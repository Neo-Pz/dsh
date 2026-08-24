/**
 * Sealed envelopes, end to end, through the REAL identity binary.
 *
 * The relay this is built for is a forwarding layer, not a mailbox: it routes
 * a message, queues it while the recipient is offline, and deletes it on
 * delivery. What it must never be is somewhere every conversation on the
 * network is legible — to whoever runs it, and to whoever later reads its
 * backups.
 *
 * These assertions are about that promise rather than about the cipher.
 * `rust/src/envelope.rs` has the unit tests for the construction; what is
 * checked here is the property a person would care about: two separate
 * machines, each with its own on-disk identity, exchanging something a third
 * machine holding the bytes cannot read.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const IFLOW_ID = join(
  import.meta.dirname,
  '..',
  'rust',
  'target',
  'release',
  process.platform === 'win32' ? 'iflow-id.exe' : 'iflow-id',
)
const hasBinary = existsSync(IFLOW_ID)

function run(home, args) {
  return spawnSync(IFLOW_ID, ['--home', home, ...args], { encoding: 'utf8' })
}

function didOf(home) {
  return JSON.parse(run(home, ['show', '--json']).stdout).did
}

describe('sealing a message for the relay to carry', { skip: !hasBinary }, () => {
  let alice
  let bob
  let mallory
  let bobDid

  before(() => {
    alice = mkdtempSync(join(tmpdir(), 'iflow-seal-a-'))
    bob = mkdtempSync(join(tmpdir(), 'iflow-seal-b-'))
    mallory = mkdtempSync(join(tmpdir(), 'iflow-seal-m-'))
    for (const [home, label] of [[alice, 'alice'], [bob, 'bob'], [mallory, 'mallory']]) {
      const created = run(home, ['create', label])
      assert.equal(created.status, 0, `create ${label} failed: ${created.stderr}`)
    }
    bobDid = didOf(bob)
  })

  after(() => {
    for (const home of [alice, bob, mallory]) rmSync(home, { recursive: true, force: true })
  })

  const AAD = 'conv-1|msg-1'
  const MESSAGE = 'can you analyse this CSV?'

  const sealForBob = (message = MESSAGE, aad = AAD) => {
    const plain = join(alice, 'plain.txt')
    const sealed = join(alice, `sealed-${Math.random().toString(36).slice(2)}.bin`)
    writeFileSync(plain, message, 'utf8')
    const result = run(alice, ['seal', bobDid, plain, sealed, aad])
    assert.equal(result.status, 0, `seal failed: ${result.stderr}`)
    return sealed
  }

  it('round-trips to the intended recipient', () => {
    const sealed = sealForBob()
    const out = join(bob, 'out.txt')
    const opened = run(bob, ['open', sealed, out, AAD])
    assert.equal(opened.status, 0, `open failed: ${opened.stderr}`)
    assert.equal(readFileSync(out, 'utf8'), MESSAGE)
  })

  it('leaves nothing readable in the blob the relay would store', () => {
    const sealed = sealForBob()
    const bytes = readFileSync(sealed)
    assert.ok(!bytes.includes(Buffer.from('analyse')), 'plaintext survived into the sealed envelope')
    assert.ok(!bytes.includes(Buffer.from('CSV')), 'plaintext survived into the sealed envelope')
  })

  it('refuses anyone the message was not sealed for', () => {
    const sealed = sealForBob()
    const opened = run(mallory, ['open', sealed, join(mallory, 'out.txt'), AAD])
    assert.notEqual(opened.status, 0, 'a third party opened the envelope')
  })

  it('will not let the relay move a message to another conversation', () => {
    // The relay cannot read the message. Without binding the ciphertext to its
    // routing metadata it could still redeliver it as a different one, which is
    // a different attack and just as bad.
    const sealed = sealForBob()
    for (const wrong of ['conv-2|msg-1', 'conv-1|msg-2', '']) {
      const opened = run(bob, ['open', sealed, join(bob, 'out.txt'), wrong])
      assert.notEqual(opened.status, 0, `routing metadata "${wrong}" was accepted`)
    }
  })

  it('detects a single altered byte', () => {
    const sealed = sealForBob()
    const bytes = readFileSync(sealed)
    bytes[bytes.length - 1] ^= 0x01
    const tampered = join(alice, 'tampered.bin')
    writeFileSync(tampered, bytes)
    const opened = run(bob, ['open', tampered, join(bob, 'out.txt'), AAD])
    assert.notEqual(opened.status, 0, 'tampering was not detected')
  })

  it('produces a different blob every time, so the relay cannot correlate', () => {
    const first = readFileSync(sealForBob('same message'))
    const second = readFileSync(sealForBob('same message'))
    assert.ok(!first.equals(second), 'two sealings of one message were byte-identical')
  })

  it('needs only the recipient did — no key exchange, no second key to publish', () => {
    // Sealing used nothing but `bobDid`, which is already public and already in
    // the AgentCard. That is the whole reason this can work over a relay
    // between two machines that have never met.
    assert.match(bobDid, /^did:key:z/)
  })

  it('fails closed on a truncated envelope rather than crashing', () => {
    const sealed = sealForBob()
    const bytes = readFileSync(sealed)
    for (const cut of [0, 1, 2, 20, 33]) {
      const short = join(alice, `short-${cut}.bin`)
      writeFileSync(short, bytes.subarray(0, cut))
      const opened = run(bob, ['open', short, join(bob, 'out.txt'), AAD])
      assert.notEqual(opened.status, 0, `a ${cut}-byte envelope was accepted`)
      assert.ok(opened.stderr.length > 0, 'a refusal should say why')
    }
  })
})
