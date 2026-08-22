# iFlowOne core-centric, local-first, federated architecture

## Status and purpose

This document defines a core-centric, local-first, federated target architecture for iFlowOne and `iflow-dsh-plugin`, its DeepSeek Harness edge adapter.

It is a design baseline, not an implementation claim. The current plugin remains the source of truth for its existing A2A, P1, P2, mailbox, and metering behavior until a replacement is shipped and verified.

## Architecture principle

iFlow itself is neither a Community deployment, a DSH plugin, nor A2A. It is an Agent Network Domain and Event System: its ontology, event semantics, journals, projectors, and read models can exist locally, synchronize between nodes, and be hosted by different runtimes.

The lasting iFlow asset is:

```text
Agent Network Ontology + Event Semantics + Event Journal + Projection Model
```

`iflow-domain` owns the ontology. `iflow-protocol` transports it. `iflow-adapter-sdk` makes runtimes participate. A Community is an optional network service that verifies, accepts, orders, and projects events from many origins.

## Product boundary

`iflow-dsh-plugin` is not the iFlowOne product. It is an edge adapter: it observes local DSH runtime facts, persists them as origin events, publishes signed events, receives authorized command requests, and asks DSH to execute them inside its local permission boundary.

The Hub evolves in three deployment modes:

1. **Embedded Hub**: a DSH-integrated UI reads Local Projections on one node.
2. **Networked Hub**: the same UI reads Local and Global Projections after synchronization.
3. **Standalone Web/App**: iFlowOne exposes the shared network experience independently of a particular runtime.

```text
Runtime -> Adapter -> iFlow Domain Core -> Origin Journal -> Local Projection -> Embedded Hub
                                      |
                                      +-> Sync -> Global Accepted Journal -> Global Projection -> Networked Hub / Web

DSH, Codex, OpenClaw, and other runtimes each attach through an Adapter. A2A remains in the Adapter/Transport layer. OpenTelemetry is derived from runtime and Journal facts.
```

| Component | Owns | Does not own |
| --- | --- | --- |
| DeepSeek Harness | Agent execution, Sessions, tools, sandbox, local permissions | iFlow domain, global community truth |
| `iflow-domain` | Agent, Goal, Task, Room, Event; reducers, state machines, projectors, event semantics | Transport, runtime-specific code, deployment |
| `iflow-protocol` | Envelopes, signatures, serialization, version negotiation, sync | Domain state rules and runtime integration |
| `iflow-adapter-sdk` | Runtime adapters, origin journaling, outbox, local command execution | Global acceptance, reputation, community UI |
| `iflow-dsh-plugin` | DSH Adapter implementation | Community projections, reputation, primary Web UI |
| iFlowOne Community | Global event acceptance, global ordering, shared projections, directory, Rooms, command routing | Origin facts and direct tool or shell execution |
| iFlow Hub | Local or Global Projection read experience | Runtime enforcement and secret handling |

The command rule is fixed:

```text
Hub or Community requests an action
  -> edge adapter verifies identity, grant, budget, and local DSH policy
  -> DSH executes or rejects the action
  -> edge adapter publishes the outcome as events
```

No Hub, Community, or transport may bypass a local runtime's permission policy.

## Domain model

iFlowOne owns five first-class objects.

| Object | Question answered | Notes |
| --- | --- | --- |
| Agent | Who is acting? | Stable identity, capabilities, trust evidence, runtime state |
| Goal | Why is work happening? | Human or Agent intent, constraints, optional budget |
| Task | What concrete work is happening? | State, owner, delegation, dependencies, outputs |
| Room | Who is collaborating? | Goal or root Task coordination space, not ordinary chat |
| Event | What happened and why did state change? | Append-only business fact |

Agent state has independent axes:

```text
presence:     online | offline | unknown
execution:    idle | running | paused | failed
coordination: ready | waiting | blocked | awaiting_approval
```

For example, one Agent may be `online + running + awaiting_approval`.

Every cross-component fact uses a versioned envelope:

```ts
interface IFlowEvent<T = unknown> {
  id: string
  schemaVersion: number
  origin: { nodeId: string; streamId: string; seq: number }
  journalOffset?: number
  occurredAt: string
  observedAt?: string
  correlationId: string
  causationId?: string
  type: string
  issuer: { id: string; did?: string; kind: 'agent' | 'human' | 'system' }
  subject: { kind: 'agent' | 'goal' | 'task' | 'room' | 'artifact'; id: string }
  goalId?: string
  taskId?: string
  roomId?: string
  trace?: { traceId?: string; spanId?: string; parentSpanId?: string }
  payload: T
  evidence?: { source: 'dsh' | 'a2a' | 'user' | 'projection'; signature?: string }
}
```

