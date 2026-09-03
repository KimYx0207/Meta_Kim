import { lstat, opendir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildProjectRef,
  getProjectRegistryPaths,
  listJoinedProjectRegistryEntries,
} from "../../../scripts/project-registry.mjs";
import {
  compareSelectionRows,
  loadLiveDefaultSelectionPolicy,
  sessionSelectionRow,
} from "../../application/live/live-default-selection.mjs";
import { buildLiveCompactProjection } from "../../application/live/live-control-room-service.mjs";
import {
  conversationDiscoveryForRuntime,
  conversationLinkPlacementForRun,
  conversationLinkRecordView,
  conversationLinkRefusalFor,
  conversationMatchBasisFor,
  conversationRuntimeFamily,
  declaredLinkPlacementForRun,
  mergeConversationLinkBuckets,
  recordConversationRuntime,
} from "../../application/live/live-conversation-link-vocabulary.mjs";
import { loadLiveRunRetentionPolicy } from "../../application/live/live-run-retention.mjs";
import { liveRecordOrigin } from "../../application/live/live-record-origin.mjs";
import { runSubstance, runWorkerCount } from "../../application/live/live-run-substance.mjs";
import { planSessionVisibility } from "../../application/live/live-run-visibility.mjs";
import {
  liveTerminalStatusDisplay,
  normalizeLiveStatus,
} from "../../application/live/live-status-vocabulary.mjs";
import {
  LIVE_MAX_COMPACT_JSON_BYTES,
  LIVE_MAX_JSON_BYTES,
  isLiveRunId,
  safeReadJson,
  sanitizeLiveProfile,
} from "./live-read-repository.mjs";

export const LIVE_HUB_MAX_PROJECTS = 128;
export const LIVE_HUB_MAX_SESSIONS = 256;
export const LIVE_HUB_ACTIVE_FRESHNESS_MS = 10 * 60 * 1000;
export const LIVE_HUB_MAX_NODE_COUNT = 128;
export const LIVE_HUB_MAX_EVENT_COUNT = 512;
export const LIVE_HUB_DISCOVERY_OPERATIONS_PER_SESSION = 24;
export const LIVE_HUB_SOURCE_READS_PER_SESSION = 8;

const LIVE_HUB_CANDIDATE_RUNS_PER_SESSION = 2;

const PROJECT_REF_PATTERN = /^project-[a-f0-9]{12}$/u;
const STAGES = new Set([
  "critical",
  "fetch",
  "thinking",
  "execution",
  "review",
  "meta-review",
  "verification",
  "evolution",
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

function positiveBound(value, hardMaximum) {
  if (!Number.isSafeInteger(value) || value <= 0) return hardMaximum;
  return Math.min(value, hardMaximum);
}

function safeTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safePublicText(value, { fallback = null, max = 120 } = {}) {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  let text = String(value).replace(CONTROL_PATTERN, " ").trim();
  if (
    !text ||
    containsSecret(text) ||
    ABSOLUTE_PATH_PATTERN.test(text) ||
    HOME_OR_FILE_URI_PATTERN.test(text)
  ) return fallback;
  text = text.replace(/<[^>]*>/gu, " ").replace(/[<>]/gu, " ").replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function normalizeStatus(value) {
  return normalizeLiveStatus(value);
}

function normalizeStage(value) {
  if (typeof value !== "string") return "in_doubt";
  const normalized = value.trim().toLowerCase().replace(/[ _]+/gu, "-");
  return STAGES.has(normalized) ? normalized : "in_doubt";
}

function normalizeRuntime(value) {
  if (typeof value !== "string") return "in_doubt";
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,39}$/u.test(normalized) ? normalized : "in_doubt";
}

/**
 * This surface owns which outcomes it is allowed to reach — `completed` needs
 * independent evidence here, and `active` needs a fresh record — but not how each
 * outcome is worded. The wording comes from the shared vocabulary so the detail
 * panel cannot describe the same stored status differently.
 */
function publicDisplay(status, { active = false, structuralOnly = false, completionProven = false } = {}) {
  const normalized = normalizeStatus(status);
  if (structuralOnly) {
    return { displayState: "unreported", statusReason: "这是结构规划记录，不是执行证据；尚未发现可信任务回报。" };
  }
  const terminal = normalized === "completed" && !completionProven
    ? null
    : liveTerminalStatusDisplay(normalized);
  if (terminal) return { ...terminal };
  if (normalized === "active" && active) return { displayState: "active", statusReason: "运行当前仍处于活动状态。" };
  if (normalized === "pending" && active) {
    return { displayState: "queued", statusReason: "运行仍在进行，该任务等待执行或等待可信回报。" };
  }
  if (["pending", "session_stopped", "archived", "active"].includes(normalized)) {
    return { displayState: "unreported", statusReason: "运行当前不活跃，尚未发现该任务的可信执行回报。" };
  }
  return { displayState: "unknown", statusReason: "现有记录不足以判断该任务是否执行或完成。" };
}

function recordTimestampWithBasis(record) {
  const recorded = [
    record?.updatedAt,
    record?.run?.updatedAt,
    record?.session?.updatedAt,
    record?.completedAt,
    record?.run?.completedAt,
    record?.deactivatedAt,
    record?.startedAt,
    record?.run?.startedAt,
    record?.createdAt,
    record?.triggeredAt,
  ];
  for (const candidate of recorded) {
    const timestamp = safeTimestamp(candidate);
    if (timestamp) return { timestamp, basis: "recorded" };
  }
  // Last resort: a governed artifact may state no time at all, and 19 of the 44
  // records in one profile were exactly that. Its own write time still dates it —
  // measured 40ms from the artifact's deepest `producedAt` claim — and reading it
  // last means a record that does claim a time always wins. The basis travels with
  // it because this branch is the majority on the surface that matters: of the 37
  // rows the panel published for this repo's own project, 22 landed here. A file
  // rewritten today would otherwise make a June run claim it was just touched.
  const observed = safeTimestamp(record?.__catalogObservedAt);
  if (observed) return { timestamp: observed, basis: "record_file_write_time" };
  return { timestamp: null, basis: null };
}

function recordTimestamp(record) {
  return recordTimestampWithBasis(record).timestamp;
}

// Deliberately not `recordTimestamp`: that chain falls through to completion,
// deactivation, and finally the record file's own write time, so it always
// returns something. A start instant is a provenance claim — 21 of 95 sessions
// in the measured profile state none, and inventing one for them would be
// indistinguishable from a recorded one.
function recordStartedAt(record) {
  for (const candidate of [record?.startedAt, record?.run?.startedAt, record?.session?.startedAt]) {
    const timestamp = safeTimestamp(candidate);
    if (timestamp) return timestamp;
  }
  return null;
}

function newestTimestamp(...values) {
  return values
    .map(safeTimestamp)
    .filter(Boolean)
    .sort((left, right) => right.localeCompare(left))[0] || null;
}

async function pathInfo(targetPath) {
  try {
    return await lstat(targetPath);
  } catch {
    return null;
  }
}

function comparablePath(value) {
  const normalized = path.resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function validateProjectEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (!PROJECT_REF_PATTERN.test(entry.projectRef || "") || typeof entry.repoRoot !== "string") return null;
  const requestedRoot = path.resolve(entry.repoRoot);
  if (buildProjectRef({ repoPath: requestedRoot }) !== entry.projectRef) return null;

  const rootInfo = await pathInfo(requestedRoot);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return null;
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(requestedRoot);
  } catch {
    return null;
  }
  if (comparablePath(requestedRoot) !== comparablePath(canonicalRoot)) return null;

  let markerFound = false;
  for (const markerName of [".meta-kim", ".git"]) {
    const markerInfo = await pathInfo(path.join(canonicalRoot, markerName));
    if (markerInfo && !markerInfo.isSymbolicLink()) {
      markerFound = true;
      break;
    }
  }
  if (!markerFound) return null;

  return {
    projectRef: entry.projectRef,
    repoRoot: canonicalRoot,
    displayName: safePublicText(entry.displayName, {
      fallback: `Project ${entry.projectRef.slice(-6)}`,
      max: 80,
    }),
    updatedAt: safeTimestamp(entry.updatedAt),
  };
}

function genericRunTitle(value) {
  const title = String(value || "").trim();
  return !title || /^(?:run\s+[a-z0-9-]{6,}|active governed run|governed task|live execution|observed execution)$/iu.test(title);
}

function conversationRef(value) {
  const ref = safePublicText(value, { max: 160 });
  return ref && /^[a-z0-9][a-z0-9:._-]{3,159}$/iu.test(ref) ? ref : null;
}

function conversationLink(value, matchBasis) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ref = conversationRef(value.conversationRef || value.conversationId || value.threadId ||
    value.sessionId || value.composerId || value.sessionKey);
  if (!ref) return null;
  const title = safePublicText(value.conversationTitle || value.title, { max: 120 });
  return {
    sourceRuntime: conversationRuntimeFamily(value.sourceRuntime || value.runtime || value.provider),
    conversationRef: ref,
    matchBasis: safePublicText(matchBasis, { fallback: "metadata_candidate", max: 64 }),
    ...(title && !genericRunTitle(title) ? { conversationTitle: title } : {}),
    ...(safeTimestamp(value.updatedAt || value.timestamp) ? { updatedAt: safeTimestamp(value.updatedAt || value.timestamp) } : {}),
  };
}

