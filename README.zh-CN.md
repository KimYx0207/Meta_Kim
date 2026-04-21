<div align="center">

<h1 style="font-size: 6em; font-weight: 900; margin-bottom: 0.2em; letter-spacing: 0.1em;">元</h1>
<p style="font-size: 1.2em; color: #7c3aed; font-weight: 600; margin-top: 0;">META_KIM</p>

<p>
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.ja-JP.md">日本語</a> |
  <a href="README.ko-KR.md">한국어</a>
</p>

<p>
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Claude%20Code%20%7C%20Codex%20%7C%20OpenClaw%20%7C%20Cursor-111827"/>
  <img alt="Stars" src="https://img.shields.io/github/stars/KimYx0207/Meta_Kim?style=flat&logo=github"/>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green"/>
</p>

</div>

## 简介

**Meta_Kim** 不是又一个 AI 编码工具。它是一套给 AI 编码助手装上"大脑"的治理系统。

打个比方：你现在用的 Claude Code、Codex、OpenClaw、Cursor，本质上都是"手"——能写代码、能改文件。但谁来决定先改哪个文件？改完谁来检查？检查出了问题谁来修？修完了怎么保证下次不会再犯同样的错？

Meta_Kim 就是干这个的。它是**AI 之上的 AI**——一套统一的治理逻辑，让复杂任务不再是一锅乱炖。

### 一句话总结

> **先搞清楚要干什么 → 再决定谁去干 → 干完审查 → 审完沉淀经验 → 经验反哺下一轮。**

这不是什么新概念，这就是任何成熟工程团队都在做的事情。只不过 Meta_Kim 把它变成了一套可运行的系统，而不是靠人的自觉。

## 快速开始

如果你只想先装上试用，直接运行：

```bash
npx --yes github:KimYx0207/Meta_Kim meta-kim
```

或者按传统方式：

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

> 💡 **安装之后**：`setup.mjs` 结尾会打印产物位置。任何时候想再看一眼（或对比上次安装），在安装目录里跑 `npm run meta:status` 即可。

如果你准备维护仓库，优先改 `canonical/` 和 `config/contracts/workflow-contract.json`，然后执行：

```bash
npm run sync:runtimes
npm run validate
```

建议阅读顺序：

1. 本文件 `README.zh-CN.md`
2. `AGENTS.md`
3. `docs/runtime-capability-matrix.md`

---

## 联系方式

![联系方式](docs/images/contact-qr.png)

GitHub <a href="https://github.com/KimYx0207">KimYx0207</a> |
X <a href="https://x.com/KimYx0207">@KimYx0207</a> |
官网 <a href="https://www.aiking.dev/">aiking.dev</a> |
微信公众号：**老金带你玩AI**

飞书知识库：
<a href="https://my.feishu.cn/wiki/OhQ8wqntFihcI1kWVDlcNdpznFf">长期更新入口</a>

### 请我一杯咖啡

如果 Meta_Kim 帮到了你，欢迎请我喝杯咖啡，算是对持续维护的支持。

<table align="center">
<tr><th>微信支付</th><th>支付宝</th></tr>
<tr>
<td align="center"><img src="docs/images/wechat-pay.jpg" width="260" alt="微信收款码"></td>
<td align="center"><img src="docs/images/alipay.jpg" width="260" alt="支付宝收款码"></td>
</tr>
</table>

### 方法依据

Meta_Kim 的方法论基础来自本项目维护者（KimYx0207）撰写的"基于元的意图放大"研究：

- 论文：<https://zenodo.org/records/18957649>
- DOI：`10.5281/zenodo.18957649`

---

## 架构：隐形骨架 + 动态发牌

这是 Meta_Kim 最核心的设计思想。整篇文档最重要的就是这一节。

### 先把核心词拆开，不然后面一定会混

| 概念 | 它是什么 | 它不是什么 |
| --- | --- | --- |
| **隐形骨架** | 表层流程下面必然存在的后台框架节点 | 一张先天写死的职责清单 |
| **8 大流程** | 隐形骨架在执行层露出的人可读主链 | 全部治理逻辑本身 |
| **10 大流程** | 复杂 run 被判断后叠加的更复杂递进方式 | 8 大流程的替代物 |
| **发牌** | 围绕 8 大流程和 agent 单元做动态管控 | 简单派任务 |
| **门** | 放行条件 | 阶段本身 |
| **协议** | 节点必须交出的结构化东西 | 口号或抽象价值观 |
| **agent 单元治理** | 让边界、能力、升级、回滚有抓手 | 角色菜单 |
| **三层记忆体系** | memory / graphify / SQL 分工协作的长期记忆 | 一份大杂烩笔记 |

如果你只想记住一句话：

> **8 大流程负责推进，门负责准入，协议负责交付，发牌负责动态介入。**

### 8 大流程 = 隐形骨架

Meta_Kim 有 8 个固定的执行阶段，我管它叫**隐形骨架**：

```mermaid
flowchart LR
    C[Critical<br/>澄清需求] --> F[Fetch<br/>搜索能力]
    F --> T[Thinking<br/>规划方案]
    T --> E[Execution<br/>分派执行]
    E --> R[Review<br/>审查]
    R --> MR[Meta-Review<br/>元审查]
    MR --> V[Verification<br/>验证]
    V --> EV[Evolution<br/>进化]

    style C fill:#fbbf24,color:#000
    style F fill:#34d399,color:#000
    style T fill:#60a5fa,color:#000
    style E fill:#f87171,color:#fff
    style R fill:#a78bfa,color:#fff
    style MR fill:#a78bfa,color:#fff
    style V fill:#34d399,color:#000
    style EV fill:#fbbf24,color:#000
```

**Critical — 先把真实问题钉住，不让后面全程建立在误解上**

需求模糊时追问澄清，而不是猜。这一步产出 `intentPacket`（意图锁定），把真实用户意图、成功标准、排除范围全写死。如果需求已经清晰，系统显式记录跳过原因，不是偷偷跳过。

