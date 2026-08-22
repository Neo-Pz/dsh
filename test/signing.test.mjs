/**
 * Origin signing, end to end, through the REAL identity binary.
 *
 * The stub host here does not fake `subprocess`: it actually spawns processes,
 * so the plugin's signer runs `iflow-id sign-blob` exactly as it does inside
 * DSH. That is the only way to know the two languages agree about which bytes
 * are covered — a mocked signer would happily agree with itself.
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
const hasBinary = existsSync(IFLOW_ID)

async function waitFor(predicate, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** A host whose subprocess port really runs child processes. */
function createRealSpawnContext(workspace) {
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
      // Synchronous like DSH's: returns a handle whose `done` is the promise.
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

  return { ctx, emit, routes }
}


describe('origin signing through the real iflow-id binary', { skip: !hasBinary }, () => {
  let workspace
  let host
  let did

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'iflow-sign-e2e-'))

    // The plugin passes `--home <workspace>`, and the store appends `.iflow`.
    const created = spawnSync(IFLOW_ID, ['--home', workspace, 'create', 'sign-e2e'], { encoding: 'utf8' })
    assert.equal(created.status, 0, `iflow-id create failed: ${created.stderr}`)
    did = JSON.parse(
      spawnSync(IFLOW_ID, ['--home', workspace, 'show', '--json'], { encoding: 'utf8' }).stdout,
    ).did

    host = createRealSpawnContext(workspace)
    const plugin = (await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href)).default
    plugin.apply(host.ctx, {})
    await waitFor(() => host.routes.has('/iflow/edge/status'), 'the edge to mount')
  })

  after(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true })
  })

  it('signs every fact it journals with the node identity', async () => {
    const agent = { id: 'sess-1', session: { id: 'sess-1', header: { meta: {} } }, options: { model: 'm' } }
    await host.emit('agent/created', { agent })
    await host.emit('session/event', { id: 'sess-1' }, { type: 'turn/start', data: { turn: 1 } })
    await host.emit(
      'session/event',
      { id: 'sess-1' },
      {
        type: 'user/message',
        data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'sign this turn' }] },
      },
    )

    const journalPath = join(workspace, '.iflow', 'edge', 'origin.ndjson')
    const read = () =>
      readFileSync(journalPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))

    await waitFor(() => read().some((e) => e.type === 'task.started'), 'the turn to be journaled')

    const events = read()
    assert.ok(events.length >= 4, `expected several facts, got ${events.length}`)
    for (const event of events) {
      assert.ok(event.evidence?.signature, `${event.type} (#${event.origin.seq}) was journaled unsigned`)
    }
  })

  it('produces signatures the Rust verifier accepts, over the canonical bytes', async () => {
    const journalPath = join(workspace, '.iflow', 'edge', 'origin.ndjson')
    const events = readFileSync(journalPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))

    // Recompute the signable bytes the way any verifier would: drop the fields
    // a receiver may add, drop the signature itself, then canonicalize.
    const signable = (event) => {
      const { journalOffset, observedAt, evidence, ...rest } = event
      const { signature, ...evidenceWithoutSignature } = evidence ?? {}
      return canonicalJson(evidence === undefined ? rest : { ...rest, evidence: evidenceWithoutSignature })
    }

    const blob = join(workspace, 'verify.bin')
    let verified = 0
    for (const event of events) {
      writeFileSync(blob, Buffer.from(signable(event), 'utf8'))
      const result = spawnSync(
        IFLOW_ID,
        ['--home', workspace, 'verify-blob', blob, event.evidence.signature, did],
        { encoding: 'utf8' },
      )
      assert.equal(result.status, 0, `#${event.origin.seq} ${event.type} failed verification: ${result.stderr}`)
      verified += 1
    }
    assert.ok(verified >= 4)
  })

  it('rejects a fact whose payload was edited after signing', async () => {
    const journalPath = join(workspace, '.iflow', 'edge', 'origin.ndjson')
    const event = readFileSync(journalPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((e) => e.type === 'task.created')
    assert.ok(event, 'expected a task.created fact to tamper with')

    const tampered = { ...event, payload: { ...event.payload, title: 'a different prompt entirely' } }
    const { journalOffset, observedAt, evidence, ...rest } = tampered
    const { signature, ...evidenceWithoutSignature } = evidence
    const blob = join(workspace, 'tampered.bin')
    writeFileSync(blob, Buffer.from(canonicalJson({ ...rest, evidence: evidenceWithoutSignature }), 'utf8'))

    const result = spawnSync(IFLOW_ID, ['--home', workspace, 'verify-blob', blob, signature, did], {
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0, 'a tampered payload must not verify')
  })
})

/** Key-sorted compact JSON — the canonical form both languages agree on. */
function canonicalJson(value) {
  const sort = (input) => {
    if (input === null || typeof input !== 'object') return input
    if (Array.isArray(input)) return input.map(sort)
    const out = {}
    for (const key of Object.keys(input).sort()) {
      if (input[key] === undefined) continue
      out[key] = sort(input[key])
    }
    return out
  }
  return JSON.stringify(sort(value))
}
