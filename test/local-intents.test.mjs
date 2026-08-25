import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const {
  IntentEnvelopeError,
  LocalIntentQueue,
  browserViewAad,
  intentAad,
  parseConversationIntent,
} = await import(pathToFileURL(join(import.meta.dirname, '..', 'src', 'web', 'local-intents.ts')).href)

const NOW = new Date('2026-08-25T12:00:00.000Z')

function envelope(overrides = {}) {
  return {
    version: 1,
    kind: 'human.intent',
    routing: {
      intentId: 'intent-1',
      principalId: 'iflow:principal:owner',
      toAgentDid: 'did:key:zOwnAgent',
      browserSessionId: 'browser-1',
      viewPublicKey: 'did:key:zBrowserView',
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      ...overrides.routing,
    },
    sealed: overrides.sealed ?? 'opaque-ciphertext',
  }
}

function memoryStore(seed) {
  let value = seed
  return {
    async read() { return value ? structuredClone(value) : undefined },
    async write(next) { value = structuredClone(next) },
    value: () => structuredClone(value),
  }
}

function harness({ plaintext, available = true, send, postView } = {}) {
  const store = memoryStore()
  const sent = []
  const views = []
  const cryptoCalls = []
  const queue = new LocalIntentQueue({
    store,
    clock: () => new Date(NOW),
    isAgentAvailable: async () => available,
    crypto: {
      async open(did, sealed, aad) {
        cryptoCalls.push({ kind: 'open', did, sealed, aad })
        if (plaintext instanceof Error) throw plaintext
        return plaintext ?? JSON.stringify({
          version: 1,
          kind: 'conversation.send',
          targetAgentDid: 'did:key:zRemoteAgent',
          text: 'hello',
        })
      },
      async seal(did, text, aad) {
        cryptoCalls.push({ kind: 'seal', did, text, aad })
        return `sealed:${text}`
      },
      async keyId() { return 'browser-key-digest' },
    },
    async sendConversation(message) {
      sent.push(message)
      return send ? send(message) : { ok: true }
    },
    async postView(view) {
      if (postView) return postView(view)
      views.push(view)
    },
    logger: { log() {}, warn() {} },
  })
  return { queue, store, sent, views, cryptoCalls }
}

describe('Local Intent durability and authority boundary', () => {
  it('persists before ACK and deduplicates a Community redelivery', async () => {
    const { queue, store } = harness({ available: false })
    assert.deepEqual(await queue.accept([envelope()]), ['intent-1'])
    assert.equal(store.value().intents[0].state, 'queued')
    assert.deepEqual(await queue.accept([envelope()]), ['intent-1'])
    assert.equal(store.value().intents.length, 1)

    const swapped = envelope({ routing: { principalId: 'iflow:principal:attacker' } })
    assert.deepEqual(await queue.accept([swapped]), [])
  })

  it('keeps an unavailable Agent in the Local Queue without decrypting or sending', async () => {
    const { queue, sent, cryptoCalls } = harness({ available: false })
    await queue.accept([envelope()])
    await queue.process()
    assert.equal(sent.length, 0)
    assert.equal(cryptoCalls.length, 0)
    assert.equal((await queue.status())[0].state, 'queued')
  })

  it('decrypts with the selected Own Agent, sends once, clears ciphertext and emits a sealed View', async () => {
    const { queue, store, sent, views, cryptoCalls } = harness()
    await queue.accept([envelope()])
    await queue.process()
    await queue.process()

    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0], {
      intentId: 'intent-1',
      messageId: 'intent-1',
      conversationId: 'web-intent-1',
      fromAgentDid: 'did:key:zOwnAgent',
      toAgentDid: 'did:key:zRemoteAgent',
      text: 'hello',
    })
    assert.equal(store.value().intents[0].envelope, undefined)
    assert.equal(store.value().intents[0].state, 'sent')
    assert.equal(views.length, 1)
    assert.equal(views[0].routing.viewKeyId, 'browser-key-digest')
    assert.equal(cryptoCalls[0].aad, intentAad(envelope()))
    assert.equal(cryptoCalls.at(-1).aad, browserViewAad(views[0]))
  })

  it('retries a transient send with the same message id and never repeats after success', async () => {
    let attempts = 0
    const { queue, sent } = harness({
      send: async () => (++attempts === 1 ? { ok: false, error: 'offline' } : { ok: true }),
    })
    await queue.accept([envelope()])
    await queue.process()
    assert.equal((await queue.status())[0].state, 'queued')
    await queue.process()
    await queue.process()
    assert.equal(sent.length, 2)
    assert.equal(sent[0].messageId, sent[1].messageId)
    assert.equal((await queue.status())[0].state, 'sent')
  })

  it('does not repeat an Agent side effect when Browser View delivery fails', async () => {
    const { queue, sent, store } = harness({
      postView: async () => { throw new Error('view relay offline') },
    })
    await queue.accept([envelope()])
    await queue.process()
    await queue.process()
    assert.equal(sent.length, 1)
    assert.equal(store.value().intents[0].state, 'sent')
    assert.equal(store.value().intents[0].envelope, undefined)
  })

  it('denies unsupported semantics without producing an Agent message', async () => {
    const { queue, sent, views, store } = harness({
      plaintext: JSON.stringify({
        version: 1,
        kind: 'conversation.send',
        targetAgentDid: 'did:key:zRemoteAgent',
        text: 'run it',
        tool: 'shell',
      }),
    })
    await queue.accept([envelope()])
    await queue.process()
    assert.equal(sent.length, 0)
    assert.equal(store.value().intents[0].state, 'denied')
    assert.equal(store.value().intents[0].envelope, undefined)
    assert.match(Buffer.from(views[0].sealed.slice('sealed:'.length)).toString(), /policy_denied/)
  })

  it('treats an undecryptable envelope as permanent and does not log plaintext', async () => {
    const { queue, sent } = harness({ plaintext: new IntentEnvelopeError('wrong Agent key') })
    await queue.accept([envelope()])
    await queue.process()
    assert.equal(sent.length, 0)
    assert.equal((await queue.status())[0].state, 'denied')
  })

  it('re-encrypts a remote reply for the matching Browser without storing the text', async () => {
    const { queue, store, views, cryptoCalls } = harness()
    await queue.accept([envelope()])
    await queue.process()
    assert.equal(await queue.deliverReply('web-intent-1', 'private answer', 'did:key:zRemoteAgent'), true)
    assert.equal(views.length, 2)
    assert.match(cryptoCalls.at(-1).text, /private answer/)
    assert.doesNotMatch(JSON.stringify(store.value()), /private answer/)
    assert.equal(await queue.deliverReply('unknown', 'not delivered', 'did:key:zOther'), false)
  })
})

describe('P0 plaintext policy', () => {
  it('accepts only message-only conversation.send', () => {
    assert.equal(parseConversationIntent(JSON.stringify({
      version: 1,
      kind: 'conversation.send',
      targetAgentDid: 'did:key:zRemote',
      text: 'hello',
    })).text, 'hello')
    assert.throws(() => parseConversationIntent('{not-json'), /not JSON/)
    assert.throws(() => parseConversationIntent(JSON.stringify({ version: 1, kind: 'tool.run' })), /only conversation.send/)
  })
})
