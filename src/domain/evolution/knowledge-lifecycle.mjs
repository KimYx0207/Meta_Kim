import { canonicalDigest, canonicalize } from "../shared/canonical-digest.mjs";

export const KNOWLEDGE_LIFECYCLE_REGISTRY_SCHEMA_VERSION =
  "knowledge-lifecycle-registry-v1";
export const KNOWLEDGE_LIFECYCLE_CANDIDATE_SCHEMA_VERSION =
  "knowledge-lifecycle-transition-candidate-v1";

export const KNOWLEDGE_LIFECYCLE_STATUSES = Object.freeze([
  "active",
  "aging",
  "deprecated",
  "retired",
]);

export const KNOWLEDGE_LIFECYCLE_OPERATIONS = Object.freeze([
  "retain",
  "mark_aging",
  "deprecate",
  "retire",
  "restore",
  "upgrade",
]);

const STATUS_SET = new Set(KNOWLEDGE_LIFECYCLE_STATUSES);
const OPERATION_SET = new Set(KNOWLEDGE_LIFECYCLE_OPERATIONS);
const KIND_SET = new Set(["knowledge", "rule", "capability_index"]);
const EXECUTION_CLASS_SET = new Set(["execution_eligible", "reference_only"]);
const SHA256_REFERENCE = /^sha256:[a-f0-9]{64}$/u;
const TRANSITIONS = Object.freeze({
  retain: Object.freeze({ from: KNOWLEDGE_LIFECYCLE_STATUSES, resolve: (status) => status }),
  mark_aging: Object.freeze({ from: ["active"], resolve: () => "aging" }),
  deprecate: Object.freeze({ from: ["aging"], resolve: () => "deprecated" }),
  retire: Object.freeze({ from: ["deprecated"], resolve: () => "retired" }),
  restore: Object.freeze({ from: ["aging", "deprecated", "retired"], resolve: () => "active" }),
  upgrade: Object.freeze({ from: KNOWLEDGE_LIFECYCLE_STATUSES, resolve: () => "active" }),
});
const FOUNDATIONAL_OPERATIONS = new Set(["retain", "upgrade", "restore"]);
const CANDIDATE_FIELDS = Object.freeze([
  "schemaVersion",
  "transitionId",
  "targetRef",
  "operation",
  "expectedStatus",
  "nextStatus",
  "expectedRegistryRevision",
  "expectedRegistryDigest",
  "expectedSourceDigest",
  "proposedSourceDigest",
  "replacementRefs",
  "reason",
  "evidenceRefs",
  "rollbackPlan",
  "proposedAt",
  "actor",
  "rollbackPlanDigest",
  "candidateDigest",
  "authorizationState",
  "authorization",
]);

function fail(message, code = "KNOWLEDGE_LIFECYCLE_INVALID") {
  const error = new Error(`Knowledge lifecycle: ${message}`);
  error.code = code;
  throw error;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}

function requiredDigest(value, label) {
  if (typeof value !== "string" || !SHA256_REFERENCE.test(value)) {
    fail(`${label} must be a strict sha256 reference`);
  }
  return value;
}

