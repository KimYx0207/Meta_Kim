import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexNativeSessionReader } from "../../src/infrastructure/live/codex-native-session-reader.mjs";
import { buildNativeCodexLiveSnapshot } from "../../src/application/live/live-native-codex-projection.mjs";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";
import { nativeCodexStartupBinding, parseArgs } from "../../scripts/meta-kim-live.mjs";
import { buildProjectRef } from "../../scripts/project-registry.mjs";

const THREAD = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const TURN = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const SINCE = Date.parse("2026-10-21T08:00:00.000Z");
const NOW = SINCE + 60_000;
const at = (offset = 0) => new Date(SINCE + offset).toISOString();
const row = (type, payload, offset = 0) => ({ type, timestamp: at(offset), payload });
const meta = (projectRoot, id = THREAD, parent = null) => row("session_meta", { id, originator: "Codex Desktop", cwd: projectRoot, source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "vscode" });
const context = (turn = TURN, offset = 1) => row("turn_context", { turn_id: turn }, offset);
const childStart = (turn = OTHER, offset = 3, parentTurn = TURN) => row("event_msg", { type: "task_started", turn_id: turn, root_turn_id: parentTurn, turn_attribution: { parent_turn_id: parentTurn } }, offset);
const serialize = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const command = (root, { thread = THREAD, turn = TURN, exitCode = 0, offset = 4 } = {}) => row("event_msg", { type: "item_completed", thread_id: thread, turn_id: turn, item: { type: "CommandExecution", id: "exec-native-1", cwd: root, command: "SECRET COMMAND", aggregated_output: "sk-private-content", status: exitCode ? "failed" : "completed", exit_code: exitCode, duration: 8 } }, offset);
const spawn = () => [
  row("response_item", { type: "function_call", namespace: "collaboration", name: "spawn_agent", call_id: "call-spawn-1", arguments: JSON.stringify({ task_name: "native_backend", agent_type: "javascript-pro", message: "roleDisplayName=backend; PRIVATE PROMPT" }) }, 2),
  row("response_item", { type: "function_call_output", call_id: "call-spawn-1", output: "PRIVATE OUTPUT" }, 3),
  row("event_msg", { type: "item_completed", thread_id: THREAD, turn_id: TURN, item: { type: "SubAgentActivity", id: "call-spawn-1", agent_thread_id: CHILD, agent_path: "/root/native_backend", kind: "started" } }, 5),
];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-native-session-test-"));
  const projectRoot = path.join(root, "project");
  const codexHome = path.join(root, ".codex");
  const day = path.join(codexHome, "sessions", "2026", "10", "21");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(day, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(day, `rollout-2026-10-21T16-00-00-${THREAD}_segment.jsonl`);
  const options = { projectRoot, codexHome, threadId: THREAD, turnId: TURN, sinceMs: SINCE, now: () => NOW };
  return { root, projectRoot, codexHome, day, file, options, async write(records) { await writeFile(file, serialize(records)); } };
}

test("reads bound native command events without raw commands, paths, output or acceptance promotion", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), command(f.projectRoot, { exitCode: 2 }), ...spawn()]);
  const observation = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observation.state, "observed");
  assert.equal(observation.commands[0].exitCode, 2);
  assert.equal(observation.agents[0].completed, false);
  const snapshot = buildNativeCodexLiveSnapshot(observation);
  assert.equal(snapshot.counts.executionEvidence, 2);
  assert.equal(snapshot.toolCalls[0].status, "failed");
  assert.equal(snapshot.run.completionEvidenceState, "unproven");
  assert.ok(snapshot.evidence.every((item) => item.executionObserved && !item.proofValid));
  const text = JSON.stringify(snapshot);
  for (const privateText of ["SECRET COMMAND", "sk-private-content", "PRIVATE PROMPT", "PRIVATE OUTPUT", f.projectRoot]) assert.equal(text.includes(privateText), false);
});