**Fetch — 先找已有能力，而不是上来就自己发明**

搜索现有 agent、skill、工具、MCP 能不能覆盖这个需求。这一步的核心理念是**能力优先**——先定义需要什么能力，再搜索谁声明了这个能力，最后派给最匹配的 owner，而不是一开始就写死一个 agent 名字。

**Thinking — 定义边界、owner、顺序、交付物、风险和停机条件**

把任务拆成子任务，给每个子任务指定 owner，明确依赖关系和并行分组。这一步产出 `dispatchBoard`（分派看板）——谁干什么、哪些可以并行跑、最终谁负责合并。同时要探索至少 2 条方案路径，不能只走一条路。

**Execution — 真正产生产物，但此时仍然处于被治理状态**

分派给专业 agent 执行。每个子任务打包成 `workerTaskPacket`，包含完整的文件上下文、约束条件、审查 owner 和验证 owner。独立子任务并行跑，不串行拖慢。**执行 ≠ 完成**——产出物后面还要过审查和验证。

**Review — 站在质量和边界角度检查当前执行是否靠谱**

审查代码质量、安全性、架构合规、边界越界检测。产出 `reviewPacket`，里面是结构化的审查发现（findings）。每个发现都有严重等级，从 CRITICAL 到 LOW。这一步不是走过场——发现没关就不能往前推。

**Meta-Review — 反过来审视 review 标准本身是不是偏了、漏了、松了**

审查"审查"。如果 review 标准本身太松，等于没审；如果标准偏了，等于审错了方向。这一步保证审查系统的质量，而不是只保证被审代码的质量。

**Verification — 确认真实世界里确实成立，而不是文本上看起来像成立**

验证修复是否真的把 review finding 关了。产出 `verificationResult` + `closeFindings`。如果修复没关上 finding，回修再验证，直到闭合。这步是最诚实的关卡——文本上看起来修了不等于真修了。

**Evolution — 把本轮能力缺口、可复用模式、升级需求写回系统**

把经验沉淀成结构性升级：可复用模式写入 memory，失败记录成伤疤，能力缺口标记给 Scout 追踪，agent 边界调整写回 canonical。每轮必须给出 `writebackDecision`——要么明确写回目标，要么说明为什么没有可落盘的内容。**不沉淀经验的 run 等于白干。**

---

这 8 个阶段合在一起就是执行脊柱。

为什么是"相对"固定？因为有些阶段在简单场景下可以跳过——但系统会显式记录跳过的原因，不是偷偷跳过。

### 10 大流程 = 骨架之上的递进工作流

如果 8 大流程是骨架，那 10 大流程就是在这个骨架上长出来的**更复杂的递进方式**：

```
direction → planning → execution → review → meta_review → revision → verify → summary → feedback → evolve
```

它不是另起一套，而是从 8 大流程**派生**出来的。区别在于：

- **8 大流程**偏向执行逻辑——"按什么顺序干活"
- **10 大流程**偏向业务治理——"每个阶段要交付什么、怎么算完成、交付物怎么流转"

```mermaid
flowchart TB
    subgraph spine["8 大流程（隐形骨架）"]
        direction LR
        C1[Critical] --> F1[Fetch] --> T1[Thinking] --> E1[Execution] --> R1[Review] --> MR1[Meta-Review] --> V1[Verification] --> EV1[Evolution]
    end

    subgraph workflow["10 大流程（递进工作流）"]
        direction LR
        D2[direction] --> P2[planning] --> EX2[execution] --> RE2[review] --> MET2[meta_review] --> REV2[revision] --> VER2[verify] --> SUM2[summary] --> FB2[feedback] --> EVO2[evolve]
    end

    C1 -.-> D2
    F1 -.-> P2
    T1 -.-> P2
    E1 -.-> EX2
    R1 -.-> RE2
    MR1 -.-> MET2
    V1 -.-> VER2
    EV1 -.-> EVO2

    style spine fill:#1e1b4b,stroke:#7c3aed,color:#e0e7ff
    style workflow fill:#14532d,stroke:#22c55e,color:#dcfce7
```

10 大流程额外多了 `revision`（修订）、`summary`（总结）、`feedback`（反馈）这些环节，让整个流程不仅仅是"做完"，还要"做好"和"做对"。

### 协议 = 每个节点必须交出什么

光有流程不够，还得规定每个环节**必须交出什么产物**。这就是协议。

Meta_Kim 的协议不是口头约定，是**结构化的数据包（packet）**：

| 协议产物 | 哪个阶段 | 作用 |
| --- | --- | --- |
| `intentPacket` | Critical | 锁定真实意图，防止执行过程中跑偏 |
| `dispatchBoard` | Thinking | 谁干什么，依赖关系，并行分组 |
| `workerTaskPacket` | Execution | 每个子任务的完整上下文包 |
| `reviewPacket` | Review | 审查发现的结构化记录 |
| `revisionResponse` | Revision | 对每个审查发现的修复响应 |
| `verificationResult` | Verification | 修复是否真的把问题关了 |
| `summaryPacket` | Summary | 对外发布前的最终摘要 |
| `evolutionWriteback` | Evolution | 经验回写目标 |

```mermaid
flowchart LR
    subgraph packets["协议产物流转"]
        direction LR
        IP[intentPacket<br/>意图锁定] --> DP[dispatchBoard<br/>分派看板]
        DP --> WTP[workerTaskPacket<br/>任务包]
        WTP --> RP[reviewPacket<br/>审查发现]
        RP --> RR[revisionResponse<br/>修复响应]
        RR --> VR[verificationResult<br/>验证结果]
        VR --> SP[summaryPacket<br/>最终摘要]
        SP --> EW[evolutionWriteback<br/>经验回写]
    end

    IP ~~~ C2["Critical"]
    DP ~~~ T2["Thinking"]
    WTP ~~~ E2["Execution"]
    RP ~~~ R2["Review"]
    RR ~~~ REV2["Revision"]
    VR ~~~ V2["Verification"]
    SP ~~~ S2["Summary"]
    EW ~~~ EV2["Evolution"]

    style packets fill:#1a1a2e,stroke:#e94560,color:#fff
```

