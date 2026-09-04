/**
 * Retention policy for persisted governed-run directory entries.
 *
 * A single full scan of one long-lived project found 1004 run directories under
 * `.meta-kim/state/default/runs/`, spanning 50 days with daily peaks of 77, 68
 * and 61 — effectively one persisted entry per governance prompt. 994 of them
 * sat at Critical with zero completed stages, all 1004 carried zero worker
 * lifecycle records, and all 1004 had zero replay events. Nothing in the state
 * writer expired them, so the session directory grew without bound and read as a
 * wall of identical empty rows.
 *
 * This module is policy plus planning only. It never touches the filesystem, so
 * a plan can be inspected, tested and reviewed before anything is moved. The
 * planner is deliberately conservative: a run that advanced a stage, recorded a
 * worker, produced an artifact, or is still the active authority is protected
 * regardless of age, and a record that cannot be classified is left alone rather
 * than guessed at.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RUN_SUBSTANCE_CLASSES, runSubstance } from "./live-run-substance.mjs";

export const LIVE_RUN_RETENTION_SCHEMA_VERSION = "meta-kim-live-run-retention-v1";

export const LIVE_RUN_RETENTION_CONFIG_URL = new URL(
  "../../../config/live/run-retention.json",
  import.meta.url,
);

export const RUN_RETENTION_DECISIONS = Object.freeze([
  "keep",
  "prune",
  "protected",
  "unclassified",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function fail(message, code = "LIVE_RUN_RETENTION_INVALID") {
  const error = new TypeError(`Live run retention: ${message}`);
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
 * The panel window may legitimately be zero — "show no receipts at all" is a
 * coherent reading choice, because the active run and every run that recorded
 * output bypass the receipt fold entirely. Zero retention days would instead mean
 * "delete on sight", which is why the prune fields keep the stricter validator.
 */
function nonNegativeInteger(value, label, ceiling) {
  if (!Number.isInteger(value) || value < 0) {
    fail(`${label} must be a non-negative integer`);
  }
  if (value > ceiling) fail(`${label} must stay at or under ${ceiling}`);
  return value;
}

/** Validate and freeze a raw run-retention document. */
export function normalizeLiveRunRetentionPolicy(raw) {
  if (!raw || typeof raw !== "object") fail("document must be an object");
  if (raw.schemaVersion !== LIVE_RUN_RETENTION_SCHEMA_VERSION) {
    fail(
      `schemaVersion must be ${LIVE_RUN_RETENTION_SCHEMA_VERSION}`,
      "LIVE_RUN_RETENTION_SCHEMA_MISMATCH",
    );
  }
  const activationOnlyRetentionDays = positiveInteger(
    raw.activationOnlyRetentionDays,
    "activationOnlyRetentionDays",
    3650,
  );
  const substantiveRetentionDays = positiveInteger(
    raw.substantiveRetentionDays,
    "substantiveRetentionDays",
    3650,
  );
  const activationOnlyMaxEntries = positiveInteger(
    raw.activationOnlyMaxEntries,
    "activationOnlyMaxEntries",
    100_000,
  );
  const substantiveMaxEntries = positiveInteger(
    raw.substantiveMaxEntries,
    "substantiveMaxEntries",
    100_000,
  );
  // A shell that outlives a run which did work would invert the whole point of
  // classifying substance, so the policy refuses that shape outright.
  if (activationOnlyRetentionDays > substantiveRetentionDays) {
    fail(
      "activationOnlyRetentionDays must not exceed substantiveRetentionDays",
      "LIVE_RUN_RETENTION_WINDOWS_INVERTED",
    );
  }
  if (activationOnlyMaxEntries > substantiveMaxEntries) {
    fail(
      "activationOnlyMaxEntries must not exceed substantiveMaxEntries",
      "LIVE_RUN_RETENTION_CAPS_INVERTED",
    );
  }
  // How many receipts the session list shows is a separate question from how long
  // they stay on disk, and conflating the two was a live defect: a machine with 47
  // receipts across 13 projects could only quiet the list by also authorizing the
  // prune pass to delete those records. Absent panel fields mean "same as
  // retention", so an older document keeps its current behaviour.
  const activationOnlyVisibleDays = nonNegativeInteger(
    raw.activationOnlyVisibleDays ?? activationOnlyRetentionDays,
    "activationOnlyVisibleDays",
    3650,
  );
  const activationOnlyVisibleMaxEntries = nonNegativeInteger(
    raw.activationOnlyVisibleMaxEntries ?? activationOnlyMaxEntries,
    "activationOnlyVisibleMaxEntries",
    100_000,
  );
  // Ordered under the prune window, so "the list promises a row the prune pass may
  // already have taken" is not a state the document can describe.
  if (activationOnlyVisibleDays > activationOnlyRetentionDays) {
    fail(
      "activationOnlyVisibleDays must not exceed activationOnlyRetentionDays",
      "LIVE_RUN_RETENTION_VISIBLE_WINDOW_INVALID",
    );
  }
  if (activationOnlyVisibleMaxEntries > activationOnlyMaxEntries) {
    fail(
      "activationOnlyVisibleMaxEntries must not exceed activationOnlyMaxEntries",
      "LIVE_RUN_RETENTION_VISIBLE_CAP_INVALID",
    );
  }
  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    activationOnlyRetentionDays,
    activationOnlyMaxEntries,
    activationOnlyVisibleDays,
    activationOnlyVisibleMaxEntries,
    substantiveRetentionDays,
    substantiveMaxEntries,
    maxPrunePerPass: positiveInteger(raw.maxPrunePerPass, "maxPrunePerPass", 10_000),
    backupRetainedPasses: positiveInteger(
      raw.backupRetainedPasses,
      "backupRetainedPasses",
      100,
    ),
  });
}

