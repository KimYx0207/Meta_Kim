# Meta_Kim 覆盖审计

这份文档回答两个问题：

1. Meta_Kim 现在到底覆盖了哪些运行时能力面？
2. 哪些东西属于宿主产品本身，不能靠仓库文件硬覆盖？

## 一、审计口径

这里说的“覆盖”，只统计和 **做事能力** 直接相关、且可以由仓库资产控制的能力面：

- 角色入口
- 子代理 / 自定义代理
- Skill
- MCP
- Hook / 守卫
- Workspace 启动与记忆
- 多代理路由
- Sandbox / Approval 配置入口
- 本地验证与冒烟

不把这些宿主级能力算进“仓库可覆盖”：

- 登录、授权、OAuth、API Key 生命周期
- 桌面 UI、聊天历史侧边栏、通知
- 各家产品自己的云端状态
- CLI 二进制本身是否安装

## 二、总结论

### 已覆盖

- Claude Code 的项目级 `subagents + skills + hooks + MCP`
- Codex 的仓库级 `AGENTS.md + custom agents + project skills + MCP config + sandbox/approval config example`
- OpenClaw 的 `workspace family + skill + bundled hooks + boot + memory + local auth bootstrap + agent-to-agent`
- Cursor 的项目级 `agents + skills + MCP config`

### 不能诚实宣称“仓库全覆盖”的部分

- Claude Code、Codex、OpenClaw、Cursor 的账号体系、桌面 UI、云端状态
- OpenClaw 的 hook 启用结果仍依赖宿主 OpenClaw CLI/网关版本
- Codex 与 Claude 的最终工具面仍受宿主会话参数、审批策略、运行环境影响

## 三、能力面逐项审计

| 能力面 | Claude Code | Codex | OpenClaw | Cursor | Meta_Kim 当前状态 |
| --- | --- | --- | --- | --- | --- |
| 理论总源 | 原生可读项目文档 | 原生可读项目文档 | 原生 workspace 文档 | 原生可读项目文档 | 已覆盖，主源为 `docs/meta.md` |
| 角色入口 | `CLAUDE.md` + `.claude/agents/` | `AGENTS.md` + `.codex/agents/` | `workspaces/<agent>/SOUL.md` 等 | `.cursor/agents/*.md`（项目级） | 已覆盖 |
| 子代理 / 自定义代理 | 原生 subagents | 原生 custom agents / subagents | 原生多 agent workspace | Cursor 原生 agent rules | 已覆盖 |
| 项目级 Skill | `.claude/skills/` | `.agents/skills/` | workspace skill + installable skill | `.agents/skills/`（通用路径） | 已覆盖 |
| 兼容 Skill 镜像 | 不需要 | `.codex/skills/` 兼容镜像 | `openclaw/skills/` 镜像 | `~/.cursor/skills/` 全局 | 已覆盖 |
| MCP | `.mcp.json` | `config.toml` 例子 | 共享同一 MCP server | `.cursor/mcp.json` | 已覆盖 |
| Hook / 守卫 | `.claude/settings.json` (12 events) | `.codex/hooks.json` (5 events) | Plugin SDK 28 hooks + bundled hooks | `.cursor/hooks.json` (4 events) | 已覆盖，但不是 1:1 同构 |
| 启动文件 | `CLAUDE.md` / agent prompt | `AGENTS.md` / custom agent prompt | `BOOT.md` / `BOOTSTRAP.md` / `IDENTITY.md` | `.cursorrules` / agent prompt | 已覆盖 |
| 记忆入口 | 文档式约定 | 宿主上下文 + SQLite/agents state | `MEMORY.md` + `session-memory` hook | 文档式约定 | 已覆盖 |
| 多代理路由 | Claude 原生委派 | Codex subagents | OpenClaw agent-to-agent | Cursor 原生 agent 委派 | 已覆盖 |
| Sandbox / Approval | Claude 原生 permission / tool control | `sandbox_mode` / `approval_policy` | 宿主网关与工具约束 | Cursor 原生 approval | 已覆盖到仓库配置入口 |
| 本地验证 | `claude agents` + schema eval | `codex exec --json` smoke | `openclaw config validate` + 本地 agent smoke | `.cursor/agents/` 存在性检查 | 已覆盖 |

## 四、仓库内对应位置

- Claude Code:
  - `CLAUDE.md`
  - `.claude/agents/*.md`
  - `.claude/skills/meta-theory/SKILL.md`
  - `.claude/settings.json`
  - `.mcp.json`
- Codex:
  - `AGENTS.md`
  - `.codex/agents/*.toml`
  - `.agents/skills/meta-theory/SKILL.md`
  - `.agents/skills/meta-theory/agents/openai.yaml`
  - `.codex/skills/meta-theory.md`
  - `codex/config.toml.example`
- OpenClaw:
  - `openclaw/openclaw.template.json`
  - `openclaw/workspaces/*/BOOT.md`
  - `openclaw/workspaces/*/BOOTSTRAP.md`
  - `openclaw/workspaces/*/MEMORY.md`
  - `openclaw/workspaces/*/memory/README.md`
  - `openclaw/workspaces/*/SOUL.md`
  - `openclaw/workspaces/*/AGENTS.md`
  - `openclaw/workspaces/*/TOOLS.md`
  - `openclaw/workspaces/*/skills/meta-theory/SKILL.md`
- Cursor:
  - `.cursor/agents/*.md`
  - `.cursor/skills/meta-theory/SKILL.md`
  - `.cursor/mcp.json`

## 五、最终判断

如果标准是：

- “用于做事的元架构能力面必须都落在仓库里”

那么当前版本可以判定为：

**已覆盖。**

如果标准是：

- “三家产品所有宿主功能 100% 完全等价”

那么这个目标本身就不成立，任何仓库都做不到。

Meta_Kim 现在做的是正确的版本：

- 把可仓库化的能力面全部仓库化
- 把不能同构的宿主能力明确标注出来
- 用 `sync + validate + eval` 做持续校验
