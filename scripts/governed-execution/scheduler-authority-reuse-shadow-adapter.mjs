import { createHash } from "node:crypto";

import {
  assertValidSchedulerAuthorityReuseShadowResult,
  buildSchedulerAuthorityReuseShadowResult,
} from "../../src/domain/scheduling/scheduler-authority-reuse-shadow.mjs";
import { assertValidTodoDependencySafeProgressShadowResult } from "../../src/domain/work/todo-dependency-safe-progress-shadow.mjs";
import {
  selectMaximalSafeReadySet,
  stageDagGraphDigest,
  validateStageDagPacket,
} from "./stage-dag.mjs";

export const SCHEDULER_AUTHORITY_REUSE_SHADOW_ADAPTER_SCHEMA_VERSION =
  "scheduler-authority-reuse-shadow-adapter-v1";

const SHADOW_AUTHORITY = Object.freeze({
  plansScheduler: false,
  dispatchesScheduler: false,
  invokesRuntimeAdapter: false,
  executesCallback: false,
  writesKernel: false,
  writesEvents: false,
  claimsNode: false,
  changesLease: false,
  changesFence: false,
  advancesCursor: false,
  changesCheckpoint: false,
  completesNode: false,
  terminatesRun: false,
  projectionOnly: true,
});

const OPTION_FIELDS = Object.freeze([
  "authoritativeStageDagPacket",
  "freshExecutionHeadSnapshot",
  "todoDependencySafeProgressShadowProjection",
  "trustedSelectionContext",
]);
const CONTEXT_FIELDS = Object.freeze(["stage", "capacity"]);
const FRESH_FIELDS = Object.freeze([
  "source", "runId", "taskFingerprint", "graphDigest", "projectionDigest",
  "cursor", "headEventHash", "headCheckpointId", "runStatus", "eventChainState",
  "completedNodeIds", "activeClaimNodeIds", "unresolvedEffectNodeIds",
  "inDoubtNodeIds", "currentness", "snapshotDigest",
]);
const A03_ENVELOPE_FIELDS = Object.freeze([
  "schemaVersion", "mode", "evaluationStatus", "disposition", "result", "authority",
]);
const A03_AUTHORITY_FIELDS = Object.freeze([
  "projectsTodoTruth", "writesTodo", "writesKernel", "writesEvents",
  "selectsSchedulerReadySet", "dispatchesScheduler", "claimsNode", "changesLease",
  "changesFence", "advancesCursor", "changesCheckpoint", "completesNode",
  "terminatesRun", "projectionOnly",
]);

function assertPlainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
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

function exactRecord(value, fields, label) {
  assertPlainRecord(value, label);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
  for (const field of fields) ownDataField(value, field, `${label}.${field}`);
  return value;
}

function denseArray(value, label, maxLength = 2_048) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} is not a plain array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) {
    throw new TypeError(`${label} has an invalid length`);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
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
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex")}`;
}

