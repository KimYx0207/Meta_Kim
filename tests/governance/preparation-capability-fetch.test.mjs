import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { fixtureCritical, refreshFixtureSourcePins } from "../helpers/host-reasoning-fixture.mjs";
import { readOnlyFixtureTaskFacts } from "../helpers/task-design-facts.mjs";
import { componentHash, sha256, stableJson } from "../../scripts/dependency-source-integrity.mjs";

test("current Critical reasoning can discover professional methods before pending design, research or decisions are resolved", async (t) => {
  const fixture = createGovernanceRuntimeFixtureScope(t);
  refreshFixtureSourcePins(fixture);
  const serviceRoot = path.join(fixture.root, "service");
  const componentPath = "agents/planning-reviewer";
  const componentRoot = path.join(serviceRoot, componentPath);
  mkdirSync(componentRoot, { recursive: true });
  const capability = { id: "planning-review", summary: "Inspect supplied planning evidence", useWhen: ["Review a proposed design"], doNotUseWhen: ["Implement or publish"],
    input: { type: "object", required: ["facts"], properties: { facts: { type: "string" } } },
    output: { type: "object", required: ["findings"], properties: { findings: { type: "string" } } },
    permissions: ["filesystem:read-user-materials"], sideEffects: [], humanGate: { required: false, when: [] }, validation: ["check.mjs"] };
  const contract = { schemaVersion: 1, id: "planning-reviewer", componentType: "agent", componentVersion: "0.1.0", entrypoint: "AGENT.md", capabilities: [capability] };
  writeFileSync(path.join(componentRoot, "AGENT.md"), "---\nname: planning-reviewer\ndescription: Inspect supplied planning evidence\ntools: Read\n---\n# Planning reviewer fixture\nCompare the supplied decisions with their source evidence. This discovery fixture does not establish actual professional quality or invocation.\n");
  writeFileSync(path.join(componentRoot, "capability.json"), stableJson(contract));
  writeFileSync(path.join(componentRoot, "check.mjs"), 'throw new Error("Capability discovery must not execute provider code");\n');
  const component = { id: contract.id, componentType: "agent", componentVersion: "0.1.0", path: componentPath, entrypoint: "AGENT.md",
    capabilityIds: [capability.id], validation: capability.validation, contentSha256: await componentHash(componentRoot), contractSha256: sha256(stableJson(contract)) };
  mkdirSync(path.join(serviceRoot, "generated"));
  writeFileSync(path.join(serviceRoot, "generated/capabilities.json"), stableJson({ schemaVersion: 1, componentCount: 1, capabilityCount: 1, components: [component],
    capabilities: [{ ...capability, componentId: component.id, componentType: component.componentType, componentVersion: component.componentVersion,
      componentPath, entrypoint: component.entrypoint, componentContentSha256: component.contentSha256, contractSha256: component.contractSha256 }] }));
  process.env.META_KIM_KIM_SERVICE_ROOT = serviceRoot;
  const { runMetaTheoryGovernedExecution } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const task = "Design a registration tool with a public signup and organizer list";
  const out = path.join(fixture.root, "preparation");
  let admissions = 0;
  const run = (runId, extra = {}) => runMetaTheoryGovernedExecution({ task, runId, projectRoot: fixture.repoRoot,
    stateDir: out, artifactDir: out, dbPath: path.join(out, "runs.sqlite"), projectCapabilityMutationMode: "read_only", emitConversationNotice: false,
    criticalInput: fixtureCritical({ task, successCriteria: ["The proposal preserves its sources and unresolved questions"] }),
    governanceTaskFacts: readOnlyFixtureTaskFacts(task),
    stageRunner: { authorize: async () => { admissions++; throw new Error("Preparation reached execution authorization"); },
      adapterRegistry: { invoke: async () => assert.fail("Preparation invoked a worker") } }, ...extra });
  const cases = [
    { id: "design", extra: { designRequired: true }, status: "needs_thinking", action: "produce_integrated_design_for_current_boundaries" },
    { id: "research", extra: { governanceTaskFacts: readOnlyFixtureTaskFacts(task, { uncertainty: "focused_unknown", verification: "needs_probe" }) }, status: "needs_research", action: "complete_topic_research_and_source_bindings" },
    { id: "decision", extra: { criticalInput: fixtureCritical({ task, successCriteria: ["Keep the unresolved product decision explicit"], blockingUnknowns: ["registration-approval-policy"] }) }, status: "needs_input", action: "complete_current_material_question" },
  ];
  for (const scenario of cases) {
    await t.test(scenario.id, async () => {
      const report = await run(`capability-fetch-${scenario.id}`, scenario.extra);
      assert.equal(report.artifactKind, "host_preparation");
      assert.equal(report.preparation.status, scenario.status);
      assert.equal(report.hostInvocationRequestPacket.nextAction.action, scenario.action);
      assert.match(report.fetchPacket.capabilityDiscovery.inventoryDigest, /^[a-f0-9]{64}$/u);
      const method = report.fetchPacket.capabilityDiscovery.agents.find((agent) => agent.id === "kim-service:planning-reviewer");
      assert.ok(method, "Pending design or questions must not hide the actual source-bound method inventory");
      assert.equal(method.ownerContract.componentContentSha256, component.contentSha256);
      assert.match(method.inventoryRef, /^sha256:[a-f0-9]{64}$/u);
      assert.deepEqual(report.workerTaskPackets, []);
      assert.equal(report.coreLoop.stageDagPacket, undefined);
      assert.equal(report.hostInvocationRequestPacket.executionAllowed, false);
      assert.deepEqual(report.machineExecution.calls, []);
    });
  }
  const noCritical = await run("capability-fetch-no-critical", { criticalInput: null });
  assert.equal(noCritical.fetchPacket.status, "not_started_before_critical");
  assert.equal(noCritical.fetchPacket.capabilityDiscovery, undefined);
  assert.equal(admissions, 0);
});
