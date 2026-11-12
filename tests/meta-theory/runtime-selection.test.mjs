import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadFormalToolProfiles, normalizePlanningRuntime, resolvePlanningRuntime } from "../../scripts/runtime-tool-profiles.mjs";
import { normalizeStageRunnerRuntime, prepareReadOnlyRuntimeInvocation } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { createLiveRuntimeAdapterRegistry, SUPPORTED_LIVE_RUNTIME_IDS } from "../../src/infrastructure/live/live-runtime-adapter-registry.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { fixtureCritical } from "../helpers/host-reasoning-fixture.mjs";
import { localProtocolFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

test("planning selection follows explicit configuration and observed host, with a labeled single configured default", () => {
  const policy = JSON.parse(readFileSync(new URL("../../config/contracts/runtime-priority-and-compatibility-contract.json", import.meta.url), "utf8"));
  const defaultChoice = resolvePlanningRuntime();
  assert.equal(defaultChoice.runtime, normalizePlanningRuntime(policy.selectionPolicy.defaultPlanningRuntime));
  assert.equal(defaultChoice.source, "configured_default");
  assert.equal(defaultChoice.observedHost.runtime, "unavailable");
  assert.ok(defaultChoice.configurationRef.endsWith("#selectionPolicy.defaultPlanningRuntime"));
  assert.equal(resolvePlanningRuntime({ hostRuntime: "claude", hostBasis: "host_env_marker" }).runtime, "claude_code");
  assert.equal(resolvePlanningRuntime({ hostRuntime: "claude", hostBasis: "host_env_marker" }).source, "observed_host");
  assert.equal(resolvePlanningRuntime({ requestedRuntime: "zcode", configuredRuntime: "invalid/value", hostRuntime: "claude" }).runtime, "zcode");
  assert.equal(resolvePlanningRuntime({ configuredRuntime: "gemini", hostRuntime: "claude" }).source, "configured_environment");
  const unknown = resolvePlanningRuntime({ requestedRuntime: "minimax-code", hostRuntime: "codex" });
  assert.equal(unknown.runtime, "minimax-code");
  assert.equal(unknown.source, "explicit_runtime");
  assert.equal(unknown.formalProfileAvailable, false);
  const conflict = resolvePlanningRuntime({ hostRuntime: "unavailable", hostBasis: "conflicting_host_env_markers" });
  assert.equal(conflict.source, "configured_default");
  assert.equal(conflict.observedHost.basis, "conflicting_host_env_markers");
});

test("native invocation uses the exact explicit model argument and never claims the provider served it", async () => {
  const model = "MiniMax-M3.1-Flash[1m]";
  for (const runtime of ["codex", "claude"]) {
    const common = { runtime, workspaceRoot: process.cwd(), packet: null, prompt: "Read-only bounded task", env: {} };
    const implicit = await prepareReadOnlyRuntimeInvocation(common);
    assert.equal(implicit.args.includes("--model"), false);
    assert.equal(implicit.modelSelection.requested, null);
    assert.equal(implicit.modelSelection.observed, null);
    const explicit = await prepareReadOnlyRuntimeInvocation({ ...common, model });
    assert.equal(explicit.args[explicit.args.indexOf("--model") + 1], model);
    assert.equal(explicit.modelSelection.requested, model);
    assert.equal(explicit.modelSelection.applied, null, "a prepared argv is not an invocation");
    assert.equal(explicit.modelSelection.observationStatus, "not_observed");
    if (runtime === "codex") assert.ok(explicit.args.includes("--ignore-user-config"));
    for (const invalid of ["", "a\nmodel", "two models", "--other-flag", "x".repeat(201)]) {
      await assert.rejects(prepareReadOnlyRuntimeInvocation({ ...common, model: invalid }), /bounded model identifier/);
    }
  }
  assert.throws(() => normalizeStageRunnerRuntime("gemini"), /Unsupported/);
  assert.throws(() => normalizeStageRunnerRuntime("minimax-code"), /Unsupported/);
});

test("formal injected clients keep their registry boundary and require declared explicit model support", async () => {
  for (const profile of loadFormalToolProfiles()) assert.ok(SUPPORTED_LIVE_RUNTIME_IDS.includes(profile.id));
  const received = [];
  const registry = createLiveRuntimeAdapterRegistry({ adapters: [
    { adapterId: "host-gemini", runtime: "gemini", capabilities: ["handoff"], modelSelectionSupported: true,
      execute: async request => { received.push(request); return { fixtureOnly: true }; } },
    { adapterId: "host-zcode", runtime: "zcode", capabilities: ["handoff"], execute: async request => { received.push(request); return {}; } },
  ] });
  const model = "provider/Model[1m]";
  const result = await registry.invoke("host-gemini", { action: "handoff", runtime: "gemini", model });
  assert.equal(received[0].model, model);
  assert.equal(result.modelSelection.requested, model);
  assert.equal(result.modelSelection.applied, model);
  assert.equal(result.modelSelection.observed, null);
  await assert.rejects(registry.invoke("host-zcode", { action: "handoff", runtime: "zcode", model }), /does not declare support/);
  assert.equal(received.length, 1, "unsupported explicit model must not invoke a substitute");
  await assert.rejects(registry.invoke("host-gemini", { action: "handoff", runtime: "codex" }), /does not match/);
  assert.throws(() => createLiveRuntimeAdapterRegistry({ adapters: [{ adapterId: "unverified", runtime: "minimax-code", capabilities: ["handoff"], execute() {} }] }), /unsupported runtime/);
});

test("real Fetch CLI and governed entry honor the current host and reject changed continuation client/model", async t => {
  const fixture = createGovernanceRuntimeFixtureScope(t);
  const task = "Read package metadata and report the exact package name.";
  const env = { ...fixture.env, CLAUDECODE: "1" };
  for (const [runtime, expected, source] of [["auto", "claude_code", "observed_host"], ["codex", "codex", "explicit_runtime"], ["minimax-code", "minimax-code", "explicit_runtime"]]) {
    const result = fixture.run(["scripts/select-execution-route.mjs", "--task", task, "--runtime", runtime, "--os", "linux", "--fetch-only", "--json"], { env });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const fetched = JSON.parse(result.stdout);
    assert.equal(fetched.fetchPacket.capabilityDiscovery.context.runtime, expected);
    assert.equal(fetched.runtimeSelection.source, source);
    assert.equal(fetched.fetchPacket.runtimeSelection.runtime, expected);
    assert.equal(fetched.routeExecutionGate.executionAuthorized, false);
  }
  const { runMetaTheoryGovernedExecution: run } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const options = { task, runId: "dynamic-client-prepare", stateDir: path.join(fixture.root, "state"),
    artifactDir: path.join(fixture.root, "artifacts"), dbPath: path.join(fixture.root, "runs.sqlite"),
    projectRoot: fixture.repoRoot, osTarget: "linux", runtime: "auto", hostEnv: { CLAUDECODE: "1" },
    criticalInput: fixtureCritical({ task, successCriteria: [{ id: "name", condition: "Report the current package name", evidenceRequired: "Current package.json" }] }),
    governanceTaskFacts: localProtocolFixtureTaskFacts(task), projectCapabilityMutationMode: "read_only",
    stageRunner: { enabled: false, model: "MiniMax-M3.1-Flash[1m]" } };
  const prepared = await run(options);
  assert.equal(prepared.runtimeSelection.source, "observed_host");
  assert.equal(prepared.fetchPacket.capabilityDiscovery.context.runtime, "claude_code");
  assert.equal(prepared.fetchPacket.runtimeSelection.source, "observed_host");
  assert.equal(prepared.modelSelection.requested, options.stageRunner.model);
  assert.equal(prepared.modelSelection.applied, null);
  assert.deepEqual(prepared.workerTaskPackets, []);
  await assert.rejects(run({ ...options, hostEnv: { CODEX_THREAD_ID: "another-host" } }), /selection changed/);
  await assert.rejects(run({ ...options, stageRunner: { enabled: false, model: "changed-model" } }), /selection changed/);
  await assert.rejects(run({ ...options, runtime: "codex", stageRunner: { enabled: false, runtime: "claude" } }), /binding differ/);
  const next = await run({ ...options, runId: "dynamic-client-fresh", stageRunner: { enabled: false, model: "changed-model" } });
  assert.notEqual(next.taskFingerprint, prepared.taskFingerprint);
  const geminiRegistry = createLiveRuntimeAdapterRegistry({ adapters: [{ adapterId: "gemini-configured", runtime: "gemini", capabilities: ["handoff"], execute: async () => ({}) }] });
  const injected = await run({ ...options, runId: "dynamic-client-injected", hostEnv: {},
    stageRunner: { enabled: false, adapterId: "gemini-configured", adapterRegistry: geminiRegistry } });
  assert.equal(injected.runtimeSelection.runtime, "gemini");
  assert.equal(injected.runtimeSelection.source, "registered_host_adapter");
  assert.equal(injected.machineExecution.calls.length, 0);
});
