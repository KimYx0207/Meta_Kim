import { createHash } from "node:crypto";
import {
  createLiveReadRepository,
  isLiveRunId,
  normalizeLiveRunId,
  resolveLiveProjectRoot,
} from "../../infrastructure/live/live-read-repository.mjs";
import { buildLiveShareArtifact } from "./build-live-share-artifact.mjs";
import {
  renderLiveReadmeEmbed,
  renderLiveShareCard,
} from "../../presentation/live/render-live-share-card.mjs";
import {
  executeLiveContinuation,
  planLiveContinuation,
} from "./plan-live-continuation.mjs";

export const LIVE_SNAPSHOT_SCHEMA_VERSION = "meta-kim-live-snapshot-v2";
export const LIVE_REPLAY_SCHEMA_VERSION = "meta-kim-live-replay-v2";
export const LIVE_COMPACT_PROJECTION_SCHEMA_VERSION = "meta-kim-live-projection-v2";
export const LIVE_MAX_COMPACT_BYTES = 256 * 1024;
export const LIVE_STALE_AFTER_MS = 10 * 60 * 1000;
export const LIVE_MAX_NODES = 128;
export const LIVE_MAX_EDGES = 256;
export const LIVE_MAX_EVIDENCE = 256;
export const LIVE_MAX_REPLAY = 512;
export const LIVE_MAX_STRING = 240;
export const LIVE_MAX_CONTEXT_TRANSFERS = 128;
export const LIVE_MAX_CONTEXT_EVIDENCE_REFS = 24;

const STAGES = [
  "critical",
  "fetch",
  "thinking",
  "execution",
  "review",
  "meta-review",
  "verification",
  "evolution",
];

const STAGE_LABELS = {
  critical: "Critical",
  fetch: "Fetch",
  thinking: "Thinking",
  execution: "Execution",
  review: "Review",
  "meta-review": "Meta-Review",
  verification: "Verification",
  evolution: "Evolution",
};

const STATUS_ALIASES = new Map([
  ["running", "active"],
  ["in_progress", "active"],
  ["in-progress", "active"],
  ["started", "active"],
  ["success", "completed"],
  ["succeeded", "completed"],
  ["pass", "completed"],
  ["passed", "completed"],
  ["done", "completed"],
  ["failure", "failed"],
  ["error", "failed"],
  ["planned_not_executed", "pending"],
  ["pending_execution", "pending"],
  ["selected_not_invoked", "pending"],
  ["skipped", "pending"],
  ["partial", "in_doubt"],
  ["unknown", "in_doubt"],
  ["stale", "in_doubt"],
  ["uncertain", "in_doubt"],
]);

const SAFE_STATUS = new Set([
  "active",
  "completed",
  "pending",
  "failed",
  "blocked",
  "cancelled",
  "session_stopped",
  "archived",
  "in_doubt",
]);

const SAFE_KINDS = new Set([
  "stage",
  "transition",
  "node",
  "evidence",
  "review",
  "verification",
  "status",
  "agent",
  "workflow",
  "tool",
  "tool_start",
  "tool_end",
  "failure",
  "in_doubt",
]);

const SECRET_ASSIGNMENT_PATTERN = /(?:api[ _-]?key|access[ _-]?token|auth(?:entication|orization)?|bearer|credential|password|passphrase|private[ _-]?key|secret|token)\s*[:=]/iu;
const BEARER_CREDENTIAL_PATTERN = /\bbearer\s+[A-Za-z0-9][A-Za-z0-9._~+/-]{3,}(?=$|[\s,;:)\]}])/iu;
const LABELED_CREDENTIAL_PATTERN = /\b(?:api[ _-]?key|access[ _-]?token|auth(?:entication|orization)?|credential|password|passphrase|private[ _-]?key|secret|token)\s+([A-Za-z0-9][A-Za-z0-9._~+/-]{6,})(?=$|[\s,;:)\]}])/iu;
const KNOWN_SECRET_VALUE_PATTERN = /\b(?:gh[pousr]_|github_pat_|AKIA|ASIA)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}|-----BEGIN [A-Z ]+KEY-----|\bsk-[A-Za-z0-9_-]{8,}\b/iu;
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|(?:^|[\s"'(<\[{=:;,])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)/u;
const HOME_OR_FILE_URI_PATTERN = /(?:^|[\s"'(<\[{=:;,])(?:~[\\/]|(?:file|vscode|vscode-insiders):\/\/|file%3a%2f%2f)/iu;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/gu;

function containsSecret(value) {
  if (
    SECRET_ASSIGNMENT_PATTERN.test(value) ||
    BEARER_CREDENTIAL_PATTERN.test(value) ||
    KNOWN_SECRET_VALUE_PATTERN.test(value)
  ) {
    return true;
  }
  const labeled = LABELED_CREDENTIAL_PATTERN.exec(value);
  if (!labeled) return false;
  const credential = labeled[1];
  return credential.length >= 16 ||
    /[0-9._~+/-]/u.test(credential) ||
    (/[a-z]/u.test(credential) && /[A-Z]/u.test(credential));
}

function publicId(kind, value) {
  const digest = createHash("sha256").update(String(value ?? "unknown"), "utf8").digest("hex").slice(0, 20);
  return `${kind}:${digest}`;
}

function exactTaskId(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function boundedArray(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function safeNullableText(value, max = LIVE_MAX_STRING) {
  const projected = safeText(value, "", max);
  return projected || null;
}

function safeStringList(value, max = 16) {
  return boundedArray(value, max)
    .map((item) => safeNullableText(item))
    .filter(Boolean);
}

function observedValue(value, observed) {
  const safeValue = safeNullableText(value, 120);
  return observed === true && safeValue
    ? { state: "observed", value: safeValue }
    : { state: "unavailable", value: null };
}

function observedCount(value, observed) {
  return observed === true && Number.isSafeInteger(value) && value >= 0
    ? { state: "observed", value }
    : { state: "unavailable", value: null };
}

function unavailableObservation() {
  return { state: "unavailable", value: null };
}

function safeObservedField(source, keys, { count = false } = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return unavailableObservation();
  for (const key of keys) {
    const raw = source[key];
    const wrapped = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    const observed = wrapped?.state === "observed" || wrapped?.observed === true || source.observed === true;
    const value = wrapped ? wrapped.value : raw;
    if (!observed) continue;
    if (count) return observedCount(value, true);
    const projected = safeNullableText(value, 120);
    if (projected && !["redacted", "[path omitted]"].includes(projected)) {
      return { state: "observed", value: projected };
    }
  }
  return unavailableObservation();
}

function repositoryProjection(artifact) {
  const source = artifact?.repositoryObservation || artifact?.repository;
  return {
    name: safeObservedField(source, ["name", "repositoryName"]),
    branch: safeObservedField(source, ["branch", "branchName"]),
    worktree: safeObservedField(source, ["worktree", "worktreeState"]),
    pullRequest: safeObservedField(source, ["pullRequest", "pullRequestNumber", "pr"]),
    diff: safeObservedField(source, ["diff", "diffSummary", "diffState"]),
  };
}

function workspaceProjection(artifact) {
  const source = artifact?.workspaceObservation || artifact?.workspace;
  return {
    name: safeObservedField(source, ["name", "workspaceName"]),
    workspaceId: safeObservedField(source, ["workspaceId", "id"]),
    transcript: safeObservedField(source, ["transcript", "transcriptState"]),
    terminal: safeObservedField(source, ["terminal", "terminalState"]),
  };
}

function safeTransferCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : null;
}

function safeTransferRef(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,159}$/u.test(text)) return null;
  const projected = safeNullableText(text, 160);
  return projected && !["redacted", "[path omitted]"].includes(projected) ? projected : null;
}

function unsafeTransferPayload(value, depth = 0) {
  if (depth > 4) return true;
  if (typeof value === "string") {
    const projected = safeText(value, "", 240);
    return projected === "redacted" || projected === "[path omitted]";
  }
  if (Array.isArray(value)) return value.slice(0, 64).some((item) => unsafeTransferPayload(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.entries(value).slice(0, 64).some(([key, item]) =>
      unsafeTransferPayload(key, depth + 1) || unsafeTransferPayload(item, depth + 1));
  }
  return false;
}

function contextTransferProjection(artifact, runId, packets, nodeByTaskId, knownNodeIds) {
  const output = [];
  const byEndpoints = new Map();
  const append = (transfer) => {
    const key = `${transfer.fromNodeId}:${transfer.toNodeId}`;
    const prior = byEndpoints.get(key);
    if (prior !== undefined) output[prior] = transfer;
    else {
      byEndpoints.set(key, output.length);
      output.push(transfer);
    }
  };
  for (const packet of packets) {
    const toTaskId = taskIdFrom(packet);
    const toNodeId = nodeByTaskId.get(toTaskId);
    if (!toNodeId) continue;
    for (const dependency of boundedArray(packet?.dependsOn, 32)) {
      const fromNodeId = nodeByTaskId.get(exactTaskId(dependency));
      if (!fromNodeId || fromNodeId === toNodeId) continue;
      append({
        id: publicId("transfer", `${runId}:${fromNodeId}:${toNodeId}:dependency`),
        fromNodeId,
        toNodeId,
        kind: "dependency",
        state: "planned",
        summaryCount: null,
        decisionCount: null,
        fileCount: null,
        evidenceCount: null,
        observedAt: null,
        digest: null,
        bytes: null,
        compactionState: "unavailable",
        omittedCount: null,
        omissionReason: null,
        downstreamAcceptanceState: "unavailable",
        evidenceRefs: [],
      });
    }
  }

  const records = [artifact?.contextTransfers, artifact?.contextHandoffs]
    .filter(Array.isArray)
    .flat()
    .slice(0, LIVE_MAX_CONTEXT_TRANSFERS);
  const resolveNodeId = (record, nodeKeys, taskKeys) => {
    for (const key of nodeKeys) {
      const candidate = typeof record?.[key] === "string" ? record[key].trim() : null;
      if (candidate && knownNodeIds.has(candidate)) return candidate;
    }
    for (const key of taskKeys) {
      const taskId = exactTaskId(record?.[key]);
      const candidate = taskId ? nodeByTaskId.get(taskId) : null;
      if (candidate && knownNodeIds.has(candidate)) return candidate;
    }
    return null;
  };
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    if (recordRunId(record) !== runId || unsafeTransferPayload(record)) continue;
    const fromNodeId = resolveNodeId(
      record,
      ["fromNodeId", "sourceNodeId"],
      ["fromTaskPacketId", "fromTaskId", "sourceTaskPacketId", "sourceTaskId"],
    );
    const toNodeId = resolveNodeId(
      record,
      ["toNodeId", "targetNodeId"],
      ["toTaskPacketId", "toTaskId", "targetTaskPacketId", "targetTaskId"],
    );
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) continue;
    const observedAt = safeTimestamp(record.observedAt || record.completedAt || record.updatedAt);
    if (!observedAt) continue;
    const acceptance = String(record.downstreamAcceptanceState || record.acceptanceState || "unavailable").trim().toLowerCase();
    const evidenceRefs = boundedArray(record.evidenceRefs, LIVE_MAX_CONTEXT_EVIDENCE_REFS)
      .map(safeTransferRef)
      .filter(Boolean);
    if (Array.isArray(record.evidenceRefs) && evidenceRefs.length !== Math.min(record.evidenceRefs.length, LIVE_MAX_CONTEXT_EVIDENCE_REFS)) continue;
    const state = acceptance === "accepted" && evidenceRefs.length > 0 ? "accepted" : "observed";
    const digest = typeof record.digest === "string" && /^[a-f0-9]{64}$/iu.test(record.digest) ? record.digest.toLowerCase() : null;
    const bytes = Number.isSafeInteger(record.bytes) && record.bytes >= 0 && record.bytes <= LIVE_MAX_COMPACT_BYTES
      ? record.bytes
      : null;
    const compactionState = ["none", "compacted", "omitted", "unavailable"].includes(record.compactionState)
      ? record.compactionState
      : "unavailable";
    const omissionReason = safeNullableText(record.omissionReason, 160);
    if (omissionReason && ["redacted", "[path omitted]"].includes(omissionReason)) continue;
    append({
      id: publicId("transfer", `${runId}:${fromNodeId}:${toNodeId}:${record.id || record.kind || "handoff"}`),
      fromNodeId,
      toNodeId,
      kind: safeId(record.kind, "context_handoff"),
      state,
      summaryCount: safeTransferCount(record.summaryCount),
      decisionCount: safeTransferCount(record.decisionCount),
      fileCount: safeTransferCount(record.fileCount),
      evidenceCount: safeTransferCount(record.evidenceCount),
      observedAt,
      digest,
      bytes,
      compactionState,
      omittedCount: safeTransferCount(record.omittedCount),
      omissionReason,
      downstreamAcceptanceState: ["accepted", "rejected", "pending", "unavailable"].includes(acceptance)
        ? acceptance
        : "unavailable",
      evidenceRefs,
    });
  }
  return output.slice(0, LIVE_MAX_CONTEXT_TRANSFERS);
}

function safeCompactContextTransfers(records, runId, nodes) {
  const known = new Set(boundedArray(nodes, LIVE_MAX_NODES).map((node) => node?.id).filter(Boolean));
  return boundedArray(records, LIVE_MAX_CONTEXT_TRANSFERS).filter((record) => {
    if (!record || typeof record !== "object" || Array.isArray(record) || unsafeTransferPayload(record)) return false;
    if (!known.has(record.fromNodeId) || !known.has(record.toNodeId) || record.fromNodeId === record.toNodeId) return false;
    if (!/^(?:transfer):[a-f0-9]{20}$/u.test(record.id || "")) return false;
    if (!["planned", "observed", "accepted"].includes(record.state)) return false;
    if (record.state !== "planned" && !safeTimestamp(record.observedAt)) return false;
    if (record.digest !== null && !(typeof record.digest === "string" && /^[a-f0-9]{64}$/u.test(record.digest))) return false;
    if (record.bytes !== null && !(Number.isSafeInteger(record.bytes) && record.bytes >= 0 && record.bytes <= LIVE_MAX_COMPACT_BYTES)) return false;
    return boundedArray(record.evidenceRefs, LIVE_MAX_CONTEXT_EVIDENCE_REFS).every((item) => safeTransferRef(item) === item);
  }).map((record) => ({
    id: record.id,
    fromNodeId: record.fromNodeId,
    toNodeId: record.toNodeId,
    kind: safeId(record.kind, "context_handoff"),
    state: record.state === "planned"
      ? "planned"
      : record.state === "accepted"
        && record.downstreamAcceptanceState === "accepted"
        && boundedArray(record.evidenceRefs, LIVE_MAX_CONTEXT_EVIDENCE_REFS).length > 0
          ? "accepted"
          : "observed",
    summaryCount: safeTransferCount(record.summaryCount),
    decisionCount: safeTransferCount(record.decisionCount),
    fileCount: safeTransferCount(record.fileCount),
    evidenceCount: safeTransferCount(record.evidenceCount),
    observedAt: safeTimestamp(record.observedAt),
    digest: record.digest || null,
    bytes: record.bytes ?? null,
    compactionState: ["none", "compacted", "omitted", "unavailable"].includes(record.compactionState)
      ? record.compactionState
      : "unavailable",
    omittedCount: safeTransferCount(record.omittedCount),
    omissionReason: safeNullableText(record.omissionReason, 160),
    downstreamAcceptanceState: ["accepted", "rejected", "pending", "unavailable"].includes(record.downstreamAcceptanceState)
      ? record.downstreamAcceptanceState
      : "unavailable",
    evidenceRefs: boundedArray(record.evidenceRefs, LIVE_MAX_CONTEXT_EVIDENCE_REFS),
  }));
}

function nowIso(clock) {
  const value = typeof clock === "function" ? clock() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function safeTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeText(value, fallback = "in_doubt", max = LIVE_MAX_STRING) {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  let text = String(value).replace(CONTROL_PATTERN, " ").trim();
  if (!text) return fallback;
  if (containsSecret(text)) {
    return "redacted";
  }
  if (ABSOLUTE_PATH_PATTERN.test(text) || HOME_OR_FILE_URI_PATTERN.test(text)) return "[path omitted]";
  // Relative source paths, prompt fragments, and shell-like strings do not
  // carry useful control-room meaning and can accidentally expose internals.
  if (/(?:^|\s)(?:\.\.?|src|tests?|node_modules|canonical|config|scripts|docs?|\.codex|\.claude|\.cursor|\.agents|openclaw|graphify-out)[\\/]/iu.test(text)) {
    return "[path omitted]";
  }
  text = text.replace(/[<>]/gu, "").replace(/\s+/gu, " ");
  return text.slice(0, max);
}

function safeId(value, fallback = "in_doubt", prefix = "") {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(text) || containsSecret(text)) return fallback;
  return `${prefix}${text}`;
}

function normalizeStatus(value, fallback = "in_doubt") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, "_");
  const alias = STATUS_ALIASES.get(normalized) || normalized;
  return SAFE_STATUS.has(alias) ? alias : fallback;
}

