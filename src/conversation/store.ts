/**
 * The local half of a Conversation.
 *
 * A Conversation is a thread between Agents and belongs to the iFlow protocol.
 * A Session is a private execution container and belongs to this Runtime.
 * Everything in this file is the mapping between the two, plus the policy that
 * decides whether a thread gets to exist at all.
 *
 * WHERE THIS LIVES, AND WHY IT MATTERS
 *
 * These files sit at `<workspace>/.iflow/`, beside `peers.json` and
 * `mailbox.json` — deliberately NOT under `<workspace>/.iflow/edge/`, which is
 * the sync surface (see `edgePaths` in iflow-adapter-sdk). Nothing here is
 * reachable by the outbox, the Community sink, or any future upload path,
 * because no such path reads this directory level.
 *
 * That is a structural guarantee rather than a rule someone has to remember.
 * `localSessionId` identifies a session in this runtime's private store and
 * `workspaceRoot` is a path on somebody's disk; keeping them where the
 * publishing machinery cannot see them is stronger than trusting a redactor to
 * strip them on the way out.
 */

// Explicit `.ts`, unlike the `.js` specifiers elsewhere in this plugin: those
// files are only ever seen by esbuild, while this module is also imported raw
// by its unit test, and node does not remap the extension.
import { signingDigest } from '../util/hash.ts'

const CONVERSATIONS = 'conversations.json'
const TRUST = 'trust.json'

/** Threads and their bindings. Local only. */
export function conversationsPath(join, workspace) {
  return join(workspace, '.iflow', CONVERSATIONS)
}

/** Who may open a thread here without asking. Local only. */
export function trustPath(join, workspace) {
  return join(workspace, '.iflow', TRUST)
}

/**
 * How this node answers a stranger.
 *
 * `ask` is the default, and it is the whole point of the object. Before this
 * existed, an inbound message went straight to a model: an unknown peer could
 * create sessions, spend tokens and trigger tools without anyone here agreeing
 * to talk to it. Message ACCEPTANCE and tool AUTHORIZATION are two different
 * questions, and the restricted `remote-a2a` preset only ever answered the
 * second one.
 */
export const DEFAULT_TRUST = Object.freeze({ default: 'ask', peers: {}, blocked: [] })

const TRUST_MODES = new Set(['ask', 'auto', 'reject'])

export async function loadTrust(ctx, join, workspace) {
  try {
    const resolved = await ctx.fs.resolve(trustPath(join, workspace))
    const data = JSON.parse(await ctx.fs.readText(resolved))
    const mode = TRUST_MODES.has(data?.default) ? data.default : DEFAULT_TRUST.default
    const peers = {}
    for (const [name, value] of Object.entries(data?.peers ?? {})) {
      if (TRUST_MODES.has(value)) peers[name] = value
    }
    return {
      default: mode,
      peers,
      blocked: Array.isArray(data?.blocked) ? data.blocked.filter((d) => typeof d === 'string') : [],
    }
  } catch (error) {
    // A missing file is the normal state of a fresh node, and an unreadable one
    // must not silently become permissive: both answer `ask`.
    return { ...DEFAULT_TRUST, peers: {}, blocked: [] }
  }
}

export async function saveTrust(ctx, join, workspace, trust) {
  const resolved = await ctx.fs.resolve(trustPath(join, workspace))
  await ctx.fs.writeText(resolved, JSON.stringify(trust, null, 2))
}

/**
 * Should this message be let in?
 *
 * Pure, so the policy can be tested without a filesystem or a peer. Returns
 * one of `accept` / `ask` / `reject`, and nothing else decides it — in
 * particular an already-accepted thread stays accepted, because asking a
 * person to re-approve every message of a conversation they already joined is
 * how an approval prompt becomes something people click through.
 */
