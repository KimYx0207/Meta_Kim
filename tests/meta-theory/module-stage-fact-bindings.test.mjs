import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { activateSpineState, createInitialState, readSpineState } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { taskProgressGoal } from "../../canonical/runtime-assets/shared/hooks/task-progress.mjs";
import { createLiveWorkspaceService } from "../../src/application/live/live-workspace-service.mjs";
import { createModuleStageFactExecutors } from "../../scripts/governed-execution/module-stage-fact-bindings.mjs";
import { buildStageDagPacket, moduleStageNodeId } from "../../scripts/governed-execution/stage-dag.mjs";
import { invokeModuleStageExecutor, resolveModuleStageExecutor } from "../../scripts/governed-execution/module-stage-execution.mjs";

const CHAT = "01900000-0000-7000-8000-000000000071";
const sha = value => createHash("sha256").update(value).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-stage-facts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  const initial = createInitialState({ activationMode: "hook_observed", driverMode: "hook_observed", hookGateMode: "advisory",
    sourceConversation: { runtime: "gemini", conversationId: CHAT, matchBasis: "transcript_file_verified" } });
  initial.currentStage = "thinking";
  initial.stages.critical.status = initial.stages.fetch.status = "completed";
  initial.stages.thinking.status = "in_progress";
  initial.criticalRecord = { realIntent: "Deliver two independent modules", successCriteria: ["Retain exact current evidence"], blockingUnknowns: [] };
  initial.fetchRecord = { evidence: ["Current project files"], decisionImpactMap: ["Keep the current source and task authority"],
    memoryStrategy: "project_only", capabilitySearchPerformed: true, capabilityDiscovery: { sources: ["current project"], matches: ["current host"] } };
  await activateSpineState(root, initial);
  const service = createLiveWorkspaceService({ projectRoot: root });
  const criterion = taskProgressGoal(initial.criticalRecord).criteria[0].criterionId;
  const modules = ["alpha", "beta"];
  await service.publishDesign({ runId: initial.runId, conversationId: CHAT, expectedRevision: 0,
    input: { schemaVersion: 1, design: { mode: "exploration", userJourneys: [], interfaces: [], sharedState: [],
      taskSlices: modules.map(id => ({ id: `task-${id}`, outcome: `Produce ${id}`, criterionIds: [criterion], dependsOn: [],
        verification: [{ criterionId: criterion, procedure: "Read actual output", expectedEvidence: "Current bytes" }] })),
      softwareDesign: { schemaVersion: 1, architecture: { id: "system", revision: 1, summary: "Two independent modules",
        decisionRefs: [], technologyChoices: [], constraints: [], moduleIds: modules }, modules: modules.map(id => ({ id, purpose: id,
        implementationNotes: "Keep the existing contracts", businessRules: ["Preserve identity"], states: [{ name: "ready", behavior: "Continue" }], taskIds: [`task-${id}`] })) } } } });
  for (const target of [null, "alpha"]) {
    const view = await service.getOverview({ runId: initial.runId });
    const review = view.reviews.find(item => item.moduleId === target);
    await service.review({ runId: initial.runId, decisionId: review.decisionId, artifactId: review.artifactId, version: review.version,
      expectedRevision: review.revision, expectedWorkspaceRevision: view.revision, choice: "accept", nonce: `stage-facts-${target || "outline"}` });
  }
  const fresh = await service.hostNextWork({ runId: initial.runId, conversationId: CHAT });
  const claim = await service.claimRequest({ runId: initial.runId, conversationId: CHAT, expectedRevision: fresh.revision, commandId: fresh.request.commandId });
  const host = { workOrder: claim.workOrder, evolutionDecision: { runId: initial.runId, decision: "none-with-reason", reason: "No reusable method change in this bounded task" } };
  const graph = buildStageDagPacket({ moduleScopePlan: claim.workOrder.moduleScopePlan,
    stageLanes: { Execution: modules.map(id => ({ laneId: `task-${id}`, laneKind: "execution_worker", effectClass: "read_only_analysis" })) } });
  const create = () => createModuleStageFactExecutors({ host, projectRoot: root, artifactRoot: path.join(root, ".meta-kim/work/stage-facts"), runtime: "gemini" });
  const invoke = async (executors, nodeId, runId = initial.runId) => {
    const node = graph.nodes.find(item => item.nodeId === nodeId);
    const executor = resolveModuleStageExecutor(executors, node);
    assert.ok(executor, executors[nodeId]?.reason);
    return invokeModuleStageExecutor({ executor, runId, stageDagPacket: graph, node, projectRoot: root, runtime: "gemini",
      claim: { attemptId: `attempt-${nodeId}`, fenceToken: 1 }, upstreamResults: [], relatedResults: [], workerTaskPackets: [] });
  };
  return { root, service, host, graph, create, invoke, runId: initial.runId };
}

