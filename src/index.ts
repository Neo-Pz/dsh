import { defineTool } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const sourcePath = fileURLToPath(import.meta.url)

// iFlow — A2A bridge (Host half) — v18: P1 trust root.
// Bidirectional Agent2Agent (A2A) bridge for DeepSeek Harness.
// v12 adds a fixed 'iflow-mirror' session: inbound peer messages and local
// replies are appended there so the GUI shows the two-way conversation live.
// v18 (P1 / V18): integrates the Rust trust root (iflow-id): AgentCard JWS
// (/.well-known/agent-card.signed.json), outbound request signing
// (X-IFlow-Signature envelope), and inbound verification + replay check.
// The shared Bearer token stays as bootstrap/compat; when a signature is
// present it is verified first (who wrote this, first time or replay).
export default {
  inject: ['tools', 'webServer', 'web', 'subprocess', 'sandboxPolicy', 'agents', 'agentDefaultModel', 'agentPresets', 'sessionTitle', 'sessions', 'fs', 'timer'],
  apply(ctx, config = {}) {
    const webServer = ctx.webServer
    const agents = ctx.agents
    const workspace = ctx.sandboxPolicy.workspaceRoot
    const allowPeerUpdate = config.allowPeerUpdate === true

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
      token: null,
      publicUrl: null,
      peers: new Map(),
      tasks: new Map(),
      outgoing: new Map(),
      mirrorTurn: 0,
      mirrorDetach: null,
      mirrorPeer: null,
    }

    const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`
    const iso = () => new Date().toISOString()
    const TERMINAL = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'])

    function simpleHash(text) {
      let h = 0x811c9dc5
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i)
        h = (h * 0x01000193) >>> 0
      }
      return h.toString(16)
    }

    async function readSource() {
      try {
        const target = await ctx.fs.resolve(sourcePath)
        const text = await ctx.fs.readText(target)
        return { text, sha: simpleHash(text) }
      } catch (err) {
        return { text: null, sha: null }
      }
    }

    // ── mirror: a PLAIN session (no origin → UI visible) with the conversation
    // UI's required event sequence. If a stale subagent-origin 'iflow-mirror'
    // session from an earlier version still exists in the store, use a distinct
    // id ('iflow-mirror-ui') so the visible plain session is the one written. ──
    async function ensureMirror() {
      try {
        const existing = ctx.sessions.get('iflow-mirror')
        let id = 'iflow-mirror'
        if (existing) {
          const meta = existing.header && existing.header.meta ? existing.header.meta : {}
          if (!meta.origin || meta.origin !== 'subagent') return existing
          id = 'iflow-mirror-ui'
        }
        // Re-adopt the persisted conversation so history survives a retire;
        // fall back to a fresh live session. `enter` returns a detach disposer
        // we call after each write batch to retire the session (so the UI can
        // resume it instead of failing "while it is live").
        const persistence = ctx.get('sessionPersistence')
        const canReadopt = !!(persistence && typeof persistence.prepare === 'function')
        let session
        let detach
        if (canReadopt) {
          try {
            const prep = await persistence.prepare(id)
            session = prep.session
            detach = ctx.sessions.enter(session)
          } catch (err) {
            // Not persisted yet (first message) → build fresh; it will be
            // persisted on append, so retiring is safe (next write re-adopts).
            let fresh = ctx.sessions.get(id)
            if (!fresh) {
              fresh = ctx.sessions.prepare(id, { meta: { cwd: workspace } })
              detach = ctx.sessions.enter(fresh)
            } else {
              detach = undefined
            }
            session = fresh
          }
        } else {
          // No persistence provider → keep the session live (old behavior) so it
          // still accumulates; never retire (nothing to re-adopt from).
          let fresh = ctx.sessions.get(id)
          if (!fresh) {
            fresh = ctx.sessions.prepare(id, { meta: { cwd: workspace } })
            ctx.sessions.enter(fresh)
          }
          session = fresh
          detach = undefined
        }
        try { ctx.sessionTitle.rename(session, 'iFlow · 双向镜像') } catch (e) { /* ignore */ }
        if (detach) state.mirrorDetach = detach
        else state.mirrorDetach = null
        return session
      } catch (err) {
        console.error('iFlow ensureMirror failed', err)
        return undefined
      }
    }

    // Free the live slot after a write batch so the mirror session becomes
    // resumable from the durable log instead of failing "while it is live".
    function retireMirror() {
      try {
        if (state.mirrorDetach) { state.mirrorDetach(); state.mirrorDetach = null }
      } catch (err) { console.error('iFlow retireMirror failed', err) }
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
    async function enqueueOut(peer, prompt) {
      const mb = await loadMailbox()
      if (mb.outbox.some(o => o.peer === peer && o.prompt === prompt && o.state !== 'delivered')) return
      mb.outbox.push({
        id: uid('mbox'), peer, prompt, taskId: '',
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
          name, url: entry.url, token: entry.token, addedAt: entry.addedAt,
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

    // ── human-in-the-loop: a message typed directly into the mirror session
    // (a user/message whose id is NOT plugin-minted 'iflow-…') is routed to the
    // session-bound peer so the operator participates in the agent↔agent
    // conversation. The distinct "human vs agent" visual badge is the client
    // side (ui-conversation MessageItem); here we do the participation/routing.
    function eventText(d) {
      try {
        if (!d || !Array.isArray(d.content)) return ''
        return d.content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('')
      } catch (err) { return '' }
    }
    async function sendToPeer(peerName, prompt) {
      const entry = resolvePeer(peerName)
      if (!entry) return { ok: false, error: 'unknown peer' }
      const rpc = (method, params) => curlPost(`${entry.url}/a2a`, { jsonrpc: '2.0', id: uid('req'), method, params }, 60, entry.token)
      return rpc('SendMessage', {
        message: { messageId: uid('msg'), role: 'ROLE_USER', parts: [{ text: prompt, mediaType: 'text/plain' }] },
        configuration: { returnImmediately: true, historyLength: 0 },
        metadata: { from: state.alias, machine: await getMachineName() },
      })
    }
    ctx.on('session/event', (session, event) => {
      try {
        if (!session || session.id !== 'iflow-mirror') return
        if (!event || event.type !== 'user/message') return
        const d = event.data
        if (!d || typeof d.id !== 'string' || d.id.startsWith('iflow-')) return // plugin-written
        const text = eventText(d)
        if (!text || !state.mirrorPeer) return
        sendToPeer(state.mirrorPeer, text).then(() => {}).catch(() => {})
      } catch (err) { /* best-effort */ }
    })

    // side: 'self'   → this machine's own turn → user/message (renders RIGHT,
    //                  WeChat "me").     'remote' → the peer's turn →
    //                  assistant/message (renders LEFT, WeChat "other"). The DSH
    //                  conversation UI aligns user/message right and
    //                  assistant/message left (MessageItem.cs style), so swapping
    //                  the roles relative to the A2A direction yields the WeChat
    //                  bubble layout: remote on the left, self on the right.
    async function mirrorAppend(side, text, label) {
      try {
        const mirror = await ensureMirror()
        if (!mirror) return
        const turn = state.mirrorTurn + 1
        const step = 1
        mirror.append('turn/start', { turn })
        mirror.append('step/start', { turn, step })
        const content = [{ type: 'text', text: `${label} ${text}` }]
        if (side === 'self') {
          mirror.append('user/message', {
            id: `iflow-${uid('m')}`,
            role: 'user',
            content,
            source: { kind: 'user' },
          }, { surfaceOp: 'append' })
        } else {
          mirror.append('assistant/message', {
            turn,
            step,
            message: {
              id: `iflow-${uid('m')}`,
              role: 'assistant',
              content,
              source: { kind: 'model', provider: 'iflow', model: 'remote' },
            },
          }, { surfaceOp: 'append' })
        }
        mirror.append('step/end', { turn, step })
        state.mirrorTurn = turn
        // Free the live slot so the user can reopen the mirror conversation.
        retireMirror()
      } catch (err) {
        console.error('iFlow mirrorAppend failed', err)
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
              const bodyPath = `${workspace}/.iflow-body-tmp.json`
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

    // ── P1 trust root bridge: spawn the Rust `iflow-id` binary. The dynamic
    // sandbox has no Web Crypto, so all identity/signing/verification work is
    // delegated to the reference implementation. The binary belongs to this
    // plugin worktree; its store stays under <workspace>/.iflow so it remains
    // inside the sandbox's writable root. ──
    let iflowIdResolved = null
    async function resolveIflowId() {
      if (iflowIdResolved !== null) return iflowIdResolved
      const candidates = [
        join(pluginRoot, 'rust', 'target', 'release', process.platform === 'win32' ? 'iflow-id.exe' : 'iflow-id'),
      ]
      for (const cand of candidates) {
        try {
          const resolved = await ctx.subprocess.resolveExecutable(cand)
          if (resolved) { iflowIdResolved = resolved; return iflowIdResolved }
        } catch (e) { /* try next */ }
      }
      iflowIdResolved = false
      return iflowIdResolved
    }

    async function iflowId(args, timeoutSec = 15) {
      const bin = await resolveIflowId()
      if (!bin) throw new Error(`iflow-id binary not found (expected ${join(pluginRoot, 'rust', 'target', 'release')})`)
      const handle = ctx.subprocess.spawn({
        // --home <workspace> keeps the store at <workspace>/.iflow, inside the
        // sandbox's writable root (the store appends .iflow itself).
        argv: [bin, '--home', workspace, ...args],
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
      try {
        const out = await iflowId(['show'])
        const did = /did:\s+(did:key:\S+)/.exec(out)
        if (did) {
          identityCache = { did: did[1], label: state.alias, present: true }
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

    function rpcResult(id, result) { return { jsonrpc: '2.0', id, result } }
    function rpcError(id, code, message, data) {
      const error = { code, message }
      if (data !== undefined) error.data = data
      return { jsonrpc: '2.0', id: id === undefined ? null : id, error }
    }
    function rpcException(code, message, data) {
      const err = new Error(message)
      err.rpcCode = code
      err.rpcData = data
      return err
    }
    function errorInfo(reason) {
      return [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'a2a-protocol.org' }]
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
      task.status = { state: stateName, timestamp: iso() }
      if (text !== undefined) {
        task.status.message = { messageId: uid('msg'), role: 'ROLE_AGENT', parts: [{ text, mediaType: 'text/plain' }] }
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

    function messageText(message) {
      if (!message || !Array.isArray(message.parts)) return ''
      const chunks = []
      for (const part of message.parts) {
        if (!part || typeof part !== 'object') continue
        if (typeof part.text === 'string') chunks.push(part.text)
        else if (part.data !== undefined) chunks.push(JSON.stringify(part.data))
        else if (typeof part.url === 'string') chunks.push(part.url)
      }
      return chunks.join('\n')
    }

    function foldOutput(events) {
      let last
      const partial = []
      for (const event of events) {
        if (event && event.type === 'assistant/message') {
          const content = event.data && event.data.message ? event.data.message.content : undefined
          if (Array.isArray(content) && content.length > 0) last = content
        } else if (event && event.type === 'assistant/chunk' && event.data && event.data.chunk
          && event.data.chunk.type === 'text-delta' && typeof event.data.chunk.text === 'string') {
          partial.push(event.data.chunk.text)
        }
      }
      if (last !== undefined) return last
      const text = partial.join('')
      return text.length > 0 ? [{ type: 'text', text }] : []
    }

    function blocksToText(blocks) {
      return blocks
        .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
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

    async function runChild(taskId, text, controller, from) {
      const startedAt = Date.now()
      const selection = ctx.agentDefaultModel.currentSelection()
      const agentOptions = selection && selection.provider && selection.model
        ? { provider: selection.provider, model: selection.model }
        : {}
      let presetId
      try {
        // Inbound remote agents run under the restricted `remote-a2a` preset
        // (workspace fs only, no shell/subagents/web). Fall back to `standard`
        // when the preset is not installed (e.g. on a peer that hasn't
        // deployed it yet).
        try {
          const preset = await ctx.agentPresets.resolve('remote-a2a')
          presetId = preset && preset.id ? preset.id : undefined
        } catch (err) {
          const preset = await ctx.agentPresets.resolve('standard')
          presetId = preset && preset.id ? preset.id : undefined
        }
      } catch (err) {
        presetId = undefined
      }
      setStatus(taskId, 'TASK_STATE_WORKING', 'Processing the request with a local agent.')
      await mirrorAppend('remote', text, `[agent:${from || 'remote'}]`)
      const childId = `iflow-${uid('agent')}`
      let handle
      try {
        handle = await agents.create({
          sessionId: childId,
          meta: { cwd: workspace, origin: 'subagent', ...(presetId ? { agentPreset: presetId } : {}) },
          agentOptions,
          signal: controller.signal,
          // Mount the standard preset inside the creation window so the child
          // gets the full local toolset (fs/bash/pwsh/skill), not just iFlow.
          setup: async (agentCtx) => {
            if (presetId) await ctx.agentPresets.mount(agentCtx, presetId)
          },
        })
      } catch (err) {
        if (controller.signal.aborted) setStatus(taskId, 'TASK_STATE_CANCELED', 'The task was canceled.')
        else setStatus(taskId, 'TASK_STATE_FAILED', `Failed to start the local agent: ${String(err && err.message ? err.message : err)}`)
        return
      }
      const child = handle.agent
      try {
        ctx.sessionTitle.rename(child.session, `iFlow · ${from || 'remote'}`)
      } catch (err) {
        console.error('iFlow rename failed', err)
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
        await mirrorAppend('self', textOut, `[agent:${state.alias}]`)
      } else {
        setStatus(taskId, 'TASK_STATE_FAILED', 'The local agent produced no output.')
      }
      try { await recordTaskUsage(taskId, from, child.session.events, startedAt, (selection && selection.model) || undefined) } catch (e) { /* best-effort */ }
    }

    async function handleSendMessage(params, signerDid, grant) {
      const message = params && params.message ? params.message : undefined
      if (!message) throw rpcException(-32602, 'Invalid parameters', 'SendMessageRequest.message is required')
      const text = messageText(message)
      if (text.length === 0) throw rpcException(-32602, 'Invalid parameters', 'message.parts must contain at least one text or data part')
      const metadata = params && params.metadata && typeof params.metadata === 'object' ? params.metadata : {}
      const from = typeof metadata.from === 'string' && metadata.from.length > 0 ? metadata.from : undefined
      if (from) state.mirrorPeer = from
      const taskId = `iflow-${uid('task')}`
      const contextId = typeof message.contextId === 'string' && message.contextId.length > 0 ? message.contextId : taskId
      const task = {
        id: taskId,
        contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: iso() },
        artifacts: [],
        metadata: {
          from: from || 'remote',
          machine: typeof metadata.machine === 'string' && metadata.machine.length > 0 ? metadata.machine : null,
          prompt: text.slice(0, 400),
          receivedAt: iso(),
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
      state.tasks.set(taskId, task)
      const controller = makeAbortController()
      state.outgoing.set(taskId, { controller, done: undefined })
      const done = runChild(taskId, text, controller, from)
      state.outgoing.get(taskId).done = done
      done.catch((err) => console.error(`iFlow task ${taskId} unhandled run error`, err))
      const configuration = params && params.configuration ? params.configuration : {}
      if (configuration.returnImmediately === true) return { task: snapshot(taskId, true) }
      await done.catch(() => {})
      return { task: snapshot(taskId, true) }
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
      if (TERMINAL.has(task.status.state)) throw rpcException(-32002, 'Task is not cancelable', errorInfo('TASK_NOT_CANCELABLE'))
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

    async function dispatch(body, signerDid, grant) {
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
          case 'SendMessage': return rpcResult(id, await handleSendMessage(params, signerDid, grant))
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
        const tmp = `${workspace}/.iflow-card-tmp.json`
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
    async function verifyInbound(req, body) {
      const header = req.headers['x-iflow-signature']
      if (!header || typeof header !== 'string' || header.length === 0) return { ok: true, did: null }
      let envelope
      try { envelope = JSON.parse(header) } catch (e) { return { ok: false, did: null, error: 'bad envelope json' } }
      if (!envelope || typeof envelope !== 'object' || !envelope.signature || !envelope.signer) return { ok: false, did: null, error: 'incomplete envelope' }
      try {
        const envPath = `${workspace}/.iflow-env-tmp.json`
        const resolved = await ctx.fs.resolve(envPath)
        await ctx.fs.writeText(resolved, JSON.stringify(envelope))
        await iflowId(['verify', envPath], 20)
        const sig = envelope.body_sha256
        if (typeof sig === 'string' && sig.length > 0 && sig !== signingDigest(body)) {
          return { ok: false, did: envelope.signer, error: 'body digest mismatch' }
        }
        if (typeof envelope.nonce === 'string' && typeof envelope.timestamp === 'number') {
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
      const grantPath = `${workspace}/.iflow-grant-tmp.json`
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
    function validCapabilityId(id) {
      if (id === '*') return true
      if (typeof id !== 'string' || !id.startsWith('iflow.cap:')) return false
      const rest = id.slice('iflow.cap:'.length)
      const seg = rest.endsWith('.*') ? rest.slice(0, rest.length - 2) : rest
      if (!seg) return false
      return seg.split('.').every((part) => part.length > 0 && /^[a-z0-9_-]+$/.test(part))
    }

    // Map the V19 default action to the V20 baseline capability ID.
    function normalizeAction(action) {
      if (action === 'agent-task') return 'iflow.cap:agent.run'
      return action
    }

    // Pure JS SHA-256 hex (FIPS 180-4) for body digest comparison — the
    // dynamic sandbox has no Web Crypto, and we only need the digest here.
    function signingDigest(text) {
      const bytes = new TextEncoder().encode(text)
      const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
      const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
      const ml = bytes.length * 8
      const withOne = new Uint8Array(bytes.length + 1)
      withOne.set(bytes)
      withOne[bytes.length] = 0x80
      let paddedLen = withOne.length + 8
      while (paddedLen % 64 !== 0) paddedLen++
      const padded = new Uint8Array(paddedLen)
      padded.set(withOne)
      const dv = new DataView(padded.buffer)
      dv.setUint32(paddedLen - 8, Math.floor(ml / 0x100000000), false)
      dv.setUint32(paddedLen - 4, ml >>> 0, false)
      const rot = (x, n) => (x >>> n) | (x << (32 - n))
      for (let i = 0; i < paddedLen; i += 64) {
        const w = new Array(64)
        for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false)
        for (let j = 16; j < 64; j++) {
          const s0 = rot(w[j - 15], 7) ^ rot(w[j - 15], 18) ^ (w[j - 15] >>> 3)
          const s1 = rot(w[j - 2], 17) ^ rot(w[j - 2], 19) ^ (w[j - 2] >>> 10)
          w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0
        }
        let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
        for (let j = 0; j < 64; j++) {
          const S1 = rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)
          const ch = (e & f) ^ (~e & g)
          const t1 = (h + S1 + ch + K[j] + w[j]) >>> 0
          const S0 = rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)
          const maj = (a & b) ^ (a & c) ^ (b & c)
          const t2 = (S0 + maj) >>> 0
          h = g; g = f; f = e; e = (d + t1) >>> 0
          d = c; c = b; b = a; a = (t1 + t2) >>> 0
        }
        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
        H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
      }
      return H.map((x) => x.toString(16).padStart(8, '0')).join('')
    }

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

    function partsText(parts) {
      if (!Array.isArray(parts)) return ''
      const chunks = []
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue
        if (typeof part.text === 'string') chunks.push(part.text)
        else if (part.data !== undefined) chunks.push(JSON.stringify(part.data))
        else if (typeof part.url === 'string') chunks.push(part.url)
      }
      return chunks.join('\n')
    }

    function taskText(task) {
      const fromArtifacts = task.artifacts && task.artifacts.length > 0
        ? task.artifacts.map((a) => partsText(a.parts)).filter((t) => t.length > 0).join('\n\n')
        : ''
      if (fromArtifacts) return fromArtifacts
      const statusMessage = task.status && task.status.message ? task.status.message : undefined
      return statusMessage ? partsText(statusMessage.parts) : ''
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
      },
    }

    const tools = [
      defineTool({
        name: 'iflow_status',
        description: 'iFlow: show the local A2A endpoint (AgentCard and JSON-RPC URLs), auth state, registered peers, sync version, mirror session state, and active inbound tasks.',
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
              mirrorSession: { type: 'string' },
              authEnabled: { type: 'boolean' },
              peers: { type: 'array', items: peerItem },
              activeTasks: { type: 'integer' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: `iFlow local endpoint:\n  AgentCard: ${value.agentCard}\n  JSON-RPC: ${value.rpcEndpoint}\n  update source: ${value.updateEndpoint}\n  syncVersion: ${value.syncVersion}\n  mirror session: ${value.mirrorSession}\n  alias: ${value.alias}\n  machine: ${value.machine}\n  auth: ${value.authEnabled ? 'enabled' : 'off'}\n  peers: ${value.peers.map((p) => `${p.name} → ${p.url}${p.healthy === undefined ? '' : p.healthy ? ' (online)' : ' (offline)'}`).join('; ') || 'none'}\n  active inbound tasks: ${value.activeTasks}`,
          }],
        },
        async execute() {
          const base = state.publicUrl || `http://127.0.0.1:${webServer.port}`
          let mirrorState = 'none'
          try { mirrorState = ctx.sessions.get('iflow-mirror') ? 'created' : 'absent' } catch (e) { /* ignore */ }
          // Refresh each peer's reachability so the report is current, not stale.
          for (const [name, entry] of state.peers) await probePeer(name, entry)
          return {
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
            mirrorSession: mirrorState,
            authEnabled: state.token !== null,
            peers: [...state.peers.entries()].map(([name, entry]) => ({ name, url: entry.url, tokenSet: entry.token !== null, healthy: entry.healthy, lastSeen: entry.lastSeen })),
            activeTasks: [...state.tasks.values()].filter((t) => !TERMINAL.has(t.status.state)).length,
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
            },
          },
          render: (_args, value) => [{ type: 'text', text: `peer ${value.name} → ${value.url} (${value.tokenSet ? 'token set' : 'no token'})` }],
        },
        async execute(args) {
          await peersReady
          const name = args.name.trim()
          const url = args.url.trim().replace(/\/+$/, '')
          state.peers.set(name, { url, token: typeof args.token === 'string' && args.token.length > 0 ? args.token : null, addedAt: iso() })
          await savePeers()
          probePeer(name, state.peers.get(name))
          return { ok: true, name, url, tokenSet: state.peers.get(name).token !== null }
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
            peers: [...state.peers.entries()].map(([name, entry]) => ({ name, url: entry.url, tokenSet: entry.token !== null, healthy: entry.healthy, lastSeen: entry.lastSeen })),
          }
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
              error: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.ok
              ? `AgentCard: ${value.name} v${value.version}\n  ${value.description}\n  interface: ${value.interfaceUrl} (${value.protocolBinding})\n  skills: ${value.skills.join(', ')}`
              : `discovery failed: ${value.error}`,
          }],
        },
        async execute(args) {
          const entry = resolvePeer(args.peer)
          if (!entry) return { ok: false, error: `unknown peer or invalid URL: ${args.peer}` }
          try {
            const text = await curlGet(`${entry.url}/.well-known/agent-card.json`, 15, entry.token)
            const card = JSON.parse(text)
            const iface = card.supportedInterfaces && card.supportedInterfaces.length > 0 ? card.supportedInterfaces[0] : {}
            return {
              ok: true,
              name: typeof card.name === 'string' ? card.name : entry.url,
              description: typeof card.description === 'string' ? card.description : '',
              version: typeof card.version === 'string' ? card.version : '',
              interfaceUrl: typeof iface.url === 'string' ? iface.url : `${entry.url}/a2a`,
              protocolBinding: typeof iface.protocolBinding === 'string' ? iface.protocolBinding : 'JSONRPC',
              skills: Array.isArray(card.skills) ? card.skills.map((s) => (s && typeof s.name === 'string' ? s.name : '')).filter(Boolean) : [],
            }
          } catch (err) {
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
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              peer: { type: 'string', required: true },
              taskId: { type: 'string' },
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
          state.mirrorPeer = args.peer
          const base = entry.url
          const token = entry.token
          const rpc = (method, params) => curlPost(`${base}/a2a`, { jsonrpc: '2.0', id: uid('req'), method, params }, 60, token)
          // Offline mailbox: before sending, redeliver any queued messages for
          // this peer. Best-effort; a still-unreachable peer leaves them queued.
          try {
            const mb = await loadMailbox()
            let dirty = false
            for (const item of mb.outbox) {
              if (item.peer !== args.peer || item.state !== 'queued') continue
              const r = await rpc('SendMessage', {
                message: { messageId: uid('msg'), role: 'ROLE_USER', parts: [{ text: item.prompt, mediaType: 'text/plain' }] },
                configuration: { returnImmediately: true, historyLength: 0 },
                metadata: { from: state.alias, machine: await getMachineName() },
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
              message: { messageId: uid('msg'), role: 'ROLE_USER', parts: [{ text: args.prompt, mediaType: 'text/plain' }] },
              configuration: { returnImmediately: true, historyLength: 0 },
              metadata: { from: state.alias, machine: await getMachineName() },
            })
          } catch (err) {
            // Peer unreachable → hold the message in the persistent outbox.
            try { await enqueueOut(args.peer, args.prompt) } catch (e) { /* best-effort */ }
            return { ok: false, peer: args.peer, taskId: '', state: 'QUEUED', error: `peer offline; queued for redelivery: ${String(err && err.message ? err.message : err)}` }
          }
          if (response.error) return { ok: false, peer: args.peer, error: `remote error ${response.error.code}: ${response.error.message}` }
          const result = response.result || {}
          const task = result.task
          // Mirror the outbound prompt (self → right, WeChat "me") once accepted.
          try { await mirrorAppend('self', args.prompt, `[agent:${state.alias}]`) } catch (e) { /* mirror is best-effort */ }
          if (!task) {
            const text = result.message ? partsText(result.message.parts) : ''
            if (text.length > 0) try { await mirrorAppend('remote', text, `[agent:${args.peer}]`) } catch (e) { /* mirror is best-effort */ }
            return {
              ok: text.length > 0, peer: args.peer, taskId: '', state: 'MESSAGE', text,
              ...(text.length === 0 ? { error: 'remote returned an empty message' } : {}),
            }
          }
          if (args.waitForCompletion === false) return { ok: true, peer: args.peer, taskId: task.id, state: task.status.state, text: '' }
          if (TERMINAL.has(task.status.state)) {
            const text = taskText(task)
            if (text.length > 0) try { await mirrorAppend('remote', text, `[agent:${args.peer}]`) } catch (e) { /* mirror is best-effort */ }
            return {
              ok: task.status.state === 'TASK_STATE_COMPLETED' && text.length > 0,
              peer: args.peer,
              taskId: task.id,
              state: task.status.state,
              text,
              ...(text.length === 0 ? { error: `task ended in ${task.status.state} with no output` } : {}),
            }
          }
          const maxWait = Math.min(Math.max(Number(args.maxWaitSeconds) || 600, 1), 3600)
          const deadline = Date.now() + maxWait * 1000
          let stateName = task.status.state
          let finalTask = task
          while (!TERMINAL.has(stateName) && Date.now() < deadline) {
            await sleep(2000)
            try {
              const poll = await rpc('GetTask', { id: task.id })
              if (poll.error) return { ok: false, peer: args.peer, taskId: task.id, state: stateName, error: `GetTask error ${poll.error.code}: ${poll.error.message}` }
              if (poll.result && poll.result.task) {
                finalTask = poll.result.task
                stateName = finalTask.status.state
              }
            } catch (err) {
              return { ok: false, peer: args.peer, taskId: task.id, state: stateName, error: `GetTask failed: ${String(err && err.message ? err.message : err)}` }
            }
          }
          if (!TERMINAL.has(stateName)) return { ok: false, peer: args.peer, taskId: task.id, state: stateName, error: `timed out waiting for task ${task.id}` }
          const text = taskText(finalTask)
          if (text.length > 0) try { await mirrorAppend('remote', text, `[${args.peer}]`) } catch (e) { /* mirror is best-effort */ }
          return {
            ok: stateName === 'TASK_STATE_COMPLETED' && text.length > 0,
            peer: args.peer,
            taskId: task.id,
            state: stateName,
            text,
            ...(text.length === 0 ? { error: `task ended in ${stateName} with no output` } : {}),
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
              const tmp = `${workspace}/.iflow-peer-card-tmp.json`
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
      const p = `${workspace}/.iflow-grant-tool-tmp.json`
      const resolved = await ctx.fs.resolve(p)
      await ctx.fs.writeText(resolved, text)
      return p
    }

    for (const tool of tools) ctx.tools.register(tool)

    console.log(`iFlow A2A bridge ready (v${state.syncVersion}): /a2a on port ${webServer.port}, alias ${state.alias}, mirror on, update source ${sourcePath}, auth ${state.token === null ? 'off' : 'on'}`)
  },
};