export function trustDecision(trust, { peerLabel, signerDid, conversation, pairMessaging } = {}) {
  // A block is absolute and is checked first: it must not be reachable around
  // by opening a new thread or by an earlier acceptance.
  if (signerDid && trust.blocked.includes(signerDid)) return 'reject'
  if (peerLabel && trust.blocked.includes(peerLabel)) return 'reject'

  // A revoked pair is not a permanent block.  It is a person taking back the
  // standing answer that made an active thread automatic.  It has to win over
  // that thread's historical `accepted` state or revocation would only affect
  // imaginary future threads while the real one kept spending this machine.
  if (pairMessaging === 'revoked') return 'ask'

  if (conversation) {
    if (conversation.state === 'rejected' || conversation.state === 'closed') return 'reject'
    if (conversation.state === 'accepted' || conversation.state === 'active') return 'accept'
    // `pending` falls through: it is still waiting on the same answer.
  }

  // A person already said yes to this pair of Agents. The gate exists to stop a
  // STRANGER spending a model here; once someone has looked at a first contact
  // and allowed it, asking again on every new thread is the same question with
  // a worse answer rate, and it trains people to click through it.
  //
  // Checked AFTER the block list and after a rejected thread, so neither can be
  // walked around by reconnecting. It permits messages arriving without a
  // prompt, and nothing else — running a tool, spending, and settling a Task
  // are separate questions the caller must still ask separately.
  if (pairMessaging === 'allowed') return 'accept'

  const named = (peerLabel && trust.peers[peerLabel]) ?? (signerDid && trust.peers[signerDid])
  const mode = named ?? trust.default
  if (mode === 'auto') return 'accept'
  if (mode === 'reject') return 'reject'
  return 'ask'
}

/**
 * The content digest that travels in a `conversation.message_*` fact.
 *
 * The plaintext is the most revealing thing this node holds and it stays here.
 * A digest still proves "this exact message is the one that was exchanged" to
 * anyone already holding the plaintext, which is the only party entitled to
 * check it.
 */
export function messageDigest(text) {
  return 'sha256:' + signingDigest(typeof text === 'string' ? text : String(text ?? ''))
}

export async function loadConversations(ctx, join, workspace) {
  try {
    const resolved = await ctx.fs.resolve(conversationsPath(join, workspace))
    const data = JSON.parse(await ctx.fs.readText(resolved))
    const conversations = {}
    for (const [id, value] of Object.entries(data?.conversations ?? {})) {
      if (!value || typeof value !== 'object') continue
      conversations[id] = normalize(id, value)
    }
    return { conversations }
  } catch (error) {
    return { conversations: {} }
  }
}

export async function saveConversations(ctx, join, workspace, store) {
  const resolved = await ctx.fs.resolve(conversationsPath(join, workspace))
  await ctx.fs.writeText(resolved, JSON.stringify(store, null, 2))
}

function normalize(id, value) {
  return {
    conversationId: id,
    localAgentId: typeof value.localAgentId === 'string' ? value.localAgentId : null,
    localAgentAuthorityDid: typeof value.localAgentAuthorityDid === 'string' ? value.localAgentAuthorityDid : null,
    peerAgentId: typeof value.peerAgentId === 'string' ? value.peerAgentId : (typeof value.peer === 'string' ? value.peer : null),
    peerAgentAuthorityDid: typeof value.peerAgentAuthorityDid === 'string'
      ? value.peerAgentAuthorityDid
      : (typeof value.peerDid === 'string' ? value.peerDid : null),
    peer: typeof value.peer === 'string' ? value.peer : null,
    peerDid: typeof value.peerDid === 'string' ? value.peerDid : null,
    mode: value.mode === 'assisted' ? 'assisted' : 'direct',
    active: value.active !== false,
    state: typeof value.state === 'string' ? value.state : 'pending',
    communicationState: value.communicationState === 'reauthorization_required'
      ? 'reauthorization_required'
      : 'active',
    binding: value.binding && typeof value.binding === 'object' ? value.binding : null,
    pendingTask: value.pendingTask ?? null,
    preview: typeof value.preview === 'string' ? value.preview : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    seenMessageIds: Array.isArray(value.seenMessageIds) ? value.seenMessageIds.slice(-SEEN_LIMIT) : [],
    outbound: Array.isArray(value.outbound) ? value.outbound.slice(-OUTBOUND_LIMIT) : [],
    deliveries: Array.isArray(value.deliveries) ? value.deliveries.slice(-DELIVERY_LIMIT) : [],
    drafts: Array.isArray(value.drafts) ? value.drafts.slice(-DRAFT_LIMIT) : [],
  }
}

