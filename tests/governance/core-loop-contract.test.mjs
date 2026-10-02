import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";

let runtimeFixture;
before(() => {
  runtimeFixture = createGovernanceRuntimeFixture(null, { graph: true });
});
after(() => runtimeFixture?.cleanup());

const CORE_LOOP = JSON.parse(readFileSync("config/contracts/core-loop-contract.json", "utf8"));

const EXPECTED_STAGES = [
  "Critical",
  "Fetch",
  "Thinking",
  "Execution",
  "Review",
  "Meta-Review",
  "Verification",
  "Evolution",
];

function getPath(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], value);
}

test("core-loop contract binds the default governed execution path", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

  assert.equal(CORE_LOOP.contractId, "meta-kim-core-loop-contract");
  assert.equal(CORE_LOOP.defaultEntry.contractIsDefaultPath, true);
  assert.equal(
    CORE_LOOP.defaultEntry.entryScript,
    "scripts/run-meta-theory-governed-execution.mjs",
  );
  assert.equal(CORE_LOOP.defaultEntry.packageScript, "meta:theory:run");
  assert.equal(
    packageJson.scripts["meta:theory:run"],
    "node scripts/run-meta-theory-governed-execution.mjs --emit-conversation-notice",
  );
  assert.equal(
    packageJson.scripts["meta:theory:run:notice"],
    packageJson.scripts["meta:theory:run"],
  );
  assert.equal(
    packageJson.scripts["meta:theory:run:json"],
    "node scripts/run-meta-theory-governed-execution.mjs --no-emit-conversation-notice",
  );
  assert.deepEqual(
    CORE_LOOP.stages.map((stage) => stage.stage),
    EXPECTED_STAGES,
  );
});

