#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runMetaTheoryGovernedExecution } from "./run-meta-theory-governed-execution.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "framework-prompt-architecture-contract.json",
);
const PRD_PATH = path.join(REPO_ROOT, "docs", "ai-native-capability-gap-mvp-prd.zh-CN.md");
const REQUIRED_LAYERS = [
  "system-developer",
  "agents-project-rules",
  "canonical-agent-soul",
  "skill-prompt",
  "workflow-contract-prompt",
  "runtime-adapter-prompt",
  "eval-fixture-prompt",
];
const REQUIRED_LAYER_FIELDS = [
  "layerId",
  "owner",
  "scope",
  "inputContract",
  "outputContract",
  "fallbackPolicy",
  "evalPolicy",
  "versionPolicy",
  "forbiddenMixing",
];
const REQUIRED_DIMENSIONS = [
  "clarity",
  "context-separation",
  "examples-counterexamples",
  "output-contract",
  "tool-data-policy",
  "safety-fallback",
  "versioning",
  "performance",
];
const REQUIRED_FIXTURE_TYPES = ["positive", "boundary", "regression"];
const REQUIRED_CONTEXT_EVIDENCE_STATES = [
  "declared_not_host_observed",
  "selected_not_host_observed_as_model_context",
  "generated_not_host_observed_as_model_context",
  "host_observed_as_model_context",
];

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

