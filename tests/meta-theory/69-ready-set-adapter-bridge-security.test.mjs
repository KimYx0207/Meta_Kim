import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  executeNativeReadySet,
  readySetDigest,
} from "../../scripts/governed-execution/ready-set-adapters.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { buildStageDagPacket } from "../../scripts/governed-execution/stage-dag.mjs";

const BRIDGE_URL = pathToFileURL(path.resolve("scripts/governed-execution/stage-runner-bridge.mjs")).href;
const DAG_URL = pathToFileURL(path.resolve("scripts/governed-execution/stage-dag.mjs")).href;

function lane(taskPacketId) {
  return {
    laneId: taskPacketId,
    laneKind: "execution_worker",
    ownerBindingRef: `owner:${taskPacketId}`,
    capabilityBindingRef: `capability:${taskPacketId}`,
    effectClass: "read_only_worker",
    resourceScopes: [`file:${taskPacketId}.txt`],
    isolation: "shared_read_only",
    status: "planned_not_invoked",
  };
}

function packet(taskPacketId) {
  return {
    taskPacketId,
    ownerAgent: "test-automator",
    description: `Read ${taskPacketId}.txt`,
    output: "observed value",
    dependsOn: [],
    executionMode: "primary_execution",
    externalWriteBoundary: false,
  };
}

function dagFor(taskPacketIds = ["one"]) {
  return buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: { Execution: taskPacketIds.map(lane) },
    runtimeCapacity: taskPacketIds.length,
  });
}

function passingInvoker(counter) {
  return async ({ packet: task }) => {
    counter.count += 1;
    return {
      status: "pass",
      runtime: "codex",
      exitCode: 0,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1,
      sessionId: `session-${task.taskPacketId}`,
      messageId: `message-${task.taskPacketId}`,
      outputText: `observed:${task.taskPacketId}`,
      outputSha256: "a".repeat(64),
      rawOutputSha256: "b".repeat(64),
      hostEventCount: 1,
      toolEventCount: 1,
      stderrTail: "",
    };
  };
}

function fabricatedResult(args, values) {
  const nodeIds = args.readyNodes.map((node) => node.nodeId);
  return {
    schemaVersion: "meta-kim-ready-set-adapter-result-v0.1",
    prdTaskId: "P-119",
    adapterId: "adversarial_test_adapter",
    status: "pass",
    authorityPacketRef: "coreLoop.stageDagPacket",
    topologyAuthorityConsumed: false,
    checkpointAuthority: "p118_durable_run_kernel_only",
    runtimeExecutionEvidence: "adversarial_test_only",
    runId: args.runId,
    graphDigest: args.graphDigest,
    batchIndex: args.batchIndex,
    selectedNodeIds: nodeIds,
    readySetDigest: readySetDigest({
      runId: args.runId,
      graphDigest: args.graphDigest,
      batchIndex: args.batchIndex,
      nodeIds,
    }),
    executionState: "settled",
    callbackExecutionEvidence: nodeIds.map((nodeId) => ({
      nodeId,
      invocationCount: 1,
      settled: true,
    })),
    results: nodeIds.map((nodeId, index) => ({
      nodeId,
      status: "fulfilled",
      value: values[index] ?? { nodeId, status: "completed" },
    })),
    optionalDependency: null,
  };
}

function baseBridge(overrides = {}) {
  const dag = overrides.stageDagPacket ?? dagFor();
  const counter = overrides.counter ?? { count: 0 };
  return {
    dag,
    counter,
    options: {
      runId: overrides.runId ?? "p119-adversarial-bridge",
      runtime: "codex",
      stageDagPacket: dag,
      workerTaskPackets: [packet("one")],
      workspaceRoot: process.cwd(),
      invokeWorker: passingInvoker(counter),
      evidenceKind: "adversarial_test_double",
      ...overrides,
      counter: undefined,
    },
  };
}

test("69 — bridge owns exact-once callback truth even when an adapter self-attests", async () => {
  const { options, counter } = baseBridge();
  options.executeReadySet = async (args) => {
    const first = await args.executeNode(args.readyNodes[0].nodeId);
    await assert.rejects(args.executeNode(args.readyNodes[0].nodeId), {
      code: "adapter_duplicate_node_invocation",
    });
    return fabricatedResult(args, [first]);
  };
  const result = await runStageRunnerBridge(options);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.failureClass, "adapter_duplicate_node_invocation");
  assert.equal(counter.count, 1);
});

test("69 — fabricated completion without callbacks fails once instead of looping", async () => {
  const { options, counter } = baseBridge();
  options.executeReadySet = async (args) => fabricatedResult(args, []);
  const result = await runStageRunnerBridge(options);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.failureClass, "adapter_controller_invocation_mismatch");
  assert.equal(counter.count, 0);
  assert.equal(result.readySetAdapterPacket.batches.length, 1);
});

