import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  assertValidDecision,
  buildHostAnswerClaim,
  claimHostAnswer,
  createDecision,
  decisionExecutionGate,
  invalidateDecision,
  presentDecision,
} from "../../src/domain/decision/decision.mjs";
import {
  buildCardPlanPacketDecisionProjection,
  buildPreDecisionOptionFrameProjection,
  buildRouteGateDecisionProjection,
} from "../../src/domain/decision/legacy-decision-projection.mjs";
import {
  GOVERNANCE_REQUIREMENT_KEYS,
  evaluateGovernanceRequirements,
  validateGovernanceTaskFacts,
} from "../../src/domain/governance/governance-requirements.mjs";

const domainRoot = path.resolve("src/domain");
const decisionSchemaPath = path.resolve("src/data/schemas/decision.schema.json");
const governanceSchemaPath = path.resolve(
  "src/data/schemas/governance-requirements.schema.json",
);
const GOVERNANCE_KEYS = [
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
];
const FORBIDDEN_DOMAIN_IMPORT = /\bfrom\s*["'](?:node:(?:fs(?:\/promises)?|process|child_process|net|http|https|dns|tls|dgram)|(?:\.\.\/)+(?:setup\.mjs|bin\/|runtimes\/|scripts\/))/u;
const FORBIDDEN_RUNTIME_SURFACE = /(?:\.(?:codex|claude|cursor)(?:[\\/]|$)|openclaw[\\/]|(?:tools\.)?request_user_input\s*\(|AskUserQuestion\s*\()/u;
const SENSITIVE_KEY = /(?:^|[_-])(?:raw_?prompt|prompt|secret|token|api_?key|password|credential)(?:$|[_-])/iu;

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(target);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [target] : [];
  });
}

function collectValuesForKey(value, key, values = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectValuesForKey(item, key, values);
  } else if (value && typeof value === "object") {
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (entryKey === key) values.push(entryValue);
      collectValuesForKey(entryValue, key, values);
    }
  }
  return values;
}

function assertNoSensitiveOutputKeys(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveOutputKeys(item, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.doesNotMatch(key, SENSITIVE_KEY, `${label}.${key} must not retain raw prompt or secret material`);
    assertNoSensitiveOutputKeys(child, `${label}.${key}`);
  }
}

function assertNoGovernancePackagesOrSensitiveSerialization(value, label) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /raw[\s_-]*prompt|api[\s_-]*key|password|credential|token|preset|(?:^|["_:-])score(?:$|["_:-])/iu, `${label} must not retain raw prompt, secret, preset, or score material`);
}

function decisionFixture(overrides = {}) {
  return createDecision({
    identity: { runId: "run:m3-boundary", taskFingerprint: "digest:m3-boundary" },
    routeChangingDimensions: ["scope"],
    options: [
      {
        optionId: "option:minimal",
        displayRef: "display:minimal-route",
        tradeoffRefs: ["tradeoff:lower-change-cost"],
        evidenceRefs: ["evidence:repo"],
      },
      {
        optionId: "option:expanded",
        displayRef: "display:expanded-route",
        tradeoffRefs: ["tradeoff:higher-validation-cost"],
        evidenceRefs: ["evidence:repo"],
      },
    ],
    recommendation: {
      optionId: "option:minimal",
      rationaleRef: "reason:smaller-compatible-route",
      evidenceRefs: ["evidence:repo"],
    },
    evidence: [{ evidenceRef: "evidence:repo", digest: `digest:${"a".repeat(64)}` }],
    requirement: {
      required: true,
      reasonRef: "reason:delivered-scope-changes",
      evidenceRefs: ["evidence:repo"],
    },
    createdAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  });
}

function governanceFacts() {
  return {
    schemaVersion: "governance-task-facts-v1",
    intent: { executable: true, userRequestedReview: false, durableLearningRequested: false },
    clarity: { blockingUnknowns: [] },
    evidence: { currentExternalFactsRequired: false, localEvidenceSufficient: true, references: ["evidence:repo"] },
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
      behaviorPreservingInternalOnly: true,
    },
    decision: { reasonableOptionCount: 1, materialDimensions: [], internalImplementationOnly: true },
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
    verification: { deterministicChecks: ["check:node-test"] },
  };
}

test("M3 Domain remains pure and has no runtime or I/O imports", () => {
  const files = filesUnder(domainRoot);
  assert.ok(files.length >= 3, "M3 must retain Decision, legacy projection, and Governance domain modules");

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, FORBIDDEN_DOMAIN_IMPORT, `${file} must not import setup, bin, runtime adapters, or Node I/O`);
    assert.doesNotMatch(source, FORBIDDEN_RUNTIME_SURFACE, `${file} must not embed runtime paths or native tool invocations`);
  }
});

