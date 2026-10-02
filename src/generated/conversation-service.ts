// GENERATED from iFlow Connect/packages/iflow-adapter-sdk/src/conversation-service.ts; SHA256 243cbc030c654ff730e8d5be1528bd2f32c8801da64ecccdc11553d0f7cdcee8
// Regenerate: node ../iflow-connect/scripts/sync-connect-snapshots.mjs. Do not edit.
/** Local conversation policy shared by tools and encrypted Web sends.
 * Current state comes from host ports; recheck after asynchronous preparation.
 */
export class ConversationPolicyError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ConversationPolicyError'
    this.code = code
  }
}
export interface ConversationAgentIdentity { agentId: string; did: string }
export interface ConversationTarget {
  fromAgent: ConversationAgentIdentity
  toAgentId: string
  toAgentDid: string
  conversationId?: string
  newConversation?: boolean
}
export interface ConversationEntry {
  conversationId: string
  localAgentId: string
  localAgentAuthorityDid: string
  peerAgentId: string
  peerAgentAuthorityDid: string
  active?: boolean
  state: string
  communicationState?: string
  updatedAt?: string
}
export interface ConversationServicePorts<T extends ConversationEntry> {
  conversations(): Readonly<Record<string, T>>
  pairState(localDid: string, peerDid: string): string | undefined
}
export function assertAgentSigner(signature: { signer?: string } | undefined, agent: { did?: string } | undefined): void {
  if (!agent?.did || signature?.signer !== agent.did) {
    throw new ConversationPolicyError('agent_signing_failed', 'signer does not match selected Agent')
  }
}
export function createConversationService<T extends ConversationEntry>({ conversations, pairState }: ConversationServicePorts<T>) {
  function matchesPair(conversation: T, { fromAgent, toAgentId, toAgentDid }: ConversationTarget): boolean {
    return conversation.localAgentId === fromAgent.agentId &&
      conversation.localAgentAuthorityDid === fromAgent.did &&
      conversation.peerAgentId === toAgentId &&
      conversation.peerAgentAuthorityDid === toAgentDid
  }
  function assertCanSend(target: ConversationTarget): void {
    const { fromAgent, toAgentId, toAgentDid, conversationId } = target
    if (!fromAgent?.agentId || !fromAgent?.did || !toAgentId || !toAgentDid) {
      throw new ConversationPolicyError('agent_identity_required', 'both Agent identities are required')
    }
    if (pairState(fromAgent.did, toAgentDid) === 'revoked') {
      throw new ConversationPolicyError('conversation_reauthorization_required', 'communication permission is paused')
    }
    if (!conversationId) return
    const conversation = conversations()[conversationId]
    if (!conversation || !matchesPair(conversation, target)) {
      throw new ConversationPolicyError('conversation_mismatch', 'the thread must belong to these exact Agents')
    }
    if (conversation.communicationState === 'reauthorization_required') {
      throw new ConversationPolicyError('conversation_reauthorization_required', 'this thread needs local reauthorization')
    }
    if (conversation.state === 'closed' || conversation.state === 'rejected') {
      throw new ConversationPolicyError('conversation_unavailable', 'this thread is no longer open')
    }
  }
  function select(target: ConversationTarget): T | undefined {
    assertCanSend(target)
    if (target.conversationId) return conversations()[target.conversationId]
    if (target.newConversation === true) return undefined
    const selected = Object.values(conversations())
      .filter((conversation) => matchesPair(conversation, target) && conversation.active !== false &&
        (conversation.state === 'active' || conversation.state === 'accepted'))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.conversationId.localeCompare(b.conversationId))[0]
    if (selected) assertCanSend({ ...target, conversationId: selected.conversationId })
    return selected
  }
  return { select, assertCanSend }
}
