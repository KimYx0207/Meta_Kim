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
 *
 * Optional prompts (off by default — install uses scope "both" and skips proxy UI):
 *   --prompt-install-scope      # Ask repo vs home vs both
 *   --prompt-proxy              # Ask Windows system proxy for git (META_KIM_GIT_PROXY)
 *   META_KIM_PROMPT_INSTALL_SCOPE=1 / META_KIM_PROMPT_PROXY=1
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
import { join, dirname, resolve } from "node:path";
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
  CLAUDE_HOOK_FILES,
  META_AGENTS,
  OPENCLAW_WORKSPACE_MD,
  expectedAgentProjectionFiles,
  summarizeExpectedFiles,
} from "./scripts/runtime-sync-check.mjs";
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
const silentMode = args.includes("--silent") || !process.stdout.isTTY;

/** Interactive extras (default off): full install uses scope "both" and skips proxy prompts. */
const promptInstallScope =
  args.includes("--prompt-install-scope") ||
  process.env.META_KIM_PROMPT_INSTALL_SCOPE === "1";
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

const I18N = {
  en: {
    modeCheck: "check only",
    modeUpdate: "update",
    modeSilent: "silent",
    modeInteractive: "interactive",
    /** Shared gate before menu / CLI modes — headings below are titles only, no "step 1/N" */
    preflightHeading: "Environment check",
    nodeOld: (v) => `Node.js v${v} too old, need >=${MIN_NODE_VERSION}`,
    nodeOk: (v) => `Node.js v${v}`,
    npmNotFound: "npm not found",
    gitNotFound: "git not found — skills install requires git",
    proxyInfo: (p) => `Proxy: ${p}`,
    pkgFound: "package.json found",
    pkgNotFound: "package.json not found — run from Meta_Kim root",
    envFailed: "Environment check failed. Fix the issues above.",
    envOk: "Environment OK!",
    stepRuntime: "AI coding tool detection",
    claudeDetected: (v) => `Claude Code ${v}`,
    claudeNotDetected: "Claude Code CLI not detected",
    codexDetected: (v) => `Codex ${v}`,
    codexNotDetected: "Codex CLI not detected (optional)",
    openclawDetected: (v) => `OpenClaw ${v}`,
    openclawNotDetected: "OpenClaw CLI not detected (optional)",
    cursorDetected: (v) => `Cursor ${v}`,
    cursorNotDetected: "Cursor CLI not detected (optional)",
    noRuntime: "No AI coding tool detected.",
    noRuntimeHint1:
      "Meta_Kim works with Claude Code, Codex, OpenClaw, or Cursor.",
    noRuntimeHint2: "Install at least one: {claudeCodeDocs}",
    continueAnyway: "Continue setup anyway?",
    setupCancelled: "Setup cancelled. Install an AI coding tool and re-run.",
    stepConfig: "Project configuration",
    mcpExists: ".mcp.json already configured",
    mcpCreated: ".mcp.json created — MCP service registered",
    settingsExists: ".claude/settings.json already configured",
    askCreateSettings: "Create .claude/settings.json with hooks?",
    settingsCreated:
      ".claude/settings.json created — hooks + permissions registered",
    settingsSkipped: ".claude/settings.json skipped by user",
    settingsSkippedNoClaude:
      ".claude/settings.json skipped (Claude Code not detected)",
    stepSkills: "Install skills",
    shipsSkills: (n) => `Meta_Kim ships ${n} skills:`,
    runningNpm: "Running npm install ...",
    npmDone: "npm dependencies installed",
    npmFailed: `
✗ npm install failed

Possible causes:
1. Network error → Check your internet connection and proxy settings
2. Node version mismatch → Ensure Node ${MIN_NODE_VERSION}+ is installed
3. Permission issue → Run: npm install --no-optional

→ Fix: Run the command manually to see full output: npm install
`,
    nodeModulesExist: "node_modules exists (use --update to reinstall)",
    skillUpdated: (n) => `${n} — updated`,
    skillInstalled: (n) => `${n} — installed`,
    skillExists: (n) => `${n} — already installed`,
    skillSubdirInstalled: (n, s) => `${n} — installed (subdir: ${s})`,
    skillFailed: (n, r) => `
✗ Skill installation failed: ${n}

Possible causes:
1. Network timeout → Run: npm run meta:sync -- --skills
2. Permission denied → Run with sudo/administrator
3. Repo not found → Check the skill repository URL

${r ? `Raw error: ${r}` : ""}
`,
    skillUpdateFailed: (n) =>
      `${n} — update skipped (non-fast-forward; keeping existing)`,
    skillSubdirNotFound: (n) => `${n} — subdir not found`,
    skillsReady: (ok, total, fail) =>
      `${ok}/${total} skills ready${fail > 0 ? `, ${fail} failed` : ""}`,
    stepValidate: "Validate project",
    agentPrompts: (n) => `${n} meta-agent prompts`,
    validationPassed: "Project validation passed",
    validationWarnings: "Validation has warnings (non-blocking)",
    setupComplete: "Setup complete!",
    whatMetaDoes: "What Meta_Kim does:",
    whatMetaDoesDesc1: "Gives your AI coding agent a team of specialists:",
    whatMetaDoesDesc2: "one reviews code, one handles security, one manages",
    whatMetaDoesDesc3: "memory — all coordinated automatically.",
    howToUse: "How to use:",
    step1Open: "Open Claude Code in this directory:",
    step2Try: "Try a meta-theory command:",
    step3Or: "Or just ask Claude to do something complex:",
    step3Hint: "(Meta_Kim will auto-coordinate the specialists)",
    codexNote: "Codex prompts are synced to .codex/",
    openclawNote: "OpenClaw workspace is synced to openclaw/",
    cursorNote: "Cursor agents are synced to .cursor/",
    noRuntimeGetStarted:
      "No AI coding tool detected. Install Claude Code to get started:",
    usefulCommands: "Useful commands:",
    cmdUpdate: "Update all skills",
    cmdCheck: "Check environment",
    cmdDoctor: "Diagnose Meta_Kim health",
    cmdVerify: "Full verification",
    // Post-install notes
    postInstallNotesHeading: "Post-install notes:",
    postInstallNotesIntro:
      "After installation, here is what is available and how each layer activates:",
    postInstallNotesPlatformSync: "Platform capability sync:",
    platformClauleCode: "Claude Code",
    platformClauleCodeCap: "agents + skills + hooks",
    platformCodex: "Codex",
    platformCodexCap: "agents + skills",
    platformOpenClaw: "OpenClaw",
    platformOpenClawCap: "workspace + skills",
    platformCursor: "Cursor",
    platformCursorCap: "agents + skills",
    postInstallNotesLayerActivation: "Three-layer memory activation:",
    layer1Label: "Layer 1 (Memory)",
    layer1Note: "automatic — built into Claude Code",
    layer2Label: "Layer 2 (Graphify)",
    layer2Note: "automatic after graphify install (pip install graphifyy)",
    layer3Label: "Layer 3 (SQL / MCP Memory Service)",
    layer3Note:
      "requires server startup: python -m mcp_memory_service (then http://localhost:8000)",
    installLocationsHeading: "Installation locations:",
    installLocationsProject: "Project-level (this directory)",
    installLocationsGlobal: "Global-level (shared across projects)",
    installLocationsManifest: "Install manifest (for safe rollback)",
    usefulCommandsHeading: "Next useful commands:",
    cmdWhereStatus: "view all artifact locations",
    cmdWhereStatusDiff: "diff against previous install",
    cmdWhereUninstall: "safe uninstall",
    postInstallNotesReminder: "Reminder:",
    postInstallNotesReminderText:
      "Run node setup.mjs --check to verify your installation at any time.",
    setupError: "Setup error:",
    setupInterrupted:
      "Interrupted (Ctrl+C) — setup did not finish. Run node setup.mjs again when ready.",
    selectLang: "Select language / 选择语言 / 言語を選択 / 언어 선택",
    choose: (n) => `Choose (1-${n})`,
    /** Shown under @inquirer select (replaces default English key hints). */
    inquirerSingleHotkeys: "↑↓ navigate · ⏎ confirm",
    /** Shown under @inquirer checkbox — space / a / i match default shortcuts. */
    inquirerMultiHotkeys:
      "↑↓ move · space toggle · ⏎ confirm · a all · i invert",
    globalInstallPrompt:
      "Meta_Kim skills install to ~/.claude/skills/ (global). Install globally?",
    globalDirReady: (p) => `Global skills dir ready: ${p}`,
    globalDirCreated: (p) => `Created global skills dir: ${p}`,
    globalDirCreateFailed: (e) => `Failed to create global skills dir: ${e}`,
    globalDirTitle: "Global Skills Directory",
    globalDirPrompt: `Meta_Kim skills will be installed to ~/.claude/skills/
• Global install — Shared across all projects
• Skip — For this project only
• Re-run setup.mjs anytime to install`,
    globalSkipped: "Global install skipped — using project-local only",
    // Install scope selection
    installScopeHeading: "Installation Scope",
    installScopePrompt: "This repo only, home skills only, or both?",
    installScopeProject: "This clone — .claude / .codex / openclaw / .cursor",
    installScopeGlobal:
      "Home — skills per selected tool (~/.*/skills), not Claude-only",
    installScopeBoth: "Both (recommended) — repo, then home",
    installScopeProjectLabel: "This repo only",
    installScopeGlobalLabel: "Home skills only",
    installScopeBothLabel: "Both (recommended)",
    installScopeProjectDesc:
      "Update tool configs in this repo only; skips home-directory skills.",
    installScopeGlobalDesc:
      "Install skills + meta-theory for tools you pick next; does not update this repo.",
    installScopeBothDesc: "Repo step, then home step.",
    depCheckHeading: "Dependency Check",
    depOk: (n) => `${n} — OK`,
    depMissing: (n) => `${n} — MISSING`,
    depNoFiles: (n) => `${n} — directory exists but no .md files`,
    selectRuntimeTargets: "Which AI coding tools do you use on this machine?",
    selectSkillDependencies:
      "Which third-party skill repositories should be installed globally?",
    inputTargetsHint: (d) =>
      `Enter numbers, comma for multiple; Enter to use default ${d}`,
    inputSkillIdsHint: (d) =>
      `Enter numbers, comma for multiple; Enter to use default ${d}`,
    warnUnknownSkillId: (id) => `Unknown skill id (ignored): ${id}`,
    depSummaryAll: "All 9 dependencies verified",
    depSummarySome: (ok, total) =>
      `Only ${ok}/${total} dependencies verified — re-run with --update`,
    syncHeading: "Cross-Runtime Sync Check",
    syncClaudeAgents: (n) => `Claude Code agents: ${n}/8 .md files`,
    syncClaudeSkills: "Claude Code skills/meta-theory/SKILL.md",
    syncClaudeHooks: (n) => `Claude Code hooks: ${n} scripts`,
    syncClaudeSettings: "Claude Code .claude/settings.json",
    syncClaudeMcp: "Claude Code .mcp.json",
    syncCodexAgents: (n) => `Codex agents: ${n}/8 .toml files`,
    syncCodexSkills: "Codex skills/meta-theory/SKILL.md",
    syncOpenclawWorkspaces: (n) =>
      `OpenClaw workspaces: ${n}/8 agents — each folder has the 9 required .md files (BOOT, SOUL, …)`,
    syncOpenclawSkill: "OpenClaw shared meta-theory",
    syncSharedSkills: "Shared skills/meta-theory/SKILL.md",
    syncCursorAgents: (n) => `Cursor agents: ${n}/8 .md files`,
    syncCursorSkills: "Cursor skills/meta-theory/SKILL.md",
    syncCursorMcp: "Cursor .cursor/mcp.json",
    syncOk: "All sync targets verified",
    syncMissing: (p) => `Missing: ${p}`,
    syncPartial: (label, got, need) => `${label}: got ${got}, need ${need}`,
    stepPythonTools: "Optional Python Tools",
    pythonNotFound: "Python 3.10+ not found — skipping graphify",
    pythonHint:
      "Install Python 3.10+ and run: pip install graphifyy && python -m graphify claude install",
    pythonNotFoundOfferInstall:
      "Python 3.10+ not found. Do you want to auto-download and install it?",
    pythonInstalling: "Downloading and installing Python 3.10+...",
    pythonInstallSuccess: "Python 3.10+ installed successfully",
    pythonInstallFailed: (err) =>
      `Python installation failed: ${err} — you can install manually at https://www.python.org/downloads/`,
    pythonInstallNotSupported: (platform) =>
      `Auto-install not supported on ${platform}. Please install Python 3.10+ manually from https://www.python.org/downloads/`,
    pythonInstallWinget: "Installing Python via winget...",
    pythonInstallWingetHint:
      "winget is downloading and installing Python — this may take a few minutes, please wait...",
    pythonInstallScoop: "Installing Python via scoop...",
    graphifyCheck: (v) => `graphify ${v}`,
    graphifyInstalling: "Installing graphify (code knowledge graph)...",
    graphifyInstalled: "graphify installed and Claude skill registered",
    graphifyUpgrading: "Upgrading graphify to latest version...",
    graphifyUpgraded: (v) => `graphify upgraded to ${v}`,
    graphifyUpgradeFailed: `graphify upgrade failed (non-blocking)`,
    graphifyInstallFailed: `
✗ graphify installation failed (non-blocking)

Possible causes:
1. Python not found → Ensure Python 3.10+ is installed and in PATH
2. pip error → Run: pip install graphifyy manually to see details
3. Network error → Check your internet/proxy connection

→ Fix: Run: pip install graphifyy && python -m graphify claude install
`,
    graphifyAlreadyInstalled: (v) => `graphify ${v} — already installed`,
    graphifySkillRegistering: (p) => `Registering graphify ${p} skill...`,
    graphifySkillRegistered: (p) => `graphify ${p} skill registered`,
    graphifySkillFailed: (p) =>
      `graphify ${p} skill registration failed (non-blocking)`,
    networkxCheck: (v) => `networkx ${v}`,
    networkxUpgrading:
      "Upgrading networkx to >=3.4 for graphify compatibility...",
    networkxUpgraded: (v) => `networkx upgraded to ${v}`,
    networkxUpgradeFailed:
      "networkx upgrade failed (graphify may not generate graphs correctly)",
    networkxAlreadyOk: (v) => `networkx ${v} — compatible`,
    graphifyHookInstalling:
      "Installing git hooks for auto graph rebuild on commit/checkout...",
    graphifyHookInstalled:
      "graphify git hooks installed (auto-rebuild on commit/checkout)",
    graphifyHookFailed: "graphify git hook installation failed (non-blocking)",
    stepMcpMemory: "MCP Memory Service (Layer 3)",
    mcpMemoryInstalling: "Installing MCP Memory Service (Layer 3)...",
    mcpMemoryInstalled: "MCP Memory Service installed",
    mcpMemoryInstallFailed:
      "MCP Memory Service installation failed (non-blocking)",
    mcpMemoryAlreadyInstalled: (v) =>
      `MCP Memory Service ${v} — already installed`,
    mcpMemoryStopping: "Stopping running MCP Memory Service before upgrade...",
    mcpMemoryStopped: "MCP Memory Service stopped",
    mcpMemoryUpgrading: "Upgrading MCP Memory Service to latest version...",
    mcpMemoryUpgraded: (v) => `MCP Memory Service upgraded to ${v}`,
    mcpMemoryUpgradeFailed: "MCP Memory Service upgrade failed (non-blocking)",
    mcpMemoryServerRegistered: "MCP Memory Service registered in .mcp.json",
    mcpMemoryServerExists: ".mcp.json already has MCP Memory Service",
    askMcpMemoryInstall:
      "Install MCP Memory Service (Layer 3)? Provides vector-level session memory with sqlite-vec.",
    mcpMemorySkipped: "MCP Memory Service skipped",
    mcpMemoryServerStartHint:
      "MCP Memory Service installed — start with: python -m mcp_memory_service  (or: uv run memory server -s hybrid)",
    mcpMemoryHookInstalling:
      "Installing Claude Code SessionStart hook for memory service...",
    mcpMemoryHookInstalled: "SessionStart hook installed",
    mcpMemoryHookWarnings:
      "Hook installation reported warnings (non-blocking) — underlying stderr shown below:",
    mcpMemoryAutoStarting: "Starting MCP Memory Service (HTTP, background)...",
    mcpMemoryAutoStarted: "MCP Memory Service running at http://localhost:8000",
    mcpMemoryAutoStartFailed: "Auto-start failed — start manually:",
    mcpMemoryAutoStartManual: "  memory server --http",
    mcpMemoryAutoStartBoot: "Boot auto-start configured",
    updateHeading: "Update Mode",
    updateNpm: "Reinstalling npm dependencies...",
    updateSkills: "Updating all skills...",
    updateSyncProjectFiles:
      "Syncing tool configs in this repo from canonical/...",
    updateSyncDone: "Sync complete",
    updateSyncProjectSkipped: "Project sync skipped (global update mode)",
    updateSyncSkip: "Sync skipped or failed",
    updateReGlobal: "Re-select global skills directory?",
    askReselectRuntimes: "Re-select AI coding tools for this machine?",
    askPythonToolsUpdate: "Install Python graphify (code knowledge graph)?",
    pythonToolsSkipped: "Python tools skipped",
    askGlobalSkillsUpdate: "Update global skills? (optional)",
    updateSkillsDone: "Global skills updated",
    globalSkillsSkipped: "Global skills skipped",
    askMetaTheoryUpdate: "Sync meta-theory to global directory? (optional)",
    updateMetaTheoryDone: "meta-theory synced to global",
    metaTheorySkipped: "meta-theory sync skipped",
    updateComplete: "Update complete!",
    // Installation overview strings
    installOverviewTitle: "Meta_Kim Installation Overview",
    installOverviewWill: "This process will:",
    installOverviewSyncConfig:
      "Sync configurations to project directory (canonical → .claude/.codex/openclaw/.cursor/)",
    installOverviewInstallSkills:
      "Install selected global skill repositories (~/.claude/skills/)",
    installOverviewSyncMeta: "Sync meta-theory to global directory",
    installOverviewOptionalPython: "Install Python graphify tool",
    installOverviewTargets: "Target tools:",
    installOverviewSkillList: "Skill repositories:",
    installOverviewNoSkills: "(none selected)",
    installOverviewScope: "Installation scope:",
    installOverviewEstimated: "Estimated time:",
    installOverviewTime: "2-5 minutes (depends on network speed)",
    // Progress step strings
    progressPrepareDir: "Prepare global skills directory",
    progressNpmInstall: "Install npm dependencies",
    progressSyncConfig: "Sync tool configurations",
    progressCleanupLegacy: "Clean up legacy skill files",
    progressInstallSkills: "Install global skills (may take several minutes)",
    progressSyncMeta: "Sync meta-theory",
    progressValidate: "Validate installation",
    // Confirm strings
    confirmStartInstall: "Start installation?",
    footprintTitle: "Installation footprint (from previous run)",
    footprintFirstInstall:
      "First install on this machine — no previous footprint recorded.",
    footprintRefreshNote: "Running install will refresh these entries.",
    footprintScopeGlobal: "Global",
    footprintScopeProject: "Project",
    footprintEntries: "entries",
    footprintCategoryLabels: {
      A: "Global runtime skills",
      B: "Global runtime hooks",
      C: "Global settings.json merges",
      D: "Project runtime skills",
      E: "Project runtime hooks",
      F: "Project runtime agents",
      G: "Project settings + MCP config",
      H: "Project local state (.meta-kim/)",
      I: "Shared dependencies (pip / git hooks)",
    },
    installCancelled: "Installation cancelled",
    installComplete: "Installation complete!",
    // Warning messages
    warnConfigSyncFailed: `
⚠ Config sync failed, continuing...

Possible causes:
1. File locked → Close IDE/Explorer on the target directory
2. Permission denied → Run as administrator
3. Git conflict → Resolve conflicts in canonical/ and retry

→ Fix: Run: node scripts/sync-runtimes.mjs --scope both
`,
    warnSkillsInstallFailed: `
⚠ Global skills install failed

Possible causes:
1. Directory locked (EBUSY) → Close Explorer/IDE, wait for antivirus, then retry
2. Network error → Check proxy settings with: node setup.mjs --prompt-proxy
3. Repo not found → Verify the skill repository URL is correct

→ Fix: Run: node setup.mjs --update
→ Hint: If EBUSY, close programs holding the skills folder, then manually delete any *.staged-* temp dirs.
`,
    warnMetaTheorySyncFailed: `
⚠ meta-theory sync failed

Possible causes:
1. Directory locked → Close programs holding ~/.claude/skills/
2. Permission denied → Check write permissions on global skills dir
3. Network error → Verify proxy settings

→ Fix: Run: node scripts/sync-global-meta-theory.mjs --targets claude
`,
    warnSkillsUpdateFailed: `
⚠ Global skills update failed

Possible causes:
1. Directory locked (EBUSY) → Close Explorer/IDE, wait for antivirus, then retry
2. Git fetch failed → Check network/proxy connection
3. Conflicts → Review staged files and resolve manually

→ Hint: If EBUSY, close programs holding the skills folder, then manually delete any *.staged-* temp dirs.
→ Fix: Run: node setup.mjs --update
`,
    warnSkillsUpdateFailedHint:
      "If the log shows EBUSY or 'resource busy', close Explorer/IDE on the skills folder, wait for antivirus/indexing to finish, then retry. You can delete leftover *.staged-* dirs manually once nothing holds the path.",
    warnMetaTheoryUpdateFailed: `
⚠ meta-theory sync failed

Possible causes:
1. Directory locked → Close programs holding ~/.claude/skills/
2. Permission denied → Check write permissions on global skills dir
3. Network error → Verify proxy settings

→ Fix: Run: node scripts/sync-global-meta-theory.mjs --targets claude
`,
    warnManifestLoadFail: (msg) => `Failed to load skills manifest: ${msg}`,
    labelOptional: "(optional)",
    selectedScope: (name) => `Selected: ${name}`,
    npmVerOk: (v) => `npm v${v}`,
    activeRuntimesSavedCli: (list) =>
      `Target tools saved from --targets: ${list}`,
    savedActiveTargets: (list) => `Saved target tools: ${list}`,
    okRepoSynced: "Repo projections synced from canonical/",
    failRepoSync:
      "Repo projection sync failed — some in-repo configs may be stale",
    pipErrorDetail: (err) => `  pip error: ${err}`,
    modeInfoLine: (mode, plat, ver) => `Mode: ${mode} | ${plat} | Node ${ver}`,
    stepLabel: (n, label) => `Step ${n}: ${label}`,
    // Proxy
    proxyHeading: "Network / Proxy",
    proxyDetectedPrompt: (port, url) =>
      `Detected proxy port ${port} (${url}). Use it?`,
    proxySkip: "No proxy — using direct connection",
    proxySkipDeclined: "Proxy declined — using direct connection",
    proxySaved: (url) => `Proxy saved: ${url}`,
    stepLabel: (n, label) => `Step ${n}: ${label}`,
    progressInstallPython: "Install Python graphify tool",
    progressInstallMcpMemory: "Install MCP Memory Service (Layer 3)",
    checkTargets: (active, supported) =>
      `activeTargets=${active} supportedTargets=${supported}`,
    localStateHeader: "Local state",
    localStateProfile: (profile, key) => `profile=${profile} key=${key}`,
    localStateRunIndex: (path) => `run index: ${path}`,
    localStateCompaction: (path) => `compaction: ${path}`,
    localStateDispatch:
      "dispatch envelope: config/contracts/workflow-contract.json -> protocols.dispatchEnvelopePacket",
    localStateMigration:
      "migration helper: npm run migrate:meta-kim -- <source-dir> --apply",
    actionPrompt: "What would you like to do?",
    actionInstall: "Install — Full first-time setup",
    actionInstallQuick: "Quick setup — Pick one platform, ready to use",
    actionUpdate: "Update — Refresh skills & sync tools",
    actionCheck: "Check — Verify dependencies & sync status",
    actionExit: "Exit",

    npxQuickHeading: "Quick Setup",
    npxQuickPlatformPrompt: "Which platform do you use?",
    npxQuickPlatformClaude: "Claude Code",
    npxQuickPlatformOpenclaw: "OpenClaw",
    npxQuickPlatformCodex: "Codex CLI",
    npxQuickPlatformCursor: "Cursor",
    npxQuickPlatformAll: "All platforms",
    npxQuickDirPrompt: "Where should I create the project?",
    npxQuickDirDefault: "~/Desktop/Meta_Kim",
    npxQuickCreating: "Creating project at",
    npxQuickCopyFiles: "Copying platform files",
    npxQuickDirExists: "Directory already exists — will update files inside",
    npxQuickDone: "Project ready!",
    npxQuickOpenIn: "Open your platform in this directory:",
    npxQuickAskDeploy:
      "Deploy runtime files to a custom directory? (e.g. Desktop)",
    npxQuickDeployYes: "Yes, deploy to a custom directory",
    npxQuickDeployNo: "No, skip for now",
    aboutAuthor: "About the Author",
    contactWebsite: "Website",
    contactGithub: "GitHub",
    contactFeishu: "Feishu Wiki",
    contactWechat: "WeChat Official Account",
  },
  "zh-CN": {
    modeCheck: "仅检查",
    modeUpdate: "更新",
    modeSilent: "静默",
    modeInteractive: "交互式",
    preflightHeading: "环境检查",
    nodeOld: (v) => `Node.js v${v} 版本过低，需要 >=${MIN_NODE_VERSION}`,
    nodeOk: (v) => `Node.js v${v}`,
    npmNotFound: "npm 未找到",
    gitNotFound: "git 未找到 — 安装技能需要 git",
    proxyInfo: (p) => `代理: ${p}`,
    pkgFound: "package.json 已找到",
    pkgNotFound: "package.json 未找到 — 请在 Meta_Kim 根目录运行",
    envFailed: "环境检查未通过，请先解决上述问题。",
    envOk: "环境检查通过！",
    stepRuntime: "检测 AI 编程工具",
    claudeDetected: (v) => `Claude Code ${v}`,
    claudeNotDetected: "未检测到 Claude Code CLI",
    codexDetected: (v) => `Codex ${v}`,
    codexNotDetected: "未检测到 Codex CLI（可选）",
    openclawDetected: (v) => `OpenClaw ${v}`,
    openclawNotDetected: "未检测到 OpenClaw CLI（可选）",
    cursorDetected: (v) => `Cursor ${v}`,
    cursorNotDetected: "未检测到 Cursor CLI（可选）",
    noRuntime: "未检测到 AI 编程工具。",
    noRuntimeHint1: "Meta_Kim 支持 Claude Code、Codex、OpenClaw 或 Cursor。",
    noRuntimeHint2: "至少安装一个：{claudeCodeDocs}",
    continueAnyway: "仍然继续安装？",
    setupCancelled: "安装已取消。请先安装 AI 编程工具。",
    stepConfig: "项目配置",
    mcpExists: ".mcp.json 已配置",
    mcpCreated: ".mcp.json 已创建 — 已注册 MCP 服务",
    settingsExists: ".claude/settings.json 已配置",
    askCreateSettings: "创建 .claude/settings.json（含 hooks 配置）？",
    settingsCreated: ".claude/settings.json 已创建 — hooks 和权限已注册",
    settingsSkipped: ".claude/settings.json 已跳过（用户选择）",
    settingsSkippedNoClaude:
      ".claude/settings.json 已跳过（未检测到 Claude Code）",
    stepSkills: "安装技能",
    shipsSkills: (n) => `Meta_Kim 内置 ${n} 个技能：`,
    runningNpm: "正在运行 npm install ...",
    npmDone: "npm 依赖安装完成",
    npmFailed: `
✗ npm install 失败

可能原因：
1. 网络错误 → 检查网络连接和代理设置
2. Node 版本不兼容 → 确保已安装 Node ${MIN_NODE_VERSION}+
3. 权限问题 → 运行：npm install --no-optional

修复：手动运行命令查看完整输出：npm install
`,
    nodeModulesExist: "node_modules 已存在（使用 --update 重新安装）",
    skillUpdated: (n) => `${n} — 已更新`,
    skillInstalled: (n) => `${n} — 已安装`,
    skillExists: (n) => `${n} — 已安装`,
    skillSubdirInstalled: (n, s) => `${n} — 已安装 (子目录: ${s})`,
    skillFailed: (n, r) => `
✗ 技能安装失败：${n}

可能原因：
1. 网络超时 → 运行：npm run meta:sync -- --skills
2. 权限被拒绝 → 使用 sudo/管理员权限运行
3. 仓库未找到 → 检查技能仓库 URL

${r ? `原始错误：${r}` : ""}
`,
    skillUpdateFailed: (n) =>
      `${n} — 更新跳过（非 fast-forward，保留现有版本）`,
    skillSubdirNotFound: (n) => `${n} — 子目录未找到`,
    skillsReady: (ok, total, fail) =>
      `${ok}/${total} 个技能就绪${fail > 0 ? `，${fail} 个失败` : ""}`,
    stepValidate: "项目验证",
    agentPrompts: (n) => `${n} 个 meta-agent 提示词`,
    validationPassed: "项目验证通过",
    validationWarnings: "验证有警告（不影响使用）",
    setupComplete: "安装完成！",
    whatMetaDoes: "Meta_Kim 是什么：",
    whatMetaDoesDesc1: "给你的 AI 编程助手配上一支专家团队：",
    whatMetaDoesDesc2: "有人负责代码审查，有人负责安全，有人负责记忆——",
    whatMetaDoesDesc3: "全部自动协调，无需手动管理。",
    howToUse: "如何使用：",
    step1Open: "在此目录打开 Claude Code：",
    step2Try: "试试 meta-theory 命令：",
    step3Or: "或直接让 Claude 做复杂任务：",
    step3Hint: "（Meta_Kim 会自动协调各专家）",
    codexNote: "Codex 提示词同步到 .codex/",
    openclawNote: "OpenClaw 工作区同步到 openclaw/",
    cursorNote: "Cursor 智能体同步到 .cursor/",
    noRuntimeGetStarted: "未检测到 AI 编程工具。安装 Claude Code 开始使用：",
    usefulCommands: "常用命令：",
    cmdUpdate: "更新所有技能",
    cmdCheck: "检查环境",
    cmdDoctor: "诊断 Meta_Kim 健康状态",
    cmdVerify: "完整验证",
    // 安装后注意事项
    postInstallNotesHeading: "安装后注意事项：",
    postInstallNotesIntro: "安装完成后，各层能力的使用方式如下：",
    postInstallNotesPlatformSync: "各平台能力同步情况：",
    platformClauleCode: "Claude Code",
    platformClauleCodeCap: "agents + skills + hooks",
    platformCodex: "Codex",
    platformCodexCap: "agents + skills",
    platformOpenClaw: "OpenClaw",
    platformOpenClawCap: "workspace + skills",
    platformCursor: "Cursor",
    platformCursorCap: "agents + skills",
    postInstallNotesLayerActivation: "三层记忆激活方式：",
    layer1Label: "第一层（Memory）",
    layer1Note: "自动激活——内置于 Claude Code",
    layer2Label: "第二层（Graphify）",
    layer2Note: "安装 graphifyy 后自动激活（pip install graphifyy）",
    layer3Label: "第三层（SQL / MCP Memory Service）",
    layer3Note:
      "需手动启动服务器：python -m mcp_memory_service（然后访问 http://localhost:8000）",
    installLocationsHeading: "安装位置：",
    installLocationsProject: "项目级（当前目录）",
    installLocationsGlobal: "全局级（跨项目共享）",
    installLocationsManifest: "安装清单（可安全卸载）",
    usefulCommandsHeading: "常用后续命令：",
    cmdWhereStatus: "查看所有产物位置",
    cmdWhereStatusDiff: "对比上次安装",
    cmdWhereUninstall: "安全卸载",
    postInstallNotesReminder: "提醒：",
    postInstallNotesReminderText:
      "随时可运行 node setup.mjs --check 验证安装状态。",
    setupError: "安装出错：",
    setupInterrupted:
      "已中断（Ctrl+C），安装未完成。需要时请重新运行：node setup.mjs",
    selectLang: "Select language / 选择语言 / 言語を選択 / 언어 선택",
    choose: (n) => `选择 (1-${n})`,
    inquirerSingleHotkeys: "↑↓ 移动选项 · ⏎ 确认",
    inquirerMultiHotkeys: "↑↓ 移动 · 空格 勾选/取消 · ⏎ 确认 · a 全选 · i 反选",
    globalInstallPrompt:
      "Meta_Kim 技能安装到 ~/.claude/skills/（全局）。是否全局安装？",
    globalDirReady: (p) => `全局技能目录就绪：${p}`,
    globalDirCreated: (p) => `已创建全局技能目录：${p}`,
    globalDirCreateFailed: (e) => `创建全局技能目录失败：${e}`,
    globalDirTitle: "全局技能目录",
    globalDirPrompt: `Meta_Kim 技能将安装到 ~/.claude/skills/
• 全局安装 — 所有项目共享
• 跳过 — 仅在当前项目使用
• 随时可重新运行 setup.mjs 安装`,
    globalSkipped: "全局安装已跳过 — 将仅在当前项目使用",
    // 安装范围选择
    installScopeHeading: "安装范围",
    installScopePrompt: "本仓库、用户目录技能、还是两者都要？",
    installScopeProject: "仅本仓库 — .claude / .codex / openclaw / .cursor",
    installScopeGlobal:
      "仅用户目录 — 所选工具各自的 ~/.*/skills（非仅 Claude）",
    installScopeBoth: "两者（推荐）— 先本仓库，再用户目录",
    installScopeProjectLabel: "仅本仓库",
    installScopeGlobalLabel: "仅用户目录",
    installScopeBothLabel: "两者（推荐）",
    installScopeProjectDesc: "只更新本仓库内各工具配置；不改用户目录 skills。",
    installScopeGlobalDesc:
      "按下一步所选工具写入各 skills + 全局 meta-theory；不改本仓库。",
    installScopeBothDesc: "先本仓库，后用户目录。",
    depCheckHeading: "依赖检查",
    depOk: (n) => `${n} — 正常`,
    depMissing: (n) => `${n} — 缺失`,
    depNoFiles: (n) => `${n} — 目录存在但无 .md 文件`,
    selectRuntimeTargets: "这台电脑上用哪些 AI 编程工具？",
    selectSkillDependencies: "要安装哪些第三方技能仓库到全局 ~/.*/skills/？",
    inputTargetsHint: (d) => `输入编号，逗号多选；回车使用默认 ${d}`,
    inputSkillIdsHint: (d) => `输入编号，逗号多选；回车使用默认 ${d}`,
    warnUnknownSkillId: (id) => `未知的技能 id（已忽略）：${id}`,
    depSummaryAll: "全部 9 个依赖验证通过",
    depSummarySome: (ok, total) =>
      `仅 ${ok}/${total} 个依赖验证通过 — 请使用 --update 重新安装`,
    syncHeading: "同步状态检查",
    syncClaudeAgents: (n) => `Claude Code 智能体: ${n}/8 .md 文件`,
    syncClaudeSkills: "Claude Code 技能/meta-theory/SKILL.md",
    syncClaudeHooks: (n) => `Claude Code 钩子: ${n} 个脚本`,
    syncClaudeSettings: "Claude Code .claude/settings.json",
    syncClaudeMcp: "Claude Code .mcp.json",
    syncCodexAgents: (n) => `Codex 智能体: ${n}/8 .toml 文件`,
    syncCodexSkills: "Codex 技能/meta-theory/SKILL.md",
    syncOpenclawWorkspaces: (n) =>
      `OpenClaw 工作区：${n}/8 个智能体，各目录 9 个必备 Markdown 已齐（含 BOOT、SOUL 等；不含子文件夹里的额外文件）`,
    syncOpenclawSkill: "OpenClaw 共享 meta-theory",
    syncSharedSkills: "共享技能/meta-theory/SKILL.md",
    syncCursorAgents: (n) => `Cursor 智能体: ${n}/8 .md 文件`,
    syncCursorSkills: "Cursor 技能/meta-theory/SKILL.md",
    syncCursorMcp: "Cursor .cursor/mcp.json",
    syncOk: "所有同步目标验证通过",
    syncMissing: (p) => `缺失：${p}`,
    syncPartial: (label, got, need) => `${label}：实际 ${got}，需要 ${need}`,
    stepPythonTools: "可选 Python 工具",
    pythonNotFound: "未检测到 Python 3.10+ — 跳过 graphify",
    pythonHint:
      "安装 Python 3.10+ 后运行：pip install graphifyy && python -m graphify claude install",
    pythonNotFoundOfferInstall: "未检测到 Python 3.10+，是否要自动下载安装？",
    pythonInstalling: "正在下载安装 Python 3.10+...",
    pythonInstallSuccess: "Python 3.10+ 安装成功",
    pythonInstallFailed: (err) =>
      `Python 安装失败：${err} — 可手动从 https://www.python.org/downloads/ 下载安装`,
    pythonInstallNotSupported: (platform) =>
      `${platform} 平台暂不支持自动安装，请从 https://www.python.org/downloads/ 手动下载 Python 3.10+`,
    pythonInstallWinget: "正在通过 winget 安装 Python...",
    pythonInstallWingetHint:
      "winget 正在下载安装 Python — 可能需要几分钟，请耐心等待...",
    pythonInstallScoop: "正在通过 scoop 安装 Python...",
    graphifyCheck: (v) => `graphify ${v}`,
    graphifyInstalling: "正在安装 graphify（代码知识图谱）...",
    graphifyInstalled: "graphify 已安装，Claude 技能已注册",
    graphifyUpgrading: "正在升级 graphify 至最新版本...",
    graphifyUpgraded: (v) => `graphify 已升级至 ${v}`,
    graphifyUpgradeFailed: `graphify 升级失败（不影响其他功能）`,
    graphifyInstallFailed: `
✗ graphify 安装失败（不影响其他功能）

可能原因：
1. Python 未找到 → 确保 Python 3.10+ 已安装并在 PATH 中
2. pip 错误 → 运行：pip install graphifyy 查看详细错误
3. 网络错误 → 检查网络/代理连接

修复：pip install graphifyy && python -m graphify claude install
`,
    graphifyAlreadyInstalled: (v) => `graphify ${v} — 已安装`,
    graphifySkillRegistering: (p) => `正在注册 graphify ${p} 技能...`,
    graphifySkillRegistered: (p) => `graphify ${p} 技能已注册`,
    graphifySkillFailed: (p) => `graphify ${p} 技能注册失败（不影响其他功能）`,
    networkxCheck: (v) => `networkx ${v}`,
    networkxUpgrading: "正在升级 networkx 至 >=3.4 以兼容 graphify...",
    networkxUpgraded: (v) => `networkx 已升级至 ${v}`,
    networkxUpgradeFailed: "networkx 升级失败（graphify 可能无法正确生成图谱）",
    networkxAlreadyOk: (v) => `networkx ${v} — 版本兼容`,
    graphifyHookInstalling:
      "正在安装 git hook（commit/checkout 时自动重建图谱）...",
    graphifyHookInstalled:
      "graphify git hook 已安装（commit/checkout 时自动重建图谱）",
    graphifyHookFailed: "graphify git hook 安装失败（不影响其他功能）",
    stepMcpMemory: "MCP Memory Service（第三层）",
    mcpMemoryInstalling: "正在安装 MCP Memory Service（第三层）...",
    mcpMemoryInstalled: "MCP Memory Service 已安装",
    mcpMemoryInstallFailed: "MCP Memory Service 安装失败（不影响其他功能）",
    mcpMemoryAlreadyInstalled: (v) => `MCP Memory Service ${v} — 已安装`,
    mcpMemoryStopping: "升级前正在停止 MCP Memory Service...",
    mcpMemoryStopped: "MCP Memory Service 已停止",
    mcpMemoryUpgrading: "正在升级 MCP Memory Service 至最新版本...",
    mcpMemoryUpgraded: (v) => `MCP Memory Service 已升级至 ${v}`,
    mcpMemoryUpgradeFailed: "MCP Memory Service 升级失败（不影响其他功能）",
    mcpMemoryServerRegistered: "MCP Memory Service 已注册到 .mcp.json",
    mcpMemoryServerExists: ".mcp.json 已包含 MCP Memory Service",
    askMcpMemoryInstall:
      "安装 MCP Memory Service（第三层）？提供向量级会话记忆（sqlite-vec）",
    mcpMemorySkipped: "MCP Memory Service 已跳过",
    mcpMemoryServerStartHint:
      "MCP Memory Service 已安装——启动方式：python -m mcp_memory_service  （或：uv run memory server -s hybrid）",
    mcpMemoryHookInstalling:
      "正在安装 Claude Code SessionStart 钩子（供记忆服务使用）...",
    mcpMemoryHookInstalled: "SessionStart 钩子已安装",
    mcpMemoryHookWarnings:
      "钩子安装产生警告（不影响后续流程）——以下是子进程 stderr 原文：",
    mcpMemoryAutoStarting: "正在启动 MCP Memory Service（HTTP 后台模式）...",
    mcpMemoryAutoStarted: "MCP Memory Service 已运行于 http://localhost:8000",
    mcpMemoryAutoStartFailed: "自动启动失败——请手动启动：",
    mcpMemoryAutoStartManual: "  memory server --http",
    mcpMemoryAutoStartBoot: "已配置开机自启",
    updateHeading: "更新模式",
    updateNpm: "正在重新安装 npm 依赖...",
    updateSkills: "正在更新所有技能...",
    updateSyncProjectFiles: "正在从 canonical/ 同步本仓库内的工具配置...",
    updateSyncDone: "同步完成",
    updateSyncProjectSkipped: "跳过项目同步（全局更新模式）",
    updateSyncSkip: "未同步或同步失败",
    updateReGlobal: "是否重新选择全局技能目录？",
    askReselectRuntimes: "重新选择这台电脑的 AI 编程工具？",
    askPythonToolsUpdate: "安装 Python graphify（代码知识图谱）？",
    pythonToolsSkipped: "Python 工具已跳过",
    askGlobalSkillsUpdate: "更新全局技能？（可选）",
    updateSkillsDone: "全局技能已更新",
    globalSkillsSkipped: "全局技能已跳过",
    askMetaTheoryUpdate: "同步 meta-theory 到全局目录？（可选）",
    updateMetaTheoryDone: "meta-theory 已同步到全局",
    metaTheorySkipped: "meta-theory 同步已跳过",
    updateComplete: "更新完成！",
    // 安装概览字符串
    installOverviewTitle: "Meta_Kim 安装概览",
    installOverviewWill: "此过程将：",
    installOverviewSyncConfig:
      "同步配置文件 (canonical → .claude/.codex/openclaw/.cursor/)",
    installOverviewInstallSkills: "安装所选全局技能仓库（~/.claude/skills/）",
    installOverviewSyncMeta: "同步 meta-theory 到全局目录",
    installOverviewOptionalPython: "可选：安装 Python graphify 工具",
    installOverviewTargets: "目标工具：",
    installOverviewSkillList: "技能仓库：",
    installOverviewNoSkills: "（未选择）",
    installOverviewScope: "安装范围：",
    installOverviewEstimated: "预计用时：",
    installOverviewTime: "2-5 分钟（取决于网络速度）",
    // 进度步骤字符串
    progressPrepareDir: "准备全局技能目录",
    progressNpmInstall: "安装 npm 依赖",
    progressSyncConfig: "同步配置文件",
    progressCleanupLegacy: "清理旧版技能文件",
    progressInstallSkills: "安装全局技能（可能需要几分钟）",
    progressSyncMeta: "同步 meta-theory",
    progressValidate: "验证安装",
    // 确认字符串
    confirmStartInstall: "开始安装？",
    footprintTitle: "安装足迹（上次安装记录）",
    footprintFirstInstall: "首次安装 — 无历史足迹可显示。",
    footprintRefreshNote: "本次安装将刷新上述条目。",
    footprintScopeGlobal: "全局",
    footprintScopeProject: "项目",
    footprintEntries: "条",
    footprintCategoryLabels: {
      A: "全局运行时技能",
      B: "全局运行时钩子",
      C: "全局 settings.json 合并",
      D: "项目运行时技能",
      E: "项目运行时钩子",
      F: "项目运行时智能体",
      G: "项目 settings + MCP 配置",
      H: "项目本地状态 (.meta-kim/)",
      I: "共享依赖 (pip / git 钩子)",
    },
    installCancelled: "安装已取消",
    installComplete: "安装完成！",
    // Warning messages
    warnConfigSyncFailed: `
⚠ 配置同步失败，继续安装...

可能原因：
1. 文件被锁定 → 关闭目标目录的 IDE/资源管理器窗口
2. 权限被拒绝 → 以管理员身份运行
3. Git 冲突 → 解决 canonical/ 中的冲突后重试

修复：node scripts/sync-runtimes.mjs --scope both
`,
    warnSkillsInstallFailed: `
⚠ 全局技能安装失败

可能原因：
1. 目录被锁定（EBUSY）→ 关闭资源管理器/IDE，等待杀毒/索引完成后重试
2. 网络错误 → 使用 node setup.mjs --prompt-proxy 检查代理设置
3. 仓库未找到 → 验证技能仓库 URL 是否正确

修复：node setup.mjs --update
提示：如遇 EBUSY，先关闭占用 skills 目录的程序，然后手动删除残留的 *.staged-* 临时目录。
`,
    warnMetaTheorySyncFailed: `
⚠ meta-theory 同步失败

可能原因：
1. 目录被锁定 → 关闭占用 ~/.claude/skills/ 的程序
2. 权限被拒绝 → 检查全局技能目录的写入权限
3. 网络错误 → 验证代理设置

修复：node scripts/sync-global-meta-theory.mjs --targets claude
`,
    warnSkillsUpdateFailed: `
⚠ 全局技能更新失败

可能原因：
1. 目录被锁定（EBUSY）→ 关闭资源管理器/IDE，等待杀毒/索引完成后重试
2. Git fetch 失败 → 检查网络/代理连接
3. 冲突 → 查看 staged 文件并手动解决

提示：如遇 EBUSY，先关闭占用 skills 目录的程序，然后手动删除残留的 *.staged-* 临时目录。
修复：node setup.mjs --update
`,
    warnSkillsUpdateFailedHint:
      "若日志含 EBUSY/目录被占用：请先关闭对该目录的资源管理器窗口与 IDE 监视、等待杀毒/索引结束后再重试；解锁后可手动删除残留的 *.staged-* 临时目录。",
    warnMetaTheoryUpdateFailed: `
⚠ meta-theory 同步失败

可能原因：
1. 目录被锁定 → 关闭占用 ~/.claude/skills/ 的程序
2. 权限被拒绝 → 检查全局技能目录的写入权限
3. 网络错误 → 验证代理设置

修复：node scripts/sync-global-meta-theory.mjs --targets claude
`,
    warnManifestLoadFail: (msg) => `加载技能清单失败：${msg}`,
    labelOptional: "（可选）",
    selectedScope: (name) => `已选择：${name}`,
    npmVerOk: (v) => `npm v${v}`,
    activeRuntimesSavedCli: (list) => `已从 --targets 保存目标工具：${list}`,
    savedActiveTargets: (list) => `已保存目标工具：${list}`,
    okRepoSynced: "仓库投影已从 canonical/ 同步",
    failRepoSync: "仓库投影同步失败 — 本仓库内部分配置可能已过期",
    pipErrorDetail: (err) => `  pip 错误：${err}`,
    modeInfoLine: (mode, plat, ver) => `模式：${mode} | ${plat} | Node ${ver}`,
    stepLabel: (n, label) => `步骤 ${n}：${label}`,
    // Proxy
    proxyHeading: "网络 / 代理",
    proxyDetectedPrompt: (port, url) =>
      `检测到代理端口 ${port}（${url}），是否使用？`,
    proxySkip: "未检测到代理 — 直连",
    proxySkipDeclined: "已拒绝代理 — 直连",
    proxySaved: (url) => `已保存代理：${url}`,
    stepLabel: (n, label) => `步骤 ${n}：${label}`,
    progressInstallPython: "安装 Python graphify 工具",
    progressInstallMcpMemory: "安装 MCP Memory Service（第三层）",
    checkTargets: (active, supported) =>
      `activeTargets=${active} supportedTargets=${supported}`,
    localStateHeader: "本地状态",
    localStateProfile: (profile, key) => `profile=${profile} key=${key}`,
    localStateRunIndex: (path) => `运行索引：${path}`,
    localStateCompaction: (path) => `压缩目录：${path}`,
    localStateDispatch:
      "调度信封：config/contracts/workflow-contract.json -> protocols.dispatchEnvelopePacket",
    localStateMigration:
      "迁移助手：npm run migrate:meta-kim -- <source-dir> --apply",
    actionPrompt: "你想做什么？",
    actionInstall: "安装 — 首次完整安装",
    actionInstallQuick: "快速配置 — 选一个平台，开箱即用",
    actionUpdate: "更新 — 刷新技能并同步配置",
    actionCheck: "检查 — 验证依赖和同步状态",
    actionExit: "退出",

    npxQuickHeading: "快速配置",
    npxQuickPlatformPrompt: "你用哪个平台？",
    npxQuickPlatformClaude: "Claude Code",
    npxQuickPlatformOpenclaw: "OpenClaw",
    npxQuickPlatformCodex: "Codex CLI",
    npxQuickPlatformCursor: "Cursor",
    npxQuickPlatformAll: "全部平台",
    npxQuickDirPrompt: "项目创建在哪里？",
    npxQuickDirDefault: "~/Desktop/Meta_Kim",
    npxQuickCreating: "正在创建项目：",
    npxQuickCopyFiles: "正在拷贝平台文件",
    npxQuickDirExists: "目录已存在 — 将更新其中的文件",
    npxQuickDone: "项目就绪！",
    npxQuickOpenIn: "在该目录打开你的平台：",
    npxQuickAskDeploy: "要把运行时文件部署到指定目录吗？（比如桌面）",
    npxQuickDeployYes: "是，部署到指定目录",
    npxQuickDeployNo: "不用了，跳过",
    aboutAuthor: "关于作者",
    contactWebsite: "个人主页",
    contactGithub: "GitHub",
    contactFeishu: "飞书开源知识库",
    contactWechat: "微信公众号",
  },
  "ja-JP": {
    modeCheck: "チェックのみ",
    modeUpdate: "更新",
    modeSilent: "サイレント",
    modeInteractive: "インタラクティブ",
    preflightHeading: "環境チェック",
    nodeOld: (v) =>
      `Node.js v${v} は古すぎます。>=${MIN_NODE_VERSION} が必要です`,
    nodeOk: (v) => `Node.js v${v}`,
    npmNotFound: "npm が見つかりません",
    gitNotFound: "git が見つかりません — スキルのインストールに必要です",
    proxyInfo: (p) => `プロキシ: ${p}`,
    pkgFound: "package.json が見つかりました",
    pkgNotFound:
      "package.json が見つかりません — Meta_Kim ルートで実行してください",
    envFailed: "環境チェックに失敗しました。上記の問題を解決してください。",
    envOk: "環境チェックOK！",
    stepRuntime: "AIコーディングツール検出",
    claudeDetected: (v) => `Claude Code ${v}`,
    claudeNotDetected: "Claude Code CLI が検出されませんでした",
    codexDetected: (v) => `Codex ${v}`,
    codexNotDetected: "Codex CLI が検出されませんでした（オプション）",
    openclawDetected: (v) => `OpenClaw ${v}`,
    openclawNotDetected: "OpenClaw CLI が検出されませんでした（オプション）",
    cursorDetected: (v) => `Cursor ${v}`,
    cursorNotDetected: "Cursor CLI が検出されませんでした（オプション）",
    noRuntime: "AIコーディングツールが検出されませんでした。",
    noRuntimeHint1:
      "Meta_Kim は Claude Code、Codex、OpenClaw、または Cursor で動作します。",
    noRuntimeHint2: "少なくとも1つインストールしてください：{claudeCodeDocs}",
    continueAnyway: "セットアップを続行しますか？",
    setupCancelled:
      "セットアップがキャンセルされました。AIコーディングツールをインストールして再実行してください。",
    stepConfig: "プロジェクト設定",
    mcpExists: ".mcp.json は既に設定されています",
    mcpCreated: ".mcp.json 作成済み — MCP サービスを登録",
    settingsExists: ".claude/settings.json は既に設定されています",
    askCreateSettings: ".claude/settings.json（hooks付き）を作成しますか？",
    settingsCreated:
      ".claude/settings.json 作成済み — hooks + パーミッション登録完了",
    settingsSkipped: ".claude/settings.json スキップ（ユーザー選択）",
    settingsSkippedNoClaude:
      ".claude/settings.json スキップ（Claude Code 未検出）",
    stepSkills: "スキルインストール",
    shipsSkills: (n) => `Meta_Kim には ${n} 個のスキルが含まれています：`,
    runningNpm: "npm install を実行中...",
    npmDone: "npm 依存関係のインストール完了",
    npmFailed: `
✗ npm install に失敗しました

考えられる原因：
1. ネットワークエラー → インターネット接続とプロキシ設定を確認
2. Node バージョンが不一致 → Node ${MIN_NODE_VERSION}+ がインストールされていることを確認
3. 権限の問題 → 実行：npm install --no-optional

修正：手動で実行して詳細を確認：npm install
`,
    nodeModulesExist: "node_modules が存在します（--update で再インストール）",
    skillUpdated: (n) => `${n} — 更新済み`,
    skillInstalled: (n) => `${n} — インストール済み`,
    skillExists: (n) => `${n} — インストール済み`,
    skillSubdirInstalled: (n, s) =>
      `${n} — インストール済み (サブディレクトリ: ${s})`,
    skillFailed: (n, r) => `
✗ スキルインストール失敗：${n}

考えられる原因：
1. ネットワークタイムアウト → 実行：npm run meta:sync -- --skills
2. 権限が拒否されました → sudo/管理者権限で実行
3. リポジトリが見つかりません → スキルリポジトリの URL を確認

${r ? `生エラー：${r}` : ""}
`,
    skillUpdateFailed: (n) =>
      `${n} — 更新スキップ（非 fast-forward、既存版を維持）`,
    skillSubdirNotFound: (n) => `${n} — サブディレクトリが見つかりません`,
    skillsReady: (ok, total, fail) =>
      `${ok}/${total} スキル準備完了${fail > 0 ? `、${fail} 失敗` : ""}`,
    stepValidate: "プロジェクト検証",
    agentPrompts: (n) => `${n} 個のメタエージェントプロンプト`,
    validationPassed: "プロジェクト検証に合格しました",
    validationWarnings: "検証に警告があります（機能に影響なし）",
    setupComplete: "セットアップ完了！",
    whatMetaDoes: "Meta_Kim とは：",
    whatMetaDoesDesc1: "AIコーディングエージェントに専門家チームを提供します：",
    whatMetaDoesDesc2: "コードレビュー、セキュリティ、メモリ管理などを",
    whatMetaDoesDesc3: "自動的に調整します。",
    howToUse: "使い方：",
    step1Open: "このディレクトリで Claude Code を開く：",
    step2Try: "meta-theory コマンドを試す：",
    step3Or: "または Claude に複雑なタスクを依頼する：",
    step3Hint: "（Meta_Kim が自動的に専門家を調整します）",
    codexNote: "Codex プロンプトは .codex/ に同期されます",
    openclawNote: "OpenClaw ワークスペースは openclaw/ に同期されます",
    cursorNote: "Cursor エージェントは .cursor/ に同期されます",
    noRuntimeGetStarted:
      "AIコーディングツールが検出されませんでした。Claude Code をインストールしてください：",
    usefulCommands: "便利なコマンド：",
    cmdUpdate: "すべてのスキルを更新",
    cmdCheck: "環境をチェック",
    cmdDoctor: "Meta_Kim の健全性を診断",
    cmdVerify: "フル検証",
    // インストール後の注意事項
    postInstallNotesHeading: "インストール後の注意事項：",
    postInstallNotesIntro: "インストール完了後、各層の使い方は以下の通りです：",
    postInstallNotesPlatformSync: "各プラットフォームの同期状況：",
    platformClauleCode: "Claude Code",
    platformClauleCodeCap: "agents + skills + hooks",
    platformCodex: "Codex",
    platformCodexCap: "agents + skills",
    platformOpenClaw: "OpenClaw",
    platformOpenClawCap: "workspace + skills",
    platformCursor: "Cursor",
    platformCursorCap: "agents + skills",
    postInstallNotesLayerActivation: "3層メモリの有効化方法：",
    layer1Label: "第1層（Memory）",
    layer1Note: "自動有効 — Claude Code に組み込み済み",
    layer2Label: "第2層（Graphify）",
    layer2Note: "graphifyy インストール後は自動有効（pip install graphifyy）",
    layer3Label: "第3層（SQL / MCP Memory Service）",
    layer3Note:
      "サーバー手動起動が必要：python -m mcp_memory_service（次に http://localhost:8000 にアクセス）",
    installLocationsHeading: "インストール先：",
    installLocationsProject: "プロジェクトレベル（このディレクトリ）",
    installLocationsGlobal: "グローバルレベル（プロジェクト間で共有）",
    installLocationsManifest:
      "インストールマニフェスト（安全にアンインストール可能）",
    usefulCommandsHeading: "次によく使うコマンド：",
    cmdWhereStatus: "すべての成果物の場所を表示",
    cmdWhereStatusDiff: "前回のインストールとの差分",
    cmdWhereUninstall: "安全にアンインストール",
    postInstallNotesReminder: "補足：",
    postInstallNotesReminderText:
      "node setup.mjs --check でいつでも導入状態を確認できます。",
    setupError: "セットアップエラー：",
    setupInterrupted:
      "中断しました（Ctrl+C）。未完了です。再開するときは node setup.mjs を実行してください。",
    selectLang: "Select language / 选择语言 / 言語を選択 / 언어 선택",
    choose: (n) => `選択 (1-${n})`,
    inquirerSingleHotkeys: "↑↓ 移動 · ⏎ 確定",
    inquirerMultiHotkeys: "↑↓ 移動 · Space 切替 · ⏎ 確定 · a 全選択 · i 反転",
    globalInstallPrompt:
      "Meta_Kim スキルは ~/.claude/skills/（グローバル）にインストールされます。グローバルインストールしますか？",
    globalDirReady: (p) => `グローバルスキルディレクトリ準備完了：${p}`,
    globalDirCreated: (p) => `グローバルスキルディレクトリ作成：${p}`,
    globalDirCreateFailed: (e) =>
      `グローバルスキルディレクトリの作成に失敗：${e}`,
    globalDirTitle: "グローバルスキルディレクトリ",
    globalDirPrompt: `Meta_Kim スキルは ~/.claude/skills/ にインストールされます
• グローバルインストール — すべてのプロジェクトで共有
• スキップ — このプロジェクトのみ
• いつでも setup.mjs を再実行してインストール`,
    globalSkipped:
      "グローバルインストールスキップ — プロジェクトローカルのみ使用",
    // インストール範囲選択
    installScopeHeading: "インストール範囲",
    installScopePrompt: "リポのみ／ホームの skills のみ／両方？",
    installScopeProject: "リポのみ — .claude / .codex / openclaw / .cursor",
    installScopeGlobal:
      "ホームのみ — 選択ツール別 ~/.*/skills（Claude 専用ではない）",
    installScopeBoth: "両方（推奨）— リポ→ホーム",
    installScopeProjectLabel: "リポのみ",
    installScopeGlobalLabel: "ホームのみ",
    installScopeBothLabel: "両方（推奨）",
    installScopeProjectDesc:
      "このリポのツール設定のみ同期。ホーム skills は触らない。",
    installScopeGlobalDesc:
      "次に選ぶツール向けに skills + meta-theory。リポは更新しない。",
    installScopeBothDesc: "リポのあとホーム。",
    depCheckHeading: "依存関係チェック",
    depOk: (n) => `${n} — OK`,
    depMissing: (n) => `${n} — 見つかりません`,
    depNoFiles: (n) => `${n} — ディレクトリはありますが.mdファイルがありません`,
    selectRuntimeTargets: "このパソコンで使うAIコーディングツールを選択",
    selectSkillDependencies:
      "グローバル ~/.*/skills/ に入れるサードパーティスキルリポジトリを選んでください",
    inputTargetsHint: (d) =>
      `番号を入力、カンマで複数選択；Enterでデフォルト ${d}`,
    inputSkillIdsHint: (d) =>
      `番号を入力、カンマで複数選択；Enterでデフォルト ${d}`,
    warnUnknownSkillId: (id) => `不明なスキル ID（無視）: ${id}`,
    depSummaryAll: "9つの依存関係すべて検証済み",
    depSummarySome: (ok, total) =>
      `${ok}/${total} の依存関係のみ検証 — --update で再インストールしてください`,
    syncHeading: "同期状態チェック",
    syncClaudeAgents: (n) => `Claude Code エージェント: ${n}/8 .md ファイル`,
    syncClaudeSkills: "Claude Code スキル/meta-theory/SKILL.md",
    syncClaudeHooks: (n) => `Claude Code フック: ${n} スクリプト`,
    syncClaudeSettings: "Claude Code .claude/settings.json",
    syncClaudeMcp: "Claude Code .mcp.json",
    syncCodexAgents: (n) => `Codex エージェント: ${n}/8 .toml ファイル`,
    syncCodexSkills: "Codex スキル/meta-theory/SKILL.md",
    syncOpenclawWorkspaces: (n) =>
      `OpenClaw ワークスペース: ${n}/8 エージェント — 各フォルダに必須の .md 9 件（BOOT、SOUL など）`,
    syncOpenclawSkill: "OpenClaw 共有 meta-theory",
    syncSharedSkills: "共有スキル/meta-theory/SKILL.md",
    syncCursorAgents: (n) => `Cursor エージェント: ${n}/8 .md ファイル`,
    syncCursorSkills: "Cursor スキル/meta-theory/SKILL.md",
    syncCursorMcp: "Cursor .cursor/mcp.json",
    syncOk: "すべての同期ターゲット検証済み",
    syncMissing: (p) => `不足：${p}`,
    syncPartial: (label, got, need) => `${label}：実際 ${got}、必要 ${need}`,
    stepPythonTools: "オプション Python ツール",
    pythonNotFound: "Python 3.10+ が見つかりません — graphify をスキップ",
    pythonHint:
      "Python 3.10+ をインストール後：pip install graphifyy && python -m graphify claude install",
    pythonNotFoundOfferInstall:
      "Python 3.10+ が見つかりません。自動ダウンロード・インストールしますか？",
    pythonInstalling: "Python 3.10+ をダウンロード・インストール中...",
    pythonInstallSuccess: "Python 3.10+ のインストールに成功しました",
    pythonInstallFailed: (err) =>
      `Python のインストールに失敗しました：${err} — https://www.python.org/downloads/ から手動でインストールしてください`,
    pythonInstallNotSupported: (platform) =>
      `${platform} では自動インストールがサポートされていません。https://www.python.org/downloads/ から手動でインストールしてください`,
    pythonInstallWinget: "winget で Python をインストール中...",
    pythonInstallWingetHint:
      "winget で Python をダウンロード・インストール中 — 数分かかる場合があります、お待ちください...",
    pythonInstallScoop: "scoop で Python をインストール中...",
    graphifyCheck: (v) => `graphify ${v}`,
    graphifyInstalling: "graphify をインストール中（コードナレッジグラフ）...",
    graphifyInstalled: "graphify インストール完了、Claude スキル登録済み",
    graphifyUpgrading: "graphify を最新バージョンにアップグレード中...",
    graphifyUpgraded: (v) => `graphify を ${v} にアップグレードしました`,
    graphifyUpgradeFailed: `graphify アップグレード失敗（非ブロッキング）`,
    graphifyInstallFailed: `
✗ graphify インストール失敗（非ブロッキング）

考えられる原因：
1. Python が見つかりません → Python 3.10+ がインストールされ PATH に含まれていることを確認
2. pip エラー → 実行：pip install graphifyy で詳細を確認
3. ネットワークエラー → ネットワーク/プロキシ接続を確認

修正：pip install graphifyy && python -m graphify claude install
`,
    graphifyAlreadyInstalled: (v) => `graphify ${v} — インストール済み`,
    graphifySkillRegistering: (p) => `graphify ${p} スキルを登録中...`,
    graphifySkillRegistered: (p) => `graphify ${p} スキル登録済み`,
    graphifySkillFailed: (p) =>
      `graphify ${p} スキル登録失敗（非ブロッキング）`,
    networkxCheck: (v) => `networkx ${v}`,
    networkxUpgrading: "graphify互換のためnetworkxを>=3.4にアップグレード中...",
    networkxUpgraded: (v) => `networkxを${v}にアップグレードしました`,
    networkxUpgradeFailed:
      "networkxのアップグレードに失敗（グラフ生成が正しく動作しない可能性）",
    networkxAlreadyOk: (v) => `networkx ${v} — 互換性あり`,
    graphifyHookInstalling:
      "git hookをインストール中（commit/checkout時にグラフ自動再構築）...",
    graphifyHookInstalled:
      "graphify git hookインストール完了（commit/checkout時に自動再構築）",
    graphifyHookFailed: "graphify git hookインストール失敗（非ブロッキング）",
    stepMcpMemory: "MCP Memory Service（第三層）",
    mcpMemoryInstalling: "MCP Memory Service（第三層）をインストール中...",
    mcpMemoryInstalled: "MCP Memory Service がインストールされました",
    mcpMemoryInstallFailed:
      "MCP Memory Service インストール失敗（非ブロッキング）",
    mcpMemoryAlreadyInstalled: (v) =>
      `MCP Memory Service ${v} — すでにインストール済み`,
    mcpMemoryStopping: "アップグレード前に MCP Memory Service を停止中...",
    mcpMemoryStopped: "MCP Memory Service を停止しました",
    mcpMemoryUpgrading:
      "MCP Memory Service を最新バージョンにアップグレード中...",
    mcpMemoryUpgraded: (v) =>
      `MCP Memory Service を ${v} にアップグレードしました`,
    mcpMemoryUpgradeFailed:
      "MCP Memory Service アップグレード失敗（非ブロッキング）",
    mcpMemoryServerRegistered:
      "MCP Memory Service が .mcp.json に登録されました",
    mcpMemoryServerExists:
      ".mcp.json にはすでに MCP Memory Service がありません",
    askMcpMemoryInstall:
      "MCP Memory Service（第三層）をインストールしますか？sqlite-vec によるベクトル級セッション記憶を提供します。",
    mcpMemorySkipped: "MCP Memory Service をスキップしました",
    mcpMemoryServerStartHint:
      "MCP Memory Service がインストールされました——起動方法：python -m mcp_memory_service  （または：uv run memory server -s hybrid）",
    mcpMemoryHookInstalling:
      "メモリサービス用の Claude Code SessionStart フックをインストール中...",
    mcpMemoryHookInstalled: "SessionStart フックをインストールしました",
    mcpMemoryHookWarnings:
      "フックのインストール中に警告が発生しました（非ブロッキング）——子プロセスの stderr を以下に表示します:",
    mcpMemoryAutoStarting:
      "MCP Memory Service（HTTP バックグラウンド）を起動中...",
    mcpMemoryAutoStarted:
      "MCP Memory Service が http://localhost:8000 で実行中",
    mcpMemoryAutoStartFailed: "自動起動に失敗——手動で起動してください：",
    mcpMemoryAutoStartManual: "  memory server --http",
    mcpMemoryAutoStartBoot: "起動時自動開始を設定しました",
    updateHeading: "アップデートモード",
    updateNpm: "npm依存関係を再インストール中...",
    updateSkills: "すべてのスキルを更新中...",
    updateSyncProjectFiles: "canonical/ からリポ内のツール設定を同期中...",
    updateSyncDone: "同期が完了しました",
    updateSyncProjectSkipped:
      "プロジェクト同期をスキップ（グローバル更新モード）",
    updateSyncSkip: "同期をスキップしたか失敗しました",
    updateReGlobal: "グローバルスキルディレクトリを再選択しますか？",
    askReselectRuntimes:
      "このパソコンで使うAIコーディングツールを再選択しますか？",
    askPythonToolsUpdate:
      "Python graphify（コードナレッジグラフ）をインストールしますか？",
    pythonToolsSkipped: "Python ツールをスキップしました",
    askGlobalSkillsUpdate: "グローバルスキルを更新しますか？（オプション）",
    updateSkillsDone: "グローバルスキルが更新されました",
    globalSkillsSkipped: "グローバルスキルをスキップしました",
    askMetaTheoryUpdate:
      "meta-theory をグローバルディレクトリに同期しますか？（オプション）",
    updateMetaTheoryDone: "meta-theory がグローバルに同期されました",
    metaTheorySkipped: "meta-theory 同期をスキップしました",
    updateComplete: "アップデート完了！",
    // インストール概要文字列
    installOverviewTitle: "Meta_Kim インストール概要",
    installOverviewWill: "このプロセスでは：",
    installOverviewSyncConfig:
      "プロジェクトディレクトリに設定を同期 (canonical → .claude/.codex/openclaw/.cursor/)",
    installOverviewInstallSkills:
      "選択したグローバルスキルリポジトリをインストール (~/.claude/skills/)",
    installOverviewSyncMeta: "meta-theory をグローバルディレクトリに同期",
    installOverviewOptionalPython: "Python graphify ツールをインストール",
    installOverviewTargets: "対象ツール：",
    installOverviewSkillList: "スキルリポジトリ：",
    installOverviewNoSkills: "（未選択）",
    installOverviewScope: "インストール範囲：",
    installOverviewEstimated: "予想時間：",
    installOverviewTime: "2-5分（ネットワーク速度によります）",
    // 進捗ステップ文字列
    progressPrepareDir: "グローバルスキルディレクトリを準備",
    progressNpmInstall: "npm依存関係をインストール",
    progressSyncConfig: "設定を同期",
    progressCleanupLegacy: "レガシースキルファイルをクリーンアップ",
    progressInstallSkills:
      "グローバルスキルをインストール（数分かかる場合があります）",
    progressSyncMeta: "meta-theory を同期",
    progressValidate: "インストールを検証",
    // 確認文字列
    confirmStartInstall: "インストールを開始しますか？",
    footprintTitle: "インストール足跡（前回の記録）",
    footprintFirstInstall:
      "このマシンでの初回インストール — 前回の足跡はありません。",
    footprintRefreshNote: "インストール実行時に上記エントリは更新されます。",
    footprintScopeGlobal: "グローバル",
    footprintScopeProject: "プロジェクト",
    footprintEntries: "件",
    footprintCategoryLabels: {
      A: "グローバルランタイムスキル",
      B: "グローバルランタイムフック",
      C: "グローバル settings.json マージ",
      D: "プロジェクトランタイムスキル",
      E: "プロジェクトランタイムフック",
      F: "プロジェクトランタイムエージェント",
      G: "プロジェクト settings + MCP 設定",
      H: "プロジェクトローカル状態 (.meta-kim/)",
      I: "共有依存関係 (pip / git フック)",
    },
    installCancelled: "インストールがキャンセルされました",
    installComplete: "インストール完了！",
    // 警告メッセージ
    warnConfigSyncFailed: `
⚠ 設定同期失敗、続行します...

考えられる原因：
1. ファイルがロックされています → ターゲットディレクトリで IDE/エクスプローラーを閉じる
2. 権限が拒否されました → 管理者として実行
3. Git 競合 → canonical/ の競合を解決してから再試行

修正：node scripts/sync-runtimes.mjs --scope both
`,
    warnSkillsInstallFailed: `
⚠ グローバルスキルインストール失敗

考えられる原因：
1. ディレクトリがロックされています（EBUSY）→ エクスプローラー/IDE を閉じ、ウイルス対策/インデックス完了を待ってから再試行
2. ネットワークエラー → node setup.mjs --prompt-proxy でプロキシ設定を確認
3. リポジトリが見つかりません → スキルリポジトリの URL が正しいか確認

修正：node setup.mjs --update
ヒント：EBUSY の場合、スキルフォルダを使用しているプログラムを閉じてから、*.staged-* の一時ディレクトリを手動で削除してください。
`,
    warnMetaTheorySyncFailed: `
⚠ meta-theory 同期失敗

考えられる原因：
1. ディレクトリがロックされています → ~/.claude/skills/ を使用しているプログラムを閉じる
2. 権限が拒否されました → グローバルスキルディレクトリの書き込み権限を確認
3. ネットワークエラー → プロキシ設定を確認

修正：node scripts/sync-global-meta-theory.mjs --targets claude
`,
    warnSkillsUpdateFailed: `
⚠ グローバルスキル更新失敗

考えられる原因：
1. ディレクトリがロックされています（EBUSY）→ エクスプローラー/IDE を閉じ、ウイルス対策/インデックス完了を待ってから再試行
2. Git fetch に失敗しました → ネットワーク/プロキシ接続を確認
3. 競合 → ステージされたファイルを確認し、手動で解決

ヒント：EBUSY の場合、スキルフォルダを使用しているプログラムを閉じてから、*.staged-* の一時ディレクトリを手動で削除してください。
修正：node setup.mjs --update
`,
    warnSkillsUpdateFailedHint:
      "ログに EBUSY 等がある場合: スキルフォルダを開いているエクスプローラー/IDE を閉じ、ウイルス対策/インデックス完了を待って再実行。*.staged-* は解放後に手動削除可。",
    warnMetaTheoryUpdateFailed: `
⚠ meta-theory 同期失敗

考えられる原因：
1. ディレクトリがロックされています → ~/.claude/skills/ を使用しているプログラムを閉じる
2. 権限が拒否されました → グローバルスキルディレクトリの書き込み権限を確認
3. ネットワークエラー → プロキシ設定を確認

修正：node scripts/sync-global-meta-theory.mjs --targets claude
`,
    warnManifestLoadFail: (msg) => `スキルマニフェストの読み込みに失敗：${msg}`,
    labelOptional: "（オプション）",
    selectedScope: (name) => `選択済み：${name}`,
    npmVerOk: (v) => `npm v${v}`,
    activeRuntimesSavedCli: (list) => `--targets から対象ツールを保存：${list}`,
    savedActiveTargets: (list) => `対象ツールを保存：${list}`,
    okRepoSynced: "canonical/ からリポジトリプロジェクションを同期",
    failRepoSync:
      "リポジトリプロジェクション同期失敗 — リポ内の一部設定が古い可能性",
    pipErrorDetail: (err) => `  pip エラー：${err}`,
    modeInfoLine: (mode, plat, ver) =>
      `モード：${mode} | ${plat} | Node ${ver}`,
    stepLabel: (n, label) => `ステップ ${n}：${label}`,
    // Proxy
    proxyHeading: "ネットワーク / プロキシ",
    proxyDetectedPrompt: (port, url) =>
      `プロキシポート ${port}（${url}）を検出。使用しますか？`,
    proxySkip: "プロキシ未検出 — 直接接続",
    proxySkipDeclined: "プロキシ辞退 — 直接接続",
    proxySaved: (url) => `プロキシを保存：${url}`,
    stepLabel: (n, label) => `ステップ ${n}：${label}`,
    progressInstallPython: "Python graphify ツールをインストール",
    progressInstallMcpMemory: "MCP Memory Service（第三層）をインストール",
    checkTargets: (active, supported) =>
      `activeTargets=${active} supportedTargets=${supported}`,
    localStateHeader: "ローカル状態",
    localStateProfile: (profile, key) => `profile=${profile} key=${key}`,
    localStateRunIndex: (path) => `ランインデックス：${path}`,
    localStateCompaction: (path) => `コンパクション：${path}`,
    localStateDispatch:
      "ディスパッチエンベロープ：config/contracts/workflow-contract.json -> protocols.dispatchEnvelopePacket",
    localStateMigration:
      "マイグレーションヘルパー：npm run migrate:meta-kim -- <source-dir> --apply",
    actionPrompt: "何をしますか？",
    actionInstall: "インストール — 初回セットアップ",
    actionInstallQuick:
      "クイックセットアップ — プラットフォームを選んですぐ使う",
    actionUpdate: "アップデート — スキル更新＆設定同期",
    actionCheck: "チェック — 依存関係と同期状態を確認",
    actionExit: "終了",

    npxQuickHeading: "クイックセットアップ",
    npxQuickPlatformPrompt: "どのプラットフォームを使いますか？",
    npxQuickPlatformClaude: "Claude Code",
    npxQuickPlatformOpenclaw: "OpenClaw",
    npxQuickPlatformCodex: "Codex CLI",
    npxQuickPlatformCursor: "Cursor",
    npxQuickPlatformAll: "すべてのプラットフォーム",
    npxQuickDirPrompt: "プロジェクトをどこに作成しますか？",
    npxQuickDirDefault: "~/Desktop/Meta_Kim",
    npxQuickCreating: "プロジェクトを作成中：",
    npxQuickCopyFiles: "プラットフォームファイルをコピー中",
    npxQuickDirExists: "ディレクトリが既に存在します — ファイルを更新します",
    npxQuickDone: "プロジェクトの準備完了！",
    npxQuickOpenIn: "このディレクトリでプラットフォームを開く：",
    npxQuickAskDeploy:
      "ランタイムファイルを指定ディレクトリにデプロイしますか？（例：デスクトップ）",
    npxQuickDeployYes: "はい、指定ディレクトリにデプロイ",
    npxQuickDeployNo: "スキップ",
    aboutAuthor: "作者について",
    contactWebsite: "ウェブサイト",
    contactGithub: "GitHub",
    contactFeishu: "Feishu Wiki",
    contactWechat: "WeChat公式アカウント",
  },
  "ko-KR": {
    modeCheck: "확인만",
    modeUpdate: "업데이트",
    modeSilent: "자동",
    modeInteractive: "대화형",
    preflightHeading: "환경 확인",
    nodeOld: (v) =>
      `Node.js v${v} 버전이 너무 낮습니다. >=${MIN_NODE_VERSION} 필요`,
    nodeOk: (v) => `Node.js v${v}`,
    npmNotFound: "npm을 찾을 수 없습니다",
    gitNotFound: "git을 찾을 수 없습니다 — 스킬 설치에 필요합니다",
    proxyInfo: (p) => `프록시: ${p}`,
    pkgFound: "package.json 찾음",
    pkgNotFound:
      "package.json을 찾을 수 없습니다 — Meta_Kim 루트에서 실행하세요",
    envFailed: "환경 확인 실패. 위 문제를 먼저 해결하세요.",
    envOk: "환경 확인 통과!",
    stepRuntime: "AI 코딩 도구 감지",
    claudeDetected: (v) => `Claude Code ${v}`,
    claudeNotDetected: "Claude Code CLI 감지되지 않음",
    codexDetected: (v) => `Codex ${v}`,
    codexNotDetected: "Codex CLI 감지되지 않음 (선택)",
    openclawDetected: (v) => `OpenClaw ${v}`,
    openclawNotDetected: "OpenClaw CLI 감지되지 않음 (선택)",
    cursorDetected: (v) => `Cursor ${v}`,
    cursorNotDetected: "Cursor CLI 감지되지 않음 (선택)",
    noRuntime: "AI 코딩 도구가 감지되지 않았습니다.",
    noRuntimeHint1:
      "Meta_Kim은 Claude Code, Codex, OpenClaw 또는 Cursor에서 작동합니다.",
    noRuntimeHint2: "최소 하나를 설치하세요: {claudeCodeDocs}",
    continueAnyway: "설정을 계속 진행할까요?",
    setupCancelled:
      "설정이 취소되었습니다. AI 코딩 도구를 설치하고 다시 실행하세요.",
    stepConfig: "프로젝트 설정",
    mcpExists: ".mcp.json이 이미 구성되어 있습니다",
    mcpCreated: ".mcp.json 생성됨 — MCP 서비스 등록됨",
    settingsExists: ".claude/settings.json이 이미 구성되어 있습니다",
    askCreateSettings: "hooks가 포함된 .claude/settings.json을 생성할까요?",
    settingsCreated: ".claude/settings.json 생성됨 — hooks + 권한 등록 완료",
    settingsSkipped: ".claude/settings.json 건너뜀 (사용자 선택)",
    settingsSkippedNoClaude:
      ".claude/settings.json 건너뜀 (Claude Code 미감지)",
    stepSkills: "스킬 설치",
    shipsSkills: (n) => `Meta_Kim에는 ${n}개의 스킬이 포함되어 있습니다:`,
    runningNpm: "npm install 실행 중...",
    npmDone: "npm 의존성 설치 완료",
    npmFailed: `
✗ npm install 실패

가능한 원인：
1. 네트워크 오류 → 인터넷 연결 및 프록시 설정 확인
2. Node 버전 불일치 → Node ${MIN_NODE_VERSION}+ 가 설치되어 있는지 확인
3. 권한 문제 → 실행：npm install --no-optional

수정：수동으로 실행하여 세부 정보 확인：npm install
`,
    nodeModulesExist: "node_modules가 존재합니다 (--update로 재설치)",
    skillUpdated: (n) => `${n} — 업데이트됨`,
    skillInstalled: (n) => `${n} — 설치됨`,
    skillExists: (n) => `${n} — 이미 설치됨`,
    skillSubdirInstalled: (n, s) => `${n} — 설치됨 (하위디렉토리: ${s})`,
    skillFailed: (n, r) => `
✗ 스킬 설치 실패：${n}

가능한 원인：
1. 네트워크 타임아웃 → 실행：npm run meta:sync -- --skills
2. 권한 거부 → sudo/관리자 권한으로 실행
3. 리포지토리를 찾을 수 없음 → 스킬 리포지토리 URL 확인

${r ? `원본 오류：${r}` : ""}
`,
    skillUpdateFailed: (n) =>
      `${n} — 업데이트 건너뜀（非 fast-forward, 기존 버전 유지）`,
    skillSubdirNotFound: (n) => `${n} — 하위디렉토리를 찾을 수 없음`,
    skillsReady: (ok, total, fail) =>
      `${ok}/${total} 스킬 준비 완료${fail > 0 ? `, ${fail} 실패` : ""}`,
    stepValidate: "프로젝트 검증",
    agentPrompts: (n) => `${n}개의 메타 에이전트 프롬프트`,
    validationPassed: "프로젝트 검증 통과",
    validationWarnings: "검증에 경고가 있습니다 (기능에 영향 없음)",
    setupComplete: "설정 완료!",
    whatMetaDoes: "Meta_Kim이란:",
    whatMetaDoesDesc1: "AI 코딩 에이전트에 전문가 팀을 제공합니다:",
    whatMetaDoesDesc2: "코드 리뷰, 보안, 메모리 관리 등을",
    whatMetaDoesDesc3: "자동으로 조정합니다.",
    howToUse: "사용 방법:",
    step1Open: "이 디렉토리에서 Claude Code 열기:",
    step2Try: "meta-theory 명령 시도:",
    step3Or: "또는 Claude에게 복잡한 작업 요청:",
    step3Hint: "(Meta_Kim이 자동으로 전문가를 조정합니다)",
    codexNote: "Codex 프롬프트는 .codex/에 동기화됩니다",
    openclawNote: "OpenClaw 워크스페이스는 openclaw/에 동기화됩니다",
    cursorNote: "Cursor 에이전트는 .cursor/에 동기화됩니다",
    noRuntimeGetStarted:
      "AI 코딩 도구가 감지되지 않았습니다. Claude Code를 설치하세요:",
    usefulCommands: "유용한 명령:",
    cmdUpdate: "모든 스킬 업데이트",
    cmdCheck: "환경 확인",
    cmdDoctor: "Meta_Kim 상태 진단",
    cmdVerify: "전체 검증",
    // 설치 후 주의사항
    postInstallNotesHeading: "설치 후 주의사항:",
    postInstallNotesIntro: "설치 완료 후 각 층의 사용 방식은 다음과 같습니다:",
    postInstallNotesPlatformSync: "각 플랫폼 동기화 현황:",
    platformClauleCode: "Claude Code",
    platformClauleCodeCap: "agents + skills + hooks",
    platformCodex: "Codex",
    platformCodexCap: "agents + skills",
    platformOpenClaw: "OpenClaw",
    platformOpenClawCap: "workspace + skills",
    platformCursor: "Cursor",
    platformCursorCap: "agents + skills",
    postInstallNotesLayerActivation: "3층 메모리 활성화 방식:",
    layer1Label: "제1층 (Memory)",
    layer1Note: "자동 활성화 — Claude Code에 내장됨",
    layer2Label: "제2층 (Graphify)",
    layer2Note: "graphifyy 설치 후 자동 활성화 (pip install graphifyy)",
    layer3Label: "제3층 (SQL / MCP Memory Service)",
    layer3Note:
      "서버 수동 시작 필요: python -m mcp_memory_service (그러면 http://localhost:8000 에 접속)",
    installLocationsHeading: "설치 위치:",
    installLocationsProject: "프로젝트 레벨 (현재 디렉터리)",
    installLocationsGlobal: "전역 레벨 (프로젝트 간 공유)",
    installLocationsManifest: "설치 매니페스트 (안전하게 제거 가능)",
    usefulCommandsHeading: "다음에 자주 사용하는 명령:",
    cmdWhereStatus: "모든 산출물 위치 확인",
    cmdWhereStatusDiff: "이전 설치와 비교",
    cmdWhereUninstall: "안전하게 제거",
    postInstallNotesReminder: "참고:",
    postInstallNotesReminderText:
      "node setup.mjs --check로 언제든지 설치 상태를 확인할 수 있습니다.",
    setupError: "설정 오류:",
    setupInterrupted:
      "중단됨(Ctrl+C). 설치가 끝나지 않았습니다. 다시 실행: node setup.mjs",
    selectLang: "Select language / 选择语言 / 言語を選択 / 언어 선택",
    choose: (n) => `선택 (1-${n})`,
    inquirerSingleHotkeys: "↑↓ 이동 · ⏎ 확인",
    inquirerMultiHotkeys:
      "↑↓ 이동 · Space 선택 토글 · ⏎ 확인 · a 전체 · i 반전",
    globalInstallPrompt:
      "Meta_Kim 스킬을 ~/.claude/skills/ (전역)에 설치합니다. 전역 설치할까요?",
    globalDirReady: (p) => `전역 스킬 디렉토리 준비됨: ${p}`,
    globalDirCreated: (p) => `전역 스킬 디렉토리 생성됨: ${p}`,
    globalDirCreateFailed: (e) => `전역 스킬 디렉토리 생성 실패：${e}`,
    globalDirTitle: "전역 스킬 디렉토리",
    globalDirPrompt: `Meta_Kim 스킬은 ~/.claude/skills/ 에 설치됩니다
• 전역 설치 — 모든 프로젝트에서 공유
• 건너뛰기 — 이 프로젝트에서만 사용
• 언제든 setup.mjs 를 다시 실행하여 설치`,
    globalSkipped: "전역 설치 건너뜀 — 프로젝트 로컬만 사용",
    // 설치 범위 선택
    installScopeHeading: "설치 범위",
    installScopePrompt: "리포만 / 홈 skills만 / 둘 다?",
    installScopeProject: "리포만 — .claude / .codex / openclaw / .cursor",
    installScopeGlobal: "홈만 — 선택 도구별 ~/.*/skills (Claude 전용 아님)",
    installScopeBoth: "둘 다 (권장) — 리포→홈",
    installScopeProjectLabel: "리포만",
    installScopeGlobalLabel: "홈만",
    installScopeBothLabel: "둘 다 (권장)",
    installScopeProjectDesc: "이 리포 도구 설정만. 홈 skills는 안 함.",
    installScopeGlobalDesc:
      "다음에 고른 도구용 skills + meta-theory. 리포는 안 건드림.",
    installScopeBothDesc: "리포 후 홈 순서.",
    depCheckHeading: "의존성 확인",
    depOk: (n) => `${n} — 정상`,
    depMissing: (n) => `${n} — 누락`,
    depNoFiles: (n) => `${n} — 디렉토리는 있으나 .md 파일 없음`,
    selectRuntimeTargets: "이 컴퓨터에서 사용할 AI 코딩 도구 선택",
    selectSkillDependencies:
      "전역 ~/.*/skills/에 설치할 서드파티 스킬 저장소를 선택하세요",
    inputTargetsHint: (d) => `번호 입력, 쉼표로 다중 선택；Enter로 기본값 ${d}`,
    inputSkillIdsHint: (d) =>
      `번호 입력, 쉼표로 다중 선택；Enter로 기본값 ${d}`,
    warnUnknownSkillId: (id) => `알 수 없는 스킬 id(무시): ${id}`,
    depSummaryAll: "9개 의존성 모두 확인 완료",
    depSummarySome: (ok, total) =>
      `${ok}/${total}개 의존성만 확인 — --update로 재설치하세요`,
    syncHeading: "동기화 상태 확인",
    syncClaudeAgents: (n) => `Claude Code 에이전트: ${n}/8 .md 파일`,
    syncClaudeSkills: "Claude Code 스킬/meta-theory/SKILL.md",
    syncClaudeHooks: (n) => `Claude Code 훅: ${n} 스크립트`,
    syncClaudeSettings: "Claude Code .claude/settings.json",
    syncClaudeMcp: "Claude Code .mcp.json",
    syncCodexAgents: (n) => `Codex 에이전트: ${n}/8 .toml 파일`,
    syncCodexSkills: "Codex 스킬/meta-theory/SKILL.md",
    syncOpenclawWorkspaces: (n) =>
      `OpenClaw 워크스페이스: ${n}/8 에이전트 — 각 폴더에 필수 .md 9개(BOOT, SOUL 등)`,
    syncOpenclawSkill: "OpenClaw 공유 meta-theory",
    syncSharedSkills: "공유 스킬/meta-theory/SKILL.md",
    syncCursorAgents: (n) => `Cursor 에이전트: ${n}/8 .md 파일`,
    syncCursorSkills: "Cursor 스킬/meta-theory/SKILL.md",
    syncCursorMcp: "Cursor .cursor/mcp.json",
    syncOk: "모든 동기화 대상 확인 완료",
    syncMissing: (p) => `누락: ${p}`,
    syncPartial: (label, got, need) => `${label}: 실제 ${got}, 필요 ${need}`,
    stepPythonTools: "선택적 Python 도구",
    pythonNotFound: "Python 3.10+ 없음 — graphify 건너뜀",
    pythonHint:
      "Python 3.10+ 설치 후: pip install graphifyy && python -m graphify claude install",
    pythonNotFoundOfferInstall:
      "Python 3.10+ 없음. 자동 다운로드 및 설치할까요?",
    pythonInstalling: "Python 3.10+ 다운로드 및 설치 중...",
    pythonInstallSuccess: "Python 3.10+ 설치 성공",
    pythonInstallFailed: (err) =>
      `Python 설치 실패: ${err} — https://www.python.org/downloads/ 에서 수동 설치 가능`,
    pythonInstallNotSupported: (platform) =>
      `${platform}은(는) 자동 설치를 지원하지 않습니다. https://www.python.org/downloads/ 에서 수동 설치하세요`,
    pythonInstallWinget: "winget으로 Python 설치 중...",
    pythonInstallWingetHint:
      "winget이 Python을 다운로드 및 설치 중입니다 — 몇 분 정도 걸릴 수 있습니다, 잠시만 기다려 주세요...",
    pythonInstallScoop: "scoop으로 Python 설치 중...",
    graphifyCheck: (v) => `graphify ${v}`,
    graphifyInstalling: "graphify 설치 중 (코드 지식 그래프)...",
    graphifyInstalled: "graphify 설치 완료, Claude 스킬 등록됨",
    graphifyUpgrading: "graphify을(를) 최신 버전으로 업그레이드 중...",
    graphifyUpgraded: (v) => `graphify이(가) ${v}(으)로 업그레이드되었습니다`,
    graphifyUpgradeFailed: `graphify 업그레이드 실패 (비차단)`,
    graphifyInstallFailed: `
✗ graphify 설치 실패 (비차단)

가능한 원인：
1. Python을 찾을 수 없음 → Python 3.10+ 가 설치되어 있고 PATH에 있는지 확인
2. pip 오류 → 실행：pip install graphifyy 로 세부 정보 확인
3. 네트워크 오류 → 네트워크/프록시 연결 확인

수정：pip install graphifyy && python -m graphify claude install
`,
    graphifyAlreadyInstalled: (v) => `graphify ${v} — 이미 설치됨`,
    graphifySkillRegistering: (p) => `graphify ${p} 스킬 등록 중...`,
    graphifySkillRegistered: (p) => `graphify ${p} 스킬 등록됨`,
    graphifySkillFailed: (p) => `graphify ${p} 스킬 등록 실패 (비차단)`,
    networkxCheck: (v) => `networkx ${v}`,
    networkxUpgrading:
      "graphify 호환성을 위해 networkx를 >=3.4로 업그레이드 중...",
    networkxUpgraded: (v) => `networkx ${v}(으)로 업그레이드 완료`,
    networkxUpgradeFailed:
      "networkx 업그레이드 실패 (그래프 생성이 올바르지 않을 수 있음)",
    networkxAlreadyOk: (v) => `networkx ${v} — 호환 가능`,
    graphifyHookInstalling:
      "git hook 설치 중 (commit/checkout 시 그래프 자동 재구축)...",
    graphifyHookInstalled:
      "graphify git hook 설치 완료 (commit/checkout 시 자동 재구축)",
    graphifyHookFailed: "graphify git hook 설치 실패 (비차단)",
    stepMcpMemory: "MCP Memory Service（3층）",
    mcpMemoryInstalling: "MCP Memory Service（3층） 설치 중...",
    mcpMemoryInstalled: "MCP Memory Service 설치 완료",
    mcpMemoryInstallFailed: "MCP Memory Service 설치 실패 (비차단)",
    mcpMemoryAlreadyInstalled: (v) => `MCP Memory Service ${v} — 이미 설치됨`,
    mcpMemoryStopping: "업그레이드 전 MCP Memory Service 중지 중...",
    mcpMemoryStopped: "MCP Memory Service 중지됨",
    mcpMemoryUpgrading:
      "MCP Memory Service을(를) 최신 버전으로 업그레이드 중...",
    mcpMemoryUpgraded: (v) =>
      `MCP Memory Service이(가) ${v}(으)로 업그레이드되었습니다`,
    mcpMemoryUpgradeFailed: "MCP Memory Service 업그레이드 실패 (비차단)",
    mcpMemoryServerRegistered: "MCP Memory Service 가 .mcp.json 에 등록됨",
    mcpMemoryServerExists: ".mcp.json 에 이미 MCP Memory Service 있음",
    askMcpMemoryInstall:
      "MCP Memory Service（3층）를 설치하시겠습니까? sqlite-vec 로 벡터 수준 세션 기억을 제공합니다.",
    mcpMemorySkipped: "MCP Memory Service 건너뜀",
    mcpMemoryServerStartHint:
      "MCP Memory Service 설치 완료——시작 방법: python -m mcp_memory_service  (또는: uv run memory server -s hybrid)",
    mcpMemoryHookInstalling:
      "메모리 서비스용 Claude Code SessionStart 훅 설치 중...",
    mcpMemoryHookInstalled: "SessionStart 훅 설치 완료",
    mcpMemoryHookWarnings:
      "훅 설치에서 경고가 발생했습니다 (비차단) — 하위 프로세스의 stderr 원문은 아래와 같습니다:",
    mcpMemoryAutoStarting: "MCP Memory Service (HTTP 백그라운드) 시작 중...",
    mcpMemoryAutoStarted:
      "MCP Memory Service가 http://localhost:8000에서 실행 중",
    mcpMemoryAutoStartFailed: "자동 시작 실패 — 수동으로 시작하세요:",
    mcpMemoryAutoStartManual: "  memory server --http",
    mcpMemoryAutoStartBoot: "부팅 시 자동 시작 구성 완료",
    updateHeading: "업데이트 모드",
    updateNpm: "npm 의존성 재설치 중...",
    updateSkills: "모든 스킬 업데이트 중...",
    updateSyncProjectFiles: "canonical/에서 리포 내 도구 설정 동기화 중...",
    updateSyncDone: "동기화 완료",
    updateSyncProjectSkipped: "프로젝트 동기화 건너뜀 (전역 업데이트 모드)",
    updateSyncSkip: "동기화를 건너뛰었거나 실패했습니다",
    updateReGlobal: "전역 스킬 디렉토리를 다시 선택할까요?",
    askReselectRuntimes: "이 컴퓨터에서 사용할 AI 코딩 도구를 다시 선택할까요?",
    askPythonToolsUpdate: "Python graphify (코드 지식 그래프)를 설치할까요?",
    pythonToolsSkipped: "Python 도구 건너뜀",
    askGlobalSkillsUpdate: "전역 스킬을 업데이트할까요? (선택)",
    updateSkillsDone: "전역 스킬 업데이트 완료",
    globalSkillsSkipped: "전역 스킬 건너뜀",
    askMetaTheoryUpdate: "meta-theory를 전역 디렉토리에 동기화할까요? (선택)",
    updateMetaTheoryDone: "meta-theory가 전역에 동기화됨",
    metaTheorySkipped: "meta-theory 동기화 건너뜀",
    updateComplete: "업데이트 완료!",
    // 설치 개요 문자열
    installOverviewTitle: "Meta_Kim 설치 개요",
    installOverviewWill: "이 과정에서:",
    installOverviewSyncConfig:
      "프로젝트 디렉토리에 설정 동기화 (canonical → .claude/.codex/openclaw/.cursor/)",
    installOverviewInstallSkills:
      "선택한 전역 스킬 리포지토리 설치 (~/.claude/skills/)",
    installOverviewSyncMeta: "meta-theory를 전역 디렉토리에 동기화",
    installOverviewOptionalPython: "Python graphify 도구 설치",
    installOverviewTargets: "대상 도구:",
    installOverviewSkillList: "스킬 저장소:",
    installOverviewNoSkills: "(선택 없음)",
    installOverviewScope: "설치 범위:",
    installOverviewEstimated: "예상 시간:",
    installOverviewTime: "2-5분(네트워크 속도에 따라 다름)",
    // 진행 단계 문자열
    progressPrepareDir: "전역 스킬 디렉토리 준비",
    progressNpmInstall: "npm 의존성 설치",
    progressSyncConfig: "설정 동기화",
    progressCleanupLegacy: "레거시 스킬 파일 정리",
    progressInstallSkills: "전역 스킬 설치(몇 분 소요될 수 있음)",
    progressSyncMeta: "meta-theory 동기화",
    progressValidate: "설치 검증",
    // 확인 문자열
    confirmStartInstall: "설치를 시작할까요?",
    footprintTitle: "설치 발자국 (이전 설치 기록)",
    footprintFirstInstall: "이 머신에서 첫 설치 — 이전 발자국이 없습니다.",
    footprintRefreshNote: "설치 실행 시 위 항목들이 갱신됩니다.",
    footprintScopeGlobal: "전역",
    footprintScopeProject: "프로젝트",
    footprintEntries: "항목",
    footprintCategoryLabels: {
      A: "전역 런타임 스킬",
      B: "전역 런타임 훅",
      C: "전역 settings.json 병합",
      D: "프로젝트 런타임 스킬",
      E: "프로젝트 런타임 훅",
      F: "프로젝트 런타임 에이전트",
      G: "프로젝트 settings + MCP 설정",
      H: "프로젝트 로컬 상태 (.meta-kim/)",
      I: "공유 의존성 (pip / git 훅)",
    },
    installCancelled: "설치가 취소되었습니다",
    installComplete: "설치 완료!",
    // 경고 메시지
    warnConfigSyncFailed: `
⚠ 구성 동기화 실패, 계속 진행...

가능한 원인：
1. 파일이 잠겨 있습니다 → 대상 디렉토리의 IDE/탐색기를 닫으세요
2. 권한 거부 → 관리자로 실행
3. Git 충돌 → canonical/ 의 충돌을 해결한 후 재시도

수정：node scripts/sync-runtimes.mjs --scope both
`,
    warnSkillsInstallFailed: `
⚠ 전역 스킬 설치 실패

가능한 원인：
1. 디렉토리가 잠겨 있습니다（EBUSY）→ 탐색기/IDE를 닫고, 백신/인덱싱이 끝난 뒤 재시도
2. 네트워크 오류 → node setup.mjs --prompt-proxy 로 프록시 설정 확인
3. 리포지토리를 찾을 수 없음 → 스킬 리포지토리 URL이 올바른지 확인

수정：node setup.mjs --update
힌트：EBUSY인 경우 skills 폴더를 사용하는 프로그램을 닫은 후 *.staged-* 임시 폴더를 수동으로 삭제하세요.
`,
    warnMetaTheorySyncFailed: `
⚠ meta-theory 동기화 실패

가능한 원인：
1. 디렉토리가 잠겨 있습니다 → ~/.claude/skills/ 를 사용하는 프로그램 닫기
2. 권한 거부 → 전역 스킬 디렉토리의 쓰기 권한 확인
3. 네트워크 오류 → 프록시 설정 확인

수정：node scripts/sync-global-meta-theory.mjs --targets claude
`,
    warnSkillsUpdateFailed: `
⚠ 전역 스킬 업데이트 실패

가능한 원인：
1. 디렉토리가 잠겨 있습니다（EBUSY）→ 탐색기/IDE를 닫고, 백신/인덱싱이 끝난 뒤 재시도
2. Git fetch 실패 → 네트워크/프록시 연결 확인
3. 충돌 → 스테이지된 파일을 확인하고 수동으로 해결

힌트：EBUSY인 경우 skills 폴더를 사용하는 프로그램을 닫은 후 *.staged-* 임시 폴더를 수동으로 삭제하세요.
수정：node setup.mjs --update
`,
    warnSkillsUpdateFailedHint:
      "로그에 EBUSY 등이 있으면: 탐색기/IDE로 skills 폴더를 닫고, 후원/인덱싱이 끝난 뒤 재시도. 잠금 해제 후 *.staged-* 폴더는 수동 삭제 가능.",
    warnMetaTheoryUpdateFailed: `
⚠ meta-theory 동기화 실패

가능한 원인：
1. 디렉토리가 잠겨 있습니다 → ~/.claude/skills/ 를 사용하는 프로그램 닫기
2. 권한 거부 → 전역 스킬 디렉토리의 쓰기 권한 확인
3. 네트워크 오류 → 프록시 설정 확인

수정：node scripts/sync-global-meta-theory.mjs --targets claude
`,
    warnManifestLoadFail: (msg) => `스킬 매니페스트 로드 실패：${msg}`,
    labelOptional: "(선택)",
    selectedScope: (name) => `선택됨：${name}`,
    npmVerOk: (v) => `npm v${v}`,
    activeRuntimesSavedCli: (list) => `--targets에서 대상 도구 저장：${list}`,
    savedActiveTargets: (list) => `대상 도구 저장：${list}`,
    okRepoSynced: "canonical/에서 리포지토리 프로젝션 동기화됨",
    failRepoSync:
      "리포지토리 프로젝션 동기화 실패 — 리포 내 일부 설정이 오래되었을 수 있음",
    pipErrorDetail: (err) => `  pip 오류：${err}`,
    modeInfoLine: (mode, plat, ver) => `모드：${mode} | ${plat} | Node ${ver}`,
    stepLabel: (n, label) => `단계 ${n}：${label}`,
    // Proxy
    proxyHeading: "네트워크 / 프록시",
    proxyDetectedPrompt: (port, url) =>
      `프록시 포트 ${port}（${url}）감지됨. 사용하시겠습니까?`,
    proxySkip: "프록시 미감지 — 직접 연결",
    proxySkipDeclined: "프록시 거절됨 — 직접 연결",
    proxySaved: (url) => `프록시 저장됨: ${url}`,
    stepLabel: (n, label) => `단계 ${n}：${label}`,
    progressInstallPython: "Python graphify 도구 설치",
    progressInstallMcpMemory: "MCP Memory Service（3층） 설치",
    checkTargets: (active, supported) =>
      `activeTargets=${active} supportedTargets=${supported}`,
    localStateHeader: "로컬 상태",
    localStateProfile: (profile, key) => `profile=${profile} key=${key}`,
    localStateRunIndex: (path) => `런 인덱스：${path}`,
    localStateCompaction: (path) => `컴팩션：${path}`,
    localStateDispatch:
      "디스패치 엔벨로프：config/contracts/workflow-contract.json -> protocols.dispatchEnvelopePacket",
    localStateMigration:
      "마이그레이션 도우미：npm run migrate:meta-kim -- <source-dir> --apply",
    actionPrompt: "무엇을 하시겠습니까?",
    actionInstall: "설치 — 최초 전체 설정",
    actionInstallQuick: "빠른 설정 — 플랫폼 하나 선택, 바로 사용",
    actionUpdate: "업데이트 — 스킬 갱신 및 설정 동기화",
    actionCheck: "확인 — 의존성 및 동기화 상태 검증",
    actionExit: "종료",

    npxQuickHeading: "빠른 설정",
    npxQuickPlatformPrompt: "어떤 플랫폼을 사용하시나요?",
    npxQuickPlatformClaude: "Claude Code",
    npxQuickPlatformOpenclaw: "OpenClaw",
    npxQuickPlatformCodex: "Codex CLI",
    npxQuickPlatformCursor: "Cursor",
    npxQuickPlatformAll: "모든 플랫폼",
    npxQuickDirPrompt: "프로젝트를 어디에 만들까요?",
    npxQuickDirDefault: "~/Desktop/Meta_Kim",
    npxQuickCreating: "프로젝트 생성 중:",
    npxQuickCopyFiles: "플랫폼 파일 복사 중",
    npxQuickDirExists: "디렉터리가 이미 존재합니다 — 파일을 업데이트합니다",
    npxQuickDone: "프로젝트 준비 완료!",
    npxQuickOpenIn: "이 디렉터리에서 플랫폼 열기:",
    npxQuickAskDeploy:
      "런타임 파일을 지정 디렉터리에 배포할까요? (예: 바탕 화면)",
    npxQuickDeployYes: "네, 지정 디렉터리에 배포",
    npxQuickDeployNo: "건너뛰기",
    aboutAuthor: "작성자 소개",
    contactWebsite: "웹사이트",
    contactGithub: "GitHub",
    contactFeishu: "Feishu 위키",
    contactWechat: "WeChat 공식 계정",
  },
};

