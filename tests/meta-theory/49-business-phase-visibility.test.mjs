import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runMetaTheoryGovernedExecution } from "../../scripts/run-meta-theory-governed-execution.mjs";

const naturalUserTask = "帮我做个小红书营销自动发布器";

describe("49 - 11-phase business workflow visibility", () => {
  test("programmatic governed run records phase reasons and report-visible current phase", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-11-phase-api-"));
    try {
      await runMetaTheoryGovernedExecution({
        task: naturalUserTask,
        runId: "api-phase-visibility",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
      });

      const artifact = JSON.parse(
        await readFile(path.join(tempDir, "api-phase-visibility.json"), "utf8")
      );
      assert.equal(artifact.conversationNotice.status, "not_emitted");
      assert.equal(artifact.userExperienceNotice.status, "partial");
      assert.equal(
        artifact.userExperienceNotice.hostObservationStatus,
        "host_observation_required"
      );
      assert.equal(artifact.businessPhasePlanPacket.phaseCount, 11);
      for (const phase of artifact.businessPhasePlanPacket.phases) {
        assert.ok(["done", "skipped", "blocked", "pending"].includes(phase.status));
        assert.equal(typeof phase.statusReason, "string");
        assert.notEqual(phase.statusReason.trim(), "");
        assert.equal(typeof phase.nextAction, "string");
        assert.notEqual(phase.nextAction.trim(), "");
      }
      assert.equal(artifact.businessPhasePlanPacket.closure.currentPhase, "feedback");
      assert.equal(artifact.businessPhasePlanPacket.closure.currentStatus, "pending");
      assert.match(artifact.businessPhasePlanPacket.closure.currentReason, /用户验收或反馈/);
      assert.match(artifact.businessPhasePlanPacket.closure.currentNextAction, /等待用户确认/);

      const markdown = await readFile(path.join(tempDir, "api-phase-visibility.zh-CN.md"), "utf8");
      assert.match(markdown, /## 阶段进展/u);
      assert.match(markdown, /Critical：确认目标与边界/u);
      assert.match(markdown, /Evolution：在适合时记录可复用结论/u);
      assert.match(markdown, /## 验证与下一步/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("CLI emits 11-phase status notice when explicitly requested", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-11-phase-cli-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--task",
          naturalUserTask,
          "--run-id",
          "cli-phase-visibility",
          "--state-dir",
          tempDir,
          "--db",
          path.join(tempDir, "runs.sqlite"),
          "--emit-conversation-notice",
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      );

      assert.equal(result.status, 0, result.stderr);
      JSON.parse(result.stdout);
      assert.match(result.stderr, /Meta_Kim 对话提示:/u);
      assert.match(result.stderr, /11阶段状态: 业务流程计划已记录/u);
      assert.doesNotMatch(result.stderr, /done=|skipped=|blocked=|pending=/u);
      assert.match(result.stderr, /计划状态不代表已执行或验收/u);
      assert.match(result.stderr, /当前阶段: 反馈 · 等待/u);
      assert.match(result.stderr, /阻塞阶段: 无/u);
      assert.doesNotMatch(
        result.stderr,
        /businessPhasePlanPacket|workerTaskPackets|cardPlanPacket/u
      );

      const artifact = JSON.parse(
        await readFile(path.join(tempDir, "cli-phase-visibility.json"), "utf8")
      );
      const closure = artifact.conversationNotice.progressEvents.find((event) => event.stage === "Closure");
      assert.equal(closure.details.source, "businessPhasePlanPacket");
      assert.equal(closure.details.phaseCount, artifact.businessPhasePlanPacket.phaseCount);
      assert.equal(closure.details.currentPhase, artifact.businessPhasePlanPacket.closure.currentPhase);
      assert.equal(closure.details.currentStatus, artifact.businessPhasePlanPacket.closure.currentStatus);
      assert.deepEqual(closure.details.blockedPhases, artifact.businessPhasePlanPacket.phases
        .filter((phase) => phase.status === "blocked").map((phase) => phase.phase));
      assert.equal(closure.details.nextAction, artifact.businessPhasePlanPacket.closure.currentNextAction);
      assert.ok(result.stderr.includes(`下一步: ${artifact.businessPhasePlanPacket.closure.currentNextAction}`));
      assert.equal(closure.details.executionOrAcceptanceEvidence, false);
      assert.equal(result.stderr.split("11阶段状态:").length - 1, 1);
      assert.equal(artifact.conversationNotice.status, "emitted");
      assert.equal(artifact.conversationNotice.evidenceKind, "transport_emitted_notice");
      assert.equal(artifact.conversationNotice.outputBoundary, "stderr_progress_channel");
      assert.equal(
        artifact.conversationNotice.hostObservation.status,
        "host_observation_required"
      );
      assert.match(
        artifact.conversationNotice.routeSummary.businessPhaseSummary.groupLine,
        /blocked=none/u
      );
      assert.match(
        artifact.conversationNotice.routeSummary.businessPhaseSummary.currentLine,
        /feedback=pending/u
      );
      assert.equal(artifact.userExperienceNotice.status, "partial");
      assert.equal(artifact.userExperienceNotice.conversationNoticeEmitted, true);
      assert.equal(artifact.userExperienceNotice.conversationNoticeObserved, false);
      assert.equal(
        artifact.userExperienceNotice.hostObservationStatus,
        "host_observation_required"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("CLI can still suppress conversation notice for machine-readable runs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-11-phase-cli-quiet-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--task",
          naturalUserTask,
          "--run-id",
          "cli-phase-quiet",
          "--state-dir",
          tempDir,
          "--db",
          path.join(tempDir, "runs.sqlite"),
          "--no-emit-conversation-notice",
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      );

      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /^Meta_Kim 对话提示:/u);
      assert.match(result.stdout, /"runId": "cli-phase-quiet"/u);
      const artifact = JSON.parse(
        await readFile(path.join(tempDir, "cli-phase-quiet.json"), "utf8")
      );
      assert.equal(artifact.conversationNotice.status, "not_emitted");
      assert.equal(artifact.userExperienceNotice.status, "partial");
      assert.equal(
        artifact.userExperienceNotice.hostObservationStatus,
        "host_observation_required"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
