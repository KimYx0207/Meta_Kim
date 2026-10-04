import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkedPath, componentHash, discoverDependencyAgentContracts } from "../dependency-agent-discovery.mjs";
import { runRouteQuery } from "../run-route-query.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const digest = (value) => createHash("sha256").update(value).digest("hex");
export const MAX_CALCULATION_INPUT_BYTES = 262144;
export const MAX_STORE_CALCULATION_INPUT_BYTES = 65536;
const fieldLabels = { quantity: "采购数量", currency: "币种", specification: "规格与单位", quotes: "候选报价" };

function result(status, fields = {}) {
  return { schemaVersion: 1, status, toolInvoked: false, nativeAgentInvocation: false,
    modelSemanticAcceptance: false, externalActionsPerformed: false, ...fields };
}

function hasDuplicateObjectKeys(validJson) {
  // JSON.parse has already checked syntax. Track object key sets without
  // collapsing duplicates or mistaking punctuation inside strings for tokens.
  const stack = [];
  for (const [token] of validJson.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]/gu)) {
    if (token === "{") stack.push({ keys: new Set(), expectsKey: true });
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else {
      const object = stack.at(-1);
      if (token === "," && object) object.expectsKey = true;
      else if (token.startsWith('"') && object?.expectsKey) {
        const key = JSON.parse(token);
        if (object.keys.has(key)) return true;
        object.keys.add(key); object.expectsKey = false;
      }
    }
  }
  return false;
}

function calculationBrief(toolId, task, materials) {
  if (toolId === "store-performance-calculator") return { request: task,
    comparison: materials.comparison ?? null, definitions: materials.definitions ?? null,
    scope: "review_supplied_store_rows_only", permitsBusinessChanges: false };
  return { request: task, specification: materials.specification ?? null, quantity: materials.quantity ?? null,
    currency: materials.currency ?? null, maxLeadDays: materials.maxLeadDays ?? null,
    weights: materials.weights ?? null, scope: "compare_supplied_materials_only", permitsContactOrPurchase: false };
}

function validateCalculationReceipt(receipt, tool, materials) {
  assert.equal(receipt.tool, tool.id);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.networkUsed, false); assert.equal(receipt.filesModified, false);
  assert(["completed", "partial", "invalid_input"].includes(receipt.status));
  if (tool.id === "supplier-comparison-calculate") {
    assert.equal(receipt.toolVersion, tool.toolVersion);
    assert.equal(receipt.quality.certifiedSuppliers, false);
  } else if (tool.id === "store-performance-calculator") {
    assert.equal(receipt.version, tool.toolVersion);
    assert.deepEqual(Object.keys(receipt).sort(), ["schemaVersion", "tool", "version", "status", "calculationTable",
      "comparisons", "quality", "limitations", "networkUsed", "filesModified"].sort());
    for (const field of ["calculationTable", "comparisons", "quality", "limitations"]) assert(Array.isArray(receipt[field]));
    assert(receipt.quality.every((issue) => issue && typeof issue.code === "string"));
    const metric = (value) => assert(value === null || (typeof value === "string" && /^-?\d+(?:\.\d{1,6})?$/u.test(value)));
    if (receipt.status === "invalid_input") {
      assert.equal(receipt.calculationTable.length, 0); assert.equal(receipt.comparisons.length, 0);
    } else {
      assert.equal(receipt.status, receipt.quality.length ? "partial" : "completed");
      assert.equal(receipt.calculationTable.length, materials.rows.length);
      receipt.calculationTable.forEach((row, index) => {
        for (const field of ["period", "sku", "channel"]) assert.equal(row[field], materials.rows[index][field]);
        for (const field of ["inputs", "metrics", "definitions"]) assert(row[field] && typeof row[field] === "object" && !Array.isArray(row[field]));
        for (const field of ["paidOrdersPerVisitorPercent", "netRevenue", "contributionAfterListedCosts"]) metric(row.metrics[field]);
        assert(row.definitions.currency === null || typeof row.definitions.currency === "string");
      });
      for (const comparison of receipt.comparisons) {
        assert(["comparable", "not_comparable"].includes(comparison.status));
        if (comparison.status === "not_comparable") {
          assert(Array.isArray(comparison.reasons)); assert(Array.isArray(comparison.conflictingFields));
          assert.equal(Object.hasOwn(comparison, "deltas"), false);
          assert.equal(Object.hasOwn(comparison, "revenueDecomposition"), false);
        } else {
          assert(comparison.deltas && typeof comparison.deltas === "object" && !Array.isArray(comparison.deltas));
          metric(comparison.deltas.paidOrdersPerVisitorPercent);
        }
      }
    }
  } else throw new TypeError("unsupported_calculation_receipt");
}

