/**
 * 11-eight-stage-spine.test.mjs
 *
 * Tests the complete 8-stage execution spine:
 * Critical → Fetch → Thinking → Execution → Review → Meta-Review → Verification → Evolution
 *
 * Validates:
 * - All 8 stages have correct state transitions
 * - gateState is properly set at each gate
 * - controlState (normal/skip/interrupt/intentional_silence/iteration/degraded) switches correctly
 * - All required protocol packets exist for each stage
 * - Stage ordering is enforced (Critical before Fetch, Evolution last)
 * - The spine relationship to business workflow phases is distinct
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkCapabilityNodeBindings,
  checkChoiceSurfaceGate,
  checkStageRequirements,
  createInitialState,
  incrementCriticalFetchLoop,
  recordIntentConfirmation,
  STAGE_META_AGENT_MAP,
} from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import {
  checkChoiceSurfaceGate as checkSharedChoiceSurfaceGate,
  createInitialState as createSharedInitialState,
  incrementCriticalFetchLoop as incrementSharedCriticalFetchLoop,
  recordIntentConfirmation as recordSharedIntentConfirmation,
} from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import {
  REPO_ROOT,
  EIGHT_STAGES,
  readFile,
  readJson,
  fileExists,
} from "./_helpers.mjs";
import { buildCodexHooksJson } from "../../scripts/runtime-hook-mapping.mjs";
import {
  assertHookResolvedItsModules,
  copyHookClosure,
} from "../helpers/hook-fixture.mjs";

const DEV_GOV_PATH = `${REPO_ROOT}/canonical/skills/meta-theory/references/dev-governance.md`;
const SKILL_PATH = `${REPO_ROOT}/canonical/skills/meta-theory/SKILL.md`;
const WORKFLOW_CONTRACT = `${REPO_ROOT}/config/contracts/workflow-contract.json`;
const VALID_FIXTURE = `${REPO_ROOT}/tests/fixtures/run-artifacts/valid-run.json`;

function minimalNodeBindings() {
  return {
    intentPacket: {
      realIntent: "verify relaxed hook governance behavior",
      successCriteria: ["minimum key behavior evidence is enough for execution"],
    },
    memoryMode: "project_only",
    fetchRecord: {
      capabilitySearchPerformed: true,
      memoryStrategy: "project_only",
      capabilityMatches: [
        {
          name: "backend implementation capability",
          score: 3,
          matchReason: "covered by backend role lane",
        },
      ],
    },
    businessFlowBlueprintPacket: {
      requiredLanes: [
        {
          laneId: "backend",
          capabilityNeed: "backend implementation",
          capabilitySearchQuery: "backend implementation owner",
          candidateOwners: ["meta-conductor"],
          candidateSkills: ["meta-theory"],
          selectedOwner: "meta-conductor",
          selectionReason: "capability-first scan selected meta-conductor",
          coverageStatus: "covered",
        },
      ],
      optionalLanes: [],
    },
    agentBlueprintPacket: {
      roles: [
        {
          businessRoleId: "backend",
          roleDisplayName: "backend",
          ownerAgent: "meta-conductor",
          ownerSource: "meta_kim_canonical",
          agentCopyPolicy: "meta_kim_governance_only",
          ownerResolution: "reuse_existing_owner",
          assignedResponsibilitySlice: ["backend"],
          matchedSkills: [
            {
              matchId: "match-backend-001",
              capabilitySlot: "backend implementation",
              providerId: "meta-theory",
              skillId: "local-project-code-change",
              source: "capability-index",
              selectionReason: "run-scoped skill evidence",
              selectionScope: "run_scoped",
            },
          ],
          skillSelectionScope: "run_scoped",
          governanceStageNodes: [
            {
              stage: "Fetch",
              ownerAgent: "meta-artisan",
              responsibility: "match capability",
            },
          ],
        },
      ],
    },
    workerTaskPackets: [
      {
        taskPacketId: "task-backend-001",
        ownerMode: "existing-owner",
        ownerAgent: "meta-conductor",
        ownerSource: "canonical/agents/meta-conductor.md",
        owner: "meta-conductor",
        businessRoleId: "backend",
        roleDisplayName: "backend",
        roleInstanceId: "backend#1",
        runtimeInstanceAlias: "host-backend-1",
        coreProblem: "close the backend implementation gap before execution",
        todayTask: "implement bounded backend change",
        nonGoals: ["do not broaden scope beyond backend"],
        output: "patch and verification notes",
        acceptanceCriteria: ["backend change is implemented and verified"],
        deliverableLink: "auth-refresh-hardening",
        scopeFiles: ["src/backend/auth.ts"],
        qualityBar: "code=layering+contract+tests",
        workType: "code",
        expertLensRefs: ["code"],
        evidenceRefs: ["fetchRecord.capabilityMatches[0]"],
        capabilityRequirements: ["backend implementation"],
        toolRequirements: ["npm run meta:test:meta-theory"],
        referenceDirection: "use Fetch evidence and local contract only",
        handoffTarget: "meta-prism",
        handoffContract: {
          handoffTo: "meta-prism",
          handoffWhen: "after implementation evidence is ready",
          handoffPayload: "changed files, verification output, and open risks",
          acceptanceSignal: "reviewPacket can verify acceptance criteria",
        },
        lengthExpectation: "concise patch plus verification notes",
        visualOrAssetPlan: "not applicable for backend code",
        dependsOn: [],
        parallelGroup: "backend",
        mergeOwner: "meta-warden",
        shardKey: "backend",
        shardScope: ["src/backend/auth.ts"],
        workspaceIsolation: "same_worktree_with_file_lock",
        artifactNamespace: "auth-refresh-hardening/backend",
        collisionPolicy: "block_on_overlap",
        verifySteps: ["focused test passes"],
        preDecisionOptionFrameRef: "preDecisionOptionFrame",
        userChoiceState: "explicit_auto_proceed",
        finalizationGate: "user choice recorded before dispatch",
      },
    ],
  };
}

function completePreExecutionBindings() {
  return {
    ...minimalNodeBindings(),
    dispatchEnvelopePacket: {
      ownerAgent: "meta-conductor",
      roleDisplayName: "backend",
      route: "project_only",
      capabilityBoundary: "backend implementation",
      allowedCapabilities: ["backend implementation"],
      blockedCapabilities: ["deploy production"],
      ownerSelection: "capability_first",
      memoryMode: "project_only",
      reviewOwner: "meta-prism",
      verificationOwner: "meta-warden",
      userChoiceState: "explicit_auto_proceed",
    },
    orchestrationTaskBoardPacket: {
      dispatchBoardId: "board-001",
      boardMode: "direct_dispatch",
      synthesisOwner: "meta-conductor",
      tasks: [
        {
          taskId: "task-backend-001",
          ownerAgent: "meta-conductor",
          dependsOn: [],
        },
      ],
    },
    dispatchBoard: {
      boardId: "board-001",
      department: "Meta_Kim",
      primaryDeliverable: "auth-refresh-hardening",
      ownerAgent: "meta-conductor",
      selectedWeapon: "npm run meta:test:meta-theory",
      reviewerAgent: "meta-prism",
      verifierAgent: "meta-warden",
    },
    productCompletenessPacket: {
      completenessStatus: "pass",
      owner: "meta-conductor",
      evidenceRefs: ["businessFlowBlueprintPacket"],
    },
    experienceQualityPacket: {
      experienceStatus: "not_applicable_with_reason",
      owner: "meta-prism",
      evidenceRefs: ["summaryPacket"],
    },
    testStrategyPacket: {
      testStatus: "pass",
      owner: "meta-warden",
      evidenceRefs: ["workerTaskPackets[0].verifySteps"],
    },
    structureHygienePacket: {
      hygieneStatus: "pass",
      owner: "meta-prism",
      evidenceRefs: ["workerResultPackets"],
    },
    permissionMatrixPacket: {
      permissionStatus: "pass",
      owner: "meta-sentinel",
      evidenceRefs: ["reviewPacket"],
    },
    sideEffectLedgerPacket: {
      sideEffectStatus: "tracked",
      owner: "meta-sentinel",
      evidenceRefs: ["workerResultPackets"],
    },
    rollbackPlanPacket: {
      rollbackStatus: "ready",
      owner: "meta-warden",
      evidenceRefs: ["verificationPacket"],
    },
    businessFlowBlueprintPacket: {
      ...minimalNodeBindings().businessFlowBlueprintPacket,
      deliverableType: "custom",
      omittedLanes: [],
      laneDependencies: [],
      coverageJudgment: "complete",
      blueprintSource: "test",
      blueprintVersion: "v1",
    },
  };
}

function preExecutionReadinessPacketsOnly() {
  const {
    fetchRecord,
    businessFlowBlueprintPacket,
    agentBlueprintPacket,
    workerTaskPackets,
    ...packets
  } = completePreExecutionBindings();
  return packets;
}

function modernCapabilityNodeBindings() {
  const state = completePreExecutionBindings();
  const lane = state.businessFlowBlueprintPacket.requiredLanes[0];
  lane.candidateCapabilities = [
    {
      capabilitySlot: "backend implementation",
      bindingType: "command",
      bindingRef: "npm:test:meta-theory",
    },
  ];
  delete lane.candidateSkills;

  const role = state.agentBlueprintPacket.roles[0];
  delete role.matchedSkills;
  role.matchedCapabilities = [
    {
      matchId: "cap-backend-001",
      capabilitySlot: "backend implementation",
      bindingType: "command",
      bindingRef: "npm run meta:test:meta-theory",
      source: "config/capability-index",
      confidenceScore: 4,
      selectionReason: "Focused command binding covers the test lane.",
      selectionScope: "run_scoped",
      persistencePolicy: "do_not_persist_to_agent_identity",
      fallback: "Block with capabilityGapPacket if the command is unavailable.",
    },
  ];
  role.capabilityBindings = [
    {
      bindingId: "binding-backend-001",
      capabilitySlot: "backend implementation",
      bindingType: "command",
      bindingRef: "npm run meta:test:meta-theory",
      source: "config/capability-index",
      evidenceRef: "fetchRecord.capabilityMatches[0]",
    },
  ];

  return state;
}

function runEnforceHook(state, payload, options = {}) {
  const { runtime = "codex", env = {} } = options;
  const cwd = mkdtempSync(join(tmpdir(), "meta-kim-hook-"));
  try {
    const hookDir = join(cwd, "canonical", "runtime-assets", "claude", "hooks");
    mkdirSync(hookDir, { recursive: true });
    copyHookClosure(REPO_ROOT, hookDir, ["enforce-agent-dispatch.mjs"]);
    const spineDir = join(cwd, ".meta-kim", "state", "test", "spine");
    mkdirSync(spineDir, { recursive: true });
    writeFileSync(
      join(spineDir, "spine-state.json"),
      JSON.stringify(state, null, 2),
      "utf8",
    );
    return spawnSync(
      process.execPath,
      [join(hookDir, "enforce-agent-dispatch.mjs")],
      {
        cwd,
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: {
          ...process.env,
          META_KIM_SPINE_STATE_DIR: ".meta-kim/state/test/spine",
          META_KIM_CAPABILITY_GATE: "block",
          META_KIM_HOOK_RUNTIME: runtime,
          ...env,
        },
      },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function codexWorkerEnvelope(packet, overrides = {}) {
  const ownerAgent = overrides.ownerAgent ?? packet.ownerAgent;
  const taskPacketId = overrides.taskPacketId ?? packet.taskPacketId;
  const roleInstanceId = overrides.roleInstanceId ?? packet.roleInstanceId;
  const providerId = overrides.providerId ?? `project:${ownerAgent}`;
  return JSON.stringify({
    schemaVersion: "codex-native-worker-invocation-v0.2",
    taskPacketId,
    roleDisplayName: overrides.roleDisplayName ?? packet.roleDisplayName,
    roleInstanceId,
    ownerAgent,
    ownerKind: "agent",
    ownerSource: overrides.ownerSource ?? packet.ownerSource,
    capabilityLoadout: {
      weapon: packet.weapon ?? null,
      dependency: packet.dependency ?? null,
    },
    coordination: {
      mergeOwner: packet.mergeOwner,
      parallelGroup: packet.parallelGroup ?? null,
    },
    metaKimBinding: {
      runId: "hook-envelope-test",
      family: "agent_subagent",
      providerId,
      bindingRef: `hook-envelope-test:agent_subagent:${providerId}:${taskPacketId}`,
      taskPacketId,
      roleInstanceId,
      occurredAt: "2026-07-14T00:00:00.000Z",
      evidenceKind: "spawn_agent_result",
    },
    ...(overrides.ownerBindingMode
      ? { ownerBindingMode: overrides.ownerBindingMode }
      : {}),
    ...(overrides.nativeAgentType
      ? { nativeAgentType: overrides.nativeAgentType }
      : {}),
    ...(overrides.ownerDefinition
      ? { ownerDefinition: overrides.ownerDefinition }
      : {}),
  });
}

function runEnforceHookWithState(state, payload, options = {}) {
  const { runtime = "codex", env = {} } = options;
  const cwd = mkdtempSync(join(tmpdir(), "meta-kim-hook-"));
  try {
    const hookDir = join(cwd, "canonical", "runtime-assets", "claude", "hooks");
    mkdirSync(hookDir, { recursive: true });
    copyHookClosure(REPO_ROOT, hookDir, ["enforce-agent-dispatch.mjs"]);
    const spineDir = join(cwd, ".meta-kim", "state", "test", "spine");
    mkdirSync(spineDir, { recursive: true });
    const spinePath = join(spineDir, "spine-state.json");
    writeFileSync(spinePath, JSON.stringify(state, null, 2), "utf8");
    const result = spawnSync(
      process.execPath,
      [join(hookDir, "enforce-agent-dispatch.mjs")],
      {
        cwd,
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: {
          ...process.env,
          META_KIM_SPINE_STATE_DIR: ".meta-kim/state/test/spine",
          META_KIM_CAPABILITY_GATE: "block",
          META_KIM_HOOK_RUNTIME: runtime,
          ...env,
        },
      },
    );
    const updatedState = JSON.parse(readFileSync(spinePath, "utf8"));
    return { result, updatedState };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function runActivateHook(existingState, payload, options = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "meta-kim-activate-"));
  const { runtime = "shared", staleMinutes = "360", taskIdentityKey = null } = options;
  try {
    const hookDir = join(cwd, "hooks");
    mkdirSync(hookDir, { recursive: true });
    // A real project session runs this hook from a project root. Mark the temp
    // dir as a legit project (.git) so the project-root gate activates the
    // spine here instead of correctly skipping an unmarked temp dir.
    mkdirSync(join(cwd, ".git"), { recursive: true });
    copyHookClosure(REPO_ROOT, hookDir, ["activate-meta-theory-spine.mjs"]);
    const spineDir = join(cwd, ".meta-kim", "state", "test", "spine");
    mkdirSync(spineDir, { recursive: true });
    const spinePath = join(spineDir, "spine-state.json");
    const identityKeyPath = join(
      cwd,
      ".meta-kim",
      "state",
      "test",
      "private",
      "task-identity-key.json",
    );
    if (taskIdentityKey) {
      mkdirSync(dirname(identityKeyPath), { recursive: true });
      writeFileSync(identityKeyPath, taskIdentityKey, "utf8");
    }
    if (existingState) {
      writeFileSync(spinePath, JSON.stringify(existingState, null, 2), "utf8");
    }
    const result = spawnSync(
      process.execPath,
      [join(hookDir, "activate-meta-theory-spine.mjs")],
      {
        cwd,
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: {
          ...process.env,
          META_KIM_SPINE_STATE_DIR: ".meta-kim/state/test/spine",
          META_KIM_SPINE_STALE_MINUTES: staleMinutes,
        },
      },
    );
    assertHookResolvedItsModules(result, "activate-meta-theory-spine.mjs");
    const nextState = JSON.parse(readFileSync(spinePath, "utf8"));
    const statusRoot = join(cwd, ".meta-kim", "state", "test");
    const readStatus = (filePath) => {
      try {
        return JSON.parse(readFileSync(filePath, "utf8"));
      } catch {
        return null;
      }
    };
    return {
      result,
      nextState,
      activeRunStatus: readStatus(join(statusRoot, "active-run.json")),
      previousRunStatus: existingState?.runId
        ? readStatus(join(statusRoot, "runs", existingState.runId, "status.json"))
        : null,
      nextRunStatus: readStatus(
        join(statusRoot, "runs", nextState.runId, "status.json"),
      ),
      taskIdentityKey: readFileSync(identityKeyPath, "utf8"),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function buildCdCommand(command) {
  const sampleRepoPath = join(tmpdir(), "meta-kim-sample-project").replace(/\\/g, "/");
  return `cd "${sampleRepoPath}" && ${command}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Part A: Stage Ordering & State Machine
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Part A: 8-stage spine ordering", async () => {
  test("all 8 stages are listed in EIGHT_STAGES helper", () => {
    const expected = [
      "Critical",
      "Fetch",
      "Thinking",
      "Execution",
      "Review",
      "Meta-Review",
      "Verification",
      "Evolution",
    ];
    assert.deepEqual(EIGHT_STAGES, expected);
  });

  test("SKILL.md defines the 8-stage spine", async () => {
    const skill = await readFile("canonical/skills/meta-theory/SKILL.md");
    for (const stage of EIGHT_STAGES) {
      assert.ok(
        skill.includes(stage),
        `SKILL.md must reference stage "${stage}"`,
      );
    }
  });

  test("workflow-contract.json canonicalExecutionSpineStages has all 8", async () => {
    const contract = await readJson("config/contracts/workflow-contract.json");
    const stages =
      contract.businessWorkflow?.canonicalExecutionSpineStages ?? [];
    assert.equal(stages.length, 8);
    const expected = [
      "critical",
      "fetch",
      "thinking",
      "execution",
      "review",
      "meta_review",
      "verification",
      "evolution",
    ];
    for (const stage of expected) {
      assert.ok(stages.includes(stage), `Missing spine stage: ${stage}`);
    }
  });

  test("workflow-contract.json distinctFromCanonicalSpine is true", async () => {
    const contract = await readJson("config/contracts/workflow-contract.json");
    assert.equal(
      contract.businessWorkflow?.distinctFromCanonicalSpine,
      true,
      "business workflow must be declared distinct from the 8-stage spine",
    );
    assert.ok(
      contract.businessWorkflow?.canonicalExecutionSpineRef?.includes(
        "Critical",
      ),
      "business workflow must reference the canonical 8-stage spine",
    );
  });

  test("workflow-contract.json documents the new stage semantics", async () => {
    const contract = await readJson("config/contracts/workflow-contract.json");
    const semantics = contract.businessWorkflow?.stageSemantics ?? {};

    assert.equal(
      semantics.critical?.primaryAction,
      "clarify_intent_first",
      "Critical must clarify intent before research or planning",
    );
    assert.equal(
      semantics.fetch?.primaryAction,
      "research_and_confirm_problem_with_candidate_solutions",
      "Fetch must search local/online sources and confirm the problem plus candidate solutions",
    );
    assert.deepEqual(
      semantics.thinking?.capabilityDecisionOrder,
      [
        "determine_needed_execution_capabilities",
        "match_existing_capabilities",
        "create_or_upgrade_only_for_gaps",
        "orchestrate_dag_with_merge_owner",
      ],
      "Thinking must decide capability needs before matching, gap creation, and DAG orchestration",
    );
    assert.ok(
      semantics.execution?.executionCapabilityTypes?.includes("agent") &&
        semantics.execution?.executionCapabilityTypes?.includes("skill") &&
        semantics.execution?.executionCapabilityTypes?.includes("command") &&
        semantics.execution?.executionCapabilityTypes?.includes("mcp_capability") &&
        semantics.execution?.executionCapabilityTypes?.includes("tool"),
      "Execution must cover agents, skills, commands, MCP capabilities, and tools",
    );
    assert.equal(
      semantics.verification?.primaryAction,
      "run_real_tests_with_fresh_evidence",
      "Verification must require real tests, not summary-only checks",
    );
    assert.ok(
      semantics.evolution?.allowedDecisions?.includes("writeback") &&
        semantics.evolution?.allowedDecisions?.includes("none"),
      "Evolution must write back or explicitly record no writeback",
    );
  });

  test("SKILL.md and dev-governance.md describe Fetch before Thinking capability matching", async () => {
    const skill = await readFile("canonical/skills/meta-theory/SKILL.md");
    const devGov = await readFile(
      "canonical/skills/meta-theory/references/dev-governance.md",
    );
    const combined = `${skill}\n${devGov}`;

    assert.doesNotMatch(
      skill,
      /## Fetch-first Pattern \(Search → Match → Invoke\)|3-step capability discovery[\s\S]{0,120}keyword → search → invoke/i,
      "SKILL.md must not keep the old Fetch-first Search-Match-Invoke main flow",
    );
    assert.doesNotMatch(
      devGov,
      /Fetch — Discover Available Agents|Invoke selected agents from Stage 2|<selected agent from Stage 2>|Capability discovery \(Search–Match–Invoke\)/i,
      "dev-governance.md must not route Execution through Stage 2 selected agents",
    );
    assert.match(
      skill,
      /\| 2 \| Fetch \|[\s\S]{0,360}(?:online|联网|web)[\s\S]{0,220}(?:local|本地)[\s\S]{0,220}(?:confirm|确认)[\s\S]{0,220}(?:problem|问题)[\s\S]{0,220}(?:candidate solutions|候选解决方案)/i,
      "The SKILL.md stage table must define Fetch as online/local problem and candidate-solution research",
    );
    assert.match(
      skill,
      /\| 3 \| Thinking \|[\s\S]{0,520}determine needed execution capabilities[\s\S]{0,260}agents[\s\S]{0,160}skills[\s\S]{0,160}commands[\s\S]{0,160}MCP capabilities[\s\S]{0,160}tools[\s\S]{0,260}match existing capabilities[\s\S]{0,260}create or upgrade only for gaps[\s\S]{0,260}(?:DAG|parallel|serial)[\s\S]{0,160}mergeOwner/i,
      "The SKILL.md stage table must make Thinking the owner/skill/tool matching and orchestration stage",
    );
    assert.match(
      devGov,
      /## STAGE 4: Execution[\s\S]{0,900}agentBlueprintPacket[\s\S]{0,240}workerTaskPackets[\s\S]{0,360}(?:skills|commands|MCP|tools)/i,
      "The dev-governance Execution section must dispatch from Thinking artifacts and selected capabilities",
    );
    assert.match(
      combined,
      /Critical[\s\S]{0,240}clarif(?:y|ies)[\s\S]{0,160}intent/i,
      "Critical must explicitly clarify intent first",
    );
    assert.match(
      combined,
      /Fetch[\s\S]{0,260}(?:online|联网|web)[\s\S]{0,260}(?:local|本地)[\s\S]{0,260}(?:confirm|确认)[\s\S]{0,220}(?:problem|问题)[\s\S]{0,220}(?:candidate solutions|候选解决方案)/i,
      "Fetch must cover online/local research and confirm problem plus candidate solutions",
    );
    assert.match(
      combined,
      /Thinking[\s\S]{0,260}determine needed execution capabilities[\s\S]{0,260}agents[\s\S]{0,160}skills[\s\S]{0,160}commands[\s\S]{0,160}MCP capabilities[\s\S]{0,160}tools[\s\S]{0,260}match existing capabilities[\s\S]{0,260}create or upgrade only for gaps[\s\S]{0,260}(?:DAG|parallel|serial)[\s\S]{0,160}mergeOwner/i,
      "Thinking must first decide needed capabilities, then match/create gaps, then plan DAG/merge owner",
    );
    assert.match(
      combined,
      /Execution[\s\S]{0,260}multi-agent[\s\S]{0,260}(?:skill|command|MCP|tool)/i,
      "Execution must be multi-agent work using skills, commands, MCP capabilities, and tools",
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Part B: Hidden State Skeleton
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Part B: hidden state skeleton", async () => {
  const devGov = await readFile(
    "canonical/skills/meta-theory/references/dev-governance.md",
  );
  const spineState = await readFile(
    "canonical/skills/meta-theory/references/spine-state.md",
  );

  test("stageState progression is documented", () => {
    const stageStatePattern =
      /stageState.*Critical.*Fetch.*Thinking.*Execution.*Review.*Meta-Review.*Verification.*Evolution/s;
    assert.ok(
      stageStatePattern.test(devGov) || devGov.includes("stageState"),
      "dev-governance.md must document stageState progression",
    );
  });

  test("controlState values are documented", () => {
    const controlStates = [
      "normal",
      "skip",
      "interrupt",
      "override",
      "intentional_silence",
      "iteration",
      "degraded",
    ];
    for (const state of controlStates) {
      assert.ok(
        devGov.includes(state) && spineState.includes(state),
        `controlState value "${state}" must be documented in dev-governance.md and spine-state.md`,
      );
    }
  });

  test("gateState values are documented", () => {
    const gateStates = ["pending", "pass", "fail", "rework", "blocked"];
    for (const state of gateStates) {
      assert.ok(
        devGov.includes(state) && spineState.includes(state),
        `gateState value "${state}" must be documented in both state references`,
      );
    }
  });

  test("surfaceState values are documented", () => {
    const surfaceStates = ["silent", "notice", "decision"];
    for (const state of surfaceStates) {
      assert.ok(
        devGov.includes(state) && spineState.includes(state),
        `surfaceState value "${state}" must be documented in both state references`,
      );
    }
  });

  test("public readiness is not overloaded into surfaceState", () => {
    assert.ok(
      spineState.includes("do not overload `surfaceState` with `internal-ready` or `public-ready`"),
      "spine-state.md must separate public readiness from runtime surfaceState",
    );
  });

  test("4-state layers (stageState, controlState, gateState, surfaceState) all present", () => {
    const hasStage = devGov.includes("stageState");
    const hasControl = devGov.includes("controlState");
    const hasGate = devGov.includes("gateState");
    const hasSurface = devGov.includes("surfaceState");
    assert.ok(
      hasStage && hasControl && hasGate && hasSurface,
      "All 4 hidden state layers must be documented",
    );
  });

  test("runtime state initializes the hidden state skeleton", () => {
    const state = createInitialState({
      taskClassification: "meta_theory_auto",
      triggerReason: "test",
    });
    const sharedState = createSharedInitialState({
      taskClassification: "meta_theory_auto",
      triggerReason: "test",
    });

    for (const runtimeState of [state, sharedState]) {
      assert.equal(runtimeState.controlState, "normal");
      assert.equal(runtimeState.gateState, "pending");
      assert.equal(runtimeState.surfaceState, "silent");
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Part B2: Critical-Fetch Intent Loop
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Part B2: Critical-Fetch intent loop", async () => {
  const spineState = await readFile(
    "canonical/skills/meta-theory/references/spine-state.md",
  );

  test("createInitialState includes loop control fields", () => {
    const state = createInitialState({
      taskClassification: "meta_theory_auto",
      triggerReason: "test",
    });
    assert.equal(state.criticalFetchLoopCount, 0);
    assert.equal(state.criticalFetchLoopMax, 3);
    assert.equal(state.intentCard, null);
    assert.equal(state.intentConfirmationState, null);
    assert.equal(state.intentConfirmationTimestamp, null);
    assert.equal(state.intentCorrectionPayload, null);
  });

  test("incrementCriticalFetchLoop counts up and detects exhaustion", () => {
    const base = createInitialState({
      taskClassification: "meta_theory_auto",
      triggerReason: "test",
    });
    const round1 = incrementCriticalFetchLoop(base);
    assert.equal(round1.criticalFetchLoopCount, 1);
    assert.equal(round1.criticalFetchLoopBudgetExhausted, false);

    const round2 = incrementCriticalFetchLoop(round1);
    assert.equal(round2.criticalFetchLoopCount, 2);
    assert.equal(round2.criticalFetchLoopBudgetExhausted, false);

    const round3 = incrementCriticalFetchLoop(round2);
    assert.equal(round3.criticalFetchLoopCount, 3);
    assert.equal(round3.criticalFetchLoopBudgetExhausted, true);
  });

  test("shared runtime spine state keeps the same intent loop controls", () => {
    const base = createSharedInitialState({
      taskClassification: "meta_theory_auto",
      triggerReason: "test",
    });
    assert.equal(base.criticalFetchLoopCount, 0);
    assert.equal(base.criticalFetchLoopMax, 3);
    assert.equal(base.intentCard, null);

    const round1 = incrementSharedCriticalFetchLoop(base);
    assert.equal(round1.criticalFetchLoopCount, 1);
    assert.equal(round1.criticalFetchLoopBudgetExhausted, false);

    const confirmed = recordSharedIntentConfirmation(round1, "confirmed", null);
    assert.equal(confirmed.intentConfirmationState, "confirmed");
    assert.equal(confirmed.intentCorrectionPayload, null);
  });

  test("recordIntentConfirmation records confirmed state", () => {
    const base = createInitialState({
      taskClassification: "meta_theory_auto",
      triggerReason: "test",
    });
    const confirmed = recordIntentConfirmation(base, "confirmed", null);
    assert.equal(confirmed.intentConfirmationState, "confirmed");
    assert.ok(confirmed.intentConfirmationTimestamp);
    assert.equal(confirmed.intentCorrectionPayload, null);
  });

  test("recordIntentConfirmation records corrected state with payload", () => {
    const base = createInitialState({
      taskClassification: "meta_theory_auto",
      triggerReason: "test",
    });
    const corrected = recordIntentConfirmation(
      base,
      "corrected",
      "I meant dark mode, not light mode",
    );
    assert.equal(corrected.intentConfirmationState, "corrected");
    assert.equal(
      corrected.intentCorrectionPayload,
      "I meant dark mode, not light mode",
    );
  });

  test("spine-state.md documents the Critical-Fetch Intent Loop", () => {
    assert.ok(
      spineState.includes("Critical-Fetch Intent Loop"),
      "spine-state.md must document the Critical-Fetch Intent Loop section",
    );
    assert.ok(
      spineState.includes("criticalFetchLoopCount"),
      "spine-state.md must document criticalFetchLoopCount field",
    );
    assert.ok(
      spineState.includes("criticalFetchLoopMax"),
      "spine-state.md must document criticalFetchLoopMax field",
    );
    assert.ok(
      spineState.includes("intentCard"),
      "spine-state.md must document intentCard field",
    );
    assert.ok(
      spineState.includes("intentConfirmationState"),
      "spine-state.md must document intentConfirmationState field",
    );
  });

  test("spine-state.md documents valid confirmation states", () => {
    for (const validState of [
      "pending",
      "confirmed",
      "corrected",
      "skipped",
    ]) {
      assert.ok(
        spineState.includes(validState),
        `spine-state.md must document confirmation state "${validState}"`,
      );
    }
  });

  test("spine-state.md documents adaptive termination", () => {
    assert.ok(
      spineState.includes("earlyExitReason") ||
        spineState.includes("adaptive"),
      "spine-state.md must document adaptive loop termination",
    );
  });

  test("choice-surface-policy.json defines intentConfirmationCard", async () => {
    const policy = await readJson(
      "config/governance/choice-surface-policy.json",
    );
    assert.ok(
      policy.intentConfirmationCard,
      "choice-surface-policy.json must define intentConfirmationCard",
    );
    assert.equal(
      policy.intentConfirmationCard.cardType,
      "intent_confirmation",
    );
    assert.ok(
      policy.intentConfirmationCard.requiredFields.includes("surfaceRequest"),
    );
    assert.ok(
      policy.intentConfirmationCard.requiredFields.includes("understoodIntent"),
    );
    assert.ok(
      policy.intentConfirmationCard.confirmationStates.includes("confirmed"),
    );
    assert.ok(
      policy.intentConfirmationCard.confirmationStates.includes("corrected"),
    );
  });

  test("choice surface policy keeps canonical cards renderer-neutral", async () => {
    const policy = await readJson(
      "config/governance/choice-surface-policy.json",
    );
    assert.ok(
      policy.choiceSurfaceAdapterContract,
      "choice-surface-policy.json must define a runtime adapter contract",
    );
    assert.deepEqual(
      policy.choiceSurfaceAdapterContract.canonicalCardTypes,
      ["intent_confirmation", "pre_execution_decision"],
    );
    assert.ok(
      policy.choiceSurfaceAdapterContract.adapterMustPreserve.includes(
        "recommended default",
      ),
    );
    assert.ok(
      policy.choiceSurfaceAdapterContract.canonicalMustNotContain.includes(
        "renderer-specific payload schema",
      ),
    );
    assert.doesNotMatch(
      policy.intentConfirmationCard.surfacePreference,
      /AskUserQuestion|request_user_input/,
      "generic intent confirmation policy must not name runtime-specific tools",
    );
  });

  test("generic decision templates do not embed runtime-specific schemas", async () => {
    const decisionTemplate = await readFile(
      "canonical/templates/user-interaction/decision-template.md",
    );
    const batchTemplate = await readFile(
      "canonical/templates/user-interaction/batch-decision-template.md",
    );
    const combined = `${decisionTemplate}\n${batchTemplate}`;
    assert.doesNotMatch(
      combined,
      /AskUserQuestion Schema|request_user_input/,
      "generic user-interaction templates must not embed runtime-specific renderer schemas",
    );
    assert.match(
      combined,
      /Runtime Adapter Payload/,
      "generic templates must route renderer schemas through runtime adapters",
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Part C: Stage-Stage State Transitions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Part C: stage-state transitions are documented", async () => {
  const devGov = await readFile(
    "canonical/skills/meta-theory/references/dev-governance.md",
  );

  test("Critical → Fetch transition is documented", () => {
    // Critical feeds into Fetch; the clarity gate must pass before Fetch
    const patterns = [
      /Critical.*Fetch/i,
      /Clarity.*Gate.*Fetch/i,
      /Gate 1.*Fetch/i,
    ];
    assert.ok(
      patterns.some((p) => p.test(devGov)),
      "Critical → Fetch transition must be documented",
    );
  });

  test("Fetch → Thinking transition is documented", () => {
    // Fetch produces capability matches, then Thinking decomposes
    const patterns = [
      /Fetch.*Thinking/i,
      /capability.*Thinking/i,
      /decomposition.*after.*Fetch/i,
    ];
    assert.ok(
      patterns.some((p) => p.test(devGov)),
      "Fetch → Thinking transition must be documented",
    );
  });

  test("Thinking → Execution transition requires Stage 3 artifacts", () => {
    // Execution only starts after runHeader, taskClassification, dispatchEnvelopePacket exist
    const patterns = [
      /Execution.*after.*Thinking/i,
      /Stage 3 artifacts.*before.*Execution/i,
      /runHeader.*dispatchEnvelope/i,
    ];
    assert.ok(
      patterns.some((p) => p.test(devGov)),
      "Thinking → Execution transition requires Stage 3 artifacts",
    );
  });

  test("Review → Meta-Review → Verification chain is documented", () => {
    const patterns = [
      /Review.*Meta-Review.*Verification/s,
      /Meta-Review.*Verification.*Evolution/s,
      /verification.*Evolution/i,
    ];
    assert.ok(
      patterns.some((p) => p.test(devGov)),
      "Review → Meta-Review → Verification chain must be documented",
    );
  });

  test("Evolution is always the final stage", () => {
    // Evolution closes the loop; nothing comes after it as a normal stage
    // It can reference other stages (→ meta-warden synthesis, → scar protocol) but
    // the 8-stage spine ends at Evolution
    const evolutionSection = devGov.match(/Evolution[\s\S]{0,800}/);
    assert.ok(evolutionSection, "Evolution section must exist");
    // Verify Evolution is documented as the terminal stage of the spine
    // by checking the stageState progression ends with Evolution
    const hasTerminalEvolution =
      devGov.includes("Verification") &&
      devGov.includes("Evolution") &&
      (devGov.match(/stageState.*Evolution/s) !== null ||
        devGov.match(/Evolution.*→/s) !== null ||
        devGov.match(
          /stageState.*critical.*fetch.*thinking.*execution.*review.*meta.review.*verification.*evolution/gi,
        ) !== null);
    assert.ok(
      hasTerminalEvolution,
      "Evolution must be documented as the terminal stage of the 8-stage spine",
    );
  });

  test("skip/interrupt/iteration control transitions are documented", () => {
    const patterns = [
      /controlState.*skip/i,
      /skip.*stage/i,
      /interrupt.*stage/i,
      /iteration.*stage/i,
    ];
    let found = 0;
    for (const p of patterns) {
      if (p.test(devGov)) found++;
    }
    assert.ok(
      found >= 2,
      "Skip/interrupt/iteration transitions must be documented",
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Part D: Protocol Packets Per Stage
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Part D: required protocol packets per stage", async () => {
  const contract = await readJson("config/contracts/workflow-contract.json");

  const STAGE_PACKETS = {
    Critical: ["runHeader", "taskClassification"],
    Fetch: ["fetchPacket"],
    Thinking: [
      "cardPlanPacket",
      "dispatchEnvelopePacket",
      "orchestrationTaskBoardPacket",
      "businessFlowBlueprintPacket",
      "agentBlueprintPacket",
    ],
    Execution: ["workerTaskPacket", "workerResultPacket"],
    Review: ["reviewPacket"],
    Verification: ["verificationPacket"],
    Evolution: ["evolutionWritebackPacket"],
  };

  // Meta-Review doesn't produce its own packet; it reviews the review standards

  for (const [stage, packets] of Object.entries(STAGE_PACKETS)) {
    for (const packet of packets) {
      test(`protocols.${packet} exists (produced at stage: ${stage})`, () => {
        assert.ok(
          contract.protocols?.[packet] !== undefined,
          `protocols.${packet} must exist (produced at stage: ${stage})`,
        );
        assert.ok(
          contract.protocols?.[packet]?.requiredFields?.length > 0,
          `protocols.${packet} must have requiredFields`,
        );
      });
    }
  }

  test("Meta-Review reviews the reviewPacket, not a separate packet", () => {
    // Meta-Review is the review-of-review; it doesn't define a new protocol
    // but operates on the reviewPacket from Stage 5
    const hasMetaReviewDocs =
      contract.protocols?.reviewPacket?.description?.includes("Meta-Review") ||
      contract.businessWorkflow?.phases?.includes("meta_review");
    assert.ok(
      hasMetaReviewDocs,
      "Meta-Review should be referenced in reviewPacket description or phases",
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Part E: Full Run Artifact — All 8 Stage Products Present
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Part E: valid run artifact contains all 8-stage products", async () => {
  test("valid-run.json fixture contains runHeader", async () => {
    const fixture = await readJson(
      "tests/fixtures/run-artifacts/valid-run.json",
    );
    assert.ok(fixture.runHeader, "valid-run.json must have runHeader");
    assert.ok(fixture.runHeader.department, "runHeader must have department");
    assert.ok(
      fixture.runHeader.primaryDeliverable,
      "runHeader must have primaryDeliverable",
    );
  });

  test("valid-run.json fixture contains taskClassification", async () => {
    const fixture = await readJson(
      "tests/fixtures/run-artifacts/valid-run.json",
    );
    assert.ok(
      fixture.taskClassification,
      "valid-run.json must have taskClassification",
    );
    assert.ok(
      fixture.taskClassification.governanceFlow,
      "taskClassification must have governanceFlow",
    );
  });

  test("valid-run.json fixture contains fetchPacket", async () => {
    const fixture = await readJson(
      "tests/fixtures/run-artifacts/valid-run.json",
    );
    assert.ok(fixture.fetchPacket, "valid-run.json must have fetchPacket");
    assert.ok(
      fixture.fetchPacket.capabilityMatches !== undefined,
      "fetchPacket must have capabilityMatches",
    );
  });

  test("valid-run.json fixture contains cardPlanPacket", async () => {
    const fixture = await readJson(
      "tests/fixtures/run-artifacts/valid-run.json",
    );
    assert.ok(
      fixture.cardPlanPacket,
      "valid-run.json must have cardPlanPacket",
    );
    assert.ok(fixture.cardPlanPacket.cardEvents, "cardPlanPacket must have cardEvents");
    assert.ok(fixture.cardPlanPacket.cardTypeCatalog, "cardPlanPacket must have cardTypeCatalog");
    assert.ok(
      fixture.cardPlanPacket.cardTypeDecisions,
      "cardPlanPacket must have cardTypeDecisions",
    );
  });

  test("valid-run.json fixture contains dispatchEnvelopePacket", async () => {
    const fixture = await readJson(
      "tests/fixtures/run-artifacts/valid-run.json",
    );
    assert.ok(
      fixture.dispatchEnvelopePacket,
      "valid-run.json must have dispatchEnvelopePacket",
    );
    assert.ok(
      fixture.dispatchEnvelopePacket.ownerAgent,
      "dispatchEnvelopePacket must have ownerAgent",
    );
  });

  test("valid-run.json fixture contains orchestrationTaskBoardPacket", async () => {
    const fixture = await readJson(
      "tests/fixtures/run-artifacts/valid-run.json",
    );
    assert.ok(
      fixture.orchestrationTaskBoardPacket,
      "valid-run.json must have orchestrationTaskBoardPacket",
    );
    assert.ok(
      fixture.orchestrationTaskBoardPacket.tasks,
      "orchestrationTaskBoardPacket must have tasks",
    );
  });

  test("valid-run.json fixture contains workerTaskPacket(s)", async () => {
    const fixture = await readJson(
      "tests/fixtures/run-artifacts/valid-run.json",
    );
    assert.ok(
      fixture.workerTaskPackets || fixture.workerTaskPacket,
      "valid-run.json must have workerTaskPacket(s)",
    );
  });

  test("valid-run.json fixture contains reviewPacket", async () => {
    const fixture = await readJson(
      "tests/fixtures/run-artifacts/valid-run.json",
    );
    assert.ok(fixture.reviewPacket, "valid-run.json must have reviewPacket");
    assert.ok(fixture.reviewPacket.findings, "reviewPacket must have findings");
  });

  test("valid-run.json fixture contains verificationPacket", async () => {
    const fixture = await readJson(
      "tests/fixtures/run-artifacts/valid-run.json",
    );
    assert.ok(
      fixture.verificationPacket,
      "valid-run.json must have verificationPacket",
    );
    assert.ok(
      fixture.verificationPacket.verified !== undefined,
      "verificationPacket must have verified",
    );
  });

  test("valid-run.json fixture contains summaryPacket", async () => {
    const fixture = await readJson(
      "tests/fixtures/run-artifacts/valid-run.json",
    );
    assert.ok(fixture.summaryPacket, "valid-run.json must have summaryPacket");
    assert.ok(
      fixture.summaryPacket.publicReady !== undefined,
      "summaryPacket must have publicReady",
    );
  });

  test("valid-run.json fixture contains evolutionWritebackPacket", async () => {
    const fixture = await readJson(
      "tests/fixtures/run-artifacts/valid-run.json",
    );
    assert.ok(
      fixture.evolutionWritebackPacket,
      "valid-run.json must have evolutionWritebackPacket",
    );
    assert.ok(
      fixture.evolutionWritebackPacket.writebackDecision !== undefined,
      "evolutionWritebackPacket must have writebackDecision",
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Part F: Gate State Enforcement
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Part F: gate state enforcement", async () => {
  const contract = await readJson("config/contracts/workflow-contract.json");

  test("planning gate owner is meta-conductor", () => {
    assert.equal(contract.gates?.planning?.owner, "meta-conductor");
  });

  test("planning gate has pass and rework tokens", () => {
    assert.equal(contract.gates?.planning?.passToken, "Pass");
    assert.equal(
      contract.gates?.planning?.reworkToken,
      "Requires Re-scheduling",
    );
  });

  test("verification gate owners are meta-warden and meta-prism", () => {
    const owners = contract.gates?.verify?.owners ?? [];
    assert.ok(
      owners.includes("meta-warden"),
      "verify gate must include meta-warden",
    );
    assert.ok(
      owners.includes("meta-prism"),
      "verify gate must include meta-prism",
    );
  });

  test("metaReview gate owners are meta-warden and meta-prism", () => {
    const owners = contract.gates?.metaReview?.owners ?? [];
    assert.ok(
      owners.includes("meta-warden"),
      "metaReview gate must include meta-warden",
    );
    assert.ok(
      owners.includes("meta-prism"),
      "metaReview gate must include meta-prism",
    );
  });

  test("summary gate requires verified run", () => {
    assert.equal(contract.gates?.summary?.requiresVerifiedRun, true);
  });

  test("publicDisplay gate is a hard release gate", () => {
    const gate = contract.gates?.publicDisplay ?? {};
    assert.equal(gate.hardReleaseGate, true);
    assert.ok(
      gate.blockFinalDraftWithoutVerifiedRun,
      "must block without verified run",
    );
    assert.ok(
      gate.blockExternalDisplayWithoutSummaryClosure,
      "must block without summary closure",
    );
    assert.ok(
      gate.blockCompletionWithoutClosedDeliverableChain,
      "must block without deliverable chain",
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Part F2: Choice Surface Runtime Gate
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Part F2: choice surface runtime gate", async () => {
  test("generated and canonical Codex PreToolUse wiring share exact spawn and followup matchers", async () => {
    const hooksJson = buildCodexHooksJson();
    const dispatchHook = hooksJson.hooks.PreToolUse.find((entry) =>
      entry.hooks?.some((hook) =>
        String(hook.command ?? "").includes("enforce-agent-dispatch.mjs"),
      ),
    );

    assert.ok(dispatchHook, "Codex hooks.json must wire the dispatch enforcement hook");
    assert.match(dispatchHook.matcher, /(?:^|\|)spawn_agent(?:\||$)/u);
    assert.match(dispatchHook.matcher, /(?:^|\|)followup_task(?:\||$)/u);
    assert.match(dispatchHook.matcher, /collaboration\\\.spawn_agent/u);
    assert.match(dispatchHook.matcher, /collaboration\\\.followup_task/u);

    const canonicalHooksJson = await readJson(
      "canonical/runtime-assets/codex/hooks.json",
    );
    const canonicalDispatchHook = canonicalHooksJson.hooks.PreToolUse.find((entry) =>
      entry.hooks?.some((hook) =>
        String(hook.command ?? "").includes("enforce-agent-dispatch.mjs"),
      ),
    );

    assert.ok(
      canonicalDispatchHook,
      "canonical Codex hooks.json must wire the dispatch enforcement hook",
    );
    assert.equal(canonicalDispatchHook.matcher, dispatchHook.matcher);
    assert.match(canonicalDispatchHook.matcher, /collaboration\\\.spawn_agent/u);
    assert.match(canonicalDispatchHook.matcher, /collaboration\\\.followup_task/u);
  });

  test("auto prompt activation creates observed advisory state instead of managed hard-gate state", () => {
    const prompt = "critical and fetch thinking and review 帮我修复 hook 反复卡住的问题";
    const { result, nextState } = runActivateHook(null, { prompt });

    assert.equal(result.status, 0);
    assert.equal(nextState.stageRuntimeControl?.activationMode, "hook_observed");
    assert.equal(nextState.stageRuntimeControl?.driverMode, "hook_observed");
    assert.equal(nextState.stageRuntimeControl?.hookGateMode, "advisory");
    assert.equal(nextState.stageRuntimeControl?.userLanguage, "zh-CN");
    assert.ok(nextState.stageRuntimeControl?.promptFingerprint);
    assert.equal(nextState.taskFingerprint, nextState.stageRuntimeControl.promptFingerprint);
    assert.match(nextState.taskFingerprint, /^hmac-sha256:[a-f0-9]{64}$/u);
    assert.equal(nextState.taskIdentitySource, "project_profile_hmac_sha256");
    assert.equal("task" in nextState, false);
    assert.equal(nextState.stageRuntimeControl?.factGatePolicy, "managed_gate_required_for_public_ready");
    assert.equal(nextState.stageRuntimeControl?.dispatchMode, "fanout_eligible");
    assert.equal(nextState.currentStage, "critical");
    assert.notEqual(nextState.fetchRecord?.capabilitySearchPerformed, true);
    assert.equal(nextState.stageRuntimeControl?.fanoutEligibilityEvidence, "prompt_signal_only");
  });

  test("ordinary multi-scope durable work becomes fanout eligible without agent wording", () => {
    const { result, nextState } = runActivateHook(null, {
      prompt:
        "请制定并落地发布方案，核对依赖来源、跨环境兼容性、发布安全和验收方法，创建 release-readiness-plan.md。",
    });

    assert.equal(result.status, 0);
    assert.equal(nextState.triggerReason, "natural_language_durable_work");
    assert.equal(nextState.stageRuntimeControl?.dispatchMode, "fanout_eligible");
    assert.equal(nextState.currentStage, "critical");
    assert.notEqual(nextState.fetchRecord?.capabilitySearchPerformed, true);
  });

  test("auto prompt activation does not create command-class publish approvals", () => {
    for (const runtime of ["shared", "claude"]) {
      const { result, nextState } = runActivateHook(
        null,
        {
          prompt:
            "critical and fetch thinking and review 提交 推送 发布新版本 更新更新说明",
        },
        { runtime },
      );

      assert.equal(result.status, 0, `${runtime}: ${result.stderr}`);
      assert.equal(nextState.stageRuntimeControl?.activationMode, "hook_observed");
      assert.equal(nextState.stageRuntimeControl?.externalPublishIntent, undefined);
    }
  });

  test("auto prompt activation rotates stale legacy active state for a new prompt", () => {
    const legacyBase = createInitialState({
      taskClassification: "meta_theory_auto",
      triggerReason: "legacy-test",
    });
    const legacy = {
      ...legacyBase,
      runId: "meta-stale-legacy",
      triggeredAt: "2000-01-01T00:00:00.000Z",
      // Supersede bookkeeping is only observable on a run that earned a durable
      // entry, so the stale run carries the completed stage that earns one.
      stages: {
        ...legacyBase.stages,
        critical: { status: "completed", completedAt: "2000-01-01T00:00:00.000Z" },
      },
    };
    delete legacy.stageRuntimeControl;

    const { result, nextState, activeRunStatus, previousRunStatus } = runActivateHook(legacy, {
      prompt: "critical and fetch thinking and review 请继续修复新的任务",
    });

    assert.equal(result.status, 0);
    assert.notEqual(nextState.runId, "meta-stale-legacy");
    assert.equal(nextState.stageRuntimeControl?.hookGateMode, "advisory");
    assert.equal(previousRunStatus.active, false);
    assert.equal(previousRunStatus.lifecycleStatus, "superseded");
    assert.equal(previousRunStatus.deactivationReason, "superseded_by_new_prompt");
    assert.equal(previousRunStatus.supersededByRunId, nextState.runId);
    assert.equal(activeRunStatus.runId, nextState.runId);
    assert.equal(activeRunStatus.active, true);
  });

  test("same-prompt activation is idempotent and managed replacement stays conservative", () => {
    const prompt = "critical and fetch thinking and review repair the runtime hook";
    const observed = createInitialState({
      taskClassification: "meta_theory_auto",
      triggerReason: "same-prompt-test",
      activationMode: "hook_observed",
      driverMode: "hook_observed",
      hookGateMode: "advisory",
      promptFingerprint: "5aeaf6fceca2f9ef",
      taskFingerprint: `hmac-sha256:${"a".repeat(64)}`,
      taskIdentitySource: "project_profile_hmac_sha256",
    });
    // Use the activator to obtain its exact fingerprint, then replay that state.
    const first = runActivateHook(null, { prompt });
    const replay = runActivateHook(first.nextState, { prompt }, {
      taskIdentityKey: first.taskIdentityKey,
    });
    assert.equal(replay.result.status, 0, replay.result.stderr);
    assert.equal(replay.nextState.runId, first.nextState.runId);
    assert.equal(replay.activeRunStatus.runId, first.nextState.runId);
    assert.equal(replay.activeRunStatus.active, true);
    assert.equal(
      replay.previousRunStatus,
      null,
      "both activations stayed at Critical, so neither earned a run directory entry",
    );

    const managed = {
      ...observed,
      runId: "meta-managed-authoritative",
      stageRuntimeControl: {
        ...observed.stageRuntimeControl,
        activationMode: "managed_stage_runtime",
        driverMode: "managed",
        hookGateMode: "block",
      },
    };
    const conservative = runActivateHook(managed, {
      prompt: `${prompt} with a different prompt`,
    }, {
      taskIdentityKey: first.taskIdentityKey,
    });
    assert.equal(conservative.result.status, 0, conservative.result.stderr);
    assert.equal(conservative.nextState.runId, managed.runId);
  });

  test("a stopped activation-only run about the same task is reused instead of re-minted", () => {
    const prompt = "critical and fetch thinking and review 请继续排查同一个任务的挂载问题";
    const first = runActivateHook(null, { prompt });
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.match(first.nextState.taskFingerprint, /^hmac-sha256:[0-9a-f]{64}$/u);

    const stopped = {
      ...first.nextState,
      active: false,
      lifecycleStatus: "session_stopped",
      deactivatedAt: new Date().toISOString(),
      deactivationReason: "session_stop",
    };
    const reused = runActivateHook(stopped, { prompt }, {
      taskIdentityKey: first.taskIdentityKey,
    });

    assert.equal(reused.result.status, 0, reused.result.stderr);
    assert.equal(
      reused.nextState.runId,
      first.nextState.runId,
      "repeated prompts about one task collapse onto one run id, not one id per prompt",
    );
    assert.deepEqual(reused.nextState.stageRuntimeControl.runIdentityReuse, {
      basis: "same_task_fingerprint_activation_only_run",
      previousStage: "critical",
      previousDeactivationReason: "session_stop",
      previousSubstanceClass: "activation_only",
    });
    assert.equal(reused.nextState.continuationBoundary, undefined);
  });

  test("a stopped run that produced work keeps its own id and history", () => {
    const prompt = "critical and fetch thinking and review 请继续排查同一个任务的挂载问题";
    const first = runActivateHook(null, { prompt });
    assert.equal(first.result.status, 0, first.result.stderr);

    const stoppedWithWork = {
      ...first.nextState,
      active: false,
      lifecycleStatus: "session_stopped",
      deactivatedAt: new Date().toISOString(),
      deactivationReason: "session_stop",
      stages: {
        ...first.nextState.stages,
        critical: { status: "completed", completedAt: new Date().toISOString() },
      },
    };
    const fresh = runActivateHook(stoppedWithWork, { prompt }, {
      taskIdentityKey: first.taskIdentityKey,
    });

    assert.equal(fresh.result.status, 0, fresh.result.stderr);
    assert.notEqual(
      fresh.nextState.runId,
      first.nextState.runId,
      "a run that completed a stage owns durable history a new activation must not overwrite",
    );
    assert.equal(fresh.nextState.stageRuntimeControl.runIdentityReuse, undefined);
    assert.equal(fresh.previousRunStatus.runId, first.nextState.runId);
    assert.equal(fresh.previousRunStatus.substanceClass, "substantive");
  });

  test("a different task never reuses a stopped activation-only run id", () => {
    const first = runActivateHook(null, {
      prompt: "critical and fetch thinking and review 请处理第一个任务",
    });
    const stopped = {
      ...first.nextState,
      active: false,
      lifecycleStatus: "session_stopped",
      deactivatedAt: new Date().toISOString(),
      deactivationReason: "session_stop",
    };
    const other = runActivateHook(stopped, {
      prompt: "critical and fetch thinking and review 请处理另一个完全不同的任务",
    }, { taskIdentityKey: first.taskIdentityKey });

    assert.equal(other.result.status, 0, other.result.stderr);
    assert.notEqual(other.nextState.runId, first.nextState.runId);
    assert.equal(other.nextState.stageRuntimeControl.runIdentityReuse, undefined);
  });

  test("production hook preserves an HMAC-bound run when its identity key is missing or corrupt", () => {
    const cwd = mkdtempSync(join(tmpdir(), "meta-kim-identity-recovery-"));
    try {
      const hookDir = join(cwd, "hooks");
      mkdirSync(hookDir, { recursive: true });
      mkdirSync(join(cwd, ".git"), { recursive: true });
      copyHookClosure(REPO_ROOT, hookDir, ["activate-meta-theory-spine.mjs"]);
      const prompt = "元理论：继续处理当前任务";
      const invoke = () => spawnSync(
        process.execPath,
        [join(hookDir, "activate-meta-theory-spine.mjs")],
        {
          cwd,
          input: JSON.stringify({ prompt }),
          encoding: "utf8",
          env: {
            ...process.env,
            META_KIM_SPINE_STATE_DIR: ".meta-kim/state/test/spine",
          },
        },
      );
      const first = invoke();
      assert.equal(first.status, 0, first.stderr);

      const stateRoot = join(cwd, ".meta-kim", "state", "test");
      const spinePath = join(stateRoot, "spine", "spine-state.json");
      const activePath = join(stateRoot, "active-run.json");
      const keyPath = join(stateRoot, "private", "task-identity-key.json");
      const originalSpineBytes = readFileSync(spinePath, "utf8");
      const originalRunId = JSON.parse(originalSpineBytes).runId;
      const runStatusPath = join(stateRoot, "runs", originalRunId, "status.json");
      const originalActiveBytes = readFileSync(activePath, "utf8");
      // A bare activation earns no directory entry, so "state unchanged" here also
      // means no entry appears on the recovery paths below.
      assert.equal(existsSync(runStatusPath), false);

      unlinkSync(keyPath);
      const missing = invoke();
      assert.equal(missing.status, 0, missing.stderr);
      assert.match(missing.stderr, /task-identity-key-missing/u);
      assert.match(missing.stderr, /保持原运行不变/u);
      assert.equal(readFileSync(spinePath, "utf8"), originalSpineBytes);
      assert.equal(readFileSync(activePath, "utf8"), originalActiveBytes);
      assert.equal(existsSync(runStatusPath), false);
      assert.equal(existsSync(keyPath), false);

      const corruptKeyBytes = "{broken-key";
      writeFileSync(keyPath, corruptKeyBytes, "utf8");
      const corrupt = invoke();
      assert.equal(corrupt.status, 0, corrupt.stderr);
      assert.match(corrupt.stderr, /task-identity-key-invalid/u);
      assert.match(corrupt.stderr, /保持原运行不变/u);
      assert.equal(readFileSync(spinePath, "utf8"), originalSpineBytes);
      assert.equal(readFileSync(activePath, "utf8"), originalActiveBytes);
      assert.equal(existsSync(runStatusPath), false);
      assert.equal(readFileSync(keyPath, "utf8"), corruptKeyBytes);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("continuation wording after session_stop records inactive-run boundary", () => {
    for (const runtime of ["shared", "claude"]) {
      const stopped = {
        ...createInitialState({
          taskClassification: "meta_theory_auto",
          triggerReason: "previous-test",
        }),
        active: false,
        lifecycleStatus: "session_stopped",
        runId: "meta-stopped-session",
        currentStage: "critical",
        deactivatedAt: "2026-06-20T18:27:05.423Z",
        deactivationReason: "session_stop",
      };

      const { result, nextState } = runActivateHook(
        stopped,
        {
          prompt:
            "继续当前 active run，不退出、不重启 critical and fetch thinking and review",
        },
        { runtime },
      );

      assert.equal(result.status, 0, `${runtime}: ${result.stderr}`);
      assert.equal(nextState.active, true);
      assert.notEqual(nextState.runId, "meta-stopped-session");
      assert.equal(
        nextState.continuationBoundary?.mode,
        "session_stop_continuation_request",
      );
      assert.equal(nextState.continuationBoundary?.previousRunId, "meta-stopped-session");
      assert.equal(nextState.continuationBoundary?.previousActive, false);
      assert.match(
        nextState.continuationBoundary?.authority,
        /HookPrompt may preserve/,
      );
    }
  });

  test("shared and Claude activation recognize broad continuation wording consistently", () => {
    for (const runtime of ["shared", "claude"]) {
      for (const prompt of [
        "继续当前 run，不退出、不重启 critical and fetch thinking and review",
        "resume same run and continue critical and fetch thinking and review",
      ]) {
        const stopped = {
          ...createInitialState({
            taskClassification: "meta_theory_auto",
            triggerReason: "previous-test",
          }),
          active: false,
          lifecycleStatus: "session_stopped",
          runId: "meta-stopped-session",
          currentStage: "critical",
          deactivatedAt: "2026-06-20T18:27:05.423Z",
          deactivationReason: "session_stop",
        };

        const { result, nextState } = runActivateHook(
          stopped,
          { prompt },
          { runtime },
        );

        assert.equal(result.status, 0, `${runtime}: ${result.stderr}`);
        assert.equal(nextState.active, true);
        assert.notEqual(nextState.runId, "meta-stopped-session");
        assert.equal(
          nextState.continuationBoundary?.mode,
          "session_stop_continuation_request",
          `${runtime} failed prompt: ${prompt}`,
        );
        assert.equal(nextState.continuationBoundary?.previousRunId, "meta-stopped-session");
      }
    }
  });

  test("Fetch in progress does not require fetchRecord until stage commit", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
    };

    const inProgress = checkStageRequirements(state);
    assert.equal(inProgress.met, true);

    const commit = checkStageRequirements({
      ...state,
      stageTransitionIntent: "commit",
    });
    assert.equal(commit.met, false);
    assert.deepEqual(commit.missing, ["fetchRecord in spine state"]);
  });

  test("Fetch and Thinking in progress do not require Agent dispatch", () => {
    for (const stage of ["fetch", "thinking"]) {
      const state = {
        ...createInitialState({
          taskClassification: "meta_theory_auto",
          triggerReason: "test",
        }),
        currentStage: stage,
        dispatchChain: {},
      };
      delete state.fetchRecord;

      const requirements = checkStageRequirements(state);
      assert.equal(requirements.met, true, `${stage} should be in-progress ready`);

      const governanceDispatch = runEnforceHook(state, {
        tool_name: "Agent",
        tool_input: {
          description: `meta-artisan ${stage} capability discovery`,
          prompt: `meta-artisan continue ${stage} evidence collection`,
        },
      });
      assert.equal(governanceDispatch.status, 0);
      assert.doesNotMatch(governanceDispatch.stdout, /permissionDecision/);
    }
  });

  test("Type-first route policy is a route selection invariant, not another gate", async () => {
    const contract = await readJson(
      "config/contracts/stage-runtime-control-contract.json",
    );

    assert.equal(
      contract.routeSelectionPolicy?.typeFirstRouteRef,
      "scripts/select-execution-route.mjs#typeFirstRoutePolicy",
    );
    assert.equal(contract.routeSelectionPolicy?.kind, "route_selection_invariant");
    assert.equal(contract.routeSelectionPolicy?.mustNotBecomeNewGate, true);
    assert.equal(
      contract.routeSelectionPolicy?.unclearTypeDisposition,
      "degrade_or_block_not_guess",
    );
    assert.equal(contract.controlPlaneRules?.hookRole, "last_resort_fuse");
  });

  test("observed hook state allows ordinary local file mutation without notice", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
        activationMode: "hook_observed",
        driverMode: "hook_observed",
        hookGateMode: "advisory",
        latestUserInputLanguage: "zh-CN",
      }),
      currentStage: "critical",
    };

    const { result, updatedState } = runEnforceHookWithState(state, {
      tool_name: "Write",
      tool_input: {
        file_path: "src/main.go",
        content: "package main\n",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
    assert.equal(result.stderr, "");
    assert.equal(updatedState.stageRuntimeControl?.observedNoticeEmittedAt, undefined);
  });

  test("observed hook state does not block commands by keyword or command class", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
        activationMode: "hook_observed",
        driverMode: "hook_observed",
        hookGateMode: "advisory",
        latestUserInputLanguage: "zh-CN",
      }),
      currentStage: "critical",
    };

    for (const command of [
      "git add CHANGELOG.md",
      "git commit -m \"test local publication checkpoint\"",
      "git tag v2.8.99",
      "git fetch origin",
      "git pull --rebase origin main",
      "git push origin main",
      "git push --force origin main",
      "git merge feature/example",
      "git rebase main",
      "git checkout -- README.md",
      "git restore .",
      "git reset --hard HEAD",
      "git clean -fdx",
      "git rm stale.txt",
      "git mv old.txt new.txt",
      "bash -lc \"git push origin main\"",
      "npm install left-pad",
      "npm publish",
      "Remove-Item -LiteralPath tmp -Recurse -Force",
      "rm -rf tmp",
      "gh release create v2.8.54 --title v2.8.54 --notes-file CHANGELOG.md",
      "gh api repos/KimYx0207/Meta_Kim/git/refs/heads/main -X DELETE",
      "Invoke-RestMethod -Method Delete -Uri \"https://api.github.com/repos/KimYx0207/Meta_Kim/git/refs/heads/main\"",
      "Invoke-Expression \"Write-Output hello\"",
      "curl -X POST https://example.com",
    ]) {
      const result = runEnforceHook(state, {
        tool_name: "Bash",
        tool_input: { command },
      });
      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stdout, /permissionDecision/);
    }
  });

  test("observed hook state keeps command execution advisory even when text contains high-risk words", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
        activationMode: "hook_observed",
        driverMode: "hook_observed",
        hookGateMode: "advisory",
        latestUserInputLanguage: "zh-CN",
      }),
      currentStage: "critical",
    };

    for (const command of [
      "graphify query \"Meta_Kim hook blocks git push and gh release during release\" --budget 1000",
      "rg \"git push origin main\" canonical tests",
      "Get-Content CHANGELOG.md | Select-String \"gh release create\"",
    ]) {
      const result = runEnforceHook(state, {
        tool_name: "Bash",
        tool_input: { command },
      });

      assert.equal(result.status, 0, command);
      assert.doesNotMatch(result.stdout, /permissionDecision/, command);
    }
  });

  test("observed hook state allows PowerShell here-string and execution-shaped commands", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
        activationMode: "hook_observed",
        driverMode: "hook_observed",
        hookGateMode: "advisory",
        latestUserInputLanguage: "zh-CN",
      }),
      currentStage: "critical",
    };

    const notesResult = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command:
          "@'\ngit push origin main\ngh release create v2.8.55\n'@ | Set-Content -LiteralPath '.meta-kim\\state\\default\\release-notes.md' -Encoding UTF8",
      },
    });

    assert.equal(notesResult.status, 0);
    assert.doesNotMatch(notesResult.stdout, /permissionDecision/);

    const executionResult = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "@'\ngit push origin main\n'@ | Invoke-Expression",
      },
    });

    assert.equal(executionResult.status, 0);
    assert.doesNotMatch(executionResult.stdout, /permissionDecision/);

    const shellWrapperResult = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "bash -lc \"git push origin main\"",
      },
    });

    assert.equal(shellWrapperResult.status, 0);
    assert.doesNotMatch(shellWrapperResult.stdout, /permissionDecision/);
  });

  test("observed hook state allows PowerShell read-only pipelines", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
        activationMode: "hook_observed",
        driverMode: "hook_observed",
        hookGateMode: "advisory",
        latestUserInputLanguage: "zh-CN",
      }),
      currentStage: "critical",
    };

    const result = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command:
          "Get-Content tests\\setup\\install-plugin-bundles.test.mjs | Select-Object -First 40",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("observed hook state keeps Node eval scripts advisory", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
        activationMode: "hook_observed",
        driverMode: "hook_observed",
        hookGateMode: "advisory",
        latestUserInputLanguage: "zh-CN",
      }),
      currentStage: "fetch",
    };

    const readOnlyResult = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command:
          "node -e \"const fs=require('fs'); const raw=fs.readFileSync('graphify-out/graph.json','utf8'); const graph=JSON.parse(raw); console.log((graph.nodes||[]).length);\"",
      },
    });

    assert.equal(readOnlyResult.status, 0);
    assert.doesNotMatch(readOnlyResult.stdout, /permissionDecision/);

    const writeResult = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command:
          "node -e \"const fs=require('fs'); fs.writeFileSync('tmp.txt','mutated');\"",
      },
    });

    assert.equal(writeResult.status, 0);
    assert.doesNotMatch(writeResult.stdout, /permissionDecision/);
  });

  test("observed hook state treats install-looking paths as ordinary command text", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
        activationMode: "hook_observed",
        driverMode: "hook_observed",
        hookGateMode: "advisory",
        latestUserInputLanguage: "zh-CN",
      }),
      currentStage: "critical",
    };

    const result = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "node --test tests/setup/install-plugin-bundles.test.mjs",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("initial Critical state does not allow execution confirmation", () => {
    const state = createInitialState({
      taskClassification: "meta_theory_auto",
      triggerReason: "test",
    });

    const result = checkChoiceSurfaceGate(state);
    assert.equal(state.choiceSurfaceState, "not_allowed");
    assert.equal(result.met, true);
  });

  test("blocks execution confirmation before Fetch and Thinking evidence", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
      choiceSurfaceState: "completed",
    };

    const result = checkChoiceSurfaceGate(state);
    assert.equal(result.met, false);
    assert.match(result.reason, /before Fetch and Thinking completed/);
  });

  test("blocks Execution when confirmation was offered but not completed", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "execution",
      dispatchedAgents: ["frontend"],
      fetchRecord: { capabilityMatches: ["frontend"] },
      preDecisionOptionFrame: {
        candidatePaths: ["direct hook enforcement", "contract-only guard"],
      },
      choiceSurfaceState: "execution_confirmation_allowed",
    };

    const result = checkStageRequirements(state);
    assert.equal(result.met, false);
    assert.deepEqual(result.missing, ["choiceSurfaceState=completed"]);
  });

  test("allows Execution when key behavior evidence exists but optional design packets are incomplete", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...minimalNodeBindings(),
      currentStage: "execution",
      dispatchedAgents: ["frontend"],
      preDecisionOptionFrame: {
        candidatePaths: ["direct hook enforcement", "contract-only guard"],
      },
      choiceSurfaceState: "completed",
    };

    const result = checkStageRequirements(state);
    assert.equal(result.met, true);
  });

  test("allows Execution after Fetch, Thinking, and complete design-time packets", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...completePreExecutionBindings(),
      currentStage: "execution",
      dispatchedAgents: ["frontend"],
      preDecisionOptionFrame: {
        candidatePaths: ["direct hook enforcement", "contract-only guard"],
      },
      choiceSurfaceState: "completed",
    };

    const result = checkStageRequirements(state);
    assert.equal(result.met, true);
  });

  test("allows Execution with generalized capability bindings without matchedSkills", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...modernCapabilityNodeBindings(),
      currentStage: "execution",
      dispatchedAgents: ["frontend"],
      preDecisionOptionFrame: {
        candidatePaths: ["command binding", "skill binding"],
      },
      choiceSurfaceState: "completed",
    };

    const result = checkStageRequirements(state);
    assert.equal(result.met, true);
  });

  test("blocks Execution when key intent evidence is missing", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...preExecutionReadinessPacketsOnly(),
      currentStage: "execution",
      dispatchedAgents: ["meta-conductor"],
      fetchRecord: {
        capabilitySearchPerformed: true,
        capabilityMatches: ["backend"],
      },
      preDecisionOptionFrame: {
        candidatePaths: ["direct hook enforcement", "contract-only guard"],
      },
      choiceSurfaceState: "completed",
    };
    delete state.intentPacket;

    const result = checkStageRequirements(state);
    assert.equal(result.met, false);
    assert.match(result.reason, /key behavior evidence/i);
    assert.ok(
      result.missing.includes(
        "intent signal (intentPacket or realIntent + successCriteria)",
      ),
    );
  });

  test("does not hard-block Execution on optional worker-role binding mismatch", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...minimalNodeBindings(),
    };
    state.workerTaskPackets[0].businessRoleId = "frontend";

    const result = checkCapabilityNodeBindings(state);
    assert.equal(result.met, true);
  });

  test("does not hard-block Execution on optional worker work-order fields", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...minimalNodeBindings(),
    };
    state.workerTaskPackets[0].evidenceRefs = [];
    delete state.workerTaskPackets[0].handoffContract;
    delete state.workerTaskPackets[0].workType;

    const result = checkCapabilityNodeBindings(state);
    assert.equal(result.met, true);
  });

  test("blocks Execution when candidates exist but owner loadout is not selected", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...minimalNodeBindings(),
    };
    delete state.workerTaskPackets[0].capabilityRequirements;
    delete state.workerTaskPackets[0].toolRequirements;
    delete state.workerTaskPackets[0].skillRequirements;
    delete state.workerTaskPackets[0].commandRequirements;
    delete state.workerTaskPackets[0].mcpRequirements;
    delete state.workerTaskPackets[0].abstractPrompt;
    delete state.workerTaskPackets[0].promptRef;
    delete state.workerTaskPackets[0].weapon;
    delete state.agentBlueprintPacket.roles[0].matchedSkills;
    delete state.agentBlueprintPacket.roles[0].matchedCapabilities;
    delete state.agentBlueprintPacket.roles[0].capabilityBindings;

    const result = checkCapabilityNodeBindings(state);
    assert.equal(result.met, false);
    assert.ok(
      result.missing.includes(
        "owner loadout (skill, command, MCP, tool, or abstract prompt)",
      ),
    );
  });

  test("blocks Execution when Review standard is missing", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...minimalNodeBindings(),
    };
    delete state.workerTaskPackets[0].qualityBar;
    delete state.workerTaskPackets[0].finalizationGate;
    delete state.workerTaskPackets[0].handoffTarget;
    delete state.workerTaskPackets[0].handoffContract;

    const result = checkCapabilityNodeBindings(state);
    assert.equal(result.met, false);
    assert.ok(result.missing.includes("Review standard"));
  });

  test("blocks Execution when runtime or OS support is known unsupported", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...minimalNodeBindings(),
      runtimeSupportStatus: "known_unsupported",
    };

    const result = checkCapabilityNodeBindings(state);
    assert.equal(result.met, false);
    assert.ok(result.missing.includes("runtime/OS support not known-unsupported"));
  });

  test("Critical stage allows read-only worktree inspection before editing", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "critical",
    };

    const result = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "git status --short",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("Verification stage allows read-only inspection even when choice evidence is incomplete", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "verification",
    };

    const result = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "git status --short",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("Verification stage allows ordinary business file mutation when choice evidence is incomplete", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "verification",
    };

    const result = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "sed -i 's/old/new/' src/styles.css",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
    assert.equal(result.stderr, "");
  });

  test("Critical stage local command execution does not force meta-warden dispatch", () => {
    assert.deepEqual(STAGE_META_AGENT_MAP.critical.required, []);
    assert.doesNotMatch(STAGE_META_AGENT_MAP.critical.label, /Warden/i);

    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "critical",
    };

    const result = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "npm install left-pad",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
    assert.doesNotMatch(result.stdout, /meta-warden|Warden scope clarification/i);
    assert.equal(result.stderr, "");
  });

  test("Critical planning-file write does not auto-advance the active run", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "critical",
    };

    const cwd = mkdtempSync(join(tmpdir(), "meta-kim-hook-stage-"));
    try {
      const hookDir = join(cwd, "canonical", "runtime-assets", "claude", "hooks");
      mkdirSync(hookDir, { recursive: true });
      copyHookClosure(REPO_ROOT, hookDir, ["enforce-agent-dispatch.mjs"]);
      const spineDir = join(cwd, ".meta-kim", "state", "test", "spine");
      mkdirSync(spineDir, { recursive: true });
      writeFileSync(
        join(spineDir, "spine-state.json"),
        JSON.stringify(state, null, 2),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [join(hookDir, "enforce-agent-dispatch.mjs")],
        {
          cwd,
          input: JSON.stringify({
            tool_name: "Write",
            tool_input: {
              file_path: join(cwd, "task_plan.md"),
              content: "# plan",
            },
          }),
          encoding: "utf8",
          env: {
            ...process.env,
            META_KIM_SPINE_STATE_DIR: ".meta-kim/state/test/spine",
            META_KIM_CAPABILITY_GATE: "block",
            META_KIM_HOOK_RUNTIME: "codex",
          },
        },
      );

      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stdout, /permissionDecision/);

      const nextState = JSON.parse(
        readFileSync(join(spineDir, "spine-state.json"), "utf8"),
      );
      assert.equal(nextState.currentStage, "critical");
      assert.notEqual(nextState.stages.critical.status, "completed");
      assert.notEqual(nextState.stages.critical.autoCompleted, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("Critical fetch-style repo inspection does not auto-advance the active run", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "critical",
    };

    const cwd = mkdtempSync(join(tmpdir(), "meta-kim-hook-fetch-"));
    try {
      const hookDir = join(cwd, "canonical", "runtime-assets", "claude", "hooks");
      mkdirSync(hookDir, { recursive: true });
      copyHookClosure(REPO_ROOT, hookDir, ["enforce-agent-dispatch.mjs"]);
      const spineDir = join(cwd, ".meta-kim", "state", "test", "spine");
      mkdirSync(spineDir, { recursive: true });
      writeFileSync(
        join(spineDir, "spine-state.json"),
        JSON.stringify(state, null, 2),
        "utf8",
      );

      const result = spawnSync(
        process.execPath,
        [join(hookDir, "enforce-agent-dispatch.mjs")],
        {
          cwd,
          input: JSON.stringify({
            tool_name: "Bash",
            tool_input: {
              command:
                'cat package.json | grep -E "\\"test|\\"meta:verify|\\"meta:check|\\"meta:validate" | head -20',
            },
          }),
          encoding: "utf8",
          env: {
            ...process.env,
            META_KIM_SPINE_STATE_DIR: ".meta-kim/state/test/spine",
            META_KIM_CAPABILITY_GATE: "block",
            META_KIM_HOOK_RUNTIME: "codex",
          },
        },
      );

      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stdout, /permissionDecision/);

      const nextState = JSON.parse(
        readFileSync(join(spineDir, "spine-state.json"), "utf8"),
      );
      assert.equal(nextState.currentStage, "critical");
      assert.notEqual(nextState.stages.critical.status, "completed");
      assert.notEqual(nextState.stages.critical.autoCompleted, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("Critical evidence gathering requires explicit stage transition before Fetch verification", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "critical",
    };

    const cwd = mkdtempSync(join(tmpdir(), "meta-kim-hook-sequence-"));
    try {
      const hookDir = join(cwd, "canonical", "runtime-assets", "claude", "hooks");
      mkdirSync(hookDir, { recursive: true });
      copyHookClosure(REPO_ROOT, hookDir, ["enforce-agent-dispatch.mjs"]);
      const spineDir = join(cwd, ".meta-kim", "state", "test", "spine");
      mkdirSync(spineDir, { recursive: true });
      const stateFile = join(spineDir, "spine-state.json");
      writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");

      const baseEnv = {
        ...process.env,
        META_KIM_SPINE_STATE_DIR: ".meta-kim/state/test/spine",
        META_KIM_CAPABILITY_GATE: "block",
        META_KIM_HOOK_RUNTIME: "codex",
      };

      const inspectResult = spawnSync(
        process.execPath,
        [join(hookDir, "enforce-agent-dispatch.mjs")],
        {
          cwd,
          input: JSON.stringify({
            tool_name: "Bash",
            tool_input: {
              command: "git diff --stat",
            },
          }),
          encoding: "utf8",
          env: baseEnv,
        },
      );

      assert.equal(inspectResult.status, 0);
      assert.doesNotMatch(inspectResult.stdout, /permissionDecision/);

      const fetchState = JSON.parse(readFileSync(stateFile, "utf8"));
      assert.equal(fetchState.currentStage, "critical");
      fetchState.currentStage = "fetch";
      fetchState.stages.fetch = {
        status: "in_progress",
        startedAt: "2026-06-17T00:00:00.000Z",
        completedAt: null,
      };
      writeFileSync(stateFile, JSON.stringify(fetchState, null, 2), "utf8");

      const verifyResult = spawnSync(
        process.execPath,
        [join(hookDir, "enforce-agent-dispatch.mjs")],
        {
          cwd,
          input: JSON.stringify({
            tool_name: "Bash",
            tool_input: {
              command: buildCdCommand("npm run meta:test:setup"),
            },
          }),
          encoding: "utf8",
          env: baseEnv,
        },
      );

      assert.equal(verifyResult.status, 0);
      assert.doesNotMatch(verifyResult.stdout, /permissionDecision/);

      const wrappedTestResult = spawnSync(
        process.execPath,
        [join(hookDir, "enforce-agent-dispatch.mjs")],
        {
          cwd,
          input: JSON.stringify({
            tool_name: "Bash",
            tool_input: {
              command: buildCdCommand(
                'node scripts/run-node-tests.mjs "tests/meta-theory/*.test.mjs" 2>&1 | tail -120',
              ),
            },
          }),
          encoding: "utf8",
          env: baseEnv,
        },
      );

      assert.equal(wrappedTestResult.status, 0);
      assert.doesNotMatch(wrappedTestResult.stdout, /permissionDecision/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("Fetch stage allows targeted read-only source search before editing", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
    };

    const result = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "rg ownerMode canonical/skills/meta-theory/SKILL.md",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("read-only hook allowance does not auto-advance Critical to Fetch", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "critical",
    };

    const { result, updatedState } = runEnforceHookWithState(state, {
      tool_name: "Bash",
      tool_input: {
        command: "rg ownerMode canonical/skills/meta-theory/SKILL.md",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
    assert.equal(updatedState.currentStage, "critical");
    assert.notEqual(updatedState.stages?.critical?.status, "completed");
    assert.notEqual(updatedState.stages?.critical?.autoCompleted, true);
  });

  test("Fetch stage allows baseline test verification before route selection", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
    };

    const result = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: buildCdCommand("npm run meta:test:setup 2>&1 | tail -80"),
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("Fetch stage allows project test runner wrapper before route selection", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
    };

    const result = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: buildCdCommand(
          'node scripts/run-node-tests.mjs "tests/meta-theory/*.test.mjs" 2>&1 | tail -120',
        ),
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("Critical stage allows harmless cwd setup plus version probes", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "critical",
    };

    const result = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: buildCdCommand("node --version && npm --version"),
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("Critical stage allows test execution after harmless cwd setup", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "critical",
    };

    const result = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: buildCdCommand("npm run meta:test:setup"),
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
    assert.equal(result.stderr, "");
  });

  test("managed stages allow ordinary local commands without warning", () => {
    for (const stage of ["critical", "fetch", "thinking", "review", "verification", "evolution"]) {
      const state = {
        ...createInitialState({
          taskClassification: "meta_theory_auto",
          triggerReason: "test",
        }),
        currentStage: stage,
      };

      for (const command of [
        "sed -i 's/old/new/' src/styles.css",
        "rm -f .meta-kim/state/default/spine/spine-state.json",
        "Remove-Item -LiteralPath .meta-kim/state/default/spine/spine-state.json -Force",
      ]) {
        const result = runEnforceHook(state, {
          tool_name: "Bash",
          tool_input: { command },
        });

        assert.equal(result.status, 0);
        assert.doesNotMatch(result.stdout, /permissionDecision/);
        assert.equal(result.stderr, "");
      }
    }
  });

  test("Fetch stage allows ordinary business file mutation without warning", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
      stageTransitionIntent: "commit",
    };
    delete state.fetchRecord;

    const result = runEnforceHook(state, {
      tool_name: "Write",
      tool_input: {
        file_path: "src/main.go",
        content: "package main\n",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  test("dispatch history cannot impersonate a meta-agent caller or warn on project mutation", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
      dispatchChain: {
        fetch: ["meta-artisan"],
      },
    };

    const result = runEnforceHook(state, {
      tool_name: "Write",
      tool_input: {
        file_path: "src/main.go",
        content: "package main\n",
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });

  test("runtime-injected meta-agent identity still enforces the readonly role boundary", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
    };

    const result = runEnforceHook(
      state,
      {
        tool_name: "Write",
        tool_input: {
          file_path: "src/main.go",
          content: "package main\n",
        },
      },
      {
        runtime: "claude",
        env: {
          CLAUDE_SUBAGENT_TYPE: "meta-artisan",
          META_KIM_META_ENFORCEMENT_MODE: "block",
        },
      },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /permissionDecision/);
    const decision = JSON.parse(result.stdout);
    assert.match(
      decision.hookSpecificOutput.permissionDecisionReason,
      /Meta-agent "meta-artisan"/,
    );
  });

  test("queryBypass allows read-only inspection but still denies mutation", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
      queryBypass: true,
    };

    const readOnly = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "rg ownerMode canonical/skills/meta-theory/SKILL.md",
      },
    });
    assert.equal(readOnly.status, 0);
    assert.doesNotMatch(readOnly.stdout, /permissionDecision/);

    const mutation = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "npm install left-pad",
      },
    });
    assert.equal(mutation.status, 0);
    assert.match(mutation.stdout, /permissionDecision/);
  });

  test("queryBypass denies mutating control tools and allows read-only task inspection", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
      queryBypass: true,
    };

    for (const tool of [
      "TaskCreate",
      "TaskUpdate",
      "TodoWrite",
      "TaskStop",
      "EnterPlanMode",
      "ExitPlanMode",
    ]) {
      const { result, updatedState } = runEnforceHookWithState(state, {
        tool_name: tool,
        tool_input: {
          subject: "mutating bookkeeping",
          todos: [{ content: "Must stay read-only", status: "pending" }],
        },
      });

      assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
      assert.match(result.stdout, /permissionDecision/, tool);
      assert.deepEqual(updatedState, state, tool);
    }

    for (const tool of ["TaskList", "TaskGet", "TaskOutput"]) {
      const { result, updatedState } = runEnforceHookWithState(state, {
        tool_name: tool,
        tool_input: { task_id: "task-read-only-001" },
      });

      assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /permissionDecision/, tool);
      assert.deepEqual(updatedState, state, tool);
    }

    const ordinaryState = { ...state, queryBypass: false };
    for (const tool of [
      "TaskCreate",
      "TaskUpdate",
      "TodoWrite",
      "TaskStop",
      "EnterPlanMode",
      "ExitPlanMode",
    ]) {
      const { result, updatedState } = runEnforceHookWithState(ordinaryState, {
        tool_name: tool,
        tool_input: { task_id: "task-control-001" },
      });

      assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /permissionDecision/, tool);
      assert.deepEqual(updatedState, ordinaryState, tool);
    }
  });

  test("queryBypass allows spine-state writes without allowing business-file writes", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
      queryBypass: true,
    };

    const spineWrite = runEnforceHook(state, {
      tool_name: "Write",
      tool_input: {
        file_path: ".meta-kim/state/test/spine/spine-state.json",
        content: JSON.stringify({ ...state, queryBypass: false }, null, 2),
      },
    });
    assert.equal(spineWrite.status, 0);
    assert.doesNotMatch(spineWrite.stdout, /permissionDecision/);

    const businessWrite = runEnforceHook(state, {
      tool_name: "Write",
      tool_input: {
        file_path: "src/main.go",
        content: "package main\n",
      },
    });
    assert.equal(businessWrite.status, 0);
    assert.match(businessWrite.stdout, /permissionDecision/);
  });

  test("Fetch stage allows Bash spine-state writes even before fetchRecord exists", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
    };

    const spineWrite = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command:
          "$p='.meta-kim/state/test/spine/spine-state.json'; " +
          "$j=Get-Content $p -Raw | ConvertFrom-Json; " +
          "$j | Add-Member -NotePropertyName fetchRecord -NotePropertyValue ([pscustomobject]@{ capabilitySearchPerformed=$true }) -Force; " +
          "$j | ConvertTo-Json -Depth 20 | Set-Content $p -Encoding UTF8",
      },
    });
    assert.equal(spineWrite.status, 0);
    assert.doesNotMatch(spineWrite.stdout, /permissionDecision/);

    const businessWrite = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "Set-Content src/main.go 'package main'",
      },
    });
    assert.equal(businessWrite.status, 0);
    assert.doesNotMatch(businessWrite.stdout, /permissionDecision/);
    assert.equal(businessWrite.stderr, "");

    const misleadingContentWrite = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "Set-Content src/main.go 'spine-state.json fetchRecord'",
      },
    });
    assert.equal(misleadingContentWrite.status, 0);
    assert.doesNotMatch(misleadingContentWrite.stdout, /permissionDecision/);
    assert.equal(misleadingContentWrite.stderr, "");
  });

  test("Fetch stage allows apply_patch spine-state patches before fetchRecord exists", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
    };
    delete state.fetchRecord;

    const spinePatch = runEnforceHook(state, {
      tool_name: "apply_patch",
      tool_input: {
        patch:
          "*** Begin Patch\n" +
          "*** Update File: .meta-kim/state/test/spine/spine-state.json\n" +
          "@@\n" +
          "+  \"fetchRecord\": {\"capabilitySearchPerformed\": true}\n" +
          "*** End Patch\n",
      },
    });

    assert.equal(spinePatch.status, 0);
    assert.doesNotMatch(spinePatch.stdout, /permissionDecision/);

    const mixedPatch = runEnforceHook(state, {
      tool_name: "apply_patch",
      tool_input: {
        patch:
          "*** Begin Patch\n" +
          "*** Update File: .meta-kim/state/test/spine/spine-state.json\n" +
          "@@\n" +
          "+  \"fetchRecord\": {\"capabilitySearchPerformed\": true}\n" +
          "*** Update File: src/main.go\n" +
          "@@\n" +
          "+package main\n" +
          "*** End Patch\n",
      },
    });

    assert.equal(mixedPatch.status, 0);
    assert.doesNotMatch(mixedPatch.stdout, /permissionDecision/);
    assert.equal(mixedPatch.stderr, "");
  });

  test("Fetch stage allows Node state repair and ordinary Node project writes", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
    };
    delete state.fetchRecord;

    const repairWrite = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command:
          "node -e \"const fs=require('fs'); " +
          "const p='.meta-kim/state/test/spine/spine-state.json'; " +
          "const s=JSON.parse(fs.readFileSync(p,'utf8')); " +
          "s.fetchRecord={status:'repair_only_fetch_record',repairOnly:true,capabilitySearchPerformed:false,executionClearance:false,researchRequired:false,researchValidationPerformed:false}; " +
          "fs.writeFileSync(p, JSON.stringify(s, null, 2));\"",
      },
    });
    assert.equal(repairWrite.status, 0);
    assert.doesNotMatch(repairWrite.stdout, /permissionDecision/);

    const pathJoinRepairWrite = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command:
          "node -e \"const fs=require('fs'); const path=require('path'); " +
          "const root='.'; " +
          "const statePath=path.join(root,'.meta-kim/state/test/spine/spine-state.json'); " +
          "const s=JSON.parse(fs.readFileSync(statePath,'utf8')); " +
          "s.fetchRecord={status:'repair_only_fetch_record',repairOnly:true,capabilitySearchPerformed:false,executionClearance:false,researchRequired:false,researchValidationPerformed:false}; " +
          "fs.writeFileSync(statePath, JSON.stringify(s, null, 2));\"",
      },
    });
    assert.equal(pathJoinRepairWrite.status, 0);
    assert.doesNotMatch(pathJoinRepairWrite.stdout, /permissionDecision/);

    const businessNodeWrite = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command:
          "node -e \"const fs=require('fs'); " +
          "const p='src/main.go'; " +
          "const note='spine-state.json fetchRecord repairOnly executionClearance:false'; " +
          "fs.writeFileSync(p, note);\"",
      },
    });
    assert.equal(businessNodeWrite.status, 0);
    assert.doesNotMatch(businessNodeWrite.stdout, /permissionDecision/);
    assert.equal(businessNodeWrite.stderr, "");
  });

  test("planning file mentions do not change silent Fetch business-file allowance", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
    };
    delete state.fetchRecord;

    const planningOnlyWrite = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command: "Set-Content -Path progress.md -Value 'fetch noted'",
      },
    });
    assert.equal(planningOnlyWrite.status, 0);
    assert.doesNotMatch(planningOnlyWrite.stdout, /permissionDecision/);

    const mixedBusinessWrite = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command:
          "Get-Content -Path progress.md | Out-Null; " +
          "Set-Content src/main.go 'package main'",
      },
    });
    assert.equal(mixedBusinessWrite.status, 0);
    assert.doesNotMatch(mixedBusinessWrite.stdout, /permissionDecision/);
    assert.equal(mixedBusinessWrite.stderr, "");
  });

  test("Fetch stage allows planning files before fetchRecord exists", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
      stageTransitionIntent: "commit",
    };
    delete state.fetchRecord;

    const nativePlanWrite = runEnforceHook(state, {
      tool_name: "Write",
      tool_input: {
        filePath: "C:/Users/example/.claude/plans/meta-kim-plan.md",
        content: "# Plan\n",
      },
    });
    assert.equal(nativePlanWrite.status, 0);
    assert.doesNotMatch(nativePlanWrite.stdout, /permissionDecision/);

    const nativePlanBashWrite = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command:
          "Set-Content -Path C:/Users/example/.claude/plans/meta-kim-plan.md -Value '# Plan'",
      },
    });
    assert.equal(nativePlanBashWrite.status, 0);
    assert.doesNotMatch(nativePlanBashWrite.stdout, /permissionDecision/);

    for (const tool of ["EnterPlanMode", "ExitPlanMode"]) {
      const result = runEnforceHook(state, {
        tool_name: tool,
        tool_input: {
          plan: "# Plan",
          todos: [{ content: "Plan the repair", status: "pending" }],
        },
      });
      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stdout, /permissionDecision/);
    }

    const businessWriteWithPlanMention = runEnforceHook(state, {
      tool_name: "Bash",
      tool_input: {
        command:
          "Set-Content -Path src/main.go -Value 'C:/Users/example/.claude/plans/meta-kim-plan.md'",
      },
    });
    assert.equal(businessWriteWithPlanMention.status, 0);
    assert.doesNotMatch(businessWriteWithPlanMention.stdout, /permissionDecision/);
    assert.equal(businessWriteWithPlanMention.stderr, "");
  });

  test("Fetch stage allows task bookkeeping without treating it as Fetch evidence", () => {
    for (const stage of ["critical", "fetch"]) {
      const state = {
        ...createInitialState({
          taskClassification: "meta_theory_auto",
          triggerReason: "test",
        }),
        currentStage: stage,
        stageTransitionIntent: "commit",
      };
      delete state.fetchRecord;

      for (const tool of ["TaskCreate", "TaskUpdate", "TodoWrite"]) {
        const { result, updatedState } = runEnforceHookWithState(state, {
          tool_name: tool,
          tool_input: {
            plan: "# Plan",
            todos: [{ content: "Plan the repair", status: "pending" }],
          },
        });
        assert.equal(result.status, 0, `${stage}:${tool}: ${result.stderr}`);
        assert.doesNotMatch(result.stdout, /permissionDecision/, `${stage}:${tool}`);
        assert.equal(result.stderr, "", `${stage}:${tool}`);
        assert.equal(updatedState.currentStage, stage, `${stage}:${tool}`);
        assert.equal(updatedState.fetchRecord, undefined, `${stage}:${tool}`);
      }
    }
  });

  test("fanout-eligible TaskCreate stays bookkeeping and does not substitute for Agent dispatch", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "natural_language_durable_work",
      }),
      currentStage: "fetch",
      stageRuntimeControl: {
        activationMode: "hook_observed",
        driverMode: "hook_observed",
        hookGateMode: "advisory",
        dispatchMode: "fanout_eligible",
      },
      fetchRecord: {
        capabilitySearchPerformed: true,
        capabilityMatches: [{ id: "review-owner", tier: "eligible" }],
      },
      dispatchedAgents: [],
    };

    const { result: bookkeeping, updatedState } = runEnforceHookWithState(state, {
      tool_name: "TaskCreate",
      tool_input: { subject: "dependency review" },
    });
    assert.equal(bookkeeping.status, 0);
    assert.doesNotMatch(bookkeeping.stdout, /permissionDecision/);
    assert.equal(bookkeeping.stderr, "");
    assert.deepEqual(updatedState.dispatchedAgents, []);
    assert.equal(updatedState.currentStage, "fetch");
    assert.notEqual(updatedState.stages?.thinking?.status, "completed");
    assert.notEqual(updatedState.stages?.execution?.status, "completed");

    const allowedAfterDispatch = runEnforceHook({
      ...state,
      dispatchedAgents: [{ name: "review-owner" }],
    }, {
      tool_name: "TaskCreate",
      tool_input: { subject: "dependency review" },
    });
    assert.equal(allowedAfterDispatch.status, 0);
    assert.doesNotMatch(allowedAfterDispatch.stdout, /permissionDecision/);

    const blockedAgentDispatch = runEnforceHook({
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "execution",
    }, {
      tool_name: "Agent",
      tool_input: {
        agent_type: "review-owner",
        description: "implement dependency review",
        prompt: "implement dependency review",
      },
    });
    assert.equal(blockedAgentDispatch.status, 0);
    assert.match(blockedAgentDispatch.stdout, /permissionDecision/);
    assert.match(
      blockedAgentDispatch.stdout,
      /Capability-first violation|pre-execution readiness|key behavior evidence/i,
    );
  });

  test("fan_out_ready cannot bypass Thinking proof of independent lanes", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "direct_parallel_dispatch_request",
      }),
      currentStage: "thinking",
      stageRuntimeControl: {
        activationMode: "managed_stage_runtime",
        driverMode: "managed",
        hookGateMode: "block",
        dispatchMode: "fan_out_ready",
      },
      fetchRecord: {
        capabilitySearchPerformed: true,
        evidence: ["real-discovery:evidence"],
      },
      stages: {
        ...createInitialState({ taskClassification: "meta_theory_auto" }).stages,
        thinking: { status: "in_progress", completedAt: null },
      },
      workerTaskPackets: [
        {
          taskPacketId: "only-lane",
          ownerAgent: "backend",
          roleInstanceId: "backend-1",
          parallelGroup: "group-1",
          mergeOwner: "meta-conductor",
          shardScope: ["src/backend"],
          dependsOn: [],
        },
      ],
    };
    const denied = runEnforceHook(state, {
      tool_name: "Agent",
      tool_input: {
        agent_type: "backend",
        description: "implement only-lane",
        prompt: "implement only-lane",
      },
    });
    assert.equal(denied.status, 0);
    assert.match(denied.stdout, /permissionDecision/);
    assert.match(denied.stdout, /Thinking fan-out readiness violation/);
    assert.match(denied.stdout, /at least two workerTaskPackets/);
  });

  test("simpleMode residue in spine state cannot skip Agent dispatch governance", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "execution",
      simpleMode: true,
    };

    const result = runEnforceHook(state, {
      tool_name: "Agent",
      tool_input: {
        agent_type: "backend",
        description: "implement task-backend-001",
        prompt: "implement task-backend-001",
      },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /permissionDecision/);
    assert.doesNotMatch(result.stderr, /Simple mode enabled|simple_mode/i);
  });

  test("rejects vague choiceGateSkip objects as non-decisions", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "execution",
      fetchRecord: { capabilityMatches: ["frontend"] },
      preDecisionOptionFrame: {
        choiceGateSkip: {
          reason: "non-interactive runtime fallback",
        },
      },
      choiceSurfaceState: "not_allowed",
    };

    const result = checkChoiceSurfaceGate(state);
    assert.equal(result.met, false);
  });

  test("allows strict choiceGateSkip only with source and safety rationale", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "execution",
      fetchRecord: { capabilityMatches: ["frontend"] },
      preDecisionOptionFrame: {
        choiceGateSkip: "explicit_auto_proceed",
        skipSource: "user_explicit_auto_proceed",
        skipSafetyRationale:
          "User explicitly authorized auto-proceed after Fetch evidence and candidate options were recorded.",
      },
      choiceSurfaceState: "not_allowed",
    };

    const result = checkChoiceSurfaceGate(state);
    assert.equal(result.met, true);
  });

  test("allows no_branching_choice skip in both runtime state implementations", () => {
    const base = {
      currentStage: "execution",
      fetchRecord: { capabilityMatches: ["frontend"] },
      preDecisionOptionFrame: {
        choiceGateSkip: "no_branching_choice",
        skipSource: "pre_decision_frame",
        skipSafetyRationale:
          "Fetch evidence showed no user answer would change route, scope, risk, owner, permission, non-goal, or acceptance.",
      },
      choiceSurfaceState: "not_allowed",
    };

    const claudeState = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...base,
    };
    const sharedState = {
      ...createSharedInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...base,
    };

    assert.equal(checkChoiceSurfaceGate(claudeState).met, true);
    assert.equal(checkSharedChoiceSurfaceGate(sharedState).met, true);
  });

  test("rejects read-only queryBypass as a choiceGateSkip reason", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "execution",
      fetchRecord: { capabilityMatches: ["frontend"] },
      preDecisionOptionFrame: {
        choiceGateSkip: "pure_read_only_queryBypass",
        skipSource: "query_bypass",
        skipSafetyRationale:
          "Read-only classification alone does not prove user choice is irrelevant.",
      },
      choiceSurfaceState: "not_allowed",
    };

    const result = checkChoiceSurfaceGate(state);
    assert.equal(result.met, false);
  });

  test("execution hook imports and applies the choice surface gate", async () => {
    const hook = await readFile(
      "canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs",
    );
    assert.match(hook, /checkChoiceSurfaceGate/);
    assert.match(hook, /choiceSurfaceGate\.met/);
    assert.match(hook, /checkCapabilityNodeBindings/);
    assert.match(hook, /Capability node binding violation/);
  });

  test("only exact trusted dispatch tool names can record an Agent dispatch", () => {
    const baseState = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      currentStage: "fetch",
      dispatchedAgents: [],
      dispatchChain: {},
    };

    for (const tool of [
      "mcp__attacker.Agent",
      "foo.Task",
      "attacker.spawn_agent",
      "attacker.followup_task",
    ]) {
      const { result, updatedState } = runEnforceHookWithState(
        baseState,
        {
          tool_name: tool,
          tool_input: {
            description: "meta-artisan Fetch evidence",
            prompt: "meta-artisan continue Fetch capability discovery",
          },
        },
        { runtime: "claude" },
      );

      assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /permissionDecision/, tool);
      assert.deepEqual(updatedState.dispatchedAgents, [], tool);
      assert.deepEqual(updatedState.dispatchChain, {}, tool);
      assert.equal(updatedState.currentStage, "fetch", tool);
    }

    for (const tool of ["Agent", "Task"]) {
      const { result, updatedState } = runEnforceHookWithState(
        baseState,
        {
          tool_name: tool,
          tool_input: {
            description: "meta-artisan Fetch evidence",
            prompt: "meta-artisan continue Fetch capability discovery",
          },
        },
        { runtime: "claude" },
      );

      assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /permissionDecision/, tool);
      assert.equal(updatedState.dispatchedAgents.length, 1, tool);
      assert.equal(updatedState.currentStage, "fetch", tool);
    }
  });

  test("Codex gates only exact native and collaboration dispatch tool names", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...minimalNodeBindings(),
      currentStage: "execution",
    };
    state.fetchRecord.capabilitySearchPerformed = false;

    for (const tool of [
      "Agent",
      "spawn_agent",
      "followup_task",
      "collaboration.spawn_agent",
      "collaboration.followup_task",
    ]) {
      const { result, updatedState } = runEnforceHookWithState(
        state,
        {
          tool_name: tool,
          tool_input: {
            agent_type: "meta-conductor",
            target: "/root/meta-conductor",
            message: "Run task-backend-001 for role backend#1",
            description: "meta-conductor backend execution",
            prompt: "Run task-backend-001 for role backend#1",
          },
        },
        { runtime: "codex" },
      );

      assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
      assert.match(result.stdout, /permissionDecision/, tool);
      assert.match(result.stdout, /Capability-first violation/, tool);
      assert.deepEqual(updatedState, state, tool);
    }

    for (const tool of [
      "attacker.Agent",
      "Agent.attacker",
      "attacker.spawn_agent",
      "spawn_agent.attacker",
      "attacker.followup_task",
      "followup_task.attacker",
      "collaboration.attacker.spawn_agent",
      "collaboration.spawn_agent.attacker",
      "collaboration.attacker.followup_task",
      "collaboration.followup_task.attacker",
    ]) {
      const { result, updatedState } = runEnforceHookWithState(
        state,
        {
          tool_name: tool,
          tool_input: {
            agent_type: "meta-conductor",
            target: "/root/meta-conductor",
            message: "Run task-backend-001 for role backend#1",
          },
        },
        { runtime: "codex" },
      );

      assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /permissionDecision/, tool);
      assert.deepEqual(updatedState, state, tool);
    }
  });

  test("Agent hook denies execution dispatch when key intent evidence is missing", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...preExecutionReadinessPacketsOnly(),
      currentStage: "execution",
      fetchRecord: {
        capabilitySearchPerformed: true,
        capabilityMatches: ["backend"],
      },
      preDecisionOptionFrame: {
        candidatePaths: ["direct hook enforcement", "contract-only guard"],
      },
      choiceSurfaceState: "completed",
    };
    delete state.intentPacket;

    const result = runEnforceHook(state, {
      tool_name: "Agent",
      tool_input: {
        description: "meta-conductor backend execution",
        prompt: "Run task-backend-001",
      },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /pre-execution readiness|key behavior evidence/i);
  });

  test("Agent hook allows dispatch with incomplete optional worker work-order fields", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...completePreExecutionBindings(),
      currentStage: "execution",
    };
    state.workerTaskPackets[0].evidenceRefs = [];
    delete state.workerTaskPackets[0].handoffContract;
    delete state.workerTaskPackets[0].workType;

    const result = runEnforceHook(state, {
      tool_name: "Agent",
      tool_input: {
        description: "meta-conductor backend execution",
        prompt: "Run task-backend-001 for role backend#1",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("spawn_agent hook denies execution dispatch before capability search", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...minimalNodeBindings(),
      currentStage: "execution",
    };
    state.fetchRecord.capabilitySearchPerformed = false;

    const result = runEnforceHook(state, {
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "backend_1",
        fork_turns: "none",
        message: "Run task-backend-001 for role backend#1",
      },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Capability-first violation/);
  });

  test("spawn_agent hook denies execution-intent dispatch during Thinking before readiness", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...minimalNodeBindings(),
      currentStage: "thinking",
      dispatchChain: { thinking: ["meta-conductor"] },
      preDecisionOptionFrame: {
        candidatePaths: ["direct hook enforcement", "contract-only guard"],
      },
      choiceSurfaceState: "completed",
    };
    delete state.memoryMode;
    delete state.fetchRecord.memoryStrategy;

    const result = runEnforceHook(state, {
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "backend_1",
        fork_turns: "none",
        message: "Implement backend task task-backend-001",
      },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /pre-execution readiness|design-time/i);
  });

  test("spawn_agent hook allows governance dispatch during Thinking", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...minimalNodeBindings(),
      currentStage: "thinking",
      dispatchChain: { thinking: ["meta-conductor"] },
      preDecisionOptionFrame: {
        candidatePaths: ["direct hook enforcement", "contract-only guard"],
      },
      choiceSurfaceState: "completed",
    };
    const reviewPacket = {
      taskPacketId: "thinking-review-001",
      ownerAgent: "meta-prism",
      ownerSource: "~/.codex/agents/meta-prism.toml",
      roleDisplayName: "review",
      roleInstanceId: "thinking_review",
      parallelGroup: null,
      mergeOwner: "meta-conductor",
    };
    state.workerTaskPackets.push(reviewPacket);

    const result = runEnforceHook(state, {
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "thinking_review",
        fork_turns: "none",
        message: codexWorkerEnvelope(reviewPacket, {
          ownerBindingMode: "run_scoped_owner_contract",
        }),
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("Codex spawn without agent_type uses the run-scoped owner contract", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...completePreExecutionBindings(),
      currentStage: "thinking",
      agentBlueprintPacket: {
        roles: [{ businessRoleId: "review", ownerAgent: "meta-prism" }],
      },
      choiceSurfaceState: "completed",
    };
    const packet = {
      taskPacketId: "thinking-review-run-scoped",
      ownerAgent: "meta-prism",
      ownerSource: "canonical/agents/meta-prism.md",
      roleDisplayName: "review",
      roleInstanceId: "thinking_review_run_scoped",
      parallelGroup: null,
      mergeOwner: "meta-conductor",
    };
    state.workerTaskPackets.push(packet);

    const result = runEnforceHook(state, {
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "meta_prism",
        nickname: "meta-prism",
        fork_turns: "none",
        message: codexWorkerEnvelope(packet, {
          ownerBindingMode: "run_scoped_owner_contract",
        }),
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("Codex v0.2 envelope without ownerBindingMode is not sufficient owner evidence", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...completePreExecutionBindings(),
      currentStage: "thinking",
      agentBlueprintPacket: {
        roles: [{ businessRoleId: "review", ownerAgent: "meta-prism" }],
      },
      choiceSurfaceState: "completed",
    };
    const packet = {
      taskPacketId: "thinking-review-missing-mode",
      ownerAgent: "meta-prism",
      ownerSource: "canonical/agents/meta-prism.md",
      roleDisplayName: "review",
      roleInstanceId: "thinking_review_missing_mode",
      parallelGroup: null,
      mergeOwner: "meta-conductor",
    };
    state.workerTaskPackets.push(packet);

    const result = runEnforceHook(state, {
      tool_name: "spawn_agent",
      tool_input: {
        task_name: "review_without_binding_mode",
        fork_turns: "none",
        message: codexWorkerEnvelope(packet),
      },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /owner binding mode/i);
  });

  test("Codex spawn with agent_type requires a matching native custom agent binding", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...completePreExecutionBindings(),
      currentStage: "thinking",
      agentBlueprintPacket: {
        roles: [{ businessRoleId: "review", ownerAgent: "meta-prism" }],
      },
      choiceSurfaceState: "completed",
    };
    const packet = {
      taskPacketId: "thinking-review-native-agent",
      ownerAgent: "meta-prism",
      ownerSource: "~/.codex/agents/meta-prism.toml",
      roleDisplayName: "review",
      roleInstanceId: "thinking_review_native_agent",
      parallelGroup: null,
      mergeOwner: "meta-conductor",
    };
    state.workerTaskPackets.push(packet);
    const nativeEnvelope = codexWorkerEnvelope(packet, {
      ownerBindingMode: "native_custom_agent",
      nativeAgentType: "meta-prism",
      ownerDefinition: {
        format: "codex_custom_agent_toml",
        sourceRef: "~/.codex/agents/meta-prism.toml",
        nativeAgentName: "meta-prism",
        nativeCustomAgentEligible: true,
      },
    });

    const allowed = runEnforceHook(state, {
      tool_name: "spawn_agent",
      tool_input: {
        agent_type: "meta-prism",
        task_name: "review_shard",
        nickname: "random-review-nickname",
        fork_turns: "none",
        message: nativeEnvelope,
      },
    });
    assert.equal(allowed.status, 0);
    assert.doesNotMatch(allowed.stdout, /permissionDecision/);

    const mismatched = runEnforceHook(state, {
      tool_name: "spawn_agent",
      tool_input: {
        agent_type: "different-agent",
        task_name: "meta-prism",
        nickname: "meta-prism",
        fork_turns: "none",
        message: nativeEnvelope,
      },
    });
    assert.equal(mismatched.status, 0);
    assert.match(mismatched.stdout, /permissionDecision/);
    assert.match(mismatched.stdout, /agent_type|owner binding/i);
  });

  test("native_custom_agent rejects a Markdown owner source even when agent_type matches", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...completePreExecutionBindings(),
      currentStage: "thinking",
      agentBlueprintPacket: {
        roles: [{ businessRoleId: "review", ownerAgent: "meta-prism" }],
      },
      choiceSurfaceState: "completed",
    };
    const packet = {
      taskPacketId: "thinking-review-native-markdown-source",
      ownerAgent: "meta-prism",
      ownerSource: "canonical/agents/meta-prism.md",
      roleDisplayName: "review",
      roleInstanceId: "thinking_review_native_markdown_source",
      parallelGroup: null,
      mergeOwner: "meta-conductor",
    };
    state.workerTaskPackets.push(packet);

    const result = runEnforceHook(state, {
      tool_name: "spawn_agent",
      tool_input: {
        agent_type: "meta-prism",
        task_name: "review_native_markdown_source",
        fork_turns: "none",
        message: codexWorkerEnvelope(packet, {
          ownerBindingMode: "native_custom_agent",
          nativeAgentType: "meta-prism",
        }),
      },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /ownerSource|TOML|native custom agent/i);
  });

  test("followup_task cannot reuse a runtime label without a professional owner binding", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...completePreExecutionBindings(),
      currentStage: "execution",
    };

    const result = runEnforceHook(state, {
      tool_name: "followup_task",
      tool_input: {
        target: "/root/status_validator_consumer",
        message: "Continue the previous task.",
      },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /permissionDecision/);
    assert.match(result.stdout, /owner-binding evidence is malformed or unverifiable/i);
    assert.match(result.stdout, /runtime instance labels, not owner identity/i);
  });

  test("apply_patch hook is treated as an execution tool without exhaustive packet blocking", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...preExecutionReadinessPacketsOnly(),
      currentStage: "execution",
      fetchRecord: {
        capabilitySearchPerformed: true,
        capabilityMatches: ["backend"],
      },
      preDecisionOptionFrame: {
        candidatePaths: ["direct hook enforcement", "contract-only guard"],
      },
      choiceSurfaceState: "completed",
    };

    const result = runEnforceHook(state, {
      tool_name: "apply_patch",
      tool_input: {
        patch: "*** Begin Patch\n*** End Patch\n",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("Cursor gates only exact Agent, Task, and spawn_agent tool names", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...minimalNodeBindings(),
      currentStage: "execution",
    };
    state.fetchRecord.capabilitySearchPerformed = false;

    for (const tool of ["Agent", "Task", "spawn_agent"]) {
      const { result, updatedState } = runEnforceHookWithState(
        state,
        {
          tool_name: tool,
          tool_input: {
            agent_type: "meta-conductor",
            description: "meta-conductor backend execution",
            prompt: "Run task-backend-001 for role backend#1",
            message: "Run task-backend-001 for role backend#1",
          },
        },
        { runtime: "cursor" },
      );

      assert.equal(result.status, 2, tool);
      assert.match(result.stdout, /"permission":"deny"/, tool);
      assert.match(result.stderr, /Capability-first violation/, tool);
      assert.deepEqual(updatedState, state, tool);
    }

    for (const tool of [
      "attacker.Agent",
      "Agent.attacker",
      "attacker.Task",
      "Task.attacker",
      "attacker.spawn_agent",
      "spawn_agent.attacker",
    ]) {
      const { result, updatedState } = runEnforceHookWithState(
        state,
        {
          tool_name: tool,
          tool_input: {
            agent_type: "meta-conductor",
            message: "Run task-backend-001 for role backend#1",
          },
        },
        { runtime: "cursor" },
      );

      assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /"permission":"deny"|permissionDecision/, tool);
      assert.deepEqual(updatedState, state, tool);
    }
  });

  test("Agent hook allows single-worker dispatch that omits task node id", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...completePreExecutionBindings(),
      currentStage: "execution",
    };

    const result = runEnforceHook(state, {
      tool_name: "Agent",
      tool_input: {
        description: "meta-conductor backend execution",
        prompt: "Run the backend task without citing its packet id",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });

  test("Agent hook allows execution dispatch with matching task node id", () => {
    const state = {
      ...createInitialState({
        taskClassification: "meta_theory_auto",
        triggerReason: "test",
      }),
      ...completePreExecutionBindings(),
      currentStage: "execution",
    };

    const result = runEnforceHook(state, {
      tool_name: "Agent",
      tool_input: {
        description: "meta-conductor backend execution",
        prompt: "Run task-backend-001 for role backend#1",
      },
    });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /permissionDecision/);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Part G: Control State Transitions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Part G: control state transitions", async () => {
  const devGov = await readFile(
    "canonical/skills/meta-theory/references/dev-governance.md",
  );
  const contract = await readJson("config/contracts/workflow-contract.json");

  test("skip transition documented (stage skipped)", () => {
    const patterns = [
      /skip.*stage/i,
      /controlState.*skip/i,
      /skip.*condition/i,
    ];
    assert.ok(
      patterns.some((p) => p.test(devGov)),
      "Skip control transition must be documented",
    );
  });

  test("interrupt transition documented (emergency pause)", () => {
    const patterns = [
      /interrupt.*stage/i,
      /controlState.*interrupt/i,
      /emergency.*interrupt/i,
    ];
    assert.ok(
      patterns.some((p) => p.test(devGov)),
      "Interrupt control transition must be documented",
    );
  });

  test("iteration transition documented (re-enter Execution after verification fail)", () => {
    const patterns = [
      /iteration.*Execution/i,
      /controlState.*iteration/i,
      /re-enter.*Execution.*verification.*fail/i,
    ];
    assert.ok(
      patterns.some((p) => p.test(devGov)),
      "Iteration control transition must be documented",
    );
  });

  test("intentional-silence transition documented", () => {
    const patterns = [
      /intentional.*silence/i,
      /controlState.*silence/i,
      /forced.*silence/i,
    ];
    assert.ok(
      patterns.some((p) => p.test(devGov)),
      "Intentional-silence control transition must be documented",
    );
  });

  test("returnsToMainChain rule documented for interrupt/override", () => {
    assert.equal(
      contract.runDiscipline?.controlIntervention?.requiresReturnToMainChain,
      true,
      "controlIntervention.requiresReturnToMainChain must be true",
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Part H: Verification → Evolution Close
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Part H: verification-to-evolution close", async () => {
  const devGov = await readFile(
    "canonical/skills/meta-theory/references/dev-governance.md",
  );

  test("Evolution receives verificationPacket results", () => {
    const patterns = [
      /Evolution.*verification.*Packet/i,
      /verification.*Evolution/i,
      /verification.*close.*Evolution/i,
    ];
    assert.ok(
      patterns.some((p) => p.test(devGov)),
      "Evolution must receive verificationPacket results",
    );
  });

  test("Evolution produces evolutionWritebackPacket with required fields", async () => {
    const contract = await readJson("config/contracts/workflow-contract.json");
    const fields =
      contract.protocols?.evolutionWritebackPacket?.requiredFields ?? [];
    const required = ["writebackDecision", "decisionReason", "writebacks"];
    for (const field of required) {
      assert.ok(
        fields.includes(field),
        `evolutionWritebackPacket must have required field: ${field}`,
      );
    }
  });

  test("Evolution writeback targets are defined", async () => {
    const contract = await readJson("config/contracts/workflow-contract.json");
    const targets = contract.runDiscipline?.evolutionWritebackTargets ?? [];
    assert.ok(
      targets.length >= 2,
      "evolutionWritebackTargets must have at least 2 targets",
    );
    assert.ok(
      targets.some((t) => t.includes("canonical/agents/")),
      "must target agents",
    );
    assert.ok(
      targets.some((t) => t.includes("canonical/skills/")),
      "must target skills",
    );
    // Evolution writes back to agent definitions directly, NOT memory/
    assert.ok(
      !targets.some((t) => t.includes("memory/")),
      "must NOT target memory/ (Claude Code session memory, not Meta_Kim evolution)",
    );
  });

  test("Verification requires installed-user compatibility beyond fresh install", async () => {
    const skill = await readFile("canonical/skills/meta-theory/SKILL.md");
    assert.match(skill, /Installed-user compatibility invariant/u);
    assert.match(skill, /existing[\s\S]*same-version reinstall/u);
    assert.match(skill, /historical-version update/u);
    assert.match(skill, /partial\/failed-install[\s\S]*user-modified drift/u);
    assert.match(skill, /fresh-install pass alone never proves/u);
    assert.match(skill, /normal public[\s\S]*install\/update route/u);
  });
});
