import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { fixtureCritical, fixtureThinkingInput, fixtureReadWorkOrder, refreshFixtureSourcePins } from "../helpers/host-reasoning-fixture.mjs";
import { readOnlyFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

const task = "Read the exact package name from package.json and deliver an evidence-backed report without edits.";
async function prepare(t) {
  const fixture = createGovernanceRuntimeFixtureScope(t); refreshFixtureSourcePins(fixture);
  const { runMetaTheoryGovernedExecution: run } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const criticalInput = fixtureCritical({ task, successCriteria: ["Exact package name with its source"] });
  const base = { task, runtime: "codex", projectRoot: fixture.repoRoot, stateDir: "tmp/first-design", dbPath: "tmp/first-design.sqlite", projectCapabilityMutationMode: "read_only", governanceTaskFacts: readOnlyFixtureTaskFacts(task), designRequired: true, criticalInput };
  const preparation = await run({ ...base, runId: "first-design-fetch" });
  assert.equal(preparation.preparation.status, "needs_thinking");
  assert.equal(preparation.productDesignPacket ?? null, null);
  const thinkingInput = fixtureThinkingInput(preparation, { criticalInput, workOrders: p => [fixtureReadWorkOrder(p, { id: "report", todayTask: task, output: "Exact package report", criterionIds: ["user-outcome"], taskFacts: readOnlyFixtureTaskFacts(task) })] });
  const designInput = { schemaVersion: 1, taskHash: criticalInput.taskHash, intentDigest: null, acceptanceDigest: preparation.goalContractPacket.acceptanceDigest,
    designId: "package-report", revision: 1, mode: "delivery", sourceRefs: ["package.json"], settledDecisionRefs: [], domainTerms: [], userJourneys: [], artifactFlow: [],
    taskSlices: [{ id: "report", outcome: task, capabilityNeed: ["read package metadata"], scopeFiles: ["package.json"], inputRefs: ["package.json"], criterionIds: ["user-outcome"], dependsOn: [], journeyRefs: [], decisionRefs: [],
      deliverables: [{ id: "report", description: "Exact package report", consumer: "User" }], verification: [{ criterionId: "user-outcome", procedure: "Compare to current package.json", expectedEvidence: "Name equals source" }], completionDemo: "Read the exact package name and its source" }] };
  return { fixture, run, preparation, base, thinkingInput, designInput };
}

test("ordinary empty Fetch accepts its first design without replacing task identity or claiming execution", async t => {
  const { run, preparation, base, thinkingInput, designInput } = await prepare(t);
  const before = await readFile(preparation.paths.json);
  const result = await run({ ...base, runId: "first-design-planned", thinkingInput, designInput, previousPlanChallengeRunId: preparation.runId });
  assert.equal(result.workerTaskPackets.length, 1);
  assert.equal(result.workerTaskPackets[0].designBinding.sliceId, "report");
  assert.equal(result.stageRunnerBridgePacket, null);
  assert.deepEqual(await readFile(preparation.paths.json), before);
  const changed = structuredClone(designInput); changed.revision = 2;
  await assert.rejects(run({ ...base, runId: "first-design-replaced", thinkingInput, designInput: changed, previousPlanChallengeRunId: result.runId }), /fingerprint|different task|terminal|identity/);
});

test("first design continuation rejects changed Critical, requirement, source reference and current source bytes", async t => {
  const { run, preparation, base, thinkingInput, designInput } = await prepare(t);
  const resume = { ...base, runId: "first-design-rejected", thinkingInput, designInput, previousPlanChallengeRunId: preparation.runId };
  const changedCritical = { ...base.criticalInput, realIntent: "A different outcome" };
  await assert.rejects(run({ ...resume, criticalInput: changedCritical, thinkingInput: { ...thinkingInput, intentPacket: changedCritical } }), /Critical|preparation|material/);
  await assert.rejects(run({ ...resume, designRequired: false }), /preparation|fingerprint|identity/);
  const changedRefs = { ...base.criticalInput, evidenceRefs: ["AGENTS.md"] };
  await assert.rejects(run({ ...resume, criticalInput: changedRefs, thinkingInput: { ...thinkingInput, intentPacket: changedRefs } }), /preparation|material/);
  const source = await readFile("package.json", "utf8");
  await writeFile("package.json", source + "\n");
  await assert.rejects(run(resume), /preparation|material|source|inventory/);
});
