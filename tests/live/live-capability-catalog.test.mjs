import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_CAPABILITY_CATALOG_AGENT_POLICY,
  LIVE_CAPABILITY_CATALOG_INDEX,
  loadLiveCapabilityCatalog,
  projectLiveCapabilityCatalog,
} from "../../src/application/live/live-capability-catalog.mjs";

test("shipped repository catalog exposes nine governed Meta Agents, not invented run invocations", async () => {
  const catalog = await loadLiveCapabilityCatalog();
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.source, "repository_registry");
  assert.equal(catalog.evidenceLevel, "registered_only");
  assert.equal(catalog.observedRuntime, false);
  assert.equal(catalog.provenance.index, LIVE_CAPABILITY_CATALOG_INDEX);
  assert.equal(catalog.provenance.agentPolicy, LIVE_CAPABILITY_CATALOG_AGENT_POLICY);
  assert.equal(catalog.agents.length, 9);
  assert.equal(catalog.counts.agents, 9);
  assert.deepEqual(catalog.agents.map(({ id }) => id), [
    "meta-artisan",
    "meta-chrysalis",
    "meta-conductor",
    "meta-genesis",
    "meta-librarian",
    "meta-prism",
    "meta-scout",
    "meta-sentinel",
    "meta-warden",
  ]);
  const conductor = catalog.agents.find((entry) => entry.id === "meta-conductor");
  assert.equal(conductor.eligibilityTier, "eligible");
  assert.equal(conductor.role, "governance-orchestrator");
  assert.ok(conductor.owns.includes("lane-dispatch"));
  assert.ok(catalog.agents.every((entry) => entry.agentKind === "canonical_meta_agent"));
  assert.ok(catalog.agents.every((entry) => entry.invocationState === "not_observed"));
  assert.deepEqual(catalog.subagents, []);
  assert.equal(catalog.counts.subagents, null);
  assert.equal(catalog.subagentSource, "run_observation_only");
});

test("skills, hooks, MCP, plugins and commands distinguish directory registration from runtime activation", async () => {
  const catalog = await loadLiveCapabilityCatalog();
  assert.equal(catalog.skills.length, 25);
  assert.equal(catalog.counts.callableSkillPackages, 2);
  assert.equal(catalog.counts.skillReferences, 23);
  assert.equal(catalog.hooks.length, 35);
  assert.equal(catalog.mcpServers.length, 1);
  assert.equal(catalog.mcpTools.length, 7);
  assert.equal(catalog.plugins.length, 3);
  assert.equal(catalog.commands.length, 4);
  assert.ok(catalog.skills.some((item) => item.id === "meta-theory" && !item.referenceOnly));
  assert.ok(catalog.skills.some((item) => item.id === "meta-theory" && item.referenceOnly));
  assert.equal(new Set(catalog.skills.map((item) => item.key)).size, catalog.skills.length);
  for (const category of ["agents", "skills", "hooks", "mcpServers", "mcpTools", "plugins", "commands"]) {
    for (const item of catalog[category]) {
      assert.equal(item.registrationState, "registered");
      assert.equal(item.invocationState, "not_observed");
      assert.equal("path" in item, false);
      assert.equal("credential" in item, false);
      assert.equal("config" in item, false);
    }
  }
  assert.equal(catalog.mcpTools.find(({ id }) => id === "meta-kim-runtime:list_meta_agents").serverId, "meta-kim-runtime");
});

test("untrusted catalog strings are bounded, filtered and cannot forge invocation evidence", () => {
  const malicious = {
    generatedAt: "nonsense",
    byCapabilityType: {
      agents: {
        a: { id: "meta-conductor", namespace: "canonical", layer: "meta", execution: "completed" },
        b: { id: "not-in-policy", namespace: "canonical", layer: "meta" },
      },
      skills: {
        a: { id: "valid-id", namespace: "canonical", observed: true, path: "/private/secrets" },
        b: { id: "ghp_0123456789abcdef", namespace: "canonical" },
        c: { id: "my-password", namespace: "canonical" },
        d: { id: "valid-id", namespace: "canonical" },
        e: { id: "support", namespace: "canonical-reference" },
      },
      mcpServers: { a: { id: "mcp", namespace: "repo-mcp", apiKey: "sensitive-value" } },
    },
  };
  const policy = { tiers: { eligible: { agents: [{ id: "meta-conductor", role: "governance-orchestrator", owns: ["lane-dispatch", "my-token", "lane-dispatch"] }] } } };
  const catalog = projectLiveCapabilityCatalog(malicious, policy);
  assert.equal(catalog.generatedAt, null);
  assert.equal(catalog.agents.length, 1);
  assert.deepEqual(catalog.agents[0].owns, ["lane-dispatch"]);
  assert.deepEqual(catalog.skills.map(({ id }) => id), ["support", "valid-id"]);
  assert.equal(catalog.counts.mcpServers, 1);
  assert.equal(JSON.stringify(catalog).includes("sensitive-value"), false);
  assert.equal(JSON.stringify(catalog).includes("/private/secrets"), false);
  assert.equal(JSON.stringify(catalog).includes("completed"), false);
  assert.equal(JSON.stringify(catalog).includes("observed\":true"), false);
  assert.ok(catalog.skills.every((item) => item.invocationState === "not_observed"));
});
