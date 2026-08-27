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

function envelope(routing = {}) {
  return {
    version: 1,
    kind: 'human.intent',
    routing: {
      intentId: 'intent-1',
      principalId: 'iflow:principal:owner',
      toAgentId: 'own-agent',
      toAgentAuthorityDid: 'did:key:zOwnAgent',
      browserSessionId: 'browser-1',
      viewPublicKey: 'did:key:zBrowserView',
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      ...routing,
    },
    sealed: 'opaque-ciphertext',
  }
}

function direct(overrides = {}) {
  return JSON.stringify({
    version: 1,
    kind: 'conversation.send',
    mode: 'direct',
    targetAgentId: 'remote-agent',
    targetAgentAuthorityDid: 'did:key:zRemoteAgent',
    text: 'hello',
    ...overrides,
  })
}

function memoryStore(seed) {
  let value = seed
  return {
    async read() { return value ? structuredClone(value) : undefined },
    async write(next) { value = structuredClone(next) },
    value: () => structuredClone(value),
  }
}

function harness({ plaintext = direct(), available = true, execute, postView } = {}) {
  const store = memoryStore()
  const executions = []
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
        return typeof plaintext === 'function' ? plaintext() : plaintext
      },
      async seal(did, text, aad) {
        cryptoCalls.push({ kind: 'seal', did, text, aad })
        return `sealed:${text}`
      },
      async keyId() { return 'browser-key-digest' },
    },
    async executeIntent(input) {
      executions.push(input)
      if (execute) return execute(input)
      return {
        ok: true,
        state: input.intent.mode === 'assisted' ? 'draft_pending' : 'sent',
        conversationId: input.intent.conversationId ?? 'conv-active',
        remoteAgentId: input.intent.targetAgentId ?? input.intent.peerAgentId,
        views: [{ version: 1, kind: 'conversation.status', conversationId: input.intent.conversationId ?? 'conv-active', state: 'sending' }],
      }
    },
    async postView(view) {
      if (postView) return postView(view)
      views.push(view)
    },
    logger: { log() {}, warn() {} },
  })
  return { queue, store, executions, views, cryptoCalls }
}

