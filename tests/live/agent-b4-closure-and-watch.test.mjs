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
import { startLiveControlRoom } from "../../src/infrastructure/live/live-control-room-server.mjs";

function createGitRepo(prefix = "meta-kim-b4-") {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "config"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "eu-shop-one", private: true }, null, 2));
  writeFileSync(path.join(root, "config", "store-eu.json"), JSON.stringify({ currency: "EUR", safetyStock: 10 }, null, 2));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  return root;
}

function createMockStartService(planPreview) {
  const requests = new Map();
  return {
    async getHosts() {
      return {
        recommendedHostId: "claude",
        hosts: [{ id: "claude", label: "Claude Code", available: true, launchSupported: true, version: "2.1.260" }],
      };
    },
    async start({ idempotencyKey }) {
      requests.set(idempotencyKey, {
        status: "completed",
        selectedHostId: "claude",
        capabilityState: { status: "verified_read_only" },
        resultPreview: planPreview,
      });
      return {
        status: "accepted",
        selectedHostId: "claude",
        capabilityState: { status: "verified_read_only" },
      };
    },
    async inspect({ idempotencyKey }) {
      return requests.get(idempotencyKey) ?? { status: "unknown" };
    },
    async close() {},
  };
}

function sampleEcommerceDesign() {
  return {
    system: {
      title: "欧洲跨境电商独立站运营系统",
      goal: "针对 Shopify 欧洲 B2C 零售店铺提升转化率并稳定库存周转",
      architecture: "市场选品 -> 定价库存联动 -> 投放增长闭环，采用受控草稿隔离核验后合入主仓",
      techStack: "Node.js ESM, Shopify B2C, JSON 配置驱动",
      acceptance: [
        "定价与安全库存计算模块通过语法与结构核验",
        "店铺配置保持合法 JSON 且不触碰任何密钥文件",
      ],
    },
    modules: [
      {
        id: "market-research",
        title: "市场与竞品调研",
        objective: "提炼欧洲冬季高潜品类与价格带基准",
        inputContract: ["目标品类目录"],
        outputContract: ["docs/market-brief.md"],
        boundaries: ["只输出分析结论，不改动线上价格"],
        acceptance: ["包含竞品价格带与主推卖点"],
        dependencies: [],
      },
      {
        id: "pricing-inventory",
        title: "动态定价与安全库存",
        objective: "按转化率与补货周期计算安全库存阈值",
        inputContract: ["docs/market-brief.md", "config/store-eu.json"],
        outputContract: ["src/pricing-engine.mjs", "config/store-eu.json"],
        boundaries: ["不直接发起外部采购付款"],
        acceptance: ["导出 computeSafetyStock 纯函数并通过语法检查"],
        dependencies: ["market-research"],
      },
      {
        id: "campaign-growth",
        title: "转化率优化与活动编排",
        objective: "结合库存健康度生成投放与着陆页优化清单",
        inputContract: ["src/pricing-engine.mjs"],
        outputContract: ["docs/campaign-plan.md"],
        boundaries: ["不自动发布外部广告"],
        acceptance: ["列出库存充足 SKU 的着陆页改进项"],
        dependencies: ["pricing-inventory"],
      },
    ],
  };
}

async function bootstrapAdoptedWorkflow(projectRoot, key = "req_b4_ecom_store_01") {
  const preview = JSON.stringify({
    schemaVersion: "meta-kim-agent-strategy-options-v1",
    provenance: "native_plan_unverified",
    evidenceVerified: false,
    summary: "欧洲站转化率偏低，建议先打通选品定价与库存联动。",
    recommendedStrategyId: "A",
    openQuestions: [],
    strategies: [
      {
        id: "A",
        title: "稳健库存联动转化方案",
        approach: "先校准畅销 SKU 定价带与安全库存，再优化高库存款着陆页",
        tradeoffs: "首周爆发慢于激进打折，但毛利稳定",
        evidenceSummary: "适合 Shopify B2C 跨境零售独立站",
        risks: "旺季补货延迟需单独设安全系数",
      },
      {
        id: "B",
        title: "全店激进清仓引流方案",
        approach: "全量降价 25% 冲销量",
        tradeoffs: "短期流量快但易断货亏毛利",
        evidenceSummary: "仅适合尾货清理",
        risks: "热销款断货导致差评",
      },
    ],
  });
  const startService = createMockStartService(preview);
  const workflowService = createAgentWorkflowService({
    projectRoot,
    profile: "default",
    agentStartService: startService,
  });
  await workflowService.start({
    goal: "提升 Shopify 欧洲跨境电商 B2C 零售独立站转化率并稳定库存",
    hostId: "claude",
    idempotencyKey: key,
  });
  const receipt = await workflowService.inspect({ idempotencyKey: key });
  await workflowService.recordDecision({
    idempotencyKey: key,
    requestId: receipt.requestId,
    planDigest: receipt.planDigest,
    decisionKey: "dec_adopt_store_01",
    action: "adopt",
    selectedStrategy: "A：稳健库存联动转化方案",
    selectionReason: "优先保毛利与不断货，契合欧洲 B2C 独立站复购逻辑",
  });
  const designSnap = await workflowService.inspectDesign({ idempotencyKey: key });
  return { workflowService, basis: designSnap.basis, key };
}

