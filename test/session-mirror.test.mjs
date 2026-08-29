/**
 * One Conversation, one thread, whichever path a message took.
 *
 * Three paths reach a Conversation and only two of them used to write anything
 * a person could see: the web Chat box, and a reply arriving over the relay.
 * A message sent with `iflow_send` went into the journal and nowhere else, and
 * so did the answer — which is why the local session and the web view showed
 * different halves of the same conversation.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const source = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')

const store = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'conversation', 'store.ts')).href
)
const { markSeen, newConversation } = store

describe('every path writes into the thread', () => {
  it('mirrors both halves after a direct send', () => {
    // `iflow_send` has the prompt it sent and the answer it got. Neither used to
    // reach the session the Conversation is bound to.
    const sends = source.split('noteDelivery(outbound,').slice(1)
    assert.ok(sends.length >= 2, 'expected both send return paths')
    for (const [index, after] of sends.entries()) {
      assert.match(after.slice(0, 400), /mirrorExchange\(outbound, \[/, `send path ${index} does not mirror`)
    }
  })

  it('records the sent prompt as this side and the answer as the peer', () => {
    const [first] = source.split('mirrorExchange(outbound, [').slice(1)
    const block = first.slice(0, 260)
    assert.match(block, /side: 'self', messageId, text: args\.prompt/)
    assert.match(block, /side: 'peer'/)
  })

  it('gives the reply its own id rather than reusing the question’s', () => {
    // Same id for both halves means the deduplication drops the answer, and the
    // thread shows the question with nothing after it.
    //
    // Checked as "the two entries name different ids", not as the literal way
    // the second one is spelled: a test that matches the template string passes
    // whatever the value turns out to be, which is how it read `messageId` for
    // both halves and said nothing.
    for (const block of source.split('mirrorExchange(outbound, [').slice(1)) {
      const entries = block.slice(0, block.indexOf('])'))
      // Both spellings: `messageId` as shorthand, and `messageId: <expr>`.
      // Matching only the explicit form found one entry and reported a
      // structure problem instead of the answer to the question asked.
      const ids = [...entries.matchAll(/messageId(?::\s*([^,\n]+))?/g)].map(
        (match) => (match[1] ?? 'messageId').trim(),
      )
      assert.equal(ids.length, 2, `expected two mirrored entries, found ${ids.length}`)
      assert.notEqual(ids[0], ids[1], 'the question and its answer are mirrored under one id')
    }
  })

  it('does not fail a send because there is nowhere to mirror to', () => {
    // A node whose operator has not chosen a conversation folder yet. The
    // exchange happened and is journalled; it simply has nowhere to be shown.
    const mirror = source.slice(source.indexOf('async function mirrorExchange'))
    const body = mirror.slice(0, mirror.indexOf('\n    async function'))
    assert.match(body, /catch \(err\)/)
    assert.match(body, /could not mirror into a session/)
    assert.equal(/throw/.test(body), false, 'mirroring throws into the send path')
  })
})

describe('mirroring the same message twice', () => {
  it('appends it once', () => {
    // The relay is polled and a send can be retried, so a path that mirrors may
    // run more than once for one message. The id is what makes that safe.
    const conversation = newConversation('conv-1', { peer: 'if-lt-b' })
    assert.equal(markSeen(conversation, 'mirror:msg-1'), true)
    assert.equal(markSeen(conversation, 'mirror:msg-1'), false)
  })

  it('keeps the question and its answer apart', () => {
    // They travel together and would collide under one key.
    const conversation = newConversation('conv-1', { peer: 'if-lt-b' })
    assert.equal(markSeen(conversation, 'mirror:msg-1'), true)
    assert.equal(markSeen(conversation, 'mirror:msg-1:reply'), true)
  })

  it('does not collide with the ids the acceptance gate already tracks', () => {
    // `markSeen` is shared with inbound duplicate suppression and with intents.
    // A bare messageId would make mirroring and delivery cancel each other out.
    const conversation = newConversation('conv-1', { peer: 'if-lt-b' })
    assert.equal(markSeen(conversation, 'msg-1'), true)
    assert.equal(markSeen(conversation, 'mirror:msg-1'), true, 'the mirror key is not namespaced')
  })
})
