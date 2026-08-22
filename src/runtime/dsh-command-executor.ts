/**
 * The command path: how a Hub asks THIS node to do something.
 *
 * The rule the architecture fixes, and this file exists to keep:
 *
 *   Hub or Community requests an action
 *     -> edge adapter verifies identity, grant, budget and local DSH policy
 *     -> DSH executes or rejects
 *     -> edge adapter publishes the outcome as events
 *
 * Two properties are non-negotiable here:
 *
 * 1. Fail closed. Commands are refused entirely unless the operator turned
 *    them on (`config.acceptCommands`). A read-only Hub must never become a
 *    remote control by accident.
 *
 * 2. No bypass. Nothing in this file can grant a permission DSH would deny.
 *    The approval bridge RACES the normal DSH approver rather than replacing
 *    it: the Task Room becomes an additional place a human can answer from,
 *    never a way around the local one.
 *
 * At-most-once execution is not handled here — `CommandLedger` in the SDK
 * settles that before an executor is ever called.
 */

/**
 * The actions this edge understands. Anything else is refused by name.
 *
 * An action may carry one argument after a colon — `approval.resolve:reject`.
 * The envelope has no free-form parameter field by design, and smuggling a
 * decision through `grantRef` or `budgetConstraint` would mean two different
 * things travelling in one field.
 */
export const SUPPORTED_ACTIONS = ['task.cancel', 'approval.resolve']

/** Split `verb:argument` into its parts. */
function parseAction(requestedAction) {
  const raw = String(requestedAction ?? '')
  const separator = raw.indexOf(':')
  return separator === -1
    ? { verb: raw, argument: undefined }
    : { verb: raw.slice(0, separator), argument: raw.slice(separator + 1) }
}

const APPROVAL_DECISIONS = {
  allow: 'allowed-once',
  allowed: 'allowed-once',
  'allowed-once': 'allowed-once',
  reject: 'rejected',
  rejected: 'rejected',
  deny: 'rejected',
}

function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * Track live DSH agents so a command can name one.
 *
 * Keyed by the same `agent-<sessionId>` identity the instrumentation journals,
 * so a Hub can act on exactly what it can see.
 */
export function createAgentRegistry(ctx) {
  const agents = new Map()
  const disposers = [
    ctx.on('agent/created', ({ agent }) => agents.set(`agent-${agent.id}`, agent), { global: true }),
    ctx.on('agent/disposed', ({ agent }) => agents.delete(`agent-${agent.id}`), { global: true }),
  ]
  return {
    get: (agentId) => agents.get(agentId),
    /** Resolve from either an agent id or the task id derived from the same session. */
    resolve(target) {
      if (target.agentId && agents.get(target.agentId)) return agents.get(target.agentId)
      if (target.taskId && target.taskId.startsWith('task-')) {
        return agents.get(`agent-${target.taskId.slice('task-'.length)}`)
      }
      return undefined
    },
    size: () => agents.size,
    dispose() {
      for (const disposer of disposers) {
        try {
          disposer()
        } catch {
          // Already unwound with its scope.
        }
      }
      agents.clear()
    },
  }
}

/**
 * Let a Hub answer an approval, without removing DSH's own answer.
 *
 * The listener returns whichever outcome arrives first: a command from the Hub,
 * or the decision the rest of DSH's approval chain produces. The local prompt
 * still appears and still counts, so this adds a surface rather than replacing
 * the enforcement point.
 */
