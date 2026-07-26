#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runMetaTheoryGovernedExecution } from "./run-meta-theory-governed-execution.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function atomicWrite(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filePath);
}

function validateGovernedReport(report, runtime, expectedPackage) {
  const failures = [];
  const bridge = report.stageRunnerBridgePacket;
  if (bridge?.status !== "pass") failures.push(`bridge_status:${bridge?.status ?? "missing"}`);
  if (bridge?.runtime !== runtime) failures.push(`runtime:${bridge?.runtime ?? "missing"}`);
  if (bridge?.executionProjection?.durable?.enabled !== true) failures.push("durable_disabled");
  if (bridge?.executionProjection?.durable?.resumed !== false) failures.push("durable_not_fresh");
  if (report.durableExecution?.mode !== "fresh") failures.push("durable_mode");
  if (report.durableExecution?.status !== "materialized") failures.push("durable_materialization");
  if (report.durableExecution?.terminalStatus !== "completed") failures.push("durable_terminal_status");
  if (!Number.isInteger(report.durableExecution?.fenceToken)) failures.push("durable_fence");
  if (!Number.isInteger(report.durableExecution?.cursor)) failures.push("durable_cursor");
  if (!report.durableExecution?.headCheckpointId) failures.push("durable_checkpoint");
  if (JSON.stringify(report.durableExecution ?? {}).includes(path.resolve(report.paths.json, ".."))) {
    failures.push("durable_absolute_path_leak");
  }
  if (bridge?.graphAuthority !== "config/contracts/core-loop-contract.json") {
    failures.push("graph_authority");
  }
  if (!(bridge?.workerResults?.length > 0)) failures.push("worker_results");
  for (const worker of bridge?.workerResults ?? []) {
    if (!worker.sessionId) failures.push(`${worker.taskPacketId}:session`);
    if (!worker.messageId) failures.push(`${worker.taskPacketId}:message`);
    if (!(worker.observedDurationMs > 0)) failures.push(`${worker.taskPacketId}:duration`);
    if (!(worker.toolEventCount > 0)) failures.push(`${worker.taskPacketId}:tool_events`);
    if (!worker.outputText?.includes(expectedPackage.name)) failures.push(`${worker.taskPacketId}:package_name`);
    if (!worker.outputText?.includes(expectedPackage.version)) failures.push(`${worker.taskPacketId}:package_version`);
  }
  const liveEvidence = report.executionResult?.workerExecutionEvidence ?? [];
  if (
    liveEvidence.length === 0 ||
    liveEvidence.some((item) => item.status !== "executed" || item.liveWorkerExecution !== true)
  ) failures.push("execution_truth_not_replaced");
  if (report.langGraphRunPacket?.runtimeExecutionEvidence !== "native_stage_runner_bridge") {
    failures.push("langgraph_runtime_evidence");
  }
  const executionTiming = report.traceEvalControlPlane?.stageTiming?.find(
    (item) => item.stage === "Execution",
  );
  if (!(executionTiming?.observedDurationMs > 0)) failures.push("execution_timing");
  return failures;
}

async function main() {
  const runtimeArg = argValue("--runtime", "both");
  if (!['codex', 'claude', 'both'].includes(runtimeArg)) {
    throw new Error("Use --runtime codex|claude|both");
  }
  const safetyTimeoutMs = Number(argValue("--safety-timeout-ms", "300000"));
  if (!Number.isFinite(safetyTimeoutMs) || safetyTimeoutMs < 10_000) {
    throw new Error("--safety-timeout-ms must be a finite process-safety fuse >= 10000");
  }
  const runtimes = runtimeArg === "both" ? ["codex", "claude"] : [runtimeArg];
  const expectedPackage = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  const acceptanceRunId = `p117-governed-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const outputRoot = path.resolve(
    argValue(
      "--output-dir",
      path.join(repoRoot, ".meta-kim", "state", "default", "stage-runner-governed", acceptanceRunId),
    ),
  );
  const results = [];
  for (const runtime of runtimes) {
    const runtimeRoot = path.join(outputRoot, runtime);
    const report = await runMetaTheoryGovernedExecution({
      task: "Read package.json and report the exact package name and version. This is read-only verification; do not modify files.",
      runId: `${acceptanceRunId}-${runtime}`,
      runtime,
      osTarget: "windows",
      stateDir: runtimeRoot,
      artifactDir: runtimeRoot,
      dbPath: path.join(runtimeRoot, "runs.sqlite"),
      projectRoot: repoRoot,
      projectCapabilityMutationMode: "read_only",
      emitConversationNotice: false,
      stageRunner: {
        enabled: true,
        runtime,
        durableMode: "fresh",
        durableDbPath: path.join(runtimeRoot, "durable-runs.sqlite"),
        capacity: 1,
        timeoutMs: safetyTimeoutMs,
      },
    });
    const failures = validateGovernedReport(report, runtime, expectedPackage);
    results.push({
      runtime,
      status: failures.length === 0 ? "pass" : "failed",
      failures,
      governedArtifactPath: path.relative(repoRoot, report.paths.json),
      bridge: report.stageRunnerBridgePacket,
    });
  }
  const summary = {
    schemaVersion: "stage-runner-governed-acceptance-v0.1",
    prdTaskId: "P-117/P-118",
    runId: acceptanceRunId,
    status: results.every((result) => result.status === "pass") ? "pass" : "failed",
    requiredRuntimes: ["codex", "claude"],
    requestedRuntimes: runtimes,
    entrypoint: "runMetaTheoryGovernedExecution / meta:theory:run",
    graphAuthority: "config/contracts/core-loop-contract.json",
    mode: "durable_read_only_shadow_fresh",
    taskBudget: null,
    timeoutMeaning: "process safety fuse only",
    dockerUsed: false,
    results,
  };
  summary.releaseEligible =
    summary.status === "pass" &&
    runtimes.length === 2 &&
    runtimes.includes("codex") &&
    runtimes.includes("claude");
  const reportPath = path.join(outputRoot, "acceptance.json");
  await atomicWrite(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: summary.status,
    releaseEligible: summary.releaseEligible,
    runId: acceptanceRunId,
    report: path.relative(repoRoot, reportPath),
    results: results.map((result) => ({
      runtime: result.runtime,
      status: result.status,
      failures: result.failures,
      workerCount: result.bridge?.workerResults?.length ?? 0,
      observedDurationMs: result.bridge?.observedDurationMs ?? null,
    })),
  }, null, 2)}\n`);
  if (summary.status !== "pass") process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
