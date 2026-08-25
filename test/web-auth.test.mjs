import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

import { canonicalJson } from 'iflow-protocol'

const { normalizeWebLoginCode, ownedAgentBindings, webChallengeSigningPayload } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'web', 'auth.ts')).href
)

describe('Node-confirmed Web login payload', () => {
  it('normalizes only the unambiguous short-code alphabet', () => {
    assert.equal(normalizeWebLoginCode(' abcd-2345 '), 'ABCD-2345')
    assert.equal(normalizeWebLoginCode('ABCI-2345'), undefined)
    assert.equal(normalizeWebLoginCode('too-short'), undefined)
  })

  it('exposes only Agents owned by the current stable Principal as send_as bindings', () => {
    const bindings = ownedAgentBindings({
      agents: [
        { agentId: 'zeta', did: 'did:key:zZeta', label: 'Zeta', principalId: 'iflow:principal:mine', grantRef: 'g-z' },
        { agentId: 'alpha', did: 'did:key:zAlpha', principalId: 'iflow:principal:mine', grantRef: 'g-a' },
        { agentId: 'other', did: 'did:key:zOther', principalId: 'iflow:principal:other' },
      ],
    }, 'iflow:principal:mine')
    assert.deepEqual(bindings.map((binding) => binding.agentId), ['alpha', 'zeta'])
    assert.ok(bindings.every((binding) => binding.relationship === 'owned' && binding.right === 'send_as'))
    assert.ok(bindings.every((binding) => canonicalJson(binding).includes('"scope":["message"]')))
  })

  it('binds browser, Origin, scope, view key, Principal, Node and Agent grants into one signed object', () => {
    const principal = {
      principalId: 'iflow:principal:mine',
      authorityDid: 'did:key:zAuthority',
      authorityVersion: 2,
    }
    const challenge = {
      challengeId: 'ich_1',
      browserSessionNonce: 'browser-nonce-1234',
      origin: 'https://agent.iflowone.com',
      issuedAt: '2026-08-25T12:00:00.000Z',
      expiresAt: '2026-08-25T12:05:00.000Z',
      requestedScope: ['intent:create', 'me:agents', 'view:read'],
      viewKeyId: 'sha256-view-key',
    }
    const agentBindings = [{
      agentId: 'alpha',
      agentDid: 'did:key:zAlpha',
      relationship: 'owned',
      right: 'send_as',
      scope: ['message'],
    }]
    const payload = webChallengeSigningPayload({ challenge, nodeId: 'node-a', principal, agentBindings })
    assert.deepEqual(payload, {
      version: 1,
      kind: 'iflow.web-auth.challenge',
      challengeId: 'ich_1',
      browserSessionNonce: 'browser-nonce-1234',
      origin: 'https://agent.iflowone.com',
      issuedAt: '2026-08-25T12:00:00.000Z',
      expiresAt: '2026-08-25T12:05:00.000Z',
      principalId: 'iflow:principal:mine',
      authorityDid: 'did:key:zAuthority',
      authorityVersion: 2,
      requestedScope: ['intent:create', 'me:agents', 'view:read'],
      viewPublicKeyDigest: 'sha256-view-key',
      nodeId: 'node-a',
      agentBindings,
    })
  })
})
