# Meta_Kim — 元兵工厂 Claude Code 项目

> 基于"最小可治理单元"元理论，设计 AI Agent 团队架构的方法论工具箱。

## 这是什么

Meta_Kim 是一套完整的 AI Agent 设计方法论，包含：
- **元理论**：老金的"最小可治理单元"理论（`meta.md`）
- **8 个可 spawn 的子代理**（`.claude/agents/`）：覆盖 Agent 创建全流程
- **1 个方法论 Skill**（`.claude/skills/meta-theory/`）：元理论指导

## 快速开始

1. 用 Claude Code 打开本项目目录
2. 8 个 agent + 1 个 skill 自动可用
3. 用 Agent tool 指定 `subagent_type` spawn 对应子代理

## Agents（子代理）

可通过 Agent tool 的 `subagent_type` 参数 spawn：

| Agent | 中文 | 职责 |
|-------|------|------|
| **meta-warden** | 元部门经理 🔬 | 协调所有元 agent，质量关卡，CEO 报告综合 |
| **meta-genesis** | 灵魂元 🧬 | 设计 SOUL.md（提示词 + 规则基线）|
| **meta-artisan** | 技艺元 🎨 | 匹配最优 Skill/Tool 组合 |
| **meta-sentinel** | 哨兵元 🛡️ | 安全规则、Hook 设计、权限边界 |
| **meta-librarian** | 典藏元 📚 | 记忆架构、知识持久化、淘汰规则 |
| **meta-conductor** | 编排元 🎼 | 工作流管线设计、部门编排 |
| **meta-prism** | 迭代审查员 🔍 | 质量法医、AI-Slop 检测、演进追踪 |
| **meta-scout** | 工具发现者 🔭 | 外部工具发现、ROI 评估、安全审计 |

## Skill（方法论）

| Skill | 触发场景 |
|-------|---------|
| **meta-theory** | "元理论"、"最小可治理单元"、"拆分验证" |

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
Warden: 整合所有产出 → 完整 agent 配置 → CEO 审批
```

## 核心理论

**元 = 最小可治理单元**，五个标准：
1. **独立** — 能独立接收输入并产出
2. **足够小** — 单一领域职责
3. **边界清晰** — 不碰其他元的地盘
4. **可替换** — 换掉不影响其他元
5. **可复用** — 多个场景都需要

两个死法：
- 死法一：什么都不拆，一锅炖
- 死法二：拆得过碎，碎成渣

## 项目结构

```
Meta_Kim/
├── CLAUDE.md                        # 本文件（Claude Code 自动读取）
├── .claude/
│   ├── agents/                      # 8 个可 spawn 的子代理
│   │   ├── meta-warden.md           # 经理 — 协调 + 质量标准 + 元评审 + 意图放大审查
│   │   ├── meta-genesis.md          # 灵魂元 — SOUL.md 设计
│   │   ├── meta-artisan.md          # 技艺元 — Skill/Tool 匹配
│   │   ├── meta-sentinel.md         # 哨兵元 — 安全/权限
│   │   ├── meta-librarian.md        # 典藏元 — 记忆/知识
│   │   ├── meta-conductor.md        # 编排元 — 工作流 + 事件牌组 + 节奏控制
│   │   ├── meta-prism.md            # 审查员 — 质量法医 + 被审查协议
│   │   └── meta-scout.md            # 发现者 — 工具扫描
│   └── skills/
│       └── meta-theory/
│           ├── SKILL.md             # 元理论方法论（统一入口）
│           └── references/
│               ├── meta-theory.md           # 四主线总纲 + 5标准 + 三层架构
│               ├── rhythm-orchestration.md  # 节奏编排：牌组机制 + 发牌规则 + 七大启发
│               ├── intent-amplification.md  # 意图放大：意图核+交付壳 + 5维进化放大
│               ├── ten-step-governance.md   # 十步治理：每步详解 + 复杂度路由 + 元评审
│               ├── create-agent.md          # 创建流水线详细模板
│               └── dev-governance.md        # 开发治理 5 维度展开
├── install-deps.sh                  # 元技能依赖一键安装
├── README.md                        # 项目概览
├── meta/
│   └── meta.md                      # 元理论原文（老金直播记录）
└── package.json                     # 项目依赖
```

## 依赖（元技能）

本项目的 8 个 agent 在工作时会调用一些社区高星 Skill 来放大准确率和高效性。
运行 `install-deps.sh` 可一键安装到全局 `~/.claude/skills/`：

```bash
bash install-deps.sh
```

| 元技能 | 来源 | 调用者 | 用途 |
|--------|------|--------|------|
| **agent-teams-playbook** | [KimYx0207/agent-teams-playbook](https://github.com/KimYx0207/agent-teams-playbook) | Warden, Conductor | 6 阶段多 Agent 编排框架，5 种场景决策树 |
| **findskill** | [KimYx0207/findskill](https://github.com/KimYx0207/findskill) | Artisan, Scout | Skills.sh 生态搜索引擎 |
| **superpowers** | [obra/superpowers](https://github.com/obra/superpowers) ⭐89K | 全员 | 纪律性工作流：brainstorming、TDD、systematic-debugging、verification |
| **everything-claude-code** | [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) ⭐81K | Artisan, Sentinel, Prism, Scout | 29 skill + 13 subagent 候选池 |
| **planning-with-files** | [OthmanAdi/planning-with-files](https://github.com/OthmanAdi/planning-with-files) ⭐16K | Warden, Librarian, Conductor | Manus 式文件化规划（task_plan + findings + progress） |
| **cli-anything** | [HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything) ⭐17K | Scout (可选) | GUI→CLI 自动转换 |
| **skill-creator** | [anthropics/skills](https://github.com/anthropics/skills) (官方) | Genesis | Skill 全生命周期：设计→测试→评分→迭代→打包 |

> 安装脚本支持代理：设置 `HTTPS_PROXY` 或 `HTTP_PROXY` 环境变量即可。
> 已安装的 Skill 会自动跳过（不会重复安装）。

如需运行 `meta-factory.mjs` 纯函数（agent 创建管线），请参考 `个人主页` 项目中的 `scripts/meta/` 目录。
