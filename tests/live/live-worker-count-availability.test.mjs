import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildProjectRef } from "../../scripts/project-registry.mjs";
import { runWorkerCount } from "../../src/application/live/live-run-substance.mjs";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";
import { createLiveHubProjectCatalog } from "../../src/infrastructure/live/live-hub-project-catalog.mjs";

async function makeProject(name) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), `meta-kim-worker-count-${name}-`));
  await mkdir(path.join(projectRoot, ".git"));
  await mkdir(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions"),
    { recursive: true },
  );
  return projectRoot;
}

function registryEntry(repoRoot) {
  return {
    projectRef: buildProjectRef({ repoPath: repoRoot }),
    repoRoot,
    displayName: path.basename(repoRoot),
    updatedAt: "2026-08-26T08:00:00.000Z",
  };
}

/**
 * Shaped after the schema-version-1 artifacts this project actually persists:
 * they carry `workerTaskPackets` and `workerResultPackets` and carry neither a
 * `nodes` nor a `replay` collection.
 */
async function writeSchemaVersionOneArtifact(projectRoot, runId, overrides = {}) {
  const target = path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "governed-executions",
    `${runId}.json`,
  );
  await writeFile(target, JSON.stringify({
    schemaVersion: 1,
    runId,
    status: "completed",
    currentStage: "verification",
    runtimeFamily: "claude",
    updatedAt: "2026-08-26T08:15:00.000Z",
    workerTaskPackets: [
      { taskPacketId: "task-1", roleDisplayName: "frontend" },
      { taskPacketId: "task-2", roleDisplayName: "backend" },
      { taskPacketId: "task-3", roleDisplayName: "test" },
    ],
    workerResultPackets: [
      { taskPacketId: "task-1", status: "completed" },
      { taskPacketId: "task-2", status: "completed" },
      { taskPacketId: "task-3", status: "completed" },
    ],
    ...overrides,
  }), "utf8");
}

async function sessionsFor(projectRoot) {
  const entry = registryEntry(projectRoot);
  const projects = await createLiveHubProjectCatalog({
    listJoinedProjects: async () => [entry],
    now: () => Date.parse("2026-08-26T09:00:00.000Z"),
  }).listProjects();
  return projects[0].sessions;
}

test("a worker count is measured from whichever worker collection the record declares", () => {
  assert.equal(
    runWorkerCount({ workerTaskPackets: [{ taskPacketId: "task-1" }, { taskPacketId: "task-2" }] }),
    2,
  );
  assert.equal(
    runWorkerCount({ workerResultPackets: [{ taskPacketId: "task-1" }] }),
    1,
  );
  assert.equal(
    runWorkerCount({ workerLifecycle: [{ taskPacketId: "task-1" }, { taskPacketId: "task-2" }] }),
    2,
  );
  assert.equal(
    runWorkerCount({
      nodes: [
        { kind: "agent", isMain: true },
        { kind: "agent" },
        { kind: "agent" },
        { kind: "stage" },
      ],
    }),
    2,
    "a compact projection reports workers as non-main agent nodes",
  );
});

test("a record that declares no worker collection stays unmeasured instead of reporting zero", () => {
  assert.equal(runWorkerCount(null), null);
  assert.equal(runWorkerCount({}), null);
  assert.equal(runWorkerCount({ runId: "meta-bare", currentStageKey: "critical" }), null);
  assert.equal(
    runWorkerCount({ workerTaskPackets: [] }),
    0,
    "an empty declared collection is a measured zero, not an absent report",
  );
  assert.equal(
    runWorkerCount({ nodes: [{ id: "node-1" }, { id: "node-2" }] }),
    null,
    "nodes that declare no kind cannot be split into workers and scaffolding",
  );
  assert.equal(
    runWorkerCount({ nodes: [] }),
    0,
    "an empty node collection is a measured zero",
  );
});

/**
 * All 19 schema-version-1 artifacts on this project's own directory happen to
 * carry equal task and result packet counts, so real data cannot tell these two
 * sources apart. The disagreeing record is constructed for exactly that reason:
 * the equality is a coincidence of runs that all finished, not a contract, and a
 * run that is still executing breaks it.
 */
