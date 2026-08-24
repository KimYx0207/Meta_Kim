import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * The Live sidecar deliberately has no persistence dependency. This repository
 * is a read-only boundary around the project-local `.meta-kim` tree.
 */

export const LIVE_DEFAULT_PROFILE = "default";
export const LIVE_MAX_JSON_BYTES = 8 * 1024 * 1024;
export const LIVE_RUN_ID_PATTERN = /^meta-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
export const LIVE_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;

function isPathInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function readPathInfo(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    return null;
  }
}

async function markerBackedRoot(candidate) {
  const resolvedCandidate = path.resolve(candidate);
  const info = await readPathInfo(resolvedCandidate);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return null;

  // A project marker is intentionally required. It keeps an accidentally
  // launched sidecar from reading an arbitrary parent such as the user home.
  const markerNames = [".meta-kim", ".git"];
  for (const markerName of markerNames) {
    const marker = path.join(resolvedCandidate, markerName);
    const markerInfo = await readPathInfo(marker);
    if (markerInfo && !markerInfo.isSymbolicLink()) {
      try {
        const canonicalCandidate = await realpath(resolvedCandidate);
        return canonicalCandidate;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function explicitCandidate(value, cwd) {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = value.trim();
  // Explicit CLI values may be relative to the current directory, but the
  // candidate still has to pass marker and symlink checks below.
  return path.resolve(cwd, candidate);
}

/**
 * Resolve the nearest marker-backed project root without trusting arbitrary
 * cwd/environment paths. A missing marker returns null and causes an empty
 * read-only projection.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {string} [options.projectRoot]
 * @param {string} [options.explicitProjectRoot]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<string|null>}
 */
export async function resolveLiveProjectRoot({
  cwd = process.cwd(),
  projectRoot,
  explicitProjectRoot,
  env = process.env,
} = {}) {
  const callerCwd = typeof env?.META_KIM_CALLER_CWD === "string" && path.isAbsolute(env.META_KIM_CALLER_CWD)
    ? env.META_KIM_CALLER_CWD
    : null;
  const start = path.resolve(callerCwd || (typeof cwd === "string" && cwd ? cwd : process.cwd()));
  const requested =
    explicitCandidate(projectRoot, start) ||
    explicitCandidate(explicitProjectRoot, start) ||
    (typeof env?.CLAUDE_PROJECT_DIR === "string" && path.isAbsolute(env.CLAUDE_PROJECT_DIR)
      ? path.resolve(env.CLAUDE_PROJECT_DIR)
      : null);

  if (requested) return markerBackedRoot(requested);

  let current = start;
  while (true) {
    const root = await markerBackedRoot(current);
    if (root) return root;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function sanitizeLiveProfile(value = LIVE_DEFAULT_PROFILE) {
  const profile = typeof value === "string" && value.trim() ? value.trim() : LIVE_DEFAULT_PROFILE;
  return LIVE_PROFILE_PATTERN.test(profile) ? profile : LIVE_DEFAULT_PROFILE;
}

export function isLiveRunId(value) {
  return typeof value === "string" && LIVE_RUN_ID_PATTERN.test(value);
}

export function normalizeLiveRunId(value) {
  return isLiveRunId(value) ? value : null;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestFrom(record) {
  const candidates = [
    record?.sha256,
    record?.sha256Digest,
    record?.artifactSha256,
    record?.jsonSha256,
    record?.digest,
  ];
  return candidates.find((candidate) => typeof candidate === "string" && /^[a-f0-9]{64}$/iu.test(candidate)) || null;
}

function jsonPathFromPointer(pointer, root, executionDir, runId) {
  const requested = typeof pointer?.jsonPath === "string" && pointer.jsonPath.trim()
    ? pointer.jsonPath.trim()
    : null;
  if (requested && path.isAbsolute(requested)) return null;

  const candidate = requested
    ? path.resolve(root, requested)
    : path.join(executionDir, `${runId}.json`);
  if (!isPathInside(executionDir, candidate) || path.extname(candidate).toLowerCase() !== ".json") {
    return null;
  }
  return candidate;
}

function relativeSegments(from, to) {
  const relative = path.relative(path.resolve(from), path.resolve(to));
  if (!isPathInside(from, to) || !relative) return [];
  return relative.split(path.sep).filter(Boolean);
}

/**
 * Read a JSON object only when every path component is a real, in-root file.
 * This function performs no mkdir/write/rename operation.
 */
async function safeReadJson(root, targetPath, { maxBytes = LIVE_MAX_JSON_BYTES } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  const stateRoot = path.join(resolvedRoot, ".meta-kim");
  if (!isPathInside(stateRoot, resolvedTarget)) return { status: "unsafe", value: null };

  const rootInfo = await readPathInfo(resolvedRoot);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return { status: "unsafe", value: null };

  let current = resolvedRoot;
  for (const segment of relativeSegments(resolvedRoot, resolvedTarget).slice(0, -1)) {
    current = path.join(current, segment);
    const info = await readPathInfo(current);
    if (!info?.isDirectory() || info.isSymbolicLink()) return { status: "unsafe", value: null };
  }

  const targetInfo = await readPathInfo(resolvedTarget);
  if (!targetInfo) return { status: "missing", value: null };
  if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.size > maxBytes) {
    return { status: "unsafe", value: null };
  }

  try {
    const canonicalRoot = await realpath(resolvedRoot);
    const canonicalTarget = await realpath(resolvedTarget);
    if (!isPathInside(canonicalRoot, canonicalTarget)) return { status: "unsafe", value: null };
    const raw = await readFile(resolvedTarget, "utf8");
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { status: "unknown", value: null };
    }
    return { status: "valid", value, raw, sha256: digest(raw) };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", value: null };
    return { status: "malformed", value: null };
  }
}

function metadataTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function readRecordRunId(value) {
  return normalizeLiveRunId(value?.runId || value?.run?.runId);
}

function isDurableStatus(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      readRecordRunId(value) &&
      (value.currentStage || value.currentStageKey || value.lifecycleStatus || value.status || value.active !== undefined),
  );
}

function isArtifact(value, expectedRunId = null) {
  const runId = readRecordRunId(value);
  if (!runId || (expectedRunId && runId !== expectedRunId)) return false;
  return Boolean(value?.schemaVersion || value?.status || value?.workerTaskPackets || value?.coreLoop || value?.verificationPacket);
}

function stateDirFor(root, profile) {
  return path.join(root, ".meta-kim", "state", sanitizeLiveProfile(profile));
}

/**
 * @typedef {object} LiveReadRepository
 * @property {string|null} projectRoot
 * @property {string} profile
 * @property {() => Promise<object|null>} readDurableStatus
 * @property {() => Promise<object|null>} readLatestArtifact
 * @property {(runId:string) => Promise<object|null>} readArtifact
 */

/**
 * Create the read-only project-local source adapter used by the Live service.
 * No method in this object mutates the filesystem.
 *
 * @param {object} [options]
 * @returns {LiveReadRepository}
 */
export function createLiveReadRepository(options = {}) {
  const profile = sanitizeLiveProfile(options.profile || options.env?.META_KIM_PROFILE || process.env.META_KIM_PROFILE);
  let projectRootPromise;
  const getProjectRoot = async () => {
    if (!projectRootPromise) {
      projectRootPromise = resolveLiveProjectRoot({
        cwd: options.cwd,
        projectRoot: options.projectRoot,
        explicitProjectRoot: options.explicitProjectRoot,
        env: options.env || process.env,
      });
    }
    return projectRootPromise;
  };

  const readDurableStatus = async () => {
    const root = await getProjectRoot();
    if (!root) return null;
    const stateDir = stateDirFor(root, profile);
    const candidates = [
      path.join(stateDir, "spine", "spine-state.json"),
      path.join(stateDir, "active-run.json"),
    ];
    for (const candidate of candidates) {
      const result = await safeReadJson(root, candidate);
      if (result.status === "valid" && isDurableStatus(result.value)) {
        return {
          ...result.value,
          __sourcePath: candidate,
          __rawSha256: result.sha256,
          __source: "durable_status",
          __updatedAt: metadataTimestamp(
            result.value.updatedAt || result.value.deactivatedAt || result.value.startedAt || result.value.triggeredAt,
          ),
        };
      }
    }

    // Older local runs may retain only a per-run status projection. Read those
    // files as a compatibility source, choosing the newest valid record while
    // keeping the scan bounded and strictly inside `.meta-kim`.
    const runDir = path.join(stateDir, "runs");
    try {
      const entries = await readdir(runDir, { withFileTypes: true });
      const records = [];
      for (const entry of entries.slice(0, 256)) {
        if (!entry.isDirectory() || !LIVE_RUN_ID_PATTERN.test(entry.name)) continue;
        const candidate = path.join(runDir, entry.name, "status.json");
        const result = await safeReadJson(root, candidate);
        if (result.status === "valid" && isDurableStatus(result.value)) {
          records.push({
            value: result.value,
            candidate,
            sha256: result.sha256,
            updatedAt: metadataTimestamp(
              result.value.updatedAt || result.value.deactivatedAt || result.value.startedAt || result.value.triggeredAt,
            ),
          });
        }
      }
      records.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
      const newest = records[0];
      if (newest) {
        return {
          ...newest.value,
          __sourcePath: newest.candidate,
          __rawSha256: newest.sha256,
          __source: "durable_status",
          __updatedAt: newest.updatedAt,
        };
      }
    } catch {
      // A missing runs directory is an ordinary empty-project state.
    }
    return null;
  };

  const readArtifactAt = async (targetPath, expectedRunId, pointer = null) => {
    const root = await getProjectRoot();
    if (!root || !targetPath) return null;
    const result = await safeReadJson(root, targetPath);
    if (result.status !== "valid" || !isArtifact(result.value, expectedRunId)) return null;
    const expectedDigest = digestFrom(pointer);
    if (expectedDigest && expectedDigest !== result.sha256) return null;
    return {
      ...result.value,
      __sourcePath: targetPath,
      __rawSha256: result.sha256,
      __source: "governed_artifact",
      __updatedAt: metadataTimestamp(
        result.value.updatedAt || result.value.completedAt || result.value.startedAt || result.value.createdAt,
      ),
    };
  };

  const readLatestArtifact = async () => {
    const root = await getProjectRoot();
    if (!root) return null;
    const stateDir = stateDirFor(root, profile);
    const executionDir = path.join(stateDir, "governed-executions");
    const latestPath = path.join(executionDir, "latest.json");
    const pointerResult = await safeReadJson(root, latestPath);
    if (pointerResult.status === "valid") {
      const runId = normalizeLiveRunId(pointerResult.value.runId);
      if (!runId) return null;
      const artifactPath = jsonPathFromPointer(pointerResult.value, root, executionDir, runId);
      if (!artifactPath) return null;
      return readArtifactAt(artifactPath, runId, pointerResult.value);
    }

    const durable = await readDurableStatus();
    const runId = normalizeLiveRunId(durable?.runId);
    if (!runId) return null;
    const candidates = [
      path.join(executionDir, `${runId}.json`),
      path.join(stateDir, "runs", runId, "artifact.json"),
      path.join(stateDir, "runs", runId, "run.json"),
      path.join(stateDir, "runs", runId, "report.json"),
      path.join(root, ".meta-kim", "runs", runId, "artifact.json"),
      path.join(root, ".meta-kim", "runs", runId, "run.json"),
    ];
    for (const candidate of candidates) {
      const artifact = await readArtifactAt(candidate, runId);
      if (artifact) return artifact;
    }
    return null;
  };

  const readArtifact = async (runId) => {
    if (!isLiveRunId(runId)) return null;
    const root = await getProjectRoot();
    if (!root) return null;
    const stateDir = stateDirFor(root, profile);
    const executionDir = path.join(stateDir, "governed-executions");
    const candidates = [
      path.join(executionDir, `${runId}.json`),
      path.join(stateDir, "runs", runId, "artifact.json"),
      path.join(stateDir, "runs", runId, "run.json"),
      path.join(stateDir, "runs", runId, "report.json"),
      path.join(root, ".meta-kim", "runs", runId, "artifact.json"),
      path.join(root, ".meta-kim", "runs", runId, "run.json"),
    ];
    for (const candidate of candidates) {
      const direct = await readArtifactAt(candidate, runId);
      if (direct) return direct;
    }
    const latest = await readLatestArtifact();
    return latest?.runId === runId ? latest : null;
  };

  return {
    get projectRoot() {
      return options.projectRoot ? path.resolve(options.projectRoot) : null;
    },
    profile,
    getProjectRoot,
    readDurableStatus,
    readLatestArtifact,
    readArtifact,
  };
}

export { isPathInside, safeReadJson };
