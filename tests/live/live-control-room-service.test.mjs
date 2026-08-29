import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import test from "node:test";

import {
  buildLiveSnapshot,
  createLiveControlRoomServer,
  createLiveControlRoomService,
  resolveLiveProjectRoot,
} from "../../scripts/meta-kim-live.mjs";
import { createLiveContinuationCommand } from "../../src/domain/live/live-continuation-command.mjs";
import { createLiveRuntimeAdapterRegistry, createFakeLiveRuntimeAdapter } from "../../src/infrastructure/live/live-runtime-adapter-registry.mjs";
import { createLiveContinuationCommandStore } from "../../src/infrastructure/live/live-continuation-command-store.mjs";
import { createLiveContinuationPlanner } from "../../src/application/live/plan-live-continuation.mjs";
import { buildLiveCompactProjection } from "../../src/application/live/live-control-room-service.mjs";
import { renderLiveReadmeEmbed } from "../../src/presentation/live/render-live-share-card.mjs";

test("does not present an unproven completed node as verified completion", () => {
  const durableStatus = {
    ...sampleStatus(),
    lifecycleStatus: "completed",
    active: false,
    stages: { critical: { status: "completed" } },
  };
  const snapshot = buildLiveSnapshot({
    durableStatus,
    governedArtifact: null,
    observedAt: "2026-08-24T01:01:00.000Z",
  });
  assert.equal(snapshot.run.status, "in_doubt");
  assert.equal(snapshot.nodes.some((node) => node.kind === "stage"), false);
});

test("re-sanitizes hostile compact projections before exposing the public snapshot", () => {
  const snapshot = buildLiveSnapshot({
    governedArtifact: {
      schemaVersion: "meta-kim-live-projection-v2",
      run: {
        runId: "explicit-safe-run",
        title: "password=must-not-leak",
        task: "C:/Users/Kim/private/task.txt",
        status: "active",
        currentStage: "execution",
      },
      session: {
        title: "Safe session",
        runtime: "secret=must-not-leak",
        mode: "C:/Users/Kim/private/mode",
      },
      nodes: [
        {
          id: "agent:known",
          kind: "agent",
          label: "token=must-not-leak",
          status: "active",
          ownerAgent: "C:/Users/Kim/private/owner",
          runtimeObservation: { state: "observed", value: "C:/Users/Kim/private/runtime" },
        },
        { id: "../../escape", kind: "agent", label: "unsafe node" },
      ],
      edges: [
        { from: "agent:known", to: "agent:missing", kind: "contains" },
        { from: "../../escape", to: "agent:known", kind: "depends_on" },
      ],
      evidence: [{ id: "proof:known", nodeId: "agent:known", label: "file:///Users/Kim/private/evidence" }],
      replay: [{ id: "event:known", nodeId: "agent:missing", at: "2026-08-24T01:00:00.000Z", label: "secret=must-not-leak" }],
      prompts: [{ nodeId: "agent:known", summary: "password=must-not-leak" }],
      toolCalls: [{ id: "tool:known", nodeId: "agent:known", name: "C:/Users/Kim/private/tool.exe" }],
      provenance: [{ nodeId: "agent:known", kind: "secret=must-not-leak" }],
      contextTransfers: [],
    },
  });

  const publicBytes = JSON.stringify(snapshot);
  assert.doesNotMatch(publicBytes, /must-not-leak|Users[\\/]Kim|private[\\/]|tool\.exe|\.\.\/\.\.\/escape/u);
  assert.equal(snapshot.run.runId, "explicit-safe-run");
  assert.deepEqual(snapshot.edges, []);
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.replay[0].nodeId, null);
});

test("redacts whitespace-delimited credentials and punctuation-prefixed POSIX paths", () => {
  const snapshot = buildLiveSnapshot({
    governedArtifact: {
      schemaVersion: "meta-kim-live-projection-v2",
      run: {
        runId: "hostile-public-text-run",
        title: "Bearer opaqueSecret123456",
        task: "password hunter2",
        status: "active",
        currentStage: "execution",
      },
      session: {
        title: "token abcdefghijklmnop",
        activity: "path=/home/kim/.ssh/id_rsa",
        runtime: "codex",
        mode: "token budget",
        proofState: "secret sauce",
      },
      nodes: [{
        id: "agent:known",
        kind: "agent",
        label: "api key Abcdef12",
        summary: "password manager",
        status: "active",
        ownerAgent: "meta-warden",
      }],
      edges: [],
      evidence: [],
      replay: [],
      prompts: [],
      toolCalls: [],
      provenance: [],
      contextTransfers: [],
    },
  });

  const publicBytes = JSON.stringify(snapshot);
  assert.doesNotMatch(publicBytes, /opaqueSecret123456|hunter2|abcdefghijklmnop|home[\\/]kim|id_rsa|Abcdef12/u);
  assert.equal(snapshot.run.title, "redacted");
  assert.equal(snapshot.run.task, "redacted");
  assert.equal(snapshot.session.activity, "[path omitted]");
  assert.equal(snapshot.session.mode, "token budget");
  assert.equal(snapshot.session.proofState, "secret sauce");
  assert.equal(snapshot.nodes[0].summary, "password manager");
});

