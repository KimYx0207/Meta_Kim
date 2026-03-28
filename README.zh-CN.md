<div align="center">

<h1>Meta_Kim</h1>

<p>
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p>
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Claude%20Code%20%7C%20Codex%20%7C%20OpenClaw-111827"/>
  <img alt="Method" src="https://img.shields.io/badge/method-%E5%85%83%20%E2%86%92%20%E7%BB%84%E7%BB%87%E9%95%9C%E5%83%8F%20%E2%86%92%20%E8%8A%82%E5%A5%8F%E7%BC%96%E6%8E%92%20%E2%86%92%20%E6%84%8F%E5%9B%BE%E6%94%BE%E5%A4%A7-0f766e"/>
  <img alt="Skill" src="https://img.shields.io/badge/skill-meta--theory%20v1.0.3-7c3aed"/>
  <img alt="License" src="https://img.shields.io/badge/license-CC%20BY%204.0-f59e0b"/>
</p>

**跨 Claude Code / Codex / OpenClaw 的意图放大元架构工程**

Meta_Kim 不是教 AI 多说，而是教 AI 先学会组织复杂任务。

**元 -> 组织镜像 -> 节奏编排 -> 意图放大**

</div>

## 作者与支持

<div align="center">
  <img src="images/二维码基础款.png" alt="联系方式" width="560"/>
  <p>
    GitHub <a href="https://github.com/KimYx0207">KimYx0207</a> |
    𝕏 <a href="https://x.com/KimYx0207">@KimYx0207</a> |
    官网 <a href="https://www.aiking.dev/">aiking.dev</a> |
    微信公众号：<strong>老金带你玩AI</strong>
  </p>
  <p>
    飞书知识库：
    <a href="https://my.feishu.cn/wiki/OhQ8wqntFihcI1kWVDlcNdpznFf">长期更新入口</a>
  </p>
</div>

<div align="center">
  <table align="center">
    <tr>
      <td align="center">
        <img src="images/微信.jpg" alt="微信收款码" width="220"/>
        <br/>
        <strong>微信支付</strong>
      </td>
      <td align="center">
        <img src="images/支付宝.jpg" alt="支付宝收款码" width="220"/>
        <br/>
        <strong>支付宝</strong>
      </td>
    </tr>
  </table>
</div>

## 一眼看懂

- 默认入口：`meta-warden`
- 组织骨架：`8` 个元 agent
- 运行时：Claude Code、Codex、OpenClaw
- 目标：先做意图放大，再做执行与协作
- 业务 run 纪律：`一个部门 -> 一个主交付物 -> 一条闭合交付链`

## 快速上手（克隆后 5 分钟跑起来）

### 环境要求

- **Node.js** v18+（用于 sync、validate、OpenClaw 脚本）
- **Git**（用于克隆项目）
- **Claude Code CLI**（可选，仅在运行 `eval:agents` 时需要）
- **OpenClaw CLI**（可选，仅在运行 `npm run prepare:openclaw-local` 时需要）

### 第一步：克隆并安装

```bash
git clone <仓库地址>
cd Meta_Kim
npm install
```

### 第二步：同步三端

```bash
npm run sync:runtimes
```

这步把 `.claude/agents/` 里的 8 个 agent 同步到 Claude Code / Codex / OpenClaw 三端镜像。**每次改了 agent 定义或 SKILL.md 后都要跑。**

### 第三步：发现全局能力

```bash
npm run discover:global
```

扫描并索引你全局安装的能力（Claude Code、OpenClaw、Codex 三端），生成统一的能力索引。**安装后首次必须运行，之后安装新全局能力时需重新运行。**

扫描范围：
- **Claude Code** (`~/.claude/`): agents、skills、hooks、plugins、commands
- **OpenClaw** (`~/.openclaw/`): agents、skills、hooks、commands
- **Codex** (`~/.codex/`): agents、skills、commands

