import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildIsolatedTestEnvironment } from "../../scripts/run-local-verification.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("actual project sync attributes shared Skills to the selected hosts once", () => {
  for (const [targets, label] of [
    ["gemini", "Gemini CLI"],
    ["codex", "Codex"],
    ["codex,gemini", "Codex / Gemini CLI"],
  ]) {
    const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-sync-summary-"));
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    mkdirSync(home);
    mkdirSync(project);
    try {
      for (const entry of ["package.json", "config", "canonical"]) {
        cpSync(path.join(repoRoot, entry), path.join(project, entry), { recursive: true });
      }
      const env = {
        ...buildIsolatedTestEnvironment(home),
        META_KIM_REPO_ROOT: project,
        META_KIM_CALLER_CWD: project,
        METAKIM_LANG: "en",
      };
      const result = spawnSync(process.execPath, [
        path.join(repoRoot, "scripts/sync-runtimes.mjs"),
        "--scope", "project", "--targets", targets,
      ], { cwd: project, env, encoding: "utf8", timeout: 30000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const skillLines = result.stdout.split("\n").filter((line) => line.startsWith(".agents/skills "));
      assert.equal(skillLines.length, 1, "the shared directory must appear exactly once");
      const group = result.stdout.split("\n\n").find((block) => block.includes(skillLines[0]));
      assert.equal(group.split("\n")[0], label);
      const writtenFiles = readdirSync(path.join(project, ".agents/skills"), {
        recursive: true, withFileTypes: true,
      }).filter((entry) => entry.isFile()).length;
      assert.equal(Number(skillLines[0].match(/\s(\d+) file\(s\) updated/u)[1]), writtenFiles);
      if (targets === "gemini") {
        assert.doesNotMatch(result.stdout, /\nCodex\n/u);
        assert.equal(existsSync(path.join(project, ".codex/agents")), false);
      }
      if (targets === "codex,gemini") {
        assert.doesNotMatch(group, /\.codex\/(?:agents|hooks|config)/u);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
