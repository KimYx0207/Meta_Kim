import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";

import { loadLiveHubLifecycleBudget } from "../../src/application/live/live-hub-lifecycle-budget.mjs";

const repoRoot = path.resolve(".");
const hookPath = path.join(
  repoRoot,
  "canonical",
  "runtime-assets",
  "shared",
  "hooks",
  "activate-meta-theory-spine.mjs",
);

/**
 * The hook reads its fuse from the package it was pointed at, so the fixture
 * ships the real budget module and the real document at the same relative
 * layout a published package uses. Stubbing the number instead would pass even
 * if the module stopped resolving its own config.
 */
function installBudgetLayer(packageRoot) {
  mkdirSync(path.join(packageRoot, "src", "application", "live"), { recursive: true });
  mkdirSync(path.join(packageRoot, "config", "live"), { recursive: true });
  copyFileSync(
    path.join(repoRoot, "src", "application", "live", "live-hub-lifecycle-budget.mjs"),
    path.join(packageRoot, "src", "application", "live", "live-hub-lifecycle-budget.mjs"),
  );
  copyFileSync(
    path.join(repoRoot, "config", "live", "hub-lifecycle.json"),
    path.join(packageRoot, "config", "live", "hub-lifecycle.json"),
  );
}

function runHook({ started, registryStatus = "joined", withBudget = true, runtime = "", conversationId = null, verifiedTranscript = true, initialEnvironment = {} }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-live-hook-"));
  const projectRoot = path.join(root, "project");
  const packageRoot = path.join(root, "package");
  const invocationPath = path.join(root, "live-invocation.json");
  const bindingPath = path.join(root, "native-binding.json");
  mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(packageRoot, "src", "infrastructure", "live"), { recursive: true });
  const transcriptPath = conversationId ? path.join(root, conversationId + ".jsonl") : null;
  if (transcriptPath && verifiedTranscript) writeFileSync(transcriptPath, JSON.stringify({ type: "session_meta", payload: { id: conversationId } }) + "\n");
  if (withBudget) installBudgetLayer(packageRoot);
  writeFileSync(
    path.join(packageRoot, "src", "infrastructure", "live", "live-hub-lifecycle.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      "export async function ensureLiveHub(options) {",
      `  writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify(options));`,
      `  return { started: ${started}, deepLink: "http://127.0.0.1:43127/?projectId=project-a1b2c3d4e5f6&runId=meta-hook-1" };`,
      "}",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(packageRoot, "scripts", "project-registry.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'export function buildProjectRef() { return "project-a1b2c3d4e5f6"; }',
      `export async function ensureGovernedLiveProjectRegistration() { return { projectRef: "project-a1b2c3d4e5f6", registryStatus: ${JSON.stringify(registryStatus)}, known: ${registryStatus === "joined" || registryStatus === "known"} }; }`,
      `export async function registerLiveNativeCodexBinding(options) { writeFileSync(${JSON.stringify(bindingPath)}, JSON.stringify(options)); }`,
      "",
    ].join("\n"),
    "utf8",
  );
  const invoke = (environment = {}) => spawnSync(process.execPath, [hookPath, "--package-root", packageRoot], {
    cwd: projectRoot,
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "请用 meta-theory 帮我实现并验证这个功能",
      ...(conversationId ? { session_id: conversationId, transcript_path: transcriptPath } : {}),
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: "",
      META_KIM_POST_COPY_AUTO: "off",
      META_KIM_LIVE_AUTO: "1",
      META_KIM_PROFILE: "hook-profile",
      META_KIM_HOOK_RUNTIME: runtime,
      CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111",
      ...initialEnvironment,
      ...environment,
    },
    windowsHide: true,
    timeout: 10_000,
  });
  const result = invoke();
  return {
    invoke,
    root,
    projectRoot,
    packageRoot,
    invocationPath,
    bindingPath,
    result,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("first governed use starts the Hub and injects a normal-chat link instruction", () => {
  const fixture = runHook({ started: true });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const output = JSON.parse(fixture.result.stdout);
    const context = output.hookSpecificOutput.additionalContext;
    assert.match(context, /Meta_Kim Live 已启动/u);
    assert.match(context, /http:\/\/127\.0\.0\.1:43127/u);
    assert.match(context, /正常会话回复/u);
    const options = JSON.parse(readFileSync(fixture.invocationPath, "utf8"));
    assert.equal(options.packageRoot, fixture.packageRoot);
    assert.equal(options.projectRef, "project-a1b2c3d4e5f6");
    assert.match(options.runId, /^meta-/u);
    assert.equal(options.profile, "hook-profile");
    assert.equal(options.timeoutMs, loadLiveHubLifecycleBudget().hookAutostartBudgetMs);
  } finally {
    fixture.cleanup();
  }
});

test("a skipped project does not announce the Hub root as the current task or request its sidebar", () => {
  const fixture = runHook({ started: true, registryStatus: "skipped" });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const options = JSON.parse(readFileSync(fixture.invocationPath, "utf8"));
    assert.equal(options.projectRef, null);
    assert.equal(options.runId, null);
    assert.equal(fixture.result.stdout.trim(), "");
    assert.equal(existsSync(path.join(fixture.projectRoot, ".meta-kim", "state", "hook-profile", "live-view-requests")), false);
  } finally {
    fixture.cleanup();
  }
});

