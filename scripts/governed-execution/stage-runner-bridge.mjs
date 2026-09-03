import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import runQuotaPolicy from "../../config/governance/run-quota-policy.json" with { type: "json" };
import {
  observeClaudeAssistantMessages,
  observeClaudeJsonl,
  observeCodexAssistantMessages,
  observeCodexJsonl,
} from "../live-acceptance/observe-host-events.mjs";
import { spawnCli } from "../runtime-cli-invocation.mjs";
import { HOST_INHERITED_ENV_NAMES } from "./host-runtime-provenance.mjs";
import { assertDurableRunRepositoryPort } from "../../src/application/ports/durable-run-repository-port.mjs";
import { openDurableRunRepository } from "../../src/application/run/open-durable-run-repository.mjs";
import { buildEvidenceTransitionShadowProjection } from "./evidence-transition-shadow-adapter.mjs";
import { buildContinuationPolicyShadowProjection } from "./continuation-policy-shadow-adapter.mjs";
import { buildTodoDependencySafeProgressShadowProjection } from "./todo-dependency-safe-progress-shadow-adapter.mjs";
import { buildSchedulerAuthorityReuseShadowPlan } from "./scheduler-authority-reuse-shadow-adapter.mjs";
import { buildLeaseClaimAuthorityShadowProjection } from "./lease-claim-authority-shadow-adapter.mjs";
import { buildRuntimeHealthProjection } from "./runtime-health-projection-adapter.mjs";
import {
  buildQuotaUsageProjection,
  buildTrustedQuotaUsageObservation,
} from "./quota-usage-projection-adapter.mjs";
import { buildReadOnlyRunProjectionSurfacesAdapter } from "./read-only-run-projection-surfaces-adapter.mjs";
import { buildReadOnlyRunAuthoritySnapshot } from "../../src/data/projections/read-only-run-authority-snapshot.mjs";
import {
  executeNativeReadySet,
  validateReadySetAdapterResult,
} from "./ready-set-adapters.mjs";
import {
  selectMaximalSafeReadySet,
  stageLaneNodeId,
  validateStageDagPacket,
} from "./stage-dag.mjs";

const SUPPORTED_RUNTIMES = new Set(["codex", "claude"]);
const nativeRuntimeBridgeAttestations = new WeakSet();
const MAX_RESULT_TEXT = 16_000;
const MANAGED_PARENT_MARKERS = HOST_INHERITED_ENV_NAMES;
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

