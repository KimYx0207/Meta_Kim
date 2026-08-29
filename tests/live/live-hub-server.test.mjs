import assert from "node:assert/strict";
import test from "node:test";

import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";

function snapshot(runId) {
  return {
    schemaVersion: "meta-kim-live-snapshot-v1",
    run: runId ? { runId, id: runId, title: `Run ${runId}`, status: "live" } : null,
    nodes: [],
    edges: [],
    evidence: [],
    replay: [],
    source: { kind: "governed_artifact", observedAt: "2026-08-26T09:00:00.000Z", stale: false },
    permissions: { projectionOnly: true, executionAllowed: false, mutationAllowed: false },
  };
}

function hubFixture() {
  const internal = {
    projectRef: "project-a1b2c3d4e5f6",
    repoRoot: "C:\\private\\project",
    displayName: "Visible Project",
    updatedAt: "2026-08-26T09:00:00.000Z",
    status: "active",
    activeSessionId: "meta-run-2",
    sessionCount: 2,
    sessions: [
      { sessionId: "meta-run-2", runId: "meta-run-2", title: "Current run", status: "active", currentStage: "execution", runtime: "codex", updatedAt: "2026-08-26T09:00:00.000Z", nodeCount: 10, eventCount: 24, active: true, repoRoot: "C:\\private\\nested" },
      { sessionId: "meta-run-1", runId: "meta-run-1", title: "Earlier run", status: "completed", currentStage: "verification", runtime: "claude", updatedAt: "2026-08-26T08:00:00.000Z", nodeCount: 129, eventCount: -1, active: false },
    ],
  };
  return {
    internal,
    catalog: {
      listProjects: async () => [{ ...internal }],
      resolveProject: async (projectRef) => projectRef === internal.projectRef ? { ...internal } : null,
    },
  };
}

test("global Hub publishes path-free project catalog and selected session APIs", async (t) => {
  const { internal, catalog } = hubFixture();
  const calls = [];
  const controller = createLiveControlRoomServer({
    globalHub: true,
    instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    hubCatalog: catalog,
    createProjectService: ({ projectRef, repoRoot }) => ({
      getSnapshot: async (runId) => {
        calls.push({ kind: "snapshot", projectRef, repoRoot, runId });
        return snapshot(runId);
      },
      getReplay: async (runId) => ({
        schemaVersion: "meta-kim-live-replay-v2",
        runId,
        replay: [{ id: "event-1", label: "Observed" }],
        source: snapshot(runId).source,
        permissions: snapshot(runId).permissions,
      }),
      getShare: async () => ({ schemaVersion: "meta-kim-live-share-v1" }),
    }),
  });
  t.after(() => controller.close());
  const address = await controller.start();

  const catalogResponse = await fetch(`${address.url}/api/projects`);
  assert.equal(catalogResponse.status, 200);
  const publicCatalog = await catalogResponse.json();
  assert.equal(publicCatalog.schemaVersion, "meta-kim-live-hub-catalog-v1");
  assert.equal(publicCatalog.projects[0].projectId, internal.projectRef);
  assert.equal(publicCatalog.projects[0].projectRef, undefined);
  assert.equal(publicCatalog.selected.runId, "meta-run-2");
  assert.equal(publicCatalog.projects[0].sessions[0].nodeCount, 10);
  assert.equal(publicCatalog.projects[0].sessions[0].eventCount, 24);
  assert.equal(publicCatalog.projects[0].sessions[1].nodeCount, undefined);
  assert.equal(publicCatalog.projects[0].sessions[1].eventCount, undefined);
  assert.doesNotMatch(JSON.stringify(publicCatalog), /repoRoot|private|C:\\/iu);

  const selected = new URL(`${address.url}/api/snapshot`);
  selected.searchParams.set("projectId", internal.projectRef);
  selected.searchParams.set("runId", "meta-run-1");
  const selectedResponse = await fetch(selected);
  assert.equal(selectedResponse.status, 200);
  assert.equal((await selectedResponse.json()).run.runId, "meta-run-1");
  assert.deepEqual(calls.at(-1), {
    kind: "snapshot",
    projectRef: internal.projectRef,
    repoRoot: internal.repoRoot,
    runId: "meta-run-1",
  });

  const replay = new URL(`${address.url}/api/replay`);
  replay.searchParams.set("projectId", internal.projectRef);
  replay.searchParams.set("runId", "meta-run-1");
  assert.equal((await (await fetch(replay)).json()).runId, "meta-run-1");
});

