# 元 Harness：模块推进与宿主交接

日期：2026-11-15。适用版本：Meta_Kim 3.16.0 / 3.16.1；专业方法来源继续使用 Kim_Service V1.19 的已锁定提交。

本次承接 3.15.1 之后的剩余工作。3.15.1 的已发布安装兼容性修复不是本次新增行为的验证证据。这里记录改动、反例、可复跑检查与边界；完整发布结果以同一提交对应的标准检查报告和 Release 附件为准。

## 用户可见的变化

1. **该问才问。** 从现有 Decision 的依赖和当前状态决定是否展示问题、选项或提醒。已明确的事项不重复询问；可以先查证的事实先查证；普通工作不固定插入暂停。仍保留真正影响方向、范围、权限或验收的选择。
2. **独立模块各自推进。** 大纲仍是共享入口，模块按真实任务依赖进入执行、审查和核验。A 等待审阅不阻塞无关 B；同一个共享任务只有一个执行身份。全部模块完成后仍需整体集成关口。
3. **原宿主接着做。** 只读取下一件已就绪的工作，再用现有 revision/CAS 领取和准确文件回执交回。父 Agent 保留本次工单、输入和子任务返回；不把完成回复误写成全部验收通过。
4. **恢复时看当前事实。** 旧阶段回执保留，但材料变化、决定撤回或 run 停止后，旧的通过记录不能放行新的执行。独立模块的有效产物仍可保留，复用时重新验证当前来源、范围和文件字节。
5. **页面跟着真实状态变化。** 分页外材料变更也会撤下旧的“可继续”，保留无关模块、已读材料和用户草稿。审阅过期显示重新登记提示；手动刷新沿原游标重读已加载页。

## 保留的核心

| 保留项 | 本次处理 |
| --- | --- |
| 九个治理角色、八阶段、两层 PRD | 保留；没有删除阶段、专业方法或最终集成验收 |
| Decision 与当前 spine | 沿用同一事实来源；界面和卡片只是投影 |
| 现有 DAG、durable kernel、lease/fence、effect 账本 | 增加可选模块范围，不新增调度服务或第二份运行数据库 |
| 当前宿主权限与可取消性 | 每次实际派工仍检查当前授权；暂停、停止和撤销不会被续做入口绕过 |
| 所有权、备份、回滚、项目能力保护 | 保留现有安装和受限写入机制 |
| 研究来源、比较方案、专业能力选择 | 保留，不凭模型名或客户端名推断能力 |
| 单客户端安装 | 保留；使用当前客户端真实能力，不要求另装 Codex 或 Claude Code |

领取租约仍用于标示待对账状态，不被改成用户授权的五分钟期限。结果不确定时不能自动重领并重复执行；原宿主可以按现有准确回执路径对账。实时授权和当前设计事实由各自原有边界判断。

## 生产接点

| 接点 | 实现及其作用 |
| --- | --- |
| 提问节奏 | `scripts/governed-execution/contextual-card-plan.mjs` 消费已有决策前沿；主入口不再要求固定第一张卡片 |
| 模块计划 | `stage-dag.mjs` 的可选 `moduleScopePlan` 绑定架构、模块、任务和真实依赖；无此输入继续旧图 |
| 阶段执行 | `module-stage-execution.mjs`、`advance-goal.mjs`、`stage-runner-bridge.mjs` 在同一内核维护独立进度及当前事实检查 |
| 当前事实 | `module-stage-fact-bindings.mjs` 读取已有 Critical/Fetch 记录、当前本地审阅和明确的 Evolution 决定，不重复发起模型判断 |
| 专业阶段 | `module-stage-host-bindings.mjs` 加载真实方法及完整验收合同，绑定实际宿主调用与准确结果文件 |
| 产物复用 | `module-artifact-reuse.mjs` 重新验证文件和当前范围，再生成新运行的验证证据；不拷贝旧通过检查点 |
| Live 交接 | `scripts/live-workspace-host.mjs --next-work` 返回新鲜领取参数；领取、汇报和重放沿用现有 service/CAS |
| 页面与守护进程 | `design.materialInvalidation` 是只读投影；新增共享 gate 也进入 Live daemon 字节身份，避免复用运行旧代码的进程 |

宿主显式绑定 `host_reported_files` 时，可使用真实宿主提供的范围内文件写入；写入前绑定准确路径、effect、回滚快照和当前授权。不确定副作用保留待对账，不能自动重复。默认命令行桥的只读范围保持原状。

## 实际反证与回归

独立审查先用真实 Live service、落盘状态、源文件及 durable kernel 复现，再把行为固化进正式测试。不是只对比字段名称或作者自报的 `pass`。

