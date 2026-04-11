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
 */

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import {
  ensureProfileState,
  toRepoRelative,
} from "./scripts/meta-kim-local-state.mjs";
import {
  loadLocalOverrides,
  normalizeTargets,
  resolveTargetContext,
  writeLocalOverrides,
} from "./scripts/meta-kim-sync-config.mjs";

// ── Config ──────────────────────────────────────────────

const PROJECT_DIR = resolve(import.meta.dirname || ".");
const SKILLS_DIR = join(homedir(), ".claude", "skills");
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const isWin = platform() === "win32";
const args = process.argv.slice(2);
const updateMode = args.includes("--update") || args.includes("-u");
const checkOnly = args.includes("--check");
const silentMode = args.includes("--silent") || !process.stdout.isTTY;

const langIdx = args.indexOf("--lang");
const langArg = langIdx >= 0 && args[langIdx + 1] ? args[langIdx + 1] : null;
let currentLangCode = langArg || "en"; // Current language code for passing to child scripts

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

    const findskillPackSubdir = platform() === "win32" ? "windows" : "original";

    // Transform manifest to legacy format for compatibility
    return {
      skillOwner,
      externalUrls: manifest.externalUrls || {},
      skills: manifest.skills.map((skill) => {
        const repo = skill.repo.replace("${skillOwner}", skillOwner);

        // Handle subdir with platform mapping
        let subdir = skill.subdir;
        if (skill.subdirTemplate === "{platform}" && skill.subdirMapping) {
          subdir =
            skill.subdirMapping[platform()] || skill.subdirMapping.default;
        }

        return {
          name: skill.id,
          repo,
          subdir: subdir || findskillPackSubdir,
          claudePlugin: skill.claudePlugin,
          targets: skill.targets || ["claude", "codex", "openclaw"],
        };
      }),
    };
  } catch (err) {
    warn(`Failed to load skills manifest: ${err.message}`);
    return { skillOwner: "KimYx0207", externalUrls: {}, skills: [] };
  }
}

