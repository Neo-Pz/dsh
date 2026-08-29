/**
 * The publish gate.
 *
 * The panel's job is to make one decision — should this machine's facts be
 * public — takeable by a person, on that machine, in one informed click. These
 * assertions cover the two ways that goes wrong: someone else making the
 * decision for you, and the decision not actually taking effect.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const BUNDLE = join(import.meta.dirname, '..', 'lib', 'index.js')

/**
 * No test here may reach the network.
 *
 * One suite boots a node that is already configured to publish, which makes it
 * try to upload immediately — against a host that does not exist. Answering it
 * here keeps the suite deterministic and offline.
 */
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ acceptedEventIds: [] }),
})

async function waitFor(predicate, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function createStubContext(workspace) {
  const routes = new Map()
  const listeners = new Map()
  const files = new Map()

  const ctx = {
    tools: { register: () => () => {} },
    webServer: {
      host: '0.0.0.0',
      port: 3080,
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => routes.delete(spec.path)
      },
    },
    subprocess: {
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
      async readText(path) {
        if (files.has(path)) return files.get(path)
        throw Object.assign(new Error('not found'), { code: 'ENOENT' })
      },
      async writeText(path, text) {
        files.set(path, text)
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

  /**
   * Drive one route the way a browser would, from a chosen address.
   *
   * `remoteAddress` is read with `in` rather than a default parameter, so a
   * test can say "this request has no address" — passing `undefined` to a
   * defaulted parameter would silently become loopback, which is the one answer
   * that must not be assumed.
   */
  const call = (path, options = {}) =>
    new Promise((resolve, reject) => {
      const { method = 'GET', body, headers = {} } = options
      const remoteAddress = 'remoteAddress' in options ? options.remoteAddress : '127.0.0.1'
      const handler = routes.get(path)
      if (!handler) return reject(new Error(`no route mounted at ${path}`))
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const request = {
        method,
        url: path,
        headers,
        socket: { remoteAddress },
        on(event, cb) {
          if (event === 'data' && payload !== undefined) cb(Buffer.from(payload, 'utf8'))
          if (event === 'end') cb()
        },
      }
      let status = 0
      const response = {
        writeHead(code) {
          status = code
          return response
        },
        end(text) {
          resolve({ status, json: text ? JSON.parse(text) : undefined })
        },
        write() {},
        on() {},
      }
      Promise.resolve(handler(request, response)).catch(reject)
    })

  return { ctx, call, routes, files }
}

describe('the panel answers this machine only', () => {
  let workspace
  let host

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'iflow-panel-'))
    host = createStubContext(workspace)
    const plugin = (await import(pathToFileURL(BUNDLE).href)).default
    plugin.apply(host.ctx, {})
    await waitFor(() => host.routes.has('/iflow/panel/state'), 'the panel routes to mount')
  })

  after(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('refuses a write from the network, however the address is spelled', async () => {
    // The web server is bound to 0.0.0.0 in this stub, which is what the
    // plugin's own docs tell operators to do so a second machine can reach A2A.
    // That is precisely why a one-POST "publish this machine" route cannot
    // trust its callers.
    for (const address of ['192.168.1.42', '10.0.0.7', '::ffff:203.0.113.9', undefined]) {
      const response = await host.call('/iflow/panel/publish/stop', { method: 'POST', remoteAddress: address })
      assert.equal(response.status, 403, `expected a refusal from ${address}`)
      assert.match(response.json.error, /this machine only/)
    }
  })

  it('keeps Principal, My Agents and Workspace state private to this node', async () => {
    const response = await host.call('/iflow/panel/state', {
      method: 'GET',
      remoteAddress: '192.168.1.42',
    })
    assert.equal(response.status, 403)
  })

  it('accepts loopback, including the IPv4-mapped form', async () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const response = await host.call('/iflow/panel/state', { remoteAddress: address })
      assert.equal(response.status, 200, `expected ${address} to be served`)
    }
  })

  it('lets a remote caller through only with this node\'s bearer token', async () => {
    const withoutToken = await host.call('/iflow/panel/publish/stop', {
      method: 'POST',
      remoteAddress: '192.168.1.42',
      headers: { authorization: 'Bearer guessed' },
    })
    // No token is configured on this node, so nothing can authorise remotely.
    assert.equal(withoutToken.status, 403)
  })

  it('answers 405 rather than acting on the wrong method', async () => {
    const response = await host.call('/iflow/panel/publish/stop', { method: 'GET' })
    assert.equal(response.status, 405)
  })

  it('guards the conversation and network routes like every other one', async () => {
    // Accepting a conversation is what creates a session and lets a remote
    // agent's message reach a model, so it is at least as consequential as
    // publishing — and the relationship graph is nobody else's business either.
    const writes = [
      ['/iflow/panel/conversations', 'GET'],
      ['/iflow/panel/conversations/accept', 'POST'],
      ['/iflow/panel/conversations/reject', 'POST'],
      ['/iflow/panel/conversation-workspace', 'POST'],
      ['/iflow/panel/network', 'GET'],
      ['/iflow/panel/peers/probe', 'POST'],
      ['/iflow/panel/principal/migration/plan', 'POST'],
      ['/iflow/panel/principal/migration/execute', 'POST'],
      ['/iflow/panel/principal/bind', 'POST'],
    ]
    for (const [path, method] of writes) {
      const refused = await host.call(path, { method, remoteAddress: '192.168.1.42', body: {} })
      assert.equal(refused.status, 403, `${path} must refuse the network`)
      const served = await host.call(path, { method, remoteAddress: '127.0.0.1', body: {} })
      assert.equal(served.status, 200, `${path} must answer loopback`)
    }
  })

  it('requires an explicit local confirmation before using the default conversation folder', async () => {
    const before = await host.call('/iflow/panel/state')
    assert.equal(before.status, 200)
    assert.equal(before.json.conversationWorkspace.confirmed, false)
    assert.equal(before.json.conversationWorkspace.path, workspace)

    const confirmed = await host.call('/iflow/panel/conversation-workspace', {
      method: 'POST',
      body: { path: workspace },
    })
    assert.equal(confirmed.status, 200)
    assert.deepEqual(confirmed.json, { ok: true, path: workspace })

    const after = await host.call('/iflow/panel/state')
    assert.equal(after.json.conversationWorkspace.confirmed, true)
    assert.equal(after.json.conversationWorkspace.path, workspace)
  })
})