function sortedUnique(value, label) {
  const items = denseArray(value, label);
  if (items.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${label} must contain non-empty strings`);
  }
  if (new Set(items).size !== items.length) throw new TypeError(`${label} contains duplicates`);
  return [...items].sort();
}

function validateFreshSnapshot(value) {
  const snapshot = exactRecord(value, FRESH_FIELDS, "freshExecutionHeadSnapshot");
  const core = {
    source: ownDataField(snapshot, "source"),
    runId: ownDataField(snapshot, "runId"),
    taskFingerprint: ownDataField(snapshot, "taskFingerprint"),
    graphDigest: ownDataField(snapshot, "graphDigest"),
    projectionDigest: ownDataField(snapshot, "projectionDigest"),
    cursor: ownDataField(snapshot, "cursor"),
    headEventHash: ownDataField(snapshot, "headEventHash"),
    headCheckpointId: ownDataField(snapshot, "headCheckpointId"),
    runStatus: ownDataField(snapshot, "runStatus"),
    eventChainState: ownDataField(snapshot, "eventChainState"),
    completedNodeIds: sortedUnique(ownDataField(snapshot, "completedNodeIds"), "freshExecutionHeadSnapshot.completedNodeIds"),
    activeClaimNodeIds: sortedUnique(ownDataField(snapshot, "activeClaimNodeIds"), "freshExecutionHeadSnapshot.activeClaimNodeIds"),
    unresolvedEffectNodeIds: sortedUnique(ownDataField(snapshot, "unresolvedEffectNodeIds"), "freshExecutionHeadSnapshot.unresolvedEffectNodeIds"),
    inDoubtNodeIds: sortedUnique(ownDataField(snapshot, "inDoubtNodeIds"), "freshExecutionHeadSnapshot.inDoubtNodeIds"),
    currentness: ownDataField(snapshot, "currentness"),
  };
  if (
    core.source !== "upstream_durable_kernel_projection_owner" ||
    !["active", "completed", "failed", "blocked"].includes(core.runStatus) ||
    !["verified", "failed", "unknown"].includes(core.eventChainState) ||
    !["fresh_bound_for_shadow_selection", "unproven"].includes(core.currentness) ||
    !Number.isSafeInteger(core.cursor) || core.cursor < 0 ||
    ownDataField(snapshot, "snapshotDigest") !== digest(core)
  ) {
    throw new TypeError("fresh execution head snapshot is invalid");
  }
  return { ...core, snapshotDigest: ownDataField(snapshot, "snapshotDigest") };
}

function validateA03Projection(projection) {
  const envelope = exactRecord(projection, A03_ENVELOPE_FIELDS, "A03 projection");
  if (
    ownDataField(envelope, "schemaVersion") !== "todo-dependency-safe-progress-shadow-adapter-v1" ||
    ownDataField(envelope, "mode") !== "shadow_only" ||
    ownDataField(envelope, "evaluationStatus") !== "evaluated"
  ) throw new TypeError("A03 projection is not canonical evaluated evidence");
  const authority = exactRecord(ownDataField(envelope, "authority"), A03_AUTHORITY_FIELDS, "A03 authority");
  for (const field of A03_AUTHORITY_FIELDS) {
    const expected = field === "projectionOnly";
    if (ownDataField(authority, field) !== expected) throw new TypeError("A03 authority is invalid");
  }
  const result = ownDataField(envelope, "result");
  assertValidTodoDependencySafeProgressShadowResult(result);
  if (ownDataField(envelope, "disposition") !== result.disposition.action) {
    throw new TypeError("A03 envelope conflicts with its canonical result");
  }
  return result;
}

function validateTrustedContext(value, stageDagPacket) {
  const context = exactRecord(value, CONTEXT_FIELDS, "trustedSelectionContext");
  const stage = ownDataField(context, "stage");
  const capacity = ownDataField(context, "capacity");
  if (stage !== null && !stageDagPacket.stageOrder.includes(stage)) {
    throw new TypeError("trusted stage is not present in the authoritative DAG");
  }
  if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 1)) {
    throw new TypeError("trusted capacity must be null or a positive safe integer");
  }
  return { stage, capacity };
}

function advisoryBinding(result) {
  const supported = new Map([
    ["candidates_available", "dependency_ready_candidate"],
    ["safe_independent_candidates_available", "safe_independent_candidate"],
  ]);
  const expectedStatus = supported.get(result.disposition.action) ?? null;
  const candidateNodeIds = expectedStatus === null
    ? []
    : result.workItems
        .filter((item) => item.status === expectedStatus)
        .map((item) => item.nodeId)
        .sort();
  return {
    schemaVersion: result.schemaVersion,
    resultDigest: digest(result),
    bindingDigest: result.bindingDigest,
    disposition: result.disposition.action,
    candidateNodeIds,
  };
}

function freshHeadBinding(snapshot) {
  const core = {
    runId: snapshot.runId,
    taskFingerprint: snapshot.taskFingerprint,
    graphDigest: snapshot.graphDigest,
    projectionDigest: snapshot.projectionDigest,
    cursor: snapshot.cursor,
    headEventHash: snapshot.headEventHash,
    headCheckpointId: snapshot.headCheckpointId,
  };
  return { ...core, snapshotDigest: digest(core) };
}

function executionAssessment(snapshot, advisory, advisoryResult) {
  return {
    runStatus: snapshot.runStatus,
    eventChainState: snapshot.eventChainState,
    currentness: snapshot.currentness,
    completedNodeIds: [...snapshot.completedNodeIds],
    activeClaimNodeIds: [...snapshot.activeClaimNodeIds],
    unresolvedEffectNodeIds: [...snapshot.unresolvedEffectNodeIds],
    inDoubtNodeIds: [...snapshot.inDoubtNodeIds],
    advisoryCompletedNodeIds: [...advisoryResult.executionSnapshot.completedNodeIds],
    advisoryActiveClaimNodeIds: [...advisoryResult.executionSnapshot.activeClaimNodeIds],
    advisoryUnresolvedEffectNodeIds: [...advisoryResult.executionSnapshot.unresolvedEffectNodeIds],
    advisoryInDoubtNodeIds: [...advisoryResult.executionSnapshot.inDoubtNodeIds],
    advisoryDisposition: advisory.disposition,
  };
}

function selectorInput({ binding, freshSnapshot, advisory, context }) {
  const core = {
    graphDigest: binding.graphDigest,
    completedNodeIds: [...freshSnapshot.completedNodeIds],
    eligibleNodeIds: [...advisory.candidateNodeIds],
    stage: context.stage,
    capacity: context.capacity,
  };
  return { ...core, inputDigest: digest(core) };
}

function selectorOutput(value) {
  const core = {
    schemaVersion: value.schemaVersion,
    stage: value.stage,
    capacity: value.capacity,
    candidateNodeIds: sortedUnique(value.candidateNodeIds, "selector candidateNodeIds"),
    readyNodeIds: sortedUnique(value.readyNodeIds, "selector readyNodeIds"),
    deferredNodeIds: sortedUnique(value.deferredNodeIds, "selector deferredNodeIds"),
  };
  return { ...core, outputDigest: digest(core) };
}

function resultEnvelope(result, selectorInvoked) {
  assertValidSchedulerAuthorityReuseShadowResult(result);
  return Object.freeze({
    schemaVersion: SCHEDULER_AUTHORITY_REUSE_SHADOW_ADAPTER_SCHEMA_VERSION,
    mode: "shadow_only",
    evaluationStatus: "evaluated",
    disposition: result.plan.status,
    selectorInvoked,
    result,
    authority: SHADOW_AUTHORITY,
  });
}

function invalidEnvelope(evaluationStatus = "not_evaluated_invalid_normalized_input") {
  return Object.freeze({
    schemaVersion: SCHEDULER_AUTHORITY_REUSE_SHADOW_ADAPTER_SCHEMA_VERSION,
    mode: "shadow_only",
    evaluationStatus,
    disposition: "in_doubt",
    selectorInvoked: false,
    result: null,
    authority: SHADOW_AUTHORITY,
  });
}

export function buildSchedulerAuthorityReuseShadowPlan(normalizedInput = null, options = {}) {
  if (normalizedInput == null) return invalidEnvelope("not_evaluated_missing_normalized_input");
  try {
    exactRecord(normalizedInput, [], "normalizedInput");
    const trusted = exactRecord(options, OPTION_FIELDS, "scheduler shadow options");
    const stageDagPacket = ownDataField(trusted, "authoritativeStageDagPacket");
    validateStageDagPacket(stageDagPacket, { requireDigest: true });
    if (stageDagGraphDigest(stageDagPacket) !== stageDagPacket.graphDigest) {
      throw new TypeError("authoritative DAG digest is invalid");
    }
    const freshSnapshot = validateFreshSnapshot(ownDataField(trusted, "freshExecutionHeadSnapshot"));
    const a03Result = validateA03Projection(ownDataField(trusted, "todoDependencySafeProgressShadowProjection"));
    const context = validateTrustedContext(ownDataField(trusted, "trustedSelectionContext"), stageDagPacket);
    const advisory = advisoryBinding(a03Result);
    const freshBinding = freshHeadBinding(freshSnapshot);
    const topologyGraphDigest = `sha256:${stageDagPacket.graphDigest}`;
    if (topologyGraphDigest !== a03Result.binding.graphDigest || topologyGraphDigest !== freshSnapshot.graphDigest) {
      throw new TypeError("topology authority does not match the bound projections");
    }
    const executionSetsMatch = [
      "completedNodeIds", "activeClaimNodeIds", "unresolvedEffectNodeIds", "inDoubtNodeIds",
    ].every((field) => JSON.stringify([...a03Result.executionSnapshot[field]].sort()) === JSON.stringify(freshSnapshot[field]));
    const headMatches =
      a03Result.binding.runId === freshSnapshot.runId &&
      a03Result.binding.taskFingerprint === freshSnapshot.taskFingerprint &&
      a03Result.binding.graphDigest === freshSnapshot.graphDigest &&
      a03Result.binding.projectionDigest === freshSnapshot.projectionDigest &&
      a03Result.binding.durableCursor === freshSnapshot.cursor &&
      a03Result.binding.headEventHash === freshSnapshot.headEventHash &&
      a03Result.binding.headCheckpointId === freshSnapshot.headCheckpointId;
    const blocked =
      freshSnapshot.runStatus !== "active" ||
      freshSnapshot.eventChainState !== "verified" ||
      freshSnapshot.currentness !== "fresh_bound_for_shadow_selection" ||
      freshSnapshot.activeClaimNodeIds.length > 0 ||
      freshSnapshot.unresolvedEffectNodeIds.length > 0;
    if (!headMatches || !executionSetsMatch || blocked || advisory.candidateNodeIds.length === 0) {
      const result = buildSchedulerAuthorityReuseShadowResult({
        binding: { ...a03Result.binding },
        freshHeadBinding: freshBinding,
        advisoryBinding: advisory,
        executionAssessment: executionAssessment(freshSnapshot, advisory, a03Result),
        selectorInput: null,
        selectorOutput: null,
      });
      return resultEnvelope(result, false);
    }
    const input = selectorInput({
      binding: a03Result.binding,
      freshSnapshot,
      advisory,
      context,
    });
    const selected = selectMaximalSafeReadySet(stageDagPacket, {
      completedNodeIds: input.completedNodeIds,
      eligibleNodeIds: input.eligibleNodeIds,
      stage: input.stage,
      capacity: input.capacity,
    });
    const output = selectorOutput(selected);
    const result = buildSchedulerAuthorityReuseShadowResult({
      binding: { ...a03Result.binding },
      freshHeadBinding: freshBinding,
      advisoryBinding: advisory,
      executionAssessment: executionAssessment(freshSnapshot, advisory, a03Result),
      selectorInput: input,
      selectorOutput: output,
    });
    return resultEnvelope(result, true);
  } catch {
    return invalidEnvelope();
  }
}