### 第四步：验证完整性

```bash
npm run validate
```

校验 frontmatter 格式、SKILL.md 同步状态、OpenClaw/Codex 配置完整性。

**期望输出：** `Validation passed for 8 agents.`

### 第五步：快速健康度检查

```bash
node scripts/agent-health-report.mjs
```

查看 8 个 agent 的状态：版本号、frontmatter 完整性、边界定义、workspace 文件、skill 同步情况，综合健康分。

### 第六步：开始使用（Claude Code）

用 Claude Code 打开仓库，直接说：

```text
请以 meta-warden 为统一入口，先做意图放大，再判断是否需要调用其他元 agent。
```

或者直接描述一个复杂任务——系统会自动跑完 8 阶段治理流程。

## 这是什么项目

Meta_Kim 不是聊天产品，不是 SaaS，不是一个“大 prompt”，也不是把很多 agent 文件堆在一起。

它是一套跨运行时的工程化方法：

- 用户先给出原始意图
- 系统先做意图放大，而不是直接急着回答
- 系统按元架构决定该拆给谁、该跳过什么、该先做什么
- 最后在 Claude Code、Codex、OpenClaw 三个运行时里保持同一套底层规矩

工程上它同时组织这些层：

- `agent`：职责边界和组织角色
- `skill`：可复用能力块
- `MCP`：外部能力接口
- `hook`：运行时约束和自动化拦截
- `memory`：长期上下文与连续性
- `workspace`：运行时本地工作空间
- `sync / validate / eval`：同步、校验、验收工具链

一句话说：

**Meta_Kim 关心的不是“单次答得像不像”，而是“复杂任务能不能被持续、稳定、可治理地完成”。**

## 元的理念

在 Meta_Kim 里：

**元 = 为了支持意图放大而存在的最小可治理单元。**

它至少要满足五个条件：

- 能独立理解
- 足够小，便于控制
- 边界清晰，知道自己不负责什么
- 可替换，不会一换就让系统整体塌掉
- 可复用，能被重复编排

Meta_Kim 不把“元”当修辞，而是把它当架构粒度。

## 方法主线

Meta_Kim 的核心链路只有一条：

**元 -> 组织镜像 -> 节奏编排 -> 意图放大**

```mermaid
flowchart LR
    A["元<br/>最小可治理单元"] --> B["组织镜像<br/>把元组织成结构"]
    B --> C["节奏编排<br/>控制时机、顺序、插队与跳过"]
    C --> D["意图放大<br/>把原始意图展开成可执行任务"]
```

这四段分别解决四个问题：

- `元`：怎么拆
- `组织镜像`：怎么组
- `节奏编排`：怎么发
- `意图放大`：怎么成

缺任何一段，这套方法都不完整。

## 系统怎么工作

默认工作路径不是“用户提问 -> 直接生成”。

而是：

```mermaid
flowchart TD
    A["用户原始意图"] --> B["meta-warden<br/>统一入口"]
    B --> C["意图放大<br/>目标、边界、约束、交付物"]
    C --> D["按需调度其他元 agent"]
    D --> E["部门 / specialist / skill / MCP / hook 协作"]
    E --> F["统一汇总输出"]
```

默认前门只有一个：

- `meta-warden`

其它 7 个元 agent 是后台结构，不是面向用户的菜单。

每一条有效的业务 run，都必须保持一条唯一主线：

- 一个部门
- 一个主交付物
- 一条闭合交付链

如果同一轮里塞进多个互不相干的目标，`meta-conductor` 应该直接打回，`meta-warden` 也不应让它进入公开展示态。

## 8 个元 agent

- `meta-warden`：统一入口、统筹、仲裁、最终汇总
- `meta-conductor`：编排、调度、节奏控制
- `meta-genesis`：人格、提示词、`SOUL.md`
- `meta-artisan`：skill、MCP、工具与能力匹配
- `meta-sentinel`：hook、安全、权限、回滚
- `meta-librarian`：记忆、知识连续性、上下文策略
- `meta-prism`：质量审查、漂移检测、反 AI 套话
- `meta-scout`：外部能力发现与评估

