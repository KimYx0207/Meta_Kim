import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { fixtureCritical, fixtureReadWorkOrder, refreshFixtureSourcePins, runWithFixtureHostThinking } from "../helpers/host-reasoning-fixture.mjs";
import { localProtocolFixtureTaskFacts } from "../helpers/task-design-facts.mjs";
import { buildGovernanceRequirementsShadow } from "../../scripts/governed-execution/governance-requirements-shadow-adapter.mjs";

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

test("current task-bound facts drive approved Gates while legacy and invalid inputs cannot bypass host preparation", async (t) => {
  const fixture = createGovernanceRuntimeFixtureScope(t);
  refreshFixtureSourcePins(fixture);
  const { runMetaTheoryGovernedExecution } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const task = "Inspect package.json and report its declared package name.";
  const facts = localProtocolFixtureTaskFacts(task);
  const criticalInput = fixtureCritical({ task, successCriteria: [{ id: "package-name", condition: "The package name matches the current package.json", evidenceRequired: "Current source read and exact package name" }] });
  const options = (name) => ({
    task, criticalInput, runId: name, projectRoot: fixture.repoRoot,
    stateDir: path.join(fixture.root, name), dbPath: path.join(fixture.root, name + ".sqlite"),
    runtime: "codex", osTarget: "windows", projectCapabilityMutationMode: "read_only",
  });
  const legacyFacts = structuredClone(facts);
  legacyFacts.schemaVersion = "governance-task-facts-v1";
  delete legacyFacts.taskHash;
  delete legacyFacts.design;
  const invalidLegacyFacts = { ...legacyFacts, evidence: { ...legacyFacts.evidence,
    references: ["sk-live-shadow-integration-raw-secret-must-not-persist"] } };
  const malformedLegacyFacts = { schemaVersion: "governance-task-facts-v1",
    rawStructuralMarker: "governance-shadow-structural-raw-must-not-persist" };
  for (const [index, input] of [null, legacyFacts, invalidLegacyFacts, malformedLegacyFacts].entries()) {
    const preparation = await runMetaTheoryGovernedExecution({ ...options("missing-current-facts-" + index), governanceTaskFacts: input });
    assert.equal(preparation.artifactKind, "host_preparation");
    assert.equal(preparation.hostInvocationRequestPacket.nextAction.action, "assess_current_task_design_facts");
    assert.equal(preparation.taskDesignRoutePacket.route, "assess_unknowns");
    assert.equal(preparation.governanceTaskFacts, null);
    assert.deepEqual(preparation.workerTaskPackets, []);
    assert.equal(preparation.coreLoop.stageDagPacket, undefined);
    assert.equal(preparation.publicReadyDecision.publicReady, false);
    assert.doesNotMatch(JSON.stringify(preparation), /sk-live-shadow-integration-raw-secret-must-not-persist|governance-shadow-structural-raw-must-not-persist/u);
  }

  // The shadow sanitizer still rejects legacy payloads without serializing raw
  // values; those payloads no longer reach a completed runner artifact because
  // current task-bound facts are required before Thinking can dispatch.
  for (const invalid of [invalidLegacyFacts, malformedLegacyFacts]) {
    const shadow = buildGovernanceRequirementsShadow({ governanceTaskFacts: invalid });
    assert.equal(shadow.evaluationStatus, "not_evaluated_invalid_normalized_facts");
    assert.equal(shadow.evaluation, null);
    assert.deepEqual(shadow.facts, { schemaVersion: null, fingerprint: null });
    assert.doesNotMatch(JSON.stringify(shadow), /sk-live-shadow-integration-raw-secret-must-not-persist|governance-shadow-structural-raw-must-not-persist/u);
    for (const property of ["error", "errorMessage", "stack"]) assert.equal(Object.hasOwn(shadow, property), false);
  }
  for (const [index, invalid] of [
    { ...facts, evidence: invalidLegacyFacts.evidence },
    { schemaVersion: "governance-task-facts-v2", rawStructuralMarker: "governance-shadow-structural-raw-must-not-persist" },
    { ...facts, taskHash: "0".repeat(64) },
  ].entries()) {
    const invalidOptions = options("invalid-current-facts-" + index);
    await assert.rejects(runMetaTheoryGovernedExecution({ ...invalidOptions, governanceTaskFacts: invalid }), (error) => {
      assert.equal(error instanceof TypeError, true);
      assert.doesNotMatch(error.message, /sk-live-shadow-integration-raw-secret-must-not-persist|governance-shadow-structural-raw-must-not-persist/u);
      return true;
    });
    assert.equal(existsSync(path.join(invalidOptions.stateDir, invalidOptions.runId + ".json")), false);
  }

  const run = (name, governanceTaskFacts) => runWithFixtureHostThinking(runMetaTheoryGovernedExecution, options(name), {
    criticalInput, governanceTaskFacts,
    workOrders: preparation => [fixtureReadWorkOrder(preparation, { id: "package-name-read", todayTask: task,
      output: "The source-bound package name", criterionIds: ["package-name"], taskFacts: governanceTaskFacts })],
  });
  const baseline = await run("current-facts", facts);
  const reviewed = await run("current-review-facts", { ...facts, intent: { ...facts.intent, userRequestedReview: true } });
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
  assert.equal(cutoverPlan.gates.review.effectiveRequired, false);
  assert.equal(reviewed.governanceRequirementPlanPacket.gates.review.effectiveRequired, true,
    "Current task-bound review facts must affect the approved review gate");

  for (const artifact of [baseline, reviewed]) {
    const shadow = artifact.sourceArtifacts.governanceRequirementsShadow;
    const plan = artifact.governanceRequirementPlanPacket;
    assert.equal(shadow.evaluationStatus, "evaluated");
    assert.equal(shadow.facts.schemaVersion, "governance-task-facts-v2");
    assert.match(shadow.facts.fingerprint, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(shadow.evaluation.schemaVersion, "governance-requirements-v1");
    assert.equal(shadow.evaluation.governanceRequirements.verification.required, true);
    assert.equal(shadow.evaluation.parityDiagnostics.mode, "compared");
    assert.equal(shadow.evaluation.parityDiagnostics.legacySource, "legacy:governed-runner-v3");
    assert.deepEqual(plan.authority, { execution: false, action: false, permission: false, host: false, durableMutation: false });
    assert.deepEqual(shadow.authority, { gatesExecution: false, changesArtifactStatus: false, changesCoreLoop: false,
      changesRouteGate: false, changesChoiceDecision: false, changesPreDecision: false, triggersNativeChoice: false, writesState: false });
    assert.deepEqual(namedPropertyPaths(artifact, "governanceRequirementsShadow"), ["sourceArtifacts.governanceRequirementsShadow"]);
    assert.deepEqual(namedPropertyPaths(artifact, "governanceRequirementPlanPacket"), ["governanceRequirementPlanPacket"]);
    for (const [phase, gate] of [["planning", "planning"], ["review", "review"], ["meta_review", "metaReview"], ["verify", "verification"], ["evolve", "evolution"]]) {
      assert.equal(artifact.businessPhasePlanPacket.phases.find(item => item.phase === phase).status === "skipped",
        plan.gates[gate].effectiveRequired === false, `${phase} follows the effective ${gate} Gate`);
    }
    assert.equal(artifact.contentEvidencePacket.researchRequired, plan.gates.research.effectiveRequired);
    assert.equal(artifact.coreLoop.executionResult.actualWorkerExecution, false);
    assert.equal(artifact.sourceArtifacts.orchestrationReport.selectedExecutionRoute.routeExecutionGate.canEnterExecution, false);
    assert.equal(artifact.summaryPacket.publicReady, false);
  }
});
