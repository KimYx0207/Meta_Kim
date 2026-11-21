#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkNetworkx, detectPython310, formatPythonLauncher, runPythonModule } from "./graphify-runtime.mjs";
import { sanitizeGraphifyWindowsHooks } from "./graphify-hook-sanitize.mjs";
import { resolveProjectRoot } from "../canonical/runtime-assets/shared/hooks/project-root.mjs";

const projectRootArgIndex = process.argv.indexOf("--project-root");
const declaredProjectRoot =
  projectRootArgIndex >= 0 && process.argv[projectRootArgIndex + 1]
    ? process.argv[projectRootArgIndex + 1]
    : null;
const rootDir = resolveProjectRoot({
  explicitDeclarations: [declaredProjectRoot, process.env.CLAUDE_PROJECT_DIR],
});
if (!rootDir) {
  // No legitimate project root — do not bootstrap graphify into an arbitrary
  // cwd. This path is opportunistic/auto; a silent no-op is the correct result.
  process.exit(0);
}
const scriptPath = fileURLToPath(import.meta.url);
const autoMode = process.argv.includes("--auto");
const autoWorkerMode = process.argv.includes("--auto-worker");
const stateDir = join(rootDir, ".meta-kim", "state", "default");
const autoMarkerPath = join(stateDir, "post-copy-init.json");
const runningTtlMs = 10 * 60 * 1000;
const failedRetryMs = 60 * 60 * 1000;
const guideTargets = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  claw: "AGENTS.md",
  opencode: "AGENTS.md",
  aider: "AGENTS.md",
  droid: "AGENTS.md",
  trae: "AGENTS.md",
  "trae-cn": "AGENTS.md",
};
const graphifyPlatformMap = {
  claude: "claude",
  codex: "codex",
  cursor: "codex",
  openclaw: "claw",
};

function scriptMtimeMs() {
  try {
    return statSync(scriptPath).mtimeMs;
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function activeTargets() {
  const manifest = readJson(join(stateDir, "project-bootstrap.json"));
  const targets = Array.isArray(manifest?.activeTargets) ? manifest.activeTargets : [];
  return targets.length > 0 ? targets : ["claude", "codex"];
}

function graphifyPlatforms() {
  return [
    ...new Set(
      activeTargets()
        .map((target) => graphifyPlatformMap[target])
        .filter(Boolean),
    ),
  ];
}

function readAutoMarker() {
  return readJson(autoMarkerPath);
}

function writeAutoMarker(status, extra = {}) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      autoMarkerPath,
      JSON.stringify(
        {
          status,
          updatedAt: new Date().toISOString(),
          scriptMtimeMs: scriptMtimeMs(),
          ...extra,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  } catch {
    // Auto-init state is best-effort; never block meta-theory startup.
  }
}

function markerAgeMs(marker) {
  const raw = marker?.updatedAt || marker?.startedAt;
  const time = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(time) ? Date.now() - time : Number.POSITIVE_INFINITY;
}

function shouldSkipAutoLaunch() {
  const marker = readAutoMarker();
  const currentScriptMtimeMs = scriptMtimeMs();
  if (marker?.status === "passed" && marker.scriptMtimeMs === currentScriptMtimeMs) {
    return true;
  }
  if (marker?.status === "running" && markerAgeMs(marker) < runningTtlMs) {
    return true;
  }
  if (marker?.status === "failed" && markerAgeMs(marker) < failedRetryMs) {
    return true;
  }
  return false;
}

function launchAutoWorker() {
  if (process.env.META_KIM_POST_COPY_AUTO === "off") return;
  if (shouldSkipAutoLaunch()) return;
  writeAutoMarker("running", { mode: "auto", startedAt: new Date().toISOString() });
  try {
    const child = spawn(process.execPath, [scriptPath, "--auto-worker"], {
      cwd: rootDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, META_KIM_POST_COPY_AUTO: "worker" },
    });
    child.unref();
  } catch (error) {
    writeAutoMarker("failed", { mode: "auto", message: error?.message || String(error) });
  }
}

if (autoMode && !autoWorkerMode) {
  launchAutoWorker();
  process.exit(0);
}

function fail(message, code = 1) {
  if (autoWorkerMode) writeAutoMarker("failed", { mode: "auto", message });
  console.error(message);
  process.exit(code);
}

function findPython() {
  return detectPython310(spawnSync, process.platform, {
    requirePip: true,
    bootstrapPip: true,
  });
}

function runCandidate(python, args, stdio = "inherit") {
  return runPythonModule(python, args, spawnSync, {
    cwd: rootDir,
    stdio,
  });
}

function runPython(python, args, { optional = false } = {}) {
  const result = runCandidate(python, args);
  if (result.status === 0) return true;
  if (optional) {
    console.warn("[Meta_Kim] Optional command failed:", args.join(" "));
    return false;
  }
  fail("[Meta_Kim] Command failed: " + args.join(" "), result.status || 1);
}

function guideAlreadyHasGraphifySection(platform) {
  const target = guideTargets[platform];
  if (!target) return false;
  const filePath = join(rootDir, target);
  if (!existsSync(filePath)) return false;
  return /^##\s+graphify\b/im.test(readFileSync(filePath, "utf8"));
}

// Same lookup as setup's readManagedGraphConfig(). An unreadable config fails
// closed: continuing would let the native installer replace managed hook blocks.
function readManagedGraphConfig() {
  const location = spawnSync("git", ["rev-parse", "--git-path", "graphify/config.json"], {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
  });
  if (location.status !== 0) return null;
  const configFile = resolve(rootDir, location.stdout.trim());
  if (!existsSync(configFile)) return null;
  let config;
  try {
    config = JSON.parse(readFileSync(configFile, "utf8"));
  } catch (error) {
    fail(`[Meta_Kim] Cannot read managed Graphify config ${configFile}: ${error.message}`);
  }
  if (typeof config?.python !== "string" || !config.python) {
    fail(`[Meta_Kim] Managed Graphify config ${configFile} has no python interpreter.`);
  }
  return config;
}

// Mirrors setup's runManagedGraphLifecycle(): always call the packaged manager
// so a stale runtime copy under .git/graphify is refreshed by `install`.
function runManagedGraph(action, managedConfig) {
  const manager = fileURLToPath(new URL("./graphify-managed.py", import.meta.url));
  const result = spawnSync(managedConfig.python, [manager, action, "--repo", rootDir], {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, PYTHONNOUSERSITE: "1", PYTHONHASHSEED: "0" },
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`[Meta_Kim] Managed Graphify ${action} failed.`, result.status || 1);
  }
}

