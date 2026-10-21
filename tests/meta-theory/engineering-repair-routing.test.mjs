import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";
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

test("the actual route CLI sends the quant repair through existing engineering selection", (t) => {
  const fixture = createGovernanceRuntimeFixture(t);
  const executionIds = ["worker", "analysis", "frontend", "backend", "test", "review"];
  const runRoute = () => {
    const result = fixture.run(["scripts/select-execution-route.mjs", "--task", quantRepair, "--runtime", "codex", "--os", "windows", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const route = runRoute();
  assert.equal(route.taskShape, "engineering_execution");
  assert.ok(route.recommendedRoute, "the existing route selector must still select a feasible route");
  assert.doesNotMatch(route.recommendedRoute.id, /^product-build-orchestration:/u);
  assert.equal(route.recommendedRoute.id, "execution-capability-discovery:codex:windows");
  assert.ok(route.recommendedRoute.score >= 85);
  assert.deepEqual(route.recommendedRoute.blockedReasons, []);
  const owner = route.recommendedRoute.selectedCapabilityProviders.agent;
  assert.ok(executionIds.includes(owner.id));
  assert.ok(route.ownerDiscoveryPacket.candidateExistingExecutionOwners.includes(owner.id));
  assert.equal(owner.id, route.recommendedRoute.owner);
  assert.equal(owner.source, "local_global_agent_inventory");
  assert.equal(owner.validCustomAgentDefinition, true);
  assert.equal(owner.metadata.name, owner.id);
  assert.notEqual(owner.cacheEvidenceOnly, true);
  assert.equal(owner.sourceRef, `~/.codex/agents/${owner.id}.toml`);
  assert.equal(owner.sourceKey, `codex:agents:${owner.id}:personal:${owner.sourceRef}`);
  const ownerBytes = readFileSync(path.join(fixture.home, ".codex", "agents", `${owner.id}.toml`));
  assert.equal(owner.contentDigest, createHash("sha256").update(ownerBytes).digest("hex"));
  assert.equal(route.recommendedRoute.ownerBinding.selectedOwner, owner.id);
  assert.equal(route.recommendedRoute.ownerBinding.existingOwnerMatched, true);
  assert.ok(route.recommendedRoute.selectedCapabilityProviders.skill);
  assert.ok(route.recommendedRoute.selectedCapabilityProviders.mcpServer
    || route.recommendedRoute.selectedCapabilityProviders.mcpTool);
  assert.equal(route.recommendedRoute.executionEligible, false, "discovery is not execution evidence");
  assert.equal(route.recommendedRoute.codexSpawnBinding.ownerBindingMode, "run_scoped_owner_contract");
  assert.equal(route.recommendedRoute.codexSpawnBinding.nativeAgentType, null);

  // Preserve the cache but remove only this fixture's exact live execution
  // definitions. Cached discovery must not mint an available implementation owner.
  const homeRoot = realpathSync(fixture.home);
  const executionFiles = executionIds.map((id) => path.join(fixture.home, ".codex", "agents", `${id}.toml`));
  for (const file of executionFiles) {
    const relative = path.relative(homeRoot, realpathSync(file));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    assert.equal(lstatSync(file).isSymbolicLink(), false);
  }
  for (const file of executionFiles) unlinkSync(file);
  const missing = runRoute();
  assert.equal(missing.taskShape, "engineering_execution");
  assert.deepEqual(missing.ownerDiscoveryPacket.candidateExistingExecutionOwners, []);
  assert.equal(missing.recommendedRoute, null);
  const engineering = missing.rankedRoutes.find((candidate) => candidate.id === "execution-capability-discovery:codex:windows");
  assert.ok(engineering.blockedReasons.includes("execution owner missing"));
  for (const cached of missing.ownerDiscoveryPacket.localGlobalAgents.filter((agent) => executionIds.includes(agent.id))) {
    assert.equal(cached.cacheEvidenceOnly, true);
    assert.equal(cached.routeEligible, false);
    assert.notEqual(cached.collision.evidenceSource, "live_project_and_global_filesystem");
  }
});
