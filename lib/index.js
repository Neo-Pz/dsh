// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
import { join } from "node:path";
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { fileURLToPath } from "node:url";

// src/edge/install.ts
import { hostname } from "node:os";

// node_modules/iflow-protocol/dist/index.js
var CanonicalizationError = class extends Error {
  constructor(message, path) {
    super(`${message} (at ${path || "<root>"})`);
    this.path = path;
    this.name = "CanonicalizationError";
  }
  path;
};
function sortValue(value, path) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") {
    const n = value;
    if (!Number.isFinite(n)) {
      throw new CanonicalizationError(`non-finite number ${String(n)} is not JSON`, path);
    }
    if (!Number.isInteger(n)) {
      throw new CanonicalizationError(
        `non-integer number ${n} cannot canonicalize identically in Rust and JS; use a string`,
        path
      );
    }
    return n;
  }
  if (type === "bigint") {
    throw new CanonicalizationError("bigint is not JSON; use a string", path);
  }
  if (type === "function" || type === "symbol" || type === "undefined") {
    throw new CanonicalizationError(`${type} cannot be canonicalized`, path);
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => sortValue(item, `${path}[${i}]`));
  }
  const source = value;
  const keys = Object.keys(source).sort();
  const out = {};
  for (const key of keys) {
    const child = source[key];
    if (child === void 0) continue;
    out[key] = sortValue(child, path ? `${path}.${key}` : key);
  }
  return out;
}
function canonicalJson(value) {
  return JSON.stringify(sortValue(value, ""));
}
function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalJson(value));
}
function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - padded.length % 4) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
function signableBytes(event) {
  const { journalOffset: _offset, observedAt: _observed, evidence, ...rest } = event;
  if (evidence === void 0) return canonicalBytes(rest);
  const { signature: _signature, ...evidenceWithoutSignature } = evidence;
  return canonicalBytes({ ...rest, evidence: evidenceWithoutSignature });
}
var EVENT_SCHEMA_VERSION = 1;
var ISSUER_KINDS = /* @__PURE__ */ new Set(["agent", "human", "system"]);
var SUBJECT_KINDS = /* @__PURE__ */ new Set(["agent", "goal", "task", "room", "artifact"]);
var EVIDENCE_SOURCES = /* @__PURE__ */ new Set(["dsh", "a2a", "user", "projection"]);
var ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
var Check = class {
  issues = [];
  fail(path, message) {
    this.issues.push({ path, message });
  }
  string(value, path, { required = true } = {}) {
    if (value === void 0) {
      if (required) this.fail(path, "is required");
      return;
    }
    if (typeof value !== "string" || value.length === 0) this.fail(path, "must be a non-empty string");
  }
  timestamp(value, path, { required = true } = {}) {
    if (value === void 0) {
      if (required) this.fail(path, "is required");
      return;
    }
    if (typeof value !== "string" || !ISO_8601.test(value)) {
      this.fail(path, "must be an ISO-8601 timestamp with an explicit offset");
    }
  }
  enum(value, path, allowed) {
    if (typeof value !== "string" || !allowed.has(value)) {
      this.fail(path, `must be one of ${[...allowed].join(" | ")}`);
    }
  }
  object(value, path) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(path, "must be an object");
      return false;
    }
    return true;
  }
};
function validateEvent(candidate) {
  const check = new Check();
  if (!check.object(candidate, "")) return { valid: false, issues: check.issues };
  const event = candidate;
  check.string(event.id, "id");
  check.string(event.type, "type");
  check.string(event.correlationId, "correlationId");
  check.string(event.causationId, "causationId", { required: false });
  check.timestamp(event.occurredAt, "occurredAt");
  check.timestamp(event.observedAt, "observedAt", { required: false });
  if (typeof event.schemaVersion !== "number" || !Number.isInteger(event.schemaVersion) || event.schemaVersion < 1) {
    check.fail("schemaVersion", "must be a positive integer");
  }
  if (check.object(event.origin, "origin")) {
    const origin = event.origin;
    check.string(origin["nodeId"], "origin.nodeId");
    check.string(origin["streamId"], "origin.streamId");
    if (typeof origin["seq"] !== "number" || !Number.isInteger(origin["seq"]) || origin["seq"] < 0) {
      check.fail("origin.seq", "must be a non-negative integer");
    }
  }
  if (event.journalOffset !== void 0) {
    if (!Number.isInteger(event.journalOffset) || event.journalOffset < 0) {
      check.fail("journalOffset", "must be a non-negative integer when present");
    }
  }
  if (check.object(event.issuer, "issuer")) {
    const issuer = event.issuer;
    check.string(issuer["id"], "issuer.id");
    check.string(issuer["did"], "issuer.did", { required: false });
    check.enum(issuer["kind"], "issuer.kind", ISSUER_KINDS);
  }
  if (check.object(event.subject, "subject")) {
    const subject = event.subject;
    check.string(subject["id"], "subject.id");
    check.enum(subject["kind"], "subject.kind", SUBJECT_KINDS);
  }
  for (const key of ["goalId", "taskId", "roomId"]) {
    check.string(event[key], key, { required: false });
  }
  if (event.evidence !== void 0 && check.object(event.evidence, "evidence")) {
    const evidence = event.evidence;
    check.enum(evidence["source"], "evidence.source", EVIDENCE_SOURCES);
    check.string(evidence["signature"], "evidence.signature", { required: false });
  }
  if (!("payload" in event)) check.fail("payload", "is required");
  return { valid: check.issues.length === 0, issues: check.issues };
}
function validateCommand(candidate) {
  const check = new Check();
  if (!check.object(candidate, "")) return { valid: false, issues: check.issues };
  const command = candidate;
  check.string(command.commandId, "commandId");
  check.string(command.idempotencyKey, "idempotencyKey");
  check.string(command.requestedAction, "requestedAction");
  check.string(command.correlationId, "correlationId");
  check.string(command.causationId, "causationId", { required: false });
  check.string(command.grantRef, "grantRef", { required: false });
  check.timestamp(command.expiresAt, "expiresAt");
  if (check.object(command.issuer, "issuer")) {
    const issuer = command.issuer;
    check.string(issuer["id"], "issuer.id");
    check.string(issuer["did"], "issuer.did", { required: false });
  }
  if (check.object(command.target, "target")) {
    const target = command.target;
    check.string(target["nodeId"], "target.nodeId");
    check.string(target["agentId"], "target.agentId", { required: false });
    check.string(target["taskId"], "target.taskId", { required: false });
  }
  return { valid: check.issues.length === 0, issues: check.issues };
}

// node_modules/iflow-domain/dist/index.js
var INITIAL_AGENT_STATE = {
  presence: "unknown",
  execution: "idle",
  coordination: "ready"
};
var TASK_TRANSITIONS = Object.freeze({
  created: ["delegated", "running", "waiting", "blocked", "failed", "completed"],
  delegated: ["running", "waiting", "blocked", "awaiting_approval", "failed", "completed"],
  running: ["waiting", "blocked", "awaiting_approval", "completed", "failed"],
  waiting: ["running", "blocked", "awaiting_approval", "completed", "failed"],
  blocked: ["running", "waiting", "awaiting_approval", "completed", "failed"],
  awaiting_approval: ["running", "waiting", "blocked", "completed", "failed"],
  completed: [],
  failed: ["running"]
});
function canTransition(from, to) {
  return TASK_TRANSITIONS[from].includes(to);
}
var EVENT_TYPES = [
  "agent.registered",
  "agent.presence_changed",
  "goal.created",
  "task.created",
  "task.delegated",
  "task.started",
  "task.waiting",
  "task.blocked",
  "task.awaiting_approval",
  "task.completed",
  "task.failed",
  "room.created",
  "room.participant_joined",
  "tool.call_started",
  "tool.call_completed",
  "approval.requested",
  "approval.resolved",
  "a2a.request_received",
  "execution.attempt_started",
  "execution.attempt_finished",
  // Not in the architecture doc's initial list: the DSH edge already meters
  // tokens per task (P4), and that fact needs a home in the journal rather
  // than a second private ledger.
  "usage.recorded",
  // The economic layer. A price is a two-party fact, so it arrives as a pair:
  // a signed offer, and an acceptance that embeds and countersigns it.
  "quote.offered",
  "quote.accepted",
  "task.settled"
];
var EVENT_TYPE_SET = new Set(EVENT_TYPES);
function isKnownEventType(type) {
  return EVENT_TYPE_SET.has(type);
}
function isEventOfType(event, type) {
  return event.type === type;
}
var ACTIVITY_WINDOW = 500;
function emptyNetworkState() {
  return {
    agents: {},
    goals: {},
    tasks: {},
    rooms: {},
    toolCalls: {},
    approvals: {},
    quotes: {},
    recent: [],
    recentTruncated: false,
    streamCursors: {},
    lastEventId: void 0,
    eventCount: 0,
    unknownEventTypes: {},
    anomalies: []
  };
}
function ensureAgent(state, id, at) {
  const existing = state.agents[id];
  if (existing) return existing;
  const created = {
    id,
    label: id,
    nodeId: "unknown",
    runtimeKind: "unknown",
    capabilities: [],
    state: { ...INITIAL_AGENT_STATE },
    trustEvidence: [],
    registeredAt: at
  };
  state.agents[id] = created;
  return created;
}
function ensureTask(state, id, at) {
  const existing = state.tasks[id];
  if (existing) return existing;
  const created = {
    id,
    title: id,
    state: "created",
    dependsOn: [],
    attempts: [],
    outputs: [],
    createdAt: at,
    updatedAt: at
  };
  state.tasks[id] = created;
  return created;
}
function moveTask(state, task, to, event) {
  if (task.state !== to && !canTransition(task.state, to)) {
    state.anomalies.push({ eventId: event.id, taskId: task.id, from: task.state, to });
  }
  task.state = to;
  task.updatedAt = event.occurredAt;
}
function taskIdOf(event) {
  return event.taskId ?? (event.subject.kind === "task" ? event.subject.id : void 0);
}
function applyEvent(previous, event) {
  const state = cloneState(previous);
  state.eventCount += 1;
  state.lastEventId = event.id;
  const streamKey = streamKeyOf(event);
  const seenSeq = state.streamCursors[streamKey];
  if (seenSeq === void 0 || event.origin.seq > seenSeq) {
    state.streamCursors[streamKey] = event.origin.seq;
  }
  state.recent.push(event);
  if (state.recent.length > ACTIVITY_WINDOW) {
    state.recent.splice(0, state.recent.length - ACTIVITY_WINDOW);
    state.recentTruncated = true;
  }
  if (!isKnownEventType(event.type)) {
    state.unknownEventTypes[event.type] = (state.unknownEventTypes[event.type] ?? 0) + 1;
    return state;
  }
  reduceKnown(state, event);
  return state;
}
function streamKeyOf(event) {
  return event.origin.nodeId + "/" + event.origin.streamId;
}
function applyEvents(previous, events) {
  let state = previous;
  for (const event of events) state = applyEvent(state, event);
  return state;
}
function reduceEvents(events) {
  return applyEvents(emptyNetworkState(), events);
}
function reduceKnown(state, event) {
  const at = event.occurredAt;
  if (isEventOfType(event, "agent.registered")) {
    const agent = ensureAgent(state, event.subject.id, at);
    agent.label = event.payload.label;
    agent.nodeId = event.payload.nodeId;
    agent.runtimeKind = event.payload.runtimeKind;
    agent.capabilities = [...event.payload.capabilities];
    if (event.payload.did !== void 0) agent.did = event.payload.did;
    if (event.payload.trustEvidence) agent.trustEvidence = [...event.payload.trustEvidence];
    agent.state = { ...agent.state, presence: "online" };
    agent.lastSeenAt = at;
    return;
  }
  if (isEventOfType(event, "agent.presence_changed")) {
    const agent = ensureAgent(state, event.subject.id, at);
    const { presence, execution, coordination } = event.payload;
    agent.state = {
      presence: presence ?? agent.state.presence,
      execution: execution ?? agent.state.execution,
      coordination: coordination ?? agent.state.coordination
    };
    agent.lastSeenAt = at;
    return;
  }
  if (isEventOfType(event, "goal.created")) {
    state.goals[event.subject.id] = {
      id: event.subject.id,
      title: event.payload.title,
      issuerId: event.issuer.id,
      constraints: event.payload.constraints ? [...event.payload.constraints] : void 0,
      budget: event.payload.budget,
      createdAt: at,
      roomId: event.payload.roomId ?? event.roomId
    };
    return;
  }
  if (isEventOfType(event, "task.created")) {
    const task = ensureTask(state, event.subject.id, at);
    task.title = event.payload.title;
    task.goalId = event.goalId;
    task.roomId = event.roomId;
    task.parentTaskId = event.payload.parentTaskId;
    task.dependsOn = event.payload.dependsOn ? [...event.payload.dependsOn] : [];
    if (event.payload.ownerAgentId) task.ownerAgentId = event.payload.ownerAgentId;
    task.updatedAt = at;
    return;
  }
  if (isEventOfType(event, "task.delegated")) {
    const task = ensureTask(state, event.subject.id, at);
    task.ownerAgentId = event.payload.toAgentId;
    ensureAgent(state, event.payload.toAgentId, at);
    moveTask(state, task, "delegated", event);
    return;
  }
  if (isEventOfType(event, "task.started")) {
    const task = ensureTask(state, event.subject.id, at);
    task.ownerAgentId = event.payload.agentId;
    ensureAgent(state, event.payload.agentId, at);
    if (!task.attempts.some((a) => a.attemptId === event.payload.attemptId)) {
      task.attempts.push({ attemptId: event.payload.attemptId, agentId: event.payload.agentId, startedAt: at });
    }
    task.blockingReason = void 0;
    moveTask(state, task, "running", event);
    return;
  }
  if (isEventOfType(event, "task.waiting")) {
    const task = ensureTask(state, event.subject.id, at);
    task.blockingReason = event.payload.reason;
    moveTask(state, task, "waiting", event);
    return;
  }
  if (isEventOfType(event, "task.blocked")) {
    const task = ensureTask(state, event.subject.id, at);
    task.blockingReason = event.payload.reason;
    if (event.payload.blockedOnTaskId && !task.dependsOn.includes(event.payload.blockedOnTaskId)) {
      task.dependsOn.push(event.payload.blockedOnTaskId);
    }
    moveTask(state, task, "blocked", event);
    return;
  }
  if (isEventOfType(event, "task.awaiting_approval")) {
    const task = ensureTask(state, event.subject.id, at);
    task.blockingReason = event.payload.reason;
    moveTask(state, task, "awaiting_approval", event);
    return;
  }
  if (isEventOfType(event, "task.completed")) {
    const task = ensureTask(state, event.subject.id, at);
    task.blockingReason = void 0;
    for (const output of event.payload.outputs ?? []) {
      task.outputs.push({ kind: output.kind, id: output.id, summary: output.summary, at });
    }
    moveTask(state, task, "completed", event);
    return;
  }
  if (isEventOfType(event, "task.failed")) {
    const task = ensureTask(state, event.subject.id, at);
    task.blockingReason = event.payload.reason;
    task.outputs.push({ kind: "error", id: event.id, summary: event.payload.reason, at });
    moveTask(state, task, "failed", event);
    return;
  }
  if (isEventOfType(event, "room.created")) {
    state.rooms[event.subject.id] = {
      id: event.subject.id,
      title: event.payload.title,
      goalId: event.payload.goalId ?? event.goalId,
      rootTaskId: event.payload.rootTaskId,
      participantAgentIds: [],
      createdAt: at
    };
    return;
  }
  if (isEventOfType(event, "room.participant_joined")) {
    const room = state.rooms[event.subject.id];
    if (room && !room.participantAgentIds.includes(event.payload.agentId)) {
      room.participantAgentIds.push(event.payload.agentId);
    }
    ensureAgent(state, event.payload.agentId, at);
    return;
  }
  if (isEventOfType(event, "tool.call_started")) {
    state.toolCalls[event.payload.callId] = {
      callId: event.payload.callId,
      taskId: taskIdOf(event),
      agentId: event.payload.agentId,
      toolName: event.payload.toolName,
      startedAt: at
    };
    ensureAgent(state, event.payload.agentId, at);
    return;
  }
  if (isEventOfType(event, "tool.call_completed")) {
    const call = state.toolCalls[event.payload.callId];
    if (call) {
      call.finishedAt = at;
      call.outcome = event.payload.outcome;
      call.errorMessage = event.payload.errorMessage;
      return;
    }
    state.toolCalls[event.payload.callId] = {
      callId: event.payload.callId,
      taskId: taskIdOf(event),
      agentId: event.issuer.id,
      toolName: event.payload.toolName,
      startedAt: at,
      finishedAt: at,
      outcome: event.payload.outcome,
      errorMessage: event.payload.errorMessage
    };
    return;
  }
  if (isEventOfType(event, "approval.requested")) {
    state.approvals[event.payload.approvalId] = {
      approvalId: event.payload.approvalId,
      taskId: taskIdOf(event),
      agentId: event.payload.agentId,
      reason: event.payload.reason,
      requestedAt: at
    };
    const agent = ensureAgent(state, event.payload.agentId, at);
    agent.state = { ...agent.state, coordination: "awaiting_approval" };
    return;
  }
  if (isEventOfType(event, "approval.resolved")) {
    const approval = state.approvals[event.payload.approvalId];
    if (approval) {
      approval.resolvedAt = at;
      approval.decision = event.payload.decision;
      const agent = state.agents[approval.agentId];
      if (agent && agent.state.coordination === "awaiting_approval") {
        agent.state = { ...agent.state, coordination: "ready" };
      }
    }
    return;
  }
  if (isEventOfType(event, "a2a.request_received")) {
    const task = ensureTask(state, event.payload.remoteTaskId, at);
    if (event.payload.fromLabel) task.title = "A2A from " + event.payload.fromLabel;
    task.updatedAt = at;
    return;
  }
  if (isEventOfType(event, "execution.attempt_started")) {
    const taskId = taskIdOf(event);
    if (!taskId) return;
    const task = ensureTask(state, taskId, at);
    if (!task.attempts.some((a) => a.attemptId === event.payload.attemptId)) {
      task.attempts.push({
        attemptId: event.payload.attemptId,
        agentId: event.payload.agentId,
        startedAt: at,
        traceId: event.payload.traceId
      });
    }
    return;
  }
  if (isEventOfType(event, "execution.attempt_finished")) {
    const taskId = taskIdOf(event);
    if (!taskId) return;
    const task = state.tasks[taskId];
    const attempt = task?.attempts.find((a) => a.attemptId === event.payload.attemptId);
    if (attempt) {
      attempt.finishedAt = at;
      attempt.outcome = event.payload.outcome;
    }
    return;
  }
  if (isEventOfType(event, "quote.offered")) {
    const taskId = taskIdOf(event);
    if (!taskId) return;
    ensureTask(state, taskId, at);
    state.quotes[event.payload.quoteId] = {
      quoteId: event.payload.quoteId,
      taskId,
      offeredBy: event.payload.offeredBy,
      offeredTo: event.payload.offeredTo,
      amountMicros: event.payload.amountMicros,
      currency: event.payload.currency,
      capability: event.payload.capability,
      expiresAt: event.payload.expiresAt,
      terms: event.payload.terms,
      offeredAt: at
    };
    return;
  }
  if (isEventOfType(event, "quote.accepted")) {
    const quote = state.quotes[event.payload.quoteId];
    if (!quote) return;
    quote.acceptedAt = at;
    quote.acceptedBy = event.payload.acceptedBy;
    return;
  }
  if (isEventOfType(event, "task.settled")) {
    const taskId = taskIdOf(event);
    if (!taskId) return;
    const task = ensureTask(state, taskId, at);
    task.settlement = {
      taskId,
      quoteId: event.payload.quoteId,
      payerAgentId: event.payload.payerAgentId,
      payeeAgentId: event.payload.payeeAgentId,
      amountMicros: event.payload.amountMicros,
      currency: event.payload.currency,
      visibility: event.payload.visibility,
      basis: event.payload.basis,
      settlementRef: event.payload.settlementRef,
      settledAt: at
    };
    task.updatedAt = at;
    return;
  }
  if (isEventOfType(event, "usage.recorded")) {
    return;
  }
  const unreachable = event;
  void unreachable;
}
function cloneState(state) {
  return {
    agents: mapValues(state.agents, (a) => ({
      ...a,
      state: { ...a.state },
      capabilities: [...a.capabilities],
      trustEvidence: [...a.trustEvidence]
    })),
    goals: mapValues(state.goals, (g) => ({ ...g, constraints: g.constraints ? [...g.constraints] : void 0 })),
    tasks: mapValues(state.tasks, (t) => ({
      ...t,
      dependsOn: [...t.dependsOn],
      attempts: t.attempts.map((a) => ({ ...a })),
      outputs: t.outputs.map((o) => ({ ...o }))
    })),
    rooms: mapValues(state.rooms, (r) => ({ ...r, participantAgentIds: [...r.participantAgentIds] })),
    toolCalls: mapValues(state.toolCalls, (c) => ({ ...c })),
    approvals: mapValues(state.approvals, (a) => ({ ...a })),
    quotes: mapValues(state.quotes, (q) => ({ ...q })),
    recent: [...state.recent],
    recentTruncated: state.recentTruncated,
    streamCursors: { ...state.streamCursors },
    lastEventId: state.lastEventId,
    eventCount: state.eventCount,
    unknownEventTypes: { ...state.unknownEventTypes },
    anomalies: [...state.anomalies]
  };
}
function mapValues(source, fn) {
  const out = {};
  for (const key of Object.keys(source)) out[key] = fn(source[key]);
  return out;
}
var AGENT_STATE_PROJECTION_VERSION = 1;
var NETWORK_GRAPH_PROJECTION_VERSION = 1;
var ACTIVITY_FEED_PROJECTION_VERSION = 1;
var TASK_GRAPH_PROJECTION_VERSION = 1;
var ROOM_PROJECTION_VERSION = 1;
function meta(state, projectionVersion, options) {
  return {
    projectionVersion,
    cursor: state.lastEventId,
    streamCursors: { ...state.streamCursors },
    eventCount: state.eventCount,
    builtAt: options.builtAt
  };
}
function projectAgentState(state, options) {
  const agents = Object.values(state.agents).sort((a, b) => a.id.localeCompare(b.id));
  return { meta: meta(state, AGENT_STATE_PROJECTION_VERSION, options), data: { agents } };
}
function projectNetworkGraph(state, options) {
  const nodes = [];
  const edges = [];
  const nodeIds = /* @__PURE__ */ new Set();
  const addNode = (node) => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };
  const addEdge = (edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return;
    if (edges.some((e) => e.id === edge.id)) return;
    edges.push(edge);
  };
  for (const agent of Object.values(state.agents)) {
    addNode({
      id: agent.id,
      kind: "agent",
      label: agent.label,
      status: `${agent.state.presence}/${agent.state.execution}/${agent.state.coordination}`
    });
  }
  for (const goal of Object.values(state.goals)) {
    addNode({ id: goal.id, kind: "goal", label: goal.title });
  }
  for (const room of Object.values(state.rooms)) {
    addNode({ id: room.id, kind: "room", label: room.title });
  }
  for (const task of Object.values(state.tasks)) {
    addNode({ id: task.id, kind: "task", label: task.title, status: task.state });
  }
  for (const task of Object.values(state.tasks)) {
    if (task.ownerAgentId) {
      addEdge({
        id: `own:${task.ownerAgentId}->${task.id}`,
        source: task.ownerAgentId,
        target: task.id,
        kind: "ownership"
      });
    }
    if (task.parentTaskId) {
      addEdge({
        id: `deleg:${task.parentTaskId}->${task.id}`,
        source: task.parentTaskId,
        target: task.id,
        kind: "delegation"
      });
    }
    for (const dependency of task.dependsOn) {
      addEdge({ id: `dep:${task.id}->${dependency}`, source: task.id, target: dependency, kind: "dependency" });
    }
    if (task.goalId) {
      addEdge({ id: `goal:${task.goalId}->${task.id}`, source: task.goalId, target: task.id, kind: "delivery" });
    }
    if (task.roomId) {
      addEdge({ id: `room:${task.roomId}->${task.id}`, source: task.roomId, target: task.id, kind: "participation" });
    }
  }
  for (const room of Object.values(state.rooms)) {
    for (const agentId of room.participantAgentIds) {
      addEdge({ id: `part:${agentId}->${room.id}`, source: agentId, target: room.id, kind: "participation" });
    }
    if (room.goalId) {
      addEdge({ id: `rgoal:${room.id}->${room.goalId}`, source: room.id, target: room.goalId, kind: "delivery" });
    }
  }
  for (const approval of Object.values(state.approvals)) {
    if (!approval.taskId) continue;
    addEdge({
      id: `appr:${approval.approvalId}`,
      source: approval.agentId,
      target: approval.taskId,
      kind: "approval",
      label: approval.decision ?? "pending"
    });
  }
  for (const agent of Object.values(state.agents)) {
    if (agent.trustEvidence.length === 0 || !agent.did) continue;
    const node = nodes.find((n) => n.id === agent.id);
    if (node) node.status = `${node.status} \xB7 trust:${agent.trustEvidence.length}`;
  }
  return { meta: meta(state, NETWORK_GRAPH_PROJECTION_VERSION, options), data: { nodes, edges } };
}
function formatAmount(micros, currency) {
  return `${(micros / 1e6).toFixed(2)} ${currency}`;
}
function summarizeEvent(event) {
  if (!isKnownEventType(event.type)) return event.type;
  if (isEventOfType(event, "agent.registered")) return `Agent ${event.payload.label} registered on ${event.payload.nodeId}`;
  if (isEventOfType(event, "agent.presence_changed")) {
    const parts = [
      event.payload.presence && `presence=${event.payload.presence}`,
      event.payload.execution && `execution=${event.payload.execution}`,
      event.payload.coordination && `coordination=${event.payload.coordination}`
    ].filter(Boolean);
    return `Agent state ${parts.join(" ")}`;
  }
  if (isEventOfType(event, "goal.created")) return `Goal created: ${event.payload.title}`;
  if (isEventOfType(event, "task.created")) return `Task created: ${event.payload.title}`;
  if (isEventOfType(event, "task.delegated")) return `Task delegated to ${event.payload.toAgentId}`;
  if (isEventOfType(event, "task.started")) return `Task started by ${event.payload.agentId}`;
  if (isEventOfType(event, "task.waiting")) return `Task waiting: ${event.payload.reason}`;
  if (isEventOfType(event, "task.blocked")) return `Task blocked: ${event.payload.reason}`;
  if (isEventOfType(event, "task.awaiting_approval")) return `Task awaiting approval: ${event.payload.reason}`;
  if (isEventOfType(event, "task.completed")) return `Task completed${event.payload.summary ? `: ${event.payload.summary}` : ""}`;
  if (isEventOfType(event, "task.failed")) return `Task failed: ${event.payload.reason}`;
  if (isEventOfType(event, "room.created")) return `Room created: ${event.payload.title}`;
  if (isEventOfType(event, "room.participant_joined")) return `${event.payload.agentId} joined the room`;
  if (isEventOfType(event, "tool.call_started")) return `Tool ${event.payload.toolName} started`;
  if (isEventOfType(event, "tool.call_completed")) {
    return `Tool ${event.payload.toolName} ${event.payload.outcome}${event.payload.errorMessage ? `: ${event.payload.errorMessage}` : ""}`;
  }
  if (isEventOfType(event, "approval.requested")) return `Approval requested: ${event.payload.reason}`;
  if (isEventOfType(event, "approval.resolved")) return `Approval ${event.payload.decision}`;
  if (isEventOfType(event, "a2a.request_received")) {
    return `A2A request from ${event.payload.fromLabel ?? event.payload.fromDid ?? "unknown peer"}`;
  }
  if (isEventOfType(event, "execution.attempt_started")) return `Attempt ${event.payload.attemptId} started`;
  if (isEventOfType(event, "execution.attempt_finished")) {
    return `Attempt ${event.payload.attemptId} ${event.payload.outcome}`;
  }
  if (isEventOfType(event, "usage.recorded")) {
    const { input, output } = event.payload.tokens;
    return `Usage ${event.payload.model}: ${input} in / ${output} out`;
  }
  if (isEventOfType(event, "quote.offered")) {
    return `Quoted ${formatAmount(event.payload.amountMicros, event.payload.currency)} by ${event.payload.offeredBy}`;
  }
  if (isEventOfType(event, "quote.accepted")) {
    return `Quote ${event.payload.quoteId} accepted by ${event.payload.acceptedBy}`;
  }
  if (isEventOfType(event, "task.settled")) {
    return `Settled ${formatAmount(event.payload.amountMicros, event.payload.currency)} (${event.payload.visibility})`;
  }
  return event.type;
}
function projectActivityFeed(state, options) {
  const entries = state.recent.map((event) => ({
    eventId: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    correlationId: event.correlationId,
    actorId: event.issuer.id,
    actorKind: event.issuer.kind,
    subjectKind: event.subject.kind,
    subjectId: event.subject.id,
    taskId: event.taskId,
    goalId: event.goalId,
    roomId: event.roomId,
    summary: summarizeEvent(event)
  }));
  return {
    meta: meta(state, ACTIVITY_FEED_PROJECTION_VERSION, options),
    data: { entries, truncated: state.recentTruncated }
  };
}
function projectTaskGraph(state, options, filter = {}) {
  const tasks = Object.values(state.tasks).filter((task) => {
    if (filter.roomId !== void 0 && task.roomId !== filter.roomId) return false;
    if (filter.goalId !== void 0 && task.goalId !== filter.goalId) return false;
    return true;
  });
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const depthOf = (taskId, seen) => {
    if (seen.has(taskId)) return 0;
    seen.add(taskId);
    const parentId = byId.get(taskId)?.parentTaskId;
    return parentId && byId.has(parentId) ? depthOf(parentId, seen) + 1 : 0;
  };
  const nodes = tasks.map((task) => ({ task, depth: depthOf(task.id, /* @__PURE__ */ new Set()) })).sort((a, b) => a.depth - b.depth || a.task.createdAt.localeCompare(b.task.createdAt));
  const edges = [];
  for (const task of tasks) {
    if (task.parentTaskId && byId.has(task.parentTaskId)) {
      edges.push({ source: task.parentTaskId, target: task.id, kind: "subtask" });
    }
    for (const dependency of task.dependsOn) {
      if (byId.has(dependency)) edges.push({ source: task.id, target: dependency, kind: "dependency" });
    }
  }
  return {
    meta: meta(state, TASK_GRAPH_PROJECTION_VERSION, options),
    data: { roomId: filter.roomId, goalId: filter.goalId, nodes, edges }
  };
}
function projectRoom(state, options, roomId) {
  const room = state.rooms[roomId];
  if (!room) return void 0;
  const tasks = Object.values(state.tasks).filter((task) => task.roomId === roomId);
  const taskIds = new Set(tasks.map((task) => task.id));
  return {
    meta: meta(state, ROOM_PROJECTION_VERSION, options),
    data: {
      room,
      goal: room.goalId ? state.goals[room.goalId] : void 0,
      participants: room.participantAgentIds.map((id) => state.agents[id]).filter((a) => a !== void 0),
      tasks,
      approvals: Object.values(state.approvals).filter((a) => a.taskId !== void 0 && taskIds.has(a.taskId)),
      toolCalls: Object.values(state.toolCalls).filter((c) => c.taskId !== void 0 && taskIds.has(c.taskId))
    }
  };
}
function projectAll(state, options) {
  return {
    agents: projectAgentState(state, options),
    network: projectNetworkGraph(state, options),
    activity: projectActivityFeed(state, options),
    tasks: projectTaskGraph(state, options)
  };
}

