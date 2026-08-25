import { defineTool } from '@deepseek-ai/dsh-tools'
import { canonicalBytes } from 'iflow-protocol'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { installIFlowEdge } from './edge/install.js'
import { clearCommunitySettings, loadCommunitySettings, saveCommunitySettings } from './edge/community-config.js'
import { installPanelRoutes } from './edge/panel.js'
import {
  agentDidsOf,
  agentHome,
  authorityHome,
  bindPrincipal as bindPrincipalIdentity,
  declareAgent as declareAgentIdentity,
  declarePrincipal as declarePrincipalIdentity,
  defaultPrincipalStoreRoot,
  homeForSigning,
  loadDeclarations,
  loadPrincipalRegistry,
  migrateLegacyPrincipal,
  planPrincipalMigration,
} from './identity/keyring.js'
import { PinMismatchError, didFingerprint, looksLikeDid, reconcileDid } from './identity/pinning.js'
import { helpAdvertises, missingCapabilities, staleBinaryAdvice } from './identity/capabilities.js'
import { relayDecision } from './relay/envelope.js'
import { createRelayTransport, startRelayPolling } from './relay/transport.js'
import {
  IntentEnvelopeError,
  LocalIntentQueue,
  startLocalIntentPolling,
} from './web/local-intents.js'
import { normalizeWebLoginCode, ownedAgentBindings, webChallengeSigningPayload } from './web/auth.js'
import { normalizeAction, validCapabilityId } from './a2a/capability.js'
import {
  TERMINAL_TASK_STATES,
  blocksToText,
  errorInfo,
  foldOutput,
  messageText,
  partsText,
  rpcException,
  rpcResult,
  taskText,
} from './a2a/protocol.js'
import { signingDigest, simpleHash } from './util/hash.js'
import {
  bindSession,
  loadConversations,
  markOutbound,
  pendingOutbound,
  recordOutbound,
  loadTrust,
  markSeen,
  messageDigest,
  newConversation,
  saveConversations,
  saveTrust,
  trustDecision,
} from './conversation/store.js'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const sourcePath = fileURLToPath(import.meta.url)

