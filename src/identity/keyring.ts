/**
 * Stable Principal, rotatable Authority, Node and Agent key separation.
 *
 * Principal Authority keys live in the user's iFlowOne home. A workspace only
 * stores a binding to one Principal plus Node- and Agent-local state.
 *
 *   ~/.iflowone/principals.json                         private registry
 *   ~/.iflowone/principals/<id>/authority-v1/.iflow/   Authority key
 *   <workspace>/.iflow/principal-binding.json          selected Principal
 *   <workspace>/.iflow/agents/<agentId>/               Agent keys
 *   <workspace>/.iflow/agents.json                     Agent declarations
 *
 * Legacy builds stored the Authority at `<workspace>/.iflow/principal/` and
 * embedded `{ did, label }` in agents.json. That remains readable, but is
 * never migrated automatically. Explicit migration backs it up, verifies the
 * expected DID, copies rather than moves the key, and only then binds it.
 */

import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

const DECLARATIONS = 'agents.json'
const BINDING = 'principal-binding.json'
const REGISTRY = 'principals.json'
const MIGRATION_RECEIPT = 'principal-migration.json'
const PRINCIPAL_PREFIX = 'iflow:principal:'

/** Node-wide state — revocations and pricing, never a Principal key. */
export function nodeHome(_join, workspace) {
  return workspace
}

/** Old workspace-scoped Authority home. Read for migration and rollback only. */
export function legacyPrincipalHome(join, workspace) {
  return join(workspace, '.iflow', 'principal')
}

/** Compatibility export for code which needs to locate the legacy directory. */
export const principalHome = legacyPrincipalHome

/** Default user-level iFlowOne state. Tests/deployments may override it. */
export function defaultPrincipalStoreRoot(join, env = process.env, userHome = homedir()) {
  const configured = typeof env.IFLOWONE_HOME === 'string' ? env.IFLOWONE_HOME.trim() : ''
  if (configured) return configured
  if (!userHome) throw new Error('cannot locate a user home for the stable Principal store; set IFLOWONE_HOME')
  return join(userHome, '.iflowone')
}

function principalSegment(principalId) {
  if (typeof principalId !== 'string' || !principalId.startsWith(PRINCIPAL_PREFIX)) {
    throw new Error('principalId must use the iflow:principal: namespace')
  }
  const segment = principalId.slice(PRINCIPAL_PREFIX.length)
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(segment)) throw new Error('principalId contains an unsafe storage identifier')
  return segment
}

/** Base passed to iflow-id for one versioned Authority key. */
export function authorityHome(join, principalStoreRoot, principalId, authorityVersion = 1) {
  if (!Number.isSafeInteger(authorityVersion) || authorityVersion < 1) {
    throw new Error('authorityVersion must be a positive integer')
  }
  return join(principalStoreRoot, 'principals', principalSegment(principalId), `authority-v${authorityVersion}`)
}

export function agentHome(join, workspace, agentId) {
  return join(workspace, '.iflow', 'agents', agentId)
}

const declarationsPath = (join, workspace) => join(workspace, '.iflow', DECLARATIONS)
const bindingPath = (join, workspace) => join(workspace, '.iflow', BINDING)
const registryPath = (join, root) => join(root, REGISTRY)
const migrationReceiptPath = (join, workspace) => join(workspace, '.iflow', MIGRATION_RECEIPT)

function missing(error) {
  return error && (error.code === 'ENOENT' || /not found|no such file/i.test(String(error.message)))
}

async function readWorkspaceJson(ctx, path) {
  try {
    const resolved = await ctx.fs.resolve(path)
    return JSON.parse(await ctx.fs.readText(resolved))
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

async function writeWorkspaceJson(ctx, path, value) {
  const resolved = await ctx.fs.resolve(path)
  await ctx.fs.writeText(resolved, JSON.stringify(value, null, 2))
}

function readLocalJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (missing(error)) return fallback
    throw error
  }
}

/** Atomic so a crash cannot turn the identity registry into half JSON. */
function writeLocalJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

function stableBinding(value) {
  if (!value || typeof value !== 'object') return null
  if (typeof value.principalId !== 'string' || typeof value.authorityDid !== 'string') return null
  const authorityVersion = Number(value.authorityVersion)
  if (!Number.isSafeInteger(authorityVersion) || authorityVersion < 1) return null
  return {
    principalId: value.principalId,
    authorityDid: value.authorityDid,
    authorityVersion,
    label: typeof value.label === 'string' ? value.label : undefined,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : undefined,
    boundAt: typeof value.boundAt === 'string' ? value.boundAt : undefined,
    source: typeof value.source === 'string' ? value.source : undefined,
  }
}

