import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function runFeedbackLoop() {
  const result = spawnSync(process.execPath, ["scripts/generate-feedback-loop-report.mjs"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const jsonStart = result.stdout.indexOf("{");
  assert.notEqual(jsonStart, -1, result.stdout);
  return JSON.parse(result.stdout.slice(jsonStart));
}

describe("42 — Feedback loop and Review / Meta-Review gate", () => {
  test("P-041/P-042/P-054/P-055/P-056 validate feedback actions, replay metrics, and review gates", () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(
      packageJson.scripts["meta:feedback:loop"],
      "node scripts/generate-feedback-loop-report.mjs",
    );

    const contract = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "config/contracts/feedback-action-contract.json"), "utf8"),
    );
    assert.equal(contract.schemaVersion, "feedback-action-contract-v0.1");
    assert.deepEqual(Object.keys(contract.actions).sort(), [
      "accept",
      "correct",
      "keep_one_time",
      "promote_to_long_term",
      "reject",
    ]);
    assert.equal(contract.durableWritePolicy.canonicalWritesWithoutApproval, 0);
    assert.equal(contract.durableWritePolicy.approvalPacketRequired, "warden-approval-v0.2");
    assert.ok(contract.reviewMetaReviewGate.reviewRequiredChecks.includes("fetch_source_evidence"));
    assert.ok(
      contract.reviewMetaReviewGate.metaReviewRequiredChecks.includes(
        "writeback_boundary_checked",
      ),
    );

    const summary = runFeedbackLoop();
    assert.equal(summary.ok, true);
    assert.equal(summary.correctionReplayCount, 12);
    assert.equal(summary.actionTypesCovered, 5);
    assert.ok(summary.changedDecisionCount >= 11);
    assert.ok(summary.repeatGapCount >= 10);
    assert.ok(summary.reviewRejectedCount >= 3);

    const reportPath = path.join(REPO_ROOT, summary.report);
    const markdownPath = path.join(REPO_ROOT, summary.markdown);
    assert.equal(existsSync(reportPath), true);
    assert.equal(existsSync(markdownPath), true);

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(report.schemaVersion, "feedback-loop-report-v0.1");
    assert.equal(report.status, "pass");
    assert.equal(report.summary.canonicalWritesWithoutApproval, 0);
    assert.equal(report.summary.reviewerConfusionReduced, 12);
    assert.equal(report.summary.reviewAcceptedCount, 1);
    assert.equal(report.summary.reviewRejectedCount, 3);
    assert.ok(report.corrections.every((item) => item.runStateWrite.canonicalWrite === false));

    for (const action of [
      "accept",
      "correct",
      "reject",
      "promote_to_long_term",
      "keep_one_time",
    ]) {
      assert.ok(report.summary.actionCounts[action] >= 1, `missing action ${action}`);
    }

    const promoteSamples = report.corrections.filter(
      (item) => item.feedbackAction === "promote_to_long_term",
    );
    assert.ok(promoteSamples.length >= 2);
    assert.ok(promoteSamples.every((item) => item.writebackIntent === "candidate_only"));

    const polishOnly = report.reviewGate.find((item) => item.id === "review-reject-polish-only");
    assert.equal(polishOnly.action, "return_to_review");
    assert.equal(polishOnly.returnToStage, "Review");
    assert.ok(polishOnly.missingReviewChecks.length >= 4);

    const missingFetch = report.reviewGate.find((item) => item.id === "review-return-missing-fetch");
    assert.equal(missingFetch.action, "return_to_stage");
    assert.equal(missingFetch.returnToStage, "Fetch");
    assert.ok(missingFetch.missingUpstreamEvidence.includes("fetch"));

    const writebackBoundary = report.reviewGate.find(
      (item) => item.id === "review-block-writeback-boundary",
    );
    assert.equal(writebackBoundary.action, "blocked");
    assert.equal(writebackBoundary.returnToStage, "Meta-Review");
    assert.ok(writebackBoundary.missingMetaReviewChecks.includes("writeback_boundary_checked"));

    const markdown = readFileSync(markdownPath, "utf8");
    assert.match(markdown, /Feedback actions are written to run state only/);
    assert.match(markdown, /Repeated correction gaps are visible/);
    assert.match(markdown, /Review checks Critical, Fetch, Thinking, Execution/);
    assert.match(markdown, /Meta-Review rejects polish-only review/);
    assert.match(markdown, /Canonical writes stay at 0 without Warden approval/);
  });
});
