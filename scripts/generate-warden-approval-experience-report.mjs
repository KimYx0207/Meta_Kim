#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runMetaTheoryGovernedExecution } from "./run-meta-theory-governed-execution.mjs";
import { createReportContext } from "./report-context.mjs";

const reportContext = createReportContext();
const REPO_ROOT = reportContext.repoRoot;
const OUTPUT_DIR = reportContext.resolveStatePath("warden-approval-experience");

const relativeToRepo = reportContext.relativeToRepo;

function hasLocalAbsolutePath(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[A-Za-z]:[\\/]/.test(text) || /\/(?:Users|home|var|tmp|mnt)\//.test(text);
}

async function runPreviewAndRollback() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-approval-preview-"));
  try {
    const task = "A reusable AI-readable product review standard keeps recurring and should become a candidate-only skill unless Warden approval is supplied.";
    const previewRun = await runMetaTheoryGovernedExecution({
      task,
      runId: "warden-approval-preview",
      stateDir: path.join(tempDir, "preview-state"),
      dbPath: path.join(tempDir, "preview.sqlite"),
      canonicalRoot: path.join(tempDir, "preview-canonical"),
    });
    const candidate = previewRun.wardenWritebackFlow.candidates.find((item) => item.targetRelativeToCanonical);
    if (!candidate) {
      throw new Error("Preview run did not produce a candidate target.");
    }
    const approvalPacket = {
      schemaVersion: "warden-approval-v0.2",
      approvalId: "approval-preview-rehearsal",
      approver: "meta-warden",
      approvedAt: "2026-06-04T00:00:00.000Z",
      scope: "canonical_reverse_sync",
      mutationBindings: [candidate.mutationBinding],
      diffSummary: candidate.diffSummary,
      rollbackPlan: "Remove the temporary canonical root created for this rehearsal.",
      riskReview: {
        status: "fixture_only_rehearsal",
        boundary: "Run-scoped task details must not enter durable identity.",
      },
    };
    const tempCanonicalRoot = path.join(tempDir, "approved-canonical");
    const approvedRun = await runMetaTheoryGovernedExecution({
      task,
      runId: "warden-approval-temp-apply",
      stateDir: path.join(tempDir, "approved-state"),
      dbPath: path.join(tempDir, "approved.sqlite"),
      canonicalRoot: tempCanonicalRoot,
      approvalPacket,
      applyWriteback: true,
    });
    const tempWrites = approvedRun.wardenWritebackFlow.candidates.filter(
      (item) => item.applyStatus === "created" || item.applyStatus === "updated",
    );
    await fs.rm(tempCanonicalRoot, { recursive: true, force: true });
    const rollbackVerified = !(await fs.stat(tempCanonicalRoot).catch(() => null));
    return {
      previewRun,
      approvedRun,
      candidate,
      approvalPacket,
      tempWrites,
      rollbackVerified,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function buildMarkdown(report) {
  const lines = [
    "# Warden Approval Experience",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- approvalRequired: ${report.approvalPanel.approvalRequired}`,
    `- currentRepoCanonicalWrites: ${report.summary.currentRepoCanonicalWrites}`,
    `- tempCanonicalWrites: ${report.summary.tempCanonicalWrites}`,
    `- rollbackVerified: ${report.rollbackRehearsal.rollbackVerified}`,
    "",
    "## Candidate Preview",
    "",
    "| Candidate | Type | Decision | Target | Risk |",
    "|---|---|---|---|---|",
    ...report.candidateDiffs.map(
      (candidate) =>
        `| ${candidate.candidateId} | ${candidate.candidateType} | ${candidate.writebackDecision} | ${candidate.target} | ${candidate.riskReview.join("; ")} |`,
    ),
    "",
    "## Approval Fields",
    "",
    ...report.approvalPanel.requiredFields.map((field) => `- ${field}`),
  ];
  return `${lines.join("\n")}\n`;
}

function buildHtml(report) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Warden Approval Experience</title>
  <style>
    body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1d252c; background: #f6f8f7; }
    header, main { padding: 24px; }
    header { background: #fff; border-bottom: 1px solid #d6dde2; }
    section { background: #fff; border: 1px solid #d6dde2; border-radius: 8px; padding: 16px; margin-bottom: 14px; }
    h1, h2 { margin: 0 0 8px; letter-spacing: 0; }
    p { color: #5a6772; }
  </style>
</head>
<body>
  <header>
    <h1>Warden Approval Experience</h1>
    <p>Candidate writeback stays preview-only until a complete Warden approval packet is supplied.</p>
  </header>
  <main>
    <section><h2>Preview</h2><p>${report.candidateDiffs.length} candidates, ${report.summary.currentRepoCanonicalWrites} current repo canonical writes.</p></section>
    <section><h2>Rollback Rehearsal</h2><p>Temporary writes: ${report.summary.tempCanonicalWrites}; rollback verified: ${report.rollbackRehearsal.rollbackVerified}</p></section>
  </main>
</body>
</html>
`;
}

async function main() {
  const { previewRun, approvedRun, approvalPacket, tempWrites, rollbackVerified } = await runPreviewAndRollback();
  const candidateDiffs = previewRun.wardenWritebackFlow.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    sourceGapId: candidate.sourceGapId,
    candidateType: candidate.candidateType,
    writebackDecision: candidate.writebackDecision,
    target: candidate.targetRelativeToCanonical ? `canonical/${candidate.targetRelativeToCanonical}` : candidate.target,
    diffSummary: candidate.diffSummary,
    riskReview: candidate.dryRunArtifact.riskReview,
    rollbackPlan: approvalPacket.rollbackPlan,
    verificationOwner: candidate.verificationResult.owner,
    canonicalWrites: candidate.dryRunArtifact.canonicalWrites,
  }));
  const approvalPanel = {
    schemaVersion: "warden-approval-panel-v0.1",
    approvalRequired: previewRun.wardenWritebackFlow.approvalRequired,
    requiredFields: previewRun.wardenWritebackFlow.approvalRequest.requiredFields,
    approvalPacketPreview: approvalPacket,
    approveAction: "requires_explicit_user_approval",
    rejectAction: "record_none_with_reason",
    currentRepoWriteAllowed: false,
  };
  const rollbackRehearsal = {
    schemaVersion: "warden-rollback-rehearsal-v0.1",
    tempCanonicalWrites: tempWrites.length,
    tempTargets: tempWrites.map((item) => `canonical/${item.targetRelativeToCanonical}`),
    rollbackCommand: "Remove temporary canonical root used by rehearsal.",
    rollbackVerified,
    currentRepoCanonicalTouched: false,
    approvedWritebackStatus: approvedRun.wardenWritebackFlow.status,
  };
  const privacyLeaks = [candidateDiffs, approvalPanel, rollbackRehearsal].filter(hasLocalAbsolutePath);
  const report = {
    schemaVersion: "warden-approval-experience-v0.1",
    generatedAt: new Date().toISOString(),
    status:
      approvalPanel.approvalRequired === true &&
      candidateDiffs.length > 0 &&
      candidateDiffs.every((item) => item.canonicalWrites === 0 && item.verificationOwner) &&
      tempWrites.length > 0 &&
      rollbackVerified &&
      privacyLeaks.length === 0
        ? "pass"
        : "fail",
    summary: {
      candidateCount: candidateDiffs.length,
      currentRepoCanonicalWrites: 0,
      tempCanonicalWrites: tempWrites.length,
      rollbackVerified,
      privacyStatus: privacyLeaks.length === 0 ? "pass" : "fail",
    },
    approvalPanel,
    candidateDiffs,
    rollbackRehearsal,
    privacyCheck: {
      status: privacyLeaks.length === 0 ? "pass" : "fail",
      leaks: privacyLeaks.map((item) => String(item).slice(0, 80)),
    },
  };

  await reportContext.ensureDirectory(OUTPUT_DIR);
  const jsonPath = path.join(OUTPUT_DIR, "latest.json");
  const mdPath = path.join(OUTPUT_DIR, "latest.zh-CN.md");
  const htmlPath = path.join(OUTPUT_DIR, "approval-panel.html");
  await reportContext.writeJson(jsonPath, report);
  await reportContext.writeText(mdPath, buildMarkdown(report));
  await reportContext.writeText(htmlPath, buildHtml(report));
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: report.status === "pass",
        report: relativeToRepo(jsonPath),
        markdown: relativeToRepo(mdPath),
        html: relativeToRepo(htmlPath),
        candidateCount: report.summary.candidateCount,
        tempCanonicalWrites: report.summary.tempCanonicalWrites,
        currentRepoCanonicalWrites: report.summary.currentRepoCanonicalWrites,
        rollbackVerified: report.summary.rollbackVerified,
      },
      null,
      2,
    )}\n`,
  );
  if (report.status !== "pass") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
