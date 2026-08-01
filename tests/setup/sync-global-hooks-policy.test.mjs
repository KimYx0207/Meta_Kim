import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { recordSetupRuntimeExecutableBindings } from "../../scripts/runtime-executable-binding.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "sync-global-meta-theory.mjs");
const PROJECTION_PACKAGE_RECEIPT_PURPOSE =
  "primary-runtime-global-projection-package-runtime-bundle:receipt";

function normalizedPathText(value) {
  const normalized = String(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function stablePackageRootFromManifest(root) {
  const manifest = JSON.parse(
    await readFile(path.join(root, ".meta-kim", "install-manifest.json"), "utf8"),
  );
  const receiptEntry = manifest.entries.find((entry) =>
    entry.source === "sync-global-meta-theory" &&
    entry.purpose === PROJECTION_PACKAGE_RECEIPT_PURPOSE &&
    entry.kind === "file"
  );
  assert.ok(receiptEntry, "global manifest must identify the stable projection package receipt");
  const receipt = JSON.parse(await readFile(receiptEntry.path, "utf8"));
  return path.resolve(path.dirname(receiptEntry.path), receipt.packageRootRelative);
}

function assertUsesStablePackageRoot(content, stablePackageRoot, label) {
  const normalized = normalizedPathText(content);
  assert.ok(
    normalized.includes(normalizedPathText(stablePackageRoot)),
    `${label} must reference the manifest-authoritative stable package root`,
  );
  assert.equal(
    normalized.includes(normalizedPathText(REPO_ROOT)),
    false,
    `${label} must not retain the source checkout root`,
  );
}

function hookCommands(config) {
  return Object.values(config.hooks ?? {}).flatMap((blocks) =>
    (blocks ?? []).flatMap((block) => block.hooks ?? [])
  ).map((hook) => hook.command).filter((command) => typeof command === "string");
}

function assertHookConfigUsesStablePackageRoot(config, stablePackageRoot, label) {
  const commands = hookCommands(config).map(normalizedPathText);
  assert.ok(
    commands.some((command) => command.includes(normalizedPathText(stablePackageRoot))),
    `${label} must reference the manifest-authoritative stable package root`,
  );
  assert.equal(
    commands.some((command) => command.includes(normalizedPathText(REPO_ROOT))),
    false,
    `${label} must not retain the source checkout root`,
  );
}

async function withTempRuntimeHomes(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-global-sync-"));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    META_KIM_CLAUDE_HOME: path.join(root, "claude"),
    META_KIM_CODEX_HOME: path.join(root, "codex"),
    META_KIM_OPENCLAW_HOME: path.join(root, "openclaw"),
    META_KIM_CURSOR_HOME: path.join(root, "cursor"),
  };
  try {
    return await fn({ env, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runScript(args, env) {
  if (args.includes("--check")) {
    recordSetupRuntimeExecutableBindings({
      roots: [path.resolve(env.HOME)],
      targets: ["claude", "codex"],
      pathResolver: () => process.execPath,
    });
  }
  const isolatedArgs = args.includes("--skip-durable-mcp")
    ? args
    : [...args, "--skip-durable-mcp"];
  return execFileAsync(process.execPath, [SCRIPT, ...isolatedArgs], {
    cwd: REPO_ROOT,
    env,
    maxBuffer: 1024 * 1024 * 8,
  });
}

describe("sync-global-meta-theory hook policy", () => {
  test("help exits successfully without resolving or writing runtime homes", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      for (const flag of ["--help", "-h"]) {
        const result = await runScript([flag], env);
        assert.match(result.stdout, /Usage: node scripts\/sync-global-meta-theory\.mjs/);
        assert.match(result.stdout, /--with-global-hooks/);
        assert.match(result.stdout, /--skip-durable-mcp/);
        assert.deepEqual(
          await readdir(root),
          [],
          `${flag} must not create runtime home or manifest state`,
        );
      }
    });
  });

  test("unknown and incomplete options fail closed without writing", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      for (const args of [
        ["--typo"],
        ["--lang", "zh-CN"],
        ["--targets"],
        ["--targets="],
      ]) {
        await assert.rejects(
          () => runScript(args, env),
          (error) => {
            assert.match(
              error.stderr,
              /Unknown option: --(?:typo|lang)|--targets requires a comma-separated value/,
            );
            return true;
          },
        );
        assert.deepEqual(
          await readdir(root),
          [],
          `${args.join(" ")} must fail before creating runtime state`,
        );
      }
    });
  });

  test("retired Hook cleanup preserves unowned same-name user files", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const hooksDir = path.join(root, "claude", "hooks");
      const userHook = path.join(hooksDir, "pre-git-push-confirm.mjs");
      const settingsPath = path.join(root, "claude", "settings.json");
      await mkdir(hooksDir, { recursive: true });
      await writeFile(userHook, "// user-owned same-name Hook\n", "utf8");
      await writeFile(
        settingsPath,
        `${JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: `node "${userHook}"` }],
              },
            ],
          },
        })}\n`,
        "utf8",
      );

      const result = await runScript(
        ["--targets", "claude", "--with-global-hooks"],
        env,
      );

      assert.equal(await readFile(userHook, "utf8"), "// user-owned same-name Hook\n");
      assert.match(await readFile(settingsPath, "utf8"), /pre-git-push-confirm\.mjs/u);
      assert.match(result.stderr, /Preserved unowned same-name Hook/);
    });
  });

  test("owned retired Meta_Kim Hook is backed up before removal", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const hooksDir = path.join(root, "claude", "hooks");
      const retiredHook = path.join(hooksDir, "pre-git-push-confirm.mjs");
      const ownedSource = `#!/usr/bin/env node
// PreToolUse hook: remind before git push
const readJsonFromStdin = true;
const decision = { permissionDecision: "allow" };
console.log("About to git push");
`;
      await mkdir(hooksDir, { recursive: true });
      await writeFile(retiredHook, ownedSource, "utf8");

      await runScript(["--targets", "claude", "--with-global-hooks"], env);

      await assert.rejects(() => readFile(retiredHook, "utf8"));
      const backupRoot = path.join(hooksDir, ".meta-kim-legacy-backup");
      const stamps = await readdir(backupRoot);
      assert.ok(stamps.length > 0);
      assert.equal(
        await readFile(path.join(backupRoot, stamps[0], path.basename(retiredHook)), "utf8"),
        ownedSource,
      );
    });
  });

  test("runtime-home writes reject a commands junction that escapes the selected home", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const codexHome = path.join(root, "codex");
      const outside = path.join(root, "outside-codex-home");
      await mkdir(codexHome, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, path.join(codexHome, "commands"), "junction");

      await assert.rejects(
        () => runScript(["--targets", "codex"], env),
        (error) => {
          assert.match(error.stderr, /Refusing to follow a symlink or junction/);
          return true;
        },
      );
      assert.deepEqual(await readdir(outside), []);
    });
  });

  test("runtime-home writes reject a commands junction into the immutable package store", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const codexHome = path.join(root, "codex");
      const storeRoot = path.join(
        root,
        ".meta-kim",
        "runtime",
        "projection-packages",
      );
      await mkdir(codexHome, { recursive: true });
      await mkdir(storeRoot, { recursive: true });
      await symlink(storeRoot, path.join(codexHome, "commands"), "junction");

      await assert.rejects(
        () => runScript(["--targets", "codex"], env),
        (error) => {
          assert.match(error.stderr, /immutable package store/);
          return true;
        },
      );
      await assert.rejects(() => readFile(path.join(storeRoot, "meta-theory.md"), "utf8"));
    });
  });

  test("default global sync/check does not require Claude global hooks", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const sync = await runScript(["--targets", "claude"], env);
      assert.match(sync.stdout, /Skipped Claude Code global hooks/);
      const stablePackageRoot = await stablePackageRootFromManifest(root);

      for (const commandName of [
        "meta-theory.md",
        "meta-theory-report.md",
        "meta-theory-verify.md",
      ]) {
        const command = await readFile(
          path.join(root, "claude", "commands", commandName),
          "utf8",
        );
        assertUsesStablePackageRoot(command, stablePackageRoot, commandName);
        assert.doesNotMatch(command, /__META_KIM_PACKAGE_ROOT__/);
      }

      const check = await runScript(["--check", "--targets", "claude"], env);
      assert.match(check.stdout, /global hooks skipped/);
      assert.match(check.stdout, /Claude Code commands/);
    });
  });

  test("--skip-durable-mcp syncs Claude assets while preserving the running MCP runtime and config", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const sync = await runScript(
        ["--targets", "claude", "--skip-durable-mcp"],
        env,
      );
      assert.match(sync.stdout, /skipped because explicitly requested with --skip-durable-mcp/);
      await readFile(
        path.join(root, "claude", "skills", "meta-theory", "SKILL.md"),
        "utf8",
      );
      await assert.rejects(() => readFile(path.join(root, ".claude.json"), "utf8"));

      const check = await runScript(
        ["--check", "--targets", "claude", "--skip-durable-mcp"],
        env,
      );
      assert.match(check.stdout, /not checked; skipped because explicitly requested/);
      assert.match(check.stdout, /Claude Code global skill/);
    });
  });

  test("--with-global-hooks is the explicit hard gate for Claude global hooks", async () => {
    await withTempRuntimeHomes(async ({ env }) => {
      await runScript(["--targets", "claude"], env);

      try {
        await runScript(
          ["--check", "--with-global-hooks", "--targets", "claude"],
          env,
        );
        assert.fail("--with-global-hooks check should fail when hooks are missing");
      } catch (error) {
        assert.match(error.stdout, /Claude Code global hooks/);
      }
    });
  });

  test("--with-global-hooks installs prompt-entry bootstrap hook package", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const claudeHooksDir = path.join(root, "claude", "hooks");
      await mkdir(claudeHooksDir, { recursive: true });
      await writeFile(
        path.join(claudeHooksDir, "user-prompt-submit.js"),
        "process.stdout.write(JSON.stringify({}));\n",
        "utf8",
      );

      await runScript(["--targets", "claude", "--with-global-hooks"], env);
      const stablePackageRoot = await stablePackageRootFromManifest(root);

      const hookDir = path.join(root, "claude", "hooks", "meta-kim");
      for (const fileName of [
        "activate-meta-theory-spine.mjs",
        "block-dangerous-bash.mjs",
        "spine-state-gates.mjs",
        "spine-state.mjs",
        "spine-state-utils.mjs",
        "stop-save-progress.mjs",
        "stop-memory-save.mjs",
        "utils.mjs",
      ]) {
        const source = await readFile(path.join(hookDir, fileName), "utf8");
        assert.equal(
          normalizedPathText(source).includes(normalizedPathText(REPO_ROOT)),
          false,
          `${fileName} must not embed the source checkout root`,
        );
      }
      for (const fileName of [
        "enforce-agent-dispatch.mjs",
        "stop-compaction.mjs",
        "stop-spine-cleanup.mjs",
      ]) {
        const source = await readFile(path.join(hookDir, fileName), "utf8");
        assert.equal(
          normalizedPathText(source).includes(normalizedPathText(REPO_ROOT)),
          false,
          `${fileName} must not embed the source checkout root`,
        );
        assert.doesNotMatch(
          source,
          /\.\.\/\.\.\/shared\/hooks\//,
          `${fileName} must resolve shared dependencies from the flattened global hook package`,
        );
      }
      for (const fileName of ["stop-compaction.mjs", "stop-spine-cleanup.mjs"]) {
        const result = spawnSync(
          process.execPath,
          [path.join(hookDir, fileName)],
          {
            cwd: root,
            env,
            input: "{}\n",
            encoding: "utf8",
            timeout: 5000,
          },
        );
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|shared[\\/]hooks/);
      }

      const settings = JSON.parse(
        await readFile(path.join(root, "claude", "settings.json"), "utf8"),
      );
      assertHookConfigUsesStablePackageRoot(
        settings,
        stablePackageRoot,
        "global Claude settings hooks",
      );
      const promptHooks = settings.hooks?.UserPromptSubmit?.flatMap(
        (block) => block.hooks ?? [],
      ) ?? [];
      assert.match(
        promptHooks[0]?.command ?? "",
        /user-prompt-submit\.js/,
        "Claude should use HookPrompt native hook before Meta_Kim spine",
      );
      assert.ok(
        promptHooks.some(
          (hook) =>
            hook.command.includes("activate-meta-theory-spine.mjs") &&
            hook.command.includes("--package-root"),
        ),
        "global Claude settings must register prompt-entry project bootstrap hook with package-root evidence",
      );
      assert.doesNotMatch(
        JSON.stringify(promptHooks),
        /hookprompt-adapter\.mjs/,
        "Claude must not wrap native HookPrompt through the Meta_Kim adapter",
      );
      const stopHooks = settings.hooks?.Stop?.flatMap(
        (block) => block.hooks ?? [],
      ) ?? [];
      assert.ok(
        stopHooks.some((hook) => hook.command.includes("stop-save-progress.mjs")),
        "global Claude settings must register the continuation progress Stop hook",
      );
      assert.ok(
        stopHooks.some((hook) => hook.command.includes("stop-memory-save.mjs")),
        "global Claude settings must register the MCP memory Stop hook",
      );
      assert.ok(
        stopHooks.some((hook) => hook.command.includes("stop-compaction.mjs")),
        "global Claude settings must register governed compaction Stop hook",
      );
    });
  });

  test("--with-global-hooks backs up existing managed hook package dirs before replacement", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const claudePackageDir = path.join(root, "claude", "hooks", "meta-kim");
      const codexPackageDir = path.join(root, "codex", "hooks", "meta-kim");
      await mkdir(claudePackageDir, { recursive: true });
      await mkdir(codexPackageDir, { recursive: true });
      await writeFile(
        path.join(claudePackageDir, "local-note.mjs"),
        "// local claude hook package note\n",
        "utf8",
      );
      await writeFile(
        path.join(codexPackageDir, "local-note.mjs"),
        "// local codex hook package note\n",
        "utf8",
      );

      await runScript(["--targets", "claude,codex", "--with-global-hooks"], env);

      await assert.rejects(() => readFile(path.join(claudePackageDir, "local-note.mjs")));
      await assert.rejects(() => readFile(path.join(codexPackageDir, "local-note.mjs")));

      const claudeBackupRoot = path.join(
        root,
        "claude",
        "hooks",
        ".meta-kim-hook-package-backup",
      );
      const codexBackupRoot = path.join(
        root,
        "codex",
        "hooks",
        ".meta-kim-hook-package-backup",
      );
      const claudeBackupDirs = await readdir(claudeBackupRoot);
      const codexBackupDirs = await readdir(codexBackupRoot);
      assert.ok(claudeBackupDirs.length > 0);
      assert.ok(codexBackupDirs.length > 0);
      assert.equal(
        await readFile(
          path.join(claudeBackupRoot, claudeBackupDirs[0], "meta-kim", "local-note.mjs"),
          "utf8",
        ),
        "// local claude hook package note\n",
      );
      assert.equal(
        await readFile(
          path.join(codexBackupRoot, codexBackupDirs[0], "meta-kim", "local-note.mjs"),
          "utf8",
        ),
        "// local codex hook package note\n",
      );
    });
  });

  test("--with-global-hooks backs up and removes legacy root Meta_Kim hook files", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const rootHookDir = path.join(root, "claude", "hooks");
      await mkdir(rootHookDir, { recursive: true });
      const canonical = await readFile(
        path.join(
          REPO_ROOT,
          "canonical",
          "runtime-assets",
          "claude",
          "hooks",
          "post-format.mjs",
        ),
        "utf8",
      );
      await writeFile(path.join(rootHookDir, "post-format.mjs"), canonical, "utf8");

      await runScript(["--targets", "claude", "--with-global-hooks"], env);

      await assert.rejects(() => readFile(path.join(rootHookDir, "post-format.mjs")));
      const backupRoot = path.join(rootHookDir, ".meta-kim-legacy-backup");
      const backupDirs = await readdir(backupRoot);
      assert.ok(backupDirs.length > 0);
      await readFile(
        path.join(backupRoot, backupDirs[0], "post-format.mjs"),
        "utf8",
      );
    });
  });

  test("target filtering does not touch Claude home when only Codex is selected", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const claudeHome = path.join(root, "claude");
      await mkdir(path.join(claudeHome, "hooks"), { recursive: true });
      const legacySkillPath = path.join(claudeHome, "skills", "meta-theory.md");
      await mkdir(path.dirname(legacySkillPath), { recursive: true });
      await writeFile(legacySkillPath, "user legacy claude skill\n", "utf8");
      const sentinelPath = path.join(claudeHome, "settings.json");
      const sentinel = `${JSON.stringify(
        { hooks: { UserPromptSubmit: [{ hooks: [{ command: "node user-only.js" }] }] } },
        null,
        2,
      )}\n`;
      await writeFile(sentinelPath, sentinel, "utf8");

      await runScript(["--targets", "codex", "--with-global-hooks"], env);
      const stablePackageRoot = await stablePackageRootFromManifest(root);

      assert.equal(await readFile(sentinelPath, "utf8"), sentinel);
      assert.equal(await readFile(legacySkillPath, "utf8"), "user legacy claude skill\n");
      await assert.rejects(() =>
        readFile(path.join(claudeHome, "hooks", "meta-kim", "activate-meta-theory-spine.mjs")),
      );
      await readFile(path.join(root, "codex", "skills", "meta-theory", "SKILL.md"), "utf8");
      const codexHookDir = path.join(root, "codex", "hooks", "meta-kim");
      for (const fileName of [
        "activate-meta-theory-spine.mjs",
        "bash-readonly-whitelist.mjs",
        "enforce-agent-dispatch.mjs",
      ]) {
        const source = await readFile(path.join(codexHookDir, fileName), "utf8");
        assert.equal(
          normalizedPathText(source).includes(normalizedPathText(REPO_ROOT)),
          false,
          `${fileName} must not embed the source checkout root`,
        );
      }
      const hooksJson = JSON.parse(
        await readFile(path.join(root, "codex", "hooks.json"), "utf8"),
      );
      assertHookConfigUsesStablePackageRoot(
        hooksJson,
        stablePackageRoot,
        "global Codex hooks",
      );
      const promptHooks = hooksJson.hooks?.UserPromptSubmit?.flatMap(
        (block) => block.hooks ?? [],
      ) ?? [];
      assert.ok(
        promptHooks.some(
          (hook) =>
            hook.command.includes("activate-meta-theory-spine.mjs") &&
            hook.command.includes("--package-root") &&
            normalizedPathText(hook.command).includes(normalizedPathText(stablePackageRoot)) &&
            !normalizedPathText(hook.command).includes(normalizedPathText(REPO_ROOT)),
        ),
        "global Codex hooks.json must register prompt-entry project bootstrap hook with package-root evidence",
      );
    });
  });

  test("Codex global skill sync/check uses the Codex skill projection", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      await runScript(["--targets", "codex"], env);
      const stablePackageRoot = await stablePackageRootFromManifest(root);

      const skillPath = path.join(
        root,
        "codex",
        "skills",
        "meta-theory",
        "SKILL.md",
      );
      const skill = await readFile(skillPath, "utf8");
      const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

      assert.match(frontmatter, /^name: meta-theory$/m);
      assert.match(frontmatter, /^description: /m);
      assert.doesNotMatch(frontmatter, /^trigger:/m);
      assert.match(skill, /\.agents\/skills\/<skill>\//);
      assert.match(skill, /Claude Code 用 `\.claude\/agents\/`/);
      assert.match(skill, /`\.claude\/hooks\/`/);
      assert.doesNotMatch(skill, /Claude Code 用[\s\S]{0,120}`\.codex\/hooks\/`/);

      const command = await readFile(
        path.join(root, "codex", "commands", "meta-theory.md"),
        "utf8",
      );
      assertUsesStablePackageRoot(command, stablePackageRoot, "global Codex meta-theory command");
      assert.doesNotMatch(command, /__META_KIM_PACKAGE_ROOT__/);
      assert.match(command, /run-meta-theory-governed-execution\.mjs/);
      assert.match(command, /--emit-conversation-notice/);
      for (const commandName of ["meta-theory-report.md", "meta-theory-verify.md"]) {
        const extraCommand = await readFile(
          path.join(root, "codex", "commands", commandName),
          "utf8",
        );
        assertUsesStablePackageRoot(extraCommand, stablePackageRoot, `global Codex ${commandName}`);
        assert.doesNotMatch(extraCommand, /__META_KIM_PACKAGE_ROOT__/);
      }

      const check = await runScript(["--check", "--targets", "codex"], env);
      assert.match(check.stdout, /Codex global skill/);
      assert.match(check.stdout, /Codex commands/);
      assert.match(check.stdout, /Codex global hooks skipped/);

      await runScript(["--targets", "codex", "--with-global-hooks"], env);
      const hookCheck = await runScript(
        ["--check", "--targets", "codex", "--with-global-hooks"],
        env,
      );
      assert.match(hookCheck.stdout, /Codex global hooks \(meta-kim\)/);
      assert.match(hookCheck.stdout, /Codex global hooks\.json/);

      const hooksJson = JSON.parse(
        await readFile(path.join(root, "codex", "hooks.json"), "utf8"),
      );
      await readFile(
        path.join(root, "codex", "hooks", "hookprompt-adapter.mjs"),
        "utf8",
      );
      assert.ok(
        JSON.stringify(hooksJson).includes("activate-meta-theory-spine.mjs"),
      );
      assert.ok(JSON.stringify(hooksJson).includes("meta-kim-memory-save.mjs"));
      assert.ok(JSON.stringify(hooksJson).includes("hookprompt-adapter.mjs"));
      assert.ok(JSON.stringify(hooksJson).includes("--package-root"));
    });
  });

  test("Codex global sync removes stale shared Meta_Kim skill aliases", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const sharedSkills = path.join(root, ".agents", "skills");
      await mkdir(path.join(sharedSkills, "meta_kim", "meta-theory"), {
        recursive: true,
      });
      await writeFile(
        path.join(sharedSkills, "meta_kim", "meta-theory", "SKILL.md"),
        `---
name: meta-theory
description: Meta Arsenal dispatcher
---

# Meta Arsenal - Smallest Governable Unit Methodology
`,
        "utf8",
      );
      await mkdir(path.join(sharedSkills, "meta-theory-agent-calling-gap"), {
        recursive: true,
      });
      await writeFile(
        path.join(sharedSkills, "meta-theory-agent-calling-gap", "SKILL.md"),
        `---
name: meta-theory-agent-calling-gap
description: old gap
---

# Meta-Theory Agent Calling Gap

## Status: FIXED
`,
        "utf8",
      );
      await mkdir(path.join(sharedSkills, "source-command-meta-theory-report"), {
        recursive: true,
      });
      await writeFile(
        path.join(sharedSkills, "source-command-meta-theory-report", "SKILL.md"),
        `---
name: source-command-meta-theory-report
description: Reopen a Meta_Kim governed run report
---

node "__META_KIM_PACKAGE_ROOT__/scripts/run-meta-theory-governed-execution.mjs" --read latest
`,
        "utf8",
      );
      await mkdir(path.join(sharedSkills, "source-command-meta-theory-verify"), {
        recursive: true,
      });
      await writeFile(
        path.join(sharedSkills, "source-command-meta-theory-verify", "SKILL.md"),
        `---
name: source-command-meta-theory-verify
description: Run the appropriate Meta_Kim verification path
---

npm run meta:release:smoke
`,
        "utf8",
      );
      await mkdir(path.join(sharedSkills, "meta-theory"), { recursive: true });
      await writeFile(
        path.join(sharedSkills, "meta-theory", "SKILL.md"),
        `---
name: meta-theory
description: Meta_Kim executable governance dispatcher
---
`,
        "utf8",
      );
      await mkdir(path.join(sharedSkills, "critical-fetch-thinking-review"), {
        recursive: true,
      });
      await writeFile(
        path.join(sharedSkills, "critical-fetch-thinking-review", "SKILL.md"),
        `---
name: critical-fetch-thinking-review
description: User-owned workflow notes
---
`,
        "utf8",
      );
      await mkdir(
        path.join(root, "codex", "skills", "critical-fetch-thinking-review"),
        {
          recursive: true,
        },
      );
      await writeFile(
        path.join(
          root,
          "codex",
          "skills",
          "critical-fetch-thinking-review",
          "SKILL.md",
        ),
        `---
name: critical-fetch-thinking-review
description: Meta_Kim legacy governed route alias
---

# Meta Theory

Critical -> Fetch -> Thinking -> Review
`,
        "utf8",
      );

      await assert.rejects(
        () => runScript(["--check", "--targets", "codex"], env),
        (error) => {
          assert.match(error.stdout, /legacy Meta Arsenal skill package/);
          assert.match(error.stdout, /legacy shared Codex global meta-theory duplicate/);
          assert.match(
            error.stdout,
            /legacy Critical\/Fetch\/Thinking\/Review Meta_Kim alias/,
          );
          return true;
        },
      );

      await runScript(["--targets", "codex"], env);

      for (const staleName of [
        "meta_kim",
        "meta-theory-agent-calling-gap",
        "source-command-meta-theory-report",
        "source-command-meta-theory-verify",
        "meta-theory",
      ]) {
        await assert.rejects(() =>
          readdir(path.join(sharedSkills, staleName)),
        );
      }
      await assert.rejects(() =>
        readdir(
          path.join(root, "codex", "skills", "critical-fetch-thinking-review"),
        ),
      );

      await readFile(
        path.join(sharedSkills, "critical-fetch-thinking-review", "SKILL.md"),
        "utf8",
      );
      await readFile(
        path.join(root, "codex", "skills", "meta-theory", "SKILL.md"),
        "utf8",
      );
      const backupRoot = path.join(
        root,
        "codex",
        ".meta-kim",
        "backups",
        "stale-skill-aliases",
      );
      assert.ok((await readdir(backupRoot)).length > 0);

      const check = await runScript(["--check", "--targets", "codex"], env);
      assert.doesNotMatch(check.stdout, /legacy Meta Arsenal skill package.*⊘/);
    });
  });

  test("Codex global hooks merge preserves user hooks and detects stale Meta_Kim entries", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const codexHome = path.join(root, "codex");
      await mkdir(codexHome, { recursive: true });
      const hooksPath = path.join(codexHome, "hooks.json");
      await writeFile(
        hooksPath,
        `${JSON.stringify(
          {
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    { type: "command", command: "node user-only.js" },
                  ],
                },
              ],
              Stop: [
                {
                  matcher: "*",
                  hooks: [{ type: "command", command: "node user-stop-only.js" }],
                },
              ],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await runScript(["--targets", "codex", "--with-global-hooks"], env);

      const merged = JSON.parse(await readFile(hooksPath, "utf8"));
      const rendered = JSON.stringify(merged);
      assert.match(rendered, /node user-only\.js/);
      assert.match(rendered, /node user-stop-only\.js/);
      assert.match(rendered, /activate-meta-theory-spine\.mjs/);
      assert.match(rendered, /stop-spine-cleanup\.mjs/);
      const stopCommands = (merged.hooks.Stop ?? [])
        .flatMap((entry) => entry.hooks ?? [])
        .map((hook) => hook.command);
      assert.equal(
        stopCommands.filter((command) => command.includes("meta-kim-memory-save.mjs")).length,
        1,
      );
      assert.equal(
        stopCommands.filter((command) => command.includes("stop-spine-cleanup.mjs")).length,
        1,
      );
      assert.ok(
        stopCommands.findIndex((command) => command.includes("meta-kim-memory-save.mjs")) <
        stopCommands.findIndex((command) => command.includes("stop-spine-cleanup.mjs")),
      );
      assert.match(rendered, /--package-root/);

      await assert.rejects(
        async () => {
          const broken = JSON.parse(await readFile(hooksPath, "utf8"));
          broken.hooks.UserPromptSubmit[0].hooks.push({
            type: "command",
            command: `node "${path.join(codexHome, "hooks", "meta-kim", "missing-retired-hook.mjs")}"`,
          });
          await writeFile(hooksPath, `${JSON.stringify(broken, null, 2)}\n`, "utf8");
          await runScript(
            ["--check", "--targets", "codex", "--with-global-hooks"],
            env,
          );
        },
        (error) => {
          assert.match(error.stdout, /Codex global hooks\.json/);
          assert.match(error.stdout, /Missing registered Meta_Kim Codex hook scripts: 1/);
          return true;
        },
      );
    });
  });

  test("global settings writes are atomic and preserve user JSON on injected failure", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const fixtures = [
        {
          id: "claude-settings",
          target: path.join(root, "claude", "settings.json"),
          args: ["--targets", "claude", "--with-global-hooks"],
        },
        {
          id: "codex-hooks",
          target: path.join(root, "codex", "hooks.json"),
          args: ["--targets", "codex", "--with-global-hooks"],
        },
      ];

      for (const fixture of fixtures) {
        await mkdir(path.dirname(fixture.target), { recursive: true });
        const original = `${JSON.stringify(
          {
            unknownUserField: { preserve: true, runtime: fixture.id },
            hooks: {
              UserPromptSubmit: [
                { hooks: [{ type: "command", command: "node user-only.js" }] },
              ],
            },
          },
          null,
          2,
        )}\n`;
        await writeFile(fixture.target, original, "utf8");

        await assert.rejects(
          () =>
            runScript(fixture.args, {
              ...env,
              META_KIM_TEST_FAIL_ATOMIC_SETTINGS_WRITE: fixture.id,
            }),
          (error) => {
            assert.match(error.stderr, new RegExp(`Injected atomic settings write failure: ${fixture.id}`));
            return true;
          },
        );

        const preserved = await readFile(fixture.target, "utf8");
        assert.equal(preserved, original);
        assert.deepEqual(JSON.parse(preserved).unknownUserField, {
          preserve: true,
          runtime: fixture.id,
        });
        assert.equal(
          (await readdir(path.dirname(fixture.target))).some((entry) =>
            entry.includes(".meta-kim-staged-"),
          ),
          false,
          "failed atomic writes must clean their staged file",
        );
      }
    });
  });

  test("default sync preserves manifest-owned hook records when hooks are skipped", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      await runScript(["--targets", "codex", "--with-global-hooks"], env);

      const manifestPath = path.join(root, ".meta-kim", "install-manifest.json");
      const withHooks = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.ok(
        withHooks.entries.some(
          (entry) => entry.purpose === "codex-global-hook",
        ),
        "precondition: explicit hook sync should record Codex global hook files",
      );

      await runScript(["--targets", "codex"], env);

      const afterSkippedHooks = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.ok(
        afterSkippedHooks.entries.some(
          (entry) => entry.purpose === "codex-global-hook",
        ),
        "skipping global hooks must not erase previously recorded hook ownership",
      );
      assert.ok(
        afterSkippedHooks.entries.some(
          (entry) => entry.purpose === "codex-global-command",
        ),
        "regular skill/command records should still be refreshed",
      );
    });
  });

  test("target filtering does not touch Codex home when only Claude is selected", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      const codexHome = path.join(root, "codex");
      await mkdir(codexHome, { recursive: true });
      const legacySkillPath = path.join(codexHome, "skills", "meta-theory.md");
      await mkdir(path.dirname(legacySkillPath), { recursive: true });
      await writeFile(legacySkillPath, "user legacy codex skill\n", "utf8");
      const sentinelPath = path.join(codexHome, "hooks.json");
      const sentinel = `${JSON.stringify(
        { hooks: { UserPromptSubmit: [{ hooks: [{ command: "node user-only.js" }] }] } },
        null,
        2,
      )}\n`;
      await writeFile(sentinelPath, sentinel, "utf8");

      await runScript(["--targets", "claude", "--with-global-hooks"], env);

      assert.equal(await readFile(sentinelPath, "utf8"), sentinel);
      assert.equal(await readFile(legacySkillPath, "utf8"), "user legacy codex skill\n");
      await assert.rejects(() =>
        readFile(path.join(codexHome, "skills", "meta-theory", "SKILL.md")),
      );
      await assert.rejects(() =>
        readFile(path.join(codexHome, "hooks", "meta-kim", "activate-meta-theory-spine.mjs")),
      );
      await readFile(
        path.join(root, "claude", "hooks", "meta-kim", "activate-meta-theory-spine.mjs"),
        "utf8",
      );
    });
  });

  test("--with-global-hooks check rejects stale settings entries for missing Meta_Kim hook files", async () => {
    await withTempRuntimeHomes(async ({ env, root }) => {
      await runScript(["--targets", "claude", "--with-global-hooks"], env);

      const settingsPath = path.join(root, "claude", "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      settings.hooks.Stop = [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `node "${path.join(root, "claude", "hooks", "meta-kim", "missing-retired-hook.mjs")}"`,
            },
          ],
        },
      ];
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

      await assert.rejects(
        () => runScript(["--check", "--with-global-hooks", "--targets", "claude"], env),
        (error) => {
          assert.match(error.stdout, /Claude Code global settings hooks/);
          assert.match(error.stdout, /Missing registered Meta_Kim hook scripts: 1/);
          return true;
        },
      );

      await runScript(["--targets", "claude", "--with-global-hooks"], env);
      const repaired = JSON.parse(await readFile(settingsPath, "utf8"));
      const repairedStop = JSON.stringify(repaired.hooks.Stop ?? []);
      assert.doesNotMatch(repairedStop, /missing-retired-hook\.mjs/);
      assert.match(repairedStop, /stop-save-progress\.mjs/);
      assert.match(repairedStop, /stop-memory-save\.mjs/);
    });
  });

  test("release verification uses the global hook hard gate without making live eval a full release gate", async () => {
    const pkg = JSON.parse(
      await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
    );
    const verifyRunner = await readFile(
      path.join(REPO_ROOT, "scripts", "run-verify-all.mjs"),
      "utf8",
    );
    assert.match(
      pkg.scripts["meta:check:global:release"],
      /--check.*--with-global-hooks|--with-global-hooks.*--check/,
    );
    assert.match(pkg.scripts["meta:verify:all"], /run-verify-all\.mjs/);
    assert.match(verifyRunner, /meta:check:global:release/);
    assert.match(pkg.scripts["meta:verify:all:live"], /eval-meta-agents\.mjs/);
    assert.match(pkg.scripts["meta:verify:all:live"], /--require-all-runtimes/);
    assert.match(pkg.scripts["meta:verify:all:live"], /--live/);
    assert.doesNotMatch(
      pkg.scripts["meta:verify:all:live"],
      /meta:check:global:release|meta:test:setup|meta:test:meta-theory/,
    );
  });
});
