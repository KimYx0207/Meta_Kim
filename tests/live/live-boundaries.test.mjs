import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildLiveSnapshot,
  createLiveControlRoomServer,
  createLiveControlRoomService,
  createLiveReadRepository,
  parseArgs,
  resolveLiveProjectRoot,
  startLiveControlRoom,
} from "../../scripts/meta-kim-live.mjs";
import {
  isPathInside,
  safeReadJson,
  sanitizeLiveProfile,
} from "../../src/infrastructure/live/live-read-repository.mjs";
import {
  buildLiveCompactProjection,
  emptyReplay,
  emptySnapshot,
  LIVE_MAX_COMPACT_BYTES,
  normalizeKind,
  normalizeStage,
  normalizeStatus,
  safeText,
} from "../../src/application/live/live-control-room-service.mjs";
import { createLiveContinuationCommand } from "../../src/domain/live/live-continuation-command.mjs";
import { createLiveContinuationCommandStore } from "../../src/infrastructure/live/live-continuation-command-store.mjs";
import { createLiveRuntimeAdapterRegistry, createFakeLiveRuntimeAdapter } from "../../src/infrastructure/live/live-runtime-adapter-registry.mjs";
import { createLiveContinuationPlanner } from "../../src/application/live/plan-live-continuation.mjs";

async function projectFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-boundary-"));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, ".meta-kim", "state", "default"), { recursive: true });
  return root;
}

function status(runId = "meta-boundary-1", updatedAt = "2026-08-24T10:00:00.000Z") {
  return {
    schemaVersion: 2,
    runId,
    active: true,
    lifecycleStatus: "active",
    currentStage: "Execution",
    updatedAt,
    stages: { execution: { status: "in_progress" } },
  };
}

function artifact(runId = "meta-boundary-1", updatedAt = "2026-08-24T10:00:00.000Z") {
  return {
    schemaVersion: "governed-execution-v1",
    runId,
    status: "in_progress",
    updatedAt,
    workerTaskPackets: [{
      taskPacketId: "worker-one",
      ownerAgent: "backend-architect",
      roleDisplayName: "backend",
      stage: "execution",
      dependsOn: [],
      evidenceRefs: ["verification:1"],
    }],
    workerResultPackets: [{ taskPacketId: "worker-one", status: "completed" }],
    verificationPacket: {
      evidence: ["redacted"],
      verificationResults: [{ status: "passed" }],
    },
  };
}

function withEffectProtocol(repository) {
  let preparedEffectId = null;
  return {
    ...repository,
    prepareEffect({ effectId }) { preparedEffectId = effectId; return { effectId, state: "prepared" }; },
    markEffectDispatchStarted({ effectId }) { return { effectId, state: "dispatch_started" }; },
    markUnresolvedEffectsInDoubt({ runId }) { return { runId, effectIds: preparedEffectId ? [preparedEffectId] : [] }; },
  };
}

test("CLI parsing rejects unsafe profiles and every malformed public option", () => {
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(parseArgs([
    "--project-root", path.resolve("."),
    "--port", "0",
    "--profile", "work-profile",
    "--no-open",
    "--json",
  ]), {
    projectRoot: path.resolve("."),
    port: 0,
    profile: "work-profile",
    open: false,
    json: true,
  });
  assert.throws(() => parseArgs(["--profile", "../outside"]), /profile/iu);
  assert.throws(() => parseArgs(["--project-root", "."]), /absolute/iu);
  assert.throws(() => parseArgs(["--port"]), /requires a value/iu);
  assert.throws(() => parseArgs(["--port", "65536"]), /65535/u);
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/iu);
});

test("snapshot allowlists normalize aliases while redacting every sensitive string class", () => {
  assert.equal(normalizeStatus("running"), "active");
  assert.equal(normalizeStatus("PASS"), "completed");
  assert.equal(normalizeStatus("not-real", "pending"), "pending");
  assert.equal(normalizeStatus(null, "blocked"), "blocked");
  assert.equal(normalizeKind("Review"), "review");
  assert.equal(normalizeKind("raw_tool_output"), "in_doubt");
  assert.equal(normalizeKind(null), "in_doubt");
  assert.equal(normalizeStage("Meta Review"), "meta-review");
  assert.equal(normalizeStage("not-real"), "in_doubt");
  assert.equal(normalizeStage(null), "in_doubt");
  assert.equal(safeText(null, "fallback"), "fallback");
  assert.equal(safeText("\u0000   ", "fallback"), "fallback");
  assert.equal(safeText("secret=do-not-leak"), "redacted");
  assert.equal(safeText("-----BEGIN PRIVATE KEY-----"), "redacted");
  assert.equal(safeText("sk-abcdefghijk"), "redacted");
  assert.equal(safeText("C:\\Users\\Kim\\secret.txt"), "[path omitted]");
  assert.equal(safeText("~/private/tool.log"), "[path omitted]");
  assert.equal(safeText("~\\private\\tool.log"), "[path omitted]");
  assert.equal(safeText("file:///Users/Kim/private/tool.log"), "[path omitted]");
  assert.equal(safeText("vscode://file/C:/Users/Kim/private/tool.log"), "[path omitted]");
  assert.equal(safeText("src/private/file.mjs"), "[path omitted]");
  assert.equal(safeText(" <safe>   label "), "safe label");
  assert.equal(safeText(123), "123");
  assert.equal(safeText("abcdef", "fallback", 3), "abc");
  assert.equal(emptySnapshot("2026-08-24T00:00:00Z").run, null);
  assert.equal(emptyReplay("bad-run").runId, null);
});

