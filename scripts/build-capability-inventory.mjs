#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OS_TARGETS, RUNTIMES, exists, listFiles, readJson, repoPath, stateDir, toPosix, writeJson } from "./governance-lib.mjs";
import { getProfilePaths, toRepoRelative } from "./meta-kim-local-state.mjs";
import {
  claimIsExecutable,
  runtimeCapabilityNameForTool,
  runtimeRouteEligibility,
  runtimeSupportForCapability,
} from "./runtime-capability-claims.mjs";

const outputPath = path.join(stateDir, "capability-inventory.json");
const profileStatePath = toRepoRelative(getProfilePaths().profileDir);

function defaultSupport(runtime = "partial", os = "partial") {
  return {
    runtimeSupport: Object.fromEntries(RUNTIMES.map((name) => [name, runtime])),
    osSupport: Object.fromEntries(OS_TARGETS.map((name) => [name, os])),
  };
}

function supportForRuntime(runtimeName, support = "native", fallback = "unknown") {
  return Object.fromEntries(
    RUNTIMES.map((name) => [name, name === runtimeName ? support : fallback])
  );
}

function supportForOs(osName, support = "native", fallback = "unknown") {
  return Object.fromEntries(
    OS_TARGETS.map((name) => [name, name === osName ? support : fallback])
  );
}

function matrixCapabilityForRecord(record) {
  if (record.type === "agent") return "agent";
  if (record.type === "skill") return "skill";
  if (record.type === "hook") return "hook";
  if (record.type === "command") return "command";
  if (["mcp_config", "mcp_server"].includes(record.type)) return "MCP";
  if (record.type === "runtime_tool") return runtimeCapabilityNameForTool(record.id);
  return null;
}

function applyRuntimeClaimBoundary(record, runtimeMatrix) {
  const matrixCapability = matrixCapabilityForRecord(record);
  if (!record.runtime || !matrixCapability) return record;
  const resolvedRoute = runtimeRouteEligibility(
    runtimeMatrix,
    matrixCapability,
    record.runtime,
  );
  return {
    ...record,
    runtimeSupport: runtimeSupportForCapability(runtimeMatrix, matrixCapability),
    routeEligibility:
      record.routeEligibility === "callable" && resolvedRoute === "callable"
        ? "callable"
        : "reference",
    runtimeClaimMode: "interactive_host",
  };
}

const PROVIDER_TYPE_BY_TYPE = {
  agent: "agent",
  skill: "skill",
  script: "script",
  command: "tool",
  reference: "tool",
  hook: "hook",
  runtime_tool: "runtime",
  weapon: "tool",
  plugin: "external",
  plugin_bundle: "external",
  mcp_config: "MCP",
  mcp_server: "MCP",
  config: "tool",
  os: "OS",
  memory: "memory",
  graph: "graph",
  external: "external",
};

const GLOBAL_INVENTORY_TYPE_TO_RECORD_TYPE = {
  agents: "agent",
  skills: "skill",
  hooks: "hook",
  plugins: "plugin",
  commands: "command",
  rules: "reference",
  prompts: "reference",
  mcpServers: "mcp_server",
  mcpTools: "mcp_server",
};

const GLOBAL_PROVIDER_ROUTE_ELIGIBILITY = {
  agents: "governance_owner",
  skills: "callable",
  hooks: "callable",
  plugins: "requires_provider_validation",
  commands: "callable",
  rules: "reference",
  prompts: "reference",
  mcpServers: "callable",
  mcpTools: "callable",
};

function riskLevelFor(record) {
  const riskText = JSON.stringify(record.risk ?? {}).toLowerCase();
  if (/credential|global|externalwrite|thirdparty|trust|approval|unsafe|delete|uninstall/.test(riskText)) {
    return "high";
  }
  if (/shell|mutate|write|install|network/.test(riskText)) return "medium";
  return "low";
}

function ownerBoundaryFor(record) {
  if (record.ownerBoundary) return record.ownerBoundary;
  if (record.type === "agent" && String(record.id).startsWith("meta-")) return "governance_owner";
  if (record.providerType === "MCP" || record.type === "mcp_config") return "provider_boundary";
  if (record.routeEligibility === "callable") return "callable_provider";
  if (record.routeEligibility === "reference") return "reference_only";
  return record.ownerCandidates?.[0] ?? "unknown_owner_boundary";
}