describe('Local Intent durability and authority boundary', () => {
  it('persists before ACK and rejects the same id under swapped routing', async () => {
    const { queue, store } = harness({ available: false })
    assert.deepEqual(await queue.accept([envelope()]), ['intent-1'])
    assert.equal(store.value().intents[0].state, 'queued')
    assert.deepEqual(await queue.accept([envelope()]), ['intent-1'])
    assert.equal(store.value().intents.length, 1)
    assert.deepEqual(await queue.accept([envelope({ principalId: 'iflow:principal:attacker' })]), [])
  })

  it('keeps unavailable Agent ciphertext in the Local Queue', async () => {
    const { queue, executions, cryptoCalls } = harness({ available: false })
    await queue.accept([envelope()])
    await queue.process()
    assert.equal(executions.length, 0)
    assert.equal(cryptoCalls.length, 0)
    assert.equal((await queue.status())[0].state, 'queued')
  })

  it('opens with Agent Authority, executes once, removes ciphertext and seals a ten-minute View', async () => {
    const { queue, store, executions, views, cryptoCalls } = harness()
    await queue.accept([envelope()])
    await queue.process()
    await queue.process()
    assert.equal(executions.length, 1)
    assert.equal(executions[0].ownAgentId, 'own-agent')
    assert.equal(executions[0].ownAgentAuthorityDid, 'did:key:zOwnAgent')
    assert.equal(store.value().intents[0].envelope, undefined)
    assert.equal(store.value().intents[0].state, 'sent')
    assert.equal(views.length, 1)
    assert.equal(views[0].routing.conversationId, 'conv-active')
    assert.equal(views[0].routing.ownAgentId, 'own-agent')
    assert.equal(Date.parse(views[0].routing.expiresAt) - NOW.getTime(), 10 * 60 * 1000)
    assert.equal(cryptoCalls[0].aad, intentAad(envelope()))
    assert.equal(cryptoCalls.at(-1).aad, browserViewAad(views[0]))
  })

  it('retries a transient runtime failure with one durable intent id', async () => {
    let attempts = 0
    const { queue, executions } = harness({
      execute: async () => (++attempts === 1 ? { ok: false, error: 'offline' } : {
        ok: true, state: 'sent', conversationId: 'conv-active', views: [],
      }),
    })
    await queue.accept([envelope()])
    await queue.process()
    assert.equal((await queue.status())[0].state, 'queued')
    await queue.process(); await queue.process()
    assert.equal(executions.length, 2)
    assert.equal(executions[0].intentId, executions[1].intentId)
    assert.equal((await queue.status())[0].state, 'sent')
  })

  it('does not repeat the Agent side effect when Browser View delivery fails', async () => {
    const { queue, executions, store } = harness({ postView: async () => { throw new Error('view offline') } })
    await queue.accept([envelope()]); await queue.process(); await queue.process()
    assert.equal(executions.length, 1)
    assert.equal(store.value().intents[0].state, 'sent')
  })

  it('permanently denies unreadable or semantically enlarged Intents', async () => {
    const enlarged = harness({ plaintext: direct({ tool: 'shell' }) })
    await enlarged.queue.accept([envelope()]); await enlarged.queue.process()
    assert.equal(enlarged.executions.length, 0)
    assert.equal(enlarged.store.value().intents[0].state, 'denied')

    const unreadable = harness({ plaintext: new IntentEnvelopeError('wrong key') })
    await unreadable.queue.accept([envelope()]); await unreadable.queue.process()
    assert.equal(unreadable.executions.length, 0)
    assert.equal((await unreadable.queue.status())[0].state, 'denied')
  })

  it('fans a reply out to all live browser bindings without storing plaintext', async () => {
    let current = direct({ conversationId: 'conv-shared' })
    const h = harness({ plaintext: () => current })
    await h.queue.accept([envelope()]); await h.queue.process()
    await h.queue.accept([envelope({ intentId: 'intent-2', browserSessionId: 'browser-2', viewPublicKey: 'did:key:zView2' })])
    await h.queue.process()
    const message = {
      messageId: 'reply-1', conversationId: 'conv-shared', authorAgentId: 'remote-agent',
      authorLabel: 'Remote', contentOrigin: 'agent', role: 'agent', text: 'private answer',
      createdAt: NOW.toISOString(), state: 'delivered',
    }
    assert.equal(await h.queue.deliverReply('conv-shared', message), true)
    assert.equal(h.views.length, 4)
    assert.equal(h.cryptoCalls.filter((call) => call.kind === 'seal' && call.text.includes('private answer')).length, 2)
    assert.doesNotMatch(JSON.stringify(h.store.value()), /private answer/)
  })
})

describe('P0 conversation Intent contract', () => {
  it('distinguishes Direct, Assisted, paged sync and draft decisions', () => {
    assert.equal(parseConversationIntent(direct()).mode, 'direct')
    assert.equal(parseConversationIntent(direct({ mode: 'assisted' })).mode, 'assisted')
    assert.deepEqual(parseConversationIntent(JSON.stringify({
      version: 1, kind: 'conversation.sync', ownAgentId: 'own-agent', peerAgentId: 'peer-agent',
    })).limit, 50)
    assert.deepEqual(parseConversationIntent(JSON.stringify({
      version: 1, kind: 'conversation.sync', ownAgentId: 'own-agent',
    })), {
      version: 1, kind: 'conversation.sync', ownAgentId: 'own-agent',
      peerAgentId: undefined, conversationId: undefined, cursor: undefined, limit: 50,
    })
    assert.equal(parseConversationIntent(JSON.stringify({
      version: 1, kind: 'conversation.draft.decide', conversationId: 'conv-1', draftId: 'draft-1', decision: 'confirm',
    })).decision, 'confirm')
    assert.throws(() => parseConversationIntent('{not-json'), /not JSON/)
    assert.throws(() => parseConversationIntent(JSON.stringify({ version: 1, kind: 'tool.run' })), /unsupported/)
  })
})
