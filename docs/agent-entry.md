# Meta_Kim Agent 工作台 / Agent workspace

这个入口属于 **Meta_Kim**，不是新的产品或另一套 Agent 调度器。它复用原 Live 工作台；Kim_Service 仍是可选的专业能力来源。没有复制 KimStudio 或 CC Switch 的第三方代码。

## 打开 / Open

在已安装 Meta_Kim 的项目目录中运行：

```powershell
meta-kim agent
```

从源码运行：

```powershell
npm run meta:agent
```

也可以明确指定项目目录：

```powershell
meta-kim agent --project-root "D:\kimproject\your-project"
```

项目目录必须已经包含 `.git` 或 `.meta-kim` 标记。应用只绑定这个明确的本地目录，浏览器不能任意更换 Agent 执行位置。安装了 Chrome/Edge 等受支持浏览器时优先以独立应用窗口打开；否则会给出回环地址。`--no-open` 可以只启动服务。关闭启动它的终端会关闭本地入口和它持有的 Agent 请求。

## 普通用户看到什么 / What a first-time user sees

1. 在“说出你想做的事”输入结果目标。无需先理解 Skill、MCP 或 PRD。
2. 软件显示服务端绑定的**真实本地项目**，检测本机客户端，并区分“检测到”“具备已审阅安全启动协议”“当前不允许执行”。页面里切换的其他项目记录不会偷偷改变 Agent 任务的执行目录。
3. 用户选择“自动选择可用客户端（只读研究）”或明确指定已审阅的客户端，再点“生成方案”。当前自动模式仅在检测到通过安全约束的 Claude Code 时才允许发起只读请求；不会回退到 Codex 个人 Token。Gemini CLI 的非交互 plan 模式有自动退出计划并进入执行的风险，故本入口禁止启动它。
4. 完成时可展开原生只读研究建议；采纳前需要亲自填写**选择的方案名称和取舍理由**，也可要求修改或放弃。采纳绑定当前方案哈希，仅代表“用于后续设计”，**不授权实际执行**。
5. 采纳方案后可生成**只读两层 PRD 草稿**（系统设计与模块输入／输出／依赖／验收），逐项人工编辑、保存设计版本、先批准系统再按依赖批准模块，最后生成绑定摘要的静态交接回执。该回执还**不创建正式 Run**、不允许写入。
6. 研究请求、人工决策、生成草稿及设计版本保存到项目自己的 `.meta-kim/state/default/agent-workflow/`。重开应用可读取确切记录；如果进程中断导致原生结果无法证实，显示 `in_doubt` 并阻止同一请求未经核对再次发起。
7. 右侧可以切换**执行流程、知识图谱、Agent 协作**。执行流程显示目标到验收的六个关口；知识图谱可以切换系统模块、方案依据与客户端关系，点击节点后在左侧唯一输入框提出修改意见。正式 Run 与研究设计阶段各自使用真实回执，不会被页面动画混为一谈。
8. 左侧能力侧栏展示九个 Meta Agent 的独立角色图形标识、已观测的 Subagent，以及 Skills、MCP、Hooks、Plugins、Commands 等清单；顶部快捷入口可直接展开这些类别。已明确绑定且通过组件哈希校验的 Kim_Service **专业 Agent 方法合同**另列一组，未配置时显示来源缺口，不从任意兄弟目录猜测。注册目录和专业来源均不代表已安装原生 Agent、已调用或得出结论；每个实际工作者的回报、证据等级与调用记录只读取当前 Run。桌面侧栏常驻，手机通过菜单打开。
9. 原生宿主清单另外按客户端展示已探测的程序及其项目／用户配置中的 **Subagent、Skill、MCP、Hook、Plugin、Command**。有配置、检测到 CLI、已加载、实际调用、产生已审阅结论是不同证据层级。清单只读，重新检测不会代替安装、登录或启动。扫描的始终是**运行 Meta_Kim 服务的那台机器**；云端服务不会凭空读到另一台 Windows 电脑上的配置。

## 当前边界 / Current limitations

- **现阶段只审阅了 Claude Code（2.1.259 及以上）的受限只读 plan 模式**，并使用白名单参数和受限环境。即使 CLI 被检测到，也必须额外通过版本及安全审阅。**Gemini CLI 仅检测，不启动**：其非交互 plan 模式可能自动批准退出计划并切换到有副作用的执行模式，不能当作人工授权前的只读隔离。
- Codex、ZCode、DSH、OpenCode、OpenClaw 显示检测状态，但尚未完成当前项目安全启动协议的验证，不开放启动。特别是不会自动使用用户个人 Codex Token。
- Pi 等宿主可在兼容目录中显示配置发现与接入候选，但当前不具备经过审阅的 Meta 原生启动／子代理结果读取器。Pi 的 MCP 和 Subagent 扩展能力不能自动推导为 Meta_Kim 已经调用成功。
- 本次原生配置目录只读取通过约束的公开名称、类别和来源范围，不将私有配置内容、绝对路径、模型参数或认证信息发送到浏览器。参考了 [Magpie 的能力库](https://github.com/yetone/magpie)、[CC Switch 的跨客户端配置和会话管理](https://github.com/farion1231/cc-switch) 以及 [Pi 的扩展机制](https://github.com/earendil-works/pi)；这些第三方功能并未被宣称为 Meta_Kim 已接通的运行时。
- 如项目中安装了可验证的 Kim_Service，Meta 通过已有的来源哈希与方法契约选择专业能力，传递给只读研究阶段；没有验证通过时不冒充专业调用成功。
- 一次原生 CLI **接单**并不意味着 Meta 已建立一个治理 `runId`；研究阶段结束也不代表完整目标已经实现、验收通过。只有既有原生事件与 Meta 记录提供确切绑定，Live 才展示对应任务图与“完成”证据。
- 已保存的 Agent **研究/决策回执**可以跨进程恢复，但目前不会自动创建或续接正式治理 `runId`，也不具备已授权原生写入的执行闭环。若服务器崩溃时原生客户端状态不确定，会保留核对关口，不据此自动重试。
- B 路径的两层 PRD **设计态**编辑及审批可以在本入口操作；其后的正式治理 Run 绑定、真实宿主执行、执行节点返工、B3 风险授权、B4 成果验收仍须逐项按 [`agent-desktop-b-prd.md`](./agent-desktop-b-prd.md) 验收，**不可把静态交接回执标为执行完成**。
- 这是 Meta 的本地应用入口，不是已签名的 Windows/macOS 安装包。

保持原命令 `meta-kim live` 的全局 Hub 只读。Agent 启动路由仅在明确运行 `meta-kim agent` 时注册，限定 `127.0.0.1`、一次性会话令牌、Same-Origin 与固定项目目录。用户输入不被拼接成 Shell 命令，也不会展示原始 CLI 错误输出或用户认证信息。

---

**English summary:** Run `meta-kim agent` from a marker-backed project folder. This is an opt-in, loopback-only view of the existing Meta Live workspace, not a new repository or scheduler. The reviewed read-only host route is Claude Code only; Gemini non-interactive plan mode is detection-only because it can exit plan mode without human approval. Optional hash-verified Kim_Service methods can inform research and a generated editable two-level PRD. Human B1/B2 approvals create persisted decisions and static handoff evidence, never code execution authority. Other hosts remain detection-only. Actual execution, scoped side-effect consent, and B4 acceptance require separately verified formal Run stages. `meta-kim live` retains its existing read-only behavior.
