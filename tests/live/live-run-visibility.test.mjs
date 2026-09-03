import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_RUN_VISIBILITY_SCHEMA_VERSION,
  planSessionVisibility,
} from "../../src/application/live/live-run-visibility.mjs";
import {
  LIVE_RUN_RETENTION_SCHEMA_VERSION,
  normalizeLiveRunRetentionPolicy,
  planRunRetention,
} from "../../src/application/live/live-run-retention.mjs";

const OBSERVED_AT = "2026-09-01T00:00:00.000Z";

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

function session(runId, extra = {}) {
  return { runId, sessionId: runId, substanceClass: "activation_only", active: false, ...extra };
}

function plan(sessions, overrides = {}) {
  return planSessionVisibility(sessions, policy(overrides), { observedAt: OBSERVED_AT });
}

test("the default session list drops stale shells and keeps every run that means something", () => {
  const result = plan([
    session("meta-active", { updatedAt: daysBefore(400), active: true }),
    session("meta-real", { substanceClass: "substantive", updatedAt: daysBefore(400) }),
    session("meta-just-started", { updatedAt: daysBefore(0.01) }),
    session("meta-stale-shell", { updatedAt: daysBefore(30) }),
  ]);

  assert.equal(result.schemaVersion, LIVE_RUN_VISIBILITY_SCHEMA_VERSION);
  assert.deepEqual(result.visible.map((entry) => entry.runId), [
    "meta-active",
    "meta-real",
    "meta-just-started",
  ]);
  assert.deepEqual(result.omitted, [
    { runId: "meta-stale-shell", sessionId: "meta-stale-shell", reason: "outside_retention_window" },
  ]);
  assert.deepEqual(result.counts, { total: 4, visible: 3, omitted: 1 });
  assert.ok(Object.isFrozen(result));
});

test("visibility never hides what it cannot classify or cannot date", () => {
  const result = plan([
    session("meta-no-class", { substanceClass: null, updatedAt: daysBefore(400) }),
    session("meta-no-date", { updatedAt: null }),
    session("meta-future", { updatedAt: daysBefore(-5) }),
  ]);

  assert.deepEqual(result.omitted, []);
  assert.deepEqual(
    result.visible.map((entry) => entry.visibilityReason).sort(),
    ["no_readable_timestamp", "session_not_classifiable", "timestamp_ahead_of_observation"],
  );
});

test("a burst of fresh shells is bounded by the same cap the prune pass uses", () => {
  const sessions = Array.from({ length: 6 }, (unused, index) =>
    session(`meta-shell-${index}`, { updatedAt: daysBefore(index / 24) }),
  );

  const result = plan(sessions, { activationOnlyMaxEntries: 2 });

  assert.deepEqual(result.visible.map((entry) => entry.runId), ["meta-shell-0", "meta-shell-1"]);
  assert.equal(result.counts.omitted, 4);
  assert.equal(
    result.omitted.every((entry) => entry.reason === "over_max_entries"),
    true,
  );
});

test("the cap never reaches a run that did work", () => {
  const sessions = Array.from({ length: 4 }, (unused, index) =>
    session(`meta-real-${index}`, { substanceClass: "substantive", updatedAt: daysBefore(index) }),
  );

  const result = plan(sessions, { activationOnlyMaxEntries: 1 });

  assert.equal(result.counts.omitted, 0);
  assert.equal(result.visible.length, 4);
});

test("visibility preserves the order the read layer already resolved", () => {
  const result = plan([
    session("meta-b", { substanceClass: "substantive", updatedAt: daysBefore(10) }),
    session("meta-a", { substanceClass: "substantive", updatedAt: daysBefore(1) }),
    session("meta-c", { updatedAt: daysBefore(0.5) }),
  ]);

  assert.deepEqual(result.visible.map((entry) => entry.runId), ["meta-b", "meta-a", "meta-c"]);
});

test("visibility annotates each surviving session without rewriting it", () => {
  const original = session("meta-real", { substanceClass: "substantive", updatedAt: daysBefore(1) });
  const result = plan([original]);

  assert.equal(result.visible[0].visibilityReason, "recorded_output");
  assert.equal(original.visibilityReason, undefined, "the read layer's session objects stay untouched");
});

test("an empty list plans to an empty result instead of throwing", () => {
  const result = plan([]);
  assert.deepEqual(result.visible, []);
  assert.deepEqual(result.counts, { total: 0, visible: 0, omitted: 0 });
});

