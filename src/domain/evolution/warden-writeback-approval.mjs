import { canonicalDigest, canonicalize } from "../shared/canonical-digest.mjs";

const APPROVAL_SCHEMA_VERSION = "warden-approval-v0.2";
const LEGACY_SCHEMA_VERSION = "warden-approval-v0.1";
const SCOPE_SET = new Set(["knowledge_lifecycle_transition", "canonical_reverse_sync"]);
const SHA256_REFERENCE = /^sha256:[a-f0-9]{64}$/u;
const APPROVAL_FIELDS = Object.freeze([
  "schemaVersion",
  "approvalId",
  "approver",
  "approvedAt",
  "scope",
  "mutationBindings",
  "diffSummary",
  "rollbackPlan",
  "riskReview",
]);
const BINDING_FIELDS = Object.freeze([
  "targetRef",
  "operation",
  "transitionId",
  "candidateDigest",
  "expectedSourceDigest",
  "rollbackPlanDigest",
]);

function errorResult(status, errors, normalized = null, approvalDigest = null) {
  return { ok: false, status, errors, normalized, approvalDigest };
}

function plainDataRecord(value, exactFields, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== exactFields.length ||
    keys.some((key) => typeof key !== "string" || !exactFields.includes(key))
  ) {
    throw new TypeError(`${label} has unsupported or missing fields`);
  }
  const result = {};
  for (const field of exactFields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${label} must contain enumerable own data properties only`);
    }
    result[field] = descriptor.value;
  }
  return result;
}

function finiteJson(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("approval data contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => finiteJson(item, seen));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    if (seen.has(value)) throw new TypeError("approval data contains a cycle");
    seen.add(value);
    const result = {};
    for (const key of Reflect.ownKeys(value).sort()) {
      if (typeof key !== "string") throw new TypeError("approval data contains a symbol key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError("approval data must contain enumerable own data properties only");
      }
      result[key] = finiteJson(descriptor.value, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError("approval data must be finite JSON data");
}

export function canonicalizeKnowledgeLifecycleValue(value) {
  return JSON.stringify(canonicalize(finiteJson(value)));
}

export function digestKnowledgeLifecycleValue(value) {
  return canonicalDigest(finiteJson(value));
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function requiredDigest(value, label) {
  if (typeof value !== "string" || !SHA256_REFERENCE.test(value)) {
    throw new TypeError(`${label} must be a strict sha256 reference`);
  }
  return value;
}

function requiredNonEmptyReviewObject(value, label) {
  const normalized = finiteJson(value);
  if (typeof normalized === "string" && normalized.trim()) return normalized;
  if (
    !normalized ||
    typeof normalized !== "object" ||
    Array.isArray(normalized) ||
    Object.keys(normalized).length === 0
  ) {
    throw new TypeError(`${label} must be non-empty review data`);
  }
  return normalized;
}

function bindingFromCandidate(candidate) {
  return normalizeBinding(candidate, "candidate");
}

function normalizeBinding(binding, index) {
  const value = plainDataRecord(binding, BINDING_FIELDS, `mutationBindings[${index}]`);
  for (const field of ["targetRef", "operation", "transitionId"]) requiredString(value[field], field);
  for (const field of ["candidateDigest", "expectedSourceDigest", "rollbackPlanDigest"]) {
    requiredDigest(value[field], field);
  }
  return value;
}

export function validateWardenWritebackApproval({ approvalPacket, candidates } = {}) {
  if (approvalPacket == null) return errorResult("approval_required", ["Warden approval v0.2 is required"]);
  if (approvalPacket?.schemaVersion === LEGACY_SCHEMA_VERSION) {
    return errorResult("legacy_unbound", ["warden-approval-v0.1 has no exact mutation/source binding"]);
  }
  try {
    const packet = plainDataRecord(approvalPacket, APPROVAL_FIELDS, "approvalPacket");
    if (packet.schemaVersion !== APPROVAL_SCHEMA_VERSION) {
      throw new TypeError("approvalPacket schemaVersion must be warden-approval-v0.2");
    }
    requiredString(packet.approvalId, "approvalId");
    if (packet.approver !== "meta-warden") throw new TypeError("approver must be meta-warden");
    requiredString(packet.approvedAt, "approvedAt");
    if (
      !Number.isFinite(Date.parse(packet.approvedAt)) ||
      new Date(packet.approvedAt).toISOString() !== packet.approvedAt
    ) {
      throw new TypeError("approvedAt must be a canonical ISO timestamp");
    }
    if (!SCOPE_SET.has(packet.scope)) throw new TypeError("approval scope is unsupported");
    requiredString(packet.diffSummary, "diffSummary");
    packet.rollbackPlan = requiredNonEmptyReviewObject(packet.rollbackPlan, "rollbackPlan");
    packet.riskReview = requiredNonEmptyReviewObject(packet.riskReview, "riskReview");
    if (!Array.isArray(packet.mutationBindings) || packet.mutationBindings.length === 0) {
      throw new TypeError("mutationBindings must be a non-empty array");
    }
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new TypeError("candidates must be a non-empty array");
    }
    const bindings = packet.mutationBindings.map(normalizeBinding);
    const candidateBindings = candidates.map(bindingFromCandidate);
    const bindingKeys = bindings.map((binding) => canonicalizeKnowledgeLifecycleValue(binding));
    const candidateKeys = candidateBindings.map((binding) => canonicalizeKnowledgeLifecycleValue(binding));
    if (new Set(bindingKeys).size !== bindingKeys.length) {
      throw new TypeError("mutationBindings must not contain duplicates");
    }
    if (new Set(candidateKeys).size !== candidateKeys.length) {
      throw new TypeError("candidates must not contain duplicate exact bindings");
    }
    const approvedTargets = bindings.map((binding) => binding.targetRef);
    const candidateTargets = candidateBindings.map((binding) => binding.targetRef);
    if (new Set(approvedTargets).size !== approvedTargets.length) {
      throw new TypeError("mutationBindings must not contain multiple mutations for one targetRef");
    }
    if (new Set(candidateTargets).size !== candidateTargets.length) {
      throw new TypeError("candidates must not contain multiple mutations for one targetRef");
    }
    const approvedSet = new Set(bindingKeys);
    if (
      candidateKeys.length !== bindingKeys.length ||
      candidateKeys.some((key) => !approvedSet.has(key))
    ) {
      throw new TypeError("each candidate must have exactly one matching mutation binding and no extras");
    }
    const normalized = finiteJson({ ...packet, mutationBindings: bindings });
    return {
      ok: true,
      status: "approved",
      errors: [],
      normalized,
      approvalDigest: digestKnowledgeLifecycleValue(normalized),
    };
  } catch (error) {
    return errorResult("invalid", [error instanceof Error ? error.message : String(error)]);
  }
}

export const WARDEN_WRITEBACK_APPROVAL_SCHEMA_VERSION = APPROVAL_SCHEMA_VERSION;
