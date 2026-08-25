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
  assert.equal(snapshot.nodes.find((node) => node.id === "stage:critical")?.status, "in_doubt");
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
    unproven.nodes.find((node) => node.id === "worker:task-unproven")?.status,
    "in_doubt",
  );
  assert.ok(unproven.evidence.length > 0);
  assert.ok(unproven.evidence.every((item) => item.status === "in_doubt"));

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
    proven.nodes.find((node) => node.id === "worker:task-proven")?.status,
    "completed",
  );
  assert.ok(proven.evidence.some((item) => item.status === "completed"));
});

test("binds evidence to known stage/worker nodes without accepting hostile ids", () => {
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

  const verification = snapshot.evidence.filter((item) => item.type === "verification");
  assert.equal(verification[0]?.nodeId, "stage:verification");
  assert.equal(verification[1]?.nodeId, "worker:task-backend-1");

  const review = snapshot.evidence.filter((item) => item.type === "review");
  assert.equal(review.length, 2);
  assert.ok(review.every((item) => item.nodeId === "stage:review"));

  const status = snapshot.evidence.filter((item) => item.type === "status");
  assert.equal(status.length, 1);
  assert.equal(status[0].nodeId, "");
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
      { taskPacketId: "task-backend-1", status: "completed" },
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
    assert.equal(snapshot.schemaVersion, "meta-kim-live-snapshot-v1");
    assert.equal(snapshot.source.kind, "durable_status");
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
    assert.equal((await snapshotResponse.json()).schemaVersion, "meta-kim-live-snapshot-v1");
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
  assert.equal(replay.replay[0].nodeId, "stage:execution");
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
    assert.equal(JSON.parse(payload).schemaVersion, "meta-kim-live-snapshot-v1");
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
