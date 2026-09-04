import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildProjectRef,
  joinProjectRegistry,
} from "../../scripts/project-registry.mjs";
import { buildLiveCompactProjection } from "../../src/application/live/live-control-room-service.mjs";
import {
  LIVE_CATALOG_SCAN_SCHEMA_VERSION,
  normalizeLiveCatalogScanPolicy,
} from "../../src/application/live/live-catalog-scan-policy.mjs";
import {
  createLiveHubProjectCatalog,
  LIVE_HUB_ACTIVE_FRESHNESS_MS,
  LIVE_HUB_DISCOVERY_OPERATIONS_PER_SESSION,
  LIVE_HUB_MAX_PROJECTS,
  LIVE_HUB_MAX_SESSIONS,
  LIVE_HUB_SOURCE_READS_PER_SESSION,
} from "../../src/infrastructure/live/live-hub-project-catalog.mjs";

async function makeProject(name = "catalog-project") {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), `meta-kim-${name}-`));
  await mkdir(path.join(projectRoot, ".git"));
  await mkdir(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions"),
    { recursive: true },
  );
  return projectRoot;
}

function registryEntry(repoRoot, overrides = {}) {
  return {
    projectRef: buildProjectRef({ repoPath: repoRoot }),
    repoRoot,
    displayName: path.basename(repoRoot),
    updatedAt: "2026-08-26T08:00:00.000Z",
    ...overrides,
  };
}

async function writeArtifact(projectRoot, runId, overrides = {}) {
  const target = path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "governed-executions",
    `${runId}.json`,
  );
  await writeFile(
    target,
    JSON.stringify({
      schemaVersion: "governed-execution-v1",
      runId,
      status: "completed",
      currentStage: "verification",
      runtimeFamily: "codex",
      updatedAt: "2026-08-26T08:15:00.000Z",
      summaryPacket: {
        visibleLines: ["Release-ready Live Hub"],
      },
      ...overrides,
    }),
    "utf8",
  );
}

async function writeCompactProjection(projectRoot, runId, overrides = {}) {
  const target = path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "governed-executions",
    `${runId}.live.json`,
  );
  await writeFile(target, JSON.stringify({
    schemaVersion: "meta-kim-live-projection-v2",
    run: {
      runId,
      title: "Committed compact run",
      status: "completed",
      currentStage: "evolution",
      updatedAt: "2026-08-26T08:30:00.000Z",
    },
    session: {
      sessionId: `session:${runId}`,
      title: "Committed compact run",
      status: "completed",
    },
    // The projection builder writes an explicit `kind` on every node and marks
    // exactly one as the main thread; the reader drops any node without one. A
    // kind-less fixture describes a record this system cannot produce.
    nodes: [
      { id: "agent:11111111111111111111", kind: "agent", isMain: true },
      { id: "agent:22222222222222222222", kind: "agent" },
    ],
    replay: [{ id: "event:11111111111111111111" }],
    ...overrides,
  }), "utf8");
}

test("lists only public project/session catalog fields and resolves the root server-side", async (t) => {
  const projectRoot = await makeProject("public");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeArtifact(projectRoot, "meta-catalog-1");

  const runDir = path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "runs",
    "meta-catalog-2",
  );
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "status.json"),
    JSON.stringify({
      runId: "meta-catalog-2",
      lifecycleStatus: "active",
      active: true,
      currentStageKey: "execution",
      runtime: "claude",
      updatedAt: "2026-08-26T08:20:00.000Z",
    }),
    "utf8",
  );

  const entry = registryEntry(projectRoot, {
    displayName: "<b>Meta Kim</b>\u0000",
  });
  const catalog = createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    now: () => Date.parse("2026-08-26T08:25:00.000Z"),
  });

  const projects = await catalog.listProjects();
  assert.equal(projects.length, 1);
  assert.deepEqual(Object.keys(projects[0]).sort(), [
    "activeSessionId",
    "displayName",
    "omittedSessionCount",
    "projectRef",
    "sessionCount",
    "sessions",
    "status",
    "updatedAt",
  ]);
  assert.equal(projects[0].displayName, "Meta Kim");
  assert.equal(projects[0].status, "active");
  assert.equal(projects[0].activeSessionId, "meta-catalog-2");
  assert.equal(projects[0].sessionCount, 2);
  assert.equal(
    projects[0].omittedSessionCount,
    0,
    "nothing is folded away silently: the count is always reported",
  );
  assert.equal(
    projects[0].sessions.every((session) => session.visibilityReason === undefined),
    true,
    "why a session is listed is a read decision, not a public session field",
  );
  assert.equal(projects[0].sessions[0].sessionId, "meta-catalog-2");
  assert.equal(projects[0].sessions[1].title, "Release-ready Live Hub");
  assert.equal(projects[0].sessions[1].nodeCount, undefined);
  assert.equal(projects[0].sessions[1].eventCount, undefined);
  assert.doesNotMatch(JSON.stringify(projects), new RegExp(projectRoot.replaceAll("\\", "\\\\"), "u"));
  assert.doesNotMatch(JSON.stringify(projects), /repoRoot|sourcePath/iu);

  const resolved = await catalog.resolveProject(entry.projectRef);
  assert.equal(resolved?.repoRoot, await import("node:fs/promises").then(({ realpath }) => realpath(projectRoot)));
  assert.deepEqual(await catalog.listSessions(entry.projectRef), projects[0].sessions);
});

async function writeActivationShell(projectRoot, runId, updatedAt) {
  const runDir = path.join(projectRoot, ".meta-kim", "state", "default", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "status.json"),
    JSON.stringify({ runId, currentStageKey: "critical", completed: [], updatedAt }),
    "utf8",
  );
}

test("the default session list folds away stale activation receipts and reports how many", async (t) => {
  const projectRoot = await makeProject("stale-shells");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  await writeArtifact(projectRoot, "meta-real-run");
  await writeActivationShell(projectRoot, "meta-shell-fresh", "2026-08-26T07:00:00.000Z");
  for (const index of [1, 2, 3]) {
    await writeActivationShell(projectRoot, `meta-shell-stale-${index}`, "2026-07-01T07:00:00.000Z");
  }

  const catalog = createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
    now: () => Date.parse("2026-08-26T08:25:00.000Z"),
  });
  const [project] = await catalog.listProjects();

  assert.deepEqual(
    project.sessions.map((session) => session.runId).sort(),
    ["meta-real-run", "meta-shell-fresh"],
    "a run that did work and a run that just started both stay listed",
  );
  assert.equal(project.omittedSessionCount, 3);
  assert.equal(project.sessionCount, 2);
  assert.equal(project.status, "idle");
});

test("omits hostile credential and punctuation-prefixed path text from the public catalog", async (t) => {
  const projectRoot = await makeProject("hostile-public-text");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-hostile-public-text";
  await writeCompactProjection(projectRoot, runId, {
    run: {
      runId,
      title: "Bearer opaqueSecret123456",
      status: "completed",
      updatedAt: "2026-08-26T08:30:00.000Z",
    },
    session: {
      title: "token abcdefghijklmnop",
      status: "completed",
    },
    summaryPacket: { nextStep: "password hunter2" },
    publicSummary: { title: "path=/home/kim/.ssh/id_rsa" },
  });

  const entry = registryEntry(projectRoot, { displayName: "Secret Sauce Studio" });
  const [project] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
  }).listProjects();

  const publicBytes = JSON.stringify(project);
  assert.doesNotMatch(publicBytes, /opaqueSecret123456|abcdefghijklmnop|hunter2|home[\\/]kim|id_rsa/u);
  assert.equal(project.displayName, "Secret Sauce Studio");
  assert.equal(project.sessions[0].title, `Run ${runId.slice(-8).toUpperCase()}`);
});

test("rejects missing, markerless, symlinked, and registry-ref-mismatched projects", async (t) => {
  const valid = await makeProject("valid");
  const markerless = await mkdtemp(path.join(os.tmpdir(), "meta-kim-markerless-"));
  const symlinkRoot = `${valid}-link`;
  t.after(async () => {
    await rm(symlinkRoot, { recursive: true, force: true });
    await rm(valid, { recursive: true, force: true });
    await rm(markerless, { recursive: true, force: true });
  });

  const rows = [
    registryEntry(path.join(os.tmpdir(), "meta-kim-does-not-exist")),
    registryEntry(markerless),
    registryEntry(valid, { projectRef: "project-000000000000" }),
  ];
  try {
    await symlink(valid, symlinkRoot, process.platform === "win32" ? "junction" : "dir");
    rows.push(registryEntry(symlinkRoot));
  } catch (error) {
    if (error?.code === "EPERM") t.diagnostic("symlink creation unavailable on this host");
    else throw error;
  }

  const catalog = createLiveHubProjectCatalog({ listJoinedProjects: async () => rows });
  assert.deepEqual(await catalog.listProjects(), []);
  assert.equal(await catalog.resolveProject("project-000000000000"), null);
});