test("typed host spawn completion alone cannot attest child task completion", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), ...spawn()]);
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].spawnReturned, true);
  assert.equal(observed.agents[0].completed, false);
  assert.equal(buildNativeCodexLiveSnapshot(observed).nodes[1].active, true);
});

test("paired parent spawn plus exact child parent metadata and terminal event yields returned, never accepted", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), ...spawn()]);
  const child = path.join(f.day, `rollout-2026-10-21T16-00-00-${CHILD}.jsonl`);
  await writeFile(child, serialize([meta(f.projectRoot, CHILD, THREAD), childStart(), context(OTHER, 3), row("event_msg", { type: "task_complete", turn_id: OTHER, last_agent_message: "PRIVATE RESULT" }, 10)]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].completed, true);
  const node = buildNativeCodexLiveSnapshot(observed).nodes[1];
  assert.equal(node.status, "in_doubt");
  assert.equal(node.executionState, "executed");
  assert.equal(node.active, false);
  assert.equal(node.terminalEvidence.length, 0);
});

test("wrong child parent and unpaired parent spawn cannot mint a returned worker", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), ...spawn()]);
  await writeFile(path.join(f.day, `rollout-${CHILD}.jsonl`), serialize([meta(f.projectRoot, CHILD, OTHER), row("event_msg", { type: "task_complete" }, 10)]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].completed, false);
  await f.write([meta(f.projectRoot), context(), spawn()[0], spawn()[2]]);
  assert.equal((await createCodexNativeSessionReader(f.options).read()).agents.length, 0);
});

test("cross-thread, cross-turn and cross-project commands do not join the bound turn", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), command(f.projectRoot, { thread: OTHER }), command(f.projectRoot, { turn: OTHER }), command(path.join(f.root, "other"))]);
  assert.equal((await createCodexNativeSessionReader(f.options).read()).commands.length, 0);
  await f.write([meta(path.join(f.root, "other")), context(), command(f.projectRoot)]);
  assert.equal((await createCodexNativeSessionReader(f.options).read()).state, "unavailable");
});

test("resume file names need not equal thread id; oversized old segment and partial final append are ignored", async (t) => {
  const f = await fixture(t);
  const old = path.join(f.day, `rollout-2026-10-21T01-00-00-${THREAD}.jsonl`);
  await writeFile(old, "x".repeat(4_096));
  await f.write([meta(f.projectRoot), context(), command(f.projectRoot)]);
  await appendFile(f.file, '{"type":"event_msg","payload":');
  const before = createHash("sha256").update(await readFile(f.file)).digest("hex");
  const observed = await createCodexNativeSessionReader({ ...f.options, maxBytes: 3_072 }).read();
  assert.equal(observed.state, "observed");
  assert.equal(observed.commands.length, 1);
  assert.equal(createHash("sha256").update(await readFile(f.file)).digest("hex"), before);
});

test("latest follows only the bound thread while explicit old-turn reads remain stable", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), command(f.projectRoot), context(OTHER, 10), command(f.projectRoot, { turn: OTHER, offset: 11 })]);
  const reader = createCodexNativeSessionReader({ ...f.options, turnId: undefined });
  assert.equal((await reader.read()).turnId, OTHER);
  assert.equal((await reader.readTurn(TURN)).turnId, TURN);
  await assert.rejects(createCodexNativeSessionReader(f.options).readTurn(OTHER), /native_session_turn_not_bound/u);
});

test("zero-event native turn does not claim execution or task completion", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context()]);
  const snapshot = buildNativeCodexLiveSnapshot(await createCodexNativeSessionReader(f.options).read());
  assert.equal(snapshot.counts.executionEvidence, 0);
  assert.equal(snapshot.nodes[0].executionObserved, false);
  assert.equal(snapshot.nodes[0].executionState, "not_observed");
  assert.equal(snapshot.run.executionEvidenceState, "not_observed");
  assert.equal(snapshot.run.active, false);
});

