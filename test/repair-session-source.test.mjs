/**
 * Repairing sessions this plugin damaged before it knew better.
 *
 * The emitting bug is fixed; a session already written stays written. These
 * check that the repair is narrow enough to trust: it fixes the shape we are
 * known to have produced and reports everything else rather than guessing,
 * because a wrong guess is indistinguishable from the truth afterwards.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

import { adoptSessionEvent } from '@deepseek-ai/dsh-session'

const repair = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'repair', 'session-source.ts')).href
)
const { inspectEvents, repairEvents } = repair

/** The exact event the old `appendRemoteAgent` wrote. */
const damaged = (seq = 7) => ({
  seq,
  type: 'assistant/message',
  data: {
    turn: 0,
    step: 0,
    message: {
      id: 'msg-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'the remote agent answered' }],
      source: { provider: 'iflow', model: 'remote-agent' },
    },
  },
})

const healthyUser = (seq = 5) => ({
  seq,
  type: 'user/message',
  data: {
    id: 'msg-0',
    role: 'user',
    content: [{ type: 'text', text: 'a person typed this' }],
    source: { kind: 'plugin', plugin: 'iflow' },
  },
})

describe('what it recognises', () => {
  it('finds the shape this plugin actually wrote', () => {
    const [finding] = inspectEvents([damaged()])
    assert.equal(finding.seq, 7)
    assert.equal(finding.repairable, true)
    assert.match(finding.reason, /older iFlow/)
  })

  it('leaves a healthy session alone', () => {
    assert.deepEqual(inspectEvents([healthyUser(), { seq: 6, type: 'session/end-seed' }]), [])
  })

  it('ignores the lifecycle events around the messages', () => {
    // A session is mostly not messages. Reporting on `session/title` would bury
    // the one line that matters.
    const noise = ['session', 'permission/preset', 'sandbox/mode', 'session/title'].map((type, i) => ({ seq: i, type }))
    assert.deepEqual(inspectEvents(noise), [])
  })
})

describe('what it refuses to guess at', () => {
  it('reports a source with no kind that iFlow did not write', () => {
    const foreign = { ...damaged(), data: { message: { role: 'assistant', source: { provider: 'someone-else' } } } }
    const [finding] = inspectEvents([foreign])
    assert.equal(finding.repairable, false)
    assert.match(finding.reason, /not written by iFlow/)
  })

  it('reports an assistant message claiming the wrong kind', () => {
    // DSH refuses this too, but naming the right one would be inventing a fact
    // about who produced the text.
    const wrong = { ...damaged(), data: { message: { role: 'assistant', source: { kind: 'plugin', plugin: 'x' } } } }
    assert.equal(inspectEvents([wrong])[0].repairable, false)
  })

  it('reports a message with no source at all', () => {
    const bare = { seq: 3, type: 'user/message', data: { role: 'user' } }
    assert.equal(inspectEvents([bare])[0].repairable, false)
  })
})

describe('the repair itself', () => {
  it('produces an event DSH will load', () => {
    // The point of the whole exercise, checked against DSH's own validator
    // rather than against a copy of its rules.
    const { events, repaired } = repairEvents([damaged()])
    assert.deepEqual(repaired, [7])
    assert.doesNotThrow(() => adoptSessionEvent(structuredClone(events[0])))
  })

  it('keeps the provider and model that were already there', () => {
    // Only the kind was missing. Replacing the rest would be rewriting who
    // answered, which nobody asked for.
    const { events } = repairEvents([damaged()])
    assert.deepEqual(events[0].data.message.source, {
      provider: 'iflow',
      model: 'remote-agent',
      kind: 'model',
    })
  })

  it('does not touch the message itself', () => {
    const { events } = repairEvents([damaged()])
    assert.deepEqual(events[0].data.message.content, [{ type: 'text', text: 'the remote agent answered' }])
    assert.equal(events[0].data.message.id, 'msg-1')
  })

  it('does not mutate what it was given', () => {
    // A dry run has to be indistinguishable from not running at all.
    const original = damaged()
    const snapshot = JSON.stringify(original)
    repairEvents([original])
    assert.equal(JSON.stringify(original), snapshot)
  })

  it('leaves the events it cannot repair exactly as they were', () => {
    const foreign = { seq: 9, type: 'assistant/message', data: { message: { role: 'assistant', source: { provider: 'x' } } } }
    const { events, repaired } = repairEvents([damaged(), foreign])
    assert.deepEqual(repaired, [7])
    assert.deepEqual(events[1], foreign)
  })

  it('reports nothing repaired when nothing was wrong', () => {
    const { repaired } = repairEvents([healthyUser()])
    assert.deepEqual(repaired, [])
  })

  it('repairs every occurrence, not just the first', () => {
    // A long conversation has one of these per remote reply.
    const { repaired } = repairEvents([damaged(7), healthyUser(8), damaged(11), damaged(15)])
    assert.deepEqual(repaired, [7, 11, 15])
  })
})
