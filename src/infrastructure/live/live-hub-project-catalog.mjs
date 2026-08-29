import { lstat, opendir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildProjectRef,
  getProjectRegistryPaths,
  listJoinedProjectRegistryEntries,
} from "../../../scripts/project-registry.mjs";
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
const STATUSES = new Set([
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
  if (typeof value !== "string") return "in_doubt";
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, "_");
  const aliased = STATUS_ALIASES.get(normalized) || normalized;
  return STATUSES.has(aliased) ? aliased : "in_doubt";
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

function recordTimestamp(record) {
  const candidates = [
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
  for (const candidate of candidates) {
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

function publicSummaryTitle(artifact, runId) {
  const summary = artifact?.summaryPacket;
  const candidates = [
    artifact?.run?.title,
    artifact?.session?.title,
    summary?.title,
    Array.isArray(summary?.visibleLines) ? summary.visibleLines[0] : null,
    summary?.nextStep,
    artifact?.publicSummary?.title,
  ];
  for (const candidate of candidates) {
    const title = safePublicText(candidate, { max: 120 });
    if (title) return title;
  }
  return `Run ${runId.slice(-8).toUpperCase()}`;
}

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

function recordStatus(record) {
  return record?.lifecycleStatus || record?.status || record?.run?.status || record?.session?.status ||
    (record?.active === true ? "active" : record?.active === false ? "session_stopped" : null);
}

function recordStage(record) {
  return record?.currentStageKey || record?.currentStage || record?.stage || record?.run?.currentStage;
}

function recordRuntime(record) {
  return record?.runtimeFamily || record?.runtime || record?.run?.runtime;
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
  const active = isFreshActiveRecord(source, nowMs, activeFreshnessMs);
  const status = normalizedStatus === "active" && !active ? "in_doubt" : normalizedStatus;
  const nodeCount = safeRecordCount(artifact, "nodes");
  const eventCount = safeRecordCount(artifact, "replay");
  return {
    sessionId: runId,
    runId,
    title: publicSummaryTitle(artifact, runId),
    status,
    currentStage: normalizeStage(recordStage(source)),
    runtime: normalizeRuntime(recordRuntime(source)),
    updatedAt: recordTimestamp(source),
    ...(nodeCount === null ? {} : { nodeCount }),
    ...(eventCount === null ? {} : { eventCount }),
    active,
  };
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
  return { ...result.value, __catalogKind: catalogKind };
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
      append(source.runId, record);
    }
  }

  const sessions = [...recordsByRun.entries()]
    .map(([runId, records]) => ({
      session: sessionFromRecords(runId, records, { nowMs, activeFreshnessMs }),
      committedRank: records.some((record) => record?.__catalogKind === "compact")
        ? 2
        : records.some((record) => record?.__catalogKind === "artifact")
          ? 1
          : 0,
    }))
    .sort((left, right) =>
      Number(right.session.active) - Number(left.session.active) ||
      String(right.session.updatedAt || "").localeCompare(String(left.session.updatedAt || "")) ||
      right.committedRank - left.committedRank ||
      left.session.runId.localeCompare(right.session.runId))
    .slice(0, maxSessions)
    .map(({ session }) => session);
  return { sessions, discovery: publicDiscoveryDiagnostic(budget) };
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
    });
    return result.sessions;
  };

  const listProjects = async () => {
    const projects = await validatedProjects();
    const output = [];
    for (const project of projects) {
      const { sessions, discovery } = await listSessionsForProject(project, {
        profile,
        maxSessions,
        maxJsonBytes,
        nowMs: now(),
        activeFreshnessMs,
        observeSourceRead,
        observeDiscoveryOperation,
      });
      const activeSession = sessions.find((session) => session.active) || null;
      output.push({
        projectRef: project.projectRef,
        displayName: project.displayName,
        updatedAt: newestTimestamp(project.updatedAt, sessions[0]?.updatedAt),
        status: activeSession ? "active" : sessions.length > 0 ? "idle" : "empty",
        sessionCount: sessions.length,
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
