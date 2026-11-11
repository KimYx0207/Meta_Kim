# 安装、客户端与任务连续性

[English](technical-notes.md) · [简体中文](technical-notes.zh-CN.md) · [日本語](technical-notes.ja-JP.md) · [한국어](technical-notes.ko-KR.md)

[返回产品介绍](../README.zh-CN.md)

这里帮助你选择安装方式，并找到具体操作说明。客户端指南和配置文件保留详细的接入规则。

## 安装选项

首次安装步骤见 [README](../README.zh-CN.md#从你的第一个项目开始)。Meta_Kim 需要 Node.js 22.13.0+ 和已配置好的 AI 客户端。

| 选项 | 什么时候使用 |
| --- | --- |
| 全局安装 | 希望多个项目复用同一套能力 |
| 项目安装 | 项目需要专门配置；非交互命令可明确指定 `--scope project` |
| 客户端选择 | 按实际使用情况选择；常规安装目标也可用 `--targets` 明确指定 |
| 全局 Hook | 需要所选客户端的全局 Hook 接入时，添加 `--with-global-hooks` |
| 环境检查 | 用 `node setup.mjs --check` 查看安装环境 |

已有设置会合并，托管更新会记录哪些文件由 Meta_Kim 管理。可运行 `node bin/meta-kim.mjs --help` 查看 CLI 操作。也可以通过 `npx --yes github:KimYx0207/Meta_Kim` 启动安装器。

克隆仓库的更新顺序是先 `git pull --ff-only`，再 `node setup.mjs --update`。使用 npx 安装的环境可运行 `npx --yes github:KimYx0207/Meta_Kim update`。

## 客户端指南

[Claude Code](../canonical/skills/meta-theory/references/runtime-claude.md) · [Codex](../canonical/skills/meta-theory/references/runtime-codex.md) · [Gemini CLI](../canonical/skills/meta-theory/references/runtime-gemini.md) · [ZCode](../canonical/skills/meta-theory/references/runtime-zcode.md)

[兼容性目录](../config/runtime-compatibility-catalog.json)记录各客户端的配置形式与当前接入级别，包括 Cursor、OpenClaw、Qoder 和 Trae。Hook 的覆盖范围取决于宿主提供的事件，具体差异见[运行说明](../AGENTS.md)。依赖项目自己的客户端支持由上游维护。

## DeepSeek Harness

DSH 是一个可选接入客户端，使用独立的安装管理命令。它需要 **Node.js 24.9.0+**；当前核对的宿主版本是 **DSH 0.2.2-rc.1**。

在 Meta_Kim 仓库目录中运行：

```sh
node bin/meta-kim.mjs dsh install
node bin/meta-kim.mjs dsh check
dsh --profile meta-kim
```

同一个 Meta_Kim CLI 的 `node bin/meta-kim.mjs dsh update` 和 `node bin/meta-kim.mjs dsh uninstall` 用于更新和移除托管接入。添加 `--service-package /path/to/kim-service-dsh` 可安装 [Kim Service 构建的专业包](https://github.com/KimYx0207/Kim_Service/blob/main/docs/dsh.md)。项目安装使用 `--scope project --project-root /path/to/project`，完成后会给出该项目的启动命令。

[DSH 指南](../canonical/skills/meta-theory/references/runtime-dsh.md)说明配置、完整方法加载、MCP 和宿主权限。[验证记录](verification/dsh-professional-quality-20261111.md)说明已经检查的配置、Skill 发现、资料交接和 MCP 范围。原生任务结果和模型专业效果按任务的实际产物评价。

## 中断后继续任务

运行记录把决定、已完成产物、依赖关系和剩余工作保存在项目中。移动项目或恢复工作时，一并保留这些记录。Live 读取当前运行，把任务与对应的产物和检查结果连接起来。

对接入监督执行的任务，连续无效的尝试会暂停相关任务，并记录下一步审阅或恢复动作，独立工作可以继续。经过审阅的新方案先进行恢复试运行。此前写入结果不确定时，先根据保存的回执核对目标当前状态。

具体流程见[从意图到交付](../canonical/skills/meta-theory/references/intent-to-delivery.md)、[架构说明](harness-architecture.md)和[任务试运行与恢复记录](verification/task-scoped-canary-20261111.md)。

## 可选 Memory 服务

持久化运行记录用于保持项目连续性。Memory 还可以跨会话保存、检索选定的信息。启用后，可检查实际配置的服务地址，例如：

```bash
curl -fsS --max-time 3 http://127.0.0.1:8000/api/health
```

健康接口用于查看服务是否可访问。任务需要写入、读取和召回时，再通过所配置的服务检查对应能力。`npm run meta:test:mcp` 检查 Meta_Kim 自己的 MCP 服务。

## 源码与生成文件

共用的 Agent、Skill 和运行资源维护在 `canonical/` 中，机器可读配置位于 `config/`。`.claude/`、`.codex/`、`.cursor/` 等客户端目录由 `npm run meta:sync` 在本地生成，由 `.gitignore` 管理并保留在本地，不提交到 GitHub 源码；发布包携带对应的共用源文件。

## 怎样查阅项目记录

| 你要确认什么 | 参考资料 |
| --- | --- |
| 安装器接受哪些参数 | [安装入口](../setup.mjs) · [CLI](../bin/meta-kim.mjs) |
| 哪些客户端提供了哪些接入 | [兼容性目录](../config/runtime-compatibility-catalog.json) |
| 设计和专业资料怎样进入执行任务 | [从意图到交付](../canonical/skills/meta-theory/references/intent-to-delivery.md) |
| 已发布版本有什么变化 | [更新日志](../CHANGELOG.zh-CN.md)及其中链接的记录 |
| 怎样维护源码 | [开发指南](../AGENTS.md) |