let t = I18N.en; // default, overwritten by selectLanguage()
let quickDeployDir = null; // set by npx quick deploy — target directory for the user

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

async function keyboardSelect(question, options) {
  if (!process.stdin.isTTY) {
    printSelectMenu(question, options, 0);
    const answer = await ask(t.choose(options.length));
    const idx = parseInt(answer, 10) - 1;
    return idx >= 0 && idx < options.length ? idx : 0;
  }

  const { select } = await import("@inquirer/prompts");

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
  if (!process.stdin.isTTY) {
    printMultiMenu(question, choices, 0, new Set(defaultIds));
    const answer = await ask(
      `${hintText(`${C.dim}${defaultIds.join(", ")}${C.reset}`)}`,
    );
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

  const { checkbox } = await import("@inquirer/prompts");

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
  const defaultIds = getDefaultSkillIds();
  const choices = SKILLS.map((s) => ({
    id: s.name,
    label: s.repo,
  }));
  return askMultiSelectSkillRepos(
    t.selectSkillDependencies,
    choices,
    defaultIds,
  );
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
function showInstallOverview(activeTargets, installScope, skillIds = []) {
  const bullets = [];
  if (installScope === "project") {
    bullets.push(t.installOverviewSyncConfig);
  } else if (installScope === "global") {
    bullets.push(t.installOverviewInstallSkills);
    bullets.push(t.installOverviewSyncMeta);
  } else {
    bullets.push(t.installOverviewSyncConfig);
    bullets.push(t.installOverviewInstallSkills);
    bullets.push(t.installOverviewSyncMeta);
  }

  // graphify is always optional — show as optional hint, not a bullet
  const scopeLabel =
    {
      project: t.installScopeProjectLabel,
      global: t.installScopeGlobalLabel,
      both: t.installScopeBothLabel,
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
  if (installScope === "global" || installScope === "both") {
    try {
      const m = readManifest(manifestPathFor("global"));
      if (m && m.entries?.length > 0)
        sources.push({ scope: "global", manifest: m });
    } catch {
      /* manifest read is best-effort */
    }
  }
  if (installScope === "project" || installScope === "both") {
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
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return resolve(raw);
}

function copyDirRecursive(src, dest) {
  if (!existsSync(src)) return 0;
  mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      count += copyDirRecursive(srcPath, destPath);
    } else {
      cpSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}

function deployPlatformFiles(platformId, targetDir) {
  let fileCount = 0;
  const copyIfExists = (srcRel, destRel) => {
    const src = join(PROJECT_DIR, srcRel);
    const dest = join(targetDir, destRel);
    if (!existsSync(src)) return;
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(src) && statSync(src).isDirectory()) {
      fileCount += copyDirRecursive(src, dest);
    } else {
      cpSync(src, dest);
      fileCount++;
    }
  };

  if (platformId === "claude" || platformId === "all") {
    copyIfExists(".claude", ".claude");
    if (existsSync(join(PROJECT_DIR, ".mcp.json")))
      copyIfExists(".mcp.json", ".mcp.json");
  }
  if (platformId === "openclaw" || platformId === "all") {
    copyIfExists("openclaw", "openclaw");
  }
  if (platformId === "codex" || platformId === "all") {
    copyIfExists(".codex", ".codex");
    copyIfExists(".agents", ".agents");
  }
  if (platformId === "cursor" || platformId === "all") {
    copyIfExists(".cursor", ".cursor");
  }
  return fileCount;
}

async function askDeployDirectory() {
  console.log("");

  const choiceIdx = await askSelect(t.npxQuickAskDeploy, [
    t.npxQuickDeployYes,
    t.npxQuickDeployNo,
  ]);
  if (choiceIdx !== 0) {
    console.log("");
    return null;
  }

  const targetDir = await askTargetDirectory();
  console.log("");
  return targetDir;
}

async function copyToDeployDir(activeTargets, targetDir) {
  if (existsSync(targetDir)) {
    console.log(`${C.dim}  ${t.npxQuickDirExists}${C.reset}`);
  } else {
    mkdirSync(targetDir, { recursive: true });
  }

  console.log(`${C.dim}  ${t.npxQuickCreating} ${targetDir}${C.reset}`);

  for (const platformId of activeTargets) {
    await withProgress(`  ${t.npxQuickCopyFiles} (${platformId})`, async () => {
      const count = deployPlatformFiles(platformId, targetDir);
      return count > 0;
    });
  }
  quickDeployDir = targetDir;

  console.log(`${C.green}${C.bold}✓ ${t.npxQuickDone}${C.reset}`);
  console.log(`${C.dim}  ${targetDir}${C.reset}`);
  console.log("");
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
    const result = spawnSync("npm", ["install"], {
      cwd: PROJECT_DIR,
      stdio: "inherit",
      shell: isWin,
    });
    return result.status === 0;
  });

  // Clean up legacy skill files before sync
  await withProgress(t.progressCleanupLegacy, () => {
    const n = cleanupLegacySkills("both");
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
    const count = deployPlatformFiles(platformId, targetDir);
    quickDeployDir = targetDir;
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
    const syncResult = runNodeScript("scripts/sync-global-meta-theory.mjs", [
      "--targets",
      targets,
    ]);
    return syncResult.status === 0;
  });

  console.log("");
  console.log(`${C.green}${C.bold}✓ ${t.npxQuickDone}${C.reset}`);
  console.log(`${C.dim}  ${targetDir}${C.reset}`);
  console.log("");

  showNextSteps(runtimes);
}

// ── Install scope selection ─────────────────────────────

/**
 * Ask user where to install: project-only, global-only, or both
 * Returns: 'project' | 'global' | 'both'
 */
async function askInstallScope() {
  if (silentMode || !promptInstallScope) return "both";

  heading(t.installScopeHeading);

  const scopes = [
    {
      id: "project",
      label: t.installScopeProjectLabel,
      desc: t.installScopeProjectDesc,
    },
    {
      id: "global",
      label: t.installScopeGlobalLabel,
      desc: t.installScopeGlobalDesc,
    },
    {
      id: "both",
      label: `${t.installScopeBothLabel}`,
      desc: t.installScopeBothDesc,
    },
  ];

  const idx = await keyboardSelect(
    t.installScopePrompt,
    scopes.map((s) => ({
      ...s,
      label: `${s.label}  ${C.dim}${s.desc}${C.reset}`,
    })),
  );

  const selected = scopes[idx]?.id || "both";
  const pickedLabel =
    {
      project: t.installScopeProjectLabel,
      global: t.installScopeGlobalLabel,
      both: t.installScopeBothLabel,
    }[selected] || selected;
  info(t.selectedScope(pickedLabel));
  return selected;
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

    // Canonical hooks: exact 8 files synced by sync-global-meta-theory.mjs
    const hooksDir = join(PROJECT_DIR, ".claude", "hooks");
    const missingHooks = CLAUDE_HOOK_FILES.filter(
      (h) => !existsSync(join(hooksDir, h)),
    );
    if (missingHooks.length === 0) {
      ok(t.syncClaudeHooks(CLAUDE_HOOK_FILES.length));
    } else {
      warn(
        t.syncMissing(`.claude/hooks/ — missing: ${missingHooks.join(", ")}`),
      );
      allOk = false;
    }

    if (existsSync(join(PROJECT_DIR, ".claude", "settings.json")))
      ok(t.syncClaudeSettings);
    else {
      warn(t.syncMissing(".claude/settings.json"));
      allOk = false;
    }

    if (existsSync(join(PROJECT_DIR, ".mcp.json"))) ok(t.syncClaudeMcp);
    else {
      warn(t.syncMissing(".mcp.json"));
      allOk = false;
    }
  }

  // --- Codex ---
  if (repoTargets.includes("codex")) {
    console.log("");
    const codexAgentsDir = join(PROJECT_DIR, ".codex", "agents");
    if (existsSync(codexAgentsDir)) {
      const summary = summarizeExpectedFiles(
        readdirSync(codexAgentsDir).filter((f) => f.endsWith(".toml")),
        expectedAgentProjectionFiles(".toml"),
      );
      if (summary.missing.length === 0)
        ok(t.syncCodexAgents(summary.presentCount));
      else {
        warn(
          t.syncPartial(
            "Codex agents",
            `${summary.presentCount}/${META_AGENTS.length}`,
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
      ".codex",
      "skills",
      "meta-theory",
      "SKILL.md",
    );
    if (existsSync(codexSkillPath)) ok(t.syncCodexSkills);
    else {
      fail(t.syncMissing(".codex/skills/meta-theory/SKILL.md"));
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
    if (existsSync(cursorMcp)) ok(t.syncCursorMcp);
    else {
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

  const detected = detectedTargetIds(runtimes);
  const suggestedTargets =
    localOverrides.activeTargets?.length > 0
      ? localOverrides.activeTargets
      : detected.length > 0
        ? detected
        : defaultTargets;

  const chosenTargets = await askMultiSelectTargets(
    t.selectRuntimeTargets,
    RUNTIME_CHOICES,
    suggestedTargets,
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

// ── Legacy skill file cleanup ────────────────────────────
// Precise removal of old single-file skill format that was replaced
// by directory format (meta-theory.md → meta-theory/SKILL.md).

const LEGACY_PROJECT_PATHS = [
  join(PROJECT_DIR, ".claude", "skills", "meta-theory.md"),
  join(PROJECT_DIR, ".codex", "skills", "meta-theory.md"),
  join(PROJECT_DIR, ".codex", "skills", "references"),
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

  if (scope === "project" || scope === "both") {
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

  if (scope === "global" || scope === "both") {
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

async function autoConfigure(installScope = "project") {
  const syncResult = runNodeScript("scripts/sync-runtimes.mjs", [
    "--scope",
    installScope,
  ]);
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
  const result = spawnSync("npm", ["install"], {
    cwd: PROJECT_DIR,
    stdio: "inherit",
    shell: isWin,
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
  return detectPython310();
}

// graphify platform name → graphify install command
const GRAPHIFY_PLATFORM_MAP = {
  claude: "claude",
  codex: "codex",
  openclaw: "claw",
  cursor: "cursor",
};

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
      const result = spawnSync(
        "winget",
        [
          "install",
          "--id",
          "Python.Python.3.11",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ],
        { stdio: "inherit", shell: true },
      );
      // winget returns non-zero for "package already installed, no upgrade
      // available" and for genuine failures alike — re-run detection either
      // way so an already-installed Python (that just isn't on PATH) is not
      // reported as "winget unavailable".
      const newPython = detectPython310();
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

async function installPythonTools(activeTargets, inUpdateMode = false) {
  heading(t.stepPythonTools);
  let python = checkPython310();
  if (!python) {
    python = await downloadAndInstallPython();
    if (!python) return;
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
        return;
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
      return;
    }
    ok(t.graphifyInstalled);
  }

  // Ensure networkx >= 3.4 for louvain_communities(max_level) compatibility
  ensureNetworkxCompatibility(python);

  // Idempotent wiring: register graphify skill for each active target + git hooks once.
  // git hooks are cross-platform (commit/checkout trigger), install once.
  // If the repo wasn't cloned via git (e.g. extracted from a zip), `.git` won't
  // exist and `graphify hook install` has nowhere to write — that's not a real
  // failure, just a no-op environment. Skip cleanly instead of alarming the user.
  if (!existsSync(join(PROJECT_DIR, ".git"))) {
    info(
      "Skipping graphify git hook (not a git repository — run `git init` or clone via git to enable auto-rebuild)",
    );
  } else {
    const hookResult = runPythonModule(
      python,
      ["-m", "graphify", "hook", "install"],
      undefined,
      { stdio: "pipe" },
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
  for (const target of activeTargets) {
    const platform = GRAPHIFY_PLATFORM_MAP[target];
    if (!platform) continue;
    info(t.graphifySkillRegistering(platform));
    const skillResult = runPythonModule(
      python,
      ["-m", "graphify", platform, "install"],
      undefined,
      { stdio: "pipe" },
    );
    if (skillResult.status === 0) {
      ok(t.graphifySkillRegistered(platform));
    } else {
      warn(t.graphifySkillFailed(platform));
    }
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

async function runMcpMemoryHookInstaller() {
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
    const result = spawnSync(whichCmd, [binName], {
      encoding: "utf8",
      shell: true,
    });
    if (result.status === 0 && result.stdout.trim()) {
      const found = result.stdout.trim().split(/\r?\n/)[0];
      if (found && existsSync(found)) return found;
    }
  } catch {}

  return null;
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

async function startMcpMemoryServiceBackground(resolved) {
  const memoryBin = findMemoryBinPath(resolved);
  if (!memoryBin) {
    warn(t.mcpMemoryAutoStartFailed);
    info(t.mcpMemoryAutoStartManual);
    return;
  }

  info(t.mcpMemoryAutoStarting);
  const env = { ...process.env, MCP_ALLOW_ANONYMOUS_ACCESS: "true" };

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

  warn(t.mcpMemoryAutoStartFailed);
  info(t.mcpMemoryAutoStartManual);
}

function configureBootAutoStart(memoryBin) {
  const plat = platform();
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
      const cmdPath = join(startupDir, "mcp-memory-start.cmd");
      const vbsPath = join(startupDir, "mcp-memory-silent.vbs");
      writeFileSync(
        cmdPath,
        `@echo off\r\nset MCP_ALLOW_ANONYMOUS_ACCESS=true\r\n"${memoryBin}" server --http\r\n`,
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
      const logPath = join(homedir(), ".meta-kim", "mcp-memory.log");
      mkdirSync(join(homedir(), ".meta-kim"), { recursive: true });
      writeFileSync(
        join(launchDir, "com.meta-kim.mcp-memory-service.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.meta-kim.mcp-memory-service</string>
  <key>ProgramArguments</key><array>
    <string>${memoryBin}</string><string>server</string><string>--http</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>MCP_ALLOW_ANONYMOUS_ACCESS</key><string>true</string>
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
    mkdirSync(autoDir, { recursive: true });
    writeFileSync(
      join(autoDir, "mcp-memory-service.desktop"),
      `[Desktop Entry]\nType=Application\nName=MCP Memory Service\nExec=env MCP_ALLOW_ANONYMOUS_ACCESS=true "${memoryBin}" server --http\nNoDisplay=true\n`,
    );
    return true;
  } catch {
    return false;
  }
}

async function installMcpMemoryServiceStep(inUpdateMode = false) {
  heading(t.stepMcpMemory);

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
    // Ask user (unless in silent mode)
    const want = await askYesNo(t.askMcpMemoryInstall, true);
    if (!want) {
      skip(`${C.dim}${t.mcpMemorySkipped}${C.reset}`);
      return;
    }

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
  const memoryServerConfig = resolved.venvCreated
    ? {
        command: python.command,
        args: [...python.args, "-m", "mcp_memory_service"],
      }
    : {
        command: "python",
        args: ["-m", "mcp_memory_service"],
      };

  const mcpPath = join(PROJECT_DIR, ".mcp.json");
  if (existsSync(mcpPath)) {
    try {
      const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf8"));
      if (mcpConfig.mcpServers?.["mcp-memory-service"]) {
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

  // Step 4.7 — auto-install the Claude Code SessionStart hook so the full
  // pipeline (pip package → .mcp.json → hook file → SessionStart registration
  // → health check) runs from a single `node setup.mjs` invocation.
  await runMcpMemoryHookInstaller();

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
  const displayDir = quickDeployDir || PROJECT_DIR;

  console.log(`${C.bold}${t.howToUse}${C.reset}
`);

  if (runtimes.claude) {
    console.log(
      `${C.dim}1.${C.reset} ${quickDeployDir ? t.npxQuickOpenIn : t.step1Open}`,
    );
    console.log(`${C.dim}cd "${displayDir}" && claude${C.reset}`);
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
  if (quickDeployDir) {
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
      `${C.dim}npm run meta:doctor:governance    # ${t.cmdDoctor}${C.reset}`,
    );
    console.log(
      `${C.dim}npm run meta:verify:all           # ${t.cmdVerify}${C.reset}`,
    );
  }

  console.log("");
  console.log(`${C.bold}${t.postInstallNotesHeading}${C.reset}`);
  console.log(`${C.dim}${t.postInstallNotesIntro}${C.reset}`);
  console.log("");
  console.log(
    `${C.bold}${C.cyan}● ${t.postInstallNotesPlatformSync}${C.reset}`,
  );
  const platformRows = [
    { name: t.platformClauleCode, cap: t.platformClauleCodeCap },
    { name: t.platformCodex, cap: t.platformCodexCap },
    { name: t.platformOpenClaw, cap: t.platformOpenClawCap },
    { name: t.platformCursor, cap: t.platformCursorCap },
  ].filter(
    (r) =>
      runtimes[
        r.name
          .replace("platform", "")
          .toLowerCase()
          .replace("claulecode", "claude")
      ] || r.name === t.platformClauleCode,
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

async function main() {
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
    checkSync(detectedRuntimes, targetContext.supportedTargets);
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

  if (silentMode) {
    await runInstall();
    process.exit(0);
  }

  if (updateMode) {
    await runUpdate();
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

  // 新增：询问安装范围
  const installScope = await askInstallScope();

  // Ask proxy configuration (saves to localOverrides)
  await askProxyConfig();

  let selectedSkillIds = [];
  if (installScope === "global" || installScope === "both") {
    selectedSkillIds = await resolveSelectedSkillDependencyIds();
  }

  // Ask deploy directory BEFORE confirm (so user decides upfront)
  const deployDir = await askDeployDirectory();

  // Show installation overview
  showInstallOverview(activeTargets, installScope, selectedSkillIds);
  await showExistingFootprint(installScope);

  const confirm = await askYesNo(t.confirmStartInstall, true);
  if (!confirm) {
    console.log(`\n${C.dim}${t.installCancelled}${C.reset}\n`);
    process.exit(0);
  }

  console.log();

  const needProject = installScope === "project" || installScope === "both";
  const needGlobal = installScope === "global" || installScope === "both";

  // 步骤计数
  let stepNum = 0;

  // 项目本地同步 (project-only 或 both)
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
      const result = spawnSync("npm", ["install"], {
        cwd: PROJECT_DIR,
        stdio: "inherit",
        shell: isWin,
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
      const configResult = await autoConfigure(installScope);
      if (!configResult) {
        warn(t.warnConfigSyncFailed);
      }
      return configResult;
    });
  }

  // 全局安装 (global-only 或 both)
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
      const syncResult = runNodeScript("scripts/sync-global-meta-theory.mjs", [
        "--targets",
        activeTargets.join(","),
      ]);
      if (syncResult.status !== 0) {
        warn(t.warnMetaTheorySyncFailed);
      }
      return syncResult.status === 0;
    });
  }

  // [Optional] Python tools (graphify)
  stepNum++;
  await withProgress(
    t.stepLabel(stepNum, t.progressInstallPython),
    async () => {
      const wantPython = await askYesNo(t.askPythonToolsUpdate, true);
      if (wantPython) {
        await installPythonTools(activeTargets);
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
      await installMcpMemoryServiceStep();
    },
  );

  //验证：project-only 和 both 检查 repo-local；global-only 跳过 repo-local 检查
  stepNum++;
  await withProgress(t.stepLabel(stepNum, t.progressValidate), async () => {
    if (needProject) {
      const { supportedTargets } = await resolveTargetContext(args);
      checkSync(runtimes, supportedTargets);
    }
    await validate();
  });

  console.log(`\n${C.bold}${C.green}✓ ${t.installComplete}${C.reset}\n`);

  // Copy runtime files to user-chosen directory (if opted in earlier)
  if (deployDir) {
    await copyToDeployDir(activeTargets, deployDir);
  }

  showNextSteps(runtimes);
}

async function runUpdate() {
  heading(t.updateHeading);
  const runtimes = await detectRuntimes();
  const reselectTargets = await askYesNo(t.askReselectRuntimes, false);
  const activeTargets = reselectTargets
    ? await selectActiveTargets(runtimes)
    : (await resolveTargetContext(args)).activeTargets;

  // ── 0. Ask for update scope (like install mode) ─────────────────────
  const updateScope = await askInstallScope();

  // Ask proxy configuration (saves to localOverrides)
  await askProxyConfig();

  // Ask deploy directory BEFORE update starts
  const deployDir = await askDeployDirectory();

  // ── 1. npm install (always — new code may have new deps) ────────────
  info(t.updateNpm);
  const npmResult = spawnSync("npm", ["install"], {
    cwd: PROJECT_DIR,
    stdio: "inherit",
    shell: isWin,
  });
  if (npmResult.status === 0) ok(t.npmDone);
  else warn(t.npmFailed);

  // ── 2. [Optional] Python tools (graphify) ─────────────────────────
  console.log("");
  const wantPython = await askYesNo(t.askPythonToolsUpdate, true);
  if (wantPython) {
    await installPythonTools(activeTargets, true);
  } else {
    skip(`${C.dim}${t.pythonToolsSkipped}${C.reset}`);
  }

  // ── 2.5 [Optional] MCP Memory Service (Layer 3) ─────────────────
  console.log("");
  await installMcpMemoryServiceStep(true);

  // ── 2.8. Clean up legacy skill files ───────────────────────────────
  const legacyCount = cleanupLegacySkills(updateScope);
  if (legacyCount > 0) ok(`Cleaned ${legacyCount} legacy file(s)`);

  // ── 3. sync-runtimes (scope from user selection) ──────────────────
  if (updateScope === "global") {
    skip(`${C.dim}${t.updateSyncProjectSkipped}${C.reset}`);
  } else {
    info(t.updateSyncProjectFiles);
    const syncResult = runNodeScript("scripts/sync-runtimes.mjs", [
      "--scope",
      updateScope,
    ]);
    if (syncResult.status === 0) ok(t.updateSyncDone);
    else warn(t.updateSyncSkip);
  }

  // ── 4. [Optional] Global skills update ─────────────────────────────
  console.log("");
  const wantGlobalSkills = await askYesNo(t.askGlobalSkillsUpdate, true);
  if (wantGlobalSkills) {
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
  } else {
    skip(`${C.dim}${t.globalSkillsSkipped}${C.reset}`);
  }

  // ── 5. [Optional] Global meta-theory sync ──────────────────────────
  console.log("");
  const wantMetaTheory = await askYesNo(t.askMetaTheoryUpdate, true);
  if (wantMetaTheory) {
    const updateSyncResult = runNodeScript(
      "scripts/sync-global-meta-theory.mjs",
      ["--targets", activeTargets.join(",")],
    );
    if (updateSyncResult.status === 0) ok(t.updateMetaTheoryDone);
    else warn(t.warnMetaTheoryUpdateFailed);
  } else {
    skip(`${C.dim}${t.metaTheorySkipped}${C.reset}`);
  }

  // ── 6. checkSync (repo-local, project scope) ───────────────────────
  const { supportedTargets } = await resolveTargetContext(args);
  checkSync(runtimes, supportedTargets);
  console.log(`\n${C.bold}${C.green}✓ ${t.updateComplete}${C.reset}\n`);

  // Copy runtime files to user-chosen directory (if opted in earlier)
  if (deployDir) {
    await copyToDeployDir(activeTargets, deployDir);
  }
}

async function runCheck() {
  console.log(`\n${C.green}✓ ${t.envOk}${C.reset}\n`);
  const runtimes = await detectRuntimes();
  const targetContext = await resolveTargetContext(args);
  checkSync(runtimes, targetContext.supportedTargets);
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
