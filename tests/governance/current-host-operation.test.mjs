import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { createHostMethodSourceFixture } from "../helpers/host-method-source-fixture.mjs";
import { createProjectProfessionalFixture, persistProjectProfessionalFixture } from "../helpers/project-professional-fixture.mjs";
import { fixtureCritical, fixtureThinkingInput, fixtureReadWorkOrder, refreshFixtureSourcePins } from "../helpers/host-reasoning-fixture.mjs";
import { localProtocolFixtureTaskFacts } from "../helpers/task-design-facts.mjs";
import { prepareReadOnlyRuntimeInvocation } from "../../scripts/governed-execution/stage-runner-bridge.mjs";

const task = "Prepare a bounded correction in package.json with the selected source method; the current host owns actual execution.";
async function prepare(t) {
  const fixture = createGovernanceRuntimeFixtureScope(t); refreshFixtureSourcePins(fixture);
  const service = createHostMethodSourceFixture(path.join(fixture.root, "service"));
  const projectProfessional = createProjectProfessionalFixture(fixture.repoRoot);
  process.env.META_KIM_KIM_SERVICE_ROOT = service.root;
  const { runMetaTheoryGovernedExecution: run } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const criticalInput = fixtureCritical({ task, successCriteria: ["The package remains valid and the requested correction is evidenced"], nonGoals: ["No publishing or native invocation claims"] });
  const base = { task, runtime: "codex", projectRoot: fixture.repoRoot, stateDir: "tmp/host-operation", dbPath: "tmp/host-operation.sqlite", projectCapabilityMutationMode: "read_only", criticalInput, governanceTaskFacts: localProtocolFixtureTaskFacts(task) };
  const prepared = await run({ ...base, runId: "operation-fetch" });
  const owner = prepared.fetchPacket.capabilityDiscovery.agents.find(p => p.id === "kim-service:package-analyst"); assert.ok(owner);
  const projectOwner = prepared.fetchPacket.capabilityDiscovery.agents.find(p => p.id === projectProfessional.id && p.source === "project_runtime_agent_inventory"); assert.ok(projectOwner);
  persistProjectProfessionalFixture(fixture.repoRoot, projectOwner, projectProfessional);
  const workOrder = fixtureReadWorkOrder(prepared, { id: "correction", todayTask: task, output: "Bounded package correction", criterionIds: ["user-outcome"], selectedProviders: { agent: projectOwner, methodAgent: owner }, taskFacts: localProtocolFixtureTaskFacts(task) });
  Object.assign(workOrder, { effectClass: "local_write", projectCapabilityIntent: { mode: "project_owned" }, methodCapabilityId: "package-analyst-deliver", methodInputs: { facts: "Current package.json is the supplied source" }, toolRequirements: ["exec_command", "apply_patch"] });
  workOrder.hostOperation = { schemaVersion: "current-host-operation-request-v1", executionOwner: "current_host", operation: "create_or_update", taskHash: criticalInput.taskHash, roleInstanceId: workOrder.roleInstanceId, scopeFiles: [...workOrder.scopeFiles],
    methodSource: { ownerAgent: owner.id, sourceRef: owner.sourceRef, contentDigest: owner.contentDigest, componentContentSha256: owner.ownerContract.componentContentSha256, capabilityId: workOrder.methodCapabilityId },
    requestedTools: [{ slot: "repository.read", tool: "exec_command" }, { slot: "repository.patch", tool: "apply_patch" }] };
  let sequence = 0;
  const execute = (order = workOrder, extra = {}) => run({ ...base, runId: "operation-plan-" + ++sequence, previousPlanChallengeRunId: prepared.runId, ...extra,
    thinkingInput: fixtureThinkingInput(prepared, { criticalInput, workOrders: () => Array.isArray(order) ? order : [order] }) });
  return { fixture, service, base, prepared, workOrder, execute };
}