describe('the relationship graph the Hub draws', () => {
  let workspace
  let host

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'iflow-panel-map-'))
    host = createStubContext(workspace)
    const plugin = (await import(pathToFileURL(BUNDLE).href)).default
    plugin.apply(host.ctx, {})
    await waitFor(() => host.routes.has('/iflow/panel/network'), 'the network route to mount')
    await waitFor(() => host.routes.has('/iflow/edge/status'), 'the edge to mount')
  })

  after(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('carries agents and relationships, and nothing about work in progress', async () => {
    // `views.network()` also holds task, goal and room nodes. They are filtered
    // out on this side rather than in the browser for two reasons: the star map
    // is about who knows whom, not what anyone is busy with — and whatever is
    // not sent cannot leak from the page that receives it.
    const response = await host.call('/iflow/panel/network', { remoteAddress: '127.0.0.1' })
    assert.equal(response.status, 200)
    for (const node of response.json.nodes) {
      assert.equal(node.kind, 'agent', `${node.kind} node must not reach the star map`)
    }
    for (const edge of response.json.edges) {
      assert.ok(edge.id.startsWith('rel:'), `${edge.id} is derived from work, not from a relationship`)
    }
  })
})

describe('what the panel reports', () => {
  let workspace
  let host

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'iflow-panel-state-'))
    host = createStubContext(workspace)
    const plugin = (await import(pathToFileURL(BUNDLE).href)).default
    plugin.apply(host.ctx, { acceptCommands: true })
    await waitFor(() => host.routes.has('/iflow/panel/state'), 'the panel routes to mount')
  })

  after(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('says this node is not publishing, when it is not', async () => {
    const { json } = await host.call('/iflow/panel/state')

    assert.equal(json.publishing, null, 'a node nobody has published must say so')
    assert.equal(json.claimInProgress, null)
  })

  it('reports security posture as fact, and offers no route to change it', async () => {
    const { json } = await host.call('/iflow/panel/state')

    assert.equal(json.posture.acceptCommands, true, 'it must report what this node actually accepts')
    assert.equal(json.posture.boundHost, '0.0.0.0')
    // A one-click switch for "accept remote commands" is more dangerous than an
    // edit someone has to look up. There is no route to flip it.
    assert.ok(!host.routes.has('/iflow/panel/posture'))
    assert.ok(!host.routes.has('/iflow/panel/accept-commands'))
  })

  it('separates holding an identity from being able to sign with it', async () => {
    const { json } = await host.call('/iflow/panel/state')

    // The stub has no iflow-id binary, so neither is true here — but they are
    // distinct fields, because a node can hold a DID and still journal unsigned
    // if the binary goes missing after start-up.
    assert.equal(typeof json.identity.ready, 'boolean')
    assert.equal(typeof json.signing, 'boolean')
  })

  it('counts what is waiting to be sent', async () => {
    const { json } = await host.call('/iflow/panel/state')

    assert.equal(typeof json.pendingFacts, 'number')
    assert.ok(json.pendingFacts >= 0)
  })
})

