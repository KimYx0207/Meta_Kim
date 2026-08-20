#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "runtime-priority-and-compatibility-contract.json",
);
const STAGE_CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "prompt-first-full-flow-stage-contract.json",
);
const LIVE_CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "prompt-first-live-acceptance-contract.json",
);
const PRD_PATH = path.join(REPO_ROOT, "docs", "ai-native-capability-gap-mvp-prd.zh-CN.md");
const FIXTURE_ARTIFACT_PATH = path.join(
  REPO_ROOT,
  ".meta-kim",
  "state",
  "default",
  "prompt-first-full-flow-live-acceptance",
  "latest.fixture.json",
);

const PRIMARY = ["claude_code", "codex"];
const BETA_COMPATIBILITY = ["zcode", "deepseek-harness", "qoder", "trae"];
const COMPATIBILITY = ["cursor", "openclaw"];
const PRIORITY_ORDER = ["primary", "beta_compatibility", "compatibility"];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sameSet(actual, expected, message) {
  assert.deepEqual([...new Set(actual)].sort(), [...new Set(expected)].sort(), message);
}

function validateContractShape(contract, stageContract, liveContract, pkg) {
  assert.equal(contract.contractId, "runtime-priority-and-compatibility-contract");
  assert.equal(contract.status, "productized");
  sameSet(contract.prdTaskIds, ["P-085", "P-092"], "runtime contract task ids drifted");
  sameSet(contract.primaryRuntimeTier, PRIMARY, "runtime contract primary tier drifted");
  sameSet(contract.betaCompatibilityRuntimeTier, BETA_COMPATIBILITY, "runtime contract beta compatibility tier drifted");
  sameSet(contract.compatibilityRuntimeTier, COMPATIBILITY, "runtime contract compatibility tier drifted");
  assert.deepEqual(contract.priorityOrder, PRIORITY_ORDER, "runtime contract priority order drifted");
  assert.equal(contract.primaryRequiredEvidenceKind, "runtime_live_pass");
  for (const kind of [
    "compatibility_smoke_pass",
    "projection_smoke",
    "blocked_with_contract",
    "native_harness_missing",
    "candidate_probe",
    "packed_structural_adapter",
  ]) {
    assert.ok(contract.compatibilityAllowedEvidenceKinds.includes(kind), `missing compatibility kind ${kind}`);
  }
  assert.deepEqual(contract.betaCompatibilityAllowedEvidenceKinds, ["packed_structural_adapter"]);
  assert.deepEqual(contract.priorityRules.primaryClosureTasks, [
    "P-087",
    "P-088",
    "P-089",
    "P-090",
    "P-091",
  ]);
  assert.equal(contract.priorityRules.compatibilityDoesNotBlockPrimary, true);
  assert.equal(contract.priorityRules.betaCompatibilityDoesNotBlockPrimary, true);
  assert.equal(contract.priorityRules.compatibilityDoesNotBlockBetaCompatibility, true);
  assert.equal(contract.priorityRules.cursorNativeLiveBlockedOnlyBlocksAllToolCompatibility, true);
  assert.equal(contract.priorityRules.p024BlocksOnly, "all-tool compatibility claim");
  assert.equal(contract.priorityRules.compatibilityPriorityLeakTarget, 0);
  assert.equal(contract.priorityRules.betaCompatibilityPriorityLeakTarget, 0);
  assert.equal(contract.priorityRules.openclawCursorPrimaryBlockerTarget, 0);
  assert.equal(contract.compatibilityDemotion.openclaw.tier, "compatibility");
  assert.equal(contract.compatibilityDemotion.cursor.tier, "compatibility");
  for (const runtimeId of BETA_COMPATIBILITY) {
    assert.equal(contract.compatibilityDemotion[runtimeId].tier, "beta_compatibility");
    assert.deepEqual(contract.compatibilityDemotion[runtimeId].notAllowedToBlock, [
      "Claude Code primary release gate",
      "Codex primary release gate",
    ]);
  }
  assert.ok(contract.noOverclaimRules.some((rule) => /packed structural adapter/u.test(rule)));
  assert.ok(contract.noOverclaimRules.some((rule) => /live-certified/u.test(rule)));

  sameSet(stageContract.primaryRuntimeTier, PRIMARY, "stage contract primary tier drifted");
  sameSet(stageContract.compatibilityRuntimeTier, COMPATIBILITY, "stage contract compatibility tier drifted");
  sameSet(liveContract.primaryRuntimeTier, PRIMARY, "live contract primary tier drifted");
  sameSet(liveContract.compatibilityRuntimeTier, COMPATIBILITY, "live contract compatibility tier drifted");
  assert.equal(liveContract.requiredRuntimeEvidenceKind, "runtime_live_pass");
  assert.equal(liveContract.requiredCompatibilitySmokeEvidenceKind, "compatibility_smoke_pass");
  sameSet(liveContract.compatibilitySmoke.runtimes, COMPATIBILITY, "compatibility smoke runtimes drifted");
  assert.equal(liveContract.compatibilitySmoke.cannotClaimPrimaryLivePass, true);
  assert.equal(liveContract.compatibilitySmoke.smokeFailureBlocksAcceptanceRun, true);
  assert.ok(
    liveContract.compatibilitySmoke.verificationCommands.some((command) => command.includes("--runtime=openclaw")),
    "OpenClaw compatibility smoke command missing",
  );
  assert.ok(
    liveContract.compatibilitySmoke.verificationCommands.some((command) => command.includes("--runtime=cursor")),
    "Cursor compatibility smoke command missing",
  );

  assert.ok(
    pkg.scripts?.["meta:prd:runtime-priority:validate"]?.includes(
      "validate-runtime-priority-and-compatibility.mjs",
    ),
    "package.json missing runtime priority validator",
  );
  assert.ok(
    `${pkg.scripts?.["meta:verify:governance"] ?? ""} ${pkg.scripts?.["meta:verify:governance:core"] ?? ""}`.includes("meta:prd:runtime-priority:validate"),
    "meta:verify:governance must include runtime priority validator",
  );
}

