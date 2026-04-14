#!/usr/bin/env node
/**
 * Cross-runtime install: clone the same third-party skill repos into
 * ~/.claude/skills, ~/.codex/skills, and ~/.openclaw/skills (plus optional
 * `claude plugin install …` for bundles that ship as official CC plugins).
 *
 * Flags:
 *   --update          git pull / re-clone skill dirs
 *   --dry-run         print actions only
 *   --plugins-only    only run `claude plugin install` (no git clones)
 *   --skip-plugins    skip `claude plugin install` even if defaults apply
 *   --skills=id,...   install only these manifest skill ids (omit = all)
 *
 * Env (optional): META_KIM_CLAUDE_HOME, CLAUDE_HOME, META_KIM_CODEX_HOME,
 * CODEX_HOME, META_KIM_OPENCLAW_HOME, OPENCLAW_HOME, META_KIM_SKILL_IDS
 */

import { execFileSync, execSync, spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  detectPython310,
  extractPipShowVersion,
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
  detectLegacySubdirInstall,
  sanitizeInstalledSkillTree,
} from "./install-skill-sanitizer.mjs";
import { fileURLToPath } from "node:url";
import {
  parseSkillsArg,
  resolveTargetContext,
  resolveRuntimeHomeDir,
} from "./meta-kim-sync-config.mjs";
import { t } from "./meta-kim-i18n.mjs";

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

const updateMode = process.argv.includes("--update");
const dryRun = process.argv.includes("--dry-run");
const pluginsOnly = process.argv.includes("--plugins-only");
const skipPlugins =
  process.argv.includes("--skip-plugins") ||
  process.argv.includes("--no-plugins");
const cliArgs = process.argv.slice(2);
const installFailures = [];
const archiveFallbacks = [];
const repairedInstallRoots = [];
const sanitizedSkillIssues = [];

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

// Apply proxy to HTTP/HTTPS env vars for git
if (gitProxy) {
  process.env.HTTP_PROXY = gitProxy.url;
  process.env.HTTPS_PROXY = gitProxy.url;
  console.log(
    `${C.cyan}→${C.reset} ${t.proxyDetected(gitProxy.url, gitProxy.source)}`,
  );
} else if (strippedLoopbackProxyEnv.length > 0) {
  console.warn(`${C.yellow}⚠${C.reset} ${t.proxyStrippedHint}`);
}

// Session-level: direct-first path only — after proxy fallback succeeds once, skip proxy fallback on later ops.
let useDirectConnection = false;

/** User configured --proxy / META_KIM_GIT_PROXY: prefer that env for git (no misleading "direct failed" first). */
const preferGitProxyFirst = Boolean(gitProxy);

/**
 * Load skills manifest from shared config (single source of truth)
 * Same as setup.mjs - ensures consistency across all installation paths
 */
function loadSkillsManifest() {
  const manifestPath = path.join(repoRoot, "config", "skills.json");
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw);

    // Allow env var override
    const skillOwner =
      process.env.META_KIM_SKILL_OWNER || manifest.skillOwner || "KimYx0207";

    // Transform manifest to script’s format
    const skillRepos = [];

    for (const skill of manifest.skills) {
      const repo = skill.repo.replace("${skillOwner}", skillOwner);
      const fullUrl = `https://github.com/${repo}.git`;

      const subdir = resolveManifestSkillSubdir(skill, os.platform());

      skillRepos.push({
        id: skill.id,
        repo: fullUrl,
        ...(subdir ? { subdir } : {}),
        targets: skill.targets || ["claude", "codex", "openclaw"],
        ...(skill.claudePlugin ? { claudePlugin: skill.claudePlugin } : {}),
      });
    }

    return { skillRepos };
  } catch (err) {
    console.warn(`${C.yellow}⚠${C.reset} ${t.failManifestLoad(err.message)}`);
    return { skillRepos: [] };
  }
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

