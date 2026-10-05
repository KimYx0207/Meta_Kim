import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { before, after } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";

const dependencyRoot = process.env.META_KIM_TEST_KIM_SERVICE_SOURCE;
const sourceOptions = { skip: !dependencyRoot && "Requires explicitly selected real Kim_Service source", timeout: 120000 };
const repo = fileURLToPath(new URL("../../", import.meta.url));
const task = "帮我复盘这周店铺数据";
let fixture, calculator, runner, handoffApi, bridgeApi, sourceApi, sequence = 0;
before(async () => {
  if (!dependencyRoot) return;
  fixture = createGovernanceRuntimeFixtureScope(null, { graph: true });
  ({ runDependencyCalculation: calculator } = await fixture.import("scripts/governed-execution/dependency-calculation.mjs"));
  ({ runMetaTheoryGovernedExecution: runner } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs"));
  handoffApi = await fixture.import("scripts/governed-execution/dependency-calculation-handoff.mjs");
  bridgeApi = await fixture.import("scripts/governed-execution/stage-runner-bridge.mjs");
  sourceApi = await fixture.import("scripts/dependency-agent-discovery.mjs");
});
after(() => fixture?.cleanup());
const materials = (name = "normal") => JSON.parse(fs.readFileSync(path.join(dependencyRoot,
  `agents/store-performance-analyst/fixtures/${name}.json`), "utf8"));
const run = (input = materials(), overrides = {}) => calculator({ task, inputJson: JSON.stringify(input),
  dependencyRoot, runtime: "codex", osTarget: "linux", ...overrides });
function options(input = materials(), extra = {}) {
  const runId = `store-calculation-${++sequence}`, output = path.join(fixture.root, runId);
  return { task, runId, runtime: "codex", osTarget: "linux", stateDir: output, artifactDir: output,
    dbPath: path.join(output, "runs.sqlite"), projectRoot: fixture.repoRoot, projectCapabilityMutationMode: "read_only",
    dependencyCalculationInput: { inputJson: JSON.stringify(input), dependencyRoot },
    stageRunner: { enabled: true, capacity: 1, durableDbPath: path.join(output, "durable.sqlite"),
      invokeWorker: async () => { throw new Error("Unexpected model/callback call"); } }, ...extra };
}
function captureWorker(captures) {
  return async ({ prompt, packet, env }) => {
    const line = prompt.split("\n").find((value) => value.startsWith("Complete calculation handoff: "));
    assert.ok(line, "selected owner receives the complete handoff");
    captures.push({ context: JSON.parse(line.slice("Complete calculation handoff: ".length)), prompt, packet, env });
    return { status: "pass", outputText: "Callback transport check only; business/model semantics unverified.",
      outputSha256: "a".repeat(64), runtimeProcessInvoked: true, durationMs: 1 };
  };
}

test("ordinary store review discovers the existing owner and runs its actual typed Python receipt", sourceOptions, async () => {
  const result = await run();
  assert.equal(result.status, "completed"); assert.equal(result.toolInvoked, true);
  assert.equal(result.route.owner, "kim-service:store-performance-analyst");
  assert.equal(result.route.entryPath, "standard_path"); assert.equal(result.route.source, "existing_execution_route");
  assert.equal(result.receipt.tool, "store-performance-calculator"); assert.equal(result.receipt.version, "0.2.0");
  assert.equal(Object.hasOwn(result.receipt, "toolVersion"), false);
  assert.deepEqual(result.receipt.calculationTable.map((row) => row.metrics.netRevenue), ["450", "220"]);
  assert.deepEqual(result.receipt.calculationTable.map((row) => row.metrics.contributionAfterListedCosts), ["200", "95"]);
  assert.equal(result.receipt.comparisons[0].deltas.paidOrdersPerVisitorPercent, "-4");
  assert.deepEqual(result.receipt.quality, []); assert.deepEqual(result.questions, []);
  assert.equal(result.brief.scope, "review_supplied_store_rows_only"); assert.equal(result.brief.permitsBusinessChanges, false);
  assert.equal(Object.hasOwn(result.brief, "weights"), false);
  assert.match(result.delivery, /退款净收入 220 CNY/); assert.match(result.delivery, /-4 个百分点/);
  assert.equal(result.nativeAgentInvocation, false); assert.equal(result.modelSemanticAcceptance, false);
  assert.equal(result.externalActionsPerformed, false); assert.equal(result.execution.kind, "real_python_calculation");
  assert.equal(result.binding.inputSha256, createHash("sha256").update(JSON.stringify(materials())).digest("hex"));
  const changed = materials(); Object.assign(changed.rows[1], { visitors: 200, paidOrders: 20, grossRevenue: 1400 });
  const actual = await run(changed);
  assert.equal(actual.receipt.calculationTable[1].metrics.netRevenue, "1380");
  assert.deepEqual(actual.receipt.comparisons[0].revenueDecomposition, {
    trafficEffect: "480", conversionEffect: "240", basketEffect: "200", grossRevenueDelta: "920",
    refundEffect: "10", netRevenueDelta: "930",
  });
});

test("missing costs stay unknown and missing definitions/comparison allow bounded row analysis", sourceOptions, async () => {
  const partial = await run(materials("missing-fields"));
  assert.equal(partial.status, "partial"); assert.equal(partial.toolInvoked, true);
  for (const row of partial.receipt.calculationTable) {
    assert.equal(row.metrics.netRevenue, null); assert.equal(row.metrics.contributionAfterListedCosts, null);
  }
  assert.match(partial.delivery, /所列成本后贡献 未知/); assert.deepEqual(partial.questions, []);
  const rowsOnly = materials(); delete rowsOnly.definitions; delete rowsOnly.comparison;
  const result = await run(rowsOnly);
  assert.equal(result.status, "partial"); assert.deepEqual(result.receipt.comparisons, []);
  assert.ok(result.receipt.quality.some((issue) => issue.code === "missing_definitions"));
  assert.deepEqual(result.questions, []);
});

test("missing rows asks only necessary business materials; protocol errors and oversized store bytes are rejected", sourceOptions, async () => {
  for (const rows of [undefined, null, []]) {
    const result = await run(rows === undefined ? {} : { rows });
    assert.equal(result.status, "needs_input"); assert.equal(result.toolInvoked, false);
    assert.deepEqual(result.missing, ["rows"]); assert.equal(result.questions.length, 1);
    assert.match(result.questions[0], /期间、SKU、渠道/); assert.doesNotMatch(result.questions[0], /schema|版本|权重/iu);
  }
  const malformed = materials(); delete malformed.schemaVersion;
  const invalid = await run(malformed);
  assert.equal(invalid.status, "invalid_input"); assert.equal(invalid.execution.exitCode, 2);
  assert.deepEqual(invalid.questions, []);
  const raw = JSON.stringify(materials());
  const limit = await run(materials(), { inputJson: raw.padEnd(65536) });
  assert.equal(limit.status, "completed");
  const oversized = await run(materials(), { inputJson: raw.padEnd(65537) });
  assert.equal(oversized.status, "invalid_input"); assert.equal(oversized.code, "calculation_materials_size_limit");
  assert.equal(oversized.maxBytes, 65536); assert.equal(oversized.toolInvoked, false);
  const config = options(); config.dependencyCalculationInput.inputJson = raw.padEnd(65537);
  const report = await runner(config);
  assert.equal(report.dependencyCalculationPacket.code, "calculation_materials_size_limit");
  assert.equal(report.dependencyCalculationPacket.maxBytes, 65536);
  assert.equal(report.stageRunnerBridgePacket.status, "blocked");
  const duplicate = await run(materials(), { inputJson: raw.replace(/}$/, ',"rows":[]}') });
  assert.equal(duplicate.status, "invalid_input"); assert.equal(duplicate.toolInvoked, true);
});