test("later child follow-up completion cannot finish an older parent turn", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), ...spawn(), row("event_msg", { type: "task_complete" }, 7)]);
  await writeFile(path.join(f.day, `rollout-${CHILD}.jsonl`), serialize([meta(f.projectRoot, CHILD, THREAD), childStart(), context(OTHER, 3), context(TURN, 9), row("event_msg", { type: "task_complete", turn_id: TURN }, 10)]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].completed, false);
});

test("copied parent task_complete cannot finish a currently running child turn", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), ...spawn()]);
  await writeFile(path.join(f.day, `rollout-${CHILD}.jsonl`), serialize([
    meta(f.projectRoot, CHILD, THREAD), context(TURN, 2),
    row("event_msg", { type: "task_complete", turn_id: TURN }, 3),
    childStart(OTHER, 4), context(OTHER, 4), command(f.projectRoot, { thread: CHILD, turn: OTHER, offset: 6 }),
  ]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].childMetadataVerified, true);
  assert.equal(observed.agents[0].childTurnId, OTHER);
  assert.equal(observed.agents[0].completed, false);
});

test("new same-parent child follow-up or later same-turn tool activity invalidates a prior return", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), ...spawn()]);
  const file = path.join(f.day, `rollout-${CHILD}.jsonl`);
  await writeFile(file, serialize([
    meta(f.projectRoot, CHILD, THREAD), childStart(), context(OTHER, 3),
    row("event_msg", { type: "task_complete", turn_id: OTHER }, 6),
    command(f.projectRoot, { thread: CHILD, turn: OTHER, offset: 7 }),
  ]));
  assert.equal((await createCodexNativeSessionReader(f.options).read()).agents[0].completed, false);
  await appendFile(file, serialize([childStart(TURN, 9), context(TURN, 9)]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].childTurnId, TURN);
  assert.equal(observed.agents[0].completed, false);
});

test("newer active child resume segments cannot be overwritten by an older returned turn", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), ...spawn()]);
  const newerTurn = "55555555-5555-4555-8555-555555555555";
  await writeFile(path.join(f.day, `rollout-2026-10-21T16-00-00-${CHILD}.jsonl`), serialize([
    meta(f.projectRoot, CHILD, THREAD), childStart(OTHER, 7), context(OTHER, 8),
    row("event_msg", { type: "task_complete", turn_id: OTHER }, 10),
  ]));
  const resumed = path.join(f.day, `rollout-2026-10-21T16-01-00-${CHILD}_segment.jsonl`);
  await writeFile(resumed, serialize([
    meta(f.projectRoot, CHILD, THREAD), childStart(newerTurn, 12), context(newerTurn, 13),
    command(f.projectRoot, { thread: CHILD, turn: newerTurn, offset: 14 }),
  ]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].childTurnId, newerTurn);
  assert.equal(observed.agents[0].completed, false);
  assert.equal(buildNativeCodexLiveSnapshot(observed).nodes[1].active, true);
  // A continuation of the same attributed turn also supersedes its old return.
  await writeFile(resumed, serialize([
    meta(f.projectRoot, CHILD, THREAD), childStart(OTHER, 7), context(OTHER, 13),
    command(f.projectRoot, { thread: CHILD, turn: OTHER, offset: 14 }),
  ]));
  assert.equal((await createCodexNativeSessionReader(f.options).read()).agents[0].completed, false);
});

test("parent execution after a terminal event resumes activity until a fresh terminal event", async (t) => {
  const f = await fixture(t);
  const terminal = row("event_msg", { type: "task_complete", turn_id: TURN }, 7);
  const subsequentEvents = [
    command(f.projectRoot, { offset: 8 }),
    row("response_item", { type: "function_call", call_id: "call-after-return", namespace: "functions", name: "exec", arguments: "{}" }, 8),
    row("response_item", { type: "function_call_output", call_id: "call-before-return", output: "PRIVATE OUTPUT" }, 8),
  ];
  for (const subsequent of subsequentEvents) {
    await f.write([meta(f.projectRoot), context(), command(f.projectRoot), terminal, subsequent]);
    const observed = await createCodexNativeSessionReader(f.options).read();
    assert.equal(observed.turnComplete, false);
    assert.equal(observed.turnCompletedAt, null);
    const projected = buildNativeCodexLiveSnapshot(observed);
    assert.equal(projected.run.active, true);
    assert.equal(projected.nodes[0].active, true);
    assert.equal(projected.run.displayState, "active");
  }
  await appendFile(f.file, serialize([row("event_msg", { type: "task_complete", turn_id: TURN }, 9)]));
  const returned = await createCodexNativeSessionReader(f.options).read();
  assert.equal(returned.turnComplete, true);
  assert.equal(buildNativeCodexLiveSnapshot(returned).run.displayState, "in_doubt");
});

