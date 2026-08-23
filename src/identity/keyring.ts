/**
 * The keys this node holds, and who they answer to.
 *
 * Identity has two layers. A Principal — a person or an organization — holds
 * one key. Under it, the operator declares Agents, each with a key of its own,
 * bound to the Principal by a grant the Principal signed. A third party can
 * then verify "this Agent is operated by that Principal" without trusting
 * either of them.
 *
 * On disk:
 *
 *   <workspace>/.iflow/identity.json          the node's own key (legacy, kept)
 *   <workspace>/.iflow/principal/             the human's key
 *   <workspace>/.iflow/agents/<agentId>/      one per declared Agent
 *   <workspace>/.iflow/agents.json            the declarations, and their grants
 *
 * One directory per key because that is how `iflow-id` partitions its store
 * (`--home`), which means none of this needs a change to the Rust side. Node-
 * wide state — the revocation registry, the rate card — is addressed with
 * `--node-home` instead, so a grant revoked while acting as one Agent cannot be
 * sidestepped by acting as another.
 *
 * What is NOT here: any of this being automatic. An Agent exists because a
 * person declared it. That is the whole difference between this and the old
 * behaviour, where every runtime session silently became an "Agent" with no
 * key, no owner, and nothing anyone could verify.
 */

const DECLARATIONS = 'agents.json'

/** Where the node-wide state lives — revocations and pricing, never a key. */
export function nodeHome(join, workspace) {
  return workspace
}

export function principalHome(join, workspace) {
  return join(workspace, '.iflow', 'principal')
}

export function agentHome(join, workspace, agentId) {
  return join(workspace, '.iflow', 'agents', agentId)
}

function declarationsPath(join, workspace) {
  return join(workspace, '.iflow', DECLARATIONS)
}

/**
 * Read the declared Agents.
 *
 * A missing file means nobody has declared anything, which is the normal state
 * of a fresh node — not an error. An unreadable one is reported as empty and
 * logged: publishing an Agent this node cannot describe would be worse than
 * publishing none.
 */
export async function loadDeclarations(ctx, join, workspace) {
  try {
    const resolved = await ctx.fs.resolve(declarationsPath(join, workspace))
    const data = JSON.parse(await ctx.fs.readText(resolved))
    const principal = data && typeof data.principal === 'object' ? data.principal : null
    const agents = Array.isArray(data?.agents) ? data.agents : []
    return {
      principal: principal && typeof principal.did === 'string' ? principal : null,
      agents: agents.filter((a) => a && typeof a.agentId === 'string' && typeof a.did === 'string'),
    }
  } catch (err) {
    if (err && (err.code === 'ENOENT' || /not found/i.test(String(err.message)))) {
      return { principal: null, agents: [] }
    }
    console.error('iFlow: could not read the agent declarations', err && err.message ? err.message : err)
    return { principal: null, agents: [] }
  }
}

export async function saveDeclarations(ctx, join, workspace, declarations) {
  const resolved = await ctx.fs.resolve(declarationsPath(join, workspace))
  await ctx.fs.writeText(resolved, JSON.stringify(declarations, null, 2))
}

/**
 * The DID of every declared Agent, by id — what the edge stamps on the events
 * each of them issues, so a verifier checks the right key.
 */
export function agentDidsOf(declarations) {
  const map = {}
  for (const agent of declarations.agents) map[agent.agentId] = agent.did
  return map
}

/**
 * Which key directory a signing request belongs to.
 *
 * Returns undefined when this node holds no key for that identity. The caller
 * must then REFUSE to sign — substituting another key would attribute the
 * event to an Agent whose operator never signed it, and a false attribution is
 * worse than an unsigned fact.
 */