function publicConversationIdentity(artifact, expectedRunId = null) {
  const source = artifact?.sourceConversation && typeof artifact.sourceConversation === "object"
    ? artifact.sourceConversation
    : {};
  const conversation = artifact?.conversation && typeof artifact.conversation === "object"
    ? artifact.conversation
    : {};
  const sourceRuntime = recordConversationRuntime(artifact);
  const refCandidates = [
    source.conversationId,
    source.threadId,
    source.sessionId,
    source.composerId,
    source.sessionKey,
    conversation.conversationId,
    conversation.threadId,
    conversation.sessionId,
    conversation.composerId,
    conversation.sessionKey,
    artifact?.run?.conversationId,
    artifact?.session?.conversationId,
    artifact?.threadId,
  ];
  let directConversationRef = null;
  for (const candidate of refCandidates) {
    const value = conversationRef(candidate);
    if (value) {
      directConversationRef = value;
      break;
    }
  }
  const title = safePublicText(source.title || conversation.title, { max: 120 });
  const verifiedLinks = [];
  const candidateLinks = [];
  // The record may already carry a basis stronger than anything read here can
  // establish. Restating a literal at each branch is how the session list and the
  // run panel ended up naming different provenance for one file on disk, so the
  // array and the basis come from one call.
  const placement = conversationLinkPlacementForRun(source, expectedRunId);
  const direct = directConversationRef ? {
    sourceRuntime,
    conversationRef: directConversationRef,
    matchBasis: conversationMatchBasisFor(source.matchBasis, placement.derivedBasis),
    ...(title && !genericRunTitle(title) ? { conversationTitle: title } : {}),
  } : null;
  if (direct) (placement.proven ? verifiedLinks : candidateLinks).push(direct);
  // Both arrays arrive already folded across every record and every alias a
  // producer uses, so this reads two names rather than four. A second alias list
  // here is how the compact projection's own names went unread.
  for (const record of Array.isArray(artifact?.conversationLinks) ? artifact.conversationLinks : []) {
    const entry = declaredLinkPlacementForRun(record, expectedRunId);
    const link = conversationLink(record, conversationMatchBasisFor(record?.matchBasis, entry.derivedBasis));
    if (link) (entry.proven ? verifiedLinks : candidateLinks).push(link);
  }
  for (const record of Array.isArray(artifact?.conversationCandidates) ? artifact.conversationCandidates : []) {
    const link = conversationLink(record, conversationMatchBasisFor(record?.matchBasis, "title_time_project_similarity"));
    if (link) candidateLinks.push(link);
  }
  // One record can name one chat twice, and this pass reads those names in its own
  // order while the run panel reads them in another. Resolving duplicates by which
  // arrived first is what let one file read `verified` here and `candidate` there,
  // so the fold is the one both surfaces call.
  const { verified, candidates } = mergeConversationLinkBuckets(verifiedLinks, candidateLinks);
  const primary = verified[0] || candidates[0] || null;
  const conversationLinkState = verified.length ? "verified" : candidates.length ? "candidate" : "unlinked";
  // The hook records why a binding was refused. Without carrying it, every
  // unlinked run reads the same, and "no chat id was ever saved" sends a reader
  // somewhere completely different than "the transcript file is gone".
  const refusal = conversationLinkRefusalFor(conversationLinkState, artifact?.conversationLinkRefusal);
  return {
    sourceRuntime: primary?.sourceRuntime || sourceRuntime,
    conversationLinkState,
    verifiedLinks: verified.slice(0, 16),
    candidateLinks: candidates.slice(0, 16),
    ...(refusal ? { conversationLinkRefusal: refusal } : {}),
    ...(primary?.conversationRef ? { conversationRef: primary.conversationRef } : {}),
    ...(primary?.conversationTitle ? { conversationTitle: primary.conversationTitle } : {}),
  };
}