test("definition conflicts keep actual per-row metrics and restrictions through the formal owner handoff", sourceOptions, async () => {
  const input = materials("definition-conflict"), captures = [];
  const result = await run(input);
  assert.equal(result.status, "partial");
  assert.equal(result.receipt.calculationTable[1].metrics.paidOrdersPerVisitorPercent, "3.333333");
  assert.equal(result.receipt.comparisons[0].status, "not_comparable");
  assert.equal(Object.hasOwn(result.receipt.comparisons[0], "deltas"), false);
  assert.equal(Object.hasOwn(result.receipt.comparisons[0], "revenueDecomposition"), false);
  assert.match(result.delivery, /不作跨期比较和收入分解/);
  const config = options(input); config.stageRunner.invokeWorker = captureWorker(captures);
  const report = await runner(config);
  assert.equal(report.dependencyCalculationPacket.status, "ready_for_worker");
  assert.equal(report.dependencyCalculationPacket.receiptStatus, "partial");
  assert.deepEqual(report.dependencyCalculationPacket.questions, []);
  assert.ok(report.dependencyCalculationPacket.issues.some((issue) => issue.reasons?.includes("definition_conflict")
    && issue.conflictingFields.includes("visitorBasis")));
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0].context.calculation.receipt, result.receipt);
  assert.match(captures[0].prompt, /拒绝跨期比较和汇总/);
});

