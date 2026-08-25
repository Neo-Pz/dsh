/**
 * Durable Human -> Own Agent Intent handling at the Origin Node.
 *
 * Community owns only a sealed delivery queue. The Node first persists an
 * envelope locally, then acknowledges collection, then asks the selected Agent
 * to decrypt and apply policy. A repeated Community delivery therefore cannot
 * repeat the Agent side effect.
 */

import { canonicalJson, validateEncryptedIntent } from 'iflow-protocol'

const STORE_VERSION = 1
const MAX_TEXT = 16 * 1024
const VIEW_TTL_MS = 2 * 60 * 1000

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

/** Exact AAD shared by Browser and Agent. Community routing cannot be swapped. */
export function intentAad(envelope) {
  return canonicalJson({ version: envelope.version, kind: envelope.kind, routing: envelope.routing })
}

/** Exact AAD shared by Agent and the one Browser View key. */
export function browserViewAad(envelope) {
  return canonicalJson({ version: envelope.version, kind: envelope.kind, routing: envelope.routing })
}

/**
 * P0 deliberately accepts one action only. Unknown fields are rejected so a
 * caller cannot smuggle tool/payment semantics into something labelled chat.
 */
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
  const allowed = new Set(['version', 'kind', 'targetAgentDid', 'text', 'conversationId'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new IntentPolicyError('P0 permits message-only Intent fields', 'unsupported_action')
  }
  if (value.version !== 1 || value.kind !== 'conversation.send') {
    throw new IntentPolicyError('P0 permits only conversation.send', 'unsupported_action')
  }
  if (typeof value.targetAgentDid !== 'string' || !value.targetAgentDid.startsWith('did:key:')) {
    throw new IntentPolicyError('targetAgentDid must be did:key', 'invalid_target')
  }
  if (typeof value.text !== 'string' || value.text.length === 0 || value.text.length > MAX_TEXT) {
    throw new IntentPolicyError(`text must contain 1-${MAX_TEXT} characters`, 'invalid_message')
  }
  if (value.conversationId !== undefined && (typeof value.conversationId !== 'string' || value.conversationId.length > 256)) {
    throw new IntentPolicyError('conversationId must be a short string', 'invalid_conversation')
  }
  return {
    version: 1,
    kind: 'conversation.send',
    targetAgentDid: value.targetAgentDid,
    text: value.text,
    conversationId: value.conversationId,
  }
}

function emptyStore() {
  return { schemaVersion: STORE_VERSION, intents: [] }
}

function safeStore(value) {
  if (!value || value.schemaVersion !== STORE_VERSION || !Array.isArray(value.intents)) return emptyStore()
  return {
    schemaVersion: STORE_VERSION,
    intents: value.intents.filter((record) => record && typeof record.intentId === 'string'),
  }
}

function messageOf(error) {
  return error && error.message ? String(error.message) : String(error)
}

export class LocalIntentQueue {
  constructor({ store, crypto, sendConversation, postView, isAgentAvailable = async () => true, clock = () => new Date(), logger = console }) {
    this.store = store
    this.crypto = crypto
    this.sendConversation = sendConversation
    this.postView = postView
    this.isAgentAvailable = isAgentAvailable
    this.clock = clock
    this.logger = logger
    this.data = null
  }

  async open() {
    if (this.data) return
    this.data = safeStore(await this.store.read())
    // A process that died after declaring an attempt but before its durable
    // outcome retries with the same intent/message id. Relay and recipient
    // dedupe that id, so retry is safer than losing an unknown outcome.
    for (const record of this.data.intents) {
      if (record.state === 'processing') record.state = 'queued'
    }
    await this.persist()
  }

  async persist() {
    await this.store.write(this.data ?? emptyStore())
  }

