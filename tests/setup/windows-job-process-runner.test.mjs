import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { runWindowsGuardedCommand } from "../../scripts/eval-process-runner.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const launcherPath = path.join(repoRoot, "scripts", "windows-job-process-runner.ps1");
const powershell = "powershell.exe";
// This fixture compiles the Windows launcher, then starts a three-process
// tree. Keep its readiness observation aligned with the guard deadline so a
// cold start cannot be mistaken for an owned-tree cleanup failure.
const TIMEOUT_CLEANUP_GUARD_TIMEOUT_MS = 20_000;
const TIMEOUT_CLEANUP_READY_TIMEOUT_MS = TIMEOUT_CLEANUP_GUARD_TIMEOUT_MS;
// Early launcher failure must surface well before the 10-second guard timeout.
const EARLY_LAUNCHER_EXIT_BUDGET_MS = 8_000;
const testTempDirectories = new Set();
const testTempRoot = path.resolve(os.tmpdir());

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerTestDirectory(tempDir) {
  const resolved = path.resolve(tempDir);
  const relative = path.relative(testTempRoot, resolved);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.dirname(relative) !== "." ||
    !path.basename(resolved).startsWith("meta-kim-job-")
  ) {
    throw new Error(`Refusing to clean an unregistered test directory: ${resolved}`);
  }
  testTempDirectories.add(resolved);
}

after(() => {
  const cleanupErrors = [];
  for (const tempDir of testTempDirectories) {
    try {
      rmSync(tempDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Failed to remove registered Windows Job Object test directories",
    );
  }
});

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
}

async function waitForCondition(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function captureOwnedIdentities(pids) {
  const idList = pids.map(Number).join(",");
  const command = [
    `$ids = @(${idList})`,
    "$rows = @()",
    "foreach ($id in $ids) { try { $p = [System.Diagnostics.Process]::GetProcessById($id); $rows += [ordered]@{ pid = [int]$id; startTicks = [string]$p.StartTime.ToUniversalTime().Ticks } } catch {} }",
    "ConvertTo-Json -InputObject $rows -Compress",
  ].join("; ");
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const rows = JSON.parse(result.stdout);
  return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
    pid: row.pid,
    startTicks: row.startTicks,
  }));
}

function directChildPids(parentPid) {
  const command = [
    `$ids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${Number(parentPid)}" | ForEach-Object { [int]$_.ProcessId })`,
    "Write-Output ('[' + (($ids | ForEach-Object { [string]$_ }) -join ',') + ']')",
  ].join("; ");
  const result = spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (result.status !== 0 || !result.stdout.trim()) return [];
  return JSON.parse(result.stdout.trim());
}

function pidAppearsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopOwnedProcesses(identities) {
  if (identities.length === 0) return;
  const expected = identities
    .map((identity) => `'${Number(identity.pid)}' = [long]${identity.startTicks}`)
    .join("; ");
  const command = [
    `$expected = @{ ${expected} }`,
    "foreach ($entry in $expected.GetEnumerator()) { try { $p = [System.Diagnostics.Process]::GetProcessById([int]$entry.Key); if ($p.StartTime.ToUniversalTime().Ticks -eq [long]$entry.Value) { $p.Kill() } } catch {} }",
  ].join("; ");
  spawnSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
}

async function waitForOwnedProcessesToExit(identities, timeoutMs = 10_000) {
  await waitForCondition(
    () => identities.every((identity) => !pidAppearsAlive(identity.pid)),
    "owned process tree to exit",
    timeoutMs,
  );
}

function waitForChildExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for pid ${child.pid} to exit`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

function writeTreeFixture(
  tempDir,
  {
    rootMode = "hold",
    exitCode = 0,
    floodBytes = 0,
    floodStream = "stdout",
  } = {},
) {
  const grandchildScript = path.join(tempDir, "grandchild.mjs");
  const childScript = path.join(tempDir, "child.mjs");
  const rootScript = path.join(tempDir, "root.mjs");
  const pidsPath = path.join(tempDir, "pids.json");
  const releasePath = path.join(tempDir, "release-root");

  writeFileSync(grandchildScript, "setInterval(() => {}, 1000);\n", "utf8");
  writeFileSync(
    childScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const grandchild = spawn(process.execPath, [process.env.META_KIM_GRANDCHILD], { stdio: "ignore", windowsHide: true });',
      'writeFileSync(process.env.META_KIM_PIDS, JSON.stringify({ root: Number(process.env.META_KIM_ROOT_PID), child: process.pid, grandchild: grandchild.pid }));',
      'setInterval(() => {}, 1000);',
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    rootScript,
    [
      'import { spawn } from "node:child_process";',
      'import { existsSync } from "node:fs";',
      `spawn(process.execPath, [${JSON.stringify(childScript)}], {`,
      `  env: { ...process.env, META_KIM_GRANDCHILD: ${JSON.stringify(grandchildScript)}, META_KIM_PIDS: ${JSON.stringify(pidsPath)}, META_KIM_ROOT_PID: String(process.pid) },`,
      '  stdio: "ignore", windowsHide: true,',
      "});",
      "const deadline = Date.now() + 10000;",
      `while (!existsSync(${JSON.stringify(pidsPath)}) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));`,
      `if (!existsSync(${JSON.stringify(pidsPath)})) throw new Error("child tree did not become ready");`,
      floodBytes > 0 || rootMode === "exit"
        ? "const releaseDeadline = Date.now() + 10000;"
        : "",
      floodBytes > 0 || rootMode === "exit"
        ? `while (!existsSync(${JSON.stringify(releasePath)}) && Date.now() < releaseDeadline) await new Promise((resolve) => setTimeout(resolve, 10));`
        : "",
      floodBytes > 0 || rootMode === "exit"
        ? `if (!existsSync(${JSON.stringify(releasePath)})) throw new Error("root release was not signaled");`
        : "",
      floodBytes > 0
        ? `process.${floodStream === "stderr" ? "stderr" : "stdout"}.write(Buffer.alloc(${floodBytes}, 120));`
        : "",
      rootMode === "exit"
        ? `process.exit(${Number(exitCode)});`
        : "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );

  return { pidsPath, releasePath, rootScript };
}

function writeSpec(tempDir, rootScript) {
  const specPath = path.join(tempDir, "spec.json");
  writeFileSync(
    specPath,
    JSON.stringify({ file: process.execPath, args: [rootScript], cwd: tempDir }),
    "utf8",
  );
  return specPath;
}

function startLauncherForSpec(tempDir, specPath) {
  const stopPath = path.join(tempDir, "stop");
  const resultPath = path.join(tempDir, "result.json");
  const child = spawn(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "-SpecPath",
      specPath,
      "-StopPath",
      stopPath,
      "-ResultPath",
      resultPath,
      "-OwnerPid",
      String(process.pid),
    ],
    { cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  return { child, resultPath, stopPath };
}

function startLauncher(tempDir, rootScript) {
  return startLauncherForSpec(tempDir, writeSpec(tempDir, rootScript));
}

async function readOwnedTree(pidsPath, timeoutMs = 10_000) {
  await waitForFile(pidsPath, timeoutMs);
  const pids = Object.values(JSON.parse(readFileSync(pidsPath, "utf8")));
  assert.equal(pids.length, 3);
  assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
  const identities = captureOwnedIdentities(pids);
  assert.equal(identities.length, pids.length);
  assert.ok(identities.every((identity) => /^\d+$/u.test(identity.startTicks)));
  return identities;
}

async function expectRejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected guarded command to reject");
}

function assertNoWholeTreeClaim(value) {
  assert.equal(Object.hasOwn(value, "processTreeCleanupVerified"), false);
  assert.equal(value.processTreeCleanupClaim, "not_claimed");
  assert.equal(
    value.processTreeCleanupBoundary,
    "out_of_job_process_creation_not_covered",
  );
}

describe(
  "Windows Job Object evaluator process runner",
  { skip: process.platform !== "win32" },
  () => {
    test("classifies outer spec failures without serializing private diagnostics", async () => {
      const cases = [
        {
          name: "read",
          prepareSpec: (tempDir) => path.join(tempDir, "PRIVATE-missing-spec.json"),
          reason: "launcher_spec_read_failed",
          operation: "read_spec",
        },
        {
          name: "parse",
          prepareSpec: (tempDir) => {
            const specPath = path.join(tempDir, "PRIVATE-parse-spec.json");
            writeFileSync(specPath, '{"file":"PRIVATE command --token secret"', "utf8");
            return specPath;
          },
          reason: "launcher_spec_parse_failed",
          operation: "parse_spec",
        },
        {
          name: "validation",
          prepareSpec: (tempDir) => {
            const specPath = path.join(tempDir, "PRIVATE-validation-spec.json");
            writeFileSync(
              specPath,
              JSON.stringify({ file: "PRIVATE command --token secret" }),
              "utf8",
            );
            return specPath;
          },
          reason: "launcher_spec_validation_failed",
          operation: "validate_spec",
        },
      ];

      for (const fixture of cases) {
        const tempDir = mkdtempSync(
          path.join(os.tmpdir(), `meta-kim-job-${fixture.name}-`),
        );
        const specPath = fixture.prepareSpec(tempDir);
        const launcher = startLauncherForSpec(tempDir, specPath);
        try {
          const exit = await waitForChildExit(launcher.child);
          assert.equal(exit.code, 2);
          await waitForFile(launcher.resultPath);
          const raw = readFileSync(launcher.resultPath, "utf8");
          const result = JSON.parse(raw);
          assert.equal(result.verified, false);
          assert.equal(result.reason, fixture.reason);
          assert.equal(result.failureOperation, fixture.operation);
          assert.equal(result.win32Error, null);
          assert.equal(Object.hasOwn(result, "detail"), false);
          assert.equal(Object.hasOwn(result, "cleanupFailure"), false);
          assert.doesNotMatch(raw, /PRIVATE|secret|--token|spec\.json/u);
        } finally {
          if (launcher.child.exitCode === null) launcher.child.kill("SIGKILL");
          registerTestDirectory(tempDir);
        }
      }
    });

    test("round-trips no-BOM UTF-8 spec arguments through Windows PowerShell 5.1", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-job-utf8-"));
      const observedPath = path.join(tempDir, "observed-arguments.json");
      const childScript = path.join(tempDir, "observe-arguments.mjs");
      const specPath = path.join(tempDir, "utf8-spec.json");
      const expectedArguments = [
        "中文参数",
        "emoji-😀",
        "café-déjà-vu",
        "日本語と한국어",
      ];
      writeFileSync(
        childScript,
        [
          'import { writeFileSync } from "node:fs";',
          "const [outputPath, ...observed] = process.argv.slice(2);",
          'writeFileSync(outputPath, JSON.stringify(observed), "utf8");',
          "",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        specPath,
        JSON.stringify({
          file: process.execPath,
          args: [childScript, observedPath, ...expectedArguments],
          cwd: tempDir,
        }),
        "utf8",
      );
      const launcher = startLauncherForSpec(tempDir, specPath);

      try {
        const exit = await waitForChildExit(launcher.child);
        assert.equal(exit.code, 0);
        await waitForFile(observedPath);
        assert.deepEqual(
          JSON.parse(readFileSync(observedPath, "utf8")),
          expectedArguments,
        );
        await waitForFile(launcher.resultPath);
        const raw = readFileSync(launcher.resultPath, "utf8");
        const result = JSON.parse(raw);
        assert.equal(result.verified, true);
        assert.equal(result.reason, "process_exited_job_drained");
        assert.equal(result.childExitCode, 0);
        assert.equal(result.activeProcesses, 0);
        assert.equal(Object.hasOwn(result, "detail"), false);
        assert.equal(Object.hasOwn(result, "cleanupFailure"), false);
        assert.doesNotMatch(raw, /中文参数|emoji|café|日本語|한국어|utf8-spec/u);
      } finally {
        if (launcher.child.exitCode === null) launcher.child.kill("SIGKILL");
        registerTestDirectory(tempDir);
      }
    });

    test("stops root, child, and grandchild and writes verified result truth", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-job-stop-"));
      const { pidsPath, rootScript } = writeTreeFixture(tempDir);
      const launcher = startLauncher(tempDir, rootScript);
      let identities = [];
      try {
        identities = await readOwnedTree(pidsPath);
        writeFileSync(launcher.stopPath, "stop", "utf8");
        const exit = await waitForChildExit(launcher.child);
        assert.equal(exit.code, 0);
        await waitForFile(launcher.resultPath);
        const result = JSON.parse(readFileSync(launcher.resultPath, "utf8"));
        assert.equal(typeof result.schemaVersion, "string");
        assert.equal(result.verified, true);
        assert.equal(typeof result.reason, "string");
        assert.equal(result.activeProcesses, 0);
        assert.equal(result.stopRequested, true);
        assert.ok(result.childExitCode === null || Number.isInteger(result.childExitCode));
        await waitForOwnedProcessesToExit(identities);
      } finally {
        if (launcher.child.exitCode === null) launcher.child.kill("SIGKILL");
        stopOwnedProcesses(identities);
        registerTestDirectory(tempDir);
      }
    });

    test("preserves child exit truth while draining descendants after root exit", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-job-exit-"));
      const { pidsPath, releasePath, rootScript } = writeTreeFixture(tempDir, {
        rootMode: "exit",
        exitCode: 23,
      });
      const launcher = startLauncher(tempDir, rootScript);
      let identities = [];
      try {
        identities = await readOwnedTree(pidsPath);
        writeFileSync(releasePath, "exit", "utf8");
        const exit = await waitForChildExit(launcher.child);
        assert.equal(exit.code, 0);
        await waitForFile(launcher.resultPath);
        const result = JSON.parse(readFileSync(launcher.resultPath, "utf8"));
        assert.equal(result.verified, true);
        assert.equal(result.childExitCode, 23);
        assert.equal(result.activeProcesses, 0);
        assert.equal(result.stopRequested, false);
        await waitForOwnedProcessesToExit(identities);
      } finally {
        if (launcher.child.exitCode === null) launcher.child.kill("SIGKILL");
        stopOwnedProcesses(identities);
        registerTestDirectory(tempDir);
      }
    });

    test("kills the assigned tree when the launcher crashes and closes its Job handle", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-job-crash-"));
      const { pidsPath, rootScript } = writeTreeFixture(tempDir);
      const launcher = startLauncher(tempDir, rootScript);
      let identities = [];
      try {
        identities = await readOwnedTree(pidsPath);
        const exitPromise = waitForChildExit(launcher.child);
        assert.equal(launcher.child.kill("SIGKILL"), true);
        await exitPromise;
        await waitForOwnedProcessesToExit(identities);
      } finally {
        if (launcher.child.exitCode === null) launcher.child.kill("SIGKILL");
        stopOwnedProcesses(identities);
        registerTestDirectory(tempDir);
      }
    });

    test("owner lease drains the Job when the Node supervisor dies", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-job-owner-death-"));
      const { pidsPath, rootScript } = writeTreeFixture(tempDir);
      const helperScript = path.join(tempDir, "supervisor.mjs");
      writeFileSync(
        helperScript,
        [
          'import { pathToFileURL } from "node:url";',
          'const { runWindowsGuardedCommand } = await import(pathToFileURL(process.env.META_KIM_RUNNER_MODULE).href);',
          "await runWindowsGuardedCommand(process.execPath, [process.env.META_KIM_ROOT_SCRIPT], {",
          "  cwd: process.cwd(),",
          "  timeout: 60000,",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );
      const supervisor = spawn(process.execPath, [helperScript], {
        cwd: tempDir,
        env: {
          ...process.env,
          META_KIM_ROOT_SCRIPT: rootScript,
          META_KIM_RUNNER_MODULE: path.join(repoRoot, "scripts", "eval-process-runner.mjs"),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let treeIdentities = [];
      let launcherIdentities = [];
      let observedLauncherPids = [];
      try {
        treeIdentities = await readOwnedTree(pidsPath);
        await waitForCondition(
          () => {
            observedLauncherPids = directChildPids(supervisor.pid);
            return observedLauncherPids.length > 0;
          },
          "owned PowerShell launcher",
          30_000,
        );
        launcherIdentities = captureOwnedIdentities(observedLauncherPids);
        assert.ok(launcherIdentities.length >= 1);

        const supervisorExit = waitForChildExit(supervisor);
        assert.equal(supervisor.kill("SIGKILL"), true);
        await supervisorExit;
        await waitForOwnedProcessesToExit(treeIdentities);
        await waitForOwnedProcessesToExit(launcherIdentities);
      } finally {
        if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
        stopOwnedProcesses([...treeIdentities, ...launcherIdentities]);
        registerTestDirectory(tempDir);
      }
    });

    test("fails quickly when a launcher exits without a verified result", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-job-no-result-"));
      const fakeLauncher = path.join(tempDir, "fake-launcher.ps1");
      writeFileSync(
        fakeLauncher,
        [
          "param([string]$SpecPath, [string]$StopPath, [string]$ResultPath)",
          "Write-Output 'META_KIM_JOB_READY'",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      const startedAt = Date.now();
      try {
        const error = await expectRejected(
          runWindowsGuardedCommand(process.execPath, ["-e", "process.exit(0)"], {
            cwd: tempDir,
            launcherPath: fakeLauncher,
            timeout: 10_000,
          }),
        );
        assert.ok(
          Date.now() - startedAt < EARLY_LAUNCHER_EXIT_BUDGET_MS,
          `failure took ${Date.now() - startedAt}ms`,
        );
        assert.equal(
          error.code,
          "META_KIM_WINDOWS_JOB_PROCESS_GROUP_LAUNCHER_EARLY_EXIT",
        );
        assert.equal(error.ownedProcessGroupCleanupVerified, false);
        assert.equal(error.ownedProcessGroupCleanupReason, "launcher_result_missing");
        assertNoWholeTreeClaim(error);
      } finally {
        registerTestDirectory(tempDir);
      }
    });

    test("does not retain a stale cleanup timer after early launcher exit", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-job-no-timer-"));
      const fakeLauncher = path.join(tempDir, "fake-launcher.ps1");
      const helperScript = path.join(tempDir, "invoke-runner.mjs");
      const errorPath = path.join(tempDir, "error.json");
      writeFileSync(
        fakeLauncher,
        [
          "param([string]$SpecPath, [string]$StopPath, [string]$ResultPath)",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        helperScript,
        [
          'import { writeFileSync } from "node:fs";',
          'import { pathToFileURL } from "node:url";',
          'const { runWindowsGuardedCommand } = await import(pathToFileURL(process.env.META_KIM_RUNNER_MODULE).href);',
          "try {",
          '  await runWindowsGuardedCommand(process.execPath, ["-e", "process.exit(0)"], {',
          "    cwd: process.cwd(),",
          "    launcherPath: process.env.META_KIM_FAKE_LAUNCHER,",
          "    timeout: 10000,",
          "  });",
          '} catch (error) { writeFileSync(process.env.META_KIM_ERROR_PATH, JSON.stringify({ code: error.code, reason: error.ownedProcessGroupCleanupReason, claim: error.processTreeCleanupClaim })); }',
          "",
        ].join("\n"),
        "utf8",
      );
      const startedAt = Date.now();
      const helper = spawn(process.execPath, [helperScript], {
        cwd: tempDir,
        env: {
          ...process.env,
          META_KIM_ERROR_PATH: errorPath,
          META_KIM_FAKE_LAUNCHER: fakeLauncher,
          META_KIM_RUNNER_MODULE: path.join(repoRoot, "scripts", "eval-process-runner.mjs"),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      try {
        await waitForFile(errorPath);
        const error = JSON.parse(readFileSync(errorPath, "utf8"));
        assert.deepEqual(error, {
          code: "META_KIM_WINDOWS_JOB_PROCESS_GROUP_LAUNCHER_EARLY_EXIT",
          reason: "launcher_result_missing",
          claim: "not_claimed",
        });
        const exit = await waitForChildExit(
          helper,
          EARLY_LAUNCHER_EXIT_BUDGET_MS,
        );
        assert.equal(exit.code, 0);
        assert.ok(
          Date.now() - startedAt < EARLY_LAUNCHER_EXIT_BUDGET_MS,
          `helper exit took ${Date.now() - startedAt}ms`,
        );
      } finally {
        if (helper.exitCode === null) helper.kill("SIGKILL");
        registerTestDirectory(tempDir);
      }
    });

    test("timeout drains the wrapper and its complete owned tree", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-job-timeout-"));
      const { pidsPath, rootScript } = writeTreeFixture(tempDir);
      let identities = [];
      try {
        const rejection = expectRejected(
          runWindowsGuardedCommand(process.execPath, [rootScript], {
            cwd: tempDir,
            timeout: TIMEOUT_CLEANUP_GUARD_TIMEOUT_MS,
            outputLimitBytes: 64 * 1024,
            tailBytes: 1024,
          }),
        );
        identities = await readOwnedTree(
          pidsPath,
          TIMEOUT_CLEANUP_READY_TIMEOUT_MS,
        );
        const error = await rejection;
        assert.equal(error.timeoutMs, TIMEOUT_CLEANUP_GUARD_TIMEOUT_MS);
        assert.equal(error.ownedProcessGroupCleanupVerified, true);
        assertNoWholeTreeClaim(error);
        await waitForOwnedProcessesToExit(identities);
      } finally {
        stopOwnedProcesses(identities);
        registerTestDirectory(tempDir);
      }
    });

    for (const streamName of ["stdout", "stderr"]) {
      test(`${streamName} flood returns bounded evidence and leaves no descendants`, async () => {
        const tempDir = mkdtempSync(
          path.join(os.tmpdir(), `meta-kim-job-${streamName}-flood-`),
        );
        const { pidsPath, releasePath, rootScript } = writeTreeFixture(tempDir, {
          floodBytes: 2 * 1024 * 1024,
          floodStream: streamName,
        });
        let identities = [];
        try {
          const guarded = runWindowsGuardedCommand(process.execPath, [rootScript], {
            cwd: tempDir,
            timeout: 15_000,
            outputLimitBytes: 4_096,
            tailBytes: 256,
          });
          identities = await readOwnedTree(pidsPath);
          writeFileSync(releasePath, "flood", "utf8");
          const error = await expectRejected(guarded);
          const metadata = error[`${streamName}Metadata`];
          assert.equal(error.code, "META_KIM_COMMAND_OUTPUT_LIMIT_EXCEEDED");
          assert.equal(error.ownedProcessGroupCleanupVerified, true);
          assertNoWholeTreeClaim(error);
          assert.deepEqual(error.outputLimitStreams, [streamName]);
          assert.equal(metadata.limitExceeded, true);
          assert.ok(metadata.bytesCaptured <= 4_096);
          assert.ok(metadata.tailBytesCaptured <= 256);
          assert.ok(Buffer.byteLength(error[streamName], "utf8") <= 4_096);
          assert.equal(typeof metadata.sha256, "string");
          assert.equal(metadata.sha256.length, 64);
          await waitForOwnedProcessesToExit(identities);
        } finally {
          stopOwnedProcesses(identities);
          registerTestDirectory(tempDir);
        }
      });
    }
  },
);
