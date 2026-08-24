/**
 * What travels through the relay, and what binds it in place.
 *
 * The relay carries a sealed blob. This file decides what goes inside it and
 * what the seal is tied to — both pure, both needing to be byte-identical on
 * the two machines, which is exactly the kind of thing that should be testable
 * without a network.
 *
 * # What goes inside
 *
 * The complete, already-signed A2A request: the JSON-RPC body plus the
 * `X-IFlow-Signature` envelope that would have travelled as a header.
 *
 * That is the whole reason the relay does not weaken anything. The recipient
 * unseals it and runs the SAME verification it runs on a direct connection —
 * the signature check, the body digest, the grant evaluation. There is no
 * relay-specific trust path, because there is no relay-specific message: it is
 * the HTTP request, in an envelope.
 *
 * A relay-specific verification path would be a way around P1 and P2, and it
 * would be reached by anyone who could reach the relay.
 */

/**
 * The bytes a sealed message is bound to.
 *
 * Passed as AEAD additional data, so decryption fails if any of it changed.
 * The relay cannot read a message; without this it could still take one and
 * redeliver it as a different message, in a different conversation, to a
 * different recipient. Being unable to read the mail is not the same as being
 * unable to reroute it.
 *
 * Order and separator are part of the wire format: both sides compute this
 * string independently and a mismatch is indistinguishable from tampering.
 */
export function envelopeAad({ conversationId, messageId, fromDid, toDid } = {}) {
  return [conversationId ?? '', messageId ?? '', fromDid ?? '', toDid ?? ''].join('|')
}

/**
 * Wrap a signed request for sealing.
 *
 * `signature` is the parsed `X-IFlow-Signature` envelope, or null when this
 * node has no key material — an unsigned message over the relay is degraded
 * in exactly the way an unsigned direct request is, and it is the recipient's
 * trust policy that decides what to do about it, not this function.
 */
export function packRelayPayload(body, signature) {
  return JSON.stringify({ v: 1, body, signature: signature ?? null })
}

/**
 * Unwrap what was sealed, refusing anything that is not the shape we sealed.
 *
 * Throws rather than returning a partial result: a payload that opened but
 * does not contain a request is not a message to be handled leniently, it is
 * a sign that something is wrong on the other side.
 */
export function unpackRelayPayload(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error('relay payload is not JSON; the sender packed something unexpected')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('relay payload is not an object')
  if (parsed.v !== 1) throw new Error(`unsupported relay payload version ${String(parsed.v)}; this node speaks 1`)
  if (typeof parsed.body !== 'string' || parsed.body.length === 0) {
    throw new Error('relay payload carries no request body')
  }
  return {
    body: parsed.body,
    signature: parsed.signature && typeof parsed.signature === 'object' ? parsed.signature : null,
  }
}

/**
 * Should this message go through the relay?
 *
 * Direct is always preferred: it is faster, it involves nobody else, and it
 * leaks no metadata to a third party. The relay is the answer to "the peer is
 * not reachable from here", which is the normal case for two machines behind
 * different NATs and the whole reason it exists.
 *
 * Returns a reason rather than a boolean so a caller can tell an operator why
 * their message went the long way round — or why it could not.
 */
export function relayDecision({ peer, directError, relayConfigured } = {}) {
  if (!directError) return { use: false, reason: 'direct delivery worked' }
  if (!relayConfigured) {
    return { use: false, reason: 'this node is not connected to a relay, so an unreachable peer stays unreachable' }
  }
  if (!peer || !peer.did) {
    return {
      use: false,
      reason:
        'no identity is pinned for this peer, so a message cannot be sealed for it. ' +
        'Run iflow_discover while it is reachable, or pass its did to iflow_add_peer.',
    }
  }
  return { use: true, reason: `direct delivery failed (${directError}); sending sealed via the relay` }
}
