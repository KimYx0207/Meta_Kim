import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
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
  assert.match(CONTRACT.safety.childEnvironmentBoundary, /exact runtime allowlist/u);
  assert.match(CONTRACT.safety.childEnvironmentBoundary, /Prefix-matching is forbidden/u);
  assert.match(CONTRACT.safety.filesystemReadBoundary, /not claimed as mechanically confined/u);
  assert.match(CONTRACT.safety.telemetryRedaction, /built-in and custom invokers/u);
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

test("runtime child environment is provider-specific and drops unrelated cloud credentials", () => {
  const parentEnv = {
    PATH: "runtime-path",
    OPENAI_API_KEY: "codex-secret",
    OPENAI_BASE_URL: "https://codex.example.invalid",
    CODEX_HOME: "codex-home",
    OPENAI_INTERNAL_DB_PASSWORD: "must-not-leak",
    CODEX_PROJECT_SECRET: "must-not-leak",
    ANTHROPIC_API_KEY: "claude-secret",
    ANTHROPIC_BASE_URL: "https://claude.example.invalid",
    CLAUDE_CONFIG_DIR: "claude-home",
    CLAUDE_PROJECT_SECRET: "must-not-leak",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    AZURE_CLIENT_SECRET: "azure-secret",
    GOOGLE_APPLICATION_CREDENTIALS: "google-secret-path",
    CLOUD_ML_TOKEN: "cloud-ml-secret",
    DATABASE_URL: "must-not-leak",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "parent-claude",
    CODEX_THREAD_ID: "parent-thread",
    CODEX_PERMISSION_PROFILE: "managed",
  };
  const codex = buildRuntimeChildEnv("codex", parentEnv);
  assert.deepEqual(codex.removedManagedHostMarkers, [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CODEX_THREAD_ID",
    "CODEX_PERMISSION_PROFILE",
  ]);
  assert.equal(codex.childEnv.OPENAI_API_KEY, "codex-secret");
  assert.equal(codex.childEnv.OPENAI_BASE_URL, "https://codex.example.invalid");
  assert.equal(codex.childEnv.CODEX_HOME, "codex-home");
  assert.equal(codex.childEnv.OPENAI_INTERNAL_DB_PASSWORD, undefined);
  assert.equal(codex.childEnv.CODEX_PROJECT_SECRET, undefined);
  assert.equal(codex.childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(codex.childEnv.CLAUDE_CONFIG_DIR, undefined);

  const claude = buildRuntimeChildEnv("claude", parentEnv);
  assert.equal(claude.childEnv.ANTHROPIC_API_KEY, "claude-secret");
  assert.equal(claude.childEnv.ANTHROPIC_BASE_URL, "https://claude.example.invalid");
  assert.equal(claude.childEnv.CLAUDE_CONFIG_DIR, "claude-home");
  assert.equal(claude.childEnv.CLAUDE_PROJECT_SECRET, undefined);
  assert.equal(claude.childEnv.OPENAI_API_KEY, undefined);
  assert.equal(claude.childEnv.CODEX_HOME, undefined);

  for (const childEnv of [codex.childEnv, claude.childEnv]) {
    assert.equal(childEnv.PATH, "runtime-path");
    assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(childEnv.AZURE_CLIENT_SECRET, undefined);
    assert.equal(childEnv.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(childEnv.CLOUD_ML_TOKEN, undefined);
    assert.equal(childEnv.DATABASE_URL, undefined);
    assert.equal(childEnv.CLAUDECODE, undefined);
    assert.equal(childEnv.CODEX_THREAD_ID, undefined);
  }
});

test("bridge sanitizes custom worker output, stderr, and failure fields before retention", async () => {
  const secret = "bridge-secret-value-93841";
  const literalPassword = "literal-password-71592";
  const result = await runStageRunnerBridge({
    runId: "p118-custom-redaction",
    runtime: "codex",
    stageDagPacket: dagFor(["one"]),
    workerTaskPackets: [packet("one")],
    workspaceRoot: process.cwd(),
    redactionEnv: { OPENAI_API_KEY: secret },
    evidenceKind: "custom_test_double",
    invokeWorker: async () => ({
      status: "failed",
      durationMs: 1,
      outputText: `${process.cwd()} ${process.cwd().toUpperCase()} OPENAI_API_KEY=${secret} password=\"${literalPassword}\"`,
      outputSha256: "a".repeat(64),
      stderrTail: `${os.homedir()} ACCESS_TOKEN=${secret}`,
      failureClass: "custom_failure",
      failureMessage: `API_KEY=${secret}; PASSWORD=${literalPassword}; ${process.cwd()}`,
    }),
  });

  const retained = JSON.stringify({ nodeRecords: result.nodeRecords, failure: result.failure });
  assert.equal(retained.includes(secret), false);
  assert.equal(retained.includes(literalPassword), false);
  assert.equal(result.nodeRecords[0].outputText.includes(process.cwd()), false);
  assert.equal(result.nodeRecords[0].outputText.includes(process.cwd().toUpperCase()), false);
  assert.equal(result.nodeRecords[0].stderrTail.includes(os.homedir()), false);
  assert.equal(retained.includes(os.homedir()), false);
  assert.match(result.nodeRecords[0].outputText, /<workspace>/u);
  assert.match(result.nodeRecords[0].outputText, /<redacted-secret>/u);
  assert.match(result.nodeRecords[0].stderrTail, /<user-home>/u);
  assert.notEqual(result.nodeRecords[0].outputSha256, "a".repeat(64));
  assert.match(result.failure.reason, /<redacted-secret>/u);
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
  assert.equal(result.stageDagPacket.status, "planned_not_invoked");
  assert.equal(result.executionProjection.status, "executed");
  assert.equal(result.workerResults.length, 1);
  assert.ok(result.workerResults[0].observedDurationMs > 0);
  assert.equal(result.workerResults[0].actualBinding.runtime, "codex");
  assert.match(result.workspaceBoundary, /filesystem read confinement is not claimed/u);
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

test("read-only bridge rejects a mutating DAG node even when its packet denies side effects", async () => {
  let invoked = false;
  const result = await runStageRunnerBridge({
    runId: "p117-node-effect-test",
    runtime: "codex",
    stageDagPacket: dagFor(["write"], {
      laneOverrides: { write: { effectClass: "external_write" } },
    }),
    workerTaskPackets: [packet("write", { externalWriteBoundary: false })],
    workspaceRoot: process.cwd(),
    invokeWorker: async () => {
      invoked = true;
      throw new Error("must not run");
    },
    evidenceKind: "test_double",
  });
  assert.equal(invoked, false);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.failureClass, "read_only_bridge_rejected_node_effect");
});

test("bridge application cannot promote an injected callback to native execution truth", async () => {
  const bridge = await runStageRunnerBridge({
    runId: "p117-apply-test",
    runtime: "claude",
    stageDagPacket: dagFor(["one"], { capacity: 1 }),
    workerTaskPackets: [packet("one")],
    workspaceRoot: process.cwd(),
    capacity: 1,
    invokeWorker: passingInvoker(),
    evidenceKind: "native_read_only_stage_runner",
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
  assert.equal(applied.stageDagPacket.status, "planned_not_invoked");
  assert.equal(applied.stageDagPacket.graphDigest, coreLoop.stageDagPacket.graphDigest);
  assert.equal(applied.stageRunnerBridgePacket.status, "pass");
  assert.equal(bridge.invocationAuthority, "injected_callback");
  assert.equal(bridge.workerResults[0].evidenceKind, "injected_stage_runner_callback");
  assert.equal(bridge.executionProjection.invocationTruth.bridgeCallbackCompleted, true);
  assert.equal(bridge.executionProjection.invocationTruth.nativeRuntimeInvoked, false);
  assert.equal(bridge.executionProjection.invocationTruth.plannedIsInvoked, false);
  assert.equal(applied.executionResult.actualWorkerExecution, false);
  assert.equal(applied.executionResult.workerResultPackets[0].status, "executed");
  assert.equal(applied.executionResult.workerExecutionEvidence[0].liveWorkerExecution, false);
  assert.ok(applied.traceEvalControlPlane.stageTiming[0].observedDurationMs > 0);
  assert.equal(applied.langGraphRunPacket.runtimeExecutionEvidence, "synthetic_stage_runner_bridge");
  assert.equal(applied.langGraphRunPacket.eventLog[0].eventType, "WorkerFinished");

  const syntheticBridge = structuredClone(bridge);
  syntheticBridge.workerResults[0].evidenceKind = "test_double";
  const syntheticApplied = applyStageRunnerBridgeResult(coreLoop, syntheticBridge);
  assert.equal(syntheticApplied.executionResult.actualWorkerExecution, false);
  assert.equal(
    syntheticApplied.executionResult.workerResultPackets[0].resultKind,
    "synthetic_read_only_worker_result",
  );
  assert.equal(
    syntheticApplied.executionResult.workerExecutionEvidence[0].runtimeProcessInvoked,
    false,
  );
  assert.equal(
    syntheticApplied.langGraphRunPacket.runtimeExecutionEvidence,
    "synthetic_stage_runner_bridge",
  );

  const nativeBridge = structuredClone(bridge);
  nativeBridge.invocationAuthority = "built_in_native_read_only_subprocess";
  nativeBridge.workerResults[0].evidenceKind = "native_read_only_stage_runner";
  const nativeApplied = applyStageRunnerBridgeResult(coreLoop, nativeBridge);
  assert.equal(nativeApplied.executionResult.actualWorkerExecution, false);
  assert.equal(
    nativeApplied.langGraphRunPacket.runtimeExecutionEvidence,
    "synthetic_stage_runner_bridge",
  );

  const missingBridgeDigest = structuredClone(bridge);
  delete missingBridgeDigest.stageDagPacket.graphDigest;
  assert.throws(
    () => applyStageRunnerBridgeResult(coreLoop, missingBridgeDigest),
    /bridge graph digest is missing/iu,
  );
});
