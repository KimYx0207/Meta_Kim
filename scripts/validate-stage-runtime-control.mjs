#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function repoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

function readText(relativePath) {
  return readFileSync(repoPath(relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hasAll(raw, markers, label) {
  for (const marker of markers) {
    assert(raw.includes(marker), `${label} missing marker: ${marker}`);
  }
}

function hasExactly(raw, markers, label) {
  assert(Array.isArray(raw), `${label} must be an array`);
  assert(raw.length === markers.length, `${label} must contain exactly ${markers.length} entries`);
  hasAll(raw, markers, label);
}

function assertContract() {
  const contract = readJson("config/contracts/stage-runtime-control-contract.json");
  assert(contract.contractId === "stage-runtime-control-contract", "wrong contract id");
  assert(contract.prdTaskId === "P-115", "P-115 must own the stage runtime control contract");
  assert(contract.controlPlaneRules?.hookRole === "last_resort_fuse", "hook must stay last-resort fuse");
  assert(contract.controlPlaneRules?.hookMustNotAdvanceStage === true, "hook must not advance stages");
  assert(
    contract.controlPlaneRules?.businessWorkflowMayBlockTools === false,
    "business workflow phases must not directly block tools",
  );
  assert(
    contract.controlPlaneRules?.sideEffectsRequireExecutionStage === false,
    "ordinary local side effects must not require the Execution stage",
  );
  assert(
    contract.stageChecks?.actionPolicy?.mustNotRequireCommitPackets === true,
    "action policy must not require commit packets",
  );
  assert(
    contract.stageChecks?.actionPolicy?.designStagesMayProceedWithoutAgentDispatch === true,
    "Critical/Fetch/Thinking action policy must not require Agent dispatch",
  );
  assert(
    contract.stageChecks?.commitRequirements?.requiresExplicitTransitionIntent === true,
    "commit requirements must require explicit transition intent",
  );
  assert(
    contract.stageChecks?.executionLease?.requiredForBusinessMutation === false,
    "execution lease must not authorize ordinary project mutation",
  );
  assert(
    contract.stageChecks?.executionLease?.requiredForPublicReadyClaim === true,
    "execution lease must remain required for public-ready claims",
  );
  assert(
    contract.activationPolicy?.autoPromptActivation?.creates === "hook_observed",
    "auto prompt activation must create hook_observed state",
  );
  assert(
    contract.activationPolicy?.autoPromptActivation?.hookGateMode === "advisory",
    "auto prompt activation must use advisory hook gate mode",
  );
  assert(
    contract.activationPolicy?.managedDriverActivation?.driverMode === "managed",
    "managed driver activation must keep managed driverMode",
  );
  assert(
    contract.factGatePolicy?.singleExecutionLease === true,
    "fact gate must be part of the single execution lease",
  );
  assert(
    contract.factGatePolicy?.mustNotBecomeIndependentHookLoop === true,
    "fact gate must not become an independent hook loop",
  );
  assert(
    contract.routeSelectionPolicy?.kind === "route_selection_invariant",
    "type-first route policy must stay a route selection invariant",
  );
  assert(
    contract.routeSelectionPolicy?.mustNotBecomeNewGate === true,
    "type-first route policy must not become another gate",
  );
  assert(
    contract.routeSelectionPolicy?.unclearTypeDisposition === "degrade_or_block_not_guess",
    "unclear route-critical types must degrade or block instead of guessing",
  );
  assert(
    contract.routeSelectionPolicy?.typeFirstRouteRef === "scripts/select-execution-route.mjs#typeFirstRoutePolicy",
    "stage runtime control must point to the executable route policy",
  );
  hasAll(
    contract.fetchPolicy?.inProgressMustAllow ?? [],
    [
      "repo_search",
      "capability_scan",
      "spine_state_write",
      "planning_file_update",
      "task_bookkeeping_control_plane",
      "visible_status_notice",
      "ordinary_project_file_mutation",
      "ordinary_local_command_execution",
    ],
    "fetchPolicy.inProgressMustAllow",
  );
  assert(
    !Object.hasOwn(contract.fetchPolicy ?? {}, "inProgressMustDelay"),
    "Fetch must not retain a hard-delay policy for task bookkeeping",
  );
  hasAll(
    contract.fetchPolicy?.taskBookkeepingPolicy?.appliesDuring ?? [],
    ["critical", "fetch_pre_evidence"],
    "fetchPolicy.taskBookkeepingPolicy.appliesDuring",
  );
  hasAll(
    contract.fetchPolicy?.taskBookkeepingPolicy?.tools ?? [],
    ["TaskCreate", "TaskUpdate", "TodoWrite"],
    "fetchPolicy.taskBookkeepingPolicy.tools",
  );
  assert(
    contract.fetchPolicy?.taskBookkeepingPolicy?.hookDisposition === "allow_without_hard_deny",
    "Critical/pre-evidence Fetch task bookkeeping must not be hard-denied by Hook",
  );
  assert(
    contract.fetchPolicy?.taskBookkeepingPolicy?.queryBypassDisposition ===
      "deny_read_only_boundary",
    "queryBypass must keep task bookkeeping outside its pure read-only boundary",
  );
  assert(
    contract.fetchPolicy?.taskBookkeepingPolicy?.sequencingGuidance === "soft_anti_churn_only",
    "task bookkeeping sequencing must remain soft anti-churn guidance",
  );
  hasAll(
    contract.fetchPolicy?.taskBookkeepingPolicy?.mustNotCountAs ?? [],
    ["fetch_evidence", "agent_dispatch", "stage_progress"],
    "fetchPolicy.taskBookkeepingPolicy.mustNotCountAs",
  );
  assert(
    contract.fetchPolicy?.taskBookkeepingPolicy?.agentDispatchGate ===
      "independent_and_unchanged",
    "real Agent dispatch governance must remain independent from task bookkeeping",
  );
  assert(
    contract.fetchPolicy?.queryBypassControlPlanePolicy?.disposition ===
      "deny_mutating_control_plane_allow_read_only_queries",
    "queryBypass must distinguish mutating control-plane tools from read-only queries",
  );
  hasExactly(
    contract.fetchPolicy?.queryBypassControlPlanePolicy?.denyTools,
    ["TaskCreate", "TaskUpdate", "TodoWrite", "TaskStop", "EnterPlanMode", "ExitPlanMode"],
    "fetchPolicy.queryBypassControlPlanePolicy.denyTools",
  );
  hasExactly(
    contract.fetchPolicy?.queryBypassControlPlanePolicy?.allowTools,
    ["TaskList", "TaskGet", "TaskOutput"],
    "fetchPolicy.queryBypassControlPlanePolicy.allowTools",
  );
  hasAll(
    contract.fetchPolicy?.inProgressMustNotRequire ?? [],
    ["fetchRecord", "agentDispatch"],
    "fetchPolicy.inProgressMustNotRequire",
  );
  hasAll(
    contract.thinkingPolicy?.inProgressMustNotRequire ?? [],
    ["agentDispatch"],
    "thinkingPolicy.inProgressMustNotRequire",
  );
  hasAll(contract.fetchPolicy?.commitRequires ?? [], ["fetchRecord"], "fetchPolicy.commitRequires");
}

function assertPrdAndPackage() {
  const prdPath = "docs/ai-native-capability-gap-mvp-prd.zh-CN.md";
  if (existsSync(repoPath(prdPath))) {
    const prd = readText(prdPath);
    hasAll(
      prd,
      [
        "v0.70 P-115 阶段运行控制面重建",
        "stage-runtime-control-contract",
        "Fetch 进行中不要求 `fetchRecord`",
        "hook 不得自动 `advanceStage`",
        "自动触发只进入 `hook_observed` / `advisory`",
        "ECC / fact gate 归入同一个 execution lease",
        "11-phase 业务流程不得直接 block tool",
        "npm run meta:prd:stage-runtime-control:validate",
      ],
      "unique PRD P-115",
    );
  } else {
    const contract = readJson("config/contracts/stage-runtime-control-contract.json");
    assert(
      contract.sourceOfTruth?.human === prdPath,
      "contract must keep the private PRD human source pointer when docs are not present",
    );
  }

  const pkg = readJson("package.json");
  assert(
    pkg.scripts?.["meta:prd:stage-runtime-control:validate"]?.includes(
      "validate-stage-runtime-control.mjs",
    ),
    "package.json missing meta:prd:stage-runtime-control:validate",
  );
  assert(
    `${pkg.scripts?.["meta:verify:governance"] ?? ""} ${pkg.scripts?.["meta:verify:governance:core"] ?? ""}`.includes(
      "meta:prd:stage-runtime-control:validate",
    ),
    "meta:verify:governance must include P-115 validator",
  );
}

function assertRuntimeSources() {
  const facadePath = "canonical/runtime-assets/shared/hooks/spine-state.mjs";
  const gatePath = "canonical/runtime-assets/shared/hooks/spine-state-gates.mjs";
  const facadeSource = readText(facadePath);
  const gateSource = readText(gatePath);

  hasAll(
    facadeSource,
    [
      'from "./spine-state-gates.mjs"',
      "checkStageRequirements",
      "stageRuntimeControl",
      "isHookObservedState",
      "hookGateMode",
    ],
    facadePath,
  );
  assert(
    !facadeSource.includes("requiresFetchRecordOnCommit: true"),
    `${facadePath} must not duplicate the shared gate policy source`,
  );
  assert(
    gateSource.includes("requiresFetchRecordOnCommit: true"),
    `${gatePath} must use commit-scoped fetchRecord requirement`,
  );
  assert(
    !gateSource.includes("requiresFetchRecord: true"),
    `${gatePath} must not require fetchRecord for a stage-in-progress action`,
  );
  hasAll(
    gateSource,
    ["state.stageTransitionIntent === \"commit\"", "Stage commit requires a fetchRecord"],
    gatePath,
  );

  const hook = readText("canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs");
  assert(!/^\s*advanceStage,?$/m.test(hook), "hook must not import advanceStage");
  assert(!/advanceStage\(state,\s*"fetch"\)/.test(hook), "hook must not auto-advance to Fetch");
  assert(!/advanceStage\(state,\s*'fetch'\)/.test(hook), "hook must not auto-advance to Fetch");
  hasAll(
    hook,
    [
      "isHookObservedState",
      "observedModeNotice",
      "Local execution tools are not stage drivers",
      "must never block or warn on ordinary project edits or local commands",
      "Passive control-plane tools, including task/todo bookkeeping, are allowed",
      "Bookkeeping never records an Agent dispatch",
    ],
    "enforce-agent-dispatch.mjs",
  );
  assert(
    !hook.includes("shouldDelayTaskBookkeeping") &&
      !hook.includes("formatTaskBookkeepingDelayDeny"),
    "Hook must not retain a Critical/pre-evidence Fetch task-bookkeeping hard deny",
  );
  assert(
    !hook.includes("formatDesignStageMutationDeny") &&
      !hook.includes("formatPostExecutionStageDeny"),
    "ordinary local execution must not retain stage-mutation denial helpers",
  );
  assert(
    !hook.includes('source: "spine_chain"') &&
      !hook.includes('source: "spine_chain_walk"'),
    "dispatch history must not be treated as runtime caller identity",
  );

  const activation = readText("canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs");
  hasAll(
    activation,
    ["activationMode: \"hook_observed\"", "hookGateMode: \"advisory\"", "shouldReplaceActiveState"],
    "activate-meta-theory-spine.mjs",
  );
}

function assertRegressionTests() {
  const tests = readText("tests/meta-theory/11-eight-stage-spine.test.mjs");
  const deprecatedModeMarker = ["simple", "Mode"].join("");
  hasAll(
    tests,
    [
      "Fetch in progress does not require fetchRecord until stage commit",
      "Fetch and Thinking in progress do not require Agent dispatch",
      "read-only hook allowance does not auto-advance Critical to Fetch",
      "Fetch stage allows Bash spine-state writes even before fetchRecord exists",
      "Fetch stage allows planning files before fetchRecord exists",
      "Fetch stage allows task bookkeeping without treating it as Fetch evidence",
      "fanout-eligible TaskCreate stays bookkeeping and does not substitute for Agent dispatch",
      "Fetch stage allows ordinary business file mutation without warning",
      "dispatch history cannot impersonate a meta-agent caller or warn on project mutation",
      "runtime-injected meta-agent identity still enforces the readonly role boundary",
      "managed stages allow ordinary local commands without warning",
      "Fetch stage allows Node state repair and ordinary Node project writes",
      `${deprecatedModeMarker} residue in spine state cannot skip Agent dispatch governance`,
      "auto prompt activation creates observed advisory state instead of managed hard-gate state",
      "observed hook state allows ordinary local file mutation without notice",
      "observed hook state does not block commands by keyword or command class",
      "observed hook state keeps command execution advisory even when text contains high-risk words",
      "auto prompt activation does not create command-class publish approvals",
      "auto prompt activation rotates stale legacy active state for a new prompt",
      "Type-first route policy is a route selection invariant, not another gate",
    ],
    "stage runtime regression tests",
  );
}

try {
  assertContract();
  assertPrdAndPackage();
  assertRuntimeSources();
  assertRegressionTests();
  console.log("stage runtime control valid: P-115 contract, package wiring, sources, and tests aligned");
} catch (error) {
  console.error(`stage runtime control invalid: ${error.message}`);
  process.exitCode = 1;
}
