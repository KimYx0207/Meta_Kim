import { GOVERNANCE_REQUIREMENT_KEYS } from "./governance-requirements.mjs";

export const GOVERNANCE_REQUIREMENT_CUTOVER_SCHEMA_VERSION = "governance-requirement-cutover-v1";

export const GOVERNANCE_REQUIREMENT_ROLLOUT_MODE = "gradual_cutover";

export const GOVERNANCE_REQUIREMENT_CUTOVER_KEYS = Object.freeze([...GOVERNANCE_REQUIREMENT_KEYS]);

export const GOVERNANCE_REQUIREMENT_CUTOVER_MODES = Object.freeze([
  "legacy_authoritative",
  "shadow_compare",
  "domain_authoritative",
]);

const CUTOVER_GATE_REQUIREMENTS = Object.freeze([
  "versioned rollout policy",
  "explicit product decision reference",
  "per-gate legacy mapping",
  "per-gate parity evidence references",
  "per-gate cutover decision reference",
  "per-gate rollback reference",
  "focused positive and adversarial tests",
]);

const INPUT_KEYS = Object.freeze(["evaluation", "legacySnapshot", "rolloutPolicy"]);
const EVALUATION_KEYS = Object.freeze(["schemaVersion", "governanceRequirements", "parityDiagnostics"]);
const REQUIREMENT_KEYS = Object.freeze(["required", "reason", "evidence"]);
const LEGACY_SNAPSHOT_KEYS = Object.freeze(["schemaVersion", "sourceRef", "gates"]);
const ROLLOUT_POLICY_KEYS = Object.freeze([
  "schemaVersion",
  "workItem",
  "productDecisionRef",
  "defaultMode",
  "gates",
]);
const ROLLOUT_GATE_KEYS = Object.freeze([
  "mode",
  "parityEvidenceRefs",
  "cutoverDecisionRef",
  "rollbackRef",
]);
const PARITY_DIAGNOSTICS_KEYS = Object.freeze(["mode", "legacySource", "differences", "notes"]);
const PARITY_DIFFERENCE_KEYS = Object.freeze(["key", "shadowRequired", "legacyRequired"]);

const REFERENCE_PATTERN = /^(?:(?:fact|evidence|digest|policy|check|legacy|change|decision|security|intent|verification|receipt|cutover|rollback|product):[a-z0-9][a-z0-9._/-]{0,95}|sha256:[a-f0-9]{64})$/u;
const SENSITIVE_REFERENCE_PATTERN = /(?:raw[\s_-]*prompt|(?:api|access|private|client)[\s_-]*key|(?:client[\s_]*)?secret|(?:pass(?:word|phrase)?|credential|authorization|bearer|token)(?:$|[\s:._/-])|(?:^|[\s:._/-])(?:sk|pk|rk|ak)[_-](?:live|test|proj|prod)?[_-]?[a-z0-9]{8,}|(?:^|[\s:._/-])(?:ghp|gho|ghu|github_pat|xox[baprs]|ya29)[_-]?[a-z0-9_-]{6,}|(?:^|[\s:._/-])eyj[a-z0-9_-]{10,}|(?:^|[\s:._/-])key[_-][a-z0-9]{12,})/iu;
const SENSITIVE_TEXT_PATTERN = /raw[\s_-]*prompt|api[\s_-]*key|password|credential|secret|bearer|token/iu;

const AUTHORITY = Object.freeze({
  execution: false,
  action: false,
  permission: false,
  host: false,
  durableMutation: false,
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object.`);
}

function assertDataProperties(value, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${label} cannot contain symbol keys.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) || descriptor.get || descriptor.set) {
      throw new TypeError(`${label}.${key} must be an enumerable data property; accessors are rejected.`);
    }
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  assertDataProperties(value, label);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new TypeError(`${label} must contain exactly: ${required.join(", ")}.`);
  }
}

function assertAllowedKeys(value, allowed, required, label) {
  assertPlainObject(value, label);
  assertDataProperties(value, label);
  const actual = Object.keys(value).sort();
  const allowedKeys = [...allowed].sort();
  if (actual.some((key) => !allowedKeys.includes(key))) {
    throw new TypeError(`${label} contains an unsupported key.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} is required.`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
}

function normalizeReference(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be an opaque evidence reference.`);
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    SENSITIVE_REFERENCE_PATTERN.test(normalized) ||
    !REFERENCE_PATTERN.test(normalized)
  ) {
    throw new TypeError(`${label} must be a bounded opaque evidence reference, not prompt or secret content.`);
  }
  return normalized;
}

function assertDenseDataArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an ordinary array.`);
  }
  const expectedKeys = ["length", ...Array.from({ length: value.length }, (_, index) => String(index))].sort();
  const actualKeys = Reflect.ownKeys(value).map(String).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError(`${label} must contain only dense data elements.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor) || descriptor.get || descriptor.set) {
      throw new TypeError(`${label}[${index}] must be an enumerable data property.`);
    }
  }
  return value;
}

function normalizeReferenceArray(value, label, { minItems = 0 } = {}) {
  assertDenseDataArray(value, label);
  if (value.length < minItems) throw new TypeError(`${label} must contain at least ${minItems} reference(s).`);
  const normalized = Array.prototype.map.call(
    value,
    (item, index) => normalizeReference(item, `${label}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} must not contain duplicate references.`);
  }
  return normalized;
}

function normalizeOptionalReference(value, label) {
  if (value === null) return null;
  return normalizeReference(value, label);
}

function normalizeSafeText(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a non-empty bounded string.`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 512 || SENSITIVE_TEXT_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must not contain raw prompt or secret content.`);
  }
  return normalized;
}

function validateRequirement(value, label) {
  assertExactKeys(value, REQUIREMENT_KEYS, label);
  assertBoolean(value.required, `${label}.required`);
  return {
    required: value.required,
    reason: normalizeSafeText(value.reason, `${label}.reason`),
    evidence: normalizeReferenceArray(value.evidence, `${label}.evidence`),
  };
}

function validateEvaluation(value) {
  assertExactKeys(value, EVALUATION_KEYS, "evaluation");
  if (value.schemaVersion !== "governance-requirements-v1") {
    throw new TypeError("evaluation.schemaVersion must be governance-requirements-v1.");
  }
  assertExactKeys(value.governanceRequirements, GOVERNANCE_REQUIREMENT_CUTOVER_KEYS, "evaluation.governanceRequirements");
  const governanceRequirements = Object.fromEntries(
    GOVERNANCE_REQUIREMENT_CUTOVER_KEYS.map((key) => [
      key,
      validateRequirement(value.governanceRequirements[key], `evaluation.governanceRequirements.${key}`),
    ]),
  );

  assertExactKeys(value.parityDiagnostics, PARITY_DIAGNOSTICS_KEYS, "evaluation.parityDiagnostics");
  if (!["not_compared", "compared"].includes(value.parityDiagnostics.mode)) {
    throw new TypeError("evaluation.parityDiagnostics.mode is unsupported.");
  }
  const legacySource = value.parityDiagnostics.legacySource === null
    ? null
    : normalizeReference(value.parityDiagnostics.legacySource, "evaluation.parityDiagnostics.legacySource");
  assertDenseDataArray(value.parityDiagnostics.differences, "evaluation.parityDiagnostics.differences");
  const differences = Array.prototype.map.call(value.parityDiagnostics.differences, (difference, index) => {
    assertExactKeys(difference, PARITY_DIFFERENCE_KEYS, `evaluation.parityDiagnostics.differences[${index}]`);
    if (!GOVERNANCE_REQUIREMENT_CUTOVER_KEYS.includes(difference.key)) {
      throw new TypeError(`evaluation.parityDiagnostics.differences[${index}].key is unsupported.`);
    }
    assertBoolean(difference.shadowRequired, `evaluation.parityDiagnostics.differences[${index}].shadowRequired`);
    assertBoolean(difference.legacyRequired, `evaluation.parityDiagnostics.differences[${index}].legacyRequired`);
    return {
      key: difference.key,
      shadowRequired: difference.shadowRequired,
      legacyRequired: difference.legacyRequired,
    };
  });
  const notes = normalizeTextArray(value.parityDiagnostics.notes, "evaluation.parityDiagnostics.notes");
  return { governanceRequirements, legacySource, differences, notes };
}

function normalizeTextArray(value, label) {
  assertDenseDataArray(value, label);
  return Array.prototype.map.call(value, (item, index) => normalizeSafeText(item, `${label}[${index}]`));
}

