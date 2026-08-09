const FACTS_SCHEMA_VERSION = "governance-task-facts-v1";
const REQUIREMENTS_SCHEMA_VERSION = "governance-requirements-v1";

export const GOVERNANCE_REQUIREMENT_KEYS = Object.freeze([
  "clarification",
  "research",
  "planning",
  "humanDecision",
  "permission",
  "review",
  "metaReview",
  "securityReview",
  "verification",
  "evolution",
]);

const MATERIAL_DECISION_DIMENSIONS = new Set([
  "result",
  "risk",
  "cost",
  "scope",
  "permission",
  "compatibility",
  "longTermImpact",
  "publicReadyAcceptance",
]);

const SECURITY_FACT_KEYS = Object.freeze([
  "auth",
  "permission",
  "credential",
  "secret",
  "payment",
  "production",
  "databaseDestructive",
  "systemConfiguration",
  "highPrivilegeDependency",
  "highRiskMcp",
]);

const CHANGE_FACT_KEYS = Object.freeze([
  "multiStep",
  "crossModule",
  "dataMigration",
  "externalSideEffect",
  "complexArchitectureChange",
  "multipleCapabilities",
  "publicInterfaceChange",
  "complexBusinessLogic",
  "dataStructureChange",
  "behaviorPreservingInternalOnly",
]);

const OPAQUE_REFERENCE_PATTERN = /^(?:(?:fact|evidence|digest|policy|check|legacy|change|decision|security|intent|verification):[a-z0-9][a-z0-9._/-]{0,95}|sha256:[a-f0-9]{64})$/u;
// Applies after NFKC normalization.  These are credential *payload* markers,
// so a legal namespace such as `evidence:` cannot disguise a token value.
// Hash-only SHA-256 references do not match any of these marker families.
const SENSITIVE_REFERENCE_PATTERN = /(?:raw[\s_-]*prompt|(?:api|access|private|client)[\s_-]*key|(?:client[\s_-]*)?secret|(?:pass(?:word|phrase)?|credential|authorization|bearer|token)(?:$|[\s:._/-])|(?:^|[\s:._/-])(?:sk|pk|rk|ak)[_-](?:live|test|proj|prod)?[_-]?[a-z0-9]{8,}|(?:^|[\s:._/-])(?:ghp|gho|ghu|github_pat|xox[baprs]|ya29)[_-]?[a-z0-9_-]{6,}|(?:^|[\s:._/-])eyj[a-z0-9_-]{10,}|(?:^|[\s:._/-])key[_-][a-z0-9]{12,})/iu;

const CHANGE_EVIDENCE_REFS = Object.freeze({
  multiStep: "change:multi-step",
  crossModule: "change:cross-module",
  dataMigration: "change:data-migration",
  externalSideEffect: "change:external-side-effect",
  complexArchitectureChange: "change:complex-architecture",
  multipleCapabilities: "change:multiple-capabilities",
  publicInterfaceChange: "change:public-interface",
  complexBusinessLogic: "change:complex-business-logic",
  dataStructureChange: "change:data-structure",
});

const SECURITY_EVIDENCE_REFS = Object.freeze({
  auth: "security:auth",
  permission: "security:permission",
  credential: "security:access-material",
  secret: "security:sensitive-material",
  payment: "security:payment",
  production: "security:production",
  databaseDestructive: "security:database-destructive",
  systemConfiguration: "security:system-configuration",
  highPrivilegeDependency: "security:high-privilege-dependency",
  highRiskMcp: "security:high-risk-mcp",
});

const DECISION_EVIDENCE_REFS = Object.freeze({
  result: "decision:result",
  risk: "decision:risk",
  cost: "decision:cost",
  scope: "decision:scope",
  permission: "decision:permission",
  compatibility: "decision:compatibility",
  longTermImpact: "decision:long-term-impact",
  publicReadyAcceptance: "decision:public-ready-acceptance",
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object.`);
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
}

function normalizeOpaqueReference(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be an opaque evidence reference.`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > 128 || SENSITIVE_REFERENCE_PATTERN.test(normalized) ||
      !OPAQUE_REFERENCE_PATTERN.test(normalized)) {
    throw new TypeError(`${label} must be a bounded opaque evidence reference, not prompt or secret content.`);
  }
  return normalized;
}

function normalizeOpaqueReferenceArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of opaque evidence references.`);
  const normalized = value.map((item, index) => normalizeOpaqueReference(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${label} must not contain duplicate opaque evidence references.`);
  }
  return normalized;
}