/** Read and validate the shipped run-retention document. */
export function loadLiveRunRetentionPolicy(configUrl = LIVE_RUN_RETENTION_CONFIG_URL) {
  const filePath = fileURLToPath(configUrl);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`cannot read ${filePath}: ${error.message}`, "LIVE_RUN_RETENTION_UNREADABLE");
  }
  return normalizeLiveRunRetentionPolicy(parsed);
}

function timestampMs(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Retention refuses to guess: a candidate with no classifiable substance class is
 * reported as unclassified and never becomes a prune candidate. Everything else
 * goes through the shared substance definition, which additionally treats a
 * governed-execution artifact or replay events as real output even when the
 * status envelope never left Critical.
 */
export function classifyRetentionCandidate(candidate) {
  if (!RUN_SUBSTANCE_CLASSES.includes(candidate?.substanceClass)) return "unclassified";
  return runSubstance(candidate, {
    artifactPresent: candidate?.artifactPresent,
    eventCount: candidate?.eventCount,
  }).substanceClass;
}

function decide(candidate, substanceClass, cutoffMs, observedAtMs) {
  if (candidate.isActiveAuthority === true) {
    return { decision: "protected", reason: "active_authority_run" };
  }
  if (substanceClass === "unclassified") {
    return { decision: "unclassified", reason: "status_record_not_classifiable" };
  }
  const updatedAtMs = timestampMs(candidate.updatedAt) ?? timestampMs(candidate.startedAt);
  if (updatedAtMs === null) {
    return { decision: "unclassified", reason: "no_readable_timestamp" };
  }
  if (updatedAtMs > observedAtMs) {
    return { decision: "keep", reason: "timestamp_ahead_of_observation" };
  }
  if (updatedAtMs >= cutoffMs) {
    return { decision: "keep", reason: "inside_retention_window" };
  }
  return { decision: "prune", reason: "outside_retention_window" };
}

/**
 * Plan a retention pass over already-classified run candidates.
 *
 * Pure: callers supply the candidate list and the observation time, and receive
 * an ordered plan. Age expiry runs first, then the per-class entry cap trims the
 * oldest survivors, then `maxPrunePerPass` bounds the batch so a machine with a
 * thousand shells converges over several explicit compaction commands rather than
 * one long sweep. Oldest-first prune order keeps that convergence monotone.
 */
export function planRunRetention(candidates, policy, options = {}) {
  const normalizedPolicy = policy?.schemaVersion === LIVE_RUN_RETENTION_SCHEMA_VERSION
    ? policy
    : normalizeLiveRunRetentionPolicy(policy);
  const observedAtMs = timestampMs(options.observedAt) ?? Date.now();
  const list = Array.isArray(candidates) ? candidates : [];

  const cutoffs = {
    activation_only:
      observedAtMs - normalizedPolicy.activationOnlyRetentionDays * DAY_MS,
    substantive: observedAtMs - normalizedPolicy.substantiveRetentionDays * DAY_MS,
  };
  const caps = {
    activation_only: normalizedPolicy.activationOnlyMaxEntries,
    substantive: normalizedPolicy.substantiveMaxEntries,
  };

  const evaluated = list.map((candidate) => {
    const substanceClass = classifyRetentionCandidate(candidate);
    const { decision, reason } = decide(
      candidate,
      substanceClass,
      cutoffs[substanceClass] ?? cutoffs.substantive,
      observedAtMs,
    );
    return {
      runId: candidate?.runId ?? null,
      substanceClass,
      decision,
      reason,
      sortKey: timestampMs(candidate?.updatedAt) ?? timestampMs(candidate?.startedAt) ?? 0,
    };
  });

  for (const substanceClass of ["activation_only", "substantive"]) {
    const survivors = evaluated
      .filter((entry) => entry.substanceClass === substanceClass && entry.decision === "keep")
      .sort((left, right) => right.sortKey - left.sortKey);
    for (const entry of survivors.slice(caps[substanceClass])) {
      entry.decision = "prune";
      entry.reason = "over_max_entries";
    }
  }

  const pruneOrdered = evaluated
    .filter((entry) => entry.decision === "prune")
    .sort((left, right) => left.sortKey - right.sortKey);
  const deferred = pruneOrdered.slice(normalizedPolicy.maxPrunePerPass);
  for (const entry of deferred) {
    entry.decision = "keep";
    entry.reason = "deferred_by_max_prune_per_pass";
  }

  const byDecision = (decision) =>
    evaluated
      .filter((entry) => entry.decision === decision)
      .map(({ runId, substanceClass, reason }) => ({ runId, substanceClass, reason }));

  return Object.freeze({
    schemaVersion: "meta-kim-live-run-retention-plan-v1",
    observedAt: new Date(observedAtMs).toISOString(),
    policy: normalizedPolicy,
    counts: Object.freeze({
      candidates: evaluated.length,
      prune: evaluated.filter((entry) => entry.decision === "prune").length,
      keep: evaluated.filter((entry) => entry.decision === "keep").length,
      protected: evaluated.filter((entry) => entry.decision === "protected").length,
      unclassified: evaluated.filter((entry) => entry.decision === "unclassified").length,
      deferred: deferred.length,
    }),
    prune: Object.freeze(
      pruneOrdered
        .slice(0, normalizedPolicy.maxPrunePerPass)
        .map(({ runId, substanceClass, reason }) => ({ runId, substanceClass, reason })),
    ),
    keep: Object.freeze(byDecision("keep")),
    protectedRuns: Object.freeze(byDecision("protected")),
    unclassified: Object.freeze(byDecision("unclassified")),
  });
}
