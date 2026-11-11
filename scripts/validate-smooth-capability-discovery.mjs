#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  "smooth-capability-discovery-contract.json",
);
const CORE_LOOP_PATH = path.join(REPO_ROOT, "config", "contracts", "core-loop-contract.json");
const PRD_PATH = path.join(REPO_ROOT, "docs", "ai-native-capability-gap-mvp-prd.zh-CN.md");

const REQUIRED_FAMILIES = [
  "governance_agent",
  "execution_agent",
  "skill",
  "command_script",
  "mcp_provider",
  "runtime_tool",
  "ordinary_tool",
  "plugin_connector",
  "retrieval_research",
  "dependency_provider",
  "memory_graph",
  "hook_runtime_adapter",
  "prompt_rule_workflow",
  "worker_task",
];

const REQUIRED_PROVIDER_TYPES = [
  "agent",
  "skill",
  "script",
  "MCP",
  "tool",
  "hook",
  "runtime",
  "OS",
  "memory",
  "graph",
  "external",
];

const REQUIRED_CORE_SOURCES = [
  "canonical/agents",
  "runtime agent mirrors",
  "repo skills",
  "tools, scripts, and package commands",
  "MCP servers and config",
  "hooks",
  "runtime capability matrix",
  "OS compatibility matrix",
  "config/capability-index",
  "Graphify/project map",
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

function sameSet(actual, expected, message) {
  assert.deepEqual([...new Set(actual)].sort(), [...new Set(expected)].sort(), message);
}

function validateContract(contract, coreLoop, pkg) {
  assert.equal(contract.contractId, "smooth-capability-discovery-contract");
  assert.equal(contract.status, "productized");
  assert.equal(contract.prdTaskId, "P-067");
  sameSet(contract.requiredFirstClassCapabilityFamilies, REQUIRED_FAMILIES, "P-067 family set drifted");
  sameSet(
    contract.runtimeProviderTypesRequiredInDefaultArtifact,
    REQUIRED_PROVIDER_TYPES,
    "P-067 runtime provider type set drifted",
  );
  assert.equal(contract.expansionPolicy.noExpansionNeededAllowed, true);
  assert.equal(
    contract.globalProfessionalProviderFirst?.workerTaskBoundary,
    "worker_task is a run-scoped dispatch packet for a selected owner/loadout; it is not a temporary agent identity, subagent definition, or durable provider.",
    "P-067 must preserve workerTask as work order, not temporary agent",
  );
  for (const family of [
    "execution_agent",
    "skill",
    "command_script",
    "mcp_provider",
    "runtime_tool",
    "ordinary_tool",
    "plugin_connector",
    "dependency_provider",
    "memory_graph",
    "hook_runtime_adapter",
    "prompt_rule_workflow",
  ]) {
    assert.ok(
      contract.globalProfessionalProviderFirst?.providerFamilies?.includes(family),
      `globalProfessionalProviderFirst missing provider family ${family}`,
    );
  }
  for (const forbidden of [
    "skill_only_discovery",
    "mcp_or_tool_swallowed_by_skill_or_script",
    "configured_provider_relabelled_as_live_invocation",
    "workerTaskPacket_relabelled_as_execution_agent",
    "temporary_small_agent_created_for_one_run_task",
    "global_professional_provider_skipped_before_create_agent",
    "noExpansionNeeded_rejected_when_route_safe",
  ]) {
    assert.ok(contract.forbiddenBehaviors.includes(forbidden), `missing forbidden behavior ${forbidden}`);
  }
  assert.equal(contract.acceptanceCriteria.skillOnlyTarget, false);
  assert.equal(contract.acceptanceCriteria.overclaimTarget, 0);
  assert.ok(
    /global\/project professional providers/i.test(contract.acceptanceCriteria.professionalProviderFirst ?? ""),
    "P-067 must require global/project professional provider search before agent creation",
  );
  assert.ok(
    /must not be counted as execution_agent providers/i.test(contract.acceptanceCriteria.workerTaskIdentityBoundary ?? ""),
    "P-067 must preserve workerTask identity boundary",
  );

  for (const source of REQUIRED_CORE_SOURCES) {
    assert.ok(
      coreLoop.capabilityDiscovery.minimumSources.includes(source),
      `core-loop capabilityDiscovery.minimumSources must include ${source}`,
    );
  }
  for (const field of [
    "providerType",
    "runtimeSupport",
    "riskLevel",
    "ownerBoundary",
    "canExecute",
    "canReview",
    "canVerify",
    "confidence",
  ]) {
    assert.ok(
      coreLoop.capabilityDiscovery.inventoryRecordRequiredFields.includes(field),
      `core-loop inventory fields must include ${field}`,
    );
  }

  assert.ok(
    pkg.scripts?.["meta:prd:smooth-capability:validate"]?.includes("validate-smooth-capability-discovery.mjs"),
    "package.json missing P-067 validator script",
  );
  assert.ok(
    `${pkg.scripts?.["meta:verify:governance"] ?? ""} ${pkg.scripts?.["meta:verify:governance:core"] ?? ""}`.includes("meta:prd:smooth-capability:validate"),
    "meta:verify:governance must include P-067 validator",
  );
}

function validateDefaultArtifact(report) {
  assert.ok(
    ["pass", "partial"].includes(report.status),
    `default governed run status must be pass or honest partial, got ${report.status}`,
  );
  assert.equal(
    report.defaultRuntimePath.status,
    report.status,
    "defaultRuntimePath.status must mirror the top-level governed run status",
  );
  const discovery = report.coreLoop.fetchPacket.capabilityDiscovery;
  assert.ok(Array.isArray(discovery.searchLog), "capabilityDiscovery.searchLog must be an array");
  assert.ok(discovery.searchLog.length >= 10, "capabilityDiscovery.searchLog must record source families checked");
  assert.ok(
    Array.isArray(discovery.capabilityInventory) && discovery.capabilityInventory.length >= 100,
    "capabilityInventory must be populated from actual discovery",
  );

  const providerTypes = new Set(discovery.capabilityInventory.map((item) => item.providerType));
  for (const providerType of REQUIRED_PROVIDER_TYPES) {
    assert.ok(providerTypes.has(providerType), `default artifact missing providerType ${providerType}`);
  }
  assert.notDeepEqual([...providerTypes].sort(), ["skill"], "capability discovery must not be skill-only");

  const serializedDiscovery = JSON.stringify(discovery);
  for (const marker of ["MCP", "tool", "hook", "runtime", "memory", "graph", "external"]) {
    assert.match(serializedDiscovery, new RegExp(marker), `capability discovery must preserve ${marker}`);
  }
  assert.doesNotMatch(
    serializedDiscovery,
    /configured_provider_relabelled_as_live_invocation|workerTaskPacket_relabelled_as_workerResult|workerTaskPacket_relabelled_as_execution_agent|temporary_small_agent_created_for_one_run_task|global_professional_provider_skipped_before_create_agent/,
    "capability discovery must not contain forbidden overclaim markers",
  );

  const workerTasks = report.coreLoop.thinkingPacket.workerTaskPackets;
  assert.ok(Array.isArray(workerTasks) && workerTasks.length > 0, "workerTaskPackets must stay separate");
  for (const [index, task] of workerTasks.entries()) {
    assert.notEqual(
      task.executionMode,
      "temporary_agent",
      `workerTaskPackets[${index}] must not create a temporary small agent`,
    );
    assert.doesNotMatch(
      JSON.stringify(task),
      /temporary small agent|temporary agent identity|workerTask as agent/i,
      `workerTaskPackets[${index}] must not describe workerTask as an agent identity`,
    );
  }
  assert.equal(
    report.coreLoop.reviewPacket.protocolCompliance.capabilityDiscoveryChecked,
    true,
    "Review must acknowledge capability discovery",
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
    "版本：v0.50",
    "P-067 已测通",
    "smooth-capability-discovery-contract",
    "scripts/validate-smooth-capability-discovery.mjs",
    "npm run meta:prd:smooth-capability:validate",
    "no_expansion_needed",
    "skill-only",
    "MCP 与 tools 作为一等能力",
  ]) {
    assert.ok(prd.includes(marker), `PRD missing marker ${marker}`);
  }
  assert.match(prd, /P-067 \| T-006\/T-008[\s\S]*?\| 已测通 \|/);
  return {
    status: "attached",
    requiredForPublicValidation: true,
    path: "docs/ai-native-capability-gap-mvp-prd.zh-CN.md",
  };
}