function normalizeKind(value) {
  if (typeof value !== "string") return "in_doubt";
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, "_");
  return SAFE_KINDS.has(normalized) ? normalized : "in_doubt";
}

function normalizeStage(value) {
  if (typeof value !== "string") return "in_doubt";
  const normalized = value.trim().toLowerCase().replace(/[ _]+/gu, "-");
  return STAGES.includes(normalized) ? normalized : "in_doubt";
}

function objectValue(value, key) {
  return value && typeof value === "object" && !Array.isArray(value) ? value[key] : undefined;
}

function firstString(value, keys) {
  for (const key of keys) {
    const candidate = objectValue(value, key);
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

function sourceEnvelope(kind, observedAt, stale) {
  return {
    kind,
    observedAt,
    stale: Boolean(stale),
  };
}

function permissions() {
  return {
    projectionOnly: true,
    executionAllowed: false,
    mutationAllowed: false,
  };
}

function emptySnapshot(observedAt, kind = "empty", stale = true) {
  const safeObservedAt = safeTimestamp(observedAt) || new Date().toISOString();
  return {
    schemaVersion: LIVE_SNAPSHOT_SCHEMA_VERSION,
    source: sourceEnvelope(kind, safeObservedAt, stale),
    run: null,
    nodes: [],
    edges: [],
    evidence: [],
    replay: [],
    repository: repositoryProjection(null),
    workspace: workspaceProjection(null),
    contextTransfers: [],
    permissions: permissions(),
  };
}

function updatedAtFor(record) {
  const direct = safeTimestamp(
    record?.__updatedAt ||
      record?.updatedAt ||
      record?.deactivatedAt ||
      record?.completedAt ||
      record?.startedAt ||
      record?.triggeredAt ||
      record?.createdAt,
  );
  if (direct) return direct;
  const events = Array.isArray(record?.agUiStageEvents?.events)
    ? record.agUiStageEvents.events
    : Array.isArray(record?.coreLoop?.agUiStageEvents?.events)
      ? record.coreLoop.agUiStageEvents.events
      : [];
  const timestamps = events
    .map((event) => safeTimestamp(event?.timestamp || event?.at || event?.occurredAt))
    .filter(Boolean)
    .sort();
  return timestamps.at(-1) || null;
}

function isStale(updatedAt, observedAt, staleAfterMs) {
  if (!updatedAt) return true;
  const observed = Date.parse(observedAt);
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(updated)) return true;
  const ageMs = observed - updated;
  return ageMs < 0 || ageMs > staleAfterMs;
}

function structuredEvidencePassed(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rawStatus = firstString(value, ["status", "result", "closeState"]);
  if (!rawStatus) return false;
  const normalized = rawStatus.trim().toLowerCase().replace(/[ -]+/gu, "_");
  return normalizeStatus(rawStatus) === "completed" || normalized === "verified" || normalized === "verified_closed";
}

function passingVerificationEvidence(artifact) {
  const verification = artifact?.verificationPacket;
  if (!verification || typeof verification !== "object") return [];
  return [verification.verificationResults, verification.fixEvidence]
    .filter(Array.isArray)
    .flat()
    .filter(structuredEvidencePassed);
}

function passingWorkerEvidence(result) {
  return (Array.isArray(result?.workerExecutionEvidence) ? result.workerExecutionEvidence : [])
    .filter(structuredEvidencePassed);
}

function completionIsProven(artifact) {
  return passingVerificationEvidence(artifact).length > 0;
}

function recordTime(record) {
  const value = updatedAtFor(record);
  return value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
}

function taskIdFrom(record) {
  return exactTaskId(firstString(record, ["taskPacketId", "taskId", "roleInstanceId", "businessRoleId"]));
}

function recordRunId(record) {
  return normalizeLiveRunId(firstString(record, ["runId", "governedRunId", "sessionRunId"]));
}

function recordBelongsToRun(record, runId) {
  const explicitRunId = recordRunId(record);
  return !explicitRunId || explicitRunId === runId;
}

function readableWorkerScope(packet) {
  const shard = boundedArray(packet?.shardScope, 1).find((item) => typeof item === "string");
  const raw = firstString(packet, ["roleInstanceId", "taskLabel", "laneLabel"]) || shard;
  if (!raw) return null;
  const cleaned = raw
    .replace(/^exec[-_:]*/iu, "")
    .replace(/[-_:]+\d+$/u, "")
    .replace(/_+/gu, " ")
    .trim();
  return safeText(cleaned, null, 96);
}

function readableRunTask(artifact) {
  const candidate = firstString(artifact, ["task"])
    || firstString(artifact?.requestRecord, ["task"]);
  return safeText(candidate, "Governed execution", 240);
}

function readableRunTitle(artifact, task) {
  const explicit = firstString(artifact, ["title"]);
  if (explicit) return safeText(explicit, "Governed run", 120);
  const firstClause = String(task || "Governed execution").split(/[;；\n]/u)[0].trim();
  return safeText(firstClause, "Governed run", 120);
}

function liveWorkerResultMap(artifact, runId) {
  const results = new Map();
  for (const result of boundedArray(artifact?.workerResultPackets, LIVE_MAX_NODES)) {
    if (!recordBelongsToRun(result, runId)) continue;
    const taskId = taskIdFrom(result);
    if (taskId) results.set(taskId, result);
  }
  return results;
}

function trustedHostEvidence(artifact, runId) {
  const candidates = [
    artifact?.coreLoop?.runtimeInvocationPlanPacket?.evidence,
    artifact?.runtimeInvocationPlanPacket?.evidence,
    artifact?.hostInvocationEvidence,
  ];
  return candidates
    .filter(Array.isArray)
    .flat()
    .filter((item) => item?.proofValid === true && item?.synthetic !== true && recordBelongsToRun(item, runId))
    .slice(0, LIVE_MAX_EVIDENCE);
}

function evidenceForTask(evidence, taskId) {
  return evidence.filter((item) =>
    exactTaskId(item?.taskPacketId) === taskId || exactTaskId(item?.bindingRef) === taskId,
  );
}

function safeExecutionEvidence(result, taskId) {
  return boundedArray(result?.workerExecutionEvidence, 24).map((item, index) => ({
    id: publicId("proof", `${taskId}:${item?.verifyStepRef ?? index}`),
    status: normalizeStatus(firstString(item, ["status", "result"]), "in_doubt"),
    observedAt: safeTimestamp(item?.runAt || item?.occurredAt || item?.completedAt),
    label: `Worker evidence ${index + 1}`,
    detail: safeText(item?.observedResult || item?.expectedResult || item?.skipReason, "Evidence recorded by the governed run", 180),
    sourceRef: safeText(item?.verifyStepRef, null, 120),
  }));
}

function safeToolCalls(hostEvidence, taskId) {
  return evidenceForTask(hostEvidence, taskId)
    .filter((item) => !["agent_subagent", "agent_teams_playbook", "durable_agent"].includes(item?.family))
    .slice(0, 24)
    .map((item, index) => ({
      id: publicId("tool", `${taskId}:${item?.eventId ?? item?.evidenceRef ?? index}`),
      kind: safeText(item?.evidenceKind, "tool", 64),
      name: safeText(item?.providerId || item?.hostSurface, "tool", 96),
      status: normalizeStatus(item?.resultStatus || item?.state, "in_doubt"),
      occurredAt: safeTimestamp(item?.occurredAt),
    }));
}

function safeTelemetry(hostEvidence, taskId) {
  const observed = evidenceForTask(hostEvidence, taskId).find((item) => item?.proofValid === true);
  const usage = observed?.usage && typeof observed.usage === "object" ? observed.usage : {};
  const inputTokens = usage.inputTokens ?? usage.input_tokens;
  const outputTokens = usage.outputTokens ?? usage.output_tokens;
  const totalTokens = usage.totalTokens ?? usage.total_tokens;
  return {
    runtime: observedValue(observed?.runtime || observed?.hostSurface, Boolean(observed)),
    model: observedValue(observed?.model, Boolean(observed)),
    tokens: {
      input: observedCount(inputTokens, Boolean(observed)),
      output: observedCount(outputTokens, Boolean(observed)),
      total: observedCount(totalTokens, Boolean(observed)),
    },
  };
}

function plannedLoadout(packet) {
  const bindings = packet?.capabilityBindings && typeof packet.capabilityBindings === "object"
    ? packet.capabilityBindings
    : {};
  const count = (value) => Array.isArray(value) ? value.length : 0;
  const names = (value) => Array.isArray(value)
    ? value.slice(0, 24).map((item) => typeof item === "string"
      ? safeText(item, "", 96)
      : safeText(firstString(item, ["name", "id", "capability", "providerId"]), "", 96)).filter(Boolean)
    : [];
  const skills = bindings.skills ?? packet?.skillLoadout;
  const mcp = bindings.mcp ?? packet?.mcpLoadout;
  const tools = bindings.tools ?? packet?.toolLoadout;
  const commands = bindings.commands ?? packet?.commandLoadout;
  return {
    skills: count(skills),
    mcp: count(mcp),
    tools: count(tools),
    commands: count(commands),
    skillNames: names(skills),
    mcpNames: names(mcp),
    toolNames: names(tools),
    commandNames: names(commands),
  };
}

function firstArtifactTimestamp(artifact) {
  const timestamps = rawReplayEvents(artifact, null)
    .map((event) => safeTimestamp(event?.timestamp || event?.at || event?.occurredAt || event?.updatedAt))
    .filter(Boolean)
    .sort();
  return timestamps[0] || null;
}

function stageReplay(artifact, runId, mainNodeId = null) {
  const events = rawReplayEvents(artifact, null);
  if (events.some((event) => event?.runId !== undefined && normalizeLiveRunId(event.runId) !== runId)) {
    return [];
  }
  const output = [];
  for (const [index, event] of events.slice(0, LIVE_MAX_REPLAY).entries()) {
    const eventRunId = event?.runId == null ? runId : normalizeLiveRunId(event.runId);
    if (eventRunId !== runId) continue;
    const stage = normalizeStage(
      firstString(event, ["stage", "stageKey", "currentStage"]) ||
        (typeof event?.nodeId === "string" && event.nodeId.startsWith("stage:") ? event.nodeId.slice(6) : null),
    );
    if (stage === "in_doubt") continue;
    const eventType = safeText(event?.eventType || event?.kind || event?.type, "StageEvent", 64);
    const eventLabel = typeof event?.userFacingLabel === "object"
      ? firstString(event.userFacingLabel, ["zh-CN", "en"])
      : null;
    output.push({
      id: publicId("event", `${runId}:${event?.eventId ?? index}:${stage}`),
      eventIndex: output.length + 1,
      eventCount: 0,
      sequence: Number.isSafeInteger(event?.sequence) && event.sequence > 0 ? event.sequence : index + 1,
      at: safeTimestamp(event?.timestamp || event?.at || event?.occurredAt || event?.updatedAt),
      kind: "stage",
      order: 10,
      chapter: stage,
      stage,
      eventType,
      nodeId: mainNodeId,
      status: normalizeStatus(event?.status || event?.state, "in_doubt"),
      label: safeText(eventLabel || `${STAGE_LABELS[stage]} · ${eventType}`, `${STAGE_LABELS[stage]} · ${eventType}`, 160),
    });
  }
  output.sort((left, right) => left.sequence - right.sequence || String(left.at).localeCompare(String(right.at)));
  return output.map((event, index, records) => ({
    ...event,
    eventIndex: index + 1,
    eventCount: records.length,
    sequence: index + 1,
  }));
}

function lifecycleReplay({ runId, mainNodeId, workflowNodes, workerNodes, stageEvents, artifact }) {
  const executionStage = stageEvents.find((event) => event.stage === "execution");
  const anchor = executionStage?.at || safeTimestamp(artifact?.createdAt || artifact?.startedAt || artifact?.updatedAt) || new Date(0).toISOString();
  const output = [{
    id: publicId("event", `${runId}:root`),
    eventIndex: 0,
    eventCount: 0,
    sequence: 0,
    at: safeTimestamp(artifact?.createdAt || artifact?.startedAt) || anchor,
    kind: "agent",
    order: 0,
    chapter: "critical",
    stage: "critical",
    eventType: "RunOpened",
    nodeId: mainNodeId,
    status: "running",
    visibility: "visible",
    label: "Run · opened",
  }];
  const add = (node, kind, at, label, status = "queued") => {
    if (!node) return;
    output.push({
      id: publicId("event", `${runId}:${kind}:${node.id}`),
      eventIndex: 0,
      eventCount: 0,
      sequence: 0,
      at: safeTimestamp(at) || anchor,
      kind,
      order: kind === "workflow" ? 20 : 30,
      chapter: "execution",
      stage: "execution",
      eventType: kind === "workflow" ? "WorkflowOpened" : "AgentQueued",
      nodeId: node.id,
      status,
      visibility: "visible",
      label: `${node.label} · ${kind === "workflow" ? "opened" : "queued"}`,
    });
  };
  workflowNodes.forEach((node, index) => add(node, "workflow", anchor, node.label, node.status));
  workerNodes.forEach((node, index) => add(node, "agent", node.firstAt || anchor, node.label, node.status));
  return output;
}

function hostReplay(hostEvidence, runId, nodeByTaskId, mainNodeId) {
  const agentFamilies = new Set(["agent_subagent", "agent_teams_playbook", "durable_agent"]);
  const failureStates = new Set(["failed", "failure", "error", "denied", "blocked", "unsupported"]);
  const output = [];
  for (const [index, item] of hostEvidence.slice(0, LIVE_MAX_REPLAY).entries()) {
    const at = safeTimestamp(item?.occurredAt || item?.completedAt || item?.startedAt);
    if (!at) continue;
    const rawState = String(item?.resultStatus || item?.status || item?.state || "").toLowerCase();
    const isFailure = failureStates.has(rawState);
    const isAgent = agentFamilies.has(item?.family);
    const kind = isFailure
      ? "failure"
      : isAgent
        ? "agent"
        : ["invoked", "started", "running", "in_progress"].includes(rawState)
          ? "tool_start"
          : "tool_end";
    const taskId = exactTaskId(item?.taskPacketId) || exactTaskId(item?.bindingRef);
    const nodeId = taskId ? nodeByTaskId.get(taskId) || null : mainNodeId;
    const toolCallId = isAgent
      ? null
      : publicId("tool", `${taskId || runId}:${item?.eventId ?? item?.evidenceRef ?? index}`);
    const provider = safeText(item?.providerId || item?.hostSurface, isAgent ? "agent" : "tool", 96);
    output.push({
      id: publicId("event", `${runId}:host:${item?.eventId ?? item?.evidenceRef ?? index}`),
      eventIndex: 0,
      eventCount: 0,
      sequence: 0,
      at,
      kind,
      order: 40,
      chapter: "execution",
      stage: "execution",
      eventType: isFailure ? "HostFailure" : isAgent ? "AgentEvent" : kind === "tool_start" ? "ToolStarted" : "ToolFinished",
      nodeId,
      toolCallId,
      status: isFailure ? "failed" : normalizeStatus(item?.resultStatus || item?.state, kind === "tool_start" ? "active" : "completed"),
      label: `${provider} · ${kind.replaceAll("_", " ")}`,
    });
  }
  return output;
}

function mergeReplayEvents(stageEvents, hostEvents) {
  const merged = [...stageEvents, ...hostEvents]
    .sort((left, right) => String(left.at || "").localeCompare(String(right.at || "")) || (left.order ?? 50) - (right.order ?? 50) || left.kind.localeCompare(right.kind))
    .slice(0, LIVE_MAX_REPLAY);
  return merged.map((event, index) => ({
    ...event,
    eventIndex: index + 1,
    eventCount: merged.length,
    sequence: index + 1,
  }));
}

function aggregateNodeStatus(nodes) {
  const statuses = nodes.map((node) => node.status);
  if (statuses.includes("active")) return "active";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("pending")) return "pending";
  if (statuses.length && statuses.every((status) => status === "completed")) return "completed";
  return "in_doubt";
}

