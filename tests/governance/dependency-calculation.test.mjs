import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { runDependencyCalculation } from "../../scripts/governed-execution/dependency-calculation.mjs";
import { componentHash, stableJson } from "../../scripts/dependency-agent-discovery.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const dependencyRoot = process.env.META_KIM_TEST_KIM_SERVICE_SOURCE;
const task = "帮我比较材料中的两家采购供应商：120个同规格白色M号纸袋，CNY，最长8天到货；算到货总支出和超购，保留质量证据缺口，不设默认权重，不联系供应商或下单。";
const sourceOptions = { skip: !dependencyRoot && "Requires explicitly selected real Kim_Service source", timeout: 45000 };
const inputJson = () => fs.readFileSync(path.join(dependencyRoot, "agents/supplier-comparison-analyst/tests/fixtures/normal.json"), "utf8");
const run = (overrides = {}) => runDependencyCalculation({ task, inputJson: inputJson(), dependencyRoot, runtime: "codex", ...overrides });
let testHome;
const priorEnvironment = new Map();
function discoverInventory(home) {
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"),
    META_KIM_PROFILE: "default", META_KIM_RUNTIME_FAMILY: "codex" };
  for (const key of ["Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
  const scan = childProcess.spawnSync(process.execPath, [path.join(repo, "scripts/discover-global-capabilities.mjs"),
    "--runtime-inventory-only", "--targets", "codex", "--json"], { cwd: home, env, encoding: "utf8", timeout: 30000 });
  assert.equal(scan.status, 0, scan.stderr); return env;
}
before(() => {
  if (!dependencyRoot) return;
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "meta-kim-calculation-home-"));
  const env = discoverInventory(testHome);
  for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "META_KIM_PROFILE", "META_KIM_RUNTIME_FAMILY"]) {
    priorEnvironment.set(key, process.env[key]); process.env[key] = env[key];
  }
});
after(() => {
  for (const [key, value] of priorEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
});

test("calculation envelope refuses malformed, oversized and unbound inputs before execution", async () => {
  for (const input of [null, [], {}, { task: "", inputJson: "{}" }, { task: "x", inputJson: "[1]" },
    { task: "x", inputJson: "{" }, { task: "x", inputJson: " ".repeat(262145) }]) {
    const result = await runDependencyCalculation(input ?? {});
    assert.equal(result.status, "invalid_input"); assert.equal(result.toolInvoked, false);
  }
  assert.equal((await runDependencyCalculation({ task, inputJson: "{}", dependencyRoot: "", runtime: "codex" })).code, "explicit_dependency_root_required");
});

test("unbound or blocked routes never launch the calculation process", sourceOptions, async () => {
  const original = childProcess.spawnSync; let toolLaunches = 0;
  childProcess.spawnSync = (command, args, options) => {
    if (args?.includes("--input-json")) { toolLaunches++; throw new Error("Blocked route launched Python"); }
    return original(command, args, options);
  };
  syncBuiltinESMExports();
  const inventory = path.join(testHome, ".meta-kim/state/default/capability-index/global-capabilities.json");
  const savedInventory = fs.readFileSync(inventory);
  try {
    const unbound = await run({ runtime: "" });
    assert.equal(unbound.code, "runtime_binding_required"); assert.equal(unbound.toolInvoked, false);
    const unsupported = await run({ runtime: "cursor" });
    assert.equal(unsupported.code, "route_not_ready_for_host_handoff");
    assert.ok(unsupported.gate.blockedBy.includes("runtime_capability_known_unsupported"));
    const unproven = await run({ task: "Compare these supplier quotes and calculate landed cost and excess quantity; use the supplied constraints and do not place an order." });
    assert.equal(unproven.code, "route_not_ready_for_host_handoff");
    assert.ok(unproven.gate.blockedBy.includes("parallel_lane_safety_not_proven"));
    fs.rmSync(inventory);
    const stale = await run();
    assert.equal(stale.code, "route_not_ready_for_host_handoff");
    assert.ok(stale.gate.blockedBy.includes("global_capability_inventory_refresh_required"));
    assert.equal(stale.toolInvoked, false); assert.equal(toolLaunches, 0);
  } finally {
    fs.writeFileSync(inventory, savedInventory);
    childProcess.spawnSync = original; syncBuiltinESMExports();
  }
});

test("same natural request uses existing route, real Python and usable material comparison without extra choices", sourceOptions, async () => {
  const result = await run();
  assert.equal(result.status, "completed"); assert.equal(result.toolInvoked, true);
  assert.equal(result.route.entryPath, "standard_path"); assert.equal(result.route.owner, "kim-service:supplier-comparison-analyst");
  assert.equal(result.route.source, "existing_execution_route"); assert.deepEqual(result.questions, []);
  assert.equal(result.receipt.ranking, null); assert.equal(result.brief.weights, null);
  assert.deepEqual(result.receipt.normalizedQuotes.map((row) => [row.landedTotal, row.deliveredQuantity, row.excessQuantity]), [["335", "150", "30"], ["275", "120", "0"]]);
  assert.match(result.delivery, /335 CNY/); assert.match(result.delivery, /275 CNY/);
  assert.equal(result.nativeAgentInvocation, false); assert.equal(result.modelSemanticAcceptance, false);
  assert.equal(result.externalActionsPerformed, false); assert.equal(result.execution.kind, "real_python_calculation");
  assert.equal(result.execution.sourceUnchanged, true);
  assert.equal(result.binding.inputSha256, createHash("sha256").update(inputJson()).digest("hex"));
});

test("short ordinary supplier request executes without calculator keyword ceremony", sourceOptions, async () => {
  for (const request of ["帮我比较这几家供应商", "帮我比较材料中的两家采购供应商",
    "Calculate landed cost for these supplied supplier quotes."]) {
    const result = await run({ task: request });
    assert.equal(result.status, "completed", request); assert.equal(result.toolInvoked, true);
    assert.equal(result.route.entryPath, "standard_path"); assert.deepEqual(result.questions, []);
    assert.match(result.delivery, /335 CNY/); assert.match(result.delivery, /275 CNY/);
  }
  assert.equal((await run({ task: "供应商比较是什么意思？" })).code, "request_is_not_execution");
  assert.equal((await run({ task: "What does it mean to compare landed cost?" })).code, "request_is_not_execution");
});

test("changed material quantities and constraints change real calculation rather than fixture constants", sourceOptions, async () => {
  const input = JSON.parse(inputJson()); input.quantity = 121; input.maxLeadDays = 6;
  const result = await run({ task: "帮我比较材料中的采购供应商，按121个需求和6天上限算总支出与超购，不下单。", inputJson: JSON.stringify(input) });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.receipt.normalizedQuotes.map((row) => [row.landedTotal, row.excessQuantity, row.constraintStatus]), [["335", "29", "excluded"], ["320", "19", "eligible"]]);
});

