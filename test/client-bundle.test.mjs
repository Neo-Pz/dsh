/**
 * The browser half, as shipped.
 *
 * `lib/client.js` is loaded by DSH's web app, not by anything here, so a
 * mistake in it surfaces in someone else's browser with no stack trace worth
 * reading. These assertions check the contract that loading depends on: the
 * wrapper shape, what it asks the host for, and what it must never carry.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const CLIENT = join(import.meta.dirname, '..', 'lib', 'client.js')
const MANIFEST = join(import.meta.dirname, '..', 'package.json')

const bundle = readFileSync(CLIENT, 'utf8')
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))

/**
 * Does this text reach the browser?
 *
 * esbuild escapes every non-ASCII character to `\uXXXX`, so searching the
 * bundle for a Chinese string finds nothing however present it is. Compared
 * case-insensitively because which case esbuild writes those hex digits in is
 * its business, not this test's.
 */
const BACKSLASH = String.fromCharCode(92)
function bundleHas(text) {
  const escaped = [...text]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code > 127 ? `${BACKSLASH}u${code.toString(16).padStart(4, '0')}` : character
    })
    .join('')
  return bundle.toLowerCase().includes(escaped.toLowerCase())
}

describe('the client bundle DSH loads', () => {
  it('registers itself the way the module loader expects', () => {
    assert.match(bundle, /window\.__ModuleLoader__\.load\(/)
    assert.match(bundle, /id:\s*'iflow-dsh-plugin'/)
    assert.match(bundle, /factory:\s*\(require\)\s*=>/)
  })

  it('hands back the two things the host reads off it', () => {
    // The host calls `apply` and resolves `inject`. A refactor that drops
    // either produces a plugin that loads and does nothing.
    assert.match(bundle, /return \{ inject: module\.exports\.inject, apply: module\.exports\.apply \}/)
  })

  it('asks the host only for modules the host actually provides', () => {
    const provided = new Set([
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
    ])

    const required = new Set()
    for (const match of bundle.matchAll(/require\(["']([^"']+)["']\)/g)) required.add(match[1])

    for (const name of required) {
      assert.ok(provided.has(name), `the host does not provide ${name}; bundle it instead`)
    }
    assert.ok(required.has('react'), 'the panel is React, so it must borrow the host React')
  })

  it('carries none of the Hub\'s heavy or proprietary dependencies', () => {
    // Two separate hazards, one rule: the graph libraries are ~550KB together,
    // more than twice this whole plugin, and iflow-hub-ui is proprietary while
    // this repository is MIT and commits its build output.
    for (const forbidden of ['cytoscape', 'reactflow', 'iflow-hub-ui']) {
      assert.ok(!bundle.includes(forbidden), `${forbidden} must not reach the client bundle`)
    }
  })

  it('stays small enough to belong in a settings page', () => {
    const kb = Buffer.byteLength(bundle, 'utf8') / 1024
    assert.ok(kb < 80, `client bundle is ${kb.toFixed(1)}kb; a publish gate should not need that`)
  })

  it('is declared so DSH knows to load it at all', () => {
    // All three are required together: without the export the loader throws,
    // without the declaration it never looks.
    assert.equal(manifest.exports['./client'], './lib/client.js')
    assert.equal(manifest.dsh.client.platform, 'web')
    assert.ok(manifest.files.includes('lib'))
  })

  it('ships both answers to a held conversation', () => {
    // The acceptance gate is only worth having if a person can answer it
    // without typing a tool call. Same narrow claim as the identity check
    // below: both routes reached the browser, so the inbox is not calling an
    // endpoint that was never wired.
    assert.match(bundle, /conversations\/accept/)
    assert.match(bundle, /conversations\/reject/)
  })

  it('is a control plane, not just a publish gate', () => {
    // The five tabs of the local Hub. A tab that vanishes in a refactor takes
    // its whole surface with it silently, and the publish gate in particular
    // must not get lost on its way into "Me".
    //
    // Searched as escapes, not as text: esbuild writes non-ASCII as \uXXXX, so
    // looking for the characters themselves would quietly never match and this
    // assertion would pass for the wrong reason.
    for (const label of ['待处理', 'Agents', '网络', '交易', '我']) {
      assert.ok(bundleHas(label), `the ${label} tab must reach the browser`)
    }
  })

  it('ships both halves of the two-layer identity', () => {
    // Declaring an Agent before a Principal exists is refused by the panel's
    // own code and again by the keyring, which is where that rule is tested.
    // What a bundle assertion can honestly establish is narrower: both routes
    // reached the browser at all, so the UI is not calling an endpoint that was
    // never wired.
    assert.match(bundle, /principal\/declare/)
    assert.match(bundle, /agents\/declare/)
  })

  it('is reachable from the app, not only from Settings', () => {
    // A publish gate nobody can find is a gate that does not work. The state of
    // this machine has to be visible without opening anything, so the button
    // sits beside Settings and the panel opens over the app.
    assert.match(bundle, /sidebar\.footer\.action/)
    assert.match(bundle, /shell\.overlay/)
    // And it stays available as a settings page for someone who goes looking.
    assert.match(bundle, /settings\.section/)
    // But never in the composer, where it would be clicked by accident.
    assert.ok(!bundle.includes('conversation.input.dock'))
  })
})
