import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAgentAcceptanceService } from "../../src/application/agent/agent-acceptance-service.mjs";
import { createAgentExecutionBridge } from "../../src/application/agent/agent-execution-bridge.mjs";
import { createAgentNativeExecutionService } from "../../src/application/agent/agent-native-execution-service.mjs";
import { createAgentWorkflowService } from "../../src/application/agent/agent-workflow-service.mjs";
import { createLiveControlRoomServer } from "../../src/infrastructure/live/live-control-room-server.mjs";

function createStoreRepo(name, initialConfig) {
  const root = mkdtempSync(path.join(os.tmpdir(), `meta-kim-${name}-`));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "config"), { recursive: true });
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, private: true, type: "module" }, null, 2));
  writeFileSync(path.join(root, "config", "store.json"), JSON.stringify(initialConfig, null, 2));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  return root;
}

function sixDigitalEmployeesDesign(withSeasonSafety = false) {
  return {
    system: {
      title: "跨境电商一人公司 · 六数字员工协同运营系统",
      goal: "围绕 Shopify 欧洲独立站转化率提升，打通选品、商品上架、定价库存、投放增长、客服质检与合规风控",
      architecture: "六角色模块化 DAG（调研 -> 上架/定价并行 -> 投放/客服 -> 合规总控），隔离工作区核验后合入店铺主仓",
      techStack: "Node.js ESM, Shopify B2C, JSON 策略配置",
      acceptance: [
        "六个专业角色产物全部通过语法、格式与契约对齐检查",
        "定价库存与投放客服策略不触碰任何外部付款或密钥文件",
      ],
    },
    modules: [
      {
        id: "market-research",
        title: "01 市场与选品分析师",
        objective: "调研欧洲冬季家居品类竞品价格带与痛点差评",
        inputContract: ["config/store.json"],
        outputContract: ["docs/01-market-research.md"],
        boundaries: ["只做调研分析，不改线上商品"],
        acceptance: ["明确高潜 SKU 与目标价格带"],
        dependencies: [],
      },
      {
        id: "catalog-listing",
        title: "02 商品视觉与详情页专家",
        objective: "重构着陆页卖点结构与尺码说明降低退货",
        inputContract: ["docs/01-market-research.md"],
        outputContract: ["docs/02-listing-copy.md"],
        boundaries: ["不夸大材质认证"],
        acceptance: ["包含核心卖点与尺码对照提示"],
        dependencies: ["market-research"],
      },
      {
        id: "pricing-inventory",
        title: "03 动态定价与库存管家",
        objective: withSeasonSafety
          ? "按日销、补货周期与旺季系数动态计算安全库存并校准毛利"
          : "按日销与补货周期计算安全库存",
        inputContract: ["docs/01-market-research.md", "config/store.json"],
        outputContract: ["src/pricing-inventory.mjs", "config/store.json"],
        boundaries: ["不自动触发外部采购打款"],
        acceptance: [
          withSeasonSafety
            ? "导出 evaluateInventoryPlan(dailySales, leadDays, seasonFactor) 且通过语法校验"
            : "导出 evaluateInventoryPlan 函数且通过语法校验",
        ],
        dependencies: ["market-research"],
      },
      {
        id: "campaign-growth",
        title: "04 转化与投放增长专家",
        objective: "仅对库存健康 SKU 编排再营销与捆绑购方案",
        inputContract: ["docs/02-listing-copy.md", "src/pricing-inventory.mjs"],
        outputContract: ["src/campaign-rules.mjs"],
        boundaries: ["不自动消耗真实广告预算"],
        acceptance: ["低库存自动暂停主推规则"],
        dependencies: ["catalog-listing", "pricing-inventory"],
      },
      {
        id: "customer-care",
        title: "05 多语种客服质检专家",
        objective: "配置德法英物流查询与尺码换货标准响应模板",
        inputContract: ["docs/02-listing-copy.md"],
        outputContract: ["config/care-playbooks.json"],
        boundaries: ["超额赔付必须转人工确认"],
        acceptance: ["合法 JSON 且包含人工升级阈值"],
        dependencies: ["catalog-listing"],
      },
      {
        id: "risk-compliance",
        title: "06 欧盟合规与风控审计员",
        objective: "核验欧盟折扣划线价法规与 GDPR 客服留痕边界",
        inputContract: ["src/campaign-rules.mjs", "config/care-playbooks.json"],
        outputContract: ["docs/06-compliance-audit.md"],
        boundaries: ["发现违规直接阻断上线"],
        acceptance: ["覆盖 Omnibus 价格指令与隐私留痕检查"],
        dependencies: ["campaign-growth", "customer-care"],
      },
    ],
  };
}

