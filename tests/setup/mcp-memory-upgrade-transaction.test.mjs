import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "node:test";
import {
  cleanupExpiredMcpMemoryRecoveryArtifacts,
  MCP_MEMORY_SQLITE_TIMEOUT_MS,
  MCP_MEMORY_SUBPROCESS_TIMEOUT_MS,
  runMcpMemoryRecoveryProtocol,
  runMcpMemoryUpgradeTransaction,
  runCandidateOnnxSentinel,
  sqliteBackupWithQuickCheck,
  sqliteQuickCheck,
  sqliteRestoreWithQuickCheck,
  validateMcpMemoryRecoveryMaterial,
  verifyOnnxEncodeEvidence,
  writeJsonAtomic,
} from "../../scripts/mcp-memory-upgrade-transaction.mjs";

const setupSource = readFileSync(resolve(import.meta.dirname, "..", "..", "setup.mjs"), "utf8");
const bootArtifactsSource = readFileSync(
  resolve(import.meta.dirname, "..", "..", "scripts", "mcp-memory-boot-artifacts.mjs"),
  "utf8",
);

const validEncode = {
  ok: true,
  packageVersion: "11.5.5",
  modelClass: "ONNXEmbeddingModel",
  modelIdentity: "all-MiniLM-L6-v2",
  degraded: false,
  dimension: 384,
  expectedDimension: 384,
  dimensionsMatch: true,
  finite: true,
};

function fixtureAdapters(overrides = {}) {
  const calls = [];
  const action = (name, result = { ok: true }) => async () => {
    calls.push(name);
    return result;
  };
  return {
    calls,
    adapters: {
      prepareCandidate: action("prepareCandidate", { ok: true, identity: "candidate-v2" }),
      validateCandidateOnline: action("validateCandidateOnline", validEncode),
      validateCandidateBootOffline: action("validateCandidateBootOffline", validEncode),
      backupDatabase: action("backupDatabase", { ok: true, quickCheck: "ok", identity: "backup-1" }),
      stopOldRuntime: action("stopOldRuntime", { ok: true, evidence: { pid: 10 } }),
      updateMcpConfig: action("updateMcpConfig"),
      configureCandidateBoot: action("configureCandidateBoot"),
      writeActiveState: action("writeActiveState"),
      startCandidate: action("startCandidate", { ok: true }),
      verifyCandidateHealthy: action("verifyCandidateHealthy", true),
      commit: action("commit"),
      cleanupSensitiveArtifacts: action("cleanupSensitiveArtifacts"),
      cleanupCandidate: action("cleanupCandidate"),
      stopCandidate: action("stopCandidate", { ok: true, stopped: true }),
      verifyNoWriter: action("verifyNoWriter", true),
      restoreDatabase: action("restoreDatabase"),
      restoreBoot: action("restoreBoot"),
      restoreState: action("restoreState"),
      startOldRuntime: action("startOldRuntime"),
      verifyOldRuntimeHealthy: action("verifyOldRuntimeHealthy", true),
      ...overrides,
    },
  };
}