/**
 * A read of one real machine found 47 of 84 visible rows were activation receipts,
 * and eleven of thirteen non-empty projects showed a list made entirely of them —
 * rows with no chat to link and no graph to draw. Narrowing the receipt window was
 * the obvious answer and was the wrong one: the same two fields also set the prune
 * cutoff, so quieting the list would have authorized deleting the records behind it.
 * The panel window is therefore its own pair of fields, ordered under the retention
 * window so the list can never promise a row the prune pass may already remove.
 */
function retentionCandidates(sessions) {
  return sessions.map((entry) => ({
    runId: entry.runId,
    substanceClass: entry.substanceClass,
    updatedAt: entry.updatedAt,
  }));
}

test("narrowing the panel window does not authorize deleting the records behind it", () => {
  const shell = session("meta-two-day-shell", { updatedAt: daysBefore(2) });
  const narrowed = policy({ activationOnlyVisibleDays: 1 });

  const shown = planSessionVisibility([shell], narrowed, { observedAt: OBSERVED_AT });

  assert.deepEqual(shown.visible, []);
  assert.deepEqual(shown.omitted, [
    {
      runId: "meta-two-day-shell",
      sessionId: "meta-two-day-shell",
      reason: "outside_visible_window",
    },
  ]);

  const onDisk = planRunRetention(retentionCandidates([shell]), narrowed, {
    observedAt: OBSERVED_AT,
  });

  assert.deepEqual(
    onDisk.prune,
    [],
    "the panel window must not reach the prune decision",
  );
});

test("the panel cap trims the list without trimming the directory", () => {
  const shells = Array.from({ length: 6 }, (unused, index) =>
    session(`meta-shell-${index}`, { updatedAt: daysBefore(index / 24) }),
  );
  const narrowed = policy({ activationOnlyVisibleMaxEntries: 2 });

  const shown = planSessionVisibility(shells, narrowed, { observedAt: OBSERVED_AT });

  assert.deepEqual(shown.visible.map((entry) => entry.runId), [
    "meta-shell-0",
    "meta-shell-1",
  ]);
  assert.deepEqual(
    shown.omitted.map((entry) => entry.reason),
    Array.from({ length: 4 }, () => "over_visible_max_entries"),
  );

  const onDisk = planRunRetention(retentionCandidates(shells), narrowed, {
    observedAt: OBSERVED_AT,
  });

  assert.deepEqual(onDisk.prune, [], "the panel cap must not reach the prune decision");
});

test("a panel window wider than the retention window is not expressible", () => {
  assert.throws(() => policy({ activationOnlyVisibleDays: 5 }), {
    code: "LIVE_RUN_RETENTION_VISIBLE_WINDOW_INVALID",
  });
  assert.throws(() => policy({ activationOnlyVisibleMaxEntries: 41 }), {
    code: "LIVE_RUN_RETENTION_VISIBLE_CAP_INVALID",
  });
});

test("a zero panel window still shows the active run and everything that did work", () => {
  const result = plan(
    [
      session("meta-active-shell", { updatedAt: daysBefore(2), active: true }),
      session("meta-real", { substanceClass: "substantive", updatedAt: daysBefore(2) }),
      session("meta-shell", { updatedAt: daysBefore(0.01) }),
    ],
    { activationOnlyVisibleDays: 0, activationOnlyVisibleMaxEntries: 0 },
  );

  assert.deepEqual(result.visible.map((entry) => entry.runId), [
    "meta-active-shell",
    "meta-real",
  ]);
  assert.deepEqual(result.omitted.map((entry) => entry.reason), ["outside_visible_window"]);
});

test("a document with no panel fields reads the retention window as the panel window", () => {
  const shipped = policy();

  assert.equal(shipped.activationOnlyVisibleDays, 3);
  assert.equal(shipped.activationOnlyVisibleMaxEntries, 40);
  assert.equal(shipped.activationOnlyVisibleDays, shipped.activationOnlyRetentionDays);
  assert.equal(shipped.activationOnlyVisibleMaxEntries, shipped.activationOnlyMaxEntries);
});

test("a row past the retention window is reported as prunable, not merely hidden", () => {
  const result = plan([session("meta-old-shell", { updatedAt: daysBefore(30) })], {
    activationOnlyVisibleDays: 1,
  });

  assert.deepEqual(result.omitted.map((entry) => entry.reason), ["outside_retention_window"]);
});
