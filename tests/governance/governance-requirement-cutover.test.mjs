import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  GOVERNANCE_REQUIREMENT_CUTOVER_KEYS,
  GOVERNANCE_REQUIREMENT_CUTOVER_MODES,
  assertGovernanceRequirementCutoverConfiguration,
  buildGovernanceRequirementPlan,
} from "../../src/domain/governance/governance-requirement-cutover.mjs";

const GATES = [
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

const SHADOW_ONLY_GATES = new Set(["clarification", "humanDecision", "permission"]);

function slug(gate) {
  return gate.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function evaluationFixture(overrides = {}, legacyRequiredByGate = {}) {
  const governanceRequirements = Object.fromEntries(
    GATES.map((gate) => [gate, {
      required: ["planning", "verification"].includes(gate),
      reason: `normalized ${gate} requirement`,
      evidence: [`policy:${slug(gate)}-requirement`],
    }]),
  );
  const resolvedRequirements = {
    ...governanceRequirements,
    ...overrides,
  };
  const differences = GATES
    .filter((gate) => resolvedRequirements[gate].required !== (legacyRequiredByGate[gate] ?? false))
    .map((gate) => ({
      key: gate,
      shadowRequired: resolvedRequirements[gate].required,
      legacyRequired: legacyRequiredByGate[gate] ?? false,
    }));
  return {
    schemaVersion: "governance-requirements-v1",
    governanceRequirements: resolvedRequirements,
    parityDiagnostics: {
      mode: "compared",
      legacySource: "legacy:gate-fixture",
      differences,
      notes: [differences.length === 0
        ? "Shadow requirements match the supplied legacy gate snapshot."
        : "Differences are diagnostic only; this shadow engine does not replace the legacy gate."],
    },
  };
}

function legacySnapshot(requiredByGate = {}) {
  return {
    schemaVersion: "governance-requirement-legacy-snapshot-v1",
    sourceRef: "legacy:gate-fixture",
    gates: Object.fromEntries(
      GATES.map((gate) => [gate, {
        required: requiredByGate[gate] ?? false,
        reason: `legacy ${gate} requirement`,
        evidence: ["legacy:gate-fixture"],
      }]),
    ),
  };
}

function domainGatePolicies() {
  return Object.fromEntries(
    GATES.map((gate) => [gate, {
      mode: "domain_authoritative",
      parityEvidenceRefs: [`evidence:parity-${slug(gate)}`],
      cutoverDecisionRef: `decision:cutover-${slug(gate)}`,
      rollbackRef: `rollback:${slug(gate)}`,
    }]),
  );
}

function rolloutConfig({ defaultMode = "legacy_authoritative", modes = {}, productDecisionRef = "decision:m3-p3-explicit-start-2026-08-25" } = {}) {
  const gates = Object.fromEntries(
    GATES.map((gate) => [gate, {
      mode: modes[gate] ?? defaultMode,
      parityEvidenceRefs: [`check:m3-p3-${slug(gate)}-parity`],
      cutoverDecisionRef: `decision:m3-p3-${slug(gate)}-cutover`,
      rollbackRef: `policy:m3-p3-${slug(gate)}-rollback`,
    }]),
  );
  return {
    schemaVersion: "governance-requirement-rollout-v1",
    workItem: "M3-P3",
    productDecisionRef,
    defaultMode,
    gates,
  };
}

function domainPolicy(overrides = {}) {
  return {
    ...rolloutConfig({
      modes: Object.fromEntries(GATES.map((gate) => [
        gate,
        SHADOW_ONLY_GATES.has(gate) ? "shadow_compare" : "domain_authoritative",
      ])),
    }),
    ...overrides,
  };
}

function input({ evaluation = null, legacy = legacySnapshot(), rolloutPolicy = rolloutConfig() } = {}) {
  const legacyRequiredByGate = legacy?.gates
    ? Object.fromEntries(GATES.map((gate) => [gate, legacy.gates[gate]?.required ?? false]))
    : {};
  return {
    evaluation: evaluation ?? evaluationFixture({}, legacyRequiredByGate),
    legacySnapshot: legacy,
    rolloutPolicy,
  };
}

test("builds all ten gates in legacy mode and never exposes authority", () => {
  const plan = buildGovernanceRequirementPlan(input());

  assert.deepEqual(GOVERNANCE_REQUIREMENT_CUTOVER_KEYS, GATES);
  assert.deepEqual(GOVERNANCE_REQUIREMENT_CUTOVER_MODES, [
    "legacy_authoritative",
    "shadow_compare",
    "domain_authoritative",
  ]);
  assert.equal(plan.schemaVersion, "governance-requirement-cutover-v1");
  assert.equal(plan.mode, "gradual_cutover");
  assert.deepEqual(Object.keys(plan.gates), GATES);
  assert.deepEqual(plan.authority, {
    execution: false,
    action: false,
    permission: false,
    host: false,
    durableMutation: false,
  });
  assert.equal(plan.gates.verification.domainRequired, true);
  assert.equal(plan.gates.verification.legacyRequired, false);
  assert.equal(plan.gates.verification.effectiveRequired, false);
  assert.equal(plan.gates.verification.effectiveSource, "legacy");
  assert.equal(plan.gates.verification.parityStatus, "divergent");
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.gates.verification), true);
  assert.equal(Object.isFrozen(plan.gates.verification.evidence), true);
  assert.throws(() => {
    plan.gates.verification.effectiveRequired = true;
  }, TypeError);
});

