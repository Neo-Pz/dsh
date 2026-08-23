/**
 * What may leave this machine.
 *
 * These assertions are the privacy boundary.
 *
 * The rules are exercised against the source module, because the build inlines
 * it into `lib/index.js` and there is no second entry point to import. So the
 * last test in this file closes that gap directly: it reads the bundle DSH
 * actually loads and asserts the redaction survived bundling. A rule that only
 * holds in source protects nobody.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const BUNDLE = join(import.meta.dirname, '..', 'lib', 'index.js')

const { redactEvent, createCommunitySink } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'edge', 'sync.ts')).href
)

function event(overrides = {}) {
  return {
    id: 'evt-1',
    schemaVersion: 1,
    origin: { nodeId: 'node-1', streamId: 'edge', seq: 1 },
    occurredAt: '2026-08-23T00:00:00.000Z',
    type: 'task.created',
    issuer: { id: 'node-1', kind: 'agent' },
    subject: { kind: 'task', id: 'task-1' },
    payload: { title: 'Refactor the billing exporter', ownerAgentId: 'agent-1' },
    ...overrides,
  }
}

describe('redaction before upload', () => {
  it('removes free text and says which field it removed', () => {
    const out = redactEvent(event(), 'structural')

    assert.notEqual(out.payload.title, 'Refactor the billing exporter')
    assert.match(out.payload.title, /redacted/)
    assert.deepEqual(out.redaction.fields, ['payload.title'])
  })

  it('keeps every structural field the projections are built from', () => {
    const out = redactEvent(event(), 'structural')

    assert.equal(out.id, 'evt-1')
    assert.equal(out.type, 'task.created')
    assert.equal(out.occurredAt, '2026-08-23T00:00:00.000Z')
    assert.deepEqual(out.origin, { nodeId: 'node-1', streamId: 'edge', seq: 1 })
    assert.equal(out.payload.ownerAgentId, 'agent-1')
  })

  it('redacts a reason as well as a title, wherever the type', () => {
    const out = redactEvent(
      event({ type: 'approval.requested', payload: { approvalId: 'a-1', toolName: 'write_file', reason: 'needs to touch prod' } }),
      'structural',
    )

    assert.equal(out.payload.toolName, 'write_file', 'a tool NAME is structure, not content')
    assert.match(out.payload.reason, /redacted/)
    assert.deepEqual(out.redaction.fields, ['payload.reason'])
  })

  it('drops the signature rather than shipping one that cannot verify', () => {
    const out = redactEvent(event({ signature: 'base64url-signature' }), 'structural')

    // A signature over a body that no longer matches would make a verifier
    // report a FORGERY. Absent is the honest answer; the signed original stays
    // on the node.
    assert.equal(out.signature, undefined)
    assert.ok(out.redaction)
  })

  it('leaves the event untouched when the operator asked for full text', () => {
    const original = event({ signature: 'base64url-signature' })
    const out = redactEvent(original, 'full')

    assert.equal(out, original)
    assert.equal(out.payload.title, 'Refactor the billing exporter')
    assert.equal(out.signature, 'base64url-signature')
  })

  it('does not invent a redaction note when there was nothing to redact', () => {
    const out = redactEvent(event({ type: 'task.completed', payload: {} }), 'structural')

    assert.equal(out.redaction, undefined)
    assert.equal(out.signature, undefined)
  })
})

describe('the community sink', () => {
  it('uploads redacted NDJSON and reports back what was accepted', async () => {
    const seen = []
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init })
      return {
        ok: true,
        status: 200,
        json: async () => ({ acceptedEventIds: ['evt-1'] }),
      }
    }

    const sink = createCommunitySink({ url: 'https://api.example.com/', token: 'tok', visibility: 'structural' })
    const result = await sink.publish([event()])

    assert.deepEqual(result.acceptedEventIds, ['evt-1'])
    assert.equal(seen[0].url, 'https://api.example.com/v1/edge/events')
    assert.equal(seen[0].init.headers.Authorization, 'Bearer tok')

    const uploaded = JSON.parse(seen[0].init.body)
    assert.match(uploaded.payload.title, /redacted/, 'the sink must not upload raw free text')
  })

  it('throws on a refusal, so the outbox keeps everything queued', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })

    const sink = createCommunitySink({ url: 'https://api.example.com', token: 'tok', visibility: 'structural' })
    await assert.rejects(() => sink.publish([event()]), /503/)
  })
})

describe('the rule that ships', () => {
  it('is in the bundle DSH loads, not only in the source', () => {
    const bundle = readFileSync(BUNDLE, 'utf8')

    assert.match(bundle, /\[redacted at origin\]/, 'the redaction marker must be in the built plugin')
    assert.match(bundle, /"title",\s*"reason"|'title',\s*'reason'/, 'the free-text key list must survive bundling')
    assert.match(bundle, /v1\/edge\/events/, 'the upload path must be in the built plugin')
  })

  it('never sends anything unless a Community and a token are both configured', () => {
    const bundle = readFileSync(BUNDLE, 'utf8')

    // The guard, not a comment about the guard: publishing stays off until an
    // operator names a Community AND gives it a token.
    assert.match(bundle, /community\.url\s*&&\s*[a-zA-Z_$][\w$]*\.community\.token/)
  })
})
