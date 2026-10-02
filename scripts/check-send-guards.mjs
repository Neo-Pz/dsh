// Mutation checks on disposable COPIES of the built plugin. Never edits src,
// lib, the working tree's changes, or an installed DSH plugin.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib/index.js'), 'utf8')
const temp = mkdtempSync(join(root, '.send-guard-check-'))
const checks = [
  ['required target', 'if (!toAgentId || !looksLikeDid(toAgentDid))', 'if (false)'],
  ['Node pin', 'if (signer !== entry.did)', 'if (false)'],
  ['selected signing home', 'agentHome(join, workspace, signingAgent.agentId)', 'workspace'],
  ['signature identity', 'if (!agent?.did || signature?.signer !== agent.did)', 'if (false)'],
  ['pair permission', 'pairState(fromAgent.did, toAgentDid) === "revoked"', 'false'],
  ['conversation ownership', 'if (!conversation || !matchesPair(conversation, target))', 'if (false)'],
  ['paused conversation', 'conversation.communicationState === "reauthorization_required"', 'false'],
  ['mailbox isolation', 'if (item.peer !== args.peer || item.state !== "queued" || item.fromAgentId !== fromAgent.agentId || item.fromAgentDid !== fromAgent.did || item.toAgentId !== toAgentId || item.toAgentDid !== toAgentDid || item.conversationId !== conversationId)', 'if (false)'],
  ['recipient identity', 'if (!declarations.agents.some((agent) => agent.agentId === toAgentId && agent.did === toAgentAuthorityDid))', 'if (false)'],
  ['post-card recheck', 'conversationService.assertCanSend({ ...sendTarget, conversationId: existing?.conversationId });', ''],
  ['post-sign recheck', 'if (signingAgent && payload?.method === "SendMessage")', 'if (false)'],
  ['panel request header', 'if (request.headers?.["x-iflow-panel"] !== "chat")', 'if (false)'],
  ['panel idempotency content', 'if (previous && previous.digest !== digest)', 'if (false)'],
  ['confirmed draft send receipt', 'if (existing?.result) return existing.result;', ''],
  ['persist before outbound', 'if (strict) {', 'if (false) {'],
  ['local draft is not peer speech', 'if (event.type === "assistant/message" && conversation.localDraftRuns?.some((run) => run.sessionId === conversation.binding?.localSessionId && index >= run.start && index < run.end)) return [];', ''],
  ['Web sync selected peer Authority', '...intent.peerAgentAuthorityDid ? { peerAgentAuthorityDid: intent.peerAgentAuthorityDid } : {}', '...{}'],
  ['Web sync local Authority', 'localAgentAuthorityDid !== ownAgentAuthorityDid', 'localAgentAuthorityDid !== ownAgentAuthorityDid && false'],
  ['Web sync named peer Authority', 'peerAgentAuthorityDid !== intent.peerAgentAuthorityDid', 'peerAgentAuthorityDid !== intent.peerAgentAuthorityDid && false'],
  ['Web list local Authority scope', 'collapseToCounterparties(state.conversations, ownAgentId, { localAgentAuthorityDid: ownAgentAuthorityDid })', 'collapseToCounterparties(state.conversations, ownAgentId)'],
]

function run(bundle) {
  return spawnSync(process.execPath, ['--test', '--test-name-pattern=explicit Agent outbound routing', 'test/conversation-bridge.test.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, IFLOW_TEST_BUNDLE: bundle },
  })
}
try {
  const baseline = run(join(root, 'lib/index.js'))
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
  for (const [name, needle, replacement] of checks) {
    assert.ok(source.includes(needle), `mutation no longer matches: ${name}`)
    const file = join(temp, 'index.mjs')
    writeFileSync(file, source.replaceAll(needle, replacement))
    const result = run(file)
    assert.equal(result.error, undefined, `${name}: process failed, not a caught mutation`)
    assert.notEqual(result.status, 0, `SURVIVED: ${name}`)
    assert.match(result.stdout, /failureType: 'testCodeFailure'/, result.stdout + result.stderr)
    assert.match(result.stdout, /# cancelled 0/, `${name}: cancellation is not proof of a caught guard`)
    console.log(`CAUGHT: ${name} (${result.stdout.match(/# fail \d+/)?.[0]})`)
  }
} finally {
  assert.equal(dirname(resolve(temp)), root)
  assert.ok(temp.startsWith(join(root, '.send-guard-check-')))
  rmSync(temp, { recursive: true, force: true })
}
