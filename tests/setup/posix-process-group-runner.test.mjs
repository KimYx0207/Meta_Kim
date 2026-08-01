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
import { runCommandWithIgnoredStdin } from "../../scripts/eval-process-runner.mjs";

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

function writeProcessTreeFixture(tempDir) {
  const grandchildScript = path.join(tempDir, "grandchild.mjs");
  const childScript = path.join(tempDir, "child.mjs");
  const rootScript = path.join(tempDir, "root.mjs");
  const pidsPath = path.join(tempDir, "pids.json");

  writeFileSync(grandchildScript, "setInterval(() => {}, 1000);\n", "utf8");
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
      'process.on("SIGTERM", () => process.exit(23));',
      `spawn(process.execPath, [${JSON.stringify(childScript)}], {`,
      `  env: { ...process.env, META_KIM_GRANDCHILD: ${JSON.stringify(grandchildScript)}, META_KIM_PIDS: ${JSON.stringify(pidsPath)}, META_KIM_ROOT_PID: String(process.pid) },`,
      '  stdio: "ignore",',
      "});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  return { pidsPath, rootScript };
}

describe(
  "POSIX detached evaluator process group",
  { skip: process.platform === "win32" },
  () => {
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