test("shadow differences stay diagnostic and cannot switch the effective requirement", () => {
  const plan = buildGovernanceRequirementPlan(input({
    rolloutPolicy: rolloutConfig({
      modes: Object.fromEntries(GATES.map((gate) => [gate, "shadow_compare"])),
    }),
  }));

  assert.equal(plan.mode, "gradual_cutover");
  assert.equal(plan.gates.verification.parityStatus, "divergent");
  assert.equal(plan.gates.verification.effectiveSource, "legacy");
  assert.equal(plan.gates.verification.effectiveRequired, false);
  assert.match(plan.gates.verification.reason, /legacy authority|shadow difference/i);
  assert.equal(plan.authority.execution, false);
  assert.equal(plan.authority.durableMutation, false);
});

test("gradual cutover evaluates each Gate from the rollout configuration independently", () => {
  const plan = buildGovernanceRequirementPlan(input({
    rolloutPolicy: rolloutConfig({
      modes: {
        clarification: "shadow_compare",
        research: "domain_authoritative",
        verification: "domain_authoritative",
      },
    }),
  }));

  assert.equal(plan.mode, "gradual_cutover");
  assert.equal(plan.gates.clarification.effectiveSource, "legacy");
  assert.equal(plan.gates.research.effectiveSource, "domain");
  assert.equal(plan.gates.research.parityStatus, "matched");
  assert.equal(plan.gates.verification.parityStatus, "approved_divergence");
  assert.equal(plan.gates.planning.effectiveSource, "legacy");
  assert.equal(plan.authority.execution, false);
});

test("accepts the checked-in M3-P3 rollout configuration shape", () => {
  const contract = JSON.parse(readFileSync(
    path.resolve("config/contracts/governance-requirement-cutover-contract.json"),
    "utf8",
  ));
  const rollout = JSON.parse(readFileSync(
    path.resolve("config/governance/governance-requirement-rollout.json"),
    "utf8",
  ));
  assert.equal(assertGovernanceRequirementCutoverConfiguration({ contract, rolloutPolicy: rollout }), true);
  const plan = buildGovernanceRequirementPlan(input({ rolloutPolicy: rollout }));

  assert.equal(plan.mode, "gradual_cutover");
  assert.equal(plan.productDecisionRef, rollout.productDecisionRef);
  assert.equal(plan.gates.clarification.effectiveSource, "legacy");
  assert.equal(plan.gates.research.effectiveSource, "domain");
  assert.equal(plan.gates.planning.parityStatus, "approved_divergence");
  assert.equal(plan.gates.humanDecision.effectiveSource, "legacy");
  assert.equal(plan.authority.host, false);
});

