# 元兵工厂实施计划

> 日期：2026-03-17
> 前置依赖：`analysis/infrastructure-meta-split.md`（四引擎分析已通过）
> 状态：待用户审批后执行

## 总览

| 专精元 | 覆盖维度 | 状态 |
|--------|----------|------|
| Genesis（灵魂元） | 提示词 + 规则基线 | 🔧 瘦身（已存在） |
| Artisan（技艺元） | 技能 + 工具 | 🆕 新建 |
| Sentinel（哨兵元） | 安全 + 权限 | 🆕 新建 |
| Librarian（典藏元） | 记忆 + 知识 | 🆕 新建 |
| Conductor（编排元） | 工作流 | ✅ 不变（已存在） |
| Forge（旧灵魂工程师） | — | ❌ 退役 |

## Step 1: 创建新 agent 完整工作空间（3 个新 agent）

每个新 agent 需要 7 个文件 + 1 个目录：

### 1.1 Artisan（技艺元）

创建 `~/.openclaw/workspace-artisan/`：
- [ ] `SOUL.md` — 完全唯一设计（技能匹配 + 工具选择 + MCP 服务器匹配）
- [ ] `IDENTITY.md` — Name: Artisan, Emoji: 🎨, Vibe: 精准高效的技能猎手
- [ ] `HEARTBEAT.md` — ON-DEMAND 模式，心跳时检查 Warden 任务
- [ ] `AGENTS.md` — team-meta 成员列表 + 通信协议
- [ ] `TOOLS.md` — 工具备注模板
- [ ] `USER.md` — 老金信息（共享模板）
- [ ] `BOOTSTRAP.md` — 首次引导（共享模板）
- [ ] `memory/` — 空目录

### 1.2 Sentinel（哨兵元）

创建 `~/.openclaw/workspace-sentinel/`：
- [ ] `SOUL.md` — 完全唯一设计（Hook 设计 + 安全规则 + 权限边界 + 回滚机制）
- [ ] `IDENTITY.md` — Name: Sentinel, Emoji: 🛡️, Vibe: 严谨冷静的安全守卫
- [ ] `HEARTBEAT.md` — ON-DEMAND 模式
- [ ] `AGENTS.md` — team-meta 成员列表 + 通信协议
- [ ] `TOOLS.md` — 工具备注模板
- [ ] `USER.md` — 老金信息（共享模板）
- [ ] `BOOTSTRAP.md` — 首次引导（共享模板）
- [ ] `memory/` — 空目录

### 1.3 Librarian（典藏元）

创建 `~/.openclaw/workspace-librarian/`：
- [ ] `SOUL.md` — 完全唯一设计（MEMORY.md 策略 + 知识持久化 + 跨会话 continuity）
- [ ] `IDENTITY.md` — Name: Librarian, Emoji: 📚, Vibe: 细致周到的知识管理者
- [ ] `HEARTBEAT.md` — ON-DEMAND 模式
- [ ] `AGENTS.md` — team-meta 成员列表 + 通信协议
- [ ] `TOOLS.md` — 工具备注模板
- [ ] `USER.md` — 老金信息（共享模板）
- [ ] `BOOTSTRAP.md` — 首次引导（共享模板）
- [ ] `memory/` — 空目录

### 1.4 Genesis SOUL.md 瘦身

修改 `~/.openclaw/workspace-genesis/SOUL.md`：
- [ ] 删除"平台能力匹配规则"段落（→ Artisan 职责）
- [ ] 删除"Security Design Responsibilities"段落（→ Sentinel 职责）
- [ ] 删除双平台能力地图中的工具/记忆细节（→ Artisan / Librarian 职责）
- [ ] 保留：Core Truths, Your Role, Thinking Framework, SOUL.md 设计蓝图, 压力测试方法论, Decision Rules, Anti-AI-Slop, Output Quality, Deliverable Flow
- [ ] 新增 Collaboration 段：明确与 Artisan/Sentinel/Librarian 的接口

### 1.5 Genesis 补全缺失文件