test("reads sessions only from protected governed-execution and run directories", async (t) => {
  const projectRoot = await makeProject("boundaries");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeArtifact(projectRoot, "meta-safe-1", {
    summaryPacket: {
      visibleLines: ["C:\\Users\\Kim\\private.txt"],
      nextStep: "token=ghp_not-for-ui",
    },
  });
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", "meta-bad.json"),
    "{",
    "utf8",
  );
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", "meta-not-artifact.json"),
    JSON.stringify({ runId: "meta-not-artifact", summaryPacket: { visibleLines: ["private-ish note"] } }),
    "utf8",
  );
  await writeFile(
    path.join(projectRoot, "meta-outside-1.json"),
    JSON.stringify({ runId: "meta-outside-1", status: "active" }),
    "utf8",
  );
  const unrelatedRunDir = path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "runs",
    "not-a-run",
  );
  await mkdir(unrelatedRunDir, { recursive: true });
  await writeFile(path.join(unrelatedRunDir, "status.json"), JSON.stringify({ runId: "meta-outside-2" }), "utf8");

  const entry = registryEntry(projectRoot);
  const catalog = createLiveHubProjectCatalog({ listJoinedProjects: async () => [entry] });
  const sessions = await catalog.listSessions(entry.projectRef);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].runId, "meta-safe-1");
  assert.equal(sessions[0].title, "Run A-SAFE-1");
  assert.doesNotMatch(JSON.stringify(sessions), /Users|private|ghp_|outside|private-ish/iu);
});

test("enforces hard project/session bounds and sorts newest sessions first", async (t) => {
  assert.equal(LIVE_HUB_MAX_PROJECTS, 128);
  assert.equal(LIVE_HUB_MAX_SESSIONS, 256);
  const roots = await Promise.all([makeProject("limit-a"), makeProject("limit-b"), makeProject("limit-c")]);
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

  for (const [index, runId] of ["meta-limit-1", "meta-limit-2", "meta-limit-3"].entries()) {
    await writeArtifact(roots[0], runId, {
      updatedAt: `2026-08-26T08:0${index}:00.000Z`,
      summaryPacket: { visibleLines: [`Visible ${index + 1}`] },
    });
  }
  const rows = roots.map((root) => registryEntry(root));
  const catalog = createLiveHubProjectCatalog({
    listJoinedProjects: async () => rows,
    maxProjects: 2,
    maxSessions: 2,
  });
  const projects = await catalog.listProjects();
  assert.equal(projects.length, 2);
  assert.equal(projects[0].sessions.length, 2);
  assert.deepEqual(projects[0].sessions.map((session) => session.runId), ["meta-limit-3", "meta-limit-2"]);
});

test("sorts trusted timestamps before applying the session limit", async (t) => {
  const projectRoot = await makeProject("timestamp-limit");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeArtifact(projectRoot, "meta-z-old", {
    updatedAt: "2026-08-26T08:00:00.000Z",
  });
  await writeArtifact(projectRoot, "meta-y-middle", {
    updatedAt: "2026-08-26T09:00:00.000Z",
  });
  await writeArtifact(projectRoot, "meta-a-new", {
    updatedAt: "2026-08-26T10:00:00.000Z",
  });

  const entry = registryEntry(projectRoot);
  const sessions = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    maxSessions: 2,
  }).listSessions(entry.projectRef);
  assert.deepEqual(sessions.map((session) => session.runId), [
    "meta-a-new",
    "meta-y-middle",
  ]);
});

test("bounds compact, raw, and run-source reads while selecting the newest metadata window", async (t) => {
  assert.equal(LIVE_HUB_DISCOVERY_OPERATIONS_PER_SESSION, 24);
  assert.equal(LIVE_HUB_SOURCE_READS_PER_SESSION, 8);
  const projectRoot = await makeProject("source-read-budget");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const stateRoot = path.join(projectRoot, ".meta-kim", "state", "default");

  for (let index = 0; index < 12; index += 1) {
    const runId = `meta-budget-${String(index).padStart(2, "0")}`;
    const updatedAt = `2026-08-26T10:${String(index).padStart(2, "0")}:00.000Z`;
    let target;
    if (index % 3 === 0) {
      await writeCompactProjection(projectRoot, runId, {
        run: { runId, title: `Compact ${index}`, status: "completed", updatedAt },
      });
      target = path.join(stateRoot, "governed-executions", `${runId}.live.json`);
    } else if (index % 3 === 1) {
      await writeArtifact(projectRoot, runId, { updatedAt });
      target = path.join(stateRoot, "governed-executions", `${runId}.json`);
    } else {
      const sourceDir = path.join(stateRoot, "runs", runId);
      await mkdir(sourceDir, { recursive: true });
      target = path.join(sourceDir, "status.json");
      await writeFile(target, JSON.stringify({
        runId,
        lifecycleStatus: "completed",
        currentStage: "verification",
        updatedAt,
      }), "utf8");
    }
    const timestamp = new Date(updatedAt);
    await utimes(target, timestamp, timestamp);
  }

  const sourceReads = [];
  const entry = registryEntry(projectRoot);
  const sessions = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    maxSessions: 2,
    observeSourceRead: (source) => sourceReads.push(source),
  }).listSessions(entry.projectRef);

  // The read window is still the newest twelve runs, but what comes back from it
  // is ordered by how much there is to draw. Measured on this fixture:
  // meta-budget-09 is a compact projection carrying two nodes, while
  // meta-budget-11 and meta-budget-10 are substantive with no measured count, so
  // recency only decides between those two. Asserting pure recency here is what
  // let the control room open on a run with an empty canvas.
  assert.deepEqual(sessions.map((session) => [session.runId, session.substanceClass, session.nodeCount ?? null]), [
    ["meta-budget-09", "substantive", 2],
    ["meta-budget-11", "substantive", null],
  ]);
  assert.ok(sourceReads.length <= 2 * LIVE_HUB_SOURCE_READS_PER_SESSION);
  assert.deepEqual(
    [...new Set(sourceReads.map((source) => source.kind))].sort(),
    ["artifact", "compact", "status"],
  );
  assert.ok(sourceReads.every((source) => source.runId >= "meta-budget-08"));
});

