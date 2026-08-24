/**
 * A message, all the way through the relay and back out.
 *
 * The two halves were built separately — the Worker in another repository —
 * so the thing most likely to be wrong is the join: whether what one side
 * seals is what the other side can open, byte for byte, with the same
 * additional data computed independently on both machines.
 *
 * This runs the REAL identity binary for sealing and opening, and a stand-in
 * relay that behaves the way the Worker's SQL does: opaque storage, per-node
 * inbox, `INSERT OR IGNORE` on message id. If the crypto and the framing
 * agree here, the only thing left between two machines is HTTP.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const IFLOW_ID = join(
  import.meta.dirname,
  '..',
  'rust',
  'target',
  'release',
  process.platform === 'win32' ? 'iflow-id.exe' : 'iflow-id',
)
const hasBinary = existsSync(IFLOW_ID)

const { createRelayTransport } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'relay', 'transport.ts')).href
)
const { envelopeAad, packRelayPayload, relayDecision, unpackRelayPayload } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'relay', 'envelope.ts')).href
)

/** A relay that behaves like the Worker's SQL, without the Worker. */
function fakeRelay() {
  const envelopes = new Map()
  const routes = new Map()
  return {
    envelopes,
    routes,
    async post(url, payload) {
      if (url.endsWith('/v1/relay/send')) {
        // INSERT OR IGNORE on message id.
        if (!envelopes.has(payload.messageId)) {
          const toNode = routes.get(payload.toDid)
          if (!toNode) return { state: 'unreachable' }
          envelopes.set(payload.messageId, {
            id: payload.messageId,
            to_node_id: toNode,
            to_did: payload.toDid,
            from_did: payload.fromDid,
            conversation_id: payload.conversationId,
            sealed: payload.sealed,
            delivered_at: null,
          })
        }
        return { state: 'queued', messageId: payload.messageId }
      }
      if (url.endsWith('/v1/relay/ack')) {
        let acknowledged = 0
        for (const id of payload.messageIds) {
          const row = envelopes.get(id)
          if (row && !row.delivered_at) {
            row.delivered_at = new Date().toISOString()
            row.sealed = ''
            acknowledged += 1
          }
        }
        return { acknowledged }
      }
      if (url.endsWith('/v1/relay/presence')) {
        const conflicts = []
        for (const agent of payload.agents) {
          const held = routes.get(agent.did)
          if (held && held !== 'node-self') conflicts.push(agent.did)
          else routes.set(agent.did, 'node-self')
        }
        return { claimed: payload.agents.map((a) => a.did), conflicts }
      }
      return {}
    },
    async get(url) {
      if (url.includes('/v1/relay/inbox')) {
        return {
          envelopes: [...envelopes.values()].filter((e) => e.to_node_id === 'node-b' && !e.delivered_at),
        }
      }
      return {}
    },
  }
}

function transportFor(home, relay) {
  return createRelayTransport({
    iflowId: async (args) => {
      const result = spawnSync(IFLOW_ID, ['--home', home, ...args], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr || result.stdout)
      return result.stdout.trim()
    },
    scratchPath: (name) => join(home, name),
    async readBytes(path) {
      return readFileSync(path)
    },
    async writeBytes(path, bytes) {
      writeFileSync(path, bytes)
    },
    post: relay.post,
    get: relay.get,
    logger: { log() {}, error() {} },
  })
}

describe('the additional data both sides compute', () => {
  it('is the same string from the same facts', () => {
    const fields = { conversationId: 'conv-1', messageId: 'msg-1', fromDid: 'did:key:zA', toDid: 'did:key:zB' }
    assert.equal(envelopeAad(fields), envelopeAad({ ...fields }))
  })

  it('changes when any single field changes', () => {
    const base = { conversationId: 'conv-1', messageId: 'msg-1', fromDid: 'did:key:zA', toDid: 'did:key:zB' }
    const seen = new Set([envelopeAad(base)])
    for (const key of Object.keys(base)) {
      seen.add(envelopeAad({ ...base, [key]: 'different' }))
    }
    assert.equal(seen.size, 5, 'two different envelopes produced the same binding')
  })

  it('does not let one field bleed into the next', () => {
    // Without a separator, {a:'x', b:'yz'} and {a:'xy', b:'z'} would bind the
    // same, and a relay could move a message between them.
    assert.notEqual(
      envelopeAad({ conversationId: 'a', messageId: 'bc' }),
      envelopeAad({ conversationId: 'ab', messageId: 'c' }),
    )
  })

  it('is defined for a message that has no conversation yet', () => {
    assert.equal(typeof envelopeAad({}), 'string')
  })
})

