import { createHash } from "node:crypto";

import {
  assertValidRuntimeHealthProjectionResult,
  evaluateRuntimeHealthProjection,
} from "../../src/domain/runtime/runtime-health-projection.mjs";
import { assertValidLeaseClaimAuthorityShadowResult } from "../../src/domain/claims/lease-claim-authority-shadow.mjs";
import {
  stageDagGraphDigest,
  validateStageDagPacket,
} from "./stage-dag.mjs";

export const RUNTIME_HEALTH_PROJECTION_ADAPTER_SCHEMA_VERSION =
  "runtime-health-projection-adapter-v1";

const OPTION_FIELDS = Object.freeze([
  "authoritativeStageDagPacket",
  "authoritativeExecutionSnapshot",
  "leaseClaimAuthorityShadowProjection",
  "runtimeRegistryBinding",
  "trustedRuntimeObservation",
]);
const EXECUTION_SNAPSHOT_FIELDS = Object.freeze(["durableRunProjection", "durableResume"]);
const A05_ENVELOPE_FIELDS = Object.freeze([
  "schemaVersion", "mode", "evaluationStatus", "disposition", "result", "authority",
]);
const A05_AUTHORITY_FIELDS = Object.freeze([
  "projectsClaimTruth", "writesKernel", "writesEvents", "claimsNode", "takesOverClaim",
  "heartbeatsClaim", "releasesClaim", "changesLease", "changesFence", "selectsScheduler",
  "dispatchesScheduler", "completesNode", "terminatesRun", "projectionOnly",
]);
const REGISTRY_FIELDS = Object.freeze([
  "runtimeId", "runtimeMode", "catalogDigest", "capabilityMatrixDigest",
  "evidenceLedgerDigest", "registryDigest",
]);