test("69 — adapter cannot return before the controller-owned callback settles", async () => {
  const { options, counter } = baseBridge();
  options.invokeWorker = async ({ packet: task }) => {
    counter.count += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      status: "pass",
      runtime: "codex",
      durationMs: 25,
      outputText: `actual:${task.taskPacketId}`,
      outputSha256: "a".repeat(64),
      rawOutputSha256: "b".repeat(64),
      hostEventCount: 1,
      toolEventCount: 1,
    };
  };
  options.executeReadySet = async (args) => {
    void args.executeNode(args.readyNodes[0].nodeId);
    return fabricatedResult(args, [{
      nodeId: args.readyNodes[0].nodeId,
      status: "completed",
      outputText: "forged-before-settlement",
    }]);
  };
  const result = await runStageRunnerBridge(options);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.failureClass, "adapter_result_substitution");
  assert.equal(counter.count, 1);
});

test("69 — adapter cannot replace an actual failed node with a forged completion", async () => {
  const secret = "P119_FORGED_RESULT_SECRET_7291";
  const { options, counter } = baseBridge();
  options.invokeWorker = async () => {
    counter.count += 1;
    return {
      status: "failed",
      durationMs: 1,
      failureClass: "actual_worker_failure",
      failureMessage: "actual failure",
    };
  };
  options.executeReadySet = async (args) => {
    await args.executeNode(args.readyNodes[0].nodeId);
    return fabricatedResult(args, [{
      nodeId: args.readyNodes[0].nodeId,
      status: "completed",
      failureMessage: `API_KEY=${secret}`,
    }]);
  };
  const result = await runStageRunnerBridge(options);
  const retained = JSON.stringify(result);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.failureClass, "adapter_result_substitution");
  assert.equal(counter.count, 1);
  assert.equal(retained.includes(secret), false);
});

test("69 — adapter receives only frozen node-id descriptors and cannot mutate the DAG", async () => {
  const { options, dag, counter } = baseBridge();
  options.executeReadySet = async (args) => {
    assert.equal(Object.isFrozen(args.readyNodes), true);
    assert.equal(Object.isFrozen(args.readyNodes[0]), true);
    assert.deepEqual(Object.keys(args.readyNodes[0]), ["nodeId"]);
    assert.throws(() => {
      args.readyNodes[0].effectClass = "external_write";
    }, TypeError);
    return executeNativeReadySet(args);
  };
  const result = await runStageRunnerBridge(options);
  assert.equal(result.status, "pass");
  assert.equal(counter.count, 1);
  assert.equal(dag.nodes.find((node) => node.laneKind === "execution_worker").effectClass, "read_only_worker");
});

test("69 — unknown node probes fail closed even when the adapter catches its own error", async () => {
  const { options, counter } = baseBridge();
  options.executeReadySet = async (args) => {
    await assert.rejects(args.executeNode("stage:execution:lane:outside"), {
      code: "adapter_unknown_node",
    });
    return executeNativeReadySet(args);
  };
  const result = await runStageRunnerBridge(options);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.failureClass, "adapter_unknown_node");
  assert.equal(counter.count, 1);
});

test("69 — non-settling adapter hits a process safety timeout", async () => {
  const { options, counter } = baseBridge();
  options.readySetTimeoutMs = 20;
  options.executeReadySet = async () => new Promise(() => {});
  const result = await runStageRunnerBridge(options);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.failureClass, "ready_set_adapter_safety_timeout");
  assert.equal(counter.count, 0);
});

test("69 — timeout drains every started callback before reporting or closing", async () => {
  const { options, counter } = baseBridge();
  let workerFinished = 0;
  options.readySetTimeoutMs = 20;
  options.invokeWorker = async () => {
    counter.count += 1;
    await new Promise((resolve) => setTimeout(resolve, 90));
    workerFinished += 1;
    return {
      status: "pass",
      runtime: "codex",
      durationMs: 90,
      outputText: "finished-before-bridge-return",
      outputSha256: "a".repeat(64),
      rawOutputSha256: "b".repeat(64),
      hostEventCount: 1,
      toolEventCount: 1,
    };
  };
  options.executeReadySet = async (args) => {
    void args.executeNode(args.readyNodes[0].nodeId);
    return new Promise(() => {});
  };
  const startedAt = Date.now();
  const result = await runStageRunnerBridge(options);
  assert.ok(Date.now() - startedAt >= 80);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.failureClass, "ready_set_adapter_safety_timeout");
  assert.equal(counter.count, 1);
  assert.equal(workerFinished, 1);
  assert.equal(result.executionProjection.nodeStatuses[0].status, "completed");
  assert.equal(result.nodeRecords[0].status, "completed");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(workerFinished, 1);
});

