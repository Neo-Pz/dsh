import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib/index.js'), 'utf8')
const temp = mkdtempSync(join(root, '.terminal-output-guard-check-'))
const checks = [
  ['immediate error contract', 'task.status.state !== "TASK_STATE_COMPLETED" || text2.length === 0', 'text2.length === 0'],
  ['polled error contract', 'stateName !== "TASK_STATE_COMPLETED" || text.length === 0', 'text.length === 0'],
  ['successful completion stays successful', 'task.status.state !== "TASK_STATE_COMPLETED" || text2.length === 0', 'true'],
  ['render fallback', 'value.error || (value.state ? `task ended in ${value.state}${value.text ? `: ${value.text}` : " with no output"}` : value.text || "remote call returned no error details")', 'value.error'],
  ['submitted display', 'TERMINAL_TASK_STATES.has(value.state) ? "finished" : "submitted"', '"finished"'],
  ['wait false terminal failure', 'if (args.waitForCompletion === false) return { ok: true, peer: args.peer, taskId: task.id, conversationId, state: task.status.state, text: "" };', ''],
]
function run(bundle) {
  return spawnSync(process.execPath, ['--test', '--test-name-pattern=terminal output contract', 'test/conversation-bridge.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, IFLOW_TEST_BUNDLE: bundle } })
}
try {
  const baseline = run(join(root, 'lib/index.js'))
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr)
  for (const [name, needle, replacement] of checks) {
    assert.ok(source.includes(needle), `mutation no longer matches: ${name}`)
    let mutated = source.replace(needle, replacement)
    if (name === 'wait false terminal failure') mutated = mutated.replace('if (TERMINAL_TASK_STATES.has(task.status.state)) {', needle + '\nif (TERMINAL_TASK_STATES.has(task.status.state)) {')
    const file = join(temp, 'index.mjs')
    writeFileSync(file, mutated)
    const result = run(file)
    assert.equal(result.error, undefined, `${name}: child process error`)
    assert.notEqual(result.status, 0, `SURVIVED: ${name}`)
    assert.match(result.stdout, /failureType: 'testCodeFailure'/)
    assert.match(result.stdout, /# cancelled 0/)
    console.log(`CAUGHT: ${name} (${result.stdout.match(/# fail \d+/)?.[0]})`)
  }
} finally {
  assert.equal(dirname(resolve(temp)), root)
  assert.ok(temp.startsWith(join(root, '.terminal-output-guard-check-')))
  rmSync(temp, { recursive: true, force: true })
}