如果你第一次接触这个项目，只需要先记住：

**默认入口是 `meta-warden`。**

## 三个运行时怎么承接

Meta_Kim 不是强行把三个运行时做成一模一样。

它做的是：

- 保持同一套底层方法
- 用每个运行时自己的原生结构去承接它

| 运行时 | 用户入口 | 仓库落点 | 作用 |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE.md` | `.claude/`、`.mcp.json` | 元 agent、skill、hook、MCP 的主源运行时 |
| Codex | `AGENTS.md` | `.codex/`、`.agents/`、`codex/config.toml.example` | Codex 原生 agent / skill 镜像 |
| OpenClaw | `openclaw/workspaces/` | `openclaw/` | OpenClaw 的本地 workspace agent 和模板配置 |

## 怎么用，怎么触发

### 8 阶段治理流程

每个复杂任务都会自动走这个流水线：

```mermaid
flowchart TD
    A["1. Critical<br/>追问澄清 — 追问不清的需求"] --> B["2. Fetch<br/>搜索现有能力 — 先找不做假设"]
    B --> C["3. Execution<br/>执行 — 元接力链路"]
    C --> D["4. Review<br/>评审 — 代码质量/UX/安全"]
    D --> E["5. Meta-Review<br/>元评审 — 越界检测/架构合规"]
    E --> F["6. Evolution<br/>意图放大 — 沉淀可复用模式"]
    F --> G["统一汇总输出"]