async function main() {
  const contract = readJson(CONTRACT_PATH);
  const coreLoop = readJson(CORE_LOOP_PATH);
  const pkg = readJson(path.join(REPO_ROOT, "package.json"));
  validateContract(contract, coreLoop, pkg);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "meta-kim-smooth-capability-"));
  let governedExecutionStatus = "unknown";
  try {
    const report = await runDiagnosticReadPlan(runMetaTheoryGovernedExecution, {
      task: [
        "验证顺滑能力发现：需要同时保留 agent、skill、script、MCP provider、tools、runtime、hook、memory、graph、external dependency 与 workerTask。",
        "只有路线、权限、风险、调用或验证需要时才展开具体子工具；安全时允许 no_expansion_needed。",
      ].join("\n"),
      runId: "validate-smooth-capability-discovery",
      projectRoot: REPO_ROOT,
      stateDir: tempDir,
      dbPath: path.join(tempDir, "runs.sqlite"),
    }, [path.relative(REPO_ROOT, CONTRACT_PATH)]);
    validateDefaultArtifact(report);
    governedExecutionStatus = report.status;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const prdEvidence = validatePrdMarkers();
  process.stdout.write(
    `${JSON.stringify({
      status: "pass",
      governedExecutionStatus,
      contract: "config/contracts/smooth-capability-discovery-contract.json",
      providerTypes: REQUIRED_PROVIDER_TYPES,
      firstClassFamilies: REQUIRED_FAMILIES.length,
      privateEvidence: [prdEvidence],
    }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
