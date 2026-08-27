/** Pure half of Node-confirmed browser login; kept byte-identical to Community. */

export function normalizeWebLoginCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return /^[23456789ABCDEFGHJKMNPQRSTWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTWXYZ]{4}$/.test(code)
    ? code
    : undefined
}

export function ownedAgentBindings(declarations, principalId) {
  return (Array.isArray(declarations?.agents) ? declarations.agents : [])
    .filter((agent) => agent && (!agent.principalId || agent.principalId === principalId))
    .map((agent) => ({
      agentId: agent.agentId,
      agentAuthorityDid: agent.did,
      ...(agent.label ? { label: agent.label } : {}),
      relationship: 'owned',
      right: 'send_as',
      scope: ['message'],
      ...(agent.grantRef ? { grantRef: agent.grantRef } : {}),
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.agentAuthorityDid.localeCompare(b.agentAuthorityDid))
}

export function webChallengeSigningPayload({ challenge, nodeId, principal, agentBindings }) {
  return {
    version: 1,
    kind: 'iflow.web-auth.challenge',
    challengeId: challenge.challengeId,
    browserSessionNonce: challenge.browserSessionNonce,
    origin: challenge.origin,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    principalId: principal.principalId,
    authorityDid: principal.authorityDid,
    authorityVersion: principal.authorityVersion,
    requestedScope: challenge.requestedScope,
    viewPublicKeyDigest: challenge.viewKeyId,
    nodeId,
    agentBindings,
  }
}
