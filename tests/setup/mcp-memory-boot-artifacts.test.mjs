import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MCP_MEMORY_BOOT_ARTIFACT_CATEGORY,
  MCP_MEMORY_BOOT_ARTIFACT_KIND,
  MCP_MEMORY_BOOT_ARTIFACT_OWNERSHIP_CLASS,
  MCP_MEMORY_BOOT_ARTIFACT_RUNTIME_TARGET,
  MCP_MEMORY_BOOT_ARTIFACT_SOURCE,
  adoptHistoricalWindowsMcpMemoryBootArtifactOwnership,
  classifyMcpMemoryBootRecoveryFile,
  collectMcpMemoryBootRecoveryFindings,
  collectOrphanMcpMemoryBootLaunchers,
  isExactMcpMemoryBootManifestIdentity,
  recordMcpMemoryBootArtifactOwnership,
  repairOrphanMcpMemoryBootLaunchers,
  renderCurrentWindowsMcpMemoryCommandBytes,
  renderCurrentWindowsMcpMemoryPowerShellBytes,
  renderCurrentWindowsMcpMemoryStartupVbsBytes,
  renderHistoricalWindowsMcpMemoryPowerShellBytesV1,
  resolveMcpMemoryBootArtifactDescriptors,
  snapshotMcpMemoryBootArtifactFile,
} from "../../scripts/mcp-memory-boot-artifacts.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function currentPlatformFixture() {
  const homeRoot = mkdtempSync(path.join(tmpdir(), "meta-kim-memory-boot-native-"));
  const descriptors = resolveMcpMemoryBootArtifactDescriptors({
    homeRoot,
    platformName: process.platform,
  });
  for (const entry of descriptors) mkdirSync(path.dirname(entry.path), { recursive: true });
  return { homeRoot, descriptors };
}

function windowsFixture() {
  const homeRoot = mkdtempSync(path.join(tmpdir(), "meta-kim-memory-boot-"));
  const descriptors = resolveMcpMemoryBootArtifactDescriptors({ homeRoot, platformName: "win32" });
  const byId = new Map(descriptors.map((entry) => [entry.id, entry]));
  const startupDir = path.win32.dirname(byId.get("windows-startup").path);
  const legacyCommand = path.win32.join(startupDir, "mcp-memory-start.cmd");
  for (const entry of descriptors) mkdirSync(path.win32.dirname(entry.path), { recursive: true });
  return { homeRoot, descriptors, byId, startupDir, legacyCommand };
}

function powerShellOptions(homeRoot, {
  runtimeDir = path.win32.join(homeRoot, ".meta-kim", "memory-venv"),
  databasePath = path.win32.join(homeRoot, "memory", "sqlite_vec.db"),
} = {}) {
  const endpointUrl = "http://localhost:8000";
  const healthUrl = `${endpointUrl}/api/health`;
  return {
    memoryBin: path.win32.join(runtimeDir, "Scripts", "memory.exe"),
    databasePath,
    endpointUrl,
    healthUrl,
    hostname: "localhost",
    port: "8000",
    failureMessage: `Meta_Kim MCP Memory Service failed to start or did not become healthy at ${healthUrl}. Please start it manually: MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http`,
    lockDir: path.win32.join(homeRoot, ".meta-kim", "locks", "mcp-memory-localhost-8000.lock"),
  };
}

function currentPowerShell(homeRoot) {
  return renderCurrentWindowsMcpMemoryPowerShellBytes(powerShellOptions(homeRoot));
}

test("Windows health probe bypasses system proxy and rejects non-success HTTP responses", () => {
  const script = currentPowerShell("C:\\Users\\Fixture").toString("utf8");
  assert.match(script, /\[System\.Net\.Http\.HttpClientHandler\]::new\(\)/u);
  assert.match(script, /\$handler\.UseProxy = \$false/u);
  assert.match(script, /\$client\.GetAsync\('http:\/\/localhost:8000\/api\/health'\)\.GetAwaiter\(\)\.GetResult\(\)/u);
  assert.match(script, /\$statusCode -ge 200 -and \$statusCode -lt 300/u);
  assert.match(script, /\$response\.Content\.ReadAsStringAsync\(\)\.GetAwaiter\(\)\.GetResult\(\) \| ConvertFrom-Json/u);
  assert.match(script, /catch \{ return \$false \}/u);
  assert.doesNotMatch(script, /Invoke-WebRequest/u);
});

