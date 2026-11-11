import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { deriveGovernanceTaskFacts } from "../../scripts/governed-execution/governance-requirement-legacy-adapter.mjs";
import { evaluateGovernanceRequirements } from "../../src/domain/governance/governance-requirements.mjs";
import { taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";
import { readCurrentTaskFacts, selectTaskDesignRoute, mergeTaskSafetyFacts, requireCurrentDispatchPolicy, inheritTaskDesignFacts, verifyTaskDesignReadiness, TASK_DESIGN_POLICY } from "../../scripts/governed-execution/task-design-dispatch.mjs";
import { routeCandidateOptions } from "../../scripts/governed-execution/intent-dialogue.mjs";
import { buildRunnerStageDagPacket } from "../../scripts/run-meta-theory-governed-execution.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { refreshFixtureSourcePins, fixtureCritical, fixtureReadWorkOrder, runWithFixtureHostThinking } from "../helpers/host-reasoning-fixture.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { readOnlyFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

const task = "Rename a local constant while preserving behavior";
function inferred(request = task, count = 1) {
  return deriveGovernanceTaskFacts({ task: request, orchestrationReport: { workerTaskPackets: Array.from({ length: count }, () => ({ capabilityRequirements: ["local-code"] })) }, planChallengePreview: { planChallengeState: { active: false } }, requestedSideEffectActions: [] });
}
function facts(design = {}, request = task) {
  return { ...structuredClone(inferred(request)), schemaVersion: "governance-task-facts-v2", taskHash: taskOutcomeDigest(request),
    design: { uncertainty: "clear", coupling: "local", operationalRisk: "low", verification: "direct", ...design } };
}

test("worker and file scheduling cannot manufacture coupled design or known-safe facts", () => {
  assert.deepEqual(inferred(task, 1), inferred(task, 20));
  assert.equal(inferred().security.auth, null);
  assert.equal(inferred().security.permission, null);
  assert.equal(readCurrentTaskFacts(inferred(), task), null);
  assert.equal(selectTaskDesignRoute(null).route, "assess_unknowns");
});

test("four dimensions separately select bounded change, focused probe and integrated design", () => {
  const cases = [
    [{}, "targeted_change", false],
    [{ operationalRisk: "sensitive" }, "targeted_change", false],
    [{ uncertainty: "focused_unknown" }, "focused_probe", false],
    [{ verification: "needs_probe" }, "focused_probe", false],
    [{ uncertainty: "undecided" }, "integrated_design", true],
    [{ coupling: "shared_state" }, "integrated_design", true],
    [{ coupling: "shared_contract" }, "integrated_design", true],
    [{ operationalRisk: "unknown" }, "assess_unknowns", false],
  ];
  for (const [dimension, route, designRequired] of cases) {
    const current = readCurrentTaskFacts(facts(dimension), task);
    assert.equal(selectTaskDesignRoute(current).route, route);
    assert.equal(selectTaskDesignRoute(current).designRequired, designRequired);
  }
  assert.equal(evaluateGovernanceRequirements(facts({ operationalRisk: "sensitive" })).governanceRequirements.permission.required, true);
});

test("unknown dimensions remain independent of a focused or integrated route", () => {
  const dimensions = ["uncertainty", "coupling", "operationalRisk", "verification"];
  for (const dimension of dimensions) {
    for (const trigger of [{ uncertainty: "focused_unknown" }, { coupling: "shared_state" }, { verification: "needs_probe" }]) {
      if (Object.hasOwn(trigger, dimension)) continue;
      const current = facts({ ...trigger, [dimension]: "unknown" });
      const readiness = verifyTaskDesignReadiness({ todayTask: task, taskFactsSubject: task, taskFacts: current,
        designBinding: { designId: "current" }, researchEvidence: ["evidence:local-source"],
        handoffTarget: "reviewer", verifySteps: [{ id: "verify", step: "Inspect the result", verify: "Matches the criterion" }] });
      assert.equal(readiness.ready, false, JSON.stringify(current.design));
      assert.deepEqual(readiness.unknownDimensions, [dimension]);
      assert.ok(readiness.gaps.includes("current_subtask_facts_required"));
      assert.equal(selectTaskDesignRoute(readCurrentTaskFacts(current, task)).assessmentRequired, true);
    }
  }
});

test("bound false cannot erase observed permissions; task/hash/version/malformed facts cannot become authority", () => {
  const request = "Change production permission enforcement";
  const current = facts({}, request); current.security.permission = false;
  assert.equal(mergeTaskSafetyFacts(current, inferred(request), { requestedSideEffectActions: ["production-write"] }).security.permission, true);
  assert.equal(mergeTaskSafetyFacts(current, inferred(request)).security.permission, false, "Keywords alone do not override current evidence");
  const docsTask = "Write documentation explaining payments; do not change permissions";
  const docsFacts = facts({}, docsTask);
  docsFacts.change = Object.fromEntries(Object.keys(docsFacts.change).map(key => [key, key === "behaviorPreservingInternalOnly"]));
  docsFacts.security = Object.fromEntries(Object.keys(docsFacts.security).map(key => [key, false]));
  assert.equal(evaluateGovernanceRequirements(mergeTaskSafetyFacts(docsFacts, inferred(docsTask))).governanceRequirements.permission.required, false);
  assert.throws(() => readCurrentTaskFacts(facts(), "another task"), /another task/);
  assert.throws(() => readCurrentTaskFacts(facts({ coupling: false }), task), /invalid/);
  assert.equal(readCurrentTaskFacts({ ...facts(), schemaVersion: "unknown" }, task), null);
});

test("legacy resume needs a successor while a current immutable plan remains readable", () => {
  const old = { workerTaskPackets: [{ taskPacketId: "done" }], completedEvidence: ["unchanged"] };
  const before = structuredClone(old);
  assert.throws(() => requireCurrentDispatchPolicy(old), /one-way successor/);
  assert.deepEqual(old, before);
  requireCurrentDispatchPolicy({ ...old, taskDesignRoutePacket: { policy: TASK_DESIGN_POLICY } });
});

test("facts inheritance expires when the same task's intent or research decisions change", () => {
  const old = { governanceTaskFacts: facts(), goalContractPacket: { intentBinding: { intentDigest: "old-intent" } }, requirementsDiscoveryPacket: { discoveryDigest: "old-decisions" } };
  assert.equal(inheritTaskDesignFacts(old, { intentDigest: "old-intent", requirementsDigest: "old-decisions" }), old.governanceTaskFacts);
  assert.equal(inheritTaskDesignFacts(old, { intentDigest: "new-intent", requirementsDigest: "old-decisions" }), null);
  assert.equal(inheritTaskDesignFacts(old, { intentDigest: "old-intent", requirementsDigest: "new-decisions" }), null);
});

test("provider/model scores do not become product questions; material outcome evidence can", () => {
  const models = ["model-a", "model-b"].map(id => ({ id, owner: id, weapon: id, score: 76, expectedResult: "The same report" }));
  assert.deepEqual(routeCandidateOptions({ rankedRoutes: models, decisionCard: { options: models } }), []);
  const ownerOnly = models.map(option => ({ ...option, materialDimensions: ["owner", "loadout"], evidenceRefs: ["evidence:equivalent-outcome"] }));
  assert.deepEqual(routeCandidateOptions({ decisionCard: { options: ownerOnly } }), []);
  const riskOptions = models.map((option, index) => ({ ...option, materialDimensions: ["risk"],
    expectedResult: index ? "Retain a recoverable local copy" : "Replace the current external copy", evidenceRefs: ["evidence:reviewed-effect"] }));
  const selected = routeCandidateOptions({ decisionCard: { options: riskOptions } });
  assert.equal(selected.length, 2);
  assert.deepEqual(selected[0].evidenceRefs, ["evidence:reviewed-effect"]);
  assert.deepEqual(routeCandidateOptions({ decisionCard: { options: riskOptions.map(option => ({ ...option, evidenceRefs: [] })) } }), []);
  assert.equal(routeCandidateOptions({ decisionCard: { options: models.map((option, index) => ({ ...option,
    materialDimensions: ["scope"], evidenceRefs: ["conversation:delivery-scope"], expectedResult: index ? "Whole book" : "One chapter" })) } }).length, 2);
});

test("mixed subtask scopes keep their own demands without downgrading permissions", () => {
  const make = (todayTask, dimensions) => ({ taskPacketId: todayTask, todayTask, taskFactsSubject: todayTask, taskFacts: facts(dimensions, todayTask), scopeFiles: [todayTask + ".js"] });
  const clear = make("clear", {});
  const shared = make("shared", { coupling: "shared_state" });
  const probe = make("probe", { uncertainty: "focused_unknown" });
  const sensitive = { ...make("sensitive", { operationalRisk: "sensitive" }), externalWriteBoundary: true };
  assert.equal(verifyTaskDesignReadiness(clear).ready, true);
  assert.deepEqual(verifyTaskDesignReadiness(shared).gaps, ["current_subtask_integrated_design_required"]);
  assert.deepEqual(verifyTaskDesignReadiness(probe).gaps, ["current_subtask_decision_evidence_required"]);
  assert.deepEqual(verifyTaskDesignReadiness(sensitive).gaps, ["current_subtask_sensitive_verification_required"]);
  assert.equal(verifyTaskDesignReadiness({ ...sensitive, handoffTarget: "existing-verifier", verifySteps: [{ step: "Check permission boundary" }] }).ready, true);
  assert.equal(verifyTaskDesignReadiness({ taskPacketId: "old" }).ready, false);
  assert.equal(mergeTaskSafetyFacts(facts(), inferred(), { workerTaskPackets: [sensitive] }).security.permission, true);
  assert.deepEqual(clear.scopeFiles, ["clear.js"]);
});

test("actual DAG bridge invokes only the bounded worker; optional reviews retain local controls", async () => {
  const packet = { taskPacketId: "bounded", owner: "reader", ownerAgent: "reader", output: "Source observation", scopeFiles: ["package.json"],
    shardScope: ["metadata"], nonGoals: ["No writes"], dependsOn: [], executionMode: "primary_execution", mutationPolicy: "read_only", workspaceIsolation: "shared_read_only", externalWriteBoundary: false,
    todayTask: task, taskFacts: facts(), taskFactsSubject: task };
  const dag = buildRunnerStageDagPacket([packet], null, { gates: { review: { effectiveRequired: false }, metaReview: { effectiveRequired: false }, evolution: { effectiveRequired: false } } });
  for (const stage of ["Review", "Meta-Review", "Evolution"]) {
    assert.deepEqual(dag.nodes.filter(node => node.stage === stage).map(node => node.laneKind), ["stage_control", "stage_merge"]);
  }
  const calls = [];
  const result = await runStageRunnerBridge({ runId: "bounded-spy", runtime: "codex", stageDagPacket: dag, workerTaskPackets: [packet], workspaceRoot: process.cwd(),
    evidenceKind: "injected_unit_spy", invokeWorker: async ({ node, packet: invoked }) => {
      calls.push({ stage: node.stage, taskId: invoked.taskPacketId });
      const at = new Date().toISOString();
      return { status: "pass", runtime: "codex", exitCode: 0, startedAt: at, endedAt: at, durationMs: 1, outputText: "observed metadata", outputSha256: "a".repeat(64), rawOutputSha256: "b".repeat(64), hostEventCount: 1, toolEventCount: 0, stderrTail: "" };
    } });
  assert.equal(result.status, "pass");
  assert.deepEqual(calls, [{ stage: "Execution", taskId: "bounded" }]);
  assert.equal(result.executionProjection.invocationTruth.nativeRuntimeInvoked, false);
});

test("mixed actual ready-set invokes independent ready work and leaves design gaps and dependents pending", async () => {
  const make = (id, design = {}, dependsOn = []) => ({ taskPacketId: id, owner: "reader", ownerAgent: "reader", output: "Source observation", scopeFiles: [id + ".js"],
    shardScope: [id], nonGoals: ["No writes"], dependsOn, executionMode: "primary_execution", mutationPolicy: "read_only", workspaceIsolation: "shared_read_only", externalWriteBoundary: false,
    todayTask: id, taskFacts: facts(design, id), taskFactsSubject: id });
  const packets = [make("clear"), make("shared", { coupling: "shared_state" }), make("dependent", {}, ["shared"]),
    { ...make("unknown-researched", { uncertainty: "focused_unknown", operationalRisk: "unknown" }), researchEvidence: ["evidence:local-source"] },
    { ...make("unknown-designed", { coupling: "shared_state", operationalRisk: "unknown" }), designBinding: { designId: "current" } },
    make("unknown-dependent", {}, ["unknown-researched"]),
    { ...make("bounded-diagnostic"), output: "Read the named source to assess the implementation task's unknown risk; make no change" },
    { ...make("sensitive", { operationalRisk: "sensitive" }), handoffTarget: "security-owner", verifySteps: [{ id: "safety", step: "Check safety", verify: "Permission boundary unchanged" }] }];
  const dag = buildRunnerStageDagPacket(packets, { runtimeCapacity: 4 });
  const calls = [];
  const result = await runStageRunnerBridge({ runId: "mixed-design-spy", runtime: "codex", stageDagPacket: dag, workerTaskPackets: packets, workspaceRoot: process.cwd(),
    evidenceKind: "injected_unit_spy", invokeWorker: async ({ packet }) => {
      calls.push(packet.taskPacketId);
      const at = new Date().toISOString();
      return { status: "pass", runtime: "codex", exitCode: 0, startedAt: at, endedAt: at, durationMs: 1, outputText: "bounded observation", outputSha256: "a".repeat(64), rawOutputSha256: "b".repeat(64), hostEventCount: 1, toolEventCount: 0, stderrTail: "" };
    } });
  assert.deepEqual(calls.sort(), ["bounded-diagnostic", "clear", "sensitive"]);
  assert.notEqual(result.status, "pass");
  assert.equal(result.executionProjection.invocationTruth.nativeRuntimeInvoked, false);
  assert.ok(JSON.stringify(result).includes("current_subtask_integrated_design_required"));
  assert.ok(JSON.stringify(result).includes("current_subtask_facts_required"));
  assert.equal(result.workerResults.some(worker => worker.taskPacketId === "dependent" && worker.status === "completed"), false);
});

test("ordinary entry consumes bound facts before any execution dispatch or complete design request", async t => {
  const fixture = createGovernanceRuntimeFixtureScope(t);
  refreshFixtureSourcePins(fixture);
  const { runMetaTheoryGovernedExecution } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const criticalInput = { taskHash: taskOutcomeDigest(task), intentDigest: null, realIntent: task, evidenceRefs: ["fixture:request"], blockingUnknowns: [], nonGoals: [], successCriteria: ["The constant is renamed without behavior changes"] };
  const invoke = (id, governanceTaskFacts, extra = {}) => runMetaTheoryGovernedExecution({ task, runId: id, criticalInput, governanceTaskFacts,
    stateDir: path.resolve("tmp/design-state"), artifactDir: path.resolve("tmp/design-artifacts"), dbPath: path.resolve("tmp/design.sqlite"), projectCapabilityMutationMode: "read_only", ...extra });
  const unknown = await invoke("design-unknown", null);
  assert.equal(unknown.hostInvocationRequestPacket.nextAction.action, "assess_current_task_design_facts");
  assert.deepEqual(unknown.workerTaskPackets, []);
  const compound = await invoke("design-unknown-probe", facts({ uncertainty: "focused_unknown", operationalRisk: "unknown" }));
  assert.equal(compound.hostInvocationRequestPacket.nextAction.action, "assess_current_task_design_facts");
  assert.deepEqual(compound.taskDesignRoutePacket.unknownDimensions, ["operationalRisk"]);
  assert.deepEqual(compound.workerTaskPackets, []);
  const probe = await invoke("design-probe", facts({ uncertainty: "focused_unknown" }));
  assert.equal(probe.hostInvocationRequestPacket.nextAction.stage, "Fetch");
  assert.equal(probe.taskDesignRoutePacket.designRequired, false);
  const shared = await invoke("design-shared", facts({ coupling: "shared_state" }));
  assert.equal(shared.hostInvocationRequestPacket.nextAction.action, "produce_integrated_design_for_current_boundaries");
  assert.deepEqual(shared.hostInvocationRequestPacket.nextAction.researchGaps, []);
  const material = facts({ uncertainty: "undecided" });
  material.decision = { reasonableOptionCount: 2, materialDimensions: ["result"], internalImplementationOnly: false };
  const choice = await invoke("design-choice", material);
  assert.equal(choice.hostInvocationRequestPacket.nextAction.stage, "Critical");
  assert.equal(choice.hostInvocationRequestPacket.nextAction.action, "declare_current_material_options_for_native_choice");
  const clear = await invoke("design-clear", facts());
  assert.equal(clear.taskDesignRoutePacket.route, "targeted_change");
  assert.equal(clear.hostInvocationRequestPacket.nextAction.stage, "Thinking");
  assert.deepEqual(clear.hostInvocationRequestPacket.nextAction.researchGaps, []);
  assert.ok(clear.fetchPacket.capabilityDiscovery.inventoryDigest);
  const inherited = await invoke("design-inherited", undefined, { previousPlanChallengeRunId: "design-clear" });
  assert.equal(inherited.taskDesignRoutePacket.route, "targeted_change");
  assert.equal(inherited.governanceTaskFacts.taskHash, taskOutcomeDigest(task));
  await writeFile(path.resolve("tmp/current-facts.json"), JSON.stringify(facts()));
  await writeFile(path.resolve("tmp/current-critical.json"), JSON.stringify(criticalInput));
  const cli = fixture.run(["scripts/run-meta-theory-governed-execution.mjs", "--task", task, "--run-id", "design-cli", "--critical-input", "tmp/current-critical.json", "--governance-task-facts-input", "tmp/current-facts.json",
    "--state-dir", "tmp/cli-state", "--artifact-dir", "tmp/cli-artifacts", "--db", "tmp/cli.sqlite"], { timeout: 30_000 });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const cliArtifact = JSON.parse(await readFile(path.resolve("tmp/cli-artifacts/design-cli.json"), "utf8"));
  assert.equal(cliArtifact.taskDesignRoutePacket.route, "targeted_change");
  assert.equal(cliArtifact.hostInvocationRequestPacket.nextAction.stage, "Thinking");
  await assert.rejects(invoke("design-wrong-task", facts({}, "unrelated task")), /another task/);
});

test("ordinary host handoff retains assessed diagnosis while the parent implementation risk stays unknown", async t => {
  const fixture = createGovernanceRuntimeFixtureScope(t);
  refreshFixtureSourcePins(fixture);
  const { runMetaTheoryGovernedExecution } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const request = "Inspect the package file to establish implementation risk before making changes";
  const diagnostic = "Read the scripts in package.json without changing any files";
  const criticalInput = fixtureCritical({ task: request, successCriteria: [{ id: "risk-evidence",
    condition: "Report current source evidence about the affected package scripts", evidenceRequired: "Current package.json inspection" }] });
  const governanceTaskFacts = readOnlyFixtureTaskFacts(request, { operationalRisk: "unknown" });
  const invoke = (id, diagnosticFacts) => runWithFixtureHostThinking(runMetaTheoryGovernedExecution, {
    task: request, runId: id, projectRoot: fixture.repoRoot, runtime: "codex", projectCapabilityMutationMode: "read_only",
    stateDir: path.join(fixture.root, id), artifactDir: path.join(fixture.root, id + "-artifacts"), dbPath: path.join(fixture.root, id + ".sqlite"),
  }, { criticalInput, governanceTaskFacts,
    workOrders: preparation => [fixtureReadWorkOrder(preparation, { id: "bounded-diagnosis", todayTask: diagnostic,
      output: "Observed source evidence, with no implementation changes", criterionIds: ["risk-evidence"], taskFacts: diagnosticFacts })] });
  const ready = await invoke("assessed-diagnosis", readOnlyFixtureTaskFacts(diagnostic));
  assert.equal(ready.preparation, undefined);
  assert.deepEqual(ready.taskDesignRoutePacket.unknownDimensions, ["operationalRisk"]);
  assert.equal(ready.workerTaskPackets.length, 1);
  assert.equal(ready.workerTaskPackets[0].taskDesignAssessment.ready, true);
  assert.equal(ready.workerTaskPackets[0].workOrderReadiness, "ready");
  assert.equal(ready.coreLoop.executionResult.actualWorkerExecution, false);
  const unresolved = await invoke("unassessed-diagnosis", readOnlyFixtureTaskFacts(diagnostic, { operationalRisk: "unknown" }));
  assert.equal(unresolved.workerTaskPackets[0].taskDesignAssessment.ready, false);
  assert.equal(unresolved.workerTaskPackets[0].workOrderReadiness, "incomplete");
  assert.ok(unresolved.workerTaskPackets[0].taskDesignAssessment.gaps.includes("current_subtask_facts_required"));
  assert.equal(unresolved.coreLoop.executionResult.actualWorkerExecution, false);
});
