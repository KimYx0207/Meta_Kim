#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runMetaTheoryGovernedExecution } from "./run-meta-theory-governed-execution.mjs";

const PRODUCT_EXPERIENCE_TASK =
  "帮团队做一个内容工作台：成员能把零散素材整理成草稿，编辑审核后安排发布时间；失败时能看出原因并重试，不同成员权限不同。先完成可审查的方案和本地验证，不连接生产账号，也不要真实发布。";

const REQUIRED_GOAL_IDS = ["P-102", "P-103", "P-104"];
const REQUIRED_SUPPORT_GATE_IDS = ["P-105", "P-106", "P-107", "P-108", "P-109", "P-110"];
const REQUIRED_INVOCATION_FAMILIES = [
  "agent_subagent",
  "app_visible_subagent",
  "worker_task",
  "skill",
  "mcp",
  "hook",
  "prompt_rule",
  "command_script",
  "runtime_tool",
  "agent_teams_playbook",
];
const REQUIRED_BINDING_COVERAGE = [
  "skill",
  "mcp",
  "command",
  "hooks",
  "abstractPromptCapability",
  "agentTeamsPlaybook",
  "workerResults",
];

const SYNTHETIC_NEGATIVE_CONTROL = [
  {
    family: "agent_subagent",
    state: "invoked",
    providerId: "codex-reviewer",
    hostSurface: "spawn_agent",
    evidenceKind: "spawn_agent_result",
    evidenceRef: "self-test:spawn_agent_result:completed",
  },
  {
    family: "skill",
    state: "applied",
    providerId: "meta-theory",
    hostSurface: "skill",
    evidenceKind: "skill_application",
    evidenceRef: "self-test:skill_application:meta-theory",
  },
  {
    family: "agent_teams_playbook",
    state: "invoked",
    providerId: "agent-teams-playbook",
    hostSurface: "spawn_agent",
    evidenceKind: "agent_team_result",
    evidenceRef: "self-test:agent_team_result:fanout-completed",
  },
];

function assertPacketStatus(report) {
  assert.equal(report.coreLoop.goalContractPacket.status, "pass");
  assert.equal(report.coreLoop.langGraphRunPacket.status, "pass");
  assert.equal(report.coreLoop.dynamicWorkflowRuntimePacket.status, "partial");
  assert.equal(report.coreLoop.peerAgentMeshPacket.status, "pass");
  assert.equal(report.coreLoop.agentTeamsPlaybookPacket.status, "pass");
  assert.equal(report.capabilityInvocationTruthPacket.status, "partial");
  assert.equal(report.coreLoop.userPerceptionPacket.status, "partial");
  assert.equal(report.coreLoop.productExperiencePacket.status, "partial");
  assert.equal(report.productExperiencePacket.status, "partial");
}

function assertLangGraphStyle(report) {
  const packet = report.coreLoop.langGraphRunPacket;
  assert.ok(packet.nodes.length >= 8, "LangGraph-style run must have stage nodes");
  assert.ok(packet.edges.length >= 7, "LangGraph-style run must have edges");
  assert.ok(packet.conditionalEdges.length > 0, "dynamic/conditional edges must exist");
  assert.ok(packet.state.sharedStateFields.includes("workerResultPackets"));
  assert.ok(packet.stateTransition.length >= 8);
  assert.ok(packet.eventLog.length >= 8);
  assert.equal(packet.checkpoint.count, packet.nodes.length);
  assert.equal(packet.replay.supported, true);
  assert.equal(packet.evidenceKind, "langgraph_style_structural_pass");
  assert.equal(packet.runtimeDependency, "none");
  assert.equal(packet.runtimeExecutionEvidence, "not_claimed");
  assert.match(packet.runtimeBoundary, /does not claim execution by a LangGraph runtime/);
}

