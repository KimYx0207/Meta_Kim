import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REPO_PROJECTION_LEDGER_PATH,
  RUNTIME_CAPABILITY_MATRIX_PATH,
  rollReviewFiles,
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
const MATRIX_PATH = RUNTIME_CAPABILITY_MATRIX_PATH;
const RECORDER = path.join(REPO_ROOT, "scripts/record-runtime-capability-evidence.mjs");

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

function reviewRows(matrix) {
  const rows = [];
  for (const platform of matrix.platforms ?? []) {
    for (const row of platform.capabilities ?? []) {
      if (row.reviewState) rows.push(row);
    }
  }
  return rows;
}

/**
 * Write an aged pair into a throwaway directory so the file-level roll can be
 * exercised for real — reading, re-validating, and writing — without touching
 * the committed config files.
 */
function sandbox(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-review-roll-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pair = agedPair();
  const matrixPath = path.join(dir, "runtime-capability-matrix.json");
  const ledgerPath = path.join(dir, "runtime-capability-evidence.json");
  writeFileSync(matrixPath, `${JSON.stringify(pair.matrix, null, 2)}\n`);
  writeFileSync(ledgerPath, `${JSON.stringify(pair.ledger, null, 2)}\n`);
  return { matrixPath, ledgerPath };
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

test("roll preserves every per-row rationale and fills only blank ones", () => {
  const pair = agedPair();
  const rows = reviewRows(pair.matrix);
  assert.ok(rows.length >= 120, `fixture must carry the real row population (got ${rows.length})`);
  const originals = rows.map((row) => row.reviewState.rationale);
  assert.ok(originals.every(Boolean), "every fixture row must start with its own rationale");

  // One deliberately blank row proves the fill branch is reachable at all. Without
  // it, "fills only blank ones" would be an unexercised half of the contract.
  const blankIndex = rows.length - 1;
  rows[blankIndex].reviewState.rationale = "   ";

  const blanket = "blanket rationale must not overwrite per-row evidence";
  const rolled = rollReviewFreshness(pair, { date: "2026-09-08", rationale: blanket });
  const rolledRows = reviewRows(rolled.matrix);
  assert.equal(rolledRows.length, rows.length, "the roll must not add or drop review rows");
  for (const [index, row] of rolledRows.entries()) {
    if (index === blankIndex) {
      assert.equal(row.reviewState.rationale, blanket, "a blank rationale must be filled");
      continue;
    }
    assert.equal(
      row.reviewState.rationale,
      originals[index],
      `row ${index} rationale must be preserved verbatim`,
    );
  }
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

test("the file-level roll re-validates and writes both files", (t) => {
  const { matrixPath, ledgerPath } = sandbox(t);
  const now = "2026-10-15T00:00:00Z";
  const result = rollReviewFiles({
    matrixPath,
    ledgerPath,
    date: "2026-10-05",
    rationale: "re-verified matrix and ledger projection sources end to end",
    now,
  });

  assert.deepEqual(result.freshnessIssues, [], "no freshness issue may survive the roll");
  assert.equal(result.code, 0, `roll must succeed, got issues: ${result.issues.join(" | ")}`);
  assert.deepEqual(
    [...result.wrote].sort(),
    [ledgerPath, matrixPath].sort(),
    "both files must be written, not just the ledger",
  );
  assert.deepEqual(
    stalenessIssues(
      JSON.parse(readFileSync(matrixPath, "utf8")),
      JSON.parse(readFileSync(ledgerPath, "utf8")),
      now,
    ),
    [],
    "the files landed on disk must themselves be fresh",
  );
});

test("the file-level roll refuses to write when a problem it cannot fix survives", (t) => {
  const { matrixPath, ledgerPath } = sandbox(t);
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  reviewRows(matrix)[0].reviewState.status = "not-a-review-state";
  writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);

  const matrixBefore = readFileSync(matrixPath, "utf8");
  const ledgerBefore = readFileSync(ledgerPath, "utf8");
  const result = rollReviewFiles({
    matrixPath,
    ledgerPath,
    date: "2026-10-05",
    rationale: "re-verified matrix and ledger projection sources end to end",
    now: "2026-10-15T00:00:00Z",
  });

  assert.equal(result.code, 1, "an unfixable reviewState must fail the roll");
  assert.ok(
    result.freshnessIssues.some((issue) =>
      issue.includes("reviewState must be fresh, non-future, and explicit"),
    ),
    `the surviving issue must be reported as a freshness issue: ${result.issues.join(" | ")}`,
  );
  assert.deepEqual(result.wrote, [], "a failed roll must write nothing");
  assert.equal(readFileSync(matrixPath, "utf8"), matrixBefore, "matrix on disk must be untouched");
  assert.equal(readFileSync(ledgerPath, "utf8"), ledgerBefore, "ledger on disk must be untouched");
});

test("the CLI refuses a future --date and leaves the committed files untouched", () => {
  const matrixBefore = readFileSync(path.join(REPO_ROOT, MATRIX_PATH), "utf8");
  const ledgerBefore = readFileSync(path.join(REPO_ROOT, REPO_PROJECTION_LEDGER_PATH), "utf8");

  const run = spawnSync(
    process.execPath,
    [RECORDER, "--roll-review", "--date", "2999-01-01", "--rationale", "re-verified end to end"],
    { encoding: "utf8" },
  );

  assert.equal(run.status, 1, `CLI must exit 1, stderr: ${run.stderr}`);
  assert.match(run.stderr, /future/u);
  assert.equal(readFileSync(path.join(REPO_ROOT, MATRIX_PATH), "utf8"), matrixBefore);
  assert.equal(
    readFileSync(path.join(REPO_ROOT, REPO_PROJECTION_LEDGER_PATH), "utf8"),
    ledgerBefore,
  );
});
