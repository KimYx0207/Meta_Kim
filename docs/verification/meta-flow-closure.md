# Meta PRD、任务、阶段与卡片链路核验

核验日期：2026-11-14（Asia/Shanghai）。起点为 `09262c75174f475777cb35406d1fe1123a05da02`，包含本轮未提交修复。没有重新运行 DSH/ZCode；没有模型调用，也没有虚构用户批准。

## 8 与 11 的精确定义

| 来源 | 定义 | 本轮证据范围 |
| --- | --- | --- |
| `config/contracts/core-loop-contract.json` | Critical → Fetch → Thinking → Execution → Review → Meta-Review → Verification → Evolution，八阶段唯一执行主干 | 契约、检查点、依赖与恢复的自动回归；不等于原生宿主业务验收 |
| `config/contracts/workflow-contract.json` 的 `businessWorkflow.phases` | direction → planning → execution → review → meta_review → revision → verify → summary → feedback → evolve → mirror，十一项业务流程投影 | 独立的触发、跳过、阻断、等待理由；字段数量不是执行证据 |
| `scripts/run-meta-theory-governed-execution.mjs` | 默认 `planned_only`；明确执行入口仍受既有关口和 read-only bridge 限制 | 本轮公开 CLI 返回 `needs_thinking`，下一步 `Critical/produce_current_critical_understanding`，`executionAllowed:false` |
| `cardPlanPacket` | 卡片候选、触发规则与展示路由计划 | `adapter_required_not_triggered_by_artifact` 明确不证明原生弹窗、工具调用或用户回答 |

历史 `12-ten-step-workflow.test.mjs` 文件名是兼容别名，正文已有十一阶段说明。本轮发现 `e2e-eight-stage-live.test.mjs` 开头把静态场景/文本断言称为真实端到端执行，已改为 synthetic contract regression；删除仅断言本地硬编码数组长度为 8 的空洞覆盖测试。其余契约断言保留。

`planning-with-files` 按 AGENTS.md 已吸收并退役，现有第一方 `planning-continuity` 是唯一计划权威。`/workflows` 不是本轮可发现的独立安装入口；实际业务流程权威是上述 workflow contract、meta-theory 和现有 runner。不安装同名未知依赖。

## 修复的实际断点

修复前，模块审阅哈希只绑定 `module.taskIds`，同 ID 的任务范围、验证程序和依赖可变而保留原票；Thinking gate 只校验审阅及材料，完全无关或空的 worker 任务也可通过。新增两个风险测试先真实失败后修复。

修复使用已有 `taskSlices`、模块材料、worker packet 和 progress evidence：

- 校验任务身份、验收标准、验证程序、合法无环依赖及模块归属；跨模块任务依赖投影进现有模块图。
- 将任务及传递依赖合同纳入实际可分页审阅材料与哈希；外部源原文追加合同，并独立保存原源长度、哈希。相关消费者重新审阅，独立模块保留。
- Thinking gate 比对 proposed worker 的 `roleInstanceId`、完整任务覆盖、`dependsOn`、`acceptanceCriterionIds`，并要求当前完整 PRD 的哈希依据。检查点消费本次 record，而非上次状态的任务。
- 不为旧任务合同补造审批。无任务旧大纲/模块的兼容仍保留；已有任务的新可见合同需要真实重审。

## 实际 CLI 与真实仓库文件记录

重跑命令（输出目录必须不存在）：

```sh
node docs/verification/meta-flow-probe.mjs /absolute/new/evidence-directory
```

本轮执行目录：`/workspace/scratch/4bcd99e92beb/verification/meta-flow-current-source-195`。Runner 将本轮 `desktop-skill-package.mjs`、`desktop-skill-renderers.mjs`、`live-workspace-service.mjs` 实际字节复制到独立项目，记录原始路径、长度、SHA-256；没有用伪造源文件替代。

