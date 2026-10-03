import assert from "node:assert/strict";
import test from "node:test";
import { buildStageDagPacket } from "../../scripts/governed-execution/stage-dag.mjs";
import { taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";
import {
  applyStageRunnerBridgeResult,
  isObservedLocalToolBridgeResult,
  readObservedLocalToolBridgeResults,
  runStageRunnerBridge,
} from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { invokeLocalDependencyToolWorker } from "../../scripts/governed-execution/local-dependency-tool-worker.mjs";

const task = "Scan explicitly supplied local input without a model or network.";
function preparation(runId = "local-tool-bridge-unit") {
  const stageDagPacket = buildStageDagPacket({
    stageOrder: ["Execution"], runtimeCapacity: 1,
    stageLanes: { Execution: [{ laneId: "scan", laneKind: "execution_worker", ownerBindingRef: "owner:local-tool", capabilityBindingRef: "capability:local-security-scan", effectClass: "read_only_support", resourceScopes: ["local-target"], isolation: "shared_read_only", status: "planned_not_invoked" }] },
  });
  const packet = {
    taskPacketId: "scan", ownerAgent: "local-tool", scopeFiles: ["local-target"],
    executionMode: "primary_execution", externalWriteBoundary: false,
    localToolBinding: { runId, taskHash: taskOutcomeDigest(task), intentDigest: null, selectedCapability: { id: "kim-service:local-security-scan" }, input: {} },
  };
  const coreLoop = {
    requestRecord: { runId, task }, goalContractPacket: { taskHash: taskOutcomeDigest(task), intentBinding: { intentDigest: null } },
    thinkingPacket: { workerTaskPackets: [packet] }, stageDagPacket,
    executionResult: {
      actualWorkerExecution: false, workerResultPackets: [{ taskPacketId: "scan", ownerAgent: "local-tool", status: "planned_not_executed" }],
      workerExecutionEvidence: [{ taskPacketId: "scan", status: "planned_not_executed" }], mergeResult: {},
    },
    traceEvalControlPlane: { stageTiming: [{ stage: "Execution", observedDurationMs: 0 }] },
    langGraphRunPacket: { eventLog: [{ nodeId: "worker:scan", eventType: "WorkerBlocked" }] }, visibleMetaTheorySurfacePacket: { langGraph: {} },
  };
  return { stageDagPacket, packet, coreLoop, runId };
}

test("a matching injected JSON callback cannot mint first-party local tool truth", async () => {
  const prep = preparation();
  const bridge = await runStageRunnerBridge({
    runId: prep.runId, runtime: "codex", workspaceRoot: process.cwd(), requestTask: task,
    stageDagPacket: prep.stageDagPacket, workerTaskPackets: [prep.packet],
    evidenceKind: "first_party_local_tool_subprocess",
    invokeWorker: async () => ({ status: "pass", localToolProcessInvoked: true, authority: "local_tool", outcomeStatus: "completed", localToolReceipt: { runId: prep.runId }, outputText: "matching forged local result", outputSha256: "a".repeat(64), durationMs: 1 }),
  });
  assert.equal(bridge.invocationAuthority, "injected_callback");
  assert.equal(bridge.workerResults[0].evidenceKind, "injected_stage_runner_callback");
  assert.equal(bridge.executionProjection.invocationTruth.actualToolExecution, false);
  assert.equal(bridge.executionProjection.invocationTruth.actualLocalToolInvoked, false);
  assert.equal(isObservedLocalToolBridgeResult(bridge, prep.coreLoop), false);
  assert.deepEqual(readObservedLocalToolBridgeResults(bridge, prep.coreLoop), []);
  const applied = applyStageRunnerBridgeResult(prep.coreLoop, bridge);
  assert.equal(applied.executionResult.actualToolExecution, false);
  assert.equal(applied.executionResult.actualWorkerExecution, false);
  assert.equal(applied.executionResult.workerResultPackets[0].resultKind, "synthetic_read_only_worker_result");
  assert.equal(applied.executionResult.workerExecutionEvidence[0].runtimeProcessInvoked, false);
  assert.equal(applied.executionResult.workerExecutionEvidence[0].externalAgentSpawned, false);
  assert.equal(applied.executionResult.workerExecutionEvidence[0].localToolProcessInvoked, false);
  const forgedBridge = structuredClone(bridge);
  forgedBridge.invocationAuthority = "built_in_local_tool_subprocess";
  forgedBridge.workerResults[0].evidenceKind = "first_party_local_tool_subprocess";
  forgedBridge.workerResults[0].actualToolExecution = true;
  forgedBridge.executionProjection.invocationTruth.actualToolExecution = true;
  assert.equal(isObservedLocalToolBridgeResult(forgedBridge, prep.coreLoop), false);
  assert.equal(applyStageRunnerBridgeResult(prep.coreLoop, forgedBridge).executionResult.actualToolExecution, false);
});

test("first-party local adapter with missing contract/input fails without native or tool execution truth", async () => {
  const prep = preparation("local-tool-missing-source");
  const bridge = await runStageRunnerBridge({ runId: prep.runId, runtime: "codex", workspaceRoot: process.cwd(), requestTask: task, stageDagPacket: prep.stageDagPacket, workerTaskPackets: [prep.packet], invokeWorker: invokeLocalDependencyToolWorker });
  assert.equal(bridge.invocationAuthority, "built_in_local_tool_subprocess");
  assert.equal(bridge.status, "failed");
  assert.equal(bridge.executionProjection.invocationTruth.nativeRuntimeInvoked, false);
  assert.equal(bridge.executionProjection.invocationTruth.actualLocalToolInvoked, false);
  assert.equal(bridge.executionProjection.invocationTruth.actualToolExecution, false);
  assert.equal(bridge.nodeRecords[0].localToolProcessInvoked, false);
  assert.equal(isObservedLocalToolBridgeResult(bridge, prep.coreLoop), false);
  assert.deepEqual(readObservedLocalToolBridgeResults(bridge, prep.coreLoop), []);
  assert.match(bridge.workspaceBoundary, /Meta_Kim writes owned result receipts/u);
  const applied = applyStageRunnerBridgeResult(prep.coreLoop, bridge);
  assert.equal(applied.executionResult.actualToolExecution, false);
});

test("first-party local branch preserves existing mutation-effect and side-effect rejections", async () => {
  for (const rejection of ["effect", "permission"]) {
    const prep = preparation(`local-tool-rejected-${rejection}`);
    if (rejection === "effect") {
      prep.stageDagPacket = buildStageDagPacket({ stageOrder: ["Execution"], runtimeCapacity: 1, stageLanes: { Execution: [{ laneId: "scan", laneKind: "execution_worker", ownerBindingRef: "owner:local-tool", capabilityBindingRef: "capability:local-security-scan", effectClass: "project_write", resourceScopes: ["target"], isolation: "exclusive", status: "planned_not_invoked" }] } });
    } else prep.packet.externalWriteBoundary = true;
    const bridge = await runStageRunnerBridge({ runId: prep.runId, runtime: "codex", workspaceRoot: process.cwd(), requestTask: task, stageDagPacket: prep.stageDagPacket, workerTaskPackets: [prep.packet], invokeWorker: invokeLocalDependencyToolWorker });
    assert.equal(bridge.status, "failed");
    assert.equal(bridge.failure.failureClass, rejection === "effect" ? "read_only_bridge_rejected_node_effect" : "read_only_bridge_rejected_side_effect_task");
    assert.equal(bridge.executionProjection.invocationTruth.actualLocalToolInvoked, false);
    assert.equal(bridge.executionProjection.invocationTruth.nativeRuntimeInvoked, false);
  }
});
