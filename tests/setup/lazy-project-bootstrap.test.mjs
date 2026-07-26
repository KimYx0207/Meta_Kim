import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildIsolatedUserHomeEnv } from "../../scripts/isolated-user-home-env.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TEST_USER_HOME = mkdtempSync(
  path.join(os.tmpdir(), "meta-kim-lazy-bootstrap-home-"),
);

after(() => {
  rmSync(TEST_USER_HOME, { recursive: true, force: true });
});

function tempProject() {
  return mkdtempSync(path.join(os.tmpdir(), "meta-kim-lazy-bootstrap-"));
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function runSetup(args, options = {}) {
  const { env: envOverrides, ...spawnOptions } = options;
  return spawnSync(process.execPath, ["setup.mjs", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    ...spawnOptions,
    env: buildIsolatedUserHomeEnv(TEST_USER_HOME, envOverrides),
  });
}

function spawnSetup(args, options = {}) {
  const { env: envOverrides, ...spawnOptions } = options;
  return spawn(process.execPath, ["setup.mjs", ...args], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...spawnOptions,
    env: buildIsolatedUserHomeEnv(TEST_USER_HOME, envOverrides),
  });
}

function collectSpawnResult(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function waitForPath(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}

function runBin(args, options = {}) {
  const { env: envOverrides, ...spawnOptions } = options;
  return spawnSync(process.execPath, ["bin/meta-kim.mjs", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    ...spawnOptions,
    env: buildIsolatedUserHomeEnv(TEST_USER_HOME, envOverrides),
  });
}

function runBootstrap(projectDir, extraArgs = []) {
  const result = runSetup([
    "--project-bootstrap",
    "--targets",
    "claude,codex",
    "--project-dir",
    projectDir,
    "--json",
    ...extraArgs,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runBootstrapForTargets(projectDir, targets, extraArgs = []) {
  const result = runSetup([
    "--project-bootstrap",
    "--targets",
    targets,
    "--project-dir",
    projectDir,
    "--json",
    ...extraArgs,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function parseTrailingJson(stdout) {
  const start = stdout.lastIndexOf("\n{");
  return JSON.parse(stdout.slice(start === -1 ? 0 : start + 1));
}

test("lazy project bootstrap dry-run exposes source chain and writes nothing", () => {
  const projectDir = tempProject();
  try {
    const before = new Set([]);
    const summary = runBootstrap(projectDir, ["--dry-run"]);
    assert.equal(summary.mode, "dry-run");
    assert.equal(summary.ok, true);
    assert.equal(summary.resultCount, 1);

    const plan = summary.results[0];
    assert.equal(plan.schemaVersion, "meta-kim-project-bootstrap-plan-v0.1");
    assert.equal(plan.state.status, "missing");
    assert.deepEqual(plan.state.activeTargets, ["claude", "codex"]);
    assert.equal(plan.sourceChain.binEntrypoint, "bin/meta-kim.mjs");
    assert.equal(plan.sourceChain.setupEntrypoint, "setup.mjs --project-bootstrap");
    assert.equal(plan.sourceChain.syncManifest, "config/sync.json");
    assert.equal(plan.sourceChain.canonicalRoots.skills, "canonical/skills");
    assert.ok(plan.sourceChain.generatedTargets.claude.includes(".claude/skills"));
    assert.equal(
      plan.sourceChain.generatedTargets.codex.includes(".agents/skills"),
      true,
    );
    assert.deepEqual(plan.writePreview.globalWrites, []);
    assert.ok(plan.writePreview.projectWrites.some((file) => file.relPath === "AGENTS.md"));
    assert.equal(plan.writePreview.backup.requiredBeforeApply, false);
    assert.equal(plan.writePreview.backup.backupRootPattern, ".meta-kim/backups/project-bootstrap/<timestamp>");
    assert.equal(plan.writePreview.rollbackPlan.availableAfterApply, true);
    assert.equal(
      plan.writePreview.rollbackPlan.stateManifest,
      ".meta-kim/state/default/project-bootstrap.json",
    );
    assert.equal(plan.choiceSurface.required, true);
    assert.equal(plan.choiceSurface.trigger, "runtime_native_choice_required_before_apply");
    assert.match(plan.choiceSurface.runtimeRequirement, /AskUserQuestion/);
    assert.match(plan.choiceSurface.runtimeRequirement, /request_user_input/);
    assert.equal(plan.choiceSurface.recommendedOptionId, "apply_project_bootstrap");
    assert.ok(plan.choiceSurface.options.length >= 3);
    assert.match(plan.decisions.defaultTargets, /Claude Code \+ Codex/);
    assert.match(plan.decisions.defaultTargets, /--targets/);
    assert.match(plan.decisions.defaultTargets, /\.meta-kim\/local\.overrides\.json/);
    for (const id of [
      "apply_project_bootstrap",
      "inspect_dry_run_only",
      "skip_this_project",
    ]) {
      const option = plan.choiceSurface.options.find((entry) => entry.id === id);
      assert.ok(option, `${id} option should be present`);
      assert.ok(option.label);
      assert.ok(option.expectedResult);
      assert.ok(option.advantage);
      assert.ok(option.risk);
      assert.ok(option.verificationImpact);
    }

    const byRel = new Map(plan.files.map((file) => [file.relPath, file]));
    assert.equal(
      plan.files.some((file) =>
        file.relPath.includes("same-set-reusable-flow-for-project-file-inventor"),
      ),
      false,
      "project bootstrap must not project internal canonical skills into runtime skill mirrors",
    );
    assert.equal(byRel.get("AGENTS.md")?.mergePolicy, "managed_block_preserve_user_text");
    assert.equal(byRel.get("AGENTS.md")?.action, "merge");
    assert.equal(
      byRel.has(".agents/skills/meta-theory/SKILL.md"),
      true,
      "Codex project bootstrap should use the current .agents/skills project skill root",
    );
    assert.equal(
      byRel.get(".claude/settings.json")?.mergePolicy,
      "additive_preserve_user_state_json",
    );
    assert.equal(
      byRel.get(".codex/hooks.json")?.mergePolicy,
      "additive_preserve_user_state_json",
    );
    if (byRel.has(".codex/config.toml")) {
      assert.equal(byRel.get(".codex/config.toml")?.mergePolicy, "never_touch");
    }
    assert.equal(
      byRel.has(".meta-kim/meta-kim-post-copy.mjs"),
      false,
      "global-first project bootstrap must not copy post-copy executables into the project",
    );

    assert.deepEqual(new Set([]), before);
    assert.equal(existsSync(path.join(projectDir, ".meta-kim")), false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("project bootstrap and explicit cleanup preserve project-owned capabilities and unknown files", () => {
  const projectDir = tempProject();
  try {
    const initial = runBootstrapForTargets(projectDir, "codex", ["--apply"]);
    assert.equal(initial.ok, true);

    const protectedRel = ".agents/skills/meta-theory/SKILL.md";
    const ordinaryRel = ".agents/skills/meta-theory/references/dev-governance.md";
    const unknownRel = ".agents/skills/user-owned-local/SKILL.md";
    const protectedPath = path.join(projectDir, ...protectedRel.split("/"));
    const ordinaryPath = path.join(projectDir, ...ordinaryRel.split("/"));
    const unknownPath = path.join(projectDir, ...unknownRel.split("/"));
    const protectedContent = "# project-owned capability\n";
    const unknownContent = "# unknown user file\n";
    writeFileSync(protectedPath, protectedContent);
    writeFileSync(ordinaryPath, "# stale managed projection\n");
    mkdirSync(path.dirname(unknownPath), { recursive: true });
    writeFileSync(unknownPath, unknownContent);

    const ownershipPath = path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-capabilities.json",
    );
    writeFileSync(
      ownershipPath,
      `${JSON.stringify({
        schemaVersion: "meta-kim-project-capabilities-v0.1",
        ownershipScope: "project_runtime_sedimentation",
        dependencyUpdatePolicy: "preserve_project_copies",
        capabilities: [
          {
            capabilityKey: "codex:skill:meta-theory",
            runtime: "codex",
            type: "skill",
            id: "meta-theory",
            ownershipClass: "runtime_sedimented_project_copy",
            dependencyUpdatePolicy: "preserve_project_copy",
            files: [{ relPath: protectedRel }],
          },
        ],
      }, null, 2)}\n`,
    );

    const preview = runBootstrapForTargets(projectDir, "codex", ["--dry-run"]);
    const protectedPlan = preview.results[0].files.find(
      (entry) => entry.relPath === protectedRel,
    );
    assert.equal(protectedPlan.action, "skip");
    assert.equal(protectedPlan.skipReason, "protected_project_capability");

    const refreshed = runBootstrapForTargets(projectDir, "codex", ["--apply"]);
    assert.equal(refreshed.ok, true);
    assert.equal(readFileSync(protectedPath, "utf8"), protectedContent);
    assert.equal(
      readFileSync(ordinaryPath, "utf8"),
      "# stale managed projection\n",
      "runtime-sedimented skills protect their whole native skill directory",
    );
    assert.equal(readFileSync(unknownPath, "utf8"), unknownContent);

    const cleanup = runSetup([
      "--cleanup-projects",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(cleanup.status, 0, cleanup.stderr || cleanup.stdout);
    assert.equal(readFileSync(protectedPath, "utf8"), protectedContent);
    assert.equal(readFileSync(unknownPath, "utf8"), unknownContent);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap dry-run previews backup and rollback without writing", () => {
  const projectDir = tempProject();
  try {
    writeFileSync(path.join(projectDir, "AGENTS.md"), "# User Project\n\nKeep this local note.\n");
    mkdirSync(path.join(projectDir, ".codex"), { recursive: true });
    mkdirSync(path.join(projectDir, ".codex", "hooks"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".codex", "hooks", "user-custom-hook.mjs"),
      "console.log('custom hook');\n",
    );
    writeFileSync(
      path.join(projectDir, ".codex", "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ hooks: [{ command: "node user-hook.mjs" }] }],
            Stop: [{ matcher: "*", hooks: [{ command: "node user-stop-hook.mjs" }] }],
          },
        },
        null,
        2,
      ) + "\n",
    );

    const summary = runBootstrap(projectDir, ["--dry-run"]);
    const plan = summary.results[0];
    assert.equal(summary.mode, "dry-run");
    assert.deepEqual(plan.writePreview.globalWrites, []);
    assert.ok(
      plan.writePreview.projectWrites.some(
        (file) => file.relPath === "AGENTS.md" && file.backupBeforeApply === true,
      ),
    );
    assert.ok(
      plan.writePreview.backup.entries.some((entry) => entry.relPath === "AGENTS.md"),
    );
    assert.equal(
      plan.writePreview.projectWrites.some((file) =>
        file.relPath.startsWith(".codex/hooks/"),
      ),
      true,
    );
    assert.match(plan.writePreview.rollbackPlan.policy, /Restore backed-up files/);
    assert.equal(existsSync(path.join(projectDir, ".meta-kim")), false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("meta-kim CLI exposes project bootstrap subcommand for global-first skill use", () => {
  const projectDir = tempProject();
  try {
    const result = runBin([
      "project",
      "bootstrap",
      "--targets",
      "claude,codex",
      "--project-dir",
      projectDir,
      "--dry-run",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = parseTrailingJson(result.stdout);
    assert.equal(summary.mode, "dry-run");
    assert.equal(summary.results[0].sourceChain.binEntrypoint, "bin/meta-kim.mjs");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap apply preserves user text/config, skips Codex project config, and records backup manifest", () => {
  const projectDir = tempProject();
  try {
    writeFileSync(path.join(projectDir, "AGENTS.md"), "# User Project\n\nKeep this local note.\n");
    mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ matcher: "Bash", hooks: [{ command: "node user-claude-hook.mjs" }] }],
          },
          permissions: { allow: ["Bash(npm test)"] },
        },
        null,
        2,
      ) + "\n",
    );
    mkdirSync(path.join(projectDir, ".codex"), { recursive: true });
    mkdirSync(path.join(projectDir, ".codex", "hooks"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".codex", "hooks", "user-custom-hook.mjs"),
      "console.log('custom hook');\n",
    );
    writeFileSync(
      path.join(projectDir, ".codex", "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ hooks: [{ command: "node user-hook.mjs" }] }],
            Stop: [{ matcher: "*", hooks: [{ command: "node user-stop-hook.mjs" }] }],
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { custom: { command: "custom-mcp" } } }, null, 2) + "\n",
    );

    const summary = runBootstrap(projectDir, ["--apply"]);
    assert.equal(summary.mode, "apply");
    assert.equal(summary.results[0].applied, true);

    const agents = readFileSync(path.join(projectDir, "AGENTS.md"), "utf8");
    assert.match(agents, /# User Project/);
    assert.match(agents, /Keep this local note/);
    assert.match(agents, /BEGIN META_KIM MANAGED BLOCK: AGENTS\.md/);
    assert.match(agents, /# Meta_Kim for Codex/);

    const codexHooks = readJson(path.join(projectDir, ".codex", "hooks.json"));
    assert.match(JSON.stringify(codexHooks), /node user-hook\.mjs/);
    assert.match(JSON.stringify(codexHooks), /node user-stop-hook\.mjs/);
    assert.match(
      JSON.stringify(codexHooks),
      /enforce-agent-dispatch|graphify-context|activate-meta-theory-spine|meta-kim-memory-save/,
    );
    assert.doesNotMatch(JSON.stringify(codexHooks), /hookprompt-adapter/);
    const codexStopCommands = codexHooks.hooks.Stop
      .flatMap((entry) => entry.hooks ?? [])
      .map((hook) => hook.command);
    assert.equal(
      codexStopCommands.filter((command) => command.includes("meta-kim-memory-save.mjs")).length,
      1,
    );
    assert.equal(
      codexStopCommands.filter((command) => command.includes("stop-spine-cleanup.mjs")).length,
      1,
    );
    assert.ok(
      codexStopCommands.findIndex((command) => command.includes("meta-kim-memory-save.mjs")) <
      codexStopCommands.findIndex((command) => command.includes("stop-spine-cleanup.mjs")),
    );
    assert.equal(
      existsSync(path.join(projectDir, ".codex", "hooks", "activate-meta-theory-spine.mjs")),
      true,
    );
    assert.equal(
      existsSync(path.join(projectDir, ".codex", "hooks", "project-root.mjs")),
      true,
    );
    assert.equal(
      existsSync(path.join(projectDir, ".codex", "hooks", "enforce-agent-dispatch.mjs")),
      true,
    );
    assert.equal(
      readFileSync(path.join(projectDir, ".claude", "hooks", "meta-kim-memory-save.mjs"), "utf8"),
      readFileSync(
        path.join(
          REPO_ROOT,
          "canonical",
          "runtime-assets",
          "claude",
          "hooks",
          "meta-kim-memory-save.mjs",
        ),
        "utf8",
      ),
    );
    assert.equal(
      readFileSync(path.join(projectDir, ".codex", "hooks", "meta-kim-memory-save.mjs"), "utf8"),
      readFileSync(
        path.join(
          REPO_ROOT,
          "canonical",
          "runtime-assets",
          "shared",
          "hooks",
          "meta-kim-memory-save.mjs",
        ),
        "utf8",
      ),
    );
    assert.equal(
      readFileSync(path.join(projectDir, ".codex", "hooks", "user-custom-hook.mjs"), "utf8"),
      "console.log('custom hook');\n",
    );

    const claudeSettings = readJson(path.join(projectDir, ".claude", "settings.json"));
    assert.match(JSON.stringify(claudeSettings), /node user-claude-hook\.mjs/);
    assert.deepEqual(claudeSettings.permissions.allow, ["Bash(npm test)"]);

    const mcp = readJson(path.join(projectDir, ".mcp.json"));
    assert.equal(mcp.mcpServers.custom.command, "custom-mcp");
    assert.equal(existsSync(path.join(projectDir, ".codex", "config.toml")), false);

    const manifestPath = path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-bootstrap.json",
    );
    const manifest = readJson(manifestPath);
    assert.equal(manifest.schemaVersion, "meta-kim-project-bootstrap-v0.1");
    assert.deepEqual(manifest.activeTargets, ["claude", "codex"]);
    assert.equal(manifest.sourceChain.setupEntrypoint, "setup.mjs --project-bootstrap");
    assert.equal(manifest.protectedMergeDecisions.protectedMerge.includes(".codex/config.toml"), true);
    assert.equal(manifest.backup.created, true);
    assert.deepEqual(
      manifest.managedFiles
        .map((entry) => entry.relPath)
        .filter((relPath) => relPath.endsWith("meta-kim-memory-save.mjs")),
      [
        ".claude/hooks/meta-kim-memory-save.mjs",
        ".codex/hooks/meta-kim-memory-save.mjs",
      ],
    );
    assert.ok(manifest.backup.entries.some((entry) => entry.relPath === "AGENTS.md"));
    assert.equal(
      manifest.backup.entries.some((entry) => entry.relPath === ".codex/hooks.json"),
      true,
    );
    assert.equal(
      manifest.managedFiles.some(
        (entry) => entry.relPath === ".meta-kim/meta-kim-post-copy.mjs",
      ),
      false,
    );

    const currentSummary = runBootstrap(projectDir, ["--dry-run"]);
    const currentPlan = currentSummary.results[0];
    assert.equal(currentPlan.state.status, "ready");
    assert.equal(currentPlan.state.requiresConfirmation, false);
    assert.equal(currentPlan.state.counts.pending, 0);
    assert.equal(currentPlan.writePreview.projectWrites.length, 0);
    assert.equal(currentPlan.writePreview.confirmation.required, false);
    assert.equal(currentPlan.writePreview.backup.requiredBeforeApply, false);
    assert.equal(currentPlan.choiceSurface.required, false);
    assert.equal(currentPlan.choiceSurface.trigger, "no_choice_needed_current");
    assert.equal(
      currentPlan.files.some((file) => file.relPath === ".meta-kim/meta-kim-post-copy.mjs"),
      false,
    );

    const noOpApply = runBootstrap(projectDir, ["--apply"]);
    assert.equal(noOpApply.results[0].applied, false);
    assert.equal(noOpApply.results[0].noOp, true);
    assert.equal(noOpApply.results[0].backup.created, false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap creates AGENTS and CLAUDE only as managed blocks", () => {
  const projectDir = tempProject();
  try {
    runBootstrapForTargets(projectDir, "claude,codex", ["--apply"]);

    const agents = readFileSync(path.join(projectDir, "AGENTS.md"), "utf8");
    const claude = readFileSync(path.join(projectDir, "CLAUDE.md"), "utf8");
    assert.match(agents, /^<!-- BEGIN META_KIM MANAGED BLOCK: AGENTS\.md -->/);
    assert.match(agents, /<!-- END META_KIM MANAGED BLOCK: AGENTS\.md -->\s*$/);
    assert.match(claude, /^<!-- BEGIN META_KIM MANAGED BLOCK: CLAUDE\.md -->/);
    assert.match(claude, /<!-- END META_KIM MANAGED BLOCK: CLAUDE\.md -->\s*$/);
    assert.equal(agents.trimStart().startsWith("# Meta_Kim for Codex"), false);
    assert.equal(claude.trimStart().startsWith("# Meta_Kim for Claude Code"), false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("global cleanup preserves header-matching AGENTS and CLAUDE files without exact proof", () => {
  const projectDir = tempProject();
  try {
    writeFileSync(
      path.join(projectDir, "AGENTS.md"),
      [
        readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8")
          .replace("This file is the Codex entrypoint", "This old file was the Codex entrypoint")
          .trimEnd(),
        "",
        "<!-- BEGIN META_KIM MANAGED BLOCK: AGENTS.md -->",
        readFileSync(path.join(REPO_ROOT, "AGENTS.md"), "utf8").trimEnd(),
        "<!-- END META_KIM MANAGED BLOCK: AGENTS.md -->",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(projectDir, "CLAUDE.md"),
      readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8").replace(
        "Claude Code is one runtime projection",
        "This old Claude Code file was one runtime projection",
      ),
      "utf8",
    );

    const result = runSetup([
      "--cleanup-projects",
      "--targets",
      "claude,codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const summary = parseTrailingJson(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(existsSync(path.join(projectDir, "AGENTS.md")), true);
    assert.equal(existsSync(path.join(projectDir, "CLAUDE.md")), true);
    const removed = summary.results.flatMap((entry) => entry.cleanup?.removed ?? []);
    assert.equal(removed.includes("AGENTS.md"), false);
    assert.equal(removed.includes("CLAUDE.md"), false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("project cleanup json output is machine-parseable without log prefix", () => {
  const projectDir = tempProject();
  try {
    runBootstrapForTargets(projectDir, "claude,codex", ["--apply"]);
    const result = runSetup([
      "--project-cleanup",
      "--targets",
      "claude,codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trimStart().startsWith("{"), true);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.resultCount, 1);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("project cleanup final summary is localized in every supported language", () => {
  const projectDir = tempProject();
  try {
    for (const [lang, expected] of [
      ["en", "Meta_Kim project cleanup: complete"],
      ["zh-CN", "Meta_Kim 项目清理：完成"],
      ["ja-JP", "Meta_Kim プロジェクト整理：完了"],
      ["ko-KR", "Meta_Kim 프로젝트 정리: 완료"],
    ]) {
      const result = runSetup([
        "--project-cleanup",
        "--targets",
        "codex",
        "--project-dir",
        projectDir,
        "--lang",
        lang,
      ]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, new RegExp(expected));
    }
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("one project mutation lock blocks bootstrap and cleanup without overwriting the manifest", () => {
  const projectDir = tempProject();
  const transactionDir = path.join(projectDir, ".meta-kim", "transactions");
  const projectMutationLock = path.join(transactionDir, "project-mutation-session.lock.json");
  const manifestPath = path.join(
    projectDir,
    ".meta-kim",
    "state",
    "default",
    "project-bootstrap.json",
  );
  const liveLock = (nonce) => ({
    schemaVersion: "meta-kim-managed-file-lock-v1",
    pid: process.pid,
    nonce,
    createdAt: new Date().toISOString(),
  });
  try {
    mkdirSync(transactionDir, { recursive: true });
    writeFileSync(
      projectMutationLock,
      JSON.stringify(liveLock("bootstrap-holder"), null, 2) + "\n",
      "utf8",
    );
    const blockedBootstrap = runSetup([
      "--project-bootstrap",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--apply",
      "--json",
    ]);
    assert.equal(blockedBootstrap.status, 1, blockedBootstrap.stderr || blockedBootstrap.stdout);
    const blockedBootstrapSummary = JSON.parse(blockedBootstrap.stdout);
    assert.equal(blockedBootstrapSummary.ok, false);
    assert.equal(blockedBootstrapSummary.results[0].error.status, "blocked");
    assert.match(blockedBootstrapSummary.results[0].error.message, /transaction_in_progress/);
    assert.equal(existsSync(projectMutationLock), true, "a second process must not remove the live lock");
    assert.equal(existsSync(manifestPath), false);

    const blockedCleanupDuringBootstrap = runSetup([
      "--project-cleanup",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(blockedCleanupDuringBootstrap.status, 1, blockedCleanupDuringBootstrap.stderr || blockedCleanupDuringBootstrap.stdout);
    assert.equal(JSON.parse(blockedCleanupDuringBootstrap.stdout).results[0].status, "blocked");

    rmSync(projectMutationLock, { force: true });
    const applied = runSetup([
      "--project-bootstrap",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--apply",
      "--json",
    ]);
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    assert.equal(existsSync(manifestPath), true);
    const manifestBeforeBlockedCleanup = readFileSync(manifestPath, "utf8");

    mkdirSync(transactionDir, { recursive: true });
    writeFileSync(
      projectMutationLock,
      JSON.stringify(liveLock("cleanup-holder"), null, 2) + "\n",
      "utf8",
    );
    const blockedCleanup = runSetup([
      "--project-cleanup",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(blockedCleanup.status, 1, blockedCleanup.stderr || blockedCleanup.stdout);
    const blockedCleanupSummary = JSON.parse(blockedCleanup.stdout);
    assert.equal(blockedCleanupSummary.ok, false);
    assert.equal(blockedCleanupSummary.results[0].status, "blocked");
    assert.match(blockedCleanupSummary.results[0].message, /transaction_in_progress/);
    assert.equal(existsSync(projectMutationLock), true, "a second process must not remove the live lock");
    assert.equal(readFileSync(manifestPath, "utf8"), manifestBeforeBlockedCleanup);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("bootstrap and cleanup mutually exclude each other across real processes", async () => {
  const projectDir = tempProject();
  const bootstrapRelease = path.join(
    os.tmpdir(),
    `meta-kim-bootstrap-release-${process.pid}-${Date.now()}`,
  );
  const cleanupRelease = path.join(
    os.tmpdir(),
    `meta-kim-cleanup-release-${process.pid}-${Date.now()}`,
  );
  const sharedLock = path.join(
    projectDir,
    ".meta-kim",
    "transactions",
    "project-mutation-session.lock.json",
  );
  const bootstrapArgs = [
    "--project-bootstrap",
    "--targets",
    "codex",
    "--project-dir",
    projectDir,
    "--apply",
    "--json",
  ];
  const cleanupArgs = [
    "--project-cleanup",
    "--targets",
    "codex",
    "--project-dir",
    projectDir,
    "--json",
  ];
  try {
    const bootstrapHolder = spawnSetup(bootstrapArgs, {
      env: {
        ...process.env,
        META_KIM_TEST_SESSION_LOCK_RELEASE_FILE: bootstrapRelease,
      },
    });
    const bootstrapResultPromise = collectSpawnResult(bootstrapHolder);
    await waitForPath(sharedLock);
    const cleanupBlocked = runSetup(cleanupArgs);
    assert.equal(cleanupBlocked.status, 1, cleanupBlocked.stderr || cleanupBlocked.stdout);
    assert.equal(JSON.parse(cleanupBlocked.stdout).results[0].status, "blocked");
    writeFileSync(bootstrapRelease, "release\n", "utf8");
    const bootstrapResult = await bootstrapResultPromise;
    assert.equal(bootstrapResult.status, 0, bootstrapResult.stderr || bootstrapResult.stdout);

    const cleanupHolder = spawnSetup(cleanupArgs, {
      env: {
        ...process.env,
        META_KIM_TEST_SESSION_LOCK_RELEASE_FILE: cleanupRelease,
      },
    });
    const cleanupResultPromise = collectSpawnResult(cleanupHolder);
    await waitForPath(sharedLock);
    const bootstrapBlocked = runSetup(bootstrapArgs);
    assert.equal(bootstrapBlocked.status, 1, bootstrapBlocked.stderr || bootstrapBlocked.stdout);
    assert.equal(JSON.parse(bootstrapBlocked.stdout).results[0].error.status, "blocked");
    writeFileSync(cleanupRelease, "release\n", "utf8");
    const cleanupResult = await cleanupResultPromise;
    assert.equal(cleanupResult.status, 0, cleanupResult.stderr || cleanupResult.stdout);
  } finally {
    rmSync(bootstrapRelease, { force: true });
    rmSync(cleanupRelease, { force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("global cleanup preserves signed Meta_Kim residue without manifest ownership proof", () => {
  const projectDir = tempProject();
  try {
    const generatedSkillDir = path.join(
      projectDir,
      ".agents",
      "skills",
      "same-set-reusable-flow-for-project-file-inventor",
    );
    const userSkillDir = path.join(projectDir, ".agents", "skills", "user-local-skill");
    mkdirSync(generatedSkillDir, { recursive: true });
    mkdirSync(userSkillDir, { recursive: true });
    writeFileSync(
      path.join(generatedSkillDir, "SKILL.md"),
      [
        "---",
        "name: same-set-reusable-flow-for-project-file-inventor",
        "author: Meta_Kim",
        "sourceGapId: gap-create-skill-same-set-reusable-flow",
        "---",
        "",
        "# Generated",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(userSkillDir, "SKILL.md"),
      "---\nname: user-local-skill\n---\n\n# User local skill\n",
      "utf8",
    );

    mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
    mkdirSync(path.join(projectDir, ".claude", "skills", "empty-local", "evals"), {
      recursive: true,
    });
    mkdirSync(path.join(projectDir, ".codex"), { recursive: true });
    mkdirSync(path.join(projectDir, ".cursor"), { recursive: true });
    mkdirSync(path.join(projectDir, "openclaw"), { recursive: true });
    mkdirSync(path.join(projectDir, "openclaw", "hooks", "mcp-memory-service"), {
      recursive: true,
    });
    mkdirSync(path.join(projectDir, "openclaw", "workspaces", "meta-warden", ".openclaw"), {
      recursive: true,
    });
    mkdirSync(path.join(projectDir, ".meta-kim", "state", "default"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".claude", "settings.json"),
      readFileSync(
        path.join(REPO_ROOT, "canonical", "runtime-assets", "claude", "settings.json"),
        "utf8",
      ),
      "utf8",
    );
    writeFileSync(
      path.join(projectDir, ".codex", "hooks.json"),
      JSON.stringify({ hooks: {} }, null, 2) + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(projectDir, ".mcp.json"),
      JSON.stringify({ mcpServers: {} }, null, 2) + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(projectDir, ".cursor", "hooks.json"),
      JSON.stringify({ version: 1, hooks: {} }, null, 2) + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(projectDir, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: {} }, null, 2) + "\n",
      "utf8",
    );
    writeFileSync(
      path.join(projectDir, "openclaw", "openclaw.template.json"),
      readFileSync(
        path.join(
          REPO_ROOT,
          "canonical",
          "runtime-assets",
          "openclaw",
          "openclaw.template.json",
        ),
        "utf8",
      ),
      "utf8",
    );
    writeFileSync(
      path.join(projectDir, "openclaw", "hooks", "mcp-memory-service", "HOOK.md"),
      "---\nname: mcp-memory-service\n---\n\n# MCP Memory Service Bridge\n\nMeta_Kim hook.\n",
      "utf8",
    );
    writeFileSync(
      path.join(projectDir, ".claude", "project-task-state.json"),
      JSON.stringify({
        sessions: [{ note: "auto-save from Stop hook" }],
        tags: ["meta_kim"],
      }),
      "utf8",
    );
    writeFileSync(
      path.join(projectDir, ".meta-kim", "state", "default", "project-bootstrap.json"),
      JSON.stringify({ schemaVersion: "meta-kim-project-bootstrap-v0.1" }),
      "utf8",
    );

    const result = runSetup([
      "--cleanup-projects",
      "--targets",
      "claude,codex,cursor,openclaw",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const summary = parseTrailingJson(result.stdout);
    assert.equal(summary.ok, true);
    const removed = summary.results.flatMap((entry) => entry.cleanup?.removed ?? []);
    assert.equal(existsSync(generatedSkillDir), true);
    assert.equal(existsSync(userSkillDir), true);
    assert.equal(existsSync(path.join(projectDir, ".claude", "settings.json")), true);
    assert.equal(existsSync(path.join(projectDir, ".claude", "skills", "empty-local")), true);
    assert.equal(existsSync(path.join(projectDir, ".codex", "hooks.json")), true);
    assert.equal(existsSync(path.join(projectDir, ".mcp.json")), true);
    assert.equal(existsSync(path.join(projectDir, ".cursor")), true);
    assert.equal(
      existsSync(path.join(projectDir, "openclaw", "hooks", "mcp-memory-service")),
      true,
    );
    assert.equal(existsSync(path.join(projectDir, ".meta-kim")), true);
    assert.equal(
      existsSync(path.join(projectDir, ".claude", "project-task-state.json")),
      true,
    );
    assert.equal(
      removed.includes(".agents/skills/same-set-reusable-flow-for-project-file-inventor"),
      false,
    );
    const skipped = summary.results.flatMap((entry) => entry.cleanup?.skipped ?? []);
    assert.ok(
      skipped.some(
        (item) =>
          item.relPath === ".agents/skills/same-set-reusable-flow-for-project-file-inventor" &&
          item.reason === "signature_only_ownership_unproven_preserved",
      ),
    );
    assert.equal(removed.includes(".claude/settings.json"), false);
    assert.equal(removed.includes(".meta-kim"), false);
    assert.ok(
      skipped.some(
        (item) =>
          item.relPath === ".claude/project-task-state.json" &&
          item.reason === "local_state_ownership_unproven_preserved",
      ),
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("global cleanup removes manifest-and-hash-proven generated directories with backups", () => {
  const projectDir = tempProject();
  try {
    const skillRel = ".agents/skills/generated-meta-kim/SKILL.md";
    const hookRel = "openclaw/hooks/mcp-memory-service/HOOK.md";
    const skillPath = path.join(projectDir, ...skillRel.split("/"));
    const hookPath = path.join(projectDir, ...hookRel.split("/"));
    mkdirSync(path.dirname(skillPath), { recursive: true });
    mkdirSync(path.dirname(hookPath), { recursive: true });
    writeFileSync(
      skillPath,
      "---\nname: generated-meta-kim\nauthor: Meta_Kim\n---\n\n# Generated\n",
      "utf8",
    );
    writeFileSync(hookPath, "# Meta_Kim mcp-memory-service hook\n", "utf8");
    const manifestPath = path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-bootstrap.json",
    );
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: "meta-kim-project-bootstrap-v0.1",
          managedFiles: [
            { relPath: skillRel, contentHash: sha256File(skillPath) },
            { relPath: hookRel, contentHash: sha256File(hookPath) },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const result = runSetup([
      "--project-cleanup",
      "--targets",
      "codex,openclaw",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    const cleanup = summary.results[0].cleanup;
    assert.equal(existsSync(path.dirname(skillPath)), false);
    assert.equal(existsSync(path.dirname(hookPath)), false);
    assert.ok(cleanup.removed.includes(".agents/skills/generated-meta-kim"));
    assert.ok(cleanup.removed.includes("openclaw/hooks/mcp-memory-service"));
    assert.ok(
      cleanup.backups.some(
        (item) => item.relPath === ".agents/skills/generated-meta-kim",
      ),
    );
    assert.ok(
      cleanup.backups.some(
        (item) => item.relPath === "openclaw/hooks/mcp-memory-service",
      ),
    );
    assert.ok(cleanup.backups.every((item) => item.sourceHash === item.backupHash));
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("project cleanup rejects a runtime-root junction before reading or deleting outside", () => {
  const projectDir = tempProject();
  const outsideDir = tempProject();
  try {
    const externalSkill = path.join(outsideDir, "generated-meta-kim");
    const externalSkillFile = path.join(externalSkill, "SKILL.md");
    mkdirSync(externalSkill, { recursive: true });
    writeFileSync(
      externalSkillFile,
      "---\nname: generated-meta-kim\nauthor: Meta_Kim\n---\n",
      "utf8",
    );
    mkdirSync(path.join(projectDir, ".agents"), { recursive: true });
    symlinkSync(
      outsideDir,
      path.join(projectDir, ".agents", "skills"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const manifestPath = path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-bootstrap.json",
    );
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "meta-kim-project-bootstrap-v0.1",
        managedFiles: [{
          relPath: ".agents/skills/generated-meta-kim/SKILL.md",
          contentHash: sha256File(externalSkillFile),
        }],
      }, null, 2) + "\n",
      "utf8",
    );

    const result = runSetup([
      "--project-cleanup",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(existsSync(externalSkillFile), true);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, false);
    assert.equal(summary.results[0].status, "blocked");
    assert.equal(existsSync(manifestPath), true);
    assert.ok(
      summary.results[0].cleanup.skipped.some(
        (item) =>
          item.relPath === ".agents/skills" &&
          item.reason === "unsafe_realpath_or_link_preserved",
      ),
    );
    assert.ok(
      summary.results[0].retryableIssues.some(
        (item) => item.reason === "unsafe_realpath_or_link_preserved",
      ),
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("project cleanup rejects an empty hook-root junction before reading outside and retains its manifest", () => {
  const projectDir = tempProject();
  const outsideDir = tempProject();
  try {
    const hookRoot = path.join(projectDir, ".codex", "hooks");
    mkdirSync(path.dirname(hookRoot), { recursive: true });
    symlinkSync(
      outsideDir,
      hookRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const manifestPath = path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-bootstrap.json",
    );
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "meta-kim-project-bootstrap-v0.1",
        managedFiles: [{
          relPath: ".codex/hooks/activate-meta-theory-spine.mjs",
          contentHash: "a".repeat(64),
        }],
      }, null, 2) + "\n",
      "utf8",
    );

    const result = runSetup([
      "--project-cleanup",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, false);
    assert.equal(summary.results[0].status, "blocked");
    assert.equal(existsSync(hookRoot), true);
    assert.equal(existsSync(outsideDir), true);
    assert.equal(existsSync(manifestPath), true);
    assert.ok(
      summary.results[0].cleanup.skipped.some(
        (item) =>
          item.relPath === ".codex/hooks" &&
          item.reason === "unsafe_realpath_or_link_preserved",
      ),
      JSON.stringify(summary.results[0].cleanup.skipped, null, 2),
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("project cleanup reports backup failures as partial and preserves its retry manifest", () => {
  const projectDir = tempProject();
  try {
    const assetRel = ".agents/skills/generated-meta-kim/SKILL.md";
    const assetPath = path.join(projectDir, ...assetRel.split("/"));
    const manifestPath = path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-bootstrap.json",
    );
    mkdirSync(path.dirname(assetPath), { recursive: true });
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(assetPath, "# Generated by Meta_Kim\n", "utf8");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "meta-kim-project-bootstrap-v0.1",
        managedFiles: [{ relPath: assetRel, contentHash: sha256File(assetPath) }],
      }, null, 2) + "\n",
      "utf8",
    );
    writeFileSync(path.join(projectDir, ".meta-kim", "backups"), "blocked\n", "utf8");

    const result = runSetup([
      "--project-cleanup",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, false);
    assert.equal(summary.results[0].status, "partial");
    assert.equal(existsSync(assetPath), true);
    assert.equal(existsSync(manifestPath), true);
    assert.ok(
      summary.results[0].retryableIssues.some(
        (item) => item.reason === "backup_failed_preserved",
      ),
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("project cleanup removes an exact managed file but reports drift as partial and retains the manifest", () => {
  const projectDir = tempProject();
  try {
    const exactRel = ".codex/hooks/activate-meta-theory-spine.mjs";
    const driftRel = ".codex/hooks/project-root.mjs";
    const exactPath = path.join(projectDir, ...exactRel.split("/"));
    const driftPath = path.join(projectDir, ...driftRel.split("/"));
    const manifestPath = path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-bootstrap.json",
    );
    mkdirSync(path.dirname(exactPath), { recursive: true });
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(exactPath, "// exact managed hook\n", "utf8");
    writeFileSync(driftPath, "// original managed resolver\n", "utf8");
    const driftManifestHash = sha256File(driftPath);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "meta-kim-project-bootstrap-v0.1",
        managedFiles: [
          { relPath: exactRel, contentHash: sha256File(exactPath) },
          { relPath: driftRel, contentHash: driftManifestHash },
        ],
      }, null, 2) + "\n",
      "utf8",
    );
    writeFileSync(driftPath, "// user changed this resolver\n", "utf8");

    const result = runSetup([
      "--project-cleanup",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, false);
    assert.equal(summary.results[0].status, "partial");
    assert.equal(existsSync(exactPath), false);
    assert.equal(readFileSync(driftPath, "utf8"), "// user changed this resolver\n");
    assert.equal(existsSync(manifestPath), true);
    assert.ok(
      summary.results[0].retryableIssues.some(
        (item) =>
          item.relPath === driftRel &&
          item.reason === "manifest_hash_mismatch_preserved",
      ),
      JSON.stringify(summary.results[0].retryableIssues, null, 2),
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("project cleanup removes project task state only with manifest-and-hash proof", () => {
  const projectDir = tempProject();
  try {
    const stateRel = ".claude/project-task-state.json";
    const statePath = path.join(projectDir, ...stateRel.split("/"));
    const manifestPath = path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-bootstrap.json",
    );
    mkdirSync(path.dirname(statePath), { recursive: true });
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ sessions: [{ note: "auto-save from Stop hook" }], tags: ["meta_kim"] }),
      "utf8",
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: "meta-kim-project-bootstrap-v0.1",
        managedFiles: [{ relPath: stateRel, contentHash: sha256File(statePath) }],
      }, null, 2) + "\n",
      "utf8",
    );

    const result = runSetup([
      "--project-cleanup",
      "--targets",
      "claude",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(existsSync(statePath), false);
    assert.ok(summary.results[0].cleanup.removed.includes(stateRel));
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("project cleanup preserves unowned empty configs and invalid user manifest", () => {
  const projectDir = tempProject();
  try {
    const hooksPath = path.join(projectDir, ".codex", "hooks.json");
    const manifestPath = path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-bootstrap.json",
    );
    mkdirSync(path.dirname(hooksPath), { recursive: true });
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(hooksPath, "{\"hooks\":{}}\n", "utf8");
    writeFileSync(manifestPath, "{\"owner\":\"user\"}\n", "utf8");
    const result = runSetup([
      "--project-cleanup",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(hooksPath, "utf8"), "{\"hooks\":{}}\n");
    assert.equal(readFileSync(manifestPath, "utf8"), "{\"owner\":\"user\"}\n");
    const skipped = JSON.parse(result.stdout).results[0].cleanup.skipped;
    assert.ok(skipped.some((item) => item.reason === "config_ownership_unproven_preserved"));
    assert.ok(skipped.some((item) => item.reason === "invalid_or_user_manifest_preserved"));
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("project bootstrap choice surface is localized in all supported locales", () => {
  const projectDir = tempProject();
  try {
    for (const [lang, expectedHeader, reasonFragment] of [
      ["en", "Project bootstrap", "Required project"],
      ["zh-CN", "项目初始化", "缺少必需"],
      ["ja-JP", "プロジェクト初期化", "不足しています"],
      ["ko-KR", "프로젝트 초기화", "없습니다"],
    ]) {
      const result = runSetup([
        "--project-bootstrap",
        "--targets",
        "codex",
        "--project-dir",
        projectDir,
        "--lang",
        lang,
        "--dry-run",
        "--json",
      ]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.results[0].choiceSurface.header, expectedHeader);
      assert.match(summary.results[0].state.confirmationReason, new RegExp(reasonFragment));
      assert.match(summary.results[0].choiceSurface.question, new RegExp(reasonFragment));
    }
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("global cleanup preserves git-tracked Meta_Kim residue for explicit migration", () => {
  const projectDir = tempProject();
  try {
    const generatedSkillDir = path.join(
      projectDir,
      ".agents",
      "skills",
      "same-set-reusable-flow-for-project-file-inventor",
    );
    mkdirSync(generatedSkillDir, { recursive: true });
    writeFileSync(
      path.join(generatedSkillDir, "SKILL.md"),
      "---\nname: same-set-reusable-flow-for-project-file-inventor\nauthor: Meta_Kim\n---\n",
      "utf8",
    );
    const trackedHookPath = path.join(
      projectDir,
      ".codex",
      "hooks",
      "activate-meta-theory-spine.mjs",
    );
    mkdirSync(path.dirname(trackedHookPath), { recursive: true });
    writeFileSync(trackedHookPath, "console.log('tracked hook');\n", "utf8");
    const trackedHooksConfigPath = path.join(projectDir, ".codex", "hooks.json");
    writeFileSync(
      trackedHooksConfigPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ command: "node .codex/hooks/activate-meta-theory-spine.mjs" }],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const init = spawnSync("git", ["init"], {
      cwd: projectDir,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(init.status, 0, init.stderr);
    const add = spawnSync("git", ["add", "."], {
      cwd: projectDir,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(add.status, 0, add.stderr);

    const result = runSetup([
      "--cleanup-projects",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const summary = parseTrailingJson(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(existsSync(path.join(generatedSkillDir, "SKILL.md")), true);
    assert.equal(readFileSync(trackedHookPath, "utf8"), "console.log('tracked hook');\n");
    assert.match(
      readFileSync(trackedHooksConfigPath, "utf8"),
      /activate-meta-theory-spine\.mjs/,
    );
    const skipped = summary.results.flatMap((entry) => entry.cleanup?.skipped ?? []);
    assert.ok(
      skipped.some(
        (item) =>
          item.relPath === ".agents/skills/same-set-reusable-flow-for-project-file-inventor" &&
          item.reason === "git_tracked_preserved",
      ),
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("global cleanup preserves unknown empty runtime shell directories", () => {
  const projectDir = tempProject();
  try {
    mkdirSync(path.join(projectDir, ".claude", "skills", "laojin", "evals"), {
      recursive: true,
    });
    mkdirSync(path.join(projectDir, ".agents"), { recursive: true });
    mkdirSync(path.join(projectDir, ".codex"), { recursive: true });

    const result = runSetup([
      "--cleanup-projects",
      "--targets",
      "claude,codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(projectDir, ".claude")), true);
    assert.equal(existsSync(path.join(projectDir, ".agents")), true);
    assert.equal(existsSync(path.join(projectDir, ".codex")), true);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap projects Codex hook files and preserves user hooks", () => {
  const projectDir = tempProject();
  const userHookPath = path.join(
    projectDir,
    ".codex",
    "hooks",
    "user-custom-hook.mjs",
  );
  try {
    mkdirSync(path.dirname(userHookPath), { recursive: true });
    writeFileSync(userHookPath, "console.log('user hook stays');\n", "utf8");

    const dryRun = runBootstrapForTargets(projectDir, "codex", ["--dry-run"]);
    const plan = dryRun.results[0];
    assert.notEqual(plan.state.status, "conflict");
    assert.equal(plan.state.counts.conflict, 0);
    assert.equal(plan.writePreview.projectConflicts.length, 0);
    assert.equal(
      plan.writePreview.projectWrites.some(
        (file) => file.relPath === ".codex/hooks/activate-meta-theory-spine.mjs",
      ),
      true,
    );

    const apply = runSetup([
      "--project-bootstrap",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--json",
      "--apply",
    ]);
    assert.equal(apply.status, 0, apply.stderr || apply.stdout);
    assert.equal(readFileSync(userHookPath, "utf8"), "console.log('user hook stays');\n");
    assert.equal(
      existsSync(path.join(projectDir, ".codex", "hooks", "activate-meta-theory-spine.mjs")),
      true,
    );
    assert.equal(
      existsSync(path.join(projectDir, ".codex", "hooks", "graphify-context.mjs")),
      true,
    );
    const hookResult = spawnSync(
      process.execPath,
      [path.join(projectDir, ".codex", "hooks", "activate-meta-theory-spine.mjs")],
      {
        cwd: projectDir,
        input: JSON.stringify({
          tool_name: "Skill",
          tool_input: { skill_name: "meta-theory" },
        }),
        encoding: "utf8",
        env: { ...process.env, META_KIM_POST_COPY_AUTO: "off" },
      },
    );
    assert.equal(hookResult.status, 0, hookResult.stderr || hookResult.stdout);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap blocks replacement of unmanifested project hooks", () => {
  const projectDir = tempProject();
  try {
    mkdirSync(path.join(projectDir, ".claude", "hooks"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".claude", "hooks", "hook-i18n.mjs"),
      "console.log('legacy');\n",
      "utf8",
    );
    mkdirSync(path.join(projectDir, ".codex", "hooks"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".codex", "hooks", "activate-meta-theory-spine.mjs"),
      "console.log('legacy');\n",
      "utf8",
    );
    mkdirSync(path.join(projectDir, ".cursor", "hooks"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".cursor", "hooks", "graphify-context.mjs"),
      "console.log('legacy');\n",
      "utf8",
    );

    const result = runSetup([
      "--project-bootstrap",
      "--targets",
      "claude,codex,cursor",
      "--project-dir",
      projectDir,
      "--apply",
      "--json",
    ]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, false);
    assert.equal(existsSync(path.join(projectDir, ".claude", "hooks")), true);
    assert.equal(existsSync(path.join(projectDir, ".codex", "hooks")), true);
    assert.equal(existsSync(path.join(projectDir, ".cursor", "hooks")), true);
    assert.equal(
      readFileSync(path.join(projectDir, ".codex", "hooks", "activate-meta-theory-spine.mjs"), "utf8"),
      "console.log('legacy');\n",
    );
    assert.equal(
      readFileSync(path.join(projectDir, ".cursor", "hooks", "graphify-context.mjs"), "utf8"),
      "console.log('legacy');\n",
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap removes stale manifest-managed project capability assets only", () => {
  const projectDir = tempProject();
  const staleRel = ".codex/skills/legacy-meta-kim/SKILL.md";
  const userRel = ".codex/skills/user-skill/SKILL.md";
  try {
    runBootstrapForTargets(projectDir, "codex", ["--apply"]);

    const stalePath = path.join(projectDir, ...staleRel.split("/"));
    const userPath = path.join(projectDir, ...userRel.split("/"));
    mkdirSync(path.dirname(stalePath), { recursive: true });
    mkdirSync(path.dirname(userPath), { recursive: true });
    writeFileSync(stalePath, "# Legacy Meta_Kim projection\n", "utf8");
    writeFileSync(userPath, "# User project skill\n", "utf8");

    const manifestPath = path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-bootstrap.json",
    );
    const manifest = readJson(manifestPath);
    manifest.managedFiles.push({
      relPath: staleRel,
      ownership: "manifest_managed",
      action: "create",
      effectiveAction: "unchanged",
      mergePolicy: "generated_projection_create",
      contentHash: sha256File(stalePath),
    });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    const result = runSetup([
      "--project-bootstrap",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--lang",
      "zh",
      "--apply",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /项目级目标已按本次选择重新计算/);
    assert.match(result.stdout, /这是项目目录更新的一部分/);
    assert.doesNotMatch(result.stdout, /Meta_Kim 正转为全局通用能力/);
    assert.match(result.stdout, /Codex skills: 1/);
    assert.equal(existsSync(stalePath), false);
    assert.equal(
      existsSync(path.join(projectDir, ".codex", "skills", "legacy-meta-kim")),
      false,
    );
    assert.equal(readFileSync(userPath, "utf8"), "# User project skill\n");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("project cleanup preserves legacy manifest entries that have no content hash", () => {
  const projectDir = tempProject();
  const staleRel = ".codex/skills/legacy-meta-kim/SKILL.md";
  try {
    runBootstrapForTargets(projectDir, "codex", ["--apply"]);
    const stalePath = path.join(projectDir, ...staleRel.split("/"));
    mkdirSync(path.dirname(stalePath), { recursive: true });
    writeFileSync(stalePath, "# User-modified legacy projection\n", "utf8");
    const manifestPath = path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-bootstrap.json",
    );
    const manifest = readJson(manifestPath);
    manifest.managedFiles.push({ relPath: staleRel, ownership: "manifest_managed" });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    const result = runSetup([
      "--project-cleanup",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--json",
    ]);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, false);
    assert.equal(summary.results[0].status, "partial");
    assert.equal(readFileSync(stalePath, "utf8"), "# User-modified legacy projection\n");
    assert.equal(existsSync(manifestPath), true);
    assert.ok(
      summary.results[0].retryableIssues.some(
        (item) =>
          item.relPath === staleRel &&
          item.reason === "legacy_manifest_missing_hash_preserved",
      ),
      JSON.stringify(summary.results[0].retryableIssues, null, 2),
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap preserves unmanifested legacy Codex project skill root", () => {
  const projectDir = tempProject();
  const legacyRel = ".codex/skills/meta-theory/SKILL.md";
  const userRel = ".codex/skills/user-skill/SKILL.md";
  try {
    const legacyPath = path.join(projectDir, ...legacyRel.split("/"));
    const userPath = path.join(projectDir, ...userRel.split("/"));
    mkdirSync(path.dirname(legacyPath), { recursive: true });
    mkdirSync(path.dirname(userPath), { recursive: true });
    writeFileSync(legacyPath, "# Stale project Meta_Kim skill\n", "utf8");
    writeFileSync(userPath, "# User project skill\n", "utf8");

    const result = runSetup([
      "--project-bootstrap",
      "--targets",
      "codex",
      "--project-dir",
      projectDir,
      "--lang",
      "zh",
      "--apply",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(
      existsSync(path.join(projectDir, ".agents", "skills", "meta-theory", "SKILL.md")),
      true,
    );
    assert.equal(existsSync(path.join(projectDir, ".codex", "skills", "meta-theory")), true);
    assert.equal(readFileSync(userPath, "utf8"), "# User project skill\n");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap merges managed project hook commands into hooks.json", () => {
  const projectDir = tempProject();
  const hooksJsonPath = path.join(projectDir, ".codex", "hooks.json");
  try {
    mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
    writeFileSync(
      hooksJsonPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ hooks: [{ command: "node user-hook.mjs" }] }],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const dryRun = runBootstrapForTargets(projectDir, "codex", ["--dry-run"]);
    const plan = dryRun.results[0];
    assert.notEqual(plan.state.status, "conflict");
    const hooksPlan = plan.files.find((file) => file.relPath === ".codex/hooks.json");
    assert.equal(hooksPlan.effectiveAction, "merge");
    assert.equal(hooksPlan.mergePolicy, "additive_preserve_user_state_json");
    assert.equal(plan.writePreview.projectConflicts.length, 0);

    runBootstrapForTargets(projectDir, "codex", ["--apply"]);
    const merged = readFileSync(hooksJsonPath, "utf8");
    assert.match(merged, /\.codex\/hooks\/activate-meta-theory-spine\.mjs/);
    assert.match(merged, /\.codex\/hooks\/enforce-agent-dispatch\.mjs/);
    assert.match(merged, /user-hook\.mjs/);
    const current = runBootstrapForTargets(projectDir, "codex", ["--dry-run"]);
    assert.equal(current.results[0].state.status, "ready");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap retargeting strips stale project hook config and preserves user hooks", () => {
  const projectDir = tempProject();
  const hooksJsonPath = path.join(projectDir, ".codex", "hooks.json");
  try {
    mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
    writeFileSync(
      hooksJsonPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [{ hooks: [{ command: "node user-hook.mjs" }] }],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    runBootstrapForTargets(projectDir, "claude,codex", ["--apply"]);
    assert.equal(existsSync(path.join(projectDir, ".codex", "hooks")), true);
    assert.match(readFileSync(hooksJsonPath, "utf8"), /\.codex\/hooks\//);

    const summary = runBootstrapForTargets(projectDir, "claude", ["--apply"]);
    assert.equal(summary.ok, true);

    const codexHooks = readFileSync(hooksJsonPath, "utf8");
    assert.match(codexHooks, /user-hook\.mjs/);
    assert.doesNotMatch(codexHooks, /\.codex\/hooks\//);
    assert.equal(existsSync(path.join(projectDir, ".codex", "hooks")), false);
    assert.equal(
      existsSync(path.join(projectDir, ".agents", "skills", "meta-theory")),
      false,
    );

    const manifest = readJson(
      path.join(projectDir, ".meta-kim", "state", "default", "project-bootstrap.json"),
    );
    assert.deepEqual(manifest.activeTargets, ["claude"]);
    assert.ok(
      manifest.cleanup.removed.some((relPath) =>
        relPath.startsWith(".codex/hooks/"),
      ),
    );
    assert.deepEqual(manifest.cleanup.strippedHookConfigs, [".codex/hooks.json"]);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap retargeting removes empty inactive hook folders", () => {
  const projectDir = tempProject();
  try {
    runBootstrapForTargets(projectDir, "claude", ["--apply"]);
    assert.equal(existsSync(path.join(projectDir, ".claude", "hooks")), true);

    const summary = runBootstrapForTargets(projectDir, "codex", ["--apply"]);
    assert.equal(summary.ok, true);
    assert.equal(existsSync(path.join(projectDir, ".claude", "hooks")), false);
    assert.equal(existsSync(path.join(projectDir, ".codex", "hooks")), true);

    const claudeSettings = readFileSync(
      path.join(projectDir, ".claude", "settings.json"),
      "utf8",
    );
    assert.doesNotMatch(claudeSettings, /\.claude\/hooks\//);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap replaces existing managed text block without duplicating user content", () => {
  const projectDir = tempProject();
  try {
    writeFileSync(
      path.join(projectDir, "AGENTS.md"),
      [
        "# User Project",
        "",
        "Keep this local note.",
        "",
        "<!-- BEGIN META_KIM MANAGED BLOCK: AGENTS.md -->",
        "# Old Meta Kim Block",
        "<!-- END META_KIM MANAGED BLOCK: AGENTS.md -->",
        "",
        "Keep this tail.",
        "",
      ].join("\n"),
    );

    const summary = runBootstrap(projectDir, ["--apply"]);
    assert.equal(summary.mode, "apply");

    const agents = readFileSync(path.join(projectDir, "AGENTS.md"), "utf8");
    const managedBlockCount = agents.match(/BEGIN META_KIM MANAGED BLOCK: AGENTS\.md/g)?.length ?? 0;
    assert.equal(managedBlockCount, 1);
    assert.match(agents, /Keep this local note/);
    assert.match(agents, /Keep this tail/);
    assert.match(agents, /# Meta_Kim for Codex/);
    assert.doesNotMatch(agents, /# Old Meta Kim Block/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap does not report success for an unwritable project target", () => {
  const projectDir = tempProject();
  const agentsPath = path.join(projectDir, "AGENTS.md");
  try {
    if (process.platform === "win32") {
      mkdirSync(agentsPath);
    } else {
      writeFileSync(agentsPath, "# User Project\n\nRead-only local note.\n");
      chmodSync(agentsPath, 0o444);
    }

    const result = runSetup([
      "--project-bootstrap",
      "--targets",
      "claude,codex",
      "--project-dir",
      projectDir,
      "--json",
      "--apply",
    ]);
    assert.notEqual(result.status, 0, "unwritable target must not be reported as apply success");
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, false);
    assert.match(summary.results[0].error.message, /EACCES|EPERM|permission|read-only|directory|EISDIR/i);
    assert.match(summary.results[0].error.status, /blocked|failed/);
  } finally {
    try {
      chmodSync(agentsPath, 0o666);
    } catch {}
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap respects target-conditional project projection boundaries", () => {
  const cases = [
    {
      targets: "claude",
      present: ["CLAUDE.md", ".claude/settings.json", ".mcp.json"],
      absent: ["AGENTS.md", ".codex", ".agents", ".cursor", "openclaw"],
    },
    {
      targets: "codex",
      present: ["AGENTS.md", ".codex/hooks.json", ".agents/skills/meta-theory/SKILL.md"],
      absent: ["CLAUDE.md", ".claude", ".cursor", "openclaw"],
    },
    {
      targets: "cursor",
      present: [
        "AGENTS.md",
        ".cursor/hooks.json",
        ".cursor/mcp.json",
        ".cursor/rules",
        ".cursor/skills/meta-theory/SKILL.md",
      ],
      absent: ["CLAUDE.md", ".claude", ".codex", ".agents", "openclaw"],
    },
    {
      targets: "openclaw",
      present: [
        "AGENTS.md",
        "openclaw/openclaw.template.json",
        "openclaw/skills/meta-theory/SKILL.md",
        "openclaw/workspaces",
      ],
      absent: ["CLAUDE.md", ".claude", ".codex", ".agents", ".cursor"],
    },
    {
      targets: "claude,codex",
      present: [
        "CLAUDE.md",
        "AGENTS.md",
        ".claude/settings.json",
        ".codex/hooks.json",
        ".agents/skills/meta-theory/SKILL.md",
        ".mcp.json",
      ],
      absent: [".cursor", "openclaw"],
    },
  ];

  for (const entry of cases) {
    const projectDir = tempProject();
    try {
      const expectedTargets = entry.targets.split(",");
      const dryRun = runBootstrapForTargets(projectDir, entry.targets, ["--dry-run"]);
      assert.equal(dryRun.mode, "dry-run");
      assert.deepEqual(dryRun.results[0].state.activeTargets, expectedTargets);
      assert.deepEqual(dryRun.results[0].writePreview.globalWrites, []);
      assert.equal(existsSync(path.join(projectDir, ".meta-kim")), false);

      runBootstrapForTargets(projectDir, entry.targets, ["--apply"]);
      const manifest = readJson(
        path.join(projectDir, ".meta-kim", "state", "default", "project-bootstrap.json"),
      );
      assert.deepEqual(manifest.activeTargets, expectedTargets);

      for (const relPath of entry.present) {
        assert.equal(
          existsSync(path.join(projectDir, ...relPath.split("/"))),
          true,
          `${entry.targets} should project ${relPath}`,
        );
      }
      for (const relPath of entry.absent) {
        assert.equal(
          existsSync(path.join(projectDir, ...relPath.split("/"))),
          false,
          `${entry.targets} should not project ${relPath}`,
        );
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }
});

test("lazy project bootstrap can project the full compatibility runtime surface when explicitly selected", () => {
  const projectDir = tempProject();
  try {
    runBootstrapForTargets(projectDir, "claude,codex,openclaw,cursor", ["--apply"]);
    assert.equal(existsSync(path.join(projectDir, "CLAUDE.md")), true);
    assert.equal(existsSync(path.join(projectDir, "AGENTS.md")), true);
    assert.equal(existsSync(path.join(projectDir, ".claude", "settings.json")), true);
    assert.equal(existsSync(path.join(projectDir, ".codex", "hooks.json")), true);
    assert.equal(existsSync(path.join(projectDir, ".agents", "skills", "meta-theory")), true);
    assert.equal(existsSync(path.join(projectDir, ".cursor", "hooks.json")), true);
    assert.equal(existsSync(path.join(projectDir, "openclaw", "openclaw.template.json")), true);
    assert.equal(
      existsSync(path.join(projectDir, ".meta-kim", "state", "default", "project-bootstrap.json")),
      true,
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap detects stale previous manifest before update", () => {
  const projectDir = tempProject();
  try {
    const manifestDir = path.join(projectDir, ".meta-kim", "state", "default");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      path.join(manifestDir, "project-bootstrap.json"),
      JSON.stringify(
        {
          schemaVersion: "meta-kim-project-bootstrap-v0.1",
          metaKimVersion: "0.0.0",
          appliedAt: "2026-01-01T00:00:00.000Z",
          activeTargets: ["claude"],
        },
        null,
        2,
      ) + "\n",
    );

    const summary = runBootstrap(projectDir, ["--dry-run"]);
    assert.equal(summary.results[0].state.status, "stale");
    assert.equal(summary.results[0].state.requiresConfirmation, true);
    assert.equal(summary.results[0].state.previousManifest.metaKimVersion, "0.0.0");

    const update = runBootstrap(projectDir, ["--apply"]);
    assert.equal(update.mode, "apply");
    assert.equal(update.results[0].applied, true);

    const current = runBootstrap(projectDir, ["--dry-run"]);
    assert.equal(current.results[0].state.status, "ready");
    assert.equal(current.results[0].state.requiresConfirmation, false);
    assert.equal(current.results[0].state.counts.pending, 0);
    assert.equal(current.results[0].writePreview.projectWrites.length, 0);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap treats equivalent files without manifest as confirmation-only", () => {
  const projectDir = tempProject();
  try {
    runBootstrap(projectDir, ["--apply"]);
    rmSync(path.join(projectDir, ".meta-kim", "state"), {
      recursive: true,
      force: true,
    });

    const summary = runBootstrap(projectDir, ["--dry-run"]);
    const plan = summary.results[0];
    assert.equal(plan.state.status, "ready_with_existing_config");
    assert.equal(plan.state.requiresConfirmation, true);
    assert.equal(plan.state.counts.pending, 0);
    assert.equal(plan.writePreview.projectWrites.length, 0);
    assert.equal(plan.writePreview.manifestWrite.requiredBeforeReady, true);
    assert.equal(plan.choiceSurface.required, true);
    assert.match(plan.choiceSurface.question, /Pending project writes: 0/);

    const rewriteManifest = runBootstrap(projectDir, ["--apply"]);
    assert.equal(rewriteManifest.results[0].applied, true);
    const current = runBootstrap(projectDir, ["--dry-run"]);
    assert.equal(current.results[0].state.status, "ready");
    assert.equal(current.results[0].state.requiresConfirmation, false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap does not manage project-local post-copy executable", () => {
  const projectDir = tempProject();
  try {
    runBootstrap(projectDir, ["--apply"]);

    const summary = runBootstrap(projectDir, ["--dry-run"]);
    const plan = summary.results[0];
    assert.equal(plan.state.status, "ready");
    assert.equal(plan.state.requiresConfirmation, false);
    assert.equal(
      plan.files.some((file) => file.relPath === ".meta-kim/meta-kim-post-copy.mjs"),
      false,
    );
    assert.equal(
      existsSync(path.join(projectDir, ".meta-kim", "meta-kim-post-copy.mjs")),
      false,
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap detects active target changes separately from version updates", () => {
  const projectDir = tempProject();
  try {
    runBootstrapForTargets(projectDir, "claude", ["--apply"]);

    const summary = runBootstrapForTargets(projectDir, "claude,codex", ["--dry-run"]);
    const plan = summary.results[0];
    assert.equal(plan.state.status, "target_scope_changed");
    assert.equal(plan.state.requiresConfirmation, true);
    assert.deepEqual(plan.state.previousManifest.activeTargets, ["claude"]);
    assert.equal(plan.state.previousManifest.targetChanged, true);
    assert.ok(plan.writePreview.projectWrites.some((file) => file.relPath === "AGENTS.md"));

    runBootstrapForTargets(projectDir, "claude,codex", ["--apply"]);
    const current = runBootstrapForTargets(projectDir, "claude,codex", ["--dry-run"]);
    assert.equal(current.results[0].state.status, "ready");
    assert.equal(current.results[0].state.requiresConfirmation, false);
    assert.equal(current.results[0].state.counts.pending, 0);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap refreshes manifest-managed drift with a transaction backup", () => {
  const projectDir = tempProject();
  try {
    runBootstrap(projectDir, ["--apply"]);
    const hookPath = path.join(
      projectDir,
      ".codex",
      "hooks",
      "enforce-agent-dispatch.mjs",
    );
    writeFileSync(hookPath, "// drifted local hook mirror\n", "utf8");

    const summary = runBootstrap(projectDir, ["--dry-run"]);
    const plan = summary.results[0];
    assert.equal(plan.state.status, "repair_required");
    assert.equal(plan.state.requiresConfirmation, true);
    assert.ok(
      plan.writePreview.projectWrites.some(
        (file) =>
          file.relPath === ".codex/hooks/enforce-agent-dispatch.mjs" &&
          file.action === "replace" &&
          file.backupBeforeApply === true,
      ),
    );

    const apply = runSetup([
      "--project-bootstrap",
      "--targets",
      "claude,codex",
      "--project-dir",
      projectDir,
      "--apply",
      "--json",
    ]);
    assert.equal(apply.status, 0);
    assert.deepEqual(
      readFileSync(hookPath),
      readFileSync(
        path.join(
          REPO_ROOT,
          "canonical",
          "runtime-assets",
          "claude",
          "hooks",
          "enforce-agent-dispatch.mjs",
        ),
      ),
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("lazy project bootstrap treats corrupt manifest as needing confirmation but not file rewrites", () => {
  const projectDir = tempProject();
  try {
    runBootstrap(projectDir, ["--apply"]);
    const manifestPath = path.join(
      projectDir,
      ".meta-kim",
      "state",
      "default",
      "project-bootstrap.json",
    );
    writeFileSync(manifestPath, "{not json\n", "utf8");

    const summary = runBootstrap(projectDir, ["--dry-run"]);
    const plan = summary.results[0];
    assert.equal(plan.state.status, "ready_with_existing_config");
    assert.equal(plan.state.requiresConfirmation, true);
    assert.equal(plan.state.previousManifest, null);
    assert.equal(plan.state.counts.pending, 0);
    assert.equal(plan.writePreview.projectWrites.length, 0);

    runBootstrap(projectDir, ["--apply"]);
    const current = runBootstrap(projectDir, ["--dry-run"]);
    assert.equal(current.results[0].state.status, "ready");
    assert.equal(current.results[0].state.requiresConfirmation, false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
