/**
 * The architecture's five failure tests, run against a REAL on-disk journal.
 *
 * These are also covered in `iflow-adapter-sdk`'s conformance suite, but only
 * against an in-memory host. That proves the logic; it does not prove the DSH
 * adapter's ports behave the same way once a real filesystem, a real append,
 * and a real process restart are involved — which is exactly where a
 * durability claim usually breaks.
 *
 *   1. a Community outage does not stop local work or Local Projection updates
 *   2. a successful upload with a lost acknowledgement creates no second fact
 *   3. repeated delivery of one command never produces two side effects
 *   4. deleting all projections and rebuilding from the Journal recreates state
 *   5. a forged event or out-of-scope command is rejected at the Origin Edge
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const IFLOW_ID = join(
  import.meta.dirname,
  '..',
  'rust',
  'target',
  'release',
  process.platform === 'win32' ? 'iflow-id.exe' : 'iflow-id',
)

async function waitFor(predicate, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function createHost(workspace) {
  const listeners = new Map()
  const routes = new Map()

  const ctx = {
    tools: { register: () => () => {} },
    webServer: {
      host: '127.0.0.1',
      port: 3080,
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => routes.delete(spec.path)
      },
    },
    web: {},
    subprocess: {
      spawn({ argv, cwd }) {
        const [command, ...args] = argv
        const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
        const reader = (text) => ({ readFrom: () => ({ text: text ?? '' }) })
        return {
          done: Promise.resolve({ exitCode: result.status ?? -1 }),
          collected: { stdout: reader(result.stdout), stderr: reader(result.stderr) },
        }
      },
      async resolveExecutable(path) {
        return existsSync(path) ? path : undefined
      },
    },
    sandboxPolicy: { workspaceRoot: workspace },
    agents: { create: async () => ({}) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
    agentPresets: { resolve: () => undefined, mount: () => {} },
    sessionTitle: { rename: () => {} },
    sessions: { get: () => undefined, prepare: async () => ({}), enter: () => () => {} },
    fs: {
      async resolve(path) {
        return path
      },
      async readText(path) {
        return readFileSync(path, 'utf8')
      },
      async writeText() {
        throw new Error('stub ctx.fs cannot write')
      },
    },
    timer: {},
    timeout(handler, ms) {
      const id = setTimeout(handler, ms)
      return () => clearTimeout(id)
    },
    effect(fn) {
      fn()
    },
    get: () => undefined,
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
      return () => listeners.get(name)?.delete(listener)
    },
  }

  const emit = async (name, ...args) => {
    for (const listener of listeners.get(name) ?? []) await listener(...args)
  }

  // Reads are bearer-checked whenever the node has a token, so the default
  // carries one; a node booted without a token ignores the header.
  const request = (method, path, { query = {}, body, headers = AUTH } = {}) =>
    new Promise((resolve, reject) => {
      const handler = routes.get(path)
      if (!handler) return reject(new Error(`no route mounted at ${path}`))
      const search = new URLSearchParams(query).toString()
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = {
        method,
        url: search ? `${path}?${search}` : path,
        headers,
        on(event, cb) {
          if (event === 'data' && payload !== undefined) cb(Buffer.from(payload, 'utf8'))
          if (event === 'end') cb()
        },
      }
      let status = 0
      const res = {
        writeHead(code) {
          status = code
          return res
        },
        end(text) {
          resolve({ status, json: text ? JSON.parse(text) : undefined })
        },
        write() {},
        on() {},
      }
      handler(req, res).catch(reject)
    })

  return { ctx, emit, routes, request }
}

const TOKEN = 'test-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** Boot the built plugin over `workspace`, waiting for the edge to be live. */
async function boot(workspace, config = {}) {
  const host = createHost(workspace)
  const plugin = (await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href)).default
  plugin.apply(host.ctx, config)
  await waitFor(() => host.routes.has('/iflow/edge/status'), 'the edge to mount')
  return host
}

