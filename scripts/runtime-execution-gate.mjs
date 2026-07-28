import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeCapabilityClaim } from "./runtime-capability-claims.mjs";
import { resolveCurrentHostHandoff } from "./current-host-execution-authority.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadRuntimeExecutionSafetyContract(root = packageRoot) {
  return JSON.parse(readFileSync(path.join(root, "config", "contracts", "runtime-execution-safety-contract.json"), "utf8"));
}

export function standardRuntimeObservationSet(contract = loadRuntimeExecutionSafetyContract()) {
  return contract.standardObservationSet.map((entry) => ({ ...entry }));
}

export function assertExactStandardRuntimeObservationSet(entries, contract = loadRuntimeExecutionSafetyContract()) {
  if (!Array.isArray(entries)) throw new Error("runtime observation bindings must be an array");
  const key = (entry) => `${entry?.runtime}:${entry?.capability}:${entry?.mode}`;
  const expected = standardRuntimeObservationSet(contract).map(key).sort();
  const actual = entries.map(key).sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("runtime observation bindings must equal the exact 10-item Claude Code/Codex interactive_host safety set");
  }
  return entries;
}

function uniqueRequirements(requirements) {
  return [...new Map(requirements.map((entry) => [`${entry.capability}:${entry.mode}`, entry])).values()];
}

export function requiredRuntimeCapabilitiesForRoute({ route = {}, taskShape = "default_executable", choiceRequired = false, contract = loadRuntimeExecutionSafetyContract() } = {}) {
  if (taskShape === "fast_path") {
    return choiceRequired ? uniqueRequirements(contract.routePolicies.choice_required ?? []) : [];
  }
  const policy = contract.routePolicies[taskShape] ?? contract.routePolicies.default_executable;
  const declared = Array.isArray(route.requiredRuntimeCapabilities) ? route.requiredRuntimeCapabilities : [];
  const choice = choiceRequired ? contract.routePolicies.choice_required : [];
  return uniqueRequirements([...policy, ...declared, ...choice]);
}

export function evaluateRouteExecutionGate({
  route = {},
  runtime,
  taskShape = "default_executable",
  choiceRequired = false,
  effectiveMatrix,
  contract = loadRuntimeExecutionSafetyContract(),
  releaseResolution = false,
} = {}) {
  const requirements = requiredRuntimeCapabilitiesForRoute({ route, taskShape, choiceRequired, contract });
  const blockers = [];
  if (!effectiveMatrix) blockers.push("effective runtime capability matrix is unavailable");
  if (runtime === "cursor" && contract.runtimeBlocks?.cursor?.productExecution) blockers.push(contract.runtimeBlocks.cursor.reason);
  const checks = requirements.map((requirement) => {
    const policy = contract.executionClassPolicies[requirement.capability];
    const resolved = effectiveMatrix
      ? resolveRuntimeCapabilityClaim(effectiveMatrix, { runtime, ...requirement })
      : { executable: false, claim: null };
    const reasons = [];
    const advisories = [];
    if (!policy) reasons.push("capability has no independent execution-class policy");
    if (policy && !policy.requiredModes.includes(requirement.mode)) reasons.push("mode is not permitted by independent execution policy");
    if (!resolved.claim) reasons.push("runtime capability claim is unavailable");
    if (["unsupported", "not_applicable"].includes(resolved.claim?.hostSupport)) {
      reasons.push(`host support is ${resolved.claim.hostSupport} for this runtime/mode`);
    }
    if (contract.integrationBlocks.includes(resolved.claim?.metaKimIntegration)
      && resolved.claim?.metaKimIntegration !== "unknown") {
      reasons.push(`integration state ${resolved.claim?.metaKimIntegration} is blocked`);
    }
    const historicalAcceptanceMissing =
      resolved.claim?.acceptanceRequirement !== "not_required" &&
      resolved.claim?.acceptanceState !== "accepted";
    const explicitRouteIneligible = (contract.routeEligibilityPolicy?.hardBlocked ?? [
      "reference_only",
      "policy_only",
      "install_only",
      "compatibility_only",
      "not_executable",
    ]).includes(resolved.claim?.routeEligibility);
    if (explicitRouteIneligible) {
      reasons.push(`route eligibility is ${resolved.claim.routeEligibility}`);
    } else if (resolved.hostHandoffEligible !== true) {
      reasons.push("resolved capability is not eligible for host handoff");
    }
    if (historicalAcceptanceMissing) {
      advisories.push("persistent acceptance is unavailable; this does not authorize or block a current host task");
    }
    if (releaseResolution && resolved.claim?.acceptanceState !== "accepted") reasons.push("release resolution requires accepted evidence");
    if (reasons.length > 0) blockers.push(`${requirement.capability}/${requirement.mode}: ${reasons.join(", ")}`);
    return {
      ...requirement,
      compatible: reasons.length === 0,
      allowed: false,
      executable: resolved.executable === true,
      hostHandoffEligible: resolved.hostHandoffEligible === true,
      reasons,
      advisories,
      evidenceRefs: resolved.evidenceRefs ?? [],
    };
  });
  const routeCompatible = blockers.length === 0;
  const handoff = resolveCurrentHostHandoff({ routeCompatible, choiceRequired, blockedReasons: blockers });
  return {
    allowed: false,
    routeCompatible,
    ...handoff,
    canHandoffToHost: ["ready_for_host_handoff", "awaiting_native_choice"].includes(handoff.handoffStatus),
    executionAuthorized: false,
    authority: "current_host_native_surfaces_and_permissions",
    observationClass: contract.persistentAcceptanceClass,
    persistentAcceptanceAuthorizesExecution: false,
    requirements,
    checks,
    blockers,
  };
}
