import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createCodexNativeSessionReader } from "../../src/infrastructure/live/codex-native-session-reader.mjs";
import { locateCodexNativeTurn } from "../../src/infrastructure/live/codex-native-turn-locator.mjs";
import { buildNativeCodexLiveSnapshot } from "../../src/application/live/live-native-codex-projection.mjs";
import { liveTaskDisplayLabel, resolveLiveTaskLifecycle } from "../../src/presentation/live/live-run-overview.mjs";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";
import { nativeCodexStartupBinding, parseArgs, resolveNativeCodexCurrentRun, liveCurrentRunPresentation } from "../../scripts/meta-kim-live.mjs";
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
const context = (projectRoot, turn = TURN, offset = 1) => row("turn_context", { turn_id: turn, cwd: projectRoot }, offset);
const childStart = (turn = OTHER, offset = 3, parentTurn = TURN) => row("event_msg", { type: "task_started", turn_id: turn, root_turn_id: parentTurn, turn_attribution: { parent_turn_id: parentTurn } }, offset);
const serialize = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const largePadding = () => Array.from({ length: 300 }, () => JSON.stringify({ type: "response_item", payload: { type: "message", text: "中".repeat(512) } })).join("\n") + "\n";
const command = (root, { thread = THREAD, turn = TURN, exitCode = 0, offset = 4 } = {}) => row("event_msg", { type: "item_completed", thread_id: thread, turn_id: turn, item: { type: "CommandExecution", id: "exec-native-1", cwd: root, command: "SECRET COMMAND", aggregated_output: "sk-private-content", status: exitCode ? "failed" : "completed", exit_code: exitCode, duration: 8 } }, offset);
const spawn = () => [
  row("response_item", { type: "function_call", namespace: "collaboration", name: "spawn_agent", call_id: "call-spawn-1", arguments: JSON.stringify({ task_name: "native_backend", agent_type: "javascript-pro", message: "roleDisplayName=backend; PRIVATE PROMPT" }) }, 2),
  row("response_item", { type: "function_call_output", call_id: "call-spawn-1", output: "PRIVATE OUTPUT" }, 3),
  row("event_msg", { type: "item_completed", thread_id: THREAD, turn_id: TURN, item: { type: "SubAgentActivity", id: "call-spawn-1", agent_thread_id: CHILD, agent_path: "/root/native_backend", kind: "started" } }, 5),
];

async function fixture(t, projectName = "project") {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-native-session-test-"));
  const projectRoot = path.join(root, projectName);
  const codexHome = path.join(root, ".codex");
  const day = path.join(codexHome, "sessions", "2026", "10", "21");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(day, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(day, `rollout-2026-10-21T16-00-00-${THREAD}_segment.jsonl`);
  const options = { projectRoot, codexHome, threadId: THREAD, turnId: TURN, sinceMs: SINCE, now: () => NOW };
  return { root, projectRoot, codexHome, day, file, options, async write(records) { await writeFile(file, serialize(records)); } };
}

function nativeTurnHint(f, { thread = THREAD, turn = TURN, offset = 0, endOffset = null, rootTurn = TURN, ordinal = 1 } = {}) {
  const file = path.join(f.codexHome, "thread_history_1.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, rollout_byte_offset INTEGER, root_turn_id TEXT, rollout_end_byte_offset INTEGER, PRIMARY KEY (thread_id, turn_id)); CREATE INDEX IF NOT EXISTS idx_native_turn_page ON thread_turns (thread_id, rollout_ordinal)");
  db.prepare("INSERT OR REPLACE INTO thread_turns VALUES (?, ?, ?, ?, ?, ?)").run(thread, turn, ordinal, offset, rootTurn, endOffset);
  db.close();
  return file;
}

function nativeChildHint(f, child = CHILD, extra = {}) {
  const db = new DatabaseSync(path.join(f.codexHome, "thread_history_1.sqlite"));
  db.exec("CREATE TABLE IF NOT EXISTS thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, item_type TEXT NOT NULL, item_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_native_item_turn ON thread_items (thread_id, turn_id, rollout_ordinal)");
  db.prepare("INSERT INTO thread_items VALUES (?, ?, 1, 'subAgentActivity', ?)").run(THREAD, TURN,
    JSON.stringify({ type: "subAgentActivity", kind: "started", agentThreadId: child, agentPath: "/root/UNTRUSTED_INDEX_NAME", agentRole: "UNTRUSTED_INDEX_OWNER", ...extra }));
  db.close();
}

test("a child locator needs exact native parent-turn source proof and never invents a parent dispatch", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
  nativeChildHint(f);
  const metadata = meta(f.projectRoot, CHILD, THREAD);
  Object.assign(metadata.payload.source.subagent.thread_spawn, { agent_path: "/root/source_only_worker", agent_role: "javascript-pro" });
  await writeFile(path.join(f.day, `rollout-child-${CHILD}.jsonl`), serialize([metadata, childStart(), context(f.projectRoot, OTHER, 4), row("event_msg", { type: "task_complete", turn_id: OTHER }, 10)]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents.length, 1);
  assert.equal(observed.agents[0].observationBasis, "verified_child_parent_turn");
  assert.equal(observed.agents[0].spawnReturned, false);
  assert.equal(observed.agents[0].completed, true);
  assert.equal(observed.agents[0].taskName, "source_only_worker");
  assert.equal(observed.agents[0].owner, "javascript-pro");
  const snapshot = buildNativeCodexLiveSnapshot(observed);
  assert.equal(snapshot.edges[0].kind, "source_parent_link");
  assert.equal(snapshot.nodes[1].provenance[0].kind, "source_parent_link");
  assert.equal(snapshot.replay.some((event) => event.type === "agent_spawned"), false);
  assert.equal(snapshot.replay.some((event) => event.type === "child_source_observed"), true);
  assert.equal(snapshot.run.executionSummary.acceptanceState, "unproven");
  assert.equal(JSON.stringify(snapshot).includes("UNTRUSTED_INDEX"), false);
  assert.ok(observed.coverage.reasons.includes("parent_dispatch_record_not_covered"));
});

test("child locator rows cannot substitute for matching native header, project and exact parent turn", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
  nativeChildHint(f);
  const file = path.join(f.day, `rollout-child-${CHILD}.jsonl`);
  const variants = [
    [meta(f.projectRoot, CHILD, OTHER), childStart(), context(f.projectRoot, OTHER)],
    [meta(path.join(f.root, "other"), CHILD, THREAD), childStart(), context(f.projectRoot, OTHER)],
    [meta(f.projectRoot, CHILD, THREAD), childStart(OTHER, 3, OTHER), context(f.projectRoot, OTHER)],
    [meta(f.projectRoot, CHILD, THREAD), { ...childStart(), payload: { ...childStart().payload, root_turn_id: OTHER } }, context(f.projectRoot, OTHER)],
    [meta(f.projectRoot, CHILD, THREAD), childStart(), context(path.join(f.root, "other"), OTHER)],
    [meta(f.projectRoot, CHILD, THREAD), context(f.projectRoot, OTHER)],
  ];
  for (const records of variants) {
    await writeFile(file, serialize(records));
    const observed = await createCodexNativeSessionReader(f.options).read();
    assert.equal(observed.agents.length, 0);
  }
});

test("a child source with a huge context still proves its exact current parent turn", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
  nativeChildHint(f);
  const metadata = meta(f.projectRoot, CHILD, THREAD);
  const prelude = serialize([metadata]);
  const giant = context(f.projectRoot, OTHER, 4);
  giant.payload.base_instructions = "x".repeat(100_000);
  await writeFile(path.join(f.day, `rollout-child-${CHILD}.jsonl`), prelude + serialize([childStart(), giant, row("event_msg", { type: "task_complete", turn_id: OTHER }, 10)]));
  nativeTurnHint(f, { thread: CHILD, turn: OTHER, offset: Buffer.byteLength(prelude) });
  const observed = await createCodexNativeSessionReader({ ...f.options, maxBytes: 32_768 }).read();
  assert.equal(observed.agents.length, 1);
  assert.equal(observed.agents[0].childMetadataVerified, true);
  assert.equal(observed.agents[0].spawnReturned, false);
  assert.equal(observed.agents[0].completed, true, "the exact terminal in the complete tail can attest return after the gap");
  assert.ok(observed.coverage.reasons.includes("child_turn_context_not_covered"));
  assert.ok(observed.coverage.bodyBytesRead <= 32_768);
});

