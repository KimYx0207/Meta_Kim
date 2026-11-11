import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDiagnosticReadPlan } from "../../scripts/diagnostic-host-protocol.mjs";

const record = (id, sourceRef, extra = {}) => ({
  id, sourceRef, runtime: "codex", layer: "execution", routeEligible: true,
  inventoryRef: `sha256:${Buffer.from(id).toString("hex").padEnd(64, "0").slice(0, 64)}`, ...extra,
});

async function scenario(t, { agents, providers, context = { runtime: "codex", os: "linux" } } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-kim-diagnostic-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), '{"name":"diagnostic-unit-fixture"}\n');
  const preparation = {
    artifactKind: "host_preparation", runId: "diagnostic-unit-fetch",
    preparation: { status: "needs_thinking" }, workerTaskPackets: [], coreLoop: {},
    fetchPacket: { capabilityDiscovery: { context,
      agents: agents ?? [record("reader", "reader.toml"), record("checker", "checker.toml")],
      providers: providers ?? [record("source-reader", "SKILL.md", { type: "skills" })],
    } },
  };
  const file = path.join(root, "preparation.json");
  await writeFile(file, JSON.stringify(preparation));
  const calls = [];
  const run = async options => {
    calls.push(options);
    return calls.length === 1 ? { paths: { json: file } } : { status: "partial", nativeInvocationClaimed: false };
  };
  const options = { task: "Inspect package.json without editing it.", runId: "diagnostic-unit", projectRoot: root,
    diagnosticProviders: { runtime: "codex", agent: { id: "reader" }, verificationAgent: { id: "checker" }, skill: { id: "source-reader" } } };
  return { run, options, calls, preparation };
}

test("diagnostic host binds explicitly selected current Fetch records through two calls", async t => {
  const { run, options, calls, preparation } = await scenario(t);
  const result = await runDiagnosticReadPlan(run, options, ["package.json"]);
  assert.equal(result.nativeInvocationClaimed, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].stageRunner, null);
  assert.equal(calls[0].invokeCapabilityProbes, false);
  assert.equal(calls[1].previousPlanChallengeRunId, preparation.runId);
  const selected = calls[1].thinkingInput.thinkingPacket.workerTaskPackets[0].selectedCapabilityProviders;
  assert.deepEqual(selected.agent, preparation.fetchPacket.capabilityDiscovery.agents[0]);
  assert.deepEqual(selected.verificationAgent, preparation.fetchPacket.capabilityDiscovery.agents[1]);
  assert.equal(selected.agent.inventoryRef, preparation.fetchPacket.capabilityDiscovery.agents[0].inventoryRef);
});

test("diagnostic host refuses governance owners and never resumes with one as executor", async t => {
  const input = await scenario(t, { agents: [record("meta-prism", "meta-prism.md", { layer: "governance" }), record("checker", "checker.toml")] });
  input.options.diagnosticProviders.agent.id = "meta-prism";
  await assert.rejects(runDiagnosticReadPlan(input.run, input.options, ["package.json"]), /governance/u);
  assert.equal(input.calls.length, 1);
});

test("diagnostic host rejects runtime mismatch and ambiguous sources without inventing bindings", async t => {
  const wrongRuntime = await scenario(t, { context: { runtime: "claude", os: "linux" } });
  await assert.rejects(runDiagnosticReadPlan(wrongRuntime.run, wrongRuntime.options, ["package.json"]), /runtime/u);
  assert.equal(wrongRuntime.calls.length, 1);
  const ambiguous = await scenario(t, { agents: [record("reader", "first.toml"), record("reader", "second.toml"), record("checker", "checker.toml")] });
  await assert.rejects(runDiagnosticReadPlan(ambiguous.run, ambiguous.options, ["package.json"]), /ambiguous/u);
  assert.equal(ambiguous.calls.length, 1);
});

test("diagnostic sourceRef selects one exact current source and missing capabilities are environment unavailable", async t => {
  const exact = await scenario(t, { agents: [record("reader", "first.toml"), record("reader", "second.toml"), record("checker", "checker.toml")] });
  exact.options.diagnosticProviders.agent.sourceRef = "second.toml";
  await runDiagnosticReadPlan(exact.run, exact.options, ["package.json"]);
  assert.equal(exact.calls[1].thinkingInput.thinkingPacket.workerTaskPackets[0].selectedCapabilityProviders.agent.sourceRef, "second.toml");
  const unavailable = await scenario(t, { agents: [] });
  await assert.rejects(runDiagnosticReadPlan(unavailable.run, unavailable.options, ["package.json"]), error =>
    error.code === "DIAGNOSTIC_ENVIRONMENT_UNAVAILABLE" && /environment unavailable/u.test(error.message));
  assert.equal(unavailable.calls.length, 1);
});

test("diagnostic Service owner contracts retain needs_probe and not_invoked without becoming native evidence", async t => {
  const dependency = id => record(`kim-service:${id}`, `agents/${id}/AGENT.md`, {
    runtime: undefined, source: "dependency_agent_contract", ownerBindingMode: "run_scoped_owner_contract",
    validCustomAgentDefinition: false, ownerContract: { runtimeStatus: "needs_probe", invocationStatus: "not_invoked" },
  });
  const input = await scenario(t, { agents: [dependency("source-evidence-analyst"), dependency("delivery-verifier")],
    providers: [record("meta-theory", ".agents/skills/meta-theory/SKILL.md", { type: "skills" })] });
  delete input.options.diagnosticProviders;
  await runDiagnosticReadPlan(input.run, input.options, ["package.json"]);
  const selected = input.calls[1].thinkingInput.thinkingPacket.workerTaskPackets[0].selectedCapabilityProviders;
  assert.equal(selected.agent.ownerContract.runtimeStatus, "needs_probe");
  assert.equal(selected.agent.ownerContract.invocationStatus, "not_invoked");
  assert.equal(selected.agent.validCustomAgentDefinition, false);
  assert.equal(selected.verificationAgent.id, "kim-service:delivery-verifier");
});
