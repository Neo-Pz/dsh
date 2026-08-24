# iFlow

**Agent2Agent (A2A) bridge + agent identity / delegation / metering for DeepSeek Harness (DSH).**

iFlow is both a **DSH plugin** and a small **protocol**. It gives agents on different DSH machines a
signed, task-oriented A2A channel: each side identifies itself with a `did:key` trust root, can
delegate work under scoped grants (L0–L3), and meters the tokens it sends and receives.

It is also the first **iFlowOne edge adapter**: it journals what this runtime actually did as signed,
replayable domain events, and serves the projections the iFlowOne Hub reads. The domain, protocol and
edge logic are open source at [`Neo-Pz/iFlowOne`](https://github.com/Neo-Pz/iFlowOne) under
Apache-2.0 and published on npm; they know nothing about DSH. This repository is the runtime
binding — one reference implementation of an adapter, and the thing to read if you are writing
another.

[![npm](https://img.shields.io/badge/dsh-plugin-github%3ANeo--Pz%2Fdsh-blue)](https://github.com/Neo-Pz/dsh)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

---

## What it does

- **Bidirectional A2A** — two DSH machines (or any A2A agent) can delegate tasks to each other via
  JSON-RPC `SendMessage` / `GetTask` / `CancelTask` / `ListTasks`, and get the final answer back.
- **P1 trust root** — each side holds an Ed25519 `did:key`, signs its AgentCard (JWS), and verifies
  the peer's identity before accepting work. Requests carry an `X-IFlow-Signature` envelope.
- **P2 delegation grants** — an agent can issue scoped, budgeted grants (level **L0–L3**, capability
  set, expiry, revocation) and pass them with `X-IFlow-Grant`, so a peer can act *for* it under a
  defined level instead of full trust.
- **P4 token metering** — tokens and estimated cost are recorded per task (idempotent, deduped),
  with a per-model pricing map, so the economy layer can settle later.
- **Conversations, not sessions** — a thread between two agents is a `conversationId` (carried as the
  A2A `contextId`), and each side binds it to a DSH session of its own. The peer's second message
  reaches a model that remembers the first; deleting the local session does not end the conversation,
  it just binds a new one. Neither side ever learns the other's session id, and iFlow stores no
  transcript: `conversation.*` facts carry a content digest, never the text.
- **First contact waits for a person** — a message from an unknown agent is held as a pending request:
  no session, no model, no tools, no tokens. `iflow_conversations` lists what is waiting and accepts
  or rejects it; `trust` promotes a peer to auto-accept. This is a *separate* layer from the
  restricted `remote-a2a` preset — that governs what an accepted task may do, this governs whether a
  stranger gets to make this machine do anything at all.
- **Relay, for peers you cannot dial** — two machines behind different NATs have no direct route, so
  one leaves a sealed envelope with the Community and the other collects it. What is sealed is the
  *complete signed A2A request*, so the recipient runs the same verification it runs on a direct
  connection — there is no relay-specific trust path, because there is no relay-specific message.
  The relay stores an opaque blob it holds no key for, cannot re-address it (the ciphertext is bound
  to its conversation, message id and recipient), and empties it on collection, keeping only the
  delivery receipt.
- **Pinned peer identities** — a peer's `did:key` is recorded the first time it is seen and every
  later sighting must match; a peer that presents a different key is refused, loudly, rather than
  believed. See *Key distribution* below for what that does and does not protect.
- **Offline mailbox** — a persistent outbox/`inbox` (`peers.json` registry; `mailbox.json` queue):
  messages to a peer that is offline and has no relay route are queued and redelivered, on the same
  conversation and with the same message id, so a retry cannot be delivered twice.
- **Runtime health** — peer reachability is probed on read; registrations are persisted so they
  survive restarts.
- **Origin Journal + projections** — DSH session, turn, tool and approval lifecycles are journaled
  as append-only `IFlowEvent`s under `<workspace>/.iflow/edge/origin.ndjson`, folded into local
  projections, and served read-only at `/iflow/projection/*`, `/iflow/journal` and `/iflow/stream`.
  Deleting the projections and replaying the journal reproduces the same state.
- **Signed facts** — every journaled event carries a detached Ed25519 signature over its canonical
  bytes, made by the same `iflow-id` key that signs the AgentCard. A verifier can therefore check any
  fact off-node. An edge with no key material still journals; those events are counted as unsigned
  rather than silently dropped.
- **Command path (opt-in, authenticated)** — `POST /iflow/command` lets a Hub request an action. It
  is refused outright unless `config.acceptCommands` is set, and it answers `503` until a shared
  token exists (`config.token`, or `iflow_set_token` at runtime): the one write route never serves
  unauthenticated, however the port is bound. A repeated delivery never executes twice, and nothing
  on it can grant a permission DSH would deny.

## Install

iFlow is a standard `dsh-plugin`. Install it into the `web` profile from GitHub:

```sh
dsh plugin --profile web add github:Neo-Pz/dsh && dsh web
```

The `iflow-id` binary (the Rust trust root) is built by GitHub Actions on every `v*` tag and attached
to the [Release](https://github.com/Neo-Pz/dsh/releases/latest) — for Windows/macOS/Linux. A fresh
install auto-fetches the one matching your OS, so **no local Rust build is needed**.

To also mount the [terminal panel](https://github.com/siberiah2o/dsh-plugin-terminal):

```sh
dsh plugin --profile web add dsh-plugin-terminal
```

## Quick start (two DSH machines)

1. Install iFlow on both machines (above), and make each `dsh web` reachable on the LAN
   (`0.0.0.0` binding — see the webserver profile patch).
2. Register a peer on each side with the shared bearer token, e.g.:
   ```sh
   dsh plugin ...   # (via the plugin's iflow_* tools, or the AgentCard endpoint)
   ```
3. Use the `iflow_send` tool (host-side) to delegate a task to the peer; the peer runs it as a local
   agent and returns the final answer.

> **Inbound tasks are confined, and fail closed.** A remote peer's task runs under the restricted
> `remote-a2a` agent preset. If that preset is not installed, the task is **rejected** rather than
> silently downgraded to the full local toolset. Set `config.inboundPreset` to name a different
> restricted preset, or `config.allowUnrestrictedInbound: true` to accept the risk deliberately.

## Key distribution, and its one weak moment

Sealing a message needs the recipient's `did:key`. That makes "where did this DID come from" the
whole of the encryption story: whoever can substitute it can read everything sent afterwards, and
the ciphertext looks perfect the entire time.

The rule is the one SSH uses for host keys, for the same reason — there is no authority to ask:

- The first `did:key` seen for a peer is **pinned** in `peers.json`.
- Every later sighting must match. A mismatch is **refused**, never silently adopted.

**Be clear about what this does not do.** It does not make first contact safe. If the very first
sighting is a lie — a relay serving its own DID instead of the peer's — the pin records the lie and
everything after is consistent with it. What pinning buys is that the window is exactly one moment
per peer, and that attacking later means breaking a pin, which is loud.

Two ways to close that window, if a peer matters enough:

```sh
# 1. Learn the key over a direct connection, before ever using the relay.
iflow_discover peer=if-lt-b

# 2. Or check the did with a person and pass it in.
iflow_add_peer name=if-lt-b url=… did=did:key:z6Mk…
```

`iflow_discover` prints a short fingerprint (`z6Mkeuov…RaKZWg3`) for exactly this: reading 48 base58
characters down a phone line is how key verification stops happening.

## The protocol

- **Transport**: JSON-RPC 2.0 over HTTP (`/a2a`), AgentCard at `/.well-known/agent-card.json`.
- **Identity**: Ed25519 `did:key`; signed AgentCard (JWS); request envelope `X-IFlow-Signature`.
- **Authorization**: `X-IFlow-Grant` = DelegationGrant (scope/capabilities, level L0–L3, budget,
  expiry, issuer-root strength, revocation).
- **Metering**: per-task token/cost ledger in `.iflow/usage`, pricing map in `.iflow/pricing.json`.

The A2A method/enum/field names follow the [A2A protocol](https://github.com/a2aproject/A2A)
(JSON-RPC 2.0, camelCase fields, SCREAMING_SNAKE enums, error codes `-32001/-32002/-32004`).
`X-IFlow-Signature`, `X-IFlow-Grant` and the `signerDid` metadata are Intentional extensions.

## Architecture

- `src/index.ts` — the DSH Host plugin (`iflow_send`, peers, conversations, mailbox, metering, A2A
  dispatch).
- `src/conversation/store.ts` — the local half of a Conversation: the acceptance policy, and the
  `conversationId → local session id` binding. Kept at `<workspace>/.iflow/`, deliberately outside
  `.iflow/edge/`, so nothing that publishes can reach it.
- `src/relay/` — reaching a peer with no route. `envelope.ts` is the pure part (what gets sealed,
  and the additional data binding it to its conversation); `transport.ts` is the client and the poll
  loop. Sealing itself is `iflow-id seal` / `open` in `rust/src/envelope.rs`.
- `src/identity/pinning.ts` — trust on first use for a peer's `did:key`, and the refusal when it
  changes.
- `src/runtime/dsh-ports.ts` — DSH implementations of the iFlow `RuntimePorts` (storage, subprocess,
  HTTP, clock, logger, ids).
- `src/runtime/dsh-instrumentation.ts` — the only place that maps DSH lifecycle events to iFlow
  domain facts. Observe-only: it can never deny a tool call or delay a turn.
- `src/runtime/dsh-command-executor.ts` — the inbound command path, fail-closed by default.
- `src/edge/install.ts` — brings the edge up and mounts the read API.
- `src/identity/iflow-id.ts` — the `Signer`/`Verifier` ports, backed by the Rust binary. Key
  material never enters the Node process.
- `src/a2a/`, `src/util/` — the pure A2A and hashing helpers (wire shapes, capability-id rules, the
  sandbox's hand-rolled SHA-256), extracted so they can be unit tested.
- `rust/` — the `iflow-id` reference implementation (identity/store, signing, AgentCard, grants,
  pricing, usage), invoked via `ctx.subprocess`.
- Runtime state lives under `<workspace>/.iflow/` (identity, nonces, peers, mailbox, conversations,
  trust, usage, pricing) and `<workspace>/.iflow/edge/` (origin journal, outbox, command ledger,
  checkpoint). The split is load-bearing: only `edge/` is ever read by anything that publishes, so
  the session bindings and message excerpts one level up cannot leave the machine by construction.

Those two `runtime/` files are the **entire** DSH coupling. Porting iFlow to another application
means writing their equivalents against `iflow-adapter-sdk`'s ports and passing its conformance
suite — nothing else in the core knows this runtime exists.

### Building

`lib/index.js` is the file DSH loads, and it is committed, so installing from GitHub needs no build.
Developing does:

```sh
npm install
node scripts/build.mjs   # bundles the iFlow core packages into lib/index.js
npm test                 # 41 tests, run against that bundle and the real iflow-id
```

The suite covers the architecture's five failure tests against a real on-disk journal, origin
signing end to end through the Rust binary, the command path's at-most-once guarantee across a
restart, and the pure helpers (including the hand-rolled SHA-256, pinned against `node:crypto`).

[`iflow-adapter-sdk`](https://www.npmjs.com/package/iflow-adapter-sdk) and its two dependencies are
`devDependencies`: the build inlines them into `lib/index.js`, so an install from git resolves
nothing at runtime and the one-click path keeps working. To develop against unreleased changes in
them, `npm link`.

## License

MIT.
