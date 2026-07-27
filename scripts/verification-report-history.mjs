import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

const REPORT_SCHEMA_VERSION = "meta-kim-verification-report-v2";
const POINTER_SCHEMA_VERSION = "meta-kim-verification-report-pointer-v1";
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_MALFORMED_LOCK_STALE_MS = 1_000;
const DEFAULT_WELL_FORMED_LOCK_STALE_MS = 300_000;
const LOCK_POLL_MS = 10;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateAttemptId(attemptId) {
  if (
    typeof attemptId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(attemptId)
  ) {
    throw new Error("verification attemptId contains unsupported characters");
  }
  return attemptId;
}

function ensurePlainDirectory(directoryPath) {
  mkdirSync(directoryPath, { recursive: true });
  const stats = lstatSync(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`verification report history path is not a plain directory: ${directoryPath}`);
  }
  return directoryPath;
}

function canonicalizePotentialPath(candidatePath) {
  const absolute = path.resolve(candidatePath);
  const missingSegments = [];
  let existingAncestor = absolute;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathSync.native(existingAncestor);
  return path.join(canonicalAncestor, ...missingSegments);
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeJsonRead(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function waitFor(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function evidenceName(sourcePath) {
  return `${path.basename(sourcePath)}.${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomUUID()}`;
}

function preserveEvidence(historyDir, bucket, sourcePath) {
  const evidenceDir = ensurePlainDirectory(path.join(historyDir, bucket));
  const target = path.join(evidenceDir, evidenceName(sourcePath));
  renameSync(sourcePath, target);
  return path.relative(historyDir, target).replaceAll("\\", "/");
}

function lockIsRecoverable(
  lockPath,
  owner,
  malformedLockStaleMs,
  wellFormedLockStaleMs,
) {
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (owner) return !processIsAlive(owner.pid) || ageMs >= wellFormedLockStaleMs;
    return ageMs >= malformedLockStaleMs;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

function acquireLock(historyDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const malformedLockStaleMs =
    options.malformedLockStaleMs ?? DEFAULT_MALFORMED_LOCK_STALE_MS;
  const wellFormedLockStaleMs =
    options.wellFormedLockStaleMs ?? DEFAULT_WELL_FORMED_LOCK_STALE_MS;
  ensurePlainDirectory(historyDir);
  const lockPath = path.join(historyDir, "write.lock");
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = openSync(temporary, "wx", 0o600);
      writeFileSync(handle, jsonText({
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      }), "utf8");
      closeSync(handle);
      handle = undefined;
      linkSync(temporary, lockPath);
      unlinkSync(temporary);
      return () => {
        try {
          const owner = safeJsonRead(lockPath);
          if (owner?.pid === process.pid && owner?.token === token) unlinkSync(lockPath);
        } catch {
          // An immutable attempt remains valid even if lock cleanup is interrupted.
        }
      };
    } catch (error) {
      if (handle !== undefined) closeSync(handle);
      if (existsSync(temporary)) unlinkSync(temporary);
      if (error.code !== "EEXIST") throw error;
      let owner = null;
      try {
        owner = safeJsonRead(lockPath);
      } catch {
        // A live creator may still be writing the tiny owner record.
      }
      if (lockIsRecoverable(
        lockPath,
        owner,
        malformedLockStaleMs,
        wellFormedLockStaleMs,
      )) {
        try {
          preserveEvidence(historyDir, "stale-locks", lockPath);
          continue;
        } catch (preserveError) {
          if (["ENOENT", "EEXIST"].includes(preserveError.code)) continue;
          throw preserveError;
        }
      }
      if (Date.now() >= deadline) {
        const lockError = new Error(
          `verification report history remained locked for ${timeoutMs}ms`,
        );
        lockError.code = "VERIFICATION_REPORT_HISTORY_BUSY";
        throw lockError;
      }
      waitFor(LOCK_POLL_MS);
    }
  }
}

function atomicWrite(filePath, text) {
  ensurePlainDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = openSync(temporary, "wx", 0o600);
    writeFileSync(handle, text, "utf8");
    closeSync(handle);
    handle = undefined;
    renameSync(temporary, filePath);
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function immutableWrite(filePath, text) {
  ensurePlainDirectory(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = openSync(temporary, "wx", 0o600);
    writeFileSync(handle, text, "utf8");
    closeSync(handle);
    handle = undefined;
    linkSync(temporary, filePath);
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function compareAttempts(left, right) {
  const completed = String(left.completedAt).localeCompare(String(right.completedAt));
  if (completed !== 0) return completed;
  return String(left.attemptId).localeCompare(String(right.attemptId));
}

function validatedAttempt(report) {
  if (
    report?.schemaVersion !== REPORT_SCHEMA_VERSION ||
    typeof report.attemptId !== "string" ||
    typeof report.completedAt !== "string" ||
    typeof report.attemptRecordHash !== "string"
  ) {
    throw new Error("verification attempt shape is invalid");
  }
  validateAttemptId(report.attemptId);
  const { attemptRecordHash, ...withoutHash } = report;
  if (sha256(JSON.stringify(withoutHash)) !== attemptRecordHash) {
    throw new Error("verification attempt hash is invalid");
  }
  return report;
}

function readAttempts(attemptsDir, historyDir) {
  const attempts = [];
  const corruptAttempts = [];
  if (!existsSync(attemptsDir)) return { attempts, corruptAttempts };
  for (const entry of readdirSync(attemptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const attemptPath = path.join(attemptsDir, entry.name);
    try {
      attempts.push(validatedAttempt(safeJsonRead(attemptPath)));
    } catch (error) {
      const preservedAt = preserveEvidence(historyDir, "corrupt-attempts", attemptPath);
      corruptAttempts.push({
        source: `attempts/${entry.name}`,
        preservedAt,
        reason: error.message,
      });
    }
  }
  return { attempts, corruptAttempts };
}

function recordWithHash(report) {
  const attemptRecordHash = sha256(JSON.stringify(report));
  return { ...report, attemptRecordHash };
}

function legacyAttemptId(report) {
  const completed = String(report.completedAt ?? "unknown")
    .replace(/[^A-Za-z0-9]+/gu, "")
    .slice(0, 32) || "unknown";
  return `legacy-${completed}-${sha256(JSON.stringify(report)).slice(0, 16)}`;
}

function importExistingProjection(
  reportPath,
  attemptsDir,
  historyDir,
  priorAttempts,
) {
  if (!existsSync(reportPath)) return { record: null, corruptProjections: [] };
  try {
    const existing = safeJsonRead(reportPath);
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      throw new Error("existing verification report projection is invalid");
    }
    let record;
    if (existing.schemaVersion === REPORT_SCHEMA_VERSION) {
      record = validatedAttempt(existing);
    } else {
      if (typeof existing.completedAt !== "string") {
        throw new Error("legacy verification report is missing completedAt");
      }
      record = recordWithHash({
        ...existing,
        schemaVersion: REPORT_SCHEMA_VERSION,
        attemptId: legacyAttemptId(existing),
        previousAttemptId: priorAttempts.sort(compareAttempts).at(-1)?.attemptId ?? null,
        importedFromLegacyProjection: true,
      });
    }
    const recordPath = path.join(attemptsDir, `${validateAttemptId(record.attemptId)}.json`);
    if (!existsSync(recordPath)) immutableWrite(recordPath, jsonText(record));
    return { record, corruptProjections: [] };
  } catch (error) {
    const preservedAt = preserveEvidence(
      historyDir,
      "corrupt-projections",
      reportPath,
    );
    return {
      record: null,
      corruptProjections: [{
        source: path.basename(reportPath),
        preservedAt,
        reason: error.message,
      }],
    };
  }
}

function pointerFor(report) {
  return {
    schemaVersion: POINTER_SCHEMA_VERSION,
    attemptId: report.attemptId,
    completedAt: report.completedAt,
    ok: report.ok === true,
    releaseGrade: report.releaseGrade === true,
    recordHash: report.attemptRecordHash,
    record: `attempts/${report.attemptId}.json`,
  };
}

export function createVerificationAttemptId(now = new Date()) {
  return `${now.toISOString().replace(/[-:.]/gu, "")}-${randomUUID()}`;
}

export function resolveVerificationHistoryDir(reportPath) {
  const resolved = path.resolve(reportPath);
  const basename = path.basename(resolved);
  const defaultBasename = process.platform === "win32"
    ? basename.toLowerCase() === "verification-report.json"
    : basename === "verification-report.json";
  const directoryName = defaultBasename
    ? "verification-reports"
    : `${basename}.verification-reports`;
  return path.join(path.dirname(resolved), directoryName);
}

function assertReportPathIsNotHistoryRecord(reportPath) {
  let current = path.dirname(reportPath);
  while (current !== path.dirname(current)) {
    const name = path.basename(current);
    const comparableName = process.platform === "win32" ? name.toLowerCase() : name;
    const reservedName =
      comparableName === "verification-reports" ||
      comparableName.endsWith(".verification-reports");
    const activeHistory = reservedName && [
      "attempts",
      "latest-attempt.json",
      "latest-release-grade.json",
      "write.lock",
    ].some((entry) => existsSync(path.join(current, entry)));
    if (activeHistory) {
      throw new Error("verification report output cannot be placed inside report history");
    }
    current = path.dirname(current);
  }
}

export function writeVerificationReportAttempt(options) {
  const reportPath = canonicalizePotentialPath(options.reportPath);
  assertReportPathIsNotHistoryRecord(reportPath);
  const historyDir = canonicalizePotentialPath(
    options.historyDir ?? resolveVerificationHistoryDir(reportPath),
  );
  const attemptsDir = path.join(historyDir, "attempts");
  const attemptId = validateAttemptId(
    options.attemptId ?? createVerificationAttemptId(),
  );
  if (!options.report || typeof options.report !== "object" || Array.isArray(options.report)) {
    throw new Error("verification report must be an object");
  }
  const releaseLock = acquireLock(historyDir, {
    timeoutMs: options.lockTimeoutMs,
    malformedLockStaleMs: options.malformedLockStaleMs,
    wellFormedLockStaleMs: options.wellFormedLockStaleMs,
  });
  try {
    ensurePlainDirectory(attemptsDir);
    const firstRead = readAttempts(attemptsDir, historyDir);
    const projectionImport = importExistingProjection(
      reportPath,
      attemptsDir,
      historyDir,
      firstRead.attempts,
    );
    const secondRead = readAttempts(attemptsDir, historyDir);
    const priorAttempts = secondRead.attempts.sort(compareAttempts);
    const corruptAttempts = [
      ...firstRead.corruptAttempts,
      ...secondRead.corruptAttempts,
    ];
    const previousAttemptId = priorAttempts.at(-1)?.attemptId ?? null;
    const record = recordWithHash({
      ...options.report,
      schemaVersion: REPORT_SCHEMA_VERSION,
      attemptId,
      previousAttemptId,
      historyRecovery: {
        corruptAttemptCount: corruptAttempts.length,
        corruptAttempts,
        corruptProjectionCount: projectionImport.corruptProjections.length,
        corruptProjections: projectionImport.corruptProjections,
      },
    });
    const recordPath = path.join(attemptsDir, `${attemptId}.json`);
    immutableWrite(recordPath, jsonText(record));

    const attempts = [...priorAttempts, record].sort(compareAttempts);
    const latest = attempts.at(-1);
    const latestReleaseGrade = attempts
      .filter((attempt) => attempt.ok === true && attempt.releaseGrade === true)
      .at(-1) ?? null;
    atomicWrite(path.join(historyDir, "latest-attempt.json"), jsonText(pointerFor(latest)));
    let latestReleaseGradePath = null;
    if (latestReleaseGrade) {
      atomicWrite(
        path.join(historyDir, "latest-release-grade.json"),
        jsonText(pointerFor(latestReleaseGrade)),
      );
      latestReleaseGradePath = path.join(
        attemptsDir,
        `${validateAttemptId(latestReleaseGrade.attemptId)}.json`,
      );
    }
    atomicWrite(reportPath, jsonText(latest));
    return {
      report: record,
      recordPath,
      latestReport: latest,
      latestReportPath: reportPath,
      latestReleaseGrade,
      latestReleaseGradePath,
      historyDir,
      corruptAttempts,
      corruptProjections: projectionImport.corruptProjections,
    };
  } finally {
    releaseLock();
  }
}

export const VERIFICATION_REPORT_SCHEMA_VERSION = REPORT_SCHEMA_VERSION;
export const VERIFICATION_REPORT_POINTER_SCHEMA_VERSION = POINTER_SCHEMA_VERSION;
