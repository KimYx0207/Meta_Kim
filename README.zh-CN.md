<div align="center">

# 元 · Meta_Kim

**把目标告诉 AI，让方案、执行和下一步始终接得上。**

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

</div>

## 让一个想法，变成看得见、用得上的成果

**Meta_Kim 帮你的 AI 助手把“这里需要改进”，一步步做成可以检查、使用和继续优化的结果。** 你仍然使用熟悉的 AI 客户端。它负责帮助 AI 理清目标、选择方案、组织任务、找到合适的专业能力，并核对实际交付了什么。

一个项目通常不止一句提示词：前面的设计会影响后面的实现，一项任务可能要等另一项任务的结果，换个对话还得知道哪些已经做完。Meta_Kim 把这些关系留在项目里，让后续工作有依据，也让你知道现在做到哪里、接下来为什么这样做。

![Meta_Kim Live 的任务关系图与演示工作流进度](docs/images/meta-kim-live-task.zh-CN.png)

*真实 Live 界面，展示产品内置的工作流演示。图中能看到任务关系与状态，点开任务可以查看记录。*

## 从一句需求，到下一次迭代

假设你的网站已经有注册表单，功能能用，但手机上填起来很挤，输错时也不容易发现。你希望改善体验，同时保留原有数据字段。

**先用自己的话说清想得到什么结果。** AI 会先查看现有流程，找出必须保留的部分：提交给服务器的数据、必填字段、产品原有风格。需要时，它会查相关资料、比较可选方案，再决定怎么改。它向你确认的问题应当能影响实际选择，例如表单是否必须保持在一屏内。

**接着把方案落到互相衔接的任务。** 从整个项目看，要说明页面、校验和服务端接口怎样配合；从具体模块看，要明确手机布局、错误提示分别改什么，以及用什么检查证明数据仍然正确提交。每项任务都有范围、输入、预期产物和完成标准。相互独立的工作可以一起推进，依赖接口决策的工作则等决策明确后再做。

**交付时，你能亲自试一遍。** 这个例子可以要求交付修改后的源码、启动方式和检查结果。在手机尺寸下试着漏填、填错，再正常注册，核对是否达到了约定标准。如果布局变好了，但错误提示还出现在不合适的位置，下一项任务就针对这个问题修正。

**换个对话，也能接着同一件事继续。** 你可以说：“保留现在的布局，把注册成功的提示再说清楚一点。” 已记录的决定、完成的任务和产物会成为起点，AI 先与当前项目核对，再继续下一步。

![从目标、研究和方案，到任务协作、验收与下一轮改进](docs/images/intent-to-delivery.zh-CN.svg)

小修正可以简洁处理，跨多个模块的功能再展开规划。任务有多复杂、影响有多大，就做相应程度的准备。

## 它怎样让复杂工作持续做下去

![用户、AI 客户端、Meta_Kim、专业能力和项目记录之间的关系](docs/images/meta-kim-overview.zh-CN.svg)

### 先把结果说清，后面的选择才有依据

一句需求里经常同时包含问题、一个设想中的解法，以及对项目的假设。Meta_Kim 帮助 AI 把它们理清：你要达到什么目的，哪些东西必须保留，做到什么程度算完成。当资料或参考案例会影响重要选择时，再把它们找来比较。这样，方案有理由，你也能在大量工作开始前判断方向是否合适。

### 一份设计，同时看清整体和具体模块

对于软件工作，同一份设计有两个视角：**架构视角**说明整体结构、接口和约束，**模块视角**把它展开成职责明确、能验收的具体任务。每一块工作都能对应到整体目标，避免各自做完以后才发现接不上。某个设计决定变化时，可以找到受影响的任务，保留仍然有效的成果。

### 按依赖推进，让能做的工作继续做

任务之间会记录“需要什么输入、产出给谁”。客户端具备相应工具时，相互独立的任务可以并行；共享前置条件或文件的工作则需要协调顺序。某一条分支需要你做决定时，其他已经具备条件的任务仍可推进。计划因此会持续参与执行，而不只是开头列一次清单。

### 每项任务带着合适的方法和资料开工

Meta_Kim 从客户端现有能力，以及明确接入的 Kim Service 等能力库中选择本轮需要的方法。发给执行者的任务可以带上专业方法、相关参考或可编辑示例，同时说明输入、产物和检查方式。资料按当前任务需要加载，让执行者拿到足够有用的上下文，也减少无关材料的干扰。

### 用项目记录，找准中断后的继续点

计划、发现、进度和执行回执，把“原本要做什么”与“实际做到了什么”连接起来。后续对话可以读取这些记录，再与当前文件核对，确定下一步。如果上一次操作是否成功还不明确，会先核实结果再决定是否重做。对话或某项任务中断后，已经有效完成的工作仍然能接着用。

