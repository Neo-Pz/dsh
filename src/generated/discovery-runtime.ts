// GENERATED from iFlow Connect/packages/iflow-adapter-sdk/src/discovery-runtime.ts; SHA256 ae48d0c5315aeaa01b06d3defe88ce7fb7a619b1a728a7cb14ceadd655a2dd76
// Regenerate: node ../iflow-connect/scripts/sync-connect-snapshots.mjs. Do not edit.
import { isPublicArdUrl, parseArdSearchRequest, isArdSearchResponse, validateAgentDiscoveryProfile } from './ard.ts'
import type { AgentDiscoveryProfile, ArdSearchRequest, DiscoverySearchView } from './ard.ts'
import type { IFlowEvidence } from 'iflow-protocol'

export interface DiscoveryAgent { agentId: string; did: string; label?: string; capabilities?: string[] }
export type AgentPublicInterface = AgentDiscoveryProfile['card']['supportedInterfaces'][number]
export interface DiscoveryPublicationContext {
  enabled: boolean
  nodeId: string
  runtimeKind: string
  version: string
  /** Explicit Agent endpoint. Hosts may expose a direct route or a relay route. */
  agentInterface: AgentPublicInterface
  evidenceSource?: IFlowEvidence['source']
}
export interface DiscoveryPublishArgs {
  action: 'publish' | 'withdraw'
  fromAgentId: string
  confirmPublic?: boolean
  description?: string
  representativeQueries?: string[]
  tags?: string[]
}
/** Structural subset of the OriginJournal input; a host can supply any journal
 * with this contract without depending on a filesystem or SDK implementation.
 */
export interface DiscoveryRegistrationInput {
  type: 'agent.registered'
  visibility: 'public'
  subject: { kind: 'agent'; id: string }
  issuer: { kind: 'agent'; id: string; did: string }
  evidence: { source: IFlowEvidence['source'] }
  payload: { label: string; did: string; nodeId: string; runtimeKind: string; capabilities: string[]; discovery: AgentDiscoveryProfile | null }
}
export interface DiscoveryRuntimePorts {
  selectedAgent(agentId: string): Promise<DiscoveryAgent>
  publicationContext(): Promise<DiscoveryPublicationContext>
  record(input: DiscoveryRegistrationInput): Promise<{ id?: string; evidence?: { signature?: string } } | undefined>
  requestSearch(agent: DiscoveryAgent, input: ArdSearchRequest): Promise<{ registry: string; response: unknown }>
}
/** Host-independent ARD behavior. Search never executes or grants a candidate. */
export function createDiscoveryRuntime({ selectedAgent, publicationContext, record, requestSearch }: DiscoveryRuntimePorts) {
  return {
    async search(fromAgentId: string, request: unknown): Promise<DiscoverySearchView> {
      const agent = await selectedAgent(fromAgentId)
      const input = parseArdSearchRequest(request)
      const { registry, response } = await requestSearch(agent, input)
      if (!isArdSearchResponse(response)) throw new Error('Registry returned an invalid ARD search response')
      return { version: 1, kind: 'discovery.results', ownAgentId: agent.agentId, registry, matching: 'keyword', response }
    },
    async publish(args: DiscoveryPublishArgs) {
      if (args.confirmPublic !== true) throw new Error('Confirm publication of the description, examples, capabilities and public Agent endpoint with confirmPublic=true')
      const agent = await selectedAgent(args.fromAgentId)
      const context = await publicationContext()
      if (!context.enabled) throw new Error('Enable Community publication explicitly before publishing discovery data')
      let discovery: AgentDiscoveryProfile | null = null
      if (args.action !== 'withdraw') {
        if (!isPublicArdUrl(context.agentInterface?.url)) throw new Error('ARD publication requires an explicitly configured public HTTPS URL without credentials, query or local address')
        const description = args.description
        const representativeQueries = args.representativeQueries
        const tags = args.tags ?? []
        const profile: unknown = {
          description, representativeQueries, tags,
          card: {
            name: agent.label || agent.agentId, description, version: context.version,
            supportedInterfaces: [{ ...context.agentInterface }],
            capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
            defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'],
            skills: [{ id: 'agent-task', name: 'Agent task', description, tags, examples: representativeQueries }],
            identity: { did: agent.did, agentId: agent.agentId },
          },
        }
        if (!validateAgentDiscoveryProfile(profile, agent.agentId, agent.did)) throw new Error('Description must contain 1–2048 characters, with 2–5 public query examples and at most 20 tags')
        discovery = profile
      }
      const event = await record({
        type: 'agent.registered', visibility: 'public', subject: { kind: 'agent', id: agent.agentId },
        issuer: { kind: 'agent', id: agent.agentId, did: agent.did },
        evidence: { source: context.evidenceSource ?? 'projection' },
        payload: { label: agent.label || agent.agentId, did: agent.did, nodeId: context.nodeId, runtimeKind: context.runtimeKind, capabilities: agent.capabilities ?? [], discovery },
      })
      if (!event?.evidence?.signature) throw new Error('Discovery publication could not be signed by the selected Agent; it will not enter the public catalog')
      return { ok: true, state: args.action === 'withdraw' ? 'withdrawal_queued' : 'publication_queued', agentId: agent.agentId, eventId: event.id }
    },
  }
}
