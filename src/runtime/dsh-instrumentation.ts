/**
 * DSH lifecycle -> iFlow domain events.
 *
 * The ONLY place that knows both vocabularies. Every listener here is
 * observe-only: it reads what DSH already decided and journals it. None of
 * them can deny a tool call, cancel an agent, or delay a turn — observation
 * must never become a control path, or an iFlow bug becomes a DSH outage.
 *
 * All listeners register with `{ global: true }`. DSH's dispatch is
 * scope-filtered (`@deepseek-ai/dsh-scope`), so a plugin-scoped listener sees
 * only its own agents' events; an edge that must journal what the whole node
 * did has to opt out of that filter or it silently loses facts.
 *
 * ## The mapping
 *
 * The first version mapped a whole DSH session to one Task. That was wrong in
 * a way the live journal made obvious: a session is long-lived and never
 * "completes", so every Task sat in `running` forever, and Goals and Rooms had
 * no source at all.
 *
 * A session is a place where a human and agents collaborate over time — that is
 * a Room. The unit of work inside it is a turn.
 *
 * | DSH                                    | iFlow                          |
 * | -------------------------------------- | ------------------------------ |
 * | session                                | Room (root session only)       |
 * | session's agent                        | Agent, joined to that Room     |
 * | first human prompt in a root session    | Goal                           |
 * | one turn                               | Task (+ one ExecutionAttempt)  |
 * | `meta.parentSession`                   | Task delegation edge           |
 * | tool call / approval                   | attached to the open turn Task |
 *
 * A subagent does not open its own Room: it joins its ancestor's, so one Room
 * holds the whole collaboration rather than fragmenting it per child.
 */

const agentIdOf = (sessionId) => `agent-${sessionId}`
const roomIdOf = (sessionId) => `room-${sessionId}`
const goalIdOf = (sessionId) => `goal-${sessionId}`
const turnTaskIdOf = (sessionId, turn) => `task-${sessionId}-t${turn}`

/** Human label for an agent: what is acting, not what it is doing. */
function labelOf(agent) {
  const meta = agent?.session?.header?.meta ?? {}
  return meta.agentPreset ?? agent?.options?.model ?? String(agent?.id ?? 'agent')
}

/** Title for a Room: the session's own name, or a readable stand-in. */
function roomTitleOf(sessionId, agent) {
  const meta = agent?.session?.header?.meta ?? {}
  if (meta.title) return meta.title
  const id = String(sessionId)
  const short = id.startsWith('session-') ? id.slice('session-'.length, 'session-'.length + 8) : id.slice(0, 8)
  return `Session ${short}`
}

function toolNameOf(exec) {
  return typeof exec?.name === 'string' ? exec.name : 'unknown'
}

/**
 * The tool that stops work to ask a human a question.
 *
 * This is the one true source of the `waiting` coordination axis in DSH, and it
 * is deliberately NOT the same as `awaiting_approval`: an approval is a
 * permission gate the runtime imposes, while this is the agent choosing to ask.
 * Collapsing them would make "who is holding this up, and why" unanswerable.
 */
const ASK_USER_TOOL = 'ask_user_question'

