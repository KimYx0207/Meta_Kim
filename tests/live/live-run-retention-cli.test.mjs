import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  LIVE_RUN_RETENTION_SCHEMA_VERSION,
  loadLiveRunRetentionPolicy,
  normalizeLiveRunRetentionPolicy,
} from "../../src/application/live/live-run-retention.mjs";
import { RUN_RETENTION_BACKUP_DIR } from "../../src/infrastructure/live/live-run-retention-store.mjs";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLI_RELATIVE = path.join("scripts", "compact-governed-runs.mjs");
const CLI = path.join(REPO_ROOT, CLI_RELATIVE);

async function makeProject(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `meta-kim-compact-${name}-`));
  await mkdir(path.join(root, ".meta-kim", "state", "default", "runs"), { recursive: true });
  return root;
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function writeRun(root, runId, status) {
  const runDir = path.join(root, ".meta-kim", "state", "default", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "status.json"), JSON.stringify({ runId, ...status }), "utf8");
  return runDir;
}

async function writePolicy(root, overrides) {
  const policyPath = path.join(root, "run-retention.json");
  await writeFile(
    policyPath,
    JSON.stringify({ ...loadLiveRunRetentionPolicy(), ...overrides }, null, 2),
    "utf8",
  );
  return policyPath;
}

