import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  REPO_PROJECTION_LEDGER_PATH,
  rollConservativeReviews,
} from "../../scripts/record-runtime-capability-evidence.mjs";
import { validateRuntimeEvidenceLedger } from "../../scripts/runtime-capability-evidence.mjs";

/**
 * The 3.0.9 freshness gates expire every conservative_review observation and
 * reviewState binding after staleAfterDays (default 30), so a maintainer must
 * re-review the projection sources and re-date the ledger on a cadence. Doing
 * that by hand means scattering one date across matrix.lastReviewedAt, each
 * capability row's reviewState, and every conservative_review observation;
 * this roller makes the re-review an explicit, rationale-bound action instead.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function committedLedger() {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, REPO_PROJECTION_LEDGER_PATH), "utf8"));
}

function sampleLedger() {
  return {
    matrix: {
      lastReviewedAt: "2026-07-01",
      platforms: [
        {
          platform: "claude_code",
          capabilities: [
            {
              capability: "agent",
              reviewState: {
                status: "conservative_review",
                lastReviewedAt: "2026-07-01",
                rationale: "pre-roll rationale",
                evidenceRefs: ["claude_code.review.conservative.2026-07-28"],
              },
            },
          ],
        },
      ],
    },
    observations: [
      {
        id: "claude_code.review.conservative.2026-07-28",
        observationClass: "conservative_review",
        observedAt: "2026-07-28",
      },
      {
        id: "claude_code.repo.projection.2026-07-28",
        observationClass: "repo_projection",
        observedAt: "2026-07-28",
        sourceRefs: [],
      },
    ],
  };
}

test("roll updates matrix, every nested reviewState, and only conservative_review observations", () => {
  const { ledger, updates } = rollConservativeReviews(sampleLedger(), {
    date: "2026-09-07",
    rationale: "re-verified all projection sources byte-aligned after the v3.0.9 absorption",
  });

  assert.equal(ledger.matrix.lastReviewedAt, "2026-09-07");
  const row = ledger.matrix.platforms[0].capabilities[0];
  assert.equal(row.reviewState.lastReviewedAt, "2026-09-07");
  assert.match(row.reviewState.rationale, /v3\.0\.9 absorption/);

  const review = ledger.observations.find((o) => o.observationClass === "conservative_review");
  assert.equal(review.observedAt, "2026-09-07");
  const projection = ledger.observations.find((o) => o.observationClass === "repo_projection");
  assert.equal(projection.observedAt, "2026-07-28", "non-review observations must stay untouched");

  assert.equal(updates.length, 3);
});

test("roll refuses a missing or too-short rationale", () => {
  const before = JSON.stringify(sampleLedger());
  for (const rationale of [undefined, "", "short"]) {
    assert.throws(
      () => rollConservativeReviews(sampleLedger(), { date: "2026-09-07", rationale }),
      /--rationale is required/u,
      `rationale=${JSON.stringify(rationale)} must be refused`,
    );
  }
  assert.equal(JSON.stringify(sampleLedger()), before, "refusal must not mutate the input");
});

test("roll refuses a future date and a non-calendar date", () => {
  assert.throws(
    () => rollConservativeReviews(sampleLedger(), { date: "2999-01-01", rationale: "re-verified everything" }),
    /future/u,
  );
  assert.throws(
    () => rollConservativeReviews(sampleLedger(), { date: "2026-02-31", rationale: "re-verified everything" }),
    /real calendar date/u,
  );
});

test("rolling the committed ledger with today's date leaves it ledger-valid", () => {
  const ledger = committedLedger();
  const today = new Date().toISOString().slice(0, 10);
  const { ledger: rolled } = rollConservativeReviews(ledger, {
    date: today,
    rationale: "committed-ledger roll smoke: projection sources re-verified",
  });
  const { issues } = validateRuntimeEvidenceLedger(rolled);
  const freshnessIssues = issues.filter((issue) => issue.includes("must bind fresh") || issue.includes("must be current, non-future"));
  assert.deepEqual(freshnessIssues, []);
});