test("mechanically rejects incomplete mappings, drifted order, weakened gates, and authorizing contracts", () => {
  const contract = JSON.parse(readFileSync(
    path.resolve("config/contracts/governance-requirement-cutover-contract.json"),
    "utf8",
  ));
  const rolloutPolicy = JSON.parse(readFileSync(
    path.resolve("config/governance/governance-requirement-rollout.json"),
    "utf8",
  ));
  const cases = [
    (candidate) => { delete candidate.legacyMappings.research; },
    (candidate) => { [candidate.rolloutSequence[5], candidate.rolloutSequence[7]] = [candidate.rolloutSequence[7], candidate.rolloutSequence[5]]; },
    (candidate) => { candidate.cutoverGate.allRequired.pop(); },
    (candidate) => { candidate.authorityBoundary.permissionReceiptMintingAllowed = true; },
    (candidate) => { candidate.rollback.independentPerGate = false; },
  ];
  for (const mutate of cases) {
    const candidate = structuredClone(contract);
    mutate(candidate);
    assert.throws(
      () => assertGovernanceRequirementCutoverConfiguration({ contract: candidate, rolloutPolicy }),
      /cutoverContract|authority|rollback/u,
    );
  }

  const driftedRollout = structuredClone(rolloutPolicy);
  driftedRollout.gates.research.mode = "unknown_mode";
  assert.throws(
    () => assertGovernanceRequirementCutoverConfiguration({ contract, rolloutPolicy: driftedRollout }),
    /rolloutPolicy/u,
  );
});

test("domain authority requires explicit product and per-gate evidence, then switches only the plan", () => {
  const plan = buildGovernanceRequirementPlan(input({
    legacy: legacySnapshot({ planning: true, verification: true }),
    rolloutPolicy: domainPolicy(),
  }));

  assert.equal(plan.mode, "gradual_cutover");
  for (const gate of GATES) {
    const entry = plan.gates[gate];
    if (SHADOW_ONLY_GATES.has(gate)) {
      assert.equal(entry.parityStatus, "matched");
      assert.equal(entry.effectiveSource, "legacy");
      assert.equal(entry.effectiveRequired, entry.legacyRequired);
    } else {
      assert.equal(entry.parityStatus, "matched");
      assert.equal(entry.effectiveSource, "domain");
      assert.equal(entry.effectiveRequired, entry.domainRequired);
      assert.match(entry.reason, /domain/i);
    }
    assert.ok(entry.evidence.includes(`check:m3-p3-${slug(gate)}-parity`));
  }
  assert.equal(plan.authority.execution, false);
  assert.equal(plan.authority.action, false);
  assert.equal(plan.authority.permission, false);
  assert.equal(plan.authority.host, false);
  assert.equal(plan.authority.durableMutation, false);
});

test("domain mode records approved divergence without granting execution or mutation", () => {
  const plan = buildGovernanceRequirementPlan(input({
    rolloutPolicy: domainPolicy(),
  }));

  assert.equal(plan.gates.verification.domainRequired, true);
  assert.equal(plan.gates.verification.legacyRequired, false);
  assert.equal(plan.gates.verification.parityStatus, "approved_divergence");
  assert.equal(plan.gates.verification.effectiveSource, "domain");
  assert.equal(plan.gates.verification.effectiveRequired, true);
  assert.equal(plan.authority.execution, false);
  assert.equal(plan.authority.action, false);
  assert.equal(plan.authority.permission, false);
  assert.equal(plan.authority.host, false);
  assert.equal(plan.authority.durableMutation, false);
});

test("missing legacy evidence fails closed instead of manufacturing parity", () => {
  assert.throws(() => buildGovernanceRequirementPlan(input({
    legacy: null,
    rolloutPolicy: domainPolicy(),
  })), /legacySnapshot|required|missing/i);
});

test("rejects unknown modes, missing cutover evidence, unsafe refs, accessors, prototypes, and extra keys", () => {
  const invalidMode = rolloutConfig({ modes: { verification: "automatic" } });
  const invalidModePlan = buildGovernanceRequirementPlan(input({ rolloutPolicy: invalidMode }));
  assert.equal(invalidModePlan.gates.verification.effectiveSource, "legacy");
  assert.equal(invalidModePlan.gates.verification.effectiveRequired, false);
  const invalidDefault = rolloutConfig({
    defaultMode: "automatic",
    modes: { verification: "domain_authoritative" },
  });
  const invalidDefaultPlan = buildGovernanceRequirementPlan(input({ rolloutPolicy: invalidDefault }));
  assert.equal(invalidDefaultPlan.gates.verification.effectiveSource, "legacy");
  assert.equal(invalidDefaultPlan.gates.verification.effectiveRequired, false);
  const incompleteEvidence = rolloutConfig({
    modes: { verification: "domain_authoritative" },
  });
  incompleteEvidence.gates.verification.parityEvidenceRefs = [];
  incompleteEvidence.gates.verification.cutoverDecisionRef = null;
  incompleteEvidence.gates.verification.rollbackRef = null;
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ rolloutPolicy: incompleteEvidence })),
    /bound|exact|evidence|reference/i,
  );
  const unsafeEvaluation = evaluationFixture();
  unsafeEvaluation.governanceRequirements.verification.evidence = ["evidence:raw-prompt"];
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ evaluation: unsafeEvaluation })),
    /opaque|secret|prompt/i,
  );
  const extraEvaluation = evaluationFixture();
  extraEvaluation.unexpected = true;
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ evaluation: extraEvaluation })),
    /exactly|unexpected/i,
  );
  const inherited = Object.assign(Object.create({ inherited: true }), input());
  assert.throws(() => buildGovernanceRequirementPlan(inherited), /plain object/i);
  const accessorInput = input();
  Object.defineProperty(accessorInput, "legacySnapshot", {
    enumerable: true,
    get() {
      return legacySnapshot();
    },
  });
  assert.throws(() => buildGovernanceRequirementPlan(accessorInput), /accessor|data property/i);
  const extraPolicy = rolloutConfig();
  extraPolicy.unexpected = true;
  assert.throws(() => buildGovernanceRequirementPlan(input({ rolloutPolicy: extraPolicy })), /unsupported|exactly/i);
  const missingGate = legacySnapshot();
  delete missingGate.gates.verification;
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ legacy: missingGate })),
    /exactly|verification/i,
  );
});

