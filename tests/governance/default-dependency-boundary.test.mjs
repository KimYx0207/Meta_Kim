import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";

const optionalIds = ["agent-teams-playbook", "findskill", "superpowers", "ecc", "hookprompt", "goalpro", "kim-decision", "cli-anything", "gstack"];
function minimalRuntime(t) {
  const fixture = createGovernanceRuntimeFixture(t);
  // Keep actual fixture owner contracts and the remaining default authoring
  // specialist. These files prove local discovery only, never host invocation.
  for (const runtime of [".codex", ".claude", ".agents"]) {
    for (const id of [...optionalIds, "create-agent"]) rmSync(path.join(fixture.home, runtime, "skills", id), { recursive: true, force: true });
  }
  for (const args of [["scripts/refresh-runtime-evidence-pins.mjs"], ["scripts/discover-global-capabilities.mjs", "--runtime-inventory-only"]]) {
    const result = fixture.run(args); assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  return fixture;
}

test("the default capability smoke closes its discovery chain with optional workflows absent", (t) => {
  const fixture = minimalRuntime(t);
  const result = fixture.run(["scripts/run-capability-discovery-smoke.mjs", "--runtime", "codex", "--os", "windows"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(readFileSync(path.join(fixture.repoRoot, ".meta-kim/state/default/capability-discovery-smoke.json")));
  assert.equal(report.status, "passed");
  const providers = report.selectedCapabilityProviders;
  assert.equal(providers.skillDiscovery.id, "package-script:meta:capability:search");
  assert.equal(providers.skillDiscovery.type, "commands");
  assert.equal(providers.skillCreation.id, "meta-skill-creator");
  assert.equal(providers.agentCreation.id, "create-agent");
  assert.equal(providers.agentCreation.sourceRef, "create-agent.md");
  assert.equal(existsSync(path.join(fixture.repoRoot, "canonical/skills/meta-theory/references", providers.agentCreation.sourceRef)), true);
  // The smoke itself requests a reusable Skill, so its execution method is
  // the remaining default authoring specialist, not a search command.
  assert.equal(providers.skill.id, "meta-skill-creator");
  assert.ok(providers.agent && !providers.agent.id.startsWith("meta-"));
  for (const provider of Object.values(providers).filter((value) => value && typeof value === "object")) {
    assert.equal(optionalIds.includes(provider.id), false, `unexpected optional dependency ${provider.id}`);
  }
  for (const id of optionalIds) assert.equal(existsSync(path.join(fixture.home, ".codex/skills", id)), false);
});

test("native bounded fan-out still prepares independently verifiable workers without an external playbook", (t) => {
  const fixture = minimalRuntime(t);
  const task = "Run meta-theory. In parallel inspect package.json; review AGENTS.md; read README.md; audit config/contracts/workflow-contract.json.";
  const result = fixture.run(["scripts/select-execution-route.mjs", "--task", task, "--runtime", "codex", "--os", "windows", "--json"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.workerTaskPacketDrafts.length, 4);
  for (const worker of report.workerTaskPacketDrafts) {
    assert.equal(worker.ownerKind, "agent");
    assert.equal(worker.codexSpawnBinding.hostSurface, "spawn_agent");
    assert.equal(worker.mutationPolicy, "read_only");
    assert.equal(worker.safetyEvidence.status, "proven");
    assert.ok(worker.shardScope.length > 0);
    assert.equal(optionalIds.includes(worker.ownerAgent), false);
  }
  assert.ok(["fan_out_ready", "fanout_eligible"].includes(report.dispatchBoardDraft.dispatchMode));
  assert.equal(existsSync(path.join(fixture.home, ".codex/skills/agent-teams-playbook")), false);
  assert.equal(report.recommendedRoute.selectedCapabilityProviders.agentCreation.id, "create-agent");
  assert.equal(report.recommendedRoute.selectedCapabilityProviders.agentCreation.sourceRef, "create-agent.md");
});
