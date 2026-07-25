import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyStageRunnerBridgeResult,
  buildRuntimeChildEnv,
  buildReadOnlyWorkerPrompt,
  runStageRunnerBridge,
} from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import {
  buildStageDagPacket,
} from "../../scripts/governed-execution/stage-dag.mjs";

const CONTRACT = JSON.parse(
  readFileSync("config/contracts/stage-runner-bridge-contract.json", "utf8"),
);
const PACKAGE = JSON.parse(readFileSync("package.json", "utf8"));

function lane(taskPacketId, overrides = {}) {
  return {
    laneId: taskPacketId,
    laneKind: "execution_worker",
    ownerBindingRef: `owner:${taskPacketId}`,
    capabilityBindingRef: `capability:${taskPacketId}`,
    effectClass: "read_only_worker",
    resourceScopes: [`file:${taskPacketId}.txt`],
    isolation: "shared_read_only",
    status: "planned_not_invoked",
    ...overrides,
  };
}

function packet(taskPacketId, overrides = {}) {
  return {
    taskPacketId,
    owner: "test",
    ownerAgent: "test-automator",
    description: `Read ${taskPacketId}.txt`,
    output: "observed value",
    acceptanceCriteria: ["read the file"],
    scopeFiles: [`${taskPacketId}.txt`],
    shardScope: [taskPacketId],
    nonGoals: ["no writes"],
    dependsOn: [],
    executionMode: "primary_execution",
    externalWriteBoundary: false,
    ...overrides,
  };
}

function dagFor(taskPacketIds, { capacity = taskPacketIds.length, laneOverrides = {} } = {}) {
  return buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: {
      Execution: taskPacketIds.map((taskPacketId) =>
        lane(taskPacketId, laneOverrides[taskPacketId] ?? {})
      ),
    },
    runtimeCapacity: capacity,
  });
}

function passingInvoker({ delayMs = 5, lifecycle = null } = {}) {
  return async ({ runtime, packet }) => {
    const startedAt = new Date();
    if (lifecycle) {
      lifecycle.active += 1;
      lifecycle.maxActive = Math.max(lifecycle.maxActive, lifecycle.active);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (lifecycle) lifecycle.active -= 1;
    const outputText = `${runtime}:${packet.taskPacketId}:observed`;
    return {
      status: "pass",
      runtime,
      exitCode: 0,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: delayMs,
      sessionId: `${runtime}-session-${packet.taskPacketId}`,
      messageId: `${runtime}-message-${packet.taskPacketId}`,
      outputText,
      outputSha256: "a".repeat(64),
      rawOutputSha256: "b".repeat(64),
      hostEventCount: 2,
      toolEventCount: 1,
      stderrTail: "",
    };
  };
}

test("P-117 contract requires Codex and Claude Code with one DAG authority", () => {
  assert.equal(CONTRACT.prdTaskId, "P-117");
  assert.deepEqual(CONTRACT.primaryRuntimes, ["codex", "claude"]);
  assert.equal(CONTRACT.singleAuthority.packet, "coreLoop.stageDagPacket");
  assert.equal(CONTRACT.safety.taskBudget, null);
  assert.equal(CONTRACT.acceptance.oneRuntimeMaySubstituteForAnother, false);
  assert.equal(CONTRACT.acceptance.syntheticProviderOrModelOutputCountsAsProductEvidence, false);
  assert.equal(CONTRACT.acceptance.deterministicInputFilesAllowed, true);
  assert.match(PACKAGE.scripts["meta:stage-runner:acceptance"], /--runtime both/u);
  assert.match(PACKAGE.scripts["meta:stage-runner:codex"], /--runtime codex/u);
  assert.match(PACKAGE.scripts["meta:stage-runner:claude"], /--runtime claude/u);
  assert.match(PACKAGE.scripts["meta:stage-runner:governed"], /--runtime both/u);
});

test("read-only worker prompt retains the original governed user task", () => {
  const prompt = buildReadOnlyWorkerPrompt({
    runId: "p117-task-context-test",
    runtime: "codex",
    node: dagFor(["one"]).nodes[0],
    packet: packet("one"),
    requestTask: "Read package.json and report the exact version.",
  });
  assert.match(prompt, /Original user task: Read package\.json and report the exact version\./u);
  if (process.platform === "win32") {
    assert.match(prompt, /direct Get-Content -LiteralPath command without a pipeline/u);
  }
});

test("runtime child environment removes nested host markers without dropping authentication", () => {
  const { childEnv, removedManagedHostMarkers } = buildRuntimeChildEnv({
    PATH: "runtime-path",
    ANTHROPIC_API_KEY: "kept-secret",
    DATABASE_URL: "must-not-leak",
    CLAUDECODE: "1",
    CODEX_THREAD_ID: "parent-thread",
    CODEX_PERMISSION_PROFILE: "managed",
  });
  assert.deepEqual(removedManagedHostMarkers, [
    "CLAUDECODE",
    "CODEX_THREAD_ID",
    "CODEX_PERMISSION_PROFILE",
  ]);
  assert.equal(childEnv.ANTHROPIC_API_KEY, "kept-secret");
  assert.equal(childEnv.PATH, "runtime-path");
  assert.equal(childEnv.CLAUDECODE, undefined);
  assert.equal(childEnv.CODEX_THREAD_ID, undefined);
  assert.equal(childEnv.DATABASE_URL, undefined);
});

test("sequential bridge executes one native-bound worker and the local merge node", async () => {
  const result = await runStageRunnerBridge({
    runId: "p117-sequential-test",
    runtime: "codex",
    stageDagPacket: dagFor(["one"], { capacity: 1 }),
    workerTaskPackets: [packet("one")],
    workspaceRoot: process.cwd(),
    capacity: 1,
    invokeWorker: passingInvoker(),
    evidenceKind: "test_double",
  });
  assert.equal(result.status, "pass");
  assert.equal(result.stageDagPacket.status, "executed");
  assert.equal(result.workerResults.length, 1);
  assert.ok(result.workerResults[0].observedDurationMs > 0);
  assert.equal(result.workerResults[0].actualBinding.runtime, "codex");
  assert.equal(result.nodeRecords.at(-1).laneKind, "stage_merge");
  assert.equal(result.nodeRecords.at(-1).status, "completed");
});

test("fan-out bridge uses the DAG ready set and overlaps two native calls before merge", async () => {
  const lifecycle = { active: 0, maxActive: 0 };
  const result = await runStageRunnerBridge({
    runId: "p117-fanout-test",
    runtime: "claude",
    stageDagPacket: dagFor(["left", "right"], { capacity: 2 }),
    workerTaskPackets: [packet("left"), packet("right")],
    workspaceRoot: process.cwd(),
    capacity: 2,
    invokeWorker: passingInvoker({ delayMs: 20, lifecycle }),
    evidenceKind: "test_double",
  });
  assert.equal(result.status, "pass");
  assert.equal(lifecycle.maxActive, 2);
  assert.equal(result.workerResults.length, 2);
  assert.deepEqual(result.workerResults.map((worker) => worker.taskPacketId), ["left", "right"]);
  assert.equal(result.nodeRecords.filter((record) => record.laneKind === "stage_merge").length, 1);
  assert.equal(result.mergedOutput.length, 2);
});

test("read-only bridge rejects side-effect worker tasks before invoking a runtime", async () => {
  let invoked = false;
  const result = await runStageRunnerBridge({
    runId: "p117-side-effect-test",
    runtime: "codex",
    stageDagPacket: dagFor(["write"]),
    workerTaskPackets: [packet("write", { externalWriteBoundary: true })],
    workspaceRoot: process.cwd(),
    invokeWorker: async () => {
      invoked = true;
      throw new Error("must not run");
    },
    evidenceKind: "test_double",
  });
  assert.equal(invoked, false);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.failureClass, "read_only_bridge_rejected_side_effect_task");
  assert.equal(result.workerResults.length, 0);
});

