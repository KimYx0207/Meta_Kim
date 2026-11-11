import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { readOnlyFixtureTaskFacts } from "../helpers/task-design-facts.mjs";
import { resolveOperatingSystem } from "../../src/application/runtime/operating-system.mjs";
import { createGovernanceRuntimeFixtureScope } from "../helpers/governance-runtime-fixture.mjs";
import { refreshFixtureSourcePins, fixtureCritical } from "../helpers/host-reasoning-fixture.mjs";

test("OS auto observes the host; explicit targets and environment overrides remain separate", () => {
  for (const [hostPlatform, expected] of [["linux", "linux"], ["darwin", "macos"], ["win32", "windows"], ["freebsd", "unknown"]]) {
    assert.equal(resolveOperatingSystem({ hostPlatform }).targetOs, expected);
    const explicit = resolveOperatingSystem({ requestedOs: "Windows", environmentOs: "macos", hostPlatform });
    assert.equal(explicit.targetOs, "windows");
    assert.equal(explicit.hostOs, expected);
    assert.equal(explicit.source, "explicit_target");
    assert.equal(resolveOperatingSystem({ requestedOs: "auto", environmentOs: "windows", hostPlatform }).targetOs, expected);
    assert.equal(resolveOperatingSystem({ environmentOs: "darwin", hostPlatform }).targetOs, "macos");
  }
  assert.equal(resolveOperatingSystem({ hostPlatform: "linux", hostRelease: "6.6.87.2-microsoft-standard-WSL2" }).targetOs, "wsl2");
  assert.equal(resolveOperatingSystem({ hostPlatform: "linux", hostRelease: "4.4.0-Microsoft" }).targetOs, "linux", "WSL1 must not be asserted as WSL2");
  assert.equal(resolveOperatingSystem({ requestedOs: "unregistered", hostPlatform: "linux" }).supported, false);
});

test("the real route CLI and ordinary runner agree on auto and explicit OS targets", async t => {
  const fixture = createGovernanceRuntimeFixtureScope(t);
  refreshFixtureSourcePins(fixture);
  const task = "Inspect the local package file without changes";
  const host = resolveOperatingSystem({ hostPlatform: process.platform, hostRelease: os.release() }).hostOs;
  const route = (args = [], env = {}) => {
    const result = fixture.run(["scripts/select-execution-route.mjs", "--task", task, "--fetch-only", "--json", ...args],
      { env: { ...fixture.env, META_KIM_OS: "", ...env } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  assert.equal(route().os, host);
  assert.equal(route([], { META_KIM_OS: "windows" }).os, "windows");
  assert.equal(route(["--os", "linux"], { META_KIM_OS: "windows" }).os, "linux");
  assert.equal(route(["--os", "auto"], { META_KIM_OS: "windows" }).os, host);
  const { runMetaTheoryGovernedExecution } = await fixture.import("scripts/run-meta-theory-governed-execution.mjs");
  for (const [id, target, expected] of [["auto", "auto", host], ["explicit", "linux", "linux"], ["environment", undefined, "windows"]]) {
    const artifact = await runMetaTheoryGovernedExecution({ task, runId: `os-${id}`, osTarget: target,
      hostEnv: { ...fixture.env, META_KIM_OS: "windows" },
      criticalInput: fixtureCritical({ task, successCriteria: ["Return the observed package facts"] }),
      governanceTaskFacts: readOnlyFixtureTaskFacts(task), projectCapabilityMutationMode: "read_only",
      stateDir: path.join(fixture.root, "state"), artifactDir: path.join(fixture.root, "artifacts"), dbPath: path.join(fixture.root, "state.sqlite") });
    assert.equal(artifact.fetchPacket.capabilityDiscovery.context.os, expected);
    assert.equal(artifact.fetchPacket.capabilityDiscovery.context.hostOs, host);
    assert.equal(artifact.coreLoop.executionResult.actualWorkerExecution, false);
  }
});
