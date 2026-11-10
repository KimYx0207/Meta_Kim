import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";

import {
  discoverDependencyAgentContracts,
  matchDependencyAgentContracts,
} from "../../scripts/dependency-agent-discovery.mjs";
import { agentCapabilityProfileDigest, agentProfileOwnerBinding, saveAgentCapabilityProfiles } from "../../scripts/agent-capability-profile.mjs";
let runtimeFixture;
function routingFixture(t) {
  const runtime = createGovernanceRuntimeFixture(t);
  // Refresh source-only pins inside the copied fixture, never host evidence.
  const pins = runtime.run(["scripts/refresh-runtime-evidence-pins.mjs"]);
  assert.equal(pins.status, 0, pins.stderr || pins.stdout);
  return runtime;
}
before(() => {
  runtimeFixture = routingFixture(null);
});
after(() => runtimeFixture?.cleanup());


const project = {
  id: "kim-service",
  source: { localPath: null },
  interface: {
    capabilityIndex: {
      format: "component-capabilities-v1",
      path: "generated/capabilities.json",
      rootEnv: "META_KIM_KIM_SERVICE_ROOT",
    },
  },
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])]),
  );
  return value;
}
const serialize = (value) => JSON.stringify(stable(value), null, 2) + "\n";

// Fixture host reasoning for diagnostic route previews; no native execution or
// user approval is asserted. The contract and original request remain bound.
function assessmentArgs(task, owner) {
  return ["--method-assessment-json", JSON.stringify({ schemaVersion: 1,
    taskHash: sha(task), agentId: owner.id, contentDigest: owner.contentDigest,
    componentContentSha256: owner.ownerContract.componentContentSha256,
    operation: "read supplied facts and draft the requested text",
    deliverable: "factual text for the requested audience",
    fitRationale: "Fixture host inspected this source's input, output and read-only exclusions.",
    nonGoals: ["publishing", "inventing facts"], evidenceRefs: [owner.sourceRef],
  })];
}