test("bridge application replaces planned execution truth before artifact persistence", async () => {
  const bridge = await runStageRunnerBridge({
    runId: "p117-apply-test",
    runtime: "claude",
    stageDagPacket: dagFor(["one"], { capacity: 1 }),
    workerTaskPackets: [packet("one")],
    workspaceRoot: process.cwd(),
    capacity: 1,
    invokeWorker: passingInvoker(),
    evidenceKind: "test_double",
  });
  const coreLoop = {
    stageDagPacket: dagFor(["one"], { capacity: 1 }),
    executionResult: {
      actualWorkerExecution: false,
      executionClosure: "worker_execution_blocked_or_not_required",
      workerResultPackets: [{
        taskPacketId: "one",
        owner: "test",
        status: "planned_not_executed",
      }],
      workerExecutionEvidence: [{
        taskPacketId: "one",
        liveWorkerExecution: false,
        status: "planned_not_executed",
      }],
      mergeResult: { status: "dispatch_board_merged", liveExecutionMerged: false },
    },
    traceEvalControlPlane: {
      stageTiming: [{ stage: "Execution", observedDurationMs: 0 }],
    },
    langGraphRunPacket: {
      runtimeExecutionEvidence: "not_claimed",
      eventLog: [{ nodeId: "worker:one", eventType: "WorkerBlocked" }],
    },
    visibleMetaTheorySurfacePacket: { langGraph: {} },
  };
  const applied = applyStageRunnerBridgeResult(coreLoop, bridge);
  assert.equal(applied.stageRunnerBridgePacket.status, "pass");
  assert.equal(applied.executionResult.actualWorkerExecution, true);
  assert.equal(applied.executionResult.workerResultPackets[0].status, "executed");
  assert.equal(applied.executionResult.workerExecutionEvidence[0].liveWorkerExecution, true);
  assert.ok(applied.traceEvalControlPlane.stageTiming[0].observedDurationMs > 0);
  assert.equal(applied.langGraphRunPacket.runtimeExecutionEvidence, "native_stage_runner_bridge");
  assert.equal(applied.langGraphRunPacket.eventLog[0].eventType, "WorkerFinished");
});
