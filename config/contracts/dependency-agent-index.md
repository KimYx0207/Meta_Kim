# 外部专业角色索引契约：Kim Service

专业角色源码放在 Kim Service 的 `agents/<id>/`。Meta_Kim 从其生成索引读取候选，再根据角色合同选择；Kim Service 不承载总路由，Meta_Kim 也不把这些角色投影为九个治理 Agent 之外的持久身份。

人话目录在 Kim Service 的 `agents/README.md`，覆盖自媒体、电商、求职职场、教育、副业创业，每类三个角色。第三方包及其既有参考地位保持独立。

## 绑定一个本地包

依赖声明在 `config/capability-index/dependency-project-registry.json` 的 `kim-service` 条目。读取顺序为：

1. 显式环境变量 `META_KIM_KIM_SERVICE_ROOT`。
2. 项目本地 `.meta-kim/local.overrides.json` 中的 `dependencyRoots["kim-service"]`。
3. 依赖声明的 `source.localPath`；发布源码默认是 `null`。

路径可为绝对路径，也可相对当前 Meta_Kim 项目根。比如两个仓库由维护者明确放在同一父目录时，可在保留原配置字段的前提下加：

```json
{
  "dependencyRoots": {
    "kim-service": "../Kim_Service"
  }
}
```

没有显式绑定时返回 `not_configured`，不会扫描任意兄弟目录、下载或安装软件。显式路径失效时返回 `missing`，不会悄悄改用另一份副本。本机路径只进入本地配置，不写入公共注册表。

## 如何进入现有流程

- `npm run meta:capabilities:index` 将已验证的包合同加入原有能力总线，记录发现状态、来源和内容摘要。
- `scripts/select-execution-route.mjs` 的 Fetch 再读取当前源文件，不用旧库存充当当前存在证明。中文触发语来自每个角色的 `useWhen`，没有另一份行业路由表。
- 入口继续使用共享的 `entry-classification-lexicon.json`。改简历、写周报、拟客服回复等明确交付请求进入 `standard_path`；纯知识咨询可保持 `fast_path`，发现角色本身不代表获得执行授权。
- 匹配明确时，现有选路器提供 `kim-service:<role>` 这一有来源限定的候选，避免与同名原生 Agent 冲突。匹配含混时保留候选与原因，不代替用户决定产品方向。
- 角色仅用于合同范围内的专业内容交付。代码实现仍走工程能力发现，不因需求中出现「简历」「商品页」就交给只读文案角色。
- Goal Prompt / Loop Prompt、运行时治理、技术脚本以及明确的 Agent / Skill / Command 创建或迭代继续使用原有流程。选路与落盘共用持久能力请求解析器；只有通过专业范围匹配的合同进入执行候选池，不能从通用名称兜底重新选回已排除的角色。
- 包内 `AGENT.md`、输入输出、权限、边界及内容哈希进入本轮 owner contract；发送到 worker 的工作单保留该合同。额外 Skill、MCP 和命令经过搜索后按需要选择，不把不需要的调用虚记为已使用。

## 来源与执行边界

加载器校验 v1 索引、组件身份、源合同哈希、组件全部文件哈希以及索引与源合同的一致性。路径越界、链接跳转、重复身份或内容漂移会返回 `invalid`，该依赖不产生执行候选。加载时只读文件，不运行包中声明的检查脚本。

`component-capabilities-v1` 接受 `schemaVersion: 1` 的组件与能力数组。合同哈希使用键排序的两空格 JSON 加尾部 LF；组件哈希按相对文件名排序，对每个文件依次加入文件名、NUL、原始字节、NUL。身份、版本、入口、验证文件及能力内容必须与源合同一致。当前消费面只接收 Agent 的 `AGENT.md` 入口与只读权限，工具声明也必须和合同相符；其他类型仍走各自既有发现机制。

发现结果的 `verified_local` 只证明当前文件与索引一致。库存记录保持 `canExecute: false`，原生支持保持 `unknown`；持久 provider 的 `support` 保持 `needs_probe`。经本轮审查后可以使用 `run_scoped_owner_contract`，不发送原生 `agent_type`，不声称 Markdown 是已加载的 Codex TOML。

选路预览会保留 `selected_not_invoked` 和 `executionEligible: false`。实际调用仍需当前运行时的工具、权限、来源审查和独立验证证据。外部发布、消息发送、付款及业务系统修改不包含在这些只读角色的合同内。

## 定向验证

```sh
node scripts/run-node-tests.mjs tests/governance/dependency-agent-discovery.test.mjs --concurrency 1
node scripts/select-execution-route.mjs --task "请把真实客服经历改成运营助理岗位简历" --runtime codex --os windows --json
```

第一条使用隔离测试包，第二条使用显式绑定的本地包生成预览；两者都不启动模型代理。修改角色后先在 Kim Service 运行其目录生成器，再重新发现。结构检查、匹配测试和路由预览不等于模型交付验收或发布完成。
