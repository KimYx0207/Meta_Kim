import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  WINDOWS_APP_LOCAL_CRT_DLLS,
  buildBootMemoryServiceEnv,
  buildInitialMemoryServiceEnv,
} from "./mcp-memory-service-lifecycle.mjs";

const SQLITE_BACKUP_SCRIPT = [
  "import sqlite3, sys",
  "source, target = sys.argv[1], sys.argv[2]",
  "src = sqlite3.connect(source)",
  "check = src.execute('PRAGMA quick_check').fetchone()[0]",
  "assert check == 'ok', check",
  "dst = sqlite3.connect(target)",
  "src.backup(dst)",
  "dst.commit()",
  "assert dst.execute('PRAGMA quick_check').fetchone()[0] == 'ok'",
  "dst.close(); src.close()",
].join("\n");

const SQLITE_RESTORE_SCRIPT = [
  "import sqlite3, sys",
  "backup, target = sys.argv[1], sys.argv[2]",
  "src = sqlite3.connect(backup)",
  "assert src.execute('PRAGMA quick_check').fetchone()[0] == 'ok'",
  "dst = sqlite3.connect(target)",
  "src.backup(dst)",
  "dst.commit()",
  "assert dst.execute('PRAGMA quick_check').fetchone()[0] == 'ok'",
  "dst.close(); src.close()",
].join("\n");

const SQLITE_QUICK_CHECK_SCRIPT = [
  "import pathlib, sqlite3, sys",
  "uri = pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro'",
  "db = sqlite3.connect(uri, uri=True)",
  "db.execute('PRAGMA query_only=ON')",
  "result = db.execute('PRAGMA quick_check').fetchone()[0]",
  "db.close()",
  "assert result == 'ok', result",
].join("\n");

const ONNX_SENTINEL_SCRIPT = [
  "import asyncio, inspect, json, math, os, sys",
  "from importlib.metadata import version",
  "from mcp_memory_service.embeddings.onnx_embeddings import ONNXEmbeddingModel",
  "from mcp_memory_service.storage.sqlite_vec import SqliteVecMemoryStorage",
  "EXPECTED_MODEL = 'all-MiniLM-L6-v2'",
  "async def maybe_await(value):",
  "    return await value if inspect.isawaitable(value) else value",
  "async def main():",
  "    db_path = sys.argv[1]",
  "    os.environ['MCP_MEMORY_SQLITE_PATH'] = db_path",
  "    storage = SqliteVecMemoryStorage(db_path)",
  "    await storage.initialize()",
  "    model = storage.embedding_model",
  "    vectors = await maybe_await(model.encode(['Meta Kim sentinel alpha', 'Meta Kim sentinel beta']))",
  "    if hasattr(vectors, 'tolist'): vectors = vectors.tolist()",
  "    vectors = [vector.tolist() if hasattr(vector, 'tolist') else list(vector) for vector in vectors]",
  "    dimensions = [len(vector) for vector in vectors]",
  "    expected_dimension = storage.embedding_dimension",
  "    evidence = {'ok': True, 'packageVersion': version('mcp-memory-service'), 'modelClass': model.__class__.__name__, 'modelIdentity': model.model_name, 'degraded': not isinstance(model, ONNXEmbeddingModel), 'dimension': dimensions[0] if dimensions else 0, 'expectedDimension': int(expected_dimension), 'dimensionsMatch': bool(dimensions) and len(set(dimensions)) == 1 and dimensions[0] == int(expected_dimension), 'finite': bool(vectors) and all(math.isfinite(float(value)) for vector in vectors for value in vector)}",
  "    print(json.dumps(evidence))",
  "asyncio.run(main())",
].join("\n");

export const MCP_MEMORY_TRANSACTION_ID_PATTERN = /^update-\d{13}-\d{1,10}$/u;
export const MCP_MEMORY_NO_DATABASE_DIGEST = createHash("sha256")
  .update("meta-kim:no-database")
  .digest("hex");

