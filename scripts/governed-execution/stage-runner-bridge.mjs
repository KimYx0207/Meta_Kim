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
import { openDurableRunKernel } from "./durable-run-kernel.mjs";
import {
  selectMaximalSafeReadySet,
  stageLaneNodeId,
  validateStageDagPacket,
} from "./stage-dag.mjs";

const SUPPORTED_RUNTIMES = new Set(["codex", "claude"]);
const MAX_RESULT_TEXT = 16_000;
const MANAGED_PARENT_MARKERS = Object.freeze([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CODEX_THREAD_ID",
  "CODEX_PERMISSION_PROFILE",
]);
const CHILD_ENV_SYSTEM_ALLOWLIST = new Set([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
  "LANG", "LC_ALL", "TERM", "NO_COLOR", "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
]);
const CHILD_ENV_RUNTIME_ALLOWLIST = Object.freeze({
  codex: new Set([
    "CODEX_HOME",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORGANIZATION",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
  ]),
  claude: new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
  ]),
});

const sha256 = (value) =>
  createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export function normalizeStageRunnerRuntime(runtime) {
  const normalized = String(runtime ?? "").trim().toLowerCase().replace(/-/gu, "_");
  if (["claude", "claude_code", "claudecode"].includes(normalized)) return "claude";
  if (normalized === "codex") return "codex";
  throw new TypeError(`Unsupported stage-runner runtime: ${runtime}`);
}

export function buildRuntimeChildEnv(runtime, env = process.env) {
  const normalizedRuntime = normalizeStageRunnerRuntime(runtime);
  const runtimeAllowlist = CHILD_ENV_RUNTIME_ALLOWLIST[normalizedRuntime];
  const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) =>
    CHILD_ENV_SYSTEM_ALLOWLIST.has(name) ||
    runtimeAllowlist.has(name)
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
      redacted = redacted.replace(
        new RegExp(escapeRegExp(normalized), process.platform === "win32" ? "giu" : "gu"),
        replacement,
      );
    }
  }
  return redacted;
}

function isSecretFieldName(name) {
  return /(?:^|[_.-])(?:api[_.-]?)?(?:key|token|password|passwd|secret|credentials?|authorization)(?:$|[_.-])/iu
    .test(String(name ?? "")) ||
    /(?:apiKey|accessToken|refreshToken|password|passwd|secret|credentials?|authorization)$/iu
      .test(String(name ?? ""));
}

function secretValuesFromEnv(env) {
  return Object.entries(env ?? {})
    .filter(([name, value]) => isSecretFieldName(name) && String(value ?? "").length >= 4)
    .map(([, value]) => String(value))
    .sort((left, right) => right.length - left.length);
}

function redactSecretFields(value) {
  let redacted = String(value ?? "");
  redacted = redacted.replace(
    /(["']?)([A-Za-z][A-Za-z0-9_.-]{0,127})\1(\s*[:=]\s*)(["'])([^"'\r\n]*)\4/gu,
    (match, fieldQuote, name, separator, valueQuote) => isSecretFieldName(name)
      ? `${fieldQuote}${name}${fieldQuote}${separator}${valueQuote}<redacted-secret>${valueQuote}`
      : match,
  );
  return redacted.replace(
    /([A-Za-z][A-Za-z0-9_.-]{0,127})(\s*[:=]\s*)([^\s,;}\]]+)/gu,
    (match, name, separator) => isSecretFieldName(name)
      ? `${name}${separator}<redacted-secret>`
      : match,
  );
}

function buildRedactionContext(workspaceRoot, env) {
  return {
    workspaceRoot,
    secretValues: secretValuesFromEnv(env),
  };
}

function redactSensitiveText(value, context, maxLength = 2_000) {
  let redacted = redactLocalPaths(value, context.workspaceRoot);
  for (const secret of context.secretValues) {
    redacted = redacted.split(secret).join("<redacted-secret>");
  }
  redacted = redactSecretFields(redacted);
  return maxLength == null ? redacted : redacted.slice(-maxLength);
}