test("Wave 1 closure: approve_all, background watch verification, scoped rework, safe merge-back, and cross-store playbook gating", async () => {
  const repoOne = createGitRepo("meta-kim-store1-");
  const repoTwo = createGitRepo("meta-kim-store2-");
  const sharedPlaybooksRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-playbooks-"));

  try {
    const { workflowService, basis, key } = await bootstrapAdoptedWorkflow(repoOne);

    // 1. Submit B2 design, verify approve_all blocks when pendingReviewNotes exist, then succeeds atomically.
    const submitted = await workflowService.recordDesign({
      ...basis,
      action: "submit",
      mutationKey: "mut_submit_design_01",
      expectedVersion: 0,
      design: sampleEcommerceDesign(),
    });
    assert.equal(submitted.version, 1);
    assert.equal(submitted.status, "draft");

    const noted = await workflowService.recordDesign({
      idempotencyKey: basis.idempotencyKey,
      requestId: basis.requestId,
      planDigest: basis.planDigest,
      decisionKey: basis.decisionKey,
      action: "request_revision",
      mutationKey: "mut_review_note_market_0001",
      expectedVersion: 1,
      target: { kind: "module", moduleId: "market-research" },
      feedback: "请补充退货率约束说明",
    });
    assert.equal(noted.pendingReviewNotes.length, 1);

    await assert.rejects(
      async () => workflowService.recordDesign({
        ...basis,
        action: "approve_all",
        mutationKey: "mut_approve_all_blocked",
        expectedVersion: noted.version,
      }),
      (err) => err.code === "AGENT_REQUEST_CONFLICT" && err.reason === "agent_design_unresolved_feedback",
    );

    const revisedMarket = await workflowService.recordDesign({
      ...basis,
      action: "revise_module",
      mutationKey: "mut_fix_market_boundary_01",
      expectedVersion: noted.version,
      module: {
        ...sampleEcommerceDesign().modules[0],
        boundaries: ["只输出分析结论，不改动线上价格", "剔除历史退货率高于 18% 的尺码敏感款"],
      },
    });
    assert.equal(revisedMarket.pendingReviewNotes.length, 0);

    const approvedAll = await workflowService.recordDesign({
      ...basis,
      action: "approve_all",
      mutationKey: "mut_approve_all_ok_01",
      expectedVersion: revisedMarket.version,
    });
    assert.equal(approvedAll.status, "approved");
    assert.equal(approvedAll.reviewComplete, true);
    assert.equal(approvedAll.system.approval.state, "approved");
    assert.ok(approvedAll.modules.every((m) => m.approval.state === "approved"));

    const handoffV1 = workflowService.prepareHandoff({
      ...basis,
      handoffKey: "handoff_prepare_store1_v1",
      designVersion: approvedAll.version,
      designDigest: approvedAll.designDigest,
    });
    assert.equal(handoffV1.status, "prepared");

    // 2. Wire B3 + B4 with isolated worktree simulation & background watch reconciler.
    let activeSessionId = "a1b2c3d4";
    let activeWorktree = path.join(repoOne, ".claude-worktrees", "wt-round-1");
    let activeSessionState = "working";
    let launchCalls = 0;

    const executionBridge = createAgentExecutionBridge({
      projectRoot: repoOne,
      profile: "default",
      agentWorkflowService: workflowService,
    });
    const nativeExecutionService = createAgentNativeExecutionService({
      projectRoot: repoOne,
      profile: "default",
      workflowService,
      executionBridge,
      probe: async () => ({ status: "detected", version: "2.1.260" }),
      launch: async (_bin, args) => {
        if (args[0] === "agents") {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: activeSessionId,
                kind: "background",
                cwd: activeWorktree,
                name: "meta-" + key.slice(0, 20),
                startedAt: Date.now(),
                state: activeSessionState,
              },
            ]),
          };
        }
        launchCalls += 1;
        mkdirSync(path.join(activeWorktree, "src"), { recursive: true });
        mkdirSync(path.join(activeWorktree, "config"), { recursive: true });
        mkdirSync(path.join(activeWorktree, "docs"), { recursive: true });
        writeFileSync(path.join(activeWorktree, "package.json"), readFileSync(path.join(repoOne, "package.json")));
        return {
          status: 0,
          stdout: `backgrounded · ${activeSessionId}\n`,
        };
      },
    });

    const acceptanceService = createAgentAcceptanceService({
      projectRoot: repoOne,
      profile: "default",
      workflowService,
      nativeExecutionService,
      sharedPlaybooksRoot,
    });

    const launchedV1 = await nativeExecutionService.authorizeAndLaunch({
      idempotencyKey: key,
      handoffDigest: handoffV1.handoffDigest,
      approvalKey: "b3_approval_store1_round1",
      scope: "local_project_draft",
    });
    assert.equal(launchedV1.nativeSessionId, "a1b2c3d4");
    assert.equal(launchCalls, 1);

    // Worker writes round-1 draft files inside isolated worktree; main projectRoot stays untouched!
    writeFileSync(path.join(activeWorktree, "docs", "market-brief.md"), "# 欧洲冬季选品简报\n主打保暖家居服，客单价 39-59 EUR。\n");
    writeFileSync(
      path.join(activeWorktree, "src", "pricing-engine.mjs"),
      "export function computeSafetyStock(dailySales) {\n  return Math.ceil(dailySales * 7);\n}\n",
    );
    writeFileSync(path.join(activeWorktree, "config", "store-eu.json"), JSON.stringify({ currency: "EUR", safetyStock: 28 }, null, 2));
    writeFileSync(path.join(activeWorktree, "docs", "campaign-plan.md"), "# 着陆页优化清单\n突出 48h 欧洲本地仓发货。\n");
    assert.equal(existsSync(path.join(repoOne, "src", "pricing-engine.mjs")), false);

    // Background watch reconciler runs once while session is finished -> auto-verifies & transitions to awaiting_human_b4!
    activeSessionState = "done";
    const watchSummary = await acceptanceService.reconcileActive();
    assert.equal(watchSummary.checkedCount, 1);
    assert.equal(watchSummary.verifiedCount, 1);

    const b4Round1 = await acceptanceService.inspect({ idempotencyKey: key });
    assert.equal(b4Round1.status, "awaiting_human_b4");
    assert.equal(b4Round1.verification.passed, true);
    assert.equal(b4Round1.changedFiles.length, 4);
    // Must not expose raw host paths in public inspection payload.
    assert.equal(JSON.stringify(b4Round1).includes(repoOne), false);

    // 3. Human requests module-scoped rework on pricing-inventory at B4!
    const reworkReceipt = await acceptanceService.decide({
      idempotencyKey: key,
      decisionKey: "b4_rework_pricing_01",
      handoffDigest: handoffV1.handoffDigest,
      artifactsDigest: b4Round1.artifactsDigest,
      action: "request_rework",
      moduleId: "pricing-inventory",
      feedback: "旺季补货周期延长，安全库存需支持 seasonMultiplier 旺季系数",
    });
    assert.equal(reworkReceipt.status, "rework_requested");

    // Upstream market-research & system remain approved; pricing-inventory and downstream campaign-growth invalidated!
    const afterReworkDesign = await workflowService.inspectDesign({ idempotencyKey: key });
    assert.equal(afterReworkDesign.system.approval.state, "approved");
    const byId = Object.fromEntries(afterReworkDesign.modules.map((m) => [m.id, m.approval.state]));
    assert.equal(byId["market-research"], "approved");
    assert.notEqual(byId["pricing-inventory"], "approved");
    assert.equal(byId["campaign-growth"], "invalidated");

    // 4. Revise pricing-inventory, approve_all remaining invalidated nodes, seal handoff v2, launch round 2!
    const revisedPricing = await workflowService.recordDesign({
      ...basis,
      action: "revise_module",
      mutationKey: "mut_revise_pricing_v2",
      expectedVersion: afterReworkDesign.version,
      module: {
        ...sampleEcommerceDesign().modules[1],
        acceptance: ["导出 computeSafetyStock(dailySales, seasonMultiplier) 纯函数并通过语法检查"],
      },
    });
    const reapproved = await workflowService.recordDesign({
      ...basis,
      action: "approve_all",
      mutationKey: "mut_approve_all_v2",
      expectedVersion: revisedPricing.version,
    });
    assert.equal(reapproved.status, "approved");

    const handoffV2 = workflowService.prepareHandoff({
      ...basis,
      handoffKey: "handoff_prepare_store1_v2",
      designVersion: reapproved.version,
      designDigest: reapproved.designDigest,
    });
    assert.notEqual(handoffV2.handoffDigest, handoffV1.handoffDigest);

    activeSessionId = "e5f6a7b8";
    activeWorktree = path.join(repoOne, ".claude-worktrees", "wt-round-2");
    activeSessionState = "done";

    const launchedV2 = await nativeExecutionService.authorizeAndLaunch({
      idempotencyKey: key,
      handoffDigest: handoffV2.handoffDigest,
      approvalKey: "b3_approval_store1_round2",
      scope: "local_project_draft",
    });
    assert.equal(launchedV2.nativeSessionId, "e5f6a7b8");
    assert.equal(launchCalls, 2);

    // First test forbidden-path & syntax protection before valid deliverables!
    writeFileSync(path.join(activeWorktree, ".env.production"), "SHOPIFY_SECRET=leak\n");
    const blockedInspect = await acceptanceService.verifyArtifacts({ idempotencyKey: key });
    assert.equal(blockedInspect.status, "blocked");
    assert.equal(blockedInspect.reason, "worktree_forbidden_path_modified");
    rmSync(path.join(activeWorktree, ".env.production"));

    // Now write clean round-2 deliverables incorporating the seasonMultiplier lesson!
    writeFileSync(path.join(activeWorktree, "docs", "market-brief.md"), "# 欧洲冬季选品简报\n主打保暖家居服，客单价 39-59 EUR。\n");
    writeFileSync(
      path.join(activeWorktree, "src", "pricing-engine.mjs"),
      "export function computeSafetyStock(dailySales, seasonMultiplier = 1.5) {\n  return Math.ceil(dailySales * 7 * seasonMultiplier);\n}\n",
    );
    writeFileSync(path.join(activeWorktree, "config", "store-eu.json"), JSON.stringify({ currency: "EUR", safetyStock: 42, seasonMultiplier: 1.5 }, null, 2));
    writeFileSync(path.join(activeWorktree, "docs", "campaign-plan.md"), "# 着陆页优化清单\n突出 48h 欧洲本地仓发货与旺季不断货保障。\n");

    const verifiedV2 = await acceptanceService.verifyArtifacts({ idempotencyKey: key });
    assert.equal(verifiedV2.status, "awaiting_human_b4");
    assert.equal(verifiedV2.verification.passed, true);

    // 5. Simulate concurrent conflict in main repo, ensure it blocks overwrite, then restore & accept cleanly!
    const originalStoreConfig = readFileSync(path.join(repoOne, "config", "store-eu.json"), "utf8");
    writeFileSync(path.join(repoOne, "config", "store-eu.json"), JSON.stringify({ currency: "GBP", manualOverride: true }, null, 2));

    const conflictResult = await acceptanceService.decide({
      idempotencyKey: key,
      decisionKey: "b4_accept_conflict_try",
      handoffDigest: handoffV2.handoffDigest,
      artifactsDigest: verifiedV2.artifactsDigest,
      action: "accept",
      summary: "确认合入主仓",
    });
    assert.equal(conflictResult.status, "blocked");
    assert.equal(conflictResult.reason, "merge_conflict_detected");
    assert.equal(JSON.parse(readFileSync(path.join(repoOne, "config", "store-eu.json"), "utf8")).currency, "GBP");

    // Restore clean baseline in main repo and accept B4!
    writeFileSync(path.join(repoOne, "config", "store-eu.json"), originalStoreConfig);
    const acceptedB4 = await acceptanceService.decide({
      idempotencyKey: key,
      decisionKey: "b4_accept_store1_final",
      handoffDigest: handoffV2.handoffDigest,
      artifactsDigest: verifiedV2.artifactsDigest,
      action: "accept",
      summary: "旺季安全库存系数验证通过，正式合入一号店并沉淀方法卡",
    });
    assert.equal(acceptedB4.status, "accepted_and_integrated");
    assert.equal(existsSync(path.join(repoOne, "src", "pricing-engine.mjs")), true);
    assert.equal(JSON.parse(readFileSync(path.join(repoOne, "config", "store-eu.json"), "utf8")).safetyStock, 42);
    assert.ok(acceptedB4.playbook?.playbookId);
    assert.ok(acceptedB4.playbook.reworkLessons.some((item) => item.includes("seasonMultiplier")));

    // 6. Store 2 (compatible EU Shopify B2C) vs Store 3 (incompatible B2B wholesale credit) applicability check!
    const { workflowService: wfTwo } = await bootstrapAdoptedWorkflow(repoTwo, "req_b4_ecom_store_02");
    const storeTwoAcceptance = createAgentAcceptanceService({
      projectRoot: repoTwo,
      profile: "default",
      workflowService: wfTwo,
      nativeExecutionService: createAgentNativeExecutionService({
        projectRoot: repoTwo,
        profile: "default",
        workflowService: wfTwo,
        executionBridge: createAgentExecutionBridge({
          projectRoot: repoTwo,
          profile: "default",
          agentWorkflowService: wfTwo,
        }),
        probe: async () => ({ status: "detected", version: "2.1.260" }),
        launch: async () => ({ status: 1, stdout: "" }),
      }),
      sharedPlaybooksRoot,
    });

    const compatibleMatches = storeTwoAcceptance.matchPlaybooks({
      goal: "开设欧洲二店（德国站 Shopify B2C 零售独立站），提升新品转化率与旺季库存稳定",
      techStack: "Node.js ESM, Shopify B2C",
    });
    assert.equal(compatibleMatches.length, 1);
    assert.equal(compatibleMatches[0].applicability, "compatible");
    assert.ok(compatibleMatches[0].reworkLessons.some((item) => item.includes("seasonMultiplier")));

    const incompatibleMatches = storeTwoAcceptance.matchPlaybooks({
      goal: "工业重型机械 B2B 线下大宗批发与 90 天账期授信审批系统",
      techStack: "Java ERP, Offline Credit",
      constraints: ["b2b_wholesale_credit"],
    });
    assert.equal(incompatibleMatches.length, 1);
    assert.equal(incompatibleMatches[0].applicability, "incompatible_context");
    assert.ok(incompatibleMatches[0].mismatchReasons.length >= 1);

    await workflowService.close();
    await wfTwo.close();
  } finally {
    rmSync(repoOne, { recursive: true, force: true });
    rmSync(repoTwo, { recursive: true, force: true });
    rmSync(sharedPlaybooksRoot, { recursive: true, force: true });
  }
});

