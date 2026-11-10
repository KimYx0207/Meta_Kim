import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getReportLabels } from "../../scripts/meta-kim-i18n.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const jsonStart = result.stdout.indexOf("{");
  assert.notEqual(jsonStart, -1, result.stdout);
  return JSON.parse(result.stdout.slice(jsonStart));
}

function readReport(summary) {
  const reportPath = path.join(REPO_ROOT, summary.report);
  const markdownPath = path.join(REPO_ROOT, summary.markdown);
  assert.equal(existsSync(reportPath), true);
  assert.equal(existsSync(markdownPath), true);
  return {
    report: JSON.parse(readFileSync(reportPath, "utf8")),
    markdown: readFileSync(markdownPath, "utf8"),
  };
}

function hasLocalAbsolutePath(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[A-Za-z]:[\\/]/.test(text) || /\/(?:Users|home|var|tmp|mnt)\//.test(text);
}

describe("45 — Remaining product backlog reports", () => {
  test("P-029 generates a cross-run trend panel with filters, endpoints, and reviewer score trend", () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(
      packageJson.scripts["meta:trend:panel"],
      "node scripts/generate-run-trend-panel-report.mjs",
    );
    runNodeScript("scripts/run-product-reviewer-replay.mjs");
    runNodeScript("scripts/generate-feedback-loop-report.mjs");
    runNodeScript("scripts/generate-runtime-live-shard-matrix.mjs");
    runNodeScript("scripts/generate-github-gap-report.mjs");

    const summary = runNodeScript("scripts/generate-run-trend-panel-report.mjs");
    assert.equal(summary.ok, true);
    assert.equal(summary.filterCount, 5);
    assert.equal(summary.panelCount, 4);
    assert.equal(summary.reviewerScoreRows, 5);
    assert.equal(summary.privacyStatus, "pass");

    const { report, markdown } = readReport(summary);
    assert.equal(report.schemaVersion, "run-trend-panel-v0.1");
    assert.equal(report.status, "pass");
    assert.deepEqual(
      report.filters.map((filter) => filter.id),
      ["runId", "timeRange", "decision", "owner", "reviewerDimension"],
    );
    assert.ok(report.endpoints.length >= 5);
    assert.ok(report.trends.blockedReasonTrend.length >= 1);
    assert.equal(typeof report.trends.githubDelta?.cannotClaimGithubComplete, "boolean");
    assert.equal(report.trends.githubDelta?.cannotClaimAllToolCompatibility, true);
    assert.equal(report.trends.githubDelta?.cursorIsPrimaryReleaseBlocker, false);
    if (report.trends.githubDelta?.compatibilityFollowUpTaskIds.length > 0) {
      assert.ok(report.trends.githubDelta.compatibilityFollowUpTaskIds.includes("P-024"));
    }
    assert.equal(hasLocalAbsolutePath(report), false);
    assert.match(markdown, /Run Trend Panel/);
  });

  test("P-043/P-057 generate a Warden approval panel, diff preview, and rollback rehearsal without current canonical writes", () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(
      packageJson.scripts["meta:warden:approval-panel"],
      "node scripts/generate-warden-approval-experience-report.mjs",
    );
    const summary = runNodeScript("scripts/generate-warden-approval-experience-report.mjs");
    assert.equal(summary.ok, true);
    assert.ok(summary.candidateCount >= 1);
    assert.ok(summary.tempCanonicalWrites >= 1);
    assert.equal(summary.currentRepoCanonicalWrites, 0);
    assert.equal(summary.rollbackVerified, true);

    const { report, markdown } = readReport(summary);
    assert.equal(report.schemaVersion, "warden-approval-experience-v0.1");
    assert.equal(report.evidenceKind, "isolated_writeback_mechanism_rehearsal");
    assert.equal(report.nativeExecutionVerified, false);
    assert.equal(report.methodImprovementVerified, false);
    assert.equal(report.status, "pass");
    assert.equal(report.approvalPanel.schemaVersion, "warden-approval-panel-v0.1");
    assert.equal(report.approvalPanel.approvalRequired, true);
    assert.equal(report.approvalPanel.currentRepoWriteAllowed, false);
    assert.equal(report.rollbackRehearsal.schemaVersion, "warden-rollback-rehearsal-v0.1");
    assert.equal(report.rollbackRehearsal.currentRepoCanonicalTouched, false);
    assert.equal(report.rollbackRehearsal.rollbackVerified, true);
    assert.equal(hasLocalAbsolutePath(report), false);
    assert.match(markdown, /Warden Approval Experience/);
  });

  test("P-044/P-058 generate runtime install/probe playbook and variant matrix while keeping Cursor compatibility pending", () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(
      packageJson.scripts["meta:runtime:probe-playbook"],
      "node scripts/generate-runtime-probe-playbook.mjs",
    );
    const summary = runNodeScript("scripts/generate-runtime-probe-playbook.mjs");
    assert.equal(summary.ok, true);
    assert.ok(summary.variantCount >= 12);
    assert.deepEqual(summary.missingEnvironments, []);
    assert.equal(summary.cursorNativeStillBlocked, true);

    const { report, markdown } = readReport(summary);
    assert.equal(report.schemaVersion, "runtime-probe-playbook-v0.1");
    assert.equal(report.status, "pass");
    for (const environment of [
      "windows_native",
      "wsl",
      "ide_subcommand",
      "path_missing",
      "auth_missing",
      "output_format_missing",
    ]) {
      assert.ok(report.variants.some((variant) => variant.environment === environment), environment);
    }
    assert.ok(
      report.variants.some(
        (variant) =>
          variant.runtime === "cursor" &&
          variant.expectedFailureClass === "native_harness_missing" &&
          variant.releaseGradeCandidate === false,
      ),
    );
    const labels = getReportLabels("zh-CN");
    assert.match(
      markdown,
      new RegExp(labels.runtimeProbePlaybookTitle(labels.toolList(labels.toolNames))),
    );
  });

  test("P-032 generates OpenClaw batch stability report with shard fallback and timeout class", () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(
      packageJson.scripts["meta:openclaw:batch-stability"],
      "node scripts/generate-openclaw-batch-stability-report.mjs",
    );
    const summary = runNodeScript("scripts/generate-openclaw-batch-stability-report.mjs");
    assert.equal(summary.generationOk, true);
    assert.equal(summary.evidenceStatus, "not_run");
    assert.equal(summary.runtimeEvidencePassed, false);
    assert.equal(Object.hasOwn(summary, "ok"), false);
    assert.equal(summary.shardCount, 9);
    assert.equal(summary.batchReleaseGrade, false);
    assert.equal(summary.timeoutClassVisible, true);

    const { report, markdown } = readReport(summary);
    assert.equal(report.schemaVersion, "openclaw-batch-stability-v0.2");
    assert.equal(report.generationStatus, "pass");
    assert.equal(report.evidenceStatus, "not_run");
    assert.equal(report.summary.passShardCount, 0);
    assert.equal(report.summary.notRunShardCount, 9);
    assert.equal(report.batchProbe.expectedFailureClass, "timeout");
    assert.equal(report.batchProbe.releaseGradeCandidate, false);
    assert.equal(report.batchProbe.evidenceStatus, "not_run");
    assert.equal(report.batchProbe.observedFailureClass, null);
    assert.ok(report.shards.every((shard) => shard.evidenceStatus === "not_run"));
    assert.ok(report.shards.every((shard) => shard.retryPolicy.maxRetries >= 1));
    assert.match(markdown, /OpenClaw Batch Stability Report/);
  });
});