function requiredTimestamp(value, label) {
  requiredString(value, label);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function assertPlainData(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a plain object`);
  }
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(`${label} must not contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      fail(`${label} must contain enumerable own data properties only`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function stringArray(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const normalized = value.map((item, index) => requiredString(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail(`${label} must not contain duplicates`);
  return normalized;
}

function cloneJson(value) {
  try {
    return structuredClone(canonicalize(value));
  } catch {
    fail("value must be finite acyclic JSON data");
  }
}

function assertEntry(entry, targetRef) {
  const value = assertPlainData(entry, `entry ${targetRef}`);
  if (value.targetRef !== targetRef) fail(`entry ${targetRef} targetRef binding is invalid`);
  if (!KIND_SET.has(value.kind)) fail(`entry ${targetRef} kind is unsupported`);
  if (!STATUS_SET.has(value.status)) fail(`entry ${targetRef} status is unsupported`);
  if (typeof value.foundational !== "boolean") fail(`entry ${targetRef} foundational must be boolean`);
  if (!EXECUTION_CLASS_SET.has(value.executionClass)) {
    fail(`entry ${targetRef} executionClass is unsupported`);
  }
  requiredDigest(value.sourceDigest, `entry ${targetRef} sourceDigest`);
  stringArray(value.replacementRefs, `entry ${targetRef} replacementRefs`);
  assertPlainData(value.provenance, `entry ${targetRef} provenance`);
  stringArray(value.provenance.sourceRefs, `entry ${targetRef} provenance.sourceRefs`, { allowEmpty: false });
  stringArray(value.provenance.evidenceRefs, `entry ${targetRef} provenance.evidenceRefs`);
  requiredTimestamp(value.provenance.recordedAt, `entry ${targetRef} provenance.recordedAt`);
  assertPlainData(value.lifecycle, `entry ${targetRef} lifecycle`);
  requiredString(value.lifecycle.lastTransitionId, `entry ${targetRef} lifecycle.lastTransitionId`);
  requiredTimestamp(value.lifecycle.changedAt, `entry ${targetRef} lifecycle.changedAt`);
  if (value.foundational && value.status !== "active") {
    fail(`foundational entry ${targetRef} must remain active`);
  }
  if (value.status === "retired") {
    const tombstone = assertPlainData(value.tombstone, `entry ${targetRef} tombstone`);
    requiredTimestamp(tombstone.retiredAt, `entry ${targetRef} tombstone.retiredAt`);
    requiredString(tombstone.transitionId, `entry ${targetRef} tombstone.transitionId`);
    requiredDigest(tombstone.sourceDigest, `entry ${targetRef} tombstone.sourceDigest`);
    stringArray(tombstone.replacementRefs, `entry ${targetRef} tombstone.replacementRefs`, {
      allowEmpty: false,
    });
    if (tombstone.retained !== true || tombstone.deletionAuthorized !== false) {
      fail(`entry ${targetRef} tombstone must be retained and non-deleting`);
    }
  }
  return value;
}

export function validateKnowledgeLifecycleRegistry(registry) {
  const value = assertPlainData(registry, "registry");
  if (value.schemaVersion !== KNOWLEDGE_LIFECYCLE_REGISTRY_SCHEMA_VERSION) {
    fail("registry schemaVersion is unsupported");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    fail("registry revision must be a non-negative safe integer");
  }
  requiredTimestamp(value.updatedAt, "registry updatedAt");
  const entries = assertPlainData(value.entries, "registry entries");
  for (const [targetRef, entry] of Object.entries(entries)) {
    requiredString(targetRef, "entry targetRef");
    assertEntry(entry, targetRef);
  }
  const applied = assertPlainData(value.appliedTransitions, "registry appliedTransitions");
  for (const [transitionId, record] of Object.entries(applied)) {
    requiredString(transitionId, "applied transition id");
    const transition = assertPlainData(record, `applied transition ${transitionId}`);
    requiredDigest(transition.candidateDigest, `applied transition ${transitionId} candidateDigest`);
    requiredDigest(transition.approvalDigest, `applied transition ${transitionId} approvalDigest`);
    requiredTimestamp(transition.appliedAt, `applied transition ${transitionId} appliedAt`);
  }
  if (!Array.isArray(value.history)) fail("registry history must be an array");
  return cloneJson(value);
}

function candidateCoreFrom(value) {
  const candidate = assertPlainData(value, "transition candidate");
  const core = {
    schemaVersion: candidate.schemaVersion,
    transitionId: candidate.transitionId,
    targetRef: candidate.targetRef,
    operation: candidate.operation,
    expectedStatus: candidate.expectedStatus,
    nextStatus: candidate.nextStatus,
    expectedRegistryRevision: candidate.expectedRegistryRevision,
    expectedRegistryDigest: candidate.expectedRegistryDigest,
    expectedSourceDigest: candidate.expectedSourceDigest,
    proposedSourceDigest: candidate.proposedSourceDigest,
    replacementRefs: candidate.replacementRefs,
    reason: candidate.reason,
    evidenceRefs: candidate.evidenceRefs,
    rollbackPlan: candidate.rollbackPlan,
    proposedAt: candidate.proposedAt,
    actor: candidate.actor,
  };
  return cloneJson(core);
}

export function digestKnowledgeLifecycleTransitionCandidate(candidate) {
  return canonicalDigest(candidateCoreFrom(candidate));
}

export function assertKnowledgeLifecycleTransitionCandidate(value) {
  const candidate = assertPlainData(value, "transition candidate");
  const candidateKeys = Reflect.ownKeys(candidate);
  if (
    candidateKeys.length !== CANDIDATE_FIELDS.length ||
    candidateKeys.some((key) => typeof key !== "string" || !CANDIDATE_FIELDS.includes(key))
  ) {
    fail("transition candidate has unsupported or missing fields");
  }
  if (candidate.schemaVersion !== KNOWLEDGE_LIFECYCLE_CANDIDATE_SCHEMA_VERSION) {
    fail("transition candidate schemaVersion is unsupported");
  }
  requiredString(candidate.transitionId, "transitionId");
  requiredString(candidate.targetRef, "targetRef");
  if (!OPERATION_SET.has(candidate.operation)) fail("operation is unsupported");
  if (!STATUS_SET.has(candidate.expectedStatus) || !STATUS_SET.has(candidate.nextStatus)) {
    fail("candidate status binding is unsupported");
  }
  if (!Number.isSafeInteger(candidate.expectedRegistryRevision) || candidate.expectedRegistryRevision < 0) {
    fail("expectedRegistryRevision must be a non-negative safe integer");
  }
  requiredDigest(candidate.expectedRegistryDigest, "expectedRegistryDigest");
  requiredDigest(candidate.expectedSourceDigest, "expectedSourceDigest");
  requiredDigest(candidate.proposedSourceDigest, "proposedSourceDigest");
  stringArray(candidate.replacementRefs, "replacementRefs");
  requiredString(candidate.reason, "reason");
  stringArray(candidate.evidenceRefs, "evidenceRefs", { allowEmpty: false });
  assertPlainData(candidate.rollbackPlan, "rollbackPlan");
  requiredString(candidate.rollbackPlan.action, "rollbackPlan.action");
  requiredString(candidate.rollbackPlan.restoreStatus, "rollbackPlan.restoreStatus");
  requiredTimestamp(candidate.proposedAt, "proposedAt");
  requiredString(candidate.actor, "actor");
  requiredDigest(candidate.rollbackPlanDigest, "rollbackPlanDigest");
  requiredDigest(candidate.candidateDigest, "candidateDigest");
  if (candidate.rollbackPlanDigest !== canonicalDigest(candidate.rollbackPlan)) {
    fail("rollbackPlanDigest does not bind rollbackPlan");
  }
  if (candidate.candidateDigest !== digestKnowledgeLifecycleTransitionCandidate(candidate)) {
    fail("candidateDigest does not bind the transition candidate");
  }
  if (candidate.authorizationState !== "candidate_only") {
    fail("transition candidates must remain candidate_only before approval");
  }
  const authorization = assertPlainData(candidate.authorization, "candidate authorization");
  const expectedAuthorization = {
    approved: false,
    mayWrite: false,
    mayDelete: false,
    mayAuthorizeExecution: false,
  };
  if (canonicalDigest(authorization) !== canonicalDigest(expectedAuthorization)) {
    fail("candidate authorization must keep every authority flag false");
  }
  return cloneJson(candidate);
}

export function createKnowledgeLifecycleTransitionCandidate({
  registry,
  targetRef,
  operation,
  transitionId,
  reason,
  evidenceRefs,
  replacementRefs,
  proposedSourceDigest,
  rollbackPlan,
  proposedAt,
  actor,
}) {
  const current = validateKnowledgeLifecycleRegistry(registry);
  requiredString(targetRef, "targetRef");
  const entry = current.entries[targetRef];
  if (!entry) fail(`unknown lifecycle target ${targetRef}`, "KNOWLEDGE_LIFECYCLE_NOT_FOUND");
  if (!OPERATION_SET.has(operation)) fail("operation is unsupported");
  const policy = TRANSITIONS[operation];
  if (!policy.from.includes(entry.status)) {
    fail(`operation ${operation} is not legal from ${entry.status}`);
  }
  if (entry.foundational && !FOUNDATIONAL_OPERATIONS.has(operation)) {
    fail("foundational capabilities may only be retained, upgraded, or restored");
  }
  const nextStatus = policy.resolve(entry.status);
  const replacements = replacementRefs ?? entry.replacementRefs;
  stringArray(replacements, "replacementRefs");
  if (["deprecated", "retired"].includes(nextStatus) && replacements.length === 0) {
    fail(`${nextStatus} entries require at least one replacement reference`);
  }
  if (replacements.includes(targetRef)) fail("replacementRefs must not reference the target itself");
  const nextSourceDigest = proposedSourceDigest ?? entry.sourceDigest;
  requiredDigest(nextSourceDigest, "proposedSourceDigest");
  if (operation !== "upgrade" && nextSourceDigest !== entry.sourceDigest) {
    fail("only upgrade may change sourceDigest");
  }
  const plan = rollbackPlan ?? {
    action: "restore_previous_registry_entry",
    restoreStatus: entry.status,
    preserveUnknownState: true,
  };
  const core = {
    schemaVersion: KNOWLEDGE_LIFECYCLE_CANDIDATE_SCHEMA_VERSION,
    transitionId: requiredString(transitionId, "transitionId"),
    targetRef,
    operation,
    expectedStatus: entry.status,
    nextStatus,
    expectedRegistryRevision: current.revision,
    expectedRegistryDigest: canonicalDigest(current),
    expectedSourceDigest: entry.sourceDigest,
    proposedSourceDigest: nextSourceDigest,
    replacementRefs: [...replacements],
    reason: requiredString(reason, "reason"),
    evidenceRefs: stringArray(evidenceRefs, "evidenceRefs", { allowEmpty: false }),
    rollbackPlan: cloneJson(plan),
    proposedAt: requiredTimestamp(proposedAt, "proposedAt"),
    actor: requiredString(actor, "actor"),
  };
  const candidate = {
    ...core,
    rollbackPlanDigest: canonicalDigest(core.rollbackPlan),
    candidateDigest: canonicalDigest(core),
    authorizationState: "candidate_only",
    authorization: {
      approved: false,
      mayWrite: false,
      mayDelete: false,
      mayAuthorizeExecution: false,
    },
  };
  return Object.freeze(candidate);
}

export function applyKnowledgeLifecycleTransitionToRegistry({
  registry,
  candidate,
  approvalDigest,
  appliedAt,
}) {
  const current = validateKnowledgeLifecycleRegistry(registry);
  const mutation = assertKnowledgeLifecycleTransitionCandidate(candidate);
  requiredDigest(approvalDigest, "approvalDigest");
  requiredTimestamp(appliedAt, "appliedAt");
  const alreadyApplied = current.appliedTransitions[mutation.transitionId];
  if (alreadyApplied) {
    if (alreadyApplied.candidateDigest !== mutation.candidateDigest) {
      fail("transitionId is already bound to a different candidate", "KNOWLEDGE_LIFECYCLE_IDEMPOTENCY_CONFLICT");
    }
    return { registry: current, applied: false, idempotent: true };
  }
  if (
    current.revision !== mutation.expectedRegistryRevision ||
    canonicalDigest(current) !== mutation.expectedRegistryDigest
  ) {
    fail("registry compare-and-set precondition failed", "KNOWLEDGE_LIFECYCLE_CAS_MISMATCH");
  }
  const previous = current.entries[mutation.targetRef];
  if (!previous) fail(`unknown lifecycle target ${mutation.targetRef}`, "KNOWLEDGE_LIFECYCLE_NOT_FOUND");
  if (previous.status !== mutation.expectedStatus || previous.sourceDigest !== mutation.expectedSourceDigest) {
    fail("candidate source/status binding no longer matches the registry", "KNOWLEDGE_LIFECYCLE_CAS_MISMATCH");
  }
  if (previous.foundational && !FOUNDATIONAL_OPERATIONS.has(mutation.operation)) {
    fail("foundational capabilities may only be retained, upgraded, or restored");
  }
  const policy = TRANSITIONS[mutation.operation];
  if (!policy.from.includes(previous.status) || policy.resolve(previous.status) !== mutation.nextStatus) {
    fail("candidate transition is not legal for the current state");
  }
  const nextEntry = {
    ...previous,
    status: mutation.nextStatus,
    sourceDigest: mutation.proposedSourceDigest,
    replacementRefs: [...mutation.replacementRefs],
    lifecycle: {
      ...previous.lifecycle,
      lastTransitionId: mutation.transitionId,
      changedAt: appliedAt,
      reason: mutation.reason,
    },
  };
  if (
    previous.executionClass === "reference_only" &&
    nextEntry.executionClass !== "reference_only"
  ) {
    fail("reference-only knowledge cannot be promoted to execution authority");
  }
  if (mutation.nextStatus === "retired") {
    nextEntry.tombstone = {
      retiredAt: appliedAt,
      transitionId: mutation.transitionId,
      sourceDigest: mutation.proposedSourceDigest,
      replacementRefs: [...mutation.replacementRefs],
      retained: true,
      deletionAuthorized: false,
    };
  } else if (["restore", "upgrade"].includes(mutation.operation)) {
    delete nextEntry.tombstone;
  }
  const next = {
    ...current,
    revision: current.revision + 1,
    updatedAt: appliedAt,
    entries: {
      ...current.entries,
      [mutation.targetRef]: nextEntry,
    },
    appliedTransitions: {
      ...current.appliedTransitions,
      [mutation.transitionId]: {
        targetRef: mutation.targetRef,
        operation: mutation.operation,
        fromStatus: previous.status,
        toStatus: mutation.nextStatus,
        candidateDigest: mutation.candidateDigest,
        approvalDigest,
        appliedAt,
        rollbackPlanDigest: mutation.rollbackPlanDigest,
      },
    },
    history: [
      ...current.history,
      {
        transitionId: mutation.transitionId,
        targetRef: mutation.targetRef,
        operation: mutation.operation,
        fromStatus: previous.status,
        toStatus: mutation.nextStatus,
        previousEntry: cloneJson(previous),
        candidateDigest: mutation.candidateDigest,
        approvalDigest,
        appliedAt,
      },
    ],
  };
  return {
    registry: validateKnowledgeLifecycleRegistry(next),
    applied: true,
    idempotent: false,
  };
}
