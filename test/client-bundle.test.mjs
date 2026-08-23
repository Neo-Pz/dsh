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

  it('takes a settings page rather than a seat people click by accident', () => {
    // `settings.section` is a page someone visits deliberately. The publish
    // gate does not belong in the conversation dock.
    assert.match(bundle, /settings\.section/)
    assert.ok(!bundle.includes('conversation.input.dock'))
  })
})
