import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { durableCapabilityRequestsFromTask } from "../../scripts/capability-request-intent.mjs";
import {
  buildProjectCustomizationPacket,
  executeProjectCustomizationPacket,
} from "../../scripts/run-meta-theory-governed-execution.mjs";

const globalOwner = {
  id: "test-automator",
  type: "agents",
  source: "local_global_agent_inventory",
  sourceRef: "~/.codex/agents/test-automator.toml",
};

test("candidate-only and pending approval clauses never become capability names or mutation authority", () => {
  for (const task of [
    "Create a candidate-only skill unless Warden approval is supplied.",
    "Create skill project-checklist unless Warden approval is supplied, responsible for checking release files.",
    "Create candidate-only skill named project-checklist for repeatable release verification.",
    "请创建 skill project-checklist，用于发布验证，但仅作为候选，批准后再落盘。",
  ]) {
    const requests = durableCapabilityRequestsFromTask(task);
    assert.ok(requests.every((request) => request.mutationAuthorized === false), task);
    assert.ok(requests.every((request) => request.explicitCapabilityId !== "unless"), task);
  }
  const explicit = durableCapabilityRequestsFromTask("请创建 skill project-checklist，用于发布验证并拒绝修改用户文件。");
  assert.equal(explicit[0].explicitCapabilityId, "project-checklist");
  assert.equal(explicit[0].mutationAuthorized, true);
  assert.equal(explicit[0].requestedAction, "create", "refusal to modify user files is not an iteration request");
  for (const task of [
    "Create skill named unless, responsible for repeatable release verification.",
    "Create skill named unless for repeatable release verification.",
  ]) {
    const namedUnless = durableCapabilityRequestsFromTask(task);
    assert.equal(namedUnless[0].explicitCapabilityId, "unless");
    assert.equal(namedUnless[0].specificationReady, true);
    assert.equal(namedUnless[0].mutationAuthorized, true, "an explicit identifier is distinct from an unless approval clause");
  }
  for (const task of [
    "Create skill named unless for repeatable release verification unless Warden approval is supplied.",
    "Create skill named unless for repeatable release verification, candidate-only until approval.",
  ]) {
    const conditional = durableCapabilityRequestsFromTask(task);
    assert.equal(conditional[0].explicitCapabilityId, "unless");
    assert.equal(conditional[0].mutationAuthorized, false, "conditions after a name still withhold mutation authority");
  }
  assert.deepEqual(durableCapabilityRequestsFromTask("Create a backend API for save response verification."), []);
});

function packet(task, localGlobalAgents = [globalOwner]) {
  return buildProjectCustomizationPacket({
    task,
    runId: "three-way",
    runtime: "codex",
    orchestrationReport: {
      selectedExecutionRoute: {
        ownerDiscoveryPacket: {
          localGlobalAgents,
          projectRuntimeAgents: [],
          localGlobalCapabilityProviders: [],
          projectRuntimeCapabilityProviders: [],
          candidateReusableCapabilityProviders: [],
        },
      },
    },
    runtimeInvocationPlanPacket: { requiredBindings: [] },
    outputLanguage: "zh-CN",
  });
}

test("negative capability creation clauses produce no durable request while preserving separate affirmative requests", () => {
  for (const task of [
    "读取 package.json 并报告名称，同时显示 Agent、Skill、Command、MCP 的真实调用状态，不创建项目级能力。",
    "只解释 agent 的职责，不创建 agent。",
    "检查 skill 的现状，不再修改。",
    "Read package.json and show Agent, Skill, Command, MCP status without creating project capabilities.",
  ]) {
    assert.deepEqual(durableCapabilityRequestsFromTask(task), [], task);
    const result = packet(task);
    assert.equal(result.decision, "use_global_directly", task);
    assert.deepEqual(result.decisions, [], "A denial must not create a project capability candidate");
  }
  const separate = durableCapabilityRequestsFromTask("不创建 skill alpha；请创建 command beta，用于检查仓库状态。");
  assert.equal(separate.length, 1);
  assert.equal(separate[0].explicitCapabilityId, "beta");
  assert.equal(separate[0].mutationAuthorized, true);
  const scopedBoundary = durableCapabilityRequestsFromTask("请创建 skill project-auditor，用于审查发布内容，不修改用户文件。");
  assert.equal(scopedBoundary.length, 1);
  assert.equal(scopedBoundary[0].requestedAction, "create");
  assert.equal(scopedBoundary[0].mutationAuthorized, true);
});