function validateLegacySnapshot(value) {
  if (value === null) {
    throw new TypeError("legacySnapshot is required for fail-closed gradual cutover.");
  }
  assertExactKeys(value, LEGACY_SNAPSHOT_KEYS, "legacySnapshot");
  if (value.schemaVersion !== "governance-requirement-legacy-snapshot-v1") {
    throw new TypeError("legacySnapshot.schemaVersion is unsupported.");
  }
  const sourceRef = normalizeReference(value.sourceRef, "legacySnapshot.sourceRef");
  assertExactKeys(value.gates, GOVERNANCE_REQUIREMENT_CUTOVER_KEYS, "legacySnapshot.gates");
  const gates = Object.fromEntries(
    GOVERNANCE_REQUIREMENT_CUTOVER_KEYS.map((key) => [
      key,
      validateRequirement(value.gates[key], `legacySnapshot.gates.${key}`),
    ]),
  );
  return { sourceRef, gates };
}

function validateRolloutGate(value, label) {
  assertExactKeys(value, ROLLOUT_GATE_KEYS, label);
  return {
    mode: typeof value.mode === "string" ? value.mode : null,
    parityEvidenceRefs: normalizeReferenceArray(value.parityEvidenceRefs, `${label}.parityEvidenceRefs`),
    cutoverDecisionRef: normalizeOptionalReference(value.cutoverDecisionRef, `${label}.cutoverDecisionRef`),
    rollbackRef: normalizeOptionalReference(value.rollbackRef, `${label}.rollbackRef`),
  };
}

function validateRolloutPolicy(value) {
  assertExactKeys(value, ROLLOUT_POLICY_KEYS, "rolloutPolicy");
  if (value.schemaVersion !== "governance-requirement-rollout-v1") {
    throw new TypeError("rolloutPolicy.schemaVersion is unsupported.");
  }
  if (value.workItem !== "M3-P3") {
    throw new TypeError("rolloutPolicy.workItem must be M3-P3.");
  }
  const productDecisionRef = normalizeOptionalReference(value.productDecisionRef, "rolloutPolicy.productDecisionRef");
  const defaultMode = typeof value.defaultMode === "string" ? value.defaultMode : null;
  const defaultModeValid = GOVERNANCE_REQUIREMENT_CUTOVER_MODES.includes(defaultMode);
  assertExactKeys(value.gates, GOVERNANCE_REQUIREMENT_CUTOVER_KEYS, "rolloutPolicy.gates");
  const gates = Object.fromEntries(
    GOVERNANCE_REQUIREMENT_CUTOVER_KEYS.map((key) => [
      key,
      validateRolloutGate(value.gates[key], `rolloutPolicy.gates.${key}`),
    ]),
  );
  return { productDecisionRef, defaultMode, defaultModeValid, gates };
}