test("formal stage runner passes complete materials and receipt to the verified existing store method; resume stays historical", sourceOptions, async () => {
  const input = materials();
  input.rows = Array.from({ length: 20 }, (_, index) => ({ ...input.rows[index % 2], sku: `SKU-${index}` }));
  assert.ok(JSON.stringify(input).length > 2000);
  const captures = [], config = options(input); config.stageRunner.invokeWorker = captureWorker(captures);
  const report = await runner(config);
  assert.equal(report.executionResult.workerExecutionEvidence[0].ownerMethodBinding?.sourceVerified, true,
    "formal route annotation must not invalidate the observed owner method binding");
  assert.equal(report.stageRunnerBridgePacket.status, "pass");
  assert.equal(report.dependencyCalculationPacket.status, "ready_for_worker");
  assert.equal(captures.length, 1);
  const { context, prompt, packet, env } = captures[0];
  assert.equal(context.materials.inputJson, JSON.stringify(input));
  assert.equal(context.calculation.receipt.calculationTable.length, 20);
  assert.ok(JSON.stringify(context.calculation.receipt).length > 2000);
  assert.equal(packet.ownerAgent, "kim-service:store-performance-analyst");
  assert.match(prompt, /selected AGENT.md method and its declared output contract/);
  assert.match(prompt, /dataQuality/); assert.match(prompt, /metricsTable/); assert.match(prompt, /hypotheses/);
  assert.doesNotMatch(prompt, /conditional shortlist|normalized quotes|供应商短名单/iu);
  const plan = await bridgeApi.prepareReadOnlyRuntimeInvocation({ runtime: "claude", workspaceRoot: fixture.repoRoot, packet, prompt, env });
  assert.equal(plan.ownerMethodBinding.sourceVerified, true);
  assert.deepEqual(JSON.parse(plan.args[plan.args.indexOf("--agents") + 1])["store-performance-analyst"].tools, ["Read"]);
  assert.deepEqual(packet.ownerContract.input.required, ["metrics"]);
  assert.equal(packet.ownerContract.output.deliveryFormat, "conceptual-human-delivery");
  assert.equal(report.dependencyCalculationPacket.nativeAgentInvocation, false);
  assert.equal(report.stageRunnerBridgePacket.executionProjection.invocationTruth.nativeRuntimeInvoked, false);
  assert.equal(report.executionResult.actualWorkerExecution, false);
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, opts) => {
    if (args?.includes("--input-json")) throw new Error("Materialized resume must not recalculate");
    return original(command, args, opts);
  }; syncBuiltinESMExports();
  try {
    const resumed = await runner({ ...config, stageRunner: { ...config.stageRunner, durableMode: "resume" } });
    assert.equal(captures.length, 1); assert.equal(resumed.dependencyCalculationPacket.toolInvoked, false);
    assert.equal(resumed.dependencyCalculationPacket.priorToolInvoked, true);
    assert.equal(resumed.dependencyCalculationPacket.observationScope, "historical_materialized_run");
    const changed = structuredClone(input); changed.rows[0].grossRevenue++;
    await assert.rejects(runner({ ...config, dependencyCalculationInput: { inputJson: JSON.stringify(changed), dependencyRoot },
      stageRunner: { ...config.stageRunner, durableMode: "resume" } }), /fingerprint|identity/iu);
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});

test("unavailable Python permits explicitly uncomputed owner analysis, while fabricated receipts fail closed", sourceOptions, async () => {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, opts) => args?.includes("--input-json")
    ? original(path.join(fixture.root, "missing-python"), args, opts) : original(command, args, opts);
  syncBuiltinESMExports();
  try {
    const captures = [], config = options(); config.stageRunner.invokeWorker = captureWorker(captures);
    const report = await runner(config);
    assert.equal(report.dependencyCalculationPacket.status, "ready_for_worker");
    assert.equal(captures[0].context.calculation.code, "calculation_process_failed");
    assert.equal(captures[0].context.calculation.toolInvoked, false); assert.equal(captures[0].context.calculation.receipt, null);
    assert.match(captures[0].prompt, /工具不可用/);
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
  for (const mutate of [
    (receipt) => { receipt.version = "9.9.9"; },
    (receipt) => { receipt.tool = "supplier-comparison-calculate"; },
    (receipt) => { receipt.quality = { issues: [] }; },
    (receipt) => { receipt.calculationTable[0].sku = "unbound-sku"; },
    (receipt) => { delete receipt.comparisons[0].deltas; },
    (receipt) => { receipt.calculationTable[0].metrics.netRevenue = 450; },
  ]) {
    childProcess.spawnSync = (command, args, opts) => {
      const executed = original(command, args, opts);
      if (!args?.includes("--input-json")) return executed;
      const receipt = JSON.parse(executed.stdout); mutate(receipt.receipt);
      return { ...executed, stdout: JSON.stringify(receipt) };
    }; syncBuiltinESMExports();
    try {
      const rejected = await run();
      assert.equal(rejected.status, "failed"); assert.equal(rejected.code, "calculation_receipt_or_source_changed");
    } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
  }
  const supplied = materials(); supplied.calculationReceipt = { status: "completed", tool: "store-performance-calculator" };
  const report = await runner(options(supplied));
  assert.equal(report.dependencyCalculationPacket.status, "invalid_input");
  assert.equal(report.stageRunnerBridgePacket.status, "blocked");
});

