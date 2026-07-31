#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { GOVERNANCE_OWNERS, OS_TARGETS, RUNTIMES, annotateCrossScopeAgentCollisions, classifyTaskShape, exists, readJson, repoPath, scoreRoute, stateDir, supportScore, toPosix } from "./governance-lib.mjs";
import { CAPABILITY_GAP_DECISION_CONTRACT, decideCapabilityGap } from "./capability-gap-mvp.mjs";
import { classifyMetaTheoryEntry } from "./meta-theory-entry-classifier.mjs";
import { loadRuntimeProfiles, resolveRuntimeProjection } from "./meta-kim-sync-config.mjs";
import {
  evaluateChoiceRequirement,
  resolveNativeChoiceSurface,
} from "./governed-execution/choice-policy.mjs";
import {
  resolveRuntimeCapabilityClaim,
  runtimeCapabilityNameForTool,
  runtimeSupportForCapability,
} from "./runtime-capability-claims.mjs";
import { loadEffectiveRuntimeCapabilityClaims } from "./effective-runtime-capability-claims.mjs";
import { evaluateRouteExecutionGate } from "./runtime-execution-gate.mjs";
import {
  sanitizeCapabilityPublicationText,
  sanitizeCapabilityPublicationValue,
} from "./capability-publication-sanitizer.mjs";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readStateJson(name, fallback) {
  const file = path.join(stateDir, name);
  return (await exists(file)) ? JSON.parse(await fs.readFile(file, "utf8")) : fallback;
}

const task = argValue("--task", "");
const requestedRouteRunId = argValue("--run-id", null);
const runtimeArg = argValue("--runtime", "auto");
const osArg = argValue("--os", "auto");
const requestedOwnerSourceKey = argValue("--owner-source", null);
const requestedOwnerSourceRef = argValue("--owner-source-ref", null);
const requestedOwnerContentDigest = String(
  argValue("--owner-content-digest", null) ?? "",
).replace(/^sha256:/iu, "").toLowerCase() || null;
const json = process.argv.includes("--json");
const rejectedCodexHostToolSchemaRaw =
  argValue("--codex-host-tool-schema", null) ??
  process.env.META_KIM_CODEX_HOST_TOOL_SCHEMA ??
  null;
const runtime = runtimeArg === "auto" ? "codex" : runtimeArg;
const osTarget = osArg === "auto" ? "windows" : osArg;
const taskShape = classifyTaskShape(task);
const taskText = String(task ?? "").toLowerCase();
const entryClassification = classifyMetaTheoryEntry(task);
const choiceSurfacePolicy = await readJson("config/governance/choice-surface-policy.json");

// An offline CLI process cannot attest the active Codex host's top-level tool
// schema. Caller-supplied JSON/env is retained only as rejected evidence; the
// interactive host must perform native binding from its own live tool surface.
const codexHostToolSchema = {
  status: "not_observed_in_offline_route_process",
  hostSurface: "spawn_agent",
  inputProperties: [],
  ownerSelectorField: null,
  evidenceSource: null,
  suppliedArtifactRejected: Boolean(rejectedCodexHostToolSchemaRaw),
  rejectedReason: rejectedCodexHostToolSchemaRaw
    ? "caller_supplied_host_schema_is_not_current_host_attestation"
    : null,
};
const entrySignals = entryClassification.signals ?? {};
const routeChangingDimensionSignals = entrySignals.routeChangingDimensionSignals ?? [];
const subjectiveRouteChoice = entrySignals.subjectiveQualitySignal === true;
const runtimeChoiceSurface = resolveNativeChoiceSurface(choiceSurfacePolicy, runtime);
const stateDirRef = toPosix(path.relative(repoPath("."), stateDir));
const GOVERNANCE_CHAIN_PREFIX_RE =
  /^critical(?:\s+thinking)?(?:\s*(?:->|=>|→|,|，|、|;|；|and)?\s+)fetch(?:\s*(?:->|=>|→|,|，|、|;|；|and)?\s+)(?:deep\s+)?thinking(?:\s*(?:->|=>|→|,|，|、|;|；|and)?\s+)review\s*/iu;
const concurrentDispatchIntentPresent =
  entrySignals.directParallelRequest === true ||
  entrySignals.structuredGovernanceChainRequest === true ||
  entrySignals.explicitMetaTheory === true ||
  entrySignals.productBuildIntent === true;
const nativeChoiceEvidenceRaw =
  argValue("--native-choice-evidence", null) ??
  process.env.META_KIM_NATIVE_CHOICE_EVIDENCE ??
  null;
function normalizeNativeChoiceEvidence(raw, expectedSurface) {
  const base = {
    completedStages: [],
  };
  if (!raw) {
    return {
      ...base,
      status: "missing",
      surface: null,
      answerRecorded: false,
      trusted: false,
    };
  }
  try {
    const parsed = JSON.parse(raw);
    const evidenceItems = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.choices)
        ? parsed.choices
        : Array.isArray(parsed.answers)
          ? parsed.answers
          : [parsed];
    const completedStages = evidenceItems
      .filter((item) => item?.status === "completed" || item?.state === "completed" || item?.answerRecorded === true)
      .map((item) => item.stage ?? item.choiceStage ?? item.checkpoint ?? parsed.stage ?? parsed.choiceStage ?? null)
      .filter(Boolean);
    const evidenceRefs = evidenceItems
      .filter((item) => item?.status === "completed" || item?.state === "completed" || item?.answerRecorded === true)
      .map((item) => item.evidenceRef ?? item.answerRef ?? parsed.evidenceRef ?? parsed.answerRef ?? null)
      .filter((ref) => typeof ref === "string" ? ref.trim().length > 0 : Boolean(ref));
    const answerRecorded =
      parsed.answerRecorded === true ||
      parsed.status === "completed" ||
      parsed.state === "completed" ||
      evidenceItems.some((item) => item?.status === "completed" || item?.state === "completed" || item?.answerRecorded === true);
    const surface = parsed.surface ?? parsed.hostSurface ?? evidenceItems.find((item) => item?.surface || item?.hostSurface)?.surface ?? evidenceItems.find((item) => item?.surface || item?.hostSurface)?.hostSurface ?? null;
    return {
      ...base,
      status: answerRecorded ? "completed" : (parsed.status ?? parsed.state ?? "present"),
      surface,
      answerRecorded,
      trusted: false,
      trustBoundary: "reference_only_cli_or_environment",
      expectedSurface,
      evidenceRef: parsed.evidenceRef ?? parsed.answerRef ?? null,
      evidenceRefs,
      completedStages,
    };
  } catch {
    return {
      ...base,
      status: "invalid",
      surface: null,
      answerRecorded: false,
      trusted: false,
    };
  }
}
const nativeChoiceEvidence = normalizeNativeChoiceEvidence(
  nativeChoiceEvidenceRaw,
  runtimeChoiceSurface.surface,
);
function hasChoiceStage(stage) {
  return nativeChoiceEvidence.trusted === true && nativeChoiceEvidence.completedStages.includes(stage);
}
const weapons = (await readJson("config/capability-index/weapon-registry.json")).weapons ?? [];
const registryDependencies = (await readJson("config/capability-index/dependency-project-registry.json")).projects ?? [];
const repoCapabilityIndex = await readJson("config/capability-index/meta-kim-capabilities.json");
const workflowContract = await readJson("config/contracts/workflow-contract.json");
const capabilityInventory = await readStateJson("capability-inventory.json", { capabilities: [] });
const globalCapabilityInventory = await readStateJson(path.join("capability-index", "global-capabilities.json"), { byCapabilityType: { agents: {} }, byPlatform: {} });
const dependencyIndex = await readStateJson("dependency-capability-index.json", { discoveredDependencyProjects: [] });
const intentContract = await readJson("config/governance/intent-amplification-contract.json");
const runtimeCapabilityState = loadEffectiveRuntimeCapabilityClaims({
  projectRoot: process.env.META_KIM_CALLER_CWD || repoPath("."),
});
const runtimeMatrix = runtimeCapabilityState.effectiveMatrix;
function activeRuntimeSupport() {
  const platform = runtimeMatrix.platforms?.find((entry) => entry.platform === runtime);
  const claims = (platform?.capabilities ?? []).map((capability) =>
    resolveRuntimeCapabilityClaim(runtimeMatrix, {
      runtime,
      capability: capability.capability,
      mode: "interactive_host",
    }));
  if (claims.some((claim) => claim.executable && claim.hostSupport === "native")) return "native";
  if (claims.some((claim) => claim.executable)) return "partial";
  if (claims.some((claim) => ["native", "partial"].includes(claim.hostSupport))) return "partial";
  return claims.some((claim) => claim.hostSupport === "unsupported") ? "unsupported" : "unknown";
}
const localOverrides = (await exists(repoPath(".meta-kim/local.overrides.json")))
  ? await readJson(".meta-kim/local.overrides.json")
  : {};
const projectProjectionMode = localOverrides.projectProjectionMode ?? "project";
const projectProjectionPolicy = {
  projectProjectionMode,
  projectRuntimeProvidersExpected: projectProjectionMode !== "global_only",
  validationProviderLayer: projectProjectionMode === "global_only" ? "local_global_runtime_inventory" : "project_runtime_inventory",
  reason: projectProjectionMode === "global_only"
    ? "Project runtime projections are intentionally skipped by local overrides; route validation must use local/global runtime inventory plus canonical provider sources."
    : "Project runtime projections may be materialized and should be validated when present.",
};

function textContains(entry, terms) {
  const text = JSON.stringify(entry).toLowerCase();
  return terms.some((term) => text.includes(term));
}

function taskContainsAny(terms) {
  return terms.some((term) => taskText.includes(term));
}

function implicitScriptCapabilityGapRequested() {
  const recurrenceSignal = taskContainsAny([
    "repeat",
    "recurring",
    "repeatedly",
    "every time",
    "stable",
    "每次",
    "反复",
    "重复",
    "稳定",
  ]);
  const deterministicSignal = taskContainsAny([
    "mechanical",
    "testable",
    "local",
    "deterministic",
    "json summary",
    "json report",
    "stage outputs",
    "verification owner",
    "decision output",
    "blocked gate reason",
    "机械",
    "可测试",
    "本地",
    "自动整理",
    "检测缺失",
  ]);
  const noAgentSignal = taskContainsAny([
    "no new agent",
    "no agent identity",
    "不需要新 agent",
    "不需要新agent",
    "不需要新 agent 身份",
    "不需要新长期身份",
  ]);
  return recurrenceSignal && deterministicSignal && noAgentSignal;
}

function agentProviderReuseConcernRequested() {
  const agentTarget = /agent|subagent|owner|智能体|代理/.test(taskText);
  const contextualAgentTarget =
    /(?:codex|meta[_ -]?kim|metakim|系统|它|他).{0,16}(?:创建|新建)/.test(taskText) &&
    /自己|一直|反复|不断|重复|老是|总是|好像/.test(taskText);
  if (!agentTarget && !contextualAgentTarget) return false;
  const creationComplaint =
    /一直(?:在)?(?:自己)?创建|一直.{0,12}创建|反复.{0,12}创建|不断.{0,12}创建|重复.{0,12}创建|老是.{0,12}创建|总是.{0,12}创建|自己创建|创建.*太多|keeps?\s+creating|creating\s+agents?|always\s+creates?/.test(taskText);
  const globalReuseSignal =
    /global|全局|已有|现有|复用|reuse|existing|找/.test(taskText);
  return creationComplaint || globalReuseSignal;
}

function explicitCapabilityGapRequested() {
  if (
    agentProviderReuseConcernRequested() &&
    !/capability gap|missing capability|missing dependency|缺能力|能力缺口|缺少能力|缺少依赖/.test(taskText)
  ) {
    return false;
  }
  return [
    "capability gap",
    "missing capability",
    "missing dependency",
    "imaginary provider",
    "unknown provider",
    "no provider",
    "create skill",
    "create agent",
    "create script",
    "create mcp",
    "缺能力",
    "能力缺口",
    "缺少能力",
    "缺少依赖",
    "不存在的 provider",
    "创建 skill",
    "创建 agent",
    "创建 script",
    "创建 mcp",
  ].some((term) => taskText.includes(term)) || implicitScriptCapabilityGapRequested();
}

function taskTerms() {
  if (taskShape === "goal_contract") return ["goal prompt", "loop prompt", "goal contract", "intent amplification", "goalpro", "目标契约", "目标合同", "意图放大"];
  if (taskShape === "strategy_product_decision") return ["strategy", "product", "decision", "monetization", "策略", "产品", "商业化", "变现"];
  if (taskShape === "platform_governance") return ["runtime", "platform", "hook", "os", "codex", "cursor", "openclaw", "claude", "平台", "钩子"];
  if (taskShape === "engineering_execution") return ["code", "test", "refactor", "engineering", "代码", "测试", "重构"];
  return ["governance", "capability", "workflow", "治理", "能力"];
}

function decisionAdjustmentRequested() {
  if (taskShape !== "strategy_product_decision") return false;
  if (productBuildExecutionRequested()) return false;
  return /decision|judge|判断|决策|选择|取舍|pass.?kill|要不要|值不值得|怎么改|怎么做|路径|方案|策略|高流量|标题|文案|封面/.test(taskText);
}

function fitsTask(entry) {
  const terms = taskTerms();
  if (taskShape === "fuzzy_complex_task") return true;
  return textContains(entry, terms) || /fuzzy|complex|governance|治理|复杂/.test(taskText);
}

function capabilityEntries(index, type) {
  return Object.values(index?.byCapabilityType?.[type] ?? {});
}

function rawPlatformCapabilityEntries(index, type) {
  return Object.values(index?.byPlatform ?? {}).flatMap(
    (platform) => platform?.capabilities?.[type] ?? [],
  );
}

function exactOwnerSourceSelected(entry) {
  if (!requestedOwnerSourceKey || !requestedOwnerContentDigest) return false;
  const sourceKeyMatches = String(entry?.sourceKey ?? "") === requestedOwnerSourceKey;
  const digestMatches = String(entry?.contentDigest ?? "")
    .replace(/^sha256:/iu, "")
    .toLowerCase() === requestedOwnerContentDigest;
  const sourceRefMatches = !requestedOwnerSourceRef ||
    toPosix(String(entry?.sourceRef ?? "")) === toPosix(String(requestedOwnerSourceRef));
  return sourceKeyMatches && digestMatches && sourceRefMatches;
}

function uniqueById(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

function uniqueStrings(items) {
  return [...new Set(items.filter(Boolean).map((item) => String(item)))];
}

function compactProviderMetadata(value) {
  if (Array.isArray(value)) return value.map(compactProviderMetadata);
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    return sanitizeCapabilityPublicationText(value, {
      repoRoot: repoPath("."),
      homeDir: process.env.USERPROFILE ?? process.env.HOME ?? "",
    });
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["path", "workspace", "baseDir"].includes(key))
      .map(([key, nested]) => [key, compactProviderMetadata(nested)]),
  );
}

function compactAgent(entry, source) {
  const layer = entry.layer ?? (String(entry.id ?? "").startsWith("meta-") ? "meta" : "execution");
  const sourceRef = entry.sourceRef ?? entry.sourcePath ?? entry.relativePath ?? (entry.platformId ? `${entry.platformId}:${entry.id}` : entry.id);
  return {
    id: entry.id,
    layer,
    source,
    platformId: entry.platformId ?? null,
    sourceRef: compactProviderMetadata(toPosix(sourceRef)),
    executionBlock: entry.executionBlock ?? layer === "meta",
    description: compactProviderMetadata(entry.description ?? null),
    own: compactProviderMetadata(entry.own ?? null),
    boundary: compactProviderMetadata(entry.boundary ?? null),
    trigger: compactProviderMetadata(entry.trigger ?? null),
    metadata: compactProviderMetadata(entry.metadata ?? null),
    validCustomAgentDefinition: entry.validCustomAgentDefinition ?? entry.metadata?.validCustomAgentDefinition ?? null,
    customAgentDefinitionErrors: entry.customAgentDefinitionErrors ?? entry.metadata?.customAgentDefinitionErrors ?? [],
    sourceClass: entry.sourceClass ?? null,
    sourceRoot: compactProviderMetadata(entry.sourceRoot ?? null),
    sourceKey: compactProviderMetadata(entry.sourceKey ?? null),
    sourcePriority: entry.sourcePriority ?? null,
    contentDigest: entry.contentDigest ?? null,
    nativeIdentity: entry.nativeIdentity ?? entry.nativeAgentName ?? entry.metadata?.nativeAgentName ?? entry.metadata?.name ?? entry.id,
    provenance: compactProviderMetadata(entry.provenance ?? []),
    collision: compactProviderMetadata(entry.collision ?? null),
    routeEligible: entry.routeEligible ?? true,
    sourceSelectedExplicitly: entry.sourceSelectedExplicitly === true,
    cacheEvidence: compactProviderMetadata(entry.cacheEvidence ?? null),
    cacheEvidenceOnly: entry.cacheEvidenceOnly === true,
  };
}

function compactCapabilityProvider(entry, source, type = entry.type ?? "skills") {
  const sourceRef = entry.sourcePath ?? entry.relativePath ?? (entry.platformId ? `${entry.platformId}:${entry.id}` : entry.path ?? entry.id);
  return {
    id: entry.id,
    type,
    source,
    platformId: entry.platformId ?? null,
    sourceRef: compactProviderMetadata(toPosix(sourceRef)),
    sourceClass: entry.sourceClass ?? null,
    sourceRoot: compactProviderMetadata(entry.sourceRoot ?? null),
    sourceKey: compactProviderMetadata(entry.sourceKey ?? null),
    sourcePriority: entry.sourcePriority ?? null,
    contentDigest: entry.contentDigest ?? null,
    nativeIdentity: entry.nativeIdentity ?? entry.id,
    provenance: compactProviderMetadata(entry.provenance ?? []),
    collision: compactProviderMetadata(entry.collision ?? null),
    routeEligible: entry.routeEligible ?? true,
  };
}

async function scanProjectFiles({ runtime: runtimeName, dir, type, source, extensions, recursive = false, maxDepth = 2 }) {
  const providers = [];
  const root = repoPath(dir);
  if (!(await exists(root))) return providers;

  async function visit(absDir, relDir, depth) {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(absDir, entry.name);
      const relPath = path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && depth < maxDepth) await visit(absPath, relPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue;
      const id = relPath.replace(/\.[^.]+$/, "").replace(/\\/g, "/");
      providers.push({
        id,
        type,
        source,
        runtime: runtimeName,
        sourceRef: toPosix(path.join(dir, relPath)),
      });
    }
  }

  await visit(root, "", 0);
  return providers;
}

async function projectRuntimeAgents() {
  const dirs = [
    { runtime: "claude_code", dir: ".claude/agents", extension: ".md" },
    { runtime: "codex", dir: ".codex/agents", extension: ".toml" },
    { runtime: "cursor", dir: ".cursor/agents", extension: ".md" },
  ];
  const agents = [];
  for (const { runtime: runtimeName, dir, extension } of dirs) {
    const absDir = repoPath(dir);
    if (!(await exists(absDir))) continue;
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
      const inventoryId = entry.name.slice(0, -extension.length);
      let id = inventoryId;
      const layer = id.startsWith("meta-") ? "meta" : "execution";
      let metadata = null;
      let validCustomAgentDefinition = null;
      let customAgentDefinitionErrors = [];
      let contentDigest = null;
      if (runtimeName === "codex") {
        const content = await fs.readFile(path.join(absDir, entry.name), "utf8");
        contentDigest = createHash("sha256").update(content).digest("hex");
        ({ metadata, errors: customAgentDefinitionErrors } = parseCodexAgentDefinition(content));
        validCustomAgentDefinition = customAgentDefinitionErrors.length === 0;
        if (validCustomAgentDefinition) id = metadata.name;
      }
      agents.push({
        id,
        layer,
        source: "project_runtime_agent_inventory",
        runtime: runtimeName,
        sourceRef: toPosix(path.join(dir, entry.name)),
        executionBlock: layer === "meta",
        metadata,
        validCustomAgentDefinition,
        customAgentDefinitionErrors,
        inventoryId,
        sourceClass: "project",
        sourcePriority: 100,
        nativeIdentity: id,
        contentDigest,
        sourceKey: `${runtimeName}:agents:${id}:project:${toPosix(path.join(dir, entry.name))}`,
      });
    }
  }
  const openclawWorkspaces = repoPath("openclaw/workspaces");
  if (await exists(openclawWorkspaces)) {
    const entries = await fs.readdir(openclawWorkspaces, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const soulPath = path.join("openclaw/workspaces", entry.name, "SOUL.md");
      if (!(await exists(repoPath(soulPath)))) continue;
      const id = entry.name;
      const layer = id.startsWith("meta-") ? "meta" : "execution";
      agents.push({
        id,
        layer,
        source: "project_runtime_agent_inventory",
        runtime: "openclaw",
        sourceRef: toPosix(soulPath),
        executionBlock: layer === "meta",
      });
    }
  }
  return agents;
}

function parseCodexAgentDefinition(content) {
  const scalar = (key) => {
    const triple = content.match(
      new RegExp(`^${key}\\s*=\\s*(?:\"\"\"|''')([\\s\\S]*?)(?:\"\"\"|''')`, "mu"),
    );
    if (triple) return triple[1].trim();
    const single = content.match(new RegExp(`^${key}\\s*=\\s*[\"']([^\"']+)[\"']`, "mu"));
    return single?.[1]?.trim() ?? null;
  };
  const metadata = {
    name: scalar("name"),
    description: scalar("description"),
    developer_instructions: scalar("developer_instructions"),
  };
  return {
    metadata,
    errors: [
      ...(!metadata.name ? ["missing_name"] : []),
      ...(!metadata.description ? ["missing_description"] : []),
      ...(!metadata.developer_instructions ? ["missing_developer_instructions"] : []),
    ],
  };
}

