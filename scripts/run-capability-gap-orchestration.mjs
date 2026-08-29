#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  GAP_DECISIONS,
  decideCapabilityGap,
} from "./capability-gap-mvp.mjs";
import { buildAgentProjectionTargets } from "./runtime-tool-profiles.mjs";
import { getProfilePaths } from "./meta-kim-local-state.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..");
const DEFAULT_OUTPUT_PATH = path.join(
  getProfilePaths({ repoPath: REPO_ROOT }).profileDir,
  "capability-gap-orchestration.json",
);

const ROLE_BY_DECISION = {
  create_skill: "skill",
  create_agent: "agent",
  create_script: "script",
  create_mcp_provider: "provider",
  worker_task_only: "worker",
  blocked_or_needs_approval: "safety",
};

const OWNER_BY_DECISION = {
  create_skill: "meta-artisan",
  create_agent: "meta-genesis",
  create_script: "script-provider",
  create_mcp_provider: "mcp-provider-capability",
  worker_task_only: "existing_execution_owner",
  blocked_or_needs_approval: "meta-sentinel",
};

const FACTORY_DECISIONS = new Set([
  "create_skill",
  "create_agent",
  "create_script",
  "create_mcp_provider",
]);

const EXECUTION_WORKER_MODES = new Set([
  "primary_execution",
  "factory_then_dispatch",
  "verification_execution",
]);

const APPROVAL_GATE_MODES = new Set(["approval_gate"]);

const EXECUTION_MODE_ENUM = new Set([
  ...EXECUTION_WORKER_MODES,
  ...APPROVAL_GATE_MODES,
  "readonly_fetch_sidecar",
  "readonly_review_sidecar",
]);

const MULTI_TYPE_CAPABILITY_INVENTORY = [
  {
    capabilityType: "agent",
    source: "canonical agents and runtime agent mirrors",
    routeImpact: "owner selection and governance boundary",
  },
  {
    capabilityType: "skill",
    source: "canonical skills and installed/runtime skill mirrors",
    routeImpact: "reusable workflow selection",
  },
  {
    capabilityType: "script",
    source: "scripts/ and package automation",
    routeImpact: "repeatable local implementation or validation path",
  },
  {
    capabilityType: "command",
    source: "package.json scripts and local CLI commands",
    routeImpact: "callable execution weapon",
  },
  {
    capabilityType: "mcp_provider_tool",
    source: "MCP configs, provider registry, and tool inventory",
    routeImpact: "external or structured tool provider path",
  },
  {
    capabilityType: "runtime_tool",
    source: "runtime-native tools and host adapters",
    routeImpact: "host-specific execution surface",
  },
  {
    capabilityType: "plugin_connector",
    source: "plugin and connector inventory",
    routeImpact: "optional integration surface",
  },
  {
    capabilityType: "retrieval_capability",
    source: "web, url, docs, browser, MCP, plugin, local, and user-source retrieval",
    routeImpact: "source-backed Fetch and deep research readiness",
  },
  {
    capabilityType: "dependency_external_package",
    source: "dependency registry and external package references",
    routeImpact: "third-party capability reuse or risk boundary",
  },
  {
    capabilityType: "worker_task",
    source: "run-scoped workerTaskPacket path",
    routeImpact: "one-run execution without durable capability creation",
  },
];

const AGENT_PROJECTION_TARGETS = buildAgentProjectionTargets();

const RETRIEVAL_CAPABILITIES = [
  {
    name: "web_search",
    status: "requires_runtime_inventory",
    role: "current public facts and ecosystem discovery",
  },
  {
    name: "url_fetch",
    status: "requires_runtime_inventory",
    role: "direct source retrieval when a URL is known",
  },
  {
    name: "docs_lookup",
    status: "requires_runtime_inventory",
    role: "official documentation and API surface verification",
  },
  {
    name: "browser_open",
    status: "requires_runtime_inventory",
    role: "interactive or rendered page inspection",
  },
  {
    name: "mcp_search",
    status: "requires_runtime_inventory",
    role: "MCP-backed search or provider discovery",
  },
  {
    name: "plugin_search",
    status: "requires_runtime_inventory",
    role: "runtime plugin or connector discovery",
  },
  {
    name: "local_only",
    status: "available",
    role: "repo, canonical, contract, package, and test evidence",
  },
  {
    name: "user_supplied_sources",
    status: "available_if_provided",
    role: "pasted text, attachments, or explicit source files",
  },
];

const PROJECT_AGENT_SOUL_POLICY = {
  identityKind: "project_scoped_agent_profile",
  savedIn: "projectAgentBlueprintPacket",
  durableAgentFile: null,
  durableAgentCreated: false,
  qualityBarRefs: [
    "canonical/skills/meta-theory/SKILL.md#Execution-agent identity",
    "config/capability-index/meta-kim-capabilities.json#governanceRules",
  ],
  durableAgentEscalation:
    "Project-scoped agent profiles are synthesized during Thinking; only Evolution plus GapDecision=create_agent may promote them into project-retained agent files after Type B GeneratedAgentSpec review.",
  identityCleanlinessRules: [
    "Keep concrete task text, file scopes, deliverable links, and verify steps out of durable agent identity.",
    "Use reusable project responsibility class, boundaries, inputs, outputs, refusals, loadout slots, and verification policy for project agents.",
    "Pin concrete skills, MCP tools, commands, and runtime tools into capabilityLoadout for the current run; update capabilities centrally for future runs.",
  ],
};

function buildCapabilityLoadout({
  repoSkills = ["meta-theory"],
  runtimeSkillCandidates = [],
  repoMcpTools = ["meta-kim-runtime:get_meta_runtime_capabilities"],
  runtimeMcpCandidates = [],
  commands = ["meta:gap:orchestrate"],
  runtimeTools = ["filesystem", "shell"],
} = {}) {
  return {
    repoSkills: [...repoSkills],
    runtimeSkillCandidates: [...runtimeSkillCandidates],
    repoMcpTools: [...repoMcpTools],
    runtimeMcpCandidates: [...runtimeMcpCandidates],
    commands: [...commands],
    runtimeTools: [...runtimeTools],
    bindingPolicy:
      "Resolved at Thinking and pinned for this run; future capability updates change the capability profile, not in-flight worker behavior.",
    sourceRefs: [
      "config/capability-index/meta-kim-capabilities.json",
      "config/skills.json",
      "package.json scripts",
      "runtime inventory",
    ],
  };
}

function buildRoleSoulPolicy(lane) {
  return {
    ...PROJECT_AGENT_SOUL_POLICY,
    projectKey: lane.projectProfile?.projectKey ?? "unknown-project",
    projectLabel: lane.projectProfile?.projectLabel ?? "unknown project",
    projectAgentId: lane.projectAgentId,
    capabilityProfileId: lane.capabilityLoadout?.capabilityProfileId ?? null,
    roleFamily: lane.roleDisplayName,
    roleLabel: lane.publicLabel,
    responsibilityClass: lane.taskFocus,
    refusalPolicy: [
      "Do not claim a synthesized profile is a committed agent file until Evolution promotes it.",
      "Do not create a task-specific agent file for one run; evolve reusable project agents only.",
      "Do not perform external writes or credential use without explicit approval.",
    ],
  };
}

function cloneCapabilityLoadout(loadout) {
  if (!loadout) return null;
  return {
    ...loadout,
    repoSkills: [...loadout.repoSkills],
    runtimeSkillCandidates: [...loadout.runtimeSkillCandidates],
    repoMcpTools: [...loadout.repoMcpTools],
    runtimeMcpCandidates: [...loadout.runtimeMcpCandidates],
    commands: [...loadout.commands],
    runtimeTools: [...loadout.runtimeTools],
    sourceRefs: [...loadout.sourceRefs],
  };
}

const CURRENT_EXTERNAL_FACT_LANE_IDS = new Set([
  "market-research",
  "platform-integration",
  "security-approval",
  "release-ops",
]);

const RETRIEVAL_TOOL_NAMES = new Set([
  "web_search",
  "url_fetch",
  "docs_lookup",
  "browser_open",
  "mcp_search",
  "plugin_search",
]);

function hasRetrievalCapability(loadout) {
  const tools = loadout?.runtimeTools ?? [];
  const mcpCandidates = loadout?.runtimeMcpCandidates ?? [];
  return tools.some((tool) => RETRIEVAL_TOOL_NAMES.has(tool)) || mcpCandidates.length > 0;
}

function buildExternalEvidencePolicy(packet, researchCapabilityDiscovery) {
  const loadout = packet.capabilityLoadout ?? {};
  const laneRequiresCurrentExternalFacts =
    CURRENT_EXTERNAL_FACT_LANE_IDS.has(packet.businessFlowLaneId) ||
    packet.externalWriteBoundary === true ||
    (packet.toolRequirements ?? []).some((requirement) =>
      [
        "deep_research",
        "official_source_review",
        "provider_probe",
        "external_capability_research",
        "credential_boundary_review",
        "security_review",
        "approval_contract",
      ].includes(requirement)
    );
  const required = laneRequiresCurrentExternalFacts;
  const availableInRun = (researchCapabilityDiscovery?.retrievalCapabilities ?? []).map(
    (capability) => capability.name
  );

  return {
    required,
    requiredReason: required
      ? "Current platform, provider, compliance, dependency, or third-party capability claims can change outside the repo."
      : "This lane can start from local project evidence unless Fetch discovers external claims that affect the route.",
    stageGate: "Fetch before Thinking route lock",
    preferredRetrieval: [
      "web_search",
      "url_fetch",
      "docs_lookup",
      "browser_open",
      "mcp_search",
      "plugin_search",
    ],
    availableInRun,
    loadoutHasRetrieval: hasRetrievalCapability(loadout),
    blockedIfMissing: laneRequiresCurrentExternalFacts,
    outputContract: [
      "sourceUrls",
      "retrievedAt",
      "claim",
      "decisionImpact",
      "contradictions",
    ],
    noCurrentFactWithoutSource: true,
  };
}

