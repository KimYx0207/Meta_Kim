import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";

// The CLI installer applies its proxy policy on import. Keep the already
// credential-isolated caller environment for the independent real npm lane.
const isolatedCallerEnv = { ...process.env };
const { directoryContentEqual } = await import("../../scripts/install-global-skills-all-runtimes.mjs");

const repoRoot = join(import.meta.dirname, "..", "..");

function runGlobalSync(env) {
  const result = spawnSync(
    process.execPath,
    ["scripts/sync-global-meta-theory.mjs", "--targets", "claude,codex"],
    {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
}

function mtimes(paths) {
  return Object.fromEntries(
    Object.entries(paths).map(([id, filePath]) => [id, statSync(filePath).mtimeMs]),
  );
}

test("global skill and command sync is a content-identical mtime no-op", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "meta-kim-global-idempotence-"));
  try {
    const claudeHome = join(root, ".claude");
    const codexHome = join(root, ".codex");
    const env = {
      ...isolatedCallerEnv,
      HOME: root,
      USERPROFILE: root,
      META_KIM_CLAUDE_HOME: claudeHome,
      META_KIM_CODEX_HOME: codexHome,
    };
    const files = {
      claudeSkill: join(claudeHome, "skills", "meta-theory", "SKILL.md"),
      claudeCommand: join(claudeHome, "commands", "meta-theory.md"),
      codexSkill: join(codexHome, "skills", "meta-theory", "SKILL.md"),
      codexCommand: join(codexHome, "commands", "meta-theory.md"),
    };

    runGlobalSync(env);
    const before = mtimes(files);
    await delay(100);
    runGlobalSync(env);
    const after = mtimes(files);

    assert.deepEqual(after, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependency skill tree comparison ignores mtimes but detects content drift", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "meta-kim-skill-tree-equality-"));
  try {
    const left = join(root, "left");
    const right = join(root, "right");
    mkdirSync(join(left, "nested"), { recursive: true });
    mkdirSync(join(right, "nested"), { recursive: true });
    writeFileSync(join(left, "SKILL.md"), "same\n", "utf8");
    writeFileSync(join(right, "SKILL.md"), "same\n", "utf8");
    writeFileSync(join(left, "nested", "ref.md"), "reference\n", "utf8");
    writeFileSync(join(right, "nested", "ref.md"), "reference\n", "utf8");
    assert.equal(await directoryContentEqual(left, right), true);
    writeFileSync(join(right, "nested", "ref.md"), "changed\n", "utf8");
    assert.equal(await directoryContentEqual(left, right), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct global sync rejects stale source pins before its stable-package handoff", (t) => {
  const runtime = createGovernanceRuntimeFixture(t);
  const prepared = runtime.run(["scripts/refresh-runtime-evidence-pins.mjs"]);
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  appendFileSync(join(runtime.repoRoot, "AGENTS.md"), "\nDirect global lifecycle fixture.\n");
  const ledger = join(runtime.repoRoot, "config/runtime-capability-evidence.json");
  const before = readFileSync(ledger, "utf8");
  const config = join(runtime.home, ".codex/config.toml");
  const configBefore = existsSync(config) ? readFileSync(config, "utf8") : null;
  const result = runtime.run(["scripts/sync-global-meta-theory.mjs", "--targets", "codex", "--skip-durable-mcp"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source runtime evidence is stale or invalid/u);
  assert.equal(readFileSync(ledger, "utf8"), before);
  assert.equal(existsSync(join(runtime.home, ".meta-kim/runtime/projection-packages")), false);
  assert.equal(existsSync(join(runtime.home, ".meta-kim/install-manifest.json")), false);
  assert.equal(existsSync(config) ? readFileSync(config, "utf8") : null, configBefore);
});
