# Meta_Kim 仓库地图

这份文档回答两个问题：

1. 每个目录是干嘛的
2. 哪些文件是主源，哪些文件只是运行时投影

结论先说：

- 理论与治理主源不再放在 `docs/` 叙事文档中。主源是 `canonical/agents/`、`canonical/skills/meta-theory/`、`config/contracts/`、`config/capability-index/`。
- `.claude/`、`.codex/`、`.cursor/`、`openclaw/` 是运行时镜像 / 投影目录，不是第二套主源。
- 能力索引 Fetch 顺序是：仓库 canonical `config/capability-index/` -> runtime mirror -> local inventory -> fallback。
- 业务工作流是 11 阶段：`direction -> planning -> execution -> review -> meta_review -> revision -> verify -> summary -> feedback -> evolve -> mirror`。

## 一、根目录

### 目录

| 路径 | 作用 |
| --- | --- |
| `canonical/` | agent、skill、runtime assets 的长期主源 |
| `config/contracts/` | 运行纪律、门禁、业务工作流契约主源 |
| `config/capability-index/` | 仓库级能力索引主源；运行时 capability-index 目录应视为镜像 |
| `.agents/` | Codex 兼容的项目级 skill 投影目录 |
| `.claude/` | Claude Code 运行时投影目录，包含 agents、skills、hooks、MCP、capability-index mirror |
| `.codex/` | Codex custom agents、skills、commands、capability-index mirror |
| `.cursor/` | Cursor agents、skills、MCP、capability-index mirror |
| `codex/` | Codex 配置示例目录，来自 canonical runtime assets |
| `docs/` | 仓库说明、能力矩阵、覆盖审计；不承担理论主源职责 |
| `openclaw/` | OpenClaw 运行时投影目录，包含 workspaces、skills、hooks、capability-index mirror |
| `scripts/` | 同步、校验、验收、MCP、迁移、本地运行时准备脚本 |
| `graphify-out/` | 代码知识图谱输出；复杂架构 / 代码问题优先读 `GRAPH_REPORT.md` |

### 文件

| 路径 | 作用 |
| --- | --- |
| `.gitignore` | Git 忽略规则，避免提交不该跟踪的本地文件 |
| `.mcp.json` | Claude Code 项目级 MCP 配置投影 |
| `AGENTS.md` | Codex / 跨运行时总入口说明 |
| `CLAUDE.md` | Claude Code 仓库规则与使用说明 |
| `LICENSE` | 项目许可证，当前为 MIT |
| `package.json` | npm 脚本、依赖、项目元信息 |
| `package-lock.json` | npm 精确依赖锁文件 |
| `README.md` | 英文仓库总说明、快速开始、命令入口 |
| `README.zh-CN.md` | 中文仓库总说明 |

## 二、canonical 与 config 主源

| 路径 | 作用 |
| --- | --- |
| `canonical/agents/*.md` | 8 个 meta agent 的长期主源 |
| `canonical/skills/meta-theory/SKILL.md` | `meta-theory` skill 的长期主源 |
| `canonical/skills/meta-theory/references/*.md` | meta-theory 的模型可读参考材料主源 |
| `canonical/runtime-assets/*` | 各运行时配置、hook、命令、模板的主源素材 |
| `config/contracts/workflow-contract.json` | 11 阶段业务工作流、run discipline、gate contract 主源 |
| `config/capability-index/` | 仓库能力索引主源；运行时 mirror 应从这里或发现器结果同步 |

## 三、运行时投影目录

### `.claude/`

| 路径 | 作用 |
| --- | --- |
| `.claude/agents/` | Claude Code agent 投影，由同步脚本生成 |
| `.claude/skills/meta-theory/` | Claude Code skill 投影，由同步脚本生成 |
| `.claude/hooks/` | Claude Code hook 投影，来自 canonical runtime assets |
| `.claude/settings.json` | Claude Code 权限与 hook 配置投影 |
| `.claude/capability-index/` | Claude Code 能力索引镜像；包含 `meta-kim-capabilities.json` |

### `.codex/` 与 `.agents/`

