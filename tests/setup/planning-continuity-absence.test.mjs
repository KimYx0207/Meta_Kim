import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const npmCli = process.env.npm_execpath;

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    ...options,
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function runHook(hookPath, projectRoot, isolatedHome, command, runId = "absence-run", extra = [], acceptRefusal = false) {
  const args = [
    hookPath,
    command,
    "--project-root", projectRoot,
    "--runtime", "codex",
    "--run-id", runId,
    ...extra,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      npm_config_cache: path.join(isolatedHome, "empty-npm-cache"),
    },
  });
  assert.ok(
    acceptRefusal ? [0, 2].includes(result.status) : result.status === 0,
    `${process.execPath} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

test("real packed install works offline with the external planning project completely absent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-planning-absence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packDir = path.join(root, "pack");
  const installRoot = path.join(root, "consumer");
  const projectRoot = path.join(root, "project");
  const existingRoot = path.join(root, "existing-project");
  const isolatedHome = path.join(root, "home");
  await Promise.all([
    mkdir(packDir, { recursive: true }),
    mkdir(installRoot, { recursive: true }),
    mkdir(path.join(projectRoot, ".git"), { recursive: true }),
    mkdir(path.join(existingRoot, ".git"), { recursive: true }),
    mkdir(isolatedHome, { recursive: true }),
  ]);

  assert.ok(npmCli, "npm_execpath is required for the real packed-product test");
  const npmCache = run(process.execPath, [npmCli, "config", "get", "cache"], { cwd: repoRoot }).stdout.trim();
  const packed = run(process.execPath, [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", packDir], {
    cwd: repoRoot,
    env: { ...process.env, npm_config_cache: npmCache },
  });
  const packResult = JSON.parse(packed.stdout);
  const tarball = path.join(packDir, packResult[0].filename);
  await writeFile(path.join(installRoot, "package.json"), '{"private":true}\n', "utf8");
  run(process.execPath, [npmCli,
    "install", tarball, "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--cache", npmCache,
  ], { cwd: installRoot, env: { ...process.env, npm_config_cache: npmCache } });

  const installedRoot = path.join(installRoot, "node_modules", "meta-kim");
  const hookPath = path.join(installedRoot, "canonical", "runtime-assets", "shared", "hooks", "planning-continuity.mjs");
  const hookSource = await readFile(hookPath, "utf8");
  assert.doesNotMatch(hookSource, /OthmanAdi|planning-with-files|node:(?:http|https|child_process)|\bfetch\s*\(/iu);
  for (const forbidden of [
    path.join(root, "planning-with-files"),
    path.join(isolatedHome, ".codex", "skills", "planning-with-files"),
    path.join(isolatedHome, ".claude", "skills", "planning-with-files"),
    path.join(isolatedHome, ".cursor", "skills", "planning-with-files"),
    path.join(isolatedHome, ".openclaw", "skills", "planning-with-files"),
  ]) await assert.rejects(() => readFile(path.join(forbidden, "SKILL.md"), "utf8"));

  const init = runHook(hookPath, projectRoot, isolatedHome, "init");
  assert.equal(init.status, "initialized_attested");
  const second = runHook(hookPath, projectRoot, isolatedHome, "init", "isolated-run");
  assert.notEqual(init.context.key, second.context.key);
  assert.notEqual(init.context.authority, second.context.authority);

  const resume = runHook(hookPath, projectRoot, isolatedHome, "resume");
  assert.equal(resume.status, "resumed");
  assert.match(resume.projection, /META_KIM_PLANNING_CONTEXT_BEGIN_/u);
  assert.doesNotMatch(resume.projection, /FILE findings\.md/u);
  assert.equal(runHook(hookPath, projectRoot, isolatedHome, "doctor").status, "healthy");

  await writeFile(path.join(projectRoot, "progress.md"), "# Progress\n\n- Current status: updated\n", "utf8");
  assert.equal(runHook(hookPath, projectRoot, isolatedHome, "resume", "absence-run", [], true).status, "refused");
  assert.equal(runHook(hookPath, projectRoot, isolatedHome, "checkpoint").status, "checkpoint_attested");
  assert.equal(runHook(hookPath, projectRoot, isolatedHome, "resume").status, "resumed");

  const stop1 = runHook(hookPath, projectRoot, isolatedHome, "stop");
  const stop2 = runHook(hookPath, projectRoot, isolatedHome, "stop");
  const stop3 = runHook(hookPath, projectRoot, isolatedHome, "stop");
  assert.deepEqual([stop1.status, stop2.status, stop3.status], ["block", "block", "allow_incomplete"]);
  const authority = JSON.parse(await readFile(init.context.authority, "utf8"));
  assert.equal(authority.ledger.version, 1);
  assert.ok(authority.ledger.events.length > 0 && authority.ledger.events.length <= 200);

  const existingPlan = "# Existing plan\n\n- [ ] preserve me\n";
  await writeFile(path.join(existingRoot, "task_plan.md"), existingPlan, "utf8");
  const existing = runHook(hookPath, existingRoot, isolatedHome, "init", "existing-run");
  assert.equal(existing.status, "initialized_waiting_owner_review");
  assert.equal(await readFile(path.join(existingRoot, "task_plan.md"), "utf8"), existingPlan);
});
