<div align="center">

# 元 · Meta_Kim

**把一个目标，变成清晰的计划、专业协作和可使用的成果。**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

[![GitHub 星标](https://img.shields.io/github/stars/KimYx0207/Meta_Kim?style=flat&label=%E6%98%9F%E6%A0%87)](https://github.com/KimYx0207/Meta_Kim/stargazers)
[![许可证 Apache 2.0](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-Apache--2.0-green)](LICENSE)

</div>

## 把一件完整的事，交给 AI 接着做

**Meta_Kim 在你常用的 AI 客户端里，把目标、项目资料、专业方法和工作进展连接起来。** 它帮助助手理解需求、选择方案、组织执行并检查结果。已经做出的决定和完成的工作留在项目中，下次打开还能接着推进。

### 哪些时候用得上

| 你的情况 | Meta_Kim 怎样组织这件事 |
| --- | --- |
| 有一个工具或新功能的想法 | 比较可行方案，确定用户怎么用，再形成计划和实现任务 |
| 已有产品需要改进 | 先看当前项目，找到相关体验和代码，再围绕问题修改、验证 |
| 一件事涉及多个专业，或要分几次做完 | 给任务配上合适的方法和资料，理清依赖，中断后从已有成果继续 |

你用自己的话说清楚想得到什么，Meta_Kim 围绕这个结果安排工作。**[Kim Service](https://github.com/KimYx0207/Kim_Service) 为具体执行提供专业方法。** 两者可以配合使用，也可以结合客户端里已有的其他能力。

## 最后会交到你手里什么

以活动报名工具为例，你可以这样开始：

> “帮我做个手机上能用的活动报名工具。先帮我选方案，再做出报名和名单导出，最后带我走一遍怎么用。”

确定范围后，这句话会落到具体交付上。这个例子可以这样安排：

| 要完成的事 | 你可以查看的交付物 |
| --- | --- |
| 选定方案 | 推荐方案、用户流程、相关参考和选择理由 |
| 把产品想清楚 | 一份需求文档：先定系统和技术，再细化模块、接口和验收标准 |
| 实现使用流程 | 报名、名单管理和导出任务，以及相关源码和资料 |
| 检查实际结果 | 报名与导出的操作演示、检查记录和需要返修的具体问题 |
| 下次接着做 | 已完成产物、已定选择、剩余任务和下一步 |

小到一次局部修复，大到一个产品，都按实际工作需要展开计划。

## 工作怎样往前走

![从目标、研究和计划，到专业协作与交付检查](docs/images/intent-to-delivery.zh-CN.svg)

1. **先弄清要得到什么。** 读取现有项目，只追问会改变结果的关键问题。
2. **找到合适的做法。** 调查重要未知，比较有实际差异的方案，给出推荐理由。
3. **让计划可以开工。** 明确任务、输入、负责人、依赖关系和完成标准。
4. **组织执行与协作。** 把所需方法和资料交给具体任务，已就绪的独立工作可以一起推进。
5. **检查、试用，再改进。** 对照目标审阅成果，吸收反馈，把有用的决定和结果留给下一轮。

**Live 工作看板**把任务、负责人、依赖、产物和检查结果放在一起。中断后，可以根据保存的记录继续；某项任务需要换个做法时，下一步会留在记录里，独立工作继续推进。

<details>
<summary>展开查看 Live 演示界面（中文）</summary>

![中文 Live 界面中的演示任务数据](docs/images/meta-kim-live-demo.png)

*图中为中文 Live 界面，展示的是演示任务数据。*

</details>

## 从你的第一个项目开始

需要 **Node.js 22.13.0+**，以及已配置好的 AI 客户端。当前版本：**[v3.10.1](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.10.1)**。

### 1. 安装 Meta_Kim

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

跟随安装提示选择客户端和安装范围。全局安装便于多个项目复用能力；项目安装适合需要专门配置的项目。已有用户配置会合并保留。[查看安装选项](docs/technical-notes.zh-CN.md#安装选项)。

### 2. 打开项目，说明想要的结果

在配置好的客户端里打开目标项目，像平时沟通一样提出需求：

> “帮我检查这个项目的注册流程，让手机上填写更顺手，保留现在的数据字段，改好后把流程和检查结果给我看。”

助手先读取已有项目资料。真正影响产品结果的选择交给你，日常实现细节由执行团队处理。

### 3. 跟进进展，试用交付物

打开当前任务的 Live 链接。也可以在 Meta_Kim 仓库目录中，为你的项目启动 Live：

```bash
node bin/meta-kim.mjs live --project-root "/path/to/your-project"
```

把示例路径换成你的项目目录。结合产物和检查记录验收，再告诉助手下一轮要改哪里。

### 更新已有安装

在 Meta_Kim 仓库目录中运行：

```bash
git pull --ff-only
node setup.mjs --update
node setup.mjs --check
```

## 选择你使用的客户端

按自己的工作习惯选择即可。各接入方式使用对应客户端的配置和扩展格式。

| 客户端 | 接入方式与入口 |
| --- | --- |
| **Codex · Claude Code** | Agent、Skill、指令和 Hook；安装时选择对应客户端 |
| **Cursor** | Agent、Skill、项目规则和 Hook；安装时选择 Cursor |
| **OpenClaw** | Skill、Agent 工作区和配置模板；安装时选择 OpenClaw |
| **Gemini CLI** | Agent、共享 Skill、设置和 Hook；[接入指南](canonical/skills/meta-theory/references/runtime-gemini.md) |
| **ZCode** | Agent、Skill、MCP 和用户级 Hook；[接入指南](canonical/skills/meta-theory/references/runtime-zcode.md) |
| **DeepSeek Harness（DSH）** | Beta 接入：原生 Skill、独立配置或项目安装，以及 MCP；[接入指南](docs/technical-notes.zh-CN.md#deepseek-harness) |
| **Qoder · Trae** | Beta 兼容适配器；[接入详情](config/runtime-compatibility-catalog.json) |

[兼容性目录](config/runtime-compatibility-catalog.json) · [安装与技术说明](docs/technical-notes.zh-CN.md)。依赖项目自己的客户端支持由上游维护。

## 按你接下来要做的事找文档

| 你想了解 | 对应文档 |
| --- | --- |
| 怎样选安装范围、启用 Hook 或配置可选服务 | [安装与技术说明](docs/technical-notes.zh-CN.md) |
| 研究和需求怎样传到具体执行任务 | [从意图到交付](canonical/skills/meta-theory/references/intent-to-delivery.md) |
| 怎样使用或扩展 Live 界面 | [Live SDK](docs/live-sdk.md) |
| 项目怎样组织，如何参与开发 | [架构说明](docs/harness-architecture.md) · [开发指南](AGENTS.md) |
| 每个版本给使用带来了什么变化 | [更新日志](CHANGELOG.zh-CN.md) |

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
