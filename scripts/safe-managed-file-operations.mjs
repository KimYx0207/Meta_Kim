import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { renameWithTransientRetry } from "./transient-rename.mjs";

const HASH_RE = /^[a-f0-9]{64}$/iu;
const JOURNAL_SCHEMA = "meta-kim-managed-file-journal-v1";
const LOCK_SCHEMA = "meta-kim-managed-file-lock-v1";
const RECEIPT_SCHEMA = "meta-kim-managed-file-receipt-v1";

export function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256ManagedFile(filePath) {
  if (!existsSync(filePath)) return null;
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) return null;
  return sha256Buffer(readFileSync(filePath));
}

export function normalizeManagedRelPath(value) {
  const rel = String(value ?? "").replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  if (!rel || rel.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return rel;
}

function isInside(absPath, absRoot) {
  const rel = relative(absRoot, absPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function inspectTrustedPath(trustedRoot, relPath, { allowMissing = false } = {}) {
  const root = resolve(trustedRoot);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return null;
  const rel = normalizeManagedRelPath(relPath);
  if (!rel) return null;
  const target = resolve(root, rel);
  if (!isInside(target, root)) return null;
  const rootReal = realpathSync(root);
  let current = root;
  for (const segment of rel.split("/")) {
    current = join(current, segment);
    if (!existsSync(current)) {
      return allowMissing ? { root, rootReal, rel, target, missingAt: current } : null;
    }
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) return null;
    if (!isInside(realpathSync(current), rootReal)) return null;
  }
  return { root, rootReal, rel, target, realPath: realpathSync(target) };
}

export function validateManagedManifest(manifest, { schemaVersion } = {}) {
  if (!manifest || typeof manifest !== "object") return null;
  if (schemaVersion && manifest.schemaVersion !== schemaVersion) return null;
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) return null;
  const files = [];
  const seen = new Set();
  for (const entry of manifest.files) {
    const relPath = normalizeManagedRelPath(entry?.relPath);
    if (!relPath || seen.has(relPath) || !HASH_RE.test(entry?.contentHash ?? "")) return null;
    seen.add(relPath);
    files.push({ relPath, contentHash: entry.contentHash.toLowerCase() });
  }
  return { ...manifest, files };
}

function ensureSafeDirectory(root, absDir, createdDirs) {
  const rootAbs = resolve(root);
  const target = resolve(absDir);
  if (!isInside(target, rootAbs)) return false;
  const rootReal = realpathSync(rootAbs);
  let current = rootAbs;
  for (const segment of relative(rootAbs, target).split(/[\\/]+/u).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) {
      mkdirSync(current);
      createdDirs.push(current);
    }
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    if (!isInside(realpathSync(current), rootReal)) return false;
  }
  return true;
}

function cleanCreatedDirs(createdDirs) {
  for (const dirPath of [...createdDirs].reverse()) {
    try {
      if (existsSync(dirPath) && readdirSync(dirPath).length === 0) {
        rmdirSync(dirPath);
      }
    } catch {
      // Cleanup is best effort; transaction state remains explicit in the result.
    }
  }
}

