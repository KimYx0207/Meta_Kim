import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..");

const CAPABILITY_RUNTIME_ID = {
  claude: "claude_code",
  codex: "codex",
  cursor: "cursor",
  openclaw: "openclaw",
};

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

export function toCapabilityRuntimeId(id) {
  return CAPABILITY_RUNTIME_ID[id] ?? id;
}

export function normalizePlanningRuntime(value) {
  if (value == null || String(value).trim() === "" || String(value).trim().toLowerCase() === "auto") return null;
  const normalized = String(value).trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(normalized)) throw new TypeError("Runtime must be a bounded client identifier");
  return ["claude", "claude_code", "claudecode", "claude-code"].includes(normalized) ? "claude_code" : normalized;
}

/** Planning selection from existing configuration and current host evidence.
 * A discovered profile is not an executable adapter or a model/provider choice. */
export function resolvePlanningRuntime({ requestedRuntime = null, stageRunnerRuntime = null, adapterRuntime = null,
  configuredRuntime = null, declaredRuntime = null, hostRuntime = null, hostBasis = null } = {}) {
  const candidates = [[requestedRuntime, "explicit_runtime"], [stageRunnerRuntime, "configured_stage_runner"],
    [adapterRuntime, "registered_host_adapter"], [configuredRuntime, "configured_environment"],
    [declaredRuntime, "declared_host"], [hostRuntime === "unavailable" ? null : hostRuntime, "observed_host"]];
  let chosen;
  for (const [value, source] of candidates) {
    const normalized = normalizePlanningRuntime(value);
    if (normalized != null) { chosen = [normalized, source]; break; }
  }
  if (!chosen) {
    const policy = readJson("config/contracts/runtime-priority-and-compatibility-contract.json");
    const runtime = normalizePlanningRuntime(policy.selectionPolicy?.defaultPlanningRuntime);
    chosen = [runtime ?? "unavailable", runtime ? "configured_default" : "not_configured"];
  }
  const [runtime, source] = chosen;
  return { schemaVersion: "runtime-selection-v1", runtime, source,
    requestedRuntime: normalizePlanningRuntime(requestedRuntime),
    formalProfileAvailable: loadFormalToolProfiles().some(profile => profile.runtime === runtime),
    observedHost: { runtime: hostRuntime ?? "unavailable", basis: hostBasis ?? "not_observed" },
    ...(source === "configured_default" ? { configurationRef: "config/contracts/runtime-priority-and-compatibility-contract.json#selectionPolicy.defaultPlanningRuntime" } : {}),
    boundary: "Planning target only; actual adapter capabilities, provider access and model availability remain separate." };
}

/** A model is an explicit host/provider identifier, not a client or permission. */
export function normalizeConfiguredModel(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !/^[^\s\u0000-\u001f\u007f]{1,200}$/u.test(value) || value.startsWith("-")) {
    throw new TypeError("Configured model must be a non-empty bounded model identifier");
  }
  return value;
}

export function modelSelectionRecord(model, { application = "not_invoked", applied = false, scope = "current_call" } = {}) {
  const requested = normalizeConfiguredModel(model);
  return { schemaVersion: "model-selection-v1", requested,
    applied: applied && requested != null ? requested : null, observed: null,
    source: requested == null ? "runtime_process_default" : "explicit_configuration",
    application, scope, observationStatus: "not_observed",
    boundary: "Applied records only the explicit invocation parameter. Provider access and the model actually served remain unverified; process defaults do not prove inheritance of the parent session or user configuration." };
}

export function renderAgentPath(agentPath, agentName = "<agent>") {
  if (!agentPath) return null;
  return String(agentPath)
    .replaceAll("{agent}", agentName)
    .replaceAll("<agent>", agentName);
}

export function loadFormalToolProfiles() {
  const syncManifest = readJson("config/sync.json");
  const catalog = readJson("config/runtime-compatibility-catalog.json");
  const byId = new Map((catalog.products ?? []).map((product) => [product.id, product]));

  return (syncManifest.supportedTargets ?? []).map((id) => {
    const product = byId.get(id);
    const agentPath = product?.genericCompatibility?.agentPath ?? null;
    return {
      id,
      runtime: toCapabilityRuntimeId(id),
      label: product?.label ?? id,
      compatibilityStatus: product?.genericCompatibility?.status ?? "unknown",
      agentPath,
      agentPathTemplate: renderAgentPath(agentPath),
      evidenceRefs: (product?.evidence ?? []).map((entry) => entry.ref),
    };
  });
}

export function loadAgentProjectionProfiles() {
  return loadFormalToolProfiles().filter((profile) => profile.agentPath);
}

export function buildAgentProjectionTargets(agentName = "<agent>") {
  return loadAgentProjectionProfiles().map((profile) => ({
    runtime: profile.runtime,
    tool: profile.label,
    target: renderAgentPath(profile.agentPath, agentName),
    compatibilityStatus: profile.compatibilityStatus,
  }));
}
