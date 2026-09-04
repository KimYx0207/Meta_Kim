import { createHash } from "node:crypto";
import {
  createLiveReadRepository,
  isLiveRunId,
  normalizeLiveRunId,
  resolveLiveProjectRoot,
} from "../../infrastructure/live/live-read-repository.mjs";
import { buildLiveShareArtifact } from "./build-live-share-artifact.mjs";
import {
  conversationDiscoveryForRuntime,
  conversationLinkPlacementForRun,
  conversationLinkRefusalFor,
  conversationMatchBasisFor,
  conversationRuntimeFamily,
  declaredLinkPlacementForRun,
  mergeConversationLinkBuckets,
  normalizeConversationMatchBasis,
  recordConversationRuntime,
} from "./live-conversation-link-vocabulary.mjs";
import {
  renderLiveReadmeEmbed,
  renderLiveShareCard,
} from "../../presentation/live/render-live-share-card.mjs";
import {
  executeLiveContinuation,
  planLiveContinuation,
} from "./plan-live-continuation.mjs";
import {
  buildLiveSchedulingProjection,
  sanitizeLiveSchedulingProjection,
} from "./live-scheduling-projection.mjs";
import { RUN_SUBSTANCE_CLASSES, runSubstance } from "./live-run-substance.mjs";
import { LIVE_RECORD_ORIGINS, liveRecordOrigin } from "./live-record-origin.mjs";
import {
  liveTerminalStatusDisplay,
  normalizeLiveStatus,
} from "./live-status-vocabulary.mjs";

export { RUN_SUBSTANCE_CLASSES, runSubstance };

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
export const LIVE_MAX_DECLARED_PLAN_NODES = 512;

/**
 * Statuses a stage-DAG packet or one of its lanes uses to say it has not run.
 * The shipped records carry `planned_not_invoked` for lanes and `pending_merge`
 * for merge nodes; the other three appear in older packets. Anything outside
 * this set is treated as a real invocation claim, so adding a member here makes
 * a lane stop counting as invoked.
 */
const DECLARED_PLAN_UNINVOKED_STATUSES = new Set([
  "planned_not_invoked",
  "pending_merge",
  "pending",
  "queued",
  "planned",
]);

/**
 * Why a snapshot carries no task nodes. A reader cannot act on "the graph is
 * empty"; they can act on knowing whether the run never wrote an artifact, wrote
 * one that declares nothing, or could not be read at all. The presentation layer
 * imports this vocabulary so every value it can receive is forced to carry copy.
 */
export const LIVE_GRAPH_AVAILABILITY_REASONS = Object.freeze({
  noReadableRunRecord: "no_readable_run_record",
  noGovernedArtifactForRun: "no_governed_artifact_for_run",
  artifactDeclaredNoNodes: "artifact_declared_no_nodes",
});

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