function recoveryPathKey(value, platformName = process.platform) {
  const normalized = resolve(value).replace(/\\/gu, "/");
  return platformName === "win32" ? normalized.toLowerCase() : normalized;
}

function recoveryPathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function validateMcpMemoryRecoveryMaterial({
  transactionRoot,
  evidenceName,
  transactionId,
  recovery,
  expectedOldMemoryBin,
  expectedPython,
  expectedDatabasePath,
  expectedCandidateRoot,
  expectedMcpPath,
  expectedSnapshotPaths = [],
  platformName = process.platform,
  lstat = lstatSync,
  realpath = realpathSync,
}) {
  if (
    !recovery || typeof recovery !== "object" || Array.isArray(recovery) ||
    !Array.isArray(recovery.bootSnapshots) ||
    !recovery.stateSnapshot || typeof recovery.stateSnapshot !== "object" ||
    Array.isArray(recovery.stateSnapshot) ||
    !recovery.oldPython || typeof recovery.oldPython !== "object" ||
    !Array.isArray(recovery.oldPython.args) ||
    !Array.isArray(expectedSnapshotPaths)
  ) return { ok: false, reason: "recovery_binding_mismatch" };
  if (!MCP_MEMORY_TRANSACTION_ID_PATTERN.test(transactionId ?? "")) {
    return { ok: false, reason: "transaction_id_invalid" };
  }
  let trustedRoot;
  try {
    const metadata = lstat(transactionRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("root link");
    trustedRoot = realpath(transactionRoot);
  } catch { return { ok: false, reason: "transaction_root_untrusted" }; }
  if (evidenceName !== `${transactionId}.json`) {
    return { ok: false, reason: "evidence_name_mismatch" };
  }
  const evidencePath = resolve(trustedRoot, evidenceName);
  const recoveryPath = resolve(trustedRoot, `${transactionId}-recovery.json`);
  const backupPath = resolve(trustedRoot, `${transactionId}-sqlite-backup.db`);
  if (![evidencePath, recoveryPath, backupPath].every((filePath) => recoveryPathInside(trustedRoot, filePath))) {
    return { ok: false, reason: "transaction_artifact_escape" };
  }
  const expectedPythonDescriptor = typeof expectedPython === "string"
    ? { command: expectedPython, args: [] }
    : { command: expectedPython?.command, args: expectedPython?.args ?? [] };
  const requiredAbsolutePaths = [
    expectedOldMemoryBin,
    expectedPythonDescriptor.command,
    expectedDatabasePath,
    expectedCandidateRoot,
    expectedMcpPath,
    recovery?.oldMemoryBin,
    recovery?.databasePath,
    recovery?.candidateMemoryBin,
    recovery?.oldPython?.command,
    recovery?.mcpPath,
  ];
  if (!requiredAbsolutePaths.every((filePath) => (
    typeof filePath === "string" && filePath.length > 0 && isAbsolute(filePath)
  ))) {
    return { ok: false, reason: "recovery_binding_mismatch" };
  }
  let trustedOldBin;
  let trustedCandidateBin;
  let trustedExpectedPython;
  let trustedRecoveryPython;
  try {
    trustedOldBin = realpath(expectedOldMemoryBin);
    trustedCandidateBin = realpath(recovery?.candidateMemoryBin);
    trustedExpectedPython = realpath(expectedPythonDescriptor.command);
    trustedRecoveryPython = realpath(recovery?.oldPython?.command);
  } catch { return { ok: false, reason: "recovery_executable_untrusted" }; }
  const snapshotSet = new Set(expectedSnapshotPaths.map((filePath) => recoveryPathKey(filePath, platformName)));
  const snapshots = [recovery?.stateSnapshot, ...(recovery?.bootSnapshots ?? [])].filter(Boolean);
  if (
    recovery?.transactionId !== transactionId ||
    !expectedDatabasePath ||
    recoveryPathKey(recovery.oldMemoryBin, platformName) !== recoveryPathKey(trustedOldBin, platformName) ||
    recoveryPathKey(recovery.databasePath, platformName) !== recoveryPathKey(expectedDatabasePath, platformName) ||
    recoveryPathKey(trustedRecoveryPython, platformName) !== recoveryPathKey(trustedExpectedPython, platformName) ||
    JSON.stringify(recovery.oldPython?.args ?? []) !== JSON.stringify(expectedPythonDescriptor.args) ||
    recoveryPathKey(recovery.mcpPath, platformName) !== recoveryPathKey(expectedMcpPath, platformName) ||
    !recoveryPathInside(expectedCandidateRoot, trustedCandidateBin) ||
    !/[/\\]Scripts[/\\]memory\.exe$/iu.test(trustedCandidateBin) ||
    !snapshots.every(({ filePath }) => isAbsolute(filePath) && snapshotSet.has(recoveryPathKey(filePath, platformName)))
  ) return { ok: false, reason: "recovery_binding_mismatch" };
  return {
    ok: true,
    trustedTransactionRoot: trustedRoot,
    trustedOldMemoryBin: trustedOldBin,
    trustedCandidateMemoryBin: trustedCandidateBin,
    trustedPython: trustedExpectedPython,
    evidencePath,
    recoveryPath,
    backupPath,
  };
}

function pythonCommand(python) {
  return typeof python === "string"
    ? { command: python, args: [] }
    : { command: python.command, args: python.args ?? [] };
}

function bestEffortMode(filePath, mode) {
  try { chmodSync(filePath, mode); } catch {}
}

function evidenceDigest(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeStopEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return undefined;
  return {
    pid: Number.isInteger(evidence.pid) ? evidence.pid : undefined,
    startIdentityDigest: evidenceDigest(evidence.startIdentity),
    executableDigest: evidenceDigest(evidence.executablePath),
    host: typeof evidence.host === "string" ? evidence.host : undefined,
    port: evidence.port === undefined ? undefined : String(evidence.port),
  };
}

function safeRepairEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return undefined;
  return {
    sourceKind: evidence.sourceKind,
    bundleName: evidence.bundleName,
    msvcVersion: evidence.msvcVersion,
    dllVersion: evidence.dllVersion,
    copiedDlls: Array.isArray(evidence.copiedDlls)
      ? evidence.copiedDlls.filter((dllName) => WINDOWS_APP_LOCAL_CRT_DLLS.includes(dllName))
      : undefined,
    signatures: Array.isArray(evidence.signatures)
      ? evidence.signatures.map((signature) => ({
        dllName: WINDOWS_APP_LOCAL_CRT_DLLS.includes(signature?.dllName)
          ? signature.dllName
          : undefined,
        status: ["Valid", "Missing", "Invalid"].includes(signature?.status)
          ? signature.status
          : "Invalid",
        signerThumbprintDigest: /^[a-f0-9]{64}$/u.test(signature?.signerThumbprintDigest ?? "")
          ? signature.signerThumbprintDigest
          : undefined,
        rootThumbprintDigest: /^[a-f0-9]{64}$/u.test(signature?.rootThumbprintDigest ?? "")
          ? signature.rootThumbprintDigest
          : undefined,
      }))
      : undefined,
    reason: evidence.reason,
  };
}