function writeSixAgentDeliverables(worktreeDir, { corruptJson = false, seasonFactor = null } = {}) {
  mkdirSync(path.join(worktreeDir, "src"), { recursive: true });
  mkdirSync(path.join(worktreeDir, "config"), { recursive: true });
  mkdirSync(path.join(worktreeDir, "docs"), { recursive: true });
  writeFileSync(path.join(worktreeDir, "docs", "01-market-research.md"), "# 选品调研\n欧洲德法市场冬季法兰绒家居服转化缺口明显，主力价格带 45 EUR。\n");
  writeFileSync(path.join(worktreeDir, "docs", "02-listing-copy.md"), "# 着陆页优化\n首屏补充欧盟尺码表与 48h 本土仓发货承诺。\n");
  writeFileSync(
    path.join(worktreeDir, "src", "pricing-inventory.mjs"),
    seasonFactor
      ? `export function evaluateInventoryPlan(dailySales, leadDays = 7, seasonFactor = ${seasonFactor}) {\n  return { safetyStock: Math.ceil(dailySales * leadDays * seasonFactor), lowStockCutoff: 15 };\n}\n`
      : "export function evaluateInventoryPlan(dailySales, leadDays = 7) {\n  return { safetyStock: Math.ceil(dailySales * leadDays), lowStockCutoff: 8 };\n}\n",
  );
  writeFileSync(
    path.join(worktreeDir, "config", "store.json"),
    corruptJson
      ? "{ broken_json: true "
      : JSON.stringify({ currency: "EUR", targetMargin: 0.58, ...(seasonFactor ? { seasonFactor } : {}) }, null, 2),
  );
  writeFileSync(
    path.join(worktreeDir, "src", "campaign-rules.mjs"),
    "export function shouldPromoteSku(stock, lowStockCutoff = 15) {\n  return stock > lowStockCutoff;\n}\n",
  );
  writeFileSync(
    path.join(worktreeDir, "config", "care-playbooks.json"),
    JSON.stringify({ languages: ["de", "fr", "en"], refundHumanGateEur: 50 }, null, 2),
  );
  writeFileSync(
    path.join(worktreeDir, "docs", "06-compliance-audit.md"),
    "# 合规审计\n符合欧盟 Omnibus 30 天最低价展示规则及客服超额人工确认红线。\n",
  );
}