test("the earliest bound task start survives later turn contexts and resume segments", async (t) => {
  const f = await fixture(t);
  const started = row("event_msg", { type: "task_started", turn_id: TURN, started_at: (SINCE + 2) / 1000 }, 3);
  await f.write([meta(f.projectRoot), context(), started, command(f.projectRoot), context(TURN, 10)]);
  assert.equal((await createCodexNativeSessionReader(f.options).read()).startedAt, at(2));
  await writeFile(path.join(f.day, `rollout-2026-10-21T16-01-00-${THREAD}.jsonl`), serialize([
    meta(f.projectRoot), context(TURN, 12),
    row("event_msg", { type: "task_started", turn_id: TURN }, 13), command(f.projectRoot, { offset: 14 }),
  ]));
  const resumed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(resumed.startedAt, at(2));
  assert.equal(buildNativeCodexLiveSnapshot(resumed).run.startedAt, at(2));
  // Without task_started, use the earliest available context rather than resume time.
  await f.write([meta(f.projectRoot), context(), command(f.projectRoot)]);
  await writeFile(path.join(f.day, `rollout-2026-10-21T16-01-00-${THREAD}.jsonl`), serialize([meta(f.projectRoot), context(TURN, 12), command(f.projectRoot, { offset: 14 })]));
  assert.equal((await createCodexNativeSessionReader(f.options).read()).startedAt, at(1));
});

test("exact parent resume segments retain earlier execution and deduplicate copied terminals before resumed activity", async (t) => {
  const f = await fixture(t);
  const first = command(f.projectRoot);
  const terminal = row("event_msg", { type: "task_complete", turn_id: TURN }, 7);
  await f.write([meta(f.projectRoot), context(), first, ...spawn(), terminal]);
  const second = command(f.projectRoot, { offset: 14 });
  second.payload.item.id = "exec-native-2";
  const resumed = path.join(f.day, `rollout-2026-10-21T16-01-00-${THREAD}.jsonl`);
  await writeFile(resumed, serialize([meta(f.projectRoot), context(), first, terminal, context(TURN, 12), second]));
  const reader = createCodexNativeSessionReader(f.options);
  const observation = await reader.read();
  assert.equal(observation.agents.length, 1, "earlier native dispatch survives a resumed segment");
  assert.equal(observation.commands.length, 2, "copied command lines are not counted twice");
  assert.equal(observation.turnComplete, false, "an old terminal cannot close resumed execution");
  assert.equal(observation.coverage.parentReadCount, 2);
  assert.equal(observation.coverage.state, "bounded");
  await appendFile(resumed, serialize([row("event_msg", { type: "task_complete", turn_id: TURN }, 16)]));
  assert.equal((await createCodexNativeSessionReader(f.options).read()).turnComplete, true);
});

test("resume merge cannot import another project, thread or turn through a matching filename", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), command(f.projectRoot)]);
  const foreign = command(f.projectRoot, { turn: OTHER, offset: 15 });
  foreign.payload.item.id = "foreign-command";
  await writeFile(path.join(f.day, `rollout-foreign-project-${THREAD}.jsonl`), serialize([meta(path.join(f.root, "other")), context(TURN, 12), foreign]));
  await writeFile(path.join(f.day, `rollout-foreign-thread-${THREAD}.jsonl`), serialize([meta(f.projectRoot, OTHER), context(TURN, 12), foreign]));
  await writeFile(path.join(f.day, `rollout-other-turn-${THREAD}.jsonl`), serialize([meta(f.projectRoot), context(OTHER, 12), foreign]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.deepEqual(observed.commands.map((item) => item.id), ["exec-native-1"]);
  assert.equal(observed.turnId, TURN);
});

