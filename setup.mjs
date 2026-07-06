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
import http from "node:http";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  cpSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve, isAbsolute, relative } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import {
  ensureProfileState,
  toRepoRelative,
} from "./scripts/meta-kim-local-state.mjs";
import {
  detectPython310,
  extractPipShowVersion,
  readProcessText,
  runPythonModule,
  checkNetworkx,
} from "./scripts/graphify-runtime.mjs";
import { resolveManifestSkillSubdir } from "./scripts/install-platform-config.mjs";
import { buildNodeScriptSpawn } from "./scripts/node-spawn-config.mjs";
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
  stripProjectMetaKimHooksFromHookConfig,
} from "./scripts/runtime-hook-mapping.mjs";
import {
  loadLocalOverrides,
  normalizeTargets,
  parseSkillsArg,
  resolveTargetContext,
  resolveRuntimeHomeDir,
  writeLocalOverrides,
} from "./scripts/meta-kim-sync-config.mjs";
import {
  MIN_NODE_VERSION,
  isSupportedNodeVersion,
} from "./scripts/node-runtime-requirements.mjs";

// ── Config ──────────────────────────────────────────────

const PROJECT_DIR = resolve(import.meta.dirname || ".");
const SKILLS_DIR = join(resolveRuntimeHomeDir("claude"), "skills");
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const isWin = platform() === "win32";
const args = process.argv.slice(2);
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
// Global hook projection policy:
//   - Fresh install (`npx meta-kim`, `node setup.mjs` without --update):
//     install global hooks by default so first-time users get the full
//     governance surface (enforce-agent-dispatch, stop-completion-guard,
//     fan-out gate, etc.) without needing to know an opt-in flag.
//   - Update (`--update` / `-u`): keep opt-in to avoid silently
//     overwriting a user-local hook that was hand-edited between releases.
//   - Explicit overrides win: `--with-global-hooks` (force on, including
//     during update) or `--without-global-hooks` (force off, including
//     during install).
const setupWithGlobalHooks =
  args.includes("--with-global-hooks") ||
  process.env.META_KIM_WITH_GLOBAL_HOOKS === "1" ||
  (!args.includes("--without-global-hooks") && !updateMode);

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

const RUNTIME_CHOICES = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "openclaw", label: "OpenClaw" },
  { id: "cursor", label: "Cursor" },
];

function normalizeProjectDeployDir(rawDir) {
  const raw = String(rawDir || "").trim();
  if (!raw) return null;
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  if (raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return resolve(raw);
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

/** Load skills manifest from shared config (single source of truth) */
function loadSkillsManifest() {
  const manifestPath = join(PROJECT_DIR, "config", "skills.json");
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw);

    // Allow env var override
    const skillOwner =
      process.env.META_KIM_SKILL_OWNER || manifest.skillOwner || "KimYx0207";

    // Transform manifest to legacy format for compatibility
    return {
      skillOwner,
      externalUrls: manifest.externalUrls || {},
      skills: manifest.skills.map((skill) => {
        const repo = skill.repo.replace("${skillOwner}", skillOwner);
        const subdir = resolveManifestSkillSubdir(skill, platform(), {
          fallbackToFindskillPack: true,
        });

        return {
          name: skill.id,
          repo,
          subdir,
          claudePlugin: skill.claudePlugin,
          defaultSelected: skill.defaultSelected ?? true,
          targets: skill.targets || ["claude", "codex", "openclaw"],
        };
      }),
    };
  } catch (err) {
    warn(t.warnManifestLoadFail(err.message));
    return { skillOwner: "KimYx0207", externalUrls: {}, skills: [] };
  }
}

const skillsManifest = loadSkillsManifest();
const SKILL_OWNER = skillsManifest.skillOwner;
const SKILLS = skillsManifest.skills;
const EXTERNAL_URLS = skillsManifest.externalUrls;

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
import { buildI18N } from "./config/i18n/setup-strings.mjs";
const I18N = buildI18N({ MIN_NODE_VERSION });

let t = I18N.en; // default, overwritten by selectLanguage()
let quickDeployDir = null; // first deploy target shown in legacy next-step text
let quickDeployDirs = []; // set by quick deploy / project deploy exports

function detectNpxMode() {
  const normalized = PROJECT_DIR.replace(/\\/g, "/").toLowerCase();
  return normalized.includes("_npx") || normalized.includes("npm-cache");
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
    await fn();
    return true;
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
  "skip-reminder.mjs",
  "stop-compaction.mjs",
  "stop-completion-guard.mjs",
  "stop-console-log-audit.mjs",
  "stop-memory-save.mjs",
  "stop-save-progress.mjs",
  "stop-spine-cleanup.mjs",
  "subagent-context.mjs",
  "utils.mjs",
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
  claude: [
    ...GLOBAL_HOOK_PACKAGE_FILES_LIST,
    "spine-state.mjs",
  ],
  codex: [
    "activate-meta-theory-spine.mjs",
    "bash-readonly-whitelist.mjs",
    "enforce-agent-dispatch.mjs",
    "graphify-context.mjs",
    "post-console-log-warn.mjs",
    "post-format.mjs",
    "post-typecheck.mjs",
    "skip-reminder.mjs",
    "spine-state.mjs",
    "spine-state-utils.mjs",
    "stop-compaction.mjs",
    "stop-completion-guard.mjs",
    "stop-console-log-audit.mjs",
    "stop-spine-cleanup.mjs",
    "subagent-context.mjs",
    "utils.mjs",
  ],
  cursor: [
    "activate-meta-theory-spine.mjs",
    "bash-readonly-whitelist.mjs",
    "enforce-agent-dispatch.mjs",
    "graphify-context.mjs",
    "post-console-log-warn.mjs",
    "post-format.mjs",
    "post-typecheck.mjs",
    "skip-reminder.mjs",
    "spine-state.mjs",
    "spine-state-utils.mjs",
    "stop-compaction.mjs",
    "stop-completion-guard.mjs",
    "stop-console-log-audit.mjs",
    "stop-spine-cleanup.mjs",
    "subagent-context.mjs",
    "utils.mjs",
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
  const candidates = [];
  if (platformId === "claude") {
    candidates.push(
      join(PROJECT_DIR, "canonical", "runtime-assets", "claude", "hooks", hookName),
    );
  }
  candidates.push(
    join(PROJECT_DIR, "canonical", "runtime-assets", "shared", "hooks", hookName),
  );
  candidates.push(
    join(PROJECT_DIR, "canonical", "runtime-assets", "claude", "hooks", hookName),
  );
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return readFileSync(candidate, "utf8");
  }
  return null;
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

function buildOpenClawWorkspacePlans(targetDir) {
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
      ),
    ),
  );
}

function projectHookGeneratedPlans(platformId, targetDir) {
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
      ));
    }
  }
  if (platformId === "openclaw") {
    plans.push(...buildOpenClawWorkspacePlans(targetDir));
  }
  return plans;
}

function writeProjectGeneratedHooks(platformId, targetDir) {
  let count = 0;
  for (const plan of projectHookGeneratedPlans(platformId, targetDir)) {
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
  return (
    GLOBAL_HOOK_PACKAGE_FILES_LIST.includes(fileName) ||
    fileName === "spine-state.mjs" // legacy ghost file from older Meta_Kim installs
  );
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

function backupBeforeMerge(destPath, label = "pre-merge") {
  if (!destPath) return null;
  if (!existsSync(destPath)) return null;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupRoot = join(
      PROJECT_DIR,
      ".meta-kim",
      "backups",
      `${label}-${stamp}`,
    );
    const safeBase = String(destPath).replace(/[\\/]+/g, "__");
    const backupPath = join(backupRoot, safeBase);
    mkdirSync(dirname(backupPath), { recursive: true });
    cpSync(destPath, backupPath);
    return backupPath;
  } catch (err) {
    warn(t?.warnBackupFailed?.(destPath, err.message) || `Backup failed for ${destPath}: ${err.message}`);
    return null;
  }
}

function mergeProtectedProjectDeployFile(srcPath, destPath, relPath, targetDir) {
  backupBeforeMerge(destPath, "pre-merge");
  writeJsonObject(
    destPath,
    plannedProtectedProjectDeployJson(srcPath, destPath, relPath, targetDir),
  );
  return 1;
}

function mergeProtectedProjectDeployTextFile(srcPath, destPath, relPath, targetDir) {
  backupBeforeMerge(destPath, "pre-merge");
  writeFileSync(
    destPath,
    plannedProtectedProjectDeployText(srcPath, destPath, relPath, targetDir),
    "utf8",
  );
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

function copyProjectDeployFile(srcPath, destPath, relPath, targetDir) {
  const rel = normalizeDeployRelPath(relPath);
  if (shouldSkipProjectDeployPath(rel)) return 0;
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
      });
    } else {
      count += copyProjectDeployFile(srcPath, destPath, relPath, targetDir);
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
          destRelBase: context.destRelBase,
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
  const skipped = shouldSkipProjectDeployPath(rel);
  const protectedJson = DEPLOY_PROTECTED_JSON_PATHS.has(rel);
  const protectedText = DEPLOY_PROTECTED_TEXT_PATHS.has(rel);
  const exists = existsSync(destPath);
  const contentStatus = projectDeployFileContentStatus(srcPath, destPath, rel, {
    skipped,
    protectedJson,
    protectedText,
    targetDir,
  });
  const managedByManifest = context.managedRelPaths?.has(rel) === true;
  const metaKimOwnedPath = isMetaKimNamespacedProjectPath(rel);
  const unknownExistingConflict =
    exists &&
    contentStatus !== "same" &&
    !skipped &&
    !protectedJson &&
    !protectedText &&
    !managedByManifest &&
    !metaKimOwnedPath;
  const mergePolicy = skipped
    ? "never_touch"
    : protectedJson
      ? "additive_preserve_user_state_json"
      : protectedText
        ? "managed_block_preserve_user_text"
        : unknownExistingConflict
          ? "user_owned_existing_file_conflict"
        : exists
          ? managedByManifest
            ? "manifest_managed_projection_replace"
            : "meta_kim_namespaced_projection_replace"
          : "generated_projection_create";
  return {
    relPath: rel,
    source: normalizeDeployRelPath(relative(PROJECT_DIR, srcPath)),
    exists,
    contentStatus,
    ownership: skipped
      ? "local_state"
      : protectedJson || protectedText
        ? "shared_config_merge"
        : managedByManifest
          ? "manifest_managed"
          : metaKimOwnedPath
            ? "meta_kim_owned"
            : exists
              ? "unknown_existing"
              : "new_file",
    action: skipped
      ? "skip"
      : protectedText
        ? "merge"
        : exists && protectedJson
        ? "merge"
        : unknownExistingConflict
          ? "conflict"
        : exists
          ? "replace"
          : "create",
    effectiveAction:
      skipped || contentStatus === "same"
        ? "unchanged"
        : protectedText
          ? "merge"
          : exists && protectedJson
          ? "merge"
          : unknownExistingConflict
            ? "conflict"
          : exists
            ? "replace"
            : "create",
    mergePolicy,
  };
}

