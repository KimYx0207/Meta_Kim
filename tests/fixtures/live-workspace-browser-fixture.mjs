/** Deterministic acceptance data, never evidence of a model or native host run. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInitialState, activateSpineState } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { joinProjectRegistry } from "../../scripts/project-registry.mjs";
import { startLiveControlRoom } from "../../src/infrastructure/live/live-control-room-server.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const projectRoot = path.resolve(option("--project-root"));
const registryRoot = path.resolve(option("--registry-root"));
const action = option("--action");
const metadataPath = path.join(projectRoot, ".meta-kim/work/browser-fixture.json");
const inputPath = path.join(projectRoot, ".meta-kim/work/design-input.json");
const digest = value => createHash("sha256").update(value).digest("hex");
const execute = (fixture, args) => {
  const result = spawnSync(process.execPath, [path.join(repo, "scripts/live-workspace-host.mjs"),
    "--project-root", projectRoot, "--profile", "default", "--run-id", fixture.runId,
    "--conversation-id", fixture.conversationId, ...args], { cwd: repo, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

if (action === "init") {
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
  await mkdir(path.join(projectRoot, ".meta-kim/work"), { recursive: true });
  await mkdir(path.join(projectRoot, "outputs"), { recursive: true });
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ name: "live-workspace-acceptance-fixture", private: true }));
  const conversationId = "01900000-0000-7000-8000-000000000092";
  const state = createInitialState({ activationMode: "hook_observed", driverMode: "hook_observed", hookGateMode: "advisory",
    sourceConversation: { runtime: "codex", conversationId, matchBasis: "transcript_file_verified" } });
  state.recordOrigin = "acceptance_fixture";
  state.currentStage = "thinking";
  state.stages.critical.status = "completed";
  state.stages.fetch.status = "completed";
  state.stages.thinking.status = "in_progress";
  state.publicSummary = { title: "产品协作工作台 · 验收样例", task: "先审阅系统模块大纲，再逐项完成详细设计。" };
  await activateSpineState(projectRoot, state);
  const moduleDefinitions = [
    { id: "alpha", title: "资料收集", purpose: "保留输入原文、来源与版本，支持完整回查。" },
    { id: "beta", title: "需求拆分", purpose: "将目标拆成可审阅、可修订的模块。", dependsOn: ["alpha"] },
    { id: "gamma", title: "交付跟踪", purpose: "展示实际进度、文件证据与待处理问题。", dependsOn: ["beta"] },
    { id: "delta", title: "复盘沉淀", purpose: "记录采用版本与原因，复用已验证的方法。", dependsOn: ["gamma"] },
  ];
  const outline = [
    "# 产品协作工作台：系统模块大纲", "",
    "> 确定性验收样例。页面读取真实本地记录，本样例没有调用模型。", "",
    "## 目标与使用者", "让负责人从同一个工作区查看目标、模块、交付和需要判断的事项。每次采纳都绑定当前文件版本。", "",
    "## 模块边界", ...moduleDefinitions.map(item => `- ${item.title}：${item.purpose}`), "",
    "## 交互与反馈", "先展示系统全貌，再进入单个模块。修改意见保留原文；版本变化时，旧的采纳不会自动沿用。", "",
    "## 数据与配置", "完整材料留在项目中。页面先读取索引，再按需加载内容；模型和运行时由宿主配置。", "",
    "## 验收标准", "每个阶段可查看；模块可单独审阅；接续有工作单和文件证据；未运行的步骤明确显示等待状态。", "",
    ...Array.from({ length: 150 }, (_, index) => `### 需求条目 ${index + 1}\n资料原文与摘要分别保存。操作失败时保留已输入的修改意见，并提供明确的重试入口。来源和版本必须可核对，中文与 emoji 🧭 不应丢失。\n`),
    "## 长材料验收末尾", "FINAL_MATERIAL_PAGE_REACHED · 原文完整保留。", "",
  ].join("\n");
  await writeFile(path.join(projectRoot, "outputs/outline.md"), outline);
  const input = { schemaVersion: 1, design: { mode: "exploration", userJourneys: [], interfaces: [], sharedState: [], taskSlices: [], settledDecisionRefs: [],
    softwareDesign: { schemaVersion: 1, architecture: { id: "collaboration-workspace", title: "产品协作工作台", revision: 1,
      summary: "从资料到交付，在一个工作区持续推进。", decisionRefs: [], technologyChoices: [], constraints: [],
      moduleIds: moduleDefinitions.map(item => item.id) }, modules: moduleDefinitions } },
    materialRefs: { outline: "outputs/outline.md", modules: {} } };
  await writeFile(inputPath, JSON.stringify(input, null, 2));
  const fixture = { projectRoot, runId: state.runId, conversationId, recordOrigin: "acceptance_fixture",
    modelCalled: false, nativeInvocationVerified: false, completionVerified: false, outlineSha256: digest(outline), outlineBytes: Buffer.byteLength(outline) };
  execute(fixture, ["--publish-design", "--input", inputPath, "--expected-revision", "0"]);
  const registration = await joinProjectRegistry({ homeDir: registryRoot, repoPath: projectRoot });
  fixture.projectId = registration.projectRef;
  await writeFile(metadataPath, JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify(fixture));
} else if (action === "serve") {
  const live = await startLiveControlRoom({ globalHub: true, homeDir: registryRoot, port: 0 });
  console.log(JSON.stringify({ url: live.url, globalHub: true, fixture: true }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, async () => { await live.close(); process.exit(0); });
} else {
  const fixture = JSON.parse(await readFile(metadataPath, "utf8"));
  const inspect = () => execute(fixture, ["--inspect"]);
  if (action === "inspect") console.log(JSON.stringify(inspect()));
  else if (action === "advance") {
    const before = inspect();
    assert.equal(before.nextAction.kind, "design_module");
    assert.equal(before.nextAction.moduleId, "alpha");
    const claim = execute(fixture, ["--claim-request", "--command-id", before.nextAction.commandId, "--expected-revision", String(before.revision)]);
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    const text = "# 资料收集：详细设计\n\n## 使用场景\n负责人导入访谈记录、需求描述或已有方案，并保留完整原文。\n\n## 页面与状态\n待导入、处理中、可审阅和需要补充分别展示。输入失败时不清空内容。\n\n## 数据边界\n原文独立保存，页面按需读取。摘要只是索引，不替代原始材料。\n\n## 验收证据\n本文件由确定性验收脚本写出，没有调用模型。\n";
    await writeFile(path.join(projectRoot, "outputs/alpha.md"), text);
    Object.assign(input.design.softwareDesign.modules[0], { implementationNotes: "输入、原文存储和只读展示分层。",
      businessRules: ["先保存完整原文，再生成处理结果。", "错误保留用户输入并展示原因。"],
      states: [{ name: "pending", behavior: "等待资料" }, { name: "ready", behavior: "原文已保存" }] });
    input.materialRefs.modules.alpha = "outputs/alpha.md";
    await writeFile(inputPath, JSON.stringify(input, null, 2));
    execute(fixture, ["--publish-design", "--input", inputPath, "--expected-revision", String(inspect().revision)]);
    const receipt = path.join(projectRoot, ".meta-kim/work/receipt.json");
    await writeFile(receipt, JSON.stringify({ outcome: "produced", summary: "Deterministic fixture file; no model invocation.",
      evidenceRefs: [{ ref: "outputs/alpha.md", sha256: digest(text) }] }));
    const result = execute(fixture, ["--complete-request", "--command-id", claim.commandId, "--claim-token", claim.claimToken,
      "--input", receipt, "--expected-revision", String(inspect().revision)]);
    assert.equal(result.status, "host_reported");
    assert.equal(result.completionVerified, false);
    console.log(JSON.stringify(result));
  } else throw new Error("Unsupported fixture action");
}