  /** Persist first; only returned ids may be ACKed to Community. */
  async accept(candidates) {
    await this.open()
    const acknowledged = []
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const validation = validateEncryptedIntent(candidate)
      if (!validation.valid) continue
      const existing = this.data.intents.find((record) => record.intentId === candidate.routing.intentId)
      if (existing) {
        // Same id under different routing is hostile/confused input. Do not ACK
        // it as the record we already persisted.
        if (
          existing.principalId === candidate.routing.principalId &&
          existing.browserSessionId === candidate.routing.browserSessionId &&
          existing.ownAgentDid === candidate.routing.toAgentDid
        ) acknowledged.push(existing.intentId)
        continue
      }
      const now = this.clock().toISOString()
      this.data.intents.push({
        intentId: candidate.routing.intentId,
        principalId: candidate.routing.principalId,
        browserSessionId: candidate.routing.browserSessionId,
        ownAgentDid: candidate.routing.toAgentDid,
        viewPublicKey: candidate.routing.viewPublicKey,
        envelope: candidate,
        state: 'queued',
        attempts: 0,
        receivedAt: now,
        updatedAt: now,
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
      if (!(await this.isAgentAvailable(record.ownAgentDid))) continue
      await this.processOne(record)
    }
  }

  async processOne(record) {
    record.state = 'processing'
    record.attempts += 1
    record.updatedAt = this.clock().toISOString()
    await this.persist()

    try {
      const plaintext = await this.crypto.open(record.ownAgentDid, record.envelope.sealed, intentAad(record.envelope))
      const intent = parseConversationIntent(plaintext)
      const conversationId = intent.conversationId || `web-${record.intentId}`
      const outcome = await this.sendConversation({
        intentId: record.intentId,
        messageId: record.intentId,
        conversationId,
        fromAgentDid: record.ownAgentDid,
        toAgentDid: intent.targetAgentDid,
        text: intent.text,
      })
      if (!outcome || outcome.ok !== true) throw new Error(outcome?.error || 'Agent message was not accepted for delivery')

      record.state = 'sent'
      record.conversationId = conversationId
      record.remoteAgentDid = intent.targetAgentDid
      record.envelope = undefined
      record.lastError = undefined
      record.updatedAt = this.clock().toISOString()
      await this.persist()
      // The Agent side effect is already durable at this point. Browser View
      // delivery is a separate best-effort notification and must never roll a
      // sent Intent back to queued (which could otherwise re-run the action).
      try {
        await this.publishView(record, {
          version: 1,
          kind: 'intent.status',
          intentId: record.intentId,
          state: 'agent_sent',
          conversationId,
          remoteAgentDid: intent.targetAgentDid,
        })
      } catch (viewError) {
        this.logger.warn?.(`iFlow Web Intent ${record.intentId}: could not deliver sent view (${messageOf(viewError)})`)
      }
    } catch (error) {
      if (error instanceof IntentPolicyError || error instanceof IntentEnvelopeError) {
        record.state = 'denied'
        record.envelope = undefined
        record.lastError = error.code
        record.updatedAt = this.clock().toISOString()
        await this.persist()
        try {
          await this.publishView(record, {
            version: 1,
            kind: 'intent.status',
            intentId: record.intentId,
            state: 'policy_denied',
            code: error.code,
          })
        } catch (viewError) {
          this.logger.warn?.(`iFlow Web Intent ${record.intentId}: could not deliver refusal view (${messageOf(viewError)})`)
        }
        return
      }
      // Network/runtime failure is retryable. Keep only sealed ciphertext and
      // a short local error code; never log or persist Human plaintext.
      record.state = 'queued'
      record.lastError = 'delivery_failed'
      record.updatedAt = this.clock().toISOString()
      await this.persist()
      this.logger.log?.(`iFlow Web Intent ${record.intentId}: delivery deferred (${messageOf(error)})`)
    }
  }

  async publishView(record, payload) {
    const now = this.clock()
    const envelope = {
      version: 1,
      kind: 'browser.view',
      routing: {
        deliveryId: `ivw_${crypto.randomUUID()}`,
        intentId: record.intentId,
        principalId: record.principalId,
        browserSessionId: record.browserSessionId,
        viewKeyId: await this.crypto.keyId(record.viewPublicKey),
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + VIEW_TTL_MS).toISOString(),
      },
      sealed: '',
    }
    envelope.sealed = await this.crypto.seal(record.viewPublicKey, JSON.stringify(payload), browserViewAad(envelope))
    await this.postView(envelope)
    return envelope.routing.deliveryId
  }

  /** A remote reply is re-encrypted immediately; plaintext is never stored here. */
  async deliverReply(conversationId, text, fromAgentDid) {
    await this.open()
    const record = this.data.intents.find(
      (candidate) => candidate.state === 'sent' && candidate.conversationId === conversationId,
    )
    if (!record) return false
    await this.publishView(record, {
      version: 1,
      kind: 'conversation.reply',
      intentId: record.intentId,
      conversationId,
      fromAgentDid,
      text,
    })
    return true
  }

  async status() {
    await this.open()
    return this.data.intents.map(({ envelope: _sealed, ...record }) => ({ ...record }))
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
    } catch (error) {
      logger.log?.(`iFlow Web Intent: poll skipped (${messageOf(error)})`)
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return { tick, dispose: () => clearInterval(timer) }
}
