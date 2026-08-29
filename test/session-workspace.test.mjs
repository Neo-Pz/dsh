/**
 * Every Agent conversation lands in the folder a person chose.
 *
 * A session created without one shows up in DSH as 未分组 — findable only by
 * scrolling, and outside whatever the operator decided iFlow was allowed to
 * touch. `conversation-bridge.test.mjs` proves the inbound path does this; the
 * intent path creates sessions too, and reaching it end to end means dragging
 * in the whole Community intent machinery.
 *
 * So this reads the source instead, and guards the rule rather than one route:
 * wherever a session is created, the working directory came from the confirmed
 * workspace. That is the check that bites the next call site somebody adds.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const source = readFileSync(join(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8')

/**
 * The same source with comments removed.
 *
 * Needed because the strings worth forbidding are exactly the ones a comment
 * explains the absence of. Checking the raw text finds the explanation and
 * reports the thing it was explaining away.
 *
 * Split on `\r?\n`, not `\n`. This repository is checked out with CRLF, and in
 * a regular expression `.` does not match `\r` — it is a line terminator — so
 * `//.*$` on a line still carrying its `\r` matches nothing at all, and every
 * comment survives a strip that looks correct.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(/\r?\n/)
  .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
  .join('\n')

/** Each `agents.create(...)` with the 40 lines leading up to it. */
function createCallSites() {
  const lines = source.split('\n')
  const sites = []
  lines.forEach((line, index) => {
    if (!line.includes('agents.create(')) return
    sites.push({
      line: index + 1,
      text: line,
      before: lines.slice(Math.max(0, index - 40), index).join('\n'),
      after: lines.slice(index, index + 12).join('\n'),
    })
  })
  return sites
}

describe('creating a session for an Agent conversation', () => {
  const sites = createCallSites()

  it('happens in more than one place, which is why this is a rule and not a test of one route', () => {
    assert.ok(sites.length >= 2, `expected several call sites, found ${sites.length}`)
  })

  for (const site of createCallSites()) {
    it(`asks for the confirmed workspace before creating one (line ${site.line})`, () => {
      // Not "a cwd was passed" but "the cwd came from the folder someone
      // confirmed". `requireConversationWorkspace` is the only thing that
      // refuses when nobody has chosen yet, which is what stops a stranger's
      // first message from picking the folder by accident.
      assert.match(
        site.before,
        /requireConversationWorkspace\(\)/,
        'a session is created here without asking for the confirmed workspace',
      )
    })

    it(`files it under that workspace rather than nowhere (line ${site.line})`, () => {
      const call = `${site.text}\n${site.after}`
      assert.match(
        `${site.before}\n${call}`,
        /meta[:\s]*[={][^}]*cwd/s,
        'a session is created with no cwd, so DSH files it as 未分组',
      )
    })
  }

  it('does not mark them as subagent sessions', () => {
    // An iFlow conversation is an ordinary DSH session and belongs in the normal
    // list. Hiding it under a subagent origin is how it stops being findable.
    // Checked against the source with comments stripped: the only mention of
    // it here is a comment explaining why it is not used, and matching that
    // would report the explanation as the offence.
    assert.equal(code.includes("origin: 'subagent'"), false)
  })

  it('names the session after the peer, so a folder full of them can be read', () => {
    // `iflow-agent-mtcysb1q-999eg5db` tells a person nothing. The peer's label
    // is the only part of this they recognise.
    assert.match(source, /sessionTitle\.rename\([^)]*peerLabel/)
    assert.match(source, /sessionTitle\.rename\([^)]*from \|\|/)
  })
})

describe('resuming one', () => {
  it('does not move a session that already exists', () => {
    // Old conversations keep the folder they were bound to. Re-filing them on
    // upgrade would move somebody's work without being asked, and the binding
    // is what makes a thread continue rather than restart.
    const resume = source.slice(source.indexOf('agents.resume('))
    const untilCreate = resume.slice(0, resume.indexOf('agents.create('))
    assert.equal(untilCreate.includes('cwd'), false, 'resuming a session re-files it')
  })
})
