#!/usr/bin/env node
import { assert } from "./governance-lib.mjs";
import { runRouteQuery } from "./run-route-query.mjs";

function route(task, runtime = "auto", os = "auto", extraArgs = []) {
  return runRouteQuery({ task, runtime, os, extraArgs });
}

const fuzzy = await route("fuzzy strategy task: choose a product monetization path and minimum test");
assert(fuzzy.candidateWeapons.includes("meta-kim-decision-patterns"), "Fuzzy strategy/product task must recall internal Meta_Kim decision patterns");
assert(fuzzy.ownerDiscoveryPacket?.governanceStages?.Critical?.requiredAgents?.includes("meta-warden"), "Route output must expose Critical governance owner discovery");
assert(Array.isArray(fuzzy.ownerDiscoveryPacket?.projectRuntimeAgents), "Route output must expose project runtime agent discovery");
assert(fuzzy.ownerDiscoveryPacket?.discoveryPrinciple === "canonical_index_first_capability_discovery_owner_last_binding", "Route output must use canonical/index-first discovery before provider matching");
assert(fuzzy.ownerDiscoveryPacket?.searchOrder?.[0] === "repo_canonical_capability_index", "Canonical capability index must be searched before provider matching");
assert(fuzzy.ownerDiscoveryPacket?.ownerBindingOrder?.includes("project_runtime_agent_inventory"), "Route owner binding must include project runtime agent inventory");
assert(Array.isArray(fuzzy.ownerDiscoveryPacket?.projectRuntimeSkillProviders), "Route output must expose project runtime skill provider discovery");
assert(Array.isArray(fuzzy.ownerDiscoveryPacket?.localGlobalSkillProviders), "Route output must expose local/global skill provider discovery");
assert(Array.isArray(fuzzy.ownerDiscoveryPacket?.projectRuntimeCapabilityProviders), "Route output must expose project runtime capability provider discovery");
assert(Array.isArray(fuzzy.ownerDiscoveryPacket?.localGlobalCapabilityProviders), "Route output must expose local/global capability provider discovery");
const projectProjectionPolicy = fuzzy.ownerDiscoveryPacket?.projectProjectionPolicy ?? {};
const projectRuntimeProvidersExpected = projectProjectionPolicy.projectRuntimeProvidersExpected !== false;
assert(typeof projectProjectionPolicy.projectProjectionMode === "string", "Route output must expose project projection mode");
assert(
  ["project_runtime_inventory", "local_global_runtime_inventory"].includes(projectProjectionPolicy.validationProviderLayer),
  "Route output must expose which provider layer validates runtime projections",
);
if (projectRuntimeProvidersExpected) {
  assert(
    fuzzy.ownerDiscoveryPacket.projectRuntimeCapabilityProviders.some((provider) => provider.id === "codex-hooks-json" && provider.sourceRef === ".codex/hooks.json"),
    "Route output must expose .codex/hooks.json as a real Codex hook config provider",
  );
  for (const [providerId, providerPath] of [
    ["claude-settings-json", ".claude/settings.json"],
    ["cursor-hooks-json", ".cursor/hooks.json"],
    ["openclaw-template-json", "openclaw/openclaw.template.json"],
  ]) {
    assert(
      fuzzy.ownerDiscoveryPacket.projectRuntimeCapabilityProviders.some((provider) => provider.id === providerId && provider.sourceRef === providerPath),
      `Route output must expose ${providerPath} as a real runtime config provider`,
    );
  }
  assert(fuzzy.ownerDiscoveryPacket?.capabilityProviderCoverage?.projectRuntimeLightScan?.hooks >= 1, "Route output must expose project hook provider coverage");
  assert(fuzzy.ownerDiscoveryPacket?.capabilityProviderCoverage?.projectRuntimeLightScan?.rules >= 1, "Route output must expose project rule/prompt provider coverage");
} else {
  assert(projectProjectionPolicy.projectProjectionMode === "global_only", "Project runtime providers may be absent only under global_only projection mode");
  assert(projectProjectionPolicy.validationProviderLayer === "local_global_runtime_inventory", "global_only validation must use local/global runtime inventory");
  assert(fuzzy.ownerDiscoveryPacket?.capabilityProviderCoverage?.localGlobalCached?.hooks >= 1, "global_only route validation must expose cached global hook provider coverage");
}
if (projectRuntimeProvidersExpected) {
  assert(
    fuzzy.ownerDiscoveryPacket.projectRuntimeAgents.some((agent) => agent.runtime === "openclaw" && agent.sourceRef?.startsWith("openclaw/workspaces/")),
    "Route output must expose OpenClaw workspace agents as project runtime agent providers",
  );
}
assert(
  fuzzy.ownerDiscoveryPacket.projectRuntimeCapabilityProviders.some((provider) => provider.id?.startsWith("package-script:") && provider.sourceRef?.startsWith("package.json#scripts.")),
  "Route output must expose package.json scripts as real command providers",
);
assert(fuzzy.ownerDiscoveryPacket?.capabilityProviderCoverage?.localGlobalCached?.plugins >= 1, "Route output must expose cached global plugin provider coverage");
assert(fuzzy.ownerDiscoveryPacket?.runtimeToolProviders?.some((provider) => provider.type === "runtimeTools"), "Route output must expose runtime tool providers");
assert(fuzzy.ownerDiscoveryPacket?.capabilityProviderCoverage?.projectRuntimeLightScan?.runtimeTools >= 1, "Route output must count runtime tool providers");
assert(fuzzy.ownerDiscoveryPacket?.globalInventoryFreshness?.mode === "cached_global_inventory_plus_project_light_scan", "Route output must expose cached+light-scan freshness policy");
assert(fuzzy.ownerDiscoveryPacket?.globalInventoryFreshness?.staleAfterMinutes === 20160, "Route output must use a 14-day global inventory stale threshold");
assert(fuzzy.ownerDiscoveryPacket?.globalInventoryFreshness?.staleAfterDays === 14, "Route output must expose the 2-week capability refresh cadence");
assert(typeof fuzzy.ownerDiscoveryPacket?.globalInventoryFreshness?.refreshRequiredBeforeExecution === "boolean", "Route output must expose whether refresh is required before execution");
assert(fuzzy.autonomousCapabilityDiscovery?.requiredByDefault === true, "Governed durable work must self-start capability discovery by default");
assert(
  fuzzy.autonomousCapabilityDiscovery?.sourcesChecked?.includes("project_runtime_inventory") &&
    fuzzy.autonomousCapabilityDiscovery?.sourcesChecked?.includes("claude_global_inventory_cache") &&
    fuzzy.autonomousCapabilityDiscovery?.sourcesChecked?.includes("codex_global_inventory_cache") &&
    fuzzy.autonomousCapabilityDiscovery?.sourcesChecked?.includes("cursor_global_inventory_cache") &&
    fuzzy.autonomousCapabilityDiscovery?.sourcesChecked?.includes("openclaw_global_inventory_cache") &&
    fuzzy.autonomousCapabilityDiscovery?.sourcesChecked?.includes("codex_global_skill_filesystem_light_scan") &&
    fuzzy.autonomousCapabilityDiscovery?.sourcesChecked?.includes("mcp_inventory") &&
    fuzzy.autonomousCapabilityDiscovery?.sourcesChecked?.includes("package_json_scripts"),
  "Autonomous capability discovery must cover project inventory, all runtime global caches, global skills, MCP, and commands",
);
assert(
  /~\/\.codex.*~\/\.claude.*~\/\.cursor.*~\/\.openclaw.*~\/\.agents/i.test(fuzzy.autonomousCapabilityDiscovery?.sourceRefPolicy ?? ""),
  "Reportable sourceRef policy must be cross-runtime and home-relative",
);
assert(fuzzy.typeFirstRoutePolicy?.policyKind === "route_selection_invariant", "Route output must expose type-first route policy");
assert(fuzzy.typeFirstRoutePolicy?.mustNotBecomeChecklist === true, "Type-first route policy must not become another checklist");
assert(
  fuzzy.typeFirstRoutePolicy?.axes?.objectType?.unclearAction === "return_null_or_capabilityGapPacket_or_reference_only",
  "Unknown object types must return null, capability gap, or reference-only instead of guessing",
);
assert(
  fuzzy.typeFirstRoutePolicy?.axes?.evidenceType?.forbiddenFallback === "validator_pass_as_runtime_truth",
  "Evidence typing must forbid promoting validator pass into runtime truth",
);
assert(
  fuzzy.typeFirstRoutePolicy?.axes?.ownershipType?.unclearAction === "preserve_or_block_until_owner_is_known",
  "Unknown ownership must preserve or block instead of overwriting state",
);
assert(
  fuzzy.routeExecutionGate?.typeFirstPolicyRef === "typeFirstRoutePolicy",
  "Execution gate must point to the route type policy instead of adding a separate gate",
);
assert(
  fuzzy.routeTypeClassification?.policyRef === "typeFirstRoutePolicy",
  "Route output must classify current route types from the executable policy",
);
assert(
  fuzzy.routeTypeClassification?.evidenceType?.claimLimit === "route_preview_not_runtime_truth",
  "Route type classification must limit structural evidence claims",
);
assert(
  fuzzy.routeTypeClassification?.objectType?.forbiddenFallbackAvoided === true,
  "Route type classification must record that object fallback guessing was avoided",
);
assert(fuzzy.routeExecutionGate?.canPreviewRoute === true, "Stale cache may still allow route preview");
assert(typeof fuzzy.routeExecutionGate?.canEnterExecution === "boolean", "Route output must expose whether Execution may start");
assert(fuzzy.ownerDiscoveryPacket?.candidateReusableCapabilityProviders?.length > 0, "Route output must expose reusable capability providers before agent creation");
assert(fuzzy.ownerDiscoveryPacket?.searchOrder?.includes("available_capability_providers_skills_tools_mcp"), "Route owner discovery must include skill/tool/MCP provider inventory after agent/index discovery");
assert(Array.isArray(fuzzy.ownerDiscoveryPacket?.capabilityDiscoverySearchLog), "Route output must expose Fetch capabilityDiscovery.searchLog evidence");
const routeSearchRefs = fuzzy.ownerDiscoveryPacket.capabilityDiscoverySearchLog
  .map((entry) => `${entry.source}:${entry.sourceRef}`)
  .join("\n");
