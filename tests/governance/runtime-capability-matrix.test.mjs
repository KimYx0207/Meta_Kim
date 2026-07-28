import assert from "node:assert/strict";
import test from "node:test";
import { assertRuntimeMatrixGovernanceShape } from "../../scripts/validate-governance-contracts.mjs";
import { readJson } from "../meta-theory/_helpers.mjs";

test("runtime matrix covers platforms and critical constraints", async () => {
  const matrix = await readJson("config/runtime-capability-matrix.json");
  const platforms = new Map(matrix.platforms.map((entry) => [entry.platform, entry]));
  for (const runtime of ["claude_code", "codex", "openclaw", "cursor"]) {
    assert.ok(platforms.has(runtime), `missing ${runtime}`);
  }
  const raw = JSON.stringify(matrix);
  assert.equal(matrix.evidenceLedger, "config/runtime-capability-evidence.json");
  assert.equal(matrix.schemaVersion, 2);
  assert.equal(Object.hasOwn(matrix, "lastVerifiedAt"), false);
  assert.equal(matrix.lastReviewedAt, "2026-07-28");
  for (const osName of ["macos", "windows", "wsl2"]) assert.match(raw, new RegExp(osName));
  for (const platform of matrix.platforms) {
    for (const capability of platform.capabilities ?? []) {
      assert.notEqual(capability.support === "native" && capability.confidence === "unverified", true);
    }
  }
  const capabilityMap = (platform) =>
    new Map((platform.capabilities ?? []).map((capability) => [capability.capability, capability]));
  const claudeCode = capabilityMap(platforms.get("claude_code"));
  assert.equal(claudeCode.get("agent")?.hostSupport, "native");
  assert.equal(claudeCode.get("agent")?.support, "partial");
  assert.equal(claudeCode.get("native choice surface")?.hostSupport, "native");
  assert.equal(claudeCode.get("native choice surface")?.hostConfidence, "verified_docs");
  assert.equal(claudeCode.get("native choice surface")?.claimsByMode.interactive_host.acceptanceState, "not_run");
  assert.equal(claudeCode.get("native choice surface")?.claimsByMode.interactive_host.routeEligibility, "host_handoff_eligible");
  assert.equal(claudeCode.get("agent")?.claimsByMode.interactive_host.routeEligibility, "host_handoff_eligible");
  const cursor = capabilityMap(platforms.get("cursor"));
  assert.equal(cursor.get("hook")?.hostSupport, "native");
  assert.equal(cursor.get("hook")?.hostConfidence, "verified_docs");
  assert.equal(cursor.get("subagent")?.hostSupport, "native");
  assert.equal(cursor.get("subagent")?.support, "partial");
  assert.equal(cursor.get("native choice surface")?.hostSupport, "native");
  assert.equal(cursor.get("native choice surface")?.hostConfidence, "verified_docs");
  assert.equal(cursor.get("native choice surface")?.claimsByMode.interactive_host.acceptanceState, "not_run");
  assert.equal(cursor.get("agent")?.claimsByMode.interactive_host.routeEligibility, "not_executable");
  const openclaw = capabilityMap(platforms.get("openclaw"));
  assert.notEqual(openclaw.get("popup / overlay / approval UI")?.support, "native");
  assert.match(JSON.stringify(platforms.get("codex")), /explicitly requested/);
  assert.match(JSON.stringify(platforms.get("codex")), /trust review/);
  assert.equal(
    capabilityMap(platforms.get("codex")).get("subagent")?.claimsByMode.interactive_host.routeEligibility,
    "host_handoff_eligible",
  );
  assert.equal(
    capabilityMap(platforms.get("codex")).get("native choice surface")?.claimsByMode.interactive_host.routeEligibility,
    "not_executable",
  );
  assert.match(JSON.stringify(platforms.get("openclaw")), /Third-party skills/);
  assert.match(JSON.stringify(platforms.get("openclaw")), /typed plugin hooks/);
  assert.match(JSON.stringify(platforms.get("openclaw")), /not a hard sandbox/);
  assert.equal(openclaw.get("hook")?.claimsByMode.interactive_host.metaKimIntegration, "declarative_only");
});

test("governance contract validates v2 mode-scoped runtime evidence", async () => {
  const runtimeMatrix = await readJson("config/runtime-capability-matrix.json");
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
