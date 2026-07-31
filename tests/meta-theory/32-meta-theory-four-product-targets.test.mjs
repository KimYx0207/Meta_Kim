import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  buildRuntimeProjectionEvidence,
  classifyProjectionFailure,
  exactInvocationBindingMatches,
  evaluateInvocationCoverage,
  readGovernedExecutionRun,
  runMetaTheoryGovernedExecution,
} from "../../scripts/run-meta-theory-governed-execution.mjs";
const multiGapTask = [
  "同一套 PRD review standard 需要 skill。",
  "长期 test coverage owner 需要 agent。",
  "release summary JSON 需要脚本。",
  "内部知识库需要 MCP provider 边界。",
].join("\n");

const productExperienceTask =
  "帮我做个小红书营销自动发布器，需要动态规划、平台规则研究、内容策略、前端界面、后端 API、数据模型、平台集成、权限风控、测试验收和发布运维，但不要真实发布或使用生产凭证。";
const contentOnlyProductTask =
  "我想做个东西，能把我平时随手记的想法变成能发出去的内容，但我现在也说不清先做成啥，你帮我拆一下怎么落地，别真发。";
const trustedNativeChoiceEvidence = [
  {
    runtime: "codex",
    stage: "Thinking",
    state: "completed",
    surface: "request_user_input",
    evidenceKind: "request_user_input_answer",
    evidenceRef: "codex:request_user_input:acceptance-route",
  },
];