test("requires bound passing structured evidence before projecting completion", () => {
  const observedAt = "2026-08-24T01:00:00.000Z";
  const unproven = buildLiveSnapshot({
    governedArtifact: {
      schemaVersion: "governed-execution-v1",
      runId: "meta-unproven-evidence",
      status: "completed",
      updatedAt: observedAt,
      workerTaskPackets: [{
        taskPacketId: "task-unproven",
        roleDisplayName: "backend",
        stage: "execution",
        evidenceRefs: ["does-not-exist"],
      }],
      workerResultPackets: [{ taskPacketId: "task-unproven", status: "completed" }],
      verificationPacket: {
        evidence: [""],
        verificationResults: [{ result: "failed" }],
      },
    },
    observedAt,
  });

  assert.equal(unproven.run.status, "in_doubt");
  assert.equal(
    unproven.nodes.find((node) => node.label === "backend" && node.isMain === false)?.status,
    "in_doubt",
  );
  assert.equal(unproven.nodes.some((node) => node.kind === "stage"), false);

  const proven = buildLiveSnapshot({
    governedArtifact: {
      schemaVersion: "governed-execution-v1",
      runId: "meta-proven-evidence",
      status: "completed",
      updatedAt: observedAt,
      workerTaskPackets: [{
        taskPacketId: "task-proven",
        roleDisplayName: "backend",
        stage: "execution",
        evidenceRefs: ["workerResultPackets.task-proven.workerExecutionEvidence[0]"],
      }],
      workerResultPackets: [{
        taskPacketId: "task-proven",
        status: "completed",
        workerExecutionEvidence: [{ status: "passed", result: "passed" }],
      }],
      verificationPacket: {
        verificationResults: [{ status: "passed", result: "passed" }],
      },
    },
    observedAt,
  });

  assert.equal(proven.run.status, "completed");
  assert.equal(
    proven.nodes.find((node) => node.label === "backend" && node.isMain === false)?.status,
    "completed",
  );
  assert.ok(proven.evidence.some((item) => item.status === "completed"));
});

test("binds projected evidence only to hashed known worker nodes without accepting hostile ids", () => {
  const snapshot = buildLiveSnapshot({
    durableStatus: {
      ...sampleStatus(),
      evidence: [{ label: "global durable status", nodeId: "worker:unknown" }],
    },
    governedArtifact: {
      ...sampleArtifact(),
      verificationPacket: {
        evidence: ["verification record"],
        verificationResults: [{
          status: "passed",
          taskPacketId: "task-backend-1",
          stage: "execution",
        }],
      },
      reviewPacket: {
        findings: [
          { status: "open", nodeId: "worker:unknown" },
          { status: "open", nodeId: "worker:../hostile" },
        ],
      },
    },
    observedAt: "2026-08-24T01:01:00.000Z",
  });

  const knownNodeIds = new Set(snapshot.nodes.map((node) => node.id));
  assert.ok(snapshot.evidence.every((item) => knownNodeIds.has(item.nodeId)));
  assert.ok(snapshot.nodes.every((node) => /^(?:agent|workflow):[a-f0-9]{20}$/u.test(node.id)));
  assert.doesNotMatch(JSON.stringify(snapshot), /unknown|hostile|\.\./u);
});

async function makeProject({ status, artifact, latest } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-"));
  await mkdir(path.join(root, ".git"));
  const stateDir = path.join(root, ".meta-kim", "state", "default");
  await mkdir(path.join(stateDir, "governed-executions"), { recursive: true });
  if (status) {
    await writeFile(path.join(stateDir, "active-run.json"), JSON.stringify(status), "utf8");
  }
  if (artifact) {
    await writeFile(
      path.join(stateDir, "governed-executions", `${artifact.runId}.json`),
      JSON.stringify(artifact),
      "utf8",
    );
  }
  if (latest) {
    await writeFile(
      path.join(stateDir, "governed-executions", "latest.json"),
      JSON.stringify(latest),
      "utf8",
    );
  }
  return root;
}

