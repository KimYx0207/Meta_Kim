#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runMetaTheoryGovernedExecution } from "./run-meta-theory-governed-execution.mjs";

const MULTI_CAPABILITY_TASK = [
  "同一套 PRD review standard 需要 skill。",
  "长期 test coverage owner 需要 agent。",
  "release summary JSON 需要脚本。",
  "内部知识库需要 MCP provider 边界。"
].join("\n");

const REQUIRED_GOVERNANCE_AGENTS = [
  "meta-warden",
  "meta-conductor",
  "meta-scout",
  "meta-artisan",
  "meta-sentinel",
  "meta-librarian",
  "meta-prism",
  "meta-genesis",
  "meta-chrysalis"
];

const FORBIDDEN_EXECUTION_EVIDENCE_KINDS = new Set([
  "smoke",
  "projection_smoke",
  "config_only",
  "schema_only",
  "board_only"
]);

function assertPacketArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(value.length > 0, `${label} must not be empty`);
}

function validateGovernanceEvidence(report) {
  assertPacketArray(report.coreLoop.governanceAgentResultPackets, "coreLoop.governanceAgentResultPackets");
  assert.deepEqual(
    report.defaultRuntimePath.governanceAgentResultPackets.map((packet) => packet.packetId),
    report.coreLoop.governanceAgentResultPackets.map((packet) => packet.packetId),
    "defaultRuntimePath must expose the same governance packets as coreLoop"
  );

  const packetsByAgent = new Map(
    report.coreLoop.governanceAgentResultPackets.map((packet) => [packet.agent, packet])
  );
  for (const agent of REQUIRED_GOVERNANCE_AGENTS) {
    assert.ok(packetsByAgent.has(agent), `missing governance result packet for ${agent}`);
  }

  for (const packet of report.coreLoop.governanceAgentResultPackets) {
    assert.ok(packet.packetId, `${packet.agent} missing packetId`);
    assert.ok(packet.stage, `${packet.agent} missing stage`);
    assert.ok(packet.resultKind, `${packet.agent} missing resultKind`);
    assert.ok(packet.artifactRef, `${packet.agent} missing artifactRef`);
    assert.ok(packet.resultSummary, `${packet.agent} missing resultSummary`);
    assert.equal(packet.nativeRuntimeAgent, false, `${packet.agent} must not overclaim native runtime agent execution`);
    assert.equal(packet.externalAgentSpawned, false, `${packet.agent} must not overclaim external agent spawn`);
  }

  assert.equal(report.coreLoop.conductorConsumptionEvidence.status, "pass");
  assert.equal(report.defaultRuntimePath.conductorConsumptionEvidence.status, "pass");
  assert.ok(
    report.coreLoop.conductorConsumptionEvidence.consumedPacketRefs.length >= 5,
    "Conductor must consume multiple real governance packets before board synthesis"
  );
  assert.equal(
    report.coreLoop.executionResult.mergeResult.governanceResultsConsumed,
    true
  );
  assert.ok(
    report.coreLoop.thinkingPacket.governanceInputsConsumed.length >= 5,
    "Thinking must record consumed governance inputs"
  );
}

function validateWorkerExecutionEvidence(report) {
  assertPacketArray(report.coreLoop.executionResult.workerResultPackets, "workerResultPackets");
  assertPacketArray(report.coreLoop.executionResult.workerExecutionEvidence, "workerExecutionEvidence");
  assert.deepEqual(
    report.defaultRuntimePath.workerResultPackets.map((packet) => packet.taskPacketId),
    report.coreLoop.executionResult.workerResultPackets.map((packet) => packet.taskPacketId),
    "defaultRuntimePath must expose worker result packets"
  );
  assert.equal(
    report.coreLoop.executionResult.workerResultPackets.length,
    report.coreLoop.thinkingPacket.workerTaskPackets.length,
    "every worker task must have a worker result packet"
  );
  assert.equal(report.coreLoop.executionResult.actualWorkerExecution, false);
  assert.equal(report.coreLoop.executionResult.mergeResult.liveExecutionMerged, false);

  const taskById = new Map(
    report.coreLoop.thinkingPacket.workerTaskPackets.map((packet) => [packet.taskPacketId, packet])
  );
  for (const [index, resultPacket] of report.coreLoop.executionResult.workerResultPackets.entries()) {
    const taskPacket = taskById.get(resultPacket.taskPacketId);
    assert.ok(taskPacket, `worker result ${resultPacket.taskPacketId} must match a task packet`);
    assert.equal(resultPacket.status, "planned_not_executed");
    assert.equal(resultPacket.evidenceKind, "structural_worker_plan");
    assert.equal(resultPacket.output.externalWritePerformed, false);
    assertPacketArray(
      resultPacket.workerExecutionEvidence,
      `workerResultPackets[${index}].workerExecutionEvidence`
    );
    assert.equal(
      resultPacket.workerExecutionEvidence.length,
      taskPacket.verifySteps.length,
      "nested worker evidence must cover every verify step exactly once"
    );
    for (const evidence of resultPacket.workerExecutionEvidence) {
      assert.equal(evidence.status, "pending_execution");
      assert.equal(evidence.exitCode, undefined);
      assert.equal(evidence.commandRanAt, undefined);
      assert.ok(taskPacket.verifySteps.some((step) => step.id === evidence.verifyStepRef));
      assert.equal(evidence.evidenceKind, "structural_worker_plan");
    }
  }

  assert.equal(report.coreLoop.reviewPacket.protocolCompliance.workerTaskPacketsPresent, true);
  assert.equal(report.coreLoop.reviewPacket.protocolCompliance.governanceAgentResultPacketsPresent, true);
  assert.equal(report.coreLoop.reviewPacket.protocolCompliance.conductorConsumptionEvidencePresent, true);
  assert.equal(report.coreLoop.reviewPacket.protocolCompliance.executionEvidenceLayerIsHonest, true);
  assert.equal(report.coreLoop.verificationResult.workerEvidence.workerResultPackets, 4);
  assert.equal(report.coreLoop.verificationResult.workerEvidence.workerExecutionEvidence, 4);
  assert.equal(report.coreLoop.verificationResult.workerEvidence.nestedWorkerExecutionEvidence, 4);
  assert.equal(report.coreLoop.publicReadyDecision.publicReady, false);
}

