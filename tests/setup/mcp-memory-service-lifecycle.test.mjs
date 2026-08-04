import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { platform, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import {
  MCP_MEMORY_COLD_START_TIMEOUT_MS,
  WINDOWS_APP_LOCAL_CRT_DLLS,
  acquireEndpointStartLock,
  buildBootMemoryServiceEnv,
  buildInitialMemoryServiceEnv,
  executeMcpMemoryReconciliation,
  discoverLatestVisualStudioCrtBundle,
  firstStartLogPaths,
  planMcpMemoryReconciliation,
  pythonMemoryHealthProbeArgs,
  releaseEndpointStartLock,
  repairWindowsCandidateOnnxRuntime,
  recordWindowsSourceFileIdentities,
  resolveWindowsProgramFilesRoots,
  runWindowsLockedDependencyProbe,
  verifyPrivateRecoveryRoot,
  verifyWindowsMicrosoftAuthenticode,
  waitForMcpMemoryHealth,
  withEndpointStartLock,
} from "../../scripts/mcp-memory-service-lifecycle.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const setupSource = readFileSync(resolve(repoRoot, "setup.mjs"), "utf8");
const lifecycleSource = readFileSync(
  resolve(repoRoot, "scripts", "mcp-memory-service-lifecycle.mjs"),
  "utf8",
);
const servers = new Set();

function fixtureSourceIdentities() {
  return WINDOWS_APP_LOCAL_CRT_DLLS.map((_dllName, index) => ({
    index,
    identity: `00000001:${String(index + 1).padStart(16, "0")}`,
    sha256: "a".repeat(64),
  }));
}

function fixtureExecutionChain() {
  return {
    ok: true,
    executionPaths: [process.execPath],
    expectedExecutionIdentities: [{
      index: 0,
      identity: "00000001:0000000000000001",
      sha256: "b".repeat(64),
    }],
    directoryPaths: [dirname(process.execPath)],
  };
}

after(async () => {
  await Promise.all(
    [...servers].map((server) => new Promise((resolveClose) => {
      server.close(resolveClose);
    })),
  );
});

function findPythonExecutable() {
  for (const [command, prefixArgs] of [
    ["python", []],
    ["python3", []],
    ["py", ["-3"]],
  ]) {
    const result = spawnSync(
      command,
      [...prefixArgs, "-c", "import sys; print(sys.executable)"],
      { encoding: "utf8", windowsHide: true },
    );
    const candidate = result.status === 0 ? result.stdout.trim() : "";
    if (candidate && isAbsolute(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

function runProcess(command, args, options) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, options);
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal, stderr }));
  });
}

function createVisualStudioBundle({
  programRoot,
  visualStudioVersion = "18",
  edition = "BuildTools",
  msvcVersion,
}) {
  return createInstanceBundle({
    instanceRoot: join(
      programRoot,
      "Microsoft Visual Studio",
      visualStudioVersion,
      edition,
    ),
    msvcVersion,
  });
}

function createInstanceBundle({ instanceRoot, msvcVersion }) {
  const bundlePath = join(
    instanceRoot,
    "VC",
    "Redist",
    "MSVC",
    msvcVersion,
    "x64",
    "Microsoft.VC145.CRT",
  );
  mkdirSync(bundlePath, { recursive: true });
  for (const dllName of WINDOWS_APP_LOCAL_CRT_DLLS) writeFileSync(join(bundlePath, dllName), dllName);
  return bundlePath;
}

