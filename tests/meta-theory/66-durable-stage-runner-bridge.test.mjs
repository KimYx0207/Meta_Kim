import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import {
  buildStageDagPacket,
  stageLaneNodeId,
} from "../../scripts/governed-execution/stage-dag.mjs";

const BRIDGE_URL = pathToFileURL(path.resolve("scripts/governed-execution/stage-runner-bridge.mjs")).href;
const KERNEL_URL = pathToFileURL(path.resolve("scripts/governed-execution/durable-run-kernel.mjs")).href;
const DAG_URL = pathToFileURL(path.resolve("scripts/governed-execution/stage-dag.mjs")).href;
const CONTRACT = JSON.parse(
  readFileSync("config/contracts/stage-runner-bridge-contract.json", "utf8"),
);

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

function dagFor(taskPacketIds) {
  return buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: { Execution: taskPacketIds.map(lane) },
    runtimeCapacity: taskPacketIds.length,
  });
}

test("66 — bridge contract exposes the optional P-118 durable kernel boundary", () => {
  assert.equal(CONTRACT.durableExtension.prdTaskId, "P-118");
  assert.equal(CONTRACT.durableExtension.optional, true);
  assert.equal(CONTRACT.durableExtension.defaultMode, "create");
  assert.equal(CONTRACT.durableExtension.requireGraphDigest, true);
  assert.equal(CONTRACT.durableExtension.authorityProjection, "coreLoop.stageDagPacket remains immutable");
  assert.equal(CONTRACT.durableExtension.terminalCommit, "per-node before ready batch settlement");
});

test("66 — durable bridge requires an authoritative graph digest", async () => {
  const dag = dagFor(["one"]);
  delete dag.graphDigest;
  await assert.rejects(
    runStageRunnerBridge({
      runId: "p118-missing-digest",
      runtime: "codex",
      stageDagPacket: dag,
      workerTaskPackets: [packet("one")],
      workspaceRoot: process.cwd(),
      durable: {
        enabled: true,
        dbPath: ":memory:",
        taskFingerprint: "task-p118-missing-digest",
      },
      invokeWorker: async () => {
        throw new Error("must not invoke without a graph digest");
      },
    }),
    /graphDigest.*required/iu,
  );
});

test("66 — durable bridge resume binds the exact graph and task", async () => {
  const kernel = await openDurableRunKernel();
  const firstDag = dagFor(["one"]);
  try {
    await runStageRunnerBridge({
      runId: "p118-bridge-binding",
      runtime: "codex",
      stageDagPacket: firstDag,
      workerTaskPackets: [packet("one")],
      workspaceRoot: process.cwd(),
      durable: {
        enabled: true,
        kernel,
        mode: "create",
        taskFingerprint: "task-p118-bridge-binding",
        leaseMs: 1_000,
      },
      evidenceKind: "test_double",
      invokeWorker: async () => ({
        status: "pass",
        durationMs: 1,
        outputText: "one",
        outputSha256: "a".repeat(64),
      }),
    });
    await assert.rejects(
      runStageRunnerBridge({
        runId: "p118-bridge-binding",
        runtime: "codex",
        stageDagPacket: firstDag,
        workerTaskPackets: [packet("one")],
        workspaceRoot: process.cwd(),
        durable: {
          enabled: true,
          kernel,
          mode: "resume",
          taskFingerprint: "different-task",
        },
      }),
      /task binding mismatch/iu,
    );
    await assert.rejects(
      runStageRunnerBridge({
        runId: "p118-bridge-binding",
        runtime: "codex",
        stageDagPacket: dagFor(["one", "two"]),
        workerTaskPackets: [packet("one"), packet("two")],
        workspaceRoot: process.cwd(),
        durable: {
          enabled: true,
          kernel,
          mode: "resume",
          taskFingerprint: "task-p118-bridge-binding",
        },
      }),
      /graph binding mismatch/iu,
    );
  } finally {
    kernel.close();
  }
});