这些协议产物不是可有可无的文档——它们是系统运行的**事实来源**。没有协议，下一节点其实不是在"接力"，而是在"猜上一个节点到底想表达什么"。这就是很多 AI 协作一到复杂任务就开始失真的原因。

当前实现中的协议载体：执行前有 `taskClassification`，发牌前有 `cardPlanPacket`，分发前有 `dispatchEnvelopePacket`，review 之后有 `reviewPacket.findings`，revision 与 verify 之间有 `revisionResponses` + `verificationResults` + `closeFindings`，对外发布前有 `summaryPacket`，进入进化前有 `writebackDecision`。

`npm run validate:run` 会校验这些产物链是否完整闭合。

### 门 = 阶段到了不代表已经过门

协议规定每个节点**必须交出什么**，门规定这些东西**够不够放行**。

一句话说死：

> **阶段说明你走到哪儿，门说明你配不配往前走。**

```mermaid
flowchart LR
    A["到达某个阶段"] --> B{"门判断"}
    B -->|通过| C["放行：进入下一步"]
    B -->|不通过| D["回修：补证据/修产物"]
    B -->|暂不放行| E["留白：等待条件成熟"]
    B -->|升级| F["更高层介入"]

    style A fill:#dbeafe,stroke:#2563eb,color:#000
    style B fill:#7c3aed,stroke:#4c1d95,color:#fff
    style C fill:#dcfce7,stroke:#16a34a,color:#000
    style D fill:#fee2e2,stroke:#dc2626,color:#000
    style E fill:#e0f2fe,stroke:#0284c7,color:#000
    style F fill:#fef3c7,stroke:#f59e0b,color:#000
```

当前系统里的关键门：

| 门 | 把什么关 | 放行条件 |
| --- | --- | --- |
| **planning gate** | 从规划进入执行前 | 边界、owner、交付物、风险都定了 |
| **metaReview gate** | 元审查够不够格 | 审查标准本身没偏、没漏、没松 |
| **verify gate** | 修复是不是真的关了 | finding → revision → verification 闭合 |
| **summary gate** | 能不能对外发布 | 验证通过 + 摘要完成 |
| **publicDisplay gate** | 能不能宣称"已完成" | verifyPassed + summaryClosed + singleDeliverableMaintained + deliverableChainClosed |

最关键的是 **publicDisplay gate**——没有通过验证、摘要未闭合、交付链断裂，就不能假装"做完了"。

门和协议的关系：

- **协议**解决"节点必须交出什么"——偏交付契约
- **门**解决"这些东西够不够放行"——偏准入判定
- 没有协议，门没有判断依据；没有门，协议就是走过场

### 动态发牌 = 补充隐形框架的灵活性

8 大流程的骨架相对固定，但现实中的任务千变万化，不可能一套固定流程覆盖所有场景。所以 Meta_Kim 引入了**动态发牌机制**。

发牌对应 8 大流程，但不是简单的 1:1 映射。10 张牌如下：

| 牌 | 触发条件 | 注意力成本 |
| --- | --- | --- |
| **Clarify（澄清）** | 需求模糊 | 低 |
| **Shrink scope（范围收缩）** | 仓库太大、文件太多 | 低 |
| **Options（方案）** | 需求清晰但路径很多 | 中 |
| **Execute（执行）** | 方案确定 | 高 |
| **Verify（校验）** | 执行完成 | 中 |
| **Fix（修复）** | 校验失败 | 中 |
| **Rollback（回滚）** | 风险扩散 | 高 |
| **Risk（风险）** | 涉及安全/全局/多方 | 高 |
| **Nudge（建议）** | 用户卡住了，轻轻推一下 | 低 |
| **Pause（留白）** | 连续 3 张高成本牌后强制休息 | 零 |

关键在于：**部分牌是动态的**。它们能补充隐形框架相对较死的逻辑：

- 当 3 张高注意力牌连续打出时，系统会**强制插入 Pause（留白）**——不是等用户提醒，是自己知道该停了
- 当安全风险出现时，**Risk 牌会抢占**，打断当前流程
- 当用户已经知道某些信息时，对应的牌会被**跳过**——不做无用功
- 当任务迭代超过上限时，系统会**升级到 Warden 裁定**——不会无限循环

发牌机制让固定骨架有了"呼吸感"——该严的地方严（8 大流程不变），该灵活的地方灵活（动态牌补充）。

```mermaid
flowchart TD
    START[当前牌完成] --> SKIP{检查下一张牌<br/>skip_condition}
    SKIP -->|满足,跳过| NEXT[继续下一张]
    SKIP -->|不满足| INTR{检查中断队列}
    INTR -->|安全风险抢占| RISK[Risk 风险牌<br/>最高优先级]
    INTR -->|无抢占| PAUSE{连续 >=3 张<br/>高成本牌?}
    PAUSE -->|是,强制休息| P[Pause 留白牌<br/>零注意力]
    PAUSE -->|否| DEAL[按优先级发牌]
    RISK --> DEAL
    P --> DEAL
    DEAL --> COUNT{迭代超过<br/>max_iterations?}
    COUNT -->|是| WARDEN[升级到 Warden 裁定]
    COUNT -->|否| START

    style RISK fill:#dc2626,color:#fff
    style P fill:#1e3a5f,color:#93c5fd
    style WARDEN fill:#7c3aed,color:#fff
    style DEAL fill:#16a34a,color:#fff
```

### 闭环 = 不断迭代 + 不断生成 + 不断提升

有了骨架、递进流程、协议、动态发牌，就形成了一个**完美闭环**：

```
需求进来 → 骨架启动 → 发牌决策 → 分派执行 → 审查验证 → 经验沉淀 → agent 升级 → 下一轮更强
```

这个闭环不是一次性的。每一轮都会：