function assertDynamicWorkflow(report) {
  const packet = report.coreLoop.dynamicWorkflowRuntimePacket;
  for (const field of REQUIRED_BINDING_COVERAGE) {
    assert.equal(
      packet.capabilityBindingCoverage[field],
      true,
      `dynamic workflow missing ${field} coverage`,
    );
  }
  assert.equal(
    packet.capabilityBindingCoverage.tools,
    false,
    "offline product-experience validation must not manufacture executable runtime-tool evidence",
  );
  assert.ok(
    packet.capabilityBindingRows.every((row) => row.runtimeTools.length === 0),
    "offline product-experience validation must leave runtime tools unbound without current host evidence",
  );
  assert.ok(packet.capabilityBindingRows.length > 0);
  assert.ok(
    packet.capabilityBindingRows.some((row) => row.commands.length > 0),
    "commands must be bound",
  );
  assert.ok(
    packet.capabilityBindingRows.some((row) => row.mcp.length > 0),
    "MCP provider/tool must be bound",
  );
  assert.ok(
    packet.capabilityBindingRows.every((row) => row.hookMatches.length > 0),
    "hooks must be matched",
  );
  assert.ok(
    packet.capabilityBindingRows.every((row) => row.abstractPromptCapability.status),
    "abstract prompt capability must be recorded",
  );
}

function assertPeerMesh(report) {
  const packet = report.coreLoop.peerAgentMeshPacket;
  assert.ok(packet.peers.length > 0, "peer mesh must include peers");
  assert.ok(packet.handoffs.length >= packet.peers.length, "peer mesh must include handoffs");
  assert.equal(packet.acceptance.noGenericOwner, true);
  assert.equal(packet.acceptance.everyPeerHasResult, true);
  assert.equal(packet.acceptance.everyPeerHasMergeOwner, true);
}

function assertUserPerception(report) {
  const packet = report.coreLoop.userPerceptionPacket;
  const cues = packet.plainLanguageCues.map((cue) => cue.cue);
  for (const cue of [
    "要做什么",
    "正在做什么",
    "准备怎么做",
    "怎么算验收通过",
    "什么时候暂停",
    "编排和真实能力调用在哪里看",
    "谁做决策",
  ]) {
    assert.ok(cues.includes(cue), `missing user perception cue ${cue}`);
  }
  assert.equal(packet.humanDecisionControl.status, "pass");
  assert.equal(packet.humanDecisionControl.decisionAuthority, "human_required");
  assert.deepEqual(packet.humanDecisionControl.humanJudgmentStages, [
    "Critical",
    "Fetch",
    "Thinking",
    "Review",
  ]);
  assert.equal(packet.humanDecisionControl.automationRole, "assistive_only");
  assert.ok(
    packet.humanDecisionControl.automationForbidden.includes("claim public-ready"),
  );
  assert.ok(
    packet.surfaces.some(
      (surface) => surface.surface === "user_readable_run_report" && surface.status === "pass",
    ),
  );
  assert.equal(packet.antiPacketDump.packetDumpPrevented, true);
}

function assertVisibleMetaTheorySurface(report) {
  const packet = report.coreLoop.visibleMetaTheorySurfacePacket;
  assert.equal(packet.status, "partial");
  assert.ok(packet.requiredVisibleTopics.includes("orchestration"));
  assert.ok(packet.requiredVisibleTopics.includes("dynamic_workflow"));
  assert.ok(packet.requiredVisibleTopics.includes("capability_inventory_not_skill_only"));
  assert.ok(packet.requiredVisibleTopics.includes("capability_invocation_presentation"));
  assert.ok(packet.requiredVisibleTopics.includes("agent_teams_playbook"));
  assert.ok(packet.requiredVisibleTopics.includes("peer_agent_mesh"));
  assert.ok(packet.requiredVisibleTopics.includes("langgraph_style_control_graph"));
  assert.equal(packet.capabilityInventory.notSkillOnly, true);
  assert.ok(packet.capabilityInventory.nonSkillCapabilityTypeCount > 0);
  assert.equal(packet.dynamicWorkflow.status, "partial");
  assert.ok(packet.dynamicWorkflow.visibleRows.length > 0);
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
      packet.capabilityInvocationPresentation.executionState,
    ),
  );
  assert.equal(packet.capabilityInvocationPresentation.executionState, "not_confirmed");
  assert.match(packet.capabilityInvocationPresentation.userSummary, /当前聊天中的实际调用结果为准/);
  assert.deepEqual(
    Object.keys(packet.capabilityInvocationPresentation).sort(),
    ["executionLabel", "executionState", "schemaVersion", "userSummary"],
  );
  assert.doesNotMatch(
    packet.capabilityInvocationPresentation.userSummary,
    /exact[_ -]?binding|live[_ -]?certification|provider|lane|精确(?:绑定|认证)|实时认证/i,
  );
  assert.equal(Object.hasOwn(packet, "capabilityInvocationTruth"), false);
  assert.equal(Object.hasOwn(packet.capabilityInvocationPresentation, "rows"), false);
  assert.equal(packet.agentTeamsPlaybook.status, "pass");
  assert.equal(packet.agentTeamsPlaybook.selected, true);
  assert.ok(packet.agentTeamsPlaybook.waveCount >= 1);
  assert.equal(packet.peerAgentMesh.status, "pass");
  assert.ok(packet.peerAgentMesh.peerCount > 0);
  assert.equal(packet.langGraph.status, "pass");
  assert.ok(packet.langGraph.nodeCount >= 8);
  assert.ok(packet.langGraph.edgeCount >= 7);
  assert.ok(packet.langGraph.checkpointCount >= 8);
  const panelSurface = report.runReportPanelContract.visibleMetaTheorySurface;
  assert.equal(panelSurface.status, "partial");
  assert.equal(Object.hasOwn(panelSurface, "capabilityInvocationTruth"), false);
  assert.deepEqual(
    Object.keys(panelSurface.capabilityInvocationPresentation).sort(),
    ["executionLabel", "executionState", "schemaVersion", "userSummary"],
  );
}

