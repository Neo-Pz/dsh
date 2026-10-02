import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
const { createDiscoveryRuntime } = await import(process.env.IFLOW_TEST_DISCOVERY_RUNTIME ? pathToFileURL(process.env.IFLOW_TEST_DISCOVERY_RUNTIME).href : '../src/discovery/runtime.ts')
const { parseConversationIntent, LocalIntentQueue } = await import(process.env.IFLOW_TEST_INTENT_PARSER ? pathToFileURL(process.env.IFLOW_TEST_INTENT_PARSER).href : '../src/web/local-intents.ts')

const agent = { agentId: 'reviewer', did: 'did:key:test-agent', label: 'Reviewer', capabilities: ['iflow.cap:review'] }
const args = { action: 'publish', fromAgentId: agent.agentId, description: 'Review TypeScript code', representativeQueries: ['Review TypeScript code', 'Explain TypeScript errors'], tags: ['code'], confirmPublic: true }
function runtime(overrides = {}) {
  const calls = []
  const service = createDiscoveryRuntime({ selectedAgent: async (id) => { if (id !== agent.agentId) throw new Error('unknown Agent'); return agent }, publicationContext: async () => ({ enabled: true, nodeId: 'node-a', version: '1.0', runtimeKind: 'dsh', agentInterface: { url: 'https://agent.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' } }), record: async (event) => { calls.push(event); return { ...event, id: 'event-a', evidence: { signature: 'fixture-signature' } } }, requestSearch: async () => ({ registry: 'https://registry.example/v1/ard', response: { results: [] } }), ...overrides })
  return { service, calls }
}
describe('ARD adapter boundary', () => {
  it('requires explicit publication and a public route, never publishes another Agent', async () => {
    const { service, calls } = runtime()
    await assert.rejects(service.publish({ ...args, confirmPublic: false }), /Confirm/)
    await assert.rejects(service.publish({ ...args, fromAgentId: 'other' }), /unknown Agent/)
    const privateRoute = runtime({ publicationContext: async () => ({ enabled: true, nodeId: 'node-a', version: '1.0', runtimeKind: 'dsh', agentInterface: { url: 'https://192.168.1.6/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' } }) })
    await assert.rejects(privateRoute.service.publish(args), /public HTTPS/)
    const credentials = runtime({ publicationContext: async () => ({ enabled: true, nodeId: 'node-a', version: '1.0', runtimeKind: 'dsh', agentInterface: { url: 'https://user:password@agent.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' } }) })
    await assert.rejects(credentials.service.publish(args), /public HTTPS/)
    const disabled = runtime({ publicationContext: async () => ({ enabled: false }) })
    await assert.rejects(disabled.service.publish(args), /Enable Community/)
    assert.equal(calls.length, 0)
  })
  it('publishes a selected Agent card in a signed public registration and supports withdrawal', async () => {
    const { service, calls } = runtime()
    assert.equal((await service.publish(args)).state, 'publication_queued')
    assert.equal(calls[0].issuer.did, agent.did)
    assert.deepEqual(calls[0].payload.discovery.card.identity, { did: agent.did, agentId: agent.agentId })
    assert.equal(calls[0].visibility, 'public')
    assert.equal((await service.publish({ ...args, action: 'withdraw' })).state, 'withdrawal_queued')
    assert.equal(calls[1].payload.discovery, null)
    await assert.rejects(runtime({ record: async () => ({ evidence: {} }) }).service.publish(args), /could not be signed/)
  })
  it('searches only as an available Agent and rejects malformed registry responses', async () => {
    const { service, calls } = runtime()
    const request = { query: { text: 'TypeScript' } }
    assert.equal((await service.search(agent.agentId, request)).ownAgentId, agent.agentId)
    await assert.rejects(service.search('other', request), /unknown Agent/)
    await assert.rejects(runtime({ requestSearch: async () => ({ response: { results: [{}] } }) }).service.search(agent.agentId, request), /invalid ARD/)
    assert.equal(calls.length, 0)
  })
  it('parses sealed-search vocabulary without allowing endpoint or tool injection', () => {
    assert.equal(parseConversationIntent(JSON.stringify({ version: 1, kind: 'discovery.search', request: { query: { text: 'TypeScript' } } })).kind, 'discovery.search')
    assert.throws(() => parseConversationIntent(JSON.stringify({ version: 1, kind: 'discovery.search', endpoint: 'https://other', request: { query: { text: 'x' } } })), /outside/)
    assert.throws(() => parseConversationIntent(JSON.stringify({ version: 1, kind: 'discovery.search', request: { query: { text: 'x' }, pageSize: 101 } })), /pageSize/)
  })
  it('uses the durable encrypted Intent queue and seals results without recording query plaintext', async () => {
    let saved; const views = []; const query = 'private test search terms'
    const plaintext = JSON.stringify({ version: 1, kind: 'discovery.search', request: { query: { text: query } } })
    const queue = new LocalIntentQueue({ store: { read: async () => saved, write: async (value) => { saved = structuredClone(value) } }, crypto: { open: async () => plaintext, keyId: async () => 'key', seal: async (_did, text) => { views.push(JSON.parse(text)); return 'sealed-result' } }, executeIntent: async ({ intent, ownAgentId }) => { assert.equal(intent.request.query.text, query); return { ok: true, views: [{ version: 1, kind: 'discovery.results', ownAgentId, registry: 'https://registry.example/v1/ard', matching: 'keyword', response: { results: [] } }] } }, postView: async (view) => { assert.equal(view.sealed, 'sealed-result') }, logger: {} })
    const now = new Date(); const routing = { intentId: 'intent-a', principalId: 'owner', toAgentId: agent.agentId, toAgentAuthorityDid: agent.did, browserSessionId: 'browser', viewPublicKey: 'did:key:browser', issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString() }
    await queue.accept([{ version: 1, kind: 'human.intent', routing, sealed: 'opaque-query' }]); await queue.process()
    assert.equal(saved.intents[0].state, 'completed')
    assert.equal(JSON.stringify(saved).includes(query), false)
    assert.equal(views[0].kind, 'discovery.results')
  })
})