function publicTaskBinding(value) {
  const taskId = exactTaskId(value);
  if (!taskId) return null;
  return /^task:[a-f0-9]{20}$/u.test(taskId) ? taskId : publicId("task", taskId);
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
  return normalizeLiveStatus(value, fallback);
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

/**
 * Snapshot for a run whose durable status record exists but whose governed
 * artifact does not. The collections are genuinely empty, so the counts are real
 * zeros rather than guesses, and `graphAvailability` states why they are zero so
 * a reader is never left to infer that the run had one agent and lost it.
 */
function durableOnlySnapshot(durable, { observedAt, stale, active }) {
  const run = normalizeRun(durable, null, stale);
  if (!run) return emptySnapshot(observedAt);
  const substance = runSubstance(durable);
  const runActive = active === true;
  // The activation hook writes the chat binding onto the status record before any
  // governed artifact exists, so this path is the only one that can carry it for a
  // run that has just started. Dropping it here is what made a bound run render as
  // "no chat id was saved" on the very surface that proves the run is live.
  const publicRun = {
    ...run,
    active: runActive,
    substanceClass: substance.substanceClass,
    ...conversationLinkProjection(durable, run.runId),
    ...publicDisplay(run.status, { active: runActive, structuralOnly: false }),
  };
  return {
    schemaVersion: LIVE_SNAPSHOT_SCHEMA_VERSION,
    source: sourceEnvelope("durable_status", observedAt, stale),
    run: publicRun,
    session: null,
    nodes: [],
    edges: [],
    evidence: [],
    replay: [],
    prompts: [],
    toolCalls: [],
    provenance: [],
    repository: repositoryProjection(null),
    workspace: workspaceProjection(null),
    contextTransfers: [],
    scheduling: null,
    eventIndex: 0,
    eventCount: 0,
    counts: {
      nodes: 0,
      edges: 0,
      evidence: 0,
      events: 0,
      toolCalls: 0,
      prompts: 0,
      provenance: 0,
      contextTransfers: 0,
    },
    graphAvailability: {
      state: "no_graph_evidence",
      reason: LIVE_GRAPH_AVAILABILITY_REASONS.noGovernedArtifactForRun,
      substanceClass: substance.substanceClass,
      substanceSource: substance.substanceSource,
      substanceSignals: substance.substanceSignals,
    },
    permissions: permissions(),
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
    scheduling: null,
    permissions: permissions(),
    graphAvailability: {
      state: "no_run_selected",
      reason: LIVE_GRAPH_AVAILABILITY_REASONS.noReadableRunRecord,
      substanceClass: null,
      substanceSource: null,
      substanceSignals: null,
    },
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

function evidenceIsStructuralOnly(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidenceKind = String(value.evidenceKind || value.resultKind || "").trim().toLowerCase();
  const observedResult = String(value.observedResult || "").trim().toLowerCase();
  const detail = String(value.detail || "").trim().toLowerCase();
  const runBy = String(value.runBy || "").trim().toLowerCase();
  return evidenceKind.includes("structural") ||
    observedResult === "not_run_by_structural_artifact_builder" ||
    observedResult === "not_run_by_governed_runner" ||
    detail === "not_run_by_structural_artifact_builder" ||
    detail === "not_run_by_governed_runner" ||
    runBy === "not_run";
}

function evidenceMatchesBinding(value, { runId = null, taskId = null } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const explicitRunId = recordRunId(value);
  if (runId && explicitRunId !== runId) return false;
  const explicitTaskId = taskIdFrom(value);
  if (taskId && explicitTaskId !== taskId) return false;
  return true;
}

const TRUSTED_TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function terminalEvidenceRecords(result, { runId = null, taskId = null } = {}) {
  const records = [
    ...boundedArray(result?.workerExecutionEvidence, 24),
    ...boundedArray(result?.terminalEvidence, 24),
  ];
  return records.filter((item) => {
    if (evidenceIsStructuralOnly(item) || !evidenceMatchesBinding(item, { runId, taskId })) return false;
    return TRUSTED_TERMINAL_STATUSES.has(normalizeStatus(firstString(item, ["status", "resultStatus", "result"])));
  });
}

function terminalStatusIsProven(result, expectedStatus, binding = {}) {
  const normalized = normalizeStatus(expectedStatus, "in_doubt");
  return terminalEvidenceRecords(result, binding)
    .some((item) => normalizeStatus(firstString(item, ["status", "resultStatus", "result"])) === normalized);
}

function passingVerificationEvidence(artifact, runId = null) {
  const verification = artifact?.verificationPacket;
  if (!verification || typeof verification !== "object") return [];
  return [verification.verificationResults, verification.fixEvidence]
    .filter(Array.isArray)
    .flat()
    .filter((item) => structuredEvidencePassed(item) && !evidenceIsStructuralOnly(item) && evidenceMatchesBinding(item, { runId }));
}

function passingWorkerEvidence(result, { runId = null, taskId = null } = {}) {
  const boundTaskId = taskId || taskIdFrom(result);
  return terminalEvidenceRecords(result, { runId, taskId: boundTaskId })
    .filter((item) => normalizeStatus(firstString(item, ["status", "resultStatus", "result"])) === "completed");
}

function completionIsProven(artifact, runId = null) {
  return passingVerificationEvidence(artifact, runId).length > 0;
}

function runTerminalStatusIsProven(artifact, runId, status) {
  const normalized = normalizeStatus(status, "in_doubt");
  if (normalized === "completed") return completionIsProven(artifact, runId);
  if (!TRUSTED_TERMINAL_STATUSES.has(normalized)) return false;
  return boundedArray(artifact?.workerResultPackets, LIVE_MAX_NODES)
    .some((result) => {
      const taskId = taskIdFrom(result);
      return Boolean(taskId) && terminalStatusIsProven(result, normalized, { runId, taskId });
    });
}

/**
 * Where a persisted run record came from.
 *
 * A projection built from an acceptance fixture runs through the same pipeline
 * as a real run and lands in the same governed-executions directory, so the two
 * files are indistinguishable once written. Origin therefore has to be declared
 * by the producer and carried on the record: a reader cannot recover it later,
 * and an unmarked fixture reads as the most complete row in the directory
 * because a fixture always has the worker counts and runtime a real activation
 * often lacks.
 *
 * Absent means governed run, so existing real records need no migration, and an
 * unrecognized value collapses to the same neutral default rather than reaching
 * a reader as a self-declared label.
 */
export { LIVE_RECORD_ORIGINS, liveRecordOrigin };

function artifactIsStructuralOnly(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false;
  if (artifact?.run?.executionEvidenceState === "structural_planning_only") return true;
  if (artifact?.executionResult?.actualWorkerExecution === false) return true;
  if (/planned_not_executed/iu.test(String(artifact?.executionResult?.executionClosure || ""))) return true;
  const results = [
    ...(Array.isArray(artifact.workerResultPackets) ? artifact.workerResultPackets : []),
    ...(Array.isArray(artifact.nodes) ? artifact.nodes.filter((node) => node?.kind === "agent" && node?.isMain !== true) : []),
  ];
  return results.length > 0 && results.every((result) =>
    /planned_not_executed/iu.test(String(result?.status || result?.resultKind || "")) ||
    String(result?.evidenceKind || "").toLowerCase().includes("structural") ||
    boundedArray(result?.workerExecutionEvidence, 24).some(evidenceIsStructuralOnly));
}

function publicDisplay(status, { active = false, structuralOnly = false } = {}) {
  const normalized = normalizeStatus(status, "in_doubt");
  if (structuralOnly) {
    return { displayState: "unreported", statusReason: "这是结构规划记录，不是执行证据；尚未发现可信任务回报。" };
  }
  const terminal = liveTerminalStatusDisplay(normalized);
  if (terminal) return { ...terminal };
  if (normalized === "active") return { displayState: "active", statusReason: "运行当前仍处于活动状态。" };
  if (normalized === "pending" && active) {
    return { displayState: "queued", statusReason: "运行仍在进行，该任务等待执行或等待可信回报。" };
  }
  if (["pending", "session_stopped", "archived"].includes(normalized)) {
    return { displayState: "unreported", statusReason: "运行当前不活跃，尚未发现该任务的可信执行回报。" };
  }
  return { displayState: "unknown", statusReason: "现有记录不足以判断该任务是否执行或完成。" };
}

function safeConversationRuntime(value) {
  return conversationRuntimeFamily(value);
}

function safeConversationRef(value) {
  if (typeof value !== "string") return null;
  const ref = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9:._-]{3,159}$/u.test(ref) && !containsSecret(ref) ? ref : null;
}

function conversationRefFrom(value) {
  return safeConversationRef(firstString(value, [
    "conversationId", "threadId", "sessionId", "composerId", "sessionKey", "conversationRef",
  ]));
}

function conversationLinkProjection(artifact, runId) {
  const verifiedLinks = [];
  const candidateLinks = [];
  const append = (target, value, matchBasis) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const conversationRef = conversationRefFrom(value);
    if (!conversationRef) return;
    const sourceRuntime = safeConversationRuntime(value.runtime || value.provider || value.sourceRuntime);
    const title = safeNullableText(value.title || value.conversationTitle, 120);
    const updatedAt = safeTimestamp(value.updatedAt || value.timestamp || value.occurredAt);
    target.push({
      sourceRuntime,
      conversationRef,
      matchBasis,
      ...(title ? { conversationTitle: title } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    });
  };
  const source = artifact?.sourceConversation && typeof artifact.sourceConversation === "object"
    ? artifact.sourceConversation
    : null;
  // Every basis below is the strongest fact this pass can observe, and the record
  // may already carry a stronger one: the activation hook writes
  // `transcript_file_verified` after it opens the transcript file and matches its
  // identity, which no read of metadata can reach. Hardcoding a literal here threw
  // that away and then persisted the weaker value into the compact projection, so
  // one run had two provenance claims on disk and the surviving one was the guess.
  if (source) {
    // One call decides both the array and the basis. Naming another run is a fact
    // about the reference, not a reason to have nothing to show: dropping it left
    // this surface on the unlinked sentence with no refusal to explain it, while
    // the session list showed the same reference as a candidate — one file, and a
    // reader who opens both is told the chat is unknown in one place and possibly
    // relevant in the other.
    const placement = conversationLinkPlacementForRun(source, runId);
    append(
      placement.proven ? verifiedLinks : candidateLinks,
      source,
      conversationMatchBasisFor(source.matchBasis, placement.derivedBasis),
    );
  }
  const exactRecords = [artifact?.conversationLinks, artifact?.runtimeConversationLinks].filter(Array.isArray).flat();
  for (const record of exactRecords) {
    // Standing and basis come from one call. A stored verified flag cannot outrank
    // the record's own statement that it belongs to a different run — letting it
    // win is how a link proven for one run became another run's confirmed chat —
    // and a flag with no run id beside it cannot name a thread-id match either,
    // because nothing here compares a thread id.
    const placement = declaredLinkPlacementForRun(record, runId);
    append(
      placement.proven ? verifiedLinks : candidateLinks,
      record,
      conversationMatchBasisFor(record?.matchBasis, placement.derivedBasis),
    );
  }
  const candidateRecords = [artifact?.conversationCandidates, artifact?.candidateConversationLinks].filter(Array.isArray).flat();
  for (const record of candidateRecords) {
    append(candidateLinks, record, conversationMatchBasisFor(record?.matchBasis, "title_time_project_similarity"));
  }
  // One record can describe one chat more than once, and this pass reads those
  // descriptions in its own order while the session list reads them in another. A
  // fold that resolves duplicates by which arrived first is therefore a fold that
  // lets the two surfaces disagree about one file, so both call the same one.
  const { verified, candidates } = mergeConversationLinkBuckets(verifiedLinks, candidateLinks);
  const primary = verified[0] || candidates[0] || null;
  const conversationLinkState = verified.length ? "verified" : candidates.length ? "candidate" : "unlinked";
  const refusal = conversationLinkRefusalFor(conversationLinkState, artifact?.conversationLinkRefusal);
  const sourceRuntime = primary?.sourceRuntime || recordConversationRuntime(artifact);
  return {
    sourceRuntime,
    conversationLinkState,
    // The session list derived this and the run header did not, so one run
    // explained how far its chat lookup reached in the list and fell back to the
    // generic sentence in its own header. Emitting it beside the runtime it is
    // derived from is what keeps the two surfaces on one answer.
    conversationDiscovery: conversationDiscoveryForRuntime(sourceRuntime),
    verifiedLinks: verified.slice(0, 16),
    candidateLinks: candidates.slice(0, 16),
    ...(refusal ? { conversationLinkRefusal: refusal } : {}),
    ...(primary?.conversationRef ? { conversationRef: primary.conversationRef } : {}),
    ...(primary?.conversationTitle ? { conversationTitle: primary.conversationTitle } : {}),
  };
}

function sanitizeConversationLinks(value) {
  return boundedArray(value, 16).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const conversationRef = safeConversationRef(item.conversationRef || item.threadId || item.sessionId);
    if (!conversationRef) return [];
    const sourceRuntime = safeConversationRuntime(item.sourceRuntime || item.runtime || item.provider);
    const conversationTitle = safeNullableText(item.conversationTitle || item.title, 120);
    const updatedAt = safeTimestamp(item.updatedAt || item.timestamp);
    return [{
      sourceRuntime,
      conversationRef,
      // This path forwards a link another surface already decided, so there is no
      // fact at hand to compare against and the stored value stands. It is still
      // whitelisted: `safeText` accepted any 64-character string, so a basis from a
      // newer build reached a reader as a raw enum.
      matchBasis: normalizeConversationMatchBasis(item.matchBasis) ?? "metadata_candidate",
      ...(conversationTitle ? { conversationTitle } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    }];
  });
}

function recordTime(record) {
  const value = updatedAtFor(record);
  return value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
}

function taskIdFrom(record) {
  return exactTaskId(firstString(record, ["taskPacketId", "taskId", "roleInstanceId", "businessRoleId"]));
}

/**
 * Not the reader the conversation surfaces use. This one answers a different
 * question — does this event, evidence binding, result, or lifecycle record
 * belong to the run being projected — where the format gate is wanted: an
 * unparseable id is not a claim worth honouring when the record is being
 * admitted into a run's own counts.
 *
 * `conversationRecordRunId` deliberately drops that gate, because for a chat
 * reference an unparseable id is still the record saying the chat belongs
 * elsewhere, and resolving it to nothing is what read as 已确认. Left as-is
 * rather than unified: sharing one reader across both questions would carry the
 * conversation surface's tolerance into the counts.
 */
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
  for (const lifecycle of boundedArray(artifact?.workerLifecycle, LIVE_MAX_NODES)) {
    if (!recordBelongsToRun(lifecycle, runId)) continue;
    const taskId = taskIdFrom(lifecycle);
    if (!taskId || results.has(taskId)) continue;
    const status = lifecycle?.status === "queued" ? "pending" : lifecycle?.status;
    results.set(taskId, {
      ...lifecycle,
      status,
      workerExecutionEvidence: boundedArray(lifecycle?.terminalEvidence, 8),
    });
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
    runId: normalizeLiveRunId(item?.runId || result?.runId),
    taskPacketId: publicTaskBinding(item?.taskPacketId || item?.taskId || result?.taskPacketId || result?.taskId || taskId),
    proofValid: item?.proofValid === true,
    synthetic: item?.synthetic === true,
    evidenceKind: safeNullableText(item?.evidenceKind, 80),
  }));
}