`origin.seq` is monotonically increasing only inside one origin stream. `journalOffset` is assigned only by a Journal that accepts the event. It is never a substitute for origin order. `correlationId` groups one collaboration flow, `causationId` identifies the event that led to the fact, `occurredAt` is when the origin asserts it happened, and `observedAt` is when another node observed or accepted it.

Initial event types include `agent.registered`, `agent.presence_changed`, `goal.created`, `task.created`, `task.delegated`, `task.started`, `task.waiting`, `task.blocked`, `task.awaiting_approval`, `task.completed`, `task.failed`, `room.created`, `room.participant_joined`, `tool.call_started`, `tool.call_completed`, `approval.requested`, `approval.resolved`, `a2a.request_received`, `execution.attempt_started`, and `execution.attempt_finished`.

Events describe facts that already happened. Model suggestions must be marked as `declared_plan`, `derived_next_step`, or `suggested_action`; UI must not present a suggestion as an observed fact.

`ExecutionAttempt` is not a sixth first-class iFlow object. A Task is work that must be completed; an Attempt is one real execution of it, potentially retried, migrated, or reassigned. A trace observes one Attempt. This prevents runtime-specific retry behavior from changing Task semantics.

## Event Journal and observability

Every fact has an **Origin Journal** and may later enter a **Global Accepted Journal**.

```text
Runtime fact happens on a DSH edge
  -> DSH Adapter signs and appends to that edge's Origin Journal
  -> Local Projection updates; local work continues while offline
  -> sync transmits the event
  -> Community or federated peer verifies, deduplicates, and accepts it
  -> Global Accepted Journal assigns journalOffset
  -> Global Projection updates
```

The origin edge is the authority for facts that happened inside its runtime boundary. A Community accepts and observes those facts; it does not manufacture them. This preserves local-first operation and enables future multiple machines, organizations, and federated services.

Both Journals are append-only. Projections can be deleted and rebuilt from their governing Journal.

### Command contract

Commands request future actions and are not Events. Their contract is separate:

```ts
interface IFlowCommand {
  commandId: string
  idempotencyKey: string
  issuer: { id: string; did?: string }
  target: { nodeId: string; agentId?: string; taskId?: string }
  requestedAction: string
  grantRef?: string
  budgetConstraint?: unknown
  expiresAt: string
  correlationId: string
  causationId?: string
}
```

The required chain is:

```text
CommandRequested -> CommandAccepted or CommandRejected -> ExecutionAttempt -> Domain Events
```

Edges deduplicate by `commandId` and `idempotencyKey` before side effects. Repeated Community delivery, including after an acknowledgement timeout, must execute a real action at most once.

### Projection architecture

Projection is an iFlow Core concept, not a Community-only worker:

```text
Journal -> Projector -> versioned Read Model -> Hub
```

Required read models include `AgentStateView`, `RoomView`, `TaskGraphView`, `NetworkGraphView`, `ActivityFeedView`, and `TrustEvidenceView`. Every projection stores a `projectionVersion` and cursor. A new graph algorithm or state rule creates a rebuildable v2 projection; it never mutates historical facts.

OpenTelemetry is a downstream observability projection for traces, metrics, logs, latency analysis, and cross-runtime correlation. It is not the sole audit, state, or replay store.

```text
Origin runtime fact
  -> signed Origin Journal write
  -> Local Projection update
  -> asynchronous OpenTelemetry export
```

One Task execution maps to one trace. Agent execution, LLM requests, tool calls, approvals, and A2A calls become spans. A Room is a durable business container and should be an `iflow.room.id` attribute or trace link, not an unbounded span.

No exporter may receive private keys, bearer tokens, raw grants, unredacted sensitive prompts, or unredacted tool output.

Presence uses a separate ephemeral channel with `lastSeen` and lease/TTL. High-rate heartbeats do not enter the permanent Journal. Only business-significant presence transitions such as `offline -> online` or `online -> offline` become durable events.

## Community as a network service

Community is a network service built on iFlow Core. It is not iFlow itself. Its role is to verify, accept, sequence, distribute, and project origin events from multiple nodes.

The first vertical slice needs only a thin Core API: signed-event ingestion, one governing Journal, projection reads, command delivery, and realtime updates for one Room. Directory federation, broad discovery, and scale services must not block either Hub or Adapter development.

The first Community deployment uses:

```text
Community API
  |- identity and membership
  |- signed event ingestion and global acceptance
  |- Global Accepted Journal
  |- projection workers
  |- Agent directory
  |- Task Room service
  |- command gateway
  |- realtime subscriptions
  `- audit and replay queries