1. **生成对应的 agent**——如果发现能力缺口，系统会通过 Type B 管线自动创建新 agent
2. **提升 agent 的能力**——通过 Evolution 回写，agent 的 SOUL.md、技能负载、工具链都会持续优化
3. **明确每个 agent 的边界**——每个 agent 只管一类事，越界会被 Sentinel 拦截

```mermaid
flowchart TD
    INPUT[需求进来] --> SPINE[隐形骨架启动]
    SPINE --> CARD[动态发牌决策]
    CARD --> DISPATCH[分派给专业 Agent]
    DISPATCH --> REVIEW[审查 + 验证]
    REVIEW --> |通过| EVOLVE[经验沉淀]
    REVIEW --> |不通过| FIX[修复 + 再审查]
    FIX --> REVIEW
    EVOLVE --> UPGRADE[Agent 能力升级]
    UPGRADE --> |发现能力缺口| CREATE[Type B 管线<br/>自动创建新 Agent]
    UPGRADE --> |边界需要调整| BOUNDARY[调整 Agent 边界]
    CREATE --> INPUT2[下一轮更强]
    BOUNDARY --> INPUT2

    style INPUT fill:#fbbf24,color:#000
    style EVOLVE fill:#34d399,color:#000
    style CREATE fill:#f87171,color:#fff
    style INPUT2 fill:#fbbf24,color:#000
```

### Agent 边界 + 技能集成

8 个元角色各管一摊，边界清晰：

| 角色 | 职责 | 不管什么 |
| --- | --- | --- |
| **meta-warden** | 协调、仲裁、最终综合 | 不直接写代码 |
| **meta-conductor** | 工作流、节奏控制 | 不做安全检查 |
| **meta-genesis** | Agent 设计、SOUL.md | 不管工具选型 |
| **meta-artisan** | 技能、MCP、工具匹配 | 不管 agent 人设 |
| **meta-sentinel** | 安全、权限、回滚 | 不管节奏编排 |
| **meta-librarian** | 记忆、连续性 | 不管代码执行 |
| **meta-prism** | 质量审查、反糊弄 | 不管能力搜索 |
| **meta-scout** | 外部能力发现 | 不管内部协调 |

每个 agent 可以集成各种强大的 **skill**（技能）和 **command**（命令），按需加载。Meta_Kim 预装了 9 个社区技能，也支持自定义扩展。

```mermaid
flowchart TD
    WARDEN[meta-warden<br/>协调/仲裁/综合] --> CONDUCTOR[meta-conductor<br/>工作流/节奏]
    WARDEN --> GENESIS[meta-genesis<br/>Agent 设计]
    WARDEN --> ARTISAN[meta-artisan<br/>技能/工具匹配]
    WARDEN --> SENTINEL[meta-sentinel<br/>安全/权限/回滚]
    WARDEN --> LIBRARIAN[meta-librarian<br/>记忆/连续性]
    WARDEN --> PRISM[meta-prism<br/>质量审查]
    WARDEN --> SCOUT[meta-scout<br/>外部能力发现]

    GENESIS -.-> |SOUL.md| ARTISAN
    ARTISAN -.-> |技能负载| GENESIS
    CONDUCTOR -.-> |任务看板| WARDEN
    SENTINEL -.-> |安全拦截| WARDEN
    PRISM -.-> |审查报告| WARDEN
    SCOUT -.-> |能力候选| ARTISAN
    LIBRARIAN -.-> |上下文记忆| WARDEN

    SKILLS[9 个社区技能<br/>+ 自定义扩展] --> ARTISAN
    HOOKS[Hook 自动化<br/>拦截/格式化/检查] --> SENTINEL

    style WARDEN fill:#7c3aed,color:#fff
    style CONDUCTOR fill:#60a5fa,color:#000
    style GENESIS fill:#fbbf24,color:#000
    style ARTISAN fill:#34d399,color:#000
    style SENTINEL fill:#f87171,color:#fff
    style LIBRARIAN fill:#a78bfa,color:#fff
    style PRISM fill:#fb923c,color:#000
    style SCOUT fill:#2dd4bf,color:#000
```

### Hook 自动化

在 Claude Code 中，Meta_Kim 通过 **Hook** 实现自动化：

- **危险命令拦截**：`rm -rf`、`DROP TABLE` 等操作会被自动阻断
- **Git push 提醒**：推送前自动提醒你检查
- **格式化**：编辑 JS/TS 文件后自动格式化
- **类型检查**：编辑后自动跑 TypeScript 检查
- **console.log 警告**：写了 console.log 会提醒你删掉
- **会话结束审计**：会话结束前检查是否有遗留问题
- **子 agent 上下文注入**：自动给子 agent 注入项目上下文

这些 Hook 不是可选的锦上添花——它们是治理系统的执行层保障。

### 跨平台映射

**整个架构可以映射到任何支持 agent 且支持 agent-to-agent 通信的项目上。**

Meta_Kim 当前已经映射了 4 个平台：

| 平台 | 状态 | 映射方式 |
| --- | --- | --- |
| **Claude Code** | 完整支持 | `.claude/agents/*.md` + `SKILL.md` + hooks + MCP |
| **Codex** | 完整支持 | `.codex/agents/*.toml` + skills + commands + hooks |
| **OpenClaw** | 完整支持 | `openclaw/` 目录结构 + workspaces + hooks |
| **Cursor** | 完整支持 | `.cursor/agents/*.md` + skills + hooks + MCP |

核心逻辑是同一套（`canonical/` 目录），只是通过同步脚本（`npm run sync:runtimes`）投影到不同平台的文件结构。