const managedGraphConfig = readManagedGraphConfig();
if (managedGraphConfig && process.platform === "win32") {
  fail("[Meta_Kim] Repository-managed Graphify is currently supported on macOS/Linux.");
}

const python = managedGraphConfig
  ? { command: managedGraphConfig.python, args: [] }
  : findPython();
if (!python) {
  fail("[Meta_Kim] Python 3.10+ with pip is required for graphify. Install Python, then run this script again.");
}
console.log(`[Meta_Kim] Using Python for graphify: ${formatPythonLauncher(python)}`);

if (managedGraphConfig) {
  // Loaded only here so projects without a managed config import nothing new.
  const { reconcileGraphifyPackage } = await import("./graphify-package-install.mjs");
  // The managed producer requires the shared baseline version (setup and
  // graphify-cli install use the same reconciliation).
  const packageResult = reconcileGraphifyPackage(python);
  if (!packageResult.ok) {
    fail(`[Meta_Kim] Graphify package verification failed: ${packageResult.code}`);
  }
  // Same check-then-upgrade as setup's ensureNetworkxCompatibility().
  if (!checkNetworkx(python).meets) {
    runPython(python, ["-m", "pip", "install", "--upgrade", "networkx>=3.4"], {
      optional: true,
    });
  }
} else {
  const pipShow = runCandidate(python, ["-m", "pip", "show", "graphifyy"], "pipe");
  if (pipShow.status !== 0) {
    runPython(python, ["-m", "pip", "install", "graphifyy"]);
  }
  runPython(python, ["-m", "pip", "install", "--upgrade", "networkx>=3.4"], {
    optional: true,
  });
}

let nativeHookFailed = false;
if (existsSync(join(rootDir, ".git"))) {
  // In managed mode a failed native hook install must still reach the manager
  // repair below (setup marks wiring failed and keeps going).
  nativeHookFailed = !runPython(python, ["-m", "graphify", "hook", "install"], {
    optional: Boolean(managedGraphConfig),
  });
  const repaired = sanitizeGraphifyWindowsHooks(
    join(rootDir, ".claude", "settings.json"),
  );
  if (repaired.changed) {
    console.log(
      `[Meta_Kim] Repaired ${repaired.count} unsafe Graphify hook command(s) ` +
      `(backup: ${repaired.backup}).`,
    );
  }
} else {
  console.log("[Meta_Kim] Skipping graphify git hook; no .git directory found.");
}

for (const platform of graphifyPlatforms()) {
  if (guideAlreadyHasGraphifySection(platform)) {
    console.log(`[Meta_Kim] graphify ${platform} guide section already exists; skipping install.`);
    continue;
  }
  runPython(python, ["-m", "graphify", platform, "install"], { optional: true });
}

if (managedGraphConfig) {
  // Native installers above may rewrite Graphify-owned hook blocks and guide
  // sections; repair them after the last installer, then refresh through the
  // manager instead of a raw update (docs/graphify-managed-lifecycle.md).
  runManagedGraph("install", managedGraphConfig);
  if (nativeHookFailed) {
    fail("[Meta_Kim] graphify hook install failed; managed hooks were repaired.");
  }
  runManagedGraph("run", managedGraphConfig);
} else {
  runPython(python, ["-m", "graphify", "update", "."]);
}
writeAutoMarker("passed", {
  mode: autoWorkerMode ? "auto" : "manual",
  graphPath: join(rootDir, "graphify-out", "graph.json"),
});
console.log("[Meta_Kim] graphify is initialized for:", rootDir);