function fsyncParentDirectory(filePath) {
  if (process.platform === "win32") return;
  let fd;
  try {
    fd = openSync(dirname(filePath), "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is not available on every filesystem. The file itself is
    // still fsynced; recovery remains fail-closed when directory durability is
    // unsupported by the host.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncFile(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r+");
    fsyncSync(fd);
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EINVAL", "ENOTSUP"].includes(error?.code)
    ) {
      // Windows can reject FlushFileBuffers for readonly/virtualized files even
      // after a byte-for-byte verified copy. Keep recovery hash-bound and treat
      // disk-flush durability as filesystem-dependent instead of failing the
      // otherwise recoverable transaction.
      return false;
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function renameDurable(fromPath, toPath, renameOptions = undefined) {
  // Windows hands out EPERM, EBUSY, and EACCES while a scanner or indexer still
  // holds a handle on a file this transaction is about to move. Those clear on
  // their own within milliseconds, so failing the whole transaction on the first
  // one turns a passing install into a spurious rollback. Every other code stays
  // fail-closed.
  renameWithTransientRetry(fromPath, toPath, renameOptions);
  fsyncParentDirectory(fromPath);
  if (dirname(fromPath) !== dirname(toPath)) fsyncParentDirectory(toPath);
}

function unlinkDurable(filePath) {
  unlinkSync(filePath);
  fsyncParentDirectory(filePath);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeExclusiveJson(filePath, value) {
  const fd = openSync(filePath, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncParentDirectory(filePath);
}

function writeExclusiveBuffer(filePath, value, mode = null) {
  const fd = openSync(filePath, "wx", mode ?? 0o666);
  try {
    writeFileSync(fd, value);
    if (process.platform !== "win32" && mode !== null) fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncParentDirectory(filePath);
}

function portableMode(stats) {
  return process.platform === "win32" ? null : stats.mode & 0o7777;
}

function validPortableMode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0o7777;
}

function safeToken(value, fallback) {
  const token = String(value ?? "").replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "");
  return token || fallback;
}

function transactionPaths(root, lockKey, controlDirRel) {
  const controlRel = normalizeManagedRelPath(controlDirRel ?? ".meta-kim/transactions");
  if (!controlRel) return null;
  const info = inspectTrustedPath(root, controlRel, { allowMissing: true });
  if (!info) return null;
  const key = safeToken(lockKey, "managed-files");
  return {
    controlDir: info.target,
    lockPath: join(info.target, `${key}.lock.json`),
    receiptPath: join(info.target, `${key}.receipt.json`),
    journalPath: join(info.target, `${key}.journal.json`),
    verifiedPath: join(info.target, `${key}.verified.json`),
    key,
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

function acquireTransactionLock(root, paths, createdDirs, nonce) {
  if (!ensureSafeDirectory(root, paths.controlDir, createdDirs)) {
    return { ok: false, status: "blocked", reason: "unsafe_control_directory" };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeExclusiveJson(paths.lockPath, {
        schemaVersion: LOCK_SCHEMA,
        pid: process.pid,
        nonce,
        createdAt: new Date().toISOString(),
      });
      return { ok: true, nonce };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        return { ok: false, status: "blocked", reason: `lock_create_failed:${error.message}` };
      }
      const owner = readJson(paths.lockPath);
      if (owner?.schemaVersion !== LOCK_SCHEMA || processIsAlive(owner.pid) !== false) {
        return {
          ok: false,
          status: "locked",
          reason: owner ? "transaction_in_progress" : "lock_owner_unknown",
          lock: owner,
          nextAction: "Wait for the active installer to finish, then retry. Do not delete an unknown live lock.",
        };
      }
      const stalePath = `${paths.lockPath}.stale-${nonce}`;
      try {
        renameDurable(paths.lockPath, stalePath);
        fsyncParentDirectory(paths.lockPath);
        unlinkDurable(stalePath);
      } catch {
        return {
          ok: false,
          status: "locked",
          reason: "stale_lock_reclaim_raced",
          nextAction: "Another process is recovering this transaction. Retry shortly.",
        };
      }
    }
  }
  return { ok: false, status: "locked", reason: "lock_retry_exhausted" };
}

function releaseTransactionLock(paths, nonce) {
  try {
    const owner = readJson(paths.lockPath);
    if (owner?.nonce === nonce) unlinkDurable(paths.lockPath);
  } catch {
    // Never remove a lock that cannot be proven to belong to this process.
  }
}

function backupEvidence(root, entries) {
  return entries.flatMap((entry) => {
    if (!entry.backupRelPath) return [];
    const info = inspectTrustedPath(root, entry.backupRelPath, { allowMissing: true });
    if (!info || !existsSync(info.target)) return [];
    const backupHash = sha256ManagedFile(info.target);
    if (backupHash !== entry.oldHash) return [];
    return [{
      relPath: entry.relPath,
      backupPath: info.target,
      sourceHash: entry.oldHash,
      backupHash,
    }];
  });
}

function operationPhase(operation, relPath) {
  if (["content", "auxiliary", "manifest"].includes(operation?.phase)) return operation.phase;
  return /(?:^|\/)[^/]*manifest[^/]*\.json$/iu.test(relPath) ? "manifest" : "content";
}

function phaseRank(phase) {
  return phase === "manifest" ? 2 : phase === "auxiliary" ? 1 : 0;
}

function maybeCrash(checkpoint, requested) {
  if (requested === checkpoint) process.exit(91);
}

function removeKnownFile(filePath, expectedHash) {
  if (!existsSync(filePath)) return true;
  if (expectedHash && sha256ManagedFile(filePath) !== expectedHash) return false;
  unlinkDurable(filePath);
  return true;
}

function journalHash(journal) {
  return sha256Buffer(Buffer.from(JSON.stringify(journal)));
}

function receiptForJournal(journal) {
  return {
    schemaVersion: RECEIPT_SCHEMA,
    nonce: journal.nonce,
    trustedRoot: journal.trustedRoot,
    lockKey: journal.lockKey,
    journalHash: journalHash(journal),
    issuedBeforeJournal: true,
  };
}

function validateReceipt(receipt, journal, root, lockKey) {
  return Boolean(
    receipt?.schemaVersion === RECEIPT_SCHEMA &&
    receipt?.issuedBeforeJournal === true &&
    receipt?.nonce === journal?.nonce &&
    receipt?.trustedRoot === root &&
    receipt?.lockKey === lockKey &&
    HASH_RE.test(receipt?.journalHash ?? "") &&
    receipt.journalHash === journalHash(journal)
  );
}

function validateOrphanReceipt(receipt, root, lockKey) {
  return Boolean(
    receipt?.schemaVersion === RECEIPT_SCHEMA &&
    receipt?.issuedBeforeJournal === true &&
    receipt?.trustedRoot === root &&
    receipt?.lockKey === lockKey &&
    /^[a-z0-9._-]+$/iu.test(receipt?.nonce ?? "") &&
    HASH_RE.test(receipt?.journalHash ?? "")
  );
}

function validateJournal(journal, root, lockKey) {
  if (
    journal?.schemaVersion !== JOURNAL_SCHEMA ||
    journal?.lockKey !== lockKey ||
    journal?.trustedRoot !== root ||
    journal?.phase !== "prepared" ||
    !/^[a-z0-9._-]+$/iu.test(journal?.nonce ?? "") ||
    safeToken(journal?.transactionLabel, "") !== journal?.transactionLabel ||
    !normalizeManagedRelPath(journal?.backupBaseRel) ||
    !journal.backupBaseRel.endsWith(`/${journal.transactionLabel}-${journal.nonce}`) ||
    !Array.isArray(journal.entries)
  ) return null;
  for (const entry of journal.entries) {
    if (
      !normalizeManagedRelPath(entry.relPath) ||
      !normalizeManagedRelPath(entry.stageRelPath) ||
      !normalizeManagedRelPath(entry.rollbackRelPath) ||
      (entry.backupRelPath && !normalizeManagedRelPath(entry.backupRelPath)) ||
      !["write", "remove"].includes(entry.kind) ||
      (entry.oldHash && !HASH_RE.test(entry.oldHash)) ||
      (entry.nextHash && !HASH_RE.test(entry.nextHash)) ||
      (entry.oldMode !== null && entry.oldMode !== undefined && !validPortableMode(entry.oldMode)) ||
      (entry.nextMode !== null && entry.nextMode !== undefined && !validPortableMode(entry.nextMode))
    ) return null;
  }
  if (journal.entries.some((entry) => !journalEntryPaths(root, journal, entry))) return null;
  return journal;
}

function journalEntryPaths(root, journal, entry) {
  const paths = {};
  for (const key of ["relPath", "stageRelPath", "rollbackRelPath", "backupRelPath"]) {
    if (!entry[key]) continue;
    const info = inspectTrustedPath(root, entry[key], { allowMissing: true });
    if (!info) return null;
    paths[key] = info.target;
  }
  const target = paths.relPath;
  const token = sha256Buffer(Buffer.from(entry.relPath)).slice(0, 12);
  const expectedStage = join(dirname(target), `.${journal.nonce}-${token}.stage`);
  const expectedRollback = join(dirname(target), `.${journal.nonce}-${token}.rollback`);
  const backupBase = resolve(root, journal.backupBaseRel);
  const expectedBackup = entry.oldHash ? join(backupBase, entry.relPath) : null;
  if (
    paths.stageRelPath !== expectedStage ||
    paths.rollbackRelPath !== expectedRollback ||
    (expectedBackup ? paths.backupRelPath !== expectedBackup : Boolean(paths.backupRelPath))
  ) return null;
  return paths;
}

function recoverPreparedEntry(root, journal, entry) {
  const paths = journalEntryPaths(root, journal, entry);
  if (!paths) return { ok: false, reason: `unsafe_recovery_path:${entry.relPath}` };
  const targetHash = existsSync(paths.relPath) ? sha256ManagedFile(paths.relPath) : null;
  const rollbackHash = existsSync(paths.rollbackRelPath)
    ? sha256ManagedFile(paths.rollbackRelPath)
    : null;
  const backupHash = paths.backupRelPath && existsSync(paths.backupRelPath)
    ? sha256ManagedFile(paths.backupRelPath)
    : null;

  if (rollbackHash) {
    if (rollbackHash !== entry.oldHash) {
      return { ok: false, reason: `rollback_hash_mismatch:${entry.relPath}` };
    }
    if (targetHash === entry.oldHash) {
      unlinkDurable(paths.rollbackRelPath);
    } else if (targetHash === null || targetHash === entry.nextHash) {
      if (targetHash !== null) unlinkDurable(paths.relPath);
      renameDurable(paths.rollbackRelPath, paths.relPath);
    } else {
      return { ok: false, reason: `recovery_target_drift:${entry.relPath}` };
    }
  } else if (entry.oldHash) {
    if (targetHash !== entry.oldHash) {
      if (backupHash !== entry.oldHash || (targetHash !== null && targetHash !== entry.nextHash)) {
        return { ok: false, reason: `recovery_source_missing:${entry.relPath}` };
      }
      const restorePath = `${paths.relPath}.meta-kim-restore`;
      copyFileSync(paths.backupRelPath, restorePath);
      if (process.platform !== "win32" && entry.oldMode !== null && entry.oldMode !== undefined) {
        chmodSync(restorePath, entry.oldMode);
      }
      if (sha256ManagedFile(restorePath) !== entry.oldHash) {
        unlinkDurable(restorePath);
        return { ok: false, reason: `recovery_copy_mismatch:${entry.relPath}` };
      }
      fsyncFile(restorePath);
      fsyncParentDirectory(restorePath);
      if (targetHash !== null) unlinkDurable(paths.relPath);
      renameDurable(restorePath, paths.relPath);
    }
  } else if (targetHash !== null) {
    if (targetHash !== entry.nextHash) {
      return { ok: false, reason: `recovery_created_target_drift:${entry.relPath}` };
    }
    unlinkDurable(paths.relPath);
  }

  if (existsSync(paths.stageRelPath)) {
    if (!removeKnownFile(paths.stageRelPath, entry.nextHash)) {
      return { ok: false, reason: `recovery_stage_drift:${entry.relPath}` };
    }
  }
  const restoredHash = existsSync(paths.relPath) ? sha256ManagedFile(paths.relPath) : null;
  if (restoredHash !== entry.oldHash) {
    return { ok: false, reason: `recovery_verification_failed:${entry.relPath}` };
  }
  if (
    restoredHash !== null &&
    process.platform !== "win32" &&
    entry.oldMode !== null &&
    entry.oldMode !== undefined &&
    portableMode(lstatSync(paths.relPath)) !== entry.oldMode
  ) {
    return { ok: false, reason: `recovery_permission_mismatch:${entry.relPath}` };
  }
  return { ok: true };
}

function clearRecoveredControlFiles(paths, injectCrashAt) {
  if (existsSync(paths.verifiedPath)) unlinkDurable(paths.verifiedPath);
  unlinkDurable(paths.journalPath);
  maybeCrash("after_recovery_journal_cleanup", injectCrashAt);
  unlinkDurable(paths.receiptPath);
}

function recoverExistingJournal(root, paths, injectCrashAt = "") {
  if (!existsSync(paths.journalPath)) {
    if (existsSync(paths.verifiedPath)) {
      return {
        ok: false,
        status: "recovery_required",
        reason: "verified_marker_without_journal",
        nextAction: "Preserve the unexpected marker and inspect the transaction control directory.",
      };
    }
    if (existsSync(paths.receiptPath)) {
      const receipt = readJson(paths.receiptPath);
      if (!validateOrphanReceipt(receipt, root, paths.key)) {
        return {
          ok: false,
          status: "recovery_required",
          reason: "invalid_orphan_transaction_receipt",
          nextAction: "Preserve the unknown receipt and inspect it before retrying.",
        };
      }
      // A receipt is issued before the journal and before any backup, stage, or
      // target mutation. With no journal or verified marker, this is the only
      // orphan state that is safe to clean automatically.
      unlinkDurable(paths.receiptPath);
    }
    return { ok: true, status: "none", backups: [] };
  }
  const journal = validateJournal(readJson(paths.journalPath), root, paths.key);
  if (!journal) {
    return {
      ok: false,
      status: "recovery_required",
      reason: "invalid_transaction_journal",
      journalPath: paths.journalPath,
      nextAction: "Preserve the journal and backups; inspect them before retrying.",
    };
  }
  const receipt = readJson(paths.receiptPath);
  if (!validateReceipt(receipt, journal, root, paths.key)) {
    return {
      ok: false,
      status: "recovery_required",
      reason: "missing_or_invalid_transaction_receipt",
      journalPath: paths.journalPath,
      nextAction: "Preserve the untrusted journal and targets; recovery requires its matching Meta_Kim receipt.",
    };
  }
  const verified = readJson(paths.verifiedPath);
  if (verified?.nonce === journal.nonce) {
    for (const entry of journal.entries) {
      const itemPaths = journalEntryPaths(root, journal, entry);
      if (!itemPaths) return { ok: false, status: "recovery_required", reason: "unsafe_verified_path" };
      const targetHash = existsSync(itemPaths.relPath) ? sha256ManagedFile(itemPaths.relPath) : null;
      if (entry.kind === "write" ? targetHash !== entry.nextHash : targetHash !== null) {
        return {
          ok: false,
          status: "recovery_required",
          reason: `verified_target_drift:${entry.relPath}`,
          journalPath: paths.journalPath,
          nextAction: "The committed target changed after verification; preserve it and inspect manually.",
        };
      }
      if (
        entry.kind === "write" &&
        process.platform !== "win32" &&
        entry.nextMode !== null &&
        entry.nextMode !== undefined &&
        portableMode(lstatSync(itemPaths.relPath)) !== entry.nextMode
      ) {
        return {
          ok: false,
          status: "recovery_required",
          reason: `verified_permission_drift:${entry.relPath}`,
          journalPath: paths.journalPath,
          nextAction: "The committed file permissions changed after verification; preserve it and inspect manually.",
        };
      }
      if (existsSync(itemPaths.stageRelPath) && !removeKnownFile(itemPaths.stageRelPath, entry.nextHash)) {
        return { ok: false, status: "recovery_required", reason: `verified_stage_drift:${entry.relPath}` };
      }
      if (existsSync(itemPaths.rollbackRelPath) && !removeKnownFile(itemPaths.rollbackRelPath, entry.oldHash)) {
        return { ok: false, status: "recovery_required", reason: `verified_rollback_drift:${entry.relPath}` };
      }
    }
    const backups = backupEvidence(root, journal.entries);
    clearRecoveredControlFiles(paths, injectCrashAt);
    return { ok: true, status: "recovered_committed", backups };
  }

  for (const entry of [...journal.entries].reverse()) {
    const recovered = recoverPreparedEntry(root, journal, entry);
    if (!recovered.ok) {
      return {
        ...recovered,
        status: "recovery_required",
        journalPath: paths.journalPath,
        nextAction: "Use the verified backup and journal to restore the listed file, then retry.",
      };
    }
  }
  const backups = backupEvidence(root, journal.entries);
  clearRecoveredControlFiles(paths, injectCrashAt);
  return { ok: true, status: "recovered_rolled_back", backups };
}

function resultWithGuidance(result) {
  const actions = {
    noop: { code: "none", message: "No action is required.", retryable: false },
    committed: { code: "complete", message: "The managed files were updated and verified.", retryable: false },
    locked: { code: "retry_after_active_transaction", message: "Wait for the active transaction to finish, then retry.", retryable: true },
    blocked: { code: "resolve_conflict", message: "Resolve the reported ownership, path, or permission conflict, then retry.", retryable: true },
    recovery_required: { code: "preserve_and_recover", message: "Preserve the journal and backups, repair the reported recovery blocker, then retry.", retryable: false },
    rolled_back: { code: "resolve_and_retry", message: "The attempted update was fully rolled back; retry after resolving the reported failure.", retryable: true },
  };
  const fallback = { code: "inspect_state", message: "Inspect the reported transaction state before retrying.", retryable: false };
  const guidance = actions[result.status] ?? fallback;
  return {
    ...result,
    nextAction: result.nextAction ?? guidance.message,
    nextActionCode: result.nextActionCode ?? guidance.code,
    retryable: result.retryable ?? guidance.retryable,
  };
}

export async function withSafeManagedFileLock({
  trustedRoot,
  lockKey = "managed-files",
  controlDirRel = ".meta-kim/transactions",
  injectPauseAfterLockMs = Number(process.env.META_KIM_TEST_PAUSE_SESSION_LOCK_MS || 0),
  injectPauseReleaseFile = process.env.META_KIM_TEST_SESSION_LOCK_RELEASE_FILE || "",
}, callback) {
  if (typeof callback !== "function") {
    return resultWithGuidance({ ok: false, status: "blocked", reason: "invalid_lock_callback" });
  }
  const root = resolve(trustedRoot);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) {
    return resultWithGuidance({ ok: false, status: "blocked", reason: "unsafe_trusted_root" });
  }
  const paths = transactionPaths(root, lockKey, controlDirRel);
  if (!paths) {
    return resultWithGuidance({ ok: false, status: "blocked", reason: "unsafe_control_path" });
  }
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const createdDirs = [];
  const lock = acquireTransactionLock(root, paths, createdDirs, nonce);
  if (!lock.ok) {
    cleanCreatedDirs(createdDirs);
    return resultWithGuidance(lock);
  }
  try {
    if (injectPauseAfterLockMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, injectPauseAfterLockMs);
    }
    if (injectPauseReleaseFile) {
      const deadline = Date.now() + 30_000;
      while (!existsSync(injectPauseReleaseFile)) {
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for the test session-lock release signal");
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    const value = await callback();
    return resultWithGuidance({ ok: true, status: "committed", value });
  } finally {
    releaseTransactionLock(paths, nonce);
    cleanCreatedDirs(createdDirs);
  }
}

export function executeSafeManagedFileTransaction({
  trustedRoot,
  backupRoot,
  operations,
  transactionLabel = "managed-files",
  lockKey = "managed-files",
  controlDirRel = ".meta-kim/transactions",
  injectFailureAtCommit = Number(process.env.META_KIM_TEST_FAIL_MANAGED_COMMIT_AT || 0),
  injectCrashAt = process.env.META_KIM_TEST_CRASH_MANAGED_AT || "",
  injectPauseAfterLockMs = Number(process.env.META_KIM_TEST_PAUSE_MANAGED_AFTER_LOCK_MS || 0),
  injectBeforeCommitItem = null,
  injectRenameOptions = null,
}) {
  if (!Array.isArray(operations)) {
    return resultWithGuidance({ ok: false, status: "blocked", reason: "invalid_operations" });
  }
  const root = resolve(trustedRoot);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) {
    return resultWithGuidance({ ok: false, status: "blocked", reason: "unsafe_trusted_root" });
  }
  const paths = transactionPaths(root, lockKey, controlDirRel);
  if (!paths) return resultWithGuidance({ ok: false, status: "blocked", reason: "unsafe_control_path" });
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const controlCreatedDirs = [];
  const lock = acquireTransactionLock(root, paths, controlCreatedDirs, nonce);
  if (!lock.ok) {
    cleanCreatedDirs(controlCreatedDirs);
    return resultWithGuidance(lock);
  }

  let keepRecoveryState = false;
  try {
    if (injectPauseAfterLockMs > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, injectPauseAfterLockMs);
    }
    const recovery = recoverExistingJournal(root, paths, injectCrashAt);
    if (!recovery.ok) {
      keepRecoveryState = true;
      return resultWithGuidance(recovery);
    }

    const planned = [];
    const seen = new Set();
    for (const [operationIndex, operation] of operations.entries()) {
      const relPath = normalizeManagedRelPath(operation?.relPath);
      if (!relPath || !["write", "remove"].includes(operation?.kind)) {
        return resultWithGuidance({ ok: false, status: "blocked", reason: "invalid_operation", relPath });
      }
      const info = inspectTrustedPath(root, relPath, { allowMissing: true });
      if (!info) return resultWithGuidance({ ok: false, status: "blocked", reason: "unsafe_realpath_or_link", relPath });
      const identityKey = process.platform === "win32" ? info.target.toLowerCase() : info.target;
      if (seen.has(identityKey)) {
        return resultWithGuidance({ ok: false, status: "blocked", reason: "duplicate_target", relPath });
      }
      seen.add(identityKey);
      const exists = existsSync(info.target);
      const oldStats = exists ? lstatSync(info.target) : null;
      const oldHash = exists ? sha256ManagedFile(info.target) : null;
      const oldMode = oldStats ? portableMode(oldStats) : null;
      if (exists && !oldHash) return resultWithGuidance({ ok: false, status: "blocked", reason: "non_regular_or_link_target", relPath });
      const expectedOldHash = operation.expectedOldHash ?? null;
      const nextContent = operation.kind === "write"
        ? Buffer.isBuffer(operation.content) ? operation.content : Buffer.from(String(operation.content ?? ""))
        : null;
      const nextHash = nextContent ? sha256Buffer(nextContent) : null;

      if (exists && HASH_RE.test(expectedOldHash) && oldHash !== expectedOldHash.toLowerCase()) {
        return resultWithGuidance({ ok: false, status: "blocked", reason: "old_hash_mismatch", relPath, expectedOldHash, actualHash: oldHash });
      }
      if (operation.kind === "write" && exists && oldHash === nextHash) {
        const managedNoop = HASH_RE.test(expectedOldHash);
        if (!managedNoop && operation.authorizedAdoptIdentical !== true) {
          return resultWithGuidance({
            ok: false,
            status: "blocked",
            reason: "unmanaged_existing_conflict",
            relPath,
            actualHash: oldHash,
          });
        }
        planned.push({
          ...operation,
          operationIndex,
          relPath,
          target: info.target,
          oldHash,
          nextHash,
          nextContent,
          oldMode,
          nextMode: oldMode,
          action: managedNoop ? "noop" : "adopt",
          phase: operationPhase(operation, relPath),
        });
        continue;
      }
      if (exists && !HASH_RE.test(expectedOldHash)) {
        return resultWithGuidance({ ok: false, status: "blocked", reason: "unmanaged_existing_conflict", relPath, actualHash: oldHash });
      }
      if (!exists && HASH_RE.test(expectedOldHash)) {
        if (operation.kind === "remove" && operation.allowManagedMissingRemove === true) {
          planned.push({ ...operation, operationIndex, relPath, target: info.target, oldHash: null, nextHash: null, oldMode: null, nextMode: null, action: "noop", phase: operationPhase(operation, relPath) });
          continue;
        }
        if (!(operation.kind === "write" && operation.allowManagedMissingCreate === true)) {
          return resultWithGuidance({ ok: false, status: "blocked", reason: "managed_file_missing", relPath, expectedOldHash });
        }
      }
      planned.push({
        ...operation,
        operationIndex,
        relPath,
        target: info.target,
        oldHash,
        nextHash,
        nextContent,
        oldMode,
        nextMode: operation.kind === "write" ? oldMode : null,
        action: operation.kind,
        phase: operationPhase(operation, relPath),
      });
    }

    const commitItems = planned
      .filter((item) => !["noop", "adopt"].includes(item.action))
      .sort((left, right) => phaseRank(left.phase) - phaseRank(right.phase) || left.operationIndex - right.operationIndex);
    if (commitItems.length === 0) {
      return resultWithGuidance({
        ok: true,
        status: "noop",
        committed: planned.map((item) => ({ relPath: item.relPath, action: item.action, contentHash: item.nextHash })),
        backups: [],
        recovery: recovery.status,
      });
    }

    const createdDirs = [];
    const label = safeToken(transactionLabel, "managed-files");
    const backupBase = resolve(backupRoot, `${label}-${nonce}`);
    if (!isInside(backupBase, root)) {
      return resultWithGuidance({ ok: false, status: "blocked", reason: "unsafe_backup_root" });
    }
    const journalEntries = commitItems.map((item) => {
      const token = sha256Buffer(Buffer.from(item.relPath)).slice(0, 12);
      const stagePath = join(dirname(item.target), `.${nonce}-${token}.stage`);
      const rollbackPath = join(dirname(item.target), `.${nonce}-${token}.rollback`);
      const backupPath = item.oldHash ? join(backupBase, item.relPath) : null;
      return {
        relPath: item.relPath,
        kind: item.kind,
        phase: item.phase,
        oldHash: item.oldHash,
        nextHash: item.nextHash,
        oldMode: item.oldMode,
        nextMode: item.nextMode,
        stageRelPath: normalizeManagedRelPath(relative(root, stagePath)),
        rollbackRelPath: normalizeManagedRelPath(relative(root, rollbackPath)),
        backupRelPath: backupPath ? normalizeManagedRelPath(relative(root, backupPath)) : null,
      };
    });
    const journal = {
      schemaVersion: JOURNAL_SCHEMA,
      phase: "prepared",
      nonce,
      lockKey: paths.key,
      trustedRoot: root,
      transactionLabel: label,
      createdAt: new Date().toISOString(),
      backupBaseRel: normalizeManagedRelPath(relative(root, backupBase)),
      entries: journalEntries,
    };
    writeExclusiveJson(paths.receiptPath, receiptForJournal(journal));
    try {
      writeExclusiveJson(paths.journalPath, journal);
    } catch (error) {
      if (existsSync(paths.receiptPath)) unlinkDurable(paths.receiptPath);
      throw error;
    }
    maybeCrash("after_prepared_journal", injectCrashAt);

    try {
      if (commitItems.some((item) => item.oldHash) && !ensureSafeDirectory(root, backupBase, createdDirs)) {
        throw new Error("unsafe_backup_root");
      }
      for (const [index, item] of commitItems.entries()) {
        const entry = journalEntries[index];
        const entryPaths = journalEntryPaths(root, journal, entry);
        if (!entryPaths) throw new Error(`unsafe_transaction_path:${item.relPath}`);
        if (item.oldHash) {
          if (!ensureSafeDirectory(root, dirname(entryPaths.backupRelPath), createdDirs)) throw new Error("unsafe_backup_parent");
          copyFileSync(item.target, entryPaths.backupRelPath);
          if (process.platform !== "win32" && item.oldMode !== null) {
            chmodSync(entryPaths.backupRelPath, item.oldMode);
          }
          if (sha256ManagedFile(entryPaths.backupRelPath) !== item.oldHash) throw new Error(`backup_hash_mismatch:${item.relPath}`);
          if (process.platform !== "win32" && portableMode(lstatSync(entryPaths.backupRelPath)) !== item.oldMode) {
            throw new Error(`backup_permission_mismatch:${item.relPath}`);
          }
          fsyncFile(entryPaths.backupRelPath);
          fsyncParentDirectory(entryPaths.backupRelPath);
        }
        if (item.kind === "write") {
          if (!ensureSafeDirectory(root, dirname(item.target), createdDirs)) throw new Error("unsafe_target_parent");
          writeExclusiveBuffer(entryPaths.stageRelPath, item.nextContent, item.nextMode);
          if (sha256ManagedFile(entryPaths.stageRelPath) !== item.nextHash) throw new Error(`stage_hash_mismatch:${item.relPath}`);
          if (
            process.platform !== "win32" &&
            item.nextMode !== null &&
            portableMode(lstatSync(entryPaths.stageRelPath)) !== item.nextMode
          ) {
            throw new Error(`stage_permission_mismatch:${item.relPath}`);
          }
        }
      }
      for (const item of commitItems) {
        const currentHash = existsSync(item.target) ? sha256ManagedFile(item.target) : null;
        if (currentHash !== item.oldHash || !inspectTrustedPath(root, item.relPath, { allowMissing: true })) {
          throw new Error(`precommit_binding_changed:${item.relPath}`);
        }
      }

      const commitRename = (fromPath, toPath) => renameDurable(fromPath, toPath, injectRenameOptions ?? undefined);
      for (const [index, item] of commitItems.entries()) {
        if (injectFailureAtCommit === index + 1) throw new Error(`injected_commit_failure:${index + 1}`);
        injectBeforeCommitItem?.(item, index);
        const entryPaths = journalEntryPaths(root, journal, journalEntries[index]);
        if (item.oldHash) {
          commitRename(item.target, entryPaths.rollbackRelPath);
          if (sha256ManagedFile(entryPaths.rollbackRelPath) !== item.oldHash) {
            if (!existsSync(item.target)) {
              commitRename(entryPaths.rollbackRelPath, item.target);
            }
            throw new Error(`commit_rollback_hash_drift:${item.relPath}`);
          }
          if (
            process.platform !== "win32" &&
            item.oldMode !== null &&
            portableMode(lstatSync(entryPaths.rollbackRelPath)) !== item.oldMode
          ) {
            if (!existsSync(item.target)) {
              commitRename(entryPaths.rollbackRelPath, item.target);
            }
            throw new Error(`commit_rollback_permission_drift:${item.relPath}`);
          }
        }
        maybeCrash("after_first_rollback_rename", index === 0 ? injectCrashAt : "");
        if (item.kind === "write") commitRename(entryPaths.stageRelPath, item.target);
        maybeCrash("after_first_target_commit", index === 0 ? injectCrashAt : "");
        maybeCrash("after_manifest_commit", item.phase === "manifest" ? injectCrashAt : "");
      }
      for (const item of commitItems) {
        const actualHash = existsSync(item.target) ? sha256ManagedFile(item.target) : null;
        if (item.kind === "write" ? actualHash !== item.nextHash : actualHash !== null) {
          throw new Error(`postcommit_verification_failed:${item.relPath}`);
        }
        if (
          item.kind === "write" &&
          process.platform !== "win32" &&
          item.nextMode !== null &&
          portableMode(lstatSync(item.target)) !== item.nextMode
        ) {
          throw new Error(`postcommit_permission_mismatch:${item.relPath}`);
        }
      }
      writeExclusiveJson(paths.verifiedPath, { nonce, verifiedAt: new Date().toISOString() });
      maybeCrash("after_verified_journal", injectCrashAt);
      for (const entry of journalEntries) {
        const entryPaths = journalEntryPaths(root, journal, entry);
        if (
          entryPaths &&
          existsSync(entryPaths.rollbackRelPath) &&
          !removeKnownFile(entryPaths.rollbackRelPath, entry.oldHash)
        ) throw new Error(`verified_rollback_drift:${entry.relPath}`);
        if (
          entryPaths &&
          existsSync(entryPaths.stageRelPath) &&
          !removeKnownFile(entryPaths.stageRelPath, entry.nextHash)
        ) throw new Error(`verified_stage_drift:${entry.relPath}`);
      }
      unlinkDurable(paths.verifiedPath);
      unlinkDurable(paths.journalPath);
      unlinkDurable(paths.receiptPath);
      return resultWithGuidance({
        ok: true,
        status: "committed",
        committed: planned.map((item) => ({ relPath: item.relPath, action: item.action, contentHash: item.nextHash })),
        backups: journalEntries.filter((entry) => entry.backupRelPath).map((entry) => ({ relPath: entry.relPath, backupPath: resolve(root, entry.backupRelPath), sourceHash: entry.oldHash, backupHash: entry.oldHash })),
        recovery: recovery.status,
      });
    } catch (error) {
      const recovered = recoverExistingJournal(root, paths, injectCrashAt);
      cleanCreatedDirs(createdDirs);
      if (!recovered.ok) {
        keepRecoveryState = true;
        return resultWithGuidance({ ...recovered, ok: false, originalFailure: error.message });
      }
      if (recovered.status === "recovered_committed") {
        return resultWithGuidance({ ok: true, status: "committed", reason: error.message, committed: [], backups: [], recovery: recovered.status });
      }
      return resultWithGuidance({ ok: false, status: "rolled_back", reason: error.message, committed: [], backups: [], recovery: recovered.status });
    }
  } finally {
    releaseTransactionLock(paths, nonce);
    if (!keepRecoveryState) cleanCreatedDirs(controlCreatedDirs);
  }
}
