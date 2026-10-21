import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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
import { buildIsolatedTestEnvironment } from "../../scripts/run-local-verification.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const launcherPath = path.join(repoRoot, "scripts", "windows-job-process-runner.ps1");
const powershell = "powershell.exe";
// This fixture compiles the Windows launcher, then starts a three-process
// tree. Keep its readiness observation aligned with the guard deadline so a
// cold start cannot be mistaken for an owned-tree cleanup failure.
const TIMEOUT_CLEANUP_GUARD_TIMEOUT_MS = 20_000;
const TIMEOUT_CLEANUP_READY_TIMEOUT_MS = TIMEOUT_CLEANUP_GUARD_TIMEOUT_MS;
// This is a test-only preparation window for fixtures without a release gate,
// not a product startup-performance contract or a post-kill cleanup allowance.
const DIRECT_LAUNCHER_FIXTURE_READY_TIMEOUT_MS = 20_000;
const FLOOD_GUARD_TIMEOUT_MS = 15_000;
// Early launcher failure must surface well before the 10-second guard timeout.
const EARLY_LAUNCHER_EXIT_BUDGET_MS = 8_000;
const testTempDirectories = new Set();
const testTempRoot = path.resolve(os.tmpdir());

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function coldPowerShellEnvironment(tempDir) {
  const home = path.join(tempDir, "isolated-home");
  const env = buildIsolatedTestEnvironment(home);
  for (const key of [
    "HOME", "APPDATA", "LOCALAPPDATA", "TMP", "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "npm_config_cache",
  ]) {
    mkdirSync(env[key], { recursive: true });
  }
  env.PSModuleAnalysisCachePath = path.join(env.LOCALAPPDATA, "ModuleAnalysisCache");
  assert.equal(existsSync(env.PSModuleAnalysisCachePath), false);
  assert.equal(Object.keys(env).some((key) => key.toUpperCase() === "PSMODULEPATH"), false);
  return env;
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

/** Test-only, content-free diagnostics for one bounded identity query. */
function captureOwnedIdentityObservation(pids, {
  timeoutMs = 5_000, spawnSyncImpl = spawnSync, now = Date.now,
} = {}) {
  assert.ok(pids.length > 0 && pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
  assert.equal(new Set(pids).size, pids.length);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5_000);
  const idList = pids.map(Number).join(",");
  const command = [
    `$ids = @(${idList})`,
    "$rows = [System.Collections.Generic.List[string]]::new()",
    "$failures = [System.Collections.Generic.List[string]]::new()",
    // Only integer PIDs, numeric OS ticks and fixed failure enums enter this
    // JSON. Console output avoids importing a module just to serialize them.
    "foreach ($id in $ids) { try { $p = [System.Diagnostics.Process]::GetProcessById($id); $ticks = [string]$p.StartTime.ToUniversalTime().Ticks; $rows.Add('{\"pid\":' + [string]$id + ',\"startTicks\":\"' + $ticks + '\"}') } catch { $failure = $_.Exception.GetBaseException(); $category = 'process_query_failed'; if ($failure -is [System.ArgumentException]) { $category = 'pid_missing' } elseif ($failure -is [System.ComponentModel.Win32Exception] -and $failure.NativeErrorCode -eq 5) { $category = 'access_denied' }; $failures.Add('{\"pid\":' + [string]$id + ',\"category\":\"' + $category + '\"}') } }",
    "[Console]::Out.Write('{\"identities\":[' + [string]::Join(',', $rows.ToArray()) + '],\"failures\":[' + [string]::Join(',', $failures.ToArray()) + ']}')",
  ].join("; ");
  const startedAt = now();
  const result = spawnSyncImpl(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
  );
  const stdout = String(result.stdout ?? "");
  const diagnostic = {
    category: "query_ok", status: Number.isInteger(result.status) ? result.status : null,
    signal: ["SIGTERM", "SIGKILL", "SIGINT"].includes(result.signal) ? result.signal : null,
    errorCode: result.error
      ? (["ETIMEDOUT", "EACCES", "EPERM", "ENOENT", "EINVAL"].includes(result.error.code) ? result.error.code : "OTHER")
      : null,
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(String(result.stderr ?? "")),
    elapsedMs: Math.max(0, now() - startedAt), timeoutMs,
  };
  const failure = (category) => ({ identities: [], diagnostic: { ...diagnostic, category } });
  if (result.error) return failure(result.error.code === "ETIMEDOUT" ? "query_timeout" : "query_spawn_failed");
  if (result.status !== 0) return failure("query_exit_nonzero");
  if (!stdout.trim()) return failure("query_empty_output");
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return failure("query_malformed_output"); }
  if (!parsed || !Array.isArray(parsed.identities) || !Array.isArray(parsed.failures)) {
    return failure("query_malformed_output");
  }
  if (parsed.failures.length > 0) {
    if (parsed.failures.some((item) => !pids.includes(item?.pid)
      || !["pid_missing", "access_denied", "process_query_failed"].includes(item?.category))) {
      return failure("query_malformed_output");
    }
    if (parsed.failures.some((item) => item.category === "access_denied")) return failure("query_access_denied");
    if (parsed.failures.some((item) => item.category === "pid_missing")) return failure("query_pid_missing");
    return failure("query_process_failure");
  }
  const rows = parsed.identities;
  if (rows.length !== pids.length || new Set(rows.map((row) => row?.pid)).size !== pids.length
    || rows.some((row) => !pids.includes(row?.pid) || typeof row?.startTicks !== "string"
      || !/^\d+$/u.test(row.startTicks))) return failure("query_identity_mismatch");
  return { identities: rows.map(({ pid, startTicks }) => ({ pid, startTicks })), diagnostic };
}

