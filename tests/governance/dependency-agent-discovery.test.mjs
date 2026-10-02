import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  discoverDependencyAgentContracts,
  matchDependencyAgentContracts,
} from "../../scripts/dependency-agent-discovery.mjs";

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

function fixture(t, { tools = "Read" } = {}) {
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
    ["headline-cover-optimizer", "标题封面优化：校准封面文字与正文承诺", ["正文已有，标题不知道怎么写", "封面放什么文字", "起一个小红书标题"]],
    ["script-writer", "脚本文案：按已有选题写正文", ["根据选题和素材写小红书正文", "口播怎么写", "写脚本文案"]],
    ["interview-coach", "面试练习：按岗位提供真实经历反馈", ["陪我练面试", "我的经历怎么回答", "目标岗位怎么自我介绍"]],
    ["workplace-writer", "周报邮件整理：把实际工作进度写清楚", ["写一份工作周报", "邮件怎么说清进度", "汇报已完成和待确认的事"]],
    ["pricing-cost-analyst", "报价与成本测算：比较价格和现金投入", ["核算报价", "计算单笔成本", "几个价格怎么选"]],
    ["concept-tutor", "概念讲解与答疑：解释学习者卡住的那一步", ["这道题为什么这样算", "这个概念我一直听不懂", "不要只给答案帮我讲明白"]],
  ]) {
    const capability = {
      id: `${id}-assist`, summary, useWhen: triggers,
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

test("plain Chinese requests match contract evidence while vague or unrelated requests do not select an owner", async (t) => {
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
  ]) assert.equal(matchDependencyAgentContracts(request, agents).selected?.id, expected, request);
  assert.equal(matchDependencyAgentContracts("帮我处理一些事情", agents).selected, null);
  assert.equal(matchDependencyAgentContracts("修复 Node Hook timeout 的回归测试", agents).selected, null);
  assert.equal(matchDependencyAgentContracts("Critical Thinking Fetch Deep Thinking Review 为什么 Codex 一直创建 agent 而不是找全局 agent", agents).selected, null);
  assert.equal(matchDependencyAgentContracts("为什么一直没有反应", agents).selected, null);
  assert.equal(matchDependencyAgentContracts("先不要执行", agents).selected, null);
  assert.equal(matchDependencyAgentContracts("帮我修改这个项目的清单", agents).selected, null);
  const sameBoundary = agents.filter((agent) => agent.componentId === "resume-editor");
  assert.equal(matchDependencyAgentContracts("按真实经历写简历", [...sameBoundary, { ...sameBoundary[0], id: "other:resume-editor" }]).selected, null);
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

test("the existing route selector binds the discovered role as a contract, without claiming invocation", (t) => {
  const { root } = fixture(t);
  const result = spawnSync(process.execPath, ["scripts/select-execution-route.mjs", "--task", "请把我的客服经历改成运营助理岗位简历", "--runtime", "codex", "--os", "windows", "--json"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 90_000,
    env: { ...process.env, META_KIM_KIM_SERVICE_ROOT: root },
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
  const result = spawnSync(process.execPath, ["scripts/select-execution-route.mjs", "--task", "修复商品详情页的 JavaScript 代码和 API 报错", "--runtime", "codex", "--os", "windows", "--json"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 90_000,
    env: { ...process.env, META_KIM_KIM_SERVICE_ROOT: root },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const route = JSON.parse(result.stdout);
  assert.notEqual(route.recommendedRoute?.owner, "kim-service:product-listing-writer");
  assert.equal(route.ownerDiscoveryPacket.dependencyAgentDiscovery.match.selected, null);
});

test("capability discovery complaints are not claimed by a tutor through generic question words", (t) => {
  const { root } = fixture(t);
  const result = spawnSync(process.execPath, ["scripts/select-execution-route.mjs", "--task", "Critical Thinking Fetch Deep Thinking Review 为什么 Codex 一直创建 agent 而不是找全局 agent", "--runtime", "codex", "--os", "windows", "--json"], {
    cwd: process.cwd(), encoding: "utf8", timeout: 90_000,
    env: { ...process.env, META_KIM_KIM_SERVICE_ROOT: root },
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
      const result = spawnSync(process.execPath, ["scripts/select-execution-route.mjs", "--task", task, "--runtime", "codex", "--os", "windows", "--json"], {
        cwd: process.cwd(), encoding: "utf8", timeout: 90_000,
        env: { ...process.env, META_KIM_KIM_SERVICE_ROOT: root },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const route = JSON.parse(result.stdout);
      assert.equal(route.ownerDiscoveryPacket.dependencyAgentDiscovery.match.selected, null);
      assert.notEqual(route.recommendedRoute?.selectedCapabilityProviders?.agent?.source, "dependency_agent_contract");
      if (route.taskShape === "goal_contract") assert.equal(route.recommendedRoute?.weapon, "goalpro");
    });
  }
});