test("a child return cannot survive later execution, a new turn or an unfinished source suffix", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
  nativeChildHint(f);
  const prelude = serialize([meta(f.projectRoot, CHILD, THREAD)]);
  nativeTurnHint(f, { thread: CHILD, turn: OTHER, offset: Buffer.byteLength(prelude) });
  const gap = JSON.stringify({ type: "compacted", payload: { text: "x".repeat(100_000) } }) + "\n";
  const beginning = prelude + serialize([childStart(), context(f.projectRoot, OTHER, 4)]) + gap;
  const terminal = row("event_msg", { type: "task_complete", turn_id: OTHER }, 10);
  const file = path.join(f.day, `rollout-child-${CHILD}.jsonl`);
  const options = { ...f.options, maxBytes: 32_768 };
  await writeFile(file, beginning + serialize([terminal]));
  assert.equal((await createCodexNativeSessionReader(options).read()).agents[0].completed, true);
  for (const suffix of [
    serialize([command(f.projectRoot, { thread: CHILD, turn: OTHER, offset: 12 })]),
    serialize([childStart(TURN, 12, TURN), context(f.projectRoot, TURN, 13)]),
    '{"type":"event_msg"',
  ]) {
    await writeFile(file, beginning + serialize([terminal]) + suffix);
    assert.equal((await createCodexNativeSessionReader(options).read()).agents[0].completed, false);
  }
  await writeFile(file, prelude + serialize([childStart(), context(f.projectRoot, OTHER, 4), terminal]) + gap + serialize([command(f.projectRoot, { thread: CHILD, turn: OTHER, offset: 20 })]));
  assert.equal((await createCodexNativeSessionReader(options).read()).agents[0].completed, false, "a prefix return cannot cross an unread gap");
});

test("a reused child's newer root task cannot hide the exact earlier parent-turn source", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
  nativeChildHint(f);
  const prelude = serialize([meta(f.projectRoot, CHILD, THREAD)]);
  const original = serialize([childStart(), context(f.projectRoot, OTHER, 4), row("event_msg", { type: "task_complete", turn_id: OTHER }, 10)]);
  const differentRoot = "55555555-5555-4555-8555-555555555555";
  const differentTurn = "66666666-6666-4666-8666-666666666666";
  await writeFile(path.join(f.day, `rollout-child-${CHILD}.jsonl`), prelude + original + serialize([childStart(differentTurn, 20, differentRoot), context(f.projectRoot, differentTurn, 21)]));
  nativeTurnHint(f, { thread: CHILD, turn: OTHER, offset: Buffer.byteLength(prelude), rootTurn: TURN, ordinal: 1 });
  nativeTurnHint(f, { thread: CHILD, turn: differentTurn, offset: Buffer.byteLength(prelude + original), rootTurn: differentRoot, ordinal: 2 });
  const hint = await locateCodexNativeTurn({ codexHome: f.codexHome, threadId: CHILD, rootTurnId: TURN });
  assert.equal(hint.turnId, OTHER);
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents.length, 1);
  assert.equal(observed.agents[0].childTurnId, OTHER);
  assert.equal(observed.agents[0].spawnReturned, false);
  assert.equal(observed.agents[0].completed, false, "later new-turn work cannot attest an old task's current return state");
});

async function indexedCompactionFixture(t) {
  const f = await fixture(t);
  const prelude = serialize([meta(f.projectRoot), context(f.projectRoot, OTHER, -10)]) + largePadding();
  const taskStart = row("event_msg", { type: "task_started", turn_id: TURN }, 0);
  const beginning = serialize([taskStart, context(f.projectRoot), ...spawn(), command(f.projectRoot)]);
  const largeCompaction = JSON.stringify({ type: "compacted", payload: { replacement_history: "x".repeat(100_000) } }) + "\n";
  const tailCommand = command(f.projectRoot, { offset: 20 });
  tailCommand.payload.item.id = "after-compaction";
  await writeFile(f.file, prelude + beginning + largeCompaction + serialize([context(f.projectRoot, TURN, 19), tailCommand]));
  const offset = Buffer.byteLength(prelude);
  const indexFile = nativeTurnHint(f, { offset });
  return { ...f, offset, indexFile, options: { ...f.options, maxBytes: 32_768 } };
}

test("an indexed source offset recovers native workers across a large compaction within the original byte budget", async (t) => {
  const f = await indexedCompactionFixture(t);
  const before = createHash("sha256").update(await readFile(f.indexFile)).digest("hex");
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.state, "observed");
  assert.equal(observed.startedAt, at());
  assert.equal(observed.agents.length, 1);
  assert.ok(observed.commands.some((item) => item.id === "after-compaction"));
  assert.ok(observed.coverage.reasons.includes("segment_middle_omitted"));
  assert.ok(observed.coverage.bodyBytesRead <= f.options.maxBytes);
  assert.ok(observed.coverage.sourceBytesRead <= observed.coverage.readByteLimit);
  assert.equal(createHash("sha256").update(await readFile(f.indexFile)).digest("hex"), before, "native index stays read-only");
});

test("indexed start records survive later compactions and unchanged reads consume no body bytes", async (t) => {
  const f = await indexedCompactionFixture(t);
  let clock = NOW;
  const reader = createCodexNativeSessionReader({ ...f.options, now: () => clock });
  assert.equal((await reader.read()).agents.length, 1);
  const later = command(f.projectRoot, { offset: 30 });
  later.payload.item.id = "later-after-compaction";
  await appendFile(f.file, JSON.stringify({ type: "compacted", payload: { text: "x".repeat(100_000) } }) + "\n" + serialize([context(f.projectRoot, TURN, 29), later]));
  clock += 1000;
  const resumed = await reader.read();
  assert.equal(resumed.agents.length, 1);
  assert.ok(resumed.commands.some((item) => item.id === "later-after-compaction"));
  clock += 1000;
  const unchanged = await reader.read();
  assert.equal(unchanged.agents.length, 1);
  assert.equal(unchanged.coverage.bodyBytesRead, 0);
});

const THIRD = "55555555-5555-4555-8555-555555555555";
const toolPair = (id, offset) => [
  row("response_item", { type: "function_call", namespace: "functions", name: "exec", call_id: id, arguments: "{}" }, offset),
  row("response_item", { type: "function_call_output", call_id: id }, offset + 1),
];
const compactPadding = (size = 40_000) => JSON.stringify({ type: "compacted", payload: { text: "x".repeat(size) } }) + "\n";

