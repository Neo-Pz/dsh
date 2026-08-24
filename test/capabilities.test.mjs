/**
 * Can the identity binary on this machine do what this plugin needs?
 *
 * The cached binary at `<workspace>/.iflow/bin/` survives plugin upgrades on
 * purpose. That is right until the binary gains a command: the cache is found
 * first, the new build is never fetched, and a feature that shipped in the
 * plugin fails against a binary from before it existed.
 *
 * The whole answer rests on reading `help` correctly, so that is what is
 * checked here — including against the real binary's actual output, because a
 * probe that quietly always answers "yes" is worse than no probe at all.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const { IFI_CAPABILITIES, helpAdvertises, missingCapabilities, staleBinaryAdvice } = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'identity', 'capabilities.ts')).href
)

const IFLOW_ID = join(
  import.meta.dirname,
  '..',
  'rust',
  'target',
  'release',
  process.platform === 'win32' ? 'iflow-id.exe' : 'iflow-id',
)
const hasBinary = existsSync(IFLOW_ID)

/** Help as it looked before sealing existed. */
const OLD_HELP = `iflow-id — iFlow trust root (P1 + P2)

commands:
  create [label]          generate & persist did:key identity
  show                     show public identity
  sign <method> <path> <body>
                               sign a request envelope (JSON out)
  verify <envelope.json>   verify a request envelope
`

describe('reading a binary’s help', () => {
  it('finds a command that is there', () => {
    assert.equal(helpAdvertises(OLD_HELP, 'create'), true)
    assert.equal(helpAdvertises(OLD_HELP, 'sign'), true)
  })

  it('does not find one that is not', () => {
    assert.equal(helpAdvertises(OLD_HELP, 'seal'), false)
    assert.equal(helpAdvertises(OLD_HELP, 'open'), false)
  })

  it('is not fooled by prose that happens to start with the word', () => {
    // The real help wraps descriptions, and one wrapped line begins
    // "seal a message so only that peer can read it". A looser match reads
    // that as proof the command exists — and then the relay fails three
    // frames down with "unknown command".
    const prose = `${OLD_HELP}\n                               seal a message so only that peer can read it.\n`
    assert.equal(helpAdvertises(prose, 'seal'), false)
  })

  it('treats unreadable help as "supports nothing"', () => {
    // Wrong permissively means a confusing runtime failure; wrong the other
    // way means one unnecessary download.
    for (const nothing of ['', null, undefined, 42]) {
      assert.equal(helpAdvertises(nothing, 'seal'), false)
    }
  })

  it('does not match a command that merely shares a prefix', () => {
    assert.equal(helpAdvertises('  sealed <x>\n', 'seal'), false)
    assert.equal(helpAdvertises('  opener <x>\n', 'open'), false)
  })

  it('accepts either kind of argument placeholder', () => {
    assert.equal(helpAdvertises('  seal <did>\n', 'seal'), true)
    assert.equal(helpAdvertises('  seal [did]\n', 'seal'), true)
  })
})

describe('what is missing', () => {
  it('names every capability an old binary lacks', () => {
    assert.deepEqual(missingCapabilities(OLD_HELP).sort(), ['open', 'seal'])
  })

  it('names none when they are all there', () => {
    const help = '  seal <recipient-did> <file> <out> [aad]\n  open <sealed> <out> [aad]\n'
    assert.deepEqual(missingCapabilities(help), [])
  })

  it('describes each one in terms of what stops working', () => {
    for (const [command, description] of Object.entries(IFI_CAPABILITIES)) {
      assert.ok(description.length > 0, `${command} has no description`)
      assert.match(description, /relay/, `${command} should say what it is for`)
    }
  })
})

describe('what an operator is told', () => {
  const advice = staleBinaryAdvice('/bin/iflow-id', '/ws/.iflow/bin/iflow-id', ['seal', 'open'])

  it('says the binary is behind the plugin, not that something is broken', () => {
    assert.match(advice, /older than this plugin/)
    assert.match(advice, /Everything else works/)
  })

  it('says which file to delete', () => {
    assert.match(advice, /\/ws\/\.iflow\/bin\/iflow-id/)
  })

  it('gives both ways out', () => {
    assert.match(advice, /iflow_fetch_identity/)
    assert.match(advice, /IFLOW_ID_PATH/)
  })
})

describe('against the real binary', { skip: !hasBinary }, () => {
  const help = spawnSync(IFLOW_ID, ['help'], { encoding: 'utf8' }).stdout

  it('sees every capability this plugin needs', () => {
    assert.deepEqual(missingCapabilities(help), [], 'the built binary is missing something the plugin needs')
  })

  it('sees the commands that predate this change', () => {
    for (const command of ['create', 'sign', 'sign-file', 'verify']) {
      assert.equal(helpAdvertises(help, command), true, `${command} was not detected`)
    }
  })

  it('cannot see a sub-command group, and that is a known limit', () => {
    // `grant` and `usage` are groups: their help reads `grant create <…>`, so
    // there is no placeholder directly after the group name. Nothing asks
    // about them — every capability in IFI_CAPABILITIES is a leaf command that
    // takes arguments — but a future one that is a group would need a
    // different probe, and finding that out here beats finding it out from a
    // feature that silently believes it is unavailable.
    for (const group of ['grant', 'usage']) {
      assert.equal(helpAdvertises(help, group), false)
    }
    for (const capability of Object.keys(IFI_CAPABILITIES)) {
      assert.match(help, new RegExp(`^\\s+${capability}\\s+<`, 'm'), `${capability} must be a leaf command`)
    }
  })

  it('does not see a command that does not exist', () => {
    assert.equal(helpAdvertises(help, 'teleport'), false)
  })
})