const projectRuntimeSearchRefs = [
  ".codex/agents",
  ".agents/skills",
  ".codex/commands",
  ".codex/hooks",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".mcp.json",
  "package.json scripts",
  ".claude/agents",
  ".claude/skills",
  ".claude/commands",
  ".claude/hooks",
  ".claude/settings.json",
  ".cursor/agents",
  ".cursor/skills",
  ".cursor/rules",
  ".cursor/prompts",
  ".cursor/hooks",
  ".cursor/hooks.json",
  ".cursor/mcp.json",
  "openclaw/workspaces",
  "openclaw/skills",
  "openclaw/hooks",
  "openclaw/openclaw.template.json",
];
const globalRuntimeSearchRefs = [
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
  "~/.codex/agents",
  "~/.codex/skills",
  "~/.codex/commands",
  "~/.codex/hooks",
  "~/.codex/hooks.json",
  "~/.codex/config.toml",
  "~/.agents/skills",
];
for (const requiredRef of [
  ...(projectRuntimeProvidersExpected ? projectRuntimeSearchRefs : [".meta-kim/local.overrides.json"]),
  ...globalRuntimeSearchRefs,
]) {
  assert(routeSearchRefs.includes(requiredRef), `Route Fetch searchLog must include ${requiredRef}`);
}
if (fuzzy.candidateDependencyProjects.includes("kim-decision")) {
  assert(!fuzzy.rankedRoutes.some((item) => item.dependencyProject === "kim-decision" && item.scoreBand === "execute"), "Kim_Decision may be discovered but must not become an execution dependency");
}
assert(!fuzzy.rankedRoutes.some((item) => item.owner === "general-purpose"), "No general-purpose owner allowed");
assert(fuzzy.recommendedRoute?.weapon, "Recommended route needs weapon");
assert(fuzzy.recommendedRoute?.verificationOwner, "Recommended route needs verification owner");
assert(fuzzy.recommendedRoute?.runtime, "Recommended route needs runtime");
assert(fuzzy.recommendedRoute?.os, "Recommended route needs OS");
assert(fuzzy.recommendedRoute?.verificationMethod, "Recommended route needs verification method");