test("historical terminal offsets and latest hints keep three long turns separate in cold and warm readers", async (t) => {
  const f = await fixture(t);
  let source = serialize([meta(f.projectRoot)]);
  let clock = NOW;
  const reader = createCodexNativeSessionReader({ ...f.options, turnId: undefined, maxBytes: 16_384, now: () => clock });
  const turns = [TURN, OTHER, THIRD];
  for (const [index, turn] of turns.entries()) {
    const offset = Buffer.byteLength(source);
    source += serialize([row("event_msg", { type: "task_started", turn_id: turn }, index * 10), context(f.projectRoot, turn, index * 10 + 1), ...toolPair(`turn-${index}`, index * 10 + 2)])
      + compactPadding()
      + serialize([row("event_msg", { type: "task_complete", turn_id: turn }, index * 10 + 6)]);
    const endOffset = Buffer.byteLength(source);
    source += compactPadding();
    await writeFile(f.file, source);
    nativeTurnHint(f, { turn, offset, endOffset, ordinal: index + 1 });
    clock += 1000;
    const current = await reader.read();
    assert.equal(current.turnId, turn, "latest must rebind when the indexed turn changes");
    assert.equal(current.turnComplete, true, "a source-verified indexed end survives an unread later suffix");
    assert.deepEqual(current.pairedToolCalls.map((item) => item.id), [`turn-${index}`]);
    assert.ok(current.coverage.bodyBytesRead <= 16_384);
  }
  for (const [index, turn] of turns.entries()) {
    clock += 1000;
    const warm = await reader.readTurn(turn);
    const cold = await createCodexNativeSessionReader({ ...f.options, turnId: turn, maxBytes: 16_384 }).read();
    assert.equal(warm.turnComplete, true);
    assert.equal(cold.turnComplete, true);
    assert.equal(warm.turnCompletedAt, at(index * 10 + 6));
    assert.deepEqual(warm.pairedToolCalls.map((item) => item.id), [`turn-${index}`]);
    assert.deepEqual(cold.pairedToolCalls.map((item) => item.id), [`turn-${index}`]);
    assert.ok(warm.coverage.sourceBytesRead <= warm.coverage.readByteLimit);
  }
});

test("retaining a pinned turn start never loses the gap before a cropped later-turn window", async (t) => {
  const f = await fixture(t);
  const prelude = serialize([meta(f.projectRoot)]);
  const initial = prelude + serialize([row("event_msg", { type: "task_started", turn_id: TURN }), context(f.projectRoot), ...toolPair("old-call", 2)])
    + compactPadding(10_000) + serialize([context(f.projectRoot, OTHER, 10), ...toolPair("foreign-before-crop", 11)]);
  await writeFile(f.file, initial);
  nativeTurnHint(f, { offset: Buffer.byteLength(prelude) });
  let clock = NOW;
  const reader = createCodexNativeSessionReader({ ...f.options, maxBytes: 8192, now: () => clock });
  assert.deepEqual((await reader.read()).pairedToolCalls.map((item) => item.id), ["old-call"]);
  await appendFile(f.file, compactPadding(3700) + serialize(toolPair("foreign-after-crop", 20)));
  clock += 1000;
  const warm = await reader.read();
  assert.deepEqual(warm.pairedToolCalls.map((item) => item.id), ["old-call"], "evicting the original gap marker must not restore the old turn's attribution");
  clock += 1000;
  assert.deepEqual((await reader.read()).pairedToolCalls.map((item) => item.id), ["old-call"]);
});

test("task_started changes unbound tool attribution even when the next turn context is absent", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), ...toolPair("old-call", 2),
    row("event_msg", { type: "task_complete", turn_id: TURN }, 4),
    row("event_msg", { type: "task_started", turn_id: OTHER }, 10), ...toolPair("new-call", 11)]);
  const observation = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observation.turnComplete, true);
  assert.deepEqual(observation.pairedToolCalls.map((item) => item.id), ["old-call"]);
  const latest = await createCodexNativeSessionReader({ ...f.options, turnId: undefined }).read();
  assert.equal(latest.state, "unavailable", "missing newest-turn context must not present the old turn as current");
});

test("terminal hints are offsets only and require an exact source terminal at their boundary", async (t) => {
  const f = await fixture(t);
  const prelude = serialize([meta(f.projectRoot)]);
  const beginning = prelude + serialize([row("event_msg", { type: "task_started", turn_id: TURN }), context(f.projectRoot), ...toolPair("old-call", 2)]) + compactPadding();
  for (const terminal of [
    row("event_msg", { type: "task_complete", turn_id: OTHER }, 6),
    row("event_msg", { type: "task_complete", turn_id: TURN, thread_id: CHILD }, 6),
    row("event_msg", { type: "task_started", turn_id: TURN }, 6),
    row("response_item", { type: "message", text: "task_complete" }, 6),
  ]) {
    const end = beginning + serialize([terminal]);
    await writeFile(f.file, end + compactPadding());
    nativeTurnHint(f, { offset: Buffer.byteLength(prelude), endOffset: Buffer.byteLength(end) });
    assert.equal((await createCodexNativeSessionReader({ ...f.options, maxBytes: 16_384 }).read()).turnComplete, false);
  }
  const end = beginning + serialize([row("event_msg", { type: "task_complete", turn_id: TURN }, 6)]);
  await writeFile(f.file, end + compactPadding());
  for (const endOffset of [Buffer.byteLength(end) - 1, Buffer.byteLength(end) + 1, Number.MAX_SAFE_INTEGER]) {
    nativeTurnHint(f, { offset: Buffer.byteLength(prelude), endOffset });
    assert.equal((await createCodexNativeSessionReader({ ...f.options, maxBytes: 16_384 }).read()).turnComplete, false);
  }
});

test("indexed completion does not hide later unbound activity in the same fully read turn", async (t) => {
  const f = await fixture(t);
  const prelude = serialize([meta(f.projectRoot)]);
  const ended = prelude + serialize([row("event_msg", { type: "task_started", turn_id: TURN }), context(f.projectRoot),
    ...toolPair("initial", 2), row("event_msg", { type: "task_complete", turn_id: TURN }, 4)]);
  await writeFile(f.file, ended + serialize(toolPair("resumed", 6)));
  nativeTurnHint(f, { offset: Buffer.byteLength(prelude), endOffset: Buffer.byteLength(ended) });
  let clock = NOW;
  const reader = createCodexNativeSessionReader({ ...f.options, now: () => clock });
  const running = await reader.read();
  assert.equal(running.turnComplete, false, "the indexed terminal cannot cut an otherwise contiguous source range");
  assert.deepEqual(running.pairedToolCalls.map((item) => item.id), ["initial", "resumed"]);
  clock += 1000;
  const cached = await reader.read();
  assert.equal(cached.turnComplete, false, "cached ordinary terminal continuity survives endpoint pin refresh");
  assert.deepEqual(cached.pairedToolCalls.map((item) => item.id), ["initial", "resumed"]);
  await appendFile(f.file, serialize([row("event_msg", { type: "task_complete", turn_id: TURN }, 8)]));
  nativeTurnHint(f, { offset: Buffer.byteLength(prelude), endOffset: Buffer.byteLength(await readFile(f.file)) });
  clock += 1000;
  const completed = await reader.read();
  assert.equal(completed.turnComplete, true);
  assert.equal(completed.turnCompletedAt, at(8));
  clock += 1000;
  assert.equal((await reader.read()).coverage.bodyBytesRead, 0);
});

test("an old indexed schema without end offsets still provides bounded start hints", async (t) => {
  const f = await fixture(t);
  const db = new DatabaseSync(path.join(f.codexHome, "thread_history_1.sqlite"));
  db.exec("CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, rollout_byte_offset INTEGER, root_turn_id TEXT, PRIMARY KEY(thread_id, turn_id)); CREATE INDEX idx_native_turn_page ON thread_turns(thread_id, rollout_ordinal)");
  db.prepare("INSERT INTO thread_turns VALUES(?, ?, 1, 99, ?)").run(THREAD, TURN, TURN);
  db.close();
  assert.deepEqual(await locateCodexNativeTurn({ codexHome: f.codexHome, threadId: THREAD, turnId: TURN }), { threadId: THREAD, turnId: TURN, offset: 99 });
});

test("a changed indexed start invalidates pinned evidence even when the old tail anchor survives", async (t) => {
  const f = await indexedCompactionFixture(t);
  let clock = NOW;
  const reader = createCodexNativeSessionReader({ ...f.options, now: () => clock });
  assert.equal((await reader.read()).agents.length, 1);
  const bytes = await readFile(f.file);
  const replacement = Buffer.from(bytes);
  const turnOffset = replacement.indexOf(Buffer.from(TURN), f.offset);
  replacement.write(OTHER, turnOffset, "utf8");
  await writeFile(f.file, replacement);
  await appendFile(f.file, serialize([command(f.projectRoot, { offset: 40 })]));
  clock += 1000;
  const changed = await reader.read();
  assert.equal(changed.state, "observed");
  assert.equal(changed.agents.length, 0, "a surviving tail cannot attest a changed turn start");
});

