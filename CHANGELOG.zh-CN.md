# 更新日志

> 🇺🇸 [English](./CHANGELOG.md) | 中文版

所有 Meta_Kim 的重要变更都会记录在此。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
发布新版本时，请在顶部（旧版本之前）添加新的 **`## [版本号] - YYYY-MM-DD`** 部分。

## [2.0.22] - 2026-05-01

### 修复

- **MCP Memory Service API 兼容性** — Claude、Codex、Cursor、OpenClaw 的 memory hooks 现在使用 `POST /api/search` + `n_results` 查询记忆，并且只写入受支持的 `memory_type: "observation"`。
- **Memory hook 升级清理** — 删除旧的 event-to-memory-type 映射代码，并清理生成的 bytecode cache 残留，避免已安装过的环境继续保留旧 hook 行为。

### 测试

- 新增 setup 测试与项目校验闸门，禁止 legacy memory search endpoint、legacy memory type 和兼容字段残留回归。
- 发布前已验证 runtime sync、hook syntax、MCP memory hook 定向测试、Graphify health，以及完整 `npm run meta:check`。

## [2.0.20] - 2026-04-30

### 修复

- **footprint diff 准确性** — `footprint --diff` 现在使用真实文件系统存在性判断 manifest 路径是否缺失，不再把 manifest 里的子文件和扫描器汇总的目录项做精确字符串比较。目录与子文件会被视为同一覆盖关系，避免真实存在的 runtime skill 文件被误报 missing。
- **project/global manifest 对比** — `--scope=both` 现在会同时读取 project 与 global install manifest，不再只比较其中一侧。
- **sync manifest 刷新** — runtime sync 与 global meta-theory sync 会替换自己上次写入的 manifest 记录，并且即使文件已经最新也重新登记受管理路径，避免旧 source 路径长期残留。

### 测试

- 新增 manifest recorder 的 source replacement 回归测试，并于 2026-04-30 使用 `npm run meta:verify:all` 完成发布级验证。

## [2.0.19] - 2026-04-28

### 修复

- **跨运行时 MCP Memory 持久化** — `install-mcp-memory-hooks.mjs` 现在除 Claude Code 外，也会为 Codex、Cursor、OpenClaw 安装 MCP Memory 生命周期钩子。Codex 写入 `~/.codex/hooks.json` 的 SessionStart / UserPromptSubmit / Stop；Cursor 写入 `~/.cursor/hooks.json` 的 beforeSubmitPrompt / stop；OpenClaw 写入 `~/.openclaw/hooks/mcp-memory-service` managed hook。
- **MCP Memory Service API 对齐** — Claude 的 SessionStart 记忆查询改用上游 `POST /api/memories/search`，同时兼容旧的 `results[].memory` 返回结构。跨运行时保存钩子使用 `POST /api/memories`，并按上游建议带上 `X-Agent-ID` 和 `conversation_id`。
- **MCP Memory 端点兼容性** — 跨运行时记忆 hook 现在同时支持 `http://` 和 `https://` 形式的 `MCP_MEMORY_URL`。
- **记忆服务健康检查表述** — 安装器不再在当前 shell 无法访问 `localhost:8000`、但 `memory.exe` 正在运行时直接误报服务 down；现在会区分“不可响应”和“当前 shell 无法验证但进程存在”。

## [2.0.18] - 2026-04-28

### 修复

- **Codex `/meta-theory` agent team 执行** — `/meta-theory` 现在明确授权 Codex 使用 sub-agent delegation；非简单任务先应用 `agent-teams-playbook`，再把能力匹配后的执行计划转换成 Codex `spawn_agent` 调用，避免复杂任务只在主线程里做完。
- **quick deploy 根目录入口文件** — `setup.mjs` 现在会在 Claude 部署时复制 `CLAUDE.md`，在 Codex、OpenClaw、Cursor 部署时复制 `AGENTS.md`。`all` 模式下 `AGENTS.md` 只复制一次，避免冗余操作，同时保留各运行时需要的项目入口。
- **planning hook 阶段统计** — planning-with-files 的 shell / PowerShell stop 与 check 脚本现在会跨运行时打补丁，Codex adapter 模板也会同时识别 `## Phase` 和 `### Phase`，避免重新安装后 Stop hook 误报 `7/0 phases done`。
- **Claude Code smoke 验证** — `eval-meta-agents` 现在兼容不再提供 `agents` 子命令的 Claude Code 版本，改为直接校验 `.claude/agents/*.md`。Windows CLI 解析也会优先使用 npm 风格的 `~/.local/claude.cmd`，再考虑 native `~/.local/bin/claude.exe`。