test("a run that dispatched more workers than reported back is counted by its roster", () => {
  assert.equal(
    runWorkerCount({
      workerTaskPackets: [
        { taskPacketId: "task-1" },
        { taskPacketId: "task-2" },
        { taskPacketId: "task-3" },
        { taskPacketId: "task-4" },
      ],
      workerResultPackets: [{ taskPacketId: "task-1" }, { taskPacketId: "task-2" }],
    }),
    4,
    "two silent workers are the ones a reader is looking for, so they stay counted",
  );
  assert.equal(
    runWorkerCount({
      workerLifecycle: [{ taskPacketId: "task-1" }, { taskPacketId: "task-2" }, { taskPacketId: "task-3" }],
      workerResultPackets: [{ taskPacketId: "task-1" }],
    }),
    3,
    "lifecycle records describe the roster, so they outrank the narrower result set",
  );
  assert.equal(
    runWorkerCount({ workerResultPackets: [{ taskPacketId: "task-1" }, { taskPacketId: "task-2" }] }),
    2,
    "with no roster-shaped collection declared, reports are the only evidence left",
  );
});

/**
 * The projection builder writes `kind` as a literal on every node it emits, so
 * this shape cannot come out of the current pipeline. The branch is kept and
 * tested anyway: if a future producer forgets the field, the roster must read as
 * unmeasured rather than as a confident zero. Covering it through a realistic
 * fixture would be coincidental coverage that disappears the moment the fixture
 * is corrected.
 */
test("nodes that declare no kind read as unmeasured rather than as zero workers", () => {
  assert.equal(
    runWorkerCount({ nodes: [{ id: "node-1" }, { id: "node-2" }, { id: "node-3" }] }),
    null,
  );
  assert.notEqual(
    runWorkerCount({ nodes: [{ id: "node-1" }] }),
    0,
    "reporting zero would claim a run with three unlabelled nodes dispatched nobody",
  );
});

test("a schema-version-1 artifact reports its worker count instead of collapsing to no report", async (t) => {
  const projectRoot = await makeProject("sv1");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeSchemaVersionOneArtifact(projectRoot, "meta-run-sv1-workers");

  const [session] = await sessionsFor(projectRoot);

  assert.equal(session.runId, "meta-run-sv1-workers");
  assert.equal(
    session.workerCount,
    3,
    "the artifact declares three worker packets, so the count is measurable",
  );
  assert.deepEqual(session.countsAvailability, {
    state: "measured",
    reason: "governed_artifact_collections",
  });
  assert.equal(
    session.nodeCount,
    5,
    "three worker packets plus the main agent and its execution lane",
  );
  assert.equal(
    session.eventCount,
    0,
    "this artifact recorded no stage events, so its timeline is measurably empty",
  );
});

/**
 * The worker count is the subject here and it stays absent: nothing in the record
 * says how many workers ran. The graph counts are a separate question with a
 * separate answer — the projection builds an empty graph, and an empty graph is
 * what the page draws.
 */
test("a run with no worker collection anywhere still reports no worker count", async (t) => {
  const projectRoot = await makeProject("no-workers");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeSchemaVersionOneArtifact(projectRoot, "meta-run-sv1-silent", {
    workerTaskPackets: undefined,
    workerResultPackets: undefined,
  });

  const [session] = await sessionsFor(projectRoot);

  assert.equal(session.runId, "meta-run-sv1-silent");
  assert.equal(
    session.workerCount,
    undefined,
    "a record with nothing to count must not invent a number",
  );
  assert.deepEqual(session.countsAvailability, {
    state: "unavailable",
    reason: "artifact_declares_no_collections",
  });
  assert.equal(
    session.nodeCount,
    undefined,
    "the projection anchors its graph on a roster, so with none it read nothing rather than nothing to draw",
  );
});

/**
 * Node and event counts describe the graph the page draws, and that graph is the
 * compact projection — not the raw artifact. Reading top-level `nodes`/`replay`
 * off a schema-version-1 artifact measures a shape no such artifact has: the
 * material sits under `langGraphRunPacket` and `agUiStageEvents`, and the
 * projection derives further nodes from the worker roster on top of that. The
 * counts asserted here are the projection's own output for this fixture, so the
 * number in the row and the number of things drawn cannot drift apart.
 */
