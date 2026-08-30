/**
 * The Conversation Bridge, end to end through the built bundle.
 *
 * These are the acceptance scenarios: a first contact waits for a person, an
 * accepted thread keeps talking in one session, a deleted session does not end
 * the conversation, and none of the local mapping ever reaches the outbox.
 *
 * Loads the REAL `lib/index.js` — the file DSH loads — against a stub host, and
 * drives it by POSTing actual A2A JSON-RPC at the mounted `/a2a` route, so the
 * wire shape is exercised rather than described.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

globalThis.fetch = async () => {
  throw new Error('network disabled in tests')
}

const BUNDLE = pathToFileURL(join(import.meta.dirname, '..', 'lib', 'index.js')).href

async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * A stub DSH host that records how agents were started.
 *
 * `created` and `resumed` are the whole point: the difference between them is
 * the difference between a conversation that remembers and one that does not.
 */
function createHost(workspace, { resumeFails = false } = {}) {
  const routes = new Map()
  const tools = new Map()
  const created = []
  const resumed = []
  const followups = []
  let counter = 0

  const makeHandle = (sessionId) => {
    const events = []
    const agent = {
      session: { id: sessionId, header: { meta: {} }, events },
      followup(message) {
        // Kept, not discarded: the id and the authorship the plugin puts here
        // are the thing several tests are about.
        followups.push({ sessionId, message })
        const text = (message.content ?? []).map((b) => b.text ?? '').join('')
        events.push({
          type: 'assistant/message',
          data: {
            message: { content: [{ type: 'text', text: `echo: ${text}` }] },
            usage: { inputTokens: 10, outputTokens: 5 },
          },
        })
      },
      async whenIdle() {},
      cancel() {},
    }
    return { agent, dispose: async () => {} }
  }

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    webServer: {
      host: '127.0.0.1',
      port: 3080,
      register(spec) {
        routes.set(spec.path, spec.handler)
        return () => routes.delete(spec.path)
      },
    },
    web: {},
    subprocess: {
      spawn() {
        return {
          done: Promise.resolve({ exitCode: 1 }),
          collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
        }
      },
      async resolveExecutable(path) {
        return path
      },
    },
    sandboxPolicy: { workspaceRoot: workspace },
    agents: {
      async create(options) {
        created.push(options)
        counter += 1
        return makeHandle(options.sessionId ?? `session-${counter}`)
      },
      async resume(options) {
        resumed.push(options)
        if (resumeFails) throw new Error('no such persisted session')
        return makeHandle(options.resumeSessionId)
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
    // A resolvable restricted preset, so the inbound path is confined rather
    // than failing closed — the acceptance gate is what these tests are about.
    agentPresets: { resolve: async () => ({ id: 'remote-a2a' }), mount: async () => {} },
    sessionTitle: { rename: () => {} },
    sessions: { get: () => undefined, prepare: async () => ({}), enter: () => () => {} },
    fs: {
      async resolve(path) {
        return path
      },
      async readText(path) {
        return readFileSync(path, 'utf8')
      },
      async writeText(path, text) {
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, text, 'utf8')
      },
    },
    timer: {},
    timeout(handler, ms) {
      const id = setTimeout(handler, ms)
      return () => clearTimeout(id)
    },
    effect(fn) {
      fn()
    },
    get() {
      return undefined
    },
    on() {
      return () => {}
    },
  }

  const post = (path, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const handler = routes.get(path)
      if (!handler) return reject(new Error(`no route mounted at ${path}`))
      const payload = typeof body === 'string' ? body : JSON.stringify(body)
      const req = {
        method: 'POST',
        url: path,
        headers,
        on(event, cb) {
          if (event === 'data') cb(Buffer.from(payload, 'utf8'))
          if (event === 'end') cb()
        },
      }
      let status = 0
      const res = {
        writeHead(code) {
          status = code
          return res
        },
        end(text) {
          resolve({ status, json: text ? JSON.parse(text) : undefined })
        },
        write() {},
        on() {},
      }
      handler(req, res).catch(reject)
    })

  return { ctx, routes, tools, created, resumed, followups, post }
}