/** How many message ids a thread remembers for duplicate suppression. */
const SEEN_LIMIT = 200

/** How many sent-message receipts a thread keeps. */
const OUTBOUND_LIMIT = 50

/** How many Deliveries a thread keeps a ruling record for. */
const DELIVERY_LIMIT = 50
const DRAFT_LIMIT = 20

/**
 * What is known about a message this node sent through the relay.
 *
 * `queued` and `delivered` are the relay's to report: it knows whether the
 * envelope was collected. `accepted` and `rejected` are not — the relay
 * cannot read a message, so it cannot know whether a person on the far side
 * agreed to it. Those two arrive with the answer, which is the only thing
 * that carries the recipient's decision.
 *
 * `unknown` is honest rather than optimistic: a relay that has forgotten a
 * message has not told us it arrived.
 */
export const OUTBOUND_STATES = Object.freeze(['queued', 'delivered', 'accepted', 'rejected', 'expired', 'unknown'])

export function newConversation(id, {
  peer,
  peerDid,
  localAgentId,
  localAgentAuthorityDid,
  peerAgentId,
  peerAgentAuthorityDid,
  mode,
  state,
  preview,
  now,
}) {
  const at = now ?? new Date().toISOString()
  return {
    conversationId: id,
    localAgentId: localAgentId ?? null,
    localAgentAuthorityDid: localAgentAuthorityDid ?? null,
    peerAgentId: peerAgentId ?? peer ?? null,
    peerAgentAuthorityDid: peerAgentAuthorityDid ?? peerDid ?? null,
    peer: peer ?? null,
    peerDid: peerDid ?? null,
    mode: mode === 'assisted' ? 'assisted' : 'direct',
    active: true,
    state: state ?? 'pending',
    communicationState: 'active',
    binding: null,
    pendingTask: null,
    // Local only, and the reason IncomingRequest's excerpt never appears in a
    // projection: a person needs to see something to decide, and that
    // something is exactly the text we refuse to publish.
    preview: (preview ?? '').slice(0, 200),
    createdAt: at,
    updatedAt: at,
    seenMessageIds: [],
    outbound: [],
    deliveries: [],
    drafts: [],
  }
}

/**
 * A pair has an active pointer, not a permanent uniqueness constraint. An
 * explicit new Conversation closes only the pointer and preserves history.
 */
export function findActiveConversation(conversations, localAgentId, peerAgentId) {
  return Object.values(conversations).find((conversation) =>
    conversation.active !== false &&
    conversation.localAgentId === localAgentId &&
    conversation.peerAgentId === peerAgentId &&
    conversation.state !== 'closed' && conversation.state !== 'rejected',
  )
}

/**
 * The open thread with a peer named the way an outbound send names them.
 *
 * `findActiveConversation` matches on the peer's Agent id, which an inbound
 * message carries and an outbound one often does not: `iflow_send` is given a
 * registered peer name or a URL, and the Agent id only becomes known once the
 * far side answers. `newConversation` stores that name in both `peer` and
 * `peerAgentId`, so matching either is what finds the thread the person means.
 *
 * `localAgentId` is null on threads opened before outbound sends recorded it;
 * those still match, because refusing to reuse them would leave exactly the
 * pile of duplicates this exists to prevent.
 */
export function findConversationWithPeer(conversations, localAgentId, peer) {
  if (!peer) return undefined
  return Object.values(conversations).find((conversation) =>
    conversation.active !== false &&
    (conversation.peer === peer || conversation.peerAgentId === peer) &&
    (conversation.localAgentId == null || localAgentId == null || conversation.localAgentId === localAgentId) &&
    conversation.state !== 'closed' && conversation.state !== 'rejected',
  )
}