function safeToolCalls(hostEvidence, taskId) {
  return evidenceForTask(hostEvidence, taskId)
    .filter((item) => ["command_script", "runtime_tool"].includes(String(item?.family || "").trim().toLowerCase()))
    .filter(evidenceShowsActualInvocation)
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
  const observed = evidenceForTask(hostEvidence, taskId).find(evidenceShowsActualInvocation);
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
  const hooks = bindings.hooks ?? packet?.hookLoadout;
  const plugins = bindings.plugins ?? packet?.pluginLoadout;
  const memoryGraph = bindings.memoryGraph ?? bindings.memory_graph ?? packet?.memoryGraphLoadout;
  const dependencies = bindings.dependencies ?? packet?.dependencyLoadout;
  return {
    skills: count(skills),
    mcp: count(mcp),
    tools: count(tools),
    commands: count(commands),
    hooks: count(hooks),
    plugins: count(plugins),
    memoryGraph: count(memoryGraph),
    dependencies: count(dependencies),
    skillNames: names(skills),
    mcpNames: names(mcp),
    toolNames: names(tools),
    commandNames: names(commands),
    hookNames: names(hooks),
    pluginNames: names(plugins),
    memoryGraphNames: names(memoryGraph),
    dependencyNames: names(dependencies),
  };
}

const LIVE_CAPABILITY_FAMILIES = Object.freeze({
  agent: new Set(["agent_subagent", "durable_agent"]),
  skill: new Set(["skill"]),
  mcp: new Set(["mcp"]),
  command: new Set(["command_script"]),
  runtime_tool: new Set(["runtime_tool"]),
  hook: new Set(["hook"]),
  plugin: new Set(["plugin"]),
  memory_graph: new Set(["memory_graph", "memory-graph"]),
  dependency: new Set(["dependency"]),
});

const LIVE_CAPABILITY_KINDS = Object.freeze(Object.keys(LIVE_CAPABILITY_FAMILIES));

const LIVE_OBSERVED_INVOCATION_STATES = new Set([
  "invoked",
  "returned",
  "verified",
  "applied",
  "completed",
  "accepted",
  "started",
  "running",
  "in_progress",
  "failed",
]);

function uniqueCapabilityNames(values) {
  return [...new Set(values.map((value) => safeText(value, "", 96)).filter(Boolean))].slice(0, 24);
}

function evidenceShowsActualInvocation(item) {
  const state = String(item?.state || "").trim().toLowerCase();
  if (state === "selected_not_invoked") return false;
  const resultStatus = String(item?.resultStatus || "").trim().toLowerCase();
  return LIVE_OBSERVED_INVOCATION_STATES.has(state) || LIVE_OBSERVED_INVOCATION_STATES.has(resultStatus);
}

