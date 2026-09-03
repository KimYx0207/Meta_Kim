import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RUN_SUBSTANCE_CLASSES,
  runSubstance,
  runSubstanceRank,
} from "../../src/application/live/live-run-substance.mjs";
import {
  LIVE_RUN_RETENTION_SCHEMA_VERSION,
  classifyRetentionCandidate,
  loadLiveRunRetentionPolicy,
  normalizeLiveRunRetentionPolicy,
  planRunRetention,
} from "../../src/application/live/live-run-retention.mjs";
import {
  RUN_RETENTION_BACKUP_DIR,
  RUN_RETENTION_MIGRATION,
  applyRunRetention,
  collectRunRetentionCandidates,
} from "../../src/infrastructure/live/live-run-retention-store.mjs";

const OBSERVED_AT = "2026-08-31T00:00:00.000Z";

function policy(overrides = {}) {
  return normalizeLiveRunRetentionPolicy({
    schemaVersion: LIVE_RUN_RETENTION_SCHEMA_VERSION,
    activationOnlyRetentionDays: 3,
    activationOnlyMaxEntries: 40,
    substantiveRetentionDays: 180,
    substantiveMaxEntries: 512,
    maxPrunePerPass: 200,
    backupRetainedPasses: 3,
    ...overrides,
  });
}

function daysBefore(days) {
  return new Date(Date.parse(OBSERVED_AT) - days * 24 * 60 * 60 * 1000).toISOString();
}

async function makeProject(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `meta-kim-retention-${name}-`));
  await mkdir(path.join(root, ".meta-kim", "state", "default", "runs"), { recursive: true });
  return root;
}

async function writeRun(root, runId, status) {
  const runDir = path.join(root, ".meta-kim", "state", "default", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "status.json"),
    JSON.stringify({ runId, ...status }),
    "utf8",
  );
  return runDir;
}

test("a bare activation carries no substance and any single real signal is enough to gain it", () => {
  assert.deepEqual(RUN_SUBSTANCE_CLASSES, ["activation_only", "substantive"]);

  const bare = { runId: "meta-bare", currentStageKey: "critical", completed: [] };
  assert.equal(runSubstance(bare).substanceClass, "activation_only");
  assert.equal(runSubstance(bare).substanceSource, "derived_from_status_fields");

  const signals = [
    { completed: ["Critical"] },
    { workerLifecycle: [{ taskPacketId: "task-1", state: "queued" }] },
    { workerTaskPackets: [{ taskPacketId: "task-1" }] },
    { currentStageKey: "fetch" },
    { blockedOn: "waiting on the user to confirm scope" },
  ];
  for (const signal of signals) {
    assert.equal(
      runSubstance({ ...bare, ...signal }).substanceClass,
      "substantive",
      `${Object.keys(signal)[0]} is recorded output and must count`,
    );
  }
  assert.equal(runSubstance(bare, { artifactPresent: true }).substanceClass, "substantive");
  assert.equal(runSubstance(bare, { eventCount: 1 }).substanceClass, "substantive");
});

test("substance reads a stage key in either casing and at either nesting depth", () => {
  assert.equal(runSubstance({ currentStage: "Execution" }).substanceSignals.stageIndex, 4);
  assert.equal(runSubstance({ run: { currentStage: "Evolution" } }).substanceSignals.stageIndex, 8);
  assert.equal(runSubstance({ currentStageKey: "critical" }).substanceSignals.stageIndex, 1);
  assert.equal(
    runSubstance({ currentStageKey: "not-a-stage" }).substanceSignals.stageIndex,
    null,
    "an unreadable stage stays unknown instead of collapsing onto the entry stage",
  );
});

test("substance counts completed stages from either a completed array or a stages map", () => {
  assert.equal(runSubstance({ completed: ["Critical", "Fetch"] }).substanceSignals.completedStages, 2);
  assert.equal(
    runSubstance({
      stages: { critical: { status: "completed" }, fetch: { status: "in_progress" } },
    }).substanceSignals.completedStages,
    1,
  );
});

test("a declared substance class is reported as declared and never downgraded", () => {
  const declared = runSubstance({ substanceClass: "substantive", currentStageKey: "critical" });
  assert.equal(declared.substanceClass, "substantive");
  assert.equal(declared.substanceSource, "declared_by_status_envelope");

  const declaredEmpty = runSubstance({ substanceClass: "activation_only", completed: ["Critical"] });
  assert.equal(
    declaredEmpty.substanceClass,
    "substantive",
    "evidence in the record outranks a stale declaration; substance is a floor, not a ceiling",
  );
});