const subjectiveQuality = await route("这个页面不好看，帮我弄高级一点", "codex", "windows");
assert(
  subjectiveQuality.recommendedRoute?.id === "subjective-ui-design-orchestration:codex:windows",
  "No-keyword subjective UI request must route to subjective UI orchestration",
);
assert(subjectiveQuality.autonomousCapabilityDiscovery?.userReminderDetected === false, "Subjective UI discovery must not depend on explicit stage words");
assert(subjectiveQuality.recommendedRoute?.blockedReasons?.length === 0, "Subjective UI route should naturally bind providers before the choice gate");
assert(
  subjectiveQuality.workerTaskPacketDrafts?.some((packet) => packet.roleDisplayName === "frontend") &&
    subjectiveQuality.workerTaskPacketDrafts?.some((packet) => packet.roleDisplayName === "test") &&
    subjectiveQuality.workerTaskPacketDrafts?.some((packet) => packet.roleDisplayName === "review"),
  "Subjective UI route must amplify into frontend, test, and review lanes",
);
assert(
  !JSON.stringify(subjectiveQuality.recommendedRoute?.selectedCapabilityProviders ?? {}).includes("C:/Users/"),
  "Route provider refs must not leak local absolute home paths",
);

const code = await route("complex code refactor with tests");
assert(!code.rankedRoutes.some((item) => item.dependencyProject === "kim-decision"), "Kim_Decision must not become implementation owner for pure code execution");