export function serializeLiveCompactProjection(value) {
  return `${JSON.stringify(value)}\n`;
}

function liveProjectionBytes(value) {
  return Buffer.byteLength(serializeLiveCompactProjection(value), "utf8");
}

function fitLiveProjectionToBudget(value, maxBytes) {
  let projection = JSON.parse(JSON.stringify(value));
  const originalBytes = liveProjectionBytes(projection);
  let omitted = { toolCalls: 0, evidence: 0, prompts: 0, provenance: 0, contextTransfers: 0, nodes: 0, replay: 0 };
  projection.truncated = {
    applied: originalBytes > maxBytes,
    originalBytes,
    finalBytes: originalBytes,
    omitted,
  };
  const size = () => liveProjectionBytes(projection);
  const exactOmitted = (visibleCounts) => ({
    toolCalls: Math.max(0, projection.counts.toolCalls - visibleCounts.toolCalls),
    evidence: Math.max(0, projection.counts.evidence - visibleCounts.evidence),
    prompts: Math.max(0, projection.counts.prompts - visibleCounts.prompts),
    provenance: Math.max(0, projection.counts.provenance - visibleCounts.provenance),
    contextTransfers: Math.max(0, projection.counts.contextTransfers - visibleCounts.contextTransfers),
    nodes: Math.max(0, projection.counts.nodes - visibleCounts.nodes),
    replay: Math.max(0, projection.counts.events - visibleCounts.events),
  });
  const settleFinalBytes = () => {
    let previous = -1;
    for (let index = 0; index < 8; index += 1) {
      const next = liveProjectionBytes(projection);
      projection.truncated.finalBytes = next;
      if (next === previous) break;
      previous = next;
    }
  };
  const removeNodeReferences = (nodeId) => {
    projection.edges = projection.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
    for (const key of ["evidence", "prompts", "toolCalls", "provenance"]) {
      projection[key] = projection[key].filter((item) => item.nodeId !== nodeId);
    }
    projection.replay = projection.replay.filter((event) => event.nodeId !== nodeId);
  };
  const lowPriorityNodeIds = () => {
    const ranks = projection.nodes.map((node, index) => {
      if (node.isMain === true) return { index, rank: Number.POSITIVE_INFINITY };
      if (node.kind === "workflow") return { index, rank: 4 };
      if (node.status === "pending") return { index, rank: 0 };
      if (["completed", "in_doubt", "cancelled", "archived"].includes(node.status)) return { index, rank: 1 };
      if (node.status === "active") return { index, rank: 3 };
      return { index, rank: 2 };
    }).filter((item) => Number.isFinite(item.rank));
    ranks.sort((left, right) => left.rank - right.rank || right.index - left.index);
    return ranks.map(({ index }) => projection.nodes[index]?.id).filter(Boolean);
  };
  // Compaction runs on the synchronous governed-run commit path. Trim whole
  // optional classes before structural nodes so work stays bounded by a small
  // number of serializations instead of one full stringify per removed item.
  const coarseTrimmers = [
    () => {
      projection.toolCalls = [];
      for (const node of projection.nodes) {
        node.toolCalls = [];
        node.toolCount = 0;
        node.latestTool = null;
      }
    },
    () => {
      projection.evidence = [];
      for (const node of projection.nodes) {
        node.workerExecutionEvidence = [];
        node.terminalEvidence = [];
      }
    },
    () => {
      projection.prompts = [];
      for (const node of projection.nodes) node.promptEras = [];
    },
    () => {
      projection.provenance = [];
      for (const node of projection.nodes) node.provenance = [];
    },
    () => { projection.contextTransfers = []; },
  ];
  for (const trim of coarseTrimmers) {
    if (size() <= maxBytes) break;
    trim();
  }
  if (size() > maxBytes) {
    const removableIds = lowPriorityNodeIds();
    while (size() > maxBytes && removableIds.length) {
      const removeCount = Math.max(1, Math.ceil(removableIds.length / 2));
      const selected = new Set(removableIds.splice(0, removeCount));
      projection.nodes = projection.nodes.filter((node) => !selected.has(node.id));
      for (const nodeId of selected) removeNodeReferences(nodeId);
    }
  }
  if (size() > maxBytes) projection.replay = [];
  projection.replay = projection.replay.map((event, index, events) => ({
    ...event,
    eventIndex: index + 1,
    eventCount: events.length,
    sequence: index + 1,
  }));
  projection.eventIndex = projection.replay.length;
  projection.eventCount = projection.replay.length;
  projection.session.nodeCount = projection.nodes.length;
  projection.session.eventCount = projection.replay.length;
  projection.visibleCounts = {
    nodes: projection.nodes.length,
    edges: projection.edges.length,
    evidence: projection.evidence.length,
    events: projection.replay.length,
    toolCalls: projection.toolCalls.length,
    prompts: projection.prompts.length,
    provenance: projection.provenance.length,
    contextTransfers: projection.contextTransfers.length,
  };
  omitted = exactOmitted(projection.visibleCounts);
  projection.truncated.omitted = omitted;
  projection.truncated.applied = Object.values(omitted).some((count) => count > 0);
  settleFinalBytes();
  if (projection.truncated.finalBytes > maxBytes) {
    const main = projection.nodes.find((node) => node.isMain === true);
    projection = {
      schemaVersion: projection.schemaVersion,
      run: projection.run,
      session: { ...projection.session, nodeCount: main ? 1 : 0, eventCount: 0 },
      nodes: main ? [{
        id: main.id,
        kind: main.kind,
        isMain: true,
        label: main.label,
        status: main.status,
        ownerAgent: main.ownerAgent,
      }] : [],
      edges: [],
      evidence: [],
      replay: [],
      prompts: [],
      toolCalls: [],
      provenance: [],
      repository: projection.repository,
      workspace: projection.workspace,
      contextTransfers: [],
      eventIndex: 0,
      eventCount: 0,
      counts: projection.counts,
      visibleCounts: { nodes: main ? 1 : 0, edges: 0, evidence: 0, events: 0, toolCalls: 0, prompts: 0, provenance: 0, contextTransfers: 0 },
      truncated: {
        applied: true,
        originalBytes,
        finalBytes: 0,
        omitted: {},
      },
    };
    projection.truncated.omitted = exactOmitted(projection.visibleCounts);
    settleFinalBytes();
  }
  return projection;
}