async function globalRuntimeAgentProviders() {
  const profileId = runtime === "claude_code" ? "claude" : runtime;
  const profiles = await loadRuntimeProfiles();
  const profile = profiles[profileId];
  const agentProjection = profile?.projection?.globalAgentProjection;
  if (!agentProjection?.supported) return [];

  const projection = resolveRuntimeProjection(profileId, "global");
  const agentsDir = projection.agentsDir;
  if (!agentsDir || !(await exists(agentsDir))) return [];
  const userHome = process.env.USERPROFILE ?? process.env.HOME ?? projection.baseDir;

  const providers = [];
  const entries = await fs.readdir(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(agentProjection.fileExtension)) continue;
    const inventoryId = entry.name.slice(0, -agentProjection.fileExtension.length);
    let id = inventoryId;
    let metadata = null;
    let customAgentDefinitionErrors = [];
    let validCustomAgentDefinition = null;
    const agentPath = path.join(agentsDir, entry.name);
    const content = await fs.readFile(agentPath, "utf8");
    if (agentProjection.format === "codex_toml") {
      ({ metadata, errors: customAgentDefinitionErrors } = parseCodexAgentDefinition(content));
      validCustomAgentDefinition = customAgentDefinitionErrors.length === 0;
      if (validCustomAgentDefinition) id = metadata.name;
    }
    const layer = id.startsWith("meta-") ? "meta" : "execution";
    const platformId = runtime === "claude_code" ? "claudeCode" : runtime;
    const sourceRef = `~/${toPosix(path.relative(userHome, agentPath))}`;
    const sourceRoot = `~/${toPosix(path.relative(userHome, agentsDir))}`;
    const contentDigest = createHash("sha256").update(content).digest("hex");
    providers.push({
      id,
      inventoryId,
      layer,
      source: "local_global_agent_inventory",
      runtime,
      platformId,
      sourceClass: "personal",
      sourceRoot,
      sourceRef,
      sourcePriority: 300,
      nativeIdentity: id,
      contentDigest,
      sourceKey: `${platformId}:agents:${id}:personal:${sourceRef}`,
      executionBlock: layer === "meta",
      metadata,
      validCustomAgentDefinition,
      customAgentDefinitionErrors,
    });
  }
  const byNativeIdentity = new Map();
  for (const provider of providers) {
    const group = byNativeIdentity.get(provider.nativeIdentity) ?? [];
    group.push(provider);
    byNativeIdentity.set(provider.nativeIdentity, group);
  }
  return [...byNativeIdentity.values()].map((group) => {
    const candidates = [...group].sort((left, right) =>
      String(left.sourceRef).localeCompare(String(right.sourceRef)));
    const winner = candidates[0];
    const distinctDigests = [...new Set(candidates.map((entry) => entry.contentDigest))];
    const exactDuplicate = candidates.length > 1 && distinctDigests.length === 1;
    const ambiguous = runtime === "codex" && candidates.length > 1 && !exactDuplicate;
    const provenance = candidates.map((entry) => ({
      id: entry.id,
      inventoryId: entry.inventoryId,
      sourceClass: entry.sourceClass,
      sourceRoot: entry.sourceRoot,
      sourceRef: entry.sourceRef,
      contentDigest: entry.contentDigest,
      nativeIdentity: entry.nativeIdentity,
      sourcePriority: entry.sourcePriority,
      sourceKey: entry.sourceKey,
      sourceValid: entry.validCustomAgentDefinition !== false,
    }));
    const collision = {
      detected: candidates.length > 1,
      kind: candidates.length <= 1
        ? "none"
        : exactDuplicate
          ? "exact_duplicate"
          : "conflicting_definitions",
      candidateCount: candidates.length,
      distinctContentDigests: distinctDigests,
      winnerSourceKey: winner.sourceKey,
      winnerSourceRef: winner.sourceRef,
      exactDuplicate,
      ambiguous,
      routeEligible: !ambiguous && winner.validCustomAgentDefinition !== false,
      evidenceSource: "live_filesystem",
    };
    return {
      ...winner,
      sourceCandidates: candidates.map((entry) => ({
        ...entry,
        provenance,
        collision,
      })),
      provenance,
      collision,
      routeEligible: !ambiguous && winner.validCustomAgentDefinition !== false,
      ambiguousNativeIdentity: ambiguous,
    };
  });
}

async function projectSkillProviders() {
  const dirs = [
    { runtime: "codex", dir: ".agents/skills", marker: "SKILL.md" },
    { runtime: "claude_code", dir: ".claude/skills", marker: "SKILL.md" },
    { runtime: "cursor", dir: ".cursor/skills", marker: "SKILL.md" },
    { runtime: "openclaw", dir: "openclaw/skills", marker: "SKILL.md" },
  ];
  const providers = [];
  for (const { runtime: runtimeName, dir, marker } of dirs) {
    const absDir = repoPath(dir);
    if (!(await exists(absDir))) continue;
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(dir, entry.name, marker);
      if (!(await exists(repoPath(skillFile)))) continue;
      providers.push({
        id: entry.name,
        type: "skills",
        source: "project_runtime_skill_inventory",
        runtime: runtimeName,
        sourceRef: toPosix(skillFile),
      });
    }
  }
  return providers;
}

async function projectCapabilityProviders() {
  const providerSpecs = [
    { runtime: "claude_code", dir: ".claude/hooks", type: "hooks", source: "project_runtime_hook_inventory", extensions: [".js", ".mjs", ".cjs", ".ts", ".py", ".sh"] },
    { runtime: "codex", dir: ".codex/hooks", type: "hooks", source: "project_runtime_hook_inventory", extensions: [".js", ".mjs", ".cjs", ".ts", ".py", ".sh"] },
    { runtime: "cursor", dir: ".cursor/hooks", type: "hooks", source: "project_runtime_hook_inventory", extensions: [".js", ".mjs", ".cjs", ".ts", ".py", ".sh"] },
    { runtime: "openclaw", dir: "openclaw/hooks", type: "hooks", source: "project_runtime_hook_inventory", extensions: [".js", ".mjs", ".cjs", ".ts", ".py", ".sh"] },
    { runtime: "claude_code", dir: ".claude/commands", type: "commands", source: "project_runtime_command_inventory", extensions: [".md", ".toml", ".yaml", ".yml"], recursive: true },
    { runtime: "codex", dir: ".codex/commands", type: "commands", source: "project_runtime_command_inventory", extensions: [".md", ".toml", ".yaml", ".yml"], recursive: true },
    { runtime: "cursor", dir: ".cursor/rules", type: "rules", source: "project_runtime_rule_inventory", extensions: [".mdc", ".md"], recursive: true },
    { runtime: "codex", dir: ".codex/prompts", type: "prompts", source: "project_runtime_prompt_inventory", extensions: [".md", ".txt", ".yaml", ".yml"], recursive: true },
    { runtime: "claude_code", dir: ".claude/prompts", type: "prompts", source: "project_runtime_prompt_inventory", extensions: [".md", ".txt", ".yaml", ".yml"], recursive: true },
    { runtime: "cursor", dir: ".cursor/prompts", type: "prompts", source: "project_runtime_prompt_inventory", extensions: [".md", ".txt", ".yaml", ".yml"], recursive: true },
  ];
  const providers = [];
  for (const spec of providerSpecs) {
    providers.push(...await scanProjectFiles(spec));
  }
  if (await exists(repoPath(".codex/hooks.json"))) {
    providers.push({
      id: "codex-hooks-json",
      type: "hooks",
      source: "project_runtime_hook_config_inventory",
      runtime: "codex",
      sourceRef: ".codex/hooks.json",
    });
  }
  for (const file of [
    { id: "claude-settings-json", runtime: "claude_code", sourceRef: ".claude/settings.json" },
    { id: "cursor-hooks-json", runtime: "cursor", sourceRef: ".cursor/hooks.json" },
    { id: "openclaw-template-json", runtime: "openclaw", sourceRef: "openclaw/openclaw.template.json" },
  ]) {
    if (await exists(repoPath(file.sourceRef))) {
      providers.push({
        id: file.id,
        type: "hooks",
        source: "project_runtime_hook_config_inventory",
        runtime: file.runtime,
        sourceRef: file.sourceRef,
      });
    }
  }
  if (await exists(repoPath("package.json"))) {
    const packageJson = await readJson("package.json");
    for (const scriptName of Object.keys(packageJson.scripts ?? {})) {
      providers.push({
        id: `package-script:${scriptName}`,
        type: "commands",
        source: "package_script_inventory",
        runtime: "shared",
        sourceRef: `package.json#scripts.${scriptName}`,
      });
    }
  }
  for (const file of [
    { id: "repo-mcp", type: "mcpServers", source: "project_runtime_mcp_inventory", runtime: "shared", sourceRef: ".mcp.json" },
    { id: "cursor-mcp", type: "mcpServers", source: "project_runtime_mcp_inventory", runtime: "cursor", sourceRef: ".cursor/mcp.json" },
    { id: "codex-config-mcp", type: "mcpServers", source: "project_runtime_mcp_inventory", runtime: "codex", sourceRef: ".codex/config.toml" },
  ]) {
    if (await exists(repoPath(file.sourceRef))) providers.push(file);
  }
  return providers;
}

async function scanSkillRoot(rootDir, source, platformId, { maxProviders = 160 } = {}) {
  const providers = [];
  if (!(await exists(rootDir))) return providers;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  function displaySkillRef(skillFile) {
    const normalizedSkillFile = toPosix(skillFile);
    const normalizedHome = home ? toPosix(home) : "";
    if (normalizedHome && normalizedSkillFile.startsWith(`${normalizedHome}/`)) {
      return `~/${toPosix(path.relative(home, skillFile))}`;
    }
    return normalizedSkillFile;
  }
  async function visit(absDir, depth) {
    if (providers.length >= maxProviders || depth > 8) return;
    let entries = [];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const rel = toPosix(path.relative(rootDir, absDir));
      const id = rel && rel !== "." ? rel : path.basename(absDir);
      providers.push({
        id,
        type: "skills",
        source,
        platformId,
        sourceRef: displaySkillRef(path.join(absDir, "SKILL.md")),
      });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (["node_modules", ".git", "dist", "build"].includes(entry.name)) continue;
      await visit(path.join(absDir, entry.name), depth + 1);
      if (providers.length >= maxProviders) return;
    }
  }
  await visit(rootDir, 0);
  return providers;
}

async function codexGlobalSkillProviders() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  if (!home) return [];
  const roots = [
    {
      root: path.join(home, ".codex", "skills"),
      source: "codex_global_skill_filesystem_light_scan",
    },
    {
      root: path.join(home, ".codex", "plugins", "cache"),
      source: "codex_plugin_skill_filesystem_light_scan",
    },
  ];
  const providers = [];
  for (const root of roots) {
    providers.push(...await scanSkillRoot(root.root, root.source, "codex"));
  }
  return uniqueById(providers);
}

const repoCanonicalAgents = capabilityEntries(repoCapabilityIndex, "agents").map((entry) => compactAgent(entry, "repo_canonical_capability_index"));
const filesystemRuntimeAgents = await globalRuntimeAgentProviders();
const liveFilesystemAgentCandidates = filesystemRuntimeAgents.flatMap(
  (agent) => agent.sourceCandidates ?? [agent],
);
const exactLiveSourceAgents = liveFilesystemAgentCandidates
  .filter(exactOwnerSourceSelected)
  .map((entry) => ({
    ...entry,
    sourceSelectedExplicitly: true,
    routeEligible:
      (entry.validCustomAgentDefinition ?? entry.metadata?.validCustomAgentDefinition) !== false,
  }));
const authoritativeFilesystemAgents = exactLiveSourceAgents.length > 0
  ? exactLiveSourceAgents
  : filesystemRuntimeAgents;
const cachedInventoryAgentEntries = capabilityEntries(globalCapabilityInventory, "agents");
function cacheEvidenceForLiveAgent(liveAgent) {
  const cached = cachedInventoryAgentEntries.find((entry) => entry.id === liveAgent.id);
  if (!cached) return { present: false, sourceAware: false, liveMatch: false };
  const cachedSources = Array.isArray(cached.provenance) && cached.provenance.length > 0
    ? cached.provenance
    : [cached];
  const sourceAware = cachedSources.every(
    (entry) => entry?.sourceRef && entry?.sourceKey && /^[a-f0-9]{64}$/iu.test(
      String(entry?.contentDigest ?? "").replace(/^sha256:/iu, ""),
    ),
  );
  const liveMatch = sourceAware && cachedSources.some(
    (entry) =>
      toPosix(String(entry.sourceRef)) === toPosix(String(liveAgent.sourceRef)) &&
      String(entry.contentDigest).replace(/^sha256:/iu, "").toLowerCase() ===
        String(liveAgent.contentDigest).replace(/^sha256:/iu, "").toLowerCase(),
  );
  return {
    present: true,
    sourceAware,
    liveMatch,
    cachedSourceKey: cached.sourceKey ?? null,
    cachedContentDigest: cached.contentDigest ?? null,
    cachedCollision: cached.collision ?? null,
    disposition: liveMatch
      ? "cache_correlated_live_filesystem_authoritative"
      : "cache_evidence_only_live_filesystem_authoritative",
  };
}
const liveGlobalAgents = authoritativeFilesystemAgents.map((agent) => ({
  ...agent,
  cacheEvidence: cacheEvidenceForLiveAgent(agent),
}));
const liveGlobalAgentIds = new Set(liveGlobalAgents.map((agent) => agent.id));
const cacheOnlyGlobalAgents = cachedInventoryAgentEntries
  .filter((entry) => !liveGlobalAgentIds.has(entry.id))
  .map((entry) => compactAgent({
    ...entry,
    routeEligible: false,
    cacheEvidenceOnly: true,
  }, "local_global_agent_inventory"));
const localGlobalAgents = [];
const localGlobalAgentKeys = new Set();
for (const agent of [...liveGlobalAgents, ...cacheOnlyGlobalAgents]) {
  const key = `${agent.runtime ?? agent.platformId ?? "shared"}:${agent.id}`;
  if (localGlobalAgentKeys.has(key)) continue;
  localGlobalAgentKeys.add(key);
  localGlobalAgents.push(agent);
}
const projectRuntimeAgentCandidates = await projectRuntimeAgents();
const repoCanonicalSkillProviders = capabilityEntries(repoCapabilityIndex, "skills").map((entry) => compactCapabilityProvider(entry, "repo_canonical_capability_index", "skills"));
const projectRuntimeSkillProviders = await projectSkillProviders();
const codexGlobalSkillFileProviders = await codexGlobalSkillProviders();
const repoCanonicalCapabilityProviders = [
  ...repoCanonicalSkillProviders,
  ...["commands", "hooks", "mcpServers", "mcpTools", "plugins", "rules", "prompts"].flatMap((type) =>
    capabilityEntries(repoCapabilityIndex, type).map((entry) => compactCapabilityProvider(entry, "repo_canonical_capability_index", type)),
  ),
];
const projectRuntimeCapabilityProviders = [
  ...projectRuntimeSkillProviders,
  ...await projectCapabilityProviders(),
].sort((a, b) => {
  const aPs = typeof a?.id === "string" && a.id.startsWith("package-script:") ? 0 : 1;
  const bPs = typeof b?.id === "string" && b.id.startsWith("package-script:") ? 0 : 1;
  return aPs - bPs;
});

function selectProjectRuntimeCapabilityEvidence(providers, limit = 80) {
  const requiredConfigIds = new Set([
    "codex-hooks-json",
    "claude-settings-json",
    "cursor-hooks-json",
    "openclaw-template-json",
  ]);
  const evidencePriority = (provider) => {
    if (provider?.source === "project_runtime_hook_config_inventory") return 0;
    if (provider?.source === "project_runtime_mcp_inventory") return 1;
    if (["rules", "prompts", "skills"].includes(provider?.type)) return 2;
    if (provider?.type === "hooks") return 3;
    if (typeof provider?.id === "string" && provider.id.startsWith("package-script:")) return 5;
    return 4;
  };
  const ordered = [...providers].sort((a, b) => evidencePriority(a) - evidencePriority(b));
  const requiredEvidence = [
    ...ordered.filter((provider) => requiredConfigIds.has(provider?.id)),
    ...ordered.filter(
      (provider) => typeof provider?.id === "string" && provider.id.startsWith("package-script:"),
    ).slice(0, 1),
    ...["skills", "commands", "hooks", "mcpServers", "rules", "prompts"]
      .map((type) => ordered.find((provider) => provider?.type === type))
      .filter(Boolean),
  ];
  return uniqueById([...requiredEvidence, ...ordered]).slice(0, limit);
}
const localGlobalCapabilityProvidersAll = ["skills", "commands", "hooks", "plugins", "mcpServers", "mcpTools", "rules", "prompts"].flatMap((type) =>
  capabilityEntries(globalCapabilityInventory, type)
    .map((entry) => compactCapabilityProvider(entry, `local_global_${type}_inventory`, type)),
).concat(codexGlobalSkillFileProviders);
const localGlobalCapabilityProviders = localGlobalCapabilityProvidersAll.slice(0, 120);
const localGlobalSkillProviders = localGlobalCapabilityProvidersAll
  .filter((provider) => provider.type === "skills")
  .slice(0, 60);
const discoveredRuntimeToolProviders = (capabilityInventory.capabilities ?? [])
  .filter((capability) => capability.type === "runtime_tool")
  .map((entry) => compactCapabilityProvider(entry, "local_runtime_capability_inventory", "runtimeTools"));
function bindRuntimeToolClaim(provider) {
  const matrixCapability = runtimeCapabilityNameForTool(provider.id);
  const claim = resolveRuntimeCapabilityClaim(runtimeMatrix, {
    runtime,
    capability: matrixCapability,
    mode: "interactive_host",
  });
  return {
    ...provider,
    runtimeSupport: runtimeSupportForCapability(runtimeMatrix, matrixCapability),
    runtimeCapability: matrixCapability,
    runtimeMode: "interactive_host",
    executionEligible: claim.executable,
    routeEligibility: claim.executable ? "callable" : "reference",
    capabilityClaim: {
      hostSupport: claim.hostSupport,
      hostConfidence: claim.hostConfidence,
      acceptanceState: claim.acceptanceState,
    },
  };
}

const runtimeToolProviders = uniqueById([
  ...discoveredRuntimeToolProviders,
  ...[
    {
      id: "shell_command",
      type: "runtimeTools",
      source: "runtime_tool_provider_inventory",
      platformId: runtime,
      sourceRef: `${runtime}:shell_command`,
    },
    {
      id: "apply_patch",
      type: "runtimeTools",
      source: "runtime_tool_provider_inventory",
      platformId: runtime,
      sourceRef: `${runtime}:apply_patch`,
    },
    {
      id: "filesystem",
      type: "runtimeTools",
      source: "runtime_tool_provider_inventory",
      platformId: runtime,
      sourceRef: `${runtime}:filesystem`,
    },
  ],
]).map(bindRuntimeToolClaim);
const capabilityProviderCoverage = {
  repoCanonical: Object.fromEntries(["skills", "commands", "hooks", "mcpServers", "mcpTools", "plugins", "rules", "prompts", "runtimeTools"].map((type) => [type, capabilityEntries(repoCapabilityIndex, type).length])),
  projectRuntimeLightScan: Object.fromEntries(["skills", "commands", "hooks", "mcpServers", "rules", "prompts", "runtimeTools"].map((type) => [type, type === "runtimeTools" ? runtimeToolProviders.length : projectRuntimeCapabilityProviders.filter((provider) => provider.type === type).length])),
  localGlobalCached: Object.fromEntries(["agents", "skills", "commands", "hooks", "plugins", "mcpServers", "mcpTools", "rules", "prompts", "runtimeTools"].map((type) => [type, type === "runtimeTools" ? runtimeToolProviders.length : capabilityEntries(globalCapabilityInventory, type).length])),
  codexFilesystemLightScan: {
    skills: codexGlobalSkillFileProviders.length,
  },
};
const globalInventoryGeneratedAt = globalCapabilityInventory.generatedAt ?? null;
const globalInventoryAgeMinutes = globalInventoryGeneratedAt
  ? Math.max(0, Math.round((Date.now() - Date.parse(globalInventoryGeneratedAt)) / 60000))
  : null;
const GLOBAL_INVENTORY_STALE_AFTER_MINUTES = 14 * 24 * 60;
const globalInventoryStale =
  globalInventoryAgeMinutes === null || globalInventoryAgeMinutes > GLOBAL_INVENTORY_STALE_AFTER_MINUTES;
const globalInventoryFreshness = {
  mode: "cached_global_inventory_plus_project_light_scan",
  fullScanWhen: [
    "install",
    "update",
    "explicit_user_refresh",
    "missing_required_provider",
    "stale_cache",
    "scheduled_refresh_older_than_14_days",
    "high_risk_provider_route",
  ],
  perRunBehavior: "read cached global inventory, do lightweight project scan, require full refresh when cache is missing or older than 14 days",
  generatedAt: globalInventoryGeneratedAt,
  ageMinutes: globalInventoryAgeMinutes,
  staleAfterMinutes: GLOBAL_INVENTORY_STALE_AFTER_MINUTES,
  staleAfterDays: 14,
  stale: globalInventoryStale,
  refreshRequiredBeforeExecution: globalInventoryStale,
  refreshCommand: "npm run discover:global",
  userHint: globalInventoryAgeMinutes === null
    ? "Capability cache is missing; this run should first update with npm run discover:global so newly added capabilities can be matched."
    : globalInventoryStale
      ? "The last full capability scan is over 2 weeks old; this run should first update with npm run discover:global to match newly added user content and reach the best capability route."
      : null,
};
const explicitGovernanceReminderDetected =
  /critical\s+and\s+fetch\s+thinking\s+and\s+review|critical.*fetch.*thinking.*review|meta-theory|元理论/i.test(task);