const contentGrowthDecision = await route("内容营销中，标题文案和封面设计怎样提升转化，帮我判断怎么改", "codex", "windows");
assert(contentGrowthDecision.taskShape === "strategy_product_decision", "Business content work must not be misclassified as runtime platform governance");
assert(contentGrowthDecision.recommendedRoute?.id === "kim-decision-lens:codex:windows", "Decision tasks should expose the Kim_Decision decision lens");
assert(contentGrowthDecision.recommendedRoute?.dependency === null, "Kim_Decision lens must not be recorded as an execution dependency");
assert(contentGrowthDecision.recommendedRoute?.decisionLensProvider === "kim-decision", "Kim_Decision lens provider should be visible separately from execution dependencies");
assert(contentGrowthDecision.recommendedRoute?.boundary?.notExecutor === true, "Kim_Decision lens must not become an implementation executor");
assert(
  JSON.stringify(contentGrowthDecision.decisionExperiencePlan?.sequence ?? []).includes("critical_decision") &&
    JSON.stringify(contentGrowthDecision.decisionExperiencePlan?.sequence ?? []).includes("fetch_evidence_decision") &&
    JSON.stringify(contentGrowthDecision.decisionExperiencePlan?.sequence ?? []).includes("thinking_path_decision"),
  "Decision UX must keep Kim_Decision in Critical/Fetch/Thinking",
);
assert(!JSON.stringify(contentGrowthDecision.decisionExperiencePlan?.sequence ?? []).includes("goalpro"), "Decision route must not trigger GoalPro early");
assert(/not the place that creates user Goals/i.test(contentGrowthDecision.decisionExperiencePlan?.evolutionBoundary ?? ""), "Evolution must not be bound to user Goal creation");

const contentAutomationBuild = await route("帮我做一个内容营销自动发布器，需要内容策略、前端界面、后端 API、数据模型、平台集成、权限风控、测试验收和发布运维", "codex", "windows");
assert(contentAutomationBuild.recommendedRoute?.id === "product-build-orchestration:codex:windows", "An explicit product build must retain the product-build orchestration route even when it includes strategy language");

