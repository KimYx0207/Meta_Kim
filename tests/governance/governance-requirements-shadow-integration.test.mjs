import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runMetaTheoryGovernedExecution } from "../../scripts/run-meta-theory-governed-execution.mjs";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function taskFacts(overrides = {}) {
  const facts = {
    schemaVersion: "governance-task-facts-v1",
    intent: {
      executable: true,
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
      behaviorPreservingInternalOnly: true,
    },
    decision: {
      reasonableOptionCount: 1,
      materialDimensions: [],
      internalImplementationOnly: true,
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
    verification: { deterministicChecks: ["check:targeted-test"] },
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

function legacyProjection(artifact) {
  const selectedRoute = artifact.sourceArtifacts.orchestrationReport.selectedExecutionRoute;
  return {
    routeExecutionGate: selectedRoute.routeExecutionGate,
    entryChoiceDecision: selectedRoute.entryChoiceDecision,
    preDecisionOptionFrame: artifact.preDecisionOptionFrame,
    status: artifact.status,
  };
}

function namedPropertyPaths(value, property, currentPath = "") {
  if (value == null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    return [
      ...(key === property ? [nextPath] : []),
      ...namedPropertyPaths(nested, property, nextPath),
    ];
  });
}

async function withFrozenClock(work) {
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [FIXED_NOW]));
    }

    static now() {
      return new RealDate(FIXED_NOW).getTime();
    }
  }

  globalThis.Date = FrozenDate;
  try {
    return await work();
  } finally {
    globalThis.Date = RealDate;
  }
}

