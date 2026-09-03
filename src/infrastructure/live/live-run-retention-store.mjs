/**
 * Bounded, reversible compaction of persisted governed-run directory entries.
 *
 * The policy and the plan live in the application layer; this module is the only
 * place that touches the filesystem. Three properties matter and are enforced
 * here rather than trusted:
 *
 * - Bounded. One pass prunes at most `maxPrunePerPass` entries, so a machine
 *   carrying a thousand activation-only shells converges over several ordinary
 *   install/update runs instead of one long sweep.
 * - Reversible. A pruned record is moved into a timestamped backup batch with a
 *   manifest, never unlinked, so a pass can be undone by copying the batch back.
 * - Ownership-bounded. Only `.meta-kim/state/<profile>/runs/**` is in scope.
 *   Install projections, runtime-sedimented project copies and user
 *   configuration are different ownership classes and are never read or moved.
 */
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  loadLiveRunRetentionPolicy,
  planRunRetention,
} from "../../application/live/live-run-retention.mjs";
import {
  RUN_SUBSTANCE_CLASSES,
  runSubstance,
} from "../../application/live/live-run-substance.mjs";

export const RUN_RETENTION_MARKER_SCHEMA = "meta-kim-run-directory-retention-marker-v1";
export const RUN_RETENTION_MIGRATION = "run-directory-retention-v1";
export const RUN_RETENTION_BACKUP_DIR = "retention-backups";
export const RUN_RETENTION_MAX_SCANNED_RUNS = 5000;

const RUN_ID_PATTERN = /^meta-[A-Za-z0-9][A-Za-z0-9._-]{0,115}$/u;
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const ARTIFACT_RELATIVE_NAMES = ["artifact.json", "run.json", "report.json"];

function isPathInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryEntries(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function profileStateDir(projectRoot, profile) {
  return path.join(projectRoot, ".meta-kim", "state", profile);
}

async function resolveActiveAuthorityRunIds(stateDir) {
  const ids = new Set();
  const spine = await readJsonIfPresent(path.join(stateDir, "spine", "spine-state.json"));
  if (typeof spine?.runId === "string") ids.add(spine.runId);
  const activeRun = await readJsonIfPresent(path.join(stateDir, "active-run.json"));
  if (typeof activeRun?.runId === "string") ids.add(activeRun.runId);
  return ids;
}

async function hasArtifact(projectRoot, stateDir, runId) {
  const governedDir = path.join(projectRoot, ".meta-kim", "governed-executions");
  const candidates = [
    path.join(governedDir, `${runId}.live.json`),
    path.join(governedDir, `${runId}.json`),
    ...ARTIFACT_RELATIVE_NAMES.map((name) => path.join(stateDir, "runs", runId, name)),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return true;
  }
  return false;
}

/**
 * Read every run status record in one profile and attach the two substance
 * signals the status envelope cannot carry: whether a governed-execution
 * artifact exists, and whether the run is the current active authority.
 *
 * A record that cannot be parsed, or whose directory name does not match its own
 * `runId`, is reported as unclassified and never becomes a prune candidate.
 */
export async function collectRunRetentionCandidates(projectRoot, options = {}) {
  const profile = typeof options.profile === "string" && PROFILE_PATTERN.test(options.profile)
    ? options.profile
    : "default";
  const stateDir = profileStateDir(projectRoot, profile);
  const runsDir = path.join(stateDir, "runs");
  const activeAuthorityRunIds = await resolveActiveAuthorityRunIds(stateDir);
  const entries = await directoryEntries(runsDir);

  const candidates = [];
  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= RUN_RETENTION_MAX_SCANNED_RUNS) break;
    if (!entry.isDirectory()) continue;
    scanned += 1;
    const runId = entry.name;
    const runDir = path.join(runsDir, runId);
    if (!isPathInside(runsDir, runDir) || !RUN_ID_PATTERN.test(runId)) {
      candidates.push({
        runId,
        substanceClass: null,
        isActiveAuthority: false,
        unreadableReason: "run_directory_name_out_of_contract",
      });
      continue;
    }
    const status = await readJsonIfPresent(path.join(runDir, "status.json"));
    if (!status || typeof status !== "object" || status.runId !== runId) {
      candidates.push({
        runId,
        substanceClass: null,
        isActiveAuthority: activeAuthorityRunIds.has(runId),
        unreadableReason: status ? "run_id_mismatch" : "status_unreadable",
      });
      continue;
    }
    candidates.push({
      runId,
      substanceClass: status.substanceClass ?? null,
      startedAt: status.startedAt ?? null,
      updatedAt: status.updatedAt ?? null,
      artifactPresent: await hasArtifact(projectRoot, stateDir, runId),
      isActiveAuthority: activeAuthorityRunIds.has(runId) || status.active === true,
    });
  }
  return { profile, runsDir, scanned, candidates };
}

/**
 * A record written before substance classification existed carries no
 * `substanceClass`. Re-deriving it through the shared substance definition keeps
 * the historical backlog classifiable without rewriting those records.
 */
