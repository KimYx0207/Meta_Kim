/**
 * Rebuild compact live projections from the artifacts they were folded from.
 *
 * A projection is a pure fold of its governed-execution artifact, so a file
 * written before the builder learned a field keeps serving the old shape forever.
 * The artifact still holds the input; nothing re-reads it. This module re-reads it,
 * on demand, under four properties borrowed from the retention store:
 *
 * - bounded: one pass plans at most `maxRuns` entries and reports what it omitted.
 * - reversible: the bytes it replaces are copied into a timestamped batch first.
 * - ownership-bounded: it writes only `<runId>.live.json` under the execution
 *   directory, plus the `liveProjection*` fields of a pointer that already claims
 *   the file it just rebuilt. Artifacts are inputs and are never written.
 * - never-unlinked: a projection it could not rebuild is reported and left alone.
 *
 * Report mode and apply mode share one classifier, and apply re-classifies each
 * entry immediately before writing, so a plan that went stale on disk cannot be
 * replayed over newer bytes.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  LIVE_PROJECTION_BACKFILL_STATUSES,
  LIVE_PROJECTION_BACKFILL_WRITABLE_STATUSES,
  diffProjectionKeys,
  loadLiveProjectionBackfillPolicy,
  resolveBackfillRunBound,
} from "../../application/live/live-projection-backfill-policy.mjs";
import { prepareLiveProjectionRecord } from "../../application/live/prepare-live-projection-record.mjs";
import {
  LIVE_DEFAULT_PROFILE,
  LIVE_MAX_COMPACT_JSON_BYTES,
  isPathInside,
  normalizeLiveRunId,
  resolveLiveProjectRoot,
  safeReadJson,
  sanitizeLiveProfile,
} from "./live-read-repository.mjs";

const PROJECTION_SUFFIX = ".live.json";
const BACKFILL_MIGRATION = "projection-backfill";

const OWNERSHIP_BOUNDARY = [
  "Rewrote only <runId>.live.json files under .meta-kim/state/<profile>/governed-executions/,",
  "and the liveProjection digest and byte count of a latest.json pointer that already named the rebuilt file.",
  "Governed-execution artifacts, install projections, runtime-sedimented project copies and user configuration",
  "are different ownership classes and were not touched.",
].join(" ");

function digestOf(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function emptyCounts() {
  return Object.fromEntries(LIVE_PROJECTION_BACKFILL_STATUSES.map((status) => [status, 0]));
}

function projectionRunId(fileName) {
  if (!fileName.endsWith(PROJECTION_SUFFIX)) return null;
  return normalizeLiveRunId(fileName.slice(0, -PROJECTION_SUFFIX.length));
}

async function listProjectionRunIds(executionDir) {
  let names;
  try {
    names = await fs.readdir(executionDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return names.map(projectionRunId).filter((runId) => runId !== null);
}

/**
 * The pointer target is planned first so a bound can never drop the one record the
 * panel actually serves; everything else is newest-first by runId, which is free and
 * deterministic. Ordering by file mtime would cost a stat per candidate — the very
 * work the bound exists to avoid — and would reorder between two identical passes.
 */
function orderCandidates(runIds, pointerRunId) {
  const rest = runIds.filter((runId) => runId !== pointerRunId).sort().reverse();
  return runIds.includes(pointerRunId) ? [pointerRunId, ...rest] : rest;
}

async function readPointer(root, executionDir) {
  const result = await safeReadJson(root, path.join(executionDir, "latest.json"));
  if (result.status !== "valid") return { record: null, raw: null, runId: null };
  return {
    record: result.value,
    raw: result.raw,
    runId: normalizeLiveRunId(result.value.runId),
  };
}

/**
 * Classify one projection against the artifact it claims to fold. Returns the entry
 * plus the bytes apply would need, so the caller can either report or write without
 * a second classification pass drifting from the first.
 */