test("index hints cannot import a stale or forged turn offset and missing indexes keep the bounded tail", async (t) => {
  const f = await indexedCompactionFixture(t);
  for (const offset of [f.offset + 1, Number.MAX_SAFE_INTEGER]) {
    nativeTurnHint(f, { offset });
    const observed = await createCodexNativeSessionReader(f.options).read();
    assert.equal(observed.state, "observed");
    assert.equal(observed.agents.length, 0);
    assert.ok(observed.commands.some((item) => item.id === "after-compaction"));
    assert.ok(observed.coverage.bodyBytesRead <= f.options.maxBytes);
  }
  await writeFile(f.indexFile, "not a SQLite database");
  assert.equal(await locateCodexNativeTurn({ codexHome: f.codexHome, threadId: THREAD, turnId: TURN }), null);
  assert.equal((await createCodexNativeSessionReader(f.options).read()).agents.length, 0);
});

test("a source gap cannot attribute another turn's unbound spawn to the indexed turn", async (t) => {
  const f = await indexedCompactionFixture(t);
  const foreign = spawn().map((record) => structuredClone(record));
  for (const record of foreign) {
    record.timestamp = at(40);
    const p = record.payload;
    if (p.call_id) p.call_id = "foreign-spawn";
    if (p.item) { p.item.id = "foreign-spawn"; p.thread_id = THREAD; p.turn_id = TURN; }
  }
  await appendFile(f.file, JSON.stringify({ type: "compacted", payload: { text: "x".repeat(100_000) } }) + "\n" + serialize(foreign));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.deepEqual(observed.agents.map((item) => item.id), ["call-spawn-1"]);
});

test("the native index remains a locator rather than a replacement for source project and thread metadata", async (t) => {
  const f = await indexedCompactionFixture(t);
  const bytes = await readFile(f.file, "utf8");
  await writeFile(f.file, bytes.replace(JSON.stringify(f.projectRoot), JSON.stringify(path.join(f.root, "other"))));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.state, "unavailable");
  assert.equal(observed.reason, "exact_native_turn_not_observed");
});

test("index hints can select the latest exact source turn without making a thread-only launch current", async (t) => {
  const f = await indexedCompactionFixture(t);
  const options = { ...f.options, turnId: undefined };
  assert.equal((await createCodexNativeSessionReader(options).read()).agents.length, 1);
  assert.equal(await resolveNativeCodexCurrentRun(options), null);
});

test("an indexed child's complete own turn can return without reading copied pre-turn history", async (t) => {
  const f = await indexedCompactionFixture(t);
  const prelude = serialize([meta(f.projectRoot, CHILD, THREAD)]) + largePadding();
  const file = path.join(f.day, `rollout-child-${CHILD}.jsonl`);
  await writeFile(file, prelude + serialize([childStart(), context(f.projectRoot, OTHER, 4), row("event_msg", { type: "task_complete", turn_id: OTHER }, 10)]));
  nativeTurnHint(f, { thread: CHILD, turn: OTHER, offset: Buffer.byteLength(prelude) });
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].childMetadataVerified, true);
  assert.equal(observed.agents[0].completed, true);
  assert.ok(observed.coverage.reasons.includes("pre_turn_history_omitted"));
  assert.equal(buildNativeCodexLiveSnapshot(observed).run.executionSummary.acceptanceState, "unproven");
  assert.ok(observed.coverage.bodyBytesRead <= f.options.maxBytes);
});

test("native offset lookup refuses an unindexed schema and multiply linked database", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.codexHome, "thread_history_1.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_byte_offset INTEGER, rollout_ordinal INTEGER)");
  db.prepare("INSERT INTO thread_turns VALUES (?, ?, 100, 1)").run(THREAD, TURN);
  db.close();
  const options = { codexHome: f.codexHome, threadId: THREAD, turnId: TURN };
  assert.equal(await locateCodexNativeTurn(options), null, "a schema without a point-lookup index cannot trigger a full-table scan");
  await rm(file);
  nativeTurnHint(f, { offset: 100 });
  await link(file, path.join(f.root, "database-alias.sqlite"));
  assert.equal(await locateCodexNativeTurn(options), null);
});

test("a locked native index quickly yields to ordinary source observation", async (t) => {
  const f = await indexedCompactionFixture(t);
  const writer = new DatabaseSync(f.indexFile);
  writer.exec("BEGIN EXCLUSIVE");
  try {
    const started = performance.now();
    assert.equal(await locateCodexNativeTurn({ codexHome: f.codexHome, threadId: THREAD, turnId: TURN }), null);
    assert.ok(performance.now() - started < 2_000, "the optional index must not block on a native writer");
  } finally { writer.exec("ROLLBACK"); writer.close(); }
});

test("a thread-only launch cannot promote an older observed turn to the current task", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot), row("event_msg", { type: "task_complete", turn_id: TURN }, 10)]);
  const threadOnly = { ...f.options, turnId: undefined };
  const oldObservation = await createCodexNativeSessionReader(threadOnly).read();
  assert.equal(oldObservation.state, "observed");
  assert.equal(oldObservation.turnComplete, true);
  const runId = await resolveNativeCodexCurrentRun(threadOnly);
  assert.equal(runId, null);
  const presentation = liveCurrentRunPresentation({ runId, nativeBinding: threadOnly, deepLink: "http://127.0.0.1:4331/?projectId=fixture" });
  assert.equal(presentation.currentRunState, "awaiting_native_turn");
  assert.equal(presentation.currentTaskLink, null);
  assert.equal(presentation.autoOpenAllowed, false);
  assert.equal(await resolveNativeCodexCurrentRun(f.options), `native-codex-${THREAD}-${TURN}`, "an explicit exact turn remains selectable");
  assert.equal(await resolveNativeCodexCurrentRun({ ...f.options, turnId: OTHER }), null);
  // Even an unterminated old turn is not proof that it belongs to this launch.
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
  assert.equal(await resolveNativeCodexCurrentRun(threadOnly), null);
});

