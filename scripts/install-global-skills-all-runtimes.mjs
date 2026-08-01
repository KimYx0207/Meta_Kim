#!/usr/bin/env node
/**
 * Cross-runtime install: clone third-party skill repos into each runtime home.
 * Default: `skills/<id>/`. `pluginHookCompat: true` keeps the canonical tree in
 * `skills/<id>/` and adds `plugins/<id>` → `skills/<id>` for upstream hooks that
 * default to plugins/. Rare `installRoot: "plugins"` does the inverse (canonical
 * in plugins, `skills/<id>` alias). Optional `claude plugin install …` for
 * marketplace plugin bundles.
 *
 * Flags:
 *   --update          git pull / re-clone / re-run setup script for all skills
 *   --dry-run         print actions only
 *   --plugins-only    only run `claude plugin install` (no git clones)
 *   --skip-plugins    skip `claude plugin install` even if defaults apply
 *   --skills=id,...   install only these manifest skill ids (omit = all)
 *   --lang <code>     localize installer output (en, zh-CN, ja-JP, ko-KR)
 *   --prefer-local-dependencies
 *                     prefer local sibling dependency checkouts for testing
 *
 * Env (optional): META_KIM_CLAUDE_HOME, CLAUDE_HOME, META_KIM_CODEX_HOME,
 * CODEX_HOME, META_KIM_OPENCLAW_HOME, OPENCLAW_HOME, META_KIM_QODER_HOME,
 * QODER_HOME, META_KIM_SKILL_IDS, META_KIM_LOCAL_DEPENDENCY_ROOT
 */

import { execFileSync, execSync, spawnSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  detectPython310,
  extractPipShowVersion,
  parsePythonVersion,
  readProcessText,
  runPythonModule,
} from "./graphify-runtime.mjs";
import {
  resolveManifestSkillSubdir,
  shouldUseCliShell,
} from "./install-platform-config.mjs";
import {
  buildGitHubTarballUrl,
  classifyGitInstallFailure,
  shouldUseArchiveFallback,
  shouldUseArchiveFallbackForUnknownClone,
} from "./install-error-classifier.mjs";
import {
  CATEGORIES,
  manifestPathFor,
  readManifest,
} from "./install-manifest.mjs";
import {
  CODEX_REQUEST_USER_INPUT_FEATURE,
  ensureCodexAppNativeControls,
  mergeCodexConfigAddOnly,
} from "./codex-config-merge.mjs";
import {
  detectManagedInstallConflict,
  detectLegacySubdirInstall,
  detectPluginBundleSkillResidue,
  sanitizeInstalledSkillTree,
  validateSkillFrontmatter,
} from "./install-skill-sanitizer.mjs";
import { fileURLToPath } from "node:url";
import {
  parseSkillsArg,
  resolveTargetContext,
  resolveRuntimeHomeDir,
} from "./meta-kim-sync-config.mjs";
import { LANG, t } from "./meta-kim-i18n.mjs";
import {
  buildCodexHooksJson,
  buildCursorHooksJson,
  buildHookPromptAdapterSource,
} from "./runtime-hook-mapping.mjs";
import {
  MetaKimConfigError,
  loadMetaKimConfig,
} from "./meta-kim-config-loader.mjs";

// ── ANSI colors (matching setup.mjs) ─────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

// Deep amber colors matching setup.mjs logo
const AMBER = "\x1b[38;2;160;120;60m";
const AMBER_BRIGHT = "\x1b[38;2;200;160;80m";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const MAX_ARCHIVE_DOWNLOAD_BYTES = 64 * 1024 * 1024;
// Dependency skill archives are source/document bundles. These limits leave
// ample room for normal assets while failing closed on decompression bombs.
const MAX_ARCHIVE_MEMBERS = 10_000;
const MAX_ARCHIVE_MEMBER_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;

function quoteCliArgForShell(value) {
  const text = String(value);
  if (text === "") return '""';
  if (!/[^\w@%+=:,./\\-]/.test(text)) return text;
  return `"${text.replace(/(["^&|<>])/g, "^$1")}"`;
}

function spawnCliWithShellOptionSync(
  command,
  commandArgs = [],
  options = {},
  useShell = shouldUseCliShell(os.platform()),
) {
  if (useShell) {
    return spawnSync(
      [command, ...commandArgs].map(quoteCliArgForShell).join(" "),
      {
        ...options,
        shell: true,
      },
    );
  }
  return spawnSync(command, commandArgs, {
    ...options,
    shell: false,
  });
}

function spawnCliSync(command, commandArgs = [], options = {}) {
  return spawnCliWithShellOptionSync(
    command,
    commandArgs,
    options,
    shouldUseCliShell(os.platform()),
  );
}

function buildGlobalCapabilityInventoryArgs(activeTargets = [], language = LANG) {
  return [
    "--lang",
    language,
    "--runtime-inventory-only",
    "--targets",
    activeTargets.join(","),
  ];
}

function refreshGlobalCapabilityInventory(activeTargets = []) {
  if (dryRun) {
    console.log(
      `${C.dim}[dry-run] refresh global capability inventory (discover:global)${C.reset}`,
    );
    return true;
  }
  console.log(
    `\n${C.bold}${AMBER}${t.refreshGlobalCapabilityInventory ?? "Refreshing global capability inventory"}${C.reset}`,
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "discover-global-capabilities.mjs"),
      ...buildGlobalCapabilityInventoryArgs(activeTargets),
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      shell: false,
      env: { ...process.env, META_KIM_LANG: LANG },
    },
  );
  if (result.status === 0) {
    console.log(
      `${C.green}✓${C.reset} ${C.dim}${t.globalCapabilityInventoryRefreshed ?? "Global capability inventory refreshed"}${C.reset}`,
    );
    return true;
  }
  console.warn(
    `${C.yellow}⚠${C.reset} ${C.dim}${t.globalCapabilityInventoryRefreshFailed ?? "Global capability discovery failed; run `npm run discover:global` after install/update."}${C.reset}`,
  );
  return false;
}

const GRAPHIFY_GUIDE_TARGETS = {
  claude: "CLAUDE.md",
};

function guideAlreadyHasGraphifySection(platform) {
  const guideFile = GRAPHIFY_GUIDE_TARGETS[platform];
  if (!guideFile) return false;
  try {
    const content = readFileSync(path.join(repoRoot, guideFile), "utf8");
    return /^##\s+graphify\b/im.test(content);
  } catch {
    return false;
  }
}

const cliArgs = process.argv.slice(2);
const directInvocation = process.argv[1] === fileURLToPath(import.meta.url);
const INSTALLER_BOOLEAN_FLAGS = new Set([
  "--update",
  "--dry-run",
  "--plugins-only",
  "--skip-plugins",
  "--no-plugins",
  "--skip-inventory-refresh",
  "--prefer-local-dependencies",
]);
const INSTALLER_VALUE_FLAGS = new Set([
  "--targets",
  "--skills",
  "--scope",
  "--proxy",
  "--log-file",
  "--lang",
]);
const INSTALLER_LANGUAGE_VALUES = new Set([
  "en",
  "zh",
  "zh-CN",
  "ja",
  "ja-JP",
  "ko",
  "ko-KR",
]);

function validateInstallerLanguage(value) {
  if (!INSTALLER_LANGUAGE_VALUES.has(value)) {
    throw new Error(
      "--lang requires one of: en, zh, zh-CN, ja, ja-JP, ko, ko-KR",
    );
  }
}

function installerHelpText() {
  return [
    "Usage: node scripts/install-global-skills-all-runtimes.mjs [options]",
    "",
    "Options:",
    "  --update                    update installed skills",
    "  --targets <ids>             comma-separated runtime ids",
    "  --skills <ids>              comma-separated skill ids",
    "  --lang <code>               localize output (en, zh, zh-CN, ja, ja-JP, ko, ko-KR)",
    "  --dry-run                   print actions without writing",
    "  --plugins-only              install native plugin bundles only",
    "  --skip-plugins, --no-plugins",
    "  --skip-inventory-refresh",
    "  --prefer-local-dependencies  use local sibling dependency checkouts when present",
    "  --proxy <url>",
    "  --log-file <path>",
    "  -h, --help                  show this help without writing",
  ].join("\n");
}

function validateInstallerArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") continue;
    if (INSTALLER_BOOLEAN_FLAGS.has(arg)) continue;
    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    if (INSTALLER_VALUE_FLAGS.has(flag)) {
      if (equalsIndex !== -1) {
        const value = arg.slice(equalsIndex + 1);
        if (!value && flag !== "--skills") {
          throw new Error(`${flag} requires a value`);
        }
        if (flag === "--lang") validateInstallerLanguage(value);
        continue;
      }
      const value = argv[index + 1];
      if (
        value === undefined ||
        (value === "" && flag !== "--skills") ||
        (flag === "--lang" ? value.startsWith("-") : value.startsWith("--"))
      ) {
        throw new Error(`${flag} requires a value`);
      }
      if (flag === "--lang") validateInstallerLanguage(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown installer argument: ${arg}`);
  }
}

if (directInvocation) {
  validateInstallerArgs(cliArgs);
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    console.log(installerHelpText());
    process.exit(0);
  }
}

const preferLocalDependencies = cliArgs.includes("--prefer-local-dependencies");

function localDependencyRoots() {
  const roots = [];
  if (process.env.META_KIM_LOCAL_DEPENDENCY_ROOT) {
    roots.push(process.env.META_KIM_LOCAL_DEPENDENCY_ROOT);
  }
  roots.push(path.dirname(repoRoot));
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function repoNameFromFullName(repoFullName) {
  return String(repoFullName ?? "").split("/").filter(Boolean).at(-1) ?? null;
}

function resolveLocalDependencyRepo(repoFullName) {
  if (!preferLocalDependencies) return null;
  const repoName = repoNameFromFullName(repoFullName);
  if (!repoName) return null;
  for (const root of localDependencyRoots()) {
    const candidate = path.join(root, repoName);
    if (existsSync(path.join(candidate, ".git"))) {
      return candidate;
    }
  }
  return null;
}

const updateMode = process.argv.includes("--update");
const dryRun = process.argv.includes("--dry-run");
const pluginsOnly = process.argv.includes("--plugins-only");
const skipPlugins =
  process.argv.includes("--skip-plugins") ||
  process.argv.includes("--no-plugins");
const skipInventoryRefresh = process.argv.includes("--skip-inventory-refresh");
const installFailures = [];
const archiveFallbacks = [];
const repairedInstallRoots = [];
const sanitizedSkillIssues = [];

// ── Log file tee ───────────────────────────────────────────────────────────

/**
 * Parse --log-file <path> from CLI args.
 * Returns the log file path or null if not specified.
 */
function parseLogFileArg(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--log-file" && argv[i + 1] !== undefined) {
      return path.resolve(argv[i + 1]);
    }
    if (argv[i].startsWith("--log-file=")) {
      return path.resolve(argv[i].slice("--log-file=".length));
    }
  }
  return null;
}

/**
 * Set up a tee that writes all stdout/stderr to BOTH the terminal and a log file.
 * Returns the resolved log file path, or null if logging was not enabled.
 */
async function setupTeeStdout(logFilePath) {
  if (!logFilePath) return null;

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(logFilePath), { recursive: true });

  const logStream = createWriteStream(logFilePath, {
    flags: "w",
    encoding: "utf8",
  });

  // Tee wrapper: write to both the original destination and the log file
  function teeWrite(originalWrite, chunk) {
    const str =
      chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk);
    originalWrite(str);
    logStream.write(str);
  }

  // Replace stdout/stderr write methods with tee versions
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk, ...rest) => {
    teeWrite((s) => origStdoutWrite(s), chunk);
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    teeWrite((s) => origStderrWrite(s), chunk);
    return true;
  };

  // Also intercept console.log/error/warn by patching the underlying write
  // (already handled by stdout/stderr write override)

  return logFilePath;
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

/**
 * Returns a copy of process.env with all proxy-related vars removed.
 * Used for direct-connection fallback when proxy causes TLS failures.
 */
function buildEnvWithoutProxy() {
  const env = { ...process.env };
  for (const key of PROXY_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * Synchronous backoff for `runGit` retries. Must not rely on POSIX `sleep`:
 * Windows cmd has no `sleep`, so `spawnSync("sleep", …)` often fails and skips delay,
 * causing tight retry loops and apparent "hangs" under load.
 */
function sleepSyncMs(ms) {
  const safeMs = Math.max(0, Math.floor(Number(ms) || 0));
  if (safeMs === 0) {
    return;
  }
  try {
    if (process.platform === "win32") {
      execSync(
        `powershell -NoProfile -NonInteractive -Command "Start-Sleep -Milliseconds ${safeMs}"`,
        { stdio: "ignore", windowsHide: true },
      );
    } else {
      spawnSync("sleep", [String(safeMs / 1000)], {
        stdio: "ignore",
        shell: false,
      });
    }
  } catch {
    const end = Date.now() + safeMs;
    while (Date.now() < end) {
      // Subprocess sleep unavailable — last-resort wait
    }
  }
}

function isLoopbackProxyValue(value) {
  if (!value || typeof value !== "string") {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1"
    );
  } catch {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/i.test(
      value.trim(),
    );
  }
}

function stripInheritedLoopbackProxyEnv() {
  if (process.env.META_KIM_KEEP_LOOPBACK_PROXY === "1") {
    return [];
  }

  // Do NOT strip if user explicitly provided a proxy
  const cliHasProxy =
    process.argv.includes("--proxy") || !!process.env.META_KIM_GIT_PROXY;
  if (cliHasProxy) {
    return [];
  }

  const stripped = [];
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key];
    if (!isLoopbackProxyValue(value)) {
      continue;
    }
    stripped.push(`${key}=${value}`);
    delete process.env[key];
  }
  return stripped;
}

// ── Proxy resolution (must happen before strip) ──────────────────────────

function resolveGitProxy(args) {
  const cliIdx = args.indexOf("--proxy");
  if (cliIdx >= 0 && args[cliIdx + 1]) {
    let value = args[cliIdx + 1].trim();
    if (!value.includes("://")) {
      value = `http://${value}`;
    }
    return { url: value, source: "--proxy" };
  }

  if (process.env.META_KIM_GIT_PROXY) {
    let value = process.env.META_KIM_GIT_PROXY.trim();
    if (!value.includes("://")) {
      value = `http://${value}`;
    }
    return { url: value, source: "META_KIM_GIT_PROXY" };
  }

  return null;
}

// Resolve proxy BEFORE stripping — so META_KIM_GIT_PROXY is set first
const gitProxy = resolveGitProxy(cliArgs);

// If we have an explicit proxy, set META_KIM_GIT_PROXY so strip logic skips it
if (gitProxy) {
  process.env.META_KIM_GIT_PROXY = gitProxy.url;
}

// Now strip loopback proxies, but skip if META_KIM_GIT_PROXY is already set
const strippedLoopbackProxyEnv = stripInheritedLoopbackProxyEnv();

// Apply proxy to HTTP/HTTPS env for git (stdout line suppressed)
if (gitProxy) {
  process.env.HTTP_PROXY = gitProxy.url;
  process.env.HTTPS_PROXY = gitProxy.url;
} else if (strippedLoopbackProxyEnv.length > 0) {
  console.warn(`${C.yellow}⚠${C.reset} ${t.proxyStrippedHint}`);
}

// Session-level: direct-first path only — after proxy fallback succeeds once, skip proxy fallback on later ops.
let useDirectConnection = false;

/** User configured --proxy / META_KIM_GIT_PROXY: prefer that env for git (no misleading "direct failed" first). */
const preferGitProxyFirst = Boolean(gitProxy);

function loadInstallerConfig() {
  let config;
  try {
    config = loadMetaKimConfig({ repoRoot });
  } catch (error) {
    const prefix =
      error instanceof MetaKimConfigError
        ? `Meta_Kim configuration error [${error.code}]`
        : "Meta_Kim configuration error";
    console.error(`${prefix}: ${error.message}`);
    process.exit(2);
  }

  const skillRepos = config.skills.skills.map((skill) => {
    const localRepoPath = resolveLocalDependencyRepo(skill.repository.fullName);
    const subdir = resolveManifestSkillSubdir(skill, os.platform());
    return {
      ...skill,
      repo: skill.repository.cloneUrl,
      repoFullName: skill.repository.fullName,
      ...(localRepoPath ? { localRepoPath } : {}),
      ...(subdir ? { subdir } : {}),
    };
  });
  return { ...config, skillRepos };
}

function applySkillsIdFilter(skillRepos, filterIds) {
  const known = new Map(skillRepos.map((s) => [s.id.toLowerCase(), s]));
  const unknownIds = [];
  const picked = [];
  const seen = new Set();
  for (const raw of filterIds) {
    const hit = known.get(String(raw).toLowerCase());
    if (!hit) {
      unknownIds.push(raw);
      continue;
    }
    const key = hit.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(hit);
  }
  return { repos: picked, unknownIds };
}

const installerConfig = loadInstallerConfig();
let SKILL_REPOS = installerConfig.skillRepos;
function normalizeInstallerSkillsFilter(parsedSkills) {
  return parsedSkills;
}

const skillsArg = normalizeInstallerSkillsFilter(parseSkillsArg(cliArgs));
const skillsFilterActive = skillsArg !== null;
if (skillsArg !== null) {
  const { repos, unknownIds } = applySkillsIdFilter(SKILL_REPOS, skillsArg);
  for (const id of unknownIds) {
    console.warn(`${C.yellow}⚠${C.reset} ${t.skillsFilterUnknown(id)}`);
  }
  SKILL_REPOS = repos;
  if (skillsArg.length > 0 && unknownIds.length === skillsArg.length) {
    console.warn(`${C.yellow}⚠${C.reset} ${t.skillsFilterNoMatches}`);
  } else if (SKILL_REPOS.length === 0) {
    console.warn(`${C.yellow}⚠${C.reset} ${t.skillsFilterEmpty}`);
  }
}

let CLAUDE_PLUGIN_SPECS = SKILL_REPOS.map((s) => s.claudePlugin).filter(Boolean);
const logFileResolved = await setupTeeStdout(parseLogFileArg(cliArgs));

function loadGlobalManagedSkillPaths() {
  const manifest = readManifest(manifestPathFor("global"));
  return (manifest?.entries ?? [])
    .filter((entry) => entry.category === CATEGORIES.A && entry.kind === "dir")
    .map((entry) => entry);
}

const globalManagedSkillPaths = loadGlobalManagedSkillPaths();

function resolveHomes() {
  return {
    claude: resolveRuntimeHomeDir("claude"),
    codex: resolveRuntimeHomeDir("codex"),
    openclaw: resolveRuntimeHomeDir("openclaw"),
    cursor: resolveRuntimeHomeDir("cursor"),
    opencode: resolveRuntimeHomeDir("opencode"),
    qwen: resolveRuntimeHomeDir("qwen"),
    zed: resolveRuntimeHomeDir("zed"),
    gemini: resolveRuntimeHomeDir("gemini"),
    codebuddy: resolveRuntimeHomeDir("codebuddy"),
    antigravity: resolveRuntimeHomeDir("antigravity"),
    joycode: resolveRuntimeHomeDir("joycode"),
    qoder: resolveRuntimeHomeDir("qoder"),
  };
}

function resolveCompatibilitySkillRoots(runtimeId, primarySkillsRoot, spec) {
  if (runtimeId !== "codex" || spec?.id !== "meta-skill-creator") return [];
  return [primarySkillsRoot];
}

function resolveOsUserHome(userHome = os.homedir()) {
  return path.resolve(userHome);
}

/** Primary deploy segment under each runtime home: skills/ (default) or plugins/ (rare). */
function skillInstallRootSegment(spec) {
  if (spec.pluginHookCompat) {
    return "skills";
  }
  return spec.installRoot === "plugins" ? "plugins" : "skills";
}

function resolveSkillTargetDir(
  runtimeHome,
  spec,
  runtimeId = null,
  userHome = os.homedir(),
) {
  if (runtimeId === "codex" && spec.id === "meta-skill-creator") {
    return path.join(
      resolveOsUserHome(userHome),
      ".agents",
      "skills",
      spec.id,
    );
  }
  return path.join(runtimeHome, skillInstallRootSegment(spec), spec.id);
}

function usesGenericSkillInstall(spec) {
  return (
    !spec.claudePlugin &&
    spec.installMethod !== "pluginMarketplace" &&
    spec.installMethod !== "upstreamCli"
  );
}

/** Resolve a secondary compatibility target under a supplied skills root. */
function resolveCompatSkillTargetDir(legacySkillsRoot, spec) {
  if (skillInstallRootSegment(spec) === "plugins") {
    return path.join(path.dirname(legacySkillsRoot), "plugins", spec.id);
  }
  return path.join(legacySkillsRoot, spec.id);
}

