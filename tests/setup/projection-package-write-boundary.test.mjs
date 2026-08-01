import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const setupPath = path.join(repoRoot, "setup.mjs");

function runBootstrap({ homeRoot, callerRoot, targetDir }) {
  return spawnSync(
    process.execPath,
    [
      setupPath,
      "--project-bootstrap",
      "--apply",
      "--project-dir",
      targetDir,
      "--targets",
      "claude,codex",
      "--silent",
      "--json",
    ],
    {
      cwd: callerRoot,
      env: {
        ...process.env,
        HOME: homeRoot,
        USERPROFILE: homeRoot,
        META_KIM_CALLER_CWD: callerRoot,
      },
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    },
  );
}

test("source setup rejects an explicit project target inside the immutable store", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-store-boundary-"));
  try {
    const homeRoot = path.join(root, "home");
    const callerRoot = path.join(root, "caller");
    const storeRoot = path.join(homeRoot, ".meta-kim", "runtime", "projection-packages");
    const targetDir = path.join(storeRoot, "meta-kim", "candidate");
    mkdirSync(callerRoot, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    const sentinel = path.join(targetDir, "sentinel.txt");
    writeFileSync(sentinel, "unchanged\n", "utf8");

    const result = runBootstrap({ homeRoot, callerRoot, targetDir });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /overlaps (?:package_root|projection_store)/u);
    assert.deepEqual(readdirSync(targetDir), ["sentinel.txt"]);
    assert.equal(readFileSync(sentinel, "utf8"), "unchanged\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source setup rejects a project child junction that enters the immutable store", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-store-junction-"));
  try {
    const homeRoot = path.join(root, "home");
    const callerRoot = path.join(root, "caller");
    const projectRoot = path.join(root, "project");
    const storeRoot = path.join(homeRoot, ".meta-kim", "runtime", "projection-packages");
    mkdirSync(callerRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(storeRoot, { recursive: true });
    writeFileSync(path.join(projectRoot, "sentinel.txt"), "unchanged\n", "utf8");
    symlinkSync(
      storeRoot,
      path.join(projectRoot, ".meta-kim"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = runBootstrap({ homeRoot, callerRoot, targetDir: projectRoot });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /overlaps (?:package_root|projection_store)/u);
    assert.deepEqual(readdirSync(projectRoot).sort(), [".meta-kim", "sentinel.txt"]);
    assert.deepEqual(readdirSync(storeRoot), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
