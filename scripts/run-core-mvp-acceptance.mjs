#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DECISION_RULES,
  GAP_DECISIONS,
  decideCapabilityGap,
  openRunStateStore,
} from "./capability-gap-mvp.mjs";
import { runEvaluation } from "./evaluate-agent-design-quality.mjs";
import { runGovernanceAgentProcessMvp } from "./run-governance-agent-process-mvp.mjs";
import { runCapabilityGapRealInputReplay } from "./run-capability-gap-real-input-replay.mjs";
import { runCapabilityGapCompleteProduct, writeGovernedPreparationReport } from "./run-capability-gap-complete-product.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_JSON_PATH = path.join(
  REPO_ROOT,
  ".meta-kim",
  "state",
  "default",
  "core-mvp-acceptance.json"
);
const DEFAULT_MARKDOWN_PATH = path.join(
  REPO_ROOT,
  ".meta-kim",
  "state",
  "default",
  "core-mvp-acceptance-report.zh-CN.md"
);
const FIXTURE_PATH = path.join(
  REPO_ROOT,
  "tests",
  "meta-theory",
  "scenarios",
  "capability-gap-decision-fixtures.json"
);

const GOVERNANCE_OWNERS = new Set([
  "meta-warden",
  "meta-conductor",
  "meta-scout",
  "meta-artisan",
  "meta-genesis",
  "meta-sentinel",
  "meta-prism",
  "meta-chrysalis",
]);

