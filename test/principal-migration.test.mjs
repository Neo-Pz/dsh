/** Stable Principal storage and the only allowed path out of the legacy layout. */

import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const {
  authorityHome,
  bindPrincipal,
  declarePrincipal,
  legacyPrincipalHome,
  loadDeclarations,
  loadPrincipalRegistry,
  migrateLegacyPrincipal,
  planPrincipalMigration,
} = await import(pathToFileURL(join(import.meta.dirname, '..', 'src', 'identity', 'keyring.ts')).href)

const scratch = []

afterEach(() => {
  while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true })
})

function temporary(name) {
  const path = mkdtempSync(join(tmpdir(), `${name}-`))
  scratch.push(path)
  return path
}

function context() {
  return {
    fs: {
      async resolve(path) {
        return path
      },
      async readText(path) {
        return readFileSync(path, 'utf8')
      },
      async writeText(path, text) {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, text, 'utf8')
      },
    },
  }
}

function identityPath(home) {
  return join(home, '.iflow', 'identity.json')
}

function writeIdentity(home, did, label = 'identity') {
  const path = identityPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ did, label, private_key: 'test-only' }), 'utf8')
}

function fakeIflowId() {
  let created = 0
  return async (args, home) => {
    if (args[0] === 'show') {
      return readFileSync(identityPath(home), 'utf8')
    }
    if (args[0] === 'create') {
      created += 1
      writeIdentity(home, `did:key:zCreated${created}`, args[1])
      return 'created'
    }
    if (args[0] === 'grant') {
      return JSON.stringify({ grant_id: `grant-${created}` })
    }
    throw new Error(`unexpected iflow-id command: ${args.join(' ')}`)
  }
}

function writeLegacy(workspace, did, label = 'Legacy owner', agentId = 'writer') {
  const agentsPath = join(workspace, '.iflow', 'agents.json')
  mkdirSync(dirname(agentsPath), { recursive: true })
  writeFileSync(agentsPath, JSON.stringify({
    principal: { did, label, declaredAt: '2026-01-01T00:00:00.000Z' },
    agents: [{
      agentId,
      label: agentId,
      did: `did:key:z${agentId}`,
      grantRef: `grant-${agentId}`,
      principalDid: did,
    }],
  }), 'utf8')
  writeIdentity(legacyPrincipalHome(join, workspace), did, label)
}

describe('a stable Principal across workspaces', () => {
  it('creates one user-level Authority and binds three workspaces to it', async () => {
    const root = temporary('iflow-profile')
    const workspaces = [temporary('iflow-ws-a'), temporary('iflow-ws-b'), temporary('iflow-ws-c')]
    const run = fakeIflowId()

    const created = await declarePrincipal(context(), join, workspaces[0], root, run, 'Acme')
    const second = await bindPrincipal(context(), join, workspaces[1], root, run, created.principalId)
    const third = await bindPrincipal(context(), join, workspaces[2], root, run, created.principalId)

    assert.equal(second.principalId, created.principalId)
    assert.equal(third.principalId, created.principalId)
    assert.equal(loadPrincipalRegistry(join, root).principals.length, 1)
    assert.ok(existsSync(identityPath(authorityHome(join, root, created.principalId, 1))))
    for (const workspace of workspaces) {
      const declarations = await loadDeclarations(context(), join, workspace)
      assert.equal(declarations.principal.principalId, created.principalId)
      assert.equal(existsSync(legacyPrincipalHome(join, workspace)), false)
    }
  })
})

describe('explicit legacy migration', () => {
  it('dry-runs without mutation, rejects a stale DID, then backs up and imports', async () => {
    const root = temporary('iflow-profile')
    const workspace = temporary('iflow-legacy')
    const run = fakeIflowId()
    const legacyDid = 'did:key:zLegacyOne'
    writeLegacy(workspace, legacyDid)

    const plan = await planPrincipalMigration(context(), join, workspace, root)
    assert.deepEqual(
      { state: plan.state, action: plan.action, did: plan.legacyAuthorityDid, agents: plan.agentCount },
      { state: 'required', action: 'import-new', did: legacyDid, agents: 1 },
    )
    assert.equal(existsSync(join(root, 'principals.json')), false, 'dry-run must not create a registry')
    assert.equal(existsSync(join(workspace, '.iflow', 'principal-binding.json')), false)
    assert.equal(existsSync(join(workspace, '.iflow', 'backups')), false)

    await assert.rejects(
      () => migrateLegacyPrincipal(context(), join, workspace, root, run, {
        expectedAuthorityDid: 'did:key:zChangedAfterPlan',
      }),
      /changed since the dry-run/,
    )
    assert.equal(existsSync(join(workspace, '.iflow', 'backups')), false, 'a stale plan must fail before backup or mutation')

    const result = await migrateLegacyPrincipal(context(), join, workspace, root, run, {
      expectedAuthorityDid: legacyDid,
    })
    assert.equal(result.migrated, true)
    assert.equal(result.legacyKeyRetained, true)
    assert.ok(existsSync(result.backupPath))
    assert.ok(existsSync(join(result.backupPath, 'principal', '.iflow', 'identity.json')))
    assert.ok(existsSync(legacyPrincipalHome(join, workspace)), 'migration copies; it never deletes the rollback source')

    const declarations = await loadDeclarations(context(), join, workspace)
    assert.match(declarations.principal.principalId, /^iflow:principal:/)
    assert.equal(declarations.principal.authorityDid, legacyDid)
    assert.equal(declarations.principal.legacy, undefined)
    assert.equal(declarations.agents[0].principalId, declarations.principal.principalId)
    assert.equal(declarations.agents[0].authorityDid, legacyDid)
    assert.equal(declarations.agents[0].principalDid, undefined)
    assert.equal((await planPrincipalMigration(context(), join, workspace, root)).state, 'complete')
  })

  it('reuses an exact Authority match but never merges a different legacy DID', async () => {
    const root = temporary('iflow-profile')
    const first = temporary('iflow-legacy-a')
    const same = temporary('iflow-legacy-b')
    const different = temporary('iflow-legacy-c')
    const run = fakeIflowId()
    writeLegacy(first, 'did:key:zSame', 'Owner A', 'agent-a')
    writeLegacy(same, 'did:key:zSame', 'Owner A again', 'agent-b')
    writeLegacy(different, 'did:key:zDifferent', 'Similar label', 'agent-c')

    const imported = await migrateLegacyPrincipal(context(), join, first, root, run, {
      expectedAuthorityDid: 'did:key:zSame',
    })
    const samePlan = await planPrincipalMigration(context(), join, same, root)
    assert.equal(samePlan.action, 'bind-existing')
    assert.equal(samePlan.targetPrincipalId, imported.principal.principalId)

    const differentPlan = await planPrincipalMigration(context(), join, different, root)
    assert.equal(differentPlan.action, 'import-new')
    assert.equal(differentPlan.targetPrincipalId, null)
    assert.equal(loadPrincipalRegistry(join, root).principals.length, 1, 'planning must not merge or import')
  })
})