describe('stopping', () => {
  let workspace
  let host

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'iflow-panel-stop-'))
    host = createStubContext(workspace)
    const plugin = (await import(pathToFileURL(BUNDLE).href)).default
    // Configured to publish by the profile — the case the panel has to be able
    // to override without anyone editing YAML.
    plugin.apply(host.ctx, {
      community: { url: 'https://api.example.com', token: 'configured-token' },
    })
    await waitFor(() => host.routes.has('/iflow/panel/state'), 'the panel routes to mount')
  })

  after(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('reports the configured Community before anyone decides', async () => {
    const { json } = await host.call('/iflow/panel/state')
    assert.equal(json.publishing?.url, 'https://api.example.com')
  })

  it('takes effect immediately, and outranks the config that turned it on', async () => {
    const stop = await host.call('/iflow/panel/publish/stop', { method: 'POST' })
    assert.equal(stop.status, 200)
    assert.equal(stop.json.publishing, null)

    const { json } = await host.call('/iflow/panel/state')
    assert.equal(json.publishing, null, 'stopping must survive the config that says to publish')

    // Written down, so it also survives a restart. A "stop" that a restart
    // undoes is not a stop.
    const stored = host.files.get(join(workspace, '.iflow', 'community.json'))
    assert.ok(stored, 'the decision must be persisted')
    assert.ok(JSON.parse(stored).stoppedAt)
    assert.ok(!JSON.parse(stored).token, 'the credential must not be left on disk after going offline')
  })
})

describe('where conversations are filed, versus where you are looking', () => {
  let workspace
  let host

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'iflow-ws-'))
    host = createStubContext(workspace)
    const plugin = (await import(pathToFileURL(BUNDLE).href)).default
    plugin.apply(host.ctx, {})
    await waitFor(() => host.routes.has('/iflow/panel/state'), 'the panel routes to mount')
  })

  after(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  const stateNow = async () => (await host.call('/iflow/panel/state', { method: 'GET' })).json

  it('reports no mismatch when conversations go to the workspace you are in', async () => {
    await host.call('/iflow/panel/conversation-workspace', { method: 'POST', body: { path: workspace } })
    const state = await stateNow()
    assert.equal(state.conversationWorkspace.path, workspace)
    assert.equal(state.conversationWorkspace.elsewhere, false)
  })

  it('reports the two folders differing, because that is when sessions look lost', async () => {
    // The render test feeds `elsewhere` in directly, so it says nothing about
    // whether anything computes it. This covers the computation: without it the
    // panel stays silent exactly when a person is staring at 未分组 wondering
    // what broke.
    const elsewhere = join(workspace, 'dsh-wechat')
    mkdirSync(elsewhere, { recursive: true })
    await host.call('/iflow/panel/conversation-workspace', { method: 'POST', body: { path: elsewhere } })

    const state = await stateNow()
    assert.equal(state.conversationWorkspace.path, elsewhere)
    assert.equal(state.conversationWorkspace.elsewhere, true, 'the mismatch is not reported')
    // The DSH workspace is still named, so the panel can say which one it means.
    assert.equal(state.conversationWorkspace.defaultPath, workspace)
  })
})