const manifestLoad = loadSkillsManifest();
let SKILL_REPOS = manifestLoad.skillRepos;
const skillsArg = parseSkillsArg(cliArgs);
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

let CLAUDE_PLUGIN_SPECS = SKILL_REPOS.map((s) => s.claudePlugin).filter(
  Boolean,
);

function resolveHomes() {
  return {
    claude: resolveRuntimeHomeDir("claude"),
    codex: resolveRuntimeHomeDir("codex"),
    openclaw: resolveRuntimeHomeDir("openclaw"),
    cursor: resolveRuntimeHomeDir("cursor"),
  };
}

function resolveCompatibilitySkillRoots(runtimeId, primarySkillsRoot) {
  if (runtimeId !== "codex") {
    return [];
  }

  const legacyCodexSkillsRoot = path.join(os.homedir(), ".agents", "skills");
  if (path.resolve(legacyCodexSkillsRoot) === path.resolve(primarySkillsRoot)) {
    return [];
  }

  return [legacyCodexSkillsRoot];
}

function assertUnderHome(resolved) {
  const home = path.resolve(os.homedir());
  const abs = path.resolve(resolved);
  if (abs !== home && !abs.startsWith(`${home}${path.sep}`)) {
    throw new Error(`Refusing to write outside user home: ${abs}`);
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

  const isLegacySubdirInstall = await detectLegacySubdirInstall(
    targetDir,
    subdirPath,
  );
  if (!isLegacySubdirInstall) {
    return { repaired: false };
  }

  repairedInstallRoots.push({
    skillId,
    targetDir,
    subdirPath,
    action: allowDelete ? "reinstall" : "sanitize_only",
  });

  if (!allowDelete) {
    return { repaired: false, legacyDetected: true };
  }

  console.warn(
    `${C.yellow}⚠${C.reset} ${t.warnRepairLegacyLayout(skillId, targetDir)}`,
  );
  if (dryRun) {
    console.log(
      t.dryRun(`Replace malformed install during reinstall: ${targetDir}`),
    );
  }
  return { repaired: true, legacyDetected: true };
}

async function sanitizeManagedSkillTarget(skillId, targetDir) {
  if (!(await pathExists(targetDir))) {
    return;
  }

  const result = await sanitizeInstalledSkillTree(targetDir, { dryRun });
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
  );
  for (const extraRoot of extraRoots) {
    const targetDir = path.join(extraRoot, spec.id);
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
    const totStr =
      est != null && est > 0 ? formatBytesBin(est) : "…";
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

async function extractArchiveInto(targetDir, archivePath, subdirPath) {
  const extractDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "meta-kim-archive-"),
  );
  try {
    if (dryRun) {
      console.log(t.dryRun(`tar -xzf ${archivePath} -C ${extractDir}`));
    } else {
      // Use relative archive name + cwd to avoid Windows tar
      // misinterpreting "C:\path" as a remote host (colon syntax).
      execFileSync(
        "tar",
        ["-xzf", path.basename(archivePath), "-C", extractDir],
        {
          cwd: path.dirname(archivePath),
          stdio: "pipe",
        },
      );
    }

    const entries = await fs.readdir(extractDir, { withFileTypes: true });
    const rootEntry = entries.find((entry) => entry.isDirectory());
    if (!rootEntry) {
      throw new Error(
        `Archive extraction produced no root directory: ${archivePath}`,
      );
    }

    const rootDir = path.join(extractDir, rootEntry.name);
    const sourceDir = subdirPath
      ? path.join(rootDir, ...subdirPath.split("/").filter(Boolean))
      : rootDir;
    if (!(await pathExists(sourceDir))) {
      throw new Error(`Archive fallback missing subdir: ${sourceDir}`);
    }

    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
  } finally {
    await fs.rm(extractDir, { recursive: true, force: true });
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
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(archivePath, buffer);
    await extractArchiveInto(targetDir, archivePath, subdirPath);
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
  const r = spawnSync("git", ["-C", dir, "rev-parse", "-q", "--verify", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });
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
    if (/(Receiving objects|接收对象|Resolving deltas|解析增量)/i.test(stderr)) {
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
  await repairManagedSkillTarget({ skillId, targetDir });
  const targetExists = await pathExists(targetDir);
  const targetEmpty = targetExists && (await isEmptyDir(targetDir));
  if (targetExists && !targetEmpty) {
    if (updateMode) {
      if (dryRun) {
        console.log(t.dryRun(`update ${targetDir}`));
      } else {
        try {
          runGit(["-C", targetDir, "pull", "--ff-only"], {
            skillLabel: `pull ${skillId}`,
          });
          console.log(`${C.green}✓${C.reset} ${t.okUpdated(targetDir)}`);
        } catch {
          console.warn(`${C.yellow}⚠${C.reset} ${t.warnPullFailed(targetDir)}`);
          const stagedDir = await createSiblingStagingDir(targetDir);
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
            }
          } catch (error) {
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

async function installSkillCreator(targetBaseSkills) {
  const id = "skill-creator";
  const targetDir = path.join(targetBaseSkills, id);
  await installGitSkillFromSubdir(
    id,
    targetDir,
    "https://github.com/anthropics/skills.git",
    "skills/skill-creator",
  );
}

async function installAllSkillsForRuntime(label, skillsRoot, runtimeId) {
  console.log(
    `\n${C.bold}${AMBER}${t.skillsHeader(label, skillsRoot)}${C.reset}`,
  );
  assertUnderHome(skillsRoot);
  if (!dryRun) {
    await fs.mkdir(skillsRoot, { recursive: true });
  }

  for (const spec of SKILL_REPOS) {
    if (spec.targets && !spec.targets.includes(runtimeId)) {
      console.log(
        `${C.yellow}⊘${C.reset} ${C.dim}${t.skipNotApplicable(spec.id, runtimeId)}${C.reset}`,
      );
      continue;
    }
    const targetDir = path.join(skillsRoot, spec.id);
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
    await sanitizeCompatibilityRoots(runtimeId, skillsRoot, spec);
  }
  const hasManifestSkillCreator = SKILL_REPOS.some(
    (spec) => spec.id === "skill-creator",
  );
  if (!hasManifestSkillCreator) {
    await installSkillCreator(skillsRoot);
  }
}

function installClaudePlugins() {
  if (skipPlugins || CLAUDE_PLUGIN_SPECS.length === 0) {
    return;
  }
  console.log(`\n${C.bold}${AMBER}${t.pluginsHeader}${C.reset}`);

  // Probe which claude invocation method works.
  // Windows edge-case: a broken npm .cmd shim may shadow a working
  // standalone .exe.  We try direct spawn first (skips .cmd), then
  // shell spawn (finds .cmd).  Whichever works is reused below.
  const isWin = os.platform() === "win32";
  const useShell = shouldUseCliShell(isWin);

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
    const viaShell = spawnSync("claude", ["--version"], {
      encoding: "utf8",
      shell: true,
    });
    if (viaShell.status === 0) {
      claudeShellOpt = true;
      claudeFound = true;
    }
  }

  if (!claudeFound) {
    console.warn(`${C.yellow}⚠${C.reset} ${t.warnClaNotFound}`);
    return;
  }

  // Detect already-installed plugins so we skip re-installing them.
  const listOut = spawnSync("claude", ["plugins", "list", "--json"], {
    encoding: "utf8",
    shell: claudeShellOpt,
  });
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

  for (const spec of CLAUDE_PLUGIN_SPECS) {
    const bareName = spec.split("@")[0];
    if (installedNames.has(bareName)) {
      console.log(
        `${C.yellow}⊘${C.reset} ${C.dim}${t.skipAlreadyInstalled(bareName)}${C.reset}`,
      );
      continue;
    }
    if (dryRun) {
      console.log(t.dryRun(`claude plugin install ${spec}`));
      continue;
    }
    console.log(`${C.cyan}→${C.reset} ${t.installingPlugin(spec)}`);
    const p = spawnSync("claude", ["plugin", "install", spec], {
      stdio: "inherit",
      shell: claudeShellOpt,
    });
    if (p.status !== 0) {
      console.warn(
        `${C.yellow}⚠${C.reset} ${t.warnPluginFailed(spec, p.status)}`,
      );
    }
  }
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

async function cleanupStaleStagingDirs(homes) {
  const cleaned = [];

  for (const homeDir of Object.values(homes)) {
    const skillsRoot = path.join(homeDir, "skills");
    if (!(await pathExists(skillsRoot))) continue;

    let entries;
    try {
      entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.includes(".staged-")) {
        continue;
      }

      const stagedPath = path.join(skillsRoot, entry.name);
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

  if (cleaned.length > 0) {
    console.log(
      `${C.green}✓${C.reset} ${t.okRemovedStagingResidual(cleaned.length)}`,
    );
  }
}

// ── Two-phase install helpers ─────────────────────────────────

/**
 * Stage a skill repo to a temporary staging directory (full clone).
 * Returns true if staging succeeded.
 */
async function stageSkillClone(skillId, stagedPath, repoUrl) {
  if ((await pathExists(stagedPath)) && !(await isEmptyDir(stagedPath))) {
    return true;
  }

  await fs.mkdir(path.dirname(stagedPath), { recursive: true });
  try {
    console.log(`${C.dim}${t.cloneStarting(skillId)}${C.reset}`);
    await runGitAsync(
      ["clone", "--progress", "--depth", "1", repoUrl, stagedPath],
      {
        skillLabel: t.gitRetryLabelStaging(skillId),
        cloneProgress: { skillId, rootPath: stagedPath },
      },
    );
    console.log(`${C.green}✓${C.reset} ${t.okStaged(skillId)}`);
    return true;
  } catch (error) {
    await handleGitFailure({ skillId, targetDir: stagedPath, repoUrl, error });
    return (await pathExists(stagedPath)) && !(await isEmptyDir(stagedPath));
  }
}

/**
 * Stage a skill from a repo subdir (sparse checkout) to staging.
 * Returns true if staging succeeded.
 */
async function stageSkillFromSubdir(skillId, stagedPath, repoUrl, subdirPath) {
  if ((await pathExists(stagedPath)) && !(await isEmptyDir(stagedPath))) {
    return true;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meta-kim-skill-"));
  try {
    console.log(`${C.dim}${t.cloneStarting(skillId)}${C.reset}`);
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
    console.log(
      `${C.green}✓${C.reset} ${t.okStagedSubdir(skillId, subdirPath)}`,
    );
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
          console.log(
            `${C.green}✓${C.reset} ${t.okStagedSubdir(skillId, subdirPath)}`,
          );
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
    // Phase 1: Stage each unique skill repo in parallel
    console.log(`\n${C.bold}${AMBER}${t.stagingHeaderParallel}${C.reset}`);
    console.log(`${C.dim}${t.stagingExplainParallel(stagingRoot)}${C.reset}\n`);

    const stagedSkills = new Map();

    const limitClone = createConcurrencyLimiter(MAX_CONCURRENT_CLONES);

    const stagePromises = SKILL_REPOS.filter((spec) => {
      const needs = targetRuntimeIds.filter(
        (id) => !spec.targets || spec.targets.includes(id),
      );
      return needs.length > 0;
    }).map((spec) =>
      limitClone(async () => {
        const stagedPath = path.join(stagingRoot, spec.id);
        const success = spec.subdir
          ? await stageSkillFromSubdir(
              spec.id,
              stagedPath,
              spec.repo,
              spec.subdir,
            )
          : await stageSkillClone(spec.id, stagedPath, spec.repo);
        return { id: spec.id, success, stagedPath };
      }),
    );

    const stageResults = await Promise.allSettled(stagePromises);
    for (const result of stageResults) {
      if (result.status === "fulfilled") {
        stagedSkills.set(result.value.id, result.value);
      }
    }

    // Phase 2: Deploy staged skills to each runtime
    for (const runtimeId of targetRuntimeIds) {
      const skillsRoot = path.join(homes[runtimeId], "skills");
      const label = runtimeLabels[runtimeId] || `${runtimeId} skills`;
      console.log(
        `\n${C.bold}${AMBER}${t.skillsHeader(label, skillsRoot)}${C.reset}`,
      );
      assertUnderHome(skillsRoot);
      await fs.mkdir(skillsRoot, { recursive: true });

      for (const spec of SKILL_REPOS) {
        if (spec.targets && !spec.targets.includes(runtimeId)) {
          console.log(
            `${C.yellow}⊘${C.reset} ${C.dim}${t.skipNotApplicable(spec.id, runtimeId)}${C.reset}`,
          );
          continue;
        }

        const staged = stagedSkills.get(spec.id);
        const targetDir = path.join(skillsRoot, spec.id);

        if (staged?.success) {
          await deployStagedSkill(
            staged.stagedPath,
            targetDir,
            spec.id,
            spec.subdir,
          );
        } else {
          // Staging failed: fall back to direct per-runtime install
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

        await sanitizeCompatibilityRoots(runtimeId, skillsRoot, spec);
      }

      // skill-creator fallback (if not in manifest)
      const hasManifestSkillCreator = SKILL_REPOS.some(
        (s) => s.id === "skill-creator",
      );
      if (!hasManifestSkillCreator) {
        await installSkillCreator(skillsRoot);
      }
    }
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  const { activeTargets } = await resolveTargetContext(cliArgs);
  const homes = resolveHomes();

  if (strippedLoopbackProxyEnv.length > 0) {
    console.warn(
      `${C.yellow}⚠${C.reset} Ignoring loopback proxy env for install: ${strippedLoopbackProxyEnv.join(", ")}`,
    );
  }

  // Clean up known legacy artifacts before any install operations
  await cleanupLegacyGlobalArtifacts(homes);
  await cleanupStaleStagingDirs(homes);

  if (!pluginsOnly) {
    const runtimeLabels = {
      claude: "Claude Code skills",
      codex: "Codex skills",
      openclaw: "OpenClaw skills",
      cursor: "Cursor skills",
    };

    const targetRuntimeIds = activeTargets.filter(
      (id) => homes[id] !== undefined,
    );

    if (targetRuntimeIds.length === 1) {
      // Single runtime: install directly (no staging overhead)
      const rid = targetRuntimeIds[0];
      await installAllSkillsForRuntime(
        runtimeLabels[rid],
        path.join(homes[rid], "skills"),
        rid,
      );
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
    installClaudePlugins();
  }

  // Optional: graphify (code knowledge graph)
  if (!pluginsOnly) {
    console.log(`\n${C.bold}${AMBER}${t.pythonToolsOptionalHeader}${C.reset}`);
    const python = detectPython310();

    if (!python) {
      console.log(t.pythonNotFoundGraphify);
      console.log(t.pythonInstallHintGraphify);
    } else {
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
        console.log(`[SKIP] ${t.skipGraphifyInstalled(version)}`);
      } else {
        console.log(t.installingGraphify);
        const pipResult = runPythonModule(
          python,
          ["-m", "pip", "install", "graphifyy"],
          undefined,
          { stdio: "pipe" },
        );
        if (pipResult.status === 0) {
          // Register Claude skill silently
          runPythonModule(
            python,
            ["-m", "graphify", "claude", "install"],
            undefined,
            { stdio: "pipe" },
          );
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
  }

  console.log(`\n${t.done}`);
  console.log(t.noteCodexOpenclaw);
  console.log(t.activeTargets(activeTargets));
  console.log(t.metaKimRoot(repoRoot));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
