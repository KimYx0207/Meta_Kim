import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertRuntimeMatrixGovernanceShape } from "../../scripts/validate-governance-contracts.mjs";

const runtimeMatrix = JSON.parse(
  readFileSync("config/runtime-capability-matrix.json", "utf8"),
);

test("governance contract validates v2 mode-scoped runtime evidence", () => {
  assert.doesNotThrow(() => assertRuntimeMatrixGovernanceShape(runtimeMatrix));

  const legacyOnly = structuredClone(runtimeMatrix);
  const legacyRow = legacyOnly.platforms[0].capabilities[0];
  delete legacyRow.evidenceRefs;
  legacyRow.evidence = { status: "legacy-placeholder" };
  assert.throws(
    () => assertRuntimeMatrixGovernanceShape(legacyOnly),
    /missing support\/confidence\/trigger\/evidenceRefs\/claimsByMode/u,
  );

  const missingModeMap = structuredClone(runtimeMatrix);
  delete missingModeMap.platforms[0].capabilities[0].claimsByMode;
  assert.throws(
    () => assertRuntimeMatrixGovernanceShape(missingModeMap),
    /missing support\/confidence\/trigger\/evidenceRefs\/claimsByMode/u,
  );

  const missingModeTruth = structuredClone(runtimeMatrix);
  const modeRow = missingModeTruth.platforms[0].capabilities[0];
  const mode = modeRow.runtimeModes[0];
  delete modeRow.claimsByMode[mode].routeEligibility;
  assert.throws(
    () => assertRuntimeMatrixGovernanceShape(missingModeTruth),
    new RegExp(`${mode} missing routeEligibility`, "u"),
  );
});