function publicSummaryIdentity(artifact, runId) {
  const conversationIdentity = publicConversationIdentity(artifact, runId);
  const { conversationRef, conversationTitle } = conversationIdentity;
  const summary = artifact?.summaryPacket;
  const candidates = [
    [conversationTitle, "conversation_title"],
    [artifact?.run?.title, "run_title"],
    [artifact?.session?.title, "session_title"],
    [summary?.title, "summary_title"],
    // The user's own request sentence identifies a run better than any prose the
    // run generated about itself, so it outranks summary fragments. It is the only
    // title 19 archived artifacts in one profile had, and it stays subject to the
    // same redaction as every other candidate.
    [artifact?.task, "request_task"],
    [artifact?.requestRecord?.task, "request_task"],
    [artifact?.coreLoop?.requestRecord?.task, "request_task"],
    [Array.isArray(summary?.visibleLines) ? summary.visibleLines[0] : null, "summary_line"],
    [summary?.nextStep, "summary_next_step"],
    [artifact?.publicSummary?.title, "public_summary_title"],
  ];
  for (const [candidate, titleSource] of candidates) {
    const title = safePublicText(candidate, { max: 120 });
    if (title && !genericRunTitle(title)) {
      return {
        title,
        titleSource,
        identificationState: conversationIdentity.conversationLinkState === "verified" ? "conversation_verified" : "descriptive",
        ...conversationIdentity,
      };
    }
  }
  return {
    title: `Run ${runId.slice(-8).toUpperCase()}`,
    titleSource: "generated_run_id",
    identificationState: conversationIdentity.conversationLinkState === "verified" ? "conversation_verified" : "unlinked",
    ...conversationIdentity,
  };
}

/**
 * Artifact identity, not conversation ownership. Its callers ask whether a file
 * on disk is the record for a run they already named — line 851 rejects an
 * artifact whose stored `runId` disagrees with the file it was loaded as — so
 * widening it with the conversation reader's alias keys would let a file whose
 * name disagrees with its own contents pass identity.
 *
 * `discoverRunBoundConversations` also reads a `sourceConversation` through this
 * and is deliberately left here: its test is positive — the run ids must match
 * before it emits a `verified: true` link — so a narrower key list can only lose
 * a link, never manufacture a confirmed one. The one shape it would newly match,
 * a conversation reference naming its run through `governedRunId`, has no
 * producer: both writers of that key put it in a delivery-bundle lifecycle
 * record and a clean-room acceptance result, neither of which is a chat
 * reference.
 */
function sourceRunId(record) {
  return typeof record?.runId === "string"
    ? record.runId
    : typeof record?.run?.runId === "string"
      ? record.run.runId
      : null;
}

function isGovernedArtifact(record) {
  return Boolean(
    record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      (record.schemaVersion ||
        record.status ||
        record.workerTaskPackets ||
        record.coreLoop ||
        record.verificationPacket),
  );
}

function isCompactLiveProjection(record) {
  return Boolean(
    record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      record.schemaVersion === "meta-kim-live-projection-v2" &&
      sourceRunId(record) &&
      record.run &&
      typeof record.run === "object" &&
      !Array.isArray(record.run) &&
      Array.isArray(record.nodes) &&
      record.nodes.length <= LIVE_HUB_MAX_NODE_COUNT &&
      Array.isArray(record.replay) &&
      record.replay.length <= LIVE_HUB_MAX_EVENT_COUNT,
  );
}

function isDurableStatus(record) {
  return Boolean(
    record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      (record.currentStage ||
        record.currentStageKey ||
        record.lifecycleStatus ||
        record.status ||
        record.active !== undefined),
  );
}

function safeRecordCount(record, key) {
  const value = record?.[key];
  return Array.isArray(value) ? value.length : null;
}

/**
 * A row's node and event counts describe the graph the page draws, and that graph
 * is the compact projection. A compact record already is one, so it is read
 * directly; a schema-version-1 artifact is not, and reading `nodes`/`replay` off
 * its top level measures a shape it never has — the stage graph lives under
 * `langGraphRunPacket`, the timeline under `agUiStageEvents`, and the projection
 * derives worker nodes from the roster on top of both. Counting the projection
 * rather than the raw keys is what keeps the number in the row and the number of
 * things drawn from being two different measurements.
 *
 * Projection is affordable here because the artifact has already been parsed to
 * reach this point: the parse dominates, so no cache is warranted.
 *
 * A projection that comes back with no nodes is not a measured empty run. The
 * builder anchors the graph on the worker roster, so an artifact carrying a real
 * stage graph and no roster also projects to nothing — reporting zero there would
 * claim a run drew nothing while its stage graph sat in the file being read. An
 * empty projection is therefore treated as unread, the same as one that throws:
 * the directory holds files that are not run artifacts, and projecting one throws.
 * Either way it costs that record its counts and nothing else, since an escaping
 * throw would blank every row in the project over one unrelated neighbour.
 */
function projectedGraphCounts(artifact) {
  if (!artifact) return { nodeCount: null, eventCount: null };
  if (artifact.__catalogKind === "compact") {
    return {
      nodeCount: safeRecordCount(artifact, "nodes"),
      eventCount: safeRecordCount(artifact, "replay"),
    };
  }
  try {
    const projection = buildLiveCompactProjection(artifact);
    const nodeCount = safeRecordCount(projection, "nodes");
    if (!nodeCount) return { nodeCount: null, eventCount: null };
    return { nodeCount, eventCount: safeRecordCount(projection, "replay") };
  } catch {
    return { nodeCount: null, eventCount: null };
  }
}

/**
 * Counts are read off the governed artifact and its compact projection, so a
 * refusal to read one of those is what explains a row with no counts. A per-run
 * status file refused for its size leaves the row without counts too, but saying
 * the artifact was past the cap for a run that never wrote one trades one wrong
 * statement for another.
 */
function refusalExplainsMissingCounts(kind) {
  return kind === "artifact" || kind === "compact";
}