test("an exact child start and return can span resume segments without promoting user acceptance", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), ...spawn(), command(f.projectRoot, { exitCode: 2 })]);
  await writeFile(path.join(f.day, `rollout-a-${CHILD}.jsonl`), serialize([meta(f.projectRoot, CHILD, THREAD), childStart(), context(OTHER, 3)]));
  await writeFile(path.join(f.day, `rollout-b-${CHILD}.jsonl`), serialize([meta(f.projectRoot, CHILD, THREAD), context(OTHER, 8), row("event_msg", { type: "task_complete", turn_id: OTHER, last_agent_message: "PRIVATE RESULT" }, 10)]));
  const observation = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observation.agents[0].completed, true);
  const snapshot = buildNativeCodexLiveSnapshot(observation);
  assert.deepEqual(snapshot.run.executionSummary, { observedAgentCount: 1, returnedAgentCount: 1, activeAgentCount: 0, returnedToolCount: 1, failedToolCount: 1, acceptanceState: "unproven" });
  assert.deepEqual(snapshot.session.executionSummary, snapshot.run.executionSummary);
  assert.equal(snapshot.session.completedCount, 0);
  assert.equal(snapshot.run.completionEvidenceState, "unproven");
  assert.equal(snapshot.nodes[1].status, "in_doubt");
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE RESULT"), false);
});

test("large omitted parent and child segments stay bounded and expose partial coverage instead of full completion", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), ...spawn(), command(f.projectRoot)]);
  await writeFile(path.join(f.day, `rollout-large-${THREAD}.jsonl`), "x".repeat(4_096));
  await writeFile(path.join(f.day, `rollout-a-${CHILD}.jsonl`), serialize([meta(f.projectRoot, CHILD, THREAD), childStart(), context(OTHER, 3), row("event_msg", { type: "task_complete", turn_id: OTHER }, 10)]));
  await writeFile(path.join(f.day, `rollout-b-${CHILD}.jsonl`), "x".repeat(4_096));
  const observation = await createCodexNativeSessionReader({ ...f.options, maxBytes: 3_072 }).read();
  assert.equal(observation.coverage.state, "partial");
  assert.deepEqual(observation.coverage.reasons, ["segment_size_limit"]);
  assert.equal(observation.agents[0].completed, false, "an omitted child continuation leaves its current return unconfirmed");
  const snapshot = buildNativeCodexLiveSnapshot(observation);
  assert.equal(snapshot.source.coverage.state, "partial");
  assert.equal(snapshot.run.executionSummary.returnedAgentCount, 0);
  assert.equal(snapshot.run.completionEvidenceState, "unproven");
  assert.ok(snapshot.source.limitations.some((item) => item.includes("partial observations")));
});

test("multiply linked source is rejected even when file symlinks are unavailable", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "outside.jsonl");
  await writeFile(target, serialize([meta(f.projectRoot), context(), command(f.projectRoot)]));
  await link(target, f.file);
  await assert.rejects(createCodexNativeSessionReader(f.options).read(), /native_session_file_rejected/u);
});

test("symbolic links and multiply linked source files fail closed", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "outside.jsonl");
  await writeFile(target, serialize([meta(f.projectRoot), context(), command(f.projectRoot)]));
  try { await symlink(target, f.file, "file"); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("host does not permit a file symlink fixture"); return; } throw error; }
  await assert.rejects(createCodexNativeSessionReader(f.options).read(), /native_session_file_rejected/u);
  await rm(f.file);
  await link(target, f.file);
  await assert.rejects(createCodexNativeSessionReader(f.options).read(), /native_session_file_rejected/u);
});