test("resumed UUIDv7 chats read the creation-day file without expanding the event or byte window", async (t) => {
  const f = await fixture(t);
  const createdMs = SINCE - 4 * 86_400_000;
  const stamp = createdMs.toString(16).padStart(12, "0");
  const thread = `${stamp.slice(0, 8)}-${stamp.slice(8)}-7000-8000-111111111111`;
  // Some hosts put the UTC creation instant in the next local calendar day.
  const creationDay = new Date(createdMs + 86_400_000).toISOString().slice(0, 10).split("-");
  const directory = path.join(f.codexHome, "sessions", ...creationDay);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-created-earlier-${thread}.jsonl`);
  const staleContext = context(f.projectRoot, OTHER, -3 * 86_400_000);
  await writeFile(file, serialize([meta(f.projectRoot, thread), staleContext]) + largePadding() + serialize([
    context(f.projectRoot), command(f.projectRoot, { thread }),
  ]));
  const options = { ...f.options, threadId: thread, maxBytes: 4_096 };
  const reader = createCodexNativeSessionReader(options);
  const observed = await reader.read();
  assert.equal(observed.state, "observed");
  assert.equal(observed.turnId, TURN);
  assert.equal(observed.commands.length, 1);
  assert.equal(observed.coverage.parentSegmentCount, 1);
  assert.ok(observed.coverage.bodyBytesRead <= options.maxBytes);
  assert.ok(observed.coverage.sourceBytesRead <= observed.coverage.readByteLimit);
  assert.equal((await createCodexNativeSessionReader({ ...options, turnId: OTHER }).read()).reason, "exact_native_turn_not_observed");
});

test("UUIDv7 creation-day hints do not trust mismatched headers or projects", async (t) => {
  const f = await fixture(t);
  const createdMs = SINCE - 4 * 86_400_000;
  const stamp = createdMs.toString(16).padStart(12, "0");
  const thread = `${stamp.slice(0, 8)}-${stamp.slice(8)}-7000-8000-111111111111`;
  const directory = path.join(f.codexHome, "sessions", ...new Date(createdMs).toISOString().slice(0, 10).split("-"));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `rollout-wrong-thread-${thread}.jsonl`), serialize([
    meta(f.projectRoot, OTHER), context(f.projectRoot), command(f.projectRoot, { thread }),
  ]));
  await writeFile(path.join(directory, `rollout-wrong-project-${thread}.jsonl`), serialize([
    meta(path.join(f.root, "other"), thread), context(f.projectRoot), command(f.projectRoot, { thread }),
  ]));
  const observed = await createCodexNativeSessionReader({ ...f.options, threadId: thread }).read();
  assert.equal(observed.state, "unavailable");
  assert.equal(observed.reason, "exact_native_turn_not_observed");
  assert.equal(observed.coverage.parentSegmentCount, 2);
  assert.equal(observed.coverage.bodyBytesRead, 0);
});

test("Desktop command file URLs bind only to the same local project", async (t) => {
  const f = await fixture(t, "Project with spaces");
  const sameProject = pathToFileURL(f.projectRoot).href;
  const sources = [sameProject, pathToFileURL(path.join(f.root, "other")).href,
    `${sameProject}?untrusted=1`, `${sameProject}#fragment`, "file://remote.example/project", "../Project with spaces"];
  const events = sources.map((cwd, index) => {
    const event = command(cwd, { offset: 2 + index });
    event.payload.item.id = `file-cwd-${index}`;
    return event;
  });
  await f.write([meta(f.projectRoot), context(f.projectRoot), ...events]);
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.deepEqual(observed.commands.map((item) => item.id), ["file-cwd-0"]);
  assert.equal(Object.hasOwn(observed.commands[0], "cwd"), false);
  const serialized = JSON.stringify(buildNativeCodexLiveSnapshot(observed));
  assert.equal(serialized.includes(sameProject), false);
});

test("large valid sessions use a bounded tail then zero-body-cache and append-only reads", async (t) => {
  const f = await fixture(t);
  let clock = NOW;
  const options = { ...f.options, maxBytes: 4096, now: () => clock };
  await writeFile(f.file, serialize([meta(f.projectRoot)]) + largePadding() + serialize([context(f.projectRoot), command(f.projectRoot)]));
  const before = createHash("sha256").update(await readFile(f.file)).digest("hex");
  const reader = createCodexNativeSessionReader(options);
  const initial = await reader.read();
  assert.equal(initial.state, "observed");
  assert.equal(initial.commands.length, 1);
  assert.equal(initial.coverage.state, "partial");
  assert.ok(initial.coverage.reasons.includes("segment_prefix_omitted"));
  assert.ok(initial.coverage.bodyBytesRead <= options.maxBytes);
  assert.ok(initial.coverage.sourceBytesRead <= initial.coverage.readByteLimit);
  assert.equal(createHash("sha256").update(await readFile(f.file)).digest("hex"), before);
  clock += 1000;
  const unchanged = await reader.read();
  assert.equal(unchanged.coverage.bodyBytesRead, 0);
  assert.equal(unchanged.coverage.cachedSegmentCount, 1);
  assert.ok(unchanged.coverage.sourceBytesRead < 2048);
  const added = command(f.projectRoot, { offset: 20 });
  added.payload.item.id = "appended-command";
  const bytes = serialize([added]);
  await appendFile(f.file, bytes);
  clock += 1000;
  const incremental = await reader.read();
  assert.equal(incremental.commands.length, 2);
  assert.equal(incremental.coverage.bodyBytesRead, Buffer.byteLength(bytes));
  assert.ok(incremental.coverage.sourceBytesRead < 2048);
});

test("a large tail without the exact turn context remains unavailable", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, serialize([meta(f.projectRoot), context(f.projectRoot)]) + largePadding() + serialize([command(f.projectRoot)]));
  const observed = await createCodexNativeSessionReader({ ...f.options, maxBytes: 4096 }).read();
  assert.equal(observed.state, "unavailable");
  assert.equal(observed.reason, "exact_native_turn_not_observed");
  assert.ok(observed.coverage.reasons.includes("segment_prefix_omitted"));
});

test("an omitted prefix cannot inherit another segment's active-turn attribution", async (t) => {
  const f = await fixture(t);
  let clock = NOW;
  await writeFile(path.join(f.day, "rollout-0000-" + THREAD + ".jsonl"), serialize([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]));
  await writeFile(f.file, serialize([meta(f.projectRoot)]) + largePadding() + serialize([
    row("response_item", { type: "function_call", call_id: "unbound-tail", name: "exec", namespace: "functions", arguments: "{}" }, 20),
    row("response_item", { type: "function_call_output", call_id: "unbound-tail" }, 21),
  ]));
  const reader = createCodexNativeSessionReader({ ...f.options, maxBytes: 4096, now: () => clock });
  const first = await reader.read();
  assert.ok(first.coverage.sourceBytesRead <= first.coverage.readByteLimit);
  clock += 1000;
  const observed = await reader.read();
  assert.equal(observed.state, "observed");
  assert.equal(observed.commands.length, 1);
  assert.equal(observed.pairedToolCalls.length, 0, "a gap resets inherited activeTurn");
  assert.equal(observed.coverage.state, "partial");
});

test("UTF-8 partial append waits for its entire JSON line without replaying prior events", async (t) => {
  const f = await fixture(t);
  let clock = NOW;
  await writeFile(f.file, serialize([meta(f.projectRoot)]) + largePadding() + serialize([context(f.projectRoot), command(f.projectRoot)]));
  const reader = createCodexNativeSessionReader({ ...f.options, maxBytes: 4096, now: () => clock });
  await reader.read();
  const added = command(f.projectRoot, { offset: 20 });
  added.payload.item.id = "utf8-append";
  added.payload.item.command = "中间截断";
  const line = Buffer.from(serialize([added]));
  const split = line.indexOf(Buffer.from("中")) + 1;
  await appendFile(f.file, line.subarray(0, split));
  clock += 1000;
  const partial = await reader.read();
  assert.equal(partial.commands.length, 1);
  assert.ok(partial.coverage.reasons.includes("partial_final_line"));
  await appendFile(f.file, line.subarray(split));
  clock += 1000;
  const complete = await reader.read();
  assert.equal(complete.commands.length, 2);
  assert.equal(complete.coverage.reasons.includes("partial_final_line"), false);
  assert.equal(complete.commands.filter((item) => item.id === "utf8-append").length, 1);
});

test("cached large sessions reject changed header/cwd and rebuild after truncation or tail-anchor drift", async (t) => {
  const f = await fixture(t);
  let clock = NOW;
  const reader = createCodexNativeSessionReader({ ...f.options, maxBytes: 4096, now: () => clock });
  const valid = serialize([meta(f.projectRoot)]) + largePadding() + serialize([context(f.projectRoot), command(f.projectRoot)]);
  await writeFile(f.file, valid);
  assert.equal((await reader.read()).state, "observed");
  await writeFile(f.file, serialize([meta(f.projectRoot)]) + largePadding() + serialize([context(path.join(f.projectRoot, "other")), command(f.projectRoot), command(f.projectRoot, { offset: 30 })]));
  clock += 1000;
  assert.equal((await reader.read()).reason, "native_turn_project_binding_unproven");
  await writeFile(f.file, serialize([meta(f.projectRoot), context(f.projectRoot)]));
  clock += 1000;
  const truncated = await reader.read();
  assert.equal(truncated.state, "observed");
  assert.equal(truncated.commands.length, 0);
  await writeFile(f.file, serialize([meta(path.join(f.root, "wrong"))]) + largePadding() + serialize([context(f.projectRoot), command(f.projectRoot)]));
  clock += 1000;
  const wrongHeader = await reader.read();
  assert.equal(wrongHeader.state, "unavailable");
  assert.equal(wrongHeader.coverage.bodyBytesRead, 0, "reject metadata before parsing a tail");
});

