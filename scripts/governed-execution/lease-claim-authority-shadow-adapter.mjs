import { createHash } from "node:crypto";

import {
  assertValidLeaseClaimAuthorityShadowResult,
  evaluateLeaseClaimAuthorityShadow,
} from "../../src/domain/claims/lease-claim-authority-shadow.mjs";
import { assertValidSchedulerAuthorityReuseShadowResult } from "../../src/domain/scheduling/scheduler-authority-reuse-shadow.mjs";
import {
  stageDagGraphDigest,
  validateStageDagPacket,
} from "./stage-dag.mjs";

export const LEASE_CLAIM_AUTHORITY_SHADOW_ADAPTER_SCHEMA_VERSION =
  "lease-claim-authority-shadow-adapter-v1";

const OPTION_FIELDS = Object.freeze([
  "authoritativeStageDagPacket",
  "authoritativeExecutionSnapshot",
  "schedulerAuthorityReuseShadowProjection",
  "trustedObservationContext",
]);
const EXECUTION_SNAPSHOT_FIELDS = Object.freeze(["durableRunProjection", "durableResume"]);
const OBSERVATION_FIELDS = Object.freeze(["source", "observedAtMs"]);
const A04_ENVELOPE_FIELDS = Object.freeze([
  "schemaVersion", "mode", "evaluationStatus", "disposition", "selectorInvoked", "result", "authority",
]);
const A04_AUTHORITY_FIELDS = Object.freeze([
  "plansScheduler", "dispatchesScheduler", "invokesRuntimeAdapter", "executesCallback",
  "writesKernel", "writesEvents", "claimsNode", "changesLease", "changesFence",
  "advancesCursor", "changesCheckpoint", "completesNode", "terminatesRun", "projectionOnly",
]);

