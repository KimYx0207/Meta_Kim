import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  LIVE_HUB_MAX_PROJECTS,
  LIVE_HUB_MAX_SESSIONS,
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
    status: "active",
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
    status: "completed",
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
  }), "utf8");
  const entry = registryEntry(projectRoot, { updatedAt: "not-a-date" });
  const projects = await createLiveHubProjectCatalog({
    profile: "../unsafe",
    listJoinedProjects: async () => [entry],
    now: () => Date.parse("2026-08-26T09:05:00.000Z"),
  }).listProjects();
  assert.equal(projects[0].updatedAt, "2026-08-26T09:00:00.000Z");
  assert.equal(projects[0].sessions[0].title, "Alternate public title");
  assert.equal(projects[0].sessions[0].status, "active");
  assert.equal(projects[0].sessions[0].currentStage, "meta-review");
  assert.equal(projects[0].sessions[0].runtime, "in_doubt");
});