function sanitizeBridgeNodeRecord(record, context) {
  const sanitize = (value, key = null) => {
    if (Array.isArray(value)) return value.map((item) => sanitize(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [
          childKey,
          sanitize(childValue, childKey),
        ]),
      );
    }
    if (typeof value !== "string") return value;
    if (!["outputText", "stderrTail", "failureMessage", "reason", "summary", "text"].includes(key)) {
      return value;
    }
    return redactSensitiveText(value, context, key === "outputText" ? MAX_RESULT_TEXT : 2_000);
  };
  const sanitized = sanitize(record);
  if (typeof sanitized.outputText === "string") {
    sanitized.outputSha256 = sha256(sanitized.outputText);
  }
  return sanitized;
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
  const { childEnv, removedManagedHostMarkers } = buildRuntimeChildEnv(normalizedRuntime, env);
  const redactionContext = buildRedactionContext(workspaceRoot, childEnv);
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
      failureMessage: redactSensitiveText(error.message, redactionContext),
      runtime: normalizedRuntime,
      ...result,
      stdout: undefined,
      stderr: undefined,
      rawOutputSha256: sha256(result.stdout),
      stderrTail: redactSensitiveText(result.stderr, redactionContext),
    };
  }
  const finalMessage = [...messages].reverse().find((message) => message?.text);
  const safeOutputText = finalMessage?.text
    ? redactSensitiveText(finalMessage.text, redactionContext, null).slice(0, MAX_RESULT_TEXT)
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
      ? redactSensitiveText(result.error.message, redactionContext)
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
    stderrTail: redactSensitiveText(result.stderr, redactionContext),
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

function isReadOnlyBridgeEffect(effectClass) {
  const normalized = String(effectClass ?? "").trim().toLowerCase();
  return normalized.startsWith("read_only") ||
    normalized === "merge_only" ||
    normalized === "stage_control";
}

async function prepareDurableBridgeContext({
  durable,
  runId,
  stageDagPacket,
}) {
  if (durable?.enabled !== true) return null;
  validateStageDagPacket(stageDagPacket, { requireDigest: true });
  if (typeof durable.taskFingerprint !== "string" || !durable.taskFingerprint.trim()) {
    throw new TypeError("durable.taskFingerprint is required");
  }
  if (!durable.kernel && (typeof durable.dbPath !== "string" || !durable.dbPath.trim())) {
    throw new TypeError("durable.dbPath or durable.kernel is required");
  }
  const kernel = durable.kernel ?? await openDurableRunKernel(durable.dbPath);
  const ownsKernel = !durable.kernel;
  const mode = durable.mode ?? "create";
  if (!["create", "resume", "create_or_resume"].includes(mode)) {
    if (ownsKernel) kernel.close();
    throw new TypeError(`Unsupported durable bridge mode: ${mode}`);
  }
  let resume;
  let resumed = false;
  try {
    if (mode === "create") {
      kernel.createRun({
        runId,
        graphDigest: stageDagPacket.graphDigest,
        taskFingerprint: durable.taskFingerprint,
      });
    } else if (mode === "resume") {
      resume = kernel.resumeRun({
        runId,
        graphDigest: stageDagPacket.graphDigest,
        taskFingerprint: durable.taskFingerprint,
      });
      resumed = true;
    } else {
      try {
        resume = kernel.resumeRun({
          runId,
          graphDigest: stageDagPacket.graphDigest,
          taskFingerprint: durable.taskFingerprint,
        });
        resumed = true;
      } catch (error) {
        if (!/Unknown governed run/iu.test(error.message)) throw error;
        kernel.createRun({
          runId,
          graphDigest: stageDagPacket.graphDigest,
          taskFingerprint: durable.taskFingerprint,
        });
      }
    }
    resume ??= kernel.resumeRun({
      runId,
      graphDigest: stageDagPacket.graphDigest,
      taskFingerprint: durable.taskFingerprint,
    });
  } catch (error) {
    if (ownsKernel) kernel.close();
    throw error;
  }
  if (!resume.resumable) {
    if (ownsKernel) kernel.close();
    throw new Error("Durable stage runner is blocked by unresolved effects");
  }
  const blockingClaim = resumed
    ? (resume.activeClaims ?? []).find(
        (claim) => Number(claim.leaseExpiresAtMs) > Date.now(),
      )
    : null;
  if (blockingClaim) {
    if (ownsKernel) kernel.close();
    const error = new Error(
      `blocked_until_lease_expiry: ${blockingClaim.nodeId} is leased by ${blockingClaim.leaseOwner} until ${blockingClaim.leaseExpiresAtMs}`,
    );
    error.code = "blocked_until_lease_expiry";
    error.nodeId = blockingClaim.nodeId;
    error.leaseOwner = blockingClaim.leaseOwner;
    error.leaseExpiresAtMs = blockingClaim.leaseExpiresAtMs;
    throw error;
  }
  const leaseMs = Math.max(10, Number.parseInt(String(durable.leaseMs ?? 30_000), 10) || 30_000);
  const heartbeatIntervalMs = Math.max(
    5,
    Math.min(
      Math.floor(leaseMs / 2),
      Number.parseInt(String(durable.heartbeatIntervalMs ?? Math.floor(leaseMs / 3)), 10) || 10_000,
    ),
  );
  return {
    kernel,
    ownsKernel,
    resumed,
    resume,
    graphDigest: stageDagPacket.graphDigest,
    taskFingerprint: durable.taskFingerprint,
    ownerId: durable.ownerId ?? `stage-runner:${process.pid}:${runId}`,
    leaseMs,
    heartbeatIntervalMs,
  };
}

