#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const npmCli = process.env.npm_execpath ?? path.join(
  path.dirname(process.execPath),
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 180_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (status ${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

function npmRun(label, args, options = {}) {
  return run(label, process.execPath, [npmCli, ...args], options);
}

function atomicWrite(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, filePath);
}

function installedPackageRoot(consumerRoot) {
  return path.join(consumerRoot, "node_modules", "meta-kim");
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function buildChildSource(packageRoot) {
  const bridgeUrl = pathToFileURL(path.join(packageRoot, "scripts/governed-execution/stage-runner-bridge.mjs")).href;
  const kernelUrl = pathToFileURL(path.join(packageRoot, "scripts/governed-execution/durable-run-kernel.mjs")).href;
  const dagUrl = pathToFileURL(path.join(packageRoot, "scripts/governed-execution/stage-dag.mjs")).href;
  const adapterUrl = pathToFileURL(path.join(packageRoot, "scripts/governed-execution/ready-set-adapters.mjs")).href;
  return `
    import { appendFileSync } from "node:fs";
    import { runStageRunnerBridge } from ${JSON.stringify(bridgeUrl)};
    import { openDurableRunKernel } from ${JSON.stringify(kernelUrl)};
    import { buildStageDagPacket } from ${JSON.stringify(dagUrl)};
    import { createLangGraphReadySetExecutor } from ${JSON.stringify(adapterUrl)};

    const [phase, dbPath, invocationLog] = process.argv.slice(2);
    const lane = (taskPacketId) => ({
      laneId: taskPacketId,
      laneKind: "execution_worker",
      ownerBindingRef: \`owner:\${taskPacketId}\`,
      capabilityBindingRef: \`capability:\${taskPacketId}\`,
      effectClass: "read_only_worker",
      resourceScopes: [\`file:\${taskPacketId}.txt\`],
      isolation: "shared_read_only",
      status: "planned_not_invoked",
    });
    const packet = (taskPacketId) => ({
      taskPacketId,
      ownerAgent: "test-automator",
      description: \`Read \${taskPacketId}.txt\`,
      output: "observed value",
      dependsOn: [],
      executionMode: "primary_execution",
      externalWriteBoundary: false,
    });
    const dag = buildStageDagPacket({
      stageOrder: ["Execution"],
      stageLanes: { Execution: [lane("a"), lane("b")] },
      runtimeCapacity: 1,
    });
    const kernel = await openDurableRunKernel(dbPath);
    if (phase === "first") {
      const completeNode = kernel.completeNode.bind(kernel);
      kernel.completeNode = (args, options) => {
        const completed = completeNode(args, options);
        if (args.nodeId.endsWith(":lane:a")) process.exit(86);
        return completed;
      };
    }
    const result = await runStageRunnerBridge({
      runId: "p119-packed-langgraph-resume",
      runtime: "codex",
      stageDagPacket: dag,
      workerTaskPackets: [packet("a"), packet("b")],
      workspaceRoot: process.cwd(),
      capacity: 1,
      executeReadySet: createLangGraphReadySetExecutor(),
      durable: {
        enabled: true,
        kernel,
        mode: phase === "first" ? "create" : "resume",
        taskFingerprint: "task-p119-packed-langgraph-resume",
        ownerId: \`bridge-\${phase}\`,
        leaseMs: 1_000,
        heartbeatIntervalMs: 100,
      },
      evidenceKind: "packed_external_consumer",
      invokeWorker: async ({ packet: task }) => {
        appendFileSync(invocationLog, \`\${phase}:\${task.taskPacketId}\\n\`);
        const outputText = \`\${phase}:\${task.taskPacketId}:observed\`;
        return {
          status: "pass",
          runtime: "codex",
          exitCode: 0,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: 1,
          sessionId: \`session-\${phase}-\${task.taskPacketId}\`,
          messageId: \`message-\${phase}-\${task.taskPacketId}\`,
          outputText,
          outputSha256: "a".repeat(64),
          rawOutputSha256: "b".repeat(64),
          hostEventCount: 1,
          toolEventCount: 1,
          stderrTail: "",
        };
      },
    });
    const projection = kernel.projectRun("p119-packed-langgraph-resume");
    process.stdout.write(JSON.stringify({
      status: result.status,
      nodeRecords: result.nodeRecords,
      adapterPacket: result.readySetAdapterPacket,
      resumed: result.executionProjection.durable.resumed,
      eventTypes: projection.events.map((event) => event.eventType),
    }));
    kernel.close();
  `;
}

async function main() {
  const outputDir = path.resolve(argValue(
    "--output-dir",
    path.join(repoRoot, ".meta-kim", "state", "default", "ready-set-adapter"),
  ));
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-p119-packed-"));
  const packDir = path.join(tempRoot, "pack");
  const consumerRoot = path.join(tempRoot, "consumer");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });
  try {
    writeFileSync(path.join(consumerRoot, "package.json"), `${JSON.stringify({
      name: "meta-kim-p119-external-consumer",
      private: true,
      type: "module",
    }, null, 2)}\n`, "utf8");
    const packed = npmRun("npm pack candidate", [
      "pack",
      "--json",
      "--pack-destination",
      packDir,
    ], { cwd: repoRoot });
    const packRecord = JSON.parse(packed.stdout)[0];
    const tarball = path.join(packDir, packRecord.filename);
    const tarballSha256 = sha256File(tarball);
    const sourceCommit = run("resolve source commit", "git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      timeout: 30_000,
    }).stdout.trim();
    const sourceStatus = spawnSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (sourceStatus.status !== 0) throw new Error(sourceStatus.stderr || "git status failed");
    npmRun("install packed Meta_Kim", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ], { cwd: consumerRoot });
    const packageRoot = installedPackageRoot(consumerRoot);
    const installedManifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const baseHasLangGraph = existsSync(path.join(consumerRoot, "node_modules", "@langchain", "langgraph"));
    const declaredLangGraph = Boolean(
      installedManifest.dependencies?.["@langchain/langgraph"] ||
      installedManifest.optionalDependencies?.["@langchain/langgraph"] ||
      installedManifest.peerDependencies?.["@langchain/langgraph"],
    );
    if (baseHasLangGraph || declaredLangGraph) {
      throw new Error("Base packed install unexpectedly includes or declares @langchain/langgraph");
    }
    const packedEntry = path.join(packageRoot, "scripts", "run-meta-theory-governed-execution.mjs");
    const missingDependencyProbe = spawnSync(process.execPath, [
      packedEntry,
      "--execute-stage-dag",
      "--stage-runner-orchestrator",
      "langgraph",
      "--stage-runner-runtime",
      "codex",
      "--task",
      "Read package.json and report the package name. Do not modify files.",
      "--temp-output",
      "--strict-exit-code",
      "--no-emit-conversation-notice",
    ], {
      cwd: consumerRoot,
      env: { ...process.env, META_KIM_CALLER_CWD: consumerRoot },
      encoding: "utf8",
      timeout: 60_000,
    });
    if (missingDependencyProbe.status !== 1) {
      throw new Error(
        `Packed missing-dependency probe expected status 1; got ${missingDependencyProbe.status}\n` +
        `${missingDependencyProbe.stdout}\n${missingDependencyProbe.stderr}`,
      );
    }
    const missingDependencySummary = JSON.parse(missingDependencyProbe.stdout);
    if (
      missingDependencySummary.stageRunner?.status !== "failed" ||
      missingDependencySummary.stageRunner?.failureClass !== "optional_dependency_missing" ||
      missingDependencySummary.stageRunner?.workerCount !== 0 ||
      missingDependencySummary.stageRunner?.readySetAdapters?.length !== 0
    ) {
      throw new Error(`Packed missing-dependency probe did not fail closed: ${missingDependencyProbe.stdout}`);
    }
    npmRun("install explicit LangGraph adapter dependency", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-save",
      "@langchain/langgraph@1.4.8",
    ], { cwd: consumerRoot });
    const installedLangGraph = JSON.parse(readFileSync(
      path.join(consumerRoot, "node_modules", "@langchain", "langgraph", "package.json"),
      "utf8",
    ));
    const childPath = path.join(consumerRoot, "packed-consumer.mjs");
    const dbPath = path.join(consumerRoot, "durable.sqlite");
    const invocationLog = path.join(consumerRoot, "invocations.log");
    writeFileSync(childPath, buildChildSource(packageRoot), "utf8");
    const first = spawnSync(process.execPath, [childPath, "first", dbPath, invocationLog], {
      cwd: consumerRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (first.status !== 86) {
      throw new Error(`Expected deliberate exit 86 after node A commit; got ${first.status}\n${first.stdout}\n${first.stderr}`);
    }
    const resumed = run("packed LangGraph kill/resume", process.execPath, [
      childPath,
      "resume",
      dbPath,
      invocationLog,
    ], { cwd: consumerRoot, timeout: 30_000 });
    const result = JSON.parse(resumed.stdout);
    const invocations = readFileSync(invocationLog, "utf8").trim().split(/\r?\n/u);
    const mergeCount = result.nodeRecords.filter((record) => record.laneKind === "stage_merge").length;
    const adapterIds = result.adapterPacket.adapterIds;
    if (
      result.status !== "pass" ||
      result.resumed !== true ||
      mergeCount !== 1 ||
      JSON.stringify(invocations) !== JSON.stringify(["first:a", "resume:b"]) ||
      JSON.stringify(adapterIds) !== JSON.stringify(["langgraph_functional_ready_set"])
    ) {
      throw new Error(`Packed LangGraph acceptance binding failed: ${JSON.stringify({
        status: result.status,
        resumed: result.resumed,
        mergeCount,
        invocations,
        adapterIds,
      })}`);
    }
    const report = {
      schemaVersion: "ready-set-adapter-acceptance-v0.1",
      prdTaskId: "P-119",
      status: "pass",
      productEvidence: "packed_external_consumer",
      evidenceScope: "ready-set adapter integration and durable resume only",
      workerEvidence: "deterministic_test_double_not_native_provider_evidence",
      nativeProviderEvidence: false,
      dockerUsed: false,
      taskBudget: null,
      timeoutMeaning: "process safety fuse only",
      packedMetaKimVersion: installedManifest.version,
      packedArtifact: {
        filename: packRecord.filename,
        sha256: tarballSha256,
        sourceCommit,
        sourceWorktreeDirty: Boolean(sourceStatus.stdout.trim()),
      },
      baseInstall: {
        langGraphPresent: baseHasLangGraph,
        langGraphDeclared: declaredLangGraph,
        explicitSelectionFailure: {
          status: "optional_dependency_missing",
          nativeFallback: false,
          workerCount: missingDependencySummary.stageRunner.workerCount,
        },
      },
      optionalInstall: {
        package: "@langchain/langgraph",
        version: installedLangGraph.version,
        api: "Functional API entrypoint plus task",
        persistenceEnabled: false,
      },
      authority: {
        topology: "coreLoop.stageDagPacket",
        checkpoint: "p118_durable_run_kernel_only",
      },
      killResume: {
        deliberateExitCode: 86,
        resumed: result.resumed,
        invocations,
        mergeCount,
        adapterIds,
        eventTypes: result.eventTypes,
      },
      deferredAdapters: {
        openaiAgents: "deferred_not_implemented_no_credentials",
        claudeAgent: "deferred_not_implemented_no_credentials",
      },
    };
    await atomicWrite(path.join(outputDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