### 测试

- 新增 setup 测试，覆盖 quick deploy 入口文件、Codex planning hook 阶段解析、Claude smoke fallback。
- 已于 2026-04-28 使用 `npm run meta:verify:all` 完成发布级验证。

## [2.0.17] - 2026-04-27

### 新增

- **Codex `/meta-theory` 命令投影** — 新增 canonical Codex 命令源 `canonical/runtime-assets/codex/commands/meta-theory.md`，并补齐项目级 / 全局同步，让 Codex 能从 `.codex/commands/` 和 `~/.codex/commands/` 加载 `/meta-theory`。

### 修复

- **Codex 命令验证与打包** — `config/sync.json`、`scripts/meta-kim-sync-config.mjs`、`scripts/sync-runtimes.mjs`、`scripts/sync-global-meta-theory.mjs`、`scripts/validate-project.mjs` 和 setup 测试现在把 Codex commands 作为一等运行时资产处理。同步修正 `.gitignore` 根目录锚定，避免 canonical Codex runtime assets 被误忽略。
- **OpenClaw skill 根目录接线** — 已核对 OpenClaw 已安装 CLI 的实际加载逻辑，并在 `canonical/runtime-assets/openclaw/openclaw.template.json` 通过 `skills.load.extraDirs` 接入 `__REPO_ROOT__\\openclaw\\skills`，让生成配置能加载仓库内 OpenClaw skills，而不是错误假定它们位于用户级 managed skills 目录。
- **Cursor agent / skill 路径对齐** — 已核对 Cursor 内置 `create-subagent` / `create-skill` 指南，并把 Cursor agent 生成改为在 `.cursor/agents/*.md` 写入 YAML frontmatter。Cursor 文档现在区分项目 skills（`.cursor/skills/<skill>/SKILL.md`）、用户 skills（`~/.cursor/skills/`）、内置 skills（`~/.cursor/skills-cursor/`）和用户 agents（`~/.cursor/agents/`）。
- **全局能力发现根目录** — `scripts/discover-global-capabilities.mjs` 现在扫描真实的 OpenClaw / Cursor 用户根目录：OpenClaw `~/.openclaw/skills` 加 `~/.agents/skills`，Cursor `~/.cursor/agents`、`~/.cursor/skills` 和 `~/.cursor/skills-cursor`。

### 变更

- **运行时文档刷新** — 更新 `AGENTS.md`、`CLAUDE.md`、`README.md`、`README.zh-CN.md`、`docs/runtime-capability-matrix.md` 和 research 文档，使其匹配已验证的 Codex、OpenClaw、Cursor 运行时位置与命令 / skill 行为。
- **OpenClaw 评估配置占位符递归替换** — `scripts/eval-meta-agents.mjs` 现在会递归替换生成配置对象里的 `__REPO_ROOT__`，不再只处理 agent workspace 路径。

## [2.0.16] - 2026-04-26

### 修复