test("global Hub rejects unknown selections and exposes an instance-bound health proof", async (t) => {
  const { catalog } = hubFixture();
  const instanceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const controller = createLiveControlRoomServer({
    globalHub: true,
    enableControl: true,
    instanceId,
    hubCatalog: catalog,
    createProjectService: () => ({ getSnapshot: async (runId) => snapshot(runId) }),
  });
  t.after(() => controller.close());
  const address = await controller.start();

  const health = await (await fetch(`${address.url}/api/health`)).json();
  assert.equal(health.instanceId, instanceId);
  assert.equal(health.singleton, true);
  assert.equal(health.readOnly, true);
  assert.equal(health.profile, "default");
  assert.equal(address.controlEnabled, false);

  const unknownProject = await fetch(`${address.url}/api/snapshot?projectId=project-000000000000&runId=meta-run-1`);
  assert.equal(unknownProject.status, 404);
  const unknownRun = await fetch(`${address.url}/api/snapshot?projectId=project-a1b2c3d4e5f6&runId=meta-missing`);
  assert.equal(unknownRun.status, 404);
  const unknownReplay = await fetch(`${address.url}/api/replay?projectId=project-a1b2c3d4e5f6&runId=meta-missing`);
  assert.equal(unknownReplay.status, 404);
  assert.equal((await unknownReplay.json()).schemaVersion, "meta-kim-live-replay-v2");
  const fallbackReplay = await fetch(`${address.url}/api/replay?projectId=project-a1b2c3d4e5f6&runId=meta-run-2`);
  assert.equal(fallbackReplay.status, 200);
  assert.equal((await fallbackReplay.json()).schemaVersion, "meta-kim-live-replay-v2");
  const page = await (await fetch(`${address.url}/?projectId=project-a1b2c3d4e5f6&runId=meta-run-2`)).text();
  assert.match(page, /data-live-project-select/u);
  assert.match(page, /data-live-session-select/u);
});

test("Hub keeps SSE clients alive and chooses the newest idle project deterministically", async (t) => {
  const projects = [
    {
      projectRef: "project-111111111111",
      repoRoot: "C:\\private\\old",
      displayName: "Older",
      status: "idle",
      activeSessionId: null,
      sessionCount: 1,
      updatedAt: "2026-08-26T08:00:00.000Z",
      sessions: [{ sessionId: "meta-old", runId: "meta-old", title: "Old", status: "completed", currentStage: "verification", runtime: "codex", updatedAt: "2026-08-26T08:00:00.000Z", active: false }],
    },
    {
      projectRef: "project-222222222222",
      repoRoot: "C:\\private\\new",
      displayName: "Newer",
      status: "idle",
      activeSessionId: null,
      sessionCount: 1,
      updatedAt: "2026-08-26T10:00:00.000Z",
      sessions: [{ sessionId: "meta-new", runId: "meta-new", title: "New", status: "completed", currentStage: "verification", runtime: "codex", updatedAt: "2026-08-26T10:00:00.000Z", active: false }],
    },
  ];
  const controller = createLiveControlRoomServer({
    globalHub: true,
    instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    heartbeatIntervalMs: 15,
    hubCatalog: {
      listProjects: async () => projects,
      resolveProject: async (projectRef) => projects.find((project) => project.projectRef === projectRef) || null,
    },
    createProjectService: () => ({ getSnapshot: async (runId) => snapshot(runId) }),
  });
  t.after(() => controller.close());
  const address = await controller.start();
  const catalog = await (await fetch(`${address.url}/api/projects`)).json();
  assert.equal(catalog.selected.projectId, "project-222222222222");
  assert.deepEqual(catalog.projects.map((project) => project.projectId), [
    "project-222222222222",
    "project-111111111111",
  ]);

  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = await fetch(`${address.url}/api/events?projectId=project-222222222222&runId=meta-new`, { signal: abort.signal });
  assert.equal(events.status, 200);
  const reader = events.body.getReader();
  let observed = "";
  const deadline = Date.now() + 500;
  while (!observed.includes(": keep-alive") && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: true, value: new Uint8Array() }), 100)),
    ]);
    if (next.done) continue;
    observed += new TextDecoder().decode(next.value);
  }
  assert.match(observed, /: keep-alive/u);
  await reader.cancel();
});
