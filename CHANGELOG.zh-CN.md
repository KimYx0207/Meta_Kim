# 更新日志

> 🇺🇸 [English](./CHANGELOG.md) | 中文版

所有 Meta_Kim 的重要变更都会记录在此。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
发布新版本时，请在顶部（旧版本之前）添加新的 **`## [版本号] - YYYY-MM-DD`** 部分。

## [未发布]

### 修复

- **四端 hooks 纠正** — 四个平台（Claude Code、Codex、OpenClaw、Cursor）均有原生 hooks 系统。此前文档错误标注仅 Claude Code 有 hooks。Codex 支持 `hooks.json`（5 个事件，v0.117.0+），OpenClaw 支持 Plugin SDK hooks（28 个），Cursor 支持 `hooks.json`（4 个事件）。已更新 `runtime-capability-matrix.md`、`runtime-coverage-audit.md`、`distribution-matrix.md` 及四语言 README。
- **PWF hook 联合部署** — `install-global-skills-all-runtimes.mjs` 现在自动部署 planning-with-files 生命周期 hooks 到 Codex（`.codex/hooks/` + `hooks.json`）和 Cursor（`.cursor/hooks/` + `hooks.json`）。
- **Superpowers 稀疏回退** — 新增 `fallbackContentDir` 逻辑，当平台子目录（`.codex/`、`.cursor/`）内容过少时自动回退到 `skills/` 主内容目录。
- **discover-global-capabilities.mjs** — 新增 Cursor 平台扫描（skills + plugins）。
- **README 跨平台映射** — 在四语言 README（EN/ZH/JA/KO）中为 Codex、OpenClaw、Cursor 条目补充 hooks 说明。

## [2.0.15] - 2026-04-20

### 新增

- **`mirror` 作为业务工作流的第 11 个阶段** — `config/contracts/workflow-contract.json` 早已把 `mirror`（镜像发布 / Mirror Publish）声明为 `evolve` 之后的终态阶段；本次发布补齐所有依赖测试和文档，使三方同步到 11 阶段契约。同步后状态：`phases.length = 11`、`terminalPhases.length = 7`、`labels.{zh-CN,en-US}` 各有 11 条，`tests/meta-theory/07-contract-compliance.test.mjs` 与 `tests/meta-theory/12-ten-step-workflow.test.mjs` 不再 flaky。

### 修复

- **`install-plugin-bundles` dry-run 状态串味** — `scripts/install-global-skills-all-runtimes.mjs`（1576–1583 行）在 `--dry-run` 模式下也会走"目录已存在就跳过"的幂等短路，导致 `obra/superpowers` 之类插件包的 sparse-checkout 预览命令在目标目录已缓存的机器上永远不会打印。单行 patch 加 `!dryRun &&`，让 dry-run 永远展示命令，真实执行的幂等性保持不变。修复 `tests/setup/install-plugin-bundles.test.mjs` 的 3 个历史失败（`Codex .codex/`、`Cursor .cursor/`、`OpenClaw skills/`）。

### 变更

- **11 阶段契约同步到测试和顶层文档**：`tests/meta-theory/07-contract-compliance.test.mjs`、`tests/meta-theory/12-ten-step-workflow.test.mjs`、`AGENTS.md`、`CLAUDE.md`、`canonical/agents/meta-conductor.md`、`canonical/skills/meta-theory/references/dev-governance.md`、`canonical/skills/meta-theory/references/ten-step-governance.md`。计数升级（`10 → 11`、终态 `6 → 7`），阶段数组末尾追加 `mirror`，zh-CN / en-US labels 各加一条 `镜像发布` / `Mirror Publish`。

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