test("altered source and route, owner or receipt handoff bindings cannot gain execution authority", sourceOptions, async () => {
  const copy = path.join(fixture.root, "changed-service");
  fs.cpSync(path.join(dependencyRoot, "agents"), path.join(copy, "agents"), { recursive: true });
  fs.mkdirSync(path.join(copy, "generated"));
  const index = JSON.parse(fs.readFileSync(path.join(dependencyRoot, "generated/capabilities.json")));
  const component = path.join(copy, "agents/store-performance-analyst");
  fs.appendFileSync(path.join(component, "scripts/calculate.py"), "\n# unreviewed change\n");
  const changedHash = await sourceApi.componentHash(component);
  index.components.find((entry) => entry.id === "store-performance-analyst").contentSha256 = changedHash;
  for (const entry of index.capabilities.filter((entry) => entry.componentId === "store-performance-analyst")) entry.componentContentSha256 = changedHash;
  fs.writeFileSync(path.join(copy, "generated/capabilities.json"), JSON.stringify(index));
  const changedSource = await run(materials(), { dependencyRoot: copy });
  assert.equal(changedSource.code, "dependency_source_or_route_not_verified"); assert.equal(changedSource.toolInvoked, false);
  const config = options(materials(), { stageRunner: null }), planned = await runner(config);
  const request = handoffApi.prepareDependencyCalculationInput({ input: config.dependencyCalculationInput, task });
  const args = { request, runId: config.runId, runtime: "codex", osTarget: "linux", route: planned.selectedExecutionRoute,
    workerTaskPackets: planned.workerTaskPackets, environment: { ...process.env, META_KIM_KIM_SERVICE_ROOT: dependencyRoot } };
  const rejectedRoute = structuredClone(args.route); rejectedRoute.routeExecutionGate.canHandoffToHost = false;
  assert.equal((await handoffApi.prepareDependencyCalculationHandoff({ ...args, route: rejectedRoute })).summary.code, "calculation_route_not_ready");
  const badPackets = structuredClone(args.workerTaskPackets); badPackets[0].ownerContract.contentDigest = "a".repeat(64);
  assert.equal((await handoffApi.prepareDependencyCalculationHandoff({ ...args, workerTaskPackets: badPackets })).summary.code, "calculation_owner_source_rejected");
  const prepared = await handoffApi.prepareDependencyCalculationHandoff(args);
  assert.equal(prepared.summary.status, "ready_for_worker");
  const packet = planned.workerTaskPackets.find((entry) => entry.taskPacketId === prepared.handoff.taskPacketId);
  for (const extra of [{ handoff: structuredClone(prepared.handoff) }, { requestTask: `${task}changed` },
    { packet: { ...packet, ownerAgent: "kim-service:supplier-comparison-analyst" } }]) {
    assert.throws(() => handoffApi.calculationHandoffForWorker({ handoff: prepared.handoff, runId: config.runId,
      runtime: "codex", requestTask: task, packet, ...extra }), /calculation_handoff_/u);
  }
  prepared.handoff.calculation.receipt.calculationTable[0].metrics.netRevenue = "0";
  assert.throws(() => handoffApi.calculationHandoffForWorker({ handoff: prepared.handoff, runId: config.runId,
    runtime: "codex", requestTask: task, packet }), /calculation_handoff_binding_rejected/u);
});

test("real MCP calculate_materials exposes and executes store inputs without a paid model or native Agent claim", sourceOptions, async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(repo, "scripts/mcp/meta-runtime-server.mjs")], cwd: fixture.home,
    env: { ...fixture.env, META_KIM_RUNTIME_FAMILY: "codex" }, stderr: "pipe" });
  const client = new Client({ name: "store-calculation-integration", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "calculate_materials");
    assert.match(tool.description, /所选能力合同/); assert.equal(Object.hasOwn(tool.inputSchema.properties, "runtime"), false);
    const response = await client.callTool({ name: "calculate_materials", arguments: { task, inputJson: JSON.stringify(materials()), dependencyRoot } });
    assert.equal(response.isError, undefined);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.status, "completed"); assert.equal(result.execution.exitCode, 0);
    assert.equal(result.receipt.calculationTable[1].metrics.netRevenue, "220");
    assert.equal(result.nativeAgentInvocation, false); assert.equal(result.modelSemanticAcceptance, false);
  } finally { await client.close(); await transport.close(); }
});
