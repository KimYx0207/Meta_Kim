import { open, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { getProcessStartIdentity, lockOwnerAppearsLive } from "../../../scripts/release-state-hardening.mjs";
import { canonicalDigest } from "../../domain/shared/canonical-digest.mjs";
import {
  validateLiveContinuationCommand,
} from "../../domain/live/live-continuation-command.mjs";
import {
  resolveLiveProjectRoot,
  sanitizeLiveProfile,
} from "./live-read-repository.mjs";

export const LIVE_CONTINUATION_COMMAND_STORE_SCHEMA_VERSION =
  "meta-kim-live-continuation-command-store-v1";
export const LIVE_CONTINUATION_COMMAND_LOG_FILE = "continuation-commands.jsonl";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const MAX_RECORDS = 16_384;
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const LOCK_SCHEMA_VERSION = "meta-kim-live-continuation-lock-v1";
const LOCK_OWNER_FILE = "owner.json";

function fail(message, code = "LIVE_CONTINUATION_STORE_ERROR") {
  const error = new Error(`Live continuation command store: ${message}`);
  error.code = code;
  throw error;
}

function isInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeProfile(profile) {
  if (!PROFILE_PATTERN.test(profile)) fail("profile is unsafe", "LIVE_CONTINUATION_STORE_PATH_UNSAFE");
  return profile;
}

function assertCandidatePath(root, candidate) {
  const stateRoot = path.join(path.resolve(root), ".meta-kim");
  const target = path.resolve(candidate);
  if (!isInside(stateRoot, target) || path.extname(target).toLowerCase() !== ".jsonl") {
    fail("command log path must remain inside .meta-kim and use .jsonl", "LIVE_CONTINUATION_STORE_PATH_UNSAFE");
  }
  return target;
}

async function assertNoSymlinkComponents(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!isInside(resolvedRoot, resolvedTarget)) fail("command path escapes project root", "LIVE_CONTINUATION_STORE_PATH_UNSAFE");
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) fail("symbolic-link command path is refused", "LIVE_CONTINUATION_STORE_PATH_UNSAFE");
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      // A missing directory/file is safe to create after all existing
      // components have passed the symlink check.
    }
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function recordCore(record) {
  return {
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    previousRecordDigest: record.previousRecordDigest,
    appendedAtMs: record.appendedAtMs,
    command: record.command,
  };
}

function recordDigest(record) {
  return canonicalDigest(recordCore(record));
}

function validateRecord(raw, expectedRevision, previousDigest) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("command log record is not an object", "LIVE_CONTINUATION_STORE_CORRUPT");
  if (raw.schemaVersion !== LIVE_CONTINUATION_COMMAND_STORE_SCHEMA_VERSION) fail("command log schema is unsupported", "LIVE_CONTINUATION_STORE_CORRUPT");
  if (!Number.isSafeInteger(raw.revision) || raw.revision !== expectedRevision) fail("command log revision is not contiguous", "LIVE_CONTINUATION_STORE_CORRUPT");
  if (raw.previousRecordDigest !== previousDigest) fail("command log hash chain is broken", "LIVE_CONTINUATION_STORE_CORRUPT");
  if (!Number.isSafeInteger(raw.appendedAtMs) || raw.appendedAtMs < 0) fail("command log timestamp is invalid", "LIVE_CONTINUATION_STORE_CORRUPT");
  const command = validateLiveContinuationCommand(raw.command);
  if (raw.recordDigest !== recordDigest({ ...raw, command })) fail("command log record digest is invalid", "LIVE_CONTINUATION_STORE_CORRUPT");
  return deepFreeze({
    schemaVersion: LIVE_CONTINUATION_COMMAND_STORE_SCHEMA_VERSION,
    revision: raw.revision,
    previousRecordDigest: raw.previousRecordDigest,
    appendedAtMs: raw.appendedAtMs,
    command,
    recordDigest: raw.recordDigest,
  });
}

async function readLog(filePath) {
  let raw;
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_LOG_BYTES) {
      fail("command log file is unsafe", "LIVE_CONTINUATION_STORE_PATH_UNSAFE");
    }
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (!raw.trim()) return [];
  const lines = raw.split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length > MAX_RECORDS) fail("command log exceeds the bounded record count", "LIVE_CONTINUATION_STORE_CORRUPT");
  const records = [];
  let previousDigest = null;
  for (let index = 0; index < lines.length; index += 1) {
    let parsed;
    try {
      parsed = JSON.parse(lines[index]);
    } catch {
      fail(`command log line ${index + 1} is malformed`, "LIVE_CONTINUATION_STORE_CORRUPT");
    }
    const record = validateRecord(parsed, index + 1, previousDigest);
    records.push(record);
    previousDigest = record.recordDigest;
  }
  return records;
}