async function classifyRun(root, executionDir, runId, { isPointerTarget, maxArtifactBytes }) {
  const projectionPath = path.join(executionDir, `${runId}${PROJECTION_SUFFIX}`);
  const artifactPath = path.join(executionDir, `${runId}.json`);
  const base = {
    runId,
    projectionPath,
    artifactPath,
    isPointerTarget,
    currentBytes: null,
    currentSha256: null,
    rebuiltBytes: null,
    rebuiltSha256: null,
    addedKeys: [],
    removedKeys: [],
    changedKeys: [],
    error: null,
  };

  const projection = await safeReadJson(root, projectionPath, {
    maxBytes: LIVE_MAX_COMPACT_JSON_BYTES,
  });
  if (projection.status !== "valid") {
    return {
      entry: { ...base, status: "projection_unreadable", error: projection.status },
      currentRaw: null,
      rebuiltContent: null,
    };
  }
  const currentRaw = projection.raw;
  const withCurrent = {
    ...base,
    currentBytes: Buffer.byteLength(currentRaw, "utf8"),
    currentSha256: digestOf(currentRaw),
  };

  const artifact = await safeReadJson(root, artifactPath, { maxBytes: maxArtifactBytes });
  if (artifact.status !== "valid") {
    const status = artifact.status === "missing" ? "artifact_missing" : "artifact_unreadable";
    return {
      entry: { ...withCurrent, status, error: artifact.status },
      currentRaw,
      rebuiltContent: null,
    };
  }

  let rebuilt;
  try {
    rebuilt = prepareLiveProjectionRecord(artifact.value);
  } catch (error) {
    return {
      entry: { ...withCurrent, status: "rebuild_failed", error: error.message },
      currentRaw,
      rebuiltContent: null,
    };
  }

  if (rebuilt.content === currentRaw) {
    return {
      entry: {
        ...withCurrent,
        status: "up_to_date",
        rebuiltBytes: rebuilt.bytes,
        rebuiltSha256: rebuilt.sha256,
      },
      currentRaw,
      rebuiltContent: rebuilt.content,
    };
  }

  return {
    entry: {
      ...withCurrent,
      status: "needs_backfill",
      rebuiltBytes: rebuilt.bytes,
      rebuiltSha256: rebuilt.sha256,
      ...diffProjectionKeys(projection.value, rebuilt.projection),
    },
    currentRaw,
    rebuiltContent: rebuilt.content,
  };
}

/**
 * Plan a projection rebuild pass. Reads only; the returned plan is safe to print,
 * store, or review before anything is written.
 */
export async function planLiveProjectionBackfill({
  projectRoot,
  profile = LIVE_DEFAULT_PROFILE,
  maxRuns,
  policy,
  configUrl,
  cwd,
  env,
} = {}) {
  const root = await resolveLiveProjectRoot({ cwd, projectRoot, env });
  if (!root) {
    // A silent empty plan here would read exactly like "every projection is current",
    // which is the one conclusion a caller must never draw from a bad root.
    const error = new Error(
      "Live projection backfill: no marker-backed project root was resolved.",
    );
    error.code = "LIVE_PROJECTION_BACKFILL_NO_PROJECT_ROOT";
    throw error;
  }
  const resolvedProfile = sanitizeLiveProfile(profile);
  const resolvedPolicy = policy ?? loadLiveProjectionBackfillPolicy(
    ...(configUrl ? [configUrl] : []),
  );
  const stateDir = path.join(root, ".meta-kim", "state", resolvedProfile);
  const executionDir = path.join(stateDir, "governed-executions");

  const pointer = await readPointer(root, executionDir);
  const ordered = orderCandidates(await listProjectionRunIds(executionDir), pointer.runId);
  const bound = resolveBackfillRunBound(resolvedPolicy, maxRuns);
  const planned = ordered.slice(0, bound);

  const counts = emptyCounts();
  const entries = [];
  for (const runId of planned) {
    const { entry } = await classifyRun(root, executionDir, runId, {
      isPointerTarget: runId === pointer.runId,
      maxArtifactBytes: resolvedPolicy.maxArtifactBytes,
    });
    counts[entry.status] += 1;
    entries.push(entry);
  }

  return {
    projectRoot: root,
    profile: resolvedProfile,
    stateDir,
    executionDir,
    observedAt: new Date().toISOString(),
    pointerRunId: pointer.runId,
    policy: resolvedPolicy,
    entries,
    counts,
    candidateRunCount: ordered.length,
    omittedRunCount: Math.max(0, ordered.length - planned.length),
  };
}

function batchIdFrom(observedAt) {
  const parsed = Date.parse(observedAt);
  const stamp = Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : new Date(0).toISOString();
  return `${BACKFILL_MIGRATION}-${stamp.replace(/[:.]/gu, "-")}`;
}

async function atomicWriteText(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, content, "utf8");
  await fs.rename(temporaryPath, filePath);
}