const autonomousCapabilityDiscovery = {
  stage: "Fetch",
  trigger: entryClassification.governedEntry
    ? "entry_classifier_auto_governed_entry"
    : "route_probe",
  triggerReason: entryClassification.triggerReason,
  requiredByDefault: entryClassification.governedEntry && entryClassification.path !== "fast_path",
  userReminderDetected: explicitGovernanceReminderDetected,
  productRule:
    "Natural-language durable work self-starts capability discovery; users do not need to say Critical, Fetch, Thinking, Review, agent, skill, MCP, command, or tool.",
  behavior:
    "Fetch scans capability sources before Thinking binds owners and lanes; validators only confirm the route artifact, not rescue a weak route after the fact.",
  routePreviewState: "completed_before_execution_gate",
  executionMayStillBlockOn: ["native_route_choice", "stale_capability_cache", "capability_gap"],
  familiesChecked: [
    "governance_agents",
    "execution_agents",
    "skills",
    "skill_creation",
    "mcp_servers",
    "mcp_tools",
    "commands",
    "runtime_tools",
    "plugins",
    "hooks",
    "rules_prompts",
    "verification_owner",
  ],
  sourcesChecked: [
    "repo_canonical_capability_index",
    "runtime_mirror_capability_indexes",
    "project_runtime_inventory",
    "local_global_inventory_cache",
    "claude_global_inventory_cache",
    "codex_global_inventory_cache",
    "cursor_global_inventory_cache",
    "openclaw_global_inventory_cache",
    "codex_global_skill_filesystem_light_scan",
    "mcp_inventory",
    "package_json_scripts",
    "runtime_tools",
  ],
  sourceRefPolicy:
    "Reportable provider refs use repo-relative paths, runtime ids, or home-relative refs like ~/.codex, ~/.claude, ~/.cursor, ~/.openclaw, and ~/.agents instead of machine absolute home paths.",
};
const typeFirstRoutePolicy = {
  status: "active",
  policyKind: "route_selection_invariant",
  mustNotBecomeChecklist: true,
  principle:
    "Classify route-critical object, evidence, and ownership types before scoring or adding gates; unknown types degrade or block instead of guessing.",
  axes: {
    objectType: {
      question: "What kind of thing is being routed or parsed?",
      knownTypes: [
        "script_target",
        "runner_or_wrapper",
        "wrapper_payload",
        "directory_path",
        "proposal_or_reference",
        "runtime_claim",
        "capability_provider",
      ],
      unclearAction: "return_null_or_capabilityGapPacket_or_reference_only",
      forbiddenFallback: "guess_executable_route_from_shape_only",
    },
    evidenceType: {
      question: "Which proof layer supports the claim?",
      knownTypes: [
        "structural",
        "host_visible",
        "native_surface",
        "runtime_live",
        "release_truth",
      ],
      unclearAction: "do_not_promote_claim",
      forbiddenFallback: "validator_pass_as_runtime_truth",
    },
    ownershipType: {
      question: "Who owns the file, state, provider, or runtime surface?",
      knownTypes: [
        "canonical_source",
        "global_home",
        "project_mirror",
        "user_owned_local_state",
        "external_dependency",
      ],
      unclearAction: "preserve_or_block_until_owner_is_known",
      forbiddenFallback: "overwrite_unknown_local_state",
    },
  },
  executionRule:
    "If any route-critical type is unknown, use null, reference_only, capabilityGapPacket, or blocked-with-reason before Execution; do not add another acceptance gate to compensate for a weak route.",
  validatorRole:
    "Validators and hooks confirm the route invariant and regressions; they do not rescue a route that failed to classify types during Fetch and Thinking.",
};
const governanceStagePolicy = workflowContract.protocols?.agentBlueprintPacket?.governanceStageCoveragePolicy ?? {};
const governanceStages = Object.fromEntries(
  ["Critical", "Fetch", "Thinking", "Review"].map((stage) => [
    stage,
    {
      requiredAgents: governanceStagePolicy.stageRequiredAgents?.[stage] ?? [],
      allowedAgents: governanceStagePolicy.stageAllowedAgents?.[stage] ?? [],
      evidenceSource: "config/contracts/workflow-contract.json#/protocols/agentBlueprintPacket/governanceStageCoveragePolicy",
    },
  ]),
);
const governanceStageOwners = [...new Set(Object.values(governanceStages).flatMap((stage) => [...stage.requiredAgents, ...stage.allowedAgents]))];
function platformMatchesRuntime(agent) {
  if (!agent?.platformId) return true;
  const normalized = String(agent.platformId).toLowerCase();
  if (runtime === "claude_code") return normalized === "claudecode" || normalized === "claude_code";
  if (runtime === "codex") return normalized === "codex" || normalized === "codexapp";
  if (runtime === "cursor") return normalized === "cursor";
  if (runtime === "openclaw") return normalized === "openclaw";
  return false;
}

const runtimeScopedAgents = annotateCrossScopeAgentCollisions([
  ...projectRuntimeAgentCandidates.filter((agent) => agent.runtime === runtime || agent.runtime === "shared"),
  ...localGlobalAgents.filter(platformMatchesRuntime),
], runtime);
const runtimeScopedProjectExecutionAgents = runtimeScopedAgents
  .filter((agent) => agent.source === "project_runtime_agent_inventory");
const runtimeScopedLocalGlobalAgents = runtimeScopedAgents
  .filter((agent) => agent.source !== "project_runtime_agent_inventory");
const candidateExecutionAgents = [
  ...runtimeScopedProjectExecutionAgents,
  ...runtimeScopedLocalGlobalAgents,
]
  .filter(
    (agent) =>
      agent.layer !== "meta" &&
      agent.executionBlock !== true &&
      agent.routeEligible !== false,
  );
const candidateExistingExecutionOwners = candidateExecutionAgents.map((agent) => agent.id);
const ownerDiscoveryPacket = {
  discoveryPrinciple: "canonical_index_first_capability_discovery_owner_last_binding",
  autonomousCapabilityDiscovery,
  searchOrder: [
    "repo_canonical_capability_index",
    "runtime_mirror_indexes",
    "project_runtime_agent_inventory",
    "local_global_agent_inventory",
    "available_capability_providers_skills_tools_mcp",
    "runtime_tool_provider_inventory",
  ],
  ownerBindingOrder: workflowContract.runDiscipline?.executionOwnership?.existingOwnerEvidenceOrder ?? [
    "repo_canonical_capability_index",
    "runtime_mirror_indexes",
    "project_runtime_agent_inventory",
    "local_global_agent_inventory",
  ],
  governanceStages,
  repoCanonicalAgents: repoCanonicalAgents.slice(0, 20),
  projectRuntimeAgents: projectRuntimeAgentCandidates.slice(0, 80),
  localGlobalAgents: localGlobalAgents.slice(0, 30),
  repoCanonicalSkillProviders: repoCanonicalSkillProviders.slice(0, 30),
  projectRuntimeSkillProviders: projectRuntimeSkillProviders.slice(0, 40),
  localGlobalSkillProviders,
  repoCanonicalCapabilityProviders: repoCanonicalCapabilityProviders.slice(0, 60),
  projectRuntimeCapabilityProviders: selectProjectRuntimeCapabilityEvidence(
    projectRuntimeCapabilityProviders,
    80,
  ),
  localGlobalCapabilityProviders,
  runtimeToolProviders: runtimeToolProviders.slice(0, 40),
  capabilityProviderCoverage,
  projectProjectionPolicy,
  globalInventoryFreshness,
  capabilityDiscoverySearchLog: [
    { source: "repo_canonical_capability_index", checked: true, sourceRef: "config/capability-index/meta-kim-capabilities.json" },
    { source: "runtime_mirror_capability_indexes", checked: true, sourceRef: ".claude/.codex/.cursor/openclaw capability-index mirrors" },
    { source: "project_projection_policy", checked: true, sourceRef: `.meta-kim/local.overrides.json#projectProjectionMode=${projectProjectionMode}` },
    { source: "claude_project_inventory", checked: true, sourceRef: ".claude/agents; .claude/skills; .claude/commands; .claude/hooks; .claude/settings.json" },
    { source: "codex_project_inventory", checked: true, sourceRef: ".codex/agents; .agents/skills; .codex/commands; .codex/hooks; .codex/hooks.json; .codex/config.toml; .mcp.json; package.json scripts" },
    { source: "cursor_project_inventory", checked: true, sourceRef: ".cursor/agents; .cursor/skills; .cursor/rules; .cursor/prompts; .cursor/hooks; .cursor/hooks.json; .cursor/mcp.json" },
    { source: "openclaw_project_inventory", checked: true, sourceRef: "openclaw/workspaces; openclaw/skills; openclaw/hooks; openclaw/openclaw.template.json" },
    { source: "local_global_inventory_cache", checked: true, sourceRef: `${stateDirRef}/capability-index/global-capabilities.json` },
    { source: "claude_global_inventory", checked: true, sourceRef: "~/.claude/agents; ~/.claude/skills; ~/.claude/commands; ~/.claude/hooks; ~/.claude/settings.json" },
    { source: "codex_global_inventory", checked: true, sourceRef: "~/.codex/agents; ~/.codex/skills; ~/.codex/commands; ~/.codex/hooks; ~/.codex/hooks.json; ~/.codex/config.toml; ~/.agents/skills" },
    { source: "codex_global_skill_filesystem_light_scan", checked: true, sourceRef: "~/.codex/skills; ~/.codex/plugins/cache" },
    { source: "cursor_global_inventory", checked: true, sourceRef: "~/.cursor/agents; ~/.cursor/skills; ~/.cursor/rules; ~/.cursor/prompts; ~/.cursor/hooks; ~/.cursor/hooks.json; ~/.cursor/mcp.json" },
    { source: "openclaw_global_inventory", checked: true, sourceRef: "~/.openclaw/openclaw.json; ~/.openclaw/workspace-*; ~/.openclaw/skills; ~/.openclaw/hooks; ~/.agents/skills" },
    { source: "mcp_inventory", checked: true, sourceRef: ".mcp.json; .cursor/mcp.json; .codex/config.toml; MCP server/tool inventory" },
    { source: "runtime_tools", checked: true, sourceRef: `${runtime}:shell_command; ${runtime}:apply_patch; ${runtime}:filesystem` },
  ],
  candidateReusableCapabilityProviders: uniqueById([
    ...repoCanonicalCapabilityProviders,
    ...projectRuntimeCapabilityProviders,
    ...localGlobalCapabilityProvidersAll,
    ...runtimeToolProviders,
  ]).map((provider) => provider.id).slice(0, 100),
  candidateExistingExecutionOwners: [...new Set(candidateExistingExecutionOwners)].slice(0, 40),
  governanceStageOwners,
  evidenceRefs: [
    "config/capability-index/meta-kim-capabilities.json",
    ".meta-kim/local.overrides.json",
    ".codex/agents",
    ".codex/commands",
    ".codex/hooks",
    ".codex/hooks.json",
    ".codex/config.toml",
    ".claude/agents",
    ".claude/commands",
    ".claude/hooks",
    ".claude/settings.json",
    ".cursor/agents",
    ".cursor/hooks",
    ".cursor/hooks.json",
    ".cursor/mcp.json",
    ".cursor/rules",
    ".agents/skills",
    ".claude/skills",
    ".cursor/skills",
    "openclaw/skills",
    "openclaw/hooks",
    "openclaw/workspaces",
    "openclaw/openclaw.template.json",
    "config/runtime-capability-matrix.json",
    `${stateDirRef}/capability-inventory.json`,
    ".mcp.json",
    "package.json",
    "scripts",
    "~/.codex/agents",
    "~/.codex/skills",
    "~/.codex/commands",
    "~/.codex/hooks",
    "~/.codex/hooks.json",
    "~/.codex/config.toml",
    "~/.agents/skills",
    "~/.claude/agents",
    "~/.claude/skills",
    "~/.claude/commands",
    "~/.claude/hooks",
    "~/.claude/settings.json",
    "~/.cursor/agents",
    "~/.cursor/skills",
    "~/.cursor/rules",
    "~/.cursor/prompts",
    "~/.cursor/hooks",
    "~/.cursor/hooks.json",
    "~/.cursor/mcp.json",
    "~/.openclaw/openclaw.json",
    "~/.openclaw/workspace-*",
    "~/.openclaw/skills",
    "~/.openclaw/hooks",
    `${stateDirRef}/capability-index/global-capabilities.json`,
    "config/contracts/workflow-contract.json",
  ],
};

const dependencyRecords = [
  ...registryDependencies.map((dep) => ({
    id: dep.id,
    name: dep.name,
    routeEligibility: dep.capabilityCard?.routeEligibility ?? "unknown",
    invokeAs: dep.interface?.invokeAs ?? "reference",
    runtimeSupport: dep.runtimeSupport ?? {},
    osSupport: dep.osSupport ?? {},
    invocationPath: dep.interface?.invocationPath ?? null,
    verificationMethod: dep.capabilityCard?.verificationMethod ?? null,
    reuseScore: dep.scoring?.overall ?? 50,
    taskShapes: dep.capabilityCard?.taskShapes ?? dep.capabilityCard?.canDo ?? [],
    triggerConditions: dep.capabilityCard?.triggerConditions ?? [],
    risk: dep.capabilityCard?.risk ?? dep.capabilityCard?.knownRisks ?? [],
  })),
  ...(dependencyIndex.discoveredDependencyProjects ?? []),
].filter((dep, index, all) => all.findIndex((item) => item.id === dep.id) === index);

function dependencyExecutable(dep) {
  const eligibility = dep?.routeEligibility ?? "unknown";
  if (["reference_only", "external_reference", "blocked", "blocked_for_execution", "needs_probe", "unknown"].includes(eligibility)) return false;
  if (dep?.invokeAs === "reference" || dep?.invokeAs === "notInvokable") return false;
  if (!dep?.invocationPath || !dep?.verificationMethod) return false;
  if (dep?.runtimeSupport?.[runtime] === "unsupported") return false;
  if (dep?.osSupport?.[osTarget] === "unsupported") return false;
  return true;
}

const candidateWeapons = weapons.filter(fitsTask);
const candidateDependencies = dependencyRecords.filter((dep) => fitsTask(dep));
const candidateFoundationalCapabilities = (capabilityInventory.capabilities ?? [])
  .filter((cap) => cap.mustPreserve && fitsTask(cap))
  .slice(0, 20)
  .map((cap) => cap.id);

function dependencyTaskFitScore(dep) {
  const terms = taskTerms();
  const depText = JSON.stringify(dep).toLowerCase();
  let score = dep.reuseScore ?? 50;
  if (terms.some((term) => depText.includes(term))) score += 25;
  if (taskShape === "goal_contract" && dep.id === "goalpro") score += 50;
  if (taskShape === "strategy_product_decision" && dep.id === "kim-decision") score += 20;
  if (dependencyExecutable(dep)) score += 30;
  else score -= 120;
  return score;
}

function selectDependencyForWeapon(weapon) {
  const dependencyIds = weapon.dependencyProjects ?? [];
  if (!dependencyIds.length) return null;
  const matches = candidateDependencies.filter((candidate) =>
    dependencyIds.includes(candidate.id),
  );
  const executableMatches = matches.filter(dependencyExecutable);
  const pool = executableMatches.length ? executableMatches : [];
  return pool
    .sort((a, b) => dependencyTaskFitScore(b) - dependencyTaskFitScore(a))[0] ?? null;
}

function routeForWeapon(weapon) {
  const dep = selectDependencyForWeapon(weapon);
  const runtimeValue = weapon.runtimeSupport?.[runtime] ?? "unknown";
  const osValue = weapon.osSupport?.[osTarget] ?? "unknown";
  const available = new Set([
    ...ownerDiscoveryPacket.candidateExistingExecutionOwners,
    ...(taskShape !== "engineering_execution"
      ? (ownerDiscoveryPacket.governanceStageOwners ?? [])
      : []),
  ]);
  const executionOwner = weapon.ownerCandidates?.find((owner) => available.has(owner)) ?? null;
  const selectedOwner = weapon.ownerCandidates?.[0] ?? null;
  const existingOwnerMatched = selectedOwner
    ? ownerDiscoveryPacket.candidateExistingExecutionOwners.includes(selectedOwner) ||
      ownerDiscoveryPacket.governanceStageOwners.includes(selectedOwner)
    : false;
  const blockedReasons = [];
  if (!weapon.ownerCandidates?.length) blockedReasons.push("owner missing");
  if (weapon.ownerCandidates?.length && !executionOwner) blockedReasons.push("owner not in runtime-scoped available set");
  if (!weapon.id) blockedReasons.push("weapon missing");
  if (runtimeValue === "unsupported") blockedReasons.push("runtime unsupported");
  if (osValue === "unsupported") blockedReasons.push("OS unsupported");
  if (weapon.ownerCandidates?.some((owner) => owner === "general-purpose")) blockedReasons.push("general-purpose fallback");
  if (weapon.ownerCandidates?.some((owner) => /runtimeInstanceAlias|nickname/i.test(owner))) blockedReasons.push("runtime alias as durable owner");
  if (taskShape === "engineering_execution" && selectedOwner && GOVERNANCE_OWNERS.includes(selectedOwner)) blockedReasons.push("governance agent as implementation worker");
  if (productBuildExecutionRequested() && weapon.id === "meta-kim-decision-patterns") {
    blockedReasons.push("product build requires multi-lane orchestration; decision patterns remain a lens inside Thinking");
  }
  if (dep && !dependencyExecutable(dep)) {
    if (dep.routeEligibility === "reference_only" || dep.invokeAs === "reference") blockedReasons.push("dependency reference_only");
    if (!dep.invocationPath) blockedReasons.push("dependency missing invocationPath");
    if (!dep.verificationMethod) blockedReasons.push("dependency missing verificationMethod");
    if (dep.runtimeSupport?.[runtime] === "unsupported") blockedReasons.push("dependency runtime unsupported");
    if (dep.osSupport?.[osTarget] === "unsupported") blockedReasons.push("dependency OS unsupported");
  }
  const dependencyFit = dep
    ? subjectiveRouteChoice
      ? 35
      : (dependencyExecutable(dep) ? dep.reuseScore ?? 70 : 20)
    : 70;
  const internalChoiceWeapon =
    subjectiveRouteChoice &&
    ["meta-kim-decision-patterns", "select-execution-route"].includes(weapon.id);
  const intentFit = (taskShape === "strategy_product_decision" && weapon.id === "meta-kim-decision-patterns") || internalChoiceWeapon
    ? 100
    : fitsTask(weapon)
      ? 85
      : 50;
  const weaponFit = (taskShape === "strategy_product_decision" && weapon.id === "meta-kim-decision-patterns") || internalChoiceWeapon ? 100 : 90;
  const routeScore = blockedReasons.length ? Math.min(49, scoreRoute({
    intentFit,
    ownerFit: weapon.ownerCandidates?.length ? 85 : 0,
    weaponFit,
    dependencyFit,
    runtimeSupport: supportScore(runtimeValue),
    osSupport: supportScore(osValue),
    verification: weapon.verification?.command ? 85 : 20,
    riskClarity: weapon.risk ? 80 : 20,
  })) : scoreRoute({
    intentFit,
    ownerFit: weapon.ownerCandidates?.length ? 85 : 0,
    weaponFit,
    dependencyFit,
    runtimeSupport: supportScore(runtimeValue),
    osSupport: supportScore(osValue),
    verification: weapon.verification?.command ? 85 : 20,
    riskClarity: weapon.risk ? 80 : 20,
  });
  return {
    id: `${weapon.id}:${runtime}:${osTarget}`,
    owner: selectedOwner,
    weapon: weapon.id,
    dependency: dep?.id ?? null,
    dependencyProject: dep?.id ?? null,
    runtime,
    os: osTarget,
    verificationOwner: weapon.verification?.command ? "meta-prism" : null,
    verificationMethod: weapon.verification?.command ?? null,
    verification: weapon.verification,
    score: routeScore,
    scoreBand: routeScore >= 85 ? "execute" : routeScore >= 70 ? "confirm_or_fetch_more" : routeScore >= 50 ? "upgrade_owner_weapon_dependency" : "blocked",
    routeScoreBreakdown: {
      intentFitWeight: 20,
      ownerFitWeight: 15,
      weaponFitWeight: 15,
      dependencyFitWeight: 15,
      runtimeSupportWeight: 10,
      osSupportWeight: 10,
      verificationStrengthWeight: 10,
      riskRollbackClarityWeight: 5,
      runtimeSupport: runtimeValue,
      osSupport: osValue,
      dependencyFit,
    },
    ownerBinding: {
      selectedOwner,
      source: "weapon_owner_candidates",
      existingOwnerMatched,
      bindingStage: "Thinking",
      providerEvidenceRef: "ownerDiscoveryPacket.candidateReusableCapabilityProviders",
      ownerDiscoveryRef: "ownerDiscoveryPacket",
    },
    blockedReasons,
  };
}

function runtimeMatchScore(provider) {
  const runtimeValue = String(provider?.runtime ?? "").toLowerCase();
  const platformValue = String(provider?.platformId ?? "").toLowerCase();
  const sourceValue = String(provider?.source ?? "").toLowerCase();
  if (runtimeValue === runtime) return 0;
  if (platformMatchesRuntime(provider)) {
    if (platformValue) return 0;
    if (sourceValue.includes(runtime)) return 0;
    return 1;
  }
  if (!runtimeValue && !platformValue) return 1;
  return 9;
}

function providerPriority(provider) {
  const source = String(provider?.source ?? "");
  const runtimeScope = runtimeMatchScore(provider);
  const sourceRank = source.includes("project_runtime")
    ? 0
    : source.includes(`${runtime}_global`) || source.includes(`${runtime}_plugin`)
      ? 1
      : source.includes("repo_canonical")
        ? 2
        : source.includes("local_global")
          ? 3
          : 4;
  return runtimeScope * 10 + sourceRank;
}

function sortProvidersForRuntime(providers) {
  return [...providers].sort((left, right) => {
    const priorityDelta = providerPriority(left) - providerPriority(right);
    if (priorityDelta !== 0) return priorityDelta;
    return String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });
}

const reusableProviders = uniqueById(sortProvidersForRuntime([
  ...repoCanonicalCapabilityProviders,
  ...projectRuntimeCapabilityProviders,
  ...localGlobalCapabilityProvidersAll,
  ...runtimeToolProviders,
]));

function providerEligibleForRoute(provider) {
  return provider?.routeEligible !== false &&
    (provider?.type !== "runtimeTools" || provider?.executionEligible === true);
}

function selectProvider(type, preferredIds = []) {
  const providers = sortProvidersForRuntime(reusableProviders.filter((provider) =>
    provider.type === type &&
    providerEligibleForRoute(provider)));
  for (const preferredId of preferredIds) {
    const match = providers.find((provider) => provider.id === preferredId) ??
      providers.find((provider) => provider.id?.includes(preferredId));
    if (match) return match;
  }
  return providers[0] ?? null;
}