function assertFailurePresentationSemantics(report) {
  const strictPresentation = report.capabilityInvocationPresentationPacket;
  const visiblePresentation = report.visibleMetaTheorySurfacePacket.capabilityInvocationPresentation;
  const failureDisposition = strictPresentation.failureDisposition;
  if (failureDisposition) {
    assert.ok(["failed", "denied", "blocked"].includes(failureDisposition));
    assert.equal(visiblePresentation.executionState, failureDisposition);
    assert.notEqual(visiblePresentation.executionState, "unavailable");
  }
  if (visiblePresentation.executionState === "unavailable") {
    assert.equal(failureDisposition, null);
    assert.equal(
      report.runtimeSubagentInvocationPacket.availabilityDisposition,
      "genuinely_unavailable",
    );
    assert.equal(strictPresentation.evidenceBoundary.successfulBindingCount, 0);
    assert.equal(strictPresentation.evidenceBoundary.verifiedFailedBindingCount, 0);
  }
}

function assertCapabilityInvocationTruth(report) {
  const packet = report.capabilityInvocationTruthPacket;
  assert.equal(report.coreLoop.capabilityInvocationTruthPacket, packet);
  assert.equal(packet.status, "partial");
  for (const state of [
    "invoked",
    "applied",
    "host_visible_observed",
    "selected_not_invoked",
    "discovered_not_selected",
    "unavailable",
    "not_authorized",
    "blocked",
    "not_required",
  ]) {
    assert.ok(packet.stateTaxonomy.includes(state), `missing invocation state ${state}`);
  }
  const byFamily = new Map(packet.rows.map((row) => [row.family, row]));
  for (const family of REQUIRED_INVOCATION_FAMILIES) {
    assert.ok(byFamily.has(family), `missing invocation family ${family}`);
  }
  assert.equal(report.coreLoop.runtimeSubagentInvocationPacket.status, "unavailable");
  assert.equal(byFamily.get("agent_subagent").state, "unavailable");
  assert.equal(byFamily.get("app_visible_subagent").state, "not_required");
  assert.equal(byFamily.get("worker_task").state, "blocked");
  assert.equal(byFamily.get("mcp").state, "selected_not_invoked");
  assert.equal(byFamily.get("hook").state, "selected_not_invoked");
  assert.equal(byFamily.get("skill").state, "selected_not_invoked");
  assert.equal(byFamily.get("prompt_rule").state, "applied");
  assert.equal(byFamily.get("command_script").state, "selected_not_invoked");
  assert.equal(byFamily.get("runtime_tool").state, "not_required");
  assert.equal(byFamily.get("agent_teams_playbook").state, "selected_not_invoked");
  assert.equal(packet.realInvocationCoverage.status, "partial");
  for (const family of [
    "agent_subagent",
    "agent_teams_playbook",
    "skill",
    "mcp",
    "hook",
    "command_script",
  ]) {
    assert.ok(packet.realInvocationCoverage.missingFamilies.includes(family));
  }
  assert.ok(packet.realInvocationCoverage.missingBindings.length > 0);
  assert.deepEqual(packet.callableInvocationCoverage.missingFamilies, []);
  assert.ok(packet.callableInvocationCoverage.callableFamilies.includes("mcp"));
  assert.ok(packet.callableInvocationCoverage.callableFamilies.includes("command_script"));
  assert.equal(
    packet.callableInvocationCoverage.callableFamilies.includes("runtime_tool"),
    false,
  );
  assert.equal(packet.truthAssertions.noLiveSubagentOverclaim, true);
  assert.equal(packet.truthAssertions.noHostUiSubagentOverclaim, true);
  assert.equal(packet.truthAssertions.noAgentTeamsPlaybookOverclaim, true);
  assert.equal(packet.truthAssertions.noMcpCallOverclaim, true);
  assert.equal(packet.truthAssertions.noCommandCallOverclaim, true);
  assert.equal(packet.truthAssertions.noRuntimeToolOverclaim, true);
  assert.equal(packet.truthAssertions.noHookTriggerOverclaim, true);
  assert.equal(packet.truthAssertions.selectedIsNotInvoked, true);
  assert.equal(packet.truthAssertions.appliedIsNotInvoked, true);
  assert.equal(packet.truthAssertions.hostVisibleIsNotInvoked, true);
  assert.ok(byFamily.get("agent_subagent").mustNotClaimAs.includes("live_subagent_invocation"));
  assert.ok(
    byFamily
      .get("app_visible_subagent")
      .mustNotClaimAs.includes("runner_agent_subagent_invocation"),
  );
  assert.ok(byFamily.get("hook").mustNotClaimAs.includes("hook_triggered"));
  assert.ok(
    byFamily
      .get("agent_teams_playbook")
      .mustNotClaimAs.includes("live_agent_team_created"),
  );
  assert.equal(packet.rows.length >= REQUIRED_INVOCATION_FAMILIES.length, true);
  assert.equal(report.capabilityInvocationTruthPacket, packet);
  assert.equal(Object.hasOwn(report.runReportPanelContract, "capabilityInvocationTruth"), false);
  assert.equal(
    report.runReportPanelContract.capabilityInvocationPresentation.executionState,
    "not_confirmed",
  );
  assert.deepEqual(
    Object.keys(report.runReportPanelContract.capabilityInvocationPresentation).sort(),
    ["executionLabel", "executionState", "schemaVersion", "userSummary"],
  );
}