- **四端 skill 清理** — `install-global-skills-all-runtimes.mjs` 四个关键修复：
  - `legacyNames` 支持 — 新增 manifest 字段用于删除旧 skill 目录（如 `find-skills` → `findskill`）。`cleanupLegacySkillNames()` 在安装前运行，清理过期的符号链接和目录。
  - `.disabled/ 残留清理` — 新增 `cleanupDisabledSkillResidue()`（单 skill）和 `sweepStaleDisabledDirs()`（全局清扫），当活跃版本存在时删除 `.disabled/{skillId}/`。捕获 manifest 外部署的 skill 残留（如通过 sync:runtimes 部署的 meta-theory）。
  - `loadSkillsManifest()` 字段传播 bug — `hookSubdirs`、`hookConfigFiles` 和 `fallbackContentDir` 从未从 manifest 复制到运行时 spec 对象。由于这个预存 bug，hooks 从未被部署。修复方式是为这三个字段添加展开运算符。
  - `deployHookSubdirs/deployHookConfigFiles` 目标路径 bug — 两个函数接收的是 `targetDir`（skills 根目录）但当作 `runtimeHome` 使用，导致 hooks 部署到错误路径。修改函数签名直接接收 `runtimeHome` 并更新所有 4 个调用点。

### 新增

- **hookprompt hook 部署机制** — hookprompt 现在作为 hook 系统正确安装，而非 skill clone：
  - 新增 `hookExtraFiles` manifest 字段 — 部署额外文件到 hooks 旁（如 `prompt-optimizer-meta.md` 到 `~/.claude/`）。
  - 新增 `hookSettingsMerge` manifest 字段 — 在 `settings.json` 中注册 hook 命令，路径指向已部署的 hook 脚本。
  - 安装脚本新增 `deployHookExtraFiles()` 和 `mergeHookSettings()` 函数。
  - `skills-manifest.schema.json` 新增三个字段的 schema 定义。
  - hookprompt manifest 条目现在包含 Claude 平台的 `hookSubdirs`、`hookExtraFiles` 和 `hookSettingsMerge`。

### 变更

- **i18n 新增** — 在 `meta-kim-i18n.mjs` 中为所有 4 种语言（en、zh-CN、ja-JP、ko-KR）添加 `warnLegacyNameRemoved` 和 `warnDisabledResidueRemoved` key。

## [2.0.15] - 2026-04-21

### 新增

- **stop-memory-save hook**: 新增 Stop hook (`stop-memory-save.mjs`)，在会话结束时将摘要写入 MCP Memory Service，实现跨会话连续性，无需手动干预。现在共有 10 个 hook 接入 `doctor:governance` 和 `validate:run`。
- **tests/setup/check-sync.test.mjs**: 预期 hook 数量从 9 更新为 10（新增 stop-memory-save）。
- **scripts/runtime-sync-check.mjs、doctor-governance.mjs、footprint.mjs、claude-settings-merge.mjs**: 在 hook 文件/命令列表中添加了 `stop-memory-save.mjs`。
- **`mirror` 作为业务工作流的第 11 个阶段** — `config/contracts/workflow-contract.json` 早已把 `mirror`（镜像发布 / Mirror Publish）声明为 `evolve` 之后的终态阶段；本次发布补齐所有依赖测试和文档，使三方同步到 11 阶段契约。同步后状态：`phases.length = 11`、`terminalPhases.length = 7`、`labels.{zh-CN,en-US}` 各有 11 条，`tests/meta-theory/07-contract-compliance.test.mjs` 与 `tests/meta-theory/12-ten-step-workflow.test.mjs` 不再 flaky。

### 修复

- **四端 hooks 纠正** — 四个平台（Claude Code、Codex、OpenClaw、Cursor）均有原生 hooks 系统。此前文档错误标注仅 Claude Code 有 hooks。Codex 支持 `hooks.json`（5 个事件，v0.117.0+），OpenClaw 支持 Plugin SDK hooks（28 个），Cursor 支持 `hooks.json`（4 个事件）。已更新 `runtime-capability-matrix.md`、`runtime-coverage-audit.md`、`distribution-matrix.md` 及四语言 README。
- **PWF hook 联合部署** — `install-global-skills-all-runtimes.mjs` 现在自动部署 planning-with-files 生命周期 hooks 到 Codex（`.codex/hooks/` + `hooks.json`）和 Cursor（`.cursor/hooks/` + `hooks.json`）。
- **Superpowers 稀疏回退** — 新增 `fallbackContentDir` 逻辑，当平台子目录（`.codex/`、`.cursor/`）内容过少时自动回退到 `skills/` 主内容目录。
- **`install-plugin-bundles` dry-run 状态串味** — `scripts/install-global-skills-all-runtimes.mjs`（1576–1583 行）在 `--dry-run` 模式下也会走"目录已存在就跳过"的幂等短路，导致 `obra/superpowers` 之类插件包的 sparse-checkout 预览命令在目标目录已缓存的机器上永远不会打印。单行 patch 加 `!dryRun &&`，让 dry-run 永远展示命令，真实执行的幂等性保持不变。修复 `tests/setup/install-plugin-bundles.test.mjs` 的 3 个历史失败（`Codex .codex/`、`Cursor .cursor/`、`OpenClaw skills/`）。