test("66 — completed worker and merge nodes atomically retain sanitized traversed edges once", async () => {
  const kernel = await openDurableRunKernel();
  const secret = "durable-secret-64925";
  const dag = buildStageDagPacket({
    stageOrder: ["Execution"],
    stageLanes: {
      Execution: [
        lane("a"),
        {
          ...lane("b"),
          dependsOn: [stageLaneNodeId("Execution", "a")],
        },
      ],
    },
    runtimeCapacity: 2,
  });
  const expectedEdges = dag.nodes
    .filter((node) => node.stage === "Execution")
    .flatMap((node) => node.dependsOn.map((fromNodeId) => ({
      fromNodeId,
      toNodeId: node.nodeId,
      laneKind: node.laneKind,
    })));
  let resumedInvocations = 0;
  try {
    const first = await runStageRunnerBridge({
      runId: "p118-atomic-traversed-edges",
      runtime: "codex",
      stageDagPacket: dag,
      workerTaskPackets: [packet("a"), packet("b")],
      workspaceRoot: process.cwd(),
      redactionEnv: { OPENAI_API_KEY: secret },
      durable: {
        enabled: true,
        kernel,
        mode: "create",
        taskFingerprint: "task-p118-atomic-traversed-edges",
        ownerId: "edge-owner-first",
        leaseMs: 1_000,
      },
      evidenceKind: "test_double",
      invokeWorker: async ({ packet: task }) => ({
        status: "pass",
        durationMs: 1,
        outputText: `${task.taskPacketId}:${process.cwd()}:API_KEY=${secret}`,
        outputSha256: "a".repeat(64),
        stderrTail: `PASSWORD=${secret}`,
      }),
    });
    assert.equal(first.status, "pass");
    const firstProjection = kernel.projectRun("p118-atomic-traversed-edges");
    assert.equal(firstProjection.edgeTraversals.length, expectedEdges.length);
    assert.equal(new Set(firstProjection.edgeTraversals.map((edge) => edge.traversalId)).size, expectedEdges.length);
    assert.equal(firstProjection.edgeTraversals.every(
      (edge) => /^[a-f0-9]{64}$/u.test(edge.conditionDigest),
    ), true);
    for (const expected of expectedEdges) {
      assert.equal(firstProjection.edgeTraversals.some((edge) =>
        edge.fromNodeId === expected.fromNodeId && edge.toNodeId === expected.toNodeId
      ), true);
    }
    assert.equal(expectedEdges.some((edge) => edge.laneKind === "execution_worker"), true);
    assert.equal(expectedEdges.some((edge) => edge.laneKind === "stage_merge"), true);
    const retained = JSON.stringify(firstProjection.completedNodes);
    assert.equal(retained.includes(secret), false);
    assert.equal(retained.includes(process.cwd()), false);

    const resumed = await runStageRunnerBridge({
      runId: "p118-atomic-traversed-edges",
      runtime: "codex",
      stageDagPacket: dag,
      workerTaskPackets: [packet("a"), packet("b")],
      workspaceRoot: process.cwd(),
      durable: {
        enabled: true,
        kernel,
        mode: "resume",
        taskFingerprint: "task-p118-atomic-traversed-edges",
        ownerId: "edge-owner-resume",
        leaseMs: 1_000,
      },
      evidenceKind: "test_double",
      invokeWorker: async () => {
        resumedInvocations += 1;
        throw new Error("completed nodes must not be invoked on resume");
      },
    });
    assert.equal(resumed.status, "pass");
    assert.equal(resumedInvocations, 0);
    assert.deepEqual(
      resumed.executionProjection.durable.projection.edgeTraversals,
      firstProjection.edgeTraversals,
    );
  } finally {
    kernel.close();
  }
});

test("66 — heartbeat failure is captured and an active claim still reaches terminal commit", async () => {
  const kernel = await openDurableRunKernel();
  const heartbeatNode = kernel.heartbeatNode.bind(kernel);
  let completeCalls = 0;
  kernel.heartbeatNode = () => {
    throw new Error("heartbeat transport failed");
  };
  const completeNode = kernel.completeNode.bind(kernel);
  kernel.completeNode = (args, options) => {
    completeCalls += 1;
    return completeNode(args, options);
  };
  try {
    const result = await runStageRunnerBridge({
      runId: "p118-heartbeat-captured",
      runtime: "codex",
      stageDagPacket: dagFor(["one"]),
      workerTaskPackets: [packet("one")],
      workspaceRoot: process.cwd(),
      durable: {
        enabled: true,
        kernel,
        mode: "create",
        taskFingerprint: "task-p118-heartbeat-captured",
        ownerId: "heartbeat-owner",
        leaseMs: 1_000,
        heartbeatIntervalMs: 5,
      },
      evidenceKind: "test_double",
      invokeWorker: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          status: "pass",
          durationMs: 20,
          outputText: "one",
          outputSha256: "a".repeat(64),
        };
      },
    });
    assert.equal(result.status, "pass");
    assert.equal(completeCalls, 2);
    assert.equal(
      result.workerResults[0].heartbeatFailure.failureClass,
      "durable_heartbeat_failed",
    );
  } finally {
    kernel.heartbeatNode = heartbeatNode;
    kernel.close();
  }
});