function startDurableHeartbeat(context, node, claim) {
  if (!context) return { stop() { return null; } };
  let heartbeatError = null;
  const timer = setInterval(() => {
    try {
      context.kernel.heartbeatNode({
        runId: claim.runId,
        nodeId: node.nodeId,
        attemptId: claim.attemptId,
        fenceToken: claim.fenceToken,
        ownerId: context.ownerId,
        leaseMs: context.leaseMs,
      });
    } catch (error) {
      heartbeatError = error;
      clearInterval(timer);
    }
  }, context.heartbeatIntervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      return heartbeatError;
    },
  };
}

function attachHeartbeatFailure(result, heartbeatError) {
  if (!heartbeatError) return result;
  return {
    ...result,
    heartbeatFailure: {
      failureClass: "durable_heartbeat_failed",
      failureMessage: heartbeatError.message,
    },
  };
}

function durableTraversedEdgesForNode(context, node) {
  if (!context) return [];
  return node.dependsOn.map((fromNodeId) => {
    const edgeBinding = JSON.stringify({
      runId: context.resume.runId,
      graphDigest: context.graphDigest,
      fromNodeId,
      toNodeId: node.nodeId,
    });
    const conditionBinding = JSON.stringify({
      graphDigest: context.graphDigest,
      condition: "dependency_completed",
      fromNodeId,
      toNodeId: node.nodeId,
    });
    return {
      traversalId: sha256(edgeBinding),
      fromNodeId,
      toNodeId: node.nodeId,
      conditionDigest: sha256(conditionBinding),
    };
  });
}

function commitDurableTerminalResult(context, node, claim, result, redactionContext) {
  if (!context) return result;
  try {
    if (result.status === "completed") {
      context.kernel.completeNode({
        runId: claim.runId,
        nodeId: node.nodeId,
        attemptId: claim.attemptId,
        fenceToken: claim.fenceToken,
        ownerId: context.ownerId,
        output: result,
        traversedEdges: durableTraversedEdgesForNode(context, node),
      });
    } else {
      context.kernel.failNode({
        runId: claim.runId,
        nodeId: node.nodeId,
        attemptId: claim.attemptId,
        fenceToken: claim.fenceToken,
        ownerId: context.ownerId,
        failure: {
          failureClass: result.failureClass ?? "stage_node_failed",
          failureMessage: result.failureMessage ?? null,
        },
      });
    }
    return result;
  } catch (error) {
    const safeFailureMessage = redactSensitiveText(error.message, redactionContext);
    let failedResult = {
      ...result,
      status: "failed",
      failureClass: "durable_terminal_commit_failed",
      failureMessage: safeFailureMessage,
      durableTerminalCommitFailure: {
        failureClass: "durable_terminal_commit_failed",
        failureMessage: safeFailureMessage,
        attemptedStatus: result.status,
      },
    };
    if (result.status !== "completed") return failedResult;
    try {
      context.kernel.failNode({
        runId: claim.runId,
        nodeId: node.nodeId,
        attemptId: claim.attemptId,
        fenceToken: claim.fenceToken,
        ownerId: context.ownerId,
        failure: {
          failureClass: failedResult.failureClass,
          failureMessage: failedResult.failureMessage,
        },
      });
    } catch (failureRecordError) {
      const safeFailureRecordMessage = redactSensitiveText(
        failureRecordError.message,
        redactionContext,
      );
      failedResult = {
        ...failedResult,
        durableFailureRecordError: {
          failureClass: "durable_failure_record_failed",
          failureMessage: safeFailureRecordMessage,
        },
      };
    }
    return failedResult;
  }
}

