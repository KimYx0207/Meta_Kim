import { describe, test } from "node:test";
import assert from "node:assert/strict";
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

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const guardPath = path.join(
  repoRoot,
  "scripts",
  "windows-process-tree-guard.ps1",
);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
}

describe("Windows Toolhelp32 process-tree guard", { skip: process.platform !== "win32" }, () => {
  test("terminates and verifies an owned root, child, and grandchild without WMI", async () => {
    const tempDir = mkdtempSync(
      path.join(os.tmpdir(), "meta-kim-process-tree-test-"),
    );
    const childScript = path.join(tempDir, "child.mjs");
    const rootScript = path.join(tempDir, "root.mjs");
    const pidsPath = path.join(tempDir, "pids.json");
    const readyPath = path.join(tempDir, "ready");
    const stopPath = path.join(tempDir, "stop");
    const resultPath = path.join(tempDir, "result.json");
    let root;
    let observedPids = [];

    try {
      writeFileSync(
        childScript,
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          'writeFileSync(process.env.META_KIM_TEST_PIDS, JSON.stringify({ root: Number(process.env.META_KIM_TEST_ROOT), child: process.pid, grandchild: grandchild.pid }));',
          'setInterval(() => {}, 1000);',
          "",
        ].join("\n"),
      );
      writeFileSync(
        rootScript,
        [
          'import { spawn } from "node:child_process";',
          'spawn(process.execPath, [process.env.META_KIM_TEST_CHILD], { env: { ...process.env, META_KIM_TEST_ROOT: String(process.pid) }, stdio: "ignore" });',
          'setInterval(() => {}, 1000);',
          "",
        ].join("\n"),
      );

      root = spawn(process.execPath, [rootScript], {
        env: {
          ...process.env,
          META_KIM_TEST_CHILD: childScript,
          META_KIM_TEST_PIDS: pidsPath,
        },
        stdio: "ignore",
        windowsHide: true,
      });
      await waitForFile(pidsPath);
      const pids = JSON.parse(readFileSync(pidsPath, "utf8"));
      observedPids = [pids.root, pids.child, pids.grandchild];
      assert.ok(observedPids.every((pid) => Number.isSafeInteger(pid) && pid > 0));
      assert.ok(observedPids.every(isAlive));

      writeFileSync(stopPath, "stop");
      const guarded = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          guardPath,
          "-RootPid",
          String(pids.root),
          "-ReadyPath",
          readyPath,
          "-StopPath",
          stopPath,
          "-ResultPath",
          resultPath,
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: 30_000, windowsHide: true },
      );

      assert.equal(guarded.status, 0, guarded.stderr || guarded.stdout);
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      assert.equal(result.verified, true);
      assert.equal(result.reason, "process_tree_terminated");
      assert.ok(result.trackedCount >= 3);
      assert.equal(result.survivorCount, 0);
      assert.ok(observedPids.every((pid) => !isAlive(pid)));
    } finally {
      for (const pid of observedPids.reverse()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone is the expected successful state.
        }
      }
      if (root && isAlive(root.pid)) {
        root.kill("SIGKILL");
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