const SHADOW_AUTHORITY = Object.freeze({
  projectsClaimTruth: false,
  writesKernel: false,
  writesEvents: false,
  claimsNode: false,
  takesOverClaim: false,
  heartbeatsClaim: false,
  releasesClaim: false,
  changesLease: false,
  changesFence: false,
  selectsScheduler: false,
  dispatchesScheduler: false,
  completesNode: false,
  terminatesRun: false,
  projectionOnly: true,
});

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain record`);
  }
  return value;
}

function ownData(value, field, label = field) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
    throw new TypeError(`${label} must be an enumerable own data field`);
  }
  return descriptor.value;
}

function exactRecord(value, fields, label) {
  plainRecord(value, label);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
  for (const field of fields) ownData(value, field, `${label}.${field}`);
  return value;
}

function denseArray(value, label, maxLength = 2_048) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array`);
  }
  if (!Number.isSafeInteger(value.length) || value.length < 0 || value.length > maxLength) {
    throw new TypeError(`${label} has an invalid length`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
      throw new TypeError(`${label} contains unsupported fields`);
    }
  }
  return Array.from({ length: value.length }, (_, index) => {
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
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

function digestReference(value) {
  const normalized = String(value ?? "");
  if (/^sha256:[a-f0-9]{64}$/u.test(normalized)) return normalized;
  if (/^[a-f0-9]{64}$/u.test(normalized)) return `sha256:${normalized}`;
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

function safeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || (positive ? value < 1 : value < 0)) {
    throw new TypeError(`${label} is not a supported safe integer`);
  }
  return value;
}

function sortedUniqueIds(value, label, topology = null) {
  const items = denseArray(value, label, 512);
  if (items.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError(`${label} must contain non-empty node identifiers`);
  }
  if (new Set(items).size !== items.length) throw new TypeError(`${label} contains duplicate nodes`);
  if (topology && items.some((item) => !topology.has(item))) throw new TypeError(`${label} contains an unknown node`);
  return [...items].sort();
}

function validateSchedulerProjection(value) {
  const envelope = exactRecord(value, A04_ENVELOPE_FIELDS, "scheduler authority projection");
  if (
    ownData(envelope, "schemaVersion") !== "scheduler-authority-reuse-shadow-adapter-v1" ||
    ownData(envelope, "mode") !== "shadow_only" ||
    ownData(envelope, "evaluationStatus") !== "evaluated"
  ) throw new TypeError("scheduler authority projection is not canonical evaluated evidence");
  const authority = exactRecord(ownData(envelope, "authority"), A04_AUTHORITY_FIELDS, "scheduler authority");
  for (const field of A04_AUTHORITY_FIELDS) {
    if (ownData(authority, field) !== (field === "projectionOnly")) {
      throw new TypeError("scheduler authority projection exposes forbidden authority");
    }
  }
  const result = ownData(envelope, "result");
  assertValidSchedulerAuthorityReuseShadowResult(result);
  if (ownData(envelope, "disposition") !== result.plan.status) {
    throw new TypeError("scheduler envelope conflicts with its canonical result");
  }
  if (ownData(envelope, "selectorInvoked") !== (result.selectorAuthority.invocationCount === 1)) {
    throw new TypeError("scheduler envelope conflicts with selector invocation truth");
  }
  return result;
}

function claimEventFor(events, claim) {
  const candidates = events.filter((event) =>
    (event.eventType === "NodeAttemptClaimed" || event.eventType === "NodeClaimHeartbeat") &&
    event.nodeId === claim.nodeId &&
    event.attemptId === claim.attemptId
  );
  if (candidates.length === 0) throw new TypeError("active claim has no bound claim event");
  return candidates.reduce((latest, event) => event.eventSeq > latest.eventSeq ? event : latest);
}

function normalizedClaimRecords({ claims, events, binding, topology, cursor }) {
  const seen = new Set();
  return claims.map((rawClaim, index) => {
    const claim = plainRecord(rawClaim, `durableResume.activeClaims[${index}]`);
    const runId = ownData(claim, "runId");
    const nodeId = ownData(claim, "nodeId");
    const attemptId = ownData(claim, "attemptId");
    const fenceToken = safeInteger(ownData(claim, "fenceToken"), "claim fence", { positive: true });
    const leaseOwner = ownData(claim, "leaseOwner");
    const leaseExpiresAtMs = safeInteger(ownData(claim, "leaseExpiresAtMs"), "claim expiry");
    if (
      runId !== binding.runId ||
      typeof nodeId !== "string" || !topology.has(nodeId) || seen.has(nodeId) ||
      typeof attemptId !== "string" || attemptId.length === 0 ||
      typeof leaseOwner !== "string" || leaseOwner.length === 0
    ) throw new TypeError("active claim binding is invalid");
    seen.add(nodeId);
    const event = claimEventFor(events, { nodeId, attemptId });
    const payload = plainRecord(event.payload, "claim event payload");
    if (
      event.runId !== binding.runId ||
      ownData(payload, "ownerId") !== leaseOwner ||
      ownData(payload, "fenceToken") !== fenceToken ||
      ownData(payload, "leaseExpiresAtMs") !== leaseExpiresAtMs
    ) throw new TypeError("active claim does not match its latest durable event");
    const core = {
      runId,
      nodeId,
      attemptRefDigest: digest({ runId, nodeId, attemptId }),
      ownerRefDigest: digest({ runId, nodeId, leaseOwner }),
      fenceToken,
      leaseExpiresAtMs,
      latestClaimEventSeq: safeInteger(event.eventSeq, "claim event sequence"),
      latestClaimEventHash: digestReference(event.eventHash),
    };
    if (core.latestClaimEventSeq > cursor) throw new TypeError("claim event is beyond the durable cursor");
    return { ...core, recordDigest: digest(core) };
  }).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

function authoritativeCommand({ stageDagPacket, executionSnapshot, schedulerResult, observation }) {
  const projection = plainRecord(ownData(executionSnapshot, "durableRunProjection"), "durableRunProjection");
  const resume = plainRecord(ownData(executionSnapshot, "durableResume"), "durableResume");
  const binding = { ...schedulerResult.binding };
  const topologyNodeIds = stageDagPacket.nodes.map((node) => node.nodeId).sort();
  const topology = new Set(topologyNodeIds);
  const events = denseArray(ownData(projection, "events"), "durableRunProjection.events", 20_000)
    .map((event, index) => plainRecord(event, `durableRunProjection.events[${index}]`));
  const run = plainRecord(ownData(projection, "run"), "durableRunProjection.run");
  const cursor = safeInteger(ownData(projection, "cursor"), "durable projection cursor");
  const headCheckpointId = ownData(projection, "headCheckpointId");
  const lastEvent = events.at(-1) ?? null;
  const completedNodeIds = sortedUniqueIds(
    denseArray(ownData(projection, "completedNodes"), "durableRunProjection.completedNodes", 512)
      .map((record) => ownData(plainRecord(record, "completed node"), "nodeId")),
    "completedNodeIds",
    topology,
  );
  const completed = new Set(completedNodeIds);
  const blockingEffectNodeIds = sortedUniqueIds(
    denseArray(ownData(resume, "blockingEffects"), "durableResume.blockingEffects", 512)
      .map((record) => ownData(plainRecord(record, "blocking effect"), "nodeId")),
    "blockingEffectNodeIds",
    topology,
  );
  const inDoubtNodeIds = sortedUniqueIds(
    [...new Set(events
      .filter((event) => event.eventType === "NodeAttemptInDoubt" && !completed.has(event.nodeId))
      .map((event) => event.nodeId))],
    "inDoubtNodeIds",
    topology,
  );
  const claims = denseArray(ownData(resume, "activeClaims"), "durableResume.activeClaims", 512);
  const claimRecords = normalizedClaimRecords({ claims, events, binding, topology, cursor });
  const eventChainState = projection.eventChain?.ok === true
    ? "verified"
    : projection.eventChain?.ok === false ? "failed" : "unknown";
  const sameHead =
    ownData(projection, "schemaVersion") === "durable-governed-run-projection-v0.1" &&
    run.runId === binding.runId &&
    ownData(resume, "runId") === binding.runId &&
    digestReference(run.taskFingerprint) === binding.taskFingerprint &&
    digestReference(run.graphDigest) === binding.graphDigest &&
    digestReference(stageDagPacket.graphDigest) === binding.graphDigest &&
    cursor === binding.durableCursor &&
    ownData(resume, "cursor") === cursor &&
    headCheckpointId === binding.headCheckpointId &&
    ownData(resume, "headCheckpointId") === headCheckpointId &&
    ownData(resume, "status") === run.status &&
    JSON.stringify(sortedUniqueIds(ownData(resume, "completedNodeIds"), "durableResume.completedNodeIds", topology)) ===
      JSON.stringify(completedNodeIds) &&
    (lastEvent === null ? binding.headEventHash === null : (
      lastEvent.eventSeq === cursor && digestReference(lastEvent.eventHash) === binding.headEventHash
    )) &&
    eventChainState === "verified";
  const runStatus = ["active", "completed", "failed", "blocked"].includes(run.status)
    ? run.status : "blocked";
  const trustedObservedAtMs = safeInteger(ownData(observation, "observedAtMs"), "trusted observedAtMs");
  const trustedObservedAtCore = {
    source: "stage_runner_bridge_wall_clock_capture",
    projectionDigest: binding.projectionDigest,
    cursor,
    headEventHash: binding.headEventHash,
    headCheckpointId,
    trustedObservedAtMs,
  };
  const blockingState = { completedNodeIds, blockingEffectNodeIds, inDoubtNodeIds };
  const authorityCore = {
    source: "stage_runner_bridge_existing_durable_authority_snapshot",
    projectionSchemaVersion: "durable-governed-run-projection-v0.1",
    runStatus,
    runId: binding.runId,
    taskFingerprint: binding.taskFingerprint,
    graphDigest: binding.graphDigest,
    projectionDigest: binding.projectionDigest,
    cursor,
    headEventHash: binding.headEventHash,
    headCheckpointId,
    eventChainState,
    currentness: sameHead ? "fresh_bound_same_settlement" : "unproven",
    topologyNodeIds,
    completedNodeIds,
    blockingEffectNodeIds,
    inDoubtNodeIds,
    claimSetDigest: digest(claimRecords),
    blockingStateDigest: digest(blockingState),
    trustedObservedAtMs,
    trustedObservedAtDigest: digest(trustedObservedAtCore),
  };
  return {
    binding,
    authoritySnapshot: { ...authorityCore, snapshotDigest: digest(authorityCore) },
    claimRecords,
    coordinatorObservation: {
      state: "not_exposed_by_current_snapshot",
      reasonCode: "coordinator_authority_not_exposed",
      projectionOnly: true,
      authoritative: false,
    },
  };
}

function invalidEnvelope(evaluationStatus = "not_evaluated_invalid_normalized_input") {
  return Object.freeze({
    schemaVersion: LEASE_CLAIM_AUTHORITY_SHADOW_ADAPTER_SCHEMA_VERSION,
    mode: "shadow_only",
    evaluationStatus,
    disposition: "in_doubt",
    result: null,
    authority: SHADOW_AUTHORITY,
  });
}

export function buildLeaseClaimAuthorityShadowProjection(normalizedInput = null, options = {}) {
  if (normalizedInput == null) return invalidEnvelope("not_evaluated_missing_normalized_input");
  try {
    exactRecord(normalizedInput, [], "normalizedInput");
    const trusted = exactRecord(options, OPTION_FIELDS, "lease claim shadow options");
    const stageDagPacket = ownData(trusted, "authoritativeStageDagPacket");
    validateStageDagPacket(stageDagPacket, { requireDigest: true });
    if (stageDagGraphDigest(stageDagPacket) !== stageDagPacket.graphDigest) {
      throw new TypeError("authoritative topology digest is invalid");
    }
    const executionSnapshot = exactRecord(
      ownData(trusted, "authoritativeExecutionSnapshot"),
      EXECUTION_SNAPSHOT_FIELDS,
      "authoritativeExecutionSnapshot",
    );
    const observation = exactRecord(
      ownData(trusted, "trustedObservationContext"),
      OBSERVATION_FIELDS,
      "trustedObservationContext",
    );
    if (ownData(observation, "source") !== "stage_runner_bridge_wall_clock_capture") {
      throw new TypeError("observation source is not bridge-owned");
    }
    const schedulerResult = validateSchedulerProjection(
      ownData(trusted, "schedulerAuthorityReuseShadowProjection"),
    );
    const result = evaluateLeaseClaimAuthorityShadow(authoritativeCommand({
      stageDagPacket,
      executionSnapshot,
      schedulerResult,
      observation,
    }));
    assertValidLeaseClaimAuthorityShadowResult(result);
    return Object.freeze({
      schemaVersion: LEASE_CLAIM_AUTHORITY_SHADOW_ADAPTER_SCHEMA_VERSION,
      mode: "shadow_only",
      evaluationStatus: "evaluated",
      disposition: result.disposition.state,
      result,
      authority: SHADOW_AUTHORITY,
    });
  } catch {
    return invalidEnvelope();
  }
}