test("E2E Benchmark: One-person cross-border ecommerce with 6 digital employees, fault recovery, self-improvement, and Store 2 reuse", async () => {
  const storeOneRoot = createStoreRepo("eu-store-one", { currency: "EUR", targetMargin: 0.52 });
  const storeTwoRoot = createStoreRepo("eu-store-two", { currency: "EUR", targetMargin: 0.55 });
  const sharedPlaybooksRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-ecom-playbooks-"));

  let serverOne = null;
  let serverOneRestarted = null;

  try {
    const strategyPreview = JSON.stringify({
      schemaVersion: "meta-kim-agent-strategy-options-v1",
      provenance: "native_plan_unverified",
      evidenceVerified: false,
      summary: "一号店当前转化率 1.2%，主要症结在尺码退货顾虑、热销码断货与无效广告消耗。",
      recommendedStrategyId: "A",
      openQuestions: [],
      strategies: [
        {
          id: "A",
          title: "六角色库存-转化协同方案",
          approach: "选品定标 -> 着陆页尺码优化 + 安全库存联动 -> 仅推健康库存款 + 多语客服与欧盟合规守门",
          tradeoffs: "低库存款暂停投放会短期减少曝光，但显著提升 ROAS 与净毛利",
          evidenceSummary: "契合欧洲 Shopify B2C 独立站履约特征",
          risks: "黑五旺季补货周期拉长需动态上调安全库存系数",
        },
        {
          id: "B",
          title: "全站无差别买一送一清仓",
          approach: "全品类五折冲单量",
          tradeoffs: "毛利跌破盈亏线且客服爆仓",
          evidenceSummary: "仅适用于临期清仓",
          risks: "主力码迅速断货引发大量客诉",
        },
      ],
    });

    const mockPlanHost = {
      async getHosts() {
        return {
          recommendedHostId: "claude",
          hosts: [{ id: "claude", label: "Claude Code", available: true, launchSupported: true, version: "2.1.260" }],
        };
      },
      async start() {
        return { status: "accepted", selectedHostId: "claude", capabilityState: { status: "verified_read_only" } };
      },
      async inspect() {
        return {
          status: "completed",
          selectedHostId: "claude",
          capabilityState: { status: "verified_read_only" },
          resultPreview: strategyPreview,
        };
      },
      async close() {},
    };

    let sessionId = "1122aabb";
    let sessionState = "working";
    let activeWorktree = path.join(storeOneRoot, ".claude-worktrees", "ecom-round-1");
    let networkOutageOnInspect = false;
    let totalNativeLaunches = 0;
    let humanInterventions = 0;

    const makeStoreOneStack = () => {
      const workflowService = createAgentWorkflowService({
        projectRoot: storeOneRoot,
        profile: "default",
        agentStartService: mockPlanHost,
      });
      const executionBridge = createAgentExecutionBridge({
        projectRoot: storeOneRoot,
        profile: "default",
        agentWorkflowService: workflowService,
      });
      const nativeExecutionService = createAgentNativeExecutionService({
        projectRoot: storeOneRoot,
        profile: "default",
        workflowService,
        executionBridge,
        probe: async () => ({ status: "detected", version: "2.1.260" }),
        launch: async (_bin, args) => {
          if (args[0] === "agents") {
            if (networkOutageOnInspect) {
              return { status: 1, stdout: "", stderr: "transient cli socket timeout" };
            }
            return {
              status: 0,
              stdout: JSON.stringify([
                {
                  id: sessionId,
                  kind: "background",
                  cwd: activeWorktree,
                  name: "meta-" + "ecom_store1_goal_0001".slice(0, 20),
                  startedAt: Date.now(),
                  state: sessionState,
                },
              ]),
            };
          }
          totalNativeLaunches += 1;
          mkdirSync(activeWorktree, { recursive: true });
          writeFileSync(path.join(activeWorktree, "package.json"), readFileSync(path.join(storeOneRoot, "package.json")));
          return { status: 0, stdout: `backgrounded · ${sessionId}\n` };
        },
      });
      const acceptanceService = createAgentAcceptanceService({
        projectRoot: storeOneRoot,
        profile: "default",
        workflowService,
        nativeExecutionService,
        sharedPlaybooksRoot,
      });
      return { workflowService, nativeExecutionService, acceptanceService };
    };

    // Boot Store 1 Live Agent Server
    const stack1 = makeStoreOneStack();
    serverOne = createLiveControlRoomServer({
      projectRoot: storeOneRoot,
      port: 0,
      globalHub: false,
      workspaceEnabled: true,
      enableAgentStart: true,
      agentWatchIntervalMs: 0,
      agentStartService: stack1.workflowService,
      agentNativeExecutionService: stack1.nativeExecutionService,
      agentAcceptanceService: stack1.acceptanceService,
      service: { getSnapshot: async () => null },
    });
    const addr1 = await serverOne.start();
    const html1 = await (await fetch(addr1.url)).text();
    const auth1 = JSON.parse(html1.match(/<script type="application\/json" id="live-workspace-config">([^<]+)<\/script>/u)[1]);
    const postJson = async (baseUrl, auth, routePath, body) => {
      const res = await fetch(`${baseUrl}${routePath}`, {
        method: "POST",
        headers: { [auth.controlHeader]: auth.controlToken, "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    const getJson = async (baseUrl, auth, routePath) => {
      const res = await fetch(`${baseUrl}${routePath}`, {
        headers: { [auth.controlHeader]: auth.controlToken },
      });
      assert.equal(res.status, 200);
      return res.json();
    };

    const key = "ecom_store1_goal_0001";

    // Goal Intake
    await postJson(addr1.url, auth1, "/api/agent/start", {
      goal: "一人管理欧洲跨境电商一号店（Shopify B2C），六个数字员工协同提升转化率并稳住库存",
      hostId: "claude",
      idempotencyKey: key,
    });
    const planReceipt = await getJson(addr1.url, auth1, `/api/agent/requests?idempotencyKey=${key}`);
    assert.equal(planReceipt.status, "completed");

    // Human Gate #1 (B1): Choose Strategy A
    humanInterventions += 1;
    await postJson(addr1.url, auth1, "/api/agent/decisions", {
      idempotencyKey: key,
      requestId: planReceipt.requestId,
      planDigest: planReceipt.planDigest,
      decisionKey: "b1_choose_strategy_a_0001",
      action: "adopt",
      selectedStrategy: "A：六角色库存-转化协同方案",
      selectionReason: "兼顾转化率、毛利率与欧盟合规边界",
    });

    // Human Gate #2 (B2): Submit 6-agent architecture & one-step approve_all + seal handoff
    humanInterventions += 1;
    const designInit = await getJson(addr1.url, auth1, `/api/agent/designs?idempotencyKey=${key}`);
    const basis = {
      idempotencyKey: key,
      requestId: designInit.basis.requestId,
      planDigest: designInit.basis.planDigest,
      decisionKey: designInit.basis.decisionKey,
    };
    const submittedDesign = await postJson(addr1.url, auth1, "/api/agent/designs", {
      ...basis,
      action: "submit",
      mutationKey: "mut_ecom_submit_6_roles_01",
      expectedVersion: 0,
      design: sixDigitalEmployeesDesign(false),
    });
    assert.equal(submittedDesign.modules.length, 6);

    const approvedDesign = await postJson(addr1.url, auth1, "/api/agent/designs", {
      ...basis,
      action: "approve_all",
      mutationKey: "mut_ecom_approve_all_6_roles",
      expectedVersion: submittedDesign.version,
    });
    assert.equal(approvedDesign.reviewComplete, true);

    const handoff1 = await postJson(addr1.url, auth1, "/api/agent/handoff", {
      ...basis,
      designVersion: approvedDesign.version,
      designDigest: approvedDesign.designDigest,
      handoffKey: "handoff_ecom_round_0001",
    });
    assert.equal(handoff1.status, "prepared");

    // Human Gate #3 (B3): Authorize isolated draft execution
    humanInterventions += 1;
    const launched1 = await postJson(addr1.url, auth1, "/api/agent/execution", {
      idempotencyKey: key,
      handoffDigest: handoff1.handoffDigest,
      approvalKey: "b3_auth_ecom_round_0001",
      scope: "local_project_draft",
    });
    assert.equal(launched1.nativeSessionId, "1122aabb");
    assert.equal(totalNativeLaunches, 1);

    // Fault Injection #1: Simulate transient CLI outage AND full server/computer restart!
    await serverOne.close();
    serverOne = null;

    const stackAfterRestart = makeStoreOneStack();
    serverOneRestarted = createLiveControlRoomServer({
      projectRoot: storeOneRoot,
      port: 0,
      globalHub: false,
      workspaceEnabled: true,
      enableAgentStart: true,
      agentWatchIntervalMs: 0,
      agentStartService: stackAfterRestart.workflowService,
      agentNativeExecutionService: stackAfterRestart.nativeExecutionService,
      agentAcceptanceService: stackAfterRestart.acceptanceService,
      service: { getSnapshot: async () => null },
    });
    const addr2 = await serverOneRestarted.start();
    const html2 = await (await fetch(addr2.url)).text();
    const auth2 = JSON.parse(html2.match(/<script type="application\/json" id="live-workspace-config">([^<]+)<\/script>/u)[1]);

    // During CLI outage, background watch neither crashes nor double-launches!
    networkOutageOnInspect = true;
    await stackAfterRestart.acceptanceService.reconcileActive();
    assert.equal(totalNativeLaunches, 1, "Must never re-launch during transient CLI observation outage");

    // Fault Injection #2: Corrupted store.json written in worktree -> background watch catches & blocks!
    networkOutageOnInspect = false;
    sessionState = "done";
    writeSixAgentDeliverables(activeWorktree, { corruptJson: true });
    await stackAfterRestart.acceptanceService.reconcileActive();
    const failedCheck = await getJson(addr2.url, auth2, `/api/agent/acceptance?idempotencyKey=${key}`);
    assert.equal(failedCheck.status, "verification_failed");
    assert.equal(failedCheck.verification.passed, false);

    // Worker repairs JSON corruption -> re-verification passes -> reaches awaiting_human_b4!
    writeSixAgentDeliverables(activeWorktree, { corruptJson: false, seasonFactor: null });
    const repairedCheck = await postJson(addr2.url, auth2, "/api/agent/acceptance", {
      idempotencyKey: key,
      action: "verify",
    });
    assert.equal(repairedCheck.status, "awaiting_human_b4");

    // Feedback & Optimization Loop: Data shows peak-season stockouts -> request rework on pricing-inventory!
    const reworked = await postJson(addr2.url, auth2, "/api/agent/acceptance", {
      idempotencyKey: key,
      decisionKey: "b4_rework_season_factor_01",
      handoffDigest: handoff1.handoffDigest,
      artifactsDigest: repairedCheck.artifactsDigest,
      action: "request_rework",
      moduleId: "pricing-inventory",
      feedback: "黑五旺季物流延长，需引入 seasonFactor=1.6 安全库存系数并将低库存停投线提高到 15 件",
    });
    assert.equal(reworked.status, "rework_requested");

    // Only pricing-inventory, campaign-growth, and risk-compliance were invalidated; market-research, catalog-listing, customer-care stay approved!
    const postReworkDesign = await getJson(addr2.url, auth2, `/api/agent/designs?idempotencyKey=${key}`);
    const states = Object.fromEntries(postReworkDesign.modules.map((m) => [m.id, m.approval.state]));
    assert.equal(states["market-research"], "approved");
    assert.equal(states["catalog-listing"], "approved");
    assert.equal(states["customer-care"], "approved");
    assert.notEqual(states["pricing-inventory"], "approved");
    assert.equal(states["campaign-growth"], "invalidated");
    assert.equal(states["risk-compliance"], "invalidated");

    // Revise pricing-inventory, one-step approve_all remaining invalidated nodes, seal handoff v2, run round 2!
    const updatedMod = await postJson(addr2.url, auth2, "/api/agent/designs", {
      ...basis,
      action: "revise_module",
      mutationKey: "mut_ecom_pricing_season_v2",
      expectedVersion: postReworkDesign.version,
      module: sixDigitalEmployeesDesign(true).modules[2],
    });
    const reapprovedAll = await postJson(addr2.url, auth2, "/api/agent/designs", {
      ...basis,
      action: "approve_all",
      mutationKey: "mut_ecom_reapprove_all_v2",
      expectedVersion: updatedMod.version,
    });
    const handoff2 = await postJson(addr2.url, auth2, "/api/agent/handoff", {
      ...basis,
      designVersion: reapprovedAll.version,
      designDigest: reapprovedAll.designDigest,
      handoffKey: "handoff_ecom_round_0002",
    });

    sessionId = "3344ccdd";
    activeWorktree = path.join(storeOneRoot, ".claude-worktrees", "ecom-round-2");
    sessionState = "done";

    await postJson(addr2.url, auth2, "/api/agent/execution", {
      idempotencyKey: key,
      handoffDigest: handoff2.handoffDigest,
      approvalKey: "b3_auth_ecom_round_0002",
      scope: "local_project_draft",
    });
    writeSixAgentDeliverables(activeWorktree, { corruptJson: false, seasonFactor: 1.6 });

    // Background watch automatically verifies round 2 without human polling!
    const watchTick2 = await stackAfterRestart.acceptanceService.reconcileActive();
    assert.equal(watchTick2.readyKeys.includes(key), true);

    const readyB4 = await getJson(addr2.url, auth2, `/api/agent/acceptance?idempotencyKey=${key}`);
    assert.equal(readyB4.status, "awaiting_human_b4");

    // Human Gate #4 (B4): Accept & integrate into Store 1 + sediment Verified Playbook!
    humanInterventions += 1;
    const finalAccepted = await postJson(addr2.url, auth2, "/api/agent/acceptance", {
      idempotencyKey: key,
      decisionKey: "b4_accept_ecom_store1_final",
      handoffDigest: handoff2.handoffDigest,
      artifactsDigest: readyB4.artifactsDigest,
      action: "accept",
      summary: "六数字员工运营产物核验通过，合入一号店并沉淀旺季库存经验卡",
    });
    assert.equal(finalAccepted.status, "accepted_and_integrated");
    assert.equal(existsSync(path.join(storeOneRoot, "src", "pricing-inventory.mjs")), true);
    assert.equal(existsSync(path.join(storeOneRoot, "docs", "06-compliance-audit.md")), true);
    assert.equal(JSON.parse(readFileSync(path.join(storeOneRoot, "config", "store.json"), "utf8")).seasonFactor, 1.6);

    // Criterion 4: Cross-Store Capability Reuse on Store 2 (with applicability verification!)
    const wfStoreTwo = createAgentWorkflowService({
      projectRoot: storeTwoRoot,
      profile: "default",
      agentStartService: mockPlanHost,
    });
    const execStoreTwo = createAgentNativeExecutionService({
      projectRoot: storeTwoRoot,
      profile: "default",
      workflowService: wfStoreTwo,
      executionBridge: createAgentExecutionBridge({
        projectRoot: storeTwoRoot,
        profile: "default",
        agentWorkflowService: wfStoreTwo,
      }),
      probe: async () => ({ status: "detected", version: "2.1.260" }),
      launch: async () => ({ status: 0, stdout: "[]" }),
    });
    const acceptStoreTwo = createAgentAcceptanceService({
      projectRoot: storeTwoRoot,
      profile: "default",
      workflowService: wfStoreTwo,
      nativeExecutionService: execStoreTwo,
      sharedPlaybooksRoot,
    });

    const storeTwoMatches = acceptStoreTwo.matchPlaybooks({
      goal: "启动欧洲二号店（法国与荷兰站 Shopify B2C 零售独立站），复用六角色运营与旺季不断货策略",
      techStack: "Node.js ESM, Shopify B2C",
    });
    assert.equal(storeTwoMatches.length, 1);
    assert.equal(storeTwoMatches[0].applicability, "compatible");
    assert.equal(storeTwoMatches[0].moduleCount, 6);
    assert.ok(storeTwoMatches[0].reworkLessons.some((l) => l.includes("seasonFactor=1.6")));

    // Verify human interventions stayed bounded to essential decision gates!
    assert.equal(humanInterventions, 4, "Routine steps ran autonomously; human only intervened at key gates");

    await wfStoreTwo.close();
  } finally {
    if (serverOne) await serverOne.close();
    if (serverOneRestarted) await serverOneRestarted.close();
    rmSync(storeOneRoot, { recursive: true, force: true });
    rmSync(storeTwoRoot, { recursive: true, force: true });
    rmSync(sharedPlaybooksRoot, { recursive: true, force: true });
  }
});
