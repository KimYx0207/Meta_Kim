import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { annotateCrossScopeAgentCollisions } from "../../scripts/governance-lib.mjs";

function writeAgent(agentsDir, filename, content) {
  writeFileSync(join(agentsDir, filename), `${content.trim()}\n`, "utf8");
}

test("Codex project and global agent collisions cannot claim an exact native source binding", () => {
  const candidates = annotateCrossScopeAgentCollisions([
    {
      id: "shared-owner",
      source: "project_runtime_agent_inventory",
      sourceClass: "project",
      sourceRef: ".codex/agents/project.toml",
      sourceKey: "codex:agents:shared-owner:project:project.toml",
      contentDigest: "a".repeat(64),
      validCustomAgentDefinition: true,
    },
    {
      id: "shared-owner",
      source: "local_global_agent_inventory",
      sourceClass: "personal",
      sourceRef: "~/.codex/agents/global.toml",
      sourceKey: "codex:agents:shared-owner:personal:global.toml",
      contentDigest: "b".repeat(64),
      validCustomAgentDefinition: true,
    },
  ], "codex");

  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.routeEligible === false));
  assert.ok(candidates.every((candidate) => candidate.collision.kind === "conflicting_definitions"));
  assert.ok(candidates.every((candidate) => candidate.collision.ambiguous === true));
  assert.ok(candidates.every((candidate) => candidate.provenance.length === 2));
});

