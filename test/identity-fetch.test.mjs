/**
 * Getting the identity binary onto a machine.
 *
 * Every failure these cover shipped at least once, and each one surfaced the
 * same way — a node quietly journaling UNSIGNED — which is why they are pinned
 * here rather than left to review:
 *
 *   - curl without `-f` writes GitHub's 404 page to disk and exits 0
 *   - a download that "succeeded" but produced nothing was believed
 *   - a proxy-only network was unreachable because proxy env was never passed
 *   - one failure disabled signing for the life of the process
 */

import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const BUNDLE = join(import.meta.dirname, '..', 'lib', 'index.js')

async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A host that never finds the binary and records every process it was asked to run. */
function createStubContext(workspace, spawns) {
  const tools = new Map()
  const routes = new Map()
  const listeners = new Map()

  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
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
      spawn(spec) {
        spawns.push(spec)
        return {
          // A download that claims success while writing nothing: the exact
          // shape curl produces against a proxy that answers 200 with an empty
          // body, and the case that used to be believed.
          done: Promise.resolve({ exitCode: 0 }),
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
      async writeText() {},
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

  return { ctx, tools, routes }
}

describe('iflow_fetch_identity', () => {
  let workspace
  let host
  let spawns

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'iflow-identity-'))
    spawns = []
    host = createStubContext(workspace, spawns)
    const plugin = (await import(pathToFileURL(BUNDLE).href)).default
    plugin.apply(host.ctx, {})
    await waitFor(() => host.tools.has('iflow_fetch_identity'), 'the tool to register')
  })

  after(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('is registered, so a degraded node has something to run', () => {
    assert.ok(host.tools.get('iflow_fetch_identity'))
  })

  it('downloads with -f, so a 404 page is an error instead of a "binary"', async () => {
    await host.tools.get('iflow_fetch_identity').execute({})

    const curl = spawns.find((spec) => spec.argv[0] === 'curl')
    assert.ok(curl, 'it should have tried to download the binary')
    assert.ok(curl.argv.includes('-fsSL'), `curl must fail on HTTP errors, got: ${curl.argv.join(' ')}`)
    assert.ok(curl.argv.includes('--retry'))
    assert.equal(curl.graceMs, 5000, 'the download needs a grace period like every other spawn')
  })

  it('names a concrete cause instead of failing silently', async () => {
    const result = await host.tools.get('iflow_fetch_identity').execute({})

    // The stub exits 0 without producing a usable binary. Which cause fires
    // depends on the machine — a developer checkout has a real binary in
    // `rust/target/release`, a fresh clone does not — so what is pinned here is
    // the property that matters: the tool refuses, and says which step failed.
    // Reporting success on any of these is what turned "no identity" into an
    // unexplained UNSIGNED node.
    assert.equal(result.ok, false)
    assert.match(
      result.error,
      /wrote nothing|too small|will not execute|did not answer/,
      `the reason must name a step, got: ${result.error}`,
    )
  })

  it('retries rather than staying broken until a restart', async () => {
    const before = spawns.filter((spec) => spec.argv[0] === 'curl').length
    await host.tools.get('iflow_fetch_identity').execute({})
    const after = spawns.filter((spec) => spec.argv[0] === 'curl').length

    assert.ok(after > before, 'a failure must not disable the fetch for the life of the process')
  })
})

describe('the fetch rules that ship', () => {
  it('passes a proxy explicitly, for networks that cannot reach GitHub directly', () => {
    const bundle = readFileSync(BUNDLE, 'utf8')

    assert.match(bundle, /HTTPS_PROXY/, 'the bundle must read the proxy from the environment')
    assert.match(bundle, /"--proxy"|'--proxy'/, 'and pass it to curl rather than hoping it is inherited')
  })

  it('checks the size of what it downloaded before trusting it', () => {
    const bundle = readFileSync(BUNDLE, 'utf8')

    assert.match(bundle, /too small to be the identity binary/)
  })
})
