/**
 * The star map's geometry.
 *
 * The only real logic in the panel, and pure, so it is checked here rather
 * than through a browser. The properties that matter are not "is it pretty"
 * but: does every node get a position, is that position the same on the next
 * render, and does nothing produce a NaN — an SVG with `cx="NaN"` renders as
 * an empty box with no error anywhere.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const { MAP_CENTRE, MAP_SIZE, layoutAgents, shortenLabel } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'client', 'map-layout.ts')).href
)

const agent = (id) => ({ id, kind: 'agent', label: id })

describe('where the star map puts an agent', () => {
  it('puts this node in the middle', () => {
    const at = layoutAgents([agent('me'), agent('a')], 'me')
    assert.deepEqual(at.me, { x: MAP_CENTRE, y: MAP_CENTRE })
  })

  it('starts the first peer at twelve o’clock', () => {
    const at = layoutAgents([agent('me'), agent('a')], 'me')
    assert.equal(Math.round(at.a.x), MAP_CENTRE)
    assert.ok(at.a.y < MAP_CENTRE, 'the first peer should be above centre, not wherever the array put it')
  })

  it('spreads peers evenly and keeps them on the circle', () => {
    const nodes = [agent('me'), agent('a'), agent('b'), agent('c'), agent('d')]
    const at = layoutAgents(nodes, 'me')
    for (const id of ['a', 'b', 'c', 'd']) {
      const dx = at[id].x - MAP_CENTRE
      const dy = at[id].y - MAP_CENTRE
      assert.ok(Math.abs(Math.hypot(dx, dy) - 128) < 0.001, `${id} is off the circle`)
    }
  })

  it('is deterministic — a node stays where the operator last saw it', () => {
    const nodes = [agent('me'), agent('a'), agent('b')]
    assert.deepEqual(layoutAgents(nodes, 'me'), layoutAgents(nodes, 'me'))
  })

  it('never produces a coordinate SVG cannot draw', () => {
    // `cx="NaN"` is not an error anywhere: it renders as an empty box.
    for (const nodes of [[], [agent('me')], [agent('a')], [agent('me'), agent('a')]]) {
      for (const at of Object.values(layoutAgents(nodes, 'me'))) {
        assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y), `bad point ${JSON.stringify(at)}`)
      }
    }
  })

  it('places every node it was given, and only those', () => {
    const at = layoutAgents([agent('me'), agent('a'), agent('b')], 'me')
    assert.deepEqual(Object.keys(at).sort(), ['a', 'b', 'me'])
  })

  it('copes with a graph this node is not part of', () => {
    // Possible before the edge has registered itself.
    const at = layoutAgents([agent('a'), agent('b')], 'me')
    assert.equal(at.me, undefined)
    assert.equal(Object.keys(at).length, 2)
  })

  it('keeps everything inside the viewBox', () => {
    const nodes = [agent('me'), ...Array.from({ length: 12 }, (_, i) => agent(`p${i}`))]
    for (const at of Object.values(layoutAgents(nodes, 'me'))) {
      assert.ok(at.x >= 0 && at.x <= MAP_SIZE && at.y >= 0 && at.y <= MAP_SIZE)
    }
  })
})

describe('node labels', () => {
  it('leaves a short one alone', () => {
    assert.equal(shortenLabel('if-lt-b'), 'if-lt-b')
  })

  it('truncates a long one to the budget, ellipsis included', () => {
    const out = shortenLabel('a-very-long-agent-name-here')
    assert.equal(out.length, 16)
    assert.ok(out.endsWith('…'))
  })

  it('answers empty for anything that is not a string', () => {
    for (const value of [undefined, null, 42, {}]) assert.equal(shortenLabel(value), '')
  })
})
