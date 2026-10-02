import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createDiscoveryRuntime } from '../discovery/runtime.js'
import { agentHome, loadDeclarations } from '../identity/keyring.js'
import { assertAgentSigner, ConversationPolicyError } from '../conversation/service.js'
import { IntentEnvelopeError, IntentPolicyError, LocalIntentQueue, startLocalIntentPolling } from '../web/local-intents.js'

// Host assembly: DSH key homes, public endpoint and local sealed queue.
// Shared discovery policy is supplied by the Connect service, not a DSH tool.
export function createDshDiscovery({ ctx, workspace, state, getEdge, curlPost }) {
  return createDiscoveryRuntime({
    async selectedAgent(agentId) {
      const declarations = await loadDeclarations(ctx, join, workspace)
      const agent = declarations.agents.find((candidate) => candidate.agentId === agentId)
      if (!agent?.did) throw new Error('Select a declared local Agent with its own Authority')
      return agent
    },
    async publicationContext() {
      if (!getEdge()) throw new Error('iFlow Edge is not ready')
      return {
        enabled: !!(state.community?.url && state.community?.token),
        nodeId: getEdge().nodeId, runtimeKind: 'dsh', evidenceSource: 'dsh', version: state.version,
        agentInterface: state.publicUrl ? {
          url: `${state.publicUrl.replace(/\/+$/, '')}/a2a`,
          protocolBinding: 'JSONRPC', protocolVersion: '1.0',
        } : undefined,
      }
    },
    async record(input) {
      if (!getEdge()) throw new Error('iFlow Edge is not ready')
      return getEdge().edge.journal.record(input)
    },
    async requestSearch(agent, request) {
      const settings = state.community
      if (!settings) throw new Error('Connect this Node to Community before searching')
      const registry = `${settings.url.replace(/\/+$/, '')}/v1/ard`
      const result = await curlPost(`${registry}/search`, request, 30, undefined, agent)
      return { registry, response: result }
    },
  })

}

export function createDiscoveryTool(getRuntime) {
  return defineTool({
    name: 'iflow_discovery',
    description: 'ARD discovery: search public Agent resources as an explicitly selected local Agent, or explicitly publish/withdraw its public profile. Search never grants permission or executes candidates. Publication needs Community enabled and confirmPublic=true.',
    parameters: {
      action: { type: 'string', required: true, description: 'search | publish | withdraw' },
      fromAgentId: { type: 'string', required: true },
      query: { type: 'string', description: 'Public registry search text; disclosed to the configured Community.' },
      capabilities: { type: 'array', items: { type: 'string' } },
      pageSize: { type: 'integer' },
      pageToken: { type: 'string' },
      description: { type: 'string' },
      representativeQueries: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      confirmPublic: { type: 'boolean' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          version: { type: 'integer' }, kind: { type: 'string' },
          ownAgentId: { type: 'string' }, registry: { type: 'string' }, matching: { type: 'string' },
          response: { type: 'object', additionalProperties: true },
          state: { type: 'string' }, agentId: { type: 'string' }, eventId: { type: 'string' }, error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? JSON.stringify(value) : `iFlow discovery failed: ${value.error || 'Search or publication could not be completed'}` }],
    },
    async execute(args) {
      try {
        if (args.action === 'search') {
          const view = await getRuntime().search(args.fromAgentId, { query: { text: args.query, ...(args.capabilities ? { filter: { capabilities: args.capabilities } } : {}) }, ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}), ...(args.pageToken ? { pageToken: args.pageToken } : {}), federation: 'none' })
          return { ok: true, ...view }
        }
        if (args.action === 'publish' || args.action === 'withdraw') return await getRuntime().publish(args)
        throw new Error('action must be search, publish or withdraw')
      } catch (error) { return { ok: false, error: String(error?.message ?? error) } }
    },
  })
}