export function buildLiveCompactProjection(artifact, { maxBytes = LIVE_MAX_COMPACT_BYTES } = {}) {
  const rawRunId = artifact?.runId || artifact?.run?.runId;
  const runId = normalizeLiveRunId(rawRunId) || (
    typeof rawRunId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(rawRunId)
      ? rawRunId
      : null
  );
  if (!runId) throw new Error("Live projection requires a valid governed runId.");
  const packets = boundedArray(artifact?.workerTaskPackets, LIVE_MAX_NODES - 2);
  const runTask = readableRunTask(artifact);
  const runTitle = readableRunTitle(artifact, runTask);
  const results = liveWorkerResultMap(artifact, runId);
  const hostEvidence = trustedHostEvidence(artifact, runId);
  const nodeByTaskId = new Map();
  const workerNodes = packets.map((packet, index) => {
    const taskId = taskIdFrom(packet) || `${runId}:worker:${index + 1}`;
    const result = results.get(taskId) || null;
    const taskEvidence = safeExecutionEvidence(result, taskId);
    let status = normalizeStatus(
      firstString(result, ["status", "resultStatus"]) || firstString(packet, ["status"]),
      "pending",
    );
    if (status === "completed" && !taskEvidence.some((item) => item.status === "completed")) {
      status = "in_doubt";
    }
    const nodeId = publicId("agent", taskId);
    nodeByTaskId.set(taskId, nodeId);
    const telemetry = safeTelemetry(hostEvidence, taskId);
    const toolCalls = safeToolCalls(hostEvidence, taskId);
    const loadout = plannedLoadout(packet);
    const startedAt = safeTimestamp(result?.startedAt || packet?.startedAt || packet?.createdAt);
    const completedAt = safeTimestamp(result?.completedAt || result?.updatedAt);
    const startMs = startedAt ? Date.parse(startedAt) : NaN;
    const endMs = completedAt ? Date.parse(completedAt) : NaN;
    const role = firstString(packet, ["roleDisplayName", "businessRoleId", "ownerAgent", "owner"]);
    const scope = readableWorkerScope(packet);
    return {
      id: nodeId,
      kind: "agent",
      isMain: false,
      label: scope || safeText(role, `worker ${index + 1}`, 80),
      task: scope || `${safeText(role, `worker ${index + 1}`, 80)} worker lane`,
      roleDisplayName: safeText(role, "worker", 80),
      roleInstanceId: safeText(firstString(packet, ["roleInstanceId"]), null, 120),
      stage: normalizeStage(firstString(packet, ["stage", "currentStage", "stageKey"])) === "in_doubt"
        ? "execution"
        : normalizeStage(firstString(packet, ["stage", "currentStage", "stageKey"])),
      parentId: null,
      status,
      ownerAgent: safeText(firstString(packet, ["ownerAgent", "owner", "agent"]), "unavailable", 96),
      runtime: telemetry.runtime.value || "unavailable",
      runtimeObservation: telemetry.runtime,
      model: telemetry.model.value || "unavailable",
      modelObservation: telemetry.model,
      tokens: telemetry.tokens,
      inputTokens: telemetry.tokens.input.value,
      outputTokens: telemetry.tokens.output.value,
      totalTokens: telemetry.tokens.total.value,
      timing: {
        startedAt,
        completedAt,
        durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null,
      },
      firstAt: startedAt,
      lastAt: completedAt,
      durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null,
      summary: status === "pending"
        ? `${safeText(role, "worker", 80)} lane · awaiting real host execution evidence`
        : "Worker state projected from governed evidence",
      terminalEvidence: taskEvidence.filter((item) => ["completed", "failed", "blocked"].includes(item.status)),
      workerExecutionEvidence: taskEvidence,
      toolCalls,
      toolCount: toolCalls.length,
      latestTool: toolCalls.at(-1)?.name || null,
      loadout,
      promptEras: [
        { era: "assignment", label: "Task assigned", summary: "Governed worker scope selected" },
        {
          era: "execution",
          label: status === "pending" ? "Execution pending" : "Execution evidence",
          summary: status === "pending" ? "No accepted host execution evidence" : "Accepted execution evidence recorded",
        },
      ],
      provenance: [
        {
          kind: "owner_binding",
          ownerBindingMode: safeText(packet?.ownerBindingMode, "run_scoped_owner_contract", 64),
          state: evidenceForTask(hostEvidence, taskId).length ? "observed" : "declared",
        },
      ],
      evidenceCount: taskEvidence.length + toolCalls.length,
    };
  });

  const groupRecords = new Map();
  for (const [index, packet] of packets.entries()) {
    const taskId = taskIdFrom(packet) || `${runId}:worker:${index + 1}`;
    const groupKey = exactTaskId(packet?.parallelGroup) || "execution";
    if (!groupRecords.has(groupKey)) groupRecords.set(groupKey, []);
    groupRecords.get(groupKey).push(nodeByTaskId.get(taskId));
  }
  const workflowNodes = [...groupRecords.entries()].map(([groupKey, childIds], index) => ({
    id: publicId("workflow", `${runId}:${groupKey}`),
    kind: "workflow",
    label: groupKey === "execution" ? "Execution lanes" : safeText(groupKey, `Workflow ${index + 1}`, 80),
    stage: "execution",
    status: aggregateNodeStatus(workerNodes.filter((node) => childIds.includes(node.id))),
    parentId: null,
    ownerAgent: safeText(artifact?.dispatchEnvelopePacket?.ownerAgent, "meta-conductor", 96),
    runtime: "unavailable",
    runtimeObservation: { state: "unavailable", value: null },
    model: "unavailable",
    modelObservation: { state: "unavailable", value: null },
    summary: `${childIds.length} worker task${childIds.length === 1 ? "" : "s"} · declared route`,
    childCount: childIds.length,
    evidenceCount: 0,
  }));
  const rootOwner = firstString(artifact?.dispatchEnvelopePacket, ["ownerAgent", "owner"]) || "meta-conductor";
  const mainNode = {
    id: publicId("agent", `${runId}:main:${rootOwner}`),
    kind: "agent",
    isMain: true,
    label: safeText(rootOwner, "main agent", 96),
    task: runTask,
    stage: normalizeStage(artifact?.currentStage || artifact?.currentStageKey),
    status: normalizeStatus(artifact?.status, workerNodes.length ? aggregateNodeStatus(workerNodes) : "in_doubt"),
    ownerAgent: safeText(rootOwner, "meta-conductor", 96),
    runtime: "unavailable",
    runtimeObservation: { state: "unavailable", value: null },
    model: "unavailable",
    modelObservation: { state: "unavailable", value: null },
    tokens: {
      input: { state: "unavailable", value: null },
      output: { state: "unavailable", value: null },
      total: { state: "unavailable", value: null },
    },
    timing: {
      startedAt: safeTimestamp(artifact?.startedAt || artifact?.createdAt),
      completedAt: safeTimestamp(artifact?.completedAt),
      durationMs: null,
    },
    firstAt: safeTimestamp(artifact?.startedAt || artifact?.createdAt),
    lastAt: safeTimestamp(artifact?.completedAt),
    durationMs: null,
    summary: "Main governed run owner · " + runTitle,
    terminalEvidence: [],
    workerExecutionEvidence: [],
    toolCalls: [],
    toolCount: 0,
    latestTool: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    promptEras: [{ era: "run", label: "Run intent", summary: "Governed task accepted" }],
    provenance: [{ kind: "dispatch_owner", state: "declared" }],
    evidenceCount: 0,
  };
  for (const workflow of workflowNodes) workflow.parentId = mainNode.id;
  for (const packet of packets) {
    const taskId = taskIdFrom(packet);
    const node = workerNodes.find((candidate) => candidate.id === nodeByTaskId.get(taskId));
    const groupKey = exactTaskId(packet?.parallelGroup) || "execution";
    const workflow = workflowNodes.find((candidate) => candidate.id === publicId("workflow", `${runId}:${groupKey}`));
    if (node) node.parentId = workflow?.id || mainNode.id;
  }
  const nodes = [mainNode, ...workflowNodes, ...workerNodes].slice(0, LIVE_MAX_NODES);
  const edges = [];
  for (const workflow of workflowNodes) edges.push({ from: mainNode.id, to: workflow.id, kind: "contains" });
  for (const [groupKey, childIds] of groupRecords.entries()) {
    const workflowId = publicId("workflow", `${runId}:${groupKey}`);
    for (const childId of childIds) edges.push({ from: workflowId, to: childId, kind: "contains" });
  }
  for (const packet of packets) {
    const target = nodeByTaskId.get(taskIdFrom(packet));
    for (const dependency of boundedArray(packet?.dependsOn, 32)) {
      const from = nodeByTaskId.get(exactTaskId(dependency));
      if (from && target) edges.push({ from, to: target, kind: "depends_on" });
    }
  }
  const contextTransfers = contextTransferProjection(
    artifact,
    runId,
    packets,
    nodeByTaskId,
    new Set(nodes.map((node) => node.id)),
  );
  const richStageTrace = Array.isArray(artifact?.agUiStageEvents?.events) && artifact.agUiStageEvents.events.length > 1;
  const stageEvents = stageReplay(artifact, runId, richStageTrace ? mainNode.id : null);
  const lifecycleEvents = richStageTrace
    ? lifecycleReplay({ runId, mainNodeId: mainNode.id, workflowNodes, workerNodes, stageEvents, artifact })
    : [];
  const replay = mergeReplayEvents(
    [...stageEvents, ...lifecycleEvents],
    hostReplay(hostEvidence, runId, nodeByTaskId, mainNode.id),
  );
  const updatedAt = updatedAtFor(artifact) || replay.at(-1)?.at || null;
  const startedAt = safeTimestamp(artifact?.startedAt || artifact?.createdAt) || replay[0]?.at || firstArtifactTimestamp(artifact);
  const currentStage = normalizeStage(artifact?.currentStage || artifact?.currentStageKey || replay.at(-1)?.stage || "execution");
  mainNode.stage = currentStage;
  mainNode.firstAt = mainNode.firstAt || startedAt;
  mainNode.timing.startedAt = mainNode.timing.startedAt || startedAt;
  let runStatus = normalizeStatus(artifact?.status, aggregateNodeStatus(workerNodes));
  if (runStatus === "completed" && !completionIsProven(artifact)) runStatus = "in_doubt";
  const projection = {
    schemaVersion: LIVE_COMPACT_PROJECTION_SCHEMA_VERSION,
    run: {
      runId,
      title: runTitle,
      task: runTask,
      status: runStatus,
      currentStage,
      startedAt,
      updatedAt,
      completedAt: safeTimestamp(artifact?.completedAt),
    },
    session: {
      sessionId: publicId("session", runId),
      title: runTitle,
      status: runStatus,
      nodeCount: nodes.length,
      eventCount: replay.length,
      activity: runTask,
      runtime: hostEvidence[0]?.runtime || hostEvidence[0]?.hostSurface || "unavailable",
      mode: hostEvidence.length ? "observed" : "planned snapshot",
      lastPromptSummary: "Prompt summary withheld",
      fileChangeCount: boundedArray(artifact?.executionResult?.fileCompletionList, 128).length,
      artifactCount: boundedArray(artifact?.sourceArtifacts, 128).length,
      plannedCount: workerNodes.filter((node) => node.status === "pending").length,
      completedCount: workerNodes.filter((node) => node.status === "completed").length,
      failedCount: workerNodes.filter((node) => ["failed", "blocked"].includes(node.status)).length,
      blockedCount: workerNodes.filter((node) => node.status === "blocked").length,
      proofState: hostEvidence.length ? "host evidence observed" : "structural evidence only",
    },
    nodes,
    edges: uniqueEdges(edges, nodes).map((edge) => ({ ...edge, kind: edges.find((item) => item.from === edge.from && item.to === edge.to)?.kind || "related" })),
    evidence: workerNodes.flatMap((node) => node.workerExecutionEvidence.map((item) => ({
      ...item,
      nodeId: node.id,
      type: "verification",
    }))).slice(0, LIVE_MAX_EVIDENCE),
    replay,
    prompts: nodes.flatMap((node) => boundedArray(node.promptEras, 8).map((prompt) => ({
      nodeId: node.id,
      era: prompt.era,
      label: prompt.label,
      summary: prompt.summary,
    }))).slice(0, LIVE_MAX_EVIDENCE),
    toolCalls: nodes.flatMap((node) => boundedArray(node.toolCalls, 24).map((toolCall) => ({
      ...toolCall,
      nodeId: node.id,
    }))).slice(0, LIVE_MAX_EVIDENCE),
    provenance: nodes.flatMap((node) => boundedArray(node.provenance, 8).map((item) => ({
      ...item,
      nodeId: node.id,
    }))).slice(0, LIVE_MAX_EVIDENCE),
    repository: repositoryProjection(artifact),
    workspace: workspaceProjection(artifact),
    contextTransfers,
    eventIndex: replay.length,
    eventCount: replay.length,
    counts: null,
  };
  projection.counts = {
    nodes: projection.nodes.length,
    edges: projection.edges.length,
    evidence: projection.evidence.length,
    events: projection.replay.length,
    toolCalls: projection.toolCalls.length,
    prompts: projection.prompts.length,
    provenance: projection.provenance.length,
    contextTransfers: projection.contextTransfers.length,
  };
  return fitLiveProjectionToBudget(projection, maxBytes);
}

