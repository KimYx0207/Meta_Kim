# 更新日志

所有 Meta_Kim 的重要变更都会记录在此。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
发布新版本时，请在顶部（旧版本之前）添加新的 **`## [版本号] - YYYY-MM-DD`** 部分。

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

- **Layer 3 auto-start on setup**：运行 `node setup.mjs` 后自动在后台启动 MCP Memory Service（HTTP 模式），然后验证 `http://localhost:8000` 的健康端点。启动成功后创建平台特定的启动项（Windows 启动脚本 / macOS LaunchAgent / Linux XDG autostart）。整个过程非阻塞 — 失败时打印手动说明而不是中止安装。每种语言新增5个 i18n key（en / zh-CN / ja-JP / ko-KR）。

- **Install Manifest Phase 4 — manifest驱动的卸载**：`scripts/uninstall.mjs` 现在优先使用安装清单而非文件系统扫描启发式。

- **Install Manifest Phase 3 — 安装前预览**：`setup.mjs` 新增 `showExistingFootprint()`，在用户确认安装前显示磁盘上的现有 Meta_Kim 文件。

- **Install Manifest Phase 2 — sync recorder 接入**：`sync-global-meta-theory.mjs` 和 `sync-runtimes.mjs` 现在将每次写入记录到安装清单。

- **Install footprint + uninstaller (Phase 1)**：三个新脚本让用户完全了解 Meta_Kim 写入系统的内容并可逆。

### 计划中

- **Install Manifest Phase 2 剩余部分** — `install-global-skills-all-runtimes.mjs` 和 `claude-settings-merge.mjs` 仍需接入 `openRecorder()` / `record()`。
- **Install Manifest Phase 3 后续** — 将"之前 footprint"升级为真正的 diff。
- **Install Manifest Phase 4 后续** — 将 `pip-package`、`mcp-server`、`git-hook` 建模为原生卸载操作。

### 修复

- **`scripts/claude-settings-merge.mjs` hookCommandNode 双转义问题** — Windows 路径双重 JSON 编码问题已修复。
- **MCP Memory Service 默认端口修正为 `8000`**（原为 `8888`）。
- **`setup.mjs` `runMcpMemoryHookInstaller` i18n + 进度 UX** — 内存 hook 安装步骤的国际化修复。
- **`scripts/install-mcp-memory-hooks.mjs` 控制台输出左对齐** — 移除了多余的缩进。
- **`scripts/sync-runtimes.mjs` 缺少 canonical 警告国际化** — 新增 en / zh-CN / ja-JP / ko-KR 翻译。
