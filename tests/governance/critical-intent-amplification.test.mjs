import assert from "node:assert/strict";
import test from "node:test";
import { normalizeHostCritical, prepareIntentDialogue, sameHostCriticalMeaning, bindIntentToWorkerTasks } from "../../scripts/governed-execution/intent-dialogue.mjs";
import { taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { fixtureCritical, fixtureThinkingInput, fixtureReadWorkOrder, refreshFixtureSourcePins } from "../helpers/host-reasoning-fixture.mjs";
import { readOnlyFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

const task = "Help me understand the current package.";
const critical = () => fixtureCritical({ task, outcome: "Identify the exact package name and version from current source, with their evidence.",
  successCriteria: [{ id: "package", condition: "Name and version match package.json", evidenceRequired: "Current package.json" }], nonGoals: ["Do not modify sources"] });

test("source-bound Critical can explain an unconfirmed request without manufacturing human acceptance", () => {
  const dialogue = prepareIntentDialogue({ task });
  const result = normalizeHostCritical({ input: critical(), task, dialogue });
  assert.equal(result.realIntent, critical().realIntent);
  assert.equal(dialogue.status, "not_supplied");
  assert.equal(dialogue.executionAllowed, false);
  assert.equal(dialogue.nativeInvocationVerified, false);
  for (const realIntent of ["", " ", null, 7]) assert.throws(() => normalizeHostCritical({ input: { ...critical(), realIntent }, task, dialogue }), /Critical/);
  assert.throws(() => normalizeHostCritical({ input: { ...critical(), taskHash: taskOutcomeDigest("another task") }, task, dialogue }), /Critical/);
  assert.throws(() => normalizeHostCritical({ input: { ...critical(), evidenceRefs: [] }, task, dialogue }), /Critical/);
});

test("Critical cannot replace an already bound confirmed outcome", () => {
  assert.throws(() => normalizeHostCritical({ input: critical(), task, dialogue: { ...prepareIntentDialogue({ task }), status: "host_provided_understanding" } }), /Critical/);
});

test("Critical equality includes current intent as well as criteria and exclusions", () => {
  assert.equal(sameHostCriticalMeaning(critical(), { ...critical(), realIntent: "Publish a replacement package" }), false);
  assert.equal(sameHostCriticalMeaning(critical(), { ...critical(), nonGoals: [] }), false);
  assert.equal(sameHostCriticalMeaning(critical(), structuredClone(critical())), true);
});

test("worker context keeps host interpretation and non-goals while confirmation remains unproven", () => {
  const packet = bindIntentToWorkerTasks({ workerTaskPackets: [{ taskPacketId: "inspect", executionMode: "primary_execution", roleDisplayName: "backend", acceptanceCriterionIds: ["package"] }],
    routeResult: {}, dialogue: { ...prepareIntentDialogue({ task }), acceptanceCriteria: [{ id: "package", description: "Exact package metadata" }] }, critical: critical() })[0];
  assert.equal(packet.coreProblem, critical().realIntent);
  assert.equal(packet.intentBinding.confirmedOutcome, task);
  assert.equal(packet.intentBinding.status, "not_supplied");
  assert.ok(packet.nonGoals.includes("Do not modify sources"));
});

test("ordinary prepare and Thinking retain interpretation and reject silent intent replacement", async t => {
  const fixture = createGovernanceRuntimeFixtureScope(t);
  refreshFixtureSourcePins(fixture);
  const { runMetaTheoryGovernedExecution: run } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const request = "Read package.json and report its exact name; preserve source files.";
  const current = fixtureCritical({ task: request, outcome: "A source-bound report of the existing package name for this user.", successCriteria: ["The name matches the current package.json"], nonGoals: ["No edits or external calls"] });
  const options = { task: request, projectRoot: fixture.repoRoot, runtime: "codex", stateDir: "tmp/critical-continuation", dbPath: "tmp/critical-continuation.sqlite", projectCapabilityMutationMode: "read_only", governanceTaskFacts: readOnlyFixtureTaskFacts(request) };
  const prepared = await run({ ...options, runId: "critical-fetch", criticalInput: current });
  assert.equal(prepared.intentPacket.realIntent, current.realIntent);
  const thinkingInput = fixtureThinkingInput(prepared, { criticalInput: current, workOrders: preparation => [fixtureReadWorkOrder(preparation, { id: "inspect", todayTask: request, output: "Exact package name", criterionIds: ["user-outcome"], taskFacts: readOnlyFixtureTaskFacts(request) })] });
  const changed = structuredClone(thinkingInput); changed.intentPacket.realIntent = "Replace the package";
  await assert.rejects(run({ ...options, runId: "critical-rejected", thinkingInput: changed, previousPlanChallengeRunId: prepared.runId }), /Critical|intent/);
  const result = await run({ ...options, runId: "critical-planned", thinkingInput, previousPlanChallengeRunId: prepared.runId });
  assert.equal(result.intentPacket.realIntent, current.realIntent);
  assert.equal(result.workerTaskPackets[0].intentBinding.status, "host_provided_not_independently_verified");
  const message = JSON.parse(result.workerTaskPackets[0].runtimeInvocationPlan.message);
  assert.ok(JSON.stringify(message).includes(current.realIntent));
  assert.equal(result.stageRunnerBridgePacket, null);
});
