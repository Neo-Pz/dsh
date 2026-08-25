/**
 * Which key belongs to which peer.
 *
 * Sealing needs the recipient's did:key, which makes "where did this DID come
 * from" the whole of the encryption story. Substitute the DID and the
 * ciphertext still looks perfect while somebody else reads it.
 *
 * These assertions are about the one rule that stands between those two
 * outcomes: the first key seen for a peer is remembered, and a later
 * disagreement is refused rather than resolved.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const { PinMismatchError, didFingerprint, looksLikeDid, reconcileDid } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'identity', 'pinning.ts')).href
)

const A = 'did:key:z6MkeuovG6myvH7ukUK1QBKXLgQaDFPtB5TF6crZsRaKZWg3'
const B = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'

describe('recognising a did:key', () => {
  it('accepts a real one', () => {
    assert.equal(looksLikeDid(A), true)
  })

  it('rejects the shapes a typo actually takes', () => {
    for (const value of [
      '',
      undefined,
      null,
      42,
      'z6Mkeuov',
      'did:key:6MkeuovG6myvH7ukUK1QBKXLgQaDFPtB5TF6crZsRaKZWg3', // no multibase z
      'did:web:example.com',
      'did:key:z6Mk', // too short to be a key
      `did:key:z6Mk0OIl${'x'.repeat(40)}`, // 0, O, I, l are not in base58
    ]) {
      assert.equal(looksLikeDid(value), false, `accepted ${JSON.stringify(value)}`)
    }
  })
})

describe('trust on first use', () => {
  it('records the first key seen', () => {
    assert.deepEqual(reconcileDid('peer', null, A), { did: A, outcome: 'recorded' })
  })

  it('keeps the pinned key when the peer presents the same one', () => {
    assert.deepEqual(reconcileDid('peer', A, A), { did: A, outcome: 'pinned' })
  })

  it('keeps the pinned key when the peer presents nothing at all', () => {
    // Absence must not un-pin: a peer that stops publishing its DID has not
    // proved it holds a different one.
    assert.deepEqual(reconcileDid('peer', A, null), { did: A, outcome: 'pinned' })
  })

  it('answers unknown when nobody has ever seen a key', () => {
    assert.deepEqual(reconcileDid('peer', null, null), { did: null, outcome: 'unknown' })
  })

  it('ignores a pinned value that is not a did at all', () => {
    // A corrupted peers.json must not become an unopenable lock.
    assert.deepEqual(reconcileDid('peer', 'garbage', A), { did: A, outcome: 'recorded' })
  })

  it('does not pin something that is not a did', () => {
    assert.deepEqual(reconcileDid('peer', null, 'garbage'), { did: null, outcome: 'unknown' })
  })
})

describe('when a peer presents a different key', () => {
  it('refuses, rather than preferring either one', () => {
    assert.throws(() => reconcileDid('if-lt-b', A, B), PinMismatchError)
  })

  it('says what was pinned, what arrived, and why it matters', () => {
    let error
    try {
      reconcileDid('if-lt-b', A, B)
    } catch (thrown) {
      error = thrown
    }
    assert.ok(error, 'expected a refusal')
    assert.match(error.message, /if-lt-b/)
    assert.ok(error.message.includes(A), 'the pinned key should be shown')
    assert.ok(error.message.includes(B), 'the presented key should be shown')
    // The consequence, not just the fact: someone reading this has to be able
    // to tell that continuing would hand their messages to whoever did this.
    assert.match(error.message, /readable by whoever holds it/)
    // And a way out that does not involve trusting the same channel again.
    assert.match(error.message, /iflow_remove_peer/)
    assert.match(error.message, /not over the same channel/)
  })

  it('carries the two keys as fields, so a caller can show them its own way', () => {
    const error = new PinMismatchError('p', A, B)
    assert.equal(error.peerName, 'p')
    assert.equal(error.pinned, A)
    assert.equal(error.presented, B)
    assert.equal(error.name, 'PinMismatchError')
  })
})

describe('fingerprints, for checking a key with a person', () => {
  it('is short enough to read aloud', () => {
    const print = didFingerprint(A)
    assert.ok(print.length < 24, `too long to read out: ${print}`)
  })

  it('shows the parts that actually differ between two keys', () => {
    assert.notEqual(didFingerprint(A), didFingerprint(B))
  })

  it('is stable', () => {
    assert.equal(didFingerprint(A), didFingerprint(A))
  })

  it('says so plainly when handed something that is not a did', () => {
    assert.equal(didFingerprint('nonsense'), 'not a did:key')
  })
})
