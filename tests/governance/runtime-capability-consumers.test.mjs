import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildCapabilityInventory } from "../../scripts/build-capability-inventory.mjs";
import { runtimeToolCandidates } from "../../scripts/generate-multi-type-capability-browser.mjs";

const matrix = JSON.parse(await readFile(
  new URL("../../config/runtime-capability-matrix.json", import.meta.url),
  "utf8",
));

test("runtime capability inventory retains docs-only tools as references", async () => {
  const inventory = await buildCapabilityInventory();
  const subagent = inventory.capabilities.find((entry) => entry.id === "subagent");
  assert.equal(subagent.runtimeSupport.cursor, "partial");
  assert.equal(subagent.routeEligibility, "reference");
  assert.equal(subagent.canExecute, false);

  const cursorRuntime = inventory.capabilities.find((entry) => entry.id === "runtime:cursor");
  assert.equal(cursorRuntime.routeEligibility, "reference");
  assert.equal(cursorRuntime.canExecute, false);
});

test("multi-type browser uses the same conservative runtime resolver", () => {
  const tools = runtimeToolCandidates(matrix);
  const applyPatch = tools.find((entry) => entry.id === "apply_patch");
  assert.equal(applyPatch.runtimeSupport.cursor, "partial");
  assert.equal(applyPatch.executionEligible, false);
  assert.equal(applyPatch.routeEligibility, "reference");
});

test("execution route treats advisory observation as host-handoff compatibility, not task authority", async () => {
  const source = await readFile(
    new URL("../../scripts/select-execution-route.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /bindRuntimeToolClaim/u);
  assert.match(source, /evaluateRouteExecutionGate/u);
  assert.match(source, /hostHandoffEligible:[^\n]*executionCapabilityGate\.routeCompatible/u);
  assert.match(source, /persistentAcceptanceAuthorizesExecution:\s*false/u);
  assert.doesNotMatch(source, /runtime_capability_acceptance_required/u);
  assert.doesNotMatch(source, /runtimeSupport:\s*"native"/u);
});