test("governance requirements derive CLI facts, compare legacy, and cut over only approved Gates", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "meta-kim-governance-shadow-integration-"));
  const runId = "governance-requirements-shadow-integration";
  const options = (name, governanceTaskFacts) => ({
    task: "Refactor this internal module and run tests",
    governanceTaskFacts,
    runId,
    stateDir: path.join(tempRoot, name, "state"),
    artifactDir: path.join(tempRoot, name, "artifacts"),
    dbPath: path.join(tempRoot, name, "runs.sqlite"),
    runtime: "codex",
    osTarget: "windows",
    projectCapabilityMutationMode: "read_only",
  });

  try {
    const { baseline, valid, malformed, structurallyMalformed } = await withFrozenClock(async () => {
      const baseline = await runMetaTheoryGovernedExecution(options("baseline", null));
      const valid = await runMetaTheoryGovernedExecution(options("valid", taskFacts()));
      const malformed = await runMetaTheoryGovernedExecution(options("malformed", taskFacts({
        evidence: {
          references: ["sk-live-shadow-integration-raw-secret-must-not-persist"],
        },
      })));
      const structurallyMalformed = await runMetaTheoryGovernedExecution(options("structurally-malformed", {
        schemaVersion: "governance-task-facts-v1",
        rawStructuralMarker: "governance-shadow-structural-raw-must-not-persist",
      }));
      return { baseline, valid, malformed, structurallyMalformed };
    });

    const absentShadow = baseline.sourceArtifacts.governanceRequirementsShadow;
    assert.equal(absentShadow.evaluationStatus, "evaluated");
    assert.equal(absentShadow.facts.schemaVersion, "governance-task-facts-v1");
    assert.match(absentShadow.facts.fingerprint, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(absentShadow.evaluation.parityDiagnostics.mode, "compared");
    assert.equal(absentShadow.evaluation.parityDiagnostics.legacySource, "legacy:governed-runner-v3");

    const validShadow = valid.sourceArtifacts.governanceRequirementsShadow;
    assert.equal(validShadow.evaluationStatus, "evaluated");
    assert.equal(validShadow.evaluation.schemaVersion, "governance-requirements-v1");
    assert.equal(validShadow.evaluation.governanceRequirements.verification.required, true);
    assert.equal(validShadow.evaluation.parityDiagnostics.mode, "compared");
    assert.equal(validShadow.evaluation.parityDiagnostics.legacySource, "legacy:governed-runner-v3");

    const cutoverPlan = baseline.governanceRequirementPlanPacket;
    assert.equal(cutoverPlan.schemaVersion, "governance-requirement-cutover-v1");
    assert.equal(cutoverPlan.mode, "gradual_cutover");
    assert.equal(Object.keys(cutoverPlan.gates).length, 10);
    for (const key of ["research", "planning", "review", "metaReview", "securityReview", "verification", "evolution"]) {
      assert.equal(cutoverPlan.gates[key].effectiveSource, "domain", key);
    }
    for (const key of ["clarification", "humanDecision", "permission"]) {
      assert.equal(cutoverPlan.gates[key].effectiveSource, "legacy", key);
    }
    assert.deepEqual(cutoverPlan.authority, {
      execution: false,
      action: false,
      permission: false,
      host: false,
      durableMutation: false,
    });
    assert.deepEqual(
      valid.governanceRequirementPlanPacket,
      cutoverPlan,
      "valid caller-supplied facts remain diagnostic and cannot replace internally derived effective facts",
    );
    for (const [phase, gate] of [
      ["planning", "planning"],
      ["review", "review"],
      ["meta_review", "metaReview"],
      ["verify", "verification"],
      ["evolve", "evolution"],
    ]) {
      const phaseStatus = baseline.businessPhasePlanPacket.phases.find((item) => item.phase === phase).status;
      assert.equal(
        phaseStatus === "skipped",
        cutoverPlan.gates[gate].effectiveRequired === false,
        `${phase} must follow the effective ${gate} Gate`,
      );
    }
    assert.equal(
      baseline.contentEvidencePacket.researchRequired,
      cutoverPlan.gates.research.effectiveRequired,
      "workflow research selection must follow the effective research Gate",
    );

    const malformedShadow = malformed.sourceArtifacts.governanceRequirementsShadow;
    assert.equal(malformedShadow.evaluationStatus, "not_evaluated_invalid_normalized_facts");
    assert.equal(malformedShadow.evaluation, null);
    assert.deepEqual(malformedShadow.facts, { schemaVersion: null, fingerprint: null });
    assert(Object.values(malformed.governanceRequirementPlanPacket.gates).every(
      (gate) => gate.effectiveSource === "legacy",
    ));
    const serializedMalformed = JSON.stringify(malformed);
    assert.doesNotMatch(serializedMalformed, /sk-live-shadow-integration-raw-secret-must-not-persist/u);
    for (const property of ["error", "errorMessage", "stack"]) {
      assert.equal(Object.hasOwn(malformedShadow, property), false, `shadow must not serialize ${property}`);
    }

    const structurallyMalformedShadow = structurallyMalformed.sourceArtifacts.governanceRequirementsShadow;
    assert.equal(structurallyMalformedShadow.evaluationStatus, "not_evaluated_invalid_normalized_facts");
    assert.equal(structurallyMalformedShadow.evaluation, null);
    assert.deepEqual(structurallyMalformedShadow.facts, { schemaVersion: null, fingerprint: null });
    assert(Object.values(structurallyMalformed.governanceRequirementPlanPacket.gates).every(
      (gate) => gate.effectiveSource === "legacy",
    ));
    assert.doesNotMatch(
      JSON.stringify(structurallyMalformed),
      /governance-shadow-structural-raw-must-not-persist/u,
    );
    for (const property of ["error", "errorMessage", "stack"]) {
      assert.equal(
        Object.hasOwn(structurallyMalformedShadow, property),
        false,
        `structural rejection must not serialize ${property}`,
      );
    }

    for (const artifact of [baseline, valid, malformed, structurallyMalformed]) {
      assert.deepEqual(
        namedPropertyPaths(artifact, "governanceRequirementsShadow"),
        ["sourceArtifacts.governanceRequirementsShadow"],
        "the diagnostic shadow may exist only under sourceArtifacts",
      );
      assert.deepEqual(
        namedPropertyPaths(artifact, "governanceRequirementPlanPacket"),
        ["governanceRequirementPlanPacket"],
        "the effective gradual-cutover plan has one canonical artifact location",
      );
      assert.deepEqual(artifact.sourceArtifacts.governanceRequirementsShadow.authority, {
        gatesExecution: false,
        changesArtifactStatus: false,
        changesCoreLoop: false,
        changesRouteGate: false,
        changesChoiceDecision: false,
        changesPreDecision: false,
        triggersNativeChoice: false,
        writesState: false,
      });
    }

    const baselineLegacy = legacyProjection(baseline);
    for (const artifact of [valid, malformed, structurallyMalformed]) {
      const candidateLegacy = legacyProjection(artifact);
      assert.equal(
        JSON.stringify(candidateLegacy),
        JSON.stringify(baselineLegacy),
        "domain input must not byte-change legacy route, choice, pre-decision, or artifact status authority",
      );
      assert.deepEqual(candidateLegacy, baselineLegacy);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
