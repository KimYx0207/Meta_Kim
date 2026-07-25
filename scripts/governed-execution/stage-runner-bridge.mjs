import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  observeClaudeAssistantMessages,
  observeClaudeJsonl,
  observeCodexAssistantMessages,
  observeCodexJsonl,
} from "../live-acceptance/observe-host-events.mjs";
import { spawnCli } from "../runtime-cli-invocation.mjs";
import {
  selectMaximalSafeReadySet,
  stageLaneNodeId,
} from "./stage-dag.mjs";

const SUPPORTED_RUNTIMES = new Set(["codex", "claude"]);
const MAX_RESULT_TEXT = 16_000;
const MANAGED_PARENT_MARKERS = Object.freeze([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CODEX_THREAD_ID",
  "CODEX_PERMISSION_PROFILE",
]);
const CHILD_ENV_EXACT_ALLOWLIST = new Set([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
  "LANG", "LC_ALL", "TERM", "NO_COLOR", "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_HOME",
  "CODEX_SKILLS_DIR", "CLAUDE_SKILLS_DIR",
  "META_KIM_CAPABILITY_GATE", "META_KIM_CAPABILITY_GATE_GRACE_DAYS",
]);
const CHILD_ENV_AUTH_PREFIXES = Object.freeze([
  "ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "AWS_", "GOOGLE_", "CLOUD_ML_", "AZURE_",
]);

const sha256 = (value) =>
  createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");

export function normalizeStageRunnerRuntime(runtime) {
  const normalized = String(runtime ?? "").trim().toLowerCase().replace(/-/gu, "_");
  if (["claude", "claude_code", "claudecode"].includes(normalized)) return "claude";
  if (normalized === "codex") return "codex";
  throw new TypeError(`Unsupported stage-runner runtime: ${runtime}`);
}

export function buildRuntimeChildEnv(env = process.env) {
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) =>
    CHILD_ENV_EXACT_ALLOWLIST.has(name) ||
    CHILD_ENV_AUTH_PREFIXES.some((prefix) => name.startsWith(prefix))
  ));
  const removedManagedHostMarkers = [];
  for (const name of MANAGED_PARENT_MARKERS) {
    if (env[name] == null || env[name] === "") continue;
    removedManagedHostMarkers.push(name);
    delete childEnv[name];
  }
  return { childEnv, removedManagedHostMarkers };
}

function redactLocalPaths(value, workspaceRoot) {
  let redacted = String(value ?? "");
  for (const [candidate, replacement] of [
    [workspaceRoot, "<workspace>"],
    [os.homedir(), "<user-home>"],
  ]) {
    if (!candidate) continue;
    for (const normalized of [path.resolve(candidate), path.resolve(candidate).replace(/\\/gu, "/")]) {
      redacted = redacted.split(normalized).join(replacement);
    }
  }
  return redacted;
}

function redactLocalText(value, workspaceRoot) {
  return redactLocalPaths(value, workspaceRoot).slice(-2_000);
}

function workerTaskForNode(workerTaskPackets, nodeId) {
  return workerTaskPackets.find(
    (packet) => stageLaneNodeId("Execution", packet.taskPacketId) === nodeId,
  ) ?? null;
}

function boundedArray(value) {
  return Array.isArray(value) ? value.slice(0, 20) : [];
}

export function buildReadOnlyWorkerPrompt({
  runId,
  runtime,
  node,
  packet,
  requestTask = null,
  upstreamResults = [],
}) {
  const task = {
    taskPacketId: packet.taskPacketId,
    ownerAgent: packet.ownerAgent ?? packet.owner,
    workType: packet.workType ?? null,
    description: packet.description ?? packet.task ?? packet.referenceDirection ?? null,
    expectedOutput: packet.output ?? packet.deliverable ?? packet.deliverableLink ?? "concise evidence-backed result",
    acceptanceCriteria: boundedArray(packet.acceptanceCriteria),
    scopeFiles: boundedArray(packet.scopeFiles),
    shardScope: boundedArray(packet.shardScope),
    nonGoals: boundedArray(packet.nonGoals),
  };
  const upstream = upstreamResults.map((result) => ({
    taskPacketId: result.taskPacketId,
    outputSha256: result.outputSha256,
    summary: result.outputText?.slice(0, 2_000) ?? null,
  }));
  return [
    "You are a bounded read-only execution worker inside Meta_Kim P-117.",
    "Use only read/search capabilities. Do not edit, create, delete, install, commit, push, publish, or access paths outside the workspace.",
    runtime === "codex" && process.platform === "win32"
      ? "For file reads on Windows, use one direct Get-Content -LiteralPath command without a pipeline or shell-side parsing; compound read pipelines may be rejected by the read-only command policy."
      : "Prefer the runtime's direct read/search tools and avoid unnecessary compound commands.",
    "Inspect the minimum relevant project evidence, complete the assigned task, and return a concise result with the facts you actually observed.",
    "Do not claim that another worker ran. Do not claim a command or file was observed unless you personally observed it.",
    `Runtime: ${runtime}`,
    `Run ID: ${runId}`,
    `DAG node: ${node.nodeId}`,
    `Original user task: ${requestTask ?? "Not separately supplied; follow the bounded task packet."}`,
    `Task packet: ${JSON.stringify(task)}`,
    `Completed upstream results: ${JSON.stringify(upstream)}`,
  ].join("\n");
}

