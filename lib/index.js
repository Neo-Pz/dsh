// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// ../iflowone/packages/iflow-protocol/dist/index.js
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
var EVENT_SCHEMA_VERSION = 2;
var ISSUER_KINDS = /* @__PURE__ */ new Set(["agent", "human", "system"]);
var SUBJECT_KINDS = /* @__PURE__ */ new Set(["agent", "goal", "task", "room", "artifact", "conversation"]);
var EVIDENCE_SOURCES = /* @__PURE__ */ new Set(["dsh", "a2a", "user", "projection"]);
var VISIBILITIES = /* @__PURE__ */ new Set(["local", "public"]);
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
  check.string(event.principalId, "principalId", { required: false });
  check.timestamp(event.occurredAt, "occurredAt");
  check.timestamp(event.observedAt, "observedAt", { required: false });
  if (typeof event.schemaVersion !== "number" || !Number.isInteger(event.schemaVersion) || event.schemaVersion < 1) {
    check.fail("schemaVersion", "must be a positive integer");
  }
  if ((event.schemaVersion ?? 0) >= 2 || event.visibility !== void 0) {
    check.enum(event.visibility, "visibility", VISIBILITIES);
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
  for (const key of ["goalId", "taskId", "roomId", "conversationId"]) {
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
function checkPrivateRouting(check, routing, required, timestamps) {
  if (!check.object(routing, "routing")) return false;
  for (const key of required) check.string(routing[key], `routing.${key}`);
  for (const key of timestamps) check.timestamp(routing[key], `routing.${key}`);
  const issuedAt = routing["issuedAt"];
  const expiresAt = routing["expiresAt"];
  if (typeof issuedAt === "string" && typeof expiresAt === "string" && ISO_8601.test(issuedAt) && ISO_8601.test(expiresAt) && Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    check.fail("routing.expiresAt", "must be later than routing.issuedAt");
  }
  return true;
}
function validateEncryptedIntent(candidate) {
  const check = new Check();
  if (!check.object(candidate, "")) return { valid: false, issues: check.issues };
  const envelope = candidate;
  if (envelope.version !== 1) check.fail("version", "must be 1");
  if (envelope.kind !== "human.intent") check.fail("kind", "must be human.intent");
  checkPrivateRouting(
    check,
    envelope.routing,
    ["intentId", "principalId", "toAgentId", "toAgentAuthorityDid", "browserSessionId", "viewPublicKey"],
    ["issuedAt", "expiresAt"]
  );
  check.string(envelope.sealed, "sealed");
  return { valid: check.issues.length === 0, issues: check.issues };
}

// src/index.ts
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { chmodSync, copyFileSync, mkdirSync as mkdirSync3, readFileSync as readFileSync3, statSync, unlinkSync, writeFileSync as writeFileSync3 } from "node:fs";
import { fileURLToPath } from "node:url";

// src/edge/install.ts
import { hostname } from "node:os";

// ../iflowone/packages/iflow-domain/dist/index.js
var INITIAL_AGENT_STATE = {
  presence: "unknown",
  execution: "idle",
  coordination: "ready"
};
var TASK_TRANSITIONS = Object.freeze({
  created: ["delegated", "running", "waiting", "blocked", "delivered", "failed"],
  delegated: ["running", "waiting", "blocked", "awaiting_approval", "delivered", "failed"],
  running: ["waiting", "blocked", "awaiting_approval", "delivered", "failed"],
  waiting: ["running", "blocked", "awaiting_approval", "delivered", "failed"],
  blocked: ["running", "waiting", "awaiting_approval", "delivered", "failed"],
  awaiting_approval: ["running", "waiting", "blocked", "delivered", "failed"],
  // A rejected Delivery sends the work back rather than ending it.
  delivered: ["completed", "running", "failed"],
  completed: [],
  failed: ["running"]
});
function canTransition(from, to) {
  return TASK_TRANSITIONS[from].includes(to);
}
var EVENT_TYPES = [
  // Stable Principal identity and its current rotatable authority.
  "principal.declared",
  "authority.rotated",
  "authority.revoked",
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
  "delivery.submitted",
  "delivery.accepted",
  "delivery.rejected",
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
  "task.settled",
  // The conversation layer. A Conversation is the durable thread between two
  // Agents; each side's Session is a private execution container underneath it.
  // These carry structure and digests only — never message text — so they are
  // safe by construction rather than by redaction.
  "conversation.opened",
  "conversation.message_sent",
  "conversation.message_received",
  "conversation.accepted",
  "conversation.rejected",
  "conversation.closed",
  // Relationships as durable objects, so the network graph has a real source.
  "relation.recorded",
  "grant.issued",
  "grant.revoked",
  "trust_evidence.recorded",
  // Which local runtime an Agent acts in. Never carries the path.
  "workspace.bound",
  // Publishing is a new signed act; it never mutates a local fact.
  "publication.created",
  // Withdrawal is also a new signed fact. It removes an item from the active
  // view, never from the immutable public Journal.
  "publication.withdrawn"
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
    conversations: {},
    relations: {},
    grants: {},
    publications: {},
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
    deliveries: [],
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
function conversationIdOf(event) {
  return event.conversationId ?? (event.subject.kind === "conversation" ? event.subject.id : void 0);
}
function ensureConversation(state, id, at) {
  const existing = state.conversations[id];
  if (existing) return existing;
  const created = {
    conversationId: id,
    participants: [],
    state: "active",
    createdAt: at,
    updatedAt: at,
    crossesOwnershipBoundary: false
  };
  state.conversations[id] = created;
  return created;
}
function relationKeyOf(sourceAgentId, targetAgentId, type) {
  return sourceAgentId + "|" + targetAgentId + "|" + type;
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
    if (event.payload.principal) agent.principal = { ...event.payload.principal };
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
    if (event.payload.grantRef) task.authorizedBy = event.payload.grantRef;
    if (event.payload.crossesOwnershipBoundary !== void 0) {
      task.crossesOwnershipBoundary = event.payload.crossesOwnershipBoundary;
    }
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
    if (task.crossesOwnershipBoundary) {
      state.anomalies.push({
        eventId: event.id,
        taskId: task.id,
        from: task.state,
        to: "completed",
        reason: "unratified_completion"
      });
      const delivered = (event.payload.outputs ?? []).map((output) => ({
        kind: output.kind,
        id: output.id,
        summary: output.summary,
        at
      }));
      for (const output of delivered) task.outputs.push(output);
      task.deliveries.push({
        deliveryId: `self:${event.id}`,
        taskId: task.id,
        byAgentId: task.ownerAgentId ?? event.issuer.id,
        outputs: delivered,
        evidence: [],
        summary: event.payload.summary,
        submittedAt: at
      });
      moveTask(state, task, "delivered", event);
      return;
    }
    task.blockingReason = void 0;
    const outputs = (event.payload.outputs ?? []).map((output) => ({
      kind: output.kind,
      id: output.id,
      summary: output.summary,
      at
    }));
    for (const output of outputs) task.outputs.push(output);
    task.deliveries.push({
      deliveryId: `legacy:${event.id}`,
      taskId: task.id,
      byAgentId: task.ownerAgentId ?? event.issuer.id,
      outputs,
      evidence: [],
      summary: event.payload.summary,
      submittedAt: at,
      acceptance: {
        outcome: "accepted",
        decidedBy: event.issuer.id,
        decidedByKind: "agent",
        at,
        selfDeclared: true
      }
    });
    moveTask(state, task, "delivered", event);
    moveTask(state, task, "completed", event);
    return;
  }
  if (isEventOfType(event, "delivery.submitted")) {
    const task = ensureTask(state, event.subject.id, at);
    task.blockingReason = void 0;
    const outputs = (event.payload.outputs ?? []).map((output) => ({
      kind: output.kind,
      id: output.id,
      summary: output.summary,
      at
    }));
    for (const output of outputs) task.outputs.push(output);
    task.deliveries.push({
      deliveryId: event.payload.deliveryId,
      taskId: task.id,
      byAgentId: event.payload.byAgentId,
      outputs,
      evidence: event.payload.evidence ?? [],
      summary: event.payload.summary,
      submittedAt: at
    });
    ensureAgent(state, event.payload.byAgentId, at);
    moveTask(state, task, "delivered", event);
    return;
  }
  if (isEventOfType(event, "delivery.accepted") || isEventOfType(event, "delivery.rejected")) {
    const accepted = isEventOfType(event, "delivery.accepted");
    const task = ensureTask(state, event.subject.id, at);
    const delivery = task.deliveries.find((d) => d.deliveryId === event.payload.deliveryId);
    if (!delivery) {
      state.anomalies.push({
        eventId: event.id,
        taskId: task.id,
        from: task.state,
        to: accepted ? "completed" : "running",
        reason: "unknown_delivery"
      });
      return;
    }
    if (delivery.byAgentId === event.payload.decidedBy) {
      state.anomalies.push({
        eventId: event.id,
        taskId: task.id,
        from: task.state,
        to: accepted ? "completed" : "running",
        reason: "self_acceptance"
      });
      return;
    }
    delivery.acceptance = {
      outcome: accepted ? "accepted" : "rejected",
      decidedBy: event.payload.decidedBy,
      decidedByKind: event.payload.decidedByKind,
      at,
      reason: event.payload.reason
    };
    moveTask(state, task, accepted ? "completed" : "running", event);
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
  if (isEventOfType(event, "conversation.opened")) {
    const id = conversationIdOf(event);
    if (!id) return;
    const conversation = ensureConversation(state, id, at);
    conversation.participants = event.payload.participants.map((p) => ({ ...p }));
    conversation.crossesOwnershipBoundary = event.payload.crossesOwnershipBoundary;
    conversation.state = "pending";
    conversation.createdAt = at;
    conversation.updatedAt = at;
    for (const participant of conversation.participants) ensureAgent(state, participant.agentId, at);
    return;
  }
  if (isEventOfType(event, "conversation.accepted")) {
    const id = conversationIdOf(event);
    if (!id) return;
    const conversation = ensureConversation(state, id, at);
    conversation.state = "accepted";
    conversation.updatedAt = at;
    return;
  }
  if (isEventOfType(event, "conversation.rejected")) {
    const id = conversationIdOf(event);
    if (!id) return;
    const conversation = ensureConversation(state, id, at);
    conversation.state = "rejected";
    conversation.updatedAt = at;
    return;
  }
  if (isEventOfType(event, "conversation.closed")) {
    const id = conversationIdOf(event);
    if (!id) return;
    const conversation = ensureConversation(state, id, at);
    conversation.state = "closed";
    conversation.updatedAt = at;
    return;
  }
  if (isEventOfType(event, "conversation.message_sent") || isEventOfType(event, "conversation.message_received")) {
    const id = conversationIdOf(event);
    if (!id) return;
    const conversation = ensureConversation(state, id, at);
    conversation.lastMessageId = event.payload.messageId;
    conversation.updatedAt = at;
    if (conversation.state === "accepted") conversation.state = "active";
    return;
  }
  if (isEventOfType(event, "grant.issued")) {
    const { grantRef, issuerDid, subjectDid, scope, constraints, level, expiresAt } = event.payload;
    if (!state.grants[grantRef]) {
      state.grants[grantRef] = {
        grantRef,
        issuerDid,
        subjectDid,
        scope: [...scope],
        constraints: constraints ? [...constraints] : [],
        level,
        issuedAt: at,
        expiresAt
      };
    }
    return;
  }
  if (isEventOfType(event, "grant.revoked")) {
    const record = state.grants[event.payload.grantRef];
    if (record && !record.revokedAt) {
      record.revokedAt = at;
      record.revocationReason = event.payload.reason;
    }
    return;
  }
  if (isEventOfType(event, "trust_evidence.recorded")) {
    const agent = ensureAgent(state, event.payload.subjectAgentId, at);
    agent.trustEvidence.push({ kind: event.payload.kind, at, detail: event.payload.detail });
    return;
  }
  if (isEventOfType(event, "relation.recorded")) {
    const { sourceAgentId, targetAgentId, type } = event.payload;
    const key = relationKeyOf(sourceAgentId, targetAgentId, type);
    const existing = state.relations[key];
    if (existing) {
      existing.strength += 1;
      existing.updatedAt = at;
      if (event.payload.visibility) existing.visibility = event.payload.visibility;
    } else {
      state.relations[key] = {
        sourceAgentId,
        targetAgentId,
        type,
        createdAt: at,
        updatedAt: at,
        strength: 1,
        visibility: event.payload.visibility ?? "private"
      };
    }
    ensureAgent(state, sourceAgentId, at);
    ensureAgent(state, targetAgentId, at);
    return;
  }
  if (isEventOfType(event, "workspace.bound")) {
    const agent = ensureAgent(state, event.payload.agentId, at);
    agent.nodeId = event.payload.nodeId;
    agent.runtimeKind = event.payload.runtime;
    return;
  }
  if (isEventOfType(event, "publication.created")) {
    const payload = event.payload;
    if (event.issuer.kind !== "agent" || event.issuer.id !== payload.publishedByAgentId) return;
    if (event.subject.kind !== "publication" || event.subject.id !== payload.publicationId) return;
    if (payload.visibility !== "public") return;
    if (state.publications[payload.publicationId]) return;
    state.publications[payload.publicationId] = {
      publicationId: payload.publicationId,
      publishedByAgentId: payload.publishedByAgentId,
      kind: payload.kind,
      visibility: payload.visibility,
      summary: payload.summary,
      domains: [...payload.domains],
      capabilities: [...payload.capabilities ?? []],
      tags: [...payload.tags ?? []],
      expectedResponses: [...payload.expectedResponses ?? []],
      expiresAt: payload.expiresAt,
      commitment: payload.commitment,
      commitmentScheme: payload.commitmentScheme,
      createdAt: at
    };
    ensureAgent(state, payload.publishedByAgentId, at);
    return;
  }
  if (isEventOfType(event, "publication.withdrawn")) {
    const payload = event.payload;
    const publication = state.publications[payload.publicationId];
    if (!publication || event.issuer.kind !== "agent" || event.issuer.id !== publication.publishedByAgentId) return;
    if (event.subject.kind !== "publication" || event.subject.id !== payload.publicationId) return;
    if (payload.publishedByAgentId !== publication.publishedByAgentId) return;
    publication.withdrawnAt = at;
    publication.withdrawalReason = payload.reason;
    return;
  }
  if (isEventOfType(event, "principal.declared") || isEventOfType(event, "authority.rotated") || isEventOfType(event, "authority.revoked")) {
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
      outputs: t.outputs.map((o) => ({ ...o })),
      deliveries: t.deliveries.map((d) => ({
        ...d,
        outputs: d.outputs.map((o) => ({ ...o })),
        acceptance: d.acceptance ? { ...d.acceptance } : void 0
      }))
    })),
    rooms: mapValues(state.rooms, (r) => ({ ...r, participantAgentIds: [...r.participantAgentIds] })),
    toolCalls: mapValues(state.toolCalls, (c) => ({ ...c })),
    approvals: mapValues(state.approvals, (a) => ({ ...a })),
    quotes: mapValues(state.quotes, (q) => ({ ...q })),
    conversations: mapValues(state.conversations, (c) => ({
      ...c,
      participants: c.participants.map((p) => ({ ...p }))
    })),
    relations: mapValues(state.relations, (r) => ({ ...r })),
    grants: mapValues(state.grants, (g) => ({ ...g, scope: [...g.scope], constraints: [...g.constraints] })),
    publications: mapValues(state.publications, (p) => ({
      ...p,
      domains: [...p.domains],
      capabilities: [...p.capabilities],
      tags: [...p.tags],
      expectedResponses: [...p.expectedResponses]
    })),
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
var CONVERSATIONS_PROJECTION_VERSION = 1;
var REQUESTS_PROJECTION_VERSION = 1;
var DISCOVERY_FEED_PROJECTION_VERSION = 1;
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
  for (const relation of Object.values(state.relations)) {
    addEdge({
      id: `rel:${relation.sourceAgentId}->${relation.targetAgentId}:${relation.type}`,
      source: relation.sourceAgentId,
      target: relation.targetAgentId,
      kind: RELATION_EDGE_KIND[relation.type],
      // Strength is a count of reassertions, and it is shown rather than
      // folded into the kind so a reader can tell one contact from fifty.
      label: relation.strength > 1 ? `${relation.type} \xD7${relation.strength}` : relation.type
    });
  }
  for (const agent of Object.values(state.agents)) {
    if (agent.trustEvidence.length === 0 || !agent.did) continue;
    const node = nodes.find((n) => n.id === agent.id);
    if (node) node.status = `${node.status} \xB7 trust:${agent.trustEvidence.length}`;
  }
  return { meta: meta(state, NETWORK_GRAPH_PROJECTION_VERSION, options), data: { nodes, edges } };
}
var RELATION_EDGE_KIND = {
  followed: "contact",
  contacted: "contact",
  trusted: "trust",
  worked_with: "collaboration",
  delegated_to: "delegation",
  transacted_with: "transaction"
};
function formatAmount(micros, currency) {
  return `${(micros / 1e6).toFixed(2)} ${currency}`;
}
function summarizeEvent(event) {
  if (!isKnownEventType(event.type)) return event.type;
  if (isEventOfType(event, "principal.declared")) return `Principal ${event.payload.principalId} declared`;
  if (isEventOfType(event, "authority.rotated")) {
    return `Principal authority rotated to version ${event.payload.authorityVersion}`;
  }
  if (isEventOfType(event, "authority.revoked")) {
    return `Principal authority version ${event.payload.authorityVersion} revoked`;
  }
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
  if (isEventOfType(event, "delivery.submitted"))
    return `Work delivered for review${event.payload.summary ? `: ${event.payload.summary}` : ""}`;
  if (isEventOfType(event, "delivery.accepted")) return `Delivery accepted by ${event.payload.decidedBy}`;
  if (isEventOfType(event, "delivery.rejected"))
    return `Delivery sent back by ${event.payload.decidedBy}: ${event.payload.reason}`;
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
  if (isEventOfType(event, "conversation.opened")) {
    const who = event.payload.participants.map((p) => p.agentId).join(" \u2194 ");
    const boundary = event.payload.crossesOwnershipBoundary ? " (crosses ownership boundary)" : "";
    return `Conversation opened: ${who}${boundary}`;
  }
  if (isEventOfType(event, "conversation.message_sent")) {
    return `Message sent to ${event.payload.toAgentId} (${event.payload.actorType} via ${event.payload.origin})`;
  }
  if (isEventOfType(event, "conversation.message_received")) {
    return `Message received from ${event.payload.fromAgentId} (${event.payload.actorType} via ${event.payload.origin})`;
  }
  if (isEventOfType(event, "conversation.accepted")) {
    return `Conversation accepted by ${event.payload.acceptedBy} (${event.payload.decidedBy})`;
  }
  if (isEventOfType(event, "conversation.rejected")) {
    const why = event.payload.reason ? `: ${event.payload.reason}` : "";
    return `Conversation rejected by ${event.payload.rejectedBy} (${event.payload.decidedBy})${why}`;
  }
  if (isEventOfType(event, "conversation.closed")) {
    return `Conversation closed${event.payload.reason ? `: ${event.payload.reason}` : ""}`;
  }
  if (isEventOfType(event, "relation.recorded")) {
    return `${event.payload.sourceAgentId} ${event.payload.type} ${event.payload.targetAgentId}`;
  }
  if (isEventOfType(event, "workspace.bound")) {
    return `Agent ${event.payload.agentId} bound to ${event.payload.runtime} on ${event.payload.nodeId}`;
  }
  if (isEventOfType(event, "publication.created")) {
    return `Agent ${event.payload.publishedByAgentId} published ${event.payload.kind}: ${event.payload.summary}`;
  }
  if (isEventOfType(event, "publication.withdrawn")) {
    return `Agent ${event.payload.publishedByAgentId} withdrew publication ${event.payload.publicationId}`;
  }
  return event.type;
}
function projectConversations(state, options) {
  const conversations = Object.values(state.conversations).sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt)
  );
  const pending = conversations.filter((c) => c.state === "pending").length;
  return {
    meta: meta(state, CONVERSATIONS_PROJECTION_VERSION, options),
    data: { conversations, pending }
  };
}
function projectRequests(state, options) {
  const requests = Object.values(state.conversations).filter((conversation) => conversation.state === "pending").map((conversation) => {
    const initiator = conversation.participants.find((p) => p.role === "initiator");
    return {
      requestId: "req-" + conversation.conversationId,
      kind: "conversation",
      conversationId: conversation.conversationId,
      fromAgentId: initiator?.agentId ?? "unknown",
      fromDid: initiator?.did,
      receivedAt: conversation.createdAt,
      state: "pending"
    };
  }).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return { meta: meta(state, REQUESTS_PROJECTION_VERSION, options), data: { requests } };
}
function projectDiscoveryFeed(state, options, filter = {}) {
  const builtAt = Date.parse(options.builtAt);
  const stateOf = (publication) => {
    if (publication.withdrawnAt) return "withdrawn";
    const expiresAt = Date.parse(publication.expiresAt);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(builtAt) || expiresAt <= builtAt) return "expired";
    return "active";
  };
  const publications = Object.values(state.publications).map((publication) => ({ publication, state: stateOf(publication) })).filter((entry) => filter.includeInactive || entry.state === "active").filter((entry) => !filter.kinds || filter.kinds.includes(entry.publication.kind)).filter((entry) => !filter.domain || entry.publication.domains.includes(filter.domain)).filter((entry) => !filter.capability || entry.publication.capabilities.includes(filter.capability)).filter((entry) => !filter.tag || entry.publication.tags.includes(filter.tag)).sort((a, b) => b.publication.createdAt.localeCompare(a.publication.createdAt));
  return {
    meta: meta(state, DISCOVERY_FEED_PROJECTION_VERSION, options),
    data: { publications, filter: { ...filter } }
  };
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
    conversationId: event.conversationId,
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
    tasks: projectTaskGraph(state, options),
    conversations: projectConversations(state, options),
    requests: projectRequests(state, options),
    discovery: projectDiscoveryFeed(state, options)
  };
}

