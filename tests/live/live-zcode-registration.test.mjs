import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importDatabaseSync } from "../../src/data/sqlite/runtime.mjs";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";
import { buildProjectRef, getProjectRegistryPaths, joinProjectRegistry, registerLiveNativeZcodeBinding, listLiveNativeZcodeBindings, skipProjectRegistry } from "../../scripts/project-registry.mjs";
import { createProjectTaskIdentity } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { parseArgs } from "../../scripts/meta-kim-live.mjs";

const SESSION = "sess_11111111-1111-4111-8111-111111111111";
const TURN = "turn_22222222-2222-4222-8222-222222222222";
const OTHER_TURN = "turn_33333333-3333-4333-8333-333333333333";
const RUN = "meta-2026-10-30t15-56-18-831z-a4fcae51aea09332";
const NATIVE_RUN = `native-zcode-${SESSION}-${TURN}`;

async function fixture(t, { defaultRun = RUN } = {}) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "meta-live-zcode-"));
  const projectRoot = path.join(homeDir, "project");
  const otherRoot = path.join(homeDir, "other");
  const zcodeHome = path.join(homeDir, ".zcode", "cli");
  await Promise.all([projectRoot, otherRoot, path.join(zcodeHome, "db")].map((directory) => mkdir(directory, { recursive: true })));
  const DatabaseSync = await importDatabaseSync();
  const db = new DatabaseSync(path.join(zcodeHome, "db", "db.sqlite"));
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, path TEXT, title TEXT, time_updated INTEGER, parent_id TEXT, time_deleted INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, sequence INTEGER, data TEXT);`);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, NULL, NULL)").run(SESSION, projectRoot, projectRoot, "Actual task", Date.now());
  const input = "Repair the current real-time task graph";
  const time = "2026-10-30T15:56:18.831Z";
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("user", SESSION, 1, Date.parse(time), JSON.stringify({ role: "user", anchor: { turnId: TURN, origin: "realUser" }, time, metadata: { inputIntent: { text: input } } }));
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("assistant", SESSION, 2, Date.parse(time) + 1, JSON.stringify({ role: "assistant", parentID: "user", anchor: { turnId: TURN }, time, finish: "tool-calls" }));
  const addTool = (id, status = "running") => db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(id, SESSION, "assistant", Number(id.replace(/\D/gu, "")) || 1,
    JSON.stringify({ type: "tool", tool: "Agent", callID: id, state: { status, input: { description: `Task ${id}`, subagent_type: "javascript-pro", prompt: "PRIVATE BODY" }, output: "PRIVATE RESULT", time: { start: Date.now(), ...(status === "running" ? {} : { end: Date.now() }) } } }));
  addTool("call-1");
  await joinProjectRegistry({ homeDir, repoPath: projectRoot });
  await joinProjectRegistry({ homeDir, repoPath: otherRoot });
  const controller = createLiveControlRoomServer({ globalHub: true, homeDir, zcodeHome, pollIntervalMs: 20 });
  const address = await controller.start();
  t.after(async () => { await controller.close(); db.close(); await rm(homeDir, { recursive: true, force: true }); });
  const projectId = buildProjectRef({ repoPath: projectRoot });
  const get = (endpoint, runId = defaultRun, selectedProject = projectId) => fetch(`${address.url}${endpoint}?${new URLSearchParams({ projectId: selectedProject, runId })}`);
  return { homeDir, projectRoot, otherRoot, zcodeHome, controller, address, projectId, get, addTool, input };
}

test("ZCode native CLI arguments require exact session and turn together", () => {
  assert.throws(() => parseArgs(["--observe-zcode-session", SESSION]), /must be supplied together/u);
  assert.throws(() => parseArgs(["--observe-zcode-turn", TURN]), /must be supplied together/u);
  assert.throws(() => parseArgs(["--observe-zcode-session", "../session", "--observe-zcode-turn", TURN]), /exact native identifier/u);
  assert.throws(() => parseArgs(["--observe-zcode-session", SESSION, "--observe-zcode-turn", TURN, "--observe-codex-thread", "44444444-4444-4444-8444-444444444444"]), /one native runtime/u);
  assert.throws(() => parseArgs(["--observe-zcode-session", SESSION, "--observe-zcode-turn", TURN, "--run-id", RUN]), /deterministic native/u);
  assert.equal(parseArgs(["--observe-zcode-session", SESSION, "--observe-zcode-turn", TURN, "--run-id", NATIVE_RUN]).runId, NATIVE_RUN);
});

test("local registration uses native identity, streams events, and is revoked with enrollment", async (t) => {
  const f = await fixture(t, { defaultRun: NATIVE_RUN });
  assert.equal((await f.get("/api/snapshot")).status, 404);
  assert.equal(await registerLiveNativeZcodeBinding({ homeDir: f.homeDir, repoPath: f.projectRoot, zcodeHome: f.zcodeHome, sessionId: SESSION, turnId: TURN, runId: RUN }), null);
  await registerLiveNativeZcodeBinding({ homeDir: f.homeDir, repoPath: f.projectRoot, zcodeHome: f.zcodeHome, sessionId: SESSION, turnId: TURN });
  const response = await f.get("/api/snapshot");
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.run.runId, NATIVE_RUN);
  assert.equal(snapshot.run.sourceRuntime, "zcode");
  assert.equal(snapshot.nodes.length, 2);
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE"), false);
  assert.equal((await f.get("/api/snapshot", NATIVE_RUN, buildProjectRef({ repoPath: f.otherRoot }))).status, 404);
  assert.equal((await f.get("/api/snapshot", "meta-2026-10-30t15-56-18-831z-aaaaaaaaaaaaaaaa")).status, 404);
  const replay = await (await f.get("/api/replay")).json();
  assert.equal(replay.runId, NATIVE_RUN);
  assert.ok(replay.replay.length > 0);
  assert.notEqual((await f.get("/api/share")).status, 200, "native observed aliases cannot be shared as accepted deliverables");
  assert.equal((await fetch(`${f.address.url}/api/projects`, { method: "POST" })).status, 405);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(`${f.address.url}/api/events?${new URLSearchParams({ projectId: f.projectId, runId: NATIVE_RUN })}`, { signal: abort.signal });
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /call-1/u);
  f.addTool("call-2", "completed");
  const update = await Promise.race([reader.read(), new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error("ZCode SSE update missing")), 3000); timeout.unref(); })]);
  assert.match(new TextDecoder().decode(update.value), /call-2/u);
  await reader.cancel();
  const collision = await registerLiveNativeZcodeBinding({ homeDir: f.homeDir, repoPath: f.projectRoot, zcodeHome: f.zcodeHome, sessionId: SESSION, turnId: OTHER_TURN, runId: NATIVE_RUN });
  assert.equal(collision, null, "another turn cannot claim an existing native identity");
  await skipProjectRegistry({ homeDir: f.homeDir, repoPath: f.projectRoot });
  assert.equal((await f.get("/api/snapshot")).status, 404);
  assert.equal((await listLiveNativeZcodeBindings({ homeDir: f.homeDir })).length, 0);
});

test("saved manual meta aliases are preserved but cannot attribute an unrelated native turn", async (t) => {
  const f = await fixture(t);
  const DatabaseSync = await importDatabaseSync();
  const db = new DatabaseSync(getProjectRegistryPaths({ homeDir: f.homeDir }).projectRegistryPath);
  const metadata = { schemaVersion: "meta-kim-live-native-binding-v1", runtime: "zcode", profile: "default", sessionId: SESSION, turnId: TURN, runId: RUN, zcodeHome: f.zcodeHome };
  const sourceRef = `default:${SESSION}:${TURN}:${RUN}`;
  const now = new Date().toISOString();
  try {
    db.prepare("INSERT INTO project_sources (project_ref, source_type, source_ref, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(f.projectId, "live_native_zcode", sourceRef, JSON.stringify(metadata), now, now);
    assert.equal((await listLiveNativeZcodeBindings({ homeDir: f.homeDir })).length, 0);
    assert.equal((await f.get("/api/snapshot")).status, 404);
    const catalog = await (await f.get("/api/projects")).json();
    assert.equal(catalog.projects.flatMap((project) => project.sessions).some((session) => session.runId === RUN && session.sourceRuntime === "zcode"), false);
    assert.equal(db.prepare("SELECT metadata_json FROM project_sources WHERE source_ref = ?").get(sourceRef).metadata_json, JSON.stringify(metadata));
  } finally { db.close(); }
});

test("an existing receipt joins only its exact native user input HMAC without registration writes", async (t) => {
  const f = await fixture(t);
  const identity = await createProjectTaskIdentity(f.projectRoot, f.input, { profile: "default" });
  const stateDir = path.join(f.projectRoot, ".meta-kim", "state", "default");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "active-run.json"), JSON.stringify({ schemaVersion: 2, runId: RUN, active: true, currentStage: "critical", currentStageKey: "critical", stageIndex: 1, startedAt: "2026-10-30T15:56:18.831Z", taskFingerprint: identity.taskFingerprint }));
  const response = await f.get("/api/snapshot");
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.run.runId, RUN);
  assert.equal(snapshot.run.sourceRuntime, "zcode");
  assert.equal(snapshot.nodes.length, 2);
  assert.equal((await listLiveNativeZcodeBindings({ homeDir: f.homeDir })).length, 0, "automatic observation does not create another state authority");
  const catalog = await (await f.get("/api/projects")).json();
  const row = catalog.projects.find((project) => project.projectId === f.projectId).sessions.find((session) => session.runId === RUN);
  assert.equal(row.sourceRuntime, "zcode");
  assert.equal(row.nodeCount, 2);
});
