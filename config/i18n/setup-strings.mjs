export const PROJECT_BOOTSTRAP_CHOICE_COPY = {
  en: {
    readyHeader: "Project ready", readyQuestion: "Meta_Kim project bootstrap is current. No project-specific files or repeated confirmation are needed.", continueLabel: "Continue",
    bootstrapHeader: "Project bootstrap", runtimeRequirement: "Claude Code must use AskUserQuestion and Codex must use request_user_input before --apply. Compatibility runtimes may show a labeled chat decision card.",
    understanding: (targets) => `AI understanding: this directory needs Meta_Kim project-specific context, config, state, or confirmed overrides for ${targets}.`,
    additions: (status, reason) => `AI additions: dry-run status is ${status}; ${reason}`,
    route: "Capability route: reuse global runtime capabilities first, then apply only confirmed project-specific state.",
    candidates: (conflicts, pending, conflictCount, globalCount) => `Candidate paths: ${conflicts ? "resolve conflicts, inspect only, or skip" : "apply now, inspect only, or skip"}. Pending project writes: ${pending}; conflicts: ${conflictCount}; global writes: ${globalCount}.`,
    apply: "Apply project bootstrap (Recommended)", applyBlocked: "Apply after resolving conflicts", inspect: "Inspect only", skip: "Skip project-local writes",
    continueExpected: "Continue without project-specific writes.", continueAdvantage: "Avoids repeated prompts and leaves the project unchanged.", continueRisk: "No current risk.", continueVerify: "Dry-run reports ready and zero writes.",
    applyExpected: "Write confirmed project-specific files and the bootstrap manifest.", applyAdvantage: "Current files will not require repeated confirmation.", applyRisk: "Only dry-run-listed files are changed after ownership and backup checks.", applyBlockedRisk: "Conflicts remain blocked; unknown user files are preserved.", applyVerify: "A second dry-run must report ready and zero pending writes.",
    inspectExpected: "Keep the dry-run plan without writing.", inspectAdvantage: "Lets the owner review generated content first.", inspectRisk: "Project-specific state may remain stale.", inspectVerify: "The manifest is unchanged and the next run may ask again.",
    skipExpected: "Continue without project-specific files.", skipAdvantage: "Leaves a global-capability-only project untouched.", skipRisk: "Project overrides and state remain disabled.", skipVerify: "The run must not claim project-governed readiness.",
  },
  "zh-CN": {
    readyHeader: "项目已就绪", readyQuestion: "Meta_Kim 项目初始化已是最新，无需写入项目专用文件或重复确认。", continueLabel: "继续",
    bootstrapHeader: "项目初始化", runtimeRequirement: "Claude Code 必须在 --apply 前使用 AskUserQuestion，Codex 必须使用 request_user_input；兼容运行时可展示带标签的聊天决策卡。",
    understanding: (targets) => `AI 理解：此目录需要面向 ${targets} 的 Meta_Kim 项目专用上下文、配置、状态或已确认覆盖。`,
    additions: (status, reason) => `AI 补充：dry-run 状态为 ${status}；${reason}`,
    route: "能力路径：优先复用全局运行时能力，只应用已确认的项目专用状态。",
    candidates: (conflicts, pending, conflictCount, globalCount) => `候选路径：${conflicts ? "解决冲突、仅检查或跳过" : "立即应用、仅检查或跳过"}。待写项目文件：${pending}；冲突：${conflictCount}；全局写入：${globalCount}。`,
    apply: "应用项目初始化（推荐）", applyBlocked: "解决冲突后应用", inspect: "仅检查", skip: "跳过项目级写入",
    continueExpected: "继续运行，不写项目专用文件。", continueAdvantage: "避免重复询问并保持项目不变。", continueRisk: "当前无风险。", continueVerify: "dry-run 显示已就绪且写入为零。",
    applyExpected: "写入已确认的项目专用文件和初始化清单。", applyAdvantage: "文件未变化时不再重复确认。", applyRisk: "仅在所有权和备份校验后修改 dry-run 清单中的文件。", applyBlockedRisk: "冲突保持阻断，未知用户文件会被保留。", applyVerify: "再次 dry-run 必须显示已就绪且待写为零。",
    inspectExpected: "保留 dry-run 计划，不写文件。", inspectAdvantage: "可先检查生成内容。", inspectRisk: "项目专用状态可能仍然陈旧。", inspectVerify: "清单不变，下次运行可能再次询问。",
    skipExpected: "继续运行但不应用项目专用文件。", skipAdvantage: "保持只使用全局能力的项目不变。", skipRisk: "项目覆盖和状态不会启用。", skipVerify: "不得声称项目治理已就绪。",
  },
  "ja-JP": {
    readyHeader: "プロジェクト準備完了", readyQuestion: "Meta_Kim のプロジェクト初期化は最新です。専用ファイルの書き込みや再確認は不要です。", continueLabel: "続行",
    bootstrapHeader: "プロジェクト初期化", runtimeRequirement: "--apply の前に Claude Code は AskUserQuestion、Codex は request_user_input を使用する必要があります。互換 runtime はラベル付き決定カードを表示できます。",
    understanding: (targets) => `AI の理解: このディレクトリには ${targets} 向けの Meta_Kim 固有 context、config、state、または確認済み override が必要です。`,
    additions: (status, reason) => `AI の補足: dry-run の状態は ${status}；${reason}`,
    route: "能力ルート: global runtime 能力を優先し、確認済みのプロジェクト固有状態だけを適用します。",
    candidates: (conflicts, pending, conflictCount, globalCount) => `候補: ${conflicts ? "競合解決、確認のみ、またはスキップ" : "今すぐ適用、確認のみ、またはスキップ"}。書き込み予定: ${pending}；競合: ${conflictCount}；global 書き込み: ${globalCount}。`,
    apply: "プロジェクト初期化を適用（推奨）", applyBlocked: "競合解決後に適用", inspect: "確認のみ", skip: "プロジェクト書き込みをスキップ",
    continueExpected: "固有ファイルを書かず続行します。", continueAdvantage: "再確認を避け、プロジェクトを変更しません。", continueRisk: "現在のリスクはありません。", continueVerify: "dry-run は ready、書き込み 0 を示します。",
    applyExpected: "確認済みの固有ファイルと manifest を書き込みます。", applyAdvantage: "変更がなければ再確認は不要です。", applyRisk: "所有権と backup 検証後、dry-run の一覧だけを変更します。", applyBlockedRisk: "競合はブロックされ、不明なユーザーファイルは保持されます。", applyVerify: "再 dry-run は ready、保留 0 である必要があります。",
    inspectExpected: "書き込まず dry-run 計画を保持します。", inspectAdvantage: "生成内容を先に確認できます。", inspectRisk: "固有状態が古いままの可能性があります。", inspectVerify: "manifest は変わらず、次回再確認される場合があります。",
    skipExpected: "固有ファイルを適用せず続行します。", skipAdvantage: "global 能力だけのプロジェクトを変更しません。", skipRisk: "固有 override と state は無効のままです。", skipVerify: "project-governed ready を主張してはいけません。",
  },
  "ko-KR": {
    readyHeader: "프로젝트 준비 완료", readyQuestion: "Meta_Kim 프로젝트 초기화가 최신입니다. 전용 파일 쓰기나 반복 확인이 필요하지 않습니다.", continueLabel: "계속",
    bootstrapHeader: "프로젝트 초기화", runtimeRequirement: "--apply 전에 Claude Code는 AskUserQuestion, Codex는 request_user_input을 사용해야 합니다. 호환 runtime은 라벨이 있는 결정 카드를 표시할 수 있습니다.",
    understanding: (targets) => `AI 이해: 이 디렉터리에는 ${targets}용 Meta_Kim 프로젝트 전용 context, config, state 또는 확인된 override가 필요합니다.`,
    additions: (status, reason) => `AI 보충: dry-run 상태는 ${status}; ${reason}`,
    route: "능력 경로: 전역 runtime 능력을 먼저 재사용하고 확인된 프로젝트 전용 상태만 적용합니다.",
    candidates: (conflicts, pending, conflictCount, globalCount) => `후보 경로: ${conflicts ? "충돌 해결, 확인만 또는 건너뛰기" : "지금 적용, 확인만 또는 건너뛰기"}. 예정 쓰기: ${pending}; 충돌: ${conflictCount}; 전역 쓰기: ${globalCount}.`,
    apply: "프로젝트 초기화 적용(권장)", applyBlocked: "충돌 해결 후 적용", inspect: "확인만", skip: "프로젝트 쓰기 건너뛰기",
    continueExpected: "전용 파일을 쓰지 않고 계속합니다.", continueAdvantage: "반복 확인을 피하고 프로젝트를 변경하지 않습니다.", continueRisk: "현재 위험이 없습니다.", continueVerify: "dry-run이 ready와 쓰기 0을 표시합니다.",
    applyExpected: "확인된 전용 파일과 manifest를 씁니다.", applyAdvantage: "변경이 없으면 다시 확인하지 않습니다.", applyRisk: "소유권과 backup 검증 후 dry-run 목록만 변경합니다.", applyBlockedRisk: "충돌은 차단되고 알 수 없는 사용자 파일은 보존됩니다.", applyVerify: "다시 실행한 dry-run은 ready와 대기 0이어야 합니다.",
    inspectExpected: "쓰지 않고 dry-run 계획만 유지합니다.", inspectAdvantage: "생성 내용을 먼저 검토할 수 있습니다.", inspectRisk: "전용 상태가 오래된 채로 남을 수 있습니다.", inspectVerify: "manifest는 바뀌지 않으며 다음 실행에서 다시 물을 수 있습니다.",
    skipExpected: "전용 파일을 적용하지 않고 계속합니다.", skipAdvantage: "전역 능력만 쓰는 프로젝트를 변경하지 않습니다.", skipRisk: "전용 override와 state는 비활성 상태입니다.", skipVerify: "project-governed ready를 주장하면 안 됩니다.",
  },
};