test("substance rank orders substantive runs ahead of activation receipts", () => {
  assert.equal(runSubstanceRank("substantive"), 1);
  assert.equal(runSubstanceRank("activation_only"), 0);
  assert.equal(runSubstanceRank(undefined), 0);
});

test("the shipped retention policy loads and validates", () => {
  const shipped = loadLiveRunRetentionPolicy();
  assert.equal(shipped.schemaVersion, LIVE_RUN_RETENTION_SCHEMA_VERSION);
  assert.ok(shipped.activationOnlyRetentionDays <= shipped.substantiveRetentionDays);
  assert.ok(shipped.activationOnlyMaxEntries <= shipped.substantiveMaxEntries);
  assert.ok(Object.isFrozen(shipped));
});

/**
 * The shipped document deliberately shows receipts for less time than it keeps
 * them. A red here means the two windows were re-merged, which is the shape that
 * made a receipt-heavy panel unfixable without also authorizing deletion — not a
 * stale assertion to relax.
 */
test("the shipped policy shows receipts for less time than it keeps them", () => {
  const shipped = loadLiveRunRetentionPolicy();
  assert.ok(
    shipped.activationOnlyVisibleDays < shipped.activationOnlyRetentionDays,
    "the panel window must be strictly narrower than the window that authorizes pruning",
  );
  assert.ok(shipped.activationOnlyVisibleMaxEntries <= shipped.activationOnlyMaxEntries);
});

test("the retention policy refuses shapes that would outlive real runs", () => {
  assert.throws(() => normalizeLiveRunRetentionPolicy({ schemaVersion: "wrong" }), {
    code: "LIVE_RUN_RETENTION_SCHEMA_MISMATCH",
  });
  assert.throws(() => policy({ activationOnlyRetentionDays: 400 }), {
    code: "LIVE_RUN_RETENTION_WINDOWS_INVERTED",
  });
  assert.throws(() => policy({ activationOnlyMaxEntries: 1024 }), {
    code: "LIVE_RUN_RETENTION_CAPS_INVERTED",
  });
  assert.throws(() => policy({ maxPrunePerPass: 0 }), { code: "LIVE_RUN_RETENTION_INVALID" });
  assert.throws(() => policy({ backupRetainedPasses: 1.5 }), { code: "LIVE_RUN_RETENTION_INVALID" });
});

test("retention protects the active run, real work, and anything it cannot classify", () => {
  const plan = planRunRetention(
    [
      { runId: "meta-active", substanceClass: "activation_only", updatedAt: daysBefore(400), isActiveAuthority: true },
      { runId: "meta-old-shell", substanceClass: "activation_only", updatedAt: daysBefore(30) },
      { runId: "meta-old-real", substanceClass: "substantive", updatedAt: daysBefore(30) },
      { runId: "meta-unknown-class", substanceClass: null, updatedAt: daysBefore(400) },
      { runId: "meta-no-timestamp", substanceClass: "activation_only", updatedAt: null },
      { runId: "meta-shell-with-artifact", substanceClass: "activation_only", updatedAt: daysBefore(30), artifactPresent: true },
    ],
    policy(),
    { observedAt: OBSERVED_AT },
  );

  assert.deepEqual(plan.prune.map((entry) => entry.runId), ["meta-old-shell"]);
  assert.deepEqual(plan.protectedRuns, [
    { runId: "meta-active", substanceClass: "activation_only", reason: "active_authority_run" },
  ]);
  assert.deepEqual(plan.unclassified.map((entry) => entry.reason).sort(), [
    "no_readable_timestamp",
    "status_record_not_classifiable",
  ]);
  assert.equal(
    plan.keep.find((entry) => entry.runId === "meta-shell-with-artifact")?.substanceClass,
    "substantive",
    "a governed artifact is real output even when the envelope never left Critical",
  );
  assert.equal(plan.counts.candidates, 6);
  assert.equal(plan.counts.prune, 1);
});

test("retention keeps records inside the window and refuses future timestamps", () => {
  const plan = planRunRetention(
    [
      { runId: "meta-fresh", substanceClass: "activation_only", updatedAt: daysBefore(1) },
      { runId: "meta-future", substanceClass: "activation_only", updatedAt: daysBefore(-5) },
    ],
    policy(),
    { observedAt: OBSERVED_AT },
  );
  assert.deepEqual(plan.prune, []);
  assert.deepEqual(
    plan.keep.map((entry) => entry.reason).sort(),
    ["inside_retention_window", "timestamp_ahead_of_observation"],
  );
});