当前 Genesis workspace 只有 SOUL.md，需补全：
- [ ] `IDENTITY.md` — Name: Genesis, Emoji: 🧬, Vibe: 精密有主见的灵魂工程师
- [ ] `HEARTBEAT.md` — ON-DEMAND 模式
- [ ] `AGENTS.md` — team-meta 更新后的成员列表
- [ ] `TOOLS.md` — 工具备注模板
- [ ] `USER.md` — 老金信息（共享模板）
- [ ] `BOOTSTRAP.md` — 首次引导（共享模板）
- [ ] `memory/` — 空目录

## Step 2: OpenClaw agent 注册

### 2.1 创建 agent 目录结构（3 个新 agent）

每个需要创建 `~/.openclaw/agents/{name}/agent/`：
- [ ] `models.json` — 模型配置
- [ ] `auth-profiles.json` — OAuth 认证
- [ ] `auth.json` — 认证配置
- [ ] `sessions/sessions.json` — 会话配置

### 2.2 注册到 openclaw.json

`~/.openclaw/openclaw.json` → `agents.list` 添加 3 条：
```json
{ "id": "artisan", "name": "artisan", "workspace": "~/.openclaw/workspace-artisan", "agentDir": "~/.openclaw/agents/artisan" }
{ "id": "sentinel", "name": "sentinel", "workspace": "~/.openclaw/workspace-sentinel", "agentDir": "~/.openclaw/agents/sentinel" }
{ "id": "librarian", "name": "librarian", "workspace": "~/.openclaw/workspace-librarian", "agentDir": "~/.openclaw/agents/librarian" }
```

### 2.3 Forge 退役处理

- [ ] 从 `openclaw.json` agents.list 中移除 forge（或标记为 disabled）
- [ ] 保留 `workspace-forge/` 目录作为历史归档（不删除）
- [ ] 保留 `agents/forge/` 目录作为历史归档

### 2.4 重启 Gateway

- [ ] `taskkill //F //PID <gateway-pid>` + `silent-launcher.vbs` 重启
- [ ] 验证：`openclaw agent --agent artisan -m "test"`

## Step 3: 更新 agent-config.json

文件：`个人主页/src/common/agent-config.json`

### 3.1 添加新 agent

```json
"artisan": {
  "name": "Artisan",
  "team": "team-meta",
  "role": "worker",
  "skills": ["find-skills", "writing-plans", "coding-standards", "skill-create", "brainstorming"],
  "thinkingMode": "critical"
},
"sentinel": {
  "name": "Sentinel",
  "team": "team-meta",
  "role": "worker",
  "skills": ["security-review", "code-security", "rigorous-coding", "writing-plans", "brainstorming"],
  "thinkingMode": "critical"
},
"librarian": {
  "name": "Librarian",
  "team": "team-meta",
  "role": "worker",
  "skills": ["planning-with-files", "writing-plans", "continuous-learning", "find-skills", "brainstorming"],
  "thinkingMode": "critical"
}
```

### 3.2 移除 Forge

- [ ] 从 `agents` 对象中删除 `forge` 条目
- [ ] 从 `sessionAgents` 数组中删除 `"forge"`

### 3.3 更新 team-meta workers

```json
"team-meta": {
  "workers": ["prism", "scout", "genesis", "conductor", "artisan", "sentinel", "librarian"]
}
```

### 3.4 更新 sessionAgents

添加 `"artisan"`, `"sentinel"`, `"librarian"`，删除 `"forge"`

## Step 4: 创建 Claude Code Skills（3 个新 skill）

### 4.1 `.claude/skills/meta-artisan/SKILL.md`

技艺元的 Claude Code 工作流 — Skill 匹配 + Tool 选择

### 4.2 `.claude/skills/meta-sentinel/SKILL.md`

哨兵元的 Claude Code 工作流 — Hook/Security 设计

### 4.3 `.claude/skills/meta-librarian/SKILL.md`

典藏元的 Claude Code 工作流 — Memory 策略设计

## Step 5: 更新 meta-factory.mjs

文件：`个人主页/scripts/meta/meta-factory.mjs`

- [ ] 新增 `matchHooksToAgent(agentRole, platform)` — Sentinel 使用
- [ ] 新增 `designMemoryStrategy(agentRole, platform)` — Librarian 使用
- [ ] 现有 `matchSkillsToPhase()` → Artisan 使用
- [ ] 更新 `resolveAgentDependencies()` — 反映新的 team-meta 人员
- [ ] 更新测试 `tests/meta-factory.test.mjs`