export function homeForSigning(join, workspace, declarations, context) {
  if (!context) return undefined

  if (context.did) {
    if (declarations.principal && declarations.principal.did === context.did) {
      return principalHome(join, workspace)
    }
    const declared = declarations.agents.find((a) => a.did === context.did)
    if (declared) return agentHome(join, workspace, declared.agentId)
    return undefined
  }

  if (context.agentId) {
    const declared = declarations.agents.find((a) => a.agentId === context.agentId)
    if (declared) return agentHome(join, workspace, declared.agentId)
  }

  return undefined
}

/**
 * Create a key in `home` if there is not one already, and return its DID.
 *
 * `create` refuses when an identity already exists, which is the right
 * behaviour for a store that must never silently replace a key — so an
 * existing one is read rather than regenerated.
 */
async function ensureKey(run, home, label) {
  try {
    const shown = await run(['show', '--json'], home)
    const did = JSON.parse(shown).did
    if (did) return did
  } catch {
    // No identity there yet.
  }
  await run(['create', label], home)
  return JSON.parse(await run(['show', '--json'], home)).did
}

/**
 * Declare the Principal: the person or organization this node's Agents answer
 * to. Idempotent — a node that already has one keeps it, because replacing a
 * Principal key would orphan every grant it ever signed.
 */
export async function declarePrincipal(ctx, join, workspace, run, label) {
  const declarations = await loadDeclarations(ctx, join, workspace)
  if (declarations.principal) return declarations.principal

  const did = await ensureKey(run, principalHome(join, workspace), label || 'principal')
  declarations.principal = { did, label: label || 'principal', declaredAt: new Date().toISOString() }
  await saveDeclarations(ctx, join, workspace, declarations)
  return declarations.principal
}

/**
 * Declare an Agent: give it a key, and have the Principal sign a grant naming
 * it as delegate.
 *
 * The grant is the binding. Without it an "Agent" is just another key on the
 * same disk, and nothing connects it to anyone who could be held responsible
 * for what it agrees to — which is the whole point of the second layer.
 *
 * Level L2 by default: enough to confirm a contract, which is what an Agent
 * doing real work needs, and short of L3, which `iflow-id` reserves for
 * something a human authorizes in person.
 */
export async function declareAgent(ctx, join, workspace, run, { agentId, label, capabilities, level, ttlSeconds }) {
  if (!agentId || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(agentId)) {
    throw new Error('agentId must be 1-63 characters of letters, digits and hyphens')
  }

  const declarations = await loadDeclarations(ctx, join, workspace)
  if (!declarations.principal) {
    throw new Error('declare a Principal first: an Agent with nobody behind it cannot be held to anything')
  }
  if (declarations.agents.some((a) => a.agentId === agentId)) {
    throw new Error(`an Agent named ${agentId} is already declared on this node`)
  }

  const caps = (capabilities ?? []).filter((c) => typeof c === 'string' && c.length > 0)
  const did = await ensureKey(run, agentHome(join, workspace, agentId), label || agentId)

  // The Principal signs, so the grant is issued from the Principal's key.
  const expiresAt = Math.floor(Date.now() / 1000) + (Number(ttlSeconds) || 365 * 24 * 3600)
  const args = [
    'grant', 'create', did,
    label || agentId,
    level || 'L2',
    String(expiresAt),
    '--issuer-kind', 'human',
    // `webauthn` is an H2 root, the minimum that may mint above L0. It is a
    // claim about how the key is held, and today this node holds it on disk —
    // recorded honestly so a reader can weigh it, not inflated to H3.
    '--root', 'webauthn',
    '--label', `${label || agentId} delegation`,
  ]
  if (caps.length > 0) args.push('--capabilities', caps.join(','))

  const grantText = await run(args, principalHome(join, workspace))
  const grant = JSON.parse(grantText.replace(/^\s*\/\/.*$/gm, ''))

  const declared = {
    agentId,
    label: label || agentId,
    did,
    capabilities: caps,
    grantRef: grant.grant_id,
    principalDid: declarations.principal.did,
    declaredAt: new Date().toISOString(),
  }
  declarations.agents.push(declared)
  await saveDeclarations(ctx, join, workspace, declarations)
  return { declared, grant }
}
