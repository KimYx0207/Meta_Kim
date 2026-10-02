import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createPosixGuardedCommandRunner,
  runCommandWithIgnoredStdin,
} from "../../scripts/eval-process-runner.mjs";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
}

function pidAppearsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processIdentity(pid) {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const startedAt = result.stdout.trim();
  return startedAt ? { pid, startedAt } : null;
}

function stopOwnedProcesses(identities) {
  for (const identity of [...identities].reverse()) {
    if (!pidAppearsAlive(identity.pid)) continue;
    if (processIdentity(identity.pid)?.startedAt !== identity.startedAt) continue;
    try {
      process.kill(identity.pid, "SIGKILL");
    } catch {
      // The owned process may exit between identity verification and the signal.
    }
  }
}

async function waitForOwnedProcessesToExit(identities, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (identities.every((identity) => !pidAppearsAlive(identity.pid))) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for the owned POSIX process group to exit");
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

function safeCleanupDiagnostic(error, signals = []) {
  const safe = (value) => typeof value === "string" && /^[A-Za-z0-9_]{1,100}$/u.test(value)
    ? value
    : null;
  return JSON.stringify({
    code: safe(error?.code),
    reason: safe(error?.ownedProcessGroupCleanupReason),
    causeCode: safe(error?.cause?.code),
    causeReason: safe(error?.cause?.ownedProcessGroupCleanupReason),
    causeSyscall: safe(error?.cause?.syscall),
    signals: signals.map(({ signal, code, calls }) => ({
      signal: signal === 0 ? 0 : safe(signal),
      code: safe(code),
      calls,
    })),
  });
}

function writeProcessTreeFixture(
  tempDir,
  { rootMode = "hold", exitCode = 0, inheritOutput = false, resistTerm = false } = {},
) {
  const grandchildScript = path.join(tempDir, "grandchild.mjs");
  const childScript = path.join(tempDir, "child.mjs");
  const rootScript = path.join(tempDir, "root.mjs");
  const pidsPath = path.join(tempDir, "pids.json");
  const readyPath = path.join(tempDir, "grandchild-ready");
  const releasePath = path.join(tempDir, "release-root");

  writeFileSync(grandchildScript, [
    'import { writeFileSync } from "node:fs";',
    resistTerm ? 'process.on("SIGTERM", () => {});' : "",
    `writeFileSync(${JSON.stringify(readyPath)}, "ready");`,
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"), "utf8");
  writeFileSync(
    childScript,
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const grandchild = spawn(process.execPath, [process.env.META_KIM_GRANDCHILD], { stdio: "ignore" });',
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
      rootMode === "hold" ? 'process.on("SIGTERM", () => process.exit(23));' : "",
      `spawn(process.execPath, [${JSON.stringify(childScript)}], {`,
      `  env: { ...process.env, META_KIM_GRANDCHILD: ${JSON.stringify(grandchildScript)}, META_KIM_PIDS: ${JSON.stringify(pidsPath)}, META_KIM_ROOT_PID: String(process.pid) },`,
      inheritOutput ? '  stdio: ["ignore", "inherit", "inherit"],' : '  stdio: "ignore",',
      "});",
      rootMode === "hold" ? "setInterval(() => {}, 1000);" : [
        "const deadline = Date.now() + 10000;",
        `while (!existsSync(${JSON.stringify(releasePath)}) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));`,
        `if (!existsSync(${JSON.stringify(releasePath)})) throw new Error("root release was not signaled");`,
        rootMode === "signal" ? 'process.kill(process.pid, "SIGTERM");' : `process.exit(${exitCode});`,
      ].join("\n"),
      "",
    ].join("\n"),
    "utf8",
  );
  return { pidsPath, readyPath, releasePath, rootScript };
}

describe(
  "POSIX detached evaluator process group",
  { skip: process.platform === "win32" },
  () => {
    for (const scenario of [
      { name: "successful root exit", rootMode: "exit", exitCode: 0 },
      { name: "nonzero root exit", rootMode: "exit", exitCode: 7 },
      { name: "signal root exit", rootMode: "signal", exitCode: null },
      { name: "root exit with inherited output pipes", rootMode: "exit", exitCode: 7, inheritOutput: true },
      { name: "root exit with a TERM-resistant grandchild", rootMode: "exit", exitCode: 7, resistTerm: true },
    ].flatMap((scenario) => scenario.resistTerm
      ? Array.from({ length: 10 }, (_, index) => ({
        ...scenario,
        name: `${scenario.name} (independent run ${index + 1}/10)`,
      }))
      : [scenario])) {
      test(`${scenario.name} drains the remaining owned group before publishing cleanup truth`, async (context) => {
        const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-posix-group-"));
        const { pidsPath, readyPath, releasePath, rootScript } = writeProcessTreeFixture(tempDir, scenario);
        let identities = [];
        const signals = [];
        const recordSignal = (signal, code) => {
          const last = signals.at(-1);
          if (last?.signal === signal && last.code === code) last.calls += 1;
          else signals.push({ signal, code, calls: 1 });
          if (signals.length > 12) signals.shift();
        };
        try {
          // Shorten only the escalation grace in the resistant-process fixture;
          // spawning, signaling, probing and final verification remain real.
          const runner = scenario.resistTerm
            ? createPosixGuardedCommandRunner({
              graceMs: 100,
              kill: (pid, signal) => {
                try {
                  const result = process.kill(pid, signal);
                  recordSignal(signal, null);
                  return result;
                } catch (error) {
                  recordSignal(signal, error.code);
                  throw error;
                }
              },
            })
            : runCommandWithIgnoredStdin;
          const completion = runner(process.execPath, [rootScript], {
            cwd: tempDir,
            timeout: 10_000,
          }).then((result) => ({ result }), (error) => ({ error }));
          await Promise.all([waitForFile(pidsPath), waitForFile(readyPath)]);
          const pids = Object.values(JSON.parse(readFileSync(pidsPath, "utf8")));
          identities = pids.map(processIdentity).filter(Boolean);
          assert.equal(identities.length, 3);
          writeFileSync(releasePath, "exit\n", "utf8");

          const { result, error } = await completion;
          const permissionDenials = signals.reduce((total, call) => total + (call.code === "EPERM" ? call.calls : 0), 0);
          if (permissionDenials > 0) context.diagnostic(`Observed ${permissionDenials} EPERM response(s) during owned-group cleanup`);
          if (scenario.exitCode === 0) {
            assert.equal(error, undefined);
          } else {
            assert.equal(error?.code, "META_KIM_CHILD_COMMAND_FAILED", safeCleanupDiagnostic(error, signals));
            assert.equal(error.exitCode, scenario.exitCode);
            assert.equal(error.signal, scenario.rootMode === "signal" ? "SIGTERM" : null);
          }
          const diagnostic = result ?? error;
          assert.equal(diagnostic.ownedProcessGroupCleanupVerified, true);
          assert.equal(diagnostic.ownedProcessGroupCleanupFailure, false);
          assert.equal(diagnostic.ownedProcessGroupCleanupReason, null);
          assert.equal(diagnostic.ownedProcessGroupScope, "posix_detached_process_group");
          assertNoWholeTreeClaim(diagnostic);
          // No extra grace after return: verified must already mean group gone.
          assert.throws(() => process.kill(-pids[0], 0), { code: "ESRCH" });
          assert.ok(identities.every((identity) => !pidAppearsAlive(identity.pid)));
        } finally {
          stopOwnedProcesses(identities);
          rmSync(tempDir, { recursive: true, force: true });
        }
      });
    }

    test("launch failure reports that no owned process group was established", async () => {
      const missingCommand = path.join(os.tmpdir(), `meta-kim-missing-${process.pid}-${Date.now()}`);
      const error = await expectRejected(runCommandWithIgnoredStdin(missingCommand, []));
      assert.equal(error.code, "META_KIM_CHILD_COMMAND_LAUNCH_FAILED");
      assert.equal(error.systemCode, "ENOENT");
      assert.equal(error.ownedProcessGroupCleanupVerified, false);
      assert.equal(error.ownedProcessGroupCleanupFailure, false);
      assert.equal(error.ownedProcessGroupCleanupReason, "process_not_spawned");
      assertNoWholeTreeClaim(error);
    });

    test("timeout wins over the root exit code and drains root, child, and grandchild", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "meta-kim-posix-group-"));
      const { pidsPath, rootScript } = writeProcessTreeFixture(tempDir);
      let identities = [];
      try {
        const rejection = expectRejected(
          runCommandWithIgnoredStdin(process.execPath, [rootScript], {
            cwd: tempDir,
            timeout: 3_000,
            outputLimitBytes: 64 * 1024,
            tailBytes: 1024,
          }),
        );
        await waitForFile(pidsPath);
        const pids = Object.values(JSON.parse(readFileSync(pidsPath, "utf8")));
        assert.equal(pids.length, 3);
        identities = pids.map(processIdentity).filter(Boolean);
        assert.equal(identities.length, 3);

        const error = await rejection;
        assert.equal(error.code, "META_KIM_COMMAND_TIMEOUT");
        assert.equal(error.timeoutMs, 3_000);
        assert.equal(error.exitCode, undefined);
        assert.equal(error.ownedProcessGroupCleanupVerified, true);
        assert.equal(error.ownedProcessGroupScope, "posix_detached_process_group");
        assertNoWholeTreeClaim(error);
        await waitForOwnedProcessesToExit(identities);
      } finally {
        stopOwnedProcesses(identities);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  },
);
