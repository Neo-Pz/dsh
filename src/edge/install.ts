/**
 * Bring up the iFlow edge inside DSH.
 *
 * Purely additive: it observes the DSH lifecycle, journals what happened, and
 * exposes read-only projections. It changes no existing A2A, mirror, grant or
 * metering behavior, and a failure here must never stop the plugin loading —
 * a runtime that cannot journal is degraded, not broken.
 */

import { hostname } from 'node:os'

import { createEdge } from 'iflow-adapter-sdk'

import { createIflowIdSigner, createIflowIdVerifier } from '../identity/iflow-id.js'
import {
  createAgentRegistry,
  createApprovalBridge,
  createDshCommandExecutor,
} from '../runtime/dsh-command-executor.js'
import { installDshInstrumentation } from '../runtime/dsh-instrumentation.js'
import { createDshPorts } from '../runtime/dsh-ports.js'
import { isLoopbackRequest } from './panel.js'
import { startCommunitySync } from './sync.js'

/**
 * A stable id for this machine+workspace pair.
 *
 * `origin.nodeId` must survive restarts or every restart would look like a new
 * node to the network, so it is derived from durable facts rather than minted.
 */
function deriveNodeId(workspace) {
  let host = 'unknown-host'
  try {
    host = hostname() || host
  } catch {
    // Hostname is a nicety; the workspace hash below carries the identity.
  }
  let hash = 0x811c9dc5
  for (let i = 0; i < workspace.length; i++) {
    hash ^= workspace.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return `${host.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${hash.toString(16)}`
}

/**
 * @param ctx cordis context
 * @param options.workspace  DSH's workspace root
 * @param options.alias      this node's display name (the plugin's `state.alias`)
 * @param options.version    plugin sync version, recorded on the edge's agent
 * @param options.nodeDid    this Runtime Node's did:key. It is neither the
 *                           Principal Authority nor a declared Agent key.
 * @param options.token      shared bearer token, or a getter for it. The
 *                           operator can set the token at runtime with
 *                           `iflow_set_token`, so pass a getter to keep the
 *                           edge in step with the plugin instead of freezing
 *                           whatever the token was at install time.
 * @param options.capabilities capability ids this node advertises
 * @param options.community    { url, token, visibility, intervalMs } — when set,
 *                           the outbox is flushed to that Community. Absent by
 *                           default: installing this plugin publishes nothing.
 * @param options.agentDids    DID of each declared Agent, by id
 * @param options.resolveSigningHome  which key directory a signing context
 *                           belongs to; undefined means this node holds no
 *                           such key and the event must go unsigned
 * @param options.runIflowId   invoke the identity binary (args[, home] -> stdout)
 * @param options.writeScratch persist bytes for the binary to read, return path
 */
export async function installIFlowEdge(ctx, options) {
  const workspace = options.workspace
  const nodeId = deriveNodeId(workspace)

  const ports = createDshPorts(ctx, workspace, { logPrefix: 'iFlow edge' })

  const descriptor = {
    nodeId,
    runtimeKind: 'dsh',
    runtimeVersion: String(options.version ?? 'unknown'),
    workspaceRoot: workspace,
    capabilities: options.capabilities ?? [],
    selfAgentId: `node-${nodeId}`,
    selfAgentLabel: options.alias ?? 'iflow-edge',
    did: options.nodeDid ?? undefined,
    // The DID of every Agent an operator declared on this node, so an event one
    // of them issues carries the key a verifier should check it against.
    agentDids: options.agentDids ?? undefined,
  }

  // Sign at the origin when the identity binary is usable. An edge with no
  // key material still journals — an unsigned fact is degraded, not lost — and
  // `journal.unsignedWriteCount` makes the gap visible rather than silent.
  let signer
  let verifier
  if (typeof options.runIflowId === 'function' && typeof options.writeScratch === 'function') {
    const io = {
      run: options.runIflowId,
      writeScratch: options.writeScratch,
      logger: ports.logger,
      // Which key signs is decided by whoever the event is attributed to. A
      // context this node holds no key for is refused, not substituted: the
      // journal then records the fact unsigned, which is honest, where a
      // signature by the wrong key would be a false attribution.
      resolveHome: options.resolveSigningHome,
    }
    signer = createIflowIdSigner(io)
    verifier = createIflowIdVerifier(io)
    try {
      // Fail fast here rather than once per event: if the binary cannot answer
      // now, journal unsigned and say so, instead of logging on every fact.
      await signer.did()
    } catch (error) {
      ports.logger.warn(
        `iFlow edge: no usable identity, so facts will be journaled UNSIGNED (${String(error?.message ?? error)})`,
      )
      signer = undefined
      verifier = undefined
    }
  }

  // Read the token per request: `iflow_set_token` can change it long after the
  // edge is installed, and a snapshot taken here would ignore that.
  const currentToken = () => (typeof options.token === 'function' ? options.token() : options.token)

  const edge = await createEdge({
    ports,
    descriptor,
    signer,
    verifier,
    server: {
      // The edge read API is loopback-only by default, but this DSH may have
      // been configured to bind a LAN address, so it reuses the plugin's own
      // bearer check rather than assuming the port is private.
      authorize: (request) => {
        if (isLoopbackRequest(request)) return true
        const token = currentToken()
        // No token means no remote read channel. Origin Journal and its private
        // projections remain available to the local Hub, but binding DSH to
        // 0.0.0.0 must not silently turn local Agent history into a LAN API.
        return Boolean(token && request.headers['authorization'] === `Bearer ${token}`)
      },
      // The standalone Web app is served from its own dev origin.
      allowedOrigins: options.allowedOrigins,
    },
  })

  const instrumentation = installDshInstrumentation(ctx, edge, {
    capabilities: descriptor.capabilities,
  })

  // ── Command path (opt-in, fail closed) ──────────────────────────────────
  const acceptCommands = options.acceptCommands === true
  const registry = createAgentRegistry(ctx)
  const approvals = createApprovalBridge(ctx, { enabled: acceptCommands && options.routeApprovals === true })
  const executor = createDshCommandExecutor({
    enabled: acceptCommands,
    nodeId,
    registry,
    approvals,
    observer: edge.observer,
  })

  // The one write route on this edge. It is mounted by the ADAPTER, not by the
  // SDK's read API, because every command must pass through this runtime's own
  // enforcement before anything happens.
  const commandRoute = ports.http.route({
    method: 'POST',
    path: '/iflow/command',
    async handler(request) {
      const json = (status, body) => ({
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
      })

      // Fail closed when no token is configured. The old check was
      // `if (options.token && ...)`, so a node with `acceptCommands: true` and
      // auth off executed task.cancel for anyone who could reach the port —
      // loopback by default, but one `--host 0.0.0.0` away from remote
      // cancellation. An unauthenticated write path is refused, not opened.
      const token = currentToken()
      if (!token) {
        return json(503, { error: 'the command channel requires a configured token; set one with iflow_set_token' })
      }
      if (request.headers['authorization'] !== `Bearer ${token}`) {
        return json(401, { error: 'unauthorized' })
      }

      let command
      try {
        command = JSON.parse(request.body ?? '')
      } catch {
        return json(400, { error: 'body must be an IFlowCommand JSON object' })
      }

      const outcome = await edge.dispatchCommand(command, executor)
      // A refusal is a valid, recorded answer — not a transport error. The
      // caller learns what happened without being able to retry into a second
      // side effect, because the ledger already remembers this command.
      return json(200, { commandId: command?.commandId, ...outcome })
    },
  })

  if (acceptCommands) {
    console.warn(
      'iFlow edge: command acceptance is ON. Remote hubs may request ' +
        `${options.routeApprovals === true ? 'task cancellation and approval decisions' : 'task cancellation'} on this node.`,
    )
  }

  // Outbound sync, off unless an operator configured a Community. Started
  // after the edge is live so the first flush has a journal to read.
  let stopSync = () => {}
  if (options.community && options.community.url && options.community.token) {
    stopSync = startCommunitySync(ctx, edge, options.community)
    ctx.logger?.info?.(
      `iFlow: publishing facts to ${options.community.url} (${options.community.visibility === 'full' ? 'FULL text' : 'free text redacted'})`,
    )
  }

  return {
    edge,
    nodeId,
    signing: signer !== undefined,
    executor,
    approvals,
    /** Resolve once every queued observation has reached the journal. */
    drain: () => instrumentation.drain(),
    dispose() {
      // Stop accepting work first, then stop listening, then let the
      // already-queued facts finish landing so a shutdown does not lose the
      // last few observations.
      stopSync()
      commandRoute.dispose()
      approvals.dispose()
      registry.dispose()
      instrumentation.dispose()
      void instrumentation.drain().finally(() => edge.dispose())
    },
  }
}