function normalizeRun(durable, artifact, stale) {
  const source = durable || artifact;
  const runId = normalizeLiveRunId(source?.runId || source?.run?.runId);
  if (!runId) return null;

  const lifecycle = firstString(source, ["lifecycleStatus", "status"]);
  const artifactEvents = rawReplayEvents(artifact, null);
  const latestArtifactStage = [...artifactEvents]
    .reverse()
    .map((event) => firstString(event, ["stage", "stageKey", "currentStage"]))
    .find(Boolean);
  const currentStage = normalizeStage(
    firstString(source, ["currentStageKey", "currentStage", "stage"]) ||
      firstString(artifact, ["currentStageKey", "currentStage", "stage"]) ||
      latestArtifactStage,
  );
  let status = stale
    ? "in_doubt"
    : normalizeStatus(lifecycle || (source?.active === true ? "active" : source?.active === false ? "session_stopped" : null));
  if (status === "completed" && !completionIsProven(artifact)) status = "in_doubt";

  return {
    runId,
    status,
    currentStage: stale ? "in_doubt" : currentStage,
    updatedAt: updatedAtFor(source),
  };
}

function stageStatus(record, stage, stale) {
  const stageRecord = objectValue(record?.stages, stage);
  const value = firstString(stageRecord, ["status", "state"]);
  return stale ? "in_doubt" : normalizeStatus(value, value ? "in_doubt" : "pending");
}

function stageEvidenceCount(artifact, stage) {
  let count = 0;
  const packets = Array.isArray(artifact?.workerTaskPackets) ? artifact.workerTaskPackets : [];
  const results = workerResultMap(artifact);
  for (const packet of packets) {
    if (normalizeStage(firstString(packet, ["stage", "currentStage", "stageKey"])) === stage) {
      const taskId = safeId(firstString(packet, ["taskPacketId", "taskId", "roleInstanceId", "businessRoleId"]), null);
      if (taskId) count += passingWorkerEvidence(results.get(taskId)).length;
    }
  }
  if (stage === "verification") count += passingVerificationEvidence(artifact).length;
  return Math.min(count, Number.MAX_SAFE_INTEGER);
}

function nodeFromStage(stage, durable, artifact, stale) {
  const evidenceCount = stageEvidenceCount(artifact, stage);
  let status = stageStatus(durable, stage, stale);
  if (status === "completed" && evidenceCount === 0) status = "in_doubt";
  return {
    id: `stage:${stage}`,
    label: STAGE_LABELS[stage],
    stage,
    status,
    ownerAgent: "in_doubt",
    runtime: safeId(firstString(durable, ["runtime", "runtimeFamily"]), "in_doubt"),
    summary: "Stage state projected from durable run",
    evidenceCount,
  };
}

function workerResultMap(artifact) {
  const map = new Map();
  const results = Array.isArray(artifact?.workerResultPackets) ? artifact.workerResultPackets : [];
  for (const result of results) {
    const taskId = safeId(firstString(result, ["taskPacketId", "taskId", "roleInstanceId"]), null);
    if (taskId) map.set(taskId, result);
  }
  return map;
}

