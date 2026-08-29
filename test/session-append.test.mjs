/**
 * What iFlow writes into a DSH Session has to survive being read back.
 *
 * A bad append does not fail at the time. `session.append` takes it, the reply
 * shows up on screen, and the damage only surfaces later when someone opens
 * that conversation and DSH refuses the whole session:
 *
 *   SessionPersistenceCorruptionError: session event at seq 6
 *   message has invalid source
 *
 * So this checks the shapes against DSH's own validator rather than against a
 * copy of its rules. `adoptSessionEvent` is the exported entry point that runs
 * `assertMessageEventShape`, which is exactly what a reload runs.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { adoptSessionEvent } from '@deepseek-ai/dsh-session'

/** The event DSH persists for `session.append('assistant/message', data)`. */
const assistantEvent = (source) => ({
  seq: 6,
  type: 'assistant/message',
  data: {
    turn: 0,
    step: 0,
    message: {
      id: 'msg-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'the remote agent answered' }],
      source,
    },
  },
})

/** The event DSH persists for `session.append('user/message', data)`. */
const userEvent = (source) => ({
  seq: 5,
  type: 'user/message',
  data: {
    id: 'msg-0',
    role: 'user',
    content: [{ type: 'text', text: 'a person typed this' }],
    source,
  },
})

describe('a remote Agent’s reply', () => {
  it('is accepted with the source iFlow actually writes', () => {
    // Keep this literal in step with `appendRemoteAgent` in src/index.ts.
    assert.doesNotThrow(() =>
      adoptSessionEvent(assistantEvent({ kind: 'model', provider: 'iflow', model: 'remote-agent' })),
    )
  })

  it('is rejected without `kind`, which is how sessions were being corrupted', () => {
    // The exact shape that shipped: provider and model, no kind. DSH requires a
    // non-empty `source.kind` before it looks at anything else.
    assert.throws(
      () => adoptSessionEvent(assistantEvent({ provider: 'iflow', model: 'remote-agent' })),
      /invalid source/,
    )
  })

  it('is rejected when the kind is anything but `model`', () => {
    // An assistant message must name the model that produced it. `plugin` is
    // right for the human side and wrong here, and the two are easy to confuse
    // because both appends live in the same handful of lines.
    assert.throws(
      () => adoptSessionEvent(assistantEvent({ kind: 'plugin', plugin: 'iflow' })),
      /must have model source/,
    )
  })

  it('is rejected when the kind is right but the provider is missing', () => {
    assert.throws(() => adoptSessionEvent(assistantEvent({ kind: 'model' })), /must have model source/)
  })
})

describe('a person’s message arriving from the web', () => {
  it('is accepted with the source iFlow writes', () => {
    // Keep this literal in step with `appendWebHuman` in src/index.ts.
    assert.doesNotThrow(() => adoptSessionEvent(userEvent({ kind: 'plugin', plugin: 'iflow' })))
  })

  it('is rejected without a kind, the same way', () => {
    assert.throws(() => adoptSessionEvent(userEvent({ plugin: 'iflow' })), /invalid source/)
  })
})
