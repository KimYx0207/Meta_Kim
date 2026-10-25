import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createInitialState, writeSpineState } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { copyHookClosure } from "../helpers/hook-fixture.mjs";

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
for (const runtime of ["codex", "claude"]) {
  const script = path.resolve("canonical/runtime-assets", runtime === "claude" ? "claude" : "shared", "hooks/stop-spine-cleanup.mjs");
  async function fixture(t, { managed = false, evolution = false } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "meta-host-stop-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const hooks = path.join(root, "hooks");
    await mkdir(hooks);
    copyHookClosure(path.resolve("."), hooks, ["stop-spine-cleanup.mjs"]);
    if (runtime === "claude") await copyFile(script, path.join(hooks, "stop-spine-cleanup.mjs"));
    const transcripts = {};
    for (const id of [PARENT, CHILD]) {
      transcripts[id] = path.join(root, id + ".jsonl");
      await writeFile(transcripts[id], JSON.stringify({ type: "session_meta", payload: { id } }) + "\n");
    }
    const state = createInitialState({ sourceRuntime: runtime, sourceConversation: { runtime, conversationId: PARENT, matchBasis: "transcript_file_verified" } });
    if (managed) state.hostCheckpointRevision = 1;
    if (evolution) { state.currentStage = "evolution"; state.stages.evolution = { status: "completed", completedAt: new Date().toISOString() }; }
    await writeSpineState(root, state);
    return { root, state, read: async () => JSON.parse(await readFile(path.join(root, ".meta-kim/state/default/active-run.json"), "utf8")),
      stop(id = PARENT, extra = {}) {
        const payload = id ? { session_id: id, transcript_path: transcripts[id], ...extra } : extra;
        const result = spawnSync(process.execPath, [path.join(hooks, "stop-spine-cleanup.mjs")], { cwd: root, input: JSON.stringify(payload), encoding: "utf8", windowsHide: true });
        assert.equal(result.status, 0, result.stderr);
        return result;
      } };
  }
  test(`${runtime}: a worker Stop cannot terminalize its parent's project run`, async (t) => {
    const f = await fixture(t);
    f.stop(CHILD);
    assert.equal((await f.read()).active, true);
  });
  test(`${runtime}: an unverified Stop cannot end a bound conversation`, async (t) => {
    const f = await fixture(t);
    f.stop(null);
    assert.equal((await f.read()).active, true);
  });
  test(`${runtime}: a different explicit run id cannot end the current run`, async (t) => {
    const f = await fixture(t);
    f.stop(PARENT, { run_id: "meta-other-run" });
    assert.equal((await f.read()).active, true);
  });
  test(`${runtime}: ordinary turn Stop preserves an unfinished checkpointed task`, async (t) => {
    const f = await fixture(t, { managed: true });
    f.stop();
    const status = await f.read();
    assert.equal(status.active, true);
    assert.equal(status.completed.length, 0);
  });
  test(`${runtime}: matching legacy Stop retains its existing terminal behavior`, async (t) => {
    const f = await fixture(t);
    f.stop();
    assert.equal((await f.read()).active, false);
  });
  test(`${runtime}: matching Evolution closure can still terminalize a checkpointed run`, async (t) => {
    const f = await fixture(t, { managed: true, evolution: true });
    f.stop();
    assert.equal((await f.read()).lifecycleStatus, "evolution_completed");
  });
}