function backfillSubstanceClass(candidate, status) {
  if (RUN_SUBSTANCE_CLASSES.includes(candidate.substanceClass)) return candidate;
  return {
    ...candidate,
    substanceClass: runSubstance(status, {
      artifactPresent: candidate.artifactPresent,
    }).substanceClass,
    substanceClassSource: "derived_from_legacy_status_fields",
  };
}

async function withBackfilledSubstance(projectRoot, collected) {
  const stateDir = profileStateDir(projectRoot, collected.profile);
  const resolved = [];
  for (const candidate of collected.candidates) {
    if (candidate.unreadableReason) {
      resolved.push(candidate);
      continue;
    }
    const status = await readJsonIfPresent(
      path.join(stateDir, "runs", candidate.runId, "status.json"),
    );
    resolved.push(backfillSubstanceClass(candidate, status));
  }
  return { ...collected, candidates: resolved };
}

async function pruneOldBackupBatches(backupRoot, retainedPasses) {
  const entries = await directoryEntries(backupRoot);
  const batches = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const removed = [];
  for (const batch of batches.slice(retainedPasses)) {
    const batchDir = path.join(backupRoot, batch);
    if (!isPathInside(backupRoot, batchDir)) continue;
    await rm(batchDir, { recursive: true, force: true });
    removed.push(batch);
  }
  return removed;
}

/**
 * Run one bounded retention pass.
 *
 * `apply: false` (the default) plans without moving anything, so the operator
 * sees what a pass would do before authorizing it. Retention has no install-time
 * caller: `scripts/compact-governed-runs.mjs` is the only entry point, because
 * run directories are user-owned state that an install must not touch.
 */
export async function applyRunRetention(projectRoot, options = {}) {
  const policy = options.policy ?? loadLiveRunRetentionPolicy();
  const collected = await withBackfilledSubstance(
    projectRoot,
    await collectRunRetentionCandidates(projectRoot, options),
  );
  const plan = planRunRetention(collected.candidates, policy, {
    observedAt: options.observedAt,
  });
  const stateDir = profileStateDir(projectRoot, collected.profile);

  if (options.apply !== true) {
    return {
      schemaVersion: RUN_RETENTION_MARKER_SCHEMA,
      migration: RUN_RETENTION_MIGRATION,
      applied: false,
      profile: collected.profile,
      scanned: collected.scanned,
      counts: plan.counts,
      plan,
      moved: [],
      failed: [],
    };
  }

  const batchId = `${RUN_RETENTION_MIGRATION}-${new Date(Date.parse(plan.observedAt)).toISOString().replace(/[:.]/gu, "-")}`;
  const backupRoot = path.join(stateDir, RUN_RETENTION_BACKUP_DIR);
  const batchDir = path.join(backupRoot, batchId);
  const moved = [];
  const failed = [];

  if (plan.prune.length > 0) {
    await mkdir(batchDir, { recursive: true });
  }
  for (const entry of plan.prune) {
    const sourceDir = path.join(stateDir, "runs", entry.runId);
    const targetDir = path.join(batchDir, entry.runId);
    if (!isPathInside(path.join(stateDir, "runs"), sourceDir) || !isPathInside(batchDir, targetDir)) {
      failed.push({ runId: entry.runId, reason: "path_outside_state_boundary" });
      continue;
    }
    try {
      await rename(sourceDir, targetDir);
      moved.push({ runId: entry.runId, substanceClass: entry.substanceClass, reason: entry.reason });
    } catch (error) {
      failed.push({ runId: entry.runId, reason: error?.code || "rename_failed" });
    }
  }

  const marker = {
    schemaVersion: RUN_RETENTION_MARKER_SCHEMA,
    migration: RUN_RETENTION_MIGRATION,
    applied: true,
    profile: collected.profile,
    observedAt: plan.observedAt,
    batchId,
    scanned: collected.scanned,
    counts: plan.counts,
    moved,
    failed,
    restoreFrom: path.join(
      ".meta-kim",
      "state",
      collected.profile,
      RUN_RETENTION_BACKUP_DIR,
      batchId,
    ),
    ownershipBoundary:
      "Only .meta-kim/state/<profile>/runs/** was read or moved. Install projections, runtime-sedimented project copies and user configuration were out of scope.",
  };

  if (moved.length > 0) {
    await writeFile(
      path.join(batchDir, "retention-manifest.json"),
      `${JSON.stringify(marker, null, 2)}\n`,
      "utf8",
    );
  }
  const migrationsDir = path.join(stateDir, "migrations");
  await mkdir(migrationsDir, { recursive: true });
  await writeFile(
    path.join(migrationsDir, `${RUN_RETENTION_MIGRATION}.json`),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
  const removedBatches = await pruneOldBackupBatches(backupRoot, policy.backupRetainedPasses);

  return { ...marker, plan, removedBackupBatches: removedBatches };
}
