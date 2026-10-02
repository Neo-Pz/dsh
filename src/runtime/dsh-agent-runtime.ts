import { blocksToText, foldOutput } from '../a2a/protocol.js'
import { bindSession, markSeen, messageDigest } from '../conversation/store.js'

// Only this host adapter knows DSH presets, Session events and Agent handles.
// Network policy stays in Connect; these callbacks persist/observe its decisions.
export function createDshAgentRuntime(ports) {
  const {
    ctx, config, requireConversationWorkspace, persistConversations,
    recordExchange, iflowId, uid, iso, setStatus, observeEdge, selfAgentId,
    getConversation, getTask, releaseTask, conversationsReady,
  } = ports
  const agents = ctx.agents

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
    const conversation = thread.conversationId ? getConversation(thread.conversationId) : undefined
    const bound = conversation && conversation.binding ? conversation.binding.localSessionId : undefined
    const setup = async (agentCtx) => {
      // Mount the resolved preset inside the creation window so the child's
      // toolset is decided before it can run anything. Which preset that is
      // was settled above, and an unconfined child never gets this far
      // unless the operator explicitly allowed it. Resume takes the same
      // path: a resumed session is no less remote than a fresh one.
      if (presetId) await ctx.agentPresets.mount(agentCtx, presetId)
    }
    // iFlow conversations are ordinary DSH conversations with a remote
    // Agent as their peer.  `origin: 'subagent'` makes DSH deliberately
    // hide them in the child-agent surface instead of the selected
    // workspace's normal session list, which is the opposite of the chat
    // product: people must be able to find and reopen these threads.
    let conversationCwd
    try {
      conversationCwd = await requireConversationWorkspace()
    } catch (err) {
      setStatus(taskId, 'TASK_STATE_AUTH_REQUIRED', err && err.message ? err.message : String(err))
      return
    }
    const meta = { cwd: conversationCwd, ...(presetId ? { agentPreset: presetId } : {}) }

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
          workspaceId: conversationCwd,
          localSessionId: handle.agent.session.id ?? childId,
          now: iso(),
        })
        void persistConversations()
      }
    }
    const child = handle.agent
    if (!resumed) {
      try {
        ctx.sessionTitle.rename(child.session, from || conversation?.peerAgentId || 'Agent')
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
        // The id the SENDER minted, not a fresh one.
        //
        // One network message, one id, on both machines. Minting a second
        // here made the two ends unable to recognise the same message: no
        // cross-node deduplication, no way to pair a reply with what it
        // answered, and no way for two sessions to be views of one thread.
        //
        // Falls back to a new id only for a peer that sent none, which is an
        // old node rather than a hostile one.
        id: thread.messageId || `iflow-${uid('msg')}`,
        role: 'user',
        content: [{ type: 'text', text }],
        // The far side wrote this. `kind: 'user'` is what DSH needs to
        // persist it; who it was is recorded beside it, because a peer's
        // message landing as an ordinary local user turn is exactly backwards.
        iflow: authorship({
          author: thread.actorType === 'human' ? 'human' : 'agent',
          authorAgentId: thread.peerAgentId ?? null,
          authorLabel: from ?? thread.peerAgentId ?? null,
          represents: thread.peerAgentId ?? null,
          side: 'peer',
        }),
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
      releaseTask(taskId)
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
      const task = getTask(taskId)
      if (task) {
        task.artifacts = [{
          artifactId: `iflow-${uid('art')}`,
          name: 'result',
          description: 'Final answer produced by the local agent.',
          parts: [{ text: textOut, mediaType: 'text/plain' }],
        }]
      }
      // A2A says completed and keeps saying it: that is what the sender's
      // GetTask poll is waiting on, and changing it would hang every peer.
      // What the journal records is narrower and truer — the work was handed
      // back, and nobody has ruled on it.
      setStatus(taskId, 'TASK_STATE_COMPLETED', 'The task completed successfully.')
      observeEdge('delivery.submitted', (observer) =>
        observer.deliverySubmitted({
          taskId,
          deliveryId: `del-${taskId}`,
          // The declared Agent that answered, which is the one that may not
          // rule on this. `toAgentId` belongs to the request handler's scope,
          // not this one.
          byAgentId: conversation?.localAgentId ?? selfAgentId(),
          outputs: [{ kind: 'artifact', id: task.artifacts[0].artifactId, summary: 'Final answer' }],
          // A digest, never the answer. The requester holds the text and can
          // check it against this; nobody else learns anything from it.
          evidence: [messageDigest(textOut)],
        }),
      )
      // The reply is this Agent speaking, on the same thread the request
      // arrived on, addressed back to whoever asked.
      await recordExchange('self', textOut, `[agent:${thread.localAgentLabel || conversation?.localAgentId || 'Agent'}]`, from, {
        conversationId: thread.conversationId,
        actorType: 'agent',
        origin: 'agent',
      })
    } else {
      setStatus(taskId, 'TASK_STATE_FAILED', 'The local agent produced no output.')
    }
    try { await recordTaskUsage(taskId, from, child.session.events, startedAt, (selection && selection.model) || undefined) } catch (e) { /* best-effort */ }
  }

  async function openConversationSession(conversation, peerLabel) {
    const selection = ctx.agentDefaultModel.currentSelection()
    const agentOptions = selection?.provider && selection?.model
      ? { provider: selection.provider, model: selection.model }
      : {}
    const controller = makeAbortController()
    let handle
    let created = false
    const bound = conversation.binding?.localSessionId
    if (bound && typeof agents.resume === 'function') {
      try { handle = await agents.resume({ resumeSessionId: bound, agentOptions, signal: controller.signal }) }
      catch { /* A Conversation outlives a locally deleted Session. */ }
    }
    if (!handle) {
      const conversationCwd = await requireConversationWorkspace()
      const sessionId = `iflow-${uid('agent')}`
      handle = await agents.create({
        sessionId,
        // Keep the session in the normal DSH workspace conversation list.
        // The ConversationBinding carries the iFlow-specific identity; a
        // subagent origin is neither necessary nor correct here.
        meta: { cwd: conversationCwd },
        agentOptions,
        signal: controller.signal,
      })
      bindSession(conversation, {
        runtime: 'dsh', workspaceId: conversationCwd,
        localSessionId: handle.agent.session.id ?? sessionId, now: iso(),
      })
      created = true
      await persistConversations()
    }
    if (created) {
      try { ctx.sessionTitle.rename(handle.agent.session, peerLabel || conversation.peerAgentId || 'Agent') }
      catch (error) { console.error('iFlow conversation title failed', error) }
    }
    return { handle, controller }
  }

  function appendWebHuman(session, text, messageId, represents) {
    session.append('user/message', {
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text }],
      // A person wrote this and an Agent carries it. Both are true, and the
      // architecture rests on not having to choose: a Human is not a network
      // actor, it acts through the Agent that represents it.
      iflow: authorship({ author: 'human', represents: represents ?? null, side: 'self' }),
      source: { kind: 'plugin', plugin: 'iflow' },
    }, { surfaceOp: 'append' })
  }

  /**
   * Authorship, written down instead of guessed at later.
   *
   * DSH's event type says whether a message is a user turn or an assistant
   * turn. It does not say WHOSE — and in a conversation with two Agents on
   * two machines that is the only question worth asking. Reading `assistant`
   * as "the peer" attributes this node's own Agent to the far side; reading
   * `user` as "me" cannot see a person on the other end at all.
   *
   * So four separate things, none of them derivable from the other three:
   *   author         who produced the words: a person, or an Agent
   *   authorAgentId  which Agent, when an Agent produced them
   *   represents     the Agent that carries them onto the network and signs
   *   side           `self` or `peer`, relative to this node
   *
   * `side` is stored rather than computed because this record belongs to one
   * machine. The same signed message is `self` here and `peer` there, and
   * each end writes its own session.
   */
  function authorship({ author, authorAgentId, authorLabel, represents, side }) {
    return { v: 1, author, authorAgentId: authorAgentId ?? null, authorLabel: authorLabel ?? null, represents: represents ?? null, side }
  }

  function appendRemoteAgent(session, text, messageId, peer = {}) {
    session.append('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: messageId,
        role: 'assistant',
        content: [{ type: 'text', text }],
        // Extra keys survive persistence and DSH ignores them, so this is
        // where the truth lives for anything of ours that reads the session
        // back — the web Chat view, and any projection after it.
        iflow: authorship({
          author: peer.author === 'human' ? 'human' : 'agent',
          authorAgentId: peer.agentId ?? null,
          authorLabel: peer.label ?? peer.agentId ?? null,
          represents: peer.agentId ?? null,
          side: peer.side === 'self' ? 'self' : 'peer',
        }),
        // `kind: 'model'` is not decoration. DSH validates every persisted
        // assistant message and requires a non-empty `source.kind`, then
        // requires it to be exactly `model` with a provider and a model.
        // Without it the append succeeds and the SESSION becomes unloadable
        // — `SessionPersistenceCorruptionError: message has invalid source`
        // — so the damage shows up later, on a session nobody was editing.
        // `model` is the field DSH shows for who produced the text, and from
        // this session's point of view that is the remote Agent. Naming it
        // here is what stops the peer's words reading as this node's own.
        source: { kind: 'model', provider: 'iflow', model: peer.label || peer.agentId || 'remote-agent' },
      },
    }, { surfaceOp: 'append' })
  }

  function eventText(event) {
    const message = event?.type === 'assistant/message' ? event.data?.message : event?.data
    return Array.isArray(message?.content)
      ? message.content.filter((block) => block?.type === 'text').map((block) => block.text ?? '').join('')
      : ''
  }

  function privateMessages(conversation, events, cursor, limit) {
    const all = events.flatMap((event, index) => {
      if (event?.type !== 'user/message' && event?.type !== 'assistant/message') return []
      // Local model preparation is not a statement from the peer, nor a
      // sent Agent message. Its confirmed message is mirrored separately.
      if (event.type === 'assistant/message' && conversation.localDraftRuns?.some((run) =>
        run.sessionId === conversation.binding?.localSessionId && index >= run.start && index < run.end)) return []
      const text = eventText(event)
      if (!text) return []
      // Written authorship first. The event type says user turn or assistant
      // turn; it does not say whose, and inferring "assistant means the peer"
      // hands this node's own Agent to the far side every time it speaks.
      const marked = event.data?.iflow ?? event.data?.message?.iflow
      const human = event.type === 'user/message'
      // Sessions written before authorship was recorded fall back to the old
      // inference. It is wrong for a local Agent's own replies and right for
      // everything else, which is exactly why it could not stay.
      const side = marked?.side ?? (human ? 'self' : 'peer')
      const author = marked?.author ?? (human ? 'human' : 'agent')
      const selfLabel = conversation.localAgentId || 'You'
      const peerLabel = conversation.peer || conversation.peerAgentId || 'Agent'
      return [{
        index,
        messageId: event.data?.id ?? event.data?.message?.id ?? `session-${index}`,
        conversationId: conversation.conversationId,
        // Which side of the conversation, and who wrote it, are two answers.
        // A person on the far side is still on the far side.
        side,
        authorAgentId: marked?.authorAgentId
          ?? (side === 'self' ? conversation.localAgentId : conversation.peerAgentId),
        authorLabel: marked?.authorLabel ?? (side === 'self' ? selfLabel : peerLabel),
        // The Agent that carries it onto the network and signs for it, which
        // is never the person even when the person wrote the words.
        representedBy: marked?.represents
          ?? (side === 'self' ? conversation.localAgentId : conversation.peerAgentId),
        contentOrigin: author,
        role: author,
        text,
        createdAt: event.at ?? conversation.updatedAt,
      }]
    })
    const requestedEnd = cursor === undefined ? all.length : Math.max(0, Math.min(Number(cursor) || 0, all.length))
    const start = Math.max(0, requestedEnd - limit)
    return {
      messages: all.slice(start, requestedEnd).map(({ index: _index, ...message }) => message),
      ...(start > 0 ? { previousCursor: String(start) } : {}),
      nextCursor: String(requestedEnd),
    }
  }

  async function sessionSnapshot(conversation, cursor, limit) {
    if (!conversation.binding?.localSessionId) return { messages: [], nextCursor: '0' }
    const opened = await openConversationSession(conversation, conversation.peer || conversation.peerAgentId)
    try { return privateMessages(conversation, opened.handle.agent.session.events ?? [], cursor, limit) }
    finally { try { await opened.handle.dispose() } catch { /* best effort */ } }
  }

  /**
   * Put an exchange into the Conversation's own session, whichever path it
   * took to get here.
   *
   * Before this, only two of the three paths wrote anything: the web Chat box
   * and a reply arriving over the relay. A message sent with `iflow_send`
   * appeared in the journal and nowhere a person looks, and so did the answer
   * to it — which is why the local session and the web view showed different
   * halves of the same conversation.
   *
   * The Conversation's session is its own thread, not whichever session
   * happened to call the tool. That is the point of the binding: one thread
   * per counterparty, continuing across every turn that touches it.
   */
  async function mirrorExchange(conversation, entries, { strict = false } = {}) {
    if (!conversation || entries.length === 0) return
    let opened
    try {
      opened = await openConversationSession(conversation, conversation.peer || conversation.peerAgentId)
    } catch (err) {
      if (strict) {
        const error = new Error('session_unavailable: cannot open the configured Conversation Session')
        error.code = 'session_unavailable'
        throw error
      }
      // A node whose operator has not chosen a conversation folder yet. The
      // exchange still happened and is still journalled; it simply has
      // nowhere local to be shown, and saying so beats failing the send.
      console.log(`iFlow: could not mirror into a session — ${err && err.message ? err.message : err}`)
      return
    }
    try {
      for (const entry of entries) {
        if (!entry.text) continue
        // `markSeen` is what makes this safe to call from a path that may run
        // twice: one network message, one id, appended once.
        if (!markSeen(conversation, `mirror:${entry.messageId}`)) continue
        if (entry.side === 'self') {
          if (entry.author === 'agent') appendRemoteAgent(opened.handle.agent.session, entry.text, entry.messageId, {
            agentId: conversation.localAgentId, label: conversation.localAgentId, side: 'self', author: 'agent',
          })
          else appendWebHuman(opened.handle.agent.session, entry.text, entry.messageId, conversation.localAgentId)
        } else {
          appendRemoteAgent(opened.handle.agent.session, entry.text, entry.messageId, {
            agentId: conversation.peerAgentId,
            label: conversation.peer || conversation.peerAgentId,
            author: entry.author,
          })
        }
      }
      await persistConversations()
    } finally {
      try { await opened.handle.dispose() } catch { /* best effort */ }
    }
  }

  async function appendReplyToConversation(conversationId, text, messageId) {
    await conversationsReady
    const conversation = getConversation(conversationId)
    if (!conversation || !markSeen(conversation, `reply:${messageId}`)) return false
    const opened = await openConversationSession(conversation, conversation.peer || conversation.peerAgentId)
    try {
      appendRemoteAgent(opened.handle.agent.session, text, messageId, {
        agentId: conversation.peerAgentId,
        label: conversation.peer || conversation.peerAgentId,
      })
    }
    finally { try { await opened.handle.dispose() } catch { /* best effort */ } }
    conversation.updatedAt = iso()
    await persistConversations()
    return true
  }

  async function generateDraft(conversation, { intentId, text, beforeExecute }) {
    const opened = await openConversationSession(conversation, conversation.peer || conversation.peerAgentId)
    try {
      // Recheck current policy after asynchronous Session resolution.
      beforeExecute()
      const before = opened.handle.agent.session.events?.length ?? 0
      opened.handle.agent.followup({
        id: intentId, role: 'user', content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'iflow' },
      })
      await opened.handle.agent.whenIdle()
      ;(conversation.localDraftRuns ??= []).push({
        sessionId: conversation.binding.localSessionId, start: before,
        end: opened.handle.agent.session.events?.length ?? before,
      })
      await persistConversations()
      return blocksToText(foldOutput((opened.handle.agent.session.events ?? []).slice(before)))
    } finally { try { await opened.handle.dispose() } catch { /* best effort */ } }
  }

  return { runChild, sessionSnapshot, mirrorExchange, appendReplyToConversation, generateDraft }
}

export function makeAbortController() {
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