function assertInvocationProbes(report) {
  const packet = report.coreLoop.capabilityInvocationProbePacket;
  assert.equal(packet.status, "pass");
  assert.deepEqual(packet.missingFamilies, []);
  assert.deepEqual(packet.requiredFamilies, ["mcp", "command_script"]);
  const byFamily = new Map(packet.probes.map((probe) => [probe.family, probe]));
  for (const family of ["mcp", "command_script"]) {
    assert.equal(byFamily.get(family)?.status, "pass", `${family} probe did not pass`);
    assert.equal(byFamily.get(family)?.exitCode, 0, `${family} probe exitCode was not 0`);
  }
  assert.equal(
    byFamily.has("runtime_tool"),
    false,
    "offline product-experience validation must not probe an unbound runtime tool",
  );
}

function assertAgentTeamsPlaybook(report) {
  const packet = report.coreLoop.agentTeamsPlaybookPacket;
  assert.equal(packet.status, "pass");
  assert.equal(packet.triggered, true);
  assert.equal(packet.providerId, "agent-teams-playbook");
  assert.ok(packet.executableLaneCount >= 2);
  assert.ok(packet.waves.length >= 1);
  assert.equal(packet.fanoutSafetyPacket.safeForParallelFanout, true);
  assert.equal(packet.acceptance.orchestrationReadyWhenParallelLanes, true);
  assert.equal(packet.acceptance.independentLanesProven, true);
  assert.equal(packet.acceptance.parallelWaveExists, true);
  assert.equal(packet.acceptance.dagAndCollisionSafe, true);
  assert.equal(packet.acceptance.waveSizeWithinCap, true);
  assert.equal(packet.acceptance.waveSizeWithinRuntimeCapacity, true);
  assert.equal(packet.acceptance.noArbitraryMetaKimCap, true);
  assert.ok(packet.runtimeCapacity >= 2);
  assert.ok(packet.capacitySource);
  assert.equal(packet.acceptance.workerPacketsPreserved, true);
  assert.equal(packet.acceptance.noLiveSubagentOverclaim, true);
  assert.equal(
    packet.selected || packet.acceptance.optionalProviderDoesNotGateNativeFanout,
    true,
    "native stage-DAG fan-out must pass whether the optional playbook is selected or not",
  );
}