```

**三条铁律贯穿全程：**
- **Critical > 猜测** — 需求不清先追问，不假设
- **Fetch > 假设** — 先搜索验证，不假设存在
- **Review > 信任** — 任何产出必须评审，不信任单次结果

### 两种触发方式

**方式一：自动触发（推荐用于复杂任务）**

直接描述一个涉及多文件改动的复杂任务。系统**自动**跑完全部 8 阶段，不需要你了解这些阶段的存在。

示例：`"帮我实现一个用户认证系统"` → 自动激活治理流程。

**方式二：手动点名（你知道具体要什么时用）**

显式点名某个元 agent。

### 默认触发方式

- 你要定义 prompt / persona / `SOUL.md`：点 `meta-genesis`
- 你要做 skill / MCP / 工具匹配：点 `meta-artisan`
- 你要处理 hook / 安全 / 权限 / 回滚：点 `meta-sentinel`
- 你要处理记忆和长期上下文：点 `meta-librarian`
- 你要处理流程编排和节奏：点 `meta-conductor`
- 你要做质量审查：点 `meta-prism`
- 你要找外部能力、外部工具：点 `meta-scout`

### 在 Claude Code 里怎么用

1. 用 Claude Code 打开仓库
2. Claude Code 会读取：
   - `CLAUDE.md`
   - `.claude/agents/`
   - `.claude/skills/`
   - `.mcp.json`
3. 直接发起任务，例如：

```text
请以 meta-warden 为统一入口，审查这个项目的架构，并给出下一步方案。
```

### 在 Codex 里怎么用

1. 用 Codex 打开仓库
2. Codex 会读取：
   - `AGENTS.md`
   - `.codex/agents/`
   - `.agents/skills/`
3. 如果要接本地 MCP，再参考：
   - `codex/config.toml.example`

### 在 OpenClaw 里怎么用

1. 先准备本地环境：

```bash
npm install
npm run prepare:openclaw-local
```

2. 然后直接运行某个元 agent，例如：

```bash
openclaw agent --local --agent meta-warden --message "请先做意图放大，再决定该调哪些元 agent" --json --timeout 120
```

## 项目结构

```text
Meta_Kim/
├─ .claude/        Claude Code 主源：agents、skills、hooks、settings
├─ .codex/         Codex 仓库内 agents 与 skills 镜像
├─ .agents/        Codex 项目级 skills 镜像
├─ codex/          Codex 全局配置示例
├─ openclaw/       OpenClaw workspace、模板配置、运行时镜像
├─ contracts/      运行时治理合约
├─ images/         README 使用的公开图片资源
├─ scripts/        同步、校验、MCP、自检、OpenClaw 准备、agent 健康度报告脚本
├─ shared-skills/  跨运行时共享技能镜像
├─ AGENTS.md       Codex / 跨运行时入口说明
├─ CLAUDE.md       Claude Code 入口说明
├─ .mcp.json       Claude Code 项目级 MCP 配置
├─ README.md       英文主 README
└─ README.zh-CN.md 中文 README
```

本地私有目录不属于公开发布面：

- `docs/`：作者本地研究稿与文章目录，已忽略
- `image/`：本地截图和临时导出目录，已忽略
- `node_modules/`：本地依赖目录，已忽略

### 为什么会有 `codex/`

Codex 的配置分两层：

- 仓库内资产：放在 `.codex/` 和 `.agents/`
- 用户电脑里的全局配置：不能直接写进仓库根部

所以：

- `.codex/` 是 Codex 真正会直接读取的仓库内内容
- `codex/` 只是一个配置示例目录，用来说明 `~/.codex/config.toml` 应该怎么接

## 这些命令什么时候要跑

### `npm install`

第一次拉项目到本地，准备使用或验证时执行。

### `npm run sync:runtimes`

你改了主源 agent、skill、运行时配置之后执行。
作用是把主源重新同步成 Claude Code / Codex / OpenClaw 三端镜像。

### `npm run discover:global`（新增）

扫描并索引你全局安装的能力（跨三个运行时）：

- **Claude Code** (`~/.claude/`): agents、skills、hooks、plugins、commands
- **OpenClaw** (`~/.openclaw/`): agents、skills、hooks、commands
- **Codex** (`~/.codex/`): agents、skills、commands

生成 `.claude/capability-index/global-capabilities.json`，供 meta-theory skill 的 Fetch 阶段使用。这样元架构就能看到并整合你的全局能力。

### `npm run validate`

校验主源文件、agent 定义、SKILL.md 同步状态，以及 OpenClaw/Codex 配置完整性。

### `npm run eval:agents`

在运行时级别做验收测试。会启动 8 个元 agent，验证边界行为是否符合预设测试用例。

### `npm run verify:all`

准备发布、提交、开源，或者刚改完运行时资产时执行。
作用是统一做校验和验收（validate + eval 合并）。

### `npm run prepare:openclaw-local`

只有你准备在本机真正跑 OpenClaw 时才需要。
作用是补 OpenClaw 本地授权和状态准备。

### `node scripts/agent-health-report.mjs`

快速健康度检查，输出 markdown 报告，覆盖版本号、frontmatter 完整性、边界定义、workspace 文件状态、skill 同步状态和综合健康分。

## 最简单的开始方式

上面的 [快速上手章节](#快速上手克隆后-5-分钟跑起来) 已经包含了从克隆到跑起来的完整步骤。

如果只是了解项目，读这三个文件的顺序：

1. `README.zh-CN.md`（本文件）——从这里开始
2. `CLAUDE.md` ——Claude Code 专用指南
3. `AGENTS.md` ——Codex 和跨运行时指南

## 方法依据与论文

Meta_Kim 的方法依据来自“基于元的意图放大”评测与方法沉淀。

- 论文页面：<https://zenodo.org/records/18957649>
- DOI：`10.5281/zenodo.18957649`

论文负责解释方法论基础。  
本仓库负责把这套方法落成可运行的工程资产。

## License

本项目采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可协议。

你可以分享、改编、再发布，但需要保留署名并标注修改。
