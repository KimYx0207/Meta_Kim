import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { globalReuseOnlyFixtures, runGlobalReuseNegativeLane } from "../../scripts/verify-packed-user-install-update.mjs";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";
import { PACKED_REUSE_REVIEWER } from "../../scripts/packed-global-reuse-acceptance.mjs";

function fixture(t) {
  const runtime = createGovernanceRuntimeFixture(t);
  const roots = { projectDir: runtime.repoRoot, userHome: runtime.home, codexHome: path.join(runtime.home, ".codex") };
  Object.assign(runtime.env, {
    CODEX_HOME: roots.codexHome, META_KIM_CODEX_HOME: roots.codexHome,
    META_KIM_MEMORY_AUTOSTART: "0", META_KIM_MEMORY_URL: "http://127.0.0.1:1",
  });
  const fixtures = globalReuseOnlyFixtures(roots);
  const manifest = path.join(roots.projectDir, ".meta-kim/state/default/project-capabilities.json");
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(manifest, JSON.stringify({ schemaVersion: "meta-kim-project-capabilities-v0.1", capabilities: [] }));
  for (const args of [["scripts/refresh-runtime-evidence-pins.mjs"], ["scripts/discover-global-capabilities.mjs", "--runtime-inventory-only"]]) {
    const result = runtime.run(args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  return { runtime, roots, fixtures, descriptor: { installedPackageRoot: runtime.repoRoot } };
}

test("actual governed CLI accepts copy-free global reuse through current Critical, Fetch and host Thinking", t => {
  const f = fixture(t);
  const proof = runGlobalReuseNegativeLane({ ...f, env: f.runtime.env, timeoutMs: 60_000 });
  assert.equal(proof.status, "passed");
  assert.deepEqual(proof.types, ["agent", "skill", "command"]);
  assert.equal(proof.projectCopiesCreated, 0);
  assert.equal(proof.ownershipEntriesCreated, 0);
  const artifactDir = path.join(f.roots.projectDir, ".meta-kim/acceptance/global-reuse");
  const preparation = JSON.parse(readFileSync(path.join(artifactDir, "packed-global-reuse-negative-fetch.json"), "utf8"));
  const planned = JSON.parse(readFileSync(path.join(artifactDir, "packed-global-reuse-negative.json"), "utf8"));
  assert.equal(preparation.artifactKind, "host_preparation");
  assert.equal(preparation.preparation.status, "needs_thinking");
  assert.equal(planned.selectedExecutionRoute.routeExecutionGate.canHandoffToHost, true);
  assert.equal(planned.workerTaskPackets.length, 1);
  assert.equal(planned.workerTaskPackets[0].workOrderReadiness, "ready");
  const thinking = JSON.parse(readFileSync(path.join(artifactDir, "host-inputs/thinking.json"), "utf8"));
  assert.equal(thinking.fetchPacket.capabilityDiscovery.inventoryDigest, preparation.fetchPacket.capabilityDiscovery.inventoryDigest);
  assert.deepEqual(planned.machineExecution.calls, []);
  assert.equal(planned.machineExecution.publicReady, false);
});

test("actual Fetch rejects a missing independent reviewer instead of inventing a binding", t => {
  const f = fixture(t);
  rmSync(path.join(f.roots.codexHome, "agents", `${PACKED_REUSE_REVIEWER}.toml`));
  const discovered = f.runtime.run(["scripts/discover-global-capabilities.mjs", "--runtime-inventory-only"]);
  assert.equal(discovered.status, 0, discovered.stderr || discovered.stdout);
  assert.throws(() => runGlobalReuseNegativeLane({ ...f, env: f.runtime.env, timeoutMs: 60_000 }), /Expected exactly one actual Fetch binding for acceptance-global-reuse-reviewer; found 0/u);
});