test("dependency project profile consumes its declared source root and cannot bypass a Type B fit decision", async (t) => {
  const service = fixture(t);
  const projectRoot = fs.mkdtempSync(path.join(runtimeFixture.root, "profile-business-B-"));
  fs.mkdirSync(path.join(projectRoot, ".git"));
  const write = (ref, value) => {
    const target = path.join(projectRoot, ref);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
    return { ref, contentDigest: `sha256:${sha(fs.readFileSync(target))}` };
  };
  const evidence = write("AGENTS.md", "Draft from verified work history only. No publishing or invented experience.");
  const material = write("materials/work-history.md", "Fixture facts: customer support, verified employment dates; no invented achievements.");
  const skillRef = ".agents/skills/resume-history/SKILL.md";
  const projectSkill = write(skillRef, "# Verified resume history\n\nBusiness B: retain the verified employment dates and do not invent achievements.\n");
  for (const [id, content] of [["resume-history", "Framework A shadow: must not supply the business method."], ["framework-only-method", "Only framework A owns this method."]]) {
    const dir = path.join(runtimeFixture.repoRoot, ".agents/skills", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), content);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  }
  const discovered = await discoverDependencyAgentContracts({ ...service.options, projectRoot });
  const owner = discovered.agents.find((entry) => entry.id === "kim-service:resume-editor");
  const profile = { capabilityProfileId: "resume-project", capabilityProfileVersion: "1", owner: agentProfileOwnerBinding(owner, { projectRoot }),
    capabilityLoadout: { slots: [
      { capabilitySlot: "context", bindingType: "skill", providerId: "get-context", mode: "default" },
      { capabilitySlot: "resume-history", bindingType: "skill", providerId: "resume-history", mode: "default" },
    ] }, projectEvidenceRefs: [evidence], materialRefs: [material, projectSkill], referenceDirection: "Use the verified history and retain the source contract's read-only boundary." };
  const preview = saveAgentCapabilityProfiles({ projectRoot, profiles: [profile], expectedOldHash: null });
  const approval = write("reviews/adopt.json", { scope: "project_capability_profile", status: "approved", projectRoot, candidateDigest: preview.contentDigest, expectedOldHash: null,
    evidenceClass: "fixture_artifact_not_host_approval" });
  assert.equal(saveAgentCapabilityProfiles({ projectRoot, profiles: [profile], approvalRefs: [approval], expectedOldHash: null, apply: true }).status, "committed");
  const contextFor = (resolution) => {
    const assessmentRef = write(`reviews/fit-${resolution}.json`, { projectRoot, owner: profile.owner, capabilityProfileId: profile.capabilityProfileId, capabilityProfileVersion: "1",
      profileDigest: agentCapabilityProfileDigest(profile), ownerResolution: resolution, evidenceRefs: [evidence], rationale: "Fixture host assessment: this actual source contract fits factual resume drafting.", hardConflicts: [] });
    const approvalRef = write(`reviews/approval-${resolution}.json`, { scope: "project_agent_fit", status: "approved", projectRoot, assessmentDigest: assessmentRef.contentDigest });
    return { profileSelections: [], fitAssessments: [{ owner: profile.owner, assessmentRef }], approvalRefs: [approvalRef] };
  };
  const route = (context, businessRoot = projectRoot) => {
    const result = runtimeFixture.run(["scripts/select-execution-route.mjs", "--task", "请把我的客服经历改成运营助理岗位简历", "--runtime", "codex", "--os", "windows", "--json",
      ...(businessRoot ? ["--project-root", businessRoot] : []),
      "--agent-profile-context-json", JSON.stringify(context),
      ...assessmentArgs("请把我的客服经历改成运营助理岗位简历", owner)], { env: { ...runtimeFixture.env, META_KIM_KIM_SERVICE_ROOT: service.root } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const ready = route(contextFor("reuse_existing_owner"));
  assert.equal(ready.recommendedRoute?.owner, owner.id);
  assert.equal(ready.recommendedRoute.agentCapabilityProfile.contentDigest, agentCapabilityProfileDigest(profile));
  assert.equal(ready.recommendedRoute.agentCapabilityProfile.materials[0].content, fs.readFileSync(path.join(projectRoot, material.ref), "utf8"));
  assert.equal(ready.recommendedRoute.codexSpawnBinding.ownerBindingMode, "run_scoped_owner_contract");
  assert.equal(ready.recommendedRoute.codexSpawnBinding.nativeAgentType, null);
  assert.equal(ready.recommendedRoute.selectedCapabilityProviders.agent.source, "dependency_agent_contract");
  const selected = ready.recommendedRoute.selectedCapabilityProviders.skill;
  assert.equal(selected.id, "resume-history");
  assert.equal(selected.source, "project_runtime_skill_inventory");
  assert.equal(selected.sourceRef, skillRef);
  assert.equal(selected.runtime, "codex");
  assert.equal(selected.contentDigest, projectSkill.contentDigest.slice(7), "the selected provider is B's bytes, not A's same-name shadow");
  assert.equal(ready.ownerDiscoveryPacket.projectRuntimeCapabilityProviders.some((entry) => entry.id === "framework-only-method"), false);
  const global = ready.recommendedRoute.selectedCapabilityProviders["profile:skill:context"];
  assert.equal(global.source, "codex_global_skill_filesystem_light_scan");
  assert.equal(global.sourceRef, "~/.codex/skills/get-context/SKILL.md");
  for (const binding of [ready.recommendedRoute.codexSpawnBinding, ready.workerTaskPacketDrafts[0].codexSpawnBinding]) {
    const message = JSON.parse(binding.message);
    assert.equal(message.capabilityLoadout.selectedProviders.skill.contentDigest, projectSkill.contentDigest.slice(7));
    const body = message.requiredMaterials.find((entry) => entry.sourceRef === skillRef);
    assert.equal(body.content, fs.readFileSync(path.join(projectRoot, skillRef), "utf8"));
    assert.equal(body.contentDigest, projectSkill.contentDigest);
  }
  const deferred = route(contextFor("upgrade_existing_owner"));
  assert.equal(deferred.recommendedRoute, null);
  assert.ok(deferred.capabilityGapPacket.projectCapabilityProfileDecisions.some((entry) => entry.ownerResolution === "upgrade_existing_owner"));
  assert.equal(fs.existsSync(path.join(projectRoot, ".codex/agents")), false);
  assert.equal(fs.existsSync(path.join(projectRoot, ".meta-kim/state/default/project-capabilities.json")), false);
  const sameRoot = route({}, null);
  assert.equal(sameRoot.recommendedRoute.owner, owner.id);
  const ownSkill = sameRoot.ownerDiscoveryPacket.projectRuntimeCapabilityProviders.find((entry) => entry.id === "resume-history");
  assert.equal(ownSkill.contentDigest, sha(fs.readFileSync(path.join(runtimeFixture.repoRoot, skillRef))));
  assert.ok(sameRoot.ownerDiscoveryPacket.projectRuntimeCapabilityProviders.some((entry) => entry.id === "framework-only-method"));
});

function fixture(t, { tools = "Read", professionalReview = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meta-kim-agent-index-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const components = [];
  const capabilities = [];
  for (const [id, summary, triggers] of [
    ["resume-editor", "简历修改：根据真实经历匹配目标岗位", ["帮我把简历改得更清楚", "简历怎样匹配目标岗位", "真实工作经历不知道怎么写"]],
    ["lesson-planner", "备课与课堂设计：按学生起点安排教学", ["设计一节数学课", "明天这课怎么讲", "教案里怎样安排练习"]],
    ["product-listing-writer", "商品页文案：把商品参数写成详情页", ["写商品详情页", "把商品参数改成卖点", "检查商品文案有没有夸大"]],
    ["topic-planner", "为自媒体账号产出有角度与排期的选题", ["不知道发什么", "找几个可用的话题", "计划下周内容"]],
    ["headline-cover-optimizer", "标题封面优化：校准封面文字与正文承诺", ["正文已有，标题不知道怎么写", "封面放什么文字", "起一个小红书标题", "write three headlines and cover copy", "Please write three headlines to improve conversion", "how should we rewrite headlines to improve conversion"]],
    ["script-writer", "脚本文案：按已有选题写正文", ["根据选题和素材写小红书正文", "口播怎么写", "写脚本文案"]],
    ["interview-coach", "面试练习：按岗位提供真实经历反馈", ["陪我练面试", "我的经历怎么回答", "目标岗位怎么自我介绍"]],
    ["workplace-writer", "周报邮件整理：把实际工作进度写清楚", ["写一份工作周报", "邮件怎么说清进度", "汇报已完成和待确认的事"]],
    ["pricing-cost-analyst", "报价与成本测算：比较价格和现金投入", ["核算报价", "计算单笔成本", "几个价格怎么选"]],
    ["concept-tutor", "概念讲解与答疑：解释学习者卡住的那一步", ["这道题为什么这样算", "这个概念我一直听不懂", "不要只给答案帮我讲明白"]],
    ...(professionalReview ? [["product-architect", "Product architecture and requirements review", ["product architecture", "review the current candidate", "product-architect"]]] : []),
  ]) {
    const capability = {
      id: id === "product-architect" ? "product-architect-deliver" : `${id}-assist`, summary, useWhen: triggers,
      doNotUseWhen: ["不发布", "不编造事实", "不处理其他角色的工作"],
      input: { type: "object", properties: { facts: { type: "string" } }, required: ["facts"] },
      output: { type: "object", properties: { draft: { type: "string", description: "事实 / 草稿" } }, required: ["draft"] },
      permissions: ["filesystem:read-user-materials"], sideEffects: [],
      humanGate: { required: true, when: ["发布须另行决定"] },
      validation: ["tests/contract.test.mjs"],
    };
    const contract = {
      schemaVersion: 1, id, componentType: "agent", componentVersion: "0.1.0",
      entrypoint: "AGENT.md", capabilities: [capability],
    };
    const componentPath = `agents/${id}`;
    const componentRoot = path.join(root, componentPath);
    const files = {
      "AGENT.md": `---\nname: ${id}\ndescription: ${summary}\ntools: ${tools}\n---\n\n# ${summary.split("：")[0]}\n\n只交付有事实依据的草稿。\n`,
      "capability.json": serialize(contract),
      "tests/contract.test.mjs": 'import fs from "node:fs"; fs.writeFileSync("must-not-execute.txt", "unsafe");\n',
    };
    const hash = createHash("sha256");
    for (const name of Object.keys(files).sort()) {
      fs.mkdirSync(path.dirname(path.join(componentRoot, name)), { recursive: true });
      fs.writeFileSync(path.join(componentRoot, name), files[name]);
      hash.update(name).update("\0").update(files[name]).update("\0");
    }
    const contentSha256 = hash.digest("hex");
    const contractSha256 = sha(serialize(contract));
    components.push({ id, componentType: "agent", componentVersion: "0.1.0", path: componentPath,
      entrypoint: "AGENT.md", validation: capability.validation, capabilityIds: [capability.id],
      contentSha256, contractSha256 });
    capabilities.push({ ...capability, componentId: id, componentType: "agent", componentVersion: "0.1.0",
      componentPath, entrypoint: "AGENT.md", componentContentSha256: contentSha256, contractSha256 });
  }
  const index = { schemaVersion: 1, componentCount: components.length, capabilityCount: capabilities.length, components, capabilities };
  const indexFile = path.join(root, "generated/capabilities.json");
  fs.mkdirSync(path.dirname(indexFile));
  const save = () => fs.writeFileSync(indexFile, serialize(index));
  save();
  const options = { projectRoot: root, projects: [project], localOverrides: {}, environment: { META_KIM_KIM_SERVICE_ROOT: root } };
  return { root, index, save, options };
}

test("discovery reads verified external contracts without executing their validation code or claiming native loading", async (t) => {
  const { root, options } = fixture(t);
  const result = await discoverDependencyAgentContracts(options);
  assert.equal(result.sources[0].status, "verified_local");
  assert.equal(result.capabilities.length, 10);
  const resume = result.agents.find((agent) => agent.id === "kim-service:resume-editor");
  assert.equal(resume.ownerBindingMode, "run_scoped_owner_contract");
  assert.equal(resume.validCustomAgentDefinition, false);
  assert.equal(resume.nativeAgentType, null);
  assert.ok(resume.ownerContract.input.required.includes("facts"));
  assert.deepEqual(resume.ownerContract.sideEffects, []);
  assert.match(resume.contentDigest, /^[a-f0-9]{64}$/);
  for (const capability of result.capabilities) {
    assert.equal(capability.canExecute, false);
    assert.equal(capability.ownerBoundary, "professional_execution_contract");
    assert.ok(Object.values(capability.runtimeSupport).every((support) => support === "unknown"));
  }
  assert.equal(fs.existsSync(path.join(root, "must-not-execute.txt")), false);
});

test("plain Chinese requests recall contracts while owner selection requires a current host assessment", async (t) => {
  const { options } = fixture(t);
  const { agents } = await discoverDependencyAgentContracts(options);
  for (const [request, expected] of [
    ["请把我的客服经历改成运营助理岗位简历", "kim-service:resume-editor"],
    ["帮小学老师备课，安排四十分钟数学课堂", "kim-service:lesson-planner"],
    ["根据这些商品参数整理详情页文案", "kim-service:product-listing-writer"],
    ["请围绕家常菜做选题清单", "kim-service:topic-planner"],
    ["这篇正文写好了，请给小红书标题和封面文字", "kim-service:headline-cover-optimizer"],
    ["把本周报价进度写成发给主管的周报", "kim-service:workplace-writer"],
    ["我不明白分数除法为什么要乘倒数，请一步步讲解", "kim-service:concept-tutor"],
  ]) {
    const recall = matchDependencyAgentContracts(request, agents);
    assert.equal(recall.candidates[0]?.id, expected, request);
    assert.equal(recall.selected, null, "Lexical ranking never chooses the execution owner");
    const owner = agents.find(agent => agent.id === expected);
    const hostSelection = { schemaVersion: 1, taskHash: recall.taskHash, agentId: owner.id, contentDigest: owner.contentDigest,
      componentContentSha256: owner.ownerContract.componentContentSha256, operation: "Prepare the requested professional result", deliverable: request,
      fitRationale: "Fixture host checked the candidate contract against this request", nonGoals: [], evidenceRefs: ["fixture:host-method-assessment"] };
    assert.equal(matchDependencyAgentContracts(request, agents, { hostSelection }).selected?.id, expected);
    assert.equal(matchDependencyAgentContracts(request + " changed", agents, { hostSelection }).selected, null);
    assert.equal(matchDependencyAgentContracts(request, agents, { hostSelection: { ...hostSelection, componentContentSha256: "0".repeat(64) } }).selected, null);
  }
  assert.equal(matchDependencyAgentContracts("帮我处理一些事情", agents).selected, null);
  assert.equal(matchDependencyAgentContracts("修复 Node Hook timeout 的回归测试", agents).selected, null);
  assert.equal(matchDependencyAgentContracts("Critical Thinking Fetch Deep Thinking Review 为什么 Codex 一直创建 agent 而不是找全局 agent", agents).selected, null);
  assert.equal(matchDependencyAgentContracts("为什么一直没有反应", agents).selected, null);
  assert.equal(matchDependencyAgentContracts("先不要执行", agents).selected, null);
  assert.equal(matchDependencyAgentContracts("帮我修改这个项目的清单", agents).selected, null);
  const sameBoundary = agents.filter((agent) => agent.componentId === "resume-editor");
  assert.equal(matchDependencyAgentContracts("按真实经历写简历", [...sameBoundary, { ...sameBoundary[0], id: "other:resume-editor" }]).selected, null);
});

test("short intent, quoted context and negative role mentions cannot silently become professional recommendations", () => {
  const agents = [
    { id: "kim-service:customer-service-writer", componentId: "customer-service-writer", displayName: "客户客服写作者", trigger: ["客户服务"] },
    { id: "kim-service:workplace-writer", componentId: "workplace-writer", displayName: "工作职场写作者", trigger: ["工作框架"] },
    { id: "kim-service:frontend-engineer", componentId: "frontend-engineer", displayName: "前端工程师", trigger: ["前端实现"] },
  ];
  for (const request of ["我想做个客户管理工具，先帮我想清楚怎么做", "请调查一下 GitHub 上可参考的工作流框架", "这次不要前端实现，只讨论采购方案", "文档里写了 frontend-engineer，这次只要研究方案"]) {
    const result = matchDependencyAgentContracts(request, agents);
    assert.equal(result.selected, null, request);
    assert.equal(result.semanticFitVerified, false);
  }
});

test("Service read and search tools share the existing filesystem read contract without granting native execution", async (t) => {
  for (const tools of ["Read, Grep, Glob", "Grep, Glob"]) {
    const { options } = fixture(t, { tools });
    const result = await discoverDependencyAgentContracts(options);
    assert.equal(result.sources[0].status, "verified_local", JSON.stringify(result.sources));
    assert.ok(result.agents.length > 0);
    assert.ok(result.agents.every(agent => agent.validCustomAgentDefinition === false));
    assert.ok(result.capabilities.every(capability => capability.canExecute === false));
    assert.ok(result.capabilities.every(capability => capability.risk.canMutateFiles === false));
  }
});

test("a reindexed prompt cannot grant tools absent from its read-only capability contract", async (t) => {
  const { options } = fixture(t, { tools: "Read, Bash" });
  const result = await discoverDependencyAgentContracts(options);
  assert.deepEqual(result.agents, []);
  assert.match(result.sources[0].reason, /tools.*permission/i);
});

test("unconfigured dependencies stay discoverable as a gap without scanning sibling folders", async () => {
  const result = await discoverDependencyAgentContracts({ projects: [project], projectRoot: process.cwd(), environment: {}, localOverrides: {} });
  assert.deepEqual(result.capabilities, []);
  assert.equal(result.sources[0].status, "not_configured");
});

test("explicit missing roots do not fall through to another configured copy", async (t) => {
  const { root, options } = fixture(t);
  const result = await discoverDependencyAgentContracts({ ...options,
    localOverrides: { dependencyRoots: { "kim-service": root } },
    environment: { META_KIM_KIM_SERVICE_ROOT: path.join(root, "missing") } });
  assert.deepEqual(result.agents, []);
  assert.equal(result.sources[0].status, "missing");
});

test("a reference-only dependency stays outside execution even when its files and hashes are valid", async (t) => {
  const { options } = fixture(t);
  const result = await discoverDependencyAgentContracts({ ...options, projects: [{
    ...project, capabilityCard: { routeEligibility: "reference_only" },
  }] });
  assert.deepEqual(result.agents, []);
  assert.equal(result.sources[0].status, "reference_only");
});

test("content drift and generated-index forgery cannot become owner candidates", async (t) => {
  await t.test("edited prompt invalidates the recorded component hash", async (t) => {
    const { root, options } = fixture(t);
    fs.appendFileSync(path.join(root, "agents/resume-editor/AGENT.md"), "changed\n");
    const result = await discoverDependencyAgentContracts(options);
    assert.deepEqual(result.agents, []);
    assert.match(result.sources[0].reason, /content.*hash/i);
  });
  await t.test("forged index text cannot outrank its source contract", async (t) => {
    const { index, save, options } = fixture(t);
    index.capabilities[0].useWhen.push("请处理我的银行卡和密码");
    save();
    const result = await discoverDependencyAgentContracts(options);
    assert.deepEqual(result.agents, []);
    assert.match(result.sources[0].reason, /index.*contract/i);
  });
});

test("paths cannot escape the declared package or traverse a directory link", async (t) => {
  await t.test("parent traversal", async (t) => {
    const { index, save, options } = fixture(t);
    index.components[0].path = "../elsewhere";
    save();
    const result = await discoverDependencyAgentContracts(options);
    assert.deepEqual(result.agents, []);
    assert.match(result.sources[0].reason, /path|component/i);
  });
  await t.test("junction or symlink", async (t) => {
    const { root, options } = fixture(t);
    const target = path.join(root, "original-agents");
    fs.renameSync(path.join(root, "agents"), target);
    fs.symlinkSync(target, path.join(root, "agents"), process.platform === "win32" ? "junction" : "dir");
    const result = await discoverDependencyAgentContracts(options);
    assert.deepEqual(result.agents, []);
    assert.match(result.sources[0].reason, /symlink|junction/i);
  });
});

test("the existing route selector binds a host-assessed contract without claiming invocation", async (t) => {
  const { root, options } = fixture(t);
  const owner = (await discoverDependencyAgentContracts(options)).agents.find(agent => agent.id === "kim-service:resume-editor");
  const result = runtimeFixture.run(["scripts/select-execution-route.mjs", "--task", "请把我的客服经历改成运营助理岗位简历", "--runtime", "codex", "--os", "windows", "--json",
    ...assessmentArgs("请把我的客服经历改成运营助理岗位简历", owner)], {
    encoding: "utf8", timeout: 90_000,
    env: { ...runtimeFixture.env, META_KIM_KIM_SERVICE_ROOT: root },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const route = JSON.parse(result.stdout);
  assert.equal(route.recommendedRoute?.owner, "kim-service:resume-editor");
  assert.equal(route.entryClassification.path, "standard_path");
  assert.equal(route.routeExecutionGate.applies, true);
  assert.equal(route.recommendedRoute.dependencyProject, "kim-service");
  assert.equal(route.recommendedRoute.selectedCapabilityProviders.agent.ownerBindingMode, "run_scoped_owner_contract");
  assert.equal(route.recommendedRoute.codexSpawnBinding.ownerBindingMode, "run_scoped_owner_contract");
  assert.equal(route.recommendedRoute.codexSpawnBinding.nativeAgentType, null);
  assert.equal(route.recommendedRoute.executionEligible, false);
  assert.equal(route.ownerDiscoveryPacket.dependencyAgentDiscovery.sources[0].status, "verified_local");
  const message = JSON.parse(route.recommendedRoute.codexSpawnBinding.message);
  assert.equal(message.ownerContract.dependencyId, "kim-service");
  assert.deepEqual(message.ownerContract.sideEffects, []);
  assert.equal(message.ownerContract.output.properties.draft.description, "事实 / 草稿");
});

test("engineering work mentioning a professional domain does not select a read-only content role", (t) => {
  const { root } = fixture(t);
  const result = runtimeFixture.run(["scripts/select-execution-route.mjs", "--task", "修复商品详情页的 JavaScript 代码和 API 报错", "--runtime", "codex", "--os", "windows", "--json"], {
    encoding: "utf8", timeout: 90_000,
    env: { ...runtimeFixture.env, META_KIM_KIM_SERVICE_ROOT: root },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const route = JSON.parse(result.stdout);
  assert.notEqual(route.recommendedRoute?.owner, "kim-service:product-listing-writer");
  assert.equal(route.ownerDiscoveryPacket.dependencyAgentDiscovery.match.selected, null);
});

test("implementation, build failure and inspection select the corresponding professional owner", (t) => {
  const runtime = routingFixture(t);
  for (const [id, description] of [
    ["code-reviewer", "Review code and report findings; no implementation."],
    ["build-error-resolver", "Resolve build and type errors only."],
    ["javascript-pro", "Implement and repair JavaScript applications."],
    ["python-pro", "Implement and repair Python applications."],
    ["doc-updater", "Maintain product and API documentation."],
  ]) {
    fs.writeFileSync(path.join(runtime.home, ".codex/agents", `${id}.toml`),
      `name = "${id}"\ndescription = "${description}"\ndeveloper_instructions = "Discovery fixture only; does not prove host invocation."\n`);
  }
  const run = (task) => {
    const result = runtime.run(["scripts/select-execution-route.mjs", "--task", task, "--runtime", "codex", "--os", "windows", "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const cases = [
    ["修复 Python 后端保存响应的并发竞态，保留事务和版本历史。", "python-pro"],
    ["修复 React 前端页面的 JavaScript 提交状态。", "frontend"],
    ["修复前端 TypeScript 代码的构建失败和类型错误。", "build-error-resolver"],
    ["修复后端 TypeScript 代码中的分页错误。", "javascript-pro"],
    ["Repair the Node.js backend API pagination logic.", "javascript-pro"],
    ["只读审查后端 API 代码，只列出问题，不修改文件。", "code-reviewer"],
    ["Run backend API regression tests and verify pagination.", "test"],
    ["运行后端 API 回归测试，验证分页结果。", "test"],
    ["只读审查后端 API 回归测试，列出覆盖缺口，不修改文件。", "code-reviewer"],
    ["编写 Python API 文档和 README。", "doc-updater"],
  ];
  for (const [task, owner] of cases) assert.equal(run(task).recommendedRoute?.owner, owner, task);

  // Real inventories need not contain the fixture's broad backend/worker aliases.
  for (const id of ["backend", "worker", "frontend"]) {
    fs.rmSync(path.join(runtime.home, ".codex/agents", `${id}.toml`));
  }
  for (const [task, owner] of cases) {
    assert.equal(run(task).recommendedRoute?.owner, owner === "frontend" ? "javascript-pro" : owner, task);
  }
  const missing = run("检查并修复后端数据接口中的分页与边界处理问题，给出最小代码改动及可复现验证办法。");
  assert.equal(missing.recommendedRoute, null);
  assert.equal(missing.capabilityGapPacket?.returnToStage, "Thinking");
  const execution = missing.rankedRoutes.find((route) => route.id.startsWith("execution-capability-discovery:"));
  assert.equal(execution.owner, null);
  assert.ok(execution.blockedReasons.includes("execution owner missing"));
});

test("owner qualification preserves domain and execution boundaries across inventory gaps", (t) => {
  const runtime = routingFixture(t);
  const run = (task) => {
    const result = runtime.run(["scripts/select-execution-route.mjs", "--task", task, "--runtime", "codex", "--os", "windows", "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const assertOwnerGap = (task) => {
    const result = run(task);
    assert.equal(result.recommendedRoute, null, task);
    assert.equal(result.capabilityGapPacket?.returnToStage, "Thinking", task);
    const execution = result.rankedRoutes.find((route) => route.id.startsWith("execution-capability-discovery:"));
    assert.equal(execution.owner, null, task);
    assert.ok(execution.blockedReasons.includes("execution owner missing"), task);
  };
  const regressionTask = "Run backend API regression tests and verify pagination.";
  assert.equal(run("Implement Python backend API for build artifact metadata persistence.").recommendedRoute?.owner, "backend");
  assert.equal(run(regressionTask).recommendedRoute?.owner, "test");
  assert.equal(run("只读审查后端 API 回归测试，列出覆盖缺口，不修改文件。").recommendedRoute?.owner, "review");
  fs.rmSync(path.join(runtime.home, ".codex/agents/test.toml"));
  assert.equal(run(regressionTask).recommendedRoute?.owner, "worker");

  for (const id of ["frontend", "worker"]) fs.rmSync(path.join(runtime.home, ".codex/agents", `${id}.toml`));
  assertOwnerGap("修复 React 前端页面的提交状态，保留当前界面交互。");
  assertOwnerGap(regressionTask);
  fs.rmSync(path.join(runtime.home, ".codex/agents/backend.toml"));
  const pythonRepair = "修复 Python 后端保存响应的并发竞态，保留事务和版本历史。";
  for (const id of ["python-reviewer", "python-pro"]) {
    // Both the reviewer role family and an implementation-shaped ID must obey
    // the discovered read-only contract. These are not host invocations.
    fs.writeFileSync(path.join(runtime.home, ".codex/agents", `${id}.toml`),
      `name = "${id}"\ndescription = "Read-only Python code review; report findings, no implementation."\ndeveloper_instructions = "Do not edit files. Discovery fixture only."\n`);
    assertOwnerGap(pythonRepair);
  }
});

test("owner refusal keeps the denied action and object without excluding a frontend status display", (t) => {
  const runtime = routingFixture(t);
  fs.writeFileSync(path.join(runtime.home, ".codex/agents/frontend.toml"),
    'name = "frontend"\ndescription = "Implement React and Vue frontend applications."\ndeveloper_instructions = "Preserve the project stack. Refuse backend schema changes."\n');
  const run = (task) => {
    const result = runtime.run(["scripts/select-execution-route.mjs", "--task", task, "--runtime", "codex", "--os", "windows", "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  assert.equal(run("Fix frontend code in src/Editor.vue to show backend availability.").recommendedRoute?.owner, "frontend");
  assert.equal(run("Fix frontend code in src/Editor.vue to show backend availability without backend schema changes.").recommendedRoute?.owner, "frontend",
    "a denied change stated as a constraint is not a requested mutation");
  for (const id of ["worker", "backend"]) fs.rmSync(path.join(runtime.home, ".codex/agents", `${id}.toml`));
  const refused = run("Fix frontend code in src/Editor.vue and change backend schema in server/schema.sql.");
  assert.equal(refused.recommendedRoute, null, "a real backend-schema mutation cannot use this frontend identity or an unqualified fallback");
  assert.equal(refused.capabilityGapPacket?.returnToStage, "Thinking");
  const execution = refused.rankedRoutes.find((route) => route.id.startsWith("execution-capability-discovery:"));
  assert.equal(execution.owner, null);
  assert.ok(execution.blockedReasons.includes("execution owner missing"));
});

test("qualified specialists outside the preference lists remain discoverable within their domain", (t) => {
  const runtime = routingFixture(t);
  for (const id of ["worker", "backend", "frontend"]) fs.rmSync(path.join(runtime.home, ".codex/agents", `${id}.toml`));
  for (const [id, description] of [
    ["rust-pro", "Implement and repair Rust backend applications."],
    ["vue-pro", "Implement and repair Vue frontend applications."],
  ]) fs.writeFileSync(path.join(runtime.home, ".codex/agents", `${id}.toml`),
    `name = "${id}"\ndescription = "${description}"\ndeveloper_instructions = "Implement the authorized scope and run focused tests. Discovery fixture only."\n`);
  const reactRepair = "修复 React 前端页面的提交状态，保留当前界面交互。";
  const backendDescription = "Implement backend APIs and database services.";
  for (const [task, expectedOwner, description, instructions] of [
    ["修复 Rust 后端 API 代码中的分页错误。", "rust-pro"],
    ["修复 Vue 前端页面代码中的提交状态。", "vue-pro"],
    [reactRepair, null],
    [reactRepair, null, backendDescription, "Own backend implementation. Do not implement frontend UI. Discovery fixture only."],
    [reactRepair, "backend", backendDescription, "Own backend implementation. Implement frontend UI. Discovery fixture only."],
    [reactRepair, null, "Implement backend APIs and frontend UI.", "Implement frontend UI. Do not implement frontend UI. Discovery fixture only."],
    [reactRepair, null, `${backendDescription} Do not implement frontend UI.`, "Own backend implementation. Discovery fixture only."],
    [reactRepair, null, backendDescription, "Own backend implementation. 禁止实现前端界面。Discovery fixture only."],
  ]) {
    if (description) fs.writeFileSync(path.join(runtime.home, ".codex/agents/backend.toml"),
      `name = "backend"\ndescription = "${description}"\ndeveloper_instructions = "${instructions}"\n`);
    const result = runtime.run(["scripts/select-execution-route.mjs", "--task", task, "--runtime", "codex", "--os", "windows", "--json"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const route = JSON.parse(result.stdout);
    assert.equal(route.recommendedRoute?.owner ?? null, expectedOwner, task);
    if (expectedOwner === null) {
      assert.equal(route.recommendedRoute, null);
      assert.equal(route.capabilityGapPacket?.returnToStage, "Thinking");
      const execution = route.rankedRoutes.find((entry) => entry.id.startsWith("execution-capability-discovery:"));
      assert.equal(execution.owner, null);
      assert.ok(execution.blockedReasons.includes("execution owner missing"));
    }
  }
});

test("strategy questions and text requests recall candidates; a current host assessment selects the method", async (t) => {
  const { root, options } = fixture(t);
  const owner = (await discoverDependencyAgentContracts(options)).agents.find(agent => agent.id === "kim-service:headline-cover-optimizer");
  const run = (task, assessed = false) => {
    const result = runtimeFixture.run(["scripts/select-execution-route.mjs", "--task", task, "--runtime", "codex", "--os", "windows", "--json", ...(assessed ? assessmentArgs(task, owner) : [])], {
      encoding: "utf8", timeout: 90_000, env: { ...runtimeFixture.env, META_KIM_KIM_SERVICE_ROOT: root },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const decision = run("内容营销中，标题文案和封面设计怎样提升转化，帮我判断怎么改");
  assert.equal(decision.taskShape, "strategy_product_decision");
  assert.equal(decision.ownerDiscoveryPacket.dependencyAgentDiscovery.match.candidates[0]?.id, "kim-service:headline-cover-optimizer");
  assert.notEqual(decision.recommendedRoute?.owner, "kim-service:headline-cover-optimizer");
  assert.ok(decision.recommendedRoute?.decisionExperiencePlan);

  for (const task of [
    "帮我判断是否要改写标题",
    "帮我判断要不要直接改写标题",
    "请给出标题封面优化方案",
    "How should we rewrite headlines to improve conversion?",
  ]) {
    const route = run(task);
    assert.notEqual(route.recommendedRoute?.owner, "kim-service:headline-cover-optimizer", task);
  }

  for (const task of [
    "内容营销要提高转化，请直接生成3个标题并改写封面文案",
    "内容营销提高转化，帮我写3个标题",
    "内容营销要提高转化，帮我直接写3个标题",
    "内容营销要提高转化，请帮我直接写3个标题",
    "Please write three headlines and cover copy to improve content marketing conversion.",
    "Please write three headlines to improve conversion.",
  ]) {
    const recall = run(task);
    assert.equal(recall.ownerDiscoveryPacket.dependencyAgentDiscovery.match.selected, null);
    assert.ok(recall.ownerDiscoveryPacket.dependencyAgentDiscovery.match.candidates.some(candidate => candidate.id === owner.id));
    const route = run(task, true);
    assert.equal(route.taskShape, "strategy_product_decision", task);
    const match = route.ownerDiscoveryPacket.dependencyAgentDiscovery.match;
    assert.equal(route.recommendedRoute?.owner, "kim-service:headline-cover-optimizer", JSON.stringify({
      task, taskShape: route.taskShape, reason: match.reason, selected: match.selected?.id,
      candidates: match.candidates.map(({ id, score }) => ({ id, score })),
      recommendedId: route.recommendedRoute?.id, recommendedOwner: route.recommendedRoute?.owner,
    }));
  }

  const mixedBuild = run("内容营销要提高转化，请直接生成3个标题，并开发一个带数据库的发布网站");
  const mixedMatch = mixedBuild.ownerDiscoveryPacket.dependencyAgentDiscovery.match;
  assert.ok(mixedMatch.candidates.some(({ id }) => id === "kim-service:headline-cover-optimizer"));
  assert.notEqual(mixedBuild.recommendedRoute?.owner, "kim-service:headline-cover-optimizer");
  assert.ok(/product|build|web|website|implementation|engineering|产品|网站|工程|构建/iu.test(JSON.stringify(mixedBuild.recommendedRoute)));
});

test("host-assessed Chinese resume requests keep the source owner and read-only boundary", async (t) => {
  const { root, options } = fixture(t);
  const owner = (await discoverDependencyAgentContracts(options)).agents.find(agent => agent.id === "kim-service:resume-editor");
  for (const task of [
    "Run meta-theory. 只读审阅 ResumeFacts.md，帮我把简历改得更清楚，匹配客户支持岗位。只返回文字建议，不修改文件、不伪造经历，不代投简历。",
    "Run meta-theory. 只读审阅 ResumeFacts.md 中的简历真实经历，列出与客户支持岗位要求相符的已证实事实及证据缺口；只返回文字，不写文件、不代投简历。",
  ]) await t.test(task, () => {
    const result = runtimeFixture.run(["scripts/select-execution-route.mjs", "--task", task, "--runtime", "codex", "--os", "windows", "--json", ...assessmentArgs(task, owner)], {
      encoding: "utf8", timeout: 90_000, env: { ...runtimeFixture.env, META_KIM_KIM_SERVICE_ROOT: root },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const route = JSON.parse(result.stdout);
    assert.equal(route.recommendedRoute?.owner, "kim-service:resume-editor");
    assert.equal(route.subjectiveUiCapabilityAmplification, null);
    assert.equal(route.routeExecutionGate.canHandoffToHost, true);
    assert.equal(route.workerTaskPacketDrafts.length, 1);
    const packet = route.workerTaskPacketDrafts[0];
    assert.deepEqual(packet.scopeFiles, ["ResumeFacts.md"]);
    assert.equal(packet.safetyEvidence.status, "proven");
    assert.equal(packet.mutationPolicy, "read_only");
    assert.equal(packet.externalWritePolicy, "forbidden");
    assert.doesNotMatch(JSON.stringify(route.decisionCard), /视觉升级|重做页面体验/u);
  });
});

test("Chinese read-only wording never erases a later requested write or submission", async (t) => {
  const { root } = fixture(t);
  for (const [task, expectedMutation, expectedExternal] of [
    ["Run meta-theory. 只读审阅 ResumeFacts.md 中的简历，不修改文件，随后修改 ResumeFacts.md", "scoped_local_writes_only", "forbidden"],
    ["Run meta-theory. 只读审阅 ResumeFacts.md 中的简历，不写文件，代投简历", "unproven", "requested_not_parallel_safe"],
  ]) await t.test(task, () => {
    const result = runtimeFixture.run(["scripts/select-execution-route.mjs", "--task", task, "--runtime", "codex", "--os", "windows", "--json"], {
      encoding: "utf8", timeout: 90_000, env: { ...runtimeFixture.env, META_KIM_KIM_SERVICE_ROOT: root },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const route = JSON.parse(result.stdout);
    assert.ok(route.workerTaskPacketDrafts.some((packet) => packet.mutationPolicy === expectedMutation),
      "The actual write/submission must remain visible even if decomposed into another worker");
    assert.ok(route.workerTaskPacketDrafts.some((packet) => packet.externalWritePolicy === expectedExternal));
  });
});

test("a professional review demand preserves the current action and subjective page design boundary", (t) => {
  const { root } = fixture(t, { professionalReview: true });
  const routeFor = (task, actionTask) => {
    const result = runtimeFixture.run(["scripts/select-execution-route.mjs", "--task", task, "--action-task", actionTask,
      "--method-work-kind", "support", "--method-capability-id", "product-architect-deliver", "--runtime", "codex", "--os", "windows", "--json"], {
      timeout: 90_000, env: { ...runtimeFixture.env, META_KIM_KIM_SERVICE_ROOT: root },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const taskA = "Run meta-theory. Use the discovered product-architect professional method to review the captured current Digital visual creation workspace PRD candidate and its deployment, user journey and asset-reuse dependencies. Then independently review that complete professional result in a fresh read-only process using the same product-architect contract. Preserve development pause; do not implement business changes.";
  const action = "Use product-architect to assess the actual current candidate product architecture, complete user flow, online target and asset-reuse prerequisites from the captured views. Return the source product output object with concrete findings and limits; a partial assessment can be handed to independent review without inventing missing facts.\ndocs/PRD.md";
  const reviewed = routeFor(taskA, action);
  assert.equal(reviewed.recommendedRoute?.owner, "kim-service:product-architect");
  assert.equal(reviewed.recommendedRoute.selectedCapabilityProviders.agent.source, "dependency_agent_contract");
  assert.equal(reviewed.recommendedRoute.ownerContract.id, "product-architect-deliver");
  assert.equal(reviewed.subjectiveUiCapabilityAmplification, null);
  assert.equal(reviewed.routeExecutionGate.canHandoffToHost, true);
  assert.equal(reviewed.workerTaskPacketDrafts[0].safetyEvidence.status, "proven");
  assert.equal(reviewed.workerTaskPacketDrafts[0].mutationPolicy, "read_only");
  const mixedActions = [
    "Then implement src/workspace.ts and deploy it.",
    "Then generate a video.",
    "do not wait—deploy now",
    "不仅读还部署",
  ];
  const mixedResults = mixedActions.map((additionalAction) => {
    const route = routeFor(taskA, `${action}\n${additionalAction}`);
    return { additionalAction, routeId: route.recommendedRoute?.id,
      canHandoffToHost: route.routeExecutionGate.canHandoffToHost,
      choicePolicy: route.routeExecutionGate.entryChoiceDecision.choicePolicy };
  });
  assert.ok(mixedResults.every(result => result.canHandoffToHost === false));
  assert.ok(mixedResults.every(result => result.routeId !== reviewed.recommendedRoute.id),
    "An explicit source method cannot swallow additional implementation, generation or deployment actions");
  const task = "帮我把简历改得更清楚，这个页面不好看，帮我弄高级一点";
  const route = routeFor(task, task);
  // The explicit --method-capability-id may retain a source-bound candidate.
  // Candidate selection must not replace the actual request or grant handoff.
  assert.equal(route.dependencyMethodHandoff.taskHash, createHash("sha256").update(task).digest("hex"));
  assert.equal(route.routeExecutionGate.canHandoffToHost, false);
});

test("capability discovery complaints are not claimed by a tutor through generic question words", (t) => {
  const { root } = fixture(t);
  const result = runtimeFixture.run(["scripts/select-execution-route.mjs", "--task", "Critical Thinking Fetch Deep Thinking Review 为什么 Codex 一直创建 agent 而不是找全局 agent", "--runtime", "codex", "--os", "windows", "--json"], {
    encoding: "utf8", timeout: 90_000,
    env: { ...runtimeFixture.env, META_KIM_KIM_SERVICE_ROOT: root },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const route = JSON.parse(result.stdout);
  assert.equal(route.recommendedRoute?.id, "execution-capability-discovery:codex:windows");
  assert.notEqual(route.recommendedRoute?.selectedCapabilityProviders?.agent?.source, "dependency_agent_contract");
  assert.equal(route.ownerDiscoveryPacket.dependencyAgentDiscovery.match.selected, null);
});

test("professional contracts cannot replace explicit governance or technical script workflows", async (t) => {
  const { root } = fixture(t);
  for (const task of [
    "帮我把商品页文案的模糊目标整理成 Goal Prompt 和 Loop Prompt，先不要执行",
    "需要一个稳定的脚本整理 release summary JSON，不需要新长期 agent。",
    "请在当前项目新建 agent governed-release-auditor，负责审查发布配置并生成检查清单。",
    "请在当前项目新建 agent resume-editor，负责整理简历并拒绝执行写操作。",
    "为什么一直创建简历 agent，而不是复用已有的",
  ]) {
    await t.test(task, () => {
      const result = runtimeFixture.run(["scripts/select-execution-route.mjs", "--task", task, "--runtime", "codex", "--os", "windows", "--json"], {
        encoding: "utf8", timeout: 90_000,
        env: { ...runtimeFixture.env, META_KIM_KIM_SERVICE_ROOT: root },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const route = JSON.parse(result.stdout);
      assert.equal(route.ownerDiscoveryPacket.dependencyAgentDiscovery.match.selected, null);
      assert.notEqual(route.recommendedRoute?.selectedCapabilityProviders?.agent?.source, "dependency_agent_contract");
      if (route.taskShape === "goal_contract") assert.equal(route.recommendedRoute?.weapon, "goalpro");
    });
  }
});
