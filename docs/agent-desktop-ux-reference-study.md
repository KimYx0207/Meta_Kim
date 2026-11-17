# Live Agent Desktop · 交互参考与验收依据

调研日期：2026-11-17。参考对象均为产品自身的公开文档或源码，不按项目 Star 数排序；吸收的是可验证的用户行为，不复制页面外观。本文是 Live 工作台的交互决策记录，并非所有参考功能均已实现的声明。

## 用户要解决的四件事

1. **找得到**：不要求用户知道 Agent、Subagent、Skill、Hook、MCP 的配置文件存放在哪，先按任务、宿主、类别和关键词找到。
2. **看得懂**：把「已发现配置」「客户端可用」「实际执行」「已获得结论」「已通过验收」明确区分。没有真实运行回执就不显示编造的成功结论。
3. **点得动**：搜索结果和每个能力记录都应直达相应关系、状态或可执行操作；普通用户不必进第二个没有意义的中转页面。
4. **改得回**：人能在任一关键决策点看到依据、反对或退回，再继续受控执行；已有配置和运行证据可追溯。

## 跨项目参考矩阵

| 一手项目及源码/文档 | 已核对的可取之处 | 对 Meta_Kim Live 的处理 | 实施边界 |
| --- | --- | --- | --- |
| [CC Switch](https://github.com/farion1231/cc-switch) | 多编码客户端统一入口；原配置导入、MCP/Skills 检索和分发；宿主能力各异 | 宿主与能力按真实扫描分组，搜索统一入口 | 不把配置存在说成运行调用；不动凭据或切换提供商 |
| [Magpie Library](https://usemagpie.ai/docs/library) | Instructions、MCP、Skills、Hooks、Subagents 跨宿主清单，按宿主本机格式管理 | 搜索贯通能力类别；保留宿主原生归属与状态 | 写配置需明确归属和事务备份，浏览目录默认只读 |
| [Pi](https://github.com/earendil-works/pi) | 可扩展 Agent 生命周期、工具和事件；可按宿主实际插件能力扩展 | 继续把 Pi 作为可探测宿主，能力不能只凭静态模板推定 | 未接入不展示成可运行 |
| [OpenCode](https://github.com/anomalyco/opencode) | 主 Agent/Subagent 分类、权限边界和会话导航 | 区分治理角色、Run 内子任务、宿主自定义子 Agent | 不把九个治理角色当作总 Agent 数 |
| [opencode-web](https://github.com/jdormit/opencode-web) | 移动端按项目找会话，当前消息内处理审批、展示子任务与工具回执 | 核心结果先展示、搜索与一跳查看能力；移动端布局作为验收场景 | 不在未经测试的设备上宣称适配成功 |
| [Cline](https://docs.cline.bot/core-workflows/task-management) | 会话历史、文件更改检查点和可恢复任务 | 把 Run 身份与回执作为任务追踪主线 | 暂不声称支持任意执行节点重放 |
| [Continue](https://docs.continue.dev/ide-extensions/agent/plan-mode) | 只读规划与执行的权限差别，内联上下文 | 关系查看保持只读，执行经已有受控接口 | 不替换当前授权门禁 |
| [Flowise AgentFlow](https://docs.flowiseai.com/using-flowise/agentflowv2) | 节点/连线可视化、多智能体与逐步数据流 | Host→能力、阶段→产物保留独立图层；节点一键定位 | 图上的节点不等于执行证据 |
| [Langflow](https://github.com/langflow-ai/langflow) | 可视搭建和 Playground 局部交互测试 | 分层浏览与细节检查可以独立于全量 Run | 可视画布只消费真实记录 |
| [n8n](https://docs.n8n.io/workflows/executions/) | 每次执行的节点数据、失败重试和定位错误节点 | Run 必须提供节点状态、可追溯结论、失败证据 | 实际重试需要执行接口和权限，不做假的前端重试 |
| [Dify](https://github.com/langgenius/dify-docs/blob/main/en/self-host/use-dify/monitor/logs.mdx) | 单节点输入/输出、执行日志和追踪 | Agent 详情区明确主张结论、观察依据与验收状态 | 「负责人回报」不自动升级为独立核验 |
| [LangGraph](https://docs.langchain.com/oss/python/langgraph/interrupts) | 在运行中暂停并向人收集结构化审批决定 | 人的采用/修改/退回在当前输入框完成 | 审批后恢复只在有持久化执行链时才可用 |
| [OpenHands](https://docs.openhands.dev/openhands/usage/architecture) | 对话、终端、浏览器、文件动作的事件统一呈现 | 任务、过程、产物可回查；来源标识不可缺 | 不把 UI 中记录视为原生命令执行 |
| [Langfuse](https://langfuse.com/docs/observability/get-started) | Trace 下的子调用、时间与观察记录 | 一条 Run 中的主/子 Agent 和能力调用可关联 | 缺原生 trace 时保持「未观测」 |
| [MCP Inspector](https://github.com/modelcontextprotocol/inspector) | 按工具、资源和提示词检查服务器能力；能分离连接和实际工具调用 | MCP 目录与实际调用证据分开呈现，能力可逐条定位 | 只读索引不自动发起 MCP 工具调用 |
| [AutoGen Studio](https://microsoft.github.io/autogen/stable/user-guide/autogenstudio-user-guide/index.html) | Agent、Team、Workflow 的可视组织 | 从角色清单延伸为按 Run 的多 Agent 协作视图 | 不把目录注册当作运行中的 Team |

参考时刻只证明这些产品/文档展示过相应交互方式；各项目的宿主兼容性、配置格式、API 和支持范围会更新，应在真正执行接入时重新核对对应版本。

## 本轮吸收并实现

| 用户动作 | 原先的摩擦 | 当前实现及对应测试 |
| --- | --- | --- |
| 在侧边栏找某个子 Agent/Skill/MCP/Hook/宿主 | 数百条记录只能滚动，重要记录被淹没 | 统一搜索，不相关分类隐藏，匹配类别自动展开；`live-agent-desktop-interaction.test.mjs` |
| 展开一个有几十个 Hook 的宿主 | 每条都重复显示长状态说明，侧边栏失去重点 | 宿主按能力类别二级折叠，默认收起；状态由行的说明提示提供 |
| 查看一个宿主的能力关系 | 必须先去中间图，再找宿主 | 宿主中有「查看能力关系」，直达 Live Host 关系层 |
| 搜索到排列靠后的具体能力 | 图谱默认节点数上限会隐藏它 | 单击能力直接聚焦精确配置节点，提供返回完整图谱入口；覆盖 40+ 节点测试 |
| 看一个能力究竟来自哪里 | 名称能看到，但宿主、配置范围和可信状态不清楚 | 节点检查区显示宿主、能力类别、配置范围、来源，以及未核实加载/调用的提示 |
| 判断 Agent 是否真的完成 | 注册角色容易被误读为执行成功 | 已有 Run 证据门槛保留，目录、检测、回报、原生返回及验收分级 |

## 未实现的产品能力与不能省略的验收

- 目前云端服务的宿主检测不能证明用户 Windows 机器装载情况。跨机器桥接和原生客户端重载应在真实 Windows 环境独立验收。
- 真实失败节点的重试、任意历史节点改写并恢复执行，必须先有后端可追溯的检查点和授权接口。仅增加按钮会误导用户。
- 多宿主配置写入应借鉴原子修改与备份，但不能照搬 CC Switch 对提供商凭据的管理，Meta_Kim 的配置所有权独立。
- 视觉验收必须分别提供**本轮真实渲染**的桌面、窄屏、搜索结果、运行结论、能力图谱截图；历史截图不能充当修改后的截图。
- 对陌生人做任务测试：不用教名词，能否在 30 秒内找到一个 Skill、区分真实执行结果、返回原任务；缺少实际观察数据时不写通过。

## 后续的产品取舍原则

右侧（或主画布）优先回答「现在发生了什么、结论是什么、是否需要我决定」；侧边栏只承载定位和必要状态。真实调用、配置读取、授权、重试都由底层运行接口决定；Live 只使用一份状态，不再造第二套看似成功的假数据。优先消除点击层级、重复文案、全屏滚动和来源歧义，再处理纯装饰性动画。