function runtimeInvocation(runtime, workspaceRoot) {
  if (runtime === "codex") {
    return {
      command: "codex",
      args: [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--cd",
        workspaceRoot,
        "-",
      ],
    };
  }
  return {
    command: "claude",
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-hook-events",
      "--safe-mode",
      "--permission-mode",
      "plan",
      "--tools",
      "Read,Glob,Grep",
      "--no-session-persistence",
    ],
  };
}

function eventLooksLikeToolCall(event) {
  const family = String(
    event?.capabilityFamily ?? event?.family ?? event?.providerType ?? event?.category ?? "",
  ).toLowerCase();
  const type = String(event?.eventType ?? event?.type ?? event?.observationKind ?? "").toLowerCase();
  return ["runtime_tool", "command_script", "tool"].includes(family) ||
    type.includes("tool") || Boolean(event?.toolName ?? event?.tool_name);
}

export async function invokeReadOnlyRuntimeWorker({
  runtime,
  prompt,
  workspaceRoot,
  requestTask = null,
  timeoutMs = 300_000,
  env = process.env,
}) {
  const normalizedRuntime = normalizeStageRunnerRuntime(runtime);
  const invocation = runtimeInvocation(normalizedRuntime, path.resolve(workspaceRoot));
  const { childEnv, removedManagedHostMarkers } = buildRuntimeChildEnv(env);
  const result = await spawnCli(invocation.command, invocation.args, {
    cwd: path.resolve(workspaceRoot),
    env: childEnv,
    input: prompt,
    timeoutMs,
  });
  let messages = [];
  let events = [];
  try {
    messages = normalizedRuntime === "codex"
      ? observeCodexAssistantMessages(result.stdout)
      : observeClaudeAssistantMessages(result.stdout);
    events = normalizedRuntime === "codex"
      ? observeCodexJsonl(result.stdout)
      : observeClaudeJsonl(result.stdout);
  } catch (error) {
    return {
      status: "failed",
      failureClass: "runtime_output_parse_failed",
      failureMessage: error.message,
      runtime: normalizedRuntime,
      ...result,
      stdout: undefined,
      stderr: undefined,
      rawOutputSha256: sha256(result.stdout),
      stderrTail: redactLocalText(result.stderr, workspaceRoot),
    };
  }
  const finalMessage = [...messages].reverse().find((message) => message?.text);
  const safeOutputText = finalMessage?.text
    ? redactLocalPaths(finalMessage.text, workspaceRoot).slice(0, MAX_RESULT_TEXT)
    : null;
  const failureClass = result.timedOut
    ? "runtime_safety_timeout"
    : result.outputLimitExceeded
      ? "runtime_output_limit"
      : result.error
        ? "runtime_launch_failed"
        : result.status !== 0
          ? "runtime_nonzero_exit"
          : !finalMessage
            ? "runtime_final_message_missing"
            : null;
  return {
    status: failureClass ? "failed" : "pass",
    failureClass,
    failureMessage: result.error?.message
      ? redactLocalText(result.error.message, workspaceRoot)
      : null,
    runtime: normalizedRuntime,
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    launchSource: result.launchSource,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: result.durationMs,
    sessionId: finalMessage?.sessionId ?? null,
    messageId: finalMessage?.messageId ?? null,
    outputText: safeOutputText,
    outputSha256: safeOutputText ? sha256(safeOutputText) : null,
    rawOutputSha256: sha256(result.stdout),
    hostEventCount: events.length,
    toolEventCount: events.filter(eventLooksLikeToolCall).length,
    removedManagedHostMarkers,
    stderrTail: redactLocalText(result.stderr, workspaceRoot),
  };
}

