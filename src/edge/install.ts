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
 * @param options.did        this node's did:key, when the identity exists
 * @param options.token      shared bearer token, when the plugin has one
 * @param options.capabilities capability ids this node advertises
 * @param options.runIflowId   invoke the identity binary (args -> stdout)
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
    did: options.did ?? undefined,
  }

  // Sign at the origin when the identity binary is usable. An edge with no
  // key material still journals — an unsigned fact is degraded, not lost — and
  // `journal.unsignedWriteCount` makes the gap visible rather than silent.
  let signer
  let verifier
  if (typeof options.runIflowId === 'function' && typeof options.writeScratch === 'function') {
    const io = { run: options.runIflowId, writeScratch: options.writeScratch, logger: ports.logger }
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
        if (!options.token) return true
        return request.headers['authorization'] === `Bearer ${options.token}`
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

      if (options.token && request.headers['authorization'] !== `Bearer ${options.token}`) {
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
      commandRoute.dispose()
      approvals.dispose()
      registry.dispose()
      instrumentation.dispose()
      void instrumentation.drain().finally(() => edge.dispose())
    },
  }
}
