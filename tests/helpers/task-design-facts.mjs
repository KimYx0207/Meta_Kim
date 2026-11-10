import { deriveGovernanceTaskFacts } from "../../scripts/governed-execution/governance-requirement-legacy-adapter.mjs";
import { taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";

/** Explicit synthetic assessment for these bounded read-only transport fixtures.
 * This is test data, not a runtime inference or permission grant. */
export function readOnlyFixtureTaskFacts(task, design = {}) {
  const base = deriveGovernanceTaskFacts({ task, orchestrationReport: { workerTaskPackets: [] },
    planChallengePreview: { planChallengeState: { active: false } }, requestedSideEffectActions: [] });
  return { ...structuredClone(base), schemaVersion: "governance-task-facts-v2", taskHash: taskOutcomeDigest(task),
    design: { uncertainty: "clear", coupling: "local", operationalRisk: "low", verification: "direct", ...design } };
}

/** Explicit assessment for disposable local protocol fixtures, whose test data
 * supplies all inputs and whose assertions concern routing/ownership/transport.
 * Opt in at the positive-path call site; never use to fill absent-input tests. */
export function localProtocolFixtureTaskFacts(task, overrides = {}) {
  const facts = {
    schemaVersion: "governance-task-facts-v2", taskHash: taskOutcomeDigest(task),
    intent: { executable: true, userRequestedReview: false, durableLearningRequested: false },
    clarity: { blockingUnknowns: [] },
    evidence: { currentExternalFactsRequired: false, localEvidenceSufficient: true, references: ["evidence:disposable-local-protocol-inputs"] },
    change: { multiStep: false, crossModule: false, dataMigration: false, externalSideEffect: false,
      complexArchitectureChange: false, multipleCapabilities: false, publicInterfaceChange: false,
      complexBusinessLogic: false, dataStructureChange: false, behaviorPreservingInternalOnly: true },
    decision: { reasonableOptionCount: 1, materialDimensions: [], internalImplementationOnly: true },
    security: { auth: false, permission: false, credential: false, secret: false, payment: false,
      production: false, databaseDestructive: false, systemConfiguration: false, highPrivilegeDependency: false, highRiskMcp: false },
    verification: { deterministicChecks: ["check:fixture-source-and-boundary-assertions"] },
    design: { uncertainty: "clear", coupling: "local", operationalRisk: "low", verification: "direct" },
  };
  for (const [key, value] of Object.entries(overrides)) facts[key] = { ...facts[key], ...value };
  return facts;
}
