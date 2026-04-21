# Meta_Kim 运行时能力矩阵

Meta_Kim 同时对接 Claude Code、Codex、OpenClaw、Cursor，但四者不是同一种产品，不能假装完全同构。

正确做法不是硬说”四端完全一样”，而是：

- 一个理论总源
- 一个 agent 总源
- 一个 skill 总源
- 每个运行时各自走原生入口
- 没有 1:1 对应项时明确标注
- **新增**：全局能力索引（跨平台发现与整合）

## 一、核心能力映射

| 能力 | Claude Code | Codex | OpenClaw | Cursor | Meta_Kim 落地 |
| --- | --- | --- | --- | --- | --- |
| 理论总源 | 可读仓库文档 | 可读仓库文档 | 可读 workspace 文档 | 可读仓库文档 | `docs/meta.md` |
| 角色 / 代理入口 | `.claude/agents/*.md` + `~/.claude/agents/*.md` | `.codex/agents/*.toml` + `~/.codex/agents/*.toml` | `openclaw/workspaces/<agent>/` + `~/.openclaw/agents/` | `.cursor/agents/*.md`（仅项目级，无全局 agent 目录） | Claude agent 为主源，全局能力通过发现器整合 |
| 子代理 / 多代理 | 原生 subagents | 原生 custom agents / subagents | 原生多 agent + agent-to-agent | Cursor 原生 agent rules | 8 个 meta agent 四端全映射，全局 agents 按需调用 |
| Skill | `.claude/skills/<name>/SKILL.md` + `~/.claude/skills/` | `.agents/skills/<name>/SKILL.md` + `~/.codex/skills/` | workspace skill + installable skill + `~/.openclaw/skills/` | `.agents/skills/<name>/SKILL.md` + `~/.cursor/skills/` | Claude skill 为主源，镜像到其他运行时 |
| Hook / 守卫 | `.claude/settings.json` hooks (12 events) + `~/.claude/hooks/` | `.codex/hooks.json` (5 events, v0.117.0+) | Plugin SDK 28 hooks + bundled hooks | `.cursor/hooks.json` (4 events, 有bugs) | 四端均有原生 hook，格式各异 |
| 记忆 | 文档与会话上下文 | 宿主状态 / SQLite | `MEMORY.md` + `session-memory` hook | 文档与会话上下文 | 元记忆策略主源写在 agent / skill 中 |
| **全局能力索引** | **`npm run discover:global`** | **`npm run discover:global`** | **`npm run discover:global`** | **`npm run discover:global`** | **`.claude/capability-index/global-capabilities.json`** |

## 一.五、全局能力发现（新增）

Meta_Kim 现在支持跨平台全局能力发现：

```bash
# 查看当前全局能力数量
npm run discover:global

# 查看详细列表
npm run discover:global -- --json
```

功能：
- **Claude Code**：扫描 `~/.claude/agents/`, `~/.claude/skills/`, `~/.claude/hooks/`, `~/.claude/plugins/`, `~/.claude/commands/`
- **OpenClaw**：扫描 `~/.openclaw/` 下的 agents/skills/hooks/commands
- **Codex**：扫描 `~/.codex/` 下的 agents/skills/commands
- **Cursor**：扫描 `~/.cursor/skills/`, `~/.cursor/plugins/`（无全局 agent 目录）
- 生成统一的能力索引 `.claude/capability-index/global-capabilities.json`

**发现的能力类型**：
- **Agents**：可复用的专业agents（如ai-engineer, backend-architect, code-reviewer）
- **Skills**：可触发的技能（如agent-browser, planning-with-files, claudeception）
- **Hooks**：PreToolUse/PostToolUse/UserPromptSubmit/SessionStart hooks
- **Plugins**：Claude Code plugins（LSP servers, tool extensions等）
- **Commands**：Slash commands（commit, debug, test-driven-development等）

**获取最新数量**：
运行 `npm run discover:global` 会输出当前扫描到的能力数量统计：
```
📊 Global Capability Summary
🔹 Claude Code (~/.claude)
   agents: [当前数量]
   skills: [当前数量]
   hooks: [当前数量]
   plugins: [当前数量]
   commands: [当前数量]
```

元架构的 Fetch 阶段会自动：
1. 先检查索引是否存在
2. 不存在则运行发现器
3. 将全局能力纳入匹配范围
4. 按平台差异调用（Claude Code用subagent_type，OpenClaw用sessions_send）

**典型使用场景**：
- 用户说"review code" → 匹配到 `everything-claude-code:code-reviewer` agent
- 用户说"帮我规划" → 匹配到 `planning-with-files` skill
- 用户说"提交代码" → 匹配到 `commit` command

## 二、主源位置

- 理论主源：`docs/meta.md`
- Claude agent 主源：`.claude/agents/*.md`
- Claude skill 主源：`.claude/skills/meta-theory/SKILL.md`
- **全局能力索引**：`.claude/capability-index/global-capabilities.json`

## 三、派生产物