### 通过检查，找到具体该改的地方

完成一项任务，需要产物达到约定标准，并有相应检查支持这个结论。当同一种做法反复无效、尝试的依据又没有变化时，相关任务需要重新审视方法、假设或关键决定，再继续推进。经过确认的有用发现还可以带入下一轮改进。你能看清交付了什么、为什么算完成，以及哪里仍待处理。

<a id="installation"></a>

## 在自己的项目里开始

先准备 **Node.js 22.13.0+**、Git，以及已经配置好模型连接的 AI 客户端。当前版本：**[v3.10.2](https://github.com/KimYx0207/Meta_Kim/releases/tag/v3.10.2)**。

### 1. 安装 Meta_Kim

```bash
git clone https://github.com/KimYx0207/Meta_Kim.git
cd Meta_Kim
npm install
node setup.mjs
```

按提示选择客户端和安装范围。**全局安装**让当前账号下的多个项目复用能力；**项目安装**会请你选择一个具体项目目录。保留 Meta_Kim 仓库，之后可用它更新。实际工作的项目可以放在另一个目录。

例如，只给某个项目安装 Codex 支持：

```bash
node setup.mjs --targets codex --scope project --project-dir "/path/to/your-project"
```

把引号中的路径换成项目的绝对路径。需要账号级安装时，改用 `--scope global` 并去掉 `--project-dir`；同时使用多个客户端，可以写成 `--targets codex,claude`。

也可以不保留源码副本，直接用 `npx --yes github:KimYx0207/Meta_Kim` 安装，以后用 `npx --yes github:KimYx0207/Meta_Kim update` 更新。这个入口接受相同的安装参数；下文以 `node bin/meta-kim.mjs` 开头的 CLI 命令，也可以换成这个 `npx` 前缀执行。

### 2. 打开项目，直接描述想要的结果

在刚才配置的客户端中打开实际工作的项目，像平时聊天一样提出需求：

> “帮我检查这个项目的注册流程，让手机上填写更顺手，保留现在的数据字段，改好后把流程和检查结果给我看。”

提供现有项目和重要约束，确认它提出的关键选择，再让它按方案推进。你随时可以问：现在改什么、为什么这样改、准备怎样检查。无需先记住某个启动口令。

### 3. 打开 Live，查看具体任务

在 Meta_Kim 仓库目录运行：

```bash
node bin/meta-kim.mjs live --project-root "/path/to/your-project"
```

打开命令打印的本地地址。Live 读取指定项目已保存的任务与执行记录。如果还没有项目记录，可以在地址后加上 `?demo=states`，先看本页截图中的内置演示。

**先看本页顶部的任务图**，沿连线了解前后依赖和正在推进的工作。**再点一个任务节点**，在详情面板选择 **证据**，查看已经记录的产物和检查结果。

![在 Meta_Kim Live 中选中任务后查看详情与证据](docs/images/meta-kim-live-detail.zh-CN.png)

*内置演示中，选中任务并打开证据页签后的真实界面。通过这些记录，可以理解任务为什么处于当前状态。*

顶部语言选择器支持中文、英文、日文和韩文，会记住你的界面语言；自己输入的任务原文保持不变。新的要求和反馈仍发给 AI 客户端，用 Live 跟进和查看已有记录。

<a id="clients"></a>

## 用你已经熟悉的客户端

交互安装器支持以下六个目标名称。安装时选择对应客户端，或在 `--targets` 后填写名称即可。

| 客户端 | 目标名称 | 安装内容 |
| --- | --- | --- |
| Claude Code | `claude` | Agent、Skill、命令和 Hook |
| Codex | `codex` | Agent、共用 Skill、配置和 Hook |
| Cursor | `cursor` | Agent、Skill、项目规则和 Hook |
| OpenClaw | `openclaw` | Agent 工作区、Skill 和配置模板 |
| Gemini CLI | `gemini` | Agent、共用 Skill、设置和 Hook |
| ZCode | `zcode` | Agent、Skill、MCP 配置及可选的用户级 Hook |

安装后，在工作项目中重新打开客户端，让它加载配置。工具访问和模型权限仍由客户端管理。需要启用 Meta_Kim 的全局 Hook 时，在安装命令中加上 `--with-global-hooks`；ZCode 从用户级配置读取 Hook。

**OpenClaw 还需要接上配置模板。** 安装会生成各 Agent 工作区和 `openclaw.template.json`：全局安装默认放在 `~/.openclaw/`，项目安装放在项目内的 `openclaw/`。把模板中的 `agents.list`、`skills.load.extraDirs` 合并进现有 OpenClaw 配置，保留原有 Agent、目录和设置。重启网关后，选择 `meta-warden` 作为入口 Agent。

**Qoder、Trae** 的 Beta 适配资源随包提供，需要明确配置后才启用，不是新增的 `--targets` 安装目标。DeepSeek Harness 使用下面的独立安装方式。依赖项目自己的客户端支持由上游维护。

## 需要专业方法时，接上 Kim Service

Meta_Kim 负责组织工作，**Kim Service 提供可复用的专业方法和材料**，用于设计、分析、内容交付等具体任务。接入之后，Meta_Kim 选择任务执行方法时，就能把这些能力纳入考虑；实际工作仍通过当前客户端已有的工具执行。

如果安装器已经登记了受管理的 Service 源码，且安装记录校验通过，Meta_Kim 可以直接使用这份登记。自己下载的副本则按下面的步骤明确绑定目录。

先把 Kim Service 下载到本地：

```bash
git clone https://github.com/KimYx0207/Kim_Service.git
```

在**实际工作的项目根目录**中创建 `.meta-kim/local.overrides.json`，写入 Kim Service 仓库的绝对路径：

```json
{
  "dependencyRoots": {
    "kim-service": "/absolute/path/to/Kim_Service"
  }
}
```

如果文件已经存在，只把 `kim-service` 合并进已有的 `dependencyRoots`，保留其他配置。这里指 AI 客户端当前打开的工作项目根目录，不是 Meta_Kim 安装器所在目录。Windows 路径可以使用正斜杠，例如 `C:/Projects/Kim_Service`。

如果用环境变量统一管理，也可在启动 AI 客户端的环境中设置 `META_KIM_KIM_SERVICE_ROOT`；它的优先级高于本地文件。仅把两个仓库放在同一父目录下，不会自动建立连接。配置好后，可以让 AI 检查可用的 Kim Service 能力，再为当前任务选择相关方法。

<a id="dsh"></a>

## DeepSeek Harness 接入

DSH 使用独立的 Beta 接入方式，通过原生 profile、Skill 和 MCP 配置工作。准备好 **DSH 0.2.2-rc.1** 和 **Node.js 24.9.0+** 后，在 Meta_Kim 仓库目录运行：

```bash
node bin/meta-kim.mjs dsh install
node bin/meta-kim.mjs dsh check
dsh --profile meta-kim
```

只配置一个项目时，在安装命令后加 `--scope project --project-root "/path/to/your-project"`，然后使用安装器打印的启动命令。检查时也指定同一个项目：

```bash
node bin/meta-kim.mjs dsh check --scope project --project-root "/path/to/your-project"
```

需要一并安装 Kim Service 的原生 DSH Skill，可以从 [Kim Service 发布页](https://github.com/KimYx0207/Kim_Service/releases/latest)下载并解压 DSH 包，安装或更新时加 `--service-package "/path/to/unpacked-service-package"`。

后续用 `node bin/meta-kim.mjs dsh update` 更新这套接入。更新会保留已有的 Service 投影；需要同时更新这些 Skill 时，再传入新版解压目录。卸载使用 `node bin/meta-kim.mjs dsh uninstall`。项目级更新或卸载时，带上安装时使用的同一组 `--scope project --project-root` 参数。

<a id="continue-work"></a>

## 继续任务、提出改进和更新安装

对话中断后，重新打开**同一个工作项目**，先让 AI 读取已经保存的计划、发现、进度和执行记录。例如：

> “继续注册流程的改进。先把已记录的决定和完成的工作与当前项目核对，确认中断操作的实际结果，再从下一项未完成任务接着做。”

继续迭代时，说清哪些保留、哪些改变，例如：“保留手机布局和现有字段，改进注册成功提示。” 这样，新的工作就能接着已认可的成果开展。可选的 Memory 服务可以帮助跨会话保存选定信息；当前任务的续接，本身已有项目记录作为依据。

源码安装的更新方式，在 Meta_Kim 仓库目录执行：

```bash
git pull --ff-only
node setup.mjs --update
node setup.mjs --check
```

安装或客户端加载出现问题时，可以运行 `node bin/meta-kim.mjs doctor` 检查配置并查看下一步建议。更新时保留工作项目的记录，后续对话才能继续使用。

## 源码与生成文件

共用的 Agent、Skill 和运行资源维护在 `canonical/` 中，机器可读配置位于 `config/`。`.claude/`、`.codex/`、`.cursor/` 等客户端目录由 `npm run meta:sync` 在本地生成，由 `.gitignore` 管理并保留在本地，不提交到 GitHub 源码；发布包携带对应的共用源文件。

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
