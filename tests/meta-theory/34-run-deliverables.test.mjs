import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { runDiagnosticReadPlan } from "../../scripts/diagnostic-host-protocol.mjs";
import { fixtureCritical, fixtureReadWorkOrder, runFixtureHostCli } from "../helpers/host-reasoning-fixture.mjs";
import { localProtocolFixtureTaskFacts } from "../helpers/task-design-facts.mjs";
import { assertOptionalPlaybookContract } from "../helpers/optional-playbook-contract.mjs";
import { getReportLabels } from "../../scripts/meta-kim-i18n.mjs";
import { buildAgentProjectionTargets } from "../../scripts/runtime-tool-profiles.mjs";
import { readJson, readFile as readRepoFile } from "./_helpers.mjs";

const task = "只读核对 package.json、AGENTS.md、README.md 和工作流合同，输出当前源文件的核对记录，不修改文件。";
const scopes = ["package.json", "AGENTS.md", "README.md", "config/contracts/workflow-contract.json"];
let runtimeFixture, generateRunDeliverables, agentTeamsCandidateSkillPaths, runMetaTheoryGovernedExecution;
before(async () => {
  runtimeFixture = createGovernanceRuntimeFixtureScope(null, { graph: true });
  ({ generateRunDeliverables } = await runtimeFixture.import("scripts/generate-meta-theory-run-deliverables.mjs"));
  ({ agentTeamsCandidateSkillPaths, runMetaTheoryGovernedExecution } = await runtimeFixture.import("scripts/run-meta-theory-governed-execution.mjs"));
});
after(() => runtimeFixture?.cleanup());

const naturalUserTask = "帮我做个小红书营销自动发布器";

function hasLocalAbsolutePath(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /[A-Za-z]:[\\/]/.test(text) || /\/(?:Users|home|var|tmp|mnt)\//.test(text);
}

const requiredReportLabelFields = [
  "governedExecutionReportTitle",
  "panelTitle",
  "task",
  "inputTask",
  "gap",
  "decision",
  "reason",
  "blocked",
  "workerTask",
  "candidate",
  "type",
  "target",
  "dryRunWrites",
  "verification",
  "entry",
  "approvalRequired",
  "approvalValidation",
  "dryRunCanonicalWrites",
  "orchestrationReview",
  "writeback",
  "decisionRuns",
  "none",
  "notRun",
  "plainLanguageSummary",
  "capabilityRouteTitle",
  "capabilityType",
  "routeImpact",
  "cardPlanTitle",
  "cardDealer",
  "card",
  "cardShell",
  "cardWhy",
  "businessPhasePlanTitle",
  "phase",
  "mapsToSpine",
  "evidence",
  "spineRelationship",
  "durableAgentPolicyTitle",
  "agent",
  "skill",
  "mcp",
];

function assertStringLabelSet(labels, fields) {
  for (const field of fields) {
    assert.equal(typeof labels[field], "string", `${field} should be a string`);
    assert.notEqual(labels[field].trim(), "", `${field} should not be empty`);
  }
}

function visibleTopLevelLabelText(labels) {
  return requiredReportLabelFields.map((field) => labels[field]).join("\n");
}

