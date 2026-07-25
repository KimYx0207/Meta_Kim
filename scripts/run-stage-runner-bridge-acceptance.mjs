#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  runStageRunnerBridge,
} from "./governed-execution/stage-runner-bridge.mjs";
import {
  buildStageDagPacket,
} from "./governed-execution/stage-dag.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function lane(taskPacketId, scopeFile) {
  return {
    laneId: taskPacketId,
    laneKind: "execution_worker",
    ownerBindingRef: `acceptance-owner:${taskPacketId}`,
    capabilityBindingRef: `p117-read-only:${taskPacketId}`,
    effectClass: "read_only_worker",
    resourceScopes: [`file:${scopeFile}`],
    isolation: "shared_read_only",
    status: "planned_not_invoked",
  };
}

function packet(taskPacketId, description, scopeFile) {
  return {
    taskPacketId,
    owner: "test",
    ownerAgent: "test-automator",
    workType: "verification",
    description,
    output: "A concise evidence-backed answer containing the exact requested fact.",
    acceptanceCriteria: ["Use a read/search tool", "Report the exact observed value"],
    scopeFiles: [scopeFile],
    shardScope: [scopeFile],
    nonGoals: ["No project mutation", "No install, commit, push, or publication"],
    dependsOn: [],
    executionMode: "primary_execution",
    externalWriteBoundary: false,
  };
}

function scenarioDefinition(scenario) {
  if (scenario === "sequential") {
    const packets = [
      packet(
        "read-package-version",
        "Read package.json and report the exact package name and version.",
        "package.json",
      ),
    ];
    return {
      expectedWorkers: 1,
      expectedMarkers: {
        "read-package-version": ["meta-kim-p117-fixture", "1.0.0"],
      },
      packets,
      dag: buildStageDagPacket({
        stageOrder: ["Execution"],
        stageLanes: { Execution: [lane(packets[0].taskPacketId, "package.json")] },
        runtimeCapacity: 1,
      }),
    };
  }
  if (scenario === "fanout_merge") {
    const packets = [
      packet(
        "read-release-heading",
        "Read CHANGELOG.md and report the exact first release heading.",
        "CHANGELOG.md",
      ),
      packet(
        "read-verification-marker",
        "Read verification.txt and report the exact verification marker.",
        "verification.txt",
      ),
    ];
    return {
      expectedWorkers: 2,
      expectedMarkers: {
        "read-release-heading": ["# v1.0.0 - P-117 fixture"],
        "read-verification-marker": ["P117-DUAL-RUNTIME-READ-ONLY"],
      },
      packets,
      dag: buildStageDagPacket({
        stageOrder: ["Execution"],
        stageLanes: {
          Execution: [
            lane(packets[0].taskPacketId, "CHANGELOG.md"),
            lane(packets[1].taskPacketId, "verification.txt"),
          ],
        },
        runtimeCapacity: 2,
      }),
    };
  }
  throw new Error(`Unsupported scenario: ${scenario}`);
}

function intervalsOverlap(results) {
  if (results.length < 2) return false;
  const starts = results.map((result) => Date.parse(result.startedAt));
  const ends = results.map((result) => Date.parse(result.endedAt));
  return Math.max(...starts) < Math.min(...ends);
}

function validateScenarioResult(result, definition, scenario) {
  const failures = [];
  if (result.status !== "pass") failures.push(`bridge_status:${result.status}`);
  if (result.graphAuthority !== "config/contracts/core-loop-contract.json") {
    failures.push("graph_authority");
  }
  if (result.workerResults.length !== definition.expectedWorkers) {
    failures.push(`worker_count:${result.workerResults.length}`);
  }
  for (const worker of result.workerResults) {
    if (!(worker.observedDurationMs > 0)) failures.push(`${worker.taskPacketId}:duration`);
    if (!worker.sessionId) failures.push(`${worker.taskPacketId}:session`);
    if (!worker.messageId) failures.push(`${worker.taskPacketId}:message`);
    if (!worker.outputSha256) failures.push(`${worker.taskPacketId}:output_digest`);
    if (!(worker.hostEventCount > 0)) failures.push(`${worker.taskPacketId}:host_events`);
    if (!(worker.toolEventCount > 0)) failures.push(`${worker.taskPacketId}:tool_events`);
    if (!worker.outputText) failures.push(`${worker.taskPacketId}:output_text`);
    for (const marker of definition.expectedMarkers[worker.taskPacketId] ?? []) {
      if (!worker.outputText?.includes(marker)) {
        failures.push(`${worker.taskPacketId}:missing_marker:${marker}`);
      }
    }
  }
  const merge = result.nodeRecords.find((record) => record.laneKind === "stage_merge");
  if (merge?.status !== "completed" || !(merge.observedDurationMs > 0)) {
    failures.push("merge_node");
  }
  if (scenario === "fanout_merge" && !intervalsOverlap(result.workerResults)) {
    failures.push("native_intervals_do_not_overlap");
  }
  return failures;
}

