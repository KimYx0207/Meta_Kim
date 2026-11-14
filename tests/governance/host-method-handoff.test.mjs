import assert from "node:assert/strict";
import test from "node:test";
import { rmSync, appendFileSync } from "node:fs";
import path from "node:path";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { createHostMethodSourceFixture } from "../helpers/host-method-source-fixture.mjs";
import { fixtureCritical, fixtureThinkingInput, fixtureReadWorkOrder, refreshFixtureSourcePins } from "../helpers/host-reasoning-fixture.mjs";
import { readOnlyFixtureTaskFacts } from "../helpers/task-design-facts.mjs";
import { taskIsExecutableWorker } from "../../scripts/governed-execution/fanout-policy.mjs";

const task = "Read package metadata and check source evidence in package.json, without editing sources.";
async function prepare(t, { removeUnselected = false } = {}) {
  const fixture = createGovernanceRuntimeFixtureScope(t); refreshFixtureSourcePins(fixture);
  const service = createHostMethodSourceFixture(path.join(fixture.root, "service"));
  if (removeUnselected) rmSync(path.join(service.root, "skills/unselected"), { recursive: true });
  process.env.META_KIM_KIM_SERVICE_ROOT = service.root;
  const { runMetaTheoryGovernedExecution: run } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const criticalInput = fixtureCritical({ task, successCriteria: ["The report matches package.json"] });
  const base = { task, runtime: "codex", projectRoot: fixture.repoRoot, stateDir: "tmp/method-handoff", dbPath: "tmp/method-handoff.sqlite", projectCapabilityMutationMode: "read_only", criticalInput, governanceTaskFacts: readOnlyFixtureTaskFacts(task) };
  const prepared = await run({ ...base, runId: "method-fetch" });
  const owner = prepared.fetchPacket.capabilityDiscovery.agents.find(p => p.id === "kim-service:package-analyst");
  assert.ok(owner, "Actual local component hashes must pass discovery");
  const workOrder = fixtureReadWorkOrder(prepared, { id: "inspect", todayTask: task, output: "Source report", criterionIds: ["user-outcome"], selectedProviders: { agent: owner }, taskFacts: readOnlyFixtureTaskFacts(task) });
  Object.assign(workOrder, { methodCapabilityId: "package-analyst-deliver", methodInputs: { facts: "Current package.json is the factual input" } });
  const execute = (current = workOrder, id = "method-plan") => run({ ...base, runId: id, previousPlanChallengeRunId: prepared.runId,
    thinkingInput: fixtureThinkingInput(prepared, { criticalInput, workOrders: () => [current] }) });
  return { fixture, service, prepared, workOrder, execute };
}

test("ordinary initial and followup messages include actual selected Agent method and knowledge", async t => {
  const { execute } = await prepare(t);
  const result = await execute(); const packet = result.workerTaskPackets[0];
  assert.ok(packet, JSON.stringify(result.orchestrationReport?.selectedExecutionRoute ?? result.capabilityGapPacket ?? result.coreLoop?.thinkingPacket));
  assert.equal(packet.methodHandoff?.methodInputStatus, "ready");
  for (const text of [packet.runtimeInvocationPlan.message, packet.runtimeInvocationPlan.followupTaskTemplate.message]) {
    const message = JSON.parse(text);
    assert.match(message.professionalMethod, /SOURCE_METHOD:package-analyst/);
    assert.match(message.professionalMethod, /METHOD_STEP:package-analyst/);
    assert.match(message.professionalMethod, /KNOWLEDGE:package-analyst/);
    assert.equal(message.methodHandoff.invocationStatus, "not_invoked");
  }
  assert.equal(result.stageRunnerBridgePacket, null);
});

test("missing method input blocks the final packet, both ordinary messages and fanout", async t => {
  const { workOrder, execute } = await prepare(t); workOrder.methodInputs = {};
  const result = await execute(); const packet = result.workerTaskPackets[0];
  assert.equal(packet.workOrderReadiness, "incomplete");
  assert.equal(packet.methodHandoff.methodInputStatus, "needs_input");
  assert.equal(taskIsExecutableWorker(packet), false);
  for (const text of [packet.runtimeInvocationPlan.message, packet.runtimeInvocationPlan.followupTaskTemplate.message]) assert.equal(JSON.parse(text).workOrderReadiness, "incomplete");
  assert.equal(result.selectedExecutionRoute.routeExecutionGate.canHandoffToHost, false);
});

test("ordinary Fetch lists declared Skill index candidates without opening unselected bodies", async t => {
  const { prepared, workOrder, execute } = await prepare(t, { removeUnselected: true });
  const skill = prepared.fetchPacket.capabilityDiscovery.providers.find(p => p.id === "kim-service:source-check-deliver");
  assert.ok(skill, "Declared dependency Skill must be discoverable from its index");
  assert.equal(skill.skillContract.sourceVerification, "index_only");
  workOrder.selectedCapabilityProviders.skill = skill;
  workOrder.methodKnowledgeAssetIds = ["package-analyst-optional"];
  const result = await execute(); const packet = result.workerTaskPackets[0];
  assert.equal(packet.methodHandoff.methodInputStatus, "ready", "A supporting Skill does not inherit the primary facts or optional asset IDs");
  const message = JSON.parse(packet.runtimeInvocationPlan.message);
  assert.match(message.professionalMethod, /SOURCE_METHOD:source-check/);
  assert.match(message.professionalMethod, /OPTIONAL_KNOWLEDGE:package-analyst/);
  assert.doesNotMatch(message.professionalMethod, /OPTIONAL_KNOWLEDGE:source-check/);
});

test("an explicitly selected Skill can own method inputs while the discovered Agent remains execution owner", async t => {
  const { prepared, workOrder, execute } = await prepare(t);
  const skill = prepared.fetchPacket.capabilityDiscovery.providers.find(p => p.id === "kim-service:source-check-deliver");
  assert.ok(skill);
  workOrder.selectedCapabilityProviders.skill = skill;
  workOrder.selectedCapabilityProviders.agent = prepared.fetchPacket.capabilityDiscovery.agents.find(p => p.id === "backend" && p.runtime === "codex");
  workOrder.methodCapabilityId = skill.id; workOrder.methodInputs = { target: "package.json" };
  const result = await execute(); const packet = result.workerTaskPackets[0];
  assert.equal(packet.methodHandoff.capabilityId, skill.id);
  assert.equal(packet.methodHandoff.methodInputStatus, "ready");
  assert.match(JSON.parse(packet.runtimeInvocationPlan.message).professionalMethod, /METHOD_STEP:source-check/);
});

test("selected method source drift cannot become a ready ordinary work order", async t => {
  const { service, execute } = await prepare(t);
  appendFileSync(path.join(service.root, "agents/package-analyst/AGENT.md"), "changed source\n");
  const result = await execute();
  assert.deepEqual(result.workerTaskPackets, [], "A drifted binding remains an explicit capability gap");
});

test("fanout excludes explicitly incomplete and blocked operations while preserving legacy metadata-only packets", () => {
  assert.equal(taskIsExecutableWorker({ executionMode: "primary_execution", workOrderReadiness: "incomplete" }), false);
  assert.equal(taskIsExecutableWorker({ executionMode: "primary_execution", workOrderReadiness: "blocked" }), false);
  assert.equal(taskIsExecutableWorker({ executionMode: "primary_execution" }), true);
});