### 变更

- **11 阶段契约同步到测试和顶层文档**：`tests/meta-theory/07-contract-compliance.test.mjs`、`tests/meta-theory/12-ten-step-workflow.test.mjs`、`AGENTS.md`、`CLAUDE.md`、`canonical/agents/meta-conductor.md`、`canonical/skills/meta-theory/references/dev-governance.md`、`canonical/skills/meta-theory/references/ten-step-governance.md`。计数升级（`10 → 11`、终态 `6 → 7`），阶段数组末尾追加 `mirror`，zh-CN / en-US labels 各加一条 `镜像发布` / `Mirror Publish`。
- **discover-global-capabilities.mjs** — 新增 Cursor 平台扫描（skills + plugins）。
- **README 跨平台映射** — 在四语言 README（EN/ZH/JA/KO）中为 Codex、OpenClaw、Cursor 条目补充 hooks 说明。

### 已知问题

- `README.md` / `README.zh-CN.md` / `README.ja-JP.md` / `README.ko-KR.md` 正文和 Mermaid 图里仍在用 `mirror` 之前的 10 阶段叙述；四语 README 同步推迟到后续版本处理。
- 新克隆仓库首次跑 `meta:verify:all` 前必须先运行 `npm run meta:sync:global`，否则 `meta:check:global` 会在缺失 `~/.codex/skills/meta-theory/`（以及 `.cursor` / `.openclaw`）目录时硬失败。把这点写进 Getting Started 前置条件的任务已入队。

## [2.0.14] - 2026-04-20

### 新增

- **MCP Memory SessionEnd 自动保存 + 分层注入 (L1/L2/L3)**：两个互补的进度追踪机制，实现跨会话连续性。
  - **`scripts/install-mcp-memory-hooks.mjs`** — 扩展处理 Stop hook (`stop-save-progress.mjs`) 和 commands 目录 (`save-progress/`)。现在同时注册 SessionStart 和 Stop hook 到 `settings.json`。Stop hook 通过正则表达式从会话记录中自动提取已完成/待办任务，并持久化到 `.claude/project-task-state.json`。
  - **`canonical/runtime-assets/claude/hooks/stop-save-progress.mjs`** — Node.js Stop hook，读取会话记录，提取任务关键词（完成/搞定/新增/修复等），调用 `mcp_memory_global.py --mode save`。每次 Claude Code 会话结束后运行，始终退出 0。
  - **`canonical/runtime-assets/claude/memory-hooks/mcp_memory_global.py`** — 升级分层注入：
    - L1 紧凑：仅任务状态（约120字符）— 始终显示
    - L2 过滤：项目记忆（相关性 > 0.55，约400字符）— 上下文触发
    - L3 完整：最近记忆（约800字符）— 按需获取 via `--mode query-memories`
  - **`canonical/runtime-assets/claude/commands/save-progress/SKILL.md`** — 手动保存命令 (`/save-progress`)。允许用户精确控制时显式保存任务状态。
  - **中文友好限制**：`MIN_RELEVANCE=0.55`（针对中文嵌入模型下调），`MAX_LEN_COMPACT=120`，`MAX_LEN_L2=400`，`MAX_LEN_L3=800`。

### 修复