test("only missing essential materials ask one useful question; missing fees remain partial", sourceOptions, async () => {
  const input = JSON.parse(inputJson()); delete input.quantity;
  const pending = await run({ inputJson: JSON.stringify(input) });
  assert.equal(pending.status, "needs_input"); assert.equal(pending.toolInvoked, false);
  assert.deepEqual(pending.missing, ["quantity"]); assert.equal(pending.questions.length, 1);
  input.quantity = 120; delete input.quotes[0].freight;
  const partial = await run({ inputJson: JSON.stringify(input) });
  assert.equal(partial.status, "partial"); assert.equal(partial.toolInvoked, true);
  assert.equal(partial.receipt.normalizedQuotes[0].landedTotal, null);
  assert.match(partial.delivery, /待确认/); assert.equal(partial.receipt.ranking, null);
});

test("absent or empty candidate quotes ask once without performing calculation", sourceOptions, async () => {
  for (const quotes of [undefined, null, []]) {
    const input = JSON.parse(inputJson());
    if (quotes === undefined) delete input.quotes;
    else input.quotes = quotes;
    const pending = await run({ inputJson: JSON.stringify(input) });
    assert.equal(pending.status, "needs_input"); assert.equal(pending.toolInvoked, false);
    assert.deepEqual(pending.missing, ["quotes"]); assert.equal(pending.questions.length, 1);
    assert.match(pending.questions[0], /候选报价/);
  }
});

test("original JSON duplicate keys reach the strict helper and cannot become a successful receipt", sourceOptions, async () => {
  const raw = inputJson().replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1');
  const invalid = await run({ inputJson: raw });
  assert.equal(invalid.status, "invalid_input"); assert.equal(invalid.execution.exitCode, 2);
  assert.equal(invalid.receipt.quality.issues[0].code, "duplicate_json_key");
});

test("missing-value clarification never hides duplicate JSON keys", sourceOptions, async () => {
  const base = inputJson();
  const incomplete = JSON.stringify({ ...JSON.parse(base), quantity: undefined });
  for (const raw of [
    base.replace(/}\s*$/, ',"quotes":[]}'),
    base.replace(/}\s*$/, ',"quotes":null}'),
    base.replace(/}\s*$/, String.raw`,"qu\u006ftes":[]}`),
    incomplete.replace(/}\s*$/, ',"extra":{"nested":1,"nested":2}}'),
  ]) {
    const invalid = await run({ inputJson: raw });
    assert.equal(invalid.status, "invalid_input"); assert.equal(invalid.toolInvoked, true);
    assert.equal(invalid.execution.exitCode, 2);
    assert.equal(invalid.receipt.quality.issues[0].code, "duplicate_json_key");
  }
  const textOnly = JSON.stringify({ ...JSON.parse(base), quotes: [], specification: 'literal {"x":1,"x":2} and escaped \\" quote' });
  const pending = await run({ inputJson: textOnly });
  assert.equal(pending.status, "needs_input"); assert.equal(pending.toolInvoked, false);
  assert.deepEqual(pending.missing, ["quotes"]);
});

