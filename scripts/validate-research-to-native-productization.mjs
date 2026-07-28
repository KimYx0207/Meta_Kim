#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getReportLabels } from "./meta-kim-i18n.mjs";
import { runMetaTheoryGovernedExecution } from "./run-meta-theory-governed-execution.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "research-to-native-productization-contract.json",
);
const FRAMEWORK_PROMPT_CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "framework-prompt-architecture-contract.json",
);
const PRD_PATH = path.join(REPO_ROOT, "docs", "ai-native-capability-gap-mvp-prd.zh-CN.md");
const REQUIRED_TASK_IDS = [
  "P-071",
  "P-072",
  "P-073",
  "P-074",
  "P-075",
  "P-076",
  "P-077",
  "P-078",
  "P-079",
  "P-080",
];
const REQUIRED_MCP_FIELDS = [
  "providerId",
  "owner",
  "trustState",
  "authModel",
  "command",
  "osSupport",
  "runtimeSupport",
  "verificationCommand",
  "conformanceStatus",
];
const REQUIRED_TRACE_FIELDS = [
  "traceId",
  "stageTiming",
  "toolModelRetrievalHandoffMetadata",
  "evalFixtures",
  "costTokenBudget",
];
const REQUIRED_EVENT_FIELDS = [
  "eventType",
  "stage",
  "status",
  "owner",
  "cancelResumeBoundary",
  "stateSync",
  "userFacingLabel",
  "packetDumpPrevented",
];
const LANGUAGES = ["en", "zh-CN", "ja-JP", "ko-KR"];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function assertNonEmpty(value, message) {
  assert.notEqual(value, undefined, message);
  assert.notEqual(value, null, message);
  if (typeof value === "string" || Array.isArray(value)) {
    assert.ok(value.length > 0, message);
  }
}

function flattenKeys(value, prefix = "", bucket = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value === "function") {
    return bucket;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    bucket.push(next);
    flattenKeys(child, next, bucket);
  }
  return bucket;
}

function validateI18nParity() {
  const baseKeys = flattenKeys(getReportLabels("en")).sort();
  for (const lang of LANGUAGES) {
    const keys = flattenKeys(getReportLabels(lang)).sort();
    assert.deepEqual(keys, baseKeys, `${lang} report label keys must match en`);
  }
}