const SHADOW_AUTHORITY = Object.freeze({
  projectsRuntimeHealth: false,
  claimsCurrentLiveness: false,
  writesKernel: false,
  writesEvents: false,
  dispatchesRuntime: false,
  claimsNode: false,
  takesOverClaim: false,
  retriesRuntime: false,
  consumesQuota: false,
  mutatesQuota: false,
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

function validateA05Projection(value) {
  const envelope = exactRecord(value, A05_ENVELOPE_FIELDS, "lease claim authority projection");
  if (
    ownData(envelope, "schemaVersion") !== "lease-claim-authority-shadow-adapter-v1" ||
    ownData(envelope, "mode") !== "shadow_only" ||
    ownData(envelope, "evaluationStatus") !== "evaluated"
  ) throw new TypeError("lease claim authority projection is not canonical evaluated evidence");
  const authority = exactRecord(ownData(envelope, "authority"), A05_AUTHORITY_FIELDS, "lease claim authority");
  for (const field of A05_AUTHORITY_FIELDS) {
    if (ownData(authority, field) !== (field === "projectionOnly")) {
      throw new TypeError("lease claim authority projection exposes forbidden authority");
    }
  }
  const result = ownData(envelope, "result");
  assertValidLeaseClaimAuthorityShadowResult(result);
  if (ownData(envelope, "disposition") !== result.disposition.state) {
    throw new TypeError("lease claim envelope conflicts with its canonical result");
  }
  return result;
}

function validateRegistryBinding(value) {
  const registry = exactRecord(value, REGISTRY_FIELDS, "runtimeRegistryBinding");
  const core = Object.fromEntries(REGISTRY_FIELDS
    .filter((field) => field !== "registryDigest")
    .map((field) => [field, ownData(registry, field)]));
  if (ownData(registry, "registryDigest") !== digest(core)) {
    throw new TypeError("runtime registry digest is invalid");
  }
  return Object.fromEntries(REGISTRY_FIELDS.map((field) => [field, ownData(registry, field)]));
}

function sameHeadBinding({ stageDagPacket, executionSnapshot, leaseResult }) {
  const projection = plainRecord(ownData(executionSnapshot, "durableRunProjection"), "durableRunProjection");
  const resume = plainRecord(ownData(executionSnapshot, "durableResume"), "durableResume");
  const run = plainRecord(ownData(projection, "run"), "durableRunProjection.run");
  const events = ownData(projection, "events");
  if (!Array.isArray(events)) throw new TypeError("durableRunProjection.events must be an array");
  const lastEvent = events.at(-1) ?? null;
  const binding = leaseResult.binding;
  const sameHead =
    ownData(projection, "schemaVersion") === "durable-governed-run-projection-v0.1" &&
    ownData(run, "runId") === binding.runId &&
    ownData(resume, "runId") === binding.runId &&
    digestReference(ownData(run, "taskFingerprint")) === binding.taskFingerprint &&
    digestReference(ownData(run, "graphDigest")) === binding.graphDigest &&
    digestReference(stageDagPacket.graphDigest) === binding.graphDigest &&
    ownData(projection, "cursor") === binding.durableCursor &&
    ownData(resume, "cursor") === binding.durableCursor &&
    ownData(projection, "headCheckpointId") === binding.headCheckpointId &&
    ownData(resume, "headCheckpointId") === binding.headCheckpointId &&
    (lastEvent === null
      ? binding.headEventHash === null
      : lastEvent.eventSeq === binding.durableCursor &&
        digestReference(lastEvent.eventHash) === binding.headEventHash) &&
    projection.eventChain?.ok === true &&
    leaseResult.authorityBinding.currentness === "fresh_bound_same_settlement" &&
    leaseResult.authorityBinding.eventChainState === "verified";
  if (!sameHead) throw new TypeError("runtime health projection is not bound to the current durable head");
  return binding;
}

function excludedSignalContext() {
  const absent = () => ({ present: false, evidenceDigest: null, provesRuntimeHealth: false });
  return {
    leaseClaimHeartbeat: absent(),
    openClawScheduledHeartbeat: absent(),
    presenceProbe: absent(),
    installOrConfigPresence: absent(),
    persistedCapabilityAcceptance: absent(),
  };
}

function invalidEnvelope(evaluationStatus = "not_evaluated_invalid_normalized_input") {
  return Object.freeze({
    schemaVersion: RUNTIME_HEALTH_PROJECTION_ADAPTER_SCHEMA_VERSION,
    mode: "shadow_only",
    evaluationStatus,
    disposition: "in_doubt",
    result: null,
    authority: SHADOW_AUTHORITY,
  });
}

export function buildRuntimeHealthProjection(normalizedInput = null, options = {}) {
  if (normalizedInput == null) return invalidEnvelope("not_evaluated_missing_normalized_input");
  try {
    exactRecord(normalizedInput, [], "normalizedInput");
    const trusted = exactRecord(options, OPTION_FIELDS, "runtime health projection options");
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
    const leaseResult = validateA05Projection(ownData(trusted, "leaseClaimAuthorityShadowProjection"));
    const registry = validateRegistryBinding(ownData(trusted, "runtimeRegistryBinding"));
    const leaseBinding = sameHeadBinding({ stageDagPacket, executionSnapshot, leaseResult });
    const binding = {
      runId: leaseBinding.runId,
      taskFingerprint: leaseBinding.taskFingerprint,
      graphDigest: leaseBinding.graphDigest,
      projectionDigest: leaseBinding.projectionDigest,
      durableCursor: leaseBinding.durableCursor,
      headEventHash: leaseBinding.headEventHash,
      headCheckpointId: leaseBinding.headCheckpointId,
      runtimeRegistryDigest: registry.registryDigest,
      policyDigest: digest({ contractId: "meta-kim-runtime-health-projection-contract", schemaVersion: 1 }),
      evaluationRevision: leaseBinding.evaluationRevision + 1,
    };
    const result = evaluateRuntimeHealthProjection({
      binding,
      runtimeRegistryBinding: registry,
      trustedObservation: ownData(trusted, "trustedRuntimeObservation"),
      excludedSignalContext: excludedSignalContext(),
    });
    assertValidRuntimeHealthProjectionResult(result);
    return Object.freeze({
      schemaVersion: RUNTIME_HEALTH_PROJECTION_ADAPTER_SCHEMA_VERSION,
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