- **`scripts/install-mcp-memory-hooks.mjs` async + `fs` 导入 bug** — `copyCommandsDir()` 使用了 `fs.readdir()` 但导入的是同步 `fs` 模块，导致 "fs is not defined" 错误。通过从 `node:fs/promises` 导入 `readdir` 修复。同时修复了 `registered is not defined` 错误，正确捕获 `registerSessionStartHook()` 和 `registerStopHook()` 的返回值。

## [2.0.13] - 2026-04-20

### 新增

- **Layer 3 auto-start on setup**：运行 `node setup.mjs` 后自动在后台启动 MCP Memory Service（HTTP 模式），然后验证 `http://localhost:8000` 的健康端点。启动成功后创建平台特定的启动项（Windows 启动脚本 / macOS LaunchAgent / Linux XDG autostart）。整个过程非阻塞 — 失败时打印手动说明而不是中止安装。每种语言新增5个 i18n key（en / zh-CN / ja-JP / ko-KR）：`mcpMemoryAutoStarting`、`mcpMemoryAutoStarted`、`mcpMemoryAutoStartFailed`、`mcpMemoryAutoStartManual`、`mcpMemoryAutoStartBoot`。

- **Install Manifest Phase 4 — manifest驱动的卸载**：`scripts/uninstall.mjs` 现在优先使用安装清单而非文件系统扫描启发式。
  - 新增 `manifestEntryToFinding(entry)` 适配器，将 schema-v1 manifest 条目映射到 `planActions` 已消费的结构。
  - 新增 `findingsFromManifest({ scope, repoRoot })` 读取全局和/或项目清单。
  - `planActions()` 新增 `useManifest` 参数和 `--no-manifest` CLI 标志。
  - MSG 表格新增 `sourceManifest` / `sourceScan` 字符串（4种语言）。
  - 单元测试：`tests/setup/uninstall-manifest.test.mjs` 新增14个测试。

- **Install Manifest Phase 3 — 安装前预览 (MVP)**：`setup.mjs` 新增 `showExistingFootprint()`，在用户确认安装前显示磁盘上的现有 Meta_Kim 文件。
  - `scripts/sync-runtimes.mjs` 新增 `--json` 输出格式。
  - 3个新 i18n key：en / zh-CN / ja-JP / ko-KR（`footprintTitle`、`footprintFirstInstall`、`footprintRefreshNote`）。

- **Install Manifest Phase 2 — sync recorder 接入**：`sync-global-meta-theory.mjs` 和 `sync-runtimes.mjs` 现在将每次写入记录到安装清单。
  - `openRecorder()` 和 `recordSafe()` 包装器。
  - 15个新单元测试：`tests/setup/sync-runtimes-manifest.test.mjs`。

- **Install footprint + uninstaller (Phase 1)**：三个新脚本让用户完全了解 Meta_Kim 写入系统的内容并可逆。
  - **`scripts/install-manifest.mjs`** — Schema v1 + 9个分类（A–I）
  - **`scripts/footprint.mjs`** — `npm run meta:status` / `:json` / `:diff`
  - **`scripts/uninstall.mjs`** — `npm run meta:uninstall` / `:yes` / `:deep`

### 计划中

- **Install Manifest Phase 2 剩余部分** — `install-global-skills-all-runtimes.mjs` 和 `claude-settings-merge.mjs` 仍需接入 `openRecorder()` / `record()`。
- **Install Manifest Phase 3 后续** — 将"之前 footprint"升级为真正的 diff。
- **Install Manifest Phase 4 后续** — 将 `pip-package`、`mcp-server`、`git-hook` 建模为原生卸载操作。

### 修复

- **`scripts/claude-settings-merge.mjs` hookCommandNode 双转义问题** — Windows 路径双重 JSON 编码问题已修复。
- **MCP Memory Service 默认端口修正为 `8000`**（原为 `8888`）。更新了 `mcp_memory_global.py`、`config.template.json`、`install-mcp-memory-hooks.mjs`、`setup.mjs` 和所有4个 README 文件。
- **`setup.mjs` `runMcpMemoryHookInstaller` i18n + 进度 UX** — 内存 hook 安装步骤的国际化修复。
- **`scripts/install-mcp-memory-hooks.mjs` 控制台输出左对齐** — 移除了多余的缩进。
- **`scripts/sync-runtimes.mjs` 缺少 canonical 警告国际化** — 新增 en / zh-CN / ja-JP / ko-KR 翻译。