/** Send one A2A message and return the resulting Task. */
async function sendMessage(host, { text, contextId, messageId, from = 'peer-a', metadata = {} }) {
  const { json } = await host.post('/a2a', {
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'SendMessage',
    params: {
      message: {
        messageId: messageId ?? `msg-${Math.random().toString(36).slice(2)}`,
        ...(contextId ? { contextId } : {}),
        role: 'ROLE_USER',
        parts: [{ text, mediaType: 'text/plain' }],
      },
      configuration: { returnImmediately: true, historyLength: 0 },
      metadata: { from, machine: 'test-machine', ...metadata },
    },
  })
  assert.ok(json, 'expected a JSON-RPC response')
  assert.ok(!json.error, `unexpected RPC error: ${JSON.stringify(json.error)}`)
  return json.result.task
}

async function getTask(host, id) {
  const { json } = await host.post('/a2a', { jsonrpc: '2.0', id: 'req-2', method: 'GetTask', params: { id } })
  return json.result.task
}

/** Boot the plugin in a fresh workspace, optionally with a trust file. */
async function boot({ trust, resumeFails = false } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'iflow-conv-'))
  if (trust) {
    mkdirSync(join(workspace, '.iflow'), { recursive: true })
    writeFileSync(join(workspace, '.iflow', 'trust.json'), JSON.stringify(trust), 'utf8')
  }
  const host = createHost(workspace, { resumeFails })
  const plugin = (await import(BUNDLE)).default
  // Most bridge scenarios model a node whose operator already chose its
  // session folder. Fresh interactive installs exercise that confirmation in
  // panel.test.mjs; these tests exercise delivery after the choice.
  plugin.apply(host.ctx, { conversationWorkspace: workspace })
  await waitFor(() => host.routes.has('/a2a'), 'the A2A route to mount')
  // The edge comes up asynchronously and the A2A bridge deliberately does not
  // wait for it — journaling must never gate answering a peer. Tests that
  // assert on journaled facts do have to wait for it.
  await waitFor(() => host.routes.has('/iflow/edge/status'), 'the edge to mount')
  return { workspace, host, cleanup: () => rmSync(workspace, { recursive: true, force: true }) }
}

