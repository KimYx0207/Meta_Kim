import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GOVERNANCE_REQUIREMENT_KEYS,
  evaluateGovernanceRequirements,
  validateGovernanceTaskFacts,
} from "../../src/domain/governance/governance-requirements.mjs";

const OPAQUE_REF_PATTERN = "^(?:(?:fact|evidence|digest|policy|check|legacy|change|decision|security|intent|verification):[a-z0-9][a-z0-9._/-]{0,95}|sha256:[a-f0-9]{64})$";
const OPAQUE_REF_RE = new RegExp(OPAQUE_REF_PATTERN, "u");

function taskFacts(overrides = {}) {
  const facts = {
    schemaVersion: "governance-task-facts-v1",
    intent: {
      executable: false,
      userRequestedReview: false,
      durableLearningRequested: false,
    },
    clarity: { blockingUnknowns: [] },
    evidence: {
      currentExternalFactsRequired: false,
      localEvidenceSufficient: true,
      references: ["evidence:repo-targeted-source-read"],
    },
    change: {
      multiStep: false,
      crossModule: false,
      dataMigration: false,
      externalSideEffect: false,
      complexArchitectureChange: false,
      multipleCapabilities: false,
      publicInterfaceChange: false,
      complexBusinessLogic: false,
      dataStructureChange: false,
      behaviorPreservingInternalOnly: false,
    },
    decision: {
      reasonableOptionCount: 0,
      materialDimensions: [],
      internalImplementationOnly: false,
    },
    security: {
      auth: false,
      permission: false,
      credential: false,
      secret: false,
      payment: false,
      production: false,
      databaseDestructive: false,
      systemConfiguration: false,
      highPrivilegeDependency: false,
      highRiskMcp: false,
    },
    verification: { deterministicChecks: [] },
  };

  return {
    ...facts,
    ...overrides,
    intent: { ...facts.intent, ...overrides.intent },
    clarity: { ...facts.clarity, ...overrides.clarity },
    evidence: { ...facts.evidence, ...overrides.evidence },
    change: { ...facts.change, ...overrides.change },
    decision: { ...facts.decision, ...overrides.decision },
    security: { ...facts.security, ...overrides.security },
    verification: { ...facts.verification, ...overrides.verification },
  };
}

function required(result, key) {
  return result.governanceRequirements[key].required;
}

function assertRequirementRecords(result) {
  assert.deepEqual(Object.keys(result.governanceRequirements).sort(), [...GOVERNANCE_REQUIREMENT_KEYS].sort());
  for (const key of GOVERNANCE_REQUIREMENT_KEYS) {
    const requirement = result.governanceRequirements[key];
    assert.equal(typeof requirement.required, "boolean", `${key}.required`);
    assert.equal(typeof requirement.reason, "string", `${key}.reason`);
    assert.notEqual(requirement.reason.trim(), "", `${key}.reason must explain the result`);
    assert(Array.isArray(requirement.evidence), `${key}.evidence must be an array`);
    assert(requirement.evidence.length > 0, `${key}.evidence must be non-empty`);
    assert(requirement.evidence.every((item) => typeof item === "string" && item.trim()), `${key}.evidence must contain non-empty strings`);
  }
}

test("clear low-risk internal implementation avoids clarification and human decision but keeps verification", () => {
  const result = evaluateGovernanceRequirements(taskFacts({
    intent: { executable: true },
    change: { behaviorPreservingInternalOnly: true },
    decision: { reasonableOptionCount: 1, internalImplementationOnly: true },
    verification: { deterministicChecks: ["check:targeted-test"] },
  }));

  assertRequirementRecords(result);
  for (const key of ["clarification", "research", "planning", "humanDecision", "permission", "review", "metaReview", "securityReview", "evolution"]) {
    assert.equal(required(result, key), false, `${key} must stay off for the low-risk internal case`);
  }
  assert.equal(required(result, "verification"), true);
  assert.deepEqual(result.parityDiagnostics, {
    mode: "not_compared",
    legacySource: null,
    differences: [],
    notes: ["Shadow engine did not receive a legacy gate snapshot."],
  });
});

test("breaking compatibility versus an adapter requires a human decision with material evidence", () => {
  const result = evaluateGovernanceRequirements(taskFacts({
    intent: { executable: true },
    change: { publicInterfaceChange: true },
    decision: {
      reasonableOptionCount: 2,
      materialDimensions: ["compatibility"],
      internalImplementationOnly: false,
    },
    verification: { deterministicChecks: ["check:compatibility-contract"] },
  }));

  assert.equal(required(result, "humanDecision"), true);
  assert.equal(required(result, "review"), true);
  assert.equal(required(result, "verification"), true);
  assert.deepEqual(result.governanceRequirements.humanDecision.evidence, ["decision:compatibility"]);
});