执行序列为公开 CLI publish → Live feedback API → CLI inspect/claim → 新 CLI 进程重读确认原 claim → 实际读取源文件并写 `outputs/source-review.json` → CLI receipt → 相同 receipt 幂等重放 → 新进程重读确认 `host_reported`。所有 CLI JSON、反馈、摘要和项目内原始回执材料均保留。反馈引用本次用户方向，但调用身份及 state 初始化明确是 synthetic fixture；未调用 accept，也未把它写成原生客户端批准。

另执行普通 governed runner CLI，保留 `governed-cli.json` 及完整 pending artifact：它正确停在当前宿主需提交真实 Critical 理解的位置；没有用编造 Critical/Thinking 输入绕过此关口。`modelSelection.application:not_invoked`，observed model 为 null。

| 环节 | 实际结果 |
| --- | --- |
| PRD 登记、反馈保存 | 实际服务与 CLI 执行；身份初始化为 synthetic fixture |
| 当前绑定身份领取、重启恢复 | 实际新进程读取同一 run/session；原 claim 不重复执行 |
| 产物与回执 | 实际源文件检查产物，哈希绑定；状态为 `host_reported` |
| 用户接受与完整八阶段业务闭环 | 未执行，最终仍 Thinking 等待真实审阅 |
| 任务依赖、阶段门禁、纠错与独立成果保留 | 自动回归通过；synthetic，不是原生业务验收 |
| 发卡 | 本轮核验契约及计划边界；无新原生弹窗或原生选择证据 |
| 模型、provider、native worker | 0 次调用；不改变任何原生验收标记 |

因此可证明本轮文件与回执的程序链路执行成功、两处任务授权断点已修复；不能声称所有八阶段或十一阶段均已在用户真实宿主中完成。没有为了得到绿色结论放宽默认执行权限。

## 回归命令

```sh
node --test tests/live/live-workspace.test.mjs tests/live/live-continuation-recovery.test.mjs tests/meta-theory/82-governed-host-checkpoint.test.mjs tests/meta-theory/83-governed-host-revision.test.mjs tests/meta-theory/11-eight-stage-spine.test.mjs tests/meta-theory/12-ten-step-workflow.test.mjs tests/meta-theory/14-card-deck-complete.test.mjs tests/meta-theory/e2e-eight-stage-live.test.mjs tests/governance/product-design-closure.test.mjs tests/governance/software-design.test.mjs
```

联合回归在最后一次 `null verification` 输入修复之前达到 **354/354 通过**（37 suites，约 48 秒），日志为 `/workspace/scratch/4bcd99e92beb/verification/meta-flow-regression-final.log`。任务去重校验后曾单独复跑 5/5 风险测试，日志为 `/workspace/scratch/4bcd99e92beb/verification/meta-flow-task-final.log`。

随后独立复审发现 `task.verification: [null]` 会抛裸 `TypeError`。新增测试先复现此失败，再增加对象类型检查：`null`、布尔值、数字、字符串条目均返回 `workspace_task_contract_invalid`、状态 `400`，并且不改变 workspace revision。此最后修复后的聚焦风险集 **6/6 通过**，日志为 `/workspace/scratch/4bcd99e92beb/verification/meta-flow-task-input-final.log`；未再次运行上述 354 项联合回归。因此 354 项结果属于修复前的联合检查，6 项结果属于最终输入修复后的针对性检查。两者均不称为 `meta:verify:all` 或 native 全验收。

旧版本迁移另用 `git show b3c1e05a40e726c4f0f4883132d16e58b6e7da8d` 的实际 publish/review 实现生成有任务的已采纳状态（`synthetic_ui_decision`），再由当前实现读取/重登记。结果见证据目录 `legacy-task-migration.json`：大纲与无关模块的 Decision 保留；任务模块的旧 hostAnswerClaim 历史保持不变，新合同仅补审受影响模块；未补审前展示明确下一步并阻断继续，相同新合同重登记稳定。
