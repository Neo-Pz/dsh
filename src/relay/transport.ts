/**
 * Talking to the relay.
 *
 * A factory rather than a module of functions, because every call needs the
 * identity binary, the scratch directory and an HTTP client that all live in
 * the plugin's closure. What it gives back is four operations and a poll loop,
 * with the crypto on the inside so no caller can forget it.
 *
 * The shape of the loop — a `running` guard, an unref'd interval, a disposer —
 * is copied from `src/edge/sync.ts` on purpose: a second scheduling idiom in
 * one plugin is a second set of shutdown bugs.
 */

// Explicit `.ts`, as in src/conversation/store.ts: this module is imported raw
// by its test as well as bundled by esbuild, and node does not remap `.js`.
import { envelopeAad, packRelayPayload, unpackRelayPayload } from './envelope.ts'

/**
 * @param io.iflowId      run the identity binary (args[, timeout]) -> stdout
 * @param io.scratchPath  a writable path for bytes handed to that binary
 * @param io.readBytes    read a file as a Buffer
 * @param io.writeBytes   write a Buffer or string to a file
 * @param io.post         POST JSON to an absolute URL with a bearer token
 * @param io.get          GET from an absolute URL with a bearer token
 * @param io.logger       console-like
 */
export function createRelayTransport(io) {
  const { iflowId, scratchPath, readBytes, writeBytes, post, get, logger = console } = io

  /** Seal a signed request for one recipient, bound to its routing metadata. */
  async function seal({ toDid, body, signature, conversationId, messageId, fromDid }) {
    const payload = packRelayPayload(body, signature)
    const plainPath = scratchPath(`relay-out-${messageId}.json`)
    const sealedPath = scratchPath(`relay-out-${messageId}.bin`)
    await writeBytes(plainPath, payload)
    const aad = envelopeAad({ conversationId, messageId, fromDid, toDid })
    await iflowId(['seal', toDid, plainPath, sealedPath, aad], 20)
    const bytes = await readBytes(sealedPath)
    return Buffer.from(bytes).toString('base64url')
  }

  /**
   * Open an envelope addressed to this node.
   *
   * A failure here is not an error to retry: it means the envelope was not
   * for this identity, was altered, or arrived under different routing
   * metadata than it was sealed with. All three are the relay misbehaving or
   * someone trying something, and none is fixed by asking again.
   */
  async function open(envelope) {
    const sealedPath = scratchPath(`relay-in-${envelope.id}.bin`)
    const plainPath = scratchPath(`relay-in-${envelope.id}.json`)
    await writeBytes(sealedPath, Buffer.from(envelope.sealed, 'base64url'))
    const aad = envelopeAad({
      conversationId: envelope.conversation_id,
      messageId: envelope.id,
      fromDid: envelope.from_did,
      toDid: envelope.to_did,
    })
    await iflowId(['open', sealedPath, plainPath, aad], 20)
    return unpackRelayPayload(Buffer.from(await readBytes(plainPath)).toString('utf8'))
  }

  async function send({ url, token, toDid, sealed, messageId, conversationId, fromDid }) {
    return post(
      `${url}/v1/relay/send`,
      { toDid, messageId, conversationId: conversationId ?? null, fromDid: fromDid ?? null, sealed },
      token,
    )
  }

  async function inbox({ url, token, limit = 25 }) {
    const answer = await get(`${url}/v1/relay/inbox?limit=${limit}`, token)
    return Array.isArray(answer?.envelopes) ? answer.envelopes : []
  }

  async function ack({ url, token, messageIds }) {
    if (messageIds.length === 0) return { acknowledged: 0 }
    return post(`${url}/v1/relay/ack`, { messageIds }, token)
  }

  async function heartbeat({ url, token, agents }) {
    return post(`${url}/v1/relay/presence`, { agents }, token)
  }

  async function directory({ url, token, did }) {
    return get(`${url}/v1/relay/directory?did=${encodeURIComponent(did)}`, token)
  }

  /**
   * Collect and deliver everything waiting, then say who is here.
   *
   * `deliver` is given the unsealed request and is expected to run it to
   * completion. An envelope is acknowledged only after it does: acknowledging
   * first would lose a message whenever this process died mid-delivery, and
   * the cost of the opposite mistake — delivering twice — is already absorbed
   * by `markSeen` on the conversation.
   *
   * An envelope that will not open is acknowledged anyway. It is not going to
   * open on the next attempt either, and leaving it in place would wedge the
   * inbox behind it forever.
   */
  async function drain({ url, token, deliver }) {
    const envelopes = await inbox({ url, token })
    if (envelopes.length === 0) return { collected: 0, delivered: 0, refused: 0 }

    const done = []
    let delivered = 0
    let refused = 0

    for (const envelope of envelopes) {
      let opened
      try {
        opened = await open(envelope)
      } catch (err) {
        refused += 1
        done.push(envelope.id)
        logger.error(
          `iFlow relay: discarding envelope ${envelope.id} from ${envelope.from_did ?? 'an unnamed sender'} — ` +
            `${String(err && err.message ? err.message : err)}`,
        )
        continue
      }
      try {
        await deliver(opened, envelope)
        delivered += 1
        done.push(envelope.id)
      } catch (err) {
        // Left unacknowledged on purpose: this one is our fault, not the
        // sender's, and it should be tried again.
        logger.error(`iFlow relay: could not deliver ${envelope.id}`, err && err.message ? err.message : err)
      }
    }

    await ack({ url, token, messageIds: done })
    return { collected: envelopes.length, delivered, refused }
  }

  return { seal, open, send, inbox, ack, heartbeat, directory, drain }
}

/**
 * Poll the relay for messages, and announce this node while doing it.
 *
 * Same shape as `startCommunitySync`: one flight at a time, an interval that
 * does not hold the process open, and a disposer.
 */
export function startRelayPolling({ transport, settings, agents, deliver, intervalMs = 15_000, logger = console }) {
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      const current = settings()
      if (!current) return
      const { url, token } = current

      const roster = agents()
      if (roster.length > 0) {
        const result = await transport.heartbeat({ url, token, agents: roster })
        // A conflict means another node claimed this Agent's route. Messages
        // for it are going somewhere else, and the operator is the only one
        // who can do anything about it, so it is said loudly and every time
        // rather than once.
        for (const did of result?.conflicts ?? []) {
          logger.error(
            `iFlow relay: another node has claimed ${did}. Messages addressed to that Agent are being ` +
              'delivered elsewhere. If that is not a machine you control, treat the identity as compromised.',
          )
        }
      }

      const outcome = await transport.drain({ url, token, deliver })
      if (outcome.collected > 0) {
        logger.log(
          `iFlow relay: collected ${outcome.collected}, delivered ${outcome.delivered}` +
            (outcome.refused > 0 ? `, discarded ${outcome.refused}` : ''),
        )
      }
    } catch (err) {
      // The relay being unreachable is normal and must not be noisy: local
      // work carries on, and anything queued stays queued.
      logger.log(`iFlow relay: poll skipped (${String(err && err.message ? err.message : err)})`)
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}
