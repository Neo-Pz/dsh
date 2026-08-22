/**
 * Capability identifiers for P2 delegation grants.
 *
 * The rule (P2-GRANT-PROTOCOL.md §8): a capability is `iflow.cap:<domain>.<op>`,
 * or a namespace wildcard, or `*`. Free-form strings are refused — an
 * unvalidated capability id is an authorization decision made on a typo.
 */

/** True when `id` is a well-formed capability identifier. */
export function validCapabilityId(id) {
  if (id === '*') return true
  if (typeof id !== 'string' || !id.startsWith('iflow.cap:')) return false
  const rest = id.slice('iflow.cap:'.length)
  const seg = rest.endsWith('.*') ? rest.slice(0, rest.length - 2) : rest
  if (!seg) return false
  return seg.split('.').every((part) => part.length > 0 && /^[a-z0-9_-]+$/.test(part))
}

/**
 * Map a legacy scope name onto its capability id.
 *
 * `agent-task` predates the `iflow.cap:` scheme and still arrives from older
 * peers, so it is translated rather than rejected.
 */
export function normalizeAction(action) {
  if (action === 'agent-task') return 'iflow.cap:agent.run'
  return action
}