test("reads bound native command events without raw commands, paths, output or acceptance promotion", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot, { exitCode: 2 }), ...spawn()]);
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
  await f.write([meta(f.projectRoot), context(f.projectRoot), ...spawn()]);
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].spawnReturned, true);
  assert.equal(observed.agents[0].completed, false);
  assert.equal(buildNativeCodexLiveSnapshot(observed).nodes[1].active, false);
});

test("native projection gives unknown owners a numbered subtask caption and bounded alias details", () => {
  const snapshot = buildNativeCodexLiveSnapshot({ state: "observed", binding: { projectRootMatched: true }, threadId: THREAD, turnId: TURN,
    startedAt: at(), observedAt: at(20), turnComplete: false,
    agents: [{ id: "opaque-dispatch", owner: "unknown-specialist", role: "worker", taskName: "internal_alias_".repeat(40), at: at(2), sha256: "a".repeat(64) }] });
  const node = snapshot.nodes[1];
  assert.equal(liveTaskDisplayLabel(node, "zh"), "子任务 1");
  assert.equal(liveTaskDisplayLabel(node, "en"), "Subtask 1");
  assert.equal(node.ownerAgent, "unknown-specialist");
  assert.equal(node.roleDisplayName, "worker");
  assert.match(node.summary, /任务说明未记录/u);
  assert.ok(snapshot.provenance[0].reasoningExcerpt.length < 160);
  assert.equal(snapshot.provenance[0].nodeId, node.id);
  assert.equal(snapshot.run.executionSummary.returnedAgentCount, 0);
  assert.equal(resolveLiveTaskLifecycle(node, snapshot.run.runId).state, "in_progress");
});

test("paired parent spawn plus exact child parent metadata and terminal event yields returned, never accepted", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), ...spawn()]);
  const child = path.join(f.day, `rollout-2026-10-21T16-00-00-${CHILD}.jsonl`);
  await writeFile(child, serialize([meta(f.projectRoot, CHILD, THREAD), childStart(), context(f.projectRoot, OTHER, 3), row("event_msg", { type: "task_complete", turn_id: OTHER, last_agent_message: "PRIVATE RESULT" }, 10)]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].completed, true);
  const snapshot = buildNativeCodexLiveSnapshot(observed);
  const node = snapshot.nodes[1];
  assert.equal(node.status, "in_doubt");
  assert.equal(node.executionState, "executed");
  assert.equal(node.active, false);
  assert.equal(node.terminalEvidence.length, 0);
  assert.deepEqual(resolveLiveTaskLifecycle(node, snapshot.run.runId), { state: "completed", detail: "result_unconfirmed" });
  assert.equal(snapshot.session.completedCount, 0);
  assert.equal(snapshot.run.completionEvidenceState, "unproven");
  assert.equal(snapshot.run.executionSummary.acceptanceState, "unproven");
  assert.equal(node.nativeInvocationVerified, undefined);
  assert.equal(node.nativeTaskCaption, "javascript-pro");
  assert.equal(node.nativeTaskOrdinal, 1);
  assert.equal(liveTaskDisplayLabel(node, "zh"), "代码实现 1");
  assert.equal(liveTaskDisplayLabel(node, "en"), "Code implementation 1");
  assert.notEqual(node.task, "native_backend");
  assert.match(snapshot.provenance.find((item) => item.nodeId === node.id).reasoningExcerpt, /native_backend.*源记录未提供任务说明/u);
  assert.equal(node.ownerAgent, "javascript-pro");
});

test("wrong child parent and unpaired parent spawn cannot mint a returned worker", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), ...spawn()]);
  await writeFile(path.join(f.day, `rollout-${CHILD}.jsonl`), serialize([meta(f.projectRoot, CHILD, OTHER), row("event_msg", { type: "task_complete" }, 10)]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].completed, false);
  await f.write([meta(f.projectRoot), context(f.projectRoot), spawn()[0], spawn()[2]]);
  assert.equal((await createCodexNativeSessionReader(f.options).read()).agents.length, 0);
});

test("cross-thread, cross-turn and cross-project commands do not join the bound turn", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot, { thread: OTHER }), command(f.projectRoot, { turn: OTHER }), command(path.join(f.root, "other"))]);
  assert.equal((await createCodexNativeSessionReader(f.options).read()).commands.length, 0);
  await f.write([meta(path.join(f.root, "other")), context(f.projectRoot), command(f.projectRoot)]);
  assert.equal((await createCodexNativeSessionReader(f.options).read()).state, "unavailable");
});

test("resume file names need not equal thread id; oversized old segment and partial final append are ignored", async (t) => {
  const f = await fixture(t);
  const old = path.join(f.day, `rollout-2026-10-21T01-00-00-${THREAD}.jsonl`);
  await writeFile(old, "x".repeat(4_096));
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
  await appendFile(f.file, '{"type":"event_msg","payload":');
  const before = createHash("sha256").update(await readFile(f.file)).digest("hex");
  const observed = await createCodexNativeSessionReader({ ...f.options, maxBytes: 3_072 }).read();
  assert.equal(observed.state, "observed");
  assert.equal(observed.commands.length, 1);
  assert.equal(createHash("sha256").update(await readFile(f.file)).digest("hex"), before);
});

test("latest follows only the bound thread while explicit old-turn reads remain stable", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot), context(f.projectRoot, OTHER, 10), command(f.projectRoot, { turn: OTHER, offset: 11 })]);
  const reader = createCodexNativeSessionReader({ ...f.options, turnId: undefined });
  assert.equal((await reader.read()).turnId, OTHER);
  assert.equal((await reader.readTurn(TURN)).turnId, TURN);
  await assert.rejects(createCodexNativeSessionReader(f.options).readTurn(OTHER), /native_session_turn_not_bound/u);
});

test("zero-event native turn does not claim execution or task completion", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot)]);
  const snapshot = buildNativeCodexLiveSnapshot(await createCodexNativeSessionReader(f.options).read());
  assert.equal(snapshot.counts.executionEvidence, 0);
  assert.equal(snapshot.nodes[0].executionObserved, false);
  assert.equal(snapshot.nodes[0].executionState, "not_observed");
  assert.equal(snapshot.run.executionEvidenceState, "not_observed");
  assert.equal(snapshot.run.active, false);
});

test("later child follow-up completion cannot finish an older parent turn", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), ...spawn(), row("event_msg", { type: "task_complete" }, 7)]);
  await writeFile(path.join(f.day, `rollout-${CHILD}.jsonl`), serialize([meta(f.projectRoot, CHILD, THREAD), childStart(), context(f.projectRoot, OTHER, 3), context(f.projectRoot, TURN, 9), row("event_msg", { type: "task_complete", turn_id: TURN }, 10)]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].completed, false);
});

test("copied parent task_complete cannot finish a currently running child turn", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), ...spawn()]);
  await writeFile(path.join(f.day, `rollout-${CHILD}.jsonl`), serialize([
    meta(f.projectRoot, CHILD, THREAD), context(f.projectRoot, TURN, 2),
    row("event_msg", { type: "task_complete", turn_id: TURN }, 3),
    childStart(OTHER, 4), context(f.projectRoot, OTHER, 4), command(f.projectRoot, { thread: CHILD, turn: OTHER, offset: 6 }),
  ]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].childMetadataVerified, true);
  assert.equal(observed.agents[0].childTurnId, OTHER);
  assert.equal(observed.agents[0].completed, false);
});

