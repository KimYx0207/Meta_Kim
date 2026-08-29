#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { OS_TARGETS, RUNTIMES, repoPath, toPosix } from "./governance-lib.mjs";
import { buildHookPromptAdapterSource } from "./runtime-hook-mapping.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

const REQUIRED_PROVIDER_TYPES = [
  "runtime_native",
  "canonical_agent",
  "canonical_skill",
  "external_skill",
  "plugin_marketplace",
  "mcp_server",
  "hook_script",
  "command",
  "rule_file",
  "dependency_project",
  "memory_provider",
  "graph_provider",
];

const SUCCESS_STATES = [
  "unknown",
  "declared",
  "projected",
  "installed",
  "trusted",
  "discoverable",
  "invokable",
  "context_effective",
  "enforcement_effective",
  "verified",
];

const FAILURE_STATES = [
  "missing_projection",
  "missing_global_install",
  "untrusted",
  "not_discoverable",
  "not_invokable",
  "output_not_consumed",
  "degraded",
  "blocked_for_execution",
];

const PUBLIC_STATUSES = ["verified", "degraded", "partial", "needs_probe", "blocked"];
const INSTALL_LAYER_STATUSES = [
  "verified",
  "projected",
  "installed",
  "declared",
  "partial",
  "needs_probe",
  "missing",
  "unsupported",
  "degraded",
];
const OS_STATUSES = ["verified", "partial", "needs_probe", "unsupported", "degraded"];
const REQUIRED_PROVIDER_FIELDS = [
  "id",
  "providerKind",
  "capabilities",
  "source",
  "trust",
  "installMethod",
  "runtimeAdapters",
  "osAdapters",
  "installLayers",
  "exposedArtifacts",
  "activationEvents",
  "outputContracts",
  "safetyBoundary",
  "risk",
  "verification",
  "degradation",
  "owner",
  "reviewOwner",
  "evolutionKey",
];