function workerNodes(artifact, stale) {
  const packets = Array.isArray(artifact?.workerTaskPackets) ? artifact.workerTaskPackets : [];
  const results = workerResultMap(artifact);
  return packets.slice(0, LIVE_MAX_NODES).map((packet, index) => {
    const rawTaskId = firstString(packet, ["taskPacketId", "taskId", "roleInstanceId", "businessRoleId"]);
    const taskId = safeId(rawTaskId, `worker-${index + 1}`);
    const result = results.get(taskId);
    const stage = normalizeStage(firstString(packet, ["stage", "currentStage", "stageKey"]));
    const role = firstString(packet, ["roleDisplayName", "businessRoleId", "ownerAgent"]);
    const evidenceCount = passingWorkerEvidence(result).length;
    let status = stale ? "in_doubt" : normalizeStatus(firstString(result, ["status", "resultStatus"]) || firstString(packet, ["status"]));
    if (status === "completed" && evidenceCount === 0) status = "in_doubt";
    return {
      id: `worker:${taskId}`,
      label: safeId(role, "worker"),
      stage,
      status,
      ownerAgent: safeId(firstString(packet, ["ownerAgent", "owner", "agent"]), "in_doubt"),
      runtime: safeId(firstString(packet, ["runtime", "runtimeFamily"]), "in_doubt"),
      summary: "Worker state projected from governed artifact",
      evidenceCount: Math.min(evidenceCount, 9999),
    };
  });
}

function artifactStageNodes(artifact, stale) {
  const events = rawReplayEvents(artifact, null);
  return STAGES.map((stage) => {
    const event = [...events].reverse().find((item) => normalizeStage(firstString(item, ["stage", "stageKey"])) === stage);
    const evidenceCount = stageEvidenceCount(artifact, stage);
    let status = stale ? "in_doubt" : normalizeStatus(event?.status || event?.state, event ? "in_doubt" : "pending");
    if (status === "completed" && evidenceCount === 0) status = "in_doubt";
    return {
      id: `stage:${stage}`,
      label: STAGE_LABELS[stage],
      stage,
      status,
      ownerAgent: safeId(firstString(event, ["owner", "ownerAgent"]), "in_doubt"),
      runtime: "in_doubt",
      summary: "Stage state projected from governed artifact",
      evidenceCount,
    };
  });
}

function uniqueEdges(edges, nodes) {
  const known = new Set(nodes.map((node) => node.id));
  const seen = new Set();
  const output = [];
  for (const edge of edges) {
    const from = typeof edge?.from === "string" ? edge.from : null;
    const to = typeof edge?.to === "string" ? edge.to : null;
    if (!from || !to || !known.has(from) || !known.has(to) || from === to) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ from, to });
    if (output.length >= LIVE_MAX_EDGES) break;
  }
  return output;
}

function buildEdges(artifact, nodes) {
  const edges = [];
  for (let index = 1; index < STAGES.length; index += 1) {
    edges.push({ from: `stage:${STAGES[index - 1]}`, to: `stage:${STAGES[index]}` });
  }

  const packets = Array.isArray(artifact?.workerTaskPackets) ? artifact.workerTaskPackets : [];
  for (const packet of packets) {
    const taskId = safeId(firstString(packet, ["taskPacketId", "taskId", "roleInstanceId", "businessRoleId"]), null);
    if (!taskId) continue;
    const target = `worker:${taskId}`;
    const stage = normalizeStage(firstString(packet, ["stage", "currentStage", "stageKey"]));
    if (stage !== "in_doubt") edges.push({ from: `stage:${stage}`, to: target });
    const dependencies = Array.isArray(packet?.dependsOn) ? packet.dependsOn : [];
    for (const dependency of dependencies) {
      const dependencyId = safeId(dependency, null);
      if (dependencyId) edges.push({ from: `worker:${dependencyId}`, to: target });
    }
  }

  if (Array.isArray(artifact?.edges)) edges.push(...artifact.edges);
  if (Array.isArray(artifact?.graph?.edges)) edges.push(...artifact.graph.edges);
  return uniqueEdges(edges, nodes);
}

function evidenceNodeId(item, fallbackNodeId, knownNodeIds) {
  const known = knownNodeIds instanceof Set ? knownNodeIds : new Set();
  const explicit = [
    firstString(item, ["nodeId", "targetNodeId", "workerNodeId", "stageNodeId"]),
  ];
  for (const value of explicit) {
    const candidate = safeId(value, null);
    if (candidate && known.has(candidate)) return candidate;
  }

  const taskId = safeId(firstString(item, ["taskPacketId", "taskId", "roleInstanceId", "businessRoleId"]), null);
  const workerNodeId = taskId ? `worker:${taskId}` : null;
  if (workerNodeId && known.has(workerNodeId)) return workerNodeId;

  const stage = normalizeStage(firstString(item, ["stage", "currentStage", "stageKey"]));
  const stageNodeId = stage !== "in_doubt" ? `stage:${stage}` : null;
  if (stageNodeId && known.has(stageNodeId)) return stageNodeId;

  const fallback = safeId(fallbackNodeId, null);
  return fallback && known.has(fallback) ? fallback : "";
}

function evidenceRecord(id, type, label, status, nodeId = "") {
  return {
    id,
    type: normalizeKind(type),
    label: safeText(label, "in_doubt"),
    status: normalizeStatus(status),
    nodeId: typeof nodeId === "string" ? nodeId : "",
  };
}

function buildEvidence(durable, artifact, stale, nodes = []) {
  const output = [];
  const knownNodeIds = new Set(nodes.map((node) => node?.id).filter((id) => typeof id === "string"));
  const append = (type, label, status, item, fallbackNodeId = "") => {
    if (output.length >= LIVE_MAX_EVIDENCE) return;
    const safeLabel = safeText(label, "in_doubt");
    if (safeLabel === "in_doubt") return;
    output.push(evidenceRecord(
      `evidence:${output.length + 1}`,
      type,
      safeLabel,
      stale ? "in_doubt" : status,
      evidenceNodeId(item, fallbackNodeId, knownNodeIds),
    ));
  };

  const verification = artifact?.verificationPacket;
  if (verification && typeof verification === "object") {
    for (const item of Array.isArray(verification.evidence) ? verification.evidence : []) {
      append("verification", "Verification evidence", "in_doubt", item, "stage:verification");
    }
    for (const item of Array.isArray(verification.verificationResults) ? verification.verificationResults : []) {
      append("verification", "Verification result", structuredEvidencePassed(item) ? "completed" : "in_doubt", item, "stage:verification");
    }
    for (const item of Array.isArray(verification.fixEvidence) ? verification.fixEvidence : []) {
      append("verification", "Fix verification", structuredEvidencePassed(item) ? "completed" : "in_doubt", item, "stage:verification");
    }
  }

  const review = artifact?.reviewPacket;
  for (const finding of Array.isArray(review?.findings) ? review.findings : []) {
    append("review", "Review finding", firstString(finding, ["closeState", "status"]), finding, "stage:review");
  }
  for (const item of Array.isArray(durable?.evidence) ? durable.evidence : []) {
    append("status", "Run status evidence", "in_doubt", item);
  }
  return output;
}

function rawReplayEvents(artifact, durable) {
  const candidates = [
    artifact?.replay,
    artifact?.timeline,
    artifact?.events,
    artifact?.stageEvents,
    artifact?.agUiStageEvents?.events,
    artifact?.coreLoop?.stageHistory,
    durable?.replay,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }
  return [];
}

function safeCompactObservation(value, { count = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.state !== "observed") {
    return unavailableObservation();
  }
  return count ? observedCount(value.value, true) : observedValue(value.value, true);
}

function sanitizeCompactEvidenceItem(item, knownNodeIds) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const nodeId = safeId(item.nodeId, "");
  return {
    id: safeId(item.id, publicId("proof", JSON.stringify(item))),
    type: normalizeKind(item.type || item.kind || "evidence"),
    label: safeText(item.label, "Evidence", 160),
    detail: safeNullableText(item.detail, 180),
    sourceRef: safeNullableText(item.sourceRef, 120),
    status: normalizeStatus(item.status, "in_doubt"),
    observedAt: safeTimestamp(item.observedAt || item.occurredAt),
    nodeId: nodeId && knownNodeIds.has(nodeId) ? nodeId : "",
  };
}

function sanitizeCompactToolCall(item, knownNodeIds) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const nodeId = safeId(item.nodeId, "");
  return {
    id: safeId(item.id, publicId("tool", JSON.stringify(item))),
    kind: normalizeKind(item.kind || "tool"),
    name: safeText(item.name, "tool", 96),
    status: normalizeStatus(item.status, "in_doubt"),
    occurredAt: safeTimestamp(item.occurredAt),
    nodeId: nodeId && knownNodeIds.has(nodeId) ? nodeId : "",
  };
}

