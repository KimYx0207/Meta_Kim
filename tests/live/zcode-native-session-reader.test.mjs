import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importDatabaseSync } from "../../src/data/sqlite/runtime.mjs";
import { createZcodeNativeSessionReader, discoverZcodeNativeBinding, nativeZcodeRunId } from "../../src/infrastructure/live/zcode-native-session-reader.mjs";
import { buildNativeZcodeLiveSnapshot, nativeZcodeSessionCatalogRow } from "../../src/application/live/live-native-zcode-projection.mjs";
import { createProjectTaskIdentity } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";

const SESSION = "sess_679debd1-96b6-45dc-8e8c-27fdcb6345f5";
const TURN = "turn_f7b6557f-b437-43e8-994b-be94c20b3a10";
const OTHER_TURN = "turn_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN = "meta-2026-10-30t15-56-18-831z-a4fcae51aea09332";
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-zcode-native-test-"));
  const projectRoot = path.join(root, "project");
  const zcodeHome = path.join(root, ".zcode", "cli");
  const dbDir = path.join(zcodeHome, "db");
  const dbPath = path.join(dbDir, "db.sqlite");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(dbDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const DatabaseSync = await importDatabaseSync();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, path TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, time_deleted INTEGER, last_outcome TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
  `);
  db.prepare("INSERT INTO session(id,directory,path,title) VALUES(?,?,?,?)").run(SESSION, projectRoot, projectRoot, "Sample task");
  db.close();
  const options = { projectRoot, sessionId: SESSION, turnId: TURN, zcodeHome, runId: RUN };
  const insertMessage = (id, sequence, data) => {
    const handle = new DatabaseSync(dbPath);
    handle.prepare("INSERT INTO message(id,session_id,data,sequence) VALUES(?,?,?,?)").run(id, SESSION, JSON.stringify(data), sequence);
    handle.close();
  };
  const insertPart = (id, messageId, sequence, data) => {
    const handle = new DatabaseSync(dbPath);
    handle.prepare("INSERT INTO part(id,message_id,session_id,data,sequence) VALUES(?,?,?,?,?)").run(id, messageId, SESSION, JSON.stringify(data), sequence);
    handle.close();
  };
  const addUser = (turnId = TURN, id = "user-1", sequence = 1, inputIntent = null) => insertMessage(id, sequence, {
    role: "user", anchor: { turnId, origin: "realUser" }, metadata: inputIntent ? { inputIntent: { text: inputIntent } } : {},
    text: "PRIVATE USER PROMPT MUST NOT LEAK", time: "2026-10-30T15:56:18.831Z",
  });
  const addAgent = (partId, messageId, sequence, { status = "running", description = `Task ${partId}`, owner = "javascript-pro", turnId = TURN } = {}) => {
    insertPart(partId, messageId, sequence, { type: "tool", tool: "Agent", callID: partId,
      state: { status, input: { description, prompt: "PRIVATE AGENT PROMPT MUST NOT LEAK", subagent_type: owner },
        output: "PRIVATE AGENT OUTPUT MUST NOT LEAK", time: { start: "2026-10-30T15:56:20.000Z", ...(status === "running" ? {} : { end: "2026-10-30T15:57:00.000Z" }) } } });
  };
  const addAssistant = (id, sequence, parentId = "user-1", turnId = TURN, finish = "tool-calls") => insertMessage(id, sequence, {
    role: "assistant", parentID: parentId, anchor: { turnId }, agent: "zcode-agent", finish,
    text: "PRIVATE ASSISTANT BODY MUST NOT LEAK", time: "2026-10-30T15:56:25.000Z",
  });
  return { root, projectRoot, zcodeHome, dbPath, options, insertMessage, insertPart, addUser, addAgent, addAssistant };
}

test("projects two exact Agent calls with safe labels and owner names", async (t) => {
  const f = await fixture(t);
  f.addUser();
  f.addAssistant("assistant-1", 2);
  f.addAgent("agent-call-1", "assistant-1", 1, { status: "completed", description: "Inspect module boundaries", owner: "explorer" });
  f.addAgent("agent-call-2", "assistant-1", 2, { description: "Review backend flow", owner: "javascript-pro" });
  f.insertPart("tool-call-1", "assistant-1", 3, { type: "tool", tool: "Bash", callID: "tool-call-1",
    state: { status: "error", input: { command: "SECRET COMMAND" }, output: "SECRET OUTPUT", time: { start: 1793375780, end: 1793375781 } } });
  const observed = await createZcodeNativeSessionReader(f.options).read();
  const snapshot = buildNativeZcodeLiveSnapshot(observed);
  assert.equal(snapshot.run.runId, RUN);
  assert.equal(snapshot.run.sourceRuntime, "zcode");
  assert.equal(snapshot.run.stageProgressEvidence, "native_execution_only");
  assert.equal(observed.coverage.scope, "parent_turn");
  assert.equal(observed.coverage.state, "partial");
  assert.ok(observed.coverage.reasons.includes("child_tool_history_not_observed"));
  assert.equal(snapshot.run.acceptanceState, "unproven");
  assert.deepEqual(snapshot.nodes.slice(1).map((item) => [item.label, item.ownerAgent, item.status]), [
    ["Inspect module boundaries", "explorer", "in_doubt"], ["Review backend flow", "javascript-pro", "active"],
  ]);
  assert.equal(snapshot.edges.length, 2);
  assert.ok(snapshot.edges.every((edge) => edge.kind === "invokes"));
  assert.deepEqual(snapshot.nodes.slice(1).map((node) => node.capabilityTruth.find((record) => record.kind === "agent")?.actualNames), [["explorer"], ["javascript-pro"]]);
  assert.ok(snapshot.nodes.slice(1).every((node) => node.capabilityTruth[0].state === "observed" && node.capabilityTruth[0].observation === "trusted_host_evidence"));
  const observedTools = snapshot.nodes[0].capabilityTruth.find((record) => record.kind === "runtime_tool");
  assert.equal(observedTools.state, "observed");
  assert.ok(observedTools.actualNames.includes("Bash"));
  assert.ok(snapshot.nodes.every((node) => node.capabilityTruth.every((record) => ["agent", "runtime_tool"].includes(record.kind))));
  assert.equal(snapshot.toolCalls.find((call) => call.callId === "tool-call-1")?.status, "failed");
  assert.equal(snapshot.run.executionSummary.acceptanceState, "unproven");
  assert.equal(nativeZcodeSessionCatalogRow(snapshot).sourceRuntime, "zcode");
  const serialized = JSON.stringify(snapshot);
  for (const privateValue of ["PRIVATE USER PROMPT", "PRIVATE AGENT PROMPT", "PRIVATE AGENT OUTPUT", "PRIVATE ASSISTANT BODY", "SECRET COMMAND", "SECRET OUTPUT"]) {
    assert.equal(serialized.includes(privateValue), false, `${privateValue} is not projected`);
  }
});

test("unsupported native tool names are omitted with explicit partial coverage", async (t) => {
  const f = await fixture(t);
  f.addUser();
  f.addAssistant("assistant-current", 2);
  f.insertPart("unsupported-tool", "assistant-current", 1, { type: "tool", tool: "invalid/tool?name", callID: "unsupported-tool", state: { status: "completed" } });
  const observed = await createZcodeNativeSessionReader(f.options).read();
  assert.equal(observed.state, "observed");
  assert.equal(observed.toolCalls.length, 0);
  assert.equal(observed.coverage.scope, "parent_turn");
  assert.equal(observed.coverage.droppedToolPartCount, 1);
  assert.equal(observed.coverage.state, "partial");
  assert.ok(observed.coverage.reasons.includes("unsupported_tool_record"));
});

test("only the exact real-user turn anchor and its assistant descendants are observed", async (t) => {
  const f = await fixture(t);
  f.addUser(TURN, "user-1", 1);
  f.addAssistant("assistant-current", 2, "user-1", TURN);
  f.addAgent("call-current", "assistant-current", 1, { description: "current turn" });
  f.insertMessage("user-later", 3, { role: "user", anchor: { turnId: OTHER_TURN, origin: "realUser" }, text: "PRIVATE LATER TURN" });
  f.addAssistant("assistant-later", 4, "user-later", OTHER_TURN);
  f.addAgent("call-later", "assistant-later", 2, { description: "later turn must not leak", turnId: OTHER_TURN });
  const observed = await createZcodeNativeSessionReader(f.options).read();
  assert.deepEqual(observed.agents.map((agent) => agent.id), ["call-current"]);
  assert.equal(JSON.stringify(buildNativeZcodeLiveSnapshot(observed)).includes("later turn must not leak"), false);
});

test("wrong project, session, or turn anchor is refused", async (t) => {
  const f = await fixture(t);
  f.addUser();
  const wrongProject = await createZcodeNativeSessionReader({ ...f.options, projectRoot: f.root }).read();
  assert.equal(wrongProject.refusal, "zcode_project_mismatch");
  const wrongSession = await createZcodeNativeSessionReader({ ...f.options, sessionId: "sess_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }).read();
  assert.equal(wrongSession.refusal, "zcode_session_not_found");
  const wrongTurn = await createZcodeNativeSessionReader({ ...f.options, turnId: OTHER_TURN }).read();
  assert.equal(wrongTurn.refusal, "zcode_turn_anchor_not_found");
  assert.equal(buildNativeZcodeLiveSnapshot(wrongProject), null);
});

test("automatic discovery binds only one exact HMAC-matched native user turn", async (t) => {
  const f = await fixture(t);
  const inputIntent = "A private task intent used only in this temporary fixture.";
  const identity = await createProjectTaskIdentity(f.projectRoot, inputIntent, { profile: "default" });
  f.addUser(TURN, "user-1", 1, inputIntent);
  const binding = await discoverZcodeNativeBinding({ projectRoot: f.projectRoot, runId: RUN, profile: "default", zcodeHome: f.zcodeHome,
    durableStatus: { runId: RUN, taskFingerprint: identity.taskFingerprint } });
  assert.deepEqual(binding, { projectRoot: f.projectRoot, zcodeHome: f.zcodeHome, sessionId: SESSION, turnId: TURN, runId: RUN });
  const wrongRun = await discoverZcodeNativeBinding({ projectRoot: f.projectRoot, runId: RUN, profile: "default", zcodeHome: f.zcodeHome,
    durableStatus: { runId: "meta-2026-10-30t14-20-00-978z-d44594d6c5badd79", taskFingerprint: identity.taskFingerprint } });
  assert.equal(wrongRun, null);
});

test("automatic discovery includes older exact turns within its bounded user-message window", async (t) => {
  const f = await fixture(t);
  const inputIntent = "The exact intent older than sixteen recent messages.";
  const identity = await createProjectTaskIdentity(f.projectRoot, inputIntent, { profile: "default" });
  f.addUser(TURN, "user-target", 1, inputIntent);
  for (let index = 0; index < 24; index += 1) {
    const turnId = `turn_${String(index + 1).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    f.addUser(turnId, `user-recent-${index}`, index + 2, `A different recent intent ${index}`);
  }
  const binding = await discoverZcodeNativeBinding({ projectRoot: f.projectRoot, runId: RUN, profile: "default", zcodeHome: f.zcodeHome,
    durableStatus: { runId: RUN, taskFingerprint: identity.taskFingerprint } });
  assert.equal(binding?.turnId, TURN);
  assert.equal(binding?.sessionId, SESSION);
});

