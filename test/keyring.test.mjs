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

const { agentDidsOf, agentHome, homeForSigning, principalHome } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'identity', 'keyring.ts')).href
)
const { createIflowIdSigner } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'identity', 'iflow-id.ts')).href
)

const WORKSPACE = '/ws'

const declarations = {
  principal: { did: 'did:key:zPrincipal', label: 'Acme Ltd' },
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
      homeForSigning(join, WORKSPACE, declarations, { did: 'did:key:zPrincipal' }),
      principalHome(join, WORKSPACE),
    )
    assert.equal(
      homeForSigning(join, WORKSPACE, declarations, { agentId: 'reviewer' }),
      agentHome(join, WORKSPACE, 'reviewer'),
    )
  })

  it('has no answer for an identity this node does not hold', () => {
    // Undefined is the whole contract: the caller must refuse, not fall back.
    assert.equal(homeForSigning(join, WORKSPACE, declarations, { did: 'did:key:zSomeoneElse' }), undefined)
    assert.equal(homeForSigning(join, WORKSPACE, declarations, { agentId: 'agent-session-42' }), undefined)
    assert.equal(homeForSigning(join, WORKSPACE, declarations, {}), undefined)
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