test("new same-parent child follow-up or later same-turn tool activity invalidates a prior return", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), ...spawn()]);
  const file = path.join(f.day, `rollout-${CHILD}.jsonl`);
  await writeFile(file, serialize([
    meta(f.projectRoot, CHILD, THREAD), childStart(), context(f.projectRoot, OTHER, 3),
    row("event_msg", { type: "task_complete", turn_id: OTHER }, 6),
    command(f.projectRoot, { thread: CHILD, turn: OTHER, offset: 7 }),
  ]));
  assert.equal((await createCodexNativeSessionReader(f.options).read()).agents[0].completed, false);
  await appendFile(file, serialize([childStart(TURN, 9), context(f.projectRoot, TURN, 9)]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].childTurnId, TURN);
  assert.equal(observed.agents[0].completed, false);
});

test("newer active child resume segments cannot be overwritten by an older returned turn", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), ...spawn()]);
  const newerTurn = "55555555-5555-4555-8555-555555555555";
  await writeFile(path.join(f.day, `rollout-2026-10-21T16-00-00-${CHILD}.jsonl`), serialize([
    meta(f.projectRoot, CHILD, THREAD), childStart(OTHER, 7), context(f.projectRoot, OTHER, 8),
    row("event_msg", { type: "task_complete", turn_id: OTHER }, 10),
  ]));
  const resumed = path.join(f.day, `rollout-2026-10-21T16-01-00-${CHILD}_segment.jsonl`);
  await writeFile(resumed, serialize([
    meta(f.projectRoot, CHILD, THREAD), childStart(newerTurn, 12), context(f.projectRoot, newerTurn, 13),
    command(f.projectRoot, { thread: CHILD, turn: newerTurn, offset: 14 }),
  ]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].childTurnId, newerTurn);
  assert.equal(observed.agents[0].completed, false);
  assert.equal(buildNativeCodexLiveSnapshot(observed).nodes[1].active, false);
  // A continuation of the same attributed turn also supersedes its old return.
  await writeFile(resumed, serialize([
    meta(f.projectRoot, CHILD, THREAD), childStart(OTHER, 7), context(f.projectRoot, OTHER, 13),
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
    await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot), terminal, subsequent]);
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
  await f.write([meta(f.projectRoot), context(f.projectRoot), started, command(f.projectRoot), context(f.projectRoot, TURN, 10)]);
  assert.equal((await createCodexNativeSessionReader(f.options).read()).startedAt, at(2));
  await writeFile(path.join(f.day, `rollout-2026-10-21T16-01-00-${THREAD}.jsonl`), serialize([
    meta(f.projectRoot), context(f.projectRoot, TURN, 12),
    row("event_msg", { type: "task_started", turn_id: TURN }, 13), command(f.projectRoot, { offset: 14 }),
  ]));
  const resumed = await createCodexNativeSessionReader(f.options).read();
  assert.equal(resumed.startedAt, at(2));
  assert.equal(buildNativeCodexLiveSnapshot(resumed).run.startedAt, at(2));
  // Without task_started, use the earliest available context rather than resume time.
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
  await writeFile(path.join(f.day, `rollout-2026-10-21T16-01-00-${THREAD}.jsonl`), serialize([meta(f.projectRoot), context(f.projectRoot, TURN, 12), command(f.projectRoot, { offset: 14 })]));
  assert.equal((await createCodexNativeSessionReader(f.options).read()).startedAt, at(1));
});

test("exact parent resume segments retain earlier execution and deduplicate copied terminals before resumed activity", async (t) => {
  const f = await fixture(t);
  const first = command(f.projectRoot);
  const terminal = row("event_msg", { type: "task_complete", turn_id: TURN }, 7);
  await f.write([meta(f.projectRoot), context(f.projectRoot), first, ...spawn(), terminal]);
  const second = command(f.projectRoot, { offset: 14 });
  second.payload.item.id = "exec-native-2";
  const resumed = path.join(f.day, `rollout-2026-10-21T16-01-00-${THREAD}.jsonl`);
  await writeFile(resumed, serialize([meta(f.projectRoot), context(f.projectRoot), first, terminal, context(f.projectRoot, TURN, 12), second]));
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
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
  const foreign = command(f.projectRoot, { turn: OTHER, offset: 15 });
  foreign.payload.item.id = "foreign-command";
  await writeFile(path.join(f.day, `rollout-foreign-project-${THREAD}.jsonl`), serialize([meta(path.join(f.root, "other")), context(f.projectRoot, TURN, 12), foreign]));
  await writeFile(path.join(f.day, `rollout-foreign-thread-${THREAD}.jsonl`), serialize([meta(f.projectRoot, OTHER), context(f.projectRoot, TURN, 12), foreign]));
  await writeFile(path.join(f.day, `rollout-other-turn-${THREAD}.jsonl`), serialize([meta(f.projectRoot), context(f.projectRoot, OTHER, 12), foreign]));
  const observed = await createCodexNativeSessionReader(f.options).read();
  assert.deepEqual(observed.commands.map((item) => item.id), ["exec-native-1"]);
  assert.equal(observed.turnId, TURN);
});

test("an exact child start and return can span resume segments without promoting user acceptance", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), ...spawn(), command(f.projectRoot, { exitCode: 2 })]);
  await writeFile(path.join(f.day, `rollout-a-${CHILD}.jsonl`), serialize([meta(f.projectRoot, CHILD, THREAD), childStart(), context(f.projectRoot, OTHER, 3)]));
  await writeFile(path.join(f.day, `rollout-b-${CHILD}.jsonl`), serialize([meta(f.projectRoot, CHILD, THREAD), context(f.projectRoot, OTHER, 8), row("event_msg", { type: "task_complete", turn_id: OTHER, last_agent_message: "PRIVATE RESULT" }, 10)]));
  const observation = await createCodexNativeSessionReader(f.options).read();
  assert.equal(observation.agents[0].completed, true);
  const snapshot = buildNativeCodexLiveSnapshot(observation);
  assert.deepEqual(snapshot.run.executionSummary, { observedAgentCount: 1, returnedAgentCount: 1, unconfirmedAgentCount: 0, returnedToolCount: 1, failedToolCount: 1, acceptanceState: "unproven" });
  assert.deepEqual(snapshot.session.executionSummary, snapshot.run.executionSummary);
  assert.equal(snapshot.session.completedCount, 0);
  assert.equal(snapshot.run.completionEvidenceState, "unproven");
  assert.equal(snapshot.nodes[1].status, "in_doubt");
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE RESULT"), false);
});

test("malformed large parent and child headers remain untrusted and leave completion unconfirmed", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), ...spawn(), command(f.projectRoot)]);
  await writeFile(path.join(f.day, `rollout-large-${THREAD}.jsonl`), "x".repeat(4_096));
  await writeFile(path.join(f.day, `rollout-a-${CHILD}.jsonl`), serialize([meta(f.projectRoot, CHILD, THREAD), childStart(), context(f.projectRoot, OTHER, 3), row("event_msg", { type: "task_complete", turn_id: OTHER }, 10)]));
  await writeFile(path.join(f.day, `rollout-b-${CHILD}.jsonl`), "x".repeat(4_096));
  const observation = await createCodexNativeSessionReader({ ...f.options, maxBytes: 3_072 }).read();
  assert.equal(observation.coverage.state, "partial");
  assert.deepEqual(observation.coverage.reasons, ["segment_metadata_unavailable"]);
  assert.equal(observation.agents[0].completed, false, "an omitted child continuation leaves its current return unconfirmed");
  const snapshot = buildNativeCodexLiveSnapshot(observation);
  assert.equal(snapshot.source.coverage.state, "partial");
  assert.equal(snapshot.run.executionSummary.returnedAgentCount, 0);
  assert.equal(snapshot.run.executionSummary.unconfirmedAgentCount, 1);
  assert.equal(snapshot.nodes[1].active, false);
  assert.equal(snapshot.nodes[1].executionState, "unknown");
  assert.equal(snapshot.run.completionEvidenceState, "unproven");
  assert.ok(snapshot.source.limitations.some((item) => item.includes("partial observations")));
});