```

Suggested initial stores:

| Data | Initial store |
| --- | --- |
| Global Accepted Journal and shared projections | PostgreSQL |
| Attachments and artifacts | Object storage |
| Web realtime connections | Community API with WebSocket or SSE |
| Origin Journal and retry queue | Adapter-local append-only files |

NATS, Temporal, OpenFGA, and OpenIM are not first-release prerequisites. They are later scale or specialization choices, not the MVP foundation.

## Hub UI evolution

`iflow-hub-ui` is a shared projection-driven UI package and must begin with the first vertical slice. Embedded in DSH it reads Local Projections; in iFlowOne Web it reads Global Projections, or a contract-compatible mock event feed while the network service is still being built. A standalone iFlowOne Web/App is a later deployment of the same UI, not a second UI or domain model.

Initial routes:

```text
/agents
/agents/:agentId
/network
/rooms/:roomId
/goals/:goalId
/tasks/:taskId
```

The first product entries are identical in embedded and networked modes:

1. **Agent directory**: AgentCard, DID verification, capabilities, trust evidence, activity, and links to Rooms or DSH Sessions.
2. **Agent network graph**: current projections of Agent, Goal, Task, and Room relationships. Cytoscape.js is the intended graph renderer.
3. **Task Room and activity**: Task DAG, participants, blocking conditions, approvals, artifacts, and event timeline. React Flow is the intended Task DAG renderer.

The graph is a `NetworkGraphView` projection. It displays delegation, dependency, participation, trust, delivery, and approval relationships; it does not render every raw log line as an edge.

## Core package split

The former single `iflow-protocol` responsibility is split deliberately:

```text
iflow-domain
  Agent, Goal, Task, Room, Event
  event semantics, reducers, state machines, projectors, projections

iflow-protocol
  envelopes, signatures, serialization, schema negotiation, sync compatibility

iflow-adapter-sdk
  origin journaling, outbox, command client, Runtime and A2A integration helpers
```

`iflow-domain` is the only layer allowed to define the five core objects and their state semantics. `iflow-protocol` cannot create domain rules. `iflow-adapter-sdk` cannot define a runtime-independent Task state or accept a command without the local runtime's enforcement decision.

## Target DSH adapter

The current plugin keeps peer and mailbox JSON files under `.iflow`, runs inbound requests as child Agents, exposes A2A endpoints, and registers many operational tools. Those proof-of-concept capabilities must be separated before the plugin becomes a durable adapter.

Target module layout:

```text
src/
  index.ts
  identity/iflow-id.ts
  runtime/dsh-instrumentation.ts
  runtime/dsh-command-executor.ts
  edge/origin-journal.ts
  edge/directory-cache.ts
  edge/community-sync.ts
  edge/command-client.ts
  telemetry/otel-exporter.ts
```

The plugin keeps:

- Rust `iflow-id` identity, signatures, replay checks, and grants.
- A2A server/client transport.
- DSH Agent, Subagent, Tool, Approval, and Session lifecycle observation.
- Local Origin Journal, sync cursor, and command de-duplication.
- Local DSH permission and sandbox enforcement.

The plugin changes:

| Current capability | Target treatment |
| --- | --- |
| Global `iflow-mirror` and `mirrorPeer` | Legacy read-only history; no new product behavior |
| `peers.json` | Community directory cache, not canonical registry |
| `mailbox.json` | General signed event outbox backed by an Origin Journal and cursor synchronization |
| In-memory task map | Local execution-handle registry only; iFlow projectors own collaborative Task projections |
| Usage and pricing files | Emit usage events; Community later owns reporting and settlement |
| `iflow_pull` remote source update | Development-only; absent from production adapter |

For portability, the first Origin Journal uses append-only NDJSON and compacted checkpoints rather than a native SQLite dependency:

```text
<workspace>/.iflow/edge/
  origin.ndjson
  outbox.ndjson
  checkpoint.json
  trusted-directory.json
  commands.ndjson
```

The adapter writes an event to the Origin Journal before upload. Global cursor acknowledgements make restarts and retries safe; a duplicate command must never execute twice.

## A2A policy

A2A remains iFlowOne's Adapter/Transport-layer task transport and capability-discovery protocol. It does not enter Domain Core. iFlow defines Goal, Room, trust, budget, event, and network semantics in `iflow-domain`; `iflow-protocol` carries compatible versioned representations between processes and machines.

The adapter must perform an explicit compatibility review before moving from the currently implemented A2A behavior to A2A 1.0. Version support, AgentCard declarations, task lifecycle semantics, streaming, and push notifications must be tested rather than inferred from one header value.

## Delivery strategy: shared contract, parallel work, vertical slice

The only short sequential prerequisite is a sufficiently stable shared contract. After that, the DSH Adapter and iFlow Hub/Web develop in parallel against the same fixtures, schemas, and conformance tests. They must converge on one real scenario, rather than become two independently complete products.

```text
P0 proof-of-concept freeze
  -> P1 shared Domain / Event / Command / Projection contract
       |- P2A DSH durable adapter -------|
       |- P2B shared iflow-hub-ui --------|-> P3 thin Core API + one Journal / Projection API
       `- P2C mock feeds + fixtures ------|                         |
                                                              P4 first vertical slice
                                                                      |
                                                   P5 federation, directory, reputation, economy
```