/**
 * Availability is decided per field, not per record. Worker, node and event
 * counts come from independent sources, and a record can yield one without the
 * others: an artifact whose projection cannot be built still declares its worker
 * roster. Collapsing the whole record to `unavailable` because one part is
 * unreadable made 16 of 44 rows print "no worker report" while their worker
 * roster sat in the file being read.
 *
 * An unmeasured zero and a measured zero still look identical to a reader while
 * meaning opposite things, so a count that genuinely cannot be read stays absent.
 * A projected zero is not that case: it is the graph the page draws.
 */
function sessionCountsAvailability(artifact, counts, { unreadableArtifact = false } = {}) {
  if (!artifact) {
    // "Nobody wrote one" and "one exists and is too large to read" are opposite
    // facts about a run, and a reader given the first for the second concludes a
    // run that produced megabytes of governance output produced nothing.
    return unreadableArtifact
      ? { state: "unavailable", reason: "governed_artifact_over_read_cap" }
      : { state: "unavailable", reason: "no_governed_artifact_for_run" };
  }
  const measured = counts.filter((count) => count !== null).length;
  if (measured === 0) return { state: "unavailable", reason: "artifact_declares_no_collections" };
  if (measured < counts.length) {
    return { state: "partial", reason: "artifact_declares_some_collections" };
  }
  return { state: "measured", reason: "governed_artifact_collections" };
}

/**
 * Substance is a floor, so one signal anywhere in a run's record set is enough.
 * The returned signals are the ones that carried the classification, which keeps
 * the reason a run counts as substantive inspectable instead of asserted.
 */
function sessionSubstance(records, extra) {
  const evaluated = records.map((record) => runSubstance(record, extra));
  return (
    evaluated.find((entry) => entry.substanceClass === "substantive") ||
    evaluated[0] ||
    runSubstance(null, extra)
  );
}

function recordStatus(record) {
  return record?.lifecycleStatus || record?.status || record?.run?.status || record?.session?.status ||
    (record?.active === true ? "active" : record?.active === false ? "session_stopped" : null);
}

/**
 * Where each spine stage stamps itself on a governed artifact, in spine order.
 * A run states its reach by which of these packets it wrote, so the deepest one
 * present is the stage it actually reached.
 */
const STAGE_PACKET_KEYS = [
  ["critical", "intentPacket"],
  ["fetch", "fetchPacket"],
  ["thinking", "thinkingPacket"],
  ["execution", "executionResult"],
  ["review", "reviewPacket"],
  ["meta-review", "metaReviewPacket"],
  ["verification", "verificationResult"],
  ["evolution", "evolutionWritebackDecision"],
];

function packetStage(record) {
  let deepest = null;
  for (const [stage, key] of STAGE_PACKET_KEYS) {
    const packet = record?.[key] ?? record?.coreLoop?.[key];
    if (packet && typeof packet === "object" && !Array.isArray(packet)) deepest = stage;
  }
  return deepest;
}

/**
 * A declared stage always wins; the packet fallback speaks only for the records
 * that declare none. Twenty-two of twenty-five artifacts in one profile stated no
 * top-level stage while stamping every packet they wrote, so the rows read
 * "stage unconfirmed" about runs that had recorded exactly how far they got.
 */
function recordStage(record) {
  return record?.currentStageKey || record?.currentStage || record?.stage || record?.run?.currentStage ||
    packetStage(record);
}

/**
 * The runtime context on the request record is the only self-declared producer in
 * a governed artifact. Runtime names elsewhere are capability and gate listings —
 * nineteen files in one profile name all four runtimes — so they cannot attribute.
 */
function recordRuntime(record) {
  return record?.runtimeFamily || record?.runtime || record?.run?.runtime ||
    record?.requestRecord?.runtimeContext?.runtimeFamily ||
    record?.coreLoop?.requestRecord?.runtimeContext?.runtimeFamily;
}

function structuralOnlyRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record?.run?.executionEvidenceState === "structural_planning_only") return true;
  if (record?.executionResult?.actualWorkerExecution === false) return true;
  if (/planned_not_executed/iu.test(String(record?.executionResult?.executionClosure || ""))) return true;
  const results = [
    ...(Array.isArray(record.workerResultPackets) ? record.workerResultPackets : []),
    ...(Array.isArray(record.nodes) ? record.nodes.filter((node) => node?.kind === "agent" && node?.isMain !== true) : []),
  ];
  return results.length > 0 && results.every((result) =>
    /planned_not_executed/iu.test(String(result?.status || result?.resultKind || "")) ||
    String(result?.evidenceKind || "").toLowerCase().includes("structural") ||
    (Array.isArray(result?.workerExecutionEvidence) && result.workerExecutionEvidence.some((item) =>
      item?.observedResult === "not_run_by_structural_artifact_builder" ||
      String(item?.evidenceKind || "").toLowerCase().includes("structural"))));
}

function terminalEvidencePassed(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  if (String(item?.evidenceKind || "").toLowerCase().includes("structural")) return false;
  if (/^not_run_by_/u.test(String(item?.observedResult || "").toLowerCase())) return false;
  return normalizeStatus(item.status || item.result || item.closeState) === "completed" ||
    ["verified", "verified_closed"].includes(String(item.status || item.result || item.closeState || "").toLowerCase());
}

function sameRunEvidence(item, runId) {
  const explicit = sourceRunId(item);
  return !explicit || explicit === runId;
}

function recordCompletionProven(record, runId) {
  if (!record || typeof record !== "object" || structuralOnlyRecord(record)) return false;
  if (record?.run?.completionEvidenceState === "trusted_terminal" && sourceRunId(record) === runId) return true;
  const verification = record?.verificationPacket;
  return [verification?.verificationResults, verification?.fixEvidence]
    .filter(Array.isArray)
    .flat()
    .some((item) => terminalEvidencePassed(item) && sameRunEvidence(item, runId));
}

function isFreshActiveRecord(record, nowMs, activeFreshnessMs) {
  const rawStatus = recordStatus(record);
  if (record?.active !== true && normalizeStatus(rawStatus) !== "active") return false;
  const timestamp = recordTimestamp(record);
  if (!timestamp) return false;
  const updatedAtMs = Date.parse(timestamp);
  const ageMs = nowMs - updatedAtMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= activeFreshnessMs;
}