test("the per-class entry cap trims the oldest survivors and never crosses classes", () => {
  const candidates = [];
  for (let index = 0; index < 5; index += 1) {
    candidates.push({
      runId: `meta-shell-${index}`,
      substanceClass: "activation_only",
      updatedAt: daysBefore(index / 24),
    });
    candidates.push({
      runId: `meta-real-${index}`,
      substanceClass: "substantive",
      updatedAt: daysBefore(index / 24),
    });
  }
  const plan = planRunRetention(candidates, policy({ activationOnlyMaxEntries: 2 }), {
    observedAt: OBSERVED_AT,
  });

  assert.deepEqual(plan.prune.map((entry) => entry.runId), [
    "meta-shell-4",
    "meta-shell-3",
    "meta-shell-2",
  ]);
  assert.equal(plan.prune.every((entry) => entry.reason === "over_max_entries"), true);
  assert.equal(
    plan.keep.filter((entry) => entry.substanceClass === "substantive").length,
    5,
    "the activation-only cap must not reach a run that did work",
  );
});

test("one pass is bounded and defers the rest oldest-first", () => {
  const candidates = Array.from({ length: 7 }, (unused, index) => ({
    runId: `meta-shell-${index}`,
    substanceClass: "activation_only",
    updatedAt: daysBefore(10 + index),
  }));
  const plan = planRunRetention(candidates, policy({ maxPrunePerPass: 3 }), {
    observedAt: OBSERVED_AT,
  });

  assert.deepEqual(plan.prune.map((entry) => entry.runId), [
    "meta-shell-6",
    "meta-shell-5",
    "meta-shell-4",
  ]);
  assert.equal(plan.counts.deferred, 4);
  assert.equal(
    plan.keep.every((entry) => entry.reason === "deferred_by_max_prune_per_pass"),
    true,
  );
});

test("a candidate with no classifiable substance class is reported rather than guessed", () => {
  assert.equal(classifyRetentionCandidate({ substanceClass: null }), "unclassified");
  assert.equal(classifyRetentionCandidate(undefined), "unclassified");
  assert.equal(classifyRetentionCandidate({ substanceClass: "activation_only" }), "activation_only");
  assert.equal(
    classifyRetentionCandidate({ substanceClass: "activation_only", eventCount: 3 }),
    "substantive",
  );
});

test("collecting candidates reports unreadable records instead of dropping them", async (t) => {
  const root = await makeProject("collect");
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeRun(root, "meta-good", {
    substanceClass: "activation_only",
    updatedAt: daysBefore(30),
  });
  await writeRun(root, "meta-mismatch", { runId: "meta-other", updatedAt: daysBefore(30) });
  const brokenDir = path.join(root, ".meta-kim", "state", "default", "runs", "meta-broken");
  await mkdir(brokenDir, { recursive: true });
  await writeFile(path.join(brokenDir, "status.json"), "{ not json", "utf8");
  const outOfContract = path.join(root, ".meta-kim", "state", "default", "runs", "not-a-run-id");
  await mkdir(outOfContract, { recursive: true });

  const collected = await collectRunRetentionCandidates(root);
  const byId = new Map(collected.candidates.map((candidate) => [candidate.runId, candidate]));

  assert.equal(collected.profile, "default");
  assert.equal(collected.scanned, 4);
  assert.equal(byId.get("meta-good").substanceClass, "activation_only");
  assert.equal(byId.get("meta-mismatch").unreadableReason, "run_id_mismatch");
  assert.equal(byId.get("meta-broken").unreadableReason, "status_unreadable");
  assert.equal(byId.get("not-a-run-id").unreadableReason, "run_directory_name_out_of_contract");
});

test("a retention pass plans without touching the filesystem by default", async (t) => {
  const root = await makeProject("plan-only");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeRun(root, "meta-shell", {
    substanceClass: "activation_only",
    updatedAt: daysBefore(30),
  });

  const result = await applyRunRetention(root, { policy: policy(), observedAt: OBSERVED_AT });

  assert.equal(result.applied, false);
  assert.deepEqual(result.moved, []);
  assert.deepEqual(result.plan.prune.map((entry) => entry.runId), ["meta-shell"]);
  const runs = await readdir(path.join(root, ".meta-kim", "state", "default", "runs"));
  assert.deepEqual(runs, ["meta-shell"], "a plan-only pass must leave the directory untouched");
});