function sanitizeCompactProjection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const runId = normalizeLiveRunId(value?.run?.runId || value.runId);
  if (!runId) return null;
  const rawNodes = boundedArray(value.nodes, LIVE_MAX_NODES);
  const nodes = [];
  const knownNodeIds = new Set();
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const id = safeId(raw.id, null);
    if (!id || knownNodeIds.has(id) || !["agent", "workflow"].includes(raw.kind)) continue;
    knownNodeIds.add(id);
    nodes.push({ raw, id });
  }
  const sanitizedNodes = nodes.map(({ raw, id }) => {
    const runtimeObservation = safeCompactObservation(raw.runtimeObservation);
    const modelObservation = safeCompactObservation(raw.modelObservation);
    const inputTokens = safeCompactObservation(raw.tokens?.input, { count: true });
    const outputTokens = safeCompactObservation(raw.tokens?.output, { count: true });
    const totalTokens = safeCompactObservation(raw.tokens?.total, { count: true });
    const evidence = boundedArray(raw.workerExecutionEvidence, 24)
      .map((item) => sanitizeCompactEvidenceItem({ ...item, nodeId: id }, knownNodeIds))
      .filter(Boolean);
    const terminalEvidence = boundedArray(raw.terminalEvidence, 24)
      .map((item) => sanitizeCompactEvidenceItem({ ...item, nodeId: id }, knownNodeIds))
      .filter(Boolean);
    const toolCalls = boundedArray(raw.toolCalls, 24)
      .map((item) => sanitizeCompactToolCall({ ...item, nodeId: id }, knownNodeIds))
      .filter(Boolean);
    const parentId = safeId(raw.parentId, null);
    const startedAt = safeTimestamp(raw.timing?.startedAt || raw.firstAt);
    const completedAt = safeTimestamp(raw.timing?.completedAt || raw.lastAt);
    const durationMs = Number.isSafeInteger(raw.timing?.durationMs ?? raw.durationMs)
      && (raw.timing?.durationMs ?? raw.durationMs) >= 0
      ? raw.timing?.durationMs ?? raw.durationMs
      : null;
    return {
      id,
      kind: raw.kind,
      isMain: raw.isMain === true,
      label: safeText(raw.label, raw.kind === "workflow" ? "Workflow" : "Agent", 120),
      task: safeNullableText(raw.task, 240),
      roleDisplayName: safeNullableText(raw.roleDisplayName, 80),
      roleInstanceId: safeNullableText(raw.roleInstanceId, 120),
      stage: normalizeStage(raw.stage),
      parentId: parentId && knownNodeIds.has(parentId) && parentId !== id ? parentId : null,
      status: normalizeStatus(raw.status, "in_doubt"),
      ownerAgent: safeText(raw.ownerAgent, "unavailable", 96),
      runtime: runtimeObservation.value || "unavailable",
      runtimeObservation,
      model: modelObservation.value || "unavailable",
      modelObservation,
      tokens: { input: inputTokens, output: outputTokens, total: totalTokens },
      inputTokens: inputTokens.value,
      outputTokens: outputTokens.value,
      totalTokens: totalTokens.value,
      timing: { startedAt, completedAt, durationMs },
      firstAt: startedAt,
      lastAt: completedAt,
      durationMs,
      summary: safeText(raw.summary, "No safe execution summary is available", 180),
      terminalEvidence,
      workerExecutionEvidence: evidence,
      toolCalls,
      toolCount: toolCalls.length,
      latestTool: toolCalls.at(-1)?.name || null,
      loadout: {
        skills: safeTransferCount(raw.loadout?.skills) ?? 0,
        mcp: safeTransferCount(raw.loadout?.mcp) ?? 0,
        tools: safeTransferCount(raw.loadout?.tools) ?? 0,
        commands: safeTransferCount(raw.loadout?.commands) ?? 0,
        skillNames: safeStringList(raw.loadout?.skillNames, 24),
        mcpNames: safeStringList(raw.loadout?.mcpNames, 24),
        toolNames: safeStringList(raw.loadout?.toolNames, 24),
        commandNames: safeStringList(raw.loadout?.commandNames, 24),
      },
      promptEras: boundedArray(raw.promptEras, 8).map((item) => ({
        era: safeText(item?.era, "prompt", 64),
        label: safeText(item?.label, "Prompt phase", 120),
        summary: safeText(item?.summary, "Prompt summary withheld", 180),
      })),
      provenance: boundedArray(raw.provenance, 8).map((item) => ({
        kind: safeText(item?.kind, "provenance", 64),
        ownerBindingMode: safeNullableText(item?.ownerBindingMode, 64),
        state: safeText(item?.state, "unavailable", 64),
      })),
      evidenceCount: evidence.length + toolCalls.length,
      childCount: safeTransferCount(raw.childCount),
    };
  });
  const sanitizedEdges = boundedArray(value.edges, LIVE_MAX_EDGES).flatMap((edge) => {
    const from = safeId(edge?.from, null);
    const to = safeId(edge?.to, null);
    if (!from || !to || from === to || !knownNodeIds.has(from) || !knownNodeIds.has(to)) return [];
    return [{
      from,
      to,
      kind: ["contains", "depends_on", "related"].includes(edge.kind) ? edge.kind : "related",
    }];
  });
  const evidence = boundedArray(value.evidence, LIVE_MAX_EVIDENCE)
    .map((item) => sanitizeCompactEvidenceItem(item, knownNodeIds))
    .filter(Boolean);
  const replay = boundedArray(value.replay, LIVE_MAX_REPLAY).flatMap((event, index) => {
    const at = safeTimestamp(event?.at || event?.timestamp || event?.occurredAt);
    if (!at) return [];
    const nodeId = safeId(event?.nodeId, "");
    const toolCallId = safeId(event?.toolCallId, null);
    return [{
      id: safeId(event?.id, publicId("event", `${runId}:${index}`)),
      eventIndex: index + 1,
      eventCount: 0,
      sequence: index + 1,
      at,
      kind: normalizeKind(event?.kind || event?.eventType),
      chapter: normalizeStage(event?.chapter),
      stage: normalizeStage(event?.stage),
      eventType: safeText(event?.eventType, "Event", 64),
      nodeId: nodeId && knownNodeIds.has(nodeId) ? nodeId : null,
      toolCallId,
      status: normalizeStatus(event?.status, "in_doubt"),
      visibility: event?.visibility === "visible" ? "visible" : "unavailable",
      label: safeText(event?.label, "Observed event", 160),
    }];
  }).map((event, index, events) => ({ ...event, eventIndex: index + 1, eventCount: events.length, sequence: index + 1 }));
  const sanitizeNodeRecords = (records, max, mapper) => boundedArray(records, max).flatMap((item) => {
    const nodeId = safeId(item?.nodeId, null);
    if (!nodeId || !knownNodeIds.has(nodeId)) return [];
    return [{ nodeId, ...mapper(item) }];
  });
  const prompts = sanitizeNodeRecords(value.prompts, LIVE_MAX_EVIDENCE, (item) => ({
    era: safeText(item?.era, "prompt", 64),
    label: safeText(item?.label, "Prompt phase", 120),
    summary: safeText(item?.summary, "Prompt summary withheld", 180),
  }));
  const toolCalls = boundedArray(value.toolCalls, LIVE_MAX_EVIDENCE)
    .map((item) => sanitizeCompactToolCall(item, knownNodeIds))
    .filter(Boolean);
  const provenance = sanitizeNodeRecords(value.provenance, LIVE_MAX_EVIDENCE, (item) => ({
    kind: safeText(item?.kind, "provenance", 64),
    ownerBindingMode: safeNullableText(item?.ownerBindingMode, 64),
    state: safeText(item?.state, "unavailable", 64),
  }));
  const safeCount = (key, fallback) => safeTransferCount(value.counts?.[key]) ?? fallback;
  const run = {
    runId,
    title: safeText(value.run?.title, "Governed run", 120),
    task: safeText(value.run?.task, "Governed execution", 240),
    status: normalizeStatus(value.run?.status, "in_doubt"),
    currentStage: normalizeStage(value.run?.currentStage),
    startedAt: safeTimestamp(value.run?.startedAt),
    updatedAt: safeTimestamp(value.run?.updatedAt),
    completedAt: safeTimestamp(value.run?.completedAt),
  };
  return {
    schemaVersion: LIVE_COMPACT_PROJECTION_SCHEMA_VERSION,
    run,
    session: {
      sessionId: publicId("session", runId),
      title: safeText(value.session?.title, run.title, 120),
      status: normalizeStatus(value.session?.status, run.status),
      nodeCount: sanitizedNodes.length,
      eventCount: replay.length,
      activity: safeText(value.session?.activity, run.task, 240),
      runtime: safeText(value.session?.runtime, "unavailable", 96),
      mode: safeText(value.session?.mode, "unavailable", 64),
      lastPromptSummary: safeText(value.session?.lastPromptSummary, "Prompt summary withheld", 180),
      fileChangeCount: safeTransferCount(value.session?.fileChangeCount),
      artifactCount: safeTransferCount(value.session?.artifactCount),
      plannedCount: safeTransferCount(value.session?.plannedCount),
      completedCount: safeTransferCount(value.session?.completedCount),
      failedCount: safeTransferCount(value.session?.failedCount),
      blockedCount: safeTransferCount(value.session?.blockedCount),
      proofState: safeText(value.session?.proofState, "unavailable", 96),
    },
    nodes: sanitizedNodes,
    edges: sanitizedEdges,
    evidence,
    replay,
    prompts,
    toolCalls,
    provenance,
    repository: repositoryProjection(value),
    workspace: workspaceProjection(value),
    contextTransfers: safeCompactContextTransfers(value.contextTransfers, runId, sanitizedNodes),
    eventIndex: replay.length,
    eventCount: replay.length,
    counts: {
      nodes: safeCount("nodes", sanitizedNodes.length),
      edges: safeCount("edges", sanitizedEdges.length),
      evidence: safeCount("evidence", evidence.length),
      events: safeCount("events", replay.length),
      toolCalls: safeCount("toolCalls", toolCalls.length),
      prompts: safeCount("prompts", prompts.length),
      provenance: safeCount("provenance", provenance.length),
      contextTransfers: safeCount("contextTransfers", 0),
    },
  };
}

function buildReplay(artifact, durable, observedAt, stale, knownNodes = []) {
  const events = rawReplayEvents(artifact, durable);
  const expectedRunId = normalizeLiveRunId(artifact?.runId || durable?.runId);
  const mismatched = events.some((event) => {
    const runId = normalizeLiveRunId(event?.runId);
    return event?.runId !== undefined && (!runId || runId !== expectedRunId);
  });
  if (mismatched) return [];

  const known = new Set(knownNodes.map((node) => node.id));
  const normalized = [];
  for (const [index, event] of events.slice(0, LIVE_MAX_REPLAY).entries()) {
    const at = safeTimestamp(event?.at || event?.timestamp || event?.occurredAt || event?.updatedAt);
    if (!at) continue;
    const eventStage = normalizeStage(firstString(event, ["stage", "stageKey", "currentStage"]));
    const rawNode = typeof event?.nodeId === "string"
      ? event.nodeId
      : eventStage !== "in_doubt"
        ? `stage:${eventStage}`
        : null;
    const candidateNode = rawNode && safeId(rawNode, null);
    const nodeId = candidateNode && (known.has(candidateNode) || /^stage:[a-z-]+$/u.test(candidateNode) || /^worker:[A-Za-z0-9._:-]+$/u.test(candidateNode))
      ? candidateNode
      : "in_doubt";
    const rawKind = event?.kind || event?.type || event?.eventType;
    const kind = eventStage !== "in_doubt" ? "stage" : normalizeKind(rawKind);
    const status = stale ? "in_doubt" : normalizeStatus(event?.status || event?.state);
    normalized.push({
      sequence: Number.isSafeInteger(event?.sequence) && event.sequence > 0 ? event.sequence : index + 1,
      at,
      kind,
      nodeId,
      status,
      label: `${kind.replaceAll("_", " ")} · ${status.replaceAll("_", " ")}`,
    });
  }
  normalized.sort((left, right) => left.sequence - right.sequence || left.at.localeCompare(right.at));
  return normalized.map((event, index) => ({ ...event, sequence: index + 1 }));
}

/**
 * Build the frozen v1 control-room view model from trusted local records.
 * Unknown fields are omitted or represented as `in_doubt`; no raw source
 * payload is returned.
 *
 * @param {object} options
 * @returns {object}
 */
