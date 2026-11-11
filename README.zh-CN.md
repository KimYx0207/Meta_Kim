<div align="center">

# 元 · Meta_Kim

**把一句想法，变成能继续、能协作、能验收的工作。**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

[![GitHub 星标](https://img.shields.io/github/stars/KimYx0207/Meta_Kim?style=flat&label=%E6%98%9F%E6%A0%87)](https://github.com/KimYx0207/Meta_Kim/stargazers)
[![许可证 Apache 2.0](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-Apache--2.0-green)](LICENSE)

</div>

## 从一句想法，做到实际交付

**Meta_Kim 帮你的 AI 助手把跨文件、跨专业、跨会话的事情做下去。** 你在常用客户端里说目标，它读取项目、研究方案、组织协作，并保存已经做出的决定和已经完成的成果。

> “帮我做个手机上能用的活动报名工具。先帮我选方案，再把报名、名单和导出做出来，最后实际用一遍给我看。”

![从用户目标、研究决策、两层 PRD 和专业协作，到检查后的交付](docs/images/intent-to-delivery.zh-CN.svg)

*两个项目的协作方式。依赖已经满足的独立任务可以并行推进。*

| 你需要什么 | Meta_Kim 帮你组织什么 |
| --- | --- |
| 想清楚方向 | 项目现状、有效参考、可选方案和推荐理由 |
| 一份能开工的计划 | 一份 PRD：先定系统与技术，再细化模块、接口和验收 |
| 专业的人做专业的事 | 为执行者配上方法、项目资料和交付标准 |
| 中断后继续 | 保存决定、成果、依赖关系和下一步 |
| 看得见进展 | Live 工作看板里的任务、负责人、产物和检查结果 |

**[Kim Service](https://github.com/KimYx0207/Kim_Service) 提供专业方法，Meta_Kim 管整件事怎么往前走。** 两者可以配合使用，也可以接入其他能力来源。真正影响产品结果的选择交给你，日常实现细节由执行团队处理。

## 三步开始

需要 **Node.js 22.13.0+**，以及已配置好的 AI 客户端。当前版本：**[v3.10.0](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.10.0)**。

**1. 安装，选择你使用的客户端。**

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

默认在全局复用能力；项目需要专门配置时，再选择项目安装。需要全局 Hook 时添加 `--with-global-hooks`，已有用户配置会合并保留。也可以通过 `npx --yes github:KimYx0207/Meta_Kim` 开始。

**2. 打开项目，直接说想要的结果。**

不用背命令，也不用先报出技术角色。说清楚希望什么能用、哪些内容要保留。助手先读取项目中已有的信息，再问真正会改变方案的问题。

**3. 看进展，使用交付物。**

打开当前任务的 Live 链接，或运行 `node bin/meta-kim.mjs live`。看板会把任务、负责人、依赖和产物串起来。[查看真实 Live 界面的中文示例](docs/images/meta-kim-live-demo.png)。

已有克隆仓库这样更新：

```bash
git pull --ff-only
node setup.mjs --update
node setup.mjs --check
```

## 客户端接入

| 客户端 | 已提供的接入方式 |
| --- | --- |
| **Codex · Claude Code** | 主要集成：原生指令、Agent、Skill、配置和 Hook |
| **Cursor · OpenClaw** | 可选兼容集成，使用各自支持的配置格式 |
| **Gemini CLI** | 可选原生 Agent、共享 Skill、设置和 Hook |
| **ZCode** | 可选 Agent、Skill、MCP 和用户级 Hook |
| **DSH — DeepSeek Harness** | 原生 Skill、独立配置或项目安装，以及 MCP |
| **Qoder · Trae** | Beta 兼容适配器 |

安装、能力包加载和实际任务分别验收。DSH 已有官方程序的无模型配置、Skill 与 MCP 探针；Gemini CLI、ZCode 已有投影和安装生命周期检查。模型的专业效果以实际任务产物评价。具体结果见[兼容性目录](config/runtime-compatibility-catalog.json)和[验证记录](docs/verification/dsh-professional-quality-20261111.md)。依赖项目自己的客户端支持由上游维护。

### DSH 快速开始

DSH 需要 **Node.js 24.9.0+**。本集成已对照 DSH `0.2.2-rc.1` 检查。

```sh
node bin/meta-kim.mjs dsh install
node bin/meta-kim.mjs dsh check
dsh --profile meta-kim
```

添加 `--service-package /path/to/kim-service-dsh` 可带上 [Kim Service 构建的专业包](https://github.com/KimYx0207/Kim_Service/blob/main/docs/dsh.md)。同一入口支持 `update` 和 `uninstall`。[DSH 指南](canonical/skills/meta-theory/references/runtime-dsh.md) · [ZCode 指南](canonical/skills/meta-theory/references/runtime-zcode.md)。

## 小范围试，出问题只停相关任务

默认 Hook 随任务推进给出提示，不再因为项目运行满七天就自动升级为阻断。

准备好的单项工单可以直接开始一次受监督试运行。对已经接入监督的任务，同一方案和依据连续两次无效，会触发该任务的保险丝；独立任务继续。换用经过审阅的新方案后，先进行一次恢复试运行，记录效果再决定后续。权限、文件归属和破坏性操作仍按当前授权处理。

等你验收时，也只暂停真正依赖该决定的任务。下次继续，保留其他已完成成果。可复用方法的改进同样先试、再评价，然后把有效版本留下来。

<details>
<summary>可选记忆服务</summary>

项目连续性使用持久化任务记录。如果同时启用了 Memory，可检查自己配置的服务地址，例如：

```bash
curl -fsS --max-time 3 http://127.0.0.1:8000/api/health
```

`.mcp.json` 配置、hook 安装、服务健康、写入、读取和跨会话召回分别检查。`npm run meta:test:mcp` 检查 Meta_Kim 自己的 MCP 服务；健康检查说明服务是否可访问。

</details>

## 继续了解与参与开发

| 目录 | 用途 |
| --- | --- |
| `canonical/` | 共用的 Agent、Skill、规则和客户端资源 |
| `config/` | 能力索引与机器协议 |
| `scripts/` · `src/` | 安装、执行、存储和 Live |
| `tests/` | 行为与回归检查 |
| `.meta-kim/` | 本地任务状态、计划和备份 |

各客户端目录从共用源文件生成，由 `.gitignore` 保留在本地，不提交到 GitHub 源码。参与开发前请读 [AGENTS.md](AGENTS.md)。

[架构说明](docs/harness-architecture.md) · [意图到交付](canonical/skills/meta-theory/references/intent-to-delivery.md) · [Live SDK](docs/live-sdk.md) · [更新日志](CHANGELOG.zh-CN.md)

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