test("a fitting global capability with no iteration stays global and creates no project target", () => {
  const result = packet("全局 test-automator agent 已经够用，不需要迭代，直接复用");
  assert.equal(result.decision, "use_global_directly");
  assert.equal(result.decisions[0].copyPolicy, "use_global_directly");
  assert.equal(result.decisions[0].targetPath, "~/.codex/agents/test-automator.toml");
  assert.equal(result.decisions[0].projectOwnershipClass, null);
  assert.equal(result.decisions[0].projectCopyCommand, null);
});

test("a global capability that needs iteration is copied to the native project target", () => {
  const result = packet("需要迭代全局 test-automator agent，针对当前项目修改");
  assert.equal(result.decision, "upgrade_existing_owner");
  assert.equal(result.decisions[0].copyPolicy, "copy_to_project_for_modification");
  assert.equal(result.decisions[0].sourceCapabilityRef, "~/.codex/agents/test-automator.toml");
  assert.equal(result.decisions[0].targetPath, ".codex/agents/test-automator.toml");
  assert.equal(result.decisions[0].projectOwnershipClass, "runtime_sedimented_project_copy");
  assert.match(result.decisions[0].projectCopyCommand, /project capability copy/u);
});

test("a real project gap creates a project-native capability instead of a global file", () => {
  const result = packet("需要在本项目新建 agent project-auditor", []);
  assert.equal(result.decision, "create_project_local_capability");
  assert.equal(result.decisions[0].copyPolicy, "create_project_local_capability");
  assert.match(result.decisions[0].targetPath, /^\.codex\/agents\//u);
  assert.equal(result.decisions[0].projectOwnershipClass, "runtime_sedimented_project_copy");
});

test("exact global Skill and Command reuse survives compacted provider packets", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-global-reuse-discovery-"));
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_HOME: process.env.CODEX_HOME,
    META_KIM_CODEX_HOME: process.env.META_KIM_CODEX_HOME,
    META_KIM_CALLER_CWD: process.env.META_KIM_CALLER_CWD,
  };
  try {
    const codexHome = path.join(root, ".codex");
    const projectRoot = path.join(root, "project");
    mkdirSync(path.join(codexHome, "skills", "exact-global-skill"), { recursive: true });
    mkdirSync(path.join(codexHome, "commands"), { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(path.join(codexHome, "skills", "exact-global-skill", "SKILL.md"), "# skill\n");
    writeFileSync(path.join(codexHome, "commands", "exact-global-command.md"), "# command\n");
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.CODEX_HOME = codexHome;
    process.env.META_KIM_CODEX_HOME = codexHome;
    process.env.META_KIM_CALLER_CWD = projectRoot;

    const result = packet([
      "直接复用全局 skill exact-global-skill，不需要迭代，也不要复制到项目。",
      "直接复用全局 command exact-global-command，不需要迭代，也不要复制到项目。",
    ].join("\n"), []);
    assert.equal(result.decision, "use_global_directly");
    assert.deepEqual(result.decisions.map((decision) => decision.copyPolicy), [
      "use_global_directly",
      "use_global_directly",
    ]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Japanese and Korean summaries describe existing project reuse without calling it global", () => {
  const packet = {
    status: "decision_ready",
    userSummary: "reuse",
    routeConfirmed: true,
    decisions: [{
      requestId: "existing-project-agent",
      capabilityType: "agent",
      requestedCapability: "project-reviewer",
      copyPolicy: "use_global_directly",
      targetPath: ".codex/agents/project-reviewer.toml",
      reason: "matching project capability exists",
      projectCandidateChecked: { matched: true },
    }],
  };
  for (const [language, expected, forbidden] of [
    ["ja-JP", /既存のプロジェクト/u, /グローバル/u],
    ["ko-KR", /기존 프로젝트/u, /전역/u],
  ]) {
    const result = executeProjectCustomizationPacket({
      packet,
      runtime: "codex",
      runId: `existing-project-${language}`,
      projectRoot: path.resolve("."),
      outputLanguage: language,
    });
    assert.match(result.userSummary, expected);
    assert.doesNotMatch(result.userSummary, forbidden);
    assert.equal(result.execution.noCopyCount, 1);
  }
});