const OBSERVED_ACTIVE_STATES = new Set(["invoked", "returned", "started", "running", "in_progress", "accepted"]);
const OBSERVED_TERMINAL_STATES = new Set(["completed", "verified", "applied"]);
const OBSERVED_FAILED_STATES = new Set(["failed"]);

function aggregateObservedStatusForTask(hostEvidence, taskId) {
  const rows = evidenceForTask(hostEvidence, taskId).filter(evidenceShowsActualInvocation);
  if (!rows.length) return { state: null, count: 0, lastAt: null };
  let active = 0;
  let terminal = 0;
  let failed = 0;
  let lastAt = null;
  for (const row of rows) {
    const state = String(row?.state || row?.resultStatus || "").trim().toLowerCase();
    if (OBSERVED_FAILED_STATES.has(state)) failed += 1;
    else if (OBSERVED_TERMINAL_STATES.has(state)) terminal += 1;
    else if (OBSERVED_ACTIVE_STATES.has(state)) active += 1;
    const at = Date.parse(row?.occurredAt || row?.observedAt);
    if (Number.isFinite(at) && (lastAt === null || at > lastAt)) lastAt = at;
  }
  let observed = null;
  if (failed > 0 && active === 0 && terminal === 0) observed = "failed";
  else if (active > 0) observed = "active";
  else if (terminal > 0 && failed === 0) observed = "completed";
  else if (terminal > 0) observed = "completed";
  return { state: observed, count: rows.length, lastAt: lastAt ? new Date(lastAt).toISOString() : null };
}

function aggregateFileHeatForTask(hostEvidence, taskId, { cap = 6 } = {}) {
  const map = new Map();
  for (const row of evidenceForTask(hostEvidence, taskId)) {
    const path = safeText(row?.filePath, null, 240);
    if (!path) continue;
    const at = safeTimestamp(row?.occurredAt || row?.observedAt);
    const existing = map.get(path);
    if (existing && Date.parse(existing.at) >= Date.parse(at || 0)) {
      existing.n += 1;
    } else {
      map.set(path, { path, at, n: existing ? existing.n + 1 : 1 });
    }
  }
  return [...map.values()]
    .sort((left, right) => Date.parse(right.at || 0) - Date.parse(left.at || 0))
    .slice(0, cap);
}

