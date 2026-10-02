import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkRuntimeEvidenceReview } from "../../scripts/check-runtime-evidence-review.mjs";
import {
  RuntimeCapabilityEvidenceError,
  assertRuntimeCapabilityClaims,
  runtimeCapabilityFailureDetails,
} from "../../scripts/runtime-capability-evidence.mjs";

function fixture() {
  return {
    matrix: JSON.parse(readFileSync(new URL("../../config/runtime-capability-matrix.json", import.meta.url))),
    ledger: JSON.parse(readFileSync(new URL("../../config/runtime-capability-evidence.json", import.meta.url))),
  };
}

function afterDays(matrix, days) {
  return new Date(Date.parse(matrix.lastReviewedAt) + days * 86_400_000).toISOString();
}

test("review monitor warns before expiry, matches the gate boundary, and never writes or promotes claims", () => {
  const { matrix, ledger } = fixture();
  const before = JSON.stringify({ matrix, ledger });
  for (const [days, expected] of [[22, "current"], [23, "due_soon"], [30, "due_soon"], [31, "invalid"]]) {
    assert.equal(checkRuntimeEvidenceReview(matrix, ledger, { now: afterDays(matrix, days) }).status, expected);
  }
  assert.equal(JSON.stringify({ matrix, ledger }), before);
  assert.throws(() => assertRuntimeCapabilityClaims(matrix, ledger, { now: afterDays(matrix, 31) }), RuntimeCapabilityEvidenceError);
});

test("review monitor considers row and conservative-evidence ages, not just the matrix date", () => {
  const { matrix, ledger } = fixture();
  const now = afterDays(matrix, 20);
  matrix.platforms[0].capabilities[0].reviewState.lastReviewedAt = afterDays(matrix, -5).slice(0, 10);
  assert.equal(checkRuntimeEvidenceReview(matrix, ledger, { now }).status, "due_soon");
  ledger.observations.find((entry) => entry.observationClass === "conservative_review").observedAt = afterDays(matrix, -12).slice(0, 10);
  assert.equal(checkRuntimeEvidenceReview(matrix, ledger, { now }).status, "invalid");
});

test("review monitor rejects invalid clocks and does not hide non-freshness validation errors", () => {
  const { matrix, ledger } = fixture();
  assert.throws(() => checkRuntimeEvidenceReview(matrix, ledger, { now: "bad" }), /timestamp/);
  assert.throws(() => checkRuntimeEvidenceReview(matrix, ledger, { warningDays: -1 }), /warningDays/);
  assert.throws(() => checkRuntimeEvidenceReview(matrix, ledger, { warningDays: 31 }), /warningDays/);
  ledger.observations[0].sourceRefs = ["https://example.com/untrusted"];
  assert.equal(checkRuntimeEvidenceReview(matrix, ledger, { now: afterDays(matrix, 0) }).status, "invalid");
});

test("public diagnostics explain review expiry without leaking raw errors or implying authorization", () => {
  const secret = "/private/user/example-token";
  const error = new RuntimeCapabilityEvidenceError([`${secret} reviewState must be fresh, non-future, and explicit`]);
  const result = runtimeCapabilityFailureDetails(error);
  assert.equal(result.reasonCode, "runtime_review_required");
  assert.match(result.issues.join(" "), /execution remains blocked/);
  assert.match(result.nextAction, /Do not bypass/);
  assert.ok(!JSON.stringify(result).includes(secret));
  const unknown = runtimeCapabilityFailureDetails(new Error(`${secret}: ENOENT`));
  assert.equal(unknown.reasonCode, "runtime_evidence_unavailable");
  assert.ok(!JSON.stringify(unknown).includes(secret));
});