async function assertReadableReportShowsVisibleSurface(report) {
  const markdown = await readFile(report.paths.markdown, "utf8");
  const visibleChrome = markdown.slice(markdown.indexOf("## 用户目标"));
  for (const marker of [
    "## 用户目标",
    "## 工作协调与调用情况",
    "调用记录",
    "协作情况",
    "工作流概览",
    "## 阶段进展",
    "Critical",
    "Fetch",
    "Thinking",
    "Execution",
    "Review",
    "Verification",
    "Evolution",
    "## 验证与下一步",
  ]) {
    assert.match(markdown, new RegExp(marker), `readable report missing ${marker}`);
  }
  assert.doesNotMatch(
    visibleChrome,
    /调用记录[^\n]*不可用/,
    "a user-visible provider summary must not say unavailable when invocation is only awaiting evidence linkage",
  );
  assert.doesNotMatch(
    visibleChrome,
    /selected_not_invoked|capabilityInvocationTruthPacket\.rows|exact[_ -]?binding|live[_ -]?certification|provider|lane|精确(?:绑定|认证)|实时认证/i,
  );
}

function assertProductExperience(report) {
  const packet = report.coreLoop.productExperiencePacket;
  assert.deepEqual(packet.coreGoalIds, REQUIRED_GOAL_IDS);
  assert.deepEqual(packet.supportGateIds, REQUIRED_SUPPORT_GATE_IDS);
  assert.deepEqual(
    packet.goals.map((goal) => goal.id),
    REQUIRED_GOAL_IDS,
  );
  const goalById = new Map(packet.goals.map((goal) => [goal.id, goal]));
  assert.equal(goalById.get("P-102").status, "pass");
  assert.equal(goalById.get("P-103").status, "partial");
  assert.equal(goalById.get("P-104").status, "partial");
  assert.deepEqual(
    packet.supportGates.map((gate) => gate.id),
    REQUIRED_SUPPORT_GATE_IDS,
  );
  const supportGateById = new Map(packet.supportGates.map((gate) => [gate.id, gate]));
  assert.equal(supportGateById.get("P-105").status, "pass");
  assert.equal(supportGateById.get("P-106").status, "partial");
  assert.equal(supportGateById.get("P-107").status, "pass");
  assert.equal(supportGateById.get("P-108").status, "pass");
  assert.equal(supportGateById.get("P-109").status, "partial");
  assert.equal(supportGateById.get("P-110").status, "pass");
  assert.equal(packet.noOverclaimGate.status, "pass");
  assert.equal(packet.noOverclaimGate.acceptedEvidenceTier, "live_host_observed");
  assert.ok(packet.noOverclaimGate.forbiddenAsProductPass.includes("chat_card_as_native_popup"));
  assert.ok(packet.noOverclaimGate.forbiddenAsProductPass.includes("demo_fixture_as_framework_goal"));
  assert.ok(packet.noOverclaimGate.forbiddenAsProductPass.includes("hidden orchestration artifacts"));
  assert.ok(packet.noOverclaimGate.forbiddenAsProductPass.includes("selected_capability_as_invoked_tool"));
  assert.ok(packet.noOverclaimGate.forbiddenAsProductPass.includes("configured_mcp_as_called_tool"));
  assert.ok(packet.noOverclaimGate.forbiddenAsProductPass.includes("run_scoped_worker_as_live_subagent"));
  assert.ok(
    packet.noOverclaimGate.forbiddenAsProductPass.includes(
      "agent_teams_playbook_selected_as_live_agent_team",
    ),
  );
  assert.equal(packet.nativeChoiceSurfaceGate.status, "partial");
  assert.equal(
    packet.nativeChoiceSurfaceGate.liveRuntimeBoundary.status,
    "needs-host-invocation",
  );
  assert.equal(packet.nativeChoiceSurfaceGate.liveRuntimeBoundary.requiredForNativePass, true);
  assert.ok(
    packet.nativeChoiceSurfaceGate.forbiddenSubstitutes.includes("after-the-fact user insertion"),
    "native choice gate must reject after-the-fact insertion as popup evidence",
  );
  assert.equal(
    packet.repeatFailureDesignGate.actionOnSecondOccurrence,
    "bottom_design_failure_return_to_critical_fetch_thinking",
  );
  assert.equal(packet.repeatFailureDesignGate.sameFailureOccurrenceThreshold, 2);
  assert.ok(
    packet.repeatFailureDesignGate.trackedFailureClasses.includes(
      "native_choice_surface_missing_before_execution",
    ),
  );
  assert.equal(packet.generalizationGate.status, "pass");
  assert.equal(packet.capabilityInvocationTruthGate.status, "partial");
  assert.equal(packet.agentTeamsPlaybookGate.status, "pass");
  assert.equal(packet.automationDecisionBoundary.status, "pass");
  assert.equal(packet.automationDecisionBoundary.decisionAuthority, "human_required");
  assert.deepEqual(packet.automationDecisionBoundary.humanJudgmentStages, [
    "Critical",
    "Fetch",
    "Thinking",
    "Review",
  ]);
  assert.equal(packet.automationDecisionBoundary.automationRole, "assistive_only");
  assert.ok(
    packet.automationDecisionBoundary.automationForbidden.includes(
      "route_selection_without_human_evidence",
    ),
  );
  assert.ok(
    packet.automationDecisionBoundary.automationForbidden.includes(
      "review_judgment_replacement",
    ),
  );
  assert.ok(
    packet.capabilityInvocationTruthGate.forbiddenRelabels.includes(
      "selected_not_invoked_as_invoked",
    ),
  );
  assert.deepEqual(packet.generalizationGate.detectedForbiddenBindings, []);
  assert.ok(
    packet.generalizationGate.forbiddenFixtureBindings.includes("桌面便签"),
    "fixture non-hardcoding gate must include the desktop sticky-notes fixture class",
  );
  assert.match(packet.nativeRuntimeBoundary, /does not claim Claude Code\/Codex native live UI/);
  assert.match(report.runReportPanelContract.productExperience.status, /partial/);
  assert.equal(report.runReportPanelContract.productExperience.supportGates.length, 6);
  assert.equal(report.runReportPanelContract.productExperience.agentTeamsPlaybookGate.status, "pass");
}