test("an already-running Hub requests the current known-project view once", () => {
  const fixture = runHook({ started: false, registryStatus: "known", runtime: "codex" });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const context = JSON.parse(fixture.result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /已复用/u);
    assert.match(context, /侧栏视图一次/u);
    assert.match(context, /queued/u);
    const options = JSON.parse(readFileSync(fixture.invocationPath, "utf8"));
    assert.equal(options.projectRef, "project-a1b2c3d4e5f6");
    assert.ok(options.runId);
    const repeated = fixture.invoke();
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(repeated.stdout.trim(), "", "the same host/project/run must not request a second tab");
    const binding = JSON.parse(readFileSync(fixture.bindingPath, "utf8"));
    assert.equal(binding.repoPath, fixture.projectRoot);
    assert.equal(binding.threadId, "11111111-1111-4111-8111-111111111111");
    assert.equal(binding.profile, "hook-profile");
    const anotherHost = fixture.invoke({ CODEX_THREAD_ID: "22222222-2222-4222-8222-222222222222" });
    assert.equal(anotherHost.status, 0, anotherHost.stderr);
    assert.match(JSON.parse(anotherHost.stdout).hookSpecificOutput.additionalContext, /侧栏视图一次/u);
  } finally {
    fixture.cleanup();
  }
});

test("a package missing the budget layer does not autostart on a guessed fuse", () => {
  const fixture = runHook({ started: true, withBudget: false });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(
      existsSync(fixture.invocationPath),
      false,
      "the hub must not be started on a fuse the data layer never supplied",
    );
    assert.equal(
      fixture.result.stdout.trim(),
      "",
      "no Live link may be announced when the measured fuse cannot be read",
    );
  } finally {
    fixture.cleanup();
  }
});

test("Codex registers the verified hook conversation when the host omits its thread environment", () => {
  const thread = "22222222-2222-4222-8222-222222222222";
  const fixture = runHook({ started: false, runtime: "codex", conversationId: thread, initialEnvironment: { CODEX_THREAD_ID: "" } });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(JSON.parse(readFileSync(fixture.bindingPath, "utf8")).threadId, thread);
    assert.equal(fixture.invoke({ CODEX_THREAD_ID: "" }).stdout.trim(), "", "the same verified conversation must reuse its view request");
  } finally { fixture.cleanup(); }
});

test("Codex prefers the verified transcript identity over an inherited thread hint", () => {
  const thread = "22222222-2222-4222-8222-222222222222";
  const fixture = runHook({ started: false, runtime: "codex", conversationId: thread });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(JSON.parse(readFileSync(fixture.bindingPath, "utf8")).threadId, thread);
  } finally { fixture.cleanup(); }
});

test("a raw session id without a verified transcript or host hint cannot register native observation", () => {
  const fixture = runHook({ started: false, runtime: "codex", conversationId: "22222222-2222-4222-8222-222222222222", verifiedTranscript: false, initialEnvironment: { CODEX_THREAD_ID: "" } });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(existsSync(fixture.bindingPath), false);
  } finally { fixture.cleanup(); }
});