test("caps hostile many-entry discovery and reports the bounded public window", async (t) => {
  const projectRoot = await makeProject("hostile-discovery-budget");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const executionDir = path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "governed-executions",
  );
  for (let index = 0; index < 80; index += 1) {
    const runId = `meta-hostile-${String(index).padStart(3, "0")}`;
    await writeArtifact(projectRoot, runId, {
      updatedAt: `2026-08-26T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
    });
    const timestamp = new Date(Date.UTC(2026, 7, 26, 0, index));
    await utimes(path.join(executionDir, `${runId}.json`), timestamp, timestamp);
  }

  const operations = [];
  const entry = registryEntry(projectRoot);
  const [project] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    maxSessions: 1,
    observeDiscoveryOperation: (operation) => operations.push(operation),
  }).listProjects();

  assert.equal(project.sessions.length, 1);
  assert.deepEqual(project.sessionDiscovery, {
    complete: false,
    truncated: true,
    strategy: "bounded-window",
    discoveryOperations: LIVE_HUB_DISCOVERY_OPERATIONS_PER_SESSION,
    discoveryOperationLimit: LIVE_HUB_DISCOVERY_OPERATIONS_PER_SESSION,
    sourceReads: 2,
    sourceReadLimit: LIVE_HUB_SOURCE_READS_PER_SESSION,
  });
  assert.equal(
    operations.length,
    LIVE_HUB_DISCOVERY_OPERATIONS_PER_SESSION + project.sessionDiscovery.sourceReads,
  );
  assert.ok(operations.some((operation) => operation.operation === "directory_entry"));
  assert.ok(operations.some((operation) => operation.operation === "metadata"));
  assert.equal(
    operations.filter((operation) => operation.operation === "json_read").length,
    project.sessionDiscovery.sourceReads,
  );
  assert.ok(
    operations.length <=
      LIVE_HUB_DISCOVERY_OPERATIONS_PER_SESSION + LIVE_HUB_SOURCE_READS_PER_SESSION,
  );
  assert.doesNotMatch(JSON.stringify(project.sessionDiscovery), /hostile-discovery-budget|meta-hostile|[A-Z]:[\\/]/iu);
});

test("includes a fresh root active-run status as the selectable active session", async (t) => {
  const projectRoot = await makeProject("root-active");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const stateRoot = path.join(projectRoot, ".meta-kim", "state", "default");
  await writeFile(path.join(stateRoot, "active-run.json"), JSON.stringify({
    runId: "meta-root-active-1",
    active: true,
    lifecycleStatus: "active",
    currentStage: "Execution",
    runtimeFamily: "codex",
    updatedAt: "2026-08-26T10:00:00.000Z",
  }), "utf8");

  const entry = registryEntry(projectRoot);
  const project = (await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    now: () => Date.parse("2026-08-26T10:05:00.000Z"),
  }).listProjects())[0];
  assert.equal(project.status, "active");
  assert.equal(project.activeSessionId, "meta-root-active-1");
  assert.deepEqual(project.sessions, [{
    sessionId: "meta-root-active-1",
    runId: "meta-root-active-1",
    title: "Run ACTIVE-1",
    titleSource: "generated_run_id",
    identificationState: "unlinked",
    sourceRuntime: "codex",
    conversationLinkState: "unlinked",
    verifiedLinks: [],
    candidateLinks: [],
    conversationDiscovery: {
      state: "metadata_only",
      runtime: "codex",
      reason: "run_bound_metadata_only",
    },
    recordOrigin: "governed_run",
    status: "active",
    displayState: "active",
    statusReason: "运行当前仍处于活动状态。",
    currentStage: "execution",
    runtime: "codex",
    updatedAt: "2026-08-26T10:00:00.000Z",
    updatedAtBasis: "recorded",
    substanceClass: "substantive",
    substanceSource: "derived_from_status_fields",
    substanceSignals: {
      completedStages: 0,
      workerRecords: 0,
      declaredWorkerPackets: 0,
      stageIndex: 4,
      advancedBeyondEntryStage: true,
      recordedBlocker: false,
      artifactPresent: false,
      eventCount: 0,
    },
    countsAvailability: {
      state: "unavailable",
      reason: "no_governed_artifact_for_run",
    },
    active: true,
  }]);
});

test("prefers the latest compact projection over a stale active status", async (t) => {
  assert.equal(LIVE_HUB_ACTIVE_FRESHNESS_MS, 10 * 60 * 1000);
  const projectRoot = await makeProject("compact-truth");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeCompactProjection(projectRoot, "meta-compact-2");

  const staleRunDir = path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "runs",
    "meta-stale-1",
  );
  await mkdir(staleRunDir, { recursive: true });
  await writeFile(path.join(staleRunDir, "status.json"), JSON.stringify({
    runId: "meta-stale-1",
    lifecycleStatus: "active",
    active: true,
    currentStage: "Critical",
    updatedAt: "2026-08-26T08:00:00.000Z",
  }), "utf8");

  const entry = registryEntry(projectRoot);
  const project = (await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    now: () => Date.parse("2026-08-26T08:31:00.000Z"),
  }).listProjects())[0];

  assert.equal(project.status, "idle");
  assert.equal(project.activeSessionId, null);
  assert.deepEqual(project.sessions.map((session) => session.runId), [
    "meta-compact-2",
    "meta-stale-1",
  ]);
  assert.deepEqual(project.sessions[0], {
    sessionId: "meta-compact-2",
    runId: "meta-compact-2",
    title: "Committed compact run",
    titleSource: "run_title",
    identificationState: "descriptive",
    sourceRuntime: "unavailable",
    conversationLinkState: "unlinked",
    verifiedLinks: [],
    candidateLinks: [],
    conversationDiscovery: {
      state: "unsupported",
      reason: "no_safe_runtime_metadata_source",
    },
    recordOrigin: "governed_run",
    status: "in_doubt",
    displayState: "unknown",
    statusReason: "现有记录不足以判断该任务是否执行或完成。",
    currentStage: "evolution",
    runtime: "in_doubt",
    updatedAt: "2026-08-26T08:30:00.000Z",
    updatedAtBasis: "recorded",
    substanceClass: "substantive",
    substanceSource: "derived_from_status_fields",
    substanceSignals: {
      completedStages: 0,
      workerRecords: 0,
      declaredWorkerPackets: 0,
      stageIndex: 8,
      advancedBeyondEntryStage: true,
      recordedBlocker: false,
      artifactPresent: true,
      eventCount: 1,
    },
    countsAvailability: {
      state: "measured",
      reason: "governed_artifact_collections",
    },
    workerCount: 1,
    nodeCount: 2,
    eventCount: 1,
    active: false,
  });
  assert.equal(project.sessions[1].status, "in_doubt");
  assert.equal(project.sessions[1].active, false);
  assert.equal(project.sessions[1].substanceClass, "activation_only");
  assert.deepEqual(project.sessions[1].countsAvailability, {
    state: "unavailable",
    reason: "no_governed_artifact_for_run",
  });
  assert.equal(project.sessions[1].nodeCount, undefined);
  assert.equal(project.sessions[1].eventCount, undefined);
});

// A projection built from an acceptance fixture lands in the same directory as a
// real run and is byte-shaped the same way, so the catalog cannot recover the
// difference by inspection. Measured on this repo before the fix: the only two of
// 44 rows carrying worker counts and a resolved runtime were both fixtures, and
// they sorted to the top of the list as the healthiest runs in the project.
test("surfaces declared record origin so a fixture cannot pass as a real run", async (t) => {
  const projectRoot = await makeProject("record-origin");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  await writeCompactProjection(projectRoot, "meta-origin-fixture", {
    run: {
      runId: "meta-origin-fixture",
      title: "Acceptance fixture run",
      status: "completed",
      currentStage: "verification",
      recordOrigin: "acceptance_fixture",
      updatedAt: "2026-08-26T09:10:00.000Z",
    },
  });
  await writeArtifact(projectRoot, "meta-origin-real", {
    updatedAt: "2026-08-26T09:09:00.000Z",
  });
  await writeArtifact(projectRoot, "meta-origin-spoof", {
    recordOrigin: "definitely-real",
    updatedAt: "2026-08-26T09:08:00.000Z",
  });

  const entry = registryEntry(projectRoot);
  const project = (await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    now: () => Date.parse("2026-08-26T09:20:00.000Z"),
  }).listProjects())[0];

  const originByRun = new Map(
    project.sessions.map((session) => [session.runId, session.recordOrigin]),
  );
  assert.equal(originByRun.get("meta-origin-fixture"), "acceptance_fixture");
  assert.equal(
    originByRun.get("meta-origin-real"),
    "governed_run",
    "a record that declares no origin is a governed run, so real history needs no migration",
  );
  assert.equal(
    originByRun.get("meta-origin-spoof"),
    "governed_run",
    "an unrecognized origin must collapse to the neutral default rather than reach a reader as a self-declared label",
  );
});

test("fails closed on oversized, malformed, and run-mismatched compact projections", async (t) => {
  const projectRoot = await makeProject("compact-boundaries");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const executionDir = path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "governed-executions",
  );
  await writeCompactProjection(projectRoot, "meta-good-1", {
    run: {
      runId: "meta-good-1",
      title: "Safe compact title",
      status: "completed",
      currentStage: "verification",
      updatedAt: "2026-08-26T09:00:00.000Z",
    },
  });
  await writeFile(path.join(executionDir, "meta-malformed-1.live.json"), "{", "utf8");
  await writeCompactProjection(projectRoot, "meta-mismatch-1", {
    run: { runId: "meta-other-1", title: "Must not appear", status: "completed" },
  });
  await writeFile(
    path.join(executionDir, "meta-oversized-1.live.json"),
    JSON.stringify({
      schemaVersion: "meta-kim-live-projection-v2",
      run: { runId: "meta-oversized-1", title: "Must not appear" },
      nodes: [],
      replay: [],
      padding: "x".repeat(256 * 1024),
    }),
    "utf8",
  );
  await writeFile(
    path.join(executionDir, "meta-oversized-raw-1.json"),
    JSON.stringify({
      schemaVersion: "governed-execution-v1",
      runId: "meta-oversized-raw-1",
      status: "completed",
      summaryPacket: { title: "Oversized raw must not appear" },
      padding: "x".repeat(2048),
    }),
    "utf8",
  );

  const entry = registryEntry(projectRoot);
  const sessions = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    now: () => Date.parse("2026-08-26T09:01:00.000Z"),
    maxJsonBytes: 1024,
  }).listSessions(entry.projectRef);
  // Failing closed is about content, not about rows. A file that is malformed or
  // names another run says nothing about this run, so it contributes nothing. A
  // file refused for its size is different: its existence was observed, and
  // dropping the row makes a run that produced megabytes of output identical to
  // one that never ran. It appears, and it publishes none of the bytes nobody read.
  // Sorted, because two rows whose only time is a file mtime written in the same
  // millisecond have no meaningful order between them; membership is the claim.
  assert.deepEqual(sessions.map((session) => session.runId).sort(), [
    "meta-good-1",
    "meta-oversized-1",
    "meta-oversized-raw-1",
  ]);
  assert.doesNotMatch(JSON.stringify(sessions), /Must not appear|Oversized raw|padding/iu);
  for (const runId of ["meta-oversized-1", "meta-oversized-raw-1"]) {
    const refused = sessions.find((session) => session.runId === runId);
    assert.deepEqual(refused.countsAvailability, {
      state: "unavailable",
      reason: "governed_artifact_over_read_cap",
    }, `${runId} must say the read was refused rather than imply it produced nothing`);
    assert.equal(refused.workerCount, undefined);
    assert.equal(refused.nodeCount, undefined);
    assert.equal(refused.eventCount, undefined);
  }
});

test("default catalog remains read-only when the global registry does not exist", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-catalog-home-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  const catalog = createLiveHubProjectCatalog({ homeDir });
  assert.deepEqual(await catalog.listProjects(), []);
  await assert.rejects(lstat(path.join(homeDir, ".meta-kim")), { code: "ENOENT" });
});

test("default catalog reads an existing joined registry without exposing its root", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-catalog-home-"));
  const projectRoot = await makeProject("registered");
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  await joinProjectRegistry({ homeDir, repoPath: projectRoot, runtimeFamily: "codex" });
  const projects = await createLiveHubProjectCatalog({ homeDir }).listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].projectRef, buildProjectRef({ repoPath: projectRoot }));
  assert.doesNotMatch(JSON.stringify(projects), /repoRoot/iu);
});

test("fails closed on registry errors and normalizes alternate governed fields", async (t) => {
  assert.deepEqual(
    await createLiveHubProjectCatalog({ listJoinedProjects: async () => null }).listProjects(),
    [],
  );
  assert.deepEqual(
    await createLiveHubProjectCatalog({ listJoinedProjects: async () => { throw new Error("registry down"); } }).listProjects(),
    [],
  );
  assert.deepEqual(
    await createLiveHubProjectCatalog({ listJoinedProjects: async () => [] }).listSessions("not-a-project"),
    [],
  );

  const projectRoot = await makeProject("alternate");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const target = path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "governed-executions",
    "meta-alternate-1.json",
  );
  await writeFile(target, JSON.stringify({
    schemaVersion: "governed-execution-v1",
    run: { runId: "meta-alternate-1" },
    status: "running",
    stage: "meta_review",
    runtime: "unsafe runtime value",
    completedAt: "2026-08-26T09:00:00.000Z",
    publicSummary: { title: "Alternate public title" },
    sourceConversation: { threadId: "01a04c60-33fe-79f3-a38a-d52fcae64d4d" },
  }), "utf8");
  const entry = registryEntry(projectRoot, { updatedAt: "not-a-date" });
  const projects = await createLiveHubProjectCatalog({
    profile: "../unsafe",
    listJoinedProjects: async () => [entry],
    now: () => Date.parse("2026-08-26T09:05:00.000Z"),
  }).listProjects();
  assert.equal(projects[0].updatedAt, "2026-08-26T09:00:00.000Z");
  assert.equal(projects[0].sessions[0].title, "Alternate public title");
  assert.equal(projects[0].sessions[0].titleSource, "public_summary_title");
  assert.equal(projects[0].sessions[0].identificationState, "conversation_verified");
  assert.equal(projects[0].sessions[0].conversationRef, "01a04c60-33fe-79f3-a38a-d52fcae64d4d");
  assert.equal(projects[0].sessions[0].status, "active");
  assert.equal(projects[0].sessions[0].currentStage, "meta-review");
  assert.equal(projects[0].sessions[0].runtime, "in_doubt");
});

test("normalizes explicit conversation identity for Claude Code, Codex, Cursor, and OpenClaw", async (t) => {
  const projectRoot = await makeProject("runtime-conversations");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const executionRoot = path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions");
  const fixtures = [
    ["claude", "sessionId", "claude-session-20260830", "Claude planning chat"],
    ["codex", "threadId", "01a04c60-33fe-79f3-a38a-d52fcae64d4d", "Codex implementation chat"],
    ["cursor", "composerId", "cursor-composer-20260830", "Cursor review chat"],
    ["openclaw", "sessionKey", "openclaw-session-20260830", "OpenClaw verification chat"],
  ];
  for (const [index, [runtime, refField, ref, title]] of fixtures.entries()) {
    const runId = `meta-runtime-${runtime}-1`;
    await writeFile(path.join(executionRoot, `${runId}.json`), JSON.stringify({
      schemaVersion: "governed-execution-v1",
      run: { runId },
      status: "completed",
      stage: "verification",
      completedAt: `2026-08-26T09:0${index}:00.000Z`,
      sourceConversation: { runtime, [refField]: ref, title },
    }), "utf8");
  }

  const project = (await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
    now: () => Date.parse("2026-08-26T10:00:00.000Z"),
  }).listProjects())[0];
  const byRuntime = new Map(project.sessions.map((session) => [session.sourceRuntime, session]));
  for (const [runtime, , ref, title] of fixtures) {
    const session = byRuntime.get(runtime);
    assert.ok(session, `${runtime} conversation must remain visible`);
    assert.equal(session.conversationRef, ref);
    assert.equal(session.conversationTitle, title);
    assert.equal(session.title, title);
    assert.equal(session.titleSource, "conversation_title");
    assert.equal(session.conversationLinkState, "verified");
    assert.equal(session.identificationState, "conversation_verified");
  }
});

test("uses conversation identity from a durable status record when no governed artifact exists", async (t) => {
  const projectRoot = await makeProject("status-conversation");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-status-conversation-1";
  const runRoot = path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "runs",
    runId,
  );
  await mkdir(runRoot, { recursive: true });
  await writeFile(path.join(runRoot, "status.json"), JSON.stringify({
    schemaVersion: 2,
    runId,
    currentStage: "execution",
    active: true,
    updatedAt: "2026-08-26T09:30:00.000Z",
    sourceConversation: {
      runtime: "codex",
      conversationId: "01a04c60-33fe-79f3-a38a-d52fcae64d4d",
      title: "Repair the Live run selector",
    },
  }), "utf8");

  const project = (await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
    now: () => Date.parse("2026-08-26T09:31:00.000Z"),
  }).listProjects())[0];
  const session = project.sessions.find((candidate) => candidate.runId === runId);

  assert.ok(session);
  assert.equal(session.title, "Repair the Live run selector");
  assert.equal(session.titleSource, "conversation_title");
  assert.equal(session.conversationRef, "01a04c60-33fe-79f3-a38a-d52fcae64d4d");
  assert.equal(session.conversationLinkState, "verified");
  assert.equal(session.identificationState, "conversation_verified");
  assert.equal(session.sourceRuntime, "codex");
});

test("discovers verified and candidate conversations across all supported runtimes without promoting candidates", async (t) => {
  const projectRoot = await makeProject("discovered-runtime-conversations");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-discovered-runtime-1";
  const executionRoot = path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions");
  await writeFile(path.join(executionRoot, `${runId}.json`), JSON.stringify({
    schemaVersion: "governed-execution-v1",
    runId,
    status: "completed",
    updatedAt: "2026-08-30T09:00:00.000Z",
    workerTaskPackets: [{ taskPacketId: "discovery-task-1", status: "completed" }],
    workerResultPackets: [{ taskPacketId: "discovery-task-1", status: "completed" }],
  }), "utf8");

  const sessions = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
    now: () => Date.parse("2026-08-30T09:01:00.000Z"),
    discoverRuntimeConversations: async () => [
      { runId, runtime: "codex", threadId: "codex-thread-20260830", verified: true },
      { runId, runtime: "claude", sessionId: "claude-session-20260830", matchBasis: "title_time_project_similarity" },
      { runId, runtime: "cursor", composerId: "cursor-composer-20260830", matchBasis: "title_time_project_similarity" },
      { runId, runtime: "openclaw", sessionKey: "openclaw-session-20260830", matchBasis: "title_time_project_similarity" },
    ],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].conversationLinkState, "verified");
  assert.deepEqual(sessions[0].verifiedLinks.map((link) => link.sourceRuntime), ["codex"]);
  assert.deepEqual(sessions[0].candidateLinks.map((link) => link.sourceRuntime).sort(), ["claude", "cursor", "openclaw"]);
  assert.equal(sessions[0].status, "in_doubt");
  assert.notEqual(sessions[0].displayState, "completed");
  assert.doesNotMatch(JSON.stringify(sessions), /[A-Z]:[\\/]|repoRoot|projectRoot/iu);
});

test("inactive structural-only artifacts are unreported instead of queued", async (t) => {
  const projectRoot = await makeProject("structural-only-display");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-structural-only-1";
  const executionRoot = path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions");
  await writeFile(path.join(executionRoot, `${runId}.json`), JSON.stringify({
    schemaVersion: "governed-execution-v1",
    runId,
    status: "pending",
    updatedAt: "2026-08-30T09:00:00.000Z",
    executionResult: { actualWorkerExecution: false, executionClosure: "planned_not_executed_by_runner" },
    workerResultPackets: [{
      taskPacketId: "structural-task-1",
      status: "planned_not_executed",
      workerExecutionEvidence: [{
        observedResult: "not_run_by_structural_artifact_builder",
        evidenceKind: "structural_worker_plan",
      }],
    }],
  }), "utf8");
  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
    now: () => Date.parse("2026-08-30T09:01:00.000Z"),
  }).listSessions(registryEntry(projectRoot).projectRef);
  assert.equal(session.active, false);
  assert.equal(session.displayState, "unreported");
  assert.match(session.statusReason, /结构规划记录/u);
});

// Nineteen of the forty-four records this profile lists are governed artifacts
// that carry no `title`, no `updatedAt`, and no `currentStage` — the whole row
// read as "来源未知 / 时间未知". They do carry the user's own request sentence and
// they do have a write time, so the row was unreadable because the catalog never
// looked, not because the run kept no record of itself.
test("an artifact with no title falls back to the request task instead of a generated run id", async (t) => {
  const projectRoot = await makeProject("artifact-request-task-title");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-run-0c547140dfc6";
  const target = path.join(
    projectRoot, ".meta-kim", "state", "default", "governed-executions", `${runId}.json`,
  );
  await writeFile(target, JSON.stringify({
    schemaVersion: "governed-execution-v1",
    runId,
    status: "partial",
    task: "修正课程案例结构：远端素材按分组文件夹呈现，并做远端核验。",
    coreLoop: { requestRecord: { runId, entry: "meta:theory:run" } },
  }), "utf8");
  const writtenAt = Date.parse("2026-06-22T15:42:56.000Z");
  await utimes(target, new Date(writtenAt), new Date(writtenAt));

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
    now: () => Date.parse("2026-08-31T09:00:00.000Z"),
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.title, "修正课程案例结构：远端素材按分组文件夹呈现，并做远端核验。");
  assert.equal(session.titleSource, "request_task");
  assert.equal(
    session.updatedAt,
    new Date(writtenAt).toISOString(),
    "a record that claims no timestamp is still dated by its own write time",
  );
});

test("a request task naming a local path stays redacted rather than becoming the title", async (t) => {
  const projectRoot = await makeProject("artifact-request-task-redaction");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-run-386f54908539";
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", `${runId}.json`),
    JSON.stringify({
      schemaVersion: "governed-execution-v1",
      runId,
      status: "partial",
      task: "评估设计 spec，spec 已落到 D:/KimProject/MetaKim/docs 下",
    }),
    "utf8",
  );

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.titleSource, "generated_run_id");
  assert.doesNotMatch(JSON.stringify(session), /[A-Z]:[\\/]/u);
});

// Sixteen of the forty-four rows in one profile read "阶段未确认", and every one of
// them held the `in_doubt` sentinel rather than nothing: the artifacts state no
// top-level stage but do stamp each spine packet with the stage that wrote it, so
// the run's own reach was recorded and simply never read.
test("a stage recorded only on the spine packets is read instead of collapsing to a sentinel", async (t) => {
  const projectRoot = await makeProject("artifact-packet-stage");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-run-packet-stage-1";
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", `${runId}.json`),
    JSON.stringify({
      schemaVersion: "governed-execution-v1",
      runId,
      status: "partial",
      task: "Close the live control room display honesty gap.",
      intentPacket: { stage: "Critical" },
      fetchPacket: { stage: "Fetch" },
      thinkingPacket: { stage: "Thinking" },
      executionResult: { stage: "Execution", actualWorkerExecution: true, executionClosure: "run_scoped_worker_executed" },
      reviewPacket: { stage: "Review", status: "partial" },
      metaReviewPacket: { stage: "Meta-Review", status: "fail" },
      verificationResult: { stage: "Verification", status: "pass" },
      evolutionWritebackDecision: { stage: "Evolution", status: "none-with-reason" },
    }),
    "utf8",
  );

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.currentStage, "evolution", "the deepest stage the run actually reached is the stage it reached");
});

// A run that stopped at Fetch must not read as one that reached Evolution, so the
// packet fallback has to follow the packets present rather than assume the set.
test("the packet stage fallback reports the deepest packet present, not the last stage defined", async (t) => {
  const projectRoot = await makeProject("artifact-packet-stage-partial-set");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-run-packet-stage-2";
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", `${runId}.json`),
    JSON.stringify({
      schemaVersion: "governed-execution-v1",
      runId,
      status: "partial",
      task: "Stop after gathering evidence.",
      coreLoop: {
        intentPacket: { stage: "Critical" },
        fetchPacket: { stage: "Fetch" },
      },
    }),
    "utf8",
  );

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.currentStage, "fetch");
});

// A record that declares its own stage keeps it. The fallback exists for records
// that state none, and must never overrule a stage the run reported directly.
test("a declared stage outranks the packet fallback", async (t) => {
  const projectRoot = await makeProject("artifact-declared-stage-wins");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-run-packet-stage-3";
  await writeArtifact(projectRoot, runId, {
    currentStage: "review",
    evolutionWritebackDecision: { stage: "Evolution" },
  });

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.currentStage, "review");
});

// Forty-two of forty-four rows read "来源未知" while fifteen of the artifacts named
// the runtime that produced them under `requestRecord.runtimeContext`. Runtime
// names scattered elsewhere in an artifact are capability lists, not attribution:
// nineteen files name all four runtimes at once, so only this declaration counts.
test("the producing runtime declared in the request record is read as the run source", async (t) => {
  const projectRoot = await makeProject("artifact-runtime-context");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-run-runtime-context-1";
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", `${runId}.json`),
    JSON.stringify({
      schemaVersion: "governed-execution-v1",
      runId,
      status: "partial",
      task: "Bind the run to the runtime that produced it.",
      requestRecord: { runtimeContext: { runtimeFamily: "claude_code", os: "windows" } },
    }),
    "utf8",
  );

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.sourceRuntime, "claude");
  assert.deepEqual(session.conversationDiscovery, {
    state: "metadata_only",
    runtime: "claude",
    reason: "run_bound_metadata_only",
  });
  assert.equal(session.conversationLinkState, "unlinked", "knowing the runtime is not knowing the chat");
});

test("a runtime context mirrored under coreLoop is read the same way", async (t) => {
  const projectRoot = await makeProject("artifact-runtime-context-mirror");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-run-runtime-context-2";
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", `${runId}.json`),
    JSON.stringify({
      schemaVersion: "governed-execution-v1",
      runId,
      status: "partial",
      task: "Mirror the runtime context under the core loop.",
      coreLoop: { requestRecord: { runtimeContext: { runtimeFamily: "codex" } } },
    }),
    "utf8",
  );

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.sourceRuntime, "codex");
});

// Nineteen artifacts state `status: "partial"` and every one of them also states
// verification passed and public-readiness was refused. Dropping `partial` out of
// the accepted vocabulary flattened all of that into `in_doubt`, which reads as
// "nothing is known" about a run whose own record is specific.
test("a partial run keeps its status instead of flattening into the doubt sentinel", async (t) => {
  const projectRoot = await makeProject("artifact-partial-status");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-run-partial-status-1";
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", `${runId}.json`),
    JSON.stringify({
      schemaVersion: "governed-execution-v1",
      runId,
      status: "partial",
      task: "Execute and verify, but stop short of release.",
      executionResult: { stage: "Execution", actualWorkerExecution: true, executionClosure: "run_scoped_worker_executed" },
      verificationResult: { stage: "Verification", status: "pass" },
      publicReadyDecision: { publicReady: false, verificationEvidencePresent: true },
    }),
    "utf8",
  );

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.status, "partial");
  assert.equal(session.displayState, "partial");
  assert.match(session.statusReason, /执行和验证都有记录/u);
});

// Three runs were replaced by a newer prompt and two were reconciled as legacy.
// Both are ordinary archival outcomes the record names outright, so neither has
// any business reading as an unjudgeable run.
test("a superseded run reports that it was replaced rather than that its state is unknown", async (t) => {
  const projectRoot = await makeProject("artifact-superseded-status");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-run-superseded-1";
  const runDir = path.join(projectRoot, ".meta-kim", "state", "default", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "status.json"),
    JSON.stringify({
      schemaVersion: 2,
      runId,
      active: false,
      lifecycleStatus: "superseded",
      currentStage: "Critical",
      currentStageKey: "critical",
      deactivationReason: "superseded_by_new_prompt",
      supersededByRunId: "meta-run-superseded-2",
      updatedAt: "2026-08-30T08:00:00.000Z",
    }),
    "utf8",
  );

  // Pinned because the fixture timestamp is absolute and the default session list
  // folds activation-only rows past `activationOnlyRetentionDays`. Left on the wall
  // clock this test passed for three days and then went red on its own, with the
  // row correctly folded away and `[session]` destructuring to undefined — a
  // calendar failure wearing the shape of a regression.
  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
    now: () => Date.parse("2026-08-30T08:30:00.000Z"),
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.status, "superseded");
  assert.equal(session.displayState, "superseded");
  assert.match(session.statusReason, /新的任务替代/u);
});

test("legacy compact worker structural evidence is inferred without a run execution state", async (t) => {
  const projectRoot = await makeProject("legacy-compact-structural-inference");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-legacy-compact-structural-1";
  await writeCompactProjection(projectRoot, runId, {
    run: { runId, status: "completed", updatedAt: "2026-08-30T09:00:00.000Z" },
    nodes: [{
      id: "agent:legacy-worker",
      kind: "agent",
      isMain: false,
      status: "completed",
      workerExecutionEvidence: [{
        observedResult: "not_run_by_structural_artifact_builder",
        evidenceKind: "structural_worker_plan",
      }],
    }],
  });
  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);
  assert.equal(session.status, "in_doubt");
  assert.equal(session.displayState, "unreported");
});

test("a refused chat binding keeps the reason the hook recorded", async (t) => {
  const projectRoot = await makeProject("conversation-refusal");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-conversation-refusal-1";
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", `${runId}.json`),
    JSON.stringify({
      schemaVersion: "governed-execution-v1",
      run: { runId },
      status: "completed",
      stage: "verification",
      completedAt: "2026-09-02T09:00:00.000Z",
      task: "Record why the chat binding was refused.",
      conversationLinkRefusal: "transcript_file_absent",
    }),
    "utf8",
  );

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.conversationLinkState, "unlinked");
  assert.equal(
    session.conversationLinkRefusal,
    "transcript_file_absent",
    "the panel cannot explain an unlinked run if the read layer drops the reason",
  );
});

test("a reason no build understands is dropped rather than shown raw", async (t) => {
  const projectRoot = await makeProject("conversation-refusal-unknown");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-conversation-refusal-2";
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", `${runId}.json`),
    JSON.stringify({
      schemaVersion: "governed-execution-v1",
      run: { runId },
      status: "completed",
      stage: "verification",
      completedAt: "2026-09-02T09:01:00.000Z",
      task: "Carry a reason from a newer build.",
      conversationLinkRefusal: "a_reason_from_a_newer_build",
    }),
    "utf8",
  );

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.conversationLinkState, "unlinked");
  assert.equal(session.conversationLinkRefusal, undefined);
});

test("a verified link never carries a stale refusal beside it", async (t) => {
  const projectRoot = await makeProject("conversation-refusal-verified");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-conversation-refusal-3";
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", `${runId}.json`),
    JSON.stringify({
      schemaVersion: "governed-execution-v1",
      run: { runId },
      status: "completed",
      stage: "verification",
      completedAt: "2026-09-02T09:02:00.000Z",
      task: "Bind the chat and leave an older refusal behind.",
      sourceConversation: { runtime: "claude", sessionId: "claude-session-20260902" },
      conversationLinkRefusal: "transcript_file_absent",
    }),
    "utf8",
  );

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.conversationLinkState, "verified");
  assert.equal(
    session.conversationLinkRefusal,
    undefined,
    "one run must not report a verified link and a missing transcript at once",
  );
});

// The producer is the activation hook, and it writes the refusal into
// `active-run.json`, which lands here as a `status` record — never as the
// governed artifact. Identity is read off the artifact, so a run with both files
// silently loses the reason unless it is merged across records the way
// `sourceConversation` already is. A fixture that puts the reason on the artifact
// passes without that merge and proves nothing about the real shape.
test("the reason survives on the record the hook actually writes it to", async (t) => {
  const projectRoot = await makeProject("conversation-refusal-status");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const stateRoot = path.join(projectRoot, ".meta-kim", "state", "default");
  const runId = "meta-conversation-refusal-4";
  await writeFile(
    path.join(stateRoot, "active-run.json"),
    JSON.stringify({
      runId,
      active: false,
      lifecycleStatus: "completed",
      currentStage: "Verification",
      runtimeFamily: "claude",
      updatedAt: "2026-09-02T09:03:00.000Z",
      conversationLinkRefusal: "transcript_file_absent",
    }),
    "utf8",
  );
  // Newer than the status record, so it wins both the artifact lookup and the
  // newest-record lookup. Only an explicit cross-record merge can carry the
  // reason through.
  await writeFile(
    path.join(stateRoot, "governed-executions", `${runId}.json`),
    JSON.stringify({
      schemaVersion: "governed-execution-v1",
      run: { runId },
      status: "completed",
      stage: "verification",
      completedAt: "2026-09-02T09:04:00.000Z",
      task: "Leave the reason on the status record only.",
    }),
    "utf8",
  );

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.runId, runId);
  assert.equal(session.conversationLinkState, "unlinked");
  assert.equal(
    session.conversationLinkRefusal,
    "transcript_file_absent",
    "the hook writes the reason to active-run.json, so reading only the artifact drops every real reason",
  );
});

/**
 * Writes the compact projection this system really produces, then deletes the raw
 * artifact it came from.
 *
 * That is not a contrived setup: the raw read is capped at
 * `LIVE_MAX_JSON_BYTES`, and 3 of the 25 archived artifacts in this profile are
 * already over it (11.8 MB, 10.3 MB, 9.3 MB against an 8 MiB cap) while the
 * freshest one sits 10 KB under. For every run past the cap the compact file is
 * the only record the catalog can read, and it nests every conversation field
 * under `run.*` while the artifact carries them at the top level.
 *
 * The fixture comes from `buildLiveCompactProjection` rather than a hand-written
 * object so it cannot drift into whatever shape the reader happens to expect —
 * the field names differ between the two kinds (`verifiedLinks` against
 * `conversationLinks`), and guessing them is how the divergence stayed invisible.
 */
async function writeProducedCompactProjection(projectRoot, artifact) {
  const compact = buildLiveCompactProjection(artifact);
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", `${artifact.runId}.live.json`),
    JSON.stringify(compact),
    "utf8",
  );
  return compact;
}

test("a run readable only through its compact projection keeps its proven chat link", async (t) => {
  const projectRoot = await makeProject("compact-only-verified-link");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-compact-only-link-1";
  const compact = await writeProducedCompactProjection(projectRoot, {
    schemaVersion: "governed-execution-v1",
    runId,
    status: "completed",
    currentStage: "verification",
    task: "Prove a chat link survives when only the compact record is readable.",
    updatedAt: "2026-09-02T10:00:00.000Z",
    sourceRuntime: "claude",
    conversationLinkState: "verified",
    sourceConversation: {
      runId,
      sessionId: "claude-session-20260902a",
      runtime: "claude",
      matchBasis: "host_transcript_path",
    },
  });
  assert.equal(compact.run.conversationLinkState, "verified", "the producer no longer records a proven link here");

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.runId, runId);
  assert.equal(
    session.conversationLinkState,
    "verified",
    "a run past the raw read cap reported 未关联 for a link its own record proved",
  );
  assert.equal(session.conversationRef, "claude-session-20260902a");
  assert.equal(session.sourceRuntime, "claude");
});

test("a run readable only through its compact projection keeps the refusal reason", async (t) => {
  const projectRoot = await makeProject("compact-only-refusal");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-compact-only-link-2";
  const compact = await writeProducedCompactProjection(projectRoot, {
    schemaVersion: "governed-execution-v1",
    runId,
    status: "completed",
    currentStage: "verification",
    task: "Prove the refusal reason survives when only the compact record is readable.",
    updatedAt: "2026-09-02T10:01:00.000Z",
    sourceRuntime: "claude",
    conversationLinkState: "unlinked",
    conversationLinkRefusal: "conversation_id_not_identified",
  });
  assert.equal(compact.run.conversationLinkRefusal, "conversation_id_not_identified");

  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [registryEntry(projectRoot)],
  }).listSessions(registryEntry(projectRoot).projectRef);

  assert.equal(session.conversationLinkState, "unlinked");
  // Losing the reason does not blank the row, it downgrades it: the page falls
  // back to the coarser discovery sentence, so a reader is told the chat history
  // was not searched instead of being told no chat id ever arrived. Both read as
  // 未关联 and only one of them is the truth about this run.
  assert.equal(
    session.conversationLinkRefusal,
    "conversation_id_not_identified",
    "a run past the raw read cap lost the only sentence that says why it is unlinked",
  );
});

// `updatedAt` on a session is a folded value: the reader falls through update,
// completion, deactivation, start, and finally the record file's own write time,
// so two runs showing the same timestamp can mean entirely different instants.
// A reader deciding "is this row old data or is the product broken right now"
// needs the one instant that is actually recorded as a start, or nothing.
test("a session reports the start time its own record states, separate from the folded update time", async (t) => {
  const projectRoot = await makeProject("session-start-recorded");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-start-recorded-1";
  await writeArtifact(projectRoot, runId, {
    startedAt: "2026-08-26T07:05:00.000Z",
    updatedAt: "2026-08-26T08:40:00.000Z",
  });

  const entry = registryEntry(projectRoot);
  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
  }).listSessions(entry.projectRef);

  assert.equal(session.runId, runId);
  assert.equal(
    session.startedAt,
    "2026-08-26T07:05:00.000Z",
    "the recorded start instant must be reported as itself, not re-derived through the folded chain",
  );
  assert.equal(session.updatedAt, "2026-08-26T08:40:00.000Z");
});

test("a session records its start time from the nested run block too", async (t) => {
  const projectRoot = await makeProject("session-start-nested");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-start-nested-1";
  await writeArtifact(projectRoot, runId, {
    updatedAt: "2026-08-26T08:40:00.000Z",
    run: { runId, startedAt: "2026-08-26T06:30:00.000Z" },
  });

  const entry = registryEntry(projectRoot);
  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
  }).listSessions(entry.projectRef);

  assert.equal(session.startedAt, "2026-08-26T06:30:00.000Z");
});

test("a session with no recorded start time says nothing rather than dating itself by its file", async (t) => {
  const projectRoot = await makeProject("session-start-absent");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runId = "meta-start-absent-1";
  await writeArtifact(projectRoot, runId, {
    updatedAt: "2026-08-26T08:40:00.000Z",
    completedAt: "2026-08-26T08:41:00.000Z",
    deactivatedAt: "2026-08-26T08:42:00.000Z",
  });

  const entry = registryEntry(projectRoot);
  const [session] = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
  }).listSessions(entry.projectRef);

  // Measured on the real profile: 21 of 95 sessions state no start instant
  // anywhere in their durable record. Filling those in from a neighbouring
  // field or from the file's own write time would put a synthesized instant
  // into a provenance column, indistinguishable from a recorded one.
  assert.strictEqual(
    session.startedAt,
    undefined,
    "an unrecorded start instant must stay absent, not borrow the update, completion, or file time",
  );
  assert.equal(
    session.updatedAt,
    "2026-08-26T08:40:00.000Z",
    "the folded update time is still reported; only the start claim is withheld",
  );
});

// Counted on the panel, not on the artifact directory: 22 of the 37 rows this
// repo's own project publishes show the record file's own write time in the same
// chip, same format, as a run that actually reported a time. Six of those 22 are
// same-day records, so they do not even read as old; rewrite one of those files
// and the row claims the run was touched just now.
test("a session says whether its time came from the record or only from the record file", async (t) => {
  const projectRoot = await makeProject("time-basis");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeArtifact(projectRoot, "meta-basis-recorded", { updatedAt: "2026-08-26T08:15:00.000Z" });
  await writeArtifact(projectRoot, "meta-basis-silent", {
    updatedAt: undefined,
    completedAt: undefined,
    startedAt: undefined,
    createdAt: undefined,
    triggeredAt: undefined,
  });

  const entry = registryEntry(projectRoot);
  const sessions = new Map(
    (await createLiveHubProjectCatalog({ listJoinedProjects: async () => [entry] })
      .listSessions(entry.projectRef)).map((session) => [session.runId, session]),
  );

  assert.equal(sessions.get("meta-basis-recorded").updatedAt, "2026-08-26T08:15:00.000Z");
  assert.equal(
    sessions.get("meta-basis-recorded").updatedAtBasis,
    "recorded",
    "a record that states its own time must be published as stating it",
  );

  const silent = sessions.get("meta-basis-silent");
  // `mtimeMs` carries a sub-millisecond fraction that the Date accessor rounds and
  // the catalog truncates, so the two conversions can differ by 1ms. Compare the
  // truncated form the catalog itself publishes; the load-bearing assertion below
  // is the hardcoded basis string, not this supporting fact.
  const writeTime = new Date(
    Math.trunc((await lstat(path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", "meta-basis-silent.json"))).mtimeMs),
  ).toISOString();
  assert.equal(silent.updatedAt, writeTime, "the fallback is still the file write time; that part is unchanged");
  assert.equal(
    silent.updatedAtBasis,
    "record_file_write_time",
    "a time nobody recorded must not be published as indistinguishable from one that was",
  );
});

const OVER_CAP_JSON_BYTES = 512;

/**
 * The byte cap is a memory guard, so the fixture makes a file exceed it instead of
 * raising it. Padding a real artifact keeps the file a governed artifact in every
 * respect except its size, which is the one property under test.
 */
async function writeOverCapArtifact(projectRoot, runId) {
  await writeArtifact(projectRoot, runId, {
    summaryPacket: { visibleLines: ["Release-ready Live Hub", "padding ".repeat(96)] },
  });
  const target = path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "governed-executions",
    `${runId}.json`,
  );
  const { size } = await lstat(target);
  assert.ok(
    size > OVER_CAP_JSON_BYTES,
    `the fixture must exceed the cap the catalog is given, got ${size}B`,
  );
  return target;
}

test("a run whose artifact is past the read cap keeps its row and says why it has no counts", async (t) => {
  const projectRoot = await makeProject("over-cap-visible");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeOverCapArtifact(projectRoot, "meta-over-cap-1");

  const entry = registryEntry(projectRoot);
  const sessions = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    maxJsonBytes: OVER_CAP_JSON_BYTES,
  }).listSessions(entry.projectRef);

  const session = sessions.find((item) => item.runId === "meta-over-cap-1");
  // The defect this guards: the reader returned nothing for the run, the run
  // produced no row, and "ran and produced this" became indistinguishable from
  // "never ran". Two real runs with rendered deliverables were invisible this way.
  assert.ok(session, "a run refused for its size must still appear in the list");
  assert.deepEqual(session.countsAvailability, {
    state: "unavailable",
    reason: "governed_artifact_over_read_cap",
  });
  assert.equal(
    session.substanceClass,
    "substantive",
    "an artifact on disk is observed output, and folding the row away would hide it again",
  );
  assert.equal(session.workerCount, undefined, "a count nobody could read must stay absent");
  assert.equal(session.nodeCount, undefined);
  assert.equal(session.eventCount, undefined);
  assert.equal(
    session.updatedAtBasis,
    "record_file_write_time",
    "the only time available for an unread file is when it was written",
  );
});

test("an unread artifact and a run that never produced one give different reasons", async (t) => {
  const projectRoot = await makeProject("over-cap-distinct");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeOverCapArtifact(projectRoot, "meta-over-cap-2");

  const runDir = path.join(projectRoot, ".meta-kim", "state", "default", "runs", "meta-activation-2");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "status.json"), JSON.stringify({
    runId: "meta-activation-2",
    lifecycleStatus: "session_stopped",
    currentStage: "fetch",
    updatedAt: "2026-08-26T08:20:00.000Z",
  }), "utf8");

  const entry = registryEntry(projectRoot);
  const sessions = new Map(
    (await createLiveHubProjectCatalog({
      listJoinedProjects: async () => [entry],
      maxJsonBytes: OVER_CAP_JSON_BYTES,
    }).listSessions(entry.projectRef)).map((session) => [session.runId, session]),
  );

  // Both rows report no counts, and a single reason for both would tell a reader
  // that a run which produced a 9 MB artifact produced nothing at all.
  assert.equal(
    sessions.get("meta-over-cap-2").countsAvailability.reason,
    "governed_artifact_over_read_cap",
  );
  assert.equal(
    sessions.get("meta-activation-2").countsAvailability.reason,
    "no_governed_artifact_for_run",
  );
});

test("an over-cap artifact does not downgrade a run whose compact projection is readable", async (t) => {
  const projectRoot = await makeProject("over-cap-compact");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeOverCapArtifact(projectRoot, "meta-over-cap-3");
  await writeCompactProjection(projectRoot, "meta-over-cap-3");

  const entry = registryEntry(projectRoot);
  const sessions = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    maxJsonBytes: OVER_CAP_JSON_BYTES,
  }).listSessions(entry.projectRef);
  const session = sessions.find((item) => item.runId === "meta-over-cap-3");

  // The compact projection is the designed fallback for an artifact past the raw
  // cap. Registering the refusal must not join the readable record set, or the row
  // it was meant to rescue would lose the counts it already had.
  assert.ok(session, "the run must still be listed");
  assert.deepEqual(session.countsAvailability, {
    state: "measured",
    reason: "governed_artifact_collections",
  });
  assert.equal(session.nodeCount, 2);
  assert.equal(session.eventCount, 1);
  assert.equal(
    session.title,
    "Committed compact run",
    "identity must still come from the projection, not from the refusal record",
  );
});

test("an over-cap artifact is still named as the unread file when the run also has a readable status", async (t) => {
  const projectRoot = await makeProject("over-cap-with-status");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeOverCapArtifact(projectRoot, "meta-over-cap-4");

  // The activation hook writes a per-run status file for every run it sees, so a
  // run that also has an over-cap artifact is the ordinary shape rather than an
  // edge case. Suppressing the refusal because *something* was readable put this
  // row back on "nobody wrote an artifact" while a multi-megabyte one sat on disk.
  const runDir = path.join(projectRoot, ".meta-kim", "state", "default", "runs", "meta-over-cap-4");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "status.json"), JSON.stringify({
    runId: "meta-over-cap-4",
    lifecycleStatus: "session_stopped",
    currentStage: "fetch",
    updatedAt: "2026-08-26T08:20:00.000Z",
  }), "utf8");

  const entry = registryEntry(projectRoot);
  const sessions = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    maxJsonBytes: OVER_CAP_JSON_BYTES,
  }).listSessions(entry.projectRef);
  const session = sessions.find((item) => item.runId === "meta-over-cap-4");

  assert.ok(session, "the run must be listed");
  assert.deepEqual(session.countsAvailability, {
    state: "unavailable",
    reason: "governed_artifact_over_read_cap",
  });

  // The refusal carries the unread file's write time, which is newer than anything
  // the readable status declares. Publishing it as an ordinary record would let it
  // win the newest-record sort and answer for the run's status, stage and time —
  // so the row would gain a true reason and lose four facts it already had.
  assert.equal(session.status, "session_stopped", "the readable status must still answer for the run");
  assert.equal(session.currentStage, "fetch");
  assert.equal(session.updatedAt, "2026-08-26T08:20:00.000Z");
  assert.equal(session.updatedAtBasis, "recorded");
});

test("a status file past the read cap keeps its row without claiming an artifact was unread", async (t) => {
  const projectRoot = await makeProject("over-cap-status-only");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  const runDir = path.join(projectRoot, ".meta-kim", "state", "default", "runs", "meta-over-cap-5");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "status.json"), JSON.stringify({
    runId: "meta-over-cap-5",
    lifecycleStatus: "session_stopped",
    currentStage: "fetch",
    updatedAt: "2026-08-26T08:20:00.000Z",
    padding: "padding ".repeat(96),
  }), "utf8");

  const entry = registryEntry(projectRoot);
  const sessions = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    maxJsonBytes: OVER_CAP_JSON_BYTES,
  }).listSessions(entry.projectRef);
  const session = sessions.find((item) => item.runId === "meta-over-cap-5");

  // The row must survive — that is the whole point of publishing a refusal. But the
  // file that was refused here is a status file, and reporting "the artifact is past
  // the read cap" for a run that never had an artifact trades one wrong statement
  // for another.
  assert.ok(session, "a run whose only file was refused for size must still appear");
  assert.equal(session.countsAvailability.reason, "no_governed_artifact_for_run");
});

test("when both a status file and the artifact are past the cap, the artifact is the one named", async (t) => {
  const projectRoot = await makeProject("over-cap-both");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeOverCapArtifact(projectRoot, "meta-over-cap-6");

  const runDir = path.join(projectRoot, ".meta-kim", "state", "default", "runs", "meta-over-cap-6");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "status.json"), JSON.stringify({
    runId: "meta-over-cap-6",
    lifecycleStatus: "session_stopped",
    currentStage: "fetch",
    updatedAt: "2026-08-26T08:20:00.000Z",
    padding: "padding ".repeat(96),
  }), "utf8");

  const entry = registryEntry(projectRoot);
  const sessions = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    maxJsonBytes: OVER_CAP_JSON_BYTES,
  }).listSessions(entry.projectRef);
  const session = sessions.find((item) => item.runId === "meta-over-cap-6");

  // Which refusal is recorded decides what the row says, and which file the scan
  // reached first is incidental to the run. Letting arrival order decide makes the
  // row report "no artifact was written" on a run whose artifact is sitting there.
  assert.ok(session, "the run must be listed");
  assert.equal(session.countsAvailability.reason, "governed_artifact_over_read_cap");
});


// The Hub serves one catalog covering every registered project, and the control
// room asks for it on first paint and on every project or run switch. Measured
// in-process before this test existed: 19 projects took 1614ms and 1657ms on two
// consecutive calls, walked one after another, while a concurrent /api/health
// answered in 1ms — the wall clock was independent file I/O waiting in line, not
// a busy event loop. Parallel walks finish out of registry order, so the second
// half of this test is the part that keeps the project list from reshuffling
// itself under the reader every time disk timing changes.
test("listProjects walks independent projects at once and answers in registry order", async (t) => {
  const names = ["scan-a", "scan-b", "scan-c", "scan-d"];
  const roots = [];
  for (const [index, name] of names.entries()) {
    const root = await makeProject(name);
    roots.push(root);
    await writeArtifact(root, `meta-scan-${index + 1}`);
  }
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

  const entries = roots.map((root, index) => registryEntry(root, { displayName: `Project ${index}` }));
  // Descending, so completion order is the reverse of registry order whenever the
  // walks overlap. Equal delays would let a push-as-you-finish implementation pass.
  const delayByRef = new Map(entries.map((entry, index) => [entry.projectRef, 200 - index * 50]));

  async function walk(scanPolicy) {
    const log = [];
    const catalog = createLiveHubProjectCatalog({
      listJoinedProjects: async () => entries,
      now: () => Date.parse("2026-08-26T08:25:00.000Z"),
      ...(scanPolicy ? { scanPolicy } : {}),
      discoverRuntimeConversations: async ({ projectRef }) => {
        log.push(`enter ${projectRef}`);
        await new Promise((resolve) => setTimeout(resolve, delayByRef.get(projectRef)));
        log.push(`exit ${projectRef}`);
        return [];
      },
    });
    const projects = await catalog.listProjects();
    return { log, names: projects.map((project) => project.displayName) };
  }

  const registryOrder = entries.map((entry, index) => `Project ${index}`);

  const serial = await walk(normalizeLiveCatalogScanPolicy({
    schemaVersion: LIVE_CATALOG_SCAN_SCHEMA_VERSION,
    cacheTtlMs: 2000,
    staleWhileRevalidateMs: 60_000,
    projectScanConcurrency: 1,
  }));
  assert.deepEqual(
    serial.log,
    entries.flatMap((entry) => [`enter ${entry.projectRef}`, `exit ${entry.projectRef}`]),
    "one lane must still finish each project before starting the next, or the policy value is being ignored",
  );
  assert.deepEqual(serial.names, registryOrder);

  const shipped = await walk(null);
  assert.deepEqual(
    [...shipped.log.slice(0, entries.length)].sort(),
    entries.map((entry) => `enter ${entry.projectRef}`).sort(),
    "the shipped policy has to reach the catalog: every project must be in flight before the first one finishes",
  );
  assert.deepEqual(
    shipped.log.slice(entries.length),
    [...entries].reverse().map((entry) => `exit ${entry.projectRef}`),
    "this fixture makes the earliest-registered project the slowest, so completion order is the reverse of registry order",
  );
  assert.deepEqual(
    shipped.names,
    registryOrder,
    "the answer is ordered by the registry, not by which disk finished first; otherwise the project list reshuffles between two identical requests",
  );
});