describe("32 — Meta-theory three product goals and support gates", () => {
  test("Agent invocation joins require exact owner binding mode and native Agent identity", () => {
    const base = {
      family: "agent_subagent",
      providerId: "global:meta-prism",
      bindingRef: "task-1:agent_subagent:global:meta-prism",
    };
    assert.equal(
      exactInvocationBindingMatches(
        { ...base, ownerBindingMode: "run_scoped_owner_contract", nativeAgentType: null },
        { ...base, ownerBindingMode: "run_scoped_owner_contract", nativeAgentType: null },
      ),
      true,
    );
    assert.equal(
      exactInvocationBindingMatches(
        { ...base, ownerBindingMode: "native_custom_agent", nativeAgentType: "meta-prism" },
        { ...base, ownerBindingMode: "run_scoped_owner_contract", nativeAgentType: null },
      ),
      false,
    );
    assert.equal(
      exactInvocationBindingMatches(
        { ...base, ownerBindingMode: "native_custom_agent", nativeAgentType: "meta-prism" },
        { ...base, ownerBindingMode: "native_custom_agent", nativeAgentType: "different-agent" },
      ),
      false,
    );
    assert.equal(
      exactInvocationBindingMatches(
        { family: "mcp", providerId: "mcp.selected", bindingRef: "task:mcp:mcp.selected" },
        { family: "mcp", providerId: "mcp.selected", bindingRef: "task:mcp:mcp.selected" },
      ),
      true,
    );
  });

  test("real invocation coverage ignores unavailable callable probes when exact bindings are observed", () => {
    const coverage = evaluateInvocationCoverage({
      missingBindings: [],
      capabilityInvocationProbePacket: {
        status: "blocked",
        requiredFamilies: ["mcp"],
        callableFamilies: [],
        missingFamilies: ["mcp"],
      },
    });
    assert.equal(coverage.realStatus, "pass");
    assert.equal(coverage.callableStatus, "blocked");
  });

  test("T-001 runs the default governed orchestration runtime path", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-governed-run-"));
    try {
      const report = await runMetaTheoryGovernedExecution({
        task: multiGapTask,
        runId: "test-run-default",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
      });

      assert.equal(report.status, "partial");
      assert.equal(report.defaultRuntimePath.status, "partial");
      assert.equal(report.defaultRuntimePath.entry, "meta:theory:run");
      assert.deepEqual(report.defaultRuntimePath.triggerChain, [
        "entry_classifier",
        "capability_discovery",
        "select_execution_route",
        "worker_task_packets",
      ]);
      assert.equal(
        report.defaultRuntimePath.orchestrationTaskBoardPacket.synthesisOwner,
        "meta-conductor"
      );
      assert.equal(report.defaultRuntimePath.workerTaskPackets.length, 4);
      assert.deepEqual(
        [...new Set(report.defaultRuntimePath.workerTaskPackets.map((packet) => packet.mergeOwner))],
        ["meta-conductor"],
      );
      assert.equal(
        report.defaultRuntimePath.orchestrationTaskBoardPacket.mergeOwner,
        "meta-conductor",
      );
      assert.equal(report.defaultRuntimePath.governanceAgentResultPackets.length, 9);
      assert.equal(report.defaultRuntimePath.conductorConsumptionEvidence.status, "pass");
      assert.ok(
        report.defaultRuntimePath.conductorConsumptionEvidence.consumedPacketRefs.length >= 5
      );
      assert.equal(report.defaultRuntimePath.workerResultPackets.length, 4);
      assert.equal(report.defaultRuntimePath.workerExecutionEvidence.length, 4);
      assert.equal(report.defaultRuntimePath.traceEvalControlPlane.stageTiming.length, 8);
      assert.equal(report.defaultRuntimePath.agUiStageEvents.eventCount, 8);
      assert.ok(report.defaultRuntimePath.performanceCostBudget.highUsePaths.length >= 6);
      assert.equal(report.defaultRuntimePath.contextEngineeringBudget.status, "partial");
      assert.equal(
        report.defaultRuntimePath.contextEngineeringBudget.measurement.hostObservedContextLoad,
        false,
      );
      assert.equal(
        report.defaultRuntimePath.contextEngineeringBudget.measurement.actualInputTokens,
        null,
      );
      assert.ok(
        report.defaultRuntimePath.contextEngineeringBudget.blockedBy.includes(
          "host_context_load_not_observed",
        ),
      );
      assert.ok(
        report.defaultRuntimePath.contextEngineeringBudget.blockedBy.includes(
          "duplicate_rule_scan_not_run",
        ),
      );
      const frameworkPromptContract = JSON.parse(
        await readFile(
          new URL(
            "../../config/contracts/framework-prompt-architecture-contract.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      const allowedContextEvidenceStates = new Set(
        frameworkPromptContract.contextEngineeringBudget.sourceRecordEvidenceStateEnum,
      );
      const contextSources = [
        ...report.defaultRuntimePath.contextEngineeringBudget.fixedContext,
        ...report.defaultRuntimePath.contextEngineeringBudget.variableContext,
      ];
      assert.equal(
        contextSources.every((source) =>
          allowedContextEvidenceStates.has(source.evidenceState),
        ),
        true,
        "context source evidenceState must be constrained by the framework contract enum",
      );
      assert.ok(
        allowedContextEvidenceStates.has("host_observed_as_model_context"),
        "the contract must define the observed state used by truthful public-ready fixtures",
      );
      assert.equal(
        contextSources.some(
          (source) => source.evidenceState === "host_observed_as_model_context",
        ),
        false,
        "the default partial artifact must not exercise the host-observed evidence state",
      );
      assert.equal(report.publicReadyDecision.publicReady, false);
      assert.equal(
        report.publicReadyDecision.contextEngineeringBudgetStatus,
        "partial",
      );
      assert.deepEqual(
        report.publicReadyDecision.contextEngineeringBudgetBlockedBy,
        report.contextEngineeringBudget.blockedBy,
      );
      assert.ok(
        report.publicReadyDecision.blockedBy.includes(
          "contextEngineeringBudget.status=partial.",
        ),
        "public-ready must be blocked by a non-pass context budget",
      );
      assert.equal(report.status, "partial");
      assert.equal(report.defaultRuntimePath.status, "partial");
      assert.ok(
        report.partialReasons.includes("context_engineering_budget=partial"),
        "final artifact partialReasons must include the context budget status",
      );
      for (const blocker of report.contextEngineeringBudget.blockedBy) {
        assert.ok(
          report.partialReasons.includes(`context_engineering_budget_blocked_by=${blocker}`),
          `final artifact partialReasons missing context blocker ${blocker}`,
        );
      }
      assert.equal(report.defaultRuntimePath.langGraphRunPacket.status, "pass");
      assert.equal(report.defaultRuntimePath.peerAgentMeshPacket.status, "pass");
      assert.equal(report.defaultRuntimePath.agentTeamsPlaybookPacket.status, "pass");
      assert.equal(report.defaultRuntimePath.agentTeamsPlaybookPacket.selected, true);
      assert.deepEqual(
        [
          ...new Set(
            report.defaultRuntimePath.agentTeamsPlaybookPacket.waves.flatMap((wave) =>
              wave.mergeOwner
            ),
          ),
        ],
        ["meta-conductor"],
      );
      assert.equal(
        report.defaultRuntimePath.agentTeamsPlaybookPacket.fanoutSafetyPacket.safeForParallelFanout,
        true
      );
      assert.equal(
        report.defaultRuntimePath.agentTeamsPlaybookPacket.acceptance.independentLanesProven,
        true
      );
      assert.equal(
        report.defaultRuntimePath.agentTeamsPlaybookPacket.acceptance.parallelWaveExists,
        true
      );
      assert.equal(
        report.defaultRuntimePath.agentTeamsPlaybookPacket.acceptance.dagAndCollisionSafe,
        true
      );
      assert.equal(
        report.defaultRuntimePath.agentTeamsPlaybookPacket.acceptance.waveSizeWithinRuntimeCapacity,
        true
      );
      assert.equal(
        report.defaultRuntimePath.agentTeamsPlaybookPacket.acceptance.noArbitraryMetaKimCap,
        true
      );
      assert.equal(report.capabilityInvocationTruthPacket.status, "partial");
      const invocationByFamily = new Map(
        report.capabilityInvocationTruthPacket.rows.map((row) => [
          row.family,
          row,
        ])
      );
      assert.equal(report.defaultRuntimePath.runtimeSubagentInvocationPacket.status, "unavailable");
      assert.equal(invocationByFamily.get("agent_subagent").state, "unavailable");
      assert.equal(invocationByFamily.get("app_visible_subagent").state, "not_required");
      assert.equal(invocationByFamily.get("worker_task").state, "blocked");
      assert.equal(invocationByFamily.get("prompt_rule").state, "applied");
      assert.equal(invocationByFamily.get("agent_teams_playbook").state, "selected_not_invoked");
      assert.equal(report.defaultRuntimePath.capabilityInvocationProbePacket.status, "not_run");
      assert.equal(
        report.capabilityInvocationTruthPacket.realInvocationCoverage.status,
        "partial"
      );
      assert.equal(report.defaultRuntimePath.hostInvocationRequestPacket.status, "partial");
      assert.ok(
        report.defaultRuntimePath.hostInvocationRequestPacket.pendingFamilies.includes(
          "agent_subagent"
        )
      );
      assert.ok(
        report.defaultRuntimePath.hostInvocationRequestPacket.requests.some(
          (request) =>
            request.family === "agent_subagent" &&
            request.status === "pending_host_invocation" &&
            request.requiredEvidence.trustedAdapterOnly === true
        )
      );
      assert.equal(
        report.defaultRuntimePath.hostInvocationRequestPacket.requests.length,
        report.defaultRuntimePath.runtimeInvocationPlanPacket.missingBindings.length,
        "every missing exact binding must have one host invocation request",
      );
      for (const binding of report.defaultRuntimePath.runtimeInvocationPlanPacket.missingBindings) {
        const request = report.defaultRuntimePath.hostInvocationRequestPacket.requests.find(
          (item) =>
            item.family === binding.family &&
            item.providerId === binding.providerId &&
            item.bindingRef === binding.bindingRef,
        );
        assert.ok(request, `missing exact request for ${binding.bindingRef}`);
        assert.equal(request.requiredEvidence.exactValues.runId, "test-run-default");
        assert.equal(request.requiredEvidence.exactValues.providerId, binding.providerId);
        assert.equal(request.requiredEvidence.exactValues.bindingRef, binding.bindingRef);
        for (const field of ["run", "session", "event", "provider", "binding", "timestamp", "result", "artifactHash"]) {
          assert.ok(request.requiredEvidence.requiredFields[field], `${binding.bindingRef} missing ${field}`);
        }
        if (binding.family === "mcp") {
          assert.equal(request.requiredEvidence.evidenceKind, "mcp_tool_result");
          assert.match(request.requiredEvidence.familySpecificRule, /exact selected provider tool call/i);
        }
        if (binding.family === "hook") {
          assert.equal(request.requiredEvidence.evidenceKind, "hook_trigger_event");
        }
      }
      assert.equal(report.defaultRuntimePath.durableAgentLifecyclePacket.status, "partial");
      assert.equal(
        report.defaultRuntimePath.durableAgentLifecyclePacket.stages.find(
          (stage) => stage.stage === "live_invocation_proof"
        ).status,
        "partial"
      );
      assert.ok(
        ["selected_not_invoked", "discovered_not_selected", "not_required"].includes(
          invocationByFamily.get("mcp").state
        )
      );
      assert.ok(["pass", "partial"].includes(report.defaultRuntimePath.visibleMetaTheorySurfacePacket.status));
      assert.equal(report.defaultRuntimePath.visibleMetaTheorySurfacePacket.capabilityInventory.notSkillOnly, true);
      assert.equal(
        report.defaultRuntimePath.visibleMetaTheorySurfacePacket.capabilityInvocationPresentation.executionState,
        "not_confirmed"
      );
      assert.ok(
        [
          "completed",
          "called",
          "called_with_failures",
          "failed",
          "denied",
          "blocked",
          "not_confirmed",
          "unavailable",
        ].includes(
          report.defaultRuntimePath.visibleMetaTheorySurfacePacket.capabilityInvocationPresentation
            .executionState,
        ),
      );
      assert.notEqual(
        report.defaultRuntimePath.visibleMetaTheorySurfacePacket.capabilityInvocationPresentation
          .executionState,
        "unavailable",
      );
      assert.match(
        report.defaultRuntimePath.visibleMetaTheorySurfacePacket.capabilityInvocationPresentation.userSummary,
        /当前聊天中的实际调用结果为准/,
      );
      assert.deepEqual(
        Object.keys(
          report.defaultRuntimePath.visibleMetaTheorySurfacePacket.capabilityInvocationPresentation,
        ).sort(),
        ["executionLabel", "executionState", "schemaVersion", "userSummary"],
      );
      assert.equal(
        Object.hasOwn(
          report.defaultRuntimePath.visibleMetaTheorySurfacePacket,
          "capabilityInvocationTruth",
        ),
        false,
      );
      assert.equal(
        Object.hasOwn(
          report.defaultRuntimePath.visibleMetaTheorySurfacePacket.capabilityInvocationPresentation,
          "rows",
        ),
        false,
      );
      assert.ok(report.capabilityInvocationTruthPacket.rows.length >= 1);
      assert.equal(
        report.capabilityInvocationTruthPacket,
        report.coreLoop.capabilityInvocationTruthPacket,
      );
      assert.equal(
        report.defaultRuntimePath.visibleMetaTheorySurfacePacket.dynamicWorkflow.status,
        report.defaultRuntimePath.dynamicWorkflowRuntimePacket.status
      );
      assert.equal(report.defaultRuntimePath.visibleMetaTheorySurfacePacket.peerAgentMesh.status, "pass");
      assert.equal(report.defaultRuntimePath.visibleMetaTheorySurfacePacket.langGraph.status, "pass");
      assert.ok(["pass", "partial"].includes(report.defaultRuntimePath.userPerceptionPacket.status));
      assert.deepEqual(
        report.defaultRuntimePath.productExperiencePacket.goals.map((goal) => goal.id),
        ["P-102", "P-103", "P-104"]
      );
      assert.deepEqual(
        report.defaultRuntimePath.productExperiencePacket.supportGates.map((gate) => gate.id),
        ["P-105", "P-106", "P-107", "P-108", "P-109", "P-110"]
      );
      assert.equal(report.defaultRuntimePath.productExperiencePacket.noOverclaimGate.status, "pass");
      assert.equal(
        report.defaultRuntimePath.productExperiencePacket.nativeChoiceSurfaceGate.liveRuntimeBoundary.status,
        "needs-host-invocation"
      );
      assert.equal(report.defaultRuntimePath.productExperiencePacket.nativeChoiceSurfaceGate.status, "partial");
      assert.equal(
        report.defaultRuntimePath.productExperiencePacket.repeatFailureDesignGate.actionOnSecondOccurrence,
        "bottom_design_failure_return_to_critical_fetch_thinking"
      );
      assert.equal(report.defaultRuntimePath.productExperiencePacket.generalizationGate.status, "pass");
      assert.equal(
        report.defaultRuntimePath.productExperiencePacket.capabilityInvocationTruthGate.status,
        "partial"
      );
      assert.equal(
        report.defaultRuntimePath.productExperiencePacket.agentTeamsPlaybookGate.status,
        "pass"
      );
      assert.equal(
        report.defaultRuntimePath.productExperiencePacket.automationDecisionBoundary.status,
        "pass"
      );
      assert.equal(
        report.defaultRuntimePath.productExperiencePacket.automationDecisionBoundary.decisionAuthority,
        "human_required"
      );
      assert.deepEqual(
        report.defaultRuntimePath.productExperiencePacket.automationDecisionBoundary.humanJudgmentStages,
        ["Critical", "Fetch", "Thinking", "Review"]
      );
      assert.ok(
        report.defaultRuntimePath.productExperiencePacket.automationDecisionBoundary.automationForbidden.includes(
          "route_selection_without_human_evidence"
        )
      );
      assert.equal(
        report.defaultRuntimePath.userPerceptionPacket.humanDecisionControl.automationRole,
        "assistive_only"
      );
      assert.equal(report.coreLoop.executionResult.actualWorkerExecution, false);
      assert.equal(report.coreLoop.traceEvalControlPlane.coverage.coverageStatus, "pass");
      assert.equal(report.coreLoop.agUiStageEvents.events.every((event) => event.packetDumpPrevented === true), true);
      assert.equal(report.coreLoop.performanceCostBudget.acceptance.externalPaidWorkRequiresApproval, true);
      assert.equal(report.coreLoop.contextEngineeringBudget.budgetRules.fixedVariableContextSeparated, true);
      assert.equal(
        report.coreLoop.executionResult.mergeResult.governanceResultsConsumed,
        true
      );
      assert.ok(
        report.coreLoop.executionResult.workerResultPackets.every(
          (packet) =>
            packet.status === "planned_not_executed" &&
            packet.workerExecutionEvidence.length === 1 &&
            packet.workerExecutionEvidence[0].status === "pending_execution" &&
            packet.workerExecutionEvidence[0].exitCode === undefined
        )
      );
      assert.equal(report.verificationPacket.verified, false);
      assert.equal(report.summaryPacket.verifyPassed, false);
      assert.ok(
        report.workerResultPackets.every(
          (packet) =>
            packet.status === "planned_not_executed" &&
            packet.fileCompletionList.every((item) => item.status === "skipped") &&
            packet.workerExecutionEvidence.every(
              (item) => item.status === "skipped" && item.exitCode === undefined,
            ),
        ),
      );
      assert.equal(
        report.coreLoop.reviewPacket.protocolCompliance.governanceAgentResultPacketsPresent,
        true
      );
      assert.equal(
        report.coreLoop.reviewPacket.protocolCompliance.conductorConsumptionEvidencePresent,
        true
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("T-002 records Claude, Codex, Cursor, and OpenClaw projection smoke evidence", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-runtime-smoke-"));
    try {
      const report = await runMetaTheoryGovernedExecution({
        task: multiGapTask,
        runId: "test-run-runtime-smoke",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
      });
      const runtimes = report.runtimeProjectionEvidence.results;

      assert.equal(report.runtimeProjectionEvidence.status, "pass");
      assert.deepEqual(
        runtimes.map((item) => item.runtime).sort(),
        ["claude", "codex", "cursor", "openclaw"]
      );
      for (const runtime of runtimes) {
        assert.equal(runtime.status, "smoke_pass", `${runtime.runtime} should pass smoke`);
        assert.equal(runtime.evidenceKind, "smoke");
        assert.equal(runtime.failureClass, "projection_only");
        assert.equal(runtime.naturalRoute, true);
        assert.ok(runtime.runtimeEntry, `${runtime.runtime} must record entry`);
        assert.ok(runtime.command, `${runtime.runtime} must record command`);
        assert.ok(runtime.remainingAction, `${runtime.runtime} must record remaining action`);
        assert.ok(runtime.orchestrationBoard, `${runtime.runtime} must bind board`);
        assert.equal(runtime.workerTaskPackets, 4);
        assert.equal(runtime.verificationOwner, "verify");
        assert.ok(runtime.runtimeDifference);
      }
      assert.equal(report.runtimeProjectionEvidence.releaseGrade, false);
      assert.equal(report.runtimeEvidencePacket.releaseGrade, false);
      assert.equal(report.runtimeEvidencePacket.failureClasses.cursor, "projection_only");
      assert.equal(
        report.runtimeEvidencePacket.records.filter(
          (item) => item.failureClass === "projection_only"
        ).length,
        4
      );
      assert.equal(report.analytics.runtimeEvidenceDistribution.length, 4);
      assert.deepEqual(
        report.analytics.runtimeEvidenceDistribution.map((item) => item.failureClass).sort(),
        ["projection_only", "projection_only", "projection_only", "projection_only"]
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("T-002a projection failure classification uses reason codes, not prose substrings", () => {
    const proseOnly = classifyProjectionFailure({
      status: "partial",
      unsupportedWithReason:
        "Cursor native live evidence still needs a future harness, but this row failed because a projection file is missing.",
    });
    assert.equal(proseOnly, "structural_failure");

    const structuredNative = classifyProjectionFailure({
      status: "partial",
      failureReasonCode: "native_harness_missing",
      unsupportedWithReason: "Missing native live-turn harness.",
    });
    assert.equal(structuredNative, "native_harness_missing");

    const smokeBoundary = classifyProjectionFailure({
      status: "smoke_pass",
      failureReasonCode: "projection_smoke_only",
      unsupportedWithReason:
        "Projection smoke is not native/live evidence; release-grade proof needs live evaluation.",
    });
    assert.equal(smokeBoundary, "projection_only");
  });

  test("T-002b uses canonical source projection only when runtime mirrors are absent", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-source-projection-"));
    const writeSource = async (relativePath, content) => {
      const target = path.join(tempDir, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    };
    try {
      const routeText =
        "meta-warden meta-conductor orchestration workerTaskPackets multi-type capability inventory meta-theory capability";
      await writeSource("canonical/skills/meta-theory/SKILL.md", routeText);
      await writeSource("canonical/agents/meta-conductor.md", routeText);
      await writeSource("canonical/runtime-assets/codex/commands/meta-theory.md", routeText);
      await writeSource("canonical/runtime-assets/cursor/rules/meta-enforcement.mdc", routeText);
      await writeSource("canonical/runtime-assets/openclaw/openclaw.template.json", routeText);

      const orchestrationReport = {
        orchestrationTaskBoardPacket: { dispatchBoardId: "source-projection-board" },
        workerTaskPackets: [{ taskPacketId: "source-projection-task" }],
      };
      const sourceOnly = await buildRuntimeProjectionEvidence({
        repoRoot: tempDir,
        orchestrationReport,
      });
      assert.equal(sourceOnly.status, "pass");
      assert.ok(
        sourceOnly.results.every(
          (item) =>
            item.status === "smoke_pass" &&
            item.evidenceSource === "canonical_source_projection" &&
            item.runtimeProjectionMaterialized === false
        )
      );

      await writeSource(".claude/skills/meta-theory/SKILL.md", "broken materialized projection");
      const materializedPartial = await buildRuntimeProjectionEvidence({
        repoRoot: tempDir,
        orchestrationReport,
      });
      const claude = materializedPartial.results.find((item) => item.runtime === "claude");
      assert.equal(materializedPartial.status, "partial");
      assert.equal(claude.status, "partial");
      assert.equal(claude.evidenceSource, "runtime_projection");
      assert.equal(claude.runtimeProjectionMaterialized, true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("T-003 distinguishes candidate_only from Warden approved writeback and can apply to a temp canonical root", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-writeback-"));
    try {
      const canonicalRoot = path.join(tempDir, "canonical");
      const candidateOnly = await runMetaTheoryGovernedExecution({
        task: "同一套 PRD review standard 需要 skill。",
        runId: "test-run-candidate-only",
        stateDir: path.join(tempDir, "candidate"),
        dbPath: path.join(tempDir, "candidate.sqlite"),
        canonicalRoot,
      });
      assert.equal(candidateOnly.wardenWritebackFlow.status, "candidate_only");
      assert.equal(candidateOnly.wardenWritebackFlow.approvalRequired, true);
      assert.equal(candidateOnly.wardenWritebackFlow.approvalValidation.ok, false);
      assert.ok(candidateOnly.wardenWritebackFlow.approvalRequest);
      assert.equal(candidateOnly.wardenWritebackFlow.dryRun.canonicalWrites, 0);
      assert.equal(candidateOnly.wardenWritebackFlow.candidates[0].writebackDecision, "candidate_only");
      assert.equal(candidateOnly.wardenWritebackFlow.candidates[0].applyStatus, "planned");
      assert.equal(candidateOnly.wardenWritebackFlow.candidates[0].dryRunArtifact.canonicalWrites, 0);
      assert.equal(candidateOnly.durableAgentLifecyclePacket.status, "partial");
      assert.equal(
        candidateOnly.durableAgentLifecyclePacket.stages.find(
          (stage) => stage.stage === "definition_candidate"
        ).status,
        "pass"
      );
      assert.equal(
        candidateOnly.durableAgentLifecyclePacket.stages.find(
          (stage) => stage.stage === "definition_writeback"
        ).status,
        "partial"
      );

      const approvalPacket = {
        schemaVersion: "warden-approval-v0.1",
        approvalId: "warden-approved-test-evidence",
        approver: "meta-warden",
        approvedAt: "2026-06-04T00:00:00.000Z",
        scope: "temp canonical writeback test",
        targets: [
          `canonical/${candidateOnly.wardenWritebackFlow.candidates[0].targetRelativeToCanonical}`,
        ],
        diffSummary: "Create one skill candidate in temp canonical root.",
        rollbackPlan: "Remove the generated temp canonical file.",
      };

      const approved = await runMetaTheoryGovernedExecution({
        task: "同一套 PRD review standard 需要 skill。",
        runId: "test-run-approved-writeback",
        stateDir: path.join(tempDir, "approved"),
        dbPath: path.join(tempDir, "approved.sqlite"),
        canonicalRoot,
        approvalPacket,
        applyWriteback: true,
      });
      const candidate = approved.wardenWritebackFlow.candidates[0];
      assert.equal(approved.wardenWritebackFlow.status, "approved-for-writeback");
      assert.equal(approved.wardenWritebackFlow.approvalValidation.ok, true);
      assert.equal(candidate.writebackDecision, "approved-for-writeback");
      assert.equal(candidate.applyStatus, "created");
      assert.equal(candidate.dryRunArtifact.canonicalWrites, 1);
      assert.equal(candidate.verificationResult.status, "pass");
      assert.match(candidate.diffSummary, /^Created /);
      assert.equal(approved.durableAgentLifecyclePacket.status, "partial");
      assert.equal(
        approved.durableAgentLifecyclePacket.stages.find(
          (stage) => stage.stage === "definition_writeback"
        ).status,
        "pass"
      );
      assert.equal(
        approved.durableAgentLifecyclePacket.stages.find(
          (stage) => stage.stage === "host_discovery_reload"
        ).status,
        "partial"
      );

      const targetPath = path.join(
        tempDir,
        "canonical",
        candidate.targetRelativeToCanonical
      );
      const written = await readFile(targetPath, "utf8");
      assert.match(written, /Generated by the Warden-approved Capability Gap writeback flow/);
      assert.match(written, /approvalEvidence: warden-approved-test-evidence/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("T-004 renders and reads a user-readable run report by runId", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-run-report-"));
    try {
      const report = await runMetaTheoryGovernedExecution({
        task: multiGapTask,
        runId: "test-run-readable-report",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
      });
      const readBack = await readGovernedExecutionRun({
        runId: report.runId,
        stateDir: tempDir,
      });

      assert.equal(readBack.artifact.runId, "test-run-readable-report");
      assert.equal(readBack.artifact.runReport.status, "partial");
      assert.equal(readBack.artifact.runReportPanelContract.status, "partial");
      assert.equal(
        readBack.artifact.runReportPanelContract.capabilityInvocationPresentation.executionState,
        "not_confirmed",
      );
      assert.deepEqual(
        Object.keys(
          readBack.artifact.runReportPanelContract.capabilityInvocationPresentation,
        ).sort(),
        ["executionLabel", "executionState", "schemaVersion", "userSummary"],
      );
      assert.equal(
        Object.hasOwn(readBack.artifact.runReportPanelContract, "capabilityInvocationTruth"),
        false,
      );
      assert.equal(
        Object.hasOwn(
          readBack.artifact.runReportPanelContract.visibleMetaTheorySurface,
          "capabilityInvocationTruth",
        ),
        false,
      );
      assert.equal(
        Object.hasOwn(
          readBack.artifact.runReportPanelContract.capabilityInvocationPresentation,
          "rows",
        ),
        false,
      );
      assert.equal(
        readBack.artifact.capabilityInvocationTruthPacket.callableInvocationCoverage.status,
        "not_run",
      );
      assert.ok(readBack.artifact.capabilityInvocationTruthPacket.rows.length >= 1);
      assert.equal(
        readBack.artifact.runReportPanelContract.schemaVersion,
        "run-report-panel-contract-v0.1"
      );
      assert.equal(
        readBack.artifact.runReportPanelContract.decisionSummary.runId,
        "test-run-readable-report"
      );
      assert.ok(
        readBack.artifact.runReportPanelContract.ownerHandoff.length > 0
      );
      assert.ok(
        readBack.artifact.runReportPanelContract.runtimeEvidence.length >= 4
      );
      assert.equal(
        readBack.artifact.runReportPanelContract.approvalRequest.dryRunCanonicalWrites,
        0
      );
      assert.deepEqual(
        readBack.artifact.runReportPanelContract.aiReadableRubric.map((item) => item.id),
        ["design", "execution", "acceptance", "feedback", "deliverables"]
      );
      assert.equal(
        readBack.artifact.runReportPanelContract.deliverables.panelContract,
        "artifact.runReportPanelContract"
      );
      for (const section of [
        "用户目标",
        "工作协调与调用情况",
        "阶段进展",
        "验证与下一步",
      ]) {
        assert.match(readBack.markdown, new RegExp(section));
      }
      assert.match(readBack.markdown, /调用记录/);
      assert.match(readBack.markdown, /协作情况/);
      assert.match(readBack.markdown, /工作流概览/);
      assert.doesNotMatch(readBack.markdown, /调用记录[^\n]*不可用/);
      const visibleChrome = readBack.markdown.slice(readBack.markdown.indexOf("## 用户目标"));
      assert.doesNotMatch(
        visibleChrome,
        /selected_not_invoked|capabilityInvocationTruthPacket\.rows|exact[_ -]?binding|live[_ -]?certification|provider|lane|精确(?:绑定|认证)|实时认证/i,
      );
      await stat(readBack.paths.json);
      await stat(readBack.paths.markdown);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("T-005 validates the three product goals and support gates", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/validate-product-experience-core-goals.mjs"],
      { encoding: "utf8", timeout: 120_000 }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, "pass");
    assert.equal(output.validationStatus, "pass");
    assert.equal(output.evidenceMode, "structural-boundary-plus-synthetic-negative-control");
    assert.equal(output.noPopupDuringSelfTest, true);
    assert.equal(output.defaultBoundaryRun.status, "partial");
    assert.equal(output.defaultBoundaryRun.evidenceTier, "structural_only");
    assert.deepEqual(output.defaultBoundaryRun.goals.map((goal) => goal.id), ["P-102", "P-103", "P-104"]);
    assert.deepEqual(output.defaultBoundaryRun.supportGates.map((gate) => gate.id), ["P-105", "P-106", "P-107", "P-108", "P-109", "P-110"]);
    assert.equal(output.defaultBoundaryRun.nativeChoiceSurface, "needs-host-invocation");
    assert.equal(output.syntheticNegativeControlRun.status, "partial");
    assert.equal(output.syntheticNegativeControlRun.productExperience, "partial");
    assert.equal(
      output.syntheticNegativeControlRun.capabilityInvocationTruth.realInvocationCoverage.status,
      "partial",
    );
    assert.equal(output.repeatFailureDesign, "bottom_design_failure_return_to_critical_fetch_thinking");
    assert.equal(output.generalizationGate, "pass");
    assert.ok(output.langGraph.nodes >= 8);
    assert.ok(output.langGraph.edges >= 7);
    assert.equal(output.dynamicWorkflow.skill, true);
    assert.equal(output.dynamicWorkflow.mcp, true);
    assert.equal(output.dynamicWorkflow.command, true);
    assert.equal(output.dynamicWorkflow.tools, false);
    assert.equal(output.dynamicWorkflow.hooks, true);
    assert.ok(output.peers > 0);
    assert.equal(output.defaultBoundaryRun.capabilityInvocationTruth.status, "partial");
    assert.equal(output.defaultBoundaryRun.capabilityInvocationTruth.states.invoked ?? 0, 0);
    assert.equal(output.defaultBoundaryRun.capabilityInvocationTruth.states.applied >= 1, true);
    assert.equal(output.defaultBoundaryRun.capabilityInvocationTruth.appVisibleSubagentState, "not_required");
    assert.equal(
      output.defaultBoundaryRun.capabilityInvocationTruth.callableInvocationCoverage.status,
      "pass",
    );
    assert.equal(
      output.defaultBoundaryRun.capabilityInvocationTruth.agentTeamsPlaybookState,
      "selected_not_invoked",
    );
    assert.equal(output.agentTeamsPlaybook.status, "pass");
    assert.equal(output.agentTeamsPlaybook.selected, true);
    assert.equal(output.defaultBoundaryRun.visibleMetaTheorySurface, "partial");
    assert.ok(output.userPerceptionCues >= 6);
  });

  test("T-005b binds product-build lanes by capabilityNeed instead of fixed agent-skill pairs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-product-build-dynamic-match-"));
    try {
      const report = await runMetaTheoryGovernedExecution({
        task: productExperienceTask,
        runId: "test-product-build-dynamic-match",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
      });
      const lanes = report.defaultRuntimePath.workerTaskPackets;
      const rows = report.coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingRows;
      const marketResearch = lanes.find(
        (packet) => packet.businessFlowLaneId === "market-research"
      );
      const capabilityTeamBlueprint =
        report.sourceArtifacts.orchestrationReport.selectedExecutionRoute.recommendedRoute
          .subjectiveUiCapabilityAmplification.capabilityTeamBlueprint;

      assert.equal(lanes.length, 11);
      assert.match(capabilityTeamBlueprint.inspiration, /agent-teams-playbook/);
      assert.equal(capabilityTeamBlueprint.rows.length, lanes.length);
      assert.equal(capabilityTeamBlueprint.rows.every((row) => row.capabilitySlot && row.providerBindingPolicy === "capability_need_runtime_match"), true);
      assert.equal(capabilityTeamBlueprint.capabilityResolutionPolicy.mode, "stop_on_first_qualified_provider");
      assert.equal(
        capabilityTeamBlueprint.capabilityResolutionPolicy.externalDiscoveryTrigger,
        "only_after_local_multi_provider_gap_is_proven",
      );
      assert.ok(
        capabilityTeamBlueprint.capabilityResolutionPolicy.forbidden.includes(
          "label_successful_native_agent_dispatch_as_fallback",
        ),
      );
      assert.equal(Object.hasOwn(capabilityTeamBlueprint, "fallbackChain"), false);
      assert.ok(
        lanes.every(
          (packet) =>
            Array.isArray(packet.capabilityNeed) &&
            packet.capabilityNeed.length > 0 &&
            packet.capabilitySelection?.selectionPolicy === "capability_need_runtime_match" &&
            packet.capabilitySelection?.candidateProviders.length > 0
        )
      );
      assert.ok(
        marketResearch.capabilityNeed.includes("capability-discovery-and-retrieval")
      );
      assert.ok(
        marketResearch.capabilitySelection.candidateProviders.some(
          (provider) => provider.id === "findskill"
        ),
        "findskill should be discovered as a capability-discovery candidate, not injected by user wording"
      );
      assert.ok(
        rows.every(
          (row) =>
            Array.isArray(row.capabilityNeed) &&
            row.capabilityNeed.length > 0 &&
            row.capabilitySelection?.selectionPolicy === "capability_need_runtime_match"
        )
      );
      assert.ok(
        rows.some((row) => row.capabilitySelection.selectedProvider?.id),
        "dynamic workflow rows should expose selected providers from capabilityNeed matching"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("T-005c content-shaped product work omits unrelated technical lanes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-product-build-content-lanes-"));
    try {
      const report = await runMetaTheoryGovernedExecution({
        task: contentOnlyProductTask,
        runId: "test-product-build-content-lanes",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
      });
      const lanes = report.defaultRuntimePath.workerTaskPackets;
      const selectedLaneIds = lanes.map((packet) => packet.businessFlowLaneId);
      const omittedLaneIds = report.coreLoop.thinkingPacket.omittedLanesWithReason ?? [];
      const omittedLaneRecords = report.coreLoop.thinkingPacket.omittedLaneRecords ?? [];
      const capabilityTeamBlueprint =
        report.sourceArtifacts.orchestrationReport.selectedExecutionRoute.recommendedRoute
          .subjectiveUiCapabilityAmplification.capabilityTeamBlueprint;

      assert.ok(selectedLaneIds.includes("product-definition"));
      assert.ok(selectedLaneIds.includes("content-strategy"));
      assert.ok(!selectedLaneIds.includes("backend-api"));
      assert.ok(!selectedLaneIds.includes("data-model"));
      assert.ok(!selectedLaneIds.includes("platform-integration"));
      assert.ok(omittedLaneIds.includes("backend-api"));
      assert.ok(omittedLaneIds.includes("data-model"));
      assert.ok(omittedLaneIds.includes("platform-integration"));
      assert.ok(
        omittedLaneRecords.some(
          (lane) => lane.laneId === "backend-api" && lane.reason && lane.evidenceRef,
        ),
      );
      assert.ok(lanes.length < 11, "content-only work should not inherit the full product-build template");
      assert.equal(capabilityTeamBlueprint.rows.length, lanes.length);
      assert.equal(capabilityTeamBlueprint.omittedCapabilitySlots.some((lane) => lane.laneId === "backend-api"), true);
      assert.notEqual(capabilityTeamBlueprint.scenario.scenario, 4);
      assert.ok(
        lanes.every(
          (packet) =>
            Array.isArray(packet.capabilityNeed) &&
            packet.capabilityNeed.length > 0 &&
            packet.capabilitySelection?.selectionPolicy === "capability_need_runtime_match"
        )
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("T-006 caller-trusted claims still need external observer evidence", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-host-evidence-no-native-"));
    try {
      const report = await runMetaTheoryGovernedExecution({
        task: productExperienceTask,
        runId: "test-run-host-evidence-no-native",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        invokeCapabilityProbes: true,
        hostInvocationEvidenceTrusted: true,
        hostInvocationEvidence: [
          {
            family: "agent_subagent",
            state: "invoked",
            providerId: "codex-reviewer",
            hostSurface: "spawn_agent",
            evidenceKind: "spawn_agent_result",
            evidenceRef: "agent:codex-reviewer:completed",
          },
          {
            family: "skill",
            state: "applied",
            providerId: "meta-theory",
            hostSurface: "skill",
            evidenceKind: "skill_application",
            evidenceRef: "skill:meta-theory:SKILL.md-read",
          },
          {
            family: "agent_teams_playbook",
            state: "invoked",
            providerId: "agent-teams-playbook",
            hostSurface: "spawn_agent",
            evidenceKind: "agent_team_result",
            evidenceRef: "agent-team:fanout:completed",
          },
        ],
      });

      assert.equal(report.status, "partial");
      assert.equal(report.coreLoop.hostInvocationRequestPacket.status, "partial");
      assert.equal(report.capabilityInvocationTruthPacket.status, "partial");
      assert.ok(
        report.coreLoop.runtimeInvocationPlanPacket.evidence.every(
          (item) => item.passEligible === false,
        ),
      );
      assert.equal(report.coreLoop.productExperiencePacket.nativeChoiceSurfaceGate.status, "partial");
      assert.equal(
        report.coreLoop.productExperiencePacket.nativeChoiceSurfaceGate.liveRuntimeBoundary.status,
        "needs-host-invocation",
      );
      assert.equal(report.coreLoop.productExperiencePacket.status, "partial");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("T-006b host-shaped fixtures plus native choice cannot promote product pass", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-host-evidence-pass-"));
    try {
      const report = await runMetaTheoryGovernedExecution({
        task: productExperienceTask,
        runId: "test-run-host-evidence-pass",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        invokeCapabilityProbes: true,
        hostInvocationEvidenceTrusted: true,
        hostInvocationEvidence: [
          {
            family: "agent_subagent",
            state: "invoked",
            providerId: "codex-reviewer",
            hostSurface: "spawn_agent",
            evidenceKind: "spawn_agent_result",
            evidenceRef: "agent:codex-reviewer:completed",
          },
          {
            family: "skill",
            state: "applied",
            providerId: "meta-theory",
            hostSurface: "skill",
            evidenceKind: "skill_application",
            evidenceRef: "skill:meta-theory:SKILL.md-read",
          },
          {
            family: "agent_teams_playbook",
            state: "invoked",
            providerId: "agent-teams-playbook",
            hostSurface: "spawn_agent",
            evidenceKind: "agent_team_result",
            evidenceRef: "agent-team:fanout:completed",
          },
        ],
        nativeChoiceEvidenceTrusted: true,
        nativeChoiceEvidence: trustedNativeChoiceEvidence,
      });

      assert.equal(report.status, "partial");
      assert.equal(report.coreLoop.runtimeInvocationPlanPacket.status, "partial");
      assert.equal(report.coreLoop.hostInvocationRequestPacket.status, "partial");
      assert.equal(report.capabilityInvocationTruthPacket.status, "partial");
      assert.equal(
        report.capabilityInvocationTruthPacket.realInvocationCoverage.status,
        "partial",
      );
      assert.equal(report.coreLoop.productExperiencePacket.nativeChoiceSurfaceGate.status, "partial");
      assert.equal(
        report.coreLoop.productExperiencePacket.nativeChoiceSurfaceGate.liveRuntimeBoundary.status,
        "needs-host-invocation",
      );
      assert.ok(
        report.capabilityInvocationTruthPacket.realInvocationCoverage.missingBindings.length > 0,
      );
      assert.equal(
        report.coreLoop.productExperiencePacket.automationDecisionBoundary.status,
        "pass",
      );
      assert.equal(
        report.coreLoop.productExperiencePacket.automationDecisionBoundary.decisionAuthority,
        "human_required",
      );
      assert.equal(report.coreLoop.productExperiencePacket.status, "partial");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("T-007 untrusted host invocation claims do not satisfy real invocation coverage", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-host-evidence-reject-"));
    try {
      const report = await runMetaTheoryGovernedExecution({
        task: multiGapTask,
        runId: "test-run-host-evidence-reject",
        stateDir: tempDir,
        dbPath: path.join(tempDir, "runs.sqlite"),
        invokeCapabilityProbes: true,
        hostInvocationEvidence: [
          {
            family: "agent_subagent",
            state: "invoked",
            providerId: "codex-reviewer",
            hostSurface: "spawn_agent",
            evidenceKind: "spawn_agent_result",
            evidenceRef: "agent:codex-reviewer:completed",
          },
          {
            family: "skill",
            state: "applied",
            providerId: "meta-theory",
            hostSurface: "skill",
            evidenceKind: "skill_application",
            evidenceRef: "skill:meta-theory:SKILL.md-read",
          },
          {
            family: "agent_teams_playbook",
            state: "invoked",
            providerId: "agent-teams-playbook",
            hostSurface: "spawn_agent",
            evidenceKind: "agent_team_result",
            evidenceRef: "agent-team:fanout:completed",
          },
        ],
      });

      assert.equal(report.status, "partial");
      assert.equal(report.coreLoop.runtimeInvocationPlanPacket.status, "partial");
      assert.equal(report.coreLoop.hostInvocationRequestPacket.status, "partial");
      assert.ok(
        report.coreLoop.hostInvocationRequestPacket.pendingFamilies.includes("agent_subagent")
      );
      assert.equal(report.capabilityInvocationTruthPacket.status, "partial");
      assert.equal(
        report.capabilityInvocationTruthPacket.realInvocationCoverage.status,
        "partial",
      );
      assert.ok(
        report.coreLoop.runtimeInvocationPlanPacket.evidence.every(
          (item) => item.passEligible === false,
        ),
      );
      assert.ok(
        report.coreLoop.runtimeInvocationPlanPacket.evidence.every(
          (item) => item.rejectionReason.includes("cannot promote itself"),
        ),
      );
      assert.ok(
        report.capabilityInvocationTruthPacket.realInvocationCoverage.missingFamilies.includes(
          "agent_subagent",
        ),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("CLI cannot self-authorize trusted host invocation evidence", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-host-evidence-cli-"));
    const hostInvocationEvidence = JSON.stringify([
      {
        family: "agent_subagent",
        state: "invoked",
        providerId: "codex-reviewer",
        hostSurface: "spawn_agent",
        evidenceKind: "spawn_agent_result",
        evidenceRef: "agent:codex-reviewer:completed",
      },
      {
        family: "skill",
        state: "applied",
        providerId: "meta-theory",
        hostSurface: "skill",
        evidenceKind: "skill_application",
        evidenceRef: "skill:meta-theory:SKILL.md-read",
      },
      {
        family: "agent_teams_playbook",
        state: "invoked",
        providerId: "agent-teams-playbook",
        hostSurface: "spawn_agent",
        evidenceKind: "agent_team_result",
        evidenceRef: "agent-team:fanout:completed",
      },
    ]);
    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--task",
          productExperienceTask,
          "--run-id",
          "test-run-cli-host-evidence",
          "--state-dir",
          tempDir,
          "--db",
          path.join(tempDir, "runs.sqlite"),
          "--invoke-capability-probes",
          "--host-invocation-evidence",
          hostInvocationEvidence,
          "--host-invocation-evidence-trusted",
          "--native-choice-evidence",
          JSON.stringify(trustedNativeChoiceEvidence),
          "--native-choice-evidence-trusted",
          "--strict-exit-code",
        ],
        { cwd: process.cwd(), encoding: "utf8", timeout: 180_000 },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Public CLI trust flags were removed/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("CLI accepts natural language task text and reports the runId", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-governed-cli-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--task",
          "同一套 PRD review standard 需要 skill。",
          "--run-id",
          "test-run-cli",
          "--state-dir",
          tempDir,
          "--db",
          path.join(tempDir, "runs.sqlite"),
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.status, "partial");
      assert.equal(summary.runId, "test-run-cli");
      assert.match(summary.report, /test-run-cli\.zh-CN\.md$/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("CLI accepts npm-style stripped positional arguments", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-governed-cli-positional-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "同一套 PRD review standard 需要 skill。",
          "test-run-cli-positional",
          tempDir,
          path.join(tempDir, "runs.sqlite"),
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.status, "partial");
      assert.equal(summary.runId, "test-run-cli-positional");
      assert.match(summary.report, /test-run-cli-positional\.zh-CN\.md$/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("CLI strict exit code preserves CI failure semantics for partial runs", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-governed-cli-strict-"));
    try {
      const result = spawnSync(
        process.execPath,
        [
          "scripts/run-meta-theory-governed-execution.mjs",
          "--task",
          "同一套 PRD review standard 需要 skill。",
          "--run-id",
          "test-run-cli-strict",
          "--state-dir",
          tempDir,
          "--db",
          path.join(tempDir, "runs.sqlite"),
          "--strict-exit-code",
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      assert.equal(result.status, 1, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.status, "partial");
      assert.equal(summary.runId, "test-run-cli-strict");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