export function buildI18N({ MIN_NODE_VERSION }) {
  return {
  en: {
    modeCheck: "check only",
    modeUpdate: "update",
    modeSilent: "silent",
    modeInteractive: "interactive",
    checkOverallFailed: "Project runtime sync check failed.",
    checkRepairCommand:
      "Repair: run `npm run meta:sync`, then run the check again.",
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
    selectedRuntimeCapabilityHeading: "Selected runtime capability summary:",
    selectedRuntimeCapabilities: {
      codex: "Codex: agents, skills, commands, MCP, and version-dependent project/global hooks",
      cursor: "Cursor: agents, skills, MCP, rules, and official preToolUse hooks",
      openclaw: "OpenClaw: workspaces, skills, hooks, and declarative governance; tool blocking still requires a typed plugin adapter",
    },
    selectedRuntimeCapabilityBoundary:
      "Capabilities vary by runtime; this report lists only what was selected and synchronized.",
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
1. Network timeout → Run: npm run meta:sync
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
    cmdDiscover: "Scan global capabilities (agents/skills)",
    // Post-install notes
    postInstallNotesHeading: "Post-install notes:",
    postInstallNotesIntro:
      "After installation, here is what is available and how each layer activates:",
    capabilityGateNotice:
      "Capability gate: progressive. Task results drive the scoped fuse; elapsed days do not trigger blocking. META_KIM_CAPABILITY_GATE=block enables the strict advisory gate.",
    globalHooksOptInNotice:
      "Global hooks are opt-in: run node setup.mjs --with-global-hooks when you want Meta_Kim to update Claude/Codex/Cursor hook wiring.",
    postInstallNotesPlatformSync: "Platform capability sync:",
    platformClaudeCode: "Claude Code",
    platformClaudeCodeCap: "agents + skills + hooks",
    platformCodex: "Codex",
    platformCodexCap: "agents + skills + commands + MCP + hooks (version-dependent)",
    platformOpenClaw: "OpenClaw",
    platformOpenClawCap: "workspace + skills + hooks + declarative governance",
    platformCursor: "Cursor",
    platformCursorCap: "agents + skills + rules + MCP + preToolUse hooks",
    postInstallNotesLayerActivation: "Three-layer memory activation:",
    layer1Label: "Layer 1 (Memory)",
    layer1Note: "automatic — built into Claude Code",
    layer2Label: "Layer 2 (Graphify)",
    layer2Note: "automatic after graphify install (pip install graphifyy)",
    layer3Label: "Layer 3 (SQL / MCP Memory Service)",
    layer3Note:
      "requires server startup: memory server --http (then http://localhost:8000)",
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
    inquirerUnavailableFallback:
      "@inquirer/prompts is not installed yet; using numbered prompts. Run npm install to restore arrow-key prompts.",
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
    installScopePrompt:
      "Install global reusable capabilities or update project directories?",
    installScopeProject:
      "Project directories — explicit project runtime update",
    installScopeGlobal:
      "Global — reusable agents, commands, MCP, and skills where the runtime supports them",
    installScopeProjectLabel: "Project directory updates",
    installScopeGlobalLabel: "Global capabilities (recommended)",
    installScopeProjectDesc:
      "Batch update selected project directories; skips reusable global capability install.",
    installScopeProjectDescDetail: `Updates the project directories you choose:
• Project context/config — managed AGENTS.md/CLAUDE.md blocks and add-only MCP/settings merges
• Project runtime projection — target-selected agents, commands, hooks, MCP, skills, rules/workspaces when project-level material is explicitly selected
• Project overrides — project-dedicated variants stay local when this project needs custom behavior
• graphify-out/ — Knowledge graph (reduces hallucination, speeds queries)
• .meta-kim/state/ and .meta-kim/backups/ — Runtime state, manifest, cache, backup, and rollback`,
    installScopeGlobalDesc:
      "Install reusable runtime capabilities; project-local files are created only for customization.",
    installScopeGlobalDescDetail: `Creates global-level features:
• Agents / commands / MCP / skills — installed into each selected runtime's official global/home locations when supported
• Global hook wiring is opt-in: pass --with-global-hooks when you want Meta_Kim to update runtime hook settings
• Project directories reuse these capabilities directly unless a project-specific extension is proven
• Other projects get discovery/dry-run first; local files are written only after customization/bootstrap confirmation`,
    askProjectRedundantCleanup:
      "Clean up redundant Meta_Kim project-level assets in selected project directories?\nGlobal capabilities will be installed into each runtime's global directory.\nCleanup only removes manifest-proven Meta_Kim-generated agents, skills, Commands, hooks, and empty folders.",
    projectCleanupAsk: "Project directories to clean",
    projectCleanupProtectionNote:
      "Cleanup-only mode: removes Meta_Kim-generated project-level runtime assets proven by manifest; preserves user files, credentials, and merged config.",
    projectCleanupHookConfigStripped: (files) =>
      `Removed Meta_Kim project hook references from merged config: ${files.join(", ")}`,
    projectCleanupBatchHeading: (n) =>
      `Cleaning redundant Meta_Kim project-level assets in ${n} project directory/directories`,
    projectCleanupSummary: "Project cleanup summary",
    projectCleanupCliResult: (passed) =>
      `Meta_Kim project cleanup: ${passed ? "complete" : "failed"}`,
    projectCleanupCliTargets: (targets) => `targets=${targets}`,
    projectCleanupCliProjects: (count) => `cleanedProjects=${count}`,
    // Directory structure explanation
    directoryExplanationHeading: "Directory Structure",
    directoryExplanationIntro: "Meta_Kim creates two levels of directories:",
    directoryExplanationProject: "Project-level (in this repo):",
    directoryExplanationProjectDetail: `• graphify-out/ — Knowledge graph built from your code
  Reduces AI hallucination by grounding queries in actual codebase structure

• .meta-kim/state/ — Runtime cache and session recovery
  Stores run history, compacts sessions, enables cross-session recovery

• .claude/.codex/.cursor/openclaw/ — Tool-specific project context/config/overrides
  Reusable agents, commands, MCP, and skills stay global unless the project needs a custom variant; hooks are explicit opt-in`,
    directoryExplanationGlobal: "Global-level (in home directory):",
    directoryExplanationGlobalDetail: `• ~/.claude/skills/ — Skills shared across ALL projects
  Install once, discover everywhere. Project files are written only for confirmed customization/state.

• ~/%tool%/skills/ — Tool-specific skills
  Claude: ~/.claude/skills/
  Codex: ~/.codex/skills/
  Cursor: ~/.cursor/skills/
  OpenClaw: ~/.openclaw/skills/`,
    directoryExplanationExisting: "For existing projects:",
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
    syncClaudeAgents: (n, total) => `Claude Code agents: ${n}/${total} .md files`,
    syncClaudeSkills: "Claude Code skills/meta-theory/SKILL.md",
    syncClaudeHooks: (n) => `Claude Code hooks: ${n} scripts`,
    syncClaudeProjectHooksMigrated:
      "Claude Code project hooks migrated to global hooks; repo-local .claude/hooks is not required",
    syncClaudeSettings: "Claude Code .claude/settings.json",
    syncClaudeMcp: "Claude Code .mcp.json",
    syncCodexAgents: (n, total) =>
      `Codex agents: ${n}/${total} .toml files`,
    syncCodexSkills: "Codex .agents/skills/meta-theory/SKILL.md",
    syncCodexSkillsGlobal:
      "Codex project skill mirror: .agents/skills/meta-theory/SKILL.md",
    syncOpenclawWorkspaces: (n, total) =>
      `OpenClaw workspaces: ${n}/${total} agents — each folder has the 9 required .md files (BOOT, SOUL, …)`,
    syncOpenclawSkill: "OpenClaw shared meta-theory",
    syncSharedSkills: "Shared skills/meta-theory/SKILL.md",
    syncCursorAgents: (n, total) => `Cursor agents: ${n}/${total} .md files`,
    syncCursorSkills: "Cursor skills/meta-theory/SKILL.md",
    syncCursorMcp: "Cursor .cursor/mcp.json",
    mcpRuntimeProjectOnly: (p) =>
      `${p} contains meta-kim-runtime, but its script path is not usable here. This MCP is only for the Meta_Kim source repo; remove the meta-kim-runtime block in copied projects. Agents still load from .claude/.codex/.cursor/openclaw files.`,
    syncOk: "All sync targets verified",
    syncMissing: (p) => `Missing: ${p}`,
    syncGlobalOnlyHookPairOk: (runtime) =>
      `${runtime} project hook pair: activator + project-root resolver`,
    syncGlobalOnlyHookPairFailed: (runtime, detail) =>
      `${runtime} project hook pair is incomplete: ${detail}`,
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
    graphifySkillSkippedGuideExists: (p) =>
      `graphify ${p} install skipped (guide already has Graphify section)`,
    graphifyCodeGraphGenerated: "graphify code graph generated",
    graphifyCodeGraphGenerationFailed:
      "graphify code graph generation failed (non-blocking)",
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
    graphifyHooksRepaired: (n, project, backup) =>
      `Repaired ${n} unsafe Graphify hook command(s) in ${project} (backup: ${backup})`,
    graphifyProjectWiringSkipped:
      "Graphify is installed globally. Run `npm run meta:graphify:rebuild` (or `python -m graphify update .`) inside a project to build its knowledge graph.",
    stepMcpMemory: "Meta_Kim cross-session memory",
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
      "Enable Meta_Kim cross-session memory? This uses MCP Memory Service; setup installs it if missing, registers it, and starts it in the background.",
    mcpMemorySkipped: "MCP Memory Service skipped",
    mcpMemoryRequiresGlobalHooks:
      "MCP Memory Service skipped: rerun with --with-global-hooks so shared runtime hooks are installed first",
    mcpMemoryServerStartHint:
      "MCP Memory Service installed — HTTP service starts with: MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http",
    mcpMemoryHookInstalling: (targets) =>
      `Installing MCP Memory hooks for ${targets}...`,
    mcpMemoryHookInstalled: "MCP Memory runtime hooks installed",
    mcpMemoryHookWarnings:
      "Hook installation reported warnings (non-blocking) — underlying stderr shown below:",
    mcpMemoryEndpointSelected: (endpoint) => `MCP Memory endpoint: ${endpoint}`,
    mcpMemoryEndpointInvalid: (reason) => `Invalid MCP Memory endpoint configuration: ${reason}`,
    mcpMemoryRemoteEndpointNoAutoStart: (endpoint) =>
      `Using external MCP Memory endpoint ${endpoint}; local process and boot auto-start were not configured.`,
    mcpMemoryAutoStarting: "Starting MCP Memory Service (HTTP, background)...",
    mcpMemoryAutoStarted: (endpoint) => `MCP Memory Service running at ${endpoint}`,
    mcpMemoryAutoStartUnverified:
      "MCP Memory Service process is running; continuing",
    mcpMemoryAutoStartFailed: "Auto-start failed — start manually:",
    mcpMemoryAutoStartManual:
      "  MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http",
    mcpMemoryAutoStartBoot: "Boot auto-start configured",
    mcpMemoryAutoStartBootFailed:
      "MCP Memory Service is healthy, but boot auto-start could not be configured",
    mcpMemoryAutoStartFailureTitle: "Meta_Kim MCP Memory Service",
    mcpMemoryAutoStartFailureMessage: (healthUrl) =>
      `Meta_Kim MCP Memory Service failed to start or did not become healthy at ${healthUrl}. Cross-session memory may be unavailable. Please start it manually: MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http`,
    updateHeading: "Update Mode",
    updateNpm: "Reinstalling npm dependencies...",
    updateSkills: "Updating all skills...",
    updateSyncProjectFiles:
      "Syncing tool configs in this repo from canonical/...",
    updateSyncDone: "Sync complete",
    updateSyncSkip: "Sync skipped or failed",
    updateReGlobal: "Re-select global skills directory?",
    askReselectRuntimes: "Re-select AI coding tools for this machine?",
    askPythonToolsUpdate: "Install Python graphify (code knowledge graph)?",
    pythonToolsSkipped: "Python tools skipped",
    askGlobalSkillsUpdate: "Update global skills? (optional)",
    updateSkillsDone: "Global skills updated",
    globalSkillsSkipped: "Global skills skipped",
    askMetaTheoryUpdate:
      "Sync the Meta_Kim global governance layer to the selected runtimes for reuse across projects? Includes agents, skills, MCP, and Commands; global hooks require --with-global-hooks. Supported items are checked automatically. (recommended)",
    updateMetaTheoryDone: "Meta_Kim global capabilities synced",
    metaTheorySkipped: "Meta_Kim global capability sync skipped",
    globalHooksMigrationHeading:
      "Self-host hook migration check (~/.claude/hooks/meta-kim/)",
    globalHooksMigrationFound: (n) =>
      `Found ${n} Meta_Kim-managed hook file(s) that no longer match the canonical whitelist.`,
    globalHooksMigrationListed: (files) =>
      `Files to remove:\n${files.map((f) => `  - ${f}`).join("\n")}`,
    globalHooksMigrationKept: (files) =>
      `User-authored files (kept):\n${files.map((f) => `  - ${f}`).join("\n")}`,
    globalHooksMigrationConfirm: (n) =>
      `Delete ${n} Meta_Kim-managed hook file(s) and back them up? (y/N)`,
    globalHooksMigrationBackedUp: (dir) => `Backed up to: ${dir}`,
    globalHooksMigrationDone: (n) =>
      `Removed ${n} Meta_Kim-managed hook file(s); will be re-installed by the global sync step.`,
    globalHooksMigrationSkipped:
      "Skipped by user; global hooks re-install may fail until you remove them manually.",
    globalHooksMigrationNoChange:
      "Global hooks dir is clean; no migration needed.",
    projectHooksMigrationHeading: (platform) =>
      `[${platform}] Removing Meta_Kim-managed project-level hook files`,
    projectHooksMigrationRemoved: (platform, count, dir) =>
      `[${platform}] Removed ${count} Meta_Kim-managed file(s) from ${dir}`,
    projectHooksMigrationKept: (platform, files) =>
      `[${platform}] User-authored hook files (kept): ${
        files.length > 0 ? files.join(", ") : "(none)"
      }`,
    projectHooksMigrationNoChange: (platform, dir) =>
      `[${platform}] ${dir} is clean; no Meta_Kim files to remove.`,
    projectAssetsCleanupIntro:
      "Meta_Kim is moving reusable capabilities to global runtime directories; project directories keep explicit project projections, project-specific overrides, state, and cache.",
    projectAssetsCleanupScope:
      "Cleanup only removes project-level capability assets proven by the project-bootstrap manifest to be Meta_Kim-generated and no longer managed. User files, credentials, and merged config files are preserved.",
    projectAssetsRetargetCleanupIntro:
      "Project runtime targets changed; Meta_Kim is pruning old project-level assets from targets that are not selected this time.",
    projectAssetsRetargetCleanupScope:
      "This project update removes only manifest-proven Meta_Kim-generated assets that are outside the current target selection. User files, credentials, and merged config files are preserved.",
    projectAssetsCleanupRemoved: (count, rows) =>
      `Removed ${count} stale project-level asset(s) and pruned empty directories:\n${rows.map((row) => `  - ${row}`).join("\n")}`,
    projectAssetsCleanupAllClean:
      "All capability types clean (agents/skills/commands/capability-index/hooks): 0 removed",
    projectAssetsCleanupSkipped: (count) =>
      `Skipped ${count} manifest entry/entries that were not safe to remove.`,
    updateComplete: "Update complete!",
    // Installation overview strings
    installOverviewTitle: "Meta_Kim Installation Overview",
    installOverviewWill: "This process will:",
    installOverviewSyncConfig:
      "Sync configurations to project directory (canonical → .claude/.codex/openclaw/.cursor/)",
    installOverviewInstallSkills:
      "Install selected global skill repositories (~/.claude/skills/)",
    installOverviewSyncMeta: "Sync Meta_Kim reusable capabilities to global runtime directories",
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
    progressSyncMeta: "Sync Meta_Kim global capabilities",
    refreshGlobalCapabilityInventory:
      "Refreshing Meta_Kim global capability inventory...",
    globalCapabilityInventoryRefreshed:
      "Meta_Kim global capability inventory refreshed",
    globalCapabilityInventoryFailed:
      "Global capability discovery failed; run `npm run discover:global` after setup/update.",
    progressValidate: "Validate installation",
    // Confirm strings
    confirmStartInstall: "Start installation?",
    projectBootstrapConfirmationReasons: {
      ready: "Project bootstrap manifest and project-specific files are current; no project write is needed.",
      conflict: "Existing project files overlap generated paths but ownership is unproven; resolve conflicts before apply.",
      stale: "The existing project bootstrap manifest uses a different Meta_Kim version.",
      target_scope_changed: "Selected runtime targets differ from the previous project bootstrap manifest.",
      missing: "Required project context, config, state, or confirmed overrides are missing.",
      repair_required: "The bootstrap version is current, but managed files need repair, merge, or recreation.",
      ready_with_existing_config: "Existing configuration still needs confirmed bootstrap state or pending changes.",
    },
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

→ Fix: Run: node scripts/sync-runtimes.mjs --scope project
`,
    warnSkillsInstallFailed: `
⚠ Global skills install failed

Primary cause: use the first exact error printed above. Apply the guidance below only when the log explicitly shows the matching condition:
1. If the log contains EBUSY or "resource busy" → Close Explorer/IDE on the skills folder and wait for antivirus/indexing to finish. After the path is released, only consider removing the exact temporary path Meta_Kim reported for this failed run; first confirm it is inside the selected runtime's skills/plugins root and is not user-owned. Never delete temporary directories by wildcard.
2. If the log reports a network or Git fetch error → Check the connection and proxy settings with: node setup.mjs --prompt-proxy
3. If the log says the repository was not found → Verify the skill repository URL is correct

→ Next step: Fix the first exact error, then retry: node setup.mjs --update
`,
    warnMetaTheorySyncFailed: `
⚠ meta-theory sync failed

Primary cause: use the first exact error printed above. Apply the guidance below only when the log explicitly shows the matching condition:
1. If the log reports EBUSY or a locked directory → Close programs holding the selected runtime's Meta_Kim skills/plugins directory
2. If the log reports permission denied → Check write permissions on that selected runtime directory
3. If the log reports a network error → Verify the connection and proxy settings

→ Next step: Fix the first exact error, then retry the selected runtimes: node setup.mjs --update
`,
    warnSkillsUpdateFailed: `
⚠ Global skills update failed

Primary cause: use the first exact error printed above. Apply the guidance below only when the log explicitly shows the matching condition:
1. If the log contains EBUSY or "resource busy" → Close Explorer/IDE on the skills folder and wait for antivirus/indexing to finish. After the path is released, only consider removing the exact temporary path Meta_Kim reported for this failed run; first confirm it is inside the selected runtime's skills/plugins root and is not user-owned. Never delete temporary directories by wildcard.
2. If the log reports a Git fetch or network error → Check the connection and proxy settings
3. If the log reports a file conflict → Review the staged files and resolve the conflict manually

→ Next step: Fix the first exact error, then retry: node setup.mjs --update
`,
    warnSkillsUpdateFailedHint:
      "If the log shows EBUSY or 'resource busy', close Explorer/IDE on the skills folder and wait for antivirus/indexing to finish. Only consider removing the exact temporary path Meta_Kim reported for this failed run after confirming it is inside the selected runtime's skills/plugins root and is not user-owned; never delete by wildcard.",
    warnMetaTheoryUpdateFailed: `
⚠ meta-theory sync failed

Primary cause: use the first exact error printed above. Apply the guidance below only when the log explicitly shows the matching condition:
1. If the log reports EBUSY or a locked directory → Close programs holding the selected runtime's Meta_Kim skills/plugins directory
2. If the log reports permission denied → Check write permissions on that selected runtime directory
3. If the log reports a network error → Verify the connection and proxy settings

→ Next step: Fix the first exact error, then retry the selected runtimes: node setup.mjs --update
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
    progressInstallPython: "Install Python graphify tool",
    progressInstallMcpMemory: "Configure Meta_Kim cross-session memory (optional)",
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
    npxQuickDirPrompt: "Where should I prepare the project directory?",
    npxQuickDirDefault: "~/Desktop/Meta_Kim",
    npxQuickCreating: "Preparing project directory:",
    npxQuickCopyFiles: "Copying project-level runtime files",
    npxQuickDirExists: "Directory already exists; files inside will be updated",
    npxQuickDone: "Project-level files ready!",
    npxQuickPostCopyScript:
      "Project graph/state outputs are generated in that project by the global Meta_Kim initializer.",
    npxQuickOpenIn: "Open your platform in this directory:",
    npxQuickAskDeploy:
      "Export project-level runtime files to another directory? You can copy that directory into existing projects.",
    npxQuickDeployYes: "Select directory",
    npxQuickDeployNo: "Skip",
    projectDeployDirPrompt: "Project directories:",
    projectDeployAsk: "Project directory updates",
    projectDeployProtectionNote:
      "Existing local settings and MCP/hook configs are preserved and merged; only selected directories are touched.",
    globalManagedProjectRefreshInfo: (n) =>
      `Detected ${n} managed project${n === 1 ? "" : "s"}. This operation refreshes the global installation and those existing projects with each project's saved runtime targets, using merge/delta updates. It creates no new project projection and never overwrites runtime-sedimented or user-owned files.`,
    managedProjectRejectedHeading: (n) => `${n} existing project target${n === 1 ? " was" : "s were"} not refreshed:`,
    managedProjectRejectedDetail: (source, reason) => `Source: ${source}. Reason: ${reason}.`,
    managedProjectRejectedRepair: "Repair or remove the listed saved/registry target, or run project bootstrap explicitly to recreate a valid manifest, then retry.",
    managedProjectRejectedStep: "Validate explicit existing project targets",
    managedProjectRejectedSources: { explicit_project_dirs: "explicit --project-dir", saved_project_dirs: "saved project list", project_registry: "user-level project registry", current_working_directory: "current working directory" },
    managedProjectRejectedReasons: { target_missing: "directory does not exist", unsafe_project_root: "project root is not a safe real directory", unsafe_manifest_path: "manifest path crosses a symlink or Junction", manifest_missing_or_invalid: "managed project manifest is missing or invalid", invalid_active_targets: "saved runtime targets are missing or unsupported" },
    projectDeployInteractiveHint:
      "Set up a saved project list once, then update every saved project together on future runs.",
    projectDeployPathEntryHint:
      "Enter all project roots in one line, separated by semicolons or commas. Example: D:/Project/a; D:/Project/b",
    projectDeploySavedPathHint: (path) =>
      `Saved in ${path}; next time choose the saved-directory option or run with --all-projects.`,
    projectDeployCliSaveHint:
      "Add --save-project-dirs to remember these CLI targets, then use --all-projects next time.",
    projectDeploySavedListHeading: (n) => `Saved project directories (${n}):`,
    projectDeployParsedTargets: (n) =>
      `Read ${n} project director${n === 1 ? "y" : "ies"}:`,
    projectDeployNoDirsEntered: "No project directories entered; skipping project export.",
    projectDeployConfirmSaveAndUpdate: (n) =>
      `Save and update ${n} project director${n === 1 ? "y" : "ies"}?`,
    projectDeployConfirmUpdateOnce: (n) =>
      `Update ${n} project director${n === 1 ? "y" : "ies"} for this run?`,
    projectDeployUseSaved: (n) => `Update all saved project directories (${n})`,
    projectDeploySelectOnce: "Update a one-time project directory list",
    projectDeploySelectAndRemember:
      "Add or change saved project directories, then update them",
    projectCleanupUseSaved: (n) =>
      `Clean redundant Meta_Kim assets from all saved project directories (${n})`,
    projectCleanupSelectOnce:
      "Clean redundant Meta_Kim assets from a one-time project directory list",
    projectCleanupSelectAndRemember:
      "Add or change saved project directories, then clean redundant Meta_Kim assets",
    projectDeployCliTargets: (n) =>
      `Using ${n} project directory target(s) from CLI`,
    projectDeploySavedTargets: (n) =>
      `Saved ${n} project directory target(s) for future updates`,
    projectDeployNoSaved:
      "No saved project directories found; skipping project export.",
    projectDeployBatchHeading: (n) =>
      `Updating project-level runtime files in ${n} project director${n === 1 ? "y" : "ies"}`,
    projectDeploySummary: "Project directory update summary",
    projectDeployStatusOk: "updated",
    projectDeployStatusPartial: "partially cleaned — retry required",
    projectDeployStatusBlocked: "blocked — fix path safety and retry",
    projectDeployStatusFailed: "failed",
    projectDeployFailed: (dir, msg) => `Failed to update ${dir}: ${msg}`,
    projectDeployMoreTargets: (n) =>
      `Also updated ${n} more project director${n === 1 ? "y" : "ies"}.`,
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
    checkOverallFailed: "项目运行时同步检查未通过。",
    checkRepairCommand: "修复方法：运行 `npm run meta:sync`，然后重新检查。",
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
    selectedRuntimeCapabilityHeading: "已选 runtime 能力摘要：",
    selectedRuntimeCapabilities: {
      codex: "Codex：agents、skills、Commands、MCP，以及取决于版本的项目/全局 hooks",
      cursor: "Cursor：agents、skills、rules、MCP 和官方 preToolUse hooks",
      openclaw: "OpenClaw：workspaces、skills、hooks 和声明式治理；工具阻断仍需 typed plugin adapter",
    },
    selectedRuntimeCapabilityBoundary:
      "各 runtime 能力不同；本报告只展示实际选中并同步的能力。",
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
1. 网络超时 → 运行：npm run meta:sync
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
    cmdDiscover: "扫描全局能力（agents/skills）",
    // 安装后注意事项
    postInstallNotesHeading: "安装后注意事项：",
    postInstallNotesIntro: "安装完成后，各层能力的使用方式如下：",
    capabilityGateNotice:
      "能力检查默认 progressive：依据任务结果局部熔断，不按天数自动阻断。META_KIM_CAPABILITY_GATE=block 可启用严格检查。",
    globalHooksOptInNotice:
      "全局 hooks 默认不改写：需要 Meta_Kim 更新 Claude/Codex/Cursor hook 配置时，请显式运行 node setup.mjs --with-global-hooks。",
    postInstallNotesPlatformSync: "各平台能力同步情况：",
    platformClaudeCode: "Claude Code",
    platformClaudeCodeCap: "agents + skills + hooks",
    platformCodex: "Codex",
    platformCodexCap: "agents + skills + Commands + MCP + hooks（取决于版本）",
    platformOpenClaw: "OpenClaw",
    platformOpenClawCap: "workspace + skills + hooks + 声明式治理",
    platformCursor: "Cursor",
    platformCursorCap: "agents + skills + rules + MCP + preToolUse hooks",
    postInstallNotesLayerActivation: "三层记忆激活方式：",
    layer1Label: "第一层（Memory）",
    layer1Note: "自动激活——内置于 Claude Code",
    layer2Label: "第二层（Graphify）",
    layer2Note: "安装 graphifyy 后自动激活（pip install graphifyy）",
    layer3Label: "第三层（SQL / MCP Memory Service）",
    layer3Note:
      "需手动启动服务器：memory server --http（然后访问 http://localhost:8000）",
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
    inquirerUnavailableFallback:
      "@inquirer/prompts 尚未安装，已退回数字菜单。安装完成后运行 npm install 可恢复方向键菜单。",
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
    installScopePrompt: "安装全局通用能力，还是批量更新项目目录？",
    installScopeProject:
      "当前项目 — 仅项目专用定制",
    installScopeGlobal:
      "全局 — 按各 runtime 支持安装 agents、Commands、MCP、skills 等通用能力",
    installScopeProjectLabel: "批量项目更新",
    installScopeGlobalLabel: "全局通用能力（推荐）",
    installScopeProjectDesc: "进入批量项目目录更新；不安装全局通用能力。",
    installScopeProjectDescDetail: `选择要更新的项目目录：
• 会进入项目目录选择/保存目录流程
• 使用 merge 更新项目上下文/配置/状态
• 只在项目确实需要定制时保留项目级 agents、Commands、hooks、MCP 或 skills
• 不安装或更新全局通用能力`,
    installScopeGlobalDesc:
      "自动安装/更新全局通用能力；可选清理项目内冗余资产。",
    installScopeGlobalDescDetail: `创建全局级功能：
• agents / Commands / MCP / skills — 在所选 runtime 支持的官方全局/用户目录中安装
• 全局 hooks 需要显式传入 --with-global-hooks，才会更新 runtime hook 配置
• 安装后会询问是否清理项目内冗余 Meta_Kim 项目级资产
• 清理只删除 manifest 能证明由 Meta_Kim 生成的旧项目级文件，并清空空目录`,
    askProjectRedundantCleanup:
      "是否帮助清理项目内冗余的 Meta_Kim 项目级资产？\n全局通用能力会安装到各 runtime 的全局目录。\n清理只会删除 manifest 能证明由 Meta_Kim 生成的旧 agents、skills、Commands、hooks 等，并清空空目录。",
    projectCleanupAsk: "选择要清理的项目目录",
    projectCleanupProtectionNote:
      "仅清理模式：只删除 manifest 能证明由 Meta_Kim 生成的项目级运行时资产；保留用户文件、凭据和配置 merge 文件。",
    projectCleanupHookConfigStripped: (files) =>
      `已从 merge 配置移除 Meta_Kim 项目级 hook 引用：${files.join("、")}`,
    projectCleanupBatchHeading: (n) =>
      `正在清理 ${n} 个项目目录内冗余的 Meta_Kim 项目级资产`,
    projectCleanupSummary: "项目目录清理结果",
    projectCleanupCliResult: (passed) =>
      `Meta_Kim 项目清理：${passed ? "完成" : "失败"}`,
    projectCleanupCliTargets: (targets) => `目标运行时=${targets}`,
    projectCleanupCliProjects: (count) => `已处理项目数=${count}`,
    // 目录结构说明
    directoryExplanationHeading: "目录结构",
    directoryExplanationIntro: "Meta_Kim 创建两级目录：",
    directoryExplanationProject: "项目级（本仓库内）：",
    directoryExplanationProjectDetail: `• graphify-out/ — 从代码构建的知识图谱
  通过实际代码结构 grounding 查询，减少 AI 幻觉

• .meta-kim/state/ — 运行缓存与会话恢复
  存储运行历史、压缩会话、支持跨会话恢复

• .claude/.codex/.cursor/openclaw/ — 各工具的项目上下文/配置/覆盖层
  可复用 agents、Commands、MCP、skills 默认留在全局；hooks 需要显式 opt-in，除非项目需要定制版本`,
    directoryExplanationGlobal: "全局级（用户目录内）：",
    directoryExplanationGlobalDetail: `• ~/.claude/skills/ — 所有项目共享的技能
  一次安装，处处可发现。项目文件只在确认需要定制/状态记录时写入。

• ~/%tool%/skills/ — 各工具专用技能
  Claude: ~/.claude/skills/
  Codex: ~/.codex/skills/
  Cursor: ~/.cursor/skills/
  OpenClaw: ~/.openclaw/skills/`,
    directoryExplanationExisting: "现有项目使用方式：",
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
    syncClaudeAgents: (n, total) => `Claude Code 智能体: ${n}/${total} .md 文件`,
    syncClaudeSkills: "Claude Code 技能/meta-theory/SKILL.md",
    syncClaudeHooks: (n) => `Claude Code 钩子: ${n} 个脚本`,
    syncClaudeProjectHooksMigrated:
      "Claude Code 项目级 hooks 已迁移到全局；不再要求仓库内 .claude/hooks",
    syncClaudeSettings: "Claude Code .claude/settings.json",
    syncClaudeMcp: "Claude Code .mcp.json",
    syncCodexAgents: (n, total) =>
      `Codex 智能体: ${n}/${total} .toml 文件`,
    syncCodexSkills: "Codex .agents/skills/meta-theory/SKILL.md",
    syncCodexSkillsGlobal:
      "Codex 项目技能镜像：.agents/skills/meta-theory/SKILL.md",
    syncOpenclawWorkspaces: (n, total) =>
      `OpenClaw 工作区：${n}/${total} 个智能体，各目录 9 个必备 Markdown 已齐（含 BOOT、SOUL 等；不含子文件夹里的额外文件）`,
    syncOpenclawSkill: "OpenClaw 共享 meta-theory",
    syncSharedSkills: "共享技能/meta-theory/SKILL.md",
    syncCursorAgents: (n, total) => `Cursor 智能体: ${n}/${total} .md 文件`,
    syncCursorSkills: "Cursor 技能/meta-theory/SKILL.md",
    syncCursorMcp: "Cursor .cursor/mcp.json",
    mcpRuntimeProjectOnly: (p) =>
      `${p} 包含 meta-kim-runtime，但这里的脚本路径不可用。这个 MCP 只给 Meta_Kim 源仓库使用；复制到普通项目时请删除 meta-kim-runtime 这一块。Agent 仍会从 .claude/.codex/.cursor/openclaw 文件加载。`,
    syncOk: "所有同步目标验证通过",
    syncMissing: (p) => `缺失：${p}`,
    syncGlobalOnlyHookPairOk: (runtime) =>
      `${runtime} 项目 Hook 依赖完整：activator + project-root resolver`,
    syncGlobalOnlyHookPairFailed: (runtime, detail) =>
      `${runtime} 项目 Hook 依赖不完整：${detail}`,
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
    graphifySkillSkippedGuideExists: (p) =>
      `跳过 graphify ${p} install（指南中已有 Graphify 章节）`,
    graphifyCodeGraphGenerated: "graphify 代码图谱已生成",
    graphifyCodeGraphGenerationFailed:
      "graphify 代码图谱生成失败（不影响其他功能）",
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
    graphifyHooksRepaired: (n, project, backup) =>
      `已修复 ${project} 中 ${n} 个不安全的 Graphify hook 命令（备份：${backup}）`,
    graphifyProjectWiringSkipped:
      "Graphify 已全局安装。在项目目录内跑 `npm run meta:graphify:rebuild`（或 `python -m graphify update .`）生成该项目的知识图谱。",
    stepMcpMemory: "Meta_Kim 跨会话记忆",
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
      "启用 Meta_Kim 跨会话记忆？会使用 MCP Memory Service；若未安装则安装，并完成注册和后台启动。",
    mcpMemorySkipped: "MCP Memory Service 已跳过",
    mcpMemoryRequiresGlobalHooks:
      "MCP Memory Service 已跳过：请使用 --with-global-hooks 重新运行，先安装共享运行时 Hook",
    mcpMemoryServerStartHint:
      "MCP Memory Service 已安装——HTTP 服务启动方式：MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http",
    mcpMemoryHookInstalling: (targets) =>
      `正在安装 ${targets} 的 MCP Memory 钩子...`,
    mcpMemoryHookInstalled: "MCP Memory 运行时钩子已安装",
    mcpMemoryHookWarnings:
      "钩子安装产生警告（不影响后续流程）——以下是子进程 stderr 原文：",
    mcpMemoryEndpointSelected: (endpoint) => `MCP Memory 端点：${endpoint}`,
    mcpMemoryEndpointInvalid: (reason) => `MCP Memory 端点配置无效：${reason}`,
    mcpMemoryRemoteEndpointNoAutoStart: (endpoint) =>
      `使用外部 MCP Memory 端点 ${endpoint}；未启动本地进程，也未配置开机自启。`,
    mcpMemoryAutoStarting: "正在启动 MCP Memory Service（HTTP 后台模式）...",
    mcpMemoryAutoStarted: (endpoint) => `MCP Memory Service 已运行于 ${endpoint}`,
    mcpMemoryAutoStartUnverified:
      "MCP Memory Service 进程正在运行，继续安装",
    mcpMemoryAutoStartFailed: "自动启动失败——请手动启动：",
    mcpMemoryAutoStartManual:
      "  MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http",
    mcpMemoryAutoStartBoot: "已配置开机自启",
    mcpMemoryAutoStartBootFailed:
      "MCP Memory Service 当前健康，但未能配置开机自启",
    mcpMemoryAutoStartFailureTitle: "Meta_Kim MCP Memory Service",
    mcpMemoryAutoStartFailureMessage: (healthUrl) =>
      `Meta_Kim MCP Memory Service 启动失败，或未在 ${healthUrl} 变为 healthy。跨会话记忆可能不可用。请手动启动：MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http`,
    updateHeading: "更新模式",
    updateNpm: "正在重新安装 npm 依赖...",
    updateSkills: "正在更新所有技能...",
    updateSyncProjectFiles: "正在从 canonical/ 同步本仓库内的工具配置...",
    updateSyncDone: "同步完成",
    updateSyncSkip: "未同步或同步失败",
    updateReGlobal: "是否重新选择全局技能目录？",
    askReselectRuntimes: "重新选择这台电脑的 AI 编程工具？",
    askPythonToolsUpdate: "安装 Python graphify（代码知识图谱）？",
    pythonToolsSkipped: "Python 工具已跳过",
    askGlobalSkillsUpdate: "更新全局技能？（可选）",
    updateSkillsDone: "全局技能已更新",
    globalSkillsSkipped: "全局技能已跳过",
    askMetaTheoryUpdate:
      "把 Meta_Kim 全局治理层同步到已选平台，供各项目复用？包含 agents、skills、MCP、Commands；全局 hooks 需要 --with-global-hooks。实际支持项会自动检查后同步。（推荐）",
    updateMetaTheoryDone: "Meta_Kim 全局能力已同步",
    metaTheorySkipped: "Meta_Kim 全局能力同步已跳过",
    globalHooksMigrationHeading:
      "自托管 hook 迁移检查（~/.claude/hooks/meta-kim/）",
    globalHooksMigrationFound: (n) =>
      `发现 ${n} 个不再匹配 canonical 白名单的 Meta_Kim 管理 hook 文件。`,
    globalHooksMigrationListed: (files) =>
      `将删除的文件：\n${files.map((f) => `  - ${f}`).join("\n")}`,
    globalHooksMigrationKept: (files) =>
      `用户自建文件（保留）：\n${files.map((f) => `  - ${f}`).join("\n")}`,
    globalHooksMigrationConfirm: (n) =>
      `删除 ${n} 个 Meta_Kim 管理 hook 文件并备份？(y/N)`,
    globalHooksMigrationBackedUp: (dir) => `已备份到：${dir}`,
    globalHooksMigrationDone: (n) =>
      `已删除 ${n} 个 Meta_Kim 管理 hook 文件；全局 sync 步骤会重新安装。`,
    globalHooksMigrationSkipped:
      "用户已跳过；全局 hooks 重装可能失败，请手动删除。",
    globalHooksMigrationNoChange:
      "全局 hooks 目录干净，无需迁移。",
    projectHooksMigrationHeading: (platform) =>
      `[${platform}] 正在删除 Meta_Kim 项目级 hook 文件`,
    projectHooksMigrationRemoved: (platform, count, dir) =>
      `[${platform}] 已删除 ${count} 个 Meta_Kim 文件：${dir}`,
    projectHooksMigrationKept: (platform, files) =>
      `[${platform}] 用户自建 hook 文件（保留）：${
        files.length > 0 ? files.join("、") : "（无）"
      }`,
    projectHooksMigrationNoChange: (platform, dir) =>
      `[${platform}] ${dir} 干净，无需处理。`,
    projectAssetsCleanupIntro:
      "Meta_Kim 正转为全局通用能力：项目级保留显式项目投影、本项目定制内容、状态和缓存。",
    projectAssetsCleanupScope:
      "本次只清理 project-bootstrap manifest 能证明由 Meta_Kim 生成、且当前计划不再管理的项目级能力资产；用户文件、凭据和配置 merge 文件会保留。",
    projectAssetsRetargetCleanupIntro:
      "项目级目标已按本次选择重新计算：正在移除上次 manifest 中属于未选平台的旧 Meta_Kim 项目资产。",
    projectAssetsRetargetCleanupScope:
      "这是项目目录更新的一部分，只清理 manifest 能证明由 Meta_Kim 生成、且不属于本次目标选择的项目级资产；用户文件、凭据和配置 merge 文件会保留。",
    projectAssetsCleanupRemoved: (count, rows) =>
      `已清理 ${count} 个旧项目级资产，并清空空目录：\n${rows.map((row) => `  - ${row}`).join("\n")}`,
    projectAssetsCleanupAllClean:
      "全类型干净（agents/skills/commands/capability-index/hooks）：删除 0",
    projectAssetsCleanupSkipped: (count) =>
      `有 ${count} 条 manifest 记录不满足安全删除条件，已跳过。`,
    updateComplete: "更新完成！",
    // 安装概览字符串
    installOverviewTitle: "Meta_Kim 安装概览",
    installOverviewWill: "此过程将：",
    installOverviewSyncConfig:
      "同步配置文件 (canonical → .claude/.codex/openclaw/.cursor/)",
    installOverviewInstallSkills: "安装所选全局技能仓库（~/.claude/skills/）",
    installOverviewSyncMeta: "同步 Meta_Kim 可复用能力到全局目录",
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
    progressSyncMeta: "同步 Meta_Kim 全局能力",
    refreshGlobalCapabilityInventory:
      "正在刷新 Meta_Kim 全局能力清单...",
    globalCapabilityInventoryRefreshed:
      "Meta_Kim 全局能力清单已刷新",
    globalCapabilityInventoryFailed:
      "全局能力发现失败；请在安装/更新后运行 `npm run discover:global`。",
    progressValidate: "验证安装",
    // 确认字符串
    confirmStartInstall: "开始安装？",
    projectBootstrapConfirmationReasons: {
      ready: "项目初始化清单和项目专用文件均为最新，无需写入。",
      conflict: "现有项目文件与生成路径重叠，但所有权未经证明；应用前必须先解决冲突。",
      stale: "现有项目初始化清单使用了不同的 Meta_Kim 版本。",
      target_scope_changed: "所选运行时目标与上次项目初始化清单不同。",
      missing: "缺少必需的项目上下文、配置、状态或已确认覆盖。",
      repair_required: "初始化版本为最新，但受管文件需要修复、合并或重建。",
      ready_with_existing_config: "现有配置仍需确认初始化状态或应用待处理变更。",
    },
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

修复：node scripts/sync-runtimes.mjs --scope project
`,
    warnSkillsInstallFailed: `
⚠ 全局技能安装失败

主要原因：以上方第一条精确错误为准。仅当日志明确出现对应情况时，再使用下面的处理方法：
1. 若日志含 EBUSY 或“目录被占用” → 关闭占用 skills 目录的资源管理器/IDE，等待杀毒与索引结束；目录释放后，只考虑处理 Meta_Kim 在本次失败日志中明确报告的那个临时路径，并先确认它位于当前所选运行时的 skills/plugins 根目录内且不属于用户资产；不要使用通配符删除临时目录
2. 若日志明确提示网络错误或 Git fetch 失败 → 检查网络连接，并运行 node setup.mjs --prompt-proxy 检查代理设置
3. 若日志提示仓库未找到 → 验证技能仓库 URL 是否正确

下一步：先修复上方第一条精确错误，再重试：node setup.mjs --update
`,
    warnMetaTheorySyncFailed: `
⚠ meta-theory 同步失败

主要原因：以上方第一条精确错误为准。仅当日志明确出现对应情况时，再使用下面的处理方法：
1. 若日志提示 EBUSY 或目录被锁定 → 关闭占用当前所选运行时 Meta_Kim skills/plugins 目录的程序
2. 若日志提示权限被拒绝 → 检查该所选运行时目录的写入权限
3. 若日志提示网络错误 → 检查网络连接与代理设置

下一步：先修复上方第一条精确错误，再重试当前所选运行时：node setup.mjs --update
`,
    warnSkillsUpdateFailed: `
⚠ 全局技能更新失败

主要原因：以上方第一条精确错误为准。仅当日志明确出现对应情况时，再使用下面的处理方法：
1. 若日志含 EBUSY 或“目录被占用” → 关闭占用 skills 目录的资源管理器/IDE，等待杀毒与索引结束；目录释放后，只考虑处理 Meta_Kim 在本次失败日志中明确报告的那个临时路径，并先确认它位于当前所选运行时的 skills/plugins 根目录内且不属于用户资产；不要使用通配符删除临时目录
2. 若日志明确提示 Git fetch 或网络错误 → 检查网络连接与代理设置
3. 若日志明确提示文件冲突 → 查看 staged 文件并手动解决冲突

下一步：先修复上方第一条精确错误，再重试：node setup.mjs --update
`,
    warnSkillsUpdateFailedHint:
      "若日志含 EBUSY/目录被占用：请先关闭占用该目录的资源管理器窗口与 IDE 监视，并等待杀毒/索引结束。仅在确认 Meta_Kim 本次失败日志报告的那个临时路径位于当前所选运行时的 skills/plugins 根目录内且不属于用户资产后，才考虑处理该精确路径；不要使用通配符删除。",
    warnMetaTheoryUpdateFailed: `
⚠ meta-theory 同步失败

主要原因：以上方第一条精确错误为准。仅当日志明确出现对应情况时，再使用下面的处理方法：
1. 若日志提示 EBUSY 或目录被锁定 → 关闭占用当前所选运行时 Meta_Kim skills/plugins 目录的程序
2. 若日志提示权限被拒绝 → 检查该所选运行时目录的写入权限
3. 若日志提示网络错误 → 检查网络连接与代理设置

下一步：先修复上方第一条精确错误，再重试当前所选运行时：node setup.mjs --update
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
    progressInstallPython: "安装 Python graphify 工具",
    progressInstallMcpMemory: "配置 Meta_Kim 跨会话记忆（可选）",
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
    npxQuickDirPrompt: "项目级目录放在哪里？",
    npxQuickDirDefault: "~/Desktop/Meta_Kim",
    npxQuickCreating: "正在准备项目级目录：",
    npxQuickCopyFiles: "正在复制项目级运行时文件",
    npxQuickDirExists: "目录已存在，将更新其中的文件",
    npxQuickDone: "项目级文件已就绪！",
    npxQuickPostCopyScript:
      "项目 graph/state 结果由全局 Meta_Kim 初始化器在该项目目录内生成。",
    npxQuickOpenIn: "在该目录打开你的平台：",
    npxQuickAskDeploy: "是否将项目级运行时文件导出到另一个目录？可把该目录复制到现有项目中。",
    npxQuickDeployYes: "选择目录",
    npxQuickDeployNo: "跳过",
    projectDeployDirPrompt: "项目目录：",
    projectDeployAsk: "项目目录更新",
    projectDeployProtectionNote:
      "已有本地 settings、MCP 和 hook 配置会保留并合并；只会更新你选择的目录。",
    globalManagedProjectRefreshInfo: (n) =>
      `检测到 ${n} 个已受管项目。本次会同时刷新全局安装和这些现有项目，并按每个项目已保存的运行时目标执行合并/增量更新；不会新建项目投影，也不会覆盖项目沉淀能力或用户文件。`,
    managedProjectRejectedHeading: (n) => `有 ${n} 个既有项目目标未刷新：`,
    managedProjectRejectedDetail: (source, reason) => `来源：${source}。原因：${reason}。`,
    managedProjectRejectedRepair: "请修复或移除上述已保存/registry 目标，或显式运行项目 bootstrap 重建有效 manifest，然后重试。",
    managedProjectRejectedStep: "验证显式既有项目目标",
    managedProjectRejectedSources: { explicit_project_dirs: "显式 --project-dir", saved_project_dirs: "已保存项目列表", project_registry: "用户级项目 registry", current_working_directory: "当前工作目录" },
    managedProjectRejectedReasons: { target_missing: "目录不存在", unsafe_project_root: "项目根目录不是安全的真实目录", unsafe_manifest_path: "manifest 路径经过 symlink 或 Junction", manifest_missing_or_invalid: "受管项目 manifest 缺失或无效", invalid_active_targets: "已保存的运行时目标为空或不受支持" },
    projectDeployInteractiveHint:
      "先配置一次常用项目目录，后续更新时可一次更新所有已保存项目。",
    projectDeployPathEntryHint:
      "请在一行里输入所有项目根目录，多个目录用分号或逗号隔开。示例：D:/Project/a; D:/Project/b",
    projectDeploySavedPathHint: (path) =>
      `已保存到 ${path}；下次可选择已保存目录，或用 --all-projects 一次更新。`,
    projectDeployCliSaveHint:
      "加上 --save-project-dirs 可记住这些命令行目录，下次用 --all-projects 复用。",
    projectDeploySavedListHeading: (n) => `已保存的项目目录（${n} 个）：`,
    projectDeployParsedTargets: (n) => `已读取 ${n} 个项目目录：`,
    projectDeployNoDirsEntered: "没有输入项目目录，跳过项目级导出。",
    projectDeployConfirmSaveAndUpdate: (n) => `保存并立即更新这 ${n} 个项目目录？`,
    projectDeployConfirmUpdateOnce: (n) => `仅本次更新这 ${n} 个项目目录？`,
    projectDeployUseSaved: (n) => `更新全部已保存项目目录（${n} 个）`,
    projectDeploySelectOnce: "仅本次更新指定项目目录",
    projectDeploySelectAndRemember: "添加或修改已保存项目目录，并立即更新",
    projectCleanupUseSaved: (n) =>
      `清理全部已保存项目目录中的冗余 Meta_Kim 资产（${n} 个）`,
    projectCleanupSelectOnce: "仅本次清理指定项目目录",
    projectCleanupSelectAndRemember:
      "添加或修改已保存项目目录，并立即清理冗余 Meta_Kim 资产",
    projectDeployCliTargets: (n) => `使用命令行传入的 ${n} 个项目目录`,
    projectDeploySavedTargets: (n) => `已保存 ${n} 个项目目录，后续更新可复用`,
    projectDeployNoSaved: "没有已保存的项目目录，跳过项目级导出。",
    projectDeployBatchHeading: (n) => `正在更新 ${n} 个项目目录的项目级运行时文件`,
    projectDeploySummary: "项目目录更新结果",
    projectDeployStatusOk: "已更新",
    projectDeployStatusPartial: "部分完成，需要重试",
    projectDeployStatusBlocked: "已阻断，请修复路径安全问题后重试",
    projectDeployStatusFailed: "失败",
    projectDeployFailed: (dir, msg) => `更新 ${dir} 失败：${msg}`,
    projectDeployMoreTargets: (n) => `另外 ${n} 个项目目录也已更新。`,
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
    checkOverallFailed: "プロジェクト runtime の同期チェックに失敗しました。",
    checkRepairCommand:
      "修復: `npm run meta:sync` を実行してから、もう一度チェックしてください。",
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
    selectedRuntimeCapabilityHeading: "選択した runtime の機能概要:",
    selectedRuntimeCapabilities: {
      codex: "Codex: agents、skills、commands、MCP、バージョン依存の project/global hooks",
      cursor: "Cursor: agents、skills、rules、MCP、公式 preToolUse hooks",
      openclaw: "OpenClaw: workspaces、skills、hooks、宣言的ガバナンス。ツールブロックには typed plugin adapter が必要",
    },
    selectedRuntimeCapabilityBoundary:
      "runtime ごとに機能は異なります。本レポートは実際に選択・同期した機能のみ表示します。",
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
1. ネットワークタイムアウト → 実行：npm run meta:sync
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
    cmdDiscover: "グローバル機能をスキャン（agents/skills）",
    // インストール後の注意事項
    postInstallNotesHeading: "インストール後の注意事項：",
    postInstallNotesIntro: "インストール完了後、各層の使い方は以下の通りです：",
    capabilityGateNotice:
      "能力チェックの既定値は progressive です。経過日数ではなく、タスクの結果に応じて対象だけを停止します。META_KIM_CAPABILITY_GATE=block で厳格モードを選べます。",
    globalHooksOptInNotice:
      "グローバル hooks は既定では変更しません。Meta_Kim で Claude/Codex/Cursor の hook 設定を更新する場合は node setup.mjs --with-global-hooks を明示してください。",
    postInstallNotesPlatformSync: "各プラットフォームの同期状況：",
    platformClaudeCode: "Claude Code",
    platformClaudeCodeCap: "agents + skills + hooks",
    platformCodex: "Codex",
    platformCodexCap: "agents + skills + commands + MCP + hooks (バージョン依存)",
    platformOpenClaw: "OpenClaw",
    platformOpenClawCap: "workspace + skills + hooks + 宣言的ガバナンス",
    platformCursor: "Cursor",
    platformCursorCap: "agents + skills + rules + MCP + preToolUse hooks",
    postInstallNotesLayerActivation: "3層メモリの有効化方法：",
    layer1Label: "第1層（Memory）",
    layer1Note: "自動有効 — Claude Code に組み込み済み",
    layer2Label: "第2層（Graphify）",
    layer2Note: "graphifyy インストール後は自動有効（pip install graphifyy）",
    layer3Label: "第3層（SQL / MCP Memory Service）",
    layer3Note:
      "サーバー手動起動が必要：memory server --http（次に http://localhost:8000 にアクセス）",
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
    inquirerUnavailableFallback:
      "@inquirer/prompts が未インストールのため番号メニューに切り替えます。npm install 後は矢印キーメニューを使えます。",
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
    installScopePrompt: "再利用グローバル能力をインストールしますか、プロジェクトディレクトリを一括更新しますか？",
    installScopeProject:
      "プロジェクトディレクトリ — 明示的なプロジェクト runtime 更新",
    installScopeGlobal:
      "グローバル — runtime が対応する agents、Commands、MCP、skills の再利用能力",
    installScopeProjectLabel: "プロジェクトディレクトリ更新",
    installScopeGlobalLabel: "グローバル能力（推奨）",
    installScopeProjectDesc:
      "選択したプロジェクトディレクトリを一括更新。再利用グローバル能力はインストールしない。",
    installScopeProjectDescDetail: `選択したプロジェクトディレクトリを更新：
• Project context/config — AGENTS.md/CLAUDE.md managed block と MCP/settings の add-only merge
• Project runtime projection — 明示選択した target の agents、Commands、hooks、MCP、skills、rules/workspaces
• Project overrides — プロジェクト専用カスタムが必要な場合はローカルに保持
• graphify-out/ — 知識グラフ（幻覚低減、クエリ高速化）
• .meta-kim/state/ と .meta-kim/backups/ — state、manifest、cache、backup、rollback`,
    installScopeGlobalDesc:
      "再利用 runtime 能力をインストール。プロジェクトローカルファイルはカスタム時のみ作成。",
    installScopeGlobalDescDetail: `グローバルレベル機能を作成：
• agents / Commands / MCP / skills — 選択 runtime の公式グローバル/ユーザー場所へインストール
• グローバル hooks は --with-global-hooks を明示した場合だけ runtime hook 設定を更新
• 各プロジェクトは、専用拡張が証明されない限りグローバル能力を直接再利用
• 他プロジェクトはまず discovery/dry-run；カスタム/bootstrap 確認後のみローカルファイルを書く`,
    askProjectRedundantCleanup:
      "プロジェクト内の冗長な Meta_Kim プロジェクトレベル資産を整理しますか？\nグローバル能力は runtime のグローバルディレクトリに置かれます。\nmanifest で Meta_Kim 生成と確認できる古い agents、skills、Commands、hooks などと空ディレクトリだけを削除します。",
    projectCleanupAsk: "整理するプロジェクトディレクトリ",
    projectCleanupProtectionNote:
      "整理専用モード：manifest で Meta_Kim 生成と確認できるプロジェクトレベル runtime 資産だけを削除します。ユーザーファイル、認証情報、merge 対象設定は保持します。",
    projectCleanupHookConfigStripped: (files) =>
      `merge config から Meta_Kim プロジェクト hook 参照を削除しました：${files.join("、")}`,
    projectCleanupBatchHeading: (n) =>
      `${n} 個のプロジェクトディレクトリで冗長な Meta_Kim プロジェクトレベル資産を整理中`,
    projectCleanupSummary: "プロジェクトディレクトリ整理結果",
    projectCleanupCliResult: (passed) =>
      `Meta_Kim プロジェクト整理：${passed ? "完了" : "失敗"}`,
    projectCleanupCliTargets: (targets) => `対象 runtime=${targets}`,
    projectCleanupCliProjects: (count) => `処理済みプロジェクト数=${count}`,
    // ディレクトリ構造説明
    directoryExplanationHeading: "ディレクトリ構造",
    directoryExplanationIntro: "Meta_Kim は 2 つのレベルのディレクトリを作成：",
    directoryExplanationProject: "プロジェクトレベル（このリポ内）：",
    directoryExplanationProjectDetail: `• graphify-out/ — コードから構築された知識グラフ
  実際のコードベース構造に基づいたクエリで AI 幻覚を低減

• .meta-kim/state/ — 実行キャッシュとセッション回復
  実行履歴、セッション圧縮、クロスセッション回復を保存

• .claude/.codex/.cursor/openclaw/ — 各ツールのプロジェクト context/config/override
  再利用 agents、Commands、MCP、skills は、プロジェクト専用版が必要な場合以外はグローバル；hooks は明示 opt-in`,
    directoryExplanationGlobal: "グローバルレベル（ホームディレクトリ内）：",
    directoryExplanationGlobalDetail: `• ~/.claude/skills/ — 全プロジェクト共有スキル
  一度のインストールでどこでも発見可能。プロジェクトファイルは確認済みカスタム/state の場合のみ書く。

• ~/%tool%/skills/ — 各ツール専用スキル
  Claude: ~/.claude/skills/
  Codex: ~/.codex/skills/
  Cursor: ~/.cursor/skills/
  OpenClaw: ~/.openclaw/skills/`,
    directoryExplanationExisting: "既存プロジェクトの場合：",
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
    syncClaudeAgents: (n, total) => `Claude Code エージェント: ${n}/${total} .md ファイル`,
    syncClaudeSkills: "Claude Code スキル/meta-theory/SKILL.md",
    syncClaudeHooks: (n) => `Claude Code フック: ${n} スクリプト`,
    syncClaudeProjectHooksMigrated:
      "Claude Code プロジェクト hooks はグローバルへ移行済みです。repo 内 .claude/hooks は不要です",
    syncClaudeSettings: "Claude Code .claude/settings.json",
    syncClaudeMcp: "Claude Code .mcp.json",
    syncCodexAgents: (n, total) =>
      `Codex エージェント: ${n}/${total} .toml ファイル`,
    syncCodexSkills: "Codex .agents/skills/meta-theory/SKILL.md",
    syncCodexSkillsGlobal:
      "Codex プロジェクトスキルミラー：.agents/skills/meta-theory/SKILL.md",
    syncOpenclawWorkspaces: (n, total) =>
      `OpenClaw ワークスペース: ${n}/${total} エージェント — 各フォルダに必須の .md 9 件（BOOT、SOUL など）`,
    syncOpenclawSkill: "OpenClaw 共有 meta-theory",
    syncSharedSkills: "共有スキル/meta-theory/SKILL.md",
    syncCursorAgents: (n, total) => `Cursor エージェント: ${n}/${total} .md ファイル`,
    syncCursorSkills: "Cursor スキル/meta-theory/SKILL.md",
    syncCursorMcp: "Cursor .cursor/mcp.json",
    mcpRuntimeProjectOnly: (p) =>
      `${p} に meta-kim-runtime がありますが、この場所ではスクリプトパスを使用できません。この MCP は Meta_Kim ソースリポジトリ専用です。コピー先プロジェクトでは meta-kim-runtime ブロックを削除してください。Agents は .claude/.codex/.cursor/openclaw ファイルから引き続き読み込まれます。`,
    syncOk: "すべての同期ターゲット検証済み",
    syncMissing: (p) => `不足：${p}`,
    syncGlobalOnlyHookPairOk: (runtime) =>
      `${runtime} project Hook ペア：activator + project-root resolver`,
    syncGlobalOnlyHookPairFailed: (runtime, detail) =>
      `${runtime} project Hook ペアが不完全です：${detail}`,
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
    graphifySkillSkippedGuideExists: (p) =>
      `graphify ${p} install をスキップ（ガイドに Graphify セクションが既にあります）`,
    graphifyCodeGraphGenerated: "graphify コードグラフ生成済み",
    graphifyCodeGraphGenerationFailed:
      "graphify コードグラフ生成失敗（非ブロッキング）",
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
    graphifyHooksRepaired: (n, project, backup) =>
      `${project} の安全でない Graphify hook コマンドを ${n} 件修復しました（バックアップ：${backup}）`,
    projectAssetsCleanupAllClean:
      "全タイプ綺麗（agents/skills/commands/capability-index/hooks）：削除 0",
    graphifyProjectWiringSkipped:
      "Graphify はグローバルにインストール済み。プロジェクト内で `npm run meta:graphify:rebuild`（または `python -m graphify update .`）を実行してナレッジグラフを構築してください。",
    stepMcpMemory: "Meta_Kim クロスセッション記憶",
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
      ".mcp.json にはすでに MCP Memory Service があります",
    askMcpMemoryInstall:
      "Meta_Kim のクロスセッション記憶を有効にしますか？MCP Memory Service を使用し、未インストールならインストールして登録・バックグラウンド起動します。",
    mcpMemorySkipped: "MCP Memory Service をスキップしました",
    mcpMemoryRequiresGlobalHooks:
      "MCP Memory Service をスキップしました。共有ランタイム Hook を先に導入するため、--with-global-hooks を付けて再実行してください",
    mcpMemoryServerStartHint:
      "MCP Memory Service がインストールされました——HTTP サービスの起動方法：MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http",
    mcpMemoryHookInstalling: (targets) =>
      `${targets} の MCP Memory フックをインストール中...`,
    mcpMemoryHookInstalled: "MCP Memory ランタイムフックをインストールしました",
    mcpMemoryHookWarnings:
      "フックのインストール中に警告が発生しました（非ブロッキング）——子プロセスの stderr を以下に表示します:",
    mcpMemoryEndpointSelected: (endpoint) => `MCP Memory エンドポイント: ${endpoint}`,
    mcpMemoryEndpointInvalid: (reason) => `MCP Memory エンドポイント設定が無効です: ${reason}`,
    mcpMemoryRemoteEndpointNoAutoStart: (endpoint) =>
      `外部 MCP Memory エンドポイント ${endpoint} を使用します。ローカルプロセスと自動起動は設定しません。`,
    mcpMemoryAutoStarting:
      "MCP Memory Service（HTTP バックグラウンド）を起動中...",
    mcpMemoryAutoStarted: (endpoint) =>
      `MCP Memory Service が ${endpoint} で実行中`,
    mcpMemoryAutoStartUnverified:
      "MCP Memory Service プロセスは実行中です。インストールを続行します",
    mcpMemoryAutoStartFailed: "自動起動に失敗——手動で起動してください：",
    mcpMemoryAutoStartManual:
      "  MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http",
    mcpMemoryAutoStartBoot: "起動時自動開始を設定しました",
    mcpMemoryAutoStartBootFailed:
      "MCP Memory Service は正常ですが、起動時の自動開始を設定できませんでした",
    mcpMemoryAutoStartFailureTitle: "Meta_Kim MCP Memory Service",
    mcpMemoryAutoStartFailureMessage: (healthUrl) =>
      `Meta_Kim MCP Memory Service の起動に失敗したか、${healthUrl} が healthy になりませんでした。クロスセッションメモリが利用できない可能性があります。手動で起動してください: MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http`,
    updateHeading: "アップデートモード",
    updateNpm: "npm依存関係を再インストール中...",
    updateSkills: "すべてのスキルを更新中...",
    updateSyncProjectFiles: "canonical/ からリポ内のツール設定を同期中...",
    updateSyncDone: "同期が完了しました",
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
      "選択した runtime に Meta_Kim グローバル治理レイヤーを同期し、各プロジェクトで再利用しますか？agents、skills、MCP、Commands を含みます。グローバル hooks は --with-global-hooks が必要です。対応項目は自動確認されます。（推奨）",
    updateMetaTheoryDone: "Meta_Kim グローバル能力を同期しました",
    metaTheorySkipped: "Meta_Kim グローバル能力同期をスキップしました",
    globalHooksMigrationHeading:
      "セルフホスト hook 移行チェック（~/.claude/hooks/meta-kim/）",
    globalHooksMigrationFound: (n) =>
      `canonical ホワイトリストに一致しない Meta_Kim 管理 hook ファイルを ${n} 件検出しました。`,
    globalHooksMigrationListed: (files) =>
      `削除対象ファイル：\n${files.map((f) => `  - ${f}`).join("\n")}`,
    globalHooksMigrationKept: (files) =>
      `ユーザー作成ファイル（保持）：\n${files.map((f) => `  - ${f}`).join("\n")}`,
    globalHooksMigrationConfirm: (n) =>
      `${n} 件の Meta_Kim 管理 hook ファイルを削除してバックアップしますか？（y/N）`,
    globalHooksMigrationBackedUp: (dir) => `バックアップ先：${dir}`,
    globalHooksMigrationDone: (n) =>
      `${n} 件の Meta_Kim 管理 hook ファイルを削除しました。グローバル sync ステップで再インストールされます。`,
    globalHooksMigrationSkipped:
      "ユーザーがスキップしました。手動で削除するまでグローバル hooks 再インストールは失敗する可能性があります。",
    globalHooksMigrationNoChange:
      "グローバル hooks ディレクトリは綺麗です。移行は不要です。",
    projectHooksMigrationHeading: (platform) =>
      `[${platform}] Meta_Kim 管理のプロジェクトレベル hook ファイルを削除中`,
    projectHooksMigrationRemoved: (platform, count, dir) =>
      `[${platform}] ${count} 個の Meta_Kim 管理ファイルを削除しました：${dir}`,
    projectHooksMigrationKept: (platform, files) =>
      `[${platform}] ユーザー作成の hook ファイル（保持）：${
        files.length > 0 ? files.join("、") : "（なし）"
      }`,
    projectHooksMigrationNoChange: (platform, dir) =>
      `[${platform}] ${dir} は綺麗です。処理は不要です。`,
    projectAssetsCleanupIntro:
      "Meta_Kim は再利用能力をグローバル runtime ディレクトリへ移行しています。プロジェクト側には明示的な project projection、専用 override、状態、キャッシュを残します。",
    projectAssetsCleanupScope:
      "このクリーンアップは project-bootstrap manifest で Meta_Kim 生成と確認でき、現在の計画で管理されないプロジェクトレベル能力資産だけを削除します。ユーザーファイル、認証情報、merge 対象の設定ファイルは保持します。",
    projectAssetsRetargetCleanupIntro:
      "プロジェクトレベルの対象 runtime が今回の選択に合わせて再計算されました。未選択 runtime の古い Meta_Kim プロジェクト資産を削除しています。",
    projectAssetsRetargetCleanupScope:
      "これはプロジェクトディレクトリ更新の一部です。manifest で Meta_Kim 生成と確認でき、今回の対象選択に含まれない資産だけを削除します。ユーザーファイル、認証情報、merge 対象の設定ファイルは保持します。",
    projectAssetsCleanupRemoved: (count, rows) =>
      `${count} 件の古いプロジェクトレベル資産を削除し、空ディレクトリを整理しました:\n${rows.map((row) => `  - ${row}`).join("\n")}`,
    projectAssetsCleanupSkipped: (count) =>
      `${count} 件の manifest エントリは安全削除条件を満たさないためスキップしました。`,
    updateComplete: "アップデート完了！",
    // インストール概要文字列
    installOverviewTitle: "Meta_Kim インストール概要",
    installOverviewWill: "このプロセスでは：",
    installOverviewSyncConfig:
      "プロジェクトディレクトリに設定を同期 (canonical → .claude/.codex/openclaw/.cursor/)",
    installOverviewInstallSkills:
      "選択したグローバルスキルリポジトリをインストール (~/.claude/skills/)",
    installOverviewSyncMeta: "Meta_Kim 再利用能力をグローバルディレクトリに同期",
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
    progressSyncMeta: "Meta_Kim グローバル能力を同期",
    refreshGlobalCapabilityInventory:
      "Meta_Kim グローバル能力インベントリを更新中...",
    globalCapabilityInventoryRefreshed:
      "Meta_Kim グローバル能力インベントリを更新しました",
    globalCapabilityInventoryFailed:
      "グローバル能力 discovery に失敗しました。setup/update 後に `npm run discover:global` を実行してください。",
    progressValidate: "インストールを検証",
    // 確認文字列
    confirmStartInstall: "インストールを開始しますか？",
    projectBootstrapConfirmationReasons: {
      ready: "初期化 manifest とプロジェクト固有ファイルは最新で、書き込みは不要です。",
      conflict: "既存ファイルが生成パスと重なり、所有権を確認できません。適用前に競合を解決してください。",
      stale: "既存の初期化 manifest は異なる Meta_Kim バージョンを使用しています。",
      target_scope_changed: "選択した runtime 対象が前回の初期化 manifest と異なります。",
      missing: "必要な project context、config、state、または確認済み override が不足しています。",
      repair_required: "初期化バージョンは最新ですが、管理対象ファイルの修復、merge、または再作成が必要です。",
      ready_with_existing_config: "既存 config には確認済み初期化 state または保留変更が必要です。",
    },
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

修正：node scripts/sync-runtimes.mjs --scope project
`,
    warnSkillsInstallFailed: `
⚠ グローバルスキルインストール失敗

主な原因：上に表示された最初の正確なエラーを基準にしてください。ログに該当する状態が明示されている場合に限り、次の対処を行ってください：
1. ログに EBUSY または「resource busy」がある場合 → スキルフォルダを開いているエクスプローラー/IDE を閉じ、ウイルス対策/インデックス処理の完了を待つ。パスの解放後は、Meta_Kim が今回の失敗ログで明示した一時パスだけを処理候補とし、選択中ランタイムの skills/plugins ルート内にあり、ユーザー所有データではないことを先に確認する。ワイルドカードで一時ディレクトリを削除しないでください
2. ログにネットワークエラーまたは Git fetch 失敗がある場合 → 接続を確認し、node setup.mjs --prompt-proxy でプロキシ設定を確認
3. ログにリポジトリ未検出がある場合 → スキルリポジトリの URL が正しいか確認

次の手順：最初の正確なエラーを修正してから再試行：node setup.mjs --update
`,
    warnMetaTheorySyncFailed: `
⚠ meta-theory 同期失敗

主な原因：上に表示された最初の正確なエラーを基準にしてください。ログに該当する状態が明示されている場合に限り、次の対処を行ってください：
1. ログに EBUSY またはディレクトリのロックがある場合 → 選択中ランタイムの Meta_Kim skills/plugins ディレクトリを使用しているプログラムを閉じる
2. ログに権限拒否がある場合 → その選択中ランタイムディレクトリの書き込み権限を確認
3. ログにネットワークエラーがある場合 → 接続とプロキシ設定を確認

次の手順：最初の正確なエラーを修正してから選択中ランタイムを再試行：node setup.mjs --update
`,
    warnSkillsUpdateFailed: `
⚠ グローバルスキル更新失敗

主な原因：上に表示された最初の正確なエラーを基準にしてください。ログに該当する状態が明示されている場合に限り、次の対処を行ってください：
1. ログに EBUSY または「resource busy」がある場合 → スキルフォルダを開いているエクスプローラー/IDE を閉じ、ウイルス対策/インデックス処理の完了を待つ。パスの解放後は、Meta_Kim が今回の失敗ログで明示した一時パスだけを処理候補とし、選択中ランタイムの skills/plugins ルート内にあり、ユーザー所有データではないことを先に確認する。ワイルドカードで一時ディレクトリを削除しないでください
2. ログに Git fetch 失敗またはネットワークエラーがある場合 → 接続とプロキシ設定を確認
3. ログにファイル競合がある場合 → ステージされたファイルを確認し、競合を手動で解決

次の手順：最初の正確なエラーを修正してから再試行：node setup.mjs --update
`,
    warnSkillsUpdateFailedHint:
      "ログに EBUSY 等がある場合: スキルフォルダを開いているエクスプローラー/IDE を閉じ、ウイルス対策/インデックス完了を待つ。Meta_Kim が今回の失敗ログで明示した一時パスが選択中ランタイムの skills/plugins ルート内にあり、ユーザー所有データではないと確認できた場合に限り、その正確なパスだけを処理候補とする。ワイルドカードで削除しないでください。",
    warnMetaTheoryUpdateFailed: `
⚠ meta-theory 同期失敗

主な原因：上に表示された最初の正確なエラーを基準にしてください。ログに該当する状態が明示されている場合に限り、次の対処を行ってください：
1. ログに EBUSY またはディレクトリのロックがある場合 → 選択中ランタイムの Meta_Kim skills/plugins ディレクトリを使用しているプログラムを閉じる
2. ログに権限拒否がある場合 → その選択中ランタイムディレクトリの書き込み権限を確認
3. ログにネットワークエラーがある場合 → 接続とプロキシ設定を確認

次の手順：最初の正確なエラーを修正してから選択中ランタイムを再試行：node setup.mjs --update
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
    progressInstallPython: "Python graphify ツールをインストール",
    progressInstallMcpMemory: "Meta_Kim クロスセッション記憶を設定（任意）",
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
    npxQuickDirPrompt: "プロジェクト用ディレクトリをどこに準備しますか？",
    npxQuickDirDefault: "~/Desktop/Meta_Kim",
    npxQuickCreating: "プロジェクト用ディレクトリを準備中：",
    npxQuickCopyFiles: "プロジェクト用ランタイムファイルをコピー中",
    npxQuickDirExists: "ディレクトリは既に存在します。中のファイルを更新します",
    npxQuickDone: "プロジェクト用ファイルの準備完了！",
    npxQuickPostCopyScript:
      "プロジェクトの graph/state 出力はグローバル Meta_Kim 初期化器がそのプロジェクト内に生成します。",
    npxQuickOpenIn: "このディレクトリでプラットフォームを開く：",
    npxQuickAskDeploy:
      "プロジェクト用ランタイムファイルを別ディレクトリに書き出しますか？そのディレクトリを既存プロジェクトへコピーできます。",
    npxQuickDeployYes: "ディレクトリを選択",
    npxQuickDeployNo: "スキップ",
    projectDeployDirPrompt: "プロジェクトディレクトリ：",
    projectDeployAsk: "プロジェクトディレクトリ更新",
    projectDeployProtectionNote:
      "既存のローカル settings、MCP、hook 設定は保持してマージします。選択したディレクトリだけを更新します。",
    globalManagedProjectRefreshInfo: (n) =>
      `管理済みプロジェクトを ${n} 件検出しました。今回はグローバル環境と既存プロジェクトを、各プロジェクトに保存されたランタイム対象でマージ／差分更新します。新しいプロジェクト投影は作成せず、プロジェクトに定着した機能やユーザーファイルを上書きしません。`,
    managedProjectRejectedHeading: (n) => `${n} 件の既存プロジェクト対象を更新できませんでした：`,
    managedProjectRejectedDetail: (source, reason) => `参照元：${source}。理由：${reason}。`,
    managedProjectRejectedRepair: "表示された保存済み／registry 対象を修復または削除するか、project bootstrap を明示的に実行して有効な manifest を再作成してから再試行してください。",
    managedProjectRejectedStep: "明示された既存プロジェクト対象を検証",
    managedProjectRejectedSources: { explicit_project_dirs: "明示的な --project-dir", saved_project_dirs: "保存済みプロジェクト一覧", project_registry: "ユーザーレベル project registry", current_working_directory: "現在の作業ディレクトリ" },
    managedProjectRejectedReasons: { target_missing: "ディレクトリが存在しません", unsafe_project_root: "プロジェクトルートが安全な実ディレクトリではありません", unsafe_manifest_path: "manifest パスが symlink または Junction を経由しています", manifest_missing_or_invalid: "管理対象プロジェクトの manifest がないか無効です", invalid_active_targets: "保存済みランタイム対象が空か未対応です" },
    projectDeployInteractiveHint:
      "プロジェクトリストを一度保存すると、以後の更新で保存済みプロジェクトをまとめて更新できます。",
    projectDeployPathEntryHint:
      "すべてのプロジェクトルートを 1 行で入力してください。複数のディレクトリはセミコロンまたはカンマで区切ります。例: D:/Project/a; D:/Project/b",
    projectDeploySavedPathHint: (path) =>
      `${path} に保存しました。次回は保存済みディレクトリを選ぶか --all-projects で更新できます。`,
    projectDeployCliSaveHint:
      "--save-project-dirs を付けると CLI で渡した対象を保存できます。次回は --all-projects を使えます。",
    projectDeploySavedListHeading: (n) => `保存済みプロジェクトディレクトリ（${n} 件）：`,
    projectDeployParsedTargets: (n) =>
      `${n} 件のプロジェクトディレクトリを読み取りました：`,
    projectDeployNoDirsEntered:
      "プロジェクトディレクトリが入力されていないため、プロジェクトエクスポートをスキップします。",
    projectDeployConfirmSaveAndUpdate: (n) =>
      `${n} 件のプロジェクトディレクトリを保存して今すぐ更新しますか？`,
    projectDeployConfirmUpdateOnce: (n) =>
      `今回だけ ${n} 件のプロジェクトディレクトリを更新しますか？`,
    projectDeployUseSaved: (n) => `保存済みプロジェクトディレクトリをすべて更新（${n} 件）`,
    projectDeploySelectOnce: "今回だけ指定したプロジェクトディレクトリを更新",
    projectDeploySelectAndRemember:
      "保存済みプロジェクトディレクトリを追加・変更し、今すぐ更新",
    projectCleanupUseSaved: (n) =>
      `保存済みプロジェクトディレクトリの冗長な Meta_Kim 資産をすべて整理（${n} 件）`,
    projectCleanupSelectOnce:
      "今回だけ指定したプロジェクトディレクトリの冗長な Meta_Kim 資産を整理",
    projectCleanupSelectAndRemember:
      "保存済みプロジェクトディレクトリを追加・変更し、冗長な Meta_Kim 資産を整理",
    projectDeployCliTargets: (n) =>
      `CLI から渡された ${n} 件のプロジェクトディレクトリを使用`,
    projectDeploySavedTargets: (n) =>
      `${n} 件のプロジェクトディレクトリを保存しました。今後の更新で再利用できます`,
    projectDeployNoSaved:
      "保存済みプロジェクトディレクトリがないため、プロジェクトエクスポートをスキップします。",
    projectDeployBatchHeading: (n) =>
      `${n} 件のプロジェクトディレクトリでプロジェクト用ランタイムファイルを更新中`,
    projectDeploySummary: "プロジェクトディレクトリ更新結果",
    projectDeployStatusOk: "更新済み",
    projectDeployStatusPartial: "一部完了 — 再試行が必要です",
    projectDeployStatusBlocked: "ブロック — パスの安全性を修正して再試行してください",
    projectDeployStatusFailed: "失敗",
    projectDeployFailed: (dir, msg) => `${dir} の更新に失敗しました：${msg}`,
    projectDeployMoreTargets: (n) =>
      `他 ${n} 件のプロジェクトディレクトリも更新しました。`,
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
    checkOverallFailed: "프로젝트 runtime 동기화 확인에 실패했습니다.",
    checkRepairCommand:
      "복구: `npm run meta:sync`를 실행한 뒤 다시 확인하세요.",
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
    selectedRuntimeCapabilityHeading: "선택한 runtime 기능 요약:",
    selectedRuntimeCapabilities: {
      codex: "Codex: agents, skills, commands, MCP 및 버전 의존 project/global hooks",
      cursor: "Cursor: agents, skills, rules, MCP 및 공식 preToolUse hooks",
      openclaw: "OpenClaw: workspaces, skills, hooks 및 선언적 governance; 도구 차단은 typed plugin adapter가 필요",
    },
    selectedRuntimeCapabilityBoundary:
      "runtime별로 기능이 다릅니다. 본 보고서는 실제로 선택하고 동기화한 기능만 표시합니다.",
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
1. 네트워크 타임아웃 → 실행：npm run meta:sync
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
    cmdDiscover: "전역 기능 스캔（agents/skills）",
    // 설치 후 주의사항
    postInstallNotesHeading: "설치 후 주의사항:",
    postInstallNotesIntro: "설치 완료 후 각 층의 사용 방식은 다음과 같습니다:",
    capabilityGateNotice:
      "기능 점검 기본값은 progressive입니다. 경과 일수가 아니라 작업 결과에 따라 해당 작업만 중단합니다. META_KIM_CAPABILITY_GATE=block으로 엄격 모드를 선택할 수 있습니다.",
    globalHooksOptInNotice:
      "전역 hooks는 기본으로 변경하지 않습니다. Meta_Kim이 Claude/Codex/Cursor hook 설정을 업데이트해야 할 때 node setup.mjs --with-global-hooks를 명시적으로 실행하세요.",
    postInstallNotesPlatformSync: "각 플랫폼 동기화 현황:",
    platformClaudeCode: "Claude Code",
    platformClaudeCodeCap: "agents + skills + hooks",
    platformCodex: "Codex",
    platformCodexCap: "agents + skills + commands + MCP + hooks (버전 의존)",
    platformOpenClaw: "OpenClaw",
    platformOpenClawCap: "workspace + skills + hooks + 선언적 governance",
    platformCursor: "Cursor",
    platformCursorCap: "agents + skills + rules + MCP + preToolUse hooks",
    postInstallNotesLayerActivation: "3층 메모리 활성화 방식:",
    layer1Label: "제1층 (Memory)",
    layer1Note: "자동 활성화 — Claude Code에 내장됨",
    layer2Label: "제2층 (Graphify)",
    layer2Note: "graphifyy 설치 후 자동 활성화 (pip install graphifyy)",
    layer3Label: "제3층 (SQL / MCP Memory Service)",
    layer3Note:
      "서버 수동 시작 필요: memory server --http (그러면 http://localhost:8000 에 접속)",
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
    inquirerUnavailableFallback:
      "@inquirer/prompts가 아직 설치되지 않아 번호 메뉴로 전환합니다. npm install 후 화살표 메뉴를 사용할 수 있습니다.",
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
    installScopePrompt: "재사용 글로벌 능력을 설치할까요, 프로젝트 디렉터리를 일괄 업데이트할까요?",
    installScopeProject:
      "프로젝트 디렉터리 — 명시적 프로젝트 runtime 업데이트",
    installScopeGlobal:
      "글로벌 — runtime 이 지원하는 agents, Commands, MCP, skills 재사용 능력",
    installScopeProjectLabel: "프로젝트 디렉터리 업데이트",
    installScopeGlobalLabel: "글로벌 능력 (권장)",
    installScopeProjectDesc:
      "선택한 프로젝트 디렉터리를 일괄 업데이트. 재사용 글로벌 능력은 설치하지 않음.",
    installScopeProjectDescDetail: `선택한 프로젝트 디렉터리 업데이트：
• Project context/config — AGENTS.md/CLAUDE.md managed block 및 MCP/settings add-only merge
• Project runtime projection — 명시 선택한 target 의 agents, Commands, hooks, MCP, skills, rules/workspaces
• Project overrides — 프로젝트 전용 커스터마이징이 필요하면 로컬에 유지
• graphify-out/ — 지식 그래프（환각 감소，쿼리 속도 향상）
• .meta-kim/state/ 및 .meta-kim/backups/ — state, manifest, cache, backup, rollback`,
    installScopeGlobalDesc:
      "재사용 runtime 능력 설치. 프로젝트 로컬 파일은 커스터마이징 때만 생성.",
    installScopeGlobalDescDetail: `글로벌 레벨 기능 생성：
• agents / Commands / MCP / skills — 선택 runtime 의 공식 글로벌/사용자 위치에 설치
• 글로벌 hooks 는 --with-global-hooks 를 명시한 경우에만 runtime hook 설정을 업데이트
• 각 프로젝트는 전용 확장이 증명되지 않는 한 글로벌 능력을 직접 재사용
• 다른 프로젝트는 discovery/dry-run 먼저；커스터마이징/bootstrap 확인 후에만 로컬 파일 작성`,
    askProjectRedundantCleanup:
      "프로젝트 안의 중복 Meta_Kim 프로젝트 레벨 자산을 정리할까요?\n글로벌 능력은 runtime 글로벌 디렉터리에 설치됩니다.\nmanifest 로 Meta_Kim 생성임이 증명된 오래된 agents, skills, Commands, hooks 등과 빈 디렉터리만 삭제합니다.",
    projectCleanupAsk: "정리할 프로젝트 디렉터리",
    projectCleanupProtectionNote:
      "정리 전용 모드: manifest 로 Meta_Kim 생성임이 증명된 프로젝트 레벨 runtime 자산만 삭제합니다. 사용자 파일, 인증 정보, merge 대상 설정은 보존합니다.",
    projectCleanupHookConfigStripped: (files) =>
      `merge config 에서 Meta_Kim 프로젝트 hook 참조를 제거했습니다: ${files.join(", ")}`,
    projectCleanupBatchHeading: (n) =>
      `${n}개 프로젝트 디렉터리의 중복 Meta_Kim 프로젝트 레벨 자산 정리 중`,
    projectCleanupSummary: "프로젝트 디렉터리 정리 결과",
    projectCleanupCliResult: (passed) =>
      `Meta_Kim 프로젝트 정리: ${passed ? "완료" : "실패"}`,
    projectCleanupCliTargets: (targets) => `대상 runtime=${targets}`,
    projectCleanupCliProjects: (count) => `처리한 프로젝트 수=${count}`,
    // 디렉토리 구조 설명
    directoryExplanationHeading: "디렉토리 구조",
    directoryExplanationIntro: "Meta_Kim 은 두 레벨의 디렉토리 생성：",
    directoryExplanationProject: "프로젝트 레벨（이 리포 내）：",
    directoryExplanationProjectDetail: `• graphify-out/ — 코드에서 구축된 지식 그래프
  실제 코드베이스 구조에 기반한 쿼리로 AI 환각 감소

• .meta-kim/state/ — 런타임 캐시 및 세션 복구
  실행 기록，세션 압축，크로스 세션 복구 저장

• .claude/.codex/.cursor/openclaw/ — 각 도구의 프로젝트 context/config/override
  재사용 agents, Commands, MCP, skills 는 프로젝트 전용 버전이 필요할 때 외에는 글로벌；hooks 는 명시 opt-in`,
    directoryExplanationGlobal: "글로벌 레벨（홈 디렉토리 내）：",
    directoryExplanationGlobalDetail: `• ~/.claude/skills/ — 모든 프로젝트 공유 스킬
  한 번 설치로 어디서든 발견 가능. 프로젝트 파일은 확인된 커스터마이징/state 일 때만 작성.

• ~/%tool%/skills/ — 각 도구 전용 스킬
  Claude: ~/.claude/skills/
  Codex: ~/.codex/skills/
  Cursor: ~/.cursor/skills/
  OpenClaw: ~/.openclaw/skills/`,
    directoryExplanationExisting: "기존 프로젝트 사용 방법：",
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
    syncClaudeAgents: (n, total) => `Claude Code 에이전트: ${n}/${total} .md 파일`,
    syncClaudeSkills: "Claude Code 스킬/meta-theory/SKILL.md",
    syncClaudeHooks: (n) => `Claude Code 훅: ${n} 스크립트`,
    syncClaudeProjectHooksMigrated:
      "Claude Code 프로젝트 hooks는 전역 hooks로 이전되었습니다. repo-local .claude/hooks는 필요하지 않습니다",
    syncClaudeSettings: "Claude Code .claude/settings.json",
    syncClaudeMcp: "Claude Code .mcp.json",
    syncCodexAgents: (n, total) =>
      `Codex 에이전트: ${n}/${total} .toml 파일`,
    syncCodexSkills: "Codex .agents/skills/meta-theory/SKILL.md",
    syncCodexSkillsGlobal:
      "Codex 프로젝트 스킬 미러: .agents/skills/meta-theory/SKILL.md",
    syncOpenclawWorkspaces: (n, total) =>
      `OpenClaw 워크스페이스: ${n}/${total} 에이전트 — 각 폴더에 필수 .md 9개(BOOT, SOUL 등)`,
    syncOpenclawSkill: "OpenClaw 공유 meta-theory",
    syncSharedSkills: "공유 스킬/meta-theory/SKILL.md",
    syncCursorAgents: (n, total) => `Cursor 에이전트: ${n}/${total} .md 파일`,
    syncCursorSkills: "Cursor 스킬/meta-theory/SKILL.md",
    syncCursorMcp: "Cursor .cursor/mcp.json",
    mcpRuntimeProjectOnly: (p) =>
      `${p}에 meta-kim-runtime이 있지만 이 위치에서는 스크립트 경로를 사용할 수 없습니다. 이 MCP는 Meta_Kim 소스 저장소 전용입니다. 복사한 일반 프로젝트에서는 meta-kim-runtime 블록을 삭제하세요. Agents는 계속 .claude/.codex/.cursor/openclaw 파일에서 로드됩니다.`,
    syncOk: "모든 동기화 대상 확인 완료",
    syncMissing: (p) => `누락: ${p}`,
    syncGlobalOnlyHookPairOk: (runtime) =>
      `${runtime} 프로젝트 Hook 쌍: activator + project-root resolver`,
    syncGlobalOnlyHookPairFailed: (runtime, detail) =>
      `${runtime} 프로젝트 Hook 쌍이 불완전합니다: ${detail}`,
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
    graphifySkillSkippedGuideExists: (p) =>
      `graphify ${p} install 건너뜀(가이드에 Graphify 섹션이 이미 있음)`,
    graphifyCodeGraphGenerated: "graphify 코드 그래프 생성됨",
    graphifyCodeGraphGenerationFailed:
      "graphify 코드 그래프 생성 실패 (비차단)",
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
    graphifyHooksRepaired: (n, project, backup) =>
      `${project}의 안전하지 않은 Graphify hook 명령 ${n}개를 복구했습니다 (백업: ${backup})`,
    projectAssetsCleanupAllClean:
      "모든 타입 정리됨 (agents/skills/commands/capability-index/hooks): 삭제 0",
    graphifyProjectWiringSkipped:
      "Graphify가 전역에 설치되었습니다. 프로젝트 디렉터리에서 `npm run meta:graphify:rebuild`(또는 `python -m graphify update .`)를 실행해 지식 그래프를 생성하세요.",
    stepMcpMemory: "Meta_Kim 크로스세션 메모리",
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
      "Meta_Kim 크로스세션 메모리를 활성화할까요? MCP Memory Service 를 사용하며, 없으면 설치하고 등록한 뒤 백그라운드로 시작합니다.",
    mcpMemorySkipped: "MCP Memory Service 건너뜀",
    mcpMemoryRequiresGlobalHooks:
      "MCP Memory Service 건너뜀: 공유 런타임 Hook을 먼저 설치하도록 --with-global-hooks로 다시 실행하세요",
    mcpMemoryServerStartHint:
      "MCP Memory Service 설치 완료——HTTP 서비스 시작 방법: MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http",
    mcpMemoryHookInstalling: (targets) =>
      `${targets}용 MCP Memory 훅 설치 중...`,
    mcpMemoryHookInstalled: "MCP Memory 런타임 훅 설치 완료",
    mcpMemoryHookWarnings:
      "훅 설치에서 경고가 발생했습니다 (비차단) — 하위 프로세스의 stderr 원문은 아래와 같습니다:",
    mcpMemoryEndpointSelected: (endpoint) => `MCP Memory 엔드포인트: ${endpoint}`,
    mcpMemoryEndpointInvalid: (reason) => `MCP Memory 엔드포인트 설정이 잘못되었습니다: ${reason}`,
    mcpMemoryRemoteEndpointNoAutoStart: (endpoint) =>
      `외부 MCP Memory 엔드포인트 ${endpoint}를 사용합니다. 로컬 프로세스와 부팅 자동 시작은 설정하지 않았습니다.`,
    mcpMemoryAutoStarting: "MCP Memory Service (HTTP 백그라운드) 시작 중...",
    mcpMemoryAutoStarted: (endpoint) =>
      `MCP Memory Service가 ${endpoint}에서 실행 중`,
    mcpMemoryAutoStartUnverified:
      "MCP Memory Service 프로세스가 실행 중이므로 설치를 계속합니다",
    mcpMemoryAutoStartFailed: "자동 시작 실패 — 수동으로 시작하세요:",
    mcpMemoryAutoStartManual:
      "  MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http",
    mcpMemoryAutoStartBoot: "부팅 시 자동 시작 구성 완료",
    mcpMemoryAutoStartBootFailed:
      "MCP Memory Service는 정상 상태이지만 부팅 시 자동 시작을 구성하지 못했습니다",
    mcpMemoryAutoStartFailureTitle: "Meta_Kim MCP Memory Service",
    mcpMemoryAutoStartFailureMessage: (healthUrl) =>
      `Meta_Kim MCP Memory Service를 시작하지 못했거나 ${healthUrl}이 healthy 상태가 되지 않았습니다. 세션 간 메모리를 사용할 수 없을 수 있습니다. 수동으로 시작하세요: MCP_ALLOW_ANONYMOUS_ACCESS=true memory server --http`,
    updateHeading: "업데이트 모드",
    updateNpm: "npm 의존성 재설치 중...",
    updateSkills: "모든 스킬 업데이트 중...",
    updateSyncProjectFiles: "canonical/에서 리포 내 도구 설정 동기화 중...",
    updateSyncDone: "동기화 완료",
    updateSyncSkip: "동기화를 건너뛰었거나 실패했습니다",
    updateReGlobal: "전역 스킬 디렉토리를 다시 선택할까요?",
    askReselectRuntimes: "이 컴퓨터에서 사용할 AI 코딩 도구를 다시 선택할까요?",
    askPythonToolsUpdate: "Python graphify (코드 지식 그래프)를 설치할까요?",
    pythonToolsSkipped: "Python 도구 건너뜀",
    askGlobalSkillsUpdate: "전역 스킬을 업데이트할까요? (선택)",
    updateSkillsDone: "전역 스킬 업데이트 완료",
    globalSkillsSkipped: "전역 스킬 건너뜀",
    askMetaTheoryUpdate:
      "선택한 runtime 에 Meta_Kim 글로벌 거버넌스 레이어를 동기화해 각 프로젝트에서 재사용할까요? agents, skills, MCP, Commands 를 포함합니다. 글로벌 hooks 는 --with-global-hooks 가 필요합니다. 지원 항목은 자동 확인됩니다. (권장)",
    updateMetaTheoryDone: "Meta_Kim 글로벌 능력 동기화 완료",
    metaTheorySkipped: "Meta_Kim 글로벌 능력 동기화 건너뜀",
    globalHooksMigrationHeading:
      "셀프 호스트 hook 마이그레이션 검사(~/.claude/hooks/meta-kim/)",
    globalHooksMigrationFound: (n) =>
      `canonical 화이트리스트와 더 이상 일치하지 않는 Meta_Kim 관리 hook 파일 ${n}개를 발견했습니다.`,
    globalHooksMigrationListed: (files) =>
      `삭제 대상 파일:\n${files.map((f) => `  - ${f}`).join("\n")}`,
    globalHooksMigrationKept: (files) =>
      `사용자 작성 파일(유지):\n${files.map((f) => `  - ${f}`).join("\n")}`,
    globalHooksMigrationConfirm: (n) =>
      `${n}개의 Meta_Kim 관리 hook 파일을 백업 후 삭제하시겠습니까? (y/N)`,
    globalHooksMigrationBackedUp: (dir) => `백업 위치: ${dir}`,
    globalHooksMigrationDone: (n) =>
      `${n}개의 Meta_Kim 관리 hook 파일을 삭제했습니다. 전역 sync 단계에서 다시 설치됩니다.`,
    globalHooksMigrationSkipped:
      "사용자가 건너뜀. 수동으로 삭제할 때까지 전역 hooks 재설치가 실패할 수 있습니다.",
    globalHooksMigrationNoChange:
      "전역 hooks 디렉터리는 깨끗합니다. 마이그레이션이 필요하지 않습니다.",
    projectHooksMigrationHeading: (platform) =>
      `[${platform}] Meta_Kim 관리 프로젝트 레벨 hook 파일 제거 중`,
    projectHooksMigrationRemoved: (platform, count, dir) =>
      `[${platform}] Meta_Kim 관리 파일 ${count}개 삭제: ${dir}`,
    projectHooksMigrationKept: (platform, files) =>
      `[${platform}] 사용자 작성 hook 파일(유지): ${
        files.length > 0 ? files.join(", ") : "(없음)"
      }`,
    projectHooksMigrationNoChange: (platform, dir) =>
      `[${platform}] ${dir} 깨끗함. 처리할 항목 없음.`,
    projectAssetsCleanupIntro:
      "Meta_Kim은 재사용 가능한 능력을 전역 runtime 디렉터리로 옮깁니다. 프로젝트에는 명시적 project projection, 프로젝트 전용 override, 상태, 캐시를 남깁니다.",
    projectAssetsCleanupScope:
      "이번 정리는 project-bootstrap manifest가 Meta_Kim 생성 파일임을 증명하고 현재 계획에서 더 이상 관리하지 않는 프로젝트 레벨 능력 자산만 삭제합니다. 사용자 파일, 인증 정보, merge 대상 설정 파일은 보존합니다.",
    projectAssetsRetargetCleanupIntro:
      "프로젝트 레벨 대상 runtime을 이번 선택에 맞게 다시 계산했습니다. 선택되지 않은 runtime의 오래된 Meta_Kim 프로젝트 자산을 삭제합니다.",
    projectAssetsRetargetCleanupScope:
      "이 작업은 프로젝트 디렉터리 업데이트의 일부입니다. manifest로 Meta_Kim 생성임이 증명되고 이번 대상 선택에 포함되지 않는 자산만 삭제합니다. 사용자 파일, 인증 정보, merge 대상 설정 파일은 보존합니다.",
    projectAssetsCleanupRemoved: (count, rows) =>
      `오래된 프로젝트 레벨 자산 ${count}개를 삭제하고 빈 디렉터리를 정리했습니다:\n${rows.map((row) => `  - ${row}`).join("\n")}`,
    projectAssetsCleanupSkipped: (count) =>
      `manifest 항목 ${count}개는 안전 삭제 조건을 만족하지 않아 건너뛰었습니다.`,
    updateComplete: "업데이트 완료!",
    // 설치 개요 문자열
    installOverviewTitle: "Meta_Kim 설치 개요",
    installOverviewWill: "이 과정에서:",
    installOverviewSyncConfig:
      "프로젝트 디렉토리에 설정 동기화 (canonical → .claude/.codex/openclaw/.cursor/)",
    installOverviewInstallSkills:
      "선택한 전역 스킬 리포지토리 설치 (~/.claude/skills/)",
    installOverviewSyncMeta: "Meta_Kim 재사용 능력을 글로벌 디렉터리에 동기화",
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
    progressSyncMeta: "Meta_Kim 글로벌 능력 동기화",
    refreshGlobalCapabilityInventory:
      "Meta_Kim 글로벌 능력 인벤토리 새로고침 중...",
    globalCapabilityInventoryRefreshed:
      "Meta_Kim 글로벌 능력 인벤토리 새로고침 완료",
    globalCapabilityInventoryFailed:
      "글로벌 능력 discovery 실패; setup/update 후 `npm run discover:global` 를 실행하세요.",
    progressValidate: "설치 검증",
    // 확인 문자열
    confirmStartInstall: "설치를 시작할까요?",
    projectBootstrapConfirmationReasons: {
      ready: "초기화 manifest와 프로젝트 전용 파일이 최신이므로 쓰기가 필요하지 않습니다.",
      conflict: "기존 파일이 생성 경로와 겹치지만 소유권이 확인되지 않았습니다. 적용 전에 충돌을 해결하세요.",
      stale: "기존 초기화 manifest가 다른 Meta_Kim 버전을 사용합니다.",
      target_scope_changed: "선택한 runtime 대상이 이전 초기화 manifest와 다릅니다.",
      missing: "필수 프로젝트 context, config, state 또는 확인된 override가 없습니다.",
      repair_required: "초기화 버전은 최신이지만 관리 파일의 복구, 병합 또는 재생성이 필요합니다.",
      ready_with_existing_config: "기존 config에는 확인된 초기화 state 또는 대기 변경이 필요합니다.",
    },
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

수정：node scripts/sync-runtimes.mjs --scope project
`,
    warnSkillsInstallFailed: `
⚠ 전역 스킬 설치 실패

주요 원인: 위에 표시된 첫 번째 정확한 오류를 기준으로 판단하세요. 로그에 해당 상태가 명시된 경우에만 아래 해결 방법을 적용하세요:
1. 로그에 EBUSY 또는 "resource busy"가 있으면 → skills 폴더를 열어 둔 탐색기/IDE를 닫고 백신/인덱싱이 끝날 때까지 기다리세요. 경로가 해제된 뒤에는 Meta_Kim이 이번 실패 로그에서 명시한 정확한 임시 경로만 처리 대상으로 삼고, 선택한 런타임의 skills/plugins 루트 안에 있으며 사용자 소유 데이터가 아닌지 먼저 확인하세요. 와일드카드로 임시 폴더를 삭제하지 마세요
2. 로그에 네트워크 오류 또는 Git fetch 실패가 있으면 → 연결을 확인하고 node setup.mjs --prompt-proxy 로 프록시 설정을 점검하세요
3. 로그에 리포지토리를 찾을 수 없다고 나오면 → 스킬 리포지토리 URL이 올바른지 확인하세요

다음 단계: 첫 번째 정확한 오류를 먼저 해결한 뒤 다시 실행하세요: node setup.mjs --update
`,
    warnMetaTheorySyncFailed: `
⚠ meta-theory 동기화 실패

주요 원인: 위에 표시된 첫 번째 정확한 오류를 기준으로 판단하세요. 로그에 해당 상태가 명시된 경우에만 아래 해결 방법을 적용하세요:
1. 로그에 EBUSY 또는 디렉토리 잠금이 있으면 → 선택한 런타임의 Meta_Kim skills/plugins 디렉토리를 사용하는 프로그램을 닫으세요
2. 로그에 권한 거부가 있으면 → 해당 런타임 디렉토리의 쓰기 권한을 확인하세요
3. 로그에 네트워크 오류가 있으면 → 연결과 프록시 설정을 확인하세요

다음 단계: 첫 번째 정확한 오류를 먼저 해결한 뒤 선택한 런타임을 다시 실행하세요: node setup.mjs --update
`,
    warnSkillsUpdateFailed: `
⚠ 전역 스킬 업데이트 실패

주요 원인: 위에 표시된 첫 번째 정확한 오류를 기준으로 판단하세요. 로그에 해당 상태가 명시된 경우에만 아래 해결 방법을 적용하세요:
1. 로그에 EBUSY 또는 "resource busy"가 있으면 → skills 폴더를 열어 둔 탐색기/IDE를 닫고 백신/인덱싱이 끝날 때까지 기다리세요. 경로가 해제된 뒤에는 Meta_Kim이 이번 실패 로그에서 명시한 정확한 임시 경로만 처리 대상으로 삼고, 선택한 런타임의 skills/plugins 루트 안에 있으며 사용자 소유 데이터가 아닌지 먼저 확인하세요. 와일드카드로 임시 폴더를 삭제하지 마세요
2. 로그에 Git fetch 실패 또는 네트워크 오류가 있으면 → 연결과 프록시 설정을 확인하세요
3. 로그에 파일 충돌이 있으면 → 스테이징된 파일을 확인하고 충돌을 수동으로 해결하세요

다음 단계: 첫 번째 정확한 오류를 먼저 해결한 뒤 다시 실행하세요: node setup.mjs --update
`,
    warnSkillsUpdateFailedHint:
      "로그에 EBUSY 등이 있으면: skills 폴더를 연 탐색기/IDE를 닫고 백신/인덱싱이 끝날 때까지 기다리세요. Meta_Kim이 이번 실패 로그에서 명시한 임시 경로가 선택한 런타임의 skills/plugins 루트 안에 있고 사용자 소유 데이터가 아니라고 확인한 경우에만 그 정확한 경로를 처리 대상으로 삼으세요. 와일드카드로 삭제하지 마세요.",
    warnMetaTheoryUpdateFailed: `
⚠ meta-theory 동기화 실패

주요 원인: 위에 표시된 첫 번째 정확한 오류를 기준으로 판단하세요. 로그에 해당 상태가 명시된 경우에만 아래 해결 방법을 적용하세요:
1. 로그에 EBUSY 또는 디렉토리 잠금이 있으면 → 선택한 런타임의 Meta_Kim skills/plugins 디렉토리를 사용하는 프로그램을 닫으세요
2. 로그에 권한 거부가 있으면 → 해당 런타임 디렉토리의 쓰기 권한을 확인하세요
3. 로그에 네트워크 오류가 있으면 → 연결과 프록시 설정을 확인하세요

다음 단계: 첫 번째 정확한 오류를 먼저 해결한 뒤 선택한 런타임을 다시 실행하세요: node setup.mjs --update
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
    progressInstallPython: "Python graphify 도구 설치",
    progressInstallMcpMemory: "Meta_Kim 크로스세션 메모리 설정 (선택)",
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
    npxQuickDirPrompt: "프로젝트용 디렉터리를 어디에 준비할까요?",
    npxQuickDirDefault: "~/Desktop/Meta_Kim",
    npxQuickCreating: "프로젝트용 디렉터리 준비 중:",
    npxQuickCopyFiles: "프로젝트용 런타임 파일 복사 중",
    npxQuickDirExists: "디렉터리가 이미 존재합니다. 내부 파일을 업데이트합니다",
    npxQuickDone: "프로젝트용 파일 준비 완료!",
    npxQuickPostCopyScript:
      "프로젝트 graph/state 출력은 전역 Meta_Kim 초기화기가 해당 프로젝트 안에 생성합니다.",
    npxQuickOpenIn: "이 디렉터리에서 플랫폼 열기:",
    npxQuickAskDeploy:
      "프로젝트용 런타임 파일을 다른 디렉터리로 내보낼까요? 해당 디렉터리를 기존 프로젝트에 복사할 수 있습니다.",
    npxQuickDeployYes: "디렉터리 선택",
    npxQuickDeployNo: "건너뛰기",
    projectDeployDirPrompt: "프로젝트 디렉터리:",
    projectDeployAsk: "프로젝트 디렉터리 업데이트",
    projectDeployProtectionNote:
      "기존 로컬 settings, MCP, hook 구성은 보존하고 병합합니다. 선택한 디렉터리만 업데이트합니다.",
    globalManagedProjectRefreshInfo: (n) =>
      `관리 중인 프로젝트 ${n}개를 감지했습니다. 이번 업데이트는 각 프로젝트에 저장된 런타임 대상을 사용해 전역 설치와 기존 프로젝트를 병합/증분 방식으로 새로 고칩니다. 새 프로젝트 투영을 만들지 않으며 프로젝트에 정착된 기능이나 사용자 파일을 덮어쓰지 않습니다.`,
    managedProjectRejectedHeading: (n) => `기존 프로젝트 대상 ${n}개를 새로 고치지 못했습니다:`,
    managedProjectRejectedDetail: (source, reason) => `출처: ${source}. 이유: ${reason}.`,
    managedProjectRejectedRepair: "표시된 저장/registry 대상을 수정하거나 제거하거나, project bootstrap을 명시적으로 실행해 유효한 manifest를 다시 만든 뒤 재시도하세요.",
    managedProjectRejectedStep: "명시된 기존 프로젝트 대상 검증",
    managedProjectRejectedSources: { explicit_project_dirs: "명시적 --project-dir", saved_project_dirs: "저장된 프로젝트 목록", project_registry: "사용자 수준 project registry", current_working_directory: "현재 작업 디렉터리" },
    managedProjectRejectedReasons: { target_missing: "디렉터리가 없습니다", unsafe_project_root: "프로젝트 루트가 안전한 실제 디렉터리가 아닙니다", unsafe_manifest_path: "manifest 경로가 symlink 또는 Junction을 통과합니다", manifest_missing_or_invalid: "관리 프로젝트 manifest가 없거나 유효하지 않습니다", invalid_active_targets: "저장된 런타임 대상이 비어 있거나 지원되지 않습니다" },
    projectDeployInteractiveHint:
      "프로젝트 목록을 한 번 저장하면 이후 업데이트에서 저장된 모든 프로젝트를 함께 업데이트할 수 있습니다.",
    projectDeployPathEntryHint:
      "모든 프로젝트 루트를 한 줄에 입력하세요. 여러 디렉터리는 세미콜론이나 쉼표로 구분합니다. 예: D:/Project/a; D:/Project/b",
    projectDeploySavedPathHint: (path) =>
      `${path}에 저장했습니다. 다음에는 저장된 디렉터리 옵션을 선택하거나 --all-projects로 업데이트할 수 있습니다.`,
    projectDeployCliSaveHint:
      "--save-project-dirs를 추가하면 CLI 대상이 저장되며 다음에는 --all-projects를 사용할 수 있습니다.",
    projectDeploySavedListHeading: (n) => `저장된 프로젝트 디렉터리 (${n}개):`,
    projectDeployParsedTargets: (n) =>
      `프로젝트 디렉터리 ${n}개를 읽었습니다:`,
    projectDeployNoDirsEntered:
      "프로젝트 디렉터리가 입력되지 않아 프로젝트 내보내기를 건너뜁니다.",
    projectDeployConfirmSaveAndUpdate: (n) =>
      `프로젝트 디렉터리 ${n}개를 저장하고 지금 업데이트할까요?`,
    projectDeployConfirmUpdateOnce: (n) =>
      `이번 실행에서만 프로젝트 디렉터리 ${n}개를 업데이트할까요?`,
    projectDeployUseSaved: (n) => `저장된 모든 프로젝트 디렉터리 업데이트 (${n}개)`,
    projectDeploySelectOnce: "이번에만 지정한 프로젝트 디렉터리 업데이트",
    projectDeploySelectAndRemember:
      "저장된 프로젝트 디렉터리를 추가/변경하고 지금 업데이트",
    projectCleanupUseSaved: (n) =>
      `저장된 모든 프로젝트 디렉터리의 중복 Meta_Kim 자산 정리 (${n}개)`,
    projectCleanupSelectOnce:
      "이번에만 지정한 프로젝트 디렉터리의 중복 Meta_Kim 자산 정리",
    projectCleanupSelectAndRemember:
      "저장된 프로젝트 디렉터리를 추가/변경하고 중복 Meta_Kim 자산 정리",
    projectDeployCliTargets: (n) =>
      `CLI에서 전달된 프로젝트 디렉터리 ${n}개 사용`,
    projectDeploySavedTargets: (n) =>
      `프로젝트 디렉터리 ${n}개를 저장했습니다. 향후 업데이트에서 재사용할 수 있습니다`,
    projectDeployNoSaved:
      "저장된 프로젝트 디렉터리가 없어 프로젝트 내보내기를 건너뜁니다.",
    projectDeployBatchHeading: (n) =>
      `프로젝트 디렉터리 ${n}개의 프로젝트용 런타임 파일 업데이트 중`,
    projectDeploySummary: "프로젝트 디렉터리 업데이트 결과",
    projectDeployStatusOk: "업데이트됨",
    projectDeployStatusPartial: "일부 완료 — 재시도가 필요합니다",
    projectDeployStatusBlocked: "차단됨 — 경로 안전 문제를 수정한 뒤 재시도하세요",
    projectDeployStatusFailed: "실패",
    projectDeployFailed: (dir, msg) => `${dir} 업데이트 실패: ${msg}`,
    projectDeployMoreTargets: (n) =>
      `다른 프로젝트 디렉터리 ${n}개도 업데이트했습니다.`,
    aboutAuthor: "작성자 소개",
    contactWebsite: "웹사이트",
    contactGithub: "GitHub",
    contactFeishu: "Feishu 위키",
    contactWechat: "WeChat 공식 계정",
  },
};
}