```mermaid
flowchart TB
    CANONICAL["canonical/<br/>（统一源码层）"]

    CANONICAL --> |npm run sync:runtimes| CLAUDE[".claude/<br/>Claude Code<br/>agents + skills + hooks"]
    CANONICAL --> |npm run sync:runtimes| CODEX[".codex/<br/>Codex<br/>agents.toml + skills + hooks"]
    CANONICAL --> |npm run sync:runtimes| OPENCLAW["openclaw/<br/>OpenClaw<br/>workspaces + skills + hooks"]
    CANONICAL --> |npm run sync:runtimes| CURSOR[".cursor/<br/>Cursor<br/>agents + skills + hooks + MCP"]

    NEW[新平台...] -.-> |配置映射| CANONICAL

    style CANONICAL fill:#7c3aed,color:#fff
    style CLAUDE fill:#fbbf24,color:#000
    style CODEX fill:#34d399,color:#000
    style OPENCLAW fill:#60a5fa,color:#000
    style CURSOR fill:#f87171,color:#fff
    style NEW fill:#555,color:#aaa
```

你可以通过配置**不断补充新的平台映射**——只要那个平台支持 agent 和 agent 间通信。

但要注意：四个运行时不是平权关系。当前 Claude Code 的承载面最完整，是主编辑运行时。

| 能力面 | Claude Code | Codex | OpenClaw | Cursor |
| --- | --- | --- | --- | --- |
| **agent** | 原生 agents/subagents，项目级与用户级都成熟 | custom agents/subagents 很强 | workspace 型 agent，支持 agent-to-agent | agent 投影可用，较轻 |
| **skill/references** | 原生 skill、references、全局技能生态完整 | `.agents/skills/` 兼容很好 | workspace skill + installable skill | skill/references 接入较轻 |
| **hook/自动化** | 项目级 hooks + settings.json + 插件生态（12 events） | hooks.json 原生支持（5 events, v0.117.0+） | Plugin SDK hooks（28 hooks） | hooks.json 原生支持（4 events） |
| **MCP/配置** | 原生 MCP 与配置面完整 | 可接 runtime adapter 与 MCP | workspace config 明确 | 可接 MCP，但整体较轻 |
| **治理闭环承载力** | **最高** | 高，但低于 Claude Code | 高，但形态不同 | 最轻 |

原因不是情怀——Claude Code 同时具备 agent、skill、references、hooks、settings、MCP、plugin、全局能力发现这些原生面，让"发牌 → 协议 → 过门 → 自动化守卫 → 写回"这一整套闭环更容易完整承载。

### 仓库四层承载结构

| 层 | 位置 | 作用 |
| --- | --- | --- |
| **canonical 主源** | `canonical/`、`config/contracts/workflow-contract.json` | 长期维护优先改这里 |
| **运行时投影** | `.claude/`、`.codex/`、`.agents/skills/`、`openclaw/`、`.cursor/` | 同一能力投到不同运行时 |
| **本地状态** | `.meta-kim/state/{profile}/`、`.meta-kim/local.overrides.json` | profile 级状态、run index、continuity |
| **脚本与校验** | `scripts/`、`npm run *` | 同步、校验、发现、验收 |

### 三层状态层（项目级 / 全局级 / 本地级）

这三层最容易混，必须分开理解：

| 层级 | 承载位置 | 决定什么 |
| --- | --- | --- |
| **项目级** | 当前仓库的 `canonical/`、contracts、runtime projections、文档、脚本 | 这个项目自己定义了什么 |
| **全局级** | `~/.claude/`、`~/.codex/`、`~/.openclaw/`、`~/.cursor/`、`~/.meta-kim/global/` | 这台机器上还能发现什么 |
| **本地级** | `.meta-kim/state/{profile}/run-index.sqlite`、`compaction/`、`profile.json` | 这次 run 在这个 profile 下留下了什么 |

#### `.meta-kim/` 里面都有什么？

`.meta-kim/` 就是 Meta_Kim 的本地存档目录。它干三件事：

**1. 记住你的选择** — `local.overrides.json`

你第一次跑 `node setup.mjs`，选了"我要用 Claude Code 和 Codex"，这个选择就存在这里。下次跑 setup 不用重新选。

*例子：你电脑上装了 Claude Code、Codex、OpenClaw 三个，但你只想用前两个。这个配置就存在这里，所有脚本读这个文件来决定往哪装技能。*

**2. 记录工作历史** — `state/{profile}/run-index.sqlite`

假设你用 Meta_Kim 的治理流程做了一件事——比如"用 8-stage spine 审查了一段代码"。这个审查的结果记录（叫 run artifact）可以被索引进 SQLite 数据库，以后能查"上次审查了啥、谁审查的、结果怎样"。

*例子：你上周让 meta-prism 审查了认证模块，这周又改了认证模块。系统查 `.meta-kim/state/` 就能知道"上次审查发现了 3 个问题，修复了 2 个，还剩 1 个没修"，不用你重复说。*

**3. 跨会话恢复** — `state/{profile}/compaction/`

你跟 Claude Code 聊到一半，token 用完了，会话断了。compaction 包把你当前做到哪一步、哪些待办没完成存下来，下次开新会话时能接着干。

*例子：你让 Meta_Kim 做一个复杂的多文件重构，做到第 6 步断了。下次开新会话，系统从 compaction 包读到"做到第 6 步了，第 7 步还没开始"，直接从第 7 步继续，不用从头来。*

**其他文件：** `doctor-cache/` 存储每次 `npm run doctor:governance` 的执行结果，`migrations/` 追踪版本间的数据结构升级，`profile.json` 存 profile 元信息。全部由脚本自动管理，你不需要手动编辑。

**快速参考：**

| 路径 | 作用 | 什么时候写入 |
| --- | --- | --- |
| `local.overrides.json` | 记住你选了哪些运行时 | 自动 — 首次运行 `setup.mjs` |
| `state/{profile}/profile.json` | Profile 元信息（创建时间、名称） | 自动 — `setup.mjs` 创建 `default` profile |
| `state/{profile}/run-index.sqlite` | 治理 run 的索引记录 — 谁跑了什么、发现了什么、还有什么没解决 | 按需 — `npm run index:runs -- <artifact>` |
| `state/{profile}/compaction/` | 跨会话接力包：未完成的步骤、待处理的发现、未关闭的验证门 | 按需 — 治理 run 需要跨会话恢复时写入 |
| `state/{profile}/doctor-cache/` | `npm run doctor:governance` 的缓存结果 | 按需 — `doctor:governance` 写入 |
| `state/{profile}/migrations/` | 状态迁移追踪（Meta_Kim 版本间的 schema 升级） | 自动 — 状态 schema 在版本间变化时 |