function validateFixtureArtifact() {
  const stdout = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "run-prompt-first-full-flow-live-acceptance.mjs"), "--fixture"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.match(stdout, /prompt-first full-flow fixture acceptance valid/);
  assert.match(stdout, /compatibilitySmoke=openclaw:passed,cursor:passed/);

  const artifact = readJson(FIXTURE_ARTIFACT_PATH);
  assert.equal(artifact.mode, "fixture");
  sameSet(artifact.requestedRuntimes, PRIMARY, "fixture requested runtimes must be primary only");
  sameSet(artifact.compatibilitySmokeRuntimes, COMPATIBILITY, "fixture compatibility runtimes drifted");
  assert.equal(artifact.compatibilitySmokePacket.status, "pass");
  assert.equal(artifact.compatibilitySmokePacket.primaryLiveClaimAllowed, false);
  assert.equal(artifact.compatibilitySmokeResults.openclaw.evidenceKind, "compatibility_smoke_pass");
  assert.equal(artifact.compatibilitySmokeResults.cursor.evidenceKind, "compatibility_smoke_pass");
  assert.equal(artifact.summary.fixtureModeCannotClaimLivePass, true);
  assert.equal(artifact.summary.primaryRuntimePerfection, false);
  for (const taskId of ["P-089", "P-090", "P-091"]) {
    assert.equal(artifact.prdTaskStatuses[taskId], "pass", `${taskId} must pass in fixture regression`);
  }
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
    "版本：v0.50",
    "P-085 已测通",
    "P-092 已测通",
    "runtime-priority-and-compatibility-contract",
    "scripts/validate-runtime-priority-and-compatibility.mjs",
    "npm run meta:prd:runtime-priority:validate",
    "compatibility-priority leak count = 0",
    "P-024 只影响 all-tool compatibility claim",
    "OpenClaw / Cursor compatibility demotion",
    "Primary runtime perfection",
  ]) {
    assert.ok(prd.includes(marker), `PRD missing marker ${marker}`);
  }
  assert.match(prd, /P-085 \| T-011\/R-007\/R-008[\s\S]*?\| 已测通 \|/);
  assert.match(prd, /P-092 \| T-002\/T-011\/R-008[\s\S]*?\| 已测通 \|/);
  assert.doesNotMatch(
    prd,
    /Primary release closure[\s\S]{0,220}P-024 解阻后/,
    "primary release closure must not wait for P-024",
  );
  return {
    status: "attached",
    requiredForPublicValidation: true,
    path: "docs/ai-native-capability-gap-mvp-prd.zh-CN.md",
  };
}

function main() {
  const contract = readJson(CONTRACT_PATH);
  const stageContract = readJson(STAGE_CONTRACT_PATH);
  const liveContract = readJson(LIVE_CONTRACT_PATH);
  const pkg = readJson(path.join(REPO_ROOT, "package.json"));

  validateContractShape(contract, stageContract, liveContract, pkg);
  validateFixtureArtifact();
  const prdEvidence = validatePrdMarkers();
  process.stdout.write(
    `${JSON.stringify({
      status: "pass",
      contract: "config/contracts/runtime-priority-and-compatibility-contract.json",
      primaryRuntimeTier: PRIMARY,
      betaCompatibilityRuntimeTier: BETA_COMPATIBILITY,
      compatibilityRuntimeTier: COMPATIBILITY,
      priorityOrder: PRIORITY_ORDER,
      compatibilityPriorityLeakTarget: 0,
      betaCompatibilityPriorityLeakTarget: 0,
      privateEvidence: [prdEvidence],
    }, null, 2)}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
}
