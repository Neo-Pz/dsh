# Working in this repository

This is the **iFlow plugin for DeepSeek Harness (DSH)** — an A2A bridge plus
agent identity, delegation and metering, and the first iFlowOne edge adapter.
It runs on a person's own machine and holds their private state.

It is *one reference implementation* of an adapter, not the definition of one.
The contracts live in `Neo-Pz/iFlowOne` (`iflow-domain`, `iflow-protocol`,
`iflow-adapter-sdk`, currently `0.7.0`) and know nothing about DSH. Keep it
that way: if a change would teach the contracts about DSH, it belongs here.

The cross-repo picture, the verified baseline and the list of traps are in
`iFlowOne/docs/handoff.md`. Read it before a first change.

## Commands

```bash
npm run build                # esbuild bundle
npm run build:client         # the panel UI
npm test                     # 357 tests (node --test); run AFTER successful build
cd rust && cargo test        # 37 tests — signing, grants, usage
```

## The three layers people confuse

They are separate on purpose and must stay separate:

| layer | question it answers |
|---|---|
| **待处理 / pending** | may this stranger talk to me at all? |
| **Chat** | what did we say to each other? |
| **交付验收 / delivery** | do I accept the work that came back? |

The 待处理 tab shows **first contacts and requests to reauthorize revoked pair
permissions**. Already-authorized chat history belongs in Chat. Reauthorization
resumes the existing Conversation and Session; it does not accept a Task delivery.

Tests import `lib/index.js`, not just source. A failed or skipped build can leave
tests exercising an old bundle. Check each build's exit status before testing.

## Rules that bite

**Pair permissions are keyed on verified DIDs, never on labels.** A label is
whatever the far side chose to put in its metadata. See
`src/conversation/permissions.ts` — it is `permissions.json`, deliberately not
`trust.json`, because a permission and a trust level are different things.

**A message has four orthogonal dimensions, and no one of them implies
another:**

```
side       self | peer          — stored per machine, relative to this node
author     human | agent        — who wrote it
authorAgentId                   — which Agent
represents                      — who that Agent acts for
```

Left/right comes from `side`. The person/agent badge comes from `author`.
Deriving one from the other is what put the reader's own name on somebody
else's sentence. There is no authoritative `source` field; it was abolished.

**One `messageId` across both nodes.** The sender's id is preserved rather than
regenerated, so the same message on two machines is the same message. Mirror
keys are namespaced (`mirror:<id>`, `mirror:<id>:reply`) because `markSeen` is
shared with inbound duplicate suppression.

**A message's text is never journalled.** `conversation.*` facts carry a content
digest. `task.*` and `delivery.*` are *not* excluded by `isPublishable`, so
anything put in `task.created.title` or `delivery.submitted.summary` leaks — this
already happened once.

**`Delivery` is not `Acceptance`.** The executor may deliver; only the
delegating side may accept. Cross-boundary `task.completed` is refused (outputs
are kept). `crossesOwnershipBoundary` is stated by the delegating side, because
only it knows — `Agent.principal` is never populated.

## Two limits that are deliberate, not bugs

- **A peer's message will always appear on the right in DSH's own session
  view.** DSH renders by role, and a peer's message has to arrive as a user turn
  — that is what prompts the local Agent. `src/client/Chats.jsx` exists for
  exactly this reason: it draws the conversation as it happened, left for the
  other party and right for this machine's Agent.
- **A malformed legacy `source` cannot be tolerated from inside the plugin.**
  DSH's loader runs `assertMessageEventShape` and throws before iFlow sees
  anything. Repairing the stored file is the only remedy available.

## Not yours to run

`src/repair/session-source.ts` writes into DSH's own session store. It is
dry-run by default, takes a `.backup` before every write, and **DSH must be
closed** before it runs. Do not run it against a live install without saying so
first.

Commit or push only when asked, and branch first if on `main`.

## Traps recorded from real debugging

- **DSH session storage is concatenated zstd frames.** `zstdDecompressSync`
  returns only the first. A store-wide scan that finds zero message events is
  reporting a bug in the scan, not an empty store.
- **JS `.` does not match `\r`.** This repo checks out CRLF, so
  comment-stripping with `//.*` and an end-of-line anchor silently does nothing.
  Split on `/\r?\n/`.
- **`esbuild` tree-shakes unused exports.** Absent from the bundle does not mean
  absent from the source.
- **Mutation-test every new guard** and record the result in the commit message.
- **A forbidden-string check will match the comment explaining the absence.**
  Strip comments — and then verify the stripping actually ran.

## Loose end

`fix/identity-node-home-capability` is an orphan branch; its content already
landed on `main` through a rewrite. Safe to delete.
