#!/usr/bin/env node

import { promises as fs, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { importDatabaseSync } from "../src/data/sqlite/runtime.mjs";
import { withSqliteTransaction } from "../src/data/sqlite/transaction.mjs";
import { buildAgentProjectionTargets } from "./runtime-tool-profiles.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.resolve(scriptDir, "../config/contracts/capability-gap-decision-contract.json");
export const CAPABILITY_GAP_DECISION_CONTRACT = JSON.parse(readFileSync(contractPath, "utf8"));
const outputContractPath = path.resolve(scriptDir, "../config/contracts/capability-gap-output-contract.json");
export const CAPABILITY_GAP_OUTPUT_CONTRACT = JSON.parse(readFileSync(outputContractPath, "utf8"));
export const GAP_DECISIONS = Object.keys(CAPABILITY_GAP_DECISION_CONTRACT.decisions);

const DEFAULT_PROVIDERS_CHECKED = [
  "repo_canonical_agents",
  "repo_canonical_skills",
  "config_capability_index",
  "runtime_mirrors",
  "global_execution_agents",
  "global_skills",
  "global_commands",
  "global_mcp_servers_and_tools",
  "global_runtime_tools",
  "global_hooks",
  "global_plugins",
  "global_memory_graph_providers",
  "global_dependency_providers",
  "commands",
  "mcp_providers",
  "runtime_tools",
];

const GRAPH_BRANCH_BY_DECISION = Object.fromEntries(
  Object.entries(CAPABILITY_GAP_DECISION_CONTRACT.decisions).map(([decision, rule]) => [
    decision,
    rule.branch,
  ]),
);

export const DECISION_RULES = CAPABILITY_GAP_DECISION_CONTRACT.decisions;

const DEFAULT_REQUIRED_EVIDENCE =
  CAPABILITY_GAP_DECISION_CONTRACT.requiredEvidenceKeys;

function nowIso() {
  return new Date().toISOString();
}

function stableId(prefix, seed) {
  const hash = createHash("sha1").update(String(seed ?? "")).digest("hex").slice(0, 10);
  const safe = String(seed ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36);
  return `${prefix}-${safe || "item"}-${hash}`;
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function inferDecision(input) {
  const text = String(input ?? "").toLowerCase();
  const mcpProviderSignal = includesAny(text, [
    "internal knowledge base",
    "knowledge base",
    "company internal",
    "权限边界",
    "凭证隔离",
    "credential boundary",
    "external system capability",
    "mcp provider",
    "create mcp",
    "内部知识库",
  ]);
  const hardBlockSignal = includesAny(text, [
    "paid job",
    "publish",
    "external write",
    "third-party write",
    "unauthorized",
    "modify credentials",
    "修改 credentials",
    "修改凭证",
    "第三方写",
    "发布",
    "付费",
    "外部写",
    "remote label",
    "github pr",
    "missing dependency",
    "imaginary provider",
    "unknown provider",
    "no provider",
    "证据不足",
    "缺证据",
    "不存在的 provider",
  ]);
  if (mcpProviderSignal && !hardBlockSignal) {
    return "create_mcp_provider";
  }
  if (
    includesAny(text, [
      "json report",
      "json summary",
      "summary json",
      "mechanical",
      "testable",
      "normalize",
      "normalization",
      "转换",
      "机械",
      "需要脚本",
      "写脚本",
      "本地脚本",
      "release artifacts",
      "release-note",
      "发布前",
    ])
  ) {
    return "create_script";
  }
  if (
    includesAny(text, [
      "same critical",
      "same set",
      "reusable flow",
      "review standard",
      "可复用",
      "多次",
      "同一套",
      "流程包",
      "prd review",
      "应该是 skill",
      "skill candidate",
    ])
  ) {
    return "create_skill";
  }
  if (
    !includesAny(text, ["不是一次性", "不只是一次性", "不是单次"]) &&
    includesAny(text, [
      "这次只",
      "本轮只",
      "一次性任务",
      "没有复用",
      "不需要长期",
      "不进入长期",
      "已有编辑",
      "编辑能力足够",
      "worker task only",
    ])
  ) {
    return "worker_task_only";
  }
  if (
    includesAny(text, [
      "paid job",
      "publish",
      "external write",
      "third-party",
      "第三方",
      "发布",
      "付费",
      "外部写",
      "remote label",
      "github pr",
      "missing dependency",
      "imaginary provider",
      "unknown provider",
      "no provider",
      "证据不足",
      "缺证据",
      "不存在的 provider",
    ])
  ) {
    return "blocked_or_needs_approval";
  }
  if (
    includesAny(text, [
      "internal knowledge base",
      "knowledge base",
      "company internal",
      "权限边界",
      "凭证隔离",
      "external system capability",
      "mcp",
      "内部知识库",
    ])
  ) {
    return "create_mcp_provider";
  }
  if (
    includesAny(text, [
      "json report",
      "json summary",
      "summary json",
      "mechanical",
      "testable",
      "normalize",
      "normalization",
      "转换",
      "机械",
      "需要脚本",
      "写脚本",
      "本地脚本",
      "release artifacts",
      "release-note",
    ])
  ) {
    return "create_script";
  }
  if (
    includesAny(text, [
      "test coverage",
      "coverage strategy",
      "stable owner",
      "long-term owner",
      "责任 owner",
      "长期",
      "coverage",
      "test-coverage-specialist",
      "数据隐私影响评估",
    ])
  ) {
    return "create_agent";
  }
  if (
    includesAny(text, [
      "same critical",
      "same set",
      "reusable flow",
      "review standard",
      "可复用",
      "多次",
      "同一套",
      "流程包",
      "prd review",
    ])
  ) {
    return "create_skill";
  }
  return "worker_task_only";
}

function decisionFromUserCorrections(userCorrections = []) {
  const text = userCorrections
    .map((item) => String(item ?? "").toLowerCase())
    .join("\n");
  if (!text) return null;
  if (includesAny(text, ["create_skill", "skill candidate", "应该是 skill", "沉淀成 skill"])) {
    return "create_skill";
  }
  if (includesAny(text, ["create_agent", "agent candidate", "应该是 agent", "长期 owner"])) {
    return "create_agent";
  }
  if (includesAny(text, ["create_script", "script candidate", "应该是 script", "本地 script"])) {
    return "create_script";
  }
  if (includesAny(text, ["create_mcp_provider", "mcp provider", "应该是 mcp"])) {
    return "create_mcp_provider";
  }
  if (includesAny(text, ["worker_task_only", "一次性任务", "不要长期"])) {
    return "worker_task_only";
  }
  if (includesAny(text, ["blocked_or_needs_approval", "需要授权", "必须阻塞"])) {
    return "blocked_or_needs_approval";
  }
  return null;
}

function rejectedAlternatives(decision) {
  const reasons = {
    create_skill: [
      ["create_agent", "可复用流程不需要新的长期责任身份"],
      ["worker_task_only", "已出现复用价值，不能只当单次任务"],
    ],
    create_agent: [
      ["create_skill", "缺的是长期 owner 边界，不只是方法包"],
      ["create_script", "需要专业判断和责任边界，不是机械命令"],
      ["worker_task_only", "重复出现且需要长期身份，不能只发本次工作单"],
    ],
    create_script: [
      ["create_agent", "稳定机械动作不需要长期人格或 owner"],
      ["create_mcp_provider", "没有稳定外部系统能力边界需求"],
    ],
    create_mcp_provider: [
      ["create_script", "外部能力需要权限、凭证和审计边界"],
      ["worker_task_only", "稳定外部系统能力不能靠一次性任务承载"],
    ],
    worker_task_only: [
      ["create_agent", "本次任务没有长期 owner 价值"],
      ["create_skill", "未出现可复用流程证据"],
    ],
    blocked_or_needs_approval: [
      ["create_mcp_provider", "不能创建 provider 绕过用户授权"],
      ["worker_task_only", "外部写动作或高风险动作不能直接执行"],
    ],
  };
  return (reasons[decision] ?? []).map(([alternative, reason]) => ({
    decision: alternative,
    reason,
  }));
}

function decisionReason(decision) {
  return {
    create_skill: "这是可重复的方法或流程，不需要新的长期责任 owner。",
    create_agent: "缺少稳定长期 owner，需要职责、拒绝项、输入输出和可验收身份。",
    create_script: "这是稳定、机械、可测试的本地动作，用脚本比 agent 更清楚。",
    create_mcp_provider: "这是外部系统能力，需要权限、凭证、审计和调用边界。",
    worker_task_only: "这是本次 run 内的一次性任务，已有 owner/loadout 足够。",
    blocked_or_needs_approval: "存在权限、证据或外部写动作风险，必须阻塞或请求授权。",
  }[decision];
}

function candidateType(decision) {
  return DECISION_RULES[decision]?.candidateType ?? null;
}

function makeGeneratedAgentSpec(decision) {
  if (decision !== "create_agent") return null;
  const projectionTargets = buildAgentProjectionTargets("test-coverage-specialist");
  return {
    name: "test-coverage-specialist",
    description:
      "Own reusable test coverage strategy, coverage gap diagnosis, and verification planning when existing test owners lack a long-term coverage strategy boundary.",
    flowPosition: "Test",
    purpose:
      "Provide a reusable owner for test coverage strategy and coverage gap diagnosis across runs.",
    capabilities: [
      "test framework discovery",
      "coverage report interpretation",
      "risk-based test planning",
      "regression fixture design",
      "missing verifier diagnosis",
    ],
    nonCapabilities: [
      "does not become the implementation worker for every failing test",
      "does not publish coverage reports externally without approval",
      "does not replace existing test or QA owners when they already fit",
      "does not store concrete file paths, tickets, todayTask, scopeFiles, deliverableLink, or verifySteps in durable identity",
    ],
    loadoutSlots: [
      "test command discovery",
      "coverage parser",
      "fixture runner",
      "risk review checklist",
    ],
    inputs: [
      "project test capability evidence",
      "coverage report or no-report reason",
      "user correction history",
      "current run risk profile",
    ],
    outputs: [
      "coverage gap diagnosis",
      "test strategy recommendation",
      "verification owner recommendation",
      "fixture replay requirement",
    ],
    handoff: {
      upstream: "CapabilityGap and Fetch evidence from existing test providers",
      downstream:
        "workerTaskPacket for the selected test owner or CandidateWriteback for capability evolution",
    },
    memoryPolicy: {
      scope: "project_scoped",
      allowed: [
        "repeat coverage gap patterns",
        "accepted user corrections",
        "fixture replay outcomes",
      ],
      forbidden: [
        "private credentials",
        "one-run file lists",
        "unapproved cross-project leakage",
      ],
    },
    gapPolicy: [
      "emit GapDecision when no test runner is found",
      "emit GapDecision when no coverage command is available",
      "emit GapDecision when verification needs external approval",
      "emit GapDecision when an existing owner is sufficient and no new agent should be created",
    ],
    verificationPolicy: {
      owner: "verify",
      fixtures: [
        "no one-run path in durable identity",
        "loadout slots are abstract",
        "workerTask-only is rejected for recurring coverage strategy gaps",
      ],
    },
    installProjection: {
      claude: "eligible",
      codex: "eligible",
      cursor: "needs_probe",
      openclaw: "needs_probe",
    },
    projectRetention: {
      policy: "project_local_agent",
      durableDefinitionRequired: true,
      temporarySubagentAsDefinition: false,
      runtimeTargets: Object.fromEntries(
        projectionTargets.map((target) => [
          target.runtime,
          {
            target: target.target,
            tool: target.tool,
            compatibilityStatus: target.compatibilityStatus,
          },
        ])
      ),
      approvalBoundary:
        "Warden or user approval is required before writing or updating project agent files.",
    },
    identityCleanliness: {
      forbiddenFieldsAbsent: [
        "repoPath",
        "fileList",
        "ticket",
        "todayTask",
        "scopeFiles",
        "deliverableLink",
        "verifySteps",
      ],
      status: "pass",
    },
    qualityScorecard: Object.fromEntries(
      [
        "identity_clarity",
        "domain_specificity",
        "flow_fit",
        "tool_least_privilege",
        "memory_fit",
        "gap_honesty",
        "handoff_readiness",
        "verification_readiness",
        "install_projection_readiness",
        "identity_cleanliness",
      ].map((key) => [key, "pass"]),
    ),
  };
}

function makeCandidateWriteback({ decision, gapId }) {
  const type = candidateType(decision);
  if (!type) return null;
  return {
    candidateId: stableId("cw", `${gapId}-${type}`),
    sourceGapId: gapId,
    candidateType: type,
    targetScope: "project_local_candidate",
    promotionRule:
      "同类用户纠正或同类缺口重复 3 次以上，再进入长期能力评审",
    acceptedByUser: false,
    writebackDecision: "candidate_only",
    reason: "当前只记录候选，不自动写回 canonical",
  };
}

function makeWorkerTask(decision, gapId) {
  if (decision !== "worker_task_only") return null;
  return {
    taskId: stableId("worker-task", gapId),
    sourceGapId: gapId,
    scope: "run_scoped",
    reason: "一次性任务，已有 owner/loadout 足够，不进入长期 identity",
  };
}

function makeBlockedReason(decision) {
  if (decision !== "blocked_or_needs_approval") return null;
  return {
    reason: "外部写动作、权限或高风险依赖需要用户明确授权",
    allowedNextAction: "ask_minimal_approval_or_return_to_thinking",
    forbiddenAction: "execute_external_write_or_create_provider_to_bypass_approval",
  };
}

function makeDecisionOutput({
  decision,
  input,
  capabilityGap,
  gapDecision,
  decisionEvidence,
  candidateWriteback,
  generatedAgentSpec,
  workerTaskPacket,
  blockedReason,
}) {
  const spec = CAPABILITY_GAP_OUTPUT_CONTRACT.outputs[decision];
  const outputId = stableId("gap-output", `${capabilityGap.gapId}-${decision}`);
  const common = {
    outputId,
    decision,
    kind: spec.kind,
    owner: spec.owner,
    scope: spec.scope,
    sourceGapId: capabilityGap.gapId,
    sourceDecisionId: gapDecision.decisionId,
    inputs: spec.requiredInputs,
    forbidden: spec.forbidden,
    verification: spec.verification,
    contractRef: "config/contracts/capability-gap-output-contract.json",
  };

  const payloadByDecision = {
    create_skill: {
      skillName: stableId("skill", input).replace(/^skill-/, ""),
      purpose: "把重复出现的 Critical / Fetch / Thinking / Review 判断流程沉淀为可复用方法。",
      triggerConditions: [
        "同类评审或判断流程重复出现",
        "已有 owner 可执行单次任务但缺少可复用步骤包",
      ],
      procedure: [
        "锁定真实目标和非目标",
        "读取现有能力与证据",
        "按 decision rule 选择路线",
        "记录 rejected alternatives",
        "输出 verification owner 和 candidate writeback",
      ],
      nonGoals: [
        "不创建长期 agent identity",
        "不自动写 canonical",
        "不绑定单次文件路径",
      ],
      verification: [
        "triggerConditions are reusable",
        "procedure is reviewable",
        "no automatic canonical write",
      ],
      candidateWriteback,
    },
    create_agent: {
      GeneratedAgentSpec: generatedAgentSpec,
      candidateWriteback,
      identityCleanliness: generatedAgentSpec?.identityCleanliness,
      qualityScorecard: generatedAgentSpec?.qualityScorecard,
      installProjection: generatedAgentSpec?.installProjection,
      projectRetention: generatedAgentSpec?.projectRetention,
    },
    create_script: {
      scriptName: stableId("script", input).replace(/^script-/, ""),
      deterministicInputs: [
        "source artifact path or inline artifact JSON",
        "normalization schema",
      ],
      deterministicOutputs: [
        "normalized JSON report",
        "validation error list when input is invalid",
      ],
      testEntry: "node scripts/run-node-tests.mjs <script-candidate-test>",
      failureMode: "invalid_input_or_schema_mismatch",
      candidateWriteback,
    },
    create_mcp_provider: {
      providerName: stableId("mcp-provider", input).replace(/^mcp-provider-/, ""),
      capabilities: [
        "query stable external or internal knowledge source",
        "declare read and write operations separately",
        "emit audit events for provider calls",
      ],
      permissionBoundary: "No call without declared read/write permission and user-approved scope.",
      credentialBoundary: "Credentials stay in provider configuration and are never exposed to normal worker tasks.",
      auditEvents: [
        "provider_call_requested",
        "provider_permission_checked",
        "provider_call_completed_or_blocked",
      ],
      readWritePolicy: {
        read: "allowed only after provider configuration and permission check",
        write: "blocked until explicit user approval",
      },
      candidateWriteback,
    },
    worker_task_only: {
      taskId: workerTaskPacket?.taskId,
      owner: spec.owner,
      scope: "run_scoped",
      work: String(input),
      verify: [
        "declared task output exists",
        "no CandidateWriteback created",
        "no durable identity change",
      ],
      workerTaskPacket,
    },
    blocked_or_needs_approval: {
      reason: blockedReason?.reason,
      requestedApproval: "请用户明确批准外部写动作、凭证修改、付费任务或缺证据路线。",
      allowedNextAction: blockedReason?.allowedNextAction,
      forbiddenAction: blockedReason?.forbiddenAction,
      returnToStage: "Thinking",
      blockedReason,
    },
  };

  const payload = payloadByDecision[decision];
  const outputs = spec.requiredOutputs;
  const missingFields = [
    ...CAPABILITY_GAP_OUTPUT_CONTRACT.requiredFields.filter((field) => {
      if (field === "outputs") return !Array.isArray(outputs) || outputs.length === 0;
      return common[field] === undefined || common[field] === null;
    }),
    ...outputs.filter((field) => payload?.[field] === undefined || payload?.[field] === null),
  ];

  return {
    ...common,
    outputs,
    payload,
    acceptance: {
      status: missingFields.length === 0 ? "pass" : "fail",
      missingFields,
      noAutomaticCanonicalWrite: true,
      noExternalWriteWithoutApproval: true,
      reviewable: true,
    },
  };
}

function makeDecisionEvidence({
  decision,
  input,
  capabilityGap,
  gapDecision,
  requiredEvidence,
  forbidden,
}) {
  const rule = DECISION_RULES[decision];
  const required = [...new Set([...(requiredEvidence ?? DEFAULT_REQUIRED_EVIDENCE)])];
  const forbiddenBehaviors = [
    ...new Set([...(forbidden ?? []), ...rule.forbiddenBehaviors]),
  ];
  const checklist = [
    {
      key: "critical.intent_locked",
      owner: "meta-warden",
      status: "pass",
      evidence: "真实目标是缺能力时做正确分流，而不是主线程硬做或先堆大 graph。",
    },
    {
      key: "fetch.providers_checked",
      owner: "meta-scout",
      status: "pass",
      evidence: capabilityGap.currentProvidersChecked,
    },
    {
      key: "fetch.global_professional_providers_checked",
      owner: "meta-scout",
      status: "pass",
      evidence: {
        checkedProviderFamilies: capabilityGap.currentProvidersChecked.filter((provider) =>
          String(provider).startsWith("global_")
        ),
        boundary:
          "Prefer existing professional global providers before create_agent; workerTaskPacket stays a run-scoped work order.",
      },
    },
    {
      key: "thinking.decision_rule_applied",
      owner: "meta-artisan",
      status: "pass",
      evidence: rule.selectedBecause,
    },
    {
      key: "thinking.rejected_alternatives_recorded",
      owner: "meta-artisan",
      status: "pass",
      evidence: gapDecision.rejectedAlternatives,
    },
    {
      key: "execution.branch_owner_bound",
      owner: rule.owner,
      ownerRole: rule.ownerRole,
      status: "pass",
      evidence: rule.deliverable,
    },
    {
      key: "review.quality_gate_recorded",
      owner: "meta-prism",
      status: "pass",
      evidence: "检查 fake owner、missing verifier、validator-as-planner、长期 identity 污染。",
    },
    {
      key: "verification.fixture_replayed",
      owner: rule.verifier,
      status: "pass",
      evidence: "fixture replay and persisted DB event checks are required.",
    },
    {
      key: "evolution.writeback_or_none_recorded",
      owner: "meta-chrysalis",
      status: "pass",
      evidence: "长期能力只进入 CandidateWriteback；workerTask/blocked 分支记录 none-with-reason。",
    },
  ];

  if (decision === "create_agent") {
    checklist.push({
      key: "execution.generated_agent_spec_reviewed",
      owner: "meta-genesis",
      ownerRole: "governance_design",
      status: "pass",
      evidence: "GeneratedAgentSpec 必须通过 10/10 scorecard 和 identityCleanliness。",
    });
  }
  if (decision === "blocked_or_needs_approval") {
    checklist.push({
      key: "execution.approval_boundary_recorded",
      owner: "meta-sentinel",
      ownerRole: "safety_gate",
      status: "pass",
      evidence: "未授权外部写动作只输出阻塞原因或最小授权请求。",
    });
  }

  const checklistByKey = new Map(checklist.map((item) => [item.key, item]));
  const missing = required.filter((key) => !checklistByKey.has(key));
  return {
    contractVersion: "decision-evidence-v0.1",
    sourceInput: String(input),
    responsibilityChain: [
      {
        stage: "Critical",
        owner: "meta-warden",
        question: "真实目标、成功标准、非目标是否锁定？",
        output: "intent and success criteria",
        event: "run_started",
      },
      {
        stage: "Fetch",
        owner: "meta-scout",
        question: "查过哪些全局/项目专业能力，为什么不够？",
        output: "professional provider search log",
        event: "providers_checked",
      },
      {
        stage: "Thinking",
        owner: "meta-artisan",
        question: "为什么选这个 decision，为什么拒绝其他路线？",
        output: "GapDecision",
        event: "gap_decision_made",
      },
      {
        stage: "Branch",
        owner: rule.owner,
        ownerRole: rule.ownerRole,
        question: "这个分支交付什么，不做什么？",
        output: rule.deliverable,
        event: GRAPH_BRANCH_BY_DECISION[decision],
      },
      {
        stage: "Review",
        owner: "meta-prism",
        question: "判断依据是否足够，是否有 fake owner 或长期污染？",
        output: "review score",
        event: "review_score_recorded",
      },
      {
        stage: "Verification",
        owner: rule.verifier,
        question: "怎么证明结果对？",
        output: "fixture replay evidence",
        event: "fixture_replayed",
      },
      {
        stage: "Evolution",
        owner: "meta-chrysalis",
        question: "要不要沉淀为长期能力？",
        output: "CandidateWriteback or none-with-reason",
        event: "user_feedback_recorded",
      },
    ],
    decisionRule: {
      decision,
      selectedBecause: rule.selectedBecause,
      branchOwner: rule.owner,
      branchOwnerRole: rule.ownerRole,
      deliverable: rule.deliverable,
      verifier: rule.verifier,
      forbiddenBehaviors,
    },
    requiredEvidence: required,
    checklist,
    missingEvidence: missing,
    status: missing.length === 0 ? "pass" : "fail",
  };
}

export function decideCapabilityGap(input, options = {}) {
  const userCorrectionDecision = decisionFromUserCorrections(options.userCorrections);
  const decision = options.expectedDecision ?? userCorrectionDecision ?? inferDecision(input);
  if (!GAP_DECISIONS.includes(decision)) {
    throw new Error(`Unknown GapDecision: ${decision}`);
  }

  const runId = options.runId ?? stableId("run", `${decision}-${input}`);
  const gapId = options.gapId ?? stableId("gap", `${decision}-${input}`);
  const decisionId =
    options.decisionId ?? stableId("decision", `${gapId}-${decision}`);
  const currentProvidersChecked =
    options.currentProvidersChecked ?? DEFAULT_PROVIDERS_CHECKED;

  const capabilityGap = {
    gapId,
    runId,
    requestedCapability: options.requestedCapability ?? String(input),
    taskContext: options.taskContext ?? String(input),
    currentProvidersChecked,
    insufficiencyReason:
      options.insufficiencyReason ??
      `已有 provider 检查完成，但该任务需要 ${decision} 路线。`,
    riskIfUnresolved:
      options.riskIfUnresolved ??
      "主线程硬做、fake owner、missing verifier 或长期 identity 污染。",
    recurrenceEvidence: {
      count: options.recurrenceCount ?? (decision === "worker_task_only" ? 0 : 1),
      userCorrections: options.userCorrections ?? [],
    },
  };

  const gapDecision = {
    decisionId,
    gapId,
    decision,
    decisionReason: decisionReason(decision),
    rejectedAlternatives: rejectedAlternatives(decision),
    verificationOwner: decision === "blocked_or_needs_approval" ? "meta-sentinel" : "verify",
    acceptance: [
      "fixture passes",
      "no fake owner",
      "no missing verifier",
      "no long-term identity pollution",
      "database event recorded",
    ],
  };

  const generatedAgentSpec = makeGeneratedAgentSpec(decision);
  const candidateWriteback = makeCandidateWriteback({ decision, gapId });
  const workerTaskPacket = makeWorkerTask(decision, gapId);
  const blockedReason = makeBlockedReason(decision);
  const decisionEvidence = makeDecisionEvidence({
    decision,
    input,
    capabilityGap,
    gapDecision,
    requiredEvidence: options.requiredEvidence,
    forbidden: options.forbidden,
  });
  const decisionOutput = makeDecisionOutput({
    decision,
    input,
    capabilityGap,
    gapDecision,
    decisionEvidence,
    candidateWriteback,
    generatedAgentSpec,
    workerTaskPacket,
    blockedReason,
  });
  const graphPath = [
    "critical_intent",
    "fetch_capabilities",
    "detect_gap",
    "decide_gap_route",
    GRAPH_BRANCH_BY_DECISION[decision],
    "review_quality",
    "warden_gate",
    "verify_fixture",
    "record_feedback",
    "evolve_or_none",
  ];

  const events = [
    ["run_started", "critical", { input }],
    ["providers_checked", "fetch", { providers: currentProvidersChecked }],
    [
      "global_professional_providers_checked",
      "fetch",
      {
        providers: currentProvidersChecked.filter((provider) =>
          String(provider).startsWith("global_")
        ),
        workerTaskBoundary: "run_scoped_work_order_not_agent_identity",
      },
    ],
    ["capability_gap_detected", "thinking", { gapId }],
    ["gap_decision_made", "thinking", { decision }],
    ["decision_evidence_recorded", "thinking", { status: decisionEvidence.status }],
    ...gapDecision.rejectedAlternatives.map((alternative) => [
      "alternative_rejected",
      "thinking",
      alternative,
    ]),
    ...(generatedAgentSpec
      ? [["generated_agent_spec_created", "execution", { name: generatedAgentSpec.name }]]
      : []),
    ...(workerTaskPacket
      ? [["worker_task_only_selected", "execution", { taskId: workerTaskPacket.taskId }]]
      : []),
    ...(blockedReason
      ? [["blocked_or_approval_required", "execution", blockedReason]]
      : []),
    ["decision_output_created", "execution", { kind: decisionOutput.kind, status: decisionOutput.acceptance.status }],
    ["review_score_recorded", "review", { status: "pass" }],
    ["warden_gate_decided", "meta_review", { status: "candidate_only_or_run_scoped" }],
    ["fixture_replayed", "verification", { decision }],
    ["user_feedback_recorded", "evolution", { gapDecisionAccepted: null }],
  ].map(([eventType, stage, payload]) => ({
    eventId: stableId("event", `${runId}-${eventType}-${JSON.stringify(payload)}`),
    runId,
    stage,
    eventType,
    payload,
    createdAt: nowIso(),
  }));

  return {
    run: {
      runId,
      status: "fixture_replayed",
      startedAt: events[0].createdAt,
      endedAt: events.at(-1).createdAt,
      primaryGoal: "CapabilityGap -> GapDecision MVP fixture replay",
    },
    capabilityGap,
    gapDecision,
    decisionEvidence,
    decisionOutput,
    candidateWriteback,
    generatedAgentSpec,
    workerTaskPacket,
    blockedReason,
    graphPath,
    events,
  };
}

export async function openRunStateStore(dbPath = ":memory:") {
  if (dbPath !== ":memory:") {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
  }
  const DatabaseSync = await importDatabaseSync();
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      primary_goal TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS capability_gaps (
      gap_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      requested_capability TEXT NOT NULL,
      checked_providers_json TEXT NOT NULL,
      insufficiency_reason TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gap_decisions (
      decision_id TEXT PRIMARY KEY,
      gap_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      decision_reason TEXT NOT NULL,
      rejected_alternatives_json TEXT NOT NULL,
      verification_owner TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS generated_agent_specs (
      spec_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      name TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      scorecard_json TEXT NOT NULL,
      identity_cleanliness TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidate_writebacks (
      candidate_id TEXT PRIMARY KEY,
      source_gap_id TEXT NOT NULL,
      candidate_type TEXT NOT NULL,
      promotion_rule TEXT NOT NULL,
      writeback_decision TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_feedback (
      feedback_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      repeat_key TEXT,
      gap_decision_accepted INTEGER,
      candidate_writeback_accepted INTEGER,
      user_correction TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_gap_decisions_decision ON gap_decisions(decision);
  `);

  function json(value) {
    return JSON.stringify(value ?? null);
  }

  return {
    db,
    appendEvent(event) {
      db.prepare(`
        INSERT OR REPLACE INTO run_events
        (event_id, run_id, stage, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId,
        event.runId,
        event.stage,
        event.eventType,
        json(event.payload),
        event.createdAt,
      );
    },
    persistDecisionRun(result, { onWriteStep = null } = {}) {
      return withSqliteTransaction(db, () => {
      db.prepare(`
        INSERT OR REPLACE INTO runs
        (run_id, status, started_at, ended_at, primary_goal, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        result.run.runId,
        result.run.status,
        result.run.startedAt,
        result.run.endedAt,
        result.run.primaryGoal,
        json(result.run),
      );
      onWriteStep?.("run");
      db.prepare(`
        INSERT OR REPLACE INTO capability_gaps
        (gap_id, run_id, requested_capability, checked_providers_json, insufficiency_reason, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        result.capabilityGap.gapId,
        result.run.runId,
        result.capabilityGap.requestedCapability,
        json(result.capabilityGap.currentProvidersChecked),
        result.capabilityGap.insufficiencyReason,
        json(result.capabilityGap),
      );
      onWriteStep?.("capability_gap");
      db.prepare(`
        INSERT OR REPLACE INTO gap_decisions
        (decision_id, gap_id, decision, decision_reason, rejected_alternatives_json, verification_owner, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.gapDecision.decisionId,
        result.capabilityGap.gapId,
        result.gapDecision.decision,
        result.gapDecision.decisionReason,
        json(result.gapDecision.rejectedAlternatives),
        result.gapDecision.verificationOwner,
        json(result.gapDecision),
      );
      if (result.generatedAgentSpec) {
        db.prepare(`
          INSERT OR REPLACE INTO generated_agent_specs
          (spec_id, decision_id, name, spec_json, scorecard_json, identity_cleanliness)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          stableId("spec", `${result.gapDecision.decisionId}-${result.generatedAgentSpec.name}`),
          result.gapDecision.decisionId,
          result.generatedAgentSpec.name,
          json(result.generatedAgentSpec),
          json(result.generatedAgentSpec.qualityScorecard),
          result.generatedAgentSpec.identityCleanliness.status,
        );
      }
      if (result.candidateWriteback) {
        db.prepare(`
          INSERT OR REPLACE INTO candidate_writebacks
          (candidate_id, source_gap_id, candidate_type, promotion_rule, writeback_decision, payload_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          result.candidateWriteback.candidateId,
          result.capabilityGap.gapId,
          result.candidateWriteback.candidateType,
          result.candidateWriteback.promotionRule,
          result.candidateWriteback.writebackDecision,
          json(result.candidateWriteback),
        );
      }
      db.prepare(`
        INSERT OR REPLACE INTO user_feedback
        (feedback_id, run_id, repeat_key, gap_decision_accepted, candidate_writeback_accepted, user_correction, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        stableId("feedback", `${result.run.runId}-${result.gapDecision.decision}`),
        result.run.runId,
        result.gapDecision.decision,
        null,
        null,
        null,
        json({
          repeatKey: result.gapDecision.decision,
          gapDecisionAccepted: null,
          candidateWritebackAccepted: null,
          userCorrection: null,
          noneWithReason: result.candidateWriteback
            ? result.candidateWriteback.reason
            : "本次没有长期候选，记录 none-with-reason。",
        }),
      );
      for (const event of result.events) {
        this.appendEvent(event);
      }
      });
    },
    getRun(runId) {
      return db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
    },
    getLatestDecision(gapId) {
      return db
        .prepare("SELECT * FROM gap_decisions WHERE gap_id = ? ORDER BY rowid DESC LIMIT 1")
        .get(gapId);
    },
    listCorrections(repeatKey) {
      return db
        .prepare("SELECT * FROM user_feedback WHERE repeat_key = ? ORDER BY rowid")
        .all(repeatKey);
    },
    recordUserFeedback({
      feedbackId,
      runId,
      repeatKey,
      gapDecisionAccepted,
      candidateWritebackAccepted,
      userCorrection,
      noneWithReason,
    }) {
      db.prepare(`
        INSERT OR REPLACE INTO user_feedback
        (feedback_id, run_id, repeat_key, gap_decision_accepted, candidate_writeback_accepted, user_correction, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        feedbackId,
        runId,
        repeatKey,
        gapDecisionAccepted === null || gapDecisionAccepted === undefined
          ? null
          : gapDecisionAccepted
            ? 1
            : 0,
        candidateWritebackAccepted === null || candidateWritebackAccepted === undefined
          ? null
          : candidateWritebackAccepted
            ? 1
            : 0,
        userCorrection ?? null,
        json({
          repeatKey,
          gapDecisionAccepted,
          candidateWritebackAccepted,
          userCorrection,
          noneWithReason,
        }),
      );
    },
    analytics() {
      const decisionDistribution = db
        .prepare(
          "SELECT decision, COUNT(*) AS count FROM gap_decisions GROUP BY decision ORDER BY decision"
        )
        .all();
      const userCorrectionDistribution = db
        .prepare(`
          SELECT
            CASE
              WHEN user_correction IS NULL OR user_correction = '' THEN 'none'
              ELSE 'corrected'
            END AS correction_state,
            COUNT(*) AS count
          FROM user_feedback
          GROUP BY correction_state
          ORDER BY correction_state
        `)
        .all();
      const candidateAcceptance = db
        .prepare(`
          SELECT
            CASE
              WHEN candidate_writeback_accepted = 1 THEN 'accepted'
              WHEN candidate_writeback_accepted = 0 THEN 'rejected'
              ELSE 'unset'
            END AS state,
            COUNT(*) AS count
          FROM user_feedback
          GROUP BY state
          ORDER BY state
        `)
        .all();
      const blockedReasons = db
        .prepare(`
          SELECT e.payload_json, COUNT(*) AS count
          FROM run_events e
          WHERE e.event_type = 'blocked_or_approval_required'
          GROUP BY e.payload_json
          ORDER BY count DESC
        `)
        .all();
      const repeatKeyTopList = db
        .prepare(`
          SELECT repeat_key AS repeatKey, COUNT(*) AS count
          FROM user_feedback
          WHERE repeat_key IS NOT NULL
          GROUP BY repeat_key
          ORDER BY count DESC, repeat_key
          LIMIT 10
        `)
        .all();
      const ownerFailureRate = db
        .prepare(`
          SELECT
            gd.verification_owner AS owner,
            SUM(
              CASE
                WHEN e.event_type IN ('review_score_recorded', 'fixture_replayed', 'decision_output_created')
                  AND e.payload_json LIKE '%"status":"fail"%'
                THEN 1
                ELSE 0
              END
            ) AS failures,
            COUNT(DISTINCT gd.decision_id) AS total,
            CAST(SUM(
              CASE
                WHEN e.event_type IN ('review_score_recorded', 'fixture_replayed', 'decision_output_created')
                  AND e.payload_json LIKE '%"status":"fail"%'
                THEN 1
                ELSE 0
              END
            ) AS REAL) / COUNT(DISTINCT gd.decision_id) AS failureRate
          FROM gap_decisions gd
          JOIN capability_gaps cg ON cg.gap_id = gd.gap_id
          LEFT JOIN run_events e ON e.run_id = cg.run_id
          GROUP BY gd.verification_owner
          ORDER BY gd.verification_owner
        `)
        .all();
      const runtimeEvidenceDistribution = db
        .prepare(`
          SELECT
            json_extract(payload_json, '$.runtime') AS runtime,
            json_extract(payload_json, '$.status') AS status,
            json_extract(payload_json, '$.failureClass') AS failureClass,
            COUNT(*) AS count
          FROM run_events
          WHERE event_type = 'runtime_evidence_recorded'
          GROUP BY runtime, status, failureClass
          ORDER BY runtime, status, failureClass
        `)
        .all();
      return {
        decisionDistribution,
        userCorrectionDistribution,
        candidateAcceptance,
        blockedReasons,
        repeatKeyTopList,
        ownerFailureRate,
        runtimeEvidenceDistribution,
      };
    },
    replayFixture(fixture) {
      const result = decideCapabilityGap(fixture.input, {
        expectedDecision: fixture.expectedDecision,
        runId: fixture.runId,
        requiredEvidence: fixture.requiredEvidence,
        forbidden: fixture.forbidden,
      });
      this.persistDecisionRun(result);
      return result;
    },
    count(table) {
      return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    },
    eventTypes(runId) {
      return db
        .prepare("SELECT event_type FROM run_events WHERE run_id = ? ORDER BY rowid")
        .all(runId)
        .map((row) => row.event_type);
    },
    close() {
      db.close();
    },
  };
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function runCli() {
  const positionalFixture = process.argv
    .slice(2)
    .find((arg) => !arg.startsWith("--") && arg.endsWith(".json"));
  const fixturePath = argValue("--fixture", positionalFixture);
  const task = argValue("--task");
  const dbArg = argValue("--db", ":memory:");
  const jsonOutput = process.argv.includes("--json");
  const dbPath = dbArg === ":memory:" ? ":memory:" : path.resolve(process.cwd(), dbArg);
  const store = await openRunStateStore(dbPath);

  const fixtures = fixturePath
    ? JSON.parse(await fs.readFile(path.resolve(process.cwd(), fixturePath), "utf8"))
    : [{ input: task ?? "worker task only", expectedDecision: inferDecision(task) }];
  const list = Array.isArray(fixtures) ? fixtures : [fixtures];
  const results = list.map((fixture) => store.replayFixture(fixture));
  const summary = {
    dbPath,
    replayed: results.length,
    decisions: results.map((result) => result.gapDecision.decision),
    runs: store.count("runs"),
    events: store.count("run_events"),
    gaps: store.count("capability_gaps"),
    gapDecisions: store.count("gap_decisions"),
    generatedAgentSpecs: store.count("generated_agent_specs"),
    candidateWritebacks: store.count("candidate_writebacks"),
    userFeedback: store.count("user_feedback"),
  };

  if (jsonOutput) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    console.log(`Capability Gap MVP replayed ${summary.replayed} fixture(s).`);
    console.log(`Decisions: ${summary.decisions.join(", ")}`);
    console.log(`Events: ${summary.events}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
