/**
 * The local half of a Conversation: the trust policy, the session binding, and
 * the guarantee that neither is reachable by anything that publishes.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const store = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'conversation', 'store.ts')).href
)
const {
  DEFAULT_TRUST,
  bindSession,
  conversationsPath,
  loadConversations,
  loadTrust,
  markOutbound,
  markSeen,
  messageDigest,
  pendingOutbound,
  recordOutbound,
  newConversation,
  trustDecision,
  trustPath,
} = store

const WORKSPACE = '/ws'

/** A ctx.fs whose files are a plain object, so a missing file is just absent. */
function fakeFs(files = {}) {
  return {
    fs: {
      async resolve(path) {
        return path
      },
      async readText(path) {
        if (!(path in files)) throw new Error(`ENOENT ${path}`)
        return files[path]
      },
      async writeText(path, text) {
        files[path] = text
      },
    },
  }
}

describe('where local conversation state lives', () => {
  it('sits beside peers.json, not inside the sync surface', () => {
    // `.iflow/edge/` is what the outbox and the Community sink read. Anything
    // one level up is unreachable from there by construction.
    for (const path of [conversationsPath(join, WORKSPACE), trustPath(join, WORKSPACE)]) {
      assert.ok(path.includes('.iflow'), `${path} should live under .iflow`)
      assert.ok(!path.includes('edge'), `${path} must not live in the sync surface`)
    }
  })
})

describe('the acceptance policy', () => {
  it('asks by default — a stranger does not get to spend a model', async () => {
    assert.equal(DEFAULT_TRUST.default, 'ask')
    const trust = await loadTrust(fakeFs(), join, WORKSPACE)
    assert.equal(trustDecision(trust, { peerLabel: 'stranger' }), 'ask')
  })

  it('still asks when the file is unreadable, rather than failing open', async () => {
    const ctx = fakeFs({ [trustPath(join, WORKSPACE)]: '{ not json' })
    const trust = await loadTrust(ctx, join, WORKSPACE)
    assert.equal(trust.default, 'ask')
    assert.equal(trustDecision(trust, { peerLabel: 'stranger' }), 'ask')
  })

  it('lets a peer the operator trusts straight through', async () => {
    const ctx = fakeFs({
      [trustPath(join, WORKSPACE)]: JSON.stringify({ default: 'ask', peers: { 'if-lt-b': 'auto' } }),
    })
    const trust = await loadTrust(ctx, join, WORKSPACE)
    assert.equal(trustDecision(trust, { peerLabel: 'if-lt-b' }), 'accept')
    assert.equal(trustDecision(trust, { peerLabel: 'someone-else' }), 'ask')
  })

  it('does not re-ask on every message of a thread already accepted', async () => {
    const trust = await loadTrust(fakeFs(), join, WORKSPACE)
    const conversation = newConversation('conv-1', { peer: 'p', state: 'accepted' })
    assert.equal(trustDecision(trust, { peerLabel: 'p', conversation }), 'accept')
  })

  it('treats a block as absolute, above any acceptance', async () => {
    const ctx = fakeFs({
      [trustPath(join, WORKSPACE)]: JSON.stringify({
        default: 'auto',
        peers: { villain: 'auto' },
        blocked: ['did:key:zVillain'],
      }),
    })
    const trust = await loadTrust(ctx, join, WORKSPACE)
    const accepted = newConversation('conv-1', { peer: 'villain', state: 'accepted' })
    assert.equal(
      trustDecision(trust, { peerLabel: 'villain', signerDid: 'did:key:zVillain', conversation: accepted }),
      'reject',
    )
  })

  it('does not let a new message reopen a rejected thread', async () => {
    const ctx = fakeFs({ [trustPath(join, WORKSPACE)]: JSON.stringify({ default: 'auto', peers: {} }) })
    const trust = await loadTrust(ctx, join, WORKSPACE)
    const rejected = newConversation('conv-1', { peer: 'p', state: 'rejected' })
    assert.equal(trustDecision(trust, { peerLabel: 'p', conversation: rejected }), 'reject')
  })

  it('ignores a mode it does not recognise instead of trusting it', async () => {
    const ctx = fakeFs({
      [trustPath(join, WORKSPACE)]: JSON.stringify({ default: 'yes-please', peers: { p: 'sure' } }),
    })
    const trust = await loadTrust(ctx, join, WORKSPACE)
    assert.equal(trust.default, 'ask')
    assert.equal(trustDecision(trust, { peerLabel: 'p' }), 'ask')
  })
})

describe('the session binding', () => {
  it('records the runtime-private mapping and nothing about the far side', () => {
    const conversation = newConversation('conv-1', { peer: 'if-lt-b' })
    const binding = bindSession(conversation, {
      runtime: 'dsh',
      workspaceId: WORKSPACE,
      localSessionId: 'iflow-agent-7',
    })
    assert.deepEqual(Object.keys(binding).sort(), ['localSessionId', 'runtime', 'workspaceId'])
  })

  it('survives a reload unchanged', async () => {
    const conversation = newConversation('conv-1', { peer: 'if-lt-b' })
    bindSession(conversation, { runtime: 'dsh', workspaceId: WORKSPACE, localSessionId: 'iflow-agent-7' })
    const ctx = fakeFs({
      [conversationsPath(join, WORKSPACE)]: JSON.stringify({ conversations: { 'conv-1': conversation } }),
    })
    const loaded = await loadConversations(ctx, join, WORKSPACE)
    assert.equal(loaded.conversations['conv-1'].binding.localSessionId, 'iflow-agent-7')
  })

  it('reads a corrupt store as empty rather than throwing into the A2A path', async () => {
    const ctx = fakeFs({ [conversationsPath(join, WORKSPACE)]: 'garbage' })
    assert.deepEqual(await loadConversations(ctx, join, WORKSPACE), { conversations: {} })
  })
})