describe('the payload wrapper', () => {
  it('round-trips a signed request', () => {
    const signature = { signature: 'sig', signer: 'did:key:zA', body_sha256: 'abc' }
    assert.deepEqual(unpackRelayPayload(packRelayPayload('{"jsonrpc":"2.0"}', signature)), {
      body: '{"jsonrpc":"2.0"}',
      signature,
    })
  })

  it('round-trips an unsigned one', () => {
    assert.deepEqual(unpackRelayPayload(packRelayPayload('{}', null)), { body: '{}', signature: null })
  })

  it('refuses a version it does not speak', () => {
    assert.throws(() => unpackRelayPayload(JSON.stringify({ v: 9, body: '{}' })), /version 9/)
  })

  it('refuses a payload with no request in it', () => {
    for (const bad of ['not json', '{}', JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, body: '' })]) {
      assert.throws(() => unpackRelayPayload(bad))
    }
  })
})

describe('when to use the relay at all', () => {
  const peer = { did: 'did:key:zB' }

  it('does not, when the direct connection worked', () => {
    assert.equal(relayDecision({ peer, directError: null, relayConfigured: true }).use, false)
  })

  it('does, when it did not', () => {
    assert.equal(relayDecision({ peer, directError: 'connection refused', relayConfigured: true }).use, true)
  })

  it('cannot, without a pinned identity — and says why', () => {
    const decision = relayDecision({ peer: { did: null }, directError: 'refused', relayConfigured: true })
    assert.equal(decision.use, false)
    assert.match(decision.reason, /iflow_discover/)
  })

  it('cannot, without a relay — and says that instead', () => {
    const decision = relayDecision({ peer, directError: 'refused', relayConfigured: false })
    assert.equal(decision.use, false)
    assert.match(decision.reason, /not connected to a relay/)
  })
})