function buildLocalBaselineComparison(packet) {
  return {
    required: true,
    stageGate: "Fetch before Thinking owner/loadout decision",
    localSources: [
      "canonical/agents/",
      "canonical/skills/",
      "config/contracts/",
      "config/capability-index/",
      "config/runtime-capability-matrix.json",
      "config/os-compatibility-matrix.json",
      "config/capability-index/dependency-project-registry.json",
      "package.json scripts",
      ".mcp.json and runtime MCP mirrors",
      "runtime mirrors and local global inventory",
      "project memory and prior run evidence",
    ],
    comparisonTargets: [
      "existing project agents",
      "available skills, prompts, rules, and hooks",
      "available MCP tools and providers",
      "package commands and local scripts",
      "runtime and OS support",
      "project memory and prior scars",
    ],
    outputContract: [
      "matchedLocalCapability",
      "gap",
      "reuseUpgradeCreateDecision",
      "localContradictions",
    ],
    noProviderClaimWithoutLocalCheck: true,
    laneId: packet.businessFlowLaneId ?? null,
  };
}

function buildKnowledgeGraphPolicy(packet) {
  return {
    equipped: true,
    mode: "graph_navigation_and_worker_slice",
    runStartPolicy: {
      existenceCheckOnly: true,
      noStartupFreshnessGate: true,
      noStartupRebuild: true,
      useIfPresent: ["graphify-out/GRAPH_REPORT.md", "graphify-out/graph.json", "graphify-out/wiki/index.md"],
    },
    contextInjectionPolicy: {
      allowed: ["worker_relevant_graph_slice", "short_graph_hint", "file_anchor", "concept_anchor"],
      forbidden: ["full_graph_json", "full_graph_report", "broad_graph_dump_to_every_worker"],
      tokenBudgetPolicy: "inject_minimal_slice_only",
    },
    truthPolicy: {
      graphRole: "navigation_index",
      finalTruthSource: "target_source_files",
      routeChangingClaimsRequireSourceRead: true,
    },
    fallbackPolicy: {
      ifMissingOrSparse: "repo_search_and_targeted_source_read",
      ifGraphContradictsSource: "source_file_wins",
    },
    afterMutationPolicy: {
      rebuildCommand: "npm run meta:graphify:rebuild",
      requiredWhen: ["code", "canonical", "contract", "runtime_facing_docs"],
      checkCommand: "npm run meta:graphify:check",
      checkGate: "verification_release_or_explicit_graph_validation",
    },
    laneId: packet.businessFlowLaneId ?? null,
  };
}

const CAPABILITY_SLOT_CATALOG = [
  {
    laneId: "product-definition",
    publicLabel: "产品定义",
    roleDisplayName: "product",
    inputPrefix: "产品定义",
    taskFocus: "锁定目标用户、核心场景、MVP 范围、成功标准、非目标和授权边界。",
    dependsOn: [],
    toolRequirements: ["intent_record", "acceptance_record", "product_scope_contract"],
    capabilityLoadout: buildCapabilityLoadout({
      runtimeSkillCandidates: ["strategic-compact"],
      commands: ["meta:gap:orchestrate", "meta:theory:run"],
      runtimeTools: ["filesystem", "shell", "memory"],
    }),
    includeWhen: (intent) => intent.wishStyleProductBuild,
  },
  {
    laneId: "market-research",
    publicLabel: "市场与平台规则研究",
    roleDisplayName: "research",
    inputPrefix: "市场与平台规则研究",
    taskFocus: "核对当前平台规则、竞品做法、可用 API 或自动化边界，避免凭印象设计外部能力。",
    dependsOn: ["product-definition"],
    toolRequirements: ["deep_research", "official_source_review", "provider_probe"],
    capabilityLoadout: buildCapabilityLoadout({
      runtimeSkillCandidates: ["market-research", "deep-research", "exa-search"],
      runtimeMcpCandidates: ["exa", "context7", "playwright"],
      commands: ["meta:research:prepare", "meta:research:execute"],
      runtimeTools: ["web_search", "url_fetch", "browser_open", "filesystem"],
    }),
    includeWhen: (intent) => intent.requiresExternalResearch || intent.isMarketingWorkflow,
  },
  {
    laneId: "content-strategy",
    publicLabel: "内容策略与生成",
    roleDisplayName: "content",
    inputPrefix: "内容策略与生成",
    taskFocus: "设计内容结构、素材、文案、标签、风格、审核和复用策略，让业务目标不只停留在发任务。",
    dependsOn: ["product-definition", "market-research"],
    toolRequirements: ["content_workflow", "brand_voice_rubric", "quality_review"],
    capabilityLoadout: buildCapabilityLoadout({
      runtimeSkillCandidates: ["content-engine", "article-writing", "market-research"],
      runtimeMcpCandidates: ["memory"],
      commands: ["meta:gap:orchestrate"],
      runtimeTools: ["filesystem", "shell", "memory"],
    }),
    includeWhen: (intent) => intent.requiresContentGeneration,
  },
  {
    laneId: "ux-flow",
    publicLabel: "用户流程",
    roleDisplayName: "ux",
    inputPrefix: "用户流程",
    taskFocus: "设计从输入、处理、编辑、审批、执行到结果回看的端到端流程。",
    dependsOn: ["product-definition", "content-strategy"],
    toolRequirements: ["flow_map", "interaction_spec"],
    capabilityLoadout: buildCapabilityLoadout({
      runtimeSkillCandidates: ["product-design:get-context", "frontend-patterns"],
      commands: ["meta:gap:orchestrate"],
      runtimeTools: ["filesystem", "shell"],
    }),
    includeWhen: (intent) => intent.requiresUi,
  },
  {
    laneId: "frontend-ui",
    publicLabel: "前端界面",
    roleDisplayName: "frontend",
    inputPrefix: "前端界面",
    taskFocus: "实现项目核心操作界面、编辑管理、状态反馈、审批状态和结果回看的用户界面。",
    dependsOn: ["product-definition", "ux-flow", "backend-api"],
    toolRequirements: ["frontend_framework", "component_tests"],
    capabilityLoadout: buildCapabilityLoadout({
      runtimeSkillCandidates: ["frontend-patterns", "e2e-testing", "design-taste-frontend"],
      commands: ["meta:gap:orchestrate", "meta:capabilities:smoke"],
      runtimeTools: ["filesystem", "shell", "apply_patch", "browser_open"],
    }),
    includeWhen: (intent) => intent.requiresUi,
  },
  {
    laneId: "backend-api",
    publicLabel: "后端 API",
    roleDisplayName: "backend",
    inputPrefix: "后端 API",
    taskFocus: "定义核心业务对象、调度、审批、队列、重试和审计日志 API。",
    dependsOn: ["product-definition", "data-model"],
    toolRequirements: ["api_contract", "backend_tests"],
    capabilityLoadout: buildCapabilityLoadout({
      runtimeSkillCandidates: ["backend-patterns", "api-design", "tdd-workflow"],
      commands: ["meta:gap:orchestrate", "meta:providers:validate"],
      runtimeTools: ["filesystem", "shell", "apply_patch"],
    }),
    includeWhen: (intent) => intent.requiresBackend,
  },
  {
    laneId: "data-model",
    publicLabel: "数据模型",
    roleDisplayName: "data",
    inputPrefix: "数据模型",
    taskFocus: "设计账号、内容、素材、排期、任务、日志、凭证引用和审计记录等项目数据结构。",
    dependsOn: ["product-definition"],
    toolRequirements: ["schema_contract", "migration_plan"],
    capabilityLoadout: buildCapabilityLoadout({
      runtimeSkillCandidates: ["backend-patterns", "api-design", "security-review"],
      commands: ["meta:gap:orchestrate", "meta:providers:validate"],
      runtimeTools: ["filesystem", "shell", "apply_patch"],
    }),
    includeWhen: (intent) => intent.requiresData,
  },
  {
    laneId: "platform-integration",
    publicLabel: "平台集成",
    roleDisplayName: "integration",
    inputPrefix: "平台集成",
    taskFocus: "评估外部 API、浏览器自动化、凭证/账号、安全限制和第三方写动作授权；没有授权不能执行真实外部写入。",
    dependsOn: ["product-definition", "market-research", "backend-api"],
    toolRequirements: ["external_capability_research", "credential_boundary_review"],
    capabilityLoadout: buildCapabilityLoadout({
      runtimeSkillCandidates: ["deep-research", "exa-search", "crosspost"],
      runtimeMcpCandidates: ["exa", "context7", "playwright"],
      commands: ["meta:research:prepare", "meta:research:execute", "meta:deps:compat"],
      runtimeTools: ["web_search", "url_fetch", "browser_open", "filesystem", "shell"],
    }),
    externalWriteBoundary: true,
    includeWhen: (intent) => intent.requiresExternalIntegration,
  },
  {
    laneId: "security-approval",
    publicLabel: "权限与风控",
    roleDisplayName: "security",
    inputPrefix: "权限与风控",
    taskFocus: "定义账号凭证、外部写动作、审批、速率限制、内容合规和回滚边界。",
    dependsOn: ["product-definition", "platform-integration"],
    toolRequirements: ["security_review", "approval_contract"],
    capabilityLoadout: buildCapabilityLoadout({
      runtimeSkillCandidates: ["security-review", "verification-loop", "careful"],
      runtimeMcpCandidates: ["context7"],
      commands: ["meta:governance:validate", "meta:deps:compat"],
      runtimeTools: ["web_search", "url_fetch", "filesystem", "shell"],
    }),
    includeWhen: (intent) => intent.requiresSecurityApproval,
  },
  {
    laneId: "test-qa",
    publicLabel: "测试验收",
    roleDisplayName: "test",
    inputPrefix: "测试验收",
    taskFocus: "覆盖单元测试、API 合同测试、调度/重试集成测试、前端 E2E 和禁止未授权外部写入的安全测试。",
    dependsOn: [
      "content-strategy",
      "frontend-ui",
      "backend-api",
      "platform-integration",
      "security-approval",
    ],
    toolRequirements: ["unit_tests", "api_contract_tests", "e2e_tests"],
    capabilityLoadout: buildCapabilityLoadout({
      runtimeSkillCandidates: ["tdd-workflow", "e2e-testing", "eval-harness", "verification-loop"],
      commands: ["meta:test:meta-theory", "meta:release:smoke", "git diff --check"],
      runtimeTools: ["filesystem", "shell", "browser_open"],
    }),
    includeWhen: (intent) => intent.wishStyleProductBuild,
  },
  {
    laneId: "release-ops",
    publicLabel: "发布运维",
    roleDisplayName: "ops",
    inputPrefix: "发布运维",
    taskFocus: "准备环境变量、部署路径、日志监控、失败告警、回滚和用户验收交付说明。",
    dependsOn: ["test-qa"],
    toolRequirements: ["deployment_plan", "monitoring_plan"],
    capabilityLoadout: buildCapabilityLoadout({
      runtimeSkillCandidates: ["verification-loop", "strategic-compact", "ship"],
      runtimeMcpCandidates: ["context7"],
      commands: ["meta:release:smoke", "meta:check", "git diff --check"],
      runtimeTools: ["web_search", "url_fetch", "filesystem", "shell", "git"],
    }),
    includeWhen: (intent) => intent.requiresReleaseOps,
  },
];