describe('duplicate suppression', () => {
  it('accepts a message id once', () => {
    const conversation = newConversation('conv-1', { peer: 'p' })
    assert.equal(markSeen(conversation, 'msg-1'), true)
    assert.equal(markSeen(conversation, 'msg-1'), false)
    assert.equal(markSeen(conversation, 'msg-2'), true)
  })

  it('does not grow without bound', () => {
    const conversation = newConversation('conv-1', { peer: 'p' })
    for (let i = 0; i < 500; i++) markSeen(conversation, `msg-${i}`)
    assert.ok(conversation.seenMessageIds.length <= 200)
  })
})

describe('the message digest', () => {
  it('is stable and does not contain the message', () => {
    const digest = messageDigest('please analyse this CSV')
    assert.equal(digest, messageDigest('please analyse this CSV'))
    assert.ok(digest.startsWith('sha256:'))
    assert.ok(!digest.includes('CSV'))
  })

  it('changes when the message does', () => {
    assert.notEqual(messageDigest('a'), messageDigest('b'))
  })
})

describe('the preview', () => {
  it('is kept, because a person has to see something to decide', () => {
    const conversation = newConversation('conv-1', { peer: 'p', preview: 'can you help me?' })
    assert.equal(conversation.preview, 'can you help me?')
  })

  it('is bounded, because it is still somebody else’s text', () => {
    const conversation = newConversation('conv-1', { peer: 'p', preview: 'x'.repeat(5000) })
    assert.equal(conversation.preview.length, 200)
  })
})

describe('what became of a message this node sent', () => {
  const sent = (id = 'msg-1') => {
    const conversation = newConversation('conv-1', { peer: 'if-lt-b' })
    recordOutbound(conversation, { messageId: id, preview: 'analyse this' })
    return conversation
  }

  it('starts queued', () => {
    assert.equal(sent().outbound[0].state, 'queued')
  })

  it('moves forward as the relay and then the peer report', () => {
    const c = sent()
    assert.equal(markOutbound(c, 'msg-1', 'delivered'), true)
    assert.equal(markOutbound(c, 'msg-1', 'accepted'), true)
    assert.equal(c.outbound[0].state, 'accepted')
  })

  it('never walks backwards', () => {
    // The relay is polled, so a `delivered` read can land after the answer
    // already said `accepted`. Accepting that would turn a settled message
    // back into an open one every poll.
    const c = sent()
    markOutbound(c, 'msg-1', 'accepted')
    assert.equal(markOutbound(c, 'msg-1', 'delivered'), false)
    assert.equal(markOutbound(c, 'msg-1', 'queued'), false)
    assert.equal(markOutbound(c, 'msg-1', 'unknown'), false)
    assert.equal(c.outbound[0].state, 'accepted')
  })

  it('treats rejected as just as final as accepted', () => {
    const c = sent()
    markOutbound(c, 'msg-1', 'rejected')
    assert.equal(markOutbound(c, 'msg-1', 'delivered'), false)
    assert.equal(c.outbound[0].state, 'rejected')
  })

  it('refuses a state that is not one of the six', () => {
    const c = sent()
    assert.equal(markOutbound(c, 'msg-1', 'probably-fine'), false)
    assert.equal(c.outbound[0].state, 'queued')
  })

  it('ignores a message it never sent', () => {
    assert.equal(markOutbound(sent(), 'msg-other', 'delivered'), false)
  })

  it('re-sending the same id replaces rather than duplicates', () => {
    const c = sent()
    recordOutbound(c, { messageId: 'msg-1', preview: 'again' })
    assert.equal(c.outbound.length, 1)
    assert.equal(c.outbound[0].state, 'queued')
  })

  it('only asks the relay about messages still in the air', () => {
    const c = sent('a')
    recordOutbound(c, { messageId: 'b' })
    recordOutbound(c, { messageId: 'c' })
    markOutbound(c, 'b', 'delivered')
    markOutbound(c, 'c', 'accepted')
    const open = pendingOutbound({ 'conv-1': c }).map((m) => m.messageId).sort()
    assert.deepEqual(open, ['a', 'b'], 'a settled message must not be polled forever')
  })

  it('does not grow without bound', () => {
    const c = newConversation('conv-1', { peer: 'p' })
    for (let i = 0; i < 200; i++) recordOutbound(c, { messageId: `m-${i}` })
    assert.ok(c.outbound.length <= 50)
  })

  it('survives a reload', async () => {
    const c = sent()
    markOutbound(c, 'msg-1', 'delivered')
    const ctx = fakeFs({
      [conversationsPath(join, WORKSPACE)]: JSON.stringify({ conversations: { 'conv-1': c } }),
    })
    const loaded = await loadConversations(ctx, join, WORKSPACE)
    assert.equal(loaded.conversations['conv-1'].outbound[0].state, 'delivered')
  })
})