function assertUnderHome(resolved) {
  const home = path.resolve(os.homedir());
  const abs = path.resolve(resolved);
  if (abs !== home && !abs.startsWith(`${home}${path.sep}`)) {
    throw new Error(`Refusing to write outside user home: ${abs}`);
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertRealPathContained(userHome, targetPath) {
  const lexicalHome = path.resolve(userHome);
  const lexicalTarget = path.resolve(targetPath);
  if (!isPathInside(lexicalHome, lexicalTarget)) {
    throw new Error(`Refusing path outside OS user home: ${lexicalTarget}`);
  }

  const realHome = await fs.realpath(lexicalHome).catch(() => lexicalHome);
  const relative = path.relative(lexicalHome, lexicalTarget);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = lexicalHome;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symlink or junction in managed path: ${current}`);
    }
    const realCurrent = await fs.realpath(current);
    if (!isPathInside(realHome, realCurrent)) {
      throw new Error(`Refusing managed path escape: ${current} -> ${realCurrent}`);
    }
  }
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDir(dirPath) {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.length === 0;
  } catch {
    return false;
  }
}

async function createSiblingStagingDir(targetDir, label = "staged") {
  const parentDir = path.dirname(targetDir);
  await fs.mkdir(parentDir, { recursive: true });
  return fs.mkdtemp(
    path.join(parentDir, `${path.basename(targetDir)}.${label}-`),
  );
}

function isWindowsLockError(error) {
  const code = error?.code || "";
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Recursive delete with short async retries. Windows often returns EPERM/EBUSY when
 * Defender, search indexer, or antivirus holds transient handles under a staging dir.
 */
async function rmDirWithRetry(dirPath, { retries = 6 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      lastErr = error;
      if (!isWindowsLockError(error)) {
        throw error;
      }
      await delayMs(120 * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Best-effort delete for staging clean-up: does not throw on Windows lock errors
 * after retries (logs warnStagingLocked). Prevents a successful skill deploy from
 * being reported as a global failure when only the sibling `.staged-*` folder is locked.
 */
async function rmDirBestEffortLocked(dirPath) {
  try {
    await rmDirWithRetry(dirPath, { retries: 8 });
  } catch (error) {
    if (isWindowsLockError(error)) {
      console.warn(`${C.yellow}⚠${C.reset} ${t.warnStagingLocked(dirPath)}`);
      return;
    }
    throw error;
  }
}

async function replaceTargetDir(targetDir, stagedDir) {
  const parentDir = path.dirname(targetDir);
  const targetExists = await pathExists(targetDir);

  // No existing target — simple rename, always safe
  if (!targetExists) {
    await fs.rename(stagedDir, targetDir);
    return;
  }

  // Existing target — try atomic rename via backup
  const backupDir = path.join(
    parentDir,
    `${path.basename(targetDir)}.backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let oldMoved = false;

  try {
    await fs.rename(targetDir, backupDir);
    oldMoved = true;
  } catch (error) {
    if (!isWindowsLockError(error)) throw error;
    // Target directory locked (Windows EPERM/EBUSY) — keep old in place,
    // fall through to copy-overwrite fallback
  }

  if (oldMoved) {
    try {
      await fs.rename(stagedDir, targetDir);
      await rmDirWithRetry(backupDir);
      return;
    } catch (error) {
      // Restore old target before falling back
      if (!(await pathExists(targetDir)) && (await pathExists(backupDir))) {
        await fs.rename(backupDir, targetDir).catch(() => {});
      }
      if (!isWindowsLockError(error)) throw error;
      // Fall through to copy fallback
    }
  }

  // Copy fallback: Windows locks may prevent directory rename but allow
  // file-level deletes.  Clear the target first so stale old files don't
  // mix with the new sparse-checkout content.
  try {
    const entries = await fs.readdir(targetDir);
    for (const entry of entries) {
      await fs
        .rm(path.join(targetDir, entry), { recursive: true, force: true })
        .catch(() => {});
    }
  } catch {
    // Best-effort cleanup — locked entries will remain but cp force overwrites
  }
  await fs.mkdir(targetDir, { recursive: true });
  await fs.cp(stagedDir, targetDir, { recursive: true, force: true });
  await rmDirBestEffortLocked(stagedDir);
  if (oldMoved) {
    await rmDirWithRetry(backupDir);
  }
}

async function directoryContentEqual(leftDir, rightDir) {
  let leftEntries;
  let rightEntries;
  try {
    [leftEntries, rightEntries] = await Promise.all([
      fs.readdir(leftDir, { withFileTypes: true }),
      fs.readdir(rightDir, { withFileTypes: true }),
    ]);
  } catch {
    return false;
  }
  const sortEntries = (entries) => [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const left = sortEntries(leftEntries);
  const right = sortEntries(rightEntries);
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (leftEntry.name !== rightEntry.name) return false;
    const leftPath = path.join(leftDir, leftEntry.name);
    const rightPath = path.join(rightDir, rightEntry.name);
    if (leftEntry.isDirectory() && rightEntry.isDirectory()) {
      if (!(await directoryContentEqual(leftPath, rightPath))) return false;
      continue;
    }
    if (leftEntry.isFile() && rightEntry.isFile()) {
      const [leftBytes, rightBytes] = await Promise.all([
        fs.readFile(leftPath),
        fs.readFile(rightPath),
      ]);
      if (!leftBytes.equals(rightBytes)) return false;
      continue;
    }
    return false;
  }
  return true;
}

const MAX_CONCURRENT_CLONES = 3;

function createConcurrencyLimiter(maxConcurrency) {
  const queue = [];
  let running = 0;

  function drain() {
    while (queue.length > 0 && running < maxConcurrency) {
      running++;
      const { task, resolve, reject } = queue.shift();
      Promise.resolve()
        .then(() => task())
        .then(resolve, reject)
        .finally(() => {
          running--;
          drain();
        });
    }
  }

  return function limit(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      drain();
    });
  };
}

async function repairManagedSkillTarget({
  skillId,
  targetDir,
  subdirPath,
  allowDelete = true,
}) {
  if (!(await pathExists(targetDir))) {
    return { repaired: false };
  }

  const conflict = await detectManagedInstallConflict(targetDir, {
    subdirPath,
    manifestManagedPaths: updateMode ? globalManagedSkillPaths : [],
  });
  if (!conflict.conflict) {
    return { repaired: false };
  }

  repairedInstallRoots.push({
    skillId,
    targetDir,
    subdirPath,
    reason: conflict.reason,
    action: allowDelete ? "reinstall" : "sanitize_only",
  });

  if (!allowDelete) {
    return {
      repaired: false,
      conflictDetected: true,
      legacyDetected: conflict.reason === "legacy_subdir_install",
      reason: conflict.reason,
    };
  }

  console.warn(
    conflict.reason === "legacy_subdir_install"
      ? `${C.yellow}⚠${C.reset} ${t.warnRepairLegacyLayout(skillId, targetDir)}`
      : `${C.yellow}⚠${C.reset} ${skillId}: replacing managed install conflict (${conflict.reason}) at ${targetDir}`,
  );
  if (dryRun) {
    console.log(
      t.dryRun(`Replace malformed install during reinstall: ${targetDir}`),
    );
  }
  return {
    repaired: true,
    conflictDetected: true,
    legacyDetected: conflict.reason === "legacy_subdir_install",
    reason: conflict.reason,
  };
}

async function sanitizeManagedSkillTarget(skillId, targetDir) {
  if (!(await pathExists(targetDir))) {
    return;
  }

  const result = await sanitizeInstalledSkillTree(targetDir, { dryRun });

  // Log hook path fixes unless marked silent (expected upstream vs install-layout normalization)
  if (result.hookPathFixes && result.hookPathFixes.length > 0) {
    for (const patch of result.hookPathFixes) {
      for (const fix of patch.fixes) {
        if (fix.silent) {
          continue;
        }
        console.warn(
          `${C.yellow}⚠${C.reset} ${C.bold}${skillId}${C.reset}: hook path auto-patched — ${fix.reason}`,
        );
        if (dryRun) {
          console.warn(`${C.dim}  would replace: ${fix.replaced}${C.reset}`);
          console.warn(`${C.dim}  with:        ${fix.with}${C.reset}`);
        }
      }
    }
  }

  if (result.quarantined === 0) {
    return;
  }

  sanitizedSkillIssues.push({
    skillId,
    targetDir,
    ...result,
  });

  for (const issue of result.invalidFiles) {
    const detail = path.relative(targetDir, issue.filePath).replace(/\\/g, "/");
    if (dryRun) {
      console.warn(
        `${C.yellow}⚠${C.reset} ${t.warnQuarantineDryRun(skillId, detail)}`,
      );
      continue;
    }

    console.warn(
      `${C.yellow}⚠${C.reset} ${t.warnQuarantined(skillId, detail)}`,
    );
  }
}

async function sanitizeCompatibilityRoots(runtimeId, primarySkillsRoot, spec) {
  const extraRoots = resolveCompatibilitySkillRoots(
    runtimeId,
    primarySkillsRoot,
    spec,
  );
  for (const extraRoot of extraRoots) {
    const targetDir = resolveCompatSkillTargetDir(extraRoot, spec);
    if (!(await pathExists(targetDir))) {
      continue;
    }

    // Detect legacy full-repo clone or stale empty directory
    const isLegacy =
      spec.subdir && (await detectLegacySubdirInstall(targetDir, spec.subdir));
    const targetEmpty = await isEmptyDir(targetDir);
    if (isLegacy || targetEmpty) {
      // Reinstall with proper sparse checkout — installGitSkillFromSubdir
      // handles its own repairManagedSkillTarget + replaceTargetDir logic
      console.warn(
        `${C.yellow}⚠${C.reset} ${t.warnRepairLegacySharedRoot(targetDir)}`,
      );
      if (spec.subdir) {
        await installGitSkillFromSubdir(
          spec.id,
          targetDir,
          spec.repo,
          spec.subdir,
        );
      } else {
        await installGitSkill(spec.id, targetDir, spec.repo);
      }
    } else {
      await sanitizeManagedSkillTarget(spec.id, targetDir);
    }
    await ensureHookLayoutAliases(path.dirname(extraRoot), spec);
  }
}