test("M3 Decision and Governance schemas are versioned and strict", () => {
  const decisionSchema = JSON.parse(readFileSync(decisionSchemaPath, "utf8"));
  const governanceSchema = JSON.parse(readFileSync(governanceSchemaPath, "utf8"));

  assert.equal(decisionSchema.additionalProperties, false);
  assert.equal(decisionSchema.properties?.schemaVersion?.const, "decision-domain-v1");
  assert.equal(decisionSchema.properties?.decisionId?.type, "string");

  const taskFacts = governanceSchema.$defs?.taskFacts;
  const evaluation = governanceSchema.$defs?.evaluation;
  assert.equal(taskFacts?.additionalProperties, false);
  assert.equal(evaluation?.additionalProperties, false);
  assert.equal(taskFacts?.properties?.schemaVersion?.const, "governance-task-facts-v1");
  assert.equal(evaluation?.properties?.schemaVersion?.const, "governance-requirements-v1");
  assert.equal(evaluation?.properties?.governanceRequirements?.additionalProperties, false);

  const decision = decisionFixture();
  const governance = evaluateGovernanceRequirements(governanceFacts());
  assert.deepEqual(Object.keys(decision).sort(), [...decisionSchema.required].sort(), "Decision runtime output must match its closed schema root");
  assert.deepEqual(Object.keys(governance).sort(), [...evaluation.required].sort(), "Governance runtime output must match its closed schema root");
});

test("M3 Decision output is closed and does not retain raw prompt or secret fields", () => {
  assert.throws(
    () => decisionFixture({ rawPrompt: "do not retain this text" }),
    /rawPrompt|not supported/u,
    "Decision input must reject a raw prompt instead of silently discarding it",
  );
  const decision = decisionFixture();
  assertValidDecision(decision);
  assertNoSensitiveOutputKeys(decision, "decision");
  assertNoGovernancePackagesOrSensitiveSerialization(decision, "decision");
  assert.equal(decision.schemaVersion, "decision-domain-v1");
  const decisionSchema = JSON.parse(readFileSync(decisionSchemaPath, "utf8"));
  assert.match(decision.decisionId, new RegExp(decisionSchema.properties.decisionId.pattern, "u"));
});

test("M3 Governance accepts only Object.prototype/null records, exact keys, and opaque references", () => {
  const normal = governanceFacts();
  const nullPrototype = Object.assign(Object.create(null), normal);
  assert.equal(validateGovernanceTaskFacts(nullPrototype).schemaVersion, "governance-task-facts-v1");

  const customPrototype = Object.create({ inherited: true });
  Object.assign(customPrototype, governanceFacts());
  assert.throws(() => validateGovernanceTaskFacts(customPrototype), /plain object/u);

  const unknownNested = governanceFacts();
  unknownNested.evidence.unexpected = true;
  assert.throws(() => validateGovernanceTaskFacts(unknownNested), /exactly/u);

  for (const unsafeReference of [
    "evidence:raw＿prompt",
    "evidence:api＿key",
    "evidence:tokеn",
    "full prompt text must never become evidence",
  ]) {
    const unsafe = governanceFacts();
    unsafe.evidence.references = [unsafeReference];
    assert.throws(() => evaluateGovernanceRequirements(unsafe), /opaque|secret|prompt/u, unsafeReference);
  }
});

test("M3 Governance keeps current external research independent from local sufficiency", () => {
  const facts = governanceFacts();
  facts.evidence = {
    currentExternalFactsRequired: true,
    localEvidenceSufficient: true,
    references: ["evidence:official-runtime"],
  };
  const output = evaluateGovernanceRequirements(facts);
  assert.equal(output.governanceRequirements.research.required, true);
  assert.deepEqual(output.governanceRequirements.research.evidence, ["evidence:official-runtime"]);
});

