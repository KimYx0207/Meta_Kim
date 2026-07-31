#!/usr/bin/env node
/**
 * Meta_Kim interactive setup (i18n)
 *
 * Usage:
 *   node setup.mjs              # Interactive first-run setup
 *   node setup.mjs --lang zh    # Skip language selection, use Chinese
 *   node setup.mjs --update     # Update installed skills
 *   node setup.mjs --check      # Environment check only
 *   node setup.mjs --silent     # Non-interactive (CI / scripts)
 *   node setup.mjs --scope global|project
 *                                # Explicit install/update destination
 *   node setup.mjs --skills a,b # Limit global skill repos (non-interactive / CI)
 *   node setup.mjs --with-global-hooks
 *                                # Opt in to global hook wiring for selected runtimes
 *   node setup.mjs --project-dir <dir> [--project-dir <dir>]
 *                                # Also export project-level runtime files to one or more projects
 *   node setup.mjs --all-projects # Reuse saved project directories for export/update
 *   node setup.mjs --project-bootstrap --project-dir <dir> [--dry-run|--apply] [--json]
 *                                # Global-first first-trigger project bootstrap
 *
 * Optional prompts (off by default — install uses global scope and skips proxy UI):
 *   --prompt-proxy              # Ask Windows system proxy for git (META_KIM_GIT_PROXY)
 *   META_KIM_PROMPT_PROXY=1
 */

import { execSync, spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  readdirSync,
  cpSync,
  statSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, resolve, isAbsolute, relative } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import {
  getProfilePaths,
  readProfileMetadata,
  resolveProfileName,
  toRepoRelative,
} from "./scripts/meta-kim-local-state.mjs";
import {
  recordSetupRuntimeExecutableBindings,
  resolveSetupRuntimeLaunchInventoryRoots,
} from "./scripts/runtime-executable-binding.mjs";
import {
  detectPython310,
  extractPipShowVersion,
  readProcessText,
  runPythonModule,
  checkNetworkx,
  resolveGraphifyExecutable,
} from "./scripts/graphify-runtime.mjs";
import {
  reconcileExistingGraphifyWindowsHooks,
  sanitizeGraphifyWindowsHooks,
} from "./scripts/graphify-hook-sanitize.mjs";
import { resolveManifestSkillSubdir } from "./scripts/install-platform-config.mjs";
import {
  SETUP_NODE_CHILD,
  buildGlobalMetaTheorySyncArgs,
  buildGlobalSkillsInstallerArgs,
  buildNodeScriptSpawn,
  buildSetupNodeChildSpawn,
} from "./scripts/node-spawn-config.mjs";
import {
  CODEX_BUSINESS_ROLE_AGENT_IDS,
  CODEX_RUNTIME_ADAPTER_AGENT_IDS,
  META_AGENTS,
  OPENCLAW_WORKSPACE_MD,
  expectedAgentProjectionFiles,
  summarizeExpectedFiles,
} from "./scripts/runtime-sync-check.mjs";
import {
  mergeRepoClaudeSettings,
} from "./scripts/claude-settings-merge.mjs";
import {
  buildCodexHooksJson,
  buildCursorHooksJson,
  runtimeHookSourceOwner,
  stripProjectMetaKimHooksFromHookConfig,
} from "./scripts/runtime-hook-mapping.mjs";
import {
  GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
  globalProjectionIsOwnedBy,
  loadLocalOverrides,
  normalizeTargets,
  parseSkillsArg,
  resolveTargetContext,
  resolveRuntimeProfilesFromManifest,
  resolveRuntimeHomeDir,
  writeLocalOverrides,
} from "./scripts/meta-kim-sync-config.mjs";
import {
  MIN_NODE_VERSION,
  isSupportedNodeVersion,
} from "./scripts/node-runtime-requirements.mjs";
import {
  memoryServiceEnv,
  memoryServerHttpArgs,
  resolveMemoryEndpoint,
} from "./scripts/memory-endpoint.mjs";
import {
  PYTHON_MEMORY_HEALTH_PROBE,
  buildBootMemoryServiceEnv,
  buildInitialMemoryServiceEnv,
  acquireEndpointStartLock,
  endpointStartLockName,
  executeMcpMemoryReconciliation,
  firstStartLogPaths,
  observeMemoryServiceChild,
  planMcpMemoryReconciliation,
  probeMcpMemoryHealth,
  repairWindowsCandidateOnnxRuntime,
  releaseEndpointStartLock,
  withEndpointStartLock,
  waitForMcpMemoryHealth,
  verifyPrivateRecoveryRoot,
} from "./scripts/mcp-memory-service-lifecycle.mjs";
import {
  inspectEndpointListener,
  isEndpointNotListening,
  resolveWindowsVenvProcessExpectation,
  stopVerifiedEndpointProcess,
  verifyMemoryListenerIdentity,
} from "./scripts/mcp-memory-process-control.mjs";
import {
  cleanupExpiredMcpMemoryRecoveryArtifacts,
  preparePrivateTransactionRoot,
  runCandidateOnnxSentinel,
  runMcpMemoryRecoveryProtocol,
  runMcpMemoryUpgradeTransaction,
  sqliteBackupWithQuickCheck,
  sqliteQuickCheck,
  sqliteRestoreWithQuickCheck,
  MCP_MEMORY_NO_DATABASE_DIGEST,
  MCP_MEMORY_TRANSACTION_ID_PATTERN,
  validateMcpMemoryRecoveryMaterial,
  writeJsonAtomic,
} from "./scripts/mcp-memory-upgrade-transaction.mjs";
import {
  executeSafeManagedFileTransaction,
  withSafeManagedFileLock,
} from "./scripts/safe-managed-file-operations.mjs";
import {
  ensureSafeProjectDirectory,
  isPathInsideDir,
  mergeProjectCleanupResults,
  projectCleanupRetryableIssues,
  projectCleanupStatus,
  projectFileHash,
  projectPathDigest,
  projectRemovalProofForManifestEntry,
  projectRemovalUnprovenReasonForManifestEntry,
  safeProjectPathInfo,
  summarizeProjectAssetCleanup,
} from "./scripts/project-bootstrap-file-safety.mjs";
import {
  normalizeSetupCliArgs,
  validateSetupCliArgs,
} from "./scripts/setup-cli-policy.mjs";
import {
  INSTALL_STEP_CLASSIFICATION,
  INSTALL_STEP_OUTCOME,
  installStep,
  summarizeInstallStatus,
} from "./scripts/install-status-semantics.mjs";
import {
  MCP_MEMORY_SETUP_ACTION,
  MCP_MEMORY_SETUP_REASON,
  resolveMcpMemorySetupPolicy,
} from "./scripts/setup-memory-policy.mjs";
import {
  MetaKimConfigError,
  loadMetaKimConfig,
} from "./scripts/meta-kim-config-loader.mjs";
import {
  isProtectedProjectCapabilityPath,
  loadProtectedProjectCapabilityPaths,
  protectedProjectCapabilityIntersects,
} from "./scripts/project-capability-ownership.mjs";
import {
  classifyProjectProjectionUpdate,
} from "./scripts/project-bootstrap-update-policy.mjs";
import {
  joinProjectRegistry,
  listJoinedProjectRegistryEntries,
} from "./scripts/project-registry.mjs";
import { resolveExistingManagedProjectCandidates } from "./scripts/existing-managed-projects.mjs";

// ── Config ──────────────────────────────────────────────

const PROJECT_DIR = resolve(import.meta.dirname || ".");
const PROJECT_PLAN_CONTENT = Symbol("projectPlanContent");
const CALLER_CWD = resolve(process.env.META_KIM_CALLER_CWD || process.cwd());
const SKILLS_DIR = join(resolveRuntimeHomeDir("claude"), "skills");
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const isWin = platform() === "win32";
const args = normalizeSetupCliArgs(process.argv.slice(2));
try {
  validateSetupCliArgs(args);
} catch (error) {
  console.error(`meta-kim setup: ${error.message}`);
  if (error.showHelp) {
    console.error("Run 'meta-kim --help' for supported commands and options.");
  }
  process.exit(2);
}
const updateMode = args.includes("--update") || args.includes("-u");
const checkOnly = args.includes("--check");
const projectBootstrapMode = args.includes("--project-bootstrap");
const projectCleanupMode =
  args.includes("--cleanup-projects") || args.includes("--project-cleanup");
const projectBootstrapDryRun = args.includes("--dry-run");
const projectBootstrapApply = args.includes("--apply");
const jsonOutputMode = args.includes("--json");
const silentMode = args.includes("--silent") || !process.stdout.isTTY;
const useSavedProjectDirsMode =
  args.includes("--all-projects") || args.includes("--update-projects");
const saveProjectDirsMode = args.includes("--save-project-dirs");
// Global hook projection policy: always opt-in. Installation and update may
// only change user-level runtime hook settings after an explicit CLI/env
// request. `--without-global-hooks` remains a compatibility no-op.
const setupWithGlobalHooks =
  args.includes("--with-global-hooks") ||
  process.env.META_KIM_WITH_GLOBAL_HOOKS === "1";
const skipOptionalTools = process.env.META_KIM_SKIP_OPTIONAL_TOOLS === "1";
const preferLocalDependencies =
  process.env.META_KIM_PREFER_LOCAL_DEPENDENCIES === "1";

function writeUtf8BomFileSync(path, content) {
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(content, "utf8"),
    ]),
  );
}

/** Interactive extras (default off): proxy prompts stay opt-in; install scope is always shown in TTY. */
const promptProxy =
  args.includes("--prompt-proxy") || process.env.META_KIM_PROMPT_PROXY === "1";

/** Maps `node setup.mjs --lang zh` etc. to canonical language codes (defined before --lang handling). */
// const INSTALL_LOG_FILE = join(
//   homedir(),
//   ".cache",
//   "meta-kim-setup",
//   `install-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.log`,
// );

/** Maps `node setup.mjs --lang zh` etc. to canonical language codes (defined before --lang handling). */
const LANG_ARG_ALIASES = { zh: "zh-CN", ja: "ja-JP", ko: "ko-KR" };
function normalizeLangCliArg(arg) {
  if (!arg) return null;
  const trimmed = String(arg).trim();
  const lower = trimmed.toLowerCase();
  return LANG_ARG_ALIASES[lower] || trimmed;
}

const langIdx = args.indexOf("--lang");
const langArg = langIdx >= 0 && args[langIdx + 1] ? args[langIdx + 1] : null;
let currentLangCode = langArg ? normalizeLangCliArg(langArg) : "en";

function normalizeProjectDeployDir(rawDir) {
  const raw = String(rawDir || "").trim();
  if (!raw) return null;
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  if (raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(CALLER_CWD, raw);
}

function uniqueProjectDeployDirs(dirs) {
  const seen = new Set();
  const result = [];
  for (const rawDir of dirs || []) {
    const dir = normalizeProjectDeployDir(rawDir);
    if (!dir) continue;
    const key = isWin ? dir.replace(/\\/g, "/").toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(dir);
  }
  return result;
}

function parseProjectDeployDirArgs(argv = args) {
  const values = [];
  const names = new Set(["--project-dir", "--deploy-dir", "--target-dir"]);
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (names.has(current) && argv[index + 1]) {
      values.push(argv[index + 1]);
      index += 1;
      continue;
    }
    for (const name of names) {
      const prefix = `${name}=`;
      if (current.startsWith(prefix)) {
        values.push(current.slice(prefix.length));
      }
    }
  }
  return uniqueProjectDeployDirs(values);
}

const cliProjectDeployDirs = parseProjectDeployDirArgs(args);

let metaKimConfig;
try {
  metaKimConfig = loadMetaKimConfig({ repoRoot: PROJECT_DIR });
} catch (error) {
  const prefix =
    error instanceof MetaKimConfigError
      ? `Meta_Kim configuration error [${error.code}]`
      : "Meta_Kim configuration error";
  console.error(`${prefix}: ${error.message}`);
  process.exit(2);
}
const setupRuntimeProfiles = resolveRuntimeProfilesFromManifest(
  metaKimConfig.syncConfig,
);
const RUNTIME_CHOICES = Object.freeze(
  metaKimConfig.syncConfig.supportedTargets.map((id) => Object.freeze({
    id,
    label: setupRuntimeProfiles[id].label,
  })),
);

const skillsManifest = {
  skillOwner: metaKimConfig.skills.skillOwner,
  skills: metaKimConfig.skills.skills.map((skill) => ({
    name: skill.id,
    repo: skill.repository.source,
    repoUrl: skill.repository.cloneUrl,
    subdir: resolveManifestSkillSubdir(skill, platform(), {
      fallbackToFindskillPack: true,
    }),
    claudePlugin: skill.claudePlugin,
    defaultSelected: skill.defaultSelected ?? true,
    targets: skill.targets,
  })),
};
const SKILL_OWNER = skillsManifest.skillOwner;
const SKILLS = skillsManifest.skills;
const DISTRIBUTION = metaKimConfig.distribution;

function getDefaultSkillIds() {
  return SKILLS.filter((s) => s.defaultSelected).map((s) => s.name);
}

function normalizeSkillIds(rawIds) {
  const validByLower = new Map(
    SKILLS.map((s) => [s.name.toLowerCase(), s.name]),
  );
  const seen = new Set();
  const out = [];
  for (const raw of rawIds || []) {
    const key = String(raw || "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    const canonical = validByLower.get(key);
    if (!canonical) continue;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

const packageJsonPath = join(PROJECT_DIR, "package.json");
const packageVersion = existsSync(packageJsonPath)
  ? JSON.parse(readFileSync(packageJsonPath, "utf8")).version || "dev"
  : "dev";

// ── i18n ────────────────────────────────────────────────

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh-CN", label: "中文" },
  { code: "ja-JP", label: "日本語" },
  { code: "ko-KR", label: "한국어" },
];

// i18n strings live in config/i18n/setup-strings.mjs to keep setup.mjs small.
// buildI18N is a closure so the (v) => ... functions can reference MIN_NODE_VERSION.
import {
  buildI18N,
  PROJECT_BOOTSTRAP_CHOICE_COPY,
} from "./config/i18n/setup-strings.mjs";
const I18N = buildI18N({ MIN_NODE_VERSION });

let t = I18N.en; // default, overwritten by selectLanguage()
let quickDeployDir = null; // first deploy target shown in legacy next-step text
let quickDeployDirs = []; // set by quick deploy / project deploy exports

function detectNpxMode() {
  const normalized = PROJECT_DIR.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("_npx") || normalized.includes("npm-cache");
}

function isSourceCheckout() {
  return existsSync(join(PROJECT_DIR, ".git"));
}

if (langArg) {
  const code = normalizeLangCliArg(langArg);
  const langMatch = LANGUAGES.find((l) => l.code === code);
  if (langMatch && I18N[langMatch.code]) {
    t = I18N[langMatch.code];
  }
}

/** Format i18n string with placeholder replacement */
function fmt(template, values = {}) {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  return result;
}

// ── ANSI colors ─────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  // Logo/frame only - dark amber gold
  amber: "\x1b[38;2;160;120;60m",
  amberBright: "\x1b[38;2;200;160;80m",
  // Section headings - gray for contrast
  section: "\x1b[38;5;240m",
};

function log(icon, msg) {
  console.log(`${icon} ${msg}`);
}
function ok(msg) {
  log(`${C.green}✓${C.reset}`, msg);
}
function skip(msg) {
  log(`${C.yellow}⊘${C.reset}`, `${C.dim}${msg}${C.reset}`);
}
function warn(msg) {
  log(`${C.yellow}⚠${C.reset}`, msg);
}
function fail(msg) {
  log(`${C.red}✗${C.reset}`, msg);
}
function info(msg) {
  log(`${C.dim}ℹ${C.reset}`, msg);
}
function heading(msg) {
  console.log(`\n${C.bold}${C.section}▸ ${msg}${C.reset}`);
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: "pipe",
      cwd: PROJECT_DIR,
      shell: isWin,
      ...opts,
    }).trim();
  } catch {
    return null;
  }
}

function quoteCliArgForShell(value) {
  const text = String(value);
  if (text === "") return '""';
  if (!/[^\w@%+=:,./\\-]/.test(text)) return text;
  return `"${text.replace(/(["^&|<>])/g, "^$1")}"`;
}

function spawnCliSync(command, commandArgs = [], options = {}) {
  if (isWin) {
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

// Cross-platform CLI detection: tries direct, .exe, then where/which fallback
function detectCli(name) {
  for (const cmd of [name, `${name}.exe`]) {
    const ver = run(`${cmd} --version`);
    if (ver) return ver.split(/\r?\n/)[0].trim();
  }
  const resolved = isWin
    ? run(`where ${name} 2>nul`)
    : run(`which ${name} 2>/dev/null`);
  if (resolved) {
    const path = resolved.split(/\r?\n/)[0].trim();
    const ver = run(`"${path}" --version`);
    if (ver) return ver.split(/\r?\n/)[0].trim();
  }
  return null;
}

function gitProxyArgs() {
  if (!PROXY) return "";
  return `-c http.proxy=${PROXY} -c https.proxy=${PROXY}`;
}

// ── Interactive prompt ──────────────────────────────────

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${C.bold}?${C.reset} ${question} `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askYesNo(question, defaultYes = true) {
  if (silentMode) return defaultYes;
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await ask(`${question} ${C.dim}${hint}${C.reset}`);
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

// ── Interactive lists ───────────────────────────────────
//
// TTY: @inquirer/prompts (select / checkbox) — reliable ↑↓ / Space / Enter on Windows, Cursor, narrow panels.
// Non-TTY: numbered readline fallback (CI / pipes).
//
// Layout: blank line before each prompt block; newline after question so options sit below a clear gap.

const ANSI_STRIP_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s) {
  return String(s ?? "").replace(ANSI_STRIP_RE, "");
}

function blankLineBeforeInquirerPrompt() {
  console.log("");
}

/** Trailing \\n on message yields a visual blank line before the choice list (see @inquirer/select render). */
function inquirerPromptQuestionLine(text) {
  return `${stripAnsi(text)}\n`;
}

function inquirerThemeSingle() {
  return {
    style: {
      keysHelpTip: () => t.inquirerSingleHotkeys,
    },
  };
}

function inquirerThemeMulti() {
  return {
    style: {
      keysHelpTip: () => t.inquirerMultiHotkeys,
    },
  };
}

let warnedInquirerFallback = false;

function isMissingInquirerPromptsError(error) {
  const message = String(error?.message || "");
  return (
    (error?.code === "ERR_MODULE_NOT_FOUND" &&
      message.includes("@inquirer/prompts")) ||
    message.includes("Cannot find package '@inquirer/prompts'")
  );
}

function warnInquirerFallbackOnce() {
  if (warnedInquirerFallback) return;
  warnedInquirerFallback = true;
  warn(t.inquirerUnavailableFallback);
}

async function importInquirerPrompt(name) {
  try {
    const mod = await import("@inquirer/prompts");
    return mod[name] ?? null;
  } catch (error) {
    if (!isMissingInquirerPromptsError(error)) throw error;
    warnInquirerFallbackOnce();
    return null;
  }
}

function formatSelectChoiceLabel(option) {
  const text =
    typeof option === "string" ? option : option.label || option.toString();
  return stripAnsi(text);
}

/** Static list for non-interactive / piped stdin (no @inquirer). */
function printSelectMenu(question, options, selected) {
  console.log(`\n${C.bold}?${C.reset} ${question}`);
  for (let i = 0; i < options.length; i++) {
    const prefix = i === selected ? `${C.green}▶${C.reset} ` : "  ";
    const text =
      typeof options[i] === "string"
        ? options[i]
        : options[i].label || options[i].toString();
    console.log(`${C.dim}${i + 1}.${C.reset} ${prefix}${text}`);
  }
}

function printMultiMenu(question, choices, focused, selected) {
  console.log(`\n${C.bold}?${C.reset} ${question}`);
  for (let i = 0; i < choices.length; i++) {
    const isFocused = i === focused;
    const isSelected = selected.has(choices[i].id);
    const focusMark = isFocused ? `${C.yellow}▶${C.reset} ` : "  ";
    const checkMark = isSelected ? `${C.green}✓${C.reset}` : " ";
    const text = choices[i].label || choices[i].toString();
    const idStr = choices[i].id || "";
    console.log(
      `${C.dim}${i + 1}.${C.reset} [${checkMark}] ${focusMark}${text} ${C.dim}(${idStr})${C.reset}`,
    );
  }
}

async function numberedSelectFallback(question, options) {
  printSelectMenu(question, options, 0);
  const answer = await ask(t.choose(options.length));
  const idx = parseInt(answer, 10) - 1;
  return idx >= 0 && idx < options.length ? idx : 0;
}

function parseMultiSelectAnswer(answer, choices, defaultIds) {
  if (!answer) return defaultIds;
  const parts = answer
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return defaultIds;
  return parts.map((part) => {
    if (/^\d+$/.test(part)) {
      const index = parseInt(part, 10) - 1;
      return choices[index]?.id ?? part;
    }
    return part.toLowerCase();
  });
}

async function numberedMultiSelectFallback(question, choices, defaultIds, hintText) {
  printMultiMenu(question, choices, 0, new Set(defaultIds));
  const answer = await ask(`${hintText(`${C.dim}${defaultIds.join(", ")}${C.reset}`)}`);
  return parseMultiSelectAnswer(answer, choices, defaultIds);
}

async function keyboardSelect(question, options) {
  if (silentMode) return 0;

  if (!process.stdin.isTTY) {
    return numberedSelectFallback(question, options);
  }

  const select = await importInquirerPrompt("select");
  if (!select) return numberedSelectFallback(question, options);

  const choices = options.map((o, i) => ({
    name: formatSelectChoiceLabel(o),
    value: i,
  }));

  blankLineBeforeInquirerPrompt();
  const answer = await select({
    message: inquirerPromptQuestionLine(question),
    choices,
    default: 0,
    loop: true,
    theme: inquirerThemeSingle(),
  });

  return typeof answer === "number" && answer >= 0 && answer < options.length
    ? answer
    : 0;
}

async function keyboardMultiSelect(question, choices, defaultIds, hintText) {
  if (silentMode) return defaultIds;

  if (!process.stdin.isTTY) {
    return numberedMultiSelectFallback(question, choices, defaultIds, hintText);
  }

  const checkbox = await importInquirerPrompt("checkbox");
  if (!checkbox) return numberedMultiSelectFallback(question, choices, defaultIds, hintText);

  const cbChoices = choices.map((c) => ({
    name: stripAnsi(`${c.label || ""} (${c.id || ""})`),
    value: c.id,
    checked: defaultIds.includes(c.id),
  }));

  blankLineBeforeInquirerPrompt();
  const picked = await checkbox({
    message: inquirerPromptQuestionLine(question),
    choices: cbChoices,
    required: false,
    theme: inquirerThemeMulti(),
  });

  return Array.isArray(picked) ? picked : defaultIds;
}

/** Alias for compatibility — redirect to keyboardSelect */
async function askSelect(question, options) {
  return keyboardSelect(question, options);
}

/** Alias for compatibility — redirect to keyboardMultiSelect */
async function askMultiSelectTargets(question, choices, defaultIds) {
  return keyboardMultiSelect(question, choices, defaultIds, t.inputTargetsHint);
}

/** Alias for compatibility — redirect to keyboardMultiSelect */
async function askMultiSelectSkillRepos(question, choices, defaultIds) {
  return keyboardMultiSelect(
    question,
    choices,
    defaultIds,
    t.inputSkillIdsHint,
  );
}

async function resolveSelectedSkillDependencyIds() {
  const cliSkills = parseSkillsArg(args);
  if (cliSkills !== null) {
    const validLower = new Set(SKILLS.map((s) => s.name.toLowerCase()));
    for (const raw of cliSkills) {
      const k = String(raw || "")
        .trim()
        .toLowerCase();
      if (k && !validLower.has(k)) {
        warn(t.warnUnknownSkillId(k));
      }
    }
    return normalizeSkillIds(cliSkills);
  }
  if (silentMode) {
    return getDefaultSkillIds();
  }
  const skillChoices = SKILLS.map((skill) => ({
    id: skill.name,
    label: skill.label || skill.name,
  }));
  const pickedSkills = await askMultiSelectSkillRepos(
    t.askSkillReposChoice ?? "Choose third-party skill repos to install",
    skillChoices,
    getDefaultSkillIds(),
  );
  return normalizeSkillIds(pickedSkills);
}

// ── Proxy configuration ────────────────────────────────

/**
 * Detect Windows system proxy from registry.
 * Returns { url, port, source } or null.
 */
function detectWindowsSystemProxy() {
  if (platform() !== "win32") return null;
  try {
    const enableResult = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    if (!enableResult.includes("0x1")) return null;

    const serverResult = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const match = serverResult.match(/REG_SZ\s+(.+)/);
    if (!match) return null;

    let raw = match[1].trim();
    if (raw.includes("=")) {
      const httpsEntry = raw
        .split(";")
        .find((s) => s.trim().startsWith("https="));
      const httpEntry = raw
        .split(";")
        .find((s) => s.trim().startsWith("http="));
      raw = (httpsEntry || httpEntry || raw).split("=").pop().trim();
    }
    if (!raw.includes("://")) raw = `http://${raw}`;

    // Extract port from URL
    let port = null;
    try {
      const parsed = new URL(raw);
      port = parsed.port ? parseInt(parsed.port, 10) : null;
    } catch {
      // ignore
    }

    return { url: raw, port, source: "system" };
  } catch {
    return null;
  }
}

/**
 * Ask user to configure git proxy.
 * Auto-detects system proxy port. Default = YES (use it). User can opt out.
 * Returns { port, url, source } or null (skip / no proxy).
 * Saves result to localOverrides.gitProxy.
 */
async function askProxyConfig() {
  const localOverrides = await loadLocalOverrides();

  // Non-interactive or prompts disabled: no git proxy in localOverrides (use HTTPS_PROXY for tools if set)
  if (silentMode || !promptProxy) {
    return null;
  }

  heading(t.proxyHeading);

  // Auto-detect system proxy, ask user to confirm (default = yes)
  const sysProxy = detectWindowsSystemProxy();

  if (sysProxy) {
    const answer = await ask(
      `${t.proxyDetectedPrompt(sysProxy.port, sysProxy.url)} ${C.dim}[Y/n]${C.reset}:`,
    );
    const trimmed = answer.trim().toLowerCase();
    // Default = yes (use proxy), only skip if user explicitly says n or no
    if (trimmed === "n" || trimmed === "no") {
      skip(t.proxySkipDeclined);
      if (localOverrides.gitProxy != null) {
        await writeLocalOverrides({ ...localOverrides, gitProxy: undefined });
      }
      return null;
    }
    // Empty input or y/yes → accept proxy
    ok(t.proxySaved(sysProxy.url));
    await writeLocalOverrides({ ...localOverrides, gitProxy: sysProxy.url });
    return { url: sysProxy.url, source: "system" };
  }

  // No system proxy detected — skip entirely
  skip(t.proxySkip);
  return null;
}

// ── Step 0: Language selection ───────────────────────────

async function selectLanguage() {
  if (langArg) {
    const code = normalizeLangCliArg(langArg);
    const match = LANGUAGES.find((l) => l.code === code);
    if (match) {
      t = I18N[match.code];
      currentLangCode = match.code;
      return match;
    }
  }

  if (silentMode) {
    currentLangCode = LANGUAGES[0].code;
    return LANGUAGES[0];
  }

  const labels = LANGUAGES.map((l) => `${l.label} (${l.code})`);
  const idx = await askSelect(t.selectLang, labels);
  t = I18N[LANGUAGES[idx].code];
  currentLangCode = LANGUAGES[idx].code;
  return LANGUAGES[idx];
}

// ── Utility functions ─────────────────────────────────────

/** Detect if this is first-time setup */
function isFirstRun() {
  const stateDir = join(PROJECT_DIR, ".meta-kim", "state");
  return !existsSync(stateDir);
}

/** Show installation overview before starting (scope-aware bullets) */
function showInstallOverview(
  activeTargets,
  installScope,
  skillIds = [],
) {
  const bullets = [];
  if (installScope === "project") {
    bullets.push(t.installOverviewSyncConfig);
  } else {
    bullets.push(t.installOverviewInstallSkills);
    bullets.push(t.installOverviewSyncMeta);
  }
  // graphify is always optional — show as optional hint, not a bullet
  const scopeLabel =
    {
      project: t.installScopeProjectLabel,
      global: t.installScopeGlobalLabel,
    }[installScope] || installScope;

  const skillLine =
    installScope === "project"
      ? ""
      : `\n${C.dim}${t.installOverviewSkillList}${C.reset}${
          skillIds.length > 0 ? skillIds.join(", ") : t.installOverviewNoSkills
        }`;

  console.log(`
${C.bold}${t.installOverviewTitle}${C.reset}

${C.dim}${t.installOverviewWill}${C.reset}
${bullets.map((b) => `${C.dim}•${C.reset} ${b}`).join("\n")}
${C.dim}•${C.reset} ${C.dim}${t.installOverviewOptionalPython}${C.reset} ${C.yellow}${t.labelOptional}${C.reset}

${C.dim}${t.installOverviewTargets}${C.reset}${activeTargets.join(", ")}
${C.dim}${t.installOverviewScope}${C.reset}${scopeLabel}${skillLine}
${C.dim}${t.installOverviewEstimated}${C.reset}${t.installOverviewTime}
`);
}

/**
 * Print a summary of Meta_Kim's existing install footprint (from manifests
 * written by prior sync runs) so the user can see what this install is about
 * to refresh. Pure read-only; safe to call even when no manifest exists.
 */
async function showExistingFootprint(installScope) {
  const { readManifest, manifestPathFor, listByCategory } =
    await import("./scripts/install-manifest.mjs");

  const sources = [];
  if (installScope === "global") {
    try {
      const m = readManifest(manifestPathFor("global"));
      if (m && m.entries?.length > 0)
        sources.push({ scope: "global", manifest: m });
    } catch {
      /* manifest read is best-effort */
    }
  }
  if (installScope === "project") {
    try {
      const m = readManifest(manifestPathFor("project", PROJECT_DIR));
      if (m && m.entries?.length > 0)
        sources.push({ scope: "project", manifest: m });
    } catch {
      /* manifest read is best-effort */
    }
  }

  console.log(`\n${C.bold}${t.footprintTitle}${C.reset}`);
  if (sources.length === 0) {
    console.log(`${C.dim}${t.footprintFirstInstall}${C.reset}\n`);
    return;
  }
  console.log("");

  for (let i = 0; i < sources.length; i++) {
    if (i > 0) console.log("");
    const { scope, manifest } = sources[i];
    const grouped = listByCategory(manifest);
    const scopeLabel =
      scope === "global" ? t.footprintScopeGlobal : t.footprintScopeProject;
    console.log(
      `${C.cyan}${scopeLabel}${C.reset}: ${manifest.entries.length} ${t.footprintEntries}`,
    );
    for (const [cat, items] of Object.entries(grouped)) {
      if (items.length === 0) continue;
      const catLabel = t.footprintCategoryLabels?.[cat] ?? cat;
      console.log(`${cat}. ${catLabel}: ${C.bold}${items.length}${C.reset}`);
    }
  }
  console.log("");
  console.log(`${C.dim}${t.footprintRefreshNote}${C.reset}`);
  console.log("");
}

/** Execute with progress indicator */
async function withProgress(label, fn) {
  console.log("");
  console.log(`${C.dim}→${C.reset} ${label}`);

  try {
    return await fn();
  } catch (err) {
    console.log(`${C.red}✗${C.reset}`);
    throw err;
  }
}

// ── Quick deploy (npx mode) ────────────────────────────

const QUICK_PLATFORMS = [
  { id: "claude", labelKey: "npxQuickPlatformClaude" },
  { id: "openclaw", labelKey: "npxQuickPlatformOpenclaw" },
  { id: "codex", labelKey: "npxQuickPlatformCodex" },
  { id: "cursor", labelKey: "npxQuickPlatformCursor" },
  { id: "all", labelKey: "npxQuickPlatformAll" },
];

async function askQuickPlatform() {
  const labels = QUICK_PLATFORMS.map((p) => t[p.labelKey]);
  const idx = await askSelect(t.npxQuickPlatformPrompt, labels);
  return QUICK_PLATFORMS[idx].id;
}

async function askTargetDirectory() {
  const rawDefault = t.npxQuickDirDefault;
  const expandedDefault = rawDefault
    .replace(/^~\//, homedir() + "/")
    .replace(/^~\\/, homedir() + "\\");
  const answer = await ask(
    `${t.npxQuickDirPrompt} ${C.dim}[${rawDefault}]${C.reset}`,
  );
  const raw = (answer || "").trim();
  if (!raw) return expandedDefault;
  return normalizeProjectDeployDir(raw);
}

function normalizeDeployRelPath(relPath) {
  return String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

const DEPLOY_LOCAL_STATE_PATHS = new Set([
  ".claude/project-task-state.json",
  ".claude/scheduled_tasks.lock",
  ".claude/settings.local.json",
]);

const DEPLOY_PROTECTED_JSON_PATHS = new Set([
  ".claude/settings.json",
  ".mcp.json",
  ".codex/hooks.json",
  ".cursor/hooks.json",
  ".cursor/mcp.json",
  "openclaw/openclaw.template.json",
]);

const DEPLOY_PROTECTED_TEXT_PATHS = new Set(["AGENTS.md", "CLAUDE.md"]);

const DEPLOY_SKIP_CONFIG_PATHS = new Set([
  ".codex/config.toml",
]);

const PROJECT_BOOTSTRAP_MERGED_CONFIG_PATHS = new Set([
  ...DEPLOY_PROTECTED_JSON_PATHS,
  ...DEPLOY_PROTECTED_TEXT_PATHS,
  ...DEPLOY_SKIP_CONFIG_PATHS,
]);

const GLOBAL_HOOK_PACKAGE_FILES_LIST = [
  "project-root.mjs",
  "utils.mjs",
  "skip-reminder.mjs",
  "spine-state-utils.mjs",
  "spine-state-gates.mjs",
  "spine-state.mjs",
  "activate-meta-theory-spine.mjs",
  "bash-readonly-whitelist.mjs",
  "block-dangerous-bash.mjs",
  "ecc-permission-cache-wrapper.mjs",
  "enforce-agent-dispatch.mjs",
  "graphify-context.mjs",
  "meta-kim-memory-save.mjs",
  "post-console-log-warn.mjs",
  "post-format.mjs",
  "post-typecheck.mjs",
  "stop-compaction.mjs",
  "stop-completion-guard.mjs",
  "stop-console-log-audit.mjs",
  "stop-memory-save.mjs",
  "stop-save-progress.mjs",
  "stop-spine-cleanup.mjs",
  "subagent-context.mjs",
];

const PROJECT_LOCAL_CAPABILITY_PREFIXES = [
  ".claude/agents/",
  ".claude/skills/",
  ".claude/commands/",
  ".claude/hooks/",
  ".claude/capability-index/",
  ".codex/agents/",
  ".codex/skills/",
  ".codex/commands/",
  ".codex/hooks/",
  ".codex/capability-index/",
  ".agents/skills/",
  ".cursor/agents/",
  ".cursor/skills/",
  ".cursor/hooks/",
  ".cursor/rules/",
  ".cursor/capability-index/",
  "openclaw/workspaces/",
  "openclaw/skills/",
  "openclaw/capability-index/",
  "openclaw/hooks/",
];

const PROJECT_SKILL_ROOTS_BY_PLATFORM = {
  claude: [".claude/skills"],
  codex: [".agents/skills"],
  cursor: [".cursor/skills"],
  openclaw: ["openclaw/skills"],
};

const PROJECT_META_KIM_CONFIG_RELS_BY_PLATFORM = {
  claude: [".claude/settings.json", ".mcp.json"],
  codex: [".codex/hooks.json", ".mcp.json"],
  cursor: [".cursor/hooks.json", ".cursor/mcp.json"],
  openclaw: ["openclaw/openclaw.template.json"],
};

const PROJECT_META_KIM_LOCAL_STATE_RELS = [
  ".claude/project-task-state.json",
  ".meta-kim/meta-kim-post-copy.mjs",
  ".meta-kim/state/default/project-bootstrap.json",
];

const PROJECT_HOOK_REL_DIRS_BY_PLATFORM = {
  claude: ".claude/hooks",
  codex: ".codex/hooks",
  cursor: ".cursor/hooks",
  openclaw: "openclaw/hooks",
};

const PROJECT_HOOK_SOURCE_CANDIDATES = {
  claude: [...GLOBAL_HOOK_PACKAGE_FILES_LIST],
  codex: [
    "project-root.mjs",
    "utils.mjs",
    "skip-reminder.mjs",
    "spine-state-utils.mjs",
    "spine-state-gates.mjs",
    "spine-state.mjs",
    "activate-meta-theory-spine.mjs",
    "bash-readonly-whitelist.mjs",
    "enforce-agent-dispatch.mjs",
    "graphify-context.mjs",
    "meta-kim-memory-save.mjs",
    "post-console-log-warn.mjs",
    "post-format.mjs",
    "post-typecheck.mjs",
    "stop-compaction.mjs",
    "stop-completion-guard.mjs",
    "stop-console-log-audit.mjs",
    "stop-spine-cleanup.mjs",
    "subagent-context.mjs",
  ],
  cursor: [
    "project-root.mjs",
    "utils.mjs",
    "skip-reminder.mjs",
    "spine-state-utils.mjs",
    "spine-state-gates.mjs",
    "spine-state.mjs",
    "activate-meta-theory-spine.mjs",
    "bash-readonly-whitelist.mjs",
    "enforce-agent-dispatch.mjs",
    "graphify-context.mjs",
    "post-console-log-warn.mjs",
    "post-format.mjs",
    "post-typecheck.mjs",
    "stop-compaction.mjs",
    "stop-completion-guard.mjs",
    "stop-console-log-audit.mjs",
    "stop-spine-cleanup.mjs",
    "subagent-context.mjs",
  ],
  openclaw: [
    "stop-save-progress.mjs",
  ],
};

function readProjectHookSource(platformId, hookName) {
  if (
    (platformId === "codex" || platformId === "cursor") &&
    hookName === "graphify-context.mjs"
  ) {
    return buildCodexGraphifyContextHookSource();
  }
  const owner = runtimeHookSourceOwner(platformId, hookName);
  if (!owner) {
    throw new Error(
      `No canonical Hook source owner for ${platformId}:${hookName}`,
    );
  }
  const sharedPath = join(
    PROJECT_DIR,
    "canonical",
    "runtime-assets",
    "shared",
    "hooks",
    hookName,
  );
  const claudePath = join(
    PROJECT_DIR,
    "canonical",
    "runtime-assets",
    "claude",
    "hooks",
    hookName,
  );
  const sourcePath = owner === "shared" ? sharedPath : claudePath;
  if (!existsSync(sourcePath)) {
    throw new Error(
      `Missing canonical Hook source for ${platformId}:${hookName} (owner=${owner})`,
    );
  }
  return readFileSync(sourcePath, "utf8");
}

function buildCodexGraphifyContextHookSource() {
  return [
    'import { existsSync, readFileSync } from "node:fs";',
    'import path from "node:path";',
    'import process from "node:process";',
    "",
    "function readPayload() {",
    "  try {",
    '    const raw = readFileSync(0, "utf8");',
    '    return raw.trim() ? JSON.parse(raw) : {};',
    "  } catch {",
    "    return {};",
    "  }",
    "}",
    "",
    "const payload = readPayload();",
    'const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();',
    'const graphPath = path.join(cwd, "graphify-out", "graph.json");',
    "",
    "if (existsSync(graphPath)) {",
    "  console.log(",
    "    JSON.stringify({",
    '      systemMessage: "graphify: Knowledge graph exists. For focused questions, run `graphify query \\"<question>\\" --budget 1000` first; use `graphify path`/`graphify explain` for relationships or concepts. Treat graph results as candidate file anchors and verify route-changing claims against source files; fall back to targeted `rg` when results are generic or stale. Read GRAPH_REPORT.md only for broad architecture context; never inject full graph.json or full GRAPH_REPORT.md.",',
    "    }),",
    "  );",
    "}",
    "",
  ].join("\n");
}

const OPENCLAW_AGENT_ORDER = [
  "meta-warden",
  "meta-genesis",
  "meta-artisan",
  "meta-sentinel",
  "meta-librarian",
  "meta-conductor",
  "meta-prism",
  "meta-scout",
];

function parseSetupAgentFrontmatter(raw, filePath) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`${filePath} is missing YAML frontmatter.`);
  }

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(`${filePath} has an invalid frontmatter line: ${line}`);
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }

  return { data, body: match[2].trimStart() };
}

function extractSetupAgentTitle(body, fallback) {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function roleFromSetupAgentTitle(title, fallback) {
  const parts = title.split(":");
  return parts.length > 1 ? parts.slice(1).join(":").trim() : fallback;
}

function sortSetupAgents(agents) {
  return [...agents].sort((left, right) => {
    const leftIndex = OPENCLAW_AGENT_ORDER.indexOf(left.id);
    const rightIndex = OPENCLAW_AGENT_ORDER.indexOf(right.id);
    if (leftIndex === -1 && rightIndex === -1) return left.id.localeCompare(right.id);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

function loadSetupAgents() {
  const canonicalAgentsDir = join(PROJECT_DIR, "canonical", "agents");
  const files = readdirSync(canonicalAgentsDir)
    .filter((file) => file.endsWith(".md"))
    .sort();

  const agents = [];
  for (const file of files) {
    const filePath = join(canonicalAgentsDir, file);
    const raw = readFileSync(filePath, "utf8");
    const { data, body } = parseSetupAgentFrontmatter(raw, filePath);
    if (!data.name || !data.description) {
      throw new Error(`${filePath} must define frontmatter name and description.`);
    }
    const title = extractSetupAgentTitle(body, data.name);
    agents.push({
      id: data.name,
      description: data.description,
      sourceFile: relative(PROJECT_DIR, filePath).replace(/\\/g, "/"),
      title,
      role: roleFromSetupAgentTitle(title, data.description),
      body: body.trim(),
    });
  }

  return sortSetupAgents(agents);
}

function parseSetupAgentPresentation(agent) {
  const titleMatch = agent.title.match(
    /^(.*?)(?::\s*(.*?))?(?:\s+([^\s]+))?$/u,
  );
  return {
    displayName: titleMatch?.[1]?.trim() || agent.id,
    localizedRole: titleMatch?.[2]?.trim() || agent.description,
    emoji: titleMatch?.[3]?.trim() || "🤖",
  };
}

function buildSetupOpenClawBootstrap(agent) {
  const { displayName, localizedRole } = parseSetupAgentPresentation(agent);

  return `# BOOTSTRAP.md - ${agent.id}

This workspace already ships Meta_Kim meta-architecture assets; do not invent a persona from scratch.

## Cold-start order

1. Read \`IDENTITY.md\` — confirm you are \`${displayName}\` and your role is ${localizedRole}.
2. Read \`SOUL.md\` — boundaries and quality bar.
3. Read \`TOOLS.md\` and \`AGENTS.md\` — decide what to delegate.
4. Update \`USER.md\` only when the user explicitly asks for long-lived context.

## First reply

- One sentence: what you own (and only that).
- Do not absorb other meta agents' responsibilities.
- Escalate cross-boundary conflicts to \`meta-warden\`.
`;
}

function buildSetupOpenClawIdentity(agent) {
  const { displayName, localizedRole, emoji } = parseSetupAgentPresentation(agent);

  return `# IDENTITY.md - ${agent.id}

- **Name:** ${displayName}
- **Creature:** Meta_Kim meta agent
- **Vibe:** Focused, minimal, clear boundaries; primary job: ${localizedRole}
- **Emoji:** ${emoji}
- **Avatar:**

## Identity Notes

- Agent ID: \`${agent.id}\`
- Core role: ${agent.description}
- Canonical source: \`${agent.sourceFile}\`
`;
}

function buildSetupOpenClawUser() {
  return `# USER.md - About Your Human

- **Name:**
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**
- **Notes:**

## Context

Record this user's long-term preferences for Meta_Kim work; do not store unrelated private data.
`;
}

function buildSetupOpenClawBoot(agent) {
  const { displayName } = parseSetupAgentPresentation(agent);

  return `# BOOT.md - ${agent.id}

After the OpenClaw gateway starts, run one-time boot checks in this order when needed.

1. Confirm the workspace path and that \`IDENTITY.md\`, \`SOUL.md\`, \`TOOLS.md\`, and \`AGENTS.md\` are readable.
2. Do not message the user proactively; act only when the boot task explicitly requires it.
3. If you see role-boundary conflicts, record them in \`MEMORY.md\` under open questions — do not rewrite persona on your own.
4. If you are \`${displayName}\`, keep boot checks inside your own boundary only.
`;
}

function buildSetupOpenClawMemory(agent) {
  return `# MEMORY.md - ${agent.id}

Store information that stays true across sessions.

## Do record

- Stable user preferences
- Recurring architecture decisions
- Confirmed boundary interpretations
- Risk constraints that keep applying

## Do not record

- One-off task state
- Ephemeral command output
- Unconfirmed guesses
- Personal data unrelated to Meta_Kim
`;
}

function buildSetupOpenClawTeamDirectory(agents) {
  const rows = agents
    .map((agent) => `| \`${agent.id}\` | ${agent.title} | ${agent.description} |`)
    .join("\n");

  return `# AGENTS.md - Meta_Kim Team Directory

This file is generated from \`canonical/agents/*.md\` by Meta_Kim runtime sync/bootstrap.

Use the smallest agent whose boundary matches the task. Escalate to \`meta-warden\` when the task spans multiple agent boundaries.

Important: this file lists only the Meta_Kim team. It is not the full OpenClaw registry. If the user asks how many agents exist, which agents are currently registered, or who can collaborate right now, query the live runtime registry first instead of answering from this file alone.

| Agent ID | Name | Responsibility |
| --- | --- | --- |
${rows}
`;
}

function buildSetupOpenClawSoul(agent) {
  return `# SOUL.md - ${agent.id}

Generated from \`${agent.sourceFile}\`. Edit the canonical source first, then run Meta_Kim runtime sync/bootstrap.

## Runtime Notes

- You are running inside OpenClaw.
- Read the local \`AGENTS.md\` before delegating with \`sessions_send\`.
- \`AGENTS.md\` only lists the Meta_Kim team, not the full OpenClaw registry.
- When the user asks which agents exist, how many agents exist, or who can collaborate right now, query the live runtime registry first through \`agents_list\`. If that tool is unavailable, fall back to an explicit runtime command and state the result source.
- Stay inside your own responsibility boundary unless the user explicitly asks you to coordinate broader work.
- The theory source is \`canonical/skills/meta-theory/references/meta-theory.md\`; public runtime behavior must not depend on local narrative notes.
- For \`meta-theory\`, \`/meta-theory\`, project understanding, architecture, runtime routing, hook/MCP/tool routing, commercialization, market, competitor, pricing, growth, strategy, or roadmap tasks, run or faithfully follow \`npm run meta:theory:run:notice -- "<user request>"\` before Thinking and relay the compact notice/report path. If command execution or retrieval capability is unavailable, return \`blocked_to_fetch\` with the exact missing capability instead of giving a shallow summary.
- Project-understanding Fetch must account for README, AGENTS, package scripts, canonical agents/skills/runtime assets, contracts, capability index, runtime projections, MCP configs, hooks, dependency registry, and Graphify when present.

${agent.body}
`;
}

function buildSetupOpenClawHeartbeat(agent) {
  const templatePath = join(
    PROJECT_DIR,
    "canonical",
    "runtime-assets",
    "openclaw",
    "HEARTBEAT.template.md",
  );
  const raw = readFileSync(templatePath, "utf8");
  return raw.replace(/^<!--[\s\S]*?-->\r?\n/, "").replaceAll("{{AGENT_ID}}", agent.id);
}

function buildSetupOpenClawTools(agent, agents) {
  const teammates = agents
    .filter((item) => item.id !== agent.id)
    .map((item) => `- \`${item.id}\`: ${item.description}`)
    .join("\n");

  return `# TOOLS.md - ${agent.id}

Auto-generated by Meta_Kim runtime sync/bootstrap. Edit canonical sources first, then re-sync.

## OpenClaw runtime conventions

- Read \`SOUL.md\` and \`AGENTS.md\` in this directory first.
- For collaboration, prefer OpenClaw native agent-to-agent routing.
- \`AGENTS.md\` lists the Meta_Kim team only — it is not the full OpenClaw registry.
- When the user asks for agent counts, names, or who can collaborate, call \`agents_list\` first; if unavailable, use an explicit command and state the source.
- Shared skill: \`../../skills/meta-theory/SKILL.md\` (directory under \`openclaw/skills/\`, not duplicated per workspace).
- Do not absorb other agents' duties; delegate or escalate to \`meta-warden\` when out of scope.

## Teammates

${teammates || "- None"}
`;
}

function buildOpenClawWorkspacePlans(targetDir, protectedPaths) {
  const agents = loadSetupAgents();
  const teamDirectory = buildSetupOpenClawTeamDirectory(agents);
  const builders = {
    "BOOT.md": (agent) => buildSetupOpenClawBoot(agent),
    "BOOTSTRAP.md": (agent) => buildSetupOpenClawBootstrap(agent),
    "IDENTITY.md": (agent) => buildSetupOpenClawIdentity(agent),
    "MEMORY.md": (agent) => buildSetupOpenClawMemory(agent),
    "USER.md": () => buildSetupOpenClawUser(),
    "SOUL.md": (agent) => buildSetupOpenClawSoul(agent),
    "AGENTS.md": () => teamDirectory,
    "HEARTBEAT.md": (agent) => buildSetupOpenClawHeartbeat(agent),
    "TOOLS.md": (agent) => buildSetupOpenClawTools(agent, agents),
  };

  return agents.flatMap((agent) =>
    OPENCLAW_WORKSPACE_MD.map((fileName) =>
      projectGeneratedFilePlan(
        `openclaw/workspaces/${agent.id}/${fileName}`,
        builders[fileName](agent),
        targetDir,
        `generated:openclaw-workspace:${agent.id}:${fileName}`,
        protectedPaths,
      ),
    ),
  );
}

function projectHookGeneratedPlans(platformId, targetDir, protectedPaths) {
  const plans = [];
  const relDir = PROJECT_HOOK_REL_DIRS_BY_PLATFORM[platformId];
  const hookNames = PROJECT_HOOK_SOURCE_CANDIDATES[platformId] ?? [];
  if (relDir && hookNames.length > 0) {
    for (const hookName of hookNames) {
      const content = readProjectHookSource(platformId, hookName);
      if (!content) continue;
      plans.push(projectGeneratedFilePlan(
        `${relDir}/${hookName}`,
        content,
        targetDir,
        `generated:project-hook:${platformId}:${hookName}`,
        protectedPaths,
      ));
    }
  }
  if (platformId === "openclaw") {
    plans.push(...buildOpenClawWorkspacePlans(targetDir, protectedPaths));
  }
  return plans;
}

function writeProjectGeneratedHooks(platformId, targetDir, protectedPaths) {
  let count = 0;
  for (const plan of projectHookGeneratedPlans(platformId, targetDir, protectedPaths)) {
    if (plan.action === "skip") continue;
    const content = plan.content;
    if (!content) continue;
    const destPath = join(targetDir, plan.relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, content, "utf8");
    count += 1;
  }
  return count;
}

function shouldSkipProjectDeployPath(relPath) {
  const rel = normalizeDeployRelPath(relPath);
  return (
    DEPLOY_LOCAL_STATE_PATHS.has(rel) ||
    DEPLOY_SKIP_CONFIG_PATHS.has(rel) ||
    rel.endsWith("/.openclaw/workspace-state.json")
  );
}

function isMetaKimNamespacedProjectPath(relPath) {
  const rel = normalizeDeployRelPath(relPath);
  return (
    rel === ".meta-kim/meta-kim-post-copy.mjs" ||
    rel.startsWith(".claude/agents/meta-") ||
    rel.startsWith(".codex/agents/meta-") ||
    rel.startsWith(".cursor/agents/meta-") ||
    rel.startsWith("openclaw/workspaces/meta-") ||
    rel.startsWith(".claude/skills/meta-theory/") ||
    rel.startsWith(".agents/skills/meta-theory/") ||
    rel.startsWith(".cursor/skills/meta-theory/") ||
    rel.startsWith("openclaw/skills/meta-theory/") ||
    rel.startsWith(".claude/capability-index/meta-kim-") ||
    rel.startsWith(".codex/capability-index/meta-kim-") ||
    rel.startsWith(".cursor/capability-index/meta-kim-") ||
    rel.startsWith("openclaw/capability-index/meta-kim-") ||
    // Hook scripts under each platform's hooks dir are Meta_Kim-managed when
    // their basename is on the canonical hook-file whitelist. Without this,
    // bootstrap misclassifies them as user files and aborts with
    // "user-owned file conflict" on every update.
    isMetaKimManagedHookRelPath(rel) ||
    rel === ".codex/commands/meta-theory.md"
  );
}

// Recognizes hook files shipped by Meta_Kim into a user's project hooks dir.
// Mirrors the GLOBAL_HOOK_PACKAGE_FILES whitelist so bootstrap correctly
// classifies them as owned by Meta_Kim (not as user-authored files).
function isMetaKimManagedHookRelPath(rel) {
  if (typeof rel !== "string") return false;
  const normalized = rel.replace(/\\/g, "/");
  let basename = null;
  if (normalized.startsWith(".claude/hooks/")) {
    basename = normalized.slice(".claude/hooks/".length);
  } else if (normalized.startsWith(".codex/hooks/")) {
    basename = normalized.slice(".codex/hooks/".length);
  } else if (normalized.startsWith(".cursor/hooks/")) {
    basename = normalized.slice(".cursor/hooks/".length);
  } else if (normalized.startsWith("openclaw/hooks/")) {
    basename = normalized.slice("openclaw/hooks/".length);
  }
  if (!basename) return false;
  const fileName = basename.split("/").pop();
  if (!fileName || !fileName.endsWith(".mjs")) return false;
  return GLOBAL_HOOK_PACKAGE_FILES_LIST.includes(fileName);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function parseJsonText(raw, filePath) {
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }
}

function readJsonObjectIfExists(filePath) {
  if (!existsSync(filePath)) return {};
  return parseJsonText(readFileSync(filePath, "utf8"), filePath);
}

function writeJsonObject(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function jsonEquivalent(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function managedTextBlockMarkers(relPath) {
  const id = `META_KIM MANAGED BLOCK: ${normalizeDeployRelPath(relPath)}`;
  return {
    begin: `<!-- BEGIN ${id} -->`,
    end: `<!-- END ${id} -->`,
  };
}

function mergeManagedTextBlockPreserveBase(base, generated, relPath) {
  const existing = String(base ?? "");
  const nextBlock = String(generated ?? "").trimEnd();
  const { begin, end } = managedTextBlockMarkers(relPath);
  const block = `${begin}\n${nextBlock}\n${end}`;
  if (!existing.trim()) return `${block}\n`;
  if (existing.trimEnd() === block) return `${block}\n`;
  const escapedBegin = begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`${escapedBegin}[\\s\\S]*?${escapedEnd}`);

  if (blockRe.test(existing)) {
    return `${existing.replace(blockRe, block).trimEnd()}\n`;
  }
  if (existing.trimEnd() === nextBlock) return `${block}\n`;
  return `${existing.trimEnd()}\n\n${block}\n`;
}

function stripManagedTextBlock(raw, relPath) {
  const { begin, end } = managedTextBlockMarkers(relPath);
  const escapedBegin = begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockRe = new RegExp(`${escapedBegin}[\\s\\S]*?${escapedEnd}`, "g");
  return String(raw ?? "").replace(blockRe, "").trim();
}

function equivalentText(left, right) {
  return String(left ?? "").replace(/\r\n/g, "\n").trimEnd() ===
    String(right ?? "").replace(/\r\n/g, "\n").trimEnd();
}

function rewriteProjectDirRefs(raw, targetDir) {
  const sourceForward = PROJECT_DIR.replace(/\\/g, "/");
  const targetForward = targetDir.replace(/\\/g, "/");
  return String(raw)
    .replaceAll("__REPO_ROOT__", targetForward)
    .replaceAll(sourceForward, targetForward)
    .replaceAll(PROJECT_DIR, targetDir);
}

function cloneJson(value) {
  return value == null ? value : structuredClone(value);
}

function stableJsonKey(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mergeArrayByIdPreserveBase(generated = [], base = []) {
  const result = cloneJson(base);
  const baseIds = new Map();
  for (let index = 0; index < result.length; index += 1) {
    const item = result[index];
    if (isPlainObject(item) && item.id) {
      baseIds.set(item.id, index);
    }
  }

  const seen = new Set(result.map(stableJsonKey));
  for (const item of generated) {
    if (isPlainObject(item) && item.id && baseIds.has(item.id)) {
      const index = baseIds.get(item.id);
      result[index] = mergeDeepPreserveBase(item, result[index]);
      continue;
    }
    const key = stableJsonKey(item);
    if (seen.has(key)) continue;
    result.push(cloneJson(item));
    seen.add(key);
  }
  return result;
}

function mergeDeepPreserveBase(generated, base) {
  if (Array.isArray(generated) || Array.isArray(base)) {
    return mergeArrayByIdPreserveBase(
      Array.isArray(generated) ? generated : [],
      Array.isArray(base) ? base : [],
    );
  }
  if (!isPlainObject(generated) || !isPlainObject(base)) {
    return base === undefined ? cloneJson(generated) : cloneJson(base);
  }

  const result = { ...cloneJson(generated), ...cloneJson(base) };
  for (const key of Object.keys(generated)) {
    if (base[key] === undefined) continue;
    if (isPlainObject(generated[key]) && isPlainObject(base[key])) {
      result[key] = mergeDeepPreserveBase(generated[key], base[key]);
    } else if (Array.isArray(generated[key]) || Array.isArray(base[key])) {
      result[key] = mergeArrayByIdPreserveBase(
        Array.isArray(generated[key]) ? generated[key] : [],
        Array.isArray(base[key]) ? base[key] : [],
      );
    }
  }
  return result;
}

function mergeMcpConfigPreserveBase(base, generated) {
  const merged = mergeDeepPreserveBase(generated, base);
  merged.mcpServers = {
    ...(generated.mcpServers ?? {}),
    ...(base.mcpServers ?? {}),
  };
  return merged;
}

function hookCommandKey(hook) {
  if (isPlainObject(hook) && typeof hook.command === "string") {
    return hook.command;
  }
  return stableJsonKey(hook);
}

function appendMissingHooks(existingHooks = [], generatedHooks = []) {
  const result = cloneJson(existingHooks);
  const seen = new Set(result.map(hookCommandKey));
  for (const hook of generatedHooks) {
    const key = hookCommandKey(hook);
    if (seen.has(key)) continue;
    result.push(cloneJson(hook));
    seen.add(key);
  }
  return result;
}

function mergeHookBlocks(existingBlocks = [], generatedBlocks = []) {
  const result = cloneJson(existingBlocks);
  for (const block of generatedBlocks) {
    if (!isPlainObject(block) || !Array.isArray(block.hooks)) {
      const key = stableJsonKey(block);
      if (!result.some((item) => stableJsonKey(item) === key)) {
        result.push(cloneJson(block));
      }
      continue;
    }

    const targetIndex = result.findIndex(
      (candidate) =>
        isPlainObject(candidate) &&
        candidate.matcher === block.matcher &&
        Array.isArray(candidate.hooks),
    );
    if (targetIndex === -1) {
      result.push(cloneJson(block));
      continue;
    }

    result[targetIndex] = {
      ...result[targetIndex],
      hooks: appendMissingHooks(result[targetIndex].hooks, block.hooks),
    };
  }
  return result;
}

function mergeHookConfigPreserveBase(base, generated) {
  const merged = mergeDeepPreserveBase(generated, base);
  const baseHooks = isPlainObject(base.hooks) ? base.hooks : {};
  const generatedHooks = isPlainObject(generated.hooks) ? generated.hooks : {};
  merged.hooks = { ...baseHooks };

  for (const [event, generatedEventValue] of Object.entries(generatedHooks)) {
    const existingEventValue = Array.isArray(baseHooks[event])
      ? baseHooks[event]
      : [];
    const generatedEvent = Array.isArray(generatedEventValue)
      ? generatedEventValue
      : [];
    const usesHookBlocks = generatedEvent.some(
      (item) => isPlainObject(item) && Array.isArray(item.hooks),
    );
    merged.hooks[event] = usesHookBlocks
      ? mergeHookBlocks(existingEventValue, generatedEvent)
      : appendMissingHooks(existingEventValue, generatedEvent);
  }

  return merged;
}

function prepareProjectDeployJson(relPath, srcPath, targetDir) {
  const rel = normalizeDeployRelPath(relPath);
  if (rel === ".mcp.json" || rel === ".cursor/mcp.json") {
    return { mcpServers: {} };
  }

  const raw = readFileSync(srcPath, "utf8");
  const parsed = parseJsonText(rewriteProjectDirRefs(raw, targetDir), srcPath);
  if (rel === "openclaw/openclaw.template.json") {
    delete parsed.mcp?.servers?.["meta-kim-runtime"];
  }
  return parsed;
}

function writeProjectManagedTransaction(targetDir, relPath, content, label) {
  const destPath = join(targetDir, relPath);
  return executeSafeManagedFileTransaction({
    trustedRoot: targetDir,
    backupRoot: join(targetDir, ".meta-kim", "backups"),
    operations: [{
      kind: "write",
      relPath,
      content,
      expectedOldHash: projectFileHash(destPath),
    }],
    transactionLabel: label,
  });
}

function mergeProtectedProjectDeployFile(srcPath, destPath, relPath, targetDir) {
  const result = writeProjectManagedTransaction(
    targetDir,
    relPath,
    JSON.stringify(plannedProtectedProjectDeployJson(srcPath, destPath, relPath, targetDir), null, 2) + "\n",
    "pre-merge",
  );
  if (!result.ok) throw new Error(`Protected project JSON write blocked: ${String(result.reason).replaceAll("_", "-")}`);
  return 1;
}

function mergeProtectedProjectDeployTextFile(srcPath, destPath, relPath, targetDir) {
  const result = writeProjectManagedTransaction(
    targetDir,
    relPath,
    plannedProtectedProjectDeployText(srcPath, destPath, relPath, targetDir),
    "pre-merge",
  );
  if (!result.ok) throw new Error(`Protected project text write blocked: ${String(result.reason).replaceAll("_", "-")}`);
  return 1;
}

function plannedProtectedProjectDeployJson(srcPath, destPath, relPath, targetDir) {
  const rel = normalizeDeployRelPath(relPath);
  const base = readJsonObjectIfExists(destPath);
  const generated = prepareProjectDeployJson(rel, srcPath, targetDir);

  if (rel === ".claude/settings.json") {
    return mergeRepoClaudeSettings(base, generated, targetDir);
  }
  if (rel === ".mcp.json" || rel === ".cursor/mcp.json") {
    return mergeMcpConfigPreserveBase(base, generated);
  }
  if (rel === ".codex/hooks.json" || rel === ".cursor/hooks.json") {
    return mergeHookConfigPreserveBase(base, generated);
  }
  return mergeDeepPreserveBase(generated, base);
}

function plannedProtectedProjectDeployText(srcPath, destPath, relPath, targetDir) {
  const rel = normalizeDeployRelPath(relPath);
  const generated = rewriteProjectDirRefs(readFileSync(srcPath, "utf8"), targetDir);
  const base = existsSync(destPath) ? readFileSync(destPath, "utf8") : "";
  return mergeManagedTextBlockPreserveBase(base, generated, rel);
}

function copyProjectDeployFile(srcPath, destPath, relPath, targetDir, protectedPaths) {
  const rel = normalizeDeployRelPath(relPath);
  if (shouldSkipProjectDeployPath(rel)) return 0;
  if (isProtectedProjectCapabilityPath(destPath, protectedPaths)) return 0;
  mkdirSync(dirname(destPath), { recursive: true });
  if (DEPLOY_PROTECTED_JSON_PATHS.has(rel)) {
    return mergeProtectedProjectDeployFile(srcPath, destPath, rel, targetDir);
  }
  if (DEPLOY_PROTECTED_TEXT_PATHS.has(rel)) {
    return mergeProtectedProjectDeployTextFile(srcPath, destPath, rel, targetDir);
  }
  cpSync(srcPath, destPath);
  return 1;
}

function copyDirRecursive(src, dest, context = {}) {
  if (!existsSync(src)) return 0;
  mkdirSync(dest, { recursive: true });
  let count = 0;
  const sourceRoot = context.sourceRoot || src;
  const targetDir = context.targetDir || dest;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    const relPath = normalizeDeployRelPath(relative(sourceRoot, srcPath));
    if (entry.isDirectory()) {
      count += copyDirRecursive(srcPath, destPath, {
        sourceRoot,
        targetDir,
        protectedPaths: context.protectedPaths,
      });
    } else {
      count += copyProjectDeployFile(
        srcPath,
        destPath,
        relPath,
        targetDir,
        context.protectedPaths,
      );
    }
  }
  return count;
}

function projectDeployRootsForPlatform(platformId) {
  const roots = [];
  const add = (srcRel, destRel = srcRel) => roots.push({ srcRel, destRel });
  if (platformId === "claude" || platformId === "all") {
    add("CLAUDE.md");
  }
  if (
    platformId === "openclaw" ||
    platformId === "codex" ||
    platformId === "cursor" ||
    platformId === "all"
  ) {
    add("AGENTS.md");
  }

  // Replace whole-directory roots (.claude/.codex/.cursor/openclaw) with
  // explicit subpath roots so deploy only touches known runtime projection
  // surfaces and never recurses through unrelated local state.
  if (platformId === "claude" || platformId === "all") {
    add("canonical/agents", ".claude/agents");
    add("canonical/skills/meta-theory", ".claude/skills/meta-theory");
    add("config/capability-index", ".claude/capability-index");
    add("canonical/runtime-assets/claude/commands", ".claude/commands");
    add("canonical/runtime-assets/claude/settings.json", ".claude/settings.json");
    add("canonical/runtime-assets/claude/mcp.json", ".mcp.json");
  }
  if (platformId === "openclaw" || platformId === "all") {
    add("canonical/skills/meta-theory", "openclaw/skills/meta-theory");
    add("config/capability-index", "openclaw/capability-index");
    add(
      "canonical/runtime-assets/openclaw/openclaw.template.json",
      "openclaw/openclaw.template.json",
    );
  }
  if (platformId === "codex" || platformId === "all") {
    add("canonical/skills/meta-theory", ".agents/skills/meta-theory");
    add("config/capability-index", ".codex/capability-index");
    add("canonical/runtime-assets/codex/commands", ".codex/commands");
    add("canonical/runtime-assets/codex/hooks.json", ".codex/hooks.json");
    add(".codex/config.toml");
  }
  if (platformId === "cursor" || platformId === "all") {
    add("canonical/agents", ".cursor/agents");
    add("canonical/skills/meta-theory", ".cursor/skills/meta-theory");
    add("config/capability-index", ".cursor/capability-index");
    add("canonical/runtime-assets/cursor/rules", ".cursor/rules");
    add("canonical/runtime-assets/cursor/hooks.json", ".cursor/hooks.json");
    add("canonical/runtime-assets/claude/mcp.json", ".cursor/mcp.json");
  }
  return roots;
}

function collectDeployFilePlansFromRoot(srcRoot, destRoot, context = {}) {
  if (!existsSync(srcRoot)) return [];
  const sourceRoot = context.sourceRoot || srcRoot;
  const targetDir = context.targetDir || destRoot;
  const plans = [];
  if (!statSync(srcRoot).isDirectory()) {
    const relPath = normalizeDeployRelPath(
      context.destRelBase || relative(sourceRoot, srcRoot),
    );
    const destPath = join(targetDir, relPath);
    plans.push(projectDeployFilePlan(srcRoot, destPath, relPath, targetDir, context));
    return plans;
  }
  for (const entry of readdirSync(srcRoot, { withFileTypes: true })) {
    const srcPath = join(srcRoot, entry.name);
    const sourceRel = normalizeDeployRelPath(relative(sourceRoot, srcPath));
    const relPath = normalizeDeployRelPath(
      context.destRelBase ? join(context.destRelBase, sourceRel) : sourceRel,
    );
    const destPath = join(targetDir, relPath);
    if (entry.isDirectory()) {
      plans.push(
        ...collectDeployFilePlansFromRoot(srcPath, destPath, {
          sourceRoot,
          targetDir,
          managedRelPaths: context.managedRelPaths,
          managedFileMap: context.managedFileMap,
          destRelBase: context.destRelBase,
          protectedPaths: context.protectedPaths,
        }),
      );
    } else {
      plans.push(projectDeployFilePlan(srcPath, destPath, relPath, targetDir, context));
    }
  }
  return plans;
}

function projectDeployFilePlan(srcPath, destPath, relPath, targetDir, context = {}) {
  const rel = normalizeDeployRelPath(relPath);
  const protectedProjectCapability = isProtectedProjectCapabilityPath(
    destPath,
    context.protectedPaths,
  );
  const skipped = shouldSkipProjectDeployPath(rel) || protectedProjectCapability;
  const protectedJson = DEPLOY_PROTECTED_JSON_PATHS.has(rel);
  const protectedText = DEPLOY_PROTECTED_TEXT_PATHS.has(rel);
  const safeTarget = projectPlanningPathInfo(targetDir, rel);
  if (!safeTarget) {
    return {
      relPath: rel,
      source: normalizeDeployRelPath(relative(PROJECT_DIR, srcPath)),
      exists: true,
      contentStatus: "unsafe",
      ownership: "unsafe_path",
      action: "conflict",
      effectiveAction: "conflict",
      mergePolicy: "unsafe_realpath_or_link_preserved",
      skipReason: null,
      conflictReason: "unsafe_realpath_or_link_preserved",
    };
  }
  const exists = existsSync(safeTarget.target);
  const plannedContent = protectedJson
    ? `${JSON.stringify(plannedProtectedProjectDeployJson(srcPath, safeTarget.target, rel, targetDir), null, 2)}\n`
    : protectedText
      ? plannedProtectedProjectDeployText(srcPath, safeTarget.target, rel, targetDir)
      : readFileSync(srcPath);
  const sourceHash = createHash("sha256").update(plannedContent).digest("hex");
  const currentHash = exists ? projectFileHash(safeTarget.target) : null;
  const previousEntry = context.managedFileMap?.get(rel) ?? null;
  const classification = classifyProjectProjectionUpdate({
    exists,
    currentHash,
    sourceHash,
    previousManifestEntry: previousEntry,
    protectedProjectCapability,
    mergeOwnedConfig: protectedJson || protectedText,
    managedProjectionUpdate:
      existingProjectProjectionUpdatePolicy().managedProjectionUpdate,
  });
  const contentStatus = skipped
    ? "skip"
    : classification.action === "unchanged"
      ? "same"
      : "different";
  const mergePolicy = skipped
    ? "never_touch"
    : protectedJson
      ? "additive_preserve_user_state_json"
      : protectedText
        ? "managed_block_preserve_user_text"
        : classification.action === "conflict"
          ? "user_owned_existing_file_conflict"
          : classification.action === "replace"
            ? "manifest_managed_projection_replace"
            : "generated_projection_create";
  return {
    relPath: rel,
    source: normalizeDeployRelPath(relative(PROJECT_DIR, srcPath)),
    [PROJECT_PLAN_CONTENT]: plannedContent,
    exists,
    contentStatus,
    ownership: skipped && !protectedProjectCapability ? "local_state" : classification.ownership,
    action: skipped
      ? "skip"
      : protectedText
        ? "merge"
        : exists && protectedJson
        ? "merge"
      : classification.action,
    effectiveAction:
      skipped || contentStatus === "same"
        ? "unchanged"
        : protectedText
          ? "merge"
          : exists && protectedJson
          ? "merge"
          : classification.action,
    mergePolicy: protectedProjectCapability ? "preserve_project_copy" : mergePolicy,
    skipReason: protectedProjectCapability
      ? "protected_project_capability"
      : skipped
        ? "local_state_or_runtime_config"
        : null,
    conflictReason: classification.action === "conflict" ? classification.reason : null,
    oldInstalledHash: classification.oldInstalledHash ?? null,
    currentHash,
    sourceHash,
  };
}

function projectGeneratedFilePlan(relPath, content, targetDir, source, protectedPaths) {
  const rel = normalizeDeployRelPath(relPath);
  const destPath = join(targetDir, rel);
  const protectedProjectCapability = isProtectedProjectCapabilityPath(
    destPath,
    protectedPaths,
  );
  const safeTarget = projectPlanningPathInfo(targetDir, rel);
  if (!safeTarget) {
    return { relPath: rel, source, content, exists: true, contentStatus: "unsafe", ownership: "unsafe_path", action: "conflict", effectiveAction: "conflict", mergePolicy: "unsafe_realpath_or_link_preserved", skipReason: null, conflictReason: "unsafe_realpath_or_link_preserved" };
  }
  const exists = existsSync(safeTarget.target);
  const currentHash = exists ? projectFileHash(safeTarget.target) : null;
  const sourceHash = createHash("sha256").update(content).digest("hex");
  const previousEntry = previousProjectManagedFileMap(targetDir).get(rel) ?? null;
  const classification = classifyProjectProjectionUpdate({
    exists,
    currentHash,
    sourceHash,
    previousManifestEntry: previousEntry,
    protectedProjectCapability,
    managedProjectionUpdate:
      existingProjectProjectionUpdatePolicy().managedProjectionUpdate,
  });
  const contentStatus = classification.action === "unchanged" ? "same" : exists ? "different" : "missing";
  return {
    relPath: rel,
    source,
    [PROJECT_PLAN_CONTENT]: content,
    exists,
    contentStatus,
    ownership: classification.ownership,
    action: protectedProjectCapability
      ? "skip"
      : classification.action,
    effectiveAction: protectedProjectCapability
      ? "unchanged"
      : contentStatus === "same"
      ? "unchanged"
      : classification.action,
    mergePolicy: protectedProjectCapability
      ? "preserve_project_copy"
      : classification.action === "replace"
        ? "manifest_managed_projection_replace"
        : classification.action === "conflict"
          ? "user_owned_existing_file_conflict"
          : "generated_projection_create",
    skipReason: protectedProjectCapability ? "protected_project_capability" : null,
    conflictReason: classification.action === "conflict" ? classification.reason : null,
    oldInstalledHash: classification.oldInstalledHash ?? null,
    currentHash,
    sourceHash,
  };
}

function projectDeployFileContentStatus(
  srcPath,
  destPath,
  relPath,
  { skipped, protectedJson, protectedText, targetDir },
) {
  if (skipped) return "skip";
  if (!existsSync(destPath)) return "missing";
  if (protectedJson) {
    const current = readJsonObjectIfExists(destPath);
    const planned = plannedProtectedProjectDeployJson(srcPath, destPath, relPath, targetDir);
    return jsonEquivalent(current, planned) ? "same" : "different";
  }
  if (protectedText) {
    const current = readFileSync(destPath, "utf8");
    const planned = plannedProtectedProjectDeployText(srcPath, destPath, relPath, targetDir);
    return current === planned ? "same" : "different";
  }
  return readFileSync(srcPath).equals(readFileSync(destPath)) ? "same" : "different";
}

function collectProjectDeployPlan(activeTargets, targetDir) {
  const plans = [];
  const seen = new Set();
  const managedRelPaths = previousProjectManagedRelPaths(targetDir);
  const managedFileMap = previousProjectManagedFileMap(targetDir);
  const protectedPaths = loadProtectedProjectCapabilityPaths(targetDir, PROJECT_DIR);
  for (const platformId of activeTargets) {
    for (const root of projectDeployRootsForPlatform(platformId)) {
      const src = join(PROJECT_DIR, root.srcRel);
      const dest = join(targetDir, root.destRel);
      for (const plan of collectDeployFilePlansFromRoot(src, dest, {
        sourceRoot: root.destRel !== root.srcRel ? src : PROJECT_DIR,
        targetDir,
        managedRelPaths,
        managedFileMap,
        destRelBase: root.destRel !== root.srcRel ? root.destRel : null,
        protectedPaths,
      })) {
        if (seen.has(plan.relPath)) continue;
        seen.add(plan.relPath);
        plans.push(plan);
      }
    }
    for (const plan of projectHookGeneratedPlans(platformId, targetDir, protectedPaths)) {
      if (seen.has(plan.relPath)) continue;
      seen.add(plan.relPath);
      plans.push(plan);
    }
  }
  return plans.sort((left, right) => left.relPath.localeCompare(right.relPath));
}

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(join(PROJECT_DIR, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function readSyncSourceChain() {
  const syncPath = join(PROJECT_DIR, "config", "sync.json");
  let sync = {};
  try {
    sync = JSON.parse(readFileSync(syncPath, "utf8"));
  } catch {
    sync = {};
  }
  return {
    packageRoot: PROJECT_DIR,
    binEntrypoint: "bin/meta-kim.mjs",
    setupEntrypoint: "setup.mjs --project-bootstrap",
    syncManifest: "config/sync.json",
    canonicalRoots: sync.canonicalRoots ?? {},
    generatedTargets: sync.generatedTargets ?? {},
    projectProjectionSource:
      "Generated runtime mirrors are read from the installed Meta_Kim package root after canonical sync.",
  };
}

function projectBootstrapManifestPath(targetDir) {
  const marker = existingProjectProjectionUpdatePolicy().managedStateMarker;
  return join(targetDir, ...marker.split("/"));
}

function missingProjectTargetHasNoLinkedAncestor(targetDir) {
  let current = resolve(targetDir);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  while (true) {
    const stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function projectPlanningPathInfo(targetDir, relPath) {
  if (existsSync(targetDir)) {
    return safeProjectPathInfo(targetDir, relPath, { allowMissing: true });
  }
  if (!missingProjectTargetHasNoLinkedAncestor(targetDir)) return null;
  const rel = normalizeDeployRelPath(relPath);
  if (!rel || rel.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return {
    root: resolve(targetDir),
    rel,
    target: join(resolve(targetDir), ...rel.split("/")),
    missingAt: resolve(targetDir),
  };
}

function existingProjectProjectionUpdatePolicy() {
  const policy =
    metaKimConfig.syncConfig?.projectMaterializationPolicy
      ?.existingProjectProjectionUpdate;
  const validDiscovery = new Set([
    "explicit_project_dirs",
    "saved_project_dirs",
    "current_working_directory",
  ]);
  if (
    !policy ||
    !Array.isArray(policy.discoveryOrder) ||
    policy.discoveryOrder.length === 0 ||
    policy.discoveryOrder.some((item) => !validDiscovery.has(item)) ||
    typeof policy.managedStateMarker !== "string" ||
    !policy.managedStateMarker ||
    policy.globalDistributionAction !== "update_existing_project_projection" ||
    policy.projectUpdateStrategy !== "project_bootstrap_merge_delta" ||
    policy.managedProjectionUpdate !== "replace_with_transaction_backup" ||
    policy.noManagedProjectAction !== "do_not_materialize_project_projection" ||
    policy.cleanupMode !== "explicit_only"
  ) {
    throw new Error("Invalid existing project projection update policy in config/sync.json");
  }
  return policy;
}

function readProjectBootstrapManifest(targetDir) {
  const marker = existingProjectProjectionUpdatePolicy().managedStateMarker;
  if (!existsSync(targetDir)) return null;
  const info = safeProjectPathInfo(targetDir, marker, { allowMissing: true });
  if (!info) throw new Error("Unsafe project bootstrap manifest path");
  if (!existsSync(info.target)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(info.target, "utf8"));
  } catch {
    return null;
  }
  return parsed;
}

function previousProjectManagedRelPaths(targetDir) {
  const manifest = readProjectBootstrapManifest(targetDir);
  const managedFiles = Array.isArray(manifest?.managedFiles) ? manifest.managedFiles : [];
  return new Set(
    managedFiles
      .map((file) => normalizeDeployRelPath(file?.relPath ?? ""))
      .filter(Boolean),
  );
}

function previousProjectManagedFileMap(targetDir) {
  const manifest = readProjectBootstrapManifest(targetDir);
  const managedFiles = Array.isArray(manifest?.managedFiles) ? manifest.managedFiles : [];
  const result = new Map();
  for (const file of managedFiles) {
    const relPath = normalizeDeployRelPath(file?.relPath ?? "");
    if (!relPath) continue;
    result.set(relPath, file);
  }
  return result;
}

function projectRemovalProof(targetDir, relPath) {
  const rel = normalizeDeployRelPath(relPath);
  const manifestEntry = previousProjectManagedFileMap(targetDir).get(rel);
  return projectRemovalProofForManifestEntry(targetDir, rel, manifestEntry);
}

function projectRemovalUnprovenReason(targetDir, relPath, fallback) {
  const rel = normalizeDeployRelPath(relPath);
  const manifestEntry = previousProjectManagedFileMap(targetDir).get(rel);
  return projectRemovalUnprovenReasonForManifestEntry(manifestEntry, fallback);
}

function isProjectLocalCapabilityAsset(relPath) {
  const rel = normalizeDeployRelPath(relPath);
  if (!rel || PROJECT_BOOTSTRAP_MERGED_CONFIG_PATHS.has(rel)) return false;
  return PROJECT_LOCAL_CAPABILITY_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function projectInstructionRelPathsForTargets(activeTargets) {
  const targets = activeTargets.includes("all")
    ? RUNTIME_CHOICES.map(({ id }) => id)
    : activeTargets;
  const rels = new Set();
  if (targets.includes("claude")) rels.add("CLAUDE.md");
  if (
    targets.includes("codex") ||
    targets.includes("cursor") ||
    targets.includes("openclaw")
  ) {
    rels.add("AGENTS.md");
  }
  return [...rels];
}

function isRedundantProjectInstructionFile(targetDir, relPath) {
  const rel = normalizeDeployRelPath(relPath);
  const targetPath = join(targetDir, rel);
  const sourcePath = join(PROJECT_DIR, rel);
  if (!safeProjectPathInfo(targetDir, rel) || !existsSync(sourcePath)) return false;
  const stats = statSync(targetPath);
  if (!stats.isFile()) return false;
  const current = readFileSync(targetPath, "utf8");
  const generated = rewriteProjectDirRefs(readFileSync(sourcePath, "utf8"), targetDir);
  const userText = stripManagedTextBlock(current, rel);
  return (
    equivalentText(current, generated) ||
    equivalentText(userText, "") ||
    equivalentText(userText, generated)
  );
}

function removeRedundantProjectInstructionFiles(targetDir, activeTargets) {
  const removed = [];
  const skipped = [];
  const backups = [];
  const root = resolve(targetDir);
  for (const relPath of projectInstructionRelPathsForTargets(activeTargets)) {
    const rel = normalizeDeployRelPath(relPath);
    const absPath = resolve(targetDir, rel);
    if (!isPathInsideDir(absPath, root)) {
      skipped.push({ relPath: rel, reason: "outside_target_dir" });
      continue;
    }
    if (!isRedundantProjectInstructionFile(targetDir, rel)) continue;
    if (!removeUntrackedProjectPath(targetDir, rel, skipped, {
      recursive: false,
      backup: true,
      backups,
    })) {
      continue;
    }
    removed.push(rel);
    pruneEmptyProjectDirs(targetDir, rel);
  }
  return { removed, skipped, backups };
}

function isGitTrackedProjectPath(targetDir, relPath) {
  if (!existsSync(join(targetDir, ".git"))) return false;
  const rel = normalizeDeployRelPath(relPath);
  const probe = spawnSync("git", ["-C", targetDir, "ls-files", "--", rel], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.status !== 0) return false;
  return probe.stdout.trim().length > 0;
}

function removeUntrackedProjectPath(targetDir, relPath, skipped, options = {}) {
  const rel = normalizeDeployRelPath(relPath);
  const root = resolve(targetDir);
  const absPath = resolve(targetDir, rel);
  const protectedPaths = loadProtectedProjectCapabilityPaths(targetDir, PROJECT_DIR);
  if (protectedProjectCapabilityIntersects(rel, protectedPaths)) {
    skipped.push({ relPath: rel, reason: "protected_project_capability_preserved" });
    return false;
  }
  const safePath = safeProjectPathInfo(targetDir, rel);
  if (!safePath) {
    skipped.push({ relPath: rel, reason: "unsafe_realpath_or_link_preserved" });
    return false;
  }
  if (!existsSync(absPath)) return false;
  if (isGitTrackedProjectPath(targetDir, rel)) {
    skipped.push({ relPath: rel, reason: "git_tracked_preserved" });
    return false;
  }
  const backup = backupProjectPathBeforeRemoval(targetDir, rel);
  if (!backup) {
    skipped.push({ relPath: rel, reason: "backup_failed_preserved" });
    return false;
  }
  if (Array.isArray(options.backups)) {
    options.backups.push({ relPath: rel, ...backup });
  }
  if (!safeProjectPathInfo(targetDir, rel)) {
    skipped.push({ relPath: rel, reason: "unsafe_realpath_changed_preserved" });
    return false;
  }
  rmSync(absPath, { recursive: options.recursive !== false, force: true });
  return true;
}

function backupProjectPathBeforeRemoval(targetDir, relPath) {
  const rel = normalizeDeployRelPath(relPath);
  const source = resolve(targetDir, rel);
  if (!safeProjectPathInfo(targetDir, rel)) return null;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupRoot = join(
      targetDir,
      ".meta-kim",
      "backups",
      "project-cleanup",
      stamp,
    );
    const destination = join(backupRoot, rel);
    if (!ensureSafeProjectDirectory(targetDir, dirname(destination))) return null;
    cpSync(source, destination, { recursive: true });
    const sourceHash = projectPathDigest(targetDir, rel);
    const backupRelPath = normalizeDeployRelPath(relative(targetDir, destination));
    const backupHash = projectPathDigest(targetDir, backupRelPath);
    if (!sourceHash || sourceHash !== backupHash) {
      rmSync(destination, { recursive: true, force: true });
      return null;
    }
    return { backupRelPath, sourceHash, backupHash };
  } catch {
    return null;
  }
}

function writeProjectFileWithVerifiedBackup(targetDir, relPath, content, backups = null) {
  const rel = normalizeDeployRelPath(relPath);
  const safePath = safeProjectPathInfo(targetDir, rel);
  if (!safePath || !lstatSync(safePath.target).isFile()) return false;
  const backup = backupProjectPathBeforeRemoval(targetDir, rel);
  if (!backup) return false;
  const tempPath = join(dirname(safePath.target), `.${Date.now()}-${process.pid}.meta-kim.tmp`);
  try {
    writeFileSync(tempPath, content);
    if (!safeProjectPathInfo(targetDir, normalizeDeployRelPath(relative(targetDir, tempPath)))) {
      unlinkSync(tempPath);
      return false;
    }
    renameSync(tempPath, safePath.target);
    if (Array.isArray(backups)) backups.push({ relPath: rel, ...backup });
    return true;
  } catch {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    return false;
  }
}

function pruneEmptyProjectDirs(targetDir, relPath, removedDirs = null) {
  let currentDir = dirname(join(targetDir, normalizeDeployRelPath(relPath)));
  const root = resolve(targetDir);
  while (currentDir !== root && isPathInsideDir(currentDir, root)) {
    const currentRel = normalizeDeployRelPath(relative(targetDir, currentDir));
    if (!safeProjectPathInfo(targetDir, currentRel)) return;
    let entries = [];
    try {
      entries = readdirSync(currentDir);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (entries.length > 0) return;
    const removedRel = normalizeDeployRelPath(relative(targetDir, currentDir));
    rmSync(currentDir, { recursive: true, force: true });
    if (Array.isArray(removedDirs) && removedRel) {
      removedDirs.push(removedRel);
    }
    currentDir = dirname(currentDir);
  }
}

function removeStaleManagedProjectAssets(
  targetDir,
  currentFilePlans,
  options = {},
) {
  const removeCurrentManaged = options.removeCurrentManaged === true;
  const preserveRelPaths = new Set(
    (options.preserveRelPaths ?? [])
      .map((relPath) => normalizeDeployRelPath(relPath))
      .filter(Boolean),
  );
  const protectedPaths = loadProtectedProjectCapabilityPaths(targetDir, PROJECT_DIR);
  for (const relPath of protectedPaths.relativePaths) preserveRelPaths.add(relPath);
  const currentRelPaths = new Set(
    currentFilePlans.map((file) => normalizeDeployRelPath(file.relPath)).filter(Boolean),
  );
  const previousRelPaths = previousProjectManagedRelPaths(targetDir);
  const removed = [];
  const skipped = [];
  const backups = [];
  const root = resolve(targetDir);

  // cleanupProjectRedundancyDirs (removeCurrentManaged) must delete every
  // capability asset the current plan would install — including cursor/openclaw
  // roots that are absent from the historical manifest (which only recorded the
  // bootstrap-time activeTargets, e.g. [claude,codex]). Without unioning
  // currentRelPaths, those runtimes' project-level agents/skills/workspaces are
  // never cleaned and the global-single-source intent silently leaks.
  const cleanupSources = removeCurrentManaged
    ? Array.from(new Set([...previousRelPaths, ...currentRelPaths]))
    : Array.from(previousRelPaths);
  for (const relPath of cleanupSources) {
    if (
      preserveRelPaths.has(relPath) ||
      protectedProjectCapabilityIntersects(relPath, protectedPaths)
    ) continue;
    if (!removeCurrentManaged && currentRelPaths.has(relPath)) continue;
    if (!isProjectLocalCapabilityAsset(relPath)) continue;
    const absPath = resolve(targetDir, relPath);
    if (!isPathInsideDir(absPath, root)) {
      skipped.push({ relPath, reason: "outside_target_dir" });
      continue;
    }
    if (!existsSync(absPath)) continue;
    const stats = statSync(absPath);
    if (!stats.isFile()) {
      skipped.push({ relPath, reason: "not_a_file" });
      continue;
    }
    const proof = projectRemovalProof(targetDir, relPath);
    if (!proof) {
      skipped.push({
        relPath,
        reason: projectRemovalUnprovenReason(
          targetDir,
          relPath,
          "ownership_or_hash_unproven_preserved",
        ),
      });
      continue;
    }
    if (!removeUntrackedProjectPath(targetDir, relPath, skipped, {
      recursive: false,
      backup: true,
      backups,
    })) {
      continue;
    }
    removed.push(relPath);
    pruneEmptyProjectDirs(targetDir, relPath);
  }

  return { removed, skipped, backups };
}

const LEGACY_PROJECT_CAPABILITY_RELS_BY_PLATFORM = {
  claude: [
    ".claude/skills/meta-theory.md",
    ".claude/skills/references",
  ],
  codex: [
    ".codex/skills/meta-theory.md",
    ".codex/skills/references",
    ".codex/skills/meta-theory",
  ],
  cursor: [
    ".cursor/skills/meta-theory.md",
    ".cursor/skills/references",
  ],
  openclaw: [
    "openclaw/skills/meta-theory.md",
    "openclaw/skills/references",
  ],
};

function legacyProjectCapabilityRelPaths(activeTargets) {
  const targets = activeTargets.includes("all")
    ? Object.keys(LEGACY_PROJECT_CAPABILITY_RELS_BY_PLATFORM)
    : activeTargets;
  return [
    ...new Set(
      targets.flatMap(
        (target) => LEGACY_PROJECT_CAPABILITY_RELS_BY_PLATFORM[target] ?? [],
      ),
    ),
  ];
}

function removeLegacyProjectCapabilityEntrypoints(targetDir, activeTargets) {
  const removed = [];
  const skipped = [];
  const backups = [];
  const root = resolve(targetDir);

  for (const relPath of legacyProjectCapabilityRelPaths(activeTargets)) {
    const rel = normalizeDeployRelPath(relPath);
    const absPath = resolve(targetDir, rel);
    if (!isPathInsideDir(absPath, root)) {
      skipped.push({ relPath: rel, reason: "outside_target_dir" });
      continue;
    }
    if (!existsSync(absPath)) continue;
    const proof = projectRemovalProof(targetDir, rel);
    if (!proof) {
      skipped.push({
        relPath: rel,
        reason: projectRemovalUnprovenReason(
          targetDir,
          rel,
          "legacy_ownership_unproven_preserved",
        ),
      });
      continue;
    }
    if (!removeUntrackedProjectPath(targetDir, rel, skipped, {
      backup: true,
      backups,
    })) continue;
    removed.push(rel);
    pruneEmptyProjectDirs(targetDir, rel);
  }

  return { removed, skipped, backups };
}

const GLOBAL_CLEANUP_PROJECT_CAPABILITY_ROOTS_BY_PLATFORM = {
  claude: [
    ".claude/skills/meta-theory",
  ],
  codex: [
    ".agents/skills/meta-theory",
  ],
  cursor: [
    ".cursor/skills/meta-theory",
  ],
  openclaw: [
    "openclaw/skills/meta-theory",
  ],
};

function globalCleanupProjectCapabilityRoots(activeTargets) {
  const targets = activeTargets.includes("all")
    ? Object.keys(GLOBAL_CLEANUP_PROJECT_CAPABILITY_ROOTS_BY_PLATFORM)
    : activeTargets;
  return [
    ...new Set(
      targets.flatMap(
        (target) => GLOBAL_CLEANUP_PROJECT_CAPABILITY_ROOTS_BY_PLATFORM[target] ?? [],
      ),
    ),
  ];
}

function removeGlobalProjectCapabilityRoots(targetDir, activeTargets) {
  const removed = [];
  const skipped = [];
  const root = resolve(targetDir);

  for (const relPath of globalCleanupProjectCapabilityRoots(activeTargets)) {
    const rel = normalizeDeployRelPath(relPath);
    const absPath = resolve(targetDir, rel);
    if (!isPathInsideDir(absPath, root)) {
      skipped.push({ relPath: rel, reason: "outside_target_dir" });
      continue;
    }
    if (!existsSync(absPath)) continue;
    const entries = statSync(absPath).isDirectory() ? readdirSync(absPath) : [rel];
    if (entries.length > 0) {
      const hasManagedChildren = [...previousProjectManagedRelPaths(targetDir)].some(
        (managedRel) => managedRel === rel || managedRel.startsWith(`${rel}/`),
      );
      if (!hasManagedChildren) {
        skipped.push({ relPath: rel, reason: "unproven_same_name_content_preserved" });
      }
      continue;
    }
    if (!removeUntrackedProjectPath(targetDir, rel, skipped)) continue;
    removed.push(rel);
    pruneEmptyProjectDirs(targetDir, rel);
  }

  return { removed, skipped };
}

function expandedCleanupTargets(activeTargets) {
  return activeTargets.includes("all")
    ? RUNTIME_CHOICES.map(({ id }) => id)
    : activeTargets;
}

function targetValuesForPlatforms(map, activeTargets) {
  return [
    ...new Set(
      expandedCleanupTargets(activeTargets).flatMap((target) => map[target] ?? []),
    ),
  ];
}

function readTextIfFile(filePath) {
  if (!existsSync(filePath)) return "";
  const stats = statSync(filePath);
  if (!stats.isFile()) return "";
  return readFileSync(filePath, "utf8");
}

function isMetaKimGeneratedSkillDirectory(dirPath) {
  const skillPath = join(dirPath, "SKILL.md");
  const raw = readTextIfFile(skillPath);
  if (!raw.trim()) return false;
  const markerRe =
    /\b(author:\s*Meta_Kim|sourceGapId:\s*gap-|approvalEvidence:\s*warden-approved|Reusable Meta_Kim|Meta_Kim executable governance dispatcher)\b/u;
  return markerRe.test(raw);
}

function projectDirectoryRemovalProof(targetDir, relPath) {
  const rel = normalizeDeployRelPath(relPath);
  const safePath = safeProjectPathInfo(targetDir, rel);
  if (!safePath || !lstatSync(safePath.target).isDirectory()) return null;
  const absPath = safePath.target;
  const manifestRelPaths = [...previousProjectManagedRelPaths(targetDir)].filter(
    (managedRel) => managedRel === rel || managedRel.startsWith(`${rel}/`),
  );
  const currentFiles = [];
  const visit = (dirPath) => {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = join(dirPath, entry.name);
      const entryRel = normalizeDeployRelPath(relative(targetDir, entryPath));
      if (entry.isSymbolicLink() || !safeProjectPathInfo(targetDir, entryRel)) {
        currentFiles.push(null);
      } else if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile()) {
        currentFiles.push(entryRel);
      } else currentFiles.push(null);
    }
  };
  visit(absPath);
  if (manifestRelPaths.length === 0) return null;
  if (currentFiles.some((fileRel) => !fileRel || !projectRemovalProof(targetDir, fileRel))) return null;
  return {
    source: "manifest_directory",
    managedFileCount: manifestRelPaths.length,
    currentFileCount: currentFiles.length,
  };
}

function removeMetaKimGeneratedProjectSkillResidue(targetDir, activeTargets) {
  const removed = [];
  const skipped = [];
  const backups = [];
  const root = resolve(targetDir);
  for (const relRoot of targetValuesForPlatforms(PROJECT_SKILL_ROOTS_BY_PLATFORM, activeTargets)) {
    const absRoot = resolve(targetDir, relRoot);
    if (!safeProjectPathInfo(targetDir, relRoot)) {
      if (existsSync(absRoot)) skipped.push({ relPath: normalizeDeployRelPath(relRoot), reason: "unsafe_realpath_or_link_preserved" });
      continue;
    }
    if (!existsSync(absRoot)) continue;
    for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absPath = join(absRoot, entry.name);
      const relPath = normalizeDeployRelPath(relative(targetDir, absPath));
      if (!isMetaKimGeneratedSkillDirectory(absPath)) continue;
      if (isGitTrackedProjectPath(targetDir, relPath)) {
        skipped.push({ relPath, reason: "git_tracked_preserved" });
        continue;
      }
      if (!projectDirectoryRemovalProof(targetDir, relPath)) {
        skipped.push({
          relPath,
          reason: "signature_only_ownership_unproven_preserved",
        });
        continue;
      }
      if (!removeUntrackedProjectPath(targetDir, relPath, skipped, {
        backup: true,
        backups,
      })) continue;
      removed.push(relPath);
      pruneEmptyProjectDirs(targetDir, relPath);
    }
  }
  return { removed, skipped, backups };
}

function directoryContainsFiles(dirPath) {
  if (!existsSync(dirPath)) return false;
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && directoryContainsFiles(entryPath)) return true;
  }
  return false;
}

function isMetaKimOpenClawHookDirectory(dirPath) {
  const hookDoc = readTextIfFile(join(dirPath, "HOOK.md"));
  return hookDoc.includes("Meta_Kim") || hookDoc.includes("mcp-memory-service");
}

function removeMetaKimOpenClawDirectoryResidue(targetDir, activeTargets) {
  const removed = [];
  const skipped = [];
  const backups = [];
  if (!expandedCleanupTargets(activeTargets).includes("openclaw")) {
    return { removed, skipped };
  }
  const root = resolve(targetDir);
  const hookRoot = resolve(targetDir, "openclaw/hooks");
  if (safeProjectPathInfo(targetDir, "openclaw/hooks") && existsSync(hookRoot)) {
    for (const entry of readdirSync(hookRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absPath = join(hookRoot, entry.name);
      const relPath = normalizeDeployRelPath(relative(targetDir, absPath));
      if (!isMetaKimOpenClawHookDirectory(absPath)) continue;
      if (isGitTrackedProjectPath(targetDir, relPath)) {
        skipped.push({ relPath, reason: "git_tracked_preserved" });
        continue;
      }
      if (!projectDirectoryRemovalProof(targetDir, relPath)) {
        skipped.push({
          relPath,
          reason: "signature_only_ownership_unproven_preserved",
        });
        continue;
      }
      if (!removeUntrackedProjectPath(targetDir, relPath, skipped, {
        backup: true,
        backups,
      })) continue;
      removed.push(relPath);
      pruneEmptyProjectDirs(targetDir, relPath);
    }
  } else if (existsSync(hookRoot)) {
    skipped.push({ relPath: "openclaw/hooks", reason: "unsafe_realpath_or_link_preserved" });
  }

  const workspaceRoot = resolve(targetDir, "openclaw/workspaces");
  if (safeProjectPathInfo(targetDir, "openclaw/workspaces") && existsSync(workspaceRoot)) {
    for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("meta-")) continue;
      const absPath = join(workspaceRoot, entry.name);
      const relPath = normalizeDeployRelPath(relative(targetDir, absPath));
      if (directoryContainsFiles(absPath)) continue;
      if (!projectDirectoryRemovalProof(targetDir, relPath)) {
        skipped.push({ relPath, reason: "ownership_unproven_empty_dir_preserved" });
        continue;
      }
      if (!removeUntrackedProjectPath(targetDir, relPath, skipped)) continue;
      removed.push(relPath);
      pruneEmptyProjectDirs(targetDir, relPath);
    }
  } else if (existsSync(workspaceRoot)) {
    skipped.push({ relPath: "openclaw/workspaces", reason: "unsafe_realpath_or_link_preserved" });
  }

  return { removed, skipped, backups };
}

function stripMetaKimMcpServersFromConfig(config = {}) {
  const next = cloneJson(config && typeof config === "object" ? config : {});
  if (isPlainObject(next.mcpServers)) {
    for (const key of ["meta-kim-runtime", "mcp-memory-service"]) {
      delete next.mcpServers[key];
    }
  }
  if (isPlainObject(next.mcp?.servers)) {
    for (const key of ["meta-kim-runtime", "mcp-memory-service"]) {
      delete next.mcp.servers[key];
    }
  }
  return next;
}

function stripMetaKimOpenClawTemplate(config = {}) {
  const next = stripMetaKimMcpServersFromConfig(config);
  if (Array.isArray(next.agents?.list)) {
    next.agents.list = next.agents.list.filter(
      (agent) => !String(agent?.id ?? "").startsWith("meta-"),
    );
  }
  if (Array.isArray(next.tools?.agentToAgent?.allow)) {
    next.tools.agentToAgent.allow = next.tools.agentToAgent.allow.filter(
      (id) => !String(id ?? "").startsWith("meta-"),
    );
  }
  if (Array.isArray(next.skills?.load?.extraDirs)) {
    next.skills.load.extraDirs = next.skills.load.extraDirs.filter(
      (dir) => !String(dir ?? "").replace(/\\/g, "/").includes("/openclaw/skills"),
    );
  }
  return next;
}

function stripMetaKimProjectConfig(relPath, config = {}) {
  const rel = normalizeDeployRelPath(relPath);
  let next = cloneJson(config && typeof config === "object" ? config : {});
  if (rel.endsWith("hooks.json") || rel === ".claude/settings.json") {
    next = stripProjectMetaKimHooksFromHookConfig(next);
  }
  if (rel.endsWith("mcp.json") || rel === ".mcp.json") {
    next = stripMetaKimMcpServersFromConfig(next);
  }
  if (rel === "openclaw/openclaw.template.json") {
    next = stripMetaKimOpenClawTemplate(next);
  }
  return next;
}

function generatedProjectConfigVariantsForRel(targetDir, relPath, currentFilePlans = []) {
  const rel = normalizeDeployRelPath(relPath);
  const plan = currentFilePlans.find(
    (file) => normalizeDeployRelPath(file.relPath) === rel,
  );
  const sourcePath = join(PROJECT_DIR, plan?.source ?? rel);
  if (!existsSync(sourcePath)) return null;
  const raw = readFileSync(sourcePath, "utf8");
  const candidates = [raw, rewriteProjectDirRefs(raw, targetDir)];
  const variants = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    variants.push(parseJsonText(candidate, sourcePath));
  }
  return variants;
}

function isEmptyProjectConfigShell(config = {}) {
  if (!isPlainObject(config)) return false;
  return Object.entries(config).every(([key, value]) => {
    if (key === "version") return true;
    if (Array.isArray(value)) return value.length === 0;
    if (isPlainObject(value)) return Object.keys(value).length === 0;
    return value === null || value === "" || value === false;
  });
}

function isGeneratedOnlyProjectConfig(targetDir, relPath, config, currentFilePlans = []) {
  const rel = normalizeDeployRelPath(relPath);
  const previousFiles = previousProjectManagedFileMap(targetDir);
  const plan = currentFilePlans.find((file) => normalizeDeployRelPath(file.relPath) === rel);
  const hasMetaKimManagementEvidence =
    previousFiles.has(rel) ||
    plan?.ownership === "shared_config_merge" ||
    plan?.mergePolicy === "additive_preserve_user_state_json";
  if (!hasMetaKimManagementEvidence) return false;
  const generatedVariants = generatedProjectConfigVariantsForRel(
    targetDir,
    rel,
    currentFilePlans,
  );
  if (!generatedVariants) return false;
  return generatedVariants.some((generated) => {
    const strippedGenerated = stripMetaKimProjectConfig(rel, generated);
    return jsonEquivalent(config, generated) || jsonEquivalent(config, strippedGenerated);
  });
}

function cleanupRedundantProjectConfigs(
  targetDir,
  activeTargets,
  currentFilePlans = [],
  options = {},
) {
  const removed = [];
  const skipped = [];
  const backups = [];
  const root = resolve(targetDir);
  const preserveRelPaths = new Set(
    (options.preserveRelPaths ?? [])
      .map((relPath) => normalizeDeployRelPath(relPath))
      .filter(Boolean),
  );
  const relPaths = targetValuesForPlatforms(
    PROJECT_META_KIM_CONFIG_RELS_BY_PLATFORM,
    activeTargets,
  );
  for (const relPath of relPaths) {
    const rel = normalizeDeployRelPath(relPath);
    if (preserveRelPaths.has(rel)) continue;
    const absPath = resolve(targetDir, rel);
    if (!isPathInsideDir(absPath, root)) {
      skipped.push({ relPath: rel, reason: "outside_target_dir" });
      continue;
    }
    if (!existsSync(absPath)) continue;
    if (!safeProjectPathInfo(targetDir, rel)) {
      skipped.push({ relPath: rel, reason: "unsafe_realpath_or_link_preserved" });
      continue;
    }
    const current = readJsonObjectIfExists(absPath);
    if (!current) continue;
    const stripped = stripMetaKimProjectConfig(rel, current);
    const ownershipProof = projectRemovalProof(targetDir, rel);
    if (!ownershipProof) {
      skipped.push({
        relPath: rel,
        reason: projectRemovalUnprovenReason(targetDir, rel, "config_ownership_unproven_preserved"),
      });
      continue;
    }
    const shouldDelete =
      isEmptyProjectConfigShell(stripped) ||
      isGeneratedOnlyProjectConfig(targetDir, rel, stripped, currentFilePlans);
    if (shouldDelete) {
      if (!removeUntrackedProjectPath(targetDir, rel, skipped, { recursive: false, backups })) {
        continue;
      }
      removed.push(rel);
      pruneEmptyProjectDirs(targetDir, rel);
      continue;
    }
    if (!jsonEquivalent(current, stripped)) {
      if (isGitTrackedProjectPath(targetDir, rel)) {
        skipped.push({ relPath: rel, reason: "git_tracked_preserved" });
        continue;
      }
      if (!writeProjectFileWithVerifiedBackup(
        targetDir,
        rel,
        JSON.stringify(stripped, null, 2) + "\n",
        backups,
      )) {
        skipped.push({ relPath: rel, reason: "backup_or_atomic_write_failed_preserved" });
      }
    }
  }
  return { removed, skipped, backups };
}

function isMetaKimProjectTaskState(filePath) {
  const raw = readTextIfFile(filePath);
  return raw.includes("auto-save from Stop hook") && raw.includes("meta_kim");
}

function isValidatedProjectBootstrapManifest(targetDir) {
  const rel = ".meta-kim/state/default/project-bootstrap.json";
  if (!safeProjectPathInfo(targetDir, rel)) return false;
  const manifest = readProjectBootstrapManifest(targetDir);
  if (manifest?.schemaVersion !== "meta-kim-project-bootstrap-v0.1") return false;
  if (!Array.isArray(manifest.managedFiles) || manifest.managedFiles.length === 0) return false;
  return manifest.managedFiles.every((entry) =>
    typeof entry?.relPath === "string" && /^[a-f0-9]{64}$/iu.test(entry?.contentHash ?? ""),
  );
}

function removeMetaKimProjectLocalState(targetDir, options = {}) {
  const removed = [];
  const skipped = [];
  const backups = [];
  const root = resolve(targetDir);
  for (const relPath of PROJECT_META_KIM_LOCAL_STATE_RELS) {
    const rel = normalizeDeployRelPath(relPath);
    const absPath = resolve(targetDir, rel);
    if (!isPathInsideDir(absPath, root)) {
      skipped.push({ relPath: rel, reason: "outside_target_dir" });
      continue;
    }
    if (!existsSync(absPath)) continue;
    if (!safeProjectPathInfo(targetDir, rel)) {
      skipped.push({ relPath: rel, reason: "unsafe_realpath_or_link_preserved" });
      continue;
    }
    if (
      rel === ".meta-kim/state/default/project-bootstrap.json" &&
      options.preserveManifest === true
    ) {
      skipped.push({
        relPath: rel,
        reason: "retryable_cleanup_pending_manifest_preserved",
      });
      continue;
    }
    if (
      rel === ".claude/project-task-state.json" &&
      (!isMetaKimProjectTaskState(absPath) || !projectRemovalProof(targetDir, rel))
    ) {
      skipped.push({ relPath: rel, reason: "local_state_ownership_unproven_preserved" });
      continue;
    }
    if (
      rel === ".meta-kim/state/default/project-bootstrap.json" &&
      !isValidatedProjectBootstrapManifest(targetDir)
    ) {
      skipped.push({ relPath: rel, reason: "invalid_or_user_manifest_preserved" });
      continue;
    }
    if (
      rel === ".meta-kim/meta-kim-post-copy.mjs" &&
      !projectRemovalProof(targetDir, rel)
    ) {
      skipped.push({ relPath: rel, reason: "local_state_ownership_unproven_preserved" });
      continue;
    }
    if (!removeUntrackedProjectPath(targetDir, rel, skipped, { backups })) continue;
    removed.push(rel);
    pruneEmptyProjectDirs(targetDir, rel, removed);
  }
  return { removed, skipped, backups };
}

function pruneEmptyProjectRuntimeDirs(targetDir, activeTargets) {
  void targetDir;
  void activeTargets;
  return { removed: [], skipped: [] };
}

function stripStaleProjectHookConfigs(targetDir, currentFilePlans) {
  const currentRelPaths = new Set(
    currentFilePlans.map((file) => normalizeDeployRelPath(file.relPath)).filter(Boolean),
  );
  const previousFiles = previousProjectManagedFileMap(targetDir);
  const hookConfigPaths = new Set([
    ".claude/settings.json",
    ".codex/hooks.json",
    ".cursor/hooks.json",
  ]);
  const changed = [];

  for (const relPath of previousFiles.keys()) {
    if (currentRelPaths.has(relPath)) continue;
    if (!hookConfigPaths.has(relPath)) continue;
    const configPath = join(targetDir, relPath);
    if (!existsSync(configPath)) continue;
    const current = readJsonObjectIfExists(configPath);
    if (!current) continue;
    const stripped = stripProjectMetaKimHooksFromHookConfig(current);
    if (jsonEquivalent(current, stripped)) continue;
    if (isGitTrackedProjectPath(targetDir, relPath)) continue;
    const result = writeProjectManagedTransaction(
      targetDir,
      relPath,
      JSON.stringify(stripped, null, 2) + "\n",
      "pre-strip-hooks",
    );
    if (result.ok) changed.push(relPath);
  }

  return changed;
}

function reportProjectAssetCleanup(cleanup, options = {}) {
  if (jsonOutputMode || !cleanup) return;
  if (cleanup.removed.length > 0) {
    const isRetarget = options.reason === "project_retarget";
    const isGlobalRedundancy = options.reason === "global_redundancy";
    // Batch cleanup prints intro/scope once at the heading; per-project only
    // report what was removed to avoid N× repeated boilerplate across dirs.
    if (!isGlobalRedundancy) {
      info(
        isRetarget
          ? t.projectAssetsRetargetCleanupIntro
          : t.projectAssetsCleanupIntro,
      );
      info(
        isRetarget
          ? t.projectAssetsRetargetCleanupScope
          : t.projectAssetsCleanupScope,
      );
    }
    info(
      t.projectAssetsCleanupRemoved(
        cleanup.removed.length,
        summarizeProjectAssetCleanup(cleanup.removed),
      ),
    );
  } else if (options.reason === "global_redundancy") {
    info(t.projectAssetsCleanupAllClean ?? t.projectAssetsCleanupRemoved(0, []));
  }
  if (cleanup.skipped.length > 0) {
    info(t.projectAssetsCleanupSkipped(cleanup.skipped.length));
  }
}

function projectBootstrapStatus(targetDir, activeTargets, filePlans) {
  const existingManifest = readProjectBootstrapManifest(targetDir);
  const version = readPackageVersion();
  const actionable = filePlans.filter((plan) => plan.action !== "skip");
  const pending = actionable.filter((plan) => plan.effectiveAction !== "unchanged");
  const missingCount = pending.filter((plan) => !plan.exists).length;
  const createCount = pending.filter((plan) => plan.effectiveAction === "create").length;
  const mergeCount = pending.filter((plan) => plan.effectiveAction === "merge").length;
  const replaceCount = pending.filter((plan) => plan.effectiveAction === "replace").length;
  const conflictCount = pending.filter((plan) => plan.effectiveAction === "conflict").length;
  const targetChanged =
    Boolean(existingManifest) &&
    JSON.stringify(existingManifest.activeTargets ?? []) !== JSON.stringify(activeTargets);
  const versionChanged =
    Boolean(existingManifest) &&
    Boolean(existingManifest.metaKimVersion) &&
    existingManifest.metaKimVersion !== version;
  const status = conflictCount > 0
    ? "conflict"
    : versionChanged
    ? "stale"
    : targetChanged
      ? "target_scope_changed"
    : !existingManifest && missingCount > 0
      ? "missing"
      : existingManifest && (replaceCount > 0 || mergeCount > 0 || createCount > 0 || missingCount > 0)
        ? "repair_required"
        : replaceCount > 0 || mergeCount > 0 || createCount > 0
          ? "ready_with_existing_config"
        : existingManifest
          ? "ready"
          : "ready_with_existing_config";
  return {
    status,
    requiresConfirmation: status !== "ready",
    confirmationReason:
      t.projectBootstrapConfirmationReasons?.[status] ??
      t.projectBootstrapConfirmationReasons.ready_with_existing_config,
    metaKimVersion: version,
    targetDir,
    activeTargets,
    counts: {
      total: filePlans.length,
      create: createCount,
      merge: mergeCount,
      replace: replaceCount,
      conflict: conflictCount,
      skip: filePlans.filter((plan) => plan.action === "skip").length,
      missing: missingCount,
      unchanged: actionable.length - pending.length,
      pending: pending.length,
    },
    previousManifest: existingManifest
      ? {
          metaKimVersion: existingManifest.metaKimVersion ?? null,
          appliedAt: existingManifest.appliedAt ?? null,
          activeTargets: existingManifest.activeTargets ?? [],
          targetChanged,
        }
      : null,
  };
}

function projectBootstrapWritePreview(targetDir, filePlans, state) {
  const pending = filePlans.filter(
    (plan) => plan.action !== "skip" && plan.effectiveAction !== "unchanged",
  );
  const conflicts = pending.filter((plan) => plan.effectiveAction === "conflict");
  const writablePending = pending.filter((plan) => plan.effectiveAction !== "conflict");
  const existing = writablePending.filter((plan) => existsSync(join(targetDir, plan.relPath)));
  const projectWrites = filePlans
    .filter(
      (plan) =>
        plan.action !== "skip" &&
        plan.effectiveAction !== "unchanged" &&
        plan.effectiveAction !== "conflict",
    )
    .map((plan) => ({
      relPath: plan.relPath,
      action: plan.effectiveAction,
      plannedAction: plan.action,
      mergePolicy: plan.mergePolicy,
      ownership: plan.ownership,
      backupBeforeApply: plan.exists,
    }));
  return {
    globalWrites: [],
    projectWrites,
    projectConflicts: conflicts.map((plan) => ({
      relPath: plan.relPath,
      action: plan.effectiveAction,
      plannedAction: plan.action,
      mergePolicy: plan.mergePolicy,
      ownership: plan.ownership,
      safeNextAction:
        "Inspect the existing file, rename it, remove it, or mark it as managed only after user confirmation.",
    })),
    manifestWrite: {
      requiredBeforeReady: state.status !== "ready",
      reason: state.confirmationReason,
      stateManifest: ".meta-kim/state/default/project-bootstrap.json",
    },
    confirmation: {
      required: state.requiresConfirmation,
      reason: state.confirmationReason,
    },
    backup: {
      requiredBeforeApply: state.status !== "ready" && existing.length > 0,
      backupRootPattern: ".meta-kim/backups/project-bootstrap/<timestamp>",
      fileCount: existing.length,
      entries: existing.map((plan) => ({
        relPath: plan.relPath,
        mergePolicy: plan.mergePolicy,
      })),
    },
    rollbackPlan: {
      availableAfterApply: true,
      restoreFrom: ".meta-kim/backups/project-bootstrap/<timestamp>/backup-manifest.json",
      stateManifest: ".meta-kim/state/default/project-bootstrap.json",
      policy:
        "Restore backed-up files from backup-manifest.json; created-only generated files can be removed from managedFiles in the project bootstrap manifest.",
    },
  };
}

function projectBootstrapChoiceCopy() {
  return PROJECT_BOOTSTRAP_CHOICE_COPY[currentLangCode] ?? PROJECT_BOOTSTRAP_CHOICE_COPY.en;
}
function buildProjectBootstrapChoiceSurface(state, writePreview) {
  const copy = projectBootstrapChoiceCopy();
  if (!state.requiresConfirmation) {
    return {
      required: false,
      trigger: "no_choice_needed_current",
      header: copy.readyHeader,
      question: copy.readyQuestion,
      recommendedOptionId: "continue",
      options: [
        {
          id: "continue",
          label: copy.continueLabel,
          expectedResult: copy.continueExpected,
          advantage: copy.continueAdvantage,
          risk: copy.continueRisk,
          verificationImpact: copy.continueVerify,
        },
      ],
    };
  }

  const pendingCount = writePreview.projectWrites.length;
  const conflictCount = writePreview.projectConflicts?.length ?? 0;
  const targetText = state.activeTargets.join(", ");
  const reason = state.confirmationReason;
  const hasConflicts = state.status === "conflict";
  return {
    required: true,
    trigger: "runtime_native_choice_required_before_apply",
    runtimeRequirement: copy.runtimeRequirement,
    header: copy.bootstrapHeader,
    question: [
      copy.understanding(targetText),
      copy.additions(state.status, reason),
      copy.route,
      copy.candidates(hasConflicts, pendingCount, conflictCount, writePreview.globalWrites.length),
    ].join("\n"),
    recommendedOptionId: hasConflicts ? "inspect_dry_run_only" : "apply_project_bootstrap",
    options: [
      {
        id: "apply_project_bootstrap",
        label: hasConflicts ? copy.applyBlocked : copy.apply,
        expectedResult: copy.applyExpected,
        advantage: copy.applyAdvantage,
        risk: hasConflicts ? copy.applyBlockedRisk : copy.applyRisk,
        verificationImpact: copy.applyVerify,
      },
      {
        id: "inspect_dry_run_only",
        label: copy.inspect,
        expectedResult: copy.inspectExpected,
        advantage: copy.inspectAdvantage,
        risk: copy.inspectRisk,
        verificationImpact: copy.inspectVerify,
      },
      {
        id: "skip_this_project",
        label: copy.skip,
        expectedResult: copy.skipExpected,
        advantage: copy.skipAdvantage,
        risk: copy.skipRisk,
        verificationImpact: copy.skipVerify,
      },
    ],
  };
}

function buildProjectBootstrapPlan(activeTargets, targetDir) {
  const filePlans = collectProjectDeployPlan(activeTargets, targetDir);
  const state = projectBootstrapStatus(targetDir, activeTargets, filePlans);
  const writePreview = projectBootstrapWritePreview(targetDir, filePlans, state);
  return {
    schemaVersion: "meta-kim-project-bootstrap-plan-v0.1",
    mode: "dry-run",
    sourceChain: readSyncSourceChain(),
    state,
    files: filePlans,
    writePreview,
    choiceSurface: buildProjectBootstrapChoiceSurface(state, writePreview),
    decisions: {
      defaultTargets:
        "config/sync.json defaultTargets are Claude Code + Codex; effective activeTargets may also come from an explicit --targets value or saved .meta-kim/local.overrides.json activeTargets.",
      protectedMerge: "JSON configs use additive preserve-user-state merge; AGENTS.md/CLAUDE.md use managed text blocks; .codex/config.toml is skipped because Codex native controls belong to global host config.",
      firstTriggerFlow:
        "Global skill runs dry-run first, asks through the runtime native choice surface, then runs --apply only after user confirmation or trusted-auto policy.",
    },
  };
}

function assertNoProjectBootstrapConflicts(plan) {
  const conflicts = plan.writePreview?.projectConflicts ?? [];
  if (conflicts.length === 0) return;
  const rels = conflicts.map((entry) => entry.relPath).join(", ");
  throw new Error(
    `Project bootstrap blocked by ${conflicts.length} user-owned file conflict(s): ${rels}`,
  );
}

function projectBootstrapTransactionBackupDescriptor(filePlans) {
  const entries = filePlans
    .filter((plan) =>
      plan.action !== "skip" &&
      plan.effectiveAction !== "unchanged" &&
      plan.effectiveAction !== "conflict" &&
      plan.exists)
    .map((plan) => ({ relPath: plan.relPath, mergePolicy: plan.mergePolicy }));
  return {
    created: entries.length > 0,
    managedByTransaction: true,
    backupRootPattern: ".meta-kim/backups/project-bootstrap-transaction/project-bootstrap-apply-*",
    fileCount: entries.length,
    entries,
  };
}

// Per-platform project-level hook directories. Mirrors RUNTIME_HOOK_CAPABILITIES
// but kept inline so this function stays self-contained for the bootstrap CLI.
const PROJECT_HOOK_DIRS_BY_PLATFORM = {
  claude: ".claude/hooks",
  codex: ".codex/hooks",
  cursor: ".cursor/hooks",
  openclaw: "openclaw/hooks",
};

// Per-platform whitelist of Meta_Kim-managed hook files. Files NOT on the
// whitelist (user-authored) are preserved.
const PROJECT_HOOK_FILE_WHITELIST_BY_PLATFORM = {
  claude: new Set([
    "project-root.mjs",
    "utils.mjs",
    "skip-reminder.mjs",
    "spine-state-utils.mjs",
    "spine-state-gates.mjs",
    "spine-state.mjs",
    "activate-meta-theory-spine.mjs",
    "bash-readonly-whitelist.mjs",
    "block-dangerous-bash.mjs",
    "ecc-permission-cache-wrapper.mjs",
    "enforce-agent-dispatch.mjs",
    "graphify-context.mjs",
    "hook-i18n.mjs",
    "meta-kim-memory-save.mjs",
    "post-format.mjs",
    "post-typecheck.mjs",
    "post-console-log-warn.mjs",
    "subagent-context.mjs",
    "stop-compaction.mjs",
    "stop-memory-save.mjs",
    "stop-console-log-audit.mjs",
    "stop-completion-guard.mjs",
    "stop-save-progress.mjs",
    "stop-spine-cleanup.mjs",
  ]),
  codex: new Set([
    "project-root.mjs",
    "utils.mjs",
    "skip-reminder.mjs",
    "spine-state-utils.mjs",
    "spine-state-gates.mjs",
    "spine-state.mjs",
    "activate-meta-theory-spine.mjs",
    "bash-readonly-whitelist.mjs",
    "codex_hook_adapter.py",
    "codex_hook_runner.mjs",
    "enforce-agent-dispatch.mjs",
    "graphify-context.mjs",
    "hook-i18n.mjs",
    "hookprompt-adapter.mjs",
    "meta-kim-memory-save.mjs",
    "planning-with-files-adapter.mjs",
    "post_tool_use.py",
    "post-tool-use.sh",
    "post-console-log-warn.mjs",
    "post-format.mjs",
    "post-typecheck.mjs",
    "pre_tool_use.py",
    "pre-tool-use.sh",
    "pre-compact.sh",
    "session_start.py",
    "session-start.sh",
    "stop.py",
    "stop.sh",
    "user_prompt_submit.py",
    "user-prompt-submit.sh",
    "permission_request.py",
    "resolve-plan-dir.sh",
    "stop-compaction.mjs",
    "stop-console-log-audit.mjs",
    "stop-completion-guard.mjs",
    "stop-spine-cleanup.mjs",
    "subagent-context.mjs",
  ]),
  cursor: new Set([
    "project-root.mjs",
    "utils.mjs",
    "skip-reminder.mjs",
    "spine-state-utils.mjs",
    "spine-state-gates.mjs",
    "spine-state.mjs",
    "activate-meta-theory-spine.mjs",
    "bash-readonly-whitelist.mjs",
    "enforce-agent-dispatch.mjs",
    "graphify-context.mjs",
    "hook-i18n.mjs",
    "hookprompt-adapter.mjs",
    "meta-kim-memory-save.mjs",
    "planning-with-files-adapter.mjs",
    "post-tool-use.ps1",
    "post-tool-use.sh",
    "post-console-log-warn.mjs",
    "post-format.mjs",
    "post-typecheck.mjs",
    "pre-tool-use.ps1",
    "pre-tool-use.sh",
    "stop.ps1",
    "stop.sh",
    "user-prompt-submit.ps1",
    "user-prompt-submit.sh",
    "stop-compaction.mjs",
    "stop-console-log-audit.mjs",
    "stop-completion-guard.mjs",
    "stop-spine-cleanup.mjs",
    "subagent-context.mjs",
  ]),
  openclaw: new Set([
    "stop-save-progress.mjs",
  ]),
};

// Remove Meta_Kim-managed hook files from a target project's hook dirs.
// Walks every active platform, removes files matching the per-platform
// whitelist, and emits a 4-locale progress message.
async function migrateProjectMetaKimHooksForBootstrap(activeTargets, targetDir) {
  const platforms = Array.isArray(activeTargets) ? activeTargets : [];
  const cleanup = { removed: [], skipped: [], backups: [] };
  for (const platform of platforms) {
    const relDir = PROJECT_HOOK_DIRS_BY_PLATFORM[platform];
    const whitelist = PROJECT_HOOK_FILE_WHITELIST_BY_PLATFORM[platform];
    if (!relDir || !whitelist) continue;
    const hooksDir = join(targetDir, relDir);
    if (existsSync(hooksDir) && !safeProjectPathInfo(targetDir, relDir)) {
      cleanup.skipped.push({
        relPath: normalizeDeployRelPath(relDir),
        reason: "unsafe_realpath_or_link_preserved",
      });
      continue;
    }
    let entries;
    try {
      entries = readdirSync(hooksDir);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const removed = [];
    const kept = [];
    for (const name of entries) {
      if (!whitelist.has(name)) {
        kept.push(name);
        continue;
      }
      const relPath = normalizeDeployRelPath(join(relDir, name));
      const skipped = [];
      if (!safeProjectPathInfo(targetDir, relPath)) {
        cleanup.skipped.push({
          relPath,
          reason: "unsafe_realpath_or_link_preserved",
        });
        kept.push(name);
        continue;
      }
      const proof = projectRemovalProof(targetDir, relPath);
      if (!proof) {
        cleanup.skipped.push({
          relPath,
          reason: projectRemovalUnprovenReason(
            targetDir,
            relPath,
            "hook_ownership_unproven_preserved",
          ),
        });
        kept.push(name);
        continue;
      }
      if (!removeUntrackedProjectPath(targetDir, relPath, skipped, {
        recursive: false,
        backup: true,
        backups: cleanup.backups,
      })) {
        cleanup.skipped.push(...skipped);
        kept.push(name);
        continue;
      }
      removed.push(name);
      cleanup.removed.push(relPath);
    }
    if (removed.length > 0) {
      if (!jsonOutputMode) {
        info(t.projectHooksMigrationRemoved(platform, removed.length, hooksDir));
        info(t.projectHooksMigrationKept(platform, kept));
      }
      let remaining = [];
      try {
        remaining = readdirSync(hooksDir);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (remaining.length === 0) {
        rmSync(hooksDir, { recursive: true, force: true });
      }
    } else {
      if (!jsonOutputMode) {
        info(t.projectHooksMigrationNoChange(platform, hooksDir));
      }
    }
  }
  return cleanup;
}

const PROJECT_MUTATION_SESSION_LOCK_KEY = "project-mutation-session";
async function applyProjectBootstrapToDir(activeTargets, targetDir) {
  if (!existsSync(targetDir)) {
    if (!missingProjectTargetHasNoLinkedAncestor(targetDir)) {
      throw new Error("Project bootstrap blocked: target path has an unsafe linked ancestor");
    }
    mkdirSync(targetDir, { recursive: true });
  }
  if (!safeProjectPathInfo(targetDir, ".meta-kim", { allowMissing: true })) {
    throw new Error("Project bootstrap blocked: unsafe .meta-kim path or Junction");
  }
  const session = await withSafeManagedFileLock(
    {
      trustedRoot: targetDir,
      lockKey: PROJECT_MUTATION_SESSION_LOCK_KEY,
    },
    () => runProjectBootstrapApplyUnlocked(activeTargets, targetDir),
  );
  if (!session.ok) {
    const error = new Error(
      `Project bootstrap session blocked: ${session.reason ?? session.status}`,
    );
    error.status = "blocked";
    error.repairAction = session.nextAction ??
      "Wait for the active project operation to finish, then rerun project bootstrap dry-run before apply.";
    throw error;
  }
  await joinProjectRegistry({
    repoPath: targetDir,
    runtimeFamily: "shared",
    sourceType: "project_bootstrap",
    sourceRef: "setup-project-bootstrap",
  });
  return session.value;
}

function projectBootstrapTransactionalPlan(plan, targetDir, backup) {
  const operations = [];
  const cleanup = { removed: [], skipped: [], backups: [], strippedHookConfigs: [] };
  const currentRelPaths = new Set(plan.files.map((file) => file.relPath));
  const protectedPaths = loadProtectedProjectCapabilityPaths(targetDir, PROJECT_DIR);
  const hookConfigPaths = new Set([".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json"]);

  for (const [relPath, previousEntry] of previousProjectManagedFileMap(targetDir)) {
    if (currentRelPaths.has(relPath) || protectedProjectCapabilityIntersects(relPath, protectedPaths)) continue;
    const info = safeProjectPathInfo(targetDir, relPath, { allowMissing: true });
    if (!info) {
      cleanup.skipped.push({ relPath, reason: "unsafe_realpath_or_link_preserved" });
      continue;
    }
    if (!existsSync(info.target)) continue;
    const currentHash = projectFileHash(info.target);
    if (currentHash !== previousEntry.contentHash) {
      cleanup.skipped.push({ relPath, reason: "manifest_hash_mismatch_preserved" });
      continue;
    }
    if (hookConfigPaths.has(relPath)) {
      const current = readJsonObjectIfExists(info.target);
      if (!current) {
        cleanup.skipped.push({ relPath, reason: "invalid_managed_config_preserved" });
        continue;
      }
      const stripped = `${JSON.stringify(stripProjectMetaKimHooksFromHookConfig(current), null, 2)}\n`;
      if (createHash("sha256").update(stripped).digest("hex") !== currentHash) {
        operations.push({ kind: "write", phase: "content", relPath, content: stripped, expectedOldHash: currentHash });
        cleanup.strippedHookConfigs.push(relPath);
      }
      continue;
    }
    if (!isProjectLocalCapabilityAsset(relPath)) continue;
    operations.push({ kind: "remove", phase: "content", relPath, expectedOldHash: currentHash });
    cleanup.removed.push(relPath);
  }

  for (const file of plan.files) {
    if (["skip", "unchanged", "conflict"].includes(file.effectiveAction) || file.action === "skip") continue;
    operations.push({
      kind: "write",
      phase: "content",
      relPath: file.relPath,
      content: file[PROJECT_PLAN_CONTENT],
      expectedOldHash: file.currentHash,
      allowManagedMissingCreate: true,
    });
  }

  const manifest = {
    schemaVersion: "meta-kim-project-bootstrap-v0.1",
    appliedAt: new Date().toISOString(),
    metaKimVersion: readPackageVersion(),
    activeTargets: plan.state.activeTargets,
    sourceChain: plan.sourceChain,
    stateBeforeApply: plan.state,
    protectedMergeDecisions: plan.decisions,
    backup,
    cleanup,
    managedFiles: plan.files
      .filter((file) => file.action !== "skip" && file.effectiveAction !== "conflict")
      .map((file) => ({ ...file, contentHash: file.sourceHash ?? file.currentHash })),
    skippedFiles: plan.files.filter((file) => file.action === "skip").map((file) => ({ ...file })),
  };
  const manifestRelPath = existingProjectProjectionUpdatePolicy().managedStateMarker;
  operations.push({
    kind: "write",
    phase: "manifest",
    relPath: manifestRelPath,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
    expectedOldHash: projectFileHash(projectBootstrapManifestPath(targetDir)),
    allowManagedMissingCreate: true,
  });
  return { operations, cleanup, manifest };
}

async function runProjectBootstrapApplyUnlocked(activeTargets, targetDir) {
  const plan = buildProjectBootstrapPlan(activeTargets, targetDir);
  // This is the last read-only gate. No backup, cleanup, strip, projection, or
  // manifest write may happen before every file conflict is known.
  assertNoProjectBootstrapConflicts(plan);
  const currentRelPaths = new Set(plan.files.map((file) => file.relPath));
  const hasStaleManifestEntries = [...previousProjectManagedFileMap(targetDir).keys()]
    .some((relPath) => !currentRelPaths.has(relPath));
  if (plan.state.status === "ready" && !hasStaleManifestEntries) {
    return {
      ...plan,
      mode: "apply",
      applied: false,
      noOp: true,
      backup: { created: false, fileCount: 0, entries: [] },
      cleanup: { removed: [], skipped: [], backups: [], strippedHookConfigs: [] },
      manifestPath: projectBootstrapManifestPath(targetDir),
    };
  }
  // Backups are created by the same journaled transaction as content and
  // manifest commits. This descriptor is write-free and safe to embed in the
  // manifest before the transaction chooses its nonce-specific backup path.
  const backup = projectBootstrapTransactionBackupDescriptor(plan.files);
  const transactionPlan = projectBootstrapTransactionalPlan(plan, targetDir, backup);
  const transaction = executeSafeManagedFileTransaction({
    trustedRoot: targetDir,
    backupRoot: join(targetDir, ".meta-kim", "backups", "project-bootstrap-transaction"),
    operations: transactionPlan.operations,
    transactionLabel: "project-bootstrap-apply",
    lockKey: "project-bootstrap-apply",
  });
  if (!transaction.ok) {
    const error = new Error(`Project bootstrap transaction blocked: ${transaction.reason ?? transaction.status}`);
    error.status = transaction.status === "rolled_back" ? "failed" : "blocked";
    error.repairAction = transaction.nextAction;
    throw error;
  }
  transactionPlan.cleanup.backups.push(...(transaction.backups ?? []));
  for (const relPath of transactionPlan.cleanup.removed) {
    pruneEmptyProjectDirs(targetDir, relPath);
  }
  reportProjectAssetCleanup(transactionPlan.cleanup, { reason: "project_retarget" });
  const manifestPath = projectBootstrapManifestPath(targetDir);
  const afterPlan = buildProjectBootstrapPlan(activeTargets, targetDir);
  return {
    ...afterPlan,
    mode: "apply",
    applied: true,
    backup,
    cleanup: transactionPlan.cleanup,
    transaction,
    manifestPath,
  };
}

function classifyProjectBootstrapError(error) {
  if (error?.status === "blocked" || error?.status === "failed") {
    return error.status;
  }
  const msg = error?.message || String(error);
  return /EACCES|EPERM|permission|read-only|readonly|access denied/i.test(msg)
    ? "blocked"
    : "failed";
}

function projectBootstrapFailureResult(targetDir, activeTargets, error) {
  const message = error?.message || String(error);
  return {
    schemaVersion: "meta-kim-project-bootstrap-plan-v0.1",
    mode: "apply",
    applied: false,
    state: {
      status: classifyProjectBootstrapError(error),
      targetDir,
      activeTargets,
    },
    error: {
      status: classifyProjectBootstrapError(error),
      message,
      returnToStage: "Fetch",
      repairAction: error?.repairAction ??
        "Fix target permissions or resolve the conflicting project file, then rerun project bootstrap dry-run before apply.",
    },
  };
}

function deployPlatformFiles(platformId, targetDir) {
  let fileCount = 0;
  const targetIsRepo = resolve(targetDir) === resolve(PROJECT_DIR);
  const protectedPaths = loadProtectedProjectCapabilityPaths(targetDir, PROJECT_DIR);
  const copyIfExists = (srcRel, destRel) => {
    const src = join(PROJECT_DIR, srcRel);
    const dest = join(targetDir, destRel);
    if (
      targetIsRepo &&
      existsSync(src) &&
      resolve(src) === resolve(dest)
    ) {
      return;
    }
    if (!existsSync(src)) return;
    mkdirSync(dirname(dest), { recursive: true });
    const relPath = normalizeDeployRelPath(destRel);
    if (existsSync(src) && statSync(src).isDirectory()) {
      fileCount += copyDirRecursive(src, dest, {
        sourceRoot: PROJECT_DIR,
        targetDir,
        protectedPaths,
      });
    } else {
      fileCount += copyProjectDeployFile(
        src,
        dest,
        relPath,
        targetDir,
        protectedPaths,
      );
    }
  };

  for (const root of projectDeployRootsForPlatform(platformId)) {
    copyIfExists(root.srcRel, root.destRel);
  }
  fileCount += writeProjectGeneratedHooks(platformId, targetDir, protectedPaths);
  return fileCount;
}

function printPostCopyBootstrapHint() {
  console.log(`${C.dim}  ${t.npxQuickPostCopyScript}${C.reset}`);
}

function savedProjectDeployDirsFrom(overrides) {
  return uniqueProjectDeployDirs(overrides?.projectDeployDirs || []);
}

function callerProjectOverrides() {
  return readJsonObjectIfExists(
    join(CALLER_CWD, ".meta-kim", "local.overrides.json"),
  ) ?? {};
}

async function existingManagedProjectDeployDirs() {
  const policy = existingProjectProjectionUpdatePolicy();
  const packageOverrides = await loadLocalOverrides();
  const savedDirs = uniqueProjectDeployDirs([
    ...savedProjectDeployDirsFrom(packageOverrides),
    ...savedProjectDeployDirsFrom(callerProjectOverrides()),
  ]);
  const registryDirs = (await listJoinedProjectRegistryEntries()).map((entry) => entry.repoRoot);
  const candidatesBySource = {
    explicit_project_dirs: cliProjectDeployDirs.map((targetDir) => ({ targetDir, source: "explicit_project_dirs" })),
    saved_project_dirs: [
      ...savedDirs.map((targetDir) => ({ targetDir, source: "saved_project_dirs" })),
      ...registryDirs.map((targetDir) => ({ targetDir, source: "project_registry" })),
    ],
    current_working_directory: [{ targetDir: CALLER_CWD, source: "current_working_directory" }],
  };
  const candidates = [];
  const seen = new Set();
  for (const candidate of policy.discoveryOrder.flatMap((source) => candidatesBySource[source] ?? [])) {
    const targetDir = resolve(candidate.targetDir);
    const key = isWin ? targetDir.replace(/\\/gu, "/").toLowerCase() : targetDir;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...candidate, targetDir });
  }

  const resolution = resolveExistingManagedProjectCandidates(candidates, {
    manifestRelPath: policy.managedStateMarker,
  });
  for (const deployment of resolution.deployments) {
    if (deployment.source === "saved_project_dirs") {
      await joinProjectRegistry({ repoPath: deployment.targetDir, runtimeFamily: "shared", sourceType: "project_bootstrap", sourceRef: "legacy-local-overrides" });
    }
  }
  return resolution;
}

async function existingManagedProjectDeployments() {
  return existingManagedProjectDeployDirs();
}

function reportRejectedManagedProjectTargets(rejected) {
  if (!Array.isArray(rejected) || rejected.length === 0 || jsonOutputMode) return;
  warn(t.managedProjectRejectedHeading(rejected.length));
  for (const item of rejected) {
    console.log(`${C.yellow}  • ${item.targetDir}${C.reset}`);
    const source = t.managedProjectRejectedSources?.[item.source] ?? item.source;
    const reason = t.managedProjectRejectedReasons?.[item.reason] ?? item.reason;
    console.log(`${C.dim}    ${t.managedProjectRejectedDetail(source, reason)}${C.reset}`);
  }
  console.log(`${C.dim}${t.managedProjectRejectedRepair}${C.reset}`);
}

function projectDeployConfigDisplayPath() {
  return ".meta-kim/local.overrides.json";
}

async function saveProjectDeployDirs(dirs) {
  const normalized = uniqueProjectDeployDirs(dirs);
  const localOverrides = await loadLocalOverrides();
  await writeLocalOverrides({
    ...localOverrides,
    projectDeployDirs: normalized,
  });
  for (const targetDir of normalized) {
    await joinProjectRegistry({
      repoPath: targetDir,
      runtimeFamily: "shared",
      sourceType: "project_bootstrap",
      sourceRef: "setup-save-project-dirs",
    });
  }
  info(t.projectDeploySavedTargets(normalized.length));
  console.log(
    `${C.dim}${t.projectDeploySavedPathHint(projectDeployConfigDisplayPath())}${C.reset}`,
  );
}

function stripProjectDeployDirInput(raw) {
  const trimmed = String(raw || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseProjectDeployDirText(rawText) {
  const dirs = [];
  const parts = String(rawText || "")
    .replace(/\r?\n/g, ";")
    .split(/[;,，；]+/);
  for (const part of parts) {
    const cleaned = stripProjectDeployDirInput(part);
    if (!cleaned || cleaned.startsWith("#")) continue;
    dirs.push(cleaned);
  }
  return uniqueProjectDeployDirs(dirs);
}

async function askProjectDeployTargetDirectories() {
  console.log(`${C.dim}${t.projectDeployPathEntryHint}${C.reset}`);
  const answer = await ask(t.projectDeployDirPrompt);
  return parseProjectDeployDirText(answer);
}

function printProjectDeployDirList(heading, dirs) {
  if (!dirs.length) return;
  console.log(`${C.bold}${heading}${C.reset}`);
  dirs.forEach((dir, index) => {
    console.log(`${C.dim}${index + 1}.${C.reset} ${dir}`);
  });
  console.log("");
}

async function confirmProjectDeployDirs(dirs, remember) {
  const normalized = uniqueProjectDeployDirs(dirs);
  if (normalized.length === 0) {
    skip(t.projectDeployNoDirsEntered);
    return [];
  }
  printProjectDeployDirList(
    t.projectDeployParsedTargets(normalized.length),
    normalized,
  );
  const confirmQuestion = remember
    ? t.projectDeployConfirmSaveAndUpdate(normalized.length)
    : t.projectDeployConfirmUpdateOnce(normalized.length);
  const confirmed = await askYesNo(confirmQuestion, true);
  return confirmed ? normalized : [];
}

async function collectProjectDeployDirs(remember) {
  const parsed = await askProjectDeployTargetDirectories();
  const confirmed = await confirmProjectDeployDirs(parsed, remember);
  if (remember && confirmed.length > 0) {
    await saveProjectDeployDirs(confirmed);
  }
  return confirmed;
}

async function askDeployDirectory() {
  console.log("");

  if (cliProjectDeployDirs.length > 0) {
    info(t.projectDeployCliTargets(cliProjectDeployDirs.length));
    if (saveProjectDirsMode) {
      await saveProjectDeployDirs(cliProjectDeployDirs);
    } else {
      console.log(`${C.dim}${t.projectDeployCliSaveHint}${C.reset}`);
    }
    return cliProjectDeployDirs;
  }

  const localOverrides = await loadLocalOverrides();
  const savedDirs = savedProjectDeployDirsFrom(localOverrides);

  if (useSavedProjectDirsMode) {
    if (savedDirs.length === 0) {
      skip(t.projectDeployNoSaved);
      return [];
    }
    info(t.projectDeployUseSaved(savedDirs.length));
    return savedDirs;
  }

  if (silentMode) {
    return uniqueProjectDeployDirs([CALLER_CWD]);
  }

  console.log(`${C.dim}${t.projectDeployProtectionNote}${C.reset}`);
  console.log(`${C.dim}${t.projectDeployInteractiveHint}${C.reset}`);
  if (savedDirs.length > 0) {
    printProjectDeployDirList(
      t.projectDeploySavedListHeading(savedDirs.length),
      savedDirs,
    );
  }
  const options = [];
  if (savedDirs.length > 0) {
    options.push({ id: "saved", label: t.projectDeployUseSaved(savedDirs.length) });
    options.push(
      { id: "remember", label: t.projectDeploySelectAndRemember },
      { id: "once", label: t.projectDeploySelectOnce },
    );
  } else {
    options.push(
      { id: "remember", label: t.projectDeploySelectAndRemember },
      { id: "once", label: t.projectDeploySelectOnce },
    );
  }
  options.push({ id: "skip", label: t.npxQuickDeployNo });

  const choiceIdx = await askSelect(
    t.projectDeployAsk,
    options.map((option) => option.label),
  );
  const choice = options[choiceIdx]?.id || "skip";
  if (choice === "saved") {
    console.log("");
    return savedDirs;
  }
  if (choice === "once") {
    const dirs = await collectProjectDeployDirs(false);
    console.log("");
    return dirs;
  }
  if (choice === "remember") {
    const dirs = await collectProjectDeployDirs(true);
    console.log("");
    return dirs;
  }
  console.log("");
  return [];
}

async function askProjectCleanupDirectory() {
  console.log("");

  if (cliProjectDeployDirs.length > 0) {
    info(t.projectDeployCliTargets(cliProjectDeployDirs.length));
    if (saveProjectDirsMode) {
      await saveProjectDeployDirs(cliProjectDeployDirs);
    } else {
      console.log(`${C.dim}${t.projectDeployCliSaveHint}${C.reset}`);
    }
    return cliProjectDeployDirs;
  }

  const localOverrides = await loadLocalOverrides();
  const savedDirs = savedProjectDeployDirsFrom(localOverrides);

  if (useSavedProjectDirsMode) {
    if (savedDirs.length === 0) {
      skip(t.projectDeployNoSaved);
      return [];
    }
    info(t.projectCleanupUseSaved(savedDirs.length));
    return savedDirs;
  }

  if (silentMode) {
    return [];
  }

  if (savedDirs.length > 0) {
    printProjectDeployDirList(
      t.projectDeploySavedListHeading(savedDirs.length),
      savedDirs,
    );
  } else {
    console.log(`${C.dim}${t.projectDeployNoSaved}${C.reset}`);
  }

  const wantCleanup = await askYesNo(t.askProjectRedundantCleanup, true);
  if (!wantCleanup) return [];

  console.log(`${C.dim}${t.projectCleanupProtectionNote}${C.reset}`);
  if (savedDirs.length === 0) {
    const dirs = await collectProjectDeployDirs(false);
    console.log("");
    return dirs;
  }

  const options = [
    { id: "saved", label: t.projectCleanupUseSaved(savedDirs.length) },
    { id: "remember", label: t.projectCleanupSelectAndRemember },
    { id: "once", label: t.projectCleanupSelectOnce },
  ];
  options.push({ id: "skip", label: t.npxQuickDeployNo });

  const choiceIdx = await askSelect(
    t.projectCleanupAsk,
    options.map((option) => option.label),
  );
  const choice = options[choiceIdx]?.id || "skip";
  if (choice === "saved") {
    console.log("");
    return savedDirs;
  }
  if (choice === "once") {
    const dirs = await collectProjectDeployDirs(false);
    console.log("");
    return dirs;
  }
  if (choice === "remember") {
    const dirs = await collectProjectDeployDirs(true);
    console.log("");
    return dirs;
  }
  console.log("");
  return [];
}

function printProjectDeploySummary(results) {
  if (!results.length) return;
  console.log(`${C.bold}${t.projectDeploySummary}${C.reset}`);
  for (const result of results) {
    const label =
      result.status === "ok"
        ? `${C.green}${t.projectDeployStatusOk}${C.reset}`
        : `${C.red}${t.projectDeployStatusFailed}${C.reset}`;
    console.log(`${C.dim}- ${result.dir}:${C.reset} ${label}`);
  }
  console.log("");
}

function printProjectCleanupSummary(results) {
  if (!results.length) return;
  console.log(`${C.bold}${t.projectCleanupSummary}${C.reset}`);
  for (const result of results) {
    const label = result.status === "ok"
      ? `${C.green}${t.projectDeployStatusOk}${C.reset}`
      : result.status === "partial"
        ? `${C.yellow}${t.projectDeployStatusPartial}${C.reset}`
        : result.status === "blocked"
          ? `${C.red}${t.projectDeployStatusBlocked}${C.reset}`
          : `${C.red}${t.projectDeployStatusFailed}${C.reset}`;
    console.log(`${C.dim}- ${result.dir}:${C.reset} ${label}`);
  }
  console.log("");
}

function cleanupProjectHookConfigs(activeTargets, targetDir) {
  const platforms = new Set();
  for (const platform of activeTargets) {
    if (platform === "all") {
      platforms.add("claude");
      platforms.add("codex");
      platforms.add("cursor");
      continue;
    }
    if (platform === "claude" || platform === "codex" || platform === "cursor") {
      platforms.add(platform);
    }
  }

  const relPaths = [];
  if (platforms.has("claude")) relPaths.push(".claude/settings.json");
  if (platforms.has("codex")) relPaths.push(".codex/hooks.json");
  if (platforms.has("cursor")) relPaths.push(".cursor/hooks.json");

  const changed = [];
  const cleanup = { removed: [], skipped: [], backups: [] };
  for (const relPath of relPaths) {
    const configPath = join(targetDir, relPath);
    if (!existsSync(configPath)) continue;
    if (!safeProjectPathInfo(targetDir, relPath)) {
      cleanup.skipped.push({
        relPath,
        reason: "unsafe_realpath_or_link_preserved",
      });
      continue;
    }
    if (!projectRemovalProof(targetDir, relPath)) {
      cleanup.skipped.push({
        relPath,
        reason: projectRemovalUnprovenReason(
          targetDir,
          relPath,
          "config_ownership_unproven_preserved",
        ),
      });
      continue;
    }
    const current = readJsonObjectIfExists(configPath);
    if (!current) continue;
    const stripped = stripProjectMetaKimHooksFromHookConfig(current);
    if (jsonEquivalent(current, stripped)) continue;
    if (isGitTrackedProjectPath(targetDir, relPath)) continue;
    if (!writeProjectFileWithVerifiedBackup(
      targetDir,
      relPath,
      JSON.stringify(stripped, null, 2) + "\n",
      cleanup.backups,
    )) {
      cleanup.skipped.push({
        relPath,
        reason: "backup_or_atomic_write_failed_preserved",
      });
      continue;
    }
    changed.push(relPath);
  }

  if (changed.length > 0 && !jsonOutputMode) {
    const formatter = t.projectCleanupHookConfigStripped;
    const message =
      typeof formatter === "function"
        ? formatter(changed)
        : `Removed Meta_Kim project hook references from: ${changed.join(", ")}`;
    info(message);
  }
  return { changed, cleanup };
}

async function cleanupProjectRedundancyDirs(activeTargets, targetDirs) {
  const dirs = uniqueProjectDeployDirs(targetDirs);
  if (dirs.length === 0) return [];

  if (!jsonOutputMode) {
    heading(t.projectCleanupBatchHeading(dirs.length));
    console.log(`${C.dim}${t.projectCleanupProtectionNote}${C.reset}`);
    info(t.projectAssetsCleanupIntro);
    info(t.projectAssetsCleanupScope);
  }

  const results = [];
  for (const targetDir of dirs) {
    try {
      if (!existsSync(targetDir)) {
        results.push({
          dir: targetDir,
          status: "ok",
          cleanup: mergeProjectCleanupResults(),
          strippedHookConfigs: [],
          retryableIssues: [],
        });
        continue;
      }
      const session = await withSafeManagedFileLock(
        {
          trustedRoot: targetDir,
          lockKey: PROJECT_MUTATION_SESSION_LOCK_KEY,
        },
        async () => {
          const hookMigrationCleanup = await migrateProjectMetaKimHooksForBootstrap(
            activeTargets,
            targetDir,
          );
          const hookConfigResult = cleanupProjectHookConfigs(activeTargets, targetDir);
          const strippedHookConfigs = hookConfigResult.changed;
          const legacyCleanup = removeLegacyProjectCapabilityEntrypoints(targetDir, activeTargets);
          const plan = buildProjectBootstrapPlan(activeTargets, targetDir);
          const capabilityRootCleanup = removeGlobalProjectCapabilityRoots(targetDir, activeTargets);
          const generatedSkillCleanup = removeMetaKimGeneratedProjectSkillResidue(
            targetDir,
            activeTargets,
          );
          const openClawDirectoryCleanup = removeMetaKimOpenClawDirectoryResidue(
            targetDir,
            activeTargets,
          );
          const configCleanup = cleanupRedundantProjectConfigs(
            targetDir,
            activeTargets,
            plan.files,
            { preserveRelPaths: strippedHookConfigs },
          );
          const instructionCleanup = removeRedundantProjectInstructionFiles(
            targetDir,
            activeTargets,
          );
          const staleManagedCleanup = removeStaleManagedProjectAssets(
            targetDir,
            plan.files,
            {
              removeCurrentManaged: true,
              preserveRelPaths: strippedHookConfigs,
            },
          );
          const cleanupBeforeLocalState = mergeProjectCleanupResults(
            hookMigrationCleanup,
            hookConfigResult.cleanup,
            legacyCleanup,
            capabilityRootCleanup,
            generatedSkillCleanup,
            openClawDirectoryCleanup,
            configCleanup,
            instructionCleanup,
            staleManagedCleanup,
          );
          const retryableBeforeLocalState = projectCleanupRetryableIssues(
            cleanupBeforeLocalState,
          );
          const localStateCleanup = removeMetaKimProjectLocalState(targetDir, {
            preserveManifest: retryableBeforeLocalState.length > 0,
          });
          const emptyDirCleanup = pruneEmptyProjectRuntimeDirs(targetDir, activeTargets);
          const cleanup = mergeProjectCleanupResults(
            cleanupBeforeLocalState,
            localStateCleanup,
            emptyDirCleanup,
          );
          const retryableIssues = projectCleanupRetryableIssues(cleanup);
          const status = projectCleanupStatus(cleanup);
          if (!jsonOutputMode) {
            reportProjectAssetCleanup(cleanup, { reason: "global_redundancy" });
          }
          return {
            dir: targetDir,
            status,
            cleanup,
            strippedHookConfigs,
            retryableIssues,
          };
        },
      );
      if (!session.ok) {
        const message = `Project cleanup session blocked: ${session.reason ?? session.status}`;
        if (!jsonOutputMode) {
          warn(t.projectDeployFailed(targetDir, message));
        }
        results.push({
          dir: targetDir,
          status: "blocked",
          message,
          repairAction: session.nextAction ??
            "Wait for the active project operation to finish, then retry cleanup.",
          retryableIssues: [{
            reason: session.reason ?? session.status,
            status: "blocked",
          }],
        });
        continue;
      }
      results.push(session.value);
    } catch (error) {
      const msg = error?.message || String(error);
      if (!jsonOutputMode) {
        warn(t.projectDeployFailed(targetDir, msg));
      }
      results.push({ dir: targetDir, status: "failed", message: msg });
    }
  }
  if (!jsonOutputMode) {
    printProjectCleanupSummary(results);
  }
  return results;
}

async function copyToDeployDirs(activeTargets, targetDirs) {
  const deployments = [];
  const seen = new Set();
  for (const candidate of targetDirs) {
    const targetDir = resolve(typeof candidate === "string" ? candidate : candidate.targetDir);
    const key = process.platform === "win32" ? targetDir.toLowerCase() : targetDir;
    if (seen.has(key)) continue;
    seen.add(key);
    deployments.push({
      targetDir,
      activeTargets: typeof candidate === "string"
        ? activeTargets
        : normalizeTargets(candidate.activeTargets),
    });
  }
  if (deployments.length === 0) return [];

  heading(t.projectDeployBatchHeading(deployments.length));
  console.log(`${C.dim}${t.projectDeployProtectionNote}${C.reset}`);

  const results = [];
  for (const deployment of deployments) {
    const { targetDir } = deployment;
    try {
      const result = await copyToDeployDir(deployment.activeTargets, targetDir);
      results.push({
        dir: targetDir,
        activeTargets: deployment.activeTargets,
        status: "ok",
        manifestPath: result.manifestPath,
        stateStatus: result.state?.status ?? "unknown",
      });
    } catch (error) {
      const msg = error?.message || String(error);
      warn(t.projectDeployFailed(targetDir, msg));
      results.push({ dir: targetDir, status: "failed", message: msg });
    }
  }
  printProjectDeploySummary(results);
  return results;
}

async function copyToDeployDir(activeTargets, targetDir) {
  if (existsSync(targetDir)) {
    console.log(`${C.dim}  ${t.npxQuickDirExists}${C.reset}`);
  } else {
    mkdirSync(targetDir, { recursive: true });
  }

  console.log(`${C.dim}  ${t.npxQuickCreating} ${targetDir}${C.reset}`);

  const bootstrapResult = await applyProjectBootstrapToDir(activeTargets, targetDir);
  const normalizedTargets = normalizeTargets(activeTargets);
  let graphifyHookRepair = { changed: false, count: 0, path: null };
  if (normalizedTargets.includes("claude") || normalizedTargets.includes("all")) {
    graphifyHookRepair = sanitizeGraphifyWindowsHooks(
      join(targetDir, ".claude", "settings.json"),
    );
    if (graphifyHookRepair.changed) {
      ok(t.graphifyHooksRepaired(
        graphifyHookRepair.count,
        targetDir,
        graphifyHookRepair.backup,
      ));
    }
  }
  quickDeployDir = quickDeployDir || targetDir;
  quickDeployDirs = uniqueProjectDeployDirs([...quickDeployDirs, targetDir]);

  console.log(`${C.green}${C.bold}✓ ${t.npxQuickDone}${C.reset}`);
  console.log(`${C.dim}  ${targetDir}${C.reset}`);
  printPostCopyBootstrapHint();
  console.log("");
  return { ...bootstrapResult, graphifyHookRepair };
}

async function runQuickDeploy() {
  heading(t.npxQuickHeading);

  const platformId = await askQuickPlatform();
  const targetDir = await askTargetDirectory();

  if (existsSync(targetDir)) {
    console.log(`${C.dim}  ${t.npxQuickDirExists}${C.reset}`);
  } else {
    mkdirSync(targetDir, { recursive: true });
  }

  console.log(`${C.dim}  ${t.npxQuickCreating} ${targetDir}${C.reset}`);

  // Run normal install to PROJECT_DIR first (generates runtime files)
  const runtimes = await detectRuntimes();

  // npm install deps
  await withProgress(t.progressNpmInstall, async () => {
    if (
      existsSync(join(PROJECT_DIR, "node_modules", "@modelcontextprotocol"))
    ) {
      return true;
    }
    info(t.runningNpm);
    const result = spawnCliSync("npm", ["install"], {
      cwd: PROJECT_DIR,
      stdio: "inherit",
    });
    return result.status === 0;
  });

  // Clean up legacy skill files before sync
  await withProgress(t.progressCleanupLegacy, () => {
    const n = cleanupLegacySkills("project");
    if (n > 0) ok(`Cleaned ${n} legacy file(s)`);
    return true;
  });

  // Sync runtimes to PROJECT_DIR
  await withProgress(t.progressSyncConfig, async () => {
    const configResult = await autoConfigure("project");
    return !!configResult;
  });

  // Copy platform files to target directory
  await withProgress(t.npxQuickCopyFiles, async () => {
    assertNoProjectBootstrapConflicts(buildProjectBootstrapPlan([platformId], targetDir));
    const count = deployPlatformFiles(platformId, targetDir);
    quickDeployDir = targetDir;
    quickDeployDirs = uniqueProjectDeployDirs([targetDir]);
    return count > 0;
  });

  // Install global skills
  await withProgress(t.progressPrepareDir, async () => {
    if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true });
    ok(t.globalDirReady(SKILLS_DIR));
    return true;
  });

  await withProgress(t.progressInstallSkills, async () => {
    const localOverrides = await loadLocalOverrides();
    const proxyEnv = localOverrides.gitProxy
      ? { META_KIM_GIT_PROXY: localOverrides.gitProxy }
      : {};
    const targets = platformId === "all" ? "claude" : platformId;
    const installResult = runNodeScript(
      SETUP_NODE_CHILD.GLOBAL_SKILLS_INSTALLER,
      buildGlobalSkillsInstallerArgs({
        targets,
        skillIds: [],
        preferLocalDependencies,
      }),
      proxyEnv,
    );
    return installResult.status === 0;
  });

  await withProgress(t.progressSyncMeta, () => {
    const targets = platformId === "all" ? "claude" : platformId;
    const syncResult = runNodeScript(
      SETUP_NODE_CHILD.GLOBAL_META_THEORY_SYNC,
      metaTheoryGlobalSyncArgs(targets),
    );
    return syncResult.status === 0;
  });

  console.log("");
  console.log(`${C.green}${C.bold}✓ ${t.npxQuickDone}${C.reset}`);
  console.log(`${C.dim}  ${targetDir}${C.reset}`);
  printPostCopyBootstrapHint();
  console.log("");

  showNextSteps(runtimes, platformId === "all" ? detectedTargetIds(runtimes) : [platformId]);
}

// ── Install scope selection ─────────────────────────────

/**
 * Ask user where to install: global reusable capabilities or project directory updates.
 * Returns: 'project' | 'global'
 */
async function askInstallScope() {
  const scopeArgIndex = args.indexOf("--scope");
  const explicitScope = scopeArgIndex >= 0 ? args[scopeArgIndex + 1] : null;
  const configuredDefault = silentMode
    ? DISTRIBUTION.installDefaults.silentScope
    : DISTRIBUTION.installDefaults.interactiveScope;
  if (explicitScope || silentMode) {
    const selected = explicitScope || configuredDefault;
    const pickedLabel =
      selected === "project"
        ? t.installScopeProjectLabel
        : t.installScopeGlobalLabel;
    info(t.selectedScope(pickedLabel));
    return selected;
  }

  heading(t.installScopeHeading);

  const scopeDefinitions = [
    {
      id: "global",
      label: t.installScopeGlobalLabel,
      desc: t.installScopeGlobalDesc,
    },
    {
      id: "project",
      label: t.installScopeProjectLabel,
      desc: t.installScopeProjectDesc,
    },
  ];
  const scopes = [
    ...scopeDefinitions.filter((scope) => scope.id === configuredDefault),
    ...scopeDefinitions.filter((scope) => scope.id !== configuredDefault),
  ];

  const idx = await keyboardSelect(
    t.installScopePrompt,
    scopes.map((s) => ({
      ...s,
      label: `${s.label}  ${C.dim}${s.desc}${C.reset}`,
    })),
  );

  const selected = scopes[idx]?.id || configuredDefault;
  const pickedLabel =
    {
      project: t.installScopeProjectLabel,
      global: t.installScopeGlobalLabel,
    }[selected] || selected;
  info(t.selectedScope(pickedLabel));

  // Show selected scope detail
  const detailKey =
    {
      project: "installScopeProjectDescDetail",
      global: "installScopeGlobalDescDetail",
    }[selected];
  if (t[detailKey]) {
    console.log("");
    console.log(`${C.green}${C.bold}▸ ${pickedLabel}${C.reset}`);
    const detailLines = t[detailKey].split("\n");
    for (const line of detailLines) {
      if (line.startsWith("•")) {
        console.log(`${C.dim}  ${line}${C.reset}`);
      } else if (line.trim()) {
        console.log(`${C.dim}  ${line.trim()}${C.reset}`);
      }
    }
    console.log("");
  }

  return selected;
}

// ── Directory structure explanation ─────────────────────────────

function showDirectoryExplanation() {
  console.log("");
  console.log(`${C.bold}${C.cyan}● ${t.directoryExplanationHeading}${C.reset}`);
  console.log("");
  console.log(`${C.dim}${t.directoryExplanationIntro}${C.reset}`);
  console.log("");

  // Project-level
  console.log(`${C.bold}${t.directoryExplanationProject}${C.reset}`);
  const projectLines = t.directoryExplanationProjectDetail.split("\n");
  for (const line of projectLines) {
    if (line.startsWith("•")) {
      console.log(`${C.dim}•${C.reset} ${line.slice(1).trim()}`);
    } else if (line.trim()) {
      console.log(`${C.dim}  ${line.trim()}${C.reset}`);
    }
  }
  console.log("");

  // Global-level
  console.log(`${C.bold}${t.directoryExplanationGlobal}${C.reset}`);
  const globalLines = t.directoryExplanationGlobalDetail.split("\n");
  for (const line of globalLines) {
    if (line.startsWith("•")) {
      console.log(`${C.dim}•${C.reset} ${line.slice(1).trim()}`);
    } else if (line.trim()) {
      console.log(`${C.dim}  ${line.trim()}${C.reset}`);
    }
  }
}

// ── Global install guidance ─────────────────────────────

async function ensureGlobalSkillsDir() {
  if (existsSync(SKILLS_DIR)) {
    ok(t.globalDirReady(SKILLS_DIR));
    return true;
  }

  const promptLines = t.globalDirPrompt.split("\n");
  console.log("");
  console.log(`${C.bold}${t.globalDirTitle}${C.reset}`);
  console.log("");
  console.log(`${promptLines[0]}`);
  console.log(`${C.dim}•${C.reset} ${promptLines[1].split("— ")[1]}`);
  console.log(`${C.dim}•${C.reset} ${promptLines[2].split("— ")[1]}`);
  console.log(`${C.dim}•${C.reset} ${promptLines[3].split("— ")[1]}`);
  console.log("");

  const shouldInstall = await askYesNo(t.globalInstallPrompt, true);
  if (!shouldInstall) {
    skip(t.globalSkipped);
    return false;
  }

  try {
    mkdirSync(SKILLS_DIR, { recursive: true });
    ok(t.globalDirCreated(SKILLS_DIR));
    return true;
  } catch (err) {
    fail(t.globalDirCreateFailed(err.message));
    return false;
  }
}

// ── Dependency verification ─────────────────────────────
// NOTE: This function is currently NOT used in the main install/update flow.
// It checks if global skills are installed in ~/.claude/skills/.
// Consider using it for pre-flight validation or remove if not needed.
// Usage: call checkDependencies() before installAllSkills() to verify state.

function checkDependencies() {
  heading(t.depCheckHeading);
  let verified = 0;

  for (const skill of SKILLS) {
    const dir = join(SKILLS_DIR, skill.name);
    if (!existsSync(dir)) {
      fail(t.depMissing(skill.name));
      continue;
    }
    // Check for at least one .md file (SKILL.md or any .md)
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    if (files.length === 0) {
      warn(t.depNoFiles(skill.name));
      continue;
    }
    ok(t.depOk(skill.name));
    verified++;
  }

  console.log();
  if (verified === SKILLS.length) {
    info(t.depSummaryAll);
  } else {
    warn(t.depSummarySome(verified, SKILLS.length));
  }
  return verified === SKILLS.length;
}

// ── Cross-runtime sync verification ─────────────────────

function openclawWorkspaceMdComplete(wsPath) {
  return OPENCLAW_WORKSPACE_MD.every((name) => existsSync(join(wsPath, name)));
}

function metaKimRuntimeNotice(mcpPath) {
  if (!existsSync(mcpPath)) return null;
  try {
    const config = JSON.parse(readFileSync(mcpPath, "utf8"));
    const server = config.mcpServers?.["meta-kim-runtime"];
    if (!server) return null;
    const scriptPath = server.args?.[0];
    if (!scriptPath) return t.mcpRuntimeProjectOnly(mcpPath);
    if (
      scriptPath.includes("__REPO_ROOT__") ||
      scriptPath.includes("REPLACE_WITH_REPO_ROOT")
    ) {
      return t.mcpRuntimeProjectOnly(mcpPath);
    }
    const resolvedScript = isAbsolute(scriptPath)
      ? scriptPath
      : join(PROJECT_DIR, scriptPath);
    if (!existsSync(resolvedScript)) return t.mcpRuntimeProjectOnly(mcpPath);
    return null;
  } catch {
    return null;
  }
}

function checkSync(
  runtimes,
  repoTargets = RUNTIME_CHOICES.map(({ id }) => id),
) {
  heading(t.syncHeading);
  let allOk = true;

  // --- Claude Code ---
  if (repoTargets.includes("claude")) {
    const claudeAgentsDir = join(PROJECT_DIR, ".claude", "agents");
    if (existsSync(claudeAgentsDir)) {
      const summary = summarizeExpectedFiles(
        readdirSync(claudeAgentsDir).filter((f) => f.endsWith(".md")),
        expectedAgentProjectionFiles(".md"),
      );
      if (summary.missing.length === 0)
        ok(t.syncClaudeAgents(summary.presentCount, META_AGENTS.length));
      else {
        warn(
          t.syncPartial(
            "Claude agents",
            `${summary.presentCount}/${META_AGENTS.length}`,
            `missing: ${summary.missing.join(", ")}`,
          ),
        );
        allOk = false;
      }
    } else {
      fail(t.syncMissing(".claude/agents/"));
      allOk = false;
    }

    const claudeSkillPath = join(
      PROJECT_DIR,
      ".claude",
      "skills",
      "meta-theory",
      "SKILL.md",
    );
    if (existsSync(claudeSkillPath)) ok(t.syncClaudeSkills);
    else {
      fail(t.syncMissing(".claude/skills/meta-theory/SKILL.md"));
      allOk = false;
    }

    ok(t.syncClaudeProjectHooksMigrated);

    if (existsSync(join(PROJECT_DIR, ".claude", "settings.json")))
      ok(t.syncClaudeSettings);
    else {
      warn(t.syncMissing(".claude/settings.json"));
      allOk = false;
    }

    const claudeMcp = join(PROJECT_DIR, ".mcp.json");
    if (existsSync(claudeMcp)) {
      ok(t.syncClaudeMcp);
      const notice = metaKimRuntimeNotice(claudeMcp);
      if (notice) warn(notice);
    } else {
      warn(t.syncMissing(".mcp.json"));
      allOk = false;
    }
  }

  // --- Codex ---
  if (repoTargets.includes("codex")) {
    console.log("");
    const codexAgentsDir = join(PROJECT_DIR, ".codex", "agents");
    const expectedCodexAgentFiles = expectedAgentProjectionFiles(".toml", [
      ...META_AGENTS,
      ...CODEX_RUNTIME_ADAPTER_AGENT_IDS,
      ...CODEX_BUSINESS_ROLE_AGENT_IDS,
    ]);
    if (existsSync(codexAgentsDir)) {
      const summary = summarizeExpectedFiles(
        readdirSync(codexAgentsDir).filter((f) => f.endsWith(".toml")),
        expectedCodexAgentFiles,
      );
      if (summary.missing.length === 0)
        ok(t.syncCodexAgents(summary.presentCount, expectedCodexAgentFiles.length));
      else {
        warn(
          t.syncPartial(
            "Codex agents",
            `${summary.presentCount}/${expectedCodexAgentFiles.length}`,
            `missing: ${summary.missing.join(", ")}`,
          ),
        );
        allOk = false;
      }
    } else {
      fail(t.syncMissing(".codex/agents/"));
      allOk = false;
    }

    const codexSkillPath = join(
      PROJECT_DIR,
      ".agents",
      "skills",
      "meta-theory",
      "SKILL.md",
    );
    if (existsSync(codexSkillPath)) {
      ok(t.syncCodexSkillsGlobal ?? t.syncCodexSkills);
    } else {
      fail(t.syncMissing(".agents/skills/meta-theory/SKILL.md"));
      allOk = false;
    }
  }

  // --- OpenClaw ---
  if (repoTargets.includes("openclaw")) {
    console.log("");
    const workspacesRoot = join(PROJECT_DIR, "openclaw", "workspaces");
    const wsDirs = existsSync(workspacesRoot)
      ? readdirSync(workspacesRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [];
    const wsSummary = summarizeExpectedFiles(wsDirs, META_AGENTS);
    const wsCount = wsSummary.presentCount;
    const completeAgents = META_AGENTS.filter((id) =>
      openclawWorkspaceMdComplete(join(workspacesRoot, id)),
    ).length;
    if (
      wsCount === META_AGENTS.length &&
      completeAgents === META_AGENTS.length
    ) {
      ok(t.syncOpenclawWorkspaces(wsCount, META_AGENTS.length));
    } else {
      warn(
        t.syncPartial(
          "OpenClaw workspaces",
          `${completeAgents}/${META_AGENTS.length} agents with 9 core .md`,
          wsSummary.missing.length > 0
            ? `missing: ${wsSummary.missing.join(", ")}`
            : `${META_AGENTS.length} agents, 9 .md each (BOOT … TOOLS)`,
        ),
      );
      allOk = false;
    }
  }

  // --- Cursor ---
  if (repoTargets.includes("cursor")) {
    console.log("");
    const cursorAgentsDir = join(PROJECT_DIR, ".cursor", "agents");
    if (existsSync(cursorAgentsDir)) {
      const summary = summarizeExpectedFiles(
        readdirSync(cursorAgentsDir).filter((f) => f.endsWith(".md")),
        expectedAgentProjectionFiles(".md"),
      );
      if (summary.missing.length === 0)
        ok(t.syncCursorAgents(summary.presentCount, META_AGENTS.length));
      else {
        warn(
          t.syncPartial(
            "Cursor agents",
            `${summary.presentCount}/${META_AGENTS.length}`,
            `missing: ${summary.missing.join(", ")}`,
          ),
        );
        allOk = false;
      }
    } else {
      fail(t.syncMissing(".cursor/agents/"));
      allOk = false;
    }

    const cursorSkillPath = join(
      PROJECT_DIR,
      ".cursor",
      "skills",
      "meta-theory",
      "SKILL.md",
    );
    if (existsSync(cursorSkillPath)) ok(t.syncCursorSkills);
    else {
      fail(t.syncMissing(".cursor/skills/meta-theory/SKILL.md"));
      allOk = false;
    }

    const cursorMcp = join(PROJECT_DIR, ".cursor", "mcp.json");
    if (existsSync(cursorMcp)) {
      ok(t.syncCursorMcp);
      const notice = metaKimRuntimeNotice(cursorMcp);
      if (notice) warn(notice);
    } else {
      warn(t.syncMissing(".cursor/mcp.json"));
      allOk = false;
    }
  }

  console.log();
  if (allOk) info(t.syncOk);
  return allOk;
}

// ── Step 1: Pre-flight checks ───────────────────────────

function preflight() {
  heading(t.preflightHeading);
  let passed = true;

  const nodeVer = process.versions.node;
  if (isSupportedNodeVersion(nodeVer)) ok(t.nodeOk(nodeVer));
  else {
    fail(t.nodeOld(nodeVer));
    passed = false;
  }

  const npmVer = run("npm --version");
  if (npmVer) ok(t.npmVerOk(npmVer));
  else {
    fail(t.npmNotFound);
    passed = false;
  }

  const gitVer = run("git --version");
  if (gitVer) ok(`${gitVer}`);
  else {
    fail(t.gitNotFound);
    passed = false;
  }

  if (PROXY) info(t.proxyInfo(PROXY));
  if (existsSync(join(PROJECT_DIR, "package.json"))) ok(t.pkgFound);
  else {
    fail(t.pkgNotFound);
    passed = false;
  }

  return passed;
}

// ── Step 2: Runtime detection ───────────────────────────

async function detectRuntimes() {
  heading(t.stepRuntime);
  const runtimes = {
    claude: false,
    codex: false,
    openclaw: false,
    cursor: false,
  };

  const claudeVer = detectCli("claude");
  if (claudeVer) {
    ok(t.claudeDetected(claudeVer));
    runtimes.claude = true;
  } else warn(t.claudeNotDetected);

  const codexVer = detectCli("codex");
  if (codexVer) {
    ok(t.codexDetected(codexVer));
    runtimes.codex = true;
  } else skip(t.codexNotDetected);

  const openclawVer = detectCli("openclaw") || detectCli("oc");
  if (openclawVer) {
    ok(t.openclawDetected(openclawVer));
    runtimes.openclaw = true;
  } else skip(t.openclawNotDetected);

  const cursorVer = detectCli("cursor");
  if (cursorVer) {
    ok(t.cursorDetected(cursorVer));
    runtimes.cursor = true;
  } else skip(t.cursorNotDetected);

  if (
    !runtimes.claude &&
    !runtimes.codex &&
    !runtimes.openclaw &&
    !runtimes.cursor
  ) {
    console.log("");
    console.log(`${C.yellow}⚠ ${t.noRuntime}${C.reset}`);
    console.log(`${C.dim}${t.noRuntimeHint1}${C.reset}`);
    console.log(
      `${C.dim}${fmt(t.noRuntimeHint2, {
        claudeCodeDocs: DISTRIBUTION.documentation.claudeCode,
      })}${C.reset}`,
    );
    console.log("");
    const proceed = await askYesNo(t.continueAnyway, false);
    if (!proceed) {
      console.log("");
      console.log(`${C.dim}${t.setupCancelled}${C.reset}`);
      console.log("");
      process.exit(0);
    }
  }

  return runtimes;
}

function detectedTargetIds(runtimes) {
  return RUNTIME_CHOICES.filter((choice) => runtimes[choice.id]).map(
    (choice) => choice.id,
  );
}

async function selectActiveTargets(runtimes) {
  const { cliTargets, defaultTargets } = await resolveTargetContext(args);
  const localOverrides = await loadLocalOverrides();

  if (cliTargets.length > 0) {
    await writeLocalOverrides({ ...localOverrides, activeTargets: cliTargets });
    info(t.activeRuntimesSavedCli(cliTargets.join(", ")));
    return cliTargets;
  }

  const chosenTargets = await askMultiSelectTargets(
    t.selectRuntimeTargets,
    RUNTIME_CHOICES,
    defaultTargets,
  );

  await writeLocalOverrides({
    ...localOverrides,
    activeTargets: chosenTargets,
  });
  info(t.savedActiveTargets(chosenTargets.join(", ")));

  if (!chosenTargets.includes("claude")) {
    console.log("");
    info(t.selectedRuntimeCapabilityHeading);
    for (const target of chosenTargets) {
      const capability = t.selectedRuntimeCapabilities[target];
      if (capability) console.log(`${C.dim}  • ${capability}${C.reset}`);
    }
    console.log(`${C.dim}  ${t.selectedRuntimeCapabilityBoundary}${C.reset}`);
    console.log("");
  }

  return chosenTargets;
}

function rememberProjectProjectionMode(targetDirs) {
  let ok = true;
  for (const targetDir of uniqueProjectDeployDirs(targetDirs)) {
    const relPath = ".meta-kim/local.overrides.json";
    const current = readJsonObjectIfExists(join(targetDir, relPath)) ?? {};
    const result = writeProjectManagedTransaction(
      targetDir,
      relPath,
      `${JSON.stringify({ ...current, projectProjectionMode: "project" }, null, 2)}\n`,
      "project-projection-mode",
    );
    if (!result.ok) ok = false;
  }
  return ok;
}

function runNodeScript(
  childId,
  extraArgs = [],
  envOverrides = {},
) {
  const spawnConfig = buildSetupNodeChildSpawn(
    process.execPath,
    PROJECT_DIR,
    childId,
    extraArgs,
    currentLangCode,
  );
  const mergedOptions = {
    ...spawnConfig.options,
    env: {
      ...process.env,
      ...envOverrides,
      META_KIM_VERSION: readPackageVersion(),
    },
  };
  return spawnSync(spawnConfig.command, spawnConfig.args, mergedOptions);
}

let lastGlobalCapabilityInventoryResult = true;

function refreshGlobalCapabilityInventory(activeTargets = []) {
  info(t.refreshGlobalCapabilityInventory);
  const targetArgs =
    Array.isArray(activeTargets) && activeTargets.length > 0
      ? ["--runtime-inventory-only", "--targets", activeTargets.join(",")]
      : ["--runtime-inventory-only"];
  const result = runNodeScript(SETUP_NODE_CHILD.CAPABILITY_DISCOVERY, targetArgs, {
    META_KIM_LANG: currentLangCode,
  });
  if (result.status === 0) {
    lastGlobalCapabilityInventoryResult = true;
    ok(t.globalCapabilityInventoryRefreshed);
    return true;
  }
  lastGlobalCapabilityInventoryResult = false;
  warn(t.globalCapabilityInventoryFailed);
  return false;
}

function refreshRuntimeExecutableBindings(activeTargets, installScope, deployDirs = []) {
  const selected = activeTargets.filter((target) => ["claude", "codex"].includes(target));
  if (selected.length === 0) return true;
  try {
    const roots = resolveSetupRuntimeLaunchInventoryRoots({
      installScope,
      deployments: deployDirs,
      homeRoot: homedir(),
      callerCwd: CALLER_CWD,
    });
    recordSetupRuntimeExecutableBindings({
      roots,
      profile: resolveProfileName(process.env.META_KIM_PROFILE),
      targets: selected,
    });
    return true;
  } catch (error) {
    warn(`Runtime executable binding failed: ${error.message}`);
    return false;
  }
}

function metaTheoryGlobalSyncArgs(targets, withGlobalHooks = false) {
  return buildGlobalMetaTheorySyncArgs({ targets, withGlobalHooks });
}

function formatRuntimeTargetLabels(targets) {
  const labels = new Map(RUNTIME_CHOICES.map((choice) => [choice.id, choice.label]));
  return targets.map((target) => labels.get(target) || target).join(", ");
}

function syncOwnedGlobalRuntimeAssets(
  targets,
  runtimeProfiles,
  withGlobalHooks = false,
) {
  const selectedTargets = [];
  const selectedAssetTypes = new Set();
  for (const targetId of targets) {
    const profile = runtimeProfiles[targetId];
    if (!profile) {
      throw new Error(`Missing runtime profile for selected target: ${targetId}`);
    }
    let targetSelected = false;
    for (const assetType of profile.projection.assetTypes) {
      if (assetType === "hooks" && !withGlobalHooks) continue;
      if (
        globalProjectionIsOwnedBy(
          profile,
          assetType,
          GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
        )
      ) {
        selectedAssetTypes.add(assetType);
        targetSelected = true;
      }
    }
    if (targetSelected) selectedTargets.push(targetId);
  }
  if (selectedTargets.length === 0 || selectedAssetTypes.size === 0) return true;
  const syncResult = runNodeScript(SETUP_NODE_CHILD.RUNTIME_SYNC, [
    "--scope",
    "global",
    "--targets",
    selectedTargets.join(","),
    "--global-assets",
    [...selectedAssetTypes].sort().join(","),
  ]);
  return syncResult.status === 0;
}

// Returns { ok: boolean, missing: string[], stale: string[] } for the global
// Meta_Kim hooks dir. Used by global hook migration and sync checks.
function checkGlobalHooksCompleteness(hooksDir) {
  const missing = [];
  const stale = [];
  if (!existsSync(hooksDir)) {
    return { ok: false, missing: GLOBAL_HOOK_PACKAGE_FILES_LIST, stale: [] };
  }
  for (const fileName of GLOBAL_HOOK_PACKAGE_FILES_LIST) {
    if (!existsSync(join(hooksDir, fileName))) {
      missing.push(fileName);
    }
  }
  let entries = [];
  try {
    entries = readdirSync(hooksDir);
  } catch {
    return { ok: missing.length === 0, missing, stale };
  }
  for (const entry of entries) {
    if (
      entry.endsWith(".mjs") &&
      !GLOBAL_HOOK_PACKAGE_FILES_LIST.includes(entry)
    ) {
      stale.push(entry);
    }
  }
  return { ok: missing.length === 0 && stale.length === 0, missing, stale };
}

// Migrate the global Meta_Kim hooks dir: back up + remove files that no
// longer match the canonical whitelist, while preserving user-authored files.
async function migrateGlobalMetaKimHooksDir(hooksDir) {
  const result = { removed: [], kept: [], backupDir: null, status: "noop" };
  if (!existsSync(hooksDir)) return result;
  let entries = [];
  try {
    entries = await fs.readdir(hooksDir);
  } catch {
    return result;
  }
  const metaKimFiles = entries.filter(
    (e) =>
      e.endsWith(".mjs") &&
      GLOBAL_HOOK_PACKAGE_FILES_LIST.includes(e) === false,
  );
  if (metaKimFiles.length === 0) {
    result.status = "clean";
    return result;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = `${hooksDir}.meta-kim.bak-${ts}`;
  let confirmed = false;
  if (silentMode || checkMode) {
    confirmed = true;
  } else {
    info(t.globalHooksMigrationHeading);
    info(t.globalHooksMigrationFound(metaKimFiles.length));
    info(t.globalHooksMigrationListed(metaKimFiles));
    const remaining = entries.filter((e) => !metaKimFiles.includes(e));
    if (remaining.length > 0) {
      info(t.globalHooksMigrationKept(remaining));
    }
    confirmed = await askYesNo(
      t.globalHooksMigrationConfirm(metaKimFiles.length),
      false,
    );
  }
  if (!confirmed) {
    result.status = "skipped";
    warn(t.globalHooksMigrationSkipped);
    return result;
  }
  await fs.mkdir(backupDir, { recursive: true });
  for (const fileName of metaKimFiles) {
    try {
      await fs.copyFile(join(hooksDir, fileName), join(backupDir, fileName));
      await fs.unlink(join(hooksDir, fileName));
      result.removed.push(fileName);
    } catch (error) {
      if (error.code !== "ENOENT") {
        warn(
          `[Meta_Kim] Failed to migrate ${fileName}: ${error.message}`,
        );
      }
    }
  }
  result.backupDir = backupDir;
  result.kept = entries.filter((e) => !metaKimFiles.includes(e));
  result.status = "migrated";
  if (!silentMode) {
    info(t.globalHooksMigrationBackedUp(backupDir));
    info(t.globalHooksMigrationDone(result.removed.length));
  }
  return result;
}

// ── Legacy skill file cleanup ────────────────────────────
// Precise removal of old single-file skill format that was replaced
// by directory format (meta-theory.md → meta-theory/SKILL.md).

const LEGACY_PROJECT_PATHS = [
  join(PROJECT_DIR, ".claude", "skills", "meta-theory.md"),
  join(PROJECT_DIR, ".codex", "skills", "meta-theory.md"),
  join(PROJECT_DIR, ".codex", "skills", "references"),
  join(PROJECT_DIR, ".codex", "skills", "meta-theory"),
  join(PROJECT_DIR, "openclaw", "skills", "meta-theory.md"),
  join(PROJECT_DIR, "openclaw", "skills", "references"),
  join(PROJECT_DIR, ".cursor", "skills", "meta-theory.md"),
];

const LEGACY_GLOBAL_PATHS = [
  {
    id: "claude",
    file: join(homedir(), ".claude", "skills", "meta-theory.md"),
  },
  {
    id: "codex",
    file: join(homedir(), ".codex", "skills", "meta-theory.md"),
    dir: join(homedir(), ".codex", "skills", "references"),
  },
  {
    id: "openclaw",
    file: join(homedir(), ".openclaw", "skills", "meta-theory.md"),
    dir: join(homedir(), ".openclaw", "skills", "references"),
  },
  {
    id: "cursor",
    file: join(homedir(), ".cursor", "skills", "meta-theory.md"),
  },
];

function cleanupLegacySkills(scope = "project") {
  let cleaned = 0;

  if (scope === "project") {
    for (const p of LEGACY_PROJECT_PATHS) {
      if (!existsSync(p)) continue;
      try {
        rmSync(p, { recursive: true, force: true });
        cleaned++;
      } catch {
        // Best-effort: locked or permission-denied is non-fatal
      }
    }
  }

  if (scope === "global") {
    for (const { file, dir } of LEGACY_GLOBAL_PATHS) {
      for (const p of [file, dir]) {
        if (!existsSync(p)) continue;
        try {
          rmSync(p, { recursive: true, force: true });
          cleaned++;
        } catch {
          // Best-effort
        }
      }
    }
  }

  return cleaned;
}

// ── Step 3: Auto-configure project files ────────────────

async function autoConfigure(installScope = "project", activeTargets = []) {
  const syncArgs = ["--scope", installScope];
  if (activeTargets.length > 0) {
    syncArgs.push("--targets", activeTargets.join(","));
  }
  const syncResult = runNodeScript(SETUP_NODE_CHILD.RUNTIME_SYNC, syncArgs);
  if (syncResult.status === 0) {
    ok(t.okRepoSynced);
    return true;
  }
  fail(t.failRepoSync);
  return false;
}

// ── Step 4: npm install + skills ────────────────────────

function installDeps() {
  if (existsSync(join(PROJECT_DIR, "node_modules", "@modelcontextprotocol"))) {
    if (!updateMode) {
      skip(t.nodeModulesExist);
      return true;
    }
  }
  info(t.runningNpm);
  const result = spawnCliSync("npm", ["install"], {
    cwd: PROJECT_DIR,
    stdio: "inherit",
  });
  if (result.status === 0) {
    ok(t.npmDone);
    return true;
  }
  fail(t.npmFailed);
  return false;
}

function installSkill(skill) {
  const target = join(SKILLS_DIR, skill.name);
  const proxy = gitProxyArgs();

  if (existsSync(target)) {
    if (updateMode) {
      if (skill.subdir) {
        rmSync(target, { recursive: true, force: true });
      } else {
        const pullResult = run(`git ${proxy} pull --ff-only`.trim(), {
          cwd: target,
        });
        if (pullResult !== null) {
          ok(t.skillUpdated(skill.name));
          return true;
        }
        // ff-only failure: don't delete the existing skill, just warn and skip
        warn(t.skillUpdateFailed(skill.name));
        return true;
      }
    } else {
      skip(t.skillExists(skill.name));
      return true;
    }
  }

  if (skill.subdir) return installSkillFromSubdir(skill, target, proxy);

  const url = skill.repoUrl;
  const cloneResult = run(
    `git ${proxy} clone --depth 1 "${url}" "${target}"`.trim(),
  );
  if (cloneResult !== null) {
    ok(t.skillInstalled(skill.name));
    return true;
  }
  fail(t.skillFailed(skill.name, skill.repo));
  return false;
}

function installSkillFromSubdir(skill, target, proxy) {
  const url = skill.repoUrl;
  const tmp = join(tmpdir(), `meta-kim-skill-${Date.now()}`);
  try {
    const cloneResult = run(
      `git ${proxy} clone --depth 1 --filter=blob:none --sparse "${url}" "${tmp}"`.trim(),
    );
    if (cloneResult === null) {
      fail(t.skillFailed(skill.name, "clone failed"));
      return false;
    }
    const checkoutResult = run(`git sparse-checkout set "${skill.subdir}"`, {
      cwd: tmp,
    });
    if (checkoutResult === null) {
      fail(t.skillSubdirNotFound(skill.name));
      return false;
    }
    const src = join(tmp, skill.subdir);
    if (!existsSync(src)) {
      fail(t.skillSubdirNotFound(skill.name));
      return false;
    }
    mkdirSync(target, { recursive: true });
    cpSync(src, target, { recursive: true });
    ok(t.skillSubdirInstalled(skill.name, skill.subdir));
    return true;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// NOTE: This function is currently NOT used in the main install flow.
// Skills installation is now handled by scripts/install-global-skills-all-runtimes.mjs
// which is called from runInstall(). This function is kept for reference
// or potential future use cases where direct skill installation is needed.
async function installAllSkills() {
  heading(t.stepSkills);
  if (!silentMode) {
    console.log(`${C.dim}${t.shipsSkills(SKILLS.length)}${C.reset}`);
    SKILLS.forEach((s) => console.log(`${C.dim}•${C.reset} ${s.name}`));
    console.log();
  }
  installDeps();
  mkdirSync(SKILLS_DIR, { recursive: true });
  let installed = 0,
    failed = 0;
  for (const skill of SKILLS) {
    if (installSkill(skill)) installed++;
    else failed++;
  }
  console.log();
  info(t.skillsReady(installed, SKILLS.length, failed));
  return failed === 0;
}

// ── Step 4.5: Optional Python tools (graphify) ─────────

function checkPython310() {
  return detectPython310(spawnSync, platform(), {
    requirePip: true,
    bootstrapPip: true,
  });
}

// graphify platform name → graphify install command
const GRAPHIFY_PLATFORM_MAP = {
  claude: "claude",
  codex: "codex",
  openclaw: "claw",
  cursor: "cursor",
};

function expandGraphifyTargets(activeTargets) {
  const targets = Array.isArray(activeTargets) ? activeTargets : [activeTargets];
  if (targets.includes("all")) return Object.keys(GRAPHIFY_PLATFORM_MAP);
  return targets;
}

/**
 * Attempt to auto-download and install Python 3.10+.
 * Returns the Python object on success, null on failure or user decline.
 */
async function downloadAndInstallPython() {
  const p = platform();
  if (silentMode) return null;

  const answer = await askYesNo(t.pythonNotFoundOfferInstall, true);
  if (!answer) {
    info(t.pythonHint);
    return null;
  }

  if (p === "win32") {
    // Try winget first (most reliable on Windows 10/11)
    const wingetCheck = spawnSync("winget", ["--version"], {
      encoding: "utf8",
    });
    const wingetAvailable = wingetCheck.status === 0;

    if (wingetAvailable) {
      info(t.pythonInstallWinget);
      console.log(`${C.dim}  ${t.pythonInstallWingetHint}${C.reset}`);
      const result = spawnCliSync(
        "winget",
        [
          "install",
          "--id",
          "Python.Python.3.11",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ],
        { stdio: "inherit" },
      );
      // winget returns non-zero for "package already installed, no upgrade
      // available" and for genuine failures alike — re-run detection either
      // way so an already-installed Python (that just isn't on PATH) is not
      // reported as "winget unavailable".
      const newPython = checkPython310();
      if (newPython) {
        if (result.status === 0) ok(t.pythonInstallSuccess);
        return newPython;
      }
      // Python still not found. Differentiate "winget ran but PATH needs
      // refresh" from "winget could not install".
      if (result.status === 0) {
        warn(
          t.pythonInstallNotSupported(
            "Windows (restart shell to pick up PATH)",
          ),
        );
      } else {
        warn(t.pythonInstallNotSupported("Windows (winget install failed)"));
      }
      info(t.pythonHint);
      return null;
    }

    // winget not available at all
    warn(t.pythonInstallNotSupported("Windows (winget unavailable)"));
    info(t.pythonHint);
    return null;
  } else if (p === "darwin") {
    warn(t.pythonInstallNotSupported("macOS"));
    info(
      `Run: brew install python@3.11  ${C.dim}(or python3.12 if preferred)${C.reset}`,
    );
    return null;
  } else {
    warn(t.pythonInstallNotSupported(p));
    info(
      `Run: sudo apt install python3.11  ${C.dim}(or your distro's package manager)${C.reset}`,
    );
    return null;
  }
}

async function installPythonTools(
  activeTargets,
  inUpdateMode = false,
  targetDir = PROJECT_DIR,
  options = {},
) {
  heading(t.stepPythonTools);
  const projectWiring = options.projectWiring !== false;
  const graphifyDir = resolve(targetDir);
  let python = checkPython310();
  if (!python) {
    python = await downloadAndInstallPython();
    if (!python) return false;
  }

  // Check if graphify already installed via pip show (more reliable than --version)
  const pipShow = runPythonModule(python, ["-m", "pip", "show", "graphifyy"]);
  if (pipShow.status === 0) {
    const version =
      extractPipShowVersion(readProcessText(pipShow)) ?? "unknown";
    if (inUpdateMode) {
      // Upgrade in update mode
      info(t.graphifyUpgrading);
      const upgradeResult = runPythonModule(
        python,
        ["-m", "pip", "install", "--upgrade", "graphifyy"],
        undefined,
        { stdio: "pipe" },
      );
      if (upgradeResult.status !== 0) {
        const stderr = readProcessText(upgradeResult);
        warn(t.graphifyUpgradeFailed);
        if (stderr) {
          console.log(`${C.dim}${t.pipErrorDetail(stderr)}${C.reset}`);
        }
        return false;
      }
      const newVersion =
        extractPipShowVersion(readProcessText(upgradeResult)) ?? version;
      ok(t.graphifyUpgraded(newVersion));
    } else {
      ok(t.graphifyAlreadyInstalled(version));
    }
  } else {
    // Install graphify
    info(t.graphifyInstalling);
    const installResult = runPythonModule(
      python,
      ["-m", "pip", "install", "graphifyy"],
      undefined,
      { stdio: "pipe" },
    );
    if (installResult.status !== 0) {
      const stderr = readProcessText(installResult);
      warn(t.graphifyInstallFailed);
      if (stderr) {
        console.log(`${C.dim}${t.pipErrorDetail(stderr)}${C.reset}`);
      }
      return false;
    }
    ok(t.graphifyInstalled);
  }

  // Ensure networkx >= 3.4 for louvain_communities(max_level) compatibility
  ensureNetworkxCompatibility(python);

  // Relocate only Graphify hooks that already exist. This also repairs a
  // stale user-level Claude hook during global-only install/update without
  // creating a new global hook.
  const graphifyExecutable = resolveGraphifyExecutable(python, spawnSync);
  if (platform() === "win32" && graphifyExecutable) {
    const reconciliation = reconcileExistingGraphifyWindowsHooks(
      [
        join(graphifyDir, ".claude", "settings.json"),
        join(homedir(), ".claude", "settings.json"),
      ],
      graphifyExecutable,
    );
    for (const sanitized of reconciliation) {
      if (sanitized.changed) {
        ok(
          `Rewrote ${sanitized.count} graphify hook command(s) to direct-spawn form (backup: ${sanitized.backup})`,
        );
      }
    }
  }

  if (!projectWiring) {
    skip(t.graphifyProjectWiringSkipped);
    return true;
  }

  let wiringOk = true;

  // Idempotent wiring: register graphify skill for each active target + git hooks once.
  // git hooks are cross-platform (commit/checkout trigger), install once.
  // If the repo wasn't cloned via git (e.g. extracted from a zip), `.git` won't
  // exist and `graphify hook install` has nowhere to write — that's not a real
  // failure, just a no-op environment. Skip cleanly instead of alarming the user.
  if (!existsSync(join(graphifyDir, ".git"))) {
    info(
      "Skipping graphify git hook (not a git repository — run `git init` or clone via git to enable auto-rebuild)",
    );
  } else {
    const hookResult = runPythonModule(
      python,
      ["-m", "graphify", "hook", "install"],
      undefined,
      { cwd: graphifyDir, stdio: "pipe" },
    );
    if (hookResult.status === 0) {
      ok(t.graphifyHookInstalled);
    } else {
      wiringOk = false;
      warn(t.graphifyHookFailed);
      const hookStdout = readProcessText(hookResult);
      const hookStderr = (hookResult.stderr || "").toString().trim();
      if (hookStdout) {
        console.log(`${C.dim}stdout: ${hookStdout}${C.reset}`);
      }
      if (hookStderr) {
        console.log(`${C.dim}stderr: ${hookStderr}${C.reset}`);
      }
      if (hookResult.error?.message) {
        console.log(
          `${C.dim}spawn error: ${hookResult.error.message}${C.reset}`,
        );
      }
    }
  }

  // Register graphify skill for each active platform
  for (const target of expandGraphifyTargets(activeTargets)) {
    const platform = GRAPHIFY_PLATFORM_MAP[target];
    if (!platform) continue;
    info(t.graphifySkillRegistering(platform));
    const skillResult = runPythonModule(
      python,
      ["-m", "graphify", platform, "install"],
      undefined,
      { cwd: graphifyDir, stdio: "pipe" },
    );
    if (skillResult.status === 0) {
      ok(t.graphifySkillRegistered(platform));
    } else {
      wiringOk = false;
      warn(t.graphifySkillFailed(platform));
    }
  }

  // graphify's upstream installer writes Windows shell-form hook commands that
  // Git Bash mangles; rewrite them to direct-spawn form after every graphify
  // install/upgrade so the hook is executable on Windows.
  if (platform() === "win32" && graphifyExecutable) {
    const sanitized = sanitizeGraphifyWindowsHooks(
      join(graphifyDir, ".claude", "settings.json"),
      { graphifyExecutable },
    );
    if (sanitized.changed) {
      ok(
        `Rewrote ${sanitized.count} graphify hook command(s) to direct-spawn form (backup: ${sanitized.backup})`,
      );
    }
  }

  const rebuildResult = runPythonModule(
    python,
    ["-m", "graphify", "update", "."],
    undefined,
    { cwd: graphifyDir, stdio: "pipe" },
  );
  if (rebuildResult.status === 0) {
    ok(t.graphifyCodeGraphGenerated);
    return wiringOk;
  } else {
    warn(t.graphifyCodeGraphGenerationFailed);
    const rebuildOutput = readProcessText(rebuildResult);
    if (rebuildOutput) {
      console.log(`${C.dim}${rebuildOutput}${C.reset}`);
    }
    return false;
  }
}

// ── Step 4.6: Optional MCP Memory Service (Layer 3) ─────

// Python resolution strategy for MCP Memory Service.
// The upstream package depends on safetensors, which often fails to build on
// Python 3.13. We prefer 3.11/3.12; if the detected Python is outside that
// range, we try to build an isolated venv locked to 3.12.
//
// NOTE: detectPython310() returns a launcher descriptor, not a string:
//   { command: string, args: string[], version: { major, minor, patch }, versionText }
// All helpers below consume and return the same shape so they integrate
// cleanly with runPythonModule(python, args) and formatPythonLauncher(python).

function isSupportedMemoryPython(pythonLauncher) {
  const v = pythonLauncher?.version;
  if (!v || typeof v.major !== "number" || typeof v.minor !== "number") {
    return false;
  }
  return v.major === 3 && v.minor >= 11 && v.minor <= 12;
}

function probePythonLauncher(command, args, spawnFn = spawnSync) {
  try {
    const result = spawnFn(command, [...args, "--version"], {
      encoding: "utf8",
      shell: false,
    });
    if (result?.error || result?.status !== 0) return null;
    const versionText = readProcessText(result);
    const m = /Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(versionText || "");
    if (!m) return null;
    return {
      command,
      args: [...args],
      version: {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3] || 0),
      },
      versionText: (versionText || "").trim(),
    };
  } catch {
    return null;
  }
}

function findPython311Or312(spawnFn = spawnSync) {
  const isWin = platform() === "win32";
  const candidates = isWin
    ? [
        ["py", ["-3.12"]],
        ["py", ["-3.11"]],
        ["python3.12", []],
        ["python3.11", []],
      ]
    : [
        ["python3.12", []],
        ["python3.11", []],
        ["py", ["-3.12"]],
        ["py", ["-3.11"]],
      ];

  for (const [command, args] of candidates) {
    const probe = probePythonLauncher(command, args, spawnFn);
    if (probe && isSupportedMemoryPython(probe)) {
      return probe;
    }
  }
  return null;
}

function venvPythonPath(venvDir) {
  const isWin = platform() === "win32";
  return isWin
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}

function createMemoryServiceVenv(sourceLauncher, venvDir, spawnFn = spawnSync) {
  if (!sourceLauncher) return null;
  try {
    const parent = dirname(venvDir);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    const result = spawnFn(
      sourceLauncher.command,
      [...sourceLauncher.args, "-m", "venv", venvDir],
      { encoding: "utf8", shell: false, stdio: "inherit" },
    );
    if (result.status !== 0) return null;

    const venvPython = venvPythonPath(venvDir);
    if (!existsSync(venvPython)) return null;

    const probed = probePythonLauncher(venvPython, [], spawnFn);
    if (!probed) return null;
    return { ...probed, absolutePath: true };
  } catch {
    return null;
  }
}

function resolvePythonForMemoryService(detectedPython) {
  if (isSupportedMemoryPython(detectedPython)) {
    return { python: detectedPython, venvCreated: false };
  }

  const detectedLabel = detectedPython?.versionText || "unknown";
  warn(
    `Detected ${detectedLabel} — mcp-memory-service prefers Python 3.11/3.12 (safetensors may fail on 3.13).`,
  );

  const venvDir = join(homedir(), ".meta-kim", "memory-venv");
  const existingVenvPython = venvPythonPath(venvDir);
  if (existsSync(existingVenvPython)) {
    const existingProbe = probePythonLauncher(existingVenvPython, []);
    if (existingProbe && isSupportedMemoryPython(existingProbe)) {
      ok(`Reusing existing venv: ${venvDir}`);
      return {
        python: { ...existingProbe, absolutePath: true },
        venvCreated: false,
        venvDir,
      };
    }
  }

  info("Attempting to create an isolated venv locked to Python 3.11/3.12...");
  const sourceLauncher = findPython311Or312();
  if (!sourceLauncher) {
    warn(
      "No Python 3.11/3.12 launcher found — falling back to detected Python (install may fail).",
    );
    info(
      platform() === "win32"
        ? "Install Python 3.12 from python.org, or run: winget install Python.Python.3.12"
        : "Install Python 3.12 via your package manager (e.g. apt/brew/pyenv).",
    );
    return { python: detectedPython, venvCreated: false, fallback: true };
  }

  const venvLauncher = createMemoryServiceVenv(sourceLauncher, venvDir);
  if (!venvLauncher) {
    warn(
      "Failed to create 3.12 venv — falling back to detected Python (install may fail).",
    );
    return { python: detectedPython, venvCreated: false, fallback: true };
  }

  ok(`Created venv at ${venvDir}`);
  return { python: venvLauncher, venvCreated: true, venvDir };
}

async function runMcpMemoryHookInstaller(
  activeTargets = RUNTIME_CHOICES.map(({ id }) => id),
  { allowClaudeGlobalSettings = false } = {},
) {
  const hookScript = join(
    PROJECT_DIR,
    "scripts",
    "install-mcp-memory-hooks.mjs",
  );
  if (!existsSync(hookScript)) {
    warn(`Hook installer missing: ${hookScript}`);
    return false;
  }

  const spawnDesc = buildNodeScriptSpawn(
    process.execPath,
    PROJECT_DIR,
    "scripts/install-mcp-memory-hooks.mjs",
    ["--targets", activeTargets.join(",")],
  );
  const childEnv =
    allowClaudeGlobalSettings && activeTargets.includes("claude")
      ? { ...process.env, META_KIM_CONFIRM_GLOBAL: "1" }
      : undefined;
  let result;
  await withProgress(
    t.mcpMemoryHookInstalling(formatRuntimeTargetLabels(activeTargets)),
    async () => {
    result = spawnSync(spawnDesc.command, spawnDesc.args, {
      ...spawnDesc.options,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      ...(childEnv ? { env: childEnv } : {}),
    });
    },
  );

  if (result.status === 0) {
    ok(t.mcpMemoryHookInstalled);
    return true;
  } else {
    warn(t.mcpMemoryHookWarnings);
    const stdoutText = (result.stdout || "").trim();
    const stderrText = (result.stderr || "").trim();
    if (stdoutText) {
      console.log(`${C.dim}${stdoutText}${C.reset}`);
    }
    if (stderrText) {
      console.log(`${C.dim}${stderrText}${C.reset}`);
    }
    return false;
  }
}

function checkMcpMemoryService(python) {
  const result = runPythonModule(python, [
    "-m",
    "pip",
    "show",
    "mcp-memory-service",
  ]);
  if (result.status !== 0) {
    return { installed: false, version: null };
  }
  const versionMatch = (result.stdout || "").match(/Version:\s*(.+)/i);
  return {
    installed: true,
    version: versionMatch ? versionMatch[1].trim() : null,
  };
}

function activeMemoryRuntimeStatePath() {
  return join(homedir(), ".meta-kim", "mcp-memory-active-runtime.json");
}

function readActiveMemoryRuntimeState() {
  try {
    return JSON.parse(readFileSync(activeMemoryRuntimeStatePath(), "utf8"));
  } catch {
    return null;
  }
}

function writeActiveMemoryRuntimeState({ resolved, memoryBin, databasePath }) {
  writeJsonAtomic(activeMemoryRuntimeStatePath(), {
    schemaVersion: "meta-kim-mcp-memory-active-runtime-v1",
    runtimeDir: resolved.venvDir ?? dirname(dirname(memoryBin)),
    pythonPath: resolved.python?.command ?? resolved.python,
    memoryBin,
    databasePath,
    activatedAt: new Date().toISOString(),
  });
  return true;
}

function findMemoryBinPath(resolved, { preferActive = true } = {}) {
  const plat = platform();
  const binName = plat === "win32" ? "memory.exe" : "memory";

  if (preferActive) {
    const active = readActiveMemoryRuntimeState();
    if (active?.memoryBin && isAbsolute(active.memoryBin) && existsSync(active.memoryBin)) {
      try {
        return realpathSync(active.memoryBin);
      } catch {}
    }
  }

  // Strategy 0: prefer the dedicated meta-kim memory venv that setup provisions
  // for this service. Resolving via resolved.python can land on an unrelated
  // system interpreter whose memory build lacks required native extensions
  // (e.g. SQLite-vec loadable extension support), which then fails to start
  // under --http. Always try the purpose-built venv first.
  // Strategy 1: resolve python executable, then check nearby directories
  let pythonCmd = resolved.python.command || resolved.python;
  if (
    !/\//.test(pythonCmd) &&
    !/\\/.test(pythonCmd) &&
    !/[A-Za-z]:/.test(pythonCmd)
  ) {
    try {
      const launcher = resolved.python;
      const result = spawnSync(
        launcher.command,
        [...launcher.args, "-c", "import sys; print(sys.executable)"],
        { encoding: "utf8", shell: false },
      );
      if (result.status === 0 && result.stdout.trim()) {
        pythonCmd = result.stdout.trim();
      }
    } catch {}
  }
  const pythonDir = dirname(pythonCmd);

  const sameDir = join(pythonDir, binName);
  if (existsSync(sameDir)) return sameDir;

  if (plat === "win32") {
    const scriptsDir = join(pythonDir, "Scripts", binName);
    if (existsSync(scriptsDir)) return scriptsDir;
  }

  const binDir = join(pythonDir, "..", "bin", binName);
  if (existsSync(binDir)) return resolve(binDir);

  const venvMemoryBin =
    plat === "win32"
      ? join(homedir(), ".meta-kim", "memory-venv", "Scripts", binName)
      : join(homedir(), ".meta-kim", "memory-venv", "bin", binName);
  if (existsSync(venvMemoryBin)) return venvMemoryBin;

  // Strategy 2: search system PATH (handles cross-install pip --user case)
  const whichCmd = plat === "win32" ? "where" : "which";
  try {
    const result = spawnCliSync(whichCmd, [binName], {
      encoding: "utf8",
    });
    if (result.status === 0 && result.stdout.trim()) {
      const found = result.stdout.trim().split(/\r?\n/)[0];
      if (found && existsSync(found)) return found;
    }
  } catch {}

  return null;
}

function buildMcpMemoryServerConfig(
  resolved,
  {
    memoryBinOverride = null,
    preferActive = true,
    databasePathOverride = null,
  } = {},
) {
  const memoryBin = memoryBinOverride ?? findMemoryBinPath(resolved, { preferActive });
  const databasePath = resolveMcpMemoryDatabasePathWithRuntime(resolved.python, {
    preferredPath: databasePathOverride ?? readActiveMemoryRuntimeState()?.databasePath ?? null,
  });
  if (!databasePath) throw new Error("MCP Memory database path could not be runtime-verified");
  if (memoryBin) {
    return {
      command: memoryBin,
      args: ["server"],
      env: { MCP_MEMORY_SQLITE_PATH: databasePath },
    };
  }
  const python = resolved.python;
  return {
    command: python.command,
    args: [...python.args, "-m", "mcp_memory_service.server"],
    env: { MCP_MEMORY_SQLITE_PATH: databasePath },
  };
}

function isLegacyMcpMemoryServerConfig(config) {
  return (
    Array.isArray(config?.args) &&
    config.args.includes("-m") &&
    config.args.includes("mcp_memory_service")
  );
}

function registerMcpMemoryServer({
  mcpPath,
  memoryServerConfig,
  fileExists = existsSync,
  readText = readFileSync,
  writeText = writeFileSync,
  isLegacy = isLegacyMcpMemoryServerConfig,
  onRegistered = () => {},
  onExisting = () => {},
  onFailure = () => {},
}) {
  try {
    if (fileExists(mcpPath)) {
      const mcpConfig = JSON.parse(readText(mcpPath, "utf8"));
      const existingMemoryConfig = mcpConfig.mcpServers?.["mcp-memory-service"];
      if (
        existingMemoryConfig &&
        !isLegacy(existingMemoryConfig) &&
        JSON.stringify(existingMemoryConfig) === JSON.stringify(memoryServerConfig)
      ) {
        onExisting();
        return true;
      }
      const nextConfig = {
        ...mcpConfig,
        mcpServers: {
          ...(mcpConfig.mcpServers ?? {}),
          "mcp-memory-service": memoryServerConfig,
        },
      };
      writeText(mcpPath, JSON.stringify(nextConfig, null, 2) + "\n");
      onRegistered();
      return true;
    }

    const newConfig = {
      mcpServers: {
        "mcp-memory-service": memoryServerConfig,
      },
    };
    writeText(mcpPath, JSON.stringify(newConfig, null, 2) + "\n");
    onRegistered();
    return true;
  } catch (error) {
    onFailure(error);
    return false;
  }
}

async function startMcpMemoryServiceBackground(
  resolved,
  endpoint = resolveMemoryEndpoint(),
  {
    memoryBinOverride = null,
    databasePathOverride = null,
    lockAlreadyHeld = false,
    configureBootOnHealthy = true,
    writeActiveStateOnHealthy = true,
    extraEnv = {},
  } = {},
) {
  if (!endpoint.canAutoStart) {
    info(t.mcpMemoryRemoteEndpointNoAutoStart(endpoint.endpointUrl));
    return true;
  }
  const memoryBin = memoryBinOverride ?? findMemoryBinPath(resolved);
  if (!memoryBin) {
    warn(t.mcpMemoryAutoStartFailed);
    info(t.mcpMemoryAutoStartManual);
    return false;
  }
  const activeDatabasePath = readActiveMemoryRuntimeState()?.databasePath;
  const databasePath = resolveMcpMemoryDatabasePathWithRuntime(resolved.python, {
    preferredPath: databasePathOverride ?? activeDatabasePath ?? null,
  });
  if (!databasePath) {
    warn(t.mcpMemoryAutoStartFailed);
    return false;
  }

  info(t.mcpMemoryAutoStarting);
  const env = memoryServiceEnv(
    endpoint,
    buildInitialMemoryServiceEnv({
      ...process.env,
      ...extraEnv,
      MCP_MEMORY_SQLITE_PATH: databasePath,
    }),
  );
  const { logDir, stdoutLog, stderrLog } = firstStartLogPaths(homedir());
  mkdirSync(logDir, { recursive: true });
  const start = async () => {
      let childState = {
        spawnError: null,
        exited: false,
        exitCode: null,
        signal: null,
      };
      let stdoutFd;
      let stderrFd;
      try {
        stdoutFd = openSync(stdoutLog, "a");
        stderrFd = openSync(stderrLog, "a");
        const child = spawn(memoryBin, memoryServerHttpArgs(endpoint), {
          env,
          detached: true,
          stdio: ["ignore", stdoutFd, stderrFd],
          windowsHide: true,
        });
        childState = observeMemoryServiceChild(child);
        child.unref();
      } catch (error) {
        childState.spawnError = error;
      } finally {
        if (stdoutFd !== undefined) closeSync(stdoutFd);
        if (stderrFd !== undefined) closeSync(stderrFd);
      }
      const healthResult = await waitForMcpMemoryHealth({
        probeHealth: () => probeMcpMemoryHealth(endpoint.healthUrl),
        childState,
        allowLauncherExit: true,
      });
      return { ok: healthResult.healthy, started: true, healthResult };
  };
  const lockResult = lockAlreadyHeld
    ? await start()
    : await withEndpointStartLock({
      endpoint,
      lockRoot: join(homedir(), ".meta-kim", "locks"),
      probeHealth: () => probeMcpMemoryHealth(endpoint.healthUrl),
      start,
    });
  const healthResult = lockResult.reason === "already_healthy_after_lock"
    ? { healthy: true, reason: lockResult.reason }
    : lockResult.healthResult ?? { healthy: false, reason: lockResult.reason };

  if (healthResult.healthy) {
    ok(t.mcpMemoryAutoStarted(endpoint.endpointUrl));
    if (configureBootOnHealthy) {
      const bootOk = configureBootAutoStart(memoryBin, endpoint, { databasePath });
      if (bootOk) ok(t.mcpMemoryAutoStartBoot);
      else warn(t.mcpMemoryAutoStartBootFailed);
    }
    if (writeActiveStateOnHealthy) {
      writeActiveMemoryRuntimeState({ resolved, memoryBin, databasePath });
    }
    return true;
  }

  warn(t.mcpMemoryAutoStartFailed);
  info(t.mcpMemoryAutoStartManual);
  info(`  ${stdoutLog}`);
  info(`  ${stderrLog}`);
  try {
    appendFileSync(
      stderrLog,
      `[${new Date().toISOString()}] ${t.mcpMemoryAutoStartFailureMessage(endpoint.healthUrl)}\nreason=${healthResult.reason}\n`,
      "utf8",
    );
  } catch {}
  return false;
}

function findMemoryHealthProbePython(memoryBin) {
  if (platform() === "win32") return null;
  for (const candidate of [
    join(dirname(memoryBin), "python"),
    join(dirname(memoryBin), "python3"),
  ]) {
    if (isAbsolute(candidate) && existsSync(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {}
    }
  }
  try {
    const firstLine = readFileSync(memoryBin, "utf8").split(/\r?\n/, 1)[0];
    const shebang = firstLine.match(/^#!\s*(\/\S*python(?:\d+(?:\.\d+)*)?)\s*$/u)?.[1];
    if (shebang && existsSync(shebang)) return realpathSync(shebang);
  } catch {}
  return null;
}

function memoryProcessIdentityExpectation(memoryBin) {
  if (platform() === "win32") {
    const expected = resolveWindowsVenvProcessExpectation(memoryBin);
    return {
      platformName: "win32",
      expectedExecutablePath: expected?.expectedExecutablePath ?? null,
      expectedExecutablePaths: expected?.expectedExecutablePaths ?? [],
      expectedLauncherPath: expected?.expectedLauncherPath ?? null,
    };
  }
  return {
    platformName: platform(),
    expectedExecutablePath: findMemoryHealthProbePython(memoryBin),
    expectedLauncherPath: memoryBin,
  };
}

function verifyEndpointRuntimeIdentity(endpoint, memoryBin) {
  const expected = memoryProcessIdentityExpectation(memoryBin);
  if (!expected.expectedExecutablePath) return false;
  const identity = inspectEndpointListener(endpoint);
  return verifyMemoryListenerIdentity(identity, {
    platform: expected.platformName,
    executablePath: expected.expectedExecutablePath,
    executablePaths: expected.expectedExecutablePaths,
    launcherPath: expected.expectedLauncherPath,
    host: endpoint.hostname,
    port: endpoint.port,
  }).verified;
}

function configureBootAutoStart(
  memoryBin,
  endpoint = resolveMemoryEndpoint(),
  { databasePath = readActiveMemoryRuntimeState()?.databasePath ?? null } = {},
) {
  if (!endpoint.canAutoStart) return false;
  if (!databasePath || !isAbsolute(databasePath)) return false;
  const plat = platform();
  const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const psSingleQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const xmlEscape = (value) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  const bootEnv = buildBootMemoryServiceEnv();
  const startLockPath = join(
    homedir(),
    ".meta-kim",
    "locks",
    endpointStartLockName(endpoint),
  );
  mkdirSync(dirname(startLockPath), { recursive: true });
  const pythonProbeBin = plat === "win32"
    ? null
    : findMemoryHealthProbePython(memoryBin);
  if (plat !== "win32" && !pythonProbeBin) return false;
  const failureMessage = t.mcpMemoryAutoStartFailureMessage(endpoint.healthUrl);
  const posixOwnerReadProbe = shellQuote(
    "import json,sys; o=json.load(open(sys.argv[1],encoding='utf-8-sig')); print(str(o.get('ownerPid',''))+'\\t'+str(o.get('ownerStartIdentity',''))+'\\t'+str(o.get('expiresAt','')))",
  );
  const posixOwnerTokenProbe = shellQuote(
    "import json,sys; o=json.load(open(sys.argv[1],encoding='utf-8-sig')); print(str(o.get('token','')))",
  );
  const posixLockAcquire =
    `LOCK_DIR=${shellQuote(startLockPath)}\n` +
    `LOCK_TOKEN="$$-$(date +%s)-\${RANDOM:-0}"\n` +
    `LOCK_ACQUIRED=0\n` +
    `read_start_identity() {\n` +
    `  if [ -r "/proc/$1/stat" ]; then sed 's/^[^)]*) //' "/proc/$1/stat" | awk '{print $20}'; else ps -o lstart= -p "$1" 2>/dev/null | sed 's/^[[:space:]]*//'; fi\n` +
    `}\n` +
    `if mkdir "$LOCK_DIR" 2>/dev/null; then LOCK_ACQUIRED=1; else\n` +
    `  check_health && exit 0\n` +
    `LOCK_NOW=$(( $(date +%s) * 1000 ))\n` +
    `  OWNER_PID=; OWNER_START=; OWNER_EXPIRES=\n` +
    `  if [ -f "$LOCK_DIR/owner.json" ]; then\n` +
    `    OWNER_FIELDS=$("$PYTHON_BIN" -c ${posixOwnerReadProbe} "$LOCK_DIR/owner.json" 2>/dev/null || true)\n` +
    `    OWNER_PID=$(printf '%s' "$OWNER_FIELDS" | cut -f1); OWNER_START=$(printf '%s' "$OWNER_FIELDS" | cut -f2); OWNER_EXPIRES=$(printf '%s' "$OWNER_FIELDS" | cut -f3)\n` +
    `  fi\n` +
    `  OWNER_ALIVE=0\n` +
    `  if [ -n "$OWNER_PID" ] && kill -0 "$OWNER_PID" 2>/dev/null && [ "$(read_start_identity "$OWNER_PID")" = "$OWNER_START" ]; then OWNER_ALIVE=1; fi\n` +
    `  OWNER_EXPIRED=0\n` +
    `  if [ -n "$OWNER_EXPIRES" ]; then [ "$OWNER_EXPIRES" -le "$LOCK_NOW" ] 2>/dev/null && OWNER_EXPIRED=1; else\n` +
    `    LOCK_MTIME=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)\n` +
    `    [ $(( LOCK_NOW - LOCK_MTIME * 1000 )) -ge 360000 ] && OWNER_EXPIRED=1\n` +
    `  fi\n` +
    `  if [ "$OWNER_ALIVE" -eq 0 ] && [ "$OWNER_EXPIRED" -eq 1 ]; then\n` +
    `    STALE_DIR="$LOCK_DIR.stale.$LOCK_TOKEN"\n` +
    `    if mv "$LOCK_DIR" "$STALE_DIR" 2>/dev/null && mkdir "$LOCK_DIR" 2>/dev/null; then LOCK_ACQUIRED=1; rm -rf -- "$STALE_DIR"; fi\n` +
    `  fi\n` +
    `  if [ "$LOCK_ACQUIRED" -ne 1 ]; then printf '%s\\n' "$MSG" >>"$LOG_PATH"; exit 1; fi\n` +
    `fi\n` +
    `LOCK_START_IDENTITY=$(read_start_identity $$)\n` +
    `LOCK_NOW=$(( $(date +%s) * 1000 ))\n` +
    `LOCK_EXPIRES=$(( LOCK_NOW + 360000 ))\n` +
    `printf '{"schemaVersion":"meta-kim-mcp-memory-start-lock-v1","token":"%s","ownerPid":%s,"ownerStartIdentity":"%s","acquiredAt":%s,"expiresAt":%s}\\n' "$LOCK_TOKEN" "$$" "$LOCK_START_IDENTITY" "$LOCK_NOW" "$LOCK_EXPIRES" >"$LOCK_DIR/owner.json"\n` +
    `if check_health; then LOCK_OWNER_TOKEN=$("$PYTHON_BIN" -c ${posixOwnerTokenProbe} "$LOCK_DIR/owner.json" 2>/dev/null || true); [ "$LOCK_OWNER_TOKEN" = "$LOCK_TOKEN" ] && rm -rf -- "$LOCK_DIR"; exit 0; fi\n`;
  const posixLockRelease =
    `LOCK_OWNER_TOKEN=$("$PYTHON_BIN" -c ${posixOwnerTokenProbe} "$LOCK_DIR/owner.json" 2>/dev/null || true)\n` +
    `[ "$LOCK_OWNER_TOKEN" = "$LOCK_TOKEN" ] && rm -rf -- "$LOCK_DIR"\n`;
  try {
    if (plat === "win32") {
      const startupDir = join(
        homedir(),
        "AppData",
        "Roaming",
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup",
      );
      if (!existsSync(startupDir)) return false;
      const metaKimDir = join(homedir(), ".meta-kim");
      mkdirSync(metaKimDir, { recursive: true });
      const psPath = join(metaKimDir, "mcp-memory-start.ps1");
      const cmdPath = join(metaKimDir, "mcp-memory-start.cmd");
      const vbsPath = join(startupDir, "mcp-memory-silent.vbs");
      const legacyCmdPath = join(startupDir, "mcp-memory-start.cmd");
      if (existsSync(legacyCmdPath)) rmSync(legacyCmdPath, { force: true });
      const escapedMemoryBin = memoryBin.replace(/'/g, "''");
      const psHealthUrl = psSingleQuote(endpoint.healthUrl);
      const psEndpointUrl = psSingleQuote(endpoint.endpointUrl);
      const psPort = psSingleQuote(endpoint.port);
      writeUtf8BomFileSync(
        psPath,
        `$ErrorActionPreference = "SilentlyContinue"\r\n` +
          `$env:MCP_ALLOW_ANONYMOUS_ACCESS = "${bootEnv.MCP_ALLOW_ANONYMOUS_ACCESS}"\r\n` +
          `$env:HF_HUB_OFFLINE = "${bootEnv.HF_HUB_OFFLINE}"\r\n` +
          `$env:TRANSFORMERS_OFFLINE = "${bootEnv.TRANSFORMERS_OFFLINE}"\r\n` +
          `$env:MCP_MEMORY_ONNX_ALLOW_DOWNLOAD = "${bootEnv.MCP_MEMORY_ONNX_ALLOW_DOWNLOAD}"\r\n` +
          `$env:MCP_MEMORY_ALLOW_HASH_EMBEDDINGS = "${bootEnv.MCP_MEMORY_ALLOW_HASH_EMBEDDINGS}"\r\n` +
          `$env:MCP_MEMORY_USE_ONNX = "${bootEnv.MCP_MEMORY_USE_ONNX}"\r\n` +
          `$env:MCP_MEMORY_SQLITE_PATH = ${psSingleQuote(databasePath)}\r\n` +
          `$env:MCP_MEMORY_URL = ${psEndpointUrl}\r\n` +
          `$env:META_KIM_MEMORY_PORT = ${psPort}\r\n` +
          `$env:MCP_HTTP_HOST = ${psSingleQuote(endpoint.hostname)}\r\n` +
          `$env:MCP_HTTP_PORT = ${psPort}\r\n` +
          `$memoryBin = '${escapedMemoryBin}'\r\n` +
          `$failureMessage = ${psSingleQuote(failureMessage)}\r\n` +
          `$logDir = Join-Path $env:USERPROFILE ".meta-kim"\r\n` +
          `$stdoutLog = Join-Path $logDir "mcp-memory.out.log"\r\n` +
          `$stderrLog = Join-Path $logDir "mcp-memory.err.log"\r\n` +
          `$lockDir = ${psSingleQuote(startLockPath)}\r\n` +
          `$lockAcquired = $false\r\n` +
          `$lockToken = [guid]::NewGuid().ToString("n")\r\n` +
          `function Test-MetaKimMemoryHealth {\r\n` +
          `  try {\r\n` +
          `    $response = Invoke-WebRequest -Uri ${psHealthUrl} -UseBasicParsing -TimeoutSec 3\r\n` +
          `    $payload = $response.Content | ConvertFrom-Json\r\n` +
          `    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300 -and $payload.status -eq "healthy")\r\n` +
          `  } catch { return $false }\r\n` +
          `}\r\n` +
          `function Remove-MetaKimOwnedLock {\r\n` +
          `  try {\r\n` +
          `    $owner = Get-Content -LiteralPath (Join-Path $lockDir "owner.json") -Raw | ConvertFrom-Json\r\n` +
          `    if ([string]$owner.token -eq $lockToken) { Remove-Item -LiteralPath $lockDir -Recurse -Force }\r\n` +
          `  } catch {}\r\n` +
          `}\r\n` +
          `try {\r\n` +
          `  New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null\r\n` +
          `  $lockAcquired = $true\r\n` +
          `  $owner = @{ schemaVersion = "meta-kim-mcp-memory-start-lock-v1"; token = $lockToken; ownerPid = $PID; ownerStartIdentity = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString("o"); acquiredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(6).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress\r\n` +
          `  Set-Content -LiteralPath (Join-Path $lockDir "owner.json") -Value $owner -Encoding UTF8\r\n` +
          `} catch {\r\n` +
          `  try {\r\n` +
          `    $existingOwner = Get-Content -LiteralPath (Join-Path $lockDir "owner.json") -Raw | ConvertFrom-Json\r\n` +
          `    $ownerAlive = $false\r\n` +
          `    try { $ownerProcess = Get-Process -Id ([int]$existingOwner.ownerPid) -ErrorAction Stop; $ownerAlive = ($ownerProcess.StartTime.ToUniversalTime().ToString("o") -eq [string]$existingOwner.ownerStartIdentity) } catch {}\r\n` +
          `    if (-not $ownerAlive -and [int64]$existingOwner.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) {\r\n` +
          `      $staleDir = "$lockDir.stale.$PID"\r\n` +
          `      Move-Item -LiteralPath $lockDir -Destination $staleDir -ErrorAction Stop\r\n` +
          `      New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null\r\n` +
          `      Remove-Item -LiteralPath $staleDir -Recurse -Force\r\n` +
          `      $lockAcquired = $true\r\n` +
          `      $owner = @{ schemaVersion = "meta-kim-mcp-memory-start-lock-v1"; token = $lockToken; ownerPid = $PID; ownerStartIdentity = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString("o"); acquiredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(6).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress\r\n` +
          `      Set-Content -LiteralPath (Join-Path $lockDir "owner.json") -Value $owner -Encoding UTF8\r\n` +
          `    }\r\n` +
          `  } catch {\r\n` +
          `    try {\r\n` +
          `      $lockMtime = [DateTimeOffset]((Get-Item -LiteralPath $lockDir).LastWriteTimeUtc)\r\n` +
          `      $lockAge = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $lockMtime.ToUnixTimeMilliseconds()\r\n` +
          `      if ($lockAge -ge 360000) {\r\n` +
          `        $staleDir = "$lockDir.stale.$PID"\r\n` +
          `        Move-Item -LiteralPath $lockDir -Destination $staleDir -ErrorAction Stop\r\n` +
          `        New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null\r\n` +
          `        Remove-Item -LiteralPath $staleDir -Recurse -Force\r\n` +
          `        $lockAcquired = $true\r\n` +
          `        $owner = @{ schemaVersion = "meta-kim-mcp-memory-start-lock-v1"; token = $lockToken; ownerPid = $PID; ownerStartIdentity = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString("o"); acquiredAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(6).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress\r\n` +
          `        Set-Content -LiteralPath (Join-Path $lockDir "owner.json") -Value $owner -Encoding UTF8\r\n` +
          `      }\r\n` +
          `    } catch {}\r\n` +
          `  }\r\n` +
          `  if (-not $lockAcquired) {\r\n` +
          `    if (Test-MetaKimMemoryHealth) { exit 0 }\r\n` +
          `    Add-Content -LiteralPath $stderrLog -Value $failureMessage -Encoding UTF8\r\n` +
          `    exit 1\r\n` +
          `  }\r\n` +
          `}\r\n` +
          `if (Test-MetaKimMemoryHealth) { Remove-MetaKimOwnedLock; exit 0 }\r\n` +
          `try {\r\n` +
          `  Start-Process -FilePath $memoryBin -ArgumentList @("server", "--http", "--http-host", ${psSingleQuote(endpoint.hostname)}, "--http-port", ${psPort}) -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog\r\n` +
          `} catch {}\r\n` +
          `$healthy = $false\r\n` +
          `for ($i = 0; $i -lt 150; $i++) {\r\n` +
          `  Start-Sleep -Seconds 2\r\n` +
          `  if (Test-MetaKimMemoryHealth) { $healthy = $true; break }\r\n` +
          `}\r\n` +
          `if (-not $healthy) {\r\n` +
          `  Add-Content -LiteralPath $stderrLog -Value $failureMessage -Encoding UTF8\r\n` +
          `}\r\n` +
          `if ($lockAcquired) { Remove-MetaKimOwnedLock }\r\n`,
      );
      writeFileSync(
        cmdPath,
        `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${psPath}"\r\n`,
      );
      writeFileSync(
        vbsPath,
        `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run """${cmdPath}""", 0, False\r\n`,
      );
      return true;
    }
    if (plat === "darwin") {
      const launchDir = join(homedir(), "Library", "LaunchAgents");
      mkdirSync(launchDir, { recursive: true });
      const metaKimDir = join(homedir(), ".meta-kim");
      mkdirSync(metaKimDir, { recursive: true });
      const logPath = join(metaKimDir, "mcp-memory.log");
      const scriptPath = join(metaKimDir, "mcp-memory-start.sh");
      writeFileSync(
        scriptPath,
        `#!/bin/sh\n` +
          `export MCP_ALLOW_ANONYMOUS_ACCESS=${bootEnv.MCP_ALLOW_ANONYMOUS_ACCESS}\n` +
          `export HF_HUB_OFFLINE=${bootEnv.HF_HUB_OFFLINE}\n` +
          `export TRANSFORMERS_OFFLINE=${bootEnv.TRANSFORMERS_OFFLINE}\n` +
          `export MCP_MEMORY_ONNX_ALLOW_DOWNLOAD=${bootEnv.MCP_MEMORY_ONNX_ALLOW_DOWNLOAD}\n` +
          `export MCP_MEMORY_ALLOW_HASH_EMBEDDINGS=${bootEnv.MCP_MEMORY_ALLOW_HASH_EMBEDDINGS}\n` +
          `export MCP_MEMORY_USE_ONNX=${bootEnv.MCP_MEMORY_USE_ONNX}\n` +
          `export MCP_MEMORY_SQLITE_PATH=${shellQuote(databasePath)}\n` +
          `export MCP_MEMORY_URL=${shellQuote(endpoint.endpointUrl)}\n` +
          `export META_KIM_MEMORY_PORT=${shellQuote(endpoint.port)}\n` +
          `export MCP_HTTP_HOST=${shellQuote(endpoint.hostname)}\n` +
          `export MCP_HTTP_PORT=${shellQuote(endpoint.port)}\n` +
          `MEMORY_BIN=${shellQuote(memoryBin)}\n` +
          `PYTHON_BIN=${shellQuote(pythonProbeBin)}\n` +
          `LOG_PATH=${shellQuote(logPath)}\n` +
          `MSG=${shellQuote(failureMessage)}\n` +
          `HEALTH_URL=${shellQuote(endpoint.healthUrl)}\n` +
          `check_health() {\n` +
          `  "$PYTHON_BIN" -c ${shellQuote(PYTHON_MEMORY_HEALTH_PROBE)} "$HEALTH_URL"\n` +
          `}\n` +
          posixLockAcquire +
          `"$MEMORY_BIN" server --http --http-host ${shellQuote(endpoint.hostname)} --http-port ${shellQuote(endpoint.port)} >>"$LOG_PATH" 2>&1 &\n` +
          `healthy=0\n` +
          `i=0\n` +
          `while [ "$i" -lt 150 ]; do\n` +
          `  sleep 2\n` +
          `  if check_health; then healthy=1; break; fi\n` +
          `  i=$((i + 1))\n` +
          `done\n` +
          `[ "$healthy" -eq 1 ] || printf '%s\\n' "$MSG" >>"$LOG_PATH"\n` +
          posixLockRelease,
        { mode: 0o755 },
      );
      writeFileSync(
        join(launchDir, "com.meta-kim.mcp-memory-service.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.meta-kim.mcp-memory-service</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>${xmlEscape(scriptPath)}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>MCP_ALLOW_ANONYMOUS_ACCESS</key><string>true</string>
    <key>HF_HUB_OFFLINE</key><string>${bootEnv.HF_HUB_OFFLINE}</string>
    <key>TRANSFORMERS_OFFLINE</key><string>${bootEnv.TRANSFORMERS_OFFLINE}</string>
    <key>MCP_MEMORY_ONNX_ALLOW_DOWNLOAD</key><string>${bootEnv.MCP_MEMORY_ONNX_ALLOW_DOWNLOAD}</string>
    <key>MCP_MEMORY_ALLOW_HASH_EMBEDDINGS</key><string>${bootEnv.MCP_MEMORY_ALLOW_HASH_EMBEDDINGS}</string>
    <key>MCP_MEMORY_USE_ONNX</key><string>${bootEnv.MCP_MEMORY_USE_ONNX}</string>
    <key>MCP_MEMORY_SQLITE_PATH</key><string>${xmlEscape(databasePath)}</string>
    <key>MCP_MEMORY_URL</key><string>${xmlEscape(endpoint.endpointUrl)}</string>
    <key>META_KIM_MEMORY_PORT</key><string>${xmlEscape(endpoint.port)}</string>
    <key>MCP_HTTP_HOST</key><string>${xmlEscape(endpoint.hostname)}</string>
    <key>MCP_HTTP_PORT</key><string>${xmlEscape(endpoint.port)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>
</dict></plist>`,
      );
      return true;
    }
    // Linux: XDG autostart
    const autoDir = join(homedir(), ".config", "autostart");
    const metaKimDir = join(homedir(), ".meta-kim");
    mkdirSync(autoDir, { recursive: true });
    mkdirSync(metaKimDir, { recursive: true });
    const logPath = join(metaKimDir, "mcp-memory.log");
    const scriptPath = join(metaKimDir, "mcp-memory-start.sh");
    writeFileSync(
      scriptPath,
      `#!/bin/sh\n` +
        `export MCP_ALLOW_ANONYMOUS_ACCESS=${bootEnv.MCP_ALLOW_ANONYMOUS_ACCESS}\n` +
        `export HF_HUB_OFFLINE=${bootEnv.HF_HUB_OFFLINE}\n` +
        `export TRANSFORMERS_OFFLINE=${bootEnv.TRANSFORMERS_OFFLINE}\n` +
        `export MCP_MEMORY_ONNX_ALLOW_DOWNLOAD=${bootEnv.MCP_MEMORY_ONNX_ALLOW_DOWNLOAD}\n` +
        `export MCP_MEMORY_ALLOW_HASH_EMBEDDINGS=${bootEnv.MCP_MEMORY_ALLOW_HASH_EMBEDDINGS}\n` +
        `export MCP_MEMORY_USE_ONNX=${bootEnv.MCP_MEMORY_USE_ONNX}\n` +
        `export MCP_MEMORY_SQLITE_PATH=${shellQuote(databasePath)}\n` +
        `export MCP_MEMORY_URL=${shellQuote(endpoint.endpointUrl)}\n` +
        `export META_KIM_MEMORY_PORT=${shellQuote(endpoint.port)}\n` +
        `export MCP_HTTP_HOST=${shellQuote(endpoint.hostname)}\n` +
        `export MCP_HTTP_PORT=${shellQuote(endpoint.port)}\n` +
        `MEMORY_BIN=${shellQuote(memoryBin)}\n` +
        `PYTHON_BIN=${shellQuote(pythonProbeBin)}\n` +
        `LOG_PATH=${shellQuote(logPath)}\n` +
        `MSG=${shellQuote(failureMessage)}\n` +
        `HEALTH_URL=${shellQuote(endpoint.healthUrl)}\n` +
        `check_health() {\n` +
        `  "$PYTHON_BIN" -c ${shellQuote(PYTHON_MEMORY_HEALTH_PROBE)} "$HEALTH_URL"\n` +
        `}\n` +
        posixLockAcquire +
        `"$MEMORY_BIN" server --http --http-host ${shellQuote(endpoint.hostname)} --http-port ${shellQuote(endpoint.port)} >>"$LOG_PATH" 2>&1 &\n` +
        `healthy=0\n` +
        `i=0\n` +
        `while [ "$i" -lt 150 ]; do\n` +
        `  sleep 2\n` +
        `  if check_health; then healthy=1; break; fi\n` +
        `  i=$((i + 1))\n` +
        `done\n` +
        `[ "$healthy" -eq 1 ] || printf '%s\\n' "$MSG" >>"$LOG_PATH"\n` +
        posixLockRelease,
      { mode: 0o755 },
    );
    writeFileSync(
      join(autoDir, "mcp-memory-service.desktop"),
      `[Desktop Entry]\nType=Application\nName=MCP Memory Service\nExec=/bin/sh "${scriptPath}"\nNoDisplay=true\n`,
    );
    return true;
  } catch {
    return false;
  }
}

function resolveMcpMemoryDatabasePathWithRuntime(python, { preferredPath = null } = {}) {
  const script = [
    "import json",
    "from mcp_memory_service.config import SQLITE_VEC_PATH",
    "print(json.dumps({'path': str(SQLITE_VEC_PATH)}))",
  ].join("\n");
  const databaseEnv = { ...process.env };
  delete databaseEnv.MCP_MEMORY_SQLITE_PATH;
  const result = runPythonModule(python, ["-c", script], undefined, {
    cwd: PROJECT_DIR,
    env: {
      ...databaseEnv,
      ...(preferredPath ? { MCP_MEMORY_SQLITE_PATH: preferredPath } : {}),
    },
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  try {
    const line = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
    const databasePath = JSON.parse(line || "{}").path;
    if (!databasePath || !isAbsolute(databasePath)) return null;
    const confirmedPath = resolve(databasePath);
    const pathKey = (value) => platform() === "win32"
      ? resolve(value).replace(/\\/g, "/").toLowerCase()
      : resolve(value);
    if (preferredPath && pathKey(confirmedPath) !== pathKey(preferredPath)) return null;
    return confirmedPath;
  } catch {
    return null;
  }
}

function snapshotManagedFile(filePath) {
  const existed = existsSync(filePath);
  return {
    filePath,
    existed,
    content: existed ? readFileSync(filePath) : null,
    mode: existed ? statSync(filePath).mode & 0o777 : null,
  };
}

function restoreManagedFile(snapshot) {
  if (snapshot.existed) {
    mkdirSync(dirname(snapshot.filePath), { recursive: true });
    const tempPath = `${snapshot.filePath}.restore-${process.pid}-${Date.now()}.tmp`;
    writeFileSync(tempPath, snapshot.content);
    renameSync(tempPath, snapshot.filePath);
    if (Number.isInteger(snapshot.mode)) {
      try { chmodSync(snapshot.filePath, snapshot.mode); } catch {}
    }
  } else {
    rmSync(snapshot.filePath, { force: true });
  }
  return true;
}

function restoreMcpMemoryServerEntry(mcpPath, snapshot) {
  let current = {};
  if (existsSync(mcpPath)) current = JSON.parse(readFileSync(mcpPath, "utf8"));
  const mcpServers = { ...(current.mcpServers ?? {}) };
  if (snapshot.existed) mcpServers["mcp-memory-service"] = snapshot.entry;
  else delete mcpServers["mcp-memory-service"];
  const next = { ...current };
  if (Object.keys(mcpServers).length > 0) next.mcpServers = mcpServers;
  else delete next.mcpServers;
  if (!snapshot.fileExisted && Object.keys(next).length === 0) {
    rmSync(mcpPath, { force: true });
  } else {
    writeJsonAtomic(mcpPath, next);
  }
  return true;
}

function memoryBootArtifactPaths() {
  const metaKimDir = join(homedir(), ".meta-kim");
  if (platform() === "win32") {
    return [
      join(metaKimDir, "mcp-memory-start.ps1"),
      join(metaKimDir, "mcp-memory-start.cmd"),
      join(homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "mcp-memory-silent.vbs"),
      join(homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "mcp-memory-start.cmd"),
    ];
  }
  if (platform() === "darwin") {
    return [
      join(metaKimDir, "mcp-memory-start.sh"),
      join(homedir(), "Library", "LaunchAgents", "com.meta-kim.mcp-memory-service.plist"),
    ];
  }
  return [
    join(metaKimDir, "mcp-memory-start.sh"),
    join(homedir(), ".config", "autostart", "mcp-memory-service.desktop"),
  ];
}

function pathKeyForRecovery(value) {
  const normalized = resolve(value).replace(/\\/gu, "/");
  return platform() === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInsideRecoveryRoot(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function mcpMemoryRecoveryDigest(payload) {
  const canonical = {
    schemaVersion: payload.schemaVersion,
    transactionId: payload.transactionId,
    oldMemoryBin: pathKeyForRecovery(payload.oldMemoryBin),
    oldPython: payload.oldPython,
    candidateMemoryBin: pathKeyForRecovery(payload.candidateMemoryBin),
    databasePath: pathKeyForRecovery(payload.databasePath),
    databaseExistedBefore: payload.databaseExistedBefore === true,
    mcpPath: pathKeyForRecovery(payload.mcpPath),
    mcpMemoryEntrySnapshot: payload.mcpMemoryEntrySnapshot,
    stateSnapshot: payload.stateSnapshot,
    bootSnapshots: payload.bootSnapshots,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function persistMcpMemoryRecoverySnapshots({
  transactionRoot,
  transactionId,
  oldMemoryBin,
  oldPython,
  candidateMemoryBin,
  databasePath,
  databaseExistedBefore,
  mcpPath,
  mcpMemoryEntrySnapshot,
  stateSnapshot,
  bootSnapshots,
}) {
  if (!MCP_MEMORY_TRANSACTION_ID_PATTERN.test(transactionId)) return { ok: false };
  let trustedTransactionRoot;
  try {
    const metadata = lstatSync(transactionRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return { ok: false };
    trustedTransactionRoot = realpathSync(transactionRoot);
  } catch { return { ok: false }; }
  const recoveryPath = resolve(trustedTransactionRoot, `${transactionId}-recovery.json`);
  if (!isPathInsideRecoveryRoot(trustedTransactionRoot, recoveryPath)) return { ok: false };
  const payload = {
    schemaVersion: "meta-kim-mcp-memory-recovery-v1",
    transactionId,
    oldMemoryBin,
    oldPython: typeof oldPython === "string"
      ? { command: oldPython, args: [] }
      : { command: oldPython.command, args: oldPython.args ?? [] },
    candidateMemoryBin,
    databasePath,
    databaseExistedBefore,
    mcpPath,
    mcpMemoryEntrySnapshot,
    createdAt: new Date().toISOString(),
    stateSnapshot: {
      filePath: stateSnapshot.filePath,
      existed: stateSnapshot.existed,
      contentBase64: stateSnapshot.content ? stateSnapshot.content.toString("base64") : null,
      mode: stateSnapshot.mode,
    },
    bootSnapshots: bootSnapshots.map((snapshot) => ({
      filePath: snapshot.filePath,
      existed: snapshot.existed,
      contentBase64: snapshot.content ? snapshot.content.toString("base64") : null,
      mode: snapshot.mode,
    })),
  };
  const recoveryDigest = mcpMemoryRecoveryDigest(payload);
  writeJsonAtomic(recoveryPath, { ...payload, recoveryDigest });
  return { ok: true, identity: recoveryPath, recoveryDigest };
}

async function recoverIncompleteMcpMemoryTransaction({ transactionRoot, endpoint, resolved }) {
  if (!existsSync(transactionRoot)) return true;
  let trustedTransactionRoot;
  try {
    const metadata = lstatSync(transactionRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
    trustedTransactionRoot = realpathSync(transactionRoot);
  } catch { return false; }
  const rootTrust = verifyPrivateRecoveryRoot({ directoryPath: trustedTransactionRoot });
  if (!rootTrust.ok) return false;
  const evidenceFiles = readdirSync(trustedTransactionRoot)
    .filter((name) => /^update-\d{13}-\d{1,10}\.json$/u.test(name))
    .sort()
    .reverse();
  const incomplete = [];
  for (const evidenceName of evidenceFiles) {
    let evidence;
    try {
      const evidencePath = resolve(trustedTransactionRoot, evidenceName);
      const evidenceMetadata = lstatSync(evidencePath);
      if (
        !isPathInsideRecoveryRoot(trustedTransactionRoot, evidencePath) ||
        !evidenceMetadata.isFile() || evidenceMetadata.isSymbolicLink() || evidenceMetadata.nlink !== 1
      ) continue;
      evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    } catch {
      continue;
    }
    if (
      evidence?.schemaVersion !== "meta-kim-mcp-memory-upgrade-v1" ||
      !MCP_MEMORY_TRANSACTION_ID_PATTERN.test(evidence.transactionId ?? "") ||
      evidenceName !== `${evidence.transactionId}.json` ||
      !["running", "rollback_failed"].includes(evidence.status)
    ) continue;
    const recoveryPath = resolve(trustedTransactionRoot, `${evidence.transactionId}-recovery.json`);
    if (!isPathInsideRecoveryRoot(trustedTransactionRoot, recoveryPath) || !existsSync(recoveryPath)) continue;
    try {
      const recoveryMetadata = lstatSync(recoveryPath);
      if (!recoveryMetadata.isFile() || recoveryMetadata.isSymbolicLink() || recoveryMetadata.nlink !== 1) continue;
    } catch { continue; }
    incomplete.push({ evidenceName, evidence, recoveryPath });
  }
  if (incomplete.length === 0) return true;

  const { evidenceName, evidence, recoveryPath } = incomplete[0];
  let recovery;
  try { recovery = JSON.parse(readFileSync(recoveryPath, "utf8")); } catch { return false; }
  if (
    !Array.isArray(evidence.events) ||
    !recovery || typeof recovery !== "object" || Array.isArray(recovery) ||
    !Array.isArray(recovery.bootSnapshots) ||
    !recovery.stateSnapshot || typeof recovery.stateSnapshot !== "object" ||
    Array.isArray(recovery.stateSnapshot) ||
    !recovery.oldPython || typeof recovery.oldPython !== "object" ||
    !Array.isArray(recovery.oldPython.args)
  ) return false;
  const expectedSnapshotPaths = new Set([
    activeMemoryRuntimeStatePath(),
    ...memoryBootArtifactPaths(),
  ].map(pathKeyForRecovery));
  const isAbsoluteRecoveryPath = (value) => typeof value === "string" && isAbsolute(value);
  const recoveryEvents = evidence.events.filter(({ stage }) => stage === "recovery_snapshots_persisted");
  const recoveryEvent = recoveryEvents[0];
  let calculatedRecoveryDigest;
  try { calculatedRecoveryDigest = mcpMemoryRecoveryDigest(recovery); } catch { return false; }
  const trustedOldMemoryBin = findMemoryBinPath(resolved, { preferActive: false });
  const trustedDatabasePath = resolveMcpMemoryDatabasePathWithRuntime(resolved.python);
  const expectedCandidateRoot = resolve(homedir(), ".meta-kim", "memory-runtimes", evidence.transactionId);
  let trustedCandidateMemoryBin;
  try {
    trustedCandidateMemoryBin = realpathSync(recovery.candidateMemoryBin);
  } catch { return false; }
  const resolvedPython = typeof resolved.python === "string"
    ? { command: resolved.python, args: [] }
    : { command: resolved.python.command, args: resolved.python.args ?? [] };
  const recoveryPython = recovery.oldPython;
  const materialValidation = validateMcpMemoryRecoveryMaterial({
    transactionRoot: trustedTransactionRoot,
    evidenceName,
    transactionId: evidence.transactionId,
    recovery,
    expectedOldMemoryBin: trustedOldMemoryBin,
    expectedPython: resolved.python,
    expectedDatabasePath: trustedDatabasePath,
    expectedCandidateRoot,
    expectedMcpPath: join(PROJECT_DIR, ".mcp.json"),
    expectedSnapshotPaths: [...expectedSnapshotPaths],
    platformName: platform(),
  });
  if (!materialValidation.ok) return false;
  if (
    recovery?.schemaVersion !== "meta-kim-mcp-memory-recovery-v1" ||
    recoveryEvents.length !== 1 ||
    recovery.transactionId !== evidence.transactionId ||
    recovery.recoveryDigest !== calculatedRecoveryDigest ||
    recoveryEvent?.recoveryDigest !== calculatedRecoveryDigest ||
    !isAbsoluteRecoveryPath(recovery.databasePath) ||
    !isAbsoluteRecoveryPath(recovery.oldMemoryBin) ||
    !isAbsoluteRecoveryPath(recovery.candidateMemoryBin) ||
    !isAbsoluteRecoveryPath(recovery.mcpPath) ||
    pathKeyForRecovery(recovery.mcpPath) !== pathKeyForRecovery(join(PROJECT_DIR, ".mcp.json")) ||
    !trustedOldMemoryBin ||
    pathKeyForRecovery(recovery.oldMemoryBin) !== pathKeyForRecovery(realpathSync(trustedOldMemoryBin)) ||
    !trustedDatabasePath ||
    pathKeyForRecovery(recovery.databasePath) !== pathKeyForRecovery(trustedDatabasePath) ||
    !recoveryPython ||
    pathKeyForRecovery(recoveryPython.command) !== pathKeyForRecovery(realpathSync(resolvedPython.command)) ||
    JSON.stringify(recoveryPython.args ?? []) !== JSON.stringify(resolvedPython.args ?? []) ||
    !isPathInsideRecoveryRoot(expectedCandidateRoot, trustedCandidateMemoryBin) ||
    !/[/\\]Scripts[/\\]memory\.exe$/iu.test(trustedCandidateMemoryBin) ||
    ![recovery.stateSnapshot, ...(recovery.bootSnapshots ?? [])]
      .filter(Boolean)
      .every(({ filePath }) => isAbsoluteRecoveryPath(filePath) && expectedSnapshotPaths.has(pathKeyForRecovery(filePath)))
  ) return false;

  const trustedBackupPath = resolve(trustedTransactionRoot, `${evidence.transactionId}-sqlite-backup.db`);
  if (!isPathInsideRecoveryRoot(trustedTransactionRoot, trustedBackupPath)) return false;
  const snapshots = [recovery.stateSnapshot, ...recovery.bootSnapshots];
  const canonicalBase64 = (value) => {
    if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return false;
    return Buffer.from(value, "base64").toString("base64") === value;
  };
  if (
    !snapshots.every((snapshot) => (
      snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) &&
      typeof snapshot.existed === "boolean" &&
      (snapshot.existed ? canonicalBase64(snapshot.contentBase64) : snapshot.contentBase64 === null) &&
      (snapshot.mode === null || (Number.isInteger(snapshot.mode) && snapshot.mode >= 0 && snapshot.mode <= 0o777))
    )) ||
    !recovery.mcpMemoryEntrySnapshot || typeof recovery.mcpMemoryEntrySnapshot !== "object" ||
    typeof recovery.mcpMemoryEntrySnapshot.fileExisted !== "boolean" ||
    typeof recovery.mcpMemoryEntrySnapshot.existed !== "boolean"
  ) return false;

  const backupEvents = evidence.events.filter(({ stage }) => stage === "database_backup_verified");
  if (backupEvents.length !== 1 || !/^[a-f0-9]{64}$/u.test(backupEvents[0].backupContentDigest ?? "")) return false;
  const expectedBackupDigest = backupEvents[0].backupContentDigest;
  if (recovery.databaseExistedBefore === true) {
    let backupMetadata;
    let trustedExistingBackupPath;
    try {
      backupMetadata = lstatSync(trustedBackupPath);
      trustedExistingBackupPath = realpathSync(trustedBackupPath);
    } catch { return false; }
    if (
      !backupMetadata.isFile() || backupMetadata.isSymbolicLink() || backupMetadata.nlink !== 1 ||
      pathKeyForRecovery(trustedExistingBackupPath) !== pathKeyForRecovery(trustedBackupPath) ||
      createHash("sha256").update(readFileSync(trustedExistingBackupPath)).digest("hex") !== expectedBackupDigest ||
      !sqliteQuickCheck({ python: resolved.python, databasePath: trustedExistingBackupPath }).ok
    ) return false;
  } else if (
    recovery.databaseExistedBefore !== false ||
    expectedBackupDigest !== MCP_MEMORY_NO_DATABASE_DIGEST ||
    existsSync(trustedBackupPath)
  ) return false;

  const identityMatches = (listener, memoryBin) => {
    const expected = memoryProcessIdentityExpectation(memoryBin);
    return verifyMemoryListenerIdentity(listener, {
      platform: expected.platformName,
      executablePath: expected.expectedExecutablePath,
      executablePaths: expected.expectedExecutablePaths,
      launcherPath: expected.expectedLauncherPath,
      host: endpoint.hostname,
      port: endpoint.port,
    }).verified;
  };
  const protocol = await runMcpMemoryRecoveryProtocol({
    preflight: async () => ({ ok: true }),
    adapters: {
      acquireTransactionLock: async () => acquireEndpointStartLock({
        endpoint,
        lockRoot: join(homedir(), ".meta-kim", "locks"),
      }),
      releaseTransactionLock: async (lock) => releaseEndpointStartLock(lock),
      inspectWriter: async () => {
        const listener = inspectEndpointListener(endpoint);
        if (isEndpointNotListening(listener)) return { kind: "none" };
        if (listener?.kind !== "listening") return { kind: "unknown" };
        if (identityMatches(listener, trustedCandidateMemoryBin)) return { kind: "candidate" };
        if (identityMatches(listener, trustedOldMemoryBin)) return { kind: "old" };
        return { kind: "unknown" };
      },
      stopWriter: ({ kind }) => stopVerifiedEndpointProcess({
        endpoint,
        ...memoryProcessIdentityExpectation(
          kind === "candidate" ? trustedCandidateMemoryBin : trustedOldMemoryBin,
        ),
      }),
      verifyNoWriter: async () => isEndpointNotListening(inspectEndpointListener(endpoint)),
      restoreDatabase: async () => {
        const backupPath = trustedBackupPath;
        if (existsSync(backupPath)) {
          const actualBackupDigest = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
          if (!expectedBackupDigest || actualBackupDigest !== expectedBackupDigest) return false;
          return sqliteRestoreWithQuickCheck({
            python: resolved.python,
            backupPath,
            targetPath: recovery.databasePath,
          }).ok;
        }
        if (recovery.databaseExistedBefore === false) return !existsSync(recovery.databasePath);
        return !evidence.events.some(({ stage }) => stage === "database_backup_verified");
      },
      restoreMcpEntry: async () => restoreMcpMemoryServerEntry(
        recovery.mcpPath,
        recovery.mcpMemoryEntrySnapshot,
      ),
      restoreBootAndActiveState: async () => {
        const snapshots = [recovery.stateSnapshot, ...(recovery.bootSnapshots ?? [])].filter(Boolean);
        return snapshots.every((snapshot) => restoreManagedFile({
          filePath: snapshot.filePath,
          existed: snapshot.existed === true,
          content: snapshot.contentBase64 ? Buffer.from(snapshot.contentBase64, "base64") : null,
          mode: snapshot.mode,
        }));
      },
      startOldRuntime: async () => ({
        ok: await startMcpMemoryServiceBackground(
          { ...resolved, python: resolved.python },
          endpoint,
          {
            memoryBinOverride: trustedOldMemoryBin,
            databasePathOverride: recovery.databasePath,
            lockAlreadyHeld: true,
            configureBootOnHealthy: false,
            writeActiveStateOnHealthy: false,
            extraEnv: { MCP_MEMORY_SQLITE_PATH: recovery.databasePath },
          },
        ),
      }),
      verifyOldRuntime: async () => verifyEndpointRuntimeIdentity(endpoint, trustedOldMemoryBin),
      markRecovered: async () => {
        evidence.status = "recovered_on_next_setup";
        evidence.stage = "recovered_on_next_setup";
        writeJsonAtomic(resolve(trustedTransactionRoot, evidenceName), evidence);
        return true;
      },
    },
  });
  return protocol.ok;
}

async function runTransactionalMcpMemoryUpdate({
  resolved,
  endpoint,
  mcpPath,
}) {
  const oldMemoryBin = findMemoryBinPath(resolved);
  const transactionRoot = join(homedir(), ".meta-kim", "transactions", "mcp-memory");
  preparePrivateTransactionRoot(transactionRoot);
  cleanupExpiredMcpMemoryRecoveryArtifacts({ transactionRoot });
  if (!await recoverIncompleteMcpMemoryTransaction({ transactionRoot, endpoint, resolved })) {
    return { ok: false, status: "incomplete_transaction_recovery_failed" };
  }
  const recoveredOldMemoryBin = findMemoryBinPath(resolved);
  if (!recoveredOldMemoryBin && !oldMemoryBin) return { ok: false, status: "old_runtime_missing" };
  const effectiveOldMemoryBin = recoveredOldMemoryBin ?? oldMemoryBin;
  const activeOldRuntime = readActiveMemoryRuntimeState();
  const effectiveOldPython = (
    activeOldRuntime?.pythonPath &&
    isAbsolute(activeOldRuntime.pythonPath) &&
    existsSync(activeOldRuntime.pythonPath)
  )
    ? { command: activeOldRuntime.pythonPath, args: [] }
    : resolved.python;
  const transactionId = `update-${Date.now()}-${process.pid}`;
  const candidateDir = join(homedir(), ".meta-kim", "memory-runtimes", transactionId);
  const sentinelRoot = join(transactionRoot, `${transactionId}-sentinel`);
  const stateSnapshot = snapshotManagedFile(activeMemoryRuntimeStatePath());
  const existingMcpConfig = existsSync(mcpPath)
    ? JSON.parse(readFileSync(mcpPath, "utf8"))
    : {};
  const mcpMemoryEntrySnapshot = {
    fileExisted: existsSync(mcpPath),
    existed: Object.hasOwn(existingMcpConfig.mcpServers ?? {}, "mcp-memory-service"),
    entry: existingMcpConfig.mcpServers?.["mcp-memory-service"] ?? null,
  };
  const bootSnapshots = memoryBootArtifactPaths().map(snapshotManagedFile);
  const databasePath = resolveMcpMemoryDatabasePathWithRuntime(effectiveOldPython, {
    preferredPath: activeOldRuntime?.databasePath ?? null,
  });
  if (!databasePath) return { ok: false, status: "database_path_resolution_failed" };
  const databaseExistedBefore = existsSync(databasePath);
  const backupPath = join(transactionRoot, `${transactionId}-sqlite-backup.db`);
  const recoveryPath = join(transactionRoot, `${transactionId}-recovery.json`);
  let candidateResolved = null;
  let candidateMemoryBin = null;

  const transaction = await runMcpMemoryUpgradeTransaction({
    transactionRoot,
    transactionId,
    adapters: {
      prepareCandidate: async () => {
        const launcher = createMemoryServiceVenv(effectiveOldPython, candidateDir);
        if (!launcher) return { ok: false };
        candidateResolved = { python: launcher, venvDir: candidateDir, venvCreated: true };
        const plan = planMcpMemoryReconciliation({
          existingInstalled: false,
          inUpdateMode: true,
        });
        const installed = executeMcpMemoryReconciliation({
          python: launcher,
          plan,
          runPython: runPythonModule,
          repairDependencyProbe: ({ python, verifyArgs }) => repairWindowsCandidateOnnxRuntime({
            python,
            candidateDir,
            verifyArgs,
            runPython: runPythonModule,
          }),
        });
        if (!installed.ok) {
          return {
            ok: false,
            code: installed.code,
            stage: installed.stage,
            processResult: installed.processResult,
            repairEvidence: installed.repairEvidence,
            repairReason: installed.repairReason,
          };
        }
        candidateMemoryBin = findMemoryBinPath(candidateResolved, { preferActive: false });
        if (!candidateMemoryBin) return { ok: false };
        return {
          ok: true,
          identity: candidateDir,
          resolved: candidateResolved,
          memoryBin: candidateMemoryBin,
          pythonPath: launcher.command,
          reconciliationStage: installed.stage,
          reconciliationCode: installed.code,
          repairEvidence: installed.repairEvidence,
        };
      },
      validateCandidateOnline: (candidate) => runCandidateOnnxSentinel({
        pythonPath: candidate.resolved.python,
        workDir: join(sentinelRoot, "online"),
        offline: false,
      }),
      validateCandidateBootOffline: (candidate) => runCandidateOnnxSentinel({
        pythonPath: candidate.resolved.python,
        workDir: join(sentinelRoot, "offline"),
        offline: true,
      }),
      persistRecoverySnapshots: async () => persistMcpMemoryRecoverySnapshots({
        transactionRoot,
        transactionId,
        oldMemoryBin: effectiveOldMemoryBin,
        oldPython: effectiveOldPython,
        candidateMemoryBin,
        databasePath,
        databaseExistedBefore,
        mcpPath,
        mcpMemoryEntrySnapshot,
        stateSnapshot,
        bootSnapshots,
      }),
      acquireTransactionLock: async () => acquireEndpointStartLock({
        endpoint,
        lockRoot: join(homedir(), ".meta-kim", "locks"),
      }),
      releaseTransactionLock: async (lock) => releaseEndpointStartLock(lock),
      stopOldRuntime: () => stopVerifiedEndpointProcess({
        endpoint,
        ...memoryProcessIdentityExpectation(effectiveOldMemoryBin),
      }),
      backupDatabase: async () => {
        if (!existsSync(databasePath)) {
          return {
            ok: true,
            quickCheck: "ok",
            identity: "no_database",
            contentSha256: MCP_MEMORY_NO_DATABASE_DIGEST,
          };
        }
        return sqliteBackupWithQuickCheck({
          python: effectiveOldPython,
          sourcePath: databasePath,
          backupPath,
        });
      },
      startCandidate: async (candidate) => ({
        ok: await startMcpMemoryServiceBackground(candidate.resolved, endpoint, {
          memoryBinOverride: candidate.memoryBin,
          databasePathOverride: databasePath,
          lockAlreadyHeld: true,
          configureBootOnHealthy: false,
          writeActiveStateOnHealthy: false,
          extraEnv: { MCP_MEMORY_SQLITE_PATH: databasePath },
        }),
      }),
      verifyCandidateHealthy: async (candidate) => (
        await probeMcpMemoryHealth(endpoint.healthUrl) &&
        verifyEndpointRuntimeIdentity(endpoint, candidate.memoryBin)
      ),
      updateMcpConfig: async (candidate) => {
        let mcpConfig = {};
        if (existsSync(mcpPath)) mcpConfig = JSON.parse(readFileSync(mcpPath, "utf8"));
        writeJsonAtomic(mcpPath, {
          ...mcpConfig,
          mcpServers: {
            ...(mcpConfig.mcpServers ?? {}),
            "mcp-memory-service": buildMcpMemoryServerConfig(candidate.resolved, {
              memoryBinOverride: candidate.memoryBin,
              preferActive: false,
              databasePathOverride: databasePath,
            }),
          },
        });
        return true;
      },
      configureCandidateBoot: (candidate) => configureBootAutoStart(candidate.memoryBin, endpoint, {
        databasePath,
      }),
      writeActiveState: async (candidate) => {
        writeActiveMemoryRuntimeState({
          resolved: candidate.resolved,
          memoryBin: candidate.memoryBin,
          databasePath,
        });
        return true;
      },
      commit: async () => true,
      cleanupSensitiveArtifacts: async () => {
        rmSync(backupPath, { force: true });
        rmSync(recoveryPath, { force: true });
        return true;
      },
      cleanupCandidate: async () => {
        rmSync(candidateDir, { recursive: true, force: true });
        return true;
      },
      stopCandidate: () => stopVerifiedEndpointProcess({
        endpoint,
        ...memoryProcessIdentityExpectation(candidateMemoryBin),
      }),
      verifyNoWriter: async () => isEndpointNotListening(inspectEndpointListener(endpoint)),
      restoreDatabase: async (backup) => {
        if (!backup) return true;
        if (backup?.identity === "no_database") {
          rmSync(databasePath, { force: true });
          return true;
        }
        return sqliteRestoreWithQuickCheck({
          python: effectiveOldPython,
          backupPath,
          targetPath: databasePath,
        });
      },
      restoreBoot: async () => bootSnapshots.every(restoreManagedFile),
      restoreState: async () => {
        restoreManagedFile(stateSnapshot);
        restoreMcpMemoryServerEntry(mcpPath, mcpMemoryEntrySnapshot);
        return true;
      },
      startOldRuntime: async () => ({
        ok: await startMcpMemoryServiceBackground({ ...resolved, python: effectiveOldPython }, endpoint, {
          memoryBinOverride: effectiveOldMemoryBin,
          databasePathOverride: databasePath,
          lockAlreadyHeld: true,
          configureBootOnHealthy: false,
          writeActiveStateOnHealthy: false,
          extraEnv: { MCP_MEMORY_SQLITE_PATH: databasePath },
        }),
      }),
      verifyOldRuntimeHealthy: async () => (
        await probeMcpMemoryHealth(endpoint.healthUrl) &&
        verifyEndpointRuntimeIdentity(endpoint, effectiveOldMemoryBin)
      ),
    },
  });
  return {
    ...transaction,
    resolved: transaction.ok ? candidateResolved : resolved,
    registrationOk: transaction.ok,
  };
}

async function installMcpMemoryServiceStep(
  inUpdateMode = false,
  activeTargets = RUNTIME_CHOICES.map(({ id }) => id),
) {
  heading(t.stepMcpMemory);

  const want = await askYesNo(t.askMcpMemoryInstall, true);
  if (!want) {
    skip(`${C.dim}${t.mcpMemorySkipped}${C.reset}`);
    return;
  }

  let memoryEndpoint;
  try {
    memoryEndpoint = resolveMemoryEndpoint();
  } catch (error) {
    warn(t.mcpMemoryEndpointInvalid(error.message));
    return false;
  }
  info(t.mcpMemoryEndpointSelected(memoryEndpoint.endpointUrl));

  // Detect Python — reuse same detection as graphify for consistency
  const detected = checkPython310();
  if (!detected) {
    warn(t.pythonNotFound);
    info(t.pythonHint);
    return false;
  }

  // Resolve Python for mcp-memory-service (safetensors prefers 3.11/3.12).
  // When the detected Python is outside that range, try to build/reuse a venv
  // locked to 3.12. Falls back to the detected Python with a warning.
  let resolved = resolvePythonForMemoryService(detected);
  let python = resolved.python;
  const mcpPath = join(PROJECT_DIR, ".mcp.json");

  // Check if already installed
  const existing = checkMcpMemoryService(python);
  let registrationOk = false;
  let backgroundOk = false;
  if (inUpdateMode && existing.installed) {
    info(t.mcpMemoryUpgrading);
    const transaction = await runTransactionalMcpMemoryUpdate({
      resolved,
      endpoint: memoryEndpoint,
      mcpPath,
    });
    if (!transaction.ok) {
      warn(t.mcpMemoryUpgradeFailed);
      info(`  ${transaction.status}: code=${transaction.code ?? "unknown"}; ${transaction.evidencePath || "no evidence"}`);
      return false;
    }
    resolved = transaction.resolved;
    python = resolved.python;
    registrationOk = transaction.registrationOk;
    backgroundOk = true;
    ok(t.mcpMemoryUpgraded(checkMcpMemoryService(python).version ?? "latest"));
  } else {
    const reconciliationPlan = planMcpMemoryReconciliation({
      existingInstalled: existing.installed,
      inUpdateMode,
    });
    info(inUpdateMode ? t.mcpMemoryUpgrading : t.mcpMemoryInstalling);
    const reconciliation = executeMcpMemoryReconciliation({
      python,
      plan: reconciliationPlan,
      runPython: runPythonModule,
    });
    if (!reconciliation.ok) {
      const stderr = readProcessText(reconciliation.processResult);
      warn(inUpdateMode ? t.mcpMemoryUpgradeFailed : t.mcpMemoryInstallFailed);
      info(`  code=${reconciliation.code ?? "unknown"}; stage=${reconciliation.stage ?? "unknown"}`);
      if (stderr) console.log(`${C.dim}${t.pipErrorDetail(stderr)}${C.reset}`);
      return false;
    }
    const reconciledVersion = checkMcpMemoryService(python).version ?? "latest";
    if (existing.installed) ok(t.mcpMemoryAlreadyInstalled(reconciledVersion));
    else ok(t.mcpMemoryInstalled);

    let memoryServerConfig;
    try {
      memoryServerConfig = buildMcpMemoryServerConfig(resolved);
    } catch (error) {
      warn(`${t.setupError} MCP Memory server registration: ${error.message}`);
      return false;
    }
    registrationOk = registerMcpMemoryServer({
      mcpPath,
      memoryServerConfig,
      onRegistered: () => ok(t.mcpMemoryServerRegistered),
      onExisting: () => ok(t.mcpMemoryServerExists),
      onFailure: (error) =>
        warn(`${t.setupError} MCP Memory server registration: ${error.message}`),
    });
    if (!registrationOk) return false;
    backgroundOk = await startMcpMemoryServiceBackground(resolved, memoryEndpoint);
  }

  info(t.mcpMemoryServerStartHint);

  // Step 4.7 — auto-install runtime memory hooks so the full pipeline
  // (pip package → .mcp.json → hook files → runtime registration →
  // health check) runs from a single `node setup.mjs` invocation.
  const hooksOk = await runMcpMemoryHookInstaller(activeTargets, {
    allowClaudeGlobalSettings: want && activeTargets.includes("claude"),
  });

  return registrationOk && hooksOk && backgroundOk;
}

function ensureNetworkxCompatibility(python) {
  const nx = checkNetworkx(python);
  if (!nx.installed) {
    // networkx not found — will be pulled in by graphify, check again
    const recheck = checkNetworkx(python);
    if (!recheck.installed || recheck.meets) return;
    if (!recheck.meets) upgradeNetworkx(python);
    return;
  }
  if (nx.meets) {
    ok(t.networkxAlreadyOk(nx.version));
    return;
  }
  upgradeNetworkx(python);
}

function upgradeNetworkx(python) {
  info(t.networkxUpgrading);
  const result = runPythonModule(
    python,
    ["-m", "pip", "install", "--upgrade", "networkx"],
    undefined,
    { stdio: "pipe" },
  );
  if (result.status === 0) {
    const recheck = checkNetworkx(python);
    const newVersion = recheck.version ?? "latest";
    ok(t.networkxUpgraded(newVersion));
  } else {
    warn(t.networkxUpgradeFailed);
    const stderr = readProcessText(result);
    if (stderr) {
      console.log(`${C.dim}${t.pipErrorDetail(stderr)}${C.reset}`);
    }
  }
}

// ── Step 5: Validate + next steps ───────────────────────

async function validateInstalledArtifacts({
  installScope,
  activeTargets,
  projectSyncOk = true,
  projectDeployResults = [],
}) {
  heading(t.stepValidate);
  if (installScope === "global") {
    // The final global check receives the selected runtimes independently of
    // the hooks opt-in so it can read back each setup launch descriptor.
    const globalValidationTargets = [...new Set(activeTargets)];
    const projectReady = projectDeployResults.every(
      (result) => result.status === "ok" && result.stateStatus === "ready",
    );
    const checkResult = runNodeScript(
      SETUP_NODE_CHILD.GLOBAL_META_THEORY_SYNC,
      [...metaTheoryGlobalSyncArgs(globalValidationTargets, setupWithGlobalHooks), "--check"],
    );
    if (checkResult.status === 0 && projectReady) {
      ok(t.validationPassed);
      return true;
    }
    warn(`${t.setupError} ${t.stepValidate}`);
    return false;
  }

  if (!projectSyncOk) {
    warn(`${t.setupError} ${t.stepValidate}`);
    return false;
  }
  if (projectDeployResults.length > 0) {
    const allTargetsReady = projectDeployResults.every(
      (result) => result.status === "ok" && result.stateStatus === "ready",
    );
    if (allTargetsReady) {
      ok(t.validationPassed);
      return true;
    }
    warn(`${t.setupError} ${t.stepValidate}`);
    return false;
  }

  // A source checkout can be its own project target. A packed distribution is
  // only a staging source and must not pass project scope without a real target.
  if (isSourceCheckout()) {
    ok(t.validationPassed);
    return true;
  }
  warn(`${t.setupError} ${t.stepValidate}`);
  return false;
}

function printInstallResult(result, completeMessage) {
  if (result.status === "complete") {
    console.log(`\n${C.bold}${C.green}✓ ${completeMessage}${C.reset}\n`);
    return;
  }

  const failedLabels = result.failedSteps.map((step) => step.id).join(", ");
  if (result.status === "partial") {
    console.log(`\n${C.bold}${C.yellow}⚠ ${t.validationWarnings}${C.reset}`);
    console.log(`${C.dim}  ${failedLabels}${C.reset}\n`);
    return;
  }

  console.log(`\n${C.bold}${C.red}✗ ${t.setupError} ${failedLabels}${C.reset}`);
  console.log("");
}

function installRecoveryCopy(mode, result) {
  const failed = result.failedSteps.map((step) => step.id).join(", ");
  const copies = {
    en: {
      title: mode === "update" ? "Update needs attention" : "Installation needs attention",
      partial: "Core setup may be usable, but optional or follow-up steps did not finish.",
      failed: "Setup is incomplete. Do not treat the runtime as ready yet.",
      retry: `Failed steps: ${failed || "unknown"}. Fix the reported cause, rerun the same command, then run node setup.mjs --check.`,
    },
    "zh-CN": {
      title: mode === "update" ? "更新尚未完整完成" : "安装尚未完整完成",
      partial: "核心能力可能可用，但仍有可选项或收尾步骤未完成。",
      failed: "当前安装不完整，请先不要把运行时视为已就绪。",
      retry: `失败步骤：${failed || "未知"}。修复上方原因后重跑同一命令，再执行 node setup.mjs --check。`,
    },
    "ja-JP": {
      title: mode === "update" ? "更新はまだ完了していません" : "インストールはまだ完了していません",
      partial: "コア機能は利用できる可能性がありますが、任意または後続の手順が未完了です。",
      failed: "セットアップは未完了です。runtime を準備完了として扱わないでください。",
      retry: `失敗した手順: ${failed || "不明"}。上記の原因を修正して同じコマンドを再実行し、その後 node setup.mjs --check を実行してください。`,
    },
    "ko-KR": {
      title: mode === "update" ? "업데이트가 아직 완료되지 않았습니다" : "설치가 아직 완료되지 않았습니다",
      partial: "핵심 기능은 사용할 수 있을 수 있지만 선택 또는 후속 단계가 완료되지 않았습니다.",
      failed: "설치가 불완전합니다. 아직 runtime을 준비 완료로 간주하지 마세요.",
      retry: `실패 단계: ${failed || "알 수 없음"}. 위 원인을 해결한 뒤 같은 명령을 다시 실행하고 node setup.mjs --check 를 실행하세요.`,
    },
  };
  return copies[currentLangCode] ?? copies.en;
}

function showInstallRecovery(result, mode) {
  const copy = installRecoveryCopy(mode, result);
  console.log(`${C.bold}${result.status === "partial" ? C.yellow : C.red}${copy.title}${C.reset}`);
  console.log(result.status === "partial" ? copy.partial : copy.failed);
  console.log(`${C.dim}${copy.retry}${C.reset}\n`);
}

function showNextSteps(runtimes, selectedTargets = detectedTargetIds(runtimes)) {
  const hasDeployDirs = quickDeployDirs.length > 0 || Boolean(quickDeployDir);
  const displayDir = quickDeployDirs[0] || quickDeployDir || PROJECT_DIR;

  console.log(`${C.bold}${t.howToUse}${C.reset}
`);

  if (runtimes.claude) {
    console.log(
      `${C.dim}1.${C.reset} ${hasDeployDirs ? t.npxQuickOpenIn : t.step1Open}`,
    );
    console.log(`${C.dim}cd "${displayDir}" && claude${C.reset}`);
    if (quickDeployDirs.length > 1) {
      console.log(
        `${C.dim}${t.projectDeployMoreTargets(quickDeployDirs.length - 1)}${C.reset}`,
      );
    }
    console.log("");
    console.log(`${C.dim}2.${C.reset} ${t.step2Try}`);
    console.log(`${C.dim}/meta-theory review my agent definitions${C.reset}`);
    console.log("");
    console.log(`${C.dim}3.${C.reset} ${t.step3Or}`);
    console.log(`${C.dim}Build a user authentication system${C.reset}`);
    console.log(`${C.dim}${t.step3Hint}${C.reset}`);
    console.log("");
  }

  if (runtimes.codex)
    console.log(`${C.dim}Codex:${C.reset} ${C.dim}${t.codexNote}${C.reset}`);
  if (runtimes.openclaw)
    console.log(
      `${C.dim}OpenClaw:${C.reset} ${C.dim}${t.openclawNote}${C.reset}`,
    );
  if (runtimes.cursor)
    console.log(`${C.dim}Cursor:${C.reset} ${C.dim}${t.cursorNote}${C.reset}`);

  if (
    !runtimes.claude &&
    !runtimes.codex &&
    !runtimes.openclaw &&
    !runtimes.cursor
  ) {
    console.log(`${C.yellow}${t.noRuntimeGetStarted}${C.reset}`);
    console.log(
      `${C.dim}${DISTRIBUTION.documentation.claudeCode}${C.reset}`,
    );
  }

  console.log("");
  console.log(`${C.bold}${t.usefulCommands}${C.reset}
`);
  if (hasDeployDirs) {
    const npxPrefix = `npx --yes ${DISTRIBUTION.project.npxSpec} meta-kim`;
    console.log(
      `${C.dim}${npxPrefix} -- --update${C.reset}`,
    );
    console.log(
      `${C.dim}${npxPrefix} -- --check${C.reset}`,
    );
  } else {
    console.log(
      `${C.dim}node setup.mjs --update          # ${t.cmdUpdate}${C.reset}`,
    );
    console.log(
      `${C.dim}node setup.mjs --check           # ${t.cmdCheck}${C.reset}`,
    );
    console.log(
      `${C.dim}npm run discover:global          # ${t.cmdDiscover}${C.reset}`,
    );
    console.log(
      `${C.dim}npm run meta:doctor:governance    # ${t.cmdDoctor}${C.reset}`,
    );
    console.log(
      `${C.dim}npm run meta:verify:all           # ${t.cmdVerify}${C.reset}`,
    );
  }

  console.log("");
  console.log(`${C.bold}${t.postInstallNotesHeading}${C.reset}`);
  console.log(`${C.dim}${t.postInstallNotesIntro}${C.reset}`);
  console.log(`${C.dim}${t.capabilityGateNotice}${C.reset}`);
  console.log(`${C.dim}${t.globalHooksOptInNotice}${C.reset}`);
  console.log("");
  console.log(
    `${C.bold}${C.cyan}● ${t.postInstallNotesPlatformSync}${C.reset}`,
  );
  const platformRows = [
    { id: "claude", name: t.platformClaudeCode, cap: t.platformClaudeCodeCap },
    { id: "codex", name: t.platformCodex, cap: t.platformCodexCap },
    { id: "openclaw", name: t.platformOpenClaw, cap: t.platformOpenClawCap },
    { id: "cursor", name: t.platformCursor, cap: t.platformCursorCap },
  ].filter((row) => selectedTargets.includes(row.id));
  for (const row of platformRows) {
    console.log(`${C.dim}• ${row.name}: ${row.cap}${C.reset}`);
  }
  console.log("");
  console.log(
    `${C.bold}${C.cyan}● ${t.postInstallNotesLayerActivation}${C.reset}`,
  );
  console.log(`${C.dim}${t.layer1Label} — ${t.layer1Note}${C.reset}`);
  console.log(`${C.dim}${t.layer2Label} — ${t.layer2Note}${C.reset}`);
  const memoryEndpoint = resolveMemoryEndpoint();
  console.log(
    `${C.dim}${t.layer3Label} — ${t.mcpMemoryEndpointSelected(memoryEndpoint.endpointUrl)}${C.reset}`,
  );
  console.log("");
  console.log(`${C.bold}${C.cyan}● ${t.installLocationsHeading}${C.reset}`);
  console.log(
    `${C.dim}• ${t.installLocationsProject}: ${displayDir}${C.reset}`,
  );
  console.log(
    `${C.dim}• ${t.installLocationsGlobal}: ~/.claude/skills/  ~/.codex/skills/  ~/.cursor/skills/  ~/.openclaw/skills/${C.reset}`,
  );
  console.log(
    `${C.dim}• ${t.installLocationsManifest}: ~/.meta-kim/install-manifest.json${C.reset}`,
  );
  console.log("");
  console.log(`${C.bold}${C.cyan}● ${t.usefulCommandsHeading}${C.reset}`);
  if (hasDeployDirs) {
    const npxPrefix = `npx --yes ${DISTRIBUTION.project.npxSpec} meta-kim`;
    console.log(`${C.dim}  ${npxPrefix} status          # ${t.cmdWhereStatus}${C.reset}`);
    console.log(`${C.dim}  ${npxPrefix} status --diff   # ${t.cmdWhereStatusDiff}${C.reset}`);
    console.log(`${C.dim}  ${npxPrefix} doctor          # ${t.cmdDoctor}${C.reset}`);
    console.log(`${C.dim}  ${npxPrefix} uninstall       # ${t.cmdWhereUninstall}${C.reset}`);
  } else {
    console.log(`${C.dim}  npm run meta:status        # ${t.cmdWhereStatus}${C.reset}`);
    console.log(`${C.dim}  npm run meta:status:diff   # ${t.cmdWhereStatusDiff}${C.reset}`);
    console.log(`${C.dim}  npm run meta:doctor        # ${t.cmdDoctor}${C.reset}`);
    console.log(`${C.dim}  npm run meta:uninstall     # ${t.cmdWhereUninstall}${C.reset}`);
  }
  console.log("");
  console.log(
    `${C.dim}${C.yellow}★ ${t.postInstallNotesReminder} ${t.postInstallNotesReminderText}${C.reset}`,
  );
  console.log("");
}

// ── Main ────────────────────────────────────────────────

function bannerLogo() {
  // Double-width block pixels for maximum visual impact
  const B = "\u2588\u2588"; // ██
  const S = "  ";

  const G = {
    M: [
      `${B}${S}${S}${S}${S}${S}${B}`,
      `${B}${B}${S}${S}${S}${B}${B}`,
      `${B}${S}${B}${S}${B}${S}${B}`,
      `${B}${S}${S}${B}${S}${S}${B}`,
      `${B}${S}${S}${S}${S}${S}${B}`,
      `${B}${S}${S}${S}${S}${S}${B}`,
      `${B}${S}${S}${S}${S}${S}${B}`,
    ],
    E: [
      `${B}${B}${B}${B}${B}${B}${B}`,
      `${B}${S}${S}${S}${S}${S}${S}`,
      `${B}${S}${S}${S}${S}${S}${S}`,
      `${B}${B}${B}${B}${B}${S}${S}`,
      `${B}${S}${S}${S}${S}${S}${S}`,
      `${B}${S}${S}${S}${S}${S}${S}`,
      `${B}${B}${B}${B}${B}${B}${B}`,
    ],
    T: [
      `${B}${B}${B}${B}${B}${B}${B}`,
      `${S}${S}${S}${B}${S}${S}${S}`,
      `${S}${S}${S}${B}${S}${S}${S}`,
      `${S}${S}${S}${B}${S}${S}${S}`,
      `${S}${S}${S}${B}${S}${S}${S}`,
      `${S}${S}${S}${B}${S}${S}${S}`,
      `${S}${S}${S}${B}${S}${S}${S}`,
    ],
    A: [
      `${S}${S}${S}${B}${S}${S}${S}`,
      `${S}${S}${B}${S}${B}${S}${S}`,
      `${S}${S}${B}${S}${B}${S}${S}`,
      `${S}${B}${B}${B}${B}${B}${S}`,
      `${S}${B}${S}${S}${S}${B}${S}`,
      `${S}${B}${S}${S}${S}${B}${S}`,
      `${B}${B}${S}${S}${S}${B}${B}`,
    ],
    _: [
      `${S}${S}${S}${S}${S}${S}${S}`,
      `${S}${S}${S}${S}${S}${S}${S}`,
      `${S}${S}${S}${S}${S}${S}${S}`,
      `${S}${S}${S}${S}${S}${S}${S}`,
      `${S}${S}${S}${S}${S}${S}${S}`,
      `${S}${S}${S}${S}${S}${S}${S}`,
      `${B}${B}${B}${B}${B}${B}${B}`,
    ],
    K: [
      `${B}${B}${S}${S}${S}${B}${S}`,
      `${B}${B}${S}${S}${B}${S}${S}`,
      `${B}${B}${S}${B}${S}${S}${S}`,
      `${B}${B}${B}${S}${S}${S}${S}`,
      `${B}${B}${S}${B}${S}${S}${S}`,
      `${B}${B}${S}${S}${B}${S}${S}`,
      `${B}${B}${S}${S}${S}${B}${S}`,
    ],
    I: [
      `${B}${B}${B}${B}${B}${B}${B}`,
      `${S}${S}${S}${B}${S}${S}${S}`,
      `${S}${S}${S}${B}${S}${S}${S}`,
      `${S}${S}${S}${B}${S}${S}${S}`,
      `${S}${S}${S}${B}${S}${S}${S}`,
      `${S}${S}${S}${B}${S}${S}${S}`,
      `${B}${B}${B}${B}${B}${B}${B}`,
    ],
  };

  const word = ["M", "E", "T", "A", "_", "K", "I", "M"];
  // Gold gradient: deep amber (24-bit RGB, dark and subtle)
  const rowColors = [
    "\x1b[38;2;160;120;60m",
    "\x1b[38;2;180;140;70m",
    "\x1b[38;2;200;160;80m",
    "\x1b[38;2;180;140;70m",
    "\x1b[38;2;160;120;60m",
    "\x1b[38;2;140;100;50m",
    "\x1b[38;2;120;80;40m",
  ];

  // Build ASCII art lines
  const artLines = [];
  for (let row = 0; row < 7; row++) {
    let line = "";
    word.forEach((ch, idx) => {
      line += G[ch][row];
      if (idx < word.length - 1) line += " "; // 1-char gap between letters
    });
    artLines.push(line);
  }

  // Visual width helper (CJK characters = 2 columns, everything else = 1)
  const dw = (s) =>
    [...s].reduce((w, ch) => {
      const cp = ch.codePointAt(0);
      const isCJK =
        (cp >= 0x4e00 && cp <= 0x9fff) ||
        (cp >= 0x3040 && cp <= 0x30ff) ||
        (cp >= 0xac00 && cp <= 0xd7af) ||
        (cp >= 0xff00 && cp <= 0xffef) ||
        (cp >= 0x3000 && cp <= 0x303f);
      return w + (isCJK ? 2 : 1);
    }, 0);

  const contacts = [
    `Website: ${DISTRIBUTION.contact.website}`,
    `GitHub:  ${DISTRIBUTION.contact.github}`,
    `X:       ${DISTRIBUTION.contact.x}`,
    `Feishu:  ${DISTRIBUTION.contact.feishu}`,
    `WeChat:  ${DISTRIBUTION.contact.wechat}`,
  ];

  const padVis = (s, width) => s + " ".repeat(Math.max(0, width - dw(s)));
  // Art width: all chars are ASCII (█ = 1 col, space = 1 col), string length = visual width
  const artW = artLines[0].length;
  const PAD = 3;
  const innerW = artW + PAD * 2;
  const bar = "\u2501".repeat(innerW);
  const blank = " ".repeat(innerW);
  const center = (text) => {
    const p = innerW - dw(text);
    const l = Math.floor(p / 2);
    return " ".repeat(l) + text + " ".repeat(p - l);
  };

  const sep = "\u2500".repeat(30);
  const frame = `\x1b[38;2;160;120;60m${C.bold}`; // deep amber frame

  const versionText = `Setup v${packageVersion}`;
  const tagline = "AI Coding Governance Layer";

  console.log("");
  console.log(`${frame}  \u250f${bar}\u2513`);
  console.log(`${frame}  \u2503${blank}\u2503`);
  artLines.forEach((line, row) => {
    const color = rowColors[row];
    const padded = " ".repeat(PAD) + padVis(line, artW) + " ".repeat(PAD);
    console.log(
      `${frame}  \u2503${color}${C.bold}${padded}${C.reset}${frame}\u2503`,
    );
  });
  console.log(`${frame}  \u2503${blank}\u2503`);
  console.log(
    `${frame}  \u2503${C.bold}\x1b[38;2;200;160;80m${center(versionText)}${C.reset}${frame}\u2503`,
  );
  console.log(
    `${frame}  \u2503${C.dim}${center(tagline)}${C.reset}${frame}\u2503`,
  );
  console.log(`${frame}  \u2503${C.dim}${center(sep)}${C.reset}${frame}\u2503`);
  console.log(`${frame}  \u2503${blank}\u2503`);
  contacts.forEach((c) => {
    console.log(`${frame}  \u2503${C.dim}${center(c)}${C.reset}${frame}\u2503`);
  });
  console.log(`${frame}  \u2503${blank}\u2503`);
  console.log(`${frame}  \u2517${bar}\u251b${C.reset}`);
  console.log("");
}

function showModeInfo() {
  const modeStr = checkOnly
    ? t.modeCheck
    : updateMode
      ? t.modeUpdate
      : silentMode
        ? t.modeSilent
        : t.modeInteractive;
  console.log(
    `${C.dim}${t.modeInfoLine(modeStr, platform(), process.versions.node)}${C.reset}`,
  );
}

const GLOBAL_ONLY_PROJECT_HOOK_PAIRS = [
  { runtime: "Claude Code", dir: ".claude/hooks" },
  { runtime: "Codex", dir: ".codex/hooks" },
  { runtime: "Cursor", dir: ".cursor/hooks" },
];

function checkGlobalOnlyProjectHookPairs() {
  heading(t.syncHeading);
  let allOk = true;
  for (const pair of GLOBAL_ONLY_PROJECT_HOOK_PAIRS) {
    const activator = join(PROJECT_DIR, pair.dir, "activate-meta-theory-spine.mjs");
    const resolver = join(PROJECT_DIR, pair.dir, "project-root.mjs");
    const activatorExists = existsSync(activator) && statSync(activator).isFile();
    const resolverExists = existsSync(resolver) && statSync(resolver).isFile();
    const importsResolver = activatorExists &&
      /from\s+["']\.\/project-root\.mjs["']/u.test(readFileSync(activator, "utf8"));
    if (activatorExists && resolverExists && importsResolver) {
      ok(t.syncGlobalOnlyHookPairOk(pair.runtime));
      continue;
    }
    allOk = false;
    fail(
      t.syncGlobalOnlyHookPairFailed(
        pair.runtime,
        [
          !activatorExists ? "activate-meta-theory-spine.mjs" : null,
          !resolverExists ? "project-root.mjs" : null,
          activatorExists && !importsResolver ? "project-root import" : null,
        ].filter(Boolean).join(", "),
      ),
    );
  }
  console.log("");
  if (allOk) info(t.syncOk);
  return allOk;
}

function checkProjectRuntimeSync(runtimes, targetContext) {
  if (targetContext.localOverrides?.projectProjectionMode === "global_only") {
    return checkGlobalOnlyProjectHookPairs();
  }
  return checkSync(runtimes, targetContext.activeTargets);
}

function reportProjectRuntimeSyncResult(syncOk) {
  if (syncOk) return true;
  console.error(`\n${C.red}✗ ${t.checkOverallFailed}${C.reset}`);
  console.error(`${C.yellow}${t.checkRepairCommand}${C.reset}\n`);
  return false;
}

async function runProjectBootstrapCli() {
  if (projectBootstrapApply && projectBootstrapDryRun) {
    throw new Error("--project-bootstrap cannot use --apply and --dry-run together");
  }
  const targetContext = await resolveTargetContext(args);
  const activeTargets = targetContext.activeTargets;
  const targetDirs = cliProjectDeployDirs.length > 0 ? cliProjectDeployDirs : [CALLER_CWD];
  const applyMode = projectBootstrapApply && !projectBootstrapDryRun;
  const results = [];
  let ok = true;

  for (const targetDir of targetDirs) {
    try {
      const plan = buildProjectBootstrapPlan(activeTargets, targetDir);
      if (!applyMode) {
        results.push(plan);
        continue;
      }

      results.push(await applyProjectBootstrapToDir(activeTargets, targetDir));
    } catch (error) {
      ok = false;
      if (jsonOutputMode) {
        results.push(projectBootstrapFailureResult(targetDir, activeTargets, error));
      } else {
        throw error;
      }
    }
  }

  const summary = {
    schemaVersion: "meta-kim-project-bootstrap-result-v0.1",
    mode: applyMode ? "apply" : "dry-run",
    ok,
    resultCount: results.length,
    results,
  };

  if (jsonOutputMode) {
    console.log(JSON.stringify(summary, null, 2));
    return ok;
  }

  for (const result of results) {
    const counts = result.state.counts;
    console.log(`Meta_Kim project bootstrap ${summary.mode}: ${result.state.targetDir}`);
    console.log(`  status=${result.state.status} targets=${result.state.activeTargets.join(",")}`);
    console.log(
      `  create=${counts.create} merge=${counts.merge} replace=${counts.replace} skip=${counts.skip}`,
    );
    console.log(`  source=${result.sourceChain.setupEntrypoint} from ${result.sourceChain.syncManifest}`);
    if (result.manifestPath) {
      console.log(`  manifest=${result.manifestPath}`);
    }
  }
  return ok;
}

async function runProjectCleanupCli() {
  const targetContext = await resolveTargetContext(args);
  const activeTargets = targetContext.activeTargets;
  const localOverrides = await loadLocalOverrides();
  const savedDirs = savedProjectDeployDirsFrom(localOverrides);
  const targetDirs =
    cliProjectDeployDirs.length > 0
      ? cliProjectDeployDirs
      : savedDirs;

  const results = await cleanupProjectRedundancyDirs(activeTargets, targetDirs);
  const summary = {
    schemaVersion: "meta-kim-project-cleanup-result-v0.1",
    mode: "cleanup",
    ok: results.every((result) => result.status === "ok"),
    resultCount: results.length,
    results,
  };

  if (jsonOutputMode) {
    console.log(JSON.stringify(summary, null, 2));
    return summary.ok;
  }

  console.log(t.projectCleanupCliResult(summary.ok));
  console.log(`  ${t.projectCleanupCliTargets(activeTargets.join(","))}`);
  console.log(`  ${t.projectCleanupCliProjects(summary.resultCount)}`);
  return summary.ok;
}

async function main() {
  if (projectBootstrapMode) {
    const ok = await runProjectBootstrapCli();
    process.exit(ok ? 0 : 1);
  }
  if (projectCleanupMode) {
    const ok = await runProjectCleanupCli();
    process.exit(ok ? 0 : 1);
  }

  // Show logo before language selection
  bannerLogo();

  // Step 0: Language selection
  await selectLanguage();
  showModeInfo();

  if (!preflight()) {
    console.log(`\n${C.red}  ${t.envFailed}${C.reset}\n`);
    process.exit(1);
  }

  // ── CLI shortcut modes (non-interactive) ──
  if (checkOnly) {
    console.log(`\n${C.green}✓ ${t.envOk}${C.reset}\n`);
    const detectedRuntimes = await detectRuntimes();
    const targetContext = await resolveTargetContext(args);
    const syncOk = checkProjectRuntimeSync(detectedRuntimes, targetContext);
    console.log(
      `${C.dim}${t.checkTargets(targetContext.activeTargets.join(", "), targetContext.supportedTargets.join(", "))}${C.reset}`,
    );
    const localState = getProfilePaths();
    const profileMetadata = await readProfileMetadata();
    console.log("");
    console.log(`${C.bold}${t.localStateHeader}${C.reset}`);
    console.log(
      `${C.dim}  profile=${localState.profile} key=${profileMetadata?.profileKey ?? localState.profileKey} status=${profileMetadata ? "present" : "not-created"}${C.reset}`,
    );
    console.log(
      `${C.dim}  run index: ${toRepoRelative(localState.runIndexPath)}${C.reset}`,
    );
    console.log(
      `${C.dim}  compaction: ${toRepoRelative(localState.compactionDir)}${C.reset}`,
    );
    console.log(
      `${C.dim}  dispatch envelope: config/contracts/workflow-contract.json -> protocols.dispatchEnvelopePacket${C.reset}`,
    );
    console.log(
      `${C.dim}  migration helper: npm run migrate:meta-kim -- <source-dir> --apply${C.reset}`,
    );
    console.log("");
    reportProjectRuntimeSyncResult(syncOk);
    process.exit(syncOk ? 0 : 1);
  }

  if (updateMode) {
    const result = await runUpdate();
    process.exit(result.exitCode);
  }

  if (silentMode) {
    const result = await runInstall();
    process.exit(result.exitCode);
  }

  // ── Interactive: choose action ──
  const actionLabels = [
    t.actionInstall,
    t.actionUpdate,
    t.actionCheck,
    t.actionExit,
  ];
  const actionIdx = await askSelect(t.actionPrompt, actionLabels);

  let result = null;
  if (actionIdx === 0) result = await runInstall();
  else if (actionIdx === 1) result = await runUpdate();
  else if (actionIdx === 2) {
    const checkOk = await runCheck();
    if (!checkOk) process.exitCode = 1;
  }
  else process.exit(0);
  if (result?.exitCode) process.exitCode = result.exitCode;
}

// ── Action runners ──────────────────────────────────────

async function runInstall() {
  const stepResults = [];
  const runtimes = await detectRuntimes();
  const activeTargets = await selectActiveTargets(runtimes);
  const { profiles: runtimeProfiles } = await resolveTargetContext(args);

  // 询问安装范围
  const installScope = await askInstallScope();
  const needProject = installScope === "project";
  const needGlobal = installScope === "global";

  // Ask proxy configuration (saves to localOverrides)
  await askProxyConfig();

  let selectedSkillIds = [];
  if (needGlobal) {
    selectedSkillIds = await resolveSelectedSkillDependencyIds();
  }

  // 在用户知道选了哪些技能后，显示目录结构说明
  showDirectoryExplanation();

  // Ask project deploy directories BEFORE confirm (so user decides upfront)
  const managedProjectResolution = needProject
    ? { deployments: await askDeployDirectory(), rejected: [] }
    : await existingManagedProjectDeployments();
  const deployDirs = managedProjectResolution.deployments;
  reportRejectedManagedProjectTargets(managedProjectResolution.rejected);
  if (needGlobal) info(t.globalManagedProjectRefreshInfo(deployDirs.length));

  // Show installation overview
  showInstallOverview(
    activeTargets,
    installScope,
    selectedSkillIds,
  );
  await showExistingFootprint(installScope);

  const confirm = await askYesNo(t.confirmStartInstall, true);
  if (!confirm) {
    console.log(`\n${C.dim}${t.installCancelled}${C.reset}\n`);
    process.exit(0);
  }

  console.log();

  // 步骤计数
  let stepNum = 0;
  const explicitRejectedTargets = managedProjectResolution.rejected.filter(
    (item) => item.source === "explicit_project_dirs",
  );
  if (explicitRejectedTargets.length > 0) {
    stepResults.push(installStep(t.managedProjectRejectedStep, false));
  }

  // 项目目录更新
  if (needProject) {
    stepNum++;
    const npmOk = await withProgress(t.stepLabel(stepNum, t.progressNpmInstall), async () => {
      if (
        existsSync(join(PROJECT_DIR, "node_modules", "@modelcontextprotocol"))
      ) {
        skip(t.nodeModulesExist);
        return true;
      }
      info(t.runningNpm);
      const result = spawnCliSync("npm", ["install"], {
        cwd: PROJECT_DIR,
        stdio: "inherit",
      });
      if (result.status === 0) {
        ok(t.npmDone);
        return true;
      }
      warn(t.npmFailed);
      return false;
    });
    stepResults.push(installStep(t.progressNpmInstall, npmOk));

    stepNum++;
    await withProgress(t.stepLabel(stepNum, t.progressCleanupLegacy), () => {
      const n = cleanupLegacySkills(installScope);
      if (n > 0) ok(`Cleaned ${n} legacy file(s)`);
      return true;
    });

    stepNum++;
    const configOk = await withProgress(t.stepLabel(stepNum, t.progressSyncConfig), async () => {
      const configResult = await autoConfigure(installScope, activeTargets);
      if (!configResult) {
        warn(t.warnConfigSyncFailed);
      }
      return configResult;
    });
    stepResults.push(installStep(t.progressSyncConfig, configOk));
  }

  // 全局安装
  if (needGlobal) {
    // 准备全局目录
    stepNum++;
    await withProgress(t.stepLabel(stepNum, t.progressPrepareDir), async () => {
      const dirReady = existsSync(SKILLS_DIR);
      if (!dirReady) {
        mkdirSync(SKILLS_DIR, { recursive: true });
      }
      ok(t.globalDirReady(SKILLS_DIR));
      return true;
    });

    // 安装全局技能
    stepNum++;
    const skillsOk = await withProgress(
      t.stepLabel(stepNum, t.progressInstallSkills),
      async () => {
        const localOverrides = await loadLocalOverrides();
        const proxyEnv = localOverrides.gitProxy
          ? { META_KIM_GIT_PROXY: localOverrides.gitProxy }
          : {};
        const skillArgs = buildGlobalSkillsInstallerArgs({
          targets: activeTargets,
          skillIds: selectedSkillIds,
          preferLocalDependencies,
          skipInventoryRefresh: true,
        });
        // ).concat(["--log-file", INSTALL_LOG_FILE]);
        const installResult = runNodeScript(
          SETUP_NODE_CHILD.GLOBAL_SKILLS_INSTALLER,
          skillArgs,
          proxyEnv,
        );
        if (installResult.status !== 0) {
          warn(t.warnSkillsInstallFailed);
          warn(`${C.dim}${t.warnSkillsUpdateFailedHint}${C.reset}`);
        }
        return installResult.status === 0;
      },
    );
    stepResults.push(installStep(t.progressInstallSkills, skillsOk));

    // 同步全局 meta-theory
    stepNum++;
    const metaSyncOk = await withProgress(t.stepLabel(stepNum, t.progressSyncMeta), () => {
      const syncResult = runNodeScript(
        SETUP_NODE_CHILD.GLOBAL_META_THEORY_SYNC,
        metaTheoryGlobalSyncArgs(activeTargets, setupWithGlobalHooks),
      );
      const runtimeAssetsOk = syncOwnedGlobalRuntimeAssets(
        activeTargets,
        runtimeProfiles,
        setupWithGlobalHooks,
      );
      if (syncResult.status !== 0 || !runtimeAssetsOk) {
        warn(t.warnMetaTheorySyncFailed);
      }
      return syncResult.status === 0 && runtimeAssetsOk;
    });
    stepResults.push(installStep(t.progressSyncMeta, metaSyncOk));
  }

  // [Optional] Python tools (graphify)
  stepNum++;
  const pythonToolsOk = skipOptionalTools
    ? (skip(`${C.dim}${t.pythonToolsSkipped}${C.reset}`), INSTALL_STEP_OUTCOME.SKIPPED)
    : await withProgress(
        t.stepLabel(stepNum, t.progressInstallPython),
        async () => {
          const wantPython = await askYesNo(t.askPythonToolsUpdate, true);
          if (wantPython) {
            return await installPythonTools(activeTargets, false, PROJECT_DIR, {
              projectWiring: needProject,
            });
          }
          skip(`${C.dim}${t.pythonToolsSkipped}${C.reset}`);
          return INSTALL_STEP_OUTCOME.SKIPPED;
        },
      );
  stepResults.push(
    installStep(
      t.progressInstallPython,
      pythonToolsOk,
      INSTALL_STEP_CLASSIFICATION.OPTIONAL,
    ),
  );

  // [Optional] MCP Memory Service (Layer 3)
  stepNum++;
  const memoryPolicy = resolveMcpMemorySetupPolicy({
    needGlobal,
    withGlobalHooks: setupWithGlobalHooks,
    skipOptionalTools,
  });
  const mcpMemoryOk = memoryPolicy.action === MCP_MEMORY_SETUP_ACTION.SKIP
    ? (
        skip(`${C.dim}${
          memoryPolicy.reason === MCP_MEMORY_SETUP_REASON.GLOBAL_HOOKS_REQUIRED
            ? t.mcpMemoryRequiresGlobalHooks
            : t.mcpMemorySkipped
        }${C.reset}`),
        INSTALL_STEP_OUTCOME.SKIPPED
      )
    : await withProgress(
        t.stepLabel(stepNum, t.progressInstallMcpMemory),
        async () => installMcpMemoryServiceStep(false, activeTargets),
      );
  stepResults.push(
    installStep(
      t.progressInstallMcpMemory,
      mcpMemoryOk === undefined ? INSTALL_STEP_OUTCOME.SKIPPED : mcpMemoryOk,
      INSTALL_STEP_CLASSIFICATION.OPTIONAL,
    ),
  );

  // Memory can add its uniquely-owned Python hook, SessionStart fragment, and
  // command subtree after global sync. Refresh only after those writes so a
  // successful setup never leaves the capability inventory stale immediately.
  if (needGlobal) {
    stepNum++;
    const inventoryOk = await withProgress(
      t.stepLabel(stepNum, t.refreshGlobalCapabilityInventory),
      async () => refreshGlobalCapabilityInventory(activeTargets),
    );
    stepResults.push(installStep(t.refreshGlobalCapabilityInventory, inventoryOk));
  }

  // Copy runtime files to user-chosen project directories (if opted in earlier)
  let deployResults = [];
  if (deployDirs.length > 0) {
    deployResults = await copyToDeployDirs(activeTargets, deployDirs);
    stepResults.push(
      installStep(
        t.projectDeployBatchHeading(deployDirs.length),
        deployResults.length === deployDirs.length &&
          deployResults.every(
            (item) => item.status === "ok" && item.stateStatus === "ready",
          ),
      ),
    );
  }

  stepNum++;
  const runtimeBindingsOk = await withProgress(
    t.stepLabel(stepNum, "runtime executable bindings"),
    async () => refreshRuntimeExecutableBindings(activeTargets, installScope, deployDirs),
  );
  stepResults.push(installStep("runtime executable bindings", runtimeBindingsOk));

  // Validate the installed global/project artifacts. Public package installs
  // must not depend on maintainer-only repository files such as .gitignore.
  stepNum++;
  let runtimeSyncOk = true;
  const validationOk = await withProgress(t.stepLabel(stepNum, t.progressValidate), async () => {
    if (needProject) {
      runtimeSyncOk = checkSync(runtimes, activeTargets);
    }
    return validateInstalledArtifacts({
      installScope,
      activeTargets,
      projectSyncOk: runtimeSyncOk,
      projectDeployResults: deployResults,
    });
  });
  if (needProject) {
    stepResults.push(installStep(t.syncHeading, runtimeSyncOk));
  }
  stepResults.push(installStep(t.progressValidate, validationOk));

  if (
    needProject &&
    summarizeInstallStatus(stepResults).status === "complete" &&
    deployResults.some((item) => item.status === "ok")
  ) {
    const stateOk = rememberProjectProjectionMode(
      deployResults.filter((item) => item.status === "ok").map((item) => item.dir),
    );
    stepResults.push(installStep(t.projectDeploySummary, stateOk));
  }

  let result = {
    ...summarizeInstallStatus(stepResults),
    rejectedManagedProjects: managedProjectResolution.rejected,
  };

  if (result.status === "complete") {
    console.log(`\n${C.bold}${C.green}✓ ${t.installComplete}${C.reset}\n`);
  } else {
    printInstallResult(result, t.installComplete);
  }

  if (result.status === "complete") {
    showNextSteps(runtimes, activeTargets);
  } else {
    showInstallRecovery(result, "install");
  }
  return result;
}

async function runUpdate() {
  const stepResults = [];
  heading(t.updateHeading);
  const runtimes = await detectRuntimes();
  const reselectTargets = await askYesNo(t.askReselectRuntimes, true);
  const activeTargets = reselectTargets
    ? await selectActiveTargets(runtimes)
    : (await resolveTargetContext(args)).activeTargets;
  const { profiles: runtimeProfiles } = await resolveTargetContext(args);

  // ── 0. Ask for update scope (like install mode) ─────────────────────
  const updateScope = await askInstallScope();
  const needProject = updateScope === "project";
  const needGlobal = updateScope === "global";

  // Ask proxy configuration (saves to localOverrides)
  await askProxyConfig();

  // Ask project deploy directories BEFORE update starts
  const managedProjectResolution = needProject
    ? { deployments: await askDeployDirectory(), rejected: [] }
    : await existingManagedProjectDeployments();
  const deployDirs = managedProjectResolution.deployments;
  reportRejectedManagedProjectTargets(managedProjectResolution.rejected);
  if (managedProjectResolution.rejected.some((item) => item.source === "explicit_project_dirs")) {
    stepResults.push(installStep(t.managedProjectRejectedStep, false));
  }
  if (needGlobal) info(t.globalManagedProjectRefreshInfo(deployDirs.length));

  // ── 1. npm install (always — new code may have new deps) ────────────
  info(t.updateNpm);
  const npmResult = spawnCliSync("npm", ["install"], {
    cwd: PROJECT_DIR,
    stdio: "inherit",
  });
  if (npmResult.status === 0) ok(t.npmDone);
  else warn(t.npmFailed);
  stepResults.push(installStep(t.updateNpm, npmResult.status === 0));

  // ── 2. [Optional] Python tools (graphify) ─────────────────────────
  console.log("");
  let pythonToolsOutcome = INSTALL_STEP_OUTCOME.SKIPPED;
  if (skipOptionalTools) {
    skip(`${C.dim}${t.pythonToolsSkipped}${C.reset}`);
  } else {
    const wantPython = await askYesNo(t.askPythonToolsUpdate, true);
    if (wantPython) {
      pythonToolsOutcome = await installPythonTools(activeTargets, true, PROJECT_DIR, {
        projectWiring: needProject,
      });
    } else {
      skip(`${C.dim}${t.pythonToolsSkipped}${C.reset}`);
    }
  }
  stepResults.push(
    installStep(
      t.progressInstallPython,
      pythonToolsOutcome,
      INSTALL_STEP_CLASSIFICATION.OPTIONAL,
    ),
  );

  // ── 2.8. Clean up legacy skill files ───────────────────────────────
  const legacyCount = cleanupLegacySkills(updateScope);
  if (legacyCount > 0) ok(`Cleaned ${legacyCount} legacy file(s)`);

  // ── 3. sync-runtimes (scope from user selection) ──────────────────
  if (needProject) {
    info(t.updateSyncProjectFiles);
    const syncResult = runNodeScript(SETUP_NODE_CHILD.RUNTIME_SYNC, [
      "--scope",
      updateScope,
      "--targets",
      activeTargets.join(","),
    ]);
    if (syncResult.status === 0) ok(t.updateSyncDone);
    else warn(t.updateSyncSkip);
    stepResults.push(installStep(t.updateSyncProjectFiles, syncResult.status === 0));
  }

  // ── 4. Global skills update ───────────────────────────────────────
  console.log("");
  if (needGlobal) {
    const updateSkillIds = await resolveSelectedSkillDependencyIds();
    const localOverrides = await loadLocalOverrides();
    const proxyEnv = localOverrides.gitProxy
      ? { META_KIM_GIT_PROXY: localOverrides.gitProxy }
      : {};
    const updateSkillArgs = buildGlobalSkillsInstallerArgs({
      targets: activeTargets,
      skillIds: updateSkillIds,
      update: true,
      preferLocalDependencies,
      skipInventoryRefresh: true,
    });
    // ).concat(["--log-file", INSTALL_LOG_FILE]);
    const updateInstallResult = runNodeScript(
      SETUP_NODE_CHILD.GLOBAL_SKILLS_INSTALLER,
      updateSkillArgs,
      proxyEnv,
    );
    if (updateInstallResult.status === 0) ok(t.updateSkillsDone);
    else {
      warn(t.warnSkillsUpdateFailed);
      warn(`${C.dim}${t.warnSkillsUpdateFailedHint}${C.reset}`);
    }
    stepResults.push(
      installStep(t.progressInstallSkills, updateInstallResult.status === 0),
    );
  }

  // ── 5. Global meta-theory sync ────────────────────────────────────
  console.log("");
  if (needGlobal) {
    const updateSyncResult = runNodeScript(
      SETUP_NODE_CHILD.GLOBAL_META_THEORY_SYNC,
      metaTheoryGlobalSyncArgs(activeTargets, setupWithGlobalHooks),
    );
    const runtimeAssetsOk = syncOwnedGlobalRuntimeAssets(
      activeTargets,
      runtimeProfiles,
      setupWithGlobalHooks,
    );
    if (updateSyncResult.status === 0 && runtimeAssetsOk)
      ok(t.updateMetaTheoryDone);
    else warn(t.warnMetaTheoryUpdateFailed);
    stepResults.push(
      installStep(
        t.progressSyncMeta,
        updateSyncResult.status === 0 && runtimeAssetsOk,
      ),
    );
  }

  // ── 5.2 [Optional] MCP Memory Service (Layer 3) ─────────────────
  // Global sync renders shared runtime assets first. The memory installer can
  // then prove the ownership handoff before installing its unique assets,
  // without treating rendered Meta_Kim commands as memory-owned files.
  console.log("");
  const memoryPolicy = resolveMcpMemorySetupPolicy({
    needGlobal,
    withGlobalHooks: setupWithGlobalHooks,
    skipOptionalTools,
  });
  const mcpMemoryOk = memoryPolicy.action === MCP_MEMORY_SETUP_ACTION.SKIP
    ? (
        skip(`${C.dim}${
          memoryPolicy.reason === MCP_MEMORY_SETUP_REASON.GLOBAL_HOOKS_REQUIRED
            ? t.mcpMemoryRequiresGlobalHooks
            : t.mcpMemorySkipped
        }${C.reset}`),
        INSTALL_STEP_OUTCOME.SKIPPED
      )
    : await installMcpMemoryServiceStep(true, activeTargets);
  stepResults.push(
    installStep(
      t.progressInstallMcpMemory,
      mcpMemoryOk === undefined ? INSTALL_STEP_OUTCOME.SKIPPED : mcpMemoryOk,
      INSTALL_STEP_CLASSIFICATION.OPTIONAL,
    ),
  );

  // ── 5.5. Refresh global capability inventory ───────────────────────
  console.log("");
  if (needGlobal) {
    await refreshGlobalCapabilityInventory(activeTargets);
  }

  // Copy runtime files before validating their final target state.
  let deployResults = [];
  if (deployDirs.length > 0) {
    deployResults = await copyToDeployDirs(activeTargets, deployDirs);
    stepResults.push(
      installStep(
        t.projectDeployBatchHeading(deployDirs.length),
        deployResults.length === deployDirs.length &&
          deployResults.every(
            (item) => item.status === "ok" && item.stateStatus === "ready",
          ),
      ),
    );
  }

  const runtimeBindingsOk = refreshRuntimeExecutableBindings(activeTargets, updateScope, deployDirs);
  stepResults.push(installStep("runtime executable bindings", runtimeBindingsOk));

  // ── 6. Validate installed artifacts, not the package source tree ───
  if (needGlobal) {
    stepResults.push(
      installStep(
        t.refreshGlobalCapabilityInventory,
        lastGlobalCapabilityInventoryResult,
      ),
    );
  }
  let updateRuntimeSyncOk = true;
  if (needProject) {
    updateRuntimeSyncOk = checkSync(runtimes, activeTargets);
    stepResults.push(installStep(t.syncHeading, updateRuntimeSyncOk));
  }
  stepResults.push(
    installStep(
      t.progressValidate,
      await validateInstalledArtifacts({
        installScope: updateScope,
        activeTargets,
        projectSyncOk: updateRuntimeSyncOk,
        projectDeployResults: deployResults,
      }),
    ),
  );
  if (
    needProject &&
    summarizeInstallStatus(stepResults).status === "complete" &&
    deployResults.some((item) => item.status === "ok")
  ) {
    const stateOk = rememberProjectProjectionMode(
      deployResults.filter((item) => item.status === "ok").map((item) => item.dir),
    );
    stepResults.push(installStep(t.projectDeploySummary, stateOk));
  }
  let result = {
    ...summarizeInstallStatus(stepResults),
    rejectedManagedProjects: managedProjectResolution.rejected,
  };
  if (result.status === "complete") {
    console.log(`\n${C.bold}${C.green}✓ ${t.updateComplete}${C.reset}\n`);
  } else {
    printInstallResult(result, t.updateComplete);
    showInstallRecovery(result, "update");
  }
  return result;
}

async function runCheck() {
  console.log(`\n${C.green}✓ ${t.envOk}${C.reset}\n`);
  const runtimes = await detectRuntimes();
  const targetContext = await resolveTargetContext(args);
  const syncOk = checkProjectRuntimeSync(runtimes, targetContext);
  console.log(
    `${C.dim}${t.checkTargets(targetContext.activeTargets.join(", "), targetContext.supportedTargets.join(", "))}${C.reset}`,
  );
  reportProjectRuntimeSyncResult(syncOk);
  return syncOk;
}

main().catch((err) => {
  const msg = err?.message || String(err);
  const interrupted =
    msg.includes("SIGINT") ||
    msg.includes("force closed") ||
    err?.name === "ExitPromptError";
  if (interrupted) {
    console.error(`\n${C.dim}  ${t.setupInterrupted}${C.reset}\n`);
    process.exit(130);
  }
  console.error(`\n${C.red}  ${t.setupError} ${msg}${C.reset}\n`);
  process.exit(1);
});
