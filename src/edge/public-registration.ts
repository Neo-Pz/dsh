/**
 * A historical registration is reusable only when it is the public,
 * Agent-attributed fact the Community can accept.
 *
 * Identity bootstrap deliberately journals unsigned facts instead of losing
 * them. Once the binary/keyring is repaired those unsigned rows remain useful
 * local history, but they must not suppress a fresh signed registration or an
 * Agent will heartbeat in the relay without ever appearing in Discover.
 */
export function hasPublishableAgentRegistration(events, agent) {
  return events.some((event) =>
    event.type === 'agent.registered' &&
    event.subject?.id === agent.agentId &&
    event.visibility === 'public' &&
    event.issuer?.kind === 'agent' &&
    event.issuer?.id === agent.agentId &&
    event.issuer?.did === agent.did &&
    event.payload?.did === agent.did &&
    typeof event.evidence?.signature === 'string' &&
    event.evidence.signature.length > 0,
  )
}
