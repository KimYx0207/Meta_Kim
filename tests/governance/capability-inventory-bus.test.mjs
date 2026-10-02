import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";

test("capability inventory bus emits unified multi-source provider records", (t) => {
  const fixture = createGovernanceRuntimeFixture(t, { graph: true });
  const result = fixture.run(["scripts/build-capability-inventory.mjs"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const inventory = JSON.parse(
    readFileSync(path.join(fixture.repoRoot, ".meta-kim/state/default/capability-inventory.json"), "utf8"),
  );
  const globalOnly = inventory.projectProjectionMode === "global_only";
  const providerTypes = new Set(inventory.capabilities.map((record) => record.providerType));

  for (const providerType of [
    "agent",
    "skill",
    "script",
    "tool",
    "MCP",
    "hook",
    "runtime",
    "OS",
    "memory",
    "graph",
    "external",
  ]) {
    assert.ok(providerTypes.has(providerType), `missing providerType ${providerType}`);
  }

  for (const record of inventory.capabilities) {
    for (const field of [
      "id",
      "providerType",
      "sourcePath",
      "runtimeSupport",
      "riskLevel",
      "ownerBoundary",
      "canExecute",
      "canReview",
      "canVerify",
      "canCreateOrUpgrade",
      "missingDependencies",
      "confidence",
      "reason",
    ]) {
      assert.ok(Object.hasOwn(record, field), `${record.id} missing ${field}`);
    }
  }

  const sourcePaths = new Set(inventory.capabilities.map((record) => record.sourcePath));
  const expectedSourcePaths = [
    "canonical/agents/meta-warden.md",
    "scripts/mcp/meta-runtime-server.mjs",
    "config/runtime-capability-matrix.json",
    "config/os-compatibility-matrix.json",
    "graphify-out/GRAPH_REPORT.md",
  ];

  if (globalOnly) {
    expectedSourcePaths.push(
      ".meta-kim/state/default/capability-index/global-capabilities.json",
      "~/.codex/agents/meta-warden.toml",
    );
  } else {
    expectedSourcePaths.push(
      ".mcp.json",
      ".codex/agents/meta-warden.toml",
      ".claude/agents/meta-warden.md",
      ".cursor/agents/meta-warden.md",
      "openclaw/workspaces/meta-warden/SOUL.md",
    );
  }

  for (const sourcePath of expectedSourcePaths) {
    assert.ok(sourcePaths.has(sourcePath), `missing source path ${sourcePath}`);
  }

  assert.ok(inventory.summary.total > 250);
  assert.ok(inventory.summary.byProviderType.MCP >= 1);
  assert.ok(inventory.summary.byProviderType.hook >= 1);
  assert.ok(inventory.summary.byProviderType.runtime >= 1);

  const byId = new Map(inventory.capabilities.map((record) => [record.id, record]));
  if (globalOnly) {
    const cachedGlobal = byId.get("cached-global-capability-inventory");
    assert.ok(cachedGlobal, "global_only inventory must retain cached global provider evidence");
    assert.equal(cachedGlobal.routeEligibility, "reference");
    assert.equal(cachedGlobal.canExecute, false);

    const globalCodexWarden = byId.get("global:codex:agents:meta-warden");
    assert.ok(globalCodexWarden, "global_only inventory must expose global Codex meta-warden");
    assert.equal(globalCodexWarden.sourcePath, "~/.codex/agents/meta-warden.toml");
    assert.equal(globalCodexWarden.routeEligibility, "governance_owner");
  } else {
    for (const configId of [
      "project-mcp-config",
      "cursor-mcp-config",
      "codex-mcp-config",
      "claude-settings",
      "codex-hooks",
      "cursor-hooks",
    ]) {
      const record = byId.get(configId);
      assert.ok(record, `missing config record ${configId}`);
      assert.equal(record.routeEligibility, "reference", `${configId} must be reference-only`);
      assert.equal(record.canExecute, false, `${configId} must not be executable`);
    }
  }
  assert.equal(byId.get("meta-kim-runtime-mcp-server")?.canExecute, true);
});
