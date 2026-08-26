/**
 * Integration test for the iFlow edge inside a stub DSH host.
 *
 * It loads the REAL built bundle (`lib/index.js`) — the same file DSH loads —
 * against a fake cordis context that implements the twelve services the plugin
 * injects. That exercises the actual adapter: the ports, the lifecycle
 * mapping, the Origin Journal on a real filesystem, and the read API.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

/**
 * No test may reach the network.
 *
 * Booting the plugin resolves the identity binary, and when the stub host
 * cannot produce one the download falls back to Node's fetch. Left unanswered
 * that is a real HTTP request to GitHub, which makes this suite slow, flaky,
 * and dependent on the machine running it having internet.
 */
globalThis.fetch = async () => {
  throw new Error('network disabled in tests')
}


/** Every fact the edge has journaled, parsed. */
function readOriginJournal(workspace) {
  const path = join(workspace, '.iflow', 'edge', 'origin.ndjson')
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/** Poll until a predicate holds, so a test never races the observation queue. */
async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Minimal stand-ins for the DSH services the plugin injects. */
function createStubContext(workspace) {
  const listeners = new Map()
  const routes = new Map()
  const tools = new Map()
  const disposers = []

  const ctx = {
    // ── services the plugin injects ──────────────────────────────────────
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
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
      // DSH's spawn is SYNCHRONOUS — it returns a handle whose `done` is the
      // promise. An async stub hands back a promise instead, and the plugin's
      // `handle.collected` is then undefined.
      spawn({ argv }) {
        // Most child processes are reported as unavailable, which is exactly
        // the degraded path a fresh machine hits before the identity binary is
        // fetched. `usage record` is the exception: it is canned so the
        // metering path can be exercised without the Rust binary.
        const line = (argv ?? []).join(' ')
        const reply = (text) => ({
          done: Promise.resolve({ exitCode: 0 }),
          collected: {
            stdout: { readFrom: () => ({ text }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        })
        if (line.includes('usage record')) {
          return reply(
            'recorded task-x: 1500 tokens (in 1000, out 500, cr 0, cw 0) cost $0.012345 fingerprint: abc123',
          )
        }
        return {
          done: Promise.resolve({ exitCode: 1 }),
          collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
        }
      },
      async resolveExecutable(path) {
        // Pretend the identity binary exists so `iflow-id` calls are attempted.
        return path
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
        throw new Error('stub ctx.fs cannot write; the port falls back to node:fs')
      },
    },
    timer: {},

    // ── cordis primitives ────────────────────────────────────────────────
    timeout(handler, ms) {
      const id = setTimeout(handler, ms)
      return () => clearTimeout(id)
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    get() {
      return undefined
    },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
      return () => listeners.get(name)?.delete(listener)
    },
  }

  /** Fire a DSH event the way cordis would. */
  const emit = async (name, ...args) => {
    for (const listener of listeners.get(name) ?? []) await listener(...args)
  }

  /** Drive a waterfall event, supplying the terminal `next()`. */
  const waterfall = async (name, terminal, ...args) => {
    let result = terminal
    for (const listener of listeners.get(name) ?? []) result = await listener(...args, async () => result)
    return result
  }

  /** POST a JSON body to a mounted route and return { status, json }. */
  const post = (path, body, headers = {}, remoteAddress = '127.0.0.1') =>
    new Promise((resolve, reject) => {
      const handler = routes.get(path)
      if (!handler) return reject(new Error(`no route mounted at ${path}`))
      const payload = typeof body === 'string' ? body : JSON.stringify(body)
      const req = {
        method: 'POST',
        url: path,
        headers,
        socket: { remoteAddress },
        on(event, cb) {
          if (event === 'data') cb(Buffer.from(payload, 'utf8'))
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

  /** Call a mounted route and return { status, json }. */
  const call = (path, query = {}, headers = {}, remoteAddress = '127.0.0.1') =>
    new Promise((resolve, reject) => {
      const handler = routes.get(path)
      if (!handler) return reject(new Error(`no route mounted at ${path}`))

      const search = new URLSearchParams(query).toString()
      const req = {
        method: 'GET',
        url: search ? `${path}?${search}` : path,
        headers,
        socket: { remoteAddress },
        on() {},
      }
      let status = 0
      let body = ''
      const res = {
        writeHead(code) {
          status = code
          return res
        },
        end(text) {
          body = text ?? ''
          resolve({ status, json: body ? JSON.parse(body) : undefined })
        },
        write() {},
        on() {},
      }
      handler(req, res).catch(reject)
    })

  return { ctx, emit, waterfall, call, post, routes, tools, disposers }
}

describe('iFlow edge inside a stub DSH host', () => {
  let workspace
  let host
  let plugin

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'iflow-edge-'))
    host = createStubContext(workspace)

    const bundle = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href
    plugin = (await import(bundle)).default

    plugin.apply(host.ctx, {})

    // The edge starts asynchronously so a slow identity lookup cannot delay
    // the plugin's load; wait for its routes to appear.
    await waitFor(() => host.routes.has('/iflow/projection/agents'), 'the edge read API to mount')
  })

  after(() => {
    for (const dispose of host.disposers) {
      try {
        dispose()
      } catch {
        // Teardown is best-effort in a stub host.
      }
    }
    rmSync(workspace, { recursive: true, force: true })
  })

  it('mounts the read API without touching the A2A routes', () => {
    for (const path of [
      '/iflow/projection/agents',
      '/iflow/projection/network',
      '/iflow/projection/activity',
      '/iflow/projection/tasks',
      '/iflow/journal',
      '/iflow/edge/status',
      '/iflow/stream',
    ]) {
      assert.ok(host.routes.has(path), `expected ${path} to be mounted`)
    }

    // P0 freeze: the pre-existing bridge surface is unchanged.
    for (const path of ['/a2a', '/.well-known/agent-card.json', '/iflow/version.json', '/iflow/latest.js']) {
      assert.ok(host.routes.has(path), `expected the existing route ${path} to survive`)
    }
  })

  it('keeps the Origin Journal and projections local when no token is configured', async () => {
    const local = await host.call('/iflow/edge/status')
    assert.equal(local.status, 200)

    const remote = await host.call('/iflow/journal', {}, {}, '192.168.1.42')
    assert.equal(remote.status, 401)
  })

  it('warns about the secrets it keeps in the clear', async () => {
    const status = host.tools.get('iflow_status')
    assert.ok(status, 'iflow_status should be registered')

    const value = await status.execute({}, {})
    assert.ok(Array.isArray(value.warnings))
    // No identity exists in this stub (the binary is unavailable) and no peer
    // holds a token, so there is nothing to warn about yet — the field is
    // present and empty rather than missing.
    assert.equal(value.warnings.length, 0)

    // The renderer must survive both shapes without throwing.
    const rendered = status.output.render({}, { ...value, warnings: ['first', 'second'] })
    assert.match(rendered[0].text, /warnings:\n {2}! first\n {2}! second/)
    assert.doesNotMatch(status.output.render({}, value)[0].text, /warnings:/)
  })

  it('creates the Origin Journal on disk and registers this node', async () => {
    const journalPath = join(workspace, '.iflow', 'edge', 'origin.ndjson')
    assert.ok(existsSync(journalPath), 'origin.ndjson should exist after startup')

    const lines = readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].type, 'agent.registered')
    assert.equal(lines[0].origin.seq, 1)
    assert.equal(lines[0].payload.runtimeKind, 'dsh')
  })

  it('journals a real collaboration: Room, Goal, delegated turn Tasks, tools and approvals', async () => {
    const lead = {
      id: 'sess-lead',
      session: { id: 'sess-lead', header: { meta: { title: 'Quarterly summary' } } },
      options: { model: 'test-model' },
    }
    // A subagent names its parent through session meta; that is the delegation
    // edge, and it is why a child joins its ancestor's Room instead of opening
    // one of its own.
    const child = {
      id: 'sess-child',
      session: { id: 'sess-child', header: { meta: { parentSession: 'sess-lead' } } },
      options: { model: 'test-model' },
    }

    const say = (sessionId, type, data) => host.emit('session/event', { id: sessionId }, { type, data })

    await host.emit('agent/created', { agent: lead })
    await host.emit('agent/status', { agent: lead, status: 'running' })
    await say('sess-lead', 'turn/start', { turn: 1 })
    await say('sess-lead', 'user/message', {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Produce the quarterly summary' }],
    })

    const exec = { callId: 'call-1', name: 'read_file', agent: lead }
    await host.waterfall('tools/pre-execute', { kind: 'allow' }, exec)
    await host.emit('tools/result', exec, { isError: false, value: null, content: [] })

    // The child works its own turn, delegated from the lead's open turn.
    await host.emit('agent/created', { agent: child })
    await say('sess-child', 'turn/start', { turn: 1 })
    await say('sess-child', 'user/message', {
      role: 'user',
      source: { kind: 'plugin', plugin: 'subagent' },
      content: [{ type: 'text', text: 'Read the ledger' }],
    })
    await say('sess-child', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

    await say('sess-lead', 'approval/asked', {
      id: 'appr-1',
      toolName: 'write_file',
      reason: 'writes outside workspace',
    })
    await say('sess-lead', 'approval/decided', { id: 'appr-1', outcome: 'allowed-once' })
    await say('sess-lead', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

    const journalPath = join(workspace, '.iflow', 'edge', 'origin.ndjson')
    const readJournal = () =>
      readFileSync(journalPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))

    await waitFor(
      () => readJournal().filter((e) => e.type === 'task.completed').length >= 2,
      'both turns to complete',
    )

    const events = readJournal()
    const types = events.map((event) => event.type)

    for (const expected of [
      'agent.registered',
      'room.created',
      'room.participant_joined',
      'goal.created',
      'task.created',
      'task.delegated',
      'task.started',
      'execution.attempt_started',
      'tool.call_started',
      'tool.call_completed',
      'approval.requested',
      'task.awaiting_approval',
      'approval.resolved',
      'execution.attempt_finished',
      'task.completed',
    ]) {
      assert.ok(types.includes(expected), `expected a ${expected} event, got ${JSON.stringify([...new Set(types)])}`)
    }

    // origin.seq is strictly increasing inside this node's single stream.
    const seqs = events.map((event) => event.origin.seq)
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b))
    assert.equal(new Set(seqs).size, seqs.length)

    // Causal order, not just append order.
    const orderOf = (type) => types.indexOf(type)
    assert.ok(orderOf('room.created') < orderOf('task.created'), 'a Task belongs to a Room that exists')
    assert.ok(orderOf('task.created') < orderOf('tool.call_started'), 'task.created must precede tool.call_started')
    assert.ok(orderOf('approval.requested') < orderOf('approval.resolved'))

    // One Room for the whole collaboration, not one per subagent.
    const rooms = events.filter((e) => e.type === 'room.created')
    assert.equal(rooms.length, 1)
    assert.equal(rooms[0].subject.id, 'room-sess-lead')

    // The child's Task hangs off the lead's open turn Task.
    const childTask = events.find((e) => e.type === 'task.created' && e.subject.id === 'task-sess-child-t1')
    assert.equal(childTask.payload.parentTaskId, 'task-sess-lead-t1')
    assert.equal(childTask.roomId, 'room-sess-lead')

    // The human prompt titled the Goal and its Task; the injected subagent
    // prompt did NOT create a second Goal.
    assert.equal(events.filter((e) => e.type === 'goal.created').length, 1)
    const goal = events.find((e) => e.type === 'goal.created')
    assert.equal(goal.payload.title, 'Produce the quarterly summary')
  })

  it('journals token metering as a fact, not only in a private ledger', async () => {
    const usage = host.tools.get('iflow_usage')
    assert.ok(usage, 'iflow_usage should be registered')

    const result = await usage.execute(
      {
        action: 'record',
        taskId: 'task-sess-lead-t1',
        from: 'did:key:zTest',
        model: 'test-model',
        inputTokens: 1000,
        outputTokens: 500,
      },
      {},
    )
    assert.equal(result.ok, true, `usage record failed: ${result.error}`)

    const readJournal = () => readOriginJournal(workspace)

    await waitFor(() => readJournal().some((e) => e.type === 'usage.recorded'), 'the usage fact to land')

    const event = readJournal().find((e) => e.type === 'usage.recorded')
    assert.equal(event.taskId, 'task-sess-lead-t1')
    assert.equal(event.payload.model, 'test-model')
    assert.deepEqual(event.payload.tokens, { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 })
    // Cost is carried as integer micro-units so the canonical form — which
    // rejects floats — can sign it.
    assert.equal(event.payload.costMicros, 12345)
    assert.ok(Number.isInteger(event.payload.costMicros))
  })

  it('journals an inbound A2A request as a first-class fact', async () => {
    // The child agent cannot actually run in this stub, so the request is
    // rejected downstream — but the FACT that a peer asked is journaled before
    // any of that, which is exactly the point.
    const response = await host.post('/a2a', {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'SendMessage',
      params: {
        message: { role: 'user', parts: [{ text: 'please summarise the ledger' }] },
        metadata: { from: 'if-remote', machine: 'peer-box' },
        configuration: { returnImmediately: true },
      },
    })
    assert.equal(response.status, 200)

    const readJournal = () => readOriginJournal(workspace)
    await waitFor(() => readJournal().some((e) => e.type === 'a2a.request_received'), 'the A2A fact to land')

    const event = readJournal().find((e) => e.type === 'a2a.request_received')
    assert.equal(event.payload.fromLabel, 'if-remote')
    assert.equal(event.evidence.source, 'a2a', 'an A2A fact must record where it came from')
    assert.ok(event.payload.remoteTaskId.startsWith('iflow-task-'))
    assert.equal(event.subject.kind, 'task')
  })

  it('journals task.waiting when the agent stops to ask a human', async () => {
    const agent = {
      id: 'sess-lead',
      session: { id: 'sess-lead', header: { meta: { title: 'Quarterly summary' } } },
      options: { model: 'test-model' },
    }
    const say = (type, data) => host.emit('session/event', { id: 'sess-lead' }, { type, data })

    await say('turn/start', { turn: 2 })
    await say('user/message', {
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'second turn' }],
    })

    const exec = { callId: 'call-ask', name: 'ask_user_question', agent }
    await host.waterfall('tools/pre-execute', { kind: 'allow' }, exec)

    const readJournal = () => readOriginJournal(workspace)
    await waitFor(() => readJournal().some((e) => e.type === 'task.waiting'), 'the waiting fact to land')

    const waiting = readJournal().find((e) => e.type === 'task.waiting')
    assert.equal(waiting.subject.id, 'task-sess-lead-t2')

    // Waiting on a human is NOT the same axis value as awaiting an approval.
    const agents = await host.call('/iflow/projection/agents')
    const lead = agents.json.data.agents.find((a) => a.id === 'agent-sess-lead')
    assert.equal(lead.state.coordination, 'waiting')

    // The answer arrives and the task resumes.
    await host.emit('tools/result', exec, { isError: false, value: null, content: [] })
    await waitFor(
      async () => {
        const after = await host.call('/iflow/projection/agents')
        return after.json.data.agents.find((a) => a.id === 'agent-sess-lead')?.state.coordination === 'ready'
      },
      'the agent to stop waiting',
    )
  })

  it('serves projections built from those facts', async () => {
    const agents = await host.call('/iflow/projection/agents')
    assert.equal(agents.status, 200)
    assert.equal(agents.json.meta.projectionVersion, 1)
    assert.ok(agents.json.data.agents.some((a) => a.id === 'agent-sess-lead'), 'the observed agent should be in the view')

    const network = await host.call('/iflow/projection/network')
    assert.equal(network.status, 200)
    assert.ok(network.json.data.nodes.length > 0)
    // The Room, the Goal, the delegated child Task and the owning Agent are all
    // relationships the graph must carry.
    const edgeKinds = new Set(network.json.data.edges.map((edge) => edge.kind))
    for (const kind of ['ownership', 'delegation', 'participation', 'delivery']) {
      assert.ok(edgeKinds.has(kind), `expected a ${kind} edge, got ${[...edgeKinds].join(', ')}`)
    }

    const activity = await host.call('/iflow/projection/activity')
    assert.ok(activity.json.data.entries.some((entry) => entry.type === 'approval.requested'))

    const status = await host.call('/iflow/edge/status')
    assert.equal(status.json.skippedJournalLines, 0)
    assert.ok(status.json.lastSeq > 1)
  })

  it('pages the journal for replay', async () => {
    const first = await host.call('/iflow/journal', { fromSeq: '0', limit: '3' })
    assert.equal(first.json.events.length, 3)
    assert.equal(first.json.hasMore, true)

    const rest = await host.call('/iflow/journal', { fromSeq: String(first.json.lastSeq), limit: '500' })
    assert.equal(rest.json.hasMore, false)
  })

  it('rebuilds the same projection from the journal alone', async () => {
    const before = await host.call('/iflow/projection/agents')

    const secondHost = createStubContext(workspace)
    plugin.apply(secondHost.ctx, {})
    await waitFor(() => secondHost.routes.has('/iflow/projection/agents'), 'the second edge to mount')

    const after_ = await secondHost.call('/iflow/projection/agents')
    assert.deepEqual(
      after_.json.data.agents.map((a) => ({ id: a.id, state: a.state })),
      before.json.data.agents.map((a) => ({ id: a.id, state: a.state })),
    )

    for (const dispose of secondHost.disposers) {
      try {
        dispose()
      } catch {
        // best effort
      }
    }
  })
})