function executionPrefixCompletedNodeIds(stageDagPacket) {
  const executionIndex = stageDagPacket.stageOrder.indexOf("Execution");
  if (executionIndex < 0) throw new TypeError("stageDagPacket is missing the Execution stage");
  const priorStages = new Set(stageDagPacket.stageOrder.slice(0, executionIndex));
  return stageDagPacket.nodes
    .filter((node) => priorStages.has(node.stage))
    .map((node) => node.nodeId);
}

function bridgeNodeRecord(node, details) {
  return {
    nodeId: node.nodeId,
    stage: node.stage,
    laneKind: node.laneKind,
    ownerBindingRef: node.ownerBindingRef,
    capabilityBindingRef: node.capabilityBindingRef,
    ...details,
  };
}

export async function runStageRunnerBridge({
  runId,
  runtime,
  stageDagPacket,
  workerTaskPackets,
  workspaceRoot,
  requestTask = null,
  capacity = null,
  timeoutMs = 300_000,
  invokeWorker = invokeReadOnlyRuntimeWorker,
  evidenceKind = "native_read_only_stage_runner",
}) {
  const normalizedRuntime = normalizeStageRunnerRuntime(runtime);
  if (!SUPPORTED_RUNTIMES.has(normalizedRuntime)) {
    throw new TypeError(`Unsupported stage-runner runtime: ${runtime}`);
  }
  if (stageDagPacket?.authority !== "config/contracts/core-loop-contract.json") {
    throw new TypeError("stageDagPacket must retain the core-loop contract as its authority");
  }
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const completedNodeIds = new Set(executionPrefixCompletedNodeIds(stageDagPacket));
  const executionNodes = stageDagPacket.nodes.filter((node) => node.stage === "Execution");
  const nodeRecords = [];
  const workerResults = [];
  const startedAt = new Date();
  const startedHr = process.hrtime.bigint();
  let failure = null;

  while (!failure && executionNodes.some((node) => !completedNodeIds.has(node.nodeId))) {
    const ready = selectMaximalSafeReadySet(stageDagPacket, {
      completedNodeIds: [...completedNodeIds],
      capacity,
      stage: "Execution",
    });
    if (ready.readyNodes.length === 0) {
      failure = {
        failureClass: "stage_dag_deadlock",
        reason: "No ready Execution node exists while incomplete nodes remain.",
      };
      break;
    }
    const batchResults = await Promise.all(ready.readyNodes.map(async (node) => {
      const nodeStartedAt = new Date();
      const nodeStartedHr = process.hrtime.bigint();
      if (node.laneKind === "stage_merge") {
        const mergeDurationMs = Math.max(
          1,
          Number(process.hrtime.bigint() - nodeStartedHr) / 1_000_000,
        );
        return bridgeNodeRecord(node, {
          status: "completed",
          runtime: "local_merge",
          evidenceKind: "local_dag_merge",
          startedAt: nodeStartedAt.toISOString(),
          endedAt: new Date().toISOString(),
          observedDurationMs: mergeDurationMs,
          mergedTaskPacketIds: workerResults.map((result) => result.taskPacketId),
          mergedOutputSha256: sha256(workerResults.map((result) => result.outputSha256).join(":")),
        });
      }
      const packet = workerTaskForNode(workerTaskPackets, node.nodeId);
      if (!packet) {
        return bridgeNodeRecord(node, {
          status: "failed",
          runtime: normalizedRuntime,
          evidenceKind,
          failureClass: "worker_task_packet_missing",
          startedAt: nodeStartedAt.toISOString(),
          endedAt: new Date().toISOString(),
          observedDurationMs: Math.max(
            1,
            Number(process.hrtime.bigint() - nodeStartedHr) / 1_000_000,
          ),
        });
      }
      if (packet.externalWriteBoundary === true || packet.executionMode === "approval_gate") {
        return bridgeNodeRecord(node, {
          status: "failed",
          runtime: normalizedRuntime,
          evidenceKind,
          taskPacketId: packet.taskPacketId,
          failureClass: "read_only_bridge_rejected_side_effect_task",
          startedAt: nodeStartedAt.toISOString(),
          endedAt: new Date().toISOString(),
          observedDurationMs: Math.max(
            1,
            Number(process.hrtime.bigint() - nodeStartedHr) / 1_000_000,
          ),
        });
      }
      const upstreamResults = workerResults.filter((result) =>
        (packet.dependsOn ?? []).includes(result.taskPacketId)
      );
      const prompt = buildReadOnlyWorkerPrompt({
        runId,
        runtime: normalizedRuntime,
        node,
        packet,
        requestTask,
        upstreamResults,
      });
      const result = await invokeWorker({
        runtime: normalizedRuntime,
        prompt,
        workspaceRoot: resolvedWorkspace,
        timeoutMs,
        node,
        packet,
      });
      const normalizedResult = bridgeNodeRecord(node, {
        status: result.status === "pass" ? "completed" : "failed",
        runtime: normalizedRuntime,
        evidenceKind,
        taskPacketId: packet.taskPacketId,
        actualBinding: {
          runtime: normalizedRuntime,
          ownerBindingRef: node.ownerBindingRef,
          capabilityBindingRef: node.capabilityBindingRef,
          taskPacketId: packet.taskPacketId,
        },
        startedAt: result.startedAt ?? nodeStartedAt.toISOString(),
        endedAt: result.endedAt ?? new Date().toISOString(),
        observedDurationMs: Math.max(1, Number(result.durationMs) || 0),
        exitCode: result.exitCode ?? null,
        sessionId: result.sessionId ?? null,
        messageId: result.messageId ?? null,
        outputText: result.outputText ?? null,
        outputSha256: result.outputSha256 ?? null,
        rawOutputSha256: result.rawOutputSha256 ?? null,
        hostEventCount: result.hostEventCount ?? 0,
        toolEventCount: result.toolEventCount ?? 0,
        removedManagedHostMarkers: result.removedManagedHostMarkers ?? [],
        failureClass: result.failureClass ?? null,
        failureMessage: result.failureMessage ?? null,
        stderrTail: result.stderrTail ?? "",
      });
      return normalizedResult;
    }));
    nodeRecords.push(...batchResults);
    for (const result of batchResults) {
      if (result.status === "completed") {
        completedNodeIds.add(result.nodeId);
        if (result.laneKind === "execution_worker") workerResults.push(result);
      }
    }
    const failed = batchResults.find((result) => result.status !== "completed");
    if (failed) {
      failure = {
        failureClass: failed.failureClass ?? "stage_node_failed",
        reason: failed.failureMessage ?? `${failed.nodeId} failed`,
        nodeId: failed.nodeId,
      };
    }
  }

  const endedAt = new Date();
  const totalDurationMs = Math.max(
    1,
    Number(process.hrtime.bigint() - startedHr) / 1_000_000,
  );
  const completedExecutionNodeIds = new Set(nodeRecords
    .filter((record) => record.status === "completed")
    .map((record) => record.nodeId));
  const updatedDag = {
    ...stageDagPacket,
    status: failure ? "execution_failed" : "executed",
    nodes: stageDagPacket.nodes.map((node) =>
      node.stage !== "Execution"
        ? node
        : {
            ...node,
            status: completedExecutionNodeIds.has(node.nodeId)
              ? "completed"
              : nodeRecords.some((record) => record.nodeId === node.nodeId)
                ? "failed"
                : node.status,
          }
    ),
    invocationTruth: {
      plannedIsInvoked: !failure,
      requiredEvidence: "runId + nodeId + native runtime process + terminal result",
      evidenceRef: "coreLoop.stageRunnerBridgePacket.nodeRecords",
    },
  };
  return {
    schemaVersion: "stage-runner-bridge-v0.1",
    prdTaskId: "P-117",
    status: failure ? "failed" : "pass",
    mode: "read_only_shadow",
    runtime: normalizedRuntime,
    runId,
    graphAuthority: stageDagPacket.authority,
    workspaceBoundary: "runtime cwd only; provider sandbox/permission mode is read-only",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    observedDurationMs: totalDurationMs,
    capacity: Math.max(1, Number.parseInt(String(capacity ?? stageDagPacket.runtimeCapacity ?? 1), 10) || 1),
    failure,
    nodeRecords,
    workerResults,
    mergedOutput: workerResults.map((result) => ({
      taskPacketId: result.taskPacketId,
      ownerBindingRef: result.ownerBindingRef,
      outputText: result.outputText,
      outputSha256: result.outputSha256,
    })),
    stageDagPacket: updatedDag,
  };
}