test("auth, credentials, and production facts require permission, security review, review, meta-review, and verification", () => {
  const result = evaluateGovernanceRequirements(taskFacts({
    intent: { executable: true },
    security: { auth: true, credential: true, production: true },
    verification: { deterministicChecks: ["check:security-regression"] },
  }));

  for (const key of ["permission", "securityReview", "review", "metaReview", "verification"]) {
    assert.equal(required(result, key), true, `${key} must be required for sensitive production facts`);
  }
  assert.equal(required(result, "evolution"), false, "security facts do not make evolution mandatory by themselves");
});

test("current versions, third-party facts, or runtime support require research", () => {
  const result = evaluateGovernanceRequirements(taskFacts({
    evidence: {
      currentExternalFactsRequired: true,
      localEvidenceSufficient: true,
      references: ["evidence:runtime-support-matrix", "evidence:third-party-version-advisory"],
    },
  }));

  assert.equal(required(result, "research"), true);
  assert.deepEqual(result.governanceRequirements.research.evidence, [
    "evidence:runtime-support-matrix",
    "evidence:third-party-version-advisory",
  ]);
});

test("migration and multiple dependencies require planning", () => {
  const result = evaluateGovernanceRequirements(taskFacts({
    change: { dataMigration: true, multipleCapabilities: true },
  }));

  assert.equal(required(result, "planning"), true);
  assert.deepEqual(result.governanceRequirements.planning.evidence, [
    "change:data-migration",
    "change:multiple-capabilities",
  ]);
});

test("review, meta-review, and evolution remain dynamic rather than score or preset driven", () => {
  const baseline = evaluateGovernanceRequirements(taskFacts());
  const requestedReview = evaluateGovernanceRequirements(taskFacts({
    intent: { userRequestedReview: true, durableLearningRequested: true },
  }));

  assert.equal(required(baseline, "review"), false);
  assert.equal(required(baseline, "metaReview"), false);
  assert.equal(required(baseline, "evolution"), false);
  assert.equal(required(requestedReview, "review"), true);
  assert.equal(required(requestedReview, "metaReview"), false);
  assert.equal(required(requestedReview, "evolution"), true);
  assert.equal("score" in requestedReview, false);
  assert.equal("tier" in requestedReview, false);
  assert.equal("preset" in requestedReview, false);
  assert.doesNotMatch(JSON.stringify(requestedReview), /(?:governance)?score|tier|preset/iu);
});

test("malformed or contradictory facts fail closed", () => {
  assert.throws(
    () => validateGovernanceTaskFacts({ schemaVersion: "governance-task-facts-v1" }),
    /taskFacts must contain exactly/u,
  );
  assert.throws(
    () => evaluateGovernanceRequirements(taskFacts({
      decision: { internalImplementationOnly: true, materialDimensions: ["scope"] },
    })),
    /Internal-only implementation alternatives/u,
  );
});

test("caller evidence accepts only lowercase opaque references, never raw text or secrets", () => {
  for (const reference of [
    "the customer asked for production deployment",
    "sk-live-abc123supersecret",
    "password=hunter2",
    "node --test tests/governance/governance-requirements.test.mjs",
  ]) {
    assert.throws(
      () => evaluateGovernanceRequirements(taskFacts({ evidence: { references: [reference] } })),
      /opaque reference|reference/u,
      `must reject non-opaque evidence ${reference}`,
    );
  }
});

test("trusted-looking reference prefixes cannot carry credentials while sha256 digests remain valid evidence", () => {
  for (const reference of [
    "evidence:sk-live-abc123supersecret",
    "policy:bearer-session-value",
    "source:api-key=abc123",
    "source:password=hunter2",
    "evidence:token=abc123",
    "Evidence:sk-live-abc123supersecret",
    "policy:Bearer-session-value",
    "evidence:sk-lіve-abc123supersecret",
    "policy:ｂearer-session-value",
  ]) {
    assert.throws(
      () => evaluateGovernanceRequirements(taskFacts({ evidence: { references: [reference] } })),
      /opaque reference|prompt or secret content|reference/u,
      `must reject credential-like content hidden behind ${reference}`,
    );
  }

  const digest = `sha256:${"a".repeat(64)}`;
  const result = evaluateGovernanceRequirements(taskFacts({
    evidence: { currentExternalFactsRequired: true, references: [digest] },
  }));
  assert.deepEqual(result.governanceRequirements.research.evidence, [digest]);
  assert.doesNotThrow(() => validateGovernanceTaskFacts(taskFacts({
    evidence: { references: [digest] },
  })));
});

