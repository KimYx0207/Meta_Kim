import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { observeCodexJsonl } from "./observe-host-events.mjs";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const SESSION_META_READ_LIMIT_BYTES = 64 * 1024;
const MTIME_TOLERANCE_MS = 5_000;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

class CodexSessionEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "CodexSessionEvidenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new CodexSessionEvidenceError(code);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function isInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function assertPlainDirectory(directoryPath, invalidCode, symlinkCode) {
  const stats = await fs.lstat(directoryPath).catch(() => null);
  if (stats?.isSymbolicLink()) fail(symlinkCode);
  if (!stats?.isDirectory()) fail(invalidCode);
  const realPath = await fs.realpath(directoryPath).catch(() => null);
  if (!realPath) fail(invalidCode);
  return realPath;
}

async function listSessionFiles(sessionsRoot) {
  const files = [];
  const pending = [sessionsRoot];
  while (pending.length > 0) {
    const directoryPath = pending.pop();
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.resolve(directoryPath, entry.name);
      if (!isInside(sessionsRoot, entryPath)) fail("codex_session_path_escape");
      const stats = await fs.lstat(entryPath);
      if (stats.isSymbolicLink()) fail("codex_session_symlink_rejected");
      if (stats.isDirectory()) {
        pending.push(entryPath);
      } else if (stats.isFile() && entry.name.endsWith(".jsonl")) {
        files.push({ filePath: entryPath, stats });
      }
    }
  }
  return files;
}

async function readSessionMeta(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(SESSION_META_READ_LIMIT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = prefix.indexOf("\n");
    if (newlineIndex < 0 && bytesRead === buffer.length) {
      return null;
    }
    const firstLine = (newlineIndex >= 0 ? prefix.slice(0, newlineIndex) : prefix).trim();
    if (!firstLine) return null;
    const record = JSON.parse(firstLine);
    return record?.type === "session_meta" ? record.payload ?? null : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function isFresh(stats, sinceMs) {
  return stats.mtimeMs + MTIME_TOLERANCE_MS >= sinceMs;
}

async function readBoundedFile(file, maxBytes, sizeCode) {
  if (file.stats.size > maxBytes) fail(sizeCode);
  const realPath = await fs.realpath(file.filePath).catch(() => null);
  if (!realPath || realPath !== file.filePath) fail("codex_session_symlink_rejected");
  const handle = await fs.open(file.filePath, "r");
  try {
    const currentStats = await handle.stat();
    if (!currentStats.isFile() || currentStats.size > maxBytes) fail(sizeCode);
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text, "utf8") > maxBytes) fail(sizeCode);
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * Recovers host events from the exact Codex exec session named by a
 * `thread.started` event. The returned session text is internal-only input for
 * the existing host observer; callers must expose only the digest/category/ids.
 *
 * @param {{
 *   codexHome?: string,
 *   threadId: string,
 *   sinceMs: number,
 *   maxBytes?: number,
 * }} options
 */
export async function readCodexSessionEvidence({
  codexHome,
  threadId,
  sinceMs,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  if (!THREAD_ID_PATTERN.test(String(threadId ?? ""))) {
    fail("codex_session_thread_id_invalid");
  }
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) {
    fail("codex_session_since_invalid");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    fail("codex_session_max_bytes_invalid");
  }

  const configuredHome = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  if (!path.isAbsolute(configuredHome)) fail("codex_home_must_be_absolute");
  const absoluteHome = path.resolve(configuredHome);
  const realHome = await assertPlainDirectory(
    absoluteHome,
    "codex_home_invalid",
    "codex_home_symlink_rejected",
  );
  if (realHome !== absoluteHome) fail("codex_home_symlink_rejected");

  const sessionsPath = path.resolve(absoluteHome, "sessions");
  if (!isInside(absoluteHome, sessionsPath)) fail("codex_session_path_escape");
  const sessionsRoot = await assertPlainDirectory(
    sessionsPath,
    "codex_sessions_invalid",
    "codex_sessions_symlink_rejected",
  );
  if (!isInside(realHome, sessionsRoot) || sessionsRoot !== sessionsPath) {
    fail("codex_sessions_symlink_rejected");
  }

  const files = await listSessionFiles(sessionsRoot);
  const parentSuffix = `-${threadId}.jsonl`;
  const parentCandidates = [];
  for (const file of files) {
    if (!path.basename(file.filePath).endsWith(parentSuffix)) continue;
    const meta = await readSessionMeta(file.filePath);
    if (
      meta?.id === threadId &&
      meta?.source === "exec" &&
      meta?.originator === "codex_exec"
    ) {
      parentCandidates.push({ ...file, meta });
    }
  }
  if (parentCandidates.length !== 1) fail("codex_parent_session_not_unique");
  const parent = parentCandidates[0];
  if (!isFresh(parent.stats, sinceMs)) fail("codex_parent_session_stale");
  const parentSessionText = await readBoundedFile(
    parent,
    maxBytes,
    "codex_parent_session_too_large",
  );

  const spawnEvents = observeCodexJsonl(parentSessionText).filter(
    (event) =>
      event.family === "agent_subagent" &&
      /(?:^|\.)spawn_agent$/u.test(String(event.hostSurface ?? "")) &&
      event.sessionId === threadId &&
      typeof event.childSessionId === "string" &&
      event.childSessionId.length > 0,
  );
  const spawnChildSessionIds = [
    ...new Set(spawnEvents.map((event) => event.childSessionId)),
  ];
  if (spawnChildSessionIds.length === 0) fail("codex_parent_spawn_event_missing");
  if (spawnChildSessionIds.length !== 1) fail("codex_parent_spawn_event_not_unique");
  const [childSessionId] = spawnChildSessionIds;

  const childCandidates = [];
  const expectedChildCandidates = [];
  for (const file of files) {
    if (file.filePath === parent.filePath || !isFresh(file.stats, sinceMs)) continue;
    const meta = await readSessionMeta(file.filePath);
    if (path.basename(file.filePath).endsWith(`-${childSessionId}.jsonl`)) {
      expectedChildCandidates.push({ ...file, meta });
    }
    if (meta?.source?.subagent?.thread_spawn?.parent_thread_id === threadId) {
      childCandidates.push({ ...file, meta });
    }
  }
  if (childCandidates.length === 0 && expectedChildCandidates.length === 1) {
    fail("codex_child_session_mismatch");
  }
  if (childCandidates.length !== 1) fail("codex_child_session_not_unique");
  const child = childCandidates[0];
  if (
    child.meta?.id !== childSessionId ||
    child.meta?.originator !== "codex_exec" ||
    !path.basename(child.filePath).endsWith(`-${childSessionId}.jsonl`)
  ) {
    fail("codex_child_session_mismatch");
  }
  const childSessionText = await readBoundedFile(
    child,
    maxBytes,
    "codex_child_session_too_large",
  );

  return {
    parentSessionText,
    threadId,
    childSessionId,
    sessionDigest: sha256(parentSessionText),
    childSessionDigest: sha256(childSessionText),
    sourceCategory: "codex_home_sessions",
    cliVersion: parent.meta.cli_version ?? null,
  };
}
