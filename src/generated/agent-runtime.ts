// GENERATED from iFlow Connect/packages/iflow-adapter-sdk/src/agent-runtime.ts; SHA256 f311c47464dfbf04100faf252d3cd54c64b3a434b051d3108dbc66785c7336fb
// Regenerate: node ../iflow-connect/scripts/sync-connect-snapshots.mjs. Do not edit.
/** Host capabilities used by Connect. Platforms implement ports, not network policy. */
export interface AgentRuntimeDescriptor {
  agentId: string
  did: string
  label?: string
  capabilities?: string[]
}
export interface AgentExecutionRequest {
  requestId: string
  agentId: string
  agentDid: string
  input: unknown
}
export interface AgentAttemptRequest { agentId: string; agentDid: string; attemptId: string }
export type AgentExecutionOutcome = { accepted: true; attemptId: string } | { accepted: false; reason: string }
export type AgentExecutionStatus =
  | { available: true; state: 'working' | 'completed' | 'failed' | 'canceled'; output?: unknown }
  | { available: false; reason: string }
export type AgentCancellationOutcome = { accepted: true } | { accepted: false; reason: string }
export type AgentRuntimeOperation = 'execute' | 'status' | 'cancel'
export interface AgentRuntimePort {
  enumerate(): Promise<readonly AgentRuntimeDescriptor[]>
  describe(agentId: string): Promise<AgentRuntimeDescriptor | undefined>
  /** The host applies execution permissions again before starting work. */
  execute(request: AgentExecutionRequest, agent: AgentRuntimeDescriptor): Promise<AgentExecutionOutcome>
  getStatus?(request: AgentAttemptRequest, agent: AgentRuntimeDescriptor): Promise<AgentExecutionStatus>
  cancel?(request: AgentAttemptRequest, agent: AgentRuntimeDescriptor): Promise<AgentCancellationOutcome>
}
export interface AgentRuntimePolicyPort {
  /** Required local authority check. A directory entry is never an approval. */
  authorize(agent: AgentRuntimeDescriptor, operation: AgentRuntimeOperation, request: AgentExecutionRequest | AgentAttemptRequest): Promise<{ allowed: boolean; reason?: string }>
}
export class AgentRuntimeError extends Error {
  readonly code: 'agent_identity_required' | 'agent_unavailable' | 'agent_authority_changed' | 'permission_denied' | 'invalid_runtime_request'
  constructor(code: AgentRuntimeError['code'], message: string) {
    super(message)
    this.name = 'AgentRuntimeError'
    this.code = code
  }
}
/** Orchestration independent of Sessions, model APIs, transport and process APIs.
 * Callers retain the command ledger for durable idempotency; the service checks
 * the current local identity and policy before every host-side action.
 */
export function createAgentRuntimeService(runtime: AgentRuntimePort, policy: AgentRuntimePolicyPort) {
  async function selectedAgent(agentId: string, expectedDid?: string): Promise<AgentRuntimeDescriptor> {
    if (!agentId) throw new AgentRuntimeError('agent_identity_required', 'An exact local Agent id is required')
    const agent = await runtime.describe(agentId)
    if (!agent || agent.agentId !== agentId || !agent.did) throw new AgentRuntimeError('agent_unavailable', 'The selected Agent is not locally available with a signing identity')
    if (expectedDid !== undefined && agent.did !== expectedDid) throw new AgentRuntimeError('agent_authority_changed', 'The selected Agent identity has changed')
    return agent
  }
  async function authorize(request: AgentExecutionRequest | AgentAttemptRequest, operation: AgentRuntimeOperation): Promise<AgentRuntimeDescriptor> {
    if (!request.agentDid) throw new AgentRuntimeError('agent_identity_required', 'The selected Agent signing identity is required')
    const agent = await selectedAgent(request.agentId, request.agentDid)
    const decision = await policy.authorize(agent, operation, request)
    if (decision.allowed !== true) throw new AgentRuntimeError('permission_denied', decision.reason || 'Local policy refused this operation')
    // Authority may have changed while policy prompted a Principal.
    return selectedAgent(request.agentId, request.agentDid)
  }
  return {
    selectedAgent,
    async enumerate(): Promise<readonly AgentRuntimeDescriptor[]> { return runtime.enumerate() },
    async execute(request: AgentExecutionRequest): Promise<AgentExecutionOutcome> {
      if (!request.requestId) throw new AgentRuntimeError('invalid_runtime_request', 'Execution requires a requestId')
      const agent = await authorize(request, 'execute')
      return runtime.execute(request, agent)
    },
    async getStatus(request: AgentAttemptRequest): Promise<AgentExecutionStatus> {
      if (!request.attemptId) throw new AgentRuntimeError('invalid_runtime_request', 'Status requires an attemptId')
      const agent = await authorize(request, 'status')
      if (!runtime.getStatus) return { available: false, reason: 'Host does not support execution status' }
      return runtime.getStatus(request, agent)
    },
    async cancel(request: AgentAttemptRequest): Promise<AgentCancellationOutcome> {
      if (!request.attemptId) throw new AgentRuntimeError('invalid_runtime_request', 'Cancellation requires an attemptId')
      const agent = await authorize(request, 'cancel')
      if (!runtime.cancel) return { accepted: false, reason: 'Host does not support cancellation' }
      return runtime.cancel(request, agent)
    },
  }
}
