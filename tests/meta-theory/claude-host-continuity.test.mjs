import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { readSpineState, writeSpineState } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { buildMetaKimHooksTemplate } from "../../scripts/claude-settings-merge.mjs";

const repo = resolve(import.meta.dirname, "../..");
const sharedHooks = join(repo, "canonical/runtime-assets/shared/hooks");
const claudeHooks = join(repo, "canonical/runtime-assets/claude/hooks");
const chat = "11111111-2222-4333-8444-555555555555";
const otherChat = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "meta-kim-claude-continuity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "home"));
  for (const id of [chat, otherChat]) writeFileSync(join(root, `${id}.jsonl`), "{}\n");
  const invoke = (script, input, args = []) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root, input: JSON.stringify(input), encoding: "utf8", windowsHide: true,
      env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), CLAUDE_PROJECT_DIR: root,
        META_KIM_LIVE_AUTO: "off", META_KIM_POST_COPY_AUTO: "off", META_KIM_PROFILE: "default" },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
  };
  function event(hook_event_name, fields = {}, session_id = chat) {
    return { hook_event_name, cwd: root, session_id, transcript_path: join(root, `${session_id}.jsonl`), ...fields };
  }
  function activate(input) {
    return invoke(join(sharedHooks, "activate-meta-theory-spine.mjs"), input,
      ["--runtime", "claude", "--package-root", repo]);
  }
  return {
    root,
    ask: (prompt, fields = {}, id) => activate(event("UserPromptSubmit", { prompt, ...fields }, id))?.additionalContext ?? "",
    stop: () => invoke(join(claudeHooks, "stop-spine-cleanup.mjs"), event("Stop")),
    start: (source, id) => activate(event("SessionStart", { source }, id)),
  };
}

test("verified Claude prompts use a short same-stage handoff and keep explicit no-checkpoint follow-ups across Stop", async (t) => {
  const f = fixture(t);
  const first = f.ask("Fix the typo in README");
  assert.match(first, /Checkpoint after each stage/);
  assert.match(first, /Bind meta-warden for substantive Critical and Meta-Review/);
  assert.match(first, /Owner-reported records and native invocation evidence remain separate/);
  const initial = await readSpineState(f.root);
  assert.equal(initial.hostCheckpointRevision ?? 0, 0);
  const duplicate = f.ask("Fix the typo in README");
  assert.match(duplicate, /Invocation:.*--inspect/);
  assert.match(duplicate, new RegExp(initial.runId));
  assert.ok(duplicate.length < first.length / 2);
  f.stop();
  assert.equal((await readSpineState(f.root)).runId, initial.runId);
  assert.match(f.ask("Update the changelog entry for this fix"), new RegExp(initial.runId));
  const continued = await readSpineState(f.root);
  assert.equal(continued.runId, initial.runId);
  assert.equal(continued.lastUserSteering.kind, "same_conversation_followup");
  assert.equal(f.ask("What does this function do?"), "");
  assert.equal(f.ask("what is the status"), "");
  assert.match(f.ask("New task: fix the configuration file"), /Checkpoint after each stage/);
  assert.notEqual((await readSpineState(f.root)).runId, initial.runId);
});

test("the Chinese handoff distinguishes meta-warden ownership and native call evidence", (t) => {
  const first = fixture(t).ask("帮我修复Hook代码并运行测试");
  assert.match(first, /Critical 和 Meta-Review 由 meta-warden 负责/);
  assert.match(first, /分别保留负责人自报记录和原生调用证据/);
});

test("stage transitions, verified compaction or resume restore full instructions to the current run", async (t) => {
  const f = fixture(t);
  f.ask("Fix the typo in README");
  const initial = await readSpineState(f.root);
  assert.ok((await writeSpineState(f.root, { ...initial, currentStage: "fetch", hostCheckpointRevision: 1 })).written);
  assert.match(f.ask("Continue fixing README"), /Checkpoint after each stage/);
  assert.doesNotMatch(f.ask("Continue fixing README"), /Checkpoint after each stage/);
  for (const source of ["compact", "resume"]) {
    const restored = f.start(source);
    assert.equal(restored?.hookEventName, "SessionStart");
    assert.match(restored.additionalContext, /Checkpoint after each stage/);
    assert.match(restored.additionalContext, new RegExp(initial.runId));
    assert.match(restored.additionalContext, /current stage=fetch/);
  }
  assert.equal(f.start("compact", otherChat), null);
});

test("an unverified session never shortens its handoff or joins a distinct prompt", async (t) => {
  const f = fixture(t);
  const unverified = { transcript_path: join(f.root, "absent.jsonl") };
  for (let i = 0; i < 2; i++) {
    assert.match(f.ask("Fix the typo in README", unverified), /Checkpoint after each stage/);
  }
  const initial = await readSpineState(f.root);
  assert.match(f.ask("Update the changelog entry for this fix", unverified), /Checkpoint after each stage/);
  assert.notEqual((await readSpineState(f.root)).runId, initial.runId);
});

test("Claude bindings can complete after the first prompt but never merge another verified session", async (t) => {
  const f = fixture(t);
  assert.match(f.ask("Fix the typo in README", { transcript_path: null }), /Checkpoint after each stage/);
  const initial = await readSpineState(f.root);
  assert.equal(initial.conversationLinkState, "unlinked");
  f.stop();
  const bound = await readSpineState(f.root);
  assert.equal(bound?.sourceConversation?.conversationId, chat);
  assert.equal(bound.runId, initial.runId);
  const otherPrompt = f.ask("Update the changelog entry for this fix", {}, otherChat);
  assert.match(otherPrompt, /Checkpoint after each stage/);
  assert.notEqual((await readSpineState(f.root)).runId, initial.runId);
});

test("Claude project and global hook wiring can restore context after compaction and resume", () => {
  const settings = JSON.parse(readFileSync(join(repo, "canonical/runtime-assets/claude/settings.json"), "utf8"));
  for (const hooks of [settings.hooks, buildMetaKimHooksTemplate(claudeHooks, repo)]) {
    assert.ok(hooks.SessionStart.some(({ matcher, hooks: handlers }) =>
      ["compact", "resume"].every((source) => new RegExp(matcher).test(source))
      && handlers.some(({ command }) => /activate-meta-theory-spine\.mjs/.test(command))));
  }
});
