import assert from "node:assert/strict";
import test from "node:test";
import { deriveDesignRevisionImpact } from "../../scripts/governed-execution/product-design.mjs";

const revisionContext = { previousRunId: "original-run", previousDesignDigest: "a".repeat(64), reason: "Investigate a different architecture after current evidence", changeEvidenceRefs: ["source:architecture-review"], directlyAffectedTaskIds: [], reuseCandidates: [] };
test("exploration can retain evidenced prior design before replacement task decomposition", () => {
  const impact = deriveDesignRevisionImpact({ mode: "exploration", taskSlices: [], revisionContext });
  assert.equal(impact.previousRunId, revisionContext.previousRunId);
  assert.equal(impact.previousDesignDigest, revisionContext.previousDesignDigest);
  assert.equal(impact.status, "new_run_required");
  assert.equal(impact.taskImpactStatus, "deferred_until_task_decomposition");
  assert.deepEqual(impact.affectedTaskIds, []);
  assert.match(impact.claimBoundary, /prior|previous/i);
});
test("empty delivery or unaudited exploration does not bypass impact analysis", () => {
  assert.throws(() => deriveDesignRevisionImpact({ mode: "delivery", taskSlices: [], revisionContext }), /affected|concrete/);
  assert.throws(() => deriveDesignRevisionImpact({ mode: "exploration", taskSlices: [], revisionContext: { ...revisionContext, changeEvidenceRefs: [] } }), /evidence/);
  assert.throws(() => deriveDesignRevisionImpact({ mode: "exploration", taskSlices: [], revisionContext: { ...revisionContext, directlyAffectedTaskIds: ["invented-task"] } }), /unknown/);
});