test("rejects array accessors, extra properties, and map overrides before reading untrusted values", () => {
  const accessorNotes = evaluationFixture();
  Object.defineProperty(accessorNotes.parityDiagnostics.notes, "0", {
    enumerable: true,
    get() {
      return "fixture";
    },
  });
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ evaluation: accessorNotes })),
    /data property|accessor|dense/i,
  );

  const customMap = evaluationFixture();
  Object.defineProperty(customMap.parityDiagnostics.differences, "map", {
    enumerable: false,
    value: () => [],
  });
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ evaluation: customMap })),
    /dense|unsupported|exactly/i,
  );

  const extraNotes = evaluationFixture();
  extraNotes.parityDiagnostics.notes.extra = "must not be read";
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ evaluation: extraNotes })),
    /dense|unsupported|exactly/i,
  );
});

test("requires parity diagnostics to match the supplied legacy source and Gate differences exactly", () => {
  const sourceMismatch = evaluationFixture();
  sourceMismatch.parityDiagnostics.legacySource = "legacy:other-source";
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ evaluation: sourceMismatch })),
    /legacySource|parity|match/i,
  );

  const differencesMismatch = evaluationFixture();
  differencesMismatch.parityDiagnostics.differences = [];
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ evaluation: differencesMismatch })),
    /difference|parity|match/i,
  );
});

test("requires domain evidence references to bind to the current M3-P3 Gate", () => {
  const forgedParity = domainPolicy();
  forgedParity.gates.verification.parityEvidenceRefs = ["check:m3-p3-forged-parity"];
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ rolloutPolicy: forgedParity })),
    /bound|exact|parity|reference/i,
  );

  const forgedCutover = domainPolicy();
  forgedCutover.gates.verification.cutoverDecisionRef = "decision:m3-p3-forged-cutover";
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ rolloutPolicy: forgedCutover })),
    /bound|exact|cutover|reference/i,
  );

  const forgedRollback = domainPolicy();
  forgedRollback.gates.verification.rollbackRef = "policy:m3-p3-forged-rollback";
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ rolloutPolicy: forgedRollback })),
    /bound|exact|rollback|reference/i,
  );

  const forgedProductDecision = domainPolicy({ productDecisionRef: "decision:other-work-item" });
  assert.throws(
    () => buildGovernanceRequirementPlan(input({ rolloutPolicy: forgedProductDecision })),
    /bound|product|decision/i,
  );
});

test("the plan schema is closed around the ten gates and non-authorizing authority", () => {
  const schema = JSON.parse(readFileSync(
    path.resolve("src/data/schemas/governance-requirement-plan.schema.json"),
    "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties?.mode?.const, "gradual_cutover");
  assert.deepEqual(schema.$defs?.gate?.required, [
    "domainRequired",
    "legacyRequired",
    "effectiveRequired",
    "effectiveSource",
    "parityStatus",
    "reason",
    "evidence",
  ]);
  assert.deepEqual(schema.properties?.gates?.required, GATES);
  assert.deepEqual(schema.$defs?.authority?.required, [
    "execution",
    "action",
    "permission",
    "host",
    "durableMutation",
  ]);
});
