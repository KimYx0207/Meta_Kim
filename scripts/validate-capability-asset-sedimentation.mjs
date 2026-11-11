#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runMetaTheoryGovernedExecution } from "./run-meta-theory-governed-execution.mjs";
import { runDiagnosticReadPlan } from "./diagnostic-host-protocol.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "capability-asset-sedimentation-contract.json"
);

const REQUIRED_TYPES = [
  "execution_agent",
  "skill",
  "script",
  "mcp_provider",
  "runtime_tool",
  "hook",
  "memory_graph",
  "dependency_provider",
  "worker_task_only"
];

const FORBIDDEN_IDENTITY_MARKERS = [
  "today task",
  "runtime nickname",
  "temporary worker"
];

function readContract() {
  return JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
}

function validateContractShape(contract) {
  assert.equal(contract.contractId, "meta-kim-capability-asset-sedimentation-contract");
  assert.equal(contract.owner, "meta-sentinel");
  assert.equal(contract.approvalBoundary.wardenApprovalRequiredForCanonicalWrites, true);
  assert.equal(contract.approvalBoundary.canonicalWritesWithoutApproval, 0);
  assert.equal(contract.approvalBoundary.runtimeMirrorsGeneratedBySyncOnly, true);
  assert.equal(contract.approvalBoundary.credentialsNeverSedimented, true);

  for (const type of REQUIRED_TYPES) {
    assert.ok(contract.requiredCandidateTypes.includes(type), `requiredCandidateTypes missing ${type}`);
    const policy = contract.candidatePolicies[type];
    assert.ok(policy, `candidatePolicies missing ${type}`);
    assert.ok(policy.longTermTrigger, `${type} missing longTermTrigger`);
    assert.ok(Array.isArray(policy.sedimentationTargets), `${type} sedimentationTargets must be an array`);
    assert.ok(policy.sedimentationTargets.length > 0, `${type} needs at least one sedimentation target`);
    assert.ok(Array.isArray(policy.projectionTargets), `${type} projectionTargets must be an array`);
    assert.ok(Array.isArray(policy.forbiddenDurableIdentity), `${type} forbiddenDurableIdentity must be an array`);
  }

  assert.equal(
    contract.candidatePolicies.worker_task_only.forbidCanonicalIdentity,
    true,
    "worker_task_only must be forbidden from durable identity"
  );
  assert.deepEqual(
    contract.candidatePolicies.worker_task_only.sedimentationTargets,
    ["run-scoped artifact only"],
    "worker_task_only can only sediment into run-scoped artifacts"
  );
  for (const marker of FORBIDDEN_IDENTITY_MARKERS) {
    assert.ok(
      contract.candidatePolicies.worker_task_only.forbiddenDurableIdentity.includes(marker),
      `worker_task_only must forbid ${marker}`
    );
  }

  for (const type of ["execution_agent", "skill", "mcp_provider", "runtime_tool", "hook", "dependency_provider"]) {
    assert.equal(
      contract.candidatePolicies[type].requiresWardenApproval,
      true,
      `${type} long-term sedimentation must require Warden approval`
    );
  }
}

async function validateDefaultWritebackBoundary() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-asset-sedimentation-"));
  try {
    const report = await runDiagnosticReadPlan(runMetaTheoryGovernedExecution, {
      task: [
        "同一套 PRD review standard 需要 skill。",
        "长期 test coverage owner 需要 agent。"
      ].join("\n"),
      runId: "validate-capability-asset-sedimentation",
      projectRoot: REPO_ROOT,
      stateDir: tempDir,
      dbPath: path.join(tempDir, "runs.sqlite"),
      canonicalRoot: path.join(tempDir, "canonical")
    }, [path.relative(REPO_ROOT, CONTRACT_PATH)]);

    assert.equal(report.wardenWritebackFlow.status, "candidate_only");
    assert.equal(report.wardenWritebackFlow.approvalRequired, true);
    assert.equal(report.wardenWritebackFlow.approvalValidation.ok, false);
    assert.equal(report.wardenWritebackFlow.dryRun.canonicalWrites, 0);
    assert.equal(report.coreLoop.evolutionWritebackDecision.canonicalWrites, 0);
    assert.ok(report.wardenWritebackFlow.candidates.length > 0);
    for (const candidate of report.wardenWritebackFlow.candidates) {
      assert.equal(candidate.writebackDecision, "candidate_only");
      assert.equal(candidate.applyStatus, "planned");
      assert.equal(candidate.dryRunArtifact.canonicalWrites, 0);
      assert.ok(
        candidate.targetRelativeToCanonical || candidate.target,
        "long-term candidate must declare a sedimentation target"
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const contract = readContract();
  validateContractShape(contract);
  await validateDefaultWritebackBoundary();
  process.stdout.write(
    `${JSON.stringify({
      status: "pass",
      contract: path.relative(REPO_ROOT, CONTRACT_PATH).replaceAll("\\", "/"),
      requiredCandidateTypes: REQUIRED_TYPES.length,
      canonicalWritesWithoutApproval: 0
    }, null, 2)}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
