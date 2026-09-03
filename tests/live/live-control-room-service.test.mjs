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
  assert.equal(
    snapshot.nodes.length,
    0,
    "a durable status with no artifact is not evidence of any agent, so no node may be synthesized",
  );
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
          capabilityTruth: [
            { kind: "hook", state: "observed", plannedNames: [], actualNames: ["fabricated-hook"], observation: "trusted_host_evidence" },
            { kind: "plugin", state: "observed", plannedNames: ["declared-plugin"], actualNames: ["fabricated-plugin"] },
            { kind: "dependency", state: "observed", plannedNames: [], actualNames: ["fabricated-dependency"] },
          ],
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
  assert.deepEqual(snapshot.nodes[0].capabilityTruth, [
    { kind: "hook", state: "planned", plannedNames: ["fabricated-hook"], actualNames: [] },
    { kind: "plugin", state: "planned", plannedNames: ["declared-plugin", "fabricated-plugin"], actualNames: [] },
    { kind: "dependency", state: "planned", plannedNames: ["fabricated-dependency"], actualNames: [] },
  ]);
  assert.equal(snapshot.nodes[0].capabilityTruth.some((record) => record.state === "observed" || record.actualNames.length), false);
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
        runId: "meta-proven-evidence",
        taskPacketId: "task-proven",
        status: "completed",
        workerExecutionEvidence: [{
          runId: "meta-proven-evidence",
          taskPacketId: "task-proven",
          status: "completed",
          result: "passed",
        }],
      }],
      verificationPacket: {
        verificationResults: [{ runId: "meta-proven-evidence", status: "passed", result: "passed" }],
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

test("public display distinguishes active queueing from inactive structural plans", () => {
  const runId = "meta-display-state-1";
  const artifact = {
    schemaVersion: "governed-execution-v1",
    runId,
    status: "pending",
    updatedAt: "2026-08-24T01:00:00.000Z",
    executionResult: { actualWorkerExecution: false, executionClosure: "planned_not_executed_by_runner" },
    workerTaskPackets: [{ taskPacketId: "task-display-1", roleDisplayName: "backend", status: "pending" }],
    workerResultPackets: [{
      taskPacketId: "task-display-1",
      status: "planned_not_executed",
      workerExecutionEvidence: [{
        status: "pending",
        observedResult: "not_run_by_structural_artifact_builder",
        evidenceKind: "structural_worker_plan",
      }],
    }],
  };
  const inactive = buildLiveSnapshot({ governedArtifact: artifact, observedAt: "2026-08-24T01:01:00.000Z" });
  const inactiveWorker = inactive.nodes.find((node) => node.isMain === false && node.kind === "agent");
  assert.equal(inactive.run.active, false);
  assert.equal(inactiveWorker.displayState, "unreported");
  assert.match(inactiveWorker.statusReason, /结构规划记录/u);

  const active = buildLiveSnapshot({
    durableStatus: { ...sampleStatus(runId), updatedAt: "2026-08-24T01:00:30.000Z" },
    governedArtifact: artifact,
    observedAt: "2026-08-24T01:01:00.000Z",
  });
  const activeWorker = active.nodes.find((node) => node.isMain === false && node.kind === "agent");
  assert.equal(active.run.active, true);
  assert.equal(activeWorker.displayState, "unreported");
});

test("legacy compact structural worker evidence remains unreported for run, workflow, and workers", () => {
  const runId = "meta-legacy-compact-structural-1";
  const snapshot = buildLiveSnapshot({
    governedArtifact: {
      schemaVersion: "governed-execution-v1",
      runId,
      status: "completed",
      updatedAt: "2026-08-30T09:00:00.000Z",
      workerTaskPackets: [{ taskPacketId: "legacy-structural-task", roleDisplayName: "backend" }],
      workerResultPackets: [{
        taskPacketId: "legacy-structural-task",
        status: "completed",
        workerExecutionEvidence: [{
          observedResult: "not_run_by_structural_artifact_builder",
          evidenceKind: "structural_worker_plan",
        }],
      }],
    },
    observedAt: "2026-08-30T09:01:00.000Z",
  });
  assert.equal(snapshot.run.executionEvidenceState, "structural_planning_only");
  assert.equal(snapshot.run.displayState, "unreported");
  assert.ok(snapshot.nodes.every((node) => node.displayState === "unreported"));
});

test("legacy compact detail-only structural evidence remains unreported", () => {
  const runId = "meta-legacy-compact-detail-1";
  const snapshot = buildLiveSnapshot({
    governedArtifact: {
      schemaVersion: "meta-kim-live-compact-v1",
      run: { runId, status: "in_doubt", executionEvidenceState: "recorded" },
      nodes: [
        { id: "agent:11111111111111111111", kind: "agent", isMain: true, status: "in_doubt" },
        {
          id: "agent:22222222222222222222",
          kind: "agent",
          isMain: false,
          status: "pending",
          workerExecutionEvidence: [{ status: "pending", detail: "not_run_by_structural_artifact_builder" }],
        },
      ],
      edges: [], evidence: [], replay: [], toolCalls: [], prompts: [], provenance: [], contextTransfers: [],
    },
    observedAt: "2026-08-30T09:01:00.000Z",
  });
  assert.equal(snapshot.run.executionEvidenceState, "structural_planning_only");
  assert.equal(snapshot.run.displayState, "unreported");
  assert.ok(snapshot.nodes.every((node) => node.displayState === "unreported"));
});

test("all trusted terminal states survive compact round-trip", () => {
  for (const terminalStatus of ["completed", "failed", "blocked", "cancelled"]) {
    const runId = `meta-terminal-roundtrip-${terminalStatus}`;
    const artifact = sampleArtifact(runId);
    artifact.status = terminalStatus;
    artifact.workerResultPackets[0].status = terminalStatus;
    artifact.workerResultPackets[0].workerExecutionEvidence[0].status = terminalStatus;
    if (terminalStatus !== "completed") artifact.verificationPacket = { verificationResults: [] };
    const compact = buildLiveCompactProjection(artifact);
    const snapshot = buildLiveSnapshot({ governedArtifact: compact, observedAt: "2026-08-24T01:01:00.000Z" });
    assert.equal(snapshot.nodes.find((node) => node.kind === "agent" && node.isMain === false)?.displayState, terminalStatus);
  }
});

test("durable host lifecycle projects verified queued active completed and stopped-unreported states", () => {
  const runId = "meta-production-lifecycle-1";
  const base = {
    ...sampleStatus(runId),
    updatedAt: "2026-08-24T01:00:30.000Z",
    sourceRuntime: "codex",
    conversationLinkState: "verified",
    sourceConversation: {
      runtime: "codex",
      conversationId: "thread-production-lifecycle-1",
      runId,
    },
    workerTaskPackets: [{
      runId,
      taskPacketId: "task-production-backend",
      roleDisplayName: "backend",
    }],
  };
  const snapshotFor = (workerLifecycle, overrides = {}) => buildLiveSnapshot({
    durableStatus: { ...base, workerLifecycle, ...overrides },
    observedAt: "2026-08-24T01:01:00.000Z",
  });

  const queued = snapshotFor([{
    runId,
    taskPacketId: "task-production-backend",
    roleDisplayName: "backend",
    status: "queued",
    updatedAt: "2026-08-24T01:00:31.000Z",
    terminalEvidence: [],
  }]);
  assert.equal(queued.run.conversationLinkState, "verified");
  assert.equal(queued.run.verifiedLinks[0].conversationRef, "thread-production-lifecycle-1");
  assert.equal(queued.nodes.find((node) => node.isMain === false).displayState, "queued");

  const active = snapshotFor([{
    runId,
    taskPacketId: "task-production-backend",
    roleDisplayName: "backend",
    status: "active",
    runtime: "codex",
    updatedAt: "2026-08-24T01:00:32.000Z",
    invocationIds: ["call-production-backend"],
    terminalEvidence: [],
  }]);
  assert.equal(active.nodes.find((node) => node.isMain === false).displayState, "active");

  const terminalEvidence = {
    runId,
    taskPacketId: "task-production-backend",
    runtime: "codex",
    status: "completed",
    resultStatus: "completed",
    proofValid: true,
    synthetic: false,
    evidenceKind: "host_worker_lifecycle",
    occurredAt: "2026-08-24T01:00:33.000Z",
  };
  const completed = snapshotFor([{
    runId,
    taskPacketId: "task-production-backend",
    roleDisplayName: "backend",
    status: "completed",
    runtime: "codex",
    updatedAt: terminalEvidence.occurredAt,
    terminalEvidence: [terminalEvidence],
  }]);
  assert.equal(completed.nodes.find((node) => node.isMain === false).displayState, "completed");

  const stopped = snapshotFor([{
    runId,
    taskPacketId: "task-production-backend",
    roleDisplayName: "backend",
    status: "queued",
    updatedAt: "2026-08-24T01:00:31.000Z",
    terminalEvidence: [],
  }], {
    active: false,
    lifecycleStatus: "session_stopped",
    status: "session_stopped",
    deactivationReason: "session_stop",
    deactivatedAt: "2026-08-24T01:00:40.000Z",
    updatedAt: "2026-08-24T01:00:40.000Z",
  });
  assert.equal(stopped.run.active, false);
  assert.equal(stopped.nodes.find((node) => node.isMain === false).displayState, "unreported");
});

test("conversation candidates remain candidates and cannot promote completion", () => {
  const snapshot = buildLiveSnapshot({
    governedArtifact: {
      schemaVersion: "governed-execution-v1",
      runId: "meta-candidate-link-1",
      status: "completed",
      conversationCandidates: [{
        runtime: "claude",
        sessionId: "claude-candidate-20260830",
        title: "Similar task title",
        matchBasis: "title_time_project_similarity",
      }],
      workerTaskPackets: [{ taskPacketId: "candidate-task-1", status: "completed" }],
      workerResultPackets: [{ taskPacketId: "candidate-task-1", status: "completed" }],
    },
  });
  assert.equal(snapshot.run.status, "in_doubt");
  assert.equal(snapshot.run.conversationLinkState, "candidate");
  assert.equal(snapshot.run.verifiedLinks.length, 0);
  assert.equal(snapshot.run.candidateLinks[0].sourceRuntime, "claude");
});

test("foreign bound terminal evidence cannot complete a local worker", () => {
  const snapshot = buildLiveSnapshot({
    governedArtifact: {
      schemaVersion: "governed-execution-v1",
      runId: "meta-local-evidence-1",
      status: "completed",
      workerTaskPackets: [{ taskPacketId: "task-local-1", roleDisplayName: "verify", status: "completed" }],
      workerResultPackets: [{
        runId: "meta-local-evidence-1",
        taskPacketId: "task-local-1",
        status: "completed",
        workerExecutionEvidence: [{
          runId: "meta-foreign-evidence-1",
          taskPacketId: "task-local-1",
          status: "passed",
        }],
      }],
      verificationPacket: {
        verificationResults: [{ runId: "meta-foreign-evidence-1", status: "passed" }],
      },
    },
  });
  assert.equal(snapshot.run.status, "in_doubt");
  assert.equal(snapshot.nodes.find((node) => node.roleDisplayName === "verify")?.status, "in_doubt");
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
  assert.doesNotMatch(JSON.stringify(snapshot), /worker:unknown|worker:\.\.\/hostile|\.\.\/hostile/u);
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
        runId,
        taskPacketId: "task-backend-1",
        status: "completed",
        workerExecutionEvidence: [{
          runId,
          taskPacketId: "task-backend-1",
          status: "completed",
          passClaim: "Focused worker verification passed",
        }],
      },
    ],
    verificationPacket: {
      evidence: ["focused test passed"],
      verificationResults: [{ runId, status: "passed", label: "contract test" }],
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

test("carries the recorded capacity wave plan into the snapshot without leaking packets or paths", () => {
  const artifact = sampleArtifact();
  artifact.workerTaskPackets.push({
    taskPacketId: "task-frontend-1",
    roleDisplayName: "frontend",
    ownerAgent: "meta-conductor",
    stage: "execution",
    dependsOn: [],
  });
  artifact.coreLoop = {
    agentTeamsPlaybookPacket: {
      maxParallelAgents: 2,
      requestedParallelAgents: 8,
      runtimeCapacity: 2,
      capacitySourceKind: "active_config",
      capacitySource: "C:/Users/Kim/.codex/config.toml",
      waves: [{
        waveId: "agent-team-wave-1",
        mode: "primary_parallel_wave",
        parallelCount: 2,
        mergeOwner: "meta-conductor",
        taskPacketIds: ["task-backend-1", "task-frontend-1"],
      }],
    },
  };

  const projection = buildLiveCompactProjection(artifact);
  const projectionNodeIds = new Set(projection.nodes.map((node) => node.id));
  assert.equal(projection.scheduling.provenance, "planned");
  assert.equal(projection.scheduling.waves[0].nodeIds.length, 2);
  assert.equal(projection.scheduling.waves[0].nodeIds.every((id) => projectionNodeIds.has(id)), true);
  assert.equal(projection.scheduling.capacity.throttled, true);
  const serialized = JSON.stringify(projection.scheduling);
  assert.equal(serialized.includes("task-backend-1"), false);
  assert.equal(serialized.includes("config.toml"), false);

  const snapshot = buildLiveSnapshot({ governedArtifact: artifact });
  const snapshotNodeIds = new Set(snapshot.nodes.map((node) => node.id));
  assert.equal(snapshot.scheduling.waveCount, 1);
  assert.equal(snapshot.scheduling.waves[0].nodeIds.every((id) => snapshotNodeIds.has(id)), true);
});

test("a stored projection cannot relabel its wave order as observed or keep naming a dropped node", () => {
  const artifact = sampleArtifact();
  artifact.coreLoop = {
    agentTeamsPlaybookPacket: {
      maxParallelAgents: 1,
      requestedParallelAgents: 4,
      waves: [{
        waveId: "agent-team-wave-1",
        mode: "primary_parallel_wave",
        parallelCount: 1,
        mergeOwner: "meta-conductor",
        taskPacketIds: ["task-backend-1"],
      }],
    },
  };
  const stored = JSON.parse(JSON.stringify(buildLiveCompactProjection(artifact)));
  stored.scheduling.provenance = "observed";
  stored.scheduling.waves[0].nodeIds.push("agent:0000000000000000ffff");

  const snapshot = buildLiveSnapshot({ governedArtifact: stored });
  assert.equal(snapshot.scheduling.provenance, "planned");
  assert.equal(snapshot.scheduling.waves[0].nodeIds.includes("agent:0000000000000000ffff"), false);
  assert.equal(snapshot.scheduling.waves[0].unmappedCount, 1);
  assert.equal(snapshot.scheduling.coverage.complete, false);
});

test("omits the scheduling block for a run that recorded no wave plan", () => {
  assert.equal(buildLiveSnapshot({}).scheduling, null);
  assert.equal(buildLiveCompactProjection(sampleArtifact()).scheduling, null);
});

// A projection built from an acceptance fixture is byte-shaped exactly like one
// built from a real run and lands in the same governed-executions directory. A
// reader cannot recover the difference afterwards, so origin has to travel with
// the record. Measured on this repo before the fix: the only two rows in a
// 44-row directory that carried worker counts and a resolved runtime were both
// fixtures, and they sorted above every real run.
test("record origin travels with a projection instead of being unrecoverable", () => {
  const real = buildLiveCompactProjection(sampleArtifact("meta-origin-real"));
  assert.equal(real.session.recordOrigin, "governed_run");
  assert.equal(real.run.recordOrigin, "governed_run");

  const fixture = sampleArtifact("meta-origin-fixture");
  fixture.recordOrigin = "acceptance_fixture";
  const projected = buildLiveCompactProjection(fixture);
  assert.equal(projected.session.recordOrigin, "acceptance_fixture");
  assert.equal(projected.run.recordOrigin, "acceptance_fixture");

  const spoofed = sampleArtifact("meta-origin-spoof");
  spoofed.recordOrigin = "definitely-real";
  assert.equal(
    buildLiveCompactProjection(spoofed).session.recordOrigin,
    "governed_run",
    "an unknown origin must fall back to the neutral default rather than reach the reader verbatim",
  );
});

// `sanitizeCompactProjection` rebuilds a stored projection from an allow-list, so
// a field registered only in the builder is silently dropped on read-back. The
// fixture would then be marked at write time and unmarked in the detail view.
test("a stored fixture projection keeps its origin through snapshot read-back", () => {
  const fixture = sampleArtifact("meta-origin-readback");
  fixture.recordOrigin = "acceptance_fixture";
  const stored = JSON.parse(JSON.stringify(buildLiveCompactProjection(fixture)));

  const snapshot = buildLiveSnapshot({ governedArtifact: stored });
  assert.equal(snapshot.session.recordOrigin, "acceptance_fixture");
  assert.equal(snapshot.run.recordOrigin, "acceptance_fixture");

  const storedReal = JSON.parse(JSON.stringify(buildLiveCompactProjection(sampleArtifact("meta-origin-readback-real"))));
  assert.equal(buildLiveSnapshot({ governedArtifact: storedReal }).session.recordOrigin, "governed_run");
});

// The discovery block became an additive field on an already-shipped projection
// version, so a stored file now carries a key its own schemaVersion does not
// announce. That is only safe because the reader re-derives it, and nothing
// asserted the write half.
//
// Load-bearing on one mutation and one only: strip `state` from the emitted block.
// Coarser breaks (dropping either `...conversation` spread, or the whole emission)
// red this together with the snapshot-side tests, because both surfaces share one
// producer — so those breaks prove the producer, not this assertion.
test("a stored projection persists the discovery block it was built with", () => {
  const artifact = sampleArtifact("meta-discovery-persisted");
  artifact.sourceConversation = { runtime: "claude", conversationRef: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
  const stored = JSON.parse(JSON.stringify(buildLiveCompactProjection(artifact)));

  assert.deepEqual(stored.run.conversationDiscovery, {
    state: "metadata_only",
    runtime: "claude",
    reason: "run_bound_metadata_only",
  });
  assert.deepEqual(stored.session.conversationDiscovery, stored.run.conversationDiscovery,
    "the header and the list row read from different halves of the same file, so a block on only one of them puts them on different answers");
});

// Pinned deliberately: the discovery block above shipped as an additive field on
// an already-released version, and that is only safe because the reader re-derives
// it. The re-derive itself is guarded in live-conversation-discovery.test.mjs —
// present-and-wrong there, absent-in-older-builds next to it. A copy of either one
// here would mean a single mutation reds two files and neither is load-bearing.
//
// This is not the only test that reds on a bump: the fixtures above hardcode the
// same literal and fail first. It stays because a bumper landing on a sanitizer
// test learns nothing about why the last additive field travelled without one, and
// this assertion's message is where that reason is written down.
test("the projection version that carried an additive field is pinned as a literal", () => {
  const artifact = sampleArtifact("meta-discovery-version-pin");
  artifact.sourceConversation = { runtime: "claude", conversationRef: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
  const stored = JSON.parse(JSON.stringify(buildLiveCompactProjection(artifact)));

  assert.equal(stored.schemaVersion, "meta-kim-live-projection-v2",
    "conversationDiscovery travelled on this version with no bump; changing it means re-deciding whether blocks stored by that version are still re-derived on read");
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

test("projects selected capability bindings as planned until trusted host evidence proves invocation", () => {
  const artifact = sampleArtifact("meta-capability-planned");
  artifact.workerTaskPackets[0].capabilityBindings = {
    skills: ["browser-qa"],
    mcp: ["github"],
    tools: ["view_image"],
    commands: ["npm-test"],
    hooks: ["dispatch-gate"],
    plugins: ["browser"],
    memoryGraph: ["graphify"],
    dependencies: ["undici"],
  };
  const snapshot = buildLiveSnapshot({ governedArtifact: artifact, observedAt: "2026-08-24T01:01:00.000Z" });
  const worker = snapshot.nodes.find((node) => node.isMain === false && node.kind === "agent");

  assert.deepEqual(worker.capabilityTruth.map(({ kind, state }) => ({ kind, state })), [
    { kind: "agent", state: "planned" },
    { kind: "skill", state: "planned" },
    { kind: "mcp", state: "planned" },
    { kind: "command", state: "planned" },
    { kind: "runtime_tool", state: "planned" },
    { kind: "hook", state: "planned" },
    { kind: "plugin", state: "planned" },
    { kind: "memory_graph", state: "planned" },
    { kind: "dependency", state: "planned" },
  ]);
  assert.deepEqual(Object.fromEntries(worker.capabilityTruth.map((record) => [record.kind, record.plannedNames])), {
    agent: ["meta-conductor"], skill: ["browser-qa"], mcp: ["github"], command: ["npm-test"],
    runtime_tool: ["view_image"], hook: ["dispatch-gate"], plugin: ["browser"], memory_graph: ["graphify"], dependency: ["undici"],
  });
  const main = snapshot.nodes.find((node) => node.isMain === true);
  assert.deepEqual(
    main.capabilityTruth,
    [],
    "this artifact declares no dispatch owner, so the root node must not claim a planned agent binding",
  );
  assert.equal(main.ownerAgent, "in_doubt");
});

test("a declared dispatch owner still reaches the root node as a planned agent binding", () => {
  const artifact = sampleArtifact("meta-capability-root-owner");
  artifact.dispatchEnvelopePacket = { ownerAgent: "meta-warden", runId: "meta-capability-root-owner" };
  const snapshot = buildLiveSnapshot({ governedArtifact: artifact, observedAt: "2026-08-24T01:01:00.000Z" });
  const main = snapshot.nodes.find((node) => node.isMain === true);

  assert.equal(main.ownerAgent, "meta-warden");
  assert.deepEqual(main.capabilityTruth, [
    { kind: "agent", state: "planned", plannedNames: ["meta-warden"], actualNames: [] },
  ]);
});

test("an artifact that declared nothing draws no graph, but any real declaration still does", () => {
  const bare = {
    schemaVersion: "governed-execution-v1",
    runId: "meta-graph-evidence",
    status: "in_progress",
    updatedAt: "2026-08-24T01:00:00.000Z",
  };
  const nodesFor = (artifact) =>
    buildLiveSnapshot({ governedArtifact: artifact, observedAt: "2026-08-24T01:01:00.000Z" }).nodes;

  assert.deepEqual(
    nodesFor(bare),
    [],
    "no owner, no worker, no workflow and no replay is nothing to draw, not a one-agent run",
  );

  const owned = nodesFor({ ...bare, dispatchEnvelopePacket: { ownerAgent: "meta-warden" } });
  assert.equal(owned.length, 1);
  assert.equal(owned[0].ownerAgent, "meta-warden", "a declared owner is evidence and keeps its node");

  const replayed = nodesFor({
    ...bare,
    replay: [{
      sequence: 1,
      at: "2026-08-24T00:59:00.000Z",
      kind: "stage",
      nodeId: "stage:execution",
      status: "in_progress",
      label: "Execution",
      runId: bare.runId,
    }],
  });
  assert.equal(replayed.length, 1, "a recorded event is evidence, and dropping the node would orphan it");

  const worked = nodesFor({
    ...bare,
    workerTaskPackets: [{ taskPacketId: "t1", ownerAgent: "frontend-developer", stage: "execution", dependsOn: [] }],
  });
  assert.equal(worked.some((node) => node.isMain === true), true);
  assert.equal(worked.some((node) => node.ownerAgent === "frontend-developer"), true);
});

test("the root node's own copy never asserts an owner the artifact did not declare", () => {
  const undeclared = buildLiveSnapshot({
    governedArtifact: sampleArtifact("meta-root-summary-undeclared"),
    observedAt: "2026-08-24T01:01:00.000Z",
  }).nodes.find((node) => node.isMain === true);

  assert.equal(
    undeclared.summary.includes("owner"),
    false,
    "an artifact with no dispatch owner must not carry a summary that claims one",
  );
  assert.deepEqual(undeclared.provenance, [{ kind: "dispatch_owner", state: "unreported" }]);

  const artifact = sampleArtifact("meta-root-summary-declared");
  artifact.dispatchEnvelopePacket = { ownerAgent: "meta-warden", runId: "meta-root-summary-declared" };
  const declared = buildLiveSnapshot({
    governedArtifact: artifact,
    observedAt: "2026-08-24T01:01:00.000Z",
  }).nodes.find((node) => node.isMain === true);

  assert.equal(declared.summary.startsWith("Main governed run owner · "), true);
  assert.deepEqual(declared.provenance, [{ kind: "dispatch_owner", state: "declared" }]);
});

test("the root node's summary never keeps a separator whose value side is empty", () => {
  // `safeText` strips angle brackets *after* its own emptiness guard, so a title
  // built only from them survives the guard and comes back as "" or " ". The
  // owner clause is real in that case, so only the separator has to go.
  const mainNodeFor = (title) => {
    const artifact = sampleArtifact("meta-root-summary-empty-title");
    artifact.dispatchEnvelopePacket = { ownerAgent: "meta-conductor", runId: "meta-root-summary-empty-title" };
    artifact.title = title;
    return buildLiveSnapshot({
      governedArtifact: artifact,
      observedAt: "2026-08-24T01:01:00.000Z",
    }).nodes.find((node) => node.isMain === true);
  };

  for (const title of ["<>", "< >"]) {
    const main = mainNodeFor(title);
    assert.equal(
      main.summary,
      "Main governed run owner",
      `a title of ${JSON.stringify(title)} carries no value, so the owner clause must stand alone`,
    );
    assert.equal(
      /·\s*$/u.test(main.summary),
      false,
      "a trailing separator reads as a value the projection failed to load",
    );
  }

  assert.equal(
    mainNodeFor("Ship the control room").summary,
    "Main governed run owner · Ship the control room",
    "a title that survives normalization still joins to the owner clause",
  );
});

test("projects actual Agent Skill MCP and Tool names only from trusted same-run invocation evidence", () => {
  const artifact = sampleArtifact("meta-capability-observed");
  artifact.workerTaskPackets[0].capabilityBindings = {
    skills: ["browser-qa"],
    mcp: ["github"],
    tools: ["view_image"],
    commands: ["npm-test"],
    hooks: ["dispatch-gate"],
    plugins: ["browser"],
    memoryGraph: ["graphify"],
    dependencies: ["undici"],
  };
  artifact.hostInvocationEvidence = [
    { family: "agent_subagent", providerId: "frontend-developer", state: "invoked", resultStatus: "returned" },
    { family: "skill", providerId: "browser-qa", state: "applied", resultStatus: "verified" },
    { family: "mcp", providerId: "github", state: "invoked", resultStatus: "verified" },
    { family: "command_script", providerId: "npm-test", state: "invoked", resultStatus: "completed" },
    { family: "runtime_tool", providerId: "view_image", state: "invoked", resultStatus: "completed" },
    { family: "hook", providerId: "dispatch-gate", state: "invoked", resultStatus: "returned" },
    { family: "plugin", providerId: "browser", state: "invoked", resultStatus: "returned" },
    { family: "memory_graph", providerId: "graphify", state: "invoked", resultStatus: "verified" },
    { family: "dependency", providerId: "undici", state: "invoked", resultStatus: "verified" },
  ].map((item, index) => ({
    ...item,
    eventId: `capability-event-${index + 1}`,
    runId: artifact.runId,
    taskPacketId: "task-backend-1",
    proofValid: true,
    synthetic: false,
  }));
  const snapshot = buildLiveSnapshot({ governedArtifact: artifact, observedAt: "2026-08-24T01:01:00.000Z" });
  const worker = snapshot.nodes.find((node) => node.isMain === false && node.kind === "agent");

  const truth = Object.fromEntries(worker.capabilityTruth.map((record) => [record.kind, record]));
  assert.deepEqual(truth.agent.actualNames, ["frontend-developer"]);
  assert.deepEqual(truth.skill.actualNames, ["browser-qa"]);
  assert.deepEqual(truth.mcp.actualNames, ["github"]);
  assert.deepEqual(truth.command.actualNames, ["npm-test"]);
  assert.deepEqual(truth.runtime_tool.actualNames, ["view_image"]);
  assert.deepEqual(truth.hook.actualNames, ["dispatch-gate"]);
  assert.deepEqual(truth.plugin.actualNames, ["browser"]);
  assert.deepEqual(truth.memory_graph.actualNames, ["graphify"]);
  assert.deepEqual(truth.dependency.actualNames, ["undici"]);
  assert.equal(worker.capabilityTruth.every((record) => record.state === "observed"), true);
});

test("does not promote selected-not-invoked foreign synthetic or proof-invalid capability evidence", () => {
  const artifact = sampleArtifact("meta-capability-negative");
  artifact.workerTaskPackets[0].capabilityBindings = {
    skills: ["browser-qa"],
    mcp: ["github"],
    tools: ["view_image"],
  };
  artifact.hostInvocationEvidence = [
    { runId: artifact.runId, family: "agent_subagent", providerId: "not-called-agent", state: "selected_not_invoked", resultStatus: "verified", proofValid: true, synthetic: false },
    { runId: artifact.runId, family: "skill", providerId: "invalid-skill", state: "applied", resultStatus: "verified", proofValid: false, synthetic: false },
    { runId: artifact.runId, family: "mcp", providerId: "synthetic-mcp", state: "invoked", resultStatus: "verified", proofValid: true, synthetic: true },
    { runId: "meta-foreign", family: "runtime_tool", providerId: "foreign-tool", state: "invoked", resultStatus: "completed", proofValid: true, synthetic: false },
  ].map((item, index) => ({ ...item, eventId: `negative-event-${index + 1}`, taskPacketId: "task-backend-1" }));
  const snapshot = buildLiveSnapshot({ governedArtifact: artifact, observedAt: "2026-08-24T01:01:00.000Z" });
  const worker = snapshot.nodes.find((node) => node.isMain === false && node.kind === "agent");

  for (const record of worker.capabilityTruth) {
    assert.notEqual(record.state, "observed");
    assert.deepEqual(record.actualNames, []);
  }
  assert.equal(worker.toolCount, 0);
  const planned = Object.fromEntries(worker.capabilityTruth.map((record) => [record.kind, record.plannedNames]));
  assert.deepEqual(planned.agent, ["meta-conductor"]);
  assert.deepEqual(planned.skill, ["browser-qa"]);
  assert.deepEqual(planned.mcp, ["github"]);
  assert.deepEqual(planned.runtime_tool, ["view_image"]);
});

test("toolCalls include only actually invoked command and runtime-tool evidence", () => {
  const artifact = sampleArtifact("meta-tool-call-truth");
  artifact.hostInvocationEvidence = [
    { family: "command_script", providerId: "selected-command", state: "selected_not_invoked", resultStatus: "verified" },
    { family: "runtime_tool", providerId: "selected-tool", state: "selected_not_invoked", resultStatus: "verified" },
    { family: "runtime_tool", providerId: "called-tool", state: "invoked", resultStatus: "completed" },
    { family: "command_script", providerId: "failed-command", state: "invoked", resultStatus: "failed" },
    { family: "skill", providerId: "called-skill", state: "applied", resultStatus: "verified" },
    { family: "mcp", providerId: "called-mcp", state: "invoked", resultStatus: "returned" },
    { family: "hook", providerId: "called-hook", state: "invoked", resultStatus: "returned" },
    { family: "plugin", providerId: "called-plugin", state: "invoked", resultStatus: "returned" },
    { family: "memory_graph", providerId: "called-graph", state: "invoked", resultStatus: "verified" },
    { family: "dependency", providerId: "called-dependency", state: "invoked", resultStatus: "verified" },
  ].map((item, index) => ({
    ...item,
    eventId: `tool-truth-event-${index + 1}`,
    runId: artifact.runId,
    taskPacketId: "task-backend-1",
    proofValid: true,
    synthetic: false,
  }));
  const snapshot = buildLiveSnapshot({ governedArtifact: artifact, observedAt: "2026-08-24T01:01:00.000Z" });
  const worker = snapshot.nodes.find((node) => node.isMain === false && node.kind === "agent");

  assert.equal(worker.toolCount, 2);
  assert.deepEqual(worker.toolCalls.map((call) => call.name), ["called-tool", "failed-command"]);
  assert.equal(worker.latestTool, "failed-command");
  assert.equal(worker.toolCalls.some((call) => /selected|skill|mcp|hook|plugin|graph|dependency/u.test(call.name)), false);
});

test("relative repository paths are redacted from tool and replay labels", () => {
  const current = sampleArtifact("meta-path-redaction");
  current.hostInvocationEvidence = [{
    runId: current.runId,
    taskPacketId: "task-backend-1",
    proofValid: true,
    synthetic: false,
    family: "runtime_tool",
    providerId: "canonical/runtime-assets/claude/mcp.json",
    state: "invoked",
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

test("capacity wave: trust-tier ordering drops low-tier nodes first when the projection exceeds budget", () => {
  const padding = "x".repeat(2800);
  const workerDescriptors = [
    { id: "completed-proven", status: "completed", roleInstance: "exec-completed-proven", component: "comp:a", observed: { family: "skill", providerId: "tdd-workflow", proofValid: true, synthetic: false } },
    { id: "active-observed", status: "active", roleInstance: "exec-active-observed", component: "comp:b", observed: { family: "tool", providerId: "Read", proofValid: true, synthetic: false } },
    { id: "active-no-evidence", status: "active", roleInstance: "exec-active-no-ev", component: "comp:c", observed: null },
    { id: "declared-only-terminal", status: "completed", roleInstance: "exec-declared-only", component: "comp:d", observed: { family: "declaration", providerId: "no-ev", proofValid: false, synthetic: false } },
    { id: "pending", status: "pending", roleInstance: "exec-pending", component: "comp:e", observed: null },
    { id: "in-doubt", status: "in_doubt", roleInstance: "exec-in-doubt", component: "comp:f", observed: null },
    { id: "blocked", status: "blocked", roleInstance: "exec-blocked", component: "comp:g", observed: null },
  ];
  const workerTaskPackets = workerDescriptors.map((worker) => ({
    taskPacketId: `agent:${worker.id}`,
    ownerAgent: "frontend-developer",
    status: worker.status,
    roleDisplayName: "frontend",
    roleInstanceId: worker.roleInstance,
    componentId: worker.component,
    stage: "execution",
    task: `${padding} ${worker.id} task`,
    description: `${padding} ${worker.id} desc`,
    capabilityBindings: {},
    shardScope: [worker.roleInstance],
    dependsOn: [],
  }));
  const workerResultPackets = workerDescriptors.map((worker) => {
    const evidence = worker.observed
      ? [{
          runId: "cap-wave-fixture",
          taskPacketId: `agent:${worker.id}`,
          verifyStepRef: `${worker.observed.family}:${worker.observed.providerId}`,
          status: worker.status === "completed" ? "completed" : "verified",
          resultStatus: worker.status === "completed" ? "completed" : "verified",
          observedResult: `${padding} ${worker.id} result`,
          runAt: "2026-08-30T00:00:30.000Z",
          proofValid: worker.observed.proofValid,
          synthetic: worker.observed.synthetic,
          evidenceKind: worker.observed.family,
        }]
      : [];
    return {
      runId: "cap-wave-fixture",
      taskPacketId: `agent:${worker.id}`,
      roleDisplayName: "frontend",
      roleInstanceId: worker.roleInstance,
      status: worker.status,
      startedAt: worker.status === "pending" ? null : "2026-08-30T00:00:01.000Z",
      completedAt: worker.status === "completed" ? "2026-08-30T00:00:30.000Z" : null,
      summary: `${padding} ${worker.id} summary`,
      description: `${padding} ${worker.id} desc`,
      workerExecutionEvidence: evidence,
    };
  });
  const hostInvocationEvidence = workerDescriptors
    .filter((worker) => worker.observed && worker.observed.proofValid)
    .map((worker) => ({
      runId: "cap-wave-fixture",
      taskPacketId: `agent:${worker.id}`,
      bindingRef: `agent:${worker.id}`,
      family: worker.observed.family,
      providerId: worker.observed.providerId,
      hostSurface: "claude-code-host",
      runtime: "claude-code",
      model: "claude-sonnet-4-5",
      state: "invoked",
      proofValid: worker.observed.proofValid,
      synthetic: worker.observed.synthetic,
      observedAt: "2026-08-30T00:00:30.000Z",
      occurredAt: "2026-08-30T00:00:30.000Z",
      filePath: `${padding}/${worker.id}.txt`,
      componentId: worker.component,
      eventId: `agent:${worker.id}:${worker.observed.family}:${worker.observed.providerId}`,
    }));
  const artifact = {
    runId: "cap-wave-fixture",
    title: "capacity wave trust tier fixture",
    task: `${padding} main task`,
    status: "active",
    currentStage: "execution",
    startedAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:05.000Z",
    completedAt: null,
    language: "zh-CN",
    projectId: "project-capwave",
    sourceConversation: {
      runId: "cap-wave-fixture",
      conversationId: "session:cap-wave",
      runtime: "claude-code",
      title: "cap-wave",
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
    conversationLinks: [{
      runId: "cap-wave-fixture",
      conversationRef: "session:cap-wave-cap-wave-fixture",
      sourceRuntime: "claude-code",
      verified: true,
      matchState: "verified",
      matchBasis: "exact_metadata",
      title: "cap-wave",
      updatedAt: "2026-08-30T00:00:00.000Z",
    }],
    dispatchEnvelopePacket: { ownerAgent: "meta-conductor", runId: "cap-wave-fixture" },
    coreLoop: {
      ownerAgent: "meta-conductor",
      capabilityInventory: {
        inventory: [{
          ownerAgent: "meta-conductor",
          capabilityFamilies: ["skill", "tool"],
        }],
      },
    },
    workerTaskPackets,
    workerResultPackets,
    hostInvocationEvidence,
  };

  const fitted = buildLiveCompactProjection(artifact, { maxBytes: 16384 });

  const survivingRoleInstance = fitted.nodes.map((node) => node.roleInstanceId).filter(Boolean);
  const hasMain = fitted.nodes.some((node) => node.isMain === true);
  const hasWorkflow = fitted.nodes.some((node) => node.kind === "workflow");

  assert.ok(hasMain, "main agent must survive capacity wave (trust tier ∞)");
  assert.ok(hasWorkflow, "workflow lane must survive capacity wave (trust tier 4)");

  const highTrustSurvived =
    survivingRoleInstance.includes("exec-completed-proven") ||
    survivingRoleInstance.includes("exec-active-observed");
  assert.ok(highTrustSurvived, "proven-terminal or observed-active worker must survive (trust tier ≥3)");

  const pendingSurvived = survivingRoleInstance.includes("exec-pending");
  const inDoubtSurvived = survivingRoleInstance.includes("exec-in-doubt");
  const blockedSurvived = survivingRoleInstance.includes("exec-blocked");
  const activeNoEvSurvived = survivingRoleInstance.includes("exec-active-no-ev");

  assert.ok(
    !pendingSurvived || !hasMain ? true : !pendingSurvived,
    "pending worker (trust tier 0) must be dropped before main (trust tier ∞)",
  );

  const declaredOnlySurvived = survivingRoleInstance.includes("exec-declared-only");
  const provenSurvived = survivingRoleInstance.includes("exec-completed-proven");
  if (declaredOnlySurvived && !provenSurvived) {
    assert.fail("declared-only-terminal (rank 2) must be dropped before proven-terminal (rank 4)");
  }

  const droppedLowTrust =
    !pendingSurvived || !inDoubtSurvived || !blockedSurvived || !activeNoEvSurvived;
  assert.ok(
    droppedLowTrust,
    "at least one of pending/in_doubt/blocked/active-no-evidence must be dropped first",
  );

  assert.ok(
    fitted.truncated?.applied === true,
    "truncation flag must be set when projection exceeds budget",
  );
});

test("capacity wave: budget compaction prunes wave membership instead of leaving ghost members", () => {
  const padding = "y".repeat(2800);
  const workerIds = ["w1", "w2", "w3", "w4", "w5", "w6"];
  const artifact = {
    runId: "wave-budget-fixture",
    title: "wave budget fixture",
    task: `${padding} main task`,
    status: "active",
    currentStage: "execution",
    startedAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:05.000Z",
    completedAt: null,
    coreLoop: {
      ownerAgent: "meta-conductor",
      agentTeamsPlaybookPacket: {
        maxParallelAgents: 6,
        requestedParallelAgents: 6,
        waves: [{
          waveId: "agent-team-wave-1",
          mode: "primary_parallel_wave",
          parallelCount: 6,
          mergeOwner: "meta-conductor",
          taskPacketIds: workerIds.map((id) => `agent:${id}`),
        }],
      },
    },
    workerTaskPackets: workerIds.map((id) => ({
      taskPacketId: `agent:${id}`,
      ownerAgent: "frontend-developer",
      status: "pending",
      roleDisplayName: "frontend",
      roleInstanceId: `exec-${id}`,
      stage: "execution",
      task: `${padding} ${id} task`,
      description: `${padding} ${id} desc`,
      capabilityBindings: {},
      dependsOn: [],
    })),
    workerResultPackets: workerIds.map((id) => ({
      runId: "wave-budget-fixture",
      taskPacketId: `agent:${id}`,
      roleDisplayName: "frontend",
      roleInstanceId: `exec-${id}`,
      status: "pending",
      startedAt: null,
      completedAt: null,
      summary: `${padding} ${id} summary`,
      description: `${padding} ${id} desc`,
      workerExecutionEvidence: [],
    })),
  };

  const full = buildLiveCompactProjection(artifact, { maxBytes: 262144 });
  assert.equal(full.scheduling.coverage.declaredTaskCount, 6);
  assert.equal(full.scheduling.coverage.mappedNodeCount, 6);
  assert.equal(full.scheduling.coverage.complete, true);

  const fitted = buildLiveCompactProjection(artifact, { maxBytes: 12288 });
  assert.equal(fitted.truncated?.applied, true);
  assert.ok(fitted.scheduling, "scheduling survives compaction; it is not a coarse trim target");

  const survivingNodeIds = new Set(fitted.nodes.map((node) => node.id));
  const wave = fitted.scheduling.waves[0];
  assert.equal(wave.nodeIds.every((id) => survivingNodeIds.has(id)), true, "no wave member may name a dropped node");
  assert.ok(wave.unmappedCount >= 1, "at least one declared member was dropped by the budget");
  assert.equal(wave.mappedCount + wave.unmappedCount, 6, "declared membership is conserved, never silently shrunk");
  assert.equal(fitted.scheduling.coverage.mappedNodeCount, wave.mappedCount);
  assert.equal(fitted.scheduling.coverage.declaredTaskCount, 6);
  assert.equal(fitted.scheduling.coverage.complete, false);
});

test("an activation-only durable status projects no node and states why the graph is empty", () => {
  const durableStatus = {
    schemaVersion: 2,
    active: true,
    lifecycleStatus: "active",
    runId: "meta-activation-only-1",
    currentStage: "Critical",
    currentStageKey: "critical",
    updatedAt: "2026-08-24T01:00:00.000Z",
    startedAt: "2026-08-24T01:00:00.000Z",
    stages: { critical: { status: "in_progress" } },
  };
  const snapshot = buildLiveSnapshot({
    durableStatus,
    governedArtifact: null,
    observedAt: "2026-08-24T01:01:00.000Z",
  });

  assert.equal(snapshot.run.runId, "meta-activation-only-1");
  assert.equal(snapshot.run.substanceClass, "activation_only");
  assert.equal("title" in snapshot.run, false, "no title may be invented for a run that declared none");
  assert.deepEqual(snapshot.nodes, [], "an activation receipt must not mint a synthetic owner node");
  assert.deepEqual(snapshot.edges, []);
  assert.deepEqual(snapshot.replay, []);
  assert.equal(snapshot.counts.nodes, 0);
  assert.equal(snapshot.counts.events, 0);
  assert.equal(snapshot.graphAvailability.state, "no_graph_evidence");
  assert.equal(snapshot.graphAvailability.reason, "no_governed_artifact_for_run");
  assert.equal(snapshot.graphAvailability.substanceClass, "activation_only");
  assert.equal(snapshot.graphAvailability.substanceSource, "derived_from_status_fields");
  assert.equal(snapshot.graphAvailability.substanceSignals.completedStages, 0);
  assert.equal(snapshot.graphAvailability.substanceSignals.advancedBeyondEntryStage, false);
});

test("an activation-only durable status carries its verified chat link into the run header", () => {
  const snapshot = buildLiveSnapshot({
    durableStatus: {
      schemaVersion: 2,
      active: true,
      lifecycleStatus: "active",
      runId: "meta-activation-linked-1",
      currentStage: "Critical",
      currentStageKey: "critical",
      updatedAt: "2026-09-02T05:01:09.483Z",
      startedAt: "2026-09-02T05:01:09.474Z",
      stages: { critical: { status: "in_progress" } },
      sourceRuntime: "claude",
      conversationLinkState: "verified",
      sourceConversation: {
        runtime: "claude",
        conversationId: "b5799d00-ef7a-4882-818d-d9053cacba71",
        runId: "meta-activation-linked-1",
        matchBasis: "transcript_file_verified",
      },
    },
    governedArtifact: null,
    observedAt: "2026-09-02T05:01:30.000Z",
  });

  assert.equal(snapshot.source.kind, "durable_status");
  assert.equal(snapshot.run.substanceClass, "activation_only");
  assert.equal(snapshot.run.conversationLinkState, "verified");
  assert.equal(snapshot.run.conversationRef, "b5799d00-ef7a-4882-818d-d9053cacba71");
  assert.equal(snapshot.run.sourceRuntime, "claude");
  assert.equal(snapshot.run.verifiedLinks.length, 1);
  assert.equal(snapshot.run.verifiedLinks[0].sourceRuntime, "claude");
  assert.equal("conversationLinkRefusal" in snapshot.run, false, "a bound run must not also print why binding failed");
});

test("an activation-only durable status carries the refusal reason when no chat link was bound", () => {
  const snapshot = buildLiveSnapshot({
    durableStatus: {
      schemaVersion: 2,
      active: true,
      lifecycleStatus: "active",
      runId: "meta-activation-refused-1",
      currentStage: "Critical",
      currentStageKey: "critical",
      updatedAt: "2026-09-02T05:01:09.483Z",
      startedAt: "2026-09-02T05:01:09.474Z",
      stages: { critical: { status: "in_progress" } },
      sourceRuntime: "codex",
      conversationLinkRefusal: "transcript_file_absent",
    },
    governedArtifact: null,
    observedAt: "2026-09-02T05:01:30.000Z",
  });

  assert.equal(snapshot.run.conversationLinkState, "unlinked");
  assert.equal(snapshot.run.conversationLinkRefusal, "transcript_file_absent");
  assert.equal(snapshot.run.sourceRuntime, "codex", "a run that named its tool must not read as an unrecorded source");
  assert.deepEqual(snapshot.run.verifiedLinks, []);
  assert.equal("conversationRef" in snapshot.run, false);
});

test("a governed run names the runtime its own request record proves, on both surfaces", () => {
  const runId = "meta-runtime-family-1";
  const artifact = {
    ...sampleArtifact(runId),
    requestRecord: { runtimeContext: { runtimeFamily: "codex", os: "windows" } },
  };

  const projection = buildLiveCompactProjection(artifact, runId);
  assert.equal(projection.run.sourceRuntime, "codex", "the projection is where the runtime family is lost");

  const fromRaw = buildLiveSnapshot({
    durableStatus: null,
    governedArtifact: artifact,
    observedAt: "2026-09-02T05:01:30.000Z",
  });
  assert.equal(fromRaw.source.kind, "governed_artifact");
  assert.equal(fromRaw.run.sourceRuntime, "codex", "the session list and the run header must name the same runtime");

  const fromProjection = buildLiveSnapshot({
    durableStatus: null,
    governedArtifact: projection,
    observedAt: "2026-09-02T05:01:30.000Z",
  });
  assert.equal(fromProjection.source.kind, "live_projection");
  assert.equal(fromProjection.run.sourceRuntime, "codex", "a stored projection must not lose the runtime either");
});

test("a substantive durable status keeps the nodes its own record declares", () => {
  const durableStatus = {
    ...sampleStatus("meta-substantive-durable-1"),
    workerTaskPackets: [
      {
        taskPacketId: "task-backend-1",
        roleDisplayName: "backend",
        ownerAgent: "backend-developer",
        stage: "execution",
        dependsOn: [],
      },
    ],
  };
  const snapshot = buildLiveSnapshot({
    durableStatus,
    governedArtifact: null,
    observedAt: "2026-08-24T01:01:00.000Z",
  });

  assert.equal(snapshot.run.substanceClass, "substantive", "substance rides on every snapshot path");
  assert.ok(snapshot.nodes.length > 0, "declared worker packets are real records and must stay visible");
  assert.equal(snapshot.graphAvailability.state, "graph_available");
  assert.equal(snapshot.graphAvailability.substanceClass, "substantive");
});

test("a run with no readable record reports no selection rather than an empty graph claim", () => {
  const snapshot = buildLiveSnapshot({ observedAt: "2026-08-24T01:01:00.000Z" });
  assert.equal(snapshot.run, null);
  assert.equal(snapshot.graphAvailability.state, "no_run_selected");
  assert.equal(snapshot.graphAvailability.substanceClass, null);
});

function plannedStageDagArtifact(overrides = {}) {
  return {
    ...sampleArtifact("meta-live-planned-dag"),
    coreLoop: {
      stageDagPacket: {
        authority: "config/contracts/core-loop-contract.json",
        status: "planned_not_invoked",
        nodes: [
          {
            nodeId: "stage:critical:lane:support-1",
            stage: "Critical",
            laneKind: "support",
            ownerBindingRef: "meta-warden",
            dependsOn: [],
            status: "planned_not_invoked",
          },
          {
            nodeId: "stage:critical:merge",
            stage: "Critical",
            laneKind: "merge",
            ownerBindingRef: "meta-conductor",
            dependsOn: ["stage:critical:lane:support-1"],
            mergeNodeId: "stage:critical:merge",
            status: "pending_merge",
          },
          {
            nodeId: "stage:execution:lane:backend",
            stage: "Execution",
            laneKind: "execution",
            ownerBindingRef: "backend-architect",
            dependsOn: ["stage:critical:merge"],
            status: "planned_not_invoked",
          },
        ],
      },
      ...overrides,
    },
  };
}

test("records a declared stage plan without drawing it as executed graph nodes", () => {
  const projection = buildLiveCompactProjection(plannedStageDagArtifact());
  assert.equal(
    projection.nodes.length,
    3,
    "the graph holds only executed evidence: one main node, one workflow group and one worker",
  );
  assert.equal(
    projection.nodes.some((node) => String(node.id).includes("stage:")),
    false,
    "a planned stage lane is not an execution node and may not enter the graph",
  );
  assert.equal(projection.session.nodeCount, 3, "a recorded plan must not inflate the executed node count");
  assert.equal(projection.declaredPlan.declaredNodeCount, 3);
  assert.equal(projection.declaredPlan.invokedNodeCount, 0);
  assert.equal(projection.declaredPlan.status, "planned_not_invoked");
  assert.equal(projection.declaredPlan.authority, "config/contracts/core-loop-contract.json");
  assert.deepEqual(projection.declaredPlan.stages, [
    { stage: "critical", label: "Critical", declaredNodeCount: 2, invokedNodeCount: 0 },
    { stage: "execution", label: "Execution", declaredNodeCount: 1, invokedNodeCount: 0 },
  ]);
});

test("refuses to count a node as invoked when the plan itself was never invoked", () => {
  const artifact = plannedStageDagArtifact();
  artifact.coreLoop.stageDagPacket.nodes[2].status = "completed";
  const projection = buildLiveCompactProjection(artifact);
  assert.equal(
    projection.declaredPlan.invokedNodeCount,
    0,
    "a plan that declares itself planned_not_invoked cannot contain a completed lane",
  );
  assert.equal(projection.declaredPlan.stages[1].invokedNodeCount, 0);
});

test("counts invoked plan lanes once the plan itself reports invocation", () => {
  const artifact = plannedStageDagArtifact();
  artifact.coreLoop.stageDagPacket.status = "invoked";
  artifact.coreLoop.stageDagPacket.nodes[2].status = "completed";
  const projection = buildLiveCompactProjection(artifact);
  assert.equal(projection.declaredPlan.status, "invoked");
  assert.equal(projection.declaredPlan.declaredNodeCount, 3);
  assert.equal(projection.declaredPlan.invokedNodeCount, 1);
  assert.deepEqual(projection.declaredPlan.stages, [
    { stage: "critical", label: "Critical", declaredNodeCount: 2, invokedNodeCount: 0 },
    { stage: "execution", label: "Execution", declaredNodeCount: 1, invokedNodeCount: 1 },
  ]);
});

test("reports no declared plan when the artifact recorded none", () => {
  const projection = buildLiveCompactProjection(sampleArtifact("meta-live-no-dag"));
  assert.strictEqual(projection.declaredPlan, null);
  assert.equal(projection.nodes.length, 3);
});

test("keeps the declared plan when a stored compact projection is read back", () => {
  const stored = buildLiveCompactProjection(plannedStageDagArtifact());
  assert.equal(stored.declaredPlan.declaredNodeCount, 3, "guard precondition: the freshly built projection carries the plan");
  const snapshot = buildLiveSnapshot({
    governedArtifact: JSON.parse(JSON.stringify(stored)),
    observedAt: "2026-08-24T01:01:00.000Z",
  });
  assert.equal(snapshot.declaredPlan.declaredNodeCount, 3);
  assert.equal(snapshot.declaredPlan.invokedNodeCount, 0);
  assert.equal(snapshot.declaredPlan.status, "planned_not_invoked");
  assert.deepEqual(snapshot.declaredPlan.stages, [
    { stage: "critical", label: "Critical", declaredNodeCount: 2, invokedNodeCount: 0 },
    { stage: "execution", label: "Execution", declaredNodeCount: 1, invokedNodeCount: 0 },
  ]);
});

test("refuses a stored plan whose lane counts exceed the count it declared", () => {
  const stored = buildLiveCompactProjection(plannedStageDagArtifact());
  stored.declaredPlan.stages[0].invokedNodeCount = 99;
  const snapshot = buildLiveSnapshot({
    governedArtifact: JSON.parse(JSON.stringify(stored)),
    observedAt: "2026-08-24T01:01:00.000Z",
  });
  assert.equal(
    snapshot.declaredPlan.stages[0].invokedNodeCount,
    2,
    "a stored file claiming more invoked lanes than it declared is clamped to what it declared",
  );
});