// iFlow — A2A bridge (Host half) — v18: P1 trust root.
// Bidirectional Agent2Agent (A2A) bridge for DeepSeek Harness.
// v21 retires the fixed 'iflow-mirror' session in favour of real Conversations:
// an inbound message is bound to an ordinary DSH session by conversationId, and
// a first contact waits for the operator to accept it before anything runs.
// v18 (P1 / V18): integrates the Rust trust root (iflow-id): AgentCard JWS
// (/.well-known/agent-card.signed.json), outbound request signing
// (X-IFlow-Signature envelope), and inbound verification + replay check.
// The shared Bearer token stays as bootstrap/compat; when a signature is
// present it is verified first (who wrote this, first time or replay).
export default {
  inject: ['tools', 'webServer', 'subprocess', 'sandboxPolicy', 'agents', 'agentDefaultModel', 'agentPresets', 'sessionTitle', 'sessions', 'fs', 'timer'],
  apply(ctx, config = {}) {
    const webServer = ctx.webServer
    const agents = ctx.agents
    const workspace = ctx.sandboxPolicy.workspaceRoot
    const principalStoreRoot = typeof config.principalStoreRoot === 'string' && config.principalStoreRoot.trim()
      ? config.principalStoreRoot.trim()
      : defaultPrincipalStoreRoot(join)
    const allowPeerUpdate = config.allowPeerUpdate === true
    // Writing into DSH's own session store is opt-in and, today, broken — see
    // `recordExchange`. The exchange is journaled either way.

    function makeAbortController() {
      const listeners = new Set()
      const signal = {
        aborted: false,
        reason: undefined,
        addEventListener(type, fn) { if (type === 'abort' && typeof fn === 'function') listeners.add(fn) },
        removeEventListener(type, fn) { if (type === 'abort') listeners.delete(fn) },
        throwIfAborted() { if (this.aborted) throw this.reason instanceof Error ? this.reason : new Error(String(this.reason)) },
      }
      return {
        signal,
        abort(reason) {
          if (signal.aborted) return
          signal.aborted = true
          signal.reason = reason === undefined ? new Error('Aborted') : reason
          const pending = [...listeners]
          listeners.clear()
          for (const fn of pending) { try { fn() } catch (e) { /* ignore */ } }
        },
      }
    }

    const state = {
      name: 'DSH Agent (iFlow)',
      description: 'A2A bridge exposing this DeepSeek Harness instance to other agents, ' +
        'letting remote DSH machines (or any A2A agent) delegate tasks here and use this machine\'s tools.',
      version: '1.0.0',
      syncVersion: '20',
      updatedAt: new Date().toISOString(),
      alias: 'if-lt',
      // Seeded from plugin config so a node can come up with auth already on;
      // `iflow_set_token` still changes it at runtime.
      token: typeof config.token === 'string' && config.token.length > 0 ? config.token : null,
      publicUrl: null,
      peers: new Map(),
      tasks: new Map(),
      outgoing: new Map(),
      // Threads, by conversationId, and the local session each is bound to.
      // Loaded from disk below; see src/conversation/store.ts for why this
      // lives where it does.
      conversations: {},
      trust: { default: 'ask', peers: {}, blocked: [] },
      // This node's own did:key, cached when the edge comes up so a
      // conversation participant can carry it without an await.
      nodeDid: null,
      // Stable owner/account identity. Never substituted with nodeDid.
      principalId: null,
      // The Community this node publishes to, which is also its relay. Cached
      // at edge start (and cleared when publishing stops) so the send path can
      // ask without reading a file mid-request.
      community: null,
      // did:key of every Agent an operator declared here, so the relay can be
      // told which Agents to route to this node.
      declaredAgentDids: {},
    }

    // Scratch files handed to the iflow-id binary (Windows argv has a length
    // limit, so bodies travel as files). They used to sit in the workspace ROOT
    // as .iflow-*-tmp.json, where they show up in the user's project and in
    // `git status`; they belong under .iflow with the rest of iFlow's state.
    const scratchDir = `${workspace}/.iflow/tmp`
    const scratchPath = (name) => {
      try { mkdirSync(scratchDir, { recursive: true }) } catch (e) { /* already there */ }
      return `${scratchDir}/${name}`
    }

    const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`
    const iso = () => new Date().toISOString()


    async function readSource() {
      try {
        const target = await ctx.fs.resolve(sourcePath)
        const text = await ctx.fs.readText(target)
        return { text, sha: simpleHash(text) }
      } catch (err) {
        return { text: null, sha: null }
      }
    }

    // ── offline mailbox: a persistent outbox/inbox queue so a message sent to
    // a peer that is currently unreachable is held and redelivered on a later
    // send attempt. Idempotent by (peer, prompt); deduped before enqueue. ──
    const mailboxFile = join(workspace, '.iflow', 'mailbox.json')
    async function loadMailbox() {
      try {
        const p = await ctx.fs.resolve(mailboxFile)
        const raw = await ctx.fs.readText(p)
        const data = JSON.parse(raw)
        return {
          outbox: Array.isArray(data.outbox) ? data.outbox : [],
          inbox: Array.isArray(data.inbox) ? data.inbox : [],
        }
      } catch (err) {
        return { outbox: [], inbox: [] }
      }
    }
    async function saveMailbox(mb) {
      try {
        const p = await ctx.fs.resolve(mailboxFile)
        await ctx.fs.writeText(p, JSON.stringify(mb, null, 2))
      } catch (err) { console.error('iFlow saveMailbox failed', err) }
    }
    async function enqueueOut(peer, prompt, thread = {}) {
      const mb = await loadMailbox()
      // Deduped by messageId when there is one. The old key was (peer, prompt),
      // which conflated two genuinely different things: asking the same
      // question twice on purpose, and one message queued twice by accident.
      const duplicate = thread.messageId
        ? mb.outbox.some((o) => o.messageId === thread.messageId)
        : mb.outbox.some((o) => o.peer === peer && o.prompt === prompt && o.state !== 'delivered')
      if (duplicate) return
      mb.outbox.push({
        id: uid('mbox'), peer, prompt, taskId: '',
        conversationId: thread.conversationId ?? null,
        messageId: thread.messageId ?? null,
        createdAt: Date.now(), attempts: 0, lastAttempt: 0, state: 'queued',
      })
      await saveMailbox(mb)
    }

    // ── peer registry persistence: registrations are DURABLE state (name/url/
    // token/addedAt), like OpenIM keeps users/friends in a durable store; the
    // runtime health fields (healthy/lastSeen) are EPHEMERAL and never written,
    // like OpenIM's Redis presence. Mirrors the mailbox.json pattern so the
    // registry survives restarts (and queued outbox items can be redelivered). ──
    const peersFile = join(workspace, '.iflow', 'peers.json')
    async function loadPeers() {
      try {
        const p = await ctx.fs.resolve(peersFile)
        const data = JSON.parse(await ctx.fs.readText(p))
        const map = new Map()
        for (const item of Array.isArray(data.peers) ? data.peers : []) {
          if (!item || typeof item.name !== 'string' || !item.name || typeof item.url !== 'string') continue
          map.set(item.name, {
            url: item.url,
            token: typeof item.token === 'string' && item.token.length > 0 ? item.token : null,
            // The peer's did:key, pinned on first sight. This is what a message
            // is sealed to, so it is the difference between end-to-end
            // encryption and the appearance of it: whoever can change this
            // value can read everything sent afterwards.
            did: typeof item.did === 'string' && item.did.length > 0 ? item.did : null,
            addedAt: typeof item.addedAt === 'string' ? item.addedAt : iso(),
          })
        }
        return map
      } catch (err) {
        return new Map()
      }
    }
    async function savePeers() {
      try {
        const p = await ctx.fs.resolve(peersFile)
        const peers = [...state.peers.entries()].map(([name, entry]) => ({
          name, url: entry.url, token: entry.token, did: entry.did ?? null, addedAt: entry.addedAt,
        }))
        await ctx.fs.writeText(p, JSON.stringify({ peers }, null, 2))
      } catch (err) { console.error('iFlow savePeers failed', err) }
    }
    // Load the persisted registry at boot; add/remove await this promise so the
    // first mutation never clobbers the on-disk list mid-load.
    const peersReady = loadPeers().then((map) => { state.peers = map }).catch(() => {})
    // Startup health probe: stamp in-memory healthy/lastSeen on each entry
    // (never persisted — presence is a snapshot, not an asset).
    async function probePeer(name, entry) {
      try {
        await curlGet(`${entry.url}/.well-known/agent-card.json`, 8, entry.token !== null ? entry.token : state.token)
        entry.healthy = true
      } catch (err) {
        entry.healthy = false
      }
      entry.lastSeen = Date.now()
    }
    peersReady.then(() => {
      for (const [name, entry] of state.peers) probePeer(name, entry)
    }).catch(() => {})

    // ── conversations: the thread a message belongs to, and the local session
    // it is bound to. Durable, like the peer registry, and for the same reason:
    // a restart must not turn an accepted peer back into a stranger, nor lose
    // which session a thread was already talking in. ──
    const conversationsReady = Promise.all([
      loadConversations(ctx, join, workspace).then((store) => { state.conversations = store.conversations }),
      loadTrust(ctx, join, workspace).then((trust) => { state.trust = trust }),
    ]).catch((err) => { console.error('iFlow: could not load conversation state', err) })

    async function persistConversations() {
      try {
        await saveConversations(ctx, join, workspace, { conversations: state.conversations })
      } catch (err) {
        console.error('iFlow saveConversations failed', err)
      }
    }

    /** How many threads are waiting for a person here. The badge reads this. */
    function pendingConversationCount() {
      return Object.values(state.conversations).filter((c) => c.state === 'pending').length
    }

    /**
     * One line on what became of the messages this node sent on a thread.
     *
     * Counted rather than listed: the useful question is whether anything is
     * still in the air, and a thread with forty delivered messages should not
     * print forty lines to answer it.
     */
    function summariseOutbound(conversation) {
      const sent = conversation.outbound ?? []
      if (sent.length === 0) return undefined
      const counts = {}
      for (const message of sent) counts[message.state] = (counts[message.state] ?? 0) + 1
      return Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(', ')
    }

    /** This node's own agent id in the network, matching the edge descriptor. */
    function selfAgentId() {
      return edgeHandle ? edgeHandle.edge.descriptor.selfAgentId : `node-${state.alias}`
    }

    /**
     * The thread this message belongs to, created on first sight.
     *
     * `conversationId` IS the A2A `contextId`. That field already exists on
     * both Message and Task, so a peer that predates any of this simply omits
     * it, gets one minted here, and never notices — no parallel header, no
     * version negotiation, no break.
     */
    function resolveConversation(conversationId, { peer, peerDid, preview, state: initial } = {}) {
      let conversation = state.conversations[conversationId]
      if (!conversation) {
        conversation = newConversation(conversationId, { peer, peerDid, preview, state: initial, now: iso() })
        state.conversations[conversationId] = conversation
      } else {
        if (peer && !conversation.peer) conversation.peer = peer
        if (peerDid && !conversation.peerDid) conversation.peerDid = peerDid
        conversation.updatedAt = iso()
      }
      return conversation
    }

    /** The two ends of a thread, as the domain models participants. */
    function participantsFor(conversation, initiator) {
      const mine = { agentId: selfAgentId(), did: state.nodeDid ?? undefined, role: 'recipient', joinedAt: iso() }
      const theirs = {
        agentId: conversation.peer ?? 'remote',
        did: conversation.peerDid ?? undefined,
        role: 'initiator',
        joinedAt: iso(),
      }
      if (initiator === 'self') {
        mine.role = 'initiator'
        theirs.role = 'recipient'
      }
      return [mine, theirs]
    }

    /**
     * Record one side of an agent-to-agent exchange.
     *
     * `side` is 'self' for this node's own turn and 'remote' for the peer's.
     *
     * THE MIRROR IS GONE. Until now this also wrote both sides into a single
     * fixed `iflow-mirror` DSH session so the exchange showed up in the host
     * UI. That was a second chat system, and it was the wrong shape twice
     * over: one global session and one global peer, when conversations are
     * many and point-to-point; and a round trip through DSH's private session
     * format, which rejected the file the plugin had just written —
     *
     *   invalid seed event at index 3: session event "assistant/message"
     *   is surface-eligible and requires a surfaceOp marker
     *
     * so it shipped disabled by default and stayed that way.
     *
     * A remote conversation now runs in a real DSH session, bound to its
     * conversationId, which the operator already sees in the ordinary session
     * list with the ordinary UI. There is nothing left for a mirror to show.
     *
     * What remains here are the two records, at two tiers: the local journal
     * entry that keeps the text, and the network-shaped `conversation.message_*`
     * fact that carries only a digest.
     */
    async function recordExchange(side, text, label, peer, thread = {}) {
      // The fact, first and unconditionally: it must not depend on a UI
      // integration being healthy.
      //
      // Written straight to the journal rather than through an observer method,
      // because the SDK has none for this — `a2a.message` is a type this
      // adapter defines. The domain's reducers ignore what they do not know, so
      // it lands in the journal and in Replay without disturbing any
      // projection, which is the right shape for a log of exchanges.
      //
      // TWO RECORDS, TWO TIERS. This one keeps the plaintext, because it is
      // this machine's own record of what it saw, and `edge/sync.ts` redacts
      // `text` before anything leaves. The network-shaped fact is the separate
      // `conversation.message_*` event below, which carries only a digest and
      // is therefore safe by construction rather than by redaction.
      if (edgeHandle) {
        try {
          await edgeHandle.edge.journal.record({
            type: 'a2a.message',
            subject: { kind: 'agent', id: peer || label },
            conversationId: thread.conversationId,
            payload: {
              direction: side === 'self' ? 'outbound' : 'inbound',
              peer: peer || null,
              label,
              conversationId: thread.conversationId ?? null,
              messageId: thread.messageId ?? null,
              // Free text, and the most revealing this node holds. It stays
              // here: `text` is redacted before anything is published.
              text,
            },
            evidence: { source: 'a2a' },
          })
        } catch (err) {
          console.error('iFlow: could not journal an A2A message', err && err.message ? err.message : err)
        }
      }

      if (thread.conversationId) {
        const shared = {
          conversationId: thread.conversationId,
          messageId: thread.messageId ?? uid('msg'),
          contentDigest: messageDigest(text),
          actorType: thread.actorType ?? 'agent',
          origin: thread.origin ?? (side === 'self' ? 'agent' : 'a2a'),
        }
        observeEdge('conversation.message', (observer) =>
          side === 'self'
            ? observer.conversationMessageSent({ ...shared, toAgentId: peer || 'remote' })
            : observer.conversationMessageReceived({ ...shared, fromAgentId: peer || 'remote' }),
        )
      }

    }

    async function curlRaw(method, url, payload, timeoutSec, token) {
      const argv = ['curl', '-sS', '-m', String(timeoutSec), '-X', method]
      if (method === 'POST') {
        argv.push('-H', 'Content-Type: application/json', '-H', 'A2A-Version: 1.0')
        if (token) argv.push('-H', `Authorization: Bearer ${token}`)
        const bodyText = JSON.stringify(payload)
        // M3: sign outbound requests to /a2a with the local trust root.
        // Best-effort — if iflow-id is unavailable or signing fails, the
        // request still goes out (token auth remains the fallback).
        if (/\/a2a\/?$/.test(url)) {
          try {
            const id = await getIdentity()
            if (id.did) {
              const path = url.replace(/^https?:\/\/[^/]+/, '')
              // Write the body to a temp file first: passing 30KB+ as an argv
              // element hits ENAMETOOLONG on Windows, so sign from file.
              const bodyPath = scratchPath('body.json')
              const resolvedBody = await ctx.fs.resolve(bodyPath)
              await ctx.fs.writeText(resolvedBody, bodyText)
              const envelope = await iflowId(['sign-file', method, path, bodyPath], 20)
              argv.push('-H', `X-IFlow-Signature: ${envelope.replace(/\n/g, ' ')}`)
            }
          } catch (e) { /* signing is best-effort */ }
        }
        argv.push('--data-binary', bodyText)
      } else if (token) {
        argv.push('-H', `Authorization: Bearer ${token}`)
      }
      argv.push(url)
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: workspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
        graceMs: 5000,
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
      const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
      if (outcome.exitCode !== 0) throw new Error(`iFlow outbound HTTP failed (exit ${String(outcome.exitCode)}): ${(stderr || stdout).slice(0, 400)}`)
      return stdout
    }

    async function curlPost(url, payload, timeoutSec, token) {
      return JSON.parse(await curlRaw('POST', url, payload, timeoutSec, token))
    }

    async function curlGet(url, timeoutSec, token) {
      return curlRaw('GET', url, undefined, timeoutSec, token)
    }

    // ── the relay: a way to reach a peer this machine cannot dial ──────────
    //
    // Two machines behind different NATs have no direct route. One leaves a
    // sealed envelope with the Community; the other collects it. The relay
    // carries the SAME signed request a direct POST would have carried, so
    // the receiving end verifies it identically — see src/relay/envelope.ts.
    const relay = createRelayTransport({
      iflowId,
      scratchPath,
      async readBytes(path) { return readFileSync(path) },
      async writeBytes(path, bytes) { writeFileSync(path, bytes) },
      async post(url, payload, token) { return curlPost(url, payload, 30, token) },
      async get(url, token) { return JSON.parse(await curlGet(url, 30, token)) },
      async identityHome(did) {
        const declarations = await loadDeclarations(ctx, join, workspace)
        return homeForSigning(join, workspace, declarations, { did }, state.nodeDid, principalStoreRoot)
      },
    })
    // Installed after identity/community state is ready. Reply handling above
    // closes over this reference so a Web-originated conversation can return a
    // private Browser View without creating a second response path.
    let webIntentQueue = null

    /**
     * The relay this node uses, or null.
     *
     * The Community and the relay are the same service and the same
     * credential, so being connected to one is being connected to the other.
     * A node that never published has no token and therefore no relay, which
     * is the right default: it also has nothing on the network to be reached
     * about.
     */
    function relaySettings() {
      const community = state.community
      if (!community || !community.url || !community.token) return null
      if (config.relay === false) return null
      return { url: community.url, token: community.token }
    }

    /**
     * Send one message the long way round.
     *
     * The request built here is byte-for-byte the one a direct POST would
     * have sent, signed the same way, and it is that whole thing — body plus
     * signature envelope — that gets sealed. The recipient runs the ordinary
     * verification on it. Nothing about arriving via the relay makes a message
     * more trusted, or differently trusted.
     */
    async function sendViaRelay({ peer, toDid, prompt, conversationId, messageId, fromAgent }) {
      const settings = relaySettings()
      if (!settings) return { ok: false, error: 'no relay configured' }
      // Said here rather than letting `iflow-id seal` fail with "unknown
      // command" three frames down, where it reads like a bug rather than an
      // upgrade someone has to do.
      if (!iflowIdSupports('seal')) {
        return {
          ok: false,
          error:
            'this node\'s identity binary predates sealed envelopes, so nothing can be sent through the relay. ' +
            `Delete ${join(IFI_BIN_DIR, IFI_BIN_NAME)} and run iflow_fetch_identity to get a current one.`,
        }
      }

      const fromDid = fromAgent?.did ?? state.nodeDid
      const request = {
        jsonrpc: '2.0',
        id: uid('req'),
        method: 'SendMessage',
        params: {
          message: {
            messageId,
            contextId: conversationId,
            role: 'ROLE_USER',
            parts: [{ text: prompt, mediaType: 'text/plain' }],
          },
          configuration: { returnImmediately: true, historyLength: 0 },
          metadata: {
            from: fromAgent?.agentId ?? state.alias,
            machine: await getMachineName(),
            conversationId,
            messageId,
            actorType: fromAgent ? 'agent' : 'human',
            origin: fromAgent ? 'web_intent' : 'keyboard',
            principalId: state.principalId ?? undefined,
            // So the recipient can tell how this arrived. It changes nothing
            // about verification; it is for the operator reading a thread.
            via: 'relay',
          },
        },
      }
      const body = JSON.stringify(request)

      // The same signature a direct POST would carry, over the same path, so
      // the far side's digest check lines up without a special case.
      let signature = null
      try {
        const id = fromAgent ? { did: fromAgent.did } : await getIdentity()
        if (id.did) {
          const bodyPath = scratchPath('relay-sign.json')
          await ctx.fs.writeText(await ctx.fs.resolve(bodyPath), body)
          const signingHome = fromAgent ? agentHome(join, workspace, fromAgent.agentId) : undefined
          signature = JSON.parse(
            await iflowId(['sign-file', 'POST', '/a2a', bodyPath], signingHome ?? 20, signingHome ? 20 : undefined),
          )
        }
      } catch (err) {
        // Signing is best-effort here exactly as it is on the direct path: an
        // unsigned message is degraded, and it is the recipient's trust policy
        // that decides what that is worth.
      }

      const sealed = await relay.seal({
        toDid,
        body,
        signature,
        conversationId,
        messageId,
        fromDid,
      })
      const answer = await relay.send({
        url: settings.url,
        token: settings.token,
        toDid,
        sealed,
        messageId,
        conversationId,
        fromDid,
      })
      if (answer && answer.state === 'queued') {
        const conversation = state.conversations[conversationId]
        if (conversation) {
          recordOutbound(conversation, { messageId, preview: prompt, now: iso() })
          void persistConversations()
        }
        return { ok: true }
      }
      return {
        ok: false,
        error:
          answer && answer.state === 'unreachable'
            ? `${peer} has never announced itself to the relay, so there is nowhere to leave this`
            : `relay refused: ${JSON.stringify(answer)}`,
      }
    }

    /**
     * Hand a collected envelope to the ordinary inbound path.
     *
     * This is the join: after unsealing there is a body and a signature
     * envelope, which is exactly what arriving over HTTP produces. The headers
     * are synthesised so `verifyInbound` sees what it always sees, and
     * `dispatch` is called unchanged.
     *
     * `replayWindow: false` is the one difference, and the only one — see the
     * note on `verifyInbound`.
     */
    async function deliverFromRelay(opened, envelope) {
      const headers = {}
      if (opened.signature) headers['x-iflow-signature'] = JSON.stringify(opened.signature)
      const verified = await verifyInbound({ headers }, opened.body, { replayWindow: false })
      if (!verified.ok) {
        throw new Error(`signature verification failed for ${envelope.id}: ${verified.error}`)
      }

      // Two kinds of thing arrive on this channel. A REQUEST has a `method`
      // and is dispatched exactly as an HTTP one would be. A RESPONSE is the
      // answer to something this node sent, and must not be dispatched — a
      // relay where every message provokes a message is a loop.
      let parsed
      try {
        parsed = JSON.parse(opened.body)
      } catch (err) {
        throw new Error(`relayed payload for ${envelope.id} is not JSON-RPC`)
      }

      if (parsed && typeof parsed.method === 'string') {
        await dispatch(opened.body, verified.did, verified.grant, {
          via: 'relay',
          // The answer goes back to whoever signed the request, not to whoever
          // the relay says handed it over.
          replyToDid: verified.did ?? envelope.from_did ?? null,
        })
        return
      }

      await acceptRelayedAnswer(parsed, envelope)
    }

    /**
     * An answer to something this node sent over the relay.
     *
     * Recorded on its conversation so the exchange is complete on both sides —
     * the local journal, the digest fact, and a line an operator can read. The
     * `iflow_send` that started it has already returned (a relayed send cannot
     * block for hours on a peer that has to be woken up and a human who has to
     * accept), so this is where the answer surfaces.
     */
    async function acceptRelayedAnswer(parsed, envelope) {
      const conversationId = envelope.conversation_id
      const peer = conversationId ? state.conversations[conversationId]?.peer : undefined

      if (parsed && parsed.error) {
        console.error(
          `iFlow relay: ${peer ?? envelope.from_did ?? 'a peer'} answered with an error on ` +
            `${conversationId ?? 'an unknown conversation'}: ${parsed.error.code} ${parsed.error.message}`,
        )
        return
      }

      const task = parsed && parsed.result ? parsed.result.task : undefined
      if (!task) throw new Error(`relayed answer for ${envelope.id} carries neither a task nor an error`)

      // The relay could tell us the envelope was collected. Only the answer can
      // say whether a person on the far side agreed to it, so that is settled
      // here and nowhere else.
      const conversation = conversationId ? state.conversations[conversationId] : undefined
      if (conversation && parsed.id) {
        const outcome = task.status?.state === 'TASK_STATE_REJECTED' ? 'rejected' : 'accepted'
        for (const sent of conversation.outbound ?? []) {
          if (sent.state === 'queued' || sent.state === 'delivered') markOutbound(conversation, sent.messageId, outcome, iso())
        }
        void persistConversations()
      }

      const text = taskText(task)
      if (text.length === 0) {
        console.log(
          `iFlow relay: ${peer ?? 'peer'} finished ${conversationId ?? ''} in ${task.status?.state} with no output`,
        )
        return
      }

      await recordExchange('remote', text, `[agent:${peer ?? envelope.from_did ?? 'remote'}]`, peer, {
        conversationId,
        messageId: envelope.id,
        actorType: 'agent',
        origin: 'a2a',
      })
      let deliveredToBrowser = false
      if (webIntentQueue && conversationId) {
        try {
          deliveredToBrowser = await webIntentQueue.deliverReply(conversationId, text, envelope.from_did ?? peer ?? 'unknown')
        } catch (error) {
          // Never attach reply text to an error/log. The local conversation
          // remains the recoverable source; Community is not a transcript.
          console.error(
            `iFlow Web Intent: could not deliver private reply for ${conversationId} (${error?.message ?? error})`,
          )
        }
      }
      if (deliveredToBrowser) {
        console.log(`iFlow relay: private answer delivered for ${conversationId}`)
      } else {
        console.log(`iFlow relay: answer on ${conversationId ?? 'a conversation'} from ${peer ?? 'a peer'}:
${text}`)
      }
    }

    /**
     * Send a finished task back to whoever asked for it over the relay.
     *
     * A direct request is answered on the connection it arrived on. A relayed
     * one has no connection, so the answer is sealed and posted back the same
     * way — as an ordinary JSON-RPC response carrying the same `id`, so the
     * far side can match it to what it sent.
     *
     * Best-effort and never throws: the work is done and journaled either way,
     * and a failure to deliver the answer must not undo it.
     */
    async function replyOverRelay(taskId) {
      const task = state.tasks.get(taskId)
      if (!task || !task.replyTo) return
      const settings = relaySettings()
      if (!settings) return
      if (!iflowIdSupports('seal')) return

      try {
        const body = JSON.stringify(rpcResult(task.replyTo.requestId, { task: snapshot(taskId, true) }))
        const messageId = uid('msg')
        const sealed = await relay.seal({
          toDid: task.replyTo.did,
          body,
          signature: null,
          conversationId: task.replyTo.conversationId,
          messageId,
          fromDid: state.nodeDid,
        })
        const answer = await relay.send({
          url: settings.url,
          token: settings.token,
          toDid: task.replyTo.did,
          sealed,
          messageId,
          conversationId: task.replyTo.conversationId,
          fromDid: state.nodeDid,
        })
        if (!answer || answer.state !== 'queued') {
          console.error(`iFlow relay: could not return the answer for ${taskId}: ${JSON.stringify(answer)}`)
        }
      } catch (err) {
        console.error(`iFlow relay: could not return the answer for ${taskId}`, err && err.message ? err.message : err)
      }
    }

    /** Which Agents this node can be reached about. */
    function relayRoster() {
      const roster = []
      if (state.nodeDid) roster.push({ did: state.nodeDid, label: state.alias, state: 'online' })
      for (const [agentId, did] of Object.entries(state.declaredAgentDids ?? {})) {
        if (did) roster.push({ did, label: agentId, state: 'online' })
      }
      return roster
    }

    // ── P1 trust root bridge: spawn the Rust `iflow-id` binary. The dynamic
    // sandbox has no Web Crypto, so all identity/signing/verification work is
    // delegated to the reference implementation. The binary belongs to this
    // plugin worktree; its store stays under <workspace>/.iflow so it remains
    // inside the sandbox's writable root. ──
    let iflowIdResolved = null
    // Why the last attempt failed, so a degraded node can say so instead of
    // repeating "binary not found" with no cause attached.
    let iflowIdFailure = null
    let iflowIdLastAttempt = 0
    // A download that failed because a proxy was down, or because the Release
    // had not been cut yet, must not disable signing for the life of the
    // process. Retry, but not on every call.
    const IFI_RETRY_MS = 5 * 60 * 1000

    /** The resolved binary's `help` output, or null before it was asked. */
    let iflowIdHelp = null
    // Smaller than any real build of the identity binary. A GitHub error page
    // is a few KB, which is exactly what this catches.
    const IFI_MIN_BYTES = 200 * 1024
    const IFI_BIN_NAME = process.platform === 'win32' ? 'iflow-id.exe' : 'iflow-id'
    // Where a downloaded binary is KEPT.
    //
    // Not inside the package. A package directory is replaced wholesale on
    // every upgrade — pnpm resolves a git dependency to a new content-addressed
    // directory each time — so a binary fetched into it is gone the next time
    // the plugin is updated, and the operator copies it in by hand again. Under
    // the workspace's own `.iflow` it survives upgrades, stays inside the
    // sandbox's writable root, and sits next to the identity store it belongs
    // to.
    const IFI_BIN_DIR = join(workspace, '.iflow', 'bin')
    // Where a binary may already BE, in priority order: an explicit override,
    // the download location, then a developer's local `cargo build` inside the
    // checkout. The last one is why a contributor never has to download
    // anything, and why a hand-copied binary still works.
    const IFI_SEARCH_PATHS = [
      process.env.IFLOW_ID_PATH,
      join(IFI_BIN_DIR, IFI_BIN_NAME),
      join(pluginRoot, 'rust', 'target', 'release', IFI_BIN_NAME),
    ].filter(Boolean)
    /**
     * Which Release asset belongs to this machine.
     *
     * Architecture is part of the answer, not a detail. Choosing on platform
     * alone sent every Linux an x86-64 binary — including every Raspberry Pi
     * and ARM cloud instance running Debian — where it downloaded fine, passed
     * a size check, and then failed to execute with a message about file
     * format that told nobody anything.
     *
     * An unsupported pair returns undefined rather than guessing. "There is no
     * build for linux/riscv64" is a sentence someone can act on; a binary that
     * cannot run is not.
     */
    const IFI_ASSETS = {
      'win32/x64': 'iflow-id-windows-amd64.exe',
      'darwin/arm64': 'iflow-id-darwin-arm64',
      'darwin/x64': 'iflow-id-darwin-amd64',
      'linux/x64': 'iflow-id-linux-amd64',
      'linux/arm64': 'iflow-id-linux-arm64',
    }
    const IFI_ASSET = IFI_ASSETS[`${process.platform}/${process.arch}`]
    const IFI_BIN_URL = IFI_ASSET
      ? `https://github.com/Neo-Pz/dsh/releases/latest/download/${IFI_ASSET}`
      : undefined
    // One-click convenience: when the CI-built binary is missing (fresh npm/git
    // install), fetch it from the GitHub Release. Best-effort; local installs
    // that already have the binary never reach this. Errors fall through to the
    // existing "binary not found" path.
    //
    // THIS IS THE ONLY FETCH. There used to be a `prepare` hook that did the
    // same thing at install time, and it was deleted for three independent
    // reasons: pnpm >= 10 keys build-script approval by the resolved commit, so
    // every upgrade from a git ref needed a fresh `allowBuilds` entry and the
    // hook mostly never ran; its own comment admitted as much; and it chose the
    // asset by platform alone, so Apple Silicon and ARM Linux were handed
    // x86-64 binaries — the exact bug the arch-aware map above exists to avoid.
    // A second, staler copy of this logic was worse than none.
    /**
     * curl arguments for reaching the Release from this machine.
     *
     * `-f` is not optional: without it GitHub's 404 page is written to the
     * destination and curl still exits 0, leaving a "binary" that is HTML. The
     * node then fails as a corrupt identity rather than as a download that did
     * not happen, which is a much harder thing to diagnose.
     *
     * The proxy is passed explicitly rather than left to the environment. DSH
     * may have been started from a shell that never had those variables, and on
     * a network where GitHub is not directly reachable that is the whole
     * difference between a signing node and a silently UNSIGNED one.
     */
    function curlFetchArgs(dest, url) {
      const proxy =
        process.env.HTTPS_PROXY || process.env.https_proxy ||
        process.env.HTTP_PROXY || process.env.http_proxy ||
        process.env.ALL_PROXY || process.env.all_proxy
      const argv = ['curl', '-fsSL', '--retry', '3', '--retry-delay', '2', '-m', '180', '-o', dest, url]
      if (proxy) argv.push('--proxy', proxy)
      return argv
    }

    /**
     * Copy a binary found elsewhere into the durable location.
     *
     * Best-effort and silent on failure: this is an optimisation for the NEXT
     * upgrade, and the binary that was just found still works either way.
     */
    function adoptIflowIdBinary(from, to, { force = false } = {}) {
      try {
        // `force` is how a capable binary replaces a stale cached one. Without
        // it the cache is write-once, which is exactly what leaves an old copy
        // shadowing a newer build for the life of the install.
        if (!force && statSync(to).size >= IFI_MIN_BYTES) return
      } catch { /* not there yet, copy it */ }
      try {
        mkdirSync(IFI_BIN_DIR, { recursive: true })
        copyFileSync(from, to)
        if (process.platform !== 'win32') chmodSync(to, 0o755)
        console.log(`iFlow: kept a copy of the identity binary at ${to} so upgrades do not lose it`)
      } catch (err) {
        console.warn(`iFlow: could not keep a copy of the identity binary at ${to}:`, err && err.message ? err.message : err)
      }
    }

    /**
     * Download without curl.
     *
     * A minimal Debian or a slim container image frequently has no curl at all,
     * and "one-click install" that depends on an optional package is not one.
     * Node's own fetch has no proxy support, which is why curl is still tried
     * first — but no proxy is a milder problem than no downloader.
     */
    async function fetchWithNode(dest, url) {
      // curl was given `-m 180`; the fallback needs the same ceiling. A
      // download with no deadline can hold the edge's start-up open forever on
      // a network that accepts the connection and then says nothing.
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`)
      }
      writeFileSync(dest, Buffer.from(await response.arrayBuffer()))
    }

    async function fetchIflowIdBinary() {
      if (!IFI_BIN_URL) {
        iflowIdFailure =
          `no prebuilt identity binary is published for ${process.platform}/${process.arch}. ` +
          'Build it with `cargo build --release` in the plugin\'s rust/ directory and point ' +
          'IFLOW_ID_PATH at the result.'
        return false
      }
      try {
        // Ensure the target dir exists on every OS (Node's mkdirSync creates the
        // full parent chain; plain cmd/`mkdir` would not on Windows).
        mkdirSync(IFI_BIN_DIR, { recursive: true })
        const dest = join(IFI_BIN_DIR, IFI_BIN_NAME)

        let curlFailure = null
        try {
          const dl = ctx.subprocess.spawn({
            argv: curlFetchArgs(dest, IFI_BIN_URL),
            cwd: workspace,
            stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 256 * 1024 } },
            // Every other spawn here gives the child a grace period. Without one
            // a slow download can be torn down mid-write, leaving a truncated
            // file that still looks like a binary to the next check.
            graceMs: 5000,
          })
          const out = await dl.done
          const stderr = dl.collected.stderr ? dl.collected.stderr.readFrom(0).text : ''
          if (out.exitCode !== 0) {
            curlFailure = `curl exit ${String(out.exitCode)}: ${stderr.slice(0, 200) || IFI_BIN_URL}`
          }
        } catch (err) {
          // curl is not installed, or the host refused to spawn it.
          curlFailure = err && err.message ? err.message : String(err)
        }

        if (curlFailure) {
          try {
            await fetchWithNode(dest, IFI_BIN_URL)
          } catch (err) {
            iflowIdFailure =
              `download failed (${curlFailure}); the fallback also failed: ` +
              (err && err.message ? err.message : String(err))
            return false
          }
        }

        // Trust the file only after looking at it. A short file is an error page
        // or a truncated write, and installing it would turn a missing identity
        // into a corrupt one.
        let size = 0
        try {
          size = statSync(dest).size
        } catch {
          iflowIdFailure = `download reported success but wrote nothing to ${dest}`
          return false
        }
        if (size < IFI_MIN_BYTES) {
          iflowIdFailure = `downloaded ${size} bytes from ${IFI_BIN_URL}, too small to be the identity binary`
          return false
        }

        // Release assets arrive without the executable bit.
        if (process.platform !== 'win32') {
          try {
            chmodSync(dest, 0o755)
          } catch (err) {
            iflowIdFailure = `could not mark ${dest} executable: ${err && err.message ? err.message : String(err)}`
            return false
          }
        }

        iflowIdFailure = null
        console.log(`iFlow: fetched the identity binary (${size} bytes) to ${dest}`)
        return true
      } catch (err) {
        iflowIdFailure = `auto-fetch threw: ${err && err.message ? err.message : String(err)}`
        console.error('iFlow iflow-id auto-fetch failed', err)
        return false
      }
    }

    /**
     * Find the identity binary, fetching it once if it is missing.
     *
     * Only SUCCESS is cached. A failure used to be permanent for the life of the
     * process: a node that came up while the proxy was down stayed unsigned
     * until someone restarted DSH, and dropping the binary in by hand changed
     * nothing. The filesystem is now re-checked on every call — it is a stat —
     * and the download is retried on a cooldown.
     */
    async function resolveIflowId(force = false) {
      // `force` has to discard the cached answer, not just skip the download
      // cooldown. Otherwise the early return below fires first and
      // `iflow_fetch_identity` is a no-op on any node that already resolved
      // something — including one that settled for a binary too old to seal,
      // which is exactly the node whose operator is being told to run it.
      if (force) {
        iflowIdResolved = null
        iflowIdHelp = null
      }
      if (iflowIdResolved) return iflowIdResolved

      const cand = join(IFI_BIN_DIR, IFI_BIN_NAME)

      // Every binary this machine can see, in preference order.
      const present = []
      for (const candidate of IFI_SEARCH_PATHS) {
        try {
          const resolved = await ctx.subprocess.resolveExecutable(candidate)
          if (resolved && !present.includes(resolved)) present.push(resolved)
        } catch (e) { /* try the next location */ }
      }

      // Prefer one that can do everything this plugin needs, rather than
      // simply the first that exists. Otherwise a stale cached copy shadows a
      // freshly built one sitting right there in the checkout.
      for (const candidate of present) {
        const help = await probeIflowIdCommands(candidate)
        if (missingCapabilities(help).length === 0) {
          iflowIdResolved = candidate
          iflowIdHelp = help
          iflowIdFailure = null
          // Keep a copy where a plugin upgrade cannot reach, overwriting an
          // older one: that cache is the whole reason a capable binary might
          // otherwise be ignored.
          if (candidate !== cand) adoptIflowIdBinary(candidate, cand, { force: true })
          return iflowIdResolved
        }
      }

      // Something is here but it predates a command this plugin needs. Try for
      // a newer build before settling, on the same cooldown as a missing one.
      const now = Date.now()
      const mayFetch = force || iflowIdLastAttempt === 0 || now - iflowIdLastAttempt >= IFI_RETRY_MS
      if (mayFetch) {
        iflowIdLastAttempt = now
        try {
          if (await fetchIflowIdBinary()) {
            const downloaded = await ctx.subprocess.resolveExecutable(cand)
            if (downloaded) {
              iflowIdResolved = downloaded
              iflowIdHelp = await probeIflowIdCommands(downloaded)
              iflowIdFailure = null
              warnAboutMissingCapabilities(downloaded)
              return iflowIdResolved
            }
            iflowIdFailure = `downloaded to ${cand} but the host will not execute it`
          }
        } catch (e) {
          iflowIdFailure = `auto-fetch threw: ${e && e.message ? e.message : String(e)}`
        }
      }

      // A binary that cannot seal can still sign, verify, meter and issue
      // grants. Refusing to use it because the network is down would turn a
      // node that mostly works into one that does not work at all.
      if (present.length > 0) {
        iflowIdResolved = present[0]
        iflowIdHelp = await probeIflowIdCommands(present[0])
        iflowIdFailure = null
        warnAboutMissingCapabilities(present[0])
        return iflowIdResolved
      }

      iflowIdResolved = false
      return iflowIdResolved
    }

    /**
     * A binary's `help` output — printed by every version since the first, so
     * this works against one older than the idea of asking it anything.
     */
    async function probeIflowIdCommands(bin) {
      try {
        const handle = ctx.subprocess.spawn({
          argv: [bin, 'help'],
          cwd: workspace,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
          graceMs: 5000,
        })
        await handle.done
        return handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
      } catch (err) {
        // Unreadable help proves nothing, so it reads as "supports nothing" —
        // the safe way to be wrong about whether a feature is available.
        return ''
      }
    }

    function warnAboutMissingCapabilities(bin) {
      const missing = missingCapabilities(iflowIdHelp ?? '')
      if (missing.length === 0) return
      console.warn(staleBinaryAdvice(bin, join(IFI_BIN_DIR, IFI_BIN_NAME), missing))
    }

    /** Can the resolved binary do this? Answers false before one is resolved. */
    function iflowIdSupports(command) {
      return iflowIdHelp !== null && helpAdvertises(iflowIdHelp, command)
    }

    /**
     * Run the identity binary.
     *
     * `home` selects WHICH key acts. This node holds several: its own, the
     * Principal's, and one per declared Agent — each in its own directory,
     * because that is how the binary partitions its store. Omitted means the
     * node's own key, which is every caller that predates declared Agents.
     *
     * `--node-home` is always the workspace, whatever key is signing: the
     * revocation registry and the rate card describe this machine, not a key.
     * Without it, a grant revoked while acting as one Agent would still be
     * honoured while acting as another.
     */
    async function iflowId(args, homeOrTimeout, maybeTimeout) {
      // Two shapes, because the timeout argument predates the home one:
      //   iflowId(args, 20)            a longer timeout, node's own key
      //   iflowId(args, home)          another key, default timeout
      //   iflowId(args, home, 20)      both
      const home = typeof homeOrTimeout === 'string' ? homeOrTimeout : undefined
      const timeoutSec = typeof homeOrTimeout === 'number' ? homeOrTimeout : (maybeTimeout ?? 15)

      const bin = await resolveIflowId()
      if (!bin) {
        throw new Error(
          `iflow-id binary not found (looked in ${IFI_SEARCH_PATHS.join(', ')})` +
            (iflowIdFailure ? `: ${iflowIdFailure}` : '') +
            '. Run iflow_fetch_identity to retry now and see why.',
        )
      }
      const handle = ctx.subprocess.spawn({
        // --home selects the Node, Agent, legacy, or user-level Authority
        // store explicitly (the binary appends .iflow itself). --node-home
        // keeps revocations node-wide, whichever identity is signing.
        argv: [bin, '--home', home ?? workspace, '--node-home', workspace, ...args],
        cwd: workspace,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
        graceMs: 5000,
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
      const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
      if (outcome.exitCode !== 0) throw new Error(`iflow-id ${args[0]} failed (exit ${String(outcome.exitCode)}): ${(stderr || stdout).slice(0, 400)}`)
      return stdout.trim()
    }

    let identityCache = null
    async function getIdentity() {
      if (identityCache) return identityCache
      // `show --json` is a promised shape; the human output this used to scrape
      // with a regular expression was not.
      try {
        const parsed = JSON.parse(await iflowId(['show', '--json']))
        if (parsed && typeof parsed.did === 'string') {
          identityCache = { did: parsed.did, label: parsed.label ?? state.alias, present: true }
          return identityCache
        }
      } catch (e) { /* fall through */ }
      identityCache = { did: null, label: state.alias, present: false }
      return identityCache
    }

    async function ensureIdentity() {
      const id = await getIdentity()
      if (id.present) return id
      try {
        const out = await iflowId(['create', state.alias])
        const did = /did:\s+(did:key:\S+)/.exec(out)
        identityCache = { did: did ? did[1] : null, label: state.alias, present: !!did }
      } catch (e) {
        identityCache = { did: null, label: state.alias, present: false }
      }
      return identityCache
    }

    let machineName = null
    async function getMachineName() {
      if (machineName !== null) return machineName
      try {
        const handle = ctx.subprocess.spawn({
          argv: ['hostname'],
          cwd: workspace,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 1024 } },
          graceMs: 3000,
        })
        const outcome = await handle.done
        const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        machineName = outcome.exitCode === 0 && stdout.trim().length > 0 ? stdout.trim() : null
      } catch (err) {
        machineName = null
      }
      return machineName
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, A2A-Version, X-IFlow-Signature, X-IFlow-Grant',
    }

    function sendJson(res, status, obj, extraHeaders) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders, ...(extraHeaders || {}) })
      res.end(JSON.stringify(obj))
    }

    function readBody(req) {
      return new Promise((resolve, reject) => {
        const decoder = new TextDecoder('utf-8', { stream: true })
        let text = ''
        req.on('data', (chunk) => { text += decoder.decode(chunk) })
        req.on('end', () => { text += decoder.decode(); resolve(text) })
        req.on('error', reject)
      })
    }

    function authorized(req) {
      if (state.token === null) return true
      const header = req.headers['authorization']
      return typeof header === 'string' && header === `Bearer ${state.token}`
    }


    async function agentCard(hostHeader) {
      const base = (state.publicUrl || `http://${hostHeader}`).replace(/\/+$/, '')
      const card = {
        name: state.name,
        description: state.description,
        version: state.version,
        supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
        defaultInputModes: ['text/plain', 'application/json'],
        defaultOutputModes: ['text/plain', 'application/json'],
        skills: [{
          id: 'agent-task',
          name: 'Agent task execution',
          description: 'Runs a prompt as a full agent on this DSH instance with access to all of its local tools, then returns the final answer.',
          tags: ['agent', 'task', 'dsh', 'iflow'],
          examples: ['Inspect the workspace and summarize what it contains.', 'Run a command on this machine and report the output.'],
          inputModes: ['text/plain', 'application/json'],
          outputModes: ['text/plain', 'application/json'],
        }],
      }
      try {
        const id = await getIdentity()
        if (id.did) card.identity = { did: id.did }
      } catch (e) { /* no identity */ }
      return card
    }

    function setStatus(taskId, stateName, text) {
      const task = state.tasks.get(taskId)
      if (!task) return
      const wasTerminal = TERMINAL_TASK_STATES.has(task.status.state)
      task.status = { state: stateName, timestamp: iso() }
      if (text !== undefined) {
        task.status.message = { messageId: uid('msg'), role: 'ROLE_AGENT', parts: [{ text, mediaType: 'text/plain' }] }
      }
      // A request that arrived over the relay has no open connection to answer
      // on, so the answer has to be sent back the same way it came. Hooked here
      // rather than at each call site because a task reaches a terminal state
      // from several — completed by the agent, failed, cancelled, or rejected
      // by a person hours later — and a reply that only some of them send is
      // worse than none.
      if (task.replyTo && !wasTerminal && TERMINAL_TASK_STATES.has(stateName)) {
        void replyOverRelay(taskId)
      }
    }

    function snapshot(taskId, includeArtifacts) {
      const task = state.tasks.get(taskId)
      if (!task) return undefined
      const out = { id: task.id, contextId: task.contextId, status: task.status }
      if (includeArtifacts !== false && task.artifacts) out.artifacts = task.artifacts
      if (task.metadata) out.metadata = task.metadata
      return out
    }




    // ── P4 token metering: sum TokenUsage across a child's assistant messages.
    // DSH already emits per-message TokenUsage (input/output/cacheRead/
    // cacheWrite/reasoning, disjoint buckets) on assistant/message events, so
    // iFlow records what DSH produced rather than re-implementing counting. ──
    function collectTaskUsage(events) {
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
      for (const event of events) {
        if (event && event.type === 'assistant/message' && event.data && event.data.usage) {
          const u = event.data.usage
          usage.inputTokens += (u.inputTokens || 0)
          usage.outputTokens += (u.outputTokens || 0)
          usage.cacheReadTokens += (u.cacheReadTokens || 0)
          usage.cacheWriteTokens += (u.cacheWriteTokens || 0)
          usage.reasoningTokens += (u.reasoningTokens || 0)
        }
      }
      return usage
    }

    // Record one task's usage to the JSONL log via iflow-id. Best-effort and
    // never throws: metering must not break the task flow.
    async function recordTaskUsage(taskId, from, events, startedAt, model) {
      try {
        const usage = collectTaskUsage(events)
        const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
        if (total === 0) return // no provider usage → nothing meaningful to record
        const durationMs = Math.max(0, Date.now() - startedAt)
        await iflowId([
          'usage', 'record',
          taskId,
          from || 'unknown',
          model || 'unknown',
          String(usage.inputTokens),
          String(usage.outputTokens),
          '--cache-read', String(usage.cacheReadTokens),
          '--cache-write', String(usage.cacheWriteTokens),
          '--duration', String(durationMs),
        ], 20)
        console.log(`iFlow usage recorded task ${taskId}: ${total} tokens`)
      } catch (err) {
        // metering is best-effort; log but never fail the task
        try { console.error('iFlow usage record failed', err) } catch (e) { /* ignore */ }
      }
    }

    async function runChild(taskId, text, controller, from, thread = {}) {
      const startedAt = Date.now()
      const selection = ctx.agentDefaultModel.currentSelection()
      const agentOptions = selection && selection.provider && selection.model
        ? { provider: selection.provider, model: selection.model }
        : {}
      // Inbound remote agents must run under a restricted preset (workspace fs
      // only, no shell/subagents/web). This used to fall back to `standard`
      // when `remote-a2a` was missing — and it is missing on every DSH install
      // today, so every remote peer silently received the FULL local toolset
      // (fs/bash/pwsh/skill). That is a remote-code-execution surface, so the
      // path now fails closed: no restricted preset, no inbound execution.
      //
      // Two deliberate escapes, both explicit:
      //   config.inboundPreset            — name a different restricted preset
      //   config.allowUnrestrictedInbound — restore the old permissive behavior
      const wantedPreset = config.inboundPreset || 'remote-a2a'
      let presetId
      try {
        const preset = await ctx.agentPresets.resolve(wantedPreset)
        presetId = preset && preset.id ? preset.id : undefined
        // A resolve that answers without a usable id confines nothing, so it
        // is treated exactly like a missing preset rather than trusted.
        if (!presetId) throw new Error(`preset '${wantedPreset}' resolved without an id`)
      } catch (err) {
        if (config.allowUnrestrictedInbound !== true) {
          const detail = `No '${wantedPreset}' agent preset is installed, so this node cannot confine an inbound remote task. ` +
            `Install a restricted preset with that id, point config.inboundPreset at one, ` +
            `or set config.allowUnrestrictedInbound: true to accept the risk of granting remote peers the full local toolset.`
          console.error(`iFlow: refusing an inbound A2A task — ${detail}`)
          setStatus(taskId, 'TASK_STATE_REJECTED', detail)
          return
        }
        console.warn(
          `iFlow: '${wantedPreset}' preset missing and allowUnrestrictedInbound is on — ` +
          'this inbound remote task gets the full local toolset.',
        )
        try {
          const preset = await ctx.agentPresets.resolve('standard')
          presetId = preset && preset.id ? preset.id : undefined
        } catch (fallbackErr) {
          presetId = undefined
        }
      }
      setStatus(taskId, 'TASK_STATE_WORKING', 'Processing the request with a local agent.')
      await recordExchange('remote', text, `[agent:${from || 'remote'}]`, from, thread)

      // ── resolve the session this conversation talks in ─────────────────
      //
      // A Conversation is a durable thread; a Session is this runtime's
      // private container for it. The binding between them is what makes the
      // second message of a conversation land in a model that remembers the
      // first — before this, every inbound message got a fresh throwaway
      // session and the peer was talking to an amnesiac.
      //
      // The far side has its own session with its own id. Neither ever learns
      // the other's; only the conversationId is shared.
      const conversation = thread.conversationId ? state.conversations[thread.conversationId] : undefined
      const bound = conversation && conversation.binding ? conversation.binding.localSessionId : undefined
      const setup = async (agentCtx) => {
        // Mount the resolved preset inside the creation window so the child's
        // toolset is decided before it can run anything. Which preset that is
        // was settled above, and an unconfined child never gets this far
        // unless the operator explicitly allowed it. Resume takes the same
        // path: a resumed session is no less remote than a fresh one.
        if (presetId) await ctx.agentPresets.mount(agentCtx, presetId)
      }
      const meta = { cwd: workspace, origin: 'subagent', ...(presetId ? { agentPreset: presetId } : {}) }

      let handle
      let resumed = false
      if (bound && typeof agents.resume === 'function') {
        try {
          handle = await agents.resume({ resumeSessionId: bound, agentOptions, signal: controller.signal, setup })
          resumed = true
        } catch (err) {
          // The persisted session is gone — someone deleted it, or a store was
          // cleared. The Conversation outlives it: fall through and bind a new
          // one silently. Losing the thread because a local container was
          // tidied away would be the wrong lifetime for the wrong object.
          console.log(
            `iFlow: conversation ${thread.conversationId} lost its local session ${bound}; starting a new one`,
          )
        }
      }
      if (!handle) {
        const childId = `iflow-${uid('agent')}`
        try {
          handle = await agents.create({ sessionId: childId, meta, agentOptions, signal: controller.signal, setup })
        } catch (err) {
          if (controller.signal.aborted) setStatus(taskId, 'TASK_STATE_CANCELED', 'The task was canceled.')
          else setStatus(taskId, 'TASK_STATE_FAILED', `Failed to start the local agent: ${String(err && err.message ? err.message : err)}`)
          return
        }
        if (conversation) {
          bindSession(conversation, {
            runtime: 'dsh',
            workspaceId: workspace,
            localSessionId: handle.agent.session.id ?? childId,
            now: iso(),
          })
          void persistConversations()
        }
      }
      const child = handle.agent
      if (!resumed) {
        try {
          ctx.sessionTitle.rename(child.session, `iFlow · ${from || 'remote'}`)
        } catch (err) {
          console.error('iFlow rename failed', err)
        }
      }
      const onAbort = () => { try { child.cancel({ kind: 'parent' }) } catch (e) { /* ignore */ } }
      controller.signal.addEventListener('abort', onAbort)
      const stopTimeout = ctx.timeout(() => {
        controller.abort(new Error('iFlow task timed out after 10 minutes'))
      }, 10 * 60 * 1000)
      let outputBlocks = []
      try {
        child.followup({
          id: `iflow-${uid('msg')}`,
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
        await child.whenIdle()
        outputBlocks = foldOutput(child.session.events)
      } catch (err) {
        console.error(`iFlow task ${taskId} agent loop error`, err)
        setStatus(taskId, 'TASK_STATE_FAILED', `The local agent failed: ${String(err && err.message ? err.message : err)}`)
      } finally {
        controller.signal.removeEventListener('abort', onAbort)
        stopTimeout()
        try { await handle.dispose() } catch (err) { console.error('iFlow child dispose error', err) }
        state.outgoing.delete(taskId)
      }
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        const timedOut = reason && reason.message && String(reason.message).startsWith('iFlow task timed out')
        setStatus(taskId, timedOut ? 'TASK_STATE_FAILED' : 'TASK_STATE_CANCELED',
          timedOut ? 'The task timed out.' : 'The task was canceled.')
        // record any usage even on abort/cancel
        try { await recordTaskUsage(taskId, from, child.session.events, startedAt, (selection && selection.model) || undefined) } catch (e) { /* best-effort */ }
        return
      }
      const textOut = blocksToText(outputBlocks)
      if (textOut.length > 0) {
        const task = state.tasks.get(taskId)
        if (task) {
          task.artifacts = [{
            artifactId: `iflow-${uid('art')}`,
            name: 'result',
            description: 'Final answer produced by the local agent.',
            parts: [{ text: textOut, mediaType: 'text/plain' }],
          }]
        }
        setStatus(taskId, 'TASK_STATE_COMPLETED', 'The task completed successfully.')
        // The reply is this Agent speaking, on the same thread the request
        // arrived on, addressed back to whoever asked.
        await recordExchange('self', textOut, `[agent:${state.alias}]`, from, {
          conversationId: thread.conversationId,
          actorType: 'agent',
          origin: 'agent',
        })
      } else {
        setStatus(taskId, 'TASK_STATE_FAILED', 'The local agent produced no output.')
      }
      try { await recordTaskUsage(taskId, from, child.session.events, startedAt, (selection && selection.model) || undefined) } catch (e) { /* best-effort */ }
    }

    async function handleSendMessage(params, signerDid, grant, arrival) {
      const message = params && params.message ? params.message : undefined
      if (!message) throw rpcException(-32602, 'Invalid parameters', 'SendMessageRequest.message is required')
      const text = messageText(message)
      if (text.length === 0) throw rpcException(-32602, 'Invalid parameters', 'message.parts must contain at least one text or data part')
      const metadata = params && params.metadata && typeof params.metadata === 'object' ? params.metadata : {}
      const from = typeof metadata.from === 'string' && metadata.from.length > 0 ? metadata.from : undefined
      await conversationsReady
      const taskId = `iflow-${uid('task')}`

      // conversationId IS the A2A contextId.
      //
      // The field is already on Message and Task in the protocol, so a peer
      // that knows nothing about conversations omits it, gets one minted here,
      // and is not broken by any of this. `metadata.conversationId` is only a
      // fallback for a caller that sets metadata but not contextId.
      const conversationId =
        (typeof message.contextId === 'string' && message.contextId.length > 0 && message.contextId) ||
        (typeof metadata.conversationId === 'string' && metadata.conversationId.length > 0 && metadata.conversationId) ||
        `conv-${uid('c')}`
      const messageId =
        (typeof message.messageId === 'string' && message.messageId.length > 0 && message.messageId) ||
        (typeof metadata.messageId === 'string' && metadata.messageId.length > 0 && metadata.messageId) ||
        uid('msg')
      // Who produced the words. The network actor is always the Agent; this
      // says whether a person typed them or the Agent spoke on its own.
      const actorType = metadata.actorType === 'human' ? 'human' : 'agent'
      const origin = typeof metadata.origin === 'string' ? metadata.origin : 'a2a'

      const known = state.conversations[conversationId]
      const conversation = resolveConversation(conversationId, {
        peer: from,
        peerDid: signerDid,
        preview: text,
      })
      const firstSighting = !known
      // Redelivery from a sender's outbox must not inject the same message
      // twice. The signature envelope's nonce stops a replayed HTTP request;
      // this stops a legitimately re-sent one from being run again.
      const fresh = markSeen(conversation, messageId)
      if (firstSighting) {
        observeEdge('conversation.opened', (observer) =>
          observer.conversationOpened({
            conversationId,
            initiatedBy: from || 'remote',
            participants: participantsFor(conversation, 'remote'),
          }),
        )
      }

      // ── the acceptance gate ────────────────────────────────────────────
      //
      // This is a SECOND security layer, independent of the first. The
      // restricted `remote-a2a` preset answers "what may this peer's task
      // do once it runs". Nothing answered "does this peer get to make us
      // run anything at all" — so an unknown Agent could open sessions,
      // spend tokens and trigger tool approvals without anyone here ever
      // agreeing to talk to it. Message ACCEPTANCE and tool AUTHORIZATION
      // are different questions and both have to be asked.
      //
      // Default is `ask`. See src/conversation/store.ts for the policy.
      const decision = trustDecision(state.trust, { peerLabel: from, signerDid, conversation })
      const task = {
        id: taskId,
        contextId: conversationId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: iso() },
        artifacts: [],
        metadata: {
          from: from || 'remote',
          machine: typeof metadata.machine === 'string' && metadata.machine.length > 0 ? metadata.machine : null,
          prompt: text.slice(0, 400),
          receivedAt: iso(),
          conversationId,
          messageId,
          ...(signerDid ? { signerDid } : {}),
          ...(grant ? {
            grantId: grant.grantId,
            grantLevel: grant.level,
            grantAction: grant.action,
            grantDelegate: grant.delegate,
            grantCapabilities: grant.capabilities || [],
            grantIssuerRoot: grant.issuerRoot || null,
            grantRevocationGrace: grant.revocationGrace || 60,
          } : {}),
        },
      }
      // Where to send the answer, when there is no connection to answer on.
      if (arrival && arrival.via === 'relay' && arrival.replyToDid) {
        task.replyTo = { did: arrival.replyToDid, requestId: arrival.requestId, conversationId }
      }
      state.tasks.set(taskId, task)
      observeEdge('a2a.request_received', (observer) =>
        observer.a2aRequestReceived({
          remoteTaskId: taskId,
          fromLabel: from,
          fromDid: signerDid || undefined,
          grantRef: grant ? grant.grantId : undefined,
        }),
      )
      const configuration = params && params.configuration ? params.configuration : {}
      if (!fresh) {
        // Already handled. Answer with the task as it stands rather than
        // running the same request a second time.
        setStatus(taskId, 'TASK_STATE_COMPLETED', 'This message was already delivered on this conversation.')
        return { task: snapshot(taskId, true) }
      }

      if (decision === 'reject') {
        conversation.state = 'rejected'
        void persistConversations()
        if (firstSighting || known?.state !== 'rejected') {
          observeEdge('conversation.rejected', (observer) =>
            observer.conversationRejected({
              conversationId,
              rejectedBy: selfAgentId(),
              decidedBy: 'policy',
            }),
          )
        }
        // REJECTED is terminal, so the sender's poll loop ends immediately
        // rather than waiting out its timeout on an answer that will not come.
        setStatus(taskId, 'TASK_STATE_REJECTED', 'This node is not accepting conversations from that agent.')
        return { task: snapshot(taskId, true) }
      }

      if (decision === 'ask') {
        // Park it. No session, no model, no tools — nothing this peer sent
        // causes work here until a person says so. What is kept is the message
        // itself, so that accepting later delivers it rather than losing it.
        conversation.state = 'pending'
        conversation.pendingTask = { taskId, text, from: from ?? null, messageId, actorType, origin }
        conversation.preview = text.slice(0, 200)
        void persistConversations()
        // AUTH_REQUIRED is deliberately NOT terminal: the sender's existing
        // GetTask poll keeps waiting, and when someone here accepts, the task
        // moves on to WORKING and then COMPLETED with no change on their side.
        setStatus(
          taskId,
          'TASK_STATE_AUTH_REQUIRED',
          'Waiting for the operator of this node to accept the conversation.',
        )
        console.log(
          `iFlow: ${from || 'an unknown agent'} wants to start conversation ${conversationId}. ` +
          `Run iflow_conversations to accept or reject it.`,
        )
        return { task: snapshot(taskId, true) }
      }

      if (conversation.state === 'pending') {
        observeEdge('conversation.accepted', (observer) =>
          observer.conversationAccepted({ conversationId, acceptedBy: selfAgentId(), decidedBy: 'policy' }),
        )
      }
      if (firstSighting) {
        observeEdge('relation.recorded', (observer) =>
          observer.relationRecorded({
            sourceAgentId: selfAgentId(),
            targetAgentId: from || 'remote',
            type: 'contacted',
          }),
        )
      }
      conversation.state = 'active'
      void persistConversations()

      const controller = makeAbortController()
      state.outgoing.set(taskId, { controller, done: undefined })
      const done = runChild(taskId, text, controller, from, {
        conversationId,
        messageId,
        actorType,
        origin,
      })
      state.outgoing.get(taskId).done = done
      done.catch((err) => console.error(`iFlow task ${taskId} unhandled run error`, err))
      if (configuration.returnImmediately === true) return { task: snapshot(taskId, true) }
      await done.catch(() => {})
      return { task: snapshot(taskId, true) }
    }

    /**
     * Let a parked conversation through.
     *
     * The message that was held is delivered now, on the task the sender is
     * still polling: AUTH_REQUIRED → WORKING → COMPLETED, with nothing to
     * change on their side. That is the whole reason the gate uses a
     * non-terminal state instead of failing the request and asking them to
     * try again.
     */
    async function acceptConversation(conversationId, { decidedBy = 'human' } = {}) {
      await conversationsReady
      const conversation = state.conversations[conversationId]
      if (!conversation) return { ok: false, error: `unknown conversation: ${conversationId}` }
      if (conversation.state !== 'pending') {
        return { ok: false, error: `conversation ${conversationId} is ${conversation.state}, not pending` }
      }
      conversation.state = 'accepted'
      const parked = conversation.pendingTask
      conversation.pendingTask = null
      await persistConversations()

      observeEdge('conversation.accepted', (observer) =>
        observer.conversationAccepted({ conversationId, acceptedBy: selfAgentId(), decidedBy }),
      )
      observeEdge('relation.recorded', (observer) =>
        observer.relationRecorded({
          sourceAgentId: selfAgentId(),
          targetAgentId: conversation.peer || 'remote',
          type: 'contacted',
        }),
      )

      if (!parked) return { ok: true, conversationId, state: 'accepted', delivered: false }

      // The sender may already have given up waiting; the task object may also
      // be gone after a restart. Either way the conversation is now accepted,
      // so their next message goes straight through.
      const task = state.tasks.get(parked.taskId)
      if (!task) return { ok: true, conversationId, state: 'accepted', delivered: false }

      conversation.state = 'active'
      await persistConversations()
      const controller = makeAbortController()
      state.outgoing.set(parked.taskId, { controller, done: undefined })
      const done = runChild(parked.taskId, parked.text, controller, parked.from ?? undefined, {
        conversationId,
        messageId: parked.messageId,
        actorType: parked.actorType,
        origin: parked.origin,
      })
      state.outgoing.get(parked.taskId).done = done
      done.catch((err) => console.error(`iFlow task ${parked.taskId} unhandled run error`, err))
      return { ok: true, conversationId, state: 'active', delivered: true, taskId: parked.taskId }
    }

    async function rejectConversation(conversationId, reason) {
      await conversationsReady
      const conversation = state.conversations[conversationId]
      if (!conversation) return { ok: false, error: `unknown conversation: ${conversationId}` }
      conversation.state = 'rejected'
      const parked = conversation.pendingTask
      conversation.pendingTask = null
      await persistConversations()
      observeEdge('conversation.rejected', (observer) =>
        observer.conversationRejected({
          conversationId,
          rejectedBy: selfAgentId(),
          decidedBy: 'human',
          reason,
        }),
      )
      // Terminal, so whoever is polling stops now instead of timing out.
      if (parked && state.tasks.has(parked.taskId)) {
        setStatus(parked.taskId, 'TASK_STATE_REJECTED', reason || 'The operator declined this conversation.')
      }
      return { ok: true, conversationId, state: 'rejected' }
    }

    function handleGetTask(params) {
      const taskId = params && typeof params.id === 'string' ? params.id : undefined
      if (!taskId || !state.tasks.has(taskId)) throw rpcException(-32001, 'Task not found', errorInfo('TASK_NOT_FOUND'))
      return { task: snapshot(taskId, true) }
    }

    async function handleCancelTask(params) {
      const taskId = params && typeof params.id === 'string' ? params.id : undefined
      const task = taskId ? state.tasks.get(taskId) : undefined
      if (!task) throw rpcException(-32001, 'Task not found', errorInfo('TASK_NOT_FOUND'))
      if (TERMINAL_TASK_STATES.has(task.status.state)) throw rpcException(-32002, 'Task is not cancelable', errorInfo('TASK_NOT_CANCELABLE'))
      const entry = state.outgoing.get(taskId)
      if (entry) {
        entry.controller.abort(new Error('canceled by client'))
        await entry.done.catch(() => {})
      } else {
        setStatus(taskId, 'TASK_STATE_CANCELED', 'The task was canceled.')
      }
      return { task: snapshot(taskId, true) }
    }

    function handleListTasks(params) {
      const filter = params && typeof params.status === 'string' ? params.status : undefined
      const pageSize = params && Number.isInteger(params.pageSize) && params.pageSize >= 1 ? Math.min(params.pageSize, 100) : 50
      const includeArtifacts = params && typeof params.includeArtifacts === 'boolean' ? params.includeArtifacts : false
      let tasks = [...state.tasks.values()]
      if (filter) tasks = tasks.filter((t) => t.status.state === filter)
      tasks.sort((a, b) => (b.status.timestamp < a.status.timestamp ? -1 : b.status.timestamp > a.status.timestamp ? 1 : 0))
      const page = tasks.slice(0, pageSize)
      return { tasks: page.map((t) => snapshot(t.id, includeArtifacts)), nextPageToken: '', pageSize, totalSize: tasks.length }
    }

    async function dispatch(body, signerDid, grant, arrival) {
      let request
      try {
        request = JSON.parse(body)
      } catch (err) {
        return rpcError(null, -32700, 'Invalid JSON payload')
      }
      if (typeof request !== 'object' || request === null || Array.isArray(request)) return rpcError(null, -32600, 'Request payload validation error')
      const { id, method, params } = request
      if (id === undefined) return null
      if (typeof method !== 'string' || method.length === 0) return rpcError(id, -32600, 'Request payload validation error')
      try {
        switch (method) {
          case 'SendMessage': return rpcResult(id, await handleSendMessage(params, signerDid, grant, arrival && { ...arrival, requestId: id }))
          case 'GetTask': return rpcResult(id, handleGetTask(params))
          case 'CancelTask': return rpcResult(id, await handleCancelTask(params))
          case 'ListTasks': return rpcResult(id, handleListTasks(params))
          case 'GetExtendedAgentCard': throw rpcException(-32004, 'Unsupported operation', errorInfo('UNSUPPORTED_OPERATION'))
          default: return rpcError(id, -32601, 'Method not found')
        }
      } catch (err) {
        if (err && typeof err.rpcCode === 'number') return rpcError(id, err.rpcCode, err.message, err.rpcData)
        console.error(`iFlow rpc ${method} error`, err)
        return rpcError(id, -32603, `Internal error: ${String(err && err.message ? err.message : err)}`)
      }
    }

    const cardHandler = async (req, res) => {
      try {
        if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); res.end(); return }
        if (req.method !== 'GET') { sendJson(res, 405, rpcError(null, -32600, 'Method not allowed')); return }
        const host = req.headers.host || `localhost:${webServer.port}`
        sendJson(res, 200, await agentCard(host), { 'Cache-Control': 'max-age=300' })
      } catch (err) {
        console.error('iFlow card handler error', err)
        try { sendJson(res, 500, rpcError(null, -32603, 'Internal error')) } catch (e) { /* client gone */ }
      }
    }

    // ── M2: signed AgentCard (JWS). Serves the canonical card signed by the
    // local trust root — a peer can verify "this capability list was indeed
    // published by the issuer" via `iflow-id agentcard-verify`. ──
    let signedCardCache = { at: 0, value: null }
    async function signedAgentCard(hostHeader) {
      const age = Date.now() - signedCardCache.at
      if (signedCardCache.value && age < 300_000) return signedCardCache.value
      try {
        const id = await ensureIdentity()
        if (!id.did) { signedCardCache = { at: Date.now(), value: { ok: false, error: 'no identity' } }; return signedCardCache.value }
        const card = await agentCard(hostHeader)
        const tmp = scratchPath('card.json')
        const resolved = await ctx.fs.resolve(tmp)
        await ctx.fs.writeText(resolved, JSON.stringify(card))
        const jwsText = await iflowId(['agentcard-sign', tmp], 20)
        const jws = JSON.parse(jwsText)
        const signed = { ok: true, card, jws }
        signedCardCache = { at: Date.now(), value: signed }
        return signed
      } catch (err) {
        signedCardCache = { at: Date.now(), value: { ok: false, error: String(err && err.message ? err.message : err) } }
        return signedCardCache.value
      }
    }

    const signedCardHandler = async (req, res) => {
      try {
        if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); res.end(); return }
        if (req.method !== 'GET') { sendJson(res, 405, rpcError(null, -32600, 'Method not allowed')); return }
        const host = req.headers.host || `localhost:${webServer.port}`
        const signed = await signedAgentCard(host)
        if (!signed.ok) { sendJson(res, 501, rpcError(null, -32603, `Signed AgentCard unavailable: ${signed.error}`)); return }
        sendJson(res, 200, { card: signed.card, jws: signed.jws }, { 'Cache-Control': 'max-age=300' })
      } catch (err) {
        console.error('iFlow signed card handler error', err)
        try { sendJson(res, 500, rpcError(null, -32603, 'Internal error')) } catch (e) { /* client gone */ }
      }
    }

    // ── P1 verification: when the caller attached an X-IFlow-Signature
    // envelope, verify it (signature + signer did + body digest + nonce/TS
    // replay window) and record the signer on the task. Missing/invalid
    // signature falls back to the shared token for bootstrap/compat.
    // ── P2 delegation: when the caller also attached an X-IFlow-Grant
    // authorization (a signed delegation grant), verify it against the
    // signer did and the action scope/level, and surface the level. ──
    /**
     * @param options.replayWindow  enforce the nonce's 300-second freshness
     *   window. True for anything that arrived over HTTP, where a request
     *   outside the window is a replay. FALSE for a message collected from the
     *   relay, where it is simply old: store-and-forward exists so a message
     *   can wait for a machine that was off for a week, and a five-minute
     *   window would reject exactly the messages the relay is for.
     *
     *   Nothing else is relaxed — the Ed25519 signature and the body digest
     *   are checked identically on both paths. What replaces the window is
     *   duplicate suppression by message id, in two independent places: the
     *   relay's `INSERT OR IGNORE`, and `markSeen` on the conversation. A
     *   relay redelivering an envelope therefore cannot cause a second run,
     *   which is the property the window was protecting.
     */
    async function verifyInbound(req, body, { replayWindow = true } = {}) {
      const header = req.headers['x-iflow-signature']
      if (!header || typeof header !== 'string' || header.length === 0) return { ok: true, did: null }
      let envelope
      try { envelope = JSON.parse(header) } catch (e) { return { ok: false, did: null, error: 'bad envelope json' } }
      if (!envelope || typeof envelope !== 'object' || !envelope.signature || !envelope.signer) return { ok: false, did: null, error: 'incomplete envelope' }
      try {
        const envPath = scratchPath('env.json')
        const resolved = await ctx.fs.resolve(envPath)
        await ctx.fs.writeText(resolved, JSON.stringify(envelope))
        await iflowId(['verify', envPath], 20)
        const sig = envelope.body_sha256
        if (typeof sig === 'string' && sig.length > 0 && sig !== signingDigest(body)) {
          return { ok: false, did: envelope.signer, error: 'body digest mismatch' }
        }
        if (replayWindow && typeof envelope.nonce === 'string' && typeof envelope.timestamp === 'number') {
          await iflowId(['replay-check', envelope.nonce, String(envelope.timestamp)], 20)
        }
        // P2 delegation: optional grant header → full authorization check.
        let grant = null
        const grantHeader = req.headers['x-iflow-grant']
        if (grantHeader && typeof grantHeader === 'string' && grantHeader.length > 0) {
          grant = await verifyGrantHeader(grantHeader, envelope.signer, req, body)
          if (grant && grant.ok === false) return { ok: false, did: envelope.signer, error: `delegation rejected: ${grant.reason}` }
        }
        return { ok: true, did: envelope.signer, grant }
      } catch (err) {
        return { ok: false, did: envelope.signer, error: String(err && err.message ? err.message : err) }
      }
    }

    // ── P2: parse an X-IFlow-Grant header, verify it against the signer did and
    // the current action. The header carries a JSON DelegationGrant plus an
    // optional "action" capability ID and "level" required for this request.
    // Best-effort delegation: a missing grant is fine (L0), a present-but-invalid
    // one rejects. V20: action is a namespace-prefixed capability ID, and the
    // full check (root-strength + capabilities + check-at-use revocation) runs
    // in `grant eval`. ──
    async function verifyGrantHeader(grantHeader, signerDid, req, body) {
      let payload
      try { payload = JSON.parse(grantHeader) } catch (e) { return { ok: false, reason: 'bad grant json' } }
      const grant = payload && payload.grant ? payload.grant : payload
      if (!grant || !grant.body || !grant.signature || !grant.grant_id) return { ok: false, reason: 'incomplete grant' }
      // The grant must be issued BY the signer (a human authorizes their agent),
      // unless the signer IS the grant's delegate (the agent acts for itself).
      const isIssuer = grant.body.issuer === signerDid
      const isDelegate = grant.body.delegate === signerDid
      if (!isIssuer && !isDelegate) return { ok: false, reason: `signer ${signerDid} is neither grant issuer nor delegate` }
      // The action must be a namespace-prefixed capability ID (ruling #2: no
      // bare free-form, to defend against collisions/forged declarations).
      const rawAction = payload.action || 'agent-task'
      const action = normalizeAction(rawAction)
      if (!validCapabilityId(action)) return { ok: false, reason: `invalid capability action: ${rawAction}` }
      const level = payload.level || 'L0'
      const now = Math.floor(Date.now() / 1000)
      const grantPath = scratchPath('grant.json')
      const resolved = await ctx.fs.resolve(grantPath)
      await ctx.fs.writeText(resolved, JSON.stringify(grant))
      await iflowId(['grant', 'verify', grantPath], 20)
      // Full delegation check: signature, id, expiry, root-strength vs level,
      // capabilities/deny scope, and check-at-use revocation (Reg-L).
      await iflowId(['grant', 'eval', grantPath, action, level, String(now)], 20)
      const capabilities = Array.isArray(grant.body.capabilities)
        ? grant.body.capabilities.map((c) => (c && typeof c.id === 'string' ? c.id : '')).filter(Boolean)
        : []
      return {
        ok: true,
        grantId: grant.grant_id,
        level: grant.body.level,
        action,
        delegate: grant.body.delegate,
        capabilities,
        issuerRoot: grant.body.issuer_root && grant.body.issuer_root.kind ? grant.body.issuer_root.kind : null,
        revocationGrace: grant.body.revocation_grace || 60,
      }
    }

    // Ruling #2: a capability ID must be a namespace-prefixed `iflow.cap:<domain>.<op>`
    // (or `*` / a `ns.*` wildcard); bare free-form is rejected.

    // Map the V19 default action to the V20 baseline capability ID.

    // Pure JS SHA-256 hex (FIPS 180-4) for body digest comparison — the
    // dynamic sandbox has no Web Crypto, and we only need the digest here.

    const a2aHandler = async (req, res) => {
      try {
        if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); res.end(); return }
        if (req.method !== 'POST') { sendJson(res, 405, rpcError(null, -32600, 'Method not allowed')); return }
        if (!authorized(req)) { sendJson(res, 401, rpcError(null, -32000, 'Unauthorized')); return }
        const body = await readBody(req)
        const verified = await verifyInbound(req, body)
        if (!verified.ok) { sendJson(res, 401, rpcError(null, -32000, `Signature verification failed: ${verified.error}`)); return }
        const response = await dispatch(body, verified.did, verified.grant)
        if (response === null) { res.writeHead(204, corsHeaders); res.end(); return }
        sendJson(res, 200, response)
      } catch (err) {
        console.error('iFlow a2a handler error', err)
        try { sendJson(res, 500, rpcError(null, -32603, `Internal error: ${String(err && err.message ? err.message : err)}`)) } catch (e) { /* client gone */ }
      }
    }

    const versionHandler = async (req, res) => {
      try {
        if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); res.end(); return }
        if (req.method !== 'GET') { sendJson(res, 405, rpcError(null, -32600, 'Method not allowed')); return }
        if (!authorized(req)) { sendJson(res, 401, rpcError(null, -32000, 'Unauthorized')); return }
        const src = await readSource()
        sendJson(res, 200, {
          name: state.name,
          version: state.syncVersion,
          updatedAt: state.updatedAt,
          source: sourcePath,
          sha: src.sha,
          size: src.text ? src.text.length : 0,
        })
      } catch (err) {
        console.error('iFlow version handler error', err)
        try { sendJson(res, 500, rpcError(null, -32603, 'Internal error')) } catch (e) { /* client gone */ }
      }
    }

    const latestHandler = async (req, res) => {
      try {
        if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); res.end(); return }
        if (req.method !== 'GET') { sendJson(res, 405, rpcError(null, -32600, 'Method not allowed')); return }
        if (!authorized(req)) { sendJson(res, 401, rpcError(null, -32000, 'Unauthorized')); return }
        const src = await readSource()
        if (!src.text) { sendJson(res, 404, rpcError(null, -32603, 'source file not found')); return }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders })
        res.end(src.text)
      } catch (err) {
        console.error('iFlow latest handler error', err)
        try { sendJson(res, 500, rpcError(null, -32603, 'Internal error')) } catch (e) { /* client gone */ }
      }
    }

    ctx.effect(() => webServer.register({ kind: 'exact', path: '/a2a', handler: a2aHandler }))
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/.well-known/agent-card.json', handler: cardHandler }))
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/.well-known/agent.json', handler: cardHandler }))
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/.well-known/agent-card.signed.json', handler: signedCardHandler }))
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/iflow/version.json', handler: versionHandler }))
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/iflow/latest.js', handler: latestHandler }))

    function resolvePeer(input) {
      if (typeof input !== 'string' || input.length === 0) return undefined
      const named = state.peers.get(input)
      if (named) return { url: named.url, token: named.token !== null ? named.token : state.token }
      if (/^https?:\/\//i.test(input)) return { url: input.replace(/\/+$/, ''), token: state.token }
      return undefined
    }



    async function sleep(ms) { await ctx.timeout(ms) }

    const peerItem = {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', required: true },
        url: { type: 'string', required: true },
        tokenSet: { type: 'boolean', required: true },
        healthy: { type: 'boolean' },
        lastSeen: { type: 'integer' },
        did: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
    }

    // `render` must be pure and replay-safe, so this is a plain formatter over
    // the value the tool already returned.
    function renderWarnings(warnings) {
      if (!Array.isArray(warnings) || warnings.length === 0) return ''
      return `\n\nwarnings:\n${warnings.map((w) => `  ! ${w}`).join('\n')}`
    }

    const tools = [
      defineTool({
        name: 'iflow_status',
        description: 'iFlow: show the local A2A endpoint (AgentCard and JSON-RPC URLs), auth state, registered peers, sync version, conversations (and how many are waiting for you to accept), and active inbound tasks.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              name: { type: 'string' },
              version: { type: 'string' },
              syncVersion: { type: 'string' },
              alias: { type: 'string' },
              machine: { type: 'string' },
              host: { type: 'string' },
              port: { type: 'integer' },
              publicUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              agentCard: { type: 'string' },
              rpcEndpoint: { type: 'string' },
              updateEndpoint: { type: 'string' },
              conversations: { type: 'integer' },
              conversationsPending: { type: 'integer' },
              authEnabled: { type: 'boolean' },
              peers: { type: 'array', items: peerItem },
              activeTasks: { type: 'integer' },
              warnings: { type: 'array', items: { type: 'string' } },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: `iFlow local endpoint:\n  AgentCard: ${value.agentCard}\n  JSON-RPC: ${value.rpcEndpoint}\n  update source: ${value.updateEndpoint}\n  syncVersion: ${value.syncVersion}\n  conversations: ${value.conversations} (${value.conversationsPending} waiting for you)\n  alias: ${value.alias}\n  machine: ${value.machine}\n  auth: ${value.authEnabled ? 'enabled' : 'off'}\n  peers: ${value.peers.map((p) => `${p.name} → ${p.url}${p.healthy === undefined ? '' : p.healthy ? ' (online)' : ' (offline)'}`).join('; ') || 'none'}\n  active inbound tasks: ${value.activeTasks}${renderWarnings(value.warnings)}`,
          }],
        },
        async execute() {
          const base = state.publicUrl || `http://127.0.0.1:${webServer.port}`
          await conversationsReady
          const threads = Object.values(state.conversations)
          // Refresh each peer's reachability so the report is current, not stale.
          for (const [name, entry] of state.peers) await probePeer(name, entry)

          // Surface the secrets sitting in the clear. These files are excluded
          // from git, but an exclusion is not encryption, and an operator who
          // never opens .iflow/ has no other way to learn this.
          const warnings = []
          const identity = await getIdentity()
          if (identity.present) {
            warnings.push('.iflow/identity.json holds this node\'s Ed25519 private key unencrypted (storage: plaintext-dev). Treat the workspace as secret material.')
          }
          if ([...state.peers.values()].some((entry) => entry.token !== null)) {
            warnings.push('.iflow/peers.json stores peer bearer tokens in plaintext.')
          }
          if (webServer.host === '0.0.0.0') {
            warnings.push(
              'This node binds 0.0.0.0, so its A2A and projection endpoints are reachable from the LAN' +
              (state.token === null ? ' WITH NO BEARER TOKEN SET.' : '.'),
            )
          }

          return {
            warnings,
            ok: true,
            name: state.name,
            version: state.version,
            syncVersion: state.syncVersion,
            alias: state.alias,
            machine: await getMachineName(),
            host: webServer.host,
            port: webServer.port,
            publicUrl: state.publicUrl,
            agentCard: `${base}/.well-known/agent-card.json`,
            rpcEndpoint: `${base}/a2a`,
            updateEndpoint: `${base}/iflow/version.json`,
            conversations: threads.length,
            conversationsPending: threads.filter((c) => c.state === 'pending').length,
            authEnabled: state.token !== null,
            peers: [...state.peers.entries()].map(([name, entry]) => ({ name, url: entry.url, tokenSet: entry.token !== null, healthy: entry.healthy, lastSeen: entry.lastSeen, did: entry.did ?? null })),
            activeTasks: [...state.tasks.values()].filter((t) => !TERMINAL_TASK_STATES.has(t.status.state)).length,
          }
        },
      }),

      defineTool({
        name: 'iflow_set_alias',
        description: 'iFlow: set this machine\'s display alias (a remark name, not the hostname), attached to outbound SendMessage metadata so the remote can name its incoming sessions (e.g. "iFlow · <alias>"). Default "if-lt".',
        parameters: {
          alias: { type: 'string', required: true, description: 'Display alias, e.g. if-lt or if-dsk.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              alias: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `iFlow alias → ${value.alias}` }],
        },
        async execute(args) {
          state.alias = typeof args.alias === 'string' && args.alias.trim().length > 0 ? args.alias.trim() : 'if-lt'
          return { ok: true, alias: state.alias }
        },
      }),

      defineTool({
        name: 'iflow_add_peer',
        description: 'iFlow: register a remote A2A endpoint (typically another DSH machine running iFlow) so it can be called by name. Pass the base URL of the remote web server, e.g. http://192.168.1.20:3080. Optionally set the same shared token configured on the remote (iflow_set_token there).',
        parameters: {
          name: { type: 'string', required: true, description: 'Local alias for the peer.' },
          url: { type: 'string', required: true, description: 'Base URL of the remote DSH web server, e.g. http://192.168.1.20:3080.' },
          token: { type: 'string', description: 'Optional Bearer token the remote requires; defaults to the local shared token when unset.' },
          did: { type: 'string', description: "The peer's did:key, if you have checked it out of band. Pins it now instead of trusting the first one seen on the wire." },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              name: { type: 'string', required: true },
              url: { type: 'string', required: true },
              tokenSet: { type: 'boolean', required: true },
              did: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              error: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.ok
              ? `peer ${value.name} → ${value.url} (${value.tokenSet ? 'token set' : 'no token'})` +
                (value.did ? `
  identity pinned: ${didFingerprint(value.did)}` : '')
              : `iFlow: ${value.error}`,
          }],
        },
        async execute(args) {
          await peersReady
          const name = args.name.trim()
          const url = args.url.trim().replace(/\/+$/, '')
          let did = null
          if (typeof args.did === 'string' && args.did.length > 0) {
            if (!looksLikeDid(args.did)) return { ok: false, name, url, tokenSet: false, error: `not a did:key: ${args.did}` }
            did = args.did
          }
          state.peers.set(name, { url, token: typeof args.token === 'string' && args.token.length > 0 ? args.token : null, did, addedAt: iso() })
          await savePeers()
          probePeer(name, state.peers.get(name))
          return { ok: true, name, url, tokenSet: state.peers.get(name).token !== null, did }
        },
      }),

      defineTool({
        name: 'iflow_list_peers',
        description: 'iFlow: list registered remote peers (name, base URL, whether a token is set).',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              peers: { type: 'array', items: peerItem, required: true },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.peers.length === 0 ? 'no peers registered' : value.peers.map((p) => `- ${p.name} → ${p.url}${p.tokenSet ? ' (token)' : ''}${p.healthy === undefined ? '' : p.healthy ? ' (online)' : ' (offline)'}`).join('\n'),
          }],
        },
        async execute() {
          return {
            ok: true,
            peers: [...state.peers.entries()].map(([name, entry]) => ({ name, url: entry.url, tokenSet: entry.token !== null, healthy: entry.healthy, lastSeen: entry.lastSeen, did: entry.did ?? null })),
          }
        },
      }),

      defineTool({
        name: 'iflow_conversations',
        description:
          'iFlow: see conversations with other agents and answer the ones waiting on you. ' +
          'A first message from an unknown agent is held — no session, no model, no tools — until you accept it here. ' +
          'Actions: list (default), accept, reject, trust (auto-accept a peer from now on), block.',
        parameters: {
          action: { type: 'string', description: "'list' | 'accept' | 'reject' | 'trust' | 'block'. Default 'list'." },
          conversationId: { type: 'string', description: 'Which conversation to accept or reject.' },
          peer: { type: 'string', description: 'Peer name or did:key, for trust and block.' },
          reason: { type: 'string', description: 'Optional reason recorded with a rejection.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              conversations: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    conversationId: { type: 'string' },
                    peer: { type: 'string' },
                    state: { type: 'string' },
                    preview: { type: 'string' },
                    boundSession: { type: 'string' },
                    sent: { type: 'string' },
                    updatedAt: { type: 'string' },
                  },
                },
              },
              conversationId: { type: 'string' },
              state: { type: 'string' },
              delivered: { type: 'boolean' },
              taskId: { type: 'string' },
              trust: { type: 'string' },
              error: { type: 'string' },
            },
          },
          render: (args, value) => {
            if (!value.ok) return [{ type: 'text', text: `iFlow: ${value.error}` }]
            if (Array.isArray(value.conversations)) {
              if (value.conversations.length === 0) return [{ type: 'text', text: 'no conversations yet' }]
              const lines = value.conversations.map((c) => {
                const waiting = c.state === 'pending' ? '  ← waiting for you' : ''
                const quote = c.preview ? `\n    "${c.preview}"` : ''
                const sent = c.sent ? `\n    sent: ${c.sent}` : ''
                return `- ${c.conversationId}  ${c.peer ?? 'unknown'}  [${c.state}]${waiting}${quote}${sent}`
              })
              const pending = value.conversations.filter((c) => c.state === 'pending').length
              const hint = pending > 0
                ? `\n\n${pending} waiting. Accept with: iflow_conversations action=accept conversationId=…`
                : ''
              return [{ type: 'text', text: lines.join('\n') + hint }]
            }
            if (value.trust) return [{ type: 'text', text: `iFlow: ${args.peer} is now ${value.trust}` }]
            const tail = value.delivered ? ' — the held message is running now' : ''
            return [{ type: 'text', text: `iFlow: conversation ${value.conversationId} is ${value.state}${tail}` }]
          },
        },
        async execute(args) {
          await conversationsReady
          const action = args.action || 'list'

          if (action === 'list') {
            const conversations = Object.values(state.conversations)
              .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
              .map((c) => ({
                conversationId: c.conversationId,
                peer: c.peer ?? undefined,
                state: c.state,
                preview: c.preview || undefined,
                // Shown locally and only locally: this is the Runtime-private
                // half of the mapping and it never goes on the wire.
                boundSession: c.binding ? c.binding.localSessionId : undefined,
                // What became of what this node sent. Without it a relayed send
                // answers "RELAYED" and there is no way to ask again.
                sent: summariseOutbound(c),
                updatedAt: c.updatedAt,
              }))
            return { ok: true, conversations }
          }

          if (action === 'accept') {
            if (!args.conversationId) return { ok: false, error: 'accept needs a conversationId' }
            return await acceptConversation(args.conversationId, { decidedBy: 'human' })
          }

          if (action === 'reject') {
            if (!args.conversationId) return { ok: false, error: 'reject needs a conversationId' }
            return await rejectConversation(args.conversationId, args.reason)
          }

          if (action === 'trust' || action === 'block') {
            if (!args.peer) return { ok: false, error: `${action} needs a peer name or did:key` }
            if (action === 'trust') {
              state.trust.peers[args.peer] = 'auto'
              state.trust.blocked = state.trust.blocked.filter((d) => d !== args.peer)
            } else {
              delete state.trust.peers[args.peer]
              if (!state.trust.blocked.includes(args.peer)) state.trust.blocked.push(args.peer)
            }
            try {
              await saveTrust(ctx, join, workspace, state.trust)
            } catch (err) {
              return { ok: false, error: `could not save trust settings: ${String(err && err.message ? err.message : err)}` }
            }
            return { ok: true, trust: action === 'trust' ? 'auto-accepted' : 'blocked' }
          }

          return { ok: false, error: `unknown action: ${action}` }
        },
      }),

      defineTool({
        name: 'iflow_remove_peer',
        description: 'iFlow: remove a registered peer by name.',
        parameters: {
          name: { type: 'string', required: true, description: 'Alias of the peer to remove.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              name: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `peer ${value.name} ${value.ok ? 'removed' : 'not found'}` }],
        },
        async execute(args) {
          await peersReady
          const removed = state.peers.delete(args.name.trim())
          await savePeers()
          return { ok: removed, name: args.name.trim() }
        },
      }),

      defineTool({
        name: 'iflow_discover',
        description: 'iFlow: fetch the AgentCard of a peer (by registered name or base URL) to learn its identity, capabilities, interface, and skills.',
        parameters: {
          peer: { type: 'string', required: true, description: 'Registered peer name or a base URL like http://192.168.1.20:3080.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              name: { type: 'string' },
              description: { type: 'string' },
              version: { type: 'string' },
              interfaceUrl: { type: 'string' },
              protocolBinding: { type: 'string' },
              skills: { type: 'array', items: { type: 'string' } },
              did: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              didPinned: { type: 'string' },
              error: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.ok
              ? `AgentCard: ${value.name} v${value.version}\n  ${value.description}\n  interface: ${value.interfaceUrl} (${value.protocolBinding})\n  skills: ${value.skills.join(', ')}` +
                (value.did
                  ? `\n  identity: ${value.did}\n  fingerprint: ${didFingerprint(value.did)}` +
                    (value.didPinned === 'recorded'
                      ? '\n  pinned. Messages are sealed to this key from now on, and a peer presenting a different one is refused.'
                      : '\n  matches the key already pinned for this peer.')
                  : '\n  identity: none published — this peer cannot be sent sealed messages.')
              : `discovery failed: ${value.error}`,
          }],
        },
        async execute(args) {
          await peersReady
          const entry = resolvePeer(args.peer)
          if (!entry) return { ok: false, error: `unknown peer or invalid URL: ${args.peer}` }
          try {
            const text = await curlGet(`${entry.url}/.well-known/agent-card.json`, 15, entry.token)
            const card = JSON.parse(text)
            const iface = card.supportedInterfaces && card.supportedInterfaces.length > 0 ? card.supportedInterfaces[0] : {}
            // The DID used to be read off the card and dropped, which left
            // nothing on this machine able to seal a message for this peer.
            // This is the sighting TOFU is built on, so it is pinned here.
            const presented = card.identity && typeof card.identity.did === 'string' ? card.identity.did : null
            const registered = state.peers.get(args.peer)
            const settled = reconcileDid(args.peer, registered ? registered.did : null, presented)
            if (registered && settled.outcome === 'recorded') {
              registered.did = settled.did
              await savePeers()
            }
            return {
              ok: true,
              name: typeof card.name === 'string' ? card.name : entry.url,
              description: typeof card.description === 'string' ? card.description : '',
              version: typeof card.version === 'string' ? card.version : '',
              interfaceUrl: typeof iface.url === 'string' ? iface.url : `${entry.url}/a2a`,
              protocolBinding: typeof iface.protocolBinding === 'string' ? iface.protocolBinding : 'JSONRPC',
              skills: Array.isArray(card.skills) ? card.skills.map((s) => (s && typeof s.name === 'string' ? s.name : '')).filter(Boolean) : [],
              did: settled.did,
              didPinned: settled.outcome,
            }
          } catch (err) {
            // A changed key is not a network failure and must not read like
            // one: it is reported with the whole explanation attached.
            if (err instanceof PinMismatchError) return { ok: false, error: err.message }
            return { ok: false, error: `discovery failed: ${String(err && err.message ? err.message : err)}` }
          }
        },
      }),

      defineTool({
        name: 'iflow_update_check',
        description: 'iFlow: compare the local iFlow source with a peer\'s self-hosted update source (/iflow/version.json) and report whether they are in sync and whether a pull is available.',
        parameters: {
          peer: { type: 'string', required: true, description: 'Registered peer name or a base URL like http://192.168.1.20:3080.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              peer: { type: 'string' },
              localVersion: { type: 'string' },
              remoteVersion: { type: 'string' },
              localSha: { type: 'string' },
              remoteSha: { type: 'string' },
              inSync: { type: 'boolean' },
              canPull: { type: 'boolean' },
              error: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.ok
              ? (value.inSync
                ? `iFlow 两端同步 ✓ (v${value.localVersion}, sha ${value.localSha})`
                : `iFlow 不同步：本机 v${value.localVersion} (${value.localSha}) vs ${value.peer} v${value.remoteVersion} (${value.remoteSha}) — 可用 iflow_pull 拉取`)
              : `update check failed: ${value.error}`,
          }],
        },
        async execute(args) {
          const entry = resolvePeer(args.peer)
          if (!entry) return { ok: false, error: `unknown peer or invalid URL: ${args.peer}` }
          try {
            const text = await curlGet(`${entry.url}/iflow/version.json`, 15, entry.token)
            const remote = JSON.parse(text)
            const local = await readSource()
            const same = remote.version === state.syncVersion && remote.sha === local.sha
            return {
              ok: true,
              peer: args.peer,
              localVersion: state.syncVersion,
              remoteVersion: typeof remote.version === 'string' ? remote.version : '',
              localSha: local.sha,
              remoteSha: typeof remote.sha === 'string' ? remote.sha : '',
              inSync: same,
              canPull: allowPeerUpdate && !same,
            }
          } catch (err) {
            return { ok: false, peer: args.peer, error: `check failed: ${String(err && err.message ? err.message : err)}` }
          }
        },
      }),

      defineTool({
        name: 'iflow_pull',
        description: 'iFlow: pull the latest iFlow source from a peer\'s self-hosted update source (/iflow/latest.js) into this development worktree. Disabled for a release worktree; restart the plugin after a successful pull.',
        parameters: {
          peer: { type: 'string', required: true, description: 'Registered peer name or a base URL like http://192.168.1.20:3080.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              peer: { type: 'string' },
              version: { type: 'string' },
              sha: { type: 'string' },
              bytes: { type: 'integer' },
              path: { type: 'string' },
              error: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.ok
              ? `已从 ${value.peer} 拉取 iFlow v${value.version} (${value.bytes} bytes, sha ${value.sha}) → ${value.path}\n注意：新代码需重新加载插件才生效（动态: cordis_define + cordis_run；静态: 重新打包重启）`
              : `pull failed: ${value.error}`,
          }],
        },
        async execute(args) {
          const entry = resolvePeer(args.peer)
          if (!entry) return { ok: false, error: `unknown peer or invalid URL: ${args.peer}` }
          if (!allowPeerUpdate) return { ok: false, peer: args.peer, error: 'peer source updates are disabled for this release worktree; update the checked-out Git tag instead' }
          try {
            const text = await curlGet(`${entry.url}/iflow/latest.js`, 30, entry.token)
            const trimmed = text.trimStart()
            if (!trimmed.startsWith('import ') && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('return {')) {
              return { ok: false, peer: args.peer, error: `refused to write: /iflow/latest.js did not return JS source (got ${JSON.stringify(text.slice(0, 60))}…). The peer may not be upgraded to v10+.` }
            }
            const target = await ctx.fs.resolve(sourcePath)
            await ctx.fs.writeText(target, text)
            return {
              ok: true,
              peer: args.peer,
              version: state.syncVersion,
              sha: simpleHash(text),
              bytes: text.length,
              path: sourcePath,
            }
          } catch (err) {
            return { ok: false, peer: args.peer, error: `pull failed: ${String(err && err.message ? err.message : err)}` }
          }
        },
      }),

      defineTool({
        name: 'iflow_send',
        description: 'iFlow: send a task to a remote A2A agent (by registered peer name or base URL). The remote runs the prompt as a full agent with its own tools and returns its final answer. Waits for completion by default (polling GetTask); set waitForCompletion=false to just start the task.',
        parameters: {
          peer: { type: 'string', required: true, description: 'Registered peer name or a base URL like http://192.168.1.20:3080.' },
          prompt: { type: 'string', required: true, description: 'The task description to send to the remote agent.' },
          waitForCompletion: { type: 'boolean', description: 'Wait for the remote task to finish and return its answer. Default true.' },
          maxWaitSeconds: { type: 'integer', description: 'Cap on how long to wait for completion. Default 600 (10 minutes), max 3600.' },
          conversationId: { type: 'string', description: 'Continue an existing conversation with this peer. Omit to start a new one; use iflow_conversations to list them.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              peer: { type: 'string', required: true },
              taskId: { type: 'string' },
              conversationId: { type: 'string' },
              state: { type: 'string' },
              text: { type: 'string' },
              error: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.ok
              ? (value.taskId ? `remote task ${value.taskId} finished (${value.state}):\n${value.text}` : `remote message:\n${value.text}`)
              : `iFlow call failed: ${value.error}`,
          }],
        },
        async execute(args) {
          const entry = resolvePeer(args.peer)
          if (!entry) return { ok: false, peer: args.peer, error: `unknown peer or invalid URL: ${args.peer}` }
          const base = entry.url
          const token = entry.token
          await conversationsReady
          // Continue a named thread, or start one. Either way the id travels as
          // the A2A `contextId`, which is where a peer already looks for it.
          const conversationId =
            typeof args.conversationId === 'string' && args.conversationId.length > 0
              ? args.conversationId
              : `conv-${uid('c')}`
          const startingIt = !state.conversations[conversationId]
          const outbound = resolveConversation(conversationId, {
            peer: args.peer,
            preview: args.prompt,
            // A thread this node opens is one it has agreed to by opening it.
            state: 'accepted',
          })
          if (outbound.state === 'pending') outbound.state = 'accepted'
          const messageId = uid('msg')
          markSeen(outbound, messageId)
          void persistConversations()
          if (startingIt) {
            observeEdge('conversation.opened', (observer) =>
              observer.conversationOpened({
                conversationId,
                initiatedBy: selfAgentId(),
                participants: participantsFor(outbound, 'self'),
              }),
            )
            observeEdge('conversation.accepted', (observer) =>
              observer.conversationAccepted({
                conversationId,
                acceptedBy: selfAgentId(),
                decidedBy: 'policy',
              }),
            )
            observeEdge('relation.recorded', (observer) =>
              observer.relationRecorded({
                sourceAgentId: selfAgentId(),
                targetAgentId: args.peer,
                type: 'contacted',
              }),
            )
          }
          // A human typed this into a tool call; the Agent is what carries it
          // onto the network. Both facts are recorded, and they are different.
          const threadMeta = {
            conversationId,
            messageId,
            actorType: 'human',
            origin: 'keyboard',
          }
          const rpc = (method, params) => curlPost(`${base}/a2a`, { jsonrpc: '2.0', id: uid('req'), method, params }, 60, token)
          // Offline mailbox: before sending, redeliver any queued messages for
          // this peer. Best-effort; a still-unreachable peer leaves them queued.
          try {
            const mb = await loadMailbox()
            let dirty = false
            for (const item of mb.outbox) {
              if (item.peer !== args.peer || item.state !== 'queued') continue
              // Redeliver on the thread it was queued on, and with the SAME
              // messageId: the recipient suppresses a duplicate by that id, so
              // a retry can never inject the message twice.
              const r = await rpc('SendMessage', {
                message: {
                  messageId: item.messageId ?? uid('msg'),
                  ...(item.conversationId ? { contextId: item.conversationId } : {}),
                  role: 'ROLE_USER',
                  parts: [{ text: item.prompt, mediaType: 'text/plain' }],
                },
                configuration: { returnImmediately: true, historyLength: 0 },
                metadata: {
                  from: state.alias,
                  machine: await getMachineName(),
                  ...(item.conversationId ? { conversationId: item.conversationId } : {}),
                  ...(item.messageId ? { messageId: item.messageId } : {}),
                },
              })
              item.attempts += 1
              item.lastAttempt = Date.now()
              if (!r.error) item.state = 'delivered'
              dirty = true
            }
            if (dirty) await saveMailbox(mb)
          } catch (err) { /* mailbox flush is best-effort */ }
          let response
          try {
            response = await rpc('SendMessage', {
              // `contextId` is the conversation. A peer that understands it
              // continues the same thread in the same local session; one that
              // does not simply echoes it back on the Task, as A2A already
              // requires.
              message: {
                messageId,
                contextId: conversationId,
                role: 'ROLE_USER',
                parts: [{ text: args.prompt, mediaType: 'text/plain' }],
              },
              configuration: { returnImmediately: true, historyLength: 0 },
              metadata: {
                from: state.alias,
                machine: await getMachineName(),
                // Additive: an older peer ignores keys it does not know, so
                // none of this can break an existing bridge.
                conversationId,
                messageId,
                actorType: 'human',
                origin: 'keyboard',
                principalId: state.principalId ?? undefined,
              },
            })
          } catch (err) {
            // Not reachable from here. That is the normal case for two
            // machines behind different NATs, not an error — so before the
            // message goes into the local outbox to wait for a route that may
            // never appear, try the one that does not need one.
            const directError = String(err && err.message ? err.message : err)
            const registered = state.peers.get(args.peer)
            const decision = relayDecision({
              peer: registered,
              directError,
              relayConfigured: Boolean(relaySettings()),
            })
            if (decision.use) {
              try {
                const relayed = await sendViaRelay({
                  peer: args.peer,
                  toDid: registered.did,
                  prompt: args.prompt,
                  conversationId,
                  messageId,
                })
                if (relayed.ok) {
                  try { await recordExchange('self', args.prompt, `[agent:${state.alias}]`, args.peer, threadMeta) } catch (e) { /* best-effort */ }
                  return {
                    ok: true,
                    peer: args.peer,
                    taskId: '',
                    conversationId,
                    state: 'RELAYED',
                    text: '',
                    error: undefined,
                  }
                }
                // Fall through to the outbox with the relay's reason, which is
                // more useful than the direct one it replaced.
                try { await enqueueOut(args.peer, args.prompt, { conversationId, messageId }) } catch (e) { /* best-effort */ }
                return { ok: false, peer: args.peer, taskId: '', conversationId, state: 'QUEUED', error: `${decision.reason}, but the relay could not take it: ${relayed.error}` }
              } catch (relayErr) {
                try { await enqueueOut(args.peer, args.prompt, { conversationId, messageId }) } catch (e) { /* best-effort */ }
                return { ok: false, peer: args.peer, taskId: '', conversationId, state: 'QUEUED', error: `relay failed: ${String(relayErr && relayErr.message ? relayErr.message : relayErr)}` }
              }
            }
            // No relay available → hold the message in the persistent outbox.
            try { await enqueueOut(args.peer, args.prompt, { conversationId, messageId }) } catch (e) { /* best-effort */ }
            return { ok: false, peer: args.peer, taskId: '', conversationId, state: 'QUEUED', error: `peer offline; queued for redelivery. ${decision.reason}` }
          }
          if (response.error) return { ok: false, peer: args.peer, conversationId, error: `remote error ${response.error.code}: ${response.error.message}` }
          const result = response.result || {}
          const task = result.task
          try { await recordExchange('self', args.prompt, `[agent:${state.alias}]`, args.peer, threadMeta) } catch (e) { /* best-effort */ }
          const inbound = { conversationId, actorType: 'agent', origin: 'a2a' }
          if (!task) {
            const text = result.message ? partsText(result.message.parts) : ''
            if (text.length > 0) try { await recordExchange('remote', text, `[agent:${args.peer}]`, args.peer, inbound) } catch (e) { /* best-effort */ }
            return {
              ok: text.length > 0, peer: args.peer, taskId: '', conversationId, state: 'MESSAGE', text,
              ...(text.length === 0 ? { error: 'remote returned an empty message' } : {}),
            }
          }
          if (args.waitForCompletion === false) return { ok: true, peer: args.peer, taskId: task.id, conversationId, state: task.status.state, text: '' }
          if (TERMINAL_TASK_STATES.has(task.status.state)) {
            const text = taskText(task)
            if (text.length > 0) try { await recordExchange('remote', text, `[agent:${args.peer}]`, args.peer, inbound) } catch (e) { /* best-effort */ }
            return {
              ok: task.status.state === 'TASK_STATE_COMPLETED' && text.length > 0,
              peer: args.peer,
              taskId: task.id,
              conversationId,
              state: task.status.state,
              text,
              ...(text.length === 0 ? { error: `task ended in ${task.status.state} with no output` } : {}),
            }
          }
          const maxWait = Math.min(Math.max(Number(args.maxWaitSeconds) || 600, 1), 3600)
          const deadline = Date.now() + maxWait * 1000
          let stateName = task.status.state
          let finalTask = task
          while (!TERMINAL_TASK_STATES.has(stateName) && Date.now() < deadline) {
            await sleep(2000)
            try {
              const poll = await rpc('GetTask', { id: task.id })
              if (poll.error) return { ok: false, peer: args.peer, taskId: task.id, conversationId, state: stateName, error: `GetTask error ${poll.error.code}: ${poll.error.message}` }
              if (poll.result && poll.result.task) {
                finalTask = poll.result.task
                stateName = finalTask.status.state
              }
            } catch (err) {
              return { ok: false, peer: args.peer, taskId: task.id, conversationId, state: stateName, error: `GetTask failed: ${String(err && err.message ? err.message : err)}` }
            }
          }
          if (!TERMINAL_TASK_STATES.has(stateName)) {
            // Non-terminal at the deadline covers the case where the far side
            // parked this as a pending contact and nobody has answered yet.
            // The thread survives on both ends; only this wait gave up.
            const waiting = stateName === 'TASK_STATE_AUTH_REQUIRED'
            return {
              ok: false,
              peer: args.peer,
              taskId: task.id,
              conversationId,
              state: stateName,
              error: waiting
                ? `${args.peer} has not accepted this conversation yet; it is waiting for a person there. The conversation stays open — retry on conversationId ${conversationId}.`
                : `timed out waiting for task ${task.id}`,
            }
          }
          const text = taskText(finalTask)
          if (text.length > 0) try { await recordExchange('remote', text, `[${args.peer}]`, args.peer, inbound) } catch (e) { /* best-effort */ }
          return {
            ok: stateName === 'TASK_STATE_COMPLETED' && text.length > 0,
            peer: args.peer,
            taskId: task.id,
            conversationId,
            state: stateName,
            text,
            ...(text.length === 0 ? { error: `task ended in ${stateName} with no output` } : {}),
          }
        },
      }),

      defineTool({
        name: 'iflow_fetch_identity',
        description:
          'iFlow: retry fetching the iflow-id identity binary now and report what happened. ' +
          'Use this when the log says facts are being journaled UNSIGNED: without the binary this node ' +
          'has no key material, so its facts cannot be proven off-node.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              path: { type: 'string' },
              did: { type: 'string' },
              missing: { type: 'array', items: { type: 'string' } },
              error: { type: 'string' },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value.ok
                ? `iFlow identity ready: ${value.did ?? 'no identity created yet'} (${value.path})` +
                  ((value.missing ?? []).length > 0
                    ? `

But this binary cannot ${value.missing.join(' or ')}. ` +
                      'It is the newest one available, so re-fetching will not help: the Release ' +
                      'has not caught up with this plugin yet. Everything except the relay works.'
                    : '')
                : `iFlow identity unavailable: ${value.error}`,
            },
          ],
        },
        async execute() {
          // `force` skips the retry cooldown: a human asking for this has just
          // fixed whatever was broken and wants to know NOW, not in five
          // minutes.
          const bin = await resolveIflowId(true)
          if (!bin) return { ok: false, error: iflowIdFailure ?? 'the binary could not be resolved' }

          // Resolving is not the same as working. The Release has shipped a
          // binary older than the source before, and an old one prints the
          // human-readable form where this expects JSON — which surfaced as an
          // unsigned node rather than as a version mismatch. So prove it.
          try {
            identityCache = null
            const identity = await getIdentity()
            // Say what this binary cannot do, now, rather than letting the
            // person discover it when a relay send fails. `resolveIflowId`
            // already tried to fetch a newer one; if something is still
            // missing, no amount of re-running this will produce it, and
            // saying so is the difference between a fix and a loop.
            const missing = missingCapabilities(iflowIdHelp ?? '')
            return {
              ok: true,
              path: bin,
              ...(identity.did ? { did: identity.did } : {}),
              ...(missing.length > 0 ? { missing } : {}),
            }
          } catch (err) {
            return {
              ok: false,
              path: bin,
              error: `the binary at ${bin} did not answer 'show --json' as expected: ${err && err.message ? err.message : String(err)}`,
            }
          }
        },
      }),

      defineTool({
        name: 'iflow_set_token',
        description: 'iFlow: set (or clear, with an empty string) the shared Bearer token protecting this machine\'s A2A endpoint. All inbound requests must then send Authorization: Bearer <token>, and outbound calls automatically attach it. Set the SAME token on every peer for mutual auth.',
        parameters: {
          token: { type: 'string', required: true, description: 'Shared secret. Pass an empty string to clear auth.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              authEnabled: { type: 'boolean', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `iFlow auth ${value.authEnabled ? 'enabled' : 'disabled'}` }],
        },
        async execute(args) {
          state.token = typeof args.token === 'string' && args.token.length > 0 ? args.token : null
          return { ok: true, authEnabled: state.token !== null }
        },
      }),

      defineTool({
        name: 'iflow_set_public_url',
        description: 'iFlow: override the base URL advertised in the local AgentCard (e.g. a tunnel or LAN hostname). Pass an empty string to go back to deriving it from each request\'s Host header.',
        parameters: {
          url: { type: 'string', required: true, description: 'Public base URL, e.g. https://iflow.example.com. Empty string clears the override.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              publicUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `iFlow public URL ${value.publicUrl ? `→ ${value.publicUrl}` : 'cleared (Host header based)'}` }],
        },
        async execute(args) {
          state.publicUrl = typeof args.url === 'string' && args.url.trim().length > 0 ? args.url.trim().replace(/\/+$/, '') : null
          return { ok: true, publicUrl: state.publicUrl }
        },
      }),

      defineTool({
        name: 'iflow_identity',
        description: 'iFlow (P1 trust root): show the local did:key identity and, optionally, create one if missing. Also verifies a peer\'s signed AgentCard from /\.well-known/agent-card.signed.json to confirm it was published by that peer\'s declared did.',
        parameters: {
          action: { type: 'string', description: 'One of: status (default), ensure (create if missing), verifyPeer (peer name or base URL to verify its signed AgentCard).' },
          peer: { type: 'string', description: 'Peer name or base URL, required when action=verifyPeer.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              did: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              label: { type: 'string' },
              storage: { type: 'string' },
              created: { type: 'boolean' },
              verifiedPeer: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              peerDid: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              error: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.error
              ? `iflow identity: ${value.error}`
              : (value.verifiedPeer
                ? `peer ${value.verifiedPeer} signed AgentCard verified → ${value.peerDid || 'unknown did'}`
                : `iFlow identity: ${value.did || 'none'} (label ${value.label}, storage ${value.storage || 'n/a'})${value.created ? ' — created now' : ''}`),
          }],
        },
        async execute(args) {
          const action = typeof args.action === 'string' ? args.action : 'status'
          try {
            if (action === 'ensure') {
              const id = await ensureIdentity()
              if (!id.did) return { ok: false, did: null, label: state.alias, error: 'failed to create identity (iflow-id binary?)' }
              return { ok: true, did: id.did, label: id.label, storage: 'plaintext-dev', created: true }
            }
            if (action === 'verifyPeer') {
              const entry = resolvePeer(args.peer)
              if (!entry) return { ok: false, error: `unknown peer or invalid URL: ${args.peer}` }
              const text = await curlGet(`${entry.url}/.well-known/agent-card.signed.json`, 15, entry.token)
              const signed = JSON.parse(text)
              const jws = signed && signed.jws ? signed.jws : signed
              if (!jws || !jws.signer) return { ok: false, error: 'peer did not return a signed AgentCard (needs v18+)' }
              const tmp = scratchPath('peer-card.json')
              const resolved = await ctx.fs.resolve(tmp)
              await ctx.fs.writeText(resolved, JSON.stringify(jws))
              await iflowId(['agentcard-verify', tmp], 20)
              return { ok: true, verifiedPeer: args.peer, peerDid: typeof jws.signer === 'string' ? jws.signer : (jws.signer && jws.signer.did ? jws.signer.did : String(jws.signer)) }
            }
            const id = await getIdentity()
            if (!id.did) return { ok: false, did: null, label: state.alias, error: 'no identity yet (run action=ensure to create)' }
            return { ok: true, did: id.did, label: id.label, storage: 'plaintext-dev' }
          } catch (err) {
            return { ok: false, did: null, label: state.alias, error: String(err && err.message ? err.message : err) }
          }
        },
      }),

      defineTool({
        name: 'iflow_grant',
        description: 'iFlow (P2 delegation): issue, verify, eval, revoke, or check a delegation grant — a human\'s signed authorization that an agent may act on their behalf for a scoped set of capabilities up to a trust level (L0-L3). Levels: L0 dialogue/quote (pre-authorized), L1 transaction (auto within scope), L2 contract (grant + explicit flag), L3 major (human must authorize in person). V20: grants carry a namespace-prefixed capability set (iflow.cap:<domain>.<op>) and a signature-root strength that bounds the level (H1→L0, H2→L2, H3→L3); revoke records a check-at-use revocation.',
        parameters: {
          action: { type: 'string', required: true, description: 'One of: create | verify | eval | revoke | status.' },
          delegate: { type: 'string', description: 'Delegate did:key (required for create).' },
          scope: { type: 'string', description: 'Comma-separated business scope (optional for create), e.g. "dialogue,quote".' },
          capabilities: { type: 'string', description: 'Comma-separated namespace capability IDs (optional for create), e.g. "iflow.cap:agent.run,iflow.cap:fs.read".' },
          deny: { type: 'string', description: 'Comma-separated capability IDs to deny (optional for create).' },
          root: { type: 'string', description: 'Issuer root kind for create: agent-custodial | webauthn | hwkey | ca | kyc (caps the level; default agent-custodial = L0).' },
          issuerKind: { type: 'string', description: 'Issuer subject kind for create: agent | human (optional).' },
          nonce: { type: 'string', description: 'Fresh challenge bound to the signing moment (optional for create).' },
          level: { type: 'string', description: 'Trust level L0-L3 (required for create and eval).' },
          expiresAt: { type: 'integer', description: 'Unix expiry seconds (required for create).' },
          budget: { type: 'integer', description: 'Optional budget cap for create.' },
          label: { type: 'string', description: 'Optional human label for create.' },
          grant: { type: 'string', description: 'Grant JSON string or path (required for verify and eval).' },
          grantId: { type: 'string', description: 'Grant id (required for revoke and status).' },
          actionScope: { type: 'string', description: 'The capability ID being evaluated (required for eval).' },
          now: { type: 'integer', description: 'Current unix seconds (optional for eval; default now).' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              grantId: { type: 'string' },
              issuer: { type: 'string' },
              delegate: { type: 'string' },
              level: { type: 'string' },
              scope: { type: 'array', items: { type: 'string' } },
              capabilities: { type: 'array', items: { type: 'string' } },
              issuerRoot: { type: 'string' },
              expiresAt: { type: 'integer' },
              granted: { type: 'boolean' },
              error: { type: 'string' },
              revokeStatus: { type: 'string' },
              grantJson: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.error
              ? `iflow grant: ${value.error}`
              : (value.granted
                ? `grant issued ✓ (grant_id ${value.grantId}, level ${value.level}, delegate ${value.delegate})\n  issuer: ${value.issuer}\n  capabilities: ${(value.capabilities || []).join(', ')}\n  scope: ${(value.scope || []).join(', ')}\n  issuerRoot: ${value.issuerRoot || '(none)'}\n  expires: ${value.expiresAt}`
                : (value.revokeStatus
                  ? `grant ${value.grantId}: ${value.revokeStatus}`
                  : `grant verified ✓ (grant_id ${value.grantId}, issuer ${value.issuer}, delegate ${value.delegate}, level ${value.level})`)),
          }],
        },
        async execute(args) {
          const action = typeof args.action === 'string' ? args.action : ''
          try {
            if (action === 'create') {
              if (!args.delegate || !args.level || typeof args.expiresAt !== 'number') return { ok: false, error: 'create needs delegate, level, expiresAt' }
              const grantArgs = ['grant', 'create', args.delegate, args.scope || '', String(args.level), String(args.expiresAt)]
              if (typeof args.budget === 'number') grantArgs.push('--budget', String(args.budget))
              if (typeof args.label === 'string' && args.label.length > 0) grantArgs.push('--label', args.label)
              if (typeof args.capabilities === 'string' && args.capabilities.length > 0) grantArgs.push('--capabilities', args.capabilities)
              if (typeof args.deny === 'string' && args.deny.length > 0) grantArgs.push('--deny', args.deny)
              if (typeof args.root === 'string' && args.root.length > 0) grantArgs.push('--root', args.root)
              if (typeof args.issuerKind === 'string' && args.issuerKind.length > 0) grantArgs.push('--issuer-kind', args.issuerKind)
              if (typeof args.nonce === 'string' && args.nonce.length > 0) grantArgs.push('--nonce', args.nonce)
              const out = await iflowId(grantArgs, 20)
              const grant = JSON.parse(out)
              return {
                ok: true, granted: true,
                grantId: grant.grant_id, issuer: grant.body.issuer, delegate: grant.body.delegate,
                level: grant.body.level, scope: grant.body.scope,
                capabilities: Array.isArray(grant.body.capabilities) ? grant.body.capabilities.map((c) => (c && c.id) || '').filter(Boolean) : [],
                issuerRoot: grant.body.issuer_root && grant.body.issuer_root.kind ? grant.body.issuer_root.kind : null,
                expiresAt: grant.body.expires_at, grantJson: out,
              }
            }
            if (action === 'verify') {
              if (!args.grant) return { ok: false, error: 'verify needs grant (JSON string or path)' }
              const g = await writeGrantTemp(args.grant)
              await iflowId(['grant', 'verify', g], 20)
              const parsed = typeof args.grant === 'string' && args.grant.trimStart().startsWith('{') ? JSON.parse(args.grant) : null
              return { ok: true, grantId: parsed ? parsed.grant_id : null, issuer: parsed ? parsed.body.issuer : null, delegate: parsed ? parsed.body.delegate : null, level: parsed ? parsed.body.level : null }
            }
            if (action === 'eval') {
              if (!args.grant || !args.actionScope || !args.level) return { ok: false, error: 'eval needs grant, actionScope, level' }
              const g = await writeGrantTemp(args.grant)
              const now = typeof args.now === 'number' ? String(args.now) : String(Math.floor(Date.now() / 1000))
              await iflowId(['grant', 'eval', g, args.actionScope, String(args.level), now], 20)
              const parsed = typeof args.grant === 'string' && args.grant.trimStart().startsWith('{') ? JSON.parse(args.grant) : null
              return { ok: true, grantId: parsed ? parsed.grant_id : null, issuer: parsed ? parsed.body.issuer : null, delegate: parsed ? parsed.body.delegate : null, level: parsed ? parsed.body.level : null }
            }
            if (action === 'revoke') {
              if (!args.grantId) return { ok: false, error: 'revoke needs grantId' }
              await iflowId(['grant', 'revoke', args.grantId], 20)
              return { ok: true, grantId: args.grantId, revokeStatus: 'revoked' }
            }
            if (action === 'status') {
              if (!args.grantId) return { ok: false, error: 'status needs grantId' }
              const out = await iflowId(['grant', 'status', args.grantId], 20)
              const m = /: (.*)$/.exec(out.trim())
              return { ok: true, grantId: args.grantId, revokeStatus: m ? m[1] : out.trim() }
            }
            return { ok: false, error: `unknown action: ${action}` }
          } catch (err) {
            return { ok: false, error: String(err && err.message ? err.message : err) }
          }
        },
      }),

      defineTool({
        name: 'iflow_usage',
        description: 'iFlow (token metering): record a task\'s token usage and cost, or aggregate the usage log into a cost report. Usage comes from DSH\'s TokenUsage; cost is read from ~/.iflow/pricing.json (per-million-token model prices). Economic fields (cost, fingerprint) are recorded now so the P3 economy layer can consume them.',
        parameters: {
          action: { type: 'string', required: true, description: 'One of: record | report.' },
          taskId: { type: 'string', description: 'Task id (required for record, used as the idempotency key).' },
          from: { type: 'string', description: 'Initiating did:key (required for record).' },
          model: { type: 'string', description: 'Model that served the task (required for record).' },
          inputTokens: { type: 'integer', description: 'Uncached input tokens (required for record).' },
          outputTokens: { type: 'integer', description: 'Output tokens (required for record).' },
          cacheReadTokens: { type: 'integer', description: 'Cache-hit input tokens (optional, default 0).' },
          cacheWriteTokens: { type: 'integer', description: 'Cache-write input tokens (optional, default 0).' },
          durationMs: { type: 'integer', description: 'Task duration in ms (optional).' },
          reportFrom: { type: 'string', description: 'Filter report to this did (optional).' },
          reportModel: { type: 'string', description: 'Filter report to this model (optional).' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              tasks: { type: 'integer' },
              tokens: { type: 'integer' },
              inputTokens: { type: 'integer' },
              outputTokens: { type: 'integer' },
              cacheReadTokens: { type: 'integer' },
              cacheWriteTokens: { type: 'integer' },
              totalCost: { type: 'number' },
              fingerprint: { type: 'string' },
              byModel: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { model: { type: 'string' }, tasks: { type: 'integer' }, tokens: { type: 'integer' }, cost: { type: 'number' } } } },
              byFrom: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { from: { type: 'string' }, tasks: { type: 'integer' }, tokens: { type: 'integer' }, cost: { type: 'number' } } } },
              error: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.error
              ? `iflow usage: ${value.error}`
              : (value.fingerprint
                ? `usage recorded ✓ (${value.tokens} tokens, cost $${Number(value.totalCost || 0).toFixed(8)}, fingerprint ${value.fingerprint})`
                : `usage report (${value.tasks} tasks): ${value.tokens} tokens (in ${value.inputTokens}, out ${value.outputTokens}, cr ${value.cacheReadTokens}, cw ${value.cacheWriteTokens}), total cost $${Number(value.totalCost || 0).toFixed(8)}`),
          }],
        },
        async execute(args) {
          const action = typeof args.action === 'string' ? args.action : ''
          try {
            if (action === 'record') {
              if (!args.taskId || !args.from || !args.model || typeof args.inputTokens !== 'number' || typeof args.outputTokens !== 'number') return { ok: false, error: 'record needs taskId, from, model, inputTokens, outputTokens' }
              const rec = ['usage', 'record', args.taskId, args.from, args.model, String(args.inputTokens), String(args.outputTokens)]
              if (typeof args.cacheReadTokens === 'number') rec.push('--cache-read', String(args.cacheReadTokens))
              if (typeof args.cacheWriteTokens === 'number') rec.push('--cache-write', String(args.cacheWriteTokens))
              if (typeof args.durationMs === 'number') rec.push('--duration', String(args.durationMs))
              const out = await iflowId(rec, 20)
              const fpMatch = /fingerprint: (\S+)/.exec(out)
              const costMatch = /cost \$([0-9.]+)/.exec(out)
              const tokMatch = /: (\d+) tokens \(in (\d+), out (\d+), cr (\d+), cw (\d+)\)/.exec(out)

              // Metering is a fact about a Task, so it belongs in the Journal
              // rather than only in a private ledger. Cost travels as integer
              // micro-units: the canonical form rejects floats so that two
              // languages can sign the same bytes.
              observeEdge('usage.recorded', (observer) =>
                observer.usageRecorded({
                  taskId: args.taskId,
                  model: args.model,
                  tokens: {
                    input: args.inputTokens,
                    output: args.outputTokens,
                    cacheRead: typeof args.cacheReadTokens === 'number' ? args.cacheReadTokens : 0,
                    cacheWrite: typeof args.cacheWriteTokens === 'number' ? args.cacheWriteTokens : 0,
                  },
                  costMicros: Math.round((costMatch ? Number(costMatch[1]) : 0) * 1e6),
                  priceSource: 'pricing.json',
                }),
              )

              return {
                ok: true,
                fingerprint: fpMatch ? fpMatch[1] : null,
                tasks: 1,
                tokens: tokMatch ? Number(tokMatch[1]) : 0,
                inputTokens: tokMatch ? Number(tokMatch[2]) : 0,
                outputTokens: tokMatch ? Number(tokMatch[3]) : 0,
                cacheReadTokens: tokMatch ? Number(tokMatch[4]) : 0,
                cacheWriteTokens: tokMatch ? Number(tokMatch[5]) : 0,
                totalCost: costMatch ? Number(costMatch[1]) : 0,
              }
            }
            if (action === 'report') {
              const rep = ['usage', 'report']
              if (args.reportFrom) rep.push('--from', args.reportFrom)
              if (args.reportModel) rep.push('--model', args.reportModel)
              const out = await iflowId(rep, 20)
              // Parse the human report into structured fields (best-effort).
              const tasksMatch = /tasks:\s*(\d+)/.exec(out)
              const tokensMatch = /tokens:\s*(\d+)/.exec(out)
              const costMatch = /total cost:\s*\$([0-9.]+)/.exec(out)
              const inMatch = /in (\d+)/.exec(out)
              const outMatch = /out (\d+)/.exec(out)
              const crMatch = /cr (\d+)/.exec(out)
              const cwMatch = /cw (\d+)/.exec(out)
              return {
                ok: true,
                tasks: tasksMatch ? Number(tasksMatch[1]) : 0,
                tokens: tokensMatch ? Number(tokensMatch[1]) : 0,
                inputTokens: inMatch ? Number(inMatch[1]) : 0,
                outputTokens: outMatch ? Number(outMatch[1]) : 0,
                cacheReadTokens: crMatch ? Number(crMatch[1]) : 0,
                cacheWriteTokens: cwMatch ? Number(cwMatch[1]) : 0,
                totalCost: costMatch ? Number(costMatch[1]) : 0,
              }
            }
            return { ok: false, error: `unknown action: ${action}` }
          } catch (err) {
            return { ok: false, error: String(err && err.message ? err.message : err) }
          }
        },
      }),
    ]

    async function writeGrantTemp(grant) {
      let text = grant
      // grant may be a path or an inline JSON string
      if (typeof grant === 'string' && !grant.trimStart().startsWith('{')) {
        text = await ctx.fs.readText(await ctx.fs.resolve(grant))
      }
      const p = scratchPath('grant-tool.json')
      const resolved = await ctx.fs.resolve(p)
      await ctx.fs.writeText(resolved, text)
      return p
    }

    for (const tool of tools) ctx.tools.register(tool)

    // ── iFlow edge (Origin Journal + Local Projection + read API) ──────────
    // Additive: it observes DSH and journals facts. The A2A bridge,
    // grants and metering above are untouched, and a failure to start the
    // edge degrades observability without taking the bridge down with it.
    // The edge starts asynchronously, so anything that wants to journal a fact
    // goes through here: before it is ready the fact is simply not observed,
    // which must never be allowed to break the A2A or metering path itself.
    let edgeHandle = null
    function observeEdge(what, use) {
      if (!edgeHandle) return
      try {
        const result = use(edgeHandle.edge.observer)
        if (result && typeof result.catch === 'function') {
          result.catch((err) => console.error(`iFlow: could not journal ${what}`, err))
        }
      } catch (err) {
        console.error(`iFlow: could not journal ${what}`, err)
      }
    }
    /**
     * Publishing is off until someone turns it on, and `.iflow/community.json`
     * is where that decision lives.
     *
     * The stored file outranks `config.community`: config is the default for a
     * node nobody has decided about, but once a person has chosen — on this
     * machine, in the panel — their choice wins over a file they may never have
     * seen. `{}` from the panel's "stop" means stopped, not "fall back to
     * config", which is why the absence of a URL here is honoured rather than
     * treated as unset.
     */
    async function resolveCommunity() {
      const stored = await loadCommunitySettings(ctx, join, workspace)
      // Decided, and the decision was no. Config does not get to overrule the
      // person who clicked stop on this machine.
      if (stored && stored.stopped) return undefined
      if (stored) return stored

      // Never decided here: fall back to whatever the profile configured.
      const fromConfig = config.community
      if (fromConfig && fromConfig.url && fromConfig.token) {
        return {
          url: String(fromConfig.url),
          token: String(fromConfig.token),
          visibility: fromConfig.visibility === 'full' ? 'full' : 'structural',
          intervalMs: Number(fromConfig.intervalMs) || 60000,
        }
      }
      return undefined
    }

    /**
     * Bring the edge up.
     *
     * Extracted so that turning publishing on or off takes effect immediately
     * instead of at the next restart. Re-running this is safe by construction:
     * `deriveNodeId` is derived from hostname and workspace, so the node keeps
     * its identity and its journal continues rather than forking, and the SDK
     * suppresses a duplicate `agent.registered` when it reopens.
     */
    async function startEdge() {
      const identity = await getIdentity()
      state.nodeDid = identity.did ?? null
      const community = await resolveCommunity()
      state.community = community ?? null
      // Who this node speaks for. An Agent exists because a person declared it;
      // a node that has declared nothing still runs, and still journals, under
      // its own key alone.
      const declarations = await loadDeclarations(ctx, join, workspace)
      state.principalId = declarations.principal?.principalId ?? null
      // Same read, kept for the relay roster: these are the Agents this node
      // asks to have messages routed to it for.
      state.declaredAgentDids = agentDidsOf(declarations)
      return installIFlowEdge(ctx, {
        workspace,
        alias: state.alias,
        version: state.syncVersion,
        nodeDid: identity.did,
        // A getter, not the value: the token can change after this call.
        token: () => state.token,
        capabilities: ['iflow.cap:task.run', 'iflow.cap:tool.call', 'iflow.cap:a2a.receive'],
        // The edge signs through the same binary the rest of the plugin uses,
        // so there is exactly one place that holds key material.
        runIflowId: (args, home) => iflowId(args, home),
        // Which Agents this node has declared, and which key each one signs
        // with. Read once per edge start: declaring an Agent restarts the edge,
        // so this cannot go stale behind the journal's back.
        agentDids: agentDidsOf(declarations),
        resolveSigningHome: (context) =>
          homeForSigning(join, workspace, declarations, context, identity.did, principalStoreRoot),
        writeScratch: async (name, bytes) => {
          const path = scratchPath(name)
          writeFileSync(path, Buffer.from(bytes))
          return path
        },
        allowedOrigins: config.hubOrigins ?? ['http://127.0.0.1:5174', 'http://localhost:5174'],
        // Both default to off: a Hub can read this node's projections out of
        // the box, but it cannot cause work here until an operator says so.
        // These stay in config on purpose — a one-click switch for "accept
        // remote commands" is more dangerous in the hands of someone who does
        // not know what it means than an edit they have to look up.
        acceptCommands: config.acceptCommands === true,
        routeApprovals: config.routeApprovals === true,
        community,
      })
    }

    let edgeStarting = null
    async function restartEdge() {
      // Serialise: two panel clicks in a row must not race two edges onto the
      // same journal.
      if (edgeStarting) await edgeStarting.catch(() => {})
      const previous = edgeHandle
      edgeHandle = null
      // Facts observed during the swap are dropped rather than queued —
      // `observeEdge` already degrades silently — which is the right trade for
      // a gap measured in milliseconds against a second writer on one journal.
      if (previous) previous.dispose()
      edgeStarting = startEdge()
      try {
        edgeHandle = await edgeStarting
        console.log(`iFlow edge restarted: node ${edgeHandle.nodeId}`)
        return edgeHandle
      } finally {
        edgeStarting = null
      }
    }

    void (async () => {
      try {
        edgeStarting = startEdge()
        edgeHandle = await edgeStarting
        console.log(`iFlow edge ready: node ${edgeHandle.nodeId}, journal .iflow/edge/origin.ndjson, projections on /iflow/projection/*`)
      } catch (err) {
        console.error('iFlow edge failed to start (A2A bridge is unaffected):', err && err.message ? err.message : err)
      } finally {
        edgeStarting = null
      }
    })()
    ctx.effect(() => () => { if (edgeHandle) edgeHandle.dispose() })

    // ── Human -> Own Agent: durable local half of the Web Intent plane ─────
    const webIntentFile = join(workspace, '.iflow', 'web-intents.json')
    const webIntentStore = {
      async read() {
        try {
          return JSON.parse(await ctx.fs.readText(await ctx.fs.resolve(webIntentFile)))
        } catch (error) {
          if (error?.code === 'ENOENT' || /not found|no such file/i.test(String(error?.message ?? error))) return undefined
          throw error
        }
      },
      async write(value) {
        await ctx.fs.writeText(await ctx.fs.resolve(webIntentFile), JSON.stringify(value, null, 2))
      },
    }

    webIntentQueue = new LocalIntentQueue({
      store: webIntentStore,
      clock: () => new Date(),
      async isAgentAvailable(did) {
        const declarations = await loadDeclarations(ctx, join, workspace)
        // A declared Agent is the local authority boundary P0 can act through.
        // Missing means unavailable, so the ciphertext remains in Local Queue.
        return declarations.agents.some((agent) => agent.did === did)
      },
      crypto: {
        async open(did, sealed, aad) {
          const declarations = await loadDeclarations(ctx, join, workspace)
          const agent = declarations.agents.find((candidate) => candidate.did === did)
          if (!agent) throw new IntentEnvelopeError('selected Agent is not declared on this Node', 'agent_unavailable')
          const sealedPath = scratchPath(`web-intent-${Date.now()}.bin`)
          const plainPath = scratchPath(`web-intent-${Date.now()}.json`)
          writeFileSync(sealedPath, Buffer.from(sealed, 'base64url'))
          try {
            await iflowId(['open', sealedPath, plainPath, aad], agentHome(join, workspace, agent.agentId), 20)
            return readFileSync(plainPath, 'utf8')
          } catch {
            throw new IntentEnvelopeError('Intent was not sealed for the selected Agent or its routing was altered')
          } finally {
            try { unlinkSync(sealedPath) } catch { /* already absent */ }
            try { unlinkSync(plainPath) } catch { /* open failed before output */ }
          }
        },
        async seal(recipientDid, plaintext, aad) {
          const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`
          const plainPath = scratchPath(`browser-view-${stamp}.json`)
          const sealedPath = scratchPath(`browser-view-${stamp}.bin`)
          writeFileSync(plainPath, plaintext)
          try {
            await iflowId(['seal', recipientDid, plainPath, sealedPath, aad], 20)
            return Buffer.from(readFileSync(sealedPath)).toString('base64url')
          } finally {
            try { unlinkSync(plainPath) } catch { /* already absent */ }
            try { unlinkSync(sealedPath) } catch { /* seal failed before output */ }
          }
        },
        async keyId(publicKey) {
          return createHash('sha256').update(publicKey, 'utf8').digest('hex')
        },
      },
      async sendConversation(message) {
        const declarations = await loadDeclarations(ctx, join, workspace)
        const fromAgent = declarations.agents.find((agent) => agent.did === message.fromAgentDid)
        if (!fromAgent) return { ok: false, error: 'selected Agent is no longer declared on this Node' }
        return sendViaRelay({
          peer: message.toAgentDid,
          toDid: message.toAgentDid,
          prompt: message.text,
          conversationId: message.conversationId,
          messageId: message.messageId,
          fromAgent,
        })
      },
      async postView(view) {
        const settings = relaySettings()
        if (!settings) throw new Error('Community connection is unavailable')
        await curlPost(`${settings.url}/v1/edge/browser-views`, view, 30, settings.token)
      },
      logger: console,
    })

    const localIntentPolling = startLocalIntentPolling({
      queue: webIntentQueue,
      settings: relaySettings,
      async inbox({ url, token }) {
        const answer = JSON.parse(await curlGet(`${url}/v1/edge/intents?limit=25`, 30, token))
        return Array.isArray(answer?.intents) ? answer.intents : []
      },
      async ack({ url, token }, intentIds) {
        return curlPost(`${url}/v1/edge/intents/ack`, { intentIds }, 30, token)
      },
      intervalMs: Number(config.webIntentIntervalMs) || 15_000,
      logger: console,
    })
    ctx.effect(() => localIntentPolling.dispose)

    // Collect anything left for this node, and say it is here.
    //
    // Started unconditionally and does nothing until `relaySettings()` answers,
    // so connecting to the Community later needs no restart. It reads
    // `state.community` on every tick rather than closing over it for the same
    // reason: publishing can be turned on and off from the panel.
    const stopRelayPolling = startRelayPolling({
      transport: relay,
      settings: relaySettings,
      agents: relayRoster,
      deliver: deliverFromRelay,
      pending: () => pendingOutbound(state.conversations),
      onStatus: (conversationId, messageId, reported) => {
        const conversation = state.conversations[conversationId]
        if (!conversation) return
        // `unknown` from the relay means it no longer holds the message. That
        // is not delivery — a swept envelope and a collected one look the same
        // from here — so it is recorded as what it is rather than guessed at.
        if (markOutbound(conversation, messageId, reported, iso())) void persistConversations()
      },
      intervalMs: Number(config.relayIntervalMs) || 15_000,
    })
    ctx.effect(() => stopRelayPolling)

    // ── The control panel ─────────────────────────────────────────────────
    // Everything below is the publish gate: what this node would send, whether
    // it is sending, and the two buttons that change that.
    const COMMUNITY_DEFAULT_URL = 'https://api.iflowone.com'
    let pendingClaim = null

    async function communityBaseUrl() {
      const current = await resolveCommunity()
      if (current && current.url) return current.url.replace(/\/+$/, '')
      const configured = config.community && config.community.url
      return String(configured || COMMUNITY_DEFAULT_URL).replace(/\/+$/, '')
    }

    async function communityFetch(path, body) {
      const base = await communityBaseUrl()
      const out = await curlRaw('POST', `${base}${path}`, body, 30, null)
      return JSON.parse(out)
    }

    async function confirmWebLogin(userCode) {
      const code = normalizeWebLoginCode(userCode)
      if (!code) {
        return { ok: false, error: '请输入 iFlowOne Web 显示的 8 位短码' }
      }
      const community = await resolveCommunity()
      if (!community?.url || !community?.token) return { ok: false, error: '这个节点尚未连接 Community' }
      const declarations = await loadDeclarations(ctx, join, workspace)
      const principal = declarations.principal
      if (!principal || principal.legacy || !principal.principalId) {
        return { ok: false, error: '请先声明、绑定或迁移一个稳定 Principal' }
      }
      if (!edgeHandle?.nodeId) return { ok: false, error: 'iFlow Edge 尚未就绪' }

      try {
        const base = community.url.replace(/\/+$/, '')
        const challenge = JSON.parse(
          await curlGet(
            `${base}/v1/edge/auth/challenges?userCode=${encodeURIComponent(code)}`,
            30,
            community.token,
          ),
        )
        const agentBindings = ownedAgentBindings(declarations, principal.principalId)
        const payload = webChallengeSigningPayload({
          challenge,
          nodeId: edgeHandle.nodeId,
          principal,
          agentBindings,
        })
        const signPath = scratchPath(`web-login-${challenge.challengeId}.bin`)
        writeFileSync(signPath, Buffer.from(canonicalBytes(payload)))
        const signed = JSON.parse(
          await iflowId(
            ['sign-blob', signPath],
            authorityHome(join, principalStoreRoot, principal.principalId, principal.authorityVersion),
            20,
          ),
        )
        const result = await curlPost(
          `${base}/v1/edge/auth/challenges/${encodeURIComponent(challenge.challengeId)}/confirm`,
          {
            principal: {
              principalId: principal.principalId,
              authorityDid: principal.authorityDid,
              authorityVersion: principal.authorityVersion,
            },
            agentBindings,
            signature: { alg: 'EdDSA', signerDid: principal.authorityDid, value: signed.signature },
          },
          30,
          community.token,
        )
        return { ok: result?.state === 'confirmed', ...result }
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) }
      }
    }

    installPanelRoutes(ctx, webServer, {
      // A remote caller is refused unless it holds this node's bearer token.
      //
      // Note what this does NOT reuse: `authorized()` returns true for
      // everyone when no token is configured, because that is the right default
      // for a read API on a loopback port. Applying it here would mean a node
      // with auth off publishes itself for anyone on the LAN who can POST. No
      // token configured therefore means no remote access at all.
      authorizeRemote: (request) => state.token !== null && authorized(request),

      async declarePrincipal(label) {
        try {
          const principal = await declarePrincipalIdentity(
            ctx,
            join,
            workspace,
            principalStoreRoot,
            (args, home) => iflowId(args, home),
            label,
          )
          state.principalId = principal.principalId
          await restartEdge()
          return { ok: true, principal }
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) }
        }
      },

      async bindPrincipal(principalId) {
        try {
          const principal = await bindPrincipalIdentity(
            ctx,
            join,
            workspace,
            principalStoreRoot,
            (args, home) => iflowId(args, home),
            principalId,
          )
          state.principalId = principal.principalId
          await restartEdge()
          return { ok: true, principal }
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) }
        }
      },

      async principalMigrationPlan() {
        try {
          return { ok: true, ...(await planPrincipalMigration(ctx, join, workspace, principalStoreRoot)) }
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) }
        }
      },

      async migratePrincipal(input) {
        try {
          const result = await migrateLegacyPrincipal(
            ctx,
            join,
            workspace,
            principalStoreRoot,
            (args, home) => iflowId(args, home, 30),
            {
              expectedAuthorityDid: input?.expectedAuthorityDid,
              targetPrincipalId: input?.targetPrincipalId,
            },
          )
          state.principalId = result.principal?.principalId ?? null
          await restartEdge()
          return { ok: true, ...result }
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) }
        }
      },

      // The Requests inbox. Same two answers the `iflow_conversations` tool
      // gives, so the panel and the tool cannot drift into disagreeing about
      // what accepting means.
      async listConversations() {
        await conversationsReady
        return {
          ok: true,
          conversations: Object.values(state.conversations)
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
            .map((c) => ({
              conversationId: c.conversationId,
              peer: c.peer,
              peerDid: c.peerDid,
              state: c.state,
              preview: c.preview,
              boundSession: c.binding ? c.binding.localSessionId : null,
              createdAt: c.createdAt,
              updatedAt: c.updatedAt,
            })),
        }
      },

      async acceptConversation(conversationId) {
        if (!conversationId) return { ok: false, error: 'conversationId is required' }
        return await acceptConversation(conversationId, { decidedBy: 'human' })
      },

      async rejectConversation(conversationId, reason) {
        if (!conversationId) return { ok: false, error: 'conversationId is required' }
        return await rejectConversation(conversationId, reason)
      },

      async declareAgent(input) {
        try {
          const { declared } = await declareAgentIdentity(ctx, join, workspace, principalStoreRoot, (a, home) => iflowId(a, home, 30), {
            agentId: input?.agentId,
            label: input?.label,
            capabilities: Array.isArray(input?.capabilities) ? input.capabilities : [],
            level: input?.level,
            ttlSeconds: input?.ttlSeconds,
          })
          // A new key changes who this edge can sign as, and the descriptor is
          // read once at start. Restart so the Agent can act immediately rather
          // than at the next reboot.
          await restartEdge()
          return { ok: true, agent: declared }
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) }
        }
      },

      confirmWebLogin,

      async state() {
        await conversationsReady
        const community = await resolveCommunity()
        const declarations = await loadDeclarations(ctx, join, workspace)
        const principalMigration = await planPrincipalMigration(ctx, join, workspace, principalStoreRoot)
        const availablePrincipals = loadPrincipalRegistry(join, principalStoreRoot).principals
        const identity = await (async () => {
          try {
            const id = await getIdentity()
            return { ready: Boolean(id.did), did: id.did ?? null, error: null }
          } catch (err) {
            return { ready: false, did: null, error: err && err.message ? err.message : String(err) }
          }
        })()

        const edge = edgeHandle
        const journal = edge
          ? { nodeId: edge.nodeId, lastSeq: edge.edge.journal.lastSeq, syncedSeq: edge.edge.journal.syncedSeq }
          : null
        const localAgents = edge ? (edge.edge.views.agents().data.agents ?? []).length : 0
        const localIntentStates = await webIntentQueue.status()
        const webIntents = localIntentStates.reduce(
          (counts, intent) => {
            counts[intent.state] = (counts[intent.state] ?? 0) + 1
            return counts
          },
          {},
        )

        return {
          edgeReady: Boolean(edge),
          identity,
          // `signing` is not the same as `identity.ready`: a node can hold a
          // DID and still journal unsigned if the binary went missing after
          // start-up.
          signing: edge ? edge.signing : false,
          localAgents,
          journal,
          pendingFacts: journal ? Math.max(0, journal.lastSeq - journal.syncedSeq) : 0,
          webIntents,
          publishing: community
            ? { url: community.url, visibility: community.visibility, enabledAt: community.enabledAt ?? null }
            : null,
          claimInProgress: pendingClaim ? { userCode: pendingClaim.userCode, expiresAt: pendingClaim.expiresAt } : null,
          // Who this node speaks for. An Agent is here because a person
          // declared it; `localAgents` above counts what the runtime is doing,
          // which is a different question.
          principal: declarations.principal,
          principalMigration,
          availablePrincipals,
          declaredAgents: declarations.agents.map((a) => ({
            agentId: a.agentId,
            label: a.label,
            did: a.did,
            capabilities: a.capabilities ?? [],
            grantRef: a.grantRef,
          })),
          // Who this node is, for the Hub's "Me" tab. `workspaceRoot` is a path
          // on this disk and is shown only to the person sitting at it: this
          // payload is loopback-guarded, and the path is never in a projection.
          alias: state.alias,
          nodeId: edge ? edge.nodeId : null,
          workspaceRoot: workspace,
          // Cached reachability, deliberately NOT probed here. The Launcher
          // polls this route every 15 seconds; probing on that path would turn
          // the panel into a scheduled port-scan of every registered peer.
          // `POST /iflow/panel/peers/probe` is the explicit way to refresh.
          peers: [...state.peers.entries()].map(([name, entry]) => ({
            name,
            url: entry.url,
            tokenSet: entry.token !== null,
            healthy: entry.healthy ?? null,
            lastSeen: entry.lastSeen ?? null,
          })),
          // The badge reads this. Because the Launcher already polls /state,
          // showing "someone is waiting" costs no additional request.
          conversationsPending: pendingConversationCount(),
          // Whether this node can reach a peer it cannot dial, and if not, why.
          // An identity binary older than the plugin is the likely answer, and
          // it is not something an operator would otherwise find out until a
          // message failed to send.
          relay: {
            configured: Boolean(relaySettings()),
            canSeal: iflowIdSupports('seal'),
          },
          trust: {
            default: state.trust.default,
            autoPeers: Object.values(state.trust.peers).filter((m) => m === 'auto').length,
            blocked: state.trust.blocked.length,
          },
          // Read-only. These are security posture, not preferences, and the
          // panel shows them so an operator can see what this node accepts —
          // it does not offer to change them.
          posture: {
            acceptCommands: config.acceptCommands === true,
            routeApprovals: config.routeApprovals === true,
            authEnabled: state.token !== null,
            boundHost: webServer.host,
            port: webServer.port,
          },
        }
      },

      /**
       * The relationship graph, and only the relationship graph.
       *
       * `views.network()` also carries task, goal and room nodes — the shape of
       * work in progress. Those are filtered out HERE rather than in the
       * browser, for two reasons: the Hub's star map is about who knows whom
       * (§23), and whatever is not sent cannot leak from the page that
       * receives it.
       */
      async networkMap() {
        const edge = edgeHandle
        if (!edge) return { ok: true, nodes: [], edges: [], selfAgentId: null }
        const view = edge.edge.views.network().data
        return {
          ok: true,
          selfAgentId: edge.edge.descriptor.selfAgentId,
          nodes: view.nodes.filter((n) => n.kind === 'agent'),
          // `rel:` is the prefix projectNetworkGraph gives edges derived from an
          // AgentRelation. Every other edge is a projection of a Task or a Room.
          edges: view.edges.filter((e) => e.id.startsWith('rel:')),
        }
      },

      async probePeers() {
        for (const [name, entry] of state.peers) await probePeer(name, entry)
        return {
          ok: true,
          peers: [...state.peers.entries()].map(([name, entry]) => ({
            name,
            url: entry.url,
            tokenSet: entry.token !== null,
            healthy: entry.healthy ?? null,
            lastSeen: entry.lastSeen ?? null,
          })),
        }
      },

      async claimStart() {
        const edge = edgeHandle
        if (!edge) return { ok: false, error: 'the edge is not running yet; try again in a moment' }
        const identity = await getIdentity().catch(() => ({ did: undefined }))

        const result = await communityFetch('/v1/claim/start', {
          nodeId: edge.nodeId,
          did: identity.did,
          label: state.alias,
        })
        if (!result || !result.deviceCode) {
          return { ok: false, error: 'the Community did not issue a code' }
        }
        pendingClaim = {
          deviceCode: result.deviceCode,
          userCode: result.userCode,
          expiresAt: result.expiresAt,
        }
        return {
          ok: true,
          userCode: result.userCode,
          verificationUrl: result.verificationUrl,
          expiresAt: result.expiresAt,
          intervalMs: result.intervalMs ?? 3000,
        }
      },

      async claimPoll() {
        if (!pendingClaim) return { ok: false, state: 'none' }

        const result = await communityFetch('/v1/claim/poll', { deviceCode: pendingClaim.deviceCode })
        if (result.state !== 'issued') {
          if (result.state === 'expired' || result.state === 'unknown') pendingClaim = null
          return { ok: true, state: result.state }
        }

        const base = await communityBaseUrl()
        await saveCommunitySettings(ctx, join, workspace, {
          url: base,
          token: result.nodeToken,
          visibility: 'structural',
          nodeId: result.nodeId,
          principalId: result.principalId ?? null,
          enabledAt: new Date().toISOString(),
          intervalMs: 60000,
        })
        pendingClaim = null

        // Take effect now. Waiting for a restart after someone has just
        // confirmed on another screen would read as a failure.
        await restartEdge()
        return { ok: true, state: 'issued', url: base }
      },

      async stopPublishing() {
        await clearCommunitySettings(ctx, join, workspace)
        pendingClaim = null
        await restartEdge()
        // Facts keep being journaled and keep queuing in the outbox; they are
        // simply not sent. Going offline is not the same as going blind.
        return { ok: true, publishing: null }
      },

      async setVisibility(visibility) {
        const community = await resolveCommunity()
        if (!community) return { ok: false, error: 'this node is not publishing' }
        const next = visibility === 'full' ? 'full' : 'structural'
        await saveCommunitySettings(ctx, join, workspace, { ...community, visibility: next })
        await restartEdge()
        return { ok: true, visibility: next }
      },

      async fetchIdentity() {
        const bin = await resolveIflowId(true)
        if (!bin) return { ok: false, error: iflowIdFailure ?? 'the binary could not be resolved' }
        try {
          identityCache = null
          const identity = await getIdentity()
          return { ok: true, path: bin, did: identity.did ?? null }
        } catch (err) {
          return { ok: false, path: bin, error: err && err.message ? err.message : String(err) }
        }
      },
    })

    console.log(`iFlow A2A bridge ready (v${state.syncVersion}): /a2a on port ${webServer.port}, alias ${state.alias}, update source ${sourcePath}, auth ${state.token === null ? 'off' : 'on'}`)
  },
};