test("CLI accepts exact native UUID bindings and ordinary CODEX_THREAD_ID startup without invoking a model", () => {
  const args = parseArgs(["--observe-codex-thread", THREAD, "--observe-codex-turn", TURN]);
  const root = path.resolve(".");
  assert.deepEqual(nativeCodexStartupBinding(args, root, {}), { projectRoot: root, threadId: THREAD, turnId: TURN });
  assert.equal(nativeCodexStartupBinding({}, root, { CODEX_THREAD_ID: THREAD }).threadId, THREAD);
  assert.equal(nativeCodexStartupBinding({}, root, {}), null);
});

/** Exercise HTTP handlers in memory; no port or preview process is started. */
async function request(controller, url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("in-memory request timed out")), 5_000);
    const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); }, end(body) { clearTimeout(timeout); resolve({ status: this.statusCode, body: JSON.parse(String(body)) }); } };
    controller.server.emit("request", { method: "GET", url, headers: { host: "127.0.0.1:4331" } }, response);
  });
}

test("trusted native observed run joins existing hub catalog and snapshot without rewriting planning history", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), command(f.projectRoot)]);
  const controller = createLiveControlRoomServer({ globalHub: true, nativeCodex: f.options, hubCatalog: { profile: "default", listProjects: async () => [], resolveProject: async () => null } });
  // Supply the authority that a listening socket normally provides without
  // allocating a socket or starting a preview server in this unit test.
  controller.server.address = () => ({ address: "127.0.0.1", port: 4331 });
  const catalog = await request(controller, "/api/projects");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.projects.length, 1);
  const { projectId, runId } = catalog.body.selected;
  assert.match(runId, /^native-codex-/u);
  const snapshot = await request(controller, `/api/snapshot?projectId=${projectId}&runId=${runId}`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.counts.toolCalls, 1);
  assert.equal(snapshot.body.counts.executionEvidence, 1);
  assert.equal(snapshot.body.run.completionEvidenceState, "unproven");
  const nativeSession = catalog.body.projects[0].sessions.find((session) => session.runId === runId);
  assert.equal(nativeSession.observationKind, "native_execution");
  assert.deepEqual(nativeSession.executionSummary, snapshot.body.run.executionSummary);
  assert.equal(nativeSession.observationCoverage.state, "bounded");
  const replay = await request(controller, `/api/replay?projectId=${projectId}&runId=${runId}`);
  assert.equal(replay.body.runId, runId);
  assert.equal(replay.body.replay.length, 1);
  const share = await request(controller, `/api/share?projectId=${projectId}&runId=${runId}`);
  assert.equal(share.status, 404);
  assert.equal(share.body.error, "share_unavailable");
  const invalid = await request(controller, `/api/snapshot?projectId=${projectId}&runId=native-codex-${OTHER}-${TURN}`);
  assert.notEqual(invalid.status, 200);
});

test("a planning row cannot copy native labels to acquire an observed execution summary", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(), command(f.projectRoot)]);
  const projectRef = buildProjectRef({ repoPath: f.projectRoot });
  const planning = { sessionId: "planning", runId: "governed-plan", title: "Existing plan", status: "pending", titleSource: "artifact", observationKind: "native_execution", executionSummary: { returnedAgentCount: 999 }, workerCount: 1, nodeCount: 1, eventCount: 1 };
  const controller = createLiveControlRoomServer({ globalHub: true, nativeCodex: f.options, hubCatalog: { profile: "default", listProjects: async () => [{ projectRef, repoRoot: f.projectRoot, displayName: "project", sessions: [planning] }], resolveProject: async () => null } });
  controller.server.address = () => ({ address: "127.0.0.1", port: 4331 });
  const catalog = await request(controller, "/api/projects");
  const row = catalog.body.projects[0].sessions.find((session) => session.runId === "governed-plan");
  assert.ok(row);
  assert.equal(row.status, "pending");
  assert.equal(row.observationKind, undefined);
  assert.equal(row.executionSummary, undefined);
  assert.equal(planning.executionSummary.returnedAgentCount, 999, "catalog did not rewrite the source planning row");
});