test("an applied pass is reversible, idempotent, and leaves real runs alone", async (t) => {
  const root = await makeProject("apply");
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, ".meta-kim", "state", "default");

  await writeRun(root, "meta-shell-a", {
    substanceClass: "activation_only",
    updatedAt: daysBefore(30),
  });
  await writeRun(root, "meta-shell-b", {
    substanceClass: "activation_only",
    updatedAt: daysBefore(20),
  });
  await writeRun(root, "meta-real", {
    substanceClass: "substantive",
    completed: ["Critical"],
    updatedAt: daysBefore(30),
  });
  await writeRun(root, "meta-active", {
    substanceClass: "activation_only",
    active: true,
    updatedAt: daysBefore(30),
  });

  const applied = await applyRunRetention(root, {
    policy: policy(),
    observedAt: OBSERVED_AT,
    apply: true,
  });

  assert.equal(applied.applied, true);
  assert.deepEqual(applied.moved.map((entry) => entry.runId).sort(), ["meta-shell-a", "meta-shell-b"]);
  assert.deepEqual(applied.failed, []);
  assert.deepEqual(
    (await readdir(path.join(stateDir, "runs"))).sort(),
    ["meta-active", "meta-real"],
    "an active run and a run that did work both survive",
  );

  const backupBatch = path.join(stateDir, RUN_RETENTION_BACKUP_DIR, applied.batchId);
  const restored = JSON.parse(
    await readFile(path.join(backupBatch, "meta-shell-a", "status.json"), "utf8"),
  );
  assert.equal(restored.runId, "meta-shell-a", "a pruned record is moved, never destroyed");

  const manifest = JSON.parse(
    await readFile(path.join(backupBatch, "retention-manifest.json"), "utf8"),
  );
  assert.equal(manifest.migration, RUN_RETENTION_MIGRATION);
  assert.equal(manifest.restoreFrom.startsWith(path.join(".meta-kim", "state", "default")), true);

  const marker = JSON.parse(
    await readFile(path.join(stateDir, "migrations", `${RUN_RETENTION_MIGRATION}.json`), "utf8"),
  );
  assert.equal(marker.applied, true);
  assert.equal(marker.counts.prune, 2);

  const second = await applyRunRetention(root, {
    policy: policy(),
    observedAt: OBSERVED_AT,
    apply: true,
  });
  assert.deepEqual(second.moved, [], "a second pass over the same state moves nothing new");
  assert.deepEqual(
    (await readdir(path.join(stateDir, "runs"))).sort(),
    ["meta-active", "meta-real"],
  );
});

test("legacy records written before substance classification are still classifiable", async (t) => {
  const root = await makeProject("legacy");
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeRun(root, "meta-legacy-shell", {
    currentStageKey: "critical",
    completed: [],
    updatedAt: daysBefore(30),
  });
  await writeRun(root, "meta-legacy-real", {
    currentStageKey: "verification",
    completed: ["Critical", "Fetch"],
    updatedAt: daysBefore(30),
  });

  const result = await applyRunRetention(root, { policy: policy(), observedAt: OBSERVED_AT });

  assert.deepEqual(result.plan.prune.map((entry) => entry.runId), ["meta-legacy-shell"]);
  assert.deepEqual(result.plan.unclassified, [], "a missing substanceClass is derivable, not unknowable");
  assert.equal(
    result.plan.keep.find((entry) => entry.runId === "meta-legacy-real")?.substanceClass,
    "substantive",
  );
});

test("retention keeps old backup batches bounded", async (t) => {
  const root = await makeProject("backups");
  t.after(() => rm(root, { recursive: true, force: true }));
  const backupRoot = path.join(root, ".meta-kim", "state", "default", RUN_RETENTION_BACKUP_DIR);
  for (const batch of ["batch-1", "batch-2", "batch-3", "batch-4"]) {
    await mkdir(path.join(backupRoot, batch), { recursive: true });
  }
  await writeRun(root, "meta-shell", {
    substanceClass: "activation_only",
    updatedAt: daysBefore(30),
  });

  const applied = await applyRunRetention(root, {
    policy: policy({ backupRetainedPasses: 2 }),
    observedAt: OBSERVED_AT,
    apply: true,
  });

  const remaining = (await readdir(backupRoot)).sort();
  assert.equal(remaining.includes(applied.batchId), true, "the batch just written is retained");
  assert.equal(remaining.length, 2);
});