describe("34 — Meta-theory run deliverables", () => {
  test("report i18n covers all supported locales beyond English and Chinese", () => {
    const english = getReportLabels("en");
    const localeExpectations = [
      {
        locale: "zh-CN",
        card: /发牌/u,
        phase: /11 阶段业务流/u,
        route: /能力路线/u,
        durable: /持久 Agent/u,
        stagePlan: /阶段执行说明/u,
      },
      {
        locale: "ja-JP",
        card: /カード配布/u,
        phase: /11フェーズ業務ワークフロー/u,
        route: /能力ルート/u,
        durable: /永続 Agent/u,
        stagePlan: /ステージ実行説明/u,
      },
      {
        locale: "ko-KR",
        card: /카드 배분/u,
        phase: /11단계 비즈니스 워크플로/u,
        route: /능력 경로/u,
        durable: /영구 Agent/u,
        stagePlan: /단계 실행 설명/u,
      },
    ];

    assertStringLabelSet(english, requiredReportLabelFields);
    assert.doesNotMatch(visibleTopLevelLabelText(english), /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u);
    assert.equal(typeof english.stageSummaries.critical, "function");
    assert.equal(typeof english.durableAgentPolicyBullets, "function");
    assert.equal(typeof english.userExperienceNotice.title, "string");
    assert.equal(typeof english.userExperienceNotice.signals.routeSummary, "function");
    assert.equal(typeof english.userExperienceNotice.partialStatusReason, "string");
    assert.equal(typeof english.userExperienceNotice.emittedStatusReason, "function");
    assert.equal(typeof english.userExperienceNotice.internalOnlySummary, "string");
    assert.equal(typeof english.conversationNotice.title, "string");
    assert.equal(typeof english.conversationNotice.routeDetail, "function");
    assert.equal(typeof english.cardVisibleSummary.sectionTitle, "string");
    assert.equal(typeof english.cardVisibleSummary.dealtLine, "function");
    assert.equal(typeof english.cardVisibleSummary.userLine, "function");
    assert.equal(typeof english.cardVisibleSummary.nextLine, "string");
    assert.equal(typeof english.cardVisibleSummary.nativeChoiceBoundary, "string");
    assert.equal(typeof english.cardVisibleSummary.progressSectionTitle, "string");
    assert.equal(typeof english.cardVisibleSummary.progressStageLine, "function");
    assert.equal(typeof english.cardVisibleSummary.progressDealLine, "function");
    assert.equal(typeof english.cardNames.clarify, "string");
    assert.equal(typeof english.stageOperationPlan.title, "string");
    assert.equal(typeof english.stageOperationPlan.executionResult, "function");

    for (const { locale, card, phase, route, durable, stagePlan } of localeExpectations) {
      const labels = getReportLabels(locale);
      assertStringLabelSet(labels, requiredReportLabelFields);
      assert.match(labels.cardPlanTitle, card);
      assert.match(labels.businessPhasePlanTitle, phase);
      assert.match(labels.capabilityRouteTitle, route);
      assert.match(labels.durableAgentPolicyTitle, durable);
      assert.match(labels.stageOperationPlan.title, stagePlan);
      assert.notEqual(labels.cardPlanTitle, english.cardPlanTitle);
      assert.notEqual(labels.businessPhasePlanTitle, english.businessPhasePlanTitle);
      assert.notEqual(labels.capabilityRouteTitle, english.capabilityRouteTitle);
      assert.notEqual(labels.durableAgentPolicyTitle, english.durableAgentPolicyTitle);
      assert.notEqual(labels.stageOperationPlan.title, english.stageOperationPlan.title);
      assert.notEqual(
        labels.stageOperationPlan.executionTitle,
        english.stageOperationPlan.executionTitle,
      );
      assert.equal(typeof labels.stageSummaries.critical, "function");
      assert.equal(typeof labels.stageSummaries.review, "function");
      assert.equal(typeof labels.userExperienceNotice.title, "string");
      assert.equal(typeof labels.userExperienceNotice.expectation, "string");
      assert.equal(typeof labels.userExperienceNotice.signals.ownerHandoff, "function");
      assert.equal(typeof labels.userExperienceNotice.partialStatusReason, "string");
      assert.equal(typeof labels.userExperienceNotice.emittedStatusReason, "function");
      assert.equal(typeof labels.userExperienceNotice.internalOnlySummary, "string");
      assert.equal(typeof labels.conversationNotice.title, "string");
      assert.equal(typeof labels.conversationNotice.stageProgressDetail, "string");
      assert.equal(typeof labels.conversationNotice.routeDetail, "function");
      assert.equal(typeof labels.cardVisibleSummary.sectionTitle, "string");
      assert.equal(typeof labels.cardVisibleSummary.dealtLine, "function");
      assert.equal(typeof labels.cardVisibleSummary.userLine, "function");
      assert.equal(typeof labels.cardVisibleSummary.nextLine, "string");
      assert.equal(typeof labels.cardVisibleSummary.nativeChoiceBoundary, "string");
      assert.equal(typeof labels.cardVisibleSummary.progressSectionTitle, "string");
      assert.equal(typeof labels.cardVisibleSummary.progressStageLine, "function");
      assert.equal(typeof labels.cardVisibleSummary.progressDealLine, "function");
      assert.equal(typeof labels.cardNames.pause, "string");
      assert.equal(typeof labels.stageOperationPlan.title, "string");
      assert.equal(typeof labels.stageOperationPlan.stages.execution.whatHappens, "string");
      assert.equal(typeof labels.cardPlanSummary, "function");
      assert.equal(typeof labels.businessPhaseSummary, "function");
      assert.equal(typeof labels.durableAgentPolicyBullets, "function");
      const toolList = labels.toolList(labels.toolNames);
      assert.match(labels.stageSummaries.critical(toolList), new RegExp(toolList));
      assert.doesNotMatch(labels.stageSummaries.critical(toolList), /undefined|function/u);
      const policy = labels.durableAgentPolicyBullets(labels.toolProfiles);
      assert.ok(Array.isArray(policy));
      assert.ok(policy.length >= labels.toolProfiles.length + 2);
      assert.doesNotMatch(policy.join("\n"), /undefined|function/u);
      assert.equal(typeof labels.deliverableLinks.readabilityReview, "string");
      assert.equal(typeof labels.readability.title, "string");
      assert.equal(typeof labels.rubric.title, "string");
      assert.equal(typeof labels.casePack.title, "string");
      assert.equal(labels.productTasks.length, 4);
    }
    assert.doesNotMatch(visibleTopLevelLabelText(getReportLabels("ja-JP")), /[\uac00-\ud7af]/u);
    assert.doesNotMatch(visibleTopLevelLabelText(getReportLabels("ko-KR")), /[\u3040-\u30ff]/u);
  });

  test("host-visible notice contract separates chat status from hook context", async () => {
    const contract = await readJson("config/contracts/workflow-contract.json");
    const visibleNotice =
      contract.runDiscipline?.qualityFirstPolicy?.hostVisibleNoticeContract;
    const codex = await readRepoFile(
      "canonical/skills/meta-theory/references/runtime-codex.md",
    );
    const claude = await readRepoFile(
      "canonical/skills/meta-theory/references/runtime-claude.md",
    );
    const notice = await readRepoFile(
      "canonical/templates/user-interaction/notice-template.md",
    );

    assert.equal(visibleNotice.required, true);
    assert.equal(visibleNotice.primaryUserVisibleSurface, "assistant_chat_message");
    assert.ok(
      visibleNotice.notUserVisibleSurfaces.includes(
        "hookSpecificOutput.additionalContext",
      ),
    );
    assert.ok(visibleNotice.notUserVisibleSurfaces.includes("markdown_report_only"));
    assert.deepEqual(visibleNotice.i18n.languageOrder, [
      "runtime_selected_output_language",
      "explicit_user_language",
      "latest_user_input_language",
      "neutral_fallback",
    ]);
    assert.equal(visibleNotice.i18n.maxBulletsPerNotice, 3);
    assert.equal(
      visibleNotice.runtimeAdapters.codex.choiceSurface,
      "request_user_input",
    );
    assert.equal(visibleNotice.runtimeAdapters.claude.choiceSurface, "AskUserQuestion");
    assert.match(codex, /additionalContext.*model\/developer context/i);
    assert.match(codex, /normal assistant chat text/i);
    assert.match(codex, /request_user_input.*branch-changing decisions/i);
    assert.match(claude, /MessageDisplay.*display-only/i);
    assert.match(claude, /assistant message itself/i);
    assert.match(claude, /AskUserQuestion.*branch-changing decisions/i);
    assert.match(notice, /ordinary assistant chat text/i);
    assert.match(notice, /HookPrompt\s*\/\s*`additionalContext`/i);
  });

  test("skill absorbs route-judgment and cleanup feedback as reusable rules", async () => {
    const skill = await readRepoFile("canonical/skills/meta-theory/SKILL.md");

    assert.match(skill, /Product-route or strategy-unclear requests/i);
    assert.match(skill, /decision protocol and minimum evidence bench/i);
    assert.match(skill, /candidate routes, required evidence, first experiment, pass\/kill signals/i);
    assert.match(skill, /full app lane starts only when/i);
    assert.match(skill, /Repository or product-doc cleanup requests/i);
    assert.match(skill, /change trains and source layers/i);
    assert.match(skill, /source layer, projection layer, evidence layer, and reader layer/i);
    assert.match(skill, /read-only, generate state, sync runtime projections, install\/update dependencies, or run live\/slow checks/i);
    assert.match(skill, /route judgment card/i);
    assert.match(skill, /Mark UI\/frontend\/backend\/database\/integration lanes as omitted/i);
  });

  test("generates separate UI, readability, rubric, and case-pack deliverables", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-deliverables-"));
    try {
      await runDiagnosticReadPlan(runMetaTheoryGovernedExecution, {
        task,
        runId: "test-run-deliverables",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
      }, scopes);
      const runArtifact = JSON.parse(
        await readFile(path.join(tempDir, "test-run-deliverables.json"), "utf8")
      );
      const markdownReport = await readFile(
        path.join(tempDir, "test-run-deliverables.zh-CN.md"),
        "utf8"
      );
      assert.deepEqual(runArtifact.stageVisibility.requiredStages, [
        "Critical",
        "Fetch",
        "Thinking",
        "Review",
      ]);
      assert.equal(runArtifact.durableProjectAgentPolicy.temporarySubagentAsDefinition, false);
      assert.deepEqual(
        runArtifact.durableProjectAgentPolicy.runtimeTargets,
        buildAgentProjectionTargets()
      );
      assert.ok(runArtifact.capabilityRoute.length >= 10);
      assert.equal(runArtifact.cardPlanPacket.schemaVersion, "card-plan-v0.3");
      assert.equal(
        runArtifact.userExperienceNotice.schemaVersion,
        "user-experience-notice-v0.1"
      );
      assert.equal(runArtifact.conversationNotice.schemaVersion, "conversation-notice-v0.1");
      assert.equal(runArtifact.conversationNotice.status, "not_emitted");
      assert.equal(runArtifact.conversationNotice.emitted, false);
      assert.equal(runArtifact.conversationNotice.emittedTextSha256, null);
      assert.equal(runArtifact.userExperienceNotice.status, "partial");
      assert.equal(runArtifact.userExperienceNotice.primarySurface, "user_readable_run_report");
      assert.equal(
        runArtifact.userExperienceNotice.pendingPrimarySurface,
        "localized_conversation_notice_host_observation_required"
      );
      assert.equal(runArtifact.userExperienceNotice.secondarySurface, "user_readable_run_report");
      assert.equal(runArtifact.userExperienceNotice.conversationNoticeEmitted, false);
      assert.equal(runArtifact.userExperienceNotice.conversationNoticeEvidence, null);
      assert.match(
        runArtifact.userExperienceNotice.statusReason,
        /还没有发出 runtime conversation notice|no runtime conversation notice/i
      );
      assert.ok(
        runArtifact.userExperienceNotice.internalOnlySignals.includes(
          "orchestrationTaskBoardPacket"
        )
      );
      assert.match(
        runArtifact.userExperienceNotice.accuracyBoundary,
        /artifact|运行时 notice|可读报告/i
      );
      assert.match(
        runArtifact.userExperienceNotice.mustNotClaim,
        /内部 artifact|internal artifact/i
      );
      assert.equal(
        runArtifact.stageOperationPlan.schemaVersion,
        "stage-operation-plan-v0.1"
      );
      assert.deepEqual(
        runArtifact.stageOperationPlan.stages.map((item) => item.stage),
        [
          "Critical",
          "Fetch",
          "Thinking",
          "Execution",
          "Review",
          "Meta-Review",
          "Verification",
          "Evolution",
        ]
      );
      const executionStage = runArtifact.stageOperationPlan.stages.find(
        (item) => item.stage === "Execution"
      );
      assert.equal(
        executionStage.workerTasks.length,
        runArtifact.runReportPanelContract.ownerHandoff.length
      );
      assert.ok(
        executionStage.workerTasks.every(
          (item) => item.owner && item.skill && item.mcp && item.command && item.resultReport
        )
      );
      assert.equal(runArtifact.cardPlanPacket.dealerOwner, "meta-conductor");
      assert.equal(runArtifact.cardPlanPacket.cardTypeCatalog.length, 10);
      assert.deepEqual(
        runArtifact.cardPlanPacket.cardTypeCatalog.map((item) => item.cardKey).sort(),
        [
          "clarify",
          "execute",
          "fix",
          "nudge",
          "options",
          "pause",
          "risk",
          "rollback",
          "shrink-scope",
          "verify",
        ]
      );
      assert.ok(runArtifact.cardPlanPacket.cardEvents.length >= 1);
      assert.equal(
        runArtifact.cardPlanPacket.visibleSummary.eventCount,
        runArtifact.cardPlanPacket.cardEvents.length
      );
      assert.equal(
        runArtifact.cardPlanPacket.visibleSummary.cardTypeCount,
        new Set(runArtifact.cardPlanPacket.cardEvents.map((item) => item.cardKey)).size
      );
      assert.ok(runArtifact.cardPlanPacket.eventOrder.includes("pause"));
      assert.ok(
        runArtifact.cardPlanPacket.cardEvents.every(
          (event) => Number.isInteger(event.repeatOrdinal) && event.repeatOrdinal >= 1
        ),
        "card event stream must record repeatOrdinal so repeated card types are representable"
      );
      assert.equal(runArtifact.cardPlanPacket.dealStandard.coveragePass, true);
      assert.equal(runArtifact.cardPlanPacket.dealStandard.passThreshold, 80);
      assert.ok(runArtifact.cardPlanPacket.dealStandard.minimumScore >= 80);
      assert.ok(runArtifact.cardPlanPacket.dealStandard.eventCount >= 1);
      assert.ok(Number.isInteger(runArtifact.cardPlanPacket.dealStandard.suppressedTypeCount));
      assert.ok(runArtifact.cardPlanPacket.dealStandard.suppressedTypeCount >= 0);
      assert.equal(
        runArtifact.cardPlanPacket.dealStandard.activeTypeCount +
          runArtifact.cardPlanPacket.dealStandard.suppressedTypeCount,
        runArtifact.cardPlanPacket.cardTypeDecisions.length,
      );
      for (const card of runArtifact.cardPlanPacket.cardTypeDecisions) {
        assert.equal(typeof card.decisionEvaluation.activationRule, "string");
        assert.notEqual(card.decisionEvaluation.activationRule.trim(), "");
        assert.ok(
          card.decisionEvaluation.accuracyScore >= card.decisionEvaluation.passThreshold,
          `${card.cardKey} card decision should pass`
        );
        assert.ok(
          Array.isArray(card.decisionEvaluation.quantitativeSignals),
          `${card.cardKey} should expose quantitative signals`
        );
        assert.ok(
          card.decisionEvaluation.quantitativeSignals.length >= 3,
          `${card.cardKey} should expose at least 3 quantitative signals`
        );
        assert.ok(
          card.decisionEvaluation.quantitativeSignals.every(
            (signal) =>
              typeof signal.signal === "string" &&
              "observed" in signal &&
              "expected" in signal &&
              typeof signal.pass === "boolean"
          ),
          `${card.cardKey} should expose signal/observed/expected/pass fields`
        );
        assert.ok(card.decisionEvaluation.evidenceRefs.length >= 1);
        assert.ok(card.decisionEvaluation.falsificationChecks.length >= 1);
      }
      assert.equal(
        runArtifact.cardPlanPacket.cardTypeDecisions.find((item) => item.cardKey === "risk")
          .decisionEvaluation.decisionState,
        "accurate_interrupt"
      );
      const fixCardWasDealt = runArtifact.cardPlanPacket.cardEvents.some(
        (item) => item.cardKey === "fix"
      );
      assert.equal(
        runArtifact.cardPlanPacket.cardTypeDecisions.find((item) => item.cardKey === "fix")
          .decisionEvaluation.decisionState,
        fixCardWasDealt ? "accurate_deal" : "accurate_suppress"
      );
      assert.equal(
        runArtifact.governanceStartReasonPacket.schemaVersion,
        "governance-start-reason-v0.1"
      );
      assert.equal(runArtifact.governanceStartReasonPacket.placement, "run_start");
      assert.match(runArtifact.governanceStartReasonPacket.summary, /进入 Meta-Theory/);
      assert.match(runArtifact.governanceStartReasonPacket.spineReason, /触发 8 阶段/);
      assert.match(runArtifact.governanceStartReasonPacket.workflowReason, /触发 11 阶段/);
      assert.match(runArtifact.governanceStartReasonPacket.cardReason, /触发发牌/);
      assert.match(markdownReport, /## 用户目标/u);
      assert.match(markdownReport, /## 工作协调与调用情况/u);
      assert.match(markdownReport, /## 阶段进展/u);
      assert.match(markdownReport, /## 验证与下一步/u);
      assert.doesNotMatch(
        markdownReport,
        /cardPlanPacket|status=|owner=|next=|selected_not_invoked|missingBindings/u,
      );
      for (const line of [
        runArtifact.governanceStartReasonPacket.summary,
        runArtifact.governanceStartReasonPacket.spineReason,
        runArtifact.governanceStartReasonPacket.workflowReason,
        runArtifact.governanceStartReasonPacket.cardReason,
      ]) {
        assert.ok(line.length <= 120, `start reason should stay concise: ${line}`);
      }
      assert.equal(
        runArtifact.businessPhasePlanPacket.schemaVersion,
        "business-phase-plan-v0.2"
      );
      assert.equal(runArtifact.businessPhasePlanPacket.phaseCount, 11);
      assert.deepEqual(
        runArtifact.businessPhasePlanPacket.phases.map((item) => item.phase),
        [
          "direction",
          "planning",
          "execution",
          "review",
          "meta_review",
          "revision",
          "verify",
          "summary",
          "feedback",
          "evolve",
          "mirror",
        ]
      );
      const nonPassingPhaseStates = new Set([
        "weak_trigger",
        "unsupported_skip",
        "blocked_without_enough_evidence",
        "pending_without_enough_evidence",
      ]);
      const computedPhaseCoveragePass = runArtifact.businessPhasePlanPacket.phases.every(
        (phase) =>
          phase.triggerEvaluation.triggerScore >=
            phase.triggerEvaluation.passThreshold &&
          !nonPassingPhaseStates.has(phase.triggerEvaluation.activationState)
      );
      assert.equal(
        runArtifact.businessPhasePlanPacket.triggerStandard.coveragePass,
        computedPhaseCoveragePass
      );
      assert.equal(runArtifact.businessPhasePlanPacket.triggerStandard.passThreshold, 80);
      assert.equal(
        runArtifact.businessPhasePlanPacket.triggerStandard.minimumScore,
        Math.min(
          ...runArtifact.businessPhasePlanPacket.phases.map(
            (phase) => phase.triggerEvaluation.triggerScore
          )
        )
      );
      for (const phase of runArtifact.businessPhasePlanPacket.phases) {
        assert.equal(typeof phase.triggerEvaluation.activationRule, "string");
        assert.notEqual(phase.triggerEvaluation.activationRule.trim(), "");
        assert.ok(
          Number.isInteger(phase.triggerEvaluation.triggerScore) &&
            phase.triggerEvaluation.triggerScore >= 0 &&
            phase.triggerEvaluation.triggerScore <= 100,
          `${phase.phase} trigger score should be a bounded percentage`
        );
        if (!nonPassingPhaseStates.has(phase.triggerEvaluation.activationState)) {
          assert.ok(
            phase.triggerEvaluation.triggerScore >= phase.triggerEvaluation.passThreshold,
            `${phase.phase} trigger score should pass for ${phase.triggerEvaluation.activationState}`
          );
        }
        assert.ok(
          Array.isArray(phase.triggerEvaluation.quantitativeSignals),
          `${phase.phase} should expose quantitative signals`
        );
        assert.ok(
          phase.triggerEvaluation.quantitativeSignals.length >= 3,
          `${phase.phase} should expose at least 3 quantitative signals`
        );
        assert.ok(
          phase.triggerEvaluation.quantitativeSignals.every(
            (signal) =>
              typeof signal.signal === "string" &&
              "observed" in signal &&
              "expected" in signal &&
              typeof signal.pass === "boolean"
          ),
          `${phase.phase} should expose signal/observed/expected/pass fields`
        );
        assert.ok(
          phase.triggerEvaluation.evidenceRefs.length >= 1,
          `${phase.phase} should cite evidence refs`
        );
        assert.ok(
          phase.triggerEvaluation.falsificationChecks.length >= 1,
          `${phase.phase} should expose falsification checks`
        );
      }
      const reviewPhase = runArtifact.businessPhasePlanPacket.phases.find(
        (item) => item.phase === "review"
      );
      const revisionPhase = runArtifact.businessPhasePlanPacket.phases.find(
        (item) => item.phase === "revision"
      );
      assert.equal(
        revisionPhase.triggerEvaluation.activationState,
        reviewPhase.status === "done" ? "accurate_skip" : revisionPhase.status === "skipped" ? "unsupported_skip" : "pending_without_enough_evidence"
      );
      assert.equal(
        runArtifact.businessPhasePlanPacket.phases.find((item) => item.phase === "feedback")
          .triggerEvaluation.activationState,
        "pending_external_input"
      );
      assert.equal(runArtifact.businessPhasePlanPacket.closure.currentPhase, "feedback");
      assert.equal(
        runArtifact.businessFlowBlueprintPacket.coverageJudgment,
        computedPhaseCoveragePass ? "complete" : "incomplete"
      );
      assert.equal(
        runArtifact.businessFlowBlueprintPacket.coverageDetail,
        computedPhaseCoveragePass
          ? "pass_route_selected_lanes_plus_all_11_business_phases_trigger_evaluated"
          : "fail_missing_route_lane_or_weak_business_phase_trigger_evidence"
      );
      assert.equal(
        runArtifact.businessFlowBlueprintPacket.phaseTriggerStandard.coveragePass,
        computedPhaseCoveragePass
      );
      const markdown = await readFile(path.join(tempDir, "test-run-deliverables.zh-CN.md"), "utf8");
      assert.match(markdown, /Critical：确认目标与边界/u);
      assert.match(markdown, /Fetch：核对证据与可用能力/u);
      assert.match(markdown, /Execution：准备或执行选定工作/u);
      assert.match(markdown, /Meta_Kim 协调能力/u);
      assert.match(markdown, /运行记录待关联（以当前聊天中的实际调用结果为准）/u);
      assert.equal(runArtifact.verificationPacket.verified, false);
      assert.equal(runArtifact.summaryPacket.verifyPassed, false);
      assert.equal(runArtifact.runtimeProjectionEvidence.status, "pass", "Projection checks alone must not claim task verification");
      assert.match(markdown, /验证仍需补充证据/u);
      assert.match(markdown, /当前助手继续处理未完成的执行与复核/u);
      assert.match(markdown, /计划已记录，执行和验收仍需当前证据/u);
      assert.doesNotMatch(markdown, /验证检查已完成|本次工作已部分完成|本次工作及相关检查已完成/u);
      assert.doesNotMatch(
        markdown,
        /Packet|packet|status=|owner=|next=|selected_not_invoked|missingBindings|accurate_interrupt/u,
      );
      const manifest = await generateRunDeliverables({
        runId: "test-run-deliverables",
        stateDir: tempDir,
        outDir: path.join(tempDir, "deliverables"),
      });

      assert.equal(manifest.schemaVersion, "meta-theory-run-deliverables-v0.1");
      assert.equal(manifest.status, "pass");
      assert.deepEqual(
        manifest.productTasks.map((item) => `${item.id}:${item.status}`),
        ["P-012:pass", "P-013:pass", "P-014:pass", "P-023:pass"]
      );
      assert.equal(hasLocalAbsolutePath(manifest), false);

      const filePaths = Object.fromEntries(
        Object.entries(manifest.files).map(([key, relativePath]) => [
          key,
          path.join(tempDir, "deliverables", path.basename(relativePath)),
        ])
      );
      for (const filePath of Object.values(filePaths)) {
        await stat(filePath);
      }

      const panel = await readFile(filePaths.panelHtml, "utf8");
      const labels = getReportLabels("zh-CN");
      const sectionLabels = labels.sections;
      assert.match(panel, /Meta_Kim 运行面板/);
      assert.match(panel, new RegExp(sectionLabels.decisionSummary));
      assert.match(panel, new RegExp(sectionLabels.ownerHandoff));
      assert.match(panel, new RegExp(sectionLabels.toolEvidenceShort));
      assert.match(panel, new RegExp(sectionLabels.aiReadableRubric));
      assert.equal(hasLocalAbsolutePath(panel), false);

      const readability = await readFile(filePaths.readabilityReview, "utf8");
      assert.match(readability, /字段翻译表/);
      assert.match(readability, /机器字段/);
      assert.match(readability, /人话标签/);
      assert.equal(hasLocalAbsolutePath(readability), false);

      const rubricJson = JSON.parse(await readFile(filePaths.rubricJson, "utf8"));
      assert.equal(rubricJson.schemaVersion, "ai-readable-run-rubric-v0.1");
      assert.deepEqual(
        rubricJson.criteria.map((item) => item.id),
        ["design", "execution", "acceptance", "feedback", "deliverables"]
      );
      assert.equal(hasLocalAbsolutePath(rubricJson), false);

      const rubricMarkdown = await readFile(filePaths.rubricMarkdown, "utf8");
      assert.match(rubricMarkdown, /设计标准/);
      assert.match(rubricMarkdown, /执行标准/);
      assert.match(rubricMarkdown, /验收标准/);
      assert.match(rubricMarkdown, /反馈标准/);
      assert.match(rubricMarkdown, /交付内容标准/);

      const casePack = await readFile(filePaths.casePack, "utf8");
      assert.match(casePack, /reviewer 该看到什么/);
      assert.match(casePack, /reviewer 怎么评分/);
      assert.match(casePack, /通过 \/ 失败样例/);
      assert.equal(hasLocalAbsolutePath(casePack), false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("a short product intent preserves its goal and next host action without fabricated execution", async () => {
    assert.doesNotMatch(naturalUserTask, /agent|skill|MCP|command|阶段|packet|JSON/i);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-natural-user-"));
    try {
      const result = await runMetaTheoryGovernedExecution({ task: naturalUserTask, runId: "natural-user-task",
        stateDir: tempDir, dbPath: path.join(tempDir, "runs.sqlite") });
      const runArtifact = JSON.parse(await readFile(result.paths.json, "utf8"));
      assert.equal(runArtifact.task, naturalUserTask);
      assert.equal(runArtifact.artifactKind, "host_preparation");
      assert.equal(runArtifact.preparation.status, "needs_thinking");
      assert.equal(runArtifact.hostInvocationRequestPacket.nextAction.stage, "Critical");
      assert.equal(runArtifact.hostInvocationRequestPacket.nextAction.producer, "current_host_ai");
      assert.equal(runArtifact.hostInvocationRequestPacket.executionAllowed, false);
      assert.deepEqual(runArtifact.workerTaskPackets, []);
      assert.equal(runArtifact.coreLoop.stageDagPacket, undefined);
      assert.equal(runArtifact.publicReadyDecision.publicReady, false);
      assert.equal(runArtifact.machineExecution.actualWorkerExecution, undefined);
      assert.equal(runArtifact.coreLoop.executionResult.actualWorkerExecution, false);
      assert.match(await readFile(result.paths.markdown, "utf8"), /尚未形成正式执行工单/u);
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  });

  test("CLI emits an honest localized preparation notice and strict mode keeps the pending exit", async () => {
    assert.doesNotMatch(naturalUserTask, /Critical|Fetch|Thinking|Review|agent|skill|MCP|packet|JSON/i);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-conversation-notice-"));
    try {
      const args = ["scripts/run-meta-theory-governed-execution.mjs", "--task", naturalUserTask,
        "--run-id", "wish-style-conversation-notice", "--state-dir", tempDir, "--db", path.join(tempDir, "runs.sqlite"),
        "--emit-conversation-notice"];
      const result = runtimeFixture.run(args);
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.status, "needs_thinking");
      assert.equal(summary.executionAllowed, false);
      assert.match(result.stderr, /Meta_Kim 对话提示/u);
      assert.match(result.stderr, /需求和当前准备状态已保存/u);
      assert.match(result.stderr, /当前助手整理目标、现有条件与验收标准/u);
      assert.doesNotMatch(result.stderr, /验证检查已完成|本次工作已部分完成|本次工作及相关检查已完成/u);
      assert.doesNotMatch(result.stderr, /ownerDiscoveryPacket|workerTaskPackets|cardPlanPacket|status=|owner=|next=/u);
      const artifact = JSON.parse(await readFile(summary.input, "utf8"));
      assert.equal(artifact.artifactKind, "host_preparation");
      assert.deepEqual(artifact.workerTaskPackets, []);
      assert.equal(artifact.publicReadyDecision.publicReady, false);
      assert.equal(artifact.conversationNotice, undefined, "CLI transport must not manufacture a persisted host observation");
      const strict = runtimeFixture.run([...args, "--strict-exit-code", "--no-emit-conversation-notice"]);
      assert.equal(strict.status, 1, strict.stderr);
      assert.equal(JSON.parse(strict.stdout).status, "needs_thinking");
      assert.equal(strict.stderr, "");
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  });

  test("CLI emits the full plan notice after an explicit current host preparation and decision", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-default-conversation-notice-"));
    const cliTask = "只读核对 package.json 的版本并报告，不修改文件。";
    const criticalInput = fixtureCritical({ task: cliTask, successCriteria: [{ id: "package-version", condition: "报告当前 package.json 版本", evidenceRequired: "package.json 的当前字节" }] });
    try {
      const result = runFixtureHostCli(runtimeFixture,
        ["scripts/run-meta-theory-governed-execution.mjs", "--task", cliTask, "--run-id", "default-conversation-notice",
          "--state-dir", tempDir, "--db", path.join(tempDir, "runs.sqlite"), "--emit-conversation-notice"],
        { criticalInput, governanceTaskFacts: localProtocolFixtureTaskFacts(cliTask), workOrders: preparation => [fixtureReadWorkOrder(preparation,
          { id: "package-read", todayTask: cliTask, output: "当前版本核对记录", criterionIds: ["package-version"], taskFacts: localProtocolFixtureTaskFacts(cliTask) })] });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.status, "partial");
      assert.match(result.stderr, /Meta_Kim 对话提示/u);
      assert.doesNotMatch(result.stderr, /status=|owner=|next=|selected_not_invoked|missingBindings/u);
      const artifact = JSON.parse(await readFile(path.join(tempDir, "default-conversation-notice.json"), "utf8"));
      assert.equal(artifact.conversationNotice.status, "emitted");
      assert.equal(artifact.conversationNotice.evidenceKind, "transport_emitted_notice");
      assert.equal(artifact.conversationNotice.outputBoundary, "stderr_progress_channel");
      assert.equal(artifact.conversationNotice.hostObservation.status, "host_observation_required");
      assert.equal(artifact.conversationNotice.textSha256, createHash("sha256").update(artifact.conversationNotice.text, "utf8").digest("hex"));
      assert.ok(result.stderr.includes(artifact.conversationNotice.text));
      assert.match(artifact.conversationNotice.routeSummary.cardSummary.nativeChoiceBoundary, /不是 native choice popup 证据/u);
      assert.equal(artifact.userExperienceNotice.status, "partial");
      assert.equal(artifact.userExperienceNotice.conversationNoticeEmitted, true);
      assert.equal(artifact.userExperienceNotice.conversationNoticeObserved, false);
      assert.equal(artifact.publicReadyDecision.publicReady, false);
      assert.equal(artifact.coreLoop.executionResult.actualWorkerExecution, false);
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  });

  test("CLI temp-output keeps governed run artifacts outside the project state tree", async () => {
    const runId = `temp-output-conversation-notice-${process.pid}`;
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-meta-theory-governed-execution.mjs",
        "--task",
        naturalUserTask,
        "--run-id",
        runId,
        "--temp-output",
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.runId, runId);
    assert.equal(summary.temporaryOutput.root.includes("meta-kim-governed-execution-"), true);
    assert.equal(summary.report, `<external-temp>/${runId}.zh-CN.md`);

    const artifact = JSON.parse(
      await readFile(path.join(summary.temporaryOutput.artifactDir, `${runId}.json`), "utf8")
    );
    assert.equal(artifact.runId, runId);
    const validation = spawnSync(
      process.execPath,
      [
        "scripts/validate-run-artifact.mjs",
        path.join(summary.temporaryOutput.artifactDir, `${runId}.json`),
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    assert.equal(validation.status, 0, validation.stderr || validation.stdout);

    const defaultArtifactPath = path.join(
      process.cwd(),
      ".meta-kim",
      "state",
      "default",
      "governed-executions",
      `${runId}.json`
    );
    await assert.rejects(stat(defaultArtifactPath));
    await rm(summary.temporaryOutput.root, { recursive: true, force: true });
  });

  test("CLI writes a manifest for the latest run", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-deliverables-cli-"));
    try {
      await runDiagnosticReadPlan(runMetaTheoryGovernedExecution, {
        task,
        runId: "test-run-deliverables-cli",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
      }, scopes);
      const result = spawnSync(
        process.execPath,
        [
          "scripts/generate-meta-theory-run-deliverables.mjs",
          "latest",
          tempDir,
          path.join(tempDir, "deliverables-cli"),
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      assert.equal(result.status, 0, result.stderr);
      const manifest = JSON.parse(result.stdout);
      assert.equal(manifest.runId, "test-run-deliverables-cli");
      assert.equal(manifest.files.panelHtml.endsWith("run-panel.html"), true);
      assert.equal(hasLocalAbsolutePath(manifest), false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("report latest never treats an external lookalike state tree as the repository lifecycle", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-report-latest-"));
    try {
      const profileDir = path.join(tempDir, ".meta-kim", "state", "default");
      const executionDir = path.join(profileDir, "governed-executions");
      await mkdir(executionDir, { recursive: true });

      const committedRunId = "meta-latest-committed-demo";
      const jsonPath = path.join(executionDir, `${committedRunId}.json`);
      const markdownPath = path.join(executionDir, `${committedRunId}.zh-CN.md`);
      await writeFile(
        jsonPath,
        `${JSON.stringify(
          {
            runId: committedRunId,
            status: "partial",
            runReport: {
              language: "zh-CN",
              markdownPath: `.meta-kim/state/default/governed-executions/${committedRunId}.zh-CN.md`,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(markdownPath, "# committed report\n", "utf8");
      await writeFile(
        path.join(executionDir, "latest.json"),
        `${JSON.stringify(
          {
            runId: committedRunId,
            jsonPath: `.meta-kim/state/default/governed-executions/${committedRunId}.json`,
            markdownPath: `.meta-kim/state/default/governed-executions/${committedRunId}.zh-CN.md`,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await writeFile(
        path.join(profileDir, "active-run.json"),
        `${JSON.stringify(
          {
            schemaVersion: 2,
            active: true,
            runId: "meta-2999-01-01t00-00-00-000z-active-demo",
            lifecycleStatus: "active",
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const latestCommitted = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--read",
          "latest",
          "--state-dir",
          executionDir,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(latestCommitted.status, 0, latestCommitted.stderr);
      const latestSummary = JSON.parse(latestCommitted.stdout);
      assert.equal(latestSummary.runId, committedRunId);
      assert.equal(latestSummary.status, "partial");
      assert.equal(latestSummary.selection.selectionSource, "latest_committed_pointer");
      assert.equal(
        latestSummary.selection.selectionReason,
        "last_committed_governed_report",
      );
      assert.match(latestSummary.selection.selectionExplanation, /latest\.json/u);
      assert.equal(latestSummary.selection.activeRunRelation, "not_checked_custom_output");
      assert.equal(latestSummary.selection.activeRunId, null);
      assert.equal(latestSummary.selection.continuationMode, "report_only");
      assert.equal(latestSummary.selection.nextCommand, null);

      const explicitHistoricalReport = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--read",
          committedRunId,
          "--state-dir",
          executionDir,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(explicitHistoricalReport.status, 0, explicitHistoricalReport.stderr);
      const summary = JSON.parse(explicitHistoricalReport.stdout);
      assert.equal(summary.runId, committedRunId);
      assert.equal(summary.status, "partial");
      assert.equal(summary.selection.selectionSource, "explicit_run_id");
      assert.equal(summary.selection.selectionReason, "explicit_committed_run_id");
      assert.match(summary.selection.selectionExplanation, /explicit runId/u);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
