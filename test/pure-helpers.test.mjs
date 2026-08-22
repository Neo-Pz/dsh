/**
 * The pure A2A/identity helpers, tested directly.
 *
 * These lived inside the plugin's `apply()` closure and were reachable only by
 * running the whole plugin, so nothing checked them. Two of them are the kind
 * of code that must be pinned against known-good values rather than trusted:
 * a hand-rolled SHA-256 (the sandbox has no Web Crypto) and the capability
 * matcher that decides what a delegated peer may do.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import { normalizeAction, validCapabilityId } from '../src/a2a/capability.ts'
import {
  TERMINAL_TASK_STATES,
  blocksToText,
  errorInfo,
  foldOutput,
  messageText,
  partsText,
  rpcException,
  rpcResult,
  taskText,
} from '../src/a2a/protocol.ts'
import { signingDigest, simpleHash } from '../src/util/hash.ts'

describe('signingDigest (hand-rolled SHA-256)', () => {
  it('matches the published vectors', () => {
    assert.equal(signingDigest(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    assert.equal(signingDigest('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('agrees with node:crypto across lengths, block boundaries and UTF-8', () => {
    const samples = [
      'a',
      'x'.repeat(55), // one byte short of needing a second block
      'x'.repeat(56), // the length field pushes it into a second block
      'x'.repeat(64),
      'x'.repeat(1000),
      '中文与 emoji 🙂 mixed',
      JSON.stringify({ method: 'POST', path: '/a2a', nested: { b: 1, a: 2 } }),
    ]
    for (const sample of samples) {
      assert.equal(
        signingDigest(sample),
        createHash('sha256').update(sample, 'utf8').digest('hex'),
        `digest mismatch for a ${sample.length}-char input`,
      )
    }
  })
})

describe('simpleHash', () => {
  it('changes when the input changes, and is stable when it does not', () => {
    assert.equal(simpleHash('same'), simpleHash('same'))
    assert.notEqual(simpleHash('source v1'), simpleHash('source v2'))
  })
})

describe('capability ids', () => {
  it('accepts the documented forms', () => {
    for (const id of ['*', 'iflow.cap:fs.read', 'iflow.cap:agent.run', 'iflow.cap:fs.*', 'iflow.cap:a.b.c']) {
      assert.equal(validCapabilityId(id), true, `${id} should be valid`)
    }
  })

  it('refuses free-form strings, so a typo cannot become a permission', () => {
    for (const id of ['fs.read', 'iflow.cap:', 'iflow.cap:.read', 'iflow.cap:fs..read', 'iflow.cap:FS.read', '', null, 42]) {
      assert.equal(validCapabilityId(id), false, `${JSON.stringify(id)} should be invalid`)
    }
  })

  it('translates the legacy scope name instead of rejecting an older peer', () => {
    assert.equal(normalizeAction('agent-task'), 'iflow.cap:agent.run')
    assert.equal(normalizeAction('iflow.cap:fs.read'), 'iflow.cap:fs.read')
  })
})

describe('A2A text extraction', () => {
  it('reads text, data and url parts, and ignores junk', () => {
    const text = messageText({
      parts: [{ text: 'hello' }, null, { data: { a: 1 } }, { url: 'https://example.test' }, 'nope'],
    })
    assert.equal(text, 'hello\n{"a":1}\nhttps://example.test')
  })

  it('returns empty for a message with no usable parts', () => {
    assert.equal(messageText(undefined), '')
    assert.equal(messageText({ parts: 'not an array' }), '')
    assert.equal(partsText([{ nothing: true }]), '')
  })

  it('prefers a task artifact over its status message', () => {
    const task = {
      artifacts: [{ parts: [{ text: 'the delivered answer' }] }],
      status: { message: { parts: [{ text: 'still working' }] } },
    }
    assert.equal(taskText(task), 'the delivered answer')
    assert.equal(taskText({ artifacts: [], status: { message: { parts: [{ text: 'still working' }] } } }), 'still working')
    assert.equal(taskText({ artifacts: [], status: {} }), '')
  })

  it('keeps only text blocks when folding DSH content', () => {
    assert.equal(blocksToText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
  })
})

describe('foldOutput', () => {
  it('prefers the final assistant message over accumulated chunks', () => {
    const folded = foldOutput([
      { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'par' } } },
      { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'tial' } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final' }] } } },
    ])
    assert.deepEqual(folded, [{ type: 'text', text: 'final' }])
  })

  it('falls back to the streamed chunks when no message landed', () => {
    const folded = foldOutput([
      { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'par' } } },
      { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'tial' } } },
    ])
    assert.deepEqual(folded, [{ type: 'text', text: 'partial' }])
  })

  it('returns nothing rather than an empty block when the agent said nothing', () => {
    assert.deepEqual(foldOutput([]), [])
    assert.deepEqual(foldOutput([{ type: 'tool/call' }]), [])
  })
})

describe('JSON-RPC shapes', () => {
  it('builds results and errors in the 2.0 envelope', () => {
    assert.deepEqual(rpcResult('id-1', { ok: true }), { jsonrpc: '2.0', id: 'id-1', result: { ok: true } })

    // rpcException is a THROWABLE: the handler catches it and turns rpcCode
    // into the JSON-RPC error code, so it must stay a real Error.
    const failure = rpcException(-32001, 'Task not found', errorInfo('TASK_NOT_FOUND'))
    assert.ok(failure instanceof Error)
    assert.equal(failure.rpcCode, -32001)
    assert.equal(failure.message, 'Task not found')
    // errorInfo builds the google.rpc.ErrorInfo ARRAY the A2A spec expects.
    assert.equal(failure.rpcData[0].reason, 'TASK_NOT_FOUND')
    assert.equal(failure.rpcData[0].domain, 'a2a-protocol.org')
  })

  it('knows which task states are terminal', () => {
    assert.equal(TERMINAL_TASK_STATES.has('TASK_STATE_COMPLETED'), true)
    assert.equal(TERMINAL_TASK_STATES.has('TASK_STATE_REJECTED'), true)
    assert.equal(TERMINAL_TASK_STATES.has('TASK_STATE_WORKING'), false)
  })
})