async function readLockOwner(lockPath) {
  let info;
  try { info = await lstat(lockPath); }
  catch (error) { if (error?.code === "ENOENT") return { exists: false }; throw error; }
  // Legacy empty files and unknown owners remain protected. Elapsed time
  // cannot establish whether another process or machine owns a lock.
  if (!info.isDirectory() || info.isSymbolicLink()) return { exists: true, reason: "lock_owner_unknown" };
  try {
    const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
    const ownerInfo = await lstat(ownerPath);
    if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.size > 4_096) {
      return { exists: true, reason: "lock_owner_unknown" };
    }
    const raw = await readFile(ownerPath, "utf8");
    const owner = JSON.parse(raw);
    if (owner?.schemaVersion !== LOCK_SCHEMA_VERSION || !/^[a-f0-9-]{36}$/u.test(owner.token ?? "") ||
        !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.hostname !== "string" ||
        !owner.hostname || !(owner.processStartIdentity === null || typeof owner.processStartIdentity === "string")) {
      return { exists: true, reason: "lock_owner_unknown" };
    }
    const reason = owner.hostname !== os.hostname() ? "lock_owner_foreign"
      : lockOwnerAppearsLive(owner) ? "lock_owner_active" : "lock_owner_exited";
    return { exists: true, reason, owner, raw, info };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error instanceof SyntaxError) {
      return { exists: true, reason: "lock_owner_unknown" };
    }
    throw error;
  }
}