| 反例或保证 | 对应检查 |
| --- | --- |
| 重新采纳模块后，整体继续请求不能沿用已 superseded 的旧 nonce | `tests/live/live-workspace.test.mjs` |
| 一个候选来源丢失，不拖停另一独立候选 | 同上 |
| 共享任务只要求目标任务的共同所有者与真实依赖，不带入其无关任务 | 同上；`105-module-stage-pipeline.test.mjs` |
| 真实反馈或来源变化后，同 kernel 恢复不能沿用旧 Thinking 放行 | `107-module-current-facts-resume.test.mjs`，覆盖两个生产入口 |
| 共享大纲变化和实际停止阻断相关调用，独立模块变化只影响依赖闭包 | 同上 |
| 任务切片 ID 映射到真实 worker packet；未知或不明确的映射拒绝 | `105-module-stage-pipeline.test.mjs` |
| 跨运行复用验证当前字节和当前范围；旧、自评或受影响证据不直接通过 | `106-module-artifact-reuse.test.mjs` |
| 当前事实只证明已有记录，不代替 Review、Verification 或用户采纳 | `module-stage-fact-bindings.test.mjs` |
| 实际方法载入、exact run/node/attempt/fence/path/hash、来源变化和撤销授权 | `tests/governance/module-stage-host-bindings.test.mjs` |
| 范围内写入、回滚、重复和不确定 effect | `tests/governance/host-scoped-local-write.test.mjs` |
| 父宿主下一件工作、当前会话/项目/profile 绑定及无副作用读取 | `tests/live/native-host-continuation.test.mjs` |
| 33 模块真实服务：页外失效、独立模块保留、手动刷新恢复与草稿保留 | `tests/live/live-workspace-presentation.test.mjs` |
| 已决定事项不重复问；有依赖的问题先查证；暂停不改变执行权限 | `contextual-card-plan.test.mjs` 与既有 34/48 测试 |
| 新增模块实际装入包，Live 导入闭包与进程字节身份完整 | `tests/live/live-package-closure.test.mjs` |

测试路径省略的前缀均为 `tests/meta-theory/`。新增测试由既有目录/glob runner 发现，`project-inventory --check-tests` 检查接线；没有另开一套验收入口。

最后清理只移除了确认无引用的一处测试命名导入，以及主入口内三个未导出的旧私有函数：`joinNoticeSentence`、`renderReportList`、`truthyEnvFlag`。被其他测试使用的 helper、公开导出、配置文件、规则和专业能力全部保留。

## 如何复查

使用仓库现有入口。变更了 canonical 文件时先同步投影，再运行相应检查：

```bash
npm run meta:sync
npm run meta:test:live:coverage
node --test tests/meta-theory/105-module-stage-pipeline.test.mjs tests/meta-theory/106-module-artifact-reuse.test.mjs tests/meta-theory/107-module-current-facts-resume.test.mjs
node --test tests/governance/module-stage-host-bindings.test.mjs tests/governance/host-scoped-local-write.test.mjs
npm run meta:verify:all
```

本次发布检查在隔离配置目录中运行，使用现有标准完整门禁、Graphify 真实本地 AST 生产器与明确标记的版本查询安装夹具。版本夹具只接受 `--version`，不能调用模型。精确源码提交、检查结果和打包摘要由对应的实际报告记录；不把前一个版本的报告用于此版。

## 各宿主交互与研究依据

完整映射集中在 [原生宿主交接](../../canonical/skills/meta-theory/references/native-host-interaction.md)。安装投影、当前工具可用、真实调用、独立验证和业务结果分别记录。Claude、Codex、Cursor、Gemini、ZCode、DSH、OpenClaw 均按当前真实 schema 和权限选择方法；子 Agent 不能嵌套调用时，把所需工单返回父级继续安排。

截至本次查证，方案沿用现有运行内核，避免引入与当前事实来源重叠的另一套框架。以下为已查阅的一手参考；本表说明设计依据，不代表这些客户端全部完成原生实测：

- [LangGraph Pregel 执行模型](https://docs.langchain.com/oss/python/langgraph/pregel)：批次中的执行屏障并不天然解决模块独立推进。
- [LangGraph checkpoints](https://docs.langchain.com/oss/python/langgraph/checkpointers)：保留已成功节点结果与失败恢复的边界。
- [Temporal child workflows](https://docs.temporal.io/child-workflows)：按实际隔离需求决定是否拆分运行单元。
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)、[Cursor subagents](https://cursor.com/docs/subagents)、[Gemini CLI subagents](https://geminicli.com/docs/core/subagents/)、[ZCode subagents](https://zcode.z.ai/en/docs/subagents)：分别核对实际调用、返回、恢复和嵌套限制。
- [DeepSeek Harness subagent 实现说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/tool-subagent/README.md)：区分本地与外部后端的返回和交互能力。

## 3.16.1 发布补正

3.16.0 的正式 CI 包没有收录本说明，因为该文件尚未进入 Git 的公开文档白名单。本地验收包与正式包的 791 个共同文件逐字节一致，差异只有本说明。3.16.1 将本说明纳入已提交源码，同时更新版本资料；包内每个文件与 Git tree 分别核对。原 3.16.0 tag、CI 包和本地报告保留，3.16.1 使用自己的完整报告与精确发行包审计。

## 已知验证边界

- 没有新增 Claude Code 与 Codex 双客户端原生模型认证要求；本次也没有消费个人模型令牌来制造认证证据。
- 七类宿主的工具合同与交接机制有针对性检查，不等于在七个原生客户端逐一完成真实商业任务。实际宿主 adapter 必须由当前运行环境提供。
- 浏览器自动化脚本已补充相应流程，但本执行环境的 Chromium 受 socket 限制，真实浏览器回看为 `not_run`。真实 service、生产 controller/renderer 与现有 DOM 替身的检查分别保留，不冒充浏览器实测。
- 普通模块完成只表示其范围完成；缺少独立审查、整体集成、当前业务效果或用户采纳证据时，仍保持相应未验收状态。
- 已停止的客户端不能被 MCP 连接、Hook 文本或结束的助手回复自动唤醒；没有新增后台模型、心跳或第三方调度器。
