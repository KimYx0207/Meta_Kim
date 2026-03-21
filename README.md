# Meta_Kim — 元兵工厂

> 基于老金"最小可治理单元"元理论，设计 AI Agent 团队架构的方法论工具箱。

## 快速开始

```bash
# 1. 克隆项目
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim

# 2. 安装元技能依赖（可选，推荐）
bash install-deps.sh

# 3. 用 Claude Code 打开本目录
# 8 个 agent + 1 个 skill 自动可用
```

## 核心理论

来源：`meta.md`（老金 2.5 小时直播完整记录）

**元 = 最小可治理单元**，五个标准：

1. **独立** — 能独立接收输入并产出
2. **足够小** — 单一领域职责
3. **边界清晰** — 不碰其他元的地盘
4. **可替换** — 换掉不影响其他元
5. **可复用** — 多个场景都需要

两个死法：
- 死法一：什么都不拆，一锅炖
- 死法二：拆得过碎，碎成渣

## 包含什么

### 8 个可 spawn 的子代理（`.claude/agents/`）

通过 Claude Code 的 Agent tool 指定 `subagent_type` spawn：

| Agent | 中文 | 层级 | 职责 |
|-------|------|------|------|
| **meta-warden** | 元部门经理 🔬 | 管理层 | 协调所有元 agent，质量关卡，S/A/B/C/D 评级 |
| **meta-genesis** | 灵魂元 🧬 | 基础设施 | 设计 SOUL.md（提示词 + 规则基线）|
| **meta-artisan** | 技艺元 🎨 | 基础设施 | 匹配最优 Skill/Tool 组合，ROI 评估 |
| **meta-sentinel** | 哨兵元 🛡️ | 基础设施 | 安全规则、Hook 设计、权限边界 |
| **meta-librarian** | 典藏元 📚 | 基础设施 | 记忆架构、知识持久化、淘汰规则 |
| **meta-conductor** | 编排元 🎼 | 编排层 | 工作流管线设计（V1/V2/V3/Meta）|
| **meta-prism** | 迭代审查员 🔍 | 元分析 | 质量法医、AI-Slop 8 签名检测 |
| **meta-scout** | 工具发现者 🔭 | 元分析 | 外部工具发现、CVE 审计 |

### 1 个方法论 Skill（`.claude/skills/meta-theory/`）

| Skill | 触发场景 |
|-------|---------|
| **meta-theory** | "元理论"、"最小可治理单元"、"拆分验证" |

### 7 个元技能依赖（`install-deps.sh` 安装）

| 元技能 | 来源 | 调用者 | 用途 |
|--------|------|--------|------|
| agent-teams-playbook | KimYx0207 | Warden, Conductor | 多 Agent 编排框架 |
| findskill | KimYx0207 | Artisan, Scout | Skills.sh 生态搜索 |
| superpowers | obra ⭐89K | 全员 | 纪律性工作流 |
| everything-claude-code | affaan-m ⭐81K | Artisan, Sentinel, Prism, Scout | subagent 候选池 |
| planning-with-files | OthmanAdi ⭐16K | Warden, Librarian, Conductor | 文件化规划 |
| cli-anything | HKUDS ⭐17K | Scout (可选) | GUI→CLI 转换 |
| skill-creator | anthropics (官方) | Genesis | Skill 测试迭代 |

## 创建一个 Agent 的完整流程

Warden 作为经理，并行 spawn 子代理：

```
用户: "我需要一个数据分析 agent"
  ↓
Warden (manager): 分析需求，并行派遣:
  ├→ Genesis:   设计 SOUL.md（人设、信条、规则、思维框架）
  ├→ Artisan:   匹配最优 Skill/Tool 组合
  ├→ Sentinel:  设计安全规则 + Hook 配置
  └→ Librarian: 设计记忆策略 + 淘汰规则
  ↓（四者并行完成）
Conductor: 设计工作流阶段集成
  ↓
Prism: 质量法医审查（AI-Slop 检测）
  ↓
Warden: 整合所有产出 → 完整 agent 配置 → CEO 审批
```

## 基础设施元拆分方案

9 个能力维度 → 5 个专精元 + 1 编排元：

```
提示词 + 规则基线  →  Genesis（灵魂元）🧬    [dims 1+7]
技能 + 工具        →  Artisan（技艺元）🎨    [dims 2+3]
安全 + 权限        →  Sentinel（哨兵元）🛡️   [dims 8+9]
记忆 + 知识        →  Librarian（典藏元）📚   [dims 4+5]
工作流             →  Conductor（编排元）🎼   [dim 6]
```

## 项目结构

```
Meta_Kim/
├── CLAUDE.md                          # Claude Code 自动读取
├── .claude/
│   ├── agents/                        # 8 个可 spawn 的子代理
│   │   ├── meta-warden.md             # 经理 — 协调 + 质量标准
│   │   ├── meta-genesis.md            # 灵魂元 — SOUL.md 设计
│   │   ├── meta-artisan.md            # 技艺元 — Skill/Tool 匹配
│   │   ├── meta-sentinel.md           # 哨兵元 — 安全/权限
│   │   ├── meta-librarian.md          # 典藏元 — 记忆/知识
│   │   ├── meta-conductor.md          # 编排元 — 工作流
│   │   ├── meta-prism.md              # 审查员 — 质量法医
│   │   └── meta-scout.md              # 发现者 — 工具扫描
│   └── skills/
│       └── meta-theory/SKILL.md       # 元理论方法论
├── meta.md                            # 元理论原文（老金直播记录）
├── install-deps.sh                    # 元技能依赖安装脚本
├── analysis/                          # 四引擎分析文档（存档）
└── task_plan.md                       # 执行计划（存档）
```

## 许可

MIT