function identityObservationError(diagnostic) {
  const measurements = Object.fromEntries(
    ["timeoutMs", "elapsedMs", "attempts", "stdoutBytes", "stderrBytes"]
      .filter((key) => Number.isFinite(diagnostic[key]) && diagnostic[key] >= 0)
      .map((key) => [key, diagnostic[key]]),
  );
  const error = new Error(`Owned process identity observation failed: ${diagnostic.category} ${JSON.stringify(measurements)}`);
  error.observationDiagnostic = diagnostic;
  return error;
}

function captureOwnedIdentities(pids) {
  const observed = captureOwnedIdentityObservation(pids);
  if (observed.diagnostic.category !== "query_ok") throw identityObservationError(observed.diagnostic);
  return observed.identities;
}

/** All retries share the caller's original deadline; only a query timeout is transient. */
async function observeOwnedTreeWithDeadline(pids, {
  deadline, now = Date.now, sleep = delay,
  capture = (requested, timeoutMs) => captureOwnedIdentityObservation(requested, { timeoutMs }),
}) {
  let attempts = 0;
  let diagnostic = { category: "readiness_deadline_exhausted", stdoutBytes: 0, stderrBytes: 0 };
  while (now() < deadline) {
    const timeoutMs = Math.min(5_000, Math.floor(deadline - now()));
    if (timeoutMs <= 0) break;
    const observed = capture(pids, timeoutMs);
    attempts += 1;
    diagnostic = { ...observed.diagnostic, attempts, deadline };
    if (diagnostic.category === "query_ok") {
      if (now() >= deadline) {
        throw identityObservationError({ ...diagnostic, category: "readiness_deadline_exhausted" });
      }
      return observed.identities;
    }
    if (diagnostic.category !== "query_timeout" || now() >= deadline) throw identityObservationError(diagnostic);
    await sleep(Math.min(25, Math.max(0, deadline - now())));
  }
  throw identityObservationError({ ...diagnostic, attempts, deadline });
}

