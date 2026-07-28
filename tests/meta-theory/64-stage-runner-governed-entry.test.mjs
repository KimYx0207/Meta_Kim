import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runMetaTheoryGovernedExecution } from "../../scripts/run-meta-theory-governed-execution.mjs";

test("formal governed entrypoint records a synthetic bridge result without claiming native execution", async (t) => {
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-p117-governed-test-"));
  t.after(async () => fs.rm(outputRoot, { recursive: true, force: true }));
  const task = "Run meta-theory: inspect package.json and produce a durable verification report of the exact package name and version. Do not modify files.";
  const prompts = [];
  const report = await runMetaTheoryGovernedExecution({
    task,
    runId: "p117-governed-entry-test",
    runtime: "codex",
    osTarget: "windows",
    stateDir: outputRoot,
    artifactDir: outputRoot,
    dbPath: path.join(outputRoot, "runs.sqlite"),
    projectRoot: process.cwd(),
    projectCapabilityMutationMode: "read_only",
    emitConversationNotice: false,
    stageRunner: {
      enabled: true,
      runtime: "codex",
      durableMode: "fresh",
      durableDbPath: path.join(outputRoot, "durable-runs.sqlite"),
      capacity: 1,
      timeoutMs: 30_000,
      evidenceKind: "governed_entry_test_double",
      invokeWorker: async ({ runtime, prompt, packet }) => {
        prompts.push(prompt);
        return {
          status: "pass",
          runtime,
          exitCode: 0,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 5,
          sessionId: `session-${packet.taskPacketId}`,
          messageId: `message-${packet.taskPacketId}`,
          outputText: "meta-kim 2.9.0",
          outputSha256: "a".repeat(64),
          rawOutputSha256: "b".repeat(64),
          hostEventCount: 1,
          toolEventCount: 1,
          stderrTail: "",
        };
      },
    },
  });
  assert.equal(report.stageRunnerBridgePacket.status, "pass");
  assert.equal(report.stageRunnerBridgePacket.executionProjection.durable.enabled, true);
  assert.equal(report.stageRunnerBridgePacket.executionProjection.durable.resumed, false);
  assert.equal(
    report.stageRunnerBridgePacket.executionProjection.invocationTruth.bridgeCallbackCompleted,
    true,
  );
  assert.equal(
    report.stageRunnerBridgePacket.executionProjection.invocationTruth.nativeRuntimeInvoked,
    false,
  );
  assert.ok(report.stageRunnerBridgePacket.stageDagPacket.nodes
    .filter((node) => node.stage === "Execution" && node.laneKind === "execution_worker")
    .every((node) => node.effectClass === "read_only_worker"));
  assert.equal(report.durableExecution.mode, "fresh");
  assert.equal(report.durableExecution.status, "materialized");
  assert.equal(report.durableExecution.fenceToken, 1);
  assert.ok(Number.isInteger(report.durableExecution.cursor));
  assert.ok(report.durableExecution.headCheckpointId);
  assert.equal(JSON.stringify(report.durableExecution).includes(outputRoot), false);
  assert.equal((await fs.stat(path.join(outputRoot, "p117-governed-entry-test.reservation.json"))).isFile(), true);
  assert.equal((await fs.stat(path.join(outputRoot, "durable-runs.sqlite"))).isFile(), true);
  assert.equal(report.executionResult.actualWorkerExecution, false);
  assert.ok(report.executionResult.workerExecutionEvidence.every(
    (item) =>
      item.status === "executed" &&
      item.liveWorkerExecution === false &&
      item.runtimeProcessInvoked === false,
  ));
  assert.equal(report.langGraphRunPacket.runtimeExecutionEvidence, "synthetic_stage_runner_bridge");
  assert.ok(report.traceEvalControlPlane.stageTiming.find(
    (item) => item.stage === "Execution",
  ).observedDurationMs > 0);
  assert.ok(prompts.length > 0);
  assert.ok(prompts.every((prompt) => prompt.includes(`Original user task: ${task}`)));
});
