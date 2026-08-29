/**
 * Who said it, and who is answerable for it.
 *
 * A DSH session event says "user turn" or "assistant turn". In a conversation
 * with two Agents on two machines that is not the question anyone is asking.
 * Reading `assistant` as "the peer" hands this node's own Agent to the far side
 * every time it speaks; reading `user` as "me" cannot see a person on the other
 * end at all.
 *
 * Four separate answers, none derivable from the other three:
 *
 *   side       self or peer, relative to THIS node
 *   author     a person, or an Agent
 *   authorId   which Agent, when it was an Agent
 *   represents the Agent that carries it onto the network and signs for it
 *
 * Left and right come from `side`. The 👤/🤖 badge comes from `author`. They are
 * different questions and a message can answer them independently: a person on
 * the far side is a human message on the left.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const source = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')

describe('what gets written down', () => {
  it('records the peer on a message that came from the peer', () => {
    // Without this the reply is an ordinary assistant message, indistinguishable
    // from something this node's own Agent produced.
    assert.match(source, /function appendRemoteAgent\(session, text, messageId, peer/)
    assert.match(source, /side: 'peer'/)
  })

  it('names the peer where DSH shows who produced the text', () => {
    // `source.model` is the field the session UI surfaces. Leaving it as a
    // constant meant every remote Agent looked like the same anonymous one.
    assert.match(source, /model: peer\.label \|\| peer\.agentId \|\| 'remote-agent'/)
  })

  it('records a human author and an Agent representative on the same message', () => {
    // Both are true at once, and the architecture rests on not choosing: a
    // Human is not a network actor, it acts through the Agent representing it.
    assert.match(source, /author: 'human', represents/)
  })

  it('keeps side out of the author, and author out of the side', () => {
    // The moment one is derived from the other, a person on the far side is
    // either rendered on the wrong side or stops being marked as a person.
    const marker = source.slice(source.indexOf('function authorship('))
    const body = marker.slice(0, marker.indexOf('\n    }'))
    assert.match(body, /author/)
    assert.match(body, /side/)
    assert.equal(/side\s*[:=]\s*[^,\n]*author/.test(body), false, 'side is computed from author')
    assert.equal(/author\s*[:=]\s*[^,\n]*side/.test(body), false, 'author is computed from side')
  })
})

describe('what gets read back', () => {
  it('prefers what was written over what can be guessed', () => {
    assert.match(source, /const marked = event\.data\?\.iflow \?\? event\.data\?\.message\?\.iflow/)
    assert.match(source, /const side = marked\?\.side \?\?/)
    assert.match(source, /const author = marked\?\.author \?\?/)
  })

  it('still reads a session written before any of this existed', () => {
    // The old inference is wrong for a local Agent's own replies and right for
    // everything else — which is why it could not stay, and why it has to
    // remain as the fallback for sessions already on disk.
    assert.match(source, /\(human \? 'self' : 'peer'\)/)
    assert.match(source, /\(human \? 'human' : 'agent'\)/)
  })

  it('reports the representative separately from the author', () => {
    assert.match(source, /representedBy: marked\?\.represents/)
  })

  it('no longer decides authorship from the event type alone', () => {
    // The exact line this replaces. Its return meant "assistant therefore the
    // peer", which is the misattribution the whole change exists to end.
    assert.equal(
      source.includes('authorAgentId: human ? conversation.localAgentId : conversation.peerAgentId'),
      false,
    )
  })
})