async function preserveExitedLock(lockPath, observed) {
  const current = await readLockOwner(lockPath);
  if (current.reason !== "lock_owner_exited" || current.raw !== observed.raw ||
      current.info.ino !== observed.info.ino || current.info.dev !== observed.info.dev) return false;
  const retainedPath = `${lockPath}.exited-${observed.owner.token}`;
  try { await lstat(retainedPath); return false; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  try {
    // Retain the nonempty directory under this exact owner's token. Competing
    // recoverers cannot replace it, so a delayed observer cannot move a newer
    // writer's lock after the first recovery has succeeded.
    await rename(lockPath, retainedPath);
    return true;
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY", "ENOTDIR", "EPERM"].includes(error?.code)) return false;
    throw error;
  }
}

async function acquireLock(lockPath, timeoutMs = 5_000) {
  const token = randomUUID();
  const pendingPath = `${lockPath}.${token}.tmp`;
  const owner = { schemaVersion: LOCK_SCHEMA_VERSION, token, pid: process.pid,
    hostname: os.hostname(), processStartIdentity: getProcessStartIdentity(process.pid) };
  let acquired = false;
  try {
    // Publish a complete nonempty lock directory atomically. A process crash
    // before publication leaves only its private temporary directory.
    await mkdir(pendingPath, { mode: 0o700 });
    const handle = await open(path.join(pendingPath, LOCK_OWNER_FILE), "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(owner)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    const started = Date.now();
    while (true) {
      const observed = await readLockOwner(lockPath);
      if (!observed.exists) {
        try { await rename(pendingPath, lockPath); acquired = true; }
        catch (error) { if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EPERM"].includes(error?.code)) throw error; }
        if (acquired) return async () => {
          const current = await readLockOwner(lockPath);
          if (current.owner?.token === token && current.owner.pid === process.pid && current.owner.hostname === owner.hostname) {
            await rm(lockPath, { recursive: true });
          }
        };
      } else if (observed.reason === "lock_owner_exited" && await preserveExitedLock(lockPath, observed)) {
        continue;
      }
      if (Date.now() - started >= timeoutMs) {
        const error = new Error("Live continuation command store: command log CAS lock timed out; inspect the recorded owner before retrying");
        error.code = "LIVE_CONTINUATION_STORE_CAS_BUSY";
        error.recovery = {
          reason: observed.reason ?? "lock_acquisition_raced",
          nextAction: observed.reason === "lock_owner_active"
            ? "Wait for the recorded writer to finish, then retry the same command."
            : "Inspect the retained lock and its owning host. Preserve unknown owners; remove a legacy lock only after independently confirming its writer has stopped.",
        };
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    if (!acquired) await rm(pendingPath, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Create the project-local append-only command log. Every mutation is
 * serialized through a lock and committed by temp-file + rename. The public
 * methods never expose the raw file contents or grant execution authority.
 */
export function createLiveContinuationCommandStore({
  projectRoot,
  cwd = process.cwd(),
  env = process.env,
  profile = "default",
  filePath,
  clock = () => Date.now(),
  lockTimeoutMs = 5_000,
} = {}) {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) {
    fail("an explicit projectRoot is required", "LIVE_CONTINUATION_STORE_PROJECT_ROOT_REQUIRED");
  }
  const rootCandidate = path.resolve(projectRoot);
  const normalizedProfile = sanitizeLiveProfile(profile);
  if (normalizedProfile !== profile || !PROFILE_PATTERN.test(normalizedProfile)) {
    fail("profile is unsafe", "LIVE_CONTINUATION_STORE_PATH_UNSAFE");
  }
  const defaultPath = path.join(
    rootCandidate,
    ".meta-kim",
    "state",
    normalizedProfile,
    "live",
    LIVE_CONTINUATION_COMMAND_LOG_FILE,
  );
  const targetPath = assertCandidatePath(rootCandidate, filePath ? path.resolve(rootCandidate, filePath) : defaultPath);
  let queue = Promise.resolve();

  const verifyRoot = async () => {
    const resolved = await resolveLiveProjectRoot({ cwd, projectRoot: rootCandidate, env });
    if (!resolved || path.resolve(resolved) !== rootCandidate) {
      fail("project root is not a trusted marker-backed root", "LIVE_CONTINUATION_STORE_PROJECT_ROOT_UNTRUSTED");
    }
    await assertNoSymlinkComponents(rootCandidate, path.join(rootCandidate, ".meta-kim"));
    await assertNoSymlinkComponents(rootCandidate, path.dirname(targetPath));
  };

  const withWriteLock = (operation) => {
    const next = queue.then(async () => {
      await verifyRoot();
      const directory = path.dirname(targetPath);
      await mkdir(directory, { recursive: true });
      await assertNoSymlinkComponents(rootCandidate, directory);
      const lockPath = `${targetPath}.lock`;
      const releaseLock = await acquireLock(lockPath, lockTimeoutMs);
      try {
        return await operation();
      } finally {
        await releaseLock().catch(() => {});
      }
    });
    queue = next.catch(() => {});
    return next;
  };

  const list = async () => {
    await verifyRoot();
    return readLog(targetPath);
  };

  const append = (input, options = {}) => withWriteLock(async () => {
    const nowMs = Number(clock());
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("clock must return a non-negative epoch millisecond value");
    const command = validateLiveContinuationCommand(input, { nowMs });
    if (command.expiresAtMs <= nowMs) {
      fail("expired command cannot be persisted", "LIVE_CONTINUATION_COMMAND_EXPIRED");
    }
    const records = await readLog(targetPath);
    const nonce = records.find((record) => record.command.nonce === command.nonce);
    if (nonce) fail(`nonce ${command.nonce} has already been used`, "LIVE_CONTINUATION_STORE_NONCE_REPLAY");
    const commandId = records.find((record) => record.command.commandId === command.commandId);
    if (commandId) fail(`commandId ${command.commandId} has already been used`, "LIVE_CONTINUATION_STORE_COMMAND_REPLAY");
    const latestBinding = records
      .filter((record) => record.command.runId === command.runId && record.command.nodeId === command.nodeId)
      .at(-1);
    if (latestBinding && command.expectedRevision <= latestBinding.command.expectedRevision) {
      fail("command expected revision is stale for its run/node binding", "LIVE_CONTINUATION_STORE_CAS_MISMATCH");
    }
    const expectedStoreRevision = options.expectedRevision ?? options.expectedStoreRevision;
    const headRevision = records.at(-1)?.revision ?? 0;
    if (expectedStoreRevision !== undefined && expectedStoreRevision !== headRevision) {
      fail(`compare-and-set expected revision ${expectedStoreRevision}, found ${headRevision}`, "LIVE_CONTINUATION_STORE_CAS_MISMATCH");
    }
    const record = {
      schemaVersion: LIVE_CONTINUATION_COMMAND_STORE_SCHEMA_VERSION,
      revision: headRevision + 1,
      previousRecordDigest: records.at(-1)?.recordDigest ?? null,
      appendedAtMs: nowMs,
      command,
    };
    const committed = { ...record, recordDigest: recordDigest(record) };
    const text = `${records.map((item) => JSON.stringify(item)).join("\n")}${records.length ? "\n" : ""}${JSON.stringify(committed)}\n`;
    const tempPath = `${targetPath}.${process.pid}.${os.threadId ?? 0}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(tempPath, targetPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    return validateRecord(committed, committed.revision, committed.previousRecordDigest);
  });

  return Object.freeze({
    schemaVersion: LIVE_CONTINUATION_COMMAND_STORE_SCHEMA_VERSION,
    projectRoot: rootCandidate,
    profile: normalizedProfile,
    filePath: targetPath,
    list,
    read: list,
    append,
    appendCommand: append,
    compareAndAppend(command, expectedRevision) {
      return append(command, { expectedRevision });
    },
    async findByNonce(nonce) {
      const records = await list();
      return records.find((record) => record.command.nonce === nonce) ?? null;
    },
    async head() {
      const records = await list();
      return records.at(-1) ?? null;
    },
  });
}

export const openLiveContinuationCommandStore = createLiveContinuationCommandStore;