function stableId(prefix, seed) {
  const hash = createHash("sha1").update(String(seed ?? "")).digest("hex").slice(0, 10);
  const safe = String(seed ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  return `${prefix}-${safe || "item"}-${hash}`;
}

function normalizeTaskText(input) {
  return String(input ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(text) : text.includes(String(pattern))
  );
}

function inferDynamicWorkflowIntent(input) {
  const text = normalizeTaskText(input);
  const normalized = text.toLowerCase();
  const buildIntent = matchesAny(normalized, [
    /\b(build|create|make|develop|ship|implement)\b/i,
    /(帮我|做个|做一个|开发|搭建|实现|搞个|弄个|来个)/u,
  ]);
  const isOnlyQuestion = matchesAny(normalized, [
    /^(什么|为何|为什么|怎么理解|解释|介绍)\b/u,
    /^(what|why|explain)\b/i,
  ]);
  const platformTargets = matchesAny(normalized, [
    /(第三方|外部|内容渠道|社交渠道|服务商|平台集成)/u,
    /\b(third[-\s]?party|external|provider|service|channel|social platform)\b/i,
  ])
    ? ["external_platform"]
    : [];
  const hasLocalScriptObject = matchesAny(normalized, [
    /(脚本|批处理|命令行|批量重命名)/u,
    /\b(script|cli|rename)\b/i,
  ]);
  const hasProductObject = matchesAny(normalized, [
    /\b(app|web app|dashboard|platform|tool|saas|automation|publisher)\b/i,
    /(系统|平台|工具|应用|网站|面板|看板|自动发布器|发布器|营销.*器|自动化)/u,
  ]);
  const scriptLikeOnly =
    hasLocalScriptObject &&
    !matchesAny(normalized, [
      /(界面|网站|平台|系统|应用|看板|发布器|营销|账号|排期|日历|审批)/u,
      /\b(web|app|dashboard|platform|publisher|campaign|account|schedule)\b/i,
    ]);
  const wishStyleProductBuild =
    buildIntent && hasProductObject && !isOnlyQuestion && !scriptLikeOnly;
  const isMarketingWorkflow = matchesAny(normalized, [
    /(营销|种草|投放|内容|文案|素材|社媒|笔记|帖子|活动|campaign)/u,
    /\b(marketing|campaign|content|copy|post|social)\b/i,
  ]);
  const requiresScheduling = matchesAny(normalized, [
    /(排期|定时|日历|队列|自动发布|计划任务)/u,
    /\b(schedule|calendar|queue|cron)\b/i,
  ]);
  const requiresExternalIntegration =
    platformTargets.length > 0 ||
    matchesAny(normalized, [
      /(第三方|外部|平台|集成|同步|发布|接口)/u,
      /\b(api|publish|post|external|integration|webhook|crosspost)\b/i,
    ]);
  const requiresUi =
    !scriptLikeOnly &&
    (matchesAny(normalized, [
      /(界面|网站|面板|看板|应用|后台|管理台|前端)/u,
      /\b(ui|frontend|dashboard|web app|admin|panel)\b/i,
    ]) ||
      wishStyleProductBuild);
  const requiresBackend =
    requiresExternalIntegration ||
    requiresScheduling ||
    matchesAny(normalized, [
      /(后端|接口|队列|服务|任务|审批|审核|数据库|自动化)/u,
      /\b(api|backend|server|service|worker|database|approval|automation)\b/i,
    ]);
  const requiresData =
    requiresBackend ||
    requiresScheduling ||
    matchesAny(normalized, [
      /(数据|记录|日志|草稿|素材|账号|内容|任务|数据库|待办|看板)/u,
      /\b(data|log|draft|asset|account|content|database|sqlite)\b/i,
    ]);
  const requiresSecurityApproval =
    requiresExternalIntegration ||
    matchesAny(normalized, [
      /(权限|风控|合规|审核|审批|安全|凭证|账号|登录|授权|cookie|token)/u,
      /\b(auth|oauth|credential|permission|risk|compliance|security|approval|cookie|token)\b/i,
    ]);
  const requiresContentGeneration =
    isMarketingWorkflow ||
    matchesAny(normalized, [
      /(生成|改写|选题|标签|标题|文案|素材|图片|视频)/u,
      /\b(generate|rewrite|topic|tag|title|image|video)\b/i,
    ]);
  const requiresExternalResearch =
    requiresExternalIntegration ||
    isMarketingWorkflow ||
    matchesAny(normalized, [
      /(最新|当前|官方|规则|政策|生态|竞品|市场|调研)/u,
      /\b(latest|current|official|rules|policy|market|research|competitor)\b/i,
    ]);
  const prototypeOnly = matchesAny(normalized, [
    /(原型|demo|只要页面|不要后端|先看样子)/u,
    /\b(prototype|demo|mockup)\b/i,
  ]);
  const externalWritesExplicitlyForbidden = matchesAny(normalized, [
    /(不要真实发布|不真实发布|不使用生产凭证|不要使用生产凭证|不要真实外部写|不要实际发布|不要登录真实账号)/u,
    /\b(no real publish|do not publish|without production credentials|no production credentials|no external writes?)\b/i,
  ]);
  const requestsLiveExternalAction =
    !externalWritesExplicitlyForbidden &&
    matchesAny(normalized, [
      /(现在发布|直接发布|立刻发布|登录账号|使用凭证|使用生产凭证|真实发布|实际发布|真实外部写)/u,
      /\b(publish now|post now|use production credentials|log in|real publish|external write)\b/i,
    ]);
  const requiresReleaseOps =
    !prototypeOnly &&
    (matchesAny(normalized, [
      /(上线|部署|发布运维|监控|告警|回滚|交付|安装)/u,
      /\b(deploy|production|release|monitor|rollback|install)\b/i,
    ]) ||
      (wishStyleProductBuild && !scriptLikeOnly));
  return {
    text,
    normalized,
    buildIntent,
    hasProductObject,
    scriptLikeOnly,
    wishStyleProductBuild,
    platformTargets,
    isMarketingWorkflow,
    requiresScheduling,
    requiresExternalIntegration,
    requiresUi,
    requiresBackend,
    requiresData,
    requiresSecurityApproval,
    requiresContentGeneration,
    requiresExternalResearch,
    requiresReleaseOps,
    prototypeOnly,
    externalWritesExplicitlyForbidden,
    requestsLiveExternalAction,
  };
}

function isWishStyleProductBuildRequest(text) {
  return inferDynamicWorkflowIntent(text).wishStyleProductBuild;
}

function inferProjectProfile(input, intent) {
  const text = normalizeTaskText(input);
  const normalized = text.toLowerCase();
  const platform = intent.platformTargets[0] ?? null;
  const localTodoDashboard = /(待办|看板|todo|kanban)/iu.test(normalized);
  const domain = intent.isMarketingWorkflow ? "marketing" : intent.requiresScheduling ? "workflow" : "product";
  const objectType = intent.requiresExternalIntegration
    ? "automation"
    : intent.requiresUi
      ? "application"
      : "tool";
  const projectKeyParts = localTodoDashboard
    ? ["local", "todo", "dashboard"]
    : [platform, domain, objectType].filter(Boolean);
  const fallbackKey = stableId("project", text).replace(/^project-/, "");
  const projectKey = (projectKeyParts.length > 0 ? projectKeyParts.join("-") : fallbackKey)
    .replace(/[^a-z0-9-]+/gi, "-")
    .toLowerCase();
  const projectLabel = localTodoDashboard
    ? "本地待办看板"
    : intent.requiresScheduling
      ? "本地待办看板"
      : "当前项目";
  return {
    schemaVersion: "project-profile-v0.1",
    projectKey,
    projectLabel,
    platformTargets: [...intent.platformTargets],
    domain,
    objectType,
    derivedFrom: "natural_language_intent_signals",
  };
}

function projectAgentIdFor(slot, projectProfile) {
  return `${projectProfile.projectKey}.${slot.roleDisplayName}`;
}

function resolveCapabilityLoadout(slot, projectProfile, intent) {
  const loadout = cloneCapabilityLoadout(slot.capabilityLoadout);
  const seed = JSON.stringify({
    projectKey: projectProfile.projectKey,
    laneId: slot.laneId,
    loadout,
    intent: sanitizeDynamicWorkflowIntent(intent),
  });
  return {
    ...loadout,
    projectKey: projectProfile.projectKey,
    capabilityProfileId: stableId("capability-profile", seed),
    capabilityProfileVersion: "run-pinned-v1",
    fixedForRun: true,
    resolvedAtStage: "Thinking",
    updatePolicy:
      "Update skills, MCPs, commands, rules, prompts, or memory providers in the capability profile; existing worker instances keep this pinned snapshot.",
  };
}

function materializeProjectCapabilitySlot(slot, projectProfile, intent) {
  const projectAgentId = projectAgentIdFor(slot, projectProfile);
  const capabilityLoadout = resolveCapabilityLoadout(slot, projectProfile, intent);
  const externalWriteRiskBoundary = slot.externalWriteBoundary === true;
  const externalWriteBoundary =
    externalWriteRiskBoundary &&
    intent.requestsLiveExternalAction === true &&
    intent.externalWritesExplicitlyForbidden !== true;
  return {
    laneId: slot.laneId,
    publicLabel: slot.publicLabel,
    roleDisplayName: slot.roleDisplayName,
    ownerAgent: projectAgentId,
    projectAgentId,
    projectProfile,
    inputPrefix: slot.inputPrefix,
    taskFocus: `${slot.taskFocus} 项目上下文：${projectProfile.projectLabel}。`,
    dependsOn: [...slot.dependsOn],
    toolRequirements: [...slot.toolRequirements],
    capabilityLoadout,
    externalWriteRiskBoundary,
    externalWriteBoundary,
    externalWritePolicy: externalWriteRiskBoundary
      ? {
          mode: externalWriteBoundary ? "approval_gate_for_live_external_action" : "design_and_sandbox_only",
          realExternalWriteAllowed: false,
          requiresExplicitApprovalForLiveWrite: true,
        }
      : null,
    slotSource: "capability_slot_catalog",
    projectAgentSource: "synthesized_from_project_profile_and_capability_requirements",
  };
}

function selectedDynamicWorkflowLanes(intent) {
  return CAPABILITY_SLOT_CATALOG.filter((lane) => lane.includeWhen(intent));
}

function dynamicDecisionInputForLane(lane, intent) {
  if (lane.externalWriteBoundary) {
    return `${lane.publicLabel}: project agent ${lane.projectAgentId} is synthesized with a pinned capability profile; third-party publish or external write requires explicit approval before execution.`;
  }
  return [
    `${lane.publicLabel}: 项目 agent ${lane.projectAgentId} 在 Thinking 阶段动态合成，并固定 capabilityProfileId=${lane.capabilityLoadout.capabilityProfileId} 供本次执行使用。`,
    "执行时 worker 只是该项目 agent 的本次实例；能力更新通过 capability profile 演进，不在执行中漂移。",
    intent.requiresExternalIntegration
      ? "相关外部动作只做边界设计，不直接执行第三方写操作。"
      : "不涉及第三方写操作。",
  ].join(" ");
}

function expandDynamicWorkflowRequests(text) {
  const intent = inferDynamicWorkflowIntent(text);
  const projectProfile = inferProjectProfile(text, intent);
  return selectedDynamicWorkflowLanes(intent).map((slot, index) => {
    const lane = materializeProjectCapabilitySlot(slot, projectProfile, intent);
    return {
      requestId: stableId("gap-request", `${index}-${lane.laneId}-${text}`),
      index,
      input: dynamicDecisionInputForLane(lane, intent),
      sourceInput: text,
      sourceKind: "wish_style_product_build",
      businessFlowLane: lane,
      dynamicWorkflowIntent: sanitizeDynamicWorkflowIntent(intent),
      projectProfile,
    };
  });
}

function sanitizeDynamicWorkflowIntent(intent) {
  return {
    buildIntent: intent.buildIntent,
    hasProductObject: intent.hasProductObject,
    scriptLikeOnly: intent.scriptLikeOnly,
    wishStyleProductBuild: intent.wishStyleProductBuild,
    platformTargets: intent.platformTargets,
    isMarketingWorkflow: intent.isMarketingWorkflow,
    requiresScheduling: intent.requiresScheduling,
    requiresExternalIntegration: intent.requiresExternalIntegration,
    requiresUi: intent.requiresUi,
    requiresBackend: intent.requiresBackend,
    requiresData: intent.requiresData,
    requiresSecurityApproval: intent.requiresSecurityApproval,
    requiresContentGeneration: intent.requiresContentGeneration,
    requiresExternalResearch: intent.requiresExternalResearch,
    requiresReleaseOps: intent.requiresReleaseOps,
    prototypeOnly: intent.prototypeOnly,
    externalWritesExplicitlyForbidden: intent.externalWritesExplicitlyForbidden,
    requestsLiveExternalAction: intent.requestsLiveExternalAction,
  };
}

function buildDynamicWorkflowPlan(input, requests) {
  const intent = inferDynamicWorkflowIntent(input);
  const selectedLaneIds = requests
    .map((request) => request.businessFlowLane?.laneId)
    .filter(Boolean);
  const selectedLaneSet = new Set(selectedLaneIds);
  const omittedLanes = intent.wishStyleProductBuild
    ? CAPABILITY_SLOT_CATALOG.filter((lane) => !selectedLaneSet.has(lane.laneId)).map(
        (lane) => ({
          laneId: lane.laneId,
          label: lane.publicLabel,
          reason: "intent_signal_not_present",
        })
      )
    : [];
  return {
    schemaVersion: "dynamic-workflow-plan-v0.1",
    applied: selectedLaneIds.length > 0,
    strategy: "classify_and_act_then_fanout_synthesize_with_verification",
    routingBasis: "intent_signals_and_capability_evidence",
    notFixedTemplate: true,
    intentSignals: sanitizeDynamicWorkflowIntent(intent),
    selectedLaneIds,
    omittedLanes,
    orchestrationPatterns: [
      "classify-and-act",
      "fan-out-and-synthesize",
      "adversarial-verification",
      "loop-until-done-when-work-amount-is-unknown",
    ],
    sourceAlignment: [
      "Claude dynamic workflows: custom harness, prompt-based planning, subagent fan-out, verification before synthesis.",
      "LangGraph: state, nodes, and conditional edges select the next node from current state.",
      "OpenAI Agents SDK: mix LLM orchestration with code orchestration, agents-as-tools, and handoffs.",
    ],
  };
}

export function decomposeCapabilityGapRequests(input) {
  const text = normalizeTaskText(input);
  if (!text) return [];
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*[-*•\d.、)）]+/, "").trim())
    .filter(Boolean);
  const sourceItems = lines.length > 1 ? lines : text.split(/[；;]+/).map((item) => item.trim());
  if (sourceItems.length === 1 && isWishStyleProductBuildRequest(text)) {
    return expandDynamicWorkflowRequests(text);
  }
  return sourceItems
    .filter(Boolean)
    .map((item, index) => ({
      requestId: stableId("gap-request", `${index}-${item}`),
      index,
      input: item,
    }));
}