function computeHandoffEdges(workerNodes) {
  const byComponent = new Map();
  for (const node of workerNodes) {
    const componentId = node?.componentId || null;
    if (!componentId) continue;
    if (!byComponent.has(componentId)) byComponent.set(componentId, []);
    byComponent.get(componentId).push(node);
  }
  const edges = [];
  const seen = new Set();
  for (const [componentId, nodes] of byComponent.entries()) {
    if (nodes.length < 2) continue;
    const ordered = nodes
      .filter((node) => node?.timing?.startedAt)
      .sort((left, right) => Date.parse(left.timing.startedAt) - Date.parse(right.timing.startedAt));
    for (let index = 1; index < ordered.length; index += 1) {
      const prev = ordered[index - 1];
      const next = ordered[index];
      const key = `${prev.id} ${next.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        from: prev.id,
        to: next.id,
        kind: "handoff",
        componentId: prev.componentId,
        fromRoleInstance: prev.roleInstanceId,
        toRoleInstance: next.roleInstanceId,
        gapMs: Math.max(0, Date.parse(next.timing.startedAt) - Date.parse(prev.timing.completedAt || prev.timing.startedAt)),
      });
      if (edges.length >= LIVE_MAX_EDGES) return edges;
    }
  }
  return edges;
}

function trustTierRank(node) {
  if (node?.isMain === true) return Number.POSITIVE_INFINITY;
  if (node?.kind === "workflow") return 4;
  if (node?.status === "pending") return 0;
  if (node?.status === "in_doubt") return 1;
  if (node?.status === "active") return node?.observedStatus ? 3 : 1;
  if (["completed", "failed", "blocked", "cancelled"].includes(node?.status)) {
    return node?.terminalProofValid ? 4 : 2;
  }
  return 2;
}

function capabilityFamilyKind(family) {
  const normalized = String(family || "").trim().toLowerCase();
  return Object.entries(LIVE_CAPABILITY_FAMILIES)
    .find(([, families]) => families.has(normalized))?.[0] || null;
}

function capabilityTruthRecord(kind, plannedNames, actualNames) {
  const planned = uniqueCapabilityNames(plannedNames);
  const actual = uniqueCapabilityNames(actualNames);
  if (!planned.length && !actual.length) return null;
  return {
    kind,
    state: actual.length ? "observed" : planned.length ? "planned" : "unavailable",
    plannedNames: planned,
    actualNames: actual,
    ...(actual.length ? { observation: "trusted_host_evidence" } : {}),
  };
}

function capabilityTruthForTask(hostEvidence, taskId, { ownerAgent = null, loadout = {} } = {}) {
  const actualByKind = Object.fromEntries(LIVE_CAPABILITY_KINDS.map((kind) => [kind, []]));
  for (const item of evidenceForTask(hostEvidence, taskId)) {
    const kind = capabilityFamilyKind(item?.family);
    if (!kind || !evidenceShowsActualInvocation(item)) continue;
    const name = firstString(item, ["providerId", "nativeAgentType", "hostSurface"]);
    if (name) actualByKind[kind].push(name);
  }
  const plannedByKind = {
    agent: ownerAgent ? [ownerAgent] : [],
    skill: loadout.skillNames || [],
    mcp: loadout.mcpNames || [],
    command: loadout.commandNames || [],
    runtime_tool: loadout.toolNames || [],
    hook: loadout.hookNames || [],
    plugin: loadout.pluginNames || [],
    memory_graph: loadout.memoryGraphNames || [],
    dependency: loadout.dependencyNames || [],
  };
  return LIVE_CAPABILITY_KINDS
    .map((kind) => capabilityTruthRecord(kind, plannedByKind[kind], actualByKind[kind]))
    .filter(Boolean);
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

// Budget compaction can remove a structural node after the scheduling block was
// built. A wave must never keep naming a node the projection no longer carries,
// so membership is pruned here and the loss shows up as reduced coverage rather
// than as a dangling reference.
function dropSchedulingNode(scheduling, nodeId) {
  if (!scheduling || !Array.isArray(scheduling.waves)) return;
  let mappedNodeCount = 0;
  for (const wave of scheduling.waves) {
    if (!wave || !Array.isArray(wave.nodeIds)) continue;
    const kept = wave.nodeIds.filter((id) => id !== nodeId);
    wave.unmappedCount += wave.nodeIds.length - kept.length;
    wave.nodeIds = kept;
    wave.mappedCount = kept.length;
    mappedNodeCount += kept.length;
  }
  scheduling.coverage = {
    ...scheduling.coverage,
    mappedNodeCount,
    complete: scheduling.coverage?.declaredTaskCount > 0
      && mappedNodeCount === scheduling.coverage.declaredTaskCount,
  };
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
    dropSchedulingNode(projection.scheduling, nodeId);
  };
  const lowPriorityNodeIds = () => {
    const ranks = projection.nodes.map((node, index) => {
      const rank = trustTierRank(node);
      return { index, rank };
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
      scheduling: null,
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
  const packets = boundedArray(
    Array.isArray(artifact?.workerTaskPackets) && artifact.workerTaskPackets.length
      ? artifact.workerTaskPackets
      : boundedArray(artifact?.workerLifecycle, LIVE_MAX_NODES - 2).map((record) => ({
          taskPacketId: record?.taskPacketId,
          roleDisplayName: record?.roleDisplayName || "worker",
          roleInstanceId: record?.roleInstanceId,
          stage: "execution",
          status: record?.status === "queued" ? "pending" : record?.status,
        })),
    LIVE_MAX_NODES - 2,
  );
  const runTask = readableRunTask(artifact);
  const runTitle = readableRunTitle(artifact, runTask);
  const results = liveWorkerResultMap(artifact, runId);
  const hostEvidence = trustedHostEvidence(artifact, runId);
  const structuralOnly = artifactIsStructuralOnly(artifact);
  const conversation = conversationLinkProjection(artifact, runId);
  const nodeByTaskId = new Map();
  const workerNodes = packets.map((packet, index) => {
    const taskId = taskIdFrom(packet) || `${runId}:worker:${index + 1}`;
    const result = results.get(taskId) || null;
    const taskEvidence = safeExecutionEvidence(result, taskId);
    let status = normalizeStatus(
      firstString(result, ["status", "resultStatus"]) || firstString(packet, ["status"]),
      "pending",
    );
    if (TRUSTED_TERMINAL_STATUSES.has(status) && !terminalStatusIsProven(result, status, { runId, taskId })) {
      status = "in_doubt";
    }
    const nodeId = publicId("agent", taskId);
    nodeByTaskId.set(taskId, nodeId);
    const telemetry = safeTelemetry(hostEvidence, taskId);
    const toolCalls = safeToolCalls(hostEvidence, taskId);
    const loadout = plannedLoadout(packet);
    const ownerAgent = safeText(firstString(packet, ["ownerAgent", "owner", "agent"]), "unavailable", 96);
    const capabilityTruth = capabilityTruthForTask(hostEvidence, taskId, { ownerAgent, loadout });
    const startedAt = safeTimestamp(result?.startedAt || packet?.startedAt || packet?.createdAt);
    const completedAt = safeTimestamp(result?.completedAt || result?.updatedAt);
    const startMs = startedAt ? Date.parse(startedAt) : NaN;
    const endMs = completedAt ? Date.parse(completedAt) : NaN;
    const role = firstString(packet, ["roleDisplayName", "businessRoleId", "ownerAgent", "owner"]);
    const scope = readableWorkerScope(packet);
    const display = publicDisplay(status, {
      active: false,
      structuralOnly: structuralOnly || evidenceIsStructuralOnly(result),
    });
    const observed = aggregateObservedStatusForTask(hostEvidence, taskId);
    const fileHeat = aggregateFileHeatForTask(hostEvidence, taskId);
    const declaredObservedMismatch = observed.state !== null && observed.state !== status && observed.state !== "completed" && status !== "in_doubt";
    const terminalProofValid = taskEvidence.some((item) => item?.proofValid === true && ["completed", "failed", "blocked", "cancelled"].includes(item?.status));
    return {
      id: nodeId,
      kind: "agent",
      isMain: false,
      label: scope || safeText(role, `worker ${index + 1}`, 80),
      task: scope || `${safeText(role, `worker ${index + 1}`, 80)} worker lane`,
      roleDisplayName: safeText(role, "worker", 80),
      roleInstanceId: safeText(firstString(packet, ["roleInstanceId"]), null, 120),
      taskPacketId: publicTaskBinding(taskId),
      componentId: safeText(firstString(packet, ["componentId"]), null, 96),
      stage: normalizeStage(firstString(packet, ["stage", "currentStage", "stageKey"])) === "in_doubt"
        ? "execution"
        : normalizeStage(firstString(packet, ["stage", "currentStage", "stageKey"])),
      parentId: null,
      status,
      active: false,
      ...display,
      declaredStatus: status,
      observedStatus: observed.state,
      observedCount: observed.count,
      observedAt: observed.lastAt,
      declaredObservedMismatch,
      terminalProofValid,
      fileHeat,
      ownerAgent,
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
      terminalEvidence: taskEvidence.filter((item) => ["completed", "failed", "blocked", "cancelled"].includes(item.status)),
      workerExecutionEvidence: taskEvidence,
      toolCalls,
      toolCount: toolCalls.length,
      latestTool: toolCalls.at(-1)?.name || null,
      loadout,
      capabilityTruth,
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
    active: false,
    parentId: null,
    ownerAgent: safeText(artifact?.dispatchEnvelopePacket?.ownerAgent, "in_doubt", 96),
    runtime: "unavailable",
    runtimeObservation: { state: "unavailable", value: null },
    model: "unavailable",
    modelObservation: { state: "unavailable", value: null },
    summary: `${childIds.length} worker task${childIds.length === 1 ? "" : "s"} · declared route`,
    childCount: childIds.length,
    evidenceCount: 0,
  }));
  // An artifact that never declared a dispatch owner leaves the root owner
  // unknown. `in_doubt` is the read model's existing marker for that, and the
  // page already treats it as non-informative. Defaulting to a real agent name
  // instead used to put a governance agent on the graph that nothing had run.
  const declaredRootOwner = firstString(artifact?.dispatchEnvelopePacket, ["ownerAgent", "owner"]);
  const rootOwner = declaredRootOwner || "in_doubt";
  const mainNode = {
    id: publicId("agent", `${runId}:main:${rootOwner}`),
    kind: "agent",
    isMain: true,
    label: safeText(declaredRootOwner, "main agent", 96),
    task: runTask,
    stage: normalizeStage(artifact?.currentStage || artifact?.currentStageKey),
    status: normalizeStatus(artifact?.status, workerNodes.length ? aggregateNodeStatus(workerNodes) : "in_doubt"),
    active: false,
    ownerAgent: safeText(declaredRootOwner, "in_doubt", 96),
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
    // Both the summary and the provenance state used to assert a declared owner
    // unconditionally, which reads as evidence on exactly the runs that never
    // named one. The owner clause is dropped rather than reworded so this layer
    // does not grow more display copy. The separator is joined rather than
    // interpolated because `runTitle` can normalize to nothing, and a trailing
    // "·" reads as a value the projection failed to load.
    summary: [declaredRootOwner ? "Main governed run owner" : "", runTitle]
      .map((clause) => clause.trim())
      .filter((clause) => clause !== "")
      .join(" · "),
    terminalEvidence: [],
    workerExecutionEvidence: [],
    toolCalls: [],
    toolCount: 0,
    latestTool: null,
    loadout: { skills: 0, mcp: 0, tools: 0, commands: 0, hooks: 0, plugins: 0, memoryGraph: 0, dependencies: 0, skillNames: [], mcpNames: [], toolNames: [], commandNames: [], hookNames: [], pluginNames: [], memoryGraphNames: [], dependencyNames: [] },
    capabilityTruth: [
      declaredRootOwner ? capabilityTruthRecord("agent", [declaredRootOwner], []) : null,
    ].filter(Boolean),
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    promptEras: [{ era: "run", label: "Run intent", summary: "Governed task accepted" }],
    provenance: [{ kind: "dispatch_owner", state: declaredRootOwner ? "declared" : "unreported" }],
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
  // An artifact that named no owner, declared no worker, built no workflow and
  // recorded no replay evidence has nothing to put on the graph. Emitting the
  // root node regardless turned every such record into a one-agent session.
  // A declared owner or any recorded event is real evidence and still draws it,
  // so this drops only the fully synthesized case; budget-driven shrinking to a
  // lone main node is a different thing and stays reachable via `truncated`.
  const graphEvidenceDeclared =
    Boolean(declaredRootOwner) ||
    workerNodes.length > 0 ||
    workflowNodes.length > 0 ||
    (Array.isArray(artifact?.replay) && artifact.replay.length > 0) ||
    (Array.isArray(artifact?.agUiStageEvents?.events) && artifact.agUiStageEvents.events.length > 0);
  const nodes = (graphEvidenceDeclared ? [mainNode, ...workflowNodes, ...workerNodes] : []).slice(0, LIVE_MAX_NODES);
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
  const handoffEdges = computeHandoffEdges(workerNodes);
  for (const edge of handoffEdges) edges.push(edge);
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
  if (TRUSTED_TERMINAL_STATUSES.has(runStatus) && !runTerminalStatusIsProven(artifact, runId, runStatus)) runStatus = "in_doubt";
  mainNode.status = runStatus;
  const runDisplay = publicDisplay(runStatus, { active: false, structuralOnly });
  const applyInactiveDisplay = (node) => Object.assign(node, publicDisplay(node.status, {
    active: false,
    structuralOnly,
  }));
  applyInactiveDisplay(mainNode);
  for (const workflow of workflowNodes) applyInactiveDisplay(workflow);
  // Wave membership is resolved through the same task-id-to-node map the graph
  // already used, so a wave can only ever name a node that exists here. A
  // malformed scheduling policy degrades this one block instead of failing the
  // whole projection and taking a running hub with it.
  let scheduling = null;
  try {
    scheduling = buildLiveSchedulingProjection({
      playbook: artifact?.coreLoop?.agentTeamsPlaybookPacket,
      resolveNodeId: (taskPacketId) => nodeByTaskId.get(taskPacketId) || null,
    });
  } catch {
    scheduling = null;
  }
  const projection = {
    schemaVersion: LIVE_COMPACT_PROJECTION_SCHEMA_VERSION,
    run: {
      runId,
      title: runTitle,
      task: runTask,
      status: runStatus,
      active: false,
      ...runDisplay,
      ...conversation,
      executionEvidenceState: structuralOnly ? "structural_planning_only" : "recorded",
      completionEvidenceState: completionIsProven(artifact, runId) ? "trusted_terminal" : "unproven",
      recordOrigin: liveRecordOrigin(artifact),
      currentStage,
      startedAt,
      updatedAt,
      completedAt: safeTimestamp(artifact?.completedAt),
    },
    session: {
      sessionId: publicId("session", runId),
      title: runTitle,
      status: runStatus,
      active: false,
      ...runDisplay,
      ...conversation,
      recordOrigin: liveRecordOrigin(artifact),
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
    scheduling,
    declaredPlan: declaredStagePlan(artifact),
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
  if (TRUSTED_TERMINAL_STATUSES.has(status) && !runTerminalStatusIsProven(artifact, runId, status)) status = "in_doubt";

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
      if (taskId) count += passingWorkerEvidence(results.get(taskId), { runId: artifact?.runId, taskId }).length;
    }
  }
  if (stage === "verification") count += passingVerificationEvidence(artifact, artifact?.runId).length;
  return Math.min(count, Number.MAX_SAFE_INTEGER);
}

function nodeFromStage(stage, durable, artifact, stale) {
  const evidenceCount = stageEvidenceCount(artifact, stage);
  let status = stageStatus(durable, stage, stale);
  if (TRUSTED_TERMINAL_STATUSES.has(status) && evidenceCount === 0) status = "in_doubt";
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
    const evidenceCount = passingWorkerEvidence(result, { runId: artifact?.runId, taskId }).length;
    let status = stale ? "in_doubt" : normalizeStatus(firstString(result, ["status", "resultStatus"]) || firstString(packet, ["status"]));
    if (TRUSTED_TERMINAL_STATUSES.has(status) && !terminalStatusIsProven(result, status, { runId: artifact?.runId, taskId })) status = "in_doubt";
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

/**
 * A governed artifact records the stage DAG it planned — lanes, owners,
 * dependencies and merge nodes, often forty to fifty of them. None of that is
 * executed work: the packet states its own `status`, and the shipped records
 * all say `planned_not_invoked`. Putting those lanes on the graph would draw a
 * plan as finished execution, so the plan stays out of `nodes` and is reported
 * here as what it is — a declared count the reader can compare against the
 * executed node count. A lane may only be called invoked when the plan itself
 * reports invocation; otherwise a lane claiming `completed` inside an
 * un-invoked plan would be promoted into a completion this run never had.
 */
/**
 * Re-validate a declared plan that came back from a stored projection file.
 * The compact read-back rebuilds every field explicitly, so a plan that is not
 * named here is dropped and the panel silently loses it. A stored file is also
 * untrusted: clamping each lane count to the count the same file declared stops
 * an edited or truncated record from reporting more invoked lanes than it ever
 * planned, which would read as execution the run cannot evidence.
 */
function sanitizeDeclaredPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const count = (input) => safeTransferCount(input) ?? 0;
  const stages = [];
  for (const entry of boundedArray(value.stages, STAGES.length)) {
    const stage = normalizeStage(entry?.stage);
    if (stage === "in_doubt" || stages.some((item) => item.stage === stage)) continue;
    const declaredNodeCount = count(entry?.declaredNodeCount);
    if (declaredNodeCount === 0) continue;
    stages.push({
      stage,
      label: STAGE_LABELS[stage],
      declaredNodeCount,
      invokedNodeCount: Math.min(count(entry?.invokedNodeCount), declaredNodeCount),
    });
  }
  stages.sort((left, right) => STAGES.indexOf(left.stage) - STAGES.indexOf(right.stage));
  const declaredNodeCount = count(value.declaredNodeCount);
  if (declaredNodeCount === 0 && stages.length === 0) return null;
  return {
    authority: safeText(value.authority, "unreported", 200),
    status: declaredPlanStatus(value, ["status", "state"]) || "unreported",
    declaredNodeCount,
    invokedNodeCount: Math.min(count(value.invokedNodeCount), declaredNodeCount),
    omittedNodeCount: count(value.omittedNodeCount),
    unrecognizedStageNodeCount: count(value.unrecognizedStageNodeCount),
    stages,
  };
}

function declaredPlanStatus(value, keys) {
  const raw = firstString(value, keys);
  return typeof raw === "string" ? raw.trim().toLowerCase().replace(/[ -]+/gu, "_") : "";
}

function declaredStagePlan(artifact) {
  const packet = artifact?.coreLoop?.stageDagPacket;
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return null;
  const totalDeclared = Array.isArray(packet.nodes) ? packet.nodes.length : 0;
  const declared = boundedArray(packet.nodes, LIVE_MAX_DECLARED_PLAN_NODES);
  if (declared.length === 0) return null;

  const status = declaredPlanStatus(packet, ["status", "state"]) || "unreported";
  const planInvoked = !DECLARED_PLAN_UNINVOKED_STATUSES.has(status);
  const perStage = new Map();
  let unrecognizedStageNodeCount = 0;
  let invokedNodeCount = 0;

  for (const node of declared) {
    const stage = normalizeStage(firstString(node, ["stage", "stageKey"]));
    const nodeStatus = declaredPlanStatus(node, ["status", "state"]);
    const invoked = planInvoked && nodeStatus !== "" && !DECLARED_PLAN_UNINVOKED_STATUSES.has(nodeStatus);
    if (invoked) invokedNodeCount += 1;
    if (stage === "in_doubt") {
      unrecognizedStageNodeCount += 1;
      continue;
    }
    const bucket = perStage.get(stage) || { stage, label: STAGE_LABELS[stage], declaredNodeCount: 0, invokedNodeCount: 0 };
    bucket.declaredNodeCount += 1;
    if (invoked) bucket.invokedNodeCount += 1;
    perStage.set(stage, bucket);
  }

  return {
    authority: firstString(packet, ["authority", "contract"])?.trim() || "unreported",
    status,
    declaredNodeCount: declared.length,
    invokedNodeCount,
    omittedNodeCount: Math.max(0, totalDeclared - declared.length),
    unrecognizedStageNodeCount,
    stages: STAGES.map((stage) => perStage.get(stage)).filter(Boolean),
  };
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
    output.push({ ...edge, from, to });
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
    runId: normalizeLiveRunId(item.runId),
    taskPacketId: publicTaskBinding(item.taskPacketId || item.taskId),
    proofValid: item.proofValid === true,
    synthetic: item.synthetic === true,
    evidenceKind: safeNullableText(item.evidenceKind, 80),
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
  const compactWorkers = rawNodes.filter((node) => node?.kind === "agent" && node?.isMain !== true);
  const structuralOnly = value?.run?.executionEvidenceState === "structural_planning_only" || (
    compactWorkers.length > 0 && compactWorkers.every((node) =>
      boundedArray(node?.workerExecutionEvidence, 24).some(evidenceIsStructuralOnly) ||
      boundedArray(node?.terminalEvidence, 24).some(evidenceIsStructuralOnly))
  );
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
    let status = normalizeStatus(raw.status, "in_doubt");
    const rawTaskId = safeId(raw.taskPacketId || raw.taskId, null);
    const terminalProven = raw.kind === "agent" && raw.isMain !== true && rawTaskId
      ? boundedArray(raw.terminalEvidence, 24).some((item) =>
          evidenceMatchesBinding(item, { runId, taskId: rawTaskId }) &&
          !evidenceIsStructuralOnly(item) &&
          normalizeStatus(firstString(item, ["status", "resultStatus", "result"])) === status)
      : false;
    if (TRUSTED_TERMINAL_STATUSES.has(status) && raw.kind === "agent" && raw.isMain !== true && !terminalProven) {
      status = "in_doubt";
    }
    return {
      id,
      kind: raw.kind,
      isMain: raw.isMain === true,
      label: safeText(raw.label, raw.kind === "workflow" ? "Workflow" : "Agent", 120),
      task: safeNullableText(raw.task, 240),
      roleDisplayName: safeNullableText(raw.roleDisplayName, 80),
      roleInstanceId: safeNullableText(raw.roleInstanceId, 120),
      taskPacketId: publicTaskBinding(rawTaskId),
      stage: normalizeStage(raw.stage),
      parentId: parentId && knownNodeIds.has(parentId) && parentId !== id ? parentId : null,
      status,
      active: false,
      ...publicDisplay(status, { active: false, structuralOnly }),
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
        hooks: safeTransferCount(raw.loadout?.hooks) ?? 0,
        plugins: safeTransferCount(raw.loadout?.plugins) ?? 0,
        memoryGraph: safeTransferCount(raw.loadout?.memoryGraph) ?? 0,
        dependencies: safeTransferCount(raw.loadout?.dependencies) ?? 0,
        skillNames: safeStringList(raw.loadout?.skillNames, 24),
        mcpNames: safeStringList(raw.loadout?.mcpNames, 24),
        toolNames: safeStringList(raw.loadout?.toolNames, 24),
        commandNames: safeStringList(raw.loadout?.commandNames, 24),
        hookNames: safeStringList(raw.loadout?.hookNames, 24),
        pluginNames: safeStringList(raw.loadout?.pluginNames, 24),
        memoryGraphNames: safeStringList(raw.loadout?.memoryGraphNames, 24),
        dependencyNames: safeStringList(raw.loadout?.dependencyNames, 24),
      },
      capabilityTruth: boundedArray(raw.capabilityTruth, LIVE_CAPABILITY_KINDS.length).flatMap((record) => {
        if (!record || typeof record !== "object") return [];
        const kind = LIVE_CAPABILITY_KINDS.includes(record.kind) ? record.kind : null;
        if (!kind) return [];
        const plannedNames = safeStringList(record.plannedNames, 24);
        const actualNames = safeStringList(record.actualNames, 24);
        const downgradedNames = uniqueCapabilityNames([...plannedNames, ...actualNames]);
        if (!downgradedNames.length) return [];
        return [{
          kind,
          state: "planned",
          plannedNames: downgradedNames,
          actualNames: [],
        }];
      }),
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
  let runStatus = normalizeStatus(value.run?.status, "in_doubt");
  if (TRUSTED_TERMINAL_STATUSES.has(runStatus)) {
    const matchingWorkerTerminal = sanitizedNodes.some((node) => node.kind === "agent" && node.isMain !== true && node.status === runStatus);
    if (!matchingWorkerTerminal || (runStatus === "completed" && value.run?.completionEvidenceState !== "trusted_terminal")) {
      runStatus = "in_doubt";
    }
  }
  // Reading back a stored projection, so the duplicates here come from whichever
  // build wrote the file rather than from this pass. The fold is the same one both
  // producers use, because a third wording of it is how the two producers came to
  // disagree in the first place.
  const { verified: verifiedLinks, candidates: candidateLinks } = mergeConversationLinkBuckets(
    sanitizeConversationLinks(value.run?.verifiedLinks || value.session?.verifiedLinks),
    sanitizeConversationLinks(value.run?.candidateLinks || value.session?.candidateLinks),
  );
  const conversationLinkState = verifiedLinks.length ? "verified" : candidateLinks.length ? "candidate" : "unlinked";
  const conversationLinkRefusal = conversationLinkRefusalFor(
    conversationLinkState,
    value.run?.conversationLinkRefusal || value.session?.conversationLinkRefusal,
  );
  const primaryLink = verifiedLinks[0] || candidateLinks[0] || null;
  // Derived rather than read back from the stored file. A projection written by an
  // older build carries no discovery block at all, and one written by a newer
  // build may name a reason this build cannot print — both would land on the
  // generic sentence, which is the defect this field exists to remove.
  const sourceRuntime = primaryLink?.sourceRuntime || safeConversationRuntime(value.run?.sourceRuntime);
  const conversationDiscovery = conversationDiscoveryForRuntime(sourceRuntime);
  const run = {
    runId,
    title: safeText(value.run?.title, "Governed run", 120),
    task: safeText(value.run?.task, "Governed execution", 240),
    status: runStatus,
    active: false,
    ...publicDisplay(runStatus, { active: false, structuralOnly }),
    sourceRuntime,
    conversationLinkState,
    conversationDiscovery,
    verifiedLinks,
    candidateLinks,
    ...(conversationLinkRefusal ? { conversationLinkRefusal } : {}),
    ...(primaryLink?.conversationRef ? { conversationRef: primaryLink.conversationRef } : {}),
    ...(primaryLink?.conversationTitle ? { conversationTitle: primaryLink.conversationTitle } : {}),
    executionEvidenceState: structuralOnly ? "structural_planning_only" : "recorded",
    completionEvidenceState: value.run?.completionEvidenceState === "trusted_terminal" ? "trusted_terminal" : "unproven",
    recordOrigin: liveRecordOrigin(value),
    currentStage: normalizeStage(value.run?.currentStage),
    startedAt: safeTimestamp(value.run?.startedAt),
    updatedAt: safeTimestamp(value.run?.updatedAt),
    completedAt: safeTimestamp(value.run?.completedAt),
  };
  // A stored projection is untrusted input: it may name nodes this pass just
  // dropped, and it may claim its wave order was observed. Re-validating against
  // the surviving node ids is what keeps a stale file from drawing a wave for a
  // node that is no longer on screen.
  let scheduling = null;
  try {
    scheduling = sanitizeLiveSchedulingProjection(value.scheduling, {
      knownNodeIds: new Set(sanitizedNodes.map((node) => node.id)),
    });
  } catch {
    scheduling = null;
  }
  return {
    schemaVersion: LIVE_COMPACT_PROJECTION_SCHEMA_VERSION,
    run,
    session: {
      sessionId: publicId("session", runId),
      title: safeText(value.session?.title, run.title, 120),
      status: run.status,
      active: false,
      ...publicDisplay(run.status, { active: false, structuralOnly }),
      sourceRuntime: run.sourceRuntime,
      conversationLinkState,
      conversationDiscovery,
      verifiedLinks,
      candidateLinks,
      ...(conversationLinkRefusal ? { conversationLinkRefusal } : {}),
      ...(run.conversationRef ? { conversationRef: run.conversationRef } : {}),
      ...(run.conversationTitle ? { conversationTitle: run.conversationTitle } : {}),
      recordOrigin: run.recordOrigin,
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
    scheduling,
    declaredPlan: sanitizeDeclaredPlan(value.declaredPlan),
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
  // A durable status record proves that a run exists and how far it got. When it
  // also declares worker task packets or lifecycle records, a graph derived from
  // those declarations is honest, because every node traces back to something the
  // record actually says. When it declares nothing, building a projection out of
  // it used to mint one synthetic root node per artifact-less run, so all 994
  // measured activation-only runs read as one-agent sessions that had already
  // lost confidence in themselves.
  if (!projection && selectedDurable) {
    if (runSubstance(selectedDurable).substanceClass === "activation_only") {
      return durableOnlySnapshot(selectedDurable, {
        observedAt: safeObservedAt,
        stale: !durableFresh,
        active: durableActive,
      });
    }
    try {
      projection = buildLiveCompactProjection(selectedDurable);
    } catch {
      projection = null;
    }
  }
  if (!projection?.run) {
    return selectedDurable
      ? durableOnlySnapshot(selectedDurable, {
          observedAt: safeObservedAt,
          stale: !durableFresh,
          active: durableActive,
        })
      : emptySnapshot(safeObservedAt);
  }

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
  const runActive = Boolean(sameRunDurable && durableActive);
  const structuralOnly = projection.run.executionEvidenceState === "structural_planning_only";
  run.active = runActive;
  Object.assign(run, publicDisplay(run.status, { active: runActive, structuralOnly }));
  // Substance rides on every snapshot path, not only the artifact-less one, so a
  // reader never has to work out which path produced the record it is holding.
  const substance = runSubstance(selectedDurable || {}, {
    artifactPresent: Boolean(compatibleArtifact),
    eventCount: projection.replay?.length || 0,
  });
  run.substanceClass = substance.substanceClass;

  const nodes = boundedArray(projection.nodes, LIVE_MAX_NODES).map((node) => ({
    ...node,
    active: runActive && normalizeStatus(node.status) === "active",
    ...publicDisplay(node.status, { active: runActive, structuralOnly }),
  }));
  const session = projection.session ? {
    ...projection.session,
    status: run.status,
    active: runActive,
    ...publicDisplay(run.status, { active: runActive, structuralOnly }),
  } : null;
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
  // The public read model bounds nodes again, so wave membership is re-checked
  // against the nodes that actually reach the page rather than the ones the
  // projection started with.
  let scheduling = null;
  try {
    scheduling = sanitizeLiveSchedulingProjection(projection.scheduling, {
      knownNodeIds: new Set(nodes.map((node) => node.id)),
    });
  } catch {
    scheduling = null;
  }
  return {
    schemaVersion: LIVE_SNAPSHOT_SCHEMA_VERSION,
    source: sourceEnvelope(kind, safeObservedAt, stale),
    run,
    session,
    nodes,
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
    scheduling,
    declaredPlan: sanitizeDeclaredPlan(projection.declaredPlan),
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
    graphAvailability: {
      state: nodes.length > 0 ? "graph_available" : "no_graph_evidence",
      reason: nodes.length > 0 ? null : LIVE_GRAPH_AVAILABILITY_REASONS.artifactDeclaredNoNodes,
      substanceClass: substance.substanceClass,
      substanceSource: "derived_with_artifact_evidence",
      substanceSignals: substance.substanceSignals,
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
  // A run the catalog listed from `runs/<runId>/status.json` has a durable record
  // even when it is neither the active run nor artifact-backed. Reading that file
  // is what keeps the two endpoints from disagreeing about whether the run exists.
  const readRunStatus = async (runId) => {
    try {
      return typeof repository.readRunStatus === "function" ? await repository.readRunStatus(runId) : null;
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
        : await readRunStatus(requestedRunId);
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
