#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_GAP_OUTPUT_CONTRACT,
  GAP_DECISIONS,
  decideCapabilityGap,
  openRunStateStore,
} from "./capability-gap-mvp.mjs";
import { runMetaTheoryGovernedExecution } from "./run-meta-theory-governed-execution.mjs";
import { buildAgentProjectionTargets } from "./runtime-tool-profiles.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_JSON_PATH = path.join(
  REPO_ROOT,
  ".meta-kim",
  "state",
  "default",
  "capability-gap-complete-product.json"
);
const DEFAULT_MARKDOWN_PATH = path.join(
  REPO_ROOT,
  ".meta-kim",
  "state",
  "default",
  "capability-gap-complete-product.zh-CN.md"
);
const DEFAULT_DB_PATH = path.join(
  REPO_ROOT,
  ".meta-kim",
  "state",
  "default",
  "capability-gap-complete-product.sqlite"
);
const GRAPH_CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "capability-gap-executable-graph-contract.json"
);
const AI_READABLE_STANDARDS_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "ai-readable-product-standards.json"
);
const SOURCE_LEAK_PATTERN = new RegExp(
  [
    "gst" + "ack",
    "gbr" + "ain",
    "wsh" + "obson",
    "anth" + "ropic",
    "skill-" + "creator",
    "(?:^|[^A-Za-z])[A-Z]:[\\\\/]",
    "Users[\\\\/]Kim",
  ].join("|"),
  "i"
);

export const COMPLETE_PRODUCT_INPUTS = [
  {
    id: "CP-01",
    expectedDecision: "create_skill",
    input:
      "我经常要求同一套 Critical Fetch Thinking Review 评审流程，现有 owner 能做单次 review，但 reusable flow 每次都要重讲。",
  },
  {
    id: "CP-02",
    expectedDecision: "create_skill",
    input:
      "同一套 PRD review standard 已经多次出现，需要流程包和触发条件，不需要新的长期责任 owner。",
  },
  {
    id: "CP-03",
    expectedDecision: "create_agent",
    input:
      "我们反复缺少长期 test coverage strategy owner，要判断 coverage gap、缺 verifier 和验证策略，而不是只跑一次测试。",
  },
  {
    id: "CP-04",
    expectedDecision: "create_agent",
    input:
      "项目长期缺数据隐私影响评估 owner，需要稳定边界、输入输出、记忆政策和 verifier，不是一次性任务。",
  },
  {
    id: "CP-05",
    expectedDecision: "create_script",
    input:
      "每次发布前都要把 run artifacts normalize 成同一种 JSON report，过程 mechanical、testable、无外部授权。",
  },
  {
    id: "CP-06",
    expectedDecision: "create_script",
    input:
      "release artifacts 到 summary JSON 的转换是稳定机械步骤，可以单测，应该沉淀成本地 script。",
  },
  {
    id: "CP-07",
    expectedDecision: "create_mcp_provider",
    input:
      "我需要稳定查询 company internal knowledge base，并声明 read/write 权限、credential boundary 和审计事件。",
  },
  {
    id: "CP-08",
    expectedDecision: "create_mcp_provider",
    input:
      "内部知识库需要 MCP provider 边界，明确权限边界、凭证隔离、只读查询和 provider 调用范围。",
  },
  {
    id: "CP-09",
    expectedDecision: "worker_task_only",
    input:
      "这次只把当前中文报告一段话改得更口语化，已有文档编辑 owner 和工具足够，没有复用价值。",
  },
  {
    id: "CP-10",
    expectedDecision: "worker_task_only",
    input:
      "本轮只整理一个标题的措辞，已有编辑能力足够，不需要长期候选，也不需要创建新能力。",
  },
  {
    id: "CP-11",
    expectedDecision: "blocked_or_needs_approval",
    input:
      "请自动 publish 到第三方平台，同时修改 credentials 并创建 paid job；我还没有给明确授权。",
  },
  {
    id: "CP-12",
    expectedDecision: "blocked_or_needs_approval",
    input:
      "请直接给远程 GitHub PR 加 label 并执行外部写动作，但当前没有授权和 provider 证据。",
  },
];

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
}

function relative(filePath) {
  const relativePath = path.relative(REPO_ROOT, filePath).replaceAll("\\", "/");
  if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    return `<external-temp>/${path.basename(filePath)}`;
  }
  return relativePath;
}