function sampleStatus(runId = "meta-live-1") {
  return {
    schemaVersion: 2,
    active: true,
    lifecycleStatus: "active",
    runId,
    currentStage: "Execution",
    currentStageKey: "execution",
    updatedAt: "2026-08-24T01:00:00.000Z",
    startedAt: "2026-08-24T00:59:00.000Z",
    stages: {
      critical: { status: "completed" },
      fetch: { status: "completed" },
      thinking: { status: "completed" },
      execution: { status: "in_progress" },
    },
  };
}

function sampleArtifact(runId = "meta-live-1") {
  return {
    schemaVersion: "governed-execution-v1",
    runId,
    status: "in_progress",
    updatedAt: "2026-08-24T01:00:00.000Z",
    workerTaskPackets: [
      {
        taskPacketId: "task-backend-1",
        roleDisplayName: "backend",
        ownerAgent: "meta-conductor",
        stage: "execution",
        dependsOn: [],
        evidenceRefs: ["verificationPacket.evidence[0]"],
      },
    ],
    workerResultPackets: [
      {
        taskPacketId: "task-backend-1",
        status: "completed",
        workerExecutionEvidence: [{ status: "passed", passClaim: "Focused worker verification passed" }],
      },
    ],
    verificationPacket: {
      evidence: ["focused test passed"],
      verificationResults: [{ status: "passed", label: "contract test" }],
    },
    replay: [
      {
        sequence: 1,
        at: "2026-08-24T00:59:00.000Z",
        kind: "stage",
        nodeId: "stage:execution",
        status: "in_progress",
        label: "Execution",
        runId,
      },
    ],
  };
}

test("snapshot v2 exposes stable unavailable repository, workspace, and context transfer fields", () => {
  const snapshot = buildLiveSnapshot({ observedAt: "2026-08-24T01:01:00.000Z" });
  assert.deepEqual(snapshot.repository, {
    name: { state: "unavailable", value: null },
    branch: { state: "unavailable", value: null },
    worktree: { state: "unavailable", value: null },
    pullRequest: { state: "unavailable", value: null },
    diff: { state: "unavailable", value: null },
  });
  assert.deepEqual(snapshot.workspace, {
    name: { state: "unavailable", value: null },
    workspaceId: { state: "unavailable", value: null },
    transcript: { state: "unavailable", value: null },
    terminal: { state: "unavailable", value: null },
  });
  assert.deepEqual(snapshot.contextTransfers, []);
});

test("depends_on creates a planned context transfer with unavailable payload truth", () => {
  const artifact = sampleArtifact("meta-context-planned");
  artifact.workerTaskPackets.push({
    taskPacketId: "task-frontend-1",
    roleDisplayName: "frontend",
    stage: "execution",
    dependsOn: ["task-backend-1"],
  });
  const snapshot = buildLiveSnapshot({ governedArtifact: artifact, observedAt: "2026-08-24T01:01:00.000Z" });
  assert.equal(snapshot.contextTransfers.length, 1);
  const transfer = snapshot.contextTransfers[0];
  const backend = snapshot.nodes.find((node) => node.roleDisplayName === "backend");
  const frontend = snapshot.nodes.find((node) => node.roleDisplayName === "frontend");
  assert.deepEqual(transfer, {
    id: transfer.id,
    fromNodeId: backend.id,
    toNodeId: frontend.id,
    kind: "dependency",
    state: "planned",
    summaryCount: null,
    decisionCount: null,
    fileCount: null,
    evidenceCount: null,
    observedAt: null,
    digest: null,
    bytes: null,
    compactionState: "unavailable",
    omittedCount: null,
    omissionReason: null,
    downstreamAcceptanceState: "unavailable",
    evidenceRefs: [],
  });
  assert.match(transfer.id, /^transfer:[a-f0-9]{20}$/u);
  assert.equal(snapshot.counts.contextTransfers, 1);
});

