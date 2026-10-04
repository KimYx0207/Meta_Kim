import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test, { before, after } from "node:test";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { readDependencyCalculationInputFile } from "../../scripts/governed-execution/dependency-calculation-handoff.mjs";

const dependencyRoot = process.env.META_KIM_TEST_KIM_SERVICE_SOURCE;
const sourceOptions = { skip: !dependencyRoot && "Requires explicitly selected real Kim_Service source", timeout: 120000 };
const task = "帮我比较采购报价";
let fixture, runner, handoffApi, bridgeApi;
let sequence = 0;
before(async () => {
  if (!dependencyRoot) return;
  fixture = createGovernanceRuntimeFixtureScope(null, { graph: true });
  ({ runMetaTheoryGovernedExecution: runner } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs"));
  handoffApi = await fixture.import("scripts/governed-execution/dependency-calculation-handoff.mjs");
  bridgeApi = await fixture.import("scripts/governed-execution/stage-runner-bridge.mjs");
});
after(() => fixture?.cleanup());
const materials = () => JSON.parse(fs.readFileSync(path.join(dependencyRoot, "agents/supplier-comparison-analyst/tests/fixtures/normal.json"), "utf8"));
function options(input = materials(), extra = {}) {
  const runId = `calculation-handoff-${++sequence}`;
  const output = path.join(fixture.root, runId);
  return { task, runId, runtime: "codex", osTarget: "linux", stateDir: output, artifactDir: output,
    dbPath: path.join(output, "runs.sqlite"), projectRoot: fixture.repoRoot, projectCapabilityMutationMode: "read_only",
    dependencyCalculationInput: { inputJson: JSON.stringify(input), dependencyRoot },
    stageRunner: { enabled: true, capacity: 1, durableDbPath: path.join(output, "durable.sqlite"),
      invokeWorker: async () => { throw new Error("Unexpected model/callback call"); } }, ...extra };
}
function captureWorker(captures) {
  return async ({ prompt, packet, env }) => {
    const line = prompt.split("\n").find((value) => value.startsWith("Complete calculation handoff: "));
    assert.ok(line, "selected worker receives structured handoff");
    const context = JSON.parse(line.slice("Complete calculation handoff: ".length));
    captures.push({ context, prompt, packet, env });
    return { status: "pass", outputText: "Callback transport check only; business/model semantics unverified.",
      outputSha256: "a".repeat(64), runtimeProcessInvoked: true, durationMs: 1 };
  };
}

test("material reader keeps bounded UTF-8 regular-file behavior and returns concise file errors", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "calculation-reader-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "materials.json");
  const content = '{"note":"甲"}'; fs.writeFileSync(filename, content);
  assert.deepEqual(await readDependencyCalculationInputFile(filename), { inputJson: content });
  assert.equal((await readDependencyCalculationInputFile(root)).error.code, "calculation_materials_file_required");
  const missing = await readDependencyCalculationInputFile(path.join(root, "missing"));
  assert.equal(missing.error.code, "calculation_materials_file_unreadable");
  assert.equal(missing.error.fileError, "ENOENT");
  assert.equal(JSON.stringify(missing).includes(root), false);
  const open = fs.promises.open;
  fs.promises.open = async () => { throw Object.assign(new Error("private path must not leak"), { code: "EACCES" }); };
  try {
    const denied = await readDependencyCalculationInputFile(filename);
    assert.equal(denied.error.code, "calculation_materials_file_unreadable");
    assert.equal(denied.error.fileError, "EACCES");
    assert.equal(JSON.stringify(denied).includes("private path"), false);
  } finally { fs.promises.open = open; }
  fs.writeFileSync(filename, "x".repeat(262144));
  assert.equal((await readDependencyCalculationInputFile(filename)).inputJson.length, 262144);
  fs.appendFileSync(filename, "x");
  assert.equal((await readDependencyCalculationInputFile(filename)).error.code, "calculation_materials_size_limit");
  fs.writeFileSync(filename, Buffer.from([0xc3, 0x28]));
  assert.equal((await readDependencyCalculationInputFile(filename)).error.code, "calculation_materials_invalid_utf8");
});

