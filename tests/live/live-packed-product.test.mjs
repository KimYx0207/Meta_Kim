import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { tarExtractCommand } from "../../scripts/tar-extract-command.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

/**
 * Wait for the packed daemon to announce its address.
 *
 * The budget is generous on purpose. This test packs the npm artifact, extracts
 * it and cold-starts a daemon, and it runs inside a 28-file parallel suite; the
 * previous 10s budget was only ~1.4s above the 8.6s the same start takes on an
 * idle machine, so the suite failed with `daemon_exited_before_ready` while the
 * packed product was healthy. A start that is merely slow under load is not the
 * defect this test exists to catch.
 */
function waitForJsonLine(child, timeoutMs = 20_000) {
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

test("the real packed CLI serves the read-only control room without a source checkout", { timeout: 60_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "meta-kim-live-packed-"));
  const extractRoot = path.join(temp, "extract");
  const projectRoot = path.join(temp, "project");
  let child;
  let daemonState = null;
  try {
    await mkdir(extractRoot);
    await mkdir(path.join(projectRoot, ".git"), { recursive: true });
    const pack = JSON.parse(execFileSync(process.execPath, [npmCliPath(), "pack", "--json", "--pack-destination", temp], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }));
    const packageFile = path.join(temp, pack[0].filename);
    const extraction = tarExtractCommand(packageFile, extractRoot);
    execFileSync(extraction.command, extraction.args, { cwd: extraction.cwd, stdio: "pipe" });
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
      "--profile", "packed-profile",
      "--port", "0",
      "--no-open",
      "--json",
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        META_KIM_CALLER_CWD: projectRoot,
        META_KIM_LIVE_HOME: path.join(temp, "home"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const address = await waitForJsonLine(child);
    assert.equal(address.host, "127.0.0.1");
    assert.equal(address.readOnly, true);
    assert.equal(address.controlEnabled, false);
    assert.equal(address.singleton, true);
    assert.equal(address.profile, "packed-profile");
    daemonState = JSON.parse(await readFile(
      path.join(temp, "home", ".meta-kim", "live", "hub.json"),
      "utf8",
    ));
    assert.equal(daemonState.instanceId.length > 0, true);
    assert.equal(daemonState.profile, "packed-profile");
    const catalogResponse = await fetch(`${address.url}/api/projects`);
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(catalog.projects.length, 1);
    assert.equal(catalog.projects[0].displayName, "project");
    assert.equal(Object.prototype.hasOwnProperty.call(catalog.projects[0], "repoRoot"), false);
    const health = await (await fetch(`${address.url}/api/health`)).json();
    assert.equal(health.profile, "packed-profile");
    // The launcher hands the daemon the version of the root it started from, so
    // this is the only place the whole chain is proven. A daemon that answers with
    // a version it was never handed leaves its serving build unidentifiable, which
    // is what made a Hub on stale code impossible to spot.
    const packedManifest = JSON.parse(await readFile(
      path.join(extractRoot, "package", "package.json"),
      "utf8",
    ));
    assert.equal(health.packageVersion, packedManifest.version);
    const response = await fetch(`${address.url}/api/snapshot`);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.schemaVersion, "meta-kim-live-snapshot-v2");
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
    if (daemonState?.pid) {
      try {
        const health = await (await fetch(`http://127.0.0.1:${daemonState.port}/api/health`)).json();
        if (health.instanceId === daemonState.instanceId) {
          process.kill(daemonState.pid, "SIGTERM");
          const deadline = Date.now() + 3_000;
          while (Date.now() < deadline) {
            try {
              process.kill(daemonState.pid, 0);
              await new Promise((resolve) => setTimeout(resolve, 75));
            } catch {
              break;
            }
          }
        }
      } catch {
        // Already stopped is an acceptable cleanup state.
      }
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
});
