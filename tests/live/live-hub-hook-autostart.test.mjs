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

function runHook({ started, registryStatus = "joined", withBudget = true }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-live-hook-"));
  const projectRoot = path.join(root, "project");
  const packageRoot = path.join(root, "package");
  const invocationPath = path.join(root, "live-invocation.json");
  mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
  mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(packageRoot, "src", "infrastructure", "live"), { recursive: true });
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
      'export function buildProjectRef() { return "project-a1b2c3d4e5f6"; }',
      `export async function ensureGovernedLiveProjectRegistration() { return { projectRef: "project-a1b2c3d4e5f6", registryStatus: ${JSON.stringify(registryStatus)} }; }`,
      "",
    ].join("\n"),
    "utf8",
  );
  const result = spawnSync(process.execPath, [hookPath, "--package-root", packageRoot], {
    cwd: projectRoot,
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "请用 meta-theory 帮我实现并验证这个功能",
    }),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: "",
      META_KIM_POST_COPY_AUTO: "off",
      META_KIM_LIVE_AUTO: "1",
      META_KIM_PROFILE: "hook-profile",
    },
    windowsHide: true,
    timeout: 10_000,
  });
  return {
    root,
    projectRoot,
    packageRoot,
    invocationPath,
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

test("a skipped project opens the Hub root without invalid project or run deep links", () => {
  const fixture = runHook({ started: true, registryStatus: "skipped" });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const options = JSON.parse(readFileSync(fixture.invocationPath, "utf8"));
    assert.equal(options.projectRef, null);
    assert.equal(options.runId, null);
  } finally {
    fixture.cleanup();
  }
});

test("an already-running Hub is reused silently instead of spamming every prompt", () => {
  const fixture = runHook({ started: false });
  try {
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    assert.equal(fixture.result.stdout.trim(), "");
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
