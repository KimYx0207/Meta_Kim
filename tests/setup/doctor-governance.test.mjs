import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { buildDoctorSyncCheckPlan, checkHooks } from "../../scripts/doctor-governance.mjs";
import { buildMetaKimHooksTemplate } from "../../scripts/claude-settings-merge.mjs";
import { collectHookRegistrations, inspectRequiredHooks, parseNodeHookCommand } from "../../scripts/hook-registration-diagnostics.mjs";

const repoRoot = join(import.meta.dirname, "..", "..");

test("SEC-1 rejects another project's identically named canonical hooks", async (t) => {
  const root = mkdtempSync(join(os.tmpdir(), "meta-kim-doctor-root-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = JSON.parse(readFileSync(join(repoRoot, "canonical/runtime-assets/claude/settings.json"), "utf8"));
  for (const blocks of Object.values(settings.hooks)) for (const block of blocks) for (const hook of block.hooks) {
    const parsed = parseNodeHookCommand(hook.command);
    hook.command = `node "D:/foreign-project/${parsed.script}" ${parsed.args.join(" ")}`;
  }
  mkdirSync(join(root, ".claude"));
  const settingsPath = join(root, ".claude/settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings));
  await assert.rejects(checkHooks({ settingsPath, projectRoot: root, projectProjectionMode: "project" }), /Required project hooks missing or invalid/u);
});

test("SEC-1 binds absolute and normalized paths to the actual settings project", async (t) => {
  const root = mkdtempSync(join(os.tmpdir(), "meta-kim-doctor-settings-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".claude"));
  const settingsPath = join(root, ".claude/settings.json");
  const canonical = JSON.parse(readFileSync(join(repoRoot, "canonical/runtime-assets/claude/settings.json"), "utf8"));
  const replaceRoot = (base) => {
    const settings = structuredClone(canonical);
    for (const blocks of Object.values(settings.hooks)) for (const block of blocks) for (const hook of block.hooks) {
      const parsed = parseNodeHookCommand(hook.command);
      hook.command = `node "${base}/${parsed.script}" ${parsed.args.join(" ")}`;
    }
    writeFileSync(settingsPath, JSON.stringify(settings));
  };
  replaceRoot(root.replaceAll("\\", "/"));
  assert.equal((await checkHooks({ settingsPath, projectProjectionMode: "project" })).mode, "project");
  replaceRoot(root.replaceAll("\\", "/") + "/child/..");
  assert.equal((await checkHooks({ settingsPath, projectProjectionMode: "project" })).mode, "project");
  for (const wrongRoot of ["../foreign-project", root.replaceAll("\\", "/") + "/child", "D:/foreign-project"]) {
    replaceRoot(wrongRoot);
    await assert.rejects(checkHooks({ settingsPath, projectProjectionMode: "project" }), /Required project hooks missing or invalid/u);
  }
});

test("SEC-1 global templates retain exact runtime paths and immutable package-root arguments", () => {
  const runtimeHome = "C:/Users/Test Runtime/.claude/hooks/meta-kim";
  const immutableRoot = "C:/Users/Test Runtime/.meta-kim/runtime/projection-packages/meta-kim/1.0.0/" + "a".repeat(64) + "/node_modules/meta-kim";
  const expected = buildMetaKimHooksTemplate(runtimeHome);
  const actual = buildMetaKimHooksTemplate(runtimeHome, immutableRoot);
  assert.equal(inspectRequiredHooks(actual, expected, { projectRoot: "D:/unrelated-project" }).ok, true);
  const otherHome = buildMetaKimHooksTemplate("D:/foreign-project/.claude/hooks/meta-kim", immutableRoot);
  assert.equal(inspectRequiredHooks(otherHome, expected, { projectRoot: "D:/unrelated-project" }).ok, false);
});

test("canonical project hooks plus user hooks pass without a stale fixed count", async (t) => {
  const root = mkdtempSync(join(os.tmpdir(), "meta-kim-doctor-subset-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = JSON.parse(readFileSync(join(repoRoot, "canonical/runtime-assets/claude/settings.json"), "utf8"));
  settings.hooks.Stop.push({ matcher: "*", hooks: [{ type: "command", command: "node user-hook.js" }] });
  const settingsPath = join(root, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings));
  assert.equal((await checkHooks({ settingsPath })).mode, "project");
});

test("the default runtime check respects configured projection mode", () => {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const command = packageJson.scripts["meta:check:runtimes"];
  assert.match(command, /sync-runtimes\.mjs --check --scope project$/u);
  assert.doesNotMatch(command, /--targets/u);
});

test("doctor-governance checks the minimal project Hook closure in global_only mode", () => {
  const plan = buildDoctorSyncCheckPlan({
    localOverrides: { projectProjectionMode: "global_only" },
    activeTargets: ["claude", "codex"],
  });

  assert.equal(plan.skipped, false);
  assert.equal(plan.projectProjectionMode, "global_only");
  assert.equal(plan.checkKind, "minimal_hook_closure");
  assert.deepEqual(plan.args.slice(-3), ["--check", "--scope", "project"]);
  assert.equal(plan.args.includes("--targets"), false);
});

test("doctor-governance checks only the active project targets", () => {
  const plan = buildDoctorSyncCheckPlan({
    localOverrides: { projectProjectionMode: "project" },
    activeTargets: ["cursor"],
  });

  assert.equal(plan.skipped, false);
  assert.equal(plan.checkKind, "full_project_projection");
  assert.deepEqual(plan.args.slice(-2), ["--targets", "cursor"]);
  assert.doesNotMatch(plan.args.join(" "), /claude,codex/);
});

test("project hook requirements retain event, matcher, managed script path and arguments", () => {
  const canonical = JSON.parse(readFileSync(join(repoRoot, "canonical/runtime-assets/claude/settings.json"), "utf8"));
  for (const mutate of [
    (hooks) => hooks.UserPromptSubmit[0].hooks.pop(),
    (hooks) => { hooks.PreToolUse[1].matcher = "Bash"; },
    (hooks) => { hooks.UserPromptSubmit[0].hooks[1].command = hooks.UserPromptSubmit[0].hooks[1].command.replace("--event user-prompt", "--event stop"); },
    (hooks) => { hooks.UserPromptSubmit[0].hooks[0].command += " --runtime codex"; },
    (hooks) => { hooks.UserPromptSubmit[0].hooks[0].command = "node user/activate-meta-theory-spine.mjs --runtime claude"; },
    (hooks) => { hooks.PreToolUse.push(...hooks.UserPromptSubmit); delete hooks.UserPromptSubmit; },
  ]) {
    const actual = structuredClone(canonical.hooks);
    mutate(actual);
    assert.equal(inspectRequiredHooks(actual, canonical.hooks).ok, false);
  }
});

test("Windows quoted Node and hook paths with spaces preserve required arguments", () => {
  const canonical = JSON.parse(readFileSync(join(repoRoot, "canonical/runtime-assets/claude/settings.json"), "utf8"));
  const actual = structuredClone(canonical.hooks);
  for (const blocks of Object.values(actual)) for (const block of blocks) for (const hook of block.hooks) {
    const parsed = parseNodeHookCommand(hook.command);
    hook.command = `"C:\\Program Files\\nodejs\\node.exe" "C:\\Project With Spaces\\${parsed.script.replaceAll("/", "\\")}" ${parsed.args.map((arg) => JSON.stringify(arg)).join(" ")}`;
  }
  assert.equal(inspectRequiredHooks(actual, canonical.hooks, { projectRoot: "C:/Project With Spaces" }).ok, true);
  assert.equal(parseNodeHookCommand('node "unterminated'), null);
  assert.equal(parseNodeHookCommand("node hook.mjs && node other.mjs"), null);
});

function globalFixture(t, native = false) {
  const root = mkdtempSync(join(os.tmpdir(), "meta-kim-doctor-global-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const claudeHome = join(root, ".claude");
  const hooksDir = join(claudeHome, "hooks", "meta-kim");
  mkdirSync(hooksDir, { recursive: true });
  const promptPath = native ? join(claudeHome, "hooks/user-prompt-submit.js") : join(hooksDir, "hookprompt-adapter.mjs");
  const hooks = buildMetaKimHooksTemplate(hooksDir, null, native ? { hookPromptCommand: `node "${promptPath}"` } : { hookPromptAdapter: true });
  for (const row of collectHookRegistrations(hooks)) writeFileSync(row.script, "// fixture only; never executed\n");
  const settingsPath = join(root, "project-settings.json");
  writeFileSync(settingsPath, '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node user-graphify.mjs"}]}]}}');
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ hooks }));
  return { claudeHome, settingsPath, hooks, save: () => writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ hooks })) };
}

for (const native of [false, true]) test(`global_only accepts full healthy ${native ? "native" : "adapter"} hooks with unrelated project hooks`, async (t) => {
  const f = globalFixture(t, native);
  assert.equal((await checkHooks(f)).mode, "global");
  const before = readFileSync(join(f.claudeHome, "settings.json"), "utf8");
  await checkHooks(f);
  assert.equal(readFileSync(join(f.claudeHome, "settings.json"), "utf8"), before);
});

test("global fallback cannot hide broken project hooks or incorrect global arguments", async (t) => {
  const f = globalFixture(t);
  f.hooks.UserPromptSubmit[0].hooks[1].command = f.hooks.UserPromptSubmit[0].hooks[1].command.replace('"claude"', '"codex"');
  f.save();
  await assert.rejects(checkHooks(f), /global Claude hooks missing or invalid/u);
  const canonical = JSON.parse(readFileSync(join(repoRoot, "canonical/runtime-assets/claude/settings.json"), "utf8"));
  canonical.hooks.PostToolUse.pop();
  writeFileSync(f.settingsPath, JSON.stringify(canonical));
  await assert.rejects(checkHooks(f), /Required project hooks missing or invalid/u);
});

test("missing settings only fall back in global_only mode, never hide a required full project projection", async (t) => {
  const f = globalFixture(t);
  rmSync(f.settingsPath);
  assert.equal((await checkHooks({ ...f, projectProjectionMode: "global_only" })).mode, "global");
  await assert.rejects(checkHooks({ ...f, projectProjectionMode: "project" }), /Required project hooks missing/u);
  writeFileSync(f.settingsPath, "{");
  await assert.rejects(checkHooks({ ...f, projectProjectionMode: "global_only" }), SyntaxError);
});