### 全局安装后哪些能力能用

Meta_Kim 的门和协议有四层执行保障。全局安装（`node setup.mjs`）后，在任何项目中使用时：

| 执行层 | 全局安装后能用 | 需要 Meta_Kim 仓库 |
| --- | --- | --- |
| **Prompt 层**（agents + skills 中定义的门和协议规则） | 能用 — 安装到 `~/.claude/skills/` 和 `~/.claude/agents/`，AI 读 prompt 就会遵守 | — |
| **Hook 层**（会话结束时的门检查、危险命令拦截） | 能用 — 配置在 `.claude/settings.json` 中 | — |
| **配置层**（workflow-contract.json 中的协议字段定义） | 能用 — 协议规则已嵌入 skill prompt，AI 知道每个 packet 必须有哪些字段 | — |
| **代码校验**（`npm run validate:run` 硬校验 packet 链闭合） | — | 需要 — 脚本在 `scripts/validate-run-artifact.mjs` |

前三层是主要防线，全局安装后在任何项目中都能工作。代码校验是最后一道兜底，需要回到 Meta_Kim 仓库目录运行（或将脚本路径指对）。

---

## 三层记忆体系

Meta_Kim 的记忆不是单一的。它有三层，各有分工，共同保障 agent 持续进化且对项目越来越熟。

三层记忆的激活方式各不相同：
- **第一层** 内置于 Claude Code——依赖 Claude Code 运行时（在 `~/.claude/projects/*/memory/` 自动读写）
- **第二层** 由 `node setup.mjs` 自动安装
- **第三层** 由 `node setup.mjs` 安装，但需要手动启动服务器（见下方第三层激活说明）

### 第一层：Memory（Agent 升级记忆）

- **负责什么**：Agent 的升级和持续学习
- **存储位置**：`.claude/projects/*/memory/`
- **工作机制**：每次运行结束前，系统会读取 memory 作为信息进行判断，决定 agent 是否需要升级、边界是否需要调整
- **核心价值**：让 agent 越用越聪明，而不是每次都从零开始
- **激活方式**：自动——AI 在每次会话中自动读写 memory
- **查询方式**：直接问 AI——"之前关于这个项目我们学到了什么？"

### 第二层：Graphify（项目级 LLM Wiki）

- **负责什么**：项目级别的代码知识图谱
- **存储位置**：`graphify-out/graph.json`（NetworkX 节点链接格式）；深度阅读可优先看同目录下的 `GRAPH_REPORT.md`
- **工作机制（数据面）**：`node setup.mjs` 可选步骤会安装 graphify、并**幂等**执行 `python -m graphify claude install` 与 `python -m graphify hook install`（即使 graphify 已通过 pip 安装过也会补全 hook）；git hook 在 commit/checkout 时触发当前仓库内图谱重建。`npm run graphify:install` 行为与之一致（含 hook）。
- **工作机制（使用面）**：同步后的 `meta-theory` 里 Fetch Step 0.5 约定模型如何检测与使用图谱；**不是**后台常驻进程。Claude Code 子代理仅通过 `subagent-context.mjs` 收到**短提示**，不会自动把整份 `graph.json` 塞进上下文。Codex / OpenClaw / Cursor 无该 hook，但共享同一份 `dev-governance.md` 引用；其他运行时可在**目标仓库**按需执行 `python -m graphify codex install` 或 `python -m graphify claw install`（参见 `python -m graphify --help`）。
- **核心价值**：
  - 让记忆越来越熟悉项目——不是记住代码原文，而是理解代码的结构和关系
  - **大幅降低幻觉**——agent 不再凭记忆瞎编，而是基于图谱事实回答
  - **大幅减少 token 消耗**——通过子图提取代替原始文件读取，最高压缩 71 倍
- **质量门槛**：
  - 模糊节点 > 30% → 标记为低质量图谱，回退到直接文件读取
  - 总节点 < 10 → 图谱太稀疏，回退到 Glob/Grep
  - 存在"上帝节点"（入度过高）→ 标记为串行瓶颈
- **激活方式**：`node setup.mjs` 可选 Python 步骤或 `npm run graphify:install`——安装/校验、networkx、Claude 侧注册、**当前仓库** git hook；图谱首次生成仍依赖 hook 触发或手动构建命令
- **查询方式**：`python -m graphify query "你的问题"`——用自然语言查询代码图谱

### 平台自动化对比

| 能力 | Claude Code | Codex | OpenClaw | Cursor |
| --- | --- | --- | --- | --- |
| PreToolUse hook（Glob/Grep 前自动提示） | ✅ settings.json | ❌ | ❌ | ❌ |
| 斜杠命令 `/graphify` | ✅ | ✅ | ✅ | ✅ |
| git hook 自动重建（post-commit/checkout） | ✅ | ✅ | ✅ | ✅ |
| AGENTS.md 常驻规则 | 不适用 | ✅ | ✅ | ✅ |
| setup.mjs 多平台安装 | ✅ claude | ✅ codex | ✅ claw | ✅ cursor |

**核心洞察**：Claude Code 是唯一一个拥有 **PreToolUse hook** 的平台——在搜索前自动提示。其他平台（Codex、OpenClaw、Cursor）使用 **AGENTS.md** 规则，这些规则在会话启动时注入，图谱感知仍然存在，但触发时机是会话开始而非每次搜索。两种机制安装后都是自动化的。

多平台安装请运行 `node setup.mjs`——它会遍历所有选中的平台，幂等执行 `graphify <platform> install`。

### 第三层：SQL（向量级会话检索）

