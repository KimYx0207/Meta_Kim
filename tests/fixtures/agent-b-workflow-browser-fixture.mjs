#!/usr/bin/env node

/**
 * Browser-only B-path fixture: real Live HTTP/DOM, deterministic fake provider.
 * Every artifact from this process is acceptance_fixture, never native proof.
 * Native host, production Run, and real side effects are deliberately absent.
 */
import path from "node:path";
import { realpathSync } from "node:fs";
import { createAgentWorkflowService } from "../../src/application/agent/agent-workflow-service.mjs";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";

const rootArg = process.argv.indexOf("--project-root");
if (rootArg < 0 || !process.argv[rootArg + 1] || !path.isAbsolute(process.argv[rootArg + 1])) {
  process.stderr.write("Use --project-root ABSOLUTE_DIR\n");
  process.exit(2);
}
const projectRoot = realpathSync(process.argv[rootArg + 1]);
const strategies = {
  schemaVersion: "meta-kim-agent-strategy-options-v1",
  provenance: "native_plan_unverified",
  evidenceVerified: false,
  summary: "测试资料：跨境电商内部分析系统的三种路线。所有事实与方案均为本地测试桩提供，未经外部核验。",
  strategies: [
    { id: "A", title: "单平台小范围试点", approach: "先接入一个平台，验证数据质量和经营口径。",
      tradeoffs: "交付较快，覆盖面有限。", evidenceSummary: "仅合成测试数据，无真实外部来源。", risks: "跨平台比较能力滞后。" },
    { id: "B", title: "按模块分阶段交付", approach: "先数据治理与检索，再建经营决策和展示。",
      tradeoffs: "实施更稳，但阶段之间需要复核。", evidenceSummary: "仅合成测试数据，无真实外部来源。", risks: "模块接口变动可能带来返工。" },
    { id: "C", title: "一次性统一平台", approach: "数据、权限、检索和经营分析同时建设。",
      tradeoffs: "目标统一，成本和回滚风险更高。", evidenceSummary: "仅合成测试数据，无真实外部来源。", risks: "并行资源冲突与范围失控。" },
  ],
  recommendedStrategyId: "B",
  openQuestions: ["生产数据是否隔离？", "是否需要先验证检索命中率？"],
};

const designDraft = {
  system: {
    title: "跨境电商经营知识工作台（模拟草稿）",
    goal: "对商品、订单、合同和广告材料形成可复核的经营建议。",
    architecture: "分离数据接入、经营分析与展示，全部测试数据按项目隔离。",
    techStack: "Node.js、SQLite（试点）与浏览器可视化。",
    acceptance: ["能在本地打开结果", "不读取受限材料", "所有关键经营指标可对账"],
  },
  modules: [
    {
      id: "data-intake", title: "数据接入与质量检查", objective: "导入合成订单、商品和供应商数据并检查重复、缺失。",
      inputContract: ["项目绑定的输入数据及指标口径"], outputContract: ["可复核的数据质量报告"],
      boundaries: ["不接触生产数据库", "不读取其它项目文件"],
      acceptance: ["重复订单被标记", "缺失项可导出"], dependencies: [],
    },
    {
      id: "business-analytics", title: "检索与经营分析", objective: "检索已核实资料并计算经营建议。",
      inputContract: ["质量合格的数据和已审阅资料"], outputContract: ["可追溯的建议和引用"],
      boundaries: ["测试阶段不对外发布"],
      acceptance: ["建议对应可靠依据", "输入变更后能重新校验结果"], dependencies: ["data-intake"],
    },
  ],
};

const receipts = new Map();
const designReceipts = new Map();
const fakeReadOnlyIntake = {
  async getHosts() {
    return { schemaVersion: "meta-kim-agent-hosts-v1", executionAllowed: true,
      recommendedHostId: "claude", hosts: [
        { id: "claude", label: "Claude Code（本地模拟验收）", available: true, launchSupported: true,
          status: "detected", version: "fixture-only" },
        { id: "codex", label: "Codex（禁止个人 Token）", available: false,
          launchSupported: false, status: "detected_but_not_allowed" },
      ] };
  },
  async start({ idempotencyKey }) {
    if (!receipts.has(idempotencyKey)) receipts.set(idempotencyKey, {
      status: "completed", resultPreview: JSON.stringify(strategies), selectedHostId: "claude",
      capabilityState: { status: "fixture_only", recordOrigin: "acceptance_fixture" },
    });
    return { status: "accepted", selectedHostId: "claude", requestId: `fixture-${idempotencyKey}`,
      executionAuthorized: false, runId: null };
  },
  inspect({ idempotencyKey }) { return receipts.get(idempotencyKey) ?? { status: "unknown" }; },
  async startDesignDraft({ idempotencyKey }) {
    if (!designReceipts.has(idempotencyKey)) designReceipts.set(idempotencyKey, {
      status: "completed", design: designDraft, selectedHostId: "claude",
      capabilityState: { status: "fixture_only", recordOrigin: "acceptance_fixture" },
    });
    return { status: "accepted", selectedHostId: "claude", executionAuthorized: false, runId: null };
  },
  inspectDesignDraft({ idempotencyKey }) {
    return designReceipts.get(idempotencyKey) ?? { status: "unknown" };
  },
  close() {},
};

const service = createAgentWorkflowService({ projectRoot, agentStartService: fakeReadOnlyIntake });
const server = createLiveControlRoomServer({ projectRoot, globalHub: false, port: 0,
  workspaceEnabled: true, enableAgentStart: true, enableControl: false,
  service: { getSnapshot: async () => null }, agentStartService: service });
const { url } = await server.start();
process.stdout.write(`${JSON.stringify({ url, recordOrigin: "acceptance_fixture",
  modelCalled: false, nativeInvocationVerified: false, completionVerified: false })}\n`);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => { void server.close().then(() => process.exit(0)); });
}