function repeatKeyFor(result) {
  const text = result.capabilityGap.taskContext.toLowerCase();
  if (text.includes("prd") || text.includes("review standard") || text.includes("critical")) {
    return "prd-review-flow";
  }
  if (text.includes("coverage") || text.includes("test")) {
    return "coverage-strategy-owner";
  }
  if (text.includes("release") || text.includes("artifact") || text.includes("json")) {
    return "artifact-normalizer";
  }
  if (text.includes("knowledge") || text.includes("provider") || text.includes("内部知识库")) {
    return "knowledge-provider";
  }
  if (text.includes("credential") || text.includes("paid") || text.includes("publish")) {
    return "external-action-approval";
  }
  return result.gapDecision.decision;
}

function makeGroupKey(result) {
  return `${result.gapDecision.decision}:${repeatKeyFor(result)}`;
}

function needsExternalResearch(input) {
  return /\b(latest|current|today|api|platform|provider|dependency|external|web|search|official|version|price|market|competitor|commercial|commerciali[sz]e|pricing|customer|investor|strategy)\b|联网|最新|当前|今天|平台|外部|生态|供应商|依赖|官方|版本|价格|搜索|市场|竞品|商业化|定价|客户|投资|战略|发展/i.test(
    String(input ?? "")
  );
}