test("explicit current-host local operation prepares source-bound work without borrowing method permissions", async t => {
  const { execute } = await prepare(t); const result = await execute(); const packet = result.workerTaskPackets[0];
  assert.ok(packet, JSON.stringify(result.capabilityGapPacket));
  assert.equal(packet.workOrderReadiness, "ready");
  assert.equal(packet.executionOwner, "current_host");
  assert.equal(packet.hostOperation.status, "ready_for_host_binding");
  assert.equal(packet.hostOperation.executionAuthorized, false);
  assert.equal(packet.hostOperation.canEnterExecution, false);
  assert.equal(packet.hostOperation.nativeInvocationVerified, false);
  assert.equal(packet.ownerAgent, "package-maintainer");
  assert.equal(packet.methodOwner.id, "kim-service:package-analyst");
  assert.ok(packet.hostOperation.requestedTools.every(tool => tool.availability === "not_observed" && tool.authorization === "not_observed"));
  for (const text of [packet.runtimeInvocationPlan.message, packet.runtimeInvocationPlan.followupTaskTemplate.message]) {
    const message = JSON.parse(text);
    assert.match(message.projectCapabilityBinding.ownerSource.content, /Preserve dependency versions/u);
    assert.match(message.projectCapabilityBinding.materials[0].content, /documented release version/u);
    assert.equal(message.hostOperation.status, packet.hostOperation.status);
    assert.ok(message.professionalMethod.includes('"status":"ready_for_host_binding"'), "Nested method context matches final work-order readiness");
    assert.doesNotMatch(message.professionalMethod, /"executionAuthorized":true/);
  }
  assert.equal(result.stageRunnerBridgePacket, null);
});

test("source, task, scope or invented authorization cannot widen current-host preparation", async t => {
  const { execute, workOrder } = await prepare(t);
  for (const mutate of [order => { delete order.hostOperation; }, order => { order.hostOperation.taskHash = "0".repeat(64); }, order => { order.hostOperation.scopeFiles = ["AGENTS.md"]; },
    order => { order.hostOperation.methodSource.contentDigest = "0".repeat(64); }, order => { order.hostOperation.requestedTools[0].authorization = "granted"; }]) {
    const changed = structuredClone(workOrder); mutate(changed);
    const result = await execute(changed);
    assert.deepEqual(result.workerTaskPackets, []);
  }
});

test("missing current-host method facts block every nested readiness view", async t => {
  const { execute, workOrder } = await prepare(t); workOrder.methodInputs = {};
  const result = await execute(); const packet = result.workerTaskPackets[0]; assert.ok(packet);
  assert.equal(packet.workOrderReadiness, "incomplete");
  assert.equal(packet.hostOperation.status, "blocked");
  for (const text of [packet.runtimeInvocationPlan.message, packet.runtimeInvocationPlan.followupTaskTemplate.message]) {
    const message = JSON.parse(text); assert.equal(message.hostOperation.status, "blocked");
    assert.ok(message.professionalMethod.includes('"status":"blocked"'));
  }
});

test("read-only runtime preparation refuses a current-host operation before constructing any subprocess request", async () => {
  await assert.rejects(prepareReadOnlyRuntimeInvocation({ runtime: "codex", workspaceRoot: process.cwd(), packet: { hostOperation: { executionOwner: "current_host" } }, prompt: "Transport test only" }), /current.host|host.operation/i);
});

test("ordinary machine executor refuses host operations without calling its supplied adapter or authorization port", async t => {
  const { execute, workOrder } = await prepare(t); let calls = 0;
  const result = await execute(workOrder, { stageRunner: { enabled: true,
    adapterRegistry: { invoke: async () => { calls++; throw new Error("must not run"); } },
    authorize: async () => { calls++; throw new Error("must not authorize"); } } });
  assert.equal(result.machineExecution.reason, "current_host_operation_requires_actual_host_binding");
  assert.equal(calls, 0);
});

test("a retained read-only reviewer depends on the exact projected writer identity", async t => {
  const { execute, workOrder, prepared, base } = await prepare(t);
  const reviewer = structuredClone(workOrder); delete reviewer.hostOperation;
  Object.assign(reviewer, { roleInstanceId: "Review_UPPER", effectClass: "read_only_worker", toolRequirements: [], dependsOn: [workOrder.roleInstanceId] });
  const designInput = { schemaVersion: 1, taskHash: base.criticalInput.taskHash, intentDigest: null, acceptanceDigest: prepared.goalContractPacket.acceptanceDigest,
    designId: "bounded-package-change", revision: 1, mode: "delivery", sourceRefs: ["package.json"], settledDecisionRefs: [], domainTerms: [], userJourneys: [], artifactFlow: [],
    taskSlices: [{ id: workOrder.roleInstanceId, outcome: workOrder.todayTask, capabilityNeed: workOrder.capabilityNeed, scopeFiles: ["package.json"], inputRefs: ["package.json"], criterionIds: ["user-outcome"], dependsOn: [], journeyRefs: [], decisionRefs: [],
      deliverables: [{ id: "package", description: workOrder.output, consumer: "User" }], verification: [{ criterionId: "user-outcome", procedure: "Check the package", expectedEvidence: "Current valid package source" }],
      completionDemo: "Read corrected package metadata", methodCapabilityId: workOrder.methodCapabilityId, methodInputs: workOrder.methodInputs, taskFacts: workOrder.taskFacts }] };
  const result = await execute([workOrder, reviewer], { designInput });
  const writer = result.workerTaskPackets.find(packet => packet.roleInstanceId === workOrder.roleInstanceId);
  const read = result.workerTaskPackets.find(packet => packet.roleInstanceId === reviewer.roleInstanceId);
  assert.ok(writer && read, JSON.stringify(result.capabilityGapPacket));
  assert.deepEqual(read.dependsOn, [writer.taskPacketId]);
  assert.equal(writer.workOrderReadiness, "ready");
  assert.equal(read.workOrderReadiness, "ready");
  assert.deepEqual(JSON.parse(read.runtimeInvocationPlan.message).coordination.dependsOn, [writer.taskPacketId]);
});

