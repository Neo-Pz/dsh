/**
 * Which key signs, and what happens when none of them should.
 *
 * A node now holds several keys: its own, a Principal's, and one per declared
 * Agent. The rules that matter are not about routing — they are about refusal.
 * Signing an event with a key it was not attributed to is not a smaller
 * signature; it says a specific operator authorized something they never saw.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const { agentDidsOf, agentHome, authorityHome, homeForSigning, nodeHome } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'identity', 'keyring.ts')).href
)
const { createIflowIdSigner } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'identity', 'iflow-id.ts')).href
)

const WORKSPACE = '/ws'
const PRINCIPAL_STORE = '/profile/.iflowone'

const declarations = {
  principal: {
    principalId: 'iflow:principal:11111111-1111-4111-8111-111111111111',
    authorityDid: 'did:key:zPrincipal',
    authorityVersion: 1,
    label: 'Acme Ltd',
  },
  agents: [
    { agentId: 'writer', did: 'did:key:zWriter', capabilities: ['iflow.cap:task.run'] },
    { agentId: 'reviewer', did: 'did:key:zReviewer', capabilities: [] },
  ],
}

describe('choosing a key', () => {
  it('sends each declared identity to its own directory', () => {
    assert.equal(
      homeForSigning(join, WORKSPACE, declarations, { did: 'did:key:zWriter' }),
      agentHome(join, WORKSPACE, 'writer'),
    )
    assert.equal(
      homeForSigning(join, WORKSPACE, declarations, { did: 'did:key:zPrincipal' }, undefined, PRINCIPAL_STORE),
      authorityHome(join, PRINCIPAL_STORE, declarations.principal.principalId, 1),
    )
    assert.equal(
      homeForSigning(join, WORKSPACE, declarations, { agentId: 'reviewer' }),
      agentHome(join, WORKSPACE, 'reviewer'),
    )
  })

  it('has no answer for a DID this node does not hold', () => {
    // Undefined is the whole contract for a NAMED identity: a DID on the event
    // is a claim a verifier will check, so the caller must refuse rather than
    // sign it with a different key.
    assert.equal(homeForSigning(join, WORKSPACE, declarations, { did: 'did:key:zSomeoneElse' }), undefined)
  })

  it('signs its own facts with its own key', () => {
    // The node's own DID is an identity it holds, and the one a verifier checks
    // every unattributed fact against.
    assert.equal(
      homeForSigning(join, WORKSPACE, declarations, { did: 'did:key:zNode' }, 'did:key:zNode'),
      nodeHome(join, WORKSPACE),
    )
  })

  it('falls back to the node key when the issuer claims no DID', () => {
    // A session, a bare `user`, a peer label: these get no DID (see
    // `agentIssuer`), so a node-key signature attributes nothing to anyone. It
    // says "this node observed this", which is exactly true — and refusing here
    // is what would leave a runtime unable to sign its own observations.
    assert.equal(
      homeForSigning(join, WORKSPACE, declarations, { agentId: 'agent-session-42' }),
      nodeHome(join, WORKSPACE),
    )
    assert.equal(homeForSigning(join, WORKSPACE, declarations, {}), nodeHome(join, WORKSPACE))
    assert.equal(homeForSigning(join, WORKSPACE, declarations, undefined), nodeHome(join, WORKSPACE))
  })

  it('reports the declared agents by id, for the descriptor', () => {
    assert.deepEqual(agentDidsOf(declarations), {
      writer: 'did:key:zWriter',
      reviewer: 'did:key:zReviewer',
    })
  })
})

describe('signing as someone', () => {
  const writeScratch = async () => '/tmp/signable.bin'

  function recordingRun(calls) {
    return async (args, home) => {
      calls.push({ args, home })
      return JSON.stringify({ signature: 'AAAA', signerDid: 'did:key:zWhoever' })
    }
  }

  it('signs with the key the event is attributed to', async () => {
    const calls = []
    const signer = createIflowIdSigner({
      run: recordingRun(calls),
      writeScratch,
      resolveHome: (context) => homeForSigning(join, WORKSPACE, declarations, context),
    })

    await signer.sign(new Uint8Array([1]), { did: 'did:key:zWriter', agentId: 'writer' })

    assert.equal(calls[0].home, agentHome(join, WORKSPACE, 'writer'))
  })

  it('refuses rather than signing as somebody else', async () => {
    const calls = []
    const signer = createIflowIdSigner({
      run: recordingRun(calls),
      writeScratch,
      resolveHome: (context) => homeForSigning(join, WORKSPACE, declarations, context),
    })

    // The journal treats a signing failure as "record it unsigned". That is the
    // honest outcome: the fact happened, and this node cannot prove who did it.
    // Substituting a key it does hold would instead assert that an operator
    // authorized something they never saw.
    await assert.rejects(
      () => signer.sign(new Uint8Array([1]), { did: 'did:key:zStranger' }),
      /refusing to sign as another identity/,
    )
    assert.equal(calls.length, 0, 'it must not reach the binary at all')
  })

  it('uses the node\'s own key when nobody is named', async () => {
    const calls = []
    const signer = createIflowIdSigner({
      run: recordingRun(calls),
      writeScratch,
      resolveHome: (context) => homeForSigning(join, WORKSPACE, declarations, context),
    })

    // Every caller that predates declared Agents lands here, and must keep
    // working unchanged.
    await signer.sign(new Uint8Array([1]))

    assert.equal(calls[0].home, undefined)
  })
})