test("informational and other-owner tasks cannot use this calculator", sourceOptions, async () => {
  assert.equal((await run({ task: "超购和总支出是什么意思？" })).code, "request_is_not_execution");
  const other = await run({ task: "帮我准备一份四十五分钟的分数教案" });
  assert.equal(other.code, "selected_owner_has_no_reviewed_calculator"); assert.equal(other.toolInvoked, false);
});

test("self-consistent regenerated dependency indexes cannot authorize changed script bytes", sourceOptions, async (t) => {
  for (const scriptName of ["calculate.py", "deliver.py"]) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "meta-kim-calculation-source-"));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(path.join(dependencyRoot, "agents"), path.join(copy, "agents"), { recursive: true });
  fs.mkdirSync(path.join(copy, "generated"));
  const index = JSON.parse(fs.readFileSync(path.join(dependencyRoot, "generated/capabilities.json")));
  const component = path.join(copy, "agents/supplier-comparison-analyst");
  fs.appendFileSync(path.join(component, `scripts/${scriptName}`), "\n# unreviewed replacement\n");
  const changedHash = await componentHash(component);
  index.components.find((item) => item.id === "supplier-comparison-analyst").contentSha256 = changedHash;
  for (const item of index.capabilities.filter((item) => item.componentId === "supplier-comparison-analyst")) item.componentContentSha256 = changedHash;
  fs.writeFileSync(path.join(copy, "generated/capabilities.json"), JSON.stringify(index));
  const rejected = await run({ dependencyRoot: copy });
  assert.equal(rejected.code, "dependency_source_or_route_not_verified"); assert.equal(rejected.toolInvoked, false);
  }
});

test("legacy helper contracts remain discoverable but never bypass missing reviewed delivery support", sourceOptions, async (t) => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "meta-kim-legacy-delivery-"));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(path.join(dependencyRoot, "agents"), path.join(copy, "agents"), { recursive: true });
  fs.mkdirSync(path.join(copy, "generated"));
  const index = JSON.parse(fs.readFileSync(path.join(dependencyRoot, "generated/capabilities.json")));
  const id = "supplier-comparison-analyst", root = path.join(copy, "agents", id);
  const contractPath = path.join(root, "capability.json");
  const contract = JSON.parse(fs.readFileSync(contractPath));
  for (const capability of contract.capabilities) delete capability.deliveryContract;
  fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2) + "\n");
  const contentSha256 = await componentHash(root);
  const contractSha256 = createHash("sha256").update(stableJson(contract)).digest("hex");
  Object.assign(index.components.find((entry) => entry.id === id), { contentSha256, contractSha256 });
  for (const entry of index.capabilities.filter((item) => item.componentId === id)) {
    delete entry.deliveryContract;
    Object.assign(entry, { componentContentSha256: contentSha256, contractSha256 });
  }
  fs.writeFileSync(path.join(copy, "generated/capabilities.json"), JSON.stringify(index));
  const result = await run({ dependencyRoot: copy });
  assert.equal(result.status, "unavailable");
  assert.equal(result.code, "reviewed_delivery_contract_required");
  assert.equal(result.toolInvoked, false);
});

test("real MCP tool call delivers the same calculation without a native Agent or paid model", sourceOptions, async (t) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meta-kim-calculation-mcp-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = discoverInventory(home);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(repo, "scripts/mcp/meta-runtime-server.mjs")], cwd: home, env, stderr: "pipe" });
  const client = new Client({ name: "real-calculation-integration", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert((await client.listTools()).tools.some((tool) => tool.name === "calculate_materials"));
    const response = await client.callTool({ name: "calculate_materials", arguments: { task, inputJson: inputJson(), dependencyRoot } });
    assert.equal(response.isError, undefined);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.status, "completed"); assert.equal(result.toolInvoked, true);
    assert.equal(result.execution.exitCode, 0); assert.match(result.delivery, /275 CNY/);
  } finally { await client.close(); await transport.close(); }
});

test("MCP runtime comes from server configuration, never a default Codex identity", sourceOptions, async (t) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  for (const runtime of [null, "cursor"]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "meta-kim-host-binding-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const env = discoverInventory(home);
    env.META_KIM_RUNTIME_FAMILY = runtime ?? "";
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(repo, "scripts/mcp/meta-runtime-server.mjs")], cwd: home, env, stderr: "pipe" });
    const client = new Client({ name: "runtime-binding-regression", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tool = (await client.listTools()).tools.find((entry) => entry.name === "calculate_materials");
      assert.equal(Object.hasOwn(tool.inputSchema.properties, "runtime"), false);
      const response = await client.callTool({ name: "calculate_materials", arguments: { task, inputJson: inputJson(), dependencyRoot } });
      const result = JSON.parse(response.content[0].text);
      assert.equal(result.toolInvoked, false);
      assert.equal(result.code, runtime ? "route_not_ready_for_host_handoff" : "runtime_binding_required");
      if (runtime) assert.equal(result.route.runtime, runtime);
    } finally { await client.close(); await transport.close(); }
  }
});
