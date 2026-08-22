# iFlow

**Agent2Agent (A2A) bridge + agent identity / delegation / metering for DeepSeek Harness (DSH).**

iFlow is both a **DSH plugin** and a small **protocol**. It gives agents on different DSH machines a
signed, task-oriented A2A channel: each side identifies itself with a `did:key` trust root, can
delegate work under scoped grants (L0–L3), and meters the tokens it sends and receives.

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
- **In-session mirror** — a live "iFlow · 双向镜像" conversation shows both sides (remote left, self
  right), survives restart (retire/re-adopt), and lets the operator type into the agent-to-agent flow
  (marked `[agent:…]` vs bare human input).
- **Offline mailbox** — a persistent outbox/`inbox` (`peers.json` registry; `mailbox.json` queue):
  messages to a peer that is offline are queued and redelivered when it returns.
- **Runtime health** — peer reachability is probed on read; registrations are persisted so they
  survive restarts.

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

- `src/index.ts` — the DSH Host plugin (`iflow_send`, peers, mirror, mailbox, metering, A2A dispatch).
- `rust/` — the `iflow-id` reference implementation (identity/store, signing, AgentCard, grants,
  pricing, usage), invoked via `ctx.subprocess`.
- Runtime state lives under `<workspace>/.iflow/` (identity, nonces, peers, mailbox, usage, pricing).

## License

MIT.