test("HTTP /api/agent/acceptance enforces workspace token + same-origin JSON and exposes safe B4 snapshot", async () => {
  const repo = createGitRepo("meta-kim-b4-http-");
  const sharedPlaybooksRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-http-pb-"));
  let room = null;
  try {
    const { workflowService, basis, key } = await bootstrapAdoptedWorkflow(repo, "req_b4_http_check_01");
    const executionBridge = createAgentExecutionBridge({
      projectRoot: repo,
      profile: "default",
      agentWorkflowService: workflowService,
    });
    const nativeExecutionService = createAgentNativeExecutionService({
      projectRoot: repo,
      profile: "default",
      workflowService,
      executionBridge,
      probe: async () => ({ status: "detected", version: "2.1.260" }),
      launch: async () => ({ status: 0, stdout: "[]" }),
    });
    const acceptanceService = createAgentAcceptanceService({
      projectRoot: repo,
      profile: "default",
      workflowService,
      nativeExecutionService,
      sharedPlaybooksRoot,
    });

    room = await startLiveControlRoom({
      projectRoot: repo,
      port: 0,
      globalHub: false,
      workspaceEnabled: true,
      enableAgentStart: true,
      agentStartService: workflowService,
      agentNativeExecutionService: nativeExecutionService,
      agentAcceptanceService: acceptanceService,
      service: { getSnapshot: async () => null },
    });
    const baseUrl = room.url;
    const pageHtml = await (await fetch(`${baseUrl}/`)).text();
    const configMatch = pageHtml.match(/<script type="application\/json" id="live-workspace-config">([^<]+)<\/script>/u);
    assert.ok(configMatch?.[1]);
    const auth = JSON.parse(configMatch[1]);
    const headers = { [auth.controlHeader]: auth.controlToken };

    // Missing token -> 403
    const unauth = await fetch(`${baseUrl}/api/agent/acceptance?idempotencyKey=${key}`);
    assert.equal(unauth.status, 403);

    // Valid token GET -> 200
    const inspectRes = await fetch(`${baseUrl}/api/agent/acceptance?idempotencyKey=${key}`, { headers });
    assert.equal(inspectRes.status, 200);
    const body = await inspectRes.json();
    assert.equal(body.schemaVersion, "meta-kim-agent-b4-acceptance-v1");
    assert.equal(body.status, "not_ready");
    assert.equal(JSON.stringify(body).includes(repo), false);

    // Cross-origin POST -> 403
    const badOrigin = await fetch(`${baseUrl}/api/agent/acceptance`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ idempotencyKey: key, action: "verify" }),
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(Boolean(basis.requestId), true);
  } finally {
    if (room) await room.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(sharedPlaybooksRoot, { recursive: true, force: true });
  }
});