function selectAnyProvider(preferredIds = [], allowedTypes = null) {
  const providers = sortProvidersForRuntime(
    allowedTypes
      ? reusableProviders.filter((provider) => allowedTypes.includes(provider.type))
      : reusableProviders,
  ).filter(providerEligibleForRoute);
  for (const preferredId of preferredIds) {
    const match = providers.find((provider) => provider.id === preferredId) ??
      providers.find((provider) => provider.id?.includes(preferredId));
    if (match) return match;
  }
  return providers[0] ?? null;
}

const CAPABILITY_NEED_TERMS = {
  "product-intent-and-context": ["product", "context", "get-context", "design-consultation", "strategy", "用户", "产品"],
  "capability-discovery-and-retrieval": ["findskill", "skill-scout", "skill-stocktake", "discover", "search", "retrieval", "capability", "发现", "检索"],
  "current-platform-policy-research": ["deep-research", "browse", "browser", "research", "platform", "policy", "market", "规则", "研究"],
  "content-generation-and-review": ["document-generate", "writing", "content", "humanizer", "docs", "内容", "文案"],
  "frontend-ui-design": ["design-html", "image-to-code", "frontend", "ui", "taste", "visual", "界面", "前端"],
  "backend-api-and-workflow": ["tdd-workflow", "backend", "api", "server", "plankton", "workflow", "后端"],
  "data-state-and-observability": ["database", "data", "state", "memory", "graph", "observability", "状态", "数据"],
  "mcp-external-provider-and-plugin": ["mcp", "plugin", "provider", "external", "integration", "runtime", "集成"],
  "safety-hooks-and-permissions": ["review", "security", "guard", "hook", "permission", "sentinel", "risk", "权限", "风险"],
  "verification-eval-and-release": ["e2e", "test", "qa", "verify", "validation", "release", "smoke", "验收", "测试"],
  "execution-tools-and-commands": ["command", "script", "shell", "apply_patch", "runtime", "tool", "执行", "命令"],
  "governance-orchestration": ["agent-teams-playbook", "orchestration", "conductor", "meta-theory", "workflow", "编排"],
};

function providerSearchText(provider) {
  return [
    provider?.id,
    provider?.name,
    provider?.description,
    provider?.summary,
    provider?.type,
    provider?.providerType,
    provider?.source,
    provider?.sourceRef,
  ].filter(Boolean).join(" ").toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termMatchesProviderText(text, term) {
  if (!term) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, "i").test(text);
}

function capabilityNeedTerms(capabilityNeed = []) {
  return uniqueStrings(
    []
      .concat(capabilityNeed)
      .flatMap((need) => [
        String(need ?? ""),
        ...(CAPABILITY_NEED_TERMS[String(need ?? "")] ?? []),
      ])
      .map((term) => term.toLowerCase())
      .filter(Boolean),
  );
}

function scoreProviderForCapabilityNeed(provider, capabilityNeed = []) {
  const terms = capabilityNeedTerms(capabilityNeed);
  const primaryTerms = capabilityNeedTerms([capabilityNeed[0]]);
  const text = providerSearchText(provider);
  const matchedTerms = terms.filter((term) => termMatchesProviderText(text, term));
  const primaryMatchedTerms = primaryTerms.filter((term) => termMatchesProviderText(text, term));
  const typeBoost =
    provider?.type === "runtimeTools" && terms.some((term) => ["tool", "runtime", "apply_patch", "shell"].includes(term))
      ? 3
      : provider?.type === "commands" && terms.some((term) => ["command", "script", "smoke", "validation"].includes(term))
        ? 3
        : provider?.type === "mcpServers" || provider?.type === "mcpTools"
          ? terms.some((term) => ["mcp", "provider", "external", "integration"].includes(term)) ? 3 : 0
          : 0;
  const score = matchedTerms.length * 10 + primaryMatchedTerms.length * 12 + typeBoost - providerPriority(provider);
  return {
    provider,
    score,
    matchedTerms,
  };
}

function candidateProvidersForCapabilityNeed(capabilityNeed = [], allowedTypes = null, limit = 6) {
  const pool = sortProvidersForRuntime(
    allowedTypes
      ? reusableProviders.filter((provider) =>
          allowedTypes.includes(provider.type) && providerEligibleForRoute(provider))
      : reusableProviders.filter(providerEligibleForRoute),
  );
  const scored = pool
    .map((provider) => scoreProviderForCapabilityNeed(provider, capabilityNeed))
    .filter((entry) => entry.score > 0 || entry.matchedTerms.length > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return String(left.provider.id ?? "").localeCompare(String(right.provider.id ?? ""));
    });
  const fallback = scored.length > 0 ? [] : pool.slice(0, limit).map((provider) => ({
    provider,
    score: 0 - providerPriority(provider),
    matchedTerms: [],
  }));
  return [...scored, ...fallback].slice(0, limit);
}

function providerSummary(entry, selectedId = null) {
  const provider = entry?.provider ?? entry;
  if (!provider) return null;
  const isSelected = provider.id === selectedId;
  return {
    id: provider.id,
    type: provider.type ?? provider.providerType ?? "capability",
    source: provider.source ?? "runtime_inventory",
    sourceRef: provider.sourceRef ?? provider.id,
    platformId: provider.platformId ?? provider.runtime ?? null,
    score: entry?.score ?? null,
    matchedTerms: entry?.matchedTerms ?? [],
    selected: isSelected,
    reason: isSelected
      ? "Best runtime-matching provider for this lane capabilityNeed."
      : "Available candidate, not selected because another provider scored higher for this lane.",
  };
}

function bindLaneCapabilityProviders(lane) {
  const capabilityNeed = lane.capabilityNeed ?? [];
  const skillCandidates = candidateProvidersForCapabilityNeed(capabilityNeed, ["skills"], 6);
  const mcpCandidates = candidateProvidersForCapabilityNeed(capabilityNeed, ["mcpServers", "mcpTools"], 3);
  const commandCandidates = candidateProvidersForCapabilityNeed(capabilityNeed, ["commands"], 3);
  const toolCandidates = candidateProvidersForCapabilityNeed(capabilityNeed, ["runtimeTools"], 3);
  const selectedSkill = skillCandidates[0]?.provider ?? null;
  const selectedMcp = mcpCandidates[0]?.provider ?? null;
  const selectedCommand = commandCandidates[0]?.provider ?? null;
  const selectedTool = toolCandidates[0]?.provider ?? null;
  const selectedProviderIds = new Set(
    [selectedSkill, selectedMcp, selectedCommand, selectedTool].filter(Boolean).map((provider) => provider.id),
  );
  return {
    capabilityNeed,
    selectionPolicy: "capability_need_runtime_match",
    selectedProvider: selectedSkill,
    selectedProviders: {
      skill: selectedSkill,
      mcp: selectedMcp,
      command: selectedCommand,
      runtimeTool: selectedTool,
    },
    candidateProviders: [
      ...skillCandidates,
      ...mcpCandidates,
      ...commandCandidates,
      ...toolCandidates,
    ].map((entry) => providerSummary(entry, selectedProviderIds.has(entry.provider?.id) ? entry.provider.id : null)),
    whySelected: selectedSkill
      ? `${selectedSkill.id} matched lane capabilityNeed without a fixed agent-to-skill binding.`
      : "No skill provider matched; lane keeps non-skill candidates and reports a capability gap if execution needs one.",
    whyNotSelected: [
      ...skillCandidates.slice(1),
      ...mcpCandidates.filter((entry) => entry.provider?.id !== selectedMcp?.id),
      ...commandCandidates.filter((entry) => entry.provider?.id !== selectedCommand?.id),
      ...toolCandidates.filter((entry) => entry.provider?.id !== selectedTool?.id),
    ].slice(0, 8).map((entry) => ({
      id: entry.provider.id,
      reason: "Candidate was discovered dynamically but was not the best fit for this lane capabilityNeed.",
    })),
  };
}

function taskMatchesPattern(pattern) {
  return pattern.test(taskText);
}

function taskMatchesAnyPattern(patterns) {
  return patterns.some((pattern) => taskMatchesPattern(pattern));
}

const PRODUCT_BUILD_INTENT_SIGNALS = {
  content: [
    /article|essay|post|copy|content|writing|newsletter|script|draft/i,
    /文章|稿子|帖子|内容|写作|文案|脚本|草稿|随手记|想法|发出去/,
  ],
  currentResearch: [
    /market|research|competitor|policy|platform|rule|current/i,
    /市场|研究|竞品|平台|规则|最新|调研|内容渠道|外部服务|第三方/,
  ],
  interface: [
    /app|web|site|dashboard|frontend|ui|ux|interface|page|tool|product|mvp/i,
    /应用|网站|网页|页面|前端|界面|工具|产品|面板|后台|MVP/i,
  ],
  implementation: [
    /build|implement|develop|ship|launch|api|backend|database|service|queue|workflow/i,
    /实现|开发|上线|接口|API|后端|数据库|服务|队列|工作流/,
  ],
  automationIntegration: [
    /auto[-\s]?publish|scheduler|integration|callback|oauth|account|adapter/i,
    /自动发布|发布器|定时|排期|集成|回调|账号|授权|适配|连接/,
  ],
  dataState: [
    /database|state|history|record|storage|analytics|observability/i,
    /数据库|状态|历史|记录|存储|数据|追踪|观测|统计/,
  ],
  safety: [
    /security|permission|approval|risk|compliance|credential|auth/i,
    /安全|权限|审批|风险|合规|凭证|授权|账号/,
  ],
  verification: [
    /test|qa|verify|acceptance|regression|release|launch/i,
    /测试|验收|验证|回归|发布|上线/,
  ],
  monetization: [
    /payment|billing|subscription|pricing|monetization/i,
    /付费|支付|订阅|定价|商业化|收款/,
  ],
  mobile: [
    /ios|android|native mobile|mobile app/i,
    /原生|移动端|手机 App|安卓|苹果/,
  ],
};

function hasProductBuildSignal(name) {
  return taskMatchesAnyPattern(PRODUCT_BUILD_INTENT_SIGNALS[name] ?? []);
}

function productBuildLaneEvidence() {
  const content = hasProductBuildSignal("content");
  const currentResearch = hasProductBuildSignal("currentResearch");
  const interfaceNeeded = hasProductBuildSignal("interface");
  const implementation = hasProductBuildSignal("implementation");
  const automationIntegration = hasProductBuildSignal("automationIntegration");
  const dataState = hasProductBuildSignal("dataState");
  const safety = hasProductBuildSignal("safety") || automationIntegration;
  const verification = hasProductBuildSignal("verification") || implementation || automationIntegration;
  const contentOnly =
    content &&
    !interfaceNeeded &&
    !implementation &&
    !automationIntegration &&
    !dataState &&
    !hasProductBuildSignal("monetization") &&
    !hasProductBuildSignal("mobile");

  return {
    content,
    currentResearch,
    interfaceNeeded,
    implementation,
    automationIntegration,
    dataState,
    safety,
    verification,
    contentOnly,
  };
}

function productBuildExecutionRequested() {
  const evidence = productBuildLaneEvidence();
  return evidence.implementation || evidence.automationIntegration || (evidence.interfaceNeeded && evidence.dataState);
}

function productRouteDecisionRequested() {
  const routeDecisionSignal =
    /\b(?:which|choose|prioriti[sz]e|route|path|strategy|roadmap|first|minimum test|growth|pricing|conversion)\b/i.test(taskText) ||
    /(?:哪个|哪条|选择|选|优先|路线|路径|战略|策略|路线图|先做|第一步|最小验证|增长|定价|转化|变现|怎么发展|怎么玩)/u.test(taskText) ||
    /不知道.*(?:先做|选择|选|路线|路径|增长|定价|转化)/u.test(taskText);
  if (!routeDecisionSignal) return false;
  const explicitBuildSignal =
    /(?:build|implement|develop|ship|launch|api|backend|database|automation|auto[-\s]?publish|scheduler)/i.test(taskText) ||
    /(?:实现|开发|上线|接口|后端|数据库|自动发布|发布器|定时|排期|工作流|做个|做一个)/u.test(taskText);
  return !explicitBuildSignal;
}

function capabilityTeamScenarioForLanes(lanes, evidence) {
  const executableLaneCount = lanes.length;
  if (executableLaneCount <= 1) {
    return {
      scenario: 1,
      name: "提示增强",
      reason: "Only one executable capability lane is needed; team fan-out would add overhead.",
    };
  }
  if (executableLaneCount <= 5 && !evidence.automationIntegration) {
    return {
      scenario: 3,
      name: "计划+评审",
      reason: "A few independent capability lanes can run as bounded sub-tasks and return to one synthesis owner.",
    };
  }
  if (evidence.automationIntegration || evidence.implementation) {
    return {
      scenario: 4,
      name: "Lead-Member",
      reason: "Implementation or integration lanes need a lead capability to coordinate dependencies and review boundaries.",
    };
  }
  return {
    scenario: 5,
    name: "复合编排",
    reason: "Many heterogeneous capability lanes require staged composition rather than one fixed team shape.",
  };
}

function capabilityTeamCollaborationMode(lanes, scenario) {
  if (lanes.length < 2) {
    return {
      mode: "Single capability lane",
      reason: "Fewer than 2 executable lanes; agent-teams-playbook fan-out is not required.",
    };
  }
  if (scenario.scenario === 4 || scenario.scenario === 5) {
    return {
      mode: "Agent Team if host supports it; otherwise independent subagents plus main-thread synthesis",
      reason: "Some lanes have dependency coordination or integration boundaries.",
    };
  }
  return {
    mode: "Subagent",
    reason: "Selected lanes can report independently to the merge owner without peer-to-peer communication.",
  };
}

function buildCapabilityTeamBlueprint(lanes, omittedLanesWithReason, evidence) {
  const scenario = capabilityTeamScenarioForLanes(lanes, evidence);
  const collaborationMode = capabilityTeamCollaborationMode(lanes, scenario);
  return {
    schemaVersion: "capability-team-blueprint-v0.1",
    inspiration: "agent-teams-playbook abstracted from agent roles to capability slots",
    scenario,
    collaborationMode,
    capabilityResolutionPolicy: {
      mode: "stop_on_first_qualified_provider",
      localProviderTypes: ["agent", "skill", "mcp", "command", "runtimeTool", "hook", "plugin", "memory", "dependency"],
      externalDiscoveryTrigger: "only_after_local_multi_provider_gap_is_proven",
      runtimeBinding: runtime === "codex"
        ? "top_level_spawn_agent_task_name_message_fork_turns"
        : runtime === "claude_code"
          ? "native_agent_or_task_surface"
          : "current_runtime_native_agent_surface",
      degradedModeTrigger: "only_after_host_surface_permission_or_owner_gap",
      forbidden: [
        "continue_to_external_search_after_qualified_local_match",
        "label_successful_native_agent_dispatch_as_fallback",
        "silent_general_purpose_owner_fallback",
      ],
    },
    rows: lanes.map((lane, index) => ({
      id: index + 1,
      capabilitySlot: lane.laneId,
      laneLabel: lane.businessFlowLaneLabel,
      capabilityNeed: lane.capabilityNeed,
      responsibility: lane.purpose,
      ownerFamily: lane.roleDisplayName,
      selectedOwner: lane.ownerAgent,
      providerBindingPolicy: "capability_need_runtime_match",
      codexSpawnBinding:
        lane.codexSpawnBinding ??
        codexSpawnBindingForOwner(lane.ownerAgent, lane.ownerKind, lane.laneId),
      dependsOn: lane.dependsOn,
      parallelGroup: lane.parallelGroup,
      runtimeExecutionSurface:
        runtime === "codex" &&
        (lane.codexSpawnBinding ??
          codexSpawnBindingForOwner(lane.ownerAgent, lane.ownerKind, lane.laneId))
          ? (lane.codexSpawnBinding ?? codexSpawnBindingForOwner(lane.ownerAgent, lane.ownerKind, lane.laneId))
              ?.ownerBindingMode === "native_custom_agent"
            ? "Codex native custom-agent request using the schema-confirmed agent_type owner selector"
            : "Codex run-scoped worker request carrying the selected owner contract in the bounded message"
          : lanes.length >= 2
            ? "host subagent/custom-agent when available; otherwise workerTaskPacket"
          : "single workerTaskPacket",
    })),
    omittedCapabilitySlots: omittedLanesWithReason,
  };
}

function selectOwner(preferredOwners = []) {
  const available = new Set(ownerDiscoveryPacket.candidateExistingExecutionOwners);
  return preferredOwners.find((owner) => available.has(owner)) ?? null;
}

function normalizeCodexTaskName(value) {
  const original = String(value ?? "worker");
  const normalized = original
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const digest = createHash("sha256").update(original).digest("hex").slice(0, 8);
  const base = (normalized || "worker").slice(0, 55).replace(/_+$/g, "") || "worker";
  return `${base}_${digest}`;
}

