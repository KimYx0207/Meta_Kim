export const RUNTIME_CAPABILITY_MODES = Object.freeze([
  "project_projection",
  "global_install",
  "interactive_host",
  "headless_live",
  "compatibility_smoke",
]);

export const HOST_SUPPORT_VALUES = Object.freeze([
  "native",
  "partial",
  "unsupported",
  "unknown",
  "not_applicable",
]);

export const ROUTE_ELIGIBILITY_VALUES = Object.freeze([
  "executable",
  "host_handoff_eligible",
  "not_executable",
  "reference_only",
  "policy_only",
  "install_only",
  "compatibility_only",
]);

const ACCEPTED_HOST_SUPPORT = new Set(["native", "partial"]);
const ACCEPTED_INTEGRATION = new Set(["projected", "host_only"]);

export function runtimeCapabilityNameForTool(toolId) {
  const normalized = String(toolId ?? "").toLowerCase();
  const aliases = {
    shell_command: "shell",
    shell: "shell",
    filesystem: "filesystem",
    apply_patch: "apply_patch / edit",
    edit: "apply_patch / edit",
    browser: "browser / web",
    web_search: "browser / web",
    url_fetch: "browser / web",
    mcp: "MCP",
    graphify: "graph",
  };
  return aliases[normalized] ?? toolId;
}

export function getRuntimeCapabilityRecord(matrix, runtime, capability) {
  return matrix?.platforms
    ?.find((entry) => entry.platform === runtime)
    ?.capabilities?.find((entry) => entry.capability === capability) ?? null;
}

export function claimIsExecutable(claim) {
  if (!claim || claim.routeEligibility !== "executable") return false;
  if (!ACCEPTED_HOST_SUPPORT.has(claim.hostSupport)) return false;
  if (!ACCEPTED_INTEGRATION.has(claim.metaKimIntegration)) return false;
  return claim.acceptanceRequirement === "not_required" || claim.acceptanceState === "accepted";
}

export function claimIsHostHandoffEligible(claim) {
  if (!claim || !["executable", "host_handoff_eligible"].includes(claim.routeEligibility)) {
    return false;
  }
  if (!ACCEPTED_HOST_SUPPORT.has(claim.hostSupport)) return false;
  if (!ACCEPTED_INTEGRATION.has(claim.metaKimIntegration)) return false;
  return true;
}

export function resolveRuntimeCapabilityClaim(matrix, { runtime, capability, mode }) {
  const record = getRuntimeCapabilityRecord(matrix, runtime, capability);
  const claim = record?.claimsByMode?.[mode] ?? null;
  return {
    runtime,
    capability,
    mode,
    record,
    claim,
    hostSupport: claim?.hostSupport ?? "unknown",
    hostConfidence: claim?.hostConfidence ?? "unverified",
    metaKimIntegration: claim?.metaKimIntegration ?? "unknown",
    acceptanceRequirement: claim?.acceptanceRequirement ?? "mode_dependent",
    acceptanceState: claim?.acceptanceState ?? "not_run",
    routeEligibility: claim?.routeEligibility ?? "not_executable",
    evidenceRefs: claim?.evidenceRefs ?? [],
    executable: claimIsExecutable(claim),
    hostHandoffEligible: claimIsHostHandoffEligible(claim),
  };
}

export function aggregateLegacyCapabilitySummary(record) {
  const claims = Object.values(record?.claimsByMode ?? {});
  const executableClaims = claims.filter(claimIsExecutable);
  if (executableClaims.some((claim) => claim.hostSupport === "native")) {
    return { support: "native", confidence: "verified_local" };
  }
  if (executableClaims.length > 0) {
    return { support: "partial", confidence: "verified_local" };
  }
  if (claims.some((claim) => ACCEPTED_HOST_SUPPORT.has(claim.hostSupport))) {
    return {
      support: "partial",
      confidence: claims.some((claim) => claim.hostConfidence === "verified_docs")
        ? "repo_claim"
        : "unverified",
    };
  }
  if (claims.length > 0 && claims.every((claim) => claim.hostSupport === "unsupported")) {
    return { support: "unsupported", confidence: "verified_docs" };
  }
  return { support: "unknown", confidence: "unverified" };
}

export function runtimeSupportForCapability(matrix, capability, mode = "interactive_host") {
  return Object.fromEntries(
    (matrix?.platforms ?? []).map((platform) => {
      const resolved = resolveRuntimeCapabilityClaim(matrix, {
        runtime: platform.platform,
        capability,
        mode,
      });
      if (resolved.executable) return [platform.platform, resolved.hostSupport];
      if (["native", "partial"].includes(resolved.hostSupport)) return [platform.platform, "partial"];
      return [platform.platform, resolved.hostSupport === "unsupported" ? "unsupported" : "unknown"];
    }),
  );
}

export function runtimeRouteEligibility(matrix, capability, runtime, mode = "interactive_host") {
  const resolved = resolveRuntimeCapabilityClaim(matrix, { runtime, capability, mode });
  if (resolved.executable) return "callable";
  if (resolved.hostHandoffEligible) return "host_handoff_eligible";
  return "reference_only";
}