function readConversations(workspace) {
  const path = join(workspace, '.iflow', 'conversations.json')
  if (!existsSync(path)) return { conversations: {} }
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('the scoped first-contact reset', () => {
  it('erases only one pair’s local bindings and leaves identity, peers, trust and other chats alone', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'iflow-reset-pair-'))
    const local = `did:key:z${'A'.repeat(42)}`
    const peer = `did:key:z${'B'.repeat(42)}`
    const otherPeer = `did:key:z${'C'.repeat(42)}`
    const iflow = join(workspace, '.iflow')
    mkdirSync(iflow, { recursive: true })
    writeFileSync(join(iflow, 'conversations.json'), JSON.stringify({
      conversations: {
        'conv-reset': {
          localAgentAuthorityDid: local, peerAgentAuthorityDid: peer, peer: 'wwee', state: 'active',
          binding: { runtime: 'dsh', workspaceId: workspace, localSessionId: 'session-keep-history' },
        },
        'conv-keep': {
          localAgentAuthorityDid: local, peerAgentAuthorityDid: otherPeer, peer: 'other', state: 'active',
          binding: { runtime: 'dsh', workspaceId: workspace, localSessionId: 'session-other' },
        },
      },
    }))
    writeFileSync(join(iflow, 'permissions.json'), JSON.stringify({
      pairs: {
        ignored: { localAgentDid: local, peerAgentDid: peer, messaging: 'allowed' },
        other: { localAgentDid: local, peerAgentDid: otherPeer, messaging: 'allowed' },
      },
    }))
    writeFileSync(join(iflow, 'mailbox.json'), JSON.stringify({
      outbox: [{ conversationId: 'conv-reset' }, { conversationId: 'conv-keep' }], inbox: [],
    }))
    // These are deliberately unrelated storage classes. reset_pair must not
    // turn a repeatable chat test into a fresh installation.
    for (const name of ['identity.json', 'principal-binding.json', 'agents.json', 'community.json', 'peers.json', 'trust.json']) {
      writeFileSync(join(iflow, name), JSON.stringify({ preserved: name }))
    }
    mkdirSync(join(iflow, 'edge'), { recursive: true })
    writeFileSync(join(iflow, 'edge', 'origin.ndjson'), '{"type":"agent.declared"}\n')
    const host = createHost(workspace)
    const plugin = (await import(BUNDLE)).default
    plugin.apply(host.ctx, { conversationWorkspace: workspace })
    await waitFor(() => host.tools.has('iflow_conversations'), 'the conversation tool to mount')
    try {
      const reset = await host.tools.get('iflow_conversations').execute({
        action: 'reset_pair', localAgentDid: local, peerAgentDid: peer, confirm: 'RESET_PAIR',
      })
      assert.equal(reset.ok, true)
      assert.equal(reset.conversations, 1)
      const after = readConversations(workspace).conversations
      assert.equal(after['conv-reset'], undefined)
      assert.ok(after['conv-keep'], 'another pair’s conversation was deleted')
      const permissions = JSON.parse(readFileSync(join(iflow, 'permissions.json'), 'utf8')).pairs
      assert.equal(Object.values(permissions).some((row) => row.peerAgentDid === peer), false)
      assert.equal(Object.values(permissions).some((row) => row.peerAgentDid === otherPeer), true)
      const mailbox = JSON.parse(readFileSync(join(iflow, 'mailbox.json'), 'utf8'))
      assert.equal(mailbox.outbox.some((row) => row.conversationId === 'conv-reset'), false)
      assert.equal(mailbox.outbox.some((row) => row.conversationId === 'conv-keep'), true)
      for (const name of ['identity.json', 'principal-binding.json', 'agents.json', 'community.json', 'peers.json', 'trust.json']) {
        assert.equal(JSON.parse(readFileSync(join(iflow, name), 'utf8')).preserved, name, `${name} was touched`)
      }
      assert.equal(readFileSync(join(iflow, 'edge', 'origin.ndjson'), 'utf8'), '{"type":"agent.declared"}\n', 'the Edge Journal was touched')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('scenario A — first contact waits for a person', () => {
  it('parks an unknown agent without starting a session, then delivers on accept', async () => {
    const { workspace, host, cleanup } = await boot()
    try {
      const task = await sendMessage(host, { text: 'can you analyse this CSV?' })

      // Held, not run. This is the DoS surface closing: no session, no model,
      // no tools, no tokens, on nothing but a stranger's say-so.
      assert.equal(task.status.state, 'TASK_STATE_AUTH_REQUIRED')
      assert.equal(host.created.length, 0, 'no local session may exist before a person accepts')
      assert.equal(host.resumed.length, 0)

      // AUTH_REQUIRED is not terminal, so the sender's existing GetTask poll
      // loop keeps waiting rather than giving up.
      assert.ok(!['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']
        .includes(task.status.state))

      const conversationId = task.contextId
      assert.ok(conversationId, 'the task must carry the conversation it belongs to')

      const tool = host.tools.get('iflow_conversations')
      assert.ok(tool, 'iflow_conversations must be registered')

      const listed = await tool.execute({ action: 'list' })
      const pending = listed.conversations.find((c) => c.conversationId === conversationId)
      assert.equal(pending.state, 'pending')
      assert.equal(pending.preview, 'can you analyse this CSV?')

      const accepted = await tool.execute({ action: 'accept', conversationId })
      assert.equal(accepted.ok, true)
      assert.equal(accepted.delivered, true, 'the held message must be delivered, not dropped')

      // The same task the sender is still polling now completes.
      await waitFor(async () => (await getTask(host, task.id)).status.state === 'TASK_STATE_COMPLETED',
        'the accepted task to complete')
      const done = await getTask(host, task.id)
      assert.equal(host.created.length, 1, 'accepting is what creates the session')
      assert.equal(host.created[0].meta.cwd, workspace, 'the normal DSH session is filed under the selected workspace')
      assert.equal(host.created[0].meta.origin, undefined, 'iFlow conversations must not be hidden as subagent sessions')
      assert.match(done.artifacts[0].parts[0].text, /echo: can you analyse this CSV\?/)

      // conversationId is shared; the local session id is not, and is not in
      // anything the far side can see.
      const stored = readConversations(workspace).conversations[conversationId]
      assert.equal(stored.state, 'active')
      assert.ok(stored.binding.localSessionId)
      assert.equal(JSON.stringify(done).includes(stored.binding.localSessionId), false)
    } finally {
      cleanup()
    }
  })

  it('rejects with a terminal state, so the sender stops polling at once', async () => {
    const { host, cleanup } = await boot()
    try {
      const task = await sendMessage(host, { text: 'let me in' })
      const tool = host.tools.get('iflow_conversations')
      await tool.execute({ action: 'reject', conversationId: task.contextId, reason: 'no thanks' })

      const after = await getTask(host, task.id)
      assert.equal(after.status.state, 'TASK_STATE_REJECTED')
      assert.equal(host.created.length, 0, 'a rejected contact never ran anything')
    } finally {
      cleanup()
    }
  })

  it('refuses a blocked agent outright, without asking anyone', async () => {
    const { host, cleanup } = await boot({ trust: { default: 'ask', peers: {}, blocked: ['villain'] } })
    try {
      const task = await sendMessage(host, { text: 'hello', from: 'villain' })
      assert.equal(task.status.state, 'TASK_STATE_REJECTED')
      assert.equal(host.created.length, 0)
    } finally {
      cleanup()
    }
  })
})

describe('an older peer that knows nothing about conversations', () => {
  it('is understood, and gets a minted conversation back on the task', async () => {
    // Exactly the shape iflow_send used to produce: no contextId, metadata
    // with nothing but from and machine.
    const { host, cleanup } = await boot({ trust: { default: 'auto', peers: {}, blocked: [] } })
    try {
      const task = await sendMessage(host, { text: 'run this please' })
      assert.ok(task.contextId, 'a peer that sent no contextId still gets one')
      await waitFor(async () => (await getTask(host, task.id)).status.state === 'TASK_STATE_COMPLETED',
        'the trusted task to complete')
      const done = await getTask(host, task.id)
      assert.match(done.artifacts[0].parts[0].text, /echo: run this please/)
    } finally {
      cleanup()
    }
  })
})

describe('continuity — the second message reaches a model that remembers the first', () => {
  it('resumes the bound session instead of creating another', async () => {
    const { host, cleanup } = await boot({ trust: { default: 'auto', peers: {}, blocked: [] } })
    try {
      const first = await sendMessage(host, { text: 'first' })
      await waitFor(async () => (await getTask(host, first.id)).status.state === 'TASK_STATE_COMPLETED', 'first')
      assert.equal(host.created.length, 1)
      const boundSession = host.created[0].sessionId

      const second = await sendMessage(host, { text: 'second', contextId: first.contextId })
      await waitFor(async () => (await getTask(host, second.id)).status.state === 'TASK_STATE_COMPLETED', 'second')

      assert.equal(host.created.length, 1, 'the second message must NOT create a second session')
      assert.equal(host.resumed.length, 1)
      assert.equal(host.resumed[0].resumeSessionId, boundSession)
      // A resumed session is no less remote than a fresh one, so the confining
      // preset is mounted on that path too.
      assert.equal(typeof host.resumed[0].setup, 'function')
    } finally {
      cleanup()
    }
  })

  it('gives a different local session id than the conversation id', async () => {
    const { workspace, host, cleanup } = await boot({ trust: { default: 'auto', peers: {}, blocked: [] } })
    try {
      const task = await sendMessage(host, { text: 'hello' })
      await waitFor(async () => (await getTask(host, task.id)).status.state === 'TASK_STATE_COMPLETED', 'task')
      const stored = readConversations(workspace).conversations[task.contextId]
      assert.notEqual(stored.binding.localSessionId, task.contextId)
    } finally {
      cleanup()
    }
  })
})

describe('scenario C — the local session is deleted', () => {
  it('starts a new one and carries on the same conversation', async () => {
    const { workspace, host, cleanup } = await boot({
      trust: { default: 'auto', peers: {}, blocked: [] },
      resumeFails: true,
    })
    try {
      const first = await sendMessage(host, { text: 'first' })
      await waitFor(async () => (await getTask(host, first.id)).status.state === 'TASK_STATE_COMPLETED', 'first')
      const originalSession = readConversations(workspace).conversations[first.contextId].binding.localSessionId

      // The peer sends again on the same conversation; resume now throws,
      // standing in for a session someone deleted.
      const second = await sendMessage(host, { text: 'still there?', contextId: first.contextId })
      await waitFor(async () => (await getTask(host, second.id)).status.state === 'TASK_STATE_COMPLETED', 'second')

      assert.equal(host.resumed.length, 1, 'it tried to resume')
      assert.equal(host.created.length, 2, 'and fell back to a new session')

      const rebound = readConversations(workspace).conversations[first.contextId]
      assert.equal(rebound.conversationId, first.contextId, 'the conversation outlives the session')
      assert.notEqual(rebound.binding.localSessionId, originalSession, 'and is rebound to the new one')
      assert.equal(second.contextId, first.contextId)
    } finally {
      cleanup()
    }
  })
})

describe('the local mapping never leaves the machine', () => {
  it('keeps session bindings and message text out of the outbox', async () => {
    const { workspace, host, cleanup } = await boot({ trust: { default: 'auto', peers: {}, blocked: [] } })
    try {
      const task = await sendMessage(host, { text: 'a secret instruction' })
      await waitFor(async () => (await getTask(host, task.id)).status.state === 'TASK_STATE_COMPLETED', 'task')
      const binding = readConversations(workspace).conversations[task.contextId].binding.localSessionId

      const outboxPath = join(workspace, '.iflow', 'edge', 'outbox.ndjson')

      // Observation is fire-and-forget by design — it must never delay the
      // work it observes — so wait for the fact rather than racing it.
      const readJournal = () =>
        readFileSync(join(workspace, '.iflow', 'edge', 'origin.ndjson'), 'utf8')
          .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      await waitFor(
        () => readJournal().some((e) => e.type.startsWith('conversation.message')),
        'the exchange to be journaled',
      )
      const journal = readJournal()
      const outbox = existsSync(outboxPath) ? readFileSync(outboxPath, 'utf8') : ''
      const queuedIds = new Set(
        outbox.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).eventId),
      )
      const queuedTypes = journal.filter((e) => queuedIds.has(e.id)).map((e) => e.type)

      for (const type of queuedTypes) {
        assert.ok(!type.startsWith('conversation.'), `${type} must never be queued for upload`)
        assert.ok(!type.startsWith('workspace.'), `${type} must never be queued for upload`)
      }
      assert.equal(outbox.includes(binding), false, 'no local session id in the outbox')
      assert.ok(
        journal.filter((event) => event.type.startsWith('conversation.')).every((event) => event.visibility === 'local'),
        'conversation history is signed as local fact, not merely hidden by a projection',
      )

      // And the conversation facts that ARE journaled carry a digest, not text.
      const messageFacts = journal.filter((e) => e.type.startsWith('conversation.message'))
      assert.ok(messageFacts.length > 0, 'expected the exchange to be journaled')
      for (const fact of messageFacts) {
        assert.match(fact.payload.contentDigest, /^sha256:[0-9a-f]{64}$/)
        assert.equal(JSON.stringify(fact).includes('a secret instruction'), false)
      }
    } finally {
      cleanup()
    }
  })
})

describe('a redelivered message', () => {
  it('is not run twice', async () => {
    const { host, cleanup } = await boot({ trust: { default: 'auto', peers: {}, blocked: [] } })
    try {
      const first = await sendMessage(host, { text: 'do the thing', messageId: 'msg-fixed' })
      await waitFor(async () => (await getTask(host, first.id)).status.state === 'TASK_STATE_COMPLETED', 'first')
      assert.equal(host.created.length, 1)

      // The sender's outbox retries the same message on the same thread.
      const again = await sendMessage(host, {
        text: 'do the thing',
        messageId: 'msg-fixed',
        contextId: first.contextId,
      })
      assert.equal(again.status.state, 'TASK_STATE_COMPLETED')
      assert.equal(host.created.length, 1, 'a duplicate must not start another run')
      assert.equal(host.resumed.length, 0)
    } finally {
      cleanup()
    }
  })
})

describe('work done for another Principal', () => {
  const readJournal = (workspace) =>
    readFileSync(join(workspace, '.iflow', 'edge', 'origin.ndjson'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

  it('is journaled as delegated across a boundary, and handed back rather than finished', async () => {
    const { workspace, host, cleanup } = await boot({ trust: { default: 'auto', peers: {}, blocked: [] } })
    try {
      const task = await sendMessage(host, { text: 'please analyse this', from: 'peer-a' })
      await waitFor(async () => (await getTask(host, task.id)).status.state === 'TASK_STATE_COMPLETED', 'task')
      await waitFor(
        () => readJournal(workspace).some((e) => e.type === 'delivery.submitted'),
        'the delivery to be journaled',
      )
      const journal = readJournal(workspace)
      const of = (type) => journal.find((e) => e.type === type)

      // The delegation states the crossing rather than leaving it to be
      // inferred. Only this side knows: the request came from another node.
      const delegated = of('task.delegated')
      assert.ok(delegated, 'a remote request was not journaled as a delegation')
      assert.equal(delegated.payload.crossesOwnershipBoundary, true)
      assert.equal(delegated.payload.fromAgentId, 'peer-a')

      // Handed back, not finished. `task.completed` here would let this node
      // rule on work it did for somebody else.
      assert.ok(of('delivery.submitted'), 'the answer was not journaled as a delivery')
      assert.equal(of('task.completed'), undefined, 'the executor declared its own work accepted')
      assert.equal(of('delivery.accepted'), undefined, 'nobody ruled, yet an acceptance exists')
    } finally {
      await cleanup()
    }
  })

  it('carries a digest of the answer as evidence, and not the answer', async () => {
    const { workspace, host, cleanup } = await boot({ trust: { default: 'auto', peers: {}, blocked: [] } })
    try {
      const task = await sendMessage(host, { text: 'summarise the confidential file' })
      await waitFor(async () => (await getTask(host, task.id)).status.state === 'TASK_STATE_COMPLETED', 'task')
      await waitFor(
        () => readJournal(workspace).some((e) => e.type === 'delivery.submitted'),
        'the delivery to be journaled',
      )
      const delivery = readJournal(workspace).find((e) => e.type === 'delivery.submitted')

      assert.equal(delivery.payload.evidence.length, 1)
      assert.match(delivery.payload.evidence[0], /^sha256:[0-9a-f]{64}$/)
      // The requester holds the text and can check it against this. Nobody else
      // learns anything from a digest.
      const answer = (await getTask(host, task.id)).artifacts?.[0]?.parts?.[0]?.text ?? ''
      assert.ok(answer.length > 0, 'the run produced no answer to check against')
      assert.equal(JSON.stringify(delivery).includes(answer), false, 'the answer itself was journaled')

      // The request text has the same problem from the other side. `task.*` and
      // `delivery.*` are publishable — unlike `conversation.*`, which the outbox
      // filter blocks structurally — so an excerpt in a title reaches the
      // Community just as surely as one in a summary.
      const journal = readJournal(workspace)
      for (const type of ['task.created', 'task.delegated', 'delivery.submitted']) {
        const fact = journal.find((e) => e.type === type)
        assert.ok(fact, `${type} was not journaled`)
        assert.equal(
          JSON.stringify(fact).includes('summarise the confidential file'),
          false,
          `${type} carries the request text`,
        )
      }
    } finally {
      await cleanup()
    }
  })
})

describe('one network message, one id', () => {
  it('keeps the sender’s messageId on the receiving machine', async () => {
    // Minting a fresh id here made the two ends unable to recognise the same
    // message: no cross-node deduplication, no pairing a reply with what it
    // answered, and no chance of two sessions being views of one thread.
    const { host, cleanup } = await boot({ trust: { default: 'auto', peers: {}, blocked: [] } })
    try {
      const task = await sendMessage(host, { text: 'analyse this', messageId: 'msg-from-the-sender' })
      await waitFor(async () => (await getTask(host, task.id)).status.state === 'TASK_STATE_COMPLETED', 'task')

      const handed = host.followups.at(-1)
      assert.ok(handed, 'nothing was handed to the local agent')
      assert.equal(handed.message.id, 'msg-from-the-sender', 'the receiving machine minted its own id')
    } finally {
      await cleanup()
    }
  })

  it('records that the far side wrote it, not this machine', async () => {
    // A peer's message landing as an ordinary local user turn is exactly
    // backwards, and it is what the read path used to infer from the type.
    const { host, cleanup } = await boot({ trust: { default: 'auto', peers: {}, blocked: [] } })
    try {
      const task = await sendMessage(host, { text: 'hello', from: 'if-lt-b' })
      await waitFor(async () => (await getTask(host, task.id)).status.state === 'TASK_STATE_COMPLETED', 'task')

      const marked = host.followups.at(-1)?.message?.iflow
      assert.ok(marked, 'no authorship was recorded')
      assert.equal(marked.side, 'peer')
      assert.equal(marked.authorLabel, 'if-lt-b')
      assert.equal(marked.represents, 'if-lt-b')
    } finally {
      await cleanup()
    }
  })

  it('marks a person on the far side as a person, still on the far side', async () => {
    // side and author answer different questions. A human message from the peer
    // is a human message AND a peer message; neither answer implies the other.
    const { host, cleanup } = await boot({ trust: { default: 'auto', peers: {}, blocked: [] } })
    try {
      const task = await sendMessage(host, {
        text: 'typed by a person over there',
        metadata: { contentOrigin: 'human' },
      })
      await waitFor(async () => (await getTask(host, task.id)).status.state === 'TASK_STATE_COMPLETED', 'task')

      const marked = host.followups.at(-1)?.message?.iflow
      assert.equal(marked.author, 'human')
      assert.equal(marked.side, 'peer')
    } finally {
      await cleanup()
    }
  })

  it('still accepts a peer that sends no id at all', async () => {
    // An older node, not a hostile one. It gets an id minted here rather than
    // being refused.
    const { host, cleanup } = await boot({ trust: { default: 'auto', peers: {}, blocked: [] } })
    try {
      const { json } = await host.post('/a2a', {
        jsonrpc: '2.0', id: 'r', method: 'SendMessage',
        params: {
          message: { role: 'ROLE_USER', parts: [{ text: 'no id here', mediaType: 'text/plain' }] },
          configuration: { returnImmediately: true },
          metadata: { from: 'old-peer' },
        },
      })
      await waitFor(async () => (await getTask(host, json.result.task.id)).status.state === 'TASK_STATE_COMPLETED', 'task')
      assert.match(host.followups.at(-1).message.id, /^(iflow-)?msg-/)
    } finally {
      await cleanup()
    }
  })
})