function assertExactKeys(value, keys, label) {
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      throw new TypeError(`${label} cannot contain symbol keys.`);
    }
    if (Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true) {
      throw new TypeError(`${label}.${key} must be an enumerable own property.`);
    }
  }
  const actual = ownKeys.sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) ||
      expected.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
}

/**
 * Validates normalized facts. Raw prompts, runtime handles, and IO references
 * intentionally do not belong to this domain boundary.
 */
export function validateGovernanceTaskFacts(taskFacts) {
  assertPlainObject(taskFacts, "taskFacts");
  assertExactKeys(
    taskFacts,
    ["schemaVersion", "intent", "clarity", "evidence", "change", "decision", "security", "verification"],
    "taskFacts",
  );
  if (taskFacts.schemaVersion !== FACTS_SCHEMA_VERSION) {
    throw new TypeError(`taskFacts.schemaVersion must be ${FACTS_SCHEMA_VERSION}.`);
  }

  assertPlainObject(taskFacts.intent, "taskFacts.intent");
  assertExactKeys(taskFacts.intent, ["executable", "userRequestedReview", "durableLearningRequested"], "taskFacts.intent");
  for (const key of Object.keys(taskFacts.intent)) assertBoolean(taskFacts.intent[key], `taskFacts.intent.${key}`);

  assertPlainObject(taskFacts.clarity, "taskFacts.clarity");
  assertExactKeys(taskFacts.clarity, ["blockingUnknowns"], "taskFacts.clarity");
  const blockingUnknowns = normalizeOpaqueReferenceArray(
    taskFacts.clarity.blockingUnknowns,
    "taskFacts.clarity.blockingUnknowns",
  );

  assertPlainObject(taskFacts.evidence, "taskFacts.evidence");
  assertExactKeys(taskFacts.evidence, ["currentExternalFactsRequired", "localEvidenceSufficient", "references"], "taskFacts.evidence");
  assertBoolean(taskFacts.evidence.currentExternalFactsRequired, "taskFacts.evidence.currentExternalFactsRequired");
  assertBoolean(taskFacts.evidence.localEvidenceSufficient, "taskFacts.evidence.localEvidenceSufficient");
  const evidenceReferences = normalizeOpaqueReferenceArray(
    taskFacts.evidence.references,
    "taskFacts.evidence.references",
  );

  assertPlainObject(taskFacts.change, "taskFacts.change");
  assertExactKeys(taskFacts.change, CHANGE_FACT_KEYS, "taskFacts.change");
  for (const key of CHANGE_FACT_KEYS) assertBoolean(taskFacts.change[key], `taskFacts.change.${key}`);

  assertPlainObject(taskFacts.decision, "taskFacts.decision");
  assertExactKeys(taskFacts.decision, ["reasonableOptionCount", "materialDimensions", "internalImplementationOnly"], "taskFacts.decision");
  if (!Number.isInteger(taskFacts.decision.reasonableOptionCount) || taskFacts.decision.reasonableOptionCount < 0) {
    throw new TypeError("taskFacts.decision.reasonableOptionCount must be a non-negative integer.");
  }
  if (!Array.isArray(taskFacts.decision.materialDimensions) ||
      taskFacts.decision.materialDimensions.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError("taskFacts.decision.materialDimensions must be an array of non-empty registered dimensions.");
  }
  if (new Set(taskFacts.decision.materialDimensions).size !== taskFacts.decision.materialDimensions.length ||
      taskFacts.decision.materialDimensions.some((dimension) => !MATERIAL_DECISION_DIMENSIONS.has(dimension))) {
    throw new TypeError("taskFacts.decision.materialDimensions must contain unique registered dimensions.");
  }
  assertBoolean(taskFacts.decision.internalImplementationOnly, "taskFacts.decision.internalImplementationOnly");

  assertPlainObject(taskFacts.security, "taskFacts.security");
  assertExactKeys(taskFacts.security, SECURITY_FACT_KEYS, "taskFacts.security");
  for (const key of SECURITY_FACT_KEYS) assertBoolean(taskFacts.security[key], `taskFacts.security.${key}`);

  assertPlainObject(taskFacts.verification, "taskFacts.verification");
  assertExactKeys(taskFacts.verification, ["deterministicChecks"], "taskFacts.verification");
  const deterministicChecks = normalizeOpaqueReferenceArray(
    taskFacts.verification.deterministicChecks,
    "taskFacts.verification.deterministicChecks",
  );
  if (taskFacts.decision.internalImplementationOnly && taskFacts.decision.materialDimensions.length > 0) {
    throw new TypeError("Internal-only implementation alternatives cannot declare material user-facing dimensions.");
  }
  return Object.freeze({
    ...taskFacts,
    clarity: Object.freeze({ ...taskFacts.clarity, blockingUnknowns: Object.freeze(blockingUnknowns) }),
    evidence: Object.freeze({ ...taskFacts.evidence, references: Object.freeze(evidenceReferences) }),
    verification: Object.freeze({ ...taskFacts.verification, deterministicChecks: Object.freeze(deterministicChecks) }),
  });
}