function validateContractShape(contract, pkg) {
  assert.equal(contract.contractId, "research-to-native-productization-contract");
  assert.equal(contract.status, "productized");
  assert.deepEqual(contract.prdTaskIds, REQUIRED_TASK_IDS);
  assert.equal(contract.globalRules.sourceBackedClaimsOnly, true);
  assert.equal(contract.globalRules.candidateProtocolsAreNotBaselineDependencies, true);
  assert.equal(contract.globalRules.configuredProviderIsNotLiveProof, true);

  const rowsByTask = new Map(contract.sourceBackedAdoptionMatrix.map((row) => [row.taskId, row]));
  for (const taskId of REQUIRED_TASK_IDS) {
    assert.ok(rowsByTask.has(taskId), `missing adoption matrix row for ${taskId}`);
    const row = rowsByTask.get(taskId);
    for (const field of contract.globalRules.requiredAdoptionFields) {
      assertNonEmpty(row[field], `${taskId} missing adoption field ${field}`);
    }
    assert.ok(
      contract.globalRules.allowedSourceTypes.includes(row.sourceType),
      `${taskId} has unsupported sourceType ${row.sourceType}`,
    );
    if (row.sourceType === "local_repo_evidence") {
      assert.ok(
        readFileSync(path.join(REPO_ROOT, row.sourceUrl), "utf8").length > 0,
        `${taskId} local evidence source missing ${row.sourceUrl}`,
      );
    } else {
      assert.match(row.sourceUrl, /^https:\/\//, `${taskId} sourceUrl must be https`);
    }
    assert.ok(Array.isArray(row.nativeTargets) && row.nativeTargets.length > 0);
    assert.equal(row.status, "productized");
    assert.equal(row.verificationCommand, "npm run meta:prd:research-native:validate");
  }

  assert.ok(contract.mcpProviderMaturityProfiles.length >= 3, "expected MCP provider profiles");
  for (const profile of contract.mcpProviderMaturityProfiles) {
    for (const field of REQUIRED_MCP_FIELDS) {
      assertNonEmpty(profile[field], `${profile.providerId ?? "provider"} missing ${field}`);
    }
    assert.ok(Array.isArray(profile.osSupport) && profile.osSupport.length > 0);
    assert.ok(Array.isArray(profile.runtimeSupport) && profile.runtimeSupport.length > 0);
    assert.ok(
      !(profile.authModel.includes("local_stdio") && profile.authModel.includes("remote_oauth")),
      `${profile.providerId} must not mix local stdio and remote OAuth`,
    );
    assert.ok(profile.liveProofBoundary, `${profile.providerId} needs live proof boundary`);
  }

  assert.deepEqual(contract.traceEvalControlPlane.requiredFields, REQUIRED_TRACE_FIELDS);
  assert.deepEqual(contract.traceEvalControlPlane.requiredStages, [
    "Critical",
    "Fetch",
    "Thinking",
    "Execution",
    "Review",
    "Meta-Review",
    "Verification",
    "Evolution",
  ]);
  assert.equal(contract.structuredOutputPolicy.firstPassSchemaValidityTarget >= 0.95, true);
  assert.equal(contract.structuredOutputPolicy.missingRequiredFieldTarget, 0);
  assert.equal(contract.promptInjectionBoundary.highRiskAutonomousBypassTarget, 0);
  assert.equal(contract.a2aCandidateProbe.candidateOnly, true);
  assert.equal(contract.a2aCandidateProbe.requiredBaseline, false);
  assert.deepEqual(contract.i18nNativeContentExpansion.languages, LANGUAGES);

  assert.ok(pkg.scripts?.["meta:prd:research-native:validate"]?.includes("validate-research-to-native-productization.mjs"));
  assert.ok(`${pkg.scripts?.["meta:verify:governance"] ?? ""} ${pkg.scripts?.["meta:verify:governance:core"] ?? ""}`.includes("meta:prd:research-native:validate"));
}

function validateDefaultArtifact(report, frameworkPromptContract) {
  const trace = report.coreLoop.traceEvalControlPlane;
  const events = report.coreLoop.agUiStageEvents;
  const perf = report.coreLoop.performanceCostBudget;
  const context = report.coreLoop.contextEngineeringBudget;
  const allowedEvidenceStates = new Set(
    frameworkPromptContract.contextEngineeringBudget.sourceRecordEvidenceStateEnum,
  );

  for (const packetName of [
    "traceEvalControlPlane",
    "agUiStageEvents",
    "performanceCostBudget",
    "contextEngineeringBudget",
  ]) {
    assert.deepEqual(
      report.defaultRuntimePath[packetName],
      report.coreLoop[packetName],
      `defaultRuntimePath must expose ${packetName}`,
    );
  }

  for (const field of REQUIRED_TRACE_FIELDS) {
    assertNonEmpty(trace[field], `traceEvalControlPlane missing ${field}`);
  }
  assert.equal(trace.stageTiming.length, 8);
  for (const stage of [
    "Critical",
    "Fetch",
    "Thinking",
    "Execution",
    "Review",
    "Meta-Review",
    "Verification",
    "Evolution",
  ]) {
    assert.ok(trace.stageTiming.some((entry) => entry.stage === stage), `trace timing missing ${stage}`);
  }
  assert.ok(trace.toolModelRetrievalHandoffMetadata.tools.length > 0);
  assert.ok(trace.toolModelRetrievalHandoffMetadata.retrieval.length > 0);
  assert.ok(trace.toolModelRetrievalHandoffMetadata.handoffs.length > 0);
  assert.ok(trace.evalFixtures.length >= 5);
  assert.equal(trace.costTokenBudget.maxExternalPaidCostWithoutApprovalUsd, 0);
  assert.equal(trace.coverage.coverageStatus, "pass");

  assert.equal(events.eventCount, 8);
  assert.deepEqual(events.localeCoverage, LANGUAGES);
  for (const event of events.events) {
    for (const field of REQUIRED_EVENT_FIELDS) {
      assertNonEmpty(event[field], `event ${event.stage} missing ${field}`);
    }
    assert.equal(event.packetDumpPrevented, true);
    for (const lang of LANGUAGES) {
      assertNonEmpty(event.userFacingLabel[lang], `event ${event.stage} missing ${lang} label`);
    }
  }

  assert.ok(perf.highUsePaths.length >= 6);
  for (const item of perf.highUsePaths) {
    for (const field of ["pathId", "p95LatencyBudgetMs", "tokenBudget", "costBudgetPolicy", "cachePolicy", "promptCachingPolicy"]) {
      assertNonEmpty(item[field], `${item.pathId ?? "highUsePath"} missing ${field}`);
    }
    assert.equal(item.costBudgetPolicy.externalPaidCostWithoutApprovalUsd, 0);
  }

  assert.equal(
    context.status,
    "partial",
    "context budget must remain partial until host-observed context evidence exists",
  );
  assert.match(context.statusReason, /not proof of host-loaded model context/);
  assert.equal(context.measurement.hostObservedContextLoad, false);
  assert.equal(context.measurement.actualInputTokens, null);
  assert.equal(context.measurement.duplicateRuleScanStatus, "not_run");
  assert.equal(context.measurement.conflictingRuleScanStatus, "not_run");
  assert.equal(context.measurement.omissionVerificationStatus, "not_verified");
  for (const blocker of [
    "host_context_load_not_observed",
    "actual_input_tokens_not_measured",
    "duplicate_rule_scan_not_run",
    "conflicting_rule_scan_not_run",
    "omission_not_verified",
  ]) {
    assert.ok(context.blockedBy.includes(blocker), `context budget missing blocker ${blocker}`);
  }
  assert.ok(context.fixedContext.length >= 3);
  assert.ok(context.variableContext.length > 0);
  for (const item of [...context.fixedContext, ...context.variableContext]) {
    for (const field of ["source", "freshness", "reasonIncluded", "evidenceState"]) {
      assertNonEmpty(item[field], `context source missing ${field}`);
    }
    assert.ok(
      allowedEvidenceStates.has(item.evidenceState),
      `context source ${item.source} has invalid evidenceState ${item.evidenceState}`,
    );
    assert.ok(Object.hasOwn(item, "reasonOmitted"), "context source must declare reasonOmitted");
  }
  assert.equal(context.budgetRules.fixedVariableContextSeparated, true);
  assert.equal(context.budgetRules.runtimeOnlyLeakReturnsToThinking, true);

  const scopedPacketText = JSON.stringify({ trace, events, perf, context });
  assert.doesNotMatch(scopedPacketText, /[A-Za-z]:[\\/]/, "research/native packets must not leak local absolute paths");
}

function validatePrdMarkers() {
  if (!existsSync(PRD_PATH)) {
    return {
      status: "private_evidence_not_attached",
      requiredForPublicValidation: false,
      path: "docs/ai-native-capability-gap-mvp-prd.zh-CN.md",
    };
  }
  const prd = readFileSync(PRD_PATH, "utf8");
  for (const marker of [
    "版本：v0.49",
    "v0.49 P-071 到 P-084 Research-to-native + framework prompt architecture productization closure",
    "research-to-native-productization-contract",
    "meta:prd:research-native:validate",
    "P-071 到 P-080 已测通",
    "P-071 到 P-084 已测通",
  ]) {
    assert.ok(prd.includes(marker), `PRD missing marker ${marker}`);
  }
  return {
    status: "attached",
    requiredForPublicValidation: true,
    path: "docs/ai-native-capability-gap-mvp-prd.zh-CN.md",
  };
}

function validateDefaultRunStatus(report) {
  assert.ok(
    ["pass", "partial"].includes(report.status),
    `default governed run status must be pass or honest partial, got ${report.status}`,
  );
  assert.equal(
    report.defaultRuntimePath.status,
    report.status,
    "defaultRuntimePath.status must mirror the top-level governed run status",
  );
  if (report.status === "partial") {
    assert.equal(
      report.coreLoop.capabilityInvocationTruthPacket.realInvocationCoverage.status,
      "partial",
    );
  }
}

async function main() {
  const contract = readJson(CONTRACT_PATH);
  const frameworkPromptContract = readJson(FRAMEWORK_PROMPT_CONTRACT_PATH);
  const pkg = readJson(path.join(REPO_ROOT, "package.json"));
  validateI18nParity();
  validateContractShape(contract, pkg);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-research-native-"));
  let governedExecutionStatus = "unknown";
  try {
    const report = await runMetaTheoryGovernedExecution({
      task: [
        "同一套 PRD review standard 需要 skill。",
        "长期 test coverage owner 需要 agent。",
        "release summary JSON 需要脚本。",
        "内部知识库需要 MCP provider 边界。",
      ].join("\n"),
      runId: "validate-research-to-native-productization",
      stateDir: tempDir,
      dbPath: path.join(tempDir, "runs.sqlite"),
    });
    validateDefaultRunStatus(report);
    validateDefaultArtifact(report, frameworkPromptContract);
    governedExecutionStatus = report.status;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const prdEvidence = validatePrdMarkers();
  process.stdout.write(
    `${JSON.stringify({
      status: "pass",
      governedExecutionStatus,
      contract: "config/contracts/research-to-native-productization-contract.json",
      tasks: REQUIRED_TASK_IDS,
      adoptionRows: contract.sourceBackedAdoptionMatrix.length,
      mcpProviderProfiles: contract.mcpProviderMaturityProfiles.length,
      privateEvidence: [prdEvidence],
    }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