test("projects same-run observed and accepted structured context handoffs", () => {
  const artifact = sampleArtifact("meta-context-observed");
  artifact.workerTaskPackets.push({
    taskPacketId: "task-frontend-1",
    roleDisplayName: "frontend",
    stage: "execution",
    dependsOn: ["task-backend-1"],
  });
  artifact.repository = {
    branch: { state: "observed", value: "feature/live-context" },
    worktree: { state: "observed", value: "dirty" },
  };
  artifact.workspace = {
    workspaceId: { state: "observed", value: "workspace-17" },
    transcript: { state: "observed", value: "available" },
  };
  artifact.contextHandoffs = [{
    runId: artifact.runId,
    fromTaskPacketId: "task-backend-1",
    toTaskPacketId: "task-frontend-1",
    kind: "implementation_handoff",
    state: "accepted",
    summaryCount: 3,
    decisionCount: 2,
    fileCount: 4,
    evidenceCount: 2,
    observedAt: "2026-08-24T01:00:30.000Z",
    digest: "a".repeat(64),
    bytes: 4096,
    compactionState: "compacted",
    omittedCount: 1,
    omissionReason: "One duplicate summary omitted",
    downstreamAcceptanceState: "accepted",
    evidenceRefs: ["handoff:evidence:1", "handoff:evidence:2"],
  }];
  const snapshot = buildLiveSnapshot({ governedArtifact: artifact, observedAt: "2026-08-24T01:01:00.000Z" });
  assert.deepEqual(snapshot.repository.branch, { state: "observed", value: "feature/live-context" });
  assert.deepEqual(snapshot.repository.pullRequest, { state: "unavailable", value: null });
  assert.deepEqual(snapshot.workspace.workspaceId, { state: "observed", value: "workspace-17" });
  assert.deepEqual(snapshot.workspace.terminal, { state: "unavailable", value: null });
  assert.equal(snapshot.contextTransfers.length, 1);
  assert.deepEqual(snapshot.contextTransfers[0], {
    ...snapshot.contextTransfers[0],
    kind: "implementation_handoff",
    state: "accepted",
    summaryCount: 3,
    decisionCount: 2,
    fileCount: 4,
    evidenceCount: 2,
    observedAt: "2026-08-24T01:00:30.000Z",
    digest: "a".repeat(64),
    bytes: 4096,
    compactionState: "compacted",
    omittedCount: 1,
    omissionReason: "One duplicate summary omitted",
    downstreamAcceptanceState: "accepted",
    evidenceRefs: ["handoff:evidence:1", "handoff:evidence:2"],
  });
});

test("accepted context state requires downstream acceptance plus safe evidence", () => {
  const artifact = sampleArtifact("meta-context-acceptance-proof");
  artifact.workerTaskPackets.push(
    {
      taskPacketId: "task-frontend-1",
      roleDisplayName: "frontend",
      stage: "execution",
      dependsOn: ["task-backend-1"],
    },
    {
      taskPacketId: "task-test-1",
      roleDisplayName: "test",
      stage: "execution",
      dependsOn: ["task-frontend-1"],
    },
  );
  artifact.contextTransfers = [
    {
      runId: artifact.runId,
      fromTaskPacketId: "task-backend-1",
      toTaskPacketId: "task-frontend-1",
      state: "accepted",
      downstreamAcceptanceState: "pending",
      evidenceRefs: ["proof:raw-state-only"],
      observedAt: "2026-08-24T01:00:20.000Z",
    },
    {
      runId: artifact.runId,
      fromTaskPacketId: "task-frontend-1",
      toTaskPacketId: "task-test-1",
      state: "accepted",
      downstreamAcceptanceState: "accepted",
      evidenceRefs: [],
      observedAt: "2026-08-24T01:00:30.000Z",
    },
  ];
  const snapshot = buildLiveSnapshot({ governedArtifact: artifact, observedAt: "2026-08-24T01:01:00.000Z" });
  assert.deepEqual(snapshot.contextTransfers.map((transfer) => transfer.state), ["observed", "observed"]);
  assert.deepEqual(snapshot.contextTransfers.map((transfer) => transfer.downstreamAcceptanceState), ["pending", "accepted"]);
});

test("older compact projections receive a stable numeric context transfer count", () => {
  const compact = buildLiveCompactProjection(sampleArtifact("meta-old-compact-count"));
  delete compact.counts.contextTransfers;
  const snapshot = buildLiveSnapshot({ governedArtifact: compact, observedAt: "2026-08-24T01:01:00.000Z" });
  assert.equal(snapshot.counts.contextTransfers, 0);
  assert.equal(Number.isSafeInteger(snapshot.counts.contextTransfers), true);
});

test("older compact projections cannot preserve accepted context without acceptance evidence", () => {
  const compact = buildLiveCompactProjection(sampleArtifact("meta-old-compact-acceptance"));
  const backend = compact.nodes.find((node) => node.roleDisplayName === "backend");
  const main = compact.nodes.find((node) => node.isMain);
  compact.contextTransfers = [{
    id: `transfer:${"a".repeat(20)}`,
    fromNodeId: main.id,
    toNodeId: backend.id,
    kind: "context_handoff",
    state: "accepted",
    observedAt: "2026-08-24T01:00:30.000Z",
    digest: null,
    bytes: null,
    compactionState: "unavailable",
    omittedCount: null,
    omissionReason: null,
    downstreamAcceptanceState: "accepted",
    evidenceRefs: [],
  }];
  compact.counts.contextTransfers = 1;
  const snapshot = buildLiveSnapshot({ governedArtifact: compact, observedAt: "2026-08-24T01:01:00.000Z" });
  assert.equal(snapshot.contextTransfers[0].state, "observed");
});