/**
 * A run is presented as a real governed run only when nothing in its record set
 * says otherwise. Taking the first non-default declaration rather than the
 * newest record keeps a later unmarked write — a status file, an activation
 * shell — from quietly restoring a fixture to real-run standing.
 */
function sessionRecordOrigin(records) {
  for (const record of records) {
    const origin = liveRecordOrigin(record);
    if (origin !== "governed_run") return origin;
  }
  return "governed_run";
}

function sessionFromRecords(runId, records, { nowMs, activeFreshnessMs }) {
  const ordered = records
    .filter(Boolean)
    .sort((left, right) => String(recordTimestamp(right) || "").localeCompare(String(recordTimestamp(left) || "")));
  const source = ordered[0] || {};
  const artifact =
    records.find((record) => record?.__catalogKind === "compact") ||
    records.find((record) => record?.__catalogKind === "artifact") ||
    null;
  const rawStatus = recordStatus(source);
  const normalizedStatus = normalizeStatus(rawStatus);
  const active = ordered.some((record) => isFreshActiveRecord(record, nowMs, activeFreshnessMs));
  const completionProven = records.some((record) => recordCompletionProven(record, runId));
  const structuralOnly = records.some(structuralOnlyRecord);
  const status = normalizedStatus === "completed" && !completionProven
    ? "in_doubt"
    : normalizedStatus === "active" && !active
      ? "in_doubt"
      : normalizedStatus;
  const { nodeCount, eventCount } = projectedGraphCounts(artifact);
  const workerCount = artifact ? runWorkerCount(artifact) : null;
  const unreadableArtifact = records.some(
    (record) =>
      record?.__catalogKind === "unreadable"
      && refusalExplainsMissingCounts(record.__catalogUnreadable?.kind),
  );
  const countsAvailability = sessionCountsAvailability(
    artifact,
    [workerCount, nodeCount, eventCount],
    { unreadableArtifact },
  );
  const substance = sessionSubstance(ordered, {
    // An artifact whose existence and size were observed by stat is recorded
    // output, even though its contents were refused. Reporting otherwise would
    // classify the row as an activation receipt, and the visibility policy folds
    // those away — the row would disappear again one layer further down.
    artifactPresent: Boolean(artifact) || unreadableArtifact,
    eventCount: eventCount ?? 0,
  });
  // The activation hook writes the refusal to `active-run.json`, which arrives as
  // a `status` record, while identity is read off the governed artifact. A run
  // with both files would lose every reason the hook recorded without this merge,
  // and a run whose artifact is past the raw read cap has only its compact
  // projection left — which stores the same facts under different names one level
  // down. The shared view is what keeps both from being read at one depth only.
  const linkViews = ordered.map(conversationLinkRecordView);
  const identityRecord = {
    ...(artifact || source),
    sourceConversation: linkViews.find((view) => view.sourceConversation)?.sourceConversation,
    conversationLinkRefusal: linkViews.find((view) => view.conversationLinkRefusal)?.conversationLinkRefusal,
    conversationLinks: linkViews.flatMap((view) => view.conversationLinks),
    conversationCandidates: linkViews.flatMap((view) => view.conversationCandidates),
  };
  const identity = publicSummaryIdentity(identityRecord, runId);
  const runtime = normalizeRuntime(recordRuntime(source));
  // The identity above reads the governed artifact; this reads the freshest
  // record, which is the only place a run that never produced an artifact names
  // its tool. Both go through the shared reader so the session list and the run
  // header cannot name the same run differently.
  const runtimeSource = recordConversationRuntime(source);
  if (identity.sourceRuntime === "unavailable" && runtimeSource !== "unavailable") {
    identity.sourceRuntime = runtimeSource;
  }
  const conversationDiscovery = conversationDiscoveryForRuntime(identity.sourceRuntime);
  const observedTime = recordTimestampWithBasis(source);
  return {
    sessionId: runId,
    runId,
    ...identity,
    recordOrigin: sessionRecordOrigin(ordered),
    status,
    ...publicDisplay(status, { active, structuralOnly, completionProven }),
    currentStage: normalizeStage(recordStage(source)),
    runtime,
    conversationDiscovery,
    updatedAt: observedTime.timestamp,
    // Same chip, same format, two very different claims: a run that reported its
    // own time, versus a record whose only date is when its file was last written.
    // The basis travels with the value so the surface can say which it is.
    ...(observedTime.basis ? { updatedAtBasis: observedTime.basis } : {}),
    ...(recordStartedAt(source) ? { startedAt: recordStartedAt(source) } : {}),
    substanceClass: substance.substanceClass,
    substanceSource: substance.substanceSource,
    substanceSignals: substance.substanceSignals,
    countsAvailability,
    ...(workerCount === null ? {} : { workerCount }),
    ...(nodeCount === null ? {} : { nodeCount }),
    ...(eventCount === null ? {} : { eventCount }),
    active,
  };
}

// This is the production discovery provider.  It deliberately consumes only
// already-read, run-bound metadata from the explicit Meta_Kim project state:
// opaque refs, runtime, title, and timestamp.  It never opens a host's
// conversation store, source files, or message bodies.  A host integration
// may provide additional candidate metadata through the injected provider,
// but injection is an extension point—not the only production route.
function discoverRunBoundConversations({ runIds, recordsByRun }) {
  const discovered = [];
  for (const runId of runIds) {
    for (const record of recordsByRun.get(runId) || []) {
      if (!record || typeof record !== "object") continue;
      const source = record.sourceConversation;
      if (source && sourceRunId(source) === runId) {
        discovered.push({
          runId,
          runtime: source.runtime,
          conversationId: source.conversationId,
          title: source.title,
          updatedAt: source.updatedAt || recordTimestamp(record),
          verified: true,
          // The run id matching is what this pass proved, but the record it read
          // may already carry a stronger basis. Re-deriving every field including
          // this one is why a transcript-verified link arrived downstream as a
          // metadata match.
          matchBasis: conversationMatchBasisFor(source.matchBasis, "exact_run_id"),
        });
      }
    }
  }
  return discovered;
}

function observeBudgetOperation(budget, operation) {
  try {
    budget.observeOperation?.(Object.freeze(operation));
  } catch {
    // Observability must never change catalog behavior.
  }
}

function consumeDiscoveryOperation(budget, operation) {
  if (budget.discoveryRemaining <= 0) {
    budget.truncated = true;
    return false;
  }
  budget.discoveryRemaining -= 1;
  budget.discoveryUsed += 1;
  observeBudgetOperation(budget, { category: "discovery", operation });
  return true;
}