export function calculationIssues(receipt) {
  if (receipt?.tool === "store-performance-calculator") return receipt.quality.map((issue) => {
    const { code, fields, period, row, sku, channel, reasons, conflictingFields, unknownFields } = issue;
    return { code, ...(fields ? { fields } : {}), ...(period ? { period } : {}), ...(row != null ? { row } : {}),
      ...(sku ? { sku } : {}), ...(channel ? { channel } : {}), ...(reasons ? { reasons } : {}),
      ...(conflictingFields ? { conflictingFields } : {}), ...(unknownFields ? { unknownFields } : {}) };
  });
  return (receipt?.quality?.issues ?? []).map(({ code, field }) => ({ code, ...(field ? { field } : {}) }));
}

/** A deterministic read-only calculation is a host tool, not native Agent
 * execution. The host supplies the original request and explicit materials.
 * This bridge never invents conversation confirmation or executes arbitrary
 * dependency commands. Only reviewed script bytes can cross this boundary.
 */
export async function runDependencyCalculation({ task, inputJson, dependencyRoot = process.env.META_KIM_KIM_SERVICE_ROOT,
  runtime = process.env.META_KIM_RUNTIME_FAMILY, osTarget = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux" } = {}) {
  if (typeof task !== "string" || !task.trim() || task.length > 6000 || typeof inputJson !== "string"
    || Buffer.byteLength(inputJson) > MAX_CALCULATION_INPUT_BYTES) return result("invalid_input", { code: "invalid_request_envelope" });
  let materials;
  try { materials = JSON.parse(inputJson); } catch { return result("invalid_input", { code: "invalid_materials_json" }); }
  if (!materials || typeof materials !== "object" || Array.isArray(materials)) return result("invalid_input", { code: "materials_must_be_object" });
  runtime = runtime === "claude" ? "claude_code" : runtime;
  if (!["codex", "claude_code", "cursor", "openclaw"].includes(runtime)) {
    return result("unavailable", { code: "runtime_binding_required",
      nextAction: "Bind META_KIM_RUNTIME_FAMILY in the MCP server configuration to its actual host runtime." });
  }
  if (typeof dependencyRoot !== "string" || !path.isAbsolute(dependencyRoot)) {
    return result("unavailable", { code: "explicit_dependency_root_required", nextAction: "Configure META_KIM_KIM_SERVICE_ROOT with the existing Kim_Service checkout." });
  }
  const binding = { requestSha256: digest(task), inputSha256: digest(inputJson), intentSource: "host_supplied_request_and_materials" };
  let componentRoot, policy, tool, script, sourceHash, route;
  try {
    const sourceRoot = path.resolve(dependencyRoot);
    const real = await fs.realpath(sourceRoot);
    assert.equal(process.platform === "win32" ? real.toLowerCase() : real,
      process.platform === "win32" ? sourceRoot.toLowerCase() : sourceRoot);
    const projects = JSON.parse(await fs.readFile(path.join(repoRoot, "config/capability-index/dependency-project-registry.json"), "utf8")).projects;
    const env = { ...process.env, META_KIM_KIM_SERVICE_ROOT: sourceRoot };
    const discovered = await discoverDependencyAgentContracts({ projects, projectRoot: repoRoot, environment: env });
    route = await runRouteQuery({ task, runtime, os: osTarget, env });
    if (route.entryClassification?.path === "fast_path") return result("not_applicable", { code: "request_is_not_execution", binding });
    const policies = JSON.parse(await fs.readFile(path.join(repoRoot, "config/contracts/dependency-calculation-tools.json"), "utf8"));
    policy = policies.tools.find((entry) => entry.ownerId === route.recommendedRoute?.owner);
    if (!policy) return result("unavailable", { code: "selected_owner_has_no_reviewed_calculator", binding });
    const owner = discovered.agents.find((entry) => entry.id === policy.ownerId);
    const routed = route.recommendedRoute.selectedCapabilityProviders?.agent;
    assert(owner && routed?.source === "dependency_agent_contract");
    assert.equal(routed.contentDigest, owner.contentDigest);
    assert.equal(routed.ownerContract.componentContentSha256, owner.ownerContract.componentContentSha256);
    componentRoot = await checkedPath(sourceRoot, `agents/${policy.componentId}`, true);
    sourceHash = await componentHash(componentRoot);
    assert.equal(sourceHash, owner.ownerContract.componentContentSha256);
    const contractBytes = await fs.readFile(await checkedPath(componentRoot, policy.contractFile));
    assert.equal(digest(contractBytes), policy.contractSha256, "calculator contract has not been reviewed");
    tool = JSON.parse(contractBytes);
    assert.equal(tool.componentId, policy.componentId);
    assert.equal(owner.ownerContract.helperContract, policy.contractFile);
    assert.equal(tool.schemaVersion, 1);
    assert.equal(tool.invocation.shell, false);
    if (tool.id === "store-performance-calculator") assert.equal(tool.maxInputBytes, MAX_STORE_CALCULATION_INPUT_BYTES);
    script = await fs.readFile(await checkedPath(componentRoot, tool.invocation.entrypoint));
    assert.equal(digest(script), policy.scriptSha256, "calculator script has not been reviewed");
  } catch {
    return result("unavailable", { code: "dependency_source_or_route_not_verified", binding });
  }
  const brief = calculationBrief(tool.id, task, materials);
  const selectedRoute = { owner: policy.ownerId, runtime, entryPath: route.entryClassification.path,
    source: "existing_execution_route", sourceContentSha256: sourceHash, toolId: tool.id };
  if (tool.id === "store-performance-calculator" && Buffer.byteLength(inputJson, "utf8") > MAX_STORE_CALCULATION_INPUT_BYTES) {
    return result("invalid_input", { code: "calculation_materials_size_limit", maxBytes: MAX_STORE_CALCULATION_INPUT_BYTES,
      binding, brief, route: selectedRoute });
  }
  const missing = tool.requiredMaterials.filter((key) => !Object.hasOwn(materials, key)
    || materials[key] == null || (typeof materials[key] === "string" && !materials[key].trim())
    || (Array.isArray(materials[key]) && materials[key].length === 0));
  // Ambiguous raw input must still reach the helper's strict duplicate-key
  // parser; its last-value-wins projection must not masquerade as missing data.
  if (missing.length && !hasDuplicateObjectKeys(inputJson)) return result("needs_input", { binding, brief, route: selectedRoute, missing,
    questions: [tool.id === "store-performance-calculator"
      ? "请提供要复盘的期间、SKU、渠道及明确指标行（如曝光、访客、支付订单和收入）；未知退款或成本可留空。"
      : `请补充${missing.map((key) => fieldLabels[key] ?? key).join("、")}；不需要为了核算先设置权重。`] });
  const gate = route.routeExecutionGate;
  if (gate?.handoffStatus === "awaiting_native_choice" && route.userChoiceNeeded) return result("needs_input", { binding, brief, route: selectedRoute,
    code: "material_route_choice_required", questions: [route.requiredUserChoiceIfAny ?? "请确认影响本次结果的路径选择。"] });
  // Route readiness is required before the MCP host starts its bounded tool;
  // it does not claim native Agent execution or replace host permissions.
  if (gate?.handoffStatus !== "ready_for_host_handoff" || gate.routeCompatible !== true || gate.canHandoffToHost !== true) {
    return result("unavailable", { code: "route_not_ready_for_host_handoff", binding, brief, route: selectedRoute,
      gate: { handoffStatus: gate?.handoffStatus ?? "missing", blockedBy: gate?.blockedBy ?? [],
        returnToStage: gate?.returnToStage ?? "Fetch", reason: gate?.reason ?? "Route handoff evidence is missing." } });
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-calculation-"));
  try {
    // Execute a snapshot of the reviewed bytes; a later dependency edit cannot
    // swap the script after verification. This is not a hostile same-user sandbox.
    const entrypoint = path.join(temporary, "calculate.py");
    await fs.writeFile(entrypoint, script, { flag: "wx" });
    const python = process.platform === "win32" ? "python" : "python3";
    const env = { PATH: process.env.PATH ?? "", HOME: temporary, USERPROFILE: temporary,
      TMPDIR: temporary, TEMP: temporary, TMP: temporary, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" };
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
    const run = spawnSync(python, ["-I", "-B", entrypoint, ...tool.invocation.argv], {
      cwd: temporary, env, shell: false, windowsHide: true, encoding: "utf8", input: inputJson,
      timeout: 10000, maxBuffer: 1024 * 1024,
    });
    if (run.error || run.signal || ![0, 2].includes(run.status) || run.stderr) {
      return result("unavailable", { toolInvoked: Boolean(run.pid), code: "calculation_process_failed", binding, brief, route: selectedRoute,
        diagnostics: { exitCode: run.status, signal: run.signal ?? null, timedOut: run.error?.code === "ETIMEDOUT" } });
    }
    let receipt;
    try {
      receipt = JSON.parse(run.stdout);
      validateCalculationReceipt(receipt, tool, materials);
      assert.equal(run.status, receipt.status === "invalid_input" ? 2 : 0);
      assert.equal(await componentHash(componentRoot), sourceHash);
    } catch { return result("failed", { toolInvoked: true, code: "calculation_receipt_or_source_changed", binding, brief, route: selectedRoute }); }
    return result(receipt.status, { toolInvoked: true, binding, brief, route: selectedRoute, questions: [], receipt,
      execution: { kind: "real_python_calculation", scriptSha256: policy.scriptSha256, contractSha256: policy.contractSha256,
        exitCode: run.status, outputSha256: digest(run.stdout), sourceUnchanged: true },
      delivery: renderCalculationDelivery(receipt) });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export function renderCalculationDelivery(receipt) {
  if (receipt.status === "invalid_input") return "材料格式有误，本次未形成可用核算结果；请按计算器输入合同修正。";
  if (receipt.tool === "store-performance-calculator") {
    const rows = receipt.calculationTable.map((row) => `${row.period}/${row.sku}/${row.channel}：支付订单/访客 ${row.metrics.paidOrdersPerVisitorPercent == null ? "未知或不适用" : `${row.metrics.paidOrdersPerVisitorPercent}%`}` +
      `，退款净收入 ${row.metrics.netRevenue ?? "未知"} ${row.definitions.currency ?? "币种未知"}，所列成本后贡献 ${row.metrics.contributionAfterListedCosts ?? "未知"}`);
    return [...rows, ...receipt.comparisons.map((comparison) => comparison.status === "not_comparable"
      ? `${comparison.sku}/${comparison.channel}：口径缺失、冲突或期间行未匹配，保留各期指标，不作跨期比较和收入分解。`
      : `${comparison.sku}/${comparison.channel}：支付订单/访客变化 ${comparison.deltas.paidOrdersPerVisitorPercent ?? "未知"} 个百分点；收入分解仅为算术，不证明因果。`),
      "缺失退款或成本保持未知；所列成本后贡献未含固定开支与税费。广告费/全部订单不是广告CAC或ROAS，不汇总跨SKU/渠道访客。未登录后台、投放或变更业务。"].join("\n");
  }
  const rows = receipt.normalizedQuotes.map((row) => `${row.supplierId}：到货总支出 ${row.landedTotal ?? "待确认"} ${row.currency ?? "币种待确认"}，实收 ${row.deliveredQuantity ?? "待确认"}，超购 ${row.excessQuantity ?? "待确认"}，交期 ${row.leadDays ?? "待确认"} 天，约束状态 ${row.constraintStatus}`);
  return [...rows, receipt.ranking == null ? "未合成排名，保留逐项比较；具体缺项见计算回执。" : "评分仅使用本次材料明确给出的权重和质量口径，详见计算回执。",
    "费用只包含已声明项目；交期和质量材料尚未核验。未联系供应商、下单或付款。"].join("\n");
}