test("Codex TOML discovery validates multiline instructions, required fields, and declared owner name", () => {
  const home = mkdtempSync(join(tmpdir(), "meta-kim-codex-agent-discovery-"));
  const agentsDir = join(home, ".codex", "agents");
  const profile = `codex-agent-discovery-${process.pid}-${Date.now()}`;
  const profileDir = resolve(".meta-kim", "state", profile);
  mkdirSync(agentsDir, { recursive: true });

  writeAgent(agentsDir, "valid-multiline.toml", `
name = "valid-multiline"
description = "Valid custom agent"
developer_instructions = """
Review the bounded task.
Return evidence and unresolved blockers.
"""
  `);
  writeAgent(agentsDir, "empty-instructions.toml", `
name = "empty-instructions"
description = "Empty instructions must fail"
developer_instructions = """

"""
  `);
  writeAgent(agentsDir, "missing-name.toml", `
description = "Missing name"
developer_instructions = "Do bounded work."
  `);
  writeAgent(agentsDir, "missing-description.toml", `
name = "missing-description"
developer_instructions = "Do bounded work."
  `);
  writeAgent(agentsDir, "missing-instructions.toml", `
name = "missing-instructions"
description = "Missing instructions"
  `);
  writeAgent(agentsDir, "filename-owner.toml", `
name = "search-specialist"
description = "The TOML name intentionally differs from the filename."
developer_instructions = "Do not use the filename as agent_type. OPENAI_API_KEY=secret-route-value D:/Outside/private.txt"
  `);

  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    META_KIM_PROFILE: profile,
    META_KIM_RUNTIME_FAMILY: "codex",
  };

  try {
    const discovery = spawnSync(
      process.execPath,
      [
        "scripts/discover-global-capabilities.mjs",
        "--runtime-inventory-only",
        "--targets",
        "codex",
        "--json",
        "--lang",
        "en",
      ],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(discovery.status, 0, discovery.stderr);
    const inventory = JSON.parse(discovery.stdout);
    const agents = Object.values(inventory.byCapabilityType.agents ?? {});
    const byId = new Map(agents.map((agent) => [agent.id, agent]));

    const valid = byId.get("valid-multiline");
    assert.equal(valid?.metadata?.validCustomAgentDefinition, true);
    assert.equal(valid?.metadata?.developerInstructions?.present, true);
    assert.match(valid?.metadata?.developerInstructions?.contentDigest ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(discovery.stdout.includes("Review the bounded task."), false);

    const invalidCases = [
      ["empty-instructions", "missing_developer_instructions"],
      ["missing-name", "missing_name"],
      ["missing-description", "missing_description"],
      ["missing-instructions", "missing_developer_instructions"],
    ];
    for (const [id, error] of invalidCases) {
      const agent = byId.get(id);
      assert.ok(
        agent,
        `${id} must be discovered; got ${[...byId.keys()].join(", ")}`,
      );
      assert.equal(agent.metadata.validCustomAgentDefinition, false, id);
      assert.ok(agent.metadata.customAgentDefinitionErrors.includes(error), `${id}: ${error}`);
    }
    assert.equal(byId.has("filename-owner"), false);
    const declaredOwner = byId.get("search-specialist");
    assert.equal(declaredOwner?.metadata?.validCustomAgentDefinition, true);
    assert.equal(declaredOwner?.metadata?.nativeAgentName, "search-specialist");
    assert.equal(declaredOwner?.inventoryId, "filename-owner");
    assert.equal(discovery.stdout.includes("secret-route-value"), false);
    assert.equal(discovery.stdout.includes("D:/Outside/private.txt"), false);

    const hostSchema = JSON.stringify({
      hostSurface: "spawn_agent",
      inputProperties: ["task_name", "message", "agent_type"],
      evidenceSource: "active_host_tool_schema",
    });
    const route = spawnSync(
      process.execPath,
      [
        "scripts/select-execution-route.mjs",
        "--task",
        "Critical Thinking Fetch Deep Thinking Review why Codex creates an agent instead of finding a global agent",
        "--runtime",
        "codex",
        "--os",
        "windows",
        "--json",
        "--codex-host-tool-schema",
        hostSchema,
      ],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(route.status, 0, route.stderr);
    const routed = JSON.parse(route.stdout);
    assert.equal(routed.recommendedRoute?.owner, "search-specialist");
    const binding = routed.recommendedRoute?.codexSpawnBinding;
    assert.equal(binding?.ownerBindingMode, "run_scoped_owner_contract");
    assert.equal(binding?.nativeAgentType, null);
    assert.equal(binding?.agent_type, undefined);
    assert.equal(binding?.ownerDefinition?.nativeAgentName, "search-specialist");
    assert.equal(binding?.ownerDefinition?.nativeCustomAgentEligible, true);
    assert.equal(
      binding?.hostToolSchemaEvidence?.status,
      "not_observed_in_offline_route_process",
    );
    assert.equal(binding?.hostToolSchemaEvidence?.suppliedArtifactRejected, true);
    assert.equal(route.stdout.includes("secret-route-value"), false);
    assert.equal(route.stdout.includes("D:/Outside/private.txt"), false);
    assert.equal(route.stdout.includes("Do not use the filename as agent_type."), false);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex source collisions preserve evidence and require exact selection for conflicting native owners", () => {
  const home = mkdtempSync(join(tmpdir(), "meta-kim-codex-agent-collisions-"));
  const agentsDir = join(home, ".codex", "agents");
  const profile = `codex-agent-collisions-${process.pid}-${Date.now()}`;
  const profileDir = resolve(".meta-kim", "state", profile);
  mkdirSync(agentsDir, { recursive: true });

  const identicalDefinition = `
name = "javascript-pro"
description = "Identical JavaScript implementation owner"
developer_instructions = "Implement bounded JavaScript work."
  `;
  writeAgent(agentsDir, "a-identical.toml", identicalDefinition);
  writeAgent(agentsDir, "b-identical.toml", identicalDefinition);
  writeAgent(agentsDir, "a-conflict.toml", `
name = "search-specialist"
description = "First conflicting search owner"
developer_instructions = "Search primary sources and return evidence."
  `);
  writeAgent(agentsDir, "b-conflict.toml", `
name = "search-specialist"
description = "Second conflicting search owner"
developer_instructions = "Use a different search policy and return evidence."
  `);

  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    META_KIM_PROFILE: profile,
    META_KIM_RUNTIME_FAMILY: "codex",
  };
  const runRoute = (extraArgs = []) => spawnSync(
    process.execPath,
    [
      "scripts/select-execution-route.mjs",
      "--task",
      "Critical Thinking Fetch Deep Thinking Review search for a matching global execution agent",
      "--runtime",
      "codex",
      "--os",
      "windows",
      "--json",
      "--codex-host-tool-schema",
      JSON.stringify({
        hostSurface: "spawn_agent",
        inputProperties: ["task_name", "message", "agent_type"],
        evidenceSource: "active_host_tool_schema",
      }),
      ...extraArgs,
    ],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );

  try {
    const discovery = spawnSync(
      process.execPath,
      [
        "scripts/discover-global-capabilities.mjs",
        "--runtime-inventory-only",
        "--targets",
        "codex",
        "--json",
        "--lang",
        "en",
      ],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(discovery.status, 0, discovery.stderr);
    const inventory = JSON.parse(discovery.stdout);
    assert.equal(discovery.stdout.includes(home), false);
    assert.equal(discovery.stdout.includes(home.replace(/\\/gu, "/")), false);
    assert.equal(discovery.stdout.includes(process.cwd()), false);
    const identical = inventory.byCapabilityType.agents["codex:javascript-pro"];
    const conflicting = inventory.byCapabilityType.agents["codex:search-specialist"];

    assert.equal(identical.collision.kind, "exact_duplicate");
    assert.equal(identical.routeEligible, true);
    assert.equal(identical.provenance.length, 2);
    assert.equal(identical.collisionAliases.length, 2);
    assert.equal(conflicting.collision.kind, "conflicting_definitions");
    assert.equal(conflicting.ambiguousNativeIdentity, true);
    assert.equal(conflicting.routeEligible, false);
    assert.equal(conflicting.provenance.length, 2);
    assert.equal(conflicting.sourceRef, conflicting.provenance[0].sourceRef);
    assert.match(conflicting.contentDigest, /^[a-f0-9]{64}$/u);
    assert.equal(inventory.byPlatform.codex.capabilities.agents.length, 4);
    assert.equal(
      inventory.byPlatform.codex.capabilities.agents.filter(
        (entry) => entry.nativeIdentity === "search-specialist",
      ).length,
      2,
    );

    const exactSource = conflicting.provenance.find(
      (entry) => entry.sourceRef.endsWith("b-conflict.toml"),
    );
    env.META_KIM_OWNER_SOURCE = exactSource.sourceRef;
    const automaticRoute = runRoute(["--compact-json"]);
    assert.equal(automaticRoute.status, 0, automaticRoute.stderr);
    const automatic = JSON.parse(automaticRoute.stdout);
    assert.equal(
      automatic.ownerDiscoveryPacket.candidateExistingExecutionOwners.includes(
        "search-specialist",
      ),
      false,
      "conflicting native owner definitions must not enter automatic routing",
    );
    const compactConflict = automatic.ownerDiscoveryPacket.localGlobalAgents.find(
      (agent) => agent.id === "search-specialist",
    );
    assert.equal(compactConflict.routeEligible, false);
    assert.equal(compactConflict.collision.ambiguous, true);
    assert.equal(compactConflict.provenance.length, 2);

    const forgedSourceRefRoute = runRoute([
      "--owner-source-ref",
      exactSource.sourceRef,
      "--owner-content-digest",
      exactSource.contentDigest,
    ]);
    assert.equal(forgedSourceRefRoute.status, 0, forgedSourceRefRoute.stderr);
    assert.notEqual(
      JSON.parse(forgedSourceRefRoute.stdout).recommendedRoute?.owner,
      "search-specialist",
      "sourceRef plus digest without the unique sourceKey must not authorize a collision",
    );

    const explicitRoute = runRoute([
      "--owner-source",
      exactSource.sourceKey,
      "--owner-source-ref",
      exactSource.sourceRef,
      "--owner-content-digest",
      exactSource.contentDigest,
    ]);
    assert.equal(explicitRoute.status, 0, explicitRoute.stderr);
    const explicit = JSON.parse(explicitRoute.stdout);
    assert.equal(explicit.recommendedRoute?.owner, "search-specialist");
    assert.equal(
      explicit.recommendedRoute?.codexSpawnBinding?.ownerBindingMode,
      "run_scoped_owner_contract",
    );
    assert.equal(
      explicit.recommendedRoute?.codexSpawnBinding?.agent_type,
      undefined,
    );
    assert.equal(
      explicit.recommendedRoute?.codexSpawnBinding?.ownerDefinition
        ?.sourceSelectedExplicitly,
      true,
    );
    assert.equal(
      explicit.recommendedRoute?.codexSpawnBinding?.ownerDefinition?.sourceRef,
      exactSource.sourceRef,
    );
    assert.equal(
      explicit.recommendedRoute?.codexSpawnBinding?.ownerDefinition
        ?.sourceCanBeBoundByNativeHost,
      false,
    );
    assert.ok(
      explicit.recommendedRoute?.codexSpawnBinding?.ownerDefinition
        ?.validationErrors.includes("native_host_cannot_bind_conflicting_source_definition"),
    );
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex live filesystem facts outrank stale and legacy cache records", () => {
  const home = mkdtempSync(join(tmpdir(), "meta-kim-codex-agent-stale-cache-"));
  const agentsDir = join(home, ".codex", "agents");
  const agentPath = join(agentsDir, "search.toml");
  const profile = `codex-agent-stale-cache-${process.pid}-${Date.now()}`;
  const profileDir = join(home, ".meta-kim", "state", profile);
  const inventoryPath = join(
    profileDir,
    "capability-index",
    "global-capabilities.json",
  );
  mkdirSync(agentsDir, { recursive: true });
  const firstDefinition = `
name = "search-specialist"
description = "Cached search owner"
developer_instructions = "Use the cached search policy."
  `;
  const liveDefinition = `
name = "search-specialist"
description = "Current live search owner"
developer_instructions = "Use the current filesystem search policy."
  `;
  writeAgent(agentsDir, "search.toml", firstDefinition);

  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    META_KIM_PROFILE: profile,
    META_KIM_RUNTIME_FAMILY: "codex",
  };
  const runRoute = () => spawnSync(
    process.execPath,
    [
      "scripts/select-execution-route.mjs",
      "--task",
      "Critical Thinking Fetch Deep Thinking Review search using the current global agent",
      "--runtime",
      "codex",
      "--os",
      "windows",
      "--json",
      "--codex-host-tool-schema",
      JSON.stringify({
        hostSurface: "spawn_agent",
        inputProperties: ["task_name", "message", "agent_type"],
        evidenceSource: "active_host_tool_schema",
      }),
    ],
    { cwd: process.cwd(), env, encoding: "utf8" },
  );

  try {
    const discovery = spawnSync(
      process.execPath,
      [
        "scripts/discover-global-capabilities.mjs",
        "--runtime-inventory-only",
        "--targets",
        "codex",
        "--json",
        "--lang",
        "en",
      ],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(discovery.status, 0, discovery.stderr);
    assert.equal(existsSync(inventoryPath), true, "discovery must publish the HOME inventory");
    writeAgent(agentsDir, "search.toml", liveDefinition);
    const liveDigest = createHash("sha256")
      .update(`${liveDefinition.trim()}\n`)
      .digest("hex");

    const staleCacheRoute = runRoute();
    assert.equal(staleCacheRoute.status, 0, staleCacheRoute.stderr);
    const staleOutput = JSON.parse(staleCacheRoute.stdout);
    const liveAgent = staleOutput.ownerDiscoveryPacket.localGlobalAgents.find(
      (agent) => agent.id === "search-specialist",
    );
    assert.equal(liveAgent.contentDigest, liveDigest);
    assert.equal(liveAgent.metadata.description, "Current live search owner");
    assert.equal(liveAgent.cacheEvidence.present, true);
    assert.equal(liveAgent.cacheEvidence.sourceAware, true);
    assert.equal(liveAgent.cacheEvidence.liveMatch, false);
    assert.equal(staleOutput.recommendedRoute?.owner, "search-specialist");

    const legacyCache = JSON.parse(readFileSync(inventoryPath, "utf8"));
    legacyCache.byCapabilityType.agents["codex:search-specialist"] = {
      id: "search-specialist",
      platformId: "codex",
      metadata: {
        name: "search-specialist",
        description: "Legacy cached owner",
        developer_instructions: "Legacy cache must not win.",
        validCustomAgentDefinition: true,
        workspace: home,
      },
      path: agentPath,
      validCustomAgentDefinition: true,
      routeEligible: false,
    };
    writeFileSync(inventoryPath, `${JSON.stringify(legacyCache, null, 2)}\n`, "utf8");

    const legacyCacheRoute = runRoute();
    assert.equal(legacyCacheRoute.status, 0, legacyCacheRoute.stderr);
    const legacyOutput = JSON.parse(legacyCacheRoute.stdout);
    const liveOverLegacy = legacyOutput.ownerDiscoveryPacket.localGlobalAgents.find(
      (agent) => agent.id === "search-specialist",
    );
    assert.equal(liveOverLegacy.contentDigest, liveDigest);
    assert.equal(liveOverLegacy.metadata.description, "Current live search owner");
    assert.equal(liveOverLegacy.cacheEvidence.sourceAware, false);
    assert.equal(liveOverLegacy.cacheEvidence.liveMatch, false);
    assert.equal(legacyOutput.recommendedRoute?.owner, "search-specialist");
    assert.equal(legacyCacheRoute.stdout.includes(home), false);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("route-ineligible skills cannot satisfy execution capability discovery", () => {
  const home = mkdtempSync(join(tmpdir(), "meta-kim-invalid-skill-route-"));
  const profile = `invalid-skill-route-${process.pid}-${Date.now()}`;
  const profileDir = resolve(".meta-kim", "state", profile);
  const inventoryDir = join(profileDir, "capability-index");
  mkdirSync(inventoryDir, { recursive: true });
  writeFileSync(join(inventoryDir, "global-capabilities.json"), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    profile,
    byPlatform: {},
    byCapabilityType: {
      agents: {},
      skills: {
        "codex:findskill": {
          id: "findskill",
          type: "skills",
          platformId: "codex",
          sourceClass: "personal",
          routeEligible: false,
          sourceValid: false,
          repairRoute: "diagnose_only_owner_managed_repair",
        },
      },
    },
  }, null, 2)}\n`, "utf8");
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    META_KIM_PROFILE: profile,
    META_KIM_RUNTIME_FAMILY: "codex",
  };
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/select-execution-route.mjs",
        "--task",
        "Critical Thinking Fetch Deep Thinking Review discover a matching execution capability",
        "--runtime",
        "codex",
        "--os",
        "windows",
        "--json",
      ],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const routed = JSON.parse(result.stdout);
    assert.notEqual(routed.recommendedRoute?.dependency, "findskill");

    const multiLane = spawnSync(
      process.execPath,
      [
        "scripts/select-execution-route.mjs",
        "--task",
        "Critical Thinking Fetch Deep Thinking Review build a web app with separate frontend and backend lanes and discover capabilities",
        "--runtime",
        "codex",
        "--os",
        "windows",
        "--json",
      ],
      { cwd: process.cwd(), env, encoding: "utf8" },
    );
    assert.equal(multiLane.status, 0, multiLane.stderr);
    const multiLaneRoutes = JSON.parse(multiLane.stdout).rankedRoutes ?? [];
    assert.equal(
      JSON.stringify(multiLaneRoutes).includes('"id":"findskill"'),
      false,
      "route-ineligible skills must not appear in dynamic lane provider bindings",
    );
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
