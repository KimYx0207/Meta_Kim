# 基础设施元拆分分析 — Critical/Fetch/Deep/Review 四引擎认知

> 日期：2026-03-17
> 分析方法：Genesis Thinking Framework (Critical → Fetch → Deep → Review)
> 分析目标：将 9 个能力维度按"最小可治理单元"原则拆分为专精元

## 背景

meta.md 定义的基础设施元覆盖 9 个能力维度：

1. 提示词体系
2. 技能体系
3. 工具体系
4. 知识体系
5. 记忆体系
6. 工作流体系
7. 规则基线
8. 权限控制
9. 安全与回滚机制

当前设计把 9 个维度全塞进 Genesis 一个 agent — 直接违反元理论"死法一"（什么都不拆，一锅炖）。

---

## Step 1: Critical Thinking（批判引擎）

### 假设检验

| # | 假设 | 质疑 | 结论 |
|---|------|------|------|
| 1 | 提示词 + 规则基线 → Genesis | 规则基线（Decision Rules, Anti-AI-Slop）能从 SOUL.md 剥离吗？ | ✅ 不能。规则基线是 SOUL.md 7 必备模块中的 3 个，分开会制造接口耦合 |
| 2 | 技能 + 工具 → Artisan | Skill 匹配和 Tool 选择是同一个决策吗？ | ✅ 是。选了 `tdd` skill 就必须配 Bash tool，选了 `browser` skill 就必须配 MCP chrome-devtools。拆开需要双向同步 |
| 3 | 安全 + 权限 → Sentinel | Hook 不全是安全用途（也有 prettier 格式化） | ⚠️ 部分成立。但 Hook 80% 用例是安全相关。非安全 Hook（格式化类）属于 Artisan 范畴，在接口文档注明即可 |
| 4 | 记忆 + 知识 → Librarian | 记忆和知识是同一回事吗？ | ✅ 是。知识最终落地为持久化文件（memory/、MEMORY.md、platform-capabilities.json），是记忆链条的一部分 |
| 5 | 5 个元不会"碎成渣" | 7 个 worker 会不会太多？ | ✅ 不会。每个元的输入输出能独立定义，不是"本来一个提示词能搞定的事非拆三个" |

### Forge 退役分析

Genesis SOUL.md (296行) 是 Forge SOUL.md (173行) 的**严格超集**：

| 能力 | Forge | Genesis | 结论 |
|------|-------|---------|------|
| SOUL.md 设计 | ✅ | ✅ | 重叠 |
| 压力测试 | 5 类 | 6 类（+平台盲区测试） | Genesis 更全 |
| 设计蓝图 | 7 模块 | 7 模块 + 验收标准 | Genesis 更全 |
| 平台覆盖 | OpenClaw only | OpenClaw + Claude Code | Genesis 超集 |
| Thinking Framework | Critical + Fetch (2引擎) | Critical + Fetch + Deep + Review (4引擎) | Genesis 超集 |
| 反模式清单 | 5 项 | 7 项 | Genesis 更全 |

**结论**：Forge 退役，Genesis 继承其全部职责。

---

## Step 2: Fetch Thinking（调研引擎）

### 外部调研

搜索了 CrewAI、AutoGen、MetaGPT、LangGraph、OpenAI Swarm 等多 agent 框架的拆分模式：

- **MetaGPT**：4-5 个 role-based agent（产品经理、架构师、项目经理、工程师、QA）
- **CrewAI**：强调 agent 间的明确角色分工和任务委派
- **行业共识**：尚无关于 meta-agent 拆分粒度的实证研究

**结论**：没有可直接套用的外部参考。需要基于元理论自行推导。

### 平台能力调研

OpenClaw agent 完整工作空间需要 **7 个核心文件 + 2 个目录**：

| 文件 | 唯一性 | 说明 |
|------|--------|------|
| `SOUL.md` | 🔴 完全唯一 | 认知操作系统，7+ 必备模块 |
| `IDENTITY.md` | 🟡 短但唯一 | 名字、emoji、vibe、avatar |
| `HEARTBEAT.md` | 🔴 完全唯一 | 自主心跳任务定义（ON-DEMAND / 定时循环） |
| `AGENTS.md` | 🟠 团队相关 | 团队成员列表、通信协议、记忆指令 |
| `TOOLS.md` | 🟢 通用模板 | 环境特定工具备注 |
| `USER.md` | 🟢 共享模板 | 老金的用户信息（所有 agent 共享） |
| `BOOTSTRAP.md` | 🟢 共享模板 | 首次引导脚本（初始化后可删除） |
| `memory/` | 📂 空目录 | 运行时生成的记忆文件 |
| `.openclaw/` | 📂 内部状态 | OpenClaw 框架内部文件 |

**关键发现**：原计划只提到创建 SOUL.md，遗漏了 6 个其他必需文件。

---

## Step 3: Deep Thinking（深度引擎）

### 9→5 最终映射