test("M3 receipt origins are closed and invalidated projections are display-only", () => {
  const pending = decisionFixture();
  const presented = presentDecision(pending, { at: "2026-08-09T00:01:00.000Z" });
  const claimInput = {
    source: "codex_request_user_input",
    requestRef: "request:m3-boundary",
    claimRef: "claim:m3-boundary",
    issuedAt: "2026-08-09T00:01:00.000Z",
    expiresAt: "2026-08-09T00:04:00.000Z",
    claimedAt: "2026-08-09T00:02:00.000Z",
    selectedOptionId: "option:minimal",
    answerDigest: `digest:${"b".repeat(64)}`,
  };
  assert.throws(
    () => buildHostAnswerClaim(presented, { ...claimInput, source: "arbitrary_adapter_label" }),
    /registered|adapter source|host answer claim/u,
    "an arbitrary source label must not mint a host answer claim",
  );
  const claim = buildHostAnswerClaim(presented, claimInput);
  const claimed = claimHostAnswer(presented, { at: claim.claimedAt, claim });
  assert.equal(claimed.status, "host_answer_claimed");
  const claimGate = decisionExecutionGate(claimed);
  assert.equal(claimGate.executionAllowed, false, "a host answer claim must not authorize execution");
  assert.equal(claimGate.blockedReason, "host_answer_claimed_not_verified");

  const invalidated = invalidateDecision(claimed, {
    at: "2026-08-09T00:03:00.000Z",
    reasonRef: "reason:option-evidence-changed",
    options: claimed.options.map((option) => option.optionId === "option:expanded"
      ? { ...option, displayRef: "display:revised-compatible-route" }
      : option),
  });

  const card = buildCardPlanPacketDecisionProjection(invalidated);
  const frame = buildPreDecisionOptionFrameProjection(invalidated);
  const route = buildRouteGateDecisionProjection(invalidated);
  for (const projection of [card, frame, route]) {
    const boundary = projection.decisionDomain ?? projection;
    assert.equal(boundary.decisionStatus, "invalidated");
    assert.equal(boundary.projectionOnly, true);
    assert.equal(boundary.cannotAnswerDecision, true);
  }
  assert.equal(route.executionAllowed, false);
  assert.equal(route.blockedReason, "decision_invalidated_by_material_change");
  assert.equal(frame.userChoiceState, "pending_user_choice");
  assert.equal(frame.unresolvedQuestions[0].status, "invalidated");
  assert.equal(frame.unresolvedQuestions[0].userAnswer, null);
  assert.deepEqual(frame.unresolvedQuestions[0].answerEvidenceRefs, []);
});

test("M3 legacy projections retain one Decision identity and remain non-authoritative", () => {
  const decision = decisionFixture();
  const projections = [
    buildCardPlanPacketDecisionProjection(decision),
    buildPreDecisionOptionFrameProjection(decision),
    buildRouteGateDecisionProjection(decision),
  ];

  for (const projection of projections) {
    const decisionIds = collectValuesForKey(projection, "decisionId");
    assert.ok(decisionIds.length >= 1, "legacy projection must carry a decisionId");
    assert.deepEqual([...new Set(decisionIds)], [decision.decisionId], "legacy projection must not mint or mix Decision identities");

    const projectionOnly = collectValuesForKey(projection, "projectionOnly");
    const cannotAnswer = collectValuesForKey(projection, "cannotAnswerDecision");
    assert.ok(projectionOnly.includes(true), "legacy projection must declare projectionOnly=true");
    assert.ok(cannotAnswer.includes(true), "legacy projection must declare cannotAnswerDecision=true");
  }
});

test("M3 Governance output has exactly ten explainable requirements and no package score", () => {
  const facts = governanceFacts();
  facts.rawPrompt = "not an allowed normalized fact";
  assert.throws(
    () => evaluateGovernanceRequirements(facts),
    TypeError,
    "normalized task facts must reject rawPrompt rather than retain it",
  );
  delete facts.rawPrompt;

  const output = evaluateGovernanceRequirements(facts);
  assert.equal(output.schemaVersion, "governance-requirements-v1");
  assert.deepEqual(GOVERNANCE_REQUIREMENT_KEYS, GOVERNANCE_KEYS);
  assert.deepEqual(Object.keys(output.governanceRequirements), GOVERNANCE_KEYS);
  assertNoSensitiveOutputKeys(output.governanceRequirements, "governanceRequirements");
  assertNoGovernancePackagesOrSensitiveSerialization(output, "governanceRequirements");

  for (const [key, requirement] of Object.entries(output.governanceRequirements)) {
    assert.deepEqual(Object.keys(requirement), ["required", "reason", "evidence"], `${key} must remain explainable without a score tier`);
    assert.equal(typeof requirement.required, "boolean");
    assert.equal(typeof requirement.reason, "string");
    assert.ok(requirement.reason.length > 0);
    assert.ok(Array.isArray(requirement.evidence));
  }

  for (const key of Object.keys(output.governanceRequirements)) {
    assert.doesNotMatch(key, /(?:lite|standard|strict|score)/iu, "Governance Requirements must not become a fixed package or score");
  }
});