function consumeSourceRead(budget, source) {
  if (budget.sourceRemaining <= 0) {
    budget.truncated = true;
    return false;
  }
  budget.sourceRemaining -= 1;
  budget.sourceUsed += 1;
  try {
    budget.observeSourceRead?.(Object.freeze({
      runId: source.runId,
      kind: source.kind,
      source: source.source,
    }));
  } catch {
    // Observability must never change catalog behavior.
  }
  observeBudgetOperation(budget, {
    category: "source",
    operation: "json_read",
    runId: source.runId,
    kind: source.kind,
    source: source.source,
  });
  return true;
}

function createCatalogBudget(maxSessions, { observeSourceRead, observeDiscoveryOperation }) {
  const discoveryLimit = maxSessions * LIVE_HUB_DISCOVERY_OPERATIONS_PER_SESSION;
  const sourceLimit = maxSessions * LIVE_HUB_SOURCE_READS_PER_SESSION;
  return {
    discoveryLimit,
    discoveryRemaining: discoveryLimit,
    discoveryUsed: 0,
    sourceLimit,
    sourceRemaining: sourceLimit,
    sourceUsed: 0,
    truncated: false,
    observeSourceRead,
    observeOperation: observeDiscoveryOperation,
  };
}

function publicDiscoveryDiagnostic(budget) {
  return Object.freeze({
    complete: !budget.truncated,
    truncated: budget.truncated,
    strategy: "bounded-window",
    discoveryOperations: budget.discoveryUsed,
    discoveryOperationLimit: budget.discoveryLimit,
    sourceReads: budget.sourceUsed,
    sourceReadLimit: budget.sourceLimit,
  });
}

async function budgetedPathInfo(targetPath, budget) {
  if (!consumeDiscoveryOperation(budget, "metadata")) return null;
  return pathInfo(targetPath);
}

async function* boundedDirectoryEntries(directory, budget) {
  const info = await budgetedPathInfo(directory, budget);
  if (!info?.isDirectory() || info.isSymbolicLink()) return;
  if (!consumeDiscoveryOperation(budget, "directory_open")) return;
  let handle;
  try {
    handle = await opendir(directory);
    while (consumeDiscoveryOperation(budget, "directory_entry")) {
      const entry = await handle.read();
      if (!entry) return;
      yield entry;
    }
  } catch {
    return;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The async directory handle may already be closed after exhaustion.
      }
    }
  }
}

async function readCatalogRecord(projectRoot, targetPath, expectedRunId, catalogKind, maxJsonBytes, budget, source) {
  if (!consumeSourceRead(budget, source)) return null;
  const result = await safeReadJson(projectRoot, targetPath, { maxBytes: maxJsonBytes });
  if (result.status !== "valid" || sourceRunId(result.value) !== expectedRunId) return null;
  if (catalogKind === "artifact" && !isGovernedArtifact(result.value)) return null;
  if (catalogKind === "compact" && !isCompactLiveProjection(result.value)) return null;
  if (catalogKind === "status" && !isDurableStatus(result.value)) return null;
  const observedAt = catalogObservedAt(source?.modifiedAtMs);
  return { ...result.value, __catalogKind: catalogKind, ...(observedAt ? { __catalogObservedAt: observedAt } : {}) };
}

/** When the file was last written, for records that carry no time of their own. */
function catalogObservedAt(modifiedAtMs) {
  return Number.isFinite(modifiedAtMs) && modifiedAtMs > 0
    ? new Date(modifiedAtMs).toISOString()
    : null;
}

async function catalogSourceCandidate(targetPath, runId, kind, maxJsonBytes, source, budget) {
  const info = await budgetedPathInfo(targetPath, budget);
  if (!info?.isFile() || info.isSymbolicLink()) return null;
  return {
    targetPath,
    runId,
    kind,
    maxJsonBytes,
    source,
    modifiedAtMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : 0,
    // Carried from the stat this candidate already paid for. `safeReadJson`
    // collapses every refusal into one opaque `unsafe`, so the size that caused
    // it is only recoverable here.
    sizeBytes: Number.isFinite(info.size) ? info.size : 0,
  };
}

function sourcePriority(kind) {
  if (kind === "compact") return 3;
  if (kind === "artifact") return 2;
  return 1;
}

function compareSources(left, right) {
  return sourcePriority(right.kind) - sourcePriority(left.kind) ||
    right.modifiedAtMs - left.modifiedAtMs ||
    left.source.localeCompare(right.source);
}

function selectCandidateRuns(candidates, maxSessions, activeRunId) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.runId) || [];
    group.push(candidate);
    grouped.set(candidate.runId, group);
  }
  return [...grouped.entries()]
    .map(([runId, sources]) => {
      sources.sort(compareSources);
      return {
        runId,
        sources,
        activeRank: Number(runId === activeRunId),
        modifiedAtMs: Math.max(...sources.map((source) => source.modifiedAtMs)),
        committedRank: Math.max(...sources.map((source) => sourcePriority(source.kind))),
      };
    })
    .sort((left, right) =>
      right.activeRank - left.activeRank ||
      right.modifiedAtMs - left.modifiedAtMs ||
      right.committedRank - left.committedRank ||
      left.runId.localeCompare(right.runId))
    .slice(0, maxSessions * LIVE_HUB_CANDIDATE_RUNS_PER_SESSION);
}

