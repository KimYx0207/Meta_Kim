#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  GRAPHIFY_NETWORKX_REQUIREMENT,
  checkNetworkx,
  detectPython310,
  formatPythonLauncher,
  readProcessText,
  runPythonModule,
} from "./graphify-runtime.mjs";
import { reconcileGraphifyPackage } from "./graphify-package-install.mjs";
import { sanitizeGraphifyWindowsHooks } from "./graphify-hook-sanitize.mjs";
import {
  MANAGED_GRAPHIFY_LINKED_WORKTREE,
  MANAGED_GRAPHIFY_UNSUPPORTED_PLATFORM,
  readManagedGraphRuntime,
  runManagedGraphLifecycle,
} from "./graphify-managed-runtime.mjs";
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
  if ((marker?.status === "passed" || marker?.status === "skipped") && marker.scriptMtimeMs === currentScriptMtimeMs) {
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

let managedGraph;
try {
  managedGraph = readManagedGraphRuntime(rootDir);
} catch (error) {
  fail(`[Meta_Kim] Could not read managed Graphify configuration: ${error.message}`);
}
if (managedGraph?.linkedWorktree) {
  writeAutoMarker("skipped", { mode: autoWorkerMode ? "auto" : "manual", message: MANAGED_GRAPHIFY_LINKED_WORKTREE });
  console.log(`[Meta_Kim] ${MANAGED_GRAPHIFY_LINKED_WORKTREE}`);
  process.exit(0);
}
if (managedGraph && process.platform === "win32") {
  fail(`[Meta_Kim] ${MANAGED_GRAPHIFY_UNSUPPORTED_PLATFORM}`);
}

const python = managedGraph?.python ?? findPython();
if (!python) {
  fail("[Meta_Kim] Python 3.10+ with pip is required for graphify. Install Python, then run this script again.");
}
console.log(`[Meta_Kim] Using Python for graphify: ${formatPythonLauncher(python)}`);

if (managedGraph) {
  const result = reconcileGraphifyPackage(python);
  if (!result.ok) fail(`[Meta_Kim] ${result.code}: ${readProcessText(result.processResult)}`);
} else {
  const pipShow = runCandidate(python, ["-m", "pip", "show", "graphifyy"], "pipe");
  if (pipShow.status !== 0) {
    runPython(python, ["-m", "pip", "install", "graphifyy"]);
  }
}
if (!managedGraph || !checkNetworkx(python).meets) {
  runPython(python, ["-m", "pip", "install", "--upgrade", GRAPHIFY_NETWORKX_REQUIREMENT], {
    optional: !managedGraph,
  });
}

if (!managedGraph && existsSync(join(rootDir, ".git"))) {
  runPython(python, ["-m", "graphify", "hook", "install"]);
  const repaired = sanitizeGraphifyWindowsHooks(
    join(rootDir, ".claude", "settings.json"),
  );
  if (repaired.changed) {
    console.log(
      `[Meta_Kim] Repaired ${repaired.count} unsafe Graphify hook command(s) ` +
      `(backup: ${repaired.backup}).`,
    );
  }
} else if (!managedGraph) {
  console.log("[Meta_Kim] Skipping graphify git hook; no .git directory found.");
}

for (const platform of graphifyPlatforms()) {
  if (guideAlreadyHasGraphifySection(platform)) {
    console.log(`[Meta_Kim] graphify ${platform} guide section already exists; skipping install.`);
    continue;
  }
  runPython(python, ["-m", "graphify", platform, "install"], { optional: true });
}

if (managedGraph) {
  for (const action of ["install", "run"]) {
    const result = runManagedGraphLifecycle(rootDir, action, python);
    if (result.status !== 0) {
      fail(`[Meta_Kim] Managed Graphify ${action} failed: ${readProcessText(result)}`, result.status || 1);
    }
  }
} else {
  runPython(python, ["-m", "graphify", "update", "."]);
}
writeAutoMarker("passed", {
  mode: autoWorkerMode ? "auto" : "manual",
  graphPath: join(rootDir, "graphify-out", "graph.json"),
});
console.log("[Meta_Kim] graphify is initialized for:", rootDir);
