import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildReadOnlyWorkerPrompt } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { fixtureCritical, fixtureReadWorkOrder, fixtureThinkingInput, refreshFixtureSourcePins } from "../helpers/host-reasoning-fixture.mjs";
import { createProjectProfessionalFixture, persistProjectProfessionalFixture } from "../helpers/project-professional-fixture.mjs";
import { localProtocolFixtureTaskFacts } from "../helpers/task-design-facts.mjs";

test("required project Skill and Command sources must actually be selected, read and current before ordinary delivery", async t => {
  const fixture = createGovernanceRuntimeFixtureScope(t); refreshFixtureSourcePins(fixture);
  const professional = createProjectProfessionalFixture(fixture.repoRoot, { id: "maintenance-planner",
    instructions: "Own maintenance triage and preserve the equipment identity, severity and responsible technician in each recommendation." });
  const { runMetaTheoryGovernedExecution: run } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  const task = "Prepare the maintenance escalation brief from current project rules.";
  const criticalInput = fixtureCritical({ task, successCriteria: ["Each escalation records its equipment and technician"] });
  const base = { task, runtime: "codex", projectRoot: fixture.repoRoot, stateDir: "tmp/required-source", dbPath: "tmp/required-source.sqlite", criticalInput,
    governanceTaskFacts: localProtocolFixtureTaskFacts(task), projectCapabilityMutationMode: "read_only" };
  let prepared = await run({ ...base, runId: "required-source-fetch" });
  const owner = prepared.fetchPacket.capabilityDiscovery.agents.find(candidate => candidate.id === professional.id && candidate.source === "project_runtime_agent_inventory");
  persistProjectProfessionalFixture(fixture.repoRoot, owner, professional);
  for (const capabilityType of ["skill", "command"]) {
    const role = "maintenance-" + capabilityType;
    const targetPath = capabilityType === "skill" ? `.agents/skills/${role}` : `.codex/commands/${role}.md`;
    const entrypoint = capabilityType === "skill" ? targetPath + "/SKILL.md" : targetPath;
    const requirement = { projectId: "maintenance", role, capabilityType, baseComponentId: "get-context", baseComponentVersion: "fixture",
      domainEvidenceRefs: [professional.rules.ref], responsibilities: ["Preserve equipment and technician evidence"], boundaries: ["No external writes"],
      projectDelta: ["Use the local escalation severity ladder"], reuseConditions: ["Current severity ladder"], targetPath, requiredInputs: [professional.rules.ref], toolRequirements: [], acceptance: ["Every escalation has its equipment and technician"] };
    const thinkingFor = (preparation, provider = null) => {
      const order = fixtureReadWorkOrder(preparation, { id: "delivery", todayTask: task, output: "Maintenance escalation brief", criterionIds: ["user-outcome"], taskFacts: base.governanceTaskFacts,
        selectedProviders: { agent: preparation.fetchPacket.capabilityDiscovery.agents.find(candidate => candidate.id === professional.id && candidate.source === "project_runtime_agent_inventory"),
          ...(provider ? { [capabilityType]: provider } : {}) } });
      delete order.projectCapabilityIntent;
      const thinking = fixtureThinkingInput(preparation, { criticalInput, workOrders: () => [order] });
      thinking.thinkingPacket.projectCapabilityRequirements = [requirement]; return thinking;
    };
    let invoked = 0;
    const missing = await run({ ...base, runId: role + "-missing", previousPlanChallengeRunId: prepared.runId, thinkingInput: thinkingFor(prepared),
      stageRunner: { enabled: true, evidenceKind: "explicit_protocol_test_double", invokeWorker: async () => { invoked++; throw new Error("must not invoke missing source"); } } });
    assert.equal(invoked, 0); assert.deepEqual(missing.workerTaskPackets, []);
    assert.ok(missing.capabilityGapPacket.missing.includes("required_project_capability_unavailable:" + role));
    const source = `# ${role}\n\nProject severity ladder: retain equipment ID, fault observation and duty technician before escalation.\n`;
    mkdirSync(path.dirname(path.join(fixture.repoRoot, entrypoint)), { recursive: true }); writeFileSync(path.join(fixture.repoRoot, entrypoint), source);
    prepared = await run({ ...base, runId: role + "-fetch" });
    const provider = prepared.fetchPacket.capabilityDiscovery.providers.find(candidate => candidate.id === role && candidate.source === `project_runtime_${capabilityType}_inventory`);
    assert.ok(provider, "The actual project entrypoint must be rediscovered");
    const ready = await run({ ...base, runId: role + "-ready", previousPlanChallengeRunId: prepared.runId, thinkingInput: thinkingFor(prepared, provider) });
    const packet = ready.workerTaskPackets[0]; assert.ok(packet, JSON.stringify(ready.capabilityGapPacket));
    assert.equal(packet.workOrderReadiness, "ready");
    assert.equal(packet.projectCapabilityBinding.capabilitySources[0].content, source);
    assert.match(packet.runtimeInvocationPlan.message, /Project severity ladder/u);
    assert.match(packet.runtimeInvocationPlan.followupTaskTemplate.message, /Project severity ladder/u);
    assert.match(buildReadOnlyWorkerPrompt({ runId: ready.runId, runtime: "codex", node: { nodeId: "delivery" }, packet }), /Project severity ladder/u);
    writeFileSync(path.join(fixture.repoRoot, entrypoint), "Changed local method after selection");
    assert.throws(() => buildReadOnlyWorkerPrompt({ runId: ready.runId, runtime: "codex", node: { nodeId: "delivery" }, packet }), /digest|source changed/u);
  }
});