- Codex custom agents：`.codex/agents/*.toml`
- Codex project skill：`.agents/skills/meta-theory/SKILL.md`
- Codex 兼容 skill：`.codex/skills/meta-theory.md`
- OpenClaw workspaces：`openclaw/workspaces/*`
- OpenClaw installable skill：`openclaw/skills/meta-theory.md`
- OpenClaw config：`openclaw/openclaw.template.json`

## 四、标准流程

每次修改 agent prompt 或共享 skill 后：

1. 先改主源文件。
2. 运行 `npm run meta:sync`。
3. 运行 `npm run meta:check:global`（新增：更新全局能力索引）。
4. 运行 `npm run meta:validate`。
5. 日常运行 `npm run meta:eval:agents`（no-LLM smoke）。
6. 需要真实 runtime prompt 验收时运行 `npm run meta:eval:agents:live`。
7. 如果运行时契约变化，再更新 `README.md`、`CLAUDE.md`、`AGENTS.md`。

## 五、行为一致性对照表

这张表不是”看起来统一”，而是四端最少必须对齐的**行为约束**。

| parity item | Claude Code | Codex | OpenClaw | Cursor | 必须保持一致的判定 |
| --- | --- | --- | --- | --- | --- |
| trigger parity | 通过 canonical skill + hook / prompt discipline 触发 | 通过 project instructions + custom agents / runtime adapter 触发 | 通过 workspace boot + hooks 触发 | 通过 project rules + agent rules 触发 | 都必须先产出 `taskClassification`，再决定 `query / simple_exec / complex_dev / meta_analysis / proposal_review / rhythm` |
| card parity | Thinking + protocol packets 决定发牌 | project skill / agents / adapters 决定发牌 | workspace / agent flow 决定发牌 | project skill / agent rules 决定发牌 | 都必须能产出等价 `cardPlanPacket`，把发牌员、牌、交付壳、抑制理由显式化 |
| silence parity | Warden/Conductor 通过 gate + prompt discipline 留白 | adapter / validator 控制 no-card 与 defer | workspace / runtime gate 控制留白 | project rules 控制留白 | 都必须支持 `noInterventionPreferred`、`silenceDecision`、`reasonForSilence`，不能把”不打断”当成漏掉 |
| control-decision parity | skip / interrupt / override 由 hook + governance owner 驱动 | validator / adapter / agent decision 驱动 | runtime hooks + governance owner 驱动 | agent rules 驱动 | 都必须把 `skipReason`、`interruptReason`、`overrideReason`、`insertedGovernanceOwner` 结构化记录，并声明如何回主链 |
| shell parity | Claude 输出按受众壳适配 | Codex 输出按受众壳适配 | OpenClaw 输出按受众壳适配 | Cursor 输出按受众壳适配 | 都必须区分意图核与 `deliveryShell`，同一核可换壳，不可把内容和壳绑死 |
| hook parity | `.claude/settings.json` 原生 hooks (12 events) | `.codex/hooks.json` 原生 hooks (5 events) | Plugin SDK 28 hooks + `openclaw.template.json` | `.cursor/hooks.json` 原生 hooks (4 events) | 四端均有原生 hook，危险命令阻断、上下文注入、结束前审计必须等价，不要求文件形态相同 |
| review parity | specialist + warden/prism 审核 | custom agent / subagent 审核 | agent-to-agent / local workspace 审核 | agent rules 审核 | Review 都必须产出 `reviewPacket.findings[]`，不能只给 PASS/FAIL |
| verification parity | 验证 hook + agent 复核 | script / subagent 复核 | workspace verification flow | agent rules 复核 | Verify 都必须消费 `revisionResponses` 和 `verificationResults`，并显式 `closeFindings` |
| stop condition parity | hook / gate 阻断公开完成态 | validator / adapter 阻断公开完成态 | hook / runtime gate 阻断公开完成态 | agent rules 阻断公开完成态 | 未 `verifyPassed`、未 `summaryClosed`、交付链未闭合时，四端都不得标记 final public-ready |
| writeback parity | 直接写 canonical 资产 | 写 canonical 后 sync mirror | 写 canonical 后 sync workspace mirror | 写 canonical 后 sync mirror | Evolution 都必须给出 `writebackDecision = writeback|none`，禁止静默跳过 |
| run artifact parity | 可产出真实 run packet 并校验 | 可产出真实 run packet 并校验 | 可产出真实 run packet 并校验 | 可产出真实 run packet 并校验 | 四端都必须接受同一套 `validate-run-artifact` 链路校验，而不是只过静态字段检查 |

## 六、漂移检测

README 只能解释口径，不能承担一致性本身。真正防漂移要靠：

- canonical source 固定为 `canonical/agents/*.md`、`canonical/skills/meta-theory/SKILL.md`、`config/contracts/workflow-contract.json`
- `npm run meta:sync` 生成 Codex / OpenClaw mirrors
- `npm run meta:validate` 检查 mirror 是否与 canonical 一致
- `npm run meta:eval:agents` 做轻量 runtime smoke
- `npm run meta:eval:agents:live` 做真实 prompt-backed runtime acceptance

如果某一端只能在 README 里声明“等价”，但 validator 和 smoke/live acceptance 都无法证明，那它就不算真正等价。