function projectFetchSources(input) {
  const text = String(input ?? "");
  const sources = [
    {
      source: "README.md",
      sourceType: "project_overview",
      routeImpact: "explain user-facing purpose and installation surface",
      requiredForProjectUnderstanding: true,
    },
    {
      source: "AGENTS.md",
      sourceType: "maintainer_contract",
      routeImpact: "bind runtime behavior, governance entry, and Graphify policy",
      requiredForProjectUnderstanding: true,
    },
    {
      source: "package.json",
      sourceType: "command_inventory",
      routeImpact: "discover executable product and verification commands",
      requiredForProjectUnderstanding: true,
    },
    {
      source: "graphify-out/GRAPH_REPORT.md",
      sourceType: "project_graph",
      routeImpact: "navigate broad codebase structure before source verification",
      requiredForProjectUnderstanding: true,
    },
    {
      source: "canonical/skills/meta-theory/SKILL.md",
      sourceType: "canonical_skill",
      routeImpact: "bind meta-theory executable governance rules",
      requiredForProjectUnderstanding: true,
    },
    {
      source: "config/contracts/core-loop-contract.json",
      sourceType: "machine_contract",
      routeImpact: "prove the default governed execution entry and stage outputs",
      requiredForProjectUnderstanding: true,
    },
    {
      source: "config/capability-index/",
      sourceType: "capability_index",
      routeImpact: "discover reusable agents, skills, tools, MCPs, hooks, and runtime providers",
      requiredForProjectUnderstanding: true,
    },
    {
      source: ".mcp.json and runtime MCP configs",
      sourceType: "mcp_inventory",
      routeImpact: "detect retrieval and memory/tool providers before Thinking",
      requiredForProjectUnderstanding: true,
    },
  ];

  if (needsExternalResearch(text)) {
    sources.push({
      source: "runtime retrieval capability inventory",
      sourceType: "external_research_capability",
      routeImpact: "prove web_search/url_fetch/browser/MCP/provider path or block before market claims",
      requiredForProjectUnderstanding: true,
    });
  }

  return sources;
}

function buildResearchCapabilityDiscovery(input) {
  const researchRequired = needsExternalResearch(input);
  return {
    owner: "meta-scout",
    researchRequired,
    retrievalCapabilities: RETRIEVAL_CAPABILITIES,
    selectedPath: researchRequired ? "mixed_source_backed_research" : "local_only_with_probe_record",
    blocked: false,
    limitations: researchRequired
      ? [
          "External retrieval capability must be proven by the active runtime before source-backed claims are final.",
        ]
      : [
          "No current external-fact dependency detected for this orchestration fixture.",
        ],
  };
}

function buildDeepResearchPlan(input) {
  const required = needsExternalResearch(input);
  return {
    owner: "meta-scout",
    required,
    decisionImpactRequired: true,
    stageGate: required ? "must_complete_before_thinking" : "recorded_before_thinking",
    sourceCategories: required
      ? ["official_docs", "current_runtime_inventory", "provider_registry", "external_ecosystem"]
      : ["canonical_sources", "contracts", "local_runtime_inventory"],
    questions: required
      ? [
          "Which current facts or external provider capabilities change the route?",
          "Which retrieval capability can verify those facts in this runtime?",
          "Does the evidence support reuse, creation, upgrade, workerTask-only, or block?",
        ]
      : [
          "Which local canonical and contract evidence changes the route?",
          "Which capability types are already covered before Thinking?",
        ],
    skipReason: required
      ? null
      : "Task does not depend on current external facts, third-party state, or live ecosystem claims.",
  };
}

function buildCapabilityInventory(decided) {
  const decisions = new Set(decided.map((gap) => gap.decision));
  return MULTI_TYPE_CAPABILITY_INVENTORY.map((item) => ({
    ...item,
    checkedBeforeThinking: true,
    coverageStatus:
      item.capabilityType === "worker_task" ||
      (item.capabilityType === "skill" && decisions.has("create_skill")) ||
      (item.capabilityType === "agent" && decisions.has("create_agent")) ||
      (item.capabilityType === "script" && decisions.has("create_script")) ||
      (item.capabilityType === "mcp_provider_tool" && decisions.has("create_mcp_provider"))
        ? "route_relevant"
        : "checked_no_primary_route",
    insufficiencyPolicy: "create_or_upgrade_only_after_fetch_evidence",
  }));
}

function summarizeGap(result, request) {
  const businessFlowLane = request.businessFlowLane ?? null;
  const repeatKey = businessFlowLane?.laneId ?? repeatKeyFor(result);
  return {
    requestId: request.requestId,
    sourceIndex: request.index,
    input: request.input,
    sourceInput: request.sourceInput ?? request.input,
    sourceKind: request.sourceKind ?? "explicit_gap_request",
    businessFlowLane,
    gapId: result.capabilityGap.gapId,
    repeatKey,
    decision: result.gapDecision.decision,
    decisionReason: result.gapDecision.decisionReason,
    owner: businessFlowLane?.ownerAgent ?? OWNER_BY_DECISION[result.gapDecision.decision],
    outputKind: result.decisionOutput.kind,
    candidateType: result.candidateWriteback?.candidateType ?? null,
    projectRetention: result.generatedAgentSpec?.projectRetention ?? null,
    blocked: result.gapDecision.decision === "blocked_or_needs_approval",
  };
}

function makeWorkerTaskPacket({ gap, group, groupIndex, itemIndex }) {
  const decision = gap.decision;
  const lane = gap.businessFlowLane;
  const roleDisplayName = lane?.roleDisplayName ?? ROLE_BY_DECISION[decision] ?? "worker";
  const capabilityLoadout = cloneCapabilityLoadout(lane?.capabilityLoadout);
  const roleSoulPolicy = lane ? buildRoleSoulPolicy(lane) : null;
  const taskPacketId = stableId("worker-task", `${group.groupKey}-${gap.requestId}`);
  const executionMode = lane
    ? "primary_execution"
    : decision === "blocked_or_needs_approval"
      ? "approval_gate"
      : FACTORY_DECISIONS.has(decision)
        ? "factory_then_dispatch"
        : "primary_execution";
  return {
    taskPacketId,
    owner: gap.owner,
    ownerMode: lane
      ? "project-agent-profile"
      : decision === "worker_task_only"
        ? "existing-owner"
        : "create-owner-first",
    executionMode,
    workerInstanceMode: lane ? "run-scoped-instance" : "gap-decision-worker",
    ownerAgent: gap.owner,
    projectAgentId: lane?.projectAgentId ?? null,
    businessRoleId: roleDisplayName,
    roleDisplayName,
    roleInstanceId: `${roleDisplayName}-${groupIndex + 1}-${itemIndex + 1}`,
    runtimeInstanceAlias: null,
    businessFlowLaneId: lane?.laneId ?? null,
    businessFlowLaneLabel: lane?.publicLabel ?? null,
    coreProblem: lane?.taskFocus ?? gap.decisionReason,
    todayTask: lane
      ? `Produce ${lane.publicLabel} handoff for: ${lane.taskFocus}`
      : `Produce ${gap.outputKind} for capability gap ${gap.gapId}.`,
    nonGoals: [
      "Do not write canonical state automatically.",
      "Do not execute external writes without approval.",
      "Do not turn one-run details into durable identity.",
      ...(lane?.externalWriteBoundary
        ? ["Do not perform real third-party publish actions without explicit user approval."]
        : lane?.externalWriteRiskBoundary
        ? ["Do not perform real third-party publish actions without explicit user approval."]
        : []),
    ],
    output: gap.outputKind,
    acceptanceCriteria: lane
      ? [
          `${lane.publicLabel} output answers the user's wish-style request without requiring protocol knowledge.`,
          "Handoff declares inputs, outputs, owner, dependencies, and verification evidence.",
          "External write, credential, and publishing actions remain blocked unless explicitly approved.",
        ]
      : [
          "GapDecision evidence is pass.",
          "DecisionOutput acceptance is pass.",
          "Review owner can verify owner boundary and non-goals.",
        ],
    deliverableLink: null,
    scopeFiles: [],
    qualityBar: "reviewable, source-grounded, no fake owner, no missing verifier",
    workType: lane ? "business_flow_product_delivery" : "capability_gap_resolution",
    expertLensRefs: ["Critical", "Fetch", "Thinking", "Review"],
    evidenceRefs: [gap.gapId, gap.requestId],
    capabilityRequirements: lane
      ? [...new Set([decision, "business_flow_lane", roleDisplayName])]
      : [decision],
    toolRequirements: lane?.toolRequirements ?? [],
    capabilityLoadout,
    capabilityBindings: capabilityLoadout,
    roleSoulPolicy,
    externalWriteRiskBoundary: lane?.externalWriteRiskBoundary === true,
    externalWriteBoundary: lane?.externalWriteBoundary === true,
    externalWritePolicy: lane?.externalWritePolicy ?? null,
    durableIdentityStatus: lane
      ? "project_agent_profile_synthesized_and_capability_pinned_for_run"
      : decision === "create_agent"
        ? "pending_generated_agent_spec_review"
        : "uses_existing_or_gap_decision_owner",
    capabilityInventoryRefs: group.capabilityInventoryRefs,
    durableProjectAgentPolicy:
      decision === "create_agent"
        ? {
            requiredDeliverable: "project_retained_abstract_agent_definition",
            temporaryWorkerIsNotDeliverable: true,
            runtimeTargets: AGENT_PROJECTION_TARGETS.map((target) => ({ ...target })),
          }
        : null,
    referenceDirection: "Use CapabilityGap and GapDecision evidence; concrete one-run work stays in this packet.",
    handoffTarget: "meta-conductor",
    handoffContract: {
      handoffTo: "meta-conductor",
      handoffWhen: "task output is review-ready",
      requiredEvidence: ["decisionEvidence", "decisionOutput", "verificationOwner"],
    },
    lengthExpectation: "compact",
    visualOrAssetPlan: "none",
    dependsOn: [],
    dependencyLaneIds: lane?.dependsOn ?? [],
    parallelGroup: group.parallelGroup,
    mergeOwner: "meta-conductor",
    shardKey: group.groupKey,
    shardScope: lane?.laneId ?? gap.repeatKey,
    workspaceIsolation: "run_scoped",
    artifactNamespace: group.groupKey.replace(/[^a-z0-9:_-]/gi, "-"),
    collisionPolicy: group.items.length > 1 ? "merge_by_owner" : "no_overlap",
    verifySteps: [
      {
        id: "decision-output-reviewed",
        command: "npm run meta:gap:orchestrate",
        successMarker: "status=pass",
      },
    ],
    preDecisionOptionFrameRef: "capability-gap-orchestration",
    userChoiceState: "auto_proceed_no_branching_choice",
    finalizationGate: "Review then Verification",
  };
}