async function compact(root, extraArgs = []) {
  const { stdout } = await run(process.execPath, [CLI, "--project", root, "--json", ...extraArgs], {
    cwd: REPO_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function runIds(root) {
  return (await readdir(path.join(root, ".meta-kim", "state", "default", "runs"))).sort();
}

async function backupBatches(root) {
  const backupRoot = path.join(root, ".meta-kim", "state", "default", RUN_RETENTION_BACKUP_DIR);
  const entries = await readdir(backupRoot, { withFileTypes: true });
  const batches = {};
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    batches[entry.name] = (await readdir(path.join(backupRoot, entry.name))).filter(
      (name) => name !== "retention-manifest.json",
    );
  }
  return batches;
}

test("compacting governed runs is a user-invoked command, never an install side effect", async () => {
  const setupSource = await readFile(path.join(REPO_ROOT, "setup.mjs"), "utf8");
  for (const forbidden of ["live-run-retention", "applyRunRetention", "compactGovernedRunDirectory"]) {
    assert.equal(
      setupSource.includes(forbidden),
      false,
      `setup.mjs must not reach into user-owned run state (${forbidden})`,
    );
  }

  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(manifest.scripts["meta:live:compact"], `node ${CLI_RELATIVE.replace(/\\/gu, "/")}`);
  assert.equal(
    manifest.scripts["meta:live:compact:apply"],
    `node ${CLI_RELATIVE.replace(/\\/gu, "/")} --apply`,
  );
});

test("the shipped policy file is the only source of retention limits", async () => {
  const shipped = loadLiveRunRetentionPolicy();
  assert.equal(shipped.schemaVersion, LIVE_RUN_RETENTION_SCHEMA_VERSION);

  const cliSource = await readFile(CLI, "utf8");
  for (const field of [
    "activationOnlyRetentionDays",
    "activationOnlyMaxEntries",
    "substantiveRetentionDays",
    "substantiveMaxEntries",
    "maxPrunePerPass",
  ]) {
    assert.equal(
      new RegExp(`${field}\\s*[:=]\\s*\\d`, "u").test(cliSource),
      false,
      `${field} belongs to config/live/run-retention.json, not to a CLI literal`,
    );
  }

  assert.equal(
    normalizeLiveRunRetentionPolicy({ ...shipped, backupRetainedPasses: 100 }).backupRetainedPasses,
    100,
    "a drain raises backup retention to the schema ceiling, so that ceiling must stay valid",
  );
});

test("a compaction reports what it would move and changes nothing without --apply", async (t) => {
  const root = await makeProject("report");
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeRun(root, "meta-shell-old", { substanceClass: "activation_only", updatedAt: daysAgo(30) });
  await writeRun(root, "meta-shell-fresh", { substanceClass: "activation_only", updatedAt: daysAgo(1) });
  await writeRun(root, "meta-real", { substanceClass: "substantive", completed: ["Critical"], updatedAt: daysAgo(30) });
  await writeRun(root, "meta-active", { substanceClass: "activation_only", active: true, updatedAt: daysAgo(30) });

  const reported = await compact(root);

  assert.equal(reported.applied, false);
  assert.deepEqual(reported.moved, []);
  assert.deepEqual(reported.plan.prune.map((entry) => entry.runId), ["meta-shell-old"]);
  assert.deepEqual(await runIds(root), [
    "meta-active",
    "meta-real",
    "meta-shell-fresh",
    "meta-shell-old",
  ]);
});

test("--apply moves stale shells into a batch that still holds their records", async (t) => {
  const root = await makeProject("apply");
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeRun(root, "meta-shell-old", { substanceClass: "activation_only", updatedAt: daysAgo(30) });
  await writeRun(root, "meta-real", { substanceClass: "substantive", completed: ["Critical"], updatedAt: daysAgo(30) });

  const applied = await compact(root, ["--apply"]);

  assert.equal(applied.applied, true);
  assert.deepEqual(applied.moved.map((entry) => entry.runId), ["meta-shell-old"]);
  assert.deepEqual(applied.failed, []);
  assert.deepEqual(await runIds(root), ["meta-real"]);

  const batches = await backupBatches(root);
  assert.deepEqual(Object.values(batches).flat(), ["meta-shell-old"]);
  const restored = JSON.parse(
    await readFile(
      path.join(
        root,
        ".meta-kim",
        "state",
        "default",
        RUN_RETENTION_BACKUP_DIR,
        applied.batchId,
        "meta-shell-old",
        "status.json",
      ),
      "utf8",
    ),
  );
  assert.equal(restored.runId, "meta-shell-old");
});

test("--until-done drains a backlog larger than one pass and keeps every batch it wrote", async (t) => {
  const root = await makeProject("drain");
  t.after(() => rm(root, { recursive: true, force: true }));

  const shells = ["a", "b", "c", "d", "e"].map((suffix) => `meta-shell-${suffix}`);
  for (const [index, runId] of shells.entries()) {
    await writeRun(root, runId, {
      substanceClass: "activation_only",
      updatedAt: daysAgo(30 + index),
    });
  }
  await writeRun(root, "meta-real", { substanceClass: "substantive", completed: ["Critical"], updatedAt: daysAgo(90) });
  const policyPath = await writePolicy(root, { maxPrunePerPass: 2, backupRetainedPasses: 1 });

  const drained = await compact(root, ["--until-done", "--policy", policyPath]);

  assert.ok(drained.passes.length >= 3, "a 5-record backlog cannot be cleared in two bounded passes");
  assert.equal(drained.totals.moved, shells.length);
  assert.equal(drained.totals.failed, 0);
  assert.deepEqual(await runIds(root), ["meta-real"]);

  for (const pass of drained.passes) {
    assert.deepEqual(
      pass.removedBackupBatches,
      [],
      "a drain must not discard a batch it wrote in the same command",
    );
  }
  const preserved = Object.values(await backupBatches(root)).flat().sort();
  assert.deepEqual(preserved, [...shells].sort(), "every drained record stays restorable");
});

test("a bounded per-pass policy still stops one pass short of the backlog", async (t) => {
  const root = await makeProject("bounded");
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const suffix of ["a", "b", "c"]) {
    await writeRun(root, `meta-shell-${suffix}`, {
      substanceClass: "activation_only",
      updatedAt: daysAgo(30),
    });
  }
  const policyPath = await writePolicy(root, { maxPrunePerPass: 1 });

  const bounded = await compact(root, ["--policy", policyPath]);

  assert.equal(bounded.counts.prune, 1);
  assert.equal(bounded.counts.deferred, 2);
});