function assertMcpSelfTest() {
  const result = spawnSync(
    process.execPath,
    ["scripts/mcp/meta-runtime-server.mjs", "--self-test"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.tools.includes("get_meta_runtime_capabilities"));
  return parsed;
}

function summarizeReport(report) {
  const invocationTruth = report.capabilityInvocationTruthPacket;
  return {
    status: report.status,
    evidenceTier: report.coreLoop.productExperiencePacket.evidenceTier,
    goals: report.coreLoop.productExperiencePacket.goals.map((goal) => ({
      id: goal.id,
      status: goal.status,
    })),
    supportGates: report.coreLoop.productExperiencePacket.supportGates.map((gate) => ({
      id: gate.id,
      status: gate.status,
    })),
    nativeChoiceSurface:
      report.coreLoop.productExperiencePacket.nativeChoiceSurfaceGate.liveRuntimeBoundary.status,
    productExperience: report.coreLoop.productExperiencePacket.status,
    visibleMetaTheorySurface: report.coreLoop.visibleMetaTheorySurfacePacket.status,
    capabilityInvocationTruth: {
      status: invocationTruth.status,
      states: invocationTruth.stateCounts,
      callableInvocationCoverage: invocationTruth.callableInvocationCoverage,
      realInvocationCoverage: {
        status: invocationTruth.realInvocationCoverage.status,
        requiredFamilies: invocationTruth.realInvocationCoverage.requiredFamilies,
        invokedFamilies: invocationTruth.realInvocationCoverage.invokedFamilies,
        missingFamilies: invocationTruth.realInvocationCoverage.missingFamilies,
        requiredBindingCount: invocationTruth.realInvocationCoverage.requiredBindings.length,
        invokedBindingCount: invocationTruth.realInvocationCoverage.invokedBindings.length,
        missingBindingCount: invocationTruth.realInvocationCoverage.missingBindings.length,
        hostEvidenceCount: invocationTruth.realInvocationCoverage.hostEvidenceCount,
        rejectedEvidenceCount: invocationTruth.realInvocationCoverage.rejectedEvidenceCount,
      },
      appVisibleSubagentState:
        invocationTruth.rows.find(
          (row) => row.family === "app_visible_subagent",
        )?.state ?? "missing",
      agentTeamsPlaybookState:
        invocationTruth.rows.find(
          (row) => row.family === "agent_teams_playbook",
        )?.state ?? "missing",
    },
  };
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-product-experience-"));
  try {
    const report = await runMetaTheoryGovernedExecution({
      task: PRODUCT_EXPERIENCE_TASK,
      runId: "validate-product-experience-core-goals",
      stateDir: tempDir,
      dbPath: path.join(tempDir, "runs.sqlite"),
      emitConversationNotice: true,
      invokeCapabilityProbes: true,
    });
    assert.equal(report.status, "partial");
    assertPacketStatus(report);
    assertLangGraphStyle(report);
    assertDynamicWorkflow(report);
    assertPeerMesh(report);
    assertInvocationProbes(report);
    assertCapabilityInvocationTruth(report);
    assertAgentTeamsPlaybook(report);
    assertVisibleMetaTheorySurface(report);
    assertFailurePresentationSemantics(report);
    assertUserPerception(report);
    assertProductExperience(report);
    await assertReadableReportShowsVisibleSurface(report);

    const negativeControlReport = await runMetaTheoryGovernedExecution({
      task: PRODUCT_EXPERIENCE_TASK,
      runId: "validate-product-experience-synthetic-negative-control",
      stateDir: tempDir,
      dbPath: path.join(tempDir, "runs.sqlite"),
      emitConversationNotice: false,
      invokeCapabilityProbes: true,
      hostInvocationEvidenceTrusted: true,
      hostInvocationEvidence: SYNTHETIC_NEGATIVE_CONTROL,
    });
    assert.equal(negativeControlReport.status, "partial");
    assert.equal(
      negativeControlReport.coreLoop.productExperiencePacket.status,
      "partial",
    );
    assert.ok(
      negativeControlReport.coreLoop.runtimeInvocationPlanPacket.evidence.every(
        (item) => item.passEligible === false,
      ),
    );
    assert.equal(
      negativeControlReport.capabilityInvocationTruthPacket.realInvocationCoverage.status,
      "partial",
    );

    const mcp = assertMcpSelfTest();
    process.stdout.write(
      `${JSON.stringify(
        {
          status: "pass",
          validationStatus: "pass",
          evidenceMode: "structural-boundary-plus-synthetic-negative-control",
          defaultBoundaryRun: summarizeReport(report),
          syntheticNegativeControlRun: summarizeReport(negativeControlReport),
          noPopupDuringSelfTest: true,
          selfTestEvidenceBoundary:
            "Synthetic/self-test evidence is deliberately rejected. This command validates structural boundaries only and never claims a live host orchestration pass.",
          repeatFailureDesign:
            report.coreLoop.productExperiencePacket.repeatFailureDesignGate.actionOnSecondOccurrence,
          generalizationGate: report.coreLoop.productExperiencePacket.generalizationGate.status,
          langGraph: {
            nodes: report.coreLoop.langGraphRunPacket.nodes.length,
            edges: report.coreLoop.langGraphRunPacket.edges.length,
            checkpoints: report.coreLoop.langGraphRunPacket.checkpoint.count,
          },
          dynamicWorkflow: report.coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage,
          peers: report.coreLoop.peerAgentMeshPacket.peers.length,
          agentTeamsPlaybook: {
            status: report.coreLoop.agentTeamsPlaybookPacket.status,
            selected: report.coreLoop.agentTeamsPlaybookPacket.selected,
            waves: report.coreLoop.agentTeamsPlaybookPacket.waves.length,
          },
          automationDecisionBoundary:
            report.coreLoop.productExperiencePacket.automationDecisionBoundary,
          userPerceptionCues: report.coreLoop.userPerceptionPacket.plainLanguageCues.length,
          mcpTools: mcp.tools,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
