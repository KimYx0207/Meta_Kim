import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  LIVE_HUB_LIFECYCLE_CONFIG_URL,
  LIVE_HUB_LIFECYCLE_SCHEMA_VERSION,
  loadLiveHubLifecycleBudget,
  normalizeLiveHubLifecycleBudget,
} from "../../src/application/live/live-hub-lifecycle-budget.mjs";

const shipped = loadLiveHubLifecycleBudget();

/**
 * Fresh-start measurements taken on this project (256 governed run artifacts),
 * three consecutive spawns with the wait budget raised to 60000ms so the child
 * could not be killed before it published state.
 */
const OBSERVED_FRESH_START_MS = [2175, 2368, 4175];

/**
 * The series that first moved this fuse out of code. Those samples timed the
 * launcher rather than the child: every 75ms poll then ran a Windows process
 * creation-time query costing 1867-5020ms, so a hub that was ready at two
 * seconds went unnoticed for several more. They record why a hardcoded fuse
 * cannot stay true, and must not be read as a bound on the child's ready time.
 */
const OBSERVED_LAUNCHER_INFLATED_MS = [5889, 6617, 6941, 7346, 8540, 15574];
const SUPERSEDED_BUDGET_MS = 5_000;

/** A fuse clears a measured range only by exceeding it, never by matching it. */
function fuseClears(fuseMs, observedMs) {
  return fuseMs > Math.max(...observedMs);
}

/** Shipped call sites that must take their fuse from the data layer. */
const CALL_SITES = [
  "scripts/meta-kim-live.mjs",
  "canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs",
];
const HARDCODED_FUSE = /timeoutMs:\s*(?:\d|process\.platform)/u;

function validDocument(overrides = {}) {
  return {
    schemaVersion: LIVE_HUB_LIFECYCLE_SCHEMA_VERSION,
    startupBudgetMs: 45_000,
    hookAutostartBudgetMs: 12_000,
    stopBudgetMs: 10_000,
    ...overrides,
  };
}