export function createApprovalBridge(ctx, options = {}) {
  const parked = new Map()
  let disposer

  if (options.enabled === true) {
    disposer = ctx.on(
      'approval/request',
      async (request, next) => {
        const agentId = request?.agent?.id ? `agent-${request.agent.id}` : undefined
        if (!agentId) return next()

        const pending = deferred()
        const waiting = parked.get(agentId) ?? []
        waiting.push(pending)
        parked.set(agentId, waiting)

        try {
          // Whoever answers first wins. `next()` runs the normal chain, so a
          // human at the DSH prompt is never locked out by a pending command.
          return await Promise.race([pending.promise, next()])
        } finally {
          const remaining = (parked.get(agentId) ?? []).filter((entry) => entry !== pending)
          if (remaining.length > 0) parked.set(agentId, remaining)
          else parked.delete(agentId)
        }
      },
      { global: true },
    )
  }

  return {
    enabled: options.enabled === true,
    /** Answer the oldest parked approval for an agent. False when none is waiting. */
    answer(agentId, outcome) {
      const waiting = parked.get(agentId)
      if (!waiting || waiting.length === 0) return false
      waiting.shift().resolve(outcome)
      return true
    },
    pendingCount: () => [...parked.values()].reduce((total, list) => total + list.length, 0),
    dispose() {
      if (disposer) {
        try {
          disposer()
        } catch {
          // Already unwound.
        }
      }
      // Release anything still parked so no turn hangs on our teardown.
      for (const waiting of parked.values()) for (const entry of waiting) entry.resolve(undefined)
      parked.clear()
    },
  }
}

/**
 * @param options.enabled       operator opt-in; false refuses every command
 * @param options.nodeId        this node's id, so misrouted commands are refused
 * @param options.registry      agent registry from `createAgentRegistry`
 * @param options.approvals     bridge from `createApprovalBridge`
 * @param options.observer      the edge's RuntimeObserver, to journal outcomes
 */
export function createDshCommandExecutor(options) {
  const { registry, approvals, observer, nodeId } = options

  return {
    async execute(command) {
      if (options.enabled !== true) {
        return {
          accepted: false,
          reason: 'this node does not accept commands (set config.acceptCommands: true to enable)',
        }
      }

      // A command addressed to another node is refused, never "helpfully"
      // executed here.
      if (command.target?.nodeId && command.target.nodeId !== nodeId) {
        return { accepted: false, reason: `command targets node ${command.target.nodeId}, not ${nodeId}` }
      }

      const { verb, argument } = parseAction(command.requestedAction)
      if (!SUPPORTED_ACTIONS.includes(verb)) {
        return {
          accepted: false,
          reason: `unsupported action ${command.requestedAction}; this node accepts ${SUPPORTED_ACTIONS.join(', ')}`,
        }
      }

      if (verb === 'task.cancel') {
        const agent = registry.resolve(command.target ?? {})
        if (!agent) return { accepted: false, reason: 'no live agent matches this command target' }
        try {
          agent.cancel({ kind: 'parent' })
        } catch (error) {
          return { accepted: false, reason: `DSH refused the cancellation: ${String(error?.message ?? error)}` }
        }
        const attemptId = `cmd-${command.commandId}`
        if (command.target?.taskId) {
          await observer.taskFailed({
            taskId: command.target.taskId,
            reason: `cancelled by ${command.issuer?.id ?? 'a hub'}`,
          })
        }
        return { accepted: true, attemptId }
      }

      // approval.resolve
      if (!approvals.enabled) {
        return { accepted: false, reason: 'this node does not route approvals through iFlow' }
      }
      const agentId = command.target?.agentId
        ?? (command.target?.taskId?.startsWith('task-')
          ? `agent-${command.target.taskId.slice('task-'.length)}`
          : undefined)
      if (!agentId) return { accepted: false, reason: 'approval.resolve needs a target agentId or taskId' }

      const requested = String(argument ?? 'allow').toLowerCase()
      const outcome = APPROVAL_DECISIONS[requested]
      if (!outcome) {
        return { accepted: false, reason: `unknown approval decision ${requested}` }
      }

      const answered = approvals.answer(agentId, outcome)
      if (!answered) {
        return { accepted: false, reason: 'no approval is waiting for that agent' }
      }
      return { accepted: true, attemptId: `cmd-${command.commandId}` }
    },
  }
}
