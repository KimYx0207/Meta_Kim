import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildProjectRef,
  joinProjectRegistry,
} from "../../scripts/project-registry.mjs";
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
    nodes: [{ id: "agent:11111111111111111111" }, { id: "agent:22222222222222222222" }],
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

  assert.deepEqual(sessions.map((session) => session.runId), [
    "meta-budget-11",
    "meta-budget-10",
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
    status: "active",
    displayState: "active",
    statusReason: "运行当前仍处于活动状态。",
    currentStage: "execution",
    runtime: "codex",
    updatedAt: "2026-08-26T10:00:00.000Z",
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
    status: "in_doubt",
    displayState: "unknown",
    statusReason: "现有记录不足以判断该任务是否执行或完成。",
    currentStage: "evolution",
    runtime: "in_doubt",
    updatedAt: "2026-08-26T08:30:00.000Z",
    nodeCount: 2,
    eventCount: 1,
    active: false,
  });
  assert.equal(project.sessions[1].status, "in_doubt");
  assert.equal(project.sessions[1].active, false);
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
  assert.deepEqual(sessions.map((session) => session.runId), ["meta-good-1"]);
  assert.doesNotMatch(JSON.stringify(sessions), /Must not appear|Oversized raw|padding/iu);
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
