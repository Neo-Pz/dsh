/**
 * Durable Human -> Own Agent Intent handling at the Origin Node.
 * Community owns only sealed queues. Plaintext is opened by the selected
 * Agent authority and private projections are sealed to a browser view key.
 */
import { canonicalJson, validateEncryptedIntent } from 'iflow-protocol'

const STORE_VERSION = 2
const MAX_TEXT = 16 * 1024
const DEFAULT_SYNC_LIMIT = 50
const MAX_SYNC_LIMIT = 100
const VIEW_TTL_MS = 10 * 60 * 1000

export class IntentPolicyError extends Error {
  constructor(message, code = 'policy_denied') {
    super(message)
    this.name = 'IntentPolicyError'
    this.code = code
  }
}

export class IntentEnvelopeError extends Error {
  constructor(message, code = 'intent_unreadable') {
    super(message)
    this.name = 'IntentEnvelopeError'
    this.code = code
  }
}

export function intentAad(envelope) {
  return canonicalJson({ version: envelope.version, kind: envelope.kind, routing: envelope.routing })
}

export function browserViewAad(envelope) {
  return canonicalJson({ version: envelope.version, kind: envelope.kind, routing: envelope.routing })
}

function shortString(value, name, { optional = false, max = 256 } = {}) {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new IntentPolicyError(`${name} must contain 1-${max} characters`, `invalid_${name}`)
  }
  return value
}

function only(value, fields) {
  if (Object.keys(value).some((key) => !fields.has(key))) {
    throw new IntentPolicyError('Intent contains fields outside its declared action', 'unsupported_action')
  }
}

/** Parse the complete P0 private conversation command vocabulary. */
export function parseConversationIntent(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new IntentPolicyError('Intent plaintext is not JSON', 'invalid_plaintext')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntentPolicyError('Intent plaintext must be an object', 'invalid_plaintext')
  }
  if (value.version !== 1 || typeof value.kind !== 'string') {
    throw new IntentPolicyError('Intent version or kind is unsupported', 'unsupported_action')
  }

  if (value.kind === 'conversation.send') {
    only(value, new Set([
      'version', 'kind', 'mode', 'targetAgentId', 'targetAgentAuthorityDid', 'text', 'conversationId',
    ]))
    if (value.mode !== 'direct' && value.mode !== 'assisted') {
      throw new IntentPolicyError('mode must be direct or assisted', 'invalid_mode')
    }
    const targetAgentAuthorityDid = shortString(value.targetAgentAuthorityDid, 'targetAgentAuthorityDid')
    if (!targetAgentAuthorityDid.startsWith('did:key:')) {
      throw new IntentPolicyError('targetAgentAuthorityDid must be did:key', 'invalid_target')
    }
    if (typeof value.text !== 'string' || value.text.length === 0 || value.text.length > MAX_TEXT) {
      throw new IntentPolicyError(`text must contain 1-${MAX_TEXT} characters`, 'invalid_message')
    }
    return {
      version: 1,
      kind: value.kind,
      mode: value.mode,
      targetAgentId: shortString(value.targetAgentId, 'targetAgentId'),
      targetAgentAuthorityDid,
      text: value.text,
      conversationId: shortString(value.conversationId, 'conversationId', { optional: true }),
    }
  }

  if (value.kind === 'conversation.sync') {
    only(value, new Set(['version', 'kind', 'ownAgentId', 'peerAgentId', 'conversationId', 'cursor', 'limit']))
    if (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_SYNC_LIMIT)) {
      throw new IntentPolicyError(`limit must be an integer from 1-${MAX_SYNC_LIMIT}`, 'invalid_limit')
    }
    const conversationId = shortString(value.conversationId, 'conversationId', { optional: true })
    const peerAgentId = shortString(value.peerAgentId, 'peerAgentId', { optional: true })
    return {
      version: 1,
      kind: value.kind,
      ownAgentId: shortString(value.ownAgentId, 'ownAgentId'),
      peerAgentId,
      conversationId,
      cursor: shortString(value.cursor, 'cursor', { optional: true }),
      limit: value.limit ?? DEFAULT_SYNC_LIMIT,
    }
  }

  if (value.kind === 'conversation.draft.decide') {
    only(value, new Set(['version', 'kind', 'conversationId', 'draftId', 'decision']))
    if (value.decision !== 'confirm' && value.decision !== 'cancel') {
      throw new IntentPolicyError('decision must be confirm or cancel', 'invalid_decision')
    }
    return {
      version: 1,
      kind: value.kind,
      conversationId: shortString(value.conversationId, 'conversationId'),
      draftId: shortString(value.draftId, 'draftId'),
      decision: value.decision,
    }
  }
  throw new IntentPolicyError('Intent action is unsupported', 'unsupported_action')
}