- **负责什么**：项目会话的向量级存储和检索
- **存储方式**：SQLite + 向量扩展（sqlite-vec）
- **工作机制**：把每次会话的关键信息存为向量，下次通过语义相似度检索
- **核心价值**：
  - 跨会话连续性——上次聊到哪了，这次能接上
  • 向量级检索——不是关键词匹配，而是语义理解
  - 精准召回——从历史会话中找到最相关的上下文
- **激活方式**：`node setup.mjs` 安装并配置 MCP Memory Service（第三层）；安装后需手动启动服务器。
  - **Claude Code**：SessionStart Hook 在 `node setup.mjs` 时自动注册
  - **其他工具**（Codex、OpenClaw、Cursor）：参见 `mcp-memory-service/claude-hooks/` 手动安装
- **启动服务器**：`npm start`（在 mcp-memory-service 目录下）或 `python -m mcp_memory_service`，然后访问 `http://localhost:8000`
- **端口覆盖**：服务器遵循 `MCP_HTTP_PORT`（默认 `8000`，与上游一致）；Meta_Kim 的 SessionStart hook 读取 `MCP_MEMORY_URL`，可指向任意可达端点。若你是从旧版 Meta_Kim（硬编码 `8888`）升级而来，请按 CHANGELOG 的 `Migration Notes` 中给出的一行方案修正 `~/.claude/hooks/config.json`。
- **Hook**：Claude Code 自动注册；其他工具参见 mcp-memory-service 文档
- **查询**：`npm run query:runs -- --owner <agent>`——按 agent 查找历史 run，或 `npm run index:runs -- <artifact>` 手动索引 run 产物

### 三层协同

```mermaid
flowchart TB
    subgraph memory["第一层：Memory"]
        M_IN[运行结束前<br/>读取 memory] --> M_JUDGE[判断 Agent<br/>是否需要升级]
        M_JUDGE --> M_OUT[更新边界<br/>调整能力]
    end

    subgraph graphify["第二层：Graphify"]
        G_IN[源文件 > 20 时<br/>自动生成图谱] --> G_COMPRESS[子图提取<br/>最高 71x 压缩]
        G_COMPRESS --> G_QUERY[Agent 基于图谱<br/>事实回答]
    end

    subgraph sql["第三层：SQL"]
        S_IN[会话关键信息<br/>存为向量] --> S_INDEX[SQLite + sqlite-vec<br/>向量索引]
        S_INDEX --> S_RECALL[语义相似度<br/>精准召回]
    end

    memory <--> graphify
    graphify <--> sql
    sql <--> memory

    GOAL1[降低幻觉<br/>基于事实而非编造]
    GOAL2[减少 token<br/>压缩代替全文读取]

    memory --> GOAL1
    graphify --> GOAL1
    graphify --> GOAL2
    sql --> GOAL2

    style memory fill:#fbbf24,color:#000
    style graphify fill:#34d399,color:#000
    style sql fill:#60a5fa,color:#000
    style GOAL1 fill:#dc2626,color:#fff
    style GOAL2 fill:#dc2626,color:#fff
```

三层记忆共同作用，实现两个核心目标：

1. **大幅降低幻觉**——agent 不凭空编造，基于事实和上下文回答
2. **大幅减少 token 消耗**——用图谱压缩代替全文读取，用向量检索代替暴力搜索

---

## 运维命令速查

### 日常使用

| 命令 | 作用 |
| --- | --- |
| `node setup.mjs` | 交互式安装/更新/检查向导 |
| `node setup.mjs --update` | 更新所有技能和依赖 |
| `node setup.mjs --check` | 环境检查（不写盘） |
| `node setup.mjs --lang zh-CN` | 指定中文界面 |

### 同步与校验

| 命令 | 作用 |
| --- | --- |
| `npm run sync:runtimes` | 从 canonical 同步到四端 |
| `npm run check:runtimes` | 检查四端是否同步 |
| `npm run validate` | 项目完整性校验 |
| `npm run verify:all` | 全量校验（含 runtime smoke） |
| `npm run doctor:governance` | 治理健康体检 |

### 技能与依赖

| 命令 | 作用 |
| --- | --- |
| `npm run meta:deps:install` | 安装 9 个社区技能到全局 |
| `npm run meta:deps:install:all-runtimes` | 安装到所有 runtime |
| `npm run meta:deps:install:claude-plugins` | 只安装 Claude Code marketplace plugin |
| `npm run discover:global` | 扫描全局能力 |
| `npm run sync:global:meta-theory` | 同步 meta-theory 到用户级 |

#### Plugin 市场类 skill（Superpowers、Everything Claude Code、cli-anything）

只有 Claude Code 自带原生 plugin 市场。对 **Codex / OpenClaw / Cursor**，安装脚本会从 upstream bundle 按 runtime 优先级抽取对应子目录（sparse-checkout）：

| Runtime | 优先链 |
| --- | --- |
| Claude Code | 原生 `claude plugin install <spec>@<marketplace>`（无 `claudePlugin` 字段的 skill 走 `skills/` 回退） |
| Codex | `.codex/` → `.codex-plugin/` → `skills/` |
| Cursor | `.cursor/` → `.cursor-plugin/` → `skills/` |
| OpenClaw | `skills/` |
| opencode | `.opencode/` → `skills/` |

抽取结果装到 `~/.<runtime>/skills/<id>/`。只装 Claude 市场 plugin：`npm run meta:deps:install:claude-plugins`；一次覆盖全 runtime：`npm run meta:deps:install:all-runtimes`。**升级用户无需手动清理**：老版本的整 repo clone 残留会通过目标目录下的 `.claude-plugin/` 标志自动识别，下次运行自动重抽。

### 高级运维