describe('declared public Agent registration', () => {
  let workspace
  let host

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'iflow-declared-agent-'))
    mkdirSync(join(workspace, '.iflow'), { recursive: true })
    writeFileSync(
      join(workspace, '.iflow', 'agents.json'),
      `${JSON.stringify({
        schemaVersion: 2,
        agents: [{
          agentId: 'Gen-On-A',
          label: 'GenOnA',
          did: 'did:key:z6Mkf6A6tcTvj8Cbke4EzVAwR7qg2xwXPViG2kGHAL4uCinE',
          capabilities: ['iflow.cap:a2a.receive'],
        }],
      })}\n`,
    )
    host = createStubContext(workspace)
    const bundle = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href
    const plugin = (await import(`${bundle}?declared-agent=${Date.now()}`)).default
    plugin.apply(host.ctx, {})
    await waitFor(
      () => {
        const journal = join(workspace, '.iflow', 'edge', 'origin.ndjson')
        return existsSync(journal) && readOriginJournal(workspace).some((event) => event.subject.id === 'Gen-On-A')
      },
      'the declared Agent to be journaled',
    )
  })

  after(() => {
    for (const dispose of host.disposers) {
      try {
        dispose()
      } catch {
        // Teardown is best-effort in a stub host.
      }
    }
    rmSync(workspace, { recursive: true, force: true })
  })

  it('publishes only the explicitly declared Agent as a durable network actor', () => {
    const event = readOriginJournal(workspace).find((candidate) => candidate.subject.id === 'Gen-On-A')
    assert.equal(event.type, 'agent.registered')
    assert.equal(event.visibility, 'public')
    assert.equal(event.issuer.did, 'did:key:z6Mkf6A6tcTvj8Cbke4EzVAwR7qg2xwXPViG2kGHAL4uCinE')
    assert.equal(event.payload.label, 'GenOnA')
    assert.deepEqual(event.payload.capabilities, ['iflow.cap:a2a.receive'])
  })
})
