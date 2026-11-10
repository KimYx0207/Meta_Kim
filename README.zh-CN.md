<div align="center">

# 元 · Meta_Kim

**把一句想法，变成可追踪、可验收的交付。**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

<a href="https://github.com/KimYx0207/Meta_Kim/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/KimYx0207/Meta_Kim?style=flat"/></a>
<a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-green"/></a>

<a href="config/runtime-compatibility-catalog.json"><img alt="Default: Claude Code and Codex; compatibility: OpenClaw and Cursor" src="https://img.shields.io/badge/default-Claude%20Code%20%7C%20Codex%20%2B%20compat--OpenClaw%20%7C%20Cursor-111827"/></a>
<a href="config/runtime-compatibility-catalog.json"><img alt="Opt-in projections: Gemini CLI and ZCode" src="https://img.shields.io/badge/opt--in-Gemini%20CLI%20%7C%20ZCode-4F46E5"/></a>

</div>

## 这是什么？

**Meta_Kim 是 AI 编程助手的 Harness 框架：把一个还没想完整的需求，组织成明确的决策、共同的计划、协作任务和可检查的结果。** 你继续使用自己的 AI 客户端，用自然语言说目标，由 Meta_Kim 围绕目标组织工作。

说直白一点：**Meta_Kim 管整件事怎么往前走，Kim Service 提供每项工作需要的专业方法。** 你说“继续”，它应接着当前决定和成果往下做；你改变需求，它按关联关系找出需要重做的部分。

适合涉及多个决策、文件、专业或会话的任务：做一个产品、迭代已有系统、研究技术方案、协调一次复杂修复。清晰的小改动会走较轻的流程。

> “我想做一个活动报名工具。用户能在手机上报名，我能看到准确的名单。先帮我研究怎么做、比较方案，再把选定的方案做出来并验证。”

![Meta_Kim 从意图、研究、两层 PRD 到专业协作和验证交付的关系图](docs/images/intent-to-delivery.svg)

*这是架构示意图。实际调度取决于当前客户端能力、任务依赖、权限和验证证据。*

## 你能看到什么

| 过程 | 用户能理解的结果 |
| --- | --- |
| 理解 | 目标、现有项目事实、约束，以及还没弄清楚的问题 |
| 研究和决策 | 相关资料、可行方案、推荐理由和实际取舍 |
| 设计 | 一份 PRD 的两层视图：先定系统和技术基线，再细化模块、接口、状态和验收 |
| 组织执行 | 每项工作有负责人、专业方法和必要资料；符合条件的独立任务可以并行 |
| 审查和验证 | 实际产物、刚执行的检查、失败项和剩余缺口 |
| 继续和改进 | 中断后保留已定决策与已完成工作，经过评价的经验可以成为可复用能力 |

**方向、范围、成本或验收确实需要你做决定时，才把选择交给你。** 内部 Agent 和工具由宿主从实际发现的能力中选择。文字相似只能找到候选，不能证明这个专业角色适合当前任务。

### Meta_Kim 与 Kim Service 怎么配合？