function homeRelativePath(filePath) {
  if (!filePath || typeof filePath !== "string") return null;
  const normalizedPath = path.resolve(filePath);
  const homeDir = path.resolve(os.homedir());
  const relativeToHome = path.relative(homeDir, normalizedPath);
  if (!relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome)) {
    return `~/${toPosix(relativeToHome)}`;
  }
  return toPosix(filePath);
}

function cachedGlobalSourcePath(entry, fallback) {
  const sourceRef = toPosix(String(entry?.sourceRef ?? "").trim());
  if (
    /^~\/(?:[A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._-]+)*$/u.test(sourceRef) &&
    sourceRef.split("/").every((segment) => ![".", ".."].includes(segment))
  ) {
    return sourceRef;
  }
  return homeRelativePath(entry?.path) ?? fallback;
}

async function readJsonIfExists(relativePath) {
  try {
    return await readJson(relativePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function canVerify(record) {
  return Boolean(record.verificationMethod) || /validate|verify|check|test|probe|smoke/i.test(
    `${record.id} ${record.invocationPath ?? ""} ${record.sourcePath ?? ""}`
  );
}

function withUnifiedCapabilityFields(record) {
  const providerType = record.providerType ?? PROVIDER_TYPE_BY_TYPE[record.type] ?? "tool";
  const routeEligibility = record.routeEligibility ?? "reference";
  const executableProvider =
    !["config", "mcp_config", "reference", "memory", "graph", "external"].includes(record.type) &&
    record.configOnly !== true;
  const canExecute =
    executableProvider &&
    routeEligibility === "callable" &&
    record.risk?.blocked !== true;
  return {
    ...record,
    capabilityId: record.capabilityId ?? record.id,
    providerType,
    sourceRef: record.sourceRef ?? record.sourcePath,
    riskLevel: record.riskLevel ?? riskLevelFor({ ...record, providerType }),
    ownerBoundary: ownerBoundaryFor({ ...record, providerType }),
    canExecute,
    canReview:
      record.canReview ??
      (Boolean(record.ownerCandidates?.includes("meta-prism")) ||
        ["agent", "script", "tool", "runtime", "hook", "MCP"].includes(providerType)),
    canVerify: record.canVerify ?? canVerify(record),
    canCreateOrUpgrade:
      record.canCreateOrUpgrade ??
      ["agent", "skill", "script", "tool", "hook", "MCP", "external"].includes(providerType),
    missingDependencies: record.missingDependencies ?? [],
    reason:
      record.reason ??
      `${providerType} capability discovered from ${record.sourcePath ?? record.sourceRef ?? "unknown source"}.`,
  };
}

async function packageScripts() {
  const pkg = await readJson("package.json");
  return Object.entries(pkg.scripts ?? {}).map(([id, command]) => ({
    id,
    type: "command",
    sourcePath: "package.json",
    invocationPath: `npm run ${id}`,
    triggerWords: [id, ...String(command).split(/\s+/).filter((part) => /^meta:|node|npm|graphify|validate|discover|probe/.test(part)).slice(0, 8)],
    ownerCandidates: ["meta-artisan", "meta-prism"],
    weaponCandidates: [id],
    dependencyCandidates: [],
    verificationMethod: id.includes("validate") || id.includes("check") || id.includes("test") ? `npm run ${id}` : null,
    risk: { canExecuteShell: true, requiresApproval: false },
    mustPreserve: /sync|install|uninstall|doctor|status|validate|verify|graphify|deps|runtime|os|test/.test(id),
    routeEligibility: "callable",
    missingFields: [],
    evidence: { source: "local_file", sourceRef: "package.json", confidence: "verified_local" },
    confidence: "verified_local",
    writebackKey: `command:${id}`,
    ...defaultSupport("partial", "partial"),
  }));
}

async function fileRecordIfExists(relativePath, options) {
  if (!(await exists(repoPath(relativePath)))) return [];
  return [
    {
      id: options.id,
      type: options.type,
      providerType: options.providerType,
      sourcePath: relativePath,
      triggerWords: options.triggerWords ?? [options.id, options.type],
      ownerCandidates: options.ownerCandidates ?? ["meta-artisan"],
      weaponCandidates: options.weaponCandidates ?? [],
      dependencyCandidates: options.dependencyCandidates ?? [],
      verificationMethod: options.verificationMethod ?? null,
      risk: options.risk ?? { canMutateFiles: false },
      configOnly: options.configOnly ?? false,
      mustPreserve: options.mustPreserve ?? true,
      routeEligibility: options.routeEligibility ?? "reference",
      missingFields: [],
      evidence: { source: "local_file", sourceRef: relativePath, confidence: "verified_local" },
      confidence: options.confidence ?? "verified_local",
      invocationPath: options.invocationPath ?? null,
      writebackKey: `${options.type}:${options.id}`,
      runtimeSupport: options.runtime
        ? supportForRuntime(
            options.runtime,
            options.runtimeSupport ?? "native",
            options.fallbackRuntimeSupport ?? "unknown",
          )
        : defaultSupport(options.runtimeSupport ?? "partial", options.osSupport ?? "partial").runtimeSupport,
      osSupport: options.os
        ? supportForOs(
            options.os,
            options.osSupport ?? "native",
            options.fallbackOsSupport ?? "unknown",
          )
        : defaultSupport(options.runtimeSupport ?? "partial", options.osSupport ?? "partial").osSupport,
    },
  ];
}

async function fileCapabilities(root, type, ownerCandidates, options = {}) {
  const files = await listFiles(repoPath(root), (file) => options.match ? options.match(file) : true);
  return files.map((file) => {
    const rel = toPosix(path.relative(repoPath("."), file));
    const id = options.id ? options.id(file) : path.basename(file, path.extname(file));
    return {
      id,
      type,
      sourcePath: rel,
      triggerWords: [id, type],
      ownerCandidates,
      weaponCandidates: options.weaponCandidates ?? [],
      dependencyCandidates: [],
      verificationMethod: options.verificationMethod ?? null,
      risk: options.risk ?? { canMutateFiles: false },
      configOnly: options.configOnly ?? false,
      mustPreserve: Boolean(options.mustPreserve),
      routeEligibility: options.routeEligibility ?? "reference",
      missingFields: [],
      evidence: { source: "local_file", sourceRef: rel, confidence: "verified_local" },
      confidence: "verified_local",
      invocationPath: options.invocationPath ?? null,
      writebackKey: `${type}:${id}`,
      runtimeSupport: options.runtime
        ? supportForRuntime(
            options.runtime,
            options.runtimeSupport ?? "native",
            options.fallbackRuntimeSupport ?? "unknown",
          )
        : defaultSupport(options.runtimeSupport ?? "partial", options.osSupport ?? "partial").runtimeSupport,
      osSupport: options.os
        ? supportForOs(
            options.os,
            options.osSupport ?? "native",
            options.fallbackOsSupport ?? "unknown",
          )
        : defaultSupport(options.runtimeSupport ?? "partial", options.osSupport ?? "partial").osSupport,
    };
  });
}

async function runtimeMirrorCapabilities() {
  return [
    ...(await fileCapabilities(".claude/agents", "agent", ["meta-warden"], { match: (file) => file.endsWith(".md"), mustPreserve: true, routeEligibility: "governance_owner", runtime: "claude_code" })),
    ...(await fileCapabilities(".codex/agents", "agent", ["meta-warden"], { match: (file) => file.endsWith(".toml"), mustPreserve: true, routeEligibility: "governance_owner", runtime: "codex" })),
    ...(await fileCapabilities(".cursor/agents", "agent", ["meta-warden"], { match: (file) => file.endsWith(".md"), mustPreserve: true, routeEligibility: "governance_owner", runtime: "cursor" })),
    ...(await fileCapabilities("openclaw/workspaces", "agent", ["meta-warden"], {
      match: (file) => path.basename(file) === "SOUL.md",
      id: (file) => path.basename(path.dirname(file)),
      mustPreserve: true,
      routeEligibility: "governance_owner",
      runtime: "openclaw",
    })),
    ...(await fileCapabilities(".agents/skills", "skill", ["meta-artisan"], { match: (file) => path.basename(file) === "SKILL.md", mustPreserve: true, routeEligibility: "callable", runtime: "codex", invocationPath: "project skill trigger" })),
    ...(await fileCapabilities(".claude/skills", "skill", ["meta-artisan"], { match: (file) => path.basename(file) === "SKILL.md", mustPreserve: true, routeEligibility: "callable", runtime: "claude_code", invocationPath: "project skill trigger" })),
    ...(await fileCapabilities(".cursor/skills", "skill", ["meta-artisan"], { match: (file) => path.basename(file) === "SKILL.md", mustPreserve: true, routeEligibility: "callable", runtime: "cursor", invocationPath: "project skill trigger" })),
    ...(await fileCapabilities("openclaw/skills", "skill", ["meta-artisan"], { match: (file) => path.basename(file) === "SKILL.md", mustPreserve: true, routeEligibility: "callable", runtime: "openclaw", invocationPath: "project skill trigger" })),
    ...(await fileCapabilities(".claude/hooks", "hook", ["meta-sentinel"], { match: (file) => /\.(mjs|js|cjs|ts|py|sh)$/.test(file), mustPreserve: true, routeEligibility: "callable", runtime: "claude_code" })),
    ...(await fileCapabilities(".codex/hooks", "hook", ["meta-sentinel"], { match: (file) => /\.(mjs|js|cjs|ts|py|sh)$/.test(file), mustPreserve: true, routeEligibility: "callable", runtime: "codex" })),
    ...(await fileCapabilities(".cursor/hooks", "hook", ["meta-sentinel"], { match: (file) => /\.(mjs|js|cjs|ts|py|sh)$/.test(file), mustPreserve: true, routeEligibility: "callable", runtime: "cursor" })),
    ...(await fileCapabilities("openclaw/hooks", "hook", ["meta-sentinel"], { match: (file) => /\.(mjs|js|cjs|ts|py|sh)$/.test(file), mustPreserve: true, routeEligibility: "callable", runtime: "openclaw" })),
    ...(await fileCapabilities(".claude/commands", "command", ["meta-artisan"], { match: (file) => /\.(md|toml|ya?ml)$/.test(file), mustPreserve: true, routeEligibility: "callable", runtime: "claude_code" })),
    ...(await fileCapabilities(".codex/commands", "command", ["meta-artisan"], { match: (file) => /\.(md|toml|ya?ml)$/.test(file), mustPreserve: true, routeEligibility: "callable", runtime: "codex" })),
    ...(await fileCapabilities(".cursor/rules", "reference", ["meta-artisan", "meta-prism"], { match: (file) => /\.(mdc|md)$/.test(file), mustPreserve: true, routeEligibility: "reference", runtime: "cursor" })),
    ...(await fileRecordIfExists(".claude/settings.json", { id: "claude-settings", type: "config", providerType: "hook", runtime: "claude_code", ownerCandidates: ["meta-sentinel"], routeEligibility: "reference", configOnly: true })),
    ...(await fileRecordIfExists(".codex/hooks.json", { id: "codex-hooks", type: "config", providerType: "hook", runtime: "codex", ownerCandidates: ["meta-sentinel"], routeEligibility: "reference", configOnly: true })),
    ...(await fileRecordIfExists(".cursor/hooks.json", { id: "cursor-hooks", type: "config", providerType: "hook", runtime: "cursor", ownerCandidates: ["meta-sentinel"], routeEligibility: "reference", configOnly: true })),
    ...(await fileRecordIfExists("openclaw/openclaw.template.json", { id: "openclaw-template", type: "hook", runtime: "openclaw", ownerCandidates: ["meta-sentinel"], routeEligibility: "reference" })),
  ];
}

async function globalRuntimeCapabilities(projectProjectionMode) {
  if (projectProjectionMode !== "global_only") return [];

  const inventory = await readJsonIfExists(
    `${profileStatePath}/capability-index/global-capabilities.json`,
  );
  const byPlatform = inventory?.byPlatform;
  if (!byPlatform || typeof byPlatform !== "object") return [];

  const records = [];
  for (const [platformKey, platformRecord] of Object.entries(byPlatform)) {
    const platformId = platformRecord?.platformId ?? platformKey;
    const capabilities = platformRecord?.capabilities ?? {};
    for (const [capabilityType, entries] of Object.entries(capabilities)) {
      if (!Array.isArray(entries)) continue;
      const recordType =
        GLOBAL_INVENTORY_TYPE_TO_RECORD_TYPE[capabilityType] ?? "external";
      for (const entry of entries) {
        if (capabilityType !== "agents") {
          continue;
        }
        const sourcePath = cachedGlobalSourcePath(
          entry,
          `global:${platformId}:${capabilityType}:${entry?.id ?? "unknown"}`,
        );
        const id = `global:${platformId}:${capabilityType}:${entry?.id ?? path.basename(sourcePath)}`;
        records.push({
          id,
          type: recordType,
          sourcePath,
          sourceRef: sourcePath,
          triggerWords: [
            entry?.id,
            entry?.metadata?.name,
            capabilityType,
            platformId,
          ].filter(Boolean),
          ownerCandidates: [entry?.id].filter(Boolean),
          weaponCandidates: [],
          dependencyCandidates: [],
          verificationMethod: "npm run discover:global",
          risk: {
            globalProvider: true,
            platformId,
            capabilityType,
          },
          configOnly: false,
          mustPreserve: String(entry?.id ?? "").startsWith("meta-"),
          routeEligibility:
            GLOBAL_PROVIDER_ROUTE_ELIGIBILITY[capabilityType] ?? "reference",
          missingFields: [],
          evidence: {
            source: "cached_global_inventory",
            sourceRef: sourcePath,
            confidence: "verified_local",
          },
          confidence: "verified_local",
          invocationPath: sourcePath,
          writebackKey: `global:${platformId}:${capabilityType}:${entry?.id ?? sourcePath}`,
          runtimeSupport: supportForRuntime(
            platformId === "claudeCode" ? "claude_code" : platformId,
            "native",
            "unknown",
          ),
          osSupport: defaultSupport("partial", "native").osSupport,
          reason:
            "Global runtime provider discovered from cached global capability inventory because projectProjectionMode=global_only.",
        });
      }
    }
  }
  return records;
}

async function mcpCapabilities() {
  return [
    ...(await fileRecordIfExists(".mcp.json", { id: "project-mcp-config", type: "mcp_config", providerType: "MCP", ownerCandidates: ["meta-artisan", "meta-sentinel"], routeEligibility: "reference", configOnly: true, verificationMethod: "npm run meta:test:mcp" })),
    ...(await fileRecordIfExists(".cursor/mcp.json", { id: "cursor-mcp-config", type: "mcp_config", providerType: "MCP", runtime: "cursor", ownerCandidates: ["meta-artisan", "meta-sentinel"], routeEligibility: "reference", configOnly: true })),
    ...(await fileRecordIfExists(".codex/config.toml", { id: "codex-mcp-config", type: "mcp_config", providerType: "MCP", runtime: "codex", ownerCandidates: ["meta-artisan", "meta-sentinel"], routeEligibility: "reference", configOnly: true })),
    ...(await fileRecordIfExists("scripts/mcp/meta-runtime-server.mjs", { id: "meta-kim-runtime-mcp-server", type: "mcp_server", providerType: "MCP", ownerCandidates: ["meta-artisan", "meta-sentinel"], routeEligibility: "callable", verificationMethod: "npm run meta:test:mcp" })),
  ];
}

async function configAndStateCapabilities() {
  return [
    ...(await fileCapabilities("config/capability-index", "config", ["meta-artisan", "meta-prism"], { match: (file) => file.endsWith(".json"), mustPreserve: true, routeEligibility: "reference", verificationMethod: "npm run meta:validate" })),
    ...(await fileCapabilities("config/contracts", "config", ["meta-prism"], { match: (file) => file.endsWith(".json") || file.endsWith(".md"), mustPreserve: true, routeEligibility: "reference", verificationMethod: "npm run meta:validate" })),
    ...(await fileRecordIfExists("canonical/runtime-assets/shared/hooks/meta-kim-memory-save.mjs", { id: "canonical-memory-save-hook", type: "memory", providerType: "memory", ownerCandidates: ["meta-librarian", "meta-sentinel"], routeEligibility: "reference", verificationMethod: "npm run meta:check:global:release" })),
    ...(await fileRecordIfExists("canonical/runtime-assets/claude/hooks/stop-memory-save.mjs", { id: "canonical-stop-memory-save-hook", type: "memory", providerType: "memory", ownerCandidates: ["meta-librarian", "meta-sentinel"], routeEligibility: "reference", verificationMethod: "npm run meta:check:global:release" })),
    ...(await fileRecordIfExists(`${profileStatePath}/capability-index/global-capabilities.json`, { id: "cached-global-capability-inventory", type: "external", providerType: "external", ownerCandidates: ["meta-librarian", "meta-artisan"], routeEligibility: "reference", verificationMethod: "npm run discover:global" })),
    ...(await fileRecordIfExists(`${profileStatePath}/capability-inventory.json`, { id: "local-capability-inventory-state", type: "memory", providerType: "memory", ownerCandidates: ["meta-librarian"], routeEligibility: "reference", verificationMethod: "npm run meta:capabilities:index" })),
    ...(await fileRecordIfExists(`${profileStatePath}/run-index.sqlite`, { id: "run-index-state", type: "memory", providerType: "memory", ownerCandidates: ["meta-librarian"], routeEligibility: "reference", verificationMethod: "npm run meta:rebuild:run-index" })),
    ...(await fileRecordIfExists("graphify-out/GRAPH_REPORT.md", { id: "graphify-report", type: "graph", providerType: "graph", ownerCandidates: ["meta-librarian", "meta-conductor"], routeEligibility: "reference", verificationMethod: "npm run meta:graphify:check" })),
    ...(await fileRecordIfExists("graphify-out/graph.json", { id: "graphify-graph", type: "graph", providerType: "graph", ownerCandidates: ["meta-librarian", "meta-conductor"], routeEligibility: "reference", verificationMethod: "npm run meta:graphify:check" })),
  ];
}

export async function buildCapabilityInventory() {
  const dependencies = await readJson("config/capability-index/dependency-project-registry.json");
  const weapons = await readJson("config/capability-index/weapon-registry.json");
  const skills = await readJson("config/skills.json");
  const runtimeMatrix = await readJson("config/runtime-capability-matrix.json");
  const osMatrix = await readJson("config/os-compatibility-matrix.json");
  const localOverrides = await readJsonIfExists(".meta-kim/local.overrides.json");
  const projectProjectionMode = localOverrides?.projectProjectionMode ?? "project";
  const records = [
    ...(await fileCapabilities("canonical/agents", "agent", ["meta-warden"], { match: (file) => file.endsWith(".md"), mustPreserve: true, routeEligibility: "governance_owner" })),
    ...(await fileCapabilities("canonical/skills", "skill", ["meta-artisan"], { match: (file) => path.basename(file) === "SKILL.md", mustPreserve: true, routeEligibility: "callable", invocationPath: "skill trigger" })),
    ...(await fileCapabilities("canonical/skills/meta-theory/references", "reference", ["meta-conductor", "meta-prism"], { match: (file) => file.endsWith(".md"), mustPreserve: true })),
    ...(await fileCapabilities("scripts", "script", ["meta-artisan", "meta-prism"], { match: (file) => file.endsWith(".mjs"), mustPreserve: true, routeEligibility: "callable", invocationPath: "node <script>" })),
    ...(await fileCapabilities("canonical/runtime-assets", "hook", ["meta-sentinel"], { match: (file) => /hooks|memory-hooks/.test(file), mustPreserve: true, routeEligibility: "callable" })),
    ...(await runtimeMirrorCapabilities()),
    ...(await globalRuntimeCapabilities(projectProjectionMode)),
    ...(await mcpCapabilities()),
    ...(await configAndStateCapabilities()),
    ...(await packageScripts()),
  ];
  for (const platform of runtimeMatrix.platforms ?? []) {
    const hasExecutableCapability = (platform.capabilities ?? []).some((capability) =>
      Object.values(capability.claimsByMode ?? {}).some(claimIsExecutable));
    records.push({
      id: `runtime:${platform.platform}`,
      type: "runtime_tool",
      providerType: "runtime",
      sourcePath: "config/runtime-capability-matrix.json",
      triggerWords: [platform.platform, "runtime"],
      ownerCandidates: ["meta-sentinel", "meta-artisan"],
      weaponCandidates: [],
      dependencyCandidates: [],
      runtimeSupport: supportForRuntime(platform.platform, hasExecutableCapability ? "native" : "partial", "unknown"),
      osSupport: defaultSupport("partial", "partial").osSupport,
      verificationMethod: "npm run meta:runtime:validate",
      risk: { runtimeBoundary: true },
      mustPreserve: true,
      routeEligibility: hasExecutableCapability ? "callable" : "reference",
      missingFields: [],
      evidence: { source: "local_file", sourceRef: "config/runtime-capability-matrix.json", confidence: "repo_claim" },
      confidence: "repo_claim",
      invocationPath: "runtime adapter",
      writebackKey: `runtime:${platform.platform}`,
    });
  }
  for (const osTarget of osMatrix.operatingSystems ?? []) {
    records.push({
      id: `os:${osTarget.id}`,
      type: "os",
      providerType: "OS",
      sourcePath: "config/os-compatibility-matrix.json",
      triggerWords: [osTarget.id, "os"],
      ownerCandidates: ["meta-sentinel", "meta-artisan"],
      weaponCandidates: [],
      dependencyCandidates: [],
      runtimeSupport: defaultSupport("partial", "partial").runtimeSupport,
      osSupport: supportForOs(osTarget.id, "native", "partial"),
      verificationMethod: "npm run meta:os:check",
      risk: { osBoundary: true },
      mustPreserve: true,
      routeEligibility: "reference",
      missingFields: [],
      evidence: { source: "local_file", sourceRef: "config/os-compatibility-matrix.json", confidence: "repo_claim" },
      confidence: "repo_claim",
      invocationPath: null,
      writebackKey: `os:${osTarget.id}`,
    });
  }
  for (const tool of ["shell", "filesystem", "apply_patch", "browser", "web_search", "online_research", "MCP", "memory", "graph", "graphify", "hook", "command", "subagent", "approval", "sandbox"]) {
    const matrixCapability = runtimeCapabilityNameForTool(tool);
    const runtimeSupport = runtimeSupportForCapability(runtimeMatrix, matrixCapability);
    const callableSomewhere = RUNTIMES.some((runtime) =>
      runtimeRouteEligibility(runtimeMatrix, matrixCapability, runtime) === "callable");
    records.push({
      id: tool,
      type: "runtime_tool",
      sourcePath: "config/runtime-capability-matrix.json",
      triggerWords: [tool, tool.replace(/_/g, " ")],
      ownerCandidates: ["meta-artisan", "meta-sentinel", "meta-scout"],
      weaponCandidates: [tool],
      dependencyCandidates: [],
      runtimeSupport,
      osSupport: defaultSupport("partial", "partial").osSupport,
      verificationMethod: "npm run meta:runtime:validate",
      risk: { requiresApproval: ["shell", "filesystem", "apply_patch"].includes(tool) },
      mustPreserve: true,
      routeEligibility: callableSomewhere ? "callable" : "reference",
      missingFields: [],
      evidence: { source: "local_file", sourceRef: "config/runtime-capability-matrix.json", confidence: "repo_claim" },
      confidence: "repo_claim",
      invocationPath: tool,
      writebackKey: `runtime_tool:${tool}`,
    });
  }
  for (const weapon of weapons.weapons ?? []) {
    records.push({
      id: weapon.id,
      type: weapon.type ?? "weapon",
      sourcePath: "config/capability-index/weapon-registry.json",
      triggerWords: weapon.triggerConditions ?? [],
      ownerCandidates: weapon.ownerCandidates ?? [],
      weaponCandidates: [weapon.id],
      dependencyCandidates: weapon.dependencyProjects ?? [],
      runtimeSupport: weapon.runtimeSupport ?? defaultSupport().runtimeSupport,
      osSupport: weapon.osSupport ?? defaultSupport().osSupport,
      verificationMethod: weapon.verification?.command ?? null,
      risk: weapon.risk ?? {},
      mustPreserve: true,
      routeEligibility: "callable",
      missingFields: [],
      evidence: { source: "local_file", sourceRef: "config/capability-index/weapon-registry.json", confidence: "verified_local" },
      confidence: "verified_local",
      invocationPath: weapon.howToTrigger?.explicit ?? null,
      writebackKey: `weapon:${weapon.id}`,
    });
  }
  for (const skill of skills.skills ?? []) {
    const pluginIds = [
      skill.claudePlugin,
      skill.codexPlugin,
      skill.cursorPlugin,
    ].filter(Boolean);
    const isPlugin =
      skill.installMethod === "pluginMarketplace" || pluginIds.length > 0;
    if (!isPlugin && !skill.pluginHookCompat) continue;
    records.push({
      id: skill.id,
      type: isPlugin ? "plugin" : "plugin_bundle",
      ...defaultSupport("partial", "partial"),
      sourcePath: "config/skills.json",
      triggerWords: [skill.id, ...(skill.capabilities ?? [])],
      ownerCandidates: ["meta-artisan", "meta-sentinel"],
      weaponCandidates: pluginIds,
      dependencyCandidates: [skill.id],
      runtimeSupport: Object.fromEntries(RUNTIMES.map((runtime) => {
        const manifestRuntime = runtime === "claude_code" ? "claude" : runtime;
        return [
          runtime,
          (skill.targets ?? []).includes(manifestRuntime) ? "partial" : "unknown",
        ];
      })),
      osSupport: defaultSupport("partial", "partial").osSupport,
      verificationMethod: "npm run meta:providers:validate",
      risk: {
        thirdParty: true,
        requiresTrustReview: true,
        installMethod: skill.installMethod ?? "subdirExtraction",
      },
      mustPreserve: true,
      routeEligibility: "requires_provider_validation",
      missingFields: [],
      evidence: {
        source: "local_file",
        sourceRef: "config/skills.json",
        confidence: "verified_local",
      },
      confidence: "verified_local",
      invocationPath: pluginIds[0] ?? null,
      writebackKey: `provider:${skill.id}`,
    });
  }
  for (const project of dependencies.projects ?? []) {
    records.push({
      id: project.id,
      type: "external",
      providerType: "external",
      ...defaultSupport("partial", "partial"),
      sourcePath: "config/capability-index/dependency-project-registry.json",
      triggerWords: [project.id, project.name, ...(project.capabilityCard?.triggerConditions ?? [])].filter(Boolean),
      ownerCandidates: ["meta-scout", "meta-artisan", "meta-sentinel"],
      weaponCandidates: [],
      dependencyCandidates: [project.id],
      verificationMethod: "npm run meta:deps:compat",
      risk: {
        externalProject: true,
        routeEligibility: project.capabilityCard?.routeEligibility ?? "unknown",
      },
      mustPreserve: true,
      routeEligibility: project.capabilityCard?.routeEligibility ?? "reference",
      missingFields: [],
      evidence: {
        source: "local_file",
        sourceRef: "config/capability-index/dependency-project-registry.json",
        confidence: "verified_local",
      },
      confidence: "verified_local",
      invocationPath: project.interface?.invocationPath ?? null,
      writebackKey: `dependency:${project.id}`,
      reason: "External or dependency project capability candidate from the dependency registry.",
    });
  }
  const normalizedRecords = records
    .map((record) => applyRuntimeClaimBoundary(record, runtimeMatrix))
    .map(withUnifiedCapabilityFields);
  const byProviderType = normalizedRecords.reduce((counts, record) => {
    counts[record.providerType] = (counts[record.providerType] ?? 0) + 1;
    return counts;
  }, {});
  return {
    generatedAt: new Date().toISOString(),
    projectProjectionMode,
    capabilities: normalizedRecords,
    runtimeMatrixCapabilities: runtimeMatrix.capabilityNames ?? [],
    osTargets: (osMatrix.operatingSystems ?? []).map((entry) => entry.id),
    dependencyProjects: dependencies.projects ?? [],
    summary: {
      total: normalizedRecords.length,
      byProviderType,
      totalPlugins: normalizedRecords.filter((record) => record.type === "plugin").length,
      totalPluginBundles: normalizedRecords.filter((record) => record.type === "plugin_bundle").length,
      mustPreserve: normalizedRecords.filter((record) => record.mustPreserve).length,
      webSearchBrowserResearch: normalizedRecords.filter((record) => /web|browser|research|fetch|online/i.test(JSON.stringify(record))).length,
      memoryGraphMcpHook: normalizedRecords.filter((record) => /memory|graph|MCP|hook|graphify/i.test(JSON.stringify(record))).length,
    },
  };
}

export async function writeCapabilityInventory(targetPath = outputPath) {
  const result = await buildCapabilityInventory();
  await writeJson(targetPath, result);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await writeCapabilityInventory();
  console.log(`capability inventory written: ${result.capabilities?.length ?? 0} records (projectProjectionMode=${result.projectProjectionMode ?? "unknown"})`);
}