test("an arbitrary invalid run ID cannot make an empty synthetic graph", async (t) => {
  const f = await fixture(t);
  f.addUser();
  const reader = createZcodeNativeSessionReader({ ...f.options, runId: "unrelated-run" });
  const observed = await reader.read();
  assert.equal(observed.refusal, "zcode_binding_invalid");
  assert.equal(buildNativeZcodeLiveSnapshot(observed), null);
  assert.equal(nativeZcodeRunId({ ...f.options, runId: "not-a-governed-run" }), null);
});

test("the reader does not modify the source database bytes", async (t) => {
  const f = await fixture(t);
  f.addUser();
  f.addAssistant("assistant-1", 2);
  const before = hash(await readFile(f.dbPath));
  await createZcodeNativeSessionReader(f.options).read();
  assert.equal(hash(await readFile(f.dbPath)), before);
});

test("tool errors remain visible, and row limits mark partial coverage", async (t) => {
  const f = await fixture(t);
  f.addUser();
  for (let index = 0; index < 514; index += 1) {
    const messageId = `assistant-${index}`;
    f.addAssistant(messageId, index + 2);
    f.addAgent(`call-${index}`, messageId, index, { status: index === 0 ? "error" : "completed", description: `Task ${index}` });
  }
  const observed = await createZcodeNativeSessionReader(f.options).read();
  assert.equal(observed.agents[0].status, "error");
  assert.equal(observed.coverage.state, "partial");
  assert.ok(observed.coverage.reasons.includes("message_limit_reached"));
  assert.equal(observed.agents.length <= 512, true);
});

test("schema failures stay explicit instead of producing an empty snapshot", async (t) => {
  const f = await fixture(t);
  const DatabaseSync = await importDatabaseSync();
  const db = new DatabaseSync(f.dbPath);
  db.exec("DROP TABLE part");
  db.close();
  const observed = await createZcodeNativeSessionReader(f.options).read();
  assert.equal(observed.refusal, "zcode_schema_unavailable");
  assert.equal(buildNativeZcodeLiveSnapshot(observed), null);
});