## [2.0.12] - 2026-04-18

### 新增

- **Third-party Dependencies README 章节**：所有4个 README（EN/zh-CN/ja-JP/ko-KR）新增第三方依赖章节，在 License 之前。
- **MCP Memory Service 默认端口修正**：从 `8888` 改为官方 `8000`。

### 修复

- **MCP Memory Service 健康检查** — 修正10处硬编码端口问题。

## [2.0.11] - 2026-04-17

### 新增

- **setup.mjs MCP Memory Service i18n + 进度 UX** — 内存 hook 安装步骤的国际化修复。

## [2.0.10] - 2026-04-16

### 新增

- **`--scope project|global|both`** 在 `setup.mjs --update` 和 `sync:runtimes` 中一致工作。
- **共享 i18n 模块** (`scripts/meta-kim-i18n.mjs`) 统一所有安装/更新字符串（4种语言）。
- **Plugin 预检查**：`install-global-skills-all-runtimes.mjs` 使用 `claude plugins list --json` 检测已安装插件。

### 修复

- `sync-runtimes.mjs` Codex 路径修正：`.claude/` → `.codex/`。
- graphify Windows 命令：`graphify` → `python -m graphify`。
- `--update` 模式现在提示选择安装范围（project/global/both）。
- `.gitignore` 正确忽略衍生目录。

## [1.4.0] - 2026-04-10

### 新增

- **`canonical/` 规范源码层**：运行时中性设计 + repo 追踪的 sync 清单 (`config/sync.json`) + 三个运行时配置（Claude、Codex、OpenClaw）。
- **本地激活配置** via `.meta-kim/local.overrides.json`。
- **`--targets` 支持** across `setup.mjs`、`sync:runtimes`、`sync:global:meta-theory`、`deps:install:all-runtimes`。
- **`--scope` 支持**：`--scope project` 写入 repo 本地目录，`--scope global` 写入运行时主目录。

### 变更

- `.claude/` 不再被视为规范源码层；Claude、Codex、OpenClaw 现在是对等的运行时投射。
- `setup.mjs` 现在保存机器本地运行时选择。
- 验证、MCP 运行时加载、迁移暂存和 meta-theory 测试现在从 `canonical/` 读取。

## [1.3.0] - 2026-04-10

### 新增

- **运行时 `dispatchEnvelopePacket` 治理**：非查询运行的所有权验证。
- **Repo 本地状态布局** under `.meta-kim/state/{profile}/`。
- **Operator 命令**：`index:runs`、`query:runs`、`rebuild:run-index`、`migrate:meta-kim`。

### 变更

- `discover:global` 现在优先重建 `.claude/capability-index/meta-kim-capabilities.json`。
- `doctor:governance` 现在报告跨层健康状态。
- 同步所有运行时治理文档到新的 run-index / dispatch-envelope / compaction 模型。

### 修复

- 填充 `README.ja-JP.md` 和 `README.ko-KR.md` 中之前缺失的 README 更新。

## [1.2.3] - 2026-04-04

### 文档

- **README（全部4种语言）**：移除 `<div align="center">` 包裹 fenced Mermaid 代码块，让 **Cursor** 能渲染图表；表格保留 `div` 居中。

## [1.2.2] - 2026-04-03

### 文档

- 对齐 **README.ja-JP.md** 和 **README.ko-KR.md** 与 **README.md** / **README.zh-CN.md**：共享锚点、工作流图、运行时/八智能体小图。
- 修复 **Mermaid** 布局：`flowchart TB` 改为 stacked `flowchart LR`。
- 所有4个 README 表格用 `<div align="center">` 包裹。
- **仓库结构**：ASCII tree 改为 path | description 表格。
- **JA/KO**：新增两层层工作流词汇表、`npx … meta-kim` 行。
- 文档 **Meta_Kim** (`node setup.mjs`) 为 **KimYx0207/findskill** 的规范安装路径。
- **`npx` 一次性入口**：`npx github:KimYx0207/Meta_Kim meta-kim`。