function legacyBinding(value) {
  if (!value || typeof value !== 'object' || typeof value.did !== 'string') return null
  return {
    principalId: null,
    authorityDid: value.did,
    authorityVersion: 1,
    did: value.did,
    label: typeof value.label === 'string' ? value.label : 'principal',
    declaredAt: typeof value.declaredAt === 'string' ? value.declaredAt : undefined,
    legacy: true,
  }
}

/** Read the workspace binding and declared Agents. Missing files mean fresh state. */
export async function loadDeclarations(ctx, join, workspace) {
  let declarationData
  let bindingData
  try {
    declarationData = await readWorkspaceJson(ctx, declarationsPath(join, workspace))
  } catch (error) {
    console.error('iFlow: could not read the agent declarations', error?.message ?? error)
  }
  try {
    bindingData = await readWorkspaceJson(ctx, bindingPath(join, workspace))
  } catch (error) {
    console.error('iFlow: could not read the Principal binding', error?.message ?? error)
  }

  const agents = Array.isArray(declarationData?.agents) ? declarationData.agents : []
  return {
    principal: stableBinding(bindingData) ?? legacyBinding(declarationData?.principal),
    agents: agents.filter((agent) => agent && typeof agent.agentId === 'string' && typeof agent.did === 'string'),
  }
}

/** agents.json holds Agents only; Principal binding has a separate lifecycle. */
export async function saveDeclarations(ctx, join, workspace, declarations) {
  await writeWorkspaceJson(ctx, declarationsPath(join, workspace), {
    schemaVersion: 2,
    agents: Array.isArray(declarations?.agents) ? declarations.agents : [],
  })
}

export function loadPrincipalRegistry(join, principalStoreRoot) {
  const data = readLocalJson(registryPath(join, principalStoreRoot), { schemaVersion: 1, principals: [] })
  const principals = Array.isArray(data?.principals) ? data.principals.map(stableBinding).filter(Boolean) : []
  return { schemaVersion: 1, principals }
}

function savePrincipalRegistry(join, principalStoreRoot, registry) {
  writeLocalJson(registryPath(join, principalStoreRoot), { schemaVersion: 1, principals: registry.principals })
}

export async function bindPrincipal(ctx, join, workspace, principalStoreRoot, run, principalId) {
  const declarations = await loadDeclarations(ctx, join, workspace)
  if (declarations.principal?.legacy) {
    throw new Error('this workspace has a legacy Principal; run the explicit migration before binding another one')
  }
  if (declarations.principal) {
    if (declarations.principal.principalId === principalId) return declarations.principal
    throw new Error('this workspace is already bound to another Principal')
  }

  const selected = loadPrincipalRegistry(join, principalStoreRoot).principals
    .find((principal) => principal.principalId === principalId)
  if (!selected) throw new Error('the selected Principal is not present in this user profile')
  const storedDid = JSON.parse(
    await run(['show', '--json'], authorityHome(join, principalStoreRoot, selected.principalId, selected.authorityVersion)),
  ).did
  if (storedDid !== selected.authorityDid) {
    throw new Error('the selected Principal Authority key does not match its private registry')
  }
  const binding = { ...selected, boundAt: new Date().toISOString(), source: 'selected' }
  await writeWorkspaceJson(ctx, bindingPath(join, workspace), binding)
  return binding
}

export function agentDidsOf(declarations) {
  const map = {}
  for (const agent of declarations.agents) map[agent.agentId] = agent.did
  return map
}

/** Unknown named identities are refused; unnamed observations use the Node key. */
export function homeForSigning(join, workspace, declarations, context, nodeDid, principalStoreRoot) {
  if (!context) return nodeHome(join, workspace)
  if (context.did) {
    if (nodeDid && context.did === nodeDid) return nodeHome(join, workspace)
    const principal = declarations.principal
    if (principal && (principal.authorityDid === context.did || principal.did === context.did)) {
      if (principal.legacy) return legacyPrincipalHome(join, workspace)
      if (!principalStoreRoot) return undefined
      return authorityHome(join, principalStoreRoot, principal.principalId, principal.authorityVersion)
    }
    const declared = declarations.agents.find((agent) => agent.did === context.did)
    if (declared) return agentHome(join, workspace, declared.agentId)
    return undefined
  }
  if (context.agentId) {
    const declared = declarations.agents.find((agent) => agent.agentId === context.agentId)
    if (declared) return agentHome(join, workspace, declared.agentId)
  }
  return nodeHome(join, workspace)
}

