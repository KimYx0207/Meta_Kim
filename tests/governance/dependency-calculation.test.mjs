import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runDependencyCalculation } from "../../scripts/governed-execution/dependency-calculation.mjs";
import { componentHash } from "../../scripts/dependency-agent-discovery.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const dependencyRoot = process.env.META_KIM_TEST_KIM_SERVICE_SOURCE;
const task = "帮我比较材料中的两家采购供应商：120个同规格白色M号纸袋，CNY，最长8天到货；算到货总支出和超购，保留质量证据缺口，不设默认权重，不联系供应商或下单。";
const sourceOptions = { skip: !dependencyRoot && "Requires explicitly selected real Kim_Service source", timeout: 45000 };
const inputJson = () => fs.readFileSync(path.join(dependencyRoot, "agents/supplier-comparison-analyst/tests/fixtures/normal.json"), "utf8");
const run = (overrides = {}) => runDependencyCalculation({ task, inputJson: inputJson(), dependencyRoot, ...overrides });

test("calculation envelope refuses malformed, oversized and unbound inputs before execution", async () => {
  for (const input of [null, [], {}, { task: "", inputJson: "{}" }, { task: "x", inputJson: "[1]" },
    { task: "x", inputJson: "{" }, { task: "x", inputJson: " ".repeat(262145) }]) {
    const result = await runDependencyCalculation(input ?? {});
    assert.equal(result.status, "invalid_input"); assert.equal(result.toolInvoked, false);
  }
  assert.equal((await runDependencyCalculation({ task, inputJson: "{}", dependencyRoot: "" })).code, "explicit_dependency_root_required");
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
    "Compare these supplier quotes and calculate landed cost and excess quantity; use the supplied constraints and do not place an order."]) {
    const result = await run({ task: request });
    assert.equal(result.status, "completed", request); assert.equal(result.toolInvoked, true);
    assert.equal(result.route.entryPath, "standard_path"); assert.deepEqual(result.questions, []);
    assert.match(result.delivery, /335 CNY/); assert.match(result.delivery, /275 CNY/);
  }
  assert.equal((await run({ task: "供应商比较是什么意思？" })).code, "request_is_not_execution");
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

test("original JSON duplicate keys reach the strict helper and cannot become a successful receipt", sourceOptions, async () => {
  const raw = inputJson().replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1');
  const invalid = await run({ inputJson: raw });
  assert.equal(invalid.status, "invalid_input"); assert.equal(invalid.execution.exitCode, 2);
  assert.equal(invalid.receipt.quality.issues[0].code, "duplicate_json_key");
});

test("informational and other-owner tasks cannot use this calculator", sourceOptions, async () => {
  assert.equal((await run({ task: "超购和总支出是什么意思？" })).code, "request_is_not_execution");
  const other = await run({ task: "帮我准备一份四十五分钟的分数教案" });
  assert.equal(other.code, "selected_owner_has_no_reviewed_calculator"); assert.equal(other.toolInvoked, false);
});

test("self-consistent regenerated dependency indexes cannot authorize changed script bytes", sourceOptions, async (t) => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "meta-kim-calculation-source-"));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(path.join(dependencyRoot, "agents"), path.join(copy, "agents"), { recursive: true });
  fs.mkdirSync(path.join(copy, "generated"));
  const index = JSON.parse(fs.readFileSync(path.join(dependencyRoot, "generated/capabilities.json")));
  const component = path.join(copy, "agents/supplier-comparison-analyst");
  fs.appendFileSync(path.join(component, "scripts/calculate.py"), "\n# unreviewed replacement\n");
  const changedHash = await componentHash(component);
  index.components.find((item) => item.id === "supplier-comparison-analyst").contentSha256 = changedHash;
  for (const item of index.capabilities.filter((item) => item.componentId === "supplier-comparison-analyst")) item.componentContentSha256 = changedHash;
  fs.writeFileSync(path.join(copy, "generated/capabilities.json"), JSON.stringify(index));
  const rejected = await run({ dependencyRoot: copy });
  assert.equal(rejected.code, "dependency_source_or_route_not_verified"); assert.equal(rejected.toolInvoked, false);
});

test("real MCP tool call delivers the same calculation without a native Agent or paid model", sourceOptions, async (t) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "meta-kim-calculation-mcp-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) if (process.env[key]) env[key] = process.env[key];
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
