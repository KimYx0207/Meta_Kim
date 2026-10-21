import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createGovernanceRuntimeFixture } from "../helpers/governance-runtime-fixture.mjs";

test("default evidence validates available and unavailable optional providers without gating native fanout", (t) => {
  const fixture = createGovernanceRuntimeFixture(t);
  const validate = () => {
    const result = fixture.run(["scripts/validate-default-governed-execution-evidence.mjs"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const available = validate();
  const validateProductExperience = () => {
    const result = fixture.run(["scripts/validate-product-experience-core-goals.mjs"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const availableProduct = validateProductExperience();
  assert.equal(availableProduct.validationStatus, "pass");
  assert.equal(availableProduct.agentTeamsPlaybook.selected, true);
  assert.equal(availableProduct.defaultBoundaryRun.capabilityInvocationTruth.agentTeamsPlaybookState, "selected_not_invoked");
  assert.equal(availableProduct.syntheticNegativeControlRun.capabilityInvocationTruth.agentTeamsPlaybookState, "selected_not_invoked");
  assert.equal(available.validationStatus, "pass");
  assert.equal(available.optionalProvider.available, true);
  assert.equal(available.optionalProvider.selected, true);
  assert.equal(available.optionalProvider.invocationState, "selected_not_invoked");
  assert.ok(["codex_global_skill", "claude_global_skill"].includes(available.optionalProvider.selectedSource));

  // Remove only this fixture's discovery-only provider files, then refresh its
  // inventory. The developer's source tree, homes and providers stay untouched.
  for (const runtime of [".codex", ".claude"]) {
    rmSync(path.join(fixture.home, runtime, "skills", "agent-teams-playbook"), { recursive: true });
  }
  const refreshed = fixture.run(["scripts/discover-global-capabilities.mjs", "--runtime-inventory-only"]);
  assert.equal(refreshed.status, 0, refreshed.stderr || refreshed.stdout);
  const unavailable = validate();
  const unavailableProduct = validateProductExperience();
  assert.equal(unavailableProduct.validationStatus, "pass");
  assert.equal(unavailableProduct.agentTeamsPlaybook.selected, false);
  assert.equal(unavailableProduct.defaultBoundaryRun.capabilityInvocationTruth.agentTeamsPlaybookState, "not_required");
  assert.equal(unavailableProduct.syntheticNegativeControlRun.capabilityInvocationTruth.agentTeamsPlaybookState, "not_required");
  assert.equal(unavailable.validationStatus, "pass");
  assert.equal(unavailable.optionalProvider.available, false);
  assert.equal(unavailable.optionalProvider.selected, false);
  assert.equal(unavailable.optionalProvider.selectedSource, null);
  assert.equal(unavailable.optionalProvider.invocationState, "not_required");

  for (const branch of [available, unavailable]) {
    assert.equal(branch.optionalProvider.invokedCount, 0);
    assert.equal(branch.optionalProvider.actualWorkerExecution, false);
    assert.equal(branch.optionalProvider.nativeFanoutReady, true);
    assert.equal(branch.optionalProvider.fanoutSafety, true);
    assert.equal(branch.optionalProvider.dagAndCollisionSafe, true);
    assert.equal(branch.optionalProvider.parallelWaveExists, true);
  }
  assert.deepEqual(available.optionalProvider.workerTaskIds, unavailable.optionalProvider.workerTaskIds);
  assert.equal(available.workerResultPackets, unavailable.workerResultPackets);
  assert.equal(available.workerExecutionEvidence, unavailable.workerExecutionEvidence);
});