test("a schema-version-1 artifact reports the node and event counts its projection draws", async (t) => {
  const projectRoot = await makeProject("graph");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeSchemaVersionOneArtifact(projectRoot, "meta-run-sv1-graph", {
    workerTaskPackets: [
      { taskPacketId: "task-1", roleDisplayName: "frontend" },
      { taskPacketId: "task-2", roleDisplayName: "backend" },
    ],
    workerResultPackets: [
      { taskPacketId: "task-1", status: "completed" },
      { taskPacketId: "task-2", status: "completed" },
    ],
    langGraphRunPacket: {
      nodes: [
        { id: "critical", stage: "critical", status: "completed" },
        { id: "fetch", stage: "fetch", status: "completed" },
        { id: "execution", stage: "execution", status: "completed" },
      ],
    },
    agUiStageEvents: {
      events: [
        { stage: "critical", type: "StageStarted", at: "2026-08-26T08:10:00.000Z" },
        { stage: "critical", type: "StageCompleted", at: "2026-08-26T08:11:00.000Z" },
        { stage: "execution", type: "StageStarted", at: "2026-08-26T08:12:00.000Z" },
      ],
    },
  });

  const [session] = await sessionsFor(projectRoot);

  assert.equal(session.runId, "meta-run-sv1-graph");
  assert.equal(
    session.nodeCount,
    4,
    "the projection draws a main agent, an execution lane and one node per worker",
  );
  assert.equal(
    session.eventCount,
    7,
    "the projection derives run and dispatch events on top of the three stage events",
  );
  assert.deepEqual(
    session.countsAvailability,
    { state: "measured", reason: "governed_artifact_collections" },
    "with all three counts read, the record is fully measured rather than partial",
  );
});

/**
 * The projection derives nodes from the worker roster even when a run recorded no
 * stage graph, so a run like this draws worker nodes and no timeline. Zero events
 * is then a measured zero: it is what the page renders, not a count that failed to
 * be read. Leaving it absent would hide a real answer behind "unavailable".
 */
test("a run with no stage graph still reports the worker nodes its projection draws", async (t) => {
  const projectRoot = await makeProject("no-graph");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeSchemaVersionOneArtifact(projectRoot, "meta-run-sv1-no-graph");

  const [session] = await sessionsFor(projectRoot);

  assert.equal(session.runId, "meta-run-sv1-no-graph");
  assert.equal(
    session.nodeCount,
    5,
    "three worker packets plus the main agent and its execution lane",
  );
  assert.equal(
    session.eventCount,
    0,
    "a run that recorded no stage events draws an empty timeline, which is a measurement",
  );
});

/**
 * Two readers disagree about the same field. The catalog resolves a record's id
 * by requiring a string, so a non-string `runId` falls through to `run.runId`;
 * the projection resolves it by truthiness, so the non-string wins there and
 * fails validation. A record carrying both therefore passes the catalog's
 * identity check and then throws once the projection reads it. Fixtures the
 * catalog rejects outright — a bad file name, an id that disagrees with the file
 * name — never reach this code, so they would prove nothing about the guard.
 *
 * A throw must cost that record its counts and nothing more. Letting it escape
 * would take down the whole directory read and blank every row in the project
 * over one damaged neighbour.
 */
test("a record the projection cannot build leaves its counts absent without failing the read", async (t) => {
  const projectRoot = await makeProject("unprojectable");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeSchemaVersionOneArtifact(projectRoot, "meta-run-sv1-readable");
  await writeFile(
    path.join(projectRoot, ".meta-kim", "state", "default", "governed-executions", "meta-run-sv1-broken.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: 12345,
      run: { runId: "meta-run-sv1-broken" },
      status: "completed",
      currentStage: "verification",
      updatedAt: "2026-08-26T08:16:00.000Z",
      workerTaskPackets: [{ taskPacketId: "task-1" }],
    }),
    "utf8",
  );

  const sessions = await sessionsFor(projectRoot);
  const readable = sessions.find((session) => session.runId === "meta-run-sv1-readable");
  const broken = sessions.find((session) => session.runId === "meta-run-sv1-broken");

  assert.ok(readable, "an unprojectable neighbour must not remove the readable rows");
  assert.equal(readable.nodeCount, 5, "the readable record still reports its projected nodes");
  assert.ok(broken, "the damaged record is still listed rather than dropped from the panel");
  assert.equal(
    broken.nodeCount,
    undefined,
    "the record that threw loses its counts and keeps everything else",
  );
  assert.equal(
    broken.workerCount,
    1,
    "a worker roster read straight off the record survives a failed projection",
  );
});