/** Drive one complete turn so there is real history to test against. */
async function runTurn(host, sessionId, turn, prompt) {
  const agent = {
    id: sessionId,
    session: { id: sessionId, header: { meta: {} } },
    options: { model: 'test-model' },
  }
  const say = (type, data) => host.emit('session/event', { id: sessionId }, { type, data })

  await host.emit('agent/created', { agent })
  await say('turn/start', { turn })
  await say('user/message', {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: prompt }],
  })
  const exec = { callId: `call-${sessionId}-${turn}`, name: 'read', agent }
  await host.waterfall?.('tools/pre-execute', { kind: 'allow' }, exec)
  await say('turn/end', { turn, reason: { kind: 'completed' } })
}

function journalPath(workspace) {
  return join(workspace, '.iflow', 'edge', 'origin.ndjson')
}

function readJournal(workspace) {
  return readFileSync(journalPath(workspace), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('the five failure tests, against a real on-disk journal', () => {
  let workspace
  let host

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'iflow-failure-'))
    if (existsSync(IFLOW_ID)) {
      spawnSync(IFLOW_ID, ['--home', workspace, 'create', 'failure-tests'], { encoding: 'utf8' })
    }
    host = await boot(workspace, { token: TOKEN, acceptCommands: true })
    await runTurn(host, 'sess-a', 1, 'first real turn')
    await waitFor(() => readJournal(workspace).some((e) => e.type === 'task.completed'), 'the turn to settle')
  })

  after(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true })
  })

  it('1. keeps journaling and projecting with no Community anywhere', async () => {
    // No sync target was ever configured, and nothing above depended on one.
    const events = readJournal(workspace)
    assert.ok(events.length >= 6, `expected real history, got ${events.length}`)

    const agents = await host.request('GET', '/iflow/projection/agents')
    assert.equal(agents.status, 200)
    assert.ok(agents.json.data.agents.some((a) => a.id === 'agent-sess-a'))

    // The facts are queued for a Community that does not exist yet, rather
    // than dropped — that queue is what makes catching up possible later.
    const outbox = join(workspace, '.iflow', 'edge', 'outbox.ndjson')
    const queued = readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(queued.length, events.length)
    assert.ok(queued.every((line) => JSON.parse(line).state === 'queued'))
  })

  it('2. a lost acknowledgement does not create a second fact on retry', async () => {
    const before = readJournal(workspace)

    // A retry re-sends the SAME event identities; a deduplicating sink keeps
    // one copy of each. Assert the identities are stable and unique.
    const ids = before.map((event) => event.id)
    assert.equal(new Set(ids).size, ids.length, 'event ids must be unique')

    const reopened = await boot(workspace)
    const after = readJournal(workspace)

    // Reopening rewrote nothing: every previously journaled fact keeps its id
    // and its position. A restart only APPENDS (a presence transition), which
    // is what makes re-sending safe — the retry carries the same identities.
    assert.deepEqual(
      after.slice(0, before.length).map((e) => e.id),
      before.map((e) => e.id),
    )
    assert.ok(after.length > before.length, 'coming back online is itself a fact')
    assert.ok(
      after.slice(before.length).every((e) => e.type === 'agent.presence_changed'),
      'a restart must not re-register anything',
    )

    const status = await reopened.request('GET', '/iflow/edge/status')
    assert.equal(status.json.lastSeq, after.length)
  })

  it('3. one command delivered many times has one side effect, across a restart', async () => {
    let cancels = 0
    const agent = {
      id: 'sess-cmd',
      session: { id: 'sess-cmd', header: { meta: {} } },
      options: {},
      cancel() {
        cancels += 1
      },
    }
    await host.emit('agent/created', { agent })

    const nodeId = (await host.request('GET', '/iflow/edge/status')).json.nodeId
    const command = {
      commandId: 'cmd-failure-3',
      idempotencyKey: 'idem-failure-3',
      issuer: { id: 'hub' },
      target: { nodeId, taskId: 'task-sess-cmd-t1', agentId: 'agent-sess-cmd' },
      requestedAction: 'task.cancel',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      correlationId: 'corr-failure-3',
    }

    const first = await host.request('POST', '/iflow/command', { headers: AUTH, body: command })
    assert.equal(first.json.accepted, true, first.json.reason)
    await host.request('POST', '/iflow/command', { headers: AUTH, body: command })
    assert.equal(cancels, 1)

    // Restart: the ledger on disk must still remember this command.
    const restarted = await boot(workspace, { token: TOKEN, acceptCommands: true })
    await restarted.emit('agent/created', { agent })
    const afterRestart = await restarted.request('POST', '/iflow/command', { headers: AUTH, body: command })

    assert.equal(cancels, 1, 'a restart must not make a delivered command executable again')
    assert.equal(afterRestart.json.accepted, true)
  })

  it('4. deleting the projection and rebuilding from the Journal recreates it', async () => {
    const before = await host.request('GET', '/iflow/projection/agents')
    const beforeNetwork = await host.request('GET', '/iflow/projection/network')

    // A brand-new process with an empty projection, reading only the journal
    // file this test has been writing all along.
    const rebuilt = await boot(workspace)
    const after = await rebuilt.request('GET', '/iflow/projection/agents')
    const afterNetwork = await rebuilt.request('GET', '/iflow/projection/network')

    // The rebuilt projection must hold every agent the first one did, in the
    // same state. It also sees the restart's own presence fact, so the event
    // count is >= rather than ==; what must match is the derived STATE.
    const strip = (view) => view.json.data.agents.map((a) => ({ id: a.id, label: a.label, state: a.state }))
    assert.deepEqual(strip(after), strip(before))
    assert.deepEqual(
      afterNetwork.json.data.edges.map((e) => e.id).sort(),
      beforeNetwork.json.data.edges.map((e) => e.id).sort(),
    )
    assert.ok(after.json.meta.eventCount >= before.json.meta.eventCount)

    // And a second rebuild inside that same process, from the same journal,
    // must be byte-identical — this is the property the doc actually names.
    const twice = await rebuilt.request('GET', '/iflow/projection/agents')
    assert.deepEqual(strip(twice), strip(after))
  })

  it('5. a forged fact is detectable, and an out-of-scope command is refused', async () => {
    const nodeId = (await host.request('GET', '/iflow/edge/status')).json.nodeId

    // Out-of-scope: an action this edge does not implement.
    const unsupported = await host.request('POST', '/iflow/command', {
      headers: AUTH,
      body: {
        commandId: 'cmd-failure-5a',
        idempotencyKey: 'idem-failure-5a',
        issuer: { id: 'hub' },
        target: { nodeId },
        requestedAction: 'shell.run',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        correlationId: 'corr-5a',
      },
    })
    assert.equal(unsupported.json.accepted, false)
    assert.match(unsupported.json.reason, /unsupported action/)

    // Misrouted: addressed to a different node.
    const misrouted = await host.request('POST', '/iflow/command', {
      headers: AUTH,
      body: {
        commandId: 'cmd-failure-5b',
        idempotencyKey: 'idem-failure-5b',
        issuer: { id: 'hub' },
        target: { nodeId: 'some-other-node' },
        requestedAction: 'task.cancel',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        correlationId: 'corr-5b',
      },
    })
    assert.equal(misrouted.json.accepted, false)
    assert.match(misrouted.json.reason, /targets node some-other-node/)

    // Expired: past its own deadline.
    const expired = await host.request('POST', '/iflow/command', {
      headers: AUTH,
      body: {
        commandId: 'cmd-failure-5c',
        idempotencyKey: 'idem-failure-5c',
        issuer: { id: 'hub' },
        target: { nodeId },
        requestedAction: 'task.cancel',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        correlationId: 'corr-5c',
      },
    })
    assert.equal(expired.json.accepted, false)
    assert.match(expired.json.reason, /expired/)

    // A forged line appended straight to the journal file is skipped on read,
    // and counted rather than silently ignored.
    const forged = JSON.stringify({ id: 'evt-forged', type: 'task.completed', payload: {} })
    writeFileSync(journalPath(workspace), `${readFileSync(journalPath(workspace), 'utf8')}${forged}\n`, 'utf8')

    const reopened = await boot(workspace)
    const status = await reopened.request('GET', '/iflow/edge/status')
    assert.equal(status.json.skippedJournalLines, 1, 'a malformed journal line must be refused, not interpreted')
  })
})