export function applyStageRunnerBridgeResult(coreLoop, bridge) {
  const resultsByTask = new Map(
    bridge.workerResults.map((result) => [result.taskPacketId, result]),
  );
  const workerResultPackets = coreLoop.executionResult.workerResultPackets.map((planned) => {
    const result = resultsByTask.get(planned.taskPacketId);
    if (!result) return planned;
    return {
      ...planned,
      status: "executed",
      resultKind: "native_read_only_worker_result",
      evidenceKind: result.evidenceKind,
      output: {
        producedBy: `${bridge.runtime}_stage_runner_bridge`,
        ownerBoundary: planned.ownerAgent ?? planned.owner,
        externalWritePerformed: false,
        text: result.outputText,
        textSha256: result.outputSha256,
      },
      note: "A native runtime process returned a terminal result for this bounded read-only worker task; Review still owns semantic acceptance.",
    };
  });
  const workerExecutionEvidence = coreLoop.executionResult.workerExecutionEvidence.map((planned) => {
    const result = resultsByTask.get(planned.taskPacketId);
    if (!result) return planned;
    return {
      ...planned,
      evidenceKind: result.evidenceKind,
      status: "executed",
      artifactRef: "coreLoop.stageRunnerBridgePacket",
      liveWorkerExecution: true,
      externalAgentSpawned: false,
      runtimeProcessInvoked: true,
      runtime: bridge.runtime,
      sessionId: result.sessionId,
      messageId: result.messageId,
      observedDurationMs: result.observedDurationMs,
      outputSha256: result.outputSha256,
      hostEventCount: result.hostEventCount,
      toolEventCount: result.toolEventCount,
      reason: "A native read-only runtime result was observed and merged; this proves invocation, while Review owns semantic acceptance.",
    };
  });
  const stageTiming = coreLoop.traceEvalControlPlane.stageTiming.map((timing) =>
    timing.stage === "Execution"
      ? {
          ...timing,
          timingRecordStatus: "native_runtime_observed",
          observedDurationMs: bridge.observedDurationMs,
          durationMeasurementNote: "Measured from the native stage-runner bridge start/end boundaries.",
        }
      : timing
  );
  const liveExecution = bridge.status === "pass" && bridge.workerResults.length > 0;
  const langGraphRunPacket = {
    ...coreLoop.langGraphRunPacket,
    runtimeExecutionEvidence: liveExecution
      ? "native_stage_runner_bridge"
      : "native_stage_runner_bridge_failed",
    runtimeBoundary:
      `The authoritative stage DAG was executed in ${bridge.runtime} read-only shadow mode; this does not claim LangGraph runtime usage.`,
    eventLog: coreLoop.langGraphRunPacket.eventLog.map((event) => {
      const taskPacketId = String(event.nodeId ?? "").replace(/^worker:/u, "");
      return resultsByTask.has(taskPacketId)
        ? {
            ...event,
            eventType: "WorkerFinished",
            evidenceRef: "coreLoop.stageRunnerBridgePacket.nodeRecords",
          }
        : event;
    }),
  };
  return {
    ...coreLoop,
    stageDagPacket: bridge.stageDagPacket,
    stageRunnerBridgePacket: bridge,
    traceEvalControlPlane: {
      ...coreLoop.traceEvalControlPlane,
      stageTiming,
    },
    langGraphRunPacket,
    visibleMetaTheorySurfacePacket: {
      ...coreLoop.visibleMetaTheorySurfacePacket,
      langGraph: {
        ...coreLoop.visibleMetaTheorySurfacePacket.langGraph,
        runtimeExecutionEvidence: langGraphRunPacket.runtimeExecutionEvidence,
      },
    },
    executionResult: {
      ...coreLoop.executionResult,
      actualWorkerExecution: liveExecution,
      executionClosure: liveExecution
        ? "run_scoped_worker_executed"
        : "worker_execution_failed",
      workerResultPackets,
      workerExecutionEvidence,
      mergeResult: {
        ...coreLoop.executionResult.mergeResult,
        status: liveExecution ? "worker_results_merged" : "worker_merge_failed",
        liveExecutionMerged: liveExecution,
        bridgeEvidenceRef: "coreLoop.stageRunnerBridgePacket",
      },
    },
  };
}
