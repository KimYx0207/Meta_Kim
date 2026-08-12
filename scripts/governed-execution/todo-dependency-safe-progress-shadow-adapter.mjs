import { createHash } from "node:crypto";

import {
  assertValidTodoDependencySafeProgressShadowResult,
  evaluateTodoDependencySafeProgressShadow,
} from "../../src/domain/work/todo-dependency-safe-progress-shadow.mjs";
import { assertValidEvidenceTransitionShadowResult } from "../../src/domain/evidence/evidence-transition.mjs";
import { assertValidContinuationPolicyShadowResult } from "../../src/domain/continuation/continuation-policy-shadow.mjs";
import {
  stageDagGraphDigest,
  validateStageDagPacket,
} from "./stage-dag.mjs";

export const TODO_DEPENDENCY_SAFE_PROGRESS_SHADOW_ADAPTER_SCHEMA_VERSION =
  "todo-dependency-safe-progress-shadow-adapter-v1";

const SHADOW_AUTHORITY = Object.freeze({
  projectsTodoTruth: false,
  writesTodo: false,
  writesKernel: false,
  writesEvents: false,
  selectsSchedulerReadySet: false,
  dispatchesScheduler: false,
  claimsNode: false,
  changesLease: false,
  changesFence: false,
  advancesCursor: false,
  changesCheckpoint: false,
  completesNode: false,
  terminatesRun: false,
  projectionOnly: true,
});

const EXECUTION_AUTHORITY_FIELDS = Object.freeze([
  "durableRunProjection",
  "durableResume",
  "nodeRecords",
]);
const A01_ENVELOPE_FIELDS = Object.freeze([
  "schemaVersion", "mode", "evaluationStatus", "verdict", "result", "authority",
]);
const A01_AUTHORITY_FIELDS = Object.freeze([
  "gatesExecution", "writesKernel", "writesEvents", "completesNode", "advancesCursor", "projectionOnly",
]);
const A02_ENVELOPE_FIELDS = Object.freeze([
  "schemaVersion", "mode", "evaluationStatus", "disposition", "result", "authority",
]);
const A02_AUTHORITY_FIELDS = Object.freeze([
  "gatesExecution", "writesKernel", "writesEvents", "completesNode", "advancesCursor",
  "changesCheckpoint", "changesLease", "changesFence", "dispatchesScheduler",
  "terminatesRun", "projectionOnly",
]);

function assertPlainRecord(value, label) {
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} is not a plain record`);
  }
  return value;
}

function ownDataField(value, field, label = field) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
    throw new TypeError(`${label} must be an enumerable own data field`);
  }
  return descriptor.value;
}

function assertExactRecord(value, fields, label) {
  assertPlainRecord(value, label);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
  for (const field of fields) ownDataField(value, field, `${label}.${field}`);
  return value;
}

function assertEmptyInput(value) {
  assertExactRecord(value, [], "normalizedInput");
}

function denseArray(value, label, { maxLength = 2_048 } = {}) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} is not a plain array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) {
    throw new TypeError(`${label} has an invalid length`);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
      Number(key) >= length
    ) {
      throw new TypeError(`${label} contains unsupported fields`);
    }
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError(`${label} must contain dense own data`);
    }
    return descriptor.value;
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex")}`;
}

