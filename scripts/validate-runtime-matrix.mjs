#!/usr/bin/env node
import { CONFIDENCE, RUNTIMES, SUPPORT, assert, readJson } from "./governance-lib.mjs";
import { assertRuntimeCapabilityClaims } from "./runtime-capability-evidence.mjs";
import { ROUTE_ELIGIBILITY_VALUES } from "./runtime-capability-claims.mjs";

const matrix = await readJson("config/runtime-capability-matrix.json");
const evidenceLedger = await readJson("config/runtime-capability-evidence.json");
const platformMap = new Map(matrix.platforms?.map((entry) => [entry.platform, entry]));

function supportMap(entry) {
  const map = new Map((entry.capabilities ?? []).map((capability) => [capability.capability, capability]));
  return map;
}

for (const runtime of RUNTIMES) {
  assert(platformMap.has(runtime), `Missing runtime platform ${runtime}`);
  const entry = platformMap.get(runtime);
  const capabilities = supportMap(entry);
  assert(!entry.capabilityTemplate, `${runtime} must not use capabilityTemplate; every capability needs a full record`);
  for (const capabilityName of matrix.capabilityNames ?? []) {
    assert(capabilities.has(capabilityName), `${runtime} missing capability ${capabilityName}`);
  }
  for (const capability of capabilities.values()) {
    assert(SUPPORT.includes(capability.support), `${runtime}.${capability.capability} has invalid support`);
    assert(CONFIDENCE.includes(capability.confidence), `${runtime}.${capability.capability} has invalid confidence`);
    assert(capability.trigger && capability.claimsByMode, `${runtime}.${capability.capability} missing trigger/claimsByMode`);
    assert(!(capability.support === "native" && capability.confidence === "unverified"), `${runtime}.${capability.capability} cannot be native with unverified confidence`);
    for (const [mode, claim] of Object.entries(capability.claimsByMode ?? {})) {
      assert(
        ROUTE_ELIGIBILITY_VALUES.includes(claim.routeEligibility),
        `${runtime}.${capability.capability}.${mode} has invalid routeEligibility ${claim.routeEligibility}`,
      );
    }
  }
}

for (const osName of ["macos", "windows", "linux", "wsl2"]) {
  assert(JSON.stringify(matrix).includes(osName), `Matrix must mention ${osName}`);
}

const cursor = supportMap(platformMap.get("cursor"));
assert(cursor.get("native choice surface")?.hostSupport === "native", "Cursor Ask Question host surface must reflect current primary documentation");
assert(cursor.get("native choice surface")?.hostConfidence === "verified_docs", "Cursor native choice host claim must remain documentation-scoped");
assert(cursor.get("native choice surface")?.claimsByMode?.interactive_host?.routeEligibility === "not_executable", "Cursor native choice must not imply product execution eligibility");
assert(cursor.get("native choice surface")?.claimsByMode?.interactive_host?.acceptanceState === "not_run", "Cursor native choice must remain locally/live unaccepted");
assert(cursor.get("hook")?.hostSupport === "native", "Cursor hook host surface must reflect official documentation");
assert(cursor.get("hook")?.hostConfidence === "verified_docs", "Cursor hook host claim must cite official documentation");
assert(cursor.get("subagent")?.hostSupport === "native", "Cursor subagent host surface must reflect official documentation");
assert(cursor.get("subagent")?.hostConfidence === "verified_docs", "Cursor subagent host claim must cite official documentation");

const codex = platformMap.get("codex");
const codexCapabilities = supportMap(codex);
assert(codexCapabilities.get("subagent")?.hostSupport === "native", "Codex subagent host surface must reflect official documentation");
assert(codexCapabilities.get("subagent")?.hostConfidence === "verified_docs", "Codex subagent host claim must cite official documentation");
assert(codexCapabilities.get("subagent")?.claimsByMode?.interactive_host?.acceptanceState === "not_run", "Codex subagent host evidence must remain distinct from local acceptance");
assert(codexCapabilities.get("subagent")?.claimsByMode?.interactive_host?.routeEligibility === "host_handoff_eligible", "Codex subagent must be host-handoff eligible without claiming accepted execution evidence");
assert(codexCapabilities.get("native choice surface")?.claimsByMode?.interactive_host?.routeEligibility === "not_executable", "Codex unknown native choice surface must remain not_executable");
assert(JSON.stringify(codex).includes("meta-theory activation authorizes safe fan-out"), "Codex subagent constraint must treat meta-theory activation as safe fan-out authorization");
assert(JSON.stringify(codex).includes("branch-changing"), "Codex subagent record must keep native choice for branch-changing route, scope, risk, or acceptance decisions");
assert(JSON.stringify(codex).includes("native choice surface"), "Codex subagent record must support native choice confirmation as an authorization source");
assert(JSON.stringify(codex).includes("hidden-auto-spawn"), "Codex subagent record must forbid hidden auto-spawn");
assert(JSON.stringify(codex).includes("agents.max_threads"), "Codex subagent record must preserve thread-cap boundary");
assert(JSON.stringify(codex).includes("max_depth"), "Codex subagent record must preserve nesting-depth boundary");
assert(JSON.stringify(codex).includes("trust review"), "Codex hooks must mention trust review");
const openclaw = supportMap(platformMap.get("openclaw"));
assert(openclaw.get("hook")?.hostConfidence === "verified_docs", "OpenClaw hooks must cite official docs evidence");
assert(JSON.stringify(platformMap.get("openclaw")).includes("typed plugin hooks"), "OpenClaw typed plugin hook boundary must be recorded");
assert(JSON.stringify(platformMap.get("openclaw")).includes("not a hard sandbox"), "OpenClaw workspace-vs-sandbox boundary must be recorded");
assert(JSON.stringify(platformMap.get("openclaw")).includes("Third-party skills"), "OpenClaw third-party skill risk must be recorded");

assertRuntimeCapabilityClaims(matrix, evidenceLedger);

console.log("runtime capability matrix valid");