| 路径 | 作用 |
| --- | --- |
| `.codex/agents/*.toml` | Codex custom-agent 投影，和 8 个 meta agent 对应 |
| `.codex/skills/meta-theory/SKILL.md` | Codex 兼容 skill 镜像 |
| `.codex/skills/meta-theory/references/*` | Codex 兼容 reference 镜像 |
| `.codex/commands/meta-theory.md` | Codex slash command 投影 |
| `.codex/capability-index/` | Codex 能力索引镜像 |
| `.agents/skills/meta-theory/` | Codex / 兼容运行时项目级 skill 入口（存在时视为投影） |
| `codex/config.toml.example` | Codex MCP、sandbox、approval、skills 配置示例 |

### `.cursor/`

| 路径 | 作用 |
| --- | --- |
| `.cursor/agents/*.md` | Cursor agent 投影 |
| `.cursor/skills/meta-theory/` | Cursor skill 投影 |
| `.cursor/mcp.json` | Cursor MCP 配置投影 |
| `.cursor/capability-index/` | Cursor 能力索引镜像 |

### `openclaw/`

| 路径 | 作用 |
| --- | --- |
| `openclaw/openclaw.template.json` | OpenClaw 通用配置模板，来自 canonical runtime assets |
| `openclaw/openclaw.local.json` | 当前机器的本地 OpenClaw 配置；不要当作跨机器主源 |
| `openclaw/skills/meta-theory/` | OpenClaw installable skill 镜像 |
| `openclaw/workspaces/*` | 8 个 meta agent 的 OpenClaw workspace 投影 |
| `openclaw/capability-index/` | OpenClaw 能力索引镜像 |

每个 `openclaw/workspaces/<agent>/` 通常包含：

| 文件名 | 作用 |
| --- | --- |
| `BOOT.md` | OpenClaw 启动入口 |
| `BOOTSTRAP.md` | 冷启动阅读顺序 |
| `IDENTITY.md` | agent 身份卡 |
| `MEMORY.md` | 长期记忆策略 |
| `USER.md` | 用户长期上下文占位 |
| `SOUL.md` | agent 主提示词投影 |
| `AGENTS.md` | 团队目录 |
| `TOOLS.md` | OpenClaw 运行时与 skill 约定 |
| `HEARTBEAT.md` | 心跳 / 定时任务约定 |
| `memory/README.md` | session memory 写入目录说明 |
| `skills/meta-theory/SKILL.md` | workspace 内可用的 `meta-theory` skill 镜像 |

## 四、docs/

| 路径 | 作用 |
| --- | --- |
| `docs/repo-map.md` | 这份仓库地图 |
| `docs/runtime-capability-matrix.md` | Claude Code / Codex / OpenClaw / Cursor 的能力映射矩阵 |
| `docs/runtime-coverage-audit.md` | 能力面覆盖与宿主限制审计 |
| `docs/QUICKSTART.md` | 快速使用说明 |
| `docs/protocols/` | 协议补充说明 |
| `docs/research/` | 研究与调研材料 |

`docs/` 可以解释架构，但不能覆盖 canonical 主源。需要改变 agent 行为、meta-theory、workflow contract 或能力索引时，先改对应 canonical/config 主源，再同步运行时投影。

## 五、能力索引 Fetch 顺序

当需要按能力派发时，按以下顺序查找：

1. 仓库 canonical：`config/capability-index/`
2. 运行时镜像：`.claude/capability-index/`、`.codex/capability-index/`、`.cursor/capability-index/`、`openclaw/capability-index/`
3. 本地 runtime inventory：`.meta-kim/state/{profile}/capability-index/global-capabilities.json`
4. fallback：明确声明没有匹配能力，再使用通用执行或创建能力的流程

不要绕过 Fetch 直接硬编码某个 agent 名称。

## 六、推荐维护顺序

1. 先改主源：`canonical/agents/`、`canonical/skills/meta-theory/`、`config/contracts/`、`config/capability-index/`
2. 运行 `npm run meta:sync`
3. 运行 `npm run discover:global`
4. 运行 `npm run meta:validate`
5. 需要完整发布信心时运行 `npm run meta:verify:all`

旧文档若仍引用已移除的理论叙事文件，应改指向 `canonical/skills/meta-theory/`。