test("rejects hostile, cross-run, path-bearing, and secret-bearing context handoffs", () => {
  const artifact = sampleArtifact("meta-context-rejected");
  artifact.workerTaskPackets.push({
    taskPacketId: "task-frontend-1",
    roleDisplayName: "frontend",
    stage: "execution",
    dependsOn: ["task-backend-1"],
  });
  const base = {
    runId: artifact.runId,
    fromTaskPacketId: "task-backend-1",
    toTaskPacketId: "task-frontend-1",
    observedAt: "2026-08-24T01:00:30.000Z",
  };
  artifact.contextTransfers = [
    { ...base, runId: "meta-foreign", state: "accepted" },
    { ...base, fromNodeId: "agent:../hostile", fromTaskPacketId: null, state: "observed" },
    { ...base, evidenceRefs: ["src/private/context.json"], state: "observed" },
    { ...base, omissionReason: "token=ghp_0123456789abcdefghijklmnopqrstuvwxyz", state: "observed" },
  ];
  artifact.repository = {
    observed: true,
    branch: "C:\\private\\repo",
    pullRequest: "PR 17",
  };
  artifact.workspace = {
    observed: true,
    transcript: "secret=super-secret",
    terminal: "C:\\private\\terminal.log",
  };
  const snapshot = buildLiveSnapshot({ governedArtifact: artifact, observedAt: "2026-08-24T01:01:00.000Z" });
  assert.equal(snapshot.contextTransfers.length, 1);
  assert.equal(snapshot.contextTransfers[0].state, "planned");
  assert.deepEqual(snapshot.repository.branch, { state: "unavailable", value: null });
  assert.deepEqual(snapshot.repository.pullRequest, { state: "observed", value: "PR 17" });
  assert.deepEqual(snapshot.workspace.transcript, { state: "unavailable", value: null });
  assert.deepEqual(snapshot.workspace.terminal, { state: "unavailable", value: null });
  assert.doesNotMatch(JSON.stringify(snapshot), /super-secret|ghp_|private[\\/]|hostile/iu);
});

function getWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "GET",
      headers: { host, connection: "close" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.once("error", reject);
    request.end();
  });
}

