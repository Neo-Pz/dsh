import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Node does not resolve TypeScript's .js import spelling. Keep this source
// adapter test independent of another repository's test loader.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(source))) return next(source.href, context)
    }
    return next(specifier, context)
  },
})

const { createDshAgentRuntime } = await import(process.env.IFLOW_TEST_DSH_RUNTIME
  ? pathToFileURL(process.env.IFLOW_TEST_DSH_RUNTIME).href
  : '../src/runtime/dsh-agent-runtime.ts')
const { createDshHttpTransport } = await import(process.env.IFLOW_TEST_DSH_CONNECT
  ? pathToFileURL(process.env.IFLOW_TEST_DSH_CONNECT).href
  : '../src/runtime/dsh-connect.ts')

function sessionFixture() {
  const conversation = {
    conversationId: 'conv-a', localAgentId: 'local', peerAgentId: 'peer', peer: 'Peer',
    binding: { localSessionId: 'session-a' },
  }
  const calls = { followup: 0, dispose: 0, persist: 0, policy: 0, resolve: 0 }
  const session = { id: 'session-a', events: [] }
  const handle = {
    agent: {
      session,
      followup() {
        calls.followup++
        session.events.push({ type: 'assistant/message', data: { message: {
          id: 'draft-a', content: [{ type: 'text', text: 'Prepared answer' }],
        } } })
      },
      async whenIdle() {},
    },
    async dispose() { calls.dispose++ },
  }
  const runtime = createDshAgentRuntime({
    ctx: {
      agents: { async resume() { await Promise.resolve(); calls.resolve++; return handle } },
      agentDefaultModel: { currentSelection() { return {} } },
    },
    config: {}, persistConversations: async () => calls.persist++,
    conversationsReady: Promise.resolve(), getConversation: () => conversation,
  })
  return { runtime, conversation, calls }
}

describe('DSH host runtime ports', () => {
  it('rechecks authority after asynchronous Session resolution before model execution', async () => {
    const { runtime, conversation, calls } = sessionFixture()
    await assert.rejects(runtime.generateDraft(conversation, {
      intentId: 'intent-a', text: 'private task',
      beforeExecute() {
        calls.policy++
        assert.equal(calls.resolve, 1)
        throw new Error('permission revoked')
      },
    }), /permission revoked/)
    assert.equal(calls.policy, 1)
    assert.equal(calls.followup, 0)
    assert.equal(calls.dispose, 1)
    assert.equal(calls.persist, 0)
  })

  it('returns the local draft and excludes its model preparation from peer history', async () => {
    const { runtime, conversation, calls } = sessionFixture()
    const draft = await runtime.generateDraft(conversation, {
      intentId: 'intent-b', text: 'private task', beforeExecute() { calls.policy++ },
    })
    assert.equal(draft, 'Prepared answer')
    assert.equal(calls.dispose, 1)
    assert.equal(conversation.localDraftRuns[0].sessionId, 'session-a')
    assert.deepEqual((await runtime.sessionSnapshot(conversation, undefined, 100)).messages, [])
    assert.equal(calls.dispose, 2)
  })

  it('signs ARD with the selected Agent and stops A2A when permission changes during mirroring', async () => {
    const agent = { agentId: 'coder', did: 'did:key:owned' }
    const calls = { spawn: 0, checks: 0, home: '', signingPath: '' }
    let allowed = true
    let signer = agent.did
    const transport = createDshHttpTransport({
      workspace: 'F:/fixture-workspace', scratchPath: (name) => `F:/fixture-workspace/${name}`,
      ctx: {
        fs: { resolve: async (path) => path, writeText: async () => {} },
        subprocess: {
          spawn({ argv }) {
            calls.spawn++
            assert.ok(argv.some((item) => item.startsWith('X-IFlow-Signature:')))
            return { done: Promise.resolve({ exitCode: 0 }), collected: {
              stdout: { readFrom() { return { text: '{"results":[]}' } } },
            } }
          },
        },
      },
      iflowId: async (args, home) => {
        calls.home = home; calls.signingPath = args[2]
        return JSON.stringify({ signer })
      },
      getIdentity: async () => { throw new Error('must not use Node key') },
      authorizeSend: () => { calls.checks++; if (!allowed) throw new Error('revoked after mirror') },
    })
    const response = await transport.curlPost('https://registry.example/v1/ard/search', {
      query: { text: 'code' },
    }, 30, undefined, agent)
    assert.deepEqual(response, { results: [] })
    assert.match(calls.home.replaceAll('\\', '/'), /\.iflow\/agents\/coder$/)
    assert.equal(calls.signingPath, '/v1/ard/search')
    assert.equal(calls.spawn, 1)

    signer = 'did:key:node'
    await assert.rejects(transport.curlPost('https://registry.example/v1/ard/search', {
      query: { text: 'code' },
    }, 30, undefined, agent), /agent_signing_failed/)
    assert.equal(calls.spawn, 1)

    signer = agent.did
    await assert.rejects(transport.curlPost('https://peer.example/a2a', {
      method: 'SendMessage', params: { metadata: {
        toAgentId: 'peer', toAgentAuthorityDid: 'did:key:peer',
      } },
    }, 30, undefined, agent, async () => { allowed = false }), /revoked/)
    assert.equal(calls.checks, 2)
    assert.equal(calls.spawn, 1)
  })
})
