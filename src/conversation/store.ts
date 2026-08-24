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
export function trustDecision(trust, { peerLabel, signerDid, conversation } = {}) {
  // A block is absolute and is checked first: it must not be reachable around
  // by opening a new thread or by an earlier acceptance.
  if (signerDid && trust.blocked.includes(signerDid)) return 'reject'
  if (peerLabel && trust.blocked.includes(peerLabel)) return 'reject'

  if (conversation) {
    if (conversation.state === 'rejected' || conversation.state === 'closed') return 'reject'
    if (conversation.state === 'accepted' || conversation.state === 'active') return 'accept'
    // `pending` falls through: it is still waiting on the same answer.
  }

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
    peer: typeof value.peer === 'string' ? value.peer : null,
    peerDid: typeof value.peerDid === 'string' ? value.peerDid : null,
    state: typeof value.state === 'string' ? value.state : 'pending',
    binding: value.binding && typeof value.binding === 'object' ? value.binding : null,
    pendingTask: value.pendingTask ?? null,
    preview: typeof value.preview === 'string' ? value.preview : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
    seenMessageIds: Array.isArray(value.seenMessageIds) ? value.seenMessageIds.slice(-SEEN_LIMIT) : [],
    outbound: Array.isArray(value.outbound) ? value.outbound.slice(-OUTBOUND_LIMIT) : [],
  }
}

/** How many message ids a thread remembers for duplicate suppression. */
const SEEN_LIMIT = 200

/** How many sent-message receipts a thread keeps. */
const OUTBOUND_LIMIT = 50

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

export function newConversation(id, { peer, peerDid, state, preview, now }) {
  const at = now ?? new Date().toISOString()
  return {
    conversationId: id,
    peer: peer ?? null,
    peerDid: peerDid ?? null,
    state: state ?? 'pending',
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
  }
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