function emptyStore() {
  return { schemaVersion: STORE_VERSION, intents: [], viewBindings: [] }
}

function safeStore(value) {
  if (!value || !Array.isArray(value.intents)) return emptyStore()
  return {
    schemaVersion: STORE_VERSION,
    intents: value.intents.filter((record) => record && typeof record.intentId === 'string'),
    viewBindings: Array.isArray(value.viewBindings)
      ? value.viewBindings.filter((binding) => binding && typeof binding.browserSessionId === 'string')
      : [],
  }
}

function messageOf(error) {
  return error && error.message ? String(error.message) : String(error)
}

function envelopeIsValid(candidate) {
  const result = validateEncryptedIntent(candidate)
  if (result.valid) return true
  // Temporary strict bridge while installed runtimes move from 0.3 to the
  // published identity-separated contract.
  const routing = candidate?.routing
  return candidate?.version === 1 && candidate?.kind === 'human.intent' &&
    typeof routing?.intentId === 'string' && typeof routing?.principalId === 'string' &&
    typeof routing?.toAgentId === 'string' && typeof routing?.toAgentAuthorityDid === 'string' &&
    typeof routing?.browserSessionId === 'string' && typeof routing?.viewPublicKey === 'string' &&
    typeof routing?.issuedAt === 'string' && typeof routing?.expiresAt === 'string' &&
    typeof candidate?.sealed === 'string'
}

export class LocalIntentQueue {
  constructor({ store, crypto, executeIntent, postView, isAgentAvailable = async () => true, clock = () => new Date(), logger = console }) {
    this.store = store
    this.crypto = crypto
    this.executeIntent = executeIntent
    this.postView = postView
    this.isAgentAvailable = isAgentAvailable
    this.clock = clock
    this.logger = logger
    this.data = null
  }

  async open() {
    if (this.data) return
    this.data = safeStore(await this.store.read())
    for (const record of this.data.intents) if (record.state === 'processing') record.state = 'queued'
    this.pruneBindings()
    await this.persist()
  }

  async persist() {
    await this.store.write(this.data ?? emptyStore())
  }

  pruneBindings() {
    const now = this.clock().getTime()
    this.data.viewBindings = this.data.viewBindings.filter((binding) => Date.parse(binding.expiresAt) > now)
  }