test("current descriptors are exact, stable, and platform-specific", () => {
  const cases = [
    ["win32", "C:\\Users\\Fixture", 3],
    ["darwin", "/Users/fixture", 2],
    ["linux", "/home/fixture", 2],
  ];
  for (const [platformName, homeRoot, count] of cases) {
    const descriptors = resolveMcpMemoryBootArtifactDescriptors({ homeRoot, platformName });
    assert.equal(descriptors.length, count);
    for (const entry of descriptors) {
      assert.equal(entry.source, MCP_MEMORY_BOOT_ARTIFACT_SOURCE);
      assert.equal(entry.category, MCP_MEMORY_BOOT_ARTIFACT_CATEGORY);
      assert.equal(entry.kind, MCP_MEMORY_BOOT_ARTIFACT_KIND);
      assert.equal(entry.ownershipClass, MCP_MEMORY_BOOT_ARTIFACT_OWNERSHIP_CLASS);
      assert.equal(entry.runtimeTarget, MCP_MEMORY_BOOT_ARTIFACT_RUNTIME_TARGET);
    }
  }
  assert.throws(
    () => resolveMcpMemoryBootArtifactDescriptors({ homeRoot: "relative", platformName: "win32" }),
    /homeRoot must be absolute/u,
  );
});

test("manifest identity validation rejects every widened ownership boundary", () => {
  const homeRoot = "C:\\Users\\Fixture";
  const entry = resolveMcpMemoryBootArtifactDescriptors({ homeRoot, platformName: "win32" })[0];
  assert.equal(isExactMcpMemoryBootManifestIdentity(entry, { homeRoot, platformName: "win32" }), true);
  const mutations = {
    path: `${entry.path}.other`,
    source: "setup.mjs",
    purpose: `${entry.purpose}:other`,
    category: "C",
    kind: "dir",
    ownershipClass: "runtime_sedimented_project_copy",
    runtimeTarget: "claude",
  };
  for (const [field, value] of Object.entries(mutations)) {
    assert.equal(
      isExactMcpMemoryBootManifestIdentity({ ...entry, [field]: value }, { homeRoot, platformName: "win32" }),
      false,
      field,
    );
  }
});