function groupGaps(gaps) {
  const groupsByKey = new Map();
  for (const gap of gaps) {
    const groupKey = gap.businessFlowLane
      ? `business-flow:${gap.businessFlowLane.laneId}`
      : makeGroupKey({
          capabilityGap: { taskContext: gap.input },
          gapDecision: { decision: gap.decision },
        });
    if (!groupsByKey.has(groupKey)) {
      groupsByKey.set(groupKey, {
        groupKey,
        decision: gap.decision,
        repeatKey: gap.repeatKey,
        items: [],
      });
    }
    groupsByKey.get(groupKey).items.push(gap);
  }
  return [...groupsByKey.values()].map((group, index) => ({
    ...group,
    parallelGroup: `capability-gap-${index + 1}`,
    duplicatePolicy: group.items.length > 1 ? "same_type_same_repeat_key_grouped" : "distinct_gap",
  }));
}

function boardModeFor(gaps) {
  return gaps.some((gap) =>
    ["create_skill", "create_agent", "create_script", "create_mcp_provider"].includes(gap.decision)
  )
    ? "factory_then_dispatch"
    : "direct_dispatch";
}

export function buildCapabilityGapOrchestration(input) {
  const requests = decomposeCapabilityGapRequests(input);
  const dynamicWorkflowPlan = buildDynamicWorkflowPlan(input, requests);
  const decided = requests.map((request) => {
    const result = decideCapabilityGap(request.input);
    return summarizeGap(result, request);
  });
  const capabilityInventory = buildCapabilityInventory(decided);
  const researchCapabilityDiscovery = buildResearchCapabilityDiscovery(input);
  const deepResearchPlan = buildDeepResearchPlan(input);
  const groups = groupGaps(decided);
  for (const group of groups) {
    group.capabilityInventoryRefs = capabilityInventory.map((item) => item.capabilityType);
  }
  const workerTaskPackets = groups.flatMap((group, groupIndex) =>
    group.items.map((gap, itemIndex) =>
      makeWorkerTaskPacket({ gap, group, groupIndex, itemIndex })
    )
  );
  const taskIdByLaneId = new Map(
    workerTaskPackets
      .filter((packet) => packet.businessFlowLaneId)
      .map((packet) => [packet.businessFlowLaneId, packet.taskPacketId])
  );
  for (const packet of workerTaskPackets) {
    if (packet.dependencyLaneIds.length > 0) {
      packet.dependsOn = packet.dependencyLaneIds
        .map((laneId) => taskIdByLaneId.get(laneId))
        .filter(Boolean);
    }
  }
  const businessFlowCapabilityMatrix = workerTaskPackets
    .filter((packet) => packet.businessFlowLaneId)
    .map((packet) => {
      const externalEvidencePolicy = buildExternalEvidencePolicy(
        packet,
        researchCapabilityDiscovery
      );
      const localBaselineComparison = buildLocalBaselineComparison(packet);
      const knowledgeGraphPolicy = buildKnowledgeGraphPolicy(packet);
      return {
        laneId: packet.businessFlowLaneId,
        label: packet.businessFlowLaneLabel,
        owner: packet.owner,
        projectAgentId: packet.projectAgentId,
        roleDisplayName: packet.roleDisplayName,
        taskPacketId: packet.taskPacketId,
        dependsOn: packet.dependsOn,
        toolRequirements: packet.toolRequirements,
        capabilityLoadout: packet.capabilityLoadout,
        executionMode: packet.executionMode,
        ownerMode: packet.ownerMode,
        workerInstanceMode: packet.workerInstanceMode,
        durableIdentityStatus: packet.durableIdentityStatus,
        roleSoulPolicy: packet.roleSoulPolicy,
        externalWriteBoundary: packet.externalWriteBoundary === true,
        externalEvidencePolicy,
        localBaselineComparison,
        knowledgeGraphPolicy,
        evidenceContract: {
          externalBeforeLocalDecision: true,
          localComparisonBeforeDispatch: true,
          noCurrentFactWithoutSource: true,
          noProviderClaimWithoutLocalCheck: true,
        },
      };
    });
  const projectAgentBlueprintPacket = {
    schemaVersion: "project-agent-blueprint-v0.1",
    synthesisStage: "Thinking",
    source: "natural_language_project_profile_plus_capability_slot_requirements",
    fixedDuringExecution: true,
    capabilityUpdatePolicy:
      "Update skill, prompt, rule, MCP, command, memory, or runtime-tool providers through the capability profile; active workers keep their pinned capabilityProfileId.",
    agents: [
      ...new Map(
        workerTaskPackets
          .filter((packet) => packet.projectAgentId)
          .map((packet) => [
            packet.projectAgentId,
            {
              projectAgentId: packet.projectAgentId,
              ownerMode: packet.ownerMode,
              roleDisplayName: packet.roleDisplayName,
              projectKey: packet.roleSoulPolicy?.projectKey ?? null,
              projectLabel: packet.roleSoulPolicy?.projectLabel ?? null,
              capabilityProfileId: packet.capabilityLoadout?.capabilityProfileId ?? null,
              capabilityProfileVersion: packet.capabilityLoadout?.capabilityProfileVersion ?? null,
              fixedForRun: packet.capabilityLoadout?.fixedForRun === true,
              memoryStrategy: {
                scope: "project",
                defaultMode: "project_only",
                updatePolicy:
                  "Write durable project lessons only through Evolution after Review; read project memory during Fetch.",
              },
              loadoutSlots: {
                skills: packet.capabilityLoadout?.runtimeSkillCandidates ?? [],
                mcp: packet.capabilityLoadout?.runtimeMcpCandidates ?? [],
                commands: packet.capabilityLoadout?.commands ?? [],
                runtimeTools: packet.capabilityLoadout?.runtimeTools ?? [],
              },
              externalEvidencePolicy: buildExternalEvidencePolicy(
                packet,
                researchCapabilityDiscovery
              ),
              localBaselineComparison: buildLocalBaselineComparison(packet),
              knowledgeGraphPolicy: buildKnowledgeGraphPolicy(packet),
              evidenceContract: {
                externalBeforeLocalDecision: true,
                localComparisonBeforeDispatch: true,
                noCurrentFactWithoutSource: true,
                noProviderClaimWithoutLocalCheck: true,
              },
              promotionPolicy:
                "Candidate profile may become a project-retained agent only after repeated fit or explicit user request plus GapDecision=create_agent and Warden-approved GeneratedAgentSpec.",
            },
          ])
      ).values(),
    ],
  };
  const orchestrationTaskBoardPacket = {
    dispatchBoardId: stableId("dispatch-board", input),
    boardMode: boardModeFor(decided),
    synthesisOwner: "meta-conductor",
    triggerChain: [
      "meta-theory-skill-adapter",
      "meta-warden-entry-gate",
      "meta-conductor-orchestration",
      "capability-gap-decision-kernel",
    ],
    tasks: workerTaskPackets.map((packet) => ({
      taskPacketId: packet.taskPacketId,
      owner: packet.owner,
      projectAgentId: packet.projectAgentId,
      roleDisplayName: packet.roleDisplayName,
      roleInstanceId: packet.roleInstanceId,
      dependsOn: packet.dependsOn,
      parallelGroup: packet.parallelGroup,
      mergeOwner: packet.mergeOwner,
      shardKey: packet.shardKey,
      shardScope: packet.shardScope,
      businessFlowLaneId: packet.businessFlowLaneId,
      businessFlowLaneLabel: packet.businessFlowLaneLabel,
      ownerMode: packet.ownerMode,
      executionMode: packet.executionMode,
      workerInstanceMode: packet.workerInstanceMode,
      capabilityLoadoutSummary: packet.capabilityLoadout
        ? {
            repoSkills: packet.capabilityLoadout.repoSkills,
            runtimeSkillCandidates: packet.capabilityLoadout.runtimeSkillCandidates,
            repoMcpTools: packet.capabilityLoadout.repoMcpTools,
            runtimeMcpCandidates: packet.capabilityLoadout.runtimeMcpCandidates,
            commands: packet.capabilityLoadout.commands,
            runtimeTools: packet.capabilityLoadout.runtimeTools,
          }
        : null,
      durableIdentityStatus: packet.durableIdentityStatus,
      roleSoulPolicy: packet.roleSoulPolicy,
      durableProjectAgentPolicy: packet.durableProjectAgentPolicy,
    })),
  };
  const decisionCounts = Object.fromEntries(
    GAP_DECISIONS.map((decision) => [
      decision,
      decided.filter((gap) => gap.decision === decision).length,
    ])
  );
  const businessFlowPackets = workerTaskPackets.filter((packet) => packet.businessFlowLaneId);
  const dynamicProjectAgentIdentityReady = businessFlowPackets.every(
    (packet) =>
      packet.ownerMode === "project-agent-profile" &&
      packet.workerInstanceMode === "run-scoped-instance" &&
      packet.durableIdentityStatus === "project_agent_profile_synthesized_and_capability_pinned_for_run" &&
      packet.projectAgentId &&
      packet.roleSoulPolicy?.durableAgentCreated === false &&
      packet.roleSoulPolicy?.savedIn === "projectAgentBlueprintPacket" &&
      packet.capabilityLoadout?.repoSkills?.includes("meta-theory") &&
      packet.capabilityLoadout?.fixedForRun === true &&
      packet.capabilityLoadout?.capabilityProfileId &&
      packet.capabilityLoadout?.commands?.length > 0 &&
      packet.capabilityLoadout?.runtimeTools?.length > 0
  );
  const dynamicProjectAgentEvidenceReady =
    businessFlowPackets.length === 0 ||
    projectAgentBlueprintPacket.agents.every(
      (agent) =>
        agent.externalEvidencePolicy &&
        typeof agent.externalEvidencePolicy.required === "boolean" &&
        Array.isArray(agent.externalEvidencePolicy.preferredRetrieval) &&
        agent.externalEvidencePolicy.preferredRetrieval.includes("web_search") &&
        agent.externalEvidencePolicy.preferredRetrieval.includes("url_fetch") &&
        agent.externalEvidencePolicy.noCurrentFactWithoutSource === true &&
        (!agent.externalEvidencePolicy.required ||
          agent.externalEvidencePolicy.loadoutHasRetrieval === true ||
          agent.externalEvidencePolicy.blockedIfMissing === true) &&
        agent.localBaselineComparison?.required === true &&
        agent.localBaselineComparison?.noProviderClaimWithoutLocalCheck === true &&
        agent.evidenceContract?.externalBeforeLocalDecision === true &&
        agent.evidenceContract?.localComparisonBeforeDispatch === true
    );
  const dynamicProjectAgentGraphReady =
    businessFlowPackets.length === 0 ||
    projectAgentBlueprintPacket.agents.every(
      (agent) =>
        agent.knowledgeGraphPolicy?.equipped === true &&
        agent.knowledgeGraphPolicy?.mode === "graph_navigation_and_worker_slice" &&
        agent.knowledgeGraphPolicy?.runStartPolicy?.existenceCheckOnly === true &&
        agent.knowledgeGraphPolicy?.runStartPolicy?.noStartupFreshnessGate === true &&
        agent.knowledgeGraphPolicy?.runStartPolicy?.noStartupRebuild === true &&
        agent.knowledgeGraphPolicy?.contextInjectionPolicy?.allowed?.includes(
          "worker_relevant_graph_slice"
        ) &&
        agent.knowledgeGraphPolicy?.contextInjectionPolicy?.forbidden?.includes(
          "full_graph_json"
        ) &&
        agent.knowledgeGraphPolicy?.truthPolicy?.finalTruthSource === "target_source_files" &&
        agent.knowledgeGraphPolicy?.afterMutationPolicy?.rebuildCommand ===
          "npm run meta:graphify:rebuild"
    );
  const executionModeReady =
    workerTaskPackets.length > 0 &&
    workerTaskPackets.every((packet) => EXECUTION_MODE_ENUM.has(packet.executionMode)) &&
    (workerTaskPackets.some((packet) => EXECUTION_WORKER_MODES.has(packet.executionMode)) ||
      workerTaskPackets.every((packet) => APPROVAL_GATE_MODES.has(packet.executionMode)));
  const status =
    requests.length > 0 &&
    workerTaskPackets.length === decided.length &&
    workerTaskPackets.every((packet) => packet.mergeOwner === "meta-conductor") &&
    executionModeReady &&
    dynamicProjectAgentIdentityReady &&
    dynamicProjectAgentEvidenceReady &&
    dynamicProjectAgentGraphReady &&
    (businessFlowPackets.length === 0 ||
      (projectAgentBlueprintPacket.agents.length > 0 &&
        projectAgentBlueprintPacket.agents.every(
          (agent) =>
            agent.fixedForRun && agent.capabilityProfileId && agent.memoryStrategy.scope === "project"
        ))) &&
    capabilityInventory.length >= 10 &&
    capabilityInventory.every((item) => item.checkedBeforeThinking) &&
    researchCapabilityDiscovery.retrievalCapabilities.length >= 8 &&
    deepResearchPlan.decisionImpactRequired === true &&
    orchestrationTaskBoardPacket.triggerChain[0] === "meta-theory-skill-adapter" &&
    orchestrationTaskBoardPacket.triggerChain[2] === "meta-conductor-orchestration"
      ? "pass"
      : "fail";
  return {
    schemaVersion: 1,
    status,
    rootGoal:
      "Route meta-theory-triggered complex tasks through Warden/Conductor before CapabilityGap decisions enter execution.",
    criticalSummary: {
      realGoal:
        "Support multiple capability gaps and dynamic natural-language workflow routing without making a skill or runtime adapter the planner.",
      nonGoals: [
        "No full CapabilityGraph.",
        "No graph database.",
        "No automatic canonical write.",
        "No governance agent as implementation worker.",
        "No fixed business-flow lane template for every wish-style request.",
      ],
      successCriteria: [
        "Skill is only the trigger adapter.",
        "Conductor owns orchestration.",
        "Each gap has its own GapDecision.",
        "Same-type repeated needs have stable grouping and merge owner.",
        "Create-agent routes produce durable project-agent candidates, not temporary worker prompts.",
        "Formal tool projection targets are declared from the compatibility catalog.",
        "Wish-style natural language selects lanes from intent signals and omitted lanes are recorded.",
        "Dynamic business-flow lanes synthesize project agent profiles, pin capability profiles for execution, and keep workers as run-scoped instances.",
      ],
    },
    stageVisibility: {
      requiredStages: ["Critical", "Fetch", "Thinking", "Review"],
      publicSummaryRequired: true,
      mustShowCapabilityRoute: true,
      mustDistinguishTemporarySubagentsFromDurableAgents: true,
    },
    fetchEvidence: {
      sources: projectFetchSources(input),
      entryGate: "meta-warden",
      orchestrationOwner: "meta-conductor",
      decisionKernel: "scripts/capability-gap-mvp.mjs",
      stageOrder: "Fetch completes research and multi-type capability inventory before Thinking.",
      capabilityInventory,
      runtimeRequirements: {
        formalToolTargets: AGENT_PROJECTION_TARGETS.map((target) => ({ ...target })),
      },
      researchCapabilityDiscovery,
      deepResearchPlan,
      dynamicWorkflowPlan,
      businessFlowCapabilityMatrix,
      decisionImpactMap: capabilityInventory.map((item) => ({
        capabilityType: item.capabilityType,
        routeImpact: item.routeImpact,
        checkedBeforeThinking: item.checkedBeforeThinking,
      })),
    },
    thinkingRoute: {
      boardMode: boardModeFor(decided),
      groupingPolicy: "same decision + repeat key share parallel group",
      businessFlowLaneCount: businessFlowCapabilityMatrix.length,
      businessFlowLanes: businessFlowCapabilityMatrix.map((lane) => ({
        laneId: lane.laneId,
        label: lane.label,
        owner: lane.owner,
        projectAgentId: lane.projectAgentId,
        roleDisplayName: lane.roleDisplayName,
      })),
      projectAgentBlueprint: {
        agentCount: projectAgentBlueprintPacket.agents.length,
        projectAgentIds: projectAgentBlueprintPacket.agents.map((agent) => agent.projectAgentId),
        fixedDuringExecution: projectAgentBlueprintPacket.fixedDuringExecution,
        externalEvidenceRequiredAgentIds: projectAgentBlueprintPacket.agents
          .filter((agent) => agent.externalEvidencePolicy?.required)
          .map((agent) => agent.projectAgentId),
        localBaselineRequiredAgentIds: projectAgentBlueprintPacket.agents
          .filter((agent) => agent.localBaselineComparison?.required)
          .map((agent) => agent.projectAgentId),
        knowledgeGraphEquippedAgentIds: projectAgentBlueprintPacket.agents
          .filter((agent) => agent.knowledgeGraphPolicy?.equipped)
          .map((agent) => agent.projectAgentId),
      },
      dynamicWorkflowPlan: {
        applied: dynamicWorkflowPlan.applied,
        strategy: dynamicWorkflowPlan.strategy,
        selectedLaneIds: dynamicWorkflowPlan.selectedLaneIds,
        omittedLaneIds: dynamicWorkflowPlan.omittedLanes.map((lane) => lane.laneId),
      },
      ownerSelectionPolicy:
        "Use governance owner for candidate design; dynamic implementation lanes remain run-scoped worker roles unless GapDecision=create_agent passes GeneratedAgentSpec review.",
      durableProjectAgentPolicy:
        "Project agent profiles are synthesized at Thinking and pinned for execution; when decision=create_agent, the deliverable is a project-retained abstract agent candidate with formal tool projection targets.",
      runtimeTargets: AGENT_PROJECTION_TARGETS.map((target) => ({ ...target })),
    },
    capabilityGaps: decided,
    groupedGaps: groups,
    decisionCounts,
    projectAgentBlueprintPacket,
    orchestrationTaskBoardPacket,
    workerTaskPackets,
    reviewResult: {
      owner: "meta-prism",
      status,
      checks: {
        skillIsNotPlanner:
          orchestrationTaskBoardPacket.triggerChain[0] === "meta-theory-skill-adapter",
        conductorOwnsBoard: orchestrationTaskBoardPacket.synthesisOwner === "meta-conductor",
        eachGapHasWorkerTask: workerTaskPackets.length === decided.length,
        workerTasksDeclareExecutionMode: workerTaskPackets.every((packet) =>
          EXECUTION_MODE_ENUM.has(packet.executionMode)
        ),
        executionWorkersAreNotSidecars:
          workerTaskPackets.some((packet) =>
            EXECUTION_WORKER_MODES.has(packet.executionMode)
          ) ||
          workerTaskPackets.every((packet) =>
            APPROVAL_GATE_MODES.has(packet.executionMode)
          ),
        sameOwnerInstancesHaveShardScope: workerTaskPackets.every(
          (packet) => packet.roleInstanceId && packet.shardScope && packet.mergeOwner
        ),
        multiTypeCapabilityInventoryPresent:
          capabilityInventory.length >= 10 &&
          capabilityInventory.every((item) => item.checkedBeforeThinking),
        researchCapabilityDiscoveryRecorded:
          researchCapabilityDiscovery.retrievalCapabilities.length >= 8,
        deepResearchPlanRecorded: deepResearchPlan.decisionImpactRequired === true,
        dynamicWorkflowIsConditional:
          !dynamicWorkflowPlan.applied ||
          (dynamicWorkflowPlan.notFixedTemplate === true &&
            dynamicWorkflowPlan.selectedLaneIds.length === businessFlowCapabilityMatrix.length),
        dynamicProjectAgentsAreSynthesizedAndPinned: dynamicProjectAgentIdentityReady,
        dynamicProjectAgentsHaveEvidencePolicies: dynamicProjectAgentEvidenceReady,
        dynamicProjectAgentsHaveGraphPolicies: dynamicProjectAgentGraphReady,
        dynamicLanesHaveLoadoutAndSoulPolicy: businessFlowPackets.every(
          (packet) => packet.capabilityLoadout && packet.roleSoulPolicy
        ),
        fetchBeforeThinking:
          orchestrationTaskBoardPacket.triggerChain.indexOf("meta-conductor-orchestration") >
          orchestrationTaskBoardPacket.triggerChain.indexOf("meta-warden-entry-gate"),
      },
    },
    verificationResult: {
      owner: "verify",
      status,
      command: "npm run meta:gap:orchestrate",
    },
    evolutionDecision: {
      status: "none-with-reason",
      reason: "This run proves orchestration routing; canonical writeback requires Warden approval.",
    },
  };
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function positionalTask(fallback = null) {
  const positional = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (["--task", "--input", "--json-out"].includes(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) continue;
    positional.push(value);
  }
  return positional.length > 0 ? positional.join(" ") : fallback;
}

async function main() {
  const task = argValue("--task", positionalTask(null));
  const inputPath = argValue("--input", null);
  const stdoutOnly = hasFlag("--stdout-only") || hasFlag("--dry-run");
  const outputPath = path.resolve(argValue("--json-out", DEFAULT_OUTPUT_PATH));
  const input = inputPath
    ? await fs.readFile(path.resolve(process.cwd(), inputPath), "utf8")
    : task;
  if (!input) {
    throw new Error("Missing --task or --input for capability gap orchestration.");
  }
  const report = buildCapabilityGapOrchestration(input);
  if (!stdoutOnly) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: report.status,
        gaps: report.capabilityGaps.length,
        groups: report.groupedGaps.length,
        boardMode: report.orchestrationTaskBoardPacket.boardMode,
        outputMode: stdoutOnly ? "stdout-only" : "file",
        report: stdoutOnly ? null : outputPath.replace(/\\/g, "/"),
        workerTaskPackets: report.workerTaskPackets.map((packet) => ({
          laneId: packet.businessFlowLaneId,
          laneLabel: packet.businessFlowLaneLabel,
          owner: packet.owner,
          projectAgentId: packet.projectAgentId,
          ownerMode: packet.ownerMode,
          executionMode: packet.executionMode,
          workerInstanceMode: packet.workerInstanceMode,
          durableIdentityStatus: packet.durableIdentityStatus,
          capabilityProfileId: packet.capabilityLoadout?.capabilityProfileId ?? null,
          fixedForRun: packet.capabilityLoadout?.fixedForRun ?? false,
          runtimeSkillCandidates: packet.capabilityLoadout?.runtimeSkillCandidates ?? [],
          runtimeMcpCandidates: packet.capabilityLoadout?.runtimeMcpCandidates ?? [],
          commands: packet.capabilityLoadout?.commands ?? [],
          externalEvidenceRequired:
            report.projectAgentBlueprintPacket.agents.find(
              (agent) => agent.projectAgentId === packet.projectAgentId
            )?.externalEvidencePolicy?.required ?? false,
          localBaselineRequired:
            report.projectAgentBlueprintPacket.agents.find(
              (agent) => agent.projectAgentId === packet.projectAgentId
            )?.localBaselineComparison?.required ?? false,
          knowledgeGraphEquipped:
            report.projectAgentBlueprintPacket.agents.find(
              (agent) => agent.projectAgentId === packet.projectAgentId
            )?.knowledgeGraphPolicy?.equipped ?? false,
          savedIn: packet.roleSoulPolicy?.savedIn ?? null,
        })),
        projectAgentBlueprintPacket: {
          agentCount: report.projectAgentBlueprintPacket.agents.length,
          agentIds: report.projectAgentBlueprintPacket.agents.map((agent) => agent.projectAgentId),
          externalEvidenceRequiredAgentIds: report.projectAgentBlueprintPacket.agents
            .filter((agent) => agent.externalEvidencePolicy?.required)
            .map((agent) => agent.projectAgentId),
          localBaselineRequiredAgentIds: report.projectAgentBlueprintPacket.agents
            .filter((agent) => agent.localBaselineComparison?.required)
            .map((agent) => agent.projectAgentId),
          knowledgeGraphEquippedAgentIds: report.projectAgentBlueprintPacket.agents
            .filter((agent) => agent.knowledgeGraphPolicy?.equipped)
            .map((agent) => agent.projectAgentId),
        },
        reviewChecks: {
          dynamicProjectAgentsAreSynthesizedAndPinned:
            report.reviewResult.checks.dynamicProjectAgentsAreSynthesizedAndPinned,
          dynamicProjectAgentsHaveEvidencePolicies:
            report.reviewResult.checks.dynamicProjectAgentsHaveEvidencePolicies,
          dynamicProjectAgentsHaveGraphPolicies:
            report.reviewResult.checks.dynamicProjectAgentsHaveGraphPolicies,
          dynamicLanesHaveLoadoutAndSoulPolicy:
            report.reviewResult.checks.dynamicLanesHaveLoadoutAndSoulPolicy,
          workerTasksDeclareExecutionMode:
            report.reviewResult.checks.workerTasksDeclareExecutionMode,
          executionWorkersAreNotSidecars:
            report.reviewResult.checks.executionWorkersAreNotSidecars,
        },
      },
      null,
      2
    )}\n`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