function readRepoFile(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

test("schema version is declared for cross-layer contract checks", () => {
  assert.equal(LIVE_HUB_LIFECYCLE_SCHEMA_VERSION, "meta-kim-live-hub-lifecycle-v1");
});

test("the shipped hub-lifecycle document is the validated source of truth", () => {
  const raw = JSON.parse(readFileSync(LIVE_HUB_LIFECYCLE_CONFIG_URL, "utf8"));
  assert.deepEqual(shipped, normalizeLiveHubLifecycleBudget(raw), "the loader must not transform the document");
  assert.equal(shipped.schemaVersion, LIVE_HUB_LIFECYCLE_SCHEMA_VERSION);
  assert.ok(
    typeof raw.description === "string" && raw.description.length > 0,
    "the measured justification for these numbers must travel with them",
  );
  assert.equal(Object.isFrozen(shipped), true, "a shared budget must not be mutable by one caller");
});

test("a malformed document is rejected instead of silently defaulted", () => {
  const rejections = [
    [null, "LIVE_HUB_LIFECYCLE_INVALID"],
    ["45000", "LIVE_HUB_LIFECYCLE_INVALID"],
    [{}, "LIVE_HUB_LIFECYCLE_SCHEMA_MISMATCH"],
    [validDocument({ schemaVersion: "meta-kim-live-hub-lifecycle-v0" }), "LIVE_HUB_LIFECYCLE_SCHEMA_MISMATCH"],
    [validDocument({ startupBudgetMs: 0 }), "LIVE_HUB_LIFECYCLE_INVALID"],
    [validDocument({ startupBudgetMs: -1 }), "LIVE_HUB_LIFECYCLE_INVALID"],
    [validDocument({ startupBudgetMs: 4_500.5 }), "LIVE_HUB_LIFECYCLE_INVALID"],
    [validDocument({ startupBudgetMs: "45000" }), "LIVE_HUB_LIFECYCLE_INVALID"],
    [validDocument({ startupBudgetMs: 600_001 }), "LIVE_HUB_LIFECYCLE_INVALID"],
    [validDocument({ hookAutostartBudgetMs: undefined }), "LIVE_HUB_LIFECYCLE_INVALID"],
    [validDocument({ stopBudgetMs: null }), "LIVE_HUB_LIFECYCLE_INVALID"],
    [validDocument({ startupBudgetMs: 8_000, stopBudgetMs: 10_000 }), "LIVE_HUB_LIFECYCLE_BUDGETS_INVERTED"],
    [validDocument({ startupBudgetMs: 9_000, hookAutostartBudgetMs: 12_000, stopBudgetMs: 1_000 }), "LIVE_HUB_LIFECYCLE_BUDGETS_INVERTED"],
  ];
  for (const [document, code] of rejections) {
    assert.throws(
      () => normalizeLiveHubLifecycleBudget(document),
      (error) => error.code === code,
      `expected ${code} for ${JSON.stringify(document)}`,
    );
  }
  assert.doesNotThrow(() => normalizeLiveHubLifecycleBudget(validDocument()), "positive control: the valid document must pass");
});

test("unknown keys are dropped rather than carried into the resolved budget", () => {
  const resolved = normalizeLiveHubLifecycleBudget(validDocument({ description: "notes", budgetNotes: { a: "b" } }));
  assert.deepEqual(Object.keys(resolved).sort(), [
    "hookAutostartBudgetMs",
    "schemaVersion",
    "startupBudgetMs",
    "stopBudgetMs",
  ]);
});

test("an unreadable document reports the path instead of failing anonymously", () => {
  assert.throws(
    () => loadLiveHubLifecycleBudget(new URL("./missing-hub-lifecycle.json", import.meta.url)),
    (error) => error.code === "LIVE_HUB_LIFECYCLE_UNREADABLE" && /missing-hub-lifecycle\.json/u.test(error.message),
  );
});

test("the shipped budgets cover the measured fresh-start range", () => {
  const observedMax = Math.max(...OBSERVED_FRESH_START_MS);
  assert.equal(
    fuseClears(observedMax, OBSERVED_FRESH_START_MS),
    false,
    "negative control: a fuse set exactly to the slowest measured start must not count as clearing it",
  );
  assert.equal(
    fuseClears(shipped.hookAutostartBudgetMs, OBSERVED_FRESH_START_MS),
    true,
    `the shortest fuse (${shipped.hookAutostartBudgetMs}ms) must still clear the slowest measured start (${observedMax}ms)`,
  );
  assert.ok(
    Math.max(...OBSERVED_LAUNCHER_INFLATED_MS) > SUPERSEDED_BUDGET_MS,
    `the superseded ${SUPERSEDED_BUDGET_MS}ms constant must stay below the readings that broke it, otherwise this whole change had no cause`,
  );
  assert.ok(
    Math.max(...OBSERVED_LAUNCHER_INFLATED_MS) > observedMax,
    "the launcher-inflated series must stay recorded as the larger, superseded reading",
  );
  assert.ok(
    shipped.startupBudgetMs >= shipped.hookAutostartBudgetMs,
    "an explicit request must never be given less patience than an opportunistic one",
  );
  assert.ok(
    shipped.stopBudgetMs <= shipped.startupBudgetMs,
    "a restart must not spend longer stopping the old hub than starting the new one",
  );
});

test("no shipped call site hardcodes its own hub fuse", () => {
  for (const relativePath of CALL_SITES) {
    const source = readRepoFile(relativePath);
    assert.match(
      source,
      /loadLiveHubLifecycleBudget/u,
      `${relativePath} must take its fuse from the data layer`,
    );
    assert.doesNotMatch(
      source,
      HARDCODED_FUSE,
      `${relativePath} still carries a literal fuse; the measured start time grows with the run count, so no constant here can stay true`,
    );
  }

  const planted = "    const result = await ensureLiveHub({ timeoutMs: 5_000 });";
  assert.match(planted, HARDCODED_FUSE, "harness sanity: the detector must catch a planted literal fuse");
  assert.match(
    '      timeoutMs: process.platform === "win32" ? 8_000 : 2_000,',
    HARDCODED_FUSE,
    "harness sanity: the detector must catch the superseded platform ternary",
  );
  assert.doesNotMatch(
    "      timeoutMs: budget.startupBudgetMs,",
    HARDCODED_FUSE,
    "harness sanity: a data-layer fuse must not be reported as hardcoded",
  );
});

test("every runtime hook projection follows the canonical source", () => {
  // Projections are runtime-local and gitignored, so an absent one is a machine
  // that has not synced rather than a defect. A present one that disagrees with
  // canonical means the runtime is still running the superseded fuse.
  const projections = [".claude", ".codex", ".cursor"];
  let checked = 0;
  for (const runtime of projections) {
    const projection = new URL(`../../${runtime}/hooks/activate-meta-theory-spine.mjs`, import.meta.url);
    if (!existsSync(projection)) continue;
    checked += 1;
    const source = readFileSync(projection, "utf8");
    assert.match(
      source,
      /loadLiveHubLifecycleBudget/u,
      `${runtime} hook is stale; run npm run meta:sync so the runtime uses the measured budget`,
    );
    assert.doesNotMatch(source, HARDCODED_FUSE, `${runtime} hook still carries the superseded literal fuse`);
  }
  assert.ok(checked >= 0, `checked ${checked} runtime projections`);
});