const codexAgentSearch = await route("Create a provider smoke test that discovers an execution agent and finds a skill provider", "codex", "windows");
assert(
  codexAgentSearch.recommendedRoute?.selectedCapabilityProviders?.agent?.platformId !== "claudeCode",
  "Codex execution owner selection must not bind Claude Code global agents",
);

const hook = await route("platform hook install for Codex and Cursor");
assert(hook.candidateWeapons.includes("runtime-capability-matrix") || hook.candidateOwners.includes("meta-sentinel"), "Platform hook task must recall runtime matrix or sentinel");

const windows = await route("Windows setup task for hooks and MCP", "codex", "windows");
assert(windows.osFilterResult.applied === "windows", "Windows setup must apply windows OS filter");

const cursorUnknown = await route("Cursor unknown native choice surface task", "cursor", "windows");
assert(cursorUnknown.recommendedRoute || cursorUnknown.capabilityGapPacket, "Cursor unknown capability must route or gap honestly");

const missing = await route("missing dependency task requiring imaginary provider xzzq");
assert(missing.recommendedRoute || missing.capabilityGapPacket, "Missing dependency task must produce route or capabilityGapPacket");
assert(missing.capabilityGapDetected === true, "Explicit missing dependency must trigger capability-gap detection");
assert(missing.capabilityGapDecision?.decision === "blocked_or_needs_approval", "Imaginary provider must block or require approval instead of being swallowed by a generic route");
assert(missing.capabilityGapDecision?.decisionEvidence?.status === "pass", "Capability-gap route decision must carry passing DecisionEvidenceContract");
assert(missing.capabilityGapDecision?.decisionEvidence?.missingEvidence?.length === 0, "Capability-gap route decision must not miss required evidence");
assert(missing.routeExecutionGate?.canEnterExecution === false, "Blocked capability-gap decision must close the Execution gate");
assert(missing.routeExecutionGate?.blockedBy?.includes("capability_gap_decision_blocks_execution"), "Execution gate must name the capability-gap blocker");
assert(
  ["classified_route_can_be_scored", "blocked_with_reason", "capabilityGapPacket"].includes(missing.routeExecutionGate?.typeFirstDisposition),
  "Explicit capability gap route must classify or degrade instead of guessing",
);
assert(
  missing.routeTypeClassification?.gapDecisionRef === "capabilityGapDecision",
  "Explicit capability gap route must connect type classification to capabilityGapDecision",
);

const claudeAgentSearch = await route("在 Claude Code 里运行 agent 搜索不对 critical and fetch thinking and review", "claude_code", "windows");
assert(
  claudeAgentSearch.recommendedRoute?.id === "execution-capability-discovery:claude_code:windows",
  "Claude Code agent-search complaints must route to execution capability discovery, not dependency-project registry",
);
assert(
  claudeAgentSearch.recommendedRoute?.selectedCapabilityProviders?.agent?.runtime !== "codex",
  "Claude Code execution owner selection must not bind Codex project agent adapters",
);
assert(
  !String(claudeAgentSearch.recommendedRoute?.selectedCapabilityProviders?.agent?.sourceRef ?? "").startsWith(".codex/agents/"),
  "Claude Code agent search must not select .codex/agents adapters as callable Claude agents",
);

