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

export const LIVE_SNAPSHOT_SCHEMA_VERSION = "meta-kim-live-snapshot-v1";
export const LIVE_REPLAY_SCHEMA_VERSION = "meta-kim-live-replay-v1";
export const LIVE_STALE_AFTER_MS = 10 * 60 * 1000;
export const LIVE_MAX_NODES = 128;
export const LIVE_MAX_EDGES = 256;
export const LIVE_MAX_EVIDENCE = 256;
export const LIVE_MAX_REPLAY = 512;
export const LIVE_MAX_STRING = 240;

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
  "in_doubt",
]);

const SECRET_PATTERN = /(?:api[_-]?key|access[_-]?token|auth(?:entication)?|bearer|credential|password|passphrase|private[_ -]?key|secret|token)\s*[:=]|\b(?:gh[pousr]_|github_pat_|AKIA|ASIA)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/iu;
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|(?:^|\s)\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/gu;

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
  if (SECRET_PATTERN.test(text) || /-----BEGIN [A-Z ]+KEY-----/u.test(text) || /\bsk-[A-Za-z0-9_-]{8,}\b/u.test(text)) {
    return "redacted";
  }
  if (ABSOLUTE_PATH_PATTERN.test(text)) return "[path omitted]";
  // Relative source paths, prompt fragments, and shell-like strings do not
  // carry useful control-room meaning and can accidentally expose internals.
  if (/(?:^|\s)(?:\.\.?[\\/]|src[\\/]|tests?[\\/]|node_modules[\\/])/iu.test(text)) {
    return "[path omitted]";
  }
  text = text.replace(/[<>]/gu, "").replace(/\s+/gu, " ");
  return text.slice(0, max);
}

function safeId(value, fallback = "in_doubt", prefix = "") {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(text) || SECRET_PATTERN.test(text)) return fallback;
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
  return observed - updated > staleAfterMs;
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
  const artifactRunId = normalizeLiveRunId(artifact?.runId);

  // Never merge different runs. When the records disagree, select the fresher
  // authority instead of allowing an old active-run projection to hide a newer
  // governed artifact.
  let selectedDurable = durable;
  let compatibleArtifact = artifact;
  if (durableRunId && artifactRunId && durableRunId !== artifactRunId) {
    const durableActive = durable?.active === true || normalizeStatus(firstString(durable, ["lifecycleStatus", "status"])) === "active";
    if (!durableActive || recordTime(artifact) >= recordTime(durable)) selectedDurable = null;
    else compatibleArtifact = null;
  }
  const sourceRecord = selectedDurable || compatibleArtifact;
  if (!sourceRecord) return emptySnapshot(safeObservedAt);

  const updatedAt = updatedAtFor(sourceRecord);
  const stale = isStale(updatedAt, safeObservedAt, staleAfterMs);
  const run = normalizeRun(selectedDurable, compatibleArtifact, stale);
  if (!run) return emptySnapshot(safeObservedAt);

  const nodes = [
    ...(selectedDurable ? STAGES.map((stage) => nodeFromStage(stage, selectedDurable, compatibleArtifact, stale)) : []),
    ...(!selectedDurable && compatibleArtifact ? artifactStageNodes(compatibleArtifact, stale) : []),
    ...workerNodes(compatibleArtifact, stale),
  ].slice(0, LIVE_MAX_NODES);
  const evidence = buildEvidence(selectedDurable, compatibleArtifact, stale, nodes);
  const replay = buildReplay(compatibleArtifact, selectedDurable, safeObservedAt, stale, nodes);
  const kind = selectedDurable ? "durable_status" : "governed_artifact";
  return {
    schemaVersion: LIVE_SNAPSHOT_SCHEMA_VERSION,
    source: sourceEnvelope(kind, safeObservedAt, stale),
    run,
    nodes,
    edges: buildEdges(compatibleArtifact, nodes),
    evidence,
    replay,
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
    const artifact = buildLiveShareArtifact({ snapshot, replay });
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