function validateProductExperienceEvidence(report) {
  assert.equal(report.coreLoop.goalContractPacket.status, "pass");
  assert.equal(report.coreLoop.langGraphRunPacket.status, "pass");
  assert.equal(report.coreLoop.peerAgentMeshPacket.status, "pass");
  assert.equal(report.coreLoop.agentTeamsPlaybookPacket.status, "pass");
  assert.equal(report.coreLoop.agentTeamsPlaybookPacket.selected, false);
  assert.equal(
    report.coreLoop.agentTeamsPlaybookPacket.acceptance.optionalProviderDoesNotGateNativeFanout,
    true,
  );
  assert.equal(report.coreLoop.agentTeamsPlaybookPacket.fanoutSafetyPacket.safeForParallelFanout, true);
  assert.equal(report.coreLoop.agentTeamsPlaybookPacket.acceptance.independentLanesProven, true);
  assert.equal(report.coreLoop.agentTeamsPlaybookPacket.acceptance.parallelWaveExists, true);
  assert.equal(report.coreLoop.agentTeamsPlaybookPacket.acceptance.dagAndCollisionSafe, true);
  assert.equal(report.coreLoop.agentTeamsPlaybookPacket.acceptance.waveSizeWithinCap, true);
  assert.equal(report.coreLoop.agentTeamsPlaybookPacket.acceptance.waveSizeWithinRuntimeCapacity, true);
  assert.equal(report.coreLoop.agentTeamsPlaybookPacket.acceptance.noArbitraryMetaKimCap, true);
  assert.ok(report.coreLoop.agentTeamsPlaybookPacket.runtimeCapacity >= 2);
  assert.ok(report.coreLoop.agentTeamsPlaybookPacket.capacitySource);
  assert.ok(
    ["pass", "partial"].includes(report.coreLoop.capabilityInvocationTruthPacket.status)
  );
  assert.ok(["pass", "partial"].includes(report.coreLoop.visibleMetaTheorySurfacePacket.status));
  assert.ok(["pass", "partial"].includes(report.coreLoop.userPerceptionPacket.status));
  assert.equal(report.coreLoop.langGraphRunPacket.checkpoint.count, report.coreLoop.langGraphRunPacket.nodes.length);
  assert.ok(report.coreLoop.langGraphRunPacket.eventLog.length >= 8);
  assert.ok(report.coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage.hooks);
  assert.ok(report.coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage.abstractPromptCapability);
  assert.ok(report.coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage.workerResults);
  assert.ok(report.coreLoop.peerAgentMeshPacket.peers.length > 0);
  assert.equal(report.coreLoop.visibleMetaTheorySurfacePacket.capabilityInventory.notSkillOnly, true);
  assert.equal(
    Object.hasOwn(
      report.coreLoop.visibleMetaTheorySurfacePacket,
      "capabilityInvocationTruth",
    ),
    false,
  );
  assert.deepEqual(
    report.capabilityInvocationTruthPacket,
    report.coreLoop.capabilityInvocationTruthPacket,
  );
  assert.equal(
    report.coreLoop.visibleMetaTheorySurfacePacket.dynamicWorkflow.status,
    report.coreLoop.dynamicWorkflowRuntimePacket.status,
  );
  assert.equal(report.coreLoop.visibleMetaTheorySurfacePacket.peerAgentMesh.status, "pass");
  assert.equal(report.coreLoop.visibleMetaTheorySurfacePacket.langGraph.status, "pass");
  assert.ok(report.coreLoop.userPerceptionPacket.plainLanguageCues.length >= 6);
  assert.deepEqual(
    report.coreLoop.productExperiencePacket.goals.map((goal) => goal.id),
    ["P-102", "P-103", "P-104"]
  );
  assert.deepEqual(
    report.coreLoop.productExperiencePacket.supportGates.map((gate) => gate.id),
    ["P-105", "P-106", "P-107", "P-108", "P-109", "P-110"]
  );
  assert.equal(report.coreLoop.productExperiencePacket.noOverclaimGate.status, "pass");
  assert.equal(report.coreLoop.productExperiencePacket.nativeChoiceSurfaceGate.status, "partial");
  assert.equal(
    report.coreLoop.productExperiencePacket.nativeChoiceSurfaceGate.liveRuntimeBoundary.status,
    "needs-host-invocation"
  );
  assert.equal(
    report.coreLoop.productExperiencePacket.repeatFailureDesignGate.actionOnSecondOccurrence,
    "bottom_design_failure_return_to_critical_fetch_thinking"
  );
  assert.equal(report.coreLoop.productExperiencePacket.generalizationGate.status, "pass");
  assert.equal(report.coreLoop.productExperiencePacket.capabilityInvocationTruthGate.status, "partial");
  assert.equal(report.coreLoop.productExperiencePacket.agentTeamsPlaybookGate.status, "pass");
  const invocationByFamily = new Map(
    report.coreLoop.capabilityInvocationTruthPacket.rows.map((row) => [row.family, row])
  );
  assert.equal(report.coreLoop.runtimeSubagentInvocationPacket.status, "unavailable");
  assert.equal(invocationByFamily.get("agent_subagent").state, "unavailable");
  assert.equal(invocationByFamily.get("app_visible_subagent").state, "not_required");
  assert.equal(invocationByFamily.get("worker_task").state, "blocked");
  assert.equal(invocationByFamily.get("prompt_rule").state, "applied");
  assert.equal(invocationByFamily.get("agent_teams_playbook").state, "not_required");
  assert.equal(report.coreLoop.capabilityInvocationProbePacket.status, "not_run");
  assert.ok(
    ["selected_not_invoked", "discovered_not_selected", "not_required"].includes(
      invocationByFamily.get("mcp").state,
    ),
  );
  assert.equal(report.coreLoop.capabilityInvocationTruthPacket.truthAssertions.noLiveSubagentOverclaim, true);
  assert.equal(report.coreLoop.capabilityInvocationTruthPacket.truthAssertions.noHostUiSubagentOverclaim, true);
  assert.equal(report.coreLoop.capabilityInvocationTruthPacket.truthAssertions.noMcpCallOverclaim, true);
  assert.ok(
    ["product_experience_pass", "partial"].includes(report.coreLoop.productExperiencePacket.status),
    "default execution must expose product experience status without overclaiming"
  );
  assert.equal(
    report.coreLoop.dynamicWorkflowRuntimePacket.status,
    report.coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage.skill &&
      report.coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage.mcp &&
      report.coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage.command &&
      report.coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage.tools
      ? "pass"
      : "partial"
  );
  assert.equal(
    report.coreLoop.reviewPacket.protocolCompliance.productExperienceEvidencePresent,
    report.coreLoop.productExperiencePacket.status === "product_experience_pass"
  );
  assert.equal(
    report.coreLoop.verificationResult.productExperienceEvidence.acceptanceCommand,
    "npm run meta:prd:product-experience:validate"
  );
}

