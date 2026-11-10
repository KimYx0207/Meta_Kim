import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { advanceGovernedGoal } from "../../scripts/governed-execution/advance-goal.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { buildStageDagPacket, stageLaneNodeId } from "../../scripts/governed-execution/stage-dag.mjs";
import { evaluateProductOutcomeReview } from "../../scripts/governed-execution/product-design.mjs";
import { componentHash, discoverDependencyAgentContracts, loadDependencyAgentMethod, stableJson, sha256 } from "../../scripts/dependency-agent-discovery.mjs";
import { buildTaskGoalContract } from "../../src/domain/governance/task-outcome.mjs";
import { checkedTaskProgress, recordTaskProgress, taskProgressGoal } from "../../canonical/runtime-assets/shared/hooks/task-progress.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Reopening a consumer acquires/releases a scheduler lease. That coordination
// history must not be confused with replayed task progress or outcome reviews.
const businessEvents = (context) => context.kernel.getEvents(context.runId).filter((event) => !event.eventType.startsWith("RunCoordinator"));

/** Temporary kernel and discovery-only contract; no CLI, model, Graph or user data. */
async function fixture(t, taskIds = ["a"], { criterionIds = ["report"] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-durable-progress-"));
  let context;
  t.after(async () => { context?.kernel?.close(); await fs.rm(root, { recursive: true, force: true }); });
  const projectRoot = path.join(root, "project");
  const serviceRoot = path.join(root, "service");
  const componentPath = "agents/progress-reviewer";
  const componentRoot = path.join(serviceRoot, componentPath);
  await fs.mkdir(projectRoot);
  await fs.mkdir(componentRoot, { recursive: true });
  const capability = { id: "progress-review", summary: "Read-only progress report", useWhen: ["Review progress material"], doNotUseWhen: ["Implement or deploy"],
    input: { type: "object", required: ["facts"], properties: { facts: { type: "string" } } },
    output: { type: "object", required: ["draft"], properties: { draft: { type: "string" } } },
    permissions: ["filesystem:read-user-materials"], sideEffects: [], humanGate: { required: false, when: [] }, validation: ["check.mjs"] };
  const contract = { schemaVersion: 1, id: "progress-reviewer", componentType: "agent", componentVersion: "0.1.0", entrypoint: "AGENT.md", capabilities: [capability] };
  await fs.writeFile(path.join(componentRoot, "AGENT.md"), "---\nname: progress-reviewer\ndescription: Read-only progress report\ntools: Read\n---\nCompare the supplied material only. Discovery fixture, not native invocation.\n");
  await fs.writeFile(path.join(componentRoot, "capability.json"), stableJson(contract));
  await fs.writeFile(path.join(componentRoot, "method.json"), stableJson({ schemaVersion: 1, roleId: "progress-reviewer", protocol: "host-bound-task-method-v1",
    steps: ["Read supplied material"], acceptance: ["Return the bounded report"], automaticInvocation: false, finalAcceptance: "caller_only" }));
  await fs.writeFile(path.join(componentRoot, "check.mjs"), 'throw new Error("Discovery must not execute validation");\n');
  const component = { id: contract.id, componentType: "agent", componentVersion: "0.1.0", path: componentPath, entrypoint: "AGENT.md",
    capabilityIds: [capability.id], validation: capability.validation, contentSha256: await componentHash(componentRoot), contractSha256: sha256(stableJson(contract)) };
  await fs.mkdir(path.join(serviceRoot, "generated"));
  await fs.writeFile(path.join(serviceRoot, "generated/capabilities.json"), stableJson({ schemaVersion: 1, componentCount: 1, capabilityCount: 1, components: [component],
    capabilities: [{ ...capability, componentId: component.id, componentType: component.componentType, componentVersion: component.componentVersion,
      componentPath, entrypoint: component.entrypoint, componentContentSha256: component.contentSha256, contractSha256: component.contractSha256 }] }));
  const env = { ...process.env, META_KIM_KIM_SERVICE_ROOT: serviceRoot };
  const { projects } = JSON.parse(await fs.readFile(new URL("../../config/capability-index/dependency-project-registry.json", import.meta.url), "utf8"));
  const discovery = await discoverDependencyAgentContracts({ projects: projects.filter((entry) => entry.id === "kim-service"), projectRoot, environment: env });
  const owner = discovery.agents.find((entry) => entry.id === "kim-service:progress-reviewer");
  assert.ok(owner, JSON.stringify(discovery));
  const packets = taskIds.map((id) => ({ taskPacketId: id, logicalTaskPacketId: id.startsWith("a") ? "logical-a" : id,
    ownerAgent: owner.id, ownerSource: "dependency_agent_contract", ownerSourceRef: owner.sourceRef,
    ownerContract: owner.ownerContract, ownerBindingMode: "run_scoped_owner_contract", methodCapabilityId: capability.id,
    methodInputs: { facts: "fixed source facts" }, acceptanceCriterionIds: criterionIds,
    todayTask: "Review the exact supplied source facts", externalWriteBoundary: false, dependsOn: [] }));
  const goal = buildTaskGoalContract({ task: "Review the supplied source facts accurately", acceptanceCriteria: [
    { id: "report", description: "The report agrees with source facts", kind: "semantic", required: true }] });
  const graph = buildStageDagPacket({ stageOrder: ["Execution"], runtimeCapacity: 1, stageLanes: { Execution: packets.map((packet) => ({
    laneId: packet.taskPacketId, laneKind: "execution_worker", ownerBindingRef: packet.ownerAgent,
    capabilityBindingRef: capability.id, effectClass: "read_only_worker", resourceScopes: [], isolation: "shared_read_only" })) } });
  context = { runId: "durable-task-progress", projectRoot, env, packets, goal, graph,
    goalProgress: taskProgressGoal({ realIntent: goal.contractFields.outcome, successCriteria: goal.acceptanceCriteria }),
    dbPath: path.join(root, "kernel.sqlite"), taskFingerprint: "fixture:durable-task-progress", admissions: [], invoked: 0 };
  context.kernel = await openDurableRunKernel(context.dbPath);
  context.method = await loadDependencyAgentMethod({ packet: packets[0], environment: env, projectRoot });
  context.host = { ownerId: "fixture-host", adapterId: "fixture-adapter", authorize: async ({ node }) => {
    if (!node) return { status: "ready" };
    context.admissions.push(node.nodeId); return { status: "waiting", reason: "fixture_before_dispatch" };
  }, adapterRegistry: { invoke: async () => { context.invoked += 1; throw new Error("synthetic_transport_failure"); } } };
  context.advance = (extra = {}) => advanceGovernedGoal({ runId: context.runId, goalContract: goal, stageDagPacket: graph,
    workerTaskPackets: packets, projectRoot, artifactRoot: path.join(projectRoot, "artifacts"), runtime: "codex",
    host: context.host, kernel: context.kernel, taskFingerprint: context.taskFingerprint, env, ...extra });
  context.reopen = async () => { context.kernel.close(); context.kernel = await openDurableRunKernel(context.dbPath); };
  context.kernel.createRun({ runId: context.runId, graphDigest: graph.graphDigest, taskFingerprint: context.taskFingerprint });
  return context;
}

function claim(context, packet) {
  return context.kernel.claimNode({ runId: context.runId, nodeId: stageLaneNodeId("Execution", packet.taskPacketId), ownerId: context.host.ownerId,
    nodeDefinitionHash: "fixture:definition", inputHash: "fixture:input", dependencyOutputHash: "fixture:upstream", leaseMs: 30_000 });
}

function fixtureObservation(context, packet, attempt, classification, extra = {}) {
  const selected = { ...packet, weapon: context.host.adapterId, capabilityId: context.method.capabilityId, methodCapabilityId: context.method.capabilityId,
    strategyRef: { id: context.method.sourceRef, ref: context.method.sourceRef, sha256: context.method.methodSha256 } };
  const observation = checkedTaskProgress({ attemptId: attempt.attemptId, criterionId: "report", classification,
    basisEvidence: [{ ref: context.method.sourceRef, sha256: context.method.contentDigest },
      { ref: "fixture:input", sha256: digest({ methodInputs: packet.methodInputs, upstream: [] }) }], evidenceRefs: ["fixture:kernel-claim"], ...extra }, selected, context.goalProgress);
  let ledger;
  for (const event of context.kernel.getEvents(context.runId).filter((entry) => entry.eventType === "TaskProgressObserved")) {
    ledger = recordTaskProgress(ledger, event.payload.observation).ledger;
  }
  const reduced = recordTaskProgress(ledger, observation);
  context.kernel.appendEvent({ runId: context.runId, eventId: `fixture-progress:${reduced.eventId}:${classification}`, eventType: "TaskProgressObserved",
    payload: { binding: { taskFingerprint: context.taskFingerprint, graphDigest: context.graph.graphDigest, projectRoot: context.projectRoot, runtime: "codex" }, packet: selected, observation } });
}

async function completeFixture(context, packet, attempt, { waiting = false } = {}) {
  const ref = `${packet.taskPacketId}.json`;
  const text = JSON.stringify({ draft: "bounded report", status: "partial", handoff: { requiresDecision: waiting, nextOwner: packet.ownerAgent } });
  await fs.writeFile(path.join(context.projectRoot, ref), text);
  const output = { attemptId: attempt.attemptId, taskPacketId: packet.taskPacketId, outputSha256: sha256(text),
    domainOutput: JSON.parse(text), machineResultArtifact: { path: path.join(context.projectRoot, ref), sha256: sha256(text), bytes: Buffer.byteLength(text) } };
  context.kernel.completeNode({ ...attempt, runId: context.runId, nodeId: stageLaneNodeId("Execution", packet.taskPacketId), ownerId: context.host.ownerId, output });
  return { ref, hash: output.outputSha256 };
}

function reviewed(context, packet, artifact, verdict, reviewRef) {
  return evaluateProductOutcomeReview({ projectRoot: context.projectRoot,
    artifact: { runId: context.runId, goalContractPacket: context.goal, workerTaskPackets: context.packets },
    input: { schemaVersion: 1, runId: context.runId, taskHash: context.goal.taskHash, intentDigest: null, acceptanceDigest: context.goal.acceptanceDigest,
      designDigest: null, reviewRef, artifactSnapshots: [{ ref: artifact.ref, sha256: artifact.hash, producerTaskId: packet.taskPacketId }],
      observations: [{ criterionId: "report", taskHash: context.goal.taskHash, acceptanceDigest: context.goal.acceptanceDigest,
        verdict, artifactRefs: [artifact.ref], evidenceKind: "independent_review", producer: "fixture-producer", reviewer: "fixture-reviewer", evidenceRef: reviewRef }], revisionRequests: [] } });
}

test("durable task progress closes a failed invocation without counting semantic failure and admits explicit recovery", async (t) => {
  const context = await fixture(t);
  context.host.authorize = async () => ({ status: "ready" });
  const first = await context.advance();
  assert.equal(first.reason, "synthetic_transport_failure");
  assert.equal(first.taskProgress.tasks[0].unresolvedAttempts, 1);
  assert.equal(first.taskProgress.tasks[0].terminalAttempts, 0);
  assert.equal(first.taskProgress.tasks[0].ineffectiveAttempts, 0);
  const blocked = await context.advance();
  assert.equal(blocked.reason, "prior_attempt_requires_explicit_recovery");
  assert.equal(context.invoked, 1, "A transport failure does not authorize an automatic retry");
  const recovery = claim(context, context.packets[0]);
  fixtureObservation(context, context.packets[0], recovery, "running");
  await completeFixture(context, context.packets[0], recovery);
  await context.reopen();
  const restored = await context.advance();
  assert.notEqual(restored.reason, "prior_attempt_requires_explicit_recovery");
  assert.equal(context.invoked, 1, "Completed recovery is retained without duplicate invocation");
  assert.equal(restored.taskProgress.tasks[0].unresolvedAttempts, 1);
});

test("durable task progress reconciles a failed attempt after restart without replay inflation", async (t) => {
  const context = await fixture(t);
  const attempt = claim(context, context.packets[0]);
  fixtureObservation(context, context.packets[0], attempt, "running");
  context.kernel.failNode({ ...attempt, runId: context.runId, nodeId: stageLaneNodeId("Execution", "a"), ownerId: context.host.ownerId,
    failure: { failureClass: "transport_failure", failureMessage: "synthetic crash before progress settlement" } });
  await context.reopen();
  const first = await context.advance();
  assert.equal(first.taskProgress.tasks[0].unresolvedAttempts, 1);
  const eventCount = businessEvents(context).length;
  const replay = await context.advance();
  assert.equal(replay.taskProgress.tasks[0].unresolvedAttempts, 1);
  assert.equal(businessEvents(context).length, eventCount);
});

test("durable task progress deduplicates reviewed attempts and rejects conflicting terminal review before persistence", async (t) => {
  const context = await fixture(t);
  const attempt = claim(context, context.packets[0]);
  fixtureObservation(context, context.packets[0], attempt, "running");
  const artifact = await completeFixture(context, context.packets[0], attempt);
  const failure = await reviewed(context, context.packets[0], artifact, "fail", "fixture:failure-review");
  const first = await context.advance({ outcomeReview: failure });
  assert.equal(first.taskProgress.tasks[0].ineffectiveAttempts, 1);
  const eventCount = businessEvents(context).length;
  await context.reopen();
  const replay = await context.advance({ outcomeReview: failure });
  assert.equal(replay.taskProgress.tasks[0].ineffectiveAttempts, 1);
  assert.equal(businessEvents(context).length, eventCount);
  const conflicting = await reviewed(context, context.packets[0], artifact, "pass", "fixture:conflicting-review");
  await assert.rejects(context.advance({ outcomeReview: conflicting }), /task_progress_attempt_conflict/);
  assert.equal(businessEvents(context).length, eventCount, "Rejected terminal reclassification must not poison stored review history");
});

test("durable task progress blocks only the repeated logical task while independent ready work stays admitted", async (t) => {
  const context = await fixture(t, ["a-first", "a-second", "a-next", "b"]);
  const firstAttempt = claim(context, context.packets[0]);
  fixtureObservation(context, context.packets[0], firstAttempt, "running");
  const firstArtifact = await completeFixture(context, context.packets[0], firstAttempt);
  await context.advance({ outcomeReview: await reviewed(context, context.packets[0], firstArtifact, "fail", "fixture:first-review") });
  const secondAttempt = claim(context, context.packets[1]);
  fixtureObservation(context, context.packets[1], secondAttempt, "running");
  const secondArtifact = await completeFixture(context, context.packets[1], secondAttempt);
  context.admissions.length = 0;
  const second = await context.advance({ outcomeReview: await reviewed(context, context.packets[1], secondArtifact, "fail", "fixture:second-review") });
  assert.equal(second.nextAction.reason, "same_basis_ineffective_attempts_require_task_correction");
  assert.equal(second.nextAction.stage, "Thinking");
  assert.deepEqual(context.admissions, [stageLaneNodeId("Execution", "b")]);
  assert.equal(second.taskProgress.tasks.find((item) => item.logicalTaskPacketId === "logical-a").sameBasisIneffectiveCount, 2);
  assert.equal(context.invoked, 0);
});

test("durable task progress excludes a real decision wait and preserves independent ready work", async (t) => {
  const context = await fixture(t, ["a", "b"]);
  const attempt = claim(context, context.packets[0]);
  fixtureObservation(context, context.packets[0], attempt, "running");
  await completeFixture(context, context.packets[0], attempt, { waiting: true });
  fixtureObservation(context, context.packets[0], attempt, "waiting", { waitReason: "professional_result_requires_input_or_decision" });
  const result = await context.advance();
  assert.deepEqual(context.admissions, [stageLaneNodeId("Execution", "b")]);
  assert.equal(result.taskProgress.tasks[0].terminalAttempts, 0);
  assert.deepEqual(result.taskProgress.tasks[0].pendingCorrections, []);
  assert.equal(context.invoked, 0);
});

test("durable task progress reports an unassigned criterion as not observed rather than inventing counters", async (t) => {
  const context = await fixture(t, ["a"], { criterionIds: [] });
  context.host.authorize = async () => ({ status: "ready" });
  const result = await context.advance();
  assert.equal(result.taskProgress.tasks[0].coverage, "not_observed");
  assert.equal(result.taskProgress.tasks[0].terminalAttempts, 0);
  assert.equal(context.kernel.getEvents(context.runId).filter((event) => event.eventType === "TaskProgressObserved").length, 0);
});