test("69 — timeout signal lets a cooperative worker stop before bridge return", async () => {
  const { options, counter } = baseBridge();
  let lateCompletion = false;
  options.readySetTimeoutMs = 20;
  options.invokeWorker = async ({ signal }) => {
    counter.count += 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        lateCompletion = true;
        resolve({ status: "pass", durationMs: 500 });
      }, 500);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve({
          status: "failed",
          durationMs: 20,
          failureClass: "worker_aborted",
          failureMessage: "adapter timeout",
        });
      }, { once: true });
    });
  };
  options.executeReadySet = async (args) => {
    void args.executeNode(args.readyNodes[0].nodeId);
    return new Promise(() => {});
  };
  const result = await runStageRunnerBridge(options);
  assert.equal(result.status, "failed");
  assert.equal(result.failure.failureClass, "ready_set_adapter_safety_timeout");
  assert.equal(counter.count, 1);
  assert.equal(result.executionProjection.nodeStatuses[0].status, "failed");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(lateCompletion, false);
});

test("69 — strict-mode host survives a fire-and-forget callback after bridge timeout", () => {
  const childSource = `
    import { runStageRunnerBridge } from ${JSON.stringify(BRIDGE_URL)};
    import { buildStageDagPacket } from ${JSON.stringify(DAG_URL)};
    const lane = {
      laneId: "one",
      laneKind: "execution_worker",
      ownerBindingRef: "owner:one",
      capabilityBindingRef: "capability:one",
      effectClass: "read_only_worker",
      resourceScopes: ["file:one.txt"],
      isolation: "shared_read_only",
      status: "planned_not_invoked",
    };
    const dag = buildStageDagPacket({
      stageOrder: ["Execution"],
      stageLanes: { Execution: [lane] },
      runtimeCapacity: 1,
    });
    let lateAttempted = 0;
    const result = await runStageRunnerBridge({
      runId: "p119-late-callback-strict-child",
      runtime: "codex",
      stageDagPacket: dag,
      workerTaskPackets: [{
        taskPacketId: "one",
        ownerAgent: "test-automator",
        description: "Read one.txt",
        output: "observed",
        dependsOn: [],
        executionMode: "primary_execution",
        externalWriteBoundary: false,
      }],
      workspaceRoot: process.cwd(),
      readySetTimeoutMs: 20,
      invokeWorker: async () => { throw new Error("late callback must never invoke worker"); },
      executeReadySet: async (args) => {
        setTimeout(() => {
          lateAttempted += 1;
          void args.executeNode(args.readyNodes[0].nodeId);
        }, 70);
        return new Promise(() => {});
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    process.stdout.write(JSON.stringify({
      status: result.status,
      failureClass: result.failure?.failureClass,
      lateAttempted,
      nodeStatus: result.executionProjection.nodeStatuses[0].status,
    }));
  `;
  const child = spawnSync(process.execPath, [
    "--unhandled-rejections=strict",
    "--input-type=module",
    "--eval",
    childSource,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout), {
    status: "failed",
    failureClass: "ready_set_adapter_safety_timeout",
    lateAttempted: 1,
    nodeStatus: "planned_not_invoked",
  });
});

test("69 — adapter failures are path- and secret-redacted before retention", async () => {
  const secret = "p119-adapter-secret-48192";
  const { options } = baseBridge();
  options.redactionEnv = { OPENAI_API_KEY: secret };
  options.executeReadySet = async () => {
    const error = new Error(`${process.cwd()} ${os.homedir()} API_KEY=${secret}`);
    error.code = "optional_adapter_unavailable";
    throw error;
  };
  const result = await runStageRunnerBridge(options);
  const retained = JSON.stringify({ failure: result.failure, adapter: result.readySetAdapterPacket });
  assert.equal(retained.includes(secret), false);
  assert.equal(retained.includes(process.cwd()), false);
  assert.equal(retained.includes(os.homedir()), false);
  assert.match(retained, /<workspace>/u);
  assert.match(retained, /<user-home>/u);
  assert.match(retained, /<redacted-secret>/u);
});

test("69 — every adapter path requires an authoritative graph digest before execution", async () => {
  const dag = dagFor();
  delete dag.graphDigest;
  let adapterCalled = false;
  const { options } = baseBridge({ stageDagPacket: dag });
  options.executeReadySet = async () => {
    adapterCalled = true;
  };
  await assert.rejects(runStageRunnerBridge(options), /graphDigest is required/iu);
  assert.equal(adapterCalled, false);
});