describe("MCP memory service lifecycle", () => {
  test("fresh missing install reconciles the exact sqlite package before dependency probe", () => {
    const plan = planMcpMemoryReconciliation({
      existingInstalled: false,
      inUpdateMode: false,
    });
    const calls = [];
    const result = executeMcpMemoryReconciliation({
      python: { command: "fixture-python", args: [] },
      plan,
      runPython: (_python, args) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(plan.previouslyInstalled, false);
    assert.equal(plan.shouldStopBeforeInstall, false);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [[
      "-m",
      "pip",
      "install",
      "mcp-memory-service[sqlite]==11.5.5",
    ], ["-c", "import onnxruntime, tokenizers"]]);
  });

  test("already-installed ordinary reinstall revalidates without uninstalling user dependencies", () => {
    const plan = planMcpMemoryReconciliation({
      existingInstalled: true,
      inUpdateMode: false,
    });
    const calls = [];
    const result = executeMcpMemoryReconciliation({
      python: { command: "fixture-python", args: [] },
      plan,
      runPython: (_python, args) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(plan.previouslyInstalled, true);
    assert.equal(plan.shouldStopBeforeInstall, false);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      ["-m", "pip", "install", "mcp-memory-service[sqlite]==11.5.5"],
      ["-c", "import onnxruntime, tokenizers"],
    ]);
    assert.equal(calls.flat().includes("uninstall"), false);
  });

  test("update with a missing dependency installs the exact sqlite package and probes it", () => {
    const plan = planMcpMemoryReconciliation({
      existingInstalled: false,
      inUpdateMode: true,
    });
    const calls = [];
    const result = executeMcpMemoryReconciliation({
      python: { command: "fixture-python", args: [] },
      plan,
      runPython: (_python, args) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(plan.previouslyInstalled, false);
    assert.equal(plan.shouldStopBeforeInstall, false);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      ["-m", "pip", "install", "--upgrade", "mcp-memory-service[sqlite]==11.5.5"],
      ["-c", "import onnxruntime, tokenizers"],
    ]);
  });

  test("installation and dependency probe failures remain distinct and repair only follows a probe failure", () => {
    const plan = planMcpMemoryReconciliation({ existingInstalled: false, inUpdateMode: true });
    let repairCalls = 0;
    const installFailure = executeMcpMemoryReconciliation({
      python: { command: "fixture-python", args: [] },
      plan,
      runPython: () => ({ status: 1, stderr: "pip failed" }),
      repairDependencyProbe: () => { repairCalls += 1; },
    });
    assert.equal(installFailure.stage, "install");
    assert.equal(installFailure.code, "mcp_memory_install_failed");
    assert.equal(repairCalls, 0);

    let calls = 0;
    const probeFailure = executeMcpMemoryReconciliation({
      python: { command: "fixture-python", args: [] },
      plan,
      runPython: () => ({ status: calls++ === 0 ? 0 : 1, stderr: "native import failed" }),
    });
    assert.equal(probeFailure.stage, "dependency_probe");
    assert.equal(probeFailure.code, "mcp_memory_dependency_probe_failed");

    calls = 0;
    const repaired = executeMcpMemoryReconciliation({
      python: { command: "fixture-python", args: [] },
      plan,
      runPython: () => ({ status: calls++ === 0 ? 0 : 1 }),
      repairDependencyProbe: () => {
        repairCalls += 1;
        return { ok: true, processResult: { status: 0 }, evidence: { dllVersion: "14.51" } };
      },
    });
    assert.equal(repaired.ok, true);
    assert.equal(repaired.code, "mcp_memory_verified_after_windows_app_local_crt");
    assert.equal(repairCalls, 1);

    const installStepStart = setupSource.indexOf("async function installMcpMemoryServiceStep(");
    const installStepEnd = setupSource.indexOf("function ensureNetworkxCompatibility", installStepStart);
    const installStepSource = setupSource.slice(installStepStart, installStepEnd);
    const reconciliationCall = installStepSource.indexOf("const reconciliation = executeMcpMemoryReconciliation(");
    const failureGate = installStepSource.indexOf("if (!reconciliation.ok)", reconciliationCall);
    const failureReturn = installStepSource.indexOf("return false;", failureGate);
    const startupRegistration = installStepSource.indexOf("registrationOk = registerMcpMemoryServer(", reconciliationCall);
    assert.ok(reconciliationCall >= 0, "setup executes dependency reconciliation");
    assert.ok(reconciliationCall < failureGate, "setup checks reconciliation after execution");
    assert.ok(failureGate < failureReturn, "failed installation or probe returns false");
    assert.ok(failureReturn < startupRegistration, "failed reconciliation cannot reach startup registration");
  });

  test("CRT discovery selects the latest complete same-version official x64 bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-vs-redist-"));
    try {
      createVisualStudioBundle({ programRoot: root, visualStudioVersion: "17", msvcVersion: "14.40.00000" });
      const expected = createVisualStudioBundle({ programRoot: root, visualStudioVersion: "18", msvcVersion: "14.51.36231" });
      const mixed = createVisualStudioBundle({ programRoot: root, visualStudioVersion: "19", msvcVersion: "14.60.00000" });
      const incomplete = createVisualStudioBundle({ programRoot: root, visualStudioVersion: "20", msvcVersion: "14.70.00000" });
      rmSync(join(incomplete, WINDOWS_APP_LOCAL_CRT_DLLS.at(-1)), { force: true });
      const result = discoverLatestVisualStudioCrtBundle({
        programFilesX86: root,
        readDllVersion: (filePath) => (
          filePath.startsWith(mixed) && filePath.endsWith("vcruntime140.dll")
            ? "14.59.0.0"
            : filePath.startsWith(mixed) ? "14.60.0.0"
              : filePath.startsWith(expected) ? "14.51.36231.0" : "14.40.0.0"
        ),
      });
      assert.equal(result.ok, true);
      assert.equal(result.bundlePath, expected);
      assert.equal(result.dllVersion, "14.51.36231.0");
      assert.deepEqual(result.files.map((filePath) => filePath.split(/[\\/]/u).at(-1)), WINDOWS_APP_LOCAL_CRT_DLLS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CRT discovery supports ProgramFiles-only installs and selects the newest bundle across both roots", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-vs-dual-root-"));
    const programFiles = join(root, "Program Files");
    const programFilesX86 = join(root, "Program Files (x86)");
    try {
      const programFilesBundle = createVisualStudioBundle({
        programRoot: programFiles,
        msvcVersion: "14.60.00000",
      });
      createVisualStudioBundle({ programRoot: programFilesX86, msvcVersion: "14.51.00000" });
      const onlyProgramFiles = discoverLatestVisualStudioCrtBundle({
        programFiles,
        readDllVersion: () => "14.60.0.0",
      });
      assert.equal(onlyProgramFiles.bundlePath, programFilesBundle);

      const bothRoots = discoverLatestVisualStudioCrtBundle({
        programFiles,
        programFilesX86,
        readDllVersion: (filePath) => filePath.startsWith(programFilesBundle)
          ? "14.60.0.0"
          : "14.51.0.0",
      });
      assert.equal(bothRoots.bundlePath, programFilesBundle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("production root resolution uses trusted system PowerShell FolderPath output, not environment roots", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-os-program-files-"));
    const powershellPath = join(root, "fixed-system-powershell.exe");
    const programFiles = join(root, "Program Files");
    const programFilesX86 = join(root, "Program Files (x86)");
    writeFileSync(powershellPath, "fixture");
    mkdirSync(programFiles);
    mkdirSync(programFilesX86);
    try {
      const resolvedRoots = resolveWindowsProgramFilesRoots({
        platformName: "win32",
        powershellPath,
        runPowerShell: (command, args) => {
          assert.equal(command, powershellPath);
          assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
          return {
            status: 0,
            stdout: JSON.stringify({ programFiles, programFilesX86 }),
          };
        },
      });
      assert.deepEqual(resolvedRoots, { ok: true, programFiles, programFilesX86 });

      const expected = createVisualStudioBundle({ programRoot: programFiles, msvcVersion: "14.60.0" });
      let resolverCalls = 0;
      const discovered = discoverLatestVisualStudioCrtBundle({
        resolveProgramFilesRoots: () => {
          resolverCalls += 1;
          return resolvedRoots;
        },
        readDllVersion: () => "14.60.0.0",
      });
      assert.equal(resolverCalls, 1);
      assert.equal(discovered.bundlePath, expected);
      assert.doesNotMatch(lifecycleSource, /process\.env(?:\.|\[)["']?ProgramFiles/iu);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("production PowerShell resolution ignores PATH and fake C-drive candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-trusted-powershell-"));
    const pathFake = join(root, "path", "powershell.exe");
    const fakeCWindows = join(root, "C", "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const trustedPowerShell = join(root, "trusted-system", "WindowsPowerShell", "v1.0", "powershell.exe");
    const programFiles = join(root, "Program Files");
    for (const filePath of [pathFake, fakeCWindows, trustedPowerShell]) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, "fixture");
    }
    mkdirSync(programFiles);
    const previousPath = process.env.PATH;
    let fakeCalls = 0;
    try {
      process.env.PATH = `${dirname(pathFake)};${previousPath ?? ""}`;
      const result = resolveWindowsProgramFilesRoots({
        platformName: "win32",
        resolveSystemTool: (segments) => {
          assert.deepEqual(segments, ["WindowsPowerShell", "v1.0", "powershell.exe"]);
          return trustedPowerShell;
        },
        runPowerShell: (command) => {
          if ([pathFake, fakeCWindows].includes(command)) fakeCalls += 1;
          assert.equal(command, trustedPowerShell);
          return { status: 0, stdout: JSON.stringify({ programFiles, programFilesX86: "" }) };
        },
      });
      assert.equal(result.ok, true, result.reason);
      assert.equal(fakeCalls, 0);
      assert.doesNotMatch(lifecycleSource, /spawnSync\("powershell\.exe"\)|C:\/Windows|System32[/\\]WindowsPowerShell/u);
      assert.match(lifecycleSource, /resolveTrustedWindowsSystemTool/u);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows production defaults resolve OS roots and discover an official complete CRT bundle read-only", {
    skip: platform() !== "win32",
  }, () => {
    const roots = resolveWindowsProgramFilesRoots();
    assert.equal(roots.ok, true, roots.reason);
    assert.ok(roots.programFiles || roots.programFilesX86);
    if (roots.programFiles) {
      assert.equal(existsSync(roots.programFiles), true);
      assert.match(roots.programFiles.replace(/\\/gu, "/"), /\/Program Files$/iu);
    }

    const discovered = discoverLatestVisualStudioCrtBundle();
    assert.equal(discovered.ok, true, discovered.reason);
    assert.equal(discovered.files.length, WINDOWS_APP_LOCAL_CRT_DLLS.length);
    assert.deepEqual(
      discovered.files.map((filePath) => filePath.split(/[\\/]/u).at(-1)),
      WINDOWS_APP_LOCAL_CRT_DLLS,
    );
    assert.ok(discovered.files.every((filePath) => existsSync(filePath)));
    assert.match(discovered.dllVersion, /^\d+(?:\.\d+)+/u);
    const signatures = verifyWindowsMicrosoftAuthenticode({ filePaths: discovered.files });
    assert.equal(signatures.ok, true, signatures.reason);
    assert.equal(signatures.evidence.length, WINDOWS_APP_LOCAL_CRT_DLLS.length);
    assert.ok(signatures.evidence.every(({ status }) => status === "Valid"));
  });

  test("duplicate ProgramFiles roots are scanned once and an unsafe root cannot poison the other", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-vs-root-trust-"));
    const sharedRoot = join(root, "shared");
    const unsafeRoot = join(root, "unsafe");
    const safeRoot = join(root, "safe");
    try {
      const sharedBundle = createVisualStudioBundle({ programRoot: sharedRoot, msvcVersion: "14.51.00000" });
      let versionReads = 0;
      const deduplicated = discoverLatestVisualStudioCrtBundle({
        programFiles: sharedRoot,
        programFilesX86: sharedRoot,
        readDllVersion: () => { versionReads += 1; return "14.51.0.0"; },
      });
      assert.equal(deduplicated.bundlePath, sharedBundle);
      assert.equal(versionReads, WINDOWS_APP_LOCAL_CRT_DLLS.length);

      createVisualStudioBundle({ programRoot: unsafeRoot, msvcVersion: "99.0.0" });
      const safeBundle = createVisualStudioBundle({ programRoot: safeRoot, msvcVersion: "14.51.00000" });
      const unsafeVisualStudioRoot = join(unsafeRoot, "Microsoft Visual Studio");
      const isolated = discoverLatestVisualStudioCrtBundle({
        programFiles: unsafeRoot,
        programFilesX86: safeRoot,
        readDllVersion: () => "14.51.0.0",
        lstat: (filePath) => {
          const metadata = lstatSync(filePath);
          return resolve(filePath) === resolve(unsafeVisualStudioRoot)
            ? { ...metadata, isDirectory: () => true, isSymbolicLink: () => true }
            : metadata;
        },
      });
      assert.equal(isolated.bundlePath, safeBundle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fixed-location vswhere discovers a validated custom Visual Studio instance", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-vswhere-custom-"));
    const programFilesX86 = join(root, "Program Files (x86)");
    const installerRoot = join(programFilesX86, "Microsoft Visual Studio", "Installer");
    const vswherePath = join(installerRoot, "vswhere.exe");
    const customInstance = join(root, "Custom VS", "BuildTools");
    const expected = createInstanceBundle({ instanceRoot: customInstance, msvcVersion: "14.70.00000" });
    mkdirSync(installerRoot, { recursive: true });
    writeFileSync(vswherePath, "fixture");
    try {
      const result = discoverLatestVisualStudioCrtBundle({
        programFilesX86,
        readDllVersion: () => "14.70.0.0",
        runVswhere: (command, args) => {
          assert.equal(command, vswherePath);
          assert.deepEqual(args, ["-products", "*", "-format", "json"]);
          return { status: 0, stdout: JSON.stringify([{ installationPath: customInstance }]) };
        },
      });
      assert.equal(result.bundlePath, expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("vswhere rejects forged, relative, and escaping instance output while preserving safe fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-vswhere-untrusted-"));
    const programFilesX86 = join(root, "Program Files (x86)");
    const installerRoot = join(programFilesX86, "Microsoft Visual Studio", "Installer");
    const vswherePath = join(installerRoot, "vswhere.exe");
    const safeBundle = createVisualStudioBundle({
      programRoot: programFilesX86,
      visualStudioVersion: "18",
      msvcVersion: "14.51.00000",
    });
    const escapingInstance = join(root, "escaping-instance");
    const outsideVc = join(root, "outside", "VC");
    mkdirSync(join(escapingInstance, "VC"), { recursive: true });
    createInstanceBundle({ instanceRoot: join(root, "outside"), msvcVersion: "99.0.0" });
    mkdirSync(installerRoot, { recursive: true });
    writeFileSync(vswherePath, "fixture");
    try {
      const common = {
        programFilesX86,
        readDllVersion: () => "14.51.0.0",
      };
      const forged = discoverLatestVisualStudioCrtBundle({
        ...common,
        runVswhere: () => ({ status: 0, stdout: "not-json" }),
      });
      assert.equal(forged.bundlePath, safeBundle);

      const rejected = discoverLatestVisualStudioCrtBundle({
        ...common,
        runVswhere: () => ({
          status: 0,
          stdout: JSON.stringify([
            { installationPath: "relative-vs" },
            { installationPath: `${root}/../escape` },
            { installationPath: 42 },
            { installationPath: escapingInstance },
          ]),
        }),
        realpath: (filePath) => resolve(filePath) === resolve(join(escapingInstance, "VC"))
          ? realpathSync(outsideVc)
          : realpathSync(filePath),
      });
      assert.equal(rejected.bundlePath, safeBundle);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows app-local repair copies only the CRT allowlist into candidate onnxruntime and retries", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-app-local-crt-"));
    const candidateDir = join(root, "candidate");
    const capiPath = join(candidateDir, "Lib", "site-packages", "onnxruntime", "capi");
    const bundlePath = join(root, "official-bundle");
    mkdirSync(capiPath, { recursive: true });
    mkdirSync(bundlePath, { recursive: true });
    for (const dllName of WINDOWS_APP_LOCAL_CRT_DLLS) writeFileSync(join(bundlePath, dllName), dllName);
    writeFileSync(join(bundlePath, "unrelated.dll"), "must not copy");
    const verifyArgs = ["-c", "import onnxruntime, tokenizers"];
    const calls = [];
    try {
      const result = repairWindowsCandidateOnnxRuntime({
        python: { command: "fixture-python", args: [] },
        candidateDir,
        verifyArgs,
        platformName: "win32",
        discoverBundle: () => ({
          ok: true,
          bundlePath,
          bundleName: "Microsoft.VC145.CRT",
          msvcVersion: "14.51.36231",
          dllVersion: "14.51.36231.0",
          sourceIdentities: fixtureSourceIdentities(),
        }),
        runPython: (_python, args) => {
          calls.push(args);
          return calls.length === 1
            ? { status: 0, stdout: `${JSON.stringify({ path: capiPath })}\n` }
            : { status: 0, stdout: "", stderr: "" };
        },
        runLockedDependencyProbe: ({ sourcePaths, targetPaths, verifyArgs: lockedVerifyArgs }) => {
          for (let index = 0; index < sourcePaths.length; index += 1) {
            writeFileSync(targetPaths[index], readFileSync(sourcePaths[index]));
          }
          calls.push(lockedVerifyArgs);
          return {
            ok: true,
            reason: "locked_dependency_probe_verified",
            processResult: { status: 0, stdout: "", stderr: "" },
            signatures: targetPaths.map((filePath) => ({
            dllName: filePath.split(/[\\/]/u).at(-1),
            status: "Valid",
            signerThumbprintDigest: "a".repeat(64),
            rootThumbprintDigest: "b".repeat(64),
            })),
          };
        },
        resolveExecutionChain: fixtureExecutionChain,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(calls[0], verifyArgs);
      assert.deepEqual(readdirSync(capiPath).sort(), [...WINDOWS_APP_LOCAL_CRT_DLLS].sort());
      assert.deepEqual(result.evidence.copiedDlls, WINDOWS_APP_LOCAL_CRT_DLLS);
      assert.ok(result.evidence.signatures.every(({ status }) => status === "Valid"));
      assert.equal(Object.hasOwn(result.evidence, "bundlePath"), false);
      assert.equal(Object.hasOwn(result.evidence, "capiPath"), false);
      assert.equal(JSON.stringify(result.evidence).includes(root), false);

      const failureCandidateDir = join(root, "failure-candidate");
      const failureCapiPath = join(
        failureCandidateDir,
        "Lib",
        "site-packages",
        "onnxruntime",
        "capi",
      );
      mkdirSync(failureCapiPath, { recursive: true });
      const copyFailure = repairWindowsCandidateOnnxRuntime({
        python: { command: "fixture-python", args: [] },
        candidateDir: failureCandidateDir,
        verifyArgs,
        platformName: "win32",
        discoverBundle: () => ({
          ok: true,
          bundlePath,
          bundleName: "Microsoft.VC145.CRT",
          msvcVersion: "14.51.36231",
          dllVersion: "14.51.36231.0",
          sourceIdentities: fixtureSourceIdentities(),
        }),
        runLockedDependencyProbe: () => ({
          ok: false,
          reason: "windows_app_local_crt_copy_failed",
        }),
        resolveExecutionChain: fixtureExecutionChain,
        runPython: () => ({ status: 0, stdout: JSON.stringify({ path: failureCapiPath }) }),
      });
      assert.equal(copyFailure.reason, "windows_app_local_crt_copy_failed");
      assert.equal(Object.hasOwn(copyFailure, "error"), false);
      assert.equal(JSON.stringify(copyFailure.evidence).includes(root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("app-local repair rejects regular, hardlink, and symlink targets before any copy", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-app-local-existing-"));
    const bundlePath = join(root, "bundle");
    mkdirSync(bundlePath);
    for (const dllName of WINDOWS_APP_LOCAL_CRT_DLLS) writeFileSync(join(bundlePath, dllName), dllName);
    const makeCandidate = (name) => {
      const candidateDir = join(root, name);
      const capiPath = join(candidateDir, "Lib", "site-packages", "onnxruntime", "capi");
      mkdirSync(capiPath, { recursive: true });
      return { candidateDir, capiPath };
    };
    const bundle = () => ({
      ok: true,
      bundlePath,
      bundleName: "Microsoft.VC145.CRT",
      msvcVersion: "14.51.0",
      dllVersion: "14.51.0.0",
      sourceIdentities: fixtureSourceIdentities(),
    });
    let copyCalls = 0;
    const run = ({ candidateDir, capiPath }, lstat = lstatSync) => repairWindowsCandidateOnnxRuntime({
      python: { command: "fixture-python", args: [] },
      candidateDir,
      verifyArgs: ["-c", "verify"],
      platformName: "win32",
      discoverBundle: bundle,
      lstat,
      copyFile: () => { copyCalls += 1; },
      runPython: () => ({ status: 0, stdout: JSON.stringify({ path: capiPath }) }),
    });
    try {
      const regular = makeCandidate("regular");
      writeFileSync(join(regular.capiPath, WINDOWS_APP_LOCAL_CRT_DLLS[0]), "existing");
      assert.equal(run(regular).reason, "windows_app_local_crt_target_exists");

      const hardlink = makeCandidate("hardlink");
      const hardlinkSource = join(root, "hardlink-source.dll");
      writeFileSync(hardlinkSource, "existing");
      linkSync(hardlinkSource, join(hardlink.capiPath, WINDOWS_APP_LOCAL_CRT_DLLS[0]));
      assert.equal(run(hardlink).reason, "windows_app_local_crt_target_exists");

      const symlink = makeCandidate("symlink");
      const simulatedTarget = join(symlink.capiPath, WINDOWS_APP_LOCAL_CRT_DLLS[0]);
      assert.equal(run(symlink, (filePath) => (
        resolve(filePath) === resolve(simulatedTarget)
          ? { isDirectory: () => false, isSymbolicLink: () => true }
          : lstatSync(filePath)
      )).reason, "windows_app_local_crt_target_exists");
      assert.equal(copyCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("app-local repair never runs the legacy candidate path probe before execution-chain lock", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-no-prelock-python-"));
    const candidateDir = join(root, "candidate");
    const capiPath = join(candidateDir, "Lib", "site-packages", "onnxruntime", "capi");
    const bundlePath = join(root, "bundle");
    mkdirSync(capiPath, { recursive: true });
    mkdirSync(bundlePath);
    for (const dllName of WINDOWS_APP_LOCAL_CRT_DLLS) writeFileSync(join(bundlePath, dllName), dllName);
    let candidateSpawns = 0;
    try {
      const result = repairWindowsCandidateOnnxRuntime({
        python: { command: join(candidateDir, "Scripts", "python.exe"), args: [] },
        candidateDir,
        verifyArgs: ["-c", "import onnxruntime"],
        platformName: "win32",
        discoverBundle: () => ({
          ok: true,
          bundlePath,
          bundleName: "Microsoft.VC145.CRT",
          msvcVersion: "14.51.0",
          dllVersion: "14.51.0.0",
          sourceIdentities: fixtureSourceIdentities(),
        }),
        runPython: () => {
          candidateSpawns += 1;
          throw new Error("attacker replaced candidate Python during legacy path probe");
        },
        resolveExecutionChain: () => ({ ok: false, reason: "candidate_execution_chain_untrusted" }),
      });
      assert.equal(result.reason, "candidate_execution_chain_untrusted");
      assert.equal(candidateSpawns, 0);
      assert.doesNotMatch(lifecycleSource, /ONNXRUNTIME_CAPI_PATH_PROBE|onnxruntime_capi_path_probe/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("locked repair fails closed for false signatures, hash races, and post-hash replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-app-local-integrity-"));
    const bundlePath = join(root, "bundle");
    mkdirSync(bundlePath);
    for (const dllName of WINDOWS_APP_LOCAL_CRT_DLLS) writeFileSync(join(bundlePath, dllName), dllName);
    const bundle = () => ({
      ok: true,
      bundlePath,
      bundleName: "Microsoft.VC145.CRT",
      msvcVersion: "14.51.0",
      dllVersion: "14.51.0.0",
      sourceIdentities: fixtureSourceIdentities(),
    });
    const makeCandidate = (name) => {
      const candidateDir = join(root, name);
      const capiPath = join(candidateDir, "Lib", "site-packages", "onnxruntime", "capi");
      mkdirSync(capiPath, { recursive: true });
      return { candidateDir, capiPath };
    };
    const run = (candidate, overrides = {}) => {
      let pythonCalls = 0;
      const result = repairWindowsCandidateOnnxRuntime({
        python: { command: "fixture-python", args: [] },
        candidateDir: candidate.candidateDir,
        verifyArgs: ["-c", "import onnxruntime, tokenizers"],
        platformName: "win32",
        discoverBundle: bundle,
        runPython: () => {
          pythonCalls += 1;
          return { status: 0, stdout: JSON.stringify({ path: candidate.capiPath }) };
        },
        resolveExecutionChain: fixtureExecutionChain,
        ...overrides,
      });
      return { result, pythonCalls };
    };
    try {
      const falseSignature = makeCandidate("false-signature");
      const rejectedSignature = run(falseSignature, {
        runLockedDependencyProbe: () => ({ ok: false, reason: "locked_authenticode_invalid" }),
      });
      assert.equal(rejectedSignature.result.reason, "locked_authenticode_invalid");
      assert.equal(rejectedSignature.pythonCalls, 0);
      assert.deepEqual(readdirSync(falseSignature.capiPath), []);

      const hashRace = makeCandidate("hash-race");
      const rejectedHash = run(hashRace, {
        runLockedDependencyProbe: () => ({ ok: false, reason: "locked_hash_mismatch" }),
      });
      assert.equal(rejectedHash.result.reason, "locked_hash_mismatch");
      assert.deepEqual(readdirSync(hashRace.capiPath), []);

      const partialCopy = makeCandidate("partial-copy");
      const rejectedPartial = run(partialCopy, {
        runLockedDependencyProbe: () => ({ ok: false, reason: "locked_copy_interrupted" }),
      });
      assert.equal(rejectedPartial.result.reason, "locked_copy_interrupted");
      assert.deepEqual(readdirSync(partialCopy.capiPath), []);

      const postSignatureRace = makeCandidate("post-signature-race");
      const rejectedPostSignature = run(postSignatureRace, {
        runLockedDependencyProbe: () => ({ ok: false, reason: "locked_directory_identity_changed" }),
      });
      assert.equal(rejectedPostSignature.result.reason, "locked_directory_identity_changed");
      assert.equal(rejectedPostSignature.pythonCalls, 0);
      assert.deepEqual(readdirSync(postSignatureRace.capiPath), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("locked repair holds source, target, and directory identities through Python import", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-locked-repair-script-"));
    const powershellPath = join(root, "fixed-powershell.exe");
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    mkdirSync(sourceRoot);
    mkdirSync(targetRoot);
    writeFileSync(powershellPath, "fixture");
    const sourcePaths = WINDOWS_APP_LOCAL_CRT_DLLS.map((dllName) => {
      const filePath = join(sourceRoot, dllName);
      writeFileSync(filePath, dllName);
      return filePath;
    });
    const targetPaths = WINDOWS_APP_LOCAL_CRT_DLLS.map((dllName) => join(targetRoot, dllName));
    let script = "";
    try {
      const result = runWindowsLockedDependencyProbe({
        python: { command: process.execPath, args: [] },
        verifyArgs: ["-e", "process.exit(0)"],
        sourcePaths,
        expectedSourceIdentities: fixtureSourceIdentities(),
        executionPaths: fixtureExecutionChain().executionPaths,
        expectedExecutionIdentities: fixtureExecutionChain().expectedExecutionIdentities,
        targetPaths,
        directoryPaths: [sourceRoot, targetRoot],
        powershellPath,
        runPowerShell: (_command, args) => {
          script = args.at(-1);
          return {
            status: 0,
            stdout: JSON.stringify({ locked: false, status: -1, reason: "fixture_stop", output: "" }),
          };
        },
      });
      assert.equal(result.reason, "fixture_stop");
      assert.match(script, /CreateFile/u);
      assert.match(script, /0x02200000/u);
      assert.match(script, /GetFileInformationByHandle/u);
      assert.match(script, /expectedSourceIdentities/u);
      assert.match(script, /locked_source_identity_mismatch/u);
      assert.match(script, /locked_target_identity_changed/u);
      assert.match(script, /FileMode\]::CreateNew/u);
      assert.match(script, /FileShare\]::Read/u);
      assert.ok(script.indexOf("[MetaKimDirectoryLock]::Identity") < script.indexOf("$output=(&"));
      assert.ok(script.indexOf("$output=(&") < script.indexOf("$handle.Dispose()"));
      assert.match(script, /Remove-Item -LiteralPath \$path -Force/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Windows locked helper rejects unsigned copied DLLs and cleans every temp target", {
    skip: platform() !== "win32",
  }, () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-locked-repair-live-"));
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    mkdirSync(sourceRoot);
    mkdirSync(targetRoot);
    const sourcePaths = WINDOWS_APP_LOCAL_CRT_DLLS.map((dllName) => {
      const filePath = join(sourceRoot, dllName);
      writeFileSync(filePath, dllName);
      return filePath;
    });
    const targetPaths = WINDOWS_APP_LOCAL_CRT_DLLS.map((dllName) => join(targetRoot, dllName));
    try {
      const sourceIdentityResult = recordWindowsSourceFileIdentities({ filePaths: sourcePaths });
      assert.equal(sourceIdentityResult.ok, true, sourceIdentityResult.reason);
      const executionIdentityResult = recordWindowsSourceFileIdentities({ filePaths: [process.execPath] });
      assert.equal(executionIdentityResult.ok, true, executionIdentityResult.reason);
      const result = runWindowsLockedDependencyProbe({
        python: { command: process.execPath, args: [] },
        verifyArgs: ["-e", "process.exit(0)"],
        sourcePaths,
        expectedSourceIdentities: sourceIdentityResult.records,
        executionPaths: [process.execPath],
        expectedExecutionIdentities: executionIdentityResult.records,
        targetPaths,
        directoryPaths: [sourceRoot, targetRoot],
      });
      assert.equal(result.ok, false);
      assert.match(result.reason, /locked_authenticode_invalid/u);
      assert.deepEqual(readdirSync(targetRoot), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("locked helper rejects source replacement and target pre-creation before import", {
    skip: platform() !== "win32",
  }, () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-locked-identity-race-"));
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    const markerPath = join(root, "import-ran.txt");
    mkdirSync(sourceRoot);
    mkdirSync(targetRoot);
    const sourcePaths = WINDOWS_APP_LOCAL_CRT_DLLS.map((dllName) => {
      const filePath = join(sourceRoot, dllName);
      writeFileSync(filePath, dllName);
      return filePath;
    });
    const targetPaths = WINDOWS_APP_LOCAL_CRT_DLLS.map((dllName) => join(targetRoot, dllName));
    try {
      const discovered = recordWindowsSourceFileIdentities({ filePaths: sourcePaths });
      assert.equal(discovered.ok, true, discovered.reason);
      const executionIdentityResult = recordWindowsSourceFileIdentities({ filePaths: [process.execPath] });
      assert.equal(executionIdentityResult.ok, true, executionIdentityResult.reason);
      renameSync(sourcePaths[0], `${sourcePaths[0]}.replaced`);
      writeFileSync(sourcePaths[0], "attacker replacement");
      const replacedSource = runWindowsLockedDependencyProbe({
        python: { command: process.execPath, args: [] },
        verifyArgs: ["-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`],
        sourcePaths,
        expectedSourceIdentities: discovered.records,
        executionPaths: [process.execPath],
        expectedExecutionIdentities: executionIdentityResult.records,
        targetPaths,
        directoryPaths: [sourceRoot, targetRoot],
      });
      assert.equal(replacedSource.ok, false);
      assert.equal(replacedSource.reason, "locked_source_identity_mismatch");
      assert.equal(existsSync(markerPath), false);
      assert.deepEqual(readdirSync(targetRoot), []);

      const rediscovered = recordWindowsSourceFileIdentities({ filePaths: sourcePaths });
      assert.equal(rediscovered.ok, true, rediscovered.reason);
      writeFileSync(targetPaths[0], "attacker pre-created target");
      const precreatedTarget = runWindowsLockedDependencyProbe({
        python: { command: process.execPath, args: [] },
        verifyArgs: ["-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`],
        sourcePaths,
        expectedSourceIdentities: rediscovered.records,
        executionPaths: [process.execPath],
        expectedExecutionIdentities: executionIdentityResult.records,
        targetPaths,
        directoryPaths: [sourceRoot, targetRoot],
      });
      assert.equal(precreatedTarget.ok, false);
      assert.equal(readFileSync(targetPaths[0], "utf8"), "attacker pre-created target");
      assert.equal(existsSync(markerPath), false);
      assert.deepEqual(readdirSync(targetRoot), [WINDOWS_APP_LOCAL_CRT_DLLS[0]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("locked helper rejects candidate Python replacement before probe execution", {
    skip: platform() !== "win32",
  }, () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-locked-python-race-"));
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    const candidateRoot = join(root, "candidate");
    const scriptsRoot = join(candidateRoot, "Scripts");
    const candidatePython = join(scriptsRoot, "python.exe");
    const pyvenvPath = join(candidateRoot, "pyvenv.cfg");
    const markerPath = join(root, "probe-ran.txt");
    mkdirSync(sourceRoot);
    mkdirSync(targetRoot);
    mkdirSync(scriptsRoot, { recursive: true });
    copyFileSync(process.execPath, candidatePython);
    writeFileSync(pyvenvPath, `home = ${dirname(process.execPath)}\n`);
    const sourcePaths = WINDOWS_APP_LOCAL_CRT_DLLS.map((dllName) => {
      const filePath = join(sourceRoot, dllName);
      writeFileSync(filePath, dllName);
      return filePath;
    });
    const targetPaths = WINDOWS_APP_LOCAL_CRT_DLLS.map((dllName) => join(targetRoot, dllName));
    const executionPaths = [candidatePython, pyvenvPath, process.execPath];
    try {
      const sourceIdentityResult = recordWindowsSourceFileIdentities({ filePaths: sourcePaths });
      const executionIdentityResult = recordWindowsSourceFileIdentities({ filePaths: executionPaths });
      assert.equal(sourceIdentityResult.ok, true, sourceIdentityResult.reason);
      assert.equal(executionIdentityResult.ok, true, executionIdentityResult.reason);
      renameSync(candidatePython, `${candidatePython}.replaced`);
      copyFileSync(process.execPath, candidatePython);
      const result = runWindowsLockedDependencyProbe({
        python: { command: candidatePython, args: [] },
        verifyArgs: ["-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`],
        sourcePaths,
        expectedSourceIdentities: sourceIdentityResult.records,
        executionPaths,
        expectedExecutionIdentities: executionIdentityResult.records,
        targetPaths,
        directoryPaths: [sourceRoot, targetRoot, candidateRoot, scriptsRoot, dirname(process.execPath)],
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "locked_execution_identity_mismatch");
      assert.equal(existsSync(markerPath), false);
      assert.deepEqual(readdirSync(targetRoot), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Authenticode validation rejects a Valid fake Microsoft subject without a pinned chain", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-authenticode-signer-"));
    const powershellPath = join(root, "fixed-powershell.exe");
    writeFileSync(powershellPath, "fixture");
    const filePaths = WINDOWS_APP_LOCAL_CRT_DLLS.map((dllName) => {
      const filePath = join(root, dllName);
      writeFileSync(filePath, dllName);
      return filePath;
    });
    try {
      const result = verifyWindowsMicrosoftAuthenticode({
        filePaths,
        powershellPath,
        runPowerShell: () => ({
          status: 0,
          stdout: JSON.stringify(filePaths.map((_filePath, index) => ({
            index,
            status: "Valid",
            subject: "CN=Counterfeit Publisher, O=Microsoft Corporation, C=US",
            thumbprint: "DEADBEEF",
            chainValid: true,
            rootThumbprint: "FAKE_MICROSOFT_ROOT",
            intermediateThumbprints: ["2F5540201B5799E6A3E2131C3D05753D23879FE0"],
          }))),
        }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "microsoft_authenticode_invalid");
      assert.equal(JSON.stringify(result.evidence).includes(root), false);
      assert.equal(JSON.stringify(result.evidence).includes("Counterfeit"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Authenticode accepts PowerShell's scalar serialization for one pinned intermediate", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-authenticode-scalar-"));
    const powershellPath = join(root, "fixed-powershell.exe");
    writeFileSync(powershellPath, "fixture");
    const filePaths = WINDOWS_APP_LOCAL_CRT_DLLS.map((dllName) => {
      const filePath = join(root, dllName);
      writeFileSync(filePath, dllName);
      return filePath;
    });
    try {
      const result = verifyWindowsMicrosoftAuthenticode({
        filePaths,
        powershellPath,
        runPowerShell: () => ({
          status: 0,
          stdout: JSON.stringify(filePaths.map((_filePath, index) => ({
            index,
            status: "Valid",
            subject: "CN=Microsoft Publisher, O=Microsoft Corporation, C=US",
            thumbprint: "2650247AC56048BC7928663C02733D25898A1D6E",
            chainValid: true,
            rootThumbprint: "8F43288AD272F3103B6FB1428485EA3014C0BCFE",
            intermediateThumbprints: "2F5540201B5799E6A3E2131C3D05753D23879FE0",
          }))),
        }),
      });
      assert.equal(result.ok, true, result.reason);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovery root ACL must have a trusted owner and no broad write grants", () => {
    const root = mkdtempSync(join(tmpdir(), "meta-kim-recovery-acl-"));
    const powershellPath = join(root, "fixture-powershell.exe");
    writeFileSync(powershellPath, "fixture");
    try {
      const safe = verifyPrivateRecoveryRoot({
        directoryPath: root,
        platformName: "win32",
        powershellPath,
        runPowerShell: () => ({
          status: 0,
          stdout: JSON.stringify({ safe: true, ownerSid: "S-1-5-21-fixture" }),
        }),
      });
      assert.equal(safe.ok, true);
      assert.match(safe.ownerDigest, /^[a-f0-9]{64}$/u);

      const broadWrite = verifyPrivateRecoveryRoot({
        directoryPath: root,
        platformName: "win32",
        powershellPath,
        runPowerShell: () => ({
          status: 0,
          stdout: JSON.stringify({ safe: false, ownerSid: "S-1-5-21-attacker" }),
        }),
      });
      assert.deepEqual(broadWrite, { ok: false, reason: "recovery_root_broad_permissions" });
      assert.match(lifecycleSource, /S-1-1-0.*S-1-5-32-545.*S-1-5-11/u);
      assert.match(lifecycleSource, /ownerTrusted/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("app-local repair fails closed off Windows, for incomplete bundles, and for missing fixed capi layout", () => {
    let discoveryCalls = 0;
    let copyCalls = 0;
    const nonWindows = repairWindowsCandidateOnnxRuntime({
      platformName: "linux",
      discoverBundle: () => { discoveryCalls += 1; return { ok: true }; },
      copyFile: () => { copyCalls += 1; },
    });
    assert.equal(nonWindows.reason, "windows_only_repair");
    assert.equal(discoveryCalls, 0);

    const incomplete = repairWindowsCandidateOnnxRuntime({
      platformName: "win32",
      discoverBundle: () => ({ ok: false, reason: "complete_same_version_x64_crt_bundle_not_found" }),
      copyFile: () => { copyCalls += 1; },
    });
    assert.equal(incomplete.reason, "complete_same_version_x64_crt_bundle_not_found");

    const root = mkdtempSync(join(tmpdir(), "meta-kim-app-local-escape-"));
    const candidateDir = join(root, "candidate");
    mkdirSync(candidateDir, { recursive: true });
    let candidateSpawns = 0;
    try {
      const escaped = repairWindowsCandidateOnnxRuntime({
        python: { command: "fixture-python", args: [] },
        candidateDir,
        verifyArgs: ["-c", "verify"],
        platformName: "win32",
        discoverBundle: () => ({ ok: true, bundlePath: join(root, "bundle") }),
        copyFile: () => { copyCalls += 1; },
        runPython: () => { candidateSpawns += 1; return { status: 0 }; },
      });
      assert.equal(escaped.reason, "candidate_runtime_untrusted");
      assert.equal(candidateSpawns, 0);
      assert.equal(copyCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("first launch strips inherited offline flags and explicitly enables ONNX download", () => {
    const env = buildInitialMemoryServiceEnv({
      KEEP: "yes",
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      MCP_MEMORY_ONNX_ALLOW_DOWNLOAD: "0",
    });

    assert.equal(env.KEEP, "yes");
    assert.equal(Object.hasOwn(env, "HF_HUB_OFFLINE"), false);
    assert.equal(Object.hasOwn(env, "TRANSFORMERS_OFFLINE"), false);
    assert.equal(env.MCP_MEMORY_ONNX_ALLOW_DOWNLOAD, "1");
    assert.equal(env.MCP_MEMORY_ALLOW_HASH_EMBEDDINGS, "0");
    assert.equal(env.MCP_MEMORY_USE_ONNX, "1");
    const logs = firstStartLogPaths(resolve("fixture-home"));
    assert.match(logs.stdoutLog.replace(/\\/g, "/"), /\.meta-kim\/mcp-memory-first-start\.out\.log$/);
    assert.match(logs.stderrLog.replace(/\\/g, "/"), /\.meta-kim\/mcp-memory-first-start\.err\.log$/);
  });

  test("boot launch is explicitly offline and disables ONNX download", () => {
    const env = buildBootMemoryServiceEnv({ KEEP: "yes" });

    assert.equal(env.KEEP, "yes");
    assert.equal(env.HF_HUB_OFFLINE, "1");
    assert.equal(env.TRANSFORMERS_OFFLINE, "1");
    assert.equal(env.MCP_MEMORY_ONNX_ALLOW_DOWNLOAD, "0");
    assert.equal(env.MCP_MEMORY_ALLOW_HASH_EMBEDDINGS, "0");
    assert.equal(env.MCP_MEMORY_USE_ONNX, "1");
    assert.match(setupSource, /MCP_MEMORY_ONNX_ALLOW_DOWNLOAD/);
  });

  test("cold start remains pending beyond ten seconds and can become healthy later", async () => {
    let clockMs = 0;
    let probes = 0;
    const result = await waitForMcpMemoryHealth({
      probeHealth: async () => {
        probes += 1;
        return clockMs >= 12_000;
      },
      timeoutMs: MCP_MEMORY_COLD_START_TIMEOUT_MS,
      pollIntervalMs: 1_500,
      now: () => clockMs,
      sleep: async (ms) => {
        clockMs += ms;
      },
    });

    assert.deepEqual(result, { healthy: true, reason: "healthy" });
    assert.ok(clockMs >= 12_000);
    assert.ok(probes > 7);
    assert.equal(MCP_MEMORY_COLD_START_TIMEOUT_MS, 300_000);
  });

  test("cold start tolerates a console launcher exit while the owned server continues initializing", async () => {
    let clockMs = 0;
    const result = await waitForMcpMemoryHealth({
      probeHealth: async () => clockMs >= 45_000,
      childState: { spawnError: null, exited: true, exitCode: 0, signal: null },
      allowLauncherExit: true,
      timeoutMs: 300_000,
      pollIntervalMs: 1_500,
      now: () => clockMs,
      sleep: async (ms) => { clockMs += ms; },
    });
    assert.deepEqual(result, { healthy: true, reason: "healthy" });
    assert.ok(clockMs >= 45_000);
  });

  test("cold start reports spawn errors and early exits", async () => {
    const spawnError = await waitForMcpMemoryHealth({
      probeHealth: async () => false,
      childState: { spawnError: new Error("fixture"), exited: false },
    });
    const earlyExit = await waitForMcpMemoryHealth({
      probeHealth: async () => false,
      childState: { spawnError: null, exited: true, exitCode: 2, signal: null },
    });

    assert.deepEqual(spawnError, { healthy: false, reason: "spawn_error" });
    assert.deepEqual(earlyExit, {
      healthy: false,
      reason: "early_exit",
      exitCode: 2,
      signal: null,
    });
  });

  test("absolute Python health probe works with an empty PATH and no Node lookup", async () => {
    const python = findPythonExecutable();
    assert.ok(python, "an absolute Python executable is required for this setup test");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"healthy"}');
    });
    servers.add(server);
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    const result = await runProcess(
      python,
      pythonMemoryHealthProbeArgs(`http://127.0.0.1:${address.port}/api/health`),
      {
        env: { PATH: "", SystemRoot: process.env.SystemRoot ?? "" },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    await new Promise((resolveClose) => server.close(resolveClose));
    servers.delete(server);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.doesNotMatch(setupSource, /command -v node|node -e/);
    assert.match(setupSource, /PYTHON_MEMORY_HEALTH_PROBE/);
  });

  test("boot launchers contain no GUI notifier", () => {
    assert.doesNotMatch(
      setupSource,
      /MessageBox|display dialog|notify-send|zenity|kdialog|xmessage/,
    );
  });

  test("endpoint mkdir lock rechecks health before starting", async () => {
    const lockRoot = mkdtempSync(join(tmpdir(), "meta-kim-memory-lock-"));
    const endpoint = {
      hostname: "127.0.0.1",
      port: "8123",
      endpointUrl: "http://127.0.0.1:8123",
    };
    let starts = 0;
    try {
      const result = await withEndpointStartLock({
        endpoint,
        lockRoot,
        probeHealth: async () => true,
        start: async () => { starts += 1; return { ok: true, started: true }; },
      });
      assert.deepEqual(result, {
        ok: true,
        started: false,
        reason: "already_healthy_after_lock",
      });
      assert.equal(starts, 0);

      const held = acquireEndpointStartLock({ endpoint, lockRoot });
      assert.equal(held.acquired, true);
      const blocked = acquireEndpointStartLock({ endpoint, lockRoot });
      assert.equal(blocked.acquired, false);
      assert.equal(blocked.reason, "lock_owner_alive");
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  test("lock takeover is owner-aware across live, dead, BOM, and missing-owner states", () => {
    const lockRoot = mkdtempSync(join(tmpdir(), "meta-kim-memory-owner-lock-"));
    const endpoint = {
      hostname: "127.0.0.1",
      port: "8124",
      endpointUrl: "http://127.0.0.1:8124",
    };
    try {
      const first = acquireEndpointStartLock({
        endpoint,
        lockRoot,
        now: () => 1_000,
        ttlMs: 100,
        ownerPid: 77,
        ownerStartIdentity: "live-start",
        isOwnerAlive: () => true,
      });
      assert.equal(first.acquired, true);
      const owner = readFileSync(first.ownerPath, "utf8");
      writeFileSync(first.ownerPath, `\ufeff${owner}`, "utf8");
      const liveExpired = acquireEndpointStartLock({
        endpoint,
        lockRoot,
        now: () => 2_000,
        isOwnerAlive: () => true,
      });
      assert.equal(liveExpired.acquired, false);
      assert.equal(liveExpired.reason, "lock_owner_alive");
      const deadExpired = acquireEndpointStartLock({
        endpoint,
        lockRoot,
        now: () => 2_000,
        isOwnerAlive: () => false,
      });
      assert.equal(deadExpired.acquired, true);
      assert.equal(releaseEndpointStartLock(first), false, "old token must not delete new owner lock");
      assert.equal(releaseEndpointStartLock(deadExpired), true);

      const missingOwnerPath = join(lockRoot, "mcp-memory-127.0.0.1-8124.lock");
      mkdirSync(missingOwnerPath);
      utimesSync(missingOwnerPath, new Date(0), new Date(0));
      const recovered = acquireEndpointStartLock({
        endpoint,
        lockRoot,
        now: () => 10_000,
        ttlMs: 100,
        isOwnerAlive: () => false,
      });
      assert.equal(recovered.acquired, true);
      assert.equal(releaseEndpointStartLock(recovered), true);
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  test("concurrent endpoint lock attempts have one winner", () => {
    const lockRoot = mkdtempSync(join(tmpdir(), "meta-kim-memory-concurrent-lock-"));
    const endpoint = {
      hostname: "127.0.0.1",
      port: "8125",
      endpointUrl: "http://127.0.0.1:8125",
    };
    try {
      const attempts = Array.from({ length: 8 }, () => acquireEndpointStartLock({
        endpoint,
        lockRoot,
        isOwnerAlive: () => true,
      }));
      assert.equal(attempts.filter(({ acquired }) => acquired).length, 1);
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });
});