test("POSIX material reader rejects FIFO and check/open FIFO substitution without blocking; regular symlinks still work", {
  skip: !["linux", "darwin"].includes(process.platform), timeout: 15000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "calculation-reader-fifo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "materials.json"), fifo = path.join(root, "fifo"), link = path.join(root, "link");
  fs.writeFileSync(filename, "{}"); fs.symlinkSync(filename, link);
  assert.deepEqual(await readDependencyCalculationInputFile(link), { inputJson: "{}" });
  const created = childProcess.spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const moduleUrl = new URL("../../scripts/governed-execution/dependency-calculation-handoff.mjs", import.meta.url).href;
  for (const replaceAfterStat of [false, true]) {
    const child = childProcess.spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { promises as fs, unlinkSync, renameSync } from "node:fs";
      import { readDependencyCalculationInputFile } from ${JSON.stringify(moduleUrl)};
      const filename = process.argv[1], fifo = process.argv[2];
      if (${replaceAfterStat}) {
        const open = fs.open.bind(fs);
        fs.open = async (...args) => { unlinkSync(filename); renameSync(fifo, filename); return open(...args); };
      }
      process.stdout.write(JSON.stringify(await readDependencyCalculationInputFile(${replaceAfterStat ? "filename" : "fifo"})));
    `, filename, fifo], { encoding: "utf8", timeout: 3000 });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    assert.equal(JSON.parse(child.stdout).error.code, "calculation_materials_file_required");
  }
});

test("formal entry passes complete >2000-character materials and real receipt to selected source owner without extra confirmation", sourceOptions, async () => {
  const input = materials();
  input.quotes[0].qualityEvidence = "甲".repeat(1900) + "END_A";
  input.quotes[1].qualityEvidence = "乙".repeat(1900) + "END_B";
  const captures = [];
  const config = options(input); config.stageRunner.invokeWorker = captureWorker(captures);
  const report = await runner(config);
  assert.equal(report.dependencyCalculationPacket.status, "ready_for_worker", JSON.stringify({calculation: report.dependencyCalculationPacket, failure: report.stageRunnerBridgePacket.failure}));
  assert.equal(report.stageRunnerBridgePacket.status, "pass", JSON.stringify(report.stageRunnerBridgePacket.failure));
  assert.equal(report.preDecisionOptionFrame.planChallengeState.active, false);
  assert.equal(report.preDecisionOptionFrame.planChallengeState.authorizationRequired, false);
  assert.equal(report.dependencyCalculationPacket.toolInvoked, true);
  assert.equal(captures.length, 1);
  const { context, prompt, packet } = captures[0];
  assert.equal(context.materials.inputJson, JSON.stringify(input));
  assert.ok(JSON.stringify(context.calculation.receipt).length > 2000);
  assert.equal(context.calculation.receipt.normalizedQuotes[1].qualityEvidence, input.quotes[1].qualityEvidence);
  assert.equal(context.calculation.receipt.normalizedQuotes[0].landedTotal, "335");
  assert.equal(context.calculation.evidence, "current_source_verified_helper_result");
  assert.equal(context.materials.trust, "unverified_host_supplied_materials");
  assert.equal(packet.ownerAgent, "kim-service:supplier-comparison-analyst");
  assert.match(prompt, /条件短名单/);
  assert.equal(report.dependencyCalculationPacket.nativeAgentInvocation, false);
  assert.equal(report.dependencyCalculationPacket.modelSemanticAcceptance, false);
  assert.equal(report.stageRunnerBridgePacket.executionProjection.invocationTruth.nativeRuntimeInvoked, false);
  assert.equal(report.executionResult.actualWorkerExecution, false);
  assert.equal(JSON.stringify(report).includes(input.quotes[1].qualityEvidence), false, "raw materials are not published in artifacts");
  assert.equal(report.workerTaskPackets[0].ownerContract.sideEffects.length, 0);
  const plan = await bridgeApi.prepareReadOnlyRuntimeInvocation({ runtime: "claude", workspaceRoot: fixture.repoRoot,
    packet, prompt, env: captures[0].env });
  assert.equal(plan.ownerMethodBinding.sourceVerified, true);
  assert.deepEqual(JSON.parse(plan.args[plan.args.indexOf("--agents") + 1])["supplier-comparison-analyst"].tools, ["Read"]);
  const originalSpawn = childProcess.spawnSync; let resumePythonCalls = 0;
  childProcess.spawnSync = (command, args, opts) => {
    if (args?.includes("--input-json")) { resumePythonCalls++; throw new Error("Materialized resume invoked helper"); }
    return originalSpawn(command, args, opts);
  }; syncBuiltinESMExports();
  let resumed;
  try { resumed = await runner({ ...config, stageRunner: { ...config.stageRunner, durableMode: "resume" } }); }
  finally { childProcess.spawnSync = originalSpawn; syncBuiltinESMExports(); }
  assert.equal(resumePythonCalls, 0);
  assert.equal(captures.length, 1, "materialized resume does not invoke helper/worker again");
  assert.equal(resumed.dependencyCalculationPacket.toolInvoked, false);
  assert.equal(resumed.dependencyCalculationPacket.priorToolInvoked, true);
  assert.equal(resumed.dependencyCalculationPacket.observationScope, "historical_materialized_run");
  const changed = structuredClone(input); changed.quantity = 121;
  await assert.rejects(runner({ ...config, dependencyCalculationInput: { inputJson: JSON.stringify(changed), dependencyRoot },
    stageRunner: { ...config.stageRunner, durableMode: "resume" } }), /fingerprint|identity/iu);
});

test("complete payload size limit fails explicitly after a real receipt, never truncates into worker", sourceOptions, async () => {
  const input = materials(); input.specification = "s".repeat(256);
  input.quotes = Array.from({ length: 100 }, (_, index) => ({ ...input.quotes[0],
    supplierId: `${index}`.padEnd(64, "x"), specification: input.specification,
    qualityEvidence: "x".repeat(1980) }));
  assert.ok(Buffer.byteLength(JSON.stringify(input)) <= 262144);
  const report = await runner(options(input));
  assert.equal(report.dependencyCalculationPacket.code, "calculation_handoff_size_limit");
  assert.equal(report.dependencyCalculationPacket.toolInvoked, true);
  assert.equal(report.dependencyCalculationPacket.receiptStatus, "completed");
  assert.equal(report.stageRunnerBridgePacket.status, "blocked");
});

test("handoff clones, altered bindings and unverified owner contracts cannot invoke worker/helper", sourceOptions, async () => {
  const config = options(materials(), { stageRunner: null });
  const planned = await runner(config);
  const request = handoffApi.prepareDependencyCalculationInput({ input: config.dependencyCalculationInput, task });
  const environment = { ...process.env, META_KIM_KIM_SERVICE_ROOT: dependencyRoot };
  const args = { request, runId: config.runId, runtime: "codex", osTarget: "linux",
    route: planned.selectedExecutionRoute, workerTaskPackets: planned.workerTaskPackets, environment };
  const prepared = await handoffApi.prepareDependencyCalculationHandoff(args);
  assert.equal(prepared.summary.status, "ready_for_worker");
  const packet = planned.workerTaskPackets.find((value) => value.taskPacketId === prepared.handoff.taskPacketId);
  const original = childProcess.spawnSync; let pythonCalls = 0;
  childProcess.spawnSync = (command, argv, opts) => {
    if (argv?.includes("--input-json")) { pythonCalls++; throw new Error("Rejected binding executed helper"); }
    return original(command, argv, opts);
  }; syncBuiltinESMExports();
  try {
    const badPackets = structuredClone(planned.workerTaskPackets); badPackets[0].ownerContract.contentDigest = "a".repeat(64);
    const denied = await handoffApi.prepareDependencyCalculationHandoff({ ...args, workerTaskPackets: badPackets });
    assert.equal(denied.summary.code, "calculation_owner_source_rejected");
    for (const overrides of [{ handoff: structuredClone(prepared.handoff) }, { requestTask: `${task}changed` },
      { runtime: "claude" }, { packet: { ...packet, ownerAgent: "unbound-owner" } }]) {
      assert.throws(() => handoffApi.calculationHandoffForWorker({ handoff: prepared.handoff, runId: config.runId,
        runtime: "codex", requestTask: task, packet, ...overrides }), /calculation_handoff_/u);
    }
    let workerCalls = 0;
    const forged = await bridgeApi.runStageRunnerBridge({ runId: config.runId, runtime: "codex",
      stageDagPacket: planned.coreLoop.stageDagPacket, workerTaskPackets: planned.workerTaskPackets,
      workspaceRoot: fixture.repoRoot, requestTask: task, workerEnv: environment,
      dependencyCalculationHandoff: structuredClone(prepared.handoff),
      invokeWorker: async () => { workerCalls++; return { status: "pass" }; } });
    assert.equal(forged.status, "failed"); assert.equal(workerCalls, 0); assert.equal(pythonCalls, 0);
    prepared.handoff.calculation.receipt.normalizedQuotes[0].landedTotal = "0";
    assert.throws(() => handoffApi.calculationHandoffForWorker({ handoff: prepared.handoff, runId: config.runId,
      runtime: "codex", requestTask: task, packet }), /calculation_handoff_binding_rejected/u);
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});

test("changed quantities and partial fees reach the real helper and worker", sourceOptions, async () => {
  const input = materials(); input.quantity = 121; input.maxLeadDays = 6; delete input.quotes[1].freight;
  const captures = []; const config = options(input); config.stageRunner.invokeWorker = captureWorker(captures);
  const report = await runner(config);
  assert.equal(report.dependencyCalculationPacket.receiptStatus, "partial");
  const rows = captures[0].context.calculation.receipt.normalizedQuotes;
  assert.equal(rows[0].excessQuantity, "29"); assert.equal(rows[0].constraintStatus, "excluded");
  assert.equal(rows[1].excessQuantity, "19"); assert.equal(rows[1].landedTotal, null);
});

test("missing materials, conflicts and forged receipt content cannot launch a worker", sourceOptions, async () => {
  const missing = materials(); delete missing.quantity;
  const pending = await runner(options(missing));
  assert.equal(pending.dependencyCalculationPacket.status, "needs_input");
  assert.deepEqual(pending.dependencyCalculationPacket.missing, ["quantity"]);
  assert.equal(pending.dependencyCalculationPacket.questions.length, 1);
  assert.equal(pending.dependencyCalculationPacket.toolInvoked, false);
  for (const mutate of [
    (input) => { input.quotes[1].currency = "USD"; },
    (input) => { input.receipt = { toolInvoked: true, status: "completed" }; },
  ]) {
    const input = materials(); mutate(input);
    const report = await runner(options(input));
    assert.equal(report.stageRunnerBridgePacket.status, "blocked");
    assert.notEqual(report.dependencyCalculationPacket.status, "ready_for_worker");
    assert.ok(report.dependencyCalculationPacket.issues.length > 0);
    if (input.quotes[1].currency === "USD") {
      assert.equal(report.dependencyCalculationPacket.code, "calculation_definition_conflict");
      assert.equal(report.dependencyCalculationPacket.questions.length, 1);
      assert.match(report.dependencyCalculationPacket.questions[0], /币种/u);
    }
  }
});

test("route rejection, input limit and runtime binding reject before Python/model execution", sourceOptions, async () => {
  const original = childProcess.spawnSync; let pythonCalls = 0, workerCalls = 0;
  childProcess.spawnSync = (command, args, opts) => {
    if (args?.includes("--input-json")) { pythonCalls++; throw new Error("Python must not execute"); }
    return original(command, args, opts);
  }; syncBuiltinESMExports();
  try {
    for (const config of [
      options(materials(), { task: "帮我比较采购报价，然后购买这批货物。" }),
      options(materials(), { task: "Compare these supplier quotes and calculate landed cost and excess quantity; use the supplied constraints and do not place an order." }),
      options(materials(), { dependencyCalculationInput: { inputJson: "甲".repeat(90000), dependencyRoot } }),
      (() => { const config = options(); config.stageRunner.runtime = "claude"; return config; })(),
      options(materials(), { dependencyCalculationInput: { inputJson: JSON.stringify(materials()), dependencyRoot, receipt: {} } }),
    ]) {
      config.stageRunner.invokeWorker = async () => { workerCalls++; throw new Error("Blocked route must not invoke worker"); };
      const report = await runner(config);
      assert.equal(report.stageRunnerBridgePacket.status, "blocked");
      assert.equal(report.dependencyCalculationPacket.toolInvoked, false);
      if (config.task.includes("然后购买")) {
        assert.equal(report.preDecisionOptionFrame.planChallengeState.authorizationRequired, true);
      }
    }
    assert.equal(pythonCalls, 0);
    assert.equal(workerCalls, 0);
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});

test("real Python launch unavailable reaches owner as explicitly uncomputed materials", sourceOptions, async () => {
  const original = childProcess.spawnSync;
  childProcess.spawnSync = (command, args, opts) => args?.includes("--input-json")
    ? original(path.join(fixture.root, "missing-python"), args, opts) : original(command, args, opts);
  syncBuiltinESMExports();
  try {
    const captures = []; const config = options(); config.stageRunner.invokeWorker = captureWorker(captures);
    const report = await runner(config);
    assert.equal(report.dependencyCalculationPacket.status, "ready_for_worker");
    assert.equal(captures[0].context.calculation.code, "calculation_process_failed");
    assert.equal(captures[0].context.calculation.toolInvoked, false);
    assert.equal(captures[0].context.calculation.receipt, null);
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});

test("CLI material flag reaches existing gate and bounded reads reject oversized bytes", sourceOptions, async () => {
  const input = materials(); delete input.quantity;
  const inputPath = path.join(fixture.root, "materials.json"); fs.writeFileSync(inputPath, JSON.stringify(input));
  const output = path.join(fixture.root, "cli");
  const result = fixture.run(["scripts/run-meta-theory-governed-execution.mjs", "--calculation-materials", inputPath,
    task, "--run-id", "cli-calculation", "--state-dir", output, "--artifact-dir", output,
    "--db", path.join(output, "runs.sqlite"), "--runtime", "codex", "--os", "linux", "--execute-stage-dag"],
  { env: { ...fixture.env, META_KIM_KIM_SERVICE_ROOT: dependencyRoot } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dependencyCalculation.status, "needs_input");
  assert.equal(report.stageRunner.status, "blocked");
  fs.writeFileSync(inputPath, "甲".repeat(90000));
  const oversized = fixture.run(["scripts/run-meta-theory-governed-execution.mjs", "--calculation-materials", inputPath, "--task", task, "--temp-output"]);
  assert.equal(oversized.status, 1);
  assert.equal(JSON.parse(oversized.stdout).dependencyCalculationPacket.code, "calculation_materials_size_limit");
});
