import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";
import { joinProjectRegistry } from "../../scripts/project-registry.mjs";

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
      { sessionId: "meta-run-2", runId: "meta-run-2", title: "Current run", status: "active", displayState: "active", statusReason: "运行当前仍处于活动状态。", sourceRuntime: "codex", conversationLinkState: "verified", verifiedLinks: [{ sourceRuntime: "codex", conversationRef: "codex-thread-20260830", matchBasis: "exact_run_id" }], candidateLinks: [{ sourceRuntime: "claude", conversationRef: "claude-candidate-20260830", matchBasis: "title_time_project_similarity" }], currentStage: "execution", runtime: "codex", updatedAt: "2026-08-26T09:00:00.000Z", nodeCount: 10, eventCount: 24, active: true, repoRoot: "C:\\private\\nested" },
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

  const brandMark = await fetch(`${address.url}/assets/meta-kim-k-mark.png`);
  assert.equal(brandMark.status, 200);
  assert.equal(brandMark.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await brandMark.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const catalogResponse = await fetch(`${address.url}/api/projects`);
  assert.equal(catalogResponse.status, 200);
  const publicCatalog = await catalogResponse.json();
  assert.equal(publicCatalog.schemaVersion, "meta-kim-live-hub-catalog-v1");
  assert.equal(publicCatalog.projects[0].projectId, internal.projectRef);
  assert.equal(publicCatalog.projects[0].projectRef, undefined);
  assert.equal(publicCatalog.selected.runId, "meta-run-2");
  assert.equal(publicCatalog.projects[0].sessions[0].nodeCount, 10);
  assert.equal(publicCatalog.projects[0].sessions[0].eventCount, 24);
  assert.equal(publicCatalog.projects[0].sessions[0].displayState, "active");
  assert.equal(publicCatalog.projects[0].sessions[0].conversationLinkState, "verified");
  assert.deepEqual(publicCatalog.projects[0].sessions[0].verifiedLinks, [{ sourceRuntime: "codex", conversationRef: "codex-thread-20260830", matchBasis: "exact_run_id" }]);
  assert.deepEqual(publicCatalog.projects[0].sessions[0].candidateLinks, [{ sourceRuntime: "claude", conversationRef: "claude-candidate-20260830", matchBasis: "title_time_project_similarity" }]);
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

// The public catalog rebuilds each session from an allow-list, so a field the
// catalog emits but this boundary does not name is silently dropped before it
// reaches a reader. Origin marked at write time and unmarked in the browser is
// worse than no marking at all: the panel would then assert that a fixture is a
// real governed run.
test("public catalog carries declared record origin and refuses a self-declared label", async (t) => {
  const { internal } = hubFixture();
  const sessions = [
    { ...internal.sessions[0], recordOrigin: "acceptance_fixture" },
    { ...internal.sessions[1], recordOrigin: "definitely-real" },
    { sessionId: "meta-run-0", runId: "meta-run-0", title: "Unmarked run", status: "completed", currentStage: "verification", runtime: "claude", updatedAt: "2026-08-26T07:00:00.000Z", active: false },
  ];
  const controller = createLiveControlRoomServer({
    globalHub: true,
    instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    hubCatalog: {
      listProjects: async () => [{ ...internal, sessionCount: sessions.length, sessions }],
      resolveProject: async () => ({ ...internal, sessions }),
    },
    createProjectService: () => ({
      getSnapshot: async (runId) => snapshot(runId),
      getReplay: async () => ({ schemaVersion: "meta-kim-live-replay-v2", replay: [] }),
      getShare: async () => ({ schemaVersion: "meta-kim-live-share-v1" }),
    }),
  });
  t.after(() => controller.close());
  const address = await controller.start();

  const publicCatalog = await (await fetch(`${address.url}/api/projects`)).json();
  const originByRun = new Map(
    publicCatalog.projects[0].sessions.map((session) => [session.runId, session.recordOrigin]),
  );
  assert.equal(originByRun.get("meta-run-2"), "acceptance_fixture");
  assert.equal(
    originByRun.get("meta-run-1"),
    "governed_run",
    "an unrecognized origin must not reach the browser verbatim",
  );
  assert.equal(
    originByRun.get("meta-run-0"),
    "governed_run",
    "a session that declares no origin is a governed run",
  );
});

test("mixed-state demo page is server-isolated from real catalog and snapshot data", async (t) => {
  let catalogCalls = 0;
  let snapshotCalls = 0;
  let projectServiceCalls = 0;
  const controller = createLiveControlRoomServer({
    globalHub: true,
    instanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    service: {
      getSnapshot: async () => {
        snapshotCalls += 1;
        return { ...snapshot("meta-private-run"), marker: "PRIVATE_SNAPSHOT_MARKER" };
      },
    },
    hubCatalog: {
      listProjects: async () => {
        catalogCalls += 1;
        return [{ ...hubFixture().internal, displayName: "PRIVATE_PROJECT_MARKER" }];
      },
      resolveProject: async () => hubFixture().internal,
    },
    createProjectService: () => {
      projectServiceCalls += 1;
      return { getSnapshot: async () => snapshot("meta-private-project-run") };
    },
  });
  t.after(() => controller.close());
  const address = await controller.start();

  const response = await fetch(`${address.url}/?demo=states`);
  const page = await response.text();
  assert.equal(response.status, 200);
  assert.equal(catalogCalls, 0);
  assert.equal(snapshotCalls, 0);
  assert.equal(projectServiceCalls, 0);
  assert.doesNotMatch(page, /PRIVATE_(?:PROJECT|SNAPSHOT)_MARKER|meta-private/iu);
  assert.match(page, /const demoMode\s*=.+searchParams\.get\("demo"\)\s*===\s*"states"/u);
  assert.match(page, /<script type="application\/json" id="live-initial-snapshot">null<\/script>/u);
  assert.match(page, /<script type="application\/json" id="live-initial-catalog">null<\/script>/u);
});

test("real loopback Hub serves a registered temporary project without private fields", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-hub-home-"));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-hub-project-"));
  await mkdir(path.join(projectRoot, ".git"));
  const executionRoot = path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions");
  await mkdir(executionRoot, { recursive: true });
  await writeFile(path.join(executionRoot, "meta-hub-4331.json"), JSON.stringify({
    schemaVersion: "governed-execution-v1",
    runId: "meta-hub-4331",
    status: "pending",
    updatedAt: "2026-08-30T09:00:00.000Z",
    sourceConversation: {
      runtime: "codex",
      conversationId: "01a04c60-33fe-79f3-a38a-d52fcae64d4d",
      runId: "meta-hub-4331",
      title: "Temporary Hub acceptance",
    },
  }), "utf8");
  const registration = await joinProjectRegistry({ homeDir, repoPath: projectRoot });
  const controller = createLiveControlRoomServer({ globalHub: true, homeDir, port: 0 });
  t.after(async () => {
    await controller.close();
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const address = await controller.start();
  const response = await fetch(`${address.url}/api/projects`);
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.equal(catalog.projects[0].projectId, registration.projectRef);
  assert.equal(catalog.projects[0].sessions[0].conversationLinkState, "verified");
  assert.equal(catalog.projects[0].sessions[0].conversationDiscovery.state, "metadata_only");
  assert.doesNotMatch(JSON.stringify(catalog), new RegExp(projectRoot.replaceAll("\\", "\\\\"), "u"));
});