test("repository primitives fail closed for malformed, oversized, and out-of-root data", async () => {
  const root = await projectFixture();
  const stateDir = path.join(root, ".meta-kim", "state", "default");
  const validPath = path.join(stateDir, "valid.json");
  const malformedPath = path.join(stateDir, "malformed.json");
  const arrayPath = path.join(stateDir, "array.json");
  const largePath = path.join(stateDir, "large.json");
  try {
    await writeFile(validPath, JSON.stringify({ runId: "meta-safe-1" }), "utf8");
    await writeFile(malformedPath, "{", "utf8");
    await writeFile(arrayPath, "[]", "utf8");
    await writeFile(largePath, JSON.stringify({ value: "123456789" }), "utf8");
    assert.equal((await safeReadJson(root, validPath)).status, "valid");
    assert.equal((await safeReadJson(root, malformedPath)).status, "malformed");
    assert.equal((await safeReadJson(root, arrayPath)).status, "unknown");
    assert.equal((await safeReadJson(root, largePath, { maxBytes: 4 })).status, "unsafe");
    assert.equal((await safeReadJson(root, stateDir)).status, "unsafe");
    assert.equal((await safeReadJson(root, path.join(root, "outside.json"))).status, "unsafe");
    assert.equal((await safeReadJson(root, path.join(stateDir, "missing.json"))).status, "missing");
    assert.equal(isPathInside(stateDir, validPath), true);
    assert.equal(isPathInside(stateDir, root), false);
    assert.equal(sanitizeLiveProfile("named-profile"), "named-profile");
    assert.equal(sanitizeLiveProfile(""), "default");
    assert.equal(sanitizeLiveProfile("../outside"), "default");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository honors direct status, pointer fallback, and empty-project branches", async () => {
  const root = await projectFixture();
  const stateDir = path.join(root, ".meta-kim", "state", "default");
  const executionDir = path.join(stateDir, "governed-executions");
  const activePath = path.join(stateDir, "active-run.json");
  const latestPath = path.join(executionDir, "latest.json");
  const artifactPath = path.join(executionDir, "meta-direct-1.json");
  try {
    await mkdir(executionDir, { recursive: true });
    await writeFile(activePath, JSON.stringify(status("meta-direct-1")), "utf8");
    await writeFile(artifactPath, JSON.stringify(artifact("meta-direct-1")), "utf8");
    const repository = createLiveReadRepository({ projectRoot: root });
    assert.equal(repository.projectRoot, path.resolve(root));
    assert.equal((await repository.readDurableStatus()).runId, "meta-direct-1");
    assert.equal((await repository.readLatestArtifact()).runId, "meta-direct-1");

    await writeFile(latestPath, JSON.stringify({
      runId: "meta-direct-1",
      jsonPath: path.resolve(artifactPath),
    }), "utf8");
    assert.equal(await repository.readLatestArtifact(), null);
    await unlink(latestPath);
    assert.equal((await repository.readArtifact("meta-direct-1")).runId, "meta-direct-1");

    const emptyRepository = createLiveReadRepository({ projectRoot: path.join(root, "missing") });
    assert.equal(await emptyRepository.readDurableStatus(), null);
    assert.equal(await emptyRepository.readLatestArtifact(), null);
    assert.equal(await emptyRepository.readArtifact("meta-direct-1"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository reads bounded legacy status and digest-bound governed artifacts", async () => {
  const root = await projectFixture();
  const stateDir = path.join(root, ".meta-kim", "state", "default");
  const runDir = path.join(stateDir, "runs", "meta-legacy-1");
  const executionDir = path.join(stateDir, "governed-executions");
  const artifactPath = path.join(executionDir, "meta-legacy-1.json");
  const rawArtifact = JSON.stringify(artifact("meta-legacy-1", "2026-08-24T10:02:00.000Z"));
  const sha256 = createHash("sha256").update(rawArtifact, "utf8").digest("hex");
  try {
    await mkdir(runDir, { recursive: true });
    await mkdir(executionDir, { recursive: true });
    await writeFile(path.join(runDir, "status.json"), JSON.stringify(status("meta-legacy-1")), "utf8");
    await writeFile(artifactPath, rawArtifact, "utf8");
    await writeFile(path.join(executionDir, "latest.json"), JSON.stringify({
      runId: "meta-legacy-1",
      jsonPath: ".meta-kim/state/default/governed-executions/meta-legacy-1.json",
      sha256,
    }), "utf8");

    const repository = createLiveReadRepository({ projectRoot: root, profile: "../outside" });
    assert.equal(repository.profile, "default");
    assert.equal((await repository.readDurableStatus()).runId, "meta-legacy-1");
    assert.equal((await repository.readLatestArtifact()).runId, "meta-legacy-1");
    assert.equal((await repository.readArtifact("meta-legacy-1")).runId, "meta-legacy-1");
    assert.equal(await repository.readArtifact("../outside"), null);

    await writeFile(path.join(executionDir, "latest.json"), JSON.stringify({
      runId: "meta-legacy-1",
      jsonPath: ".meta-kim/state/default/governed-executions/meta-legacy-1.json",
      sha256: "0".repeat(64),
    }), "utf8");
    assert.equal(await repository.readLatestArtifact(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compact live projection is bounded, digest-bound, Unicode-safe, and preferred over oversized raw artifacts", async () => {
  const root = await projectFixture();
  const executionDir = path.join(root, ".meta-kim", "state", "default", "governed-executions");
  const runId = "meta-compact-1";
  const rawTaskId = "unicode-id-任务-甲-987";
  const projection = buildLiveCompactProjection({
    schemaVersion: "governed-execution-v1",
    runId,
    status: "partial",
    task: "Safe compact task",
    updatedAt: "2026-08-24T10:00:00.000Z",
    workerTaskPackets: [{
      taskPacketId: rawTaskId,
      roleDisplayName: "backend",
      ownerAgent: "backend-architect",
      todayTask: "Prepare the bounded service projection",
      parallelGroup: "delivery",
    }],
    workerResultPackets: [{ taskPacketId: rawTaskId, status: "planned_not_executed" }],
    coreLoop: { runtimeInvocationPlanPacket: { evidence: [
      {
        eventId: "tool-call-1",
        taskPacketId: rawTaskId,
        bindingRef: rawTaskId,
        proofValid: true,
        passEligible: true,
        family: "runtime_tool",
        providerId: "read-only-observer",
        evidenceKind: "runtime_tool_call",
        state: "invoked",
        resultStatus: "started",
        occurredAt: "2026-08-24T09:59:58.000Z",
      },
      {
        eventId: "tool-call-1",
        taskPacketId: rawTaskId,
        bindingRef: rawTaskId,
        proofValid: true,
        passEligible: true,
        family: "runtime_tool",
        providerId: "read-only-observer",
        evidenceKind: "runtime_tool_call",
        resultStatus: "completed",
        occurredAt: "2026-08-24T10:00:00.000Z",
        payload: "secret=must-not-project",
      },
      {
        eventId: "agent-call-1",
        taskPacketId: rawTaskId,
        bindingRef: rawTaskId,
        proofValid: true,
        passEligible: true,
        family: "agent_subagent",
        providerId: "backend-architect",
        evidenceKind: "agent_task_result",
        resultStatus: "returned",
        occurredAt: "2026-08-24T10:00:01.000Z",
      },
      {
        eventId: "tool-call-2",
        taskPacketId: rawTaskId,
        bindingRef: rawTaskId,
        proofValid: true,
        passEligible: false,
        family: "runtime_tool",
        providerId: "file:///Users/Kim/private/tool.exe",
        evidenceKind: "runtime_tool_call",
        resultStatus: "failed",
        occurredAt: "2026-08-24T10:00:02.000Z",
      },
    ] } },
    agUiStageEvents: { events: [{
      eventId: "event-1",
      eventType: "StepFinished",
      stage: "Execution",
      status: "completed",
      timestamp: "2026-08-24T10:00:00.000Z",
    }] },
  });
  const content = `${JSON.stringify(projection, null, 2)}\n`;
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  try {
    await mkdir(executionDir, { recursive: true });
    await writeFile(path.join(executionDir, `${runId}.live.json`), content, "utf8");
    await writeFile(path.join(executionDir, `${runId}.json`), JSON.stringify({ runId, padding: "x".repeat(8 * 1024 * 1024) }), "utf8");
    await writeFile(path.join(executionDir, "latest.json"), JSON.stringify({
      runId,
      jsonPath: `.meta-kim/state/default/governed-executions/${runId}.json`,
      liveProjectionPath: `.meta-kim/state/default/governed-executions/${runId}.live.json`,
      liveProjectionSha256: digest,
      liveProjectionBytes: Buffer.byteLength(content, "utf8"),
    }), "utf8");
    const repository = createLiveReadRepository({ projectRoot: root });
    const latest = await repository.readLatestArtifact();
    assert.equal(latest.__source, "live_projection");
    assert.equal(latest.run.runId, runId);
    assert.ok(Buffer.byteLength(content, "utf8") <= LIVE_MAX_COMPACT_BYTES);
    assert.equal(projection.nodes.some((node) => node.kind === "stage"), false);
    assert.equal(projection.nodes.find((node) => node.label === "backend")?.status, "pending");
    assert.equal(projection.nodes.find((node) => node.label === "backend")?.toolCalls.length, 3);
    const toolEvent = projection.replay.find((event) => event.kind === "tool_end");
    assert.ok(toolEvent?.nodeId);
    assert.ok(toolEvent?.toolCallId);
    assert.deepEqual(
      new Set(projection.replay.map((event) => event.kind)),
      new Set(["stage", "tool_start", "tool_end", "agent", "failure"]),
    );
    assert.doesNotMatch(content, new RegExp(rawTaskId, "u"));
    assert.doesNotMatch(content, /must-not-project|payload|secret=|Users\/Kim|tool\.exe/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compact projection trims optional detail before nodes and records original versus visible counts", () => {
  const runId = "meta-compact-truncated";
  const workerTaskPackets = Array.from({ length: 80 }, (_, index) => ({
    taskPacketId: `任务-${index}-${"x".repeat(120)}`,
    roleDisplayName: `worker-${index}`,
    ownerAgent: "backend-architect",
    parallelGroup: `group-${index % 8}`,
  }));
  const workerResultPackets = workerTaskPackets.map((packet) => ({
    taskPacketId: packet.taskPacketId,
    status: "completed",
    workerExecutionEvidence: Array.from({ length: 24 }, (_, index) => ({
      status: "passed",
      verifyStepRef: `proof-${index}-${"y".repeat(120)}`,
    })),
  }));
  const projection = buildLiveCompactProjection({
    runId,
    status: "completed",
    workerTaskPackets,
    workerResultPackets,
    verificationPacket: { verificationResults: [{ status: "passed" }] },
  }, { maxBytes: 24 * 1024 });
  assert.ok(Buffer.byteLength(JSON.stringify(projection), "utf8") <= 24 * 1024);
  assert.equal(projection.truncated.applied, true);
  assert.ok(projection.counts.nodes > projection.visibleCounts.nodes);
  assert.ok(projection.truncated.omitted.evidence > 0);
  assert.equal(projection.truncated.omitted.nodes, projection.counts.nodes - projection.visibleCounts.nodes);
  assert.equal(projection.truncated.omitted.evidence, projection.counts.evidence - projection.visibleCounts.evidence);
  assert.equal(projection.truncated.omitted.toolCalls, projection.counts.toolCalls - projection.visibleCounts.toolCalls);
  assert.equal(projection.truncated.omitted.prompts, projection.counts.prompts - projection.visibleCounts.prompts);
  assert.equal(projection.truncated.omitted.provenance, projection.counts.provenance - projection.visibleCounts.provenance);
  assert.equal(projection.truncated.omitted.replay, projection.counts.events - projection.visibleCounts.events);
  assert.equal(projection.truncated.finalBytes, Buffer.byteLength(JSON.stringify(projection), "utf8"));
  assert.equal(projection.nodes.some((node) => node.isMain === true), true);
});

test("repository falls back to the same pointer raw artifact when compact data is missing or corrupt", async () => {
  const root = await projectFixture();
  const executionDir = path.join(root, ".meta-kim", "state", "default", "governed-executions");
  const runId = "meta-compact-fallback";
  const raw = JSON.stringify(artifact(runId));
  try {
    await mkdir(executionDir, { recursive: true });
    await writeFile(path.join(executionDir, `${runId}.json`), raw, "utf8");
    await writeFile(path.join(executionDir, `${runId}.live.json`), "{broken", "utf8");
    await writeFile(path.join(executionDir, "latest.json"), JSON.stringify({
      runId,
      jsonPath: `.meta-kim/state/default/governed-executions/${runId}.json`,
      liveProjectionPath: `.meta-kim/state/default/governed-executions/${runId}.live.json`,
      liveProjectionSha256: "0".repeat(64),
      liveProjectionBytes: 7,
    }), "utf8");
    const latest = await createLiveReadRepository({ projectRoot: root }).readLatestArtifact();
    assert.equal(latest.runId, runId);
    assert.equal(latest.__source, "governed_artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project-root resolution rejects symbolic roots and invalid explicit candidates", async (t) => {
  const root = await projectFixture();
  const link = `${root}-link`;
  try {
    assert.equal(await resolveLiveProjectRoot({ projectRoot: root }), await resolveLiveProjectRoot({ cwd: root }));
    const nested = path.join(root, "nested", "child");
    await mkdir(nested, { recursive: true });
    assert.equal(await resolveLiveProjectRoot({ cwd: nested }), path.resolve(root));
    assert.equal(await resolveLiveProjectRoot({
      cwd: os.tmpdir(),
      env: { CLAUDE_PROJECT_DIR: root },
    }), path.resolve(root));
    assert.equal(await resolveLiveProjectRoot({
      cwd: nested,
      env: { META_KIM_CALLER_CWD: "relative-not-trusted" },
    }), path.resolve(root));
    assert.equal(await resolveLiveProjectRoot({ projectRoot: path.join(root, "missing") }), null);
    try {
      await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
      assert.equal(await resolveLiveProjectRoot({ projectRoot: link }), null);
    } catch (error) {
      if (error?.code === "EPERM") t.diagnostic("symlink creation unavailable on this host");
      else throw error;
    }
  } finally {
    await rm(link, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot truth handles stale, conflicting, proven, and malformed histories", () => {
  const empty = buildLiveSnapshot({ observedAt: "not-a-date" });
  assert.equal(empty.run, null);
  assert.equal(empty.source.kind, "empty");

  const stale = buildLiveSnapshot({
    durableStatus: status(),
    governedArtifact: artifact(),
    observedAt: "2026-08-25T10:00:00.000Z",
    staleAfterMs: 1_000,
  });
  assert.equal(stale.source.stale, false);
  assert.equal(stale.run.runId, "meta-boundary-1");
  assert.equal(stale.nodes.some((node) => node.kind === "stage"), false);

  const durableWins = buildLiveSnapshot({
    durableStatus: status("meta-current", "2026-08-24T10:03:00.000Z"),
    governedArtifact: artifact("meta-old", "2026-08-24T10:02:00.000Z"),
    observedAt: "2026-08-24T10:03:01.000Z",
  });
  assert.equal(durableWins.run.runId, "meta-current");
  assert.equal(durableWins.source.kind, "durable_status");

  const proven = artifact("meta-proof");
  proven.status = "completed";
  proven.verificationPacket = { fixEvidence: [{ result: "passed" }] };
  proven.events = [
    { sequence: 2, timestamp: "2026-08-24T10:00:02.000Z", stage: "Review", status: "completed" },
    { sequence: 1, timestamp: "2026-08-24T10:00:01.000Z", stage: "Execution", status: "running" },
  ];
  const completed = buildLiveSnapshot({
    governedArtifact: proven,
    observedAt: "2026-08-24T10:00:03.000Z",
  });
  assert.equal(completed.run.status, "completed");
  assert.deepEqual(completed.replay.map((event) => event.sequence), [1, 2]);

  proven.events.push({ runId: "meta-other", timestamp: "2026-08-24T10:00:03.000Z" });
  assert.deepEqual(buildLiveSnapshot({
    governedArtifact: proven,
    observedAt: "2026-08-24T10:00:04.000Z",
  }).replay, []);
});

test("service degrades absent and throwing repository methods to honest empty projections", async () => {
  const throwing = createLiveControlRoomService({
    repository: {
      async readDurableStatus() { throw new Error("private"); },
      async readLatestArtifact() { throw new Error("private"); },
      async readArtifact() { throw new Error("private"); },
    },
    clock: () => "invalid-clock",
  });
  assert.equal((await throwing.getSnapshot()).run, null);
  assert.equal((await throwing.getReplay("meta-safe-1")).source.kind, "empty");
  assert.equal((await throwing.getReplay("../bad")).runId, null);

  const absent = createLiveControlRoomService({ repository: {}, clock: () => new Date("2026-08-24T10:00:00Z") });
  assert.equal((await absent.buildSnapshot()).run, null);
  assert.equal((await absent.getReplay("meta-safe-1")).replay.length, 0);
});

test("HTTP boundary rejects mutation and authority abuse and returns bounded fallbacks", async () => {
  const service = {
    async getSnapshot() { throw new Error("private path C:/secret"); },
    async getReplay() { throw new Error("raw secret"); },
  };
  const control = createLiveControlRoomServer({ service, port: 0, pollIntervalMs: 10 });
  const address = await control.start();
  try {
    assert.deepEqual(await control.start(), address);
    const snapshot = await fetch(`${address.url}/api/snapshot`);
    assert.equal(snapshot.status, 200);
    assert.deepEqual(await snapshot.json(), { error: "snapshot_unavailable" });

    const replay = await fetch(`${address.url}/api/replay?runId=meta-safe-1`);
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).replay, []);

    assert.equal((await fetch(`${address.url}/api/replay?runId=../bad`)).status, 400);
    assert.equal((await fetch(`${address.url}/missing`)).status, 404);
    assert.equal((await fetch(`${address.url}/api/snapshot`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${address.url}/api/snapshot`, { headers: { origin: "http://attacker.example" } })).status, 403);
  } finally {
    await control.close();
    await control.close();
  }
});

test("snapshot and SSE surfaces strip any injected control projection", async () => {
  let reads = 0;
  const service = {
    async getSnapshot() {
      reads += 1;
      return {
        run: { runId: "meta-strip-1", status: reads === 1 ? "pending" : reads === 2 ? "active" : "completed" },
        nodes: [],
        edges: [],
        evidence: [],
        replay: [],
        control: {
          controlEnabled: true,
          controlHeader: "x-meta-kim-control-token",
          controlToken: "must-not-leak-123456",
          capabilities: { pause: true, resume: true, reassign: true, handoff: true },
        },
      };
    },
  };
  const control = createLiveControlRoomServer({ service, port: 0, pollIntervalMs: 10 });
  const address = await control.start();
  let events;
  try {
    const snapshot = await fetch(`${address.url}/api/snapshot`);
    const snapshotBody = await snapshot.text();
    assert.equal(snapshot.status, 200);
    assert.doesNotMatch(snapshotBody, /must-not-leak|"control"/u);

    events = await fetch(`${address.url}/api/events`);
    const reader = events.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.doesNotMatch(first, /must-not-leak|"control"/u);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = new TextDecoder().decode((await reader.read()).value || new Uint8Array());
    assert.doesNotMatch(second, /must-not-leak|"control"/u);
    await reader.cancel();
  } finally {
    await events?.body?.cancel?.().catch?.(() => {});
    await control.close();
  }
});

test("server refuses non-loopback binding and convenience start closes cleanly", async () => {
  assert.throws(() => createLiveControlRoomServer({ host: "0.0.0.0" }), /loopback/iu);
  const running = await startLiveControlRoom({ service: {
    async getSnapshot() { return null; },
    async getReplay() { return null; },
  }, port: 0 });
  assert.equal(running.host, "127.0.0.1");
  assert.ok(running.port > 0);
  await running.close();
  assert.equal(running.server.listening, false);
});

test("share is GET-only and control endpoints remain absent by default", async () => {
  const root = await projectFixture();
  await writeFile(path.join(root, ".meta-kim", "state", "default", "active-run.json"), JSON.stringify(status()), "utf8");
  let control;
  try {
    control = createLiveControlRoomServer({ projectRoot: root, port: 0 });
    const address = await control.start();
    const share = await fetch(`${address.url}/api/share`);
    assert.equal(share.status, 200);
    assert.equal((await share.json()).permissions.mutationAllowed, false);
    const markdown = await fetch(`${address.url}/api/share?format=markdown`);
    assert.equal(markdown.status, 200);
    assert.match(await markdown.text(), /read-only/iu);
    assert.equal((await fetch(`${address.url}/api/share`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${address.url}/api/continuation/plan`, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await fetch(`${address.url}/api/commands`, { method: "POST", body: "{}" })).status, 404);
  } finally {
    await control?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("control opt-in requires same-origin and token, then persists through the injected adapter only once", async () => {
  const root = await projectFixture();
  const nowMs = Date.now();
  const runId = "meta-boundary-1";
  const nodeId = "node-boundary-1";
  const command = createLiveContinuationCommand({
    action: "resume",
    runId,
    nodeId,
    expectedRevision: 1,
    checkpointId: null,
    effectState: "none",
    claim: { attemptId: "attempt-boundary-1", ownerId: "owner-boundary-1", leaseExpiresAtMs: nowMs + 200_000, fenceToken: 1 },
    actor: "actor-boundary-1",
    runtimeAdapter: "fake-boundary",
    runtime: "fake",
    nonce: "nonce-boundary-1",
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + 100_000,
    payload: {},
  });
  const authority = {
    runId,
    status: "active",
    cursor: 1,
    headCheckpointId: null,
    resumable: true,
    activeClaims: [{ runId, nodeId, attemptId: "attempt-boundary-1", leaseOwner: "owner-boundary-1", leaseExpiresAtMs: nowMs + 200_000, fenceToken: 1 }],
    blockingEffects: [],
  };
  const calls = [];
  const adapterRegistry = createLiveRuntimeAdapterRegistry({ adapters: [createFakeLiveRuntimeAdapter({
    adapterId: "fake-boundary",
    runtime: "fake",
    execute: async (request) => { calls.push(request); return { accepted: true }; },
  })] });
  const durableRepository = withEffectProtocol({ resumeRun: () => authority, verifyEventChain: () => ({ ok: true, runId }) });
  const planner = createLiveContinuationPlanner({
    repository: durableRepository,
    adapterRegistry,
  });
  const commandStore = createLiveContinuationCommandStore({ projectRoot: root, clock: () => nowMs });
  const controlCommandBuilder = () => command;
  const controlCapabilities = { pause: true, resume: true, reassign: true, handoff: true };
  const controlAdapterBindings = {
    pause: { adapterId: "fake-boundary", runtime: "fake" },
    resume: { adapterId: "fake-boundary", runtime: "fake" },
    reassign: { adapterId: "fake-boundary", runtime: "fake" },
    handoff: { adapterId: "fake-boundary", runtime: "fake" },
  };
  let control;
  try {
    control = createLiveControlRoomServer({ projectRoot: root, port: 0, enableControl: true, continuationPlanner: planner, durableRepository, commandStore, adapterRegistry, controlCommandBuilder, controlCapabilities, controlAdapterBindings });
    const address = await control.start();
    const body = JSON.stringify(command);
    const planResponse = await fetch(`${address.url}/api/continuation/plan`, {
      method: "POST", headers: { origin: address.url, "content-type": "application/json" }, body,
    });
    assert.equal(planResponse.status, 200);
    assert.equal((await planResponse.json()).executionAllowed, false);
    assert.equal((await fetch(`${address.url}/api/commands`, { method: "POST", headers: { origin: address.url, "content-type": "application/json" }, body })).status, 403);
    assert.equal((await fetch(`${address.url}/api/commands`, { method: "POST", headers: { origin: "http://attacker.example", [control.controlHeader]: control.controlToken, "content-type": "application/json" }, body })).status, 403);
    const executed = await fetch(`${address.url}/api/commands`, {
      method: "POST",
      headers: { origin: address.url, [control.controlHeader]: control.controlToken, "content-type": "application/json" },
      body,
    });
    assert.equal(executed.status, 200);
    const executedBody = await executed.json();
    assert.equal(executedBody.status, "adapter_invoked");
    assert.equal(executedBody.adapterInvocationObserved, true);
    assert.equal(executedBody.effectState, "in_doubt");
    assert.equal(executedBody.completionVerified, false);
    assert.equal(Object.hasOwn(executedBody, "executionAllowed"), false);
    assert.equal(Object.hasOwn(executedBody, "mutationAllowed"), false);
    const replayed = await fetch(`${address.url}/api/commands`, {
      method: "POST",
      headers: { origin: address.url, [control.controlHeader]: control.controlToken, "content-type": "application/json" },
      body,
    });
  assert.equal(replayed.status, 409);
    assert.equal(calls.length, 1);
  } finally {
    await control?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("control exposure requires the complete injected loadout and builds browser intents from a fresh snapshot", async () => {
  const root = await projectFixture();
  const nowMs = Date.now();
  const runId = "meta-builder-1";
  const nodeId = "node-builder-1";
  const authority = {
    runId,
    status: "active",
    cursor: 1,
    headCheckpointId: null,
    resumable: true,
    activeClaims: [{ runId, nodeId, attemptId: "attempt-builder-1", leaseOwner: "owner-builder-1", leaseExpiresAtMs: nowMs + 200_000, fenceToken: 1 }],
    blockingEffects: [],
  };
  const durableRepository = withEffectProtocol({
    resumeRun: () => authority,
    verifyEventChain: () => ({ ok: true, runId }),
  });
  const calls = [];
  const adapterRegistry = createLiveRuntimeAdapterRegistry({ adapters: [createFakeLiveRuntimeAdapter({
    adapterId: "fake-builder",
    runtime: "fake",
    execute: async (request) => { calls.push(request); return { accepted: true }; },
  })] });
  const planner = createLiveContinuationPlanner({ repository: durableRepository, adapterRegistry });
  const commandStore = createLiveContinuationCommandStore({ projectRoot: root, clock: () => nowMs });
  const snapshots = [];
  const service = {
    async getSnapshot() {
      const snapshot = { run: { runId, status: "active" }, nodes: [], edges: [], evidence: [], replay: [], permissions: { projectionOnly: true, executionAllowed: false, mutationAllowed: false } };
      snapshots.push(snapshot);
      return snapshot;
    },
    planContinuation(command, overrides) { return planner.plan(command, overrides); },
    executeContinuation(plan, overrides) { return planner.execute(plan, { ...overrides, commandStore, adapterRegistry }); },
  };
  const builderCalls = [];
  const controlCommandBuilder = ({ action, runId: intentRunId, snapshot, nowMs: builderNowMs }) => {
    builderCalls.push({ action, runId: intentRunId, snapshot, nowMs: builderNowMs });
    return createLiveContinuationCommand({
      action,
      runId: intentRunId,
      nodeId,
      expectedRevision: 1,
      checkpointId: null,
      effectState: "none",
      claim: { attemptId: "attempt-builder-1", ownerId: "owner-builder-1", leaseExpiresAtMs: builderNowMs + 100_000, fenceToken: 1 },
      actor: "actor-builder-1",
      runtimeAdapter: "fake-builder",
      runtime: "fake",
      nonce: `nonce-builder-${builderCalls.length}`,
      issuedAtMs: builderNowMs,
      expiresAtMs: builderNowMs + 50_000,
      payload: {},
    });
  };
  const capabilities = { pause: true, resume: true, reassign: true, handoff: true };
  const controlAdapterBindings = {
    pause: { adapterId: "fake-builder", runtime: "fake" },
    resume: { adapterId: "fake-builder", runtime: "fake" },
    reassign: { adapterId: "fake-builder", runtime: "fake" },
    handoff: { adapterId: "fake-builder", runtime: "fake" },
  };
  let control;
  try {
    control = createLiveControlRoomServer({
      service,
      port: 0,
      enableControl: true,
      durableRepository,
      adapterRegistry,
      controlCommandBuilder,
      controlCapabilities: capabilities,
      controlAdapterBindings,
      commandStore,
    });
    const address = await control.start();
    const page = await fetch(address.url);
    const pageHtml = await page.text();
    assert.equal(page.status, 200);
    assert.equal(address.controlEnabled, true);
    assert.match(pageHtml, /data-live-control-action="resume"/u);
    assert.match(pageHtml, new RegExp(control.controlToken, "u"));
    assert.equal((await fetch(`${address.url}/api/commands`, {
      method: "POST",
      headers: { origin: address.url, "content-type": "application/json" },
      body: JSON.stringify({ action: "resume", runId }),
    })).status, 403);
    const response = await fetch(`${address.url}/api/commands`, {
      method: "POST",
      headers: { origin: address.url, [control.controlHeader]: control.controlToken, "content-type": "application/json" },
      body: JSON.stringify({ action: "resume", runId }),
    });
    assert.equal(response.status, 200);
    const responseBody = await response.json();
    assert.equal(responseBody.status, "adapter_invoked");
    assert.equal(responseBody.adapterInvocationObserved, true);
    assert.equal(responseBody.effectState, "in_doubt");
    assert.equal(responseBody.completionVerified, false);
    assert.equal(Object.hasOwn(responseBody, "executionAllowed"), false);
    assert.equal(Object.hasOwn(responseBody, "mutationAllowed"), false);
    assert.equal(builderCalls.length, 1);
    assert.equal(builderCalls[0].snapshot, snapshots.at(-1));
    assert.equal(builderCalls[0].nowMs >= nowMs, true);
    assert.equal(calls.length, 1);
  } finally {
    await control?.close();
    await rm(root, { recursive: true, force: true });
  }

  for (const omission of ["controlCommandBuilder", "adapterRegistry", "durableRepository", "controlAdapterBindings", "commandStore", "effectProtocol"]) {
    let planCalls = 0;
    let executeCalls = 0;
    let appendCalls = 0;
    const unavailableCommandStore = { append: async () => { appendCalls += 1; } };
    const options = {
      service: {
        async getSnapshot() { return { run: { runId }, nodes: [], edges: [], evidence: [], replay: [] }; },
        async planContinuation() { planCalls += 1; throw new Error("plan must not be called"); },
        async executeContinuation() { executeCalls += 1; throw new Error("execute must not be called"); },
      },
      port: 0,
      enableControl: true,
      durableRepository,
      adapterRegistry,
      controlCommandBuilder,
      controlCapabilities: capabilities,
      controlAdapterBindings,
      commandStore: unavailableCommandStore,
    };
    if (omission === "effectProtocol") options.durableRepository = { resumeRun: durableRepository.resumeRun, verifyEventChain: durableRepository.verifyEventChain };
    delete options[omission];
    const unavailable = createLiveControlRoomServer(options);
    const unavailableAddress = await unavailable.start();
    try {
      const html = await (await fetch(unavailableAddress.url)).text();
      assert.equal(unavailableAddress.controlEnabled, false);
      assert.doesNotMatch(html, /data-live-control-action="(?:pause|resume|reassign|handoff)"/u);
      const rejected = await fetch(`${unavailableAddress.url}/api/commands`, {
        method: "POST",
        headers: { origin: unavailableAddress.url, [unavailable.controlHeader]: unavailable.controlToken, "content-type": "application/json" },
        body: JSON.stringify({ command: { action: "resume", runId } }),
      });
      assert.equal(rejected.status, 503);
      assert.equal(planCalls, 0);
      assert.equal(executeCalls, 0);
      assert.equal(appendCalls, 0);
    } finally {
      await unavailable.close();
    }
  }
});

test("browser builder output cannot select an adapter outside the action binding", async () => {
  const root = await projectFixture();
  const nowMs = Date.now();
  const runId = "meta-builder-binding-mismatch";
  const nodeId = "node-builder-binding-mismatch";
  const authority = {
    runId,
    status: "active",
    cursor: 1,
    headCheckpointId: null,
    resumable: true,
    activeClaims: [{ runId, nodeId, attemptId: "attempt-builder-binding-mismatch", leaseOwner: "owner-builder-binding-mismatch", leaseExpiresAtMs: nowMs + 200_000, fenceToken: 1 }],
    blockingEffects: [],
  };
  const durableRepository = withEffectProtocol({
    resumeRun: () => authority,
    verifyEventChain: () => ({ ok: true, runId }),
  });
  const adapterCalls = [];
  const adapterRegistry = createLiveRuntimeAdapterRegistry({ adapters: [
    createFakeLiveRuntimeAdapter({ adapterId: "fake-bound-builder", runtime: "fake", execute: async (request) => { adapterCalls.push(request); return { accepted: true }; } }),
    createFakeLiveRuntimeAdapter({ adapterId: "fake-unbound-builder", runtime: "fake", execute: async (request) => { adapterCalls.push(request); return { accepted: true }; } }),
  ] });
  const planner = createLiveContinuationPlanner({ repository: durableRepository, adapterRegistry });
  let planCalls = 0;
  let executeCalls = 0;
  let appendCalls = 0;
  const commandStore = { append: async () => { appendCalls += 1; } };
  const service = {
    async getSnapshot() { return { run: { runId, status: "active" }, nodes: [], edges: [], evidence: [], replay: [] }; },
    planContinuation(command, overrides) { planCalls += 1; return planner.plan(command, overrides); },
    executeContinuation(plan, overrides) { executeCalls += 1; return planner.execute(plan, { ...overrides, commandStore, durableRepository, adapterRegistry }); },
  };
  const controlCommandBuilder = ({ action, runId: intentRunId, nowMs: builderNowMs }) => createLiveContinuationCommand({
    action,
    runId: intentRunId,
    nodeId,
    expectedRevision: 1,
    checkpointId: null,
    effectState: "none",
    claim: { attemptId: "attempt-builder-binding-mismatch", ownerId: "owner-builder-binding-mismatch", leaseExpiresAtMs: builderNowMs + 100_000, fenceToken: 1 },
    actor: "actor-builder-binding-mismatch",
    runtimeAdapter: "fake-unbound-builder",
    runtime: "fake",
    nonce: "nonce-builder-binding-mismatch",
    issuedAtMs: builderNowMs,
    expiresAtMs: builderNowMs + 50_000,
    payload: {},
  });
  const controlAdapterBindings = Object.fromEntries(["pause", "resume", "reassign", "handoff"].map((action) => [action, { adapterId: "fake-bound-builder", runtime: "fake" }]));
  let control;
  try {
    control = createLiveControlRoomServer({
      service,
      port: 0,
      enableControl: true,
      durableRepository,
      adapterRegistry,
      commandStore,
      controlCommandBuilder,
      controlCapabilities: { pause: true, resume: true, reassign: true, handoff: true },
      controlAdapterBindings,
    });
    const address = await control.start();
    const response = await fetch(`${address.url}/api/commands`, {
      method: "POST",
      headers: { origin: address.url, [control.controlHeader]: control.controlToken, "content-type": "application/json" },
      body: JSON.stringify({ action: "resume", runId }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { status: "blocked", executionAllowed: false, mutationAllowed: false, error: "continuation_blocked" });
    assert.equal(planCalls, 0);
    assert.equal(executeCalls, 0);
    assert.equal(appendCalls, 0);
    assert.equal(adapterCalls.length, 0);
  } finally {
    await control?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("complete commands cannot select an adapter outside the action binding", async () => {
  const root = await projectFixture();
  const nowMs = Date.now();
  const runId = "meta-complete-binding-mismatch";
  const nodeId = "node-complete-binding-mismatch";
  const authority = {
    runId,
    status: "active",
    cursor: 1,
    headCheckpointId: null,
    resumable: true,
    activeClaims: [{ runId, nodeId, attemptId: "attempt-complete-binding-mismatch", leaseOwner: "owner-complete-binding-mismatch", leaseExpiresAtMs: nowMs + 200_000, fenceToken: 1 }],
    blockingEffects: [],
  };
  const durableRepository = withEffectProtocol({
    resumeRun: () => authority,
    verifyEventChain: () => ({ ok: true, runId }),
  });
  const adapterCalls = [];
  const adapterRegistry = createLiveRuntimeAdapterRegistry({ adapters: [
    createFakeLiveRuntimeAdapter({ adapterId: "fake-bound-complete", runtime: "fake", execute: async (request) => { adapterCalls.push(request); return { accepted: true }; } }),
    createFakeLiveRuntimeAdapter({ adapterId: "fake-unbound-complete", runtime: "fake", execute: async (request) => { adapterCalls.push(request); return { accepted: true }; } }),
  ] });
  const planner = createLiveContinuationPlanner({ repository: durableRepository, adapterRegistry });
  let planCalls = 0;
  let executeCalls = 0;
  let appendCalls = 0;
  const commandStore = { append: async () => { appendCalls += 1; } };
  const service = {
    async getSnapshot() { return { run: { runId, status: "active" }, nodes: [], edges: [], evidence: [], replay: [] }; },
    planContinuation(command, overrides) { planCalls += 1; return planner.plan(command, overrides); },
    executeContinuation(plan, overrides) { executeCalls += 1; return planner.execute(plan, { ...overrides, commandStore, durableRepository, adapterRegistry }); },
  };
  const command = createLiveContinuationCommand({
    action: "resume",
    runId,
    nodeId,
    expectedRevision: 1,
    checkpointId: null,
    effectState: "none",
    claim: { attemptId: "attempt-complete-binding-mismatch", ownerId: "owner-complete-binding-mismatch", leaseExpiresAtMs: nowMs + 100_000, fenceToken: 1 },
    actor: "actor-complete-binding-mismatch",
    runtimeAdapter: "fake-unbound-complete",
    runtime: "fake",
    nonce: "nonce-complete-binding-mismatch",
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + 50_000,
    payload: {},
  });
  const controlAdapterBindings = Object.fromEntries(["pause", "resume", "reassign", "handoff"].map((action) => [action, { adapterId: "fake-bound-complete", runtime: "fake" }]));
  let control;
  try {
    control = createLiveControlRoomServer({
      service,
      port: 0,
      enableControl: true,
      durableRepository,
      adapterRegistry,
      commandStore,
      controlCommandBuilder: () => command,
      controlCapabilities: { pause: true, resume: true, reassign: true, handoff: true },
      controlAdapterBindings,
    });
    const address = await control.start();
    const response = await fetch(`${address.url}/api/commands`, {
      method: "POST",
      headers: { origin: address.url, [control.controlHeader]: control.controlToken, "content-type": "application/json" },
      body: JSON.stringify({ command }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { status: "blocked", executionAllowed: false, mutationAllowed: false, error: "continuation_blocked" });
    assert.equal(planCalls, 0);
    assert.equal(executeCalls, 0);
    assert.equal(appendCalls, 0);
    assert.equal(adapterCalls.length, 0);
  } finally {
    await control?.close();
    await rm(root, { recursive: true, force: true });
  }
});
