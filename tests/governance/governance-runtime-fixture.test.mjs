import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createGovernanceRuntimeFixture,
  createGovernanceRuntimeFixtureScope,
} from "../helpers/governance-runtime-fixture.mjs";

test("governance fixture discovers its own providers without inheriting runtime homes or host evidence", (t) => {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  let fixture;
  try {
    Object.assign(process.env, {
      OPENAI_API_KEY: "fixture-secret-sentinel", ANTHROPIC_API_KEY: "fixture-secret-sentinel",
      CUSTOM_PROVIDER_SECRET: "fixture-secret-sentinel", NODE_OPTIONS: "--invalid-sentinel-option",
      NODE_PATH: "ambient-node-path", APPDATA: "ambient-appdata", LOCALAPPDATA: "ambient-localappdata",
      Meta_Kim_Project_Root: "ambient-mixed-case-root",
    });
    fixture = createGovernanceRuntimeFixture(t, { graph: true });
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
  assert.doesNotMatch(JSON.stringify(fixture.env), /fixture-secret-sentinel|ambient-|invalid-sentinel/u);
  assert.equal(process.cwd(), originalCwd);
  assert.deepEqual({ ...process.env }, originalEnv);
  assert.notEqual(fixture.repoRoot, originalCwd);
  assert.equal(fixture.env.HOME, fixture.home);
  assert.equal(fixture.env.USERPROFILE, fixture.home);
  assert.equal(fixture.env.META_KIM_PROFILE, undefined);
  for (const key of ["CODEX_HOME", "CLAUDE_PROJECT_DIR", "META_KIM_CODEX_HOST_TOOL_SCHEMA", "META_KIM_KIM_SERVICE_ROOT", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GH_TOKEN", "NODE_OPTIONS"]) {
    assert.equal(fixture.env[key], undefined, `${key} must not leak into fixture discovery`);
  }
  const inventory = JSON.parse(readFileSync(path.join(fixture.home,
    ".meta-kim/state/default/capability-index/global-capabilities.json"), "utf8"));
  assert.ok(inventory.byPlatform.codex.capabilities.agents.some((agent) => agent.id === "worker"));
  assert.ok(inventory.byPlatform.claudeCode.capabilities.plugins.some((plugin) => plugin.id === "governance-test-plugin"));
  assert.match(readFileSync(path.join(fixture.repoRoot, "graphify-out/GRAPH_REPORT.md"), "utf8"), /test graph fixture/u);
  fixture.cleanup();
  assert.equal(existsSync(fixture.root), false);
});

test("in-process fixture dynamically imports isolated source and restores cwd and environment", async (t) => {
  const cwd = process.cwd();
  const env = { ...process.env };
  const fixture = createGovernanceRuntimeFixtureScope(t);
  assert.equal(process.cwd(), fixture.repoRoot);
  assert.equal(process.env.HOME, fixture.home);
  const governance = await fixture.import("scripts/governance-lib.mjs");
  assert.equal(governance.repoRoot, fixture.repoRoot);
  assert.equal(governance.stateDir, path.join(fixture.repoRoot, ".meta-kim/state/default"));
  assert.equal(existsSync(path.join(fixture.repoRoot, "tests/meta-theory/scenarios")), true);
  fixture.cleanup();
  fixture.cleanup();
  assert.equal(process.cwd(), cwd);
  assert.deepEqual({ ...process.env }, env);
  assert.equal(existsSync(fixture.root), false);
});
