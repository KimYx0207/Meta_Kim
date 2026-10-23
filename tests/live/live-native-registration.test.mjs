import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";
import { buildProjectRef, joinProjectRegistry, registerLiveNativeCodexBinding, skipProjectRegistry } from "../../scripts/project-registry.mjs";

const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";
const TURN_A = "33333333-3333-4333-8333-333333333333";
const TURN_B = "44444444-4444-4444-8444-444444444444";
const encode = (rows) => rows.map(JSON.stringify).join("\n") + "\n";

test("a running Hub adds two trusted local threads without changing an existing stream or allowing HTTP enrollment", async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "meta-live-bindings-"));
  const codexHome = path.join(homeDir, ".codex");
  const projectA = path.join(homeDir, "Project A");
  const projectB = path.join(homeDir, "Project B");
  const day = new Date().toISOString().slice(0, 10).split("-");
  const sessionDir = path.join(codexHome, "sessions", ...day);
  await Promise.all([projectA, projectB, sessionDir].map((directory) => mkdir(directory, { recursive: true })));
  const started = Date.now() - 10_000;
  const row = (type, payload, offset = 0) => ({ type, timestamp: new Date(started + offset).toISOString(), payload });
  const command = (root, thread, turn, id, offset) => row("event_msg", { type: "item_completed", thread_id: thread, turn_id: turn, item: { type: "CommandExecution", id, cwd: root, status: "completed", exit_code: 0 } }, offset);
  const source = async (root, thread, turn) => {
    const file = path.join(sessionDir, `rollout-${thread}.jsonl`);
    await writeFile(file, encode([
      row("session_meta", { id: thread, originator: "Codex Desktop", cwd: root }),
      row("turn_context", { turn_id: turn, cwd: root }, 1),
      command(root, thread, turn, "first", 2),
    ]));
    return file;
  };
  const fileA = await source(projectA, THREAD_A, TURN_A);
  await source(projectB, THREAD_B, TURN_B);
  await joinProjectRegistry({ homeDir, repoPath: projectA });
  await joinProjectRegistry({ homeDir, repoPath: projectB });
  const startup = { projectRoot: projectB, codexHome, threadId: THREAD_B, turnId: TURN_B };
  const controller = createLiveControlRoomServer({ globalHub: true, homeDir, projectRoot: projectB, nativeCodex: startup, pollIntervalMs: 20 });
  const address = await controller.start();
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await controller.close(); await rm(homeDir, { recursive: true, force: true }); });
  const projectIdA = buildProjectRef({ repoPath: projectA });
  const projectIdB = buildProjectRef({ repoPath: projectB });
  const runA = `native-codex-${THREAD_A}-${TURN_A}`;
  const runB = `native-codex-${THREAD_B}-${TURN_B}`;
  const query = (projectId, runId) => new URLSearchParams({ projectId, runId });
  const get = (endpoint, projectId, runId) => fetch(`${address.url}${endpoint}?${query(projectId, runId)}`);
  assert.equal((await get("/api/snapshot", projectIdA, runA)).status, 404);
  assert.equal((await get("/api/snapshot", projectIdB, runB)).status, 404, "startup hint cannot bypass missing local enrollment");
  await registerLiveNativeCodexBinding({ homeDir, repoPath: projectA, threadId: THREAD_A, codexHome });
  const first = await get("/api/snapshot", projectIdA, runA);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).run.runId, runA);
  const otherProfile = createLiveControlRoomServer({ globalHub: true, homeDir, nativeCodex: startup, profile: "other-profile" });
  const otherAddress = await otherProfile.start();
  try {
    assert.equal((await fetch(`${otherAddress.url}/api/snapshot?${query(projectIdA, runA)}`)).status, 404);
  } finally { await otherProfile.close(); }
  const stream = await fetch(`${address.url}/api/events?${query(projectIdA, runA)}`, { signal: abort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.ok(initial.includes(runA));
  await registerLiveNativeCodexBinding({ homeDir, repoPath: projectB, threadId: THREAD_B, turnId: TURN_B, codexHome });
  assert.equal((await get("/api/snapshot", projectIdB, runB)).status, 200);
  assert.equal((await controller.service.getSnapshot(runB)).run.runId, runB);
  assert.equal((await get("/api/snapshot", projectIdA, runB)).status, 404);
  assert.equal((await get("/api/snapshot", projectIdB, runA)).status, 404);
  const invalid = await fetch(`${address.url}/api/snapshot?projectId=${projectIdA}&runId=native-codex-invalid&threadId=${THREAD_B}&projectRoot=${encodeURIComponent(projectB)}`);
  assert.equal(invalid.status, 404);
  assert.equal((await fetch(`${address.url}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectRoot: projectB, threadId: THREAD_B }) })).status, 405);
  const catalog = await (await get("/api/projects", projectIdA, runA)).json();
  assert.equal(catalog.projects.flatMap((project) => project.sessions).filter((session) => session.observationKind === "native_execution").length, 2);
  assert.equal(JSON.stringify(catalog).includes(homeDir), false);
  await appendFile(fileA, encode([command(projectA, THREAD_A, TURN_A, "second", 30)]));
  const next = await Promise.race([reader.read(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("SSE did not update")), 3_000); timer.unref(); })]);
  const update = new TextDecoder().decode(next.value);
  assert.ok(update.includes(runA));
  assert.equal(update.includes(runB), false);
  await reader.cancel();
  await skipProjectRegistry({ homeDir, repoPath: projectB });
  assert.equal((await get("/api/snapshot", projectIdB, runB)).status, 404);
  await assert.rejects(controller.service.getSnapshot(runB), /native_turn_not_available/u, "startup cannot revive a revoked registration through the service");
});