describe('a message through the relay', { skip: !hasBinary }, () => {
  let alice
  let bob
  let mallory
  let bobDid
  let aliceDid
  let relay

  const REQUEST = JSON.stringify({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'SendMessage',
    params: { message: { messageId: 'msg-1', parts: [{ text: 'can you analyse this CSV?' }] } },
  })
  const SIGNATURE = { signature: 'sig-bytes', signer: 'did:key:zAlice', body_sha256: 'digest' }

  before(() => {
    alice = mkdtempSync(join(tmpdir(), 'iflow-relay-a-'))
    bob = mkdtempSync(join(tmpdir(), 'iflow-relay-b-'))
    mallory = mkdtempSync(join(tmpdir(), 'iflow-relay-m-'))
    for (const [home, label] of [[alice, 'alice'], [bob, 'bob'], [mallory, 'mallory']]) {
      const created = spawnSync(IFLOW_ID, ['--home', home, 'create', label], { encoding: 'utf8' })
      assert.equal(created.status, 0, `create ${label}: ${created.stderr}`)
    }
    bobDid = JSON.parse(spawnSync(IFLOW_ID, ['--home', bob, 'show', '--json'], { encoding: 'utf8' }).stdout).did
    aliceDid = JSON.parse(spawnSync(IFLOW_ID, ['--home', alice, 'show', '--json'], { encoding: 'utf8' }).stdout).did
    relay = fakeRelay()
    relay.routes.set(bobDid, 'node-b')
  })

  after(() => {
    for (const home of [alice, bob, mallory]) rmSync(home, { recursive: true, force: true })
  })

  const sendOne = async (messageId = 'msg-1') => {
    const out = transportFor(alice, relay)
    const sealed = await out.seal({
      toDid: bobDid,
      body: REQUEST,
      signature: SIGNATURE,
      conversationId: 'conv-1',
      messageId,
      fromDid: 'did:key:zAlice',
    })
    return out.send({
      url: 'https://relay.test',
      token: 'ifn_alice',
      toDid: bobDid,
      sealed,
      messageId,
      conversationId: 'conv-1',
      fromDid: 'did:key:zAlice',
    })
  }

  it('arrives, and is exactly what was sent', async () => {
    await sendOne()
    const delivered = []
    const outcome = await transportFor(bob, relay).drain({
      url: 'https://relay.test',
      token: 'ifn_bob',
      deliver: async (opened) => { delivered.push(opened) },
    })
    assert.deepEqual(outcome, { collected: 1, delivered: 1, refused: 0 })
    assert.equal(delivered[0].body, REQUEST)
    assert.deepEqual(delivered[0].signature, SIGNATURE)
  })

  it('leaves nothing readable in what the relay stored', async () => {
    relay.envelopes.clear()
    await sendOne('msg-opaque')
    const stored = relay.envelopes.get('msg-opaque').sealed
    assert.ok(!stored.includes('analyse'), 'the message survived into the relay')
    assert.ok(!stored.includes('SendMessage'), 'the request survived into the relay')
    assert.ok(!stored.includes('sig-bytes'), 'the signature survived into the relay')
  })

  it('cannot be opened by another node holding the same bytes', async () => {
    relay.envelopes.clear()
    await sendOne('msg-private')
    const envelope = { ...relay.envelopes.get('msg-private') }
    await assert.rejects(() => transportFor(mallory, relay).open(envelope))
  })

  it('cannot be re-addressed by the relay it passed through', async () => {
    relay.envelopes.clear()
    await sendOne('msg-bound')
    // A relay that cannot read a message could still try to redeliver it as a
    // different one. The additional data is what stops that.
    const moved = { ...relay.envelopes.get('msg-bound'), conversation_id: 'conv-2' }
    await assert.rejects(() => transportFor(bob, relay).open(moved))
  })

  it('is acknowledged only once it has been handled', async () => {
    relay.envelopes.clear()
    await sendOne('msg-fails')
    const bobTransport = transportFor(bob, relay)
    await bobTransport.drain({
      url: 'https://relay.test',
      token: 'ifn_bob',
      deliver: async () => { throw new Error('the local agent could not start') },
    })
    // Still waiting: this failure was ours, and losing the message would be
    // worse than delivering it twice.
    assert.equal(relay.envelopes.get('msg-fails').delivered_at, null)

    const second = await bobTransport.drain({
      url: 'https://relay.test',
      token: 'ifn_bob',
      deliver: async () => {},
    })
    assert.equal(second.delivered, 1)
    assert.ok(relay.envelopes.get('msg-fails').delivered_at)
  })

  it('does not wedge the inbox behind something that will never open', async () => {
    relay.envelopes.clear()
    await sendOne('msg-good')
    relay.envelopes.set('msg-corrupt', {
      id: 'msg-corrupt',
      to_node_id: 'node-b',
      to_did: bobDid,
      from_did: 'did:key:zAlice',
      conversation_id: 'conv-1',
      sealed: Buffer.from('v1 and then nonsense').toString('base64url'),
      delivered_at: null,
    })

    const delivered = []
    const outcome = await transportFor(bob, relay).drain({
      url: 'https://relay.test',
      token: 'ifn_bob',
      deliver: async (opened) => { delivered.push(opened) },
    })
    assert.equal(outcome.refused, 1)
    assert.equal(outcome.delivered, 1, 'the good message was held up by the bad one')
    // Both are gone from the inbox: the good one delivered, the bad one
    // discarded rather than retried forever.
    assert.ok(relay.envelopes.get('msg-corrupt').delivered_at)
  })

  it('carries an answer back the way it came', async () => {
    // The whole point of a two-way relay: a request with no connection to
    // answer on still gets answered. Sealed to the original sender, matching
    // the JSON-RPC id it was asked with.
    relay.envelopes.clear()
    relay.routes.set(aliceDid, 'node-a')

    const bobSide = transportFor(bob, relay)
    const answer = JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-1',
      result: { task: { id: 't1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ parts: [{ text: 'here is the analysis' }] }] } },
    })
    const sealedAnswer = await bobSide.seal({
      toDid: aliceDid,
      body: answer,
      signature: null,
      conversationId: 'conv-1',
      messageId: 'msg-answer',
      fromDid: bobDid,
    })
    // Route it to Alice's node so her inbox, not Bob's, is the one holding it.
    relay.envelopes.set('msg-answer', {
      id: 'msg-answer',
      to_node_id: 'node-a',
      to_did: aliceDid,
      from_did: bobDid,
      conversation_id: 'conv-1',
      sealed: sealedAnswer,
      delivered_at: null,
    })

    // Alice can open it, and what comes out is a response rather than a request.
    const opened = await transportFor(alice, relay).open(relay.envelopes.get('msg-answer'))
    const parsed = JSON.parse(opened.body)
    assert.equal(parsed.method, undefined, 'an answer must not look like a request')
    assert.equal(parsed.id, 'req-1', 'the answer must carry the id it was asked with')
    assert.match(parsed.result.task.artifacts[0].parts[0].text, /here is the analysis/)
  })

  it('is delivered once even if the relay hands it over twice', async () => {
    relay.envelopes.clear()
    await sendOne('msg-dup')
    await sendOne('msg-dup')
    assert.equal(relay.envelopes.size, 1)
  })
})
