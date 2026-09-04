/**
 * Read-side visibility for governed-run sessions.
 *
 * Prune policy and read policy answer different questions from the same document:
 * retention decides what may leave the disk, visibility decides what the default
 * session list is worth showing. A run that only ever recorded its own activation
 * is a receipt, not a session, so past the activation window it is folded away and
 * counted — never dropped silently, and never before it has had the chance to do
 * work. Both sides read `config/live/run-retention.json`, so an operator tunes one
 * file instead of two, but they read *different fields* of it: a machine measured
 * with 47 receipts across 13 projects needs a quieter list without also authorizing
 * the prune pass to delete the records behind it.
 */
import { RUN_SUBSTANCE_CLASSES } from "./live-run-substance.mjs";

export const LIVE_RUN_VISIBILITY_SCHEMA_VERSION = "meta-kim-live-run-visibility-v1";

const DAY_MS = 24 * 60 * 60 * 1000;

function timestampMs(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decide one session in isolation. Anything unclassifiable, undatable, or newer
 * than the observation point stays visible: a read filter that guesses is worse
 * than a longer list.
 *
 * The two omission reasons are not interchangeable. `outside_visible_window` means
 * the record is still on disk and a wider panel window would show it again;
 * `outside_retention_window` means the prune pass is already free to remove it. The
 * panel fields are supplied by `normalizeLiveRunRetentionPolicy`, which fills them
 * from the retention window when a document omits them — an un-normalized policy
 * therefore yields a longer list rather than a silently emptied one.
 */
function decideSession(session, policy, observedMs) {
  if (session?.active === true) return { visible: true, reason: "active_run" };
  if (!RUN_SUBSTANCE_CLASSES.includes(session?.substanceClass)) {
    return { visible: true, reason: "session_not_classifiable" };
  }
  if (session.substanceClass !== "activation_only") {
    return { visible: true, reason: "recorded_output" };
  }
  const updatedMs = timestampMs(session.updatedAt);
  if (updatedMs === null) return { visible: true, reason: "no_readable_timestamp" };
  if (updatedMs > observedMs) return { visible: true, reason: "timestamp_ahead_of_observation" };
  const ageMs = observedMs - updatedMs;
  if (ageMs > policy.activationOnlyRetentionDays * DAY_MS) {
    return { visible: false, reason: "outside_retention_window" };
  }
  if (ageMs > policy.activationOnlyVisibleDays * DAY_MS) {
    return { visible: false, reason: "outside_visible_window" };
  }
  return { visible: true, reason: "inside_retention_window", capped: true, updatedMs };
}

/** Map the receipts trimmed by either cap to the cap that trimmed them. */
function cappedOverflow(decided, policy) {
  const capped = decided
    .filter((entry) => entry.decision.capped)
    .sort((left, right) => right.decision.updatedMs - left.decision.updatedMs);
  const overflow = new Map();
  capped.forEach((entry, rank) => {
    if (rank >= policy.activationOnlyMaxEntries) {
      overflow.set(entry.index, "over_max_entries");
      return;
    }
    if (rank >= policy.activationOnlyVisibleMaxEntries) {
      overflow.set(entry.index, "over_visible_max_entries");
    }
  });
  return overflow;
}

function sessionRef(session) {
  return {
    runId: session?.runId ?? null,
    sessionId: session?.sessionId ?? session?.runId ?? null,
  };
}

/**
 * Plan the default session list for one project.
 *
 * Returns the incoming order untouched for surviving sessions, each annotated with
 * the reason it survived, plus the folded-away sessions and a count the caller is
 * expected to surface. Input sessions are never mutated.
 */
export function planSessionVisibility(sessions, policy, options = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const observedMs = timestampMs(options.observedAt) ?? Date.now();
  const decided = list.map((session, index) => ({
    index,
    session,
    decision: decideSession(session, policy, observedMs),
  }));
  const overflow = cappedOverflow(decided, policy);

  const visible = [];
  const omitted = [];
  for (const entry of decided) {
    if (entry.decision.visible && !overflow.has(entry.index)) {
      visible.push({ ...entry.session, visibilityReason: entry.decision.reason });
      continue;
    }
    omitted.push({
      ...sessionRef(entry.session),
      reason: overflow.get(entry.index) ?? entry.decision.reason,
    });
  }

  return Object.freeze({
    schemaVersion: LIVE_RUN_VISIBILITY_SCHEMA_VERSION,
    observedAt: new Date(observedMs).toISOString(),
    visible,
    omitted,
    counts: { total: list.length, visible: visible.length, omitted: omitted.length },
  });
}