function validateContractShape(contract, pkg) {
  assert.equal(contract.contractId, "framework-prompt-architecture-contract");
  assert.equal(contract.status, "productized");
  assert.deepEqual(contract.prdTaskIds, ["P-081", "P-082", "P-083", "P-084"]);
  assert.deepEqual(contract.primaryRuntimeTier, ["claude_code", "codex"]);
  assert.deepEqual(contract.compatibilityRuntimeTier, ["cursor", "openclaw"]);
  assert.ok(contract.sourceGuidance.length >= 7, "prompt architecture must cite source guidance");
  for (const source of contract.sourceGuidance) {
    for (const field of ["sourceId", "url", "sourceType", "claimUsed"]) {
      assertNonEmpty(source[field], `${source.sourceId ?? "source"} missing ${field}`);
    }
    assert.match(source.url, /^https:\/\//, `${source.sourceId} source URL must be https`);
  }

  const layers = new Map(contract.promptAssetLayers.map((layer) => [layer.layerId, layer]));
  assert.deepEqual([...layers.keys()], REQUIRED_LAYERS);
  for (const layerId of REQUIRED_LAYERS) {
    const layer = layers.get(layerId);
    for (const field of REQUIRED_LAYER_FIELDS) {
      assertNonEmpty(layer[field], `${layerId} missing ${field}`);
    }
    assert.ok(Array.isArray(layer.inputContract) && layer.inputContract.length > 0);
    assert.ok(Array.isArray(layer.outputContract) && layer.outputContract.length > 0);
    assert.ok(Array.isArray(layer.forbiddenMixing) && layer.forbiddenMixing.length > 0);
  }

  const dimensions = new Map(contract.promptAssetReviewMatrix.map((dimension) => [dimension.dimensionId, dimension]));
  assert.deepEqual([...dimensions.keys()], REQUIRED_DIMENSIONS);
  for (const dimensionId of REQUIRED_DIMENSIONS) {
    const dimension = dimensions.get(dimensionId);
    for (const field of ["sourceRefs", "question", "failureMode", "requiredEvidence"]) {
      assertNonEmpty(dimension[field], `${dimensionId} missing ${field}`);
    }
    assert.ok(Array.isArray(dimension.sourceRefs) && dimension.sourceRefs.length > 0);
    assert.ok(Array.isArray(dimension.requiredEvidence) && dimension.requiredEvidence.length > 0);
  }

  const fixtures = contract.promptEvalRegressionSuite.fixtureFamilies ?? [];
  const fixtureTypes = new Set(fixtures.map((fixture) => fixture.fixtureType));
  for (const type of REQUIRED_FIXTURE_TYPES) {
    assert.ok(fixtureTypes.has(type), `missing ${type} prompt fixture`);
    assert.equal(
      contract.promptEvalRegressionSuite.minimumFixturesPerDurablePromptChange[type],
      1,
      `${type} fixture minimum must be 1`,
    );
  }
  assert.equal(contract.promptEvalRegressionSuite.repeatAmbiguityReductionTarget, 0.3);
  assert.equal(contract.promptEvalRegressionSuite.manualAcceptanceCanSupplementButNotReplaceFixtures, true);

  const context = contract.contextEngineeringBudget;
  for (const field of [
    "sourceRecordsRequiredFields",
    "sourceRecordEvidenceStateEnum",
    "fixedContextKinds",
    "variableContextKinds",
    "longContextRule",
    "returnToThinkingTriggers",
    "promptSprawlBudget",
    "runtimeTruthRequirements",
  ]) {
    assertNonEmpty(context[field], `contextEngineeringBudget missing ${field}`);
  }
  for (const trigger of ["duplicate_rule", "conflicting_rule", "runtime_only_schema_leak"]) {
    assert.ok(context.returnToThinkingTriggers.includes(trigger), `missing return-to-Thinking trigger ${trigger}`);
  }
  assert.equal(context.promptSprawlBudget.duplicateRuleTarget, 0);
  assert.equal(context.promptSprawlBudget.runtimeOnlyLeakTarget, 0);
  assert.ok(context.sourceRecordsRequiredFields.includes("evidenceState"));
  assert.deepEqual(
    context.sourceRecordEvidenceStateEnum,
    REQUIRED_CONTEXT_EVIDENCE_STATES,
    "context source evidence states must use the contract enum",
  );
  assert.equal(context.runtimeTruthRequirements.declaredOrSelectedSourceIsNotLoadedEvidence, true);
  assert.equal(context.runtimeTruthRequirements.hostObservedContextLoadRequiredForPass, true);
  assert.equal(context.runtimeTruthRequirements.actualInputTokensRequiredForPass, true);
  assert.deepEqual(context.runtimeTruthRequirements.completedChecksRequiredForPass, [
    "duplicate_rule_scan",
    "conflicting_rule_scan",
    "omission_verification",
  ]);

  assert.ok(pkg.scripts?.["meta:prd:prompt-architecture:validate"]?.includes("validate-framework-prompt-architecture.mjs"));
  assert.ok(`${pkg.scripts?.["meta:verify:governance"] ?? ""} ${pkg.scripts?.["meta:verify:governance:core"] ?? ""}`.includes("meta:prd:prompt-architecture:validate"));
}

function validateDefaultArtifact(report, contract) {
  const context = report.coreLoop.contextEngineeringBudget;
  const allowedEvidenceStates = new Set(
    contract.contextEngineeringBudget.sourceRecordEvidenceStateEnum,
  );
  assert.equal(context.prdTaskId, "P-084");
  assert.equal(
    context.status,
    "partial",
    "context budget cannot pass without host-observed loading and completed budget scans",
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
  for (const source of [...context.fixedContext, ...context.variableContext]) {
    for (const field of ["source", "freshness", "reasonIncluded", "evidenceState"]) {
      assertNonEmpty(source[field], `context source missing ${field}`);
    }
    assert.ok(
      allowedEvidenceStates.has(source.evidenceState),
      `context source ${source.source} has invalid evidenceState ${source.evidenceState}`,
    );
    assert.ok(Object.hasOwn(source, "reasonOmitted"), "context source must include reasonOmitted");
  }
  assert.equal(
    [...context.fixedContext, ...context.variableContext].some(
      (source) => source.evidenceState === "host_observed_as_model_context",
    ),
    false,
    "default partial artifact must not claim host-observed context evidence",
  );
  assert.equal(context.budgetRules.longContextOnlyForRouteChangingEvidence, true);
  assert.equal(context.budgetRules.duplicateRulesReturnToThinking, true);
  assert.equal(context.budgetRules.runtimeOnlyLeakReturnsToThinking, true);

  const promptRelevantPackets = {
    contextEngineeringBudget: report.coreLoop.contextEngineeringBudget,
    traceEvalControlPlane: report.coreLoop.traceEvalControlPlane,
    agUiStageEvents: report.coreLoop.agUiStageEvents,
  };
  assert.doesNotMatch(
    JSON.stringify(promptRelevantPackets),
    /[A-Za-z]:[\\/]/,
    "prompt architecture packets must not leak local absolute paths",
  );
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
    "framework-prompt-architecture-contract",
    "meta:prd:prompt-architecture:validate",
    "P-081 到 P-084 已测通",
    "Prompt asset review matrix 已产品化",
    "Prompt eval and regression suite 已产品化",
    "Context engineering and prompt sprawl budget 已产品化",
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
  const pkg = readJson(path.join(REPO_ROOT, "package.json"));
  validateContractShape(contract, pkg);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-prompt-architecture-"));
  let governedExecutionStatus = "unknown";
  try {
    const report = await runMetaTheoryGovernedExecution({
      task: [
        "一个 framework prompt 需要通过 Claude Code 和 Codex 主链路。",
        "不能覆盖 planning-with-files，只能迭代更新。",
        "需要保留 findskill、hookprompt、skill-creator 这类抽象能力触发边界。",
      ].join("\n"),
      runId: "validate-framework-prompt-architecture",
      stateDir: tempDir,
      dbPath: path.join(tempDir, "runs.sqlite"),
    });
    validateDefaultRunStatus(report);
    validateDefaultArtifact(report, contract);
    governedExecutionStatus = report.status;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const prdEvidence = validatePrdMarkers();
  process.stdout.write(
    `${JSON.stringify({
      status: "pass",
      governedExecutionStatus,
      contract: "config/contracts/framework-prompt-architecture-contract.json",
      layers: REQUIRED_LAYERS.length,
      reviewDimensions: REQUIRED_DIMENSIONS.length,
      fixtureTypes: REQUIRED_FIXTURE_TYPES,
      privateEvidence: [prdEvidence],
    }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
