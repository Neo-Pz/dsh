import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { hasPublishableAgentRegistration } from '../src/edge/public-registration.ts'

const AGENT = {
  agentId: 'shawn',
  did: 'did:key:z6MkuDgUgUcGRs5qqgp5E9nvbJ1UhdLAYeXTcU2VZFWeYktN',
}

function registration(overrides = {}) {
  return {
    type: 'agent.registered',
    subject: { kind: 'agent', id: AGENT.agentId },
    visibility: 'public',
    issuer: { kind: 'agent', id: AGENT.agentId, did: AGENT.did },
    payload: { did: AGENT.did },
    evidence: { source: 'dsh', signature: 'signed-at-origin' },
    ...overrides,
  }
}

describe('public Agent registration recovery', () => {
  it('does not let an unsigned bootstrap fact suppress a retry after identity recovery', () => {
    const unsigned = registration({ evidence: { source: 'dsh' } })
    assert.equal(hasPublishableAgentRegistration([unsigned], AGENT), false)
  })

  it('does not reuse a registration signed by a Node or another Agent', () => {
    const wrongIssuer = registration({
      issuer: { kind: 'agent', id: 'node-desktop', did: 'did:key:zNode' },
    })
    assert.equal(hasPublishableAgentRegistration([wrongIssuer], AGENT), false)
  })

  it('reuses the matching Agent-signed public registration', () => {
    assert.equal(hasPublishableAgentRegistration([registration()], AGENT), true)
  })
})