const skillsManifest = loadSkillsManifest();
const SKILL_OWNER = skillsManifest.skillOwner;
const SKILLS = skillsManifest.skills;
const EXTERNAL_URLS = skillsManifest.externalUrls;

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
    nodeOld: (v) => `Node.js v${v} too old, need >=18`,
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
    mcpCreated: ".mcp.json created — MCP runtime server registered",
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
    npmFailed: "npm install failed",
    nodeModulesExist: "node_modules exists (use --update to reinstall)",
    skillUpdated: (n) => `${n} — updated`,
    skillInstalled: (n) => `${n} — installed`,
    skillExists: (n) => `${n} — already installed`,
    skillSubdirInstalled: (n, s) => `${n} — installed (subdir: ${s})`,
    skillFailed: (n, r) => `${n} — failed (${r})`,
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
    setupError: "Setup error:",
    selectLang: "Select language / 选择语言 / 言語を選択 / 언어 선택",
    choose: (n) => `Choose (1-${n})`,
    globalInstallPrompt:
      "Meta_Kim skills install to ~/.claude/skills/ (global). Install globally?",
    globalDirReady: (p) => `Global skills dir ready: ${p}`,
    globalDirCreated: (p) => `Created global skills dir: ${p}`,
    globalDirTitle: "Global Skills Directory",
    globalDirPrompt: `Meta_Kim skills will be installed to ~/.claude/skills/
• Global install — Shared across all projects
• Skip — For this project only
• Re-run setup.mjs anytime to install`,
    globalSkipped: "Global install skipped — using project-local only",
    // Install scope selection
    installScopeHeading: "Installation Scope",
    installScopePrompt: "Where would you like to install Meta_Kim?",
    installScopeProject:
      "Project only — Files in .claude/.codex/openclaw/.cursor/ (current project only)",
    installScopeGlobal:
      "Global only — ~/.claude/skills/ (shared across all projects)",
    installScopeBoth: "Both (recommended) — Project files + global skills",
    installScopeProjectLabel: "Project only",
    installScopeGlobalLabel: "Global only",
    installScopeBothLabel: "Both (recommended)",
    installScopeProjectDesc:
      "Install to project directory only (.claude/, .codex/, openclaw/, .cursor/)",
    installScopeGlobalDesc:
      "Install to global directory only (~/.claude/skills/)",
    installScopeBothDesc:
      "Install both project and global (recommended for full experience)",
    depCheckHeading: "Dependency Check",
    depOk: (n) => `${n} — OK`,
    depMissing: (n) => `${n} — MISSING`,
    depNoFiles: (n) => `${n} — directory exists but no .md files`,
    selectRuntimeTargets: "Which AI coding tools do you use on this machine?",
    inputTargetsHint: (d) =>
      `Enter numbers, comma for multiple; Enter to use default ${d}`,
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
    syncCodexSkills: "Codex skills/meta-theory.md",
    syncOpenclawWorkspaces: (n) =>
      `OpenClaw workspaces: ${n}/8 agents — each folder has the 9 required .md files (BOOT, SOUL, …)`,
    syncOpenclawSkill: "OpenClaw shared meta-theory",
    syncSharedSkills: "shared-skills/meta-theory.md",
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
    graphifyCheck: (v) => `graphify ${v}`,
    graphifyInstalling:
      "Installing graphify (code knowledge graph, 71x token compression)...",
    graphifyInstalled: "graphify installed and Claude skill registered",
    graphifyInstallFailed: "graphify installation failed (non-blocking)",
    graphifyAlreadyInstalled: (v) => `graphify ${v} — already installed`,
    graphifySkillRegistering: "Registering graphify Claude skill...",
    graphifySkillRegistered:
      "graphify Claude skill registered to ~/.claude/skills/graphify/",
    graphifySkillFailed:
      "graphify Claude skill registration failed (non-blocking)",
    updateHeading: "Update Mode",
    updateNpm: "Reinstalling npm dependencies...",
    updateSkills: "Updating all skills...",
    updateSyncProjectFiles: "Syncing project runtime files from canonical/...",
    updateSyncDone: "Sync complete",
    updateSyncProjectSkipped: "Project sync skipped (global update mode)",
    updateSyncSkip: "Sync skipped or failed",
    updateReGlobal: "Re-select global skills directory?",
    askReselectRuntimes: "Re-select AI coding tools for this machine?",
    askPythonToolsUpdate:
      "Install Python graphify (code knowledge graph, 71x token compression)?",
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
      "Install 9 global skill repositories (~/.claude/skills/)",
    installOverviewSyncMeta: "Sync meta-theory to global directory",
    installOverviewOptionalPython: "Install Python graphify tool",
    installOverviewTargets: "Target tools:",
    installOverviewScope: "Installation scope:",
    installOverviewEstimated: "Estimated time:",
    installOverviewTime: "2-5 minutes (depends on network speed)",
    // Progress step strings
    progressPrepareDir: "Prepare global skills directory",
    progressSyncConfig: "Sync tool configurations",
    progressInstallSkills: "Install global skills (may take several minutes)",
    progressSyncMeta: "Sync meta-theory",
    progressValidate: "Validate installation",
    // Confirm strings
    confirmStartInstall: "Start installation?",
    installCancelled: "Installation cancelled",
    installComplete: "Installation complete!",
    // Warning messages
    warnConfigSyncFailed: "Config sync failed, continuing...",
    warnSkillsInstallFailed:
      "Global skills install failed, check error messages",
    warnMetaTheorySyncFailed: "meta-theory sync failed, check error messages",
    warnSkillsUpdateFailed: "Global skills update failed, check error messages",
    warnMetaTheoryUpdateFailed: "meta-theory sync failed, check error messages",
    actionPrompt: "What would you like to do?",
    actionInstall: "Install — Full first-time setup",
    actionUpdate: "Update — Refresh skills & sync tools",
    actionCheck: "Check — Verify dependencies & sync status",
    actionExit: "Exit",
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
    nodeOld: (v) => `Node.js v${v} 版本过低，需要 >=18`,
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
    mcpCreated: ".mcp.json 已创建 — MCP 运行时服务器已注册",
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
    npmFailed: "npm install 失败",
    nodeModulesExist: "node_modules 已存在（使用 --update 重新安装）",
    skillUpdated: (n) => `${n} — 已更新`,
    skillInstalled: (n) => `${n} — 已安装`,
    skillExists: (n) => `${n} — 已安装`,
    skillSubdirInstalled: (n, s) => `${n} — 已安装 (子目录: ${s})`,
    skillFailed: (n, r) => `${n} — 安装失败 (${r})`,
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
    setupError: "安装出错：",
    selectLang: "Select language / 选择语言 / 言語を選択 / 언어 선택",
    choose: (n) => `选择 (1-${n})`,
    globalInstallPrompt:
      "Meta_Kim 技能安装到 ~/.claude/skills/（全局）。是否全局安装？",
    globalDirReady: (p) => `全局技能目录就绪：${p}`,
    globalDirCreated: (p) => `已创建全局技能目录：${p}`,
    globalDirTitle: "全局技能目录",
    globalDirPrompt: `Meta_Kim 技能将安装到 ~/.claude/skills/
• 全局安装 — 所有项目共享
• 跳过 — 仅在当前项目使用
• 随时可重新运行 setup.mjs 安装`,
    globalSkipped: "全局安装已跳过 — 将仅在当前项目使用",
    // 安装范围选择
    installScopeHeading: "安装范围",
    installScopePrompt: "Meta_Kim 安装到哪里？",
    installScopeProject:
      "仅项目 — 文件在 .claude/.codex/openclaw/.cursor/（仅当前项目）",
    installScopeGlobal: "仅全局 — ~/.claude/skills/（所有项目共享）",
    installScopeBoth: "全部（推荐）— 项目文件 + 全局技能",
    installScopeProjectLabel: "仅项目",
    installScopeGlobalLabel: "仅全局",
    installScopeBothLabel: "全部（推荐）",
    installScopeProjectDesc:
      "仅安装到项目目录（.claude/, .codex/, openclaw/, .cursor/）",
    installScopeGlobalDesc: "仅安装到全局目录（~/.claude/skills/）",
    installScopeBothDesc: "同时安装项目和全局（推荐，完整体验）",
    depCheckHeading: "依赖检查",
    depOk: (n) => `${n} — 正常`,
    depMissing: (n) => `${n} — 缺失`,
    depNoFiles: (n) => `${n} — 目录存在但无 .md 文件`,
    selectRuntimeTargets: "这台电脑上用哪些 AI 编程工具？",
    inputTargetsHint: (d) => `输入编号，逗号多选；回车使用默认 ${d}`,
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
    syncCodexSkills: "Codex 技能/meta-theory.md",
    syncOpenclawWorkspaces: (n) =>
      `OpenClaw 工作区：${n}/8 个智能体，各目录 9 个必备 Markdown 已齐（含 BOOT、SOUL 等；不含子文件夹里的额外文件）`,
    syncOpenclawSkill: "OpenClaw 共享 meta-theory",
    syncSharedSkills: "共享技能/meta-theory.md",
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
    graphifyCheck: (v) => `graphify ${v}`,
    graphifyInstalling: "正在安装 graphify（代码知识图谱，71x token 压缩）...",
    graphifyInstalled: "graphify 已安装，Claude 技能已注册",
    graphifyInstallFailed: "graphify 安装失败（不影响其他功能）",
    graphifyAlreadyInstalled: (v) => `graphify ${v} — 已安装`,
    graphifySkillRegistering: "正在注册 graphify Claude 技能...",
    graphifySkillRegistered:
      "graphify Claude 技能已注册到 ~/.claude/skills/graphify/",
    graphifySkillFailed: "graphify Claude 技能注册失败（不影响其他功能）",
    updateHeading: "更新模式",
    updateNpm: "正在重新安装 npm 依赖...",
    updateSkills: "正在更新所有技能...",
    updateSyncProjectFiles: "正在从 canonical/ 同步项目运行时文件...",
    updateSyncDone: "同步完成",
    updateSyncProjectSkipped: "跳过项目同步（全局更新模式）",
    updateSyncSkip: "未同步或同步失败",
    updateReGlobal: "是否重新选择全局技能目录？",
    askReselectRuntimes: "重新选择这台电脑的 AI 编程工具？",
    askPythonToolsUpdate:
      "安装 Python graphify（代码知识图谱，71x token 压缩）？",
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
    installOverviewInstallSkills: "安装 9 个全局技能仓库",
    installOverviewSyncMeta: "同步 meta-theory 到全局目录",
    installOverviewOptionalPython: "可选：安装 Python graphify 工具",
    installOverviewTargets: "目标工具：",
    installOverviewScope: "安装范围：",
    installOverviewEstimated: "预计用时：",
    installOverviewTime: "2-5 分钟（取决于网络速度）",
    // 进度步骤字符串
    progressPrepareDir: "准备全局技能目录",
    progressSyncConfig: "同步配置文件",
    progressInstallSkills: "安装全局技能（可能需要几分钟）",
    progressSyncMeta: "同步 meta-theory",
    progressValidate: "验证安装",
    // 确认字符串
    confirmStartInstall: "开始安装？",
    installCancelled: "安装已取消",
    installComplete: "安装完成！",
    // Warning messages
    warnConfigSyncFailed: "配置同步失败，继续安装...",
    warnSkillsInstallFailed: "全局技能安装失败，请检查错误信息",
    warnMetaTheorySyncFailed: "meta-theory 同步失败，请检查错误信息",
    warnSkillsUpdateFailed: "全局技能更新失败，请检查错误信息",
    warnMetaTheoryUpdateFailed: "meta-theory 同步失败，请检查错误信息",
    actionPrompt: "你想做什么？",
    actionInstall: "安装 — 首次完整安装",
    actionUpdate: "更新 — 刷新技能并同步配置",
    actionCheck: "检查 — 验证依赖和同步状态",
    actionExit: "退出",
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
    nodeOld: (v) => `Node.js v${v} は古すぎます。>=18 が必要です`,
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
    mcpCreated: ".mcp.json 作成済み — MCP ランタイムサーバー登録完了",
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
    npmFailed: "npm install に失敗しました",
    nodeModulesExist: "node_modules が存在します（--update で再インストール）",
    skillUpdated: (n) => `${n} — 更新済み`,
    skillInstalled: (n) => `${n} — インストール済み`,
    skillExists: (n) => `${n} — インストール済み`,
    skillSubdirInstalled: (n, s) =>
      `${n} — インストール済み (サブディレクトリ: ${s})`,
    skillFailed: (n, r) => `${n} — 失敗 (${r})`,
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
    setupError: "セットアップエラー：",
    selectLang: "Select language / 选择语言 / 言語を選択 / 언어 선택",
    choose: (n) => `選択 (1-${n})`,
    globalInstallPrompt:
      "Meta_Kim スキルは ~/.claude/skills/（グローバル）にインストールされます。グローバルインストールしますか？",
    globalDirReady: (p) => `グローバルスキルディレクトリ準備完了：${p}`,
    globalDirCreated: (p) => `グローバルスキルディレクトリ作成：${p}`,
    globalDirTitle: "グローバルスキルディレクトリ",
    globalDirPrompt: `Meta_Kim スキルは ~/.claude/skills/ にインストールされます
• グローバルインストール — すべてのプロジェクトで共有
• スキップ — このプロジェクトのみ
• いつでも setup.mjs を再実行してインストール`,
    globalSkipped:
      "グローバルインストールスキップ — プロジェクトローカルのみ使用",
    // インストール範囲選択
    installScopeHeading: "インストール範囲",
    installScopePrompt: "Meta_Kim をどこにインストールしますか？",
    installScopeProject:
      "プロジェクトのみ — .claude/.codex/openclaw/.cursor/ のファイル（現在のプロジェクトのみ）",
    installScopeGlobal:
      "グローバルのみ — ~/.claude/skills/（すべてのプロジェクトで共有）",
    installScopeBoth: "両方（推奨）— プロジェクトファイル + グローバルスキル",
    installScopeProjectLabel: "プロジェクトのみ",
    installScopeGlobalLabel: "グローバルのみ",
    installScopeBothLabel: "両方（推奨）",
    installScopeProjectDesc:
      "プロジェクトディレクトリのみにインストール（.claude/, .codex/, openclaw/, .cursor/）",
    installScopeGlobalDesc:
      "グローバルディレクトリのみにインストール（~/.claude/skills/）",
    installScopeBothDesc:
      "プロジェクトとグローバル両方にインストール（推奨、完全な体験）",
    depCheckHeading: "依存関係チェック",
    depOk: (n) => `${n} — OK`,
    depMissing: (n) => `${n} — 見つかりません`,
    depNoFiles: (n) => `${n} — ディレクトリはありますが.mdファイルがありません`,
    selectRuntimeTargets: "このパソコンで使うAIコーディングツールを選択",
    inputTargetsHint: (d) =>
      `番号を入力、カンマで複数選択；Enterでデフォルト ${d}`,
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
    syncCodexSkills: "Codex スキル/meta-theory.md",
    syncOpenclawWorkspaces: (n) =>
      `OpenClaw ワークスペース: ${n}/8 エージェント — 各フォルダに必須の .md 9 件（BOOT、SOUL など）`,
    syncOpenclawSkill: "OpenClaw 共有 meta-theory",
    syncSharedSkills: "共有スキル/meta-theory.md",
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
    graphifyCheck: (v) => `graphify ${v}`,
    graphifyInstalling:
      "graphify をインストール中（コードナレッジグラフ、71x トークン圧縮）...",
    graphifyInstalled: "graphify インストール完了、Claude スキル登録済み",
    graphifyInstallFailed: "graphify インストール失敗（非ブロッキング）",
    graphifyAlreadyInstalled: (v) => `graphify ${v} — インストール済み`,
    graphifySkillRegistering: "graphify Claude スキルを登録中...",
    graphifySkillRegistered:
      "graphify Claude スキルを ~/.claude/skills/graphify/ に登録",
    graphifySkillFailed: "graphify Claude スキル登録失敗（非ブロッキング）",
    updateHeading: "アップデートモード",
    updateNpm: "npm依存関係を再インストール中...",
    updateSkills: "すべてのスキルを更新中...",
    updateSyncProjectFiles:
      "canonical/ からプロジェクトランタイムファイルを同期中...",
    updateSyncDone: "同期が完了しました",
    updateSyncProjectSkipped:
      "プロジェクト同期をスキップ（グローバル更新モード）",
    updateSyncSkip: "同期をスキップしたか失敗しました",
    updateReGlobal: "グローバルスキルディレクトリを再選択しますか？",
    askReselectRuntimes:
      "このパソコンで使うAIコーディングツールを再選択しますか？",
    askPythonToolsUpdate:
      "Python graphify（コードナレッジグラフ、71x トークン圧縮）をインストールしますか？",
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
      "9つのグローバルスキルリポジトリをインストール (~/.claude/skills/)",
    installOverviewSyncMeta: "meta-theory をグローバルディレクトリに同期",
    installOverviewOptionalPython: "Python graphify ツールをインストール",
    installOverviewTargets: "対象ツール：",
    installOverviewScope: "インストール範囲：",
    installOverviewEstimated: "予想時間：",
    installOverviewTime: "2-5分（ネットワーク速度によります）",
    // 進捗ステップ文字列
    progressPrepareDir: "グローバルスキルディレクトリを準備",
    progressSyncConfig: "設定を同期",
    progressInstallSkills:
      "グローバルスキルをインストール（数分かかる場合があります）",
    progressSyncMeta: "meta-theory を同期",
    progressValidate: "インストールを検証",
    // 確認文字列
    confirmStartInstall: "インストールを開始しますか？",
    installCancelled: "インストールがキャンセルされました",
    installComplete: "インストール完了！",
    // 警告メッセージ
    warnConfigSyncFailed: "設定同期失敗、続行します...",
    warnSkillsInstallFailed:
      "グローバルスキルインストール失敗、エラーを確認してください",
    warnMetaTheorySyncFailed: "meta-theory 同期失敗、エラーを確認してください",
    warnSkillsUpdateFailed:
      "グローバルスキル更新失敗、エラーを確認してください",
    warnMetaTheoryUpdateFailed:
      "meta-theory 同期失敗、エラーを確認してください",
    actionPrompt: "何をしますか？",
    actionInstall: "インストール — 初回セットアップ",
    actionUpdate: "アップデート — スキル更新＆設定同期",
    actionCheck: "チェック — 依存関係と同期状態を確認",
    actionExit: "終了",
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
    nodeOld: (v) => `Node.js v${v} 버전이 너무 낮습니다. >=18 필요`,
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
    mcpCreated: ".mcp.json 생성됨 — MCP 런타임 서버 등록 완료",
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
    npmFailed: "npm install 실패",
    nodeModulesExist: "node_modules가 존재합니다 (--update로 재설치)",
    skillUpdated: (n) => `${n} — 업데이트됨`,
    skillInstalled: (n) => `${n} — 설치됨`,
    skillExists: (n) => `${n} — 이미 설치됨`,
    skillSubdirInstalled: (n, s) => `${n} — 설치됨 (하위디렉토리: ${s})`,
    skillFailed: (n, r) => `${n} — 실패 (${r})`,
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
    setupError: "설정 오류:",
    selectLang: "Select language / 选择语言 / 言語を選択 / 언어 선택",
    choose: (n) => `선택 (1-${n})`,
    globalInstallPrompt:
      "Meta_Kim 스킬을 ~/.claude/skills/ (전역)에 설치합니다. 전역 설치할까요?",
    globalDirReady: (p) => `전역 스킬 디렉토리 준비됨: ${p}`,
    globalDirCreated: (p) => `전역 스킬 디렉토리 생성됨: ${p}`,
    globalDirTitle: "전역 스킬 디렉토리",
    globalDirPrompt: `Meta_Kim 스킬은 ~/.claude/skills/ 에 설치됩니다
• 전역 설치 — 모든 프로젝트에서 공유
• 건너뛰기 — 이 프로젝트에서만 사용
• 언제든 setup.mjs 를 다시 실행하여 설치`,
    globalSkipped: "전역 설치 건너뜀 — 프로젝트 로컬만 사용",
    // 설치 범위 선택
    installScopeHeading: "설치 범위",
    installScopePrompt: "Meta_Kim을 어디에 설치하시겠습니까?",
    installScopeProject:
      "프로젝트만 — .claude/.codex/openclaw/.cursor/ 파일 (현재 프로젝트만)",
    installScopeGlobal: "전역만 — ~/.claude/skills/ (모든 프로젝트 공유)",
    installScopeBoth: "둘 다 (권장) — 프로젝트 파일 + 전역 스킬",
    installScopeProjectLabel: "프로젝트만",
    installScopeGlobalLabel: "전역만",
    installScopeBothLabel: "둘 다 (권장)",
    installScopeProjectDesc:
      "프로젝트 디렉토리에만 설치 (.claude/, .codex/, openclaw/, .cursor/)",
    installScopeGlobalDesc: "전역 디렉토리에만 설치 (~/.claude/skills/)",
    installScopeBothDesc: "프로젝트와 전역 모두 설치 (권장, 완전한 경험)",
    depCheckHeading: "의존성 확인",
    depOk: (n) => `${n} — 정상`,
    depMissing: (n) => `${n} — 누락`,
    depNoFiles: (n) => `${n} — 디렉토리는 있으나 .md 파일 없음`,
    selectRuntimeTargets: "이 컴퓨터에서 사용할 AI 코딩 도구 선택",
    inputTargetsHint: (d) => `번호 입력, 쉼표로 다중 선택；Enter로 기본값 ${d}`,
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
    syncCodexSkills: "Codex 스킬/meta-theory.md",
    syncOpenclawWorkspaces: (n) =>
      `OpenClaw 워크스페이스: ${n}/8 에이전트 — 각 폴더에 필수 .md 9개(BOOT, SOUL 등)`,
    syncOpenclawSkill: "OpenClaw 공유 meta-theory",
    syncSharedSkills: "공유 스킬/meta-theory.md",
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
    graphifyCheck: (v) => `graphify ${v}`,
    graphifyInstalling: "graphify 설치 중 (코드 지식 그래프, 71x 토큰 압축)...",
    graphifyInstalled: "graphify 설치 완료, Claude 스킬 등록됨",
    graphifyInstallFailed: "graphify 설치 실패 (비차단)",
    graphifyAlreadyInstalled: (v) => `graphify ${v} — 이미 설치됨`,
    graphifySkillRegistering: "graphify Claude 스킬 등록 중...",
    graphifySkillRegistered:
      "graphify Claude 스킬이 ~/.claude/skills/graphify/에 등록됨",
    graphifySkillFailed: "graphify Claude 스킬 등록 실패 (비차단)",
    updateHeading: "업데이트 모드",
    updateNpm: "npm 의존성 재설치 중...",
    updateSkills: "모든 스킬 업데이트 중...",
    updateSyncProjectFiles: "canonical/에서 프로젝트 런타임 파일 동기화 중...",
    updateSyncDone: "동기화 완료",
    updateSyncProjectSkipped: "프로젝트 동기화 건너뜀 (전역 업데이트 모드)",
    updateSyncSkip: "동기화를 건너뛰었거나 실패했습니다",
    updateReGlobal: "전역 스킬 디렉토리를 다시 선택할까요?",
    askReselectRuntimes: "이 컴퓨터에서 사용할 AI 코딩 도구를 다시 선택할까요?",
    askPythonToolsUpdate:
      "Python graphify (코드 지식 그래프, 71x 토큰 압축)를 설치할까요?",
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
      "9개 전역 스킬 리포지토리 설치 (~/.claude/skills/)",
    installOverviewSyncMeta: "meta-theory를 전역 디렉토리에 동기화",
    installOverviewOptionalPython: "Python graphify 도구 설치",
    installOverviewTargets: "대상 도구:",
    installOverviewScope: "설치 범위:",
    installOverviewEstimated: "예상 시간:",
    installOverviewTime: "2-5분(네트워크 속도에 따라 다름)",
    // 진행 단계 문자열
    progressPrepareDir: "전역 스킬 디렉토리 준비",
    progressSyncConfig: "설정 동기화",
    progressInstallSkills: "전역 스킬 설치(몇 분 소요될 수 있음)",
    progressSyncMeta: "meta-theory 동기화",
    progressValidate: "설치 검증",
    // 확인 문자열
    confirmStartInstall: "설치를 시작할까요?",
    installCancelled: "설치가 취소되었습니다",
    installComplete: "설치 완료!",
    // 경고 메시지
    warnConfigSyncFailed: "구성 동기화 실패, 계속 진행...",
    warnSkillsInstallFailed: "전역 스킬 설치 실패, 오류 메시지를 확인하세요",
    warnMetaTheorySyncFailed:
      "meta-theory 동기화 실패, 오류 메시지를 확인하세요",
    warnSkillsUpdateFailed: "전역 스킬 업데이트 실패, 오류 메시지를 확인하세요",
    warnMetaTheoryUpdateFailed:
      "meta-theory 동기화 실패, 오류 메시지를 확인하세요",
    actionPrompt: "무엇을 하시겠습니까?",
    actionInstall: "설치 — 최초 전체 설정",
    actionUpdate: "업데이트 — 스킬 갱신 및 설정 동기화",
    actionCheck: "확인 — 의존성 및 동기화 상태 검증",
    actionExit: "종료",
    aboutAuthor: "작성자 소개",
    contactWebsite: "웹사이트",
    contactGithub: "GitHub",
    contactFeishu: "Feishu 위키",
    contactWechat: "WeChat 공식 계정",
  },
};

