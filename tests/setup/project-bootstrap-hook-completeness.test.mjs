import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildIsolatedUserHomeEnv } from "../../scripts/isolated-user-home-env.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TEST_USER_HOME = mkdtempSync(path.join(os.tmpdir(), "meta-kim-hook-complete-home-"));
const PROJECTS = [];

after(() => {
  rmSync(TEST_USER_HOME, { recursive: true, force: true });
  for (const dir of PROJECTS) rmSync(dir, { recursive: true, force: true });
});

function bootstrapClaudeProject() {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-hook-complete-"));
  PROJECTS.push(projectDir);
  const result = spawnSync(
    process.execPath,
    ["setup.mjs", "--project-bootstrap", "--targets", "claude", "--project-dir", projectDir, "--json", "--apply"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
      env: buildIsolatedUserHomeEnv(TEST_USER_HOME),
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return projectDir;
}

const HOOK_SCRIPT_PATTERN = /\.claude[\\/]+hooks[\\/]+([\w.-]+\.(?:mjs|cjs|js|py|sh|ps1))/g;

function registeredHookCommands(settings) {
  const commands = [];
  for (const groups of Object.values(settings.hooks ?? {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (typeof hook?.command === "string") commands.push(hook.command);
      }
    }
  }
  return commands;
}

function registeredHookFiles(settings) {
  const names = new Set();
  for (const command of registeredHookCommands(settings)) {
    for (const match of command.matchAll(HOOK_SCRIPT_PATTERN)) names.add(match[1]);
  }
  return [...names].sort();
}

test("every canonical hook command that points into .claude/hooks names a parseable script", () => {
  const settings = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "canonical", "runtime-assets", "claude", "settings.json"), "utf8"),
  );
  const unparsed = registeredHookCommands(settings).filter(
    (command) => /\.claude[\\/]+hooks/.test(command) && [...command.matchAll(HOOK_SCRIPT_PATTERN)].length === 0,
  );
  assert.deepEqual(unparsed, [], "hook commands the copy-list scanner cannot resolve");
});

test("setup.mjs hand-kept hook list stays a subset of runtime-hook-mapping", async () => {
  const { SHARED_RUNTIME_HOOK_FILES, CLAUDE_COMPATIBLE_HOOK_FILES, PROJECT_META_KIM_HOOK_FILES } = await import(
    "../../scripts/runtime-hook-mapping.mjs"
  );
  const source = readFileSync(path.join(REPO_ROOT, "setup.mjs"), "utf8");
  const block = source.match(/const GLOBAL_HOOK_PACKAGE_FILES_LIST = \[([\s\S]*?)\];/);
  assert.ok(block, "GLOBAL_HOOK_PACKAGE_FILES_LIST not found in setup.mjs");
  const literals = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(literals.length > 0, "GLOBAL_HOOK_PACKAGE_FILES_LIST has no string entries");
  const known = new Set([
    ...SHARED_RUNTIME_HOOK_FILES,
    ...CLAUDE_COMPATIBLE_HOOK_FILES,
    ...PROJECT_META_KIM_HOOK_FILES,
  ]);
  assert.deepEqual(literals.filter((name) => !known.has(name)), []);
});

test("project bootstrap copies every hook that .claude/settings.json registers", () => {
  const projectDir = bootstrapClaudeProject();
  const settings = JSON.parse(
    readFileSync(path.join(projectDir, ".claude", "settings.json"), "utf8"),
  );
  const registered = registeredHookFiles(settings);
  // Guard against a vacuous pass: the file that was dropped before the fix.
  for (const required of ["planning-continuity.mjs"]) {
    assert.ok(registered.includes(required), `${required} must be registered`);
  }
  const missing = registered.filter(
    (name) => !existsSync(path.join(projectDir, ".claude", "hooks", name)),
  );
  assert.deepEqual(missing, [], "registered hooks without a copied file (zombies)");
});

const IGNORED_CACHE_DIRS = new Set([
  ".ruff_cache", ".meta-kim", ".git", ".pytest_cache", ".mypy_cache", "__pycache__", "node_modules",
]);

function findIgnoredCacheDirs(root, rel = "") {
  if (!existsSync(root)) return [];
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (IGNORED_CACHE_DIRS.has(entry.name)) found.push(childRel);
    else found.push(...findIgnoredCacheDirs(path.join(root, entry.name), childRel));
  }
  return found;
}

test("project bootstrap does not project tool-cache directories into any Claude projection root", () => {
  const projectDir = bootstrapClaudeProject();
  const claudeDir = path.join(projectDir, ".claude");
  const leaked = ["agents", "skills", "commands", "capability-index"].flatMap((root) =>
    findIgnoredCacheDirs(path.join(claudeDir, root), root),
  );
  assert.deepEqual(leaked, []);
});