test("resolves only a marker-backed project root", async () => {
  const projectRoot = await makeProject();
  try {
    assert.equal(await resolveLiveProjectRoot({ cwd: projectRoot }), path.resolve(projectRoot));
    assert.equal(await resolveLiveProjectRoot({ cwd: path.join(projectRoot, ".meta-kim") }), path.resolve(projectRoot));
    const noRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-no-root-"));
    assert.equal(await resolveLiveProjectRoot({ cwd: noRoot, projectRoot: noRoot }), null);
    await rm(noRoot, { recursive: true, force: true });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("resolves the original caller project when the packaged CLI changes cwd", async () => {
  const projectRoot = await makeProject();
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-package-root-"));
  try {
    assert.equal(await resolveLiveProjectRoot({
      cwd: packageRoot,
      env: { META_KIM_CALLER_CWD: projectRoot },
    }), path.resolve(projectRoot));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("a newer governed artifact is not hidden by an older durable run", () => {
  const snapshot = buildLiveSnapshot({
    durableStatus: { ...sampleStatus("meta-old"), updatedAt: "2026-08-24T00:00:00.000Z" },
    governedArtifact: { ...sampleArtifact("meta-new"), updatedAt: "2026-08-24T01:00:00.000Z" },
    observedAt: "2026-08-24T01:01:00.000Z",
  });
  assert.equal(snapshot.run.runId, "meta-new");
  assert.equal(snapshot.source.kind, "governed_artifact");
});

test("an explicitly stopped durable run does not hide the latest governed artifact", () => {
  const snapshot = buildLiveSnapshot({
    durableStatus: { ...sampleStatus("meta-stopped"), active: false, lifecycleStatus: "session_stopped", updatedAt: "2026-08-24T02:00:00.000Z" },
    governedArtifact: { ...sampleArtifact("meta-governed"), updatedAt: "2026-08-24T01:00:00.000Z" },
    observedAt: "2026-08-24T02:01:00.000Z",
  });
  assert.equal(snapshot.run.runId, "meta-governed");
  assert.equal(snapshot.source.kind, "governed_artifact");
});

test("a future-dated durable run cannot hide the latest governed artifact", () => {
  const snapshot = buildLiveSnapshot({
    durableStatus: { ...sampleStatus("meta-future"), updatedAt: "2099-08-24T02:00:00.000Z" },
    governedArtifact: { ...sampleArtifact("meta-current"), updatedAt: "2026-08-24T01:00:00.000Z" },
    observedAt: "2026-08-24T02:01:00.000Z",
  });
  assert.equal(snapshot.run.runId, "meta-current");
  assert.equal(snapshot.source.kind, "governed_artifact");
});

test("foreign-run worker results and host evidence cannot contaminate the current snapshot", () => {
  const current = sampleArtifact("meta-current");
  current.workerTaskPackets[0].roleInstanceId = "exec-course-publish-1";
  current.workerResultPackets = [{
    runId: "meta-foreign",
    taskPacketId: "task-backend-1",
    status: "completed",
    workerExecutionEvidence: [{ status: "passed" }],
  }];
  current.hostInvocationEvidence = [{
    runId: "meta-foreign",
    taskPacketId: "task-backend-1",
    proofValid: true,
    synthetic: false,
    providerId: "canonical/runtime-assets/claude/mcp.json",
    runtime: "codex",
    model: "foreign-model",
    resultStatus: "completed",
    usage: { outputTokens: 999 },
  }];
  const snapshot = buildLiveSnapshot({ governedArtifact: current, observedAt: "2026-08-24T01:01:00.000Z" });
  const worker = snapshot.nodes.find((node) => node.isMain === false && node.kind === "agent");
  assert.equal(worker.label, "course-publish");
  assert.equal(worker.roleDisplayName, "backend");
  assert.equal(worker.status, "pending");
  assert.equal(worker.runtime, "unavailable");
  assert.equal(worker.model, "unavailable");
  assert.equal(worker.outputTokens, null);
  assert.equal(worker.toolCount, 0);
  assert.equal(snapshot.replay.some((event) => /canonical|foreign-model/iu.test(event.label)), false);
});

test("relative repository paths are redacted from tool and replay labels", () => {
  const current = sampleArtifact("meta-path-redaction");
  current.hostInvocationEvidence = [{
    runId: current.runId,
    taskPacketId: "task-backend-1",
    proofValid: true,
    synthetic: false,
    providerId: "canonical/runtime-assets/claude/mcp.json",
    resultStatus: "completed",
  }];
  const snapshot = buildLiveSnapshot({ governedArtifact: current, observedAt: "2026-08-24T01:01:00.000Z" });
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /canonical[\\/]runtime-assets/iu);
  assert.match(serialized, /\[path omitted\]/u);
});

test("builds the frozen projection and never exposes raw prompt/path data", async () => {
  const projectRoot = await makeProject({
    status: sampleStatus(),
    artifact: {
      ...sampleArtifact(),
      intentPacket: { realIntent: "do not show this raw prompt" },
      verificationPacket: {
        evidence: [
          `secret=super-secret /private/path\u0000`,
          "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
          "AKIAIOSFODNN7EXAMPLE",
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature",
          "/data/records/customer.json",
        ],
      },
      stagePurpose: "Confidential customer merger details that must not be displayed",
    },
    latest: {
      runId: "meta-live-1",
      jsonPath: ".meta-kim/state/default/governed-executions/meta-live-1.json",
    },
  });
  try {
    const service = createLiveControlRoomService({ projectRoot });
    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.schemaVersion, "meta-kim-live-snapshot-v2");
    assert.equal(snapshot.source.kind, "governed_artifact");
    assert.equal(snapshot.run.runId, "meta-live-1");
    assert.equal(snapshot.permissions.projectionOnly, true);
    assert.equal(snapshot.permissions.executionAllowed, false);
    assert.equal(snapshot.permissions.mutationAllowed, false);
    assert.ok(snapshot.nodes.some((node) => node.label === "backend"));
    assert.equal(snapshot.replay[0].runId, undefined);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /do not show this raw prompt|super-secret|\/private\/path|ghp_|AKIA|eyJhbGci|\/data\/records|customer merger/iu);
    assert.ok(serialized.length < 100_000);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("rejects cross-run artifacts and traversal run ids without reading outside state", async () => {
  const projectRoot = await makeProject({ status: sampleStatus("meta-live-1") });
  const outsidePath = path.join(path.dirname(projectRoot), "outside-secret.json");
  await writeFile(outsidePath, JSON.stringify({ secret: "must-not-read" }), "utf8");
  try {
    const service = createLiveControlRoomService({ projectRoot });
    const crossRun = await service.getReplay("meta-live-2");
    assert.deepEqual(crossRun.replay, []);
    const traversal = await service.getReplay("meta-..%2f..%2foutside-secret");
    assert.deepEqual(traversal.replay, []);
    assert.equal((await readFile(outsidePath, "utf8")).includes("must-not-read"), true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outsidePath, { force: true });
  }
});

test("server starts on a random loopback port, serves snapshot/replay, and closes", async () => {
  const projectRoot = await makeProject({ status: sampleStatus(), artifact: sampleArtifact(), latest: {
    runId: "meta-live-1",
    jsonPath: ".meta-kim/state/default/governed-executions/meta-live-1.json",
  } });
  let control;
  try {
    control = createLiveControlRoomServer({ projectRoot, port: 0 });
    const address = await control.start();
    assert.equal(address.host, "127.0.0.1");
    assert.ok(address.port > 0);
    const snapshotResponse = await fetch(`${address.url}/api/snapshot`);
    assert.equal(snapshotResponse.status, 200);
    assert.equal((await snapshotResponse.json()).schemaVersion, "meta-kim-live-snapshot-v2");
    const replayResponse = await fetch(`${address.url}/api/replay?runId=meta-live-1`);
    assert.equal(replayResponse.status, 200);
    assert.ok(Array.isArray((await replayResponse.json()).replay));
    const pageResponse = await fetch(address.url);
    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /data-live-graph/u);
    assert.match(pageResponse.headers.get("content-security-policy"), /default-src 'self'/u);
    const rebound = await getWithHost(address.url, "attacker.example");
    assert.equal(rebound.status, 403);
    assert.doesNotMatch(rebound.body, /meta-live-1/u);
    await control.close();
    control = null;
    await assert.rejects(fetch(`${address.url}/api/snapshot`));
  } finally {
    await control?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("a closed controller cannot be restarted and leak a listener", async () => {
  const control = createLiveControlRoomServer({ service: { getSnapshot: async () => null }, port: 0 });
  await control.close();
  await assert.rejects(control.start(), /closed/iu);
  assert.equal(control.server.listening, false);
});

test("historical replay consumes saved AG-UI stage events without current-run contamination", async () => {
  const artifact = sampleArtifact("meta-history");
  delete artifact.replay;
  artifact.agUiStageEvents = { events: [{
    timestamp: "2026-08-24T00:59:00.000Z",
    eventType: "StepFinished",
    stage: "Execution",
    status: "completed",
    userFacingLabel: "must be replaced by a safe structural label",
  }] };
  const repository = {
    readDurableStatus: async () => sampleStatus("meta-current"),
    readLatestArtifact: async () => artifact,
    readArtifact: async (runId) => runId === "meta-history" ? artifact : null,
  };
  const replay = await createLiveControlRoomService({ repository, clock: () => new Date("2026-08-24T01:00:00.000Z") }).getReplay("meta-history");
  assert.equal(replay.runId, "meta-history");
  assert.equal(replay.replay.length, 1);
  assert.equal(replay.replay[0].kind, "stage");
  assert.equal(replay.replay[0].nodeId, null);
  assert.doesNotMatch(replay.replay[0].label, /must be replaced/iu);
});

test("SSE emits an initial snapshot and has no mutation side effects", async () => {
  const projectRoot = await makeProject({ status: sampleStatus() });
  const before = await stat(path.join(projectRoot, ".meta-kim", "state", "default", "active-run.json"));
  try {
    const control = createLiveControlRoomServer({ projectRoot, port: 0 });
    const address = await control.start();
    const response = await fetch(`${address.url}/api/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/iu);
    const reader = response.body.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /data:/u);
    const payload = text.match(/data: (.+)\n/u)?.[1];
    assert.equal(JSON.parse(payload).schemaVersion, "meta-kim-live-snapshot-v2");
    await reader.cancel();
    await control.close();
    const after = await stat(path.join(projectRoot, ".meta-kim", "state", "default", "active-run.json"));
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("SSE broadcasts semantic snapshot changes from one shared observer loop", async () => {
  let version = 1;
  const service = {
    async getSnapshot() {
      return {
        schemaVersion: "meta-kim-live-snapshot-v1",
        source: { kind: "durable_status", observedAt: new Date().toISOString(), stale: false },
        run: { runId: "meta-live-sse", status: "active", currentStage: "execution", updatedAt: `2026-08-24T01:00:0${version}.000Z` },
        nodes: [], edges: [], evidence: [], replay: [],
        permissions: { projectionOnly: true, executionAllowed: false, mutationAllowed: false },
      };
    },
    async getReplay() { return null; },
  };
  const control = createLiveControlRoomServer({ service, port: 0, pollIntervalMs: 10 });
  const address = await control.start();
  const response = await fetch(`${address.url}/api/events`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let timeout;
  try {
    const first = decoder.decode((await reader.read()).value);
    assert.match(first, /2026-08-24T01:00:01\.000Z/u);
    version = 2;
    const second = await Promise.race([
      reader.read(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("SSE update timeout")), 1_000); }),
    ]);
    clearTimeout(timeout);
    timeout = null;
    assert.match(decoder.decode(second.value), /2026-08-24T01:00:02\.000Z/u);
  } finally {
    if (timeout) clearTimeout(timeout);
    await reader.cancel();
    await control.close();
  }
});

test("share export is deterministic, read-only, and supports a markdown card", async () => {
  const projectRoot = await makeProject({ status: sampleStatus(), artifact: sampleArtifact() });
  try {
    const service = createLiveControlRoomService({
      projectRoot,
      clock: () => new Date("2026-08-24T01:01:00.000Z"),
    });
    const first = await service.getShare();
    const second = await service.getShare();
    assert.equal(first.schemaVersion, "meta-kim-live-share-v1");
    assert.equal(first.permissions.executionAllowed, false);
    assert.equal(first.permissions.mutationAllowed, false);
    assert.deepEqual(first, second);
    const markdown = await service.getShare({ format: "markdown" });
    assert.match(markdown, /read-only/iu);
    assert.match(markdown, /Content digest:/u);
    const readme = await service.getShare({ format: "readme" });
    assert.equal(readme, renderLiveReadmeEmbed(first));
    assert.match(readme, /Live replay/iu);
    assert.doesNotMatch(markdown, /sampleArtifact|raw|secret|C:\\/iu);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("continuation plan and command execution are injected and separate", async () => {
  const projectRoot = await makeProject({ status: sampleStatus(), artifact: sampleArtifact() });
  const nowMs = 2_000;
  const command = createLiveContinuationCommand({
    action: "resume",
    runId: "run-live-service",
    nodeId: "node-live-service",
    expectedRevision: 1,
    checkpointId: null,
    effectState: "none",
    claim: { attemptId: "attempt-live-service", ownerId: "owner-live-service", leaseExpiresAtMs: 20_000, fenceToken: 1 },
    actor: "actor-live-service",
    runtimeAdapter: "fake-service",
    runtime: "fake",
    nonce: "nonce-live-service",
    issuedAtMs: 1_000,
    expiresAtMs: 10_000,
    payload: {},
  });
  let preparedEffectId = null;
  const repository = {
    resumeRun: () => ({
      runId: command.runId,
      status: "active",
      cursor: 1,
      headCheckpointId: null,
      resumable: true,
      activeClaims: [{ runId: command.runId, nodeId: command.nodeId, attemptId: "attempt-live-service", leaseOwner: "owner-live-service", leaseExpiresAtMs: 20_000, fenceToken: 1 }],
      blockingEffects: [],
    }),
    verifyEventChain: () => ({ ok: true }),
    prepareEffect: ({ effectId }) => { preparedEffectId = effectId; return { effectId, state: "prepared" }; },
    markEffectDispatchStarted: ({ effectId }) => ({ effectId, state: "dispatch_started" }),
    markUnresolvedEffectsInDoubt: ({ runId }) => ({ runId, effectIds: preparedEffectId ? [preparedEffectId] : [] }),
  };
  const calls = [];
  const adapterRegistry = createLiveRuntimeAdapterRegistry({ adapters: [createFakeLiveRuntimeAdapter({
    adapterId: "fake-service",
    runtime: "fake",
    execute: async (request) => { calls.push(request); return { accepted: true }; },
  })] });
  const planner = createLiveContinuationPlanner({ repository, adapterRegistry, nowMs });
  const commandStore = createLiveContinuationCommandStore({ projectRoot, clock: () => nowMs });
  try {
    const service = createLiveControlRoomService({ projectRoot, continuationPlanner: planner, durableRepository: repository, commandStore, adapterRegistry });
    const plan = await service.planContinuation(command);
    assert.equal(plan.status, "planned");
    assert.equal(calls.length, 0);
    const executed = await service.executeContinuation(plan, { nowMs });
    assert.equal(executed.status, "adapter_invoked");
    assert.equal(executed.completionVerified, false);
    assert.equal(calls.length, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
