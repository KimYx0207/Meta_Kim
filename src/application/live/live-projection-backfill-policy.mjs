/**
 * Rebuild policy for compact live projections already on disk.
 *
 * A compact projection is a pure fold of its governed-execution artifact, which
 * means a file written before the builder learned a field keeps serving the old
 * shape forever: the artifact still holds the input, but nothing re-reads it. One
 * measured project held 8 projections while 11 of its artifacts carried a declared
 * stage plan of 36 to 50 nodes — every node marked `planned_not_invoked` — and the
 * panel drew those runs as a single node, because `declaredPlan` was absent from
 * the projection the reader actually serves.
 *
 * This module is policy and validation only. It never touches the filesystem, so
 * a document can be checked and a plan reviewed before anything is written. The
 * ordering invariants below exist so that a document describing a pass which
 * would drop the record the panel serves, or which would hide a backup inside the
 * directory it scans, cannot be expressed at all.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LIVE_PROJECTION_BACKFILL_SCHEMA_VERSION = "meta-kim-live-projection-backfill-v1";

export const LIVE_PROJECTION_BACKFILL_CONFIG_URL = new URL(
  "../../../config/live/projection-backfill.json",
  import.meta.url,
);

/**
 * Every terminal state a planned entry can carry. Only `needs_backfill` authorizes
 * a write; the four unreadable/missing states exist so a projection the pass could
 * not safely rebuild is reported rather than dropped, and `up_to_date` is recorded
 * explicitly so "nothing to do" is distinguishable from "never examined".
 */
export const LIVE_PROJECTION_BACKFILL_STATUSES = Object.freeze([
  "needs_backfill",
  "up_to_date",
  "artifact_missing",
  "artifact_unreadable",
  "projection_unreadable",
  "rebuild_failed",
]);

/** The subset of statuses `applyLiveProjectionBackfill` is allowed to write. */
export const LIVE_PROJECTION_BACKFILL_WRITABLE_STATUSES = Object.freeze(["needs_backfill"]);

const PORTABLE_DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function fail(message, code = "LIVE_PROJECTION_BACKFILL_INVALID") {
  const error = new TypeError(`Live projection backfill: ${message}`);
  error.code = code;
  throw error;
}

function positiveInteger(value, label, ceiling) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
  if (value > ceiling) fail(`${label} must stay at or under ${ceiling}`);
  return value;
}

/**
 * The backup directory name is joined onto the state directory, so it has to be a
 * single portable segment: a traversal component or separator would place backups
 * outside the ownership boundary this pass is allowed to write.
 */
function portableDirectoryName(value, label) {
  if (typeof value !== "string" || !PORTABLE_DIRECTORY_NAME.test(value)) {
    fail(`${label} must be a single portable directory name`);
  }
  if (value === "." || value === "..") fail(`${label} must not be a traversal segment`);
  return value;
}

/** Validate and freeze a raw projection-backfill document. */
export function normalizeLiveProjectionBackfillPolicy(raw) {
  if (!raw || typeof raw !== "object") fail("document must be an object");
  if (raw.schemaVersion !== LIVE_PROJECTION_BACKFILL_SCHEMA_VERSION) {
    fail(
      `schemaVersion must be ${LIVE_PROJECTION_BACKFILL_SCHEMA_VERSION}`,
      "LIVE_PROJECTION_BACKFILL_SCHEMA_MISMATCH",
    );
  }
  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    maxRuns: positiveInteger(raw.maxRuns, "maxRuns", 100_000),
    /**
     * The artifact read is the one place this pass needs a bound of its own. The
     * live reader caps artifacts to protect a panel request, and a projection is
     * rebuilt from the same artifact — so a pass sharing that cap is blind to
     * exactly the largest runs, which are the ones whose projections matter most.
     * This is an explicitly invoked maintenance read, off the request path, so it
     * carries its own bound rather than widening the reader's for everyone.
     */
    maxArtifactBytes: positiveInteger(
      raw.maxArtifactBytes,
      "maxArtifactBytes",
      134_217_728,
    ),
    backupDirName: portableDirectoryName(raw.backupDirName, "backupDirName"),
    backupRetainedPasses: positiveInteger(
      raw.backupRetainedPasses,
      "backupRetainedPasses",
      100,
    ),
  });
}

/** Read and validate the shipped projection-backfill document. */
export function loadLiveProjectionBackfillPolicy(
  configUrl = LIVE_PROJECTION_BACKFILL_CONFIG_URL,
) {
  const filePath = fileURLToPath(configUrl);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(
      `cannot read ${filePath}: ${error.message}`,
      "LIVE_PROJECTION_BACKFILL_UNREADABLE",
    );
  }
  return normalizeLiveProjectionBackfillPolicy(parsed);
}

/**
 * How many entries one pass may plan. An explicit caller bound narrows the shipped
 * policy but never widens it, so a command-line typo cannot turn a bounded pass
 * into an unbounded sweep.
 */
export function resolveBackfillRunBound(policy, requested) {
  if (requested === undefined || requested === null) return policy.maxRuns;
  const bound = positiveInteger(requested, "maxRuns", policy.maxRuns);
  return Math.min(bound, policy.maxRuns);
}

/**
 * Which top-level keys a rebuilt projection adds, drops, or changes relative to the
 * projection currently on disk. This is what makes a report reviewable: a caller can
 * see that a pass would introduce `declaredPlan` rather than being told only that
 * some bytes differ.
 */
export function diffProjectionKeys(current, rebuilt) {
  const currentKeys = current && typeof current === "object" ? Object.keys(current) : [];
  const rebuiltKeys = rebuilt && typeof rebuilt === "object" ? Object.keys(rebuilt) : [];
  const currentSet = new Set(currentKeys);
  const rebuiltSet = new Set(rebuiltKeys);
  const addedKeys = rebuiltKeys.filter((key) => !currentSet.has(key));
  const removedKeys = currentKeys.filter((key) => !rebuiltSet.has(key));
  const changedKeys = rebuiltKeys.filter(
    (key) => currentSet.has(key) && JSON.stringify(current[key]) !== JSON.stringify(rebuilt[key]),
  );
  return {
    addedKeys: Object.freeze(addedKeys),
    removedKeys: Object.freeze(removedKeys),
    changedKeys: Object.freeze(changedKeys),
  };
}