// ../iflowone/packages/iflow-adapter-sdk/dist/index.js
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
      principalId: input.principalId,
      visibility: input.visibility ?? "local",
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
      conversationId: input.conversationId,
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
        const raw = await this.signer.sign(signableBytes(signed), {
          did: signed.issuer.did,
          agentId: signed.issuer.id
        });
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
    if (event.visibility !== "public") {
      throw new Error(`iflow: refusing to enqueue non-public event ${event.id}`);
    }
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
  conversations() {
    return projectConversations(this.state, this.options());
  }
  requests() {
    return projectRequests(this.state, this.options());
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
  /**
   * The issuer stamp for an event an Agent produced.
   *
   * The DID matters: a verifier checks the signature against it, and an event
   * that carries none can be recorded but never proven off-node. A declared
   * Agent has its own key, so its own DID is attached; `selfAgentId` keeps the
   * edge's DID; anything else — a session, a peer label — has no key and is
   * honestly left without one.
   */
  agentIssuer(agentId) {
    const declared = this.descriptor.agentDids?.[agentId];
    const did = declared ?? (agentId === this.descriptor.selfAgentId ? this.descriptor.did : void 0);
    return { id: agentId, did, kind: "agent" };
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
      reason: input.reason,
      grantRef: input.grantRef,
      crossesOwnershipBoundary: input.crossesOwnershipBoundary
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
  /**
   * The executor finished, and nobody else has to agree.
   *
   * Correct only when there is no counterparty: an Agent doing work for its own
   * Principal. For work delegated across an ownership boundary use
   * `deliverySubmitted` — the fold will not complete such a Task from this
   * event, and records the attempt.
   */
  taskCompleted(input) {
    return this.taskEvent("task.completed", input.taskId, input.context, {
      summary: input.summary,
      outputs: input.outputs
    });
  }
  /**
   * The executor hands work back for someone else to rule on.
   *
   * Use this, not `taskCompleted`, whenever the work was delegated to another
   * Principal's Agent. It does not end the Task: the Task moves to `delivered`
   * and waits for `deliveryAccepted` or `deliveryRejected` from the side that
   * asked for it. A cross-boundary Task that reports `taskCompleted` instead is
   * recorded as an anomaly and still does not complete, so the difference is
   * enforced rather than trusted.
   */
  deliverySubmitted(input) {
    return this.taskEvent("delivery.submitted", input.taskId, input.context, {
      deliveryId: input.deliveryId,
      byAgentId: input.byAgentId,
      outputs: input.outputs,
      evidence: input.evidence,
      summary: input.summary
    });
  }
  /**
   * The side that asked for the work accepts it.
   *
   * `decidedBy` must not be the Agent that submitted the Delivery. The fold
   * refuses a self-acceptance and leaves the Task delivered, so emitting one
   * produces a visible anomaly rather than a quietly finished Task.
   */
  deliveryAccepted(input) {
    return this.taskEvent("delivery.accepted", input.taskId, input.context, {
      deliveryId: input.deliveryId,
      decidedBy: input.decidedBy,
      decidedByKind: input.decidedByKind,
      reason: input.reason
    });
  }
  /** Sent back. The Task returns to `running`; the Delivery and its reason both stay. */
  deliveryRejected(input) {
    return this.taskEvent("delivery.rejected", input.taskId, input.context, {
      deliveryId: input.deliveryId,
      decidedBy: input.decidedBy,
      decidedByKind: input.decidedByKind,
      reason: input.reason
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
  // ── Conversations ───────────────────────────────────────────────────────
  //
  // A Conversation is the durable thread between two Agents; each side's
  // Session is a private execution container underneath it. Nothing here
  // carries message text — the digest is the only thing that crosses, and it
  // proves the message to whoever already holds it without revealing it to
  // anyone who does not.
  conversationOpened(input) {
    const principals = new Set(
      input.participants.map((p) => p.principalId).filter((id) => typeof id === "string")
    );
    return this.conversationEvent("conversation.opened", input.conversationId, input.context, {
      participants: input.participants,
      initiatedBy: input.initiatedBy,
      crossesOwnershipBoundary: principals.size > 1
    });
  }
  conversationMessageSent(input) {
    return this.conversationEvent("conversation.message_sent", input.conversationId, input.context, {
      messageId: input.messageId,
      toAgentId: input.toAgentId,
      actorType: input.actorType ?? "agent",
      origin: input.origin ?? "agent",
      contentDigest: input.contentDigest
    });
  }
  conversationMessageReceived(input) {
    return this.conversationEvent("conversation.message_received", input.conversationId, input.context, {
      messageId: input.messageId,
      fromAgentId: input.fromAgentId,
      actorType: input.actorType ?? "agent",
      origin: input.origin ?? "a2a",
      contentDigest: input.contentDigest
    });
  }
  conversationAccepted(input) {
    return this.conversationEvent("conversation.accepted", input.conversationId, input.context, {
      acceptedBy: input.acceptedBy,
      decidedBy: input.decidedBy
    });
  }
  conversationRejected(input) {
    return this.conversationEvent("conversation.rejected", input.conversationId, input.context, {
      rejectedBy: input.rejectedBy,
      decidedBy: input.decidedBy,
      reason: input.reason
    });
  }
  conversationClosed(input) {
    return this.conversationEvent("conversation.closed", input.conversationId, input.context, {
      reason: input.reason
    });
  }
  relationRecorded(input) {
    return this.safely(
      "relation.recorded",
      () => this.journal.record({
        type: "relation.recorded",
        subject: { kind: "agent", id: input.sourceAgentId },
        issuer: input.context?.issuer ?? this.agentIssuer(input.sourceAgentId),
        payload: {
          sourceAgentId: input.sourceAgentId,
          targetAgentId: input.targetAgentId,
          type: input.type,
          visibility: input.visibility
        },
        ...spread(input.context)
      })
    );
  }
  /**
   * Which runtime and node an Agent works on.
   *
   * The workspace PATH is deliberately not a parameter. It is local state, it
   * identifies a person's disk layout, and there is no reader on the network
   * that needs it.
   */
  workspaceBound(input) {
    return this.safely(
      "workspace.bound",
      () => this.journal.record({
        type: "workspace.bound",
        subject: { kind: "agent", id: input.agentId },
        issuer: input.context?.issuer ?? this.agentIssuer(input.agentId),
        payload: {
          agentId: input.agentId,
          runtime: input.runtime ?? this.descriptor.runtimeKind,
          nodeId: this.descriptor.nodeId
        },
        ...spread(input.context)
      })
    );
  }
  /**
   * Conversation facts share a correlation keyed on the conversation, so a
   * whole thread reads as one flow the way a task's lifecycle does.
   */
  conversationEvent(type, conversationId, context, payload) {
    return this.safely(
      type,
      () => this.journal.record({
        type,
        subject: { kind: "conversation", id: conversationId },
        conversationId,
        correlationId: context?.correlationId ?? this.correlationFor(conversationId),
        payload,
        ...spreadWithoutCorrelation(context),
        ...context?.issuer ? { issuer: context.issuer } : {}
      })
    );
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
    occurredAt: context.occurredAt,
    principalId: context.principalId,
    visibility: context.visibility
  };
}
function spreadWithoutCorrelation(context) {
  if (!context) return {};
  return {
    causationId: context.causationId,
    goalId: context.goalId,
    roomId: context.roomId,
    occurredAt: context.occurredAt,
    principalId: context.principalId,
    visibility: context.visibility
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
  get("/projection/conversations", () => projection.conversations());
  get("/projection/requests", () => projection.requests());
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
          const send2 = (event) => {
            stream.send(`event: iflow-event
data: ${JSON.stringify(event)}

`);
          };
          const subscription = journal.subscribe(send2);
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
var LOCAL_ONLY_EVENT_PREFIXES = ["conversation.", "workspace."];
function isPublishable(event) {
  if (LOCAL_ONLY_EVENT_PREFIXES.some((prefix) => event.type.startsWith(prefix))) return false;
  if (event.visibility !== void 0) return event.visibility === "public";
  return event.schemaVersion === 1;
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
  const publishable = options.publishable ? (event) => isPublishable(event) && options.publishable(event) : isPublishable;
  disposables.push(
    journal.subscribe((event) => {
      views.ingest(event);
      if (queueForSync && publishable(event)) {
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
function createIflowIdSigner({ run, writeScratch, logger, resolveHome }) {
  let cachedDid;
  return {
    async did() {
      if (cachedDid) return cachedDid;
      const out = await run(["show", "--json"]);
      cachedDid = JSON.parse(out).did;
      return cachedDid;
    },
    /**
     * Sign as whoever the context names.
     *
     * With no context, or a context this node has no key for, the behaviour
     * differs sharply and on purpose:
     *
     *   no context        the node's own key — the single-identity case, and
     *                     every caller that predates declared Agents
     *   known identity    that identity's key
     *   unknown identity  REFUSE
     *
     * The refusal is the point. Substituting another key would attribute the
     * event to an Agent whose operator never signed it; the journal treats a
     * signing failure as "record it unsigned", and an unprovable fact is a far
     * better answer than a falsely attributed one.
     */
    async sign(bytes, context) {
      const named = context && (context.did || context.agentId);
      let home;
      if (named && resolveHome) {
        home = resolveHome(context);
        if (!home) {
          throw new Error(
            `no key on this node for ${context.did ?? context.agentId}; refusing to sign as another identity`
          );
        }
      }
      const path = await writeScratch("signable.bin", bytes);
      const out = await run(["sign-blob", path], home);
      const parsed = JSON.parse(out);
      if (!home && !cachedDid) cachedDid = parsed.signerDid;
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
    return {
      method: req.method ?? "GET",
      path: url.pathname,
      query,
      headers,
      body,
      socket: { remoteAddress: req.socket?.remoteAddress }
    };
  };
  const readBody2 = (req) => new Promise((resolve, reject) => {
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
          const body = spec.method === "POST" ? await readBody2(req) : void 0;
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

// src/edge/panel.ts
function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress;
  if (typeof address !== "string" || address.length === 0) {
    return false;
  }
  const normalised = address.replace(/^::ffff:/i, "");
  return normalised === "127.0.0.1" || normalised === "::1" || normalised === "localhost" || normalised.startsWith("127.");
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (text.length > 64 * 1024) reject(new Error("body too large"));
    });
    request.on("end", () => resolve(text));
    request.on("error", reject);
  });
}
async function readJson(request) {
  const text = await readBody(request);
  if (!text.trim()) return {};
  return JSON.parse(text);
}
function send(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(text);
}
function installPanelRoutes(ctx, webServer, deps) {
  const guard = (handler, { write }) => async (request, response) => {
    if (write && !isLoopbackRequest(request) && !deps.authorizeRemote(request)) {
      return send(response, 403, {
        error: "the iFlow panel answers this machine only",
        detail: "This request did not come from the local machine. Open the panel in DSH on the machine you want to publish."
      });
    }
    try {
      await handler(request, response);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      send(response, 500, { error: message });
    }
  };
  const routes = [
    ["/iflow/panel/state", "GET", guard(async (_request, response) => {
      send(response, 200, await deps.state());
    }, { write: true })],
    ["/iflow/panel/claim/start", "POST", guard(async (_request, response) => {
      send(response, 200, await deps.claimStart());
    }, { write: true })],
    ["/iflow/panel/claim/poll", "POST", guard(async (request, response) => {
      const body = await readJson(request);
      send(response, 200, await deps.claimPoll(body));
    }, { write: true })],
    ["/iflow/panel/publish/stop", "POST", guard(async (_request, response) => {
      send(response, 200, await deps.stopPublishing());
    }, { write: true })],
    ["/iflow/panel/visibility", "POST", guard(async (request, response) => {
      const body = await readJson(request);
      send(response, 200, await deps.setVisibility(body.visibility));
    }, { write: true })],
    // The folder is private local configuration.  It determines where future
    // ordinary DSH conversation sessions are created; it is never projected,
    // relayed, or included in an AgentCard.
    ["/iflow/panel/conversation-workspace", "POST", guard(async (request, response) => {
      const body = await readJson(request);
      send(response, 200, await deps.setConversationWorkspace(body.path));
    }, { write: true })],
    ["/iflow/panel/identity/fetch", "POST", guard(async (_request, response) => {
      send(response, 200, await deps.fetchIdentity());
    }, { write: true })],
    ["/iflow/panel/principal/declare", "POST", guard(async (request, response) => {
      const body = await readJson(request);
      send(response, 200, await deps.declarePrincipal(body.label));
    }, { write: true })],
    ["/iflow/panel/principal/bind", "POST", guard(async (request, response) => {
      const body = await readJson(request);
      send(response, 200, await deps.bindPrincipal(body.principalId));
    }, { write: true })],
    // This is deliberately a POST even though it only plans: the response
    // reveals private identity bindings and legacy key state. It therefore
    // takes the same local-machine guard as the operation it previews.
    ["/iflow/panel/principal/migration/plan", "POST", guard(async (_request, response) => {
      send(response, 200, await deps.principalMigrationPlan());
    }, { write: true })],
    ["/iflow/panel/principal/migration/execute", "POST", guard(async (request, response) => {
      const body = await readJson(request);
      send(response, 200, await deps.migratePrincipal(body));
    }, { write: true })],
    ["/iflow/panel/agents/declare", "POST", guard(async (request, response) => {
      const body = await readJson(request);
      send(response, 200, await deps.declareAgent(body));
    }, { write: true })],
    // The browser shows a short code; the operator confirms it on the Node
    // that holds the Principal Authority. Community never receives that key.
    ["/iflow/panel/web-login/confirm", "POST", guard(async (request, response) => {
      const body = await readJson(request);
      send(response, 200, await deps.confirmWebLogin(body.userCode));
    }, { write: true })],
    // The Requests inbox: what is waiting on the person at this machine, and
    // the two answers they can give. Accepting is what creates a session and
    // lets a remote agent's message reach a model, so it is a write and takes
    // the loopback guard like every other one.
    //
    // Read is local-only too, unlike the projections: the list carries the
    // message excerpt and the bound local session id, neither of which appears
    // in `/iflow/projection/requests` precisely because that one is shareable.
    ["/iflow/panel/conversations", "GET", guard(async (_request, response) => {
      send(response, 200, await deps.listConversations());
    }, { write: true })],
    ["/iflow/panel/conversations/accept", "POST", guard(async (request, response) => {
      const body = await readJson(request);
      send(response, 200, await deps.acceptConversation(body.conversationId));
    }, { write: true })],
    ["/iflow/panel/conversations/reject", "POST", guard(async (request, response) => {
      const body = await readJson(request);
      send(response, 200, await deps.rejectConversation(body.conversationId, body.reason));
    }, { write: true })],
    // Ruling on work a remote Agent handed back. A separate act from accepting
    // the conversation: agreeing to talk is not agreeing the work is done.
    ["/iflow/panel/deliveries/decide", "POST", guard(async (request, response) => {
      const body = await readJson(request);
      send(response, 200, await deps.decideDelivery(body.conversationId, body.deliveryId, body.decision, body.reason));
    }, { write: true })],
    // The relationship graph the Hub's Network tab draws. Guarded like the rest
    // of the panel rather than served as a projection: who this machine has
    // talked to is not the same kind of fact as what it published, and the
    // panel has exactly one access rule.
    ["/iflow/panel/network", "GET", guard(async (_request, response) => {
      send(response, 200, await deps.networkMap());
    }, { write: true })],
    // Reachability on demand. Kept off the polled `/state` payload on purpose:
    // probing every peer on a 15-second timer is a scheduled port-scan.
    ["/iflow/panel/peers/probe", "POST", guard(async (_request, response) => {
      send(response, 200, await deps.probePeers());
    }, { write: true })]
  ];
  for (const [path, method, handler] of routes) {
    ctx.effect(
      () => webServer.register({
        kind: "exact",
        path,
        handler: async (request, response) => {
          if (request.method === "OPTIONS") {
            response.writeHead(204, { Allow: `${method}, OPTIONS` });
            return response.end();
          }
          if (request.method !== method) {
            return send(response, 405, { error: `use ${method}` });
          }
          return handler(request, response);
        }
      })
    );
  }
}

// src/edge/public-registration.ts
function hasPublishableAgentRegistration(events, agent) {
  return events.some(
    (event) => event.type === "agent.registered" && event.subject?.id === agent.agentId && event.visibility === "public" && event.issuer?.kind === "agent" && event.issuer?.id === agent.agentId && event.issuer?.did === agent.did && event.payload?.did === agent.did && typeof event.evidence?.signature === "string" && event.evidence.signature.length > 0
  );
}

// src/edge/sync.ts
var FREE_TEXT_KEYS = ["title", "reason", "text"];
var REDACTED = "[redacted at origin]";
function redactEvent(event, visibility) {
  if (visibility === "full") return event;
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return event;
  const removed = FREE_TEXT_KEYS.filter((key) => typeof payload[key] === "string" && payload[key].length > 0);
  if (removed.length === 0) return event;
  const redactedPayload = { ...payload };
  for (const key of removed) redactedPayload[key] = REDACTED;
  const copy = { ...event, payload: redactedPayload };
  if (copy.evidence && copy.evidence.signature) {
    const { signature, ...rest } = copy.evidence;
    copy.evidence = rest;
  }
  copy.redaction = {
    fields: removed.map((key) => `payload.${key}`),
    reason: "free text is not published by default; the signed original stays on the origin node"
  };
  return copy;
}
function createCommunitySink(options) {
  const base = options.url.replace(/\/+$/, "");
  const visibility = options.visibility === "full" ? "full" : "structural";
  return {
    async publish(events) {
      const body = events.map((event) => JSON.stringify(redactEvent(event, visibility))).join("\n");
      const response = await fetch(`${base}/v1/edge/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          Authorization: `Bearer ${options.token}`
        },
        body
      });
      if (!response.ok) {
        throw new Error(`community returned ${response.status} for /v1/edge/events`);
      }
      const result = await response.json();
      const accepted = Array.isArray(result?.acceptedEventIds) ? result.acceptedEventIds : [];
      return { acceptedEventIds: accepted };
    }
  };
}
function startCommunitySync(ctx, edge, options) {
  const sink = createCommunitySink(options);
  const everyMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0 ? options.intervalMs : 6e4;
  const resolveEvent = (eventId) => edge.journal.all().find((event) => event.id === eventId);
  const advanceWatermark = async () => {
    const pending = edge.outbox.pending();
    const watermark = pending.length === 0 ? edge.journal.lastSeq : Math.min(...pending.map((entry) => entry.seq)) - 1;
    if (watermark > edge.journal.syncedSeq) {
      await edge.journal.markSynced(watermark);
    }
  };
  let running = false;
  const flush = async () => {
    if (running) return;
    running = true;
    try {
      const result = await edge.outbox.flush(sink, resolveEvent);
      if (result.attempted > 0) {
        console.log(
          `iFlow sync: ${result.delivered}/${result.attempted} facts accepted by ${options.url}` + (result.error ? ` (${result.error})` : "")
        );
      }
      await advanceWatermark();
    } catch (err) {
      console.error("iFlow sync failed (facts stay queued):", err && err.message ? err.message : err);
    } finally {
      running = false;
    }
  };
  void flush();
  const timer = setInterval(() => void flush(), everyMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
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
    did: options.nodeDid ?? void 0,
    // The DID of every Agent an operator declared on this node, so an event one
    // of them issues carries the key a verifier should check it against.
    agentDids: options.agentDids ?? void 0
  };
  let signer;
  let verifier;
  if (typeof options.runIflowId === "function" && typeof options.writeScratch === "function") {
    const io = {
      run: options.runIflowId,
      writeScratch: options.writeScratch,
      logger: ports.logger,
      // Which key signs is decided by whoever the event is attributed to. A
      // context this node holds no key for is refused, not substituted: the
      // journal then records the fact unsigned, which is honest, where a
      // signature by the wrong key would be a false attribution.
      resolveHome: options.resolveSigningHome
    };
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
        if (isLoopbackRequest(request)) return true;
        const token = currentToken();
        return Boolean(token && request.headers["authorization"] === `Bearer ${token}`);
      },
      // The standalone Web app is served from its own dev origin.
      allowedOrigins: options.allowedOrigins
    }
  });
  for (const agent of options.publicAgents ?? []) {
    if (hasPublishableAgentRegistration(edge.journal.all(), agent)) continue;
    await edge.observer.agentRegistered({
      agentId: agent.agentId,
      label: agent.label,
      capabilities: agent.capabilities,
      did: agent.did,
      context: { visibility: "public" }
    });
  }
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
  let stopSync = () => {
  };
  if (options.community && options.community.url && options.community.token) {
    stopSync = startCommunitySync(ctx, edge, options.community);
    ctx.logger?.info?.(
      `iFlow: publishing facts to ${options.community.url} (${options.community.visibility === "full" ? "FULL text" : "free text redacted"})`
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
      stopSync();
      commandRoute.dispose();
      approvals.dispose();
      registry.dispose();
      instrumentation.dispose();
      void instrumentation.drain().finally(() => edge.dispose());
    }
  };
}

// src/edge/community-config.ts
var FILE = "community.json";
function pathFor(join2, workspace) {
  return join2(workspace, ".iflow", FILE);
}
async function loadCommunitySettings(ctx, join2, workspace) {
  let data;
  try {
    const resolved = await ctx.fs.resolve(pathFor(join2, workspace));
    data = JSON.parse(await ctx.fs.readText(resolved));
  } catch (err) {
    if (err && (err.code === "ENOENT" || /not found/i.test(String(err.message)))) return null;
    return { stopped: true };
  }
  try {
    if (data && data.stoppedAt) return { stopped: true };
    if (!data || typeof data.url !== "string" || typeof data.token !== "string") return { stopped: true };
    if (data.url.length === 0 || data.token.length === 0) return { stopped: true };
    return {
      url: data.url,
      token: data.token,
      visibility: data.visibility === "full" ? "full" : "structural",
      nodeId: typeof data.nodeId === "string" ? data.nodeId : void 0,
      principalId: typeof data.principalId === "string" ? data.principalId : null,
      enabledAt: typeof data.enabledAt === "string" ? data.enabledAt : void 0,
      intervalMs: Number(data.intervalMs) || 6e4
    };
  } catch {
    return { stopped: true };
  }
}
async function saveCommunitySettings(ctx, join2, workspace, settings) {
  const resolved = await ctx.fs.resolve(pathFor(join2, workspace));
  await ctx.fs.writeText(resolved, JSON.stringify(settings, null, 2));
}
async function clearCommunitySettings(ctx, join2, workspace) {
  const resolved = await ctx.fs.resolve(pathFor(join2, workspace));
  await ctx.fs.writeText(resolved, JSON.stringify({ stoppedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2));
}

// src/identity/keyring.ts
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { dirname as dirname2 } from "node:path";
var DECLARATIONS = "agents.json";
var BINDING = "principal-binding.json";
var REGISTRY = "principals.json";
var MIGRATION_RECEIPT = "principal-migration.json";
var PRINCIPAL_PREFIX = "iflow:principal:";
function nodeHome(_join, workspace) {
  return workspace;
}
function legacyPrincipalHome(join2, workspace) {
  return join2(workspace, ".iflow", "principal");
}
function defaultPrincipalStoreRoot(join2, env = process.env, userHome = homedir()) {
  const configured = typeof env.IFLOWONE_HOME === "string" ? env.IFLOWONE_HOME.trim() : "";
  if (configured) return configured;
  if (!userHome) throw new Error("cannot locate a user home for the stable Principal store; set IFLOWONE_HOME");
  return join2(userHome, ".iflowone");
}
function principalSegment(principalId) {
  if (typeof principalId !== "string" || !principalId.startsWith(PRINCIPAL_PREFIX)) {
    throw new Error("principalId must use the iflow:principal: namespace");
  }
  const segment = principalId.slice(PRINCIPAL_PREFIX.length);
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(segment)) throw new Error("principalId contains an unsafe storage identifier");
  return segment;
}
function authorityHome(join2, principalStoreRoot, principalId, authorityVersion = 1) {
  if (!Number.isSafeInteger(authorityVersion) || authorityVersion < 1) {
    throw new Error("authorityVersion must be a positive integer");
  }
  return join2(principalStoreRoot, "principals", principalSegment(principalId), `authority-v${authorityVersion}`);
}
function agentHome(join2, workspace, agentId) {
  return join2(workspace, ".iflow", "agents", agentId);
}
var declarationsPath = (join2, workspace) => join2(workspace, ".iflow", DECLARATIONS);
var bindingPath = (join2, workspace) => join2(workspace, ".iflow", BINDING);
var registryPath = (join2, root) => join2(root, REGISTRY);
var migrationReceiptPath = (join2, workspace) => join2(workspace, ".iflow", MIGRATION_RECEIPT);
function missing(error) {
  return error && (error.code === "ENOENT" || /not found|no such file/i.test(String(error.message)));
}
async function readWorkspaceJson(ctx, path) {
  try {
    const resolved = await ctx.fs.resolve(path);
    return JSON.parse(await ctx.fs.readText(resolved));
  } catch (error) {
    if (missing(error)) return void 0;
    throw error;
  }
}
async function writeWorkspaceJson(ctx, path, value) {
  const resolved = await ctx.fs.resolve(path);
  await ctx.fs.writeText(resolved, JSON.stringify(value, null, 2));
}
function readLocalJson(path, fallback) {
  try {
    return JSON.parse(readFileSync2(path, "utf8"));
  } catch (error) {
    if (missing(error)) return fallback;
    throw error;
  }
}
function writeLocalJson(path, value) {
  mkdirSync2(dirname2(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync2(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 384 });
  renameSync(temporary, path);
}
function stableBinding(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.principalId !== "string" || typeof value.authorityDid !== "string") return null;
  const authorityVersion = Number(value.authorityVersion);
  if (!Number.isSafeInteger(authorityVersion) || authorityVersion < 1) return null;
  return {
    principalId: value.principalId,
    authorityDid: value.authorityDid,
    authorityVersion,
    label: typeof value.label === "string" ? value.label : void 0,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : void 0,
    boundAt: typeof value.boundAt === "string" ? value.boundAt : void 0,
    source: typeof value.source === "string" ? value.source : void 0
  };
}
function legacyBinding(value) {
  if (!value || typeof value !== "object" || typeof value.did !== "string") return null;
  return {
    principalId: null,
    authorityDid: value.did,
    authorityVersion: 1,
    did: value.did,
    label: typeof value.label === "string" ? value.label : "principal",
    declaredAt: typeof value.declaredAt === "string" ? value.declaredAt : void 0,
    legacy: true
  };
}
async function loadDeclarations(ctx, join2, workspace) {
  let declarationData;
  let bindingData;
  try {
    declarationData = await readWorkspaceJson(ctx, declarationsPath(join2, workspace));
  } catch (error) {
    console.error("iFlow: could not read the agent declarations", error?.message ?? error);
  }
  try {
    bindingData = await readWorkspaceJson(ctx, bindingPath(join2, workspace));
  } catch (error) {
    console.error("iFlow: could not read the Principal binding", error?.message ?? error);
  }
  const agents = Array.isArray(declarationData?.agents) ? declarationData.agents : [];
  return {
    principal: stableBinding(bindingData) ?? legacyBinding(declarationData?.principal),
    agents: agents.filter((agent) => agent && typeof agent.agentId === "string" && typeof agent.did === "string")
  };
}
async function saveDeclarations(ctx, join2, workspace, declarations) {
  await writeWorkspaceJson(ctx, declarationsPath(join2, workspace), {
    schemaVersion: 2,
    agents: Array.isArray(declarations?.agents) ? declarations.agents : []
  });
}
function loadPrincipalRegistry(join2, principalStoreRoot) {
  const data = readLocalJson(registryPath(join2, principalStoreRoot), { schemaVersion: 1, principals: [] });
  const principals = Array.isArray(data?.principals) ? data.principals.map(stableBinding).filter(Boolean) : [];
  return { schemaVersion: 1, principals };
}
function savePrincipalRegistry(join2, principalStoreRoot, registry) {
  writeLocalJson(registryPath(join2, principalStoreRoot), { schemaVersion: 1, principals: registry.principals });
}
async function bindPrincipal(ctx, join2, workspace, principalStoreRoot, run, principalId) {
  const declarations = await loadDeclarations(ctx, join2, workspace);
  if (declarations.principal?.legacy) {
    throw new Error("this workspace has a legacy Principal; run the explicit migration before binding another one");
  }
  if (declarations.principal) {
    if (declarations.principal.principalId === principalId) return declarations.principal;
    throw new Error("this workspace is already bound to another Principal");
  }
  const selected = loadPrincipalRegistry(join2, principalStoreRoot).principals.find((principal) => principal.principalId === principalId);
  if (!selected) throw new Error("the selected Principal is not present in this user profile");
  const storedDid = JSON.parse(
    await run(["show", "--json"], authorityHome(join2, principalStoreRoot, selected.principalId, selected.authorityVersion))
  ).did;
  if (storedDid !== selected.authorityDid) {
    throw new Error("the selected Principal Authority key does not match its private registry");
  }
  const binding = { ...selected, boundAt: (/* @__PURE__ */ new Date()).toISOString(), source: "selected" };
  await writeWorkspaceJson(ctx, bindingPath(join2, workspace), binding);
  return binding;
}
function agentDidsOf(declarations) {
  const map = {};
  for (const agent of declarations.agents) map[agent.agentId] = agent.did;
  return map;
}
function homeForSigning(join2, workspace, declarations, context, nodeDid, principalStoreRoot) {
  if (!context) return nodeHome(join2, workspace);
  if (context.did) {
    if (nodeDid && context.did === nodeDid) return nodeHome(join2, workspace);
    const principal = declarations.principal;
    if (principal && (principal.authorityDid === context.did || principal.did === context.did)) {
      if (principal.legacy) return legacyPrincipalHome(join2, workspace);
      if (!principalStoreRoot) return void 0;
      return authorityHome(join2, principalStoreRoot, principal.principalId, principal.authorityVersion);
    }
    const declared = declarations.agents.find((agent) => agent.did === context.did);
    if (declared) return agentHome(join2, workspace, declared.agentId);
    return void 0;
  }
  if (context.agentId) {
    const declared = declarations.agents.find((agent) => agent.agentId === context.agentId);
    if (declared) return agentHome(join2, workspace, declared.agentId);
  }
  return nodeHome(join2, workspace);
}
async function ensureKey(run, home, label) {
  try {
    const did = JSON.parse(await run(["show", "--json"], home)).did;
    if (did) return did;
  } catch {
  }
  await run(["create", label], home);
  return JSON.parse(await run(["show", "--json"], home)).did;
}
async function declarePrincipal(ctx, join2, workspace, principalStoreRoot, run, label) {
  const declarations = await loadDeclarations(ctx, join2, workspace);
  if (declarations.principal) {
    if (declarations.principal.legacy) throw new Error("migrate the legacy workspace Principal before declaring another one");
    return declarations.principal;
  }
  const principalId = `${PRINCIPAL_PREFIX}${randomUUID()}`;
  const authorityVersion = 1;
  const authorityDid = await ensureKey(
    run,
    authorityHome(join2, principalStoreRoot, principalId, authorityVersion),
    label || "principal"
  );
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const document = { principalId, authorityDid, authorityVersion, label: label || "principal", createdAt: now };
  const registry = loadPrincipalRegistry(join2, principalStoreRoot);
  registry.principals.push(document);
  savePrincipalRegistry(join2, principalStoreRoot, registry);
  const binding = { ...document, boundAt: now, source: "created" };
  await writeWorkspaceJson(ctx, bindingPath(join2, workspace), binding);
  return binding;
}
async function planPrincipalMigration(ctx, join2, workspace, principalStoreRoot) {
  const declarations = await loadDeclarations(ctx, join2, workspace);
  if (!declarations.principal) return { state: "none" };
  if (!declarations.principal.legacy) return { state: "complete", principal: declarations.principal };
  const legacyAuthorityDid = declarations.principal.authorityDid;
  const matches = loadPrincipalRegistry(join2, principalStoreRoot).principals.filter((principal) => principal.authorityDid === legacyAuthorityDid);
  if (matches.length > 1) {
    return { state: "ambiguous", legacyAuthorityDid, candidates: matches.map((item) => item.principalId) };
  }
  return {
    state: "required",
    legacyAuthorityDid,
    label: declarations.principal.label,
    action: matches.length === 1 ? "bind-existing" : "import-new",
    targetPrincipalId: matches[0]?.principalId ?? null,
    agentCount: declarations.agents.length,
    legacyKeyRetained: true,
    backupRequired: true
  };
}
function backupLegacyState(join2, workspace) {
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backup = join2(workspace, ".iflow", "backups", `principal-${stamp}`);
  mkdirSync2(backup, { recursive: true });
  const legacyKey = legacyPrincipalHome(join2, workspace);
  if (existsSync(legacyKey)) cpSync(legacyKey, join2(backup, "principal"), { recursive: true, errorOnExist: true });
  const agents = declarationsPath(join2, workspace);
  if (existsSync(agents)) cpSync(agents, join2(backup, DECLARATIONS), { errorOnExist: true });
  writeLocalJson(join2(backup, "manifest.json"), {
    schemaVersion: 1,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    legacyPrincipalHome: legacyKey,
    agentsPath: agents
  });
  return backup;
}
async function migrateLegacyPrincipal(ctx, join2, workspace, principalStoreRoot, run, { expectedAuthorityDid, targetPrincipalId } = {}) {
  const plan = await planPrincipalMigration(ctx, join2, workspace, principalStoreRoot);
  if (plan.state === "complete") return { migrated: false, idempotent: true, principal: plan.principal };
  if (plan.state !== "required") throw new Error(`legacy Principal migration is not executable (${plan.state})`);
  if (!expectedAuthorityDid || expectedAuthorityDid !== plan.legacyAuthorityDid) {
    throw new Error("legacy Authority DID changed since the dry-run; inspect the migration again");
  }
  const shown = JSON.parse(await run(["show", "--json"], legacyPrincipalHome(join2, workspace)));
  if (shown.did !== expectedAuthorityDid) {
    throw new Error("the legacy key on disk does not match agents.json; refusing migration");
  }
  const registry = loadPrincipalRegistry(join2, principalStoreRoot);
  let document;
  if (plan.action === "bind-existing") {
    if (targetPrincipalId && targetPrincipalId !== plan.targetPrincipalId) {
      throw new Error("target Principal does not match the dry-run");
    }
    document = registry.principals.find((principal) => principal.principalId === plan.targetPrincipalId);
    if (!document) throw new Error("the Principal selected by the dry-run no longer exists");
    const targetDid = JSON.parse(
      await run(["show", "--json"], authorityHome(join2, principalStoreRoot, document.principalId, document.authorityVersion))
    ).did;
    if (targetDid !== expectedAuthorityDid) throw new Error("the selected Principal Authority key does not match its registry");
  } else {
    if (targetPrincipalId) throw new Error("a new Principal import cannot target an unrelated Principal");
    document = {
      principalId: `${PRINCIPAL_PREFIX}${randomUUID()}`,
      authorityDid: expectedAuthorityDid,
      authorityVersion: 1,
      label: plan.label || "principal",
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  const backupPath = backupLegacyState(join2, workspace);
  if (plan.action === "import-new") {
    const target = authorityHome(join2, principalStoreRoot, document.principalId, document.authorityVersion);
    if (existsSync(target)) throw new Error("refusing to overwrite an existing Authority directory");
    mkdirSync2(dirname2(target), { recursive: true });
    cpSync(legacyPrincipalHome(join2, workspace), target, { recursive: true, errorOnExist: true });
    const copiedDid = JSON.parse(await run(["show", "--json"], target)).did;
    if (copiedDid !== expectedAuthorityDid) throw new Error("copied Authority failed post-copy verification");
    registry.principals.push(document);
    savePrincipalRegistry(join2, principalStoreRoot, registry);
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const binding = { ...document, boundAt: now, source: "migrated" };
  const declarations = await loadDeclarations(ctx, join2, workspace);
  const agents = declarations.agents.map((agent) => {
    const { principalDid: _legacyPrincipalDid, ...rest } = agent;
    return {
      ...rest,
      principalId: document.principalId,
      authorityDid: document.authorityDid,
      authorityVersion: document.authorityVersion
    };
  });
  await saveDeclarations(ctx, join2, workspace, { agents });
  await writeWorkspaceJson(ctx, bindingPath(join2, workspace), binding);
  await writeWorkspaceJson(ctx, migrationReceiptPath(join2, workspace), {
    schemaVersion: 1,
    migratedAt: now,
    principalId: document.principalId,
    authorityDid: document.authorityDid,
    authorityVersion: document.authorityVersion,
    backupPath,
    legacyKeyRetained: true
  });
  return { migrated: true, principal: binding, backupPath, legacyKeyRetained: true };
}
async function declareAgent(ctx, join2, workspace, principalStoreRoot, run, { agentId, label, capabilities, level, ttlSeconds }) {
  if (!agentId || !/^[a-z0-9][a-z0-9-]{0,62}$/i.test(agentId)) {
    throw new Error("agentId must be 1-63 characters of letters, digits and hyphens");
  }
  const declarations = await loadDeclarations(ctx, join2, workspace);
  if (!declarations.principal) throw new Error("bind a Principal first: an Agent with nobody behind it cannot be held to anything");
  if (declarations.principal.legacy) throw new Error("migrate the legacy Principal before declaring another Agent");
  if (declarations.agents.some((agent) => agent.agentId === agentId)) {
    throw new Error(`an Agent named ${agentId} is already declared on this node`);
  }
  const caps = (capabilities ?? []).filter((capability) => typeof capability === "string" && capability.length > 0);
  const did = await ensureKey(run, agentHome(join2, workspace, agentId), label || agentId);
  const expiresAt = Math.floor(Date.now() / 1e3) + (Number(ttlSeconds) || 365 * 24 * 3600);
  const args = [
    "grant",
    "create",
    did,
    label || agentId,
    level || "L2",
    String(expiresAt),
    "--issuer-kind",
    "human",
    "--root",
    "webauthn",
    "--label",
    `${label || agentId} delegation`
  ];
  if (caps.length > 0) args.push("--capabilities", caps.join(","));
  const authority = authorityHome(
    join2,
    principalStoreRoot,
    declarations.principal.principalId,
    declarations.principal.authorityVersion
  );
  const grantText = await run(args, authority);
  const grant = JSON.parse(grantText.replace(/^\s*\/\/.*$/gm, ""));
  const declared = {
    agentId,
    label: label || agentId,
    did,
    capabilities: caps,
    grantRef: grant.grant_id,
    principalId: declarations.principal.principalId,
    authorityDid: declarations.principal.authorityDid,
    authorityVersion: declarations.principal.authorityVersion,
    declaredAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  declarations.agents.push(declared);
  await saveDeclarations(ctx, join2, workspace, declarations);
  return { declared, grant };
}

// src/identity/pinning.ts
function looksLikeDid(value) {
  return typeof value === "string" && /^did:key:z[1-9A-HJ-NP-Za-km-z]{40,}$/.test(value);
}
var PinMismatchError = class extends Error {
  constructor(peerName, pinned, presented) {
    super(
      `${peerName} presented a different identity than the one pinned for it.
  pinned:    ${pinned}
  presented: ${presented}
Refusing to send. A message sealed to the new key would be readable by whoever holds it.
If this peer legitimately rotated its key, remove it with iflow_remove_peer and add it again with the new did \u2014 after checking that did with a person, not over the same channel that just presented it.`
    );
    this.name = "PinMismatchError";
    this.peerName = peerName;
    this.pinned = pinned;
    this.presented = presented;
  }
};
function reconcileDid(peerName, pinned, presented) {
  const known = looksLikeDid(pinned) ? pinned : null;
  const seen = looksLikeDid(presented) ? presented : null;
  if (known && seen && known !== seen) throw new PinMismatchError(peerName, known, seen);
  if (known) return { did: known, outcome: "pinned" };
  if (seen) return { did: seen, outcome: "recorded" };
  return { did: null, outcome: "unknown" };
}
function didFingerprint(did) {
  if (!looksLikeDid(did)) return "not a did:key";
  const body = did.slice("did:key:".length);
  return `${body.slice(0, 8)}\u2026${body.slice(-8)}`;
}

// src/identity/capabilities.ts
var IFI_CAPABILITIES = Object.freeze({
  "--node-home": "keep revocations and pricing node-wide across Agent identities",
  seal: "sealing messages for the relay",
  open: "opening messages from the relay"
});
function helpAdvertises(help, command) {
  if (typeof help !== "string" || help.length === 0) return false;
  return new RegExp(`^\\s+${command}\\s+[<\\[]`, "m").test(help);
}
function missingCapabilities(help) {
  return Object.keys(IFI_CAPABILITIES).filter((command) => !helpAdvertises(help, command));
}
function staleBinaryAdvice(binPath, cachePath, missing2) {
  const cannot = missing2.map((command) => IFI_CAPABILITIES[command]).join(" or ");
  return [
    `iFlow: the identity binary at ${binPath} is older than this plugin \u2014 it cannot ${cannot}.`,
    "Everything else works. One of three things is true:",
    `  \xB7 a stale cached copy \u2014 delete ${cachePath} and run iflow_fetch_identity`,
    "  \xB7 a local build you would rather use \u2014 point IFLOW_ID_PATH at it",
    "  \xB7 the published Release has not caught up with this plugin \u2014 nothing on this",
    "    machine fixes that; a new binary has to be tagged and built first"
  ].join("\n");
}

// src/relay/envelope.ts
function envelopeAad({ conversationId, messageId, fromDid, toDid } = {}) {
  return [conversationId ?? "", messageId ?? "", fromDid ?? "", toDid ?? ""].join("|");
}
function packRelayPayload(body, signature) {
  return JSON.stringify({ v: 1, body, signature: signature ?? null });
}
function unpackRelayPayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error("relay payload is not JSON; the sender packed something unexpected");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("relay payload is not an object");
  if (parsed.v !== 1) throw new Error(`unsupported relay payload version ${String(parsed.v)}; this node speaks 1`);
  if (typeof parsed.body !== "string" || parsed.body.length === 0) {
    throw new Error("relay payload carries no request body");
  }
  return {
    body: parsed.body,
    signature: parsed.signature && typeof parsed.signature === "object" ? parsed.signature : null
  };
}
function relayDecision({ peer, directError, relayConfigured } = {}) {
  if (!directError) return { use: false, reason: "direct delivery worked" };
  if (!relayConfigured) {
    return { use: false, reason: "this node is not connected to a relay, so an unreachable peer stays unreachable" };
  }
  if (!peer || !peer.did) {
    return {
      use: false,
      reason: "no identity is pinned for this peer, so a message cannot be sealed for it. Run iflow_discover while it is reachable, or pass its did to iflow_add_peer."
    };
  }
  return { use: true, reason: `direct delivery failed (${directError}); sending sealed via the relay` };
}

// src/relay/transport.ts
function createRelayTransport(io) {
  const { iflowId, scratchPath, readBytes, writeBytes, post, get, identityHome, logger = console } = io;
  async function seal({ toDid, body, signature, conversationId, messageId, fromDid }) {
    const payload = packRelayPayload(body, signature);
    const plainPath = scratchPath(`relay-out-${messageId}.json`);
    const sealedPath = scratchPath(`relay-out-${messageId}.bin`);
    await writeBytes(plainPath, payload);
    const aad = envelopeAad({ conversationId, messageId, fromDid, toDid });
    await iflowId(["seal", toDid, plainPath, sealedPath, aad], 20);
    const bytes = await readBytes(sealedPath);
    return Buffer.from(bytes).toString("base64url");
  }
  async function open(envelope) {
    const sealedPath = scratchPath(`relay-in-${envelope.id}.bin`);
    const plainPath = scratchPath(`relay-in-${envelope.id}.json`);
    await writeBytes(sealedPath, Buffer.from(envelope.sealed, "base64url"));
    const aad = envelopeAad({
      conversationId: envelope.conversation_id,
      messageId: envelope.id,
      fromDid: envelope.from_did,
      toDid: envelope.to_did
    });
    const home = identityHome ? await identityHome(envelope.to_did) : void 0;
    if (identityHome && !home) throw new Error(`this node has no private key for relay recipient ${envelope.to_did}`);
    await iflowId(["open", sealedPath, plainPath, aad], home ?? 20, home ? 20 : void 0);
    return unpackRelayPayload(Buffer.from(await readBytes(plainPath)).toString("utf8"));
  }
  async function send2({ url, token, toDid, sealed, messageId, conversationId, fromDid }) {
    return post(
      `${url}/v1/relay/send`,
      { toDid, messageId, conversationId: conversationId ?? null, fromDid: fromDid ?? null, sealed },
      token
    );
  }
  async function inbox({ url, token, limit = 25 }) {
    const answer = await get(`${url}/v1/relay/inbox?limit=${limit}`, token);
    return Array.isArray(answer?.envelopes) ? answer.envelopes : [];
  }
  async function ack({ url, token, messageIds }) {
    if (messageIds.length === 0) return { acknowledged: 0 };
    return post(`${url}/v1/relay/ack`, { messageIds }, token);
  }
  async function status({ url, token, messageIds }) {
    if (messageIds.length === 0) return {};
    const answer = await post(`${url}/v1/relay/status`, { messageIds }, token);
    return answer?.status ?? {};
  }
  async function heartbeat({ url, token, agents }) {
    return post(`${url}/v1/relay/presence`, { agents }, token);
  }
  async function directory({ url, token, did }) {
    return get(`${url}/v1/relay/directory?did=${encodeURIComponent(did)}`, token);
  }
  async function drain({ url, token, deliver }) {
    const envelopes = await inbox({ url, token });
    if (envelopes.length === 0) return { collected: 0, delivered: 0, refused: 0 };
    const done = [];
    let delivered = 0;
    let refused = 0;
    for (const envelope of envelopes) {
      let opened;
      try {
        opened = await open(envelope);
      } catch (err) {
        refused += 1;
        done.push(envelope.id);
        logger.error(
          `iFlow relay: discarding envelope ${envelope.id} from ${envelope.from_did ?? "an unnamed sender"} \u2014 ${String(err && err.message ? err.message : err)}`
        );
        continue;
      }
      try {
        await deliver(opened, envelope);
        delivered += 1;
        done.push(envelope.id);
      } catch (err) {
        logger.error(`iFlow relay: could not deliver ${envelope.id}`, err && err.message ? err.message : err);
      }
    }
    await ack({ url, token, messageIds: done });
    return { collected: envelopes.length, delivered, refused };
  }
  return { seal, open, send: send2, inbox, ack, status, heartbeat, directory, drain };
}
function startRelayPolling({
  transport,
  settings,
  agents,
  deliver,
  /** Sent messages whose fate is still open, and how to record an answer. */
  pending = () => [],
  onStatus = () => {
  },
  intervalMs = 15e3,
  logger = console
}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const current = settings();
      if (!current) return;
      const { url, token } = current;
      const roster = agents();
      if (roster.length > 0) {
        const result = await transport.heartbeat({ url, token, agents: roster });
        for (const did of result?.conflicts ?? []) {
          logger.error(
            `iFlow relay: another node has claimed ${did}. Messages addressed to that Agent are being delivered elsewhere. If that is not a machine you control, treat the identity as compromised.`
          );
        }
      }
      const open = pending();
      if (open.length > 0) {
        const reported = await transport.status({ url, token, messageIds: open.map((m) => m.messageId) });
        for (const { conversationId, messageId } of open) {
          const reportedState = reported[messageId];
          if (reportedState) onStatus(conversationId, messageId, reportedState);
        }
      }
      const outcome = await transport.drain({ url, token, deliver });
      if (outcome.collected > 0) {
        logger.log(
          `iFlow relay: collected ${outcome.collected}, delivered ${outcome.delivered}` + (outcome.refused > 0 ? `, discarded ${outcome.refused}` : "")
        );
      }
    } catch (err) {
      logger.log(`iFlow relay: poll skipped (${String(err && err.message ? err.message : err)})`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

// src/web/local-intents.ts
var STORE_VERSION = 2;
var MAX_TEXT = 16 * 1024;
var DEFAULT_SYNC_LIMIT = 50;
var MAX_SYNC_LIMIT = 100;
var VIEW_TTL_MS = 10 * 60 * 1e3;
var IntentPolicyError2 = class extends Error {
  constructor(message, code = "policy_denied") {
    super(message);
    this.name = "IntentPolicyError";
    this.code = code;
  }
};
var IntentEnvelopeError = class extends Error {
  constructor(message, code = "intent_unreadable") {
    super(message);
    this.name = "IntentEnvelopeError";
    this.code = code;
  }
};
function intentAad(envelope) {
  return canonicalJson({ version: envelope.version, kind: envelope.kind, routing: envelope.routing });
}
function browserViewAad(envelope) {
  return canonicalJson({ version: envelope.version, kind: envelope.kind, routing: envelope.routing });
}
function shortString(value, name, { optional = false, max = 256 } = {}) {
  if (optional && value === void 0) return void 0;
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new IntentPolicyError2(`${name} must contain 1-${max} characters`, `invalid_${name}`);
  }
  return value;
}
function only(value, fields) {
  if (Object.keys(value).some((key) => !fields.has(key))) {
    throw new IntentPolicyError2("Intent contains fields outside its declared action", "unsupported_action");
  }
}
function parseConversationIntent(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new IntentPolicyError2("Intent plaintext is not JSON", "invalid_plaintext");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IntentPolicyError2("Intent plaintext must be an object", "invalid_plaintext");
  }
  if (value.version !== 1 || typeof value.kind !== "string") {
    throw new IntentPolicyError2("Intent version or kind is unsupported", "unsupported_action");
  }
  if (value.kind === "conversation.send") {
    only(value, /* @__PURE__ */ new Set([
      "version",
      "kind",
      "mode",
      "targetAgentId",
      "targetAgentAuthorityDid",
      "text",
      "conversationId"
    ]));
    if (value.mode !== "direct" && value.mode !== "assisted") {
      throw new IntentPolicyError2("mode must be direct or assisted", "invalid_mode");
    }
    const targetAgentAuthorityDid = shortString(value.targetAgentAuthorityDid, "targetAgentAuthorityDid");
    if (!targetAgentAuthorityDid.startsWith("did:key:")) {
      throw new IntentPolicyError2("targetAgentAuthorityDid must be did:key", "invalid_target");
    }
    if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > MAX_TEXT) {
      throw new IntentPolicyError2(`text must contain 1-${MAX_TEXT} characters`, "invalid_message");
    }
    return {
      version: 1,
      kind: value.kind,
      mode: value.mode,
      targetAgentId: shortString(value.targetAgentId, "targetAgentId"),
      targetAgentAuthorityDid,
      text: value.text,
      conversationId: shortString(value.conversationId, "conversationId", { optional: true })
    };
  }
  if (value.kind === "conversation.sync") {
    only(value, /* @__PURE__ */ new Set(["version", "kind", "ownAgentId", "peerAgentId", "conversationId", "cursor", "limit"]));
    if (value.limit !== void 0 && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_SYNC_LIMIT)) {
      throw new IntentPolicyError2(`limit must be an integer from 1-${MAX_SYNC_LIMIT}`, "invalid_limit");
    }
    const conversationId = shortString(value.conversationId, "conversationId", { optional: true });
    const peerAgentId = shortString(value.peerAgentId, "peerAgentId", { optional: true });
    return {
      version: 1,
      kind: value.kind,
      ownAgentId: shortString(value.ownAgentId, "ownAgentId"),
      peerAgentId,
      conversationId,
      cursor: shortString(value.cursor, "cursor", { optional: true }),
      limit: value.limit ?? DEFAULT_SYNC_LIMIT
    };
  }
  if (value.kind === "conversation.draft.decide") {
    only(value, /* @__PURE__ */ new Set(["version", "kind", "conversationId", "draftId", "decision"]));
    if (value.decision !== "confirm" && value.decision !== "cancel") {
      throw new IntentPolicyError2("decision must be confirm or cancel", "invalid_decision");
    }
    return {
      version: 1,
      kind: value.kind,
      conversationId: shortString(value.conversationId, "conversationId"),
      draftId: shortString(value.draftId, "draftId"),
      decision: value.decision
    };
  }
  throw new IntentPolicyError2("Intent action is unsupported", "unsupported_action");
}
function emptyStore() {
  return { schemaVersion: STORE_VERSION, intents: [], viewBindings: [] };
}
function safeStore(value) {
  if (!value || !Array.isArray(value.intents)) return emptyStore();
  return {
    schemaVersion: STORE_VERSION,
    intents: value.intents.filter((record) => record && typeof record.intentId === "string"),
    viewBindings: Array.isArray(value.viewBindings) ? value.viewBindings.filter((binding) => binding && typeof binding.browserSessionId === "string") : []
  };
}
function messageOf(error) {
  return error && error.message ? String(error.message) : String(error);
}
function envelopeIsValid(candidate) {
  const result = validateEncryptedIntent(candidate);
  if (result.valid) return true;
  const routing = candidate?.routing;
  return candidate?.version === 1 && candidate?.kind === "human.intent" && typeof routing?.intentId === "string" && typeof routing?.principalId === "string" && typeof routing?.toAgentId === "string" && typeof routing?.toAgentAuthorityDid === "string" && typeof routing?.browserSessionId === "string" && typeof routing?.viewPublicKey === "string" && typeof routing?.issuedAt === "string" && typeof routing?.expiresAt === "string" && typeof candidate?.sealed === "string";
}
var LocalIntentQueue = class {
  constructor({ store, crypto: crypto2, executeIntent, postView, isAgentAvailable = async () => true, clock = () => /* @__PURE__ */ new Date(), logger = console }) {
    this.store = store;
    this.crypto = crypto2;
    this.executeIntent = executeIntent;
    this.postView = postView;
    this.isAgentAvailable = isAgentAvailable;
    this.clock = clock;
    this.logger = logger;
    this.data = null;
  }
  async open() {
    if (this.data) return;
    this.data = safeStore(await this.store.read());
    for (const record of this.data.intents) if (record.state === "processing") record.state = "queued";
    this.pruneBindings();
    await this.persist();
  }
  async persist() {
    await this.store.write(this.data ?? emptyStore());
  }
  pruneBindings() {
    const now = this.clock().getTime();
    this.data.viewBindings = this.data.viewBindings.filter((binding) => Date.parse(binding.expiresAt) > now);
  }
  /** Persist first; only returned ids may be ACKed to Community. */
  async accept(candidates) {
    await this.open();
    const acknowledged = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (!envelopeIsValid(candidate)) continue;
      const existing = this.data.intents.find((record) => record.intentId === candidate.routing.intentId);
      if (existing) {
        if (existing.principalId === candidate.routing.principalId && existing.browserSessionId === candidate.routing.browserSessionId && existing.ownAgentId === candidate.routing.toAgentId && existing.ownAgentAuthorityDid === candidate.routing.toAgentAuthorityDid) acknowledged.push(existing.intentId);
        continue;
      }
      const now = this.clock().toISOString();
      this.data.intents.push({
        intentId: candidate.routing.intentId,
        principalId: candidate.routing.principalId,
        browserSessionId: candidate.routing.browserSessionId,
        ownAgentId: candidate.routing.toAgentId,
        ownAgentAuthorityDid: candidate.routing.toAgentAuthorityDid,
        viewPublicKey: candidate.routing.viewPublicKey,
        envelope: candidate,
        state: "queued",
        attempts: 0,
        receivedAt: now,
        updatedAt: now
      });
      acknowledged.push(candidate.routing.intentId);
    }
    await this.persist();
    return acknowledged;
  }
  async process() {
    await this.open();
    for (const record of this.data.intents) {
      if (record.state !== "queued") continue;
      if (!await this.isAgentAvailable(record.ownAgentId, record.ownAgentAuthorityDid)) continue;
      await this.processOne(record);
    }
  }
  async processOne(record) {
    record.state = "processing";
    record.attempts += 1;
    record.updatedAt = this.clock().toISOString();
    await this.persist();
    try {
      const plaintext = await this.crypto.open(record.ownAgentAuthorityDid, record.envelope.sealed, intentAad(record.envelope));
      const intent = parseConversationIntent(plaintext);
      if (intent.kind === "conversation.sync" && intent.ownAgentId !== record.ownAgentId) {
        throw new IntentPolicyError2("sync ownAgentId does not match the selected Agent", "agent_mismatch");
      }
      const result = await this.executeIntent({
        intentId: record.intentId,
        principalId: record.principalId,
        ownAgentId: record.ownAgentId,
        ownAgentAuthorityDid: record.ownAgentAuthorityDid,
        intent
      });
      if (!result || result.ok !== true) throw new Error(result?.error || "Agent did not accept the Intent");
      record.state = result.state ?? "completed";
      record.conversationId = result.conversationId ?? intent.conversationId;
      record.remoteAgentId = result.remoteAgentId ?? intent.targetAgentId ?? intent.peerAgentId;
      record.envelope = void 0;
      record.lastError = void 0;
      record.updatedAt = this.clock().toISOString();
      if (record.conversationId) this.bindBrowserView(record, record.conversationId);
      await this.persist();
      for (const view of result.views ?? []) {
        try {
          await this.publishView(record, view);
        } catch (viewError) {
          this.logger.warn?.(`iFlow Web Intent ${record.intentId}: private view deferred (${messageOf(viewError)})`);
        }
      }
    } catch (error) {
      if (error instanceof IntentPolicyError2 || error instanceof IntentEnvelopeError) {
        record.state = "denied";
        record.envelope = void 0;
        record.lastError = error.code;
        record.updatedAt = this.clock().toISOString();
        await this.persist();
        try {
          await this.publishView(record, { version: 1, kind: "conversation.status", conversationId: record.conversationId ?? "", state: "failed", code: error.code });
        } catch (viewError) {
          this.logger.warn?.(`iFlow Web Intent ${record.intentId}: refusal view deferred (${messageOf(viewError)})`);
        }
        return;
      }
      record.state = "queued";
      record.lastError = "delivery_failed";
      record.updatedAt = this.clock().toISOString();
      await this.persist();
      this.logger.log?.(`iFlow Web Intent ${record.intentId}: delivery deferred (${messageOf(error)})`);
    }
  }
  bindBrowserView(record, conversationId) {
    const key = `${record.principalId}\0${record.ownAgentId}\0${record.browserSessionId}\0${conversationId}`;
    const now = this.clock();
    this.data.viewBindings = this.data.viewBindings.filter((binding) => binding.key !== key);
    this.data.viewBindings.push({
      key,
      principalId: record.principalId,
      ownAgentId: record.ownAgentId,
      browserSessionId: record.browserSessionId,
      conversationId,
      anchorIntentId: record.intentId,
      viewPublicKey: record.viewPublicKey,
      expiresAt: new Date(now.getTime() + VIEW_TTL_MS).toISOString()
    });
  }
  async publishView(recordOrBinding, payload) {
    const now = this.clock();
    const conversationId = payload.conversationId || recordOrBinding.conversationId;
    const envelope = {
      version: 1,
      kind: "browser.view",
      routing: {
        deliveryId: `ivw_${crypto.randomUUID()}`,
        intentId: recordOrBinding.intentId ?? recordOrBinding.anchorIntentId,
        principalId: recordOrBinding.principalId,
        browserSessionId: recordOrBinding.browserSessionId,
        viewKeyId: await this.crypto.keyId(recordOrBinding.viewPublicKey),
        ...conversationId ? { conversationId } : {},
        ...recordOrBinding.ownAgentId ? { ownAgentId: recordOrBinding.ownAgentId } : {},
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + VIEW_TTL_MS).toISOString()
      },
      sealed: ""
    };
    envelope.sealed = await this.crypto.seal(recordOrBinding.viewPublicKey, JSON.stringify(payload), browserViewAad(envelope));
    await this.postView(envelope);
    return envelope.routing.deliveryId;
  }
  /** Fan out one reply to every live browser session bound to this conversation. */
  async deliverReply(conversationId, message) {
    await this.open();
    this.pruneBindings();
    const bindings = this.data.viewBindings.filter((binding) => binding.conversationId === conversationId);
    let delivered = 0;
    for (const binding of bindings) {
      try {
        await this.publishView(binding, { version: 1, kind: "conversation.message", conversationId, message });
        delivered += 1;
      } catch (error) {
        this.logger.warn?.(`iFlow Web View ${binding.browserSessionId}: reply deferred (${messageOf(error)})`);
      }
    }
    await this.persist();
    return delivered > 0;
  }
  async status() {
    await this.open();
    return this.data.intents.map(({ envelope: _sealed, viewPublicKey: _key, ...record }) => ({ ...record }));
  }
};
function startLocalIntentPolling({ queue, settings, inbox, ack, intervalMs = 15e3, logger = console }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const current = settings();
      if (!current) return;
      const envelopes = await inbox(current);
      const persisted = await queue.accept(envelopes);
      if (persisted.length > 0) await ack(current, persisted);
      await queue.process();
    } catch (error) {
      logger.log?.(`iFlow Web Intent: poll skipped (${messageOf(error)})`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { tick, dispose: () => clearInterval(timer) };
}

// src/web/auth.ts
function normalizeWebLoginCode(value) {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[23456789ABCDEFGHJKMNPQRSTWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTWXYZ]{4}$/.test(code) ? code : void 0;
}
function ownedAgentBindings(declarations, principalId) {
  return (Array.isArray(declarations?.agents) ? declarations.agents : []).filter((agent) => agent && (!agent.principalId || agent.principalId === principalId)).map((agent) => ({
    agentId: agent.agentId,
    agentAuthorityDid: agent.did,
    ...agent.label ? { label: agent.label } : {},
    relationship: "owned",
    right: "send_as",
    scope: ["message"],
    ...agent.grantRef ? { grantRef: agent.grantRef } : {}
  })).sort((a, b) => a.agentId.localeCompare(b.agentId) || a.agentAuthorityDid.localeCompare(b.agentAuthorityDid));
}
function webChallengeSigningPayload({ challenge, nodeId, principal, agentBindings }) {
  return {
    version: 1,
    kind: "iflow.web-auth.challenge",
    challengeId: challenge.challengeId,
    browserSessionNonce: challenge.browserSessionNonce,
    origin: challenge.origin,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    principalId: principal.principalId,
    authorityDid: principal.authorityDid,
    authorityVersion: principal.authorityVersion,
    requestedScope: challenge.requestedScope,
    viewPublicKeyDigest: challenge.viewKeyId,
    nodeId,
    agentBindings
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

// src/conversation/store.ts
var CONVERSATIONS = "conversations.json";
var TRUST = "trust.json";
function conversationsPath(join2, workspace) {
  return join2(workspace, ".iflow", CONVERSATIONS);
}
function trustPath(join2, workspace) {
  return join2(workspace, ".iflow", TRUST);
}
var DEFAULT_TRUST = Object.freeze({ default: "ask", peers: {}, blocked: [] });
var TRUST_MODES = /* @__PURE__ */ new Set(["ask", "auto", "reject"]);
async function loadTrust(ctx, join2, workspace) {
  try {
    const resolved = await ctx.fs.resolve(trustPath(join2, workspace));
    const data = JSON.parse(await ctx.fs.readText(resolved));
    const mode = TRUST_MODES.has(data?.default) ? data.default : DEFAULT_TRUST.default;
    const peers = {};
    for (const [name, value] of Object.entries(data?.peers ?? {})) {
      if (TRUST_MODES.has(value)) peers[name] = value;
    }
    return {
      default: mode,
      peers,
      blocked: Array.isArray(data?.blocked) ? data.blocked.filter((d) => typeof d === "string") : []
    };
  } catch (error) {
    return { ...DEFAULT_TRUST, peers: {}, blocked: [] };
  }
}
async function saveTrust(ctx, join2, workspace, trust) {
  const resolved = await ctx.fs.resolve(trustPath(join2, workspace));
  await ctx.fs.writeText(resolved, JSON.stringify(trust, null, 2));
}
function trustDecision(trust, { peerLabel, signerDid, conversation } = {}) {
  if (signerDid && trust.blocked.includes(signerDid)) return "reject";
  if (peerLabel && trust.blocked.includes(peerLabel)) return "reject";
  if (conversation) {
    if (conversation.state === "rejected" || conversation.state === "closed") return "reject";
    if (conversation.state === "accepted" || conversation.state === "active") return "accept";
  }
  const named = (peerLabel && trust.peers[peerLabel]) ?? (signerDid && trust.peers[signerDid]);
  const mode = named ?? trust.default;
  if (mode === "auto") return "accept";
  if (mode === "reject") return "reject";
  return "ask";
}
function messageDigest(text) {
  return "sha256:" + signingDigest(typeof text === "string" ? text : String(text ?? ""));
}
async function loadConversations(ctx, join2, workspace) {
  try {
    const resolved = await ctx.fs.resolve(conversationsPath(join2, workspace));
    const data = JSON.parse(await ctx.fs.readText(resolved));
    const conversations = {};
    for (const [id, value] of Object.entries(data?.conversations ?? {})) {
      if (!value || typeof value !== "object") continue;
      conversations[id] = normalize(id, value);
    }
    return { conversations };
  } catch (error) {
    return { conversations: {} };
  }
}
async function saveConversations(ctx, join2, workspace, store) {
  const resolved = await ctx.fs.resolve(conversationsPath(join2, workspace));
  await ctx.fs.writeText(resolved, JSON.stringify(store, null, 2));
}
function normalize(id, value) {
  return {
    conversationId: id,
    localAgentId: typeof value.localAgentId === "string" ? value.localAgentId : null,
    localAgentAuthorityDid: typeof value.localAgentAuthorityDid === "string" ? value.localAgentAuthorityDid : null,
    peerAgentId: typeof value.peerAgentId === "string" ? value.peerAgentId : typeof value.peer === "string" ? value.peer : null,
    peerAgentAuthorityDid: typeof value.peerAgentAuthorityDid === "string" ? value.peerAgentAuthorityDid : typeof value.peerDid === "string" ? value.peerDid : null,
    peer: typeof value.peer === "string" ? value.peer : null,
    peerDid: typeof value.peerDid === "string" ? value.peerDid : null,
    mode: value.mode === "assisted" ? "assisted" : "direct",
    active: value.active !== false,
    state: typeof value.state === "string" ? value.state : "pending",
    binding: value.binding && typeof value.binding === "object" ? value.binding : null,
    pendingTask: value.pendingTask ?? null,
    preview: typeof value.preview === "string" ? value.preview : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : (/* @__PURE__ */ new Date()).toISOString(),
    seenMessageIds: Array.isArray(value.seenMessageIds) ? value.seenMessageIds.slice(-SEEN_LIMIT) : [],
    outbound: Array.isArray(value.outbound) ? value.outbound.slice(-OUTBOUND_LIMIT) : [],
    deliveries: Array.isArray(value.deliveries) ? value.deliveries.slice(-DELIVERY_LIMIT) : [],
    drafts: Array.isArray(value.drafts) ? value.drafts.slice(-DRAFT_LIMIT) : []
  };
}
var SEEN_LIMIT = 200;
var OUTBOUND_LIMIT = 50;
var DELIVERY_LIMIT = 50;
var DRAFT_LIMIT = 20;
var OUTBOUND_STATES = Object.freeze(["queued", "delivered", "accepted", "rejected", "expired", "unknown"]);
function newConversation(id, {
  peer,
  peerDid,
  localAgentId,
  localAgentAuthorityDid,
  peerAgentId,
  peerAgentAuthorityDid,
  mode,
  state,
  preview,
  now
}) {
  const at = now ?? (/* @__PURE__ */ new Date()).toISOString();
  return {
    conversationId: id,
    localAgentId: localAgentId ?? null,
    localAgentAuthorityDid: localAgentAuthorityDid ?? null,
    peerAgentId: peerAgentId ?? peer ?? null,
    peerAgentAuthorityDid: peerAgentAuthorityDid ?? peerDid ?? null,
    peer: peer ?? null,
    peerDid: peerDid ?? null,
    mode: mode === "assisted" ? "assisted" : "direct",
    active: true,
    state: state ?? "pending",
    binding: null,
    pendingTask: null,
    // Local only, and the reason IncomingRequest's excerpt never appears in a
    // projection: a person needs to see something to decide, and that
    // something is exactly the text we refuse to publish.
    preview: (preview ?? "").slice(0, 200),
    createdAt: at,
    updatedAt: at,
    seenMessageIds: [],
    outbound: [],
    deliveries: [],
    drafts: []
  };
}
function findActiveConversation(conversations, localAgentId, peerAgentId) {
  return Object.values(conversations).find(
    (conversation) => conversation.active !== false && conversation.localAgentId === localAgentId && conversation.peerAgentId === peerAgentId && conversation.state !== "closed" && conversation.state !== "rejected"
  );
}
function findConversationWithPeer(conversations, localAgentId, peer) {
  if (!peer) return void 0;
  return Object.values(conversations).find(
    (conversation) => conversation.active !== false && (conversation.peer === peer || conversation.peerAgentId === peer) && (conversation.localAgentId == null || localAgentId == null || conversation.localAgentId === localAgentId) && conversation.state !== "closed" && conversation.state !== "rejected"
  );
}
function activateConversation(conversations, conversation) {
  for (const candidate of Object.values(conversations)) {
    if (candidate.conversationId === conversation.conversationId) continue;
    if (candidate.localAgentId === conversation.localAgentId && candidate.peerAgentId === conversation.peerAgentId) {
      candidate.active = false;
    }
  }
  conversation.active = true;
  return conversation;
}
function markSeen(conversation, messageId) {
  if (!messageId) return true;
  if (conversation.seenMessageIds.includes(messageId)) return false;
  conversation.seenMessageIds.push(messageId);
  if (conversation.seenMessageIds.length > SEEN_LIMIT) {
    conversation.seenMessageIds.splice(0, conversation.seenMessageIds.length - SEEN_LIMIT);
  }
  return true;
}
function bindSession(conversation, { runtime, workspaceId, localSessionId, now }) {
  conversation.binding = { runtime, workspaceId, localSessionId };
  conversation.updatedAt = now ?? (/* @__PURE__ */ new Date()).toISOString();
  return conversation.binding;
}
function putDraft(conversation, { draftId, text, originIntentId, expiresAt, now }) {
  const at = now ?? (/* @__PURE__ */ new Date()).toISOString();
  conversation.drafts = (conversation.drafts ?? []).filter((draft) => draft.draftId !== draftId);
  conversation.drafts.push({ draftId, text, originIntentId, state: "pending", createdAt: at, expiresAt });
  if (conversation.drafts.length > DRAFT_LIMIT) conversation.drafts.splice(0, conversation.drafts.length - DRAFT_LIMIT);
  conversation.updatedAt = at;
  return conversation.drafts.at(-1);
}
function recordDelivery(conversation, { deliveryId, taskId, digest, now }) {
  const at = now ?? (/* @__PURE__ */ new Date()).toISOString();
  conversation.deliveries = (conversation.deliveries ?? []).filter((d) => d.deliveryId !== deliveryId);
  conversation.deliveries.push({ deliveryId, taskId, digest, state: "pending", receivedAt: at });
  if (conversation.deliveries.length > DELIVERY_LIMIT) {
    conversation.deliveries.splice(0, conversation.deliveries.length - DELIVERY_LIMIT);
  }
  conversation.updatedAt = at;
  return conversation.deliveries.at(-1);
}
function decideDelivery(conversation, deliveryId, decision, now) {
  const delivery = (conversation.deliveries ?? []).find((d) => d.deliveryId === deliveryId);
  if (!delivery || delivery.state !== "pending") return null;
  if (decision !== "accept" && decision !== "reject") return null;
  delivery.state = decision === "accept" ? "accepted" : "rejected";
  delivery.decidedAt = now ?? (/* @__PURE__ */ new Date()).toISOString();
  conversation.updatedAt = delivery.decidedAt;
  return delivery;
}
function pendingDeliveries(conversations) {
  const open = [];
  for (const conversation of Object.values(conversations)) {
    for (const delivery of conversation.deliveries ?? []) {
      if (delivery.state === "pending") open.push({ conversation, delivery });
    }
  }
  return open.sort((a, b) => String(b.delivery.receivedAt).localeCompare(String(a.delivery.receivedAt)));
}
function decideDraft(conversation, draftId, decision, now) {
  const draft = (conversation.drafts ?? []).find((candidate) => candidate.draftId === draftId);
  if (!draft || draft.state !== "pending") return null;
  if (draft.expiresAt && Date.parse(draft.expiresAt) <= Date.parse(now ?? (/* @__PURE__ */ new Date()).toISOString())) {
    draft.state = "expired";
    return null;
  }
  draft.state = decision === "confirm" ? "confirmed" : "cancelled";
  draft.decidedAt = now ?? (/* @__PURE__ */ new Date()).toISOString();
  conversation.updatedAt = draft.decidedAt;
  return draft;
}
function recordOutbound(conversation, { messageId, preview, now }) {
  if (!messageId) return;
  const at = now ?? (/* @__PURE__ */ new Date()).toISOString();
  conversation.outbound = (conversation.outbound ?? []).filter((m) => m.messageId !== messageId);
  conversation.outbound.push({
    messageId,
    state: "queued",
    sentAt: at,
    updatedAt: at,
    preview: (preview ?? "").slice(0, 120)
  });
  if (conversation.outbound.length > OUTBOUND_LIMIT) {
    conversation.outbound.splice(0, conversation.outbound.length - OUTBOUND_LIMIT);
  }
}
var OUTBOUND_RANK = { unknown: 0, queued: 1, expired: 2, delivered: 2, rejected: 3, accepted: 3 };
function markOutbound(conversation, messageId, next, now) {
  const entry = (conversation.outbound ?? []).find((m) => m.messageId === messageId);
  if (!entry) return false;
  if (!OUTBOUND_STATES.includes(next)) return false;
  if ((OUTBOUND_RANK[next] ?? 0) < (OUTBOUND_RANK[entry.state] ?? 0)) return false;
  if (entry.state === next) return false;
  entry.state = next;
  entry.updatedAt = now ?? (/* @__PURE__ */ new Date()).toISOString();
  return true;
}
function pendingOutbound(conversations) {
  const out = [];
  for (const conversation of Object.values(conversations)) {
    for (const message of conversation.outbound ?? []) {
      if (message.state === "queued" || message.state === "delivered") {
        out.push({ conversationId: conversation.conversationId, messageId: message.messageId });
      }
    }
  }
  return out;
}

// src/index.ts
var pluginRoot = fileURLToPath(new URL("../", import.meta.url));
var sourcePath = fileURLToPath(import.meta.url);
var index_default = {
  inject: ["tools", "webServer", "subprocess", "sandboxPolicy", "agents", "agentDefaultModel", "agentPresets", "sessionTitle", "sessions", "fs", "timer"],
  apply(ctx, config = {}) {
    const webServer = ctx.webServer;
    const agents = ctx.agents;
    const workspace = ctx.sandboxPolicy.workspaceRoot;
    const principalStoreRoot = typeof config.principalStoreRoot === "string" && config.principalStoreRoot.trim() ? config.principalStoreRoot.trim() : defaultPrincipalStoreRoot(join);
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
      // A private label for this runtime node. It is never an Agent identity
      // and must not appear as a Conversation participant or signature actor.
      alias: typeof config.nodeLabel === "string" && config.nodeLabel.trim() ? config.nodeLabel.trim() : typeof config.alias === "string" && config.alias.trim() ? config.alias.trim() : "DSH Node",
      // Seeded from plugin config so a node can come up with auth already on;
      // `iflow_set_token` still changes it at runtime.
      token: typeof config.token === "string" && config.token.length > 0 ? config.token : null,
      publicUrl: null,
      peers: /* @__PURE__ */ new Map(),
      tasks: /* @__PURE__ */ new Map(),
      outgoing: /* @__PURE__ */ new Map(),
      // Threads, by conversationId, and the local session each is bound to.
      // Loaded from disk below; see src/conversation/store.ts for why this
      // lives where it does.
      conversations: {},
      trust: { default: "ask", peers: {}, blocked: [] },
      // This node's own did:key, cached when the edge comes up so a
      // conversation participant can carry it without an await.
      nodeDid: null,
      // Stable owner/account identity. Never substituted with nodeDid.
      principalId: null,
      // The Community this node publishes to, which is also its relay. Cached
      // at edge start (and cleared when publishing stops) so the send path can
      // ask without reading a file mid-request.
      community: null,
      // did:key of every Agent an operator declared here, so the relay can be
      // told which Agents to route to this node.
      declaredAgentDids: {}
    };
    const nodeSettingsFile = join(workspace, ".iflow", "node.json");
    const nodeLabelReady = (async () => {
      try {
        const stored = JSON.parse(await ctx.fs.readText(await ctx.fs.resolve(nodeSettingsFile)));
        if (typeof stored.nodeLabel === "string" && stored.nodeLabel.trim()) state.alias = stored.nodeLabel.trim();
      } catch {
      }
    })();
    async function persistNodeLabel() {
      await ctx.fs.writeText(await ctx.fs.resolve(nodeSettingsFile), JSON.stringify({
        schemaVersion: 1,
        nodeLabel: state.alias,
        updatedAt: iso()
      }, null, 2));
    }
    const conversationWorkspaceFile = join(workspace, ".iflow", "conversation-workspace.json");
    const conversationWorkspace = { path: workspace, confirmed: false };
    const conversationWorkspaceReady = (async () => {
      if (typeof config.conversationWorkspace === "string" && config.conversationWorkspace.trim()) {
        conversationWorkspace.path = config.conversationWorkspace.trim();
        conversationWorkspace.confirmed = true;
        return;
      }
      try {
        const stored = JSON.parse(await ctx.fs.readText(await ctx.fs.resolve(conversationWorkspaceFile)));
        if (typeof stored.path === "string" && stored.path.trim()) {
          conversationWorkspace.path = stored.path.trim();
          conversationWorkspace.confirmed = stored.confirmed === true;
        }
      } catch {
      }
    })();
    async function requireConversationWorkspace() {
      await conversationWorkspaceReady;
      if (!conversationWorkspace.confirmed) {
        throw new Error("\u8BF7\u5148\u5728 iFlow \u7684\u201C\u6211\u201D\u9875\u9762\u786E\u8BA4\u4F1A\u8BDD\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u518D\u5F00\u59CB Agent \u5BF9\u8BDD");
      }
      return conversationWorkspace.path;
    }
    async function setConversationWorkspace(path) {
      if (typeof path !== "string" || !path.trim()) throw new Error("\u8BF7\u8F93\u5165\u5DE5\u4F5C\u76EE\u5F55\u7684\u7EDD\u5BF9\u8DEF\u5F84");
      const candidate = path.trim();
      if (!isAbsolute(candidate)) throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84");
      let stats;
      try {
        stats = statSync(candidate);
      } catch {
        throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u5B58\u5728\u6216\u65E0\u6CD5\u8BBF\u95EE");
      }
      if (!stats.isDirectory()) throw new Error("\u5DE5\u4F5C\u76EE\u5F55\u5FC5\u987B\u6307\u5411\u4E00\u4E2A\u6587\u4EF6\u5939");
      conversationWorkspace.path = candidate;
      conversationWorkspace.confirmed = true;
      await ctx.fs.writeText(await ctx.fs.resolve(conversationWorkspaceFile), JSON.stringify({
        schemaVersion: 1,
        path: candidate,
        confirmed: true,
        updatedAt: iso()
      }, null, 2));
      return { ok: true, path: candidate };
    }
    const scratchDir = `${workspace}/.iflow/tmp`;
    const scratchPath = (name) => {
      try {
        mkdirSync3(scratchDir, { recursive: true });
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
    async function enqueueOut(peer, prompt, thread = {}) {
      const mb = await loadMailbox();
      const duplicate = thread.messageId ? mb.outbox.some((o) => o.messageId === thread.messageId) : mb.outbox.some((o) => o.peer === peer && o.prompt === prompt && o.state !== "delivered");
      if (duplicate) return;
      mb.outbox.push({
        id: uid("mbox"),
        peer,
        prompt,
        taskId: "",
        conversationId: thread.conversationId ?? null,
        messageId: thread.messageId ?? null,
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
            // The peer's did:key, pinned on first sight. This is what a message
            // is sealed to, so it is the difference between end-to-end
            // encryption and the appearance of it: whoever can change this
            // value can read everything sent afterwards.
            did: typeof item.did === "string" && item.did.length > 0 ? item.did : null,
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
          did: entry.did ?? null,
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
    const conversationsReady = Promise.all([
      loadConversations(ctx, join, workspace).then((store) => {
        state.conversations = store.conversations;
      }),
      loadTrust(ctx, join, workspace).then((trust) => {
        state.trust = trust;
      })
    ]).catch((err) => {
      console.error("iFlow: could not load conversation state", err);
    });
    async function persistConversations() {
      try {
        await saveConversations(ctx, join, workspace, { conversations: state.conversations });
      } catch (err) {
        console.error("iFlow saveConversations failed", err);
      }
    }
    function pendingConversationCount() {
      return Object.values(state.conversations).filter((c) => c.state === "pending").length;
    }
    function summariseOutbound(conversation) {
      const sent = conversation.outbound ?? [];
      if (sent.length === 0) return void 0;
      const counts = {};
      for (const message of sent) counts[message.state] = (counts[message.state] ?? 0) + 1;
      return Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(", ");
    }
    function noteDelivery(conversation, task, text) {
      if (!conversation || !task || task.status?.state !== "TASK_STATE_COMPLETED" || !text) return;
      recordDelivery(conversation, {
        deliveryId: `del-${task.id}`,
        taskId: task.id,
        digest: messageDigest(text),
        now: iso()
      });
      void persistConversations();
    }
    function selfAgentId() {
      return edgeHandle ? edgeHandle.edge.descriptor.selfAgentId : `node-${state.alias}`;
    }
    function resolveConversation(conversationId, {
      peer,
      peerDid,
      localAgentId,
      localAgentAuthorityDid,
      peerAgentId,
      peerAgentAuthorityDid,
      mode,
      preview,
      state: initial
    } = {}) {
      let conversation = state.conversations[conversationId];
      if (!conversation) {
        conversation = newConversation(conversationId, {
          peer,
          peerDid,
          localAgentId,
          localAgentAuthorityDid,
          peerAgentId,
          peerAgentAuthorityDid,
          mode,
          preview,
          state: initial,
          now: iso()
        });
        state.conversations[conversationId] = conversation;
      } else {
        if (peer && !conversation.peer) conversation.peer = peer;
        if (peerDid && !conversation.peerDid) conversation.peerDid = peerDid;
        if (localAgentId && !conversation.localAgentId) conversation.localAgentId = localAgentId;
        if (localAgentAuthorityDid && !conversation.localAgentAuthorityDid) conversation.localAgentAuthorityDid = localAgentAuthorityDid;
        if (peerAgentId && !conversation.peerAgentId) conversation.peerAgentId = peerAgentId;
        if (peerAgentAuthorityDid && !conversation.peerAgentAuthorityDid) conversation.peerAgentAuthorityDid = peerAgentAuthorityDid;
        if (mode === "direct" || mode === "assisted") conversation.mode = mode;
        conversation.updatedAt = iso();
      }
      return conversation;
    }
    function participantsFor(conversation, initiator) {
      const mine = { agentId: selfAgentId(), did: state.nodeDid ?? void 0, role: "recipient", joinedAt: iso() };
      const theirs = {
        agentId: conversation.peer ?? "remote",
        did: conversation.peerDid ?? void 0,
        role: "initiator",
        joinedAt: iso()
      };
      if (initiator === "self") {
        mine.role = "initiator";
        theirs.role = "recipient";
      }
      return [mine, theirs];
    }
    async function recordExchange(side, text, label, peer, thread = {}) {
      if (edgeHandle) {
        try {
          await edgeHandle.edge.journal.record({
            type: "a2a.message",
            subject: { kind: "agent", id: peer || label },
            conversationId: thread.conversationId,
            payload: {
              direction: side === "self" ? "outbound" : "inbound",
              peer: peer || null,
              label,
              conversationId: thread.conversationId ?? null,
              messageId: thread.messageId ?? null,
              // Free text, and the most revealing this node holds. It stays
              // here: `text` is redacted before anything is published.
              text
            },
            evidence: { source: "a2a" }
          });
        } catch (err) {
          console.error("iFlow: could not journal an A2A message", err && err.message ? err.message : err);
        }
      }
      if (thread.conversationId) {
        const shared = {
          conversationId: thread.conversationId,
          messageId: thread.messageId ?? uid("msg"),
          contentDigest: messageDigest(text),
          actorType: thread.actorType ?? "agent",
          origin: thread.origin ?? (side === "self" ? "agent" : "a2a")
        };
        observeEdge(
          "conversation.message",
          (observer) => side === "self" ? observer.conversationMessageSent({ ...shared, toAgentId: peer || "remote" }) : observer.conversationMessageReceived({ ...shared, fromAgentId: peer || "remote" })
        );
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
    const relay = createRelayTransport({
      iflowId,
      scratchPath,
      async readBytes(path) {
        return readFileSync3(path);
      },
      async writeBytes(path, bytes) {
        writeFileSync3(path, bytes);
      },
      async post(url, payload, token) {
        return curlPost(url, payload, 30, token);
      },
      async get(url, token) {
        return JSON.parse(await curlGet(url, 30, token));
      },
      async identityHome(did) {
        const declarations = await loadDeclarations(ctx, join, workspace);
        return homeForSigning(join, workspace, declarations, { did }, state.nodeDid, principalStoreRoot);
      }
    });
    let webIntentQueue = null;
    function relaySettings() {
      const community = state.community;
      if (!community || !community.url || !community.token) return null;
      if (config.relay === false) return null;
      return { url: community.url, token: community.token };
    }
    async function sendViaRelay({
      peer,
      toAgentId,
      toAgentAuthorityDid,
      prompt,
      conversationId,
      messageId,
      fromAgent,
      contentOrigin = "agent",
      originIntentId
    }) {
      const settings = relaySettings();
      if (!settings) return { ok: false, error: "no relay configured" };
      if (!iflowIdSupports("seal")) {
        return {
          ok: false,
          error: `this node's identity binary predates sealed envelopes, so nothing can be sent through the relay. Delete ${join(IFI_BIN_DIR, IFI_BIN_NAME)} and run iflow_fetch_identity to get a current one.`
        };
      }
      if (!fromAgent?.agentId || !fromAgent?.did) {
        return { ok: false, error: "an explicitly declared sending Agent is required" };
      }
      if (!toAgentId || !toAgentAuthorityDid) {
        return { ok: false, error: "the target Agent id and current Authority DID are required" };
      }
      const fromDid = fromAgent.did;
      const request = {
        jsonrpc: "2.0",
        id: uid("req"),
        method: "SendMessage",
        params: {
          message: {
            messageId,
            contextId: conversationId,
            role: "ROLE_USER",
            parts: [{ text: prompt, mediaType: "text/plain" }]
          },
          configuration: { returnImmediately: true, historyLength: 0 },
          metadata: {
            from: fromAgent.label || fromAgent.agentId,
            fromAgentId: fromAgent.agentId,
            fromAgentAuthorityDid: fromAgent.did,
            fromLabel: fromAgent.label || fromAgent.agentId,
            toAgentId,
            toAgentAuthorityDid,
            machine: await getMachineName(),
            conversationId,
            messageId,
            contentOrigin,
            originIntentId,
            actorType: "agent",
            origin: originIntentId ? "web_intent" : "agent",
            principalId: state.principalId ?? void 0,
            // So the recipient can tell how this arrived. It changes nothing
            // about verification; it is for the operator reading a thread.
            via: "relay"
          }
        }
      };
      const body = JSON.stringify(request);
      let signature;
      const bodyPath = scratchPath("relay-sign.json");
      try {
        await ctx.fs.writeText(await ctx.fs.resolve(bodyPath), body);
        const signingHome = agentHome(join, workspace, fromAgent.agentId);
        signature = JSON.parse(
          await iflowId(["sign-file", "POST", "/a2a", bodyPath], signingHome, 20)
        );
      } catch (err) {
        return {
          ok: false,
          error: `the selected Agent could not sign this message: ${String(err?.message ?? err)}`
        };
      } finally {
        try {
          unlinkSync(bodyPath);
        } catch {
        }
      }
      const sealed = await relay.seal({
        toDid: toAgentAuthorityDid,
        body,
        signature,
        conversationId,
        messageId,
        fromDid
      });
      const answer = await relay.send({
        url: settings.url,
        token: settings.token,
        toDid: toAgentAuthorityDid,
        sealed,
        messageId,
        conversationId,
        fromDid
      });
      if (answer && answer.state === "queued") {
        const conversation = state.conversations[conversationId];
        if (conversation) {
          recordOutbound(conversation, { messageId, preview: prompt, now: iso() });
          void persistConversations();
        }
        return { ok: true };
      }
      return {
        ok: false,
        error: answer && answer.state === "unreachable" ? `${peer} has never announced itself to the relay, so there is nowhere to leave this` : `relay refused: ${JSON.stringify(answer)}`
      };
    }
    async function deliverFromRelay(opened, envelope) {
      const headers = {};
      if (opened.signature) headers["x-iflow-signature"] = JSON.stringify(opened.signature);
      const verified = await verifyInbound({ headers }, opened.body, { replayWindow: false });
      if (!verified.ok) {
        throw new Error(`signature verification failed for ${envelope.id}: ${verified.error}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(opened.body);
      } catch (err) {
        throw new Error(`relayed payload for ${envelope.id} is not JSON-RPC`);
      }
      if (parsed && typeof parsed.method === "string") {
        await dispatch(opened.body, verified.did, verified.grant, {
          via: "relay",
          // The answer goes back to whoever signed the request, not to whoever
          // the relay says handed it over.
          replyToDid: verified.did ?? envelope.from_did ?? null
        });
        return;
      }
      await acceptRelayedAnswer(parsed, envelope);
    }
    async function acceptRelayedAnswer(parsed, envelope) {
      const conversationId = envelope.conversation_id;
      const peer = conversationId ? state.conversations[conversationId]?.peer : void 0;
      if (parsed && parsed.error) {
        console.error(
          `iFlow relay: ${peer ?? envelope.from_did ?? "a peer"} answered with an error on ${conversationId ?? "an unknown conversation"}: ${parsed.error.code} ${parsed.error.message}`
        );
        return;
      }
      const task = parsed && parsed.result ? parsed.result.task : void 0;
      if (!task) throw new Error(`relayed answer for ${envelope.id} carries neither a task nor an error`);
      const conversation = conversationId ? state.conversations[conversationId] : void 0;
      if (conversation && parsed.id) {
        const outcome = task.status?.state === "TASK_STATE_REJECTED" ? "rejected" : "accepted";
        for (const sent of conversation.outbound ?? []) {
          if (sent.state === "queued" || sent.state === "delivered") markOutbound(conversation, sent.messageId, outcome, iso());
        }
        void persistConversations();
      }
      const text = taskText(task);
      if (text.length === 0) {
        console.log(
          `iFlow relay: ${peer ?? "peer"} finished ${conversationId ?? ""} in ${task.status?.state} with no output`
        );
        return;
      }
      if (conversationId) {
        try {
          await appendReplyToConversation(conversationId, text, envelope.id);
        } catch (error) {
          console.error(`iFlow: could not append reply to local Conversation ${conversationId} (${error?.message ?? error})`);
        }
      }
      await recordExchange("remote", text, `[agent:${peer ?? envelope.from_did ?? "remote"}]`, peer, {
        conversationId,
        messageId: envelope.id,
        actorType: "agent",
        origin: "a2a"
      });
      let deliveredToBrowser = false;
      if (webIntentQueue && conversationId) {
        try {
          deliveredToBrowser = await webIntentQueue.deliverReply(conversationId, {
            messageId: envelope.id,
            conversationId,
            authorAgentId: conversation?.peerAgentId ?? peer ?? envelope.from_did ?? "unknown",
            authorLabel: conversation?.peer ?? peer ?? "Agent",
            contentOrigin: "agent",
            role: "agent",
            text,
            createdAt: iso(),
            state: "delivered"
          });
        } catch (error) {
          console.error(
            `iFlow Web Intent: could not deliver private reply for ${conversationId} (${error?.message ?? error})`
          );
        }
      }
      if (deliveredToBrowser) {
        console.log(`iFlow relay: private answer delivered for ${conversationId}`);
      } else {
        console.log(`iFlow relay: answer on ${conversationId ?? "a conversation"} from ${peer ?? "a peer"}:
${text}`);
      }
    }
    async function replyOverRelay(taskId) {
      const task = state.tasks.get(taskId);
      if (!task || !task.replyTo) return;
      const settings = relaySettings();
      if (!settings) return;
      if (!iflowIdSupports("seal")) return;
      try {
        const body = JSON.stringify(rpcResult(task.replyTo.requestId, { task: snapshot(taskId, true) }));
        const messageId = uid("msg");
        const declarations = await loadDeclarations(ctx, join, workspace);
        const respondingAgent = declarations.agents.find((agent) => agent.agentId === task.replyTo.respondingAgentId);
        if (!respondingAgent) throw new Error("the responding Agent is no longer declared on this Node");
        const bodyPath = scratchPath(`relay-reply-${messageId}.json`);
        await ctx.fs.writeText(await ctx.fs.resolve(bodyPath), body);
        let signature;
        try {
          signature = JSON.parse(await iflowId(
            ["sign-file", "POST", "/a2a", bodyPath],
            agentHome(join, workspace, respondingAgent.agentId),
            20
          ));
        } finally {
          try {
            unlinkSync(bodyPath);
          } catch {
          }
        }
        const sealed = await relay.seal({
          toDid: task.replyTo.did,
          body,
          signature,
          conversationId: task.replyTo.conversationId,
          messageId,
          fromDid: respondingAgent.did
        });
        const answer = await relay.send({
          url: settings.url,
          token: settings.token,
          toDid: task.replyTo.did,
          sealed,
          messageId,
          conversationId: task.replyTo.conversationId,
          fromDid: respondingAgent.did
        });
        if (!answer || answer.state !== "queued") {
          console.error(`iFlow relay: could not return the answer for ${taskId}: ${JSON.stringify(answer)}`);
        }
      } catch (err) {
        console.error(`iFlow relay: could not return the answer for ${taskId}`, err && err.message ? err.message : err);
      }
    }
    function relayRoster() {
      const roster = [];
      for (const [agentId, did] of Object.entries(state.declaredAgentDids ?? {})) {
        if (did) roster.push({ did, label: agentId, state: "online" });
      }
      return roster;
    }
    let iflowIdResolved = null;
    let iflowIdFailure = null;
    let iflowIdLastAttempt = 0;
    const IFI_RETRY_MS = 5 * 60 * 1e3;
    let iflowIdHelp = null;
    const IFI_MIN_BYTES = 200 * 1024;
    const IFI_BIN_NAME = process.platform === "win32" ? "iflow-id.exe" : "iflow-id";
    const IFI_BIN_DIR = join(workspace, ".iflow", "bin");
    const IFI_SEARCH_PATHS = [
      process.env.IFLOW_ID_PATH,
      join(IFI_BIN_DIR, IFI_BIN_NAME),
      join(pluginRoot, "rust", "target", "release", IFI_BIN_NAME)
    ].filter(Boolean);
    const IFI_ASSETS = {
      "win32/x64": "iflow-id-windows-amd64.exe",
      "darwin/arm64": "iflow-id-darwin-arm64",
      "darwin/x64": "iflow-id-darwin-amd64",
      "linux/x64": "iflow-id-linux-amd64",
      "linux/arm64": "iflow-id-linux-arm64"
    };
    const IFI_ASSET = IFI_ASSETS[`${process.platform}/${process.arch}`];
    const IFI_BIN_URL = IFI_ASSET ? `https://github.com/Neo-Pz/dsh/releases/latest/download/${IFI_ASSET}` : void 0;
    function curlFetchArgs(dest, url) {
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
      const argv = ["curl", "-fsSL", "--retry", "3", "--retry-delay", "2", "-m", "180", "-o", dest, url];
      if (proxy) argv.push("--proxy", proxy);
      return argv;
    }
    function adoptIflowIdBinary(from, to, { force = false } = {}) {
      try {
        if (!force && statSync(to).size >= IFI_MIN_BYTES) return;
      } catch {
      }
      try {
        mkdirSync3(IFI_BIN_DIR, { recursive: true });
        copyFileSync(from, to);
        if (process.platform !== "win32") chmodSync(to, 493);
        console.log(`iFlow: kept a copy of the identity binary at ${to} so upgrades do not lose it`);
      } catch (err) {
        console.warn(`iFlow: could not keep a copy of the identity binary at ${to}:`, err && err.message ? err.message : err);
      }
    }
    async function fetchWithNode(dest, url) {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(18e4) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }
      writeFileSync3(dest, Buffer.from(await response.arrayBuffer()));
    }
    async function fetchIflowIdBinary() {
      if (!IFI_BIN_URL) {
        iflowIdFailure = `no prebuilt identity binary is published for ${process.platform}/${process.arch}. Build it with \`cargo build --release\` in the plugin's rust/ directory and point IFLOW_ID_PATH at the result.`;
        return false;
      }
      try {
        mkdirSync3(IFI_BIN_DIR, { recursive: true });
        const dest = join(IFI_BIN_DIR, IFI_BIN_NAME);
        let curlFailure = null;
        try {
          const dl = ctx.subprocess.spawn({
            argv: curlFetchArgs(dest, IFI_BIN_URL),
            cwd: workspace,
            stdio: { stdin: "ignore", stdout: { maxBytes: 1024 }, stderr: { maxBytes: 256 * 1024 } },
            // Every other spawn here gives the child a grace period. Without one
            // a slow download can be torn down mid-write, leaving a truncated
            // file that still looks like a binary to the next check.
            graceMs: 5e3
          });
          const out = await dl.done;
          const stderr = dl.collected.stderr ? dl.collected.stderr.readFrom(0).text : "";
          if (out.exitCode !== 0) {
            curlFailure = `curl exit ${String(out.exitCode)}: ${stderr.slice(0, 200) || IFI_BIN_URL}`;
          }
        } catch (err) {
          curlFailure = err && err.message ? err.message : String(err);
        }
        if (curlFailure) {
          try {
            await fetchWithNode(dest, IFI_BIN_URL);
          } catch (err) {
            iflowIdFailure = `download failed (${curlFailure}); the fallback also failed: ` + (err && err.message ? err.message : String(err));
            return false;
          }
        }
        let size = 0;
        try {
          size = statSync(dest).size;
        } catch {
          iflowIdFailure = `download reported success but wrote nothing to ${dest}`;
          return false;
        }
        if (size < IFI_MIN_BYTES) {
          iflowIdFailure = `downloaded ${size} bytes from ${IFI_BIN_URL}, too small to be the identity binary`;
          return false;
        }
        if (process.platform !== "win32") {
          try {
            chmodSync(dest, 493);
          } catch (err) {
            iflowIdFailure = `could not mark ${dest} executable: ${err && err.message ? err.message : String(err)}`;
            return false;
          }
        }
        iflowIdFailure = null;
        console.log(`iFlow: fetched the identity binary (${size} bytes) to ${dest}`);
        return true;
      } catch (err) {
        iflowIdFailure = `auto-fetch threw: ${err && err.message ? err.message : String(err)}`;
        console.error("iFlow iflow-id auto-fetch failed", err);
        return false;
      }
    }
    async function resolveIflowId(force = false) {
      if (force) {
        iflowIdResolved = null;
        iflowIdHelp = null;
      }
      if (iflowIdResolved) return iflowIdResolved;
      const cand = join(IFI_BIN_DIR, IFI_BIN_NAME);
      const present = [];
      for (const candidate of IFI_SEARCH_PATHS) {
        try {
          const resolved = await ctx.subprocess.resolveExecutable(candidate);
          if (resolved && !present.includes(resolved)) present.push(resolved);
        } catch (e) {
        }
      }
      for (const candidate of present) {
        const help = await probeIflowIdCommands(candidate);
        if (missingCapabilities(help).length === 0) {
          iflowIdResolved = candidate;
          iflowIdHelp = help;
          iflowIdFailure = null;
          if (candidate !== cand) adoptIflowIdBinary(candidate, cand, { force: true });
          return iflowIdResolved;
        }
      }
      const now = Date.now();
      const mayFetch = force || iflowIdLastAttempt === 0 || now - iflowIdLastAttempt >= IFI_RETRY_MS;
      if (mayFetch) {
        iflowIdLastAttempt = now;
        try {
          if (await fetchIflowIdBinary()) {
            const downloaded = await ctx.subprocess.resolveExecutable(cand);
            if (downloaded) {
              iflowIdResolved = downloaded;
              iflowIdHelp = await probeIflowIdCommands(downloaded);
              iflowIdFailure = null;
              warnAboutMissingCapabilities(downloaded);
              return iflowIdResolved;
            }
            iflowIdFailure = `downloaded to ${cand} but the host will not execute it`;
          }
        } catch (e) {
          iflowIdFailure = `auto-fetch threw: ${e && e.message ? e.message : String(e)}`;
        }
      }
      if (present.length > 0) {
        iflowIdResolved = present[0];
        iflowIdHelp = await probeIflowIdCommands(present[0]);
        iflowIdFailure = null;
        warnAboutMissingCapabilities(present[0]);
        return iflowIdResolved;
      }
      iflowIdResolved = false;
      return iflowIdResolved;
    }
    async function probeIflowIdCommands(bin) {
      try {
        const handle = ctx.subprocess.spawn({
          argv: [bin, "help"],
          cwd: workspace,
          stdio: { stdin: "ignore", stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
          graceMs: 5e3
        });
        await handle.done;
        return handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
      } catch (err) {
        return "";
      }
    }
    function warnAboutMissingCapabilities(bin) {
      const missing2 = missingCapabilities(iflowIdHelp ?? "");
      if (missing2.length === 0) return;
      console.warn(staleBinaryAdvice(bin, join(IFI_BIN_DIR, IFI_BIN_NAME), missing2));
    }
    function iflowIdSupports(command) {
      return iflowIdHelp !== null && helpAdvertises(iflowIdHelp, command);
    }
    async function iflowId(args, homeOrTimeout, maybeTimeout) {
      const home = typeof homeOrTimeout === "string" ? homeOrTimeout : void 0;
      const timeoutSec = typeof homeOrTimeout === "number" ? homeOrTimeout : maybeTimeout ?? 15;
      const bin = await resolveIflowId();
      if (!bin) {
        throw new Error(
          `iflow-id binary not found (looked in ${IFI_SEARCH_PATHS.join(", ")})` + (iflowIdFailure ? `: ${iflowIdFailure}` : "") + ". Run iflow_fetch_identity to retry now and see why."
        );
      }
      const handle = ctx.subprocess.spawn({
        // --home selects the Node, Agent, legacy, or user-level Authority
        // store explicitly (the binary appends .iflow itself). --node-home
        // keeps revocations node-wide, whichever identity is signing.
        argv: [bin, "--home", home ?? workspace, "--node-home", workspace, ...args],
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
    function readBody2(req) {
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
      const wasTerminal = TERMINAL_TASK_STATES.has(task.status.state);
      task.status = { state: stateName, timestamp: iso() };
      if (text !== void 0) {
        task.status.message = { messageId: uid("msg"), role: "ROLE_AGENT", parts: [{ text, mediaType: "text/plain" }] };
      }
      if (task.replyTo && !wasTerminal && TERMINAL_TASK_STATES.has(stateName)) {
        void replyOverRelay(taskId);
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
    async function runChild(taskId, text, controller, from, thread = {}) {
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
      await recordExchange("remote", text, `[agent:${from || "remote"}]`, from, thread);
      const conversation = thread.conversationId ? state.conversations[thread.conversationId] : void 0;
      const bound = conversation && conversation.binding ? conversation.binding.localSessionId : void 0;
      const setup = async (agentCtx) => {
        if (presetId) await ctx.agentPresets.mount(agentCtx, presetId);
      };
      let conversationCwd;
      try {
        conversationCwd = await requireConversationWorkspace();
      } catch (err) {
        setStatus(taskId, "TASK_STATE_AUTH_REQUIRED", err && err.message ? err.message : String(err));
        return;
      }
      const meta2 = { cwd: conversationCwd, ...presetId ? { agentPreset: presetId } : {} };
      let handle;
      let resumed = false;
      if (bound && typeof agents.resume === "function") {
        try {
          handle = await agents.resume({ resumeSessionId: bound, agentOptions, signal: controller.signal, setup });
          resumed = true;
        } catch (err) {
          console.log(
            `iFlow: conversation ${thread.conversationId} lost its local session ${bound}; starting a new one`
          );
        }
      }
      if (!handle) {
        const childId = `iflow-${uid("agent")}`;
        try {
          handle = await agents.create({ sessionId: childId, meta: meta2, agentOptions, signal: controller.signal, setup });
        } catch (err) {
          if (controller.signal.aborted) setStatus(taskId, "TASK_STATE_CANCELED", "The task was canceled.");
          else setStatus(taskId, "TASK_STATE_FAILED", `Failed to start the local agent: ${String(err && err.message ? err.message : err)}`);
          return;
        }
        if (conversation) {
          bindSession(conversation, {
            runtime: "dsh",
            workspaceId: conversationCwd,
            localSessionId: handle.agent.session.id ?? childId,
            now: iso()
          });
          void persistConversations();
        }
      }
      const child = handle.agent;
      if (!resumed) {
        try {
          ctx.sessionTitle.rename(child.session, from || conversation?.peerAgentId || "Agent");
        } catch (err) {
          console.error("iFlow rename failed", err);
        }
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
        observeEdge(
          "delivery.submitted",
          (observer) => observer.deliverySubmitted({
            taskId,
            deliveryId: `del-${taskId}`,
            // The declared Agent that answered, which is the one that may not
            // rule on this. `toAgentId` belongs to the request handler's scope,
            // not this one.
            byAgentId: conversation?.localAgentId ?? selfAgentId(),
            outputs: [{ kind: "artifact", id: task.artifacts[0].artifactId, summary: "Final answer" }],
            // A digest, never the answer. The requester holds the text and can
            // check it against this; nobody else learns anything from it.
            evidence: [messageDigest(textOut)]
          })
        );
        await recordExchange("self", textOut, `[agent:${thread.localAgentLabel || conversation?.localAgentId || "Agent"}]`, from, {
          conversationId: thread.conversationId,
          actorType: "agent",
          origin: "agent"
        });
      } else {
        setStatus(taskId, "TASK_STATE_FAILED", "The local agent produced no output.");
      }
      try {
        await recordTaskUsage(taskId, from, child.session.events, startedAt, selection && selection.model || void 0);
      } catch (e) {
      }
    }
    async function handleSendMessage(params, signerDid, grant, arrival) {
      const message = params && params.message ? params.message : void 0;
      if (!message) throw rpcException(-32602, "Invalid parameters", "SendMessageRequest.message is required");
      const text = messageText2(message);
      if (text.length === 0) throw rpcException(-32602, "Invalid parameters", "message.parts must contain at least one text or data part");
      const metadata = params && params.metadata && typeof params.metadata === "object" ? params.metadata : {};
      const fromAgentId = typeof metadata.fromAgentId === "string" && metadata.fromAgentId.length > 0 ? metadata.fromAgentId : typeof metadata.from === "string" && metadata.from.length > 0 ? metadata.from : void 0;
      const from = typeof metadata.fromLabel === "string" && metadata.fromLabel.length > 0 ? metadata.fromLabel : fromAgentId;
      const declaredAuthority = typeof metadata.fromAgentAuthorityDid === "string" ? metadata.fromAgentAuthorityDid : void 0;
      if (declaredAuthority && signerDid && declaredAuthority !== signerDid) {
        throw rpcException(-32003, "Agent Authority mismatch", "signed request does not match fromAgentAuthorityDid");
      }
      const toAgentId = typeof metadata.toAgentId === "string" ? metadata.toAgentId : void 0;
      const toAgentAuthorityDid = typeof metadata.toAgentAuthorityDid === "string" ? metadata.toAgentAuthorityDid : void 0;
      await conversationsReady;
      const taskId = `iflow-${uid("task")}`;
      const conversationId = typeof message.contextId === "string" && message.contextId.length > 0 && message.contextId || typeof metadata.conversationId === "string" && metadata.conversationId.length > 0 && metadata.conversationId || `conv-${uid("c")}`;
      const messageId = typeof message.messageId === "string" && message.messageId.length > 0 && message.messageId || typeof metadata.messageId === "string" && metadata.messageId.length > 0 && metadata.messageId || uid("msg");
      const actorType = metadata.contentOrigin === "human" || metadata.actorType === "human" ? "human" : "agent";
      const origin = typeof metadata.origin === "string" ? metadata.origin : "a2a";
      const known = state.conversations[conversationId];
      const conversation = resolveConversation(conversationId, {
        peer: from,
        peerDid: signerDid,
        localAgentId: toAgentId,
        localAgentAuthorityDid: toAgentAuthorityDid,
        peerAgentId: fromAgentId,
        peerAgentAuthorityDid: declaredAuthority || signerDid,
        preview: text
      });
      const firstSighting = !known;
      const fresh = markSeen(conversation, messageId);
      if (firstSighting) {
        observeEdge(
          "conversation.opened",
          (observer) => observer.conversationOpened({
            conversationId,
            initiatedBy: from || "remote",
            participants: participantsFor(conversation, "remote")
          })
        );
      }
      const decision = trustDecision(state.trust, { peerLabel: from, signerDid, conversation });
      const task = {
        id: taskId,
        contextId: conversationId,
        status: { state: "TASK_STATE_SUBMITTED", timestamp: iso() },
        artifacts: [],
        metadata: {
          from: from || "remote",
          machine: typeof metadata.machine === "string" && metadata.machine.length > 0 ? metadata.machine : null,
          prompt: text.slice(0, 400),
          receivedAt: iso(),
          conversationId,
          messageId,
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
      if (arrival && arrival.via === "relay" && arrival.replyToDid) {
        task.replyTo = {
          did: arrival.replyToDid,
          requestId: arrival.requestId,
          conversationId,
          respondingAgentId: toAgentId
        };
      }
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
      if (fresh) {
        const respondingAgentId = toAgentId || selfAgentId();
        observeEdge(
          "task.created",
          (observer) => observer.taskCreated({
            taskId,
            // Deliberately not an excerpt of the request. `task.*` and
            // `delivery.*` are publishable — unlike `conversation.*`, which the
            // outbox filter blocks structurally — so anything put here goes to
            // the Community. The peer is already named by
            // `a2a.request_received`; the words are not ours to forward.
            title: `Request from ${from}`,
            ownerAgentId: respondingAgentId
          })
        );
        observeEdge(
          "task.delegated",
          (observer) => observer.taskDelegated({
            taskId,
            toAgentId: respondingAgentId,
            fromAgentId: from,
            grantRef: grant ? grant.grantId : void 0,
            crossesOwnershipBoundary: true
          })
        );
      }
      const configuration = params && params.configuration ? params.configuration : {};
      if (!fresh) {
        setStatus(taskId, "TASK_STATE_COMPLETED", "This message was already delivered on this conversation.");
        return { task: snapshot(taskId, true) };
      }
      if (decision === "reject") {
        conversation.state = "rejected";
        void persistConversations();
        if (firstSighting || known?.state !== "rejected") {
          observeEdge(
            "conversation.rejected",
            (observer) => observer.conversationRejected({
              conversationId,
              rejectedBy: selfAgentId(),
              decidedBy: "policy"
            })
          );
        }
        setStatus(taskId, "TASK_STATE_REJECTED", "This node is not accepting conversations from that agent.");
        return { task: snapshot(taskId, true) };
      }
      if (decision === "ask") {
        conversation.state = "pending";
        conversation.pendingTask = { taskId, text, from: from ?? null, messageId, actorType, origin };
        conversation.preview = text.slice(0, 200);
        void persistConversations();
        setStatus(
          taskId,
          "TASK_STATE_AUTH_REQUIRED",
          "Waiting for the operator of this node to accept the conversation."
        );
        console.log(
          `iFlow: ${from || "an unknown agent"} wants to start conversation ${conversationId}. Run iflow_conversations to accept or reject it.`
        );
        return { task: snapshot(taskId, true) };
      }
      if (conversation.state === "pending") {
        observeEdge(
          "conversation.accepted",
          (observer) => observer.conversationAccepted({ conversationId, acceptedBy: selfAgentId(), decidedBy: "policy" })
        );
      }
      if (firstSighting) {
        observeEdge(
          "relation.recorded",
          (observer) => observer.relationRecorded({
            sourceAgentId: selfAgentId(),
            targetAgentId: from || "remote",
            type: "contacted"
          })
        );
      }
      conversation.state = "active";
      void persistConversations();
      const controller = makeAbortController();
      state.outgoing.set(taskId, { controller, done: void 0 });
      const done = runChild(taskId, text, controller, from, {
        conversationId,
        messageId,
        actorType,
        origin,
        localAgentLabel: toAgentId
      });
      state.outgoing.get(taskId).done = done;
      done.catch((err) => console.error(`iFlow task ${taskId} unhandled run error`, err));
      if (configuration.returnImmediately === true) return { task: snapshot(taskId, true) };
      await done.catch(() => {
      });
      return { task: snapshot(taskId, true) };
    }
    async function acceptConversation(conversationId, { decidedBy = "human" } = {}) {
      await conversationsReady;
      const conversation = state.conversations[conversationId];
      if (!conversation) return { ok: false, error: `unknown conversation: ${conversationId}` };
      if (conversation.state !== "pending") {
        return { ok: false, error: `conversation ${conversationId} is ${conversation.state}, not pending` };
      }
      conversation.state = "accepted";
      const parked = conversation.pendingTask;
      conversation.pendingTask = null;
      await persistConversations();
      observeEdge(
        "conversation.accepted",
        (observer) => observer.conversationAccepted({ conversationId, acceptedBy: selfAgentId(), decidedBy })
      );
      observeEdge(
        "relation.recorded",
        (observer) => observer.relationRecorded({
          sourceAgentId: selfAgentId(),
          targetAgentId: conversation.peer || "remote",
          type: "contacted"
        })
      );
      if (!parked) return { ok: true, conversationId, state: "accepted", delivered: false };
      const task = state.tasks.get(parked.taskId);
      if (!task) return { ok: true, conversationId, state: "accepted", delivered: false };
      conversation.state = "active";
      await persistConversations();
      const controller = makeAbortController();
      state.outgoing.set(parked.taskId, { controller, done: void 0 });
      const done = runChild(parked.taskId, parked.text, controller, parked.from ?? void 0, {
        conversationId,
        messageId: parked.messageId,
        actorType: parked.actorType,
        origin: parked.origin,
        localAgentLabel: conversation.localAgentId
      });
      state.outgoing.get(parked.taskId).done = done;
      done.catch((err) => console.error(`iFlow task ${parked.taskId} unhandled run error`, err));
      return { ok: true, conversationId, state: "active", delivered: true, taskId: parked.taskId };
    }
    async function rejectConversation(conversationId, reason) {
      await conversationsReady;
      const conversation = state.conversations[conversationId];
      if (!conversation) return { ok: false, error: `unknown conversation: ${conversationId}` };
      conversation.state = "rejected";
      const parked = conversation.pendingTask;
      conversation.pendingTask = null;
      await persistConversations();
      observeEdge(
        "conversation.rejected",
        (observer) => observer.conversationRejected({
          conversationId,
          rejectedBy: selfAgentId(),
          decidedBy: "human",
          reason
        })
      );
      if (parked && state.tasks.has(parked.taskId)) {
        setStatus(parked.taskId, "TASK_STATE_REJECTED", reason || "The operator declined this conversation.");
      }
      return { ok: true, conversationId, state: "rejected" };
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
    async function dispatch(body, signerDid, grant, arrival) {
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
            return rpcResult(id, await handleSendMessage(params, signerDid, grant, arrival && { ...arrival, requestId: id }));
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
    async function verifyInbound(req, body, { replayWindow = true } = {}) {
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
        if (replayWindow && typeof envelope.nonce === "string" && typeof envelope.timestamp === "number") {
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
        const body = await readBody2(req);
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
        lastSeen: { type: "integer" },
        did: { oneOf: [{ type: "string" }, { type: "null" }] }
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
        description: "iFlow: show the local A2A endpoint (AgentCard and JSON-RPC URLs), auth state, registered peers, sync version, conversations (and how many are waiting for you to accept), and active inbound tasks.",
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
              conversations: { type: "integer" },
              conversationsPending: { type: "integer" },
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
  conversations: ${value.conversations} (${value.conversationsPending} waiting for you)
  alias: ${value.alias}
  machine: ${value.machine}
  auth: ${value.authEnabled ? "enabled" : "off"}
  peers: ${value.peers.map((p) => `${p.name} \u2192 ${p.url}${p.healthy === void 0 ? "" : p.healthy ? " (online)" : " (offline)"}`).join("; ") || "none"}
  active inbound tasks: ${value.activeTasks}${renderWarnings(value.warnings)}`
          }]
        },
        async execute() {
          const base = state.publicUrl || `http://127.0.0.1:${webServer.port}`;
          await conversationsReady;
          const threads = Object.values(state.conversations);
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
            conversations: threads.length,
            conversationsPending: threads.filter((c) => c.state === "pending").length,
            authEnabled: state.token !== null,
            peers: [...state.peers.entries()].map(([name, entry]) => ({ name, url: entry.url, tokenSet: entry.token !== null, healthy: entry.healthy, lastSeen: entry.lastSeen, did: entry.did ?? null })),
            activeTasks: [...state.tasks.values()].filter((t) => !TERMINAL_TASK_STATES.has(t.status.state)).length
          };
        }
      }),
      defineTool({
        name: "iflow_set_alias",
        description: "iFlow: set this Runtime Node's private display label. It is stored locally and never substitutes for an Agent identity.",
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
          state.alias = typeof args.alias === "string" && args.alias.trim().length > 0 ? args.alias.trim() : "DSH Node";
          await persistNodeLabel();
          return { ok: true, alias: state.alias };
        }
      }),
      defineTool({
        name: "iflow_add_peer",
        description: "iFlow: register a remote A2A endpoint (typically another DSH machine running iFlow) so it can be called by name. Pass the base URL of the remote web server, e.g. http://192.168.1.20:3080. Optionally set the same shared token configured on the remote (iflow_set_token there).",
        parameters: {
          name: { type: "string", required: true, description: "Local alias for the peer." },
          url: { type: "string", required: true, description: "Base URL of the remote DSH web server, e.g. http://192.168.1.20:3080." },
          token: { type: "string", description: "Optional Bearer token the remote requires; defaults to the local shared token when unset." },
          did: { type: "string", description: "The peer's did:key, if you have checked it out of band. Pins it now instead of trusting the first one seen on the wire." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              name: { type: "string", required: true },
              url: { type: "string", required: true },
              tokenSet: { type: "boolean", required: true },
              did: { oneOf: [{ type: "string" }, { type: "null" }] },
              error: { type: "string" }
            }
          },
          render: (_args, value) => [{
            type: "text",
            text: value.ok ? `peer ${value.name} \u2192 ${value.url} (${value.tokenSet ? "token set" : "no token"})` + (value.did ? `
  identity pinned: ${didFingerprint(value.did)}` : "") : `iFlow: ${value.error}`
          }]
        },
        async execute(args) {
          await peersReady;
          const name = args.name.trim();
          const url = args.url.trim().replace(/\/+$/, "");
          let did = null;
          if (typeof args.did === "string" && args.did.length > 0) {
            if (!looksLikeDid(args.did)) return { ok: false, name, url, tokenSet: false, error: `not a did:key: ${args.did}` };
            did = args.did;
          }
          state.peers.set(name, { url, token: typeof args.token === "string" && args.token.length > 0 ? args.token : null, did, addedAt: iso() });
          await savePeers();
          probePeer(name, state.peers.get(name));
          return { ok: true, name, url, tokenSet: state.peers.get(name).token !== null, did };
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
            peers: [...state.peers.entries()].map(([name, entry]) => ({ name, url: entry.url, tokenSet: entry.token !== null, healthy: entry.healthy, lastSeen: entry.lastSeen, did: entry.did ?? null }))
          };
        }
      }),
      defineTool({
        name: "iflow_conversations",
        description: "iFlow: see conversations with other agents and answer the ones waiting on you. A first message from an unknown agent is held \u2014 no session, no model, no tools \u2014 until you accept it here. Actions: list (default), accept, reject, trust (auto-accept a peer from now on), block.",
        parameters: {
          action: { type: "string", description: "'list' | 'accept' | 'reject' | 'trust' | 'block'. Default 'list'." },
          conversationId: { type: "string", description: "Which conversation to accept or reject." },
          peer: { type: "string", description: "Peer name or did:key, for trust and block." },
          reason: { type: "string", description: "Optional reason recorded with a rejection." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              conversations: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    conversationId: { type: "string" },
                    peer: { type: "string" },
                    state: { type: "string" },
                    preview: { type: "string" },
                    boundSession: { type: "string" },
                    sent: { type: "string" },
                    updatedAt: { type: "string" }
                  }
                }
              },
              conversationId: { type: "string" },
              state: { type: "string" },
              delivered: { type: "boolean" },
              taskId: { type: "string" },
              trust: { type: "string" },
              error: { type: "string" }
            }
          },
          render: (args, value) => {
            if (!value.ok) return [{ type: "text", text: `iFlow: ${value.error}` }];
            if (Array.isArray(value.conversations)) {
              if (value.conversations.length === 0) return [{ type: "text", text: "no conversations yet" }];
              const lines = value.conversations.map((c) => {
                const waiting = c.state === "pending" ? "  \u2190 waiting for you" : "";
                const quote = c.preview ? `
    "${c.preview}"` : "";
                const sent = c.sent ? `
    sent: ${c.sent}` : "";
                return `- ${c.conversationId}  ${c.peer ?? "unknown"}  [${c.state}]${waiting}${quote}${sent}`;
              });
              const pending = value.conversations.filter((c) => c.state === "pending").length;
              const hint = pending > 0 ? `

${pending} waiting. Accept with: iflow_conversations action=accept conversationId=\u2026` : "";
              return [{ type: "text", text: lines.join("\n") + hint }];
            }
            if (value.trust) return [{ type: "text", text: `iFlow: ${args.peer} is now ${value.trust}` }];
            const tail = value.delivered ? " \u2014 the held message is running now" : "";
            return [{ type: "text", text: `iFlow: conversation ${value.conversationId} is ${value.state}${tail}` }];
          }
        },
        async execute(args) {
          await conversationsReady;
          const action = args.action || "list";
          if (action === "list") {
            const conversations = Object.values(state.conversations).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map((c) => ({
              conversationId: c.conversationId,
              peer: c.peer ?? void 0,
              state: c.state,
              preview: c.preview || void 0,
              // Shown locally and only locally: this is the Runtime-private
              // half of the mapping and it never goes on the wire.
              boundSession: c.binding ? c.binding.localSessionId : void 0,
              // What became of what this node sent. Without it a relayed send
              // answers "RELAYED" and there is no way to ask again.
              sent: summariseOutbound(c),
              updatedAt: c.updatedAt
            }));
            return { ok: true, conversations };
          }
          if (action === "accept") {
            if (!args.conversationId) return { ok: false, error: "accept needs a conversationId" };
            return await acceptConversation(args.conversationId, { decidedBy: "human" });
          }
          if (action === "reject") {
            if (!args.conversationId) return { ok: false, error: "reject needs a conversationId" };
            return await rejectConversation(args.conversationId, args.reason);
          }
          if (action === "trust" || action === "block") {
            if (!args.peer) return { ok: false, error: `${action} needs a peer name or did:key` };
            if (action === "trust") {
              state.trust.peers[args.peer] = "auto";
              state.trust.blocked = state.trust.blocked.filter((d) => d !== args.peer);
            } else {
              delete state.trust.peers[args.peer];
              if (!state.trust.blocked.includes(args.peer)) state.trust.blocked.push(args.peer);
            }
            try {
              await saveTrust(ctx, join, workspace, state.trust);
            } catch (err) {
              return { ok: false, error: `could not save trust settings: ${String(err && err.message ? err.message : err)}` };
            }
            return { ok: true, trust: action === "trust" ? "auto-accepted" : "blocked" };
          }
          return { ok: false, error: `unknown action: ${action}` };
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
              did: { oneOf: [{ type: "string" }, { type: "null" }] },
              didPinned: { type: "string" },
              error: { type: "string" }
            }
          },
          render: (_args, value) => [{
            type: "text",
            text: value.ok ? `AgentCard: ${value.name} v${value.version}
  ${value.description}
  interface: ${value.interfaceUrl} (${value.protocolBinding})
  skills: ${value.skills.join(", ")}` + (value.did ? `
  identity: ${value.did}
  fingerprint: ${didFingerprint(value.did)}` + (value.didPinned === "recorded" ? "\n  pinned. Messages are sealed to this key from now on, and a peer presenting a different one is refused." : "\n  matches the key already pinned for this peer.") : "\n  identity: none published \u2014 this peer cannot be sent sealed messages.") : `discovery failed: ${value.error}`
          }]
        },
        async execute(args) {
          await peersReady;
          const entry = resolvePeer(args.peer);
          if (!entry) return { ok: false, error: `unknown peer or invalid URL: ${args.peer}` };
          try {
            const text = await curlGet(`${entry.url}/.well-known/agent-card.json`, 15, entry.token);
            const card = JSON.parse(text);
            const iface = card.supportedInterfaces && card.supportedInterfaces.length > 0 ? card.supportedInterfaces[0] : {};
            const presented = card.identity && typeof card.identity.did === "string" ? card.identity.did : null;
            const registered = state.peers.get(args.peer);
            const settled = reconcileDid(args.peer, registered ? registered.did : null, presented);
            if (registered && settled.outcome === "recorded") {
              registered.did = settled.did;
              await savePeers();
            }
            return {
              ok: true,
              name: typeof card.name === "string" ? card.name : entry.url,
              description: typeof card.description === "string" ? card.description : "",
              version: typeof card.version === "string" ? card.version : "",
              interfaceUrl: typeof iface.url === "string" ? iface.url : `${entry.url}/a2a`,
              protocolBinding: typeof iface.protocolBinding === "string" ? iface.protocolBinding : "JSONRPC",
              skills: Array.isArray(card.skills) ? card.skills.map((s) => s && typeof s.name === "string" ? s.name : "").filter(Boolean) : [],
              did: settled.did,
              didPinned: settled.outcome
            };
          } catch (err) {
            if (err instanceof PinMismatchError) return { ok: false, error: err.message };
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
          maxWaitSeconds: { type: "integer", description: "Cap on how long to wait for completion. Default 600 (10 minutes), max 3600." },
          conversationId: { type: "string", description: "Continue this exact conversation. Omit to continue the open one with this peer; use iflow_conversations to list them." },
          newConversation: { type: "boolean", description: "Start a separate thread with this peer instead of continuing the open one. Default false." },
          fromAgentId: { type: "string", description: "Declared Agent that signs and sends. Required when this Node has more than one Agent." }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              peer: { type: "string", required: true },
              taskId: { type: "string" },
              conversationId: { type: "string" },
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
          const declarations = await loadDeclarations(ctx, join, workspace);
          const fromAgent = typeof args.fromAgentId === "string" && args.fromAgentId ? declarations.agents.find((agent) => agent.agentId === args.fromAgentId) : declarations.agents.length === 1 ? declarations.agents[0] : void 0;
          if (!fromAgent) {
            return {
              ok: false,
              peer: args.peer,
              error: declarations.agents.length > 1 ? "choose fromAgentId; a Node label cannot act as one of several Agents" : "declare an Agent before sending; the Node itself is not a Conversation participant"
            };
          }
          const base = entry.url;
          const token = entry.token;
          await conversationsReady;
          const explicitId = typeof args.conversationId === "string" && args.conversationId.length > 0 ? args.conversationId : null;
          const existing = explicitId || args.newConversation === true ? void 0 : findConversationWithPeer(state.conversations, selfAgentId(), args.peer);
          const conversationId = explicitId ?? existing?.conversationId ?? `conv-${uid("c")}`;
          const startingIt = !state.conversations[conversationId];
          const outbound = resolveConversation(conversationId, {
            peer: args.peer,
            // Recorded so the next send can scope the lookup to this Agent
            // rather than matching any thread that happens to name the peer.
            localAgentId: selfAgentId(),
            preview: args.prompt,
            // A thread this node opens is one it has agreed to by opening it.
            state: "accepted"
          });
          if (outbound.state === "pending") outbound.state = "accepted";
          const messageId = uid("msg");
          markSeen(outbound, messageId);
          void persistConversations();
          if (startingIt) {
            observeEdge(
              "conversation.opened",
              (observer) => observer.conversationOpened({
                conversationId,
                initiatedBy: selfAgentId(),
                participants: participantsFor(outbound, "self")
              })
            );
            observeEdge(
              "conversation.accepted",
              (observer) => observer.conversationAccepted({
                conversationId,
                acceptedBy: selfAgentId(),
                decidedBy: "policy"
              })
            );
            observeEdge(
              "relation.recorded",
              (observer) => observer.relationRecorded({
                sourceAgentId: selfAgentId(),
                targetAgentId: args.peer,
                type: "contacted"
              })
            );
          }
          const threadMeta = {
            conversationId,
            messageId,
            actorType: "human",
            origin: "keyboard"
          };
          const rpc = (method, params) => curlPost(`${base}/a2a`, { jsonrpc: "2.0", id: uid("req"), method, params }, 60, token);
          try {
            const mb = await loadMailbox();
            let dirty = false;
            for (const item of mb.outbox) {
              if (item.peer !== args.peer || item.state !== "queued") continue;
              const r = await rpc("SendMessage", {
                message: {
                  messageId: item.messageId ?? uid("msg"),
                  ...item.conversationId ? { contextId: item.conversationId } : {},
                  role: "ROLE_USER",
                  parts: [{ text: item.prompt, mediaType: "text/plain" }]
                },
                configuration: { returnImmediately: true, historyLength: 0 },
                metadata: {
                  from: fromAgent.label || fromAgent.agentId,
                  fromAgentId: fromAgent.agentId,
                  fromAgentAuthorityDid: fromAgent.did,
                  fromLabel: fromAgent.label || fromAgent.agentId,
                  machine: await getMachineName(),
                  ...item.conversationId ? { conversationId: item.conversationId } : {},
                  ...item.messageId ? { messageId: item.messageId } : {}
                }
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
              // `contextId` is the conversation. A peer that understands it
              // continues the same thread in the same local session; one that
              // does not simply echoes it back on the Task, as A2A already
              // requires.
              message: {
                messageId,
                contextId: conversationId,
                role: "ROLE_USER",
                parts: [{ text: args.prompt, mediaType: "text/plain" }]
              },
              configuration: { returnImmediately: true, historyLength: 0 },
              metadata: {
                from: fromAgent.label || fromAgent.agentId,
                fromAgentId: fromAgent.agentId,
                fromAgentAuthorityDid: fromAgent.did,
                fromLabel: fromAgent.label || fromAgent.agentId,
                toAgentId: args.peer,
                toAgentAuthorityDid: entry.did,
                machine: await getMachineName(),
                // Additive: an older peer ignores keys it does not know, so
                // none of this can break an existing bridge.
                conversationId,
                messageId,
                actorType: "human",
                origin: "keyboard",
                principalId: state.principalId ?? void 0
              }
            });
          } catch (err) {
            const directError = String(err && err.message ? err.message : err);
            const registered = state.peers.get(args.peer);
            const decision = relayDecision({
              peer: registered,
              directError,
              relayConfigured: Boolean(relaySettings())
            });
            if (decision.use) {
              try {
                const relayed = await sendViaRelay({
                  peer: args.peer,
                  toAgentId: args.peer,
                  toAgentAuthorityDid: registered.did,
                  prompt: args.prompt,
                  conversationId,
                  messageId,
                  fromAgent,
                  contentOrigin: "agent"
                });
                if (relayed.ok) {
                  try {
                    await recordExchange("self", args.prompt, `[agent:${fromAgent.label || fromAgent.agentId}]`, args.peer, threadMeta);
                  } catch (e) {
                  }
                  return {
                    ok: true,
                    peer: args.peer,
                    taskId: "",
                    conversationId,
                    state: "RELAYED",
                    text: "",
                    error: void 0
                  };
                }
                try {
                  await enqueueOut(args.peer, args.prompt, { conversationId, messageId });
                } catch (e) {
                }
                return { ok: false, peer: args.peer, taskId: "", conversationId, state: "QUEUED", error: `${decision.reason}, but the relay could not take it: ${relayed.error}` };
              } catch (relayErr) {
                try {
                  await enqueueOut(args.peer, args.prompt, { conversationId, messageId });
                } catch (e) {
                }
                return { ok: false, peer: args.peer, taskId: "", conversationId, state: "QUEUED", error: `relay failed: ${String(relayErr && relayErr.message ? relayErr.message : relayErr)}` };
              }
            }
            try {
              await enqueueOut(args.peer, args.prompt, { conversationId, messageId });
            } catch (e) {
            }
            return { ok: false, peer: args.peer, taskId: "", conversationId, state: "QUEUED", error: `peer offline; queued for redelivery. ${decision.reason}` };
          }
          if (response.error) return { ok: false, peer: args.peer, conversationId, error: `remote error ${response.error.code}: ${response.error.message}` };
          const result = response.result || {};
          const task = result.task;
          try {
            await recordExchange("self", args.prompt, `[agent:${fromAgent.label || fromAgent.agentId}]`, args.peer, threadMeta);
          } catch (e) {
          }
          const inbound = { conversationId, actorType: "agent", origin: "a2a" };
          if (!task) {
            const text2 = result.message ? partsText(result.message.parts) : "";
            if (text2.length > 0) try {
              await recordExchange("remote", text2, `[agent:${args.peer}]`, args.peer, inbound);
            } catch (e) {
            }
            return {
              ok: text2.length > 0,
              peer: args.peer,
              taskId: "",
              conversationId,
              state: "MESSAGE",
              text: text2,
              ...text2.length === 0 ? { error: "remote returned an empty message" } : {}
            };
          }
          if (args.waitForCompletion === false) return { ok: true, peer: args.peer, taskId: task.id, conversationId, state: task.status.state, text: "" };
          if (TERMINAL_TASK_STATES.has(task.status.state)) {
            const text2 = taskText(task);
            if (text2.length > 0) try {
              await recordExchange("remote", text2, `[agent:${args.peer}]`, args.peer, inbound);
            } catch (e) {
            }
            noteDelivery(outbound, task, text2);
            return {
              ok: task.status.state === "TASK_STATE_COMPLETED" && text2.length > 0,
              peer: args.peer,
              taskId: task.id,
              conversationId,
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
              if (poll.error) return { ok: false, peer: args.peer, taskId: task.id, conversationId, state: stateName, error: `GetTask error ${poll.error.code}: ${poll.error.message}` };
              if (poll.result && poll.result.task) {
                finalTask = poll.result.task;
                stateName = finalTask.status.state;
              }
            } catch (err) {
              return { ok: false, peer: args.peer, taskId: task.id, conversationId, state: stateName, error: `GetTask failed: ${String(err && err.message ? err.message : err)}` };
            }
          }
          if (!TERMINAL_TASK_STATES.has(stateName)) {
            const waiting = stateName === "TASK_STATE_AUTH_REQUIRED";
            return {
              ok: false,
              peer: args.peer,
              taskId: task.id,
              conversationId,
              state: stateName,
              error: waiting ? `${args.peer} has not accepted this conversation yet; it is waiting for a person there. The conversation stays open \u2014 retry on conversationId ${conversationId}.` : `timed out waiting for task ${task.id}`
            };
          }
          const text = taskText(finalTask);
          if (text.length > 0) try {
            await recordExchange("remote", text, `[${args.peer}]`, args.peer, inbound);
          } catch (e) {
          }
          noteDelivery(outbound, finalTask, text);
          return {
            ok: stateName === "TASK_STATE_COMPLETED" && text.length > 0,
            peer: args.peer,
            taskId: task.id,
            conversationId,
            state: stateName,
            text,
            ...text.length === 0 ? { error: `task ended in ${stateName} with no output` } : {}
          };
        }
      }),
      defineTool({
        name: "iflow_fetch_identity",
        description: "iFlow: retry fetching the iflow-id identity binary now and report what happened. Use this when the log says facts are being journaled UNSIGNED: without the binary this node has no key material, so its facts cannot be proven off-node.",
        parameters: {},
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              path: { type: "string" },
              did: { type: "string" },
              missing: { type: "array", items: { type: "string" } },
              error: { type: "string" }
            }
          },
          render: (_args, value) => [
            {
              type: "text",
              text: value.ok ? `iFlow identity ready: ${value.did ?? "no identity created yet"} (${value.path})` + ((value.missing ?? []).length > 0 ? `

But this binary cannot ${value.missing.join(" or ")}. It is the newest one available, so re-fetching will not help: the Release has not caught up with this plugin yet. Everything except the relay works.` : "") : `iFlow identity unavailable: ${value.error}`
            }
          ]
        },
        async execute() {
          const bin = await resolveIflowId(true);
          if (!bin) return { ok: false, error: iflowIdFailure ?? "the binary could not be resolved" };
          try {
            identityCache = null;
            const identity = await getIdentity();
            const missing2 = missingCapabilities(iflowIdHelp ?? "");
            return {
              ok: true,
              path: bin,
              ...identity.did ? { did: identity.did } : {},
              ...missing2.length > 0 ? { missing: missing2 } : {}
            };
          } catch (err) {
            return {
              ok: false,
              path: bin,
              error: `the binary at ${bin} did not answer 'show --json' as expected: ${err && err.message ? err.message : String(err)}`
            };
          }
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
    async function resolveCommunity() {
      const stored = await loadCommunitySettings(ctx, join, workspace);
      if (stored && stored.stopped) return void 0;
      if (stored) return stored;
      const fromConfig = config.community;
      if (fromConfig && fromConfig.url && fromConfig.token) {
        return {
          url: String(fromConfig.url),
          token: String(fromConfig.token),
          visibility: fromConfig.visibility === "full" ? "full" : "structural",
          intervalMs: Number(fromConfig.intervalMs) || 6e4
        };
      }
      return void 0;
    }
    async function startEdge() {
      const identity = await getIdentity();
      state.nodeDid = identity.did ?? null;
      const community = await resolveCommunity();
      state.community = community ?? null;
      const declarations = await loadDeclarations(ctx, join, workspace);
      state.principalId = declarations.principal?.principalId ?? null;
      state.declaredAgentDids = agentDidsOf(declarations);
      return installIFlowEdge(ctx, {
        workspace,
        alias: state.alias,
        version: state.syncVersion,
        nodeDid: identity.did,
        // A getter, not the value: the token can change after this call.
        token: () => state.token,
        capabilities: ["iflow.cap:task.run", "iflow.cap:tool.call", "iflow.cap:a2a.receive"],
        // The edge signs through the same binary the rest of the plugin uses,
        // so there is exactly one place that holds key material.
        runIflowId: (args, home) => iflowId(args, home),
        // Which Agents this node has declared, and which key each one signs
        // with. Read once per edge start: declaring an Agent restarts the edge,
        // so this cannot go stale behind the journal's back.
        agentDids: agentDidsOf(declarations),
        publicAgents: declarations.agents.map((agent) => ({
          agentId: agent.agentId,
          label: agent.label || agent.agentId,
          did: agent.did,
          capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : []
        })),
        resolveSigningHome: (context) => homeForSigning(join, workspace, declarations, context, identity.did, principalStoreRoot),
        writeScratch: async (name, bytes) => {
          const path = scratchPath(name);
          writeFileSync3(path, Buffer.from(bytes));
          return path;
        },
        allowedOrigins: config.hubOrigins ?? ["http://127.0.0.1:5174", "http://localhost:5174"],
        // Both default to off: a Hub can read this node's projections out of
        // the box, but it cannot cause work here until an operator says so.
        // These stay in config on purpose — a one-click switch for "accept
        // remote commands" is more dangerous in the hands of someone who does
        // not know what it means than an edit they have to look up.
        acceptCommands: config.acceptCommands === true,
        routeApprovals: config.routeApprovals === true,
        community
      });
    }
    let edgeStarting = null;
    async function restartEdge() {
      if (edgeStarting) await edgeStarting.catch(() => {
      });
      const previous = edgeHandle;
      edgeHandle = null;
      if (previous) previous.dispose();
      edgeStarting = startEdge();
      try {
        edgeHandle = await edgeStarting;
        console.log(`iFlow edge restarted: node ${edgeHandle.nodeId}`);
        return edgeHandle;
      } finally {
        edgeStarting = null;
      }
    }
    void (async () => {
      try {
        edgeStarting = startEdge();
        edgeHandle = await edgeStarting;
        console.log(`iFlow edge ready: node ${edgeHandle.nodeId}, journal .iflow/edge/origin.ndjson, projections on /iflow/projection/*`);
      } catch (err) {
        console.error("iFlow edge failed to start (A2A bridge is unaffected):", err && err.message ? err.message : err);
      } finally {
        edgeStarting = null;
      }
    })();
    ctx.effect(() => () => {
      if (edgeHandle) edgeHandle.dispose();
    });
    async function openConversationSession(conversation, peerLabel) {
      const selection = ctx.agentDefaultModel.currentSelection();
      const agentOptions = selection?.provider && selection?.model ? { provider: selection.provider, model: selection.model } : {};
      const controller = makeAbortController();
      let handle;
      let created = false;
      const bound = conversation.binding?.localSessionId;
      if (bound && typeof agents.resume === "function") {
        try {
          handle = await agents.resume({ resumeSessionId: bound, agentOptions, signal: controller.signal });
        } catch {
        }
      }
      if (!handle) {
        const conversationCwd = await requireConversationWorkspace();
        const sessionId = `iflow-${uid("agent")}`;
        handle = await agents.create({
          sessionId,
          // Keep the session in the normal DSH workspace conversation list.
          // The ConversationBinding carries the iFlow-specific identity; a
          // subagent origin is neither necessary nor correct here.
          meta: { cwd: conversationCwd },
          agentOptions,
          signal: controller.signal
        });
        bindSession(conversation, {
          runtime: "dsh",
          workspaceId: conversationCwd,
          localSessionId: handle.agent.session.id ?? sessionId,
          now: iso()
        });
        created = true;
        await persistConversations();
      }
      if (created) {
        try {
          ctx.sessionTitle.rename(handle.agent.session, peerLabel || conversation.peerAgentId || "Agent");
        } catch (error) {
          console.error("iFlow conversation title failed", error);
        }
      }
      return { handle, controller };
    }
    function appendWebHuman(session, text, messageId) {
      session.append("user/message", {
        id: messageId,
        role: "user",
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "iflow" }
      }, { surfaceOp: "append" });
    }
    function appendRemoteAgent(session, text, messageId) {
      session.append("assistant/message", {
        turn: 0,
        step: 0,
        message: {
          id: messageId,
          role: "assistant",
          content: [{ type: "text", text }],
          // `kind: 'model'` is not decoration. DSH validates every persisted
          // assistant message and requires a non-empty `source.kind`, then
          // requires it to be exactly `model` with a provider and a model.
          // Without it the append succeeds and the SESSION becomes unloadable
          // — `SessionPersistenceCorruptionError: message has invalid source`
          // — so the damage shows up later, on a session nobody was editing.
          source: { kind: "model", provider: "iflow", model: "remote-agent" }
        }
      }, { surfaceOp: "append" });
    }
    function eventText(event) {
      const message = event?.type === "assistant/message" ? event.data?.message : event?.data;
      return Array.isArray(message?.content) ? message.content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("") : "";
    }
    function privateMessages(conversation, events, cursor, limit) {
      const all = events.flatMap((event, index) => {
        if (event?.type !== "user/message" && event?.type !== "assistant/message") return [];
        const text = eventText(event);
        if (!text) return [];
        const human = event.type === "user/message";
        return [{
          index,
          messageId: event.data?.id ?? event.data?.message?.id ?? `session-${index}`,
          conversationId: conversation.conversationId,
          authorAgentId: human ? conversation.localAgentId : conversation.peerAgentId,
          authorLabel: human ? conversation.localAgentId || "You" : conversation.peer || conversation.peerAgentId || "Agent",
          contentOrigin: human ? "human" : "agent",
          role: human ? "human" : "agent",
          text,
          createdAt: event.at ?? conversation.updatedAt
        }];
      });
      const requestedEnd = cursor === void 0 ? all.length : Math.max(0, Math.min(Number(cursor) || 0, all.length));
      const start = Math.max(0, requestedEnd - limit);
      return {
        messages: all.slice(start, requestedEnd).map(({ index: _index, ...message }) => message),
        ...start > 0 ? { previousCursor: String(start) } : {},
        nextCursor: String(requestedEnd)
      };
    }
    async function sessionSnapshot(conversation, cursor, limit) {
      if (!conversation.binding?.localSessionId) return { messages: [], nextCursor: "0" };
      const opened = await openConversationSession(conversation, conversation.peer || conversation.peerAgentId);
      try {
        return privateMessages(conversation, opened.handle.agent.session.events ?? [], cursor, limit);
      } finally {
        try {
          await opened.handle.dispose();
        } catch {
        }
      }
    }
    async function appendReplyToConversation(conversationId, text, messageId) {
      await conversationsReady;
      const conversation = state.conversations[conversationId];
      if (!conversation || !markSeen(conversation, `reply:${messageId}`)) return false;
      const opened = await openConversationSession(conversation, conversation.peer || conversation.peerAgentId);
      try {
        appendRemoteAgent(opened.handle.agent.session, text, messageId);
      } finally {
        try {
          await opened.handle.dispose();
        } catch {
        }
      }
      conversation.updatedAt = iso();
      await persistConversations();
      return true;
    }
    async function executeWebConversationIntent({ intentId, ownAgentId, ownAgentAuthorityDid, intent }) {
      await conversationsReady;
      const declarations = await loadDeclarations(ctx, join, workspace);
      const fromAgent = declarations.agents.find((agent) => agent.agentId === ownAgentId && agent.did === ownAgentAuthorityDid);
      if (!fromAgent) throw new IntentEnvelopeError("selected Agent identity or Authority is unavailable", "agent_unavailable");
      if (intent.kind === "conversation.sync") {
        if (!intent.conversationId && !intent.peerAgentId) {
          const offset = Math.max(0, Number(intent.cursor) || 0);
          const visible = Object.values(state.conversations).filter((candidate) => candidate.localAgentId === ownAgentId).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
          const page = visible.slice(offset, offset + intent.limit);
          return {
            ok: true,
            views: [{
              version: 1,
              kind: "conversation.list",
              ownAgentId,
              conversations: page.map((candidate) => ({
                conversationId: candidate.conversationId,
                peerAgentId: candidate.peerAgentId,
                peerLabel: candidate.peer || candidate.peerAgentId || "Agent",
                mode: candidate.mode === "assisted" ? "assisted" : "direct",
                state: candidate.state,
                updatedAt: candidate.updatedAt
              })),
              ...offset + page.length < visible.length ? { nextCursor: String(offset + page.length) } : {}
            }]
          };
        }
        const conversation2 = intent.conversationId ? state.conversations[intent.conversationId] : findActiveConversation(state.conversations, ownAgentId, intent.peerAgentId);
        if (!conversation2 || conversation2.localAgentId !== ownAgentId) {
          throw new IntentPolicyError("Conversation is not owned by the selected Agent", "conversation_unavailable");
        }
        const snapshot2 = await sessionSnapshot(conversation2, intent.cursor, intent.limit);
        return {
          ok: true,
          conversationId: conversation2.conversationId,
          remoteAgentId: conversation2.peerAgentId,
          views: [{ version: 1, kind: "conversation.snapshot", conversationId: conversation2.conversationId, ...snapshot2 }]
        };
      }
      if (intent.kind === "conversation.draft.decide") {
        const conversation2 = state.conversations[intent.conversationId];
        if (!conversation2 || conversation2.localAgentId !== ownAgentId) {
          throw new IntentPolicyError("Draft is not owned by the selected Agent", "draft_unavailable");
        }
        const draft = decideDraft(conversation2, intent.draftId, intent.decision, iso());
        if (!draft) throw new IntentPolicyError("Draft is missing, expired or already decided", "draft_unavailable");
        await persistConversations();
        if (intent.decision === "cancel") {
          return {
            ok: true,
            conversationId: conversation2.conversationId,
            remoteAgentId: conversation2.peerAgentId,
            views: [{ version: 1, kind: "conversation.status", conversationId: conversation2.conversationId, state: "cancelled" }]
          };
        }
        const messageId = `msg-${intent.draftId}`;
        const outcome2 = await sendViaRelay({
          peer: conversation2.peer || conversation2.peerAgentId,
          toAgentId: conversation2.peerAgentId,
          toAgentAuthorityDid: conversation2.peerAgentAuthorityDid,
          prompt: draft.text,
          conversationId: conversation2.conversationId,
          messageId,
          fromAgent,
          contentOrigin: "agent",
          originIntentId: draft.originIntentId
        });
        if (!outcome2?.ok) throw new Error(outcome2?.error || "Assisted draft could not be queued");
        recordOutbound(conversation2, { messageId, preview: draft.text, now: iso() });
        await persistConversations();
        return {
          ok: true,
          state: "sent",
          conversationId: conversation2.conversationId,
          remoteAgentId: conversation2.peerAgentId,
          views: [{ version: 1, kind: "conversation.status", conversationId: conversation2.conversationId, messageId, state: "sending" }]
        };
      }
      let conversation = intent.conversationId ? state.conversations[intent.conversationId] : void 0;
      if (!conversation && !intent.conversationId) {
        conversation = findActiveConversation(state.conversations, ownAgentId, intent.targetAgentId);
      }
      const starting = !conversation;
      const conversationId = conversation?.conversationId ?? intent.conversationId ?? `conv-${uid("c")}`;
      conversation = resolveConversation(conversationId, {
        peer: intent.targetAgentId,
        peerDid: intent.targetAgentAuthorityDid,
        localAgentId: ownAgentId,
        localAgentAuthorityDid: ownAgentAuthorityDid,
        peerAgentId: intent.targetAgentId,
        peerAgentAuthorityDid: intent.targetAgentAuthorityDid,
        mode: intent.mode,
        preview: intent.text,
        state: "accepted"
      });
      if (conversation.localAgentId !== ownAgentId || conversation.peerAgentId !== intent.targetAgentId) {
        throw new IntentPolicyError("Conversation participants cannot be changed", "conversation_mismatch");
      }
      activateConversation(state.conversations, conversation);
      if (starting) conversation.state = "accepted";
      const isNewIntent = markSeen(conversation, `intent:${intentId}`);
      const opened = await openConversationSession(conversation, conversation.peer || conversation.peerAgentId);
      try {
        if (intent.mode === "assisted") {
          if (!isNewIntent) throw new IntentPolicyError("Assisted Intent was already processed", "duplicate_intent");
          const before = opened.handle.agent.session.events?.length ?? 0;
          opened.handle.agent.followup({
            id: intentId,
            role: "user",
            content: [{ type: "text", text: intent.text }],
            source: { kind: "plugin", plugin: "iflow" }
          });
          await opened.handle.agent.whenIdle();
          const generated = blocksToText(foldOutput((opened.handle.agent.session.events ?? []).slice(before)));
          if (!generated) throw new Error("Own Agent produced no Assisted draft");
          const draftId = uid("draft");
          putDraft(conversation, {
            draftId,
            text: generated,
            originIntentId: intentId,
            expiresAt: new Date(Date.now() + 30 * 60 * 1e3).toISOString(),
            now: iso()
          });
          await persistConversations();
          return {
            ok: true,
            state: "draft_pending",
            conversationId,
            remoteAgentId: intent.targetAgentId,
            views: [
              { version: 1, kind: "conversation.bound", conversationId, peerAgentId: intent.targetAgentId },
              { version: 1, kind: "conversation.draft", conversationId, draftId, text: generated },
              { version: 1, kind: "conversation.status", conversationId, state: "draft_pending" }
            ]
          };
        }
        if (isNewIntent) appendWebHuman(opened.handle.agent.session, intent.text, intentId);
      } finally {
        try {
          await opened.handle.dispose();
        } catch {
        }
      }
      const outcome = await sendViaRelay({
        peer: intent.targetAgentId,
        toAgentId: intent.targetAgentId,
        toAgentAuthorityDid: intent.targetAgentAuthorityDid,
        prompt: intent.text,
        conversationId,
        messageId: intentId,
        fromAgent,
        contentOrigin: "human",
        originIntentId: intentId
      });
      if (!outcome?.ok) throw new Error(outcome?.error || "Direct message could not be queued");
      recordOutbound(conversation, { messageId: intentId, preview: intent.text, now: iso() });
      await persistConversations();
      await recordExchange("self", intent.text, `[agent:${fromAgent.label || fromAgent.agentId}]`, intent.targetAgentId, {
        conversationId,
        messageId: intentId,
        actorType: "human",
        origin: "web_intent"
      });
      return {
        ok: true,
        state: "sent",
        conversationId,
        remoteAgentId: intent.targetAgentId,
        views: [
          { version: 1, kind: "conversation.bound", conversationId, peerAgentId: intent.targetAgentId },
          {
            version: 1,
            kind: "conversation.message",
            conversationId,
            message: {
              messageId: intentId,
              conversationId,
              authorAgentId: ownAgentId,
              authorLabel: fromAgent.label || fromAgent.agentId,
              contentOrigin: "human",
              role: "human",
              text: intent.text,
              createdAt: iso(),
              state: "sending"
            }
          },
          { version: 1, kind: "conversation.status", conversationId, messageId: intentId, state: "sending" }
        ]
      };
    }
    const webIntentFile = join(workspace, ".iflow", "web-intents.json");
    const webIntentStore = {
      async read() {
        try {
          return JSON.parse(await ctx.fs.readText(await ctx.fs.resolve(webIntentFile)));
        } catch (error) {
          if (error?.code === "ENOENT" || /not found|no such file/i.test(String(error?.message ?? error))) return void 0;
          throw error;
        }
      },
      async write(value) {
        await ctx.fs.writeText(await ctx.fs.resolve(webIntentFile), JSON.stringify(value, null, 2));
      }
    };
    webIntentQueue = new LocalIntentQueue({
      store: webIntentStore,
      clock: () => /* @__PURE__ */ new Date(),
      async isAgentAvailable(agentId, authorityDid) {
        const declarations = await loadDeclarations(ctx, join, workspace);
        return declarations.agents.some((agent) => agent.agentId === agentId && agent.did === authorityDid);
      },
      crypto: {
        async open(did, sealed, aad) {
          const declarations = await loadDeclarations(ctx, join, workspace);
          const agent = declarations.agents.find((candidate) => candidate.did === did);
          if (!agent) throw new IntentEnvelopeError("selected Agent is not declared on this Node", "agent_unavailable");
          const sealedPath = scratchPath(`web-intent-${Date.now()}.bin`);
          const plainPath = scratchPath(`web-intent-${Date.now()}.json`);
          writeFileSync3(sealedPath, Buffer.from(sealed, "base64url"));
          try {
            await iflowId(["open", sealedPath, plainPath, aad], agentHome(join, workspace, agent.agentId), 20);
            return readFileSync3(plainPath, "utf8");
          } catch {
            throw new IntentEnvelopeError("Intent was not sealed for the selected Agent or its routing was altered");
          } finally {
            try {
              unlinkSync(sealedPath);
            } catch {
            }
            try {
              unlinkSync(plainPath);
            } catch {
            }
          }
        },
        async seal(recipientDid, plaintext, aad) {
          const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
          const plainPath = scratchPath(`browser-view-${stamp}.json`);
          const sealedPath = scratchPath(`browser-view-${stamp}.bin`);
          writeFileSync3(plainPath, plaintext);
          try {
            await iflowId(["seal", recipientDid, plainPath, sealedPath, aad], 20);
            return Buffer.from(readFileSync3(sealedPath)).toString("base64url");
          } finally {
            try {
              unlinkSync(plainPath);
            } catch {
            }
            try {
              unlinkSync(sealedPath);
            } catch {
            }
          }
        },
        async keyId(publicKey) {
          return createHash("sha256").update(publicKey, "utf8").digest("hex");
        }
      },
      executeIntent: executeWebConversationIntent,
      async postView(view) {
        const settings = relaySettings();
        if (!settings) throw new Error("Community connection is unavailable");
        await curlPost(`${settings.url}/v1/edge/browser-views`, view, 30, settings.token);
      },
      logger: console
    });
    const localIntentPolling = startLocalIntentPolling({
      queue: webIntentQueue,
      settings: relaySettings,
      async inbox({ url, token }) {
        const answer = JSON.parse(await curlGet(`${url}/v1/edge/intents?limit=25`, 30, token));
        return Array.isArray(answer?.intents) ? answer.intents : [];
      },
      async ack({ url, token }, intentIds) {
        return curlPost(`${url}/v1/edge/intents/ack`, { intentIds }, 30, token);
      },
      intervalMs: Number(config.webIntentIntervalMs) || 15e3,
      logger: console
    });
    ctx.effect(() => localIntentPolling.dispose);
    const stopRelayPolling = startRelayPolling({
      transport: relay,
      settings: relaySettings,
      agents: relayRoster,
      deliver: deliverFromRelay,
      pending: () => pendingOutbound(state.conversations),
      onStatus: (conversationId, messageId, reported) => {
        const conversation = state.conversations[conversationId];
        if (!conversation) return;
        if (markOutbound(conversation, messageId, reported, iso())) void persistConversations();
      },
      intervalMs: Number(config.relayIntervalMs) || 15e3
    });
    ctx.effect(() => stopRelayPolling);
    const COMMUNITY_DEFAULT_URL = "https://api.iflowone.com";
    let pendingClaim = null;
    async function communityBaseUrl() {
      const current = await resolveCommunity();
      if (current && current.url) return current.url.replace(/\/+$/, "");
      const configured = config.community && config.community.url;
      return String(configured || COMMUNITY_DEFAULT_URL).replace(/\/+$/, "");
    }
    async function communityFetch(path, body) {
      const base = await communityBaseUrl();
      const out = await curlRaw("POST", `${base}${path}`, body, 30, null);
      return JSON.parse(out);
    }
    async function confirmWebLogin(userCode) {
      const code = normalizeWebLoginCode(userCode);
      if (!code) {
        return { ok: false, error: "\u8BF7\u8F93\u5165 iFlowOne Web \u663E\u793A\u7684 8 \u4F4D\u77ED\u7801" };
      }
      const community = await resolveCommunity();
      if (!community?.url || !community?.token) return { ok: false, error: "\u8FD9\u4E2A\u8282\u70B9\u5C1A\u672A\u8FDE\u63A5 Community" };
      const declarations = await loadDeclarations(ctx, join, workspace);
      const principal = declarations.principal;
      if (!principal || principal.legacy || !principal.principalId) {
        return { ok: false, error: "\u8BF7\u5148\u58F0\u660E\u3001\u7ED1\u5B9A\u6216\u8FC1\u79FB\u4E00\u4E2A\u7A33\u5B9A Principal" };
      }
      if (!edgeHandle?.nodeId) return { ok: false, error: "iFlow Edge \u5C1A\u672A\u5C31\u7EEA" };
      try {
        const base = community.url.replace(/\/+$/, "");
        const challenge = JSON.parse(
          await curlGet(
            `${base}/v1/edge/auth/challenges?userCode=${encodeURIComponent(code)}`,
            30,
            community.token
          )
        );
        const agentBindings = ownedAgentBindings(declarations, principal.principalId);
        const payload = webChallengeSigningPayload({
          challenge,
          nodeId: edgeHandle.nodeId,
          principal,
          agentBindings
        });
        const signPath = scratchPath(`web-login-${challenge.challengeId}.bin`);
        writeFileSync3(signPath, Buffer.from(canonicalBytes(payload)));
        const signed = JSON.parse(
          await iflowId(
            ["sign-blob", signPath],
            authorityHome(join, principalStoreRoot, principal.principalId, principal.authorityVersion),
            20
          )
        );
        const result = await curlPost(
          `${base}/v1/edge/auth/challenges/${encodeURIComponent(challenge.challengeId)}/confirm`,
          {
            principal: {
              principalId: principal.principalId,
              authorityDid: principal.authorityDid,
              authorityVersion: principal.authorityVersion
            },
            agentBindings,
            signature: { alg: "EdDSA", signerDid: principal.authorityDid, value: signed.signature }
          },
          30,
          community.token
        );
        return { ok: result?.state === "confirmed", ...result };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    }
    installPanelRoutes(ctx, webServer, {
      // A remote caller is refused unless it holds this node's bearer token.
      //
      // Note what this does NOT reuse: `authorized()` returns true for
      // everyone when no token is configured, because that is the right default
      // for a read API on a loopback port. Applying it here would mean a node
      // with auth off publishes itself for anyone on the LAN who can POST. No
      // token configured therefore means no remote access at all.
      authorizeRemote: (request) => state.token !== null && authorized(request),
      async setConversationWorkspace(path) {
        try {
          return await setConversationWorkspace(path);
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      },
      async declarePrincipal(label) {
        try {
          const principal = await declarePrincipal(
            ctx,
            join,
            workspace,
            principalStoreRoot,
            (args, home) => iflowId(args, home),
            label
          );
          state.principalId = principal.principalId;
          await restartEdge();
          return { ok: true, principal };
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      },
      async bindPrincipal(principalId) {
        try {
          const principal = await bindPrincipal(
            ctx,
            join,
            workspace,
            principalStoreRoot,
            (args, home) => iflowId(args, home),
            principalId
          );
          state.principalId = principal.principalId;
          await restartEdge();
          return { ok: true, principal };
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      },
      async principalMigrationPlan() {
        try {
          return { ok: true, ...await planPrincipalMigration(ctx, join, workspace, principalStoreRoot) };
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      },
      async migratePrincipal(input) {
        try {
          const result = await migrateLegacyPrincipal(
            ctx,
            join,
            workspace,
            principalStoreRoot,
            (args, home) => iflowId(args, home, 30),
            {
              expectedAuthorityDid: input?.expectedAuthorityDid,
              targetPrincipalId: input?.targetPrincipalId
            }
          );
          state.principalId = result.principal?.principalId ?? null;
          await restartEdge();
          return { ok: true, ...result };
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      },
      // The Requests inbox. Same two answers the `iflow_conversations` tool
      // gives, so the panel and the tool cannot drift into disagreeing about
      // what accepting means.
      async listConversations() {
        await conversationsReady;
        return {
          ok: true,
          conversations: Object.values(state.conversations).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map((c) => ({
            conversationId: c.conversationId,
            peer: c.peer,
            peerDid: c.peerDid,
            state: c.state,
            preview: c.preview,
            boundSession: c.binding ? c.binding.localSessionId : null,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt
          }))
        };
      },
      async acceptConversation(conversationId) {
        if (!conversationId) return { ok: false, error: "conversationId is required" };
        return await acceptConversation(conversationId, { decidedBy: "human" });
      },
      async rejectConversation(conversationId, reason) {
        if (!conversationId) return { ok: false, error: "conversationId is required" };
        return await rejectConversation(conversationId, reason);
      },
      /**
       * Rule on work a remote Agent handed back.
       *
       * The journal fact is what makes this binding: until one is written, a
       * Task delegated across an ownership boundary stays `delivered`, however
       * the executor described it. `decidedBy` is this node's Agent, which is
       * necessarily not the one that submitted — the fold refuses a
       * self-acceptance, and here the two are on different machines.
       */
      async decideDelivery(conversationId, deliveryId, decision, reason) {
        await conversationsReady;
        if (!conversationId || !deliveryId) return { ok: false, error: "conversationId and deliveryId are required" };
        if (decision !== "accept" && decision !== "reject") {
          return { ok: false, error: 'decision must be "accept" or "reject"' };
        }
        if (decision === "reject" && !reason) {
          return { ok: false, error: "rejecting a delivery needs a reason" };
        }
        const conversation = state.conversations[conversationId];
        if (!conversation) return { ok: false, error: "no such conversation" };
        const ruled = decideDelivery(conversation, deliveryId, decision, iso());
        if (!ruled) return { ok: false, error: "no delivery awaiting a decision" };
        await persistConversations();
        const decidedBy = conversation.localAgentId ?? selfAgentId();
        observeEdge(
          `delivery.${ruled.state}`,
          (observer) => decision === "accept" ? observer.deliveryAccepted({
            taskId: ruled.taskId,
            deliveryId,
            decidedBy,
            decidedByKind: "human"
          }) : observer.deliveryRejected({
            taskId: ruled.taskId,
            deliveryId,
            decidedBy,
            decidedByKind: "human",
            reason
          })
        );
        return { ok: true, delivery: ruled };
      },
      async declareAgent(input) {
        try {
          const { declared } = await declareAgent(ctx, join, workspace, principalStoreRoot, (a, home) => iflowId(a, home, 30), {
            agentId: input?.agentId,
            label: input?.label,
            capabilities: Array.isArray(input?.capabilities) ? input.capabilities : [],
            level: input?.level,
            ttlSeconds: input?.ttlSeconds
          });
          await restartEdge();
          return { ok: true, agent: declared };
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      },
      confirmWebLogin,
      async state() {
        await conversationsReady;
        await conversationWorkspaceReady;
        const community = await resolveCommunity();
        const declarations = await loadDeclarations(ctx, join, workspace);
        const principalMigration = await planPrincipalMigration(ctx, join, workspace, principalStoreRoot);
        const availablePrincipals = loadPrincipalRegistry(join, principalStoreRoot).principals;
        const identity = await (async () => {
          try {
            const id = await getIdentity();
            return { ready: Boolean(id.did), did: id.did ?? null, error: null };
          } catch (err) {
            return { ready: false, did: null, error: err && err.message ? err.message : String(err) };
          }
        })();
        const edge = edgeHandle;
        const journal = edge ? { nodeId: edge.nodeId, lastSeq: edge.edge.journal.lastSeq, syncedSeq: edge.edge.journal.syncedSeq } : null;
        const localAgents = edge ? (edge.edge.views.agents().data.agents ?? []).length : 0;
        const localIntentStates = await webIntentQueue.status();
        const webIntents = localIntentStates.reduce(
          (counts, intent) => {
            counts[intent.state] = (counts[intent.state] ?? 0) + 1;
            return counts;
          },
          {}
        );
        return {
          edgeReady: Boolean(edge),
          identity,
          // `signing` is not the same as `identity.ready`: a node can hold a
          // DID and still journal unsigned if the binary went missing after
          // start-up.
          signing: edge ? edge.signing : false,
          localAgents,
          journal,
          pendingFacts: journal ? Math.max(0, journal.lastSeq - journal.syncedSeq) : 0,
          webIntents,
          publishing: community ? { url: community.url, visibility: community.visibility, enabledAt: community.enabledAt ?? null } : null,
          claimInProgress: pendingClaim ? { userCode: pendingClaim.userCode, expiresAt: pendingClaim.expiresAt } : null,
          // Who this node speaks for. An Agent is here because a person
          // declared it; `localAgents` above counts what the runtime is doing,
          // which is a different question.
          principal: declarations.principal,
          principalMigration,
          availablePrincipals,
          declaredAgents: declarations.agents.map((a) => ({
            agentId: a.agentId,
            label: a.label,
            did: a.did,
            capabilities: a.capabilities ?? [],
            grantRef: a.grantRef
          })),
          // Who this node is, for the Hub's "Me" tab. `workspaceRoot` is a path
          // on this disk and is shown only to the person sitting at it: this
          // payload is loopback-guarded, and the path is never in a projection.
          alias: state.alias,
          nodeId: edge ? edge.nodeId : null,
          workspaceRoot: workspace,
          conversationWorkspace: {
            path: conversationWorkspace.path,
            confirmed: conversationWorkspace.confirmed,
            defaultPath: workspace
          },
          // Cached reachability, deliberately NOT probed here. The Launcher
          // polls this route every 15 seconds; probing on that path would turn
          // the panel into a scheduled port-scan of every registered peer.
          // `POST /iflow/panel/peers/probe` is the explicit way to refresh.
          peers: [...state.peers.entries()].map(([name, entry]) => ({
            name,
            url: entry.url,
            tokenSet: entry.token !== null,
            healthy: entry.healthy ?? null,
            lastSeen: entry.lastSeen ?? null
          })),
          // The badge reads this. Because the Launcher already polls /state,
          // showing "someone is waiting" costs no additional request.
          conversationsPending: pendingConversationCount(),
          // Work handed back to this node and still owed a ruling. A separate
          // queue from pending conversations: agreeing to talk and agreeing the
          // work is done are different decisions, made at different times.
          deliveriesPending: pendingDeliveries(state.conversations).map(({ conversation, delivery }) => ({
            conversationId: conversation.conversationId,
            deliveryId: delivery.deliveryId,
            taskId: delivery.taskId,
            peerLabel: conversation.peer || conversation.peerAgentId || "agent",
            receivedAt: delivery.receivedAt
          })),
          // Whether this node can reach a peer it cannot dial, and if not, why.
          // An identity binary older than the plugin is the likely answer, and
          // it is not something an operator would otherwise find out until a
          // message failed to send.
          relay: {
            configured: Boolean(relaySettings()),
            canSeal: iflowIdSupports("seal")
          },
          trust: {
            default: state.trust.default,
            autoPeers: Object.values(state.trust.peers).filter((m) => m === "auto").length,
            blocked: state.trust.blocked.length
          },
          // Read-only. These are security posture, not preferences, and the
          // panel shows them so an operator can see what this node accepts —
          // it does not offer to change them.
          posture: {
            acceptCommands: config.acceptCommands === true,
            routeApprovals: config.routeApprovals === true,
            authEnabled: state.token !== null,
            boundHost: webServer.host,
            port: webServer.port
          }
        };
      },
      /**
       * The relationship graph, and only the relationship graph.
       *
       * `views.network()` also carries task, goal and room nodes — the shape of
       * work in progress. Those are filtered out HERE rather than in the
       * browser, for two reasons: the Hub's star map is about who knows whom
       * (§23), and whatever is not sent cannot leak from the page that
       * receives it.
       */
      async networkMap() {
        const edge = edgeHandle;
        if (!edge) return { ok: true, nodes: [], edges: [], selfAgentId: null };
        const view = edge.edge.views.network().data;
        return {
          ok: true,
          selfAgentId: edge.edge.descriptor.selfAgentId,
          nodes: view.nodes.filter((n) => n.kind === "agent"),
          // `rel:` is the prefix projectNetworkGraph gives edges derived from an
          // AgentRelation. Every other edge is a projection of a Task or a Room.
          edges: view.edges.filter((e) => e.id.startsWith("rel:"))
        };
      },
      async probePeers() {
        for (const [name, entry] of state.peers) await probePeer(name, entry);
        return {
          ok: true,
          peers: [...state.peers.entries()].map(([name, entry]) => ({
            name,
            url: entry.url,
            tokenSet: entry.token !== null,
            healthy: entry.healthy ?? null,
            lastSeen: entry.lastSeen ?? null
          }))
        };
      },
      async claimStart() {
        const edge = edgeHandle;
        if (!edge) return { ok: false, error: "the edge is not running yet; try again in a moment" };
        const identity = await getIdentity().catch(() => ({ did: void 0 }));
        const result = await communityFetch("/v1/claim/start", {
          nodeId: edge.nodeId,
          did: identity.did,
          label: state.alias
        });
        if (!result || !result.deviceCode) {
          return { ok: false, error: "the Community did not issue a code" };
        }
        pendingClaim = {
          deviceCode: result.deviceCode,
          userCode: result.userCode,
          expiresAt: result.expiresAt
        };
        return {
          ok: true,
          userCode: result.userCode,
          verificationUrl: result.verificationUrl,
          expiresAt: result.expiresAt,
          intervalMs: result.intervalMs ?? 3e3
        };
      },
      async claimPoll() {
        if (!pendingClaim) return { ok: false, state: "none" };
        const result = await communityFetch("/v1/claim/poll", { deviceCode: pendingClaim.deviceCode });
        if (result.state !== "issued") {
          if (result.state === "expired" || result.state === "unknown") pendingClaim = null;
          return { ok: true, state: result.state };
        }
        const base = await communityBaseUrl();
        await saveCommunitySettings(ctx, join, workspace, {
          url: base,
          token: result.nodeToken,
          visibility: "structural",
          nodeId: result.nodeId,
          principalId: result.principalId ?? null,
          enabledAt: (/* @__PURE__ */ new Date()).toISOString(),
          intervalMs: 6e4
        });
        pendingClaim = null;
        await restartEdge();
        return { ok: true, state: "issued", url: base };
      },
      async stopPublishing() {
        await clearCommunitySettings(ctx, join, workspace);
        pendingClaim = null;
        await restartEdge();
        return { ok: true, publishing: null };
      },
      async setVisibility(visibility) {
        const community = await resolveCommunity();
        if (!community) return { ok: false, error: "this node is not publishing" };
        const next = visibility === "full" ? "full" : "structural";
        await saveCommunitySettings(ctx, join, workspace, { ...community, visibility: next });
        await restartEdge();
        return { ok: true, visibility: next };
      },
      async fetchIdentity() {
        const bin = await resolveIflowId(true);
        if (!bin) return { ok: false, error: iflowIdFailure ?? "the binary could not be resolved" };
        try {
          identityCache = null;
          const identity = await getIdentity();
          return { ok: true, path: bin, did: identity.did ?? null };
        } catch (err) {
          return { ok: false, path: bin, error: err && err.message ? err.message : String(err) };
        }
      }
    });
    console.log(`iFlow A2A bridge ready (v${state.syncVersion}): /a2a on port ${webServer.port}, alias ${state.alias}, update source ${sourcePath}, auth ${state.token === null ? "off" : "on"}`);
  }
};
export {
  index_default as default
};