async function ensureKey(run, home, label) {
  try {
    const did = JSON.parse(await run(['show', '--json'], home)).did
    if (did) return did
  } catch {
    // No identity there yet.
  }
  await run(['create', label], home)
  return JSON.parse(await run(['show', '--json'], home)).did
}

/** Create a stable Principal in the user profile and bind this workspace. */
export async function declarePrincipal(ctx, join, workspace, principalStoreRoot, run, label) {
  const declarations = await loadDeclarations(ctx, join, workspace)
  if (declarations.principal) {
    if (declarations.principal.legacy) throw new Error('migrate the legacy workspace Principal before declaring another one')
    return declarations.principal
  }

  const principalId = `${PRINCIPAL_PREFIX}${randomUUID()}`
  const authorityVersion = 1
  const authorityDid = await ensureKey(
    run,
    authorityHome(join, principalStoreRoot, principalId, authorityVersion),
    label || 'principal',
  )
  const now = new Date().toISOString()
  const document = { principalId, authorityDid, authorityVersion, label: label || 'principal', createdAt: now }
  const registry = loadPrincipalRegistry(join, principalStoreRoot)
  registry.principals.push(document)
  savePrincipalRegistry(join, principalStoreRoot, registry)

  const binding = { ...document, boundAt: now, source: 'created' }
  await writeWorkspaceJson(ctx, bindingPath(join, workspace), binding)
  return binding
}

/** Dry-run only. It never creates, copies, binds or edits. */
export async function planPrincipalMigration(ctx, join, workspace, principalStoreRoot) {
  const declarations = await loadDeclarations(ctx, join, workspace)
  if (!declarations.principal) return { state: 'none' }
  if (!declarations.principal.legacy) return { state: 'complete', principal: declarations.principal }

  const legacyAuthorityDid = declarations.principal.authorityDid
  const matches = loadPrincipalRegistry(join, principalStoreRoot).principals
    .filter((principal) => principal.authorityDid === legacyAuthorityDid)
  if (matches.length > 1) {
    return { state: 'ambiguous', legacyAuthorityDid, candidates: matches.map((item) => item.principalId) }
  }
  return {
    state: 'required',
    legacyAuthorityDid,
    label: declarations.principal.label,
    action: matches.length === 1 ? 'bind-existing' : 'import-new',
    targetPrincipalId: matches[0]?.principalId ?? null,
    agentCount: declarations.agents.length,
    legacyKeyRetained: true,
    backupRequired: true,
  }
}

function backupLegacyState(join, workspace) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = join(workspace, '.iflow', 'backups', `principal-${stamp}`)
  mkdirSync(backup, { recursive: true })
  const legacyKey = legacyPrincipalHome(join, workspace)
  if (existsSync(legacyKey)) cpSync(legacyKey, join(backup, 'principal'), { recursive: true, errorOnExist: true })
  const agents = declarationsPath(join, workspace)
  if (existsSync(agents)) cpSync(agents, join(backup, DECLARATIONS), { errorOnExist: true })
  writeLocalJson(join(backup, 'manifest.json'), {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    legacyPrincipalHome: legacyKey,
    agentsPath: agents,
  })
  return backup
}