async function listSessionsForProject(project, {
  profile,
  maxSessions,
  maxJsonBytes,
  nowMs,
  activeFreshnessMs,
  observeSourceRead,
  observeDiscoveryOperation,
  discoverRuntimeConversations,
  visibilityPolicy,
  selectionPolicy,
}) {
  const stateRoot = path.join(project.repoRoot, ".meta-kim", "state", profile);
  const recordsByRun = new Map();
  const budget = createCatalogBudget(maxSessions, {
    observeSourceRead,
    observeDiscoveryOperation,
  });
  const append = (runId, record) => {
    if (!record) return;
    const current = recordsByRun.get(runId) || [];
    current.push(record);
    recordsByRun.set(runId, current);
  };

  let activeRunId = null;
  const activeRunPath = path.join(stateRoot, "active-run.json");
  if (await catalogSourceCandidate(activeRunPath, "active-run", "status", maxJsonBytes, "active-run", budget)) {
    if (consumeSourceRead(budget, { runId: "active-run", kind: "status", source: "active-run" })) {
      const activeRunResult = await safeReadJson(project.repoRoot, activeRunPath, { maxBytes: maxJsonBytes });
      activeRunId = sourceRunId(activeRunResult.value);
      if (
        activeRunResult.status === "valid" &&
        isLiveRunId(activeRunId) &&
        isDurableStatus(activeRunResult.value)
      ) {
        append(activeRunId, { ...activeRunResult.value, __catalogKind: "status" });
      } else {
        activeRunId = null;
      }
    }
  }

  const candidates = [];
  const executionDir = path.join(stateRoot, "governed-executions");
  for await (const entry of boundedDirectoryEntries(executionDir, budget)) {
    if (!entry.isFile()) continue;
    const compact = entry.name.endsWith(".live.json");
    const raw = entry.name.endsWith(".json") && !compact;
    if (!compact && !raw) continue;
    const runId = compact
      ? entry.name.slice(0, -".live.json".length)
      : entry.name.slice(0, -5);
    if (!isLiveRunId(runId)) continue;
    const candidate = await catalogSourceCandidate(
      path.join(executionDir, entry.name),
      runId,
      compact ? "compact" : "artifact",
      compact ? LIVE_MAX_COMPACT_JSON_BYTES : maxJsonBytes,
      compact ? "governed-compact" : "governed-artifact",
      budget,
    );
    if (candidate) candidates.push(candidate);
  }

  const runDir = path.join(stateRoot, "runs");
  const runSourceKinds = new Map([
    ["status.json", "status"],
    ["artifact.json", "artifact"],
    ["run.json", "artifact"],
    ["report.json", "artifact"],
  ]);
  for await (const entry of boundedDirectoryEntries(runDir, budget)) {
    if (!entry.isDirectory() || !isLiveRunId(entry.name)) continue;
    const runId = entry.name;
    for await (const sourceEntry of boundedDirectoryEntries(path.join(runDir, runId), budget)) {
      const kind = runSourceKinds.get(sourceEntry.name);
      if (!kind || !sourceEntry.isFile()) continue;
      const candidate = await catalogSourceCandidate(
        path.join(runDir, runId, sourceEntry.name),
        runId,
        kind,
        maxJsonBytes,
        `run-${sourceEntry.name.slice(0, -5)}`,
        budget,
      );
      if (candidate) candidates.push(candidate);
    }
  }

  const candidateRuns = selectCandidateRuns(candidates, maxSessions, activeRunId);
  const widestSourceSet = Math.max(0, ...candidateRuns.map((group) => group.sources.length));
  const refusedForSize = new Map();
  for (let sourceIndex = 0; sourceIndex < widestSourceSet && budget.sourceRemaining > 0; sourceIndex += 1) {
    for (const group of candidateRuns) {
      const source = group.sources[sourceIndex];
      if (!source || budget.sourceRemaining <= 0) continue;
      const record = await readCatalogRecord(
        project.repoRoot,
        source.targetPath,
        source.runId,
        source.kind,
        source.maxJsonBytes,
        budget,
        source,
      );
      if (record) {
        append(source.runId, record);
        continue;
      }
      // First refusal wins, and for a run with both files past the cap that is the
      // artifact: this directory is scanned before the per-run directories, and
      // within one directory every artifact-kind filename sorts before
      // `status.json`. The artifact is the file that answers for missing counts, so
      // the ordering matters — a test pins the outcome rather than this line, so
      // changing the scan order fails there instead of silently renaming the file.
      if (source.sizeBytes > source.maxJsonBytes && !refusedForSize.has(source.runId)) {
        refusedForSize.set(source.runId, source);
      }
    }
  }

  // A refused read produced no record, and no record produced no row: a run that
  // wrote a multi-megabyte artifact and a run that never existed became the same
  // absence on the panel. Two runs with rendered deliverables were invisible this
  // way. The cap is a memory guard and stays where it is, so the refusal is
  // published as a row that states why it has no counts instead.
  //
  // Publication is not gated on the run having nothing else readable. Gating it on
  // that put the row back on "nobody wrote an artifact" whenever any other file
  // happened to be readable — and the activation hook writes a per-run status file
  // for every run, so that was the ordinary shape, not an edge case.
  //
  // A refusal beside a readable artifact is harmless rather than suppressed: its
  // record declares no conversation, no worker packets and no status, so it cannot
  // become the row's newest record, its origin, or its identity. The one field it
  // does set — that the artifact went unread — is only consulted when no artifact
  // was readable, which is exactly when it is true.
  for (const [runId, source] of refusedForSize) {
    const readable = recordsByRun.get(runId) || [];
    // The refusal is timestamped by the unread file's write time, which outranks
    // anything a readable record declares in the newest-record sort. Withholding it
    // when another record exists keeps the row's status, stage and time answered by
    // the record that actually states them; a run with nothing else readable has no
    // other answer, so it keeps the write time.
    const observedAt = readable.length > 0 ? null : catalogObservedAt(source.modifiedAtMs);
    append(runId, {
      __catalogKind: "unreadable",
      __catalogUnreadable: {
        kind: source.kind,
        sizeBytes: source.sizeBytes,
        maxBytes: source.maxJsonBytes,
      },
      ...(observedAt ? { __catalogObservedAt: observedAt } : {}),
    });
  }

  if (recordsByRun.size > 0) {
    try {
      const discoveryInput = {
        projectRef: project.projectRef,
        projectRoot: project.repoRoot,
        runIds: [...recordsByRun.keys()],
        recordsByRun,
      };
      const defaultDiscovered = await discoverRunBoundConversations(discoveryInput);
      const injectedDiscovered = typeof discoverRuntimeConversations === "function"
        ? await discoverRuntimeConversations(discoveryInput)
        : [];
      const discovered = [...defaultDiscovered, ...(Array.isArray(injectedDiscovered) ? injectedDiscovered : [])];
      for (const item of Array.isArray(discovered) ? discovered.slice(0, maxSessions * 16) : []) {
        const runId = sourceRunId(item);
        if (!isLiveRunId(runId) || !recordsByRun.has(runId)) continue;
        const verified = item?.verified === true || item?.matchState === "verified" || item?.linkState === "verified";
        // A provider's basis is untrusted input — an injected one is a host
        // integration, and even the built-in one reads a file. Whitelisting it here
        // keeps an unknown value from reaching a reader as a raw enum. The fact at
        // hand is that this item is run-bound: the run id was matched just above.
        // Deriving the weakest basis unconditionally would have clamped the
        // built-in provider's own proven links down to a similarity guess.
        const link = conversationLink(item, conversationMatchBasisFor(
          item?.matchBasis,
          verified ? "exact_run_id" : "title_time_project_similarity",
        ));
        if (!link) continue;
        append(runId, verified
          ? { __catalogKind: "conversation", conversationLinks: [{ ...link, runId, verified: true }] }
          : { __catalogKind: "conversation", conversationCandidates: [{ ...link, runId }] });
      }
    } catch {
      // Runtime history discovery is optional and read-only; a provider failure
      // must not hide the governed-run catalog.
    }
  }

  // Ordering puts runs that have something to show first, then the run the user
  // is watching. Recency alone let a burst of activation-only shells — measured at
  // 77 in a single day on one project — push every run that did work out of the
  // read window, and ranking liveness above substance put a freshly activated
  // shell at the top of a list where 93 of 114 rows had no graph to draw.
  const ranked = [...recordsByRun.entries()]
    .map(([runId, records]) => sessionSelectionRow(
      sessionFromRecords(runId, records, { nowMs, activeFreshnessMs }),
      {
        committedRank: records.some((record) => record?.__catalogKind === "compact")
          ? 2
          : records.some((record) => record?.__catalogKind === "artifact")
            ? 1
            : 0,
      },
    ))
    .sort((left, right) => compareSelectionRows(left, right, selectionPolicy || loadLiveDefaultSelectionPolicy()))
    .map((row) => row.session);

  // Folding stale activation receipts away runs before the read cap, so the cap is
  // spent on sessions the user can act on rather than on receipts. Why a session
  // survived is a read decision, not session data, so it stays out of the payload
  // and only the folded-away count is reported.
  const visibility = planSessionVisibility(
    ranked,
    visibilityPolicy || loadLiveRunRetentionPolicy(),
    { observedAt: new Date(nowMs).toISOString() },
  );
  const visible = visibility.visible.slice(0, maxSessions);
  return {
    sessions: visible.map(({ visibilityReason, ...session }) => session),
    omittedSessionCount: visibility.counts.omitted +
      Math.max(0, visibility.counts.visible - maxSessions),
    discovery: publicDiscoveryDiagnostic(budget),
  };
}