export function createDshWebIntentPlane({ ctx, config, workspace, scratchPath, iflowId, curlPost, curlGet, settings, executeIntent: runIntent }) {
  // ── Human -> Own Agent: durable local half of the Web Intent plane ─────
  const webIntentFile = join(workspace, '.iflow', 'web-intents.json')
  const webIntentStore = {
    async read() {
      try {
        return JSON.parse(await ctx.fs.readText(await ctx.fs.resolve(webIntentFile)))
      } catch (error) {
        if (error?.code === 'ENOENT' || /not found|no such file/i.test(String(error?.message ?? error))) return undefined
        throw error
      }
    },
    async write(value) {
      await ctx.fs.writeText(await ctx.fs.resolve(webIntentFile), JSON.stringify(value, null, 2))
    },
  }

  const webIntentQueue = new LocalIntentQueue({
    store: webIntentStore,
    clock: () => new Date(),
    async isAgentAvailable(agentId, authorityDid) {
      const declarations = await loadDeclarations(ctx, join, workspace)
      // A declared Agent is the local authority boundary P0 can act through.
      // Missing means unavailable, so the ciphertext remains in Local Queue.
      return declarations.agents.some((agent) => agent.agentId === agentId && agent.did === authorityDid)
    },
    crypto: {
      async open(did, sealed, aad) {
        const declarations = await loadDeclarations(ctx, join, workspace)
        const agent = declarations.agents.find((candidate) => candidate.did === did)
        if (!agent) throw new IntentEnvelopeError('selected Agent is not declared on this Node', 'agent_unavailable')
        const sealedPath = scratchPath(`web-intent-${Date.now()}.bin`)
        const plainPath = scratchPath(`web-intent-${Date.now()}.json`)
        writeFileSync(sealedPath, Buffer.from(sealed, 'base64url'))
        try {
          await iflowId(['open', sealedPath, plainPath, aad], agentHome(join, workspace, agent.agentId), 20)
          return readFileSync(plainPath, 'utf8')
        } catch {
          throw new IntentEnvelopeError('Intent was not sealed for the selected Agent or its routing was altered')
        } finally {
          try { unlinkSync(sealedPath) } catch { /* already absent */ }
          try { unlinkSync(plainPath) } catch { /* open failed before output */ }
        }
      },
      async seal(recipientDid, plaintext, aad) {
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`
        const plainPath = scratchPath(`browser-view-${stamp}.json`)
        const sealedPath = scratchPath(`browser-view-${stamp}.bin`)
        writeFileSync(plainPath, plaintext)
        try {
          await iflowId(['seal', recipientDid, plainPath, sealedPath, aad], 20)
          return Buffer.from(readFileSync(sealedPath)).toString('base64url')
        } finally {
          try { unlinkSync(plainPath) } catch { /* already absent */ }
          try { unlinkSync(sealedPath) } catch { /* seal failed before output */ }
        }
      },
      async keyId(publicKey) {
        return createHash('sha256').update(publicKey, 'utf8').digest('hex')
      },
    },
    async executeIntent(args) {
      try { return await runIntent(args) }
      catch (error) {
        if (error instanceof ConversationPolicyError) throw new IntentPolicyError(error.message, error.code)
        throw error
      }
    },
    async postView(view) {
      const connection = settings()
      if (!connection) throw new Error('Community connection is unavailable')
      await curlPost(`${connection.url}/v1/edge/browser-views`, view, 30, connection.token)
    },
    logger: console,
  })

  const localIntentPolling = startLocalIntentPolling({
    queue: webIntentQueue,
    settings,
    async inbox({ url, token }) {
      const answer = JSON.parse(await curlGet(`${url}/v1/edge/intents?limit=25`, 30, token))
      return Array.isArray(answer?.intents) ? answer.intents : []
    },
    async ack({ url, token }, intentIds) {
      return curlPost(`${url}/v1/edge/intents/ack`, { intentIds }, 30, token)
    },
    intervalMs: Number(config.webIntentIntervalMs) || 15_000,
    logger: console,
  })
  return { queue: webIntentQueue, dispose: localIntentPolling.dispose }

}

// DSH subprocess/file transport. Agent requests fail closed and recheck policy
// immediately before the host starts a process, after signing and mirroring.
export function createDshHttpTransport({ ctx, workspace, scratchPath, iflowId, getIdentity, authorizeSend }) {
  async function curlRaw(method, url, payload, timeoutSec, token, signingAgent, beforeSend) {
    const argv = ['curl', '-sS', '-m', String(timeoutSec), '-X', method]
    if (method === 'POST') {
      argv.push('-H', 'Content-Type: application/json', '-H', 'A2A-Version: 1.0')
      if (token) argv.push('-H', `Authorization: Bearer ${token}`)
      const bodyText = JSON.stringify(payload)
      // Explicit Agent sends fail closed. Legacy control calls without a
      // selected Agent retain their old Node-signing/token behavior.
      if (/\/(?:a2a|v1\/ard\/search)\/?$/.test(url) && signingAgent) {
        const bodyPath = scratchPath('agent-body.json')
        try {
          await ctx.fs.writeText(await ctx.fs.resolve(bodyPath), bodyText)
          const envelope = JSON.parse(await iflowId(
            ['sign-file', method, new URL(url).pathname, bodyPath],
            agentHome(join, workspace, signingAgent.agentId), 20,
          ))
          assertAgentSigner(envelope, signingAgent)
          argv.push('-H', `X-IFlow-Signature: ${JSON.stringify(envelope)}`)
        } catch (error) {
          const failure = new Error('agent_signing_failed: refusing unsigned or Node-signed send')
          failure.code = 'agent_signing_failed'
          throw failure
        } finally { try { unlinkSync(bodyPath) } catch { /* scratch only */ } }
      } else if (/\/a2a\/?$/.test(url)) {
        try {
          const id = await getIdentity()
          if (id.did) {
            const path = url.replace(/^https?:\/\/[^/]+/, '')
            // Write the body to a temp file first: passing 30KB+ as an argv
            // element hits ENAMETOOLONG on Windows, so sign from file.
            const bodyPath = scratchPath('body.json')
            const resolvedBody = await ctx.fs.resolve(bodyPath)
            await ctx.fs.writeText(resolvedBody, bodyText)
            const envelope = await iflowId(['sign-file', method, path, bodyPath], 20)
            argv.push('-H', `X-IFlow-Signature: ${envelope.replace(/\n/g, ' ')}`)
          }
        } catch (e) { /* signing is best-effort */ }
      }
      argv.push('--data-binary', bodyText)
    } else if (token) {
      argv.push('-H', `Authorization: Bearer ${token}`)
    }
    argv.push(url)
    if (signingAgent && payload?.method === 'SendMessage') {
      const metadata = payload.params?.metadata
      const target = {
        fromAgent: signingAgent, toAgentId: metadata?.toAgentId,
        toAgentDid: metadata?.toAgentAuthorityDid, conversationId: metadata?.conversationId,
      }
      authorizeSend(target)
      if (beforeSend) await beforeSend()
      authorizeSend(target)
    }
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: workspace,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
      graceMs: 5000,
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
    const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    if (outcome.exitCode !== 0) throw new Error(`iFlow outbound HTTP failed (exit ${String(outcome.exitCode)}): ${(stderr || stdout).slice(0, 400)}`)
    return stdout
  }

  async function curlPost(url, payload, timeoutSec, token, signingAgent, beforeSend) {
    return JSON.parse(await curlRaw('POST', url, payload, timeoutSec, token, signingAgent, beforeSend))
  }

  async function curlGet(url, timeoutSec, token) {
    return curlRaw('GET', url, undefined, timeoutSec, token)
  }

  return { curlRaw, curlPost, curlGet }
}