// node_modules/iflow-adapter-sdk/dist/index.js
var EDGE_DIR = ".iflow/edge";
function edgePaths(workspaceRoot) {
  const base = `${trimTrailingSlash(workspaceRoot)}/${EDGE_DIR}`;
  return {
    origin: `${base}/origin.ndjson`,
    outbox: `${base}/outbox.ndjson`,
    commands: `${base}/commands.ndjson`,
    checkpoint: `${base}/checkpoint.json`,
    trustedDirectory: `${base}/trusted-directory.json`,
    tmpDir: `${base}/tmp`
  };
}
function trimTrailingSlash(path) {
  return path.replace(/[/\\]+$/, "").replace(/\\/g, "/");
}
var ORIGIN_STREAM_ID = "edge";
var EMPTY_CHECKPOINT = { lastSeq: 0, syncedSeq: 0, updatedAt: "1970-01-01T00:00:00.000Z" };
var OriginJournal = class _OriginJournal {
  constructor(ports, descriptor, paths, logger) {
    this.ports = ports;
    this.descriptor = descriptor;
    this.paths = paths;
    this.logger = logger;
  }
  ports;
  descriptor;
  paths;
  logger;
  events = [];
  checkpoint = { ...EMPTY_CHECKPOINT };
  subscribers = /* @__PURE__ */ new Set();
  writeChain = Promise.resolve();
  corruptLines = 0;
  signer;
  /** Facts this process wrote with no signature on them. */
  unsignedCount = 0;
  static async open(ports, descriptor, options = {}) {
    const paths = edgePaths(descriptor.workspaceRoot);
    const journal = new _OriginJournal(ports, descriptor, paths, ports.logger);
    journal.signer = options.signer;
    await journal.load(options.tolerateCorruptLines ?? true);
    return journal;
  }
  async load(tolerateCorruptLines) {
    const raw = await this.ports.storage.read(this.paths.origin);
    if (raw) {
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          this.corruptLines += 1;
          if (!tolerateCorruptLines) throw new Error(`origin journal has an unparsable line: ${trimmed.slice(0, 120)}`);
          continue;
        }
        const result = validateEvent(parsed);
        if (!result.valid) {
          this.corruptLines += 1;
          if (!tolerateCorruptLines) {
            throw new Error(`origin journal has an invalid event: ${result.issues.map((i) => i.path).join(",")}`);
          }
          continue;
        }
        this.events.push(parsed);
      }
    }
    const checkpointRaw = await this.ports.storage.read(this.paths.checkpoint);
    if (checkpointRaw) {
      try {
        this.checkpoint = { ...EMPTY_CHECKPOINT, ...JSON.parse(checkpointRaw) };
      } catch {
        this.logger.warn("iflow: checkpoint.json unreadable, rebuilding from the journal");
      }
    }
    const highest = this.events.reduce((max, event) => Math.max(max, event.origin.seq), 0);
    if (highest > this.checkpoint.lastSeq) {
      this.checkpoint.lastSeq = highest;
      this.checkpoint.lastEventId = this.events[this.events.length - 1]?.id;
    }
    if (this.checkpoint.syncedSeq > this.checkpoint.lastSeq) this.checkpoint.syncedSeq = this.checkpoint.lastSeq;
    if (this.corruptLines > 0) {
      this.logger.warn(`iflow: skipped ${this.corruptLines} unreadable origin journal line(s)`);
    }
  }
  get nodeId() {
    return this.descriptor.nodeId;
  }
  get lastSeq() {
    return this.checkpoint.lastSeq;
  }
  get syncedSeq() {
    return this.checkpoint.syncedSeq;
  }
  get skippedLineCount() {
    return this.corruptLines;
  }
  /** How many facts this process wrote without a signature. */
  get unsignedWriteCount() {
    return this.unsignedCount;
  }
  get signing() {
    return this.signer !== void 0;
  }
  /**
   * Attach a signer after opening.
   *
   * The identity binary may need fetching, so an edge often starts before it
   * can sign. Facts written before that are journaled unsigned rather than
   * dropped, and counted so the gap stays visible instead of silent.
   */
  useSigner(signer) {
    this.signer = signer;
  }
  /** Every event this node holds, in origin order. */
  all() {
    return this.events;
  }
  /** Events strictly after `seq`, for paging and replay. */
  since(seq, limit = 500) {
    const out = [];
    for (const event of this.events) {
      if (event.origin.seq <= seq) continue;
      out.push(event);
      if (out.length >= limit) break;
    }
    return out;
  }
  /**
   * Record a fact. The event is durable before this resolves, so a caller can
   * treat a resolved promise as "the network will eventually see this".
   *
   * Appends are serialized through one chain: two concurrent observers must
   * never both claim the same `origin.seq`.
   */
  async record(input) {
    const result = this.writeChain.then(() => this.appendNow(input));
    this.writeChain = result.then(
      () => void 0,
      () => void 0
    );
    return result;
  }
  async appendNow(input) {
    const seq = this.checkpoint.lastSeq + 1;
    const occurredAt = input.occurredAt ?? this.ports.clock.nowIso();
    const event = {
      id: this.ports.ids.newId("evt"),
      schemaVersion: EVENT_SCHEMA_VERSION,
      origin: { nodeId: this.descriptor.nodeId, streamId: ORIGIN_STREAM_ID, seq },
      occurredAt,
      correlationId: input.correlationId ?? this.ports.ids.newId("corr"),
      causationId: input.causationId,
      type: input.type,
      issuer: input.issuer ?? {
        id: this.descriptor.selfAgentId,
        did: this.descriptor.did,
        kind: "system"
      },
      subject: input.subject,
      goalId: input.goalId,
      taskId: input.taskId,
      roomId: input.roomId,
      trace: input.trace,
      payload: input.payload,
      evidence: input.evidence ?? { source: "dsh" }
    };
    const validation = validateEvent(event);
    if (!validation.valid) {
      throw new Error(
        `iflow: refusing to journal a malformed ${input.type} event: ` + validation.issues.map((i) => `${i.path} ${i.message}`).join("; ")
      );
    }
    const signed = stripUndefined(event);
    if (this.signer) {
      try {
        const raw = await this.signer.sign(signableBytes(signed));
        signed.evidence = { ...signed.evidence ?? { source: "dsh" }, signature: base64url(raw) };
      } catch (error) {
        this.unsignedCount += 1;
        this.logger.warn("iflow: could not sign an event; journaling it unsigned", error);
      }
    } else {
      this.unsignedCount += 1;
    }
    await this.ports.storage.append(this.paths.origin, `${JSON.stringify(signed)}
`);
    this.events.push(signed);
    this.checkpoint.lastSeq = seq;
    this.checkpoint.lastEventId = event.id;
    this.checkpoint.updatedAt = this.ports.clock.nowIso();
    await this.persistCheckpoint();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(signed);
      } catch (error) {
        this.logger.error("iflow: journal subscriber threw", error);
      }
    }
    return signed;
  }
  /** Mark everything up to `seq` as accepted by a Community. */
  async markSynced(seq) {
    if (seq <= this.checkpoint.syncedSeq) return;
    this.checkpoint.syncedSeq = Math.min(seq, this.checkpoint.lastSeq);
    this.checkpoint.updatedAt = this.ports.clock.nowIso();
    await this.persistCheckpoint();
  }
  async persistCheckpoint() {
    await this.ports.storage.write(this.paths.checkpoint, `${JSON.stringify(this.checkpoint, null, 2)}
`);
  }
  subscribe(handler) {
    this.subscribers.add(handler);
    return { dispose: () => this.subscribers.delete(handler) };
  }
};
function stripUndefined(value) {
  return JSON.parse(JSON.stringify(value));
}
var Outbox = class _Outbox {
  constructor(storage, clock, logger, paths) {
    this.storage = storage;
    this.clock = clock;
    this.logger = logger;
    this.paths = paths;
  }
  storage;
  clock;
  logger;
  paths;
  entries = /* @__PURE__ */ new Map();
  flushing = false;
  static async open(storage, clock, logger, paths) {
    const outbox = new _Outbox(storage, clock, logger, paths);
    await outbox.load();
    return outbox;
  }
  async load() {
    const raw = await this.storage.read(this.paths.outbox);
    if (!raw) return;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (typeof entry.eventId !== "string") continue;
        this.entries.set(entry.eventId, entry);
      } catch {
        this.logger.warn("iflow: skipped an unreadable outbox line");
      }
    }
  }
  /** Queue a fact for upload. Enqueuing the same event twice is a no-op. */
  async enqueue(event) {
    if (this.entries.has(event.id)) return;
    const entry = {
      eventId: event.id,
      seq: event.origin.seq,
      state: "queued",
      attempts: 0,
      queuedAt: this.clock.nowIso()
    };
    this.entries.set(event.id, entry);
    await this.storage.append(this.paths.outbox, `${JSON.stringify(entry)}
`);
  }
  pending() {
    return [...this.entries.values()].filter((entry) => entry.state === "queued").sort((a, b) => a.seq - b.seq);
  }
  delivered() {
    return [...this.entries.values()].filter((entry) => entry.state === "delivered");
  }
  isDelivered(eventId) {
    return this.entries.get(eventId)?.state === "delivered";
  }
  /**
   * Try to hand every queued event to the sink.
   *
   * `resolveEvent` reads the body out of the Journal rather than the outbox
   * holding a second copy: the Journal is the only place a fact lives.
   */
  async flush(sink, resolveEvent) {
    if (this.flushing) return { attempted: 0, delivered: 0, failed: 0, error: "flush already in progress" };
    this.flushing = true;
    try {
      const queued = this.pending();
      if (queued.length === 0) return { attempted: 0, delivered: 0, failed: 0 };
      const batch = [];
      for (const entry of queued) {
        const event = resolveEvent(entry.eventId);
        if (event) batch.push(event);
        else this.logger.warn(`iflow: outbox references an event not in the journal: ${entry.eventId}`);
      }
      if (batch.length === 0) return { attempted: 0, delivered: 0, failed: 0 };
      const now = this.clock.nowIso();
      for (const event of batch) {
        const entry = this.entries.get(event.id);
        if (entry) {
          entry.attempts += 1;
          entry.lastAttemptAt = now;
        }
      }
      try {
        const { acceptedEventIds } = await sink.publish(batch);
        await this.markDelivered(acceptedEventIds);
        return {
          attempted: batch.length,
          delivered: acceptedEventIds.length,
          failed: batch.length - acceptedEventIds.length
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const event of batch) {
          const entry = this.entries.get(event.id);
          if (entry) entry.lastError = message;
        }
        await this.compact();
        return { attempted: batch.length, delivered: 0, failed: batch.length, error: message };
      }
    } finally {
      this.flushing = false;
    }
  }
  /** Idempotent: acknowledging the same event twice changes nothing. */
  async markDelivered(eventIds) {
    let changed = false;
    const now = this.clock.nowIso();
    for (const eventId of eventIds) {
      const entry = this.entries.get(eventId);
      if (!entry || entry.state === "delivered") continue;
      entry.state = "delivered";
      entry.deliveredAt = now;
      entry.lastError = void 0;
      changed = true;
    }
    if (changed) await this.compact();
  }
  /** Rewrite the file as one line per event, dropping superseded states. */
  async compact() {
    const lines = [...this.entries.values()].sort((a, b) => a.seq - b.seq).map((entry) => JSON.stringify(entry)).join("\n");
    await this.storage.write(this.paths.outbox, lines.length > 0 ? `${lines}
` : "");
  }
};
var CommandLedger = class _CommandLedger {
  constructor(storage, clock, logger, paths) {
    this.storage = storage;
    this.clock = clock;
    this.logger = logger;
    this.paths = paths;
  }
  storage;
  clock;
  logger;
  paths;
  byCommandId = /* @__PURE__ */ new Map();
  byIdempotencyKey = /* @__PURE__ */ new Map();
  static async open(storage, clock, logger, paths) {
    const ledger = new _CommandLedger(storage, clock, logger, paths);
    await ledger.load();
    return ledger;
  }
  async load() {
    const raw = await this.storage.read(this.paths.commands);
    if (!raw) return;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const record = JSON.parse(trimmed);
        if (typeof record.commandId !== "string") continue;
        this.remember(record);
      } catch {
        this.logger.warn("iflow: skipped an unreadable command ledger line");
      }
    }
    for (const record of this.byCommandId.values()) {
      if (record.status !== "in_flight") continue;
      this.logger.warn(
        `iflow: command ${record.commandId} was interrupted mid-execution; it will not be retried automatically`
      );
    }
  }
  remember(record) {
    this.byCommandId.set(record.commandId, record);
    this.byIdempotencyKey.set(record.idempotencyKey, record);
  }
  async persist(record) {
    await this.storage.append(this.paths.commands, `${JSON.stringify(record)}
`);
  }
  /** A previously seen command, by either dedup key. */
  lookup(command) {
    return this.byCommandId.get(command.commandId) ?? this.byIdempotencyKey.get(command.idempotencyKey);
  }
  size() {
    return this.byCommandId.size;
  }
  /**
   * Run a command exactly once.
   *
   * The executor is the host's local enforcement point: it verifies identity,
   * grant, budget and its own runtime policy, and it may refuse. Nothing here
   * can override that decision — this layer only guarantees the executor is
   * asked at most once per command.
   */
  async dispatch(command, executor) {
    const validation = validateCommand(command);
    if (!validation.valid) {
      const record2 = {
        commandId: typeof command.commandId === "string" ? command.commandId : "malformed",
        idempotencyKey: typeof command.idempotencyKey === "string" ? command.idempotencyKey : "malformed",
        requestedAction: String(command.requestedAction ?? ""),
        status: "rejected",
        receivedAt: this.clock.nowIso(),
        settledAt: this.clock.nowIso(),
        reason: `malformed command: ${validation.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`
      };
      return { outcome: { accepted: false, reason: record2.reason }, duplicate: false, record: record2 };
    }
    const existing = this.lookup(command);
    if (existing) {
      return {
        duplicate: true,
        record: existing,
        outcome: existing.status === "accepted" ? { accepted: true, attemptId: existing.attemptId } : {
          accepted: false,
          reason: existing.status === "in_flight" ? "a previous delivery of this command was interrupted and will not be retried" : existing.reason ?? "rejected"
        }
      };
    }
    if (Date.parse(command.expiresAt) <= this.clock.now()) {
      const record2 = {
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        requestedAction: command.requestedAction,
        status: "rejected",
        receivedAt: this.clock.nowIso(),
        settledAt: this.clock.nowIso(),
        reason: "command expired"
      };
      this.remember(record2);
      await this.persist(record2);
      return { outcome: { accepted: false, reason: record2.reason }, duplicate: false, record: record2 };
    }
    const record = {
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      requestedAction: command.requestedAction,
      status: "in_flight",
      receivedAt: this.clock.nowIso()
    };
    this.remember(record);
    await this.persist(record);
    let outcome;
    try {
      outcome = await executor.execute(command);
    } catch (error) {
      outcome = { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
    record.status = outcome.accepted ? "accepted" : "rejected";
    record.settledAt = this.clock.nowIso();
    record.attemptId = outcome.attemptId;
    record.reason = outcome.reason;
    this.remember(record);
    await this.persist(record);
    return { outcome, duplicate: false, record };
  }
};
var LocalProjection = class {
  constructor(clock) {
    this.clock = clock;
  }
  clock;
  state = emptyNetworkState();
  listeners = /* @__PURE__ */ new Set();
  /** Discard everything and re-derive from the journal. */
  rebuild(events) {
    this.state = reduceEvents(events);
  }
  /** Fold one newly journaled fact. */
  ingest(event) {
    this.state = applyEvent(this.state, event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
      }
    }
  }
  onChange(handler) {
    this.listeners.add(handler);
    return { dispose: () => this.listeners.delete(handler) };
  }
  /** The raw fold. Exposed for tests and for a rebuild-equality check. */
  snapshot() {
    return this.state;
  }
  options() {
    return { builtAt: this.clock.nowIso() };
  }
  agents() {
    return projectAgentState(this.state, this.options());
  }
  network() {
    return projectNetworkGraph(this.state, this.options());
  }
  activity() {
    return projectActivityFeed(this.state, this.options());
  }
  tasks(filter = {}) {
    return projectTaskGraph(this.state, this.options(), filter);
  }
  room(roomId) {
    return projectRoom(this.state, this.options(), roomId);
  }
  all() {
    return projectAll(this.state, this.options());
  }
};
var RuntimeObserver = class {
  constructor(journal, descriptor, ids, logger) {
    this.journal = journal;
    this.descriptor = descriptor;
    this.ids = ids;
    this.logger = logger;
  }
  journal;
  descriptor;
  ids;
  logger;
  /** taskId -> correlationId, so a whole flow shares one id without the host tracking it. */
  correlations = /* @__PURE__ */ new Map();
  /**
   * The correlation id for a task, minted on first sight.
   *
   * Exposed so a host can stamp the same id onto its own traces: one Task
   * execution maps to one trace, and a shared correlation is what makes the
   * journal and the trace store line up later.
   */
  correlationFor(taskId) {
    const existing = this.correlations.get(taskId);
    if (existing) return existing;
    const created = this.ids.newId("corr");
    this.correlations.set(taskId, created);
    return created;
  }
  /** Forget a finished flow so a long-lived edge does not grow without bound. */
  releaseCorrelation(taskId) {
    this.correlations.delete(taskId);
  }
  agentIssuer(agentId) {
    return { id: agentId, did: agentId === this.descriptor.selfAgentId ? this.descriptor.did : void 0, kind: "agent" };
  }
  /** Record, but never let an observation failure break the host's work. */
  async safely(what, run) {
    try {
      return await run();
    } catch (error) {
      this.logger.error(`iflow: failed to journal ${what}`, error);
      return void 0;
    }
  }
  agentRegistered(input) {
    return this.safely(
      "agent.registered",
      () => this.journal.record({
        type: "agent.registered",
        subject: { kind: "agent", id: input.agentId },
        issuer: input.context?.issuer ?? this.agentIssuer(input.agentId),
        payload: {
          label: input.label,
          did: input.did,
          nodeId: this.descriptor.nodeId,
          runtimeKind: this.descriptor.runtimeKind,
          capabilities: input.capabilities ?? [],
          trustEvidence: input.trustEvidence
        },
        ...spread(input.context)
      })
    );
  }
  agentPresenceChanged(input) {
    return this.safely(
      "agent.presence_changed",
      () => this.journal.record({
        type: "agent.presence_changed",
        subject: { kind: "agent", id: input.agentId },
        issuer: input.context?.issuer ?? this.agentIssuer(input.agentId),
        payload: {
          presence: input.presence,
          execution: input.execution,
          coordination: input.coordination
        },
        ...spread(input.context)
      })
    );
  }
  goalCreated(input) {
    return this.safely(
      "goal.created",
      () => this.journal.record({
        type: "goal.created",
        subject: { kind: "goal", id: input.goalId },
        issuer: input.issuer,
        goalId: input.goalId,
        payload: {
          title: input.title,
          constraints: input.constraints,
          budget: input.budget,
          roomId: input.roomId
        },
        ...spread(input.context)
      })
    );
  }
  taskCreated(input) {
    return this.taskEvent("task.created", input.taskId, input.context, {
      title: input.title,
      parentTaskId: input.parentTaskId,
      dependsOn: input.dependsOn,
      ownerAgentId: input.ownerAgentId
    }, { goalId: input.goalId, roomId: input.roomId });
  }
  taskDelegated(input) {
    return this.taskEvent("task.delegated", input.taskId, input.context, {
      toAgentId: input.toAgentId,
      fromAgentId: input.fromAgentId,
      reason: input.reason
    });
  }
  taskStarted(input) {
    return this.taskEvent("task.started", input.taskId, input.context, {
      agentId: input.agentId,
      attemptId: input.attemptId ?? this.ids.newId("attempt")
    });
  }
  taskWaiting(input) {
    return this.taskEvent("task.waiting", input.taskId, input.context, { reason: input.reason });
  }
  taskBlocked(input) {
    return this.taskEvent("task.blocked", input.taskId, input.context, {
      reason: input.reason,
      blockedOnTaskId: input.blockedOnTaskId
    });
  }
  taskAwaitingApproval(input) {
    return this.taskEvent("task.awaiting_approval", input.taskId, input.context, {
      approvalId: input.approvalId,
      reason: input.reason
    });
  }
  taskCompleted(input) {
    return this.taskEvent("task.completed", input.taskId, input.context, {
      summary: input.summary,
      outputs: input.outputs
    });
  }
  taskFailed(input) {
    return this.taskEvent("task.failed", input.taskId, input.context, { reason: input.reason });
  }
  roomCreated(input) {
    return this.safely(
      "room.created",
      () => this.journal.record({
        type: "room.created",
        subject: { kind: "room", id: input.roomId },
        roomId: input.roomId,
        goalId: input.goalId,
        payload: { title: input.title, goalId: input.goalId, rootTaskId: input.rootTaskId },
        ...spread(input.context)
      })
    );
  }
  roomParticipantJoined(input) {
    return this.safely(
      "room.participant_joined",
      () => this.journal.record({
        type: "room.participant_joined",
        subject: { kind: "room", id: input.roomId },
        roomId: input.roomId,
        payload: { agentId: input.agentId },
        ...spread(input.context)
      })
    );
  }
  toolCallStarted(input) {
    return this.safely(
      "tool.call_started",
      () => this.journal.record({
        type: "tool.call_started",
        subject: input.taskId ? { kind: "task", id: input.taskId } : { kind: "agent", id: input.agentId },
        issuer: input.context?.issuer ?? this.agentIssuer(input.agentId),
        taskId: input.taskId,
        correlationId: input.context?.correlationId ?? (input.taskId ? this.correlationFor(input.taskId) : void 0),
        payload: {
          callId: input.callId,
          toolName: input.toolName,
          agentId: input.agentId,
          argumentsDigest: input.argumentsDigest
        },
        ...spreadWithoutCorrelation(input.context)
      })
    );
  }
  toolCallCompleted(input) {
    return this.safely(
      "tool.call_completed",
      () => this.journal.record({
        type: "tool.call_completed",
        subject: input.taskId ? { kind: "task", id: input.taskId } : { kind: "agent", id: input.agentId },
        issuer: input.context?.issuer ?? this.agentIssuer(input.agentId),
        taskId: input.taskId,
        correlationId: input.context?.correlationId ?? (input.taskId ? this.correlationFor(input.taskId) : void 0),
        payload: {
          callId: input.callId,
          toolName: input.toolName,
          outcome: input.outcome,
          errorMessage: input.errorMessage
        },
        ...spreadWithoutCorrelation(input.context)
      })
    );
  }
  approvalRequested(input) {
    return this.safely(
      "approval.requested",
      () => this.journal.record({
        type: "approval.requested",
        subject: input.taskId ? { kind: "task", id: input.taskId } : { kind: "agent", id: input.agentId },
        issuer: input.context?.issuer ?? this.agentIssuer(input.agentId),
        taskId: input.taskId,
        correlationId: input.context?.correlationId ?? (input.taskId ? this.correlationFor(input.taskId) : void 0),
        payload: {
          approvalId: input.approvalId,
          toolName: input.toolName,
          reason: input.reason,
          agentId: input.agentId
        },
        ...spreadWithoutCorrelation(input.context)
      })
    );
  }
  approvalResolved(input) {
    return this.safely(
      "approval.resolved",
      () => this.journal.record({
        type: "approval.resolved",
        subject: input.taskId ? { kind: "task", id: input.taskId } : { kind: "agent", id: input.agentId },
        taskId: input.taskId,
        correlationId: input.context?.correlationId ?? (input.taskId ? this.correlationFor(input.taskId) : void 0),
        payload: { approvalId: input.approvalId, decision: input.decision },
        ...spreadWithoutCorrelation(input.context)
      })
    );
  }
  a2aRequestReceived(input) {
    return this.safely(
      "a2a.request_received",
      () => this.journal.record({
        type: "a2a.request_received",
        subject: { kind: "task", id: input.remoteTaskId },
        taskId: input.remoteTaskId,
        correlationId: input.context?.correlationId ?? this.correlationFor(input.remoteTaskId),
        payload: {
          remoteTaskId: input.remoteTaskId,
          fromDid: input.fromDid,
          fromLabel: input.fromLabel,
          grantRef: input.grantRef
        },
        evidence: { source: "a2a" },
        ...spreadWithoutCorrelation(input.context)
      })
    );
  }
  attemptStarted(input) {
    return this.taskEvent("execution.attempt_started", input.taskId, input.context, {
      attemptId: input.attemptId,
      agentId: input.agentId,
      traceId: input.traceId
    });
  }
  attemptFinished(input) {
    return this.taskEvent("execution.attempt_finished", input.taskId, input.context, {
      attemptId: input.attemptId,
      outcome: input.outcome
    });
  }
  /**
   * Offer a price for a Task.
   *
   * The returned event is the one a counterparty must countersign, so callers
   * keep it: `countersignPayloadFor(offer)` turns it into the fields the
   * acceptance needs.
   */
  quoteOffered(input) {
    return this.taskEvent("quote.offered", input.taskId, input.context, {
      quoteId: input.quoteId,
      offeredBy: input.offeredBy,
      offeredTo: input.offeredTo,
      amountMicros: Math.round(input.amountMicros),
      currency: input.currency ?? "USD",
      capability: input.capability,
      expiresAt: input.expiresAt,
      terms: input.terms
    });
  }
  /**
   * Accept an offer, countersigning it.
   *
   * `offerEventId` and `offerSignature` must come from the offer event itself
   * — see `countersignPayloadFor` in iflow-protocol. An acceptance that does
   * not quote the offer's own signature is a one-sided claim.
   */
  quoteAccepted(input) {
    return this.taskEvent("quote.accepted", input.taskId, input.context, {
      quoteId: input.quoteId,
      acceptedBy: input.acceptedBy,
      offerEventId: input.offerEventId,
      offerSignature: input.offerSignature
    });
  }
  /**
   * Record what actually changed hands.
   *
   * `visibility` defaults to `private`: publishing a counterparty's commercial
   * terms is a decision the parties make, not a default the protocol imposes.
   */
  taskSettled(input) {
    return this.taskEvent("task.settled", input.taskId, input.context, {
      quoteId: input.quoteId,
      payerAgentId: input.payerAgentId,
      payeeAgentId: input.payeeAgentId,
      amountMicros: Math.round(input.amountMicros),
      currency: input.currency ?? "USD",
      visibility: input.visibility ?? "private",
      basis: input.basis ?? (input.quoteId ? "quote" : "negotiated"),
      settlementRef: input.settlementRef
    });
  }
  usageRecorded(input) {
    return this.taskEvent("usage.recorded", input.taskId, input.context, {
      model: input.model,
      tokens: {
        input: Math.round(input.tokens.input),
        output: Math.round(input.tokens.output),
        cacheRead: Math.round(input.tokens.cacheRead),
        cacheWrite: Math.round(input.tokens.cacheWrite)
      },
      costMicros: Math.round(input.costMicros),
      currency: input.currency ?? "USD",
      priceSource: input.priceSource ?? "unknown"
    });
  }
  taskEvent(type, taskId, context, payload, extra = {}) {
    return this.safely(
      type,
      () => this.journal.record({
        type,
        subject: { kind: "task", id: taskId },
        taskId,
        goalId: context?.goalId ?? extra.goalId,
        roomId: context?.roomId ?? extra.roomId,
        correlationId: context?.correlationId ?? this.correlationFor(taskId),
        payload,
        ...spreadWithoutCorrelation(context)
      })
    );
  }
};
function spread(context) {
  if (!context) return {};
  return {
    correlationId: context.correlationId,
    causationId: context.causationId,
    goalId: context.goalId,
    roomId: context.roomId,
    occurredAt: context.occurredAt
  };
}
function spreadWithoutCorrelation(context) {
  if (!context) return {};
  return {
    causationId: context.causationId,
    goalId: context.goalId,
    roomId: context.roomId,
    occurredAt: context.occurredAt
  };
}
var EDGE_ROUTE_PREFIX = "/iflow";
var DEFAULT_PAGE_LIMIT = 500;
function mountEdgeServer(http, journal, projection, logger, options = {}) {
  const authorize = options.authorize ?? (() => true);
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const disposables = [];
  const corsHeaders = (request) => {
    const origin = request.headers["origin"] ?? request.headers["Origin"];
    const allowed = options.allowedOrigins;
    if (!origin) return {};
    if (allowed && !allowed.includes(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      Vary: "Origin"
    };
  };
  const json = (request, status, body) => ({
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request) },
    body: JSON.stringify(body)
  });
  const guarded = (handler) => async (request) => {
    if (!authorize(request)) return json(request, 401, { error: "unauthorized" });
    try {
      return json(request, 200, handler(request));
    } catch (error) {
      logger.error("iflow: edge read failed", error);
      return json(request, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  const get = (path, handler) => {
    disposables.push(http.route({ method: "GET", path: `${EDGE_ROUTE_PREFIX}${path}`, handler: guarded(handler) }));
  };
  get("/projection/agents", () => projection.agents());
  get("/projection/network", () => projection.network());
  get("/projection/activity", () => projection.activity());
  get("/projection/tasks", (request) => {
    const roomId = request.query["roomId"];
    const goalId = request.query["goalId"];
    return projection.tasks({ roomId: roomId || void 0, goalId: goalId || void 0 });
  });
  get("/projection/room", (request) => {
    const roomId = request.query["roomId"] ?? "";
    const view = projection.room(roomId);
    if (!view) throw new Error(`no such room: ${roomId}`);
    return view;
  });
  get("/journal", (request) => {
    const fromSeq = Number.parseInt(request.query["fromSeq"] ?? "0", 10);
    const requested = Number.parseInt(request.query["limit"] ?? String(pageLimit), 10);
    const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : pageLimit, pageLimit);
    const events = journal.since(Number.isFinite(fromSeq) ? fromSeq : 0, limit);
    const lastSeq = events.length > 0 ? events[events.length - 1].origin.seq : fromSeq;
    return {
      nodeId: journal.nodeId,
      fromSeq,
      lastSeq,
      // A client pages until this is false; it never has to guess.
      hasMore: lastSeq < journal.lastSeq,
      events
    };
  });
  get("/edge/status", () => ({
    nodeId: journal.nodeId,
    lastSeq: journal.lastSeq,
    syncedSeq: journal.syncedSeq,
    skippedJournalLines: journal.skippedLineCount,
    projection: projection.agents().meta
  }));
  if (http.stream) {
    disposables.push(
      http.stream({
        path: `${EDGE_ROUTE_PREFIX}/stream`,
        handler: (request, stream) => {
          if (!authorize(request)) {
            stream.send('event: error\ndata: {"error":"unauthorized"}\n\n');
            stream.close();
            return;
          }
          const send = (event) => {
            stream.send(`event: iflow-event
data: ${JSON.stringify(event)}

`);
          };
          const subscription = journal.subscribe(send);
          stream.onClose(() => subscription.dispose());
          stream.send(`event: hello
data: ${JSON.stringify({ nodeId: journal.nodeId, lastSeq: journal.lastSeq })}

`);
        }
      })
    );
  }
  return {
    dispose() {
      for (const disposable of disposables.reverse()) disposable.dispose();
    }
  };
}
async function createEdge(options) {
  const { ports, descriptor } = options;
  const paths = edgePaths(descriptor.workspaceRoot);
  const journal = await OriginJournal.open(ports, descriptor, { signer: options.signer });
  const outbox = await Outbox.open(ports.storage, ports.clock, ports.logger, paths);
  const commands = await CommandLedger.open(ports.storage, ports.clock, ports.logger, paths);
  const views = new LocalProjection(ports.clock);
  views.rebuild(journal.all());
  const observer = new RuntimeObserver(journal, descriptor, ports.ids, ports.logger);
  const disposables = [];
  const queueForSync = options.queueForSync ?? true;
  disposables.push(
    journal.subscribe((event) => {
      views.ingest(event);
      if (queueForSync) {
        void outbox.enqueue(event).catch((error) => {
          ports.logger.warn("iflow: could not queue an event for sync", error);
        });
      }
    })
  );
  if (ports.http && (options.serve ?? true)) {
    disposables.push(mountEdgeServer(ports.http, journal, views, ports.logger, options.server));
  }
  if (options.registerSelf ?? true) {
    const alreadyRegistered = journal.all().some((event) => event.type === "agent.registered" && event.subject.id === descriptor.selfAgentId);
    if (alreadyRegistered) {
      await observer.agentPresenceChanged({ agentId: descriptor.selfAgentId, presence: "online", execution: "idle" });
    } else {
      await observer.agentRegistered({
        agentId: descriptor.selfAgentId,
        label: descriptor.selfAgentLabel,
        capabilities: descriptor.capabilities,
        did: descriptor.did
      });
    }
  }
  return {
    journal,
    outbox,
    commands,
    views,
    observer,
    paths,
    descriptor,
    async dispatchCommand(command, executor) {
      const result = await commands.dispatch(command, executor);
      if (result.duplicate) {
        ports.logger.warn(`iflow: ignored a duplicate delivery of command ${command.commandId}`);
      }
      return result.outcome;
    },
    rebuildProjection() {
      views.rebuild(journal.all());
    },
    async verifyJournal(limit) {
      const events = limit === void 0 ? journal.all() : journal.all().slice(-limit);
      const result = { checked: 0, verified: 0, unsigned: 0, forged: [] };
      const verifier = options.verifier;
      for (const event of events) {
        result.checked += 1;
        const signature = event.evidence?.signature;
        if (!signature) {
          result.unsigned += 1;
          continue;
        }
        if (!verifier) continue;
        const signerDid = event.issuer.did ?? descriptor.did;
        const ok = signerDid ? await verifier.verify(signableBytes(event), base64urlDecode(signature), signerDid) : false;
        if (ok) result.verified += 1;
        else result.forged.push({ eventId: event.id, seq: event.origin.seq });
      }
      return result;
    },
    dispose() {
      for (const disposable of disposables.reverse()) disposable.dispose();
    }
  };
}

// src/identity/iflow-id.ts
function createIflowIdSigner({ run, writeScratch, logger }) {
  let cachedDid;
  return {
    async did() {
      if (cachedDid) return cachedDid;
      const out = await run(["show", "--json"]);
      cachedDid = JSON.parse(out).did;
      return cachedDid;
    },
    async sign(bytes) {
      const path = await writeScratch("signable.bin", bytes);
      const out = await run(["sign-blob", path]);
      const parsed = JSON.parse(out);
      if (!cachedDid) cachedDid = parsed.signerDid;
      return base64urlDecode2(parsed.signature);
    }
  };
}
function createIflowIdVerifier({ run, writeScratch, logger }) {
  return {
    async verify(bytes, signature, signerDid) {
      const path = await writeScratch("verifiable.bin", bytes);
      try {
        await run(["verify-blob", path, base64urlEncode(signature), signerDid]);
        return true;
      } catch (error) {
        const message = String(error?.message ?? error);
        if (!/verification failed|signature error/i.test(message)) {
          logger?.warn?.(`iFlow: signature check could not run: ${message}`);
        }
        return false;
      }
    }
  };
}
function base64urlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return Buffer.from(binary, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode2(text) {
  return new Uint8Array(Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

// src/runtime/dsh-command-executor.ts
var SUPPORTED_ACTIONS = ["task.cancel", "approval.resolve"];
function parseAction(requestedAction) {
  const raw = String(requestedAction ?? "");
  const separator = raw.indexOf(":");
  return separator === -1 ? { verb: raw, argument: void 0 } : { verb: raw.slice(0, separator), argument: raw.slice(separator + 1) };
}
var APPROVAL_DECISIONS = {
  allow: "allowed-once",
  allowed: "allowed-once",
  "allowed-once": "allowed-once",
  reject: "rejected",
  rejected: "rejected",
  deny: "rejected"
};
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function createAgentRegistry(ctx) {
  const agents = /* @__PURE__ */ new Map();
  const disposers = [
    ctx.on("agent/created", ({ agent }) => agents.set(`agent-${agent.id}`, agent), { global: true }),
    ctx.on("agent/disposed", ({ agent }) => agents.delete(`agent-${agent.id}`), { global: true })
  ];
  return {
    get: (agentId) => agents.get(agentId),
    /** Resolve from either an agent id or the task id derived from the same session. */
    resolve(target) {
      if (target.agentId && agents.get(target.agentId)) return agents.get(target.agentId);
      if (target.taskId && target.taskId.startsWith("task-")) {
        return agents.get(`agent-${target.taskId.slice("task-".length)}`);
      }
      return void 0;
    },
    size: () => agents.size,
    dispose() {
      for (const disposer of disposers) {
        try {
          disposer();
        } catch {
        }
      }
      agents.clear();
    }
  };
}
function createApprovalBridge(ctx, options = {}) {
  const parked = /* @__PURE__ */ new Map();
  let disposer;
  if (options.enabled === true) {
    disposer = ctx.on(
      "approval/request",
      async (request, next) => {
        const agentId = request?.agent?.id ? `agent-${request.agent.id}` : void 0;
        if (!agentId) return next();
        const pending = deferred();
        const waiting = parked.get(agentId) ?? [];
        waiting.push(pending);
        parked.set(agentId, waiting);
        try {
          return await Promise.race([pending.promise, next()]);
        } finally {
          const remaining = (parked.get(agentId) ?? []).filter((entry) => entry !== pending);
          if (remaining.length > 0) parked.set(agentId, remaining);
          else parked.delete(agentId);
        }
      },
      { global: true }
    );
  }
  return {
    enabled: options.enabled === true,
    /** Answer the oldest parked approval for an agent. False when none is waiting. */
    answer(agentId, outcome) {
      const waiting = parked.get(agentId);
      if (!waiting || waiting.length === 0) return false;
      waiting.shift().resolve(outcome);
      return true;
    },
    pendingCount: () => [...parked.values()].reduce((total, list) => total + list.length, 0),
    dispose() {
      if (disposer) {
        try {
          disposer();
        } catch {
        }
      }
      for (const waiting of parked.values()) for (const entry of waiting) entry.resolve(void 0);
      parked.clear();
    }
  };
}
function createDshCommandExecutor(options) {
  const { registry, approvals, observer, nodeId } = options;
  return {
    async execute(command) {
      if (options.enabled !== true) {
        return {
          accepted: false,
          reason: "this node does not accept commands (set config.acceptCommands: true to enable)"
        };
      }
      if (command.target?.nodeId && command.target.nodeId !== nodeId) {
        return { accepted: false, reason: `command targets node ${command.target.nodeId}, not ${nodeId}` };
      }
      const { verb, argument } = parseAction(command.requestedAction);
      if (!SUPPORTED_ACTIONS.includes(verb)) {
        return {
          accepted: false,
          reason: `unsupported action ${command.requestedAction}; this node accepts ${SUPPORTED_ACTIONS.join(", ")}`
        };
      }
      if (verb === "task.cancel") {
        const agent = registry.resolve(command.target ?? {});
        if (!agent) return { accepted: false, reason: "no live agent matches this command target" };
        try {
          agent.cancel({ kind: "parent" });
        } catch (error) {
          return { accepted: false, reason: `DSH refused the cancellation: ${String(error?.message ?? error)}` };
        }
        const attemptId = `cmd-${command.commandId}`;
        if (command.target?.taskId) {
          await observer.taskFailed({
            taskId: command.target.taskId,
            reason: `cancelled by ${command.issuer?.id ?? "a hub"}`
          });
        }
        return { accepted: true, attemptId };
      }
      if (!approvals.enabled) {
        return { accepted: false, reason: "this node does not route approvals through iFlow" };
      }
      const agentId = command.target?.agentId ?? (command.target?.taskId?.startsWith("task-") ? `agent-${command.target.taskId.slice("task-".length)}` : void 0);
      if (!agentId) return { accepted: false, reason: "approval.resolve needs a target agentId or taskId" };
      const requested = String(argument ?? "allow").toLowerCase();
      const outcome = APPROVAL_DECISIONS[requested];
      if (!outcome) {
        return { accepted: false, reason: `unknown approval decision ${requested}` };
      }
      const answered = approvals.answer(agentId, outcome);
      if (!answered) {
        return { accepted: false, reason: "no approval is waiting for that agent" };
      }
      return { accepted: true, attemptId: `cmd-${command.commandId}` };
    }
  };
}

// src/runtime/dsh-instrumentation.ts
var agentIdOf = (sessionId) => `agent-${sessionId}`;
var roomIdOf = (sessionId) => `room-${sessionId}`;
var goalIdOf = (sessionId) => `goal-${sessionId}`;
var turnTaskIdOf = (sessionId, turn) => `task-${sessionId}-t${turn}`;
function labelOf(agent) {
  const meta2 = agent?.session?.header?.meta ?? {};
  return meta2.agentPreset ?? agent?.options?.model ?? String(agent?.id ?? "agent");
}
function roomTitleOf(sessionId, agent) {
  const meta2 = agent?.session?.header?.meta ?? {};
  if (meta2.title) return meta2.title;
  const id = String(sessionId);
  const short = id.startsWith("session-") ? id.slice("session-".length, "session-".length + 8) : id.slice(0, 8);
  return `Session ${short}`;
}
function toolNameOf(exec) {
  return typeof exec?.name === "string" ? exec.name : "unknown";
}
var ASK_USER_TOOL = "ask_user_question";
function messageText(message, limit = 120) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = blocks.map((block) => typeof block?.text === "string" ? block.text : "").join(" ").replace(/\s+/g, " ").trim();
  if (text.length === 0) return void 0;
  return text.length > limit ? `${text.slice(0, limit - 1)}\u2026` : text;
}
function installDshInstrumentation(ctx, edge, options = {}) {
  const observer = edge.observer;
  const disposers = [];
  const on = (name, listener) => {
    disposers.push(ctx.on(name, listener, { global: true }));
  };
  let queue = Promise.resolve();
  const enqueue = (work) => {
    queue = queue.then(work).catch((error) => {
      console.error("iFlow: an observation failed and was dropped", error);
    });
    return queue;
  };
  const sessions = /* @__PURE__ */ new Map();
  const openCalls = /* @__PURE__ */ new Map();
  const openApprovals = /* @__PURE__ */ new Map();
  function record(sessionId) {
    let entry = sessions.get(sessionId);
    if (!entry) {
      entry = {
        agentId: agentIdOf(sessionId),
        // One correlation for this session's lifecycle facts. Without it every
        // registration and presence change became its own single-fact "flow"
        // in a replay, burying the flows that actually did work.
        lifecycleCorrelation: observer.correlationFor(`lifecycle-${sessionId}`),
        rootSessionId: sessionId,
        parentSessionId: void 0,
        roomId: roomIdOf(sessionId),
        registered: false,
        roomAnnounced: false,
        goalAnnounced: false,
        openTurn: void 0
      };
      sessions.set(sessionId, entry);
    }
    return entry;
  }
  function rootOf(sessionId, seen = /* @__PURE__ */ new Set()) {
    if (seen.has(sessionId)) return sessionId;
    seen.add(sessionId);
    const parent = sessions.get(sessionId)?.parentSessionId;
    return parent ? rootOf(parent, seen) : sessionId;
  }
  function openTaskId(sessionId) {
    return sessions.get(sessionId)?.openTurn?.journaled ? sessions.get(sessionId).openTurn.taskId : void 0;
  }
  on("agent/created", ({ agent }) => {
    const sessionId = agent.id;
    const meta2 = agent?.session?.header?.meta ?? {};
    const entry = record(sessionId);
    entry.parentSessionId = typeof meta2.parentSession === "string" ? meta2.parentSession : void 0;
    entry.rootSessionId = rootOf(sessionId);
    entry.roomId = roomIdOf(entry.rootSessionId);
    enqueue(async () => {
      if (!entry.registered) {
        entry.registered = true;
        await observer.agentRegistered({
          agentId: entry.agentId,
          label: labelOf(agent),
          capabilities: options.capabilities ?? [],
          context: { correlationId: entry.lifecycleCorrelation, roomId: entry.roomId }
        });
      }
      const root = record(entry.rootSessionId);
      if (!root.roomAnnounced) {
        root.roomAnnounced = true;
        await observer.roomCreated({
          roomId: entry.roomId,
          title: roomTitleOf(entry.rootSessionId, entry.rootSessionId === sessionId ? agent : void 0),
          context: { correlationId: entry.lifecycleCorrelation }
        });
      }
      await observer.roomParticipantJoined({
        roomId: entry.roomId,
        agentId: entry.agentId,
        context: { correlationId: entry.lifecycleCorrelation }
      });
    });
  });
  on("agent/disposed", ({ agent }) => {
    const entry = sessions.get(agent.id);
    enqueue(async () => {
      await observer.agentPresenceChanged({
        agentId: agentIdOf(agent.id),
        presence: "offline",
        execution: "idle",
        context: { correlationId: entry?.lifecycleCorrelation }
      });
      if (entry?.openTurn?.taskId) observer.releaseCorrelation(entry.openTurn.taskId);
      sessions.delete(agent.id);
    });
  });
  on("agent/status", ({ agent, status }) => {
    const entry = record(agent.id);
    enqueue(
      () => observer.agentPresenceChanged({
        agentId: entry.agentId,
        execution: status === "running" ? "running" : "idle",
        context: { correlationId: openTaskId(agent.id) ? void 0 : entry.lifecycleCorrelation }
      })
    );
  });
  on("agent/error", ({ agent, error }) => {
    const taskId = openTaskId(agent.id);
    if (!taskId) return;
    enqueue(
      () => observer.taskFailed({
        taskId,
        reason: error instanceof Error ? error.message : String(error)
      })
    );
  });
  on("tools/pre-execute", async (exec, next) => {
    const decision = await next();
    const agent = exec.agent;
    if (agent) {
      const entry = record(agent.id);
      const taskId = openTaskId(agent.id);
      const toolName = toolNameOf(exec);
      openCalls.set(exec.callId, { taskId, agentId: entry.agentId, toolName });
      enqueue(async () => {
        await observer.toolCallStarted({
          callId: exec.callId,
          toolName,
          agentId: entry.agentId,
          taskId
        });
        if (toolName === ASK_USER_TOOL && taskId) {
          await observer.taskWaiting({ taskId, reason: "the agent asked the user a question" });
          await observer.agentPresenceChanged({ agentId: entry.agentId, coordination: "waiting" });
        }
      });
    }
    return decision;
  });
  on("tools/result", (exec, result) => {
    const open = openCalls.get(exec.callId);
    openCalls.delete(exec.callId);
    if (!open) return;
    const failure = result?.isError === true;
    enqueue(async () => {
      await observer.toolCallCompleted({
        callId: exec.callId,
        toolName: open.toolName,
        outcome: failure ? "error" : "ok",
        agentId: open.agentId,
        taskId: open.taskId,
        errorMessage: failure ? String(result?.error?.message ?? result?.error ?? "tool failed") : void 0
      });
      if (open.toolName === ASK_USER_TOOL && open.taskId) {
        await observer.agentPresenceChanged({ agentId: open.agentId, coordination: "ready" });
        await observer.taskStarted({ taskId: open.taskId, agentId: open.agentId });
      }
    });
  });
  on("session/event", (session, event) => {
    const sessionId = session?.id ?? event?.sessionId;
    if (typeof sessionId !== "string") return;
    const entry = record(sessionId);
    if (event.type === "turn/start") {
      entry.openTurn = {
        turn: event.data.turn,
        taskId: turnTaskIdOf(sessionId, event.data.turn),
        attemptId: `attempt-${sessionId}-t${event.data.turn}`,
        journaled: false
      };
      return;
    }
    if (event.type === "user/message") {
      const turn = entry.openTurn;
      if (!turn || turn.journaled) return;
      turn.journaled = true;
      const title = messageText(event.data) ?? `Turn ${turn.turn}`;
      const isHumanPrompt = event.data?.source?.kind === "user";
      const parentTaskId = entry.parentSessionId ? openTaskId(entry.parentSessionId) : void 0;
      enqueue(async () => {
        const root = record(entry.rootSessionId);
        if (isHumanPrompt && !root.goalAnnounced) {
          root.goalAnnounced = true;
          await observer.goalCreated({
            goalId: goalIdOf(entry.rootSessionId),
            title,
            issuer: { id: "user", kind: "human" },
            roomId: entry.roomId
          });
        }
        await observer.taskCreated({
          taskId: turn.taskId,
          title,
          parentTaskId,
          goalId: root.goalAnnounced ? goalIdOf(entry.rootSessionId) : void 0,
          roomId: entry.roomId
        });
        if (parentTaskId) {
          await observer.taskDelegated({
            taskId: turn.taskId,
            toAgentId: entry.agentId,
            reason: "delegated to a subagent session"
          });
        }
        await observer.taskStarted({ taskId: turn.taskId, agentId: entry.agentId, attemptId: turn.attemptId });
        await observer.attemptStarted({
          taskId: turn.taskId,
          attemptId: turn.attemptId,
          agentId: entry.agentId
        });
      });
      return;
    }
    if (event.type === "turn/end") {
      const turn = entry.openTurn;
      entry.openTurn = void 0;
      if (!turn || !turn.journaled) return;
      const reason = event.data?.reason ?? { kind: "completed" };
      enqueue(async () => {
        if (reason.kind === "completed") {
          await observer.attemptFinished({ taskId: turn.taskId, attemptId: turn.attemptId, outcome: "succeeded" });
          await observer.taskCompleted({ taskId: turn.taskId });
        } else if (reason.kind === "blocked") {
          await observer.taskBlocked({ taskId: turn.taskId, reason: "the turn ended blocked" });
        } else if (reason.kind === "aborted") {
          await observer.attemptFinished({ taskId: turn.taskId, attemptId: turn.attemptId, outcome: "cancelled" });
          await observer.taskFailed({
            taskId: turn.taskId,
            reason: `cancelled (${reason.reason?.kind ?? "unknown cause"})`
          });
        } else {
          await observer.attemptFinished({ taskId: turn.taskId, attemptId: turn.attemptId, outcome: "failed" });
          await observer.taskFailed({
            taskId: turn.taskId,
            reason: String(reason.error?.message ?? reason.kind ?? "the turn failed")
          });
        }
        observer.releaseCorrelation(turn.taskId);
      });
      return;
    }
    if (event.type === "approval/asked") {
      const approvalId = String(event.data.id);
      const taskId = openTaskId(sessionId);
      const reason = event.data.reason ?? `${event.data.toolName} needs approval`;
      openApprovals.set(approvalId, { taskId, agentId: entry.agentId });
      enqueue(async () => {
        await observer.approvalRequested({
          approvalId,
          agentId: entry.agentId,
          reason,
          toolName: event.data.toolName,
          taskId
        });
        if (taskId) await observer.taskAwaitingApproval({ taskId, approvalId, reason });
      });
      return;
    }
    if (event.type === "approval/decided") {
      const approvalId = String(event.data.id);
      const open = openApprovals.get(approvalId) ?? { taskId: openTaskId(sessionId), agentId: entry.agentId };
      openApprovals.delete(approvalId);
      enqueue(async () => {
        await observer.approvalResolved({
          approvalId,
          decision: normalizeApprovalOutcome(event.data.outcome),
          agentId: open.agentId,
          taskId: open.taskId
        });
        if (open.taskId) {
          await observer.taskStarted({
            taskId: open.taskId,
            agentId: open.agentId,
            attemptId: entry.openTurn?.attemptId
          });
        }
      });
    }
  });
  return {
    /**
     * Resolve once every observation queued so far has reached the journal.
     * Used on shutdown so pending facts are not lost with the process, and by
     * tests that need a settled journal to assert against.
     */
    drain() {
      return queue;
    },
    dispose() {
      for (const disposer of disposers.reverse()) {
        try {
          disposer();
        } catch {
        }
      }
      openCalls.clear();
      openApprovals.clear();
      sessions.clear();
    }
  };
}
function normalizeApprovalOutcome(outcome) {
  switch (outcome) {
    case "allowed-once":
      return "allowed";
    case "rejected":
    case "cancelled":
    case "unavailable":
      return outcome;
    default:
      return "unavailable";
  }
}

// src/runtime/dsh-ports.ts
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
function createStoragePort(ctx) {
  const ensureDir = (path) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (error) {
      if (error && error.code !== "EEXIST") throw error;
    }
  };
  return {
    async read(path) {
      try {
        const resolved = await ctx.fs.resolve(path);
        return await ctx.fs.readText(resolved);
      } catch (error) {
        if (error && (error.code === "ENOENT" || /not found|no such file/i.test(String(error.message)))) {
          return void 0;
        }
        try {
          return readFileSync(path, "utf8");
        } catch (fallbackError) {
          if (fallbackError && fallbackError.code === "ENOENT") return void 0;
          throw fallbackError;
        }
      }
    },
    async write(path, text) {
      ensureDir(path);
      try {
        const resolved = await ctx.fs.resolve(path);
        await ctx.fs.writeText(resolved, text);
      } catch {
        writeFileSync(path, text, "utf8");
      }
    },
    async append(path, text) {
      ensureDir(path);
      appendFileSync(path, text, "utf8");
    }
  };
}
function createSpawnPort(ctx, workspace) {
  return {
    async run(argv, options = {}) {
      const handle = await ctx.subprocess.spawn({
        argv,
        cwd: options.cwd ?? workspace,
        stdio: {
          stdin: options.stdinFile ? { kind: "file", path: options.stdinFile } : "ignore",
          stdout: { maxBytes: 1 << 20 },
          stderr: { maxBytes: 1 << 18 }
        },
        graceMs: 3e3
      });
      const outcome = await handle.done;
      const read = (stream) => stream ? stream.readFrom(0).text : "";
      return {
        code: outcome.exitCode ?? -1,
        stdout: read(handle.collected.stdout),
        stderr: read(handle.collected.stderr)
      };
    },
    async resolveExecutable(path) {
      try {
        return await ctx.subprocess.resolveExecutable(path);
      } catch {
        return void 0;
      }
    }
  };
}
function createHttpServerPort(ctx, options = {}) {
  const webServer = ctx.webServer;
  const corsHeaders = options.corsHeaders ?? {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
  const toRequest = (req, body) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const query = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    const headers = {};
    for (const [key, value] of Object.entries(req.headers ?? {})) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    }
    return { method: req.method ?? "GET", path: url.pathname, query, headers, body };
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const decoder = new TextDecoder("utf-8", { stream: true });
    let text = "";
    req.on("data", (chunk) => {
      text += decoder.decode(chunk);
    });
    req.on("end", () => {
      text += decoder.decode();
      resolve(text);
    });
    req.on("error", reject);
  });
  return {
    route(spec) {
      const handler = async (req, res) => {
        try {
          if (req.method === "OPTIONS") {
            res.writeHead(204, corsHeaders);
            res.end();
            return;
          }
          if (req.method !== spec.method) {
            res.writeHead(405, { "Content-Type": "application/json", ...corsHeaders });
            res.end(JSON.stringify({ error: "method not allowed" }));
            return;
          }
          const body = spec.method === "POST" ? await readBody(req) : void 0;
          const response = await spec.handler(toRequest(req, body));
          res.writeHead(response.status, {
            "Cache-Control": "no-store",
            ...corsHeaders,
            ...response.headers ?? {}
          });
          res.end(response.body ?? "");
        } catch (error) {
          console.error(`iFlow edge route ${spec.path} failed`, error);
          try {
            res.writeHead(500, { "Content-Type": "application/json", ...corsHeaders });
            res.end(JSON.stringify({ error: "internal error" }));
          } catch {
          }
        }
      };
      const dispose = webServer.register({ kind: "exact", path: spec.path, handler });
      return { dispose: () => dispose() };
    },
    stream(spec) {
      const handler = async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          ...corsHeaders
        });
        const closeHandlers = [];
        let closed = false;
        const finish = () => {
          if (closed) return;
          closed = true;
          for (const handlerFn of closeHandlers) {
            try {
              handlerFn();
            } catch {
            }
          }
        };
        req.on("close", finish);
        res.on("close", finish);
        const keepAlive = setInterval(() => {
          if (!closed) {
            try {
              res.write(": keep-alive\n\n");
            } catch {
              finish();
            }
          }
        }, 25e3);
        closeHandlers.push(() => clearInterval(keepAlive));
        spec.handler(toRequest(req, void 0), {
          send(chunk) {
            if (closed) return;
            try {
              res.write(chunk);
            } catch {
              finish();
            }
          },
          close() {
            finish();
            try {
              res.end();
            } catch {
            }
          },
          onClose(handlerFn) {
            if (closed) handlerFn();
            else closeHandlers.push(handlerFn);
          }
        });
      };
      const dispose = webServer.register({ kind: "exact", path: spec.path, handler });
      return { dispose: () => dispose() };
    },
    baseUrl() {
      const host = webServer.host === "0.0.0.0" ? "127.0.0.1" : webServer.host ?? "127.0.0.1";
      return `http://${host}:${webServer.port}`;
    }
  };
}
function createClockPort(ctx) {
  return {
    now: () => Date.now(),
    nowIso: () => (/* @__PURE__ */ new Date()).toISOString(),
    timeout(handler, ms) {
      const disposer = ctx.timeout(handler, ms);
      return { dispose: () => typeof disposer === "function" ? disposer() : void 0 };
    }
  };
}
function createLoggerPort(prefix = "iFlow edge") {
  return {
    info: (message, detail) => console.log(`${prefix}: ${message}`, detail ?? ""),
    warn: (message, detail) => console.warn(`${prefix}: ${message}`, detail ?? ""),
    error: (message, detail) => console.error(`${prefix}: ${message}`, detail ?? "")
  };
}
function createIdPortForDsh() {
  let counter = 0;
  return {
    newId(prefix) {
      counter += 1;
      const random = Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0");
      return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${random}`;
    }
  };
}
function createDshPorts(ctx, workspace, options = {}) {
  return {
    storage: createStoragePort(ctx),
    spawn: createSpawnPort(ctx, workspace),
    http: createHttpServerPort(ctx, options),
    clock: createClockPort(ctx),
    logger: createLoggerPort(options.logPrefix),
    ids: createIdPortForDsh()
  };
}

// src/edge/install.ts
function deriveNodeId(workspace) {
  let host = "unknown-host";
  try {
    host = hostname() || host;
  } catch {
  }
  let hash = 2166136261;
  for (let i = 0; i < workspace.length; i++) {
    hash ^= workspace.charCodeAt(i);
    hash = hash * 16777619 >>> 0;
  }
  return `${host.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${hash.toString(16)}`;
}
async function installIFlowEdge(ctx, options) {
  const workspace = options.workspace;
  const nodeId = deriveNodeId(workspace);
  const ports = createDshPorts(ctx, workspace, { logPrefix: "iFlow edge" });
  const descriptor = {
    nodeId,
    runtimeKind: "dsh",
    runtimeVersion: String(options.version ?? "unknown"),
    workspaceRoot: workspace,
    capabilities: options.capabilities ?? [],
    selfAgentId: `node-${nodeId}`,
    selfAgentLabel: options.alias ?? "iflow-edge",
    did: options.did ?? void 0
  };
  let signer;
  let verifier;
  if (typeof options.runIflowId === "function" && typeof options.writeScratch === "function") {
    const io = { run: options.runIflowId, writeScratch: options.writeScratch, logger: ports.logger };
    signer = createIflowIdSigner(io);
    verifier = createIflowIdVerifier(io);
    try {
      await signer.did();
    } catch (error) {
      ports.logger.warn(
        `iFlow edge: no usable identity, so facts will be journaled UNSIGNED (${String(error?.message ?? error)})`
      );
      signer = void 0;
      verifier = void 0;
    }
  }
  const currentToken = () => typeof options.token === "function" ? options.token() : options.token;
  const edge = await createEdge({
    ports,
    descriptor,
    signer,
    verifier,
    server: {
      // The edge read API is loopback-only by default, but this DSH may have
      // been configured to bind a LAN address, so it reuses the plugin's own
      // bearer check rather than assuming the port is private.
      authorize: (request) => {
        const token = currentToken();
        if (!token) return true;
        return request.headers["authorization"] === `Bearer ${token}`;
      },
      // The standalone Web app is served from its own dev origin.
      allowedOrigins: options.allowedOrigins
    }
  });
  const instrumentation = installDshInstrumentation(ctx, edge, {
    capabilities: descriptor.capabilities
  });
  const acceptCommands = options.acceptCommands === true;
  const registry = createAgentRegistry(ctx);
  const approvals = createApprovalBridge(ctx, { enabled: acceptCommands && options.routeApprovals === true });
  const executor = createDshCommandExecutor({
    enabled: acceptCommands,
    nodeId,
    registry,
    approvals,
    observer: edge.observer
  });
  const commandRoute = ports.http.route({
    method: "POST",
    path: "/iflow/command",
    async handler(request) {
      const json = (status, body) => ({
        status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body)
      });
      const token = currentToken();
      if (!token) {
        return json(503, { error: "the command channel requires a configured token; set one with iflow_set_token" });
      }
      if (request.headers["authorization"] !== `Bearer ${token}`) {
        return json(401, { error: "unauthorized" });
      }
      let command;
      try {
        command = JSON.parse(request.body ?? "");
      } catch {
        return json(400, { error: "body must be an IFlowCommand JSON object" });
      }
      const outcome = await edge.dispatchCommand(command, executor);
      return json(200, { commandId: command?.commandId, ...outcome });
    }
  });
  if (acceptCommands) {
    console.warn(
      `iFlow edge: command acceptance is ON. Remote hubs may request ${options.routeApprovals === true ? "task cancellation and approval decisions" : "task cancellation"} on this node.`
    );
  }
  return {
    edge,
    nodeId,
    signing: signer !== void 0,
    executor,
    approvals,
    /** Resolve once every queued observation has reached the journal. */
    drain: () => instrumentation.drain(),
    dispose() {
      commandRoute.dispose();
      approvals.dispose();
      registry.dispose();
      instrumentation.dispose();
      void instrumentation.drain().finally(() => edge.dispose());
    }
  };
}

// src/a2a/capability.ts
function validCapabilityId(id) {
  if (id === "*") return true;
  if (typeof id !== "string" || !id.startsWith("iflow.cap:")) return false;
  const rest = id.slice("iflow.cap:".length);
  const seg = rest.endsWith(".*") ? rest.slice(0, rest.length - 2) : rest;
  if (!seg) return false;
  return seg.split(".").every((part) => part.length > 0 && /^[a-z0-9_-]+$/.test(part));
}
function normalizeAction(action) {
  if (action === "agent-task") return "iflow.cap:agent.run";
  return action;
}

// src/a2a/protocol.ts
var TERMINAL_TASK_STATES = /* @__PURE__ */ new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED"
]);
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcException(code, message, data) {
  const err = new Error(message);
  err.rpcCode = code;
  err.rpcData = data;
  return err;
}
function errorInfo(reason) {
  return [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "a2a-protocol.org" }];
}
function messageText2(message) {
  if (!message || !Array.isArray(message.parts)) return "";
  const chunks = [];
  for (const part of message.parts) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") chunks.push(part.text);
    else if (part.data !== void 0) chunks.push(JSON.stringify(part.data));
    else if (typeof part.url === "string") chunks.push(part.url);
  }
  return chunks.join("\n");
}
function partsText(parts) {
  if (!Array.isArray(parts)) return "";
  const chunks = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") chunks.push(part.text);
    else if (part.data !== void 0) chunks.push(JSON.stringify(part.data));
    else if (typeof part.url === "string") chunks.push(part.url);
  }
  return chunks.join("\n");
}
function taskText(task) {
  const fromArtifacts = task.artifacts && task.artifacts.length > 0 ? task.artifacts.map((a) => partsText(a.parts)).filter((t) => t.length > 0).join("\n\n") : "";
  if (fromArtifacts) return fromArtifacts;
  const statusMessage = task.status && task.status.message ? task.status.message : void 0;
  return statusMessage ? partsText(statusMessage.parts) : "";
}
function blocksToText(blocks) {
  return blocks.filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}
function foldOutput(events) {
  let last;
  const partial = [];
  for (const event of events) {
    if (event && event.type === "assistant/message") {
      const content = event.data && event.data.message ? event.data.message.content : void 0;
      if (Array.isArray(content) && content.length > 0) last = content;
    } else if (event && event.type === "assistant/chunk" && event.data && event.data.chunk && event.data.chunk.type === "text-delta" && typeof event.data.chunk.text === "string") {
      partial.push(event.data.chunk.text);
    }
  }
  if (last !== void 0) return last;
  const text = partial.join("");
  return text.length > 0 ? [{ type: "text", text }] : [];
}
function eventText(d) {
  try {
    if (!d || !Array.isArray(d.content)) return "";
    return d.content.map((b) => b && typeof b.text === "string" ? b.text : "").join("");
  } catch (err) {
    return "";
  }
}

// src/util/hash.ts
function signingDigest(text) {
  const bytes = new TextEncoder().encode(text);
  const K = [1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298];
  const H = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225];
  const ml = bytes.length * 8;
  const withOne = new Uint8Array(bytes.length + 1);
  withOne.set(bytes);
  withOne[bytes.length] = 128;
  let paddedLen = withOne.length + 8;
  while (paddedLen % 64 !== 0) paddedLen++;
  const padded = new Uint8Array(paddedLen);
  padded.set(withOne);
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, Math.floor(ml / 4294967296), false);
  dv.setUint32(paddedLen - 4, ml >>> 0, false);
  const rot = (x, n) => x >>> n | x << 32 - n;
  for (let i = 0; i < paddedLen; i += 64) {
    const w = new Array(64);
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 64; j++) {
      const s0 = rot(w[j - 15], 7) ^ rot(w[j - 15], 18) ^ w[j - 15] >>> 3;
      const s1 = rot(w[j - 2], 17) ^ rot(w[j - 2], 19) ^ w[j - 2] >>> 10;
      w[j] = w[j - 16] + s0 + w[j - 7] + s1 >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let j = 0; j < 64; j++) {
      const S1 = rot(e, 6) ^ rot(e, 11) ^ rot(e, 25);
      const ch = e & f ^ ~e & g;
      const t1 = h + S1 + ch + K[j] + w[j] >>> 0;
      const S0 = rot(a, 2) ^ rot(a, 13) ^ rot(a, 22);
      const maj = a & b ^ a & c ^ b & c;
      const t2 = S0 + maj >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    H[0] = H[0] + a >>> 0;
    H[1] = H[1] + b >>> 0;
    H[2] = H[2] + c >>> 0;
    H[3] = H[3] + d >>> 0;
    H[4] = H[4] + e >>> 0;
    H[5] = H[5] + f >>> 0;
    H[6] = H[6] + g >>> 0;
    H[7] = H[7] + h >>> 0;
  }
  return H.map((x) => x.toString(16).padStart(8, "0")).join("");
}
function simpleHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = h * 16777619 >>> 0;
  }
  return h.toString(16);
}

// src/index.ts
var pluginRoot = fileURLToPath(new URL("../", import.meta.url));
var sourcePath = fileURLToPath(import.meta.url);
var index_default = {
  inject: ["tools", "webServer", "web", "subprocess", "sandboxPolicy", "agents", "agentDefaultModel", "agentPresets", "sessionTitle", "sessions", "fs", "timer"],
  apply(ctx, config = {}) {
    const webServer = ctx.webServer;
    const agents = ctx.agents;
    const workspace = ctx.sandboxPolicy.workspaceRoot;
    const allowPeerUpdate = config.allowPeerUpdate === true;
    function makeAbortController() {
      const listeners = /* @__PURE__ */ new Set();
      const signal = {
        aborted: false,
        reason: void 0,
        addEventListener(type, fn) {
          if (type === "abort" && typeof fn === "function") listeners.add(fn);
        },
        removeEventListener(type, fn) {
          if (type === "abort") listeners.delete(fn);
        },
        throwIfAborted() {
          if (this.aborted) throw this.reason instanceof Error ? this.reason : new Error(String(this.reason));
        }
      };
      return {
        signal,
        abort(reason) {
          if (signal.aborted) return;
          signal.aborted = true;
          signal.reason = reason === void 0 ? new Error("Aborted") : reason;
          const pending = [...listeners];
          listeners.clear();
          for (const fn of pending) {
            try {
              fn();
            } catch (e) {
            }
          }
        }
      };
    }
    const state = {
      name: "DSH Agent (iFlow)",
      description: "A2A bridge exposing this DeepSeek Harness instance to other agents, letting remote DSH machines (or any A2A agent) delegate tasks here and use this machine's tools.",
      version: "1.0.0",
      syncVersion: "20",
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      alias: "if-lt",
      // Seeded from plugin config so a node can come up with auth already on;
      // `iflow_set_token` still changes it at runtime.
      token: typeof config.token === "string" && config.token.length > 0 ? config.token : null,
      publicUrl: null,
      peers: /* @__PURE__ */ new Map(),
      tasks: /* @__PURE__ */ new Map(),
      outgoing: /* @__PURE__ */ new Map(),
      mirrorTurn: 0,
      mirrorDetach: null,
      mirrorPeer: null
    };
    const scratchDir = `${workspace}/.iflow/tmp`;
    const scratchPath = (name) => {
      try {
        mkdirSync2(scratchDir, { recursive: true });
      } catch (e) {
      }
      return `${scratchDir}/${name}`;
    };
    const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
    const iso = () => (/* @__PURE__ */ new Date()).toISOString();
    async function readSource() {
      try {
        const target = await ctx.fs.resolve(sourcePath);
        const text = await ctx.fs.readText(target);
        return { text, sha: simpleHash(text) };
      } catch (err) {
        return { text: null, sha: null };
      }
    }
    async function ensureMirror() {
      try {
        const existing = ctx.sessions.get("iflow-mirror");
        let id = "iflow-mirror";
        if (existing) {
          const meta2 = existing.header && existing.header.meta ? existing.header.meta : {};
          if (!meta2.origin || meta2.origin !== "subagent") return existing;
          id = "iflow-mirror-ui";
        }
        const persistence = ctx.get("sessionPersistence");
        const canReadopt = !!(persistence && typeof persistence.prepare === "function");
        let session;
        let detach;
        if (canReadopt) {
          try {
            const prep = await persistence.prepare(id);
            session = prep.session;
            detach = ctx.sessions.enter(session);
          } catch (err) {
            let fresh = ctx.sessions.get(id);
            if (!fresh) {
              fresh = ctx.sessions.prepare(id, { meta: { cwd: workspace } });
              detach = ctx.sessions.enter(fresh);
            } else {
              detach = void 0;
            }
            session = fresh;
          }
        } else {
          let fresh = ctx.sessions.get(id);
          if (!fresh) {
            fresh = ctx.sessions.prepare(id, { meta: { cwd: workspace } });
            ctx.sessions.enter(fresh);
          }
          session = fresh;
          detach = void 0;
        }
        try {
          ctx.sessionTitle.rename(session, "iFlow \xB7 \u53CC\u5411\u955C\u50CF");
        } catch (e) {
        }
        if (detach) state.mirrorDetach = detach;
        else state.mirrorDetach = null;
        return session;
      } catch (err) {
        console.error("iFlow ensureMirror failed", err);
        return void 0;
      }
    }
    function retireMirror() {
      try {
        if (state.mirrorDetach) {
          state.mirrorDetach();
          state.mirrorDetach = null;
        }
      } catch (err) {
        console.error("iFlow retireMirror failed", err);
      }
    }
    const mailboxFile = join(workspace, ".iflow", "mailbox.json");
    async function loadMailbox() {
      try {
        const p = await ctx.fs.resolve(mailboxFile);
        const raw = await ctx.fs.readText(p);
        const data = JSON.parse(raw);
        return {
          outbox: Array.isArray(data.outbox) ? data.outbox : [],
          inbox: Array.isArray(data.inbox) ? data.inbox : []
        };
      } catch (err) {
        return { outbox: [], inbox: [] };
      }
    }
    async function saveMailbox(mb) {
      try {
        const p = await ctx.fs.resolve(mailboxFile);
        await ctx.fs.writeText(p, JSON.stringify(mb, null, 2));
      } catch (err) {
        console.error("iFlow saveMailbox failed", err);
      }
    }
    async function enqueueOut(peer, prompt) {
      const mb = await loadMailbox();
      if (mb.outbox.some((o) => o.peer === peer && o.prompt === prompt && o.state !== "delivered")) return;
      mb.outbox.push({
        id: uid("mbox"),
        peer,
        prompt,
        taskId: "",
        createdAt: Date.now(),
        attempts: 0,
        lastAttempt: 0,
        state: "queued"
      });
      await saveMailbox(mb);
    }
    const peersFile = join(workspace, ".iflow", "peers.json");
    async function loadPeers() {
      try {
        const p = await ctx.fs.resolve(peersFile);
        const data = JSON.parse(await ctx.fs.readText(p));
        const map = /* @__PURE__ */ new Map();
        for (const item of Array.isArray(data.peers) ? data.peers : []) {
          if (!item || typeof item.name !== "string" || !item.name || typeof item.url !== "string") continue;
          map.set(item.name, {
            url: item.url,
            token: typeof item.token === "string" && item.token.length > 0 ? item.token : null,
            addedAt: typeof item.addedAt === "string" ? item.addedAt : iso()
          });
        }
        return map;
      } catch (err) {
        return /* @__PURE__ */ new Map();
      }
    }
    async function savePeers() {
      try {
        const p = await ctx.fs.resolve(peersFile);
        const peers = [...state.peers.entries()].map(([name, entry]) => ({
          name,
          url: entry.url,
          token: entry.token,
          addedAt: entry.addedAt
        }));
        await ctx.fs.writeText(p, JSON.stringify({ peers }, null, 2));
      } catch (err) {
        console.error("iFlow savePeers failed", err);
      }
    }
    const peersReady = loadPeers().then((map) => {
      state.peers = map;
    }).catch(() => {
    });
    async function probePeer(name, entry) {
      try {
        await curlGet(`${entry.url}/.well-known/agent-card.json`, 8, entry.token !== null ? entry.token : state.token);
        entry.healthy = true;
      } catch (err) {
        entry.healthy = false;
      }
      entry.lastSeen = Date.now();
    }
    peersReady.then(() => {
      for (const [name, entry] of state.peers) probePeer(name, entry);
    }).catch(() => {
    });
    async function sendToPeer(peerName, prompt) {
      const entry = resolvePeer(peerName);
      if (!entry) return { ok: false, error: "unknown peer" };
      const rpc = (method, params) => curlPost(`${entry.url}/a2a`, { jsonrpc: "2.0", id: uid("req"), method, params }, 60, entry.token);
      return rpc("SendMessage", {
        message: { messageId: uid("msg"), role: "ROLE_USER", parts: [{ text: prompt, mediaType: "text/plain" }] },
        configuration: { returnImmediately: true, historyLength: 0 },
        metadata: { from: state.alias, machine: await getMachineName() }
      });
    }
    ctx.on("session/event", (session, event) => {
      try {
        if (!session || session.id !== "iflow-mirror") return;
        if (!event || event.type !== "user/message") return;
        const d = event.data;
        if (!d || typeof d.id !== "string" || d.id.startsWith("iflow-")) return;
        const text = eventText(d);
        if (!text || !state.mirrorPeer) return;
        sendToPeer(state.mirrorPeer, text).then(() => {
        }).catch(() => {
        });
      } catch (err) {
      }
    });
    async function mirrorAppend(side, text, label) {
      try {
        const mirror = await ensureMirror();
        if (!mirror) return;
        const turn = state.mirrorTurn + 1;
        const step = 1;
        mirror.append("turn/start", { turn });
        mirror.append("step/start", { turn, step });
        const content = [{ type: "text", text: `${label} ${text}` }];
        if (side === "self") {
          mirror.append("user/message", {
            id: `iflow-${uid("m")}`,
            role: "user",
            content,
            source: { kind: "user" }
          }, { surfaceOp: "append" });
        } else {
          mirror.append("assistant/message", {
            turn,
            step,
            message: {
              id: `iflow-${uid("m")}`,
              role: "assistant",
              content,
              source: { kind: "model", provider: "iflow", model: "remote" }
            }
          }, { surfaceOp: "append" });
        }
        mirror.append("step/end", { turn, step });
        state.mirrorTurn = turn;
        retireMirror();
      } catch (err) {
        console.error("iFlow mirrorAppend failed", err);
      }
    }
    async function curlRaw(method, url, payload, timeoutSec, token) {
      const argv = ["curl", "-sS", "-m", String(timeoutSec), "-X", method];
      if (method === "POST") {
        argv.push("-H", "Content-Type: application/json", "-H", "A2A-Version: 1.0");
        if (token) argv.push("-H", `Authorization: Bearer ${token}`);
        const bodyText = JSON.stringify(payload);
        if (/\/a2a\/?$/.test(url)) {
          try {
            const id = await getIdentity();
            if (id.did) {
              const path = url.replace(/^https?:\/\/[^/]+/, "");
              const bodyPath = scratchPath("body.json");
              const resolvedBody = await ctx.fs.resolve(bodyPath);
              await ctx.fs.writeText(resolvedBody, bodyText);
              const envelope = await iflowId(["sign-file", method, path, bodyPath], 20);
              argv.push("-H", `X-IFlow-Signature: ${envelope.replace(/\n/g, " ")}`);
            }
          } catch (e) {
          }
        }
        argv.push("--data-binary", bodyText);
      } else if (token) {
        argv.push("-H", `Authorization: Bearer ${token}`);
      }
      argv.push(url);
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: workspace,
        stdio: { stdin: "ignore", stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
        graceMs: 5e3
      });
      const outcome = await handle.done;
      const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
      const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
      if (outcome.exitCode !== 0) throw new Error(`iFlow outbound HTTP failed (exit ${String(outcome.exitCode)}): ${(stderr || stdout).slice(0, 400)}`);
      return stdout;
    }
    async function curlPost(url, payload, timeoutSec, token) {
      return JSON.parse(await curlRaw("POST", url, payload, timeoutSec, token));
    }
    async function curlGet(url, timeoutSec, token) {
      return curlRaw("GET", url, void 0, timeoutSec, token);
    }
    let iflowIdResolved = null;
    const IFI_BIN_DIR = join(pluginRoot, "rust", "target", "release");
    const IFI_BIN_NAME = process.platform === "win32" ? "iflow-id.exe" : "iflow-id";
    const IFI_BIN_URL = process.platform === "win32" ? "https://github.com/Neo-Pz/dsh/releases/latest/download/iflow-id-windows-amd64.exe" : process.platform === "darwin" ? "https://github.com/Neo-Pz/dsh/releases/latest/download/iflow-id-darwin-amd64" : "https://github.com/Neo-Pz/dsh/releases/latest/download/iflow-id-linux-amd64";
    async function fetchIflowIdBinary() {
      try {
        mkdirSync2(IFI_BIN_DIR, { recursive: true });
        const dest = join(IFI_BIN_DIR, IFI_BIN_NAME);
        const dl = ctx.subprocess.spawn({ argv: ["curl", "-sSL", "-m", "120", "-o", dest, IFI_BIN_URL], cwd: workspace, stdio: { stdin: "ignore", stdout: { maxBytes: 1024 }, stderr: { maxBytes: 256 * 1024 } } });
        const out = await dl.done;
        return out.exitCode === 0;
      } catch (err) {
        console.error("iFlow iflow-id auto-fetch failed", err);
        return false;
      }
    }
    async function resolveIflowId() {
      if (iflowIdResolved !== null) return iflowIdResolved;
      const cand = join(IFI_BIN_DIR, IFI_BIN_NAME);
      try {
        const resolved = await ctx.subprocess.resolveExecutable(cand);
        if (resolved) {
          iflowIdResolved = resolved;
          return iflowIdResolved;
        }
      } catch (e) {
      }
      try {
        if (await fetchIflowIdBinary()) {
          const resolved = await ctx.subprocess.resolveExecutable(cand);
          if (resolved) {
            iflowIdResolved = resolved;
            return iflowIdResolved;
          }
        }
      } catch (e) {
      }
      iflowIdResolved = false;
      return iflowIdResolved;
    }
    async function iflowId(args, timeoutSec = 15) {
      const bin = await resolveIflowId();
      if (!bin) throw new Error(`iflow-id binary not found (expected ${join(pluginRoot, "rust", "target", "release")})`);
      const handle = ctx.subprocess.spawn({
        // --home <workspace> keeps the store at <workspace>/.iflow, inside the
        // sandbox's writable root (the store appends .iflow itself).
        argv: [bin, "--home", workspace, ...args],
        cwd: workspace,
        stdio: { stdin: "ignore", stdout: { maxBytes: 4 * 1024 * 1024 }, stderr: { maxBytes: 256 * 1024 } },
        graceMs: 5e3
      });
      const outcome = await handle.done;
      const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
      const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
      if (outcome.exitCode !== 0) throw new Error(`iflow-id ${args[0]} failed (exit ${String(outcome.exitCode)}): ${(stderr || stdout).slice(0, 400)}`);
      return stdout.trim();
    }
    let identityCache = null;
    async function getIdentity() {
      if (identityCache) return identityCache;
      try {
        const parsed = JSON.parse(await iflowId(["show", "--json"]));
        if (parsed && typeof parsed.did === "string") {
          identityCache = { did: parsed.did, label: parsed.label ?? state.alias, present: true };
          return identityCache;
        }
      } catch (e) {
      }
      identityCache = { did: null, label: state.alias, present: false };
      return identityCache;
    }
    async function ensureIdentity() {
      const id = await getIdentity();
      if (id.present) return id;
      try {
        const out = await iflowId(["create", state.alias]);
        const did = /did:\s+(did:key:\S+)/.exec(out);
        identityCache = { did: did ? did[1] : null, label: state.alias, present: !!did };
      } catch (e) {
        identityCache = { did: null, label: state.alias, present: false };
      }
      return identityCache;
    }
    let machineName = null;
    async function getMachineName() {
      if (machineName !== null) return machineName;
      try {
        const handle = ctx.subprocess.spawn({
          argv: ["hostname"],
          cwd: workspace,
          stdio: { stdin: "ignore", stdout: { maxBytes: 4096 }, stderr: { maxBytes: 1024 } },
          graceMs: 3e3
        });
        const outcome = await handle.done;
        const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
        machineName = outcome.exitCode === 0 && stdout.trim().length > 0 ? stdout.trim() : null;
      } catch (err) {
        machineName = null;
      }
      return machineName;
    }
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, A2A-Version, X-IFlow-Signature, X-IFlow-Grant"
    };
    function sendJson(res, status, obj, extraHeaders) {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders, ...extraHeaders || {} });
      res.end(JSON.stringify(obj));
    }
    function readBody(req) {
      return new Promise((resolve, reject) => {
        const decoder = new TextDecoder("utf-8", { stream: true });
        let text = "";
        req.on("data", (chunk) => {
          text += decoder.decode(chunk);
        });
        req.on("end", () => {
          text += decoder.decode();
          resolve(text);
        });
        req.on("error", reject);
      });
    }
    function authorized(req) {
      if (state.token === null) return true;
      const header = req.headers["authorization"];
      return typeof header === "string" && header === `Bearer ${state.token}`;
    }
    async function agentCard(hostHeader) {
      const base = (state.publicUrl || `http://${hostHeader}`).replace(/\/+$/, "");
      const card = {
        name: state.name,
        description: state.description,
        version: state.version,
        supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
        capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
        defaultInputModes: ["text/plain", "application/json"],
        defaultOutputModes: ["text/plain", "application/json"],
        skills: [{
          id: "agent-task",
          name: "Agent task execution",
          description: "Runs a prompt as a full agent on this DSH instance with access to all of its local tools, then returns the final answer.",
          tags: ["agent", "task", "dsh", "iflow"],
          examples: ["Inspect the workspace and summarize what it contains.", "Run a command on this machine and report the output."],
          inputModes: ["text/plain", "application/json"],
          outputModes: ["text/plain", "application/json"]
        }]
      };
      try {
        const id = await getIdentity();
        if (id.did) card.identity = { did: id.did };
      } catch (e) {
      }
      return card;
    }
    function setStatus(taskId, stateName, text) {
      const task = state.tasks.get(taskId);
      if (!task) return;
      task.status = { state: stateName, timestamp: iso() };
      if (text !== void 0) {
        task.status.message = { messageId: uid("msg"), role: "ROLE_AGENT", parts: [{ text, mediaType: "text/plain" }] };
      }
    }
    function snapshot(taskId, includeArtifacts) {
      const task = state.tasks.get(taskId);
      if (!task) return void 0;
      const out = { id: task.id, contextId: task.contextId, status: task.status };
      if (includeArtifacts !== false && task.artifacts) out.artifacts = task.artifacts;
      if (task.metadata) out.metadata = task.metadata;
      return out;
    }
    function collectTaskUsage(events) {
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
      for (const event of events) {
        if (event && event.type === "assistant/message" && event.data && event.data.usage) {
          const u = event.data.usage;
          usage.inputTokens += u.inputTokens || 0;
          usage.outputTokens += u.outputTokens || 0;
          usage.cacheReadTokens += u.cacheReadTokens || 0;
          usage.cacheWriteTokens += u.cacheWriteTokens || 0;
          usage.reasoningTokens += u.reasoningTokens || 0;
        }
      }
      return usage;
    }
    async function recordTaskUsage(taskId, from, events, startedAt, model) {
      try {
        const usage = collectTaskUsage(events);
        const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        if (total === 0) return;
        const durationMs = Math.max(0, Date.now() - startedAt);
        await iflowId([
          "usage",
          "record",
          taskId,
          from || "unknown",
          model || "unknown",
          String(usage.inputTokens),
          String(usage.outputTokens),
          "--cache-read",
          String(usage.cacheReadTokens),
          "--cache-write",
          String(usage.cacheWriteTokens),
          "--duration",
          String(durationMs)
        ], 20);
        console.log(`iFlow usage recorded task ${taskId}: ${total} tokens`);
      } catch (err) {
        try {
          console.error("iFlow usage record failed", err);
        } catch (e) {
        }
      }
    }
    async function runChild(taskId, text, controller, from) {
      const startedAt = Date.now();
      const selection = ctx.agentDefaultModel.currentSelection();
      const agentOptions = selection && selection.provider && selection.model ? { provider: selection.provider, model: selection.model } : {};
      const wantedPreset = config.inboundPreset || "remote-a2a";
      let presetId;
      try {
        const preset = await ctx.agentPresets.resolve(wantedPreset);
        presetId = preset && preset.id ? preset.id : void 0;
        if (!presetId) throw new Error(`preset '${wantedPreset}' resolved without an id`);
      } catch (err) {
        if (config.allowUnrestrictedInbound !== true) {
          const detail = `No '${wantedPreset}' agent preset is installed, so this node cannot confine an inbound remote task. Install a restricted preset with that id, point config.inboundPreset at one, or set config.allowUnrestrictedInbound: true to accept the risk of granting remote peers the full local toolset.`;
          console.error(`iFlow: refusing an inbound A2A task \u2014 ${detail}`);
          setStatus(taskId, "TASK_STATE_REJECTED", detail);
          return;
        }
        console.warn(
          `iFlow: '${wantedPreset}' preset missing and allowUnrestrictedInbound is on \u2014 this inbound remote task gets the full local toolset.`
        );
        try {
          const preset = await ctx.agentPresets.resolve("standard");
          presetId = preset && preset.id ? preset.id : void 0;
        } catch (fallbackErr) {
          presetId = void 0;
        }
      }
      setStatus(taskId, "TASK_STATE_WORKING", "Processing the request with a local agent.");
      await mirrorAppend("remote", text, `[agent:${from || "remote"}]`);
      const childId = `iflow-${uid("agent")}`;
      let handle;
      try {
        handle = await agents.create({
          sessionId: childId,
          meta: { cwd: workspace, origin: "subagent", ...presetId ? { agentPreset: presetId } : {} },
          agentOptions,
          signal: controller.signal,
          // Mount the resolved preset inside the creation window so the child's
          // toolset is decided before it can run anything. Which preset that is
          // was settled above, and an unconfined child never gets this far
          // unless the operator explicitly allowed it.
          setup: async (agentCtx) => {
            if (presetId) await ctx.agentPresets.mount(agentCtx, presetId);
          }
        });
      } catch (err) {
        if (controller.signal.aborted) setStatus(taskId, "TASK_STATE_CANCELED", "The task was canceled.");
        else setStatus(taskId, "TASK_STATE_FAILED", `Failed to start the local agent: ${String(err && err.message ? err.message : err)}`);
        return;
      }
      const child = handle.agent;
      try {
        ctx.sessionTitle.rename(child.session, `iFlow \xB7 ${from || "remote"}`);
      } catch (err) {
        console.error("iFlow rename failed", err);
      }
      const onAbort = () => {
        try {
          child.cancel({ kind: "parent" });
        } catch (e) {
        }
      };
      controller.signal.addEventListener("abort", onAbort);
      const stopTimeout = ctx.timeout(() => {
        controller.abort(new Error("iFlow task timed out after 10 minutes"));
      }, 10 * 60 * 1e3);
      let outputBlocks = [];
      try {
        child.followup({
          id: `iflow-${uid("msg")}`,
          role: "user",
          content: [{ type: "text", text }],
          source: { kind: "user" }
        });
        await child.whenIdle();
        outputBlocks = foldOutput(child.session.events);
      } catch (err) {
        console.error(`iFlow task ${taskId} agent loop error`, err);
        setStatus(taskId, "TASK_STATE_FAILED", `The local agent failed: ${String(err && err.message ? err.message : err)}`);
      } finally {
        controller.signal.removeEventListener("abort", onAbort);
        stopTimeout();
        try {
          await handle.dispose();
        } catch (err) {
          console.error("iFlow child dispose error", err);
        }
        state.outgoing.delete(taskId);
      }
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        const timedOut = reason && reason.message && String(reason.message).startsWith("iFlow task timed out");
        setStatus(
          taskId,
          timedOut ? "TASK_STATE_FAILED" : "TASK_STATE_CANCELED",
          timedOut ? "The task timed out." : "The task was canceled."
        );
        try {
          await recordTaskUsage(taskId, from, child.session.events, startedAt, selection && selection.model || void 0);
        } catch (e) {
        }
        return;
      }
      const textOut = blocksToText(outputBlocks);
      if (textOut.length > 0) {
        const task = state.tasks.get(taskId);
        if (task) {
          task.artifacts = [{
            artifactId: `iflow-${uid("art")}`,
            name: "result",
            description: "Final answer produced by the local agent.",
            parts: [{ text: textOut, mediaType: "text/plain" }]
          }];
        }
        setStatus(taskId, "TASK_STATE_COMPLETED", "The task completed successfully.");
        await mirrorAppend("self", textOut, `[agent:${state.alias}]`);
      } else {
        setStatus(taskId, "TASK_STATE_FAILED", "The local agent produced no output.");
      }
      try {
        await recordTaskUsage(taskId, from, child.session.events, startedAt, selection && selection.model || void 0);
      } catch (e) {
      }
    }
    async function handleSendMessage(params, signerDid, grant) {
      const message = params && params.message ? params.message : void 0;
      if (!message) throw rpcException(-32602, "Invalid parameters", "SendMessageRequest.message is required");
      const text = messageText2(message);
      if (text.length === 0) throw rpcException(-32602, "Invalid parameters", "message.parts must contain at least one text or data part");
      const metadata = params && params.metadata && typeof params.metadata === "object" ? params.metadata : {};
      const from = typeof metadata.from === "string" && metadata.from.length > 0 ? metadata.from : void 0;
      if (from) state.mirrorPeer = from;
      const taskId = `iflow-${uid("task")}`;
      const contextId = typeof message.contextId === "string" && message.contextId.length > 0 ? message.contextId : taskId;
      const task = {
        id: taskId,
        contextId,
        status: { state: "TASK_STATE_SUBMITTED", timestamp: iso() },
        artifacts: [],
        metadata: {
          from: from || "remote",
          machine: typeof metadata.machine === "string" && metadata.machine.length > 0 ? metadata.machine : null,
          prompt: text.slice(0, 400),
          receivedAt: iso(),
          ...signerDid ? { signerDid } : {},
          ...grant ? {
            grantId: grant.grantId,
            grantLevel: grant.level,
            grantAction: grant.action,
            grantDelegate: grant.delegate,
            grantCapabilities: grant.capabilities || [],
            grantIssuerRoot: grant.issuerRoot || null,
            grantRevocationGrace: grant.revocationGrace || 60
          } : {}
        }
      };
      state.tasks.set(taskId, task);
      observeEdge(
        "a2a.request_received",
        (observer) => observer.a2aRequestReceived({
          remoteTaskId: taskId,
          fromLabel: from,
          fromDid: signerDid || void 0,
          grantRef: grant ? grant.grantId : void 0
        })
      );
      const controller = makeAbortController();
      state.outgoing.set(taskId, { controller, done: void 0 });
      const done = runChild(taskId, text, controller, from);
      state.outgoing.get(taskId).done = done;
      done.catch((err) => console.error(`iFlow task ${taskId} unhandled run error`, err));
      const configuration = params && params.configuration ? params.configuration : {};
      if (configuration.returnImmediately === true) return { task: snapshot(taskId, true) };
      await done.catch(() => {
      });
      return { task: snapshot(taskId, true) };
    }
    function handleGetTask(params) {
      const taskId = params && typeof params.id === "string" ? params.id : void 0;
      if (!taskId || !state.tasks.has(taskId)) throw rpcException(-32001, "Task not found", errorInfo("TASK_NOT_FOUND"));
      return { task: snapshot(taskId, true) };
    }
    async function handleCancelTask(params) {
      const taskId = params && typeof params.id === "string" ? params.id : void 0;
      const task = taskId ? state.tasks.get(taskId) : void 0;
      if (!task) throw rpcException(-32001, "Task not found", errorInfo("TASK_NOT_FOUND"));
      if (TERMINAL_TASK_STATES.has(task.status.state)) throw rpcException(-32002, "Task is not cancelable", errorInfo("TASK_NOT_CANCELABLE"));
      const entry = state.outgoing.get(taskId);
      if (entry) {
        entry.controller.abort(new Error("canceled by client"));
        await entry.done.catch(() => {
        });
      } else {
        setStatus(taskId, "TASK_STATE_CANCELED", "The task was canceled.");
      }
      return { task: snapshot(taskId, true) };
    }
    function handleListTasks(params) {
      const filter = params && typeof params.status === "string" ? params.status : void 0;
      const pageSize = params && Number.isInteger(params.pageSize) && params.pageSize >= 1 ? Math.min(params.pageSize, 100) : 50;
      const includeArtifacts = params && typeof params.includeArtifacts === "boolean" ? params.includeArtifacts : false;
      let tasks = [...state.tasks.values()];
      if (filter) tasks = tasks.filter((t) => t.status.state === filter);
      tasks.sort((a, b) => b.status.timestamp < a.status.timestamp ? -1 : b.status.timestamp > a.status.timestamp ? 1 : 0);
      const page = tasks.slice(0, pageSize);
      return { tasks: page.map((t) => snapshot(t.id, includeArtifacts)), nextPageToken: "", pageSize, totalSize: tasks.length };
    }
    async function dispatch(body, signerDid, grant) {
      let request;
      try {
        request = JSON.parse(body);
      } catch (err) {
        return rpcError(null, -32700, "Invalid JSON payload");
      }
      if (typeof request !== "object" || request === null || Array.isArray(request)) return rpcError(null, -32600, "Request payload validation error");
      const { id, method, params } = request;
      if (id === void 0) return null;
      if (typeof method !== "string" || method.length === 0) return rpcError(id, -32600, "Request payload validation error");
      try {
        switch (method) {
          case "SendMessage":
            return rpcResult(id, await handleSendMessage(params, signerDid, grant));
          case "GetTask":
            return rpcResult(id, handleGetTask(params));
          case "CancelTask":
            return rpcResult(id, await handleCancelTask(params));
          case "ListTasks":
            return rpcResult(id, handleListTasks(params));
          case "GetExtendedAgentCard":
            throw rpcException(-32004, "Unsupported operation", errorInfo("UNSUPPORTED_OPERATION"));
          default:
            return rpcError(id, -32601, "Method not found");
        }
      } catch (err) {
        if (err && typeof err.rpcCode === "number") return rpcError(id, err.rpcCode, err.message, err.rpcData);
        console.error(`iFlow rpc ${method} error`, err);
        return rpcError(id, -32603, `Internal error: ${String(err && err.message ? err.message : err)}`);
      }
    }
    const cardHandler = async (req, res) => {
      try {
        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }
        if (req.method !== "GET") {
          sendJson(res, 405, rpcError(null, -32600, "Method not allowed"));
          return;
        }
        const host = req.headers.host || `localhost:${webServer.port}`;
        sendJson(res, 200, await agentCard(host), { "Cache-Control": "max-age=300" });
      } catch (err) {
        console.error("iFlow card handler error", err);
        try {
          sendJson(res, 500, rpcError(null, -32603, "Internal error"));
        } catch (e) {
        }
      }
    };
    let signedCardCache = { at: 0, value: null };
    async function signedAgentCard(hostHeader) {
      const age = Date.now() - signedCardCache.at;
      if (signedCardCache.value && age < 3e5) return signedCardCache.value;
      try {
        const id = await ensureIdentity();
        if (!id.did) {
          signedCardCache = { at: Date.now(), value: { ok: false, error: "no identity" } };
          return signedCardCache.value;
        }
        const card = await agentCard(hostHeader);
        const tmp = scratchPath("card.json");
        const resolved = await ctx.fs.resolve(tmp);
        await ctx.fs.writeText(resolved, JSON.stringify(card));
        const jwsText = await iflowId(["agentcard-sign", tmp], 20);
        const jws = JSON.parse(jwsText);
        const signed = { ok: true, card, jws };
        signedCardCache = { at: Date.now(), value: signed };
        return signed;
      } catch (err) {
        signedCardCache = { at: Date.now(), value: { ok: false, error: String(err && err.message ? err.message : err) } };
        return signedCardCache.value;
      }
    }
    const signedCardHandler = async (req, res) => {
      try {
        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }
        if (req.method !== "GET") {
          sendJson(res, 405, rpcError(null, -32600, "Method not allowed"));
          return;
        }
        const host = req.headers.host || `localhost:${webServer.port}`;
        const signed = await signedAgentCard(host);
        if (!signed.ok) {
          sendJson(res, 501, rpcError(null, -32603, `Signed AgentCard unavailable: ${signed.error}`));
          return;
        }
        sendJson(res, 200, { card: signed.card, jws: signed.jws }, { "Cache-Control": "max-age=300" });
      } catch (err) {
        console.error("iFlow signed card handler error", err);
        try {
          sendJson(res, 500, rpcError(null, -32603, "Internal error"));
        } catch (e) {
        }
      }
    };
    async function verifyInbound(req, body) {
      const header = req.headers["x-iflow-signature"];
      if (!header || typeof header !== "string" || header.length === 0) return { ok: true, did: null };
      let envelope;
      try {
        envelope = JSON.parse(header);
      } catch (e) {
        return { ok: false, did: null, error: "bad envelope json" };
      }
      if (!envelope || typeof envelope !== "object" || !envelope.signature || !envelope.signer) return { ok: false, did: null, error: "incomplete envelope" };
      try {
        const envPath = scratchPath("env.json");
        const resolved = await ctx.fs.resolve(envPath);
        await ctx.fs.writeText(resolved, JSON.stringify(envelope));
        await iflowId(["verify", envPath], 20);
        const sig = envelope.body_sha256;
        if (typeof sig === "string" && sig.length > 0 && sig !== signingDigest(body)) {
          return { ok: false, did: envelope.signer, error: "body digest mismatch" };
        }
        if (typeof envelope.nonce === "string" && typeof envelope.timestamp === "number") {
          await iflowId(["replay-check", envelope.nonce, String(envelope.timestamp)], 20);
        }
        let grant = null;
        const grantHeader = req.headers["x-iflow-grant"];
        if (grantHeader && typeof grantHeader === "string" && grantHeader.length > 0) {
          grant = await verifyGrantHeader(grantHeader, envelope.signer, req, body);
          if (grant && grant.ok === false) return { ok: false, did: envelope.signer, error: `delegation rejected: ${grant.reason}` };
        }
        return { ok: true, did: envelope.signer, grant };
      } catch (err) {
        return { ok: false, did: envelope.signer, error: String(err && err.message ? err.message : err) };
      }
    }
    async function verifyGrantHeader(grantHeader, signerDid, req, body) {
      let payload;
      try {
        payload = JSON.parse(grantHeader);
      } catch (e) {
        return { ok: false, reason: "bad grant json" };
      }
      const grant = payload && payload.grant ? payload.grant : payload;
      if (!grant || !grant.body || !grant.signature || !grant.grant_id) return { ok: false, reason: "incomplete grant" };
      const isIssuer = grant.body.issuer === signerDid;
      const isDelegate = grant.body.delegate === signerDid;
      if (!isIssuer && !isDelegate) return { ok: false, reason: `signer ${signerDid} is neither grant issuer nor delegate` };
      const rawAction = payload.action || "agent-task";
      const action = normalizeAction(rawAction);
      if (!validCapabilityId(action)) return { ok: false, reason: `invalid capability action: ${rawAction}` };
      const level = payload.level || "L0";
      const now = Math.floor(Date.now() / 1e3);
      const grantPath = scratchPath("grant.json");
      const resolved = await ctx.fs.resolve(grantPath);
      await ctx.fs.writeText(resolved, JSON.stringify(grant));
      await iflowId(["grant", "verify", grantPath], 20);
      await iflowId(["grant", "eval", grantPath, action, level, String(now)], 20);
      const capabilities = Array.isArray(grant.body.capabilities) ? grant.body.capabilities.map((c) => c && typeof c.id === "string" ? c.id : "").filter(Boolean) : [];
      return {
        ok: true,
        grantId: grant.grant_id,
        level: grant.body.level,
        action,
        delegate: grant.body.delegate,
        capabilities,
        issuerRoot: grant.body.issuer_root && grant.body.issuer_root.kind ? grant.body.issuer_root.kind : null,
        revocationGrace: grant.body.revocation_grace || 60
      };
    }
    const a2aHandler = async (req, res) => {
      try {
        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, rpcError(null, -32600, "Method not allowed"));
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, rpcError(null, -32e3, "Unauthorized"));
          return;
        }
        const body = await readBody(req);
        const verified = await verifyInbound(req, body);
        if (!verified.ok) {
          sendJson(res, 401, rpcError(null, -32e3, `Signature verification failed: ${verified.error}`));
          return;
        }
        const response = await dispatch(body, verified.did, verified.grant);
        if (response === null) {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }
        sendJson(res, 200, response);
      } catch (err) {
        console.error("iFlow a2a handler error", err);
        try {
          sendJson(res, 500, rpcError(null, -32603, `Internal error: ${String(err && err.message ? err.message : err)}`));
        } catch (e) {
        }
      }
    };
    const versionHandler = async (req, res) => {
      try {
        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }
        if (req.method !== "GET") {
          sendJson(res, 405, rpcError(null, -32600, "Method not allowed"));
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, rpcError(null, -32e3, "Unauthorized"));
          return;
        }
        const src = await readSource();
        sendJson(res, 200, {
          name: state.name,
          version: state.syncVersion,
          updatedAt: state.updatedAt,
          source: sourcePath,
          sha: src.sha,
          size: src.text ? src.text.length : 0
        });
      } catch (err) {
        console.error("iFlow version handler error", err);
        try {
          sendJson(res, 500, rpcError(null, -32603, "Internal error"));
        } catch (e) {
        }
      }
    };
    const latestHandler = async (req, res) => {
      try {
        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders);
          res.end();
          return;
        }
        if (req.method !== "GET") {
          sendJson(res, 405, rpcError(null, -32600, "Method not allowed"));
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, rpcError(null, -32e3, "Unauthorized"));
          return;
        }
        const src = await readSource();
        if (!src.text) {
          sendJson(res, 404, rpcError(null, -32603, "source file not found"));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders });
        res.end(src.text);
      } catch (err) {
        console.error("iFlow latest handler error", err);
        try {
          sendJson(res, 500, rpcError(null, -32603, "Internal error"));
        } catch (e) {
        }
      }
    };
    ctx.effect(() => webServer.register({ kind: "exact", path: "/a2a", handler: a2aHandler }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/.well-known/agent-card.json", handler: cardHandler }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/.well-known/agent.json", handler: cardHandler }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/.well-known/agent-card.signed.json", handler: signedCardHandler }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/iflow/version.json", handler: versionHandler }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/iflow/latest.js", handler: latestHandler }));
    function resolvePeer(input) {
      if (typeof input !== "string" || input.length === 0) return void 0;
      const named = state.peers.get(input);
      if (named) return { url: named.url, token: named.token !== null ? named.token : state.token };
      if (/^https?:\/\//i.test(input)) return { url: input.replace(/\/+$/, ""), token: state.token };
      return void 0;
    }
    async function sleep(ms) {
      await ctx.timeout(ms);
    }
    const peerItem = {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", required: true },
        url: { type: "string", required: true },
        tokenSet: { type: "boolean", required: true },
        healthy: { type: "boolean" },
        lastSeen: { type: "integer" }
      }
    };
    function renderWarnings(warnings) {
      if (!Array.isArray(warnings) || warnings.length === 0) return "";
      return `

warnings:
${warnings.map((w) => `  ! ${w}`).join("\n")}`;
    }
    const tools = [
      defineTool({
        name: "iflow_status",
        description: "iFlow: show the local A2A endpoint (AgentCard and JSON-RPC URLs), auth state, registered peers, sync version, mirror session state, and active inbound tasks.",
        parameters: {},
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              name: { type: "string" },
              version: { type: "string" },
              syncVersion: { type: "string" },
              alias: { type: "string" },
              machine: { type: "string" },
              host: { type: "string" },
              port: { type: "integer" },
              publicUrl: { oneOf: [{ type: "string" }, { type: "null" }] },
              agentCard: { type: "string" },
              rpcEndpoint: { type: "string" },
              updateEndpoint: { type: "string" },
              mirrorSession: { type: "string" },
              authEnabled: { type: "boolean" },
              peers: { type: "array", items: peerItem },
              activeTasks: { type: "integer" },
              warnings: { type: "array", items: { type: "string" } }
            }
          },
          render: (_args, value) => [{
            type: "text",
            text: `iFlow local endpoint:
  AgentCard: ${value.agentCard}
  JSON-RPC: ${value.rpcEndpoint}
  update source: ${value.updateEndpoint}
  syncVersion: ${value.syncVersion}
  mirror session: ${value.mirrorSession}
  alias: ${value.alias}
  machine: ${value.machine}
  auth: ${value.authEnabled ? "enabled" : "off"}
  peers: ${value.peers.map((p) => `${p.name} \u2192 ${p.url}${p.healthy === void 0 ? "" : p.healthy ? " (online)" : " (offline)"}`).join("; ") || "none"}
  active inbound tasks: ${value.activeTasks}${renderWarnings(value.warnings)}`
          }]
        },
        async execute() {
          const base = state.publicUrl || `http://127.0.0.1:${webServer.port}`;
          let mirrorState = "none";
          try {
            mirrorState = ctx.sessions.get("iflow-mirror") ? "created" : "absent";
          } catch (e) {
          }
          for (const [name, entry] of state.peers) await probePeer(name, entry);
          const warnings = [];
          const identity = await getIdentity();
          if (identity.present) {
            warnings.push(".iflow/identity.json holds this node's Ed25519 private key unencrypted (storage: plaintext-dev). Treat the workspace as secret material.");
          }
          if ([...state.peers.values()].some((entry) => entry.token !== null)) {
            warnings.push(".iflow/peers.json stores peer bearer tokens in plaintext.");
          }
          if (webServer.host === "0.0.0.0") {
            warnings.push(
              "This node binds 0.0.0.0, so its A2A and projection endpoints are reachable from the LAN" + (state.token === null ? " WITH NO BEARER TOKEN SET." : ".")
            );
          }
          return {
            warnings,
            ok: true,
            name: state.name,
            version: state.version,
            syncVersion: state.syncVersion,
            alias: state.alias,
            machine: await getMachineName(),
            host: webServer.host,
            port: webServer.port,
            publicUrl: state.publicUrl,
            agentCard: `${base}/.well-known/agent-card.json`,
            rpcEndpoint: `${base}/a2a`,
            updateEndpoint: `${base}/iflow/version.json`,
            mirrorSession: mirrorState,
            authEnabled: state.token !== null,
            peers: [...state.peers.entries()].map(([name, entry]) => ({ name, url: entry.url, tokenSet: entry.token !== null, healthy: entry.healthy, lastSeen: entry.lastSeen })),
            activeTasks: [...state.tasks.values()].filter((t) => !TERMINAL_TASK_STATES.has(t.status.state)).length
          };
        }
      }),
      defineTool({
        name: "iflow_set_alias",
        description: `iFlow: set this machine's display alias (a remark name, not the hostname), attached to outbound SendMessage metadata so the remote can name its incoming sessions (e.g. "iFlow \xB7 <alias>"). Default "if-lt".`,
        parameters: {
          alias: { type: "string", required: true, description: "Display alias, e.g. if-lt or if-dsk." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              alias: { type: "string", required: true }
            }
          },
          render: (_args, value) => [{ type: "text", text: `iFlow alias \u2192 ${value.alias}` }]
        },
        async execute(args) {
          state.alias = typeof args.alias === "string" && args.alias.trim().length > 0 ? args.alias.trim() : "if-lt";
          return { ok: true, alias: state.alias };
        }
      }),
      defineTool({
        name: "iflow_add_peer",
        description: "iFlow: register a remote A2A endpoint (typically another DSH machine running iFlow) so it can be called by name. Pass the base URL of the remote web server, e.g. http://192.168.1.20:3080. Optionally set the same shared token configured on the remote (iflow_set_token there).",
        parameters: {
          name: { type: "string", required: true, description: "Local alias for the peer." },
          url: { type: "string", required: true, description: "Base URL of the remote DSH web server, e.g. http://192.168.1.20:3080." },
          token: { type: "string", description: "Optional Bearer token the remote requires; defaults to the local shared token when unset." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              name: { type: "string", required: true },
              url: { type: "string", required: true },
              tokenSet: { type: "boolean", required: true }
            }
          },
          render: (_args, value) => [{ type: "text", text: `peer ${value.name} \u2192 ${value.url} (${value.tokenSet ? "token set" : "no token"})` }]
        },
        async execute(args) {
          await peersReady;
          const name = args.name.trim();
          const url = args.url.trim().replace(/\/+$/, "");
          state.peers.set(name, { url, token: typeof args.token === "string" && args.token.length > 0 ? args.token : null, addedAt: iso() });
          await savePeers();
          probePeer(name, state.peers.get(name));
          return { ok: true, name, url, tokenSet: state.peers.get(name).token !== null };
        }
      }),
      defineTool({
        name: "iflow_list_peers",
        description: "iFlow: list registered remote peers (name, base URL, whether a token is set).",
        parameters: {},
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              peers: { type: "array", items: peerItem, required: true }
            }
          },
          render: (_args, value) => [{
            type: "text",
            text: value.peers.length === 0 ? "no peers registered" : value.peers.map((p) => `- ${p.name} \u2192 ${p.url}${p.tokenSet ? " (token)" : ""}${p.healthy === void 0 ? "" : p.healthy ? " (online)" : " (offline)"}`).join("\n")
          }]
        },
        async execute() {
          return {
            ok: true,
            peers: [...state.peers.entries()].map(([name, entry]) => ({ name, url: entry.url, tokenSet: entry.token !== null, healthy: entry.healthy, lastSeen: entry.lastSeen }))
          };
        }
      }),
      defineTool({
        name: "iflow_remove_peer",
        description: "iFlow: remove a registered peer by name.",
        parameters: {
          name: { type: "string", required: true, description: "Alias of the peer to remove." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              name: { type: "string", required: true }
            }
          },
          render: (_args, value) => [{ type: "text", text: `peer ${value.name} ${value.ok ? "removed" : "not found"}` }]
        },
        async execute(args) {
          await peersReady;
          const removed = state.peers.delete(args.name.trim());
          await savePeers();
          return { ok: removed, name: args.name.trim() };
        }
      }),
      defineTool({
        name: "iflow_discover",
        description: "iFlow: fetch the AgentCard of a peer (by registered name or base URL) to learn its identity, capabilities, interface, and skills.",
        parameters: {
          peer: { type: "string", required: true, description: "Registered peer name or a base URL like http://192.168.1.20:3080." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              name: { type: "string" },
              description: { type: "string" },
              version: { type: "string" },
              interfaceUrl: { type: "string" },
              protocolBinding: { type: "string" },
              skills: { type: "array", items: { type: "string" } },
              error: { type: "string" }
            }
          },
          render: (_args, value) => [{
            type: "text",
            text: value.ok ? `AgentCard: ${value.name} v${value.version}
  ${value.description}
  interface: ${value.interfaceUrl} (${value.protocolBinding})
  skills: ${value.skills.join(", ")}` : `discovery failed: ${value.error}`
          }]
        },
        async execute(args) {
          const entry = resolvePeer(args.peer);
          if (!entry) return { ok: false, error: `unknown peer or invalid URL: ${args.peer}` };
          try {
            const text = await curlGet(`${entry.url}/.well-known/agent-card.json`, 15, entry.token);
            const card = JSON.parse(text);
            const iface = card.supportedInterfaces && card.supportedInterfaces.length > 0 ? card.supportedInterfaces[0] : {};
            return {
              ok: true,
              name: typeof card.name === "string" ? card.name : entry.url,
              description: typeof card.description === "string" ? card.description : "",
              version: typeof card.version === "string" ? card.version : "",
              interfaceUrl: typeof iface.url === "string" ? iface.url : `${entry.url}/a2a`,
              protocolBinding: typeof iface.protocolBinding === "string" ? iface.protocolBinding : "JSONRPC",
              skills: Array.isArray(card.skills) ? card.skills.map((s) => s && typeof s.name === "string" ? s.name : "").filter(Boolean) : []
            };
          } catch (err) {
            return { ok: false, error: `discovery failed: ${String(err && err.message ? err.message : err)}` };
          }
        }
      }),
      defineTool({
        name: "iflow_update_check",
        description: "iFlow: compare the local iFlow source with a peer's self-hosted update source (/iflow/version.json) and report whether they are in sync and whether a pull is available.",
        parameters: {
          peer: { type: "string", required: true, description: "Registered peer name or a base URL like http://192.168.1.20:3080." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              peer: { type: "string" },
              localVersion: { type: "string" },
              remoteVersion: { type: "string" },
              localSha: { type: "string" },
              remoteSha: { type: "string" },
              inSync: { type: "boolean" },
              canPull: { type: "boolean" },
              error: { type: "string" }
            }
          },
          render: (_args, value) => [{
            type: "text",
            text: value.ok ? value.inSync ? `iFlow \u4E24\u7AEF\u540C\u6B65 \u2713 (v${value.localVersion}, sha ${value.localSha})` : `iFlow \u4E0D\u540C\u6B65\uFF1A\u672C\u673A v${value.localVersion} (${value.localSha}) vs ${value.peer} v${value.remoteVersion} (${value.remoteSha}) \u2014 \u53EF\u7528 iflow_pull \u62C9\u53D6` : `update check failed: ${value.error}`
          }]
        },
        async execute(args) {
          const entry = resolvePeer(args.peer);
          if (!entry) return { ok: false, error: `unknown peer or invalid URL: ${args.peer}` };
          try {
            const text = await curlGet(`${entry.url}/iflow/version.json`, 15, entry.token);
            const remote = JSON.parse(text);
            const local = await readSource();
            const same = remote.version === state.syncVersion && remote.sha === local.sha;
            return {
              ok: true,
              peer: args.peer,
              localVersion: state.syncVersion,
              remoteVersion: typeof remote.version === "string" ? remote.version : "",
              localSha: local.sha,
              remoteSha: typeof remote.sha === "string" ? remote.sha : "",
              inSync: same,
              canPull: allowPeerUpdate && !same
            };
          } catch (err) {
            return { ok: false, peer: args.peer, error: `check failed: ${String(err && err.message ? err.message : err)}` };
          }
        }
      }),
      defineTool({
        name: "iflow_pull",
        description: "iFlow: pull the latest iFlow source from a peer's self-hosted update source (/iflow/latest.js) into this development worktree. Disabled for a release worktree; restart the plugin after a successful pull.",
        parameters: {
          peer: { type: "string", required: true, description: "Registered peer name or a base URL like http://192.168.1.20:3080." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              peer: { type: "string" },
              version: { type: "string" },
              sha: { type: "string" },
              bytes: { type: "integer" },
              path: { type: "string" },
              error: { type: "string" }
            }
          },
          render: (_args, value) => [{
            type: "text",
            text: value.ok ? `\u5DF2\u4ECE ${value.peer} \u62C9\u53D6 iFlow v${value.version} (${value.bytes} bytes, sha ${value.sha}) \u2192 ${value.path}
\u6CE8\u610F\uFF1A\u65B0\u4EE3\u7801\u9700\u91CD\u65B0\u52A0\u8F7D\u63D2\u4EF6\u624D\u751F\u6548\uFF08\u52A8\u6001: cordis_define + cordis_run\uFF1B\u9759\u6001: \u91CD\u65B0\u6253\u5305\u91CD\u542F\uFF09` : `pull failed: ${value.error}`
          }]
        },
        async execute(args) {
          const entry = resolvePeer(args.peer);
          if (!entry) return { ok: false, error: `unknown peer or invalid URL: ${args.peer}` };
          if (!allowPeerUpdate) return { ok: false, peer: args.peer, error: "peer source updates are disabled for this release worktree; update the checked-out Git tag instead" };
          try {
            const text = await curlGet(`${entry.url}/iflow/latest.js`, 30, entry.token);
            const trimmed = text.trimStart();
            if (!trimmed.startsWith("import ") && !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("return {")) {
              return { ok: false, peer: args.peer, error: `refused to write: /iflow/latest.js did not return JS source (got ${JSON.stringify(text.slice(0, 60))}\u2026). The peer may not be upgraded to v10+.` };
            }
            const target = await ctx.fs.resolve(sourcePath);
            await ctx.fs.writeText(target, text);
            return {
              ok: true,
              peer: args.peer,
              version: state.syncVersion,
              sha: simpleHash(text),
              bytes: text.length,
              path: sourcePath
            };
          } catch (err) {
            return { ok: false, peer: args.peer, error: `pull failed: ${String(err && err.message ? err.message : err)}` };
          }
        }
      }),
      defineTool({
        name: "iflow_send",
        description: "iFlow: send a task to a remote A2A agent (by registered peer name or base URL). The remote runs the prompt as a full agent with its own tools and returns its final answer. Waits for completion by default (polling GetTask); set waitForCompletion=false to just start the task.",
        parameters: {
          peer: { type: "string", required: true, description: "Registered peer name or a base URL like http://192.168.1.20:3080." },
          prompt: { type: "string", required: true, description: "The task description to send to the remote agent." },
          waitForCompletion: { type: "boolean", description: "Wait for the remote task to finish and return its answer. Default true." },
          maxWaitSeconds: { type: "integer", description: "Cap on how long to wait for completion. Default 600 (10 minutes), max 3600." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              peer: { type: "string", required: true },
              taskId: { type: "string" },
              state: { type: "string" },
              text: { type: "string" },
              error: { type: "string" }
            }
          },
          render: (_args, value) => [{
            type: "text",
            text: value.ok ? value.taskId ? `remote task ${value.taskId} finished (${value.state}):
${value.text}` : `remote message:
${value.text}` : `iFlow call failed: ${value.error}`
          }]
        },
        async execute(args) {
          const entry = resolvePeer(args.peer);
          if (!entry) return { ok: false, peer: args.peer, error: `unknown peer or invalid URL: ${args.peer}` };
          state.mirrorPeer = args.peer;
          const base = entry.url;
          const token = entry.token;
          const rpc = (method, params) => curlPost(`${base}/a2a`, { jsonrpc: "2.0", id: uid("req"), method, params }, 60, token);
          try {
            const mb = await loadMailbox();
            let dirty = false;
            for (const item of mb.outbox) {
              if (item.peer !== args.peer || item.state !== "queued") continue;
              const r = await rpc("SendMessage", {
                message: { messageId: uid("msg"), role: "ROLE_USER", parts: [{ text: item.prompt, mediaType: "text/plain" }] },
                configuration: { returnImmediately: true, historyLength: 0 },
                metadata: { from: state.alias, machine: await getMachineName() }
              });
              item.attempts += 1;
              item.lastAttempt = Date.now();
              if (!r.error) item.state = "delivered";
              dirty = true;
            }
            if (dirty) await saveMailbox(mb);
          } catch (err) {
          }
          let response;
          try {
            response = await rpc("SendMessage", {
              message: { messageId: uid("msg"), role: "ROLE_USER", parts: [{ text: args.prompt, mediaType: "text/plain" }] },
              configuration: { returnImmediately: true, historyLength: 0 },
              metadata: { from: state.alias, machine: await getMachineName() }
            });
          } catch (err) {
            try {
              await enqueueOut(args.peer, args.prompt);
            } catch (e) {
            }
            return { ok: false, peer: args.peer, taskId: "", state: "QUEUED", error: `peer offline; queued for redelivery: ${String(err && err.message ? err.message : err)}` };
          }
          if (response.error) return { ok: false, peer: args.peer, error: `remote error ${response.error.code}: ${response.error.message}` };
          const result = response.result || {};
          const task = result.task;
          try {
            await mirrorAppend("self", args.prompt, `[agent:${state.alias}]`);
          } catch (e) {
          }
          if (!task) {
            const text2 = result.message ? partsText(result.message.parts) : "";
            if (text2.length > 0) try {
              await mirrorAppend("remote", text2, `[agent:${args.peer}]`);
            } catch (e) {
            }
            return {
              ok: text2.length > 0,
              peer: args.peer,
              taskId: "",
              state: "MESSAGE",
              text: text2,
              ...text2.length === 0 ? { error: "remote returned an empty message" } : {}
            };
          }
          if (args.waitForCompletion === false) return { ok: true, peer: args.peer, taskId: task.id, state: task.status.state, text: "" };
          if (TERMINAL_TASK_STATES.has(task.status.state)) {
            const text2 = taskText(task);
            if (text2.length > 0) try {
              await mirrorAppend("remote", text2, `[agent:${args.peer}]`);
            } catch (e) {
            }
            return {
              ok: task.status.state === "TASK_STATE_COMPLETED" && text2.length > 0,
              peer: args.peer,
              taskId: task.id,
              state: task.status.state,
              text: text2,
              ...text2.length === 0 ? { error: `task ended in ${task.status.state} with no output` } : {}
            };
          }
          const maxWait = Math.min(Math.max(Number(args.maxWaitSeconds) || 600, 1), 3600);
          const deadline = Date.now() + maxWait * 1e3;
          let stateName = task.status.state;
          let finalTask = task;
          while (!TERMINAL_TASK_STATES.has(stateName) && Date.now() < deadline) {
            await sleep(2e3);
            try {
              const poll = await rpc("GetTask", { id: task.id });
              if (poll.error) return { ok: false, peer: args.peer, taskId: task.id, state: stateName, error: `GetTask error ${poll.error.code}: ${poll.error.message}` };
              if (poll.result && poll.result.task) {
                finalTask = poll.result.task;
                stateName = finalTask.status.state;
              }
            } catch (err) {
              return { ok: false, peer: args.peer, taskId: task.id, state: stateName, error: `GetTask failed: ${String(err && err.message ? err.message : err)}` };
            }
          }
          if (!TERMINAL_TASK_STATES.has(stateName)) return { ok: false, peer: args.peer, taskId: task.id, state: stateName, error: `timed out waiting for task ${task.id}` };
          const text = taskText(finalTask);
          if (text.length > 0) try {
            await mirrorAppend("remote", text, `[${args.peer}]`);
          } catch (e) {
          }
          return {
            ok: stateName === "TASK_STATE_COMPLETED" && text.length > 0,
            peer: args.peer,
            taskId: task.id,
            state: stateName,
            text,
            ...text.length === 0 ? { error: `task ended in ${stateName} with no output` } : {}
          };
        }
      }),
      defineTool({
        name: "iflow_set_token",
        description: "iFlow: set (or clear, with an empty string) the shared Bearer token protecting this machine's A2A endpoint. All inbound requests must then send Authorization: Bearer <token>, and outbound calls automatically attach it. Set the SAME token on every peer for mutual auth.",
        parameters: {
          token: { type: "string", required: true, description: "Shared secret. Pass an empty string to clear auth." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              authEnabled: { type: "boolean", required: true }
            }
          },
          render: (_args, value) => [{ type: "text", text: `iFlow auth ${value.authEnabled ? "enabled" : "disabled"}` }]
        },
        async execute(args) {
          state.token = typeof args.token === "string" && args.token.length > 0 ? args.token : null;
          return { ok: true, authEnabled: state.token !== null };
        }
      }),
      defineTool({
        name: "iflow_set_public_url",
        description: "iFlow: override the base URL advertised in the local AgentCard (e.g. a tunnel or LAN hostname). Pass an empty string to go back to deriving it from each request's Host header.",
        parameters: {
          url: { type: "string", required: true, description: "Public base URL, e.g. https://iflow.example.com. Empty string clears the override." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              publicUrl: { oneOf: [{ type: "string" }, { type: "null" }] }
            }
          },
          render: (_args, value) => [{ type: "text", text: `iFlow public URL ${value.publicUrl ? `\u2192 ${value.publicUrl}` : "cleared (Host header based)"}` }]
        },
        async execute(args) {
          state.publicUrl = typeof args.url === "string" && args.url.trim().length > 0 ? args.url.trim().replace(/\/+$/, "") : null;
          return { ok: true, publicUrl: state.publicUrl };
        }
      }),
      defineTool({
        name: "iflow_identity",
        description: "iFlow (P1 trust root): show the local did:key identity and, optionally, create one if missing. Also verifies a peer's signed AgentCard from /.well-known/agent-card.signed.json to confirm it was published by that peer's declared did.",
        parameters: {
          action: { type: "string", description: "One of: status (default), ensure (create if missing), verifyPeer (peer name or base URL to verify its signed AgentCard)." },
          peer: { type: "string", description: "Peer name or base URL, required when action=verifyPeer." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              did: { oneOf: [{ type: "string" }, { type: "null" }] },
              label: { type: "string" },
              storage: { type: "string" },
              created: { type: "boolean" },
              verifiedPeer: { oneOf: [{ type: "string" }, { type: "null" }] },
              peerDid: { oneOf: [{ type: "string" }, { type: "null" }] },
              error: { type: "string" }
            }
          },
          render: (_args, value) => [{
            type: "text",
            text: value.error ? `iflow identity: ${value.error}` : value.verifiedPeer ? `peer ${value.verifiedPeer} signed AgentCard verified \u2192 ${value.peerDid || "unknown did"}` : `iFlow identity: ${value.did || "none"} (label ${value.label}, storage ${value.storage || "n/a"})${value.created ? " \u2014 created now" : ""}`
          }]
        },
        async execute(args) {
          const action = typeof args.action === "string" ? args.action : "status";
          try {
            if (action === "ensure") {
              const id2 = await ensureIdentity();
              if (!id2.did) return { ok: false, did: null, label: state.alias, error: "failed to create identity (iflow-id binary?)" };
              return { ok: true, did: id2.did, label: id2.label, storage: "plaintext-dev", created: true };
            }
            if (action === "verifyPeer") {
              const entry = resolvePeer(args.peer);
              if (!entry) return { ok: false, error: `unknown peer or invalid URL: ${args.peer}` };
              const text = await curlGet(`${entry.url}/.well-known/agent-card.signed.json`, 15, entry.token);
              const signed = JSON.parse(text);
              const jws = signed && signed.jws ? signed.jws : signed;
              if (!jws || !jws.signer) return { ok: false, error: "peer did not return a signed AgentCard (needs v18+)" };
              const tmp = scratchPath("peer-card.json");
              const resolved = await ctx.fs.resolve(tmp);
              await ctx.fs.writeText(resolved, JSON.stringify(jws));
              await iflowId(["agentcard-verify", tmp], 20);
              return { ok: true, verifiedPeer: args.peer, peerDid: typeof jws.signer === "string" ? jws.signer : jws.signer && jws.signer.did ? jws.signer.did : String(jws.signer) };
            }
            const id = await getIdentity();
            if (!id.did) return { ok: false, did: null, label: state.alias, error: "no identity yet (run action=ensure to create)" };
            return { ok: true, did: id.did, label: id.label, storage: "plaintext-dev" };
          } catch (err) {
            return { ok: false, did: null, label: state.alias, error: String(err && err.message ? err.message : err) };
          }
        }
      }),
      defineTool({
        name: "iflow_grant",
        description: "iFlow (P2 delegation): issue, verify, eval, revoke, or check a delegation grant \u2014 a human's signed authorization that an agent may act on their behalf for a scoped set of capabilities up to a trust level (L0-L3). Levels: L0 dialogue/quote (pre-authorized), L1 transaction (auto within scope), L2 contract (grant + explicit flag), L3 major (human must authorize in person). V20: grants carry a namespace-prefixed capability set (iflow.cap:<domain>.<op>) and a signature-root strength that bounds the level (H1\u2192L0, H2\u2192L2, H3\u2192L3); revoke records a check-at-use revocation.",
        parameters: {
          action: { type: "string", required: true, description: "One of: create | verify | eval | revoke | status." },
          delegate: { type: "string", description: "Delegate did:key (required for create)." },
          scope: { type: "string", description: 'Comma-separated business scope (optional for create), e.g. "dialogue,quote".' },
          capabilities: { type: "string", description: 'Comma-separated namespace capability IDs (optional for create), e.g. "iflow.cap:agent.run,iflow.cap:fs.read".' },
          deny: { type: "string", description: "Comma-separated capability IDs to deny (optional for create)." },
          root: { type: "string", description: "Issuer root kind for create: agent-custodial | webauthn | hwkey | ca | kyc (caps the level; default agent-custodial = L0)." },
          issuerKind: { type: "string", description: "Issuer subject kind for create: agent | human (optional)." },
          nonce: { type: "string", description: "Fresh challenge bound to the signing moment (optional for create)." },
          level: { type: "string", description: "Trust level L0-L3 (required for create and eval)." },
          expiresAt: { type: "integer", description: "Unix expiry seconds (required for create)." },
          budget: { type: "integer", description: "Optional budget cap for create." },
          label: { type: "string", description: "Optional human label for create." },
          grant: { type: "string", description: "Grant JSON string or path (required for verify and eval)." },
          grantId: { type: "string", description: "Grant id (required for revoke and status)." },
          actionScope: { type: "string", description: "The capability ID being evaluated (required for eval)." },
          now: { type: "integer", description: "Current unix seconds (optional for eval; default now)." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              grantId: { type: "string" },
              issuer: { type: "string" },
              delegate: { type: "string" },
              level: { type: "string" },
              scope: { type: "array", items: { type: "string" } },
              capabilities: { type: "array", items: { type: "string" } },
              issuerRoot: { type: "string" },
              expiresAt: { type: "integer" },
              granted: { type: "boolean" },
              error: { type: "string" },
              revokeStatus: { type: "string" },
              grantJson: { type: "string" }
            }
          },
          render: (_args, value) => [{
            type: "text",
            text: value.error ? `iflow grant: ${value.error}` : value.granted ? `grant issued \u2713 (grant_id ${value.grantId}, level ${value.level}, delegate ${value.delegate})
  issuer: ${value.issuer}
  capabilities: ${(value.capabilities || []).join(", ")}
  scope: ${(value.scope || []).join(", ")}
  issuerRoot: ${value.issuerRoot || "(none)"}
  expires: ${value.expiresAt}` : value.revokeStatus ? `grant ${value.grantId}: ${value.revokeStatus}` : `grant verified \u2713 (grant_id ${value.grantId}, issuer ${value.issuer}, delegate ${value.delegate}, level ${value.level})`
          }]
        },
        async execute(args) {
          const action = typeof args.action === "string" ? args.action : "";
          try {
            if (action === "create") {
              if (!args.delegate || !args.level || typeof args.expiresAt !== "number") return { ok: false, error: "create needs delegate, level, expiresAt" };
              const grantArgs = ["grant", "create", args.delegate, args.scope || "", String(args.level), String(args.expiresAt)];
              if (typeof args.budget === "number") grantArgs.push("--budget", String(args.budget));
              if (typeof args.label === "string" && args.label.length > 0) grantArgs.push("--label", args.label);
              if (typeof args.capabilities === "string" && args.capabilities.length > 0) grantArgs.push("--capabilities", args.capabilities);
              if (typeof args.deny === "string" && args.deny.length > 0) grantArgs.push("--deny", args.deny);
              if (typeof args.root === "string" && args.root.length > 0) grantArgs.push("--root", args.root);
              if (typeof args.issuerKind === "string" && args.issuerKind.length > 0) grantArgs.push("--issuer-kind", args.issuerKind);
              if (typeof args.nonce === "string" && args.nonce.length > 0) grantArgs.push("--nonce", args.nonce);
              const out = await iflowId(grantArgs, 20);
              const grant = JSON.parse(out);
              return {
                ok: true,
                granted: true,
                grantId: grant.grant_id,
                issuer: grant.body.issuer,
                delegate: grant.body.delegate,
                level: grant.body.level,
                scope: grant.body.scope,
                capabilities: Array.isArray(grant.body.capabilities) ? grant.body.capabilities.map((c) => c && c.id || "").filter(Boolean) : [],
                issuerRoot: grant.body.issuer_root && grant.body.issuer_root.kind ? grant.body.issuer_root.kind : null,
                expiresAt: grant.body.expires_at,
                grantJson: out
              };
            }
            if (action === "verify") {
              if (!args.grant) return { ok: false, error: "verify needs grant (JSON string or path)" };
              const g = await writeGrantTemp(args.grant);
              await iflowId(["grant", "verify", g], 20);
              const parsed = typeof args.grant === "string" && args.grant.trimStart().startsWith("{") ? JSON.parse(args.grant) : null;
              return { ok: true, grantId: parsed ? parsed.grant_id : null, issuer: parsed ? parsed.body.issuer : null, delegate: parsed ? parsed.body.delegate : null, level: parsed ? parsed.body.level : null };
            }
            if (action === "eval") {
              if (!args.grant || !args.actionScope || !args.level) return { ok: false, error: "eval needs grant, actionScope, level" };
              const g = await writeGrantTemp(args.grant);
              const now = typeof args.now === "number" ? String(args.now) : String(Math.floor(Date.now() / 1e3));
              await iflowId(["grant", "eval", g, args.actionScope, String(args.level), now], 20);
              const parsed = typeof args.grant === "string" && args.grant.trimStart().startsWith("{") ? JSON.parse(args.grant) : null;
              return { ok: true, grantId: parsed ? parsed.grant_id : null, issuer: parsed ? parsed.body.issuer : null, delegate: parsed ? parsed.body.delegate : null, level: parsed ? parsed.body.level : null };
            }
            if (action === "revoke") {
              if (!args.grantId) return { ok: false, error: "revoke needs grantId" };
              await iflowId(["grant", "revoke", args.grantId], 20);
              return { ok: true, grantId: args.grantId, revokeStatus: "revoked" };
            }
            if (action === "status") {
              if (!args.grantId) return { ok: false, error: "status needs grantId" };
              const out = await iflowId(["grant", "status", args.grantId], 20);
              const m = /: (.*)$/.exec(out.trim());
              return { ok: true, grantId: args.grantId, revokeStatus: m ? m[1] : out.trim() };
            }
            return { ok: false, error: `unknown action: ${action}` };
          } catch (err) {
            return { ok: false, error: String(err && err.message ? err.message : err) };
          }
        }
      }),
      defineTool({
        name: "iflow_usage",
        description: "iFlow (token metering): record a task's token usage and cost, or aggregate the usage log into a cost report. Usage comes from DSH's TokenUsage; cost is read from ~/.iflow/pricing.json (per-million-token model prices). Economic fields (cost, fingerprint) are recorded now so the P3 economy layer can consume them.",
        parameters: {
          action: { type: "string", required: true, description: "One of: record | report." },
          taskId: { type: "string", description: "Task id (required for record, used as the idempotency key)." },
          from: { type: "string", description: "Initiating did:key (required for record)." },
          model: { type: "string", description: "Model that served the task (required for record)." },
          inputTokens: { type: "integer", description: "Uncached input tokens (required for record)." },
          outputTokens: { type: "integer", description: "Output tokens (required for record)." },
          cacheReadTokens: { type: "integer", description: "Cache-hit input tokens (optional, default 0)." },
          cacheWriteTokens: { type: "integer", description: "Cache-write input tokens (optional, default 0)." },
          durationMs: { type: "integer", description: "Task duration in ms (optional)." },
          reportFrom: { type: "string", description: "Filter report to this did (optional)." },
          reportModel: { type: "string", description: "Filter report to this model (optional)." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              tasks: { type: "integer" },
              tokens: { type: "integer" },
              inputTokens: { type: "integer" },
              outputTokens: { type: "integer" },
              cacheReadTokens: { type: "integer" },
              cacheWriteTokens: { type: "integer" },
              totalCost: { type: "number" },
              fingerprint: { type: "string" },
              byModel: { type: "array", items: { type: "object", additionalProperties: false, properties: { model: { type: "string" }, tasks: { type: "integer" }, tokens: { type: "integer" }, cost: { type: "number" } } } },
              byFrom: { type: "array", items: { type: "object", additionalProperties: false, properties: { from: { type: "string" }, tasks: { type: "integer" }, tokens: { type: "integer" }, cost: { type: "number" } } } },
              error: { type: "string" }
            }
          },
          render: (_args, value) => [{
            type: "text",
            text: value.error ? `iflow usage: ${value.error}` : value.fingerprint ? `usage recorded \u2713 (${value.tokens} tokens, cost $${Number(value.totalCost || 0).toFixed(8)}, fingerprint ${value.fingerprint})` : `usage report (${value.tasks} tasks): ${value.tokens} tokens (in ${value.inputTokens}, out ${value.outputTokens}, cr ${value.cacheReadTokens}, cw ${value.cacheWriteTokens}), total cost $${Number(value.totalCost || 0).toFixed(8)}`
          }]
        },
        async execute(args) {
          const action = typeof args.action === "string" ? args.action : "";
          try {
            if (action === "record") {
              if (!args.taskId || !args.from || !args.model || typeof args.inputTokens !== "number" || typeof args.outputTokens !== "number") return { ok: false, error: "record needs taskId, from, model, inputTokens, outputTokens" };
              const rec = ["usage", "record", args.taskId, args.from, args.model, String(args.inputTokens), String(args.outputTokens)];
              if (typeof args.cacheReadTokens === "number") rec.push("--cache-read", String(args.cacheReadTokens));
              if (typeof args.cacheWriteTokens === "number") rec.push("--cache-write", String(args.cacheWriteTokens));
              if (typeof args.durationMs === "number") rec.push("--duration", String(args.durationMs));
              const out = await iflowId(rec, 20);
              const fpMatch = /fingerprint: (\S+)/.exec(out);
              const costMatch = /cost \$([0-9.]+)/.exec(out);
              const tokMatch = /: (\d+) tokens \(in (\d+), out (\d+), cr (\d+), cw (\d+)\)/.exec(out);
              observeEdge(
                "usage.recorded",
                (observer) => observer.usageRecorded({
                  taskId: args.taskId,
                  model: args.model,
                  tokens: {
                    input: args.inputTokens,
                    output: args.outputTokens,
                    cacheRead: typeof args.cacheReadTokens === "number" ? args.cacheReadTokens : 0,
                    cacheWrite: typeof args.cacheWriteTokens === "number" ? args.cacheWriteTokens : 0
                  },
                  costMicros: Math.round((costMatch ? Number(costMatch[1]) : 0) * 1e6),
                  priceSource: "pricing.json"
                })
              );
              return {
                ok: true,
                fingerprint: fpMatch ? fpMatch[1] : null,
                tasks: 1,
                tokens: tokMatch ? Number(tokMatch[1]) : 0,
                inputTokens: tokMatch ? Number(tokMatch[2]) : 0,
                outputTokens: tokMatch ? Number(tokMatch[3]) : 0,
                cacheReadTokens: tokMatch ? Number(tokMatch[4]) : 0,
                cacheWriteTokens: tokMatch ? Number(tokMatch[5]) : 0,
                totalCost: costMatch ? Number(costMatch[1]) : 0
              };
            }
            if (action === "report") {
              const rep = ["usage", "report"];
              if (args.reportFrom) rep.push("--from", args.reportFrom);
              if (args.reportModel) rep.push("--model", args.reportModel);
              const out = await iflowId(rep, 20);
              const tasksMatch = /tasks:\s*(\d+)/.exec(out);
              const tokensMatch = /tokens:\s*(\d+)/.exec(out);
              const costMatch = /total cost:\s*\$([0-9.]+)/.exec(out);
              const inMatch = /in (\d+)/.exec(out);
              const outMatch = /out (\d+)/.exec(out);
              const crMatch = /cr (\d+)/.exec(out);
              const cwMatch = /cw (\d+)/.exec(out);
              return {
                ok: true,
                tasks: tasksMatch ? Number(tasksMatch[1]) : 0,
                tokens: tokensMatch ? Number(tokensMatch[1]) : 0,
                inputTokens: inMatch ? Number(inMatch[1]) : 0,
                outputTokens: outMatch ? Number(outMatch[1]) : 0,
                cacheReadTokens: crMatch ? Number(crMatch[1]) : 0,
                cacheWriteTokens: cwMatch ? Number(cwMatch[1]) : 0,
                totalCost: costMatch ? Number(costMatch[1]) : 0
              };
            }
            return { ok: false, error: `unknown action: ${action}` };
          } catch (err) {
            return { ok: false, error: String(err && err.message ? err.message : err) };
          }
        }
      })
    ];
    async function writeGrantTemp(grant) {
      let text = grant;
      if (typeof grant === "string" && !grant.trimStart().startsWith("{")) {
        text = await ctx.fs.readText(await ctx.fs.resolve(grant));
      }
      const p = scratchPath("grant-tool.json");
      const resolved = await ctx.fs.resolve(p);
      await ctx.fs.writeText(resolved, text);
      return p;
    }
    for (const tool of tools) ctx.tools.register(tool);
    let edgeHandle = null;
    function observeEdge(what, use) {
      if (!edgeHandle) return;
      try {
        const result = use(edgeHandle.edge.observer);
        if (result && typeof result.catch === "function") {
          result.catch((err) => console.error(`iFlow: could not journal ${what}`, err));
        }
      } catch (err) {
        console.error(`iFlow: could not journal ${what}`, err);
      }
    }
    void (async () => {
      try {
        const identity = await getIdentity();
        edgeHandle = await installIFlowEdge(ctx, {
          workspace,
          alias: state.alias,
          version: state.syncVersion,
          did: identity.did,
          // A getter, not the value: the token can change after this call.
          token: () => state.token,
          capabilities: ["iflow.cap:task.run", "iflow.cap:tool.call", "iflow.cap:a2a.receive"],
          // The edge signs through the same binary the rest of the plugin uses,
          // so there is exactly one place that holds key material.
          runIflowId: (args) => iflowId(args),
          writeScratch: async (name, bytes) => {
            const path = scratchPath(name);
            writeFileSync2(path, Buffer.from(bytes));
            return path;
          },
          allowedOrigins: config.hubOrigins ?? ["http://127.0.0.1:5174", "http://localhost:5174"],
          // Both default to off: a Hub can read this node's projections out of
          // the box, but it cannot cause work here until an operator says so.
          acceptCommands: config.acceptCommands === true,
          routeApprovals: config.routeApprovals === true
        });
        console.log(`iFlow edge ready: node ${edgeHandle.nodeId}, journal .iflow/edge/origin.ndjson, projections on /iflow/projection/*`);
      } catch (err) {
        console.error("iFlow edge failed to start (A2A bridge is unaffected):", err && err.message ? err.message : err);
      }
    })();
    ctx.effect(() => () => {
      if (edgeHandle) edgeHandle.dispose();
    });
    console.log(`iFlow A2A bridge ready (v${state.syncVersion}): /a2a on port ${webServer.port}, alias ${state.alias}, mirror on, update source ${sourcePath}, auth ${state.token === null ? "off" : "on"}`);
  }
};
export {
  index_default as default
};