test("a projected read-only design keeps checked scope, method inputs and dependencies", async t => {
  const { execute, workOrder, prepared, base, fixture } = await prepare(t);
  const reviewer = structuredClone(workOrder); delete reviewer.hostOperation;
  Object.assign(reviewer, { roleInstanceId: "Review_BOUNDARY", effectClass: "read_only_worker", toolRequirements: [], dependsOn: [workOrder.roleInstanceId] });
  const slice = order => ({ id: order.roleInstanceId, outcome: order.todayTask, capabilityNeed: order.capabilityNeed,
    scopeFiles: ["package.json"], inputRefs: ["package.json"], criterionIds: ["user-outcome"], dependsOn: order.dependsOn,
    journeyRefs: [], decisionRefs: [], deliverables: [{ id: order.roleInstanceId + "-result", description: order.output, consumer: "User" }],
    verification: [{ criterionId: "user-outcome", procedure: "Check the package", expectedEvidence: "Current valid package source" }],
    completionDemo: "Read corrected package metadata", methodCapabilityId: order.methodCapabilityId, methodInputs: order.methodInputs, taskFacts: order.taskFacts,
    ...(order.dependsOn.length ? { dependencyReasons: order.dependsOn.map(taskId => ({ taskId, reason: "Read the current result after its writer" })) } : {}) });
  const source = { schemaVersion: 1, taskHash: base.criticalInput.taskHash, intentDigest: null,
    acceptanceDigest: prepared.goalContractPacket.acceptanceDigest, designId: "source-bound-design", revision: 1, mode: "delivery",
    sourceRefs: ["package.json"], settledDecisionRefs: [], domainTerms: [], userJourneys: [], artifactFlow: [], taskSlices: [slice(workOrder), slice(reviewer)] };
  for (const change of [row => { row.scopeFiles = [path.join(fixture.root, "outside-design-scope.txt")]; },
    row => { row.methodInputs = { facts: "Unchecked substituted method input" }; },
    row => { row.dependsOn = []; row.dependencyReasons = []; }]) {
    const designInput = structuredClone(source); change(designInput.taskSlices[1]);
    const result = await execute([workOrder, reviewer], { designInput });
    const packet = result.workerTaskPackets.find(item => item.roleInstanceId === reviewer.roleInstanceId);
    assert.equal(packet.workOrderReadiness, "incomplete");
    assert.equal(result.selectedExecutionRoute.routeExecutionGate.canHandoffToHost, false);
    assert.deepEqual(packet.scopeFiles, [path.join(fixture.repoRoot, "package.json")]);
    assert.deepEqual(packet.methodInputs, reviewer.methodInputs);
    const message = JSON.parse(packet.runtimeInvocationPlan.message);
    assert.equal(message.workOrderReadiness, "incomplete");
    assert.deepEqual(message.scope.scopeFiles, packet.scopeFiles);
  }
  const allowed = await execute([workOrder, reviewer], { designInput: source });
  const packet = allowed.workerTaskPackets.find(item => item.roleInstanceId === reviewer.roleInstanceId);
  assert.equal(packet.effectClass, "read_only_worker");
  assert.equal(packet.workOrderReadiness, "ready");
  assert.equal(JSON.parse(packet.runtimeInvocationPlan.message).designContext.designId, source.designId);
  assert.equal(JSON.parse(packet.runtimeInvocationPlan.followupTaskTemplate.message).designContext.digest, packet.designContext.digest);
  assert.equal(allowed.selectedExecutionRoute.routeExecutionGate.canHandoffToHost, true);
});