async function runFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "meta-kim-memory-upgrade-"));
  const fixture = fixtureAdapters(overrides);
  try {
    const result = await runMcpMemoryUpgradeTransaction({
      transactionRoot: root,
      adapters: fixture.adapters,
      transactionId: "fixture-transaction",
    });
    const evidence = JSON.parse(readFileSync(result.evidencePath, "utf8"));
    return { ...fixture, result, evidence };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("MCP memory upgrade transaction", () => {
  test("atomic evidence writes retry transient Windows rename locks", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-memory-atomic-write-"));
    const target = join(root, "evidence.json");
    let attempts = 0;
    try {
      writeJsonAtomic(target, { ok: true }, {
        platform: "win32",
        rename: (source, destination) => {
          attempts += 1;
          if (attempts < 3) {
            const error = new Error("transient lock");
            error.code = "EPERM";
            throw error;
          }
          renameSync(source, destination);
        },
        wait: () => {},
      });
      assert.equal(attempts, 3);
      assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows SQLite and candidate probes use hidden shell-free bounded subprocesses", async () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-memory-subprocess-options-"));
    const calls = [];
    const spawnFn = (command, args, options) => {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: JSON.stringify(validEncode),
        stderr: "",
      };
    };
    try {
      const python = { command: "python.exe", args: [] };
      sqliteBackupWithQuickCheck({
        python,
        sourcePath: join(root, "source.db"),
        backupPath: join(root, "backup.db"),
        spawnFn,
      });
      sqliteRestoreWithQuickCheck({
        python,
        backupPath: join(root, "backup.db"),
        targetPath: join(root, "target.db"),
        spawnFn,
      });
      sqliteQuickCheck({
        python,
        databasePath: join(root, "target.db"),
        spawnFn,
      });
      await runCandidateOnnxSentinel({
        pythonPath: python,
        workDir: join(root, "sentinel"),
        offline: false,
        spawnFn,
      });
      assert.equal(calls.length, 4);
      for (const { options } of calls) {
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        assert.ok(Number.isFinite(options.timeout) && options.timeout > 0);
      }
      assert.equal(calls[0].options.timeout, MCP_MEMORY_SQLITE_TIMEOUT_MS);
      assert.equal(calls.at(-1).options.timeout, MCP_MEMORY_SUBPROCESS_TIMEOUT_MS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovery rejects transaction traversal and arbitrary executable or database bindings", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-recovery-binding-"));
    const transactionId = "update-1785103594775-101980";
    const oldBin = join(root, "trusted", "old", "memory.exe");
    const python = join(root, "trusted", "python.exe");
    const databasePath = join(root, "trusted", "memory.db");
    const candidateRoot = join(root, "memory-runtimes", transactionId);
    const candidateBin = join(candidateRoot, "Scripts", "memory.exe");
    const mcpPath = join(root, "project", ".mcp.json");
    const statePath = join(root, "state.json");
    for (const filePath of [oldBin, python, candidateBin]) {
      mkdirSync(resolve(filePath, ".."), { recursive: true });
      writeFileSync(filePath, "fixture");
    }
    const recovery = {
      transactionId,
      oldMemoryBin: oldBin,
      oldPython: { command: python, args: [] },
      candidateMemoryBin: candidateBin,
      databasePath,
      mcpPath,
      stateSnapshot: { filePath: statePath },
      bootSnapshots: [],
    };
    const validate = (overrides = {}) => validateMcpMemoryRecoveryMaterial({
      transactionRoot: root,
      evidenceName: `${transactionId}.json`,
      transactionId,
      recovery,
      expectedOldMemoryBin: oldBin,
      expectedPython: { command: python, args: [] },
      expectedDatabasePath: databasePath,
      expectedCandidateRoot: candidateRoot,
      expectedMcpPath: mcpPath,
      expectedSnapshotPaths: [statePath],
      platformName: "win32",
      ...overrides,
    });
    try {
      assert.equal(validate().ok, true);
      assert.equal(validate({ transactionId: "../evil" }).reason, "transaction_id_invalid");
      assert.equal(validate({ evidenceName: `../${transactionId}.json` }).reason, "evidence_name_mismatch");
      assert.equal(validate({ recovery: { ...recovery, oldMemoryBin: python } }).reason, "recovery_binding_mismatch");
      assert.equal(validate({ recovery: { ...recovery, databasePath: join(root, "victim.db") } }).reason, "recovery_binding_mismatch");
      assert.equal(validate({ recovery: { ...recovery, oldPython: { command: oldBin, args: [] } } }).reason, "recovery_binding_mismatch");
      assert.equal(validate({ recovery: { ...recovery, candidateMemoryBin: oldBin } }).reason, "recovery_binding_mismatch");
      assert.equal(validate({ recovery: { ...recovery, bootSnapshots: {} } }).reason, "recovery_binding_mismatch");
      assert.equal(validate({ recovery: { ...recovery, oldPython: { command: python, args: {} } } }).reason, "recovery_binding_mismatch");
      assert.equal(validate({ recovery: null }).reason, "recovery_binding_mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F6 candidate install failure preserves the old runtime without stopping it", async () => {
    const { result, calls, evidence } = await runFixture({
      prepareCandidate: async () => ({ ok: false }),
    });
    assert.equal(result.status, "failed_old_runtime_preserved");
    assert.equal(result.code, "F6_candidate_install_failed");
    assert.equal(calls.includes("stopOldRuntime"), false);
    assert.equal(evidence.oldRuntimePreservedUntilStop, true);
  });

  test("candidate dependency probe failure preserves its specific code and evidence", async () => {
    const { result, calls, evidence } = await runFixture({
      prepareCandidate: async () => ({
        ok: false,
        code: "mcp_memory_dependency_probe_failed",
        stage: "dependency_probe",
        repairReason: "complete_same_version_x64_crt_bundle_not_found",
      }),
    });
    assert.equal(result.status, "failed_old_runtime_preserved");
    assert.equal(result.code, "mcp_memory_dependency_probe_failed");
    assert.equal(calls.includes("stopOldRuntime"), false);
    const failure = evidence.events.find(({ stage }) => stage === "candidate_prepare_failed");
    assert.deepEqual(failure && {
      code: failure.code,
      failureStage: failure.failureStage,
      repairReason: failure.repairReason,
    }, {
      code: "mcp_memory_dependency_probe_failed",
      failureStage: "dependency_probe",
      repairReason: "complete_same_version_x64_crt_bundle_not_found",
    });
  });

  test("persisted candidate repair evidence contains no machine-local paths", async () => {
    const repairEvidence = {
      sourceKind: "visual_studio_official_redist",
      bundleName: "Microsoft.VC145.CRT",
      msvcVersion: "14.51.36231",
      dllVersion: "14.51.36231.0",
      copiedDlls: ["vcruntime140.dll"],
      signatures: [{
        dllName: "vcruntime140.dll",
        status: "Valid",
        signerThumbprintDigest: "a".repeat(64),
        targetPath: "C:\\Users\\Kim\\candidate\\vcruntime140.dll",
      }],
      reason: "windows_app_local_crt_verified",
    };
    const { evidence } = await runFixture({
      prepareCandidate: async () => ({
        ok: true,
        identity: "candidate-v2",
        reconciliationStage: "verified_after_windows_app_local_crt",
        reconciliationCode: "mcp_memory_verified_after_windows_app_local_crt",
        repairEvidence,
      }),
    });
    const installed = evidence.events.find(({ stage }) => stage === "candidate_installed");
    assert.deepEqual(installed.repairEvidence, {
      ...repairEvidence,
      signatures: [{
        dllName: "vcruntime140.dll",
        status: "Valid",
        signerThumbprintDigest: "a".repeat(64),
      }],
    });
    assert.equal(Object.hasOwn(installed.repairEvidence, "bundlePath"), false);
    assert.equal(Object.hasOwn(installed.repairEvidence, "capiPath"), false);
  });

  test("the complete persisted transaction evidence replaces every runtime path with digests", async () => {
    const { evidence } = await runFixture({
      prepareCandidate: async () => ({
        ok: true,
        identity: "C:\\Users\\Kim\\.meta-kim\\candidate-v2",
      }),
      persistRecoverySnapshots: async () => ({
        ok: true,
        identity: "D:\\private\\recovery.json",
      }),
      stopOldRuntime: async () => ({
        ok: true,
        evidence: {
          pid: 42,
          startIdentity: "C:\\Users\\Kim\\process-start",
          executablePath: "C:\\Users\\Kim\\memory.exe",
          host: "127.0.0.1",
          port: "8000",
        },
      }),
      backupDatabase: async () => ({
        ok: true,
        quickCheck: "ok",
        identity: "/home/kim/private/sqlite-backup.db",
      }),
    });
    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /[A-Z]:[\\/]/u);
    assert.doesNotMatch(serialized, /\/home\/kim|Users[\\/]Kim/iu);
    const candidate = evidence.events.find(({ stage }) => stage === "candidate_installed");
    const recovery = evidence.events.find(({ stage }) => stage === "recovery_snapshots_persisted");
    const stopped = evidence.events.find(({ stage }) => stage === "old_runtime_stopped");
    const backup = evidence.events.find(({ stage }) => stage === "database_backup_verified");
    assert.match(candidate.candidateIdentityDigest, /^[a-f0-9]{64}$/u);
    assert.match(recovery.identityDigest, /^[a-f0-9]{64}$/u);
    assert.match(stopped.stopEvidence.startIdentityDigest, /^[a-f0-9]{64}$/u);
    assert.match(stopped.stopEvidence.executableDigest, /^[a-f0-9]{64}$/u);
    assert.match(backup.backupIdentityDigest, /^[a-f0-9]{64}$/u);
  });

  test("F7 invalid online ONNX evidence preserves the old runtime", async () => {
    const { result, calls } = await runFixture({
      validateCandidateOnline: async () => ({ ...validEncode, modelClass: "HashEmbeddingModel" }),
    });
    assert.equal(result.code, "F7_candidate_online_encode_failed");
    assert.equal(calls.includes("stopOldRuntime"), false);
  });

  test("F8 boot-offline encode failure occurs before stop", async () => {
    const { result, calls } = await runFixture({
      validateCandidateBootOffline: async () => ({ ...validEncode, finite: false }),
    });
    assert.equal(result.code, "F8_candidate_offline_encode_failed");
    assert.equal(calls.includes("stopOldRuntime"), false);
  });

  test("post-stop candidate failure restores database, boot, state, and old health", async () => {
    const { result, calls } = await runFixture({
      verifyCandidateHealthy: async () => false,
    });
    assert.equal(result.status, "rolled_back");
    assert.deepEqual(calls.slice(-7), [
      "stopCandidate",
      "verifyNoWriter",
      "restoreDatabase",
      "restoreBoot",
      "restoreState",
      "startOldRuntime",
      "verifyOldRuntimeHealthy",
    ]);
  });

  test("same-version running update keeps the endpoint transaction open through a post-switch readback", async () => {
    let writer = "old";
    const { result, evidence } = await runFixture({
      prepareCandidate: async () => ({
        ok: true,
        identity: "same-version-candidate",
        reconciliationStage: "verified",
        reconciliationCode: "same_version_reconciled",
      }),
      stopOldRuntime: async () => {
        assert.equal(writer, "old");
        writer = "none";
        return { ok: true, evidence: { pid: 10 } };
      },
      startCandidate: async () => {
        writer = "candidate";
        return { ok: true };
      },
      verifyCandidateHealthy: async () => writer === "candidate",
      stopCandidate: async () => {
        writer = "none";
        return { ok: true, stopped: true };
      },
      startOldRuntime: async () => {
        writer = "old";
        return { ok: true };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, "committed");
    assert.ok(evidence.events.some(({ stage }) => stage === "candidate_post_switch_verified"));
    assert.equal(writer, "candidate");
  });

  test("post-switch health or identity failure rolls back the old runtime", async () => {
    let verificationCount = 0;
    const { result, calls } = await runFixture({
      verifyCandidateHealthy: async () => {
        verificationCount += 1;
        return verificationCount === 1;
      },
    });
    assert.equal(result.code, "candidate_post_switch_verification_failed");
    assert.equal(result.status, "rolled_back");
    assert.deepEqual(calls.slice(-7), [
      "stopCandidate",
      "verifyNoWriter",
      "restoreDatabase",
      "restoreBoot",
      "restoreState",
      "startOldRuntime",
      "verifyOldRuntimeHealthy",
    ]);
  });

  test("rollback releases the exact candidate listener before restarting the old runtime", async () => {
    let portOccupied = true;
    const { result } = await runFixture({
      verifyCandidateHealthy: async () => false,
      stopCandidate: async () => {
        portOccupied = false;
        return { ok: true, stopped: true };
      },
      verifyNoWriter: async () => {
        assert.equal(portOccupied, false);
        return true;
      },
      startOldRuntime: async () => {
        assert.equal(portOccupied, false);
        return { ok: true };
      },
    });
    assert.equal(result.status, "rolled_back");
  });

  test("rollback stops immediately when candidate stop or endpoint release fails", async () => {
    for (const failure of ["stop", "release"]) {
      const { result, calls, evidence } = await runFixture({
        verifyCandidateHealthy: async () => false,
        stopCandidate: async () => (
          failure === "stop" ? { ok: false, stopped: false } : { ok: true, stopped: true }
        ),
        verifyNoWriter: async () => failure !== "release",
      });
      assert.equal(result.status, "rollback_failed");
      assert.equal(result.code, "F9_rollback_failed");
      assert.equal(evidence.status, "rollback_failed");
      assert.equal(calls.includes("restoreDatabase"), false);
      assert.equal(calls.includes("restoreBoot"), false);
      assert.equal(calls.includes("restoreState"), false);
      assert.equal(calls.includes("startOldRuntime"), false);
      assert.equal(calls.includes("verifyOldRuntimeHealthy"), false);
      assert.ok(result.rollbackErrors.some(({ stage }) => (
        stage === (failure === "stop" ? "candidate_stopped_for_rollback" : "rollback_endpoint_released")
      )));
    }
  });

  test("stop precedes backup and candidate identity health precedes MCP, boot, and active state", async () => {
    const { result, calls } = await runFixture();
    assert.equal(result.status, "committed");
    const order = (name) => calls.indexOf(name);
    assert.ok(order("stopOldRuntime") < order("backupDatabase"));
    assert.ok(order("backupDatabase") < order("startCandidate"));
    assert.ok(order("verifyCandidateHealthy") < order("updateMcpConfig"));
    assert.ok(order("updateMcpConfig") < order("configureCandidateBoot"));
    assert.ok(order("configureCandidateBoot") < order("writeActiveState"));
    assert.ok(order("writeActiveState") < order("cleanupSensitiveArtifacts"));
  });

  test("F9 rollback failure fails closed and retains recovery evidence", async () => {
    const { result, evidence, calls } = await runFixture({
      verifyCandidateHealthy: async () => false,
      restoreDatabase: async () => ({ ok: false }),
    });
    assert.equal(result.status, "rollback_failed");
    assert.equal(result.code, "F9_rollback_failed");
    assert.ok(result.rollbackErrors.some(({ stage }) => stage === "database_restored"));
    assert.equal(evidence.status, "rollback_failed");
    assert.equal(calls.includes("restoreBoot"), false);
    assert.equal(calls.includes("restoreState"), false);
    assert.equal(calls.includes("startOldRuntime"), false);
    assert.equal(calls.includes("verifyOldRuntimeHealthy"), false);
  });

  test("evidence write failure after stop cannot skip rollback", async () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-memory-evidence-failure-"));
    const fixture = fixtureAdapters();
    let writes = 0;
    try {
      const result = await runMcpMemoryUpgradeTransaction({
        transactionRoot: root,
        adapters: fixture.adapters,
        transactionId: "evidence-write-failure",
        writeEvidence: (filePath, payload) => {
          writes += 1;
          if (payload.stage === "old_runtime_stopped") throw new Error("disk full");
          writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
        },
      });
      assert.equal(result.status, "rolled_back");
      assert.ok(writes > 0);
      assert.deepEqual(fixture.calls.slice(-7), [
        "stopCandidate",
        "verifyNoWriter",
        "restoreDatabase",
        "restoreBoot",
        "restoreState",
        "startOldRuntime",
        "verifyOldRuntimeHealthy",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ONNX evidence rejects degraded, wrong model, non-finite, and mismatched vectors", () => {
    assert.equal(verifyOnnxEncodeEvidence(validEncode), true);
    assert.equal(verifyOnnxEncodeEvidence({ ...validEncode, degraded: true }), false);
    assert.equal(verifyOnnxEncodeEvidence({ ...validEncode, modelClass: "HashEmbeddingModel" }), false);
    assert.equal(verifyOnnxEncodeEvidence({ ...validEncode, finite: false }), false);
    assert.equal(verifyOnnxEncodeEvidence({ ...validEncode, dimensionsMatch: false }), false);
  });

  test("candidate MCP config bypasses stale active runtime and binds candidate executable", () => {
    assert.match(setupSource, /function buildMcpMemoryServerConfig\([\s\S]*memoryBinOverride = null[\s\S]*preferActive = true/);
    assert.match(setupSource, /buildMcpMemoryServerConfig\(candidate\.resolved, \{\s*memoryBinOverride: candidate\.memoryBin,\s*preferActive: false/);
  });

  test("setup routes a live historical or same-version listener through the transaction authority gate", () => {
    assert.match(setupSource, /async function planMcpMemoryUpdateRoute\(/u);
    assert.match(setupSource, /await planMcpMemoryUpdateRoute\(/u);
    assert.match(setupSource, /oldMemoryBinOverride: updateRoute\.oldMemoryBin/u);
    assert.match(setupSource, /requireRuntimeAuthority: true/u);
    assert.match(setupSource, /runtime_manifest_boot_chain_unverified/u);
    assert.match(setupSource, /await probeMcpMemoryHealth\(endpoint\.healthUrl\)/u);
    assert.match(setupSource, /await adoptHistoricalWindowsMcpMemoryBootArtifactOwnership\(/u);
    assert.match(setupSource, /manifestEntries: authority\.manifest\.entries/u);
    assert.match(setupSource, /async function verifyEndpointRuntimeHealthy\(/u);
    assert.match(setupSource, /timeoutMs: 5_000,[\s\S]*?pollIntervalMs: 250/u);
    assert.match(setupSource, /verifyCandidateHealthy: \(candidate\) =>\s*verifyEndpointRuntimeHealthy/u);
    assert.match(setupSource, /if \(listener\?\.kind !== "listening"\)/u);
    assert.match(setupSource, /update refused: \$\{updateRoute\.reason\}/u);
  });

  test("global Memory lifecycle state never mutates the immutable package or caller project root", () => {
    assert.match(
      setupSource,
      /function mcpMemoryRuntimeConfigPath\(\) \{\s*return join\(homedir\(\), "\.meta-kim", "mcp-memory-runtime-config\.json"\);\s*\}/u,
    );
    const installStart = setupSource.indexOf("async function installMcpMemoryServiceStep(");
    const installEnd = setupSource.indexOf("function ensureNetworkxCompatibility", installStart);
    const installStep = setupSource.slice(installStart, installEnd);
    assert.match(installStep, /const mcpPath = mcpMemoryRuntimeConfigPath\(\)/u);
    assert.doesNotMatch(installStep, /join\(PROJECT_DIR, "\.mcp\.json"\)/u);
    const recoveryStart = setupSource.indexOf("async function recoverIncompleteMcpMemoryTransaction");
    const recoveryEnd = setupSource.indexOf("async function runTransactionalMcpMemoryUpdate", recoveryStart);
    const recoveryStep = setupSource.slice(recoveryStart, recoveryEnd);
    assert.match(recoveryStep, /expectedMcpPath: mcpMemoryRuntimeConfigPath\(\)/u);
    assert.doesNotMatch(recoveryStep, /join\(PROJECT_DIR, "\.mcp\.json"\)/u);
  });

  test("recovery snapshot stores only the MCP memory entry, not the whole MCP file", () => {
    const start = setupSource.indexOf("function persistMcpMemoryRecoverySnapshots");
    const end = setupSource.indexOf("async function recoverIncompleteMcpMemoryTransaction", start);
    const persistence = setupSource.slice(start, end);
    assert.match(persistence, /mcpMemoryEntrySnapshot/);
    assert.doesNotMatch(persistence, /mcpSnapshot|readFileSync\(mcpPath/);
  });

  test("custom database path is persisted into live env, every boot launcher, active state, and recovery", () => {
    assert.match(setupSource, /MCP_MEMORY_SQLITE_PATH: databasePath/);
    assert.match(setupSource, /env: \{ MCP_MEMORY_SQLITE_PATH: databasePath \}/);
    assert.match(setupSource, /renderCurrentWindowsMcpMemoryPowerShellBytes\(\{[\s\S]*?databasePath/);
    assert.match(bootArtifactsSource, /\$env:MCP_MEMORY_SQLITE_PATH =/);
    assert.match(setupSource, /export MCP_MEMORY_SQLITE_PATH=/);
    assert.match(setupSource, /<key>MCP_MEMORY_SQLITE_PATH<\/key>/);
    assert.match(setupSource, /databasePath,\s*activatedAt/);
    assert.match(setupSource, /preferredPath: activeOldRuntime\?\.databasePath/);
  });

  test("incomplete recovery locks the endpoint and stops an exact live writer before restore", () => {
    const start = setupSource.indexOf("async function recoverIncompleteMcpMemoryTransaction");
    const end = setupSource.indexOf("async function runTransactionalMcpMemoryUpdate", start);
    const recovery = setupSource.slice(start, end);
    assert.doesNotMatch(recovery, /await probeMcpMemoryHealth\(endpoint\.healthUrl\)\) return true/);
    assert.match(recovery, /acquireEndpointStartLock/);
    assert.match(recovery, /candidateMemoryBin/);
    assert.match(recovery, /verifyMemoryListenerIdentity/);
    assert.match(recovery, /stopVerifiedEndpointProcess/);
    assert.ok(recovery.indexOf("stopVerifiedEndpointProcess") < recovery.indexOf("sqliteRestoreWithQuickCheck"));
    assert.match(recovery, /lockAlreadyHeld: true/);
  });

  test("private transaction files are restrictive and conservative retention leaves user backups", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-private-transaction-"));
    try {
      const evidencePath = join(root, "owned.json");
      writeJsonAtomic(evidencePath, {
        schemaVersion: "meta-kim-mcp-memory-upgrade-v1",
        transactionId: "owned",
        status: "rollback_failed",
      });
      const recoveryPath = join(root, "owned-recovery.json");
      const backupPath = join(root, "owned-sqlite-backup.db");
      const userBackup = join(root, "my-independent-backup.db");
      writeJsonAtomic(recoveryPath, { schemaVersion: "meta-kim-mcp-memory-recovery-v1" });
      writeFileSync(backupPath, "owned", { mode: 0o600 });
      writeFileSync(userBackup, "user", { mode: 0o600 });
      if (process.platform !== "win32") {
        assert.equal(statSync(evidencePath).mode & 0o777, 0o600);
      }
      const old = new Date(0);
      for (const filePath of [evidencePath, recoveryPath, backupPath]) utimesSync(filePath, old, old);
      cleanupExpiredMcpMemoryRecoveryArtifacts({ transactionRoot: root, now: Date.now(), retentionMs: 1 });
      assert.equal(existsSync(evidencePath), false);
      assert.equal(existsSync(recoveryPath), false);
      assert.equal(existsSync(backupPath), false);
      assert.equal(existsSync(userBackup), true);
      if (process.platform !== "win32") {
        assert.equal(statSync(root).mode & 0o777, 0o700);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("successful commit removes recovery snapshot and database backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-success-cleanup-"));
    const fixture = fixtureAdapters();
    const recoveryPath = join(root, "success-recovery.json");
    const backupPath = join(root, "success-sqlite-backup.db");
    writeFileSync(recoveryPath, "sensitive");
    writeFileSync(backupPath, "sensitive");
    fixture.adapters.cleanupSensitiveArtifacts = async () => {
      fixture.calls.push("cleanupSensitiveArtifacts");
      rmSync(recoveryPath, { force: true });
      rmSync(backupPath, { force: true });
      return true;
    };
    try {
      const result = await runMcpMemoryUpgradeTransaction({
        transactionRoot: root,
        adapters: fixture.adapters,
        transactionId: "success",
      });
      assert.equal(result.status, "committed");
      assert.equal(existsSync(recoveryPath), false);
      assert.equal(existsSync(backupPath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("candidate-healthy crash recovery stops the live writer before database restore", async () => {
    const calls = [];
    const action = (name, result = true) => async () => { calls.push(name); return result; };
    const result = await runMcpMemoryRecoveryProtocol({
      adapters: {
        acquireTransactionLock: action("lock", { acquired: true, token: "fixture" }),
        releaseTransactionLock: action("unlock"),
        inspectWriter: action("inspect", { kind: "candidate" }),
        stopWriter: action("stopCandidate", { ok: true }),
        verifyNoWriter: action("verifyNoWriter", true),
        restoreDatabase: action("restoreDatabase", true),
        restoreMcpEntry: action("restoreMcp", true),
        restoreBootAndActiveState: action("restoreState", true),
        startOldRuntime: action("startOld", { ok: true }),
        verifyOldRuntime: action("verifyOld", true),
        markRecovered: action("markRecovered", true),
      },
    });
    assert.equal(result.ok, true);
    assert.ok(calls.indexOf("stopCandidate") < calls.indexOf("restoreDatabase"));
    assert.equal(calls.at(-1), "unlock");
  });

  test("legacy recovery journal fails preflight without stopping a live candidate", async () => {
    const calls = [];
    const result = await runMcpMemoryRecoveryProtocol({
      preflight: async () => ({ ok: false, reason: "recovery_digest_missing" }),
      adapters: {
        acquireTransactionLock: async () => { calls.push("lock"); return { acquired: true }; },
        inspectWriter: async () => { calls.push("inspect_live_candidate"); return { kind: "candidate" }; },
        stopWriter: async () => { calls.push("stop_live_candidate"); return { ok: true }; },
      },
    });
    assert.deepEqual(result, { ok: false, reason: "recovery_digest_missing" });
    assert.deepEqual(calls, []);
  });

  test("recovery cannot race a boot owner holding the endpoint lock", async () => {
    const calls = [];
    const result = await runMcpMemoryRecoveryProtocol({
      adapters: {
        acquireTransactionLock: async () => { calls.push("lock"); return { acquired: false }; },
        releaseTransactionLock: async () => { calls.push("unlock"); },
      },
    });
    assert.deepEqual(result, { ok: false, reason: "recovery_lock_unavailable" });
    assert.deepEqual(calls, ["lock"]);
  });

  test("recovery fails closed on an unknown endpoint listener", async () => {
    const calls = [];
    const result = await runMcpMemoryRecoveryProtocol({
      adapters: {
        acquireTransactionLock: async () => ({ acquired: true }),
        releaseTransactionLock: async () => { calls.push("unlock"); },
        inspectWriter: async () => ({ kind: "unknown" }),
      },
    });
    assert.deepEqual(result, { ok: false, reason: "unknown_listener" });
    assert.deepEqual(calls, ["unlock"]);
  });

  test("setup treats only explicit not-listening inspection as a released endpoint", () => {
    assert.match(setupSource, /import \{[\s\S]*isEndpointNotListening,[\s\S]*\} from "\.\/scripts\/mcp-memory-process-control\.mjs"/u);
    assert.match(setupSource, /if \(isEndpointNotListening\(listener\)\) return \{ kind: "none" \}/u);
    assert.match(setupSource, /if \(listener\?\.kind !== "listening"\) return \{ kind: "unknown" \}/u);
    assert.equal(
      (setupSource.match(/verifyNoWriter: async \(\) => isEndpointNotListening\(inspectEndpointListener\(endpoint\)\)/gu) ?? []).length,
      2,
    );
    assert.doesNotMatch(setupSource, /verifyNoWriter: async \(\) => !inspectEndpointListener/u);
  });
});