## Step 6: 精简 Genesis SKILL.md

文件：`个人主页/.claude/skills/meta-genesis/SKILL.md`

- [ ] 移除 skill 匹配相关指令（→ meta-artisan）
- [ ] 移除安全设计相关指令（→ meta-sentinel）
- [ ] 移除记忆策略相关指令（→ meta-librarian）
- [ ] 保留 SOUL.md 灵魂设计核心流程

## Step 7: 数据库迁移

文件：`个人主页/supabase/migrations/029_meta_expansion.sql`

```sql
-- 添加 3 个新 agent
INSERT INTO agents (id, name, team_id, role, status) VALUES
  ('a0000001-0000-0000-0000-000000000025', 'Artisan', (SELECT id FROM teams WHERE slug='team-meta'), 'worker', 'idle'),
  ('a0000001-0000-0000-0000-000000000026', 'Sentinel', (SELECT id FROM teams WHERE slug='team-meta'), 'worker', 'idle'),
  ('a0000001-0000-0000-0000-000000000027', 'Librarian', (SELECT id FROM teams WHERE slug='team-meta'), 'worker', 'idle');

-- Soft-delete Forge (保留历史数据)
UPDATE agents SET status = 'retired' WHERE name = 'Forge';
```

UUID pattern 延续：meta 系列 16-19（现有），新增 25-27。

## Step 8: 验证

- [ ] 4 个 SOUL.md 全部通过 `validateSoulMd()` (8 模块 PASS)
- [ ] `node scripts/_validate_souls.mjs` 扩展验证所有 5 个元
- [ ] `node --test tests/meta-factory.test.mjs` 所有测试通过
- [ ] `openclaw agent --agent artisan -m "test"` 注册成功
- [ ] `openclaw agent --agent sentinel -m "test"` 注册成功
- [ ] `openclaw agent --agent librarian -m "test"` 注册成功
- [ ] Supabase migration 执行成功

## 文件清单

| 文件 | 操作 | 所属项目 |
|------|------|----------|
| `~/.openclaw/workspace-artisan/*` (7 files + memory/) | CREATE | OpenClaw |
| `~/.openclaw/workspace-sentinel/*` (7 files + memory/) | CREATE | OpenClaw |
| `~/.openclaw/workspace-librarian/*` (7 files + memory/) | CREATE | OpenClaw |
| `~/.openclaw/workspace-genesis/SOUL.md` | MODIFY — 瘦身 | OpenClaw |
| `~/.openclaw/workspace-genesis/IDENTITY.md` + 5 files | CREATE — 补全 | OpenClaw |
| `~/.openclaw/openclaw.json` | MODIFY — 注册 3 新 + 退役 forge | OpenClaw |
| `~/.openclaw/agents/artisan/agent/*` | CREATE | OpenClaw |
| `~/.openclaw/agents/sentinel/agent/*` | CREATE | OpenClaw |
| `~/.openclaw/agents/librarian/agent/*` | CREATE | OpenClaw |
| `个人主页/src/common/agent-config.json` | MODIFY | 个人主页 |
| `个人主页/.claude/skills/meta-artisan/SKILL.md` | CREATE | 个人主页 |
| `个人主页/.claude/skills/meta-sentinel/SKILL.md` | CREATE | 个人主页 |
| `个人主页/.claude/skills/meta-librarian/SKILL.md` | CREATE | 个人主页 |
| `个人主页/.claude/skills/meta-genesis/SKILL.md` | MODIFY | 个人主页 |
| `个人主页/scripts/meta/meta-factory.mjs` | MODIFY | 个人主页 |
| `个人主页/tests/meta-factory.test.mjs` | MODIFY | 个人主页 |
| `个人主页/scripts/_validate_souls.mjs` | MODIFY | 个人主页 |
| `个人主页/supabase/migrations/029_meta_expansion.sql` | CREATE | 个人主页 |
| `Meta_Kim/agents/*/SOUL.md` | CREATE — 设计稿存档 | Meta_Kim |