/** A failed observation never releases its directory before the original guard has settled. */
async function observeWithSettledOwnedGuard({ guarded, observe, verify }) {
  const settled = guarded.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
  let observed;
  let observationError;
  let cleanupError;
  try { observed = await observe(); } catch (error) { observationError = error; }
  const outcome = await settled;
  try { await verify(outcome, observed); } catch (error) { cleanupError = error; }
  if (observationError && cleanupError) {
    throw new AggregateError([observationError, cleanupError], "Identity observation and guarded cleanup both failed");
  }
  if (observationError) throw observationError;
  if (cleanupError) throw cleanupError;
  return observed;
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

function startLauncherForSpec(tempDir, specPath, env) {
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
    { cwd: repoRoot, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  return { child, resultPath, stopPath };
}

function startLauncher(tempDir, rootScript) {
  return startLauncherForSpec(tempDir, writeSpec(tempDir, rootScript));
}

async function readOwnedTree(pidsPath, timeoutMs = 10_000, { deadline = Date.now() + timeoutMs } = {}) {
  await waitForFile(pidsPath, Math.max(0, deadline - Date.now()));
  const pids = Object.values(JSON.parse(readFileSync(pidsPath, "utf8")));
  assert.equal(pids.length, 3);
  assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
  const identities = await observeOwnedTreeWithDeadline(pids, { deadline });
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

describe("owned identity observation diagnostics and teardown", () => {
  const pids = [101, 102, 103];
  const identities = pids.map((pid) => ({ pid, startTicks: String(100000 + pid) }));
  const success = () => ({ status: 0, signal: null, stdout: JSON.stringify({ identities, failures: [] }), stderr: "" });
  const timeout = () => ({ status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" });

  test("explicit query timeout retries within the original deadline and five-second ceiling", async () => {
    let clock = 0;
    const queryTimeouts = [];
    let queries = 0;
    let yields = 0;
    const actual = await observeOwnedTreeWithDeadline(pids, {
      deadline: 9_000, now: () => clock,
      sleep: async () => { yields += 1; clock += 25; },
      capture: (requested, timeoutMs) => captureOwnedIdentityObservation(requested, {
        timeoutMs, now: () => clock,
        spawnSyncImpl: (_file, _args, options) => {
          queryTimeouts.push(options.timeout);
          queries += 1;
          if (queries === 1) { clock += 5_000; return timeout(); }
          return success();
        },
      }),
    });
    assert.deepEqual(actual, identities);
    assert.deepEqual(queryTimeouts, [5_000, 3_975]);
    assert.equal(yields, 1);
  });

  test("query timeout exhaustion preserves the shared deadline", async () => {
    let clock = 0;
    const queryTimeouts = [];
    await assert.rejects(observeOwnedTreeWithDeadline(pids, {
      deadline: 6_000, now: () => clock, sleep: async () => { clock += 25; },
      capture: (requested, timeoutMs) => captureOwnedIdentityObservation(requested, {
        timeoutMs, now: () => clock,
        spawnSyncImpl: (_file, _args, options) => {
          queryTimeouts.push(options.timeout); clock += options.timeout; return timeout();
        },
      }),
    }), (error) => error.observationDiagnostic.category === "query_timeout"
      && error.observationDiagnostic.attempts === 2
      && error.observationDiagnostic.deadline === 6_000);
    assert.deepEqual(queryTimeouts, [5_000, 975]);
    assert.equal(clock, 6_000);
  });

  test("a late successful query cannot extend the original deadline", async () => {
    let clock = 0;
    await assert.rejects(observeOwnedTreeWithDeadline(pids, {
      deadline: 1_000, now: () => clock,
      capture: () => { clock = 1_000; return { identities, diagnostic: { category: "query_ok" } }; },
    }), (error) => error.observationDiagnostic.category === "readiness_deadline_exhausted");
  });

  for (const [category, result] of [
    ["query_spawn_failed", { status: null, error: { code: "EACCES" }, stdout: "", stderr: "" }],
    ["query_spawn_failed", { status: null, error: { code: "private-do-not-echo", message: "private-do-not-echo" }, stdout: "", stderr: "" }],
    ["query_exit_nonzero", { status: 1, stdout: "", stderr: "private-do-not-echo" }],
    ["query_empty_output", { status: 0, stdout: "", stderr: "" }],
    ["query_malformed_output", { status: 0, stdout: "private-do-not-echo", stderr: "" }],
    ["query_pid_missing", { status: 0, stdout: JSON.stringify({ identities: [], failures: [{ pid: 101, category: "pid_missing" }] }), stderr: "" }],
    ["query_access_denied", { status: 0, stdout: JSON.stringify({ identities: [], failures: [{ pid: 101, category: "access_denied" }] }), stderr: "" }],
    ["query_process_failure", { status: 0, stdout: JSON.stringify({ identities: [], failures: [{ pid: 101, category: "process_query_failed" }] }), stderr: "" }],
    ["query_identity_mismatch", { status: 0, stdout: JSON.stringify({ identities: [identities[0], identities[0], identities[2]], failures: [] }), stderr: "" }],
  ]) {
    test(`${category} is diagnostic, private and never retried`, async () => {
      let queries = 0;
      let caught;
      try {
        await observeOwnedTreeWithDeadline(pids, {
          deadline: 20_000, now: () => 0,
          sleep: async () => { assert.fail("fatal observation must not retry"); },
          capture: (requested, timeoutMs) => captureOwnedIdentityObservation(requested, {
            timeoutMs, now: () => 0,
            spawnSyncImpl: () => { queries += 1; return result; },
          }),
        });
      } catch (error) { caught = error; }
      assert.equal(caught?.observationDiagnostic?.category, category);
      assert.equal(queries, 1);
      assert.doesNotMatch(JSON.stringify(caught.observationDiagnostic), /private-do-not-echo/u);
      assert.doesNotMatch(caught.message, /private-do-not-echo/u);
      assert.match(caught.message, /"stdoutBytes":\d+/u);
      assert.equal(typeof caught.observationDiagnostic.stdoutBytes, "number");
    });
  }

  test("observation failure cannot enter teardown before the original guard settles", async () => {
    let settleGuard;
    const guarded = new Promise((resolve) => { settleGuard = resolve; });
    const observationError = new Error("specific observation failure");
    let verified = false;
    let teardown = false;
    const operation = observeWithSettledOwnedGuard({
      guarded,
      observe: async () => { throw observationError; },
      verify: async (outcome) => { assert.equal(outcome.status, "fulfilled"); verified = true; },
    }).finally(() => { teardown = true; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(teardown, false);
    assert.equal(verified, false);
    settleGuard({ guardedFixtureOnly: true });
    await assert.rejects(operation, (error) => error === observationError);
    assert.equal(verified, true);
    assert.equal(teardown, true);
  });

  test("observation and guard cleanup failures remain distinct", async () => {
    const observationError = new Error("specific observation failure");
    const cleanupError = new Error("specific cleanup failure");
    await assert.rejects(observeWithSettledOwnedGuard({
      guarded: Promise.reject(cleanupError),
      observe: async () => { throw observationError; },
      verify: async (outcome) => { assert.equal(outcome.status, "rejected"); throw outcome.error; },
    }), (error) => error instanceof AggregateError
      && error.errors[0] === observationError && error.errors[1] === cleanupError);
  });
});

test("Windows launcher explicitly resolves its built-in cmdlets without ambient discovery", () => {
  const source = readFileSync(launcherPath, "utf8");
  const powershellSource = source.replace(/\$nativeSource = @'[\s\S]*?\r?\n'@/u, "");
  const cmdlets = [
    ["Microsoft.PowerShell.Utility", "New-Object"],
    ["Microsoft.PowerShell.Utility", "ConvertTo-Json"],
    ["Microsoft.PowerShell.Utility", "ConvertFrom-Json"],
    ["Microsoft.PowerShell.Utility", "Add-Type"],
    ["Microsoft.PowerShell.Management", "Test-Path"],
    ["Microsoft.PowerShell.Management", "Get-Content"],
  ];
  for (const [module, cmdlet] of cmdlets) {
    const calls = [...powershellSource.matchAll(
      new RegExp(String.raw`(?<![\w.\\-])(?:([\w.-]+)\\)?${cmdlet}\b`, "gu"),
    )];
    assert.ok(calls.length > 0, `${cmdlet} must be covered`);
    for (const [, resolvedModule] of calls) {
      assert.equal(resolvedModule, module, `${cmdlet} must resolve through ${module}`);
    }
  }
});

describe(
  "Windows Job Object evaluator process runner",
  { skip: process.platform !== "win32" },
  () => {
    test("captures a real cold-cache identity without importing a serializer module", async (t) => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-job-cold-identity-"));
      const observations = [];
      try {
        const env = coldPowerShellEnvironment(tempDir);
        const identities = await observeOwnedTreeWithDeadline([process.pid], {
          deadline: Date.now() + 10_000,
          capture: (requested, timeoutMs) => {
            assert.ok(timeoutMs > 0 && timeoutMs <= 5_000);
            const observed = captureOwnedIdentityObservation(requested, {
              timeoutMs,
              spawnSyncImpl: (file, args, options) => {
                assert.equal(options.timeout, timeoutMs);
                assert.doesNotMatch(args.at(-1), /ConvertTo-Json|Import-Module|Write-Output/u);
                return spawnSync(file, args, { ...options, env });
              },
            });
            observations.push(observed.diagnostic);
            return observed;
          },
        });
        assert.equal(observations.at(-1)?.category, "query_ok");
        assert.ok(observations.slice(0, -1).every(({ category }) => category === "query_timeout"));
        assert.deepEqual(identities.map(({ pid }) => pid), [process.pid]);
        assert.match(identities[0].startTicks, /^\d+$/u);
      } finally {
        t.diagnostic(`cold identity observations ${JSON.stringify(observations)}`);
        registerTestDirectory(tempDir);
      }
    });

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
        const launcher = startLauncherForSpec(tempDir, specPath, coldPowerShellEnvironment(tempDir));
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

    test("preserves exit and cleanup truth with a cold isolated PowerShell module cache", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-job-cold-cache-"));
      try {
        const error = await expectRejected(runWindowsGuardedCommand(
          process.execPath,
          ["-e", 'process.stdout.write("isolated child reached"); process.exit(7);'],
          { cwd: tempDir, env: coldPowerShellEnvironment(tempDir), timeout: 10_000 },
        ));
        assert.equal(error.code, "META_KIM_CHILD_COMMAND_FAILED");
        assert.equal(error.exitCode, 7);
        assert.equal(error.signal, null);
        assert.equal(error.stdout, "isolated child reached");
        assert.equal(error.ownedProcessGroupCleanupVerified, true);
        assert.equal(error.ownedProcessGroupCleanupFailure, false);
        assert.equal(error.ownedProcessGroupCleanupReason, null);
        assert.equal(error.ownedProcessGroupScope, "windows_job_object_owned_process_group");
        assert.equal(error.launcherStillAlive, false);
        assertNoWholeTreeClaim(error);
      } finally {
        registerTestDirectory(tempDir);
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
        identities = await readOwnedTree(pidsPath, DIRECT_LAUNCHER_FIXTURE_READY_TIMEOUT_MS);
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
        identities = await readOwnedTree(pidsPath, DIRECT_LAUNCHER_FIXTURE_READY_TIMEOUT_MS);
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
      const launcherRecordPath = path.join(tempDir, "launcher-pid.json");
      writeFileSync(
        helperScript,
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          'import { pathToFileURL } from "node:url";',
          'const { createWindowsGuardedCommandRunner } = await import(pathToFileURL(process.env.META_KIM_RUNNER_MODULE).href);',
          "const launcherRecords = [];",
          "const runWindowsGuardedCommand = createWindowsGuardedCommandRunner({",
          "  spawn: (file, args, options) => {",
          "    const launcher = spawn(file, args, options);",
          "    launcherRecords.push({ parentPid: process.pid, launcherPid: launcher.pid });",
          '    writeFileSync(process.env.META_KIM_LAUNCHER_RECORD, JSON.stringify(launcherRecords));',
          "    return launcher;",
          "  },",
          "});",
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
          META_KIM_LAUNCHER_RECORD: launcherRecordPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let treeIdentities = [];
      let launcherIdentities = [];
      try {
        treeIdentities = await readOwnedTree(pidsPath, DIRECT_LAUNCHER_FIXTURE_READY_TIMEOUT_MS);
        // Observe the actual production spawn without discovering unrelated
        // processes through CIM. Arguments, handles and Job behavior are real.
        await waitForFile(launcherRecordPath, 30_000);
        const launcherRecords = JSON.parse(readFileSync(launcherRecordPath, "utf8"));
        assert.ok(Array.isArray(launcherRecords));
        assert.equal(launcherRecords.length, 1);
        const [launcherRecord] = launcherRecords;
        assert.equal(launcherRecord.parentPid, supervisor.pid);
        assert.ok(Number.isSafeInteger(launcherRecord.launcherPid) && launcherRecord.launcherPid > 0);
        assert.notEqual(launcherRecord.launcherPid, supervisor.pid);
        launcherIdentities = captureOwnedIdentities([launcherRecord.launcherPid]);
        assert.equal(launcherIdentities.length, 1);
        assert.equal(launcherIdentities[0].pid, launcherRecord.launcherPid);
        assert.match(launcherIdentities[0].startTicks, /^\d+$/u);

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
          "Microsoft.PowerShell.Utility\\Write-Output 'META_KIM_JOB_READY'",
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
      let guardCleanupVerified = false;
      try {
        const deadline = Date.now() + TIMEOUT_CLEANUP_READY_TIMEOUT_MS;
        const guarded = runWindowsGuardedCommand(process.execPath, [rootScript], {
            cwd: tempDir,
            timeout: TIMEOUT_CLEANUP_GUARD_TIMEOUT_MS,
            outputLimitBytes: 64 * 1024,
            tailBytes: 1024,
          });
        await observeWithSettledOwnedGuard({
          guarded,
          observe: async () => {
            identities = await readOwnedTree(pidsPath, TIMEOUT_CLEANUP_READY_TIMEOUT_MS, { deadline });
            return identities;
          },
          verify: async (outcome) => {
            assert.equal(outcome.status, "rejected", "the original guard must reach its timeout");
            const error = outcome.error;
            if (error.code !== "META_KIM_COMMAND_TIMEOUT") throw error;
            assert.equal(error.code, "META_KIM_COMMAND_TIMEOUT");
            assert.equal(error.timeoutMs, TIMEOUT_CLEANUP_GUARD_TIMEOUT_MS);
            assert.equal(error.ownedProcessGroupCleanupVerified, true);
            assertNoWholeTreeClaim(error);
            await waitForOwnedProcessesToExit(identities);
            guardCleanupVerified = true;
          },
        });
      } finally {
        stopOwnedProcesses(identities);
        // Unverified native cleanup remains a failure and retains its directory.
        if (guardCleanupVerified) registerTestDirectory(tempDir);
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
        let guardCleanupVerified = false;
        try {
          const readinessDeadline = Date.now() + FLOOD_GUARD_TIMEOUT_MS;
          const guarded = runWindowsGuardedCommand(process.execPath, [rootScript], {
            cwd: tempDir,
            timeout: FLOOD_GUARD_TIMEOUT_MS,
            outputLimitBytes: 4_096,
            tailBytes: 256,
          });
          await observeWithSettledOwnedGuard({
            guarded,
            observe: async () => {
              identities = await readOwnedTree(pidsPath, FLOOD_GUARD_TIMEOUT_MS, { deadline: readinessDeadline });
              writeFileSync(releasePath, "flood", "utf8");
              return identities;
            },
            verify: async (outcome) => {
              assert.equal(outcome.status, "rejected", "the flood must exceed its output limit");
              const error = outcome.error;
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
              guardCleanupVerified = true;
            },
          });
        } finally {
          stopOwnedProcesses(identities);
          // Keep failed readiness/cleanup evidence instead of racing the Job.
          if (guardCleanupVerified) registerTestDirectory(tempDir);
        }
      });
    }
  },
);