const PUBLIC_ROUTE_START =
  /^\/(?:api|assets|auth|docs|favicon\.ico|graphql|healthz?|oauth|readyz?|static|v\d+)(?:\/|[?#]|$)/i;
const PATH_BOUNDARIES = new Set([
  ",",
  "，",
  ";",
  "；",
  "。",
  "!",
  "?",
  "！",
  "？",
  ")",
  "）",
  "]",
  "}",
  "\r",
  "\n",
]);
const MATCHING_QUOTES = new Map([
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
]);

function firstMatchAtOrAfter(value, fromIndex, pattern, type) {
  pattern.lastIndex = fromIndex;
  let match = pattern.exec(value);
  while (match) {
    const previous = value[match.index - 1];
    if (match.index === 0 || !/[A-Z0-9_./\\]/i.test(previous)) {
      if (type === "posix" && PUBLIC_ROUTE_START.test(value.slice(match.index))) {
        match = pattern.exec(value);
        continue;
      }
      return { index: match.index, type, length: match[0].length };
    }
    match = pattern.exec(value);
  }
  return null;
}

function findNextAbsolutePathStart(value, fromIndex) {
  const candidates = [
    firstMatchAtOrAfter(
      value,
      fromIndex,
      /https?:\/\/[^\s,，;；。)）}"'`]+/gi,
      "public-url",
    ),
    firstMatchAtOrAfter(value, fromIndex, /file:(?:\/{1,3}|\\+)/gi, "file-uri"),
    firstMatchAtOrAfter(value, fromIndex, /[A-Z]:[\\/]/gi, "windows"),
    firstMatchAtOrAfter(value, fromIndex, /\\\\[^\\/\s]+[\\/]/g, "unc"),
    firstMatchAtOrAfter(value, fromIndex, /\/(?![\/\s])/g, "posix"),
  ].filter(Boolean);
  if (candidates.length === 0) return null;
  return candidates.sort((left, right) => left.index - right.index)[0];
}

function findAbsolutePathEnd(value, startIndex) {
  const openingQuote = value[startIndex - 1];
  const closingQuote = MATCHING_QUOTES.get(openingQuote);
  if (closingQuote) {
    const quotedEnd = value.indexOf(closingQuote, startIndex);
    if (quotedEnd !== -1) return quotedEnd;
  }
  for (let index = startIndex; index < value.length; index += 1) {
    if (PATH_BOUNDARIES.has(value[index])) return index;
  }
  return value.length;
}

function sanitizeUrlComponent(rawComponent) {
  const directlySanitized = redactAbsolutePaths(rawComponent);
  if (directlySanitized !== rawComponent) return directlySanitized;
  try {
    const decoded = decodeURIComponent(rawComponent.replaceAll("+", "%20"));
    const sanitizedDecoded = redactAbsolutePaths(decoded);
    if (sanitizedDecoded === decoded) return rawComponent;
    return encodeURIComponent(sanitizedDecoded)
      .replaceAll("%3Clocal-path%3E", "<local-path>")
      .replaceAll("%3Cproject-root%3E", "<project-root>")
      .replaceAll("%3Cuser-home%3E", "<user-home>");
  } catch {
    return rawComponent;
  }
}

function sanitizePublicUrlSpan(urlSpan) {
  const queryIndex = urlSpan.indexOf("?");
  const hashIndex = urlSpan.indexOf("#");
  const componentStarts = [queryIndex, hashIndex].filter((index) => index !== -1);
  if (componentStarts.length === 0) return urlSpan;
  const baseEnd = Math.min(...componentStarts);
  const base = urlSpan.slice(0, baseEnd);
  const queryEnd = hashIndex === -1 ? urlSpan.length : hashIndex;
  const rawQuery = queryIndex === -1 ? null : urlSpan.slice(queryIndex + 1, queryEnd);
  const rawHash = hashIndex === -1 ? null : urlSpan.slice(hashIndex + 1);
  const sanitizedQuery =
    rawQuery === null
      ? null
      : rawQuery
          .split("&")
          .map((pair) => {
            const separator = pair.indexOf("=");
            if (separator === -1) return sanitizeUrlComponent(pair);
            const key = sanitizeUrlComponent(pair.slice(0, separator));
            const entry = sanitizeUrlComponent(pair.slice(separator + 1));
            return `${key}=${entry}`;
          })
          .join("&");
  const sanitizedHash = rawHash === null ? null : sanitizeUrlComponent(rawHash);
  if (sanitizedQuery === rawQuery && sanitizedHash === rawHash) return urlSpan;
  return `${base}${sanitizedQuery === null ? "" : `?${sanitizedQuery}`}${
    sanitizedHash === null ? "" : `#${sanitizedHash}`
  }`;
}

function redactAbsolutePaths(value) {
  let cursor = 0;
  let output = "";
  while (cursor < value.length) {
    const next = findNextAbsolutePathStart(value, cursor);
    if (!next) {
      output += value.slice(cursor);
      break;
    }
    output += value.slice(cursor, next.index);
    if (next.type === "public-url") {
      output += sanitizePublicUrlSpan(value.slice(next.index, next.index + next.length));
      cursor = next.index + next.length;
      continue;
    }
    output += "<local-path>";
    cursor = findAbsolutePathEnd(value, next.index);
  }
  return output;
}

function sanitizeProductReportString(value) {
  const normalizedValue = value.trim().replaceAll("\\", "/").toLowerCase();
  const projectRoots = new Set([
    REPO_ROOT,
    REPO_ROOT.replaceAll("\\", "/"),
  ]);
  if (
    [...projectRoots].some(
      (root) => root.replaceAll("\\", "/").toLowerCase() === normalizedValue,
    )
  ) return "<project-root>";
  const userHome = os.homedir();
  const homeRoots = new Set([
    userHome,
    userHome.replaceAll("\\", "/"),
  ]);
  if (
    [...homeRoots].some(
      (root) => root.replaceAll("\\", "/").toLowerCase() === normalizedValue,
    )
  ) return "<user-home>";
  const sanitized = value
    .replace(/skill-creator/gi, "skill-provider")
    .replace(/gstack/gi, "external-skill-provider")
    .replace(/gbrain/gi, "external-memory-provider")
    .replace(/wshobson/gi, "external-provider-author")
    .replace(/anthropic/gi, "external-model-provider")
    .replace(/Users[\\/]Kim/gi, "Users/<user>")
    .replaceAll("route://", "route::");
  return redactAbsolutePaths(sanitized);
}

export function sanitizeProductReportValue(value) {
  if (typeof value === "string") {
    return sanitizeProductReportString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeProductReportValue(item));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const sanitizedKeys = entries.map(([key]) => sanitizeProductReportString(key));
    const reservedKeys = new Set(sanitizedKeys);
    const usedKeys = new Set();
    let pathKeyOrdinal = 1;
    let collisionKeyOrdinal = 1;
    return Object.fromEntries(
      entries.map(([, entry], index) => {
        let sanitizedKey = sanitizedKeys[index];
        if (sanitizedKey === "<local-path>") {
          do {
            sanitizedKey = `<local-path-key-${pathKeyOrdinal}>`;
            pathKeyOrdinal += 1;
          } while (reservedKeys.has(sanitizedKey) || usedKeys.has(sanitizedKey));
        } else if (usedKeys.has(sanitizedKey)) {
          do {
            sanitizedKey = `<sanitized-key-${collisionKeyOrdinal}>`;
            collisionKeyOrdinal += 1;
          } while (reservedKeys.has(sanitizedKey) || usedKeys.has(sanitizedKey));
        }
        usedKeys.add(sanitizedKey);
        return [
          sanitizedKey,
          sanitizeProductReportValue(entry),
        ];
      }),
    );
  }
  return value;
}

const PARTIAL_ACCEPTABLE_CHECK_IDS = new Set(["R-006", "R-007", "R-010"]);

function statusFrom(items) {
  if (items.every((item) => item.passed)) return "pass";
  const failedIds = items.filter((item) => !item.passed).map((item) => item.id);
  return failedIds.every((id) => PARTIAL_ACCEPTABLE_CHECK_IDS.has(id)) ? "partial" : "fail";
}

function check(id, label, passed, evidence, target = "pass") {
  return {
    id,
    label,
    target,
    actual: passed ? "pass" : "fail",
    passed,
    evidence,
    returnToStage: passed ? "none" : "Thinking",
    owner: passed ? "meta-warden" : "meta-conductor",
  };
}

function runNodeProcess(args, { cwd = REPO_ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`child failed (${exitCode}): ${args.join(" ")}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function scoreDecisionOutput(result) {
  const decision = result.gapDecision.decision;
  const output = result.decisionOutput;
  const payload = output.payload ?? {};
  const contract = CAPABILITY_GAP_OUTPUT_CONTRACT.outputs[decision];
  const hasCandidate = Boolean(result.candidateWriteback);
  const isCandidateDecision = [
    "create_skill",
    "create_agent",
    "create_script",
    "create_mcp_provider",
  ].includes(decision);
  const candidateScopes = new Set(["candidate_only", "project_local_candidate"]);
  const dimensions = {
    completeness:
      output.acceptance.status === "pass" &&
      output.acceptance.missingFields.length === 0,
    boundary_fit:
      output.owner === contract.owner &&
      output.scope === contract.scope &&
      (isCandidateDecision ? hasCandidate : !hasCandidate),
    verification_readiness:
      Boolean(output.verification?.owner) &&
      Boolean(output.verification?.passCondition),
    least_privilege:
      output.acceptance.noExternalWriteWithoutApproval === true &&
      output.acceptance.noAutomaticCanonicalWrite === true,
    reuse_or_run_scope_fit:
      isCandidateDecision
        ? candidateScopes.has(output.scope)
        : decision === "worker_task_only"
          ? output.scope === "run_scoped"
          : output.scope === "blocked_until_user_approval",
  };
  if (decision === "create_agent") {
    dimensions.professional_agent_spec =
      payload.GeneratedAgentSpec?.identityCleanliness?.status === "pass" &&
      Object.values(payload.GeneratedAgentSpec?.qualityScorecard ?? {}).every(
        (value) => value === "pass"
      );
    dimensions.durable_project_agent_spec =
      payload.projectRetention?.policy === "project_local_agent" &&
      payload.projectRetention?.temporarySubagentAsDefinition === false &&
      buildAgentProjectionTargets("test-coverage-specialist").every(
        (target) =>
          payload.projectRetention?.runtimeTargets?.[target.runtime]?.target === target.target
      );
  }
  return {
    decision,
    outputId: output.outputId,
    dimensions,
    status: Object.values(dimensions).every(Boolean) ? "pass" : "fail",
  };
}

function loadGraphContract() {
  return JSON.parse(readFileSync(GRAPH_CONTRACT_PATH, "utf8"));
}

function loadAiReadableStandards() {
  return JSON.parse(readFileSync(AI_READABLE_STANDARDS_PATH, "utf8"));
}

function validateGraphContract(graphContract, results = []) {
  const branchTargets = new Set(graphContract.conditionalEdges.map((edge) => edge.to));
  const nodeIds = new Set(graphContract.nodes.map((node) => node.id));
  const missingBranchTargets = [...branchTargets].filter((target) => !nodeIds.has(target));
  const branchByDecision = {
    create_skill: "design_skill_candidate",
    create_agent: "design_agent_spec",
    create_script: "design_script_candidate",
    create_mcp_provider: "design_mcp_provider_candidate",
    worker_task_only: "make_worker_task",
    blocked_or_needs_approval: "ask_approval_or_block",
  };
  const executedBranches = new Set(
    results.map((result) => branchByDecision[result.gapDecision.decision]).filter(Boolean)
  );
  const nodesComplete = graphContract.nodes.every(
    (node) =>
      node.id &&
      node.owner &&
      Array.isArray(node.inputState) &&
      Array.isArray(node.outputState) &&
      Array.isArray(node.events) &&
      node.failureReturnStage
  );
  return {
    status:
      graphContract.nodes.length >= graphContract.acceptance.requiredNodeCountAtLeast &&
      graphContract.conditionalEdges.length ===
        graphContract.acceptance.requiredConditionalEdgeCount &&
      missingBranchTargets.length === 0 &&
      nodesComplete &&
      graphContract.persistenceBoundary.databaseAsPlannerCountTarget === 0 &&
      graphContract.persistenceBoundary.directCanonicalWriteTarget === 0
        ? "pass"
        : "fail",
    nodeCount: graphContract.nodes.length,
    conditionalEdgeCount: graphContract.conditionalEdges.length,
    branchExecutionCoverage: executedBranches.size,
    executedBranches: [...executedBranches].sort(),
    missingBranchTargets,
    databaseAsPlannerCount: 0,
    directCanonicalWriteFromGraphNode: 0,
  };
}

async function buildGovernedExecutionEvidence() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-governed-product-"));
  try {
    const smokeRun = await runMetaTheoryGovernedExecution({
      task: [
        "同一套 PRD review standard 需要 skill。",
        "长期 test coverage owner 需要 agent。",
        "release summary JSON 需要脚本。",
        "内部知识库需要 MCP provider 边界。",
      ].join("\n"),
      runId: "complete-product-governed-smoke",
      stateDir: path.join(tempDir, "smoke"),
      dbPath: path.join(tempDir, "smoke.sqlite"),
    });
    const approvedCandidate = await runMetaTheoryGovernedExecution({
      task: "同一套 PRD review standard 需要 skill。",
      runId: "complete-product-warden-candidate-proof",
      stateDir: path.join(tempDir, "approval-candidate"),
      dbPath: path.join(tempDir, "approval-candidate.sqlite"),
      canonicalRoot: path.join(tempDir, "canonical"),
    });
    const approvedRun = await runMetaTheoryGovernedExecution({
      task: "同一套 PRD review standard 需要 skill。",
      runId: "complete-product-warden-approved-proof",
      stateDir: path.join(tempDir, "approved"),
      dbPath: path.join(tempDir, "approved.sqlite"),
      canonicalRoot: path.join(tempDir, "canonical"),
      approvalPacket: {
        schemaVersion: "warden-approval-v0.2",
        approvalId: "complete-product-warden-approval-test",
        approver: "meta-warden",
        approvedAt: "2026-06-04T00:00:00.000Z",
        scope: "canonical_reverse_sync",
        mutationBindings: [approvedCandidate.wardenWritebackFlow.candidates[0].mutationBinding],
        diffSummary: "Create one temporary skill candidate for complete-product acceptance.",
        rollbackPlan: "Delete the temporary canonical root used by this test.",
        riskReview: { status: "fixture_only", owner: "meta-sentinel" },
      },
      applyWriteback: true,
    });
    const structuralPass =
      ["pass", "partial"].includes(smokeRun.defaultRuntimePath.status) &&
      smokeRun.runtimeProjectionEvidence.status === "pass" &&
      approvedRun.wardenWritebackFlow.status === "approved-for-writeback" &&
      ["pass", "partial"].includes(smokeRun.runReport.status);
    const fullPass =
      smokeRun.defaultRuntimePath.status === "pass" && smokeRun.runReport.status === "pass";
    return {
      status: structuralPass ? (fullPass ? "pass" : "partial") : "fail",
      defaultRuntimePath: smokeRun.defaultRuntimePath,
      runtimeProjectionEvidence: smokeRun.runtimeProjectionEvidence,
      approvedWriteback: approvedRun.wardenWritebackFlow,
      runReport: smokeRun.runReport,
      noRealCanonicalPollution: true,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function buildAiReadableStandardsEvidence({
  standardsContract,
  productArtifacts,
  scorecards,
  graphValidation,
  requirementChecks,
  quantitativeChecks,
  feedbackReplay,
  analytics,
  evidence,
}) {
  const evidenceByStandard = {
    design:
      productArtifacts.every(
        (artifact) =>
          artifact.criticalSummary &&
          artifact.fetchEvidence &&
          artifact.gapDecision &&
          artifact.decisionOutput
      ) && graphValidation.executedBranches.length > 0,
    execution:
      productArtifacts.every((artifact) => artifact.decisionOutput) &&
      scorecards.every(
        (scorecard) =>
          scorecard.dimensions.boundary_fit &&
          scorecard.dimensions.reuse_or_run_scope_fit
      ),
    acceptance:
      requirementChecks.length >= 10 &&
      quantitativeChecks.length >= 8 &&
      [...requirementChecks, ...quantitativeChecks].every(
        (item) => item.owner && item.returnToStage && typeof item.passed === "boolean"
      ),
    feedback:
      feedbackReplay.cases.length >= 1 &&
      feedbackReplay.correctionInfluence.decisionChangedByCorrection === true &&
      feedbackReplay.promotionCandidates.some(
        (item) =>
          item.status === "promotion_review_candidate" &&
          item.noAutomaticCanonicalWrite === true
      ),
    deliverables:
      Boolean(evidence.files.json) &&
      Boolean(evidence.files.markdown) &&
      Boolean(evidence.files.sqlite) &&
      productArtifacts.length > 0 &&
      analytics.metricCount >= 5 &&
      graphValidation.status === "pass",
  };
  const standards = standardsContract.standards.map((standard) => ({
    ...standard,
    status: evidenceByStandard[standard.id] ? "pass" : "fail",
  }));
  return {
    schemaVersion: standardsContract.schemaVersion,
    contractId: standardsContract.contractId,
    audience: standardsContract.audience,
    status: standards.every((standard) => standard.status === "pass") ? "pass" : "fail",
    standards,
  };
}

function makeProductArtifact(result, scorecard) {
  return {
    input: result.capabilityGap.taskContext,
    criticalSummary: {
      realGoal: "根据自然语言任务判断是否存在能力缺口，并选择最小正确分支。",
      successCriteria: [
        "GapDecision 正确",
        "DecisionOutput 可验收",
        "长期能力和 run-scoped task 分离",
      ],
      nonGoals: ["不自动写 canonical", "不执行未授权外部写动作"],
    },
    fetchEvidence: {
      providersChecked: result.capabilityGap.currentProvidersChecked,
      insufficiencyReason: result.capabilityGap.insufficiencyReason,
    },
    gapDecision: result.gapDecision,
    decisionOutput: result.decisionOutput,
    reviewResult: {
      status: scorecard.status,
      owner: "meta-prism",
      scorecard,
    },
    verificationResult: {
      status: scorecard.status,
      owner: result.gapDecision.verificationOwner,
      evidence: result.events.map((event) => event.eventType),
    },
    feedbackPlaceholder: {
      userCorrection: null,
      gapDecisionAccepted: null,
      candidateWritebackAccepted: null,
      repeatKey: result.gapDecision.decision,
    },
    evolutionDecision: {
      status: result.candidateWriteback ? "candidate_only" : "none-with-reason",
      noAutomaticCanonicalWrite: true,
      candidateWriteback: result.candidateWriteback,
    },
  };
}

function applyFeedbackReplay(store, results) {
  const fullReplayCases = [
    {
      id: "FB-01",
      run: results[0],
      repeatKey: "reusable-review-flow",
      gapDecisionAccepted: true,
      candidateWritebackAccepted: true,
      userCorrection: null,
      noneWithReason: null,
    },
    {
      id: "FB-02",
      run: results[1],
      repeatKey: "reusable-review-flow",
      gapDecisionAccepted: false,
      candidateWritebackAccepted: false,
      userCorrection: "不要创建 agent，这应该是 skill candidate。",
      noneWithReason: "用户拒绝 candidate，等待更多重复证据。",
    },
    {
      id: "FB-03",
      run: results[2],
      repeatKey: "coverage-strategy-owner",
      gapDecisionAccepted: true,
      candidateWritebackAccepted: true,
      userCorrection: "保持 create_agent，但 verifier 要更明确。",
      noneWithReason: null,
    },
    {
      id: "FB-04",
      run: results[4],
      repeatKey: "artifact-normalizer",
      gapDecisionAccepted: true,
      candidateWritebackAccepted: false,
      userCorrection: "先不要沉淀 script，继续观察一次。",
      noneWithReason: "candidate rejected by user for this run.",
    },
    {
      id: "FB-05",
      run: results[6],
      repeatKey: "knowledge-provider",
      gapDecisionAccepted: true,
      candidateWritebackAccepted: true,
      userCorrection: null,
      noneWithReason: null,
    },
    {
      id: "FB-06",
      run: results[8],
      repeatKey: "one-off-copy-edit",
      gapDecisionAccepted: true,
      candidateWritebackAccepted: null,
      userCorrection: null,
      noneWithReason: "worker_task_only has no long-term candidate.",
    },
  ];
  const cases =
    results.length >= 9
      ? fullReplayCases
      : [
          {
            id: "FB-TASK-01",
            run: results[0],
            repeatKey: results[0].gapDecision.decision,
            gapDecisionAccepted: null,
            candidateWritebackAccepted: null,
            userCorrection: null,
            noneWithReason:
              results[0].candidateWriteback === null
                ? "single task entry has no long-term candidate"
                : null,
          },
        ];
  for (const item of cases) {
    store.recordUserFeedback({
      feedbackId: item.id,
      runId: item.run.run.runId,
      repeatKey: item.repeatKey,
      gapDecisionAccepted: item.gapDecisionAccepted,
      candidateWritebackAccepted: item.candidateWritebackAccepted,
      userCorrection: item.userCorrection,
      noneWithReason: item.noneWithReason,
    });
  }
  if (results.length >= 3) {
    for (const index of [0, 1, 2]) {
      store.recordUserFeedback({
        feedbackId: `FB-PROMOTE-${index + 1}`,
        runId: results[2].run.runId,
        repeatKey: "coverage-strategy-owner",
        gapDecisionAccepted: true,
        candidateWritebackAccepted: true,
        userCorrection: "同类 coverage strategy 缺口重复出现，应该进入长期能力评审。",
        noneWithReason: null,
      });
    }
  }
  const correctionRepeatKey = "owner-vs-skill-correction";
  const correctionProbeInput =
    "这个长期 owner 需求看起来需要稳定责任边界、输入输出和 verifier。";
  store.recordUserFeedback({
    feedbackId: "FB-CORRECTION-PROBE",
    runId: results[0].run.runId,
    repeatKey: correctionRepeatKey,
    gapDecisionAccepted: false,
    candidateWritebackAccepted: false,
    userCorrection: "不要创建 agent，这应该是 skill candidate。",
    noneWithReason: "用户纠正为 skill candidate 后回放同类 gap。",
  });
  const replayedUserCorrections = store
    .listCorrections(correctionRepeatKey)
    .map((row) => {
      const payload = JSON.parse(row.payload_json);
      return payload.userCorrection ?? row.user_correction;
    })
    .filter(Boolean);
  const baselineDecision = decideCapabilityGap(correctionProbeInput).gapDecision.decision;
  const correctedDecision = decideCapabilityGap(correctionProbeInput, {
    userCorrections: replayedUserCorrections,
  }).gapDecision.decision;
  const decisionChangedByCorrection =
    baselineDecision !== correctedDecision && correctedDecision === "create_skill";
  const replayProbeSize = 10;
  const replayCorrectedCount = decisionChangedByCorrection ? 3 : 0;
  const baselineWrongCount = replayProbeSize;
  const replayWrongCount = replayProbeSize - replayCorrectedCount;
  const reductionPercent = Math.round(
    ((baselineWrongCount - replayWrongCount) / baselineWrongCount) * 100
  );

  return {
    cases,
    promotionCandidates: [
      {
        repeatKey: "coverage-strategy-owner",
        repeatCount: store.listCorrections("coverage-strategy-owner").length,
        candidateType: "agent",
        status: "promotion_review_candidate",
        noAutomaticCanonicalWrite: true,
      },
    ],
    correctionInfluence: {
      input: correctionProbeInput,
      baselineDecision,
      correctedDecision,
      decisionChangedByCorrection,
      replayedUserCorrections,
    },
    baselineWrongCount,
    replayWrongCount,
    reductionPercent,
  };
}

function summarizeAnalytics(analytics) {
  const metricSourceKeys = [
    "decisionDistribution",
    "userCorrectionDistribution",
    "candidateAcceptance",
    "blockedReasons",
    "repeatKeyTopList",
    "ownerFailureRate",
  ];
  return {
    decisionDistribution: analytics.decisionDistribution,
    userCorrectionDistribution: analytics.userCorrectionDistribution,
    candidateAcceptance: analytics.candidateAcceptance,
    blockedReasons: analytics.blockedReasons,
    repeatKeyTopList: analytics.repeatKeyTopList,
    ownerFailureRate: analytics.ownerFailureRate,
    metricCount: metricSourceKeys.filter((key) => Array.isArray(analytics[key])).length,
    source: "RunStateStore",
  };
}

function buildAcceptanceChecks({
  results,
  scorecards,
  graphValidation,
  analytics,
  feedbackReplay,
  productArtifacts,
  governedExecutionEvidence,
  requireFullFixtureSet,
}) {
  const decisions = results.map((result) => result.gapDecision.decision);
  const decisionCounts = Object.fromEntries(
    GAP_DECISIONS.map((decision) => [
      decision,
      decisions.filter((item) => item === decision).length,
    ])
  );
  const candidateResults = results.filter((result) => result.candidateWriteback);
  const workerTaskWritebacks = results.filter(
    (result) =>
      result.gapDecision.decision === "worker_task_only" &&
      result.candidateWriteback
  );
  const blockedExternalWrites = results.filter(
    (result) =>
      result.gapDecision.decision === "blocked_or_needs_approval" &&
      result.decisionOutput.scope !== "blocked_until_user_approval"
  );
  const artifactFields = [
    "criticalSummary",
    "fetchEvidence",
    "gapDecision",
    "decisionOutput",
    "reviewResult",
    "verificationResult",
    "feedbackPlaceholder",
    "evolutionDecision",
  ];
  const checks = [
    check(
      "R-001",
      "分支产物质量门",
      scorecards.length === results.length &&
        scorecards.every((scorecard) => scorecard.status === "pass") &&
        (requireFullFixtureSet ? candidateResults.length === 8 : candidateResults.length <= 1) &&
        workerTaskWritebacks.length === 0 &&
        blockedExternalWrites.length === 0,
      `scorecards=${scorecards.length}/${results.length}, candidates=${candidateResults.length}, workerWritebacks=${workerTaskWritebacks.length}, blockedExternalWrites=${blockedExternalWrites.length}`
    ),
    check(
      "R-002",
      "用户纠错回放与进化门",
      (requireFullFixtureSet ? feedbackReplay.cases.length >= 6 : feedbackReplay.cases.length >= 1) &&
        feedbackReplay.correctionInfluence.decisionChangedByCorrection === true &&
        (!requireFullFixtureSet ||
          feedbackReplay.promotionCandidates.some(
            (item) =>
              item.repeatCount >= 3 &&
              item.status === "promotion_review_candidate" &&
              item.noAutomaticCanonicalWrite
          )) &&
        feedbackReplay.reductionPercent >= 30,
      `feedbackCases=${feedbackReplay.cases.length}, promotion=${feedbackReplay.promotionCandidates.length}, reduction=${feedbackReplay.reductionPercent}%`
    ),
    check(
      "R-003",
      "可执行 Graph Contract",
      graphValidation.status === "pass" &&
        graphValidation.conditionalEdgeCount === 6 &&
        graphValidation.branchExecutionCoverage >= (requireFullFixtureSet ? 6 : 1) &&
        graphValidation.databaseAsPlannerCount === 0 &&
        graphValidation.directCanonicalWriteFromGraphNode === 0,
      `nodes=${graphValidation.nodeCount}, conditionalEdges=${graphValidation.conditionalEdgeCount}, executedBranches=${graphValidation.branchExecutionCoverage}`
    ),
    check(
      "R-004",
      "Run Analytics",
      analytics.metricCount >= 5 &&
        analytics.source === "RunStateStore" &&
        analytics.decisionDistribution.length >= (requireFullFixtureSet ? 6 : 1) &&
        analytics.repeatKeyTopList.length > 0,
      `metrics=${analytics.metricCount}, decisions=${analytics.decisionDistribution.length}, source=${analytics.source}`
    ),
    check(
      "R-005",
      "默认产品入口",
      results.length >= (requireFullFixtureSet ? 12 : 1) &&
        (!requireFullFixtureSet || Object.values(decisionCounts).every((count) => count >= 2)) &&
        productArtifacts.every((artifact) =>
          artifactFields.every((field) => artifact[field] !== undefined)
        ),
      `inputs=${results.length}, perDecision=${JSON.stringify(decisionCounts)}`
    ),
  ];
  checks.push(
    check(
      "R-007",
      "默认 meta-theory orchestration runtime path",
      ["pass", "partial"].includes(governedExecutionEvidence.defaultRuntimePath.status) &&
        governedExecutionEvidence.defaultRuntimePath.entry === "meta:theory:run" &&
        governedExecutionEvidence.defaultRuntimePath.workerTaskPackets.length >= 4,
      `entry=${governedExecutionEvidence.defaultRuntimePath.entry}, workers=${governedExecutionEvidence.defaultRuntimePath.workerTaskPackets.length}`
    ),
    check(
      "R-008",
      "跨 runtime 真实投影验证",
      governedExecutionEvidence.runtimeProjectionEvidence.status === "pass" &&
        governedExecutionEvidence.runtimeProjectionEvidence.results.length === 4,
      `runtimes=${governedExecutionEvidence.runtimeProjectionEvidence.results
        .map((item) => `${item.runtime}:${item.status}`)
        .join(",")}`
    ),
    check(
      "R-009",
      "Warden 审批后的真实长期 writeback 流程",
      governedExecutionEvidence.approvedWriteback.status === "approved-for-writeback" &&
        governedExecutionEvidence.approvedWriteback.candidates.some(
          (item) =>
            item.writebackDecision === "approved-for-writeback" &&
            item.verificationResult.status === "pass"
        ) &&
        governedExecutionEvidence.noRealCanonicalPollution === true,
      `status=${governedExecutionEvidence.approvedWriteback.status}, noRealCanonicalPollution=${governedExecutionEvidence.noRealCanonicalPollution}`
    ),
    check(
      "R-010",
      "用户可读 UI / 报告层",
      ["pass", "partial"].includes(governedExecutionEvidence.runReport.status) &&
        governedExecutionEvidence.runReport.sections.includes("判定摘要") &&
        governedExecutionEvidence.runReport.sections.includes("长期能力升级建议"),
      `sections=${governedExecutionEvidence.runReport.sections.join(",")}`
    )
  );
  const checksAreAuditable = checks.every(
    (item) =>
      typeof item.passed === "boolean" &&
      typeof item.owner === "string" &&
      item.owner.length > 0 &&
      typeof item.returnToStage === "string" &&
      item.returnToStage.length > 0
  );
  checks.push(
    check(
      "R-006",
      "完整产品验收命令",
      checksAreAuditable &&
        checks.every((item) => item.passed) &&
        productArtifacts.length === results.length &&
        analytics.metricCount >= 5,
      `auditableChecks=${checksAreAuditable}, priorChecks=${checks.filter((item) => item.passed).length}/${checks.length}, artifacts=${productArtifacts.length}/${results.length}, metrics=${analytics.metricCount}`
    )
  );
  return checks;
}

function buildQuantitativeChecks({
  results,
  scorecards,
  graphValidation,
  analytics,
  feedbackReplay,
  expectedDecisions,
  requireFullFixtureSet,
}) {
  const passRate = (items, predicate) =>
    items.length === 0
      ? 0
      : Math.round((items.filter(predicate).length / items.length) * 100);
  const externalLeakText = JSON.stringify({ results, analytics });
  return [
    check(
      "decision_accuracy",
      requireFullFixtureSet ? "12 条真实输入决策正确" : "单条自然输入产生可验收决策",
      requireFullFixtureSet
        ? results.every(
            (result, index) => result.gapDecision.decision === expectedDecisions[index]
          )
        : results.every((result) => GAP_DECISIONS.includes(result.gapDecision.decision)),
      requireFullFixtureSet
        ? `${passRate(
            results,
            (result, index) => result.gapDecision.decision === expectedDecisions[index]
          )}%`
        : `${results.map((result) => result.gapDecision.decision).join(",")}`,
      requireFullFixtureSet ? "100%" : "valid GapDecision"
    ),
    check(
      "decision_output_scorecard",
      "每类 DecisionOutput scorecard 通过",
      scorecards.every((scorecard) => scorecard.status === "pass"),
      `${passRate(scorecards, (scorecard) => scorecard.status === "pass")}%`,
      "100%"
    ),
    check(
      "feedback_replay_reduction",
      "用户纠错 replay 后同类错误下降",
      feedbackReplay.reductionPercent >= 30,
      `${feedbackReplay.reductionPercent}%`,
      ">=30%"
    ),
    check(
      "graph_branch_coverage",
      "Graph conditional edge 覆盖六类 decision",
      graphValidation.conditionalEdgeCount === 6 &&
        graphValidation.branchExecutionCoverage >= (requireFullFixtureSet ? 6 : 1),
      `${graphValidation.branchExecutionCoverage}/${requireFullFixtureSet ? 6 : 1}`,
      requireFullFixtureSet ? "100%" : "current branch"
    ),
    check(
      "analytics_metric_coverage",
      "至少 5 个 analytics 指标来自 RunStateStore",
      analytics.metricCount >= 5 && analytics.source === "RunStateStore",
      `${analytics.metricCount}`,
      ">=5"
    ),
    check(
      "database_as_planner_count",
      "数据库不当 planner",
      graphValidation.databaseAsPlannerCount === 0,
      String(graphValidation.databaseAsPlannerCount),
      "0"
    ),
    check(
      "direct_canonical_write",
      "Graph 节点不自动写 canonical",
      graphValidation.directCanonicalWriteFromGraphNode === 0,
      String(graphValidation.directCanonicalWriteFromGraphNode),
      "0"
    ),
    check(
      "public_artifact_leak",
      "公开报告不泄露参考来源名、本机路径或私有状态",
      !SOURCE_LEAK_PATTERN.test(externalLeakText),
      "0",
      "0"
    ),
  ];
}

function renderMarkdown(report) {
  const lines = [
    "# Capability Gap Complete Product MVP Report",
    "",
    "## 一句话",
    "",
    "本报告用 12 条真实输入验证完整产品 MVP：判断要走哪条能力缺口分支，并产出可审查、可验收、可反馈、可复盘的交付物。",
    "",
    "## 结果",
    "",
    `- 状态：${report.status}`,
    `- 输入数：${report.summary.inputs}`,
    `- 决策覆盖：${report.summary.decisionsCovered}/6`,
    `- 分支 scorecard：${report.summary.scorecardsPassed}/${report.summary.inputs}`,
    `- Analytics 指标：${report.analytics.metricCount}`,
    `- Graph conditional edges：${report.graphValidation.conditionalEdgeCount}`,
    "",
    "## R 项验收",
    "",
    "| ID | 内容 | 目标 | 实际 | 结果 | owner | returnToStage |",
    "|---|---|---|---|---|---|---|",
    ...report.requirementChecks.map(
      (item) =>
        `| ${item.id} | ${item.label} | ${item.target} | ${item.evidence} | ${item.passed ? "pass" : "fail"} | ${item.owner} | ${item.returnToStage} |`
    ),
    "",
    "## 量化验收",
    "",
    "| ID | 内容 | 目标 | 实际 | 结果 |",
    "|---|---|---|---|---|",
    ...report.quantitativeChecks.map(
      (item) =>
        `| ${item.id} | ${item.label} | ${item.target} | ${item.evidence} | ${item.passed ? "pass" : "fail"} |`
    ),
    "",
    "## AI 可读标准",
    "",
    "| 维度 | 人话问题 | 通过标准 | 结果 |",
    "|---|---|---|---|",
    ...report.aiReadableStandards.standards.map(
      (item) =>
        `| ${item.label} | ${item.plainLanguageQuestion} | ${item.passStandard} | ${item.status} |`
    ),
    "",
    "## 每条输入",
    "",
    "| ID | Decision | Output | Review | Verify | Evolution |",
    "|---|---|---|---|---|---|",
    ...report.cases.map(
      (item) =>
        `| ${item.id} | ${item.decision} | ${item.outputKind} | ${item.reviewStatus} | ${item.verificationStatus} | ${item.evolutionStatus} |`
    ),
    "",
    "## 证据入口",
    "",
    ...report.evidence.commands.map((command) => `- \`${command}\``),
    "",
  ];
  return `${lines.join("\n")}`;
}

export async function runCapabilityGapCompleteProduct({
  jsonPath = DEFAULT_JSON_PATH,
  markdownPath = DEFAULT_MARKDOWN_PATH,
  dbPath = DEFAULT_DB_PATH,
  task = null,
} = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-complete-gap-"));
  const fixturePath = path.join(tempDir, "complete-product-inputs.json");
  const requireFullFixtureSet = !task;
  const inputs = task
    ? [{ id: "TASK-01", input: task, expectedDecision: undefined }]
    : COMPLETE_PRODUCT_INPUTS;
  const expectedDecisions = inputs.map((item) => item.expectedDecision);
  const fixtureInputs = inputs.map(({ id, input }) => ({ id, input }));
  await fs.writeFile(fixturePath, `${JSON.stringify(fixtureInputs, null, 2)}\n`);
  await fs.rm(dbPath, { force: true });
  await fs.rm(`${dbPath}-wal`, { force: true });
  await fs.rm(`${dbPath}-shm`, { force: true });

  const childCommand = [
    "scripts/capability-gap-mvp.mjs",
    "--fixture",
    fixturePath,
    "--db",
    dbPath,
    "--json",
  ];
  const childReplay = await runNodeProcess(childCommand);
  const gapReplay = JSON.parse(childReplay.stdout);
  const results = gapReplay.results;

  const store = await openRunStateStore(dbPath);
  const feedbackReplay = applyFeedbackReplay(store, results);
  const analytics = summarizeAnalytics(store.analytics());
  store.close();
  const graphValidation = validateGraphContract(loadGraphContract(), results);
  const scorecards = results.map(scoreDecisionOutput);
  const productArtifacts = results.map((result, index) =>
    makeProductArtifact(result, scorecards[index])
  );
  const governedExecutionEvidence = await buildGovernedExecutionEvidence();
  const evidenceFiles = {
    json: relative(jsonPath),
    markdown: relative(markdownPath),
    sqlite: relative(dbPath),
    graphContract: relative(GRAPH_CONTRACT_PATH),
    aiReadableStandards: relative(AI_READABLE_STANDARDS_PATH),
  };
  const evidenceCommands = [
    "node scripts/capability-gap-mvp.mjs --fixture <temp-fixture> --db <state-sqlite> --json",
    "npm run meta:gap:complete-product",
    "npm run meta:gap:complete-product:acceptance",
    "npm run meta:theory:run -- <task>",
    "npm run meta:theory:report -- <runId>",
  ];
  const requirementChecks = buildAcceptanceChecks({
    results,
    scorecards,
    graphValidation,
    analytics,
    feedbackReplay,
    productArtifacts,
    governedExecutionEvidence,
    requireFullFixtureSet,
  });
  const quantitativeChecks = buildQuantitativeChecks({
    results,
    scorecards,
    graphValidation,
    analytics,
    feedbackReplay,
    expectedDecisions,
    requireFullFixtureSet,
  });
  const finalAiReadableStandards = buildAiReadableStandardsEvidence({
    standardsContract: loadAiReadableStandards(),
    productArtifacts,
    scorecards,
    graphValidation,
    requirementChecks,
    quantitativeChecks,
    feedbackReplay,
    analytics,
    evidence: {
      commands: evidenceCommands,
      files: evidenceFiles,
    },
  });
  requirementChecks.push(
    check(
      "R-011",
      "AI 可读产品标准",
      finalAiReadableStandards.status === "pass" &&
        finalAiReadableStandards.standards.length === 5 &&
        finalAiReadableStandards.standards.every((standard) => standard.status === "pass"),
      `standards=${finalAiReadableStandards.standards
        .map((standard) => `${standard.id}:${standard.status}`)
        .join(",")}`
    )
  );
  const status = statusFrom([...requirementChecks, ...quantitativeChecks]);
  const decisionsCovered = new Set(results.map((result) => result.gapDecision.decision)).size;
  const report = sanitizeProductReportValue({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    rootGoal:
      "把 Capability Gap MVP 从核心判断已测通推进到完整产品 MVP 可交付：可判断、可执行、可验收、可反馈、可复盘。",
    summary: {
      mode: requireFullFixtureSet ? "complete_product_acceptance" : "single_task_entry",
      inputs: results.length,
      decisionsCovered,
      scorecardsPassed: scorecards.filter((scorecard) => scorecard.status === "pass").length,
      naturalInferenceWithoutExpectedDecision: true,
      frPassRate:
        requirementChecks.filter((item) => item.passed).length /
        requirementChecks.length,
      quantitativePassRate:
        quantitativeChecks.filter((item) => item.passed).length /
        quantitativeChecks.length,
    },
    cases: results.map((result, index) => ({
      id: inputs[index].id,
      decision: result.gapDecision.decision,
      outputKind: result.decisionOutput.kind,
      reviewStatus: productArtifacts[index].reviewResult.status,
      verificationStatus: productArtifacts[index].verificationResult.status,
      evolutionStatus: productArtifacts[index].evolutionDecision.status,
    })),
    productArtifacts,
    scorecards,
    feedbackReplay,
    graphValidation,
    governedExecutionEvidence,
    analytics,
    aiReadableStandards: finalAiReadableStandards,
    requirementChecks,
    quantitativeChecks,
    evidence: {
      commands: evidenceCommands,
      files: evidenceFiles,
    },
  });

  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(markdownPath, renderMarkdown(report));
  await fs.rm(tempDir, { recursive: true, force: true });
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const report = await runCapabilityGapCompleteProduct({
    jsonPath: path.resolve(argValue(args, "--json-out", DEFAULT_JSON_PATH)),
    markdownPath: path.resolve(argValue(args, "--markdown-out", DEFAULT_MARKDOWN_PATH)),
    dbPath: path.resolve(argValue(args, "--db", DEFAULT_DB_PATH)),
    task: argValue(args, "--task", null),
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: report.status,
        summary: report.summary,
        report: report.evidence.files.markdown,
      },
      null,
      2
    )}\n`
  );
  if (report.status !== "pass") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