  /** Persist first; only returned ids may be ACKed to Community. */
  async accept(candidates) {
    await this.open()
    const acknowledged = []
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (!envelopeIsValid(candidate)) continue
      const existing = this.data.intents.find((record) => record.intentId === candidate.routing.intentId)
      if (existing) {
        if (existing.principalId === candidate.routing.principalId &&
          existing.browserSessionId === candidate.routing.browserSessionId &&
          existing.ownAgentId === candidate.routing.toAgentId &&
          existing.ownAgentAuthorityDid === candidate.routing.toAgentAuthorityDid) acknowledged.push(existing.intentId)
        continue
      }
      const now = this.clock().toISOString()
      this.data.intents.push({
        intentId: candidate.routing.intentId,
        principalId: candidate.routing.principalId,
        browserSessionId: candidate.routing.browserSessionId,
        ownAgentId: candidate.routing.toAgentId,
        ownAgentAuthorityDid: candidate.routing.toAgentAuthorityDid,
        viewPublicKey: candidate.routing.viewPublicKey,
        envelope: candidate,
        state: 'queued', attempts: 0, receivedAt: now, updatedAt: now,
      })
      acknowledged.push(candidate.routing.intentId)
    }
    await this.persist()
    return acknowledged
  }

  async process() {
    await this.open()
    for (const record of this.data.intents) {
      if (record.state !== 'queued') continue
      if (!(await this.isAgentAvailable(record.ownAgentId, record.ownAgentAuthorityDid))) continue
      await this.processOne(record)
    }
  }

  async processOne(record) {
    record.state = 'processing'; record.attempts += 1; record.updatedAt = this.clock().toISOString()
    await this.persist()
    try {
      const plaintext = await this.crypto.open(record.ownAgentAuthorityDid, record.envelope.sealed, intentAad(record.envelope))
      const intent = parseConversationIntent(plaintext)
      if (intent.kind === 'conversation.sync' && intent.ownAgentId !== record.ownAgentId) {
        throw new IntentPolicyError('sync ownAgentId does not match the selected Agent', 'agent_mismatch')
      }
      const result = await this.executeIntent({
        intentId: record.intentId,
        principalId: record.principalId,
        ownAgentId: record.ownAgentId,
        ownAgentAuthorityDid: record.ownAgentAuthorityDid,
        intent,
      })
      if (!result || result.ok !== true) throw new Error(result?.error || 'Agent did not accept the Intent')
      record.state = result.state ?? 'completed'
      record.conversationId = result.conversationId ?? intent.conversationId
      record.remoteAgentId = result.remoteAgentId ?? intent.targetAgentId ?? intent.peerAgentId
      record.envelope = undefined; record.lastError = undefined; record.updatedAt = this.clock().toISOString()
      if (record.conversationId) this.bindBrowserView(record, record.conversationId)
      await this.persist()
      for (const view of result.views ?? []) {
        try { await this.publishView(record, view) }
        catch (viewError) { this.logger.warn?.(`iFlow Web Intent ${record.intentId}: private view deferred (${messageOf(viewError)})`) }
      }
    } catch (error) {
      if (error instanceof IntentPolicyError || error instanceof IntentEnvelopeError) {
        record.state = 'denied'; record.envelope = undefined; record.lastError = error.code; record.updatedAt = this.clock().toISOString()
        await this.persist()
        try {
          await this.publishView(record, { version: 1, kind: 'conversation.status', conversationId: record.conversationId ?? '', state: 'failed', code: error.code })
        } catch (viewError) { this.logger.warn?.(`iFlow Web Intent ${record.intentId}: refusal view deferred (${messageOf(viewError)})`) }
        return
      }
      record.state = 'queued'; record.lastError = 'delivery_failed'; record.updatedAt = this.clock().toISOString()
      await this.persist()
      this.logger.log?.(`iFlow Web Intent ${record.intentId}: delivery deferred (${messageOf(error)})`)
    }
  }

  bindBrowserView(record, conversationId) {
    const key = `${record.principalId}\u0000${record.ownAgentId}\u0000${record.browserSessionId}\u0000${conversationId}`
    const now = this.clock()
    this.data.viewBindings = this.data.viewBindings.filter((binding) => binding.key !== key)
    this.data.viewBindings.push({
      key, principalId: record.principalId, ownAgentId: record.ownAgentId,
      browserSessionId: record.browserSessionId, conversationId,
      anchorIntentId: record.intentId, viewPublicKey: record.viewPublicKey,
      expiresAt: new Date(now.getTime() + VIEW_TTL_MS).toISOString(),
    })
  }

  async publishView(recordOrBinding, payload) {
    const now = this.clock()
    const conversationId = payload.conversationId || recordOrBinding.conversationId
    const envelope = {
      version: 1, kind: 'browser.view',
      routing: {
        deliveryId: `ivw_${crypto.randomUUID()}`,
        intentId: recordOrBinding.intentId ?? recordOrBinding.anchorIntentId,
        principalId: recordOrBinding.principalId,
        browserSessionId: recordOrBinding.browserSessionId,
        viewKeyId: await this.crypto.keyId(recordOrBinding.viewPublicKey),
        ...(conversationId ? { conversationId } : {}),
        ...(recordOrBinding.ownAgentId ? { ownAgentId: recordOrBinding.ownAgentId } : {}),
        issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + VIEW_TTL_MS).toISOString(),
      }, sealed: '',
    }
    envelope.sealed = await this.crypto.seal(recordOrBinding.viewPublicKey, JSON.stringify(payload), browserViewAad(envelope))
    await this.postView(envelope)
    return envelope.routing.deliveryId
  }

  /** Fan out one reply to every live browser session bound to this conversation. */
  async deliverReply(conversationId, message) {
    await this.open(); this.pruneBindings()
    const bindings = this.data.viewBindings.filter((binding) => binding.conversationId === conversationId)
    let delivered = 0
    for (const binding of bindings) {
      try {
        await this.publishView(binding, { version: 1, kind: 'conversation.message', conversationId, message })
        delivered += 1
      } catch (error) { this.logger.warn?.(`iFlow Web View ${binding.browserSessionId}: reply deferred (${messageOf(error)})`) }
    }
    await this.persist()
    return delivered > 0
  }

  async status() {
    await this.open()
    return this.data.intents.map(({ envelope: _sealed, viewPublicKey: _key, ...record }) => ({ ...record }))
  }
}

/** Polling has one in-flight tick and never keeps DSH alive by itself. */
export function startLocalIntentPolling({ queue, settings, inbox, ack, intervalMs = 15_000, logger = console }) {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const current = settings()
      if (!current) return
      const envelopes = await inbox(current)
      const persisted = await queue.accept(envelopes)
      if (persisted.length > 0) await ack(current, persisted)
      await queue.process()
    } catch (error) { logger.log?.(`iFlow Web Intent: poll skipped (${messageOf(error)})`) }
    finally { running = false }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return { tick, dispose: () => clearInterval(timer) }
}