test("existing Critical, Fetch and accepted module facts advance without repeated model calls or aggregate completion", async t => {
  const f = await fixture(t);
  const before = await readSpineState(f.root);
  const executors = await f.create();
  for (const id of ["scope:shared:architecture:gate", ...["Critical", "Fetch", "Thinking", "Evolution"].map(stage => moduleStageNodeId("alpha", stage))]) {
    const result = await f.invoke(executors, id);
    assert.equal(result.stageVerdict, "pass"); assert.equal(result.nativeInvocationVerified, false);
    const evidence = result.stageReceipt.evidenceRefs[0];
    const bytes = await readFile(path.join(f.root, evidence.ref));
    assert.equal(sha(bytes), evidence.sha256);
    assert.equal(JSON.parse(bytes).workspaceRunId, f.runId);
    assert.equal(result.stageReceipt.hostObservation.evidenceKind, "current_state_facts");
  }
  assert.deepEqual(await readSpineState(f.root), before, "facts never complete the aggregate spine or consume another approval");
  assert.equal(before.liveWorkspace.designStatus, "in_progress");
  assert.equal(executors.Review, undefined); assert.equal(executors.Verification, undefined);
});

test("changed Decision, foreign workspace and missing Fetch facts cannot be replaced by a self-declared pass", async t => {
  const f = await fixture(t);
  const executors = await f.create();
  const view = await f.service.getOverview({ runId: f.runId }), target = view.design.modules[0];
  await f.service.feedback({ runId: f.runId, moduleId: "alpha", artifactId: target.artifactId, version: target.version,
    original: "Recheck this exact implementation contract", expectedWorkspaceRevision: view.revision, nonce: "changed-fact-binding" });
  await assert.rejects(f.invoke(executors, moduleStageNodeId("alpha", "Thinking")), /review|binding/u);
  const refreshed = await f.create();
  assert.equal(resolveModuleStageExecutor(refreshed, f.graph.nodes.find(node => node.nodeId === moduleStageNodeId("alpha", "Thinking"))), null);
  const original = f.host.workOrder.profile;
  f.host.workOrder.profile = "foreign";
  await assert.rejects(f.create(), /workspace_required/u);
  f.host.workOrder.profile = original;
  const state = await readSpineState(f.root), next = structuredClone(state);
  next.fetchRecord.capabilitySearchPerformed = false;
  await f.service.repository.writeState(state, next);
  assert.equal((await f.create())[moduleStageNodeId("alpha", "Fetch")].ready, false);
});

test("new kernel revisions need explicit current workspace context; Evolution needs its existing inline decision", async t => {
  const f = await fixture(t), executors = await f.create();
  const id = moduleStageNodeId("alpha", "Critical");
  await assert.rejects(f.invoke(executors, id, "revised-kernel-run"), /new_run_context_required/u);
  f.host.moduleRunContext = { runId: "revised-kernel-run", workspaceRunId: f.runId, previousRunId: f.runId, designDigest: "a".repeat(64) };
  assert.equal((await f.invoke(executors, id, "revised-kernel-run")).stageVerdict, "pass");
  delete f.host.evolutionDecision;
  const missing = await f.create();
  assert.equal(missing[moduleStageNodeId("alpha", "Evolution")].ready, false);
  f.host.evolutionDecision = { runId: f.runId, decision: "writeback", reason: "A reusable method changed" };
  assert.equal((await f.create())[moduleStageNodeId("alpha", "Evolution")], undefined, "triggered Evolution retains its professional path");
});