/**
 * Build the read-only Live Hub catalog over the explicit user project registry.
 * Public methods never scan outside registered roots. `resolveProject()` is an
 * internal server boundary and is the only method that returns `repoRoot`.
 */
export function createLiveHubProjectCatalog(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const profile = sanitizeLiveProfile(options.profile);
  const maxProjects = positiveBound(options.maxProjects, LIVE_HUB_MAX_PROJECTS);
  const maxSessions = positiveBound(options.maxSessions, LIVE_HUB_MAX_SESSIONS);
  const maxJsonBytes = positiveBound(options.maxJsonBytes, LIVE_MAX_JSON_BYTES);
  const activeFreshnessMs = positiveBound(
    options.activeFreshnessMs,
    LIVE_HUB_ACTIVE_FRESHNESS_MS,
  );
  const now = typeof options.now === "function" ? options.now : Date.now;
  const listJoinedProjects = options.listJoinedProjects || listJoinedProjectRegistryEntries;
  const observeSourceRead = typeof options.observeSourceRead === "function"
    ? options.observeSourceRead
    : null;
  const observeDiscoveryOperation = typeof options.observeDiscoveryOperation === "function"
    ? options.observeDiscoveryOperation
    : null;
  const discoverRuntimeConversations = options.discoverRuntimeConversations ||
    options.listRuntimeConversations || options.discoverConversations || null;
  const visibilityPolicy = options.visibilityPolicy || loadLiveRunRetentionPolicy();
  const selectionPolicy = options.selectionPolicy || loadLiveDefaultSelectionPolicy();

  const validatedProjects = async () => {
    let entries;
    try {
      // The shared registry helper also supports writers and initializes its
      // database when missing. Live is a read-only observer, so avoid invoking
      // that default helper until its database already exists.
      if (listJoinedProjects === listJoinedProjectRegistryEntries) {
        const { projectRegistryPath } = getProjectRegistryPaths({ homeDir });
        if (!(await pathInfo(projectRegistryPath))?.isFile()) return [];
      }
      entries = await listJoinedProjects({ homeDir });
    } catch {
      return [];
    }
    if (!Array.isArray(entries)) return [];
    const projects = [];
    for (const entry of entries.slice(0, maxProjects)) {
      const project = await validateProjectEntry(entry);
      if (project) projects.push(project);
    }
    return projects;
  };

  const resolveProject = async (projectRef) => {
    if (!PROJECT_REF_PATTERN.test(projectRef || "")) return null;
    const projects = await validatedProjects();
    return projects.find((project) => project.projectRef === projectRef) || null;
  };

  const listSessions = async (projectRef) => {
    const project = await resolveProject(projectRef);
    if (!project) return [];
    const result = await listSessionsForProject(project, {
      profile,
      maxSessions,
      maxJsonBytes,
      nowMs: now(),
      activeFreshnessMs,
      observeSourceRead,
      observeDiscoveryOperation,
      discoverRuntimeConversations,
      visibilityPolicy,
      selectionPolicy,
    });
    return result.sessions;
  };

  const listProjects = async () => {
    const projects = await validatedProjects();
    const output = [];
    for (const project of projects) {
      const { sessions, omittedSessionCount, discovery } = await listSessionsForProject(project, {
        profile,
        maxSessions,
        maxJsonBytes,
        nowMs: now(),
        activeFreshnessMs,
        observeSourceRead,
        observeDiscoveryOperation,
        discoverRuntimeConversations,
        visibilityPolicy,
        selectionPolicy,
      });
      const activeSession = sessions.find((session) => session.active) || null;
      output.push({
        projectRef: project.projectRef,
        displayName: project.displayName,
        updatedAt: newestTimestamp(project.updatedAt, sessions[0]?.updatedAt),
        status: activeSession ? "active" : sessions.length > 0 ? "idle" : "empty",
        sessionCount: sessions.length,
        omittedSessionCount,
        activeSessionId: activeSession?.sessionId || null,
        sessions,
        ...(discovery.truncated ? { sessionDiscovery: discovery } : {}),
      });
    }
    return output;
  };

  return {
    profile,
    listProjects,
    resolveProject,
    listSessions,
  };
}