| 9 维度 | 归属元 | 耦合理由 |
|--------|--------|----------|
| 1. 提示词体系 | **Genesis（灵魂元）** | SOUL.md 核心模块 |
| 2. 规则基线 | **Genesis（灵魂元）** | Decision Rules / Anti-AI-Slop 是 SOUL.md 内置模块，不可剥离 |
| 3. 技能体系 | **Artisan（技艺元）** | 131+ 技能搜索空间，独立高复杂度决策 |
| 4. 工具体系 | **Artisan（技艺元）** | 工具选择受技能选择直接驱动（skill→tool 映射） |
| 5. 安全机制 | **Sentinel（哨兵元）** | 横切关注点，"顺手做"是系统大敌 |
| 6. 权限控制 | **Sentinel（哨兵元）** | 与安全机制强耦合（权限声明 + 安全红线 + Hook 审计） |
| 7. 记忆体系 | **Librarian（典藏元）** | memory/ + MEMORY.md 完整链条 |
| 8. 知识体系 | **Librarian（典藏元）** | 知识最终落地为持久化文件，是记忆链条的一部分 |
| 9. 工作流体系 | **Conductor（编排元）** | 已存在，职责不变 |

### team-meta 人员变化

| Before (5 workers) | After (7 workers) | 变化 |
|---------------------|--------------------|----|
| Forge | ❌ 退役 | -1 |
| Prism | Prism | 不变 |
| Scout | Scout | 不变 |
| Genesis | Genesis（瘦身） | 修改 |
| Conductor | Conductor | 不变 |
| — | Artisan | +1 🆕 |
| — | Sentinel | +1 🆕 |
| — | Librarian | +1 🆕 |

净变化：-1 (Forge) + 3 (新增) = **+2 workers**

### 协作流程

```
CEO: "创建一个新的数据分析 agent"
  ↓
Warden (经理): 分配任务给基础设施元团队
  ↓ (四者并行，各自独立产出)
Genesis:   设计 SOUL.md 灵魂（Core Truths, Decision Rules, Thinking Framework）
Artisan:   匹配最优 skill 组合 + 工具选择 + MCP 服务器
Sentinel:  设计安全规则 + Hook 配置 + 权限边界 + 回滚机制
Librarian: 设计记忆策略 + 知识持久化方案 + 跨会话 continuity
  ↓
Warden:    整合四份产出 → 完整 agent 配置
  ↓
Conductor: 设计该 agent 参与的工作流节点
  ↓
CEO:       最终审批
```

---

## Step 4: Review Thinking（审查引擎）

### 五标准验证

| 标准 | Genesis（灵魂元） | Artisan（技艺元） | Sentinel（哨兵元） | Librarian（典藏元） | Conductor（编排元） |
|------|-------------------|-------------------|--------------------|--------------------|---------------------|
| 独立 | ✅ 给任务描述就能设计 SOUL.md | ✅ 给角色+平台就能匹配 skill | ✅ 给 SOUL.md 就能设计安全规则 | ✅ 给 agent 角色就能设计记忆策略 | ✅ 给部门就能设计工作流 |
| 足够小 | ✅ SOUL.md 核心设计是单一领域 | ✅ Skill/Tool 匹配是单一领域 | ✅ Hook/Security 是单一领域 | ✅ Memory/Knowledge 是单一领域 | ✅ Workflow 是单一领域 |
| 边界清晰 | ✅ 不碰 skill/hook/memory | ✅ 不碰灵魂/安全/记忆 | ✅ 不碰灵魂/skill/记忆 | ✅ 不碰灵魂/skill/安全 | ✅ 不碰基础设施能力 |
| 可替换 | ✅ 换掉不影响其他 3 个 | ✅ 换掉不影响其他 3 个 | ✅ 换掉不影响其他 3 个 | ✅ 换掉不影响其他 3 个 | ✅ 换掉不影响基础设施元 |
| 可复用 | ✅ 任何 agent 都需要 | ✅ 任何 agent 都需要 | ✅ 任何 agent 都需要 | ✅ 任何 agent 都需要 | ✅ 任何部门都需要 |

### "碎成渣"风险排除

meta.md 原文：
> "极端二：拆得过碎，碎成渣。本来一个提示词能搞定的事，非要拆成三个元..."

判断标准是每个元能否独立接收输入并独立产出：
- Genesis 输入：任务描述 → 产出：SOUL.md
- Artisan 输入：角色 + 平台 → 产出：skill + tool 组合
- Sentinel 输入：SOUL.md → 产出：安全规则 + Hook + 权限
- Librarian 输入：agent 角色 → 产出：记忆策略 + 知识方案

每个元都有独立的输入→输出管道，不是"碎成渣"。

反证：如果合并 Artisan + Sentinel 为"装备元"，其职责变成"选 skill + 选 tool + 设计 Hook + 设计安全红线 + 权限声明"— 五个不同领域的决策塞一个元，回到"死法一"。

---

## 结论

**9→5 分组通过四引擎验证。** 具体方案：

1. **Genesis（灵魂元）**：提示词体系 + 规则基线 → SOUL.md 设计
2. **Artisan（技艺元）**：技能体系 + 工具体系 → Skill/Tool/MCP 匹配
3. **Sentinel（哨兵元）**：安全机制 + 权限控制 → Hook/Security/Permissions
4. **Librarian（典藏元）**：记忆体系 + 知识体系 → Memory/Knowledge 策略
5. **Conductor（编排元）**：工作流体系 → V1/V2/V3/Meta 管道（已存在，不变）

**附加决策**：Forge 退役，被 Genesis 完全取代。