test("opaque references reject Unicode and case variants", () => {
  for (const reference of [
    "Evidence:repo-targeted-source-read",
    "evidence:Repo-targeted-source-read",
    "evidence:运行时支持",
    "evidence:repo targeted-source-read",
    "evidence:repo:targeted-source-read",
  ]) {
    assert.equal(OPAQUE_REF_RE.test(reference), false, `${reference} is not a canonical opaque reference`);
    assert.throws(
      () => evaluateGovernanceRequirements(taskFacts({ evidence: { references: [reference] } })),
      /opaque reference|reference/u,
    );
  }
});

test("prototype-bearing facts and inherited fields fail closed", () => {
  const outerPrototype = taskFacts();
  const prototypeBackedFacts = Object.assign(Object.create({ inherited: true }), taskFacts());
  const inheritedOnlyFacts = Object.create(outerPrototype);
  const nestedPrototypeFacts = taskFacts();
  nestedPrototypeFacts.security = Object.assign(Object.create({ inheritedSecurity: true }), nestedPrototypeFacts.security);

  for (const facts of [prototypeBackedFacts, inheritedOnlyFacts, nestedPrototypeFacts]) {
    assert.throws(
      () => validateGovernanceTaskFacts(facts),
      /plain object|exactly/u,
    );
  }
});

test("safe placeholders are references, not verification claims", () => {
  const result = evaluateGovernanceRequirements(taskFacts({
    intent: { executable: true },
    verification: { deterministicChecks: [] },
  }));

  assert.equal(required(result, "verification"), true);
  assert.deepEqual(result.governanceRequirements.verification.evidence, ["policy:verification-check-reference-missing"]);
  assert(result.governanceRequirements.verification.evidence.every((reference) => OPAQUE_REF_RE.test(reference)));
  assert.doesNotMatch(JSON.stringify(result.governanceRequirements.verification), /pass(?:ed)?|succeed(?:ed)?|verified/iu);
});

test("schema and implementation expose the same strict requirement contract", () => {
  const schema = JSON.parse(readFileSync(new URL("../../src/data/schemas/governance-requirements.schema.json", import.meta.url), "utf8"));
  const requiredBySchema = schema.$defs.evaluation.properties.governanceRequirements.required;

  assert.equal(schema.$defs.opaqueEvidenceReference.pattern, OPAQUE_REF_PATTERN);
  assert.deepEqual([...requiredBySchema].sort(), [...GOVERNANCE_REQUIREMENT_KEYS].sort());
  assert.equal(schema.$defs.requirement.required.includes("required"), true);
  assert.equal(schema.$defs.requirement.required.includes("reason"), true);
  assert.equal(schema.$defs.requirement.required.includes("evidence"), true);
  assert.equal(schema.$defs.requirement.additionalProperties, false);
});

test("legacy parity is shadow-only and cannot authorize or replace a legacy gate", () => {
  const result = evaluateGovernanceRequirements(taskFacts({
    intent: { executable: true },
    decision: {
      reasonableOptionCount: 2,
      materialDimensions: ["compatibility"],
      internalImplementationOnly: false,
    },
  }), {
    legacyGate: {
      source: "legacy:gate-fixture",
      requirements: Object.fromEntries(GOVERNANCE_REQUIREMENT_KEYS.map((key) => [key, false])),
    },
  });

  assert.equal(result.parityDiagnostics.mode, "compared");
  assert.equal(result.parityDiagnostics.legacySource, "legacy:gate-fixture");
  assert(result.parityDiagnostics.differences.some((difference) => difference.key === "humanDecision"));
  assert.deepEqual(result.parityDiagnostics.notes, [
    "Differences are diagnostic only; this shadow engine does not replace the legacy gate.",
  ]);
  assert.deepEqual(Object.keys(result).sort(), ["governanceRequirements", "parityDiagnostics", "schemaVersion"]);
  assert.equal("authorized" in result, false);
  assert.equal("authorization" in result, false);
  assert.equal("legacyGate" in result, false);
});

test("legacy gate source is a strict opaque reference and diagnostics never authorize", () => {
  const legacyRequirements = Object.fromEntries(GOVERNANCE_REQUIREMENT_KEYS.map((key) => [key, false]));
  for (const source of ["legacy gate fixture", "Legacy:gate-fixture", "legacy:密钥", "legacy:gate:fixture"]) {
    assert.throws(
      () => evaluateGovernanceRequirements(taskFacts(), { legacyGate: { source, requirements: legacyRequirements } }),
      /opaque reference|legacyGate\.source|reference/u,
    );
  }

  const result = evaluateGovernanceRequirements(taskFacts({
    decision: { reasonableOptionCount: 2, materialDimensions: ["scope"] },
  }), {
    legacyGate: { source: "legacy:gate-fixture", requirements: legacyRequirements },
  });
  assert.equal(result.parityDiagnostics.mode, "compared");
  assert(result.parityDiagnostics.differences.length > 0);
  assert.doesNotMatch(JSON.stringify(result.parityDiagnostics), /authori[sz]e|allow|permit/iu);
});