const sha256Reference = (value) => {
  const normalized = String(value ?? "");
  if (/^sha256:[a-f0-9]{64}$/u.test(normalized)) return normalized;
  if (/^[a-f0-9]{64}$/u.test(normalized)) return `sha256:${normalized}`;
  return `sha256:${sha256(normalized)}`;
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

const canonicalDigestReference = (value) => `sha256:${sha256(canonicalJson(value))}`;

function runtimeHealthFailureStatus(failureClass) {
  switch (failureClass) {
    case "runtime_safety_timeout":
      return { invocationStatus: "timeout", failureClass: "runtime_safety_timeout" };
    case "runtime_launch_failed":
      return { invocationStatus: "launch_failed", failureClass: "runtime_launch_failed" };
    case "runtime_output_parse_failed":
      return { invocationStatus: "parse_failed", failureClass: "runtime_parse_failed" };
    case "runtime_output_limit":
      return { invocationStatus: "output_limit", failureClass: "runtime_output_limit" };
    case "runtime_nonzero_exit":
      return { invocationStatus: "nonzero_exit", failureClass: "runtime_nonzero_exit" };
    case "runtime_final_message_missing":
      return { invocationStatus: "final_message_missing", failureClass: "final_message_missing" };
    default:
      return { invocationStatus: "conflict", failureClass: "unknown" };
  }
}

function buildRuntimeHealthRegistryBinding({ runtimeId, runtimeMode, evidenceLedgerDigest }) {
  const core = {
    runtimeId,
    runtimeMode,
    catalogDigest: canonicalDigestReference({
      source: "stage_runner_bridge_supported_runtime_catalog",
      runtimeIds: [...SUPPORTED_RUNTIMES].sort(),
    }),
    capabilityMatrixDigest: canonicalDigestReference({
      source: "config/runtime-capability-matrix.json",
      runtimeId,
      runtimeMode,
    }),
    evidenceLedgerDigest,
  };
  return { ...core, registryDigest: canonicalDigestReference(core) };
}

function buildTrustedRuntimeHealthObservation({
  runtimeId,
  nativeRuntimeInvokerSelected,
  nativeInvocationAttemptedNodeIds,
  nodeRecords,
  observedAt,
}) {
  const runtimeMode = nativeRuntimeInvokerSelected ? "native_cli" : "injected_callback";
  const settled = nodeRecords.filter((record) =>
    record?.laneKind === "execution_worker" &&
    record?.runtime === runtimeId &&
    record?.evidenceKind === "native_read_only_stage_runner" &&
    nativeInvocationAttemptedNodeIds.has(record?.nodeId) &&
    (record?.status === "completed" || record?.status === "failed")
  );
  if (!nativeRuntimeInvokerSelected || settled.length === 0) {
    const core = {
      source: "none",
      runtimeId,
      runtimeMode,
      currentRun: true,
      nativeInvocationObserved: false,
      invocationStatus: "not_invoked",
      failureClass: nativeRuntimeInvokerSelected ? "not_applicable" : "injected_callback",
      startedAt: null,
      endedAt: null,
      observedAt: null,
      evidenceRefDigest: null,
    };
    return { ...core, observationDigest: canonicalDigestReference(core) };
  }
  const failed = settled.find((record) => record.status === "failed") ?? null;
  const classification = failed
    ? runtimeHealthFailureStatus(failed.failureClass)
    : { invocationStatus: "pass", failureClass: "none" };
  const startedValues = settled.map((record) => Date.parse(record.startedAt));
  const endedValues = settled.map((record) => Date.parse(record.endedAt));
  const timestampsValid = [...startedValues, ...endedValues].every(Number.isSafeInteger) &&
    startedValues.every((value, index) => value <= endedValues[index]) &&
    endedValues.every((value) => value <= observedAt);
  const evidenceRefDigest = canonicalDigestReference(settled.map((record) => ({
    nodeId: record.nodeId,
    status: record.status,
    failureClass: record.failureClass ?? null,
    outputSha256: record.outputSha256 ?? null,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
  })));
  const core = {
    source: "stage_runner_bridge_native_invocation",
    runtimeId,
    runtimeMode,
    currentRun: true,
    nativeInvocationObserved: true,
    invocationStatus: timestampsValid ? classification.invocationStatus : "conflict",
    failureClass: timestampsValid ? classification.failureClass : "unknown",
    startedAt: timestampsValid ? Math.min(...startedValues) : observedAt,
    endedAt: timestampsValid ? Math.max(...endedValues) : observedAt,
    observedAt,
    evidenceRefDigest,
  };
  return { ...core, observationDigest: canonicalDigestReference(core) };
}

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
  signal = null,
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
    signal,
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
  const kernel = assertDurableRunRepositoryPort(
    durable.kernel ?? await openDurableRunRepository(durable.dbPath),
  );
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

function ownDataValue(record, field) {
  try {
    if (record == null || typeof record !== "object" || Array.isArray(record)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    return descriptor?.enumerable === true && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function evidenceTransitionAuthorityBinding({
  durableContext,
  durableRunProjection,
  stageDagPacket,
  executionNodes,
  durableClaimsByNodeId,
  evidenceTransitionShadow,
}) {
  if (!durableContext || !durableRunProjection) return null;
  try {
    validateStageDagPacket(stageDagPacket, { requireDigest: true });
  } catch {
    return null;
  }
  if (durableRunProjection.run.graphDigest !== stageDagPacket.graphDigest) return null;
  const executionIndex = stageDagPacket.stageOrder.indexOf("Execution");
  const reviewIndex = stageDagPacket.stageOrder.indexOf("Review");
  if (executionIndex < 0 || reviewIndex !== executionIndex + 1) return null;
  const executionMerges = stageDagPacket.nodes.filter(
    (node) => node.stage === "Execution" && node.laneKind === "stage_merge",
  );
  const reviewLanes = stageDagPacket.nodes.filter(
    (node) => node.stage === "Review" && node.laneKind !== "stage_merge",
  );
  const reviewMerges = stageDagPacket.nodes.filter(
    (node) => node.stage === "Review" && node.laneKind === "stage_merge",
  );
  if (
    executionMerges.length !== 1 ||
    reviewLanes.length < 1 ||
    reviewMerges.length !== 1
  ) {
    return null;
  }
  const [executionMerge] = executionMerges;
  const [reviewMerge] = reviewMerges;
  const reviewLaneIds = new Set(reviewLanes.map((node) => node.nodeId));
  if (
    reviewLanes.some((node) => !node.dependsOn.includes(executionMerge.nodeId)) ||
    reviewMerge.dependsOn.length !== reviewLaneIds.size ||
    reviewMerge.dependsOn.some((nodeId) => !reviewLaneIds.has(nodeId))
  ) return null;
  const transitionRequest = ownDataValue(evidenceTransitionShadow, "transitionRequest");
  if (
    ownDataValue(transitionRequest, "fromStage") !== "execution" ||
    ownDataValue(transitionRequest, "toStage") !== "review"
  ) {
    return null;
  }
  const mergeNode = executionNodes.find((node) => node.nodeId === executionMerge.nodeId);
  if (!mergeNode) return null;
  const completed = durableRunProjection.completedNodes.find(
    (record) => record.nodeId === mergeNode.nodeId,
  );
  if (!completed) return null;
  let claim = durableClaimsByNodeId.get(mergeNode.nodeId) ?? null;
  if (!claim) {
    const claimEvent = durableRunProjection.events.find(
      (event) =>
        event.eventType === "NodeAttemptClaimed" &&
        event.nodeId === mergeNode.nodeId &&
        event.attemptId === completed.sourceAttemptId,
    );
    if (claimEvent) {
      claim = {
        attemptId: claimEvent.attemptId,
        attemptNo: claimEvent.payload?.attemptNo,
        fenceToken: claimEvent.payload?.fenceToken,
      };
    }
  }
  if (
    !claim ||
    typeof claim.attemptId !== "string" ||
    !Number.isSafeInteger(claim.attemptNo) ||
    claim.attemptNo < 1 ||
    !Number.isSafeInteger(claim.fenceToken) ||
    claim.fenceToken < 1
  ) {
    return null;
  }
  return {
    runId: durableRunProjection.run.runId,
    taskFingerprint: sha256Reference(durableRunProjection.run.taskFingerprint),
    graphDigest: sha256Reference(durableRunProjection.run.graphDigest),
    nodeId: mergeNode.nodeId,
    attemptId: claim.attemptId,
    fenceToken: claim.fenceToken,
    revision: claim.attemptNo - 1,
  };
}

function continuationPolicyAuthoritySnapshot({
  durableContext,
  durableRunProjection,
  failure,
  executionNodes,
  nodeRecordsById,
}) {
  if (!durableContext || !durableRunProjection) return null;
  const resume = durableContext.resume;
  const blockingEffectRefs = (resume.blockingEffects ?? [])
    .map((effect) => effect?.effectId)
    .filter((effectId) => typeof effectId === "string" && effectId.length > 0)
    .sort();
  const activeClaimRefs = (resume.activeClaims ?? [])
    .map((claim) => [
      "claim",
      claim?.nodeId,
      claim?.attemptId,
      claim?.fenceToken,
    ].join(":"))
    .filter((claimRef) => !claimRef.includes("undefined"))
    .sort();
  const bridgeSettlementState = failure
    ? "failed"
    : executionNodes.length > 0 && executionNodes.every(
        (node) => nodeRecordsById.get(node.nodeId)?.status === "completed",
      )
      ? "settled"
      : "incomplete";
  const eventChainState = durableRunProjection.eventChain?.ok === true
    ? "verified"
    : durableRunProjection.eventChain?.ok === false
      ? "failed"
      : "unknown";
  const authorityCoherent =
    durableRunProjection.schemaVersion === "durable-governed-run-projection-v0.1" &&
    durableRunProjection.run?.runId === resume.runId &&
    durableRunProjection.run?.graphDigest === durableContext.graphDigest &&
    durableRunProjection.run?.taskFingerprint === durableContext.taskFingerprint &&
    Number.isSafeInteger(durableRunProjection.cursor) &&
    durableRunProjection.cursor >= resume.cursor &&
    (
      durableRunProjection.events.length === 0 ||
      durableRunProjection.events.at(-1)?.eventSeq === durableRunProjection.cursor
    );
  const currentness = activeClaimRefs.length > 0
    ? "active_claim_present"
    : blockingEffectRefs.length > 0
      ? "unresolved_effect_present"
      : authorityCoherent && bridgeSettlementState === "settled"
        ? "bound_same_bridge_settlement"
        : "unproven";
  const lastEvent = durableRunProjection.events.at(-1) ?? null;
  const projectionBinding = {
    schemaVersion: durableRunProjection.schemaVersion,
    runId: durableRunProjection.run?.runId ?? null,
    taskFingerprint: durableRunProjection.run?.taskFingerprint ?? null,
    graphDigest: durableRunProjection.run?.graphDigest ?? null,
    runStatus: durableRunProjection.run?.status ?? null,
    cursor: durableRunProjection.cursor,
    headEventHash: lastEvent?.eventHash ?? null,
    headCheckpointId: durableRunProjection.headCheckpointId,
    eventChainState,
    blockingEffectRefs,
    activeClaimRefs,
    bridgeSettlementState,
  };
  return {
    source: "stage_runner_bridge_existing_authority_projection",
    projectionSchemaVersion: durableRunProjection.schemaVersion,
    runStatus: durableRunProjection.run?.status ?? "blocked",
    runId: durableRunProjection.run?.runId ?? resume.runId,
    taskFingerprint: sha256Reference(
      durableRunProjection.run?.taskFingerprint ?? durableContext.taskFingerprint,
    ),
    graphDigest: sha256Reference(
      durableRunProjection.run?.graphDigest ?? durableContext.graphDigest,
    ),
    cursor: durableRunProjection.cursor,
    headEventHash: lastEvent?.eventHash ? sha256Reference(lastEvent.eventHash) : null,
    headCheckpointId: durableRunProjection.headCheckpointId ?? null,
    projectionDigest: sha256Reference(JSON.stringify(projectionBinding)),
    eventChainState,
    blockingEffectRefs,
    activeClaimRefs,
    bridgeSettlementState,
    currentness,
  };
}

function schedulerFreshExecutionHeadSnapshot({
  durableContext,
  durableRunProjection,
  durableResume,
  executionNodes,
  nodeRecordsById,
}) {
  if (!durableContext || !durableRunProjection || !durableResume) return null;
  const continuationAuthority = continuationPolicyAuthoritySnapshot({
    durableContext: { ...durableContext, resume: durableResume },
    durableRunProjection,
    failure: null,
    executionNodes,
    nodeRecordsById,
  });
  if (!continuationAuthority) return null;
  const completedNodeIds = [...new Set(
    durableRunProjection.completedNodes.map((record) => record.nodeId),
  )].sort();
  const activeClaimNodeIds = [...new Set(
    (durableResume.activeClaims ?? []).map((claim) => claim.nodeId),
  )].sort();
  const unresolvedEffectNodeIds = [...new Set(
    (durableResume.blockingEffects ?? []).map((effect) => effect.nodeId),
  )].sort();
  const inDoubtNodeIds = [...new Set(
    durableRunProjection.events
      .filter((event) => event.eventType === "NodeAttemptInDoubt")
      .map((event) => event.nodeId)
      .filter((nodeId) => !completedNodeIds.includes(nodeId)),
  )].sort();
  const lastEvent = durableRunProjection.events.at(-1) ?? null;
  const stableHead =
    durableRunProjection.cursor === durableResume.cursor &&
    durableRunProjection.headCheckpointId === durableResume.headCheckpointId &&
    (lastEvent === null || lastEvent.eventSeq === durableResume.cursor);
  const currentness =
    continuationAuthority.currentness === "bound_same_bridge_settlement" && stableHead
      ? "fresh_bound_for_shadow_selection"
      : "unproven";
  const rawRunStatus = durableRunProjection.run.status;
  const runStatus = ["active", "completed", "failed", "blocked"].includes(rawRunStatus)
    ? rawRunStatus
    : "blocked";
  const snapshot = {
    source: "upstream_durable_kernel_projection_owner",
    runId: continuationAuthority.runId,
    taskFingerprint: continuationAuthority.taskFingerprint,
    graphDigest: continuationAuthority.graphDigest,
    projectionDigest: continuationAuthority.projectionDigest,
    cursor: continuationAuthority.cursor,
    headEventHash: continuationAuthority.headEventHash,
    headCheckpointId: continuationAuthority.headCheckpointId,
    runStatus,
    eventChainState: continuationAuthority.eventChainState,
    completedNodeIds,
    activeClaimNodeIds,
    unresolvedEffectNodeIds,
    inDoubtNodeIds,
    currentness,
  };
  return {
    ...snapshot,
    snapshotDigest: canonicalDigestReference(snapshot),
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
  executeReadySet = executeNativeReadySet,
  readySetTimeoutMs = null,
  evidenceKind = "native_read_only_stage_runner",
  evidenceTransitionShadow = null,
  continuationPolicyShadow = null,
  todoDependencySafeProgressShadow = null,
  schedulerAuthorityReuseShadow = null,
  leaseClaimAuthorityShadow = null,
  runtimeHealthProjection = null,
  quotaUsageProjection = null,
  readOnlyRunProjectionSurfaces = null,
  durable = null,
  redactionEnv = process.env,
}) {
  const normalizedRuntime = normalizeStageRunnerRuntime(runtime);
  const nativeRuntimeInvokerSelected = invokeWorker === invokeReadOnlyRuntimeWorker;
  const resolvedEvidenceKind = nativeRuntimeInvokerSelected
    ? "native_read_only_stage_runner"
    : evidenceKind === "native_read_only_stage_runner"
      ? "injected_stage_runner_callback"
      : evidenceKind;
  if (!SUPPORTED_RUNTIMES.has(normalizedRuntime)) {
    throw new TypeError(`Unsupported stage-runner runtime: ${runtime}`);
  }
  if (stageDagPacket?.authority !== "config/contracts/core-loop-contract.json") {
    throw new TypeError("stageDagPacket must retain the core-loop contract as its authority");
  }
  validateStageDagPacket(stageDagPacket, { requireDigest: true });
  const durableContext = await prepareDurableBridgeContext({ durable, runId, stageDagPacket });
  try {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const redactionContext = buildRedactionContext(resolvedWorkspace, redactionEnv);
  const completedNodeIds = new Set(executionPrefixCompletedNodeIds(stageDagPacket));
  const executionNodes = stageDagPacket.nodes.filter((node) => node.stage === "Execution");
  const nodeRecordsById = new Map();
  const workerResultsByNodeId = new Map();
  const durableClaimsByNodeId = new Map();
  const nativeInvocationAttemptedNodeIds = new Set();
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
  const readySetAdapterBatches = [];
  let readySetBatchIndex = 0;

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
    const executeNode = async (node, signal = null) => {
      const nodeStartedAt = new Date();
      const nodeStartedHr = process.hrtime.bigint();
      const dependencyResults = node.dependsOn
        .map((dependencyId) => nodeRecordsById.get(dependencyId))
        .filter(Boolean);
      const claim = durableClaimForNode(durableContext, node, dependencyResults);
      if (claim) durableClaimsByNodeId.set(node.nodeId, claim);
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
            evidenceKind: resolvedEvidenceKind,
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
            evidenceKind: resolvedEvidenceKind,
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
            evidenceKind: resolvedEvidenceKind,
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
            if (nativeRuntimeInvokerSelected) {
              nativeInvocationAttemptedNodeIds.add(node.nodeId);
            }
            result = await invokeWorker({
              runtime: normalizedRuntime,
              prompt,
              workspaceRoot: resolvedWorkspace,
              timeoutMs,
              node,
              packet,
              signal,
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
            evidenceKind: resolvedEvidenceKind,
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
    };
    const canonicalReadyNodes = new Map(ready.readyNodes.map((node) => [node.nodeId, node]));
    const adapterReadyNodes = Object.freeze(
      ready.readyNodes.map((node) => Object.freeze({ nodeId: node.nodeId })),
    );
    const controllerInvocationCounts = new Map();
    const controllerPromises = new Map();
    const controllerSettlements = new Map();
    const controllerNodeResults = new Map();
    let controllerViolation = null;
    let controllerOpen = true;
    let controllerSignal = null;
    const observedRejection = (error) => {
      const rejected = Promise.reject(error);
      void rejected.catch(() => {});
      return rejected;
    };
    const guardedExecuteNode = (candidateNodeId) => {
      const nodeId = String(candidateNodeId ?? "");
      const canonicalNode = canonicalReadyNodes.get(nodeId);
      if (!controllerOpen) {
        const error = new Error(`Ready-set callback arrived after the batch was closed: ${nodeId || "missing"}`);
        error.code = "ready_set_callback_after_close";
        controllerViolation ??= error;
        return observedRejection(error);
      }
      if (!canonicalNode) {
        const error = new Error(`Ready-set adapter attempted a node outside the scheduler selection: ${nodeId || "missing"}`);
        error.code = "adapter_unknown_node";
        controllerViolation ??= error;
        return observedRejection(error);
      }
      const nextCount = (controllerInvocationCounts.get(nodeId) ?? 0) + 1;
      controllerInvocationCounts.set(nodeId, nextCount);
      if (nextCount !== 1) {
        const error = new Error(`Ready-set adapter attempted to invoke a node more than once: ${nodeId}`);
        error.code = "adapter_duplicate_node_invocation";
        controllerViolation ??= error;
        return observedRejection(error);
      }
      try {
        validateStageDagPacket(stageDagPacket, { requireDigest: true });
      } catch (error) {
        error.code ??= "stage_dag_integrity_failed";
        controllerViolation ??= error;
        return observedRejection(error);
      }
      const controllerPromise = (async () => {
        try {
          const value = await executeNode(canonicalNode, controllerSignal);
          if (value?.nodeId !== nodeId) {
            const error = new Error(`Controller callback result identity changed for ${nodeId}`);
            error.code = "controller_result_identity_mismatch";
            throw error;
          }
          controllerSettlements.set(nodeId, { nodeId, status: "fulfilled", value });
          controllerNodeResults.set(nodeId, value);
          return value;
        } catch (error) {
          const safeFailureMessage = redactSensitiveText(error.message, redactionContext);
          const safeFailureClass = /^[a-z0-9_:-]{1,120}$/iu.test(String(error.code ?? ""))
            ? String(error.code)
            : "ready_set_node_rejected";
          const failedResult = {
            nodeId,
            status: "failed",
            failureClass: safeFailureClass,
            failureMessage: safeFailureMessage,
          };
          controllerSettlements.set(nodeId, {
            nodeId,
            status: "rejected",
            error: { code: safeFailureClass, message: safeFailureMessage },
          });
          controllerNodeResults.set(nodeId, failedResult);
          throw error;
        }
      })();
      void controllerPromise.catch(() => {});
      controllerPromises.set(nodeId, controllerPromise);
      return controllerPromise;
    };
    let batchResults;
    let adapterTimeout;
    let adapterAbortController;
    try {
      adapterAbortController = new AbortController();
      controllerSignal = adapterAbortController.signal;
      const effectiveReadySetTimeoutMs = Math.max(
        1,
        Number.parseInt(String(readySetTimeoutMs ?? (timeoutMs + 5_000)), 10) || (timeoutMs + 5_000),
      );
      const adapterTimeoutPromise = new Promise((_, reject) => {
        adapterTimeout = setTimeout(() => {
          adapterAbortController.abort("ready_set_adapter_safety_timeout");
          const error = new Error(
            `Ready-set adapter exceeded the ${effectiveReadySetTimeoutMs}ms process safety timeout`,
          );
          error.code = "ready_set_adapter_safety_timeout";
          reject(error);
        }, effectiveReadySetTimeoutMs);
      });
      const adapterResult = await Promise.race([
        Promise.resolve().then(() => executeReadySet({
          runId,
          graphDigest: stageDagPacket.graphDigest,
          readyNodes: adapterReadyNodes,
          executeNode: guardedExecuteNode,
          batchIndex: readySetBatchIndex,
          signal: adapterAbortController.signal,
        })),
        adapterTimeoutPromise,
      ]);
      if (controllerViolation) throw controllerViolation;
      for (const node of ready.readyNodes) {
        if (controllerInvocationCounts.get(node.nodeId) !== 1) {
          const error = new Error(`Bridge did not observe exactly one callback for ${node.nodeId}`);
          error.code = "adapter_controller_invocation_mismatch";
          throw error;
        }
      }
      await Promise.race([
        Promise.allSettled([...controllerPromises.values()]),
        adapterTimeoutPromise,
      ]);
      if (controllerViolation) throw controllerViolation;
      for (const node of ready.readyNodes) {
        if (controllerInvocationCounts.get(node.nodeId) !== 1) {
          const error = new Error(`Bridge callback count changed after settlement for ${node.nodeId}`);
          error.code = "adapter_controller_invocation_mismatch";
          throw error;
        }
      }
      clearTimeout(adapterTimeout);
      adapterTimeout = null;
      const validatedAdapterResult = validateReadySetAdapterResult(adapterResult, {
        runId,
        graphDigest: stageDagPacket.graphDigest,
        readyNodes: adapterReadyNodes,
        batchIndex: readySetBatchIndex,
      });
      for (const node of ready.readyNodes) {
        const adapterSettlement = validatedAdapterResult.results.find(
          (result) => result.nodeId === node.nodeId,
        );
        const controllerSettlement = controllerSettlements.get(node.nodeId);
        if (
          !controllerSettlement ||
          adapterSettlement?.status !== controllerSettlement.status ||
          (
            controllerSettlement.status === "fulfilled" &&
            JSON.stringify(adapterSettlement.value) !== JSON.stringify(controllerSettlement.value)
          )
        ) {
          const error = new Error(`Adapter substituted controller-owned result truth for ${node.nodeId}`);
          error.code = "adapter_result_substitution";
          throw error;
        }
      }
      readySetAdapterBatches.push({
        ...validatedAdapterResult,
        controllerInvocationEvidence: ready.readyNodes.map((node) => ({
          nodeId: node.nodeId,
          invocationCount: controllerInvocationCounts.get(node.nodeId),
        })),
        results: validatedAdapterResult.results.map((result) => ({
          nodeId: result.nodeId,
          status: result.status,
        })),
      });
      batchResults = ready.readyNodes.map((node) => controllerNodeResults.get(node.nodeId));
      readySetBatchIndex += 1;
    } catch (error) {
      clearTimeout(adapterTimeout);
      adapterTimeout = null;
      controllerOpen = false;
      if (adapterAbortController && !adapterAbortController.signal.aborted) {
        adapterAbortController.abort(error.code ?? "ready_set_adapter_failed");
      }
      if (controllerPromises.size > 0) {
        await Promise.allSettled([...controllerPromises.values()]);
      }
      const safeFailureMessage = redactSensitiveText(error.message, redactionContext);
      const safeFailureClass = /^[a-z0-9_:-]{1,120}$/iu.test(String(error.code ?? ""))
        ? String(error.code)
        : "ready_set_executor_failed";
      failure = {
        failureClass: safeFailureClass,
        reason: safeFailureMessage,
      };
      readySetAdapterBatches.push({
        schemaVersion: "meta-kim-ready-set-adapter-result-v0.1",
        prdTaskId: "P-119",
        status: "failed",
        runId,
        graphDigest: stageDagPacket.graphDigest,
        batchIndex: readySetBatchIndex,
        selectedNodeIds: ready.readyNodes.map((node) => node.nodeId),
        failureClass: failure.failureClass,
        failureMessage: safeFailureMessage,
      });
      break;
    } finally {
      controllerOpen = false;
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
  const nodeRecords = executionNodes.map((node) => nodeRecordsById.get(node.nodeId)).filter(Boolean);
  const workerResults = executionNodes
    .map((node) => workerResultsByNodeId.get(node.nodeId))
    .filter(Boolean);
  const bridgeCallbackCompleted = !failure && workerResults.length > 0;
  const nativeRuntimeInvoked =
    bridgeCallbackCompleted &&
    nativeRuntimeInvokerSelected &&
    workerResults.every(
      (result) => result.evidenceKind === "native_read_only_stage_runner",
    );
  const durableRunProjection = durableContext
    ? durableContext.kernel.projectRun(runId)
    : null;
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
      plannedIsInvoked: nativeRuntimeInvoked,
      bridgeCallbackCompleted,
      nativeRuntimeInvoked,
      requiredEvidence: "runId + nodeId + native runtime process + terminal result",
      evidenceRef: "coreLoop.stageRunnerBridgePacket.nodeRecords",
    },
    durable: durableContext
      ? {
          enabled: true,
          resumed: durableContext.resumed,
          leaseMs: durableContext.leaseMs,
          heartbeatIntervalMs: durableContext.heartbeatIntervalMs,
          projection: durableRunProjection,
        }
      : { enabled: false, resumed: false },
  };
  const evidenceTransitionShadowProjection = failure || evidenceTransitionShadow == null
    ? null
    : buildEvidenceTransitionShadowProjection(evidenceTransitionShadow, {
        authoritativeBinding: evidenceTransitionAuthorityBinding({
          durableContext,
          durableRunProjection,
          stageDagPacket,
          executionNodes,
          durableClaimsByNodeId,
          evidenceTransitionShadow,
        }),
      });
  const continuationPolicyShadowProjection = continuationPolicyShadow == null
    ? null
    : buildContinuationPolicyShadowProjection(continuationPolicyShadow, {
        authoritativeSnapshot: continuationPolicyAuthoritySnapshot({
          durableContext,
          durableRunProjection,
          failure,
          executionNodes,
          nodeRecordsById,
        }),
        evidenceTransitionShadowProjection,
      });
  const todoDependencySafeProgressShadowProjection = todoDependencySafeProgressShadow == null
    ? null
    : buildTodoDependencySafeProgressShadowProjection(
        todoDependencySafeProgressShadow,
        {
          authoritativeTopology: stageDagPacket,
          authoritativeExecutionSnapshot: durableContext && durableRunProjection
            ? {
                durableRunProjection,
                durableResume: durableContext.resume,
                nodeRecords: nodeRecords.map((record) => ({
                  nodeId: record.nodeId,
                  status: record.status,
                })),
              }
            : null,
          evidenceTransitionShadowProjection,
          continuationPolicyShadowProjection,
        },
      );
  let schedulerFreshHeadSnapshot = null;
  if (schedulerAuthorityReuseShadow != null && durableContext) {
    try {
      const freshProjection = durableContext.kernel.projectRun(runId);
      const freshResume = durableContext.kernel.resumeRun({
        runId,
        graphDigest: durableContext.graphDigest,
        taskFingerprint: durableContext.taskFingerprint,
      });
      schedulerFreshHeadSnapshot = schedulerFreshExecutionHeadSnapshot({
        durableContext,
        durableRunProjection: freshProjection,
        durableResume: freshResume,
        executionNodes,
        nodeRecordsById,
      });
    } catch {
      schedulerFreshHeadSnapshot = null;
    }
  }
  const rawTrustedSchedulerCapacity = capacity ?? stageDagPacket.runtimeCapacity;
  const trustedSchedulerCapacity = Number.isSafeInteger(rawTrustedSchedulerCapacity) &&
    rawTrustedSchedulerCapacity > 0
    ? rawTrustedSchedulerCapacity
    : null;
  const schedulerAuthorityReuseShadowProjection = schedulerAuthorityReuseShadow == null
    ? null
    : buildSchedulerAuthorityReuseShadowPlan(schedulerAuthorityReuseShadow, {
        authoritativeStageDagPacket: stageDagPacket,
        freshExecutionHeadSnapshot: schedulerFreshHeadSnapshot,
        todoDependencySafeProgressShadowProjection,
        trustedSelectionContext: {
          stage: null,
          capacity: trustedSchedulerCapacity,
        },
      });
  let leaseClaimExecutionSnapshot = null;
  let leaseClaimObservationContext = null;
  if (leaseClaimAuthorityShadow != null && durableContext) {
    try {
      const freshProjection = durableContext.kernel.projectRun(runId);
      const freshResume = durableContext.kernel.resumeRun({
        runId,
        graphDigest: durableContext.graphDigest,
        taskFingerprint: durableContext.taskFingerprint,
      });
      leaseClaimExecutionSnapshot = {
        durableRunProjection: freshProjection,
        durableResume: freshResume,
      };
      leaseClaimObservationContext = {
        source: "stage_runner_bridge_wall_clock_capture",
        observedAtMs: Date.now(),
      };
    } catch {
      leaseClaimExecutionSnapshot = null;
      leaseClaimObservationContext = null;
    }
  }
  const leaseClaimAuthorityProjection = leaseClaimAuthorityShadow == null
    ? null
    : buildLeaseClaimAuthorityShadowProjection(leaseClaimAuthorityShadow, {
        authoritativeStageDagPacket: stageDagPacket,
        authoritativeExecutionSnapshot: leaseClaimExecutionSnapshot,
        schedulerAuthorityReuseShadowProjection,
        trustedObservationContext: leaseClaimObservationContext,
      });
  let runtimeHealthRegistryBinding = null;
  let trustedRuntimeObservation = null;
  const bridgeProjectionObservedAt = runtimeHealthProjection != null || quotaUsageProjection != null
    ? Date.now()
    : null;
  if (runtimeHealthProjection != null) {
    trustedRuntimeObservation = buildTrustedRuntimeHealthObservation({
      runtimeId: normalizedRuntime,
      nativeRuntimeInvokerSelected,
      nativeInvocationAttemptedNodeIds,
      nodeRecords,
      observedAt: bridgeProjectionObservedAt,
    });
    runtimeHealthRegistryBinding = buildRuntimeHealthRegistryBinding({
      runtimeId: normalizedRuntime,
      runtimeMode: nativeRuntimeInvokerSelected ? "native_cli" : "injected_callback",
      evidenceLedgerDigest: canonicalDigestReference({
        runId,
        runtimeId: normalizedRuntime,
        observationDigest: trustedRuntimeObservation.observationDigest,
      }),
    });
  }
  const runtimeHealthProjectionResult = runtimeHealthProjection == null
    ? null
    : buildRuntimeHealthProjection(runtimeHealthProjection, {
        authoritativeStageDagPacket: stageDagPacket,
        authoritativeExecutionSnapshot: leaseClaimExecutionSnapshot,
        leaseClaimAuthorityShadowProjection: leaseClaimAuthorityProjection,
        runtimeRegistryBinding: runtimeHealthRegistryBinding,
        trustedRuntimeObservation,
      });
  let quotaExecutionSnapshot = null;
  let trustedQuotaUsageObservation = null;
  if (quotaUsageProjection != null && durableContext) {
    try {
      quotaExecutionSnapshot = {
        durableRunProjection: durableContext.kernel.projectRun(runId),
        durableResume: durableContext.kernel.resumeRun({
          runId,
          graphDigest: durableContext.graphDigest,
          taskFingerprint: durableContext.taskFingerprint,
        }),
      };
      trustedQuotaUsageObservation = buildTrustedQuotaUsageObservation({
        authoritativeExecutionSnapshot: quotaExecutionSnapshot,
        observedAt: bridgeProjectionObservedAt,
      });
    } catch {
      quotaExecutionSnapshot = null;
      trustedQuotaUsageObservation = null;
    }
  }
  const quotaUsageProjectionResult = quotaUsageProjection == null
    ? null
    : buildQuotaUsageProjection(quotaUsageProjection, {
        authoritativeStageDagPacket: stageDagPacket,
        authoritativeExecutionSnapshot: quotaExecutionSnapshot,
        trustedQuotaPolicy: runQuotaPolicy,
        trustedUsageObservation: trustedQuotaUsageObservation,
      });
  let readOnlyRunProjectionSurfacesResult = null;
  if (readOnlyRunProjectionSurfaces != null) {
    let authoritySnapshot = null;
    try {
      const freshProjection = durableContext?.kernel.projectRun(runId) ?? null;
      const freshResume = durableContext?.kernel.resumeRun({
        runId,
        graphDigest: durableContext?.graphDigest,
        taskFingerprint: durableContext?.taskFingerprint,
      }) ?? null;
      if (freshProjection && freshResume) {
        const canonicalProjectionEnvelopes = [
          evidenceTransitionShadowProjection,
          continuationPolicyShadowProjection,
          todoDependencySafeProgressShadowProjection,
          schedulerAuthorityReuseShadowProjection,
          leaseClaimAuthorityProjection,
          runtimeHealthProjectionResult,
          quotaUsageProjectionResult,
        ];
        authoritySnapshot = buildReadOnlyRunAuthoritySnapshot({
          authoritativeDurableProjection: freshProjection,
          authoritativeDurableResume: freshResume,
          stageDag: stageDagPacket,
          canonicalProjectionEnvelopes,
        });
      }
    } catch {
      authoritySnapshot = null;
    }
    const presentationOptions = readOnlyRunProjectionSurfaces && typeof readOnlyRunProjectionSurfaces === "object"
      ? readOnlyRunProjectionSurfaces
      : {};
    readOnlyRunProjectionSurfacesResult = buildReadOnlyRunProjectionSurfacesAdapter({}, {
      authoritySnapshot,
      copy: presentationOptions.copy,
      statusColumnMap: presentationOptions.statusColumnMap,
    });
  }
  const bridge = {
    schemaVersion: "stage-runner-bridge-v0.1",
    prdTaskId: "P-117",
    status: failure ? "failed" : "pass",
    mode: "read_only_shadow",
    runtime: normalizedRuntime,
    invocationAuthority: nativeRuntimeInvokerSelected
      ? "built_in_native_read_only_subprocess"
      : "injected_callback",
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
    readySetAdapterPacket: {
      schemaVersion: "meta-kim-ready-set-adapter-packet-v0.1",
      prdTaskId: "P-119",
      status: failure ? "failed" : "pass",
      authorityPacketRef: "coreLoop.stageDagPacket",
      graphDigest: stageDagPacket.graphDigest ?? null,
      checkpointAuthority: "p118_durable_run_kernel_only",
      adapterIds: [...new Set(readySetAdapterBatches.map((batch) => batch.adapterId).filter(Boolean))],
      batches: readySetAdapterBatches,
    },
    ...(evidenceTransitionShadowProjection
      ? { evidenceTransitionShadowProjection }
      : {}),
    ...(continuationPolicyShadowProjection
      ? { continuationPolicyShadowProjection }
      : {}),
    ...(todoDependencySafeProgressShadowProjection
      ? { todoDependencySafeProgressShadowProjection }
      : {}),
    ...(schedulerAuthorityReuseShadowProjection
      ? { schedulerAuthorityReuseShadowProjection }
      : {}),
    ...(leaseClaimAuthorityProjection
      ? { leaseClaimAuthorityProjection }
      : {}),
    ...(runtimeHealthProjectionResult
      ? { runtimeHealthProjection: runtimeHealthProjectionResult }
      : {}),
    ...(quotaUsageProjectionResult
      ? { quotaUsageProjection: quotaUsageProjectionResult }
      : {}),
    ...(readOnlyRunProjectionSurfacesResult
      ? { readOnlyRunProjectionSurfaces: readOnlyRunProjectionSurfacesResult }
      : {}),
    compatibilityView: {
      stageDagStatus: executionProjection.status,
      nodeStatuses: executionProjection.nodeStatuses,
      invocationTruth: executionProjection.invocationTruth,
    },
  };
  if (nativeRuntimeInvokerSelected) nativeRuntimeBridgeAttestations.add(bridge);
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
  const bridgeCompleted = bridge.status === "pass" && bridge.workerResults.length > 0;
  const nativeExecutionObserved =
    bridgeCompleted &&
    nativeRuntimeBridgeAttestations.has(bridge) &&
    bridge.invocationAuthority === "built_in_native_read_only_subprocess" &&
    bridge.executionProjection?.invocationTruth?.nativeRuntimeInvoked === true &&
    bridge.workerResults.every(
      (result) => result.evidenceKind === "native_read_only_stage_runner",
    );
  const workerResultPackets = coreLoop.executionResult.workerResultPackets.map((planned) => {
    const result = resultsByTask.get(planned.taskPacketId);
    if (!result) return planned;
    return {
      ...planned,
      status: "executed",
      resultKind: nativeExecutionObserved
        ? "native_read_only_worker_result"
        : "synthetic_read_only_worker_result",
      evidenceKind: result.evidenceKind,
      output: {
        producedBy: `${bridge.runtime}_stage_runner_bridge`,
        ownerBoundary: planned.ownerAgent ?? planned.owner,
        externalWritePerformed: false,
        text: result.outputText,
        textSha256: result.outputSha256,
      },
      note: nativeExecutionObserved
        ? "A native runtime process returned a terminal result for this bounded read-only worker task; Review still owns semantic acceptance."
        : "A synthetic callback returned a terminal result for this bounded read-only worker task; this proves bridge and recovery behavior, not native runtime execution.",
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
      liveWorkerExecution: nativeExecutionObserved,
      externalAgentSpawned: false,
      runtimeProcessInvoked: nativeExecutionObserved,
      runtime: bridge.runtime,
      sessionId: result.sessionId,
      messageId: result.messageId,
      observedDurationMs: result.observedDurationMs,
      outputSha256: result.outputSha256,
      hostEventCount: result.hostEventCount,
      toolEventCount: result.toolEventCount,
      reason: nativeExecutionObserved
        ? "A native read-only runtime result was observed and merged; this proves invocation, while Review owns semantic acceptance."
        : "A synthetic read-only callback result was merged for bridge and recovery verification; native runtime invocation is not claimed.",
    };
  });
  const stageTiming = coreLoop.traceEvalControlPlane.stageTiming.map((timing) =>
    timing.stage === "Execution"
      ? {
          ...timing,
          timingRecordStatus: nativeExecutionObserved
            ? "native_runtime_observed"
            : "synthetic_callback_observed",
          observedDurationMs: bridge.observedDurationMs,
          durationMeasurementNote: nativeExecutionObserved
            ? "Measured from the native stage-runner bridge start/end boundaries."
            : "Measured from synthetic bridge callback boundaries; native runtime timing is not claimed.",
        }
      : timing
  );
  const langGraphRunPacket = {
    ...coreLoop.langGraphRunPacket,
    runtimeExecutionEvidence: nativeExecutionObserved
      ? "native_stage_runner_bridge"
      : bridgeCompleted
        ? "synthetic_stage_runner_bridge"
        : "stage_runner_bridge_failed",
    runtimeBoundary: nativeExecutionObserved
      ? `The authoritative stage DAG was executed in ${bridge.runtime} read-only shadow mode; this does not claim LangGraph runtime usage.`
      : "The authoritative stage DAG was exercised by a synthetic callback; this proves bridge and recovery behavior but not native runtime or LangGraph execution.",
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
      actualWorkerExecution: nativeExecutionObserved,
      executionClosure: nativeExecutionObserved
        ? "run_scoped_worker_executed"
        : bridgeCompleted
          ? "synthetic_worker_result_observed"
          : "worker_execution_failed",
      workerResultPackets,
      workerExecutionEvidence,
      mergeResult: {
        ...coreLoop.executionResult.mergeResult,
        status: bridgeCompleted ? "worker_results_merged" : "worker_merge_failed",
        liveExecutionMerged: nativeExecutionObserved,
        bridgeEvidenceRef: "coreLoop.stageRunnerBridgePacket",
      },
    },
  };
}