/** First line of a message's text blocks, trimmed to a title's worth. */
function messageText(message, limit = 120) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const text = blocks
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0) return undefined
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * Install every observer. Returns `{ drain, dispose }`.
 *
 * @param ctx cordis context (the plugin's own; listeners opt out of its filter)
 * @param edge the `IFlowEdge` returned by `createEdge`
 * @param options.capabilities capability ids to record on observed agents
 */
export function installDshInstrumentation(ctx, edge, options = {}) {
  const observer = edge.observer
  const disposers = []
  const on = (name, listener) => {
    disposers.push(ctx.on(name, listener, { global: true }))
  }

  /**
   * One serialized observation queue.
   *
   * DSH fires these events without awaiting us — correctly so, since
   * observation must never delay a turn. But each handler needs several
   * awaited journal writes, and letting those chains interleave would record
   * `tool.call_started` before the `task.created` it belongs to. Chaining every
   * handler through one promise keeps journal order equal to causal order while
   * still returning to DSH immediately.
   */
  let queue = Promise.resolve()
  const enqueue = (work) => {
    queue = queue.then(work).catch((error) => {
      console.error('iFlow: an observation failed and was dropped', error)
    })
    return queue
  }

  /**
   * Per-session bookkeeping.
   *
   * sessionId -> {
   *   agentId, roomId, rootSessionId, parentSessionId,
   *   registered, roomAnnounced, goalAnnounced,
   *   openTurn: { turn, taskId, attemptId, journaled } | undefined,
   * }
   */
  const sessions = new Map()
  /** callId -> { taskId, agentId, toolName }, to pair a completion with its start. */
  const openCalls = new Map()
  /** approvalId -> { taskId, agentId }, same reason. */
  const openApprovals = new Map()

  function record(sessionId) {
    let entry = sessions.get(sessionId)
    if (!entry) {
      entry = {
        agentId: agentIdOf(sessionId),
        // One correlation for this session's lifecycle facts. Without it every
        // registration and presence change became its own single-fact "flow"
        // in a replay, burying the flows that actually did work.
        lifecycleCorrelation: observer.correlationFor(`lifecycle-${sessionId}`),
        rootSessionId: sessionId,
        parentSessionId: undefined,
        roomId: roomIdOf(sessionId),
        registered: false,
        roomAnnounced: false,
        goalAnnounced: false,
        openTurn: undefined,
      }
      sessions.set(sessionId, entry)
    }
    return entry
  }

  /** Walk `parentSession` to the collaboration's root, so children share one Room. */
  function rootOf(sessionId, seen = new Set()) {
    if (seen.has(sessionId)) return sessionId
    seen.add(sessionId)
    const parent = sessions.get(sessionId)?.parentSessionId
    return parent ? rootOf(parent, seen) : sessionId
  }

  /** The Task a fact belongs to: the session's open turn, else its parent's. */
  function openTaskId(sessionId) {
    return sessions.get(sessionId)?.openTurn?.journaled
      ? sessions.get(sessionId).openTurn.taskId
      : undefined
  }

  // ── Agents, Rooms ────────────────────────────────────────────────────────

  on('agent/created', ({ agent }) => {
    const sessionId = agent.id
    const meta = agent?.session?.header?.meta ?? {}
    const entry = record(sessionId)
    entry.parentSessionId = typeof meta.parentSession === 'string' ? meta.parentSession : undefined
    entry.rootSessionId = rootOf(sessionId)
    entry.roomId = roomIdOf(entry.rootSessionId)

    enqueue(async () => {
      if (!entry.registered) {
        entry.registered = true
        await observer.agentRegistered({
          agentId: entry.agentId,
          label: labelOf(agent),
          capabilities: options.capabilities ?? [],
          context: { correlationId: entry.lifecycleCorrelation, roomId: entry.roomId },
        })
      }

      // Only a root session opens a Room; a child joins its ancestor's so one
      // Room holds the whole collaboration instead of one per subagent.
      const root = record(entry.rootSessionId)
      if (!root.roomAnnounced) {
        root.roomAnnounced = true
        await observer.roomCreated({
          roomId: entry.roomId,
          title: roomTitleOf(entry.rootSessionId, entry.rootSessionId === sessionId ? agent : undefined),
          context: { correlationId: entry.lifecycleCorrelation },
        })
      }
      await observer.roomParticipantJoined({
        roomId: entry.roomId,
        agentId: entry.agentId,
        context: { correlationId: entry.lifecycleCorrelation },
      })
    })
  })

  on('agent/disposed', ({ agent }) => {
    const entry = sessions.get(agent.id)
    enqueue(async () => {
      await observer.agentPresenceChanged({
        agentId: agentIdOf(agent.id),
        presence: 'offline',
        execution: 'idle',
        context: { correlationId: entry?.lifecycleCorrelation },
      })
      if (entry?.openTurn?.taskId) observer.releaseCorrelation(entry.openTurn.taskId)
      sessions.delete(agent.id)
    })
  })

  on('agent/status', ({ agent, status }) => {
    const entry = record(agent.id)
    // Only the execution axis moves here. Presence and coordination are
    // separate facts, and the Task lifecycle belongs to the turn boundaries.
    // A status change during a turn joins that turn's flow; outside one it
    // joins the session's lifecycle flow.
    enqueue(() =>
      observer.agentPresenceChanged({
        agentId: entry.agentId,
        execution: status === 'running' ? 'running' : 'idle',
        context: { correlationId: openTaskId(agent.id) ? undefined : entry.lifecycleCorrelation },
      }),
    )
  })

  on('agent/error', ({ agent, error }) => {
    const taskId = openTaskId(agent.id)
    if (!taskId) return
    enqueue(() =>
      observer.taskFailed({
        taskId,
        reason: error instanceof Error ? error.message : String(error),
      }),
    )
  })

  // ── Tool calls ───────────────────────────────────────────────────────────

  // A waterfall listener MUST forward `next()` unchanged. Journaling the fact
  // is a side effect of passing the decision through, never a vote on it, and
  // it is queued rather than awaited so it adds no latency to the call.
  on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    const agent = exec.agent
    if (agent) {
      const entry = record(agent.id)
      const taskId = openTaskId(agent.id)
      const toolName = toolNameOf(exec)
      openCalls.set(exec.callId, { taskId, agentId: entry.agentId, toolName })
      enqueue(async () => {
        await observer.toolCallStarted({
          callId: exec.callId,
          toolName,
          agentId: entry.agentId,
          taskId,
        })
        if (toolName === ASK_USER_TOOL && taskId) {
          await observer.taskWaiting({ taskId, reason: 'the agent asked the user a question' })
          await observer.agentPresenceChanged({ agentId: entry.agentId, coordination: 'waiting' })
        }
      })
    }
    return decision
  })

  on('tools/result', (exec, result) => {
    const open = openCalls.get(exec.callId)
    openCalls.delete(exec.callId)
    if (!open) return
    const failure = result?.isError === true
    enqueue(async () => {
      await observer.toolCallCompleted({
        callId: exec.callId,
        toolName: open.toolName,
        outcome: failure ? 'error' : 'ok',
        agentId: open.agentId,
        taskId: open.taskId,
        errorMessage: failure ? String(result?.error?.message ?? result?.error ?? 'tool failed') : undefined,
      })
      // The human answered, so the task is no longer waiting on one.
      if (open.toolName === ASK_USER_TOOL && open.taskId) {
        await observer.agentPresenceChanged({ agentId: open.agentId, coordination: 'ready' })
        await observer.taskStarted({ taskId: open.taskId, agentId: open.agentId })
      }
    })
  })

  // ── Turns, Goals, Tasks, approvals ───────────────────────────────────────

  on('session/event', (session, event) => {
    const sessionId = session?.id ?? event?.sessionId
    if (typeof sessionId !== 'string') return
    const entry = record(sessionId)

    if (event.type === 'turn/start') {
      // Opened, but not journaled yet: a turn that claims no input is not work,
      // and journaling it would fill the timeline with empty Tasks.
      entry.openTurn = {
        turn: event.data.turn,
        taskId: turnTaskIdOf(sessionId, event.data.turn),
        attemptId: `attempt-${sessionId}-t${event.data.turn}`,
        journaled: false,
      }
      return
    }

    if (event.type === 'user/message') {
      const turn = entry.openTurn
      if (!turn || turn.journaled) return
      turn.journaled = true

      const title = messageText(event.data) ?? `Turn ${turn.turn}`
      // `source.kind === 'user'` is a real human prompt; 'plugin' is a
      // synthetic injected context (file-change notices, skills, cron).
      const isHumanPrompt = event.data?.source?.kind === 'user'
      const parentTaskId = entry.parentSessionId ? openTaskId(entry.parentSessionId) : undefined

      enqueue(async () => {
        const root = record(entry.rootSessionId)
        if (isHumanPrompt && !root.goalAnnounced) {
          root.goalAnnounced = true
          await observer.goalCreated({
            goalId: goalIdOf(entry.rootSessionId),
            title,
            roomId: entry.roomId,
          })
        }

        await observer.taskCreated({
          taskId: turn.taskId,
          title,
          parentTaskId,
          goalId: root.goalAnnounced ? goalIdOf(entry.rootSessionId) : undefined,
          roomId: entry.roomId,
        })

        // A child session's turn is work its parent delegated.
        if (parentTaskId) {
          await observer.taskDelegated({
            taskId: turn.taskId,
            toAgentId: entry.agentId,
            reason: 'delegated to a subagent session',
          })
        }

        await observer.taskStarted({ taskId: turn.taskId, agentId: entry.agentId, attemptId: turn.attemptId })
        await observer.attemptStarted({
          taskId: turn.taskId,
          attemptId: turn.attemptId,
          agentId: entry.agentId,
        })
      })
      return
    }

    if (event.type === 'turn/end') {
      const turn = entry.openTurn
      entry.openTurn = undefined
      if (!turn || !turn.journaled) return

      const reason = event.data?.reason ?? { kind: 'completed' }
      enqueue(async () => {
        if (reason.kind === 'completed') {
          await observer.attemptFinished({ taskId: turn.taskId, attemptId: turn.attemptId, outcome: 'succeeded' })
          await observer.taskCompleted({ taskId: turn.taskId })
        } else if (reason.kind === 'blocked') {
          // Blocked is not failure: the work is real and still owed.
          await observer.taskBlocked({ taskId: turn.taskId, reason: 'the turn ended blocked' })
        } else if (reason.kind === 'aborted') {
          await observer.attemptFinished({ taskId: turn.taskId, attemptId: turn.attemptId, outcome: 'cancelled' })
          await observer.taskFailed({
            taskId: turn.taskId,
            reason: `cancelled (${reason.reason?.kind ?? 'unknown cause'})`,
          })
        } else {
          await observer.attemptFinished({ taskId: turn.taskId, attemptId: turn.attemptId, outcome: 'failed' })
          await observer.taskFailed({
            taskId: turn.taskId,
            reason: String(reason.error?.message ?? reason.kind ?? 'the turn failed'),
          })
        }
        observer.releaseCorrelation(turn.taskId)
      })
      return
    }

    if (event.type === 'approval/asked') {
      const approvalId = String(event.data.id)
      const taskId = openTaskId(sessionId)
      const reason = event.data.reason ?? `${event.data.toolName} needs approval`
      openApprovals.set(approvalId, { taskId, agentId: entry.agentId })
      enqueue(async () => {
        await observer.approvalRequested({
          approvalId,
          agentId: entry.agentId,
          reason,
          toolName: event.data.toolName,
          taskId,
        })
        if (taskId) await observer.taskAwaitingApproval({ taskId, approvalId, reason })
      })
      return
    }

    if (event.type === 'approval/decided') {
      const approvalId = String(event.data.id)
      const open = openApprovals.get(approvalId) ?? { taskId: openTaskId(sessionId), agentId: entry.agentId }
      openApprovals.delete(approvalId)
      enqueue(async () => {
        await observer.approvalResolved({
          approvalId,
          decision: normalizeApprovalOutcome(event.data.outcome),
          decidedBy: 'human',
          agentId: open.agentId,
          taskId: open.taskId,
        })
        // The Task is unblocked either way; a refusal ends it, an allow resumes it.
        if (open.taskId) {
          await observer.taskStarted({
            taskId: open.taskId,
            agentId: open.agentId,
            attemptId: entry.openTurn?.attemptId,
          })
        }
      })
    }
  })

  return {
    /**
     * Resolve once every observation queued so far has reached the journal.
     * Used on shutdown so pending facts are not lost with the process, and by
     * tests that need a settled journal to assert against.
     */
    drain() {
      return queue
    },

    dispose() {
      for (const disposer of disposers.reverse()) {
        try {
          disposer()
        } catch {
          // A listener already unwound with its scope.
        }
      }
      openCalls.clear()
      openApprovals.clear()
      sessions.clear()
    },
  }
}

/**
 * DSH's `ApprovalOutcome` and iFlow's decision vocabulary agree on three of
 * four values; `allowed-once` is DSH's way of saying allowed exactly here.
 */
function normalizeApprovalOutcome(outcome) {
  switch (outcome) {
    case 'allowed-once':
      return 'allowed'
    case 'rejected':
    case 'cancelled':
    case 'unavailable':
      return outcome
    default:
      return 'unavailable'
  }
}
