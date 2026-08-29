/**
 * A Chats list is a list of who you talk to.
 *
 * It used to list every thread, so the same Agent appeared three times with
 * nothing to tell the rows apart — a session manager wearing a chat app's
 * clothes. `weww / weww / wwee` was the whole experience of it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const source = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')

// The real function, not a copy of it. A test that reimplements the selection
// passes while the implementation drifts away from it, which is the failure
// this whole file exists to prevent in the UI.
const store = await import(
  pathToFileURL(join(import.meta.dirname, '..', 'src', 'conversation', 'store.ts')).href
)
const collapse = store.collapseToCounterparties

const thread = (id, peer, updatedAt, extra = {}) => ({
  conversationId: id,
  peerAgentId: peer,
  peer,
  localAgentId: 'mine',
  active: true,
  updatedAt,
  ...extra,
})

describe('one row per counterparty', () => {
  it('collapses several threads with the same Agent into one', () => {
    const rows = collapse({
      a: thread('c1', 'weww', '2026-08-01T00:00:00.000Z'),
      b: thread('c2', 'weww', '2026-08-02T00:00:00.000Z'),
      c: thread('c3', 'wwee', '2026-08-03T00:00:00.000Z'),
    }, 'mine')
    assert.deepEqual(rows.map((r) => r.peerAgentId), ['wwee', 'weww'])
  })

  it('keeps the thread a message would actually continue', () => {
    // The active thread is the one the next send goes to, so it is the one the
    // row has to represent — otherwise clicking the row opens a dead history.
    const rows = collapse({
      old: thread('c-old', 'weww', '2026-08-09T00:00:00.000Z', { active: false }),
      live: thread('c-live', 'weww', '2026-08-01T00:00:00.000Z'),
    }, 'mine')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].conversationId, 'c-live', 'the row points at a thread nothing would continue')
  })

  it('falls back to whichever spoke last when neither is active', () => {
    const rows = collapse({
      a: thread('c-a', 'weww', '2026-08-01T00:00:00.000Z', { active: false }),
      b: thread('c-b', 'weww', '2026-08-05T00:00:00.000Z', { active: false }),
    }, 'mine')
    assert.equal(rows[0].conversationId, 'c-b')
  })

  it('does not show another Agent’s conversations', () => {
    const rows = collapse({
      mine: thread('c1', 'weww', '2026-08-01T00:00:00.000Z'),
      theirs: thread('c2', 'wwee', '2026-08-02T00:00:00.000Z', { localAgentId: 'someone-else' }),
    }, 'mine')
    assert.deepEqual(rows.map((r) => r.peerAgentId), ['weww'])
  })

  it('skips a thread with nobody on the other end', () => {
    // A conversation with no peer recorded cannot be a row in a list of who you
    // talk to, and grouping every such thread under `undefined` would merge
    // unrelated ones into a single phantom counterparty.
    const rows = collapse({
      a: thread('c1', undefined, '2026-08-01T00:00:00.000Z', { peer: undefined }),
      b: thread('c2', 'weww', '2026-08-02T00:00:00.000Z'),
    }, 'mine')
    assert.deepEqual(rows.map((r) => r.peerAgentId), ['weww'])
  })

  it('orders by who spoke most recently', () => {
    const rows = collapse({
      a: thread('c1', 'old-friend', '2026-08-01T00:00:00.000Z'),
      b: thread('c2', 'just-now', '2026-08-30T00:00:00.000Z'),
    }, 'mine')
    assert.deepEqual(rows.map((r) => r.peerAgentId), ['just-now', 'old-friend'])
  })
})

describe('the plugin performs that selection', () => {
  it('groups by counterparty rather than listing every conversation', () => {
    // The line this replaces mapped every conversation straight into the page.
    assert.match(source, /collapseToCounterparties\(state\.conversations, ownAgentId\)/)
    // And the old line is gone: it mapped every conversation into the page.
    assert.equal(source.includes('.filter((candidate) => candidate.localAgentId === ownAgentId)'), false)
  })
})