function digestReference(value) {
  const normalized = String(value ?? "");
  if (/^sha256:[a-f0-9]{64}$/u.test(normalized)) return normalized;
  if (/^[a-f0-9]{64}$/u.test(normalized)) return `sha256:${normalized}`;
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function fixedAuthority(value, fields, expected, label) {
  const record = assertExactRecord(value, fields, label);
  for (const field of fields) {
    if (ownDataField(record, field, `${label}.${field}`) !== expected[field]) {
      throw new TypeError(`${label}.${field} is invalid`);
    }
  }
}

function validatedA02(projection) {
  const envelope = assertExactRecord(projection, A02_ENVELOPE_FIELDS, "continuation projection");
  if (
    ownDataField(envelope, "schemaVersion") !== "continuation-policy-shadow-adapter-v1" ||
    ownDataField(envelope, "mode") !== "shadow_only" ||
    ownDataField(envelope, "evaluationStatus") !== "evaluated"
  ) {
    throw new TypeError("continuation projection is not a canonical evaluated result");
  }
  fixedAuthority(
    ownDataField(envelope, "authority"),
    A02_AUTHORITY_FIELDS,
    {
      gatesExecution: false,
      writesKernel: false,
      writesEvents: false,
      completesNode: false,
      advancesCursor: false,
      changesCheckpoint: false,
      changesLease: false,
      changesFence: false,
      dispatchesScheduler: false,
      terminatesRun: false,
      projectionOnly: true,
    },
    "continuation projection authority",
  );
  const result = ownDataField(envelope, "result");
  assertValidContinuationPolicyShadowResult(result);
  if (ownDataField(envelope, "disposition") !== result.disposition.action) {
    throw new TypeError("continuation envelope conflicts with its canonical result");
  }
  return result;
}

function validatedA01(projection, binding) {
  const envelope = assertExactRecord(projection, A01_ENVELOPE_FIELDS, "evidence projection");
  if (
    ownDataField(envelope, "schemaVersion") !== "evidence-transition-shadow-adapter-v1" ||
    ownDataField(envelope, "mode") !== "shadow_only" ||
    ownDataField(envelope, "evaluationStatus") !== "evaluated"
  ) {
    throw new TypeError("evidence projection is not a canonical evaluated result");
  }
  fixedAuthority(
    ownDataField(envelope, "authority"),
    A01_AUTHORITY_FIELDS,
    {
      gatesExecution: false,
      writesKernel: false,
      writesEvents: false,
      completesNode: false,
      advancesCursor: false,
      projectionOnly: true,
    },
    "evidence projection authority",
  );
  const result = ownDataField(envelope, "result");
  assertValidEvidenceTransitionShadowResult(result);
  if (
    ownDataField(envelope, "verdict") !== result.verdict.status ||
    result.binding.runId !== binding.runId ||
    result.binding.taskFingerprint !== binding.taskFingerprint ||
    result.binding.graphDigest !== binding.graphDigest ||
    result.binding.policyDigest !== binding.policyDigest
  ) {
    throw new TypeError("evidence projection conflicts with bound continuation authority");
  }
  return result;
}

function normalizedTopology(stageDagPacket, binding) {
  validateStageDagPacket(stageDagPacket, { requireDigest: true });
  const computedGraphDigest = stageDagGraphDigest(stageDagPacket);
  if (computedGraphDigest !== stageDagPacket.graphDigest) {
    throw new TypeError("stage DAG digest is invalid");
  }
  const graphDigest = digestReference(computedGraphDigest);
  if (graphDigest !== binding.graphDigest) {
    throw new TypeError("stage DAG does not match continuation binding");
  }
  const nodes = denseArray(stageDagPacket.nodes, "stage DAG nodes").map((node, index) => {
    assertPlainRecord(node, `stage DAG nodes[${index}]`);
    const dependsOn = sortedUnique(denseArray(
      ownDataField(node, "dependsOn", `stage DAG nodes[${index}].dependsOn`),
      `stage DAG nodes[${index}].dependsOn`,
      { maxLength: 512 },
    ));
    const resourceScopes = sortedUnique(denseArray(
      ownDataField(node, "resourceScopes", `stage DAG nodes[${index}].resourceScopes`),
      `stage DAG nodes[${index}].resourceScopes`,
      { maxLength: 512 },
    ));
    return {
      nodeId: ownDataField(node, "nodeId", `stage DAG nodes[${index}].nodeId`),
      stage: ownDataField(node, "stage", `stage DAG nodes[${index}].stage`),
      laneKind: ownDataField(node, "laneKind", `stage DAG nodes[${index}].laneKind`),
      ownerBindingRef: ownDataField(node, "ownerBindingRef", `stage DAG nodes[${index}].ownerBindingRef`),
      capabilityBindingRef: ownDataField(node, "capabilityBindingRef", `stage DAG nodes[${index}].capabilityBindingRef`),
      dependsOn,
      effectClass: ownDataField(node, "effectClass", `stage DAG nodes[${index}].effectClass`),
      resourceScopes,
      isolation: ownDataField(node, "isolation", `stage DAG nodes[${index}].isolation`),
      mergeNodeId: ownDataField(node, "mergeNodeId", `stage DAG nodes[${index}].mergeNodeId`),
    };
  });
  return {
    schemaVersion: stageDagPacket.schemaVersion,
    authority: "config/contracts/core-loop-contract.json",
    graphDigest,
    nodes,
  };
}

function nodeIdList(records, label) {
  return sortedUnique(denseArray(records, label).map((record, index) => {
    assertPlainRecord(record, `${label}[${index}]`);
    return ownDataField(record, "nodeId", `${label}[${index}].nodeId`);
  }));
}

function normalizedExecutionSnapshot(rawAuthority, topology, continuationResult) {
  const authority = assertExactRecord(
    rawAuthority,
    EXECUTION_AUTHORITY_FIELDS,
    "authoritativeExecutionSnapshot",
  );
  const projection = assertPlainRecord(
    ownDataField(authority, "durableRunProjection"),
    "durableRunProjection",
  );
  const resume = assertPlainRecord(
    ownDataField(authority, "durableResume"),
    "durableResume",
  );
  const run = assertPlainRecord(ownDataField(projection, "run", "durableRunProjection.run"), "durableRunProjection.run");
  const events = denseArray(ownDataField(projection, "events", "durableRunProjection.events"), "durableRunProjection.events", { maxLength: 20_000 });
  const completedNodeIds = nodeIdList(
    ownDataField(projection, "completedNodes", "durableRunProjection.completedNodes"),
    "durableRunProjection.completedNodes",
  );
  const activeClaims = denseArray(
    ownDataField(resume, "activeClaims", "durableResume.activeClaims"),
    "durableResume.activeClaims",
  );
  const blockingEffects = denseArray(
    ownDataField(resume, "blockingEffects", "durableResume.blockingEffects"),
    "durableResume.blockingEffects",
  );
  const activeClaimNodeIds = nodeIdList(activeClaims, "durableResume.activeClaims");
  const unresolvedEffectNodeIds = nodeIdList(blockingEffects, "durableResume.blockingEffects");
  const inDoubtNodeIds = sortedUnique(events.flatMap((event, index) => {
    assertPlainRecord(event, `durableRunProjection.events[${index}]`);
    return ownDataField(event, "eventType", `durableRunProjection.events[${index}].eventType`) === "NodeAttemptInDoubt"
      ? [ownDataField(event, "nodeId", `durableRunProjection.events[${index}].nodeId`)]
      : [];
  })).filter((nodeId) => !completedNodeIds.includes(nodeId));
  const eventChain = assertPlainRecord(
    ownDataField(projection, "eventChain", "durableRunProjection.eventChain"),
    "durableRunProjection.eventChain",
  );
  const eventChainOk = ownDataField(eventChain, "ok", "durableRunProjection.eventChain.ok");
  const eventChainState = eventChainOk === true ? "verified" : eventChainOk === false ? "failed" : "unknown";
  const nodeRecords = denseArray(
    ownDataField(authority, "nodeRecords"),
    "authoritativeExecutionSnapshot.nodeRecords",
  );
  const recordStatuses = new Map(nodeRecords.map((record, index) => {
    assertPlainRecord(record, `authoritativeExecutionSnapshot.nodeRecords[${index}]`);
    return [
      ownDataField(record, "nodeId", `authoritativeExecutionSnapshot.nodeRecords[${index}].nodeId`),
      ownDataField(record, "status", `authoritativeExecutionSnapshot.nodeRecords[${index}].status`),
    ];
  }));
  const executionNodes = topology.nodes.filter((node) => node.stage === "Execution");
  const bridgeSettlementState = executionNodes.length > 0 && executionNodes.every(
    (node) => recordStatuses.get(node.nodeId) === "completed",
  ) ? "settled" : "incomplete";
  const cursor = ownDataField(projection, "cursor", "durableRunProjection.cursor");
  const lastEvent = events.at(-1) ?? null;
  const lastEventSeq = lastEvent === null
    ? null
    : ownDataField(lastEvent, "eventSeq", "durableRunProjection.events[last].eventSeq");
  const projectionSchemaVersion = ownDataField(projection, "schemaVersion", "durableRunProjection.schemaVersion");
  const runId = ownDataField(run, "runId", "durableRunProjection.run.runId");
  const taskFingerprint = ownDataField(run, "taskFingerprint", "durableRunProjection.run.taskFingerprint");
  const graphDigest = ownDataField(run, "graphDigest", "durableRunProjection.run.graphDigest");
  const blockingEffectRefs = sortedUnique(blockingEffects.map((effect, index) => {
    assertPlainRecord(effect, `durableResume.blockingEffects[${index}]`);
    return ownDataField(effect, "effectId", `durableResume.blockingEffects[${index}].effectId`);
  }));
  const activeClaimRefs = sortedUnique(activeClaims.map((claim, index) => {
    assertPlainRecord(claim, `durableResume.activeClaims[${index}]`);
    return [
      "claim",
      ownDataField(claim, "nodeId", `durableResume.activeClaims[${index}].nodeId`),
      ownDataField(claim, "attemptId", `durableResume.activeClaims[${index}].attemptId`),
      ownDataField(claim, "fenceToken", `durableResume.activeClaims[${index}].fenceToken`),
    ].join(":");
  }));
  const authorityCoherent =
    projectionSchemaVersion === "durable-governed-run-projection-v0.1" &&
    runId === ownDataField(resume, "runId", "durableResume.runId") &&
    digestReference(taskFingerprint) === continuationResult.binding.taskFingerprint &&
    digestReference(graphDigest) === continuationResult.binding.graphDigest &&
    Number.isSafeInteger(cursor) &&
    cursor >= ownDataField(resume, "cursor", "durableResume.cursor") &&
    (events.length === 0 || lastEventSeq === cursor);
  const currentness = activeClaimNodeIds.length > 0
    ? "active_claim_present"
    : unresolvedEffectNodeIds.length > 0
      ? "unresolved_effect_present"
      : authorityCoherent && bridgeSettlementState === "settled"
        ? "bound_same_bridge_settlement"
        : "unproven";
  const lastEventHash = lastEvent === null
    ? null
    : ownDataField(lastEvent, "eventHash", "durableRunProjection.events[last].eventHash");
  const headCheckpointId = ownDataField(projection, "headCheckpointId", "durableRunProjection.headCheckpointId");
  const projectionBinding = {
    schemaVersion: projectionSchemaVersion,
    runId,
    taskFingerprint,
    graphDigest,
    runStatus: ownDataField(run, "status", "durableRunProjection.run.status"),
    cursor,
    headEventHash: lastEventHash,
    headCheckpointId,
    eventChainState,
    blockingEffectRefs,
    activeClaimRefs,
    bridgeSettlementState,
  };
  const projectionDigest = digestReference(JSON.stringify(projectionBinding));
  const authoritySnapshot = continuationResult.authoritySnapshot;
  if (
    continuationResult.binding.runId !== runId ||
    continuationResult.binding.projectionDigest !== projectionDigest ||
    continuationResult.binding.durableCursor !== cursor ||
    continuationResult.binding.headEventHash !== (lastEventHash ? digestReference(lastEventHash) : null) ||
    continuationResult.binding.headCheckpointId !== headCheckpointId ||
    authoritySnapshot.projectionDigest !== projectionDigest ||
    authoritySnapshot.eventChainState !== eventChainState ||
    authoritySnapshot.currentness !== currentness
  ) {
    throw new TypeError("durable execution projection does not match continuation authority");
  }
  return {
    projectionDigest,
    eventChainState,
    currentness,
    completedNodeIds,
    activeClaimNodeIds,
    unresolvedEffectNodeIds,
    inDoubtNodeIds,
  };
}

function decisionSnapshot(topology, executionSnapshot) {
  const approvalGateNodeIds = topology.nodes
    .filter((node) => node.effectClass === "approval_gate")
    .map((node) => node.nodeId);
  const completed = new Set(executionSnapshot.completedNodeIds);
  const verifiedDecisionNodeIds = approvalGateNodeIds.filter((nodeId) => completed.has(nodeId)).sort();
  const pendingDecisionNodeIds = approvalGateNodeIds.filter((nodeId) => !completed.has(nodeId)).sort();
  const unknownDecisionNodeIds = [];
  return {
    pendingDecisionNodeIds,
    verifiedDecisionNodeIds,
    unknownDecisionNodeIds,
    snapshotDigest: digest({
      pendingDecisionNodeIds,
      verifiedDecisionNodeIds,
      unknownDecisionNodeIds,
    }),
  };
}

function evidenceSummary(result) {
  return {
    schemaVersion: result.schemaVersion,
    resultDigest: digest(result),
    bindingDigest: result.bindingDigest,
    evaluationStatus: "evaluated",
    verdict: result.verdict.status,
    blockedDecisionIds: [...result.verdict.blockedDecisionIds].sort(),
    reasonCodes: [...result.verdict.reasonCodes].sort(),
  };
}

function continuationSummary(result) {
  return {
    schemaVersion: result.schemaVersion,
    resultDigest: digest(result),
    bindingDigest: result.bindingDigest,
    evaluationStatus: "evaluated",
    action: result.disposition.action,
    reasonCodes: [...result.disposition.reasonCodes].sort(),
  };
}

function shadowEnvelope({ evaluationStatus, disposition, result = null }) {
  return Object.freeze({
    schemaVersion: TODO_DEPENDENCY_SAFE_PROGRESS_SHADOW_ADAPTER_SCHEMA_VERSION,
    mode: "shadow_only",
    evaluationStatus,
    disposition,
    result,
    authority: SHADOW_AUTHORITY,
  });
}

export function buildTodoDependencySafeProgressShadowProjection(
  normalizedInput = null,
  {
    authoritativeTopology = null,
    authoritativeExecutionSnapshot = null,
    evidenceTransitionShadowProjection = null,
    continuationPolicyShadowProjection = null,
  } = {},
) {
  if (normalizedInput == null) {
    return shadowEnvelope({
      evaluationStatus: "not_evaluated_missing_normalized_input",
      disposition: "in_doubt",
    });
  }
  try {
    assertEmptyInput(normalizedInput);
    const continuationResult = validatedA02(continuationPolicyShadowProjection);
    const topology = normalizedTopology(authoritativeTopology, continuationResult.binding);
    const executionSnapshot = normalizedExecutionSnapshot(
      authoritativeExecutionSnapshot,
      topology,
      continuationResult,
    );
    const evidenceResult = validatedA01(
      evidenceTransitionShadowProjection,
      continuationResult.binding,
    );
    const evidenceTransition = evidenceSummary(evidenceResult);
    if (
      continuationResult.evidenceTransition.schemaVersion !== evidenceTransition.schemaVersion ||
      continuationResult.evidenceTransition.resultDigest !== evidenceTransition.resultDigest ||
      continuationResult.evidenceTransition.bindingDigest !== evidenceTransition.bindingDigest ||
      continuationResult.evidenceTransition.evaluationStatus !== evidenceTransition.evaluationStatus ||
      continuationResult.evidenceTransition.verdict !== evidenceTransition.verdict
    ) {
      throw new TypeError("evidence projection does not match the canonical continuation input");
    }
    const continuation = continuationSummary(continuationResult);
    const decisionOnlyWait =
      continuation.action === "wait" &&
      continuation.reasonCodes.length > 0 &&
      continuation.reasonCodes.every((reason) => [
        "awaiting_human_decision",
        "evidence_transition_blocked",
      ].includes(reason));
    if (decisionOnlyWait && evidenceTransition.blockedDecisionIds.length === 0) {
      throw new TypeError("decision-only wait has no exact approval-gate binding");
    }
    const result = evaluateTodoDependencySafeProgressShadow({
      binding: { ...continuationResult.binding },
      topology,
      executionSnapshot,
      decisionSnapshot: decisionSnapshot(topology, executionSnapshot),
      evidenceTransition,
      continuation,
    });
    assertValidTodoDependencySafeProgressShadowResult(result);
    return shadowEnvelope({
      evaluationStatus: "evaluated",
      disposition: result.disposition.action,
      result,
    });
  } catch {
    return shadowEnvelope({
      evaluationStatus: "not_evaluated_invalid_normalized_input",
      disposition: "escalate",
    });
  }
}