function durableClaimForNode(context, node, dependencyResults) {
  if (!context) return null;
  return context.kernel.claimNode({
    runId: context.resume.runId,
    nodeId: node.nodeId,
    nodeDefinitionHash: sha256(`${context.graphDigest}:${node.nodeId}`),
    inputHash: sha256(`${context.taskFingerprint}:${node.nodeId}`),
    dependencyOutputHash: sha256(
      dependencyResults.map((result) => `${result.nodeId}:${result.outputSha256 ?? ""}`).join("|"),
    ),
    ownerId: context.ownerId,
    leaseMs: context.leaseMs,
  });
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
  durable = null,
  redactionEnv = process.env,
}) {
  const normalizedRuntime = normalizeStageRunnerRuntime(runtime);
  if (!SUPPORTED_RUNTIMES.has(normalizedRuntime)) {
    throw new TypeError(`Unsupported stage-runner runtime: ${runtime}`);
  }
  if (stageDagPacket?.authority !== "config/contracts/core-loop-contract.json") {
    throw new TypeError("stageDagPacket must retain the core-loop contract as its authority");
  }
  const durableContext = await prepareDurableBridgeContext({ durable, runId, stageDagPacket });
  try {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const redactionContext = buildRedactionContext(resolvedWorkspace, redactionEnv);
  const completedNodeIds = new Set(executionPrefixCompletedNodeIds(stageDagPacket));
  const executionNodes = stageDagPacket.nodes.filter((node) => node.stage === "Execution");
  const nodeRecordsById = new Map();
  const workerResultsByNodeId = new Map();
  for (const completed of durableContext?.resume.completedNodes ?? []) {
    const record = completed.output;
    if (!record || record.nodeId !== completed.nodeId || record.status !== "completed") {
      throw new Error(`Durable completed node output is not a valid bridge record: ${completed.nodeId}`);
    }
    completedNodeIds.add(completed.nodeId);
    nodeRecordsById.set(completed.nodeId, record);
    if (record.laneKind === "execution_worker") workerResultsByNodeId.set(completed.nodeId, record);
  }
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
      const dependencyResults = node.dependsOn
        .map((dependencyId) => nodeRecordsById.get(dependencyId))
        .filter(Boolean);
      const claim = durableClaimForNode(durableContext, node, dependencyResults);
      const heartbeat = startDurableHeartbeat(durableContext, node, claim);
      let normalizedResult;
      if (node.laneKind === "stage_merge") {
        const mergeDurationMs = Math.max(
          1,
          Number(process.hrtime.bigint() - nodeStartedHr) / 1_000_000,
        );
        const mergedOutputSha256 = sha256(
          dependencyResults.map((result) => result.outputSha256).join(":"),
        );
        normalizedResult = bridgeNodeRecord(node, {
          status: "completed",
          runtime: "local_merge",
          evidenceKind: "local_dag_merge",
          startedAt: nodeStartedAt.toISOString(),
          endedAt: new Date().toISOString(),
          observedDurationMs: mergeDurationMs,
          mergedTaskPacketIds: dependencyResults
            .filter((result) => result.laneKind === "execution_worker")
            .map((result) => result.taskPacketId),
          mergedOutputSha256,
          outputSha256: mergedOutputSha256,
        });
      } else {
        const packet = workerTaskForNode(workerTaskPackets, node.nodeId);
        if (!isReadOnlyBridgeEffect(node.effectClass)) {
          normalizedResult = bridgeNodeRecord(node, {
            status: "failed",
            runtime: normalizedRuntime,
            evidenceKind,
            taskPacketId: packet?.taskPacketId ?? null,
            failureClass: "read_only_bridge_rejected_node_effect",
            failureMessage: `Node effectClass is not read-only: ${node.effectClass ?? "missing"}`,
            startedAt: nodeStartedAt.toISOString(),
            endedAt: new Date().toISOString(),
            observedDurationMs: Math.max(
              1,
              Number(process.hrtime.bigint() - nodeStartedHr) / 1_000_000,
            ),
          });
        } else if (!packet) {
          normalizedResult = bridgeNodeRecord(node, {
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
        } else if (packet.externalWriteBoundary === true || packet.executionMode === "approval_gate") {
          normalizedResult = bridgeNodeRecord(node, {
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
        } else {
          const upstreamResults = dependencyResults.filter(
            (result) => result.laneKind === "execution_worker",
          );
          const prompt = buildReadOnlyWorkerPrompt({
            runId,
            runtime: normalizedRuntime,
            node,
            packet,
            requestTask,
            upstreamResults,
          });
          let result;
          try {
            result = await invokeWorker({
              runtime: normalizedRuntime,
              prompt,
              workspaceRoot: resolvedWorkspace,
              timeoutMs,
              node,
              packet,
            });
          } catch (error) {
            result = {
              status: "failed",
              failureClass: "runtime_invoker_threw",
              failureMessage: error.message,
            };
          }
          normalizedResult = bridgeNodeRecord(node, {
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
        }
      }
      normalizedResult = sanitizeBridgeNodeRecord(
        attachHeartbeatFailure(normalizedResult, heartbeat.stop()),
        redactionContext,
      );
      normalizedResult = commitDurableTerminalResult(
        durableContext,
        node,
        claim,
        normalizedResult,
        redactionContext,
      );
      normalizedResult = sanitizeBridgeNodeRecord(normalizedResult, redactionContext);
      nodeRecordsById.set(node.nodeId, normalizedResult);
      if (normalizedResult.status === "completed") {
        completedNodeIds.add(node.nodeId);
        if (normalizedResult.laneKind === "execution_worker") {
          workerResultsByNodeId.set(node.nodeId, normalizedResult);
        }
      }
      return normalizedResult;
    }));
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
  const nodeRecords = executionNodes.map((node) => nodeRecordsById.get(node.nodeId)).filter(Boolean);
  const workerResults = executionNodes
    .map((node) => workerResultsByNodeId.get(node.nodeId))
    .filter(Boolean);
  const executionProjection = {
    schemaVersion: "stage-dag-execution-projection-v0.1",
    authorityPacketRef: "coreLoop.stageDagPacket",
    graphDigest: stageDagPacket.graphDigest ?? null,
    status: failure ? "execution_failed" : "executed",
    nodeStatuses: executionNodes.map((node) => ({
      nodeId: node.nodeId,
      status: nodeRecordsById.get(node.nodeId)?.status ?? "planned_not_invoked",
    })),
    invocationTruth: {
      plannedIsInvoked: !failure,
      requiredEvidence: "runId + nodeId + native runtime process + terminal result",
      evidenceRef: "coreLoop.stageRunnerBridgePacket.nodeRecords",
    },
    durable: durableContext
      ? {
          enabled: true,
          resumed: durableContext.resumed,
          leaseMs: durableContext.leaseMs,
          heartbeatIntervalMs: durableContext.heartbeatIntervalMs,
          projection: durableContext.kernel.projectRun(runId),
        }
      : { enabled: false, resumed: false },
  };
  const bridge = {
    schemaVersion: "stage-runner-bridge-v0.1",
    prdTaskId: "P-117",
    status: failure ? "failed" : "pass",
    mode: "read_only_shadow",
    runtime: normalizedRuntime,
    runId,
    graphAuthority: stageDagPacket.authority,
    workspaceBoundary: "provider sandbox/permission mode is read-only; prompt and retained telemetry redact workspace/home paths, but filesystem read confinement is not claimed",
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
    stageDagPacket,
    executionProjection,
    compatibilityView: {
      stageDagStatus: executionProjection.status,
      nodeStatuses: executionProjection.nodeStatuses,
      invocationTruth: executionProjection.invocationTruth,
    },
  };
  return bridge;
  } finally {
    if (durableContext?.ownsKernel) durableContext.kernel.close();
  }
}

export function applyStageRunnerBridgeResult(coreLoop, bridge) {
  if (coreLoop.stageDagPacket?.graphDigest) {
    if (!bridge.stageDagPacket?.graphDigest) {
      throw new Error("Stage runner bridge graph digest is missing");
    }
    if (coreLoop.stageDagPacket.graphDigest !== bridge.stageDagPacket.graphDigest) {
      throw new Error("Stage runner bridge graph digest does not match coreLoop.stageDagPacket");
    }
  }
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
    stageDagPacket: coreLoop.stageDagPacket,
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