function argValue(name, fallback = null) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] ?? fallback;
  const prefix = `${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const registryPath = path.resolve(
  repoRoot,
  argValue("--registry", "config/capability-index/provider-registry.json"),
);
const hooksPath = path.resolve(
  argValue(
    "--codex-hooks",
    process.env.META_KIM_CODEX_HOOKS_JSON ||
      path.join(os.homedir(), ".codex", "hooks.json"),
  ),
);
const cursorHooksPath = path.resolve(
  argValue(
    "--cursor-hooks",
    process.env.META_KIM_CURSOR_HOOKS_JSON ||
      path.join(os.homedir(), ".cursor", "hooks.json"),
  ),
);
const jsonOutput = args.includes("--json");
const strictGlobalHooks = args.includes("--strict-global-hooks");
const fixCodexHookPrompt = args.includes("--fix-codex-hookprompt");
const fixCursorHookPrompt = args.includes("--fix-cursor-hookprompt");

function issue({
  severity = "error",
  code,
  message,
  providerId = null,
  providerType = null,
  runtimeId = null,
  osId = null,
  installLayer = null,
  state = null,
  sourceRef = null,
}) {
  return {
    severity,
    code,
    message,
    providerId,
    providerType,
    runtimeId,
    osId,
    installLayer,
    state,
    sourceRef,
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function hasCommand(json, eventName, needle) {
  const event = json?.hooks?.[eventName];
  if (!Array.isArray(event)) return false;
  return event.some((block) => {
    const hooks = Array.isArray(block?.hooks) ? block.hooks : [block];
    return hooks.some((hook) =>
      String(hook?.command ?? "").replace(/\\/g, "/").includes(needle),
    );
  });
}

function uniqueMappedIds(providers, field) {
  const values = new Set();
  for (const provider of providers) {
    for (const value of provider.mappings?.[field] ?? []) values.add(value);
  }
  return values;
}

function expandedSupport(provider, runtimeId) {
  if (!RUNTIMES.includes(runtimeId)) return null;
  const override = provider.support.runtimes?.[runtimeId];
  const expanded = {
    ...provider.support.default,
    ...(override ?? {}),
  };
  if (override && !Object.hasOwn(override, "reason")) delete expanded.reason;
  return expanded;
}

function equalStringRecord(left, right) {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function runtimeClaimProjectionMatches(adapter, support) {
  return (
    adapter?.state === support?.state &&
    adapter?.status === support?.status &&
    (adapter?.reason ?? null) === (support?.reason ?? null) &&
    equalStringRecord(adapter?.installLayers, support?.installLayers)
  );
}

function runtimeClaimTargets(provider) {
  if (["runtime_native", "hook_script"].includes(provider.providerType)) {
    return new Set(provider.mappings?.runtimeTargets ?? []);
  }
  return null;
}

function validateRuntimeClaimTruth(provider, issues) {
  const targets = runtimeClaimTargets(provider);
  if (targets && targets.size === 0) {
    issues.push(
      issue({
        code: "missing_runtime_claim_target",
        providerId: provider.id,
        providerType: provider.providerType,
        message: `${provider.id} must declare mappings.runtimeTargets`,
      }),
    );
  }
  if (
    provider.providerType === "runtime_native" &&
    JSON.stringify([...(targets ?? [])].sort()) !==
      JSON.stringify([...(provider.mappings?.runtimeMatrixPlatforms ?? [])].sort())
  ) {
    issues.push(
      issue({
        code: "runtime_native_target_mismatch",
        providerId: provider.id,
        providerType: provider.providerType,
        message: `${provider.id} runtimeTargets must equal runtimeMatrixPlatforms`,
      }),
    );
  }
  for (const runtimeId of RUNTIMES) {
    const support = expandedSupport(provider, runtimeId);
    const adapter = provider.runtimeAdapters?.[runtimeId];
    if (adapter && !runtimeClaimProjectionMatches(adapter, support)) {
      issues.push(
        issue({
          code: "runtime_claim_projection_mismatch",
          providerId: provider.id,
          providerType: provider.providerType,
          runtimeId,
          state: adapter.state,
          message:
            `${provider.id} runtimeAdapters.${runtimeId} must be a projection of ` +
            "support, which is the single runtime-claim authority",
        }),
      );
    }
    const forbiddenRunClaims = [
      "selected",
      "invoked",
      "completed",
      "live",
      "support",
      "availability",
      "nativeSupport",
      "executionAuthority",
      "acceptanceState",
    ].filter(
      (field) => adapter && Object.hasOwn(adapter, field),
    );
    if (forbiddenRunClaims.length > 0) {
      issues.push(
        issue({
          code: "static_selected_claim_forbidden",
          providerId: provider.id,
          providerType: provider.providerType,
          runtimeId,
          state: forbiddenRunClaims.join(","),
          message:
            `${provider.id} cannot persist ${forbiddenRunClaims.join(", ")} in the registry; ` +
            "selection and execution are run-scoped evidence",
        }),
      );
    }
    if (
      adapter?.activationEvent &&
      (support.status === "blocked" || support.state === "blocked_for_execution")
    ) {
      issues.push(
        issue({
          code: "blocked_runtime_activation_claim",
          providerId: provider.id,
          providerType: provider.providerType,
          runtimeId,
          state: support.status,
          message:
            `${provider.id} cannot use activation metadata to claim an executable ` +
            `runtime while support for ${runtimeId} is blocked`,
        }),
      );
    }
    if (!targets || targets.has(runtimeId)) continue;
    const layerClaims = Object.values(support.installLayers ?? {});
    const osClaims = Object.values(support.os ?? {});
    const falselyPositive =
      support.status !== "blocked" ||
      support.state !== "blocked_for_execution" ||
      layerClaims.some((claim) => claim !== "unsupported") ||
      osClaims.some((claim) => claim !== "unsupported");
    if (falselyPositive) {
      issues.push(
        issue({
          code: "cross_runtime_claim_without_target",
          providerId: provider.id,
          providerType: provider.providerType,
          runtimeId,
          state: support.status,
          message:
            `${provider.id} is runtime-scoped but claims support for non-target ${runtimeId}; ` +
            "projection presence cannot prove availability, native support, or live execution",
        }),
      );
    }
    if (adapter?.activationEvent) {
      issues.push(
        issue({
          code: "cross_runtime_activation_leak",
          providerId: provider.id,
          providerType: provider.providerType,
          runtimeId,
          state: adapter.state,
          message: `${provider.id} leaks its target activation event into non-target ${runtimeId}`,
        }),
      );
    }
  }
  if (
    provider.source?.mappings &&
    JSON.stringify(provider.source.mappings) !== JSON.stringify(provider.mappings)
  ) {
    issues.push(
      issue({
        code: "source_mapping_projection_mismatch",
        providerId: provider.id,
        providerType: provider.providerType,
        message: `${provider.id} source.mappings must project the canonical mappings block`,
      }),
    );
  }
}

function validateSupport(provider, issues) {
  for (const runtimeId of RUNTIMES) {
    const support = expandedSupport(provider, runtimeId);
    if (![...SUCCESS_STATES, ...FAILURE_STATES].includes(support.state)) {
      issues.push(
        issue({
          code: "invalid_state",
          providerId: provider.id,
          providerType: provider.providerType,
          runtimeId,
          state: support.state,
          message: `${provider.id} has invalid state ${support.state} for ${runtimeId}`,
        }),
      );
    }
    if (!PUBLIC_STATUSES.includes(support.status)) {
      issues.push(
        issue({
          code: "invalid_status",
          providerId: provider.id,
          providerType: provider.providerType,
          runtimeId,
          state: support.status,
          message: `${provider.id} has invalid status ${support.status} for ${runtimeId}`,
        }),
      );
    }
    const invalidStateStatusPair =
      (support.state === "blocked_for_execution" && support.status !== "blocked") ||
      (support.status === "blocked" && support.state !== "blocked_for_execution") ||
      (support.state === "degraded" && support.status !== "degraded") ||
      (support.status === "degraded" && support.state !== "degraded") ||
      (support.state === "verified" && support.status !== "verified") ||
      (["runtime_native", "hook_script"].includes(provider.providerType) &&
        support.status === "verified" &&
        support.state !== "verified");
    if (invalidStateStatusPair) {
      issues.push(
        issue({
          code: "inconsistent_state_status",
          providerId: provider.id,
          providerType: provider.providerType,
          runtimeId,
          state: `${support.state}/${support.status}`,
          message: `${provider.id} has contradictory state/status for ${runtimeId}`,
        }),
      );
    }
    for (const installLayer of provider.activation.installLayers ?? []) {
      const layerStatus = support.installLayers?.[installLayer];
      if (!layerStatus) {
        issues.push(
          issue({
            code: "missing_install_layer_state",
            providerId: provider.id,
            providerType: provider.providerType,
            runtimeId,
            installLayer,
            state: "unknown",
            message: `${provider.id} missing ${runtimeId} install layer state for ${installLayer}`,
          }),
        );
      } else if (!INSTALL_LAYER_STATUSES.includes(layerStatus)) {
        issues.push(
          issue({
            code: "invalid_install_layer_state",
            providerId: provider.id,
            providerType: provider.providerType,
            runtimeId,
            installLayer,
            state: layerStatus,
            message: `${provider.id} has invalid ${runtimeId}/${installLayer} state ${layerStatus}`,
          }),
        );
      }
    }
    for (const osId of OS_TARGETS) {
      const osStatus = support.os?.[osId];
      if (!OS_STATUSES.includes(osStatus)) {
        issues.push(
          issue({
            code: "missing_os_state",
            providerId: provider.id,
            providerType: provider.providerType,
            runtimeId,
            osId,
            state: osStatus ?? "unknown",
            message: `${provider.id} missing ${runtimeId}/${osId} OS state`,
          }),
        );
      }
    }
  }
}

function currentOsId() {
  return process.platform === "win32" ? "windows" : undefined;
}

function adapterCommand(filePath) {
  const nodeCommand = process.execPath.includes(" ")
    ? `"${process.execPath.replace(/\\/g, "\\\\")}"`
    : process.execPath.replace(/\\/g, "\\\\");
  return `${nodeCommand} "${filePath.replace(/\\/g, "\\\\")}"`;
}

async function validateHookPromptAdapter({
  issues,
  registry,
  runtimeId,
  providerId,
  hooksFilePath,
  projectHooksPath,
  eventName,
  fixFlag,
}) {
  const provider = registry.providers.find(
    (entry) => entry.id === providerId,
  );
  if (!provider) return;

  const hooks = await readJsonIfExists(hooksFilePath);
  const severity = strictGlobalHooks ? "error" : "warning";
  if (!hooks) {
    issues.push(
      issue({
        severity,
        code: "missing_global_install",
        providerId: provider.id,
        providerType: provider.providerType,
        runtimeId,
        osId: currentOsId(),
        installLayer: "global_home",
        state: "missing_global_install",
        sourceRef: toPosix(hooksFilePath),
        message: `${runtimeId} global hooks file not found at ${toPosix(hooksFilePath)}`,
      }),
    );
    return;
  }

  const projectHooks = await readJsonIfExists(repoPath(projectHooksPath));
  const projectHasAdapter = hasCommand(
    projectHooks,
    eventName,
    "hookprompt-adapter.mjs",
  );
  const globalHasAdapter = hasCommand(
    hooks,
    eventName,
    "hookprompt-adapter.mjs",
  );

  if (projectHasAdapter) {
    issues.push(
      issue({
        code: "wrong_install_layer",
        providerId: provider.id,
        providerType: provider.providerType,
        runtimeId,
        installLayer: "project_projection",
        state: "project_duplicate",
        sourceRef: projectHooksPath,
        message:
          `Project ${runtimeId} hooks register hookprompt-adapter.mjs, but HookPrompt is a global package and must not be duplicated in project hooks`,
      }),
    );
  }

  if (!globalHasAdapter) {
    issues.push(
      issue({
        severity,
        code: "output_not_consumed",
        providerId: provider.id,
        providerType: provider.providerType,
        runtimeId,
        osId: currentOsId(),
        installLayer: "global_home",
        state: "output_not_consumed",
        sourceRef: toPosix(hooksFilePath),
        message:
          `${runtimeId} global ${eventName} does not register hookprompt-adapter.mjs, so HookPrompt output may not enter model context globally`,
      }),
    );
  }

  if (fixFlag && hooks && !globalHasAdapter) {
    await addHookPromptAdapter(hooksFilePath, hooks, eventName, runtimeId);
    issues.push(
      issue({
        severity: "info",
        code: "fixed_global_install",
        providerId: provider.id,
        providerType: provider.providerType,
        runtimeId,
        installLayer: "global_home",
        state: "installed",
        sourceRef: toPosix(hooksFilePath),
        message: `Registered hookprompt-adapter.mjs in ${runtimeId} global ${eventName} hooks`,
      }),
    );
  }
}

async function validateCodexHookPrompt({ issues, registry }) {
  await validateHookPromptAdapter({
    issues,
    registry,
    runtimeId: "codex",
    providerId: "hook-script-codex-hookprompt-adapter",
    hooksFilePath: hooksPath,
    projectHooksPath: ".codex/hooks.json",
    eventName: "UserPromptSubmit",
    fixFlag: fixCodexHookPrompt,
  });
}

async function validateCursorHookPrompt({ issues, registry }) {
  await validateHookPromptAdapter({
    issues,
    registry,
    runtimeId: "cursor",
    providerId: "hook-script-cursor-hookprompt-adapter",
    hooksFilePath: cursorHooksPath,
    projectHooksPath: ".cursor/hooks.json",
    eventName: "beforeSubmitPrompt",
    fixFlag: fixCursorHookPrompt,
  });
}

async function addHookPromptAdapter(filePath, hooksJson, eventName, runtimeId) {
  const home = path.resolve(os.homedir());
  const target = path.resolve(filePath);
  if (target !== home && !target.startsWith(`${home}${path.sep}`)) {
    throw new Error(`Refusing to modify ${runtimeId} hooks outside user home: ${target}`);
  }
  const hooksDir = path.join(path.dirname(target), "hooks");
  const adapter = path.join(hooksDir, "hookprompt-adapter.mjs");
  const command = adapterCommand(adapter);
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(adapter, buildHookPromptAdapterSource(runtimeId), "utf8");
  hooksJson.hooks ??= {};
  hooksJson.hooks[eventName] ??= runtimeId === "codex" ? [{ hooks: [] }] : [];
  if (!Array.isArray(hooksJson.hooks[eventName])) {
    hooksJson.hooks[eventName] = runtimeId === "codex" ? [{ hooks: [] }] : [];
  }
  if (runtimeId === "codex") {
    const first = hooksJson.hooks[eventName][0] ?? { hooks: [] };
    first.hooks ??= [];
    first.hooks.push({ type: "command", command, timeout: 10 });
    hooksJson.hooks[eventName][0] = first;
  } else {
    hooksJson.hooks[eventName].push({ command, timeout: 10 });
  }
  await fs.writeFile(target, `${JSON.stringify(hooksJson, null, 2)}\n`, "utf8");
}

function validateRegistryShape(registry, issues) {
  const runtimeClaimPolicy = registry.mappingPolicy?.providerRuntimeClaims;
  const requiredClaimPolicy = {
    sourceRef: "providers[*].support",
    required: true,
    runtimeAdapters: "derived_projection",
    selection: "run_scoped_only",
    availability: "support_state_and_install_layers",
    nativeSupport: "runtime_native_target_only",
    liveEvidence: "verification_artifact_required",
  };
  if (JSON.stringify(runtimeClaimPolicy) !== JSON.stringify(requiredClaimPolicy)) {
    issues.push(
      issue({
        code: "invalid_runtime_claim_policy",
        message:
          "provider runtime claims must keep support as the single authority and separate " +
          "run-scoped selection, availability, native support, and live evidence",
      }),
    );
  }
  for (const type of REQUIRED_PROVIDER_TYPES) {
    if (!registry.providerTypes?.includes(type)) {
      issues.push(issue({ code: "missing_provider_type", message: `providerTypes missing ${type}` }));
    }
    if (!(registry.providers ?? []).some((provider) => provider.providerType === type)) {
      issues.push(issue({ code: "missing_provider_instance", providerType: type, message: `No provider instance for ${type}` }));
    }
  }

  const declaredRuntimes = new Set(registry.runtimes ?? []);
  for (const runtimeId of declaredRuntimes) {
    if (!RUNTIMES.includes(runtimeId)) {
      issues.push(
        issue({
          code: "unknown_runtime_registry_key",
          runtimeId,
          message: `registry.runtimes contains undeclared runtime ${runtimeId}`,
        }),
      );
    }
  }
  for (const runtimeId of RUNTIMES) {
    if (!declaredRuntimes.has(runtimeId)) {
      issues.push(
        issue({
          code: "missing_runtime_registry_key",
          runtimeId,
          message: `registry.runtimes is missing declared runtime ${runtimeId}`,
        }),
      );
    }
  }

  for (const state of SUCCESS_STATES) {
    if (!registry.stateModel?.successStates?.includes(state)) {
      issues.push(issue({ code: "missing_success_state", state, message: `stateModel missing success state ${state}` }));
    }
  }
  for (const state of FAILURE_STATES) {
    if (!registry.stateModel?.failureStates?.includes(state)) {
      issues.push(issue({ code: "missing_failure_state", state, message: `stateModel missing failure state ${state}` }));
    }
  }

  const ids = new Set();
  for (const provider of registry.providers ?? []) {
    if (ids.has(provider.id)) {
      issues.push(issue({ code: "duplicate_provider", providerId: provider.id, message: `Duplicate provider id ${provider.id}` }));
    }
    ids.add(provider.id);
    for (const [field, runtimeMap] of [
      ["runtimeAdapters", provider.runtimeAdapters],
      ["support.runtimes", provider.support?.runtimes],
    ]) {
      for (const runtimeId of Object.keys(runtimeMap ?? {})) {
        if (!RUNTIMES.includes(runtimeId)) {
          issues.push(
            issue({
              code: "unknown_runtime_claim_key",
              providerId: provider.id,
              providerType: provider.providerType,
              runtimeId,
              message: `${provider.id} ${field} contains undeclared runtime ${runtimeId}`,
            }),
          );
        }
      }
    }
    for (const field of ["sourceOfTruth", "activation", "verification", "risk", "support"]) {
      if (!provider[field]) {
        issues.push(issue({ code: "missing_provider_field", providerId: provider.id, providerType: provider.providerType, message: `${provider.id} missing ${field}` }));
      }
    }
    for (const [metadataName, metadata] of [
      ["activation", provider.activation],
      ["support", provider.support],
      ["support.default", provider.support?.default],
    ]) {
      for (const field of [
        "live",
        "selected",
        "invoked",
        "completed",
        "executionAuthority",
        "activationEvent",
      ]) {
        if (metadata && Object.hasOwn(metadata, field)) {
          issues.push(
            issue({
              code: "metadata_claim_forbidden",
              providerId: provider.id,
              providerType: provider.providerType,
              state: `${metadataName}.${field}`,
              message:
                `${provider.id} cannot persist ${metadataName}.${field}; ` +
                "support is the sole durable runtime authority and live evidence is run-scoped",
            }),
          );
        }
      }
    }
    for (const [runtimeId, support] of Object.entries(provider.support?.runtimes ?? {})) {
      for (const field of [
        "live",
        "selected",
        "invoked",
        "completed",
        "executionAuthority",
        "activationEvent",
      ]) {
        if (support && Object.hasOwn(support, field)) {
          issues.push(
            issue({
              code: "metadata_claim_forbidden",
              providerId: provider.id,
              providerType: provider.providerType,
              runtimeId,
              state: `support.runtimes.${runtimeId}.${field}`,
              message:
                `${provider.id} cannot persist support.runtimes.${runtimeId}.${field}; ` +
                "support state must not be upgraded by activation or live metadata",
            }),
          );
        }
      }
    }
    for (const field of REQUIRED_PROVIDER_FIELDS) {
      const value = provider[field];
      const emptyArray = Array.isArray(value) && value.length === 0;
      const emptyObject =
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0;
      if (value === undefined || value === null || emptyArray || emptyObject) {
        issues.push(
          issue({
            code: "missing_contract_field",
            providerId: provider.id,
            providerType: provider.providerType,
            message: `${provider.id} missing provider contract field ${field}`,
          }),
        );
      }
    }
    if (provider.providerKind !== provider.providerType) {
      issues.push(
        issue({
          code: "provider_kind_mismatch",
          providerId: provider.id,
          providerType: provider.providerType,
          message: `${provider.id} providerKind must match providerType until a migration explicitly separates them`,
        }),
      );
    }
    if (provider.outputContracts?.mustEnterModelContext && provider.activation?.outputConsumption !== "model_context") {
      issues.push(
        issue({
          code: "output_contract_mismatch",
          providerId: provider.id,
          providerType: provider.providerType,
          message: `${provider.id} claims model context but activation output is ${provider.activation?.outputConsumption}`,
        }),
      );
    }
    for (const runtimeId of RUNTIMES) {
      if (!provider.runtimeAdapters?.[runtimeId]) {
        issues.push(
          issue({
            code: "missing_runtime_adapter",
            providerId: provider.id,
            providerType: provider.providerType,
            runtimeId,
            message: `${provider.id} missing runtimeAdapters.${runtimeId}`,
          }),
        );
      }
    }
    for (const osId of OS_TARGETS) {
      if (!provider.osAdapters?.[osId]) {
        issues.push(
          issue({
            code: "missing_os_adapter",
            providerId: provider.id,
            providerType: provider.providerType,
            osId,
            message: `${provider.id} missing osAdapters.${osId}`,
          }),
        );
      }
    }
    validateRuntimeClaimTruth(provider, issues);
    validateSupport(provider, issues);
  }
}

function validateSourceMappings({ registry, skills, dependencyRegistry, runtimeMatrix, weaponRegistry, issues }) {
  const providers = registry.providers ?? [];
  const mappedSkillIds = uniqueMappedIds(providers, "skillsJsonIds");
  const mappedDependencyIds = uniqueMappedIds(providers, "dependencyProjectIds");
  const mappedPlatforms = uniqueMappedIds(providers, "runtimeMatrixPlatforms");
  const mappedWeapons = uniqueMappedIds(providers, "weaponRegistryIds");

  for (const skill of skills.skills ?? []) {
    if (!mappedSkillIds.has(skill.id)) {
      issues.push(issue({ code: "unmapped_skill", message: `config/skills.json skill ${skill.id} missing from provider registry`, sourceRef: "config/skills.json" }));
    }
    const isPlugin =
      skill.installMethod === "pluginMarketplace" ||
      skill.claudePlugin ||
      skill.codexPlugin ||
      skill.cursorPlugin;
    if (isPlugin) {
      const pluginProvider = providers.find(
        (provider) =>
          ["plugin_marketplace", "plugin_bundle"].includes(provider.providerType) &&
          provider.mappings?.skillsJsonIds?.includes(skill.id),
      );
      if (!pluginProvider) {
        issues.push(issue({ code: "plugin_only_in_skills_manifest", providerType: "plugin_marketplace", message: `${skill.id} plugin exists in config/skills.json but provider registry does not know it`, sourceRef: "config/skills.json" }));
      }
    }
  }

  for (const project of dependencyRegistry.projects ?? []) {
    if (!mappedDependencyIds.has(project.id)) {
      issues.push(issue({ code: "unmapped_dependency_project", message: `dependency project ${project.id} missing from provider registry`, sourceRef: "config/capability-index/dependency-project-registry.json" }));
    }
  }

  for (const platform of runtimeMatrix.platforms ?? []) {
    if (!mappedPlatforms.has(platform.platform)) {
      issues.push(issue({ code: "unmapped_runtime_platform", runtimeId: platform.platform, message: `runtime platform ${platform.platform} missing from provider registry`, sourceRef: "config/runtime-capability-matrix.json" }));
    }
  }

  for (const weapon of weaponRegistry.weapons ?? []) {
    if (!mappedWeapons.has(weapon.id)) {
      issues.push(issue({ code: "unmapped_weapon", message: `weapon ${weapon.id} missing from provider registry`, sourceRef: "config/capability-index/weapon-registry.json" }));
    }
  }
}

async function main() {
  const issues = [];
  const [registry, skills, dependencyRegistry, runtimeMatrix, weaponRegistry] =
    await Promise.all([
      readJson(registryPath),
      readJson(repoPath("config/skills.json")),
      readJson(repoPath("config/capability-index/dependency-project-registry.json")),
      readJson(repoPath("config/runtime-capability-matrix.json")),
      readJson(repoPath("config/capability-index/weapon-registry.json")),
    ]);

  validateRegistryShape(registry, issues);
  validateSourceMappings({
    registry,
    skills,
    dependencyRegistry,
    runtimeMatrix,
    weaponRegistry,
    issues,
  });
  await validateCodexHookPrompt({ issues, registry });
  await validateCursorHookPrompt({ issues, registry });

  const errors = issues.filter((entry) => entry.severity === "error");
  const warnings = issues.filter((entry) => entry.severity === "warning");
  const infos = issues.filter((entry) => entry.severity === "info");
  const result = {
    ok: errors.length === 0,
    registry: toPosix(path.relative(repoRoot, registryPath)),
    strictGlobalHooks,
    summary: {
      providers: registry.providers?.length ?? 0,
      errors: errors.length,
      warnings: warnings.length,
      infos: infos.length,
    },
    issues,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `provider capabilities ${result.ok ? "valid" : "invalid"}: ${result.summary.providers} providers, ${errors.length} errors, ${warnings.length} warnings`,
    );
    for (const entry of issues) {
      const parts = [
        entry.severity.toUpperCase(),
        entry.code,
        entry.providerId,
        entry.runtimeId,
        entry.osId,
        entry.installLayer,
        entry.state,
      ].filter(Boolean);
      console.log(`- [${parts.join(" / ")}] ${entry.message}`);
    }
  }

  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
