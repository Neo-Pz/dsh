/**
 * Which key belongs to which peer, and what happens when that changes.
 *
 * Sealing a message needs the recipient's `did:key`. That makes the question
 * "where did this DID come from" the whole of the encryption story: whoever
 * can substitute the DID can read everything sent afterwards, and the
 * ciphertext will look perfect the entire time.
 *
 * # Trust on first use, and then never again
 *
 * The first DID seen for a peer is recorded. Every later sighting must match.
 * A mismatch is REFUSED and reported — never silently adopted, and never
 * resolved by preferring the newer value, which would make the pin decorative.
 *
 * This is deliberately the same rule SSH uses for host keys, for the same
 * reason: there is no authority to ask, so the honest thing is to remember
 * what was seen and make a change impossible to miss.
 *
 * # What this does and does not defend against
 *
 * It does not make first contact safe. If the very first sighting is a lie —
 * a relay serving its own DID instead of the peer's — the pin records the lie
 * and everything afterwards is consistent with it. What TOFU buys is that the
 * window is exactly one moment per peer, and that anyone who wants to attack
 * later has to break a pin, which is loud.
 *
 * Two ways to close that window, both supported: fetch the AgentCard over a
 * direct connection before ever using the relay, or pass the DID out of band
 * with `iflow_add_peer --did` after checking it with a human.
 */

/** A DID that could plausibly be a key rather than a typo. */
export function looksLikeDid(value) {
  return typeof value === 'string' && /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,}$/.test(value)
}

/** Raised when a peer presents a different key than the one on record. */
export class PinMismatchError extends Error {
  constructor(peerName, pinned, presented) {
    super(
      `${peerName} presented a different identity than the one pinned for it.\n` +
        `  pinned:    ${pinned}\n` +
        `  presented: ${presented}\n` +
        'Refusing to send. A message sealed to the new key would be readable by whoever holds it.\n' +
        'If this peer legitimately rotated its key, remove it with iflow_remove_peer and add it ' +
        'again with the new did — after checking that did with a person, not over the same channel ' +
        'that just presented it.',
    )
    this.name = 'PinMismatchError'
    this.peerName = peerName
    this.pinned = pinned
    this.presented = presented
  }
}

/**
 * Reconcile a sighting with what is on record.
 *
 * Returns the DID to use and what happened, so a caller can log a first
 * pinning without inventing the wording. Throws {@link PinMismatchError} when
 * the peer's key changed.
 *
 *   pinned    already on record and matching
 *   recorded  nothing was on record; this sighting becomes the pin
 *   unknown   nothing on record and nothing presented
 */
export function reconcileDid(peerName, pinned, presented) {
  const known = looksLikeDid(pinned) ? pinned : null
  const seen = looksLikeDid(presented) ? presented : null

  if (known && seen && known !== seen) throw new PinMismatchError(peerName, known, seen)
  if (known) return { did: known, outcome: 'pinned' }
  if (seen) return { did: seen, outcome: 'recorded' }
  return { did: null, outcome: 'unknown' }
}

/**
 * A short, comparable form of a DID, for a person checking it out of band.
 *
 * Reading 48 base58 characters down a phone line is how key verification stops
 * happening. The head and tail are what actually differ between two keys, so
 * that is what is shown.
 */
export function didFingerprint(did) {
  if (!looksLikeDid(did)) return 'not a did:key'
  const body = did.slice('did:key:'.length)
  return `${body.slice(0, 8)}…${body.slice(-8)}`
}
