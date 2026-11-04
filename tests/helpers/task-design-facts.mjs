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
