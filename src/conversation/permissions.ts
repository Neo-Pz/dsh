/**
 * Standing permission for one pair of Agents to keep talking.
 *
 * The acceptance gate exists so a STRANGER cannot make this machine spend a
 * model. Once a person has looked at a first contact and said yes, the peer is
 * not a stranger any more and the gate has done its job — asking again on the
 * next thread is not more safety, it is the same question with a worse answer
 * rate. This is what turns that one click into a durable fact.
 *
 * Deliberately NOT in `trust.json`. That file is the operator's hand-written
 * posture, and the panel says so in as many words — no switches, edit the
 * config. What accumulates here is different in kind: granted by clicking,
 * listed individually, and revocable one pair at a time.
 *
 * Keyed on DIDs, never labels. A label is whatever the far side puts in a
 * metadata field; a DID is what they proved. Granting standing permission to a
 * name would let anyone inherit it by claiming the name.
 *
 * What it permits is exactly one thing: messages may arrive without a person
 * being asked first. It is not authority to run a tool, spend anything, or
 * settle a Task — those are separate questions with separate answers, and the
 * whole architecture rests on them not collapsing into each other.
 */

const PERMISSIONS = 'permissions.json'

export function permissionsPath(join, workspace) {
  return join(workspace, '.iflow', PERMISSIONS)
}

const pairKey = (localAgentDid, peerAgentDid) => `${localAgentDid}|${peerAgentDid}`

export function emptyPermissions() {
  return { pairs: {} }
}

export async function loadPermissions(ctx, join, workspace) {
  try {
    const resolved = await ctx.fs.resolve(permissionsPath(join, workspace))
    const data = JSON.parse(await ctx.fs.readText(resolved))
    const pairs = {}
    for (const [key, value] of Object.entries(data?.pairs ?? {})) {
      if (!value || typeof value !== 'object') continue
      if (typeof value.localAgentDid !== 'string' || typeof value.peerAgentDid !== 'string') continue
      if (value.messaging !== 'allowed' && value.messaging !== 'blocked') continue
      pairs[key] = {
        localAgentDid: value.localAgentDid,
        peerAgentDid: value.peerAgentDid,
        peerLabel: typeof value.peerLabel === 'string' ? value.peerLabel : null,
        localAgentId: typeof value.localAgentId === 'string' ? value.localAgentId : null,
        messaging: value.messaging,
        grantedAt: typeof value.grantedAt === 'string' ? value.grantedAt : null,
        grantedBy: value.grantedBy === 'human' ? 'human' : 'policy',
        revokedAt: typeof value.revokedAt === 'string' ? value.revokedAt : null,
      }
    }
    return { pairs }
  } catch (error) {
    // A missing file is the normal state of a fresh node. An unreadable one must
    // not become permissive by accident: an empty set means every first contact
    // still asks, which is the safe direction to fail in.
    return emptyPermissions()
  }
}

export async function savePermissions(ctx, join, workspace, permissions) {
  const resolved = await ctx.fs.resolve(permissionsPath(join, workspace))
  await ctx.fs.writeText(resolved, `${JSON.stringify(permissions, null, 2)}\n`)
}

/**
 * May this pair exchange messages without asking a person again?
 *
 * Returns `null` when nothing has been decided, which is different from a
 * refusal — the caller falls through to the ordinary trust policy, and a
 * stranger still stops at the gate.
 */
export function messagingPermission(permissions, localAgentDid, peerAgentDid) {
  if (!localAgentDid || !peerAgentDid) return null
  const pair = permissions.pairs[pairKey(localAgentDid, peerAgentDid)]
  if (!pair || pair.revokedAt) return null
  return pair.messaging
}

/**
 * Record that a person allowed this pair to keep talking.
 *
 * Only ever called with a peer DID that was actually verified. An unsigned peer
 * has nothing durable to grant permission TO, so accepting its thread accepts
 * that thread and no more — the caller is responsible for not inventing a key.
 */
export function allowPair(permissions, { localAgentDid, peerAgentDid, localAgentId, peerLabel, now }) {
  if (!localAgentDid || !peerAgentDid) return null
  const key = pairKey(localAgentDid, peerAgentDid)
  const pair = {
    localAgentDid,
    peerAgentDid,
    localAgentId: localAgentId ?? null,
    peerLabel: peerLabel ?? null,
    messaging: 'allowed',
    grantedAt: now ?? new Date().toISOString(),
    grantedBy: 'human',
    revokedAt: null,
  }
  permissions.pairs[key] = pair
  return pair
}

/**
 * Withdraw it. The record stays, marked revoked rather than deleted: a person
 * asking "did I ever allow this" deserves an answer, and a removed row answers
 * the same as one that never existed.
 */
export function revokePair(permissions, localAgentDid, peerAgentDid, now) {
  const pair = permissions.pairs[pairKey(localAgentDid, peerAgentDid)]
  if (!pair || pair.revokedAt) return null
  pair.revokedAt = now ?? new Date().toISOString()
  pair.messaging = 'blocked'
  return pair
}

/** Every pair currently allowed, for a panel that has to show what was granted. */
export function allowedPairs(permissions) {
  return Object.values(permissions.pairs)
    .filter((pair) => !pair.revokedAt && pair.messaging === 'allowed')
    .sort((a, b) => String(b.grantedAt).localeCompare(String(a.grantedAt)))
}