function requirement(required, reason, evidence) {
  if (typeof required !== "boolean" || !reason || !Array.isArray(evidence)) {
    throw new TypeError("Requirement construction must produce required:boolean, a reason, and opaque evidence references.");
  }
  return Object.freeze({ required, reason, evidence: Object.freeze(normalizeOpaqueReferenceArray(evidence, "requirement.evidence")) });
}

function trueFactKeys(record) {
  return Object.keys(record).filter((key) => record[key] === true);
}

function buildParityDiagnostics(requirements, legacyGate) {
  if (legacyGate == null) {
    return Object.freeze({
      mode: "not_compared",
      legacySource: null,
      differences: Object.freeze([]),
      notes: Object.freeze(["Shadow engine did not receive a legacy gate snapshot."]),
    });
  }
  assertPlainObject(legacyGate, "legacyGate");
  assertExactKeys(legacyGate, ["source", "requirements"], "legacyGate");
  const legacySource = normalizeOpaqueReference(legacyGate.source, "legacyGate.source");
  assertPlainObject(legacyGate.requirements, "legacyGate.requirements");
  assertExactKeys(legacyGate.requirements, GOVERNANCE_REQUIREMENT_KEYS, "legacyGate.requirements");
  for (const key of GOVERNANCE_REQUIREMENT_KEYS) assertBoolean(legacyGate.requirements[key], `legacyGate.requirements.${key}`);

  const differences = GOVERNANCE_REQUIREMENT_KEYS.flatMap((key) =>
    legacyGate.requirements[key] === requirements[key].required
      ? []
      : [{ key, shadowRequired: requirements[key].required, legacyRequired: legacyGate.requirements[key] }],
  );
  return Object.freeze({
    mode: "compared",
    legacySource,
    differences: Object.freeze(differences),
    notes: Object.freeze(
      differences.length === 0
        ? ["Shadow requirements match the supplied legacy gate snapshot."]
        : ["Differences are diagnostic only; this shadow engine does not replace the legacy gate."],
    ),
  });
}

/**
 * Derives one explainable requirement record per governance capability.
 * It is a pure shadow evaluator: it never invokes tools, persists state, or
 * changes the existing route gate.
 */
