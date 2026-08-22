/**
 * The command path, exercised against the real built bundle.
 *
 * What these assertions protect:
 *   - a Hub cannot cause work on an edge that did not opt in
 *   - a repeated delivery never produces a second side effect
 *   - answering an approval from a Task Room does not remove DSH's own answer
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function createStubContext(workspace) {
  const listeners = new Map()
  const routes = new Map()
  const disposers = []

  const ctx = {
    tools: { register: () => () => {} },
    webServer: {
      host: '127.0.0.1',
      port: 3080,
      register(spec) {
        const key = spec.path
        routes.set(key, spec.handler)
        return () => routes.delete(key)
      },
    },
    web: {},
    subprocess: {
      // Synchronous, like DSH's: the handle is returned, not a promise of one.
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 1 }),
          collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
        }
      },
      async resolveExecutable() {
        return undefined
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
      async readText() {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      },
      async writeText() {
        throw new Error('stub cannot write')
      },
    },
    timer: {},
    timeout(handler, ms) {
      const id = setTimeout(handler, ms)
      return () => clearTimeout(id)
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
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

  /** Start a waterfall without awaiting it, so a racing answer can be tested. */
  const startWaterfall = (name, terminal, ...args) => {
    const chain = [...(listeners.get(name) ?? [])]
    const run = async (index) => {
      if (index >= chain.length) return terminal()
      return chain[index](...args, () => run(index + 1))
    }
    return run(0)
  }

  const post = (path, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const handler = routes.get(path)
      if (!handler) return reject(new Error(`no route mounted at ${path}`))
      const payload = JSON.stringify(body)
      const req = {
        method: 'POST',
        url: path,
        headers,
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

  const get = (path) =>
    new Promise((resolve, reject) => {
      const handler = routes.get(path)
      if (!handler) return reject(new Error(`no route mounted at ${path}`))
      const req = { method: 'GET', url: path, headers: {}, on() {} }
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

  return { ctx, emit, startWaterfall, post, get, routes, disposers }
}

async function bootPlugin(config) {
  const workspace = mkdtempSync(join(tmpdir(), 'iflow-cmd-'))
  const host = createStubContext(workspace)
  const bundle = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href
  const plugin = (await import(bundle)).default
  plugin.apply(host.ctx, config)
  await waitFor(() => host.routes.has('/iflow/command'), 'the command route to mount')

  // A command names the node it is for, so a misrouted one can be refused
  // rather than executed. The Hub learns the id the same way: by reading it.
  const status = await host.get('/iflow/edge/status')
  return { workspace, host, nodeId: status.json.nodeId }
}

function command(nodeId, overrides = {}) {
  return {
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    issuer: { id: 'hub-1' },
    target: { nodeId, taskId: 'task-sess-1' },
    requestedAction: 'task.cancel',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    correlationId: 'corr-1',
    ...overrides,
  }
}

describe('command path — closed by default', () => {
  let workspace
  let host
  let nodeId

  before(async () => {
    ;({ workspace, host, nodeId } = await bootPlugin({}))
  })

  after(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('refuses every command when the operator has not opted in', async () => {
    const agent = { id: 'sess-1', session: { id: 'sess-1', header: { meta: {} } }, options: {}, cancel() {
      throw new Error('a closed edge must never reach the runtime')
    } }
    await host.emit('agent/created', { agent })

    const response = await host.post('/iflow/command', command(nodeId))
    assert.equal(response.status, 200)
    assert.equal(response.json.accepted, false)
    assert.match(response.json.reason, /does not accept commands/)
  })

  it('rejects a malformed body without reaching the ledger', async () => {
    const response = await host.post('/iflow/command', { nonsense: true })
    assert.equal(response.json.accepted, false)
    assert.match(response.json.reason, /malformed/)
  })
})

describe('command path — opted in', () => {
  let workspace
  let host
  let nodeId

  before(async () => {
    ;({ workspace, host, nodeId } = await bootPlugin({ acceptCommands: true, routeApprovals: true }))
  })

  after(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('cancels a live agent exactly once, however many times it is delivered', async () => {
    let cancels = 0
    const agent = {
      id: 'sess-1',
      session: { id: 'sess-1', header: { meta: {} } },
      options: {},
      cancel() {
        cancels += 1
      },
    }
    await host.emit('agent/created', { agent })

    const first = await host.post('/iflow/command', command(nodeId))
    assert.equal(first.json.accepted, true)
    assert.equal(cancels, 1)

    // Same command id, and then the same idempotency key under a new id.
    const second = await host.post('/iflow/command', command(nodeId))
    const third = await host.post('/iflow/command', command(nodeId, { commandId: 'cmd-1-resent' }))

    assert.equal(cancels, 1)
    assert.equal(second.json.accepted, true)
    assert.equal(third.json.accepted, true)
  })

  it('refuses an action it does not implement, by name', async () => {
    const response = await host.post(
      '/iflow/command',
      command(nodeId, { commandId: 'cmd-2', idempotencyKey: 'idem-2', requestedAction: 'shell.run' }),
    )
    assert.equal(response.json.accepted, false)
    assert.match(response.json.reason, /unsupported action shell\.run/)
  })

  it('refuses a command addressed to another node', async () => {
    const response = await host.post(
      '/iflow/command',
      command(nodeId, { commandId: 'cmd-3', idempotencyKey: 'idem-3', target: { nodeId: 'someone-else', taskId: 'task-sess-1' } }),
    )
    assert.equal(response.json.accepted, false)
    assert.match(response.json.reason, /targets node someone-else/)
  })

  it('lets a Task Room answer an approval that is waiting', async () => {
    const agent = { id: 'sess-9', session: { id: 'sess-9', header: { meta: {} } }, options: {}, cancel() {} }
    await host.emit('agent/created', { agent })

    let localApproverCalled = false
    // The local chain is still live; it simply has not answered yet.
    const pending = host.startWaterfall(
      'approval/request',
      () =>
        new Promise((resolve) => {
          localApproverCalled = true
          setTimeout(() => resolve('rejected'), 5000)
        }),
      { agent, toolName: 'write_file', callId: 'call-9' },
    )

    await waitFor(() => localApproverCalled, 'the local approval chain to start')

    const response = await host.post(
      '/iflow/command',
      command(nodeId, {
        commandId: 'cmd-appr',
        idempotencyKey: 'idem-appr',
        target: { nodeId, taskId: 'task-sess-9' },
        requestedAction: 'approval.resolve:allow',
      }),
    )

    assert.equal(response.json.accepted, true, `command was refused: ${response.json.reason}`)
    assert.equal(await pending, 'allowed-once')
  })

  it('refuses to answer an approval that nobody is waiting on', async () => {
    const response = await host.post(
      '/iflow/command',
      command(nodeId, {
        commandId: 'cmd-appr-2',
        idempotencyKey: 'idem-appr-2',
        target: { nodeId, taskId: 'task-sess-nobody' },
        requestedAction: 'approval.resolve:allow',
      }),
    )
    assert.equal(response.json.accepted, false)
    assert.match(response.json.reason, /no approval is waiting/)
  })

  it('records every command decision in the ledger on disk', async () => {
    const { readFileSync } = await import('node:fs')
    const ledger = readFileSync(join(workspace, '.iflow', 'edge', 'commands.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    assert.ok(ledger.some((record) => record.commandId === 'cmd-1' && record.status === 'accepted'))
    assert.ok(ledger.some((record) => record.commandId === 'cmd-2' && record.status === 'rejected'))
  })
})