/**
 * The projection anchors its graph on the worker roster, so an artifact that
 * recorded a real stage graph and no roster still projects to nothing. That empty
 * projection is a failure to build, not a run with nothing in it: the stage nodes
 * are sitting in the file being read. Reporting zero would put a confident number
 * over material the reader can see is there.
 */
test("a stage graph the projection cannot anchor stays absent instead of reporting zero nodes", async (t) => {
  const projectRoot = await makeProject("unanchored");
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await writeSchemaVersionOneArtifact(projectRoot, "meta-run-sv1-unanchored", {
    workerTaskPackets: undefined,
    workerResultPackets: undefined,
    langGraphRunPacket: {
      nodes: [
        { id: "critical", stage: "critical", status: "completed" },
        { id: "execution", stage: "execution", status: "completed" },
      ],
    },
  });

  const [session] = await sessionsFor(projectRoot);

  assert.equal(session.runId, "meta-run-sv1-unanchored");
  assert.equal(
    session.nodeCount,
    undefined,
    "two recorded stage nodes must not be published as a drawn graph of zero",
  );
  assert.equal(session.eventCount, undefined, "an unbuilt graph carries no timeline either");
});

/**
 * The public catalog rebuilds every session from an allow-list, so a count the
 * catalog measures but this boundary does not name never reaches the browser.
 * A worker count fixed in the catalog alone would leave the panel still printing
 * "no worker report" over a number that was measured two layers down.
 */
test("the public catalog publishes a measured worker count and drops one outside its bound", async (t) => {
  const sessions = [
    {
      sessionId: "meta-run-workers",
      runId: "meta-run-workers",
      title: "Dispatched run",
      status: "completed",
      currentStage: "verification",
      runtime: "claude",
      updatedAt: "2026-08-26T08:15:00.000Z",
      countsAvailability: { state: "partial", reason: "artifact_declares_some_collections" },
      workerCount: 3,
      active: false,
    },
    {
      sessionId: "meta-run-absurd",
      runId: "meta-run-absurd",
      title: "Implausible roster",
      status: "completed",
      currentStage: "verification",
      runtime: "claude",
      updatedAt: "2026-08-26T08:10:00.000Z",
      countsAvailability: { state: "measured", reason: "governed_artifact_collections" },
      workerCount: 10_000,
      nodeCount: 4,
      eventCount: 9,
      active: false,
    },
  ];
  const project = {
    projectRef: "project-a1b2c3d4e5f6",
    repoRoot: path.join(os.tmpdir(), "meta-kim-worker-count-public"),
    displayName: "Worker count project",
    updatedAt: "2026-08-26T09:00:00.000Z",
    status: "idle",
    activeSessionId: null,
    sessionCount: sessions.length,
    sessions,
  };
  const controller = createLiveControlRoomServer({
    globalHub: true,
    instanceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    hubCatalog: {
      listProjects: async () => [{ ...project }],
      resolveProject: async (ref) => (ref === project.projectRef ? { ...project } : null),
    },
    createProjectService: () => ({
      getSnapshot: async () => ({ schemaVersion: "meta-kim-live-snapshot-v1", run: null, nodes: [], edges: [], evidence: [], replay: [] }),
      getReplay: async () => ({ schemaVersion: "meta-kim-live-replay-v2", replay: [] }),
      getShare: async () => ({ schemaVersion: "meta-kim-live-share-v1" }),
    }),
  });
  t.after(() => controller.close());
  const address = await controller.start();

  const published = await (await fetch(`${address.url}/api/projects`)).json();
  const [dispatched, absurd] = published.projects[0].sessions;

  assert.equal(
    dispatched.workerCount,
    3,
    "a measured worker count must survive the public allow-list",
  );
  assert.deepEqual(dispatched.countsAvailability, {
    state: "partial",
    reason: "artifact_declares_some_collections",
  });
  assert.equal(
    absurd.workerCount,
    undefined,
    "a count past the public bound is dropped rather than published unchecked",
  );
  assert.equal(
    absurd.countsAvailability.state,
    "partial",
    "dropping one of three counts downgrades the record from measured to partial",
  );
});