/**
 * One row per counterparty, for a list of who you talk to.
 *
 * Listing every thread showed the same Agent three times with nothing to tell
 * the rows apart — a session manager wearing a chat app's clothes. The active
 * thread is the one a message would continue, so it is the one that represents
 * the pair; older threads keep their history and stop competing for the line.
 *
 * A thread with no counterparty recorded is skipped rather than grouped under
 * a missing key, which would merge unrelated threads into one phantom row.
 */
export function collapseToCounterparties(conversations, localAgentId) {
  const newest = new Map()
  for (const candidate of Object.values(conversations)) {
    if (candidate.localAgentId !== localAgentId) continue
    const counterparty = candidate.peerAgentId || candidate.peer
    if (!counterparty) continue
    const held = newest.get(counterparty)
    const liveNow = candidate.active !== false
    const liveHeld = held ? held.active !== false : false
    // Active wins outright; among equals, whichever spoke last.
    const better = !held
      || (liveNow && !liveHeld)
      || (liveNow === liveHeld && String(candidate.updatedAt) > String(held.updatedAt))
    if (better) newest.set(counterparty, candidate)
  }
  return [...newest.values()].sort((left, right) =>
    String(right.updatedAt).localeCompare(String(left.updatedAt)),
  )
}

export function activateConversation(conversations, conversation) {
  for (const candidate of Object.values(conversations)) {
    if (candidate.conversationId === conversation.conversationId) continue
    if (candidate.localAgentId === conversation.localAgentId && candidate.peerAgentId === conversation.peerAgentId) {
      candidate.active = false
    }
  }
  conversation.active = true
  return conversation
}

/**
 * Remember a message id, and say whether it is new.
 *
 * The signature envelope's nonce already stops a replayed HTTP request. This
 * is the layer below that: the same logical message redelivered from an outbox
 * must not be injected into the session twice.
 */
export function markSeen(conversation, messageId) {
  if (!messageId) return true
  if (conversation.seenMessageIds.includes(messageId)) return false
  conversation.seenMessageIds.push(messageId)
  if (conversation.seenMessageIds.length > SEEN_LIMIT) {
    conversation.seenMessageIds.splice(0, conversation.seenMessageIds.length - SEEN_LIMIT)
  }
  return true
}

/**
 * The Runtime-private mapping. Never leaves this machine.
 *
 * `{ conversationId, runtime, workspaceId, localSessionId }` is the whole
 * object: the far side has its own, with a different `localSessionId`, and
 * neither ever learns the other's.
 */
export function bindSession(conversation, { runtime, workspaceId, localSessionId, now }) {
  conversation.binding = { runtime, workspaceId, localSessionId }
  conversation.updatedAt = now ?? new Date().toISOString()
  return conversation.binding
}

export function putDraft(conversation, { draftId, text, originIntentId, expiresAt, now }) {
  const at = now ?? new Date().toISOString()
  conversation.drafts = (conversation.drafts ?? []).filter((draft) => draft.draftId !== draftId)
  conversation.drafts.push({ draftId, text, originIntentId, state: 'pending', createdAt: at, expiresAt })
  if (conversation.drafts.length > DRAFT_LIMIT) conversation.drafts.splice(0, conversation.drafts.length - DRAFT_LIMIT)
  conversation.updatedAt = at
  return conversation.drafts.at(-1)
}

/**
 * A remote Agent handed work back, and nobody here has ruled on it.
 *
 * Kept per Conversation rather than globally because ruling on a Delivery is a
 * decision about a counterparty, and the thread is where a person can see what
 * was asked. The answer text is NOT stored here — it is already in the bound
 * DSH session, which is where a person reads it; this records that a decision
 * is owed, and what it is owed about.
 */
