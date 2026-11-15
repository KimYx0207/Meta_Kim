import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { activateSpineState, createInitialState, terminalizeSpineState } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { createLiveWorkspaceService } from "../../src/application/live/live-workspace-service.mjs";
import { buildTaskGoalContract } from "../../src/domain/governance/task-outcome.mjs";
import { discoverDependencyAgentContracts } from "../../scripts/dependency-agent-discovery.mjs";
import { buildStageDagPacket, moduleStageNodeId } from "../../scripts/governed-execution/stage-dag.mjs";
import { advanceGovernedGoal } from "../../scripts/governed-execution/advance-goal.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { createHostMethodSourceFixture } from "../helpers/host-method-source-fixture.mjs";
import { readOnlyWorkerPacket } from "../helpers/read-only-worker-packet.mjs";

const CHAT = "01900000-0000-7000-8000-000000000092";
const sha = value => createHash("sha256").update(value).digest("hex");

// Real Live review, files, claims and durable kernel; only professional calls
// use a controlled local transport. This is not native model certification.
async function fixture(t, entry, { aggregate = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-module-current-facts-"));
  await mkdir(path.join(root, ".git")); await mkdir(path.join(root, "outputs"));
  const artifactRoot = path.join(root, ".meta-kim/work/results");
  await mkdir(artifactRoot, { recursive: true });
  for (const id of ["outline", "alpha", "beta"]) await writeFile(path.join(root, `outputs/${id}.md`), `Reviewed ${id}\n`);
  const state = createInitialState({ activationMode: "hook_observed", driverMode: "hook_observed", hookGateMode: "advisory",
    sourceConversation: { runtime: "codex", conversationId: CHAT, matchBasis: "transcript_file_verified" } });
  state.recordOrigin = "acceptance_fixture"; state.currentStage = "thinking";
  state.stages.critical.status = state.stages.fetch.status = "completed"; state.stages.thinking.status = "in_progress";
  state.criticalRecord = { realIntent: "Keep independent modules under current design authority", blockingUnknowns: [],
    successCriteria: [{ id: "criterion-live", description: "Preserve current scope and dependencies" }] };
  state.fetchRecord = { evidence: ["Current project"], decisionImpactMap: ["Retain source contracts"], memoryStrategy: "project_only",
    capabilitySearchPerformed: true, capabilityDiscovery: { sources: ["project"], matches: ["current host"] } };
  await activateSpineState(root, state);
  const service = createLiveWorkspaceService({ projectRoot: root });
  const overview = () => service.getOverview({ runId: state.runId });
  await service.publishDesign({ runId: state.runId, conversationId: CHAT, expectedRevision: (await overview()).revision,
    input: { schemaVersion: 1, materialRefs: { outline: "outputs/outline.md", modules: { alpha: "outputs/alpha.md", beta: "outputs/beta.md" } },
      design: { mode: "exploration", userJourneys: [], interfaces: [], sharedState: [], settledDecisionRefs: [],
        taskSlices: ["alpha", "beta"].map(id => ({ id: `task-${id}`, outcome: `Inspect ${id}`, scopeFiles: [`outputs/${id}.md`],
          criterionIds: ["criterion-live"], dependsOn: [], verification: [{ criterionId: "criterion-live", procedure: "Read actual source", expectedEvidence: "Current file bytes" }] })),
        softwareDesign: { schemaVersion: 1, architecture: { id: "system", revision: 1, summary: "Independent modules", decisionRefs: [],
          technologyChoices: [], constraints: [], moduleIds: ["alpha", "beta"] }, modules: ["alpha", "beta"].map(id => ({ id, purpose: id,
          implementationNotes: `Inspect ${id}`, businessRules: ["Keep exact identity"], states: [{ name: "ready", behavior: "Continue" }], taskIds: [`task-${id}`] })) } } } });
  for (const id of [null, "alpha", ...(aggregate ? ["beta"] : [])]) {
    const view = await overview(), review = view.reviews.find(item => item.moduleId === id);
    await service.review({ runId: state.runId, decisionId: review.decisionId, expectedRevision: review.revision,
      expectedWorkspaceRevision: view.revision, artifactId: review.artifactId, version: review.version,
      choice: "accept", nonce: `accept-${id ?? "outline"}` });
  }
  const fresh = await service.hostNextWork({ runId: state.runId, conversationId: CHAT });
  const request = aggregate ? (await service.getRequests({ runId: state.runId })).requests.find(item => item.kind === "continue_governed_run" && item.status === "waiting_host") : fresh.request;
  assert.ok(request, "A real continuation request must exist");
  const claim = await service.claimRequest({ runId: state.runId, conversationId: CHAT, expectedRevision: fresh.revision, commandId: request.commandId });
  const dependency = path.join(root, "dependency"); createHostMethodSourceFixture(dependency);
  const env = { ...process.env, META_KIM_KIM_SERVICE_ROOT: dependency };
  const projects = JSON.parse(await readFile(new URL("../../config/capability-index/dependency-project-registry.json", import.meta.url), "utf8")).projects;
  const discovery = await discoverDependencyAgentContracts({ projects, projectRoot: root, environment: env });
  const owner = discovery.agents.find(item => item.id === "kim-service:package-analyst");
  const packets = ["alpha", "beta"].map(id => readOnlyWorkerPacket({ taskPacketId: `task-${id}`, roleInstanceId: `task-${id}`,
    ownerAgent: owner.id, ownerSource: owner.source, ownerSourceRef: owner.sourceRef, ownerBindingMode: owner.ownerBindingMode, ownerContract: owner.ownerContract,
    todayTask: `Inspect ${id}`, methodInputs: { facts: "Current bounded fixture source" }, acceptanceCriterionIds: ["criterion-live"],
    scopeFiles: [`outputs/${id}.md`], mutationPolicy: "read_only", externalWriteBoundary: false, dependsOn: [], workOrderReadiness: "ready" }));
  const graph = buildStageDagPacket({ moduleScopePlan: claim.workOrder.moduleScopePlan, runtimeCapacity: 2,
    stageLanes: { Execution: packets.map(packet => ({ laneId: packet.taskPacketId, laneKind: "execution_worker", ownerBindingRef: owner.id,
      capabilityBindingRef: "fixture:source-read", effectClass: "read_only_worker", resourceScopes: [], isolation: "shared_read_only" })) } });
  const kernel = await openDurableRunKernel();
  t.after(async () => { kernel.close(); await rm(root, { recursive: true, force: true }); });
  let allowExecution = false;
  const observed = [];
  const stageExecutors = Object.fromEntries(["Review", "Meta-Review", "Verification"].map(stage => [stage, {
    ownerId: "fixture-independent-reviewer", capabilityId: `fixture:${stage}`, sourceRef: "fixture:bounded-review", sourceSha256: sha(stage), toolBinding: "fixture:actual-callback",
    async invoke(request) {
      const ref = `fixture:${request.node.nodeId}`;
      return { binding: request.binding, verdict: "pass", summary: "Controlled current-scope review", evidenceRefs: [{ ref, sha256: sha(ref) }],
        criterionResults: [{ id: "criterion-live", status: "pass", evidenceRefs: [ref] }] };
    } }]));
  const output = () => ({ report: "Observed current bounded source", status: "produced", handoff: { nextOwner: owner.id, requiresDecision: false } });
  const host = { ownerId: "current-fixture-host", adapterId: "fixture-local-transport", methodResultMode: "host_reported_files", capacity: 2,
    workOrder: claim.workOrder, stageExecutors, evolutionDecision: { runId: state.runId, decision: "none-with-reason", reason: "No reusable method changed" },
    authorize: async ({ node }) => node?.laneKind === "execution_worker" && !allowExecution
      ? { status: "waiting", reason: "fixture_pause_before_execution" } : { status: "ready" },
    adapterRegistry: { invoke: async (_id, request) => {
      observed.push(request.packet.taskPacketId);
      const bytes = Buffer.from(JSON.stringify({ binding: request.methodBinding, output: output() }));
      const target = path.join(request.machineResultArtifact.ownedRoot, request.machineResultArtifact.relativePath);
      await writeFile(target, bytes, { flag: "wx" });
      return { result: { status: "pass", runtime: "gemini", ownerMethodBinding: request.methodSourceBinding,
        machineResultArtifact: { path: target, sha256: sha(bytes), bytes: bytes.length } } };
    } } };
  const taskFingerprint = "current-facts-resume";
  const goal = buildTaskGoalContract({ task: state.criticalRecord.realIntent,
    acceptanceCriteria: [{ id: "criterion-live", description: state.criticalRecord.successCriteria[0].description, kind: "deterministic", required: true }] });
  const advance = () => entry === "advance" ? advanceGovernedGoal({ runId: state.runId, goalContract: goal, stageDagPacket: graph,
    workerTaskPackets: packets, projectRoot: root, artifactRoot, runtime: "gemini", host, kernel, taskFingerprint, env })
    : runStageRunnerBridge({ runId: state.runId, runtime: "claude", stageDagPacket: graph,
      workerTaskPackets: packets.map(packet => ({ ...packet, workOrderReadiness: allowExecution ? "ready" : "incomplete" })),
      workspaceRoot: root, workerEnv: env, stageExecutors, host, artifactRoot, evidenceKind: "synthetic_transport",
      durable: { enabled: true, kernel, mode: allowExecution ? "resume" : "create", taskFingerprint },
      invokeWorker: async ({ packet }) => { observed.push(packet.taskPacketId); const bytes = JSON.stringify(output());
        return { status: "pass", durationMs: 1, outputText: bytes, outputSha256: sha(bytes), outputTextComplete: true }; } });
  return { root, runId: state.runId, service, overview, kernel, graph, observed, advance, host,
    continue: () => { allowExecution = true; }, stored: () => kernel.resumeRun({ runId: state.runId, graphDigest: graph.graphDigest, taskFingerprint }).completedNodes };
}

for (const entry of ["advance", "bridge"]) for (const mutation of ["feedback", "source", "architecture", "stop"]) {
  test(`${entry} resume rechecks current ${mutation} after a persisted Thinking receipt`, async t => {
    const f = await fixture(t, entry);
    await f.advance(); assert.deepEqual(f.observed, []);
    const thinkingId = moduleStageNodeId("alpha", "Thinking");
    const old = f.stored().find(row => row.nodeId === thinkingId);
    assert.ok(old, "The original real accepted design was persisted before the pause");
    if (mutation === "feedback") {
      const view = await f.overview(), target = view.design.modules.find(module => module.id === "alpha");
      await f.service.feedback({ runId: f.runId, moduleId: "alpha", artifactId: target.artifactId, version: target.version,
        original: "Revise this current design before proceeding", expectedWorkspaceRevision: view.revision, nonce: "invalidated-before-resume" });
    } else if (mutation === "stop") await terminalizeSpineState(f.root, { expectedRunId: f.runId, reason: "session_stop" });
    else await writeFile(path.join(f.root, `outputs/${mutation === "source" ? "alpha" : "outline"}.md`), "Unpublished changed source\n");
    f.continue();
    if (mutation === "stop") await assert.rejects(f.advance(), /module_fact_current_workspace_required/u);
    else {
      const result = await f.advance(), progress = result.moduleProgress ?? result.executionProjection.moduleProgress;
      const alpha = progress.modules.find(module => module.moduleId === "alpha");
      assert.equal(alpha.stages.find(stage => stage.stage === "Thinking").completed, false);
      assert.equal(progress.aggregateCompleted, false);
    }
    assert.deepEqual(f.observed, [], "No actual worker call may cross a revoked current fact");
    assert.deepEqual(f.stored().find(row => row.nodeId === thinkingId), old, "Keep prior evidence without presenting it as current permission");
  });
}

for (const entry of ["advance", "bridge"]) test(`${entry} source invalidation blocks only its real descendants while independent beta completes`, async t => {
  const f = await fixture(t, entry, { aggregate: true });
  await f.advance(); assert.deepEqual(f.observed, []);
  await writeFile(path.join(f.root, "outputs/alpha.md"), "Changed alpha only\n");
  f.continue();
  const result = await f.advance(), progress = result.moduleProgress ?? result.executionProjection.moduleProgress;
  assert.deepEqual(f.observed, ["task-beta"]);
  assert.equal(progress.modules.find(module => module.moduleId === "alpha").completed, false);
  assert.equal(progress.modules.find(module => module.moduleId === "beta").completed, true, JSON.stringify(result));
  assert.equal(progress.aggregateCompleted, false);
});

for (const entry of ["advance", "bridge"]) test(`${entry} a previously complete graph still rechecks current facts before reporting completion`, async t => {
  const f = await fixture(t, entry, { aggregate: true });
  await f.advance(); f.continue();
  const complete = await f.advance();
  assert.equal((complete.moduleProgress ?? complete.executionProjection.moduleProgress).aggregateCompleted, true);
  assert.deepEqual([...f.observed].sort(), ["task-alpha", "task-beta"]);
  const historical = f.stored();
  await writeFile(path.join(f.root, "outputs/alpha.md"), "Changed after completion\n");
  const resumed = await f.advance(), progress = resumed.moduleProgress ?? resumed.executionProjection.moduleProgress;
  assert.equal(progress.aggregateCompleted, false);
  assert.equal(progress.modules.find(module => module.moduleId === "alpha").completed, false);
  assert.equal(progress.modules.find(module => module.moduleId === "beta").completed, true);
  assert.deepEqual([...f.observed].sort(), ["task-alpha", "task-beta"], "No completed work is replayed to repair a changed current basis");
  assert.deepEqual(f.stored(), historical, "The existing kernel retains historical evidence");
});