test("default CLI keeps stdout machine-readable while progress uses stderr", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-cli-streams-"));
  try {
    const visible = runtimeFixture.run(
      [
        "scripts/run-meta-theory-governed-execution.mjs",
        "--emit-conversation-notice",
        "--task",
        "Build and review a configurable workflow",
        "--run-id",
        "stream-routing-visible",
        "--output-language",
        "en",
        "--state-dir",
        tempDir,
        "--db",
        path.join(tempDir, "visible.sqlite"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(visible.status, 0, visible.stderr);
    const visibleSummary = JSON.parse(visible.stdout);
    assert.equal(visibleSummary.runId, "stream-routing-visible");
    for (const marker of ["[Critical]", "[Fetch]", "[Thinking]", "[Execution]", "[Review]", "[Closure]"]) {
      assert.equal(visible.stderr.includes(marker), true, `missing stderr progress marker ${marker}`);
    }

    const machine = runtimeFixture.run(
      [
        "scripts/run-meta-theory-governed-execution.mjs",
        "--no-emit-conversation-notice",
        "--task",
        "Build a machine-readable workflow summary",
        "--run-id",
        "stream-routing-json",
        "--output-language",
        "en",
        "--state-dir",
        tempDir,
        "--db",
        path.join(tempDir, "json.sqlite"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(machine.status, 0, machine.stderr);
    assert.equal(JSON.parse(machine.stdout).runId, "stream-routing-json");
    assert.doesNotMatch(machine.stderr, /\[(?:Critical|Fetch|Thinking|Execution|Review|Closure)\]/u);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("core-loop stages have IO, skip, gate, and blocking policy", () => {
  for (const stage of CORE_LOOP.stages) {
    for (const field of [
      "requiredInputs",
      "requiredOutputs",
      "skipConditions",
      "gateConditions",
      "blockingGates",
      "warningGates",
      "defaultOwner",
    ]) {
      assert.ok(Object.hasOwn(stage, field), `${stage.stage} missing ${field}`);
    }
    assert.ok(stage.requiredInputs.length > 0, `${stage.stage} needs inputs`);
    assert.ok(stage.requiredOutputs.length > 0, `${stage.stage} needs outputs`);
    assert.ok(stage.skipConditions.length > 0, `${stage.stage} needs skip conditions`);
    assert.ok(stage.gateConditions.length > 0, `${stage.stage} needs gate conditions`);
  }

  const byStage = Object.fromEntries(CORE_LOOP.stages.map((stage) => [stage.stage, stage]));
  assert.ok(byStage.Critical.requiredOutputs.includes("intentPacket.realIntent"));
  assert.ok(byStage.Critical.requiredOutputs.includes("intentPacket.noQuotaClarification"));
  assert.ok(byStage.Fetch.requiredOutputs.includes("fetchPacket.capabilityDiscovery.searchLog"));
  assert.ok(byStage.Fetch.requiredOutputs.includes("fetchPacket.capabilityDiscovery.capabilityInventory"));
  assert.ok(byStage.Thinking.requiredOutputs.includes("thinkingPacket.workerTaskPackets"));
  assert.ok(byStage.Thinking.requiredOutputs.includes("thinkingPacket.verificationOwner"));
  assert.ok(byStage.Review.requiredOutputs.includes("reviewPacket.upstreamQuality"));
  assert.ok(byStage["Meta-Review"].requiredOutputs.includes("metaReviewPacket.publicReadyGateCheck"));
  assert.ok(byStage.Verification.blockingGates.includes("public_ready_without_verification"));
  assert.ok(byStage.Evolution.requiredOutputs.includes("evolutionWritebackPacket.noneWithReason"));
});

test("capability discovery is multi-type and verification is a fuse", () => {
  for (const source of [
    "canonical/agents",
    "runtime agent mirrors",
    "Codex custom agents",
    "Claude Code agents",
    "Cursor agents and rules",
    "OpenClaw workspaces, skills, and config",
    "repo skills",
    "user/admin/system skills when discoverable",
    "tools, scripts, and package commands",
    "MCP servers and config",
    "hooks",
    "runtime capability matrix",
    "OS compatibility matrix",
    "config/capability-index",
    "global capability inventory",
    "Graphify/project map",
    "previous run state and learned evolution records",
  ]) {
    assert.ok(
      CORE_LOOP.capabilityDiscovery.minimumSources.includes(source),
      `missing source ${source}`,
    );
  }

  for (const field of [
    "id",
    "providerType",
    "sourcePath",
    "runtimeSupport",
    "riskLevel",
    "ownerBoundary",
    "canExecute",
    "canReview",
    "canVerify",
    "canCreateOrUpgrade",
    "missingDependencies",
    "confidence",
    "reason",
  ]) {
    assert.ok(
      CORE_LOOP.capabilityDiscovery.inventoryRecordRequiredFields.includes(field),
      `missing inventory field ${field}`,
    );
  }

  assert.equal(CORE_LOOP.verificationPolicy.notEveryStepInterceptor, true);
  assert.equal(CORE_LOOP.verificationPolicy.hooksAreLastResortFuse, true);
  assert.equal(CORE_LOOP.publicReadyClaim.requiresVerificationEvidence, true);
  assert.ok(CORE_LOOP.publicReadyClaim.blocksOn.includes("runtime smoke mislabeled as live"));
});

test("governed execution emits a coreLoop artifact summary", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-core-loop-contract-"));
  const runId = "core-loop-contract-test";
  const result = runtimeFixture.run(
    [
      "scripts/run-meta-theory-governed-execution.mjs",
      "--task",
      "需要一个稳定的脚本整理 release summary JSON，不需要新长期 agent。",
      "--run-id",
      runId,
      "--state-dir",
      tempDir,
      "--db",
      path.join(tempDir, "runs.sqlite"),
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "partial");
  assert.equal(summary.runId, runId);

  const artifact = JSON.parse(readFileSync(path.join(tempDir, `${runId}.json`), "utf8"));
  assert.equal(artifact.runId, runId);
  assert.deepEqual(
    artifact.coreLoop.preDecisionOptionFrame,
    artifact.preDecisionOptionFrame,
    "coreLoop and workflow packaging must expose one plan-challenge frame without recomputation drift",
  );
  assert.equal(artifact.coreLoop.contractRef, "config/contracts/core-loop-contract.json");
  assert.deepEqual(artifact.coreLoop.spine, EXPECTED_STAGES);
  for (const packetName of [
    "requestRecord",
    "intentPacket",
    "fetchPacket",
    "capabilityInventory",
    "thinkingPacket",
    "governanceAgentResultPackets",
    "conductorConsumptionEvidence",
    "traceEvalControlPlane",
    "agUiStageEvents",
    "performanceCostBudget",
    "contextEngineeringBudget",
    "goalContractPacket",
    "langGraphRunPacket",
    "dynamicWorkflowRuntimePacket",
    "peerAgentMeshPacket",
    "agentTeamsPlaybookPacket",
    "runtimeInvocationPlanPacket",
    "visibleMetaTheorySurfacePacket",
    "userPerceptionPacket",
    "productExperiencePacket",
    "dispatchBoard",
    "workerTaskPackets",
    "executionResult",
    "reviewPacket",
    "metaReviewPacket",
    "verificationResult",
    "evolutionWritebackDecision",
    "evolutionWritebackPacket",
    "dynamicWorkflowDecisionRecord",
    "publicReadyDecision",
  ]) {
    assert.notEqual(artifact[packetName], undefined, `top-level ${packetName} must exist`);
  }
  for (const stage of CORE_LOOP.stages) {
    for (const outputPath of stage.requiredOutputs) {
      assert.notEqual(
        getPath(artifact.coreLoop, outputPath),
        undefined,
        `${stage.stage} required output ${outputPath} must exist in coreLoop artifact`,
      );
    }
  }
  assert.ok(artifact.coreLoop.intentPacket.realIntent);
  assert.equal(artifact.coreLoop.stageDagPacket.status, "planned_not_invoked");
  for (const stage of EXPECTED_STAGES) {
    const summary = artifact.coreLoop.stageDagPacket.stageSummaries.find(
      (item) => item.stage === stage,
    );
    assert.ok(summary, `${stage} must exist in the stage DAG`);
    assert.ok(
      summary.laneNodeIds.length >= (stage === "Execution" ? 1 : 2),
      `${stage} must expose its materialized contract or worker lanes`,
    );
    const contractStage = CORE_LOOP.stages.find((item) => item.stage === stage);
    assert.equal(summary.mergeAuthority, contractStage.parallelPolicy.mergeAuthority);
  }
  assert.ok(artifact.coreLoop.fetchPacket.capabilityDiscovery.capabilityInventory.length > 250);
  const providerTypes = new Set(
    artifact.coreLoop.fetchPacket.capabilityDiscovery.capabilityInventory.map(
      (record) => record.providerType,
    ),
  );
  for (const providerType of [
    "agent",
    "skill",
    "script",
    "tool",
    "MCP",
    "hook",
    "runtime",
    "OS",
    "memory",
    "graph",
    "external",
  ]) {
    assert.ok(providerTypes.has(providerType), `coreLoop inventory missing ${providerType}`);
  }
  for (const field of CORE_LOOP.capabilityDiscovery.inventoryRecordRequiredFields) {
    assert.ok(
      Object.hasOwn(artifact.coreLoop.capabilityInventory[0], field),
      `capability record missing ${field}`,
    );
  }
  assert.ok(
    artifact.coreLoop.capabilityGapPacket || artifact.coreLoop.capabilityReady,
    "coreLoop must record either capabilityGapPacket or capabilityReady",
  );
  if (artifact.coreLoop.capabilityGapPacket) {
    assert.ok(artifact.coreLoop.capabilityGapPacket.decisionOptions.length >= 5);
  } else {
    for (const field of ["owner", "weapon", "reviewOwner", "metaReviewOwner", "verificationOwner"]) {
      assert.ok(artifact.coreLoop.capabilityReady[field], `capabilityReady missing ${field}`);
    }
  }
  const dynamicCards = new Set(
    artifact.coreLoop.dynamicWorkflowDecisionRecord.cards.map((card) => card.label),
  );
  for (const label of [
    "Clarify",
    "Shrink scope",
    "Options",
    "Execute",
    "Verify",
    "Fix",
    "Rollback",
    "Risk",
    "Nudge",
    "Pause",
  ]) {
    assert.ok(dynamicCards.has(label), `dynamic workflow missing ${label}`);
  }
  assert.ok(artifact.coreLoop.thinkingPacket.workerTaskPackets.length > 0);
  assert.equal(artifact.coreLoop.goalContractPacket.status, "pass");
  assert.equal(artifact.coreLoop.langGraphRunPacket.status, "pass");
  assert.equal(artifact.coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage.hooks, true);
  assert.equal(
    artifact.coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage.abstractPromptCapability,
    true,
  );
  assert.equal(artifact.coreLoop.dynamicWorkflowRuntimePacket.capabilityBindingCoverage.workerResults, true);
  assert.equal(artifact.coreLoop.peerAgentMeshPacket.status, "pass");
  assert.ok(["pass", "not_required"].includes(artifact.coreLoop.agentTeamsPlaybookPacket.status));
  if (artifact.coreLoop.thinkingPacket.workerTaskPackets.length >= 2) {
    assert.equal(artifact.coreLoop.agentTeamsPlaybookPacket.status, "pass");
    assert.equal(artifact.coreLoop.agentTeamsPlaybookPacket.selected, true);
    assert.equal(artifact.coreLoop.agentTeamsPlaybookPacket.fanoutSafetyPacket.safeForParallelFanout, true);
    assert.equal(artifact.coreLoop.agentTeamsPlaybookPacket.acceptance.independentLanesProven, true);
    assert.equal(artifact.coreLoop.agentTeamsPlaybookPacket.acceptance.parallelWaveExists, true);
    assert.equal(artifact.coreLoop.agentTeamsPlaybookPacket.acceptance.dagAndCollisionSafe, true);
    assert.equal(artifact.coreLoop.agentTeamsPlaybookPacket.acceptance.waveSizeWithinCap, true);
    assert.equal(artifact.coreLoop.agentTeamsPlaybookPacket.acceptance.waveSizeWithinRuntimeCapacity, true);
    assert.equal(artifact.coreLoop.agentTeamsPlaybookPacket.acceptance.noArbitraryMetaKimCap, true);
    assert.ok(artifact.coreLoop.agentTeamsPlaybookPacket.runtimeCapacity >= 2);
    assert.ok(artifact.coreLoop.agentTeamsPlaybookPacket.capacitySource);
  } else {
    assert.equal(artifact.coreLoop.agentTeamsPlaybookPacket.status, "not_required");
    assert.equal(artifact.coreLoop.agentTeamsPlaybookPacket.selected, false);
  }
  assert.ok(artifact.coreLoop.peerAgentMeshPacket.peers.length > 0);
  assert.ok(["pass", "partial"].includes(artifact.coreLoop.capabilityInvocationTruthPacket.status));
  const invocationByFamily = new Map(
    artifact.coreLoop.capabilityInvocationTruthPacket.rows.map((row) => [row.family, row]),
  );
  const expectedSubagentState = artifact.coreLoop.runtimeSubagentInvocationPacket.fanoutEligible
    ? "unavailable"
    : "not_required";
  assert.equal(
    artifact.coreLoop.runtimeSubagentInvocationPacket.status,
    expectedSubagentState,
  );
  assert.equal(
    invocationByFamily.get("agent_subagent").state,
    expectedSubagentState,
  );
  assert.equal(invocationByFamily.get("app_visible_subagent").state, "not_required");
  assert.equal(invocationByFamily.get("worker_task").state, "blocked");
  assert.equal(invocationByFamily.get("prompt_rule").state, "applied");
  assert.equal(
    invocationByFamily.get("agent_teams_playbook").state,
    artifact.coreLoop.agentTeamsPlaybookPacket.status === "pass"
      ? "selected_not_invoked"
      : "not_required",
  );
  assert.ok(
    ["selected_not_invoked", "discovered_not_selected", "not_required"].includes(
      invocationByFamily.get("mcp").state,
    ),
  );
  assert.equal(invocationByFamily.get("hook").state, "selected_not_invoked");
  assert.equal(artifact.coreLoop.capabilityInvocationProbePacket.status, "not_run");
  assert.equal(
    artifact.coreLoop.capabilityInvocationTruthPacket.callableInvocationCoverage.status,
    "not_run",
  );
  if (artifact.coreLoop.capabilityInvocationTruthPacket.status === "partial") {
    assert.equal(
      artifact.coreLoop.capabilityInvocationTruthPacket.realInvocationCoverage.status,
      "partial",
    );
    assert.ok(
      artifact.coreLoop.capabilityInvocationTruthPacket.realInvocationCoverage.missingFamilies.length > 0,
    );
  }
  assert.equal(
    artifact.coreLoop.capabilityInvocationTruthPacket.truthAssertions.noLiveSubagentOverclaim,
    true,
  );
  assert.equal(
    artifact.coreLoop.capabilityInvocationTruthPacket.truthAssertions.noHostUiSubagentOverclaim,
    true,
  );
  assert.equal(
    artifact.coreLoop.capabilityInvocationTruthPacket.truthAssertions.noAgentTeamsPlaybookOverclaim,
    true,
  );
  assert.equal(
    artifact.coreLoop.capabilityInvocationTruthPacket.truthAssertions.noMcpCallOverclaim,
    true,
  );
  assert.ok(["pass", "partial"].includes(artifact.coreLoop.visibleMetaTheorySurfacePacket.status));
  assert.equal(artifact.coreLoop.visibleMetaTheorySurfacePacket.capabilityInventory.notSkillOnly, true);
  assert.equal(
    Object.hasOwn(
      artifact.coreLoop.visibleMetaTheorySurfacePacket,
      "capabilityInvocationTruth",
    ),
    false,
  );
  assert.deepEqual(
    artifact.capabilityInvocationTruthPacket,
    artifact.coreLoop.capabilityInvocationTruthPacket,
  );
  assert.equal(
    artifact.coreLoop.visibleMetaTheorySurfacePacket.dynamicWorkflow.status,
    artifact.coreLoop.dynamicWorkflowRuntimePacket.status,
  );
  assert.equal(artifact.coreLoop.visibleMetaTheorySurfacePacket.peerAgentMesh.status, "pass");
  assert.equal(artifact.coreLoop.visibleMetaTheorySurfacePacket.langGraph.status, "pass");
  assert.ok(["pass", "partial"].includes(artifact.coreLoop.userPerceptionPacket.status));
  assert.ok(artifact.coreLoop.userPerceptionPacket.plainLanguageCues.length >= 6);
  assert.deepEqual(
    artifact.coreLoop.productExperiencePacket.goals.map((goal) => goal.id),
    ["P-102", "P-103", "P-104"],
  );
  assert.deepEqual(
    artifact.coreLoop.productExperiencePacket.supportGates.map((gate) => gate.id),
    ["P-105", "P-106", "P-107", "P-108", "P-109", "P-110"],
  );
  assert.equal(artifact.coreLoop.productExperiencePacket.noOverclaimGate.status, "pass");
  assert.equal(
    artifact.coreLoop.productExperiencePacket.nativeChoiceSurfaceGate.liveRuntimeBoundary.status,
    "needs-host-invocation",
  );
  assert.equal(artifact.coreLoop.productExperiencePacket.nativeChoiceSurfaceGate.status, "partial");
  assert.equal(
    artifact.coreLoop.productExperiencePacket.repeatFailureDesignGate.actionOnSecondOccurrence,
    "bottom_design_failure_return_to_critical_fetch_thinking",
  );
  assert.equal(artifact.coreLoop.productExperiencePacket.generalizationGate.status, "pass");
  assert.equal(artifact.coreLoop.productExperiencePacket.capabilityInvocationTruthGate.status, "partial");
  assert.equal(artifact.coreLoop.productExperiencePacket.agentTeamsPlaybookGate.status, "pass");
  assert.ok(artifact.coreLoop.governanceAgentResultPackets.length > 0);
  assert.equal(artifact.coreLoop.conductorConsumptionEvidence.status, "pass");
  assert.ok(artifact.coreLoop.thinkingPacket.governanceInputsConsumed.length > 0);
  assert.equal(artifact.coreLoop.executionResult.mainThreadRole, "scope_delegate_review_synthesize");
  assert.equal(artifact.coreLoop.executionResult.actualWorkerExecution, false);
  assert.ok(artifact.coreLoop.executionResult.workerExecutionEvidence.length > 0);
  assert.ok(
    artifact.coreLoop.executionResult.workerExecutionEvidence.every(
      (item) => item.externalAgentSpawned === false,
    ),
  );
  assert.ok(
    artifact.coreLoop.executionResult.workerExecutionEvidence.every(
      (item) => item.liveWorkerExecution === false,
    ),
  );
  assert.equal(artifact.coreLoop.executionResult.mergeResult.liveExecutionMerged, false);
  assert.equal(artifact.coreLoop.reviewPacket.upstreamQuality.critical, true);
  assert.equal(artifact.coreLoop.reviewPacket.protocolCompliance.executionEvidenceLayerIsHonest, true);
  assert.equal(artifact.coreLoop.metaReviewPacket.reviewStandardChecked, true);
  assert.match(artifact.coreLoop.metaReviewPacket.biasCheck.overclaimCheck, /blocked|pass/);
  assert.equal(artifact.coreLoop.verificationResult.notEveryStepInterceptor, true);
  assert.ok(artifact.coreLoop.verificationResult.remainingRisk.length > 0);
  assert.ok(["writeback", "candidate-writeback", "none-with-reason"].includes(
    artifact.coreLoop.evolutionWritebackDecision.decision,
  ));
  assert.ok(Array.isArray(artifact.coreLoop.evolutionWritebackPacket.writebacks));
  assert.ok(artifact.coreLoop.scarPacket.preventionRule);
  assert.equal(artifact.coreLoop.publicReadyDecision.publicReady, false);
  assert.ok(artifact.coreLoop.publicReadyDecision.blockedBy.length > 0);
  rmSync(tempDir, { recursive: true, force: true });
});

test("caller-provided host-visible names remain unverified hints", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-host-visible-"));
  const runId = "core-loop-host-visible-subagent-test";
  const result = runtimeFixture.run(
    [
      "scripts/run-meta-theory-governed-execution.mjs",
      "--task",
      "需要一次能产生多 worker 的 meta-theory governed run。",
      "--run-id",
      runId,
      "--state-dir",
      tempDir,
      "--db",
      path.join(tempDir, "runs.sqlite"),
      "--host-visible-subagents",
      "Galileo,Codebase Analysis",
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "partial");
  assert.equal(summary.runId, runId);

  const artifact = JSON.parse(readFileSync(path.join(tempDir, `${runId}.json`), "utf8"));
  const invocationByFamily = new Map(
    artifact.coreLoop.capabilityInvocationTruthPacket.rows.map((row) => [row.family, row]),
  );
  assert.equal(invocationByFamily.get("app_visible_subagent").state, "not_required");
  assert.equal(invocationByFamily.get("agent_subagent").state, "unavailable");
  assert.equal(artifact.coreLoop.stageDagPacket.status, "planned_not_invoked");
  assert.ok(
    artifact.coreLoop.stageDagPacket.nodes.some(
      (node) => node.stage === "Execution" && node.laneKind === "execution_worker",
    ),
  );
  assert.equal(artifact.coreLoop.capabilityInvocationPresentationPacket.executionState, "not_confirmed");
  assert.equal(
    artifact.coreLoop.capabilityInvocationTruthPacket.truthAssertions.noHostUiSubagentOverclaim,
    true,
  );
  rmSync(tempDir, { recursive: true, force: true });
});

test("core-loop contract declares three product goals plus support gates", () => {
  assert.equal(
    CORE_LOOP.productExperienceCoreGoals.evidenceTierRequired,
    "product_experience_pass",
  );
  assert.deepEqual(CORE_LOOP.productExperienceCoreGoals.requiredGoalIds, [
    "P-102",
    "P-103",
    "P-104",
  ]);
  assert.deepEqual(CORE_LOOP.productExperienceCoreGoals.supportGateIds, [
    "P-105",
    "P-106",
    "P-107",
    "P-108",
    "P-109",
    "P-110",
  ]);
  assert.deepEqual(CORE_LOOP.productExperienceCoreGoals.requiredPackets, [
    "goalContractPacket",
    "langGraphRunPacket",
    "dynamicWorkflowRuntimePacket",
    "peerAgentMeshPacket",
    "agentTeamsPlaybookPacket",
    "runtimeInvocationPlanPacket",
    "hostInvocationRequestPacket",
    "capabilityInvocationProbePacket",
    "capabilityInvocationTruthPacket",
    "durableAgentLifecyclePacket",
    "visibleMetaTheorySurfacePacket",
    "userPerceptionPacket",
    "productExperiencePacket",
  ]);
  assert.ok(CORE_LOOP.productExperienceCoreGoals.langGraphStyleRequirements.includes("checkpoint"));
  assert.ok(CORE_LOOP.productExperienceCoreGoals.dynamicWorkflowRequirements.includes("mcp"));
  assert.ok(
    CORE_LOOP.productExperienceCoreGoals.dynamicWorkflowRequirements.includes("agentTeamsPlaybook"),
  );
  assert.ok(
    CORE_LOOP.productExperienceCoreGoals.capabilityInvocationTruthRequirements.some((rule) =>
      rule.includes("app-visible host UI subagents"),
    ),
  );
  assert.ok(
    CORE_LOOP.productExperienceCoreGoals.capabilityInvocationTruthRequirements.some((rule) =>
      rule.includes("capabilityInvocationProbePacket"),
    ),
  );
  assert.deepEqual(CORE_LOOP.productExperienceCoreGoals.userPerceptionRequirements, [
    "what_to_do",
    "what_is_happening",
    "how_it_will_run",
    "acceptance_standard",
    "pause_condition",
  ]);
  assert.ok(CORE_LOOP.productExperienceCoreGoals.supportGateRequirements["P-106"].some(
    (rule) => rule.includes("request_user_input"),
  ));
  assert.ok(CORE_LOOP.productExperienceCoreGoals.supportGateRequirements["P-107"].some(
    (rule) => rule.includes("bottom_design_failure"),
  ));
  assert.ok(CORE_LOOP.productExperienceCoreGoals.supportGateRequirements["P-108"].some(
    (rule) => rule.includes("desktop sticky notes"),
  ));
  assert.ok(CORE_LOOP.productExperienceCoreGoals.supportGateRequirements["P-109"].some(
    (rule) => rule.includes("app-visible host subagent"),
  ));
  assert.ok(CORE_LOOP.productExperienceCoreGoals.supportGateRequirements["P-110"].some(
    (rule) => rule.includes("native Agent/Task/spawn_agent"),
  ));
});

test("project-understanding governed run records deep Fetch source classes", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-project-understanding-"));
  const runId = "core-loop-project-understanding-fetch-test";
  const result = runtimeFixture.run(
    [
      "scripts/run-meta-theory-governed-execution.mjs",
      "--task",
      "这个项目如果商业化应该怎么发展？",
      "--run-id",
      runId,
      "--state-dir",
      tempDir,
      "--db",
      path.join(tempDir, "runs.sqlite"),
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "partial");
  assert.equal(summary.runId, runId);

  const artifact = JSON.parse(readFileSync(path.join(tempDir, `${runId}.json`), "utf8"));
  const sourceTypes = new Set(
    artifact.coreLoop.fetchPacket.evidence.map((source) => source.sourceType),
  );

  for (const sourceType of [
    "project_overview",
    "maintainer_contract",
    "command_inventory",
    "project_graph",
    "canonical_skill",
    "machine_contract",
    "capability_index",
    "mcp_inventory",
    "external_research_capability",
  ]) {
    assert.ok(sourceTypes.has(sourceType), `missing Fetch sourceType ${sourceType}`);
  }
  assert.equal(
    artifact.coreLoop.fetchPacket.capabilityDiscovery.searchLog.some((entry) =>
      String(entry.source ?? "").includes("Graphify"),
    ),
    true,
  );
  assert.equal(
    artifact.coreLoop.fetchPacket.capabilityDiscovery.searchLog.some((entry) =>
      String(entry.source ?? "").includes("MCP"),
    ),
    true,
  );
  rmSync(tempDir, { recursive: true, force: true });
});

test("default governed run is route-driven instead of old capability-gap orchestration", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-route-driven-"));
  const runId = "route-driven-subjective-ui";
  const result = runtimeFixture.run(
    [
      "scripts/run-meta-theory-governed-execution.mjs",
      "--task",
      "这个页面不好看，帮我弄高级一点",
      "--run-id",
      runId,
      "--state-dir",
      tempDir,
      "--db",
      path.join(tempDir, "runs.sqlite"),
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const artifact = JSON.parse(readFileSync(path.join(tempDir, `${runId}.json`), "utf8"));
  const report = artifact.sourceArtifacts.orchestrationReport;
  assert.equal(
    report.selectedExecutionRoute.recommendedRoute.id,
    "subjective-ui-design-orchestration:codex:windows",
  );
  assert.equal(report.decisionCounts.oldDefaultPath, 0);
  assert.equal(artifact.workerTaskPackets.length, 6);
  assert.ok(
    artifact.workerTaskPackets.every(
      (packet) => packet.packetKind === "run_scoped_task_not_agent_definition",
    ),
    "worker task cards must be marked as run tasks, not durable agent settings",
  );
  for (const packet of artifact.workerTaskPackets) {
    assert.ok(Array.isArray(packet.skillLoadout), `${packet.roleInstanceId} missing skillLoadout`);
    assert.ok(Array.isArray(packet.mcpLoadout), `${packet.roleInstanceId} missing mcpLoadout`);
    assert.ok(Array.isArray(packet.toolLoadout), `${packet.roleInstanceId} missing toolLoadout`);
    assert.ok(Array.isArray(packet.commandLoadout), `${packet.roleInstanceId} missing commandLoadout`);
  }
  assert.equal(
    artifact.workerTaskPackets.some(
      (packet) =>
        packet.roleInstanceId === "read-before-edit-implementation" &&
        packet.readBeforeEditRequired === true,
    ),
    true,
  );
  rmSync(tempDir, { recursive: true, force: true });
});

test("core-loop release strict fixture validates with workflow run validator", () => {
  const result = runtimeFixture.run(
    [
      "scripts/validate-run-artifact.mjs",
      "tests/fixtures/run-artifacts/valid-core-loop-release-run.json",
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.ok(output.validatedPackets.includes("workerTaskPacket"));
  assert.ok(output.validatedPackets.includes("evolutionWritebackPacket"));
});