export function buildLiveSnapshot({
  durableStatus = null,
  governedArtifact = null,
  observedAt = new Date().toISOString(),
  staleAfterMs = LIVE_STALE_AFTER_MS,
} = {}) {
  const safeObservedAt = safeTimestamp(observedAt) || new Date().toISOString();
  const durable = durableStatus && typeof durableStatus === "object" ? durableStatus : null;
  const artifact = governedArtifact && typeof governedArtifact === "object" ? governedArtifact : null;
  const durableRunId = normalizeLiveRunId(durable?.runId);
  const artifactRunId = normalizeLiveRunId(artifact?.runId || artifact?.run?.runId);
  const durableUpdatedAt = updatedAtFor(durable);
  const durableFresh = Boolean(durableRunId) && !isStale(durableUpdatedAt, safeObservedAt, staleAfterMs);
  const durableActive = durableFresh && (
    durable?.active === true || normalizeStatus(firstString(durable, ["lifecycleStatus", "status"])) === "active"
  );

  // Never merge different runs. When the records disagree, select the fresher
  // authority instead of allowing an old active-run projection to hide a newer
  // governed artifact.
  let selectedDurable = durable;
  let compatibleArtifact = artifact;
  if (durableRunId && artifactRunId && durableRunId !== artifactRunId) {
    if (durableActive) compatibleArtifact = null;
    else selectedDurable = null;
  }
  const sourceRecord = selectedDurable || compatibleArtifact;
  if (!sourceRecord) return emptySnapshot(safeObservedAt);
  let projection = null;
  if (compatibleArtifact) {
    try {
      projection = compatibleArtifact.schemaVersion === LIVE_COMPACT_PROJECTION_SCHEMA_VERSION
        ? sanitizeCompactProjection(compatibleArtifact)
        : buildLiveCompactProjection(compatibleArtifact);
    } catch {
      projection = null;
    }
  }
  if (!projection && selectedDurable) {
    try {
      projection = buildLiveCompactProjection({
        ...selectedDurable,
        task: "Active governed run",
        title: "Active governed run",
      });
    } catch {
      return emptySnapshot(safeObservedAt);
    }
  }
  if (!projection?.run) return emptySnapshot(safeObservedAt);

  const sameRunDurable = selectedDurable && durableRunId === projection.run.runId;
  const stale = Boolean(sameRunDurable && !durableFresh && !compatibleArtifact);
  const run = {
    ...projection.run,
    status: sameRunDurable && durableActive
      ? "active"
      : stale
        ? "in_doubt"
        : normalizeStatus(projection.run.status, "in_doubt"),
    currentStage: sameRunDurable && durableFresh
      ? normalizeStage(firstString(selectedDurable, ["currentStageKey", "currentStage", "stage"]))
      : normalizeStage(projection.run.currentStage),
    updatedAt: sameRunDurable && durableFresh ? durableUpdatedAt : safeTimestamp(projection.run.updatedAt),
  };
  const kind = compatibleArtifact
    ? compatibleArtifact.__source === "live_projection" || compatibleArtifact.schemaVersion === LIVE_COMPACT_PROJECTION_SCHEMA_VERSION
      ? "live_projection"
      : "governed_artifact"
    : "durable_status";
  const contextTransfers = safeCompactContextTransfers(
    projection.contextTransfers,
    projection.run.runId,
    projection.nodes,
  );
  const countValue = (key, fallback) => Number.isSafeInteger(projection.counts?.[key]) && projection.counts[key] >= 0
    ? projection.counts[key]
    : fallback;
  return {
    schemaVersion: LIVE_SNAPSHOT_SCHEMA_VERSION,
    source: sourceEnvelope(kind, safeObservedAt, stale),
    run,
    session: projection.session || null,
    nodes: boundedArray(projection.nodes, LIVE_MAX_NODES),
    edges: boundedArray(projection.edges, LIVE_MAX_EDGES),
    evidence: boundedArray(projection.evidence, LIVE_MAX_EVIDENCE),
    replay: boundedArray(projection.replay, LIVE_MAX_REPLAY),
    // These collections are already safe compact projections. Keeping them in
    // the public read model lets the Inspector explain provenance and tool
    // activity without exposing raw prompts or tool payloads.
    prompts: boundedArray(projection.prompts, LIVE_MAX_EVIDENCE),
    toolCalls: boundedArray(projection.toolCalls, LIVE_MAX_EVIDENCE),
    provenance: boundedArray(projection.provenance, LIVE_MAX_EVIDENCE),
    repository: repositoryProjection(projection),
    workspace: workspaceProjection(projection),
    contextTransfers,
    eventIndex: Number.isSafeInteger(projection.eventIndex) ? projection.eventIndex : projection.replay?.length || 0,
    eventCount: Number.isSafeInteger(projection.eventCount) ? projection.eventCount : projection.replay?.length || 0,
    counts: {
      nodes: countValue("nodes", projection.nodes?.length || 0),
      edges: countValue("edges", projection.edges?.length || 0),
      evidence: countValue("evidence", projection.evidence?.length || 0),
      events: countValue("events", projection.replay?.length || 0),
      toolCalls: countValue("toolCalls", projection.toolCalls?.length || 0),
      prompts: countValue("prompts", projection.prompts?.length || 0),
      provenance: countValue("provenance", projection.provenance?.length || 0),
      contextTransfers: countValue("contextTransfers", contextTransfers.length),
    },
    permissions: permissions(),
  };
}

function emptyReplay(runId = null, observedAt = new Date().toISOString()) {
  return {
    schemaVersion: LIVE_REPLAY_SCHEMA_VERSION,
    runId: normalizeLiveRunId(runId),
    replay: [],
    source: sourceEnvelope("empty", observedAt, true),
    permissions: permissions(),
  };
}

function continuationError(message, code = "LIVE_CONTINUATION_UNAVAILABLE") {
  const error = new Error(`Live continuation: ${message}`);
  error.code = code;
  return error;
}

/**
 * @param {object} [options]
 * @returns {LiveControlRoomService}
 */
export function createLiveControlRoomService(options = {}) {
  const repository = options.repository || createLiveReadRepository(options);
  const clock = options.clock || (() => new Date());
  const staleAfterMs = Number.isFinite(options.staleAfterMs) ? options.staleAfterMs : LIVE_STALE_AFTER_MS;
  const continuationPlanner = options.continuationPlanner || null;
  const continuationCommandStore = options.commandStore || options.continuationCommandStore || null;
  const continuationAdapterRegistry = options.adapterRegistry || options.runtimeAdapterRegistry || null;

  const readDurable = async () => {
    try {
      return typeof repository.readDurableStatus === "function" ? await repository.readDurableStatus() : null;
    } catch {
      return null;
    }
  };
  const readLatestArtifact = async () => {
    try {
      return typeof repository.readLatestArtifact === "function" ? await repository.readLatestArtifact() : null;
    } catch {
      return null;
    }
  };

  const getSnapshot = async (requestedRunId = null) => {
    const observedAt = nowIso(clock);
    const durable = await readDurable();
    if (requestedRunId !== null) {
      if (!isLiveRunId(requestedRunId)) return emptySnapshot(observedAt);
      let artifact = null;
      try {
        artifact = typeof repository.readArtifact === "function"
          ? await repository.readArtifact(requestedRunId)
          : null;
      } catch {
        artifact = null;
      }
      const matchingDurable = normalizeLiveRunId(durable?.runId) === requestedRunId
        ? durable
        : null;
      return buildLiveSnapshot({
        durableStatus: matchingDurable,
        governedArtifact: artifact,
        observedAt,
        staleAfterMs,
      });
    }
    const artifact = await readLatestArtifact();
    return buildLiveSnapshot({ durableStatus: durable, governedArtifact: artifact, observedAt, staleAfterMs });
  };

  const getReplay = async (runId) => {
    const observedAt = nowIso(clock);
    if (!isLiveRunId(runId)) return emptyReplay(null, observedAt);
    let artifact = null;
    try {
      artifact = typeof repository.readArtifact === "function" ? await repository.readArtifact(runId) : null;
    } catch {
      artifact = null;
    }
    if (!artifact) return emptyReplay(runId, observedAt);
    const currentDurable = await readDurable();
    const durable = normalizeLiveRunId(currentDurable?.runId) === runId ? currentDurable : null;
    const snapshot = buildLiveSnapshot({ durableStatus: durable, governedArtifact: artifact, observedAt, staleAfterMs });
    if (!snapshot.run || snapshot.run.runId !== runId) return emptyReplay(runId, observedAt);
    return {
      schemaVersion: LIVE_REPLAY_SCHEMA_VERSION,
      runId,
      replay: snapshot.replay,
      source: snapshot.source,
      permissions: permissions(),
    };
  };

  const getShare = async ({ runId = null, format = "json", title } = {}) => {
    if (format !== "json" && format !== "markdown" && format !== "readme") {
      throw continuationError("unsupported share format", "LIVE_SHARE_FORMAT_UNSUPPORTED");
    }
    if (runId !== null && !isLiveRunId(runId)) {
      throw continuationError("invalid share run id", "LIVE_SHARE_RUN_ID_INVALID");
    }
    const snapshot = await getSnapshot(runId);
    if (!snapshot?.run) throw continuationError("no trusted run is available for sharing", "LIVE_SHARE_UNAVAILABLE");
    const requestedRunId = runId || snapshot.run.runId;
    const replay = runId ? await getReplay(runId) : {
      runId: snapshot.run.runId,
      replay: snapshot.replay,
      source: snapshot.source,
      permissions: snapshot.permissions,
    };
    const artifact = buildLiveShareArtifact({
      snapshot: { ...snapshot, schemaVersion: "meta-kim-live-snapshot-v1" },
      replay: { ...replay, schemaVersion: "meta-kim-live-replay-v1" },
    });
    if (format === "markdown") return renderLiveShareCard(artifact, { title });
    if (format === "readme") return renderLiveReadmeEmbed(artifact, { title });
    return artifact;
  };

  const planContinuation = async (command, overrides = {}) => {
    if (continuationPlanner?.plan && typeof continuationPlanner.plan === "function") {
      return continuationPlanner.plan(command, overrides);
    }
    if (typeof continuationPlanner === "function") return continuationPlanner(command, overrides);
    if (options.durableRepository && continuationAdapterRegistry) {
      return planLiveContinuation({
        ...options,
        ...overrides,
        command,
        repository: options.durableRepository,
        adapterRegistry: continuationAdapterRegistry,
      });
    }
    throw continuationError("no durable continuation planner is injected", "LIVE_CONTINUATION_PLANNER_UNAVAILABLE");
  };

  const executeContinuation = async (plan, overrides = {}) => {
    const durableRepository = overrides.durableRepository || options.durableRepository || null;
    const commandStore = overrides.commandStore || continuationCommandStore;
    if (!durableRepository || typeof durableRepository.resumeRun !== "function" || typeof durableRepository.verifyEventChain !== "function") {
      throw continuationError("no durable continuation authority is injected", "LIVE_CONTINUATION_AUTHORITY_REQUIRED");
    }
    for (const method of ["prepareEffect", "markEffectDispatchStarted", "markUnresolvedEffectsInDoubt"]) {
      if (typeof durableRepository[method] !== "function") {
        throw continuationError(`no durable continuation effect protocol method ${method} is injected`, "LIVE_CONTINUATION_EFFECT_PROTOCOL_REQUIRED");
      }
    }
    if (!commandStore || typeof commandStore.append !== "function") {
      throw continuationError("no durable continuation command store is injected", "LIVE_CONTINUATION_STORE_REQUIRED");
    }
    if (continuationPlanner?.execute && typeof continuationPlanner.execute === "function") {
      return continuationPlanner.execute(plan, {
        ...overrides,
        durableRepository,
        commandStore,
        adapterRegistry: overrides.adapterRegistry || continuationAdapterRegistry,
      });
    }
    if (!continuationAdapterRegistry) {
      throw continuationError("no runtime adapter is injected", "LIVE_CONTINUATION_ADAPTER_UNAVAILABLE");
    }
    return executeLiveContinuation({
      plan,
      adapterRegistry: continuationAdapterRegistry,
      commandStore,
      durableRepository,
      expectedStoreRevision: overrides.expectedStoreRevision,
      nowMs: overrides.nowMs ?? Date.now(),
    });
  };

  return {
    repository,
    getSnapshot,
    getReplay,
    getShare,
    getShareArtifact: getShare,
    planContinuation,
    planLiveContinuation: planContinuation,
    executeContinuation,
    executeLiveContinuation: executeContinuation,
    buildSnapshot: getSnapshot,
    resolveProjectRoot: () => resolveLiveProjectRoot(options),
  };
}

export {
  emptySnapshot,
  emptyReplay,
  normalizeKind,
  normalizeStage,
  normalizeStatus,
  safeText,
};