### 新增

- **Graphify** 可选集成：压缩代码知识图谱，`graphify:*` npm 脚本，Fetch 阶段自动检测钩子，所有语言 README 章节。

### 修复

- 统一 **findskill** 命名。
- 安装 **planning-with-files** from `skills/planning-with-files/`。
- 安装 **findskill** 根据平台选择目录。

### 变更

- 扩展 `config/contracts/workflow-contract.json` 形式化卡片治理。
- 新增 `scripts/validate-run-artifact.mjs`。
- 同步 README 到新的卡片/发牌人/沉默/总结模型。
- 对齐 `package.json` 与最新发布版本。

## [1.2.1] - 2026-04-02

### 变更

- 恢复两个根 README 文件为更完整的项目形态。
- 中文 README 以 `元` 概念重新为中心。
- 同步 `README.md`、`README.zh-CN.md`、`AGENTS.md`、`CLAUDE.md` 与当前项目设计。

### 新增

- `.claude/skills/meta-theory/references/dev-governance.md` 中的规范所有权优先治理规则。
- 显式能力差距解决阶梯。
- 协议优先调度要求。
- 并行性要求。
- Evolution 回写规则。

### 同步

- 同步强化的规范 `meta-theory` skill 和 `dev-governance` 参考到 Codex 镜像、OpenClaw 镜像、共享 skills、workspace packs。

## [1.2.0] - 2026-03-28

### 变更

- 重命名私有 `meta/` 目录为 `docs/`。
- 同步所有 README 和文档文件。
- 移除过时的 `factory/` 引用。
- 添加 `config/contracts/` 到仓库树文档。
- 修复 `README.zh-CN.md` 中的重复步骤编号。
- 移除 `CLAUDE.md` 中的硬编码全局能力计数。
- 添加 `.claude/capability-index/` 到 `.gitignore`。
- 清理 `docs/runtime-capability-matrix.md` 中的本地 Windows 路径。

## [1.1.0] - 2026-03-27

### 新增

- 智能体版本控制（每个智能体的 YAML frontmatter `version` 字段）。
- 改进 CLI 输出 UX。

### 修复

- 强制单源 meta 工作流验证。
- 强制 OpenClaw 智能体注册检查。
- 强化 meta 运行时发现和 OpenClaw 智能体注册指导。

## [1.0.0] - 2026-03-22

### 新增

- 公开开源发布面。
- 8个旗舰专业 meta-agent 配置（`meta-warden` 到 `meta-scout`）。
- 跨运行时同步工具：`sync:runtimes`、`validate`、`eval:agents`。
- 全局能力发现 via `discover:global`。
- OpenClaw workspace 系列。
- Codex 智能体镜像在 `.codex/agents/*.toml`。
- 共享 skill 镜像层。
- 智能体健康报告脚本。
- MIT 许可证。

### 变更

- 将发布文档折叠到根 README 文件。
- 为开源发布精简 foundry 输出。
- 确定初始公开发布面。

## [0.5.0] - 2026-03-21

### 新增

- 跨运行时覆盖审计。
- 运行时能力矩阵。
- 仓库地图。
- Claude Code、OpenClaw、Codex 便携式运行时包。
- OpenClaw bootstrap 和本地认证资源。
- 运行时评估脚本。
- 运行时指南中文翻译。
- 论文参考和 DOI。

### 修复

- Bootstrap OpenClaw 本地认证。
- 强化跨运行时智能体和 skill 便携性。

## [0.1.0] - 2026-03-17

### 新增

- 初始项目结构作为 Claude Code 项目。
- 将 skills 转换为 agents 并合并 SPEC 内容到智能体定义。
- Meta_Kim 架构基线快照。
