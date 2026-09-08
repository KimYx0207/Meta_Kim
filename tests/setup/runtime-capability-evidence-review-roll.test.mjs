import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REPO_PROJECTION_LEDGER_PATH,
  rollReviewFreshness,
} from "../../scripts/record-runtime-capability-evidence.mjs";
import { validateRuntimeCapabilityClaims } from "../../scripts/runtime-capability-evidence.mjs";

/**
 * The 3.0.9 freshness gates expire review bindings that live across TWO real
 * config files: config/runtime-capability-matrix.json (matrix.lastReviewedAt
 * plus one reviewState per capability row — the large majority of bindings)
 * and config/runtime-capability-evidence.json (the conservative_review
 * observations). Rolling only the ledger leaves the other half of the
 * staleness issues red, so the roller consumes and returns both files, and the
 * acceptance criterion is: under a clock pushed past the window, staleness
 * issues reach ZERO — not merely that some fields changed.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MATRIX_PATH = "config/runtime-capability-matrix.json";

function committedPair() {
  return {
    matrix: JSON.parse(readFileSync(path.join(REPO_ROOT, MATRIX_PATH), "utf8")),
    ledger: JSON.parse(readFileSync(path.join(REPO_ROOT, REPO_PROJECTION_LEDGER_PATH), "utf8")),
  };
}

function agedPair() {
  const pair = committedPair();
  pair.matrix = JSON.parse(JSON.stringify(pair.matrix));
  pair.ledger = JSON.parse(JSON.stringify(pair.ledger));
  pair.matrix.lastReviewedAt = "2026-01-01";
  for (const platform of pair.matrix.platforms ?? []) {
    for (const row of platform.capabilities ?? []) {
      if (row.reviewState) row.reviewState.lastReviewedAt = "2026-01-01";
    }
  }
  for (const observation of pair.ledger.observations ?? []) {
    if (observation.observationClass === "conservative_review") {
      observation.observedAt = "2026-01-01";
    }
  }
  return pair;
}

function stalenessIssues(matrix, ledger, now) {
  return validateRuntimeCapabilityClaims(matrix, ledger, { now }).filter(
    (issue) =>
      issue.includes("must be current, non-future, and fresh") ||
      issue.includes("must bind fresh conservative_review evidence") ||
      issue.includes("reviewState must be fresh, non-future, and explicit"),
  );
}

test("rolling both real files drives staleness issues to zero under a pushed clock", () => {
  const pair = agedPair();
  const now = "2026-10-15T00:00:00Z";
  const before = stalenessIssues(pair.matrix, pair.ledger, now);
  assert.ok(before.length > 0, "aged fixture must start stale under the pushed clock");

  const rolled = rollReviewFreshness(pair, {
    date: "2026-10-05",
    rationale: "re-verified matrix and ledger projection sources end to end",
    now,
  });
  assert.deepEqual(
    stalenessIssues(rolled.matrix, rolled.ledger, now),
    [],
    "staleness must reach zero in BOTH files after the roll",
  );
  assert.ok(rolled.updates.length >= 120, `matrix rows must be rolled (got ${rolled.updates.length} updates)`);
});

test("roll preserves per-row rationales and fills only blank ones", () => {
  const pair = agedPair();
  const row = pair.matrix.platforms[0].capabilities.find((entry) => entry.reviewState);
  const original = row.reviewState.rationale;
  assert.ok(original, "fixture row must carry a per-row rationale");

  const rolled = rollReviewFreshness(pair, {
    date: "2026-09-08",
    rationale: "blanket rationale must not overwrite per-row evidence",
  });
  const rolledRow = rolled.matrix.platforms[0].capabilities.find(
    (entry) => entry.reviewState,
  );
  assert.equal(
    rolledRow.reviewState.rationale,
    original,
    "existing per-row rationale must be preserved verbatim",
  );
});

test("roll refuses future dates, non-calendar dates, and weak rationales without mutating input", () => {
  for (const bad of [
    { date: "2999-01-01", rationale: "re-verified everything end to end" },
    { date: "2026-02-31", rationale: "re-verified everything end to end" },
    { date: "2026-09-08", rationale: "short" },
    { date: "2026-09-08", rationale: undefined },
  ]) {
    const pair = agedPair();
    const before = JSON.stringify(pair);
    assert.throws(() => rollReviewFreshness(pair, bad), Error, `must refuse ${JSON.stringify(bad)}`);
    assert.equal(JSON.stringify(pair), before, "refusal must not mutate the input");
  }
});

test("rolling the committed pair to today leaves freshness issues at zero under the real clock", () => {
  const pair = committedPair();
  const today = new Date().toISOString().slice(0, 10);
  const rolled = rollReviewFreshness(pair, {
    date: today,
    rationale: "committed-pair roll smoke: projection sources re-verified today",
  });
  assert.deepEqual(stalenessIssues(rolled.matrix, rolled.ledger), []);
});