let t = I18N.en; // default, overwritten by selectLanguage()

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
  console.log(`\n${C.bold}${C.section}  ▸ ${msg}${C.reset}\n`);
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
    if (ver) return ver;
  }
  const resolved = isWin
    ? run(`where ${name} 2>nul`)
    : run(`which ${name} 2>/dev/null`);
  if (resolved) {
    const path = resolved.split(/\r?\n/)[0].trim();
    const ver = run(`"${path}" --version`);
    if (ver) return ver;
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

async function askSelect(question, options) {
  console.log(`\n  ${C.bold}?${C.reset} ${question}`);
  options.forEach((opt, i) => {
    console.log(`    ${C.dim}${i + 1}.${C.reset} ${opt}`);
  });
  const answer = await ask(t.choose(options.length));
  const idx = parseInt(answer, 10) - 1;
  return idx >= 0 && idx < options.length ? idx : 0;
}

async function askMultiSelectTargets(question, choices, defaultIds) {
  if (silentMode) {
    return defaultIds;
  }

  const defaultSet = new Set(defaultIds);
  console.log(`\n  ${C.bold}?${C.reset} ${question}`);
  choices.forEach((choice, index) => {
    const marker = defaultSet.has(choice.id) ? `${C.green}x${C.reset}` : " ";
    console.log(
      `    ${C.dim}${index + 1}.${C.reset} [${marker}] ${choice.label} ${C.dim}(${choice.id})${C.reset}`,
    );
  });
  const answer = await ask(
    `${t.inputTargetsHint(`${C.dim}${defaultIds.join(", ")}${C.reset}`)}`,
  );
  if (!answer) {
    return defaultIds;
  }

  const parts = answer
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const mapped = parts.map((part) => {
    if (/^\d+$/.test(part)) {
      const index = Number.parseInt(part, 10) - 1;
      return choices[index]?.id ?? part;
    }
    return part.toLowerCase();
  });

  return normalizeTargets(mapped);
}

// ── Step 0: Language selection ───────────────────────────

async function selectLanguage() {
  if (langArg) {
    const match = LANGUAGES.find((l) => l.code === langArg);
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
function showInstallOverview(activeTargets, installScope) {
  const bullets = [];
  bullets.push(t.installOverviewSyncConfig);

  if (installScope === "project") {
    // project-only: sync only
  } else if (installScope === "global") {
    // global-only: skills + meta-theory only
    bullets.push(t.installOverviewInstallSkills);
    bullets.push(t.installOverviewSyncMeta);
  } else {
    // both: all steps
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

  console.log(`
${C.bold}  ${t.installOverviewTitle}${C.reset}

  ${C.dim}${t.installOverviewWill}${C.reset}
${bullets.map((b) => `${C.dim}•${C.reset} ${b}`).join("\n")}
  ${C.dim}•${C.reset} ${C.dim}${t.installOverviewOptionalPython}${C.reset} ${C.yellow}(optional)${C.reset}

  ${C.dim}${t.installOverviewTargets}${C.reset}${activeTargets.join(", ")}
  ${C.dim}${t.installOverviewScope}${C.reset}${scopeLabel}
  ${C.dim}${t.installOverviewEstimated}${C.reset}${t.installOverviewTime}
`);
}

/** Execute with progress indicator */
async function withProgress(label, fn) {
  process.stdout.write(`${C.dim}→${C.reset} ${label}...`);
  const startTime = Date.now();

  try {
    const result = await fn();
    const elapsed = Date.now() - startTime;
    const timeStr =
      elapsed > 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`;
    console.log(` ${C.green}✓${C.reset} ${C.dim}(${timeStr})${C.reset}`);
    return result;
  } catch (err) {
    console.log(` ${C.red}✗${C.reset}`);
    throw err;
  }
}

// ── Install scope selection ─────────────────────────────

/**
 * Ask user where to install: project-only, global-only, or both
 * Returns: 'project' | 'global' | 'both'
 */
async function askInstallScope() {
  if (silentMode) return "both"; // 默认全部安装

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
      label: t.installScopeBothLabel,
      desc: t.installScopeBothDesc,
    },
  ];

  console.log(`${C.bold}${C.dim}?${C.reset} ${t.installScopePrompt}\n`);

  scopes.forEach((scope, i) => {
    const defaultMark =
      scope.id === "both" ? `${C.green}(default)${C.reset} ` : "";
    console.log(
      `    ${C.dim}${i + 1}.${C.reset} ${C.bold}${scope.label}${C.reset} ${defaultMark}`,
    );
    console.log(`        ${C.dim}${scope.desc}${C.reset}`);
  });

  const answer = await ask(t.choose(3));
  const idx = parseInt(answer, 10) - 1;

  // 默认选择 both (idx=2)，无效输入也返回 both
  const selected = idx >= 0 && idx < 3 ? scopes[idx].id : "both";

  const scopeName = {
    project: "project-only",
    global: "global-only",
    both: "both",
  }[selected];

  info(`Selected: ${scopeName}`);
  return selected;
}

// ── Global install guidance ─────────────────────────────

async function ensureGlobalSkillsDir() {
  if (existsSync(SKILLS_DIR)) {
    ok(t.globalDirReady(SKILLS_DIR));
    return true;
  }

  // Improved prompt with better context
  const promptLines = t.globalDirPrompt.split("\n");
  console.log(`
  ${C.bold}${t.globalDirTitle}${C.reset}

  ${promptLines[0]}
  ${C.dim}•${C.reset} ${promptLines[1].split("— ")[1]}
  ${C.dim}•${C.reset} ${promptLines[2].split("— ")[1]}
  ${C.dim}•${C.reset} ${promptLines[3].split("— ")[1]}
`);

  const shouldInstall = await askYesNo(t.globalInstallPrompt, true);
  if (!shouldInstall) {
    skip(t.globalSkipped);
    return false;
  }

  mkdirSync(SKILLS_DIR, { recursive: true });
  ok(t.globalDirCreated(SKILLS_DIR));
  return true;
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

const META_AGENTS = [
  "meta-artisan",
  "meta-conductor",
  "meta-genesis",
  "meta-librarian",
  "meta-prism",
  "meta-scout",
  "meta-sentinel",
  "meta-warden",
];
/** Same nine as scripts/validate-project.mjs (not "everything in readdir") */
const OPENCLAW_WORKSPACE_MD = [
  "BOOT.md",
  "BOOTSTRAP.md",
  "IDENTITY.md",
  "MEMORY.md",
  "USER.md",
  "SOUL.md",
  "AGENTS.md",
  "HEARTBEAT.md",
  "TOOLS.md",
];

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
      const agents = readdirSync(claudeAgentsDir).filter((f) =>
        f.endsWith(".md"),
      );
      if (agents.length === META_AGENTS.length)
        ok(t.syncClaudeAgents(agents.length));
      else {
        warn(t.syncPartial("Claude agents", agents.length, META_AGENTS.length));
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

    const hooksDir = join(PROJECT_DIR, ".claude", "hooks");
    if (existsSync(hooksDir)) {
      const hooks = readdirSync(hooksDir).filter((f) => f.endsWith(".mjs"));
      ok(t.syncClaudeHooks(hooks.length));
    } else {
      fail(t.syncMissing(".claude/hooks/"));
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
    const codexAgentsDir = join(PROJECT_DIR, ".codex", "agents");
    if (existsSync(codexAgentsDir)) {
      const agents = readdirSync(codexAgentsDir).filter((f) =>
        f.endsWith(".toml"),
      );
      if (agents.length === META_AGENTS.length)
        ok(t.syncCodexAgents(agents.length));
      else {
        warn(t.syncPartial("Codex agents", agents.length, META_AGENTS.length));
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
      "meta-theory.md",
    );
    if (existsSync(codexSkillPath)) ok(t.syncCodexSkills);
    else {
      fail(t.syncMissing(".codex/skills/meta-theory.md"));
      allOk = false;
    }
  }

  // --- OpenClaw ---
  if (repoTargets.includes("openclaw")) {
    const ocWorkspaces = join(PROJECT_DIR, "openclaw", "workspaces");
    if (existsSync(ocWorkspaces)) {
      const wsDirs = readdirSync(ocWorkspaces, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      const wsCount = wsDirs.filter((n) => META_AGENTS.includes(n)).length;
      const completeAgents = META_AGENTS.filter((id) =>
        openclawWorkspaceMdComplete(join(ocWorkspaces, id)),
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
            `${META_AGENTS.length} agents, 9 .md each (BOOT … TOOLS)`,
          ),
        );
        allOk = false;
      }
    } else {
      fail(t.syncMissing("openclaw/workspaces/"));
      allOk = false;
    }
  }

  // --- Shared ---
  if (repoTargets.includes("openclaw")) {
    const sharedSkill = join(PROJECT_DIR, "shared-skills", "meta-theory.md");
    if (existsSync(sharedSkill)) ok(t.syncSharedSkills);
    else {
      warn(t.syncMissing("shared-skills/meta-theory.md"));
      allOk = false;
    }
  }

  // --- Cursor ---
  if (repoTargets.includes("cursor")) {
    const cursorAgentsDir = join(PROJECT_DIR, ".cursor", "agents");
    if (existsSync(cursorAgentsDir)) {
      const agents = readdirSync(cursorAgentsDir).filter((f) =>
        f.endsWith(".md"),
      );
      if (agents.length === META_AGENTS.length)
        ok(t.syncCursorAgents(agents.length));
      else {
        warn(t.syncPartial("Cursor agents", agents.length, META_AGENTS.length));
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
  const major = parseInt(nodeVer.split(".")[0], 10);
  if (major >= 18) ok(t.nodeOk(nodeVer));
  else {
    fail(t.nodeOld(nodeVer));
    passed = false;
  }

  const npmVer = run("npm --version");
  if (npmVer) ok(`npm v${npmVer}`);
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
    console.log(`\n  ${C.yellow}⚠ ${t.noRuntime}${C.reset}`);
    console.log(`${C.dim}${t.noRuntimeHint1}${C.reset}`);
    console.log(
      `${C.dim}${fmt(t.noRuntimeHint2, {
        claudeCodeDocs:
          EXTERNAL_URLS.claudeCodeDocs ||
          "https://docs.anthropic.com/en/docs/claude-code",
      })}${C.reset}\n`,
    );
    const proceed = await askYesNo(t.continueAnyway, false);
    if (!proceed) {
      console.log(`\n  ${C.dim}${t.setupCancelled}${C.reset}\n`);
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
    info(`Active runtimes saved from --targets: ${cliTargets.join(", ")}`);
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
  info(`Saved active runtime targets: ${chosenTargets.join(", ")}`);
  return chosenTargets;
}

function runNodeScript(scriptRelative, extraArgs = []) {
  // Automatically pass --lang to child scripts
  const langArgs = currentLangCode ? ["--lang", currentLangCode] : [];
  return spawnSync(
    process.execPath,
    [join(PROJECT_DIR, scriptRelative), ...langArgs, ...extraArgs],
    {
      cwd: PROJECT_DIR,
      stdio: "inherit",
      shell: isWin,
    },
  );
}

// ── Step 3: Auto-configure project files ────────────────

async function autoConfigure(installScope = "project") {
  heading(t.stepConfig);
  const syncResult = runNodeScript("scripts/sync-runtimes.mjs", [
    "--scope",
    installScope,
  ]);
  if (syncResult.status === 0) {
    ok("Repo projections synced from canonical/");
    return true;
  }
  warn("Repo projection sync failed");
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
        rmSync(target, { recursive: true, force: true });
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
    SKILLS.forEach((s) => console.log(`    ${C.dim}•${C.reset} ${s.name}`));
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
  const cmds = ["python3", "python"];
  for (const cmd of cmds) {
    const r = run(`${cmd} --version`);
    if (r) {
      const m = r.match(/Python (\d+)\.(\d+)/);
      if (m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 10))) return cmd;
    }
  }
  return null;
}

async function installPythonTools() {
  heading(t.stepPythonTools);
  const pyCmd = checkPython310();
  if (!pyCmd) {
    warn(t.pythonNotFound);
    info(t.pythonHint);
    return;
  }

  // Check if graphify already installed via pip show (more reliable than --version)
  const pipCmd = pyCmd === "python3" ? "pip3" : "pip";
  const pipShow = run(`${pipCmd} show graphifyy`);
  if (pipShow) {
    const versionMatch = pipShow.match(/Version:\s*(.+)/);
    const version = versionMatch ? versionMatch[1].trim() : "unknown";
    ok(t.graphifyAlreadyInstalled(version));
    return;
  }

  // Install graphify
  info(t.graphifyInstalling);
  const installResult = spawnSync(pipCmd, ["install", "graphifyy"], {
    stdio: "pipe",
    shell: isWin,
  });
  if (installResult.status !== 0) {
    warn(t.graphifyInstallFailed);
    return;
  }
  ok(t.graphifyInstalled);

  // Register Claude skill — use python -m graphify, not bare "graphify" command
  // graphifyy installs a module, not a system PATH command on Windows
  info(t.graphifySkillRegistering);
  const skillResult = spawnSync(
    pyCmd,
    ["-m", "graphify", "claude", "install"],
    {
      stdio: "pipe",
      shell: isWin,
    },
  );
  if (skillResult.status === 0) {
    ok(t.graphifySkillRegistered);
  } else {
    warn(t.graphifySkillFailed);
  }
}

// ── Step 5: Validate + next steps ───────────────────────

async function validate() {
  heading(t.stepValidate);
  const agentsDir = join(PROJECT_DIR, ".claude", "agents");
  if (existsSync(agentsDir)) {
    const agents = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    ok(t.agentPrompts(agents.length));
  }
  const validateResult = spawnSync("node", ["scripts/validate-project.mjs"], {
    cwd: PROJECT_DIR,
    stdio: "inherit",
    shell: isWin,
  });
  if (validateResult.status === 0) ok(t.validationPassed);
  else warn(t.validationWarnings);
}

function showNextSteps(runtimes) {
  console.log("");
  console.log(`${C.bold}${C.green}✓ ${t.setupComplete}${C.reset}`);
  console.log("");
  console.log(`${C.bold}  ${t.howToUse}${C.reset}
`);

  if (runtimes.claude) {
    console.log(`${C.dim}1.${C.reset} ${t.step1Open}
     ${C.dim}cd "${PROJECT_DIR}" && claude${C.reset}

  ${C.dim}2.${C.reset} ${t.step2Try}
     ${C.dim}/meta-theory review my agent definitions${C.reset}

  ${C.dim}3.${C.reset} ${t.step3Or}
     ${C.dim}Build a user authentication system${C.reset}
     ${C.dim}${t.step3Hint}${C.reset}
`);
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

  console.log(`${C.bold}  ${t.usefulCommands}${C.reset}
    ${C.dim}node setup.mjs --update          # ${t.cmdUpdate}${C.reset}
    ${C.dim}node setup.mjs --check           # ${t.cmdCheck}${C.reset}
    ${C.dim}npm run doctor:governance         # ${t.cmdDoctor}${C.reset}
    ${C.dim}npm run verify:all                # ${t.cmdVerify}${C.reset}
`);
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
  console.log(`${frame}  \u2503${blank}\u2503`);
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
    `${C.dim}Mode: ${modeStr} | ${platform()} | Node ${process.versions.node}${C.reset}`,
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
    console.log(`\n  ${C.green}✓ ${t.envOk}${C.reset}\n`);
    const detectedRuntimes = await detectRuntimes();
    const targetContext = await resolveTargetContext(args);
    checkSync(detectedRuntimes, targetContext.supportedTargets);
    console.log(
      `${C.dim}activeTargets=${targetContext.activeTargets.join(", ")} supportedTargets=${targetContext.supportedTargets.join(", ")}${C.reset}`,
    );
    const localState = await ensureProfileState();
    console.log(`${C.bold}  Local state${C.reset}`);
    console.log(
      `    ${C.dim}profile=${localState.profile} key=${localState.metadata.profileKey}${C.reset}`,
    );
    console.log(
      `    ${C.dim}run index: ${toRepoRelative(localState.runIndexPath)}${C.reset}`,
    );
    console.log(
      `    ${C.dim}compaction: ${toRepoRelative(localState.compactionDir)}${C.reset}`,
    );
    console.log(
      `    ${C.dim}dispatch envelope: config/contracts/workflow-contract.json -> protocols.dispatchEnvelopePacket${C.reset}`,
    );
    console.log(
      `    ${C.dim}migration helper: npm run migrate:meta-kim -- <source-dir> --apply${C.reset}\n`,
    );
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

  // Show installation overview
  showInstallOverview(activeTargets, installScope);

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
    await withProgress(
      `Step ${stepNum}: Sync project runtime files`,
      async () => {
        const configResult = await autoConfigure(installScope);
        if (!configResult) {
          warn(t.warnConfigSyncFailed);
        }
        return configResult;
      },
    );
  }

  // 全局安装 (global-only 或 both)
  if (needGlobal) {
    // 准备全局目录
    stepNum++;
    await withProgress(
      `Step ${stepNum}: Prepare global skills directory`,
      async () => {
        const dirReady = existsSync(SKILLS_DIR);
        if (!dirReady) {
          mkdirSync(SKILLS_DIR, { recursive: true });
        }
        ok(t.globalDirReady(SKILLS_DIR));
        return true;
      },
    );

    // 安装全局技能
    stepNum++;
    await withProgress(`Step ${stepNum}: Install global skills`, () => {
      const installResult = runNodeScript(
        "scripts/install-global-skills-all-runtimes.mjs",
        ["--targets", activeTargets.join(",")],
      );
      if (installResult.status !== 0) {
        warn(t.warnSkillsInstallFailed);
      }
      return installResult.status === 0;
    });

    // 同步全局 meta-theory
    stepNum++;
    await withProgress(`Step ${stepNum}: Sync meta-theory to global`, () => {
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
  const wantPython = await askYesNo(t.askPythonToolsUpdate, true);
  if (wantPython) {
    await withProgress(
      `Step ${stepNum}: Install Python graphify tool`,
      async () => {
        await installPythonTools();
      },
    );
  } else {
    skip(`${C.dim}${t.pythonToolsSkipped}${C.reset}`);
    stepNum--; // don't count skipped steps
  }

  // 验证：project-only 和 both 检查 repo-local；global-only 跳过 repo-local 检查
  stepNum++;
  await withProgress(`Step ${stepNum}: Validate installation`, async () => {
    if (needProject) {
      const { supportedTargets } = await resolveTargetContext(args);
      checkSync(runtimes, supportedTargets);
    }
    await validate();
  });

  console.log(`\n  ${C.bold}${C.green}✓ ${t.installComplete}${C.reset}\n`);
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
  const wantPython = await askYesNo(t.askPythonToolsUpdate, true);
  if (wantPython) {
    await installPythonTools();
  } else {
    skip(`${C.dim}${t.pythonToolsSkipped}${C.reset}`);
  }

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
  const wantGlobalSkills = await askYesNo(t.askGlobalSkillsUpdate, true);
  if (wantGlobalSkills) {
    const updateInstallResult = runNodeScript(
      "scripts/install-global-skills-all-runtimes.mjs",
      ["--update", "--targets", activeTargets.join(",")],
    );
    if (updateInstallResult.status === 0) ok(t.updateSkillsDone);
    else warn(t.warnSkillsUpdateFailed);
  } else {
    skip(`${C.dim}${t.globalSkillsSkipped}${C.reset}`);
  }

  // ── 5. [Optional] Global meta-theory sync ──────────────────────────
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
  console.log(`\n  ${C.bold}${C.green}✓ ${t.updateComplete}${C.reset}\n`);
}

async function runCheck() {
  console.log(`\n  ${C.green}✓ ${t.envOk}${C.reset}\n`);
  const runtimes = await detectRuntimes();
  const targetContext = await resolveTargetContext(args);
  checkSync(runtimes, targetContext.supportedTargets);
  console.log(
    `${C.dim}activeTargets=${targetContext.activeTargets.join(", ")} supportedTargets=${targetContext.supportedTargets.join(", ")}${C.reset}`,
  );
}

main().catch((err) => {
  console.error(`\n${C.red}  ${t.setupError} ${err.message}${C.reset}\n`);
  process.exit(1);
});