test("66 — terminal commit failure returns a structured fail-closed bridge result", async () => {
  const kernel = await openDurableRunKernel();
  const completeNode = kernel.completeNode.bind(kernel);
  kernel.completeNode = (args, options) => {
    if (args.nodeId.endsWith(":lane:one")) throw new Error("terminal commit persistence failed");
    return completeNode(args, options);
  };
  try {
    const result = await runStageRunnerBridge({
      runId: "p118-terminal-commit-failed",
      runtime: "codex",
      stageDagPacket: dagFor(["one"]),
      workerTaskPackets: [packet("one")],
      workspaceRoot: process.cwd(),
      durable: {
        enabled: true,
        kernel,
        mode: "create",
        taskFingerprint: "task-p118-terminal-commit-failed",
        ownerId: "terminal-owner",
        leaseMs: 1_000,
      },
      evidenceKind: "test_double",
      invokeWorker: async () => ({
        status: "pass",
        durationMs: 1,
        outputText: "one",
        outputSha256: "a".repeat(64),
      }),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failure.failureClass, "durable_terminal_commit_failed");
    assert.equal(result.nodeRecords[0].status, "failed");
    assert.equal(result.nodeRecords[0].failureClass, "durable_terminal_commit_failed");
    assert.equal(result.workerResults.length, 0);
  } finally {
    kernel.close();
  }
});

test("66 — resume blocks before invocation while a prior node lease is still active", async () => {
  const kernel = await openDurableRunKernel();
  const dag = dagFor(["one"]);
  let invoked = false;
  try {
    kernel.createRun({
      runId: "p118-active-lease-block",
      graphDigest: dag.graphDigest,
      taskFingerprint: "task-p118-active-lease-block",
    });
    kernel.claimNode({
      runId: "p118-active-lease-block",
      nodeId: dag.nodes.find((node) => node.laneKind === "execution_worker").nodeId,
      nodeDefinitionHash: "node-definition",
      inputHash: "input",
      dependencyOutputHash: "dependencies",
      ownerId: "prior-owner",
      leaseMs: 60_000,
    });
    await assert.rejects(
      runStageRunnerBridge({
        runId: "p118-active-lease-block",
        runtime: "codex",
        stageDagPacket: dag,
        workerTaskPackets: [packet("one")],
        workspaceRoot: process.cwd(),
        durable: {
          enabled: true,
          kernel,
          mode: "resume",
          taskFingerprint: "task-p118-active-lease-block",
          ownerId: "resume-owner",
        },
        invokeWorker: async () => {
          invoked = true;
          throw new Error("must not invoke before lease expiry");
        },
      }),
      /blocked_until_lease_expiry/iu,
    );
    assert.equal(invoked, false);
  } finally {
    kernel.close();
  }
});

test("66 — child process kill after A commit resumes only B after lease expiry and merges once", async (t) => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-p118-bridge-"));
  let inspectionKernel = null;
  t.after(() => {
    inspectionKernel?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });
  const dbPath = path.join(tempRoot, "durable.sqlite");
  const invocationLog = path.join(tempRoot, "invocations.log");
  const childPath = path.join(tempRoot, "durable-bridge-child.mjs");
  const childSource = `
    import { appendFileSync } from "node:fs";
    import { runStageRunnerBridge } from ${JSON.stringify(BRIDGE_URL)};
    import { openDurableRunKernel } from ${JSON.stringify(KERNEL_URL)};
    import { buildStageDagPacket } from ${JSON.stringify(DAG_URL)};

    const [phase, dbPath, invocationLog] = process.argv.slice(2);
    const lane = (taskPacketId) => ({
      laneId: taskPacketId,
      laneKind: "execution_worker",
      ownerBindingRef: \`owner:\${taskPacketId}\`,
      capabilityBindingRef: \`capability:\${taskPacketId}\`,
      effectClass: "read_only_worker",
      resourceScopes: [\`file:\${taskPacketId}.txt\`],
      isolation: "shared_read_only",
      status: "planned_not_invoked",
    });
    const packet = (taskPacketId) => ({
      taskPacketId,
      ownerAgent: "test-automator",
      description: \`Read \${taskPacketId}.txt\`,
      output: "observed value",
      dependsOn: [],
      executionMode: "primary_execution",
      externalWriteBoundary: false,
    });
    const dag = buildStageDagPacket({
      stageOrder: ["Execution"],
      stageLanes: { Execution: [lane("a"), lane("b")] },
      runtimeCapacity: 2,
    });
    const kernel = await openDurableRunKernel(dbPath);
    if (phase === "first") {
      const completeNode = kernel.completeNode.bind(kernel);
      kernel.completeNode = (args, options) => {
        const completed = completeNode(args, options);
        if (args.nodeId.endsWith(":lane:a")) process.exit(86);
        return completed;
      };
    }
    const result = await runStageRunnerBridge({
      runId: "p118-child-kill-resume",
      runtime: "codex",
      stageDagPacket: dag,
      workerTaskPackets: [packet("a"), packet("b")],
      workspaceRoot: process.cwd(),
      capacity: 2,
      durable: {
        enabled: true,
        kernel,
        mode: phase === "first" ? "create" : "resume",
        taskFingerprint: "task-p118-child-kill-resume",
        ownerId: \`bridge-\${phase}\`,
        leaseMs: 60,
        heartbeatIntervalMs: 15,
      },
      evidenceKind: "child_process_test_double",
      invokeWorker: async ({ packet: task }) => {
        appendFileSync(invocationLog, \`\${phase}:\${task.taskPacketId}\\n\`);
        if (phase === "first" && task.taskPacketId === "b") {
          await new Promise(() => {});
        }
        const outputText = \`\${phase}:\${task.taskPacketId}:observed\`;
        return {
          status: "pass",
          runtime: "codex",
          exitCode: 0,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 1,
          sessionId: \`session-\${phase}-\${task.taskPacketId}\`,
          messageId: \`message-\${phase}-\${task.taskPacketId}\`,
          outputText,
          outputSha256: "a".repeat(64),
          rawOutputSha256: "b".repeat(64),
          hostEventCount: 1,
          toolEventCount: 1,
          stderrTail: "",
        };
      },
    });
    process.stdout.write(JSON.stringify({
      status: result.status,
      nodeRecords: result.nodeRecords,
      executionProjection: result.executionProjection,
    }));
    kernel.close();
  `;
  writeFileSync(childPath, childSource, "utf8");

  const first = spawnSync(process.execPath, [childPath, "first", dbPath, invocationLog], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(first.status, 86, first.stderr || first.stdout);

  await new Promise((resolve) => setTimeout(resolve, 120));
  const resumed = spawnSync(process.execPath, [childPath, "resume", dbPath, invocationLog], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  const summary = JSON.parse(resumed.stdout);
  assert.equal(summary.status, "pass");
  assert.equal(summary.executionProjection.durable.resumed, true);
  assert.equal(summary.nodeRecords.filter((record) => record.laneKind === "stage_merge").length, 1);
  assert.equal(
    summary.nodeRecords.find((record) => record.nodeId.endsWith(":lane:a")).outputText,
    "first:a:observed",
  );
  assert.deepEqual(
    summary.nodeRecords.find((record) => record.laneKind === "stage_merge").mergedTaskPacketIds,
    ["a", "b"],
  );

  const invocations = readFileSync(invocationLog, "utf8").trim().split(/\r?\n/u);
  assert.deepEqual(invocations.filter((line) => line.endsWith(":a")), ["first:a"]);
  assert.deepEqual(invocations.filter((line) => line.endsWith(":b")), ["first:b", "resume:b"]);

  inspectionKernel = await openDurableRunKernel(dbPath);
  const projection = inspectionKernel.projectRun("p118-child-kill-resume");
  const completedEvents = projection.events.filter((event) => event.eventType === "NodeAttemptCompleted");
  assert.equal(completedEvents.filter((event) => event.nodeId.endsWith(":lane:a")).length, 1);
  assert.equal(completedEvents.filter((event) => event.nodeId.endsWith(":lane:b")).length, 1);
  assert.equal(completedEvents.filter((event) => event.nodeId.endsWith(":merge")).length, 1);
  assert.equal(
    projection.events.filter((event) => event.eventType === "NodeAttemptAbandoned").length,
    1,
  );
  inspectionKernel.close();
  inspectionKernel = null;
});