/** Execute an explicit migration, bound to the DID observed in its dry-run. */
export async function migrateLegacyPrincipal(
  ctx,
  join,
  workspace,
  principalStoreRoot,
  run,
  { expectedAuthorityDid, targetPrincipalId } = {},
) {
  const plan = await planPrincipalMigration(ctx, join, workspace, principalStoreRoot)
  if (plan.state === 'complete') return { migrated: false, idempotent: true, principal: plan.principal }
  if (plan.state !== 'required') throw new Error(`legacy Principal migration is not executable (${plan.state})`)
  if (!expectedAuthorityDid || expectedAuthorityDid !== plan.legacyAuthorityDid) {
    throw new Error('legacy Authority DID changed since the dry-run; inspect the migration again')
  }

  const shown = JSON.parse(await run(['show', '--json'], legacyPrincipalHome(join, workspace)))
  if (shown.did !== expectedAuthorityDid) {
    throw new Error('the legacy key on disk does not match agents.json; refusing migration')
  }

  const registry = loadPrincipalRegistry(join, principalStoreRoot)
  let document
  if (plan.action === 'bind-existing') {
    if (targetPrincipalId && targetPrincipalId !== plan.targetPrincipalId) {
      throw new Error('target Principal does not match the dry-run')
    }
    document = registry.principals.find((principal) => principal.principalId === plan.targetPrincipalId)
    if (!document) throw new Error('the Principal selected by the dry-run no longer exists')
    const targetDid = JSON.parse(
      await run(['show', '--json'], authorityHome(join, principalStoreRoot, document.principalId, document.authorityVersion)),
    ).did
    if (targetDid !== expectedAuthorityDid) throw new Error('the selected Principal Authority key does not match its registry')
  } else {
    if (targetPrincipalId) throw new Error('a new Principal import cannot target an unrelated Principal')
    document = {
      principalId: `${PRINCIPAL_PREFIX}${randomUUID()}`,
      authorityDid: expectedAuthorityDid,
      authorityVersion: 1,
      label: plan.label || 'principal',
      createdAt: new Date().toISOString(),
    }
  }

  // Backup before the first mutation. The legacy key remains after success.
  const backupPath = backupLegacyState(join, workspace)
  if (plan.action === 'import-new') {
    const target = authorityHome(join, principalStoreRoot, document.principalId, document.authorityVersion)
    if (existsSync(target)) throw new Error('refusing to overwrite an existing Authority directory')
    mkdirSync(dirname(target), { recursive: true })
    cpSync(legacyPrincipalHome(join, workspace), target, { recursive: true, errorOnExist: true })
    const copiedDid = JSON.parse(await run(['show', '--json'], target)).did
    if (copiedDid !== expectedAuthorityDid) throw new Error('copied Authority failed post-copy verification')
    registry.principals.push(document)
    savePrincipalRegistry(join, principalStoreRoot, registry)
  }

  const now = new Date().toISOString()
  const binding = { ...document, boundAt: now, source: 'migrated' }
  const declarations = await loadDeclarations(ctx, join, workspace)
  const agents = declarations.agents.map((agent) => {
    const { principalDid: _legacyPrincipalDid, ...rest } = agent
    return {
      ...rest,
      principalId: document.principalId,
      authorityDid: document.authorityDid,
      authorityVersion: document.authorityVersion,
    }
  })
  await saveDeclarations(ctx, join, workspace, { agents })
  await writeWorkspaceJson(ctx, bindingPath(join, workspace), binding)
  await writeWorkspaceJson(ctx, migrationReceiptPath(join, workspace), {
    schemaVersion: 1,
    migratedAt: now,
    principalId: document.principalId,
    authorityDid: document.authorityDid,
    authorityVersion: document.authorityVersion,
    backupPath,
    legacyKeyRetained: true,
  })
  return { migrated: true, principal: binding, backupPath, legacyKeyRetained: true }
}

/** Declare an Agent and have the selected Principal Authority sign its grant. */
export async function declareAgent(
  ctx,
  join,
  workspace,
  principalStoreRoot,
  run,
  { agentId, label, capabilities, level, ttlSeconds },
) {
  if (!agentId || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(agentId)) {
    throw new Error('agentId must be 1-63 characters of letters, digits and hyphens')
  }
  const declarations = await loadDeclarations(ctx, join, workspace)
  if (!declarations.principal) throw new Error('bind a Principal first: an Agent with nobody behind it cannot be held to anything')
  if (declarations.principal.legacy) throw new Error('migrate the legacy Principal before declaring another Agent')
  if (declarations.agents.some((agent) => agent.agentId === agentId)) {
    throw new Error(`an Agent named ${agentId} is already declared on this node`)
  }

  const caps = (capabilities ?? []).filter((capability) => typeof capability === 'string' && capability.length > 0)
  const did = await ensureKey(run, agentHome(join, workspace, agentId), label || agentId)
  const expiresAt = Math.floor(Date.now() / 1000) + (Number(ttlSeconds) || 365 * 24 * 3600)
  const args = [
    'grant', 'create', did, label || agentId, level || 'L2', String(expiresAt),
    '--issuer-kind', 'human', '--root', 'webauthn', '--label', `${label || agentId} delegation`,
  ]
  if (caps.length > 0) args.push('--capabilities', caps.join(','))

  const authority = authorityHome(
    join,
    principalStoreRoot,
    declarations.principal.principalId,
    declarations.principal.authorityVersion,
  )
  const grantText = await run(args, authority)
  const grant = JSON.parse(grantText.replace(/^\s*\/\/.*$/gm, ''))
  const declared = {
    agentId,
    label: label || agentId,
    did,
    capabilities: caps,
    grantRef: grant.grant_id,
    principalId: declarations.principal.principalId,
    authorityDid: declarations.principal.authorityDid,
    authorityVersion: declarations.principal.authorityVersion,
    declaredAt: new Date().toISOString(),
  }
  declarations.agents.push(declared)
  await saveDeclarations(ctx, join, workspace, declarations)
  return { declared, grant }
}