/**
 * Rewrite the pointer's projection digest and byte count so the reader keeps serving
 * the projection instead of silently falling back to the raw artifact.
 *
 * Only a pointer that already names the rebuilt file is updated. A pointer with no
 * `liveProjectionPath` is left alone: adding one would move that run from the raw
 * artifact onto the projection path, which is a different decision than rebuilding a
 * projection someone already chose to publish.
 */
async function updatePointerFor(plan, pointer, entry, content) {
  if (!pointer.record || pointer.runId !== entry.runId) return "pointer_not_target";
  const declared = pointer.record.liveProjectionPath;
  if (typeof declared !== "string" || !declared.trim()) return "pointer_declares_no_projection";
  const declaredPath = path.resolve(plan.projectRoot, declared);
  if (path.resolve(declaredPath) !== path.resolve(entry.projectionPath)) {
    return "pointer_names_a_different_file";
  }
  await atomicWriteText(
    path.join(plan.executionDir, "latest.json"),
    `${JSON.stringify(
      {
        ...pointer.record,
        liveProjectionSha256: digestOf(content),
        liveProjectionBytes: Buffer.byteLength(content, "utf8"),
      },
      null,
      2,
    )}\n`,
  );
  return "pointer_updated";
}

async function pruneOldBackupBatches(backupRoot, retainedPasses) {
  let names;
  try {
    names = await fs.readdir(backupRoot);
  } catch {
    return [];
  }
  const batches = names
    .filter((name) => name.startsWith(`${BACKFILL_MIGRATION}-`))
    .sort()
    .reverse();
  const dropped = batches.slice(retainedPasses);
  for (const name of dropped) {
    await fs.rm(path.join(backupRoot, name), { recursive: true, force: true });
  }
  return dropped;
}

/**
 * Apply a plan. Each entry is re-classified immediately before it is written, so a
 * plan produced against older bytes cannot overwrite newer ones.
 */
export async function applyLiveProjectionBackfill(plan) {
  const writable = plan.entries.filter((entry) =>
    LIVE_PROJECTION_BACKFILL_WRITABLE_STATUSES.includes(entry.status),
  );
  const written = [];
  const failed = [];
  if (writable.length === 0) {
    return {
      applied: 0,
      written,
      failed,
      backupDir: null,
      restoreFrom: null,
      prunedBackupBatches: [],
      ownershipBoundary: OWNERSHIP_BOUNDARY,
    };
  }

  const backupRoot = path.join(plan.stateDir, plan.policy.backupDirName);
  const backupDir = path.join(backupRoot, batchIdFrom(plan.observedAt));
  await fs.mkdir(backupDir, { recursive: true });
  const pointer = await readPointer(plan.projectRoot, plan.executionDir);

  for (const planned of writable) {
    const backupPath = path.join(backupDir, `${planned.runId}${PROJECTION_SUFFIX}`);
    if (
      !isPathInside(plan.executionDir, planned.projectionPath) ||
      !isPathInside(backupRoot, backupPath)
    ) {
      failed.push({ runId: planned.runId, reason: "path_outside_state_boundary" });
      continue;
    }

    const fresh = await classifyRun(plan.projectRoot, plan.executionDir, planned.runId, {
      isPointerTarget: planned.isPointerTarget,
      maxArtifactBytes: plan.policy.maxArtifactBytes,
    });
    if (fresh.entry.status !== "needs_backfill") {
      failed.push({ runId: planned.runId, reason: `changed_since_plan:${fresh.entry.status}` });
      continue;
    }

    try {
      await fs.writeFile(backupPath, fresh.currentRaw, "utf8");
      await atomicWriteText(planned.projectionPath, fresh.rebuiltContent);
      const pointerOutcome = await updatePointerFor(
        plan,
        pointer,
        fresh.entry,
        fresh.rebuiltContent,
      );
      written.push({ ...fresh.entry, pointerOutcome, backupPath });
    } catch (error) {
      failed.push({ runId: planned.runId, reason: `write_failed:${error.message}` });
    }
  }

  return {
    applied: written.length,
    written,
    failed,
    backupDir,
    restoreFrom: path.relative(plan.projectRoot, backupDir) || backupDir,
    prunedBackupBatches: await pruneOldBackupBatches(
      backupRoot,
      plan.policy.backupRetainedPasses,
    ),
    ownershipBoundary: OWNERSHIP_BOUNDARY,
  };
}
