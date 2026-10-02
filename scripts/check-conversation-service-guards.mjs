// Mutate disposable copies only: never overwrite a source or installed bundle.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const original = join(root, 'src/generated/conversation-service.ts')
const source = readFileSync(original, 'utf8')
const temp = mkdtempSync(join(root, '.conversation-guard-check-'))
const mutations = [
  ['required identities', "if (!fromAgent?.agentId || !fromAgent?.did || !toAgentId || !toAgentDid)", 'if (false)'],
  ['selected signer', 'if (!agent?.did || signature?.signer !== agent.did)', 'if (false)'],
  ...['localAgentId === fromAgent.agentId', 'localAgentAuthorityDid === fromAgent.did', 'peerAgentId === toAgentId', 'peerAgentAuthorityDid === toAgentDid']
    .map((comparison) => [comparison, `conversation.${comparison}`, 'true']),
  ['permission', "pairState(fromAgent.did, toAgentDid) === 'revoked'", 'false'],
  ['paused thread', "conversation.communicationState === 'reauthorization_required'", 'false'],
  ['closed thread', "conversation.state === 'closed' || conversation.state === 'rejected'", 'false'],
  ['active pointer', 'conversation.active !== false', 'true'],
]
function run(path) {
  return spawnSync(process.execPath, ['--test', 'test/conversation-service.test.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, IFLOW_TEST_SERVICE: path },
  })
}
try {
  const baseline = run(original)
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
  for (const [name, needle, replacement] of mutations) {
    assert.ok(source.includes(needle), `mutation no longer matches: ${name}`)
    const path = join(temp, 'service.ts')
    writeFileSync(path, source.replaceAll(needle, replacement))
    const result = run(path)
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0, `SURVIVED: ${name}`)
    assert.match(result.stdout, /failureType: 'testCodeFailure'/)
    assert.match(result.stdout, /# cancelled 0/)
    console.log(`CAUGHT: ${name}`)
  }
} finally {
  assert.equal(dirname(resolve(temp)), root)
  assert.ok(temp.startsWith(join(root, '.conversation-guard-check-')))
  rmSync(temp, { recursive: true, force: true })
}
