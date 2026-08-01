/**
 * install-mcp-memory-hooks.mjs
 *
 * Installs MCP Memory Service hooks and commands.
 *
 * What this script does (in order):
 *   1. Copy the canonical Python hook from canonical/runtime-assets/claude/memory-hooks/
 *      to ~/.claude/hooks/mcp_memory_global.py
 *   2. Seed ~/.claude/hooks/config.json from config.template.json if not present
 *      (NEVER overwrite an existing config — user customizations are preserved)
 *   3. Copy only the memory-owned files declared by managed-assets.json
 *      (the Claude Python loader and save-progress skill subtree)
 *   4. Verify shared hooks and top-level commands that global runtime sync owns
 *   5. Register the SessionStart hook in ~/.claude/settings.json
 *      - Automatically detects and validates Python paths
 *      - On Windows: skips WindowsApps shim, prefers explicit Python executable
 *      - Auto-fixes invalid Python paths (e.g., bare "python" on Windows)
 *   6. Verify globally-owned lifecycle registration for Claude, Codex, and Cursor
 *   7. Verify the globally-owned OpenClaw memory hook projection
 *   8. Warn if MCP server is not responding on the configured endpoint
 *      (MCP_MEMORY_URL, META_KIM_MEMORY_PORT, or http://localhost:8000)
 *
 * Usage:
 *   node scripts/install-mcp-memory-hooks.mjs                         # Install/verify all runtime hooks
 *   node scripts/install-mcp-memory-hooks.mjs --targets codex,cursor   # Verify selected runtime hooks
 *   node scripts/install-mcp-memory-hooks.mjs --check                  # Dry-run: verify only, no side effects
 *   node scripts/install-mcp-memory-hooks.mjs --force                  # Force-update Python paths even if current is valid
 *   node scripts/install-mcp-memory-hooks.mjs --remove                 # Remove only memory-owned assets
 *
 * Exit codes:
 *   0  success
 *   1  non-fatal warnings occurred (hook copied but registration failed)
 *   2  fatal: canonical source asset missing
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  statSync,
  lstatSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname, relative, resolve, isAbsolute, win32 as windowsPath, posix as posixPath, sep as pathSeparator } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { resolveMemoryEndpoint } from "./memory-endpoint.mjs";
import {
  executeSafeManagedFileTransaction,
  normalizeManagedRelPath,
  sha256Buffer,
  sha256ManagedFile,
  inspectTrustedPath,
  validateManagedManifest,
} from "./safe-managed-file-operations.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CANONICAL_RUNTIME_ASSETS_DIR = join(REPO_ROOT, "canonical", "runtime-assets");

// ── Paths ──────────────────────────────────────────────

const CANONICAL_HOOK_DIR = join(
  REPO_ROOT,
  "canonical",
  "runtime-assets",
  "claude",
  "memory-hooks",
);
const CANONICAL_HOOK_SOURCE = join(CANONICAL_HOOK_DIR, "mcp_memory_global.py");
const CANONICAL_CONFIG_TEMPLATE = join(
  CANONICAL_HOOK_DIR,
  "config.template.json",
);
const CANONICAL_MANAGED_ASSET_SPEC = join(
  CANONICAL_HOOK_DIR,
  "managed-assets.json",
);
const HOOKS_TARGET_DIR = join(homedir(), ".claude", "hooks");
const HOOK_TARGET = join(HOOKS_TARGET_DIR, "mcp_memory_global.py");
const CONFIG_TARGET = join(HOOKS_TARGET_DIR, "config.json");
const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const CODEX_HOME = join(homedir(), ".codex");
const CURSOR_HOME = join(homedir(), ".cursor");
const OPENCLAW_HOME = join(homedir(), ".openclaw");
const RUNTIME_MANIFEST_DIR = join(
  homedir(),
  ".meta-kim",
  "manifests",
  "mcp-memory-hooks",
);
const RUNTIME_MANIFEST_SCHEMA = "meta-kim-memory-hook-files-v2";
const CROSS_RUNTIME_HOOK_FILE = "meta-kim-memory-save.mjs";
const CLAUDE_SESSION_FRAGMENT_KIND = "claude-session-start-command-v1";
const CLAUDE_SESSION_FRAGMENT_EVENT = "SessionStart";
const CLAUDE_SESSION_FRAGMENT_MATCHER = "*";
const GLOBAL_INSTALL_MANIFEST_PATH = join(
  homedir(),
  ".meta-kim",
  "install-manifest.json",
);

function readManagedAssetSpec() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(CANONICAL_MANAGED_ASSET_SPEC, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid MCP Memory managed-assets spec: could not read or parse ${CANONICAL_MANAGED_ASSET_SPEC}: ${error.message}`,
    );
  }
  if (
    raw?.schemaVersion !== "meta-kim-mcp-memory-managed-assets-v1" ||
    !isJsonObject(raw.owned) ||
    !isJsonObject(raw.retiredOwned) ||
    !isJsonObject(raw.delegatedToGlobalSync)
  ) {
    throw new Error(`Invalid MCP Memory managed-assets spec: ${CANONICAL_MANAGED_ASSET_SPEC}`);
  }
  const runtimeIds = [
    ...new Set([
      ...Object.keys(raw.owned),
      ...Object.keys(raw.retiredOwned),
      ...Object.keys(raw.delegatedToGlobalSync),
    ]),
  ];
  if (runtimeIds.length === 0) {
    throw new Error("Invalid MCP Memory managed-assets spec: no runtimes are declared");
  }
  for (const runtime of runtimeIds) {
    if (!/^[a-z][a-z0-9-]*$/u.test(runtime)) {
      throw new Error(`Invalid MCP Memory managed-assets runtime id: ${runtime}`);
    }
    if (
      !Array.isArray(raw.owned[runtime]) ||
      !Array.isArray(raw.retiredOwned[runtime]) ||
      !Array.isArray(raw.delegatedToGlobalSync[runtime])
    ) {
      throw new Error(
        `Invalid MCP Memory managed-assets spec: ${runtime} must declare owned, retiredOwned, and delegatedToGlobalSync arrays`,
      );
    }
  }
  return raw;
}

const MANAGED_ASSET_SPEC = readManagedAssetSpec();
const DEFAULT_TARGETS = Object.freeze([
  ...new Set([
    ...Object.keys(MANAGED_ASSET_SPEC.owned),
    ...Object.keys(MANAGED_ASSET_SPEC.retiredOwned),
    ...Object.keys(MANAGED_ASSET_SPEC.delegatedToGlobalSync),
  ]),
]);
const VALID_TARGETS = new Set(DEFAULT_TARGETS);

// ── Formatting helpers ──────────────────────────────────

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function info(msg) {
  console.log(`${dim("→")} ${msg}`);
}
function ok(msg) {
  console.log(`${green("✓")} ${msg}`);
}
function warn(msg) {
  console.log(`${yellow("⚠")} ${msg}`);
}
function fail(msg) {
  console.log(`${red("✗")} ${msg}`);
}

// ── Core helpers ────────────────────────────────────────

// Global flag for force-update mode
let FORCE_UPDATE = false;
let claudeConsentWarningShown = false;

function requireClaudeGlobalSettingsConsent({ explicitRemove = false } = {}) {
  const allowed =
    explicitRemove ||
    FORCE_UPDATE ||
    process.env.META_KIM_CONFIRM_GLOBAL === "1";
  if (allowed) return true;
  if (!claudeConsentWarningShown) {
    warn(
      "Refusing to write to user-global Claude settings without explicit consent. " +
      "Pass --force or set META_KIM_CONFIRM_GLOBAL=1 to allow global mutation. " +
      `Target: ${CLAUDE_SETTINGS}`,
    );
    claudeConsentWarningShown = true;
  }
  return false;
}

function parseTargets(argv) {
  const explicitValues = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--targets") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--targets requires a comma-separated runtime list");
      }
      explicitValues.push(value);
      index += 1;
    } else if (arg.startsWith("--targets=")) {
      explicitValues.push(arg.slice("--targets=".length));
    }
  }
  if (explicitValues.length === 0) return [...DEFAULT_TARGETS];
  if (explicitValues.length !== 1 || !explicitValues[0].trim()) {
    throw new Error("Specify --targets exactly once with a non-empty runtime list");
  }
  const rawItems = explicitValues[0].split(",");
  if (rawItems.some((item) => !item.trim())) {
    throw new Error("--targets contains an empty runtime id");
  }
  const parsed = rawItems.map((item) => item.trim().toLowerCase());
  const unknown = [...new Set(parsed.filter((item) => !VALID_TARGETS.has(item)))];
  if (unknown.length > 0) {
    throw new Error(
      `Unknown MCP Memory runtime target(s): ${unknown.join(", ")}. Valid targets: ${DEFAULT_TARGETS.join(", ")}`,
    );
  }
  return [...new Set(parsed)];
}

function targetListText(targets) {
  return targets.join(", ");
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    ...opts,
  });
}

function isMemoryProcessRunning() {
  if (process.platform !== "win32") return false;
  try {
    const ps = run("pwsh.exe", [
      "-NoProfile",
      "-Command",
      "if (Get-Process -Name memory -ErrorAction SilentlyContinue) { 'running' }",
    ]);
    if (ps.status === 0 && ps.stdout.includes("running")) return true;
  } catch {
    // fall through
  }
  try {
    const result = run("tasklist", ["/FI", "IMAGENAME eq memory.exe"]);
    return result.status === 0 && /\bmemory\.exe\b/iu.test(result.stdout);
  } catch {
    return false;
  }
}

function configuredMemoryEndpoint() {
  return resolveMemoryEndpoint().endpointUrl;
}

function memoryHealthUrl(endpoint = configuredMemoryEndpoint()) {
  return resolveMemoryEndpoint({ MCP_MEMORY_URL: endpoint }).healthUrl;
}

function endpointPort(endpoint = configuredMemoryEndpoint()) {
  return resolveMemoryEndpoint({ MCP_MEMORY_URL: endpoint }).port;
}

function findProcessUsingPort(port) {
  if (!port) return null;
  if (process.platform === "win32") {
    const netstat = run("netstat", ["-ano", "-p", "tcp"]);
    if (netstat.status === 0) {
      const lines = netstat.stdout.split(/\r?\n/);
      const listeningLine = lines.find((line) => {
        const parts = line.trim().split(/\s+/);
        return (
          /LISTENING/i.test(line) &&
          parts.some((part) => part.endsWith(`:${port}`))
        );
      });
      const pid = listeningLine?.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) {
        const task = run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
        const name = task.stdout.match(/^"([^"]+)"/)?.[1] || "unknown";
        return { pid, name };
      }
    }
    return null;
  }

  const lsof = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  if (lsof.status === 0 && lsof.stdout) {
    const line = lsof.stdout.split(/\r?\n/).find((entry) => /^\S+\s+\d+\s/u.test(entry));
    if (line) {
      const parts = line.trim().split(/\s+/);
      return { pid: parts[1], name: parts[0] };
    }
  }
  return null;
}

function printMemoryPortDiagnostic(endpoint = configuredMemoryEndpoint()) {
  const port = endpointPort(endpoint);
  const owner = findProcessUsingPort(port);
  if (!owner) {
    info(`Endpoint checked: ${endpoint}`);
    info("Use MCP_MEMORY_URL or META_KIM_MEMORY_PORT to point hooks at a different service.");
    return;
  }
  warn(`Port ${port} is already used by PID ${owner.pid} (${owner.name}).`);
  info(
    `Choose another endpoint, for example: set META_KIM_MEMORY_PORT=8001 or set MCP_MEMORY_URL=http://localhost:8001`,
  );
}

function checkServerHealthStatus(endpoint = configuredMemoryEndpoint()) {
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const url = memoryHealthUrl(endpoint);
  try {
    const result = run(curl, ["--noproxy", "*", "-s", "--max-time", "2", url]);
    if (result.status === 0 && result.stdout) {
      const data = JSON.parse(result.stdout);
      return data.status === "healthy" ? "healthy" : "down";
    }
  } catch {
    // fall through
  }
  return isMemoryProcessRunning() ? "unknown" : "down";
}

function filesEqual(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  try {
    return readFileSync(a, "utf8") === readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

export function isValidPythonCommand(cmd, platform = process.platform) {
  const normalized = cmd?.trim().replace(/\\/gu, "/") || "";
  if (platform === "win32") {
    if (!windowsPath.isAbsolute(normalized) || normalized.toLowerCase().includes("/windowsapps/")) {
      return false;
    }
    return /^(?:python|python3|pythonw)\.exe$/iu.test(windowsPath.basename(normalized));
  }
  if (/^(?:python|python3)$/u.test(normalized)) return true;
  return (
    posixPath.isAbsolute(normalized) &&
    /^(?:python|python3(?:\.\d+)?)$/u.test(posixPath.basename(normalized))
  );
}

export function collectWindowsPythonCommandCandidates({
  env,
  locatedPaths = [],
  pathExists,
  listDirectoryNames,
}) {
  const candidates = [];
  const scanVersionDirectories = (root) => {
    if (!root || !windowsPath.isAbsolute(root)) return;
    for (const name of listDirectoryNames(root)) {
      if (!/^Python\d+(?:-32)?$/iu.test(name)) continue;
      candidates.push(windowsPath.join(root, name, "python.exe"));
      candidates.push(windowsPath.join(root, name, "python3.exe"));
    }
  };
  for (const key of ["META_KIM_PYTHON", "PYTHON", "PYTHON3"]) {
    if (env[key]) candidates.push(env[key]);
  }
  candidates.push(...locatedPaths);
  if (env.LOCALAPPDATA) {
    scanVersionDirectories(windowsPath.join(env.LOCALAPPDATA, "Programs", "Python"));
  }
  for (const key of ["ProgramFiles", "ProgramFiles(x86)"]) {
    if (env[key]) scanVersionDirectories(env[key]);
  }
  scanVersionDirectories("C:\\");
  return candidates.filter((candidate) => pathExists(candidate));
}

export function selectPythonCommand({
  candidates,
  platform,
  pathExists,
  probe,
}) {
  const preferredCandidates = [];
  for (const cmd of candidates) {
    if (!isValidPythonCommand(cmd, platform)) continue;
    if (platform === "win32" && /^(?:python|python3)\.exe$/iu.test(windowsPath.basename(cmd))) {
      const pythonw = windowsPath.join(windowsPath.dirname(cmd), "pythonw.exe");
      if (pathExists(pythonw)) preferredCandidates.push(pythonw);
    }
    preferredCandidates.push(cmd);
  }
  const seen = new Set();
  for (const cmd of preferredCandidates) {
    if (!isValidPythonCommand(cmd, platform)) continue;
    const normalized = cmd.replace(/\\/gu, "/");
    const key = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    if (probe(cmd)) return normalized;
  }
  return null;
}

function pickPythonCommand() {
  // Cross-platform Python resolver.
  // Windows: the Microsoft Store WindowsApps shim intercepts bare `python`
  // and returns exit code 49 without stderr — must be filtered out at every stage.
  const isWin = process.platform === "win32";
  let candidates = [];

  // 1. Explicit PYTHON env var (highest priority)
  if (!isWin && process.env.PYTHON) candidates.push(process.env.PYTHON);

  // 2. System discovery via where/which — finds all versions in PATH
  const finder = isWin ? "where.exe" : "which";
  for (const name of ["python3", "python"]) {
    try {
      const result = run(finder, [name], { timeout: 750 });
      if (result.status === 0 && result.stdout) {
        const paths = result.stdout
          .trim()
          .split(/\r?\n/)
          .map((p) => p.trim())
          .filter(Boolean);
        candidates.push(...paths);
      }
    } catch {
      // not found
    }
  }

  // 3. Dynamic Windows install paths (no hardcoded version numbers)
  if (isWin) {
    const listDirectoryNames = (directory) => {
      try {
        return readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      } catch {
        return [];
      }
    };
    candidates = collectWindowsPythonCommandCandidates({
      env: process.env,
      locatedPaths: candidates,
      pathExists: existsSync,
      listDirectoryNames,
    });
  }

  const selected = selectPythonCommand({
    candidates,
    platform: process.platform,
    pathExists: existsSync,
    probe: (cmd) => run(
      cmd,
      ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"],
      { timeout: 750 },
    ).status === 0,
  });
  if (selected) return selected;
  if (!isWin) return "python3";
  warn("No safe working Python found — Claude SessionStart registration is blocked");
  return null;
}

function readJsonFile(filePath, fallback = {}) {
  if (!existsSync(filePath)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readExistingJsonObjectStrict(filePath, fallback) {
  if (!existsSync(filePath)) return { ok: true, value: fallback, existed: false };
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isJsonObject(value)) {
      return { ok: false, path: filePath, reason: "existing_json_root_not_object" };
    }
    return { ok: true, value, existed: true };
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      reason: "existing_json_malformed",
      detail: error.message,
    };
  }
}

function readSelectedRuntimeSettingsStrict(targets) {
  const specs = [
    ["claude", CLAUDE_SETTINGS, { hooks: {} }],
    ["codex", join(CODEX_HOME, "hooks.json"), { hooks: {} }],
    ["cursor", join(CURSOR_HOME, "hooks.json"), { version: 1, hooks: {} }],
  ];
  const values = {};
  for (const [runtime, filePath, fallback] of specs) {
    if (!targets.includes(runtime)) continue;
    const parsed = readExistingJsonObjectStrict(filePath, fallback);
    if (!parsed.ok) return { ...parsed, runtime };
    values[runtime] = parsed.value;
  }
  return { ok: true, values };
}

function crossRuntimeMemoryHookCandidates(runtimeHome) {
  return [
    join(runtimeHome, "hooks", "meta-kim", CROSS_RUNTIME_HOOK_FILE),
    join(runtimeHome, "hooks", CROSS_RUNTIME_HOOK_FILE),
  ];
}

function findInstalledCrossRuntimeMemoryHook(runtimeHome) {
  return crossRuntimeMemoryHookCandidates(runtimeHome).find((candidate) =>
    existsSync(candidate),
  ) ?? null;
}

function listRegularFiles(rootDir) {
  if (!existsSync(rootDir) || lstatSync(rootDir).isSymbolicLink()) return null;
  const files = [];
  const visit = (dirPath) => {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return false;
      const entryPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (!visit(entryPath)) return false;
      } else if (entry.isFile()) {
        files.push(relative(rootDir, entryPath).replace(/\\/g, "/"));
      } else return false;
    }
    return true;
  };
  return visit(rootDir) ? files.sort() : null;
}

function homeRel(filePath) {
  return normalizeManagedRelPath(relative(homedir(), filePath));
}

function runtimeManifestPath(runtime) {
  return join(RUNTIME_MANIFEST_DIR, `${runtime}.json`);
}

function readRuntimeManagedManifest(runtime) {
  return readRuntimeManagedManifestState(runtime).manifest;
}

function commandToken(value) {
  const normalized = String(value).replace(/\\/gu, "/");
  return /[\s"]/u.test(normalized)
    ? `"${normalized.replace(/"/gu, '\\"')}"`
    : normalized;
}

function quotedCommandToken(value) {
  return `"${String(value).replace(/\\/gu, "/").replace(/"/gu, '\\"')}"`;
}

function commandTargetsExactClaudeSessionHook(command, { allowLegacy = false } = {}) {
  const normalized = String(command ?? "").trim().replace(/\\/gu, "/");
  const targetToken = `"${String(HOOK_TARGET).replace(/\\/gu, "/").replace(/"/gu, '\\"')}"`;
  const currentSuffix = ` ${targetToken} --mode session`;
  const legacySuffix = ` ${targetToken}`;
  const suffix = normalized.endsWith(currentSuffix)
    ? currentSuffix
    : allowLegacy && normalized.endsWith(legacySuffix)
      ? legacySuffix
      : null;
  if (!suffix) return false;
  const executable = normalized.slice(0, -suffix.length).trim();
  return Boolean(executable) && !/[&|;<>()\r\n]/u.test(executable);
}

function buildClaudeSessionStartFragment() {
  const pythonCmd = pickPythonCommand();
  if (!pythonCmd) {
    throw new Error("Claude SessionStart requires a safe absolute Python interpreter on Windows");
  }
  return {
    kind: CLAUDE_SESSION_FRAGMENT_KIND,
    settingsRelPath: homeRel(CLAUDE_SETTINGS),
    eventName: CLAUDE_SESSION_FRAGMENT_EVENT,
    matcher: CLAUDE_SESSION_FRAGMENT_MATCHER,
    hook: {
      type: "command",
      command: `${quotedCommandToken(pythonCmd)} ${quotedCommandToken(HOOK_TARGET)} --mode session`,
    },
  };
}

function normalizeClaudeSettingsFragment(fragment) {
  if (
    !isJsonObject(fragment) ||
    fragment.kind !== CLAUDE_SESSION_FRAGMENT_KIND ||
    fragment.settingsRelPath !== homeRel(CLAUDE_SETTINGS) ||
    fragment.eventName !== CLAUDE_SESSION_FRAGMENT_EVENT ||
    fragment.matcher !== CLAUDE_SESSION_FRAGMENT_MATCHER ||
    !isJsonObject(fragment.hook) ||
    fragment.hook.type !== "command" ||
    typeof fragment.hook.command !== "string" ||
    !commandTargetsExactClaudeSessionHook(fragment.hook.command)
  ) return null;
  return {
    kind: CLAUDE_SESSION_FRAGMENT_KIND,
    settingsRelPath: homeRel(CLAUDE_SETTINGS),
    eventName: CLAUDE_SESSION_FRAGMENT_EVENT,
    matcher: CLAUDE_SESSION_FRAGMENT_MATCHER,
    hook: { type: "command", command: fragment.hook.command },
  };
}

function validateRuntimeManagedManifestValue(raw, runtime) {
  const manifest = validateManagedManifest(raw, {
    schemaVersion: RUNTIME_MANIFEST_SCHEMA,
  });
  if (!manifest || manifest.runtime !== runtime) return null;
  const rawFragments = raw.settingsFragments ?? [];
  if (!Array.isArray(rawFragments)) return null;
  if (runtime !== "claude" && rawFragments.length > 0) return null;
  const settingsFragments = rawFragments.map(normalizeClaudeSettingsFragment);
  if (settingsFragments.some((fragment) => !fragment) || settingsFragments.length > 1) {
    return null;
  }
  return { ...manifest, settingsFragments };
}

function readRuntimeManagedManifestState(runtime) {
  const manifestPath = runtimeManifestPath(runtime);
  if (!existsSync(manifestPath)) {
    return { exists: false, manifestPath, raw: null, manifest: null };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { exists: true, manifestPath, raw: null, manifest: null };
  }
  return {
    exists: true,
    manifestPath,
    raw,
    manifest: validateRuntimeManagedManifestValue(raw, runtime),
  };
}

function safeSpecPath(rootDir, relativePath) {
  const normalized = normalizeManagedRelPath(relativePath);
  if (!normalized) return null;
  const absolutePath = resolve(rootDir, normalized);
  const rel = relative(rootDir, absolutePath);
  if (!rel || rel === ".." || rel.startsWith(`..${pathSeparator}`) || isAbsolute(rel)) {
    return null;
  }
  return absolutePath;
}

function managedAssetSpecError(message) {
  throw new Error(`Invalid MCP Memory managed-assets spec: ${message}`);
}

function runtimeHomeFor(runtime) {
  if (!/^[a-z][a-z0-9-]*$/u.test(runtime)) {
    managedAssetSpecError(`unsafe runtime id ${JSON.stringify(runtime)}`);
  }
  const runtimeHome = safeSpecPath(homedir(), `.${runtime}`);
  const relPath = runtimeHome ? homeRel(runtimeHome) : null;
  const inspected = relPath
    ? inspectTrustedPath(homedir(), relPath, { allowMissing: true })
    : null;
  if (!runtimeHome || !relPath || !inspected) {
    managedAssetSpecError(`unsafe runtime home for ${runtime}`);
  }
  if (existsSync(runtimeHome) && !lstatSync(runtimeHome).isDirectory()) {
    managedAssetSpecError(`runtime home is not a directory for ${runtime}`);
  }
  return runtimeHome;
}

function requireCanonicalSource(relativePath, expectedKind, label) {
  const normalized = normalizeManagedRelPath(relativePath);
  const sourcePath = normalized
    ? safeSpecPath(CANONICAL_RUNTIME_ASSETS_DIR, normalized)
    : null;
  const inspected = normalized
    ? inspectTrustedPath(CANONICAL_RUNTIME_ASSETS_DIR, normalized)
    : null;
  if (!sourcePath || !inspected) {
    managedAssetSpecError(`${label} is missing, unsafe, or traverses a symbolic link`);
  }
  const stats = lstatSync(sourcePath);
  if (expectedKind === "file" && !stats.isFile()) {
    managedAssetSpecError(`${label} must be a regular file`);
  }
  if (expectedKind === "directory" && !stats.isDirectory()) {
    managedAssetSpecError(`${label} must be a directory`);
  }
  return sourcePath;
}

function requireRuntimeFileTarget(runtimeHome, relativePath, label) {
  const targetPath = safeSpecPath(runtimeHome, relativePath);
  const relPath = targetPath ? homeRel(targetPath) : null;
  const inspected = relPath
    ? inspectTrustedPath(homedir(), relPath, { allowMissing: true })
    : null;
  if (!targetPath || !relPath || !inspected) {
    managedAssetSpecError(`${label} is unsafe or traverses a symbolic link`);
  }
  if (existsSync(targetPath) && !lstatSync(targetPath).isFile()) {
    managedAssetSpecError(`${label} must resolve to a regular file target`);
  }
  return targetPath;
}

function declarationShape(declaration, label) {
  if (!isJsonObject(declaration)) {
    managedAssetSpecError(`${label} must be an object`);
  }
  const has = (key) => Object.prototype.hasOwnProperty.call(declaration, key);
  const shapes = [
    ["file", ["source", "target"]],
    ["fileCandidates", ["source", "targetCandidates"]],
    ["tree", ["sourceTree", "targetTree"]],
    ["filesIn", ["sourceFilesIn", "targetDir"]],
  ].filter(([, keys]) => keys.every(has));
  if (shapes.length !== 1) {
    managedAssetSpecError(`${label} must use exactly one supported declaration shape`);
  }
  const [shape, allowedKeys] = shapes[0];
  const unexpected = Object.keys(declaration).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    managedAssetSpecError(`${label} has unexpected field(s): ${unexpected.join(", ")}`);
  }
  for (const key of allowedKeys.filter((key) => key !== "targetCandidates")) {
    if (typeof declaration[key] !== "string" || !declaration[key].trim()) {
      managedAssetSpecError(`${label}.${key} must be a non-empty string`);
    }
  }
  if (shape === "fileCandidates") {
    if (
      !Array.isArray(declaration.targetCandidates) ||
      declaration.targetCandidates.length === 0 ||
      declaration.targetCandidates.some((value) => typeof value !== "string" || !value.trim()) ||
      new Set(declaration.targetCandidates).size !== declaration.targetCandidates.length
    ) {
      managedAssetSpecError(`${label}.targetCandidates must be a non-empty unique string array`);
    }
  }
  return shape;
}

function expandManagedDeclaration(
  group,
  runtime,
  declaration,
  declarationIndex,
  { allTargetCandidates = false } = {},
) {
  const label = `${group}.${runtime}[${declarationIndex}]`;
  const shape = declarationShape(declaration, label);
  const runtimeHome = runtimeHomeFor(runtime);
  const specs = [];
  const add = (source, target, targetLabel) => {
    const verifiedTarget = requireRuntimeFileTarget(runtimeHome, target, targetLabel);
    specs.push({ source, target: verifiedTarget, relPath: homeRel(verifiedTarget) });
  };

  if (shape === "file" || shape === "fileCandidates") {
    const source = requireCanonicalSource(declaration.source, "file", `${label}.source`);
    const targetValues = shape === "file"
      ? [declaration.target]
      : declaration.targetCandidates;
    const candidates = targetValues.map((target, index) => ({
      target,
      absolutePath: requireRuntimeFileTarget(
        runtimeHome,
        target,
        `${label}.${shape === "file" ? "target" : `targetCandidates[${index}]`}`,
      ),
    }));
    const selected = allTargetCandidates
      ? candidates
      : shape === "file"
        ? candidates
        : (() => {
            const globalProofs = group === "delegatedToGlobalSync"
              ? readGlobalInstallProofs()
              : null;
            return [
              candidates.find((candidate) =>
                globalManifestProvesFile(candidate.absolutePath, globalProofs),
              ) ??
              candidates.find((candidate) => existsSync(candidate.absolutePath)) ??
              candidates[0],
            ];
          })();
    for (const [index, candidate] of selected.entries()) {
      add(source, candidate.target, `${label}.selectedTarget[${index}]`);
    }
    return specs;
  }

  const sourceRoot = requireCanonicalSource(
    shape === "tree" ? declaration.sourceTree : declaration.sourceFilesIn,
    "directory",
    `${label}.${shape === "tree" ? "sourceTree" : "sourceFilesIn"}`,
  );
  const targetRoot = shape === "tree" ? declaration.targetTree : declaration.targetDir;
  const sourceFiles = shape === "tree"
    ? listRegularFiles(sourceRoot)
    : readdirSync(sourceRoot, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isSymbolicLink()) {
          managedAssetSpecError(`${label}.sourceFilesIn contains symbolic link ${entry.name}`);
        }
        return entry.isFile() ? [entry.name] : [];
      });
  if (!sourceFiles || sourceFiles.length === 0) {
    managedAssetSpecError(`${label} resolves to no regular source files`);
  }
  for (const relPath of sourceFiles) {
    const source = requireCanonicalSource(
      join(
        shape === "tree" ? declaration.sourceTree : declaration.sourceFilesIn,
        relPath,
      ),
      "file",
      `${label}.source:${relPath}`,
    );
    add(source, join(targetRoot, relPath), `${label}.target:${relPath}`);
  }
  return specs;
}

function retiredOwnedFileSpecs(runtime) {
  const declarations = MANAGED_ASSET_SPEC.retiredOwned?.[runtime];
  if (!Array.isArray(declarations)) {
    managedAssetSpecError(`retiredOwned.${runtime} must be an array`);
  }
  const runtimeHome = runtimeHomeFor(runtime);
  return declarations.map((declaration, index) => {
    const label = `retiredOwned.${runtime}[${index}]`;
    if (
      !isJsonObject(declaration) ||
      Object.keys(declaration).length !== 1 ||
      typeof declaration.target !== "string" ||
      !declaration.target.trim()
    ) managedAssetSpecError(`${label} must contain only one non-empty target`);
    const target = requireRuntimeFileTarget(runtimeHome, declaration.target, `${label}.target`);
    return { target, relPath: homeRel(target) };
  });
}

function preflightManagedAssetSpec() {
  const targetOwners = new Map();
  for (const group of ["owned", "delegatedToGlobalSync"]) {
    for (const [runtime, declarations] of Object.entries(MANAGED_ASSET_SPEC[group])) {
      runtimeHomeFor(runtime);
      for (const [index, declaration] of declarations.entries()) {
        const specs = expandManagedDeclaration(group, runtime, declaration, index, {
          allTargetCandidates: true,
        });
        for (const spec of specs) {
          const key = absolutePathKey(spec.target);
          const owner = `${group}.${runtime}[${index}]`;
          const previous = targetOwners.get(key);
          if (previous && previous !== owner) {
            managedAssetSpecError(
              `single-owner collision for ${spec.relPath}: ${previous} and ${owner}`,
            );
          }
          targetOwners.set(key, owner);
        }
      }
    }
  }
  for (const runtime of Object.keys(MANAGED_ASSET_SPEC.retiredOwned)) {
    for (const [index, spec] of retiredOwnedFileSpecs(runtime).entries()) {
      const key = absolutePathKey(spec.target);
      const owner = `retiredOwned.${runtime}[${index}]`;
      const previous = targetOwners.get(key);
      if (previous && previous !== owner) {
        managedAssetSpecError(
          `single-owner collision for ${spec.relPath}: ${previous} and ${owner}`,
        );
      }
      targetOwners.set(key, owner);
    }
  }
}

function declaredFileSpecs(group, runtime, options = {}) {
  const declarations = MANAGED_ASSET_SPEC[group]?.[runtime];
  if (!Array.isArray(declarations)) {
    managedAssetSpecError(`${group}.${runtime} must be an array`);
  }
  return declarations.flatMap((declaration, index) =>
    expandManagedDeclaration(group, runtime, declaration, index, options)
  );
}

preflightManagedAssetSpec();

function canonicalFileSpecs(runtime) {
  return declaredFileSpecs("owned", runtime);
}

function delegatedGlobalFileSpecs(runtime, options = {}) {
  return declaredFileSpecs("delegatedToGlobalSync", runtime, options);
}

function validateMemoryManifestOwnedPaths(runtime, manifest) {
  const allowed = new Set([
    ...canonicalFileSpecs(runtime).map((spec) => spec.relPath),
    ...retiredOwnedFileSpecs(runtime).map((spec) => spec.relPath),
    ...delegatedGlobalFileSpecs(runtime, { allTargetCandidates: true }).map(
      (spec) => spec.relPath,
    ),
  ]);
  for (const entry of manifest?.files ?? []) {
    if (allowed.has(entry.relPath) || isSeedOnlyRetainedPath(runtime, entry.relPath)) continue;
    return entry.relPath;
  }
  return null;
}

function absolutePathKey(filePath) {
  const key = resolve(filePath).replace(/\\/g, "/");
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function readGlobalInstallProofs() {
  const manifest = readJsonFile(GLOBAL_INSTALL_MANIFEST_PATH, null);
  if (!manifest || !Array.isArray(manifest.entries)) return null;
  const proofs = new Map();
  for (const entry of manifest.entries) {
    if (
      typeof entry?.path !== "string" ||
      !/^[a-f0-9]{64}$/i.test(entry?.sha256 ?? "") ||
      !Number.isSafeInteger(entry?.size) ||
      entry.size < 0
    ) continue;
    proofs.set(absolutePathKey(entry.path), entry);
  }
  return proofs;
}

function globalManifestProvesFile(filePath, proofs) {
  if (!proofs || !existsSync(filePath)) return false;
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) return false;
  const proof = proofs.get(absolutePathKey(filePath));
  if (!proof || proof.size !== stats.size) return false;
  return sha256ManagedFile(filePath) === proof.sha256.toLowerCase();
}

function runtimeRegistrationIssues(runtime) {
  const issues = [];
  if (runtime === "claude") {
    const settings = readJsonFile(CLAUDE_SETTINGS, null);
    for (const hookName of ["stop-save-progress.mjs", "stop-memory-save.mjs"]) {
      const registered = (settings?.hooks?.Stop ?? []).some((block) =>
        block?.hooks?.some((hook) => String(hook?.command ?? "").includes(hookName)),
      );
      if (!registered) issues.push(`Claude Stop hook NOT registered: ${hookName}`);
    }
  }
  for (const [targetId, runtimeHome, eventNames] of [
    ["codex", CODEX_HOME, ["SessionStart", "UserPromptSubmit", "Stop"]],
    ["cursor", CURSOR_HOME, ["beforeSubmitPrompt", "stop"]],
  ]) {
    if (runtime !== targetId) continue;
    const settings = readJsonFile(join(runtimeHome, "hooks.json"), null);
    for (const eventName of eventNames) {
      const entries = settings?.hooks?.[eventName] ?? [];
      const registered = Array.isArray(entries) && entries.some((entry) =>
        entry?.command
          ? String(entry.command).includes(CROSS_RUNTIME_HOOK_FILE)
          : (entry?.hooks ?? []).some((hook) =>
              String(hook?.command ?? "").includes(CROSS_RUNTIME_HOOK_FILE),
            ),
      );
      if (!registered) issues.push(`${targetId} ${eventName} memory hook NOT registered`);
    }
  }
  return issues;
}

function delegatedGlobalProjectionIssues(
  targets,
  { includeRegistrations = true } = {},
) {
  const proofs = readGlobalInstallProofs();
  const issues = [];
  for (const runtime of targets) {
    for (const spec of delegatedGlobalFileSpecs(runtime)) {
      if (!globalManifestProvesFile(spec.target, proofs)) {
        issues.push(
          `${runtime}: global sync ownership proof missing or stale (${spec.relPath})`,
        );
      }
    }
    if (includeRegistrations) {
      issues.push(...runtimeRegistrationIssues(runtime));
    }
  }
  return issues;
}

function isSeedOnlyRetainedPath(runtime, relPath) {
  return runtime === "claude" && relPath === homeRel(CONFIG_TARGET);
}

function seedOnlyOperations(runtime) {
  if (
    runtime !== "claude" ||
    existsSync(CONFIG_TARGET) ||
    !existsSync(CANONICAL_CONFIG_TEMPLATE)
  ) return [];
  return [{
    kind: "write",
    phase: "auxiliary",
    relPath: homeRel(CONFIG_TARGET),
    content: readFileSync(CANONICAL_CONFIG_TEMPLATE),
    expectedOldHash: null,
  }];
}

function assertMutableClaudeHookShape(settings) {
  if (settings.hooks !== undefined && !isJsonObject(settings.hooks)) {
    throw new Error("Claude settings hooks must be an object; preserved existing settings");
  }
  const sessionStart = settings.hooks?.[CLAUDE_SESSION_FRAGMENT_EVENT];
  if (sessionStart !== undefined && !Array.isArray(sessionStart)) {
    throw new Error("Claude SessionStart hooks must be an array; preserved existing settings");
  }
}

function hookMatchesClaudeFragment(block, hook, fragment) {
  return (
    isJsonObject(block) &&
    block.matcher === fragment.matcher &&
    isJsonObject(hook) &&
    hook.type === fragment.hook.type &&
    hook.command === fragment.hook.command
  );
}

function claudeSettingsContainsFragment(settings, fragment) {
  const blocks = settings?.hooks?.[fragment.eventName];
  return Array.isArray(blocks) && blocks.some((block) =>
    Array.isArray(block?.hooks) &&
    block.hooks.some((hook) => hookMatchesClaudeFragment(block, hook, fragment)),
  );
}

function removeOwnedClaudeSessionFragments(
  settings,
  { fragments = [], allowLegacyOwnedFragment = false } = {},
) {
  assertMutableClaudeHookShape(settings);
  const hooks = { ...(settings.hooks ?? {}) };
  const blocks = [...(hooks[CLAUDE_SESSION_FRAGMENT_EVENT] ?? [])];
  const remaining = fragments.map((fragment) => ({ fragment, removed: false }));
  let legacyRemoved = false;

  for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    const block = blocks[blockIndex];
    if (!isJsonObject(block) || !Array.isArray(block.hooks)) continue;
    const nextHooks = [...block.hooks];
    for (let hookIndex = nextHooks.length - 1; hookIndex >= 0; hookIndex -= 1) {
      const hook = nextHooks[hookIndex];
      const exact = remaining.find(
        (candidate) =>
          !candidate.removed && hookMatchesClaudeFragment(block, hook, candidate.fragment),
      );
      if (exact) {
        exact.removed = true;
        nextHooks.splice(hookIndex, 1);
        continue;
      }
      if (
        !legacyRemoved &&
        allowLegacyOwnedFragment &&
        block.matcher === CLAUDE_SESSION_FRAGMENT_MATCHER &&
        isJsonObject(hook) &&
        hook.type === "command" &&
        commandTargetsExactClaudeSessionHook(hook.command, { allowLegacy: true })
      ) {
        legacyRemoved = true;
        nextHooks.splice(hookIndex, 1);
      }
    }
    if (nextHooks.length > 0) {
      blocks[blockIndex] = { ...block, hooks: nextHooks };
    } else if (Object.keys(block).every((key) => ["matcher", "hooks"].includes(key))) {
      blocks.splice(blockIndex, 1);
    } else {
      blocks[blockIndex] = { ...block, hooks: [] };
    }
  }

  if (blocks.length > 0) hooks[CLAUDE_SESSION_FRAGMENT_EVENT] = blocks;
  else delete hooks[CLAUDE_SESSION_FRAGMENT_EVENT];
  const next = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

function buildClaudeSettingsValue(
  settings,
  { previousFragments = [], allowLegacyOwnedFragment = false, desiredFragment },
) {
  const cleaned = removeOwnedClaudeSessionFragments(settings, {
    fragments: previousFragments,
    allowLegacyOwnedFragment,
  });
  return {
    ...cleaned,
    hooks: {
      ...(cleaned.hooks ?? {}),
      [CLAUDE_SESSION_FRAGMENT_EVENT]: [
        ...(cleaned.hooks?.[CLAUDE_SESSION_FRAGMENT_EVENT] ?? []),
        { matcher: desiredFragment.matcher, hooks: [{ ...desiredFragment.hook }] },
      ],
    },
  };
}

function jsonOperation(filePath, value, phase = "content") {
  const content = JSON.stringify(value, null, 2) + "\n";
  const currentHash = sha256ManagedFile(filePath);
  if (currentHash === sha256Buffer(Buffer.from(content))) return null;
  return {
    kind: "write",
    relPath: homeRel(filePath),
    content,
    expectedOldHash: currentHash,
    phase,
  };
}

function blockedTransaction(reason, nextAction, relPath = null) {
  return {
    ok: false,
    status: "blocked",
    reason,
    nextAction,
    ...(relPath ? { relPath } : {}),
  };
}

function blockedExistingSettingsTransaction(existingSettings) {
  const relPath = homeRel(existingSettings.path) ?? existingSettings.path;
  warn(
    `Preserved ${existingSettings.runtime} settings: existing JSON is malformed or is not an object (${existingSettings.path})`,
  );
  const result = blockedTransaction(
    `${existingSettings.reason}:${existingSettings.runtime}`,
    `Fix the JSON syntax so the root value is an object, then retry. Meta_Kim did not change any selected file. Target: ${existingSettings.path}`,
    relPath,
  );
  info(`Recovery: ${result.nextAction}`);
  return result;
}

function reportTransactionResult(label, result) {
  if (result.recovery && result.recovery !== "none") {
    ok(`${label}: recovered interrupted transaction state (${result.recovery}).`);
  }
  if (result.ok && result.status === "noop") {
    ok(`${label}: already up to date; no managed files were rewritten.`);
    return;
  }
  if (result.ok) return;

  const location = result.relPath ? ` (${result.relPath})` : "";
  if (result.status === "locked") {
    warn(`${label} is waiting on another installer: ${result.reason}${location}`);
  } else if (result.status === "recovery_required") {
    warn(`${label} needs transaction recovery before it can continue: ${result.reason}${location}`);
  } else {
    warn(`${label} preserved all targets: ${result.reason}${location}`);
  }
  if (result.nextAction) info(`Recovery: ${result.nextAction}`);
}

function installSelectedRuntimeFilesTransactional(targets) {
  if (targets.includes("claude") && !requireClaudeGlobalSettingsConsent()) {
    return blockedTransaction(
      "claude_global_consent_required",
      "Pass --force or set META_KIM_CONFIRM_GLOBAL=1, then retry.",
    );
  }
  const existingSettings = readSelectedRuntimeSettingsStrict(
    targets.filter((runtime) => runtime === "claude"),
  );
  if (!existingSettings.ok) {
    return blockedExistingSettingsTransaction(existingSettings);
  }
  const operations = [];
  const manifestOperations = [];
  const globalProofs = readGlobalInstallProofs();
  const desiredClaudeFragment = targets.includes("claude")
    ? buildClaudeSessionStartFragment()
    : null;
  let oldClaudeManifest = null;
  for (const runtime of targets) {
    const specs = canonicalFileSpecs(runtime);
    const delegatedSpecs = delegatedGlobalFileSpecs(runtime, {
      allTargetCandidates: true,
    });
    const delegatedByRelPath = new Map(
      delegatedSpecs.map((spec) => [spec.relPath, spec]),
    );
    const oldManifestState = readRuntimeManagedManifestState(runtime);
    const oldManifestPath = oldManifestState.manifestPath;
    const oldManifestRaw = oldManifestState.raw;
    const oldManifest = oldManifestState.manifest;
    if (oldManifestState.exists && !oldManifest) {
      warn(`Preserved runtime ${runtime}: ownership manifest is invalid or empty`);
      return blockedTransaction(
        `invalid_runtime_manifest:${runtime}`,
        "Preserve the runtime files and repair or remove only the invalid ownership manifest after inspection.",
      );
    }
    const invalidOwnedPath = oldManifest
      ? validateMemoryManifestOwnedPaths(runtime, oldManifest)
      : null;
    if (invalidOwnedPath) {
      warn(`Preserved runtime ${runtime}: ownership manifest contains an unowned path`);
      return blockedTransaction(
        `runtime_manifest_path_outside_owned_policy:${runtime}`,
        "Preserve every runtime file and repair the ownership manifest against the canonical managed-assets policy before retrying.",
        invalidOwnedPath,
      );
    }
    if (runtime === "claude") oldClaudeManifest = oldManifest;
    const oldMap = new Map((oldManifest?.files ?? []).map((entry) => [entry.relPath, entry.contentHash]));
    const nextFiles = [];
    const nextPaths = new Set(specs.map((spec) => spec.relPath));
    for (const entry of oldManifest?.files ?? []) {
      if (nextPaths.has(entry.relPath) || isSeedOnlyRetainedPath(runtime, entry.relPath)) {
        continue;
      }
      const delegated = delegatedByRelPath.get(entry.relPath);
      if (delegated) {
        if (!globalManifestProvesFile(delegated.target, globalProofs)) {
          warn(`Preserved runtime ${runtime}: delegated global owner proof is missing`);
          return blockedTransaction(
            `delegated_global_owner_proof_missing:${runtime}`,
            "Run global runtime sync first, verify its install manifest, then retry the ownership handoff.",
            entry.relPath,
          );
        }
        continue;
      }
      operations.push({
        kind: "remove",
        phase: "content",
        relPath: entry.relPath,
        expectedOldHash: entry.contentHash,
        allowManagedMissingRemove: true,
      });
    }
    for (const spec of specs) {
      const content = readFileSync(spec.source);
      const contentHash = sha256Buffer(content);
      nextFiles.push({ relPath: spec.relPath, contentHash });
      operations.push({
        kind: "write",
        phase: "content",
        relPath: spec.relPath,
        content,
        expectedOldHash: oldMap.get(spec.relPath) ?? null,
        authorizedAdoptIdentical: true,
        allowManagedMissingCreate: true,
      });
    }
    operations.push(...seedOnlyOperations(runtime));
    if (nextFiles.length > 0) {
      const manifestValue = {
        schemaVersion: RUNTIME_MANIFEST_SCHEMA,
        runtime,
        files: nextFiles,
        ...(runtime === "claude"
          ? { settingsFragments: [desiredClaudeFragment] }
          : {}),
      };
      const manifestOperation = jsonOperation(oldManifestPath, manifestValue, "manifest");
      if (manifestOperation) manifestOperations.push(manifestOperation);
    } else if (oldManifestRaw) {
      manifestOperations.push({
        kind: "remove",
        phase: "manifest",
        relPath: homeRel(oldManifestPath),
        expectedOldHash: sha256ManagedFile(oldManifestPath),
      });
    }
  }

  if (targets.includes("claude")) {
    const legacyHookOwned = Boolean(
      oldClaudeManifest &&
      oldClaudeManifest.settingsFragments.length === 0 &&
      oldClaudeManifest.files.some((entry) => entry.relPath === homeRel(HOOK_TARGET)),
    );
    const operation = jsonOperation(
      CLAUDE_SETTINGS,
      buildClaudeSettingsValue(existingSettings.values.claude, {
        previousFragments: oldClaudeManifest?.settingsFragments ?? [],
        allowLegacyOwnedFragment: legacyHookOwned,
        desiredFragment: desiredClaudeFragment,
      }),
      "auxiliary",
    );
    if (operation) operations.push(operation);
  }
  operations.push(...manifestOperations);

  const result = executeSafeManagedFileTransaction({
    trustedRoot: homedir(),
    backupRoot: join(homedir(), ".meta-kim", "backups"),
    operations,
    transactionLabel: "mcp-memory-install",
    lockKey: "mcp-memory-hooks",
  });
  reportTransactionResult("Runtime hook install", result);
  return result;
}

function removeSelectedRuntimeFilesTransactional(targets) {
  const existingSettings = readSelectedRuntimeSettingsStrict(
    targets.filter((runtime) => runtime === "claude"),
  );
  if (!existingSettings.ok) {
    return blockedExistingSettingsTransaction(existingSettings);
  }
  const operations = [];
  const manifestOperations = [];
  let claudeManifest = null;
  for (const runtime of targets) {
    const manifestState = readRuntimeManagedManifestState(runtime);
    const manifestPath = manifestState.manifestPath;
    const manifest = manifestState.manifest;
    if (manifestState.exists && !manifest) {
      warn(`Preserved runtime ${runtime}: ownership manifest is invalid or empty`);
      return blockedTransaction(
        `invalid_runtime_manifest:${runtime}`,
        "Preserve the runtime files and repair or remove only the invalid ownership manifest after inspection.",
      );
    }
    const invalidOwnedPath = manifest
      ? validateMemoryManifestOwnedPaths(runtime, manifest)
      : null;
    if (invalidOwnedPath) {
      warn(`Preserved runtime ${runtime}: ownership manifest contains an unowned path`);
      return blockedTransaction(
        `runtime_manifest_path_outside_owned_policy:${runtime}`,
        "Preserve every runtime file and repair the ownership manifest against the canonical managed-assets policy before retrying.",
        invalidOwnedPath,
      );
    }
    if (runtime === "claude") claudeManifest = manifest;
    if (!manifest) {
      const hasManagedCandidate = canonicalFileSpecs(runtime).some((spec) =>
        existsSync(spec.target),
      );
      if (hasManagedCandidate) {
        warn(`Preserved runtime ${runtime}: managed files exist without an ownership manifest`);
        return blockedTransaction(
          `ownership_manifest_missing:${runtime}`,
          "Run the installer to restore ownership evidence, or inspect the files before removing them manually.",
        );
      }
      continue;
    }
    const delegatedPaths = new Set(
      delegatedGlobalFileSpecs(runtime, { allTargetCandidates: true }).map(
        (spec) => spec.relPath,
      ),
    );
    for (const entry of manifest.files) {
      if (isSeedOnlyRetainedPath(runtime, entry.relPath)) continue;
      if (delegatedPaths.has(entry.relPath)) continue;
      operations.push({
        kind: "remove",
        phase: "content",
        relPath: entry.relPath,
        expectedOldHash: entry.contentHash,
        allowManagedMissingRemove: true,
      });
    }
    manifestOperations.push({
      kind: "remove",
      phase: "manifest",
      relPath: homeRel(manifestPath),
      expectedOldHash: sha256ManagedFile(manifestPath),
    });
  }

  if (targets.includes("claude") && claudeManifest && existsSync(CLAUDE_SETTINGS)) {
    const legacyHookOwned =
      claudeManifest.settingsFragments.length === 0 &&
      claudeManifest.files.some((entry) => entry.relPath === homeRel(HOOK_TARGET));
    const next = removeOwnedClaudeSessionFragments(existingSettings.values.claude, {
      fragments: claudeManifest.settingsFragments,
      allowLegacyOwnedFragment: legacyHookOwned,
    });
    const op = next ? jsonOperation(CLAUDE_SETTINGS, next, "auxiliary") : null;
    if (op) operations.push(op);
  }
  operations.push(...manifestOperations);
  const result = executeSafeManagedFileTransaction({
    trustedRoot: homedir(),
    backupRoot: join(homedir(), ".meta-kim", "backups"),
    operations,
    transactionLabel: "mcp-memory-remove",
    lockKey: "mcp-memory-hooks",
  });
  reportTransactionResult("Runtime hook removal", result);
  return result;
}

// ── Commands ────────────────────────────────────────────

async function install(targets) {
  console.log(`\n${bold("Installing MCP Memory runtime hooks...")}\n`);
  info(`Targets: ${targetListText(targets)}`);

  const transaction = installSelectedRuntimeFilesTransactional(targets);
  if (!targets.includes("claude")) ok("Claude MCP memory hooks skipped (claude not selected)");
  const delegatedIssues = transaction.ok
    ? delegatedGlobalProjectionIssues(targets)
    : [];
  for (const issue of delegatedIssues) warn(issue);

  console.log("");
  info("Checking MCP Memory Service health...");
  const endpoint = configuredMemoryEndpoint();
  const health = checkServerHealthStatus(endpoint);
  if (health === "healthy") {
    ok(`MCP Memory Service is running on ${endpoint}`);
  } else if (health === "unknown") {
    warn(
      `Could not verify ${endpoint} from this shell, but memory.exe is running`,
    );
  } else {
    warn(`MCP Memory Service is NOT responding on ${endpoint}`);
    printMemoryPortDiagnostic(endpoint);
    info(
      "Start the HTTP service with: MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http",
    );
  }

  if (!transaction.ok || delegatedIssues.length > 0) {
    warn(
      "Runtime hook installation did not complete; run global sync for shared projections and retry.",
    );
    console.log(
      `\n${yellow("Done with warnings.")} Follow the recovery guidance, retry, and restart runtimes only after installation succeeds.\n`,
    );
    process.exit(1);
  }

  console.log(
    `\n${green("Done!")} Restart selected runtimes for hooks to take effect.\n`,
  );
}

function addCheckIssue(issues, message) {
  issues.push(message);
  warn(message);
}

function verifyRuntimeManagedState(runtime, issues) {
  const manifestPath = runtimeManifestPath(runtime);
  const expectedSpecs = canonicalFileSpecs(runtime);
  if (expectedSpecs.length === 0) {
    if (existsSync(manifestPath)) {
      addCheckIssue(
        issues,
        `${runtime}: legacy memory ownership manifest remains after global-owner handoff`,
      );
    }
    return null;
  }
  if (!existsSync(manifestPath)) {
    addCheckIssue(issues, `${runtime}: ownership manifest is missing`);
    return null;
  }
  const manifest = readRuntimeManagedManifest(runtime);
  if (!manifest) {
    addCheckIssue(issues, `${runtime}: ownership manifest is invalid or empty`);
    return null;
  }

  const expected = new Map(expectedSpecs.map((spec) => [spec.relPath, spec]));
  const owned = new Map(manifest.files.map((entry) => [entry.relPath, entry]));
  for (const spec of expectedSpecs) {
    const entry = owned.get(spec.relPath);
    if (!entry) {
      addCheckIssue(issues, `${runtime}: managed file is missing from the manifest (${spec.relPath})`);
      continue;
    }
    const canonicalHash = sha256ManagedFile(spec.source);
    if (entry.contentHash !== canonicalHash) {
      addCheckIssue(issues, `${runtime}: manifest hash differs from the current canonical file (${spec.relPath})`);
      continue;
    }
    const installedHash = sha256ManagedFile(join(homedir(), spec.relPath));
    if (installedHash !== entry.contentHash) {
      addCheckIssue(issues, `${runtime}: installed managed file is missing or changed (${spec.relPath})`);
    }
  }
  for (const entry of manifest.files) {
    if (!expected.has(entry.relPath)) {
      const qualifier = isSeedOnlyRetainedPath(runtime, entry.relPath)
        ? "seed-only config is still incorrectly owned"
        : "stale managed entry remains";
      addCheckIssue(issues, `${runtime}: ${qualifier} (${entry.relPath})`);
    }
  }
  if (runtime === "claude") {
    const fragment = manifest.settingsFragments[0];
    if (!fragment) {
      addCheckIssue(issues, "claude: SessionStart settings ownership fragment is missing");
    } else {
      const settings = readJsonFile(CLAUDE_SETTINGS, null);
      if (!claudeSettingsContainsFragment(settings, fragment)) {
        addCheckIssue(
          issues,
          "claude: exact manifest-owned SessionStart settings fragment is missing or changed",
        );
      }
    }
  }
  return manifest;
}

function check(targets) {
  console.log(`\n${bold("Checking MCP Memory hook installation...")}\n`);
  info(`Targets: ${targetListText(targets)}`);
  const issues = [];

  const sourceExists = existsSync(CANONICAL_HOOK_SOURCE);
  if (targets.includes("claude")) {
    sourceExists
      ? ok(`Canonical source present: ${CANONICAL_HOOK_SOURCE}`)
      : addCheckIssue(issues, `Canonical source MISSING: ${CANONICAL_HOOK_SOURCE}`);

    const targetExists = existsSync(HOOK_TARGET);
    targetExists
      ? ok(`Hook installed: ${HOOK_TARGET}`)
      : addCheckIssue(issues, `Hook not installed at ${HOOK_TARGET}`);

    if (sourceExists && targetExists) {
      const inSync = filesEqual(CANONICAL_HOOK_SOURCE, HOOK_TARGET);
      inSync
        ? ok("Hook content in sync with canonical")
        : addCheckIssue(issues, "Hook content DIFFERS from canonical (run install to update)");
    }

    const configExists = existsSync(CONFIG_TARGET);
    configExists
      ? ok(`Config present: ${CONFIG_TARGET}`)
      : addCheckIssue(issues, `Config missing: ${CONFIG_TARGET}`);

    const settingsExists = existsSync(CLAUDE_SETTINGS);
    if (settingsExists) {
      try {
        const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
        const manifest = readRuntimeManagedManifest("claude");
        const sessionFragment = manifest?.settingsFragments?.[0] ?? null;
        const sessionRegistered = Boolean(
          sessionFragment && claudeSettingsContainsFragment(settings, sessionFragment),
        );
        sessionRegistered
          ? ok("SessionStart hook registered in settings.json")
          : addCheckIssue(issues, "SessionStart hook NOT registered");
        for (const hookName of ["stop-save-progress.mjs", "stop-memory-save.mjs"]) {
          const registered = (settings.hooks?.Stop ?? []).some((block) =>
            block?.hooks?.some((hook) => String(hook?.command ?? "").includes(hookName)),
          );
          registered
            ? ok(`Stop hook registered: ${hookName}`)
            : addCheckIssue(issues, `Stop hook NOT registered: ${hookName}`);
        }
      } catch {
        addCheckIssue(issues, "Could not parse settings.json");
      }
    } else {
      addCheckIssue(issues, `settings.json not found: ${CLAUDE_SETTINGS}`);
    }
    verifyRuntimeManagedState("claude", issues);
  } else {
    ok("Claude MCP memory checks skipped (claude not selected)");
  }

  for (const [label, runtimeHome, hooksFile, eventNames] of [
    [
      "Codex",
      CODEX_HOME,
      "hooks.json",
      ["SessionStart", "UserPromptSubmit", "Stop"],
    ],
    ["Cursor", CURSOR_HOME, "hooks.json", ["beforeSubmitPrompt", "stop"]],
  ]) {
    const targetId = label.toLowerCase();
    if (!targets.includes(targetId)) continue;
    const hookFile = findInstalledCrossRuntimeMemoryHook(runtimeHome);
    hookFile
      ? ok(`${label} memory hook installed: ${hookFile}`)
      : addCheckIssue(
          issues,
          `${label} memory hook missing: ${crossRuntimeMemoryHookCandidates(runtimeHome).join(" or ")}`,
        );
    const cfg = readJsonFile(join(runtimeHome, hooksFile), null);
    for (const eventName of eventNames) {
      const entries = cfg?.hooks?.[eventName] ?? [];
      const registered = Array.isArray(entries)
        ? entries.some((entry) => {
            if (entry?.command) {
              return String(entry.command).includes(CROSS_RUNTIME_HOOK_FILE);
            }
            return (entry?.hooks ?? []).some((hook) =>
              String(hook?.command ?? "").includes(CROSS_RUNTIME_HOOK_FILE),
            );
          })
        : false;
      registered
        ? ok(`${label} ${eventName} memory hook registered`)
        : addCheckIssue(issues, `${label} ${eventName} memory hook NOT registered`);
    }
    verifyRuntimeManagedState(targetId, issues);
  }

  const openclawHookDir = join(OPENCLAW_HOME, "hooks", "mcp-memory-service");
  if (targets.includes("openclaw")) {
    const before = issues.length;
    const manifest = verifyRuntimeManagedState("openclaw", issues);
    if (manifest && issues.length === before) {
      ok(`OpenClaw MCP memory hook manifest and hashes verified: ${openclawHookDir}`);
    }
  }

  for (const issue of delegatedGlobalProjectionIssues(targets, {
    includeRegistrations: false,
  })) {
    if (!issues.includes(issue)) addCheckIssue(issues, issue);
  }

  const endpoint = configuredMemoryEndpoint();
  const health = checkServerHealthStatus(endpoint);
  if (health === "healthy") {
    ok(`MCP Memory Service responding on ${endpoint}`);
  } else if (health === "unknown") {
    warn(
      `MCP Memory Service health could not be verified at ${endpoint}, but memory.exe is running`,
    );
  } else {
    warn(`MCP Memory Service NOT responding on ${endpoint}`);
    printMemoryPortDiagnostic(endpoint);
  }

  if (issues.length > 0) {
    warn(`${issues.length} hook installation issue(s) found.`);
    info(
      `Repair: node scripts/install-mcp-memory-hooks.mjs --targets ${targets.join(",")}` +
      (targets.includes("claude") ? " --force" : ""),
    );
    info("Then rerun this --check command. User files and drifted managed files will be preserved.");
  } else {
    ok("All selected runtime hook files, manifests, and registrations match.");
  }
  console.log("");
  return { ok: issues.length === 0, issueCount: issues.length, issues };
}

function remove(targets) {
  console.log(
    `\n${bold("Removing MCP Memory hook registration...")}\n`,
  );
  info(`Targets: ${targetListText(targets)}`);

  const transaction = removeSelectedRuntimeFilesTransactional(targets);
  info("Only exact manifest-managed files were removed; unknown or drifted files were preserved.");
  if (transaction.ok) ok("Done.\n");
  else warn("Removal was partial; preserved files require ownership or backup repair.\n");
  return transaction;
}

// ── Main ────────────────────────────────────────────────

const args = process.argv.slice(2);

// Handle --force flag (must be checked before other flags)
if (args.includes("--force")) {
  FORCE_UPDATE = true;
  // Remove --force from args so it doesn't interfere with other checks
  const forceIndex = args.indexOf("--force");
  args.splice(forceIndex, 1);
}

async function main() {
  const targets = parseTargets(args);
  if (args.includes("--check")) {
    if (!check(targets).ok) process.exitCode = 1;
  }
  else if (args.includes("--remove")) {
    if (!remove(targets).ok) process.exitCode = 1;
  }
  else await install(targets);
}

if (resolve(process.argv[1] || "") === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`Installation failed: ${err.message}`);
    process.exit(1);
  });
}