function resolveRouteRunId(value) {
  if (value != null) {
    const normalized = String(value).trim();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(normalized) ||
      normalized === "." ||
      normalized === ".."
    ) {
      throw new Error("Invalid --run-id: expected a safe 1-128 character run identifier.");
    }
    return normalized;
  }
  return `route-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

const routeRunId = resolveRouteRunId(requestedRouteRunId);
const routeOccurredAt = new Date().toISOString();

function codexProviderId(provider, ownerId) {
  const scope = provider?.source === "local_global_agent_inventory"
    ? "global"
    : provider?.source === "project_runtime_agent_inventory"
      ? "project"
      : provider?.source ?? "runtime";
  return `${scope}:${ownerId}`;
}

function codexOwnerSource(provider) {
  if (!provider) return null;
  if (provider.source !== "local_global_agent_inventory") return provider.sourceRef ?? null;
  const sourceRef = String(provider.sourceRef ?? "").replace(/\\/g, "/");
  if (sourceRef.startsWith("~/")) return sourceRef;
  const platform = String(provider.platformId ?? "").toLowerCase();
  if (platform === "codex" || platform === "codexapp") return `~/.codex/agents/${sourceRef}`;
  if (platform === "claudecode" || platform === "claude_code") return `~/.claude/agents/${sourceRef}`;
  if (platform === "cursor") return `~/.cursor/agents/${sourceRef}`;
  return `global-agent:${sourceRef}`;
}

function codexOwnerDefinition(provider) {
  const sourceRef = String(provider?.sourceRef ?? "").replace(/\\/g, "/");
  const isCodexRuntimeProvider =
    provider?.runtime === "codex" ||
    ["codex", "codexapp"].includes(String(provider?.platformId ?? "").toLowerCase());
  const isToml = /(?:^|\/)agents\/[^/]+\.toml$/iu.test(sourceRef) || /\.toml$/iu.test(sourceRef);
  const metadata = provider?.metadata ?? {};
  const requiredMetadataPresent = ["name", "description", "developer_instructions"].every(
    (field) => typeof metadata?.[field] === "string" && metadata[field].trim().length > 0,
  );
  const nativeNameMatchesInventory = metadata?.name === provider?.id;
  const sourceRouteEligible =
    provider?.routeEligible !== false || provider?.sourceSelectedExplicitly === true;
  const sourceCanBeBoundByNativeHost = !(
    provider?.collision?.ambiguous === true ||
    provider?.collision?.kind === "conflicting_definitions"
  );
  const definitionValidated = provider?.validCustomAgentDefinition === true ||
    (requiredMetadataPresent && nativeNameMatchesInventory);
  const nativeCustomAgentEligible = Boolean(
    isCodexRuntimeProvider &&
      isToml &&
      definitionValidated &&
      nativeNameMatchesInventory &&
      sourceRouteEligible &&
      sourceCanBeBoundByNativeHost,
  );
  return {
    format: nativeCustomAgentEligible ? "codex_custom_agent_toml" : "non_native_owner_definition",
    sourceRef: codexOwnerSource(provider),
    nativeAgentName: requiredMetadataPresent ? metadata.name : null,
    nativeCustomAgentEligible,
    sourceSelectedExplicitly: provider?.sourceSelectedExplicitly === true,
    sourceKey: provider?.sourceKey ?? null,
    contentDigest: provider?.contentDigest ?? null,
    provenance: provider?.provenance ?? [],
    collision: provider?.collision ?? null,
    cacheEvidence: provider?.cacheEvidence ?? null,
    routeEligible: sourceRouteEligible,
    sourceCanBeBoundByNativeHost,
    validationErrors: [
      ...(provider?.customAgentDefinitionErrors ?? []),
      ...(!isToml ? ["owner_source_is_not_toml"] : []),
      ...(!requiredMetadataPresent ? ["required_codex_agent_fields_missing"] : []),
      ...(metadata?.name && !nativeNameMatchesInventory ? ["native_name_does_not_match_selected_owner"] : []),
      ...(!sourceRouteEligible ? ["ambiguous_native_owner_source"] : []),
      ...(!sourceCanBeBoundByNativeHost ? ["native_host_cannot_bind_conflicting_source_definition"] : []),
    ],
    reason: nativeCustomAgentEligible
      ? "Owner was discovered from a Codex TOML custom-agent definition; native binding still requires an active host owner selector and a successful invocation."
      : "Owner is not backed by a validated Codex TOML custom-agent definition whose declared name matches the selected owner identity, so it can only bind through the run-scoped owner contract.",
  };
}

function roleDisplayNameForOwner(ownerId) {
  const owner = String(ownerId ?? "").toLowerCase();
  if (/test|qa|verify/.test(owner)) return "test";
  if (/backend|security|api|server/.test(owner)) return "backend";
  if (/frontend|react|ui|accessibility/.test(owner)) return "frontend";
  if (/review|architect/.test(owner)) return "review";
  if (/search|analysis|explor/.test(owner)) return "analysis";
  if (/docs?|content/.test(owner)) return "docs";
  return "worker";
}

function buildCodexWorkerMessage(ownerId, ownerKind, roleInstanceId, taskPacket = null, provider = null) {
  const taskPacketId = taskPacket?.taskPacketId ?? `worker-task:${roleInstanceId ?? ownerId}`;
  const resolvedRoleInstanceId = taskPacket?.roleInstanceId ?? roleInstanceId ?? ownerId;
  const roleDisplayName = taskPacket?.roleDisplayName ?? ownerId;
  const ownerSource = taskPacket?.ownerSource ?? codexOwnerSource(provider);
  const capabilityLoadout = taskPacket?.capabilityLoadout ?? {
    weapon: taskPacket?.weapon ?? null,
    dependency: taskPacket?.dependency ?? null,
  };
  const ownerDefinition = codexOwnerDefinition(provider);
  const ownerBindingMode = taskPacket?.ownerBindingMode ?? "run_scoped_owner_contract";
  const nativeAgentType = ownerBindingMode === "native_custom_agent"
    ? taskPacket?.nativeAgentType ?? ownerId
    : null;
  const metaKimBinding = {
    runId: routeRunId,
    family: "agent_subagent",
    providerId: codexProviderId(provider, ownerId),
    bindingRef: `${routeRunId}:agent_subagent:${codexProviderId(provider, ownerId)}:${taskPacketId}`,
    taskPacketId,
    roleInstanceId: resolvedRoleInstanceId,
    occurredAt: routeOccurredAt,
    evidenceKind: "spawn_agent_result",
  };
  return JSON.stringify({
    schemaVersion: "codex-native-worker-invocation-v0.2",
    taskPacketId,
    roleDisplayName,
    roleInstanceId: resolvedRoleInstanceId,
    ownerAgent: ownerId,
    ownerKind,
    ownerSource,
    ownerBindingMode,
    nativeAgentType,
    ownerDefinition,
    capabilityLoadout,
    scope: {
      purpose: taskPacket?.purpose ?? `Execute the bounded worker task owned by ${ownerId}.`,
      decisionImpact: taskPacket?.decisionImpact ?? null,
      nonGoals: ["Do not absorb sibling lanes", "Do not mutate outside the declared scope"],
    },
    coordination: {
      dependsOn: taskPacket?.dependsOn ?? [],
      parallelGroup: taskPacket?.parallelGroup ?? null,
      mergeOwner: taskPacket?.mergeOwner ?? "meta-conductor",
      shardScope: taskPacket?.shardScope ?? [],
      workspaceIsolation: taskPacket?.workspaceIsolation ?? null,
      externalWritePolicy: taskPacket?.externalWritePolicy ?? "unproven",
      collisionPolicy: taskPacket?.collisionPolicy ?? "unproven",
    },
    outputContract: {
      deliverable: "Return the scoped result, changed files or evidence, and unresolved blockers.",
      verificationOwner: taskPacket?.verificationOwner ?? "meta-prism",
      verification: taskPacket?.verification ?? "Run the lane-specific checks named by the work order.",
    },
    metaKimBinding,
  });
}

function codexSpawnBindingForOwner(ownerId, ownerKind = "agent", roleInstanceId = null, taskPacket = null) {
  if (runtime !== "codex" || ownerKind !== "agent" || !ownerId) return null;
  const provider = candidateExecutionAgents.find((agent) => agent.id === ownerId);
  if (!provider) return null;
  const ownerSource = codexOwnerSource(provider);
  const ownerDefinition = codexOwnerDefinition(provider);
  const ownerSelectorField = codexHostToolSchema.ownerSelectorField;
  const ownerBindingMode =
    ownerDefinition.nativeCustomAgentEligible && ownerSelectorField
      ? "native_custom_agent"
      : "run_scoped_owner_contract";
  const nativeAgentType = ownerBindingMode === "native_custom_agent" ? ownerId : null;
  const message = buildCodexWorkerMessage(ownerId, ownerKind, roleInstanceId, {
    ...taskPacket,
    ownerSource,
    ownerBindingMode,
    nativeAgentType,
  }, provider);
  const followupMessage = buildCodexWorkerMessage(ownerId, ownerKind, roleInstanceId, {
    ...taskPacket,
    ownerSource,
    ownerBindingMode: "run_scoped_owner_contract",
    nativeAgentType: null,
  }, provider);
  const binding = {
    hostSurface: "spawn_agent",
    supportedHostSurfaces: ["spawn_agent", "followup_task"],
    task_name: normalizeCodexTaskName(taskPacket?.taskPacketId ?? roleInstanceId ?? ownerId),
    fork_turns: "none",
    message,
    followupTaskTemplate: {
      hostSurface: "followup_task",
      target: null,
      targetPolicy: "existing_runtime_instance_id_only_not_owner_identity",
      message: followupMessage,
      ownerBindingMode: "run_scoped_owner_contract",
      nativeAgentType: null,
    },
    ownerAgent: ownerId,
    ownerKind,
    ownerSource,
    ownerBindingMode,
    nativeAgentType,
    ownerSelectorField,
    ownerDefinition,
    nativeCustomAgentCandidate: {
      eligibleOwnerDefinition: ownerDefinition.nativeCustomAgentEligible,
      requiredHostSelector: "agent_type_or_equivalent",
      requiredInvocationResult: "successful_before_invoked_or_completed_presentation",
      promotionRule:
        "Schema-confirmed agent_type plus a Codex TOML owner may select the native request mode; only a successful host result may mark that request invoked or completed.",
    },
    sourceRef: provider.sourceRef,
    runtimeInstanceAlias: null,
    visibleBindingRequired: true,
    hostSurfaceProbeRequired: true,
    hostToolSchemaEvidence: codexHostToolSchema,
    invocationReadiness: ownerBindingMode === "native_custom_agent"
      ? "native_custom_agent_request_ready_success_still_requires_host_result"
      : ownerDefinition.nativeCustomAgentEligible
        ? "run_scoped_ready_native_custom_agent_requires_host_schema"
      : "run_scoped_ready_owner_is_not_codex_toml",
    unavailablePolicy: "block_or_declare_degraded_without_legacy_fallback",
  };
  if (ownerBindingMode === "native_custom_agent") {
    binding[ownerSelectorField] = ownerId;
  }
  return binding;
}

function selectExecutionOwner() {
  const candidates = [...new Set(candidateExistingExecutionOwners)].filter(
    (id) =>
      typeof id === "string" &&
      !id.includes("general-purpose") &&
      !/runtimeInstanceAlias|nickname/i.test(id),
  );
  if (candidates.length === 0) return null;
  const taskLower = String(taskText || "").toLowerCase();
  const findInAvailable = (prefs) => {
    for (const pref of prefs) {
      const exact = candidates.find((id) => id === pref);
      if (exact) return exact;
      const partial = candidates.find((id) => id.includes(pref));
      if (partial) return partial;
    }
    return null;
  };
  const implementationMutationRequested =
    productBuildExecutionRequested() ||
    /\b(?:fix|implement|build|refactor|rebuild|migrate|write|edit|update|repair|code)\b|修复|实现|构建|重构|迁移|写入|编辑|更新|改代码|搞定/iu.test(taskText);
  const preferenceGroups = [
    ...(implementationMutationRequested ? [{
      terms: ["security", "backend", "hook", "routing", "runtime", "code", "安全", "后端", "钩子", "路由", "运行时", "修复", "实现"],
      owners: ["backend-security-coder", "backend", "build-error-resolver", "code-reviewer", "worker"],
    }] : []),
    {
      terms: ["agent", "subagent", "owner", "search", "discover", "find", "智能体", "代理", "搜索", "寻找", "发现"],
      owners: ["codebase-search", "search-specialist", "analysis", "worker", "backend"],
    },
    {
      terms: ["test", "smoke", "verify", "validation", "qa", "测试", "验证"],
      owners: ["test", "verify", "qa", "e2e-runner", "pr-test-analyzer", "build-error-resolver", "worker"],
    },
    {
      terms: ["doc", "docs", "readme", "文档"],
      owners: ["docs", "api-documenter", "content-specialist", "worker"],
    },
    {
      terms: ["frontend", "ui", "react", "前端", "页面"],
      owners: ["frontend", "ui", "react", "accessibility-specialist", "worker"],
    },
    {
      terms: ["backend", "api", "server", "后端"],
      owners: ["backend", "api", "server", "worker"],
    },
    {
      terms: ["review", "审查", "reviewer"],
      owners: ["code-reviewer", "architect-review", "review", "worker"],
    },
  ];
  for (const group of preferenceGroups) {
    if (!group.terms.some((term) => taskLower.includes(term))) continue;
    const owner = findInAvailable(group.owners);
    if (owner) return owner;
  }
  const genericOwner = findInAvailable([
    "worker",
    "backend",
    "code-reviewer",
    "build-error-resolver",
    "api-documenter",
    "architect-review",
  ]);
  if (genericOwner) return genericOwner;
  const scored = candidates.map((id) => {
    const idLower = id.toLowerCase();
    let score = 0;
    for (const part of idLower.split(/[-_./]/)) {
      if (part && part.length >= 3 && taskLower.includes(part)) score += 1;
    }
    return { id, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].id : null;
}

function capabilityDiscoveryTaskRequested() {
  const discoveryVerb = /find|discover|search|match|route|寻找|找|发现|搜索|检索|匹配|路由/.test(taskText);
  const discoveryTarget = /agent|subagent|owner|skill|provider|capability|mcp|tool|智能体|代理|技能|能力|工具/.test(taskText);
  const executionFanoutDiscovery =
    concurrentDispatchIntentPresent && (
      taskShape === "engineering_execution" ||
      entrySignals.directParallelRequest === true ||
      entrySignals.explicitMetaTheory === true ||
      entrySignals.structuredGovernanceChainRequest === true
    );
  return (discoveryVerb && discoveryTarget) || agentProviderReuseConcernRequested() || executionFanoutDiscovery;
}

// 9 类 owner 池（agent / skill / mcp / command / runtimeTool / hook / plugin / memory / dependency）。
// 抽象入口：resolveProvider({ kind, terms, runtime }) → { id, kind, metadata } | null
const PROVIDER_POOL_SOURCES = {
  agent: () => candidateExecutionAgents,
  skill: () => [
    ...repoCanonicalSkillProviders,
    ...projectRuntimeSkillProviders,
    ...localGlobalSkillProviders,
  ],
  mcp: () => [
    ...repoCanonicalCapabilityProviders,
    ...projectRuntimeCapabilityProviders,
    ...localGlobalCapabilityProviders,
  ].filter((p) => p.type === "mcpServer" || p.type === "mcpTool"),
  command: () => [
    ...repoCanonicalCapabilityProviders,
    ...projectRuntimeCapabilityProviders,
    ...localGlobalCapabilityProviders,
  ].filter((p) => p.type === "commands"),
  runtimeTool: () => runtimeToolProviders,
  hook: () => [
    ...repoCanonicalCapabilityProviders,
    ...projectRuntimeCapabilityProviders,
    ...localGlobalCapabilityProviders,
  ].filter((p) => p.type === "hooks"),
  plugin: () => [
    ...repoCanonicalCapabilityProviders,
    ...projectRuntimeCapabilityProviders,
    ...localGlobalCapabilityProviders,
  ].filter((p) => p.type === "plugins"),
  memory: () => [
    ...repoCanonicalCapabilityProviders,
    ...projectRuntimeCapabilityProviders,
    ...localGlobalCapabilityProviders,
  ].filter((p) => p.type === "rules" || p.type === "prompts"),
  dependency: () => [
    ...repoCanonicalCapabilityProviders,
    ...projectRuntimeCapabilityProviders,
    ...localGlobalCapabilityProviders,
  ].filter((p) => p.type === "skills" || p.type === "mcpServers"),
};

// 每类 provider 的 corpus 字段（语义搜索用的描述文本）。
function providerCorpus(p, kind) {
  const base = [p.id, p.description, p.type].filter(Boolean).join(" ");
  return base;
}

// 在指定 kind 的 provider 池里，按 lane terms 找最匹配的 provider。
// 返回 { id, kind, metadata } | null —— 找不到就不强塞，避免假 owner。
function resolveProvider({ kind, terms, runtime: runtimeName = runtime }) {
  const tokens = String(terms ?? "")
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  const declared = new Set(ownerDiscoveryPacket.candidateExistingExecutionOwners);
  const poolFn = PROVIDER_POOL_SOURCES[kind];
  if (!poolFn) return null;
  const pool = poolFn().filter((p) => {
    if (!providerEligibleForRoute(p)) return false;
    if (kind === "agent") return declared.has(p.id);
    return true;
  });
  let best = null;
  let bestScore = 0;
  for (const p of pool) {
    const corpus = providerCorpus(p, kind).toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (corpus.includes(token)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore > 0 ? { id: best.id, kind, metadata: best } : null;
}

function buildParallelExecutionLanes() {
  // 最大限度放开：>=2 个独立工作单元就拆 lane。
  // lane terms 来自 taskText 临时提取（路径 + 显式 lane 标记 + 句子分段），
  // 不预设 DOMAIN_KEYWORDS。owner 通过 resolveProvider 按 9 类池（agent → skill → mcp
  // → command → runtimeTool → hook → plugin → memory → dependency）优先级链探测，
  // 第一个命中的 kind 就用；都找不到就别硬塞。
  const laneSegments = new Map();
  function addLaneSegment(key, laneHint, terms) {
    const normalizedTerms = String(terms ?? "").trim();
    if (!normalizedTerms || normalizedTerms.length < 3) return;
    if (!laneSegments.has(key)) {
      laneSegments.set(key, { laneHint, terms: normalizedTerms });
    }
  }

  function deriveLaneSafetyEvidence(segment, laneId) {
    const segmentText = String(segment?.terms ?? "");
    const mutationRequested = /\b(?:fix|implement|build|refactor|rebuild|migrate|write|edit|update|delete|remove|deploy|publish|release|upload|send)\b|修复|实现|构建|重构|迁移|写入|编辑|更新|删除|移除|部署|发布|上传|发送/iu.test(taskText);
    const inspectionRequested = /\b(?:check|review|inspect|audit|analy[sz]e|verify|investigate)\b|检查|审查|审核|分析|验证|排查/iu.test(taskText);
    const externalWriteRequested = /\b(?:deploy|publish|release|upload|send|email)\b|部署|发布|上传|发送|邮件/iu.test(taskText);
    const explicitPaths = [...segmentText.matchAll(/\b(?:src|test|tests|canonical|config|scripts|docs|app|apps|packages|lib|api|database)(?:[\\/][a-z0-9_.-]+)+/giu)]
      .map((match) => match[0].replace(/\\/g, "/").toLowerCase());
    const readOnly = inspectionRequested && !mutationRequested && !externalWriteRequested;
    const shardScope = explicitPaths.length > 0
      ? [...new Set(explicitPaths)]
      : readOnly
        ? [`read-only-capability:${laneId}`]
        : [];
    const proven =
      !externalWriteRequested &&
      (readOnly || explicitPaths.length > 0);
    return {
      status: proven ? "proven" : "unproven",
      evidenceBasis: readOnly
        ? "read_only_lane_with_unique_capability_scope"
        : explicitPaths.length > 0
          ? "explicit_local_path_scope"
          : "missing_non_overlapping_shard_scope",
      shardScope,
      mutationPolicy: readOnly ? "read_only" : explicitPaths.length > 0 ? "scoped_local_writes_only" : "unproven",
      workspaceIsolation: readOnly ? "shared_workspace_read_only" : explicitPaths.length > 0 ? "shared_workspace_disjoint_paths" : "unproven",
      externalWritePolicy: externalWriteRequested ? "requested_not_parallel_safe" : "forbidden",
      collisionPolicy: proven
        ? "deny_writes_outside_shard_scope_and_merge_through_meta_conductor"
        : "unproven",
    };
  }

  // 1. 路径型 segment：src/ui、src/api、database/migrations —— 每个顶层目录一个 lane
  for (const match of taskText.matchAll(/(?:^|[\s,;:(])([a-z][\w-]*\/[\w.-]+)/g)) {
    const path = match[1];
    const top = path.split("/")[0];
    if (["the", "and", "for", "with", "under", "into", "from", "in", "on", "to"].includes(top)) continue;
    addLaneSegment(`path:${top}`, top, path.replace(/[\/_.]/g, " "));
  }

  // 2. 显式 lane 标记：lane A / lane B —— laneHint 当 key
  for (const match of taskText.matchAll(/lane\s+([a-z0-9]+)/gi)) {
    const label = match[1].toLowerCase();
    addLaneSegment(`lane:${label}`, label, `lane ${label}`);
  }

  // 3. 句子分段：换行、中英文句读、冒号/分号/「and」/「与」断句
  for (const segment of taskText.split(/\n+|[.!?。！？,;，、；:：]|\band\b|与|和|以及/)) {
    const trimmed = segment.trim().replace(GOVERNANCE_CHAIN_PREFIX_RE, "").trim();
    if (trimmed.length < 4) continue;
    addLaneSegment(`seg:${trimmed}`, trimmed.slice(0, 24), trimmed);
  }

  // 4. 无显式标点时，用能力锚点拆 lane。很多真实任务会写成
  // “平台 key adapter 注册 能力账本 路由 上传证据”，入口分类已能识别
  // 多 lane，但句子分段会只得到一整句。这里只在文本已表达并行/治理/
  // 产品多线意图时构造候选 lane；真正的 fan-out 仍由后面的 Thinking
  // worker packets、DAG 与碰撞边界裁决。
  if (concurrentDispatchIntentPresent) {
    const anchorPatterns = [
      {
        key: "meta-theory-rules",
        hint: "meta-theory",
        re: /(?:meta-theory|元理论|治理规则|规则)/iu,
        terms: "meta-theory rules governance",
      },
      {
        key: "codex-runtime",
        hint: "codex-runtime",
        re: /(?:codex\s+runtime|runtime|运行时)/iu,
        terms: "codex runtime adapter",
      },
      {
        key: "test-gap",
        hint: "test",
        re: /(?:测试缺口|测试|test\s+gap|tests?)/iu,
        terms: "test verification gap",
      },
      {
        key: "platform-key-adapter",
        hint: "platform-adapter",
        re: /(?:平台.*(?:key|adapter|适配|注册)|(?:key|adapter).*(?:注册|能力账本))/iu,
        terms: "platform key adapter registry",
      },
      {
        key: "capability-ledger",
        hint: "capability-ledger",
        re: /(?:能力账本|能力矩阵|capability\s+(?:ledger|matrix))/iu,
        terms: "capability ledger matrix",
      },
      {
        key: "platform-route",
        hint: "route",
        re: /(?:平台.*路由|路由|route)/iu,
        terms: "platform route routing",
      },
      {
        key: "upload-evidence",
        hint: "upload-evidence",
        re: /(?:上传证据|上传|upload\s+evidence|upload)/iu,
        terms: "upload evidence proof",
      },
    ];
    for (const pattern of anchorPatterns) {
      if (pattern.re.test(taskText)) {
        if (
          laneSegments.size >= 2 &&
          [...laneSegments.values()].some((segment) =>
            pattern.re.test(`${segment.laneHint ?? ""} ${segment.terms ?? ""}`),
          )
        ) {
          continue;
        }
        addLaneSegment(`anchor:${pattern.key}`, pattern.hint, pattern.terms);
      }
    }
  }

  if (laneSegments.size < 2) return null;

  const KIND_PRIORITY = ["agent", "skill", "mcp", "command", "runtimeTool", "hook", "plugin", "memory", "dependency"];
  const lanes = [];
  for (const [, segment] of laneSegments) {
    let provider = null;
    let capabilityProvider = null;
    if (concurrentDispatchIntentPresent) {
      provider = resolveProvider({ kind: "agent", terms: segment.terms });
      if (!provider) {
        const fallbackOwner = selectExecutionOwner();
        provider = fallbackOwner ? { id: fallbackOwner, kind: "agent", metadata: null } : null;
      }
      for (const kind of KIND_PRIORITY.filter((item) => item !== "agent")) {
        capabilityProvider = resolveProvider({ kind, terms: segment.terms });
        if (capabilityProvider) break;
      }
    } else {
      for (const kind of KIND_PRIORITY) {
        provider = resolveProvider({ kind, terms: segment.terms });
        if (provider) break;
      }
    }
    if (!provider) continue;
    const laneId = `exec-${segment.laneHint.replace(/[^a-z0-9一-鿿-]/gi, "-").toLowerCase()}-${lanes.length + 1}`;
    const safetyEvidence = deriveLaneSafetyEvidence(segment, laneId);
    lanes.push({
      laneId,
      roleDisplayName: roleDisplayNameForOwner(provider.id),
      ownerKind: provider.kind,
      ownerAgent: provider.id,
      codexSpawnBinding: codexSpawnBindingForOwner(provider.id, provider.kind, laneId),
      purpose: `并行执行 "${segment.terms.trim().slice(0, 60)}"；独立交付，由 ${provider.kind}/${provider.id} owner 负责`,
      capabilityProvider,
      decisionImpact: `${provider.kind}/${provider.id} 是 runtime-scoped 真 owner，匹配到 lane terms：${segment.terms.trim().slice(0, 40)}`,
      dependsOn: [],
      parallelGroup: "parallel-execution",
      safetyEvidence,
    });
  }

  if (lanes.length < 2) return null;
  return lanes;
}

// 按 ownerKind 桶分 lane，触发对应 orchestratorKind（fan-out adapter）。
// 6 种 orchestratorKind：agentTeamsPlaybook / skillComposition / mcpComposition
// / commandSequence / runtimeToolSequence / mixedParallelism（混合）。
function classifyOrchestratorKinds(lanes) {
  if (!Array.isArray(lanes) || lanes.length < 2) return [];
  const buckets = new Map();
  for (const lane of lanes) {
    const kind = lane.ownerKind ?? "agent";
    if (!buckets.has(kind)) buckets.set(kind, []);
    buckets.get(kind).push(lane);
  }
  const orchestratorKinds = [];
  for (const [kind, group] of buckets) {
    if (group.length < 2) continue;
    switch (kind) {
      case "agent": orchestratorKinds.push("agentTeamsPlaybook"); break;
      case "skill": orchestratorKinds.push("skillComposition"); break;
      case "mcp": orchestratorKinds.push("mcpComposition"); break;
      case "command": orchestratorKinds.push("commandSequence"); break;
      case "runtimeTool": orchestratorKinds.push("runtimeToolSequence"); break;
      case "hook": orchestratorKinds.push("hookSequence"); break;
      case "plugin": orchestratorKinds.push("pluginComposition"); break;
      case "memory": orchestratorKinds.push("memoryComposition"); break;
      case "dependency": orchestratorKinds.push("dependencyComposition"); break;
      default: orchestratorKinds.push("mixedParallelism");
    }
  }
  if (buckets.size > 1) orchestratorKinds.push("mixedParallelism");
  return orchestratorKinds;
}

function executionCapabilityDiscoveryRoute() {
  const parallelExecutionLanes = buildParallelExecutionLanes();
  const explicitDiscoveryRoute = capabilityDiscoveryTaskRequested();
  if (subjectiveRouteChoice) return null;
  if (taskShape !== "engineering_execution" && !explicitDiscoveryRoute) return null;
  const selectedOwner = selectExecutionOwner();
  const selectedAgentProvider = [
    ...runtimeScopedProjectExecutionAgents,
    ...runtimeScopedLocalGlobalAgents,
  ].find((agent) => agent.id === selectedOwner) ?? null;
  const wantsDiscovery = explicitDiscoveryRoute || /find|discover|search|寻找|发现/.test(taskText);
  const wantsCreation = /create|scaffold|generate|创建|生成/.test(taskText);
  const selectedSkillDiscovery = selectProvider("skills", ["findskill", "skill-scout", "skill-stocktake"]);
  const selectedSkillCreation = selectProvider("skills", ["meta-skill-creator", "create-agent", "agent-teams-playbook"]);
  const selectedSkill = wantsDiscovery
    ? selectedSkillDiscovery ?? selectedSkillCreation
    : wantsCreation
      ? selectedSkillCreation ?? selectedSkillDiscovery
      : selectProvider("skills", ["tdd-workflow", "verification-loop", "meta-theory"]);
  const selectedAgentCreation = selectProvider("skills", ["create-agent", "agent-teams-playbook", "meta-skill-creator"]);
  const selectedMcpServer = selectProvider("mcpServers", ["meta-kim-runtime", "repo-mcp", "codex-config-mcp"]);
  const selectedMcpTool = selectProvider("mcpTools", ["get_meta_runtime_capabilities", "list_meta_agents", "get_meta_agent"]);
  const selectedCommand = selectProvider("commands", ["meta-theory", "save-progress"]);
  const selectedRuntimeTool = selectProvider("runtimeTools", ["apply_patch", "shell_command", "Bash"]);
  const blockedReasons = [];
  if (!selectedOwner) blockedReasons.push("execution owner missing");
  if (!selectedSkill) blockedReasons.push("skill provider missing");
  if (!selectedMcpServer && !selectedMcpTool) blockedReasons.push("MCP provider missing");
  // Missing accepted runtime-tool evidence blocks Execution in the independent
  // capability gate below; it must not erase the correct design-time route.
  const routeScore = blockedReasons.length ? 49 : explicitDiscoveryRoute ? 92 : 88;
  return {
    id: `execution-capability-discovery:${runtime}:${osTarget}`,
    owner: selectedOwner,
    weapon: "select-execution-route",
    dependency: selectedSkill?.id ?? null,
    dependencyProject: null,
    runtime,
    os: osTarget,
    verificationOwner: "meta-prism",
    verificationMethod: "npm run meta:route:validate",
    verification: {
      command: "npm run meta:route:validate",
      artifact: "route JSON",
      passCondition: "Execution capability discovery route has a runtime-valid non-governance owner plus discovered skill, MCP, command/tool, runtime, OS, and verification owner.",
    },
    score: routeScore,
    scoreBand: routeScore >= 85 ? "execute" : "blocked",
    routeScoreBreakdown: {
      intentFitWeight: 20,
      ownerFitWeight: 15,
      weaponFitWeight: 15,
      dependencyFitWeight: 15,
      runtimeSupportWeight: 10,
      osSupportWeight: 10,
      verificationStrengthWeight: 10,
      riskRollbackClarityWeight: 5,
      runtimeSupport: activeRuntimeSupport(),
      osSupport: "supported",
      dependencyFit: selectedSkill ? 85 : 0,
    },
    ownerBinding: {
      selectedOwner,
      source: "existing_execution_owner_inventory",
      existingOwnerMatched: Boolean(selectedOwner),
      bindingStage: "Thinking",
      providerEvidenceRef: "ownerDiscoveryPacket.candidateReusableCapabilityProviders",
      ownerDiscoveryRef: "ownerDiscoveryPacket",
    },
    codexSpawnBinding: codexSpawnBindingForOwner(selectedOwner, "agent"),
    selectedCapabilityProviders: {
      agentOwner: selectedOwner,
      agent: selectedAgentProvider,
      agentCreation: selectedAgentCreation,
      skill: selectedSkill,
      skillDiscovery: selectedSkillDiscovery,
      skillCreation: selectedSkillCreation,
      mcpServer: selectedMcpServer,
      mcpTool: selectedMcpTool,
      command: selectedCommand,
      runtimeTool: selectedRuntimeTool,
    },
    parallelExecutionLanes,
    blockedReasons,
  };
}

function goalProContractRoute() {
  if (taskShape !== "goal_contract") return null;
  const selectedSkill = selectProvider("skills", ["goalpro"]);
  const dependency = dependencyRecords.find((dep) => dep.id === "goalpro") ?? null;
  const blockedReasons = [];
  if (!selectedSkill) blockedReasons.push("goalpro skill provider missing");
  if (!dependency) blockedReasons.push("goalpro dependency project missing");
  if (dependency && !dependencyExecutable(dependency)) blockedReasons.push("goalpro dependency not executable");
  const score = blockedReasons.length ? 49 : 92;
  return {
    id: `goalpro-contract:${runtime}:${osTarget}`,
    owner: "meta-conductor",
    weapon: "goalpro",
    dependency: selectedSkill?.id ?? "goalpro",
    dependencyProject: "goalpro",
    runtime,
    os: osTarget,
    verificationOwner: "meta-prism",
    verificationMethod: "npm run meta:deps:compat",
    verification: {
      command: "npm run meta:deps:compat",
      artifact: "config/skills.json; config/capability-index/dependency-project-registry.json",
      passCondition: "GoalPro is registered as a prompt-only dependency skill for Goal Prompt / Loop Prompt / intent-amplification work.",
    },
    score,
    scoreBand: score >= 85 ? "execute" : "blocked",
    routeScoreBreakdown: {
      intentFitWeight: 20,
      ownerFitWeight: 15,
      weaponFitWeight: 15,
      dependencyFitWeight: 15,
      runtimeSupportWeight: 10,
      osSupportWeight: 10,
      verificationStrengthWeight: 10,
      riskRollbackClarityWeight: 5,
      runtimeSupport: activeRuntimeSupport(),
      osSupport: "supported",
      dependencyFit: dependency ? 95 : 0,
    },
    ownerBinding: {
      selectedOwner: "meta-conductor",
      source: "goal_contract_task_shape",
      existingOwnerMatched: true,
      bindingStage: "Thinking",
      providerEvidenceRef: "candidateDependencyProjects.goalpro",
      ownerDiscoveryRef: "ownerDiscoveryPacket",
    },
    selectedCapabilityProviders: selectedSkill ? [selectedSkill] : [],
    boundary: {
      invokeAs: "skill",
      executionMode: "prompt_only",
      notExecutor: true,
      notAutomationScheduler: true,
    },
    blockedReasons,
  };
}

function kimDecisionExperienceRoute() {
  if (!decisionAdjustmentRequested()) return null;
  const selectedSkill = selectProvider("skills", ["kim-decision"]);
  const dependency = dependencyRecords.find((dep) => dep.id === "kim-decision") ?? null;
  const blockedReasons = [];
  if (!selectedSkill) blockedReasons.push("kim-decision skill provider missing");
  if (!dependency) blockedReasons.push("kim-decision dependency project missing");
  const score = blockedReasons.length ? 49 : 93;
  return {
    id: `kim-decision-lens:${runtime}:${osTarget}`,
    owner: "meta-warden",
    weapon: "meta-kim-decision-patterns",
    dependency: null,
    dependencyProject: null,
    decisionLensProvider: selectedSkill?.id ?? "kim-decision",
    runtime,
    os: osTarget,
    verificationOwner: "meta-prism",
    verificationMethod: "npm run meta:route:validate",
    verification: {
      command: "npm run meta:route:validate",
      artifact: "route JSON",
      passCondition: "Decision tasks expose a Kim_Decision decision lens without promoting it to code executor, then offer GoalPro only after the decision is ready to become a goal.",
    },
    score,
    scoreBand: score >= 85 ? "execute" : "blocked",
    routeScoreBreakdown: {
      intentFitWeight: 20,
      ownerFitWeight: 15,
      weaponFitWeight: 15,
      dependencyFitWeight: 15,
      runtimeSupportWeight: 10,
      osSupportWeight: 10,
      verificationStrengthWeight: 10,
      riskRollbackClarityWeight: 5,
      runtimeSupport: activeRuntimeSupport(),
      osSupport: "supported",
      dependencyFit: dependency ? 90 : 0,
    },
    ownerBinding: {
      selectedOwner: "meta-warden",
      source: "decision_adjustment_task_shape",
      existingOwnerMatched: true,
      bindingStage: "Thinking",
      providerEvidenceRef: "candidateDependencyProjects.kim-decision",
      ownerDiscoveryRef: "ownerDiscoveryPacket",
    },
    selectedCapabilityProviders: selectedSkill ? [selectedSkill] : [],
    boundary: {
      invokeAs: "decision_lens",
      executionMode: "model_context",
      notExecutor: true,
      notImplementationWorker: true,
      notAutomationScheduler: true,
    },
    decisionExperiencePlan: {
      userVisibleActivation: "Kim_Decision decision lens",
      scope:
        "Decision support only during Critical, Fetch, and Thinking. It does not create a Goal, run execution, schedule automation, or start a Loop.",
      sequence: [
        {
          step: "critical_decision",
          provider: "kim-decision",
          stage: "Critical",
          purpose: "锁定真问题、成功标准、非目标、关键取舍和 pass/kill 判断，不急着写执行目标。",
        },
        {
          step: "fetch_evidence_decision",
          provider: "kim-decision",
          stage: "Fetch",
          purpose: "判断哪些证据会改变路线，哪些外部/本地事实必须先查，避免拍脑袋决策。",
        },
        {
          step: "thinking_path_decision",
          provider: "kim-decision",
          stage: "Thinking",
          purpose: "比较候选路径，选择最小 MVP / 最小验证 / 执行路线，并记录为什么不走其他路。",
        },
      ],
      goalProBoundary:
        "GoalPro is not triggered by this route. It is selected only when the user explicitly asks for Goal Prompt, Loop Prompt, goal contract, or prompt-only goal packaging.",
      loopBoundary:
        "Loop belongs after a Goal has produced a result and the user wants a next-round review/continuation prompt; it is not part of Critical, Fetch, Thinking, or Evolution writeback.",
      evolutionBoundary:
        "Evolution records Meta_Kim system writeback or none-with-reason; it is not the place that creates user Goals.",
    },
    blockedReasons,
  };
}

function subjectiveUiDesignRoute() {
  if (!subjectiveRouteChoice) return null;
  const selectedProviders = {
    context: selectAnyProvider(["product-design/0.1.46/skills/get-context", "get-context", "design-consultation"], ["skills"]),
    ideation: selectAnyProvider(["product-design/0.1.46/skills/ideate", "ideate", "design-shotgun", "taste-skill", "web-design-guidelines"], ["skills"]),
    visualReview: selectAnyProvider(["design-review", "plan-design-review", "taste-skill", "design-qa"], ["skills"]),
    implementation: selectAnyProvider(["design-html", "frontend-patterns", "product-design/0.1.46/skills/image-to-code", "image-to-code"], ["skills"]),
    browser: selectAnyProvider(["control-in-app-browser", "agent-browser", "open-gstack-browser", "cli-anything-browser"], ["skills"]),
    e2e: selectAnyProvider(["e2e-testing", "windows-desktop-e2e", "agent-browser-verify"], ["skills"]),
    runtimeEdit: selectProvider("runtimeTools", ["apply_patch"]),
    shell: selectProvider("runtimeTools", ["shell_command"]),
    verificationCommand: selectProvider("commands", ["package-script:meta:route:validate", "package-script:meta:test:meta-theory", "package-script:meta:release:smoke"]),
    mcp: selectProvider("mcpServers", ["meta-kim-runtime", "repo-mcp", "codex-config-mcp"]),
  };
  const lanes = [
    {
      laneId: "intent-calibration",
      roleDisplayName: "analysis",
      ownerAgent: selectOwner(["analysis", "frontend", "worker"]) ?? "analysis",
      purpose: "把“高级一点”翻译成目标用户、页面目标、审美方向、非目标和验收标准。",
      capabilityProvider: selectedProviders.context,
      decisionImpact: "决定是微调、系统重做，还是先做诊断报告。",
      dependsOn: [],
      parallelGroup: "subjective-ui-prep",
    },
    {
      laneId: "design-direction",
      roleDisplayName: "frontend",
      ownerAgent: selectOwner(["frontend", "analysis", "worker"]) ?? "frontend",
      purpose: "提出视觉层级、间距、字体、颜色、组件状态、响应式和动效方案。",
      capabilityProvider: selectedProviders.ideation,
      decisionImpact: "决定设计路线和需要变更的文件范围。",
      dependsOn: ["intent-calibration"],
      parallelGroup: "subjective-ui-design",
    },
    {
      laneId: "read-before-edit-implementation",
      roleDisplayName: "frontend",
      ownerAgent: selectOwner(["frontend", "worker"]) ?? "frontend",
      purpose: "先读取页面、组件、样式和设计系统，再做最小可逆改动。",
      capabilityProvider: selectedProviders.implementation,
      runtimeTool: selectedProviders.runtimeEdit,
      decisionImpact: "把设计方案变成代码，但不能绕过读前改约束。",
      dependsOn: ["design-direction"],
      parallelGroup: "subjective-ui-execution",
    },
    {
      laneId: "browser-qa",
      roleDisplayName: "test",
      ownerAgent: selectOwner(["test", "verify", "worker"]) ?? "test",
      purpose: "用浏览器/截图/响应式检查验证页面是否真的变高级且没有破坏体验。",
      capabilityProvider: selectedProviders.e2e ?? selectedProviders.browser,
      runtimeTool: selectedProviders.shell,
      decisionImpact: "决定是否可以进入 Review，还是回到设计/实现。",
      dependsOn: ["read-before-edit-implementation"],
      parallelGroup: "subjective-ui-verification",
    },
    {
      laneId: "design-review",
      roleDisplayName: "review",
      ownerAgent: selectOwner(["review", "verify", "analysis"]) ?? "review",
      purpose: "检查是否只是堆装饰、是否违背产品目标、是否破坏设计系统和可用性。",
      capabilityProvider: selectedProviders.visualReview,
      decisionImpact: "决定修订、放行，或需要用户在质量/速度间再选。",
      dependsOn: ["browser-qa"],
      parallelGroup: "subjective-ui-review",
    },
    {
      laneId: "evolution-signal",
      roleDisplayName: "analysis",
      ownerAgent: "meta-chrysalis",
      purpose: "只有当同类审美/页面改造模式可复用时才写回，否则 none-with-reason。",
      capabilityProvider: selectAnyProvider(["evolution-writeback", "meta-theory"], ["skills"]),
      decisionImpact: "让 Evolution 成为复用信号判断，而不是摆设。",
      dependsOn: ["design-review"],
      parallelGroup: "subjective-ui-evolution",
    },
  ];
  const missing = lanes
    .filter((lane) => !lane.ownerAgent || !lane.capabilityProvider)
    .map((lane) => `${lane.laneId}:missing_owner_or_provider`);
  const score = missing.length ? 78 : 94;
  return {
    id: `subjective-ui-design-orchestration:${runtime}:${osTarget}`,
    owner: "meta-conductor",
    weapon: "select-execution-route",
    dependency: selectedProviders.ideation?.id ?? selectedProviders.context?.id ?? null,
    dependencyProject: null,
    runtime,
    os: osTarget,
    verificationOwner: "meta-prism",
    verificationMethod: "npm run meta:route:validate",
    verification: {
      command: "npm run meta:route:validate",
      artifact: "route JSON and UI workflow evidence",
      passCondition: "Subjective UI route exposes intent, design, implementation, browser QA, review, and evolution lanes with concrete providers and no read-before-edit gap.",
    },
    score,
    scoreBand: score >= 85 ? "execute_after_native_choices" : "confirm_or_fetch_more",
    routeScoreBreakdown: {
      intentFitWeight: 20,
      ownerFitWeight: 15,
      weaponFitWeight: 15,
      dependencyFitWeight: 15,
      runtimeSupportWeight: 10,
      osSupportWeight: 10,
      verificationStrengthWeight: 10,
      riskRollbackClarityWeight: 5,
      runtimeSupport: activeRuntimeSupport(),
      osSupport: "supported",
      dependencyFit: missing.length ? 60 : 92,
    },
    ownerBinding: {
      selectedOwner: "meta-conductor",
      source: "subjective_ui_design_orchestration",
      existingOwnerMatched: true,
      bindingStage: "Thinking",
      providerEvidenceRef: "subjectiveUiCapabilityAmplification.lanes",
      ownerDiscoveryRef: "ownerDiscoveryPacket",
    },
    selectedCapabilityProviders: selectedProviders,
    subjectiveUiCapabilityAmplification: {
      intent: "把模糊审美诉求放大成产品目标、设计方向、实现边界、浏览器验证、审美评审和复用判断。",
      decisionCheckpoints: [
        {
          stage: "Critical",
          surface: "request_user_input",
          question: "高级一点是哪种高级，以及这次允许改到什么范围？",
          options: ["最小可逆视觉升级", "系统化重做页面体验", "先出诊断报告不改代码"],
          requiredBefore: "Fetch/Thinking route lock",
        },
        {
          stage: "Thinking",
          surface: "request_user_input",
          question: "Fetch 读完页面和能力后，选择执行路线：微调、重做、还是只交付审美诊断？",
          options: ["保守微调", "系统化重做", "诊断报告"],
          requiredBefore: "Execution",
        },
        {
          stage: "Review",
          surface: "request_user_input_if_tradeoff",
          question: "如果 Review 发现速度和质量冲突，是否继续打磨还是先收敛上线？",
          options: ["继续打磨", "先收敛", "回到设计"],
          requiredBefore: "Revision",
        },
      ],
      lanes,
      omittedLanesWithReason: [
        { laneId: "backend", reason: "页面视觉质量请求没有后端/API 证据。" },
        { laneId: "database", reason: "没有数据结构或迁移需求。" },
        { laneId: "auth-security", reason: "没有权限、安全或认证变更。" },
        { laneId: "external-dependency", reason: "不默认引入第三方 UI 依赖；只有用户选择系统化重做或 Fetch 证明现有能力不足时才触发。" },
      ],
      readBeforeEditPolicy:
        "Execution lane must read target page/component/style files in the same turn before apply_patch/Edit/Write.",
      reviewUse:
        "Review now has concrete standards: product goal fit, visual hierarchy, design-system consistency, browser evidence, responsive behavior, and no decorative-only polish.",
      evolutionUse:
        "Evolution records reusable UI-polish playbook only when the same pattern repeats or Review finds a durable skill/agent gap; otherwise none-with-reason.",
    },
    blockedReasons: missing,
  };
}

function productBuildOrchestrationRoute() {
  if (
    entryClassification.triggerReason !== "natural_language_product_build" &&
    entrySignals.productBuildIntent !== true
  ) {
    return null;
  }
  if (productRouteDecisionRequested()) {
    return null;
  }
  const lane = ({
    laneId,
    label,
    roleDisplayName,
    ownerPriority,
    purpose,
    capabilityNeed,
    includeWhen = () => true,
    omissionReason = "当前输入没有证明这条 lane 是必要执行范围。",
    dependsOn = [],
    parallelGroup,
  }) => ({
    laneId,
    businessFlowLaneId: laneId,
    businessFlowLaneLabel: label,
    roleDisplayName,
    ownerAgent: selectOwner(ownerPriority) ?? ownerPriority.find((o) => ownerDiscoveryPacket.candidateExistingExecutionOwners.includes(o)) ?? null,
    purpose,
    capabilityNeed,
    includeWhen,
    omissionReason,
    decisionImpact: `${label} 决定当前产品构建路线是否能继续进入下一批执行。`,
    dependsOn,
    parallelGroup,
  });
  const evidence = productBuildLaneEvidence();
  const candidateLanes = [
    lane({
      laneId: "product-definition",
      label: "产品定义",
      roleDisplayName: "analysis",
      ownerPriority: ["analysis", "worker"],
      purpose: "把一句许愿式需求拆成用户、核心场景、边界、成功标准和非目标。",
      capabilityNeed: ["product-intent-and-context", "governance-orchestration"],
      parallelGroup: "product-build-discovery",
    }),
    lane({
      laneId: "market-research",
      label: "市场与平台规则研究",
      roleDisplayName: "analysis",
      ownerPriority: ["analysis", "docs", "worker"],
      purpose: "查清平台规则、内容风险、竞品和自动发布限制，避免先做错方向。",
      capabilityNeed: ["capability-discovery-and-retrieval", "current-platform-policy-research"],
      includeWhen: () => evidence.currentResearch || evidence.automationIntegration || evidence.safety,
      omissionReason: "当前任务没有平台规则、竞品、外部事实或自动发布风险证据。",
      parallelGroup: "product-build-discovery",
    }),
    lane({
      laneId: "content-strategy",
      label: "内容策略与生成",
      roleDisplayName: "docs",
      ownerPriority: ["docs", "analysis", "worker"],
      purpose: "设计内容主题、生成链路、审核口径和人工介入点。",
      capabilityNeed: ["content-generation-and-review", "safety-hooks-and-permissions"],
      dependsOn: ["product-definition", "market-research"],
      parallelGroup: "product-build-design",
    }),
    lane({
      laneId: "ux-flow",
      label: "UX 流程",
      roleDisplayName: "frontend",
      ownerPriority: ["frontend", "analysis", "worker"],
      purpose: "设计从选题、生成、审核、排期到发布回看的一条主流程。",
      capabilityNeed: ["frontend-ui-design", "product-intent-and-context"],
      includeWhen: () => evidence.interfaceNeeded || evidence.implementation || evidence.automationIntegration,
      omissionReason: "当前任务更像内容/方案产出，没有用户界面或操作流程设计证据。",
      dependsOn: ["product-definition", "content-strategy"],
      parallelGroup: "product-build-design",
    }),
    lane({
      laneId: "frontend-ui",
      label: "前端界面",
      roleDisplayName: "frontend",
      ownerPriority: ["frontend", "worker"],
      purpose: "设计选题、内容预览、排期、审核和发布状态的操作界面。",
      capabilityNeed: ["frontend-ui-design", "execution-tools-and-commands"],
      includeWhen: () => evidence.interfaceNeeded || evidence.implementation,
      omissionReason: "当前任务没有页面、应用、前端或可视化操作界面证据。",
      dependsOn: ["ux-flow"],
      parallelGroup: "product-build-implementation",
    }),
    lane({
      laneId: "backend-api",
      label: "后端 API",
      roleDisplayName: "backend",
      ownerPriority: ["backend", "worker"],
      purpose: "定义内容生成、审核、排期、发布、回调和状态查询 API。",
      capabilityNeed: ["backend-api-and-workflow", "execution-tools-and-commands"],
      includeWhen: () => evidence.implementation || evidence.automationIntegration,
      omissionReason: "当前任务没有 API、后端服务、自动化工作流或系统实现证据。",
      dependsOn: ["platform-integration"],
      parallelGroup: "product-build-implementation",
    }),
    lane({
      laneId: "data-model",
      label: "数据与任务状态",
      roleDisplayName: "backend",
      ownerPriority: ["backend", "worker"],
      purpose: "设计任务状态、发布记录、错误记录和可追踪证据。",
      capabilityNeed: ["data-state-and-observability", "execution-tools-and-commands"],
      includeWhen: () => evidence.dataState || evidence.automationIntegration || evidence.implementation,
      omissionReason: "当前任务没有数据库、任务状态、记录留存或观测追踪证据。",
      dependsOn: ["platform-integration"],
      parallelGroup: "product-build-implementation",
    }),
    lane({
      laneId: "platform-integration",
      label: "自动发布架构",
      roleDisplayName: "backend",
      ownerPriority: ["backend", "analysis", "worker"],
      purpose: "设计账号、任务、队列、发布适配和失败重试的执行架构。",
      capabilityNeed: ["mcp-external-provider-and-plugin", "backend-api-and-workflow"],
      includeWhen: () => evidence.automationIntegration,
      omissionReason: "当前任务没有外部平台集成、账号授权、自动发布或适配器证据。",
      dependsOn: ["product-definition", "market-research"],
      parallelGroup: "product-build-design",
    }),
    lane({
      laneId: "security-approval",
      label: "风险与权限边界",
      roleDisplayName: "review",
      ownerPriority: ["review", "analysis", "worker"],
      purpose: "确认账号权限、平台规则、敏感操作和人工确认点，不把高风险发布做成黑箱。",
      capabilityNeed: ["safety-hooks-and-permissions", "mcp-external-provider-and-plugin"],
      includeWhen: () => evidence.safety || evidence.automationIntegration,
      omissionReason: "当前任务没有权限、账号、外部写入、平台风险或敏感操作证据。",
      dependsOn: ["market-research", "platform-integration"],
      parallelGroup: "product-build-review",
    }),
    lane({
      laneId: "test-qa",
      label: "测试验收",
      roleDisplayName: "test",
      ownerPriority: ["test", "verify", "worker"],
      purpose: "设计端到端、失败重试、权限边界、内容审核和回归验收。",
      capabilityNeed: ["verification-eval-and-release", "execution-tools-and-commands"],
      includeWhen: () => evidence.verification,
      omissionReason: "当前任务未进入实现、上线或可执行系统验证范围。",
      dependsOn: ["frontend-ui", "backend-api", "data-model"],
      parallelGroup: "product-build-verification",
    }),
    lane({
      laneId: "release-ops",
      label: "发布与运行手册",
      roleDisplayName: "docs",
      ownerPriority: ["docs", "test", "worker"],
      purpose: "整理上线前检查、运行步骤、回滚方式和用户可见交付物。",
      capabilityNeed: ["content-generation-and-review", "verification-eval-and-release"],
      includeWhen: () => evidence.verification || evidence.automationIntegration,
      omissionReason: "当前任务没有上线、运行、回滚或系统交付手册证据。",
      dependsOn: ["test-qa", "security-approval"],
      parallelGroup: "product-build-closure",
    }),
  ];
  const selectedLaneIds = new Set(candidateLanes.filter((item) => item.includeWhen(evidence)).map((item) => item.laneId));
  const lanes = candidateLanes
    .filter((item) => selectedLaneIds.has(item.laneId))
    .map(({ includeWhen, omissionReason, dependsOn, ...item }) => ({
      ...item,
      dependsOn: dependsOn.filter((laneId) => selectedLaneIds.has(laneId)),
      selectionEvidence: {
        policy: "dynamic_evidence_screening",
        source: "task_intent_signals",
        contentOnly: evidence.contentOnly,
      },
    }));
  const omittedLanesWithReason = [
    ...candidateLanes
      .filter((item) => !selectedLaneIds.has(item.laneId))
      .map((item) => ({ laneId: item.laneId, reason: item.omissionReason })),
    ...(!hasProductBuildSignal("monetization")
      ? [{ laneId: "payment", reason: "用户没有要求付费、订阅、定价或商业化收款。" }]
      : []),
    ...(!hasProductBuildSignal("mobile")
      ? [{ laneId: "native-mobile", reason: "当前需求没有原生 App 或移动端实现证据。" }]
      : []),
  ];
  const capabilityTeamBlueprint = buildCapabilityTeamBlueprint(lanes, omittedLanesWithReason, evidence);
  const lanesWithBindings = lanes.map((item) => {
    const capabilityBinding = bindLaneCapabilityProviders(item);
    return {
      ...item,
      capabilityProvider: capabilityBinding.selectedProvider,
      runtimeTool: capabilityBinding.selectedProviders.runtimeTool,
      capabilityBinding,
      providerMatch: {
        capabilityNeed: capabilityBinding.capabilityNeed,
        selectionPolicy: capabilityBinding.selectionPolicy,
        candidateProviders: capabilityBinding.candidateProviders,
        selectedProvider: providerSummary(
          capabilityBinding.selectedProvider,
          capabilityBinding.selectedProvider?.id,
        ),
        whySelected: capabilityBinding.whySelected,
        whyNotSelected: capabilityBinding.whyNotSelected,
      },
    };
  });
  const laneProviderEntries = lanesWithBindings.flatMap((item) => {
    const providers = item.capabilityBinding?.selectedProviders ?? {};
    return Object.entries(providers)
      .filter(([, provider]) => provider)
      .map(([kind, provider]) => [`lane:${item.laneId}:${kind}`, provider]);
  });
  const selectedProviders = Object.fromEntries(laneProviderEntries);
  const firstSelectedSkill = lanesWithBindings.find((item) => item.capabilityProvider)?.capabilityProvider ?? null;
  const missing = lanes
    .filter((item, index) => !lanesWithBindings[index]?.capabilityProvider)
    .map((item) => `${item.laneId}:missing_provider`);
  const score = missing.length ? 78 : 93;
  return {
    id: `product-build-orchestration:${runtime}:${osTarget}`,
    owner: "meta-conductor",
    weapon: "select-execution-route",
    dependency: firstSelectedSkill?.id ?? null,
    dependencyProject: null,
    runtime,
    os: osTarget,
    verificationOwner: "meta-prism",
    verificationMethod: "npm run meta:route:validate",
    verification: {
      command: "npm run meta:route:validate",
      artifact: "route JSON and product-build lane evidence",
      passCondition: "Natural-language product build route selects only evidence-backed lanes from a broad candidate universe and records omitted lanes with reasons.",
    },
    score,
    scoreBand: score >= 85 ? "execute" : "confirm_or_fetch_more",
    routeScoreBreakdown: {
      intentFitWeight: 20,
      ownerFitWeight: 15,
      weaponFitWeight: 15,
      dependencyFitWeight: 15,
      runtimeSupportWeight: 10,
      osSupportWeight: 10,
      verificationStrengthWeight: 10,
      riskRollbackClarityWeight: 5,
      runtimeSupport: activeRuntimeSupport(),
      osSupport: "supported",
      dependencyFit: missing.length ? 60 : 90,
    },
    ownerBinding: {
      selectedOwner: "meta-conductor",
      source: "natural_language_product_build_orchestration",
      existingOwnerMatched: true,
      bindingStage: "Thinking",
      providerEvidenceRef: "subjectiveUiCapabilityAmplification.lanes",
      ownerDiscoveryRef: "ownerDiscoveryPacket",
    },
    selectedCapabilityProviders: selectedProviders,
    subjectiveUiCapabilityAmplification: {
      intent: "把许愿式产品构建需求放大成用户能看懂的业务执行图，再映射到 agent、skill、MCP、command、runtime tool 和验证 owner。",
      decisionCheckpoints: [
        {
          stage: "Critical",
          surface: "request_user_input_if_route_changes",
          question: "如果产品方向、发布风险或自动化边界会改变执行路线，先让用户选择范围。",
          options: ["先做 MVP", "先做方案和风险评审", "直接进入实现"],
          requiredBefore: "Execution when route-changing ambiguity remains",
        },
      ],
      lanes: lanesWithBindings,
      candidateLaneUniverse: candidateLanes.map((item) => item.laneId),
      laneSelectionPolicy:
        "dynamic_evidence_screening: keep a broad candidate universe, select only lanes justified by current task signals, and record omitted lanes with human-readable reasons.",
      capabilityTeamBlueprint,
      omittedLanesWithReason,
      readBeforeEditPolicy:
        "Any implementation lane must read target files in the same turn before apply_patch/Edit/Write.",
      reviewUse:
        "Review checks product value, platform risk, implementation boundaries, test evidence, and whether the route stayed user-visible.",
      evolutionUse:
        "Evolution writes back only when repeated product-build routing exposes a reusable agent, skill, MCP, command, or hook improvement.",
    },
    blockedReasons: missing,
    score: missing.length ? 49 : 90,
    scoreBand: missing.length ? "blocked" : "execute",
  };
}

const syntheticRoutes = [
  goalProContractRoute(),
  kimDecisionExperienceRoute(),
  productBuildOrchestrationRoute(),
  subjectiveUiDesignRoute(),
  executionCapabilityDiscoveryRoute(),
].filter(Boolean);
const independentTaskShape = subjectiveRouteChoice
  ? "governed_dispatch"
  : entryClassification.path === "fast_path"
    ? "fast_path"
  : entrySignals.productBuildIntent === true
    ? "product_build"
    : taskShape === "engineering_execution"
      ? "engineering_execution"
      : entrySignals.explicitMetaTheory === true
        ? "governed_dispatch"
        : "default_executable";
const rankedRoutes = [...candidateWeapons.map(routeForWeapon), ...syntheticRoutes]
  .map((route) => {
    const executionCapabilityGate = evaluateRouteExecutionGate({
      route,
      runtime,
      taskShape: independentTaskShape,
      choiceRequired: subjectiveRouteChoice,
      effectiveMatrix: runtimeMatrix,
    });
    return {
      ...route,
      requiredRuntimeCapabilities: executionCapabilityGate.requirements,
      executionCapabilityGate: { ...executionCapabilityGate, applies: independentTaskShape !== "fast_path" },
      executionPolicy: independentTaskShape,
      executionEligible: false,
      hostHandoffEligible: independentTaskShape !== "fast_path" && executionCapabilityGate.routeCompatible,
    };
  })
  .sort((a, b) => b.score - a.score);
const recommendedRoute = rankedRoutes.find((route) => route.score >= 85) ?? rankedRoutes.find((route) => route.score >= 70) ?? null;
const capabilityGapPacket = recommendedRoute ? null : {
  gap: "No route has enough owner + weapon + dependency + runtime + OS + verification support.",
  taskShape,
  currentAgentsChecked: [...new Set([...ownerDiscoveryPacket.candidateExistingExecutionOwners, ...ownerDiscoveryPacket.governanceStageOwners])].slice(0, 60),
  currentProvidersChecked: ownerDiscoveryPacket.candidateReusableCapabilityProviders.slice(0, 80),
  ownerDiscoveryRef: "ownerDiscoveryPacket",
  missing: rankedRoutes[0]?.blockedReasons?.length ? rankedRoutes[0].blockedReasons : ["owner_weapon_dependency_route"],
  returnToStage: "Thinking",
};
const capabilityGapDetected = !recommendedRoute || explicitCapabilityGapRequested();
const capabilityGapDecision = capabilityGapDetected
  ? (() => {
      const result = decideCapabilityGap(task, {
        currentProvidersChecked: ownerDiscoveryPacket.evidenceRefs,
        requestedCapability: task || capabilityGapPacket?.gap || "Capability gap route decision",
        insufficiencyReason: capabilityGapPacket?.gap ?? "Task explicitly asks for a capability-gap decision before Execution.",
        riskIfUnresolved:
          "A normal route may hide a missing capability, fake owner, missing verifier, or unauthorized provider path.",
        requiredEvidence: CAPABILITY_GAP_DECISION_CONTRACT.requiredEvidenceKeys,
      });
      return {
        detected: true,
        source: recommendedRoute ? "explicit_gap_signal" : "missing_recommended_route",
        decision: result.gapDecision.decision,
        gapDecision: result.gapDecision,
        decisionEvidence: result.decisionEvidence,
        decisionOutput: result.decisionOutput,
        candidateWriteback: result.candidateWriteback,
        generatedAgentSpec: result.generatedAgentSpec,
        workerTaskPacket: result.workerTaskPacket,
        blockedReason: result.blockedReason,
        graphPath: result.graphPath,
        acceptance: {
          requiredEvidenceCovered: result.decisionEvidence.status === "pass",
          missingEvidence: result.decisionEvidence.missingEvidence,
          forbiddenBehaviors: result.decisionEvidence.decisionRule.forbiddenBehaviors,
        },
      };
    })()
  : null;
const capabilityGapBlocksExecution = Boolean(
  capabilityGapDecision &&
    (capabilityGapDecision.decision === "blocked_or_needs_approval" ||
      capabilityGapDecision.decisionEvidence?.status !== "pass"),
);
function routeOwnershipType(route) {
  const selectedAgent = route?.selectedCapabilityProviders?.agent;
  const source = String(selectedAgent?.source ?? route?.ownerBinding?.source ?? "");
  if (route?.dependencyProject) return "external_dependency";
  if (source.includes("project_runtime")) return "project_mirror";
  if (source.includes("local_global")) return "global_home";
  if (route?.owner?.startsWith("meta-")) return "canonical_source";
  return "unknown";
}

function classifyRouteTypes(route, { gapDecision, gapPacket, gapBlocksExecution }) {
  const overallDisposition = !route
    ? "capabilityGapPacket"
    : gapBlocksExecution
      ? "blocked_with_reason"
      : route.score < 85
        ? "confirm_or_fetch_more"
        : "classified_route_can_be_scored";
  return {
    policyRef: "typeFirstRoutePolicy",
    objectType: {
      selected: route?.dependencyProject
        ? "external_dependency"
        : route?.weapon
          ? "capability_provider"
          : "unknown",
      source: route ? "recommendedRoute" : "capabilityGapPacket",
      disposition: !route ? "capabilityGapPacket" : overallDisposition,
      unclearAction: !route ? "capabilityGapPacket" : null,
      forbiddenFallbackAvoided: true,
    },
    evidenceType: {
      selected: "structural",
      source: route?.verificationMethod ? "recommendedRoute.verificationMethod" : "routeExecutionGate",
      claimLimit: "route_preview_not_runtime_truth",
      disposition: overallDisposition,
      forbiddenFallbackAvoided: true,
    },
    ownershipType: {
      selected: routeOwnershipType(route),
      source: route?.ownerBinding?.ownerDiscoveryRef ?? "ownerDiscoveryPacket",
      disposition: routeOwnershipType(route) === "unknown" ? "preserve_or_block_until_owner_is_known" : overallDisposition,
      forbiddenFallbackAvoided: routeOwnershipType(route) !== "unknown",
    },
    gapDecisionRef: gapDecision ? "capabilityGapDecision" : null,
    gapPacketRef: gapPacket ? "capabilityGapPacket" : null,
    overallDisposition,
  };
}

const routeTypeClassification = classifyRouteTypes(recommendedRoute, {
  gapDecision: capabilityGapDecision,
  gapPacket: capabilityGapPacket,
  gapBlocksExecution: capabilityGapBlocksExecution,
});
const userChoiceNeeded = Boolean(recommendedRoute && recommendedRoute.score >= 70 && recommendedRoute.score < 85);
const decisionCard = userChoiceNeeded ? {
  recommendedDefault: recommendedRoute.id,
  reason: "Route is useful but needs confirmation or more evidence because score is 70-84.",
  choicePolicy: choiceSurfacePolicy.choiceRequiredWhen,
  options: rankedRoutes.slice(0, 3).map((route) => ({
    id: route.id,
    bestFor: route.scoreBand,
    benefit: "Uses discovered owner, weapon, runtime, OS, and verification route.",
    cost: "May need more evidence if score is below 85.",
    risk: route.blockedReasons.join("; ") || "partial capability support may remain.",
    expectedResult: "Bounded execution route.",
    verification: route.verificationMethod ?? "manual review"
  }))
} : null;

const criticalChoiceDecision = evaluateChoiceRequirement(choiceSurfacePolicy, {
  runtime,
  stage: "Critical",
  routeChangingDimensions: routeChangingDimensionSignals,
  materialBranch: subjectiveRouteChoice,
  highRiskOperation:
    entrySignals.destructiveOrProductionIntent === true &&
    entrySignals.queryPreambleSignal !== true,
  destructiveOrProductionOperation:
    entrySignals.destructiveOrProductionTermSignal === true &&
    (entrySignals.actionIntent === true || entrySignals.destructiveOrProductionIntent === true) &&
    entrySignals.queryPreambleSignal !== true,
});
const thinkingChoiceDimensions = [
  ...(subjectiveRouteChoice ? ["scope", "acceptance"] : []),
  ...(decisionCard ? ["scope", "owner", "runtime_or_os", "dependency", "acceptance"] : []),
];
const thinkingChoiceDecision = evaluateChoiceRequirement(choiceSurfacePolicy, {
  runtime,
  stage: "Thinking",
  routeChangingDimensions: thinkingChoiceDimensions,
  materialBranch: subjectiveRouteChoice || Boolean(decisionCard),
  decisionCardOptionCount: decisionCard?.options?.length ?? 0,
});
const entryChoiceDecision = {
  schemaVersion: "entry-choice-decision-v1",
  policySource: "config/governance/choice-surface-policy.json",
  lifecycleOwner: "meta-conductor/spine",
  choicePolicy:
    criticalChoiceDecision.required || thinkingChoiceDecision.required
      ? "must_ask"
      : "no_choice_needed",
  critical: criticalChoiceDecision,
  thinking: thinkingChoiceDecision,
};
const choicePolicy = entryChoiceDecision.choicePolicy;
const criticalChoiceBlocksExecution =
  criticalChoiceDecision.required && !hasChoiceStage("Critical");
const thinkingChoiceBlocksExecution =
  thinkingChoiceDecision.required && !hasChoiceStage("Thinking");
const routeScoreReady =
  Boolean(recommendedRoute?.score >= 85) ||
  Boolean(
    recommendedRoute?.score >= 70 &&
    decisionCard &&
    hasChoiceStage("Thinking"),
  );

const selectedWorkerLanes =
  recommendedRoute?.subjectiveUiCapabilityAmplification?.lanes ??
  recommendedRoute?.parallelExecutionLanes ??
  null;

const workerTaskPacketDrafts = selectedWorkerLanes
  ? selectedWorkerLanes.map((lane, index) => {
      const taskPacket = {
        taskPacketId: `worker-task:${lane.laneId}:${index + 1}`,
        ownerKind: lane.ownerKind ?? "agent",
        ownerAgent: lane.ownerAgent,
        roleDisplayName: lane.roleDisplayName,
        roleInstanceId: lane.laneId,
        weapon: recommendedRoute.weapon,
        dependency: lane.capabilityProvider?.id ?? recommendedRoute.dependency,
        runtime,
        os: osTarget,
        verificationOwner: recommendedRoute.verificationOwner,
        verification: recommendedRoute.verificationMethod,
        dependsOn: lane.dependsOn ?? [],
        parallelGroup: lane.parallelGroup ?? null,
        mergeOwner: "meta-conductor",
        shardScope: lane.safetyEvidence?.shardScope ?? [],
        mutationPolicy: lane.safetyEvidence?.mutationPolicy ?? "unproven",
        workspaceIsolation: lane.safetyEvidence?.workspaceIsolation ?? "unproven",
        externalWritePolicy: lane.safetyEvidence?.externalWritePolicy ?? "unproven",
        collisionPolicy: lane.safetyEvidence?.collisionPolicy ?? "unproven",
        safetyEvidence: lane.safetyEvidence ?? { status: "unproven" },
        purpose: lane.purpose,
        decisionImpact: lane.decisionImpact,
      };
      const codexSpawnBinding = codexSpawnBindingForOwner(
        lane.ownerAgent,
        lane.ownerKind ?? "agent",
        lane.laneId,
        taskPacket,
      );
      return {
        ...taskPacket,
        ownerSource: codexSpawnBinding?.ownerSource ?? null,
        codexSpawnBinding,
      };
    })
  : recommendedRoute
    ? (() => {
        const selectedOwner =
          recommendedRoute.selectedCapabilityProviders?.agent?.id ??
          recommendedRoute.owner;
        const roleInstanceId = `exec-${selectedOwner ?? "unknown"}-1`;
        const taskPacket = {
          taskPacketId: `worker-task:${roleInstanceId}:1`,
          ownerKind: "agent",
          ownerAgent: selectedOwner,
          roleDisplayName: roleDisplayNameForOwner(selectedOwner),
          roleInstanceId,
          weapon: recommendedRoute.weapon,
          dependency: recommendedRoute.dependency,
          runtime,
          os: osTarget,
          verificationOwner: recommendedRoute.verificationOwner,
          verification: recommendedRoute.verificationMethod,
          dependsOn: [],
          parallelGroup: null,
          mergeOwner: "meta-conductor",
          shardScope: [],
          mutationPolicy: "single_worker",
          workspaceIsolation: "single_worker",
          externalWritePolicy: "bounded_by_route",
          collisionPolicy: "single_worker_bounded_scope",
          purpose: `Execute route ${recommendedRoute.id} within its declared scope.`,
          decisionImpact: "Single-worker route selected by Thinking.",
        };
        const codexSpawnBinding = codexSpawnBindingForOwner(
          selectedOwner,
          "agent",
          roleInstanceId,
          taskPacket,
        );
        return [{
          ...taskPacket,
          ownerSource: codexSpawnBinding?.ownerSource ?? null,
          codexSpawnBinding,
        }];
      })()
    : [];

const parallelGroupIds = [...new Set(
  workerTaskPacketDrafts
    .map((packet) => packet.parallelGroup)
    .filter(Boolean),
)];
function scopesArePairwiseDisjoint(packets) {
  const ownedScopes = packets.flatMap((packet) =>
    (packet.shardScope ?? []).map((scope) => ({
      packetId: packet.taskPacketId,
      scope: String(scope).replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase(),
    })),
  );
  if (ownedScopes.length < packets.length) return false;
  for (let leftIndex = 0; leftIndex < ownedScopes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ownedScopes.length; rightIndex += 1) {
      const left = ownedScopes[leftIndex];
      const right = ownedScopes[rightIndex];
      if (left.packetId === right.packetId) continue;
      if (
        left.scope === right.scope ||
        left.scope.startsWith(`${right.scope}/`) ||
        right.scope.startsWith(`${left.scope}/`)
      ) {
        return false;
      }
    }
  }
  return true;
}
const safeFanoutReady =
  workerTaskPacketDrafts.length >= 2 &&
  new Set(workerTaskPacketDrafts.map((packet) => packet.taskPacketId)).size === workerTaskPacketDrafts.length &&
  new Set(workerTaskPacketDrafts.map((packet) => packet.roleInstanceId)).size === workerTaskPacketDrafts.length &&
  parallelGroupIds.length === 1 &&
  workerTaskPacketDrafts.every(
    (packet) =>
      packet.ownerAgent &&
      packet.mergeOwner === "meta-conductor" &&
      Array.isArray(packet.dependsOn) &&
      packet.dependsOn.length === 0 &&
      packet.safetyEvidence?.status === "proven" &&
      packet.externalWritePolicy === "forbidden" &&
      packet.collisionPolicy !== "unproven" &&
      packet.workspaceIsolation !== "unproven",
  ) &&
  scopesArePairwiseDisjoint(workerTaskPacketDrafts);
const unprovenMultiLaneExecution =
  Array.isArray(recommendedRoute?.parallelExecutionLanes) &&
  recommendedRoute.parallelExecutionLanes.length >= 2 &&
  !safeFanoutReady;
const nativeChoicePending = criticalChoiceBlocksExecution || thinkingChoiceBlocksExecution;
const fastPathNativeChoicePending =
  entryClassification.path === "fast_path" && nativeChoicePending;
const executionGateApplies = entryClassification.path !== "fast_path" || fastPathNativeChoicePending;
const routeCompatibilityBlocked =
  executionGateApplies &&
  recommendedRoute &&
  recommendedRoute.executionCapabilityGate?.routeCompatible !== true;
const routePreparationBlocked =
  !recommendedRoute ||
  !routeScoreReady ||
  globalInventoryFreshness.refreshRequiredBeforeExecution ||
  capabilityGapBlocksExecution ||
  unprovenMultiLaneExecution;
const handoffStatus = !executionGateApplies
  ? "not_applicable"
  : fastPathNativeChoicePending
    ? "awaiting_native_choice"
  : routeCompatibilityBlocked || routePreparationBlocked
    ? "blocked"
    : nativeChoicePending
      ? "awaiting_native_choice"
      : "ready_for_host_handoff";
const hostAction = handoffStatus === "ready_for_host_handoff"
  ? "host_action_required"
  : handoffStatus === "awaiting_native_choice"
    ? "invoke_native_choice_surface"
    : "none";
const routeExecutionGate = {
  applies: executionGateApplies,
  canPreviewRoute: true,
  routeCompatible: !routeCompatibilityBlocked,
  handoffStatus,
  hostAction,
  canHandoffToHost: ["ready_for_host_handoff", "awaiting_native_choice"].includes(handoffStatus),
  canEnterExecution: false,
  canEnterExecutionMeaning: "host_native_execution_has_not_occurred",
  executionAuthorized: false,
  authorizationOwner: "current_host_native_surfaces_and_permissions",
  persistentAcceptanceAuthorizesExecution: false,
  blockedBy: [
    ...(!recommendedRoute ? ["missing_recommended_route"] : []),
    ...(recommendedRoute && !routeScoreReady ? ["route_requires_confirmation_or_more_fetch"] : []),
    ...(globalInventoryFreshness.refreshRequiredBeforeExecution ? ["global_capability_inventory_refresh_required"] : []),
    ...(capabilityGapBlocksExecution ? ["capability_gap_decision_blocks_execution"] : []),
    ...(criticalChoiceBlocksExecution ? ["native_choice_surface_required_before_execution"] : []),
    ...(thinkingChoiceBlocksExecution ? ["thinking_route_choice_required_before_execution"] : []),
    ...(unprovenMultiLaneExecution ? ["parallel_lane_safety_not_proven"] : []),
    ...(routeCompatibilityBlocked ? ["runtime_capability_known_unsupported"] : []),
  ],
  returnToStage: !executionGateApplies
    ? null
    : !recommendedRoute
    ? "Thinking"
    : capabilityGapBlocksExecution
      ? "Thinking"
    : criticalChoiceBlocksExecution
      ? "Critical"
    : thinkingChoiceBlocksExecution
      ? "Thinking"
      : unprovenMultiLaneExecution
      ? "Thinking"
    : routeCompatibilityBlocked
      ? "Verification"
    : !routeScoreReady || globalInventoryFreshness.refreshRequiredBeforeExecution
      ? "Fetch"
      : null,
  refreshCommand: globalInventoryFreshness.refreshRequiredBeforeExecution ? globalInventoryFreshness.refreshCommand : null,
  reason: !executionGateApplies
    ? "Pure read-only fast-path query does not enter Execution and therefore does not require a runtime execution capability gate."
    : !recommendedRoute
    ? "No executable route is available; Execution must not start until owner, provider, runtime, OS, and verification binding are resolved."
    : !routeScoreReady
      ? "Route preview is available, but Execution needs confirmation or stronger provider evidence before starting."
      : capabilityGapBlocksExecution
        ? "Capability-gap decision requires approval, stronger evidence, or return to Thinking before Execution."
      : criticalChoiceBlocksExecution
        ? "The input has a route-changing ambiguity and requires a trusted native choice-surface answer before Execution."
      : thinkingChoiceBlocksExecution
        ? "The user intent is calibrated, but the fetched capability route still has multiple product/design execution paths; Thinking needs a trusted native route choice before Execution."
      : unprovenMultiLaneExecution
        ? "Multiple execution lanes were drafted, but shard scope, workspace isolation, or collision boundaries are still unproven; return to Thinking instead of presenting the route as execution-ready."
      : globalInventoryFreshness.refreshRequiredBeforeExecution
        ? "Cached provider evidence is missing or older than 14 days; route preview is allowed, but Execution must refresh capability discovery first."
      : routeCompatibilityBlocked
        ? `Route design is available, but current ${runtime} has a known unsupported runtime capability: ${recommendedRoute?.executionCapabilityGate?.blockers?.join("; ") ?? "required runtime capabilities"}.`
      : nativeChoicePending
        ? `Route compatibility is ready; the ${runtime} host must invoke its native choice surface before execution.`
        : "Route compatibility is ready; the current host must perform the selected native tool/Agent actions under its own permissions.",
  entryClassification,
  entryChoiceDecision,
  choicePolicy,
  typeFirstPolicyRef: "typeFirstRoutePolicy",
  typeFirstDisposition: routeTypeClassification.overallDisposition,
  nativeChoiceSurface: {
    required: criticalChoiceDecision.required,
    primarySurface: runtimeChoiceSurface.surface,
    policyRef: runtimeChoiceSurface.source,
    evidence: nativeChoiceEvidence,
    rule:
      "Branch-changing choices must be answered through the native host surface before Execution; artifact-only cards or chat text do not satisfy this gate.",
  },
  runtimeCapabilityEvidence: {
    profile: runtimeCapabilityState.overlayStatus.profile,
    state: runtimeCapabilityState.overlayStatus.state,
    applied: runtimeCapabilityState.overlayStatus.applied,
    rejected: runtimeCapabilityState.overlayStatus.rejected,
    issues: runtimeCapabilityState.issues,
  },
  thinkingChoiceSurface: {
    required: thinkingChoiceDecision.required,
    primarySurface: runtimeChoiceSurface.surface,
    policyRef: runtimeChoiceSurface.source,
    evidenceTrusted: hasChoiceStage("Thinking"),
    rule:
      "Subjective product/design work needs a second route choice after Fetch/Thinking when implementation paths have different scope, cost, and verification impact.",
  },
};

const output = {
  taskShape,
  intentAmplificationPrecheck: {
    needsIntentAmplification: taskShape === "fuzzy_complex_task" || taskShape === "strategy_product_decision",
    scoreThreshold: intentContract.scoreBands?.find((band) => band.status?.includes("may_claim"))?.min ?? 90,
    reason: "Route may change based on real intent, success criteria, and userGoalDone evidence.",
  },
  entryClassification,
  entryChoiceDecision,
  typeFirstRoutePolicy,
  routeTypeClassification,
  ownerDiscoveryPacket,
  autonomousCapabilityDiscovery,
  candidateOwners: [...new Set([...candidateWeapons.flatMap((weapon) => weapon.ownerCandidates ?? []), ...ownerDiscoveryPacket.candidateExistingExecutionOwners])],
  candidateWeapons: candidateWeapons.map((weapon) => weapon.id),
  candidateDependencies: candidateDependencies.map((dep) => dep.id),
  candidateDependencyProjects: candidateDependencies.map((dep) => dep.id),
  internalDecisionPatterns: candidateWeapons.some((weapon) => weapon.id === "meta-kim-decision-patterns")
    ? ["critical-real-intent-lock", "fetch-evidence-labeling", "thinking-subject-path-map", "thinking-minimum-test", "review-pass-kill-gate"]
    : [],
  candidateFoundationalCapabilities,
  runtimeFilterResult: { requested: runtimeArg, applied: runtime, unsupported: !RUNTIMES.includes(runtime) },
  osFilterResult: { requested: osArg, applied: osTarget, unsupported: !OS_TARGETS.includes(osTarget) },
  rankedRoutes,
  recommendedRoute,
  decisionExperiencePlan: recommendedRoute?.decisionExperiencePlan ?? null,
  subjectiveUiCapabilityAmplification: recommendedRoute?.subjectiveUiCapabilityAmplification ?? null,
  decisionCheckpoints: recommendedRoute?.subjectiveUiCapabilityAmplification?.decisionCheckpoints ?? [],
  capabilityGapDetected,
  capabilityGapDecision,
  routeExecutionGate,
  userChoiceNeeded,
  decisionCard,
  dispatchBoardDraft: recommendedRoute ? {
    owner: "meta-conductor",
    route: recommendedRoute.id,
    mergeOwner: "meta-conductor",
    dispatchMode: safeFanoutReady
      ? "fan_out_ready"
      : workerTaskPacketDrafts.length >= 2
        ? "fanout_eligible"
        : "single_worker_ready",
    fanoutReadiness: {
      entryConcurrencyHintPresent: concurrentDispatchIntentPresent,
      thinkingApproved: safeFanoutReady,
      workerCount: workerTaskPacketDrafts.length,
      independentLanes: safeFanoutReady,
      collisionBoundaryDeclared: workerTaskPacketDrafts.every(
        (packet) => packet.safetyEvidence?.status === "proven" && packet.collisionPolicy !== "unproven",
      ),
      shardScopesPairwiseDisjoint: scopesArePairwiseDisjoint(workerTaskPacketDrafts),
      externalWritesForbidden: workerTaskPacketDrafts.every(
        (packet) => packet.externalWritePolicy === "forbidden",
      ),
      hostInvocationBoundary: runtime === "codex"
        ? "probe current top-level spawn_agent surface before invocation"
        : "use the current runtime native agent surface",
    },
    parallelGroups: parallelGroupIds,
    orchestratorKinds: classifyOrchestratorKinds(
      recommendedRoute.subjectiveUiCapabilityAmplification?.lanes ?? recommendedRoute.parallelExecutionLanes ?? []
    ),
  } : null,
  workerTaskPacketDrafts,
  capabilityGapPacket,
  verificationPlan: {
    command: "npm run meta:route:validate",
    owner: "meta-prism",
    doneCondition: "recommendedRoute has owner, weapon, runtime, OS, verification owner, verification method, and score >= 85; otherwise capabilityGapPacket exists.",
  },
  rejectedRoutes: rankedRoutes.slice(1).map((route) => ({ id: route.id, score: route.score, reasons: route.blockedReasons.length ? route.blockedReasons : [`lower score than ${recommendedRoute?.id}`] })),
  routeScoreBreakdown: recommendedRoute?.routeScoreBreakdown ?? null,
  blockedReasons: recommendedRoute?.blockedReasons ?? capabilityGapPacket?.missing ?? [],
  requiredUserChoiceIfAny: userChoiceNeeded ? decisionCard : null,
};

function compactProvider(provider) {
  if (!provider || typeof provider !== "object") return provider;
  return Object.fromEntries(
    [
      ["id", provider.id],
      ["type", provider.type ?? provider.providerType],
      ["providerType", provider.providerType],
      ["source", provider.source],
      ["sourceRef", provider.sourceRef],
      ["sourceClass", provider.sourceClass],
      ["sourceRoot", provider.sourceRoot],
      ["sourceKey", provider.sourceKey],
      ["sourcePriority", provider.sourcePriority],
      ["contentDigest", provider.contentDigest],
      ["nativeIdentity", provider.nativeIdentity],
      ["provenance", provider.provenance],
      ["metadata", provider.metadata],
      ["collision", provider.collision],
      ["routeEligible", provider.routeEligible],
      ["sourceSelectedExplicitly", provider.sourceSelectedExplicitly],
      ["cacheEvidence", provider.cacheEvidence],
      ["cacheEvidenceOnly", provider.cacheEvidenceOnly],
      ["platformId", provider.platformId],
      ["runtime", provider.runtime],
      ["score", provider.score],
      ["matchedTerms", provider.matchedTerms],
      ["selected", provider.selected],
      ["reason", provider.reason],
      ["coverageStatus", provider.coverageStatus],
    ]
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, compactProviderMetadata(value)])
  );
}

function compactProviderCollection(value, limit = 20) {
  if (Array.isArray(value)) return value.slice(0, limit).map(compactProvider);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, provider]) => [key, compactProvider(provider)])
  );
}

function compactProviderMatch(providerMatch) {
  if (!providerMatch || typeof providerMatch !== "object") return providerMatch;
  return {
    selectionPolicy: providerMatch.selectionPolicy,
    candidateProviders: compactProviderCollection(providerMatch.candidateProviders ?? [], 12),
    selectedProvider: compactProvider(providerMatch.selectedProvider),
    whySelected: providerMatch.whySelected,
    whyNotSelected: (providerMatch.whyNotSelected ?? [])
      .slice(0, 12)
      .map((item) => ({
        id: item.id,
        reason: item.reason,
      })),
  };
}

function compactLane(lane) {
  if (!lane || typeof lane !== "object") return lane;
  return {
    ...lane,
    capabilityProvider: compactProvider(lane.capabilityProvider),
    capabilityBinding: lane.capabilityBinding
      ? {
          ...lane.capabilityBinding,
          selectedProviders: compactProviderCollection(
            lane.capabilityBinding.selectedProviders ?? {},
          ),
          candidatesByFamily: Object.fromEntries(
            Object.entries(lane.capabilityBinding.candidatesByFamily ?? {}).map(
              ([family, providers]) => [family, compactProviderCollection(providers, 12)],
            ),
          ),
        }
      : lane.capabilityBinding,
    providerMatch: compactProviderMatch(lane.providerMatch),
  };
}

function compactSubjectiveAmplification(amplification) {
  if (!amplification || typeof amplification !== "object") return amplification;
  return {
    ...amplification,
    lanes: (amplification.lanes ?? []).map(compactLane),
    capabilityTeamBlueprint: amplification.capabilityTeamBlueprint
      ? {
          ...amplification.capabilityTeamBlueprint,
          rows: (amplification.capabilityTeamBlueprint.rows ?? []).map((row) => ({
            ...row,
            selectedProvider: compactProvider(row.selectedProvider),
          })),
        }
      : amplification.capabilityTeamBlueprint,
  };
}

function compactRoute(route) {
  if (!route || typeof route !== "object") return route;
  return {
    ...route,
    selectedCapabilityProviders: compactProviderCollection(
      route.selectedCapabilityProviders ?? {},
    ),
    subjectiveUiCapabilityAmplification: compactSubjectiveAmplification(
      route.subjectiveUiCapabilityAmplification,
    ),
  };
}

function countPacketArray(packet, field) {
  return Array.isArray(packet?.[field]) ? packet[field].length : 0;
}

function compactOwnerDiscoveryPacket(packet) {
  if (!packet || typeof packet !== "object") return packet;
  return {
    discoveryPrinciple: packet.discoveryPrinciple,
    autonomousCapabilityDiscovery: packet.autonomousCapabilityDiscovery,
    searchOrder: packet.searchOrder,
    ownerBindingOrder: packet.ownerBindingOrder,
    governanceStages: packet.governanceStages,
    evidenceRefs: (packet.evidenceRefs ?? []).slice(0, 80),
    repoCanonicalAgents: compactProviderCollection(packet.repoCanonicalAgents ?? [], 20),
    projectRuntimeAgents: compactProviderCollection(packet.projectRuntimeAgents ?? [], 30),
    localGlobalAgents: compactProviderCollection(packet.localGlobalAgents ?? [], 30),
    repoCanonicalSkillProviders: compactProviderCollection(
      packet.repoCanonicalSkillProviders ?? [],
      30,
    ),
    projectRuntimeSkillProviders: compactProviderCollection(
      packet.projectRuntimeSkillProviders ?? [],
      30,
    ),
    localGlobalSkillProviders: compactProviderCollection(
      packet.localGlobalSkillProviders ?? [],
      40,
    ),
    repoCanonicalCapabilityProviders: compactProviderCollection(
      packet.repoCanonicalCapabilityProviders ?? [],
      40,
    ),
    projectRuntimeCapabilityProviders: compactProviderCollection(
      selectProjectRuntimeCapabilityEvidence(packet.projectRuntimeCapabilityProviders ?? [], 30),
      30,
    ),
    localGlobalCapabilityProviders: compactProviderCollection(
      packet.localGlobalCapabilityProviders ?? [],
      40,
    ),
    runtimeToolProviders: compactProviderCollection(packet.runtimeToolProviders ?? [], 20),
    capabilityProviderCoverage: packet.capabilityProviderCoverage,
    projectProjectionPolicy: packet.projectProjectionPolicy,
    globalInventoryFreshness: packet.globalInventoryFreshness,
    capabilityDiscoverySearchLog: (packet.capabilityDiscoverySearchLog ?? []).slice(0, 80),
    candidateExistingExecutionOwners: (
      packet.candidateExistingExecutionOwners ?? []
    ).slice(0, 80),
    governanceStageOwners: packet.governanceStageOwners ?? [],
    candidateReusableCapabilityProviders: compactProviderCollection(
      packet.candidateReusableCapabilityProviders ?? [],
      80,
    ),
    inventoryCounts: {
      repoCanonicalAgents: countPacketArray(packet, "repoCanonicalAgents"),
      projectRuntimeAgents: countPacketArray(packet, "projectRuntimeAgents"),
      localGlobalAgents: countPacketArray(packet, "localGlobalAgents"),
      repoCanonicalSkillProviders: countPacketArray(packet, "repoCanonicalSkillProviders"),
      projectRuntimeSkillProviders: countPacketArray(packet, "projectRuntimeSkillProviders"),
      localGlobalSkillProviders: countPacketArray(packet, "localGlobalSkillProviders"),
      candidateReusableCapabilityProviders: countPacketArray(
        packet,
        "candidateReusableCapabilityProviders",
      ),
    },
  };
}

function compactRouteOutput(raw) {
  return {
    ...raw,
    ownerDiscoveryPacket: compactOwnerDiscoveryPacket(raw.ownerDiscoveryPacket),
    candidateOwners: (raw.candidateOwners ?? []).slice(0, 80),
    candidateWeapons: (raw.candidateWeapons ?? []).slice(0, 80),
    candidateDependencies: (raw.candidateDependencies ?? []).slice(0, 80),
    candidateDependencyProjects: (raw.candidateDependencyProjects ?? []).slice(0, 80),
    candidateFoundationalCapabilities: compactProviderCollection(
      raw.candidateFoundationalCapabilities ?? [],
      80,
    ),
    rankedRoutes: (raw.rankedRoutes ?? []).slice(0, 8).map(compactRoute),
    recommendedRoute: compactRoute(raw.recommendedRoute),
    subjectiveUiCapabilityAmplification: compactSubjectiveAmplification(
      raw.subjectiveUiCapabilityAmplification,
    ),
    rejectedRoutes: (raw.rejectedRoutes ?? []).slice(0, 16),
  };
}

const outputForPublication =
  json ||
  process.argv.includes("--runner-compact") ||
  process.argv.includes("--compact-json")
    ? compactRouteOutput(output)
    : output;
const printableOutput = sanitizeCapabilityPublicationValue(outputForPublication, {
  repoRoot: repoPath("."),
  homeDir: process.env.USERPROFILE ?? process.env.HOME ?? "",
});

if (json) console.log(JSON.stringify(printableOutput));
else console.log(JSON.stringify(printableOutput, null, 2));
