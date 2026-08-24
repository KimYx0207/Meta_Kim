import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tarCommand = process.platform === "win32" ? "tar.exe" : "tar";

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const resolved = candidates.find((candidate) => typeof candidate === "string" && existsSync(candidate));
  if (!resolved) throw new Error("npm JavaScript CLI not found");
  return resolved;
}

function waitForJsonLine(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`packed Live start timeout: ${stderr}`)), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split(/\r?\n/u).find((entry) => entry.trim().startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (!stdout.includes("{")) {
        clearTimeout(timer);
        reject(new Error(`packed Live exited before startup (${code}): ${stderr}`));
      }
    });
  });
}

test("the real packed CLI serves the read-only control room without a source checkout", { timeout: 30_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-packed-"));
  const extractRoot = path.join(temp, "extract");
  const projectRoot = path.join(temp, "project");
  let child;
  try {
    await mkdir(extractRoot);
    await mkdir(path.join(projectRoot, ".git"), { recursive: true });
    const pack = JSON.parse(execFileSync(process.execPath, [npmCliPath(), "pack", "--json", "--pack-destination", temp], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }));
    const packageFile = path.join(temp, pack[0].filename);
    execFileSync(tarCommand, ["-xf", packageFile, "-C", extractRoot], { stdio: "pipe" });
    const cli = path.join(extractRoot, "package", "bin", "meta-kim.mjs");

    const help = spawnSync(process.execPath, [cli, "live", "--help"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /read-only/iu);
    assert.match(help.stdout, /--enable-control/u);

    child = spawn(process.execPath, [
      cli,
      "live",
      "--project-root", projectRoot,
      "--port", "0",
      "--no-open",
      "--json",
    ], {
      cwd: projectRoot,
      env: { ...process.env, META_KIM_CALLER_CWD: projectRoot },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const address = await waitForJsonLine(child);
    assert.equal(address.host, "127.0.0.1");
    assert.equal(address.readOnly, true);
    assert.equal(address.controlEnabled, false);
    const response = await fetch(`${address.url}/api/snapshot`);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.schemaVersion, "meta-kim-live-snapshot-v1");
    assert.equal(snapshot.run, null);
    assert.equal(snapshot.permissions.mutationAllowed, false);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
});