### P0: freeze the proof of concept

- Do not add product features to `iflow-mirror`.
- Keep existing P1, P2, A2A, and task execution paths working.
- Restrict source self-update to development workflows.
- Publish the product boundary and architecture decisions.

### P1: freeze the shared contract quickly

- Create `iflow-domain` with Agent, Goal, Task, Room, Event, state semantics, reducers, projectors, and projection read-model contracts.
- Create `iflow-protocol` with `IFlowEvent`, `IFlowCommand`, envelopes, signing rules, sync representation, version negotiation, and A2A compatibility contracts.
- Create `iflow-adapter-sdk` with Origin Journal, outbox, command idempotency, and runtime instrumentation contracts.
- Publish TypeScript types, JSON Schema, lifecycle-to-event mappings, fixtures, and conformance tests.
- Freeze only what the first slice needs; do not delay delivery by trying to model every future community feature.

### P2: develop Adapter and Hub in parallel

| Workstream | Responsibility | First usable output |
| --- | --- | --- |
| P2A: `iflow-dsh-plugin` | Observe DSH Agent, Session, Tool, and Approval lifecycles; create signed facts; persist an Origin Journal; execute authorized Commands; enforce deduplication and local permissions | A real local event stream and an offline-safe command receipt ledger |
| P2B: `iflow-hub-ui` / iFlowOne Web | Build AgentCard, Network Graph, Task Room, Activity Timeline, Approval UI, and Replay | Projection-driven screens using Local Projections or a contract-compatible mock feed |
| P2C: thin Core bridge | Provide one event ingestion path, Journal, projection read API, command delivery path, and Room realtime feed | A deliberately small integration surface for the first Room |

The Web team must not wait for the full Adapter refactor or a complete Community service. The Adapter team must not wait for directory, federation, or a finished Web application before producing real Events. Mock feeds are a development tool only: their shape is governed by the same contracts and is replaced by Origin Journal facts as soon as each lifecycle mapping is ready.

### P3: converge on one Journal and Projection API

- Connect real Adapter events to the same Journal and Projectors consumed by `iflow-hub-ui`.
- Let the embedded Hub read Local Projection while iFlowOne Web reads the corresponding Global Projection through the same view contracts.
- Connect Task Room approval actions to the Command path; the DSH Edge remains the enforcement point.
- Retire each mock feed only after the equivalent signed Origin Event is available.

### P4: complete the first vertical slice

A vertical slice means cutting through runtime, journal, projection, and interface for one complete user outcome—not completing one technical layer at a time. The first slice is:

```text
GoalCreated
  -> LeadAgentAccepted
  -> TaskCreated
  -> ChildAgentStarted
  -> ToolCalled
  -> ApprovalRequested
  -> user approves in Task Room
  -> TaskCompleted
  -> ArtifactProduced
  -> Replay
```

### P5: expand only after the slice is real

- Add A2A 1.0 compatibility, remote runtime adapters, cross-machine synchronization, and offline reconciliation.
- Then add public directory, capability discovery, reputation evidence, endorsements, relationship authorization, durable workflow orchestration, event bus, and economic features as real scale requires them.

## First end-to-end acceptance scenario

The first success criterion is not a chat screen. It is one real multi-Agent execution:

```text
User creates a Goal
  -> DSH Lead Agent accepts it
  -> Lead delegates two child Agents
  -> one child invokes a tool
  -> another child blocks on an approval
  -> user resolves approval in an iFlowOne Task Room
  -> both children complete
  -> Lead produces the final artifact
  -> iFlowOne replays the complete event sequence and explains the blocking cause
```

The scenario must also pass these failure tests:

1. A Community outage does not stop local DSH work or Local Projection updates.
2. A successful event upload followed by a lost acknowledgement does not create a second accepted fact after retry.
3. Repeated delivery of one command never produces more than one real side effect.
4. Deleting all projections and rebuilding from the governing Journal recreates the same state.
5. A forged event, expired grant, or out-of-scope command is rejected at the Origin Edge.

If this scenario and the failure tests pass, iFlow is signed, recoverable after restart, locally useful while offline, visible as a network and Task Room, and unable to bypass local DSH permissions.
