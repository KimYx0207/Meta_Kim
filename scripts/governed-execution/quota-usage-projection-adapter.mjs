import { createHash } from "node:crypto";

import {
  assertValidQuotaUsageProjectionResult,
  evaluateQuotaUsageProjection,
} from "../../src/domain/quota/quota-usage-projection.mjs";
import { stageDagGraphDigest, validateStageDagPacket } from "./stage-dag.mjs";

export const QUOTA_USAGE_PROJECTION_ADAPTER_SCHEMA_VERSION =
  "quota-usage-projection-adapter-v1";

const OPTION_FIELDS = Object.freeze([
  "authoritativeStageDagPacket",
  "authoritativeExecutionSnapshot",
  "trustedQuotaPolicy",
  "trustedUsageObservation",
]);
const SNAPSHOT_FIELDS = Object.freeze(["durableRunProjection", "durableResume"]);
const QUOTA_KEYS = Object.freeze([
  "maxValidatedTransitions", "maxNoProgressLoops", "maxRetries", "maxWallClock", "maxCost",
]);
const UNITS = Object.freeze({
  maxValidatedTransitions: "count",
  maxNoProgressLoops: "count",
  maxRetries: "count",
  maxWallClock: "milliseconds",
  maxCost: "micro_usd",
});
const SHADOW_AUTHORITY = Object.freeze({
  projectsQuotaUsage: false,
  enforcesQuota: false,
  mutatesQuota: false,
  consumesQuota: false,
  stopsRun: false,
  pausesRun: false,
  retriesRun: false,
  dispatchesScheduler: false,
  writesKernel: false,
  writesEvents: false,
  advancesCursor: false,
  mutatesCheckpoint: false,
  writesTerminalStatus: false,
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
    throw new TypeError(`${label} must be enumerable own data`);
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
function denseArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain list`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError(`${label} must be dense own data`);
    }
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError(`${label} contains extra fields`);
  return value;
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
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
function metric(state, value, unit, evidenceRefDigest) {
  return { state, value, unit, scope: "root_run_lineage", evidenceRefDigest };
}
function snapshotParts(authoritativeExecutionSnapshot) {
  const snapshot = exactRecord(authoritativeExecutionSnapshot, SNAPSHOT_FIELDS, "authoritativeExecutionSnapshot");
  const projection = plainRecord(ownData(snapshot, "durableRunProjection"), "durableRunProjection");
  const resume = plainRecord(ownData(snapshot, "durableResume"), "durableResume");
  const run = plainRecord(ownData(projection, "run"), "durableRunProjection.run");
  const events = denseArray(ownData(projection, "events"), "durableRunProjection.events");
  return { projection, resume, run, events };
}
function currentHead(parts) {
  const { projection, resume, run, events } = parts;
  const lastEvent = events.at(-1) ?? null;
  const headMatches =
    ownData(projection, "schemaVersion") === "durable-governed-run-projection-v0.1" &&
    ownData(run, "runId") === ownData(resume, "runId") &&
    ownData(projection, "cursor") === ownData(resume, "cursor") &&
    ownData(projection, "headCheckpointId") === ownData(resume, "headCheckpointId") &&
    (lastEvent === null || (
      ownData(lastEvent, "eventSeq") === ownData(projection, "cursor") &&
      typeof ownData(lastEvent, "eventHash") === "string"
    ));
  return { lastEvent, headMatches };
}
function projectionBinding(parts) {
  const { projection, run } = parts;
  const { lastEvent } = currentHead(parts);
  const core = {
    runId: ownData(run, "runId"),
    rootRunId: ownData(run, "rootRunId"),
    taskFingerprint: digestReference(ownData(run, "taskFingerprint")),
    graphDigest: digestReference(ownData(run, "graphDigest")),
    durableCursor: ownData(projection, "cursor"),
    headEventHash: lastEvent === null ? null : digestReference(ownData(lastEvent, "eventHash")),
    headCheckpointId: ownData(projection, "headCheckpointId"),
  };
  return { ...core, projectionDigest: digest(core) };
}

export function buildTrustedQuotaUsageObservation({ authoritativeExecutionSnapshot, observedAt }) {
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new TypeError("observedAt must be a non-negative safe integer");
  const parts = snapshotParts(authoritativeExecutionSnapshot);
  const { projection, resume, run, events } = parts;
  const { headMatches } = currentHead(parts);
  const runId = ownData(run, "runId");
  const rootRunId = ownData(run, "rootRunId");
  const rootComplete =
    ownData(run, "parentRunId") === null &&
    runId === rootRunId &&
    ownData(resume, "rootRunId") === rootRunId &&
    ownData(resume, "parentRunId") === null;
  const chainTrusted = ownData(projection, "eventChain")?.ok === true && headMatches;
  let retryState = "observed";
  let retryValue = 0;
  let retryEvidence = null;
  const claimEvidence = [];
  const seenEventIds = new Set();
  const seenAttemptIds = new Set();
  let claimConflict = false;
  for (const event of events) {
    plainRecord(event, "durable event");
    const eventId = ownData(event, "eventId");
    if (seenEventIds.has(eventId)) claimConflict = true;
    seenEventIds.add(eventId);
    if (ownData(event, "runId") !== runId) claimConflict = true;
    if (ownData(event, "eventType") !== "NodeAttemptClaimed") continue;
    const attemptId = ownData(event, "attemptId");
    const payload = plainRecord(ownData(event, "payload"), "claim payload");
    const attemptNo = ownData(payload, "attemptNo");
    if (typeof attemptId !== "string" || seenAttemptIds.has(attemptId) || !Number.isSafeInteger(attemptNo) || attemptNo < 1) {
      claimConflict = true;
      continue;
    }
    seenAttemptIds.add(attemptId);
    if (attemptNo > 1) retryValue += 1;
    claimEvidence.push({ attemptIdDigest: digest(attemptId), attemptNo, eventSeq: ownData(event, "eventSeq") });
  }
  if (!rootComplete || !chainTrusted || claimConflict) {
    retryState = "in_doubt";
    retryValue = null;
  } else {
    retryEvidence = digest({ runId, rootRunId, claimEvidence });
  }
  const rootCreatedAt = Date.parse(ownData(run, "createdAt"));
  const wallTrusted = rootComplete && chainTrusted && Number.isSafeInteger(rootCreatedAt) && rootCreatedAt >= 0 && observedAt >= rootCreatedAt;
  const wallValue = wallTrusted ? observedAt - rootCreatedAt : null;
  const wallEvidence = wallTrusted ? digest({ runId, rootRunId, rootCreatedAt, observedAt }) : null;
  const metrics = {
    maxValidatedTransitions: metric("not_observed", null, UNITS.maxValidatedTransitions, null),
    maxNoProgressLoops: metric("not_observed", null, UNITS.maxNoProgressLoops, null),
    maxRetries: metric(retryState, retryValue, UNITS.maxRetries, retryEvidence),
    maxWallClock: metric(wallTrusted ? "observed" : "in_doubt", wallValue, UNITS.maxWallClock, wallEvidence),
    maxCost: metric("not_observed", null, UNITS.maxCost, null),
  };
  const core = { source: "stage_runner_bridge_durable_root_lineage", runId, rootRunId, observedAt, metrics };
  return deepFreeze({ ...core, observationDigest: digest(core) });
}

function invalidEnvelope(evaluationStatus = "not_evaluated_invalid_normalized_input") {
  return Object.freeze({
    schemaVersion: QUOTA_USAGE_PROJECTION_ADAPTER_SCHEMA_VERSION,
    mode: "shadow_only",
    evaluationStatus,
    disposition: "in_doubt",
    result: null,
    authority: SHADOW_AUTHORITY,
  });
}

export function buildQuotaUsageProjection(normalizedInput = null, options = {}) {
  if (normalizedInput == null) return invalidEnvelope("not_evaluated_missing_normalized_input");
  try {
    exactRecord(normalizedInput, [], "normalizedInput");
    const trusted = exactRecord(options, OPTION_FIELDS, "quota usage projection options");
    const stageDagPacket = ownData(trusted, "authoritativeStageDagPacket");
    validateStageDagPacket(stageDagPacket, { requireDigest: true });
    if (stageDagGraphDigest(stageDagPacket) !== stageDagPacket.graphDigest) throw new TypeError("stage DAG digest is invalid");
    const executionSnapshot = ownData(trusted, "authoritativeExecutionSnapshot");
    const parts = snapshotParts(executionSnapshot);
    const bound = projectionBinding(parts);
    if (digestReference(stageDagPacket.graphDigest) !== bound.graphDigest) throw new TypeError("stage DAG and durable graph differ");
    const suppliedObservation = ownData(trusted, "trustedUsageObservation");
    plainRecord(suppliedObservation, "trustedUsageObservation");
    const expectedObservation = buildTrustedQuotaUsageObservation({
      authoritativeExecutionSnapshot: executionSnapshot,
      observedAt: ownData(suppliedObservation, "observedAt"),
    });
    if (JSON.stringify(canonical(suppliedObservation)) !== JSON.stringify(canonical(expectedObservation))) {
      throw new TypeError("trusted usage observation does not match durable root-lineage truth");
    }
    const quotaPolicy = ownData(trusted, "trustedQuotaPolicy");
    const binding = {
      runId: bound.runId,
      rootRunId: bound.rootRunId,
      taskFingerprint: bound.taskFingerprint,
      graphDigest: bound.graphDigest,
      projectionDigest: bound.projectionDigest,
      durableCursor: bound.durableCursor,
      headEventHash: bound.headEventHash,
      headCheckpointId: bound.headCheckpointId,
      quotaPolicyDigest: ownData(quotaPolicy, "policyDigest"),
      usageObservationDigest: expectedObservation.observationDigest,
      evaluationRevision: ownData(quotaPolicy, "revision"),
    };
    const result = evaluateQuotaUsageProjection({ binding, quotaPolicy, trustedUsageObservation: expectedObservation });
    assertValidQuotaUsageProjectionResult(result);
    return Object.freeze({
      schemaVersion: QUOTA_USAGE_PROJECTION_ADAPTER_SCHEMA_VERSION,
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