const codexAgentReuseComplaint = await route("Critical Thinking Fetch Deep Thinking Review 为什么 Codex 一直创建 agent 而不是找全局 agent", "codex", "windows");
assert(
  codexAgentReuseComplaint.recommendedRoute?.id === "execution-capability-discovery:codex:windows",
  "Codex agent-creation complaints must route to execution capability discovery before dependency/project registry",
);
assert(
  codexAgentReuseComplaint.recommendedRoute?.selectedCapabilityProviders?.agent?.platformId === "codex",
  "Codex agent-creation complaints must bind a Codex-callable global/project agent provider",
);
assert(
  codexAgentReuseComplaint.recommendedRoute?.codexSpawnBinding?.hostSurface === "spawn_agent" &&
    codexAgentReuseComplaint.recommendedRoute?.codexSpawnBinding?.ownerAgent === codexAgentReuseComplaint.recommendedRoute?.owner &&
    codexAgentReuseComplaint.recommendedRoute?.codexSpawnBinding?.ownerBindingMode === "run_scoped_owner_contract" &&
    codexAgentReuseComplaint.recommendedRoute?.codexSpawnBinding?.nativeAgentType === null &&
    codexAgentReuseComplaint.recommendedRoute?.codexSpawnBinding?.fork_turns === "none" &&
    !Object.hasOwn(codexAgentReuseComplaint.recommendedRoute?.codexSpawnBinding ?? {}, "agent_type") &&
    !Object.hasOwn(codexAgentReuseComplaint.recommendedRoute?.codexSpawnBinding ?? {}, "fork_context"),
  "Codex global agent reuse must use a run-scoped owner contract when the active host schema does not expose agent_type",
);
assert(
  /^[a-z0-9_]+$/.test(codexAgentReuseComplaint.workerTaskPacketDrafts?.[0]?.codexSpawnBinding?.task_name ?? "") &&
    codexAgentReuseComplaint.workerTaskPacketDrafts?.[0]?.codexSpawnBinding?.ownerAgent === codexAgentReuseComplaint.recommendedRoute?.owner,
  "Worker task packets must carry a valid native Codex task name and the selected owner metadata",
);
assert(
  codexAgentReuseComplaint.workerTaskPacketDrafts?.[0]?.codexSpawnBinding?.visibleBindingRequired === true &&
    codexAgentReuseComplaint.workerTaskPacketDrafts?.[0]?.codexSpawnBinding?.runtimeInstanceAlias === null,
  "Codex worker packets must require visible owner binding and reserve runtimeInstanceAlias for host nicknames",
);
const codexAgentTypeSchema = JSON.stringify({
  hostSurface: "spawn_agent",
  inputProperties: ["task_name", "message", "agent_type"],
  evidenceSource: "active_host_tool_schema",
});
const codexNativeAgentReuse = await route(
  "Critical Thinking Fetch Deep Thinking Review 为什么 Codex 一直创建 agent 而不是找全局 agent",
  "codex",
  "windows",
  ["--codex-host-tool-schema", codexAgentTypeSchema],
);
assert(
  codexNativeAgentReuse.recommendedRoute?.codexSpawnBinding?.ownerBindingMode === "run_scoped_owner_contract" &&
    codexNativeAgentReuse.recommendedRoute?.codexSpawnBinding?.nativeAgentType === null &&
    !Object.hasOwn(codexNativeAgentReuse.recommendedRoute?.codexSpawnBinding ?? {}, "agent_type") &&
    codexNativeAgentReuse.recommendedRoute?.codexSpawnBinding?.hostToolSchemaEvidence?.suppliedArtifactRejected === true,
  "Offline Codex routing must reject caller-supplied host schemas and leave native owner binding to the active host",
);
assert(
  codexAgentReuseComplaint.workerTaskPacketDrafts?.[0]?.ownerAgent === codexAgentReuseComplaint.recommendedRoute?.owner &&
    codexAgentReuseComplaint.workerTaskPacketDrafts?.[0]?.roleDisplayName &&
    !String(codexAgentReuseComplaint.workerTaskPacketDrafts?.[0]?.roleDisplayName).startsWith("agent-"),
  "Codex reuse complaints must produce owner-first worker packets, not runtime-created agent identities",
);
assert(
  codexAgentReuseComplaint.capabilityGapDetected === false,
  "Agent reuse complaints must not be misread as create-agent capability-gap requests",
);

const createAgentGap = await route("create agent for long-term test coverage strategy owner");
assert(createAgentGap.capabilityGapDetected === true, "Explicit create agent request must trigger capability-gap detection");
assert(createAgentGap.capabilityGapDecision?.decision === "create_agent", "Long-term coverage owner gap must route to create_agent");
assert(createAgentGap.capabilityGapDecision?.generatedAgentSpec?.identityCleanliness?.status === "pass", "create_agent route gap must produce a clean GeneratedAgentSpec");

console.log("capability routing valid");
