# 创建流水线 — 完整参考

## 流水线全景

```
┌─ Phase 1: 发现与拆分（模式A专用）──────────────────┐
│ Step 0: 数据收集     ← git 历史 + 文件分布分析      │
│ Step 1: 能力维度列举  ← 从数据中识别领域边界         │
│ Step 2: 耦合分组     ← 高耦合合并，低耦合分离        │
│ Step 2.5: 用户确认   ← 展示方案，征求领域判断        │
├─ Phase 2: 按需设计 ──────────────────────────────┤
│ Step 3: Genesis 灵魂  ← ✅ 必选（每个 Agent）       │
│ Step 4: Artisan 技能  ← ✅ 必选（每个 Agent）       │
│ Step 5: Sentinel 安全 ← 🔶 按需（碰 API/DB/Auth）  │
│ Step 6: Librarian 记忆← 🔶 按需（需跨会话经验）      │
│ Step 7: Conductor 编排← 🔶 按需（需多 Agent 协作）  │
├─ Phase 3: 审查与修订 ────────────────────────────┤
│ Step 8: 批判性审查    ← 自我批判 + 质量评级 + Slop检测│
│ Step 9: 修订         ← 审查不过就修，最多2轮        │
├─ Phase 4: 整合与验证 ─────────────────────────────┤
│ Step 10: 整合写入     ← 生成 .md 文件 + 更新 CLAUDE.md│
│ Step 11: 最终验证     ← 五标准 + 死法 + 完整性检查    │
│ Step 12: 用户确认     ← 展示产出，获批后才写入文件    │
└──────────────────────────────────────────────────┘
```

## 两种入口模式

### 模式A：发现模式（不确定要造什么agent）
- 用户说"帮我设计agent"但没有明确清单
- 走完整Phase 1数据分析 + 拆分

### 模式B：直接模式（已明确要造哪些agent）
- 用户已有明确的agent清单和职责定义
- 跳过Phase 1，直接进入Phase 2设计
- 但仍需在Phase 4验证时检查五标准和死法

---

## Phase 1: 数据收集与拆分

### Step 0: 数据收集命令

```bash
# 提交总数（了解项目规模）
git log --since="6 months ago" --oneline | wc -l

# 提交类型分布（feat/fix/refactor各占多少）
git log --since="6 months ago" --oneline | awk '{print $2}' | sed 's/:.*//' | sort | uniq -c | sort -rn

# 目录变更热力图（哪些区域最活跃）
git log --since="6 months ago" --name-only --pretty=format:"" | sed '/^$/d' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -20

# 文件共变分析（哪些目录经常一起改 = 高耦合）
git log --since="6 months ago" --name-only --pretty=format:"---" | awk 'BEGIN{RS="---"} NF>1 {for(i=1;i<=NF;i++) for(j=i+1;j<=NF;j++) print $i, $j}' | sed 's|/[^/]*$||g' | sort | uniq -c | sort -rn | head -15

# 文件分类计数
echo "=== Components ===" && find src/visual/components -name "*.tsx" 2>/dev/null | wc -l
echo "=== API routes ===" && find app/api -name "route.ts" 2>/dev/null | wc -l
echo "=== Scripts ===" && find scripts -name "*.mjs" 2>/dev/null | wc -l
echo "=== Tests ===" && find tests -name "*.test.*" 2>/dev/null | wc -l
```

### Steps 1-2: 分析与分组

从数据中识别天然领域边界：
- 变更频率 >5% 的目录区域 = 候选独立域
- 共变频率高的目录 = 应合并到同一 agent
- 共变频率低的目录 = 可分离

**耦合判定**：如果A目录改了，B目录是否经常也要改？是 → 同一agent。否 → 可分。

### Step 2.5: 用户确认

用 `AskUserQuestion` 展示拆分方案：
- 列出每个候选 agent 的名称、职责域、数据证据
- 问用户"这个分组符合你的认知吗？"
- **铁律**：如果用户说"这两个能力类型不同"，即使数据显示它们耦合，也必须拆开

---

## Phase 2: 按需设计

### 按需站点判定

Genesis（灵魂）和 Artisan（技能）**每个Agent必跑**。其他三站看情况：

在Step 3 Genesis完成后，对每个Agent回答三个问题：

| 问题 | Yes → 触发站点 | 判断依据 |
|------|---------------|---------|
| 它会修改文件、调用外部API、操作数据库？ | Sentinel（安全） | 有写操作 = 有风险面 |
| 它需要记住上次做了什么、积累学习经验？ | Librarian（记忆） | 需要跨会话一致性 |
| 它需要和其他Agent交接成果、协调执行顺序？ | Conductor（编排） | 多agent协作 |