test("future ownership snapshots every complete boot artifact before recording and awaits flush", async () => {
  const fixture = currentPlatformFixture();
  try {
    for (const entry of fixture.descriptors) writeFileSync(entry.path, `${entry.id}\n`);
    const calls = [];
    let recorderOptions = null;
    let flushed = false;
    const result = await recordMcpMemoryBootArtifactOwnership({
      homeRoot: fixture.homeRoot,
      platformName: process.platform,
      metaKimVersion: "fixture-version",
      recorderFactory: (options) => {
        recorderOptions = options;
        return {
          recordFile: (filePath, identity) => calls.push({ filePath, identity }),
          flush: async () => {
            flushed = true;
            return { ok: true, path: path.join(fixture.homeRoot, ".meta-kim", "install-manifest.json") };
          },
        };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(flushed, true);
    assert.deepEqual(recorderOptions, { scope: "global", metaKimVersion: "fixture-version" });
    assert.deepEqual(calls, fixture.descriptors.map((entry) => {
      const bytes = readFileSync(entry.path);
      return {
        filePath: entry.path,
        identity: {
        source: entry.source,
        purpose: entry.purpose,
        category: entry.category,
        kind: entry.kind,
        size: bytes.length,
        sha256: sha256(bytes),
        ownershipClass: entry.ownershipClass,
        runtimeTarget: entry.runtimeTarget,
        },
      };
    }));
    assert.equal(calls.every(({ identity }) => /^[a-f0-9]{64}$/u.test(identity.sha256)), true);
  } finally {
    rmSync(fixture.homeRoot, { recursive: true, force: true });
  }
});

test("a linked .meta-kim ancestor blocks snapshot, ownership, and Windows recovery", async (context) => {
  const fixture = currentPlatformFixture();
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "meta-kim-memory-boot-outside-"));
  const linkedMetaKim = path.join(fixture.homeRoot, ".meta-kim");
  try {
    rmSync(linkedMetaKim, { recursive: true, force: true });
    try {
      symlinkSync(outsideRoot, linkedMetaKim, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
        context.skip(`link creation is unavailable on this host: ${error.code}`);
        return;
      }
      throw error;
    }
    for (const entry of fixture.descriptors) {
      mkdirSync(path.dirname(entry.path), { recursive: true });
      writeFileSync(entry.path, `${entry.id}\n`);
    }
    assert.throws(
      () => snapshotMcpMemoryBootArtifactFile({
        filePath: fixture.descriptors[0].path,
        homeRoot: fixture.homeRoot,
        platformName: process.platform,
      }),
      /linked_directory_ancestor|unsafe_directory_type/u,
    );
    let recorderOpened = false;
    const ownership = await recordMcpMemoryBootArtifactOwnership({
      homeRoot: fixture.homeRoot,
      platformName: process.platform,
      recorderFactory: () => {
        recorderOpened = true;
        throw new Error("unsafe chain must not open recorder");
      },
    });
    assert.equal(ownership.status, "boot_artifacts_incomplete");
    assert.equal(recorderOpened, false);

    if (process.platform === "win32") {
      const byId = new Map(fixture.descriptors.map((entry) => [entry.id, entry.path]));
      writeFileSync(
        byId.get("windows-command"),
        renderCurrentWindowsMcpMemoryCommandBytes({ powershellPath: byId.get("windows-powershell") }),
      );
      const findings = collectMcpMemoryBootRecoveryFindings({
        homeRoot: fixture.homeRoot,
        platformName: "win32",
      });
      assert.equal(findings.some((entry) => entry.path === byId.get("windows-command")), false);
    }
  } finally {
    rmSync(fixture.homeRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("remote endpoints skip local boot ownership without touching artifacts or recorder", async () => {
  let recorderOpened = false;
  let statCalled = false;
  const result = await recordMcpMemoryBootArtifactOwnership({
    homeRoot: "C:\\Users\\RemoteFixture",
    platformName: "win32",
    metaKimVersion: "fixture-version",
    canAutoStart: false,
    recorderFactory: () => {
      recorderOpened = true;
      throw new Error("remote endpoint must not open a recorder");
    },
    lstat: () => {
      statCalled = true;
      throw new Error("remote endpoint must not inspect local artifacts");
    },
  });
  assert.deepEqual(result, {
    ok: true,
    status: "not_applicable_remote_endpoint",
    descriptors: [],
    manifestPath: null,
  });
  assert.equal(recorderOpened, false);
  assert.equal(statCalled, false);
});

test("future ownership fails closed for incomplete, unsafe, record, and flush failures", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = windowsFixture();
  try {
    for (const entry of fixture.descriptors) writeFileSync(entry.path, `${entry.id}\n`);
    rmSync(fixture.descriptors[0].path, { force: true });
    let recorderOpened = false;
    const incomplete = await recordMcpMemoryBootArtifactOwnership({
      homeRoot: fixture.homeRoot,
      platformName: "win32",
      recorderFactory: () => {
        recorderOpened = true;
        throw new Error("must not open");
      },
    });
    assert.equal(incomplete.status, "boot_artifacts_incomplete");
    assert.equal(recorderOpened, false);

    writeFileSync(fixture.descriptors[0].path, "restored\n");
    const unsafePath = fixture.descriptors[1].path;
    const unsafe = await recordMcpMemoryBootArtifactOwnership({
      homeRoot: fixture.homeRoot,
      platformName: "win32",
      lstat: (filePath) => filePath === unsafePath
        ? { isFile: () => true, isSymbolicLink: () => true }
        : { isFile: () => true, isSymbolicLink: () => false },
      recorderFactory: () => { throw new Error("must not open"); },
    });
    assert.equal(unsafe.status, "boot_artifacts_incomplete");

    const recordFailure = await recordMcpMemoryBootArtifactOwnership({
      homeRoot: fixture.homeRoot,
      platformName: "win32",
      recorderFactory: () => ({
        recordFile: () => { throw new Error("record denied"); },
        flush: async () => ({ ok: true }),
      }),
    });
    assert.equal(recordFailure.status, "manifest_record_failed");
    assert.match(recordFailure.error, /record denied/u);

    const flushFailure = await recordMcpMemoryBootArtifactOwnership({
      homeRoot: fixture.homeRoot,
      platformName: "win32",
      recorderFactory: () => ({
        recordFile: () => {},
        flush: async () => ({ ok: false, error: "disk full" }),
      }),
    });
    assert.equal(flushFailure.status, "manifest_flush_failed");
    assert.match(flushFailure.error, /disk full/u);

    const changedPath = fixture.descriptors[0].path;
    const concurrentChange = await recordMcpMemoryBootArtifactOwnership({
      homeRoot: fixture.homeRoot,
      platformName: "win32",
      recorderFactory: () => ({
        recordFile: () => {},
        flush: async () => {
          writeFileSync(changedPath, "changed while flushing\n");
          return { ok: true, path: path.join(fixture.homeRoot, ".meta-kim", "install-manifest.json") };
        },
      }),
    });
    assert.equal(concurrentChange.status, "boot_artifacts_changed_during_recording");
    assert.match(concurrentChange.error, /changed while ownership was being persisted/u);
  } finally {
    rmSync(fixture.homeRoot, { recursive: true, force: true });
  }
});

test("setup records global boot ownership before hooks at the successful common MCP Memory return", () => {
  const setupSource = readFileSync(path.resolve(import.meta.dirname, "../../setup.mjs"), "utf8");
  assert.match(setupSource, /from "\.\/scripts\/mcp-memory-boot-artifacts\.mjs"/u);
  assert.match(setupSource, /writeFileSync\(psPath, renderCurrentWindowsMcpMemoryPowerShellBytes\(\{[\s\S]*?memoryBin,[\s\S]*?databasePath,[\s\S]*?endpointUrl: endpoint\.endpointUrl,[\s\S]*?healthUrl: endpoint\.healthUrl,[\s\S]*?hostname: endpoint\.hostname,[\s\S]*?port: endpoint\.port,[\s\S]*?failureMessage,[\s\S]*?lockDir: startLockPath,[\s\S]*?bootEnv,[\s\S]*?\}\)\);/u);
  assert.match(setupSource, /writeFileSync\(cmdPath, renderCurrentWindowsMcpMemoryCommandBytes\(\{ powershellPath: psPath \}\)\);/u);
  assert.match(setupSource, /writeFileSync\(vbsPath, renderCurrentWindowsMcpMemoryStartupVbsBytes\(\{ commandPath: cmdPath \}\)\);/u);
  assert.doesNotMatch(setupSource, /\$ErrorActionPreference = "SilentlyContinue"\\r\\n/u);
  const start = setupSource.indexOf("async function installMcpMemoryServiceStep(");
  const end = setupSource.indexOf("function ensureNetworkxCompatibility", start);
  const step = setupSource.slice(start, end);
  assert.match(step, /if \(!registrationOk \|\| !backgroundOk\) return false;/u);
  assert.match(step, /await recordMcpMemoryBootArtifactOwnership\(\{[\s\S]*?homeRoot: homedir\(\)[\s\S]*?platformName: platform\(\)[\s\S]*?metaKimVersion: packageVersion/u);
  assert.match(step, /canAutoStart: memoryEndpoint\.canAutoStart/u);
  assert.match(step, /if \(!ownership\.ok\)[\s\S]*?return MCP_MEMORY_INSTALL_OUTCOME\.OWNERSHIP_FAILURE;/u);
  assert.match(step, /return registrationOk && hooksOk && backgroundOk;\s*\}/u);
  const backgroundGate = step.indexOf("if (!registrationOk || !backgroundOk) return false;");
  const ownershipCall = step.indexOf("await recordMcpMemoryBootArtifactOwnership(");
  const hookInstaller = step.indexOf("await runMcpMemoryHookInstaller(");
  const finalReturn = step.indexOf(
    "return registrationOk && hooksOk && backgroundOk;",
    hookInstaller,
  );
  assert.ok(backgroundGate < ownershipCall, "background success gate precedes ownership");
  assert.ok(ownershipCall < hookInstaller, "ownership is persisted before hook installation");
  assert.ok(hookInstaller < finalReturn, "hook outcome controls the final return");
});

test("orphan current Startup VBS classifies without its target and modified VBS is preserved", {
  skip: process.platform !== "win32",
}, () => {
  const fixture = windowsFixture();
  try {
    const vbsPath = fixture.byId.get("windows-startup").path;
    const commandPath = fixture.byId.get("windows-command").path;
    writeFileSync(vbsPath, renderCurrentWindowsMcpMemoryStartupVbsBytes({ commandPath }));
    const findings = collectMcpMemoryBootRecoveryFindings({ homeRoot: fixture.homeRoot, platformName: "win32" });
    assert.deepEqual(findings.map((entry) => entry.recoverySignature), ["current-windows-startup-vbs"]);
    assert.match(findings[0].sha256, /^[a-f0-9]{64}$/u);
    writeFileSync(vbsPath, `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${commandPath}""", 0, False\r\n' user change\r\n`);
    assert.deepEqual(collectMcpMemoryBootRecoveryFindings({ homeRoot: fixture.homeRoot, platformName: "win32" }), []);
  } finally {
    rmSync(fixture.homeRoot, { recursive: true, force: true });
  }
});

test("automatic repair removes only an exact orphan Startup VBS and is idempotent", {
  skip: process.platform !== "win32",
}, () => {
  const fixture = windowsFixture();
  try {
    const vbsPath = fixture.byId.get("windows-startup").path;
    const commandPath = fixture.byId.get("windows-command").path;
    writeFileSync(vbsPath, renderCurrentWindowsMcpMemoryStartupVbsBytes({ commandPath }));
    assert.deepEqual(
      collectOrphanMcpMemoryBootLaunchers({ homeRoot: fixture.homeRoot, platformName: "win32" })
        .map((entry) => entry.recoverySignature),
      ["current-windows-startup-vbs"],
    );

    const repaired = repairOrphanMcpMemoryBootLaunchers({
      homeRoot: fixture.homeRoot,
      platformName: "win32",
      randomId: () => "test-repair",
    });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.status, "repaired");
    assert.equal(existsSync(vbsPath), false);
    assert.deepEqual(
      repairOrphanMcpMemoryBootLaunchers({ homeRoot: fixture.homeRoot, platformName: "win32" }),
      { ok: true, status: "no_action", repaired: [] },
    );
  } finally {
    rmSync(fixture.homeRoot, { recursive: true, force: true });
  }
});

test("automatic repair preserves healthy, modified, and rollback-required launchers", {
  skip: process.platform !== "win32",
}, () => {
  const fixture = windowsFixture();
  try {
    const vbsPath = fixture.byId.get("windows-startup").path;
    const commandPath = fixture.byId.get("windows-command").path;
    const exactVbs = renderCurrentWindowsMcpMemoryStartupVbsBytes({ commandPath });
    writeFileSync(vbsPath, exactVbs);
    writeFileSync(commandPath, Buffer.from("user command\r\n", "utf8"));
    assert.deepEqual(
      collectOrphanMcpMemoryBootLaunchers({ homeRoot: fixture.homeRoot, platformName: "win32" }),
      [],
      "an existing target keeps the launcher outside automatic repair",
    );

    rmSync(commandPath, { force: true });
    writeFileSync(vbsPath, Buffer.concat([exactVbs, Buffer.from("' changed\r\n", "utf8")]));
    assert.deepEqual(
      collectOrphanMcpMemoryBootLaunchers({ homeRoot: fixture.homeRoot, platformName: "win32" }),
      [],
      "modified same-name content is user-owned",
    );

    writeFileSync(vbsPath, exactVbs);
    const failed = repairOrphanMcpMemoryBootLaunchers({
      homeRoot: fixture.homeRoot,
      platformName: "win32",
      randomId: () => "test-rollback",
      unlink: () => { throw new Error("simulated unlink failure"); },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.status, "repair_failed");
    assert.equal(existsSync(vbsPath), true, "failed quarantine deletion restores the launcher");
    assert.deepEqual(readFileSync(vbsPath), exactVbs);
  } finally {
    rmSync(fixture.homeRoot, { recursive: true, force: true });
  }
});

test("global install and update run automatic orphan repair before dependency work", () => {
  const setupSource = readFileSync(path.join(process.cwd(), "setup.mjs"), "utf8");
  const helper = setupSource.indexOf("function runAutomaticMcpMemoryBootRepair()");
  assert.ok(helper >= 0);
  const installStart = setupSource.indexOf("async function runInstall()");
  const updateStart = setupSource.indexOf("async function runUpdate()");
  const installRepair = setupSource.indexOf(
    'installStep("automatic MCP Memory boot repair", runAutomaticMcpMemoryBootRepair())',
    installStart,
  );
  const installMemory = setupSource.indexOf("installMcpMemoryServiceStep(false", installStart);
  const updateRepair = setupSource.indexOf(
    'installStep("automatic MCP Memory boot repair", runAutomaticMcpMemoryBootRepair())',
    updateStart,
  );
  const updateNpm = setupSource.indexOf("// ── 1. npm install", updateStart);
  assert.ok(installStart < installRepair && installRepair < installMemory);
  assert.ok(updateStart < updateRepair && updateRepair < updateNpm);
});

test("current Windows CMD and strong-marker PS1 classify only with exact generated relationships", {
  skip: process.platform !== "win32",
}, () => {
  const fixture = windowsFixture();
  try {
    const psPath = fixture.byId.get("windows-powershell").path;
    const commandPath = fixture.byId.get("windows-command").path;
    const psBytes = currentPowerShell(fixture.homeRoot);
    assert.deepEqual([...psBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(psBytes.toString("utf8").replaceAll("\r\n", "").includes("\n"), false);
    writeFileSync(psPath, psBytes);
    writeFileSync(commandPath, renderCurrentWindowsMcpMemoryCommandBytes({ powershellPath: psPath }));
    assert.deepEqual(
      collectMcpMemoryBootRecoveryFindings({ homeRoot: fixture.homeRoot, platformName: "win32" })
        .map((entry) => entry.recoverySignature),
      ["current-windows-powershell", "current-windows-command"],
    );
    assert.equal(classifyMcpMemoryBootRecoveryFile({ filePath: psPath, bytes: Buffer.concat([psBytes, Buffer.from("# changed\r\n")]), homeRoot: fixture.homeRoot, platformName: "win32" }), null);
    const catchRegion = '  } catch {}\r\n}\r\ntry {\r\n  New-Item -ItemType Directory';
    const attackedCatchRegion = '  } catch { Start-Process -FilePath "calc.exe" }\r\n}\r\ntry {\r\n  New-Item -ItemType Directory';
    const attackedPowerShell = Buffer.from(psBytes.toString("utf8").replace(catchRegion, attackedCatchRegion), "utf8");
    assert.notDeepEqual(attackedPowerShell, psBytes);
    assert.equal(classifyMcpMemoryBootRecoveryFile({ filePath: psPath, bytes: attackedPowerShell, homeRoot: fixture.homeRoot, platformName: "win32" }), null);
    assert.equal(classifyMcpMemoryBootRecoveryFile({ filePath: commandPath, bytes: Buffer.from(`@echo off\r\npowershell.exe -File "${psPath}"\r\n`), homeRoot: fixture.homeRoot, platformName: "win32" }), null);
  } finally {
    rmSync(fixture.homeRoot, { recursive: true, force: true });
  }
});

test("historical Windows boot adoption requires the complete exact chain and active runtime binding", {
  skip: process.platform !== "win32",
}, async () => {
  const fixture = windowsFixture();
  try {
    const runtimeDir = path.win32.join(
      fixture.homeRoot,
      ".meta-kim",
      "memory-runtimes",
      "update-1234567890123-4321",
    );
    const options = powerShellOptions(fixture.homeRoot, { runtimeDir });
    const pythonPath = path.win32.join(runtimeDir, "Scripts", "python.exe");
    mkdirSync(path.win32.dirname(options.memoryBin), { recursive: true });
    mkdirSync(path.win32.dirname(options.databasePath), { recursive: true });
    writeFileSync(options.memoryBin, "memory launcher\n");
    writeFileSync(pythonPath, "python launcher\n");
    writeFileSync(options.databasePath, "sqlite fixture\n");
    writeFileSync(
      fixture.byId.get("windows-powershell").path,
      renderHistoricalWindowsMcpMemoryPowerShellBytesV1(options),
    );
    writeFileSync(
      fixture.byId.get("windows-command").path,
      renderCurrentWindowsMcpMemoryCommandBytes({
        powershellPath: fixture.byId.get("windows-powershell").path,
      }),
    );
    writeFileSync(
      fixture.byId.get("windows-startup").path,
      renderCurrentWindowsMcpMemoryStartupVbsBytes({
        commandPath: fixture.byId.get("windows-command").path,
      }),
    );
    const activeStatePath = path.win32.join(
      fixture.homeRoot,
      ".meta-kim",
      "mcp-memory-active-runtime.json",
    );
    const activeState = {
      schemaVersion: "meta-kim-mcp-memory-active-runtime-v1",
      runtimeDir,
      pythonPath,
      memoryBin: options.memoryBin,
      databasePath: options.databasePath,
      activatedAt: "2026-07-31T04:45:15.055Z",
    };
    writeFileSync(activeStatePath, `${JSON.stringify(activeState, null, 2)}\n`);

    assert.deepEqual(
      collectMcpMemoryBootRecoveryFindings({
        homeRoot: fixture.homeRoot,
        platformName: "win32",
      }).map((entry) => entry.recoverySignature),
      [
        "historical-windows-powershell-proxy-v1",
        "current-windows-command",
        "current-windows-startup-vbs",
      ],
    );

    let recorderOptions;
    const recorded = [];
    const adopted = await adoptHistoricalWindowsMcpMemoryBootArtifactOwnership({
      homeRoot: fixture.homeRoot,
      platformName: "win32",
      metaKimVersion: "2.9.27",
      manifestEntries: [],
      expectedMemoryBin: options.memoryBin,
      expectedPythonPaths: [pythonPath],
      endpoint: {
        endpointUrl: options.endpointUrl,
        healthUrl: options.healthUrl,
        hostname: options.hostname,
        port: Number(options.port),
      },
      expectedLockDir: options.lockDir,
      recorderFactory: (received) => {
        recorderOptions = received;
        return {
          recordFile: (filePath, identity) => recorded.push({ filePath, identity }),
          flush: async () => ({
            ok: true,
            path: path.win32.join(fixture.homeRoot, ".meta-kim", "install-manifest.json"),
          }),
        };
      },
    });
    assert.equal(adopted.ok, true, adopted.error);
    assert.equal(adopted.status, "historical_boot_chain_adopted");
    assert.equal(recorderOptions.requireExistingValidManifest, true);
    assert.deepEqual(
      recorderOptions.expectedAbsentPaths,
      fixture.descriptors.map((entry) => entry.path),
    );
    assert.equal(recorded.length, 3);

    const collision = await adoptHistoricalWindowsMcpMemoryBootArtifactOwnership({
      homeRoot: fixture.homeRoot,
      platformName: "win32",
      metaKimVersion: "2.9.27",
      manifestEntries: [{ path: fixture.byId.get("windows-command").path }],
      expectedMemoryBin: options.memoryBin,
      expectedPythonPaths: [pythonPath],
      endpoint: {
        endpointUrl: options.endpointUrl,
        healthUrl: options.healthUrl,
        hostname: options.hostname,
        port: Number(options.port),
      },
      expectedLockDir: options.lockDir,
      recorderFactory: () => { throw new Error("must not record a claimed path"); },
    });
    assert.equal(collision.reason, "historical_boot_manifest_path_already_owned");

    writeFileSync(
      fixture.byId.get("windows-powershell").path,
      Buffer.concat([
        renderHistoricalWindowsMcpMemoryPowerShellBytesV1(options),
        Buffer.from("# user change\r\n"),
      ]),
    );
    const modified = await adoptHistoricalWindowsMcpMemoryBootArtifactOwnership({
      homeRoot: fixture.homeRoot,
      platformName: "win32",
      metaKimVersion: "2.9.27",
      manifestEntries: [],
      expectedMemoryBin: options.memoryBin,
      expectedPythonPaths: [pythonPath],
      endpoint: {
        endpointUrl: options.endpointUrl,
        healthUrl: options.healthUrl,
        hostname: options.hostname,
        port: Number(options.port),
      },
      expectedLockDir: options.lockDir,
      recorderFactory: () => { throw new Error("must not record modified bytes"); },
    });
    assert.equal(modified.reason, "historical_boot_chain_unverified");
  } finally {
    rmSync(fixture.homeRoot, { recursive: true, force: true });
  }
});

test("earliest legacy Windows Startup CMD and its VBS require the exact historical shape", {
  skip: process.platform !== "win32",
}, () => {
  const fixture = windowsFixture();
  try {
    const vbsPath = fixture.byId.get("windows-startup").path;
    const memoryBin = path.win32.join(fixture.homeRoot, "legacy", "memory.exe");
    writeFileSync(fixture.legacyCommand, `@echo off\r\nset MCP_ALLOW_ANONYMOUS_ACCESS=true\r\n"${memoryBin}" server --http\r\n`);
    writeFileSync(vbsPath, `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${fixture.legacyCommand}""", 0, False\r\n`);
    assert.deepEqual(
      collectMcpMemoryBootRecoveryFindings({ homeRoot: fixture.homeRoot, platformName: "win32" })
        .map((entry) => entry.recoverySignature),
      ["legacy-windows-startup-vbs", "legacy-windows-command"],
    );
    rmSync(vbsPath, { force: true });
    assert.deepEqual(
      collectMcpMemoryBootRecoveryFindings({ homeRoot: fixture.homeRoot, platformName: "win32" }),
      [],
      "a standalone same-name user Startup CMD is not enough recovery proof",
    );
    writeFileSync(fixture.legacyCommand, `@echo off\r\nset MCP_ALLOW_ANONYMOUS_ACCESS=false\r\n"${memoryBin}" server --http\r\n`);
    assert.equal(classifyMcpMemoryBootRecoveryFile({ filePath: fixture.legacyCommand, bytes: Buffer.from(`@echo off\r\nset MCP_ALLOW_ANONYMOUS_ACCESS=false\r\n"${memoryBin}" server --http\r\n`), homeRoot: fixture.homeRoot, platformName: "win32" }), null);
  } finally {
    rmSync(fixture.homeRoot, { recursive: true, force: true });
  }
});
