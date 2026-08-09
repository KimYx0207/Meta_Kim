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
    coreLoop: artifact.coreLoop,
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

test("governance requirements remain a contained, non-authorizing shadow of governed execution", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "meta-kim-governance-shadow-integration-"));
  const runId = "governance-requirements-shadow-integration";
  const options = (name, governanceTaskFacts) => ({
    task: "Implement a low-risk internal change",
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
    const { baseline, valid, malformed, structurallyMalformed } = await withFrozenClock(async () => ({
      baseline: await runMetaTheoryGovernedExecution(options("baseline", null)),
      valid: await runMetaTheoryGovernedExecution(options("valid", taskFacts())),
      malformed: await runMetaTheoryGovernedExecution(options("malformed", taskFacts({
        evidence: {
          references: ["sk-live-shadow-integration-raw-secret-must-not-persist"],
        },
      }))),
      structurallyMalformed: await runMetaTheoryGovernedExecution(options("structurally-malformed", {
        schemaVersion: "governance-task-facts-v1",
        rawStructuralMarker: "governance-shadow-structural-raw-must-not-persist",
      })),
    }));

    const absentShadow = baseline.sourceArtifacts.governanceRequirementsShadow;
    assert.equal(absentShadow.evaluationStatus, "not_evaluated_missing_normalized_facts");
    assert.equal(absentShadow.evaluation, null);
    assert.deepEqual(absentShadow.facts, { schemaVersion: null, fingerprint: null });

    const validShadow = valid.sourceArtifacts.governanceRequirementsShadow;
    assert.equal(validShadow.evaluationStatus, "evaluated");
    assert.equal(validShadow.evaluation.schemaVersion, "governance-requirements-v1");
    assert.equal(validShadow.evaluation.governanceRequirements.verification.required, true);
    assert.deepEqual(validShadow.evaluation.parityDiagnostics, {
      mode: "not_compared",
      legacySource: null,
      differences: [],
      notes: ["Shadow engine did not receive a legacy gate snapshot."],
    });

    const malformedShadow = malformed.sourceArtifacts.governanceRequirementsShadow;
    assert.equal(malformedShadow.evaluationStatus, "not_evaluated_invalid_normalized_facts");
    assert.equal(malformedShadow.evaluation, null);
    assert.deepEqual(malformedShadow.facts, { schemaVersion: null, fingerprint: null });
    const serializedMalformed = JSON.stringify(malformed);
    assert.doesNotMatch(serializedMalformed, /sk-live-shadow-integration-raw-secret-must-not-persist/u);
    for (const property of ["error", "errorMessage", "stack"]) {
      assert.equal(Object.hasOwn(malformedShadow, property), false, `shadow must not serialize ${property}`);
    }

    const structurallyMalformedShadow = structurallyMalformed.sourceArtifacts.governanceRequirementsShadow;
    assert.equal(structurallyMalformedShadow.evaluationStatus, "not_evaluated_invalid_normalized_facts");
    assert.equal(structurallyMalformedShadow.evaluation, null);
    assert.deepEqual(structurallyMalformedShadow.facts, { schemaVersion: null, fingerprint: null });
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
        "the shadow may exist only under sourceArtifacts",
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
        "shadow input must not byte-change legacy route/choice/status/core-loop output",
      );
      assert.deepEqual(candidateLegacy, baselineLegacy);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