三个问题全 No → 只跑 Genesis + Artisan。

### Step 3: Genesis — 灵魂设计（必选）

**读取** `.claude/agents/meta-genesis.md`，按其方法论设计SOUL.md。

详见 references/meta-theory.md 第8模块。

### Step 4: Artisan — 技能匹配（必选）

**读取** `.claude/agents/meta-artisan.md`

1. **扫描可用Skills**：`ls .claude/skills/*/SKILL.md` + 系统内置Skills
2. **ROI评分**：`ROI = (任务覆盖度 × 使用频率) / (上下文成本 + 学习曲线)`
3. **产出**：每个Agent的Skill推荐清单（Top 5-8，带ROI分数和理由）

### Step 5: Sentinel — 安全设计（按需）

**读取** `.claude/agents/meta-sentinel.md`

- **威胁建模**：该Agent领域的Top 5威胁
- **权限设计**：3级（CAN / CANNOT / NEVER）
- **Hook设计**：PreToolUse / PostToolUse / Stop hooks
- **产出**：安全规则 + Hook配置 + 权限边界

### Step 6: Librarian — 记忆设计（按需）

**读取** `.claude/agents/meta-librarian.md`

- **记忆架构**：3层（索引层 / 主题层 / 归档层）
- **过期策略**：按类型设过期规则
- **产出**：MEMORY.md模板 + 持久化策略

### Step 7: Conductor — 编排设计（按需）

**读取** `.claude/agents/meta-conductor.md`

- **协作流程**：Agent间的调用顺序、并行/串行
- **触发条件**：什么情况下spawn这个Agent
- **产出**：工作流配置 + 触发规则

---

## Phase 3: 审查与修订

详见 references/meta-theory.md 第4-5节（质量评级+AI-Slop检测）

### Step 8: 批判性审查

#### 8a. 自我批判

对每个Agent的完整设计，回答4个问题：
1. **我做了什么假设？有数据支撑吗？**
2. **把Agent名字换成别的，设计还成立吗？**
3. **有没有"顺手"的痕迹？**
4. **哪些是真正思考过的，哪些是套模板的？**

### Step 9: 修订

- **B级**：补充具体案例、数据引用、文件路径
- **C级**：重写套话段落，用项目实际数据替换
- **D级**：回到对应站点，从头重新执行

修订后再次进入Step 8，直到达到A级以上。**最多2轮**

---

## Phase 4: 整合与验证

### Step 10: 整合写入

生成最终的Agent定义文件 `.claude/agents/{name}.md`，结构如下：

```markdown
# {Name}: {中文名} {emoji}

> {一句话角色定位}

## 身份
- **层级**: 执行元
- **角色**: {role}

## 职责边界
**只管**: {具体职责列表}
**不碰**: {明确排除的职责，指向负责的agent}

## Core Truths
{≥3条核心信念}

## Decision Rules
{≥3条if/then决策规则}

## Thinking Framework
{领域特定的思维步骤}

## Anti-AI-Slop
{该领域的套话检测信号}

## Output Quality
{可验证的质量门槛}

## Deliverable Flow
{input → process → output 流程}

## Meta-Skills
{≥2个自我提升方向}

## 技能装备
| Skill | ROI | 用途 |
|-------|-----|------|
{技能清单}

## 安全规则（如有）
{权限 + Hook配置}

## 记忆策略（如有）
{MEMORY.md模板}

## 工作流（如有）
{触发条件 + 协作流程}

## 跳过的站点
{列出被跳过的站点及理由}

## 五标准验证
| 标准 | 证据 | Pass? |
|------|------|-------|
| 独立 | {具体证据} | ✅ |
| 足够小 | {具体证据} | ✅ |
| 边界清晰 | {具体证据} | ✅ |
| 可替换 | {具体证据} | ✅ |
| 可复用 | {具体证据} | ✅ |
```

同步更新 `CLAUDE.md` Section "Claude Code Subagents"。

### Step 11: 最终验证

| 检查项 | 方法 | 不通过处理 |
|--------|------|-----------|
| 五标准验证 | 每个Agent填表，5/5 PASS | 回Step 9修订 |
| 死法检查 | 无一锅炖、无碎成渣 | 回Step 2重新分组 |
| 8模块完整性 | SOUL.md 8模块齐全 | 回Step 3补充 |
| 跳站合理性 | 跳过的站点有明确理由 | 无理由 → 补跑该站 |

### Step 12: 用户确认

向用户展示完整产出摘要：
- 每个Agent的职责 + 质量评级（S/A/B）
- 跳过的站点及原因
- 五标准验证表

**获取用户明确的"确认"后才写入文件。**
