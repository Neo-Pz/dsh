/**
 * Where this node's decision to publish is written down.
 *
 * Publishing used to be configured in DSH's own config file, which meant it
 * could only be turned on by editing YAML and restarting — and that put the
 * single most consequential action in the system (make this machine's facts
 * public) behind the least visible gesture available. This file is what the
 * panel writes instead, so the decision is made by a person clicking a button
 * on the machine it affects.
 *
 * Precedence: this file wins over `config.community`. The config value is a
 * default for a node that has never decided; once someone has chosen — to
 * publish, or to stop — that choice outranks a file they may not have written
 * and cannot see.
 */

const FILE = 'community.json'

/** Nothing here may be logged: `token` is this node's credential. */
export interface CommunitySettings {
  url: string
  token: string
  visibility: 'structural' | 'full'
  nodeId?: string
  /** Null until a human identity is bound to this node. */
  principalId?: string | null
  enabledAt?: string
  intervalMs?: number
}

function pathFor(join, workspace) {
  return join(workspace, '.iflow', FILE)
}

/**
 * Read the stored decision.
 *
 * Three distinct answers, and the difference between the last two is the whole
 * point of this file:
 *
 *   null              nobody has decided — fall back to whatever config says
 *   { stopped: true } someone decided NOT to publish — config must not override
 *   settings          someone decided to publish, here
 *
 * Collapsing "stopped" into "no settings" would mean a node that was turned off
 * in the panel comes back online at the next restart, because the config that
 * originally enabled it is still there. A stop a restart undoes is not a stop.
 *
 * A missing file is the normal case, not an error. A corrupt one is read as
 * "stopped" rather than "never decided", deliberately: a node that cannot read
 * its own settings must not resolve that doubt by publishing.
 */
export async function loadCommunitySettings(ctx, join, workspace) {
  let data
  try {
    const resolved = await ctx.fs.resolve(pathFor(join, workspace))
    data = JSON.parse(await ctx.fs.readText(resolved))
  } catch (err) {
    // ENOENT is "never decided". Anything else is a file that exists and will
    // not parse, which is not something to interpret optimistically.
    if (err && (err.code === 'ENOENT' || /not found/i.test(String(err.message)))) return null
    return { stopped: true }
  }

  try {
    if (data && data.stoppedAt) return { stopped: true }
    if (!data || typeof data.url !== 'string' || typeof data.token !== 'string') return { stopped: true }
    if (data.url.length === 0 || data.token.length === 0) return { stopped: true }
    return {
      url: data.url,
      token: data.token,
      visibility: data.visibility === 'full' ? 'full' : 'structural',
      nodeId: typeof data.nodeId === 'string' ? data.nodeId : undefined,
      principalId: typeof data.principalId === 'string' ? data.principalId : null,
      enabledAt: typeof data.enabledAt === 'string' ? data.enabledAt : undefined,
      intervalMs: Number(data.intervalMs) || 60000,
    }
  } catch {
    return { stopped: true }
  }
}

export async function saveCommunitySettings(ctx, join, workspace, settings) {
  const resolved = await ctx.fs.resolve(pathFor(join, workspace))
  await ctx.fs.writeText(resolved, JSON.stringify(settings, null, 2))
}

/**
 * Going offline.
 *
 * The file is emptied rather than deleted so that "this node was published and
 * then stopped" stays distinguishable from "this node never published", and so
 * the credential is not left lying on disk after it stops being used.
 */
export async function clearCommunitySettings(ctx, join, workspace) {
  const resolved = await ctx.fs.resolve(pathFor(join, workspace))
  await ctx.fs.writeText(resolved, JSON.stringify({ stoppedAt: new Date().toISOString() }, null, 2))
}