function relative(filePath) {
  return path.relative(REPO_ROOT, filePath).replaceAll("\\", "/");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function argValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function check(id, label, passed, evidence, target = "pass", actual = passed ? "pass" : "fail") {
  return { id, label, target, actual, passed, evidence };
}

function statusFrom(checks) {
  return checks.every((item) => item.passed) ? "pass" : "fail";
}

function summarizeDecisionFixtures(fixtures) {
  const results = fixtures.map((fixture) =>
    decideCapabilityGap(fixture.input, {
      expectedDecision: fixture.expectedDecision,
      requiredEvidence: fixture.requiredEvidence,
      forbidden: fixture.forbidden,
    })
  );
  const decisions = results.map((result) => result.gapDecision.decision);
  const uniqueDecisions = [...new Set(decisions)].sort();
  const uniqueBranches = [...new Set(results.map((result) => result.graphPath.join(" -> ")))];
  const explainableCount = results.filter(
    (result) =>
      result.gapDecision.decisionReason &&
      result.gapDecision.rejectedAlternatives.length > 0 &&
      result.decisionEvidence.status === "pass"
  ).length;
  const verifierMissingCount = results.filter(
    (result) => !result.gapDecision.verificationOwner
  ).length;
  const fakeOwnerCount = results.filter((result) => {
    const rule = result.decisionEvidence.decisionRule;
    return (
      GOVERNANCE_OWNERS.has(rule.branchOwner) &&
      rule.branchOwnerRole === "execution_worker"
    );
  }).length;
  const outputFailures = results.filter(
    (result) => result.decisionOutput.acceptance.status !== "pass"
  ).length;

  return {
    total: fixtures.length,
    expectedDecisionCount: GAP_DECISIONS.length,
    uniqueDecisions,
    uniqueBranches,
    explainableCount,
    verifierMissingCount,
    fakeOwnerCount,
    outputFailures,
    results,
  };
}

async function summarizeRunStateStore(fixtures) {
  const store = await openRunStateStore(":memory:");
  const results = fixtures.map((fixture) => store.replayFixture(fixture));
  const eventCoverage = results.every((result, index) => {
    const eventTypes = store.eventTypes(result.run.runId);
    return [
      "capability_gap_detected",
      "providers_checked",
      "gap_decision_made",
      "decision_evidence_recorded",
      fixtures[index].expectedEvent,
    ].every((eventType) => eventTypes.includes(eventType));
  });

  return {
    runs: store.count("runs"),
    events: store.count("run_events"),
    gaps: store.count("capability_gaps"),
    decisions: store.count("gap_decisions"),
    generatedAgentSpecs: store.count("generated_agent_specs"),
    candidateWritebacks: store.count("candidate_writebacks"),
    userFeedback: store.count("user_feedback"),
    eventCoverage,
  };
}

function buildFrChecks({ fixtures, decisionSummary, storeSummary, agentEvaluation, processReport, realInputReplay }) {
  const fixtureDecisions = [...new Set(fixtures.map((fixture) => fixture.expectedDecision))].sort();
  return [
    check(
      "FR-001",
      "CapabilityGap 识别",
      decisionSummary.results.every((result) => result.capabilityGap.gapId),
      "每个 fixture 都生成 CapabilityGap"
    ),
    check(
      "FR-002",
      "GapDecision 六分类",
      fixtureDecisions.length === GAP_DECISIONS.length &&
        GAP_DECISIONS.every((decision) => fixtureDecisions.includes(decision)),
      `fixtures=${fixtureDecisions.join(", ")}`
    ),
    check(
      "FR-003",
      "长期能力候选写回",
      storeSummary.candidateWritebacks === 4,
      `candidate_writebacks=${storeSummary.candidateWritebacks}`
    ),
    check(
      "FR-004",
      "workerTask-only 保护",
      decisionSummary.results.some(
        (result) =>
          result.gapDecision.decision === "worker_task_only" &&
          result.workerTaskPacket &&
          result.candidateWriteback === null
      ),
      "worker_task_only 有 workerTaskPacket 且无 candidateWriteback"
    ),
    check(
      "FR-005",
      "Validator guardrails",
      decisionSummary.outputFailures === 0,
      `decisionOutput failures=${decisionSummary.outputFailures}`
    ),
    check(
      "FR-006",
      "反馈回放",
      storeSummary.userFeedback === fixtures.length,
      `user_feedback=${storeSummary.userFeedback}`
    ),
    check(
      "FR-007",
      "create_agent 成品验收",
      processReport.evaluation.specEvaluation.status === "pass" &&
        processReport.evaluation.intelligenceEvaluation.status === "pass" &&
        agentEvaluation.acceptance.status === "pass",
      `process=${processReport.status}, eval=${agentEvaluation.acceptance.status}`
    ),
    check(
      "FR-008",
      "RunStateStore 持久化",
      storeSummary.runs === fixtures.length &&
        storeSummary.gaps === fixtures.length &&
        storeSummary.decisions === fixtures.length &&
        storeSummary.eventCoverage,
      `runs=${storeSummary.runs}, gaps=${storeSummary.gaps}, decisions=${storeSummary.decisions}`
    ),
    check(
      "FR-009",
      "LangGraph 控制图",
      decisionSummary.uniqueBranches.length === GAP_DECISIONS.length &&
        processReport.langGraphTrace.edges.some(
          (edge) =>
            edge.type === "conditional" &&
            edge.condition === "GapDecision.decision == create_agent"
        ),
      `branches=${decisionSummary.uniqueBranches.length}`
    ),
    check(
      "FR-010",
      "判断依据合同",
      decisionSummary.explainableCount === fixtures.length &&
        realInputReplay.status === "pass",
      `fixtures=${decisionSummary.explainableCount}/${fixtures.length}, realInputs=${realInputReplay.cases.length}`
    ),
    check(
      "FR-011",
      "下一步交付物合同",
      decisionSummary.outputFailures === 0,
      "所有 decisionOutput acceptance 均 pass"
    ),
  ];
}

function buildMetricChecks({
  fixtures,
  decisionSummary,
  storeSummary,
  agentEvaluation,
  processReport,
  realInputReplay,
  completeProduct,
}) {
  const stationPackets = processReport.stationPackets ?? {};
  const stationPacketNames = Object.keys(stationPackets);
  const stationSourceLeakCount = /gstack|gbrain|wshobson|anthropic|skill-creator/i.test(
    JSON.stringify(stationPackets)
  )
    ? 1
    : 0;
  return [
    check(
      "gap_decision_explainability",
      "每个 GapDecision 都能说明判断依据",
      decisionSummary.explainableCount === fixtures.length,
      `${decisionSummary.explainableCount}/${fixtures.length}`,
      "100%"
    ),
    check(
      "fake_owner",
      "治理 agent 不伪装成执行 worker",
      decisionSummary.fakeOwnerCount === 0,
      String(decisionSummary.fakeOwnerCount),
      "0"
    ),
    check(
      "missing_verifier",
      "每个 decision 都有 verificationOwner",
      decisionSummary.verifierMissingCount === 0,
      String(decisionSummary.verifierMissingCount),
      "0"
    ),
    check(
      "long_term_identity_pollution",
      "长期身份不写入单次任务细节",
      agentEvaluation.summary.longTermIdentityPollutionCount === 0 &&
        processReport.generatedAgentSpec.identityCleanliness.status === "pass",
      String(agentEvaluation.summary.longTermIdentityPollutionCount),
      "0"
    ),
    check(
      "fixture_pass",
      "Capability Gap fixtures 全通过",
      decisionSummary.uniqueDecisions.length === GAP_DECISIONS.length &&
        decisionSummary.outputFailures === 0,
      `${decisionSummary.uniqueDecisions.length}/${GAP_DECISIONS.length}`,
      "100%"
    ),
    check(
      "run_state_store_coverage",
      "RunStateStore 覆盖 run/event/gap/decision",
      storeSummary.eventCoverage &&
        storeSummary.runs === fixtures.length &&
        storeSummary.gaps === fixtures.length &&
        storeSummary.decisions === fixtures.length,
      `events=${storeSummary.events}`,
      "100%"
    ),
    check(
      "langgraph_branch_coverage",
      "六类 decision 都有条件分支路径",
      decisionSummary.uniqueBranches.length === GAP_DECISIONS.length,
      `${decisionSummary.uniqueBranches.length}/${GAP_DECISIONS.length}`,
      "100%"
    ),
    check(
      "user_correction_replay",
      "用户修正可被记录并回放",
      storeSummary.userFeedback === fixtures.length,
      `${storeSummary.userFeedback}/${fixtures.length}`,
      "tracked baseline"
    ),
    check(
      "station_output_coverage",
      "create_agent 五个治理站点都有产物",
      stationPacketNames.length === 5 &&
        [
          "agentBoundaryDecision",
          "agentLoadoutDecision",
          "agentMemoryDecision",
          "agentDesignReview",
          "agentCandidateGateDecision",
        ].every((name) => Object.hasOwn(stationPackets, name)),
      `${stationPacketNames.length}/5`,
      "100%"
    ),
    check(
      "external_source_wording_leak",
      "公开 station 产物不暴露参考来源名",
      stationSourceLeakCount === 0,
      String(stationSourceLeakCount),
      "0"
    ),
    check(
      "run_scoped_binding_leak",
      "run-scoped 绑定不进入长期身份",
      processReport.generatedAgentSpec.identityCleanliness?.status === "pass" &&
        processReport.evaluation.specEvaluation.failedDimensions.includes(
          "identity_cleanliness"
        ) === false,
      "0",
      "0"
    ),
    check(
      "memory_writeback_bypass",
      "记忆写回不能绕过 Warden",
      String(stationPackets.agentMemoryDecision?.writebackGate ?? "").includes(
        "meta-warden"
      ),
      "0",
      "0"
    ),
    check(
      "missing_return_to_stage",
      "Review station 必须给出 returnToStage",
      stationPackets.agentDesignReview?.returnToStage !== undefined,
      "0",
      "0"
    ),
    check(
      "real_input_replay_pass",
      "真实输入新进程回放通过",
      realInputReplay.status === "pass" &&
        realInputReplay.cases.length === 6 &&
        realInputReplay.stationPacketCoverage === true,
      `${realInputReplay.cases.length}/6`,
      "100%"
    ),
    check(
      "complete_product_mvp_pass",
      "完整产品 MVP 验收入口通过",
      completeProduct.status === "pass",
      completeProduct.status,
      "pass"
    ),
    check(
      "analytics_decision_distribution",
      "Analytics 可查询 decision 分布",
      completeProduct.analytics.decisionDistribution.length === 6,
      `${completeProduct.analytics.decisionDistribution.length}/6`,
      "100%"
    ),
    check(
      "analytics_user_corrections",
      "Analytics 可查询用户纠错分布",
      completeProduct.analytics.userCorrectionDistribution.length >= 2,
      `${completeProduct.analytics.userCorrectionDistribution.length}`,
      ">=2"
    ),
    check(
      "analytics_candidate_acceptance",
      "Analytics 可查询 candidate 接受率",
      completeProduct.analytics.candidateAcceptance.length >= 2,
      `${completeProduct.analytics.candidateAcceptance.length}`,
      ">=2"
    ),
    check(
      "analytics_repeat_keys",
      "Analytics 可查询 repeatKey top list",
      completeProduct.analytics.repeatKeyTopList.length > 0,
      `${completeProduct.analytics.repeatKeyTopList.length}`,
      ">0"
    ),
    check(
      "analytics_owner_failure_rate",
      "Analytics 可查询 owner 失败率",
      completeProduct.analytics.ownerFailureRate.length > 0,
      `${completeProduct.analytics.ownerFailureRate.length}`,
      ">0"
    ),
  ];
}

function renderMarkdown(report) {
  const lines = [
    "# Meta_Kim Core MVP 验收报告",
    "",
    `- 状态：${report.status}`,
    `- 生成时间：${report.generatedAt}`,
    `- 根本目标：${report.rootGoal}`,
    "",
    "## 结论",
    "",
    report.status === "pass"
      ? "当前核心 MVP 的 PRD 验收项都有可复查证据。"
      : "当前核心 MVP 仍有验收缺口，不能声明完成。",
    "",
    "## FR 验收",
    "",
    "| FR | 内容 | 目标 | 实际 | 结果 | 证据 |",
    "|---|---|---|---|---|---|",
    ...report.frChecks.map(
      (item) =>
        `| ${item.id} | ${item.label} | ${item.target} | ${item.actual} | ${item.passed ? "pass" : "fail"} | ${item.evidence} |`
    ),
    "",
    "## 量化指标",
    "",
    "| 指标 | 内容 | 目标 | 实际 | 结果 |",
    "|---|---|---|---|---|",
    ...report.metricChecks.map(
      (item) =>
        `| ${item.id} | ${item.label} | ${item.target} | ${item.actual} | ${item.passed ? "pass" : "fail"} |`
    ),
    "",
    "## 证据入口",
    "",
    ...report.evidence.commands.map((command) => `- \`${command}\``),
    "",
    "## 下一步",
    "",
    report.nextAction,
    "",
  ];
  return `${lines.join("\n")}`;
}

export async function runCoreMvpAcceptance({
  jsonPath = DEFAULT_JSON_PATH,
  markdownPath = DEFAULT_MARKDOWN_PATH,
} = {}) {
  const fixtures = await readJson(FIXTURE_PATH);
  const decisionSummary = summarizeDecisionFixtures(fixtures);
  const storeSummary = await summarizeRunStateStore(fixtures);
  const agentEvaluation = await runEvaluation();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-core-mvp-"));
  const processReport = await runGovernanceAgentProcessMvp({
    statePath: path.join(tempDir, "process.json"),
    markdownPath: path.join(tempDir, "process.md"),
    dbPath: path.join(tempDir, "process.sqlite"),
  });
  const realInputReplay = await runCapabilityGapRealInputReplay({
    jsonPath: path.join(tempDir, "real-input-replay.json"),
    markdownPath: path.join(tempDir, "real-input-replay.md"),
    dbPath: path.join(tempDir, "real-input-replay.sqlite"),
  });
  const completeProduct = await runCapabilityGapCompleteProduct({
    jsonPath: path.join(tempDir, "complete-product.json"),
    markdownPath: path.join(tempDir, "complete-product.md"),
    dbPath: path.join(tempDir, "complete-product.sqlite"),
    preparationStateDir: path.join(path.dirname(jsonPath), "governed-preparation"),
  });
  if (completeProduct.artifactKind === "host_preparation") {
    try {
      return await writeGovernedPreparationReport(completeProduct, {
        jsonPath, markdownPath, consumer: "core_mvp_acceptance",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
  await fs.rm(tempDir, { recursive: true, force: true });

  const frChecks = buildFrChecks({
    fixtures,
    decisionSummary,
    storeSummary,
    agentEvaluation,
    processReport,
    realInputReplay,
    completeProduct,
  });
  const metricChecks = buildMetricChecks({
    fixtures,
    decisionSummary,
    storeSummary,
    agentEvaluation,
    processReport,
    realInputReplay,
    completeProduct,
  });
  const checks = [...frChecks, ...metricChecks];
  const status = statusFrom(checks);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    rootGoal:
      "证明 Meta_Kim 能在发现能力缺口时自然选择 create_skill / create_agent / create_script / create_mcp_provider / worker_task_only / blocked_or_needs_approval，并能把 create_agent 交付为抽象、专业、可验证的治理 agent 设计。",
    decisions: GAP_DECISIONS.map((decision) => ({
      decision,
      branchOwner: DECISION_RULES[decision].owner,
      branchOwnerRole: DECISION_RULES[decision].ownerRole,
    })),
    summary: {
      fixtures: fixtures.length,
      decisionsCovered: decisionSummary.uniqueDecisions.length,
      branchesCovered: decisionSummary.uniqueBranches.length,
      runStateStoreEvents: storeSummary.events,
      candidateWritebacks: storeSummary.candidateWritebacks,
      agentDesignEvaluation: agentEvaluation.acceptance.status,
      governanceProcessMvp: processReport.status,
      stationPacketsCovered: Object.keys(processReport.stationPackets ?? {}).length,
      realInputReplay: realInputReplay.status,
      completeProductMvp: completeProduct.status,
      analyticsMetrics: completeProduct.analytics.metricCount,
    },
    frChecks,
    metricChecks,
    evidence: {
      files: [
        "docs/ai-native-capability-gap-mvp-prd.zh-CN.md",
        "config/contracts/capability-gap-decision-contract.json",
        "config/contracts/capability-gap-output-contract.json",
        "config/contracts/agent-design-quality-contract.json",
        "config/contracts/governance-agent-design-station-contract.json",
        "tests/meta-theory/scenarios/capability-gap-decision-fixtures.json",
      ],
      commands: [
        "npm run meta:core:mvp:acceptance",
        "npm run meta:test:meta-theory",
        "npm run meta:agent-process:mvp",
        "npm run meta:gap:real-input-replay",
        "npm run meta:gap:complete-product:acceptance",
      ],
      generatedReports: {
        json: relative(jsonPath),
        markdown: relative(markdownPath),
      },
    },
    nextAction:
      status === "pass"
        ? "下一步进入真实迭代：用这套验收报告作为门禁，开始升级治理 agent 的实际设定，而不是继续堆新框架。"
        : "先修复 fail 的 FR 或指标，再进入治理 agent 设定升级。",
  };

  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(markdownPath, renderMarkdown(report));
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonPath = path.resolve(argValue(args, "--json-out", DEFAULT_JSON_PATH));
  const markdownPath = path.resolve(
    argValue(args, "--markdown-out", DEFAULT_MARKDOWN_PATH)
  );
  const report = await runCoreMvpAcceptance({ jsonPath, markdownPath });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: report.status,
        summary: report.summary,
        report: relative(markdownPath),
        ...(report.artifactKind === "host_preparation" ? { nextAction: report.nextAction, preparation: report.preparation.status } : {}),
      },
      null,
      2
    )}\n`
  );
  if (report.status !== "pass") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