function validateDefaultCompletionStatus(report) {
  const allowedStatuses = new Set(["pass", "partial"]);
  assert.ok(
    allowedStatuses.has(report.status),
    `default governed execution status must be pass or honest partial, got ${report.status}`
  );
  assert.equal(
    report.defaultRuntimePath.status,
    report.status,
    "defaultRuntimePath.status must mirror the top-level governed execution status"
  );

  const realCoverage =
    report.coreLoop.capabilityInvocationTruthPacket.realInvocationCoverage;
  if (report.status === "pass") {
    assert.equal(realCoverage.status, "pass");
    assert.deepEqual(realCoverage.missingFamilies, []);
    return;
  }

  assert.equal(realCoverage.status, "partial");
  assert.ok(
    realCoverage.missingFamilies.length > 0,
    "partial default execution must name missing real invocation families"
  );
  assert.equal(report.coreLoop.hostInvocationRequestPacket.status, "partial");
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-default-evidence-"));
  try {
    const report = await runMetaTheoryGovernedExecution({
      task: MULTI_CAPABILITY_TASK,
      runId: "validate-default-governed-execution-evidence",
      stateDir: tempDir,
      dbPath: path.join(tempDir, "runs.sqlite")
    });

    validateDefaultCompletionStatus(report);
    validateGovernanceEvidence(report);
    validateWorkerExecutionEvidence(report);
    validateProductExperienceEvidence(report);

    process.stdout.write(
      `${JSON.stringify({
        status: report.status === "pass" ? "validated_pass" : "validated_partial",
        validationStatus: "pass",
        governedExecutionStatus: report.status,
        governanceAgentResultPackets: report.coreLoop.governanceAgentResultPackets.length,
        consumedGovernancePackets: report.coreLoop.conductorConsumptionEvidence.consumedPacketRefs.length,
        workerResultPackets: report.coreLoop.executionResult.workerResultPackets.length,
        workerExecutionEvidence: report.coreLoop.executionResult.workerExecutionEvidence.length,
        productExperience: report.coreLoop.productExperiencePacket.status
      }, null, 2)}\n`
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
