import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyTaskShape } from "../../scripts/governance-lib.mjs";
import { classifyMetaTheoryEntry, hasProductBuildIntent } from "../../scripts/meta-theory-entry-classifier.mjs";

const quantRepair = "完成量化0.4.6-3整轮行情末尾指标计算超时修复与选股持仓研究一致性验收，保留已认可完整产品，零新增成本，只用隔离测试及软件本身访问真实数据，禁止原始数据库引擎直读、凭据和云变更。";

test("an existing-product repair does not borrow its product object from a preservation constraint", () => {
  for (const task of [quantRepair,
    "Fix the indicator timeout in the existing application, preserve the approved complete product; do not build a new platform.",
    "修复现有产品的接口超时，保留完整产品，不要重新开发平台。",
    "保留现有平台并修复接口超时，不要重建产品。",
    "修复高并发超时，保留已认可完整产品",
    "修复并行任务超时，保留完整产品",
    "修复合并排序超时，保留完整产品",
  ]) {
    assert.equal(classifyMetaTheoryEntry(task).signals.productBuildIntent, false, task);
    assert.equal(classifyTaskShape(task), "engineering_execution", task);
  }
});

test("new product requests and explicit mixed repair/build work retain the product route", () => {
  for (const task of [
    "帮我做个小红书营销自动发布器",
    "Build a new analytics dashboard",
    "新建平台，同时修复旧系统的接口超时",
    "修复旧系统的接口超时，并实现新的监控平台",
    "Repair the existing app timeout and create a new monitoring dashboard",
    "アプリを作る",
    "새 앱을 만들어 주세요",
  ]) assert.equal(hasProductBuildIntent(task), true, task);
});

test("negated construction and a definition do not grant product-build intent", () => {
  assert.equal(hasProductBuildIntent("不要新建平台，只修复接口超时"), false);
  const definition = classifyMetaTheoryEntry("What does it mean to build a platform?");
  assert.equal(definition.path, "fast_path");
  assert.equal(definition.signals.productBuildIntent, false);
});

test("the self-contained activation hook follows the same repair/constraint boundary", () => {
  const source = readFileSync(new URL("../../canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function productBuildRequested(");
  const end = source.indexOf("\nconst PROJECT_UNDERSTANDING_RE", start);
  assert.ok(start >= 0 && end > start);
  const classify = new Function("ACTION_RE", "PRODUCT_BUILD_OBJECT_RE", `${source.slice(start, end)}; return productBuildRequested;`)(
    /build|create|implement|fix|repair|帮我|修复|做|新建|实现/iu,
    /app|platform|dashboard|平台|系统|产品|发布器/iu,
  );
  for (const task of [quantRepair, "Fix the app timeout, preserve the approved platform", "修复旧系统并新建监控平台", "修复高并发平台超时，保留已认可产品", "帮我做个营销发布器"]) {
    assert.equal(classify(task), hasProductBuildIntent(task), task);
  }
  const observedClauses = [];
  const observeClauses = new Function("ACTION_RE", "PRODUCT_BUILD_OBJECT_RE", `${source.slice(start, end)}; return productBuildRequested;`)(
    { test(clause) { observedClauses.push(clause); return /修复/iu.test(clause); } },
    /平台/iu,
  );
  observeClauses("修复高并发平台超时，保留完整产品");
  assert.ok(observedClauses.includes("修复高并发平台超时"), "the hook must keep 并 inside an engineering word");
});

test("the actual route CLI sends the quant repair through existing engineering selection", () => {
  const result = spawnSync(process.execPath, ["scripts/select-execution-route.mjs", "--task", quantRepair, "--runtime", "codex", "--os", "windows", "--json"], {
    cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const route = JSON.parse(result.stdout);
  assert.equal(route.taskShape, "engineering_execution");
  assert.ok(route.recommendedRoute, "the existing route selector must still select a feasible route");
  assert.doesNotMatch(route.recommendedRoute.id, /^product-build-orchestration:/u);
});