test("the public catalog only reports a discovery result the record actually carries", async (t) => {
  // The reason strings are claims about what was inspected. Synthesizing one for
  // a record that carries no discovery block makes "nothing was recorded" read
  // as "a runtime was looked for and none was safe" — and on a session that
  // already has a verified link, the two statements contradict each other.
  const silent = {
    sessionId: "meta-run-silent",
    runId: "meta-run-silent",
    title: "Record with no discovery block",
    status: "completed",
    conversationLinkState: "verified",
    verifiedLinks: [{ sourceRuntime: "codex", conversationRef: "codex-thread-silent", matchBasis: "exact_run_id" }],
  };
  const declared = {
    sessionId: "meta-run-declared",
    runId: "meta-run-declared",
    title: "Record with a discovery block",
    status: "completed",
    conversationLinkState: "unlinked",
    conversationDiscovery: { state: "metadata_only", runtime: "claude", reason: "run_bound_metadata_only" },
  };
  // A record can reach how far the lookup got without recording why. Publishing
  // it whole and publishing nothing are both covered above, so a default reason
  // filled in here would pass both of those and still put a sentence nobody
  // wrote in front of the reader.
  const partial = {
    sessionId: "meta-run-partial",
    runId: "meta-run-partial",
    title: "Record with a state but no reason",
    status: "completed",
    conversationLinkState: "unlinked",
    conversationDiscovery: { state: "unsupported" },
  };
  const project = {
    projectRef: "project-discovery-honesty",
    repoRoot: "C:\\private\\discovery",
    displayName: "Discovery Honesty",
    updatedAt: "2026-09-02T09:00:00.000Z",
    status: "idle",
    activeSessionId: null,
    sessionCount: 3,
    sessions: [silent, declared, partial],
  };
  const controller = createLiveControlRoomServer({
    globalHub: true,
    hubCatalog: {
      listProjects: async () => [{ ...project }],
      resolveProject: async (projectRef) => (projectRef === project.projectRef ? { ...project } : null),
    },
    createProjectService: () => ({ getSnapshot: async (runId) => snapshot(runId) }),
  });
  t.after(() => controller.close());
  const address = await controller.start();

  const catalog = await (await fetch(`${address.url}/api/projects`)).json();
  const published = new Map(catalog.projects[0].sessions.map((session) => [session.sessionId, session]));

  assert.equal(
    Object.hasOwn(published.get("meta-run-silent"), "conversationDiscovery"),
    false,
    "a record with no discovery block must not be published with a fabricated one",
  );
  assert.deepEqual(
    published.get("meta-run-declared").conversationDiscovery,
    { state: "metadata_only", runtime: "claude", reason: "run_bound_metadata_only" },
    "a record that does carry a discovery block must still publish it",
  );
  assert.deepEqual(
    published.get("meta-run-partial").conversationDiscovery,
    { state: "unsupported" },
    "a discovery block that records no reason must be published without one",
  );
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

test("global Hub health names the version of the build serving it", async (t) => {
  // The identity digest cannot be compared to anything a person or a probe knows,
  // so /api/health could not answer whether the port was served by the working
  // tree or by an installed release. A Hub rendering hours-old code stayed
  // invisible to the page, the API and the CLI alike.
  const { catalog } = hubFixture();
  const controller = createLiveControlRoomServer({
    globalHub: true,
    instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    packageIdentity: "a".repeat(64),
    packageVersion: "9.9.9-probe",
    hubCatalog: catalog,
    createProjectService: () => ({ getSnapshot: async (runId) => snapshot(runId) }),
  });
  t.after(() => controller.close());
  const address = await controller.start();
  const health = await (await fetch(`${address.url}/api/health`)).json();
  assert.equal(health.packageVersion, "9.9.9-probe");
  assert.equal(health.packageIdentity, "a".repeat(64));

  const unnamed = createLiveControlRoomServer({
    globalHub: true,
    instanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    hubCatalog: catalog,
    createProjectService: () => ({ getSnapshot: async (runId) => snapshot(runId) }),
  });
  t.after(() => unnamed.close());
  const unnamedAddress = await unnamed.start();
  const unnamedHealth = await (await fetch(`${unnamedAddress.url}/api/health`)).json();
  // A defaulted version would read as a real build and answer the very comparison
  // this field exists for, so a start path that named none reports nothing.
  assert.equal(Object.prototype.hasOwnProperty.call(unnamedHealth, "packageVersion"), true);
  assert.equal(unnamedHealth.packageVersion, null);
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

test("the public catalog keeps the reason a run has no chat link", async (t) => {
  // The public projection names every field it forwards, so a field the read
  // layer starts carrying is dropped here by default. That failure is silent:
  // the panel simply keeps showing the generic sentence.
  const { internal } = hubFixture();
  const project = {
    ...internal,
    sessions: [{
      ...internal.sessions[1],
      conversationLinkState: "unlinked",
      conversationLinkRefusal: "transcript_file_absent",
    }],
  };
  const controller = createLiveControlRoomServer({
    globalHub: true,
    instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    hubCatalog: {
      listProjects: async () => [{ ...project }],
      resolveProject: async (projectRef) => projectRef === project.projectRef ? { ...project } : null,
    },
    createProjectService: () => ({
      getSnapshot: async () => null,
      getReplay: async () => null,
      getShare: async () => ({ schemaVersion: "meta-kim-live-share-v1" }),
    }),
  });
  t.after(() => controller.close());
  const address = await controller.start();

  const response = await fetch(`${address.url}/api/projects`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.projects[0].sessions[0].conversationLinkState, "unlinked");
  assert.equal(
    body.projects[0].sessions[0].conversationLinkRefusal,
    "transcript_file_absent",
    "an explicit field list drops every field it does not name",
  );
});

test("the published session keeps a recorded start time and publishes none when the record states none", async (t) => {
  const project = {
    projectRef: "project-b1b2c3d4e5f6",
    repoRoot: "C:\private\start-time",
    displayName: "Start Time Project",
    updatedAt: "2026-08-26T09:00:00.000Z",
    status: "active",
    activeSessionId: "meta-start-1",
    sessionCount: 2,
    sessions: [
      {
        sessionId: "meta-start-1",
        runId: "meta-start-1",
        title: "Run that states when it began",
        status: "completed",
        currentStage: "verification",
        runtime: "claude",
        startedAt: "2026-08-26T07:05:00.000Z",
        updatedAt: "2026-08-26T09:00:00.000Z",
        active: false,
      },
      {
        sessionId: "meta-start-2",
        runId: "meta-start-2",
        title: "Run that states no beginning",
        status: "completed",
        currentStage: "verification",
        runtime: "claude",
        updatedAt: "2026-08-26T08:00:00.000Z",
        active: false,
      },
    ],
  };
  const controller = createLiveControlRoomServer({
    globalHub: true,
    instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    hubCatalog: {
      listProjects: async () => [{ ...project }],
      resolveProject: async (projectRef) => (projectRef === project.projectRef ? { ...project } : null),
    },
    createProjectService: () => ({
      getSnapshot: async (runId) => snapshot(runId),
      getReplay: async (runId) => ({ schemaVersion: "meta-kim-live-replay-v2", runId, replay: [] }),
      getShare: async () => ({ schemaVersion: "meta-kim-live-share-v1" }),
    }),
  });
  t.after(() => controller.close());
  const address = await controller.start();

  const published = await (await fetch(`${address.url}/api/projects`)).json();
  const sessions = new Map(published.projects[0].sessions.map((session) => [session.sessionId, session]));

  assert.equal(
    sessions.get("meta-start-1").startedAt,
    "2026-08-26T07:05:00.000Z",
    "this surface republishes the catalog; dropping the recorded start instant here loses it for good",
  );
  // The whitelist is what publishes fields, so an unrecorded start must be a
  // missing key rather than a blank string or a borrowed `updatedAt` — a reader
  // cannot tell a synthesized instant from a recorded one.
  assert.strictEqual(sessions.get("meta-start-2").startedAt, undefined);
  assert.equal(sessions.get("meta-start-2").updatedAt, "2026-08-26T08:00:00.000Z");
});

// The catalog now says whether a session's time was reported by the run or only
// read off the record file. That distinction is worthless if this surface drops
// it: the browser would show both kinds of time in one chip, identically.
test("the published session carries where its time came from", async (t) => {
  const project = {
    projectRef: "project-c1c2c3d4e5f6",
    repoRoot: "C:\private\time-basis",
    displayName: "Time Basis Project",
    updatedAt: "2026-08-26T09:00:00.000Z",
    status: "active",
    activeSessionId: "meta-basis-1",
    sessionCount: 3,
    sessions: [
      {
        sessionId: "meta-basis-1",
        runId: "meta-basis-1",
        title: "Run that reported its own time",
        status: "completed",
        currentStage: "verification",
        runtime: "claude",
        updatedAt: "2026-08-26T09:00:00.000Z",
        updatedAtBasis: "recorded",
        active: false,
      },
      {
        sessionId: "meta-basis-2",
        runId: "meta-basis-2",
        title: "Run dated only by its file",
        status: "in_doubt",
        currentStage: "in_doubt",
        runtime: "in_doubt",
        updatedAt: "2026-07-05T08:35:53.574Z",
        updatedAtBasis: "record_file_write_time",
        active: false,
      },
      {
        sessionId: "meta-basis-3",
        runId: "meta-basis-3",
        title: "Run with no time at all",
        status: "in_doubt",
        currentStage: "in_doubt",
        runtime: "in_doubt",
        updatedAt: null,
        active: false,
      },
    ],
  };
  const controller = createLiveControlRoomServer({
    globalHub: true,
    instanceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    hubCatalog: {
      listProjects: async () => [{ ...project }],
      resolveProject: async (projectRef) => (projectRef === project.projectRef ? { ...project } : null),
    },
    createProjectService: () => ({
      getSnapshot: async (runId) => snapshot(runId),
      getReplay: async (runId) => ({ schemaVersion: "meta-kim-live-replay-v2", runId, replay: [] }),
      getShare: async () => ({ schemaVersion: "meta-kim-live-share-v1" }),
    }),
  });
  t.after(() => controller.close());
  const address = await controller.start();

  const published = await (await fetch(`${address.url}/api/projects`)).json();
  const sessions = new Map(published.projects[0].sessions.map((session) => [session.sessionId, session]));

  assert.equal(
    sessions.get("meta-basis-1").updatedAtBasis,
    "recorded",
    "a run that reported its own time must reach the browser saying so",
  );
  assert.equal(
    sessions.get("meta-basis-2").updatedAtBasis,
    "record_file_write_time",
    "counted on the panel: 22 of 37 rows in this repo's project are this kind, and the browser could not tell",
  );
  assert.equal(sessions.get("meta-basis-2").updatedAt, "2026-07-05T08:35:53.574Z");
  // No time means no basis; publishing one here would invent a provenance claim
  // for a record that makes none.
  assert.strictEqual(sessions.get("meta-basis-3").updatedAtBasis, undefined);
});
