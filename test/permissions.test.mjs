/**
 * Standing permission for a pair of Agents to keep talking.
 *
 * The acceptance gate exists to stop a stranger spending a model here. Once a
 * person has allowed a peer, asking again on every reconnect is the same
 * question asked until people stop reading it. These check that the permission
 * is durable, keyed on what was proved rather than what was claimed, and
 * narrow — messages, and nothing else.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const perms = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'conversation', 'permissions.ts')).href
)
const {
  allowPair,
  allowedPairs,
  emptyPermissions,
  forgetPair,
  loadPermissions,
  messagingPermission,
  pairMessagingState,
  permissionsPath,
  revokePair,
} = perms

const store = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'conversation', 'store.ts')).href
)
const { trustDecision, DEFAULT_TRUST } = store

const WORKSPACE = '/ws'
const LOCAL = 'did:key:zLocalAgent'
const PEER = 'did:key:zPeerAgent'

function fakeFs(files = {}) {
  return {
    fs: {
      async resolve(path) { return path },
      async readText(path) {
        if (!(path in files)) throw new Error(`ENOENT ${path}`)
        return files[path]
      },
      async writeText(path, text) { files[path] = text },
    },
  }
}

const granted = () => {
  const permissions = emptyPermissions()
  allowPair(permissions, { localAgentDid: LOCAL, peerAgentDid: PEER, peerLabel: 'wwee' })
  return permissions
}

describe('where a granted permission lives', () => {
  it('is its own file, not the operator’s hand-written posture', () => {
    // `trust.json` is edited by a person and the panel says so. What piles up
    // by clicking is a different kind of thing, listed and revoked one at a time.
    const path = permissionsPath(join, WORKSPACE)
    assert.ok(path.includes('.iflow'))
    assert.ok(!path.includes('trust'))
    assert.ok(!path.includes('edge'), 'permissions must not sit in the sync surface')
  })
})

describe('allowing a pair', () => {
  it('answers for that pair and no other', () => {
    const permissions = granted()
    assert.equal(messagingPermission(permissions, LOCAL, PEER), 'allowed')
    assert.equal(messagingPermission(permissions, LOCAL, 'did:key:zSomeoneElse'), null)
    assert.equal(messagingPermission(permissions, 'did:key:zOtherLocal', PEER), null)
  })

  it('is directional', () => {
    // A grant is about one side allowing another. Reversing it is a different
    // decision that the other machine makes for itself.
    assert.equal(messagingPermission(granted(), PEER, LOCAL), null)
  })

  it('refuses to be keyed on nothing', () => {
    // An unsigned peer has no durable identity. Granting to a missing DID would
    // create a permission that the next caller inherits by default.
    const permissions = emptyPermissions()
    assert.equal(allowPair(permissions, { localAgentDid: LOCAL, peerAgentDid: null }), null)
    assert.equal(allowPair(permissions, { localAgentDid: null, peerAgentDid: PEER }), null)
    assert.deepEqual(permissions.pairs, {})
  })

  it('says nothing about a pair nobody decided on', () => {
    // `null` is not a refusal: the caller falls through to the ordinary policy,
    // and a stranger still stops at the gate.
    assert.equal(messagingPermission(emptyPermissions(), LOCAL, PEER), null)
  })
})

describe('revoking', () => {
  it('stops the permission', () => {
    const permissions = granted()
    assert.ok(revokePair(permissions, LOCAL, PEER))
    assert.equal(messagingPermission(permissions, LOCAL, PEER), null)
    assert.equal(pairMessagingState(permissions, LOCAL, PEER), 'revoked')
  })

  it('keeps the record rather than deleting it', () => {
    // "Did I ever allow this" deserves an answer, and a removed row answers the
    // same as one that never existed.
    const permissions = granted()
    revokePair(permissions, LOCAL, PEER)
    const pair = Object.values(permissions.pairs)[0]
    assert.ok(pair.revokedAt)
    assert.equal(pair.grantedAt !== null, true)
  })

  it('is idempotent', () => {
    const permissions = granted()
    revokePair(permissions, LOCAL, PEER)
    assert.equal(revokePair(permissions, LOCAL, PEER), null)
  })

  it('leaves it out of what the panel shows as allowed', () => {
    const permissions = granted()
    assert.equal(allowedPairs(permissions).length, 1)
    revokePair(permissions, LOCAL, PEER)
    assert.deepEqual(allowedPairs(permissions), [])
  })

  it('can erase exactly one pair for a scoped first-contact test', () => {
    const permissions = granted()
    const other = 'did:key:zOtherAgent'
    allowPair(permissions, { localAgentDid: LOCAL, peerAgentDid: other, peerLabel: 'other' })
    assert.ok(forgetPair(permissions, LOCAL, PEER))
    assert.equal(pairMessagingState(permissions, LOCAL, PEER), null)
    assert.equal(pairMessagingState(permissions, LOCAL, other), 'allowed')
  })
})

describe('what the permission does to the gate', () => {
  it('lets an allowed pair through without asking', () => {
    assert.equal(
      trustDecision(DEFAULT_TRUST, { peerLabel: 'wwee', signerDid: PEER, pairMessaging: 'allowed' }),
      'accept',
    )
  })

  it('still asks when nothing was granted', () => {
    assert.equal(trustDecision(DEFAULT_TRUST, { peerLabel: 'wwee', signerDid: PEER }), 'ask')
  })

  it('cannot be used to walk around a block', () => {
    // A block is absolute and checked first. Otherwise blocking someone could be
    // undone by an older grant they still hold.
    const trust = { default: 'ask', peers: {}, blocked: [PEER] }
    assert.equal(trustDecision(trust, { signerDid: PEER, pairMessaging: 'allowed' }), 'reject')
  })

  it('cannot reopen a thread that was rejected', () => {
    const rejected = { state: 'rejected' }
    assert.equal(
      trustDecision(DEFAULT_TRUST, { signerDid: PEER, conversation: rejected, pairMessaging: 'allowed' }),
      'reject',
    )
  })

  it('makes an active conversation ask again after a local revocation', () => {
    const active = { state: 'active' }
    assert.equal(
      trustDecision(DEFAULT_TRUST, { signerDid: PEER, conversation: active, pairMessaging: 'revoked' }),
      'ask',
    )
  })
})

describe('surviving a restart', () => {
  it('reads back what was granted', async () => {
    const permissions = granted()
    const ctx = fakeFs({ [permissionsPath(join, WORKSPACE)]: JSON.stringify(permissions) })
    const loaded = await loadPermissions(ctx, join, WORKSPACE)
    assert.equal(messagingPermission(loaded, LOCAL, PEER), 'allowed')
  })

  it('reads a corrupt file as empty rather than as permissive', async () => {
    // Failing open here would mean an unreadable file silently admits everyone.
    const ctx = fakeFs({ [permissionsPath(join, WORKSPACE)]: '{ not json' })
    const loaded = await loadPermissions(ctx, join, WORKSPACE)
    assert.deepEqual(loaded.pairs, {})
    assert.equal(messagingPermission(loaded, LOCAL, PEER), null)
  })

  it('drops an entry that names no DIDs', async () => {
    const ctx = fakeFs({
      [permissionsPath(join, WORKSPACE)]: JSON.stringify({
        pairs: { bogus: { messaging: 'allowed', peerLabel: 'wwee' } },
      }),
    })
    assert.deepEqual((await loadPermissions(ctx, join, WORKSPACE)).pairs, {})
  })

  it('drops an entry whose permission is not one of the two', async () => {
    const ctx = fakeFs({
      [permissionsPath(join, WORKSPACE)]: JSON.stringify({
        pairs: { k: { localAgentDid: LOCAL, peerAgentDid: PEER, messaging: 'everything' } },
      }),
    })
    assert.deepEqual((await loadPermissions(ctx, join, WORKSPACE)).pairs, {})
  })

  it('reads the legacy blocked plus revokedAt representation as revoked', async () => {
    const ctx = fakeFs({
      [permissionsPath(join, WORKSPACE)]: JSON.stringify({
        pairs: {
          old: {
            localAgentDid: LOCAL, peerAgentDid: PEER, messaging: 'blocked',
            revokedAt: '2026-08-30T00:00:00.000Z', grantedBy: 'human',
          },
        },
      }),
    })
    const loaded = await loadPermissions(ctx, join, WORKSPACE)
    assert.equal(pairMessagingState(loaded, LOCAL, PEER), 'revoked')
  })
})