export function evaluateGovernanceRequirements(taskFacts, { legacyGate = null } = {}) {
  const facts = validateGovernanceTaskFacts(taskFacts);
  const securityFactKeys = trueFactKeys(facts.security);
  const changeReasons = trueFactKeys(facts.change)
    .filter((key) => key !== "behaviorPreservingInternalOnly")
    .map((key) => CHANGE_EVIDENCE_REFS[key]);
  const securityReasons = securityFactKeys.map((key) => SECURITY_EVIDENCE_REFS[key]);
  const hasMaterialDecision =
    facts.decision.reasonableOptionCount >= 2 &&
    facts.decision.materialDimensions.length > 0 &&
    facts.decision.internalImplementationOnly === false;
  const planningRequired =
    facts.change.multiStep || facts.change.crossModule || facts.change.dataMigration ||
    facts.change.externalSideEffect || facts.change.complexArchitectureChange || facts.change.multipleCapabilities;
  const permissionRequired =
    facts.change.externalSideEffect || securityFactKeys.some((key) =>
      ["permission", "credential", "secret", "payment", "production", "databaseDestructive", "systemConfiguration", "highPrivilegeDependency", "highRiskMcp"].includes(key),
    );
  const reviewRequired =
    facts.intent.userRequestedReview || facts.change.publicInterfaceChange || facts.change.complexBusinessLogic ||
    facts.change.crossModule || facts.change.dataStructureChange || facts.change.complexArchitectureChange ||
    securityReasons.length > 0;
  const metaReviewRequired =
    reviewRequired && (securityReasons.length > 0 || facts.change.complexArchitectureChange || facts.change.externalSideEffect);
  const verificationRequired = facts.intent.executable;
  const evolutionRequired = facts.intent.durableLearningRequested;

  const governanceRequirements = Object.freeze({
    clarification: requirement(
      facts.clarity.blockingUnknowns.length > 0,
      facts.clarity.blockingUnknowns.length > 0
        ? "Blocking unknowns can change the user-facing route or acceptance boundary."
        : "Normalized facts contain no blocking unknowns.",
      facts.clarity.blockingUnknowns.length > 0 ? facts.clarity.blockingUnknowns : ["policy:clarity-not-required"],
    ),
    research: requirement(
      facts.evidence.currentExternalFactsRequired || facts.evidence.localEvidenceSufficient === false,
      facts.evidence.currentExternalFactsRequired
        ? "Current external facts are required before the route can be trusted."
        : facts.evidence.localEvidenceSufficient === false
          ? "Local evidence is insufficient, so additional evidence is required."
          : "Local evidence is sufficient and no current external fact is required.",
      facts.evidence.references.length > 0 ? facts.evidence.references : ["policy:research-not-required"],
    ),
    planning: requirement(
      planningRequired,
      planningRequired
        ? "The normalized change facts include a dependency, scope, migration, side-effect, architecture, or capability coordination signal."
        : "No normalized planning trigger is present.",
      changeReasons.length > 0 ? changeReasons : ["policy:planning-not-required"],
    ),
    humanDecision: requirement(
      hasMaterialDecision,
      hasMaterialDecision
        ? "At least two reasonable options materially branch a user-facing outcome."
        : facts.decision.internalImplementationOnly
          ? "Alternatives are internal implementation details and do not require a human decision."
          : "There are not at least two reasonable options with a material user-facing branch.",
      hasMaterialDecision
        ? facts.decision.materialDimensions.map((dimension) => DECISION_EVIDENCE_REFS[dimension])
        : [
            "policy:human-decision-not-required",
          ],
    ),
    permission: requirement(
      permissionRequired,
      permissionRequired
        ? "A side effect or permission-sensitive action requires a separate authorization boundary."
        : "No normalized permission-sensitive action is present.",
      permissionRequired
        ? [
            ...(facts.change.externalSideEffect ? [CHANGE_EVIDENCE_REFS.externalSideEffect] : []),
            ...securityReasons,
          ]
        : ["policy:permission-not-required"],
    ),
    review: requirement(
      reviewRequired,
      reviewRequired
        ? "The change or request needs an outcome-quality review beyond a single deterministic check."
        : "No normalized review trigger is present.",
      reviewRequired
        ? [
            ...(facts.intent.userRequestedReview ? ["intent:user-requested-review"] : []),
            ...changeReasons,
            ...securityReasons,
          ]
        : ["policy:review-not-required"],
    ),
    metaReview: requirement(
      metaReviewRequired,
      metaReviewRequired
        ? "The review standard itself needs scrutiny because the task carries security, architecture, or side-effect risk."
        : "No normalized trigger requires a second-order review of the review standard.",
      metaReviewRequired
        ? [
            ...(facts.change.complexArchitectureChange ? [CHANGE_EVIDENCE_REFS.complexArchitectureChange] : []),
            ...(facts.change.externalSideEffect ? [CHANGE_EVIDENCE_REFS.externalSideEffect] : []),
            ...securityReasons,
          ]
        : ["policy:meta-review-not-required"],
    ),
    securityReview: requirement(
      securityReasons.length > 0,
      securityReasons.length > 0
        ? "Security-sensitive normalized facts require a security review."
        : "No normalized security-sensitive fact is present.",
      securityReasons.length > 0 ? securityReasons : ["policy:security-review-not-required"],
    ),
    verification: requirement(
      verificationRequired,
      verificationRequired
        ? "Executable work requires deterministic verification selected from normalized checks."
        : "No executable work is requested, so deterministic verification is not required by this shadow evaluator.",
      verificationRequired
        ? facts.verification.deterministicChecks.length > 0
          ? facts.verification.deterministicChecks
          : ["policy:verification-check-reference-missing"]
        : ["policy:verification-not-required"],
    ),
    evolution: requirement(
      evolutionRequired,
      evolutionRequired
        ? "The user explicitly requested durable learning or writeback consideration."
        : "Evolution defaults to false without a durable-learning trigger.",
      evolutionRequired ? ["intent:durable-learning-requested"] : ["policy:evolution-default-false"],
    ),
  });

  return Object.freeze({
    schemaVersion: REQUIREMENTS_SCHEMA_VERSION,
    governanceRequirements,
    parityDiagnostics: buildParityDiagnostics(governanceRequirements, legacyGate),
  });
}