test("multiply linked source is rejected even when file symlinks are unavailable", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "outside.jsonl");
  await writeFile(target, serialize([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]));
  await link(target, f.file);
  await assert.rejects(createCodexNativeSessionReader(f.options).read(), /native_session_file_rejected/u);
});

test("symbolic links and multiply linked source files fail closed", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "outside.jsonl");
  await writeFile(target, serialize([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]));
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

test("native wrapper keeps distinct POSIX case-sensitive project roots isolated", { skip: process.platform === "win32" ? "Windows path identity is case-insensitive" : false }, async (t) => {
  const f = await fixture(t, "ProjectCase");
  const otherProject = path.join(f.root, "projectcase");
  await mkdir(otherProject, { recursive: true });
  if (await realpath(otherProject) === await realpath(f.projectRoot)) {
    t.skip("host filesystem does not distinguish case-only directory names");
    return;
  }
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
  const baseSnapshot = { run: { runId: "other-project-run" }, source: "other-project" };
  const calls = [];
  const base = { async getSnapshot(runId) { calls.push(runId); return baseSnapshot; } };
  const controller = createLiveControlRoomServer({ projectRoot: otherProject, nativeCodex: f.options, service: base });
  assert.deepEqual(await controller.service.getSnapshot(), baseSnapshot);
  assert.deepEqual(calls, [undefined], "another project's request must reach its own base service");
});

test("native wrapper accepts mixed-case paths with spaces and preserves ordinary service arguments", async (t) => {
  const f = await fixture(t, "MixedCase Project");
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
  const calls = [];
  const base = Object.fromEntries(["getSnapshot", "getReplay", "getDeliverable", "getShare"].map((name) => [name, async (...args) => { calls.push([name, ...args]); return { source: name }; }]));
  const controller = createLiveControlRoomServer({ projectRoot: f.projectRoot, nativeCodex: f.options, service: base });
  assert.equal(createCodexNativeSessionReader(f.options).projectRoot, f.projectRoot);
  const native = await controller.service.getSnapshot();
  assert.equal(native.run.runId, `native-codex-${THREAD}-${TURN}`);
  assert.equal(native.counts.executionEvidence, 1);
  assert.deepEqual(calls, []);
  const runId = "Run-MiXeD_Case-123";
  const deliverableId = "Folder/MixedCase File.md";
  const shareRequest = { runId, path: path.join(f.projectRoot, "Assets", "MixedCase File.md"), args: ["--Service", "BackEnd"] };
  await controller.service.getSnapshot(runId);
  await controller.service.getReplay(runId);
  await controller.service.getDeliverable(runId, deliverableId);
  await controller.service.getShare(shareRequest);
  assert.deepEqual(calls, [["getSnapshot", runId], ["getReplay", runId], ["getDeliverable", runId, deliverableId], ["getShare", shareRequest]]);
  assert.equal(calls[3][1], shareRequest, "base request object is forwarded unchanged");
});

test("native wrapper accepts a Windows case-only alias for the same project", { skip: process.platform !== "win32" ? "Windows-only path alias behavior" : false }, async (t) => {
  const f = await fixture(t, "MixedCase Project");
  const alias = f.projectRoot.toUpperCase();
  assert.notEqual(alias, f.projectRoot);
  assert.equal((await realpath(alias)).toLowerCase(), (await realpath(f.projectRoot)).toLowerCase());
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
  let baseCalls = 0;
  const controller = createLiveControlRoomServer({ projectRoot: alias, nativeCodex: f.options, service: { async getSnapshot() { baseCalls += 1; return null; } } });
  assert.equal((await controller.service.getSnapshot()).counts.executionEvidence, 1);
  assert.equal(baseCalls, 0);
});

test("native UUID bindings remain case-insensitive without changing the project path", async (t) => {
  const f = await fixture(t, "MixedCase Project");
  const threadId = "abcdefab-abcd-4abc-8def-abcdefabcdef";
  const turnId = "feedabcd-abcd-4abc-8def-feedabcdefab";
  await writeFile(path.join(f.day, `rollout-${threadId}_segment.jsonl`), serialize([meta(f.projectRoot, threadId), context(f.projectRoot, turnId), command(f.projectRoot, { thread: threadId, turn: turnId })]));
  const args = parseArgs(["--observe-codex-thread", threadId.toUpperCase(), "--observe-codex-turn", turnId.toUpperCase()]);
  const binding = nativeCodexStartupBinding(args, f.projectRoot, {});
  assert.deepEqual(binding, { projectRoot: f.projectRoot, threadId, turnId });
  const nativeCodex = { ...f.options, threadId: threadId.toUpperCase(), turnId: turnId.toUpperCase() };
  const reader = createCodexNativeSessionReader(nativeCodex);
  assert.equal(reader.projectRoot, f.projectRoot);
  assert.equal(reader.threadId, threadId);
  assert.equal((await reader.readTurn(turnId.toUpperCase())).state, "observed");
  const controller = createLiveControlRoomServer({ projectRoot: f.projectRoot, nativeCodex, service: { async getSnapshot() { throw new Error("unexpected base service call"); } } });
  const snapshot = await controller.service.getSnapshot(`native-codex-${threadId}-${turnId}`);
  assert.equal(snapshot.run.runId, `native-codex-${threadId}-${turnId}`);
  assert.equal(snapshot.counts.executionEvidence, 1);
});

test("trusted native observed run joins existing hub catalog and snapshot without rewriting planning history", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
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
  await f.write([meta(f.projectRoot), context(f.projectRoot), command(f.projectRoot)]);
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

test("review regression C3 missing child return is unconfirmed rather than active", async (t) => {
  const f = await fixture(t);
  await f.write([meta(f.projectRoot), row("turn_context", { turn_id: TURN, cwd: f.projectRoot }, 1), ...spawn(), row("event_msg", { type: "task_complete", turn_id: TURN }, 10)]);
  const snapshot = buildNativeCodexLiveSnapshot(await createCodexNativeSessionReader(f.options).read());
  assert.equal(snapshot.run.executionSummary.unconfirmedAgentCount, 1);
  assert.equal(snapshot.run.executionSummary.activeAgentCount, undefined);
  assert.equal(snapshot.nodes[1].active, false);
  assert.equal(snapshot.nodes[1].status, "in_doubt");
  assert.notEqual(snapshot.nodes[1].executionState, "executing");
});

test("review regression S5 parent turn cwd must bind ordinary paired tools to this project", async (t) => {
  const f = await fixture(t);
  const pair = [row("response_item", { type: "function_call", call_id: "ordinary-tool", namespace: "functions", name: "exec", arguments: "{}" }, 3), row("response_item", { type: "function_call_output", call_id: "ordinary-tool", output: "PRIVATE OUTPUT" }, 4)];
  for (const cwd of [path.join(f.root, "other-project"), undefined, null, "."]) {
    await f.write([meta(f.projectRoot), row("turn_context", { turn_id: TURN, cwd }, 1), ...pair]);
    const wrong = await createCodexNativeSessionReader(f.options).read();
    assert.equal(wrong.state, "unavailable");
    assert.equal(wrong.reason, "native_turn_project_binding_unproven");
    assert.equal(buildNativeCodexLiveSnapshot(wrong), null);
    assert.doesNotMatch(JSON.stringify(wrong), /PRIVATE|other-project/u);
  }
  await f.write([meta(f.projectRoot), row("turn_context", { turn_id: TURN, cwd: f.projectRoot }, 1), ...pair]);
  await writeFile(path.join(f.day, `rollout-resume-${THREAD}.jsonl`), serialize([meta(f.projectRoot), row("turn_context", { turn_id: TURN, cwd: path.join(f.root, "other-project") }, 12), ...pair]));
  assert.equal((await createCodexNativeSessionReader(f.options).read()).state, "unavailable", "one matching resume context cannot hide another explicit conflicting context");
});