| 项目 | 负责什么 |
| --- | --- |
| **[Meta_Kim](https://github.com/KimYx0207/Meta_Kim)** | 理解、研究、决策、编排、审查、验证和跨轮连续性 |
| **[Kim Service](https://github.com/KimYx0207/Kim_Service)** | 可复用的专业 Agent、Skill、Hook、Tool，以及方法、示例和输入输出边界 |

前端 Agent 需要真实的设计与工程知识、项目约束和当前任务资料。集成会读取选中的专业资料，校验其内容，并送进实际工单。一个角色名字、几句提示词或通过 JSON 校验，都不能代替专业质量。

## 三步开始

需要 **Node.js 22.13.0 或更新版本**，以及你已配置好的客户端。

**1. 获取并安装。**

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

在安装器里选择自己使用的客户端。默认在全局复用能力，项目需要专门配置时再使用现有的项目引导流程。需要全局 Hook 时显式添加 `--with-global-hooks`。安装记录会区分自己管理的内容与用户已有配置。

也可以通过 `npx --yes github:KimYx0207/Meta_Kim` 进入。持久化的客户端资源会落到稳定的软件包目录，不依赖临时 npm 缓存。

**2. 在选定客户端打开你的项目，直接说想要的结果。**

不用背命令，也不用先报出技术角色。说明什么应该能用、哪些内容必须保留、你会怎样验收。宿主先查项目中能查到的事实，再问真正影响方向且尚未解决的问题。

**3. 看进展，检查交付。**

使用当前项目/任务给出的 Live 链接，或者运行 `node bin/meta-kim.mjs live`。界面从同一份任务记录展示负责人、依赖、产物和阻塞。

![Meta_Kim Live 工作看板，使用示例数据展示真实界面](docs/images/meta-kim-live-demo.png)

*真实 Live 渲染器配合代表性示例数据。工具返回、检查通过、产品被验收，是不同的状态。*

### 已克隆用户怎么更新？

```bash
git pull --ff-only
node setup.mjs --update
```

用 `node setup.mjs --check` 检查所选安装。用户改动和无法确认归属的历史文件会保留供审查。源码更新、依赖更新和客户端真实执行分别报告。

## 客户端支持：做到哪一步，验证到哪一步

已发布基线是 [v3.9.0](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.9.0)。[Unreleased](CHANGELOG.zh-CN.md#unreleased---未发布) 记录当前源码新增内容，不代表已经发布了新版本。

| 客户端 | 当前源码接入 | 验证边界 |
| --- | --- | --- |
| **Codex** | Primary 正式投影：指令、Agent、Skill、Hook/配置和只读执行桥 | 以当前宿主实际能力和证据为准 |
| **Claude Code** | Primary 正式投影：原生 Agent、Skill、Hook 和只读执行桥 | 单独维护其原生工具约定 |
| **Cursor** | 非默认兼容投影：规则、Skill、Agent 和对应配置 | 投影检查不等于所有客户端流程已验证 |
| **Gemini CLI** | 按需启用的原生投影：Agent、共享中立 Skill、原生设置和 Hook | 结构与生命周期验证；模型真实执行尚未认证 |
| **ZCode** | 按需启用的原生投影：Agent、Skill、MCP 和用户级 Hook | 当前客户端忽略项目级 Hook；模型真实执行尚未认证 |
| **OpenClaw** | 保留现有非默认兼容投影 | 需要自身配置和宿主证据 |
| **DSh / DeepSeek Harness** | 通过 `meta-kim dsh` 接入原生 Skill、独立 profile／项目 patch 和 MCP | 已做不调用模型的官方配置、Skill 和 MCP 探测；自定义原生 Agent、强制 Hook 与业务质量分别验收 |

Qoder、Trae 保持 **Beta 兼容 adapter**。DSh 保留历史只读候选适配器，另增按需启用的原生接入；不因此扩张现有执行桥的运行时权限。ZCode 历史上的只读候选适配器与新增的按需投影分别保留。详情见[兼容目录](config/runtime-compatibility-catalog.json)、[Gemini 说明](canonical/skills/meta-theory/references/runtime-gemini.md)和 [ZCode 说明](canonical/skills/meta-theory/references/runtime-zcode.md)。

依赖项目自己的安装目标由上游项目维护，不能据此宣称 Meta_Kim 已通过适配。Gemini 与 Codex 共存时使用宿主中立的项目 Skill，具体工具和路径由当前客户端决定。[Gemini Skill 官方说明](https://geminicli.com/docs/cli/skills/)和 [ZCode Hook 官方说明](https://zcode.z.ai/en/docs/hooks)给出了这些差异的依据。

### DSh 快速开始

安装当前 Meta_Kim 源码后执行：

```sh
node bin/meta-kim.mjs dsh install
node bin/meta-kim.mjs dsh check
dsh --profile meta-kim
```

DSh 本身要求 **Node >=24.9.0**，Meta_Kim 其他客户端的版本要求不变。本适配核对 DSh `0.2.2-rc.1`。加 `--service-package /path/to/kim-service-dsh`，可以接入 [Kim_Service 构建的完整专业 Skills](https://github.com/KimYx0207/Kim_Service/blob/main/docs/dsh.md)。同一入口支持 `update`、`check`、`uninstall`，保留用户文件和改动。[DSh 说明](canonical/skills/meta-theory/references/runtime-dsh.md)包含项目安装、完整方法读取、共享包保留和验证边界。

## 连续性和自我进化如何落地？

每项专业输出都有通过条件、拒收条件、验证方法、所需证据和是否阻断，Meta_Kim 会将这些标准交到实际工作者手里。工作者自报“通过”仍待独立核验；关键证据缺失不能被其他通过项抵消。检查、实测和未测范围见[本轮验证记录](docs/verification/dsh-professional-quality-20261111.md)。

系统设计与模块细节属于**同一份 PRD**，连接同一组任务和验收条件。一个模块变化，会沿实际依赖找出受影响工作；其他已完成产物可以在核对当前绑定后复用。

持久化只读执行器按“宿主当前容量”和“计划容量”的较小值派工。独立任务同时执行，一项完成后可立即释放依赖并补位。未知容量默认串行，现有全局阶段屏障和写入权限继续有效。

人工验收按实际依赖暂停：A 等人验收时，不依赖 A 的 B、C 可以继续。恢复后保留已完成成果，最终交付仍须通过每个必要关卡。Live 界面会把待验收与独立工作分别说明。

依赖按实际能力选择。重复的流程提示整合进现有自有方法，浏览器、桌面控制等执行引擎保留各自接口。能力、Skill、Tool、MCP、Hook 的区别和分层说明见[架构与能力模型](docs/harness-architecture.md)。

RSI 是可以评价的改进循环：实际经历 → 改进候选 → 评估 → 审查后提升。缺少质量观察时保持未评价，反思文字、分数或证据文件名不能替自己批准修改。实验指令变化会使旧实验记录失去复用资格，历史成绩不会自动证明新版本有效。

当前源码导航帮助查找调用方和关联文件，没有 Graphify 也能工作。静态搜索没有找到引用，只能提示进一步核查；删除前还要看动态加载、配置、生成内容和外部入口。

### 可选记忆：确认实际做到了什么

如果启用了可选的 Memory 服务，可以检查默认本地健康地址：

```bash
curl -fsS --max-time 3 http://127.0.0.1:8000/api/health
```

修改过地址时使用自己的配置。`.mcp.json` 中有配置、hook 已安装，均不代表记忆实际可用；不能仅凭 health check 就宣称写入、读取或跨会话召回成功，这些操作各自需要新鲜的实际回执。`npm run meta:test:mcp` 检查 Meta_Kim 自身的 MCP 服务约定，不验证这些外部 Memory 操作。Memory 是可选能力，也不替代项目已有的持久化任务记录。

## 目录怎么找？

| 位置 | 用途 |
| --- | --- |
| `canonical/` | 治理 Agent、Skill、规则和客户端资源的源文件 |
| `config/` | 约定、兼容声明和证据记录 |
| `scripts/` · `src/` | 执行、校验、适配、存储和用户工具 |
| `tests/` | 行为及回归检查；夹具注明其证据边界 |
| 客户端生成目录 | 从 canonical 重建的本地投影 |
| `.meta-kim/` | 私有任务状态、项目规划、证据和备份 |

完整方法与参考项目见[从意图到交付](canonical/skills/meta-theory/references/intent-to-delivery.md)，数据流见[项目、研究与 PRD](canonical/skills/meta-theory/references/project-research-prd.md)。参与开发先读 [AGENTS.md](AGENTS.md)。原有八阶段主流程继续作为治理主线。

生成的 runtime projection 目录是本地输出，由 `.gitignore` 保护，不能作为 GitHub source 提交。

维护者常用命令：

```bash
npm run meta:sync
npm run meta:validate
npm run meta:test:ci -- --suite core
npm run meta:test:ci -- --suite governance
```

本地测试只能证明它实际覆盖的行为。客户端原生执行、模型质量和用户最终验收需要各自的证据。另见[原生 CLI 观察与隐私](docs/native-cli-observation.md)、[Live SDK](docs/live-sdk.md)、[Graphify 生命周期](docs/graphify-managed-lifecycle.md)及[变更记录](CHANGELOG.zh-CN.md)。

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

## License

采用 [Apache License 2.0](LICENSE)，允许商业使用。再分发 Meta_Kim 或重要组成部分时保留 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)；第三方能力遵循各自许可证。署名不代表作者为衍生项目背书。

建议署名：**Meta_Kim by KimYx0207 — https://github.com/KimYx0207/Meta_Kim**
