import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { nextControlledPromotionLineage } from "../../scripts/runtime-capability-acceptance.mjs";

const packageRoot = path.resolve(import.meta.dirname, "../..");

test("two consecutive exact-10 promotions retain one unbroken lineage per runtime claim", () => {
  const safetySet = JSON.parse(readFileSync(path.join(packageRoot, "config", "contracts", "runtime-execution-safety-contract.json"), "utf8")).standardObservationSet;
  const bases = safetySet.map((binding, index) => ({ ...binding, attemptId: `raw-${index}`, releaseGrade: false }));
  const first = bases.map((base, index) => ({
    ...base,
    attemptId: `promotion-1-${index}`,
    releaseGrade: true,
    promotion: nextControlledPromotionLineage(base, bases, { releaseAuditAttemptId: "audit-1", verificationAttemptId: "verify-1" }),
  }));
  const second = bases.map((base, index) => ({
    ...base,
    attemptId: `promotion-2-${index}`,
    releaseGrade: true,
    promotion: nextControlledPromotionLineage(base, [...bases, ...first], { releaseAuditAttemptId: "audit-2", verificationAttemptId: "verify-2" }),
  }));
  assert.equal(first.length, 10);
  assert.equal(second.length, 10);
  assert.deepEqual(first.map((entry) => entry.promotion.generation), Array(10).fill(1));
  assert.deepEqual(second.map((entry) => entry.promotion.generation), Array(10).fill(2));
  for (let index = 0; index < 10; index += 1) {
    assert.equal(first[index].promotion.baseAttemptId, bases[index].attemptId);
    assert.equal(first[index].promotion.parentPromotionAttemptId, null);
    assert.equal(second[index].promotion.baseAttemptId, bases[index].attemptId);
    assert.equal(second[index].promotion.parentPromotionAttemptId, first[index].attemptId);
  }
});
