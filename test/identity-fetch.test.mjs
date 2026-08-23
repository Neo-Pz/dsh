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

/**
 * The download falls back to Node's fetch when curl is missing. Nothing here
 * may reach the network, so the fallback is answered locally.
 */
globalThis.fetch = async () => {
  throw new Error('network disabled in tests')
}

async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A host that never finds the binary and records what it was asked to run and probe. */
function createStubContext(workspace, spawns, probed = []) {
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
      async resolveExecutable(path) {
        probed.push(path)
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
  let probed

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'iflow-identity-'))
    spawns = []
    probed = []
    host = createStubContext(workspace, spawns, probed)
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

  it('downloads to the workspace, not into the package that gets replaced', async () => {
    await host.tools.get('iflow_fetch_identity').execute({})

    const curl = spawns.find((spec) => spec.argv[0] === 'curl')
    const dest = curl.argv[curl.argv.indexOf('-o') + 1]

    // A package directory is replaced wholesale on every upgrade — pnpm
    // resolves a git dependency to a new content-addressed directory each time
    // — so a binary fetched into it is gone after the next update and gets
    // copied back by hand. Under the workspace it survives.
    assert.ok(
      dest.startsWith(join(workspace, '.iflow', 'bin')),
      `the binary must be kept outside the package, got: ${dest}`,
    )
    assert.ok(!dest.includes('node_modules'), 'never inside an installed package directory')
  })

  it('looks where a binary may already be before downloading one', async () => {
    // The download location first, then a developer's own `cargo build` inside
    // the checkout — which is why a contributor never downloads anything, and
    // why a hand-copied binary keeps working.
    assert.ok(
      probed.some((path) => path.startsWith(join(workspace, '.iflow', 'bin'))),
      `it must probe the workspace location, probed: ${probed.join(', ')}`,
    )
    assert.ok(
      probed.some((path) => path.includes(join('rust', 'target', 'release'))),
      'and a local cargo build in the checkout',
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

describe('an operator override', () => {
  it('is read from IFLOW_ID_PATH before anything else', () => {
    const bundle = readFileSync(BUNDLE, 'utf8')

    // The escape hatch for a machine that cannot reach the Release at all:
    // build or copy the binary anywhere, point at it, done.
    assert.match(bundle, /IFLOW_ID_PATH/)
  })
})

describe('platforms without a published build', () => {
  let workspace
  let host
  let originalArch

  before(async () => {
    // The asset table is consulted inside apply(), so overriding here changes
    // what this instance believes it is running on.
    originalArch = process.arch
    Object.defineProperty(process, 'arch', { value: 'riscv64', configurable: true })

    workspace = mkdtempSync(join(tmpdir(), 'iflow-arch-'))
    host = createStubContext(workspace, [])
    const plugin = (await import(pathToFileURL(BUNDLE).href)).default
    plugin.apply(host.ctx, {})
    await waitFor(() => host.tools.has('iflow_fetch_identity'), 'the tool to register')
  })

  after(() => {
    Object.defineProperty(process, 'arch', { value: originalArch, configurable: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  it('says so, instead of downloading a binary that cannot run', async () => {
    const result = await host.tools.get('iflow_fetch_identity').execute({})

    assert.equal(result.ok, false)
    // Choosing on platform alone used to send every Linux an x86-64 binary,
    // which downloaded fine, passed the size check, and then failed to execute
    // with a message about file format that told nobody anything.
    assert.match(result.error, /no prebuilt identity binary is published for linux\/riscv64|riscv64/)
    assert.match(result.error, /IFLOW_ID_PATH|cargo build/, 'and names the way out')
  })
})

describe('the platforms a Release covers', () => {
  it('publishes an asset for each one the plugin will ask for', () => {
    const bundle = readFileSync(BUNDLE, 'utf8')

    // Debian on ARM is every Raspberry Pi and most cheap cloud instances, and
    // macos-latest is Apple Silicon — an asset named `darwin-amd64` built there
    // was arm64, so an Intel Mac could not run it.
    for (const asset of [
      'iflow-id-windows-amd64.exe',
      'iflow-id-linux-amd64',
      'iflow-id-linux-arm64',
      'iflow-id-darwin-arm64',
      'iflow-id-darwin-amd64',
    ]) {
      assert.ok(bundle.includes(asset), `the plugin must know about ${asset}`)
    }
  })

  it('picks by architecture, not by platform alone', () => {
    const bundle = readFileSync(BUNDLE, 'utf8')

    assert.match(bundle, /process\.arch/)
    assert.match(bundle, /linux\/arm64/)
  })
})
