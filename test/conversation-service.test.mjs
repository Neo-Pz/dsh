import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const { createConversationService, assertAgentSigner } = await import(pathToFileURL(
  process.env.IFLOW_TEST_SERVICE || join(import.meta.dirname, '..', 'src/conversation/service.ts'),
).href)

const target = { fromAgent: { agentId: 'mine', did: 'did:key:mine' }, toAgentId: 'peer', toAgentDid: 'did:key:peer' }
const thread = (id, overrides = {}) => ({
  conversationId: id, localAgentId: 'mine', localAgentAuthorityDid: 'did:key:mine',
  peerAgentId: 'peer', peerAgentAuthorityDid: 'did:key:peer',
  active: true, state: 'accepted', communicationState: 'active', updatedAt: '2026-09-05T01:00:00Z',
  binding: { sessionId: 'local-only' }, ...overrides,
})
function fixture(initial = {}) {
  const state = { conversations: initial, permission: 'allowed' }
  const service = createConversationService({ conversations: () => state.conversations, pairState: () => state.permission })
  return { state, service }
}
const rejects = (fn, code) => assert.throws(fn, (error) => error.code === code)

describe('shared Conversation Service', () => {
  it('both transports require the selected Agent signer, not an absent or Node signer', () => {
    assertAgentSigner({ signer: 'did:key:mine' }, target.fromAgent)
    rejects(() => assertAgentSigner({ signer: 'did:key:node' }, target.fromAgent), 'agent_signing_failed')
    rejects(() => assertAgentSigner({}, target.fromAgent), 'agent_signing_failed')
    rejects(() => assertAgentSigner({}, {}), 'agent_signing_failed')
  })
  it('returns the same bound active thread for repeated sends and ignores newer inactive history', () => {
    const { service } = fixture({ live: thread('live'), old: thread('old', { active: false, updatedAt: '2099' }) })
    assert.equal(service.select(target).conversationId, 'live')
    assert.equal(service.select(target).binding.sessionId, 'local-only')
  })
  it('does not mutate state when selecting or rejecting a thread', () => {
    const { state, service } = fixture({ live: thread('live') })
    const before = JSON.stringify(state)
    service.select(target)
    rejects(() => service.select({ ...target, conversationId: 'missing' }), 'conversation_mismatch')
    assert.equal(JSON.stringify(state), before)
  })
  for (const field of ['localAgentId', 'localAgentAuthorityDid', 'peerAgentId', 'peerAgentAuthorityDid']) {
    it(`does not borrow a thread with a different ${field}`, () => {
      const { service } = fixture({ wrong: thread('wrong', { [field]: 'other' }) })
      assert.equal(service.select(target), undefined)
      rejects(() => service.select({ ...target, conversationId: 'wrong' }), 'conversation_mismatch')
    })
  }
  it('requires identities even for a new conversation', () => {
    const { service } = fixture()
    rejects(() => service.select({ ...target, toAgentDid: '' }), 'agent_identity_required')
  })
  it('revocation wins over active history and explicit new-thread requests', () => {
    const { state, service } = fixture({ live: thread('live') })
    state.permission = 'revoked'
    rejects(() => service.select(target), 'conversation_reauthorization_required')
    rejects(() => service.select({ ...target, newConversation: true }), 'conversation_reauthorization_required')
  })
  it('an explicitly paused thread does not silently become a new thread', () => {
    const { service } = fixture({ live: thread('live', { communicationState: 'reauthorization_required' }) })
    rejects(() => service.select(target), 'conversation_reauthorization_required')
  })
  it('allows first contact without granting standing permission', () => {
    const { state, service } = fixture()
    state.permission = 'absent'
    assert.equal(service.select(target), undefined)
    assert.equal(state.permission, 'absent')
    assert.deepEqual(state.conversations, {})
  })
  it('refuses closed and rejected explicit threads', () => {
    for (const state of ['closed', 'rejected']) {
      const { service } = fixture({ live: thread('live', { state }) })
      rejects(() => service.select({ ...target, conversationId: 'live' }), 'conversation_unavailable')
    }
  })
  it('rechecks current permission and replaced bindings after asynchronous work', async () => {
    const { state, service } = fixture({ live: thread('live') })
    const send = { ...target, conversationId: 'live' }
    service.assertCanSend(send)
    await Promise.resolve()
    state.permission = 'revoked'
    rejects(() => service.assertCanSend(send), 'conversation_reauthorization_required')
    state.permission = 'allowed'
    state.conversations = { live: thread('live', { peerAgentAuthorityDid: 'new-authority' }) }
    rejects(() => service.assertCanSend(send), 'conversation_mismatch')
    state.conversations = {}
    rejects(() => service.assertCanSend(send), 'conversation_mismatch')
  })
})