async function atomicWrite(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, filePath);
}

async function createFixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-p117-stage-runner-"));
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "meta-kim-p117-fixture", version: "1.0.0" }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(root, "CHANGELOG.md"), "# v1.0.0 - P-117 fixture\n", "utf8");
  await fs.writeFile(path.join(root, "verification.txt"), "P117-DUAL-RUNTIME-READ-ONLY\n", "utf8");
  return root;
}

async function main() {
  const runtimeArg = argValue("--runtime", null);
  if (!runtimeArg || !["codex", "claude", "both"].includes(runtimeArg)) {
    throw new Error("Use --runtime codex|claude|both");
  }
  const scenarioArg = argValue("--scenario", "all");
  if (!["sequential", "fanout_merge", "all"].includes(scenarioArg)) {
    throw new Error("Use --scenario sequential|fanout_merge|all");
  }
  const safetyTimeoutMs = Number(argValue("--safety-timeout-ms", "300000"));
  if (!Number.isFinite(safetyTimeoutMs) || safetyTimeoutMs < 10_000) {
    throw new Error("--safety-timeout-ms must be a finite process-safety fuse >= 10000");
  }
  const runtimes = runtimeArg === "both" ? ["codex", "claude"] : [runtimeArg];
  const scenarios = scenarioArg === "all"
    ? ["sequential", "fanout_merge"]
    : [scenarioArg];
  const outputDir = path.resolve(
    argValue(
      "--output-dir",
      path.join(repoRoot, ".meta-kim", "state", "default", "stage-runner-bridge"),
    ),
  );
  const acceptanceRunId = `p117-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
  const fixtureRoot = await createFixtureRoot();
  const scenarioResults = [];
  try {
    for (const runtime of runtimes) {
      for (const scenario of scenarios) {
        const definition = scenarioDefinition(scenario);
        const bridge = await runStageRunnerBridge({
          runId: `${acceptanceRunId}-${runtime}-${scenario}`,
          runtime,
          stageDagPacket: definition.dag,
          workerTaskPackets: definition.packets,
          workspaceRoot: fixtureRoot,
          capacity: scenario === "fanout_merge" ? 2 : 1,
          timeoutMs: safetyTimeoutMs,
        });
        const failures = validateScenarioResult(bridge, definition, scenario);
        scenarioResults.push({
          runtime,
          scenario,
          status: failures.length === 0 ? "pass" : "failed",
          failures,
          evidence: bridge,
        });
      }
    }
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
  const report = {
    schemaVersion: "stage-runner-bridge-acceptance-v0.1",
    prdTaskId: "P-117",
    runId: acceptanceRunId,
    status: scenarioResults.every((result) => result.status === "pass") ? "pass" : "failed",
    requiredRuntimes: ["codex", "claude"],
    requestedRuntimes: runtimes,
    requestedScenarios: scenarios,
    taskBudget: null,
    timeoutMeaning: "process safety fuse only",
    productEvidence: true,
    dockerUsed: false,
    fixtureMeaning: "The files are deterministic task inputs; every worker result comes from a real native runtime process.",
    scenarioResults,
  };
  report.releaseEligible =
    report.status === "pass" &&
    runtimes.length === 2 &&
    runtimes.includes("codex") &&
    runtimes.includes("claude") &&
    scenarios.length === 2 &&
    scenarios.includes("sequential") &&
    scenarios.includes("fanout_merge");
  const reportPath = path.join(outputDir, `${acceptanceRunId}.json`);
  await atomicWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await atomicWrite(path.join(outputDir, "latest.json"), `${JSON.stringify({
    runId: acceptanceRunId,
    status: report.status,
    releaseEligible: report.releaseEligible,
    report: path.basename(reportPath),
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    runId: acceptanceRunId,
    report: path.relative(repoRoot, reportPath),
    results: scenarioResults.map((result) => ({
      runtime: result.runtime,
      scenario: result.scenario,
      status: result.status,
      failures: result.failures,
      workerCount: result.evidence.workerResults.length,
      observedDurationMs: result.evidence.observedDurationMs,
    })),
  }, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