export function recordDelivery(conversation, { deliveryId, taskId, digest, now }) {
  const at = now ?? new Date().toISOString()
  conversation.deliveries = (conversation.deliveries ?? []).filter((d) => d.deliveryId !== deliveryId)
  conversation.deliveries.push({ deliveryId, taskId, digest, state: 'pending', receivedAt: at })
  if (conversation.deliveries.length > DELIVERY_LIMIT) {
    conversation.deliveries.splice(0, conversation.deliveries.length - DELIVERY_LIMIT)
  }
  conversation.updatedAt = at
  return conversation.deliveries.at(-1)
}

/**
 * Accept or send back. Idempotent and one-way: a Delivery already ruled on
 * stays ruled on, because re-deciding would let a later poll or a stray click
 * overturn something the counterparty has already been told.
 */
export function decideDelivery(conversation, deliveryId, decision, now) {
  const delivery = (conversation.deliveries ?? []).find((d) => d.deliveryId === deliveryId)
  if (!delivery || delivery.state !== 'pending') return null
  if (decision !== 'accept' && decision !== 'reject') return null
  delivery.state = decision === 'accept' ? 'accepted' : 'rejected'
  delivery.decidedAt = now ?? new Date().toISOString()
  conversation.updatedAt = delivery.decidedAt
  return delivery
}

/** Every Delivery still owed a ruling, newest first, across all threads. */
export function pendingDeliveries(conversations) {
  const open = []
  for (const conversation of Object.values(conversations)) {
    for (const delivery of conversation.deliveries ?? []) {
      if (delivery.state === 'pending') open.push({ conversation, delivery })
    }
  }
  return open.sort((a, b) => String(b.delivery.receivedAt).localeCompare(String(a.delivery.receivedAt)))
}

export function decideDraft(conversation, draftId, decision, now) {
  const draft = (conversation.drafts ?? []).find((candidate) => candidate.draftId === draftId)
  if (!draft || draft.state !== 'pending') return null
  if (draft.expiresAt && Date.parse(draft.expiresAt) <= Date.parse(now ?? new Date().toISOString())) {
    draft.state = 'expired'
    return null
  }
  draft.state = decision === 'confirm' ? 'confirmed' : 'cancelled'
  draft.decidedAt = now ?? new Date().toISOString()
  conversation.updatedAt = draft.decidedAt
  return draft
}

/** Note that a message went out, so its fate can be asked about later. */
export function recordOutbound(conversation, { messageId, preview, now }) {
  if (!messageId) return
  const at = now ?? new Date().toISOString()
  conversation.outbound = (conversation.outbound ?? []).filter((m) => m.messageId !== messageId)
  conversation.outbound.push({
    messageId,
    state: 'queued',
    sentAt: at,
    updatedAt: at,
    preview: (preview ?? '').slice(0, 120),
  })
  if (conversation.outbound.length > OUTBOUND_LIMIT) {
    conversation.outbound.splice(0, conversation.outbound.length - OUTBOUND_LIMIT)
  }
}

/**
 * Move one sent message to a new state.
 *
 * Refuses to walk backwards. The relay is polled, and a status read that
 * arrives out of order must not turn an accepted message back into a delivered
 * one — `delivered` is what the relay knows, `accepted` is what the recipient
 * said, and the second outranks the first however late it lands.
 */
const OUTBOUND_RANK = { unknown: 0, queued: 1, expired: 2, delivered: 2, rejected: 3, accepted: 3 }

export function markOutbound(conversation, messageId, next, now) {
  const entry = (conversation.outbound ?? []).find((m) => m.messageId === messageId)
  if (!entry) return false
  if (!OUTBOUND_STATES.includes(next)) return false
  if ((OUTBOUND_RANK[next] ?? 0) < (OUTBOUND_RANK[entry.state] ?? 0)) return false
  if (entry.state === next) return false
  entry.state = next
  entry.updatedAt = now ?? new Date().toISOString()
  return true
}

/** Messages whose fate the relay might still be able to report. */
export function pendingOutbound(conversations) {
  const out = []
  for (const conversation of Object.values(conversations)) {
    for (const message of conversation.outbound ?? []) {
      if (message.state === 'queued' || message.state === 'delivered') {
        out.push({ conversationId: conversation.conversationId, messageId: message.messageId })
      }
    }
  }
  return out
}