export function assertGovernanceRequirementCutoverConfiguration({ contract, rolloutPolicy }) {
  assertPlainObject(contract, "cutoverContract");
  assertDataProperties(contract, "cutoverContract");
  if (contract.schemaVersion !== "governance-requirement-cutover-contract-v1") {
    throw new TypeError("cutoverContract.schemaVersion is unsupported.");
  }
  if (contract.workItem !== "M3-P3") {
    throw new TypeError("cutoverContract.workItem must be M3-P3.");
  }
  if (
    JSON.stringify(contract.requirementOrder) !== JSON.stringify(GOVERNANCE_REQUIREMENT_CUTOVER_KEYS) ||
    JSON.stringify(contract.rolloutSequence) !== JSON.stringify(GOVERNANCE_REQUIREMENT_CUTOVER_KEYS)
  ) {
    throw new TypeError("cutoverContract requirement and rollout order must match the canonical Gate order.");
  }
  if (
    JSON.stringify(contract.allowedModes) !== JSON.stringify(GOVERNANCE_REQUIREMENT_CUTOVER_MODES) ||
    contract.defaultMode !== "legacy_authoritative"
  ) {
    throw new TypeError("cutoverContract modes must match the gradual-cutover modes.");
  }

  assertExactKeys(contract.legacyMappings, GOVERNANCE_REQUIREMENT_CUTOVER_KEYS, "cutoverContract.legacyMappings");
  for (const key of GOVERNANCE_REQUIREMENT_CUTOVER_KEYS) {
    const mapping = contract.legacyMappings[key];
    assertAllowedKeys(
      mapping,
      ["authorityRefs", "decisionEntrypoints", "legacyGap"],
      ["authorityRefs", "decisionEntrypoints"],
      `cutoverContract.legacyMappings.${key}`,
    );
    if (
      normalizeTextArray(mapping.authorityRefs, `cutoverContract.legacyMappings.${key}.authorityRefs`).length === 0 ||
      normalizeTextArray(mapping.decisionEntrypoints, `cutoverContract.legacyMappings.${key}.decisionEntrypoints`).length === 0
    ) {
      throw new TypeError(`cutoverContract.legacyMappings.${key} must bind authority and decision entrypoints.`);
    }
    if (Object.hasOwn(mapping, "legacyGap")) {
      normalizeSafeText(mapping.legacyGap, `cutoverContract.legacyMappings.${key}.legacyGap`);
    }
  }

  assertExactKeys(
    contract.cutoverGate,
    ["allRequired", "missingInputBehavior", "unknownModeBehavior"],
    "cutoverContract.cutoverGate",
  );
  if (
    JSON.stringify(contract.cutoverGate.allRequired) !== JSON.stringify(CUTOVER_GATE_REQUIREMENTS) ||
    contract.cutoverGate.missingInputBehavior !== "legacy_authoritative" ||
    contract.cutoverGate.unknownModeBehavior !== "legacy_authoritative_with_diagnostic"
  ) {
    throw new TypeError("cutoverContract.cutoverGate does not preserve the approved fail-closed gate.");
  }

  assertExactKeys(
    contract.authorityBoundary,
    [
      "controlsGovernanceRequirednessOnly",
      "executionAllowed",
      "actionAuthorizationAllowed",
      "permissionReceiptMintingAllowed",
      "nativeHostAuthorityAllowed",
      "durableMutationAllowed",
      "publicReadyAllowed",
      "rule",
    ],
    "cutoverContract.authorityBoundary",
  );
  if (
    contract.authorityBoundary.controlsGovernanceRequirednessOnly !== true ||
    contract.authorityBoundary.executionAllowed !== false ||
    contract.authorityBoundary.actionAuthorizationAllowed !== false ||
    contract.authorityBoundary.permissionReceiptMintingAllowed !== false ||
    contract.authorityBoundary.nativeHostAuthorityAllowed !== false ||
    contract.authorityBoundary.durableMutationAllowed !== false ||
    contract.authorityBoundary.publicReadyAllowed !== false
  ) {
    throw new TypeError("cutoverContract authority boundary must remain non-authorizing.");
  }

  assertExactKeys(
    contract.rollback,
    ["targetMode", "independentPerGate", "shadowRecordsBecomeAuthoritative", "requiresNewReviewAfterRollback"],
    "cutoverContract.rollback",
  );
  if (
    contract.rollback.targetMode !== "legacy_authoritative" ||
    contract.rollback.independentPerGate !== true ||
    contract.rollback.shadowRecordsBecomeAuthoritative !== false ||
    contract.rollback.requiresNewReviewAfterRollback !== true
  ) {
    throw new TypeError("cutoverContract rollback must be independent and legacy-authoritative.");
  }

  const normalizedRollout = validateRolloutPolicy(rolloutPolicy);
  if (
    normalizedRollout.defaultMode !== contract.defaultMode ||
    !normalizedRollout.defaultModeValid ||
    GOVERNANCE_REQUIREMENT_CUTOVER_KEYS.some(
      (key) => !GOVERNANCE_REQUIREMENT_CUTOVER_MODES.includes(normalizedRollout.gates[key].mode),
    )
  ) {
    throw new TypeError("rolloutPolicy modes must be declared by the cutover contract.");
  }
  return true;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function gateReason({ mode, modeValid, parityStatus, effectiveSource }) {
  if (!modeValid) {
    return "Invalid Gate rollout mode; legacy authority remains effective.";
  }
  if (parityStatus === "not_compared") {
    return "Legacy evidence is missing; legacy authority remains effective.";
  }
  if (parityStatus === "approved_divergence") {
    return "Approved divergence is recorded from explicit cutover evidence; no runtime authority is granted.";
  }
  if (parityStatus === "divergent") {
    return mode === "shadow_compare"
      ? "Shadow difference is diagnostic only; legacy authority remains effective."
      : "Legacy authority is selected by policy; the domain difference remains observational.";
  }
  if (effectiveSource === "domain") {
    return "Domain requirement matches legacy evidence and is selected for this plan; no runtime authority is granted.";
  }
  return "Domain and legacy requirements match; legacy authority remains effective by policy.";
}

function uniqueReferences(values) {
  return [...new Set(values)];
}

function gateSlug(key) {
  return key.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
}

function domainEvidenceMatchesGate({ key, rolloutPolicy, policy }) {
  const slug = gateSlug(key);
  return rolloutPolicy.productDecisionRef === "decision:m3-p3-explicit-start-2026-08-25" &&
    policy.parityEvidenceRefs.length === 1 &&
    policy.parityEvidenceRefs[0] === `check:m3-p3-${slug}-parity` &&
    policy.cutoverDecisionRef === `decision:m3-p3-${slug}-cutover` &&
    policy.rollbackRef === `policy:m3-p3-${slug}-rollback`;
}

function assertParityMatchesLegacy(evaluation, legacySnapshot) {
  if (evaluation.legacySource !== legacySnapshot.sourceRef) {
    throw new TypeError("evaluation parity source must match legacySnapshot.sourceRef.");
  }
  const expected = GOVERNANCE_REQUIREMENT_CUTOVER_KEYS.flatMap((key) => {
    const domainRequired = evaluation.governanceRequirements[key].required;
    const legacyRequired = legacySnapshot.gates[key].required;
    return domainRequired === legacyRequired ? [] : [{ key, shadowRequired: domainRequired, legacyRequired }];
  });
  if (
    evaluation.differences.length !== expected.length ||
    expected.some((record, index) => {
      const actual = evaluation.differences[index];
      return actual?.key !== record.key ||
        actual.shadowRequired !== record.shadowRequired ||
        actual.legacyRequired !== record.legacyRequired;
    })
  ) {
    throw new TypeError("evaluation parity differences must exactly match the supplied legacy snapshot.");
  }
}

export function buildGovernanceRequirementPlan(input) {
  assertExactKeys(input, INPUT_KEYS, "buildGovernanceRequirementPlan input");
  const evaluation = validateEvaluation(input.evaluation);
  const legacySnapshot = validateLegacySnapshot(input.legacySnapshot);
  const rolloutPolicy = validateRolloutPolicy(input.rolloutPolicy);
  assertParityMatchesLegacy(evaluation, legacySnapshot);
  for (const key of GOVERNANCE_REQUIREMENT_CUTOVER_KEYS) {
    const policy = rolloutPolicy.gates[key];
    if (
      rolloutPolicy.defaultModeValid &&
      policy.mode === "domain_authoritative" &&
      !domainEvidenceMatchesGate({ key, rolloutPolicy, policy })
    ) {
      throw new TypeError(`rolloutPolicy.gates.${key} domain evidence must be exactly bound to M3-P3 and this Gate.`);
    }
  }

  const gates = Object.fromEntries(
    GOVERNANCE_REQUIREMENT_CUTOVER_KEYS.map((key) => {
      const domain = evaluation.governanceRequirements[key];
      const legacy = legacySnapshot.gates[key];
      const policy = rolloutPolicy.gates?.[key] ?? null;
      const domainRequired = domain.required;
      const legacyRequired = legacy.required;
      const modeValid = rolloutPolicy.defaultModeValid && GOVERNANCE_REQUIREMENT_CUTOVER_MODES.includes(policy.mode);
      const mode = modeValid ? policy.mode : "legacy_authoritative";
      const domainEvidenceReady = mode === "domain_authoritative";
      const parityStatus = domainRequired === legacyRequired
          ? "matched"
          : domainEvidenceReady
            ? "approved_divergence"
            : "divergent";
      const canSelectDomain = domainEvidenceReady;
      const effectiveSource = canSelectDomain ? "domain" : "legacy";
      const evidence = uniqueReferences([
        ...domain.evidence,
        ...legacy.evidence,
        ...(policy?.parityEvidenceRefs ?? []),
        ...(policy
          ? [rolloutPolicy.productDecisionRef, policy.cutoverDecisionRef, policy.rollbackRef].filter(Boolean)
          : []),
      ]);
      return [key, {
        domainRequired,
        legacyRequired,
        effectiveRequired: effectiveSource === "domain" ? domainRequired : legacyRequired,
        effectiveSource,
        parityStatus,
        reason: gateReason({ mode, modeValid, parityStatus, effectiveSource }),
        evidence,
      }];
    }),
  );

  return deepFreeze({
    schemaVersion: GOVERNANCE_REQUIREMENT_CUTOVER_SCHEMA_VERSION,
    mode: GOVERNANCE_REQUIREMENT_ROLLOUT_MODE,
    productDecisionRef: rolloutPolicy.productDecisionRef,
    gates,
    authority: { ...AUTHORITY },
  });
}