async function validateMetaSkillCreatorPackage(rootDir) {
  const rootStat = await fs.lstat(rootDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Invalid meta-skill-creator package root: ${rootDir}`);
  }
  const skillPath = path.join(rootDir, "SKILL.md");
  const skillStat = await fs.lstat(skillPath);
  if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
    throw new Error("meta-skill-creator requires a regular SKILL.md");
  }
  const skillContent = await fs.readFile(skillPath, "utf8");
  const frontmatter = validateSkillFrontmatter(skillContent);
  if (!frontmatter.ok || !/^name:\s*meta-skill-creator\s*$/im.test(skillContent)) {
    throw new Error(
      `Invalid meta-skill-creator SKILL.md: ${frontmatter.message}`,
    );
  }

  async function rejectLinks(currentDir) {
    for (const entry of await fs.readdir(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`meta-skill-creator package contains a link: ${entryPath}`);
      }
      if (stat.isDirectory()) await rejectLinks(entryPath);
    }
  }
  await rejectLinks(rootDir);
}

async function transactionalReplaceMetaSkillTargets(
  sourceDir,
  targets,
  {
    userHome = os.homedir(),
    failCommitAfter = 0,
    failRollbackTarget = null,
  } = {},
) {
  await validateMetaSkillCreatorPackage(sourceDir);
  for (const target of targets) {
    await assertRealPathContained(userHome, target);
  }

  const prepared = [];
  const backups = [];
  const installed = [];
  let committed = false;
  try {
    // Prepare and validate every target before mutating either live root.
    for (const target of targets) {
      const staged = await createSiblingStagingDir(target, "transaction");
      await assertRealPathContained(userHome, staged);
      await fs.cp(sourceDir, staged, { recursive: true, force: true });
      await validateMetaSkillCreatorPackage(staged);
      prepared.push({ target, staged });
    }

    for (const { target } of prepared) {
      await assertRealPathContained(userHome, target);
      if (!(await pathExists(target))) continue;
      const backup = path.join(
        path.dirname(target),
        `${path.basename(target)}.transaction-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      await fs.rename(target, backup);
      backups.push({ target, backup });
    }

    for (const item of prepared) {
      await assertRealPathContained(userHome, item.target);
      await fs.rename(item.staged, item.target);
      installed.push(item.target);
      if (failCommitAfter > 0 && installed.length === failCommitAfter) {
        throw new Error(`Injected commit failure after target ${failCommitAfter}`);
      }
    }
    for (const target of installed) {
      await validateMetaSkillCreatorPackage(target);
    }
    committed = true;
  } catch (error) {
    const recoveryErrors = [];
    if (!committed) {
      for (const target of installed.reverse()) {
        try {
          await fs.rm(target, { recursive: true, force: true });
          if (await pathExists(target)) {
            throw new Error(`new target still exists after rollback removal: ${target}`);
          }
        } catch (recoveryError) {
          recoveryErrors.push(
            new Error(`failed to remove new target ${target}: ${recoveryError.message}`),
          );
        }
      }
      for (const { target, backup } of backups.reverse()) {
        try {
          if (failRollbackTarget && path.resolve(target) === path.resolve(failRollbackTarget)) {
            throw new Error("Injected rollback restore failure");
          }
          if (!(await pathExists(backup))) {
            throw new Error(`recovery backup is missing: ${backup}`);
          }
          if (await pathExists(target)) {
            throw new Error(`live target blocks recovery: ${target}`);
          }
          await fs.rename(backup, target);
          if (!(await pathExists(target)) || (await pathExists(backup))) {
            throw new Error(`recovery verification failed: ${backup} -> ${target}`);
          }
          await validateMetaSkillCreatorPackage(target);
        } catch (recoveryError) {
          recoveryErrors.push(
            new Error(
              `failed to restore ${target} from recovery backup ${backup}: ${recoveryError.message}`,
            ),
          );
        }
      }
    }
    if (recoveryErrors.length > 0) {
      const recoveryPaths = backups
        .filter(({ backup }) => existsSync(backup))
        .map(({ backup }) => backup);
      throw new AggregateError(
        [error, ...recoveryErrors],
        `meta-skill-creator transaction failed and recovery was incomplete; recovery backups: ${recoveryPaths.join(", ") || "none"}; recovery errors: ${recoveryErrors.map((item) => item.message).join(" | ")}`,
      );
    }
    throw error;
  } finally {
    for (const { staged } of prepared) {
      if (await pathExists(staged)) {
        await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
  for (const { backup } of backups) {
    await rmDirBestEffortLocked(backup);
  }
}

function testMetaSkillSourceDir() {
  if (
    process.env.META_KIM_ALLOW_TEST_FIXTURES === "1" &&
    process.env.META_KIM_TEST_META_SKILL_SOURCE_DIR
  ) {
    return path.resolve(process.env.META_KIM_TEST_META_SKILL_SOURCE_DIR);
  }
  return null;
}

function testMetaSkillTransactionFaults(targets) {
  if (process.env.META_KIM_ALLOW_TEST_FIXTURES !== "1") return {};
  const failCommitAfter = Number.parseInt(
    process.env.META_KIM_TEST_FAIL_COMMIT_AFTER ?? "0",
    10,
  );
  const rollbackIndex = Number.parseInt(
    process.env.META_KIM_TEST_FAIL_ROLLBACK_TARGET_INDEX ?? "-1",
    10,
  );
  return {
    failCommitAfter: Number.isFinite(failCommitAfter) ? failCommitAfter : 0,
    failRollbackTarget:
      rollbackIndex >= 0 && rollbackIndex < targets.length
        ? targets[rollbackIndex]
        : null,
  };
}

async function installMetaSkillCreatorAcrossRuntimes(
  runtimeHomes,
  activeTargets,
  spec,
  { sourceDir = testMetaSkillSourceDir(), userHome = os.homedir() } = {},
) {
  const targets = [];
  if (activeTargets.includes("claude") && spec.targets?.includes("claude")) {
    targets.push(path.join(runtimeHomes.claude, "skills", spec.id));
  }
  if (activeTargets.includes("codex") && spec.targets?.includes("codex")) {
    targets.push(
      resolveSkillTargetDir(runtimeHomes.codex, spec, "codex", userHome),
      path.join(runtimeHomes.codex, "skills", spec.id),
    );
  }
  if (targets.length === 0) return;
  for (const target of targets) {
    await assertRealPathContained(userHome, target);
  }
  if (dryRun) {
    for (const target of targets) {
      console.log(t.dryRun(`install ${spec.id}: ${target}`));
    }
    return;
  }

  const sourceStage = await createSiblingStagingDir(targets[0], "source");
  try {
    await assertRealPathContained(userHome, sourceStage);
    if (sourceDir) {
      await fs.cp(sourceDir, sourceStage, { recursive: true, force: true });
    } else if (spec.subdir) {
      await installGitSkillFromSubdir(
        spec.id,
        sourceStage,
        spec.repo,
        spec.subdir,
      );
    } else {
      await installGitSkill(spec.id, sourceStage, spec.repo);
    }
    await validateMetaSkillCreatorPackage(sourceStage);
    await transactionalReplaceMetaSkillTargets(sourceStage, targets, {
      userHome,
      ...testMetaSkillTransactionFaults(targets),
    });
  } finally {
    await fs.rm(sourceStage, { recursive: true, force: true }).catch(() => {});
  }
}

function runGit(args, opts = {}) {
  if (dryRun) {
    console.log(t.dryRun(`git ${args.join(" ")}`));
    return { status: 0, stdout: "", stderr: "" };
  }
  const maxRetries = opts.retries ?? 3;
  const skillLabel = opts.skillLabel || args.join(" ");
  const hasProxy = !!(process.env.HTTP_PROXY || process.env.HTTPS_PROXY);

  for (let attempt = 1; ; attempt++) {
    // Explicit git proxy: use it first. Otherwise try direct first, then proxy fallback.
    const gitEnv =
      preferGitProxyFirst && hasProxy ? process.env : buildEnvWithoutProxy();
    const result = spawnSync("git", args, {
      encoding: "utf8",
      shell: false,
      stdio: "pipe",
      env: gitEnv,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    if (result.status === 0) {
      if (!opts.cwd) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
      return result;
    }
    const error = new Error(`git ${args.join(" ")} failed`);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    const category = classifyGitInstallFailure(error);
    const isRetryable =
      category === "tls_transport" || category === "proxy_network";

    // Direct-first failed — if proxy is available, try once with proxy as fallback
    if (
      !preferGitProxyFirst &&
      isRetryable &&
      hasProxy &&
      !useDirectConnection
    ) {
      console.warn(
        `${C.yellow}⚠${C.reset} ${t.proxyFallbackProxy(skillLabel)}`,
      );
      const proxyResult = spawnSync("git", args, {
        encoding: "utf8",
        shell: false,
        stdio: "pipe",
        env: process.env,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
      if (proxyResult.status === 0) {
        console.log(
          `${C.green}✓${C.reset} ${t.proxyFallbackProxySuccess(skillLabel)}`,
        );
        useDirectConnection = true;
        if (!opts.cwd) {
          if (proxyResult.stdout) process.stdout.write(proxyResult.stdout);
          if (proxyResult.stderr) process.stderr.write(proxyResult.stderr);
        }
        return proxyResult;
      }
      // Proxy also failed — fall through to normal retry logic
    }

    if (!isRetryable || attempt >= maxRetries) {
      if (!opts.cwd) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
      throw error;
    }
    const delay = attempt * 2000;
    // Retries before max: stay quiet (TLS/proxy flakes are expected); still backoff.
    sleepSyncMs(delay);
  }
}

function formatBytesBin(n) {
  if (n <= 0 || !Number.isFinite(n)) {
    return "0 B";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ["KiB", "MiB", "GiB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function sumGitPackBytes(cloneRoot) {
  const packDir = path.join(cloneRoot, ".git", "objects", "pack");
  try {
    const entries = await fs.readdir(packDir, { withFileTypes: true });
    let sum = 0;
    for (const e of entries) {
      if (!e.isFile()) {
        continue;
      }
      const st = await fs.stat(path.join(packDir, e.name));
      sum += st.size;
    }
    return sum;
  } catch {
    return 0;
  }
}

/**
 * Last "Receiving objects" / "Resolving deltas" line from git --progress (EN/zh).
 * Note: high % here does **not** mean the clone finished successfully — git may still
 * fail afterward (checkout, deltas, TLS); trust exit code + stderr, not this alone.
 */
function parseGitProgress(stderrText) {
  const re =
    /(?:Receiving objects|接收对象|Resolving deltas|解析增量)\s*:\s*(\d+)%\s*\((\d+)\/(\d+)\)/gi;
  let last = null;
  let m;
  while ((m = re.exec(stderrText)) !== null) {
    last = {
      pct: Number(m[1]),
      cur: Number(m[2]),
      tot: Number(m[3]),
    };
  }
  return last;
}

function formatCloneHudLine(skillId, bytes, est, recv) {
  const curStr = formatBytesBin(bytes);
  if (recv && recv.tot > 0) {
    const totStr = est != null && est > 0 ? formatBytesBin(est) : "…";
    return t.cloneProgressLine(
      skillId,
      curStr,
      totStr,
      recv.pct,
      recv.cur,
      recv.tot,
    );
  }
  if (bytes > 0) {
    return t.cloneProgressLinePartial(skillId, curStr);
  }
  return "";
}

function startCloneProgressHud(skillId, rootPath, getStderrText) {
  let stopped = false;
  let lastPrinted = "";

  async function emitOnce() {
    const recv = parseGitProgress(getStderrText());
    const bytes = await sumGitPackBytes(rootPath);
    if (bytes === 0 && !recv) {
      return;
    }
    let est = null;
    if (recv && recv.cur > 0 && recv.tot >= recv.cur) {
      est = Math.round((bytes * recv.tot) / recv.cur);
    } else if (recv && recv.pct > 0 && recv.pct < 100 && bytes > 0) {
      est = Math.round((bytes * 100) / recv.pct);
    }
    const line = formatCloneHudLine(skillId, bytes, est, recv);
    if (!line || line === lastPrinted) {
      return;
    }
    lastPrinted = line;
    console.log(`${C.dim}${line}${C.reset}`);
  }

  const interval = setInterval(() => {
    if (!stopped) {
      void emitOnce();
    }
  }, 450);
  return () => {
    stopped = true;
    clearInterval(interval);
    void emitOnce();
  };
}

/**
 * Async git execution — non-blocking spawn, supports true parallel downloads.
 * Strategy: with explicit --proxy / META_KIM_GIT_PROXY, use proxy env first; else try direct first, then proxy fallback.
 */
function runGitAsync(args, opts = {}) {
  const maxRetries = opts.retries ?? 3;
  const skillLabel = opts.skillLabel || args.join(" ");
  const hasProxy = !!(process.env.HTTP_PROXY || process.env.HTTPS_PROXY);
  const useCloneHud = Boolean(opts.cloneProgress);
  /** Stream git stderr live (e.g. clone --progress). Suppressed when clone HUD is active. */
  const liveStderr = opts.liveStderr === true && !useCloneHud;

  return new Promise((resolve, reject) => {
    if (dryRun) {
      console.log(t.dryRun(`git ${args.join(" ")}`));
      resolve({ status: 0, stdout: "", stderr: "" });
      return;
    }

    let attempt = 0;

    // Helper: spawn git with explicit env
    function spawnGit(envOverride) {
      const spawnOpts = {
        shell: false,
        env: envOverride ?? buildEnvWithoutProxy(),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      };
      const proc = spawn("git", args, spawnOpts);
      let stdout = "";
      let stderr = "";
      let stopHud = null;
      if (useCloneHud && opts.cloneProgress) {
        const { skillId, rootPath } = opts.cloneProgress;
        stopHud = startCloneProgressHud(skillId, rootPath, () => stderr);
      }
      proc.stdout?.on("data", (d) => {
        stdout += d;
      });
      proc.stderr?.on("data", (d) => {
        const chunk = d.toString();
        stderr += chunk;
        if (liveStderr) {
          process.stderr.write(d);
        }
      });
      return new Promise((res, rej) => {
        proc.on("close", (code) => {
          if (stopHud) {
            stopHud();
          }
          if (code === 0) {
            res({ status: 0, stdout, stderr });
          } else {
            const err = new Error(`git ${args.join(" ")} failed`);
            err.status = code;
            err.stdout = stdout;
            err.stderr = stderr;
            rej(err);
          }
        });
        proc.on("error", (err) => {
          rej(new Error(`git ${args.join(" ")} spawn error: ${err.message}`));
        });
      });
    }

    async function tryOnce() {
      attempt++;
      // Remove partial clone output before retry — otherwise git fails with
      // "destination path already exists" (classified as unknown) and masks TLS/network.
      if (attempt > 1 && args[0] === "clone") {
        const dest = args[args.length - 1];
        if (
          typeof dest === "string" &&
          !/^https?:\/\//i.test(dest) &&
          !dest.startsWith("--")
        ) {
          try {
            await fs.rm(dest, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }
      }
      try {
        const result = await spawnGit(
          preferGitProxyFirst && hasProxy ? process.env : undefined,
        );
        resolve(result);
      } catch (error) {
        const category = classifyGitInstallFailure(error);
        const isRetryable =
          category === "tls_transport" ||
          category === "proxy_network" ||
          category === "unknown";

        // Direct-first failed — if proxy is available, try once with proxy
        if (
          !preferGitProxyFirst &&
          isRetryable &&
          hasProxy &&
          !useDirectConnection
        ) {
          console.warn(
            `${C.yellow}⚠${C.reset} ${t.proxyFallbackProxy(skillLabel)}`,
          );
          try {
            const proxyResult = await spawnGit(process.env);
            console.log(
              `${C.green}✓${C.reset} ${t.proxyFallbackProxySuccess(skillLabel)}`,
            );
            useDirectConnection = true;
            resolve(proxyResult);
            return;
          } catch {
            // Proxy also failed — fall through to normal retry logic
          }
        }

        if (!isRetryable || attempt >= maxRetries) {
          reject(error);
        } else {
          const delay = attempt * 2000;
          // Retries before max: no WARN spam; handleGitFailure / archive path log real failures.
          setTimeout(tryOnce, delay);
        }
      }
    }

    tryOnce();
  });
}

function recordInstallFailure(details) {
  installFailures.push(details);
}

function resolveArchiveLimit(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function validateArchiveMembers(archivePath, limits = {}) {
  const python = detectPython310();
  if (!python) {
    throw new Error(
      "Archive fallback requires Python 3.10+ to validate members before extraction",
    );
  }
  const maxMembers = resolveArchiveLimit(
    limits.maxMembers,
    MAX_ARCHIVE_MEMBERS,
    "maxMembers",
  );
  const maxMemberBytes = resolveArchiveLimit(
    limits.maxMemberBytes,
    MAX_ARCHIVE_MEMBER_UNCOMPRESSED_BYTES,
    "maxMemberBytes",
  );
  const maxTotalBytes = resolveArchiveLimit(
    limits.maxTotalBytes,
    MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES,
    "maxTotalBytes",
  );
  const validator = [
    "import re, sys, tarfile",
    "archive = sys.argv[1]",
    "max_members, max_member_bytes, max_total_bytes = map(int, sys.argv[2:5])",
    "def safe_parts(value, label):",
    "    text = value.replace('\\\\', '/')",
    "    if not text or text.startswith('/') or text.startswith('//') or re.match(r'^[A-Za-z]:', text):",
    "        raise RuntimeError(f'unsafe {label}: {value!r}')",
    "    parts = []",
    "    for part in text.split('/'):",
    "        if part in ('', '.'):",
    "            continue",
    "        if part == '..':",
    "            raise RuntimeError(f'unsafe {label}: {value!r}')",
    "        parts.append(part)",
    "    if not parts:",
    "        raise RuntimeError(f'unsafe {label}: {value!r}')",
    "    return parts",
    "member_count = 0",
    "total_size = 0",
    "with tarfile.open(archive, 'r:gz') as tf:",
    "    for member in tf:",
    "        member_count += 1",
    "        if member_count > max_members:",
    "            raise RuntimeError(f'archive member count exceeds limit: {member_count} > {max_members}')",
    "        member_size = max(0, int(member.size or 0))",
    "        if member_size > max_member_bytes:",
    "            raise RuntimeError(f'archive member exceeds uncompressed size limit: {member.name!r} ({member_size} > {max_member_bytes})')",
    "        total_size += member_size",
    "        if total_size > max_total_bytes:",
    "            raise RuntimeError(f'archive total uncompressed size exceeds limit: {total_size} > {max_total_bytes}')",
    "        safe_parts(member.name, 'archive member path')",
    "        if member.issym() or member.islnk():",
    "            safe_parts(member.linkname, 'archive link target')",
    "            raise RuntimeError('archive links are not allowed')",
    "        if not (member.isdir() or member.isreg()):",
    "            raise RuntimeError(f'unsupported archive member type: {member.name!r}')",
    "if member_count == 0:",
    "    raise RuntimeError('archive contains no members')",
  ].join("\n");
  execFileSync(
    python.command,
    [
      ...python.args,
      "-c",
      validator,
      archivePath,
      String(maxMembers),
      String(maxMemberBytes),
      String(maxTotalBytes),
    ],
    { stdio: "pipe" },
  );
}

async function readResponseBodyBounded(
  response,
  maxBytes = MAX_ARCHIVE_DOWNLOAD_BYTES,
) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(
      `Archive download exceeds ${maxBytes} byte limit (content-length ${declaredLength})`,
    );
  }
  if (!response.body) {
    throw new Error("Archive fallback response has no body");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("archive size limit exceeded").catch(() => {});
        throw new Error(`Archive download exceeds ${maxBytes} byte limit`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function replaceArchiveTargetAtomically(targetDir, stagedDir) {
  const parentDir = path.dirname(targetDir);
  const backupDir = path.join(
    parentDir,
    `${path.basename(targetDir)}.archive-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let movedExisting = false;
  await fs.mkdir(parentDir, { recursive: true });
  if (await pathExists(targetDir)) {
    await fs.rename(targetDir, backupDir);
    movedExisting = true;
  }
  try {
    await fs.rename(stagedDir, targetDir);
  } catch (error) {
    if (movedExisting && !(await pathExists(targetDir))) {
      await fs.rename(backupDir, targetDir).catch(() => {});
    }
    throw error;
  }
  if (movedExisting) {
    await rmDirBestEffortLocked(backupDir);
  }
}

async function extractArchiveInto(
  targetDir,
  archivePath,
  subdirPath,
  sourceMetadata = null,
) {
  const extractDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "meta-kim-archive-"),
  );
  const stagedTargetDir = await createSiblingStagingDir(targetDir, "archive");
  try {
    if (dryRun) {
      console.log(t.dryRun(`tar -xzf ${archivePath} -C ${extractDir}`));
    } else {
      // Validate every member before native tar can create any filesystem entry.
      // Links are rejected entirely because an otherwise in-root link can still
      // be used as a write-through pivot by a later archive member.
      validateArchiveMembers(archivePath);
      // Use relative archive name + cwd to avoid Windows tar
      // misinterpreting "C:\path" as a remote host (colon syntax).
      try {
        execFileSync(
          "tar",
          ["-xzf", path.basename(archivePath), "-C", extractDir],
          {
            cwd: path.dirname(archivePath),
            stdio: "pipe",
          },
        );
      } catch (nativeTarError) {
        const python = detectPython310();
        if (!python) throw nativeTarError;
        const safeExtract = [
          "import sys, tarfile",
          "archive, target = sys.argv[1], sys.argv[2]",
          "with tarfile.open(archive, 'r:gz') as tf:",
          "    tf.extractall(target)",
        ].join("\n");
        execFileSync(
          python.command,
          [...python.args, "-c", safeExtract, archivePath, extractDir],
          { stdio: "pipe" },
        );
      }
    }

    const entries = await fs.readdir(extractDir, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) {
      throw new Error(
        `Archive extraction must produce exactly one root directory: ${archivePath}`,
      );
    }
    const rootEntry = entries[0];

    const rootDir = path.join(extractDir, rootEntry.name);
    const sourceDir = subdirPath
      ? path.join(rootDir, ...subdirPath.split("/").filter(Boolean))
      : rootDir;
    if (!(await pathExists(sourceDir))) {
      throw new Error(`Archive fallback missing subdir: ${sourceDir}`);
    }

    await fs.cp(sourceDir, stagedTargetDir, { recursive: true, force: true });
    if (sourceMetadata) {
      await fs.writeFile(
        path.join(stagedTargetDir, ".meta-kim-source.json"),
        `${JSON.stringify({ ...sourceMetadata, rootName: rootEntry.name }, null, 2)}\n`,
        "utf8",
      );
    }
    await replaceArchiveTargetAtomically(targetDir, stagedTargetDir);
    return { rootName: rootEntry.name };
  } finally {
    await fs.rm(extractDir, { recursive: true, force: true });
    if (await pathExists(stagedTargetDir)) {
      await rmDirBestEffortLocked(stagedTargetDir);
    }
  }
}

async function installViaArchiveFallback({
  skillId,
  targetDir,
  displayTargetDir = targetDir,
  repoUrl,
  subdirPath,
  category,
  failureText,
}) {
  const archiveUrl = buildGitHubTarballUrl(repoUrl);
  if (!archiveUrl) {
    throw new Error(
      `Archive fallback only supports GitHub HTTPS remotes: ${repoUrl}`,
    );
  }

  const response = await fetch(archiveUrl, {
    headers: {
      "user-agent": "meta-kim/2.0",
      accept: "application/vnd.github+json",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `Archive fallback HTTP ${response.status} for ${archiveUrl}`,
    );
  }

  const archivePath = path.join(
    os.tmpdir(),
    `meta-kim-${Date.now()}-${path.basename(targetDir)}.tar.gz`,
  );
  try {
    const buffer = await readResponseBodyBounded(response);
    await fs.writeFile(archivePath, buffer);
    await extractArchiveInto(targetDir, archivePath, subdirPath, {
        source: "github_archive_fallback",
        requestedUrl: archiveUrl,
        resolvedUrl: response.url,
    });
    archiveFallbacks.push({ skillId, targetDir: displayTargetDir, category });
    console.warn(
      `${C.yellow}⚠${C.reset} ${t.warnArchiveFallback(skillId, category)}`,
    );
    console.log(
      `${C.green}✓${C.reset} ${t.okArchiveInstalled(displayTargetDir)}`,
    );
  } catch (error) {
    recordInstallFailure({
      skillId,
      targetDir: displayTargetDir,
      repoUrl,
      category,
      failureText,
      fallback: "archive",
      reason: error.message,
    });
    console.warn(
      `${C.yellow}⚠${C.reset} ${t.warnArchiveFailed(skillId, category, error.message)}`,
    );
  } finally {
    await fs.rm(archivePath, { force: true });
  }
}

/**
 * True if `dir` resolves a valid HEAD (clone/checkout may be usable even when git exited non-zero).
 */
function isGitWorkTreeReady(dir) {
  if (!dir || !existsSync(dir)) return false;
  const r = spawnSync(
    "git",
    ["-C", dir, "rev-parse", "-q", "--verify", "HEAD"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20_000,
    },
  );
  return r.status === 0;
}

/**
 * Print exit code + stderr tail so the **concrete** git error is visible (not inferred from progress UI).
 */
function logGitFailureRawDetails(skillId, displayTargetDir, error) {
  console.warn(
    `${C.yellow}⚠${C.reset} ${C.bold}${skillId}${C.reset} ${C.dim}→ ${displayTargetDir}${C.reset}`,
  );
  const code = error?.status;
  console.warn(`${C.dim}${t.gitFailureExitLine(code ?? "?")}${C.reset}`);
  const stderr = String(error?.stderr ?? "");
  const lines = stderr.trim().split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-20);
  if (tail.length) {
    console.warn(`${C.dim}${tail.map((l) => `  ${l}`).join("\n")}${C.reset}`);
    if (
      /(Receiving objects|接收对象|Resolving deltas|解析增量)/i.test(stderr)
    ) {
      console.warn(`${C.dim}${t.gitFailureProgressNotFinalHint}${C.reset}`);
    }
  } else {
    console.warn(`${C.dim}${t.gitFailureNoStderr}${C.reset}`);
    if (error?.message) {
      console.warn(`${C.dim}  ${error.message}${C.reset}`);
    }
  }
}

async function handleGitFailure({
  skillId,
  targetDir,
  displayTargetDir = targetDir,
  repoUrl,
  subdirPath,
  error,
}) {
  // Prefer filesystem truth over exit codes: objects may be complete while stderr shows TLS noise.
  if (
    !subdirPath &&
    (await pathExists(targetDir)) &&
    isGitWorkTreeReady(targetDir)
  ) {
    console.log(
      `${C.green}✓${C.reset} ${C.dim}${t.warnGitUsableDespiteError(skillId, displayTargetDir)}${C.reset}`,
    );
    return;
  }
  if (
    subdirPath &&
    (await pathExists(targetDir)) &&
    !(await isEmptyDir(targetDir))
  ) {
    console.log(
      `${C.green}✓${C.reset} ${C.dim}${t.warnGitUsableDespiteError(skillId, displayTargetDir)}${C.reset}`,
    );
    return;
  }

  logGitFailureRawDetails(skillId, displayTargetDir, error);

  const category = classifyGitInstallFailure(error);
  const failureText = [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .join("\n");

  const tryArchiveUnknown =
    category === "unknown" &&
    shouldUseArchiveFallbackForUnknownClone(repoUrl, failureText);
  if (shouldUseArchiveFallback(category) || tryArchiveUnknown) {
    await installViaArchiveFallback({
      skillId,
      targetDir,
      displayTargetDir,
      repoUrl,
      subdirPath,
      category: tryArchiveUnknown ? "proxy_network" : category,
      failureText,
    });
    return;
  }

  recordInstallFailure({
    skillId,
    targetDir: displayTargetDir,
    repoUrl,
    category,
    failureText,
    fallback: "none",
    reason: error?.message || String(error),
  });
  console.warn(
    `${C.yellow}⚠${C.reset} ${t.warnGitInstallFailed(skillId, category)}`,
  );
}

async function installGitSkill(skillId, targetDir, repoUrl) {
  assertUnderHome(targetDir);
  const repairResult = await repairManagedSkillTarget({ skillId, targetDir });
  const targetExists = await pathExists(targetDir);
  const targetEmpty = targetExists && (await isEmptyDir(targetDir));
  if (targetExists && !targetEmpty) {
    if (updateMode) {
      if (dryRun) {
        console.log(t.dryRun(`update ${targetDir}`));
      } else {
        try {
          if (repairResult.conflictDetected) {
            throw new Error(`managed install conflict: ${repairResult.reason}`);
          }
          runGit(["pull", "--ff-only"], {
            cwd: targetDir,
            skillLabel: `pull ${skillId}`,
          });
          console.log(`${C.green}✓${C.reset} ${t.okUpdated(targetDir)}`);
        } catch {
          console.warn(`${C.yellow}⚠${C.reset} ${t.warnPullFailed(targetDir)}`);
          const stagedDir = await createSiblingStagingDir(targetDir);
          const failureCountBeforeFallback = installFailures.length;
          try {
            try {
              runGit(["clone", "--depth", "1", repoUrl, stagedDir], {
                skillLabel: `clone ${skillId}`,
              });
            } catch (error) {
              await handleGitFailure({
                skillId,
                targetDir: stagedDir,
                displayTargetDir: targetDir,
                repoUrl,
                error,
              });
            }

            if (
              (await pathExists(stagedDir)) &&
              !(await isEmptyDir(stagedDir))
            ) {
              await replaceTargetDir(targetDir, stagedDir);
              console.log(`${C.green}✓${C.reset} ${t.okUpdated(targetDir)}`);
            } else if (installFailures.length === failureCountBeforeFallback) {
              recordInstallFailure({
                skillId,
                targetDir,
                repoUrl,
                category: "unknown",
                fallback: "update_clone_replace",
                reason: "pull fallback clone produced no staged content",
              });
            }
          } catch (error) {
            recordInstallFailure({
              skillId,
              targetDir,
              repoUrl,
              category: "unknown",
              fallback: "update_clone_replace",
              reason: error?.message || String(error),
            });
            console.warn(
              `${C.yellow}⚠${C.reset} ${t.warnReplaceFailed(skillId, targetDir, error.message)}`,
            );
          } finally {
            await rmDirBestEffortLocked(stagedDir);
          }
        }
      }
    } else {
      console.log(
        `${C.yellow}⊘${C.reset} ${C.dim}${t.skipExists(targetDir)}${C.reset}`,
      );
    }
    await sanitizeManagedSkillTarget(skillId, targetDir);
    return;
  }
  if (dryRun) {
    console.log(t.dryRun(`clone ${repoUrl} -> ${targetDir}`));
  } else {
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    try {
      runGit(["clone", "--depth", "1", repoUrl, targetDir], {
        skillLabel: `clone ${skillId}`,
      });
      console.log(`${C.green}✓${C.reset} ${t.okCloned(targetDir)}`);
    } catch (error) {
      await handleGitFailure({
        skillId,
        targetDir,
        repoUrl,
        error,
      });
    }
  }
  await sanitizeManagedSkillTarget(skillId, targetDir);
}

async function installGitSkillFromSubdir(
  skillId,
  targetDir,
  repoUrl,
  subdirPath,
) {
  assertUnderHome(targetDir);
  const repairResult = await repairManagedSkillTarget({
    skillId,
    targetDir,
    subdirPath,
  });
  const targetExists = await pathExists(targetDir);
  const targetEmpty = targetExists && (await isEmptyDir(targetDir));
  const shouldReplaceExisting =
    updateMode || repairResult.legacyDetected || targetEmpty;

  if (targetExists && !shouldReplaceExisting) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}${t.skipExists(targetDir)}${C.reset}`,
    );
    await sanitizeManagedSkillTarget(skillId, targetDir);
    return;
  }

  if (dryRun) {
    console.log(
      t.dryRun(`sparse install ${repoUrl} (${subdirPath}) -> ${targetDir}`),
    );
    return;
  }

  const stagedTargetDir = await createSiblingStagingDir(targetDir);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-skill-"));
  try {
    try {
      runGit(
        [
          "clone",
          "--depth",
          "1",
          "--filter=blob:none",
          "--sparse",
          repoUrl,
          tmp,
        ],
        { skillLabel: `clone ${skillId}` },
      );
      runGit(["sparse-checkout", "set", subdirPath], {
        cwd: tmp,
        skillLabel: `checkout ${skillId}`,
      });
      const src = path.join(tmp, ...subdirPath.split("/").filter(Boolean));
      if (!(await pathExists(src))) {
        throw new Error(`Sparse checkout path missing after clone: ${src}`);
      }
      await fs.cp(src, stagedTargetDir, { recursive: true, force: true });
    } catch (error) {
      let recovered = false;
      if (existsSync(tmp) && isGitWorkTreeReady(tmp)) {
        try {
          runGit(["sparse-checkout", "set", subdirPath], {
            cwd: tmp,
            skillLabel: `checkout ${skillId}`,
          });
          const srcRecover = path.join(
            tmp,
            ...subdirPath.split("/").filter(Boolean),
          );
          if (await pathExists(srcRecover)) {
            await fs.cp(srcRecover, stagedTargetDir, {
              recursive: true,
              force: true,
            });
            recovered = true;
          }
        } catch {
          // fall through
        }
      }
      if (!recovered) {
        await handleGitFailure({
          skillId,
          targetDir: stagedTargetDir,
          displayTargetDir: targetDir,
          repoUrl,
          subdirPath,
          error,
        });
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  if (
    (await pathExists(stagedTargetDir)) &&
    !(await isEmptyDir(stagedTargetDir))
  ) {
    await replaceTargetDir(targetDir, stagedTargetDir);
    console.log(
      `${C.green}✓${C.reset} ${t.okBasename(path.basename(targetDir), targetDir)}`,
    );
  }

  if (await pathExists(stagedTargetDir)) {
    await rmDirBestEffortLocked(stagedTargetDir);
  }
  await sanitizeManagedSkillTarget(skillId, targetDir);
}

async function deployRuntimeHookSupport(spec, runtimeHome, runtimeId, skillsRoot) {
  await sanitizeCompatibilityRoots(runtimeId, skillsRoot, spec);
  await ensureHookLayoutAliases(runtimeHome, spec);
  await deployHookSubdirs(spec, runtimeHome, runtimeId);
  await deployHookConfigFiles(spec, runtimeHome, runtimeId);
  await deployHookExtraFiles(spec, runtimeHome, runtimeId);
  await patchPlanningWithFilesPhaseCounters(spec, runtimeHome, runtimeId);
  await patchCodexPlanningHooksForPlatform(spec, runtimeHome, runtimeId);
  await patchCodexHookPromptForPlatform(spec, runtimeHome, runtimeId);
  await mergeHookSettings(spec, runtimeHome, runtimeId);
}

async function installAllSkillsForRuntime(label, runtimeHome, runtimeId) {
  const skillsRoot = path.join(runtimeHome, "skills");
  assertUnderHome(runtimeHome);
  if (!dryRun) {
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.mkdir(path.join(runtimeHome, "plugins"), { recursive: true });
  }

  let hasOutput = false;
  const emitHeader = () => {
    if (hasOutput) return;
    hasOutput = true;
    console.log(
      `\n${C.bold}${AMBER}${t.skillsHeader(label, runtimeHome)}${C.reset}`,
    );
  };

  for (const spec of SKILL_REPOS) {
    if (!usesGenericSkillInstall(spec))
      continue; // plugin bundles handled by installPluginBundlesForNonClaudeRuntimes
    if (spec.id === "meta-skill-creator") continue;
    if (spec.targets && !spec.targets.includes(runtimeId)) {
      continue;
    }
    emitHeader();
    const targetDir = resolveSkillTargetDir(runtimeHome, spec, runtimeId);
    await cleanupLegacySkillNames(runtimeHome, spec);
    if (spec.subdir) {
      await installGitSkillFromSubdir(
        spec.id,
        targetDir,
        spec.repo,
        spec.subdir,
      );
    } else {
      await installGitSkill(spec.id, targetDir, spec.repo);
    }
    await deployRuntimeHookSupport(spec, runtimeHome, runtimeId, skillsRoot);
    await cleanupDisabledSkillResidue(runtimeHome, spec.id);
  }

  if (!hasOutput) {
    console.log(
      `\n${C.green}✓${C.reset} ${C.dim}${t.allUpToDate(label)}${C.reset}`,
    );
  }
}

// ── Plugin bundles for non-Claude runtimes ────────────────────────────────
// Upstream pluginMarketplace packages (e.g. obra/superpowers) ship runtime-specific subtrees such as
// `.codex/`, `.cursor-plugin/`, `.opencode/`. For non-Claude runtimes we
// sparse-checkout the preferred subdir into `~/.<runtime>/skills/<id>/`.
// Claude runtime is still handled by installClaudePlugins() via the native
// `claude plugin install ...` marketplace path.
const PLUGIN_BUNDLE_SUBDIR_PREF = {
  claude: ["skills"],
  codex: [".codex", ".codex-plugin", "skills"],
  cursor: [".cursor", ".cursor-plugin", "skills"],
  opencode: [".opencode", "skills"],
  qoder: [".qoder", "skills"],
  openclaw: ["skills"],
};

function nativePluginIdForRuntime(spec, runtimeId) {
  if (runtimeId === "codex") return spec.codexPlugin ?? null;
  if (runtimeId === "cursor") return spec.cursorPlugin ?? null;
  return null;
}

async function looksLikeLegacySuperpowersSkillBundle(targetDir, spec) {
  if (spec.id !== "superpowers") return false;
  return (
    (await pathExists(path.join(targetDir, "using-superpowers", "SKILL.md"))) &&
    (await pathExists(path.join(targetDir, "test-driven-development", "SKILL.md"))) &&
    !(await pathExists(path.join(targetDir, "plugin.json"))) &&
    !(await pathExists(path.join(targetDir, ".codex-plugin"))) &&
    !(await pathExists(path.join(targetDir, ".cursor-plugin")))
  );
}

async function cleanupNativePluginSkillFallback(runtimeHome, runtimeId, spec) {
  const nativePluginId = nativePluginIdForRuntime(spec, runtimeId);
  if (!nativePluginId) return;

  const targetDir = path.join(runtimeHome, "skills", spec.id);
  const hasLegacyBundle =
    (await detectPluginBundleSkillResidue(targetDir)) ||
    (await looksLikeLegacySuperpowersSkillBundle(targetDir, spec));
  if (!hasLegacyBundle) return;

  assertUnderHome(targetDir);
  console.warn(
    `${C.yellow}⚠${C.reset} ${spec.id}: removing legacy ${runtimeId} skills/ fallback; use the native ${runtimeId} plugin "${nativePluginId}" instead`,
  );
  console.warn(`${C.dim}  ${targetDir}${C.reset}`);
  if (dryRun) {
    console.log(t.dryRun(`remove legacy native-plugin fallback: ${targetDir}`));
    return;
  }

  try {
    await rmDirWithRetry(targetDir);
  } catch (error) {
    if (isWindowsLockError(error)) {
      console.warn(`${C.yellow}⚠${C.reset} ${t.warnStagingLocked(targetDir)}`);
      return;
    }
    throw error;
  }
}

const ECC_HOME_INSTALL_TARGETS = new Set(["codex", "opencode", "qwen"]);
const ECC_PROJECT_INSTALL_TARGETS = new Set([
  "cursor",
  "zed",
  "gemini",
  "codebuddy",
  "antigravity",
  "joycode",
]);

function upstreamCliTargetMode(runtimeId) {
  if (ECC_HOME_INSTALL_TARGETS.has(runtimeId)) return "home";
  if (ECC_PROJECT_INSTALL_TARGETS.has(runtimeId)) return "project";
  return null;
}

function upstreamCliArgsForTarget(spec, runtimeId) {
  const pkg = spec.upstreamPackage || `${spec.id}@latest`;
  const profile = spec.upstreamProfile || "core";
  return [
    "--yes",
    "--package",
    pkg,
    "ecc",
    "install",
    "--profile",
    profile,
    "--target",
    runtimeId,
  ];
}

function formatNpxCommand(args) {
  return `npx ${args.join(" ")}`;
}

async function readCodexConfigSnapshot(runtimeId, runtimeHome) {
  if (runtimeId !== "codex" || !runtimeHome) return null;
  const configPath = path.join(runtimeHome, "config.toml");
  const text = (await pathExists(configPath))
    ? await fs.readFile(configPath, "utf8")
    : null;
  return { configPath, text };
}

function isEccCodexAgentsBaseline(text) {
  if (!text) return false;
  return (
    /^# ECC for Codex CLI/m.test(text) &&
    /This supplements the root `AGENTS\.md` with Codex-specific guidance\./.test(
      text,
    ) &&
    /Everything Claude Code|ECC/.test(text)
  );
}

async function readCodexGlobalAgentsSnapshot(runtimeId, runtimeHome) {
  if (runtimeId !== "codex" || !runtimeHome) return null;
  const agentsPath = path.join(runtimeHome, "AGENTS.md");
  const text = (await pathExists(agentsPath))
    ? await fs.readFile(agentsPath, "utf8")
    : null;
  return {
    agentsPath,
    text,
    isEccBaseline: isEccCodexAgentsBaseline(text),
  };
}

async function backupCodexConfigBeforeUpstream(snapshot) {
  if (!snapshot?.text) return null;
  const backupPath = `${snapshot.configPath}.meta-kim.pre-ecc.bak`;
  await fs.copyFile(snapshot.configPath, backupPath);
  console.log(
    `${C.yellow}↻${C.reset} ${C.dim}${t.codexConfigBackupBeforeEcc(backupPath)}${C.reset}`,
  );
  return backupPath;
}

async function backupCodexGlobalAgentsBeforeUpstream(snapshot) {
  if (!snapshot?.text) return null;
  const backupPath = `${snapshot.agentsPath}.meta-kim.pre-ecc.bak`;
  await fs.copyFile(snapshot.agentsPath, backupPath);
  console.log(
    `${C.yellow}↻${C.reset} ${C.dim}${t.codexGlobalAgentsBackupBeforeEcc(backupPath)}${C.reset}`,
  );
  return backupPath;
}

async function restoreCodexConfigAfterUpstream(snapshot, runtimeHome) {
  if (!snapshot || snapshot.text === null) return false;
  const upstreamText = (await pathExists(snapshot.configPath))
    ? await fs.readFile(snapshot.configPath, "utf8")
    : "";
  const merged = mergeCodexConfigAddOnly(snapshot.text, upstreamText);
  const next = ensureCodexAppNativeControls(merged, {
    codexHome: runtimeHome,
  });
  if (upstreamText === next) return false;
  await fs.writeFile(snapshot.configPath, next, "utf8");
  console.log(
    `${C.green}✓${C.reset} ${C.dim}${t.codexConfigRestoredAfterEcc(snapshot.configPath)}${C.reset}`,
  );
  return true;
}

async function restoreCodexGlobalAgentsAfterUpstream(snapshot) {
  if (!snapshot) return false;
  const currentText = (await pathExists(snapshot.agentsPath))
    ? await fs.readFile(snapshot.agentsPath, "utf8")
    : null;

  if (snapshot.text && !snapshot.isEccBaseline) {
    if (currentText === snapshot.text) return false;
    await fs.writeFile(snapshot.agentsPath, snapshot.text, "utf8");
    console.log(
      `${C.green}✓${C.reset} ${C.dim}${t.codexGlobalAgentsRestoredAfterEcc(snapshot.agentsPath)}${C.reset}`,
    );
    return true;
  }

  if (currentText && isEccCodexAgentsBaseline(currentText)) {
    const backupPath = `${snapshot.agentsPath}.meta-kim.ecc-baseline.bak`;
    await fs.copyFile(snapshot.agentsPath, backupPath);
    await fs.rm(snapshot.agentsPath, { force: true });
    console.log(
      `${C.green}✓${C.reset} ${C.dim}${t.codexGlobalAgentsQuarantinedAfterEcc(snapshot.agentsPath, backupPath)}${C.reset}`,
    );
    return true;
  }

  return false;
}

async function installUpstreamCliSpecs(runtimeHomes, activeTargets) {
  if (skipPlugins) return;
  const specs = SKILL_REPOS.filter((s) => s.installMethod === "upstreamCli");
  if (specs.length === 0) return;

  let hasOutput = false;
  const emitHeader = () => {
    if (hasOutput) return;
    hasOutput = true;
    console.log(`\n${C.bold}${AMBER}${t.upstreamNativeInstallersHeader}${C.reset}`);
  };

  for (const spec of specs) {
    const specTargets = spec.targets || [];
    for (const runtimeId of activeTargets) {
      if (!specTargets.includes(runtimeId)) continue;
      const runtimeHome = runtimeHomes[runtimeId];
      if (!runtimeHome) continue;

      await cleanupLegacySkillNames(runtimeHome, spec);
      await cleanupDisabledSkillResidue(runtimeHome, spec.id);

      if (runtimeId === "claude" && spec.claudePlugin) {
        continue;
      }

      const targetMode = upstreamCliTargetMode(runtimeId);
      if (!targetMode) continue;

      const args = upstreamCliArgsForTarget(spec, runtimeId);
      const commandText = formatNpxCommand(args);

      emitHeader();
      if (targetMode === "project") {
        const message = t.upstreamProjectLocalSkipped(
          spec.id,
          runtimeId,
          commandText,
        );
        if (dryRun) {
          console.log(t.dryRun(message));
        } else {
          console.log(`${C.yellow}⊘${C.reset} ${message}`);
        }
        continue;
      }

      if (dryRun) {
        console.log(t.dryRun(commandText));
        if (runtimeId === "codex") {
          console.log(
            t.dryRun(
              t.upstreamCodexConfigPreserveDryRun(
                path.join(runtimeHome, "config.toml"),
              ),
            ),
          );
          console.log(
            t.dryRun(
              t.upstreamCodexGlobalAgentsPreserveDryRun(
                path.join(runtimeHome, "AGENTS.md"),
              ),
            ),
          );
        }
        continue;
      }

      console.log(
        `${C.cyan}→${C.reset} ${t.upstreamNativeInstall(spec.id, runtimeId)}`,
      );
      const codexConfigSnapshot = await readCodexConfigSnapshot(
        runtimeId,
        runtimeHome,
      );
      const codexGlobalAgentsSnapshot = await readCodexGlobalAgentsSnapshot(
        runtimeId,
        runtimeHome,
      );
      await backupCodexConfigBeforeUpstream(codexConfigSnapshot);
      await backupCodexGlobalAgentsBeforeUpstream(codexGlobalAgentsSnapshot);
      const result = spawnCliSync("npx", args, {
        cwd: os.homedir(),
        encoding: "utf8",
        stdio: "inherit",
      });
      await restoreCodexConfigAfterUpstream(codexConfigSnapshot, runtimeHome);
      await restoreCodexGlobalAgentsAfterUpstream(codexGlobalAgentsSnapshot);
      if (result.status !== 0) {
        recordInstallFailure({
          skillId: `${spec.id} (${runtimeId})`,
          targetDir: runtimeHome,
          repoUrl: spec.repo,
          category: "unknown",
          failureText: `upstream installer exited ${result.status}`,
          fallback: "none",
          reason: t.upstreamInstallerFailureReason(commandText),
        });
      }
    }
  }
}

async function ensureCodexChoiceSurfaceAfterInstall(runtimeHomes, activeTargets) {
  if (!activeTargets.includes("codex") || !runtimeHomes.codex) return;

  const configPath = path.join(runtimeHomes.codex, "config.toml");
  if (dryRun) {
    console.log(
      t.dryRun(
        t.codexNativeControlsDryRun(configPath, CODEX_REQUEST_USER_INPUT_FEATURE),
      ),
    );
    return;
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const previous = (await pathExists(configPath))
    ? await fs.readFile(configPath, "utf8")
    : "";

  const next = ensureCodexAppNativeControls(previous, {
    codexHome: runtimeHomes.codex,
  });

  if (previous === next) {
    console.log(
      `${C.green}✓${C.reset} ${C.dim}${t.codexChoiceSurfacePreserved(configPath)}${C.reset}`,
    );
    return;
  }

  if (previous) {
    const backupPath = `${configPath}.meta-kim.bak`;
    await fs.copyFile(configPath, backupPath);
    console.log(
      `${C.yellow}↻${C.reset} ${C.dim}${t.codexConfigBackupBeforeChoiceSurface(backupPath)}${C.reset}`,
    );
  }

  await fs.writeFile(configPath, next, "utf8");
  console.log(
    `${C.green}✓${C.reset} ${C.dim}${t.codexChoiceSurfaceRestored(configPath)}${C.reset}`,
  );
}

function printNativePluginInstallHint(runtimeId, pluginId) {
  if (runtimeId === "codex") {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}${t.codexNativePluginManualStep(pluginId)}${C.reset}`,
    );
    return;
  }
  if (runtimeId === "cursor") {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}${t.cursorNativePluginManualStep(pluginId)}${C.reset}`,
    );
  }
}

function codexPluginInstalled(pluginId, marketplaceId = "openai-curated") {
  const result = spawnCliSync("codex", ["plugin", "list"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return false;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const escapedPlugin = pluginId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedMarketplace = marketplaceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `${escapedPlugin}@${escapedMarketplace}\\s+installed`,
    "i",
  ).test(output);
}

function installCodexNativePlugin(pluginId) {
  const marketplaceId = "openai-curated";
  if (dryRun) {
    console.log(t.dryRun(`codex plugin add ${pluginId}@${marketplaceId}`));
    return true;
  }

  const versionProbe = spawnCliSync("codex", ["--version"], {
    encoding: "utf8",
  });
  if (versionProbe.status !== 0) {
    printNativePluginInstallHint("codex", pluginId);
    return false;
  }

  if (codexPluginInstalled(pluginId, marketplaceId)) {
    console.log(
      `${C.green}✓${C.reset} ${C.dim}${t.codexPluginAlreadyInstalled(`${pluginId}@${marketplaceId}`)}${C.reset}`,
    );
    return true;
  }

  spawnCliSync("codex", ["plugin", "marketplace", "upgrade", marketplaceId], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const result = spawnCliSync(
    "codex",
    ["plugin", "add", `${pluginId}@${marketplaceId}`],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (result.status === 0) return true;

  console.log(
    `${C.yellow}⊘${C.reset} ${C.dim}${t.codexNativePluginAutoInstallIncomplete(`${pluginId}@${marketplaceId}`)}${C.reset}`,
  );
  return false;
}

async function installPluginBundlesForNonClaudeRuntimes(
  runtimeHomes,
  activeTargets,
) {
  if (skipPlugins) return;
  const pluginBundleSpecs = SKILL_REPOS.filter(
    (s) =>
      s.installMethod !== "upstreamCli" &&
      (s.claudePlugin || s.installMethod === "pluginMarketplace"),
  );
  if (pluginBundleSpecs.length === 0) return;

  const NON_CLAUDE = ["codex", "cursor", "opencode", "qoder", "openclaw"];
  // Extend with "claude" ONLY for specs lacking claudePlugin — those cannot be
  // installed via `claude plugin install` and need the sparse-checkout fallback
  // even on Claude runtime (e.g. cli-anything).
  const allowsClaudeFallback = pluginBundleSpecs.some((s) => !s.claudePlugin);
  const eligibleRuntimes = (
    allowsClaudeFallback ? ["claude", ...NON_CLAUDE] : NON_CLAUDE
  ).filter((r) => activeTargets?.includes(r) && runtimeHomes[r]);
  if (eligibleRuntimes.length === 0) return;

  let hasOutput = false;
  const emitHeader = () => {
    if (hasOutput) return;
    hasOutput = true;
    console.log(
      `\n${C.bold}${AMBER}${t.pluginBundlesHeader}${C.reset}`,
    );
  };

  for (const spec of pluginBundleSpecs) {
    const specTargets = spec.targets || [];
    for (const runtimeId of eligibleRuntimes) {
      if (!specTargets.includes(runtimeId)) continue;
      const runtimeHome = runtimeHomes[runtimeId];
      const nativePluginId = nativePluginIdForRuntime(spec, runtimeId);
      if (nativePluginId) {
        emitHeader();
        await cleanupNativePluginSkillFallback(runtimeHome, runtimeId, spec);
        if (runtimeId === "codex") {
          installCodexNativePlugin(nativePluginId);
        } else {
          printNativePluginInstallHint(runtimeId, nativePluginId);
        }
        continue;
      }
      // Claude runtime with a native claudePlugin spec: already handled by
      // installClaudePlugins() via `claude plugin install`. Skip here to
      // avoid double install. Claude runtime WITHOUT claudePlugin (e.g.
      // cli-anything) still needs the sparse-checkout fallback.
      if (runtimeId === "claude" && spec.claudePlugin) continue;
      const targetDir = path.join(runtimeHome, "skills", spec.id);

      // Stale bundle residue detection: previous full-repo clones of plugin
      // bundles (obra/superpowers etc.) dump .claude-plugin/ at targetDir root,
      // which non-Claude runtimes cannot consume. Treat such dirs as stale
      // and re-extract the runtime-specific subtree.
      const conflict = await detectManagedInstallConflict(targetDir);
      const staleResidue =
        !updateMode && conflict.reason === "plugin_bundle_residue";

      if (
        !updateMode &&
        !dryRun &&
        !staleResidue &&
        (await pathExists(targetDir)) &&
        !(await isEmptyDir(targetDir))
      ) {
        continue;
      }

      if (staleResidue) {
        console.log(
          `${C.cyan}↻${C.reset} ${C.dim}${spec.id}: migrating legacy bundle residue at ${targetDir}${C.reset}`,
        );
      }

      emitHeader();
      const preferredSubdirs = PLUGIN_BUNDLE_SUBDIR_PREF[runtimeId] || [
        "skills",
      ];
      const triedSubdirs = [];
      let ok = false;

      for (const subdir of preferredSubdirs) {
        triedSubdirs.push(subdir);
        if (dryRun) {
          console.log(
            t.dryRun(
              `git sparse-checkout ${spec.repo}:${subdir} -> ${targetDir}`,
            ),
          );
          ok = true;
          break;
        }
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-pb-"));
        try {
          await runGitAsync(
            [
              "clone",
              "--depth",
              "1",
              "--filter=blob:none",
              "--sparse",
              spec.repo,
              tmp,
            ],
            { skillLabel: `${spec.id} (${runtimeId})` },
          );
          await runGitAsync(["sparse-checkout", "set", subdir], { cwd: tmp });
          const src = path.join(tmp, ...subdir.split("/").filter(Boolean));
          if ((await pathExists(src)) && !(await isEmptyDir(src))) {
            await fs.rm(targetDir, { recursive: true, force: true });
            await fs.mkdir(path.dirname(targetDir), { recursive: true });
            await fs.cp(src, targetDir, { recursive: true, force: true });
            console.log(
              `${C.green}✓${C.reset} ${spec.id} → ${targetDir} ${C.dim}(from ${subdir})${C.reset}`,
            );
            ok = true;
            break;
          }
          // subdir absent in this repo — try the next preference
        } catch {
          // git error for this subdir — try the next preference
        } finally {
          await fs.rm(tmp, { recursive: true, force: true });
        }
      }

      // Fallback: if platform subdir was too sparse (no SKILL.md or key files),
      // try the spec's fallbackContentDir (e.g. "skills") as the main content
      if (ok && spec.fallbackContentDir) {
        const hasSkillFile =
          (await pathExists(path.join(targetDir, "SKILL.md"))) ||
          (await pathExists(path.join(targetDir, "AGENTS.md"))) ||
          (await pathExists(path.join(targetDir, "CLAUDE.md")));
        const dirSize = await (async () => {
          try {
            const entries = await fs.readdir(targetDir);
            return entries.length;
          } catch {
            return 0;
          }
        })();
        // If only 1-2 files pulled and no key entry file, it's too sparse
        if (!hasSkillFile && dirSize <= 2 && !dryRun) {
          const fallback = spec.fallbackContentDir;
          const tmp2 = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-fb-"));
          try {
            await runGitAsync(
              [
                "clone",
                "--depth",
                "1",
                "--filter=blob:none",
                "--sparse",
                spec.repo,
                tmp2,
              ],
              { skillLabel: `${spec.id}-fallback (${runtimeId})` },
            );
            await runGitAsync(["sparse-checkout", "set", fallback], {
              cwd: tmp2,
            });
            const src2 = path.join(
              tmp2,
              ...fallback.split("/").filter(Boolean),
            );
            if ((await pathExists(src2)) && !(await isEmptyDir(src2))) {
              await fs.rm(targetDir, { recursive: true, force: true });
              await fs.mkdir(path.dirname(targetDir), { recursive: true });
              await fs.cp(src2, targetDir, { recursive: true, force: true });
              console.log(
                `${C.cyan}↻${C.reset} ${spec.id} -> ${targetDir} ${C.dim}(fallback from ${fallback})${C.reset}`,
              );
            }
          } catch {
            // fallback failed — keep what we have
          } finally {
            await fs.rm(tmp2, { recursive: true, force: true });
          }
        }
      }

      if (!ok) {
        console.warn(
          `${C.yellow}⚠${C.reset} ${spec.id}: no suitable subdir for ${runtimeId} (tried: ${triedSubdirs.join(", ")})`,
        );
      }

      // Hook co-deployment for plugin bundles
      await deployHookSubdirs(spec, runtimeHome, runtimeId);
      await deployHookConfigFiles(spec, runtimeHome, runtimeId);
      await deployHookExtraFiles(spec, runtimeHome, runtimeId);
      await patchPlanningWithFilesPhaseCounters(spec, runtimeHome, runtimeId);
      await patchCodexPlanningHooksForPlatform(spec, runtimeHome, runtimeId);
      await patchCodexHookPromptForPlatform(spec, runtimeHome, runtimeId);
      await mergeHookSettings(spec, runtimeHome, runtimeId);
    }
  }
}

async function installClaudePlugins() {
  if (skipPlugins || CLAUDE_PLUGIN_SPECS.length === 0) {
    return false;
  }
  console.log(`\n${C.bold}${AMBER}${t.pluginsHeader}${C.reset}`);

  // Auto-register plugin marketplaces if not already present.
  // This is needed on fresh Mac/Linux installs where marketplaces are not
  // pre-registered (unlike Windows which has them installed by default).
  // Registry is derived from config/skills.json. A plugin with no declared
  // marketplace/version source is rejected by the shared config preflight.
  const MARKETPLACE_URLS = Object.fromEntries(
    SKILL_REPOS.filter((skill) => skill.claudePlugin).map((skill) => [
      skill.marketplace.id,
      skill.marketplace.repository.cloneUrl,
    ]),
  );

  if (dryRun) {
    const neededMarketplaces = new Set(
      CLAUDE_PLUGIN_SPECS.map((spec) => spec.split("@")[1]).filter(
        (id) => id in MARKETPLACE_URLS,
      ),
    );
    if (neededMarketplaces.size > 0) {
      console.log(`\n${C.dim}  ${t.checkingPluginMarketplaces}${C.reset}`);
      for (const mktId of neededMarketplaces) {
        console.log(
          t.dryRun(
            `claude plugin marketplace add ${MARKETPLACE_URLS[mktId]} (${mktId})`,
          ),
        );
      }
    }
    for (const spec of CLAUDE_PLUGIN_SPECS) {
      const command = updateMode ? "update" : "install";
      console.log(t.dryRun(`claude plugin ${command} ${spec}`));
    }
    return true;
  }

  // Probe which claude invocation method works.
  // Windows edge-case: a broken npm .cmd shim may shadow a working
  // standalone .exe.  We try direct spawn first (skips .cmd), then
  // shell spawn (finds .cmd).  Whichever works is reused below.
  const isWin = os.platform() === "win32";
  const useShell = shouldUseCliShell(os.platform());

  let claudeShellOpt = false;
  let claudeFound = false;

  // Strategy 1: direct spawn (finds .exe, skips broken .cmd shims on Windows)
  const direct = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (direct.status === 0) {
    claudeShellOpt = false;
    claudeFound = true;
  }

  // Strategy 2: shell spawn (finds .cmd wrappers for npm installs)
  if (!claudeFound && useShell) {
    const viaShell = spawnCliSync("claude", ["--version"], {
      encoding: "utf8",
    });
    if (viaShell.status === 0) {
      claudeShellOpt = true;
      claudeFound = true;
    }
  }

  if (!claudeFound) {
    console.warn(`${C.yellow}⚠${C.reset} ${t.warnClaNotFound}`);
    return false;
  }

  // Collect marketplace IDs needed by CLAUDE_PLUGIN_SPECS (spec format: "name@marketplace")
  const neededMarketplaces = new Set(
    CLAUDE_PLUGIN_SPECS.map((spec) => spec.split("@")[1]).filter(
      (id) => id in MARKETPLACE_URLS,
    ),
  );

  if (neededMarketplaces.size > 0) {
    console.log(`\n${C.dim}  ${t.checkingPluginMarketplaces}${C.reset}`);

    // Probe currently-registered marketplaces
    const mktListOut = spawnCliWithShellOptionSync(
      "claude",
      ["plugin", "marketplace", "list", "--json"],
      { encoding: "utf8" },
      claudeShellOpt,
    );
    let registeredMarketplaces = new Set();
    if (mktListOut.status === 0 && mktListOut.stdout) {
      try {
        // Output is JSON array of { name, source, repo, ... }
        const mktData = JSON.parse(mktListOut.stdout);
        if (Array.isArray(mktData)) {
          for (const m of mktData) {
            if (m.name) registeredMarketplaces.add(m.name);
          }
        }
      } catch {
        // Fall through with empty set
      }
    }

    for (const mktId of neededMarketplaces) {
      if (registeredMarketplaces.has(mktId)) {
        console.log(
          `${C.green}✓${C.reset} ${C.dim}Marketplace "${mktId}" already registered${C.reset}`,
        );
        continue;
      }
      const url = MARKETPLACE_URLS[mktId];
      console.log(
        `${C.cyan}→${C.reset} ${C.dim}Registering marketplace "${mktId}" from ${url}${C.reset}`,
      );
      const addOut = spawnCliWithShellOptionSync(
        "claude",
        ["plugin", "marketplace", "add", url],
        { encoding: "utf8" },
        claudeShellOpt,
      );
      if (addOut.status === 0) {
        console.log(
          `${C.green}✓${C.reset} ${C.dim}Marketplace "${mktId}" registered${C.reset}`,
        );
      } else {
        const err = (addOut.stderr || addOut.stdout || "")
          .trim()
          .split("\n")[0];
        console.warn(
          `${C.yellow}⚠${C.reset} ${C.dim}Failed to register marketplace "${mktId}": ${err}${C.reset}`,
        );
      }
    }

    // Refresh registered marketplaces to pull latest plugin manifests
    // (mitigates upstream rename events: e.g., everything-claude-code plugin renamed to ecc;
    // stale marketplace caches keep the old plugin name and break new install specs)
    for (const mktId of neededMarketplaces) {
      console.log(
        `${C.cyan}→${C.reset} ${C.dim}Refreshing marketplace "${mktId}"${C.reset}`,
      );
      const updateOut = spawnCliWithShellOptionSync(
        "claude",
        ["plugin", "marketplace", "update", mktId],
        { encoding: "utf8" },
        claudeShellOpt,
      );
      if (updateOut.status === 0) {
        console.log(
          `${C.green}✓${C.reset} ${C.dim}Marketplace "${mktId}" refreshed${C.reset}`,
        );
      } else {
        const refreshErr = (updateOut.stderr || updateOut.stdout || "")
          .trim()
          .split("\n")[0];
        console.warn(
          `${C.yellow}⚠${C.reset} ${C.dim}Failed to refresh marketplace "${mktId}": ${refreshErr}${C.reset}`,
        );
      }
    }
  }

  // Load installed plugin records from installed_plugins.json
  // Format: { version: 2, plugins: { "<fullKey>": [records] } }
  let installedPluginsFile = { version: 2, plugins: {} };
  const configHome =
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  // Claude Code writes installed_plugins.json under the plugins/ subdirectory
  const installedPluginsPath = path.join(
    configHome,
    "plugins",
    "installed_plugins.json",
  );
  function readInstalledPluginsFromDisk() {
    try {
      if (existsSync(installedPluginsPath)) {
        const raw = readFileSync(installedPluginsPath, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed.plugins) parsed.plugins = {};
        return parsed;
      }
    } catch {
      // If file missing or corrupt, fall through with fresh structure.
    }
    return { version: 2, plugins: {} };
  }
  installedPluginsFile = readInstalledPluginsFromDisk();

  for (const repoSpec of SKILL_REPOS.filter((s) => s.claudePlugin)) {
    const canonicalSpec = repoSpec.claudePlugin;
    for (const legacyName of repoSpec.legacyNames || []) {
      for (const key of Object.keys(installedPluginsFile.plugins)) {
        if (key === canonicalSpec) continue;
        if (!key.startsWith(`${legacyName}@`)) continue;
        console.warn(
          `${C.yellow}⚠${C.reset} ${t.staleClaudePluginRecordRemoved(repoSpec.id, key)}`,
        );
        delete installedPluginsFile.plugins[key];
      }
    }
  }
  try {
    await fs.mkdir(path.dirname(installedPluginsPath), { recursive: true });
    await fs.writeFile(
      installedPluginsPath,
      JSON.stringify(installedPluginsFile, null, 2),
      "utf8",
    );
  } catch {
    // Non-fatal; Claude can recreate this file during plugin install.
  }

  // Flat lookup by bare name (first matching record across all full keys)
  function getInstalledRecord(bareName) {
    const key = Object.keys(installedPluginsFile.plugins).find((k) =>
      k.startsWith(bareName + "@"),
    );
    const records = installedPluginsFile.plugins[key];
    return records?.[0] ?? null;
  }

  // Probe currently-active plugins via CLI (for bare-name dedup in non-update mode)
  const listOut = spawnCliWithShellOptionSync(
    "claude",
    ["plugins", "list", "--json"],
    { encoding: "utf8" },
    claudeShellOpt,
  );
  let installedNames = new Set();
  if (listOut.status === 0 && listOut.stdout) {
    try {
      const plugins = JSON.parse(listOut.stdout);
      if (Array.isArray(plugins)) {
        for (const p of plugins) {
          const name = (p.name || p.id || "").split("@")[0].trim();
          if (name) installedNames.add(name);
        }
      }
    } catch {
      // If JSON parse fails, fall through to blind install.
    }
  }

  /**
   * Fetch the latest plugin version from GitHub marketplace.json.
   * Returns version string or null if unreachable/unparseable.
   * Version source: .claude-plugin/marketplace.json → plugins[].version
   */
  async function fetchLatestPluginVersion(versionSource) {
    const repoFull = versionSource.repository.fullName;
    const encodedManifestPath = versionSource.manifestPath
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
    const url = `${versionSource.apiBase}/repos/${repoFull}/contents/${encodedManifestPath}`;
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent": "meta-kim/2.0",
          accept: "application/vnd.github.v3+json",
        },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const content = Buffer.from(data.content, "base64").toString("utf8");
      const m = JSON.parse(content);
      // marketplace.json format: { plugins: [{ name, version, ... }] }
      if (m.plugins && Array.isArray(m.plugins)) {
        const found = m.plugins.find(
          (plugin) => plugin.name === versionSource.pluginName,
        );
        return found?.version ?? null;
      }
      // Fallback: top-level version (some older formats)
      return m.version ?? null;
    } catch {
      return null;
    }
  }

  for (const spec of CLAUDE_PLUGIN_SPECS) {
    const bareName = spec.split("@")[0];
    const repoSpec = SKILL_REPOS.find((skill) => skill.claudePlugin === spec);
    const versionSource = repoSpec.versionSource;
    const repoFull = versionSource.repository.fullName;
    // Look up by full spec ("bareName@marketplace"), not bare name.
    // installed_plugins.json can carry stale cross-marketplace entries for the
    // same bare name (e.g. both "superpowers@claude-plugins-official" and
    // "superpowers@superpowers-marketplace"); matching by bare name alone
    // returns whichever record happens to be first, which caused every run
    // to look like an "upgrade" (old marketplace version vs new marketplace
    // latest never matched).
    const localRecord = installedPluginsFile.plugins[spec]?.[0] ?? null;
    const localVersion = localRecord?.version ?? null;

    if (!updateMode) {
      // Non-update mode: skip only when the canonical full spec is installed.
      if (localRecord) {
        console.log(
          `${C.yellow}⊘${C.reset} ${C.dim}${t.skipAlreadyInstalled(spec)}${C.reset}`,
        );
        continue;
      }
    } else {
      // Update mode: fetch latest from GitHub and compare
      const latestVersion = await fetchLatestPluginVersion(versionSource);
      if (latestVersion) {
        if (localVersion === latestVersion) {
          console.log(
            `${C.green}✓${C.reset} ${C.dim}${bareName} ${latestVersion} — ${t.labelUpToDate}${C.reset}`,
          );
          continue;
        }
        console.log(
          `${C.cyan}↺${C.reset} ${bareName}: ${C.dim}${localVersion ?? "unknown"}${C.reset} → ${C.bold}${latestVersion}${C.reset} ${C.dim}(${repoFull})${C.reset}`,
        );
      } else {
        // GitHub unreachable or unparseable — warn but proceed with install
        if (localVersion) {
          console.log(
            `${C.yellow}⚠${C.reset} ${C.dim}${bareName} — ${t.labelCannotCheckGitHub}${C.reset} ${C.dim}(${t.labelUsingLocalRecord(localVersion)})${C.reset}`,
          );
        } else {
          console.log(
            `${C.yellow}⚠${C.reset} ${C.dim}${bareName} — ${t.labelCannotCheckGitHub}${C.reset}`,
          );
        }
      }
    }

    if (dryRun) {
      console.log(t.dryRun(`claude plugin install ${spec}`));
      continue;
    }
    const pluginCommand = updateMode && localRecord ? "update" : "install";
    console.log(
      `${C.cyan}→${C.reset} ${
        pluginCommand === "update"
          ? t.updatingPlugin(spec)
          : t.installingPlugin(spec)
      }`,
    );
    const p = spawnCliWithShellOptionSync(
      "claude",
      ["plugin", pluginCommand, spec],
      { stdio: "inherit" },
      claudeShellOpt,
    );
    if (p.status !== 0) {
      console.warn(
        `${C.yellow}⚠${C.reset} ${t.warnPluginFailed(spec, p.status)}`,
      );
      continue;
    } else if (updateMode) {
      console.log(`${C.green}✓${C.reset} ${t.pluginUpdated(spec)}`);
    }

    // Record installed version so --update mode can detect future mismatches.
    // Both update-mode reinstalls and first-time installs write here.
    if (p.status === 0) {
      // Prefer the plugin manager's own updated record. This preserves install
      // paths and commit SHAs after `claude plugin update`.
      const refreshedInstalledPluginsFile = readInstalledPluginsFromDisk();
      if (refreshedInstalledPluginsFile.plugins?.[spec]?.[0]) {
        installedPluginsFile = refreshedInstalledPluginsFile;
        continue;
      }

      // Priority: (1) GitHub API version, (2) parse version from installPath dir name.
      // installPath format: ~/.claude/plugins/cache/{marketplace}/{name}/{version}/
      // The directory name IS the version — more reliable than GitHub API rate limits.
      let resolvedVersion = await fetchLatestPluginVersion(repoFull);
      if (!resolvedVersion && localRecord?.installPath) {
        const dirName = path.basename(localRecord.installPath);
        // Directory name matches "1.2.0" or "v1.2.0" pattern
        const v = dirName.match(/^v?(\d+\.\d+\.\d+.*)$/)?.[1] ?? dirName;
        if (v && v !== dirName) resolvedVersion = v;
      }
      // Update installPath to new version dir if version changed (update mode)
      let resolvedInstallPath = localRecord?.installPath ?? "";
      if (updateMode && resolvedVersion) {
        // Reconstruct installPath with new version
        const oldPathParts = (localRecord?.installPath ?? "")
          .split(path.sep)
          .filter(Boolean);
        if (oldPathParts.length >= 2) {
          // Replace last path segment (version dir) with new version
          oldPathParts[oldPathParts.length - 1] = resolvedVersion;
          resolvedInstallPath = oldPathParts.join(path.sep);
        }
      }
      const newRecord = {
        scope: "user",
        installPath: resolvedInstallPath,
        version: resolvedVersion ?? spec,
        installedAt: localRecord?.installedAt ?? new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        ...(localRecord?.gitCommitSha
          ? { gitCommitSha: localRecord.gitCommitSha }
          : {}),
      };
      // Keep full key format: "bareName@marketplace"
      const fullKey = spec;
      installedPluginsFile.plugins[fullKey] = [newRecord];
      try {
        fs.writeFileSync(
          installedPluginsPath,
          JSON.stringify(installedPluginsFile, null, 2),
          "utf8",
        );
      } catch {
        // Write failure is non-fatal; the version will be re-detected next run.
      }
    }
  }
  return true;
}

// ── Legacy artifact cleanup ──────────────────────────────────

/**
 * Detect and remove known legacy directory structures left by older
 * versions of Meta_Kim install scripts. Runs automatically during
 * every install/update so all users benefit.
 *
 * Known patterns:
 *   1. Nested runtime dir: ~/.claude/.claude/, ~/.codex/.codex/, etc.
 *      (caused by old global-sync writing project-level structure into
 *      the runtime home dir)
 *   2. Stale meta-kim install: ~/.claude/meta-kim/
 *      (old install artifact from pre-2.0 setup)
 */
async function cleanupLegacyGlobalArtifacts(homes) {
  const cleaned = [];

  // Pattern 1: nested runtime dir inside its own home
  // e.g. ~/.claude/.claude/, ~/.codex/.codex/, ~/.openclaw/.openclaw/, ~/.cursor/.cursor/
  for (const [runtimeId, homeDir] of Object.entries(homes)) {
    const runtimeDirName = path.basename(homeDir); // e.g. ".claude"
    const nestedDir = path.join(homeDir, runtimeDirName);
    if (await pathExists(nestedDir)) {
      console.warn(`${C.yellow}⚠${C.reset} ${t.warnRemovingObsoleteDir}`);
      console.warn(
        `${C.dim}  ${nestedDir}${C.reset} — ${t.warnNestedCopyNotUsed(runtimeId)}`,
      );
      if (!dryRun) {
        await fs.rm(nestedDir, { recursive: true, force: true });
      }
      cleaned.push(nestedDir);
    }
  }

  // Pattern 2: stale meta-kim install artifact inside Claude home
  const metaKimLegacy = path.join(homes.claude, "meta-kim");
  if (await pathExists(metaKimLegacy)) {
    console.warn(`${C.yellow}⚠${C.reset} ${t.warnRemovingObsoleteDir}`);
    console.warn(
      `${C.dim}  ${metaKimLegacy}${C.reset} — ${t.warnPre2Artifact}`,
    );
    if (!dryRun) {
      await fs.rm(metaKimLegacy, { recursive: true, force: true });
    }
    cleaned.push(metaKimLegacy);
  }

  if (cleaned.length > 0) {
    console.log(`${C.green}✓${C.reset} ${t.okRemovedObsolete(cleaned.length)}`);
    console.log(`${C.dim}  ${t.noteSettingsNotAffected}${C.reset}`);
  }
}

/**
 * Align skills/ vs plugins/ for discovery vs upstream hook defaults.
 * - pluginHookCompat: canonical in skills/<id>, add plugins/<id> -> skills/<id>
 * - installRoot plugins (no compat): canonical in plugins/<id>, add skills/<id> -> plugins/<id>
 */
async function ensureHookLayoutAliases(runtimeHome, spec) {
  const skillsDir = path.resolve(runtimeHome, "skills", spec.id);
  const pluginsDir = path.resolve(runtimeHome, "plugins", spec.id);

  if (spec.pluginHookCompat) {
    if (!(await pathExists(skillsDir))) {
      return;
    }
    if (dryRun) {
      console.log(
        t.dryRun(
          `symlink ${pluginsDir} -> ${skillsDir} (upstream Stop hook expects plugins/)`,
        ),
      );
      return;
    }
    await fs.rm(pluginsDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.dirname(pluginsDir), { recursive: true });
    if (process.platform === "win32") {
      await fs.symlink(skillsDir, pluginsDir, "junction");
    } else {
      const rel = path.relative(path.dirname(pluginsDir), skillsDir);
      await fs.symlink(rel, pluginsDir, "dir");
    }
    return;
  }

  if (skillInstallRootSegment(spec) !== "plugins") {
    return;
  }
  if (!(await pathExists(pluginsDir))) {
    return;
  }
  if (dryRun) {
    console.log(
      t.dryRun(`symlink ${skillsDir} -> ${pluginsDir} (skill discovery alias)`),
    );
    return;
  }

  await fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.dirname(skillsDir), { recursive: true });
  if (process.platform === "win32") {
    await fs.symlink(pluginsDir, skillsDir, "junction");
  } else {
    const rel = path.relative(path.dirname(skillsDir), pluginsDir);
    await fs.symlink(rel, skillsDir, "dir");
  }
}

async function cleanupStaleStagingDirs(homes) {
  const cleaned = [];

  for (const homeDir of Object.values(homes)) {
    for (const segment of ["skills", "plugins"]) {
      const installRoot = path.join(homeDir, segment);
      if (!(await pathExists(installRoot))) continue;

      let entries;
      try {
        entries = await fs.readdir(installRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.includes(".staged-")) {
          continue;
        }

        const stagedPath = path.join(installRoot, entry.name);
        console.warn(`${C.yellow}⚠${C.reset} ${t.warnRemovingObsoleteDir}`);
        console.warn(
          `${C.dim}  ${stagedPath}${C.reset} — ${t.warnStaleStagingResidual}`,
        );
        if (!dryRun) {
          try {
            await fs.rm(stagedPath, { recursive: true, force: true });
          } catch (rmError) {
            if (isWindowsLockError(rmError)) {
              console.warn(
                `${C.yellow}⚠${C.reset} ${t.warnStagingLocked(stagedPath)}`,
              );
              continue;
            }
            throw rmError;
          }
        }
        cleaned.push(stagedPath);
      }
    }
  }

  if (cleaned.length > 0) {
    console.log(
      `${C.green}✓${C.reset} ${t.okRemovedStagingResidual(cleaned.length)}`,
    );
  }
}

async function cleanupClaudeNativePluginSkillResidue(homes, activeTargets) {
  if (!activeTargets.includes("claude") || !homes.claude) {
    return;
  }

  const specs = SKILL_REPOS.filter((spec) => spec.claudePlugin);
  for (const spec of specs) {
    const candidateNames = [spec.id, ...(spec.legacyNames || [])];
    for (const candidateName of candidateNames) {
      const targetDir = path.join(homes.claude, "skills", candidateName);
      if (!(await detectPluginBundleSkillResidue(targetDir))) {
        continue;
      }

      assertUnderHome(targetDir);
      console.warn(
        `${C.yellow}⚠${C.reset} ${spec.id}: removing legacy Claude plugin bundle residue from skills discovery path`,
      );
      console.warn(`${C.dim}  ${targetDir}${C.reset}`);
      if (dryRun) {
        console.log(t.dryRun(`remove legacy plugin residue: ${targetDir}`));
        continue;
      }

      try {
        await rmDirWithRetry(targetDir);
      } catch (error) {
        if (isWindowsLockError(error)) {
          console.warn(`${C.yellow}⚠${C.reset} ${t.warnStagingLocked(targetDir)}`);
          continue;
        }
        throw error;
      }
    }
  }
}

// ── Two-phase install helpers ─────────────────────────────────

async function cleanupLegacySkillNames(runtimeHome, spec) {
  const legacyNames = spec.legacyNames;
  if (!legacyNames || legacyNames.length === 0) return;
  const installSegment = skillInstallRootSegment(spec);
  for (const legacyName of legacyNames) {
    const legacyDir = path.join(runtimeHome, installSegment, legacyName);
    if (!(await pathExists(legacyDir))) continue;
    if (dryRun) {
      console.log(t.dryRun(`remove legacy skill dir: ${legacyDir}`));
      continue;
    }
    try {
      const stat = await fs.lstat(legacyDir);
      if (stat.isSymbolicLink()) await fs.unlink(legacyDir);
      else await rmDirWithRetry(legacyDir);
      console.log(
        `${C.green}✓${C.reset} ${t.warnLegacyNameRemoved(spec.id, legacyName, legacyDir)}`,
      );
    } catch (error) {
      if (isWindowsLockError(error)) {
        console.warn(`${C.yellow}⚠${C.reset} ${t.warnStagingLocked(legacyDir)}`);
        continue;
      }
      console.warn(
        `${C.yellow}⚠${C.reset} ${spec.id}: failed to remove legacy "${legacyName}" at ${legacyDir}: ${error.message}`,
      );
    }
  }
}

/**
 * Remove stale .disabled/{skillId}/ residue after a skill is successfully installed/updated.
 * When a skill was previously disabled and then reinstalled, the old disabled copy should
 * not linger alongside the active version.
 *
 * @param {string} runtimeHome - The runtime home directory (e.g. ~/.codex)
 * @param {string} skillId - The skill identifier
 */
async function cleanupDisabledSkillResidue(runtimeHome, skillId) {
  const installSegments = ["skills", "plugins"];

  for (const segment of installSegments) {
    const disabledDir = path.join(runtimeHome, segment, ".disabled", skillId);
    if (!(await pathExists(disabledDir))) {
      continue;
    }

    if (dryRun) {
      console.log(t.dryRun(`remove disabled residue: ${disabledDir}`));
      continue;
    }

    try {
      const stat = await fs.lstat(disabledDir);
      if (stat.isSymbolicLink()) {
        await fs.unlink(disabledDir);
      } else {
        await rmDirWithRetry(disabledDir);
      }
      console.log(
        `${C.green}✓${C.reset} ${t.warnDisabledResidueRemoved(skillId, disabledDir)}`,
      );
    } catch (error) {
      if (isWindowsLockError(error)) {
        console.warn(
          `${C.yellow}⚠${C.reset} ${t.warnStagingLocked(disabledDir)}`,
        );
        continue;
      }
      console.warn(
        `${C.yellow}⚠${C.reset} ${skillId}: failed to remove .disabled/ residue at ${disabledDir}: ${error.message}`,
      );
    }
  }
}

/**
 * Sweep .disabled/ directories under skills/ and plugins/ for any entries
 * that have an active counterpart (same name exists in the parent segment).
 * This catches residue from skills deployed outside the manifest (e.g. meta-theory
 * via sync:runtimes) that would not be covered by per-skill cleanup.
 */
async function sweepStaleDisabledDirs(runtimeHome) {
  const segments = ["skills", "plugins"];

  for (const segment of segments) {
    const disabledRoot = path.join(runtimeHome, segment, ".disabled");
    if (!(await pathExists(disabledRoot))) continue;

    let entries;
    try {
      entries = await fs.readdir(disabledRoot);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const activeDir = path.join(runtimeHome, segment, entry);
      const disabledDir = path.join(disabledRoot, entry);

      if (!(await pathExists(activeDir))) continue;

      if (dryRun) {
        console.log(t.dryRun(`remove stale disabled: ${disabledDir}`));
        continue;
      }

      try {
        const stat = await fs.lstat(disabledDir);
        if (stat.isSymbolicLink()) {
          await fs.unlink(disabledDir);
        } else if (stat.isDirectory()) {
          await rmDirWithRetry(disabledDir);
        }
        console.log(
          `${C.green}✓${C.reset} ${t.warnDisabledResidueRemoved(entry, disabledDir)}`,
        );
      } catch (error) {
        if (isWindowsLockError(error)) {
          console.warn(
            `${C.yellow}⚠${C.reset} ${t.warnStagingLocked(disabledDir)}`,
          );
          continue;
        }
        console.warn(
          `${C.yellow}⚠${C.reset} ${entry}: failed to sweep .disabled/ at ${disabledDir}: ${error.message}`,
        );
      }
    }

    // Remove .disabled/ dir itself if now empty
    try {
      const remaining = await fs.readdir(disabledRoot);
      if (remaining.length === 0 && !dryRun) {
        await fs.rmdir(disabledRoot);
      }
    } catch {
      // non-fatal
    }
  }
}

/**
 * Clone a skill repo to the staging directory, skipping download if the skill
 * already exists at preExistingPath (first target runtime's install location).
 * This avoids redundant git clones in multi-runtime mode when skills are
 * already deployed to at least one runtime.
 * @param {boolean} skipIfExisting - when true, skip clone if preExistingPath is populated (non-update mode).
 *   When false (update mode), always clone even if skill already exists at a runtime.
 */
async function stageSkillClone(
  skillId,
  stagedPath,
  repoUrl,
  preExistingPath,
  skipIfExisting,
) {
  // Skip download if the skill already exists at a target runtime (non-update mode).
  // In update mode, skipIfExisting is false so this block is bypassed and we always re-clone.
  if (
    skipIfExisting &&
    preExistingPath &&
    (await pathExists(preExistingPath)) &&
    !(await isEmptyDir(preExistingPath))
  ) {
    return true;
  }

  if ((await pathExists(stagedPath)) && !(await isEmptyDir(stagedPath))) {
    return true;
  }

  await fs.mkdir(path.dirname(stagedPath), { recursive: true });
  try {
    await runGitAsync(
      ["clone", "--progress", "--depth", "1", repoUrl, stagedPath],
      {
        skillLabel: t.gitRetryLabelStaging(skillId),
        cloneProgress: { skillId, rootPath: stagedPath },
      },
    );
    return true;
  } catch (error) {
    await handleGitFailure({ skillId, targetDir: stagedPath, repoUrl, error });
    return (await pathExists(stagedPath)) && !(await isEmptyDir(stagedPath));
  }
}

async function stageSkillFromLocalRepo(
  skillId,
  stagedPath,
  localRepoPath,
  subdirPath = null,
  preExistingPath,
  skipIfExisting,
) {
  if (
    skipIfExisting &&
    preExistingPath &&
    (await pathExists(preExistingPath)) &&
    !(await isEmptyDir(preExistingPath))
  ) {
    return true;
  }

  if ((await pathExists(stagedPath)) && !(await isEmptyDir(stagedPath))) {
    return true;
  }

  const sourcePath = subdirPath
    ? path.join(localRepoPath, ...subdirPath.split("/").filter(Boolean))
    : localRepoPath;

  if (dryRun) {
    console.log(
      t.dryRun(`stage local ${sourcePath} -> ${stagedPath}`),
    );
    return true;
  }

  if (!(await pathExists(sourcePath))) {
    throw new Error(`Local dependency source missing for ${skillId}: ${sourcePath}`);
  }
  await fs.mkdir(path.dirname(stagedPath), { recursive: true });
  await fs.cp(sourcePath, stagedPath, { recursive: true, force: true });
  return true;
}

/**
 * Stage a skill from a repo subdir (sparse checkout) to staging.
 * Skips download if preExistingPath already contains the skill.
 * Returns true if staging succeeded.
 * @param {boolean} skipIfExisting - when true, skip clone if preExistingPath is populated (non-update mode).
 *   When false (update mode), always clone even if skill already exists at a runtime.
 */
async function stageSkillFromSubdir(
  skillId,
  stagedPath,
  repoUrl,
  subdirPath,
  preExistingPath,
  skipIfExisting,
) {
  // Skip download if the skill already exists at a target runtime (non-update mode).
  // In update mode, skipIfExisting is false so this block is bypassed and we always re-clone.
  if (
    skipIfExisting &&
    preExistingPath &&
    (await pathExists(preExistingPath)) &&
    !(await isEmptyDir(preExistingPath))
  ) {
    return true;
  }

  if ((await pathExists(stagedPath)) && !(await isEmptyDir(stagedPath))) {
    return true;
  }

  if (dryRun) {
    console.log(
      t.dryRun(`stage sparse ${repoUrl} (${subdirPath}) -> ${stagedPath}`),
    );
    return true;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-skill-"));
  try {
    await runGitAsync(
      [
        "clone",
        "--progress",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        repoUrl,
        tmp,
      ],
      {
        skillLabel: t.gitRetryLabelStaging(skillId),
        cloneProgress: { skillId, rootPath: tmp },
      },
    );
    await runGitAsync(["sparse-checkout", "set", subdirPath], {
      cwd: tmp,
      skillLabel: `checkout ${skillId}`,
    });
    const src = path.join(tmp, ...subdirPath.split("/").filter(Boolean));
    if (!(await pathExists(src))) {
      throw new Error(`Sparse checkout path missing: ${src}`);
    }
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.cp(src, stagedPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    let recovered = false;
    if (existsSync(tmp) && isGitWorkTreeReady(tmp)) {
      try {
        await runGitAsync(["sparse-checkout", "set", subdirPath], {
          cwd: tmp,
          skillLabel: `${t.gitRetryLabelStaging(skillId)} (recover)`,
        });
        const srcRecover = path.join(
          tmp,
          ...subdirPath.split("/").filter(Boolean),
        );
        if (await pathExists(srcRecover)) {
          await fs.mkdir(path.dirname(stagedPath), { recursive: true });
          await fs.cp(srcRecover, stagedPath, { recursive: true, force: true });
          recovered = true;
        }
      } catch {
        // fall through to handleGitFailure
      }
    }
    if (!recovered) {
      await handleGitFailure({
        skillId,
        targetDir: stagedPath,
        repoUrl,
        subdirPath,
        error,
      });
    }
    return (
      recovered ||
      ((await pathExists(stagedPath)) && !(await isEmptyDir(stagedPath)))
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Deploy a staged skill to a runtime's skills directory.
 * Handles existing targets, repair, and sanitization.
 */
async function deployStagedSkill(stagedPath, targetDir, skillId, subdirPath) {
  assertUnderHome(targetDir);

  if (!(await pathExists(stagedPath)) || (await isEmptyDir(stagedPath))) {
    return false;
  }

  await repairManagedSkillTarget({
    skillId,
    targetDir,
    subdirPath,
    allowDelete: true,
  });

  const targetExists = await pathExists(targetDir);
  const targetEmpty = targetExists && (await isEmptyDir(targetDir));

  if (targetExists && !targetEmpty && !updateMode) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}${t.skipExists(targetDir)}${C.reset}`,
    );
    await sanitizeManagedSkillTarget(skillId, targetDir);
    return true;
  }

  if (targetExists && !targetEmpty && await directoryContentEqual(stagedPath, targetDir)) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}${t.skipExists(targetDir)}${C.reset}`,
    );
    return true;
  }

  const stagedCopy = await createSiblingStagingDir(targetDir);
  try {
    await fs.cp(stagedPath, stagedCopy, { recursive: true, force: true });
    if ((await pathExists(stagedCopy)) && !(await isEmptyDir(stagedCopy))) {
      await replaceTargetDir(targetDir, stagedCopy);
      console.log(
        `${C.green}✓${C.reset} ${t.okBasename(path.basename(targetDir), targetDir)}`,
      );
    }
  } finally {
    await rmDirBestEffortLocked(stagedCopy);
  }

  await sanitizeManagedSkillTarget(skillId, targetDir);
  return true;
}

/**
 * Two-phase install: stage each skill repo once, then deploy to all runtimes.
 * Avoids redundant git clones when multiple runtimes are active.
 */
async function installSkillsToMultipleRuntimes(
  targetRuntimeIds,
  homes,
  runtimeLabels,
) {
  const stagingRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "meta-kim-staging-"),
  );

  try {
    // Phase 0: Find pre-existing installs to avoid redundant downloads.
    // If a skill already exists at the first target runtime, the staging
    // functions can skip cloning and Phase 2 can copy from that location.
    const alreadyExists = new Map();
    for (const spec of SKILL_REPOS) {
      if (!usesGenericSkillInstall(spec))
        continue; // plugin bundles handled separately
      const applicableRuntimes = targetRuntimeIds.filter(
        (id) => !spec.targets || spec.targets.includes(id),
      );
      if (applicableRuntimes.length === 0) continue;
      // Check the first runtime as the canonical "already installed" source.
      const firstRuntimeId = applicableRuntimes[0];
      const firstRuntimeHome = homes[firstRuntimeId];
      const candidate = resolveSkillTargetDir(
        firstRuntimeHome,
        spec,
        firstRuntimeId,
      );
      if ((await pathExists(candidate)) && !(await isEmptyDir(candidate))) {
        alreadyExists.set(spec.id, candidate);
      }
    }

    // Phase 1: Stage each unique skill repo in parallel (silent unless actual cloning happens)

    const limitClone = createConcurrencyLimiter(MAX_CONCURRENT_CLONES);

    const stagePromises = SKILL_REPOS.filter((spec) => {
      if (!usesGenericSkillInstall(spec)) return false;
      if (spec.id === "meta-skill-creator") return false;
      const needs = targetRuntimeIds.filter(
        (id) => !spec.targets || spec.targets.includes(id),
      );
      return needs.length > 0;
    }).map((spec) =>
      limitClone(async () => {
        const stagedPath = path.join(stagingRoot, spec.id);
        const preExistingPath = alreadyExists.get(spec.id);
        const fixtureSource =
          spec.id === "meta-skill-creator" ? testMetaSkillSourceDir() : null;
        if (fixtureSource) {
          await fs.cp(fixtureSource, stagedPath, { recursive: true, force: true });
          return { id: spec.id, success: true, stagedPath };
        }
        const success = spec.localRepoPath
          ? await stageSkillFromLocalRepo(
              spec.id,
              stagedPath,
              spec.localRepoPath,
              spec.subdir,
              preExistingPath,
              !updateMode,
            )
          : spec.subdir
          ? await stageSkillFromSubdir(
              spec.id,
              stagedPath,
              spec.repo,
              spec.subdir,
              preExistingPath,
              !updateMode,
            )
          : await stageSkillClone(
              spec.id,
              stagedPath,
              spec.repo,
              preExistingPath,
              !updateMode,
            );
        return { id: spec.id, success, stagedPath };
      }),
    );

    const stagedSkills = new Map();
    const stageResults = await Promise.allSettled(stagePromises);
    for (const result of stageResults) {
      if (result.status === "fulfilled") {
        stagedSkills.set(result.value.id, result.value);
      }
    }

    // Sanitize each staged tree once (hook path fixes, etc.) so Phase 2 copies are clean
    // and we do not repeat the same warning per runtime.
    for (const spec of SKILL_REPOS) {
      const staged = stagedSkills.get(spec.id);
      if (!staged?.success) continue;
      if (
        !(await pathExists(staged.stagedPath)) ||
        (await isEmptyDir(staged.stagedPath))
      ) {
        continue;
      }
      await sanitizeManagedSkillTarget(spec.id, staged.stagedPath);
    }

    // Phase 2: Deploy staged skills to each runtime
    for (const runtimeId of targetRuntimeIds) {
      const runtimeHome = homes[runtimeId];
      const skillsRoot = path.join(runtimeHome, "skills");
      const label = runtimeLabels[runtimeId] || `${runtimeId} skills`;
      assertUnderHome(skillsRoot);
      await fs.mkdir(skillsRoot, { recursive: true });
      await fs.mkdir(path.join(runtimeHome, "plugins"), { recursive: true });

      let hasOutput = false;
      const emitHeader = () => {
        if (hasOutput) return;
        hasOutput = true;
        console.log(
          `\n${C.bold}${AMBER}${t.skillsHeader(label, runtimeHome)}${C.reset}`,
        );
      };

      for (const spec of SKILL_REPOS) {
        if (!usesGenericSkillInstall(spec))
          continue; // plugin bundles handled separately
        if (spec.id === "meta-skill-creator") continue;
        if (spec.targets && !spec.targets.includes(runtimeId)) {
          continue;
        }

        const staged = stagedSkills.get(spec.id);
        const targetDir = resolveSkillTargetDir(runtimeHome, spec, runtimeId);
        await cleanupLegacySkillNames(runtimeHome, spec);
        // staged?.success can be true even when stagedPath is empty (skip-clone
        // when skill already exists at first runtime). In that case fall through
        // to direct install so "already exists" output is printed.
        const stagedPathExists =
          staged?.success &&
          (await pathExists(staged.stagedPath)) &&
          !(await isEmptyDir(staged.stagedPath));

        if (stagedPathExists) {
          emitHeader();
          await deployStagedSkill(
            staged.stagedPath,
            targetDir,
            spec.id,
            spec.subdir,
          );
        } else {
          // Staging skipped or failed: fall back to direct per-runtime install
          emitHeader();
          if (spec.subdir) {
            await installGitSkillFromSubdir(
              spec.id,
              targetDir,
              spec.repo,
              spec.subdir,
            );
          } else {
            await installGitSkill(spec.id, targetDir, spec.repo);
          }
        }

        await deployRuntimeHookSupport(spec, runtimeHome, runtimeId, skillsRoot);
        await cleanupDisabledSkillResidue(runtimeHome, spec.id);
      }

      if (!hasOutput) {
        console.log(
          `\n${C.green}✓${C.reset} ${C.dim}${t.allUpToDate(label)}${C.reset}`,
        );
      }
    }
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  const { activeTargets } = await resolveTargetContext(cliArgs);
  const homes = resolveHomes();

  for (const runtimeId of activeTargets) {
    if (homes[runtimeId]) {
      await assertRealPathContained(os.homedir(), homes[runtimeId]);
    }
  }

  if (strippedLoopbackProxyEnv.length > 0) {
    console.warn(
      `${C.yellow}⚠${C.reset} ${t.warnIgnoringLoopbackProxyEnv(strippedLoopbackProxyEnv)}`,
    );
  }

  // Clean up known legacy artifacts before any install operations
  await cleanupLegacyGlobalArtifacts(homes);
  await cleanupStaleStagingDirs(homes);

  const metaSkillCreatorSpec = SKILL_REPOS.find(
    (spec) => spec.id === "meta-skill-creator" && usesGenericSkillInstall(spec),
  );
  if (!pluginsOnly && metaSkillCreatorSpec) {
    await installMetaSkillCreatorAcrossRuntimes(
      homes,
      activeTargets,
      metaSkillCreatorSpec,
    );
  }

  if (!pluginsOnly) {
    const runtimeLabels = {
      claude: t.skillsRuntimeSectionClaude,
      codex: t.skillsRuntimeSectionCodex,
      openclaw: t.skillsRuntimeSectionOpenclaw,
      cursor: t.skillsRuntimeSectionCursor,
    };

    const targetRuntimeIds = activeTargets.filter(
      (id) =>
        homes[id] !== undefined &&
        SKILL_REPOS.some(
          (spec) =>
            usesGenericSkillInstall(spec) &&
            spec.id !== "meta-skill-creator" &&
            (!spec.targets || spec.targets.includes(id)),
        ),
    );

    if (targetRuntimeIds.length === 1) {
      // Single runtime: install directly (no staging overhead)
      const rid = targetRuntimeIds[0];
      await installAllSkillsForRuntime(runtimeLabels[rid], homes[rid], rid);
    } else if (targetRuntimeIds.length > 1) {
      // Multiple runtimes: clone once, deploy everywhere
      await installSkillsToMultipleRuntimes(
        targetRuntimeIds,
        homes,
        runtimeLabels,
      );
    }
  }

  if (activeTargets.includes("claude")) {
    const claudePluginsReady = await installClaudePlugins();
    if (claudePluginsReady) {
      await cleanupClaudeNativePluginSkillResidue(homes, activeTargets);
    }
  }
  await installUpstreamCliSpecs(homes, activeTargets);
  await installPluginBundlesForNonClaudeRuntimes(homes, activeTargets);
  await ensureCodexChoiceSurfaceAfterInstall(homes, activeTargets);
  if (!skipInventoryRefresh) refreshGlobalCapabilityInventory(activeTargets);

  // Optional: graphify (code knowledge graph)
  if (!pluginsOnly && process.env.META_KIM_SKIP_OPTIONAL_TOOLS !== "1") {
    console.log(`\n${C.bold}${AMBER}${t.pythonToolsOptionalHeader}${C.reset}`);

    // Detect Python: prefer already-activated venv (VIRTUAL_ENV), fall back to probe.
    // This respects the user's venv without disturbing it — pip install goes to the
    // active venv if one is present.
    let python = detectPython310();
    const venvPath = process.env.VIRTUAL_ENV;

    if (venvPath) {
      // A venv is already active. Resolve its python directly.
      // Windows: <venv>/Scripts/python.exe | macOS/Linux: <venv>/bin/python
      const pathSep = process.platform === "win32" ? "\\" : "/";
      const venvBin =
        venvPath + pathSep + (process.platform === "win32" ? "Scripts" : "bin");
      const venvPython =
        venvBin +
        pathSep +
        (process.platform === "win32" ? "python.exe" : "python");

      const venvCheck = spawnSync(venvPython, ["--version"], {
        encoding: "utf8",
      });
      if (venvCheck?.status === 0) {
        const parsed = parsePythonVersion(
          venvCheck.stdout || venvCheck.stderr || "",
        );
        if (
          parsed &&
          (parsed.major > 3 || (parsed.major === 3 && parsed.minor >= 10))
        ) {
          python = {
            command: venvPython,
            args: [],
            version: parsed,
            versionText:
              venvCheck.stdout?.trim() || venvCheck.stderr?.trim() || "",
          };
          console.log(`${C.dim}  ${t.usingActiveVenv(venvPath)}${C.reset}`);
        } else {
          console.warn(
            `${C.yellow}⚠${C.reset} ${C.dim}${t.venvTooOldFallback(venvPath, parsed?.raw ?? "unknown")}${C.reset}`,
          );
        }
      }
    }

    if (!python) {
      console.log(t.pythonNotFoundGraphify);
      console.log(t.pythonInstallHintGraphify);
    } else {
      const ensureGraphifyWiring = () => {
        if (guideAlreadyHasGraphifySection("claude")) {
          console.log(
            `${C.yellow}⊘${C.reset} ${C.dim}${t.graphifyInstallSkippedGuideExists("claude")}${C.reset}`,
          );
        } else {
          runPythonModule(
            python,
            ["-m", "graphify", "claude", "install"],
            undefined,
            { stdio: "pipe" },
          );
        }
        runPythonModule(
          python,
          ["-m", "graphify", "hook", "install"],
          undefined,
          { stdio: "pipe" },
        );
      };

      // Check if graphify already installed via pip show (more reliable than --version)
      const pipShow = runPythonModule(python, [
        "-m",
        "pip",
        "show",
        "graphifyy",
      ]);
      if (pipShow.status === 0) {
        const version =
          extractPipShowVersion(readProcessText(pipShow)) ?? "unknown";
        console.log(`${C.yellow}⊘${C.reset} ${C.dim}${t.skipGraphifyInstalled(version)}${C.reset}`);
        ensureGraphifyWiring();
      } else {
        console.log(t.installingGraphify);
        const pipResult = runPythonModule(
          python,
          ["-m", "pip", "install", "graphifyy"],
          undefined,
          { stdio: "pipe" },
        );
        if (pipResult.status === 0) {
          ensureGraphifyWiring();
          console.log(t.okGraphifyInstalled);
        } else {
          console.warn(`${C.yellow}⚠${C.reset} ${t.warnGraphifyPipFailed}`);
        }
      }
    }
  }

  // Print failure summary if any skills failed
  const FAILURE_CATEGORIES = [
    "tls_transport",
    "repo_not_found",
    "auth_required",
    "subdir_missing",
    "proxy_network",
    "permission_denied",
    "missing_runtime",
    "unknown",
  ];

  function failureHint(category) {
    const key = `failureHint_${category}`;
    return t[key] || t.failureHint_unknown;
  }

  if (installFailures.length > 0) {
    console.log(
      `\n${C.yellow}${C.bold}${t.summaryInstallFailures(installFailures.length)}${C.reset}`,
    );
    for (const failure of installFailures) {
      const category = failure.category || "unknown";
      console.log(
        `${C.red}✗${C.reset} ${failure.skillId} — ${failureHint(category)}`,
      );
    }
    // Show unique actionable suggestions
    const uniqueCats = [
      ...new Set(installFailures.map((f) => f.category || "unknown")),
    ];
    console.log(`\n${C.bold}${t.failureSuggestions}${C.reset}`);
    for (const cat of uniqueCats) {
      console.log(`${C.dim}•${C.reset} ${failureHint(cat)}`);
    }
    process.exitCode = 1;
  }
  if (archiveFallbacks.length > 0) {
    console.log(
      `\n${C.yellow}${t.summaryArchiveFallbacks(archiveFallbacks.length)}${C.reset}`,
    );
    for (const fb of archiveFallbacks) {
      console.log(
        `${C.yellow}⚠${C.reset} ${C.dim}${t.summaryArchiveFallbackLine(fb.skillId, fb.category)}${C.reset}`,
      );
    }
    console.log(`${C.dim}${t.summaryArchiveFallbackScopeNote}${C.reset}`);
  }

  if (repairedInstallRoots.length > 0) {
    console.log(
      `\n${C.yellow}${t.summaryRepairedOrFlagged(repairedInstallRoots.length)}${C.reset}`,
    );
    for (const repair of repairedInstallRoots) {
      console.log(
        `${C.yellow}⚠${C.reset} ${repair.skillId} -> ${repair.action} (${repair.targetDir})`,
      );
    }
  }
  if (sanitizedSkillIssues.length > 0) {
    console.log(
      `\n${C.yellow}${t.summaryQuarantined(sanitizedSkillIssues.reduce((sum, item) => sum + item.quarantined, 0))}${C.reset}`,
    );
    for (const item of sanitizedSkillIssues) {
      console.log(
        `${C.yellow}⚠${C.reset} ${item.skillId} -> ${item.quarantined} file(s) in ${item.targetDir}`,
      );
    }

    const allHookFixes = sanitizedSkillIssues.flatMap(
      (item) => item.hookPathFixes || [],
    );
    const loudHookFixes = allHookFixes
      .map((patch) => ({
        ...patch,
        fixes: (patch.fixes || []).filter((f) => !f.silent),
      }))
      .filter((patch) => patch.fixes.length > 0);
    if (loudHookFixes.length > 0) {
      console.log(
        `\n${C.yellow}⚠ Hook path auto-fixed during install:${C.reset}`,
      );
      for (const patch of loudHookFixes) {
        for (const fix of patch.fixes) {
          console.log(`${C.yellow}  •${C.reset} ${fix.skill}: ${fix.reason}`);
        }
      }
    }
  }

  // Sweep stale .disabled/ entries (covers skills deployed outside the manifest,
  // e.g. meta-theory via sync:runtimes)
  for (const rid of activeTargets) {
    if (homes[rid]) {
      await sweepStaleDisabledDirs(homes[rid]);
    }
  }

  console.log(`\n${t.done}`);
  console.log(t.noteCodexOpenclaw);
  console.log(t.activeTargets(activeTargets));
  console.log(t.metaKimRoot(repoRoot));

  // // Print log file path if logging was active
  // if (logFileResolved) {
  //   console.log(`\n${C.cyan}📋 ${t.logSaved(logFileResolved)}${C.reset}`);
  // }
}

// ========== Hook Co-Deployment ==========

async function deployHookSubdirs(spec, runtimeHome, runtimeId) {
  const hookSubdirs = spec.hookSubdirs;
  if (!hookSubdirs || !hookSubdirs[runtimeId]) return;

  const subdirs = hookSubdirs[runtimeId];
  if (!Array.isArray(subdirs) || subdirs.length === 0) return;

  const hooksDir = path.join(runtimeHome, "hooks");
  if (!dryRun) {
    await fs.mkdir(hooksDir, { recursive: true });
  }

  for (const hookSubdir of subdirs) {
    if (dryRun) {
      console.log(
        t.dryRun(
          `git sparse-checkout ${spec.repo}:${hookSubdir} -> ${hooksDir}`,
        ),
      );
      continue;
    }
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-hook-"));
    try {
      await runGitAsync(
        [
          "clone",
          "--depth",
          "1",
          "--filter=blob:none",
          "--sparse",
          spec.repo,
          tmp,
        ],
        { skillLabel: `${spec.id}-hooks (${runtimeId})` },
      );
      await runGitAsync(["sparse-checkout", "set", hookSubdir], { cwd: tmp });
      const src = path.join(tmp, ...hookSubdir.split("/").filter(Boolean));
      if ((await pathExists(src)) && !(await isEmptyDir(src))) {
        const entries = await fs.readdir(src);
        for (const entry of entries) {
          const srcPath = path.join(src, entry);
          const destPath = path.join(hooksDir, entry);
          const stat = await fs.stat(srcPath);
          if (stat.isFile()) {
            await fs.copyFile(srcPath, destPath);
          } else if (stat.isDirectory()) {
            await fs.cp(srcPath, destPath, { recursive: true, force: true });
          }
        }
        console.log(
          `${C.green}✓${C.reset} ${spec.id} hooks -> ${hooksDir} ${C.dim}(from ${hookSubdir})${C.reset}`,
        );
      }
    } catch {
      // hook subdir absent — non-fatal
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
}

async function deployHookConfigFiles(spec, runtimeHome, runtimeId) {
  const hookConfigFiles = spec.hookConfigFiles;
  if (!hookConfigFiles || !hookConfigFiles[runtimeId]) return;

  const configFile = hookConfigFiles[runtimeId];
  if (dryRun) {
    console.log(
      t.dryRun(
        `git sparse-checkout ${spec.repo}:${configFile} -> ${runtimeHome}`,
      ),
    );
    return;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-hcfg-"));
  try {
    await runGitAsync(
      [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        spec.repo,
        tmp,
      ],
      { skillLabel: `${spec.id}-hookconfig (${runtimeId})` },
    );
    // sparse-checkout the parent dir of the config file
    const parentDir = path.dirname(configFile).replace(/\\/g, "/");
    await runGitAsync(["sparse-checkout", "set", parentDir || "."], {
      cwd: tmp,
    });
    const srcPath = path.join(tmp, ...configFile.split("/").filter(Boolean));
    if (await pathExists(srcPath)) {
      const destPath = path.join(runtimeHome, path.basename(configFile));
      if (
        spec.id === "planning-with-files" &&
        path.basename(configFile) === "hooks.json" &&
        ["codex", "cursor"].includes(runtimeId)
      ) {
        await mergePlanningHookConfigFile(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
      console.log(
        `${C.green}✓${C.reset} ${spec.id} ${path.basename(configFile)} -> ${runtimeHome} ${C.dim}(from ${configFile})${C.reset}`,
      );
    }
  } catch {
    // config file absent — non-fatal
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function normalizeHookCommand(command) {
  return String(command ?? "").replace(/\\/g, "/").trim();
}

function hookCommandAlreadyRegistered(existingBlocks, generatedHook) {
  const generatedCommand = normalizeHookCommand(generatedHook?.command);
  if (!generatedCommand) {
    return false;
  }
  return existingBlocks.some((block) =>
    (block.hooks ?? [block]).some(
      (hook) => normalizeHookCommand(hook?.command) === generatedCommand,
    ),
  );
}

function appendMissingHookBlock(existingBlocks, generatedBlock) {
  const generatedHooks = generatedBlock.hooks ?? [generatedBlock];
  const missingHooks = generatedHooks.filter(
    (hook) => !hookCommandAlreadyRegistered(existingBlocks, hook),
  );
  if (missingHooks.length === 0) {
    return existingBlocks;
  }
  if (generatedBlock.hooks && existingBlocks.length > 0) {
    const targetIndex = existingBlocks.findIndex(
      (block) => (block.matcher ?? "") === (generatedBlock.matcher ?? ""),
    );
    const index = targetIndex >= 0 ? targetIndex : 0;
    const targetBlock = existingBlocks[index];
    const targetHooks = targetBlock.hooks ?? [targetBlock];
    existingBlocks[index] = {
      ...targetBlock,
      hooks: [...targetHooks, ...missingHooks],
    };
    return existingBlocks;
  }
  return [...existingBlocks, ...missingHooks];
}

function mergePlanningHooksJson(existing, generated) {
  const next = { ...(generated ?? {}), ...(existing ?? {}) };
  next.hooks = { ...((generated ?? {}).hooks ?? {}), ...((existing ?? {}).hooks ?? {}) };
  for (const [event, generatedBlocks] of Object.entries((generated ?? {}).hooks ?? {})) {
    const existingBlocks = Array.isArray(next.hooks[event])
      ? [...next.hooks[event]]
      : [];
    const blocks = Array.isArray(generatedBlocks) ? generatedBlocks : [generatedBlocks];
    next.hooks[event] = blocks.reduce(appendMissingHookBlock, existingBlocks);
  }
  return next;
}

async function mergePlanningHookConfigFile(srcPath, destPath) {
  let generated = {};
  let existing = {};
  try {
    generated = JSON.parse(await fs.readFile(srcPath, "utf8"));
  } catch {
    await fs.copyFile(srcPath, destPath);
    return;
  }
  if (await pathExists(destPath)) {
    try {
      existing = JSON.parse(await fs.readFile(destPath, "utf8"));
    } catch {
      existing = {};
    }
  }
  const merged = mergePlanningHooksJson(existing, generated);
  await fs.writeFile(destPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

function codexPlanningHookCommand(runtimeHome, scriptName) {
  const nodePath = process.execPath;
  const scriptPath = path.join(runtimeHome, "hooks", scriptName);
  const runnerPath = path.join(runtimeHome, "hooks", "codex_hook_runner.mjs");
  const shellToken = (value) =>
    /[\s"]/u.test(value) ? JSON.stringify(value) : value;
  return `${shellToken(nodePath)} ${shellToken(runnerPath)} ${shellToken(scriptPath)}`;
}

function buildCodexPlanningHooksJson(runtimeHome) {
  return {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            {
              type: "command",
              command: codexPlanningHookCommand(runtimeHome, "session_start.py"),
              statusMessage: "Loading planning context",
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command: codexPlanningHookCommand(
                runtimeHome,
                "user_prompt_submit.py",
              ),
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: codexPlanningHookCommand(runtimeHome, "pre_tool_use.py"),
              statusMessage: "Checking plan before Bash",
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: codexPlanningHookCommand(runtimeHome, "post_tool_use.py"),
              statusMessage: "Reviewing Bash against plan",
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: codexPlanningHookCommand(runtimeHome, "stop.py"),
              timeout: 30,
            },
          ],
        },
      ],
    },
  };
}

function hookCommandContains(block, marker) {
  return (block.hooks ?? [block]).some((hook) =>
    String(hook.command ?? "").includes(marker),
  );
}

function mergeCodexPlanningHooksJson(existing, generated) {
  const next = { ...(existing ?? {}), hooks: { ...((existing ?? {}).hooks ?? {}) } };
  for (const [event, generatedBlocks] of Object.entries(generated.hooks ?? {})) {
    const existingBlocks = Array.isArray(next.hooks[event])
      ? [...next.hooks[event]]
      : [];
    for (const generatedBlock of generatedBlocks) {
      const generatedHooks = generatedBlock.hooks ?? [generatedBlock];
      const missingHooks = generatedHooks.filter((hook) => {
        const marker = path.basename(String(hook.command ?? ""));
        return marker && !existingBlocks.some((block) => hookCommandContains(block, marker));
      });
      if (missingHooks.length === 0) {
        continue;
      }

      const matcher = generatedBlock.matcher;
      const targetIndex = existingBlocks.findIndex((block) =>
        matcher ? block.matcher === matcher : !block.matcher,
      );
      if (targetIndex >= 0) {
        const target = existingBlocks[targetIndex];
        existingBlocks[targetIndex] = {
          ...target,
          hooks: [...(target.hooks ?? []), ...missingHooks],
        };
      } else {
        existingBlocks.push({
          ...generatedBlock,
          hooks: missingHooks,
        });
      }
    }
    next.hooks[event] = existingBlocks;
  }
  return next;
}

function buildCodexPlanningHookAdapterPy() {
  return [
    "#!/usr/bin/env python3",
    "from __future__ import annotations",
    "",
    "import json",
    "import re",
    "import shutil",
    "import subprocess",
    "import sys",
    "from pathlib import Path",
    "from typing import Any",
    "",
    "",
    "HOOK_DIR = Path(__file__).resolve().parent",
    "",
    "",
    "def load_payload() -> dict[str, Any]:",
    "    raw = sys.stdin.read().strip()",
    "    if not raw:",
    "        return {}",
    "    try:",
    "        payload = json.loads(raw)",
    "    except json.JSONDecodeError:",
    "        return {}",
    "    return payload if isinstance(payload, dict) else {}",
    "",
    "",
    "def cwd_from_payload(payload: dict[str, Any]) -> Path:",
    '    cwd = payload.get("cwd")',
    "    if isinstance(cwd, str) and cwd:",
    "        return Path(cwd)",
    "    return Path.cwd()",
    "",
    "",
    "def emit_json(payload: dict[str, Any]) -> None:",
    "    if not payload:",
    "        return",
    "    json.dump(payload, sys.stdout, ensure_ascii=False)",
    '    sys.stdout.write("\\n")',
    "",
    "",
    "def parse_json(text: str) -> dict[str, Any]:",
    "    if not text.strip():",
    "        return {}",
    "    try:",
    "        payload = json.loads(text)",
    "    except json.JSONDecodeError:",
    "        return {}",
    "    return payload if isinstance(payload, dict) else {}",
    "",
    "",
    "def _read_lines(path: Path) -> list[str]:",
    "    try:",
    '        return path.read_text(encoding="utf-8", errors="replace").splitlines()',
    "    except OSError:",
    "        return []",
    "",
    "",
    "def _head(path: Path, count: int) -> str:",
    '    return "\\n".join(_read_lines(path)[:count])',
    "",
    "",
    "def _tail(path: Path, count: int) -> str:",
    '    return "\\n".join(_read_lines(path)[-count:])',
    "",
    "",
    "def _count_statuses(plan_file: Path) -> tuple[int, int, int, int]:",
    "    lines = _read_lines(plan_file)",
    '    total = sum(1 for line in lines if re.match(r"^#{2,3}\\s+Phase\\b", line))',
    '    complete_primary = sum(1 for line in lines if "**Status:** complete" in line)',
    '    in_progress_primary = sum(1 for line in lines if "**Status:** in_progress" in line)',
    '    pending_primary = sum(1 for line in lines if "**Status:** pending" in line)',
    '    complete_inline = sum(1 for line in lines if "[complete]" in line)',
    '    in_progress_inline = sum(1 for line in lines if "[in_progress]" in line)',
    '    pending_inline = sum(1 for line in lines if "[pending]" in line)',
    "    complete = max(complete_primary, complete_inline)",
    "    in_progress = max(in_progress_primary, in_progress_inline)",
    "    pending = max(pending_primary, pending_inline)",
    "    return total, complete, in_progress, pending",
    "",
    "",
    "def _native_user_prompt_submit(cwd: Path) -> tuple[str, str]:",
    '    plan_file = cwd / "task_plan.md"',
    "    if not plan_file.is_file():",
    '        return "", ""',
    "    parts = [",
    '        "[planning-with-files] ACTIVE PLAN -- current state:",',
    "        _head(plan_file, 50),",
    '        "",',
    '        "=== recent progress ===",',
    '        _tail(cwd / "progress.md", 20),',
    '        "",',
    '        "[planning-with-files] Read findings.md for research context. Continue from the current phase.",',
    "    ]",
    '    return "\\n".join(parts).strip(), ""',
    "",
    "",
    "def _native_session_start(cwd: Path) -> tuple[str, str]:",
    '    skill_script = HOOK_DIR.parent / "skills" / "planning-with-files" / "scripts" / "session-catchup.py"',
    "    if skill_script.is_file():",
    "        subprocess.run(",
    "            [sys.executable, str(skill_script), str(cwd)],",
    "            cwd=str(cwd),",
    "            text=True,",
    "            capture_output=True,",
    "            check=False,",
    "        )",
    '    return _native_user_prompt_submit(cwd)',
    "",
    "",
    "def _native_pre_tool_use(cwd: Path) -> tuple[str, str]:",
    '    plan_file = cwd / "task_plan.md"',
    '    stderr = _head(plan_file, 30) if plan_file.is_file() else ""',
    '    return json.dumps({"decision": "allow"}), stderr',
    "",
    "",
    "def _native_post_tool_use(cwd: Path) -> tuple[str, str]:",
    '    if (cwd / "task_plan.md").is_file():',
    '        return "[planning-with-files] Update progress.md with what you just did. If a phase is now complete, update task_plan.md status.", ""',
    '    return "", ""',
    "",
    "",
    "def _native_stop(cwd: Path) -> tuple[str, str]:",
    '    plan_file = cwd / "task_plan.md"',
    "    if not plan_file.is_file():",
    '        return "", ""',
    "    total, complete, _in_progress, _pending = _count_statuses(plan_file)",
    "    if total <= 0:",
    '        return "", ""',
    "    if complete == total and total > 0:",
    '        message = f"[planning-with-files] ALL PHASES COMPLETE ({complete}/{total}). If the user has additional work, add new phases to task_plan.md before starting."',
    "    else:",
    '        message = f"[planning-with-files] Task incomplete ({complete}/{total} phases done). Update progress.md, then read task_plan.md and continue working on the remaining phases."',
    '    return json.dumps({"followup_message": message}, ensure_ascii=False), ""',
    "",
    "",
    "def _run_native_script(script_name: str, cwd: Path) -> tuple[str, str]:",
    '    if script_name == "session-start.sh":',
    "        return _native_session_start(cwd)",
    '    if script_name == "user-prompt-submit.sh":',
    "        return _native_user_prompt_submit(cwd)",
    '    if script_name == "pre-tool-use.sh":',
    "        return _native_pre_tool_use(cwd)",
    '    if script_name == "post-tool-use.sh":',
    "        return _native_post_tool_use(cwd)",
    '    if script_name == "stop.sh":',
    "        return _native_stop(cwd)",
    '    return "", ""',
    "",
    "",
    "def run_shell_script(script_name: str, cwd: Path) -> tuple[str, str]:",
    '    sh_bin = shutil.which("sh")',
    "    script_path = HOOK_DIR / script_name",
    "    if sh_bin and script_path.is_file():",
    "        result = subprocess.run(",
    "            [sh_bin, str(script_path)],",
    "            cwd=str(cwd),",
    "            text=True,",
    "            capture_output=True,",
    "            check=False,",
    "        )",
    "        return result.stdout.strip(), result.stderr.strip()",
    "    return _run_native_script(script_name, cwd)",
    "",
    "",
    "def main_guard(func) -> int:",
    "    try:",
    "        func()",
    "    except Exception as exc:  # pragma: no cover",
    '        print(f"[planning-with-files hook] {exc}", file=sys.stderr)',
    "        return 0",
    "    return 0",
    "",
  ].join("\n");
}

export function collectWindowsPythonCandidatePaths({
  env,
  installTimeHint = null,
  pathApi,
  pathExists,
  listDirectoryNames,
}) {
  const candidates = [];
  const seen = new Set();
  const isSafe = (candidate) => {
    if (!candidate || !pathApi.isAbsolute(candidate)) return false;
    const normalized = candidate.replace(/\\/gu, "/").toLowerCase();
    if (normalized.includes("/windowsapps/")) return false;
    return /^(?:python|python3)\.exe$/iu.test(pathApi.basename(candidate));
  };
  const push = (candidate) => {
    if (!isSafe(candidate) || !pathExists(candidate)) return;
    const normalized = candidate.replace(/\\/gu, "/").toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(candidate);
  };
  const scanVersionDirectories = (root) => {
    if (!root || !pathApi.isAbsolute(root)) return;
    for (const name of listDirectoryNames(root)) {
      if (!/^Python\d+(?:-32)?$/iu.test(name)) continue;
      for (const executable of ["python.exe", "python3.exe"]) {
        push(pathApi.join(root, name, executable));
      }
    }
  };

  for (const key of ["META_KIM_PYTHON", "PYTHON", "PYTHON3"]) push(env[key]);
  push(installTimeHint?.command);
  const pathValue = env.PATH || env.Path || env.path || "";
  for (const dir of String(pathValue).split(pathApi.delimiter).filter(Boolean)) {
    if (!pathApi.isAbsolute(dir)) continue;
    for (const executable of ["python.exe", "python3.exe"]) {
      push(pathApi.join(dir, executable));
    }
  }

  if (env.LOCALAPPDATA) {
    scanVersionDirectories(pathApi.join(env.LOCALAPPDATA, "Programs", "Python"));
  }
  for (const key of ["ProgramFiles", "ProgramFiles(x86)"]) {
    if (env[key]) scanVersionDirectories(env[key]);
  }
  scanVersionDirectories("C:\\");
  return candidates;
}

export function buildCodexHookRunnerMjs(pythonHint = null) {
  const hintCommand =
    pythonHint && typeof pythonHint.command === "string"
      ? pythonHint.command.trim()
      : "";
  const hintBasename = path.basename(hintCommand).toLowerCase();
  const installTimePythonHint =
    hintCommand &&
    !/^py(?:\.exe)?$/iu.test(hintBasename) &&
    !hintCommand.replace(/\\/gu, "/").toLowerCase().includes("/windowsapps/") &&
    (process.platform !== "win32" ||
      (path.isAbsolute(hintCommand) &&
        /^(?:python|python3|pythonw)\.exe$/iu.test(hintBasename)))
      ? { command: hintCommand, args: Array.isArray(pythonHint.args) ? pythonHint.args : [] }
      : null;
  return [
    'import { spawnSync } from "node:child_process";',
    'import { existsSync, readFileSync, readdirSync } from "node:fs";',
    'import path from "node:path";',
    'import process from "node:process";',
    "",
    "const scriptPath = process.argv[2];",
    `const INSTALL_TIME_PYTHON_HINT = ${JSON.stringify(installTimePythonHint)};`,
    "",
    "function isPyLauncher(filePath) {",
    "  return /^py(?:\\.exe)?$/i.test(path.basename(String(filePath)));",
    "}",
    "",
    `const collectWindowsPythonCandidatePaths = ${collectWindowsPythonCandidatePaths.toString()};`,
    "",
    "function listDirectoryNames(directory) {",
    "  try {",
    "    return readdirSync(directory, { withFileTypes: true })",
    "      .filter((entry) => entry.isDirectory())",
    "      .map((entry) => entry.name);",
    "  } catch {",
    "    return [];",
    "  }",
    "}",
    "",
    "function commandWorks(command, args = []) {",
    "  const result = spawnSync(command, [",
    "    ...args,",
    "    '-c',",
    "    'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)',",
    "  ], {",
    "    encoding: 'utf8',",
    "    windowsHide: true,",
    "    timeout: 750,",
    "  });",
    "  return result.status === 0;",
    "}",
    "",
    "function pythonCandidates() {",
    "  const candidates = [];",
    "  if (process.platform === 'win32') {",
    "    const paths = collectWindowsPythonCandidatePaths({",
    "      env: process.env,",
    "      installTimeHint: INSTALL_TIME_PYTHON_HINT,",
    "      pathApi: path.win32,",
    "      pathExists: existsSync,",
    "      listDirectoryNames,",
    "    });",
    "    candidates.push(...paths.map((command) => ({ command, args: [] })));",
    "  } else {",
    "    for (const envKey of ['META_KIM_PYTHON', 'PYTHON', 'PYTHON3']) {",
    "      const value = process.env[envKey];",
    "      if (value && !isPyLauncher(value)) candidates.push({ command: value, args: [] });",
    "    }",
    "    if (INSTALL_TIME_PYTHON_HINT) candidates.push(INSTALL_TIME_PYTHON_HINT);",
    "    candidates.push({ command: 'python3', args: [] });",
    "    candidates.push({ command: 'python', args: [] });",
    "  }",
    "",
    "  const seen = new Set();",
    "  return candidates.filter((candidate) => {",
    "    const key = `${candidate.command}\\0${candidate.args.join('\\0')}`;",
    "    if (seen.has(key)) return false;",
    "    seen.add(key);",
    "    return true;",
    "  });",
    "}",
    "",
    "function findPython() {",
    "  for (const candidate of pythonCandidates()) {",
    "    if (commandWorks(candidate.command, candidate.args)) return candidate;",
    "  }",
    "  return null;",
    "}",
    "",
    "function main() {",
    "  if (!scriptPath) return 0;",
    "  const python = findPython();",
    "  if (!python) return 0;",
    "  let input = '';",
    "  try {",
    "    input = readFileSync(0, 'utf8');",
    "  } catch {",
    "    input = '';",
    "  }",
    "  const result = spawnSync(",
    "    python.command,",
    "    [...python.args, scriptPath],",
    "    {",
    "      input,",
    "      encoding: 'utf8',",
    "      env: {",
    "        ...process.env,",
    "        PYTHONIOENCODING: 'utf-8',",
    "        PYTHONUTF8: '1',",
    "      },",
    "      windowsHide: true,",
    "      timeout: 30000,",
    "    },",
    "  );",
    "  if (result.stdout) process.stdout.write(result.stdout);",
    "  return 0;",
    "}",
    "",
    "process.exitCode = main();",
    "",
  ].join("\n");
}

function buildCodexWrapperPy(scriptName) {
  return [
    "#!/usr/bin/env python3",
    "from __future__ import annotations",
    "",
    "import codex_hook_adapter as adapter",
    "",
    "",
    "def main() -> None:",
    "    payload = adapter.load_payload()",
    "    root = adapter.cwd_from_payload(payload)",
    `    stdout, _ = adapter.run_shell_script("${scriptName}", root)`,
    "    if stdout:",
    '        adapter.emit_json({"systemMessage": stdout})',
    "",
    "",
    'if __name__ == "__main__":',
    "    raise SystemExit(adapter.main_guard(main))",
    "",
  ].join("\n");
}

function buildCodexPreToolUseWrapperPy() {
  return [
    "#!/usr/bin/env python3",
    "from __future__ import annotations",
    "",
    "import codex_hook_adapter as adapter",
    "",
    "",
    "def main() -> None:",
    "    payload = adapter.load_payload()",
    "    root = adapter.cwd_from_payload(payload)",
    '    stdout, stderr = adapter.run_shell_script("pre-tool-use.sh", root)',
    "",
    "    result = adapter.parse_json(stdout)",
    '    decision = result.get("decision")',
    '    if decision and decision != "allow":',
    "        adapter.emit_json(result)",
    "        return",
    "",
    "    if stderr:",
    '        adapter.emit_json({"systemMessage": stderr})',
    "",
    "",
    'if __name__ == "__main__":',
    "    raise SystemExit(adapter.main_guard(main))",
    "",
  ].join("\n");
}

function buildCodexStopWrapperPy() {
  return [
    "#!/usr/bin/env python3",
    "from __future__ import annotations",
    "",
    "import codex_hook_adapter as adapter",
    "",
    "",
    "def main() -> None:",
    "    payload = adapter.load_payload()",
    "    root = adapter.cwd_from_payload(payload)",
    '    stdout, _ = adapter.run_shell_script("stop.sh", root)',
    "    result = adapter.parse_json(stdout)",
    "",
    '    decision = result.get("decision")',
    '    if decision and decision != "allow":',
    "        adapter.emit_json(result)",
    "        return",
    "",
    '    message = result.get("followup_message")',
    "    if not isinstance(message, str) or not message:",
    "        return",
    "",
    '    if "(0/0" in message:',
    "        return",
    "",
    '    adapter.emit_json({"systemMessage": message})',
    "",
    "",
    'if __name__ == "__main__":',
    "    raise SystemExit(adapter.main_guard(main))",
    "",
  ].join("\n");
}

async function patchTextFileIfExists(filePath, replacements) {
  if (!(await pathExists(filePath))) {
    return false;
  }
  let content = await fs.readFile(filePath, "utf8");
  const original = content;
  for (const [from, to] of replacements) {
    content = content.replace(from, to);
  }
  if (content === original) {
    return false;
  }
  await fs.writeFile(filePath, content, "utf8");
  return true;
}

async function patchPlanningWithFilesPhaseCounters(spec, runtimeHome, runtimeId) {
  if (spec.id !== "planning-with-files" || dryRun) {
    return;
  }

  const shReplacements = [
    [
      'TOTAL=$(grep -c "### Phase" "$PLAN_FILE" || true)',
      'TOTAL=$(grep -Ec "^#{2,3}[[:space:]]+Phase\\b" "$PLAN_FILE" || true)',
    ],
  ];
  const ps1Replacements = [
    [
      '$TOTAL = ([regex]::Matches($content, "### Phase")).Count',
      '$TOTAL = ([regex]::Matches($content, "(?m)^#{2,3}\\s+Phase\\b")).Count',
    ],
  ];
  const candidates = [
    [path.join(runtimeHome, "hooks", "stop.sh"), shReplacements],
    [path.join(runtimeHome, "hooks", "stop.ps1"), ps1Replacements],
    [
      path.join(
        runtimeHome,
        "skills",
        "planning-with-files",
        "scripts",
        "check-complete.sh",
      ),
      shReplacements,
    ],
    [
      path.join(
        runtimeHome,
        "skills",
        "planning-with-files",
        "scripts",
        "check-complete.ps1",
      ),
      ps1Replacements,
    ],
  ];

  let patched = 0;
  for (const [filePath, replacements] of candidates) {
    if (await patchTextFileIfExists(filePath, replacements)) {
      patched += 1;
    }
  }
  if (patched > 0) {
    console.log(
      `${C.green}✓${C.reset} ${spec.id} phase counters patched for ${runtimeId} (${patched} file${patched === 1 ? "" : "s"})`,
    );
  }
}

async function patchCodexPlanningHooksForPlatform(spec, runtimeHome, runtimeId) {
  if (
    runtimeId !== "codex" ||
    spec.id !== "planning-with-files" ||
    dryRun
  ) {
    return;
  }

  const hooksDir = path.join(runtimeHome, "hooks");
  if (!(await pathExists(hooksDir))) {
    return;
  }

  const hooksJsonPath = path.join(runtimeHome, "hooks.json");
  let existingHooksJson = {};
  if (await pathExists(hooksJsonPath)) {
    try {
      existingHooksJson = JSON.parse(await fs.readFile(hooksJsonPath, "utf8"));
    } catch {
      existingHooksJson = {};
    }
  }
  const mergedHooksJson = mergeCodexPlanningHooksJson(
    existingHooksJson,
    buildCodexPlanningHooksJson(runtimeHome),
  );
  await fs.writeFile(
    hooksJsonPath,
    `${JSON.stringify(mergedHooksJson, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(hooksDir, "codex_hook_adapter.py"),
    buildCodexPlanningHookAdapterPy(),
    "utf8",
  );
  await fs.writeFile(
    path.join(hooksDir, "codex_hook_runner.mjs"),
    buildCodexHookRunnerMjs(
      process.platform === "win32" ? null : detectPython310(),
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(hooksDir, "session_start.py"),
    buildCodexWrapperPy("session-start.sh"),
    "utf8",
  );
  await fs.writeFile(
    path.join(hooksDir, "user_prompt_submit.py"),
    buildCodexWrapperPy("user-prompt-submit.sh"),
    "utf8",
  );
  await fs.writeFile(
    path.join(hooksDir, "pre_tool_use.py"),
    buildCodexPreToolUseWrapperPy(),
    "utf8",
  );
  await fs.writeFile(
    path.join(hooksDir, "post_tool_use.py"),
    buildCodexWrapperPy("post-tool-use.sh"),
    "utf8",
  );
  await fs.writeFile(
    path.join(hooksDir, "stop.py"),
    buildCodexStopWrapperPy(),
    "utf8",
  );
  console.log(
    `${C.green}✓${C.reset} ${spec.id} Codex hooks patched for ${os.platform()}`,
  );
}

async function patchCodexHookPromptForPlatform(spec, runtimeHome, runtimeId) {
  if (!["codex", "cursor"].includes(runtimeId) || spec.id !== "hookprompt" || dryRun) {
    return;
  }

  const hooksDir = path.join(runtimeHome, "hooks");
  await fs.mkdir(hooksDir, { recursive: true });

  const memoryHookPath = path.join(hooksDir, "meta-kim-memory-save.mjs");
  const graphifyHookPath = path.join(hooksDir, "graphify-context.mjs");
  const spineHookPath = path.join(hooksDir, "activate-meta-theory-spine.mjs");
  const hookPromptAdapterPath = path.join(hooksDir, "hookprompt-adapter.mjs");

  await fs.writeFile(
    hookPromptAdapterPath,
    buildHookPromptAdapterSource(runtimeId),
    "utf8",
  );

  let existing = {};
  const hooksJsonPath = path.join(runtimeHome, "hooks.json");
  if (await pathExists(hooksJsonPath)) {
    try {
      existing = JSON.parse(await fs.readFile(hooksJsonPath, "utf8"));
    } catch {
      existing = {};
    }
  }
  const hookBuilder = runtimeId === "codex" ? buildCodexHooksJson : buildCursorHooksJson;
  const generated = hookBuilder({
    graphifyHookPath:
      (await pathExists(graphifyHookPath)) ? graphifyHookPath : "graphify-context.mjs",
    memoryHookPath:
      (await pathExists(memoryHookPath)) ? memoryHookPath : "meta-kim-memory-save.mjs",
    ...(runtimeId === "codex" && {
      spineHookPath:
        (await pathExists(spineHookPath)) ? spineHookPath : "activate-meta-theory-spine.mjs",
    }),
    hookPromptAdapterPath,
  });

  const next = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const event = runtimeId === "codex" ? "UserPromptSubmit" : "beforeSubmitPrompt";
  const existingBlocks = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
  const alreadyRegistered = existingBlocks.some((block) =>
    (block.hooks ?? [block]).some((hook) =>
      String(hook.command ?? "").includes("hookprompt-adapter.mjs"),
    ),
  );
  if (alreadyRegistered) {
    return;
  }
  const generatedEventHooks =
    runtimeId === "codex"
      ? generated.hooks.UserPromptSubmit[0].hooks
      : generated.hooks.beforeSubmitPrompt;
  const adapterHook = generatedEventHooks.find((hook) =>
    hook.command.includes("hookprompt-adapter.mjs"),
  );
  if (!adapterHook) {
    return;
  }
  if (existingBlocks.length > 0 && runtimeId === "codex") {
    existingBlocks[0].hooks = [...(existingBlocks[0].hooks ?? []), adapterHook];
    next.hooks[event] = existingBlocks;
  } else if (existingBlocks.length > 0) {
    next.hooks[event] = [...existingBlocks, adapterHook];
  } else {
    next.hooks[event] =
      runtimeId === "codex"
        ? [
            {
              hooks: [adapterHook],
            },
          ]
        : [adapterHook];
  }

  await fs.writeFile(hooksJsonPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  console.log(
    `${C.green}✓${C.reset} ${spec.id} ${runtimeId} hook adapter registered`,
  );
}

// ========== Hook Extra Files Deployment ==========

async function deployHookExtraFiles(spec, runtimeHome, runtimeId) {
  const hookExtraFiles = spec.hookExtraFiles;
  if (!hookExtraFiles || !hookExtraFiles[runtimeId]) return;

  const entries = hookExtraFiles[runtimeId];
  if (!Array.isArray(entries) || entries.length === 0) return;

  for (const entry of entries) {
    if (!entry.src || !entry.dest) continue;
    if (dryRun) {
      console.log(
        t.dryRun(
          `deploy extra file ${spec.repo}:${entry.src} -> ${path.join(runtimeHome, entry.dest)}`,
        ),
      );
      continue;
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-hextra-"));
    try {
      const parentDir = path.dirname(entry.src).replace(/\\/g, "/");
      await runGitAsync(
        [
          "clone",
          "--depth",
          "1",
          "--filter=blob:none",
          "--sparse",
          spec.repo,
          tmp,
        ],
        { skillLabel: `${spec.id}-extra (${runtimeId})` },
      );
      await runGitAsync(["sparse-checkout", "set", parentDir || "."], {
        cwd: tmp,
      });
      const srcPath = path.join(tmp, ...entry.src.split("/").filter(Boolean));
      if (await pathExists(srcPath)) {
        const destPath = path.join(runtimeHome, entry.dest);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.copyFile(srcPath, destPath);
        console.log(
          `${C.green}✓${C.reset} ${spec.id} ${path.basename(entry.src)} -> ${destPath}`,
        );
      }
    } catch {
      // extra file absent — non-fatal
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
}

// ========== Hook Settings Merge ==========

async function mergeHookSettings(spec, runtimeHome, runtimeId) {
  const hookSettingsMerge = spec.hookSettingsMerge;
  if (!hookSettingsMerge || !hookSettingsMerge[runtimeId]) return;

  const cfg = hookSettingsMerge[runtimeId];
  if (!cfg.event || !cfg.hookFile) return;

  const settingsPath = path.join(runtimeHome, "settings.json");
  const hookScriptPath = path.join(runtimeHome, "hooks", cfg.hookFile);

  if (dryRun) {
    console.log(
      t.dryRun(`merge hook ${cfg.event} -> ${settingsPath} (${cfg.hookFile})`),
    );
    return;
  }

  if (!(await pathExists(hookScriptPath))) return;

  let settings = {};
  if (await pathExists(settingsPath)) {
    try {
      settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    } catch {
      return;
    }
  }

  if (!settings.hooks) settings.hooks = {};
  const existingEntries = settings.hooks[cfg.event] || [];

  const normalizedPath = hookScriptPath.replace(/\\/g, "/");
  const alreadyRegistered = existingEntries.some((group) =>
    (group.hooks || []).some((h) => {
      const cmd = (h.command || "").replace(/\\/g, "/");
      return cmd.includes(cfg.hookFile);
    }),
  );

  if (alreadyRegistered) return;

  const newEntry = {
    hooks: [
      {
        type: "command",
        command: `node "${hookScriptPath.replace(/\\/g, "\\\\")}"`,
        ...(cfg.timeout ? { timeout: cfg.timeout } : {}),
      },
    ],
  };

  existingEntries.push(newEntry);
  settings.hooks[cfg.event] = existingEntries;

  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  console.log(
    `${C.green}✓${C.reset} ${spec.id} hook registered: ${cfg.event} -> ${cfg.hookFile}`,
  );
}

export {
  MAX_ARCHIVE_DOWNLOAD_BYTES,
  MAX_ARCHIVE_MEMBERS,
  MAX_ARCHIVE_MEMBER_UNCOMPRESSED_BYTES,
  MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES,
  extractArchiveInto,
  readResponseBodyBounded,
  validateArchiveMembers,
  buildGlobalCapabilityInventoryArgs,
  assertRealPathContained,
  normalizeInstallerSkillsFilter,
  resolveCompatibilitySkillRoots,
  directoryContentEqual,
  resolveOsUserHome,
  resolveSkillTargetDir,
  transactionalReplaceMetaSkillTargets,
  validateInstallerArgs,
  validateMetaSkillCreatorPackage,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}