export function preparePrivateTransactionRoot(transactionRoot) {
  mkdirSync(transactionRoot, { recursive: true, mode: 0o700 });
  bestEffortMode(transactionRoot, 0o700);
  return transactionRoot;
}

export function hardenPrivateFile(filePath) {
  if (existsSync(filePath)) bestEffortMode(filePath, 0o600);
  return filePath;
}

export function sqliteBackupWithQuickCheck({ python, sourcePath, backupPath }) {
  preparePrivateTransactionRoot(dirname(backupPath));
  const launcher = pythonCommand(python);
  const result = spawnSync(launcher.command, [...launcher.args, "-c", SQLITE_BACKUP_SCRIPT, sourcePath, backupPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  hardenPrivateFile(backupPath);
  let contentSha256;
  if (result.status === 0 && existsSync(backupPath)) {
    contentSha256 = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
  }
  return { ok: result.status === 0, quickCheck: result.status === 0 ? "ok" : "failed", identity: backupPath, contentSha256, processResult: result };
}

export function sqliteRestoreWithQuickCheck({ python, backupPath, targetPath }) {
  const launcher = pythonCommand(python);
  const result = spawnSync(launcher.command, [...launcher.args, "-c", SQLITE_RESTORE_SCRIPT, backupPath, targetPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  return { ok: result.status === 0, quickCheck: result.status === 0 ? "ok" : "failed", processResult: result };
}

export function sqliteQuickCheck({ python, databasePath }) {
  const launcher = pythonCommand(python);
  const result = spawnSync(launcher.command, [...launcher.args, "-c", SQLITE_QUICK_CHECK_SCRIPT, databasePath], {
    encoding: "utf8",
    windowsHide: true,
  });
  return { ok: result.status === 0, quickCheck: result.status === 0 ? "ok" : "failed", processResult: result };
}

export async function runCandidateOnnxSentinel({
  pythonPath,
  workDir,
  offline,
  baseEnv = process.env,
}) {
  mkdirSync(workDir, { recursive: true });
  const databasePath = join(workDir, offline ? "offline-sentinel.db" : "online-sentinel.db");
  const env = {
    ...(offline ? buildBootMemoryServiceEnv(baseEnv) : buildInitialMemoryServiceEnv(baseEnv)),
    MCP_MEMORY_STORAGE_BACKEND: "sqlite_vec",
    MCP_MEMORY_SQLITE_PATH: databasePath,
  };
  const launcher = pythonCommand(pythonPath);
  const probe = spawnSync(launcher.command, [...launcher.args, "-c", ONNX_SENTINEL_SCRIPT, databasePath], {
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  let evidence = {};
  try {
    const line = probe.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
    evidence = JSON.parse(line || "{}");
  } catch {}
  rmSync(workDir, { recursive: true, force: true });
  return {
    ...evidence,
    ok: probe.status === 0 && evidence.ok === true,
    processResult: probe,
  };
}

export function writeJsonAtomic(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  hardenPrivateFile(tempPath);
  renameSync(tempPath, filePath);
  hardenPrivateFile(filePath);
}

const RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function cleanupExpiredMcpMemoryRecoveryArtifacts({
  transactionRoot,
  now = Date.now(),
  retentionMs = RECOVERY_RETENTION_MS,
}) {
  if (!existsSync(transactionRoot)) return [];
  const removed = [];
  for (const name of readdirSync(transactionRoot)) {
    if (!name.endsWith(".json") || name.endsWith("-recovery.json")) continue;
    const evidencePath = join(transactionRoot, name);
    let evidence;
    try { evidence = JSON.parse(readFileSync(evidencePath, "utf8")); } catch { continue; }
    if (evidence?.schemaVersion !== "meta-kim-mcp-memory-upgrade-v1") continue;
    if (!evidence.transactionId || !["committed", "rolled_back", "rollback_failed", "failed_old_runtime_preserved", "recovered_on_next_setup"].includes(evidence.status)) continue;
    if (now - statSync(evidencePath).mtimeMs < retentionMs) continue;
    for (const ownedPath of [
      evidencePath,
      join(transactionRoot, `${evidence.transactionId}-recovery.json`),
      join(transactionRoot, `${evidence.transactionId}-sqlite-backup.db`),
    ]) {
      if (!existsSync(ownedPath)) continue;
      rmSync(ownedPath, { force: true });
      removed.push(ownedPath);
    }
  }
  return removed;
}

export function verifyOnnxEncodeEvidence(evidence) {
  return Boolean(
    evidence?.ok === true &&
    evidence?.packageVersion === "11.5.5" &&
    evidence?.modelClass === "ONNXEmbeddingModel" &&
    evidence?.modelIdentity === "all-MiniLM-L6-v2" &&
    evidence?.degraded === false &&
    Number.isInteger(evidence?.dimension) &&
    evidence.dimension > 0 &&
    evidence.dimension <= 8_192 &&
    evidence?.expectedDimension === evidence.dimension &&
    evidence?.dimensionsMatch === true &&
    evidence?.finite === true,
  );
}

function errorCode(error, fallback) {
  return error?.code || fallback;
}

export async function runMcpMemoryRecoveryProtocol({ adapters, preflight = async () => ({ ok: true }) }) {
  try {
    const ready = await preflight();
    if (!ready?.ok) return { ok: false, reason: ready?.reason ?? "recovery_preflight_failed" };
  } catch (error) {
    return { ok: false, reason: "recovery_preflight_exception", message: String(error?.message || error) };
  }
  const lock = await adapters.acquireTransactionLock();
  if (!lock?.acquired) return { ok: false, reason: "recovery_lock_unavailable" };
  try {
    const writer = await adapters.inspectWriter();
    if (!writer || !["none", "old", "candidate"].includes(writer.kind)) {
      return { ok: false, reason: "unknown_listener" };
    }
    if (writer.kind !== "none") {
      const stopped = await adapters.stopWriter(writer);
      if (!stopped?.ok) return { ok: false, reason: "verified_writer_stop_failed" };
    }
    if (!(await adapters.verifyNoWriter())) {
      return { ok: false, reason: "writer_present_before_restore" };
    }
    if ((await adapters.restoreDatabase()) === false) {
      return { ok: false, reason: "database_restore_failed" };
    }
    if ((await adapters.restoreMcpEntry()) === false) {
      return { ok: false, reason: "mcp_restore_failed" };
    }
    if ((await adapters.restoreBootAndActiveState()) === false) {
      return { ok: false, reason: "state_restore_failed" };
    }
    const started = await adapters.startOldRuntime({ lockAlreadyHeld: true });
    if (!started?.ok || !(await adapters.verifyOldRuntime())) {
      return { ok: false, reason: "old_runtime_recovery_failed" };
    }
    if ((await adapters.markRecovered()) === false) {
      return { ok: false, reason: "recovery_journal_update_failed" };
    }
    return { ok: true, reason: "recovered" };
  } catch (error) {
    return {
      ok: false,
      reason: "recovery_exception",
      message: String(error?.message || error),
    };
  } finally {
    try { await adapters.releaseTransactionLock(lock); } catch {}
  }
}

export async function runMcpMemoryUpgradeTransaction({
  transactionRoot,
  adapters,
  transactionId = `mcp-memory-upgrade-${Date.now()}-${randomUUID()}`,
  writeEvidence = writeJsonAtomic,
}) {
  preparePrivateTransactionRoot(transactionRoot);
  const evidencePath = join(transactionRoot, `${transactionId}.json`);
  const evidence = {
    schemaVersion: "meta-kim-mcp-memory-upgrade-v1",
    transactionId,
    status: "running",
    stage: "prepare_candidate",
    oldRuntimePreservedUntilStop: true,
    events: [],
  };
  const record = (stage, detail = {}, { bestEffort = false } = {}) => {
    evidence.stage = stage;
    evidence.events.push({ stage, at: new Date().toISOString(), ...detail });
    try {
      writeEvidence(evidencePath, evidence);
      return true;
    } catch (error) {
      evidence.evidenceWriteErrors ??= [];
      evidence.evidenceWriteErrors.push({ stage, code: error?.code ?? "evidence_write_failed" });
      if (!bestEffort) throw error;
      return false;
    }
  };

  let candidate = null;
  let backup = null;
  let oldStopped = false;
  let transactionLock = null;
  try {
    record("prepare_candidate");
    candidate = await adapters.prepareCandidate();
    if (!candidate?.ok) {
      const error = new Error("candidate install failed");
      error.code = candidate?.code ?? "F6_candidate_install_failed";
      record("candidate_prepare_failed", {
        code: error.code,
        failureStage: candidate?.stage,
        repairReason: candidate?.repairReason,
      });
      throw error;
    }
    record("candidate_installed", {
      candidateIdentityDigest: evidenceDigest(candidate.identity),
      reconciliationStage: candidate.reconciliationStage,
      reconciliationCode: candidate.reconciliationCode,
      repairEvidence: safeRepairEvidence(candidate.repairEvidence),
    });

    const online = await adapters.validateCandidateOnline(candidate);
    if (!verifyOnnxEncodeEvidence(online)) {
      const error = new Error("candidate online ONNX encode failed");
      error.code = "F7_candidate_online_encode_failed";
      throw error;
    }
    record("candidate_online_encode_verified", { dimension: online.dimension });

    const offline = await adapters.validateCandidateBootOffline(candidate);
    if (!verifyOnnxEncodeEvidence(offline)) {
      const error = new Error("candidate boot-offline ONNX encode failed");
      error.code = "F8_candidate_offline_encode_failed";
      throw error;
    }
    record("candidate_boot_offline_encode_verified", { dimension: offline.dimension });

    if (adapters.persistRecoverySnapshots) {
      const snapshot = await adapters.persistRecoverySnapshots(candidate);
      if (snapshot === false || snapshot?.ok === false) {
        const error = new Error("recovery snapshot persistence failed");
        error.code = "recovery_snapshot_failed";
        throw error;
      }
      record("recovery_snapshots_persisted", {
        identityDigest: evidenceDigest(snapshot?.identity),
        recoveryDigest: /^[a-f0-9]{64}$/u.test(snapshot?.recoveryDigest ?? "")
          ? snapshot.recoveryDigest
          : undefined,
      });
    }
    if (adapters.acquireTransactionLock) {
      transactionLock = await adapters.acquireTransactionLock(candidate);
      if (!transactionLock?.acquired) {
        const error = new Error("endpoint transaction lock unavailable");
        error.code = "endpoint_transaction_lock_failed";
        throw error;
      }
      record("endpoint_transaction_lock_acquired");
    }

    const stopped = await adapters.stopOldRuntime();
    if (!stopped?.ok) {
      const error = new Error("old runtime stop was not identity-verified");
      error.code = "verified_stop_failed";
      throw error;
    }
    oldStopped = true;
    record("old_runtime_stopped", { stopEvidence: safeStopEvidence(stopped.evidence) });

    backup = await adapters.backupDatabase();
    if (!backup?.ok || backup.quickCheck !== "ok") {
      const error = new Error("SQLite backup or quick_check failed");
      error.code = "database_backup_failed";
      throw error;
    }
    record("database_backup_verified", {
      backupIdentityDigest: evidenceDigest(backup.identity),
      backupContentDigest: /^[a-f0-9]{64}$/u.test(backup.contentSha256 ?? "")
        ? backup.contentSha256
        : undefined,
    });

    const started = await adapters.startCandidate(candidate);
    if (!started?.ok || !(await adapters.verifyCandidateHealthy(candidate))) {
      const error = new Error("candidate failed identity and health verification");
      error.code = "candidate_runtime_verification_failed";
      throw error;
    }
    record("candidate_runtime_verified");
    if ((await adapters.updateMcpConfig(candidate)) === false) {
      const error = new Error("candidate MCP configuration update failed");
      error.code = "candidate_mcp_switch_failed";
      throw error;
    }
    record("candidate_mcp_config_updated");
    if ((await adapters.configureCandidateBoot(candidate)) === false) {
      const error = new Error("candidate boot switch failed");
      error.code = "candidate_boot_switch_failed";
      throw error;
    }
    record("candidate_boot_switched");
    if ((await adapters.writeActiveState(candidate)) === false) {
      const error = new Error("candidate active state update failed");
      error.code = "candidate_active_state_failed";
      throw error;
    }
    record("candidate_active_state_written");
    await adapters.commit(candidate, backup);
    evidence.status = "committed";
    record("committed");
    if (adapters.cleanupSensitiveArtifacts) {
      try {
        const cleaned = await adapters.cleanupSensitiveArtifacts(candidate, backup);
        if (cleaned === false || cleaned?.ok === false) {
          return {
            ok: false,
            status: "committed_cleanup_failed",
            code: "sensitive_artifact_cleanup_failed",
            candidate,
            evidencePath,
          };
        }
      } catch {
        return {
          ok: false,
          status: "committed_cleanup_failed",
          code: "sensitive_artifact_cleanup_failed",
          candidate,
          evidencePath,
        };
      }
    }
    return { ok: true, status: "committed", candidate, evidencePath };
  } catch (error) {
    record("failed", { code: errorCode(error, "upgrade_failed") }, { bestEffort: true });
    if (!oldStopped) {
      try {
        if (candidate) await adapters.cleanupCandidate(candidate);
      } catch {}
      evidence.status = "failed_old_runtime_preserved";
      record("failed_old_runtime_preserved", { code: errorCode(error, "upgrade_failed") }, { bestEffort: true });
      return {
        ok: false,
        status: "failed_old_runtime_preserved",
        code: errorCode(error, "upgrade_failed"),
        evidencePath,
      };
    }

    const rollbackErrors = [];
    const rollbackFailed = () => {
      evidence.status = "rollback_failed";
      evidence.rollbackFailures = rollbackErrors.map(({ stage }) => stage);
      record("rollback_failed", { failures: rollbackErrors.map(({ stage }) => stage) }, { bestEffort: true });
      return {
        ok: false,
        status: "rollback_failed",
        code: "F9_rollback_failed",
        rollbackErrors,
        evidencePath,
      };
    };
    const attempt = async (stage, action) => {
      try {
        const result = await action();
        if (result === false || result?.ok === false) throw new Error(`${stage} returned failure`);
        record(stage, {}, { bestEffort: true });
        return true;
      } catch (rollbackError) {
        rollbackErrors.push({ stage, message: String(rollbackError?.message || rollbackError) });
        record(`${stage}_failed`, {}, { bestEffort: true });
        return false;
      }
    };
    if (!(await attempt("candidate_stopped_for_rollback", () => adapters.stopCandidate(candidate)))) {
      return rollbackFailed();
    }
    if (!(await attempt("rollback_endpoint_released", async () => ({
      ok: (await adapters.verifyNoWriter()) === true,
    })))) {
      return rollbackFailed();
    }
    if (!(await attempt("database_restored", () => adapters.restoreDatabase(backup)))) {
      return rollbackFailed();
    }
    await attempt("boot_restored", () => adapters.restoreBoot());
    await attempt("state_restored", () => adapters.restoreState());
    await attempt("old_runtime_restarted", () => adapters.startOldRuntime());
    await attempt("old_runtime_health_verified", async () => {
      const healthy = await adapters.verifyOldRuntimeHealthy();
      return { ok: healthy === true };
    });

    if (rollbackErrors.length > 0) {
      return rollbackFailed();
    }
    evidence.status = "rolled_back";
    record("rolled_back", { originalCode: errorCode(error, "upgrade_failed") }, { bestEffort: true });
    return {
      ok: false,
      status: "rolled_back",
      code: errorCode(error, "upgrade_failed"),
      evidencePath,
    };
  } finally {
    if (transactionLock?.acquired && adapters.releaseTransactionLock) {
      try {
        await adapters.releaseTransactionLock(transactionLock);
      } catch {
        record("endpoint_transaction_lock_release_failed", {}, { bestEffort: true });
      }
    }
  }
}
