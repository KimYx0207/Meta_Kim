import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  SETUP_NODE_CHILD,
  buildGlobalMetaTheorySyncArgs,
  buildGlobalSkillsInstallerArgs,
  buildNodeScriptArgs,
  buildNodeScriptSpawn,
  buildSetupNodeChildSpawn,
} from "../../scripts/node-spawn-config.mjs";
import { validateInstallerArgs } from "../../scripts/install-global-skills-all-runtimes.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

describe("setup child CLI contracts", () => {
  test("disables shell for Node paths containing spaces", () => {
    const spawnConfig = buildNodeScriptSpawn(
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\repo\\Meta_Kim",
      "scripts/install-global-skills-all-runtimes.mjs",
      ["--targets", "claude,codex"],
      { language: "zh-CN" },
    );

    assert.equal(spawnConfig.command, "C:\\Program Files\\nodejs\\node.exe");
    assert.deepEqual(spawnConfig.args, [
      "C:\\repo\\Meta_Kim\\scripts\\install-global-skills-all-runtimes.mjs",
      "--lang",
      "zh-CN",
      "--targets",
      "claude,codex",
    ]);
    assert.deepEqual(spawnConfig.options, {
      cwd: "C:\\repo\\Meta_Kim",
      stdio: "inherit",
      shell: false,
    });
  });

  test("rejects legacy language arrays instead of silently dropping them", () => {
    assert.throws(
      () => buildNodeScriptArgs(["--targets", "claude"], ["--lang", "zh-CN"]),
      /legacy langArgs arrays are not supported/u,
    );
  });

  test("production phase builders generate installer-compatible quick, install, and update argv", () => {
    const phaseCases = [
      {
        phase: "quick-deploy",
        args: buildGlobalSkillsInstallerArgs({
          targets: "codex",
          skillIds: [],
        }),
      },
      {
        phase: "install",
        args: buildGlobalSkillsInstallerArgs({
          targets: ["claude", "codex"],
          skillIds: ["meta-theory"],
          skipInventoryRefresh: true,
        }),
      },
      {
        phase: "update",
        args: buildGlobalSkillsInstallerArgs({
          targets: ["claude", "codex"],
          skillIds: ["meta-theory"],
          update: true,
          skipInventoryRefresh: true,
        }),
      },
    ];

    for (const { phase, args } of phaseCases) {
      const spawnConfig = buildSetupNodeChildSpawn(
        process.execPath,
        repoRoot,
        SETUP_NODE_CHILD.GLOBAL_SKILLS_INSTALLER,
        args,
        "zh-CN",
      );
      assert.equal(
        spawnConfig.args[0],
        path.join(repoRoot, "scripts", "install-global-skills-all-runtimes.mjs"),
        phase,
      );
      assert.deepEqual(spawnConfig.args.slice(1, 3), ["--lang", "zh-CN"], phase);
      assert.doesNotThrow(() => validateInstallerArgs(spawnConfig.args.slice(1)), phase);
      if (phase === "install" || phase === "update") {
        assert.ok(args.includes("--skip-inventory-refresh"), phase);
      }
    }
  });

  test("packed acceptance can explicitly route dependency installs to local fixtures", () => {
    const args = buildGlobalSkillsInstallerArgs({
      targets: ["claude", "codex"],
      skillIds: ["findskill"],
      update: true,
      preferLocalDependencies: true,
    });
    assert.ok(args.includes("--prefer-local-dependencies"));
    assert.doesNotThrow(() => validateInstallerArgs(args));
  });

  test("strict global sync gets no language option and executes zero-write target discovery", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-child-contract-"));
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
      const args = [
        ...buildGlobalMetaTheorySyncArgs({ targets: ["claude", "codex"] }),
        "--print-targets",
      ];
      const spawnConfig = buildSetupNodeChildSpawn(
        process.execPath,
        repoRoot,
        SETUP_NODE_CHILD.GLOBAL_META_THEORY_SYNC,
        args,
        "zh-CN",
      );
      assert.doesNotMatch(spawnConfig.args.join(" "), /--lang/u);
      const result = spawnSync(spawnConfig.command, spawnConfig.args, {
        ...spawnConfig.options,
        stdio: "pipe",
        encoding: "utf8",
        env,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Resolved active targets:/u);
      assert.deepEqual(readdirSync(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only declared localized children receive language", () => {
    for (const childId of [
      SETUP_NODE_CHILD.RUNTIME_SYNC,
      SETUP_NODE_CHILD.CAPABILITY_DISCOVERY,
      SETUP_NODE_CHILD.PROJECT_VALIDATION,
    ]) {
      const spawnConfig = buildSetupNodeChildSpawn(
        process.execPath,
        repoRoot,
        childId,
        ["--targets", "claude"],
        "ja-JP",
      );
      assert.deepEqual(spawnConfig.args.slice(1, 3), ["--lang", "ja-JP"]);
    }
    const validationSpawn = buildSetupNodeChildSpawn(
      process.execPath,
      repoRoot,
      SETUP_NODE_CHILD.PROJECT_VALIDATION,
      ["--context", "install"],
      "ko-KR",
    );
    assert.equal(
      validationSpawn.args[0],
      path.join(repoRoot, "scripts", "validate-project.mjs"),
    );
    assert.deepEqual(validationSpawn.args.slice(1), [
      "--lang",
      "ko-KR",
      "--context",
      "install",
    ]);
    assert.throws(
      () => buildSetupNodeChildSpawn(process.execPath, repoRoot, "unknown-child"),
      /Unknown setup child contract/u,
    );
  });
});
