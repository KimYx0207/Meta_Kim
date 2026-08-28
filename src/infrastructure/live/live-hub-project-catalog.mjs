import { lstat, realpath, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildProjectRef,
  getProjectRegistryPaths,
  listJoinedProjectRegistryEntries,
} from "../../../scripts/project-registry.mjs";
import {
  LIVE_MAX_JSON_BYTES,
  isLiveRunId,
  safeReadJson,
  sanitizeLiveProfile,
} from "./live-read-repository.mjs";

export const LIVE_HUB_MAX_PROJECTS = 128;
export const LIVE_HUB_MAX_SESSIONS = 256;

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
const SECRET_PATTERN = /(?:api[_-]?key|access[_-]?token|auth(?:entication)?|bearer|credential|password|passphrase|private[_ -]?key|secret|token)\s*[:=]|\b(?:gh[pousr]_|github_pat_|AKIA|ASIA)[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/iu;
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|(?:^|\s)\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)/u;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/gu;

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
  if (!text || SECRET_PATTERN.test(text) || ABSOLUTE_PATH_PATTERN.test(text)) return fallback;
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
    record?.completedAt,
    record?.deactivatedAt,
    record?.startedAt,
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

async function safeDirectoryEntries(directory) {
  const info = await pathInfo(directory);
  if (!info?.isDirectory() || info.isSymbolicLink()) return [];
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function publicSummaryTitle(artifact, runId) {
  const summary = artifact?.summaryPacket;
  const candidates = [
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

function sessionFromRecords(runId, records) {
  const ordered = records
    .filter(Boolean)
    .sort((left, right) => String(recordTimestamp(right) || "").localeCompare(String(recordTimestamp(left) || "")));
  const source = ordered[0] || {};
  const artifact = records.find((record) => record?.__catalogKind === "artifact") || null;
  const rawStatus = source.lifecycleStatus || source.status || (source.active === true ? "active" : source.active === false ? "session_stopped" : null);
  const status = normalizeStatus(rawStatus);
  return {
    sessionId: runId,
    runId,
    title: publicSummaryTitle(artifact, runId),
    status,
    currentStage: normalizeStage(source.currentStageKey || source.currentStage || source.stage),
    runtime: normalizeRuntime(source.runtimeFamily || source.runtime),
    updatedAt: recordTimestamp(source),
    active: source.active === true || status === "active",
  };
}

async function readCatalogRecord(projectRoot, targetPath, expectedRunId, catalogKind, maxJsonBytes) {
  const result = await safeReadJson(projectRoot, targetPath, { maxBytes: maxJsonBytes });
  if (result.status !== "valid" || sourceRunId(result.value) !== expectedRunId) return null;
  if (catalogKind === "artifact" && !isGovernedArtifact(result.value)) return null;
  if (catalogKind === "status" && !isDurableStatus(result.value)) return null;
  return { ...result.value, __catalogKind: catalogKind };
}

async function listSessionsForProject(project, { profile, maxSessions, maxJsonBytes }) {
  const stateRoot = path.join(project.repoRoot, ".meta-kim", "state", profile);
  const recordsByRun = new Map();
  const append = (runId, record) => {
    if (!record) return;
    const current = recordsByRun.get(runId) || [];
    current.push(record);
    recordsByRun.set(runId, current);
  };

  const executionDir = path.join(stateRoot, "governed-executions");
  const executionEntries = (await safeDirectoryEntries(executionDir))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({ entry, runId: entry.name.slice(0, -5) }))
    .filter(({ runId }) => isLiveRunId(runId))
    // Run ids are time-bearing in normal governed execution. Descending order
    // keeps the bounded read biased toward recent sessions without stat-ing or
    // parsing an unbounded number of files.
    .sort((left, right) => right.runId.localeCompare(left.runId))
    .slice(0, maxSessions);
  for (const { entry, runId } of executionEntries) {
    const record = await readCatalogRecord(
      project.repoRoot,
      path.join(executionDir, entry.name),
      runId,
      "artifact",
      maxJsonBytes,
    );
    append(runId, record);
  }

  const runDir = path.join(stateRoot, "runs");
  const runEntries = (await safeDirectoryEntries(runDir))
    .filter((entry) => entry.isDirectory() && isLiveRunId(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(0, maxSessions);
  for (const entry of runEntries) {
    const runId = entry.name;
    for (const [fileName, kind] of [
      ["status.json", "status"],
      ["artifact.json", "artifact"],
      ["run.json", "artifact"],
      ["report.json", "artifact"],
    ]) {
      const record = await readCatalogRecord(
        project.repoRoot,
        path.join(runDir, runId, fileName),
        runId,
        kind,
        maxJsonBytes,
      );
      if (record) append(runId, record);
    }
  }

  return [...recordsByRun.entries()]
    .map(([runId, records]) => sessionFromRecords(runId, records))
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")) || left.runId.localeCompare(right.runId))
    .slice(0, maxSessions);
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
  const listJoinedProjects = options.listJoinedProjects || listJoinedProjectRegistryEntries;

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
    return listSessionsForProject(project, { profile, maxSessions, maxJsonBytes });
  };

  const listProjects = async () => {
    const projects = await validatedProjects();
    const output = [];
    for (const project of projects) {
      const sessions = await listSessionsForProject(project, { profile, maxSessions, maxJsonBytes });
      const activeSession = sessions.find((session) => session.active) || null;
      output.push({
        projectRef: project.projectRef,
        displayName: project.displayName,
        updatedAt: newestTimestamp(project.updatedAt, sessions[0]?.updatedAt),
        status: activeSession ? "active" : sessions.length > 0 ? "idle" : "empty",
        sessionCount: sessions.length,
        activeSessionId: activeSession?.sessionId || null,
        sessions,
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