| 命令 | 作用 |
| --- | --- |
| `npm run validate:run -- <file.json>` | 校验治理 run 产物 |
| `npm run eval:agents` | 轻量 runtime smoke 测试 |
| `npm run eval:agents:live` | 带实时 prompt 的验收 |
| `npm run probe:clis` | 探测本机 CLI 工具 |
| `npm run test:mcp` | MCP 自测 |
| `npm run index:runs -- <dir>` | 索引已验证的 run 产物 |
| `npm run query:runs -- --owner <agent>` | 查询 run 索引 |
| `npm run migrate:meta-kim -- <dir> --apply` | 导入旧版提示包 |

---

## FAQ

### Q：我用 `npx` 装的，文件在哪？

Meta_Kim 把产物写到 3 个地方：

1. **当前目录** — `.claude/`、`.codex/`、`.cursor/`、`openclaw/` 本项目的 runtime 投影
2. **用户 home** — `~/.claude/skills/meta-theory/`（以及 `.codex / .cursor / .openclaw`）跨项目共享的全局 skill
3. **清单** — `~/.meta-kim/install-manifest.json` 记录所有改动，支持安全卸载

在你跑 `npx` 的那个目录下运行 `npm run meta:status`（或 `node setup.mjs --check`）查看完整足迹。想回滚就跑 `npm run meta:uninstall`。

### Q：Meta_Kim 和普通的 AI 编码助手有什么区别？

普通 AI 编码助手是你问什么它就做什么，没有中间的治理环节。Meta_Kim 在"问"和"做"之间加了好几层：先确认你到底要什么，再规划谁来做，做完还要审查，审完还要验证，验证通过还要沉淀经验。**它不是另一个 AI，是给 AI 装了一套工程纪律。**

### Q：我只有一个文件要改，需要用 Meta_Kim 吗？

**不需要。** Meta_Kim 解决的是跨文件、跨模块、需要多能力协作的复杂任务。如果你只是改一个文件里的一个函数，直接用 Claude Code 就够了。别用大炮打蚊子。

### Q：8 大流程和 10 大流程是什么关系？

8 大流程是**执行骨架**（Critical → Fetch → Thinking → Execution → Review → Meta-Review → Verification → Evolution），相对固定。10 大流程是从骨架**派生出来的业务工作流**（direction → planning → execution → review → meta_review → revision → verify → summary → feedback → evolve），更注重交付物流转和闭环。10 大流程不是推翻 8 大流程，而是在它之上增加了递进治理的复杂度。

### Q：动态发牌是什么意思？

8 大流程是固定的，但现实中任务千变万化。发牌机制让系统在固定流程中有了灵活性——比如连续干了 3 件高强度的事，系统会自动暂停（Pause 牌）；发现安全问题，会立即打断当前流程（Risk 抢占牌）。**固定骨架保证了底线，动态发牌保证了适应性。**

### Q：三层记忆会不会很重？

不会。三层各有分工：
- Memory 很轻，就是几个 markdown 文件
- Graphify 只在源文件 > 20 的项目才会启用，而且生成一次后可以复用
- SQL 用的是本地 SQLite，不需要额外的数据库服务

三层加起来的资源消耗，远小于你每次从零开始让 AI 读整个项目的 token 消耗。

### Q：支持哪些平台？

目前完整支持 Claude Code、Codex、OpenClaw、Cursor 四个平台。核心逻辑在 `canonical/` 目录，通过同步脚本投影到各平台。只要一个平台支持 agent 和 agent 间通信，理论上就能映射上去。

### Q：安装复杂吗？

一行命令搞定：

```bash
npx --yes github:KimYx0207/Meta_Kim meta-kim
```

或者克隆后运行：

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

向导会引导你选择语言、平台和安装范围。

### Q：为什么叫"元"？

在 Meta_Kim 里，**元 = 最小的可治理单元**。一个有效的元单元必须：
- 拥有一个明确的责任类别
- 定义它的拒绝边界
- 可以被独立审查
- 可以被替换
- 可以被安全回滚

不是什么都能叫"元"的。够得上这个标准，才算。

### Q：这个项目和 MCP 有什么关系？

Meta_Kim 使用 MCP（Model Context Protocol）来扩展 agent 的能力边界。通过 `.mcp.json` 配置文件，agent 可以调用外部工具和服务。但 Meta_Kim 本身不是一个 MCP 服务器——它是一套治理框架，MCP 只是它集成的工具之一。

## 延伸阅读

- [README.md](README.md)
- [AGENTS.md](AGENTS.md)
- [config/contracts/workflow-contract.json](config/contracts/workflow-contract.json)
- [docs/runtime-capability-matrix.md](docs/runtime-capability-matrix.md)

---

## 第三方依赖

Meta_Kim 本身采用 MIT 协议。以下可选技能仓库通过 `node setup.mjs` 单独安装，各自的许可证独立适用。

### npm 依赖

| 包名 | License |
|------|---------|
| [`@inquirer/prompts`](https://github.com/SBoudrias/Inquirer.js) | MIT |
| [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) | MIT |
| [`zod`](https://github.com/colinhacks/zod) | MIT |

### 可选技能仓库

| 仓库 | License |
|-----|---------|
| [KimYx0207/agent-teams-playbook](https://github.com/KimYx0207/agent-teams-playbook) | MIT |
| [KimYx0207/findskill](https://github.com/KimYx0207/findskill) | MIT |
| [KimYx0207/HookPrompt](https://github.com/KimYx0207/HookPrompt) | MIT |
| [obra/superpowers](https://github.com/obra/superpowers) | MIT |
| [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) | MIT |
| [OthmanAdi/planning-with-files](https://github.com/OthmanAdi/planning-with-files) | MIT |
| [HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything) | Apache 2.0 |
| [garrytan/gstack](https://github.com/garrytan/gstack) | MIT |
| [anthropics/skills](https://github.com/anthropics/skills) | 未声明许可证（© Anthropic, PBC） |

### 可选 pip 包

| 包名 | License |
|------|---------|
| [`graphifyy`](https://github.com/safishamsi/graphify) | MIT |
| [`mcp-memory-service`](https://pypi.org/project/mcp-memory-service/) | Apache 2.0 |

---

## License

本项目采用 [MIT License](LICENSE)。