function projectGeneratedFilePlan(relPath, content, targetDir, source) {
  const rel = normalizeDeployRelPath(relPath);
  const destPath = join(targetDir, rel);
  const exists = existsSync(destPath);
  const current = exists ? readFileSync(destPath, "utf8") : null;
  const contentStatus = !exists ? "missing" : current === content ? "same" : "different";
  return {
    relPath: rel,
    source,
    content,
    exists,
    contentStatus,
    ownership: isMetaKimNamespacedProjectPath(rel)
      ? "meta_kim_owned"
      : exists
        ? "unknown_existing"
        : "new_file",
    action: exists ? "replace" : "create",
    effectiveAction: contentStatus === "same" ? "unchanged" : exists ? "replace" : "create",
    mergePolicy: exists
      ? "meta_kim_namespaced_projection_replace"
      : "generated_projection_create",
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
  for (const platformId of activeTargets) {
    for (const root of projectDeployRootsForPlatform(platformId)) {
      const src = join(PROJECT_DIR, root.srcRel);
      const dest = join(targetDir, root.destRel);
      for (const plan of collectDeployFilePlansFromRoot(src, dest, {
        sourceRoot: root.destRel !== root.srcRel ? src : PROJECT_DIR,
        targetDir,
        managedRelPaths,
        destRelBase: root.destRel !== root.srcRel ? root.destRel : null,
      })) {
        if (seen.has(plan.relPath)) continue;
        seen.add(plan.relPath);
        plans.push(plan);
      }
    }
    for (const plan of projectHookGeneratedPlans(platformId, targetDir)) {
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
  return join(targetDir, ".meta-kim", "state", "default", "project-bootstrap.json");
}

function readProjectBootstrapManifest(targetDir) {
  const manifestPath = projectBootstrapManifestPath(targetDir);
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
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

function isProjectLocalCapabilityAsset(relPath) {
  const rel = normalizeDeployRelPath(relPath);
  if (!rel || PROJECT_BOOTSTRAP_MERGED_CONFIG_PATHS.has(rel)) return false;
  return PROJECT_LOCAL_CAPABILITY_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function projectInstructionRelPathsForTargets(activeTargets) {
  const targets = activeTargets.includes("all")
    ? ["claude", "codex", "cursor", "openclaw"]
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
  if (!existsSync(targetPath) || !existsSync(sourcePath)) return false;
  const stats = statSync(targetPath);
  if (!stats.isFile()) return false;
  const current = readFileSync(targetPath, "utf8");
  const generated = rewriteProjectDirRefs(readFileSync(sourcePath, "utf8"), targetDir);
  const userText = stripManagedTextBlock(current, rel);
  const metaKimProjectionSignature =
    (rel === "AGENTS.md" && userText.trimStart().startsWith("# Meta_Kim for Codex")) ||
    (rel === "CLAUDE.md" &&
      userText.trimStart().startsWith("# Meta_Kim for Claude Code"));
  return (
    equivalentText(current, generated) ||
    equivalentText(userText, "") ||
    equivalentText(userText, generated) ||
    metaKimProjectionSignature
  );
}

function removeRedundantProjectInstructionFiles(targetDir, activeTargets) {
  const removed = [];
  const skipped = [];
  const root = resolve(targetDir);
  for (const relPath of projectInstructionRelPathsForTargets(activeTargets)) {
    const rel = normalizeDeployRelPath(relPath);
    const absPath = resolve(targetDir, rel);
    if (!isPathInsideDir(absPath, root)) {
      skipped.push({ relPath: rel, reason: "outside_target_dir" });
      continue;
    }
    if (!isRedundantProjectInstructionFile(targetDir, rel)) continue;
    if (!removeUntrackedProjectPath(targetDir, rel, skipped, { recursive: false })) {
      continue;
    }
    removed.push(rel);
    pruneEmptyProjectDirs(targetDir, rel);
  }
  return { removed, skipped };
}

function projectAssetCleanupBucket(relPath) {
  const rel = normalizeDeployRelPath(relPath);
  const runtime = rel.startsWith(".claude/")
    ? "Claude Code"
    : rel.startsWith(".codex/") || rel.startsWith(".agents/")
      ? "Codex"
      : rel.startsWith(".cursor/")
        ? "Cursor"
        : rel.startsWith("openclaw/")
          ? "OpenClaw"
          : "Other";
  const type = rel.includes("/agents/") || rel.startsWith("openclaw/workspaces/")
    ? "agents"
    : rel.includes("/skills/")
      ? "skills"
      : rel.includes("/commands/")
        ? "Commands"
        : rel.includes("/hooks/")
          ? "hooks"
          : rel.includes("/rules/")
            ? "rules"
            : rel.includes("/capability-index/")
              ? "capability-index"
              : "assets";
  return `${runtime} ${type}`;
}

function summarizeProjectAssetCleanup(removed) {
  const counts = new Map();
  for (const relPath of removed) {
    const bucket = projectAssetCleanupBucket(relPath);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, count]) => `${bucket}: ${count}`);
}

function isPathInsideDir(absPath, absDir) {
  const rel = relative(absDir, absPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
  if (!isPathInsideDir(absPath, root)) {
    skipped.push({ relPath: rel, reason: "outside_target_dir" });
    return false;
  }
  if (!existsSync(absPath)) return false;
  if (isGitTrackedProjectPath(targetDir, rel)) {
    skipped.push({ relPath: rel, reason: "git_tracked_preserved" });
    return false;
  }
  rmSync(absPath, { recursive: options.recursive !== false, force: true });
  return true;
}

function pruneEmptyProjectDirs(targetDir, relPath, removedDirs = null) {
  let currentDir = dirname(join(targetDir, normalizeDeployRelPath(relPath)));
  const root = resolve(targetDir);
  while (currentDir !== root && isPathInsideDir(currentDir, root)) {
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
  const currentRelPaths = new Set(
    currentFilePlans.map((file) => normalizeDeployRelPath(file.relPath)).filter(Boolean),
  );
  const previousRelPaths = previousProjectManagedRelPaths(targetDir);
  const removed = [];
  const skipped = [];
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
    if (!removeUntrackedProjectPath(targetDir, relPath, skipped, { recursive: false })) {
      continue;
    }
    removed.push(relPath);
    pruneEmptyProjectDirs(targetDir, relPath);
  }

  return { removed, skipped };
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

function mergeProjectCleanupResults(...cleanups) {
  return {
    removed: cleanups.flatMap((cleanup) => cleanup?.removed ?? []),
    skipped: cleanups.flatMap((cleanup) => cleanup?.skipped ?? []),
  };
}

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
  const root = resolve(targetDir);

  for (const relPath of legacyProjectCapabilityRelPaths(activeTargets)) {
    const rel = normalizeDeployRelPath(relPath);
    const absPath = resolve(targetDir, rel);
    if (!isPathInsideDir(absPath, root)) {
      skipped.push({ relPath: rel, reason: "outside_target_dir" });
      continue;
    }
    if (!existsSync(absPath)) continue;
    if (!removeUntrackedProjectPath(targetDir, rel, skipped)) continue;
    removed.push(rel);
    pruneEmptyProjectDirs(targetDir, rel);
  }

  return { removed, skipped };
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
    if (!removeUntrackedProjectPath(targetDir, rel, skipped)) continue;
    removed.push(rel);
    pruneEmptyProjectDirs(targetDir, rel);
  }

  return { removed, skipped };
}

function expandedCleanupTargets(activeTargets) {
  return activeTargets.includes("all")
    ? ["claude", "codex", "cursor", "openclaw"]
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

function removeMetaKimGeneratedProjectSkillResidue(targetDir, activeTargets) {
  const removed = [];
  const skipped = [];
  const root = resolve(targetDir);
  for (const relRoot of targetValuesForPlatforms(PROJECT_SKILL_ROOTS_BY_PLATFORM, activeTargets)) {
    const absRoot = resolve(targetDir, relRoot);
    if (!isPathInsideDir(absRoot, root)) {
      skipped.push({ relPath: normalizeDeployRelPath(relRoot), reason: "outside_target_dir" });
      continue;
    }
    if (!existsSync(absRoot)) continue;
    for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absPath = join(absRoot, entry.name);
      const relPath = normalizeDeployRelPath(relative(targetDir, absPath));
      if (!isMetaKimGeneratedSkillDirectory(absPath)) continue;
      if (!removeUntrackedProjectPath(targetDir, relPath, skipped)) continue;
      removed.push(relPath);
      pruneEmptyProjectDirs(targetDir, relPath);
    }
  }
  return { removed, skipped };
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
  if (!expandedCleanupTargets(activeTargets).includes("openclaw")) {
    return { removed, skipped };
  }
  const root = resolve(targetDir);
  const hookRoot = resolve(targetDir, "openclaw/hooks");
  if (isPathInsideDir(hookRoot, root) && existsSync(hookRoot)) {
    for (const entry of readdirSync(hookRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absPath = join(hookRoot, entry.name);
      const relPath = normalizeDeployRelPath(relative(targetDir, absPath));
      if (!isMetaKimOpenClawHookDirectory(absPath)) continue;
      if (!removeUntrackedProjectPath(targetDir, relPath, skipped)) continue;
      removed.push(relPath);
      pruneEmptyProjectDirs(targetDir, relPath);
    }
  } else if (!isPathInsideDir(hookRoot, root)) {
    skipped.push({ relPath: "openclaw/hooks", reason: "outside_target_dir" });
  }

  const workspaceRoot = resolve(targetDir, "openclaw/workspaces");
  if (isPathInsideDir(workspaceRoot, root) && existsSync(workspaceRoot)) {
    for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("meta-")) continue;
      const absPath = join(workspaceRoot, entry.name);
      const relPath = normalizeDeployRelPath(relative(targetDir, absPath));
      if (directoryContainsFiles(absPath)) continue;
      if (!removeUntrackedProjectPath(targetDir, relPath, skipped)) continue;
      removed.push(relPath);
      pruneEmptyProjectDirs(targetDir, relPath);
    }
  } else if (!isPathInsideDir(workspaceRoot, root)) {
    skipped.push({ relPath: "openclaw/workspaces", reason: "outside_target_dir" });
  }

  return { removed, skipped };
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

function cleanupRedundantProjectConfigs(targetDir, activeTargets, currentFilePlans = []) {
  const removed = [];
  const skipped = [];
  const root = resolve(targetDir);
  const relPaths = targetValuesForPlatforms(
    PROJECT_META_KIM_CONFIG_RELS_BY_PLATFORM,
    activeTargets,
  );
  for (const relPath of relPaths) {
    const rel = normalizeDeployRelPath(relPath);
    const absPath = resolve(targetDir, rel);
    if (!isPathInsideDir(absPath, root)) {
      skipped.push({ relPath: rel, reason: "outside_target_dir" });
      continue;
    }
    if (!existsSync(absPath)) continue;
    const current = readJsonObjectIfExists(absPath);
    if (!current) continue;
    const stripped = stripMetaKimProjectConfig(rel, current);
    const shouldDelete =
      isEmptyProjectConfigShell(stripped) ||
      isGeneratedOnlyProjectConfig(targetDir, rel, stripped, currentFilePlans);
    if (shouldDelete) {
      if (!removeUntrackedProjectPath(targetDir, rel, skipped, { recursive: false })) {
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
      backupBeforeMerge(absPath, "pre-strip");
      writeJsonObject(absPath, stripped);
    }
  }
  return { removed, skipped };
}

function isMetaKimProjectTaskState(filePath) {
  const raw = readTextIfFile(filePath);
  return raw.includes("auto-save from Stop hook") && raw.includes("meta_kim");
}

function removeMetaKimProjectLocalState(targetDir) {
  const removed = [];
  const skipped = [];
  const root = resolve(targetDir);
  for (const relPath of PROJECT_META_KIM_LOCAL_STATE_RELS) {
    const rel = normalizeDeployRelPath(relPath);
    const absPath = resolve(targetDir, rel);
    if (!isPathInsideDir(absPath, root)) {
      skipped.push({ relPath: rel, reason: "outside_target_dir" });
      continue;
    }
    if (!existsSync(absPath)) continue;
    if (rel === ".claude/project-task-state.json" && !isMetaKimProjectTaskState(absPath)) {
      skipped.push({ relPath: rel, reason: "local_state_not_meta_kim_signed" });
      continue;
    }
    if (!removeUntrackedProjectPath(targetDir, rel, skipped)) continue;
    removed.push(rel);
    pruneEmptyProjectDirs(targetDir, rel, removed);
  }
  return { removed, skipped };
}

function pruneEmptyDirsPostOrder(absDir, targetRoot, removed, targetDir) {
  if (!existsSync(absDir) || !isPathInsideDir(absDir, targetRoot)) return;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    pruneEmptyDirsPostOrder(join(absDir, entry.name), targetRoot, removed, targetDir);
  }
  if (absDir === targetRoot) return;
  const entries = readdirSync(absDir);
  if (entries.length > 0) return;
  rmSync(absDir, { recursive: true, force: true });
  removed.push(normalizeDeployRelPath(relative(targetDir, absDir)));
}

function pruneEmptyProjectRuntimeDirs(targetDir, activeTargets) {
  const removed = [];
  const skipped = [];
  const root = resolve(targetDir);
  const roots = [
    ...targetValuesForPlatforms(PROJECT_SKILL_ROOTS_BY_PLATFORM, activeTargets),
    ".agents",
    ".claude",
    ".codex",
    "openclaw",
    ".cursor",
  ];
  for (const relRoot of [...new Set(roots)]) {
    const absRoot = resolve(targetDir, relRoot);
    if (!isPathInsideDir(absRoot, root)) {
      skipped.push({ relPath: normalizeDeployRelPath(relRoot), reason: "outside_target_dir" });
      continue;
    }
    if (!existsSync(absRoot)) continue;
    pruneEmptyDirsPostOrder(absRoot, root, removed, targetDir);
  }
  return { removed, skipped };
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
    backupBeforeMerge(configPath, "pre-strip-hooks");
    writeJsonObject(configPath, stripped);
    changed.push(relPath);
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
      status === "ready"
        ? "Project bootstrap manifest and project-specific files are current; no project write is needed."
        : status === "conflict"
          ? "Existing project files overlap Meta_Kim generated paths but are not known to be Meta_Kim-owned; resolve conflicts before apply."
          : status === "stale"
          ? "Existing project bootstrap manifest uses a different Meta_Kim version."
          : status === "target_scope_changed"
            ? "Selected runtime targets differ from the previous project bootstrap manifest."
          : status === "missing"
            ? "Project context/config/state or confirmed overrides are missing one or more required files."
            : status === "repair_required"
              ? "Project bootstrap version is current, but managed files need repair, merge, or recreation."
              : "Project has existing or equivalent config but still needs a confirmed bootstrap to record state or apply pending changes.",
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

function buildProjectBootstrapChoiceSurface(state, writePreview) {
  if (!state.requiresConfirmation) {
    return {
      required: false,
      trigger: "no_choice_needed_current",
      header: "Project ready",
      question:
        "Meta_Kim project bootstrap is already current for the selected targets. No project-specific files need to be written, and no confirmation popup should be shown.",
      recommendedOptionId: "continue",
      options: [
        {
          id: "continue",
          label: "Continue",
          expectedResult: "Proceed with the governed run without project-specific bootstrap writes.",
          advantage: "Avoids repeated prompts and leaves the project untouched.",
          risk: "None for the current selected targets.",
          verificationImpact: "Dry-run shows status=ready, requiresConfirmation=false, and zero project writes.",
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
    runtimeRequirement:
      "Claude Code must use AskUserQuestion and Codex must use request_user_input before --apply. Compatibility runtimes may show a labeled chat decision card.",
    header: "Project bootstrap",
    question: [
      `AI understanding: this directory needs Meta_Kim project-specific context/config/state or confirmed overrides for ${targetText}.`,
      `AI additions: dry-run found ${state.status}; ${reason}`,
      "Capability route: reuse global runtime capabilities first, then apply only project-specific context/config/state or confirmed overrides.",
      `Candidate paths: ${
        hasConflicts
          ? "inspect and resolve conflicts, skip this project for now, or apply only after conflicts are resolved"
          : "apply now, inspect only, or skip this project for now"
      }. Pending project writes: ${pendingCount}; conflicts: ${conflictCount}; global writes: ${writePreview.globalWrites.length}.`,
    ].join("\n"),
    recommendedOptionId: hasConflicts ? "inspect_dry_run_only" : "apply_project_bootstrap",
    options: [
      {
        id: "apply_project_bootstrap",
        label: hasConflicts ? "Apply after resolving conflicts" : "Apply project bootstrap (Recommended)",
        expectedResult:
          "Create or update the selected project-specific context/config/state or confirmed overrides, then write the project bootstrap manifest.",
        advantage: "The next meta-theory trigger can proceed without asking again when files remain current.",
        risk: hasConflicts
          ? "Blocked until writePreview.projectConflicts is empty; Meta_Kim will not overwrite unknown user-owned files."
          : "Touches project files listed in writePreview.projectWrites after backup/merge policy.",
        verificationImpact:
          "After apply, a second dry-run must report status=ready, requiresConfirmation=false, pending=0, and projectWrites=0.",
      },
      {
        id: "inspect_dry_run_only",
        label: "Inspect only",
        expectedResult: "Do not write files; keep the dry-run plan for human review.",
        advantage: "Safest when the project owner wants to inspect generated files first.",
        risk: "Meta_Kim can still reuse global capabilities, but project-specific context/config/state may remain stale for this directory.",
        verificationImpact: "No manifest update is written; the next trigger will ask again if state is unchanged.",
      },
      {
        id: "skip_this_project",
        label: "Skip project-local writes",
        expectedResult: "Continue without applying Meta_Kim project-specific files.",
        advantage: "Avoids changing a directory that should rely on global reusable capabilities only.",
        risk: "Only global reusable capabilities remain available; project-specific overrides/config/state are not enabled.",
        verificationImpact: "The run must not claim project-governed readiness for this directory.",
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

function createProjectBootstrapBackup(targetDir, filePlans) {
  const existing = filePlans.filter(
    (plan) =>
      plan.action !== "skip" &&
      plan.effectiveAction !== "unchanged" &&
      plan.effectiveAction !== "conflict" &&
      existsSync(join(targetDir, plan.relPath)),
  );
  if (existing.length === 0) {
    return { created: false, fileCount: 0, entries: [] };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = join(targetDir, ".meta-kim", "backups", "project-bootstrap", stamp);
  const entries = [];
  for (const plan of existing) {
    const from = join(targetDir, plan.relPath);
    const to = join(backupRoot, plan.relPath);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    entries.push({
      relPath: plan.relPath,
      mergePolicy: plan.mergePolicy,
      backupRelPath: normalizeDeployRelPath(relative(targetDir, to)),
    });
  }
  const manifest = {
    schemaVersion: "meta-kim-project-bootstrap-backup-v0.1",
    createdAt: new Date().toISOString(),
    targetDir,
    entries,
  };
  writeJsonObject(join(backupRoot, "backup-manifest.json"), manifest);
  return {
    created: true,
    backupRoot,
    backupRelPath: normalizeDeployRelPath(relative(targetDir, backupRoot)),
    fileCount: entries.length,
    entries,
  };
}

function writeProjectBootstrapManifest(targetDir, plan, backup, cleanup = null) {
  const manifestPath = projectBootstrapManifestPath(targetDir);
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
    managedFiles: plan.files.filter(
      (file) => file.action !== "skip" && file.effectiveAction !== "conflict",
    ),
    skippedFiles: plan.files.filter((file) => file.action === "skip"),
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeJsonObject(manifestPath, manifest);
  return manifestPath;
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
    "skip-reminder.mjs",
    "subagent-context.mjs",
    "stop-compaction.mjs",
    "stop-memory-save.mjs",
    "stop-console-log-audit.mjs",
    "stop-completion-guard.mjs",
    "stop-save-progress.mjs",
    "stop-spine-cleanup.mjs",
    "utils.mjs",
    "spine-state.mjs",
    "spine-state-utils.mjs",
  ]),
  codex: new Set([
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
    "skip-reminder.mjs",
    "spine-state.mjs",
    "spine-state-utils.mjs",
    "stop-compaction.mjs",
    "stop-console-log-audit.mjs",
    "stop-completion-guard.mjs",
    "stop-spine-cleanup.mjs",
    "subagent-context.mjs",
    "utils.mjs",
  ]),
  cursor: new Set([
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
    "skip-reminder.mjs",
    "spine-state.mjs",
    "spine-state-utils.mjs",
    "stop-compaction.mjs",
    "stop-console-log-audit.mjs",
    "stop-completion-guard.mjs",
    "stop-spine-cleanup.mjs",
    "subagent-context.mjs",
    "utils.mjs",
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
  for (const platform of platforms) {
    const relDir = PROJECT_HOOK_DIRS_BY_PLATFORM[platform];
    const whitelist = PROJECT_HOOK_FILE_WHITELIST_BY_PLATFORM[platform];
    if (!relDir || !whitelist) continue;
    const hooksDir = join(targetDir, relDir);
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
      if (!removeUntrackedProjectPath(targetDir, relPath, skipped, { recursive: false })) {
        kept.push(name);
        continue;
      }
      try {
        removed.push(name);
      } catch (error) {
        if (error.code !== "ENOENT") {
          warn(
            `[Meta_Kim] Failed to remove ${platform} hook ${name}: ${error.message}`,
          );
        }
      }
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
}

async function applyProjectBootstrapToDir(activeTargets, targetDir) {
  const legacyCleanup = removeLegacyProjectCapabilityEntrypoints(targetDir, activeTargets);
  let plan = buildProjectBootstrapPlan(activeTargets, targetDir);
  const cleanup = mergeProjectCleanupResults(
    legacyCleanup,
    removeStaleManagedProjectAssets(targetDir, plan.files),
  );
  const strippedHookConfigs = stripStaleProjectHookConfigs(targetDir, plan.files);
  cleanup.strippedHookConfigs = strippedHookConfigs;
  reportProjectAssetCleanup(cleanup, { reason: "project_retarget" });
  if (cleanup.removed.length > 0 || strippedHookConfigs.length > 0) {
    plan = buildProjectBootstrapPlan(activeTargets, targetDir);
  }
  assertNoProjectBootstrapConflicts(plan);
  if (plan.state.status === "ready") {
    return {
      ...plan,
      mode: "apply",
      applied: false,
      noOp: true,
      backup: { created: false, fileCount: 0, entries: [] },
      cleanup,
      manifestPath: projectBootstrapManifestPath(targetDir),
    };
  }
  const backup = createProjectBootstrapBackup(targetDir, plan.files);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }
  for (const platformId of activeTargets) {
    deployPlatformFiles(platformId, targetDir);
  }
  const manifestPath = writeProjectBootstrapManifest(targetDir, plan, backup, cleanup);
  const afterPlan = buildProjectBootstrapPlan(activeTargets, targetDir);
  return {
    ...afterPlan,
    mode: "apply",
    applied: true,
    backup,
    cleanup,
    manifestPath,
  };
}

function classifyProjectBootstrapError(error) {
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
      repairAction:
        "Fix target permissions or resolve the conflicting project file, then rerun project bootstrap dry-run before apply.",
    },
  };
}

function deployPlatformFiles(platformId, targetDir) {
  let fileCount = 0;
  const targetIsRepo = resolve(targetDir) === resolve(PROJECT_DIR);
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
      });
    } else {
      fileCount += copyProjectDeployFile(src, dest, relPath, targetDir);
    }
  };

  for (const root of projectDeployRootsForPlatform(platformId)) {
    copyIfExists(root.srcRel, root.destRel);
  }
  fileCount += writeProjectGeneratedHooks(platformId, targetDir);
  return fileCount;
}

function printPostCopyBootstrapHint() {
  console.log(`${C.dim}  ${t.npxQuickPostCopyScript}${C.reset}`);
}

function savedProjectDeployDirsFrom(overrides) {
  return uniqueProjectDeployDirs(overrides?.projectDeployDirs || []);
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
    return [];
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
    const label =
      result.status === "ok"
        ? `${C.green}${t.projectDeployStatusOk}${C.reset}`
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
  for (const relPath of relPaths) {
    const configPath = join(targetDir, relPath);
    if (!existsSync(configPath)) continue;
    const current = readJsonObjectIfExists(configPath);
    if (!current) continue;
    const stripped = stripProjectMetaKimHooksFromHookConfig(current);
    if (jsonEquivalent(current, stripped)) continue;
    if (isGitTrackedProjectPath(targetDir, relPath)) continue;
    backupBeforeMerge(configPath, "pre-strip-hooks");
    writeJsonObject(configPath, stripped);
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
  return changed;
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
      await migrateProjectMetaKimHooksForBootstrap(activeTargets, targetDir);
      const strippedHookConfigs = cleanupProjectHookConfigs(activeTargets, targetDir);
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
      );
      const instructionCleanup = removeRedundantProjectInstructionFiles(
        targetDir,
        activeTargets,
      );
      const localStateCleanup = removeMetaKimProjectLocalState(targetDir);
      const emptyDirCleanup = pruneEmptyProjectRuntimeDirs(targetDir, activeTargets);
      const cleanup = mergeProjectCleanupResults(
        legacyCleanup,
        capabilityRootCleanup,
        generatedSkillCleanup,
        openClawDirectoryCleanup,
        configCleanup,
        instructionCleanup,
        removeStaleManagedProjectAssets(targetDir, plan.files, {
          removeCurrentManaged: true,
        }),
        localStateCleanup,
        emptyDirCleanup,
      );
      if (!jsonOutputMode) {
        reportProjectAssetCleanup(cleanup, { reason: "global_redundancy" });
      }
      results.push({ dir: targetDir, status: "ok", cleanup, strippedHookConfigs });
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
  const dirs = uniqueProjectDeployDirs(targetDirs);
  if (dirs.length === 0) return [];

  heading(t.projectDeployBatchHeading(dirs.length));
  console.log(`${C.dim}${t.projectDeployProtectionNote}${C.reset}`);

  const results = [];
  for (const targetDir of dirs) {
    try {
      const result = await copyToDeployDir(activeTargets, targetDir);
      results.push({ dir: targetDir, status: "ok", manifestPath: result.manifestPath });
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
  quickDeployDir = quickDeployDir || targetDir;
  quickDeployDirs = uniqueProjectDeployDirs([...quickDeployDirs, targetDir]);

  console.log(`${C.green}${C.bold}✓ ${t.npxQuickDone}${C.reset}`);
  console.log(`${C.dim}  ${targetDir}${C.reset}`);
  printPostCopyBootstrapHint();
  console.log("");
  return bootstrapResult;
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
      "scripts/install-global-skills-all-runtimes.mjs",
      ["--targets", targets, "--skills", ""],
      proxyEnv,
    );
    return installResult.status === 0;
  });

  await withProgress(t.progressSyncMeta, () => {
    const targets = platformId === "all" ? "claude" : platformId;
    const syncResult = runNodeScript(
      "scripts/sync-global-meta-theory.mjs",
      metaTheoryGlobalSyncArgs(targets),
    );
    return syncResult.status === 0;
  });

  console.log("");
  console.log(`${C.green}${C.bold}✓ ${t.npxQuickDone}${C.reset}`);
  console.log(`${C.dim}  ${targetDir}${C.reset}`);
  printPostCopyBootstrapHint();
  console.log("");

  showNextSteps(runtimes);
}

// ── Install scope selection ─────────────────────────────

/**
 * Ask user where to install: global reusable capabilities or project directory updates.
 * Returns: 'project' | 'global'
 */
async function askInstallScope() {
  if (silentMode) return "global";

  heading(t.installScopeHeading);

  const scopes = [
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

  const idx = await keyboardSelect(
    t.installScopePrompt,
    scopes.map((s) => ({
      ...s,
      label: `${s.label}  ${C.dim}${s.desc}${C.reset}`,
    })),
  );

  const selected = scopes[idx]?.id || "global";
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
  repoTargets = ["claude", "codex", "openclaw", "cursor"],
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
        ok(t.syncClaudeAgents(summary.presentCount));
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
      ok(t.syncOpenclawWorkspaces(wsCount));
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
        ok(t.syncCursorAgents(summary.presentCount));
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
        claudeCodeDocs:
          EXTERNAL_URLS.claudeCodeDocs ||
          "https://docs.anthropic.com/en/docs/claude-code",
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

  // Platform capability transparency: warn if Claude Code is not selected
  const hasClaude = chosenTargets.includes("claude");
  if (!hasClaude) {
    console.log(`
⚠  平台能力提示:
   您选择的平台暂不支持以下功能:
   • Hook 自动化 (PreToolUse/PostToolUse)
   • Layer 1 Memory 自动激活
   • CLI 快速命令 (npm run meta:xxx)

   推荐: Claude Code 提供最完整的 Meta_Kim 体验。
         https://docs.anthropic.com/claude-code
`);
  }

  return chosenTargets;
}

async function rememberProjectProjectionMode(mode) {
  const localOverrides = await loadLocalOverrides();
  await writeLocalOverrides({
    ...localOverrides,
    projectProjectionMode: mode,
  });
}

function runNodeScript(scriptRelative, extraArgs = [], envOverrides = {}) {
  // Automatically pass --lang to child scripts
  const langArgs = currentLangCode ? ["--lang", currentLangCode] : [];
  const spawnConfig = buildNodeScriptSpawn(
    process.execPath,
    PROJECT_DIR,
    scriptRelative,
    extraArgs,
    langArgs,
  );
  const mergedOptions = {
    ...spawnConfig.options,
    env: {
      ...process.env,
      ...envOverrides,
    },
  };
  return spawnSync(spawnConfig.command, spawnConfig.args, mergedOptions);
}

function refreshGlobalCapabilityInventory(activeTargets = []) {
  info(t.refreshGlobalCapabilityInventory);
  const targetArgs =
    Array.isArray(activeTargets) && activeTargets.length > 0
      ? ["--runtime-inventory-only", "--targets", activeTargets.join(",")]
      : ["--runtime-inventory-only"];
  const result = runNodeScript("scripts/discover-global-capabilities.mjs", targetArgs, {
    META_KIM_LANG: currentLangCode,
  });
  if (result.status === 0) {
    ok(t.globalCapabilityInventoryRefreshed);
    return true;
  }
  warn(t.globalCapabilityInventoryFailed);
  return false;
}

function metaTheoryGlobalSyncArgs(targets, withGlobalHooks = false) {
  const targetList = Array.isArray(targets) ? targets.join(",") : String(targets);
  const syncArgs = ["--targets", targetList];
  const hookTargets = targetList
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean);
  if (
    withGlobalHooks &&
    hookTargets.some((target) => ["claude", "codex"].includes(target))
  ) {
    syncArgs.push("--with-global-hooks");
  }
  return syncArgs;
}

function nonClaudeGlobalRuntimeHookTargets(targets) {
  const targetList = Array.isArray(targets)
    ? targets
    : String(targets || "")
        .split(",")
        .filter(Boolean);
  return targetList.filter((target) =>
    ["cursor", "openclaw"].includes(target),
  );
}

function formatRuntimeTargetLabels(targets) {
  const labels = new Map(RUNTIME_CHOICES.map((choice) => [choice.id, choice.label]));
  return targets.map((target) => labels.get(target) || target).join(", ");
}

function syncNonClaudeGlobalRuntimeHooks(targets, withGlobalHooks = false) {
  if (!withGlobalHooks) return true;
  const hookTargets = nonClaudeGlobalRuntimeHookTargets(targets);
  if (hookTargets.length === 0) return true;
  const syncResult = runNodeScript("scripts/sync-runtimes.mjs", [
    "--scope",
    "global",
    "--targets",
    hookTargets.join(","),
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
// longer match the canonical whitelist (e.g. legacy spine-state.mjs), and
// user-authored files (anything not on the whitelist) are preserved.
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
  const syncResult = runNodeScript("scripts/sync-runtimes.mjs", syncArgs);
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

  const url = `https://github.com/${skill.repo}.git`;
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
  const url = `https://github.com/${skill.repo}.git`;
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

const GRAPHIFY_GUIDE_TARGETS = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  claw: "AGENTS.md",
  opencode: "AGENTS.md",
  aider: "AGENTS.md",
  droid: "AGENTS.md",
  trae: "AGENTS.md",
  "trae-cn": "AGENTS.md",
};

function guideAlreadyHasGraphifySection(platform, baseDir = PROJECT_DIR) {
  const target = GRAPHIFY_GUIDE_TARGETS[platform];
  if (!target) return false;
  const filePath = join(baseDir, target);
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, "utf8");
  return /^##\s+graphify\b/im.test(content);
}

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

  if (!projectWiring) {
    skip(t.graphifyProjectWiringSkipped);
    return true;
  }

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
    if (guideAlreadyHasGraphifySection(platform, graphifyDir)) {
      skip(t.graphifySkillSkippedGuideExists(platform));
      continue;
    }
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
      warn(t.graphifySkillFailed(platform));
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
    return true;
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

async function runMcpMemoryHookInstaller(activeTargets = DEFAULT_TARGETS.map((target) => target.id)) {
  const hookScript = join(
    PROJECT_DIR,
    "scripts",
    "install-mcp-memory-hooks.mjs",
  );
  if (!existsSync(hookScript)) {
    warn(`Hook installer missing: ${hookScript}`);
    return;
  }

  const spawnDesc = buildNodeScriptSpawn(
    process.execPath,
    PROJECT_DIR,
    "scripts/install-mcp-memory-hooks.mjs",
    ["--targets", activeTargets.join(",")],
  );
  let result;
  await withProgress(t.mcpMemoryHookInstalling, async () => {
    result = spawnSync(spawnDesc.command, spawnDesc.args, {
      ...spawnDesc.options,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  });

  if (result.status === 0) {
    ok(t.mcpMemoryHookInstalled);
  } else {
    warn(t.mcpMemoryHookWarnings);
    const stderrText = (result.stderr || "").trim();
    if (stderrText) {
      console.log(`${C.dim}${stderrText}${C.reset}`);
    }
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

function findMemoryBinPath(resolved) {
  const plat = platform();
  const binName = plat === "win32" ? "memory.exe" : "memory";

  // Strategy 0: prefer the dedicated meta-kim memory venv that setup provisions
  // for this service. Resolving via resolved.python can land on an unrelated
  // system interpreter whose memory build lacks required native extensions
  // (e.g. SQLite-vec loadable extension support), which then fails to start
  // under --http. Always try the purpose-built venv first.
  const venvMemoryBin =
    plat === "win32"
      ? join(homedir(), ".meta-kim", "memory-venv", "Scripts", binName)
      : join(homedir(), ".meta-kim", "memory-venv", "bin", binName);
  if (existsSync(venvMemoryBin)) return venvMemoryBin;

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

function buildMcpMemoryServerConfig(resolved) {
  const memoryBin = findMemoryBinPath(resolved);
  if (memoryBin) {
    return {
      command: memoryBin,
      args: ["server"],
    };
  }
  const python = resolved.python;
  return {
    command: python.command,
    args: [...python.args, "-m", "mcp_memory_service.server"],
  };
}

function isLegacyMcpMemoryServerConfig(config) {
  return (
    Array.isArray(config?.args) &&
    config.args.includes("-m") &&
    config.args.includes("mcp_memory_service")
  );
}

function stopMcpMemoryService() {
  const plat = platform();
  try {
    if (plat === "win32") {
      execSync("taskkill /F /IM memory.exe", { stdio: "pipe" });
    } else if (plat === "darwin") {
      try {
        execSync(
          "launchctl unload ~/Library/LaunchAgents/com.meta-kim.mcp-memory-service.plist 2>/dev/null",
          { stdio: "pipe" },
        );
      } catch {}
      execSync("pkill -f 'memory server --http'", { stdio: "pipe" });
    } else {
      execSync("pkill -f 'memory server --http'", { stdio: "pipe" });
    }
    return true;
  } catch {
    return false;
  }
}

function isMcpMemoryProcessRunning() {
  if (platform() !== "win32") return false;
  try {
    const result = spawnSync(
      "pwsh.exe",
      [
        "-NoProfile",
        "-Command",
        "if (Get-Process -Name memory -ErrorAction SilentlyContinue) { 'running' }",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status === 0 && result.stdout.includes("running")) return true;
  } catch {}

  try {
    const result = spawnSync("tasklist", ["/FI", "IMAGENAME eq memory.exe"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return result.status === 0 && /\bmemory\.exe\b/iu.test(result.stdout);
  } catch {
    return false;
  }
}

async function startMcpMemoryServiceBackground(resolved) {
  const memoryBin = findMemoryBinPath(resolved);
  if (!memoryBin) {
    warn(t.mcpMemoryAutoStartFailed);
    info(t.mcpMemoryAutoStartManual);
    return;
  }

  info(t.mcpMemoryAutoStarting);
  const env = {
    ...process.env,
    MCP_ALLOW_ANONYMOUS_ACCESS: "true",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
  };

  try {
    const child = spawn(memoryBin, ["server", "--http"], {
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Background start may report errors but still succeed
  }

  // Poll health endpoint — service may need several seconds to initialize
  const POLL_INTERVAL = 1500;
  const POLL_MAX_MS = 10000;
  const pollStart = Date.now();
  let healthy = false;

  while (Date.now() - pollStart < POLL_MAX_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    healthy = await new Promise((resolve) => {
      const req = http.get(
        "http://127.0.0.1:8000/api/health",
        { timeout: 3000 },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(body.includes("healthy")));
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
    if (healthy) break;
  }

  if (healthy) {
    ok(t.mcpMemoryAutoStarted);
    const bootOk = configureBootAutoStart(memoryBin);
    if (bootOk) ok(t.mcpMemoryAutoStartBoot);
    return;
  }

  if (isMcpMemoryProcessRunning()) {
    ok(t.mcpMemoryAutoStartUnverified);
    const bootOk = configureBootAutoStart(memoryBin);
    if (bootOk) ok(t.mcpMemoryAutoStartBoot);
    return;
  }

  warn(t.mcpMemoryAutoStartFailed);
  info(t.mcpMemoryAutoStartManual);
}

function configureBootAutoStart(memoryBin) {
  const plat = platform();
  const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const psSingleQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const failureTitle = t.mcpMemoryAutoStartFailureTitle;
  const failureMessage = t.mcpMemoryAutoStartFailureMessage;
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
      writeUtf8BomFileSync(
        psPath,
        `$ErrorActionPreference = "SilentlyContinue"\r\n` +
          `$env:MCP_ALLOW_ANONYMOUS_ACCESS = "true"\r\n` +
          `$env:HF_HUB_OFFLINE = "1"\r\n` +
          `$env:TRANSFORMERS_OFFLINE = "1"\r\n` +
          `$memoryBin = '${escapedMemoryBin}'\r\n` +
          `$failureTitle = ${psSingleQuote(failureTitle)}\r\n` +
          `$failureMessage = ${psSingleQuote(failureMessage)}\r\n` +
          `$logDir = Join-Path $env:USERPROFILE ".meta-kim"\r\n` +
          `$stdoutLog = Join-Path $logDir "mcp-memory.out.log"\r\n` +
          `$stderrLog = Join-Path $logDir "mcp-memory.err.log"\r\n` +
          `function Test-MetaKimMemoryHealth {\r\n` +
          `  try {\r\n` +
          `    $response = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/health" -UseBasicParsing -TimeoutSec 3\r\n` +
          `    return ($response.Content -match "healthy")\r\n` +
          `  } catch { return $false }\r\n` +
          `}\r\n` +
          `if (Test-MetaKimMemoryHealth) { exit 0 }\r\n` +
          `try {\r\n` +
          `  Start-Process -FilePath $memoryBin -ArgumentList @("server", "--http") -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog\r\n` +
          `} catch {}\r\n` +
          `$healthy = $false\r\n` +
          `for ($i = 0; $i -lt 150; $i++) {\r\n` +
          `  Start-Sleep -Seconds 2\r\n` +
          `  if (Test-MetaKimMemoryHealth) { $healthy = $true; break }\r\n` +
          `}\r\n` +
          `if (-not $healthy) {\r\n` +
          `  Add-Type -AssemblyName PresentationFramework\r\n` +
          `  [System.Windows.MessageBox]::Show($failureMessage, $failureTitle, "OK", "Warning") | Out-Null\r\n` +
          `}\r\n`,
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
          `export MCP_ALLOW_ANONYMOUS_ACCESS=true\n` +
          `export HF_HUB_OFFLINE=1\n` +
          `export TRANSFORMERS_OFFLINE=1\n` +
          `MEMORY_BIN=${shellQuote(memoryBin)}\n` +
          `LOG_PATH=${shellQuote(logPath)}\n` +
          `TITLE=${shellQuote(failureTitle)}\n` +
          `MSG=${shellQuote(failureMessage)}\n` +
          `check_health() {\n` +
          `  command -v curl >/dev/null 2>&1 && curl -fsS --noproxy '*' --max-time 3 http://127.0.0.1:8000/api/health 2>/dev/null | grep -q healthy\n` +
          `}\n` +
          `notify_failure() {\n` +
          `  osascript -e "display dialog \\"$MSG\\" with title \\"$TITLE\\" buttons {\\"OK\\"} with icon caution" >/dev/null 2>&1 || true\n` +
          `}\n` +
          `check_health && exit 0\n` +
          `"$MEMORY_BIN" server --http >>"$LOG_PATH" 2>&1 &\n` +
          `healthy=0\n` +
          `i=0\n` +
          `while [ "$i" -lt 150 ]; do\n` +
          `  sleep 2\n` +
          `  if check_health; then healthy=1; break; fi\n` +
          `  i=$((i + 1))\n` +
          `done\n` +
          `[ "$healthy" -eq 1 ] || notify_failure\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(launchDir, "com.meta-kim.mcp-memory-service.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.meta-kim.mcp-memory-service</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>${scriptPath}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>MCP_ALLOW_ANONYMOUS_ACCESS</key><string>true</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>
    <key>TRANSFORMERS_OFFLINE</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
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
        `export MCP_ALLOW_ANONYMOUS_ACCESS=true\n` +
        `export HF_HUB_OFFLINE=1\n` +
        `export TRANSFORMERS_OFFLINE=1\n` +
        `MEMORY_BIN=${shellQuote(memoryBin)}\n` +
        `LOG_PATH=${shellQuote(logPath)}\n` +
        `TITLE=${shellQuote(failureTitle)}\n` +
        `MSG=${shellQuote(failureMessage)}\n` +
        `check_health() {\n` +
        `  command -v curl >/dev/null 2>&1 && curl -fsS --noproxy '*' --max-time 3 http://127.0.0.1:8000/api/health 2>/dev/null | grep -q healthy\n` +
        `}\n` +
        `notify_failure() {\n` +
        `  if command -v notify-send >/dev/null 2>&1; then notify-send "$TITLE" "$MSG"; return; fi\n` +
        `  if command -v zenity >/dev/null 2>&1; then zenity --warning --title="$TITLE" --text="$MSG"; return; fi\n` +
        `  if command -v kdialog >/dev/null 2>&1; then kdialog --sorry "$MSG" --title "$TITLE"; return; fi\n` +
        `  if command -v xmessage >/dev/null 2>&1; then xmessage -center "$MSG"; return; fi\n` +
        `  printf '%s\\n' "$MSG" >>"$LOG_PATH"\n` +
        `}\n` +
        `check_health && exit 0\n` +
        `"$MEMORY_BIN" server --http >>"$LOG_PATH" 2>&1 &\n` +
        `healthy=0\n` +
        `i=0\n` +
        `while [ "$i" -lt 150 ]; do\n` +
        `  sleep 2\n` +
        `  if check_health; then healthy=1; break; fi\n` +
        `  i=$((i + 1))\n` +
        `done\n` +
        `[ "$healthy" -eq 1 ] || notify_failure\n`,
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

async function installMcpMemoryServiceStep(inUpdateMode = false, activeTargets = DEFAULT_TARGETS.map((target) => target.id)) {
  heading(t.stepMcpMemory);

  const want = await askYesNo(t.askMcpMemoryInstall, true);
  if (!want) {
    skip(`${C.dim}${t.mcpMemorySkipped}${C.reset}`);
    return;
  }

  // Detect Python — reuse same detection as graphify for consistency
  const detected = checkPython310();
  if (!detected) {
    warn(t.pythonNotFound);
    info(t.pythonHint);
    return;
  }

  // Resolve Python for mcp-memory-service (safetensors prefers 3.11/3.12).
  // When the detected Python is outside that range, try to build/reuse a venv
  // locked to 3.12. Falls back to the detected Python with a warning.
  const resolved = resolvePythonForMemoryService(detected);
  const python = resolved.python;

  // Check if already installed
  const existing = checkMcpMemoryService(python);
  if (existing.installed) {
    if (inUpdateMode) {
      // Stop running service before upgrading (Windows locks the binary)
      info(t.mcpMemoryStopping);
      const stopped = stopMcpMemoryService();
      if (stopped) {
        ok(t.mcpMemoryStopped);
        await new Promise((r) => setTimeout(r, 2000));
      }
      // Upgrade in update mode
      info(t.mcpMemoryUpgrading);
      const upgradeResult = runPythonModule(python, [
        "-m",
        "pip",
        "install",
        "--upgrade",
        "mcp-memory-service",
      ]);
      if (upgradeResult.status !== 0) {
        const stderr = readProcessText(upgradeResult);
        warn(t.mcpMemoryUpgradeFailed);
        if (stderr) {
          console.log(`${C.dim}${t.pipErrorDetail(stderr)}${C.reset}`);
        }
        return;
      }
      const newVersion = checkMcpMemoryService(python).version ?? "latest";
      ok(t.mcpMemoryUpgraded(newVersion));
    } else {
      ok(t.mcpMemoryAlreadyInstalled(existing.version ?? "unknown"));
    }
  } else {
    // Install via pip (use resolved Python for cross-platform compatibility)
    info(t.mcpMemoryInstalling);
    const installResult = runPythonModule(python, [
      "-m",
      "pip",
      "install",
      "mcp-memory-service",
    ]);
    if (installResult.status !== 0) {
      const stderr = readProcessText(installResult);
      warn(t.mcpMemoryInstallFailed);
      if (stderr) {
        console.log(`${C.dim}${t.pipErrorDetail(stderr)}${C.reset}`);
      }
      return;
    } else {
      ok(t.mcpMemoryInstalled);
    }
  }

  // Register in project .mcp.json. When running inside a venv we write the
  // absolute python path so Claude Code can launch it without shell PATH setup.
  // `python` here is a launcher descriptor { command, args, version, ... }.
  const memoryServerConfig = buildMcpMemoryServerConfig(resolved);

  const mcpPath = join(PROJECT_DIR, ".mcp.json");
  if (existsSync(mcpPath)) {
    try {
      const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf8"));
      if (
        isLegacyMcpMemoryServerConfig(
          mcpConfig.mcpServers?.["mcp-memory-service"],
        )
      ) {
        const nextConfig = {
          ...mcpConfig,
          mcpServers: {
            ...(mcpConfig.mcpServers ?? {}),
            "mcp-memory-service": memoryServerConfig,
          },
        };
        writeFileSync(mcpPath, JSON.stringify(nextConfig, null, 2) + "\n");
        ok(t.mcpMemoryServerRegistered);
      } else if (mcpConfig.mcpServers?.["mcp-memory-service"]) {
        ok(t.mcpMemoryServerExists);
      } else {
        const nextConfig = {
          ...mcpConfig,
          mcpServers: {
            ...(mcpConfig.mcpServers ?? {}),
            "mcp-memory-service": memoryServerConfig,
          },
        };
        writeFileSync(mcpPath, JSON.stringify(nextConfig, null, 2) + "\n");
        ok(t.mcpMemoryServerRegistered);
      }
    } catch {
      warn(t.mcpMemoryServerExists);
    }
  } else {
    // Create minimal .mcp.json with just the memory service
    const newConfig = {
      mcpServers: {
        "mcp-memory-service": memoryServerConfig,
      },
    };
    writeFileSync(mcpPath, JSON.stringify(newConfig, null, 2) + "\n");
    ok(t.mcpMemoryServerRegistered);
  }

  info(t.mcpMemoryServerStartHint);

  // Step 4.7 — auto-install runtime memory hooks so the full pipeline
  // (pip package → .mcp.json → hook files → runtime registration →
  // health check) runs from a single `node setup.mjs` invocation.
  await runMcpMemoryHookInstaller(activeTargets);

  // Step 4.8 — start the HTTP server in background and configure boot auto-start
  await startMcpMemoryServiceBackground(resolved);
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

async function validate() {
  heading(t.stepValidate);
  const agentsDir = join(PROJECT_DIR, ".claude", "agents");
  if (existsSync(agentsDir)) {
    const summary = summarizeExpectedFiles(
      readdirSync(agentsDir).filter((f) => f.endsWith(".md")),
      expectedAgentProjectionFiles(".md"),
    );
    ok(t.agentPrompts(summary.presentCount));
  }
  const validateSpawn = buildNodeScriptSpawn(
    process.execPath,
    PROJECT_DIR,
    "scripts/validate-project.mjs",
    ["--context", "install"],
  );
  const validateResult = spawnSync(
    validateSpawn.command,
    validateSpawn.args,
    validateSpawn.options,
  );
  if (validateResult.status === 0) ok(t.validationPassed);
  else warn(t.validationWarnings);
}

function showNextSteps(runtimes) {
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
      `${C.dim}${
        EXTERNAL_URLS.claudeCodeDocs ||
        "https://docs.anthropic.com/en/docs/claude-code"
      }${C.reset}`,
    );
  }

  console.log("");
  console.log(`${C.bold}${t.usefulCommands}${C.reset}
`);
  if (hasDeployDirs) {
    console.log(
      `${C.dim}npx --yes github:KimYx0207/Meta_Kim meta-kim -- --update${C.reset}`,
    );
    console.log(
      `${C.dim}npx --yes github:KimYx0207/Meta_Kim meta-kim -- --check${C.reset}`,
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
    { name: t.platformClaudeCode, cap: t.platformClaudeCodeCap },
    { name: t.platformCodex, cap: t.platformCodexCap },
    { name: t.platformOpenClaw, cap: t.platformOpenClawCap },
    { name: t.platformCursor, cap: t.platformCursorCap },
  ].filter(
    (r) =>
      runtimes[
        r.name
          .replace("platform", "")
          .toLowerCase()
          .replace("claudecode", "claude")
      ] || r.name === t.platformClaudeCode,
  );
  for (const row of platformRows) {
    console.log(`${C.dim}• ${row.name}: ${row.cap}${C.reset}`);
  }
  console.log("");
  console.log(
    `${C.bold}${C.cyan}● ${t.postInstallNotesLayerActivation}${C.reset}`,
  );
  console.log(`${C.dim}${t.layer1Label} — ${t.layer1Note}${C.reset}`);
  console.log(`${C.dim}${t.layer2Label} — ${t.layer2Note}${C.reset}`);
  console.log(`${C.dim}${t.layer3Label} — ${t.layer3Note}${C.reset}`);
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
  console.log(
    `${C.dim}  npm run meta:status        # ${t.cmdWhereStatus}${C.reset}`,
  );
  console.log(
    `${C.dim}  npm run meta:status:diff   # ${t.cmdWhereStatusDiff}${C.reset}`,
  );
  console.log(
    `${C.dim}  npm run meta:uninstall     # ${t.cmdWhereUninstall}${C.reset}`,
  );
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
    `Website: ${EXTERNAL_URLS.author?.website || "https://www.aiking.dev/"}`,
    `GitHub:  ${EXTERNAL_URLS.author?.github || "https://github.com/KimYx0207"}`,
    `X:       ${EXTERNAL_URLS.author?.x || "https://x.com/KimYx0207"}`,
    `Feishu:  ${
      EXTERNAL_URLS.author?.feishu ||
      "https://my.feishu.cn/wiki/OhQ8wqntFihcI1kWVDlcNdpznFf"
    }`,
    "WeChat:  \u8001\u91d1\u5e26\u4f60\u73a9AI",
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

function checkProjectRuntimeSync(runtimes, targetContext) {
  if (targetContext.localOverrides?.projectProjectionMode !== "global_only") {
    checkSync(runtimes, targetContext.activeTargets);
  }
}

async function runProjectBootstrapCli() {
  if (projectBootstrapApply && projectBootstrapDryRun) {
    throw new Error("--project-bootstrap cannot use --apply and --dry-run together");
  }
  const targetContext = await resolveTargetContext(args);
  const activeTargets = targetContext.activeTargets;
  const targetDirs = cliProjectDeployDirs.length > 0 ? cliProjectDeployDirs : [process.cwd()];
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
  const failed = results.filter((result) => result.status === "failed");
  const summary = {
    schemaVersion: "meta-kim-project-cleanup-result-v0.1",
    mode: "cleanup",
    ok: failed.length === 0,
    resultCount: results.length,
    results,
  };

  if (jsonOutputMode) {
    console.log(JSON.stringify(summary, null, 2));
    return summary.ok;
  }

  console.log(`Meta_Kim project cleanup: ${summary.ok ? "ok" : "failed"}`);
  console.log(`  targets=${activeTargets.join(",")}`);
  console.log(`  cleanedProjects=${summary.resultCount}`);
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
    checkProjectRuntimeSync(detectedRuntimes, targetContext);
    console.log(
      `${C.dim}${t.checkTargets(targetContext.activeTargets.join(", "), targetContext.supportedTargets.join(", "))}${C.reset}`,
    );
    const localState = await ensureProfileState();
    console.log("");
    console.log(`${C.bold}${t.localStateHeader}${C.reset}`);
    console.log(
      `${C.dim}  profile=${localState.profile} key=${localState.metadata.profileKey}${C.reset}`,
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
    process.exit(0);
  }

  if (updateMode) {
    await runUpdate();
    process.exit(0);
  }

  if (silentMode) {
    await runInstall();
    process.exit(0);
  }

  // ── Interactive: choose action ──
  const actionLabels = [
    t.actionInstall,
    t.actionUpdate,
    t.actionCheck,
    t.actionExit,
  ];
  const actionIdx = await askSelect(t.actionPrompt, actionLabels);

  if (actionIdx === 0) await runInstall();
  else if (actionIdx === 1) await runUpdate();
  else if (actionIdx === 2) await runCheck();
  else process.exit(0);
}

// ── Action runners ──────────────────────────────────────

async function runInstall() {
  const runtimes = await detectRuntimes();
  const activeTargets = await selectActiveTargets(runtimes);

  // 询问安装范围
  const installScope = await askInstallScope();
  const needProject = installScope === "project";
  const needGlobal = installScope === "global";
  await rememberProjectProjectionMode(needGlobal ? "global_only" : "project");

  // Ask proxy configuration (saves to localOverrides)
  await askProxyConfig();

  let selectedSkillIds = [];
  if (needGlobal) {
    selectedSkillIds = await resolveSelectedSkillDependencyIds();
  }

  // 在用户知道选了哪些技能后，显示目录结构说明
  showDirectoryExplanation();

  // Ask project deploy directories BEFORE confirm (so user decides upfront)
  const deployDirs = needProject ? await askDeployDirectory() : [];
  const cleanupDirs = needGlobal ? await askProjectCleanupDirectory() : [];

  // Early cleanup: run right after directory selection so the user sees the
  // result immediately. Must not depend on the slower install steps below
  // (npm install / python / mcp / validate) — those are easy to interrupt,
  // and losing the cleanup defeats the global-single-source intent.
  if (cleanupDirs.length > 0) {
    await cleanupProjectRedundancyDirs(activeTargets, cleanupDirs);
  }

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

  // 项目目录更新
  if (needProject) {
    stepNum++;
    await withProgress(t.stepLabel(stepNum, t.progressNpmInstall), async () => {
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

    stepNum++;
    await withProgress(t.stepLabel(stepNum, t.progressCleanupLegacy), () => {
      const n = cleanupLegacySkills(installScope);
      if (n > 0) ok(`Cleaned ${n} legacy file(s)`);
      return true;
    });

    stepNum++;
    await withProgress(t.stepLabel(stepNum, t.progressSyncConfig), async () => {
      const configResult = await autoConfigure(installScope, activeTargets);
      if (!configResult) {
        warn(t.warnConfigSyncFailed);
      }
      return configResult;
    });
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
    await withProgress(
      t.stepLabel(stepNum, t.progressInstallSkills),
      async () => {
        const localOverrides = await loadLocalOverrides();
        const proxyEnv = localOverrides.gitProxy
          ? { META_KIM_GIT_PROXY: localOverrides.gitProxy }
          : {};
        const skillArgs =
          selectedSkillIds.length > 0
            ? [
                "--targets",
                activeTargets.join(","),
                "--skills",
                selectedSkillIds.join(","),
              ]
            : ["--targets", activeTargets.join(","), "--skills", ""];
        // ).concat(["--log-file", INSTALL_LOG_FILE]);
        const installResult = runNodeScript(
          "scripts/install-global-skills-all-runtimes.mjs",
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

    // 同步全局 meta-theory
    stepNum++;
    await withProgress(t.stepLabel(stepNum, t.progressSyncMeta), () => {
      const syncResult = runNodeScript(
        "scripts/sync-global-meta-theory.mjs",
        metaTheoryGlobalSyncArgs(activeTargets, setupWithGlobalHooks),
      );
      const runtimeHooksOk = syncNonClaudeGlobalRuntimeHooks(
        activeTargets,
        setupWithGlobalHooks,
      );
      if (syncResult.status !== 0 || !runtimeHooksOk) {
        warn(t.warnMetaTheorySyncFailed);
      }
      return syncResult.status === 0 && runtimeHooksOk;
    });
  }

  if (needGlobal) {
    stepNum++;
    await withProgress(
      t.stepLabel(stepNum, t.refreshGlobalCapabilityInventory),
      async () => refreshGlobalCapabilityInventory(activeTargets),
    );
  }

  // [Optional] Python tools (graphify)
  stepNum++;
  await withProgress(
    t.stepLabel(stepNum, t.progressInstallPython),
    async () => {
      const wantPython = await askYesNo(t.askPythonToolsUpdate, true);
      if (wantPython) {
        await installPythonTools(activeTargets, false, PROJECT_DIR, {
          projectWiring: needProject,
        });
      } else {
        skip(`${C.dim}${t.pythonToolsSkipped}${C.reset}`);
      }
    },
  );

  // [Optional] MCP Memory Service (Layer 3)
  stepNum++;
  await withProgress(
    t.stepLabel(stepNum, t.progressInstallMcpMemory),
    async () => {
      await installMcpMemoryServiceStep(false, activeTargets);
    },
  );

  // 验证：项目路径检查 repo-local；全局路径只跑项目完整性校验
  stepNum++;
  await withProgress(t.stepLabel(stepNum, t.progressValidate), async () => {
    if (needProject) {
      checkSync(runtimes, activeTargets);
    }
    await validate();
  });

  console.log(`\n${C.bold}${C.green}✓ ${t.installComplete}${C.reset}\n`);

  // Copy runtime files to user-chosen project directories (if opted in earlier)
  if (deployDirs.length > 0) {
    await copyToDeployDirs(activeTargets, deployDirs);
  }

  showNextSteps(runtimes);
}

async function runUpdate() {
  heading(t.updateHeading);
  const runtimes = await detectRuntimes();
  const reselectTargets = await askYesNo(t.askReselectRuntimes, true);
  const activeTargets = reselectTargets
    ? await selectActiveTargets(runtimes)
    : (await resolveTargetContext(args)).activeTargets;

  // ── 0. Ask for update scope (like install mode) ─────────────────────
  const updateScope = await askInstallScope();
  const needProject = updateScope === "project";
  const needGlobal = updateScope === "global";
  await rememberProjectProjectionMode(needGlobal ? "global_only" : "project");

  // Ask proxy configuration (saves to localOverrides)
  await askProxyConfig();

  // Ask project deploy directories BEFORE update starts
  const deployDirs = needProject ? await askDeployDirectory() : [];
  const cleanupDirs = needGlobal ? await askProjectCleanupDirectory() : [];

  // Early cleanup: run right after directory selection so the user sees the
  // result immediately. Must not depend on the slower install steps below
  // (npm install / python / mcp / validate) — those are easy to interrupt,
  // and losing the cleanup defeats the global-single-source intent.
  if (cleanupDirs.length > 0) {
    await cleanupProjectRedundancyDirs(activeTargets, cleanupDirs);
  }

  // ── 1. npm install (always — new code may have new deps) ────────────
  info(t.updateNpm);
  const npmResult = spawnCliSync("npm", ["install"], {
    cwd: PROJECT_DIR,
    stdio: "inherit",
  });
  if (npmResult.status === 0) ok(t.npmDone);
  else warn(t.npmFailed);

  // ── 2. [Optional] Python tools (graphify) ─────────────────────────
  console.log("");
  const wantPython = await askYesNo(t.askPythonToolsUpdate, true);
  if (wantPython) {
    await installPythonTools(activeTargets, true, PROJECT_DIR, {
      projectWiring: needProject,
    });
  } else {
    skip(`${C.dim}${t.pythonToolsSkipped}${C.reset}`);
  }

  // ── 2.5 [Optional] MCP Memory Service (Layer 3) ─────────────────
  console.log("");
  await installMcpMemoryServiceStep(true, activeTargets);

  // ── 2.8. Clean up legacy skill files ───────────────────────────────
  const legacyCount = cleanupLegacySkills(updateScope);
  if (legacyCount > 0) ok(`Cleaned ${legacyCount} legacy file(s)`);

  // ── 3. sync-runtimes (scope from user selection) ──────────────────
  if (needProject) {
    info(t.updateSyncProjectFiles);
    const syncResult = runNodeScript("scripts/sync-runtimes.mjs", [
      "--scope",
      updateScope,
      "--targets",
      activeTargets.join(","),
    ]);
    if (syncResult.status === 0) ok(t.updateSyncDone);
    else warn(t.updateSyncSkip);
  }

  // ── 4. Global skills update ───────────────────────────────────────
  console.log("");
  if (needGlobal) {
    const updateSkillIds = await resolveSelectedSkillDependencyIds();
    const localOverrides = await loadLocalOverrides();
    const proxyEnv = localOverrides.gitProxy
      ? { META_KIM_GIT_PROXY: localOverrides.gitProxy }
      : {};
    const updateSkillArgs =
      updateSkillIds.length > 0
        ? [
            "--update",
            "--targets",
            activeTargets.join(","),
            "--skills",
            updateSkillIds.join(","),
          ]
        : ["--update", "--targets", activeTargets.join(","), "--skills", ""];
    // ).concat(["--log-file", INSTALL_LOG_FILE]);
    const updateInstallResult = runNodeScript(
      "scripts/install-global-skills-all-runtimes.mjs",
      updateSkillArgs,
      proxyEnv,
    );
    if (updateInstallResult.status === 0) ok(t.updateSkillsDone);
    else {
      warn(t.warnSkillsUpdateFailed);
      warn(`${C.dim}${t.warnSkillsUpdateFailedHint}${C.reset}`);
    }
  }

  // ── 5. Global meta-theory sync ────────────────────────────────────
  console.log("");
  if (needGlobal) {
    const updateSyncResult = runNodeScript(
      "scripts/sync-global-meta-theory.mjs",
      metaTheoryGlobalSyncArgs(activeTargets, setupWithGlobalHooks),
    );
    const runtimeHooksOk = syncNonClaudeGlobalRuntimeHooks(
      activeTargets,
      setupWithGlobalHooks,
    );
    if (updateSyncResult.status === 0 && runtimeHooksOk)
      ok(t.updateMetaTheoryDone);
    else warn(t.warnMetaTheoryUpdateFailed);
  }

  // ── 5.5. Refresh global capability inventory ───────────────────────
  console.log("");
  if (needGlobal) {
    await refreshGlobalCapabilityInventory(activeTargets);
  }

  // ── 6. checkSync (repo-local, project scope) ───────────────────────
  if (needProject) {
    checkSync(runtimes, activeTargets);
  }
  console.log(`\n${C.bold}${C.green}✓ ${t.updateComplete}${C.reset}\n`);

  // Copy runtime files to user-chosen project directories (if opted in earlier)
  if (deployDirs.length > 0) {
    await copyToDeployDirs(activeTargets, deployDirs);
  }
}

async function runCheck() {
  console.log(`\n${C.green}✓ ${t.envOk}${C.reset}\n`);
  const runtimes = await detectRuntimes();
  const targetContext = await resolveTargetContext(args);
  checkProjectRuntimeSync(runtimes, targetContext);
  console.log(
    `${C.dim}${t.checkTargets(targetContext.activeTargets.join(", "), targetContext.supportedTargets.join(", "))}${C.reset}`,
  );
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
