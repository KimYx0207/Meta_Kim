# 更新日志

> 🇺🇸 [English](./CHANGELOG.md) | 中文版

这是 Meta_Kim 面向读者的更新说明。

更新说明先解释本次解决的用户痛点或风险，再说明为了解决它改了什么、为什么重要。过细的内部任务编号、低价值 backlog id 和实现流水账不放在这里；需要精确证据时，请看 Git 历史、测试、生成报告和 PRD 产物。

## [2.9.27] - 2026-08-05

### 修复内容

- **正式打包 CLI 的全局安装与更新现在会迁移已有 MCP Memory runtime，不再直接跳过。** v2.9.26 的不可变正式包虽然正确刷新了 Claude/Codex 投影，却误把独立的 Memory 运行生命周期视为已经处理，导致历史用户仍可能保留旧的、会受系统代理影响的开机脚本。现在正式包会按正常策略完成依赖判断、旁路候选升级、精确暂停自有进程、失败回滚、开机文件刷新、自动重启和健康回读；全新安装、同版本重装、缺少依赖和显式跳过可选工具的行为保持不变。
- **没有旧 manifest 记录的 Windows 启动链，也只会在归属证据完整时自动纳管。** 更新必须同时验证历史 PowerShell 字节、CMD/VBS 完整引用链、未变化的 active runtime 状态、安全的物理 runtime/Python/数据库文件、身份一致且健康的 listener，以及路径不存在既有或并发 manifest 所有者。缺失、被修改、链接、归属含糊或用户自有内容一律不碰，并保持 fail closed。
- **全局 Memory 生命周期不再把 `.mcp.json` 写进不可变正式包。** 回滚状态改存于 Meta_Kim 用户状态目录，因此 Memory 迁移成功后不会破坏 stable package 闭包，也不会误改调用者项目；对外仍由 `meta-kim-runtime` 提供唯一的 Meta_Kim MCP server 入口。
- **切换后验证只容忍短暂观测空窗，不放宽身份匹配。** Windows 健康与进程身份回读会在最多 5 秒内有限重试，但成功时仍必须精确匹配同一可执行文件、launcher、参数、host 和端口；持续不一致仍会回滚。
- **贡献者致谢：** 感谢 [@qitiandashenggogogo](https://github.com/qitiandashenggogogo) 发起 [#50](https://github.com/KimYx0207/Meta_Kim/pull/50) 和 [#51](https://github.com/KimYx0207/Meta_Kim/pull/51) 的贡献；这些成果与其上的历史安装用户迁移加固一并保留在本版本中。

### 验证

- 验证包含针对真实“旧 manifest 未登记”Memory runtime 的正式包全局更新，并回读历史链在不扩大归属边界的前提下完成纳管、Windows launcher 已使用禁用代理的 `HttpClientHandler`、所引用可执行文件存在、重启后服务健康、没有残留孤儿启动项，且不可变正式包仍与其精确 receipt 一致。

## [2.9.26] - 2026-08-05

### 修复内容

- **Windows 历史安装用户重新安装或更新时，不再需要手动结束 MCP Memory 或删除被占用文件。** 只有 endpoint PID、启动身份、可执行文件、launcher、参数、host/port、全局 manifest、当前解释器和数据库都与 Meta_Kim 记录的权威完全一致，安装器才会暂停旧服务；未知 listener 或用户改动一律 fail closed。对同版本重装和历史版本更新，安装器会先在旁路目录准备并验证候选，再停止旧 runtime；切换、重启或健康/身份回读失败时，会恢复旧 runtime、数据库、启动文件、MCP 配置项和 active state。
- **Windows 启动项与依赖检查不再把机器环境问题丢给用户处理。** 精确匹配的 Meta_Kim 孤儿启动项会在依赖步骤前自动修复；健康依赖直接复用，缺失依赖进入正常安装，替换失败保留上一份可工作 runtime。PowerShell 5.1 与 7 的本地健康检查会绕过用户代理，真实 503 等 HTTP 失败仍会判定为失败；相关子进程均隐藏窗口、禁用 shell 并设置有界超时。
- **历史安装状态会沿正常 update 路径做严格受限的自动迁移。** 只有同时满足历史分类与精确所有权的陈旧 manifest 记录，才会在全局安装锁内移除；不可读、仍存在、已漂移、链接或用户所有内容全部保留。install、update 与精确 uninstall 还共用不可变投影包的 digest 锁，避免清理与正在使用该包的进程竞态。
- **发布证明更严格，也更适配 Windows 网络环境。** Release 审计与规划关闭使用有界 WinINET/WinHTTP/直连策略、可信 Windows 系统工具、显式代理/TLS 清理、调用方仓库状态权威，以及精确 asset 大小与摘要绑定。新增 `meta:release:plan` 根据真实 diff 推荐 smoke 或 full；install、runtime、安全、未知或空变更会 fail closed 到完整门禁，且不会削弱 `meta:verify:all`。
- **运行时声明继续保留真实来源。** 仓库外或链接报告不能继承仓库 run identity；runtime acceptance 统一写入规范运行端名称；未知运行端在写状态前失败；激活元数据也不能凭空制造 provider registry 未声明的支持能力。
- **Graphify 发布重建现在能严格恢复上游序列化边界，同时不掩盖危险输出。** 单一 `$text` JSON 对象包装的超边、节点列表外层精确的 `{item:[...]}` 包装、精确的 `name/kind/paths/weight` 备用超边结构，以及严格处于 0–1 的十进制置信度字符串，都会先纳入绑定白名单并规范化，再继续执行原有 ID/引用校验。公开 `https://` 标签不再被误判为 Windows 盘符路径，安全的 `~/.meta-kim` 展示别名会渲染为 `<meta-kim-home>`；字段混搭或多余字段、非法包装或置信度、不安全别名穿越、悬空引用、真实本机路径和不完整图谱身份仍会阻断发布。
- **贡献者致谢：** 感谢 [@qitiandashenggogogo](https://github.com/qitiandashenggogogo) 在 [#50](https://github.com/KimYx0207/Meta_Kim/pull/50) 和 [#51](https://github.com/KimYx0207/Meta_Kim/pull/51) 中提供的初始贡献。本版本继续保留这两项已合并贡献，并补齐其上的历史用户更新、回滚与发布证明加固。

### 验证

- 发布验证覆盖全新安装、同版本重装、历史版本更新、部分失败残留、用户改动漂移、Windows 精确进程权威、事务回滚与直接重试、本地健康检查绕过代理、受锁保护的历史 manifest 迁移、共享包生命周期锁、公共打包 CLI 安装/更新、runtime/provider 来源，以及 GitHub Release 精确绑定。

## [2.9.25] - 2026-08-05

### 修复内容

- **Windows 已安装 CLI 在“当前 Node 可执行文件旁边没有自带 npm”时也能完成全局更新。** 稳定包同步会先检查 Node/npm 的直接安装布局，再从净化后的 PATH 安全解析真实 `npm.cmd` 及其绝对 `npm-cli.js`，全程不经过可见 shell。这样可兼容 Codex/便携 Node 启动器，同时保留不可变包权威和无 shell 子进程边界。
- **繁忙 Windows 主机上的发布验证不再误报失败。** Graphify 合并属性现在是仓库正式跟踪规则，不会在验证中途产生未跟踪文件；Job Object 的“监督进程死亡”探针为高负载 PowerShell 进程查询保留了足够观察时间；并发验证历史夹具也会有限重试 Windows 临时目录清理。这些改动都没有放宽生产断言。
- **v2.9.23 与 v2.9.24 的兼容修复全部继续保留。** 历史启动项自动清理、依赖状态处理、全局 `meta-theory` 投影、Graphify 隐藏探测、PR #50/#51 修正和精确 Release 审计提升均未改变。再次感谢 [@qitiandashenggogogo](https://github.com/qitiandashenggogogo) 在 [#50](https://github.com/KimYx0207/Meta_Kim/pull/50) 和 [#51](https://github.com/KimYx0207/Meta_Kim/pull/51) 中提供的初始贡献。

### 验证

- 验证覆盖便携 Node/无内置 npm 回归、真实打包后的全局更新、标准完整发布门禁和 GitHub Release 精确绑定。

## [2.9.24] - 2026-08-05

### 修复内容

- **公开的发布审计 CLI 现在会在生成精确发布绑定后正常结束。** 运行时能力证据提升不再反向导入正在执行的审计模块，消除了循环模块等待；此前该问题会先写出有效的 `published_bound` 记录，随后以 Node 的 top-level await 未完成警告退出。
- **v2.9.23 的安装、更新、启动项自动修复、Graphify 隐藏探测、全局 Claude Hook 与 runtime rebind 修复保持不变。** 本补丁只为修复其发布后审计命令而取代 v2.9.23，并继续保留对 [@qitiandashenggogogo](https://github.com/qitiandashenggogogo) 在 [#50](https://github.com/KimYx0207/Meta_Kim/pull/50) 和 [#51](https://github.com/KimYx0207/Meta_Kim/pull/51) 中贡献的致谢。

### 验证

- 发布验证覆盖共享 canonical 哈希边界、新旧验证报告阶段结构、真实打包后的审计 CLI，以及一次新的干净完整打包产品门禁和后续精确 GitHub Release 绑定。

## [2.9.23] - 2026-08-04

### 修复内容

- **Windows 历史安装用户不再需要手工删除失效的 MCP Memory 开机启动项。** 正常安装/更新会在依赖处理前，仅识别并清理“命令目标已经丢失”的 Meta_Kim 精确 `mcp-memory-silent.vbs` 形态；公开的恢复卸载入口也能执行同一套有边界修复，未知或被用户修改的启动文件继续保留。
- **MCP Memory 依赖安装现在会区分“从未安装”“已有健康环境”和“替换失败”。** 安装/更新不再盲信 PATH 中第一个候选，而是验证真实可执行性；健康环境直接复用，新环境只有验证通过后才激活，升级候选失败时保留原来可用的运行时。
- **Claude 的历史 MCP 注册会通过公开更新入口自动迁移。** 严格历史识别现在覆盖过去产生的直接 Node 和 `cmd /c` 形态，包括绝对 `node.exe` 路径；只把已证明属于 Meta_Kim 的 `meta_kim_runtime` 替换成稳定的 `meta-kim-runtime`，其他服务器、认证、环境变量和用户配置保持不变。
- **历史安装用户兼容性成为发布硬规则。** 安装、更新、同步、清理、依赖、启动项、manifest 和生成配置相关改动，必须覆盖全新安装、同版本重装、历史版本升级、上次安装残留和用户修改漂移；维护者专用清理命令或只修全新安装的补丁不再算产品修复。
- **Windows 的 Graphify 验证不再调用 `py -3` 或弹出可见终端。** 自动发现只接受 PATH 或标准安装目录中的绝对 `python.exe` / `python3.exe`，拒绝 WindowsApps 别名，并把版本、pip、Graphify、Git 与迁移相关子进程统一隐藏运行；没有 Python 时会干净地进入依赖缺失分支，已有健康 Python 时直接复用。
- **全局 Claude Code 安装现在会真正注册已经投影的能力优先治理 Hook。** 历史全局设置在正常更新时补上 `enforce-agent-dispatch`，重复更新保持幂等，项目内与全局治理不再出现一边生效、一边漏接线的差异。
- **运行时 CLI 升级后可以只刷新启动清单，不再顺带重装开机启动。** 新的 `meta-kim runtime rebind` 公开入口只重绑 Claude Code / Codex 可执行身份，严格校验 target、scope 和 Node 版本。macOS / Linux 的 MCP Memory 启动链与 Windows 一样由正常更新写入精确 manifest，不依赖文件名或脚本文本启发式判断。
- **贡献致谢：** 感谢 [@qitiandashenggogogo](https://github.com/qitiandashenggogogo) 通过 [#50](https://github.com/KimYx0207/Meta_Kim/pull/50) 和 [#51](https://github.com/KimYx0207/Meta_Kim/pull/51) 发现全局 Claude 治理 Hook 漏接线与运行时清单重绑问题，并提供初始实现；本版本在这些贡献基础上补齐历史更新、公开 CLI、跨平台 scope、安全边界和发行回归。

### 验证

- 标准完整发布门禁使用真实打包后的公开 CLI，覆盖安装、更新、重复更新、历史迁移、孤儿启动项自动修复、跨平台启动链 manifest、归属卸载、用户状态保留、运行时重绑、全局 Claude Hook 补线、隐藏式 Graphify 探测、运行时同步与治理回归。

## [2.9.22] - 2026-08-02

### 修复内容

- **Claude Code 的进度保存现在可以在只有 `python3`、没有裸 `python` 命令的新版 macOS 上正常工作。** macOS 和 Linux 优先尝试 `python3`，并保留 `python` 作为兼容回退；每个候选都必须先证明满足 Python 3.10+，才会运行 memory helper。
- **Windows Python Hook 不再回退到 `py.exe`，也不会再弹出可见控制台窗口。** Claude Code 和生成的 Codex Hook 会从安全的明确路径、PATH 和常见非 PATH 安装目录中选择经过验证的解释器；过期环境覆盖、WindowsApps 别名和 `py` launcher 都会被拒绝，子进程统一隐藏窗口启动。
- **兼容修复没有改变 Hook 原有行为。** stdin/stdout 转发、退出码处理、有界探针和执行超时继续保留，运行时证据账本也已重新绑定到修正后的 Claude canonical 投影。

### 验证

- 跨平台安装器与 MCP Memory Hook 定向回归 83/83 通过，运行时证据回归 11/11 通过，运行时能力矩阵已按修正后的源码指纹验证通过。

## [2.9.21] - 2026-08-01

### 修复内容

- **run-status 不再把治理任务原文或稳定 fingerprint 复制到状态输出。** 文本、详情和 JSON 共用同一份脱敏公开投影；嵌套 fingerprint 会被移除，自由文本若重复任务内容会被脱敏，完整报告内容只通过显式报告回读查看。
- **Codex planning Hook 不再携带维护者电脑上的固定 Python 路径。** 安装/更新只记录通过共享活探针的解释器描述，生成的 runner 每次仍重新验证 Python 3.10+；过期环境覆盖、过期安装提示、失效 PATH 和只会伪造 `--version` 的程序都会被拒绝并继续寻找有效解释器。
- **失效解释器不再让 Hook 长时间卡顿。** PATH 候选先检查文件存在，每个可执行探针使用较短的有界超时。

### 验证

- 状态、安装器、packed 回读、Graphify runtime、PRD、同步和项目聚焦检查通过。两路独立 Review 曾退回第一版；嵌套 fingerprint、短任务、非 PATH 回退、过期 hint 和超时反例均已进入回归。修正候选按低风险发布使用 release smoke，不重复无关的完整发布套件。

## [2.9.20] - 2026-08-01

### 修复内容

- **npx 继续作为受支持的全局安装/更新入口，但可回收 cache 不再成为永久运行权威。** 在写入 Claude Code 或 Codex 的 Commands、Hooks、合并配置前，候选实现先把精确安装包物化到由“包版本 + 打包文件 SHA-256”定位的共享不可变目录；所有持久执行引用只从这个稳定根生成。
- **只读、执行环境和所有权边界保持明确。** help、status、doctor 不会只因调用就物化稳定目录；check 按 npm 的真实打包文件集核对，但不写用户 npm cache。版本探测、真实 pack 与 install 共用一次性私有 cache/temp，稳定 child 会去掉临时执行环境覆盖。卸载先清除持久引用，再删除 receipt、first-party 文件与目录闭包都精确匹配的 manifest-owned bundle。
- **物化过程被意外中断后可以恢复，但不会信任或删除未知内容。** 同一摘要由带 owner 的锁串行创建；已死亡且缺少 receipt 的残缺目录会连同证据一起原子隔离后再重建，完整但不可信的目录仍然 fail closed。稳定 child 还会先把结构化项目部署记录还原成真实目标目录，再运行 Graphify 工具。
- **保留的 Hook 备份不再膨胀活跃能力清单。** discovery 只在遍历前剪枝 Meta_Kim 精确命名的非运行态 Hook 备份目录；磁盘上的备份全部保留，名称中只是包含 `backup` 等字样的用户目录仍会被发现。在维护者验收机上，活跃 Hook 记录从 5947 降到 153，可搜索能力条目从 7573 降到 1779。
- **发布证明会真实覆盖“临时根消失”这一故障。** packed 公共 CLI 从 npx 形状的临时包根更新 Claude Code 与 Codex，删除全部可回收来源，再从精确稳定 authority 执行 check，并回读 Commands、Hooks、合并配置、manifest 完整性和所有引用路径。若当前版本的 Git tag 已存在，发布预检会在昂贵探针前直接阻断，避免未升版本的候选借更旧历史 tag 取得通过。

### 验证

- lifecycle、cleanup、Hook 投影、packed proof、tag guard、release binding 与 first-party 漂移定向回归已通过，并完成 correctness、security、completeness 独立反证。安全口径只覆盖正常 cache 删除、意外内容漂移、链接路径拒绝和精确卸载所有权；不声称抵抗同一用户下的恶意进程、被替换的 Node/npm 或供应链攻击。P-141、P-151、P-154、P-156、Cursor live、Docker 验收和已取消的 Claude 上下文删减 A/B 继续保持独立。

## [2.9.19] - 2026-08-01

### 修复内容

- **Windows runtime 验收不再根据可复用 PID 反推整棵进程树，而是用私有 Job Object 管住自己创建的进程。** 根进程先以 suspended 状态创建，成功加入 Job 后才恢复；kill-on-close、owner 进程 handle 与 supervisor pipe lease 共同覆盖 timeout、launcher 崩溃、Node supervisor 退出和根进程提前结束，确保真正加入 Job 的成员被排空。
- **runtime 命令输出有界保存，同时保留完整流证据。** 每个输出流只保留有限正文与尾部，但记录完整字节数和 SHA-256；UTF-8 截断不会产生破损字符，仓库路径、用户 home、WSL 路径和凭据默认脱敏，次级临时文件清理失败也不会覆盖主要进程清理结果。
- **清理声明与真实控制范围一致。** 发布证据只能验证 runner 自己拥有的 Windows Job 或 POSIX detached process group；明确不声称能清理任意完整系统进程树，也不覆盖脱离该进程组创建的进程。标准发布链新增一次串行 process-guard 阶段，避免这些生命周期测试在其他套件中重复执行。
- **Windows PowerShell 5.1 现在会显式按 UTF-8 读取 evaluator 启动规格。** 无 BOM JSON 交接中的真实中文 Agent 定义、emoji、重音拉丁文、日文和韩文不再损坏；launcher/result 矛盾、越界协议数值和畸形公开失败证据会 fail closed，不会被误报为清理已验证。
- **主要进程清理真值与次级控制目录清理分开记录。** 临时目录残留会继续作为有界、固定白名单的次级失败显示，但已经自洽证明的 Windows Job 或 POSIX 进程组清理不会被它覆盖。公开报告不会带出原始命令、提示词、路径、环境变量、输出、stack 或 signal。
- **Graphify 重建现在能正确处理当前工作区中有意删除的受跟踪文件。** 在计算当前仓库快照前会排除 Git 索引里已删除的旧路径，替换旧进程 guardian 不再因 `ENOENT` 让代码图迁移崩溃；若文件在摘要过程中并发消失，验证仍会 fail closed。
- **Graphify 在 Windows 安装已验证代码图时，只对短暂目录锁做有限重试。** `EPERM`、`EBUSY`、`EACCES` 使用很短且有上限的退避；其他错误立即失败，重试耗尽仍恢复上一份已验证图，不会放宽发布门。
- **OpenClaw 2026.7.1 的 SQLite 认证存储不再让兼容 smoke 失败，也不会触发旧式凭据复制。** Meta_Kim 识别由 OpenClaw 管理的 per-agent SQLite store，把认证继承继续交给运行端处理，绝不复制凭据数据库；只有不存在当前 store 的旧安装才继续使用固定 JSON 文件兼容镜像。

### 验证

- 定向回归覆盖 root/child/grandchild timeout 清理、根进程非零退出后的后代排空、launcher 崩溃、Node supervisor 退出、缺失 launcher 结果、残留 timer、stdout/stderr 洪泛、默认脱敏、UTF-8 分片/规格往返、POSIX 结果竞争、矛盾协议组合及主要/次级清理真值。correctness、security、completeness 三路独立 Review 最终均为 P0/P1/P2=0。最终仍以最终提交上的单一 clean 15/15 标准门、精确 Release 绑定和 Claude Code/Codex 正式全局读回为准；此前第 8 项失败报告和后续 Claude-only 定向诊断都不算发布证据。

## [2.9.18] - 2026-08-01

### 修复内容

- **治理判断与运行状态事务现在有了清晰边界。** `spine-state.mjs` 继续作为唯一兼容入口和状态权威，路径/profile、任务身份、HMAC、迁移、锁/CAS、激活与终止全部留在原事务链；无文件 I/O 的阶段、能力、选择面与 fan-out 判断被抽到单一共享规则模块，局部修改不再与持久化实现混在一起。
- **Claude Code、Codex 与 Cursor 的 Hook 投影会先安装依赖，再替换引用它的入口。** 项目同步、全局同步、setup、清理白名单和能力发现目录都认识新的共享依赖；更新中断不会留下“新入口已经生效、依赖文件却还不存在”的本次新增窗口。
- **共享治理常量不能再被同进程导入方篡改。** 阶段顺序、公开标签、选择面状态与嵌套阶段策略均已深冻结，Meta Agent 名单保持私有；伪造 owner 不能通过修改共享数组进入主 dispatch chain。

### 验证

- 旧 `spine-state.mjs` 的 43 个导出完整保留，14 个迁移后的规则导出仍与新模块保持同一引用。定向回归覆盖状态 CAS/迁移/中断修复、三运行端冷启动、packed/global Hook 投影、依赖写入顺序、策略常量篡改和伪 owner；correctness、security、projection completeness 三路独立 Review 最终均为 P0/P1/P2=0。发布仍以标准完整门、精确 Release 绑定和 Claude Code/Codex 正式全局读回为最终证据。

## [2.9.17] - 2026-07-31

### 修复内容

- **Codex Agent 与 Skill 发现现在会保留来源，不再把同名定义压成一条未经确认的能力。** 内容完全相同的副本仍可作为别名复用；互相冲突或元数据无效的定义只用于诊断，不能进入普通或动态执行路由。真实文件系统定义优先于过期缓存，项目与全局冲突继续保留各自的所有权和修复边界。
- **离线路由不能再用传入 JSON 或环境变量伪造 Codex 原生自定义 Agent 权限。** 只有当前交互宿主可以证明原生 `agent_type` 支持；离线选择会拒绝自报的宿主 schema，并安全退回本次运行范围内的 owner contract。
- **能力诊断和公开输出更安全，也更诚实。** 新增 Codex Skill 预检与 JSONL 重放命令，用来报告候选能力集合压力和已观察事件标记，不冒充宿主完成，也不推断因果关系。公开清单与路由输出会清除密钥和本机路径，以摘要代替完整 developer instructions；安装所有权无法验证时会 fail closed。
- **标准发布验收不再把维护者接管的 Graphify 产物当作新鲜生产证据。** 门禁现在会亲自启动并观察确定性的本地代码图更新，绑定过程中未变化的仓库快照，再在不使用 LLM 的情况下重新聚类，最后执行原有身份与新鲜度检查；旧产物接管只保留为恢复手段。

### 验证

- 定向发现、路由、YAML 元数据、所有权、隐私与重放回归已通过，覆盖冲突自定义 Agent、动态 lane 中的无效 provider、带引号或逗号/分号的本机路径、包含秘密的环境片段、进程失败退出，以及只有事件标记但没有独立宿主回执的情况。correctness、product-fit、security 三路独立 Review 均未发现剩余 P0/P1/P2。发布前仍必须完成标准完整发布验证、真实打包产品安装、Release 精确绑定，以及 Claude Code/Codex 最终全局读回。本版本不声称已经修复 Codex 宿主元数据截断。

## [2.9.16] - 2026-07-31

### 修复内容

- **Codex CLI 0.146 现在能收到合法的自定义 Agent 发布熔断请求。** 自包含的子任务验收在显式指定 `agent_type` 时同步使用 `fork_turns: "none"`，避免宿主拒绝“指定 Agent + 默认继承完整对话”的参数组合。
- **完整发布验收现在会在同一次运行中持续保留并核对同一组声明运行端投影。** 同步与读回阶段都从规范 `sync` 清单明确选择 Claude Code、Codex、OpenClaw、Cursor，不再在跨端 smoke 前退回本机默认目标，或把刚生成的四端文件误判为过期。
- **Claude Code 2.1.202 的异步 Agent 只有在精确子任务结果和完整任务生命周期都结束后，才会成为有效证据。** Agent 与 subagent 观察现在同时绑定 session、tool call、task、子任务结果、完成边界和 marker digest；失败、重复、乱序、跨 session 或只有装饰文本的结果都会 fail closed，不再被误判成成功的子任务。
- **当独立 Codex CLI 无法调用时，Codex Desktop 可以从当前原生任务提供新鲜发布证据。** 读取器兼容当前结构化输出块，忽略外层仍在运行的字符串输出，同时继续要求命令、文件读取与补丁操作按精确顺序完成；普通字符串或自报的 `Exit code: 0` 不能制造成功 capability receipt。
- **已完成的 Graphify extract 现在可以显式、安全接管，不必重复提取。** 接管前必须同时绑定精确 HEAD、仓库文件清单与内容、普通文件产物哈希、图身份、报告计数和“源码未晚于提取产物”的时间证据；随后只能从 cluster/stamp 接续。rebuild 还会把规范的 `~/.meta-kim/...` 文档示例确定性改写为非本地展示标记，真实 home 路径、未知 alias 和路径穿越形式仍然 fail closed。
- **runtime-capability 证据回归的冻结时钟已与仓库证据日期同步。** 基线不再把现有的 2026-07-31 OpenClaw 投影观察误判为未来证据，同时负例仍会拒绝真正更晚的观察日期。

### 验证

- 定向 observer、producer、原始记录重放、acceptance 与 Graphify 安全回归覆盖 Claude 同步/异步 Agent 生命周期、精确子任务结果哈希、重复与失败终态、跨 session/call 拼接、Codex Desktop 字符串输出反证、合法结构化桌面证据、安全接管现有 extract、错 HEAD/源码变化拒绝以及私有路径/穿越拒绝。Graphify 门禁修复加入前，correctness、security/truth、completeness 三路独立 Review 均未发现剩余 P0/P1/P2；新增修复仍需通过标准完整发布验证和发布后的精确包绑定。当前生产观察已精确覆盖 Claude Code 5/5 与 Codex 5/5。

## [2.9.15] - 2026-07-31

### 修复内容

- **不再把 OpenClaw 的声明式 `executionBlock` 策略描述成机械工具调用拦截。** canonical 运行端边界现在明确：拒绝说明只是策略指导，真正阻断或改写工具调用需要 OpenClaw typed plugin Hook。Meta_Kim 仍不声称已经安装该 adapter，也不会把 Claude Code 或 Codex 的 deny-payload 语义直接复制到 OpenClaw。

### 验证

- correctness、security/truth、completeness 三路独立 Review 已关闭全部 P0/P1。私有 capability-gap PRD 测试 56/56 通过，五分类严格验收通过，运行端投影同步与 `git diff --check` 通过；发布前只执行一次的全局 fresh readback 已确认 Claude Code/Codex 的治理 Agent、Meta-Theory Skill、Hooks、Commands、MCP 与 choice 配置均为当前版本。

## [2.9.14] - 2026-07-30

### 修复内容

- **从 GitHub 下载源码包或在 Windows 上用 Git 克隆时，不会再仅因文本换行符为 LF/CRLF 就触发仓库证据校验失败。** UTF-8 文本现在按统一 LF 表示计算仓库源码绑定，非文本文件仍保持原始字节哈希，因此相同的受跟踪内容可在源码包、npm 安装包和本地工作区中得到一致结果。

### 验证

- 仓库证据回归同时验证 LF 与 CRLF 分发结果一致，并保留非 UTF-8 文件的原始字节敏感哈希。GitHub 源码包形态与实际 npm 打包产品形态均不再出现 SHA-256 不匹配。发布前仍必须完成标准完整发布门禁与发布后的精确包绑定审计。

## [2.9.13] - 2026-07-29

### 修复内容

- **Claude Code 不再持续调用已经失效的 Windows 旧 Python 目录中的 Graphify。** 安装与更新会从 Meta_Kim 实际选中的 Python 解释器解析 console script，包括带版本号的 Windows 用户脚本目录，再只把已确认的 `hook-guard read/search` 旧项迁移为无 shell 的 `command` + `args` 形式；解析过程不会信任 `PATH` 中另一个同名 `graphify`。
- **纯全局更新现在能修复已有用户 Hook，但不会擅自创建项目或用户接线。** 已有 guide 内容不再阻止上游 Graphify 刷新；未知命令与裸命令保持不变；settings 写入先备份并原子替换；Doctor 在没有已验证新路径时只报告缺失 executable，不删除也不改写旧 Hook。
- **Graphify 重建不再把本机私有路径留在节点 `source_url` 中。** 输出清洗只移除该字段内已识别的 Windows、UNC、macOS、Linux 与 home-relative 本机路径，记录精确脱敏数量，同时保留 HTTP(S) 与仓库相对来源。

### 验证

- 定向回归覆盖 parser、sanitizer、Doctor、runtime resolver、setup flow、Graphify CLI safety、输出隐私与 Windows integration，包括原始 Python 3.11 正斜杠命令、当前 Python 3.14 用户脚本目录、selected-interpreter 绑定、拒绝 `PATH` 回退、幂等、未知 Hook 保留、备份/原子写失败、global-only 不创建配置、私有 `source_url` 脱敏，以及 Doctor 诊断前后原始字节不变。独立 release-fit 与 Hook-safety Review 已关闭全部 P0-P2。只有标准完整发布验证与发布后的精确包绑定都通过后才发布本版本；Docker、Cursor 产品执行、任务预算与可选 live certification 不从这些定向检查推断。

## [2.9.12] - 2026-07-28

### 修复内容

- **上下文工程预算不再在宿主尚未观察和测量时提前通过。** 默认 governed run 会保持 `partial`，直到 runtime 证明实际加载的固定/可变上下文、给出有限非负的输入 token 数、完成重复/冲突/遗漏检查，并把每条已观察 source 绑定到证据。缺失测量现在会形成明确 blocker，不再被硬编码成 `pass`。
- **所有 public-ready 验证入口现在消费同一份上下文真值。** 通用 run-artifact validator 与 strict intent validator 都会拒绝缺包、partial、blocked、未测量、未观察或缺少证据引用的 context budget。top-level 与 `coreLoop` 副本必须一致，成功的嵌套包不能遮蔽失败副本；非 public-ready 运行仍可省略该包。

### 验证

- 定向 public-ready/context-budget 回归覆盖通用 validator、strict validator、governed runner、产品目标路径、有效 fixtures 和 top-level/`coreLoop` 遮蔽反例；correctness、completeness、collision 三路独立 Review 已接受最终隔离 diff。只有标准完整发布门和发布后的精确包绑定都通过后才发布本版本；Graphify、Docker、任务预算、Cursor 产品执行和可选 live certification 不从定向检查中推断。

## [2.9.11] - 2026-07-28

### 修复内容

- **Claude Code 与 Codex 的能力证据现在只说明“当前宿主可以尝试接手”，不再冒充 Meta_Kim 已授权或已执行。** 兼容的宿主能力进入明确交接状态；历史观察始终只是参考，明确不支持、仅供参考、错误 runtime 和未证实的原生选择能力继续阻断。独立 runner 只生成有边界的宿主请求，callback、环境变量、JSON、receipt 或自哈希都不能制造当前执行权限。
- **Runtime 观察从一张报告矩阵变成可恢复、按能力绑定的正式产品路径。** 打包后的 CLI 可记录和读取 Claude Code/Codex 共十项精确能力，绑定真实 producer 事件与发布 lineage，保留失败证据用于诊断，MCP 明确输出 populated 10/0 与 empty 0/10，同时所有持久化结果都不能反向开启执行。
- **安装与发布证明现在验证用户真正运行的包。** Windows 启动清单绑定发现入口、shim、launcher 和 JavaScript 入口，但不虚构同用户信任根，也不声称彻底消除 TOCTOU。带项目刷新的全局更新会先把 managed deployment 记录规范成绝对清单根目录，不会在项目能力复制后误判失败。当前、项目、历史三条安装/升级路径必须精确覆盖 canonical 四目标；Verification、Release audit、release close 和只读观察入口复算同一个原始证明，旧格式、缺目标、只报数量或自报成功都会失败。
- **Packed MCP 验收现在会把只读观察与它真实产生的有效矩阵比较。** 包内 canonical 原始矩阵仍必须完全一致；MCP 回读则必须与同一已安装包、同一隔离只读快照重新计算出的有效矩阵完全一致。预期的 advisory 叠加不再误报发布失败，同时原始矩阵漂移或有效状态漂移仍会被拒绝。
- **治理验收现在读取当前按运行模式拆分的 runtime claim 格式。** 每个声明的 runtime mode 都必须有非空 `evidenceRefs` 和完整 `claimsByMode` 事实，不再错误要求已经废弃的顶层 `evidence` 占位字段；旧结构或缺字段记录仍会 fail closed。
- **Graphify 现在能在子目录存在同名文件时，为仓库根目录文件生成稳定且唯一的标签。** 根文件使用真实的显式相对写法，例如 `./README.md`；普通文件和子目录的最短唯一路径保持不变，并由回归测试保护可重放的身份校验。

### 验证

- 十一轮反证与返工依次关闭了伪授权、路由死锁、原生选择歧义、Stage Runner 绕过、启动身份漂移、packed 源泄漏、目标集合不完整、发布审计误信、worker 错误归因和连续发布 lineage 问题。最终 correctness、security、product-completeness 三路独立 Review 均无 P0/P1/P2，Meta-Review 已授权进入标准发布门。已有 Claude Code 5/5、Codex 5/5 的生产观察只读复用，没有重复调用模型。Cursor 产品执行、Docker、任务预算和可选 live-certified 外部签名均不是本版验收证据。

## [2.9.10] - 2026-07-28

### 修复内容

- **Graphify 的“最新”现在证明身份规则和仓库内容，不再只比较 Git 提交号。** 所有真实 upstream file node 都使用已安装 Graphify 0.9.28 的 Unicode normalizer 和完整 source path 身份；proof 精确绑定仓库文件清单与内容、全部节点与关系、两份 hyperedge 表面、analysis、provenance、sanitization 和报告数量。同名的 Claude 适配器与共享实现保持两个真实、可分别查询的节点。
- **增量更新和聚类中断现在从一致快照恢复。** Extract checkpoint 保存内容绑定的 graph/analysis 输入，cluster checkpoint 再绑定最终 report；sidecar 截断、graph 部分写入、report 被改、上游命令运行期间源码变化、community 仍引用旧节点或孤儿 snapshot，都不能冒充 current。增量更新发现新节点或改名节点尚未进入 analysis 时会自动重新聚类，且每个 graph node 必须恰好属于一个 community。
- **Graphify 生成证据不再泄露或跟随私有本机路径。** Graph、analysis 的键和值、report 正文和恢复 snapshot 都拒绝 Windows、UNC、Unix home 及分隔符后的 `~/` 路径，错误不会回显秘密。Graphify output、state 和 snapshot 必须是位于真实仓库输出目录内的普通文件；混合大小写 `GIT_*` 错仓、junction 和 symlink 外跳都会 fail closed。
- **跨运行时发布验收现在使用目标 Claude Code 自己的 provider，不再误继承调用方 provider。** Hook 隔离仍使用空 setting sources，同时只从 Claude 全局设置中白名单读取 provider、模型和 timeout 环境。这样从 Codex 发起的发布检查会调用用户配置的 `MiniMax-M3`，不会再把这个模型名发给调用进程里残留的 GLM 接口；其他任意 settings 环境项仍不会进入验收子进程。

### 验证

- correctness、反例和 security 三路独立 Review 把闪退、旧 proof、TOCTOU、路径泄漏、symlink、community 漏项/重复和孤儿 snapshot 反例转成回归后，最终 P0/P1/P2 均为 0。Graphify 聚焦测试 69/69，Claude provider 环境测试 24/24，唯一私有 PRD 合约 56/56；真实 Python 3.14.6 / Graphify 0.9.28 重建和独立检查已绑定每个实际表示的节点、精确 link、community 引用和真实 file identity，且没有开放 checkpoint。发布验收还明确排除了 Windows CEF 继承仓库工作目录时可能生成的根目录 `debug.log`，并用回归测试证明这种机器日志不会再让知识图证明过期；双主运行时发布保险丝随后以真实 `MiniMax-M3` Claude Code 调用和 Codex 调用共同得到 release-grade 证据。上游 88 个零节点来源和 semantic collision 完整性明确留在 P-149。Docker、任务预算和 Cursor 产品执行不作为验收证据。

## [2.9.9] - 2026-07-27

### 修复内容

- **私有工作队列现在可以收尾公开发布，但不会因此被公开。** 打包后的 `meta-kim release close` 读取唯一被 ignore 的 PRD `ACTIVE` 行，只向已经存在且同样被 ignore 的 planning 文件追加一段人话、幂等的发布事实。它不会创建公共 backlog 镜像、公开 PRD，也不会把 planning 段落变成第二个队列权威。
- **发布收尾会重新证明当前公开事实和全局状态，不再相信本地“成功”标签。** 写入前，命令会把哈希串联的 `published_bound` 证据与 GitHub 上真实的 annotated tag、Release、重新下载的 tgz、精确 clean verification report 和 remote main 再做一次绑定；随后检查系统账户真实默认目录里的 Claude Code/Codex 全局投影，并在投影和 record 发布前后紧邻复核 PRD、tracked tree、tag、audit、planning presence 与 marker。
- **闪退恢复和恶意本地路径重定向都会 fail closed。** 不可变备份、逐文件原子替换、完整内容 hash 的 closure record 与稳定 marker，使重跑可以保留正确结果、只补缺项。被跟踪或不私有的 planning、畸形 marker、脱链/伪造 audit、篡改 record、symlink/junction、并发修改队列或文件、runtime/source/Node preload 重定向，以及 Windows 大小写不敏感的 `GIT_*` 假仓库重定向都会被拒绝，不能冒充 `release_closed`。

### 验证

- correctness、反例和 security 三路独立 Review 把实际攻击反例转成回归后，最终均为 P0/P1 归零。正式验收覆盖 release-close 与 release-audit 定向测试、CLI UX、完整 governance 回归、打包边界、项目同步/检查、标准全量发布门禁、发布后的精确包审计，以及 Claude Code/Codex 最终全局 setup 回读。Docker、任务预算和 Cursor 产品执行不作为验收证据。

## [2.9.8] - 2026-07-27

### 修复内容

- **全量验收失败不再抹掉之前的证据。** 每次 `meta:verify:all` 结束都会先写入不可变 attempt，再更新兼容旧读取方的 `verification-report.json` latest 投影。独立的最近发布级指针会保留可直接交给发布审计的精确 clean attempt，即使后面又跑了诊断或失败验收也不会丢。
- **报告写到一半时闪退，不会再让以后每次验收都卡死。** Attempt 与 lock owner 只有在完整原子写入后才对外可见；第一次升级会导入旧 clean 报告。半截旧 projection、坏 attempt、死锁和 PID 被复用的陈旧锁会原样保留为恢复证据，但不再阻断下一份报告。
- **并发运行和自定义输出不会互相串历史。** Latest 由完成时间和 attempt ID 稳定决定，不依赖抢锁顺序；不同自定义报告路径各用自己的 history；Windows 大小写别名和路径穿越 ID 不能覆盖不可变 attempt；现有发布审计仍能读取新增字段后的报告。

### 验证

- 定向回归覆盖崩溃残留、旧报告迁移、并发、自定义路径、Windows 大小写 alias、路径穿越和 exact 发布审计。正式发布前仍必须完成标准全量门禁、精确包绑定与 Claude Code/Codex 全局 setup 回读。Docker、任务预算和 Cursor 产品执行不作为验收证据。

## [2.9.7] - 2026-07-27

### 修复内容

- **运行端专用 provider 不再冒充其他运行端也支持。** Claude Code、Codex、Cursor、OpenClaw 及 HookPrompt adapter 只在声明的目标运行端保留正向 claim；所有非目标 adapter 都明确阻塞、安装层与系统层为 unsupported，且不再复制目标运行端的激活事件。
- **Provider claim 现在只有一个长期事实源。** `providers[*].support` 负责可用性真值，显式 runtime target 负责适用范围，`runtimeAdapters` 只是由 schema 和 validator 双重校验的投影。静态 registry 不得声称 provider 已被选择、调用、完成或现场运行；这些只能来自本次运行证据。
- **Validator 会拒绝“看起来完整”的假记录。** 负例覆盖跨运行端 `verified`、用 support override 伪扩目标、adapter/source mapping 漂移、自相矛盾的 state/status、激活事件泄漏和私有运行状态字段。Claude Code 与 Codex 的目标能力保持 verified；本版没有把 Cursor 产品执行包装成已处理。

### 验证

- 本次由 provider 定向测试、完整 governance 回归、真实 schema 校验、项目同步/检查、标准发布门禁、精确发布绑定以及 Claude Code/Codex 全局 setup 回读共同验收。Docker、任务预算和 Cursor 产品执行不作为验收证据。

## [2.9.6] - 2026-07-27

### 修复内容

- **发布证据现在可以被审计，不再靠事后回忆拼接。** 打包后的 `meta-kim release audit` 会把本地与 GitHub annotated tag、peeled commit/tree、干净全量验证报告、公开 Release 和上传的 npm 包写入不可变、哈希串联的 attempt 记录。旧版本如果已经找不到当时的干净报告，只能明确记为 verification unbound，不能补写成 exact。
- **被替换过代码的包不能继承干净发布结论。** exact 升级要求本地 tgz 与 GitHub asset 都逐字节等于同一份干净 `meta:verify:all` 实际安装并测试过的 npm 候选包；只有包名、版本号或 `package.json` 相同会被拒绝。
- **审计证据只能写进仓库拥有的状态目录。** 输出根目录及其 `attempts`、`stale-locks` 子目录会在 lock、record、pointer 或 stale-lock 写入前拒绝 symlink/junction 跳转。失败 attempt 继续追加保存，不会覆盖最近一次成功绑定。

### 验证

- 发布验收覆盖审计与 junction 反例、完整 governance 回归、脏候选与干净提交两轮标准 `meta:verify:all`、packed CLI、发布后附加到 GitHub Release 的 exact `published_bound` 记录，以及 Claude Code/Codex 最终全局 setup 回读。Docker、任务预算与 Cursor 产品执行不作为验收正证。

## [2.9.5] - 2026-07-27

### 修复内容

- **`meta:theory:report latest` 现在会说清楚自己选的是哪一种 “latest”。** 命令仍然读取最后一次 committed governed report，合法的 `partial` 报告也会正常打开；但 JSON 摘要新增稳定的 `selection` 区块，明确区分 committed report 指针和当前 active lifecycle run。
- **当前运行状态不能再静默改写报告读取结果。** active 关系只通过 Meta_Kim canonical status reader 判断；弱格式或坏掉的 `active-run.json` 投影不被信任，自定义报告目录保持隔离，显式 runId 仍精确读取指定的 committed artifact。
- **Claude Code 和 Codex 的命令说明保持同一边界。** 两端投影都会提示操作者报告 selected run、artifact claim status、active-run relation 与继续命令，同时不得输出任务原文或 task fingerprint。

### 验证

- 标准 `meta:verify:all` 在一次不中断运行中 13/13 全过，覆盖四运行端隔离 install/update、packed 用户与项目 install/update/re-update、全局 Hook、Meta-Theory 1,366 项 0 失败（3 项按设计跳过）、integration，以及 fresh Claude Code/Codex live release fuse。Docker、任务预算和 Cursor 产品执行没有被当作验收正证。

## [2.9.4] - 2026-07-26

### 修复内容

- **LangGraph 现在可以进入真实 Dynamic Workflow，但不会变成第二套工作流引擎。** 可选 ready-set adapter 只消费 `coreLoop.stageDagPacket` 已经选好的精确节点，用 LangGraph Functional API 的 `entrypoint` 和 `task` 包裹执行；流程图、checkpoint、lease、恢复和 merge 权威仍在 Meta_Kim。
- **普通安装完全不变。** 默认仍用原生执行；只有显式选择 `--stage-runner-orchestrator langgraph` 才动态加载维护者自己安装的 `@langchain/langgraph`；包缺失或接口不兼容会明确失败，不会静默退回原生路径。
- **真实打包外部消费者验收证明了边界。** 普通候选包没有 LangGraph 依赖，显式选择时会明确失败且不回退原生路径；单独安装 `@langchain/langgraph@1.4.8` 后，A 节点耐久提交时故意结束进程，再启动只执行 B，最终 merge 一次。验收中的确定性 worker 明确标成 test-only，不能冒充原生运行端正证。没有凭证支持的 OpenAI Agents 与 Claude Agent SDK 适配器仍如实标记为未实现、未做 live 证明。
- **Claude Code 的 live 发布验收不再被无关的用户提示词 Hook 改写结构化证据。** 验收器读取真实已安装的运行端 Agent 定义，校验声明身份和边界字段、记录完整文件摘要，再通过 Claude 原生 `--setting-sources "" --agents --agent` 路径绑定紧凑投影。空设置源只排除无关的用户/项目 Hook，不会禁用显式内联 Agent，也不切断宿主管理的登录凭据。用户 Hook 不会被修改，报告也会把这种 inline binding 与普通加载的自定义 Agent 明确区分。
- **MCP Memory 的安装、更新和开机启动现在可恢复且安静。** 安装路径固定为 `mcp-memory-service[sqlite]==11.5.5`，强制使用 ONNX 并禁止 hash embedding。更新先构建并行候选环境、证明联网与开机离线两种真实 ONNX 向量，再取得 endpoint 事务锁；随后只停止 PID、启动身份、可执行文件/launcher、host、port 与 argv 全部匹配的 listener，对已静止的 SQLite 数据库执行 backup 与 `quick_check`，并在候选服务健康且监听进程身份匹配后，才依次更新 MCP 配置、boot 文件和 active 状态。由目标 runtime 验证的绝对数据库路径会同时写进 MCP 配置、live env、全部 boot launcher、active state 和 recovery journal，自定义数据库不会在重启后静默退回默认路径。崩溃恢复先取得同一 endpoint 锁，在 restore 前精确停止旧或候选 writer，遇到未知 listener 则 fail closed。恢复材料只保存 MCP Memory 条目与必要状态，使用私有权限；commit 后立即删除敏感 backup/recovery，失败材料也只按受控命名保守过期。setup 与 boot 共用 owner-aware endpoint mkdir 锁，不再使用名称级广泛杀进程或 GUI 通知。
- **Windows C++ 运行库代际混装时，不再退回 hash 或只给一个模糊的安装失败。** 包安装成功但 ONNX 依赖探针失败时，setup 只允许从本机 Visual Studio 官方 Redist 树中发现完整、同版本的 x64 CRT bundle，把允许列表 DLL 放到候选 ONNX 模块旁并重试一次。非 Windows、文件不完整或混版、符号链接/路径逃逸、缺少官方资产都会 fail closed；setup 不写 System32、不下载任意 DLL，也不借用其他应用私带的运行库。

## [2.9.3] - 2026-07-26

### 解决的问题

Meta_Kim 已能让 Claude Code 和 Codex 执行 Dynamic Workflow 阶段图，但进程中断后仍接近“重新运行原请求”。闪退可能让已完成 worker 再做一次，生成产物也可能与运行状态不一致；原有 checkpoint/replay 字段并不等于可耐久恢复到具体节点。

### 修复内容

- **governed run 现在从 append-only SQLite kernel 恢复。** 每个 run 精确绑定任务与 canonical graph digest，记录哈希事件链、节点 attempt、checkpoint、lease、fencing token、coordinator、fork lineage 和真实 traversed edge。节点完成与边遍历原子提交；事件、投影、checkpoint、claim 或物化摘要被篡改时 fail closed。
- **闪退后只继续没做完的工作。** 正式 runner 把新执行和恢复入口分开；活跃 lease 不能被抢占；只有身份绑定的 staging/final artifact 状态可修复；最终只物化一对 JSON/Markdown，不重跑 worker。子进程强制退出测试证明：A 已完成就保留，只在 lease 到期后继续 B，merge 只执行一次。
- **Claude Code 与 Codex 共用同一耐久接口，但不会多出第二张图。** 两端仍只消费 `coreLoop.stageDagPacket`；bridge 只保存 execution projection，不能重定义阶段、依赖或 merge owner。本版本仍禁止外部副作用；effect reconciliation 只是以后适配器启用副作用前的安全边界，不冒充真实外部 effect 证明。
- **运行端启动和留存证据进一步收紧。** Windows CLI 按 PATH 目录先后选择可用入口；子进程只继承精确列出的登录/配置变量，不再按前缀通配；内置和自定义 worker 输出都会在耐久保存前限长、脱敏。
- **全局更新能收口 Codex App 的路径再生成，但不会接管用户配置。** Codex 生成新的有效内置 marketplace 路径、旁边又留着 Meta_Kim 旧的精确冲突注释时，合并器只删除这条旧受管注释并结束对应 journal ownership；未知、重复、不相邻或用户自写内容仍 fail closed。

### 验证

- durable kernel、runner、bridge、graph、CLI、唯一 PRD、篡改、闪退恢复、artifact 修复、凭证边界和遍历边的针对性测试为 126/126；独立架构、持久化、bridge、安全与最终 Review 均未发现 P1/P2 阻塞。
- 原生 run `p117-2026-07-26T05-36-46-515Z` 四项产品场景全部通过：最终环境边界修复后，Claude Code 与 Codex 各完成一次串行 worker 和一次真实重叠的双 worker fan-out/merge。
- 耐久正式入口 run `p117-governed-2026-07-26T05-39-25-380Z` 在 Codex 与 Claude Code 两端均通过且 `releaseEligible=true`，单独证明了 kernel-backed 执行与物化路径，不拿四场景 bridge 验收替代耐久证据。
- 标准 `meta:verify:all` 在同一次不中断运行中 13/13 全过，覆盖四目标隔离 install/update、packed 用户/项目 install-update、全局 Hook、Graphify、setup、Meta-Theory 1342 项 0 失败、integration 以及 fresh Claude Code/Codex live release fuse。Docker、Cursor 产品执行、合成 provider 输出、任务/token 预算、项目修改和外部副作用均不属于本次验收。

## [2.9.2] - 2026-07-26

### 解决的问题

闪退或 Stop Hook 中断后，Meta_Kim 可能留下大量 `active=true` 的历史 run-status。后续新提示词看起来会继承旧的 Critical 阶段状态；同时 Claude Code 与 Codex 的 Stop Hook 还没有在同一生命周期合同下收口，又不能把两个运行端的 Hook 强行合并成同一份实现。

### 修复内容

- **run continuity 改为 spine 唯一权威，公开 status 只是可修复投影。** 新 run ID 小写且带随机后缀；refresh/Stop 写入必须匹配 expected run；active/status 可以从 spine 修复；强验证的旧记录只迁移一次为 `archived_legacy`，unknown/malformed 原样保留。
- **任务身份不再保存原始提示词。** 状态里只保存项目/profile 本地 HMAC fingerprint；不安全 JSON 边界在首写前拒绝；已有 HMAC-bound run 但 key 丢失/损坏时 fail closed；嵌套 raw prompt 字段会从持久化状态中剥离。
- **Claude Code 与 Codex 保持必要的 Hook 来源分离。** 共享层只放 spine、锁、路径、生命周期和 Codex/Cursor 通用逻辑；Claude Code 保留自己的 Stop 入口和 memory hook 来源。Codex 项目/全局 Stop 现在会保留用户 Hook，先保存 memory，再执行生命周期 cleanup。
- **完整 meta-theory 发布测试获得与大型验证阶段一致的安全余量。** 已通过的 1,269 项测试不会再仅因前序真实运行端检查造成的临时机器负载而被 180 秒门限误杀。
- **Claude Code 与 Codex 保留各自适合的发布探针路径。** Claude 继续直接验证自定义 Agent 绑定；只有 Codex 在 Claude 完成后进入干净子进程，避免前一运行端状态拖慢 Codex 宿主事件发现；双运行时仍由一个发布熔断器统一判定。
- **Codex 宿主事件偶发漏收时会重试，但不复用证据。** 最多两次尝试各自使用全新的隔离子进程和进程树守护；首败保留安全摘要，清理失败立即停止，只有某一次自身的严格 live 证据可以通过。探针保留 Codex 登录信息，但忽略无关的用户 MCP 配置；外壳非零退出时，也只能依据同一新鲜 session 中已经完成的原生派发恢复，不会再丢掉 Codex 实际做完的任务。外层发布阶段的安全超时也覆盖负载下的两次尝试。
- **Windows 探针清理不再依赖 `taskkill` 进程提供器是否健康。** 隔离 Codex evaluator 启动前，Toolhelp32 守护器必须先 ready；正常结束或超时都会清理完整后代树、验证零存活，无法证明清理完成就让发布门失败。
- **本地验收历史很长时，status 仍可正常使用。** 简洁 CLI 与其回归测试可承载完整内部 footprint 数据，不再因为 Node 较小的默认子进程输出缓冲而静默失败。

### 验证

- run-status lifecycle、八阶段 spine、Hook canonical ownership、data integrity、MCP memory hooks、project bootstrap、runtime sync manifest、global hook policy、W2 transaction safety 和唯一 PRD 合同的聚焦测试均通过。
- 真实本地状态先备份再迁移：216 条陈旧 active 历史被归档，303 条已终止记录保留，最后只剩 1 条当前 v2 active。
- 标准 packed `meta:verify:all` 已 13/13 通过，并包含 fresh Claude Code/Codex live evidence 与全局 Hook 检查。Docker、fixture-only、projection-only 没有被当作产品正证。

## [2.9.1] - 2026-07-25

### 解决的问题

Meta_Kim 已经能生成唯一权威的阶段 DAG 和 Dynamic Workflow worker 计划，但默认产物仍停在 `planned_not_executed`：没有原生 worker 真正消费这张图，耗时始终为零，replay/checkpoint 字段也容易被误解成已经执行。只接 Codex 同样不符合 Claude Code + Codex 双主运行端的产品边界。

### 修复内容

- **同一张阶段图现在能在两个主运行端执行真实只读工作。** 显式 `--execute-stage-dag` 路径直接消费 `coreLoop.stageDagPacket`，复用现有 safe-ready-set 调度器处理串行和 fan-out，通过薄适配器调用 Codex 或 Claude Code，最后只做一次确定性的本地合并。运行端不能重定义阶段、依赖、wave 或 merge owner；默认路径仍然只做计划。
- **真实执行证据会在 governed artifact 保存前写入。** worker 记录实际运行端绑定、原生 session/message、开始/结束时间、非零耗时、终态结果、工具次数、输出摘要和失败分类；只有观察到真实结果，才会替换计划 worker、Execution 耗时和 LangGraph-style runtime evidence。Review 仍负责判断结果是否真的满足任务，本版本不声称支持耐久恢复。
- **桥接器适合 Claude Code 与 Codex 的正常安全环境。** 两端都使用无 shell 拼接的只读启动方式，去掉父会话标记，只继承白名单内的系统/运行端/认证变量；副作用任务在启动前拒绝，本机路径默认脱敏，超时只作为失控进程保险。Claude Code 2.1.202 的流式结果只有在同 session 的成功终态记录与最终文本精确一致时才算完成。

### 验证

- 独立宿主 run `p117-2026-07-25T12-37-33-190Z` 四项原生桥接场景全部通过且 `releaseEligible=true`：Codex 与 Claude Code 各完成一个串行 worker 和一个真实区间重叠的双 worker fan-out/merge，并具备精确文件内容、原生 session/message、读取/搜索工具、非零耗时和本地 merge 证据。
- 正式入口 run `p117-governed-2026-07-25T12-39-56-219Z` 同样为 `releaseEligible=true`：`meta:theory:run` 分别通过 Codex 与 Claude Code 完成 package 检查，并在两个保存产物中把计划执行真相替换成真实结果。
- Docker、WSL、任务/token/成本预算、提权、项目写入、外部副作用和合成 provider 输出都不能满足本次产品验收。

## [2.9.0] - 2026-07-25

### 解决的问题

首版 Harness Fitness Lab 已能证明 runner 会如实报告负结果，但简单任务和高风险任务出现质量天花板，无法分别判断核心治理、Review 链和 Evolution 的价值与成本。继续事后收紧隐藏测试，或人为设置任务耗时预算，只会制造失败，不是在测量用户结果。

### 修复内容

- **实验能拆分组件，又不会把天花板任务改造成陷阱。** P-135 新增 `baseline -> slim -> reviewed -> full` 累积梯子，每个任务/组重复 3 次；每题 5 条可见要求与 5 条 held-out 行为检查一一绑定；简单任务改成无预算的 single-flight 并发语义场景。只有所有组都达到相同满分时，才允许用自然 token/耗时差异证明额外成本；成本证据永远不能冒充质量收益。
- **默认治理深度按实测价值收敛。** Critical / Fetch / Thinking 仍是 canonical 顺序与真相边界，但明确、低风险的本地任务只需简洁的内联记录。Review / Meta-Review 按风险、歧义、影响范围、验证失败或声明强度触发。Evolution 能力和 canonical 阶段完整保留，但退出默认执行脚手架；没有持久学习触发条件时，直接内联记录 `none-with-reason`，不再派发 Evolution 工作。
- **Fitness trial 在闪退后可以真正续跑。** provider 身份与结构化 provider 证据分离保存，旧结果可安全推断；正式结果指针不参与不可变合同定义摘要。同一正式 run-id 重启后复用了全部 36 个 trial，没有再次调用 provider。

### 验证

- Windows 原生 Codex 正式矩阵完成 36/36 个 live trial，保留完整 JSONL trajectory 且全部具备产品证据资格；四组均为 9/9、盲评 5/5，因此没有任何治理组件被宣称有质量收益。
- 核心治理相对 baseline 的 token/墙钟成本为 1.201×/1.354×，改为条件启用；Review 相对 slim 为 1.029×/0.971×，同样条件启用；Evolution 相对 reviewed 为 1.525×/1.289×，从默认脚手架移除。
- Docker、WSL、任务预算、提权或绕过 sandbox 均未参与验收；fixture 和被用户叫停在 2/12 的预算实验只保留为诊断，不能计产品证据。

## [2.8.93] - 2026-07-24

### 解决的问题

Meta_Kim 已经有大量治理结构，但此前没有受控实验能证明这些结构是否真的改善任务结果。Windows Codex 试跑还曾把 headless 审批策略覆盖误判成整个平台只读，既阻塞真实产品证据，也容易把 Docker 诊断错当成用户路径验收。

### 修复内容

- **Harness Fitness Lab 开始测量真实结果，而不是 packet 完整度。** Codex 原生 runner 按固定随机顺序执行 3 类任务 × 3 组 × 3 次试验，使用隔离且已有初始提交的工作区、held-out 环境测试、匿名质量评分、完整 JSONL trajectory、token/工具/返工/墙钟指标、不可变可续跑结果，并明确区分诊断证据和产品证据。
- **Windows 原生试验改用 Codex 支持的权限路径。** 独立宿主把 `:workspace`、`on-request` 与原生 auto-reviewer 绑定，只使用一个外部 Git 工作区根，并拒绝嵌套在 Codex Desktop managed session 中运行。Docker、fixture、计划结果、提权和绕过 sandbox 都不能满足产品验收。
- **首轮负结论被如实保留。** 27 次原生试验全部完成：完整治理 9/9，基线与去掉 Review 均为 8/9，成本在 1.5 倍预算内；但只有模糊产品任务显著提升，因此通用 2/3 fitness 门槛仍失败，Review 也没有证明独立收益。下一项是消除基准天花板并做治理瘦身，而不是继续堆框架。

### 验证

- 独立 Windows 原生 pilot 在不使用 Docker、不提权、不绕过 sandbox 的条件下完成真实文件修改、公开测试和 held-out 测试。
- 正式矩阵完成 27/27 个 live Codex trial，并保留 `criteriaPass=false`，没有为了发布而篡改结论。
- 发布前必须通过合同、计划器、provider 参数安全、评分、失败分母、partial pilot、package surface、唯一 PRD、Graphify、投影、setup、Meta-Theory、integration 和 packed release 验证。

## [2.8.92] - 2026-07-24

### 解决的问题

标准发布链此前可能在 smoke evaluator 进程正常退出后报告成功，即使 evaluator 自己的证据已经标明运行时只有 projection、并不具备 release-grade。Claude 发现逻辑还把 Agent View 命令误当成自定义 Agent 定义来源；Codex 则可能仅凭模型生成的 JSON 或超时恢复结果通过 live evaluator，而没有证明真实子 Agent 已完成。最终导致发布声明强于 Claude Code 和 Codex 的底层证据。

### 修复内容

- **标准发布现在只有一道双主运行时保险丝。** release evaluator 固定检查 Claude Code 与 Codex，先验证完整的九个治理 Agent 结构清单，再要求两个主运行时各有一次真实宿主调用成功。smoke、canonical fallback、fixture、模型自述 JSON 和 projection-only 证据仍可诊断，但不能打开发布保险丝。
- **运行时身份只按宿主实际证明的层级报告。** Claude 自定义 Agent 从真实的项目/全局声明中发现，并通过 `claude --agent` 主会话绑定实测；Codex 从 TOML 的 `name` 字段发现定义。当活动 `spawn_agent` schema 没有 `agent_type` 时，完成的 child 会诚实记录为 run-scoped 调用，不会被误报成已经加载某个 custom Agent。
- **Codex CLI 未完整转发事件时，仍能安全验证完成链。** evaluator 优先消费原生 JSONL；如果 Codex 0.144.x 已持久化完成的协作事件、但 `exec --json` 没有转发，则只接受本轮精确且新鲜的 exec thread 及其唯一 child 回链。错误、陈旧、重复、超大小、链接路径或 fixture 证据全部 fail closed；公开报告只保留 ID 与摘要。
- **全局更新在宿主规范化和动态重建后仍保持真实归属。** Claude 只有在解包后的 Windows `cmd` 启动定义精确命中 manifest 指纹时，才允许迁移受管的持久化 MCP；Codex TOML 日志只会折叠宿主恢复后的完全相同重放，或在受管结果不变时重基到最新宿主值。命令被追加参数或目标结果变化时仍然 fail closed。

### 验证

- evaluator、observer、发布链、session 关联、路径安全和隐私聚焦回归 77 个全部通过；独立 P0/P1 Review 未发现发布真相或信息泄漏阻断项。
- 真实双主运行时保险丝通过：Claude Code 与 Codex 均为 `strictReleasePass=true`；Codex 证明了 `spawn_agent -> returned_child_final`，同时保持诚实的 run-scoped 绑定边界。
- 全局 MCP 归属、持久化 bundle 生命周期、Codex TOML 日志与 manifest 聚焦回归全部通过，并完成真实 v2.8.91 到 v2.8.92 的全局同步及同步后检查。
- 正式发布前，最终候选必须继续通过完整 packed-product、四运行时投影/安装、Graphify、setup、Meta-Theory、integration 与双主运行时发布套件。

## [2.8.91] - 2026-07-21

### 解决的问题

2.8.90 已经会在主 setup 和 Graphify CLI 安装器执行后修复 Windows 上的不安全 Graphify 命令，但仍漏了两条真实用户路径：项目复制后的初始化器会独立运行 `graphify hook install`，可能再次生成同样的反斜杠命令；已经出错的旧项目也没有对外可用的迁移命令。因此，手动改好某一个项目的 `.claude/settings.json` 只能修好该项目，不能安全迁移另一个未纳管项目；Meta_Kim 也不应该在没有明确授权范围时扫描并改写磁盘上的任意仓库。

### 修复内容

- **Meta_Kim 负责的每条 Graphify 安装路径都关闭 Windows shell 边界。** post-copy 初始化器会在上游安装命令后立即清理项目 Hook；install/update 刷新也会清理用户明确选择或已有 manifest 纳管的 Claude 项目。未纳管项目保持不动。
- **旧项目现在有公开且范围明确的迁移命令。** 在出错项目目录运行 `meta-kim doctor hooks --fix`。稳定 CLI 默认只处理调用者当前项目；`--project-root <目录>` 可明确选择另一个项目，只有显式加 `--all` 才会包含用户级设置。
- **修复范围窄且可恢复。** 只改写已知的 Windows `graphify.EXE hook-guard read|search` shell 形式；保留 Hook 元数据和含空格的可执行路径；原始 JSON 必须先成功备份，再以原子替换方式写入。其他未知不兼容 Hook 仍然只诊断、不自动改写。
- **全局 Codex 配置在外部漂移后仍可逆恢复。** 如果 active marketplace 键再次出现在 Meta_Kim 以前生成的禁用冲突注释旁边，planner 现在会把相邻重复状态收敛成一条受管注释，并记录可精确反演的 mutation，不会再让全局同步永久停在 partial。

### 验证

- Hook doctor、清理器、公开 CLI、Graphify 接线和运行时聚焦测试 106 个全部通过；完整 setup 测试 415 个全部通过。
- Codex config planner 回归套件 26 个测试全部通过，并用维护者此前失败的真实配置形态完成了精确内存往返。
- packed-product 预检成功执行四运行时安装/更新探针，并用真实 npm 包完成一次安装和连续两次更新。
- 在最初报错的多媒体项目中，新启动的 Claude Code `Read` 探针和 `meta-kim doctor hooks --project-root ... --silent` 都未出现 Hook 错误。

## [2.8.90] - 2026-07-21

### 解决的问题

graphify 上游安装器会把 Windows shell 形式的 hook 命令（`C:\Users\<用户>\...\graphify.EXE hook-guard read`）写进项目 `.claude/settings.json`。Claude Code 在 Windows 上用 Git Bash 跑 shell 形式 hook，反斜杠被当成转义字符吞掉，路径塌成类似 `C:UsersKim...graphify.EXE`，于是每次 `Read`、`Glob`、`Bash` 工具调用都会刷一条 non-blocking 的 `command not found`。Meta_Kim 的 hook 体检已经能把它诊断为 `windows_shell_backslash_path` 不兼容，但只是诊断——安装和更新流程每次还会重新生成那条坏命令，所以在 Windows 上 clone 仓库的人每次全新安装都会撞上同样的报错。

### 修复内容

- **graphify hook 命令在安装时就被修好，而不是只被诊断。** `graphify hook install` 跑完后，setup 流程（`setup.mjs`）和 `meta:graphify:install` / `meta:graphify:update` 流程都会把 Windows shell 形式的 graphify 命令改写成 direct-spawn 的 `command` + `args` 形式（例如 `command: "C:\\...\\graphify.EXE"`，`args: ["hook-guard", "read"]`）。direct-spawn hook 不经过 Bash，可执行文件路径原样保留。修复只在 Windows 生效，幂等，改写前写带时间戳的备份，并且只动 graphify 注入的命令——其他用户 hook 保持原样，等用户自己处理。

### 验证

- 新增 `rewriteHookToDirectSpawn` 单测（在 `doctor-hooks`）覆盖盘符和 UNC 路径改写、安全形式放行（正斜杠、引号包裹、已拆 `args`、裸 `graphify`）、非 graphify 命令保留、非 win32 不处理。
- 新增 `sanitizeGraphifyWindowsHooks` 单测覆盖文件读写往返、非 win32 不处理、幂等、备份生成、文件缺失、非 graphify 保留、权限和同组 hook 保留。
- 完整 `npm run meta:test:setup` 通过，409 个测试，0 失败。

## [2.8.89] - 2026-07-16

### 解决的问题

Meta-Theory 里曾有多个组件同时决定同一条执行路线：入口分类器本应只识别任务，却又决定能不能弹出原生选择、是否允许并行和需要多少条执行线。这些判断可能与规范 Skill、执行选择器和真实宿主不一致，结果是该让用户选择时很少出现交互，而本来可以安全并行的工作又可能被串行化，甚至被一个可选编排 Skill 卡住。另一方面，旧 Claude `PostToolUse:Write` Memory Hook 如果以 CommonJS `.js` 形式落在 `type=module` 项目里，会反复报错；Hook 诊断还可能把无法解析目标路径的外部命令误判成健康或损坏文件。

### 修复内容

- **入口分类器只报告事实，不再拥有执行策略。** 它现在只返回入口路径和可观察信号，不再决定原生选择状态、并行授权、执行线数量或阶段策略。
- **原生选择统一由一个运行时感知策略处理。** 路线、范围、风险、owner 和验收标准发生实质分叉时才进入选择；Claude Code 使用 `AskUserQuestion`，Codex 使用 `request_user_input`。原生弹窗没有回答、返回空值、被拒绝或被宿主吞掉时，会阻断或回到责任阶段，不再偷偷当成同意。
- **核心循环合同成为唯一并行权威。** 八个阶段之间保留有序合并屏障；当前阶段内部所有互不依赖的工作，则在依赖、资源、权限、隔离、有效工作量和宿主容量允许时运行最大安全 ready set。父子路径和未知写入范围会被视为真实冲突，不再制造看似并行、实际可能互相覆盖的执行。
- **原生并行不再依赖 `agent-teams-playbook`。** Claude Agent/Task 或 Codex `spawn_agent` 配合权威阶段 DAG 就足够。该 Skill 只保留为可选适配器，缺少它不会阻断、不会降级，也不能替代真实宿主调用证据。
- **Hook 诊断和旧资产退役更安全。** `doctor-hooks` 支持显式项目根目录，能够识别 ESM 项目中不兼容的 CommonJS `.js` 目标，并把无法解析目标路径的命令标为“未验证”，而不是猜测健康或损坏。自动修复仍只处理能够证明已丢失的僵尸目标；未知或不兼容的用户资产继续保留，等待明确处理。
- **Claude 全局刷新可以保留正在使用的持久 MCP runtime。** 新的显式维护参数可以只刷新全局 Skill、Agents、commands 和安装清单，不替换正在运行的 MCP bundle，也不重写用户 MCP 配置；默认同步行为保持不变。

### 验证

- 原生选择、阶段 DAG、Hook doctor、运行时投影、ownership 和受治理执行的聚焦回归全部通过，覆盖错误原生界面、空回答、路径碰撞、未知写入范围和旧 Hook 等情况。
- Meta-Theory 共运行 1,188 项测试：1,183 通过、0 失败、5 项声明跳过。
- 一次全新的 `npm run meta:verify:all` 完整通过全部 `13/13` 个标准发布级阶段，`releaseGrade=true`，其中包含四运行时安装/更新探针，以及真实 npm 打包后的用户安装、项目安装和重复更新验收。
- 项目和四个运行时的用户级全局 Meta-Theory 投影均已同步，并启用了全局 Hook。Claude 持久 MCP bundle 与注册项已事务式升级到 `2.8.89`，写入前自动备份，过程中没有终止 Claude。可选私有签名 `live-certified` 验证本次未请求。

## [2.8.88] - 2026-07-16

### 解决的问题

跨运行时的 dispatch Hook 仍把普通本地文件与命令工具当成阶段推进器。用户只是让 Meta_Kim 修改业务文件，也可能因为当前处于 Fetch、Thinking 或其他治理阶段而被拦截或警告；严重时连修复状态的命令本身也会被拦住，形成自锁。但这个 Hook 真正需要治理的是 Agent dispatch，而不是普通项目操作。另一方面，Windows 上的 Claude Code 会把 Meta_Kim 持久 MCP 的精确启动命令规范化为等价的 `cmd /c` 形式。全局安装与更新因此把 Meta_Kim 自己的条目误判为“用户未归属冲突”，无法完成 Claude 用户级全局安装。

### 修复内容

- **`enforce-agent-dispatch` 不再按阶段限制普通项目操作。** 本地文件修改和命令执行不再因为 Meta_Kim 当前阶段而被拒绝或警告。Agent dispatch 治理、明确的只读查询承诺，以及由运行时可信注入的 meta-agent 只读边界仍然保留。
- **历史 dispatch 记录不再冒充当前调用者。** dispatch chain 里曾经出现过 meta-agent，不会再把主线程后续业务文件修改误认成 meta-agent 写入，也不会产生假警告。
- **Claude 的精确 Windows MCP 包装形式会被识别为 Meta_Kim 自有条目。** 安装器只接受对预期可执行文件与参数进行精确包装的 `cmd`/`cmd.exe`；额外参数、路径变化、拼接命令、环境漂移和未知相似项仍按用户冲突保护。
- **Claude 全局安装与清理 ownership 保持精确。** 检查和同步会保留等价包装形式，安装清单记录实际注册条目的指纹，后续更新或清理只处理 Meta_Kim 自己的片段，不会认领整份 `.claude.json`。
- **真实打包生命周期覆盖 Claude 规范化行为。** 打包后的全局安装测试会把注册项改写为 Claude 的包装形式，验证检查与同步幂等、清单指纹一致，并证明无关用户配置不受影响。

### 验证

- Hook、阶段运行时、Claude 全局资产和打包运行时生命周期的聚焦回归全部通过，包含未知冲突拒绝、meta-agent 边界和只读查询边界。
- Claude 用户级 Agent、Skill、Hook、settings 注册、commands、持久 MCP bundle 与安装清单已同步；全目标全局发布检查通过。
- 一次不中断的 `npm run meta:verify:all` 完整通过全部 `13/13` 个标准发布级阶段，`releaseGrade=true`；Graphify 新鲜度与差异格式检查也通过。
- 可选的私有签名 `live-certified` 验证未请求，它与标准发布门禁保持独立。

## [2.8.87] - 2026-07-15

### 解决的问题

全局运行时安装、更新和清理仍有几处依赖固定假设：运行时 profile、旧 Agent 路径、安装包位置和上一版本号都可能被写成特定值。这样既会让合法的新运行时 profile 无法接入，也可能留下已经退役的投影，或把“路径看起来合理”误当成“Meta_Kim 确实拥有”。Codex 配置在 ownership 不确定时虽然会安全保留，但还不能记录为精确、可逆的真实差量。打包后的 MCP 运行时也可能返回结构正确的占位资源，却没有证明能力矩阵、Agent 和 Meta-Theory 内容确实来自已安装包。与此同时，setup 与测试子进程可能污染真实用户的能力盘点和项目注册表；打包发布验证仍混用了源码仓库证据与安装后产品事实，并依赖固定的历史版本基线。

### 修复内容

- **运行时投影与迁移改为由来源声明驱动。** 各运行时 profile 自行声明输出路径、renderer 和退役边界；历史 Agent 指纹从 Git 历史生成到规范迁移目录，不再维护固定 Agent 或路径清单。未来 profile 结构不完整时会失败关闭。
- **安装 ownership 精确且可逆。** Manifest 策略会同时绑定类别、来源、运行时、资产类型、用途和路径，全部匹配后才允许清理。Codex `config.toml` 只记录真实发生的 mutation，保留原始注释、换行和字节形态，通过原子 compare-and-swap 落盘，并能在不删除用户其他修改的前提下精确逆向恢复。内容漂移、TOML 歧义、符号链接越界、伪造用途和旧 command-only ownership 都会被保留或阻断，不再靠猜测处理。
- **MCP 运行时事实来自真实安装包。** 全局同步会安装带版本的持久 bundle，并校验精确包身份与目录结构。服务端从该安装包读取并验证完整运行时能力矩阵、规范 Agent 与 Meta-Theory 资源；传输验收会拒绝占位、缺项、重复、空内容和越界资源。运行时启动不再依赖源码仓库、`npx` 或环境 `PATH`。
- **能力发现与本地状态不再跨运行时或测试泄漏。** Claude 与 Codex 通过明确的 runtime-family profile 共享盘点语义，不再因偶然入口文件名发生冲突。定向刷新会保留未选运行时的既有盘点，并发刷新通过文件锁与原子替换发布；Setup 只负责一次最终盘点刷新，子进程测试使用隔离用户目录；新的项目注册表修复命令只清理精确匹配且已经不存在的临时项目记录，并提供 dry-run 与备份保护。
- **全局清理只认声明过的 ownership。** `global_only` 退役、OpenClaw workspace、Memory Hook、持久 MCP bundle、Agent、Skill、Command、Hook 与能力索引统一使用 profile 或契约生成的 allowlist，并采用最具体匹配。未知文件、用户漂移、项目运行时沉淀副本和第三方配置都不会被触碰。
- **发布验证动态证明真实打包产品。** 隔离安装后的 tarball 会执行真实安装、更新、重复更新、项目更新、MCP 和历史升级路径。上一稳定版本从 Git 标签动态选择，不再写死版本号；超时来自发布策略契约；耗时 packed 验收拥有独立测试 lane；缺少历史记录时标准发布验证会失败，只有显式诊断模式可以降级。
- **发布测试实时显示进度且不重复执行 packed CLI。** Node 测试 runner 会直接流式输出子进程进度；快速 setup 与子进程重型分组由 import 关系动态识别，不维护固定文件清单；真实 packed CLI 验收只在发布预检执行，不再在标准 setup 阶段重复。

### 验证

- Codex TOML 规划与逆向恢复、Manifest 与卸载安全、MCP 安装包/资源契约、全局 Agent 迁移、项目注册表隔离、setup 编排及 packed package 边界等聚焦测试已在开发过程中通过。
- 一次完整 `npm run meta:verify:all` 已通过全部 `13/13` 个标准发布级阶段，`releaseGrade=true`、`packedProductProofComplete=true`，源码快照在整轮验证期间保持稳定。Meta-Theory 阶段共运行 1,190 项测试：1,185 通过、0 失败、5 跳过。
- 可选私有签名 `live-certified` 验证本次未请求，继续与标准发布门保持分离。

## [2.8.86] - 2026-07-14

### 解决的问题

过去“安装到全局”和“运行时需要在项目内沉淀能力”被混成了一个生命周期。用户明明选择全局安装，却可能不清楚项目目录为什么仍有运行时文件；后续全局更新又可能漏掉已经受管的项目，或误碰为了当前项目而专门迭代的能力。Agent、Skill、Command、MCP、Hook 和工具的状态也没有稳定区分“发现、选择、请求宿主调用、真实返回、失败、可选外部认证”。此外，Issue #48 暴露了两个真实打包更新缺陷：`npx` 临时包被要求包含仅源码仓库存在的 `.gitignore`，以及用户已经同意安装 MCP Memory 后，这次授权没有限定传给 Claude 设置写入子步骤。

### 修复内容

- **安装范围与项目能力归属彻底分开。** 用户安装或更新时仍可选择全局或项目。全局更新只刷新已经带有合法 Meta_Kim bootstrap manifest 的受管项目，不会凭空创建新项目投影。全局发现且无需修改的能力直接使用；只有当前项目确实需要新建或迭代 Agent、Skill、Command 时，才复制到项目并记录为独立的运行时沉淀，后续全局操作会保护它。
- **受管项目更新同时保证新鲜度和用户内容安全。** manifest 所有的生成投影会先备份再替换为当前包版本；共享配置进行合并；未知文件和项目沉淀能力保持不动。计划、真实写入、旧文件清理和显式冗余清理统一读取同一份 ownership 记录。
- **受治理执行展示真实运行状态，不再靠界面猜测。** 修改前会完成能力发现，并解析 owner、Agent、Skill、Command/工具、MCP、Hook 与验证路径。聊天状态明确区分已选择、已请求、已调用、已返回、失败和外部认证；只有当前 Codex 宿主能力与投影 TOML 同时支持时，才会宣称调用了自定义 Agent。
- **只有实质分支才进入真实方案挑战。** 范围、风险、验收或实现形态真正发生分叉时才触发 Plan Challenge；“我理解了你的要求”和“授权开始执行”保持分离。没有路线分支的普通工作不会被重复确认卡住。
- **Issue #48 的打包更新问题已修复。** 打包安装只验证产品包实际携带的文件，不再要求源码专用 `.gitignore`。用户明确同意 MCP Memory 后，授权只传给本次选中的 Claude 子操作；单独运行 installer 仍保持失败关闭。Claude 和 Codex 的全局设置也改为 staging、同步落盘、原子替换，异常中断不会截断用户 JSON。
- **发布验收改走真实用户路径。** 真实 npm 打包后的 CLI 会覆盖 Claude Code、Codex、Cursor、OpenClaw 的安装和更新，并验证从公开版 `v2.8.85` 更新到 `v2.8.86`，不再只以仓库源码直跑作为产品通过证据。

### 验证

- Issue #48 相关 setup 与 MCP Memory 聚焦测试 `71/71` 通过；全局 Hook/设置策略测试 `19/19` 通过，其中包括 Claude、Codex 原子替换失败注入。
- 打包产品安装/更新验收覆盖四个声明运行时和上一公开版本基线。
- 最终发布树上的标准 `npm run meta:verify:all` 通过，`releaseGrade=true`；可选私有签名 `live-certified` 验证本次未请求。

## [2.8.85] - 2026-07-13

### 解决的问题

通过 `setup.mjs` 更新时，父脚本会把 `--lang` 无差别传给所有子脚本，其中两个严格 CLI 并不支持该参数，导致更新在真正写入前就直接失败。精确参数错误明明已经显示，后续提示却仍猜测 EBUSY、网络或冲突，Codex 等运行时用户甚至会看到 Claude 专属路径和修复命令。标准发布验证又绕过了真实的 setup 父入口，直接调用 installer，因此没有证明父子参数契约真的兼容。

### 修复内容

- **setup 使用显式子脚本 CLI 契约。** 安装、更新与快速部署共用生产参数构造器；支持本地化的子脚本接收用户选择语言，严格的全局 Meta-Theory 同步只接收其支持的参数。未知子脚本契约和旧数组调用会明确失败，不再静默丢失语言。
- **installer 的语言处理完整且失败关闭。** 空格写法与等号写法真实等价，只接受受支持的语言代码和别名，内部能力盘点也继承同一个有效语言。
- **真实父子边界进入回归测试。** setup 的生产构造器会生成快速部署、安装、更新的真实参数并交给 installer 校验；严格全局同步则在隔离运行时目录中真实执行，证明不会收到语言参数，也不会写入用户目录。
- **四语失败提示准确且保留完整帮助。** 英文、简体中文、日文、韩文均以上方第一条精确错误为准；目录占用、网络、权限与冲突建议仅在日志明确出现时适用；恢复命令不再写死 Claude，也不再建议使用通配符删除可能属于用户的目录。
- **用户选择语言贯穿到最终验证。** 运行时同步、能力盘点、依赖安装和项目验证不再在同一次流程中切回宿主语言。

### 验证

- 合并后的 setup、语言、严格参数与 UX 聚焦检查 `109/109` 通过；最后一组语言/验证边界检查 `63/63` 通过。
- 完整 setup 套件 `648/649` 通过、`0` 失败，Windows 上 `1` 条为预期 POSIX 专属跳过。
- 正确性、安全性、UX/测试三个独立复核均已关闭全部 Critical/HIGH；第二轮结果为 `0` Critical、`0` HIGH。
- 一次完整 `npm run meta:verify:all` 通过标准发布门，`releaseGrade=true`；可选私有签名 `live-certified` 验证未请求。

## [2.8.84] - 2026-07-13

### 解决的问题

Meta_Kim 的安装、更新和清理流程仍有几条路径会把“没有被 Git 跟踪”误当成“属于 Meta_Kim”。Hook 删除或改名后可能留下幽灵文件；内容已经正确的受管文件仍可能被重复备份和重写；用户的损坏配置可能被覆盖；部分清理失败或运行时不一致也可能被汇总成成功。并发 setup/cleanup、进程中断、Windows Junction 和 NTFS ADS 还缺少一条统一安全边界。与此同时，长时间发布探针可能看起来像卡住，关键恢复提示也没有始终以用户语言出现在聊天和终端状态中。

### 修复内容

- **受管文件统一进入安全事务生命周期。** 安装、更新、同步和清理现在共同使用精确 manifest + 旧哈希所有权、根目录/Junction 越界检查、冲突预检、已验证备份、staging、原子提交、回滚、receipt 绑定恢复日志、确定性路径和跨进程锁。
- **清理可恢复，并默认保护用户状态。** 删除或改名的旧受管项只有在精确证明所有权后才会退役；内容漂移、未知文件、损坏配置、仅初始化配置和用户自有内容都会保留，并返回可操作的 `partial` 或阻断结果。内容已经正确的受管文件是真正 no-op，不再产生备份、重写和 mtime 抖动。
- **跨运行时检查如实反映结果。** Claude、Codex、Cursor、OpenClaw 的 Hook/配置写入共用安全边界；`global_only` 会验证全部必需 Hook 依赖对；OpenClaw check 检测到不一致时返回非零退出码；setup 同步或备份失败不再被总结为成功。
- **用户提示保持可见并完成多语言统一。** 安装、清理、状态、详情、失败、选择和恢复步骤在英文、简体中文、日文、韩文中保持一致。移除了重复的更新确认，但迁移风险、安全说明和下一步操作仍保留在聊天/终端首要界面，不要求用户翻生成文件。
- **发布证据和 Windows 报告写入更稳定。** 标准验证把四运行时隔离安装/更新探针绑定到稳定源码快照，在长任务开始前显示进度，并在失败时给出恢复动作。受治理运行替换报告文件时，只对 Windows 短暂占用错误执行有限重试，其他错误继续立即失败。
- **大型 setup 安全策略拆成聚焦模块。** 受管文件事务与项目 bootstrap 文件安全逻辑进入独立小模块，不再继续膨胀 `setup.mjs`，也不靠调用点重复堆防护。

### 验证

- 受治理运行界面聚焦测试 `12/12` 通过；完整 Meta-Theory 测试 `1137/1142` 通过、`0` 失败、`5` 条为预期条件跳过。
- 完整 setup 测试 `641/642` 通过、`0` 失败、Windows 上 `1` 条为预期 POSIX 专属跳过；集成测试 `6/6` 通过。
- Claude Code、Codex、Cursor、OpenClaw 项目投影、全局 Meta-Theory 技能/命令及 Claude/Codex 全局 Hook 已同步并检查；Graphify 已重建并通过新鲜度验证。
- 一次完整 `npm run meta:verify:all` 通过全部 `11/11` 标准发布级阶段，`releaseGrade=true`；隔离安装和更新探针分别核验四个运行时产物。可选私有签名 `live-certified` 验证未请求，继续与普通发布门分离。

## [2.8.83] - 2026-07-12

### 解决的问题

Meta-Theory 激活 Hook 曾可能把任意工作目录误当成项目，并在那里生成 `.meta-kim` 或 `graphify-out`。PR 的第一版修复移除了这个不安全兜底，但项目根解析仍分别存在于激活 Hook 与 post-copy 初始化器中，只接受 Claude 专属的显式根目录，而且还没有保证 Claude、Codex、Cursor、全局同步和项目 bootstrap 的每条投影路径都会把解析器依赖与激活器一起安装。维护者入口文档也尚未说明这条新的稳定边界。

### 修复内容

- **项目根解析统一为一份共享实现。** 激活 Hook 和 post-copy 初始化器共同使用 `project-root.mjs`，不再维护两份可能漂移的逻辑。
- **跨运行时兜底顺序安全且明确。** 可信显式声明优先；当前 cwd 已由 marker 证明为项目时优先于 payload；只有绝对路径且有 marker 证明的运行时 payload 才能作为最后兜底。相对 payload 和无 marker 的任意目录都会被拒绝。
- **post-copy 直接接收已确认的项目根。** 激活 Hook 显式传递 `--project-root`，post-copy 不再自行猜测第二个项目位置。
- **所有投影都携带完整依赖。** Claude、Codex、Cursor 项目 Hook、全局 Hook 包、`setup.mjs --project-bootstrap`、包清单与托管文件清理都会让 `project-root.mjs` 和激活器一起安装、一起退役。
- **维护者文档与运行时事实一致。** `AGENTS.md` 与 `CLAUDE.md` 已补充解析优先级、无合法根时不写入，以及共享依赖必须成组投影的规则，没有给普通用户增加额外安装步骤。

### 验证

- 真实子进程测试覆盖任意临时目录、`.git` 与 bootstrap marker、嵌套目录、无效声明、跨运行时 payload 字段、跨仓库重定向、相对路径拒绝、Hook 到 post-copy 参数绑定，以及从实际生成的 Codex Hook 目录启动。
- Claude Code、Codex、OpenClaw、Cursor 的项目与全局投影已同步；Claude/Codex 全局 Hook 包已备份并刷新。
- 一次完整标准发布级验证通过全部 `11/11` 阶段，`releaseGrade=true`；可选的私有签名 `live-certified` 验证仍是独立且本次未请求的保障层。

## [2.8.82] - 2026-07-12

### 解决的问题

Codex 或 Claude 的当前聊天已经真实调用并返回子代理后，Meta_Kim 仍可能因为缺少逐项精确关联或额外独立认证，把用户看到的状态写成“不可用”。用户执行事实、内部审计和可选的外部认证被压成了一个状态；同时，重要进度仍过度依赖生成文件，安装/更新失败、运行标识、宿主观察证据和重复验证链也可能产生含糊或不安全的完成结论。

### 修复内容

- **用户执行事实与内部保障状态正式分离。** 当前原生工具结果直接决定聊天状态；已完成、已调用、部分失败、失败、被拒绝、被阻止、真正不可用和待关联分别表达。缺少精确审计关联不再抹掉已成功的调用，只有宿主不支持或缺少 provider 且没有成功/严格失败 binding 时才显示“不可用”。
- **聊天窗口成为主要的人话运行界面。** 开始、路线、执行、审查、验证、风险、负责人交接和下一步会按用户语言显示。英文、简体中文、日文和韩文报告/面板不再暴露 packet 名、provider id、lane 枚举和认证术语，同时不减少有用提示。
- **可编辑产物不能给自己发合格证。** 调用方 JSON、环境提示、公开 trust 开关、UI badge、fixture 和普通运行文件不能制造“已调用/已完成/独立复核完成”。Codex/Claude 宿主观察、内容寻址候选包、固定信任根和可选私有签名验证继续失败关闭，并与标准发布门保持分离。
- **治理运行与安装流程失败关闭。** Run ID 具备路径安全和并发防碰撞能力，显式覆盖必须授权，latest 指针原子更新，读取结果绑定目标运行。Setup 会汇总部署、MCP、Graphify 与可选步骤失败，部分安装不能再报告成功。
- **路由和验证链更稳定。** 自然语言分类覆盖多语言 UX 请求且不依赖内容品牌；展示消费者只读取用户状态，严格验证器只读取顶层审计包；标准验证链统一由一个编排器负责，不再递归重复阶段。

### 验证

- Claude Code、Codex、OpenClaw、Cursor 的项目与全局 Meta-Theory 投影已同步；Claude/Codex 全局 Hook 已备份并同步。
- Graphify 已重建并通过新鲜度检查。
- 一次完整 `npm run meta:verify:all` 在同一报告中通过全部 `11/11` 标准发布级阶段，`releaseGrade=true`。
- 可选的私有签名 `live-certified` 验证未请求；这不影响标准发布，也不改变当前聊天中真实调用已经发生的事实。

## [2.8.81] - 2026-07-12

### 解决的问题

Meta_Kim 曾把内容业务请求误判为运行时平台治理，并在路由、外部研究判断和项目命名中写入具体内容平台名称。这会让通用治理层因为用户提到某个品牌而走不同路线。与此同时，GoalPro 与 Kim_Decision 虽已作为依赖接入，但缺少清晰的用户侧使用边界。

### 修复内容

- **业务意图与运行时平台治理分开判断。** 只有 Hook、适配器、权限、MCP、安装、配置等技术信号才进入运行时治理；内容和增长任务不再因为提到“平台”而被误路由。
- **移除内容平台品牌路由。** 产品编排、外部研究判断、真实发布风险识别和项目 ID 改为识别第三方服务、最新规则、发布、授权、内容自动化等通用意图，不再依赖品牌名称。
- **Kim_Decision 明确为决策镜头，不是执行器。** 明确的决策请求可在 Critical、Fetch、Thinking 中用于锁定问题、判断证据和选择路径；它不能成为代码执行者、排程器或实现负责人。
- **GoalPro 保持按需、仅提示词边界。** 只有用户明确需要 Goal Prompt、Loop Prompt 或目标契约时才选择；Evolution 不创建用户目标，Loop 只会在已有 Goal 结果后出现。
- **GoalPro 与 Kim_Decision 纳入正式依赖登记。** Provider、依赖、安装、兼容性和路由记录覆盖 Claude Code、Codex、Cursor、OpenClaw，并明确各自边界。

### 验证

- 标准完整发布门禁：`npm run meta:verify:all`。
- 已覆盖新决策路由与通用内容自动化行为的路由、依赖、入口分类、受治理交付物和产品体验验证。

## [2.8.80] - 2026-07-11

### 解决的问题

Meta_Kim 仍在安装和路由外部官方 `skill-creator`，但项目现在已经有维护边界更清楚、验收能力更完整的 `meta-skill-creator`。只替换仓库地址并不够：Claude Code 与 Codex 使用不同的用户 Skill 根目录，Codex 还需要兼容副本；空依赖选择必须保持为空；已有 `skill-creator` 必须继续归用户所有；多目录更新失败时也不能只安装成功一部分。

### 修复

- **Meta Skill Creator 成为正式的 Skill 创建 provider。** 依赖清单、能力索引、路由、基础能力校验和演化指引统一选择 `KimYx0207/meta-skill-creator`，不再把外部官方包作为 Claude Code/Codex 的默认创建能力。
- **按照宿主真实发现目录安装。** Claude Code 安装到 `~/.claude/skills`；Codex 安装到 `~/.agents/skills`，并同步 `~/.codex/skills` 兼容副本；自定义 `CODEX_HOME` 时正式用户目录仍保持正确。
- **三个目标目录使用同一个安装/更新事务。** 新包先完成验证与 staging，再替换 live 目录；中途失败会回滚全部目标，恢复不完整时明确保留备份路径，符号链接/Junction 越界会失败关闭。
- **已有 `skill-creator` 完全不处理。** Meta_Kim 只改变 provider 选择，不删除、迁移或重命名用户副本、兼容副本或 Codex 系统内置 Skill。
- **依赖筛选与 CLI 查询保持安全。** 显式空 `--skills` 不安装任何依赖；帮助和未知参数继续保证零写入。

### 验证

- 安装事务专项测试 `10/10` 通过；路由、provider 和基础能力聚焦套件 `10/10` 通过。
- 上游 commit `ace057d771c1baaa58811a00a2cbbdcad30d8e72` 通过包结构与闭环校验；三份安装副本的 `SKILL.md` SHA-256 均为 `1528407a46fb3f47c035a831e91a8965f8a711f0ad6df458a7f7ef563d46d682`。
- Claude Code 与 Codex 全新只读会话均发现并读取了已安装的 `meta-skill-creator`；用户、兼容和 Codex 系统内置的旧 `skill-creator` 整树哈希保持不变。
- 标准完整发布门 `npm run meta:verify:all` 在更新发布元数据前通过全部 `11/11` 阶段；最终发布检查会重跑版本、包内容和 diff 断言。

## [2.8.79] - 2026-07-11

### 解决的问题

安装、运行状态、Hook、能力发现和发布链长期存在重复实现与危险边界。大规模清理即使通过聚焦测试，仍可能出现 profile 状态分裂、全局同步穿透 Windows Junction、把用户自有同名 Hook 当成 Meta_Kim 文件、`--help` 发生真实写入、恢复的设计测试没有进入标准测试链，以及发布验证无法证明最终包内容等问题。

### 修复

- **运行状态统一为一套防碰撞 profile 契约。** 应用层和 Hook 层复用同一清洗实现；路径穿越、Unicode、同名碰撞和超长输入都会得到稳定隔离的身份，正常 profile 保持兼容。即使使用自定义状态目录或并发写入，spine、active-run 和 run-status 也会解析到同一 profile。
- **全局同步在文件系统和所有权边界上失败关闭。** 帮助和未知参数保证零写入；runtime home 写入拒绝符号链接/Junction 越界；退休 Hook 只有在证明属于 Meta_Kim 后才会先备份再删除，并且只清理对应的受管 settings 项。用户自有同名文件和 settings 不受影响。
- **Hook 只有一个 canonical 实现，同时保留运行时差异。** Claude 兼容适配器投影共享实现；能力索引同时记录 canonical 与 adapter 路径；真正独立的 Claude/OpenClaw 同名 Hook 使用不同 namespace，不再按文件名错误合并。
- **CLI 与 Setup 在任意目录下保持一致。** 包 CLI 从自身安装位置解析脚本；Setup 对 `--参数 值` 和 `--参数=值` 使用同一消费路径；空值和未知参数会在安装动作前失败。
- **数据与报告辅助层完成模块化和事务化。** 项目库存、报告上下文、Memory endpoint、SQLite 事务、Setup policy 和 governed fan-out 共用模块替代重复临时代码，同时保留用户数据和回滚边界。
- **设计 PoC 的保留与退役边界明确。** 四个配置驱动设计模块、合同和 59 个测试继续打包并进入标准测试；无调用的 validator 草稿和过期 RESULTS 报告继续退役。守卫只拦真实可执行消费，不误伤文档和包清单否定断言。
- **标准发布链覆盖所有测试和包边界。** 测试库存明确覆盖 unit、setup、integration、meta-theory 和 design-gate；离线 `npm pack --dry-run` 断言证明必需文件进入包、退役文件不进入包。

### 验证

- correctness、security、completeness 三视角反证审查，覆盖路径穿越、名称碰撞、用户同名 Hook、settings 所有权和 Windows Junction。
- 更新发布元数据前的合并修复聚焦测试：`130/130` 通过。
- `npm run meta:test:inventory`、`npm run meta:test:unit` 与离线包清单断言。
- 发布提交前必须完成四运行时同步、Graphify 重建、`npm run meta:verify:all` 和最终 package/diff 检查。

## [2.8.78] - 2026-07-11

### 解决的问题

治理 runner 仍可能把编排说得比宿主证据更完整：已配置 provider、可调用探针、fixture、普通 shell 调用或 runner 自己生成的结果，都可能被错误升级成真实调用；号称干净的测试也仍可能读到真实用户 Skill、同级依赖仓库或临时状态残留。

### 修复

- **真实编排不能再由测试自己给自己发合格证。** readiness probe、MCP `--self-test`、已配置 provider、命中的 Hook、fixture 字符串、公开 CLI 信任开关，以及 runner 内部生成的 worker 计划，都不再算真实调用证据。
- **调用覆盖改为逐个 binding 验收。** 每个已选中的能力类型、provider 和任务 binding 都必须对应到外部观察到的宿主事件；一条能力类型级证据不能覆盖其他 lane 或 provider。
- **新增 Codex CLI 与 Claude Code 的干净环境宿主观察入口。** 测试使用正式打包快照、隔离的用户目录、运行时目录和临时目录，不读取全局库存或 sibling 仓库；输入是不泄露能力名称和并发暗示的普通业务任务。观察器只能报告实际发生了什么，不能自己把报告升级成可选的最高等级 `live-certified`；只有该认证才要求独立的私有签名与逐 binding 对账器。
- **MCP 新增真实传输层验收。** 新探针会实际完成 `initialize`、`tools/list` 和 `tools/call`；只列工具的 self-test 仍只算 readiness 证据。
- **固定版本依赖的 Windows 归档回退可用。** 干净安装通过 Git commit，或 GitHub 归档的 commit 前缀 + 精确 Skill 哈希验证 agent-teams-playbook v4.8.0；Windows tar 无法处理中文文件名时，改用防路径穿越/链接逃逸的 Python 解包。
- **归档和认证材料处理改为失败关闭。** 依赖归档在解压前限制下载体积，并检查成员路径、类型、数量和展开大小；解压使用隔离 staging。复制的 Codex 认证会先销毁再决定是否保留诊断目录，Windows CLI 提示词也不再经过 `cmd.exe` 展开。
- **发布验证明确拆成不同保障等级。** `meta:verify:all` 是标准完整发布门，完整通过即可进行普通发布；`meta:verify:live-certified` 会重新执行标准链，再追加固定 Ed25519 公钥的外部观察门。只续跑最后一步不能冒充 `live-certified`，调用者不能替换信任公钥，readiness probe 也不再影响逐 binding 的真实调用覆盖。
- **fan-out 提示不再伪造 Fetch 证据。** 普通自然语言中的多范围信号只会标记“可能适合拆分”；必须真实完成能力发现，并由 Thinking 证明 lane 独立，才允许进入执行派发。
- **历史示例不再重复发布个人绝对路径。** 面向读者的更新记录和规划路径 fixture 改用可移植占位符，不再携带具体用户目录和项目目录。

### 验证

- `node --test tests/governance/live-evidence-boundary.test.mjs`
- `node scripts/validate-product-experience-core-goals.mjs`
- `node scripts/live-acceptance/probe-mcp-transport.mjs`
- `node scripts/live-acceptance/run-clean-room-live-acceptance.mjs --preflight`
- 最终聚焦回归：发布/证据 `16/16`、setup/归档 `28/28`、核心编排 `191/191` 全部通过。
- 最终源码上的标准完整 `meta:verify:all`：第 1-8 阶段通过，已满足普通发布门。单独可选的 `meta:verify:live-certified` 因 `private_attested_exact_binding_report_missing` 尚不可用；因此这个候选版本不能宣称 `live-certified`，但缺少外部签名不阻止标准打标签和发布。
- 去掉并发暗示后的本机诊断对照组：纯只读对照没有调用 Agent、Skill、MCP 或已选项目 Command，因此今后不再拿该对照组冒充 fan-out 验收。这只是诊断观察，不是 `live-certified` 签名证据。
- 本机治理运行诊断观察到 Claude Code 使用了 Agent、Skill、Hook 和 runtime tool。MCP 可调用但本次路线未选择，普通 shell 也没有再冒充项目 Command；在独立观察器逐个签名所选 binding 前，这些事件不能支持可选的 `live-certified` 声明，但它们不是标准发布等级的必需条件。
- 当真实用户的 `~/.agents/skills` 存在时，Codex CLI 干净环境会在宿主启动前直接阻断；当前 CLI 即使隔离 HOME/CODEX_HOME 仍会读取该目录。CLI 证据继续与 Codex Desktop 分开。

## [2.8.77] - 2026-07-10

### 解决的问题

当前 Codex 宿主已经提供顶层原生 `spawn_agent(task_name, fork_turns, message)`。但未发布路线仍在输出已经移除的 typed/namespaced 参数形态，导致本来正确的 owner 复用计划仍可能调用失败或显示成错误的宿主路线。迁移时还必须证明：删除 Codex 专属旧字段不会削弱 Claude Code 独立的原生 Agent/Task 路线。

### 改动

- **Codex 现在只输出新版原生任务计划。** 路由使用顶层 `spawn_agent`，携带清洗后的 `task_name`、受边界约束的 worker `message` 和最小 `fork_turns`，不再输出 typed/namespaced 回退参数。
- **继续复用 owner，但不再假装宿主加载了某个 agent type。** `ownerAgent`、owner 来源、能力装载、lane、合并负责人和可见绑定仍保留在 worker packet/message 中；运行时任务名只表示本次任务实例。
- **阶段链触发和 Hook 状态已经统一，但不会跳过 Thinking。** 结构化 Critical/Fetch/Thinking/Review 入口无需用户再补“并行 Agent”关键词，会先标记为 `fanout_eligible`；只有 Thinking 真正产出 2 个以上互不依赖、同属一个并行组、具备合并负责人和冲突边界的 worker packet 后，才进入 `fan_out_ready`。
- **Claude Code 独立支持保持不变。** Claude Code 继续使用自己的原生 Agent/Task 和 SubagentStart；矩阵回归测试会保护 agent、subagent、custom agent 的 native 声明。
- **`agent-teams-playbook` 不再强制表演回退链。** 已有 Agent/Skill/Tool/Command/MCP provider 一旦匹配就停止搜索；只有真实能力缺口才做外部 Skill 搜索，原生 Agent 成功派发不会因为可选 Skill 未安装而被错标成 fallback。
- **依赖 checkout 解析现在区分运行时。** 本地开发优先使用 sibling 上游仓库，避免旧全局包抢先；Claude Code 扫描 `.claude`/`~/.claude`，Codex 扫描 `.agents`/`~/.codex`。

### 验证

- `node --test tests/meta-theory/01-structural.test.mjs tests/meta-theory/11-eight-stage-spine.test.mjs tests/meta-theory/47-meta-theory-entry-classifier.test.mjs tests/meta-theory/50-parallel-execution-lanes.test.mjs`
- `node --test tests/governance/capability-routing.test.mjs tests/governance/fanout-completion-gate.test.mjs tests/governance/runtime-capability-matrix.test.mjs`
- `npm run meta:route:validate`
- `npm run meta:verify:governance`
- `npm run meta:release:smoke`
- `npm run meta:check:global:release`
- `git diff --check`

## [2.8.76] - 2026-07-06

### 解决的问题

Codex 里仍然会看起来像是在“创建智能体”，更关键的是：当治理 fan-out 请求使用空格串联的能力锚点，或使用中文句号/换行而不是逗号时，路由仍可能塌成过少的 worker lane。这样从可见运行结果上很难相信它真的在复用全局 agent。

### 改动

- **空格串联的能力锚点现在会拆成复用全局 agent 的 lane。** Meta-governed Codex 任务里，平台 adapter、能力账本、路由、上传证据等工作会产出多个 worker packet，不再只落到一个宽泛 worker。
- **自然句子边界也算 lane 边界。** 换行、中英文句号/问号/感叹号都会进入 lane 提取；如果自然分段已经覆盖了某个能力，锚点补拆不会再重复生成额外 lane。
- **回归测试检查 typed 全局 owner 复用。** 新测试断言 Codex fan-out worker 通过 `typed_spawn` 绑定已有发现到的 agent owner，而不是发明临时 owner 或创建持久投影 agent。

### 验证

- `node --test tests/meta-theory/50-parallel-execution-lanes.test.mjs tests/governance/capability-routing.test.mjs`
- `node --test tests/meta-theory/26-core-mvp-acceptance.test.mjs tests/meta-theory/30-capability-gap-complete-product.test.mjs tests/meta-theory/32-meta-theory-four-product-targets.test.mjs`
- `npm run meta:route:validate`
- `npm run meta:release:smoke`

## [2.8.75] - 2026-07-06

### 解决的问题

`2.8.74` 修的是用户明确说“派发 / 并行”时的纠偏，但设计仍然太窄。Meta_Kim / `meta-theory` 触发本身就应该代表“进入治理执行，并在 Thinking 证明可拆、安全时自动 fan-out”。用户不应该在已经进入治理执行后，还要再补一句“派发”、特定结构化链路，或再过一个 native choice panel。

### 改动

- **Meta 触发现在授权 safe fan-out。** 显式 `meta-theory`、`/meta-theory`、`元理论`、自然语言治理执行入口，以及结构化链路变体，在 scope 可拆时都会产生 `meta_theory_trigger_request`，不再等待 native choice surface 才能并行。
- **自动 fan-out 不抢具体业务路由。** 主观 UI 请求仍走 `subjective-ui-design-orchestration` 并保留必要 native choice；Meta 触发只附加 fan-out 元数据，不覆盖更具体的业务路线。
- **Codex route selection 把 Meta 触发当自动 fan-out。** 当 scope 可拆时，route 会产出多个 agent-owned worker packets，并带 typed Codex `spawn_agent` 绑定和 agent-teams fan-out adapter。
- **canonical 文档删掉“普通 meta-theory 不算授权”的错误规则。** Native choice 仍用于会改变路线、范围、风险或验收标准的决策，但不再作为 Meta_Kim 触发后允许安全并行的前置许可。

### 验证

- `node --test tests/meta-theory/47-meta-theory-entry-classifier.test.mjs tests/governance/capability-routing.test.mjs` -> 20 个入口分类测试和 capability-routing fixtures 通过。
- `npm run meta:route:validate` -> 通过。
- `npm run meta:sync` -> 项目 runtime 投影 manifest 已刷新。
- `npm run meta:release:smoke` -> 1106 通过，0 失败，5 跳过；integration 通过。

## [2.8.74] - 2026-07-06

### 解决的问题

`2.8.73` 把治理路由和 live subagent 授权分开后，Codex 里仍有一个实际 fan-out 缺陷：用户直接纠正“我要的是派发 / 并行”时，入口分类器虽然识别到了 fan-out 信号，却仍可能把它留在 `fast_path`。即使进入路由，中文里的“规则、runtime、测试缺口”这类可拆范围也可能合并成一个 worker，或者把 lane 绑定到 skill，而不是可复用的 Codex agent owner，结果用户看到的还是协议解释，不是真并行派发。

### 改动

- **直接“派发/并行”现在就是治理执行入口。** “派发”“并行”等中文纠偏会进入标准治理路径，成为 fan-out eligible，并作为 Codex subagent 的直接授权来源。
- **显式 fan-out 优先绑定 agent owner。** 用户要求 agent fan-out 时，每个 worker lane 先绑定可复用的 Codex 全局/项目 agent owner；skill、command、MCP tool、runtime tool 只作为 loadout 或依赖，不替代 lane owner。
- **中文范围能正确拆并行 lane。** route selection 现在把中文逗号、顿号、分号、冒号也当成 lane 分隔符，所以“规则、runtime、测试缺口”能产出多个 worker packets。
- **测试锁住真实派发形状。** 回归测试要求直接并行派发必须产出多个 agent-owned worker packets，且每个 Codex worker 都带 typed `spawn_agent` 绑定，并选择 agent-teams fan-out adapter。

### 验证

- `node --test tests/meta-theory/47-meta-theory-entry-classifier.test.mjs tests/governance/capability-routing.test.mjs` -> 18 个入口分类测试和 capability-routing fixtures 通过。
- `npm run meta:route:validate` -> 通过。
- `npm run meta:sync` -> 项目 runtime 投影 manifest 已刷新。
- `npm run meta:release:smoke` -> 1105 通过，0 失败，5 跳过；integration 通过。

## [2.8.73] - 2026-07-05

### 解决的问题

`meta-theory` 能进入治理 run，也能产出并行 worker lanes，但 Codex 里仍可能由主线程串行执行，因为文档和测试把 `meta-theory` 触发误当成了 live `spawn_agent` 授权。真实 Codex 会话里，这会让“多 agent 编排”只出现在协议文本里，实际没有任何宿主 subagent 调用。

### 改动

- **治理路由和 live subagent 授权分开。** `meta-theory` 只代表进入治理路由和可并行候选；Codex live subagent fan-out 现在必须有明确 subagent / delegation / parallel-agent 措辞，或已经完成命名 parallel-agent route 的 native choice。
- **静默串行兜底会被 gate 抓住。** Codex 已选 `spawn_agent` lane 但 0 个实际 dispatch 时，除非有有效 degraded state，否则 fan-out completion gate 会触发。
- **调用真值新增 `not_authorized` 状态。** capability truth packets、contracts、reports 和产品目标校验现在区分“未授权”“宿主工具不可用”和“被阻断”。
- **Codex command/runtime 文档不再过度承诺 `/meta-theory`。** command adapter 现在明确：`/meta-theory` 授权的是治理路由；live delegation 仍取决于明确授权和可调用宿主工具。

### 验证

- `node --test tests/meta-theory/32-meta-theory-four-product-targets.test.mjs tests/meta-theory/34-run-deliverables.test.mjs tests/governance/fanout-completion-gate.test.mjs tests/meta-theory/47-meta-theory-entry-classifier.test.mjs` -> 48/48 通过。
- `node scripts/validate-product-experience-core-goals.mjs` -> 通过；默认 run 显示 `not_authorized`，trusted self-test 达到 product-experience pass。
- `node scripts/validate-runtime-matrix.mjs` -> 通过。
- `npm run meta:sync -- --targets claude,codex,cursor,openclaw` -> 项目运行时镜像已更新。
- `npm run meta:sync:global:release` 和 `npm run meta:check:global:release` -> Claude Code 和 Codex 全局 skills、hooks、commands 已同步并检查通过。
- `npm run meta:check` -> 通过。
- `npm run meta:release:smoke` -> 1104 通过，0 失败，5 跳过；integration 通过。
- `npm run meta:graphify:check` -> graph matches HEAD。
- `git diff --check` -> 通过。

## [2.8.72] - 2026-07-05

### 解决的问题

Codex 执行派发仍然像是在不断新建 agent，而不是先从全局/项目 agent 清单里找可复用 owner。同时，Meta_Kim 的 observed hook 模式也不该再承担第二套“高风险关键词拦截”：用户明确要求的 Git、删除、GitHub API、安装、发布、release 命令，不应该因为 Meta_Kim 自己的流程 hook 又被挡一次。通用 keyword 风险拦截属于宿主/运行时安全层，Meta_Kim 只应该管自己的流程闸门。

### 改动

- **Codex 派发改为 global-first，并区分 typed spawn。** Codex `/meta-theory` 路由和 runtime reference 现在优先复用已发现的全局/项目 owner；指定类型派发用 `agent_type`，完整上下文 fork 才用 `fork_context`，两者不再混用。
- **执行 owner 兜底更严格。** 能力路由不再拿第一个候选硬顶，而是为 implementation、verification、research、provider、test 等 lane 记录匹配证据后再选 owner。
- **observed hook 不再重复 keyword 安全拦截。** `enforce-agent-dispatch.mjs` 删除 observed 模式下的命令黑名单，也删除 GitHub Git Data API 发布特批支路。observed 模式下，Meta_Kim 不再按命令类别拦截；release 是否真实、rollback 证据是否够、策略是否遵守、公示是否达标，交给 Review 和 Verification 判断。
- **Meta_Kim 流程 gate 仍保留。** managed 阶段 readiness、choice/capability/owner evidence、meta-agent 直接改业务文件、`queryBypass` 写入、已知 unsupported runtime/OS 等仍会拦，因为它们是 Meta_Kim 流程设计本身的问题。

### 验证

- `npm run meta:setup:update` -> 全局更新完成；全局 skills、依赖、MCP memory hooks、能力索引已刷新。
- `npm run meta:sync:global:release` -> Claude Code 和 Codex 全局 skills、commands、hooks 已同步。
- `git fetch --tags origin` -> 全局 hook 同步后成功，确认 Git 不再被 Meta_Kim observed hook 策略阻拦。
- `node --test tests/governance/capability-routing.test.mjs tests/meta-theory/01-structural.test.mjs tests/meta-theory/11-eight-stage-spine.test.mjs` -> 199/199 通过。
- `node scripts/validate-stage-runtime-control.mjs` -> 通过。
- `npm run meta:route:validate` -> 通过。
- `npm run meta:release:smoke` -> 1103 通过，0 失败，5 跳过；integration 通过。
- `npm run meta:graphify:check` -> graph matches HEAD。
- `git diff --check` -> 通过。

## [2.8.71] - 2026-07-05

### 解决的问题

Windows 本地安装和发布级校验时，可能会出现 Node 的 `[DEP0190]` 警告。原因是 setup、全局依赖安装、release verify runner 和 OS probe 里还有子进程路径把 args 数组和 shell 执行混在一起，Node 会把它判为有安全风险的调用方式。同时，Codex 多 agent fan-out 路径还有几个真实使用中的坑：执行路由可能退回到“第一个候选 agent”，Codex `spawn_agent` 可能把 `fork_context: true` 和 `agent_type` 混用，shared `spine-state.mjs` 引入的工具文件也没有投影到所有会用到它的 hook 目录。

### 改动

- **安装和发布命令不再触发 DEP0190。** `setup.mjs`、`scripts/install-global-skills-all-runtimes.mjs`、`scripts/run-verify-all.mjs` 和 `scripts/governance-lib.mjs` 避开 Node 的 `shell: true` + args warning 路径；需要兼容 Windows `.cmd` 的地方改为显式 `cmd.exe /d /s /c` handoff。
- **执行 owner 选择不再随便兜底。** `scripts/select-execution-route.mjs` 现在基于完整 execution-owner 清单和语义偏好组选择 test、verify、provider、research、implementation 等任务 owner；没有合适匹配时返回 `null`，不再拿第一个候选硬顶。
- **Codex fork 规则只留在 Codex 面。** Codex command adapter 和 Codex runtime reference 现在明确：完整上下文 fork 用 `fork_context: true` 且不传 `agent_type`；指定类型派发用 `agent_type` 且不启用完整上下文 fork。结构测试保证这条 Codex 专属规则不会污染 shared、Claude、Cursor 或 OpenClaw 表面。
- **shared spine-state 依赖在投影 hook 中可解析。** `spine-state-utils.mjs` 进入 Codex/Cursor 项目与全局 hook copy 路径，并补上 sync/discovery 测试，和 shared `spine-state.mjs` 的 import 图保持一致。

### 验证

- `node --trace-deprecation setup.mjs --check --silent` -> 无 DEP0190 警告。
- `node --trace-deprecation scripts/install-global-skills-all-runtimes.mjs --dry-run --plugins-only --targets claude` -> 无 DEP0190 警告。
- `NODE_OPTIONS=--trace-deprecation node scripts/run-verify-all.mjs` -> 8/8 阶段通过，无 DEP0190 警告。
- `node scripts/probe-os-compatibility.mjs --check` -> 通过。
- `npm run meta:test:setup` -> 504/504 通过。
- `npm run meta:test:meta-theory` -> 1104 通过，0 失败，5 跳过。
- `npm run meta:route:validate` -> 通过。
- `node --test tests/meta-theory/01-structural.test.mjs` -> 63/63 通过。
- `npm run meta:prompt:validate` -> 通过。
- `git diff --check` -> 通过。

## [2.8.70] - 2026-07-05

### 解决的问题

用户希望 Claude Code 和 Codex 都支持"fan-out / 团队"工作流——主 agent 并行派出多个子 agent——但 Meta_Kim 的触发与派发门让这套流程实际跑不起来。`activate-meta-theory-spine.mjs` 只匹配 `meta-theory` / `critical + fetch + thinking + review` / `元理论`，所以像"开 3 个 agent 扫全量发布差距"这样的请求根本进不了多 agent 路径。进入之后，`enforce-agent-dispatch.mjs` 在 execution / review / meta_review / verification / evolution 阶段对任何 `Agent` / `spawn_agent` 调用都要求 `fetchRecord.capabilitySearchPerformed === true`，而这个 flag 从不自动置位，主线程卡死。`spine-state.mjs` 还直接写 JSON 状态文件，fan-out 多 agent 各自切换同一 run 时存在竞争。整套机制没有为 `team` / `fan-out` / `军团` / `并行` 关键词文档化触发，没有 agent 资格分级，没有原子状态切换，多 agent run 真正发起后也没法自动从 `critical` 推进到 `fetch`。

### 改动

- **多 agent 触发关键词 + 自动能力检索 + 阶段预推进。** `canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs`（及其 `claude` 镜像）现匹配 `team` / `fan-out` / `multi-agent` / `agent teams` / `军团` / `分队` / `并行` / `并发` / `多 agent` / `开 N 个`。命中后自动跑能力检索，读 `config/capability-index/agent-eligibility.json` + `canonical/agents/`，填 `fetchRecord.capabilitySearchPerformed = true` + `capabilityMatches`，把 `currentStage` 从 `critical` 预推进到 `fetch`，并记录 `linkedCommands` / `linkedSkills` / `dispatchMode = "fan_out_ready"`，主线程可立即 fork。
- **fan-out run 的 capability gate 免检。** `canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs`（投影到 `.codex/hooks/` 和 `.cursor/hooks/`）把 `stageRuntimeControl.dispatchMode ∈ {fan_out_ready, fan_out_in_progress}` 当作 discovery 等价阶段，多 agent run 期间的 Agent / `spawn_agent` 派发不再因缺 `capabilitySearchPerformed` 被 deny。
- **三层 agent 资格注册表。** `config/capability-index/agent-eligibility.json` 列出 `eligible`（九个 meta-* agent，含 role + owns[]）、`conditional`、`hard_reject` 三层，带拒绝原因串，能力检索对每个 agent 返回单一裁决而非自由形态 ownerCandidates。
- **原子 spine-state 写入 + 文件锁。** `canonical/runtime-assets/shared/hooks/spine-state-utils.mjs` 提供 `atomicWriteJson`（临时文件 + rename）和 `withFileLock`（`open` + `wx` + 抖动重试）。`spine-state.mjs` 的 `writeSpineState` 套上两者，并发 fan-out agent 不会写坏 run JSON。
- **多 agent 触发时自动 link command + skill。** 被触发的 run 从 prompt 提取 `/slash-command` 名和 `skill:xxx` 引用，填进 `stageRuntimeControl.linkedCommands` / `linkedSkills`，派发板能展示每条 lane 该加载什么。

### 验证

- 所有触及的 canonical 源跑 `node --check` → SYNTAX OK。
- `npm run meta:validate` → 7/7 通过。
- `node --test tests/setup/graphify-wiring-contract.test.mjs tests/setup/sync-runtimes-manifest.test.mjs` → 71/71 通过。
- `npm run meta:check:runtimes` → Claude Code + Codex + Cursor 镜像一致。
- `npm run meta:sync` → `.claude/hooks/` 更新 2 个文件，再镜像到 `.codex/` + `.cursor/`。

## [2.8.69] - 2026-07-05

### 解决的问题

开源用户装好 Meta_Kim 后，去别的项目或别的机器跑 spine hook 时会撞上一条写死的死路径。`setup.mjs` 和 `sync-runtimes.mjs` 在安装时把 canonical 模板里的 `__REPO_ROOT__` 占位符渲染成绝对路径，所以全局和项目 hook 注册里的 `--package-root <绝对路径>` 在用户自己机器上根本不存在。spine 激活脚本又把这个对不上静默吞掉（EXIT=0），`startPostCopyAutoInit` 永远找不到 `scripts/project-post-copy-init.mjs`，全局 post-copy 初始化对除原作者以外的所有人都不可达。

### 改动

- **spine 激活脚本改为运行时解析 package root，不再盲目信任写死的路径。** `canonical/runtime-assets/claude/hooks/activate-meta-theory-spine.mjs` 与 `canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs` 新增 `resolvePackageRoot(candidate)`：若 `--package-root` 参数或 `META_KIM_PACKAGE_ROOT` 环境变量指向的目录确实存在，照用；否则从脚本自身位置（`import.meta.url`）逐层往上找，直到命中含 `scripts/project-post-copy-init.mjs` 的目录；找不到任何 Meta_Kim 根时才回退到 `null`。`.claude/hooks`、`.codex/hooks`、`.cursor/hooks` 镜像和全局 `~/.claude/hooks/meta-kim`、`~/.codex/hooks/meta-kim` 副本现在都带同一个解析器。

### 验证

- 两个 canonical 源 `node --check` → 语法 OK。
- `npm run meta:validate` → 7/7 通过。
- `node --test tests/setup/graphify-wiring-contract.test.mjs tests/setup/sync-runtimes-manifest.test.mjs` → 71/71 通过。
- `npm run meta:check:runtimes` → 工具端镜像已是最新。
- `npm run meta:sync:global:release` → Claude Code 和 Codex 的全局 hook/skill/command 已同步；`~/.claude/hooks/meta-kim/activate-meta-theory-spine.mjs` 与 `~/.codex/hooks/meta-kim/activate-meta-theory-spine.mjs` 均含 `resolvePackageRoot`。

## [2.8.68] - 2026-07-04

### 解决的问题

用户在 Codex 里输入 `/meta` 时，可能会看到好几个看起来都像 Meta_Kim / Meta Theory 的入口。根因不是用户装错了，而是历史版本留下的全局 skill 别名没有被同步器收走：`meta_kim`、旧 report/verify source command、agent-calling-gap 记录，以及 `critical/fetch/thinking/review` 这类路线别名可能同时留在 `~/.agents`、`~/.codex`、`~/.claude`。这样开源用户升级后也会和维护者一样困惑，不知道应该选哪个入口。另一个发布阻塞点是 Graphify：源码改动后 `npm run meta:graphify:rebuild` 可能因为“新图节点数更少”被 Graphify 拒绝覆盖，导致 `meta:graphify:check` 一直报旧 HEAD。

### 改动

- **全局同步器会安全清理旧 Meta_Kim skill 别名。** `scripts/sync-global-meta-theory.mjs` 现在按内容签名识别历史别名，先备份到 `.meta-kim/backups/stale-skill-aliases`，再删除确认属于 Meta_Kim 管理的旧入口；用户自己创建的同名 skill 会保留。
- **Codex 的共享 skill 根目录也纳入清理。** 选择 Codex 目标时，同步器会检查旧的 `~/.agents/skills`，并在 canonical `~/.codex/skills/meta-theory` 存在时清掉共享目录里的旧 `meta-theory` 重复镜像。
- **Graphify rebuild 能从 smaller-graph guard 自动恢复。** `scripts/graphify-cli.mjs rebuild` 现在识别 Graphify 特定的 `Refusing to overwrite` 保护，自动用 `--force` 重跑并把图谱 stamp 到当前 HEAD；同时支持 `META_KIM_GRAPHIFY_BIN` 和 `META_KIM_GRAPHIFY_BIN_ARGS`，方便测试和诊断固定使用哪个 Graphify 可执行入口。
- **能力发现脚本支持短语言参数。** `discover-global-capabilities.mjs` 现在识别 `--zh`、`--en`、`--ja`、`--ko`，和已有测试及 CLI 预期对齐。

### 验证

- `npm run meta:graphify:rebuild` 从 smaller graph guard 自动恢复，并 stamp 到当前 HEAD。
- `npm run meta:graphify:check` → rebuild 后图谱匹配当前 HEAD。
- `node --test tests/setup/graphify-wiring-contract.test.mjs tests/setup/sync-global-hooks-policy.test.mjs` → 41/41 pass。
- `npm run meta:release:smoke` → 1108 tests，1103 pass，0 fail，5 skipped；integration 6/6 pass。
- `git diff --check` → pass。

## [2.8.67] - 2026-07-04

### 解决的问题

`npm run meta:check` 对 `projectProjectionMode: global_only` 的项目会在第一步静默放过——`meta:check:runtimes` 默认什么 target 都不传,直接拿到一个"工具端镜像已是最新"的绿灯,其实啥也没对比。这条路径上的项目看上去是健康的,但实际从未走过 `claude` / `codex` 项目投影的对照检查。

### 改动

- **`meta:check:runtimes` 默认显式选 target。** `package.json` 里这条 script 现在固定传 `--scope project --targets claude,codex`。对 global_only 项目,跑 `npm run meta:check` 会真的去对比两边镜像,silent skip 不再发生。

### 验证

- `npm run meta:check` 退出码 0,7/7 通过
- `npm run meta:graphify:check` 报 `graphify graph matches HEAD a6dc5734`(rebuild 后)
- `npm run meta:doctor:governance` 报 `run index ready`(rebuild 后)

## [2.8.66] - 2026-07-04

### 解决的问题

开源用户跑 `meta-kim` 时没法判断运行时投影其实是否健康。`meta:check:runtimes` 即便没选 runtime target 也返回"工具端镜像已是最新"——`global_only` 项目静默跳过、没警告,看起来像同步过实际没动。另一条线,每个 `weapon-registry.json` owner 都是 governance 层(`meta-*`),但 `select-execution-route.mjs` 从 `candidateExecutionAgents` 显式过滤掉 `layer === "meta"` 的 owner,导致每个武器的 `ownerCandidates` 都落空、所有 6 条 route 都被 block——`fuzzy_strategy` 任务明明对着正确的 governance owner,却吐出 `capabilityGapPacket`。第三类更隐蔽:v2.8.61 的 i18n 抽离重构把所有本地化字符串搬进了 `config/i18n/setup-strings.mjs`,而三个 setup 测试(`i18n` / `mcp-memory-hooks` / `setup-update-default-flow`)还在用 `readFileSync("setup.mjs")` 断言中/日/韩字面量——字符串搬走了,测试没跟,28 条 setup 测试一直报"i18n 覆盖 stale",但从 v2.8.61 重构起就一直是齐的。

### 改动

- **`sync-runtimes.mjs` 不再在没东西查的时候撒谎。** `check` 分支现在能区分两种情况:一是 `global_only` 没选 runtime target,二是选了 target 且都已最新。无 `--targets` 且 `projectProjectionMode: global_only` 时,脚本显式打"未选定 runtime target — 未检查任何镜像",并提示用 `--targets claude,codex`,不再发绿色的"最新"让人误以为真做了事。
- **`select-execution-route.mjs` 让 governance owner 接 governance 武器,但不让它当实现工人。** `routeForWeapon` 的 available 集合在 taskShape 不是 `engineering_execution` 时,把 `ownerDiscoveryPacket.candidateExistingExecutionOwners` 与 `governanceStageOwners` 取并集。`engineering_execution` 分支保持原来的执行层过滤不变,所以 `meta-*` agent 能满足 `meta-kim-decision-patterns` / `runtime-capability-matrix` 这类武器的 routing,但仍然被拦着不当 implementation worker。
- **`build-capability-inventory.mjs` 不再把全局 inventory 压缩成只发 meta。** `global-capabilities.json` 缓存现在会把全局插件装的所有 agent 都发出来,不只是 `meta-*`;每条记录的 `ownerCandidates` 是该 agent 真正的 id(不再对非 meta fallback 成 `["meta-artisan"]`)。`selectExecutionOwner` 改成对 available owner id 做关键词模糊匹配,所以 global_only 项目里 "test" / "smoke" / "verify" 这种任务能落到 `test-automator` / `e2e-runner` 这种真实 agent 上,不再落到空的 available 集上。
- **setup 测试跟上 i18n 抽离。** `tests/setup/i18n.test.mjs`、`tests/setup/mcp-memory-hooks.test.mjs`、`tests/setup/setup-update-default-flow.test.mjs` 凡是断言本地化字面量,改成从 `config/i18n/setup-strings.mjs`(或 `readRepoFile`)读。`setup.mjs` 通过 `buildI18N({ MIN_NODE_VERSION })` 导出 i18n 块;测试和 v2.8.61 重构后的真实源对齐。
- **`sync-runtimes.mjs` 不再往 stdout 灌 1.7 MB 全量 JSON。** CLI 入口改成输出一行摘要(`capability inventory written: N records (projectProjectionMode=...)`)。用 `spawnSync` 跑脚本的测试(如 `capability-inventory-bus.test.mjs`)不再踩 Node 默认 1 MB `maxBuffer` 的天花板、误报 `result.status = null`。
- **稳定 spine-state 投影,让 hook import 不会断。** 这条工作流早期"统一到 shared"做得太激进——多个 `claude/hooks/*.mjs`(`stop-compaction`、`stop-spine-cleanup`、`enforce-agent-dispatch` 等)`import "./spine-state.mjs"` 是相对路径。`canonical/runtime-assets/claude/hooks/spine-state.mjs` 与 `shared/hooks/spine-state.mjs` 两边都保留(字节级一致),`activate-meta-theory-spine.mjs` 与 `skip-reminder.mjs` 同理。`PROJECT_CLAUDE_HOOK_FILES` 保留 `spine-state`,通用循环仍会写出 Claude 端副本;codex 端副本只走 codex 专属块。`import "./spine-state.mjs"` 的 hook 都能 resolve。

### 验证

- `npm run meta:verify:all` → 1108 测试,1103 pass,0 fail,5 skipped。8 步全绿。
- `npm run meta:check:runtimes -- --scope project --targets claude,codex` → "工具端镜像已是最新"。
- `npm install @inquirer/prompts`(env 刷新)+ `npm run meta:test:setup` → 502/0。
- 手动 `node scripts/select-execution-route.mjs --task "<fuzzy strategy>"` → 出 `recommendedRoute`,worker 选到 `meta-kim-decision-patterns`。

## [2.8.65] - 2026-07-03

### 解决的问题

`enforce-agent-dispatch` 的 fan-out 关卡想强制主线程在改文件前先派 Claude Code `Agent`，但关卡跑在 Node hook 里，而真正的派发必须由 host 完成。runner 还一边声明"live subagent 声明必须由 host 外部 spawn"，一边又从不把 worker lane 写进 spine state，结果关卡从不触发，主线程继续自干。每次之前的补丁都是再加一层软约束；根因是这套设计和 host 原生的 fan-out 能力打架。

### 改动

- **从 `enforce-agent-dispatch.mjs` 移除 fan-out 关卡**——host 原生 `Agent` / `spawn_agent` 现在是编排者；hook 不再因为"没派 Agent"而 deny 主线程 mutation。
- **降级声明护栏保留为独立检查**——声明 `degradedMode: true` 的 run 仍需 `fetchRecord.capabilitySearchPerformed` 且至少 3 个 `capabilityMatches`，否则 hook deny。
- **软化 runner 的 `runtimeInvocationBoundary`**——Node runner 只记录证据、建议 lane，不再声称强制 host 派发。
- **Claude / Codex 命令 adapter 从 `DISPATCH IS MANDATORY` 改为 `HOST-NATIVE FAN-OUT PREFERRED`**；Codex adapter 新增建议：worker lane 需要自己的 agent 类型时优先用 named subagent，不用 fork。
- **`validateDegradedDeclaration` 现在从 `shared/hooks/spine-state.mjs` 导出**（之前只在 Claude 副本里），修复了 `runEnforceHook` 下 hook import 失败导致的 44 个测试回归。
- **新增 `tests/governance/degraded-declaration-guard.test.mjs`**（11 个 case），并更新 `tests/meta-theory/01-structural.test.mjs` 匹配新命令措辞。

### 验证

- `npm run meta:release:smoke` → 1108 tests，1103 pass，0 fail，5 skipped。
- `npm run meta:test:governance` → 87/87 pass。

## [2.8.64] - 2026-07-02

### 解决的问题

有三个相互关联的根因，导致"fan-out 不发生"问题在多次发版里反复出现，即使项目早就在更早的 patch 里发过 fan-out 关卡：(1) `enforce-agent-dispatch.mjs` 在 Execution 阶段检测到主线程零 Agent dispatch 自干，却只 `process.stderr.write` 一行 warn 然后放行——就是这个软约束导致"主线程还是会自干"的现象；(2) `scripts/sync-runtimes.mjs` 在 `local.overrides.json` 是 `projectProjectionMode: "global_only"` 时跳过 canonical hook 投影到 runtime 镜像（因为该模式强制 `selectedTargets = []`，per-runtime `syncClaudeProjection` 根本没被调），canonical hook 改动就这么静默地脱同步，必须手动 `cp` 才能追平；(3) `setup.mjs` 让全局 hook 投影在初次安装时是 opt-in（`--with-global-hooks`），所以 `npx meta-kim` 首次安装的人**根本收不到后续发版里加的治理能力**，除非他们显式重跑 setup。三者都是机制层面的独立缺陷，不是文档问题；只修一个，用户可见的症状会再次复发。

### 改动

- **Execution 阶段 fan-out 关卡现在是真 block，不再是 warn**——`enforce-agent-dispatch.mjs` 把长期 warn-only 的路径换成调用 `spine-state.mjs` 里的新纯函数 `evaluateFanoutGate(state)`，再按 `META_KIM_FANOUT_GATE`（block | warn | progressive | off，默认 progressive + 7 天 grace）决策。当 run 是真 fan-out（≥2 worker packets、0 记录的 Agent dispatch、未显式 `degradedMode: true`）时，关卡 deny 下一次 mutation 并报告 `META_KIM_FANOUT_GATE effective mode`；唯一合法的出口是 dispatch Agent 或写 `degradedMode: true` 到 spine state。单 lane run（`workerTaskPackets.length < 2`）豁免，避免 Codex / Cursor / OpenClaw dispatch 事件覆盖差异误伤合法单 owner run。
- **`spine-state.mjs` 新增纯函数 `evaluateFanoutGate(state)`**——返回 `{ triggered, dispatched, workerCount, stage, degraded, reason }`。跨 runtime hook 共享，**不 spawn 完整 PreToolUse hook 就能直接单测**。reason 字段是挂给每次 deny / warn 事件的人话说明。
- **`tests/governance/fanout-completion-gate.test.mjs` 回归覆盖**——6 个 case：triggered（execution + 0 dispatch + ≥2 worker + 未 degraded）、有 Agent dispatch 时不触发、`degradedMode: true` 时不触发、单 lane（<2 worker packets）不触发、非 Execution 阶段不触发、null/缺字段安全（不抛）。
- **修 `meta:sync` 在 `global_only` 下静默跳过 hook 投影的根因**——`scripts/sync-runtimes.mjs` 在主函数加一段（`scope !== "global"` 守卫），把 canonical `claude/hooks/*`（按 `PROJECT_CLAUDE_HOOK_FILES` + shared 依赖 `activate-meta-theory-spine.mjs` + `skip-reminder.mjs` 过滤）无条件投到 `.claude/hooks/`、`.codex/hooks/`、`.cursor/hooks/` 三个镜像。同一段也跑 `REMOVED_PROJECT_CLAUDE_HOOK_FILES` 清理，避免老 hook 在重命名/删除后回流。
- **修 `npx meta-kim` 首次安装静默跳过全局 hook 的根因**——`setup.mjs` 重定义 `setupWithGlobalHooks`：初次安装（`npx meta-kim`、`node setup.mjs` 不带 `--update`）默认装全局 hook；`--update` 仍 opt-in（不覆盖用户改过的 hook）。显式 `--with-global-hooks`（强制开，含 update）和 `--without-global-hooks`（强制关，含初次安装）覆盖两个默认。意思是下游用户升到这个版本能自动拿到 fan-out 关卡，不用额外 flag。
- **`shared/hooks/spine-state.mjs` 也加了同一份 `evaluateFanoutGate`**——test helper `runEnforceHookWithState`（`tests/meta-theory/11-eight-stage-spine.test.mjs`）在临时 cwd 里**先复制** canonical/spine-state.mjs、**再复制** shared/spine-state.mjs 覆盖，hook `import './spine-state.mjs'` 解析到最后写的 shared 版。不在这里加同一函数，test 会在 Execution 阶段第一次 mutation 时 ReferenceError。canonical 和 shared 各保留一份是 test fixture 复制顺序决定的，不删任一份。

### 验证

- `node --test tests/governance/fanout-completion-gate.test.mjs` → 6 pass / 0 fail。
- `npm run meta:test:governance` → 76 pass / 0 fail（无回归）。
- `npm run meta:check` → 7/7 过，含 `meta:open-source-boundary:validate`（canonical-only `package.json` `files` 白名单完整，没有 runtime 镜像或 test fixture 漏进发布集）。
- **`meta:sync` 反向测试**：手动把 `.claude/hooks/enforce-agent-dispatch.mjs` 里的 `evaluateFanoutGate` 块删掉（3 → 2 匹配），跑 `npm run meta:sync`；输出报告"已更新 2 个文件 / 已更新 10 个文件 / 已更新 10 个文件"，镜像恢复到 3 匹配。canonical 没动（diff 干净），`.codex` 和 `.cursor` 镜像也跟着恢复。
- Windows + Node 22.16.0 实机：`npm run meta:setup:check` 和 `npm run meta:setup:update` 都过。`Skipped global hooks (opt in with --with-global-hooks)` 通知在 `setup.mjs --update` 下仍出现（保留的 opt-in 行为）；新默认在下次 `npx meta-kim` 初次安装时生效。
- `npm run meta:release:smoke` → 1108 tests / 1103 pass / 0 fail / 5 skipped（v2.8.63 baseline 一致）。

## [2.8.63] - 2026-06-30

### 解决的问题

8 阶段脊柱的关卡存在 stage key 漂移：`enforce-agent-dispatch.mjs` 本地 stage order 用的是 `meta_review`（下划线），而 `spine-state.mjs` 和 canonical 标签用的是 `meta-review`（连字符），导致 `indexOf` 在 Meta-Review 阶段静默失败。Fetch 阶段也缺少与 Critical 对称的业务文件 mutation deny 分支，导致 `npm install` 和业务文件写入在 `fetchRecord` 提交前不被拦截。另外，SubagentStart hook 对所有 spawn 的 agent 触发（`matcher: "*"`）、MCP-memory 安装脚本未经确认就写用户全局 `~/.claude/settings.json`、缺少一条同步全局 hooks 的命令、新增的 `global-owner-discovery.md` reference 缺少 prompt-executability 校验器要求的标准 section 结构——这些让产品体验测试链路报错。

### 改动

- 将 stage key 统一为 `meta-review`，覆盖 `enforce-agent-dispatch.mjs`、`spine-state.mjs`（claude + shared 源）以及全部 runtime 投影（`.claude` / `.codex` / `.cursor` 加全局 `~/.claude/hooks/meta-kim` 和 `~/.codex/hooks/meta-kim`），让 Meta-Review 关卡在每个平台都正确解析。
- 新增 Fetch 阶段业务 mutation deny 分支，与 Critical 对称：能力发现必须先写 `fetchRecord`，才能进行业务文件写入或包安装。
- 把 Claude 和 Codex 投影的 SubagentStart hook matcher 从 `*` 收窄为 `meta-*`，让上下文注入只针对 meta 治理 subagent。
- 给 `install-mcp-memory-hooks.mjs` 加 `META_KIM_CONFIRM_GLOBAL` 确认关卡，用户全局 `~/.claude/settings.json` 不再在无显式 flag 时被改写。
- 新增 `meta:sync:global:release` npm 脚本（与 `meta:check:global:release` 对称），一条命令同时同步全局 skill + commands + hooks + settings。
- 新增 `canonical/skills/meta-theory/references/global-owner-discovery.md`（完整 12 section 结构），并在 `SKILL.md` 和 `dev-governance.md` 中链接。

## [2.8.62] - 2026-06-29

### 解决的问题

`scripts/discover-global-capabilities.mjs` 导出的 `OUTPUT_I18N` 只有英文和中文两块翻译，但项目其它地方（如 `setup.mjs` 的 `LANG_ARG_ALIASES`）宣传支持 `en / zh / ja / ko` 4 个语言。传 `--lang ja` 或 `--lang ko` 实际静默 fallback 到英文，Skills 家族统计的截断提示在英文和中文下都有对应文案，日文和韩文完全没有翻译。这是 v2.8.60（截断文案）和 v2.8.61（setup i18n 抽取）都没补完的缺口。

### 变更

- **`OUTPUT_I18N` 现在覆盖全部 4 个语言** - 增补日文（`ja-JP`）和韩文（`ko-KR`）两块，包含和英文中文同样的 16 个 key：title、byPlatform、hooksByCategory、skillsByFamily、detailsHidden、noMatchingCapabilities、noMatchingCapabilityType、warnings、more、none、scanning、scanningPlatform、errors、detailedInventory、governanceRules、canonicalIndexWritten、localInventoryWritten、canonicalIndexMirrored、searchIndexWritten。
- **`normalizeOutputLang` 把 ja 和 ko 前缀路由到新块** - `ja*` 映射到 `"ja-JP"`，`ko*` 映射到 `"ko-KR"`；之前两者都 fallback 到英文。
- **截断文案本地化** - 日文 `more` 写 `等、残り {n} 件は篇幅の都合により非表示`；韩文 `more` 写 `등, 나머지 {n}개 항목은 분량상 표시되지 않음`。`{n}` 仍由 `formatCounts` 替换。
- **回归保护** - `tests/meta-theory/52-discover-i18n-truncate-format.test.mjs` 加 2 个 case 守护 (a) 源码里有全部 4 语言块；(b) `normalizeOutputLang` 有 `ja → "ja-JP"` 和 `ko → "ko-KR"` 分支。

### 验证

- 实测：`node scripts/discover-global-capabilities.mjs --lang ja | head -5` 现在显示 `🔍 グローバル能力をスキャン中...` 和 `  Claude Code をスキャン中...`；`--lang ko` 显示对应韩文扫描标题。
- `node --test tests/meta-theory/*.test.mjs` → 1071 pass / 0 fail。
- 其它 suite → 638 pass / 0 fail。
- `npm run meta:doctor:governance` → `All governance doctor checks passed`。

### 关于上一版的说明

v2.8.60 引入了截断文案，v2.8.61 抽取了 setup i18n 块，但两个版本都没补完 `discover-global-capabilities.mjs` 的 4 语言覆盖。v2.8.62 把这个收尾。**不 amend v2.8.61 release**——v2.8.61 的 GitHub release 保持原样可追溯。

## [2.8.61] - 2026-06-29

### 解决的问题

`setup.mjs` 已经长到 9204 行，里面嵌了 2463 行的 4 语言 I18N 字符串对象（4 语言 × 几百个 key）。同一份翻译数据实际上散在两个地方（`scripts/meta-kim-i18n.mjs` 和 `setup.mjs`），脚本文件大部分体积是翻译表而不是流程逻辑。`LANG_ARG_ALIASES` 自称支持 `en / zh / ja / ko`，但实际字符串只在那 2463 行里活着，没有文件级测试守护单一源契约。

### 变更

- **I18N 字符串抽到 `config/i18n/setup-strings.mjs`** - 2463 行 4 语言块独立成文件。函数以 `export function buildI18N({ MIN_NODE_VERSION })` 暴露，原 `(v) => ... 模板字面量` 还能通过闭包引用 `MIN_NODE_VERSION`。
- **`setup.mjs` 改为 import** - 2463 行内联对象换成 `import { buildI18N } from "./config/i18n/setup-strings.mjs"; const I18N = buildI18N({ MIN_NODE_VERSION });`。`setup.mjs` 从 9204 → 6741 行。
- **单一源恢复** - 改翻译现在只需改一个文件。`scripts/meta-kim-i18n.mjs` 继续服务其它脚本；`config/i18n/setup-strings.mjs` 服务 setup.mjs。
- **回归保护** - 新增 `tests/meta-theory/53-setup-i18n-extracted.test.mjs`，守护单一源契约：strings 文件存在 + export `buildI18N`；setup.mjs import 它 + 不再有内联 `const I18N = {`；4 语言块全在；setup.mjs 行数 < 7500。

### 验证

- `node setup.mjs --help` 走新 import + 闭包无语法错误。
- `node --test tests/meta-theory/*.test.mjs` → 1071 pass / 0 fail（53 号加 4 个 case）。
- 其它 suite → 638 pass / 0 fail。
- `npm run meta:doctor:governance` → `All governance doctor checks passed`。

## [2.8.60] - 2026-06-29

### 解决的问题

`meta:deps:install` / `discover-global-capabilities.mjs` 在 Skills 家族统计那行里只显示前 8 个家族，剩下的折成一个简短后缀。英文版本是 `+N more`，中文版本是 `项未显示` —— 两个都容易被误读成「数据缺失」而不是「截断提示」。行为本身不是 bug（缺的家族用 `--verbose` 还能看到），但措辞让它看着像 bug。

### 变更

- **默认可见家族数从 8 提到 20** - `formatCounts(counts, maxItems = 20, ...)` 函数默认值改为 20，两个调用点同步改。
- **截断提示自解释** - 英中文案重写，明示隐藏数和原因。英文：`more, remaining {n} hidden due to length`；中文：`等，剩余 {n} 项因篇幅关系未显示`。`{n}` 占位符由 `formatCounts` 实际替换。
- **回归保护** - 新增 `tests/meta-theory/52-discover-i18n-truncate-format.test.mjs`，守护新文案 + 断言每个平台至少有 10 个可见家族。

### 验证

- 实测：`node scripts/discover-global-capabilities.mjs --zh | grep "Skills 家族统计" -A 4` 输出形如 `Claude Code: vercel 4, agent-browser 1, ..., django-security 1, 等，剩余 56 项因篇幅关系未显示`。
- `node --test tests/meta-theory/*.test.mjs` → 1067 pass / 0 fail（52 号加 3 个 case）。
- 其它 suite → 638 pass / 0 fail。
- `npm run meta:doctor:governance` → `All governance doctor checks passed`。

### 说明

本次只覆盖源码里现有的 2 个语言字符串（en + zh）。其它 locale 继续 fallback 到英文。如果需要加更多语言，下次发版和翻译 review 一起出。

## [2.8.59] - 2026-06-28

### 解决的问题

v2.8.58 只暴露一类 owner（execution agent）。Meta_Kim 实际有 9 类 owner（agent / skill / MCP / command / runtime tool / hook / plugin / memory-graph / dependency），但 lane 解析只在 agent 池里搜，所以想用真 command / MCP / runtime tool 的 lane 会拿到假 agent owner。fan-out orchestrator 也是一维的：≥2 worker 一律走 `agent-teams-playbook`，即使 lane 都是 skill / MCP / command worker（playbook 派不了）。

### 变更

- **owner 解析覆盖全部 9 类** - `findOwnerForLaneTerms` 换成 `resolveProvider({ kind, terms })`，底层是 `PROVIDER_POOL_SOURCES` 类型化 map。lane 按优先级链 `agent → skill → mcp → command → runtimeTool → hook → plugin → memory → dependency` 探测，第一个命中的 kind 即用。
- **lane 带 `ownerKind` 字段** - 每条 parallel-execution lane 都记录 owner 的能力类目，dispatcher 据此选 host 工具（Task / Skill / Bash / apply_patch / MCP call 等）而不是猜。
- **orchestrator-kind 分桶取代单 playbook 闸** - `classifyOrchestratorKinds` 按 ownerKind 把 lane 分组，触发最多 6 类并行 orchestrator：`agentTeamsPlaybook`（≥2 agent lane）、`skillComposition` / `mcpComposition` / `commandSequence` / `runtimeToolSequence`（其它桶达 ≥2）、`mixedParallelism`（多种 kind 同时存在）。dispatchBoard 报告触发的集合，`agent-teams-playbook` 不再被强派去管非 agent lane。
- **workerTaskPacket 透传 `ownerKind` 与 `orchestratorKinds`** - `run-meta-theory-governed-execution.mjs` 把 `ownerKind` 透到每个 workerTaskPacket，host dispatcher 知道每条 lane 用什么工具。
- **回归保护** - `tests/meta-theory/50-parallel-execution-lanes.test.mjs` 改按 `ownerKind` 分桶断言，`tests/meta-theory/51-orchestrator-kind-bucketing.test.mjs` 守护 orchestrator-kind 触发逻辑。

### 验证

- 实测：`node scripts/run-meta-theory-governed-execution.mjs --runtime claude_code "refactor frontend in src/ui, rebuild backend api in src/api, migrate database schema, deploy config ci"` → `orchestratorKinds: ["agentTeamsPlaybook","mixedParallelism"]`，5 个 worker 的 `ownerKind` 分布 `[agent, agent, agent, command, agent]`；`migrate database schema` lane 现在匹配到真 command provider（`package-script:migrate:meta-kim`），不再是假 agent。
- `node --test tests/meta-theory/*.test.mjs` → 1064 pass / 0 fail。
- 其它 suite → 638 pass / 0 fail。
- `npm run meta:doctor:governance` → `All governance doctor checks passed`。

## [2.8.58] - 2026-06-28

### 解决的问题

`/meta-theory` 在工程类任务下从来不会真正把 `agent-teams-playbook` 当成 fan-out 适配器选中，所以多 worker 并行模式实际上从未生效。route 分析总是收敛到单 worker 兜底分支，playbook 永远停在 `not_required`。同时，`workerTaskPacketDrafts` 和上层 sourceTasks 也只消费 `subjectiveUiCapabilityAmplification.lanes`，根本没有给工程任务开第二扇门。另外 `meta:doctor:governance` 在 Windows 上对带 `--runtime` 参数的 hook command 会报假阳性 hook mismatch。

### 变更

- **工程任务也能拆多 lane** - `select-execution-route.mjs` 新增 `buildParallelExecutionLanes`，从 task 文本里临时识别路径、显式 lane 标记、句子分段等独立工作单元，≥2 个就拆。worker 产出和 dispatchBoard 现在也认这条 lane 源。
- **owner 必须来自 runtime-scoped discovery** - 新增 `findOwnerForLaneTerms`，把 lane 描述当查询串，去 `candidateExecutionAgents` 的 `id + description + own + boundary + trigger` 里做关键词匹配；命中才用，不硬编码 `frontend/backend/test/docs`。`compactAgent` 同步补齐 description / own / boundary / trigger 字段，语义匹配才有依据。
- **找不到真 owner 就跳过 lane** - 找不到就不再兜底写假 owner，直接让这条 lane 不进 workerTaskPacketDrafts，由 route gate 自然降级。
- **Doctor normalizeHookName 跨平台正确** - `doctor-governance.mjs` 在 basename 匹配前先剥掉 trailing CLI 参数，再显式去 `.mjs` 后缀，避免 Windows `path.basename(p, ".mjs")` 把后缀漏进比对。

### 验证

- 实测：`node scripts/run-meta-theory-governed-execution.mjs --runtime claude_code --emit-conversation-notice "refactor frontend components in src/ui, rebuild backend api routes in src/api, and migrate database schema."`，playbook 从 `not_required` 变 `pass / selected=是 / waves=1`，peer mesh 从 1 变 4 peers / 10 handoffs，owner 都是 runtime 真 agent（如 `build-error-resolver / ai-engineer-* / api-documenter-* / database-admin-*`）。
- 测试：`node --test tests/meta-theory/*.test.mjs` 1058 pass / 0 fail；其它 suite 638 pass / 0 fail；`npm run meta:doctor:governance` 输出 `All governance doctor checks passed`。
- 回归保护：新增 `tests/meta-theory/50-parallel-execution-lanes.test.mjs` 守护「无假 owner + 多 lane 触发」契约。

## [2.8.57] - 2026-06-25

### 解决的问题

Review follow-up 里真正暴露的风险不是“还缺更多清单”，而是默认路线选择还不够稳：命令目标、runtime 证据、用户本地状态都需要同一个保守规则先发生在 Execution 之前。只要路线关键类型不清楚，Meta_Kim 就应该降级、阻断、返回 `null` 或保持 reference-only，而不是先猜一个路线，再靠 validator 或 hook 事后补洞。

### 变更

- **Type-first route policy** - `select-execution-route` 现在会输出机器可读的 `typeFirstRoutePolicy` 和每轮实际计算的 `routeTypeClassification`，覆盖对象类型、证据类型、归属类型和保守 disposition。
- **不新增 gate 的契约** - Stage runtime control 只把该 policy 作为路线选择不变量引用，明确它不是新的验收门或 hook loop。
- **可执行回归覆盖** - Capability routing validator 和测试现在会检查未知对象、证据、归属类型必须保守降级，而不能靠形状猜。
- **Meta-theory 提示收紧** - canonical meta-theory skill 现在要求 Fetch / Thinking 先分类路线关键类型，再决定是否需要 checklist 或 validator 机制。

### 验证

- `node scripts/select-execution-route.mjs --task "missing dependency task" --runtime codex --os windows --json --compact-json`
- `npm run meta:route:validate`
- `npm run meta:prd:stage-runtime-control:validate`
- `node --test tests/governance/capability-routing.test.mjs`
- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.56] - 2026-06-23

### 解决的问题

这次审计确认还有三类治理运行时风险：观察态 hook 仍可能从全局 hook 目录拦住只读 `node -e` Fetch 检查；runtime projection 的失败分类仍会被人类可读文案里的词影响；Graphify 看不到 Meta_Kim agent 之间的治理边，导致 review 只能看到文件引用，缺少治理关系。

### 变更

- **只读 Node eval 不再误拦** - 只读读取、解析、打印本地文件的 `node -e` 检查现在会被识别为 read-only；写文件、起子进程、网络调用、动态 import 和 eval 类执行仍继续拦截。
- **全局 hook 同步证据** - 修复后的 hook package 已用 `--with-global-hooks` 同步到本机 Claude Code 和 Codex 全局 hook 目录，当前实际运行的 hook 不再沿用旧 read-only whitelist。
- **结构化 runtime 失败原因** - governed runtime projection evidence 现在记录 `failureReasonCode`；失败分类不再从 `native` / `live` 这类文案词里猜。
- **能力数字语义拆开** - repo capability index 现在把 canonical inventory totals 和本机 runtime projection actual counts 分开，避免把 `totalHooks` / `totalCommands` 误读成已挂载 hook/command 数。
- **Graphify 治理边增强** - Graphify rebuild 会补 Meta_Kim agent-governance edges，并给 `file_type` 补 `type` 兼容字段，让 agent 关系和节点类型消费者都可审计。

### 验证

- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `node --test tests/meta-theory/32-meta-theory-four-product-targets.test.mjs`
- `node --test tests/setup/capability-index-inheritance-chain.test.mjs`
- `node --test tests/setup/graphify-wiring-contract.test.mjs`
- `npm run meta:release:smoke`
- `npm run meta:check`
- `npm run meta:graphify:rebuild`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.55] - 2026-06-23

### 解决的问题

观察态发布修复还剩一个文本载荷边缘：用 PowerShell here-string 写 release notes 时，正文里如果出现 `git push` 或 `gh release`，hook 仍可能把 release-note 文本误判成真实 shell 发布命令。

### 变更

- **Here-string 文本安全** - 观察态高风险检测现在会先剥离 PowerShell here-string 正文，再匹配命令动词，release-note 或搜索文本不会再被误认为可执行发布命令。
- **可执行 here-string 继续拦截** - `Invoke-Expression` / `iex` 仍被视为高风险，所以把 here-string 管道给 shell 执行仍会被拦。

### 验证

- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `npm run meta:release:smoke`
- `node scripts/run-verify-all.mjs --no-report`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.54] - 2026-06-23

### 解决的问题

观察态 hook 仍会让维护发布变成“自己锁自己”。用户已经明确要求提交、推送、发布新版本并更新说明时，同一轮 run 里 `git push` 或 GitHub Release 命令仍可能被拦，因为 hook 只看到高风险外部副作用，没有看到用户的发布授权。它还会把 Graphify / 搜索命令里引号包住的 `git push`、`gh release` 搜索词误判成真实发布命令。

### 变更

- **显式观察态发布意图** - prompt 激活时，如果用户 wording 明确包含提交 / 推送 / 发布 / 版本发布，会写入短期的 user-explicit external publish intent。
- **窄发布放行** - 在这个 intent 下，观察态只放行非强推的 `git push` 和 GitHub Release `view/create/edit/upload`；`npm publish`、安装、强推和破坏性命令仍继续拦截。
- **搜索词误伤修复** - read-only 搜索和 Graphify 查询不会再因为引号里的搜索文本提到 `git push` 或 `gh release` 而被当成高风险命令。
- **全局 hook 同步证据** - 修复后的 hook package 已用 `--with-global-hooks` 同步到本机 Claude Code 和 Codex 全局 hook 目录，并用 release 版全局检查确认。

### 验证

- `node --check canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs`
- `node --check canonical/runtime-assets/claude/hooks/activate-meta-theory-spine.mjs`
- `node --check canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs`
- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `npm run meta:prd:stage-runtime-control:validate`
- `npm run meta:sync`
- `node scripts/sync-global-meta-theory.mjs --with-global-hooks`
- `npm run meta:check`
- `npm run meta:check:global:release`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.53] - 2026-06-23

### 解决的问题

Meta_Kim 的 runtime hook 仍可能把设计期阶段表现得像是必须先派 Agent。Fetch 阶段真实业务文件写入被拦是正确的，但拒绝文案会提示维护者去 dispatch Agent；这和当前设定冲突，因为 Critical、Fetch、Thinking 都允许主线程推进。相同 gate 还可能拦住 Claude `/plan` 的计划更新，让计划面动作看起来也像被禁止的业务写入。

这会制造错误修复循环：维护者真正需要补的是 Fetch / Thinking 证据，再进入 Execution；但 hook 暗示下一步必须派 Agent。

本次发布审计还发现几类首跑和维护发布风险：`npx github:...` 可能在依赖安装前就失败；全局安装可能静默改用户 home hook 配置；Codex/Cursor hook runtime 仍依赖路径嗅探；MCP Memory 在 `8000` 端口冲突和 Windows Python shim 场景下诊断不清；`meta:verify:all` 的嵌套命令失败时仍不够好定位。

### 变更

- **首跑 setup fallback** - `setup.mjs` 在 `@inquirer/prompts` 尚未安装时会退回数字菜单，让 GitHub/npx fresh setup 能继续走到依赖安装流程。
- **全局 hooks 显式 opt-in** - 全局通用能力安装不再把 hooks 当成默认全局能力；只有传入 `--with-global-hooks` 时才更新 Claude/Codex/Cursor hook wiring，文档和测试同步锁住这个边界。
- **Hook runtime 显式选择** - 生成的 Claude、Codex、Cursor hook 命令会传入明确 runtime 参数；canonical dispatcher 仍保留 fallback detection，但正常投影不再依赖路径嗅探。
- **Capability gate 可见性** - progressive capability gate 的 hook 输出会暴露 grace-window 状态，setup 也会提示维护者如何选择 `warn`、`block` 或 `off`。
- **MCP Memory 诊断增强** - MCP Memory hooks 和安装路径支持 `MCP_MEMORY_URL` / `META_KIM_MEMORY_PORT`，健康检查失败时提示可能占用端口的进程，并让 Windows Python shim 问题更容易定位。
- **分阶段 verify runner** - `meta:verify:all` 默认改用 staged runner，支持 `--json`、`--from`、报告输出、每阶段耗时和失败续跑；旧单行链保留为 `meta:verify:all:chain`。
- **state 可移植性提示** - `meta:status` 会提示 `.meta-kim/state/` 的 machine-portability 风险，避免把含本机绝对路径的 state 当成可分享项目材料。
- **投影层级文案收紧** - 公开文档现在把 Claude Code 和 Codex 描述为默认投影；OpenClaw 和 Cursor 是兼容投影，需要维护者握手和 native self-test evidence。
- **设计期阶段语义修正** - Critical、Fetch、Thinking 的拒绝文案现在明确说明：业务 mutation 要等 Execution；主线程仍可继续 read/search、capability discovery、planning/control-plane 更新和 spine-state packet 写入。
- **Agent 要求只属于 Execution** - stage runtime control contract 现在记录 Fetch 和 Thinking 进行中不要求 Agent dispatch；execution owner/loadout 与 dispatch evidence 仍保留为 Execution 阶段门。
- **计划控制面放行** - Claude plan-mode surface、task/todo bookkeeping、`.claude/plans/*.md` 和 Meta_Kim planning files 可在 Fetch 阶段、没有 `fetchRecord` 时更新；普通业务文件仍然会被拦。
- **观察态本地发布步骤放行** - 自动触发的观察态现在允许本地 `git add` 和 `git commit` 检查点，也不会因为搜索文本里出现高风险词而误拦；`git push`、包安装、reset 等外部发布或破坏性命令仍继续拦截。
- **Hook 路径字段兼容** - hook 的 file-path 提取支持 camelCase 和 target path 变体，确保 runtime planning surface 按真实目标路径分类。
- **Run-scoped Worker 实机执行回归覆盖** - eight-stage spine、setup、MCP Memory、hook runtime、release docs 和 staged verify 测试覆盖设计期不强制 Agent、planning control-plane 放行、全局 hooks opt-in、显式 runtime 选择，以及业务 mutation 被拦时不得提示用户 dispatch Agent 的精确文案。

### 验证

- `npm run meta:prd:stage-runtime-control:validate`
- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `npm run meta:sync`
- `npm run discover:global`
- `npm run meta:check`
- `npm run meta:check:global`
- `node scripts/run-verify-all.mjs --no-report`
- `git diff --check`

## [2.8.52] - 2026-06-23

### 解决的问题

governed execution 强化合并后，Meta_Kim 还需要一次发布收口，把这批 cleanup 和维护者真实风险对齐：维护者应该能从 main 工作区跑正确的验证链，不再依赖散落命令；MCP runtime server 需要显式声明 SDK 依赖；过期 helper scripts 不应该继续像公开入口一样留在仓库里；普通自然语言模糊验收也不能被误报成 Codex native live proof。

这次发布还需要刷新 canonical capability index，让能力发现描述当前合并后的源码树，而不是上一个 release 的快照。

### 变更

- **分阶段验证 runner** - 新增 `meta:verify:stages`，维护者可以直接在 main 工作区按阶段运行或续跑发布级验证链。
- **MCP runtime 依赖显式化** - 将 `@modelcontextprotocol/sdk` 声明为 package dependency，使 `scripts/mcp/meta-runtime-server.mjs` 在 fresh install 后也能 self-test，不再依赖本机偶然存在的包。
- **governed runner 证据修复** - 加固 `--temp-output` 覆盖和 capability-need 输出，保证 governed-run artifact 能通过验证，同时继续诚实区分 public-ready 与 host-invocation 证据边界。
- **死脚本清理** - 移除已无源码引用的旧 cleanup/reporting scripts，并在脚本文档中写清删除规则，避免过期 CLI 变成意外的公开 API。
- **发布证据刷新** - 基于合并后的 `main` 刷新 canonical capability index、Graphify 图谱、global hooks 和 release checks。

### 验证

- `node scripts/mcp/meta-runtime-server.mjs --self-test`
- `npm run meta:test:meta-theory`
- `npm run meta:release:smoke`
- `npm run meta:verify:all`
- `npm run meta:graphify:check`
- `npm run meta:check:global:release`
- 使用普通中文模糊发布审计请求跑 temp-output governed run；artifact 已验证，spine 到达 Fetch/Thinking/Review/Verification，同时 host evidence 按真实情况保持 `partial`。
- `git diff --check`

## [2.8.51] - 2026-06-22

### 解决的问题

Meta_Kim 在 governed run 进入 Verification 等后置阶段后，仍可能发生自锁。维护者想运行 `git status`、`Get-Content` 这类只读 Fetch 或诊断命令时，会先被 execution-tool hook 送进 choice surface gate；如果当前 state 缺 Fetch evidence 或 Thinking option frame，这些只读命令也会被拒绝。

这会形成治理悖论：运行需要 Fetch 证据才能继续，但 hook 又拦住了收集或修复证据所需的只读命令。

### 变更

- **只读检查先于 choice gate** - dispatch enforcement hook 现在会在 `checkChoiceSurfaceGate` 前放行安全的只读 Bash inspection，恢复取证和状态修复能力，同时不削弱变更控制。
- **变更命令仍然被拦** - 同一条 incomplete-state 路径下，`npm install` 等 mutation 命令仍会被拒绝；本次修复恢复的是 Fetch 访问，不是关闭 capability-first gate。
- **Verification 阶段回归覆盖** - eight-stage spine 测试新增复现：Verification 阶段 choice evidence 不完整时，`git status --short` 可通过，但 mutation 仍拒绝。
- **全局 Hook 刷新** - fixed canonical hook 已同步到全局 Claude Code 和 Codex hook 包，使当前运行时和源码树行为一致。

### 验证

- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `npm run meta:sync`
- `npm run discover:global`
- `node scripts/graphify-cli.mjs rebuild --force`
- `npm run meta:graphify:check`
- `npm run meta:check`
- `node scripts/sync-global-meta-theory.mjs --with-global-hooks`
- `node scripts/sync-global-meta-theory.mjs --check --with-global-hooks`
- `npm run meta:check:global`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.50] - 2026-06-22

### 解决的问题

Meta_Kim 已经有规则、validator 和架构说明，但维护者仍然不容易一眼看清：哪些机制真的跑起来了，哪些只是结构或文档，用户可见证据到哪里为止。这样会带来产品风险：Dynamic Workflow、LangGraph-style 控制、Graphify、MCP Memory、evolution 写回、自动化和开源健康，可能被说成同一层“已完成”。

本次还修清了自动化发布边界。自动化可以帮忙收集证据、减少重复动作，但发布判断、Critical/Fetch/Thinking/Review 质量判断和 public-ready 声明，必须继续由人基于证据作决定。

### 变更

- **产品治理证据分层** - governed execution 现在把自动化辅助、人类决策阶段、自测证据、host/native 证据和产品体验状态分层记录。
- **诚实的产品体验 validator** - 产品体验校验可以在不弹出 native choice 的情况下通过可信自测；但默认 host/native 边界没有 live host 证据时仍保持 `partial`。
- **Dynamic Workflow 与 LangGraph-style 覆盖** - meta-theory 测试覆盖图式 state、nodes、edges、checkpoint/replay、动态 lane 绑定、agent-team packet 解析和 dispatch envelope 证据。
- **Graphify 产品化** - Graphify CLI 更清楚地暴露 query、path、explain、check、rebuild 流程，使图谱成为导航和验证辅助，而不是上下文倾倒。
- **Evolution 写回门** - evolution writeback 现在区分真实写回目标和明确的 `none-with-reason`，避免把临时记录误说成可持续学习闭环。
- **Global hooks 与 MCP Memory 边界** - 全局 hook 同步和 MCP Memory 说明更清楚地区分注册、生命周期 hook、服务健康和本地记忆写入。
- **开源健康** - 新增 GitHub community health 与维护文件，包括贡献、安全、代码归属和依赖更新入口，不要求 GitHub Actions workflow。

### 验证

- 合并前 `npm run meta:verify:all`
- `node scripts/graphify-cli.mjs rebuild --force`
- `npm run meta:graphify:check`
- `node scripts/validate-product-experience-core-goals.mjs`
- `npm run meta:release:smoke`
- Codex App 新对话一句话模糊发布审计
- `npm run meta:capabilities:smoke`
- `npm run meta:test:meta-theory`
- `npm run meta:test:integration`
- `git diff --check`

## [2.8.49] - 2026-06-21

### 解决的问题

当用户级 Codex `config.toml` 在 `[features]` 上方有坏掉的 TOML 数组时，macOS 上的 Codex 可能在 Meta_Kim 启动前就失败。宿主错误会指向 `multi_agent = true`，看起来像这个合法 Codex feature 写错了，但真正的问题是上方数组缺逗号或没有闭合。

Meta_Kim 的全局同步和依赖安装路径也会用行级合并修改 Codex 配置，所以需要在写入前拒绝合并结构不安全的配置，并给出可执行的本地修复提示。

### 变更

- **Codex 配置合并护栏** - Codex config merge 在写入 feature flags、App native controls 或 add-only 依赖配置前，会拒绝未闭合的 TOML 数组或 inline table。
- **人话诊断** - 错误会指出仍处在未闭合 TOML 容器里的行、容器打开的行/列，并展示 `multi_agent = true` 应放在 `[features]` 下。
- **全局检查可见性** - `meta:check:global` 现在会单独报告 Codex `config.toml` 无效，不再只降级成 `default_mode_request_user_input` 缺失。
- **回归覆盖** - Setup 测试复现截图里的 `notify = [` 加 `multi_agent = true` 失败形态，同时保持合法多行 TOML 数组可用。

### 验证

- `node --check scripts/codex-config-merge.mjs`
- `node --check scripts/sync-global-meta-theory.mjs`
- `node --test tests/setup/codex-config-merge.test.mjs`
- 临时 Codex home 执行 `sync-global-meta-theory.mjs --check --targets codex` 坏配置复现
- `npm run meta:test:setup`
- `npm run meta:check`
- `npm run meta:check:global`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.48] - 2026-06-21

### 解决的问题

Graphify 的提示仍可能把 agent 引向大范围读取 `GRAPH_REPORT.md` 或图谱上下文，使大项目上下文过重，也模糊了“图谱导航提示”和“源文件证据”的边界。即使 canonical source 已更新，旧的全局 Codex hook 也可能继续吐出旧版短提示。

全局安装模式在 macOS 上也可能出现假红：`setup.mjs --check` 仍按项目本地投影检查所有 supported runtime，而没有尊重当前 `global_only` 模式和 active targets。

### 变更

- **Graphify Query-First 策略** - meta-theory 现在把 Graphify 视为导航能力，而不是上下文倾倒。聚焦任务应优先用 `graphify query`、`graphify path` 或 `graphify explain` 找候选锚点。
- **源文件验证边界** - Graphify 结果只算候选文件锚点；会改变路线的判断必须回读源文件验证。结果泛、旧、或被生成状态污染时，回退到定向仓库搜索。
- **Hook 上下文瘦身** - Claude subagent 与 Graphify hooks 现在明确禁止把完整 `graph.json`、完整 `GRAPH_REPORT.md` 或大范围 graph dump 注入 worker 上下文。
- **Sync 模板对齐** - Codex runtime sync 和 setup 模板同步使用 query-first 文案，避免项目或全局同步把旧提示刷回来。
- **Global-Only Setup 检查修复** - Setup check/update 路径现在尊重 `projectProjectionMode=global_only`；全局模式跳过项目本地投影校验，项目模式只校验当前选中的 active targets。
- **全局 Hook 刷新** - 使用 `--with-global-hooks` 刷新全局 Claude 与 Codex `meta-kim` hooks，使当前运行时提示与 canonical policy 一致。
- **文档与回归覆盖** - README/CLAUDE 现在说明 Graphify 应通过 query/path/explain 小切片使用，并配合源文件验证；setup 测试会拒绝旧的 compressed-context 文案。

### 验证

- `node --test tests/setup/sync-runtimes-manifest.test.mjs`
- `node --test tests/setup/graphify-wiring-contract.test.mjs`
- `node --test tests/setup/setup-update-default-flow.test.mjs`
- `npm run meta:sync`
- `npm run meta:validate`
- `node scripts/graphify-cli.mjs rebuild --force`
- `npm run meta:graphify:check`
- `npm run discover:global`
- `npm run meta:check`
- `npm run meta:sync:global -- --with-global-hooks`
- `npm run meta:check:global -- --with-global-hooks`
- `npm run meta:release:smoke`
- 当前 Codex 的 `rg` hook probe 已输出新版 query-first/source-verification Graphify 提示。
- `git diff --check`

## [2.8.47] - 2026-06-21

### 解决的问题

在 Codex/Windows 宿主禁止嵌套 Node 子进程时，governed execution CLI 和 smoke 测试会卡住或崩溃，导致真实模糊指令验收看起来像没跑通，即便路线选择器和 Node 测试本身是有效的。

同时，产品体验支撑门仍会把结构性的 native choice 支撑误写成 pass。一次运行可能已经证明了 worker packets 和 selected providers，但仍有风险把 `selected_not_invoked`、CLI 子进程或 markdown/card artifact 误读成真实 host invocation 或 native choice 证据。

### 变更

- **路线选择器宿主 fallback** - 当 `spawnSync(process.execPath, ...)` 被宿主阻止时，governed execution 会退回同进程 route selector；普通不受限宿主仍走原 CLI 路径。
- **Selector 紧凑输出** - 新增 runner-compact selector 模式，避免 governed run 携带过大的路线 payload，同时保留 selected providers、worker lanes 和 owner discovery counts。
- **8 阶段可见进度** - 对话提示和 stage operation plan 现在展示 Critical、Fetch、Thinking、Execution、Review、Meta-Review、Verification、Evolution，不再停在 Review。
- **能力 Smoke 宿主 fallback** - capability-discovery smoke 复用同进程 selector fallback，并诚实报告 spawn 错误，不再写出 undefined output。
- **Node 测试包装器 fallback** - 共享 Node 测试包装器在 child-process 不可用时，对本仓本地脚本提供窄范围 worker-backed fallback。
- **可信 Host Invocation 证据** - governed execution 现在只接受带有真实 family、state、provider 或 surface、合法 evidence kind、非空 evidence ref 的 trusted host evidence；`hostInvocationRequestPacket` 也必须 pass，artifact 才能 pass。
- **Native Choice 证据门** - P-106 不再因为结构性 card 证据默认 pass。Codex/Claude 的分支决策会保持 `needs-host-invocation`，直到附上可信 `request_user_input` / `AskUserQuestion` 证据。
- **禁止伪造 Native Choice 快捷口令** - `select-execution-route` 不再把纯字符串 `completed` / `confirmed` 当成可信 native choice 证明；结构化证据也必须带 native surface 和 evidence ref。
- **Validator 摘要诚实化** - 默认 governed-execution validator 现在拆分 `validationStatus` 与 `governedExecutionStatus`，有效但 partial 的运行不会再被顶层 `status=pass` 混淆。

### 验证

- `node --check scripts/run-meta-theory-governed-execution.mjs scripts/select-execution-route.mjs scripts/run-capability-discovery-smoke.mjs scripts/run-node-tests.mjs scripts/meta-kim-i18n.mjs`
- `node scripts/run-meta-theory-governed-execution.mjs --task "帮我把这个系统弄得更顺、更能自动处理复杂任务，并让我看见它怎么判断、怎么分工、怎么推进、怎么验收。" --run-id codex-goal-fuzzy-acceptance --state-dir .meta-kim/state/codex-goal-fuzzy --db .meta-kim/state/codex-goal-fuzzy/runs.sqlite --emit-conversation-notice --emit-card-dealing-summary`
- `node scripts/validate-run-artifact.mjs .meta-kim/state/codex-goal-fuzzy/codex-goal-fuzzy-acceptance.json`
- `node --test --test-concurrency=1 tests/meta-theory/*.test.mjs`
- `npm run meta:test:integration`
- `node --test tests/meta-theory/32-meta-theory-four-product-targets.test.mjs`
- `node --test tests/governance/core-loop-contract.test.mjs tests/meta-theory/34-run-deliverables.test.mjs tests/governance/capability-routing.test.mjs`
- `npm run meta:prd:default-execution:validate`
- `npm run meta:prd:product-experience:validate`
- 通过 `Start-Process node scripts/run-meta-theory-governed-execution.mjs` 启动干净 host-acceptance 新进程，使用当前 Codex `spawn_agent` 和 `request_user_input` 证据；产物结果为 artifact status `pass`、`hostInvocationRequest=pass`、`realInvocationCoverage=pass`、`nativeChoiceGate=pass`、`productExperience=product_experience_pass`
- `npm run meta:release:smoke`
- `npm run meta:verify:all`
- `node scripts/graphify-cli.mjs rebuild --force`
- `npm run meta:graphify:check`
- `git diff --check`
- 发布边界保持诚实：full verification、validator、graphify check 与干净 host evidence 支撑本次 patch 发布；全 runtime native live proof 仍是单独的 release-grade 目标。

## [2.8.46] - 2026-06-21

### 解决的问题

本次发布修复 Claude Code 会话中断后的续跑边界：当 runtime spine 已经 `session_stop`，后续再说“继续当前 active run”不能再被误读成真的 active governed run。HookPrompt 仍然保持首屏意图增强层，但它的 model-visible context 不再能冒充 Fetch、Thinking、worker、Execution、Verification 或 public-ready 证据。

### 变更

- **HookPrompt 证据边界** - 在 meta-theory skill、抽象能力契约和 runtime safety contract 中明确 HookPrompt 只是 prompt-intake context；它可以澄清意图，但不能推进阶段或满足治理证据。
- **HookPrompt JSONL Transcript 安全** - Stop hooks 现在会只剥离 HookPrompt 展示片段；当 Claude 把前台提示展示写成一行 escaped newline JSONL 时，不会吞掉后面的真实 transcript 内容。
- **Public Readiness 状态拆分** - 将 runtime `surfaceState`（`silent` / `notice` / `decision`）和 Warden 拥有的 `publicReadinessState`（`debug-surface` / `internal-ready` / `public-ready`）分离，避免交互展示状态冒充发布就绪。
- **Dynamic Workflow lane 证据闭环** - Route 选中的 worker lanes 现在直接进入 business-flow blueprint，保留 omitted lanes with reasons，并由 `meta-conductor` 作为编排 synthesis 的 merge owner。
- **Invocation Truth Public-Ready 硬门** - Run artifact validator 现在会拒绝 selected executable capability 只被选中、不可用、被阻断、缺 host evidence，或 top-level packet 与 `coreLoop` 不一致时的 public-ready 声明。
- **LangGraph-style Runtime 边界** - 产品证据现在明确这是 LangGraph-style 结构控制图，不新增也不声称真实 LangGraph runtime dependency。
- **Global-only 能力清单** - Capability discovery 在 `global_only` 投影模式下可读取缓存的全局 runtime inventory，同时继续把项目配置记录保持为 reference-only。
- **Inactive Run 续跑边界** - `active-run.json` 与 status envelope 现在公开 `deactivatedAt`、`deactivationReason` 和 `continuationBoundary`，让 `session_stop` 历史可见，但不会被当成 active managed run。
- **Claude Runtime Session-Stop 修复** - Claude spine activation 会先读取 inactive spine state；当用户要求继续时，创建新的 observed run，并记录前一个已停止 run 的边界，而不是声称旧 run 仍然 active。
- **Continuation 文案识别对齐** - Shared 与 Claude activation hooks 现在识别同一组宽口径续跑说法，例如 `current run`、`same run`、`当前 run`、`同一个 run`。
- **Stop Hook Transcript 过滤** - Stop compaction 和 progress hook 在 transcript 启发式判断前会剥离 HookPrompt 前台展示块，避免提示词优化文本制造假的阶段进度、finding 或续跑 handoff。
- **Stop Cleanup 路径安全** - `stop-spine-cleanup` 删除 completed spine state 前会复用 repo-local state resolver，非法 `META_KIM_SPINE_STATE_DIR` 不能删除 `.meta-kim/state` 之外的文件。
- **Local Continuity 文案降权** - Stop compaction 和 project task state 现在把交接标记为 `local_continuity_only` 并写入 `mustNotClaimActiveRun`，替换容易误导的 “Resume from X stage” 说法。
- **状态 CLI 诚实输出** - `meta-run-status` 对 inactive `session_stop` 会输出 reason 和 continuation boundary，而不是只折叠成一行笼统 inactive。
- **发布元数据对齐** - 将包元数据提升到 `2.8.46`，确保 source tree、tag 和 GitHub Release 指向同一版本。

### 验证

- `node --check canonical/runtime-assets/claude/hooks/stop-compaction.mjs canonical/runtime-assets/claude/hooks/stop-save-progress.mjs canonical/runtime-assets/claude/hooks/activate-meta-theory-spine.mjs canonical/runtime-assets/claude/hooks/spine-state.mjs canonical/runtime-assets/shared/hooks/spine-state.mjs scripts/meta-run-status.mjs`
- `node --test tests/meta-theory/20-run-status-envelope.test.mjs`
- `node --test tests/meta-theory/09-run-artifact-validator.test.mjs`
- `node --test tests/meta-theory/32-meta-theory-four-product-targets.test.mjs`
- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `node --test tests/governance/runtime-safety-contract.test.mjs`
- `node --test tests/governance/capability-inventory-bus.test.mjs`
- `node --test tests/setup/mcp-memory-hooks.test.mjs`
- `npm run meta:release:smoke`
- `npm run meta:verify:all`
- Public-ready 边界保持诚实：HookPrompt prompt-intake context 不是 runtime invocation、Verification 或 release-grade all-runtime live evidence。

## [2.8.45] - 2026-06-20

### 解决的问题

本次发布补上 Meta_Kim 的 Dynamic Workflow / LangGraph-style governed execution 声明与用户可检查证据之间的断层。默认发布面现在记录最新的 hook 自锁修复，确保私有项目 manual 不进入开源 source 集合，并附带一份 full-pass governed execution artifact，用来证明能力发现、worker fan-out、host invocation truth 与 Verification 已经跑通；同时不把它越级说成 release-grade live all-runtime ready。

### 变更

- **Dynamic Workflow 证据闭环** - 复测 `<temp>/meta-kim-host-full/artifacts/goalpro-codex-host-full-proof.json`，确认其中包含 `fetchPacket`、`capabilityInventory`、`capabilityRoute`、`dynamicWorkflowRuntimePacket`、`langGraphRunPacket`、`workerTaskPackets`、`workerResultPackets` 与 `verificationPacket`。
- **Host Invocation Truth** - 确认真实 Codex host 证据覆盖 `spawn_agent_result`、`agent_team_result` 与 `skill_application`，并有 MCP、command/script、runtime-tool 三类 fresh local probes；artifact 中 `realInvocationCoverage.missingFamilies` 为空。
- **Hook 自锁修复** - Fetch 阶段 dispatch gate 现在可以受限修复自己的 `fetchRecord` 状态，同时在能力发现和 execution clearance 前仍然阻止业务文件写入。
- **开源 Source 边界** - 从公开 source 树移除私有 manual 文档，并让 README 引用保持在受支持的公开文档面上。
- **发布元数据对齐** - 将包元数据提升到 `2.8.45`，确保 source tree、tag 和 GitHub Release 指向同一版本。

### 验证

- `npm run meta:validate:run -- <temp>/meta-kim-host-full/artifacts/goalpro-codex-host-full-proof.json`
- `npm run meta:test:meta-theory`
- `npm run meta:release:smoke`
- `git diff --check`
- Public-ready 边界保持诚实：`publicReadyDecision.publicReady = false`，因为本次没有附带 release-grade live all-runtime evidence。

## [2.8.44] - 2026-06-19

### 解决的问题

本次发布补上 canonical 源、全局 hook 包和项目 runtime 投影之间的安装/更新断层。新用户和已有项目现在会拿到一致的 governed `meta-theory` 行为；可复用的全局资产不会被误复制进项目镜像；源仓库自检也不会再把预期为空的生成目录误报成安装镜像过期。

### 变更

- **Canonical Runtime Source Projection** - `meta-theory` runtime smoke 检查在项目镜像尚未生成时会回退检查 canonical 源资产；但如果 runtime 镜像已经 materialized 且内容坏掉，仍然会判为不完整。
- **全局 Hook 依赖闭环** - Claude 全局 hook 脚本现在从打包后的 `hooks/meta-kim/` 目录解析 shared helper，不再导入缺失的项目本地 shared 路径。
- **Fetch 自锁维修路径** - Fetch 阶段的 hook enforcement 现在允许受限的 repair-only `fetchRecord` 写入 `spine-state.json`；但在完成真实能力发现和执行放行前，业务文件写入仍会被拦住。
- **安装与更新范围对齐** - setup/update 路径保持全局安装只写全局、项目 bootstrap 只从 canonical 源生成项目镜像，并取消对 Meta_Kim 源仓库的特殊处理。
- **11 阶段用户可见性** - governed run 报告在 runtime verification 仍然 blocked 时，会把用户可见 business phase 保持在 feedback / acceptance 等待点，同时保留 blocker 证据。
- **产品交付包 Bootstrap** - product delivery bundle 生成现在让 governed run 和 deliverable generation 共用同一个 run id 与 state dir，修复 clean smoke 中找不到 governed run 的失败。
- **一等 Memory 能力发现** - canonical memory hooks 现在会作为稳定的 `memory` provider 进入默认 capability inventory；干净 state 下的 governed run 不再依赖已有本地状态文件来证明 memory 能力覆盖。
- **源仓库健康检查口径** - runtime health 检查区分源仓库自检和用户安装态镜像，避免对空生成目录输出误导性的 stale-mirror 文案。

### 验证

- `npm run meta:verify:all`
- `npm run meta:release:smoke`
- `npm run meta:prd:smooth-capability:validate`
- `npm run meta:prd:stage-runtime-control:validate`
- `node --test tests/meta-theory/11-eight-stage-spine.test.mjs`
- `node --test tests/meta-theory/32-meta-theory-four-product-targets.test.mjs`
- `node --test tests/meta-theory/43-product-delivery-bundle.test.mjs`
- `node --test tests/meta-theory/49-business-phase-visibility.test.mjs`
- 隔离 setup/hooks worker：`130 pass / 0 fail`
- runtime health worker：`meta:public-assets:validate`、`meta:check:runtimes`、hook sync tests、stale projection simulation
- `git diff --check`

## [2.8.43] - 2026-06-19

### 解决的问题

本次发布解决的是 governed run 看似已经在 hook context 或生成报告里完成，但用户仍然看不到清晰进度、没有原生选择证据、也没有真实能力路线的问题。同时收紧 setup/update 清理路径，让旧安装留下的项目级 Meta_Kim 残留可以被安全移除，而不会删掉用户自己的文件。

### 变更

- **用户可见治理进度** - 新增 host-visible notice contract 和 runtime 指南，要求 Codex 与 Claude Code 在普通 assistant chat 中显示 run start、route、blocker、closure 等关键进度；原生选择面板只用于会改变路线的决策。
- **自动能力发现** - 扩展 route selection：自然语言 durable work 会先扫描项目/runtime/全局 skills、commands、MCP providers、hooks、scripts、runtime tools，再由 Thinking 绑定 owner；不再要求用户先说出 agent、skill 或协议阶段。
- **原生选择证据门** - 对主观质量或路线会变化的任务，跟踪 Codex `request_user_input` 与 Claude `AskUserQuestion` 证据后才允许执行；结构化报告不能再冒充真实原生选择。
- **项目清理与 Bootstrap 安全** - 新增 setup cleanup 路径，用于清理冗余 Meta_Kim 项目资产；`AGENTS.md` / `CLAUDE.md` 改为 managed block 合并；补齐 Codex `.agents/skills` 项目投影覆盖，并增加保护未知本地 skill 与 git-tracked 文件的回归测试。
- **全局 Hook 与记忆对齐** - 保持 HookPrompt 在 Meta_Kim spine hook 之前运行，新增 Codex 全局 HookPrompt adapter 同步；doctor 检查接受健康的 Claude 全局 hook；MCP memory 检查能识别 `hooks/meta-kim/` 下的 hook。

### 验证

- `npm run meta:verify:all`
- `npm run meta:release:smoke`
- `npm run meta:check`
- `npm run meta:doctor:governance`
- `npm run meta:check:global:release`
- `node --test tests/setup/claude-settings-merge.test.mjs tests/setup/lazy-project-bootstrap.test.mjs tests/setup/doctor-governance.test.mjs tests/setup/mcp-memory-hooks.test.mjs`
- `node scripts/validate-capability-routing.mjs`
- `git diff --check`

## [2.8.42] - 2026-06-18

### 解决的问题

本次发布解决的是全局可复用安装和项目本地生成状态被混在一起的问题。现在可以端到端验证全局 `meta-theory` 安装，而不把通用 Codex skill 复制进每个项目；项目缓存和 Graphify 输出仍然只落在当前项目。

### 变更

- **Codex 全局 Hook 注册** - 全局同步现在会把 Meta_Kim hook 脚本复制到 `~/.codex/hooks/meta-kim/`，并把 prompt-entry spine hook 合并进 `~/.codex/hooks.json`，带 package-root 证据；用户自己的 hook 会保留，只替换 Meta_Kim 管理项。
- **项目缓存验证** - 新增 `npm run meta:project-cache:verify`，并支持 `--real-global`，用于证明全局 hook 会在当前项目生成 `.meta-kim/state/default/post-copy-init.json`、`graphify-out/graph.json`、`graphify-out/GRAPH_REPORT.md`，且不会复制 `.agents/skills/meta-theory/`。
- **安装范围矩阵** - 扩展安装范围验证，覆盖全局默认、全局全正式目标、项目默认、项目全正式目标，并证明预期文件存在、非预期写入不存在。
- **正式投影口径** - README 现在把 OpenClaw 和 Cursor 说明为非默认但正式投影，不再放进兼容层；候选 probe 仍然保持分层。

### 验证

- `node scripts/sync-global-meta-theory.mjs --check --targets claude,codex,cursor,openclaw --with-global-hooks`
- `npm run meta:project-cache:verify -- --real-global`
- `npm run meta:project-cache:verify`
- `npm run meta:install-scope:verify`
- `node --test tests/setup/sync-global-hooks-policy.test.mjs tests/setup/install-scope-matrix.test.mjs`
- `node scripts/validate-runtime-safety-contract.mjs`
- `git diff --check`

## [2.8.41] - 2026-06-16

### 解决的问题

本次解决的是“Meta_Kim 选中了能力”与“宿主真的调用了能力”之间看不见的断层。现在用户能看到 Claude Code 或 Codex 还需要执行什么动作、什么证据才算数，以及长期 Agent 为什么必须等宿主 reload 并真实调用后才算完成。

### 变更

- **宿主调用请求契约** - 新增 `hostInvocationRequestPacket`；当 Agent、Skill、MCP、command/script、runtime tool、`agent-teams-playbook` 被选中但还没有 live 调用证据时，会明确列出 Claude Code 或 Codex 宿主下一步必须执行的动作，不再把缺失调用藏在 partial 报告里。
- **可信证据边界** - 收紧 governed execution：host request、CLI/env claim、markdown report、app 可见 badge 都不能当执行证明；只有 trusted host adapter 返回带 state、provider/surface、evidence kind、evidence ref 的新鲜证据才能计入通过。
- **长期 Agent 生命周期证明** - 新增 `durableAgentLifecyclePacket`；长期智能体必须经过 definition candidate、Warden approval/writeback、host reload/discovery、live invocation proof 四关，才能宣称完成。
- **Runtime Adapter 指南** - 更新 Claude Code 和 Codex runtime reference，区分 runner handoff、真实宿主 provider 调用、长期项目 agent 发现机制，为后续 adapter 实现留出清晰接口。
- **产品证据贯通** - 扩展 run report、product delivery bundle、validators 和 support gates，使宿主调用请求和长期 agent 生命周期状态进入产品验收证据链。

### 验证

- `node --test tests/governance/core-loop-contract.test.mjs tests/meta-theory/32-meta-theory-four-product-targets.test.mjs tests/meta-theory/34-run-deliverables.test.mjs tests/meta-theory/43-product-delivery-bundle.test.mjs`
- `npm run meta:test:meta-theory`
- `npm run meta:check`
- `git diff --check`

## [2.8.40] - 2026-06-16

### 解决的问题

本次解决的是全局 Meta_Kim 已更新，但打开的项目仍发现不了新治理入口的问题。Prompt 入口现在会说明为什么启动治理，并在写入任何项目文件前先探测项目就绪状态。

### 变更

- **Prompt 入口治理激活** - Claude Code 和 Codex 的项目级 prompt 入口现在会运行 meta-theory spine hook；自然语言 durable work 和 `critical/fetch/thinking/review` 说法可以在执行前触发治理，不再只依赖显式 Skill 激活。
- **Claude 全局项目就绪检测** - Claude Code 全局 hooks 现在会安装 prompt-entry bootstrap hook package，并带 package-root 证据；旧项目或未 bootstrap 项目会先收到精简的项目就绪原因，再决定是否应用项目文件。
- **项目 Bootstrap 安全边界** - Project bootstrap 仍然坚持 dry-run first 和确认门；stale 或 equivalent 项目只显示 `status`、active targets、reason 和 native choice 要求，不会静默写入。
- **Spine 死锁解除** - 即使 Fetch 正在等待 `fetchRecord`，spine-state 写入也会放行，避免 prompt-entry 实机测试后维护者无法写入 Fetch 证据或关闭运行态。
- **全局能力证据刷新** - 安装新的 hook package 后刷新全局能力发现；库存现在能看到 Meta_Kim 全局 prompt-entry hook，以及 agents、skills、commands、MCP servers/tools、plugins 和 runtime hooks。

### 验证

- `node --test tests/setup/graphify-wiring-contract.test.mjs tests/meta-theory/11-eight-stage-spine.test.mjs tests/setup/sync-runtimes-manifest.test.mjs tests/setup/sync-global-hooks-policy.test.mjs tests/meta-theory/47-meta-theory-entry-classifier.test.mjs tests/governance/capability-routing.test.mjs`
- `node --check canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs`
- `node --check canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs`
- `npm run meta:sync`
- `npm run meta:sync:global -- --with-global-hooks`
- `npm run discover:global`
- 在 `<project-root>/game-design` 中执行 Claude Code 全局 `UserPromptSubmit` 实机 smoke
- 在 `<project-root>/Meta_Kim` 中执行 Codex 项目 `UserPromptSubmit` 实机 smoke

## [2.8.39] - 2026-06-16

### 解决的问题

本次解决的是“发牌写在契约里，但用户看不到也证明不了它触发”的问题。发牌决策现在有评分、证据、反事实检查和精简的用户可见理由。

### 变更

- **发牌准确性标准** - 将 `cardPlanPacket` 升级到 v0.2；每张牌都必须记录 deal/suppress/defer/skip/interrupt/escalate 决策，并带 80 分标准、量化信号、证据引用和反证检查。
- **用户可见发牌原因** - 在 run-start 和报告里新增精简说明：为什么触发发牌、多少张牌进入节奏控制、最低分是否通过。
- **契约化发牌证明** - 将 `dealStandard` 设为 `cardPlanPacket` 必填字段，对齐生成的 card shell/source/silence/control decision，并刷新 validator fixtures。
- **Deep Research 风格发牌审查** - 每张牌的判断都绑定决策影响和反事实检查；不需要的牌会带证据 suppress，不再只是模糊 defer。
- **全局发现就绪** - 已把更新后的 meta-theory skill 同步到项目和全局 runtime home，并刷新 Claude Code、Codex、OpenClaw、Cursor 的全局能力库存。

### 验证

- `node --test tests/meta-theory/14-card-deck-complete.test.mjs tests/meta-theory/34-run-deliverables.test.mjs tests/meta-theory/12-ten-step-workflow.test.mjs tests/meta-theory/07-contract-compliance.test.mjs`
- `node scripts/run-meta-theory-governed-execution.mjs --task "帮我做个小红书营销自动发布器" --run-id card-proof --emit-conversation-notice`
- `npm run meta:check`
- `npm run meta:test:meta-theory`
- `npm run discover:global`
- `npm run meta:sync:global`
- `npm run meta:check:global`
- `npm run meta:release:smoke`

## [2.8.38] - 2026-06-16

### 解决的问题

本次解决的是 11 阶段业务流因为列出阶段名就看似完成的问题。每个阶段现在都要有证据、评分，以及 trigger/skip/block/wait 的明确判断。

### 变更

- **11 阶段触发标准** - 将 `businessPhasePlanPacket` 升级到 v0.2；每个阶段都必须记录 trigger/skip/block/wait 决策、评分、证据引用、量化信号和反证检查，不再因为列出 11 个阶段名就通过。
- **业务流覆盖真实性** - 用契约对齐的 `complete` / `incomplete` 判断和 `coverageDetail` 替换旧的 phase-count-only 字符串，避免把“已记录”和“准确触发”混在一起。
- **精简开场原因** - 新增 run-start 用户可读说明，解释为什么触发 8 阶段 spine 和 11 阶段业务流；说明保持短句，并绑定证据，不倾倒内部 packet。
- **Deep Research 风格阶段证据** - 阶段判断现在绑定关键信号、反事实检查和决策证据；例如 Revision 的准确跳过、Feedback 的外部等待会被明确表示。
- **报告可见性** - 用户可读 meta-theory 报告和 CLI conversation notice 现在会显示触发状态、触发评分和开场原因。

### 验证

- `node --test tests/meta-theory/34-run-deliverables.test.mjs`
- `node --test tests/meta-theory/12-ten-step-workflow.test.mjs tests/meta-theory/09-run-artifact-validator.test.mjs`
- `npm run meta:check`
- `npm run meta:test:meta-theory`
- `npm run discover:global`
- `npm run meta:check:global`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.37] - 2026-06-16

### 解决的问题

本次解决的是 Review、Meta-Review、Evolution 浅层通过的问题。运行现在必须证明证据质量、盲区检查、可复用学习判断和 public-ready 边界，而不是只靠 packet 存在就通过。

### 变更

- **深度 Review 门禁** - Prompt-first live acceptance 现在要求 Review 证明已检查证据质量、反证、决策影响、可证伪性和上游阶段链路，不再只靠 packet 存在就通过。
- **Meta-Review 深度审计** - 新增机械化深度审计：拒绝浅层 packet-only Review，检查对抗覆盖和审查盲区，并把 public-ready 证据与 live/runtime 证据分开。
- **Evolution 策略证据** - Evolution 的 `none-with-reason` 现在必须证明已判断可复用模式、写回目标、scar 需求和下次复用 key。
- **Strict Live Acceptance 回归** - 新增回归覆盖，确保缺失或浅层 Review / Meta-Review / Evolution packet 会失败，而不是被 fallback 数据补成通过。

### 验证

- `node --test tests/governance/prompt-first-live-acceptance.test.mjs`
- `node --test tests/governance/decision-cross-validation.test.mjs tests/governance/prompt-first-live-acceptance.test.mjs`
- `npm run meta:check`
- `npm run meta:test:meta-theory`
- `npm run meta:sync`
- `npm run discover:global`
- `npm run meta:check:global`
- `npm run meta:prd:prompt-first-live:validate`
- `git diff --check`

## [2.8.36] - 2026-06-16

### 解决的问题

本次解决的是还没查已有专业能力就新建或路由到执行 Agent 的问题。Meta_Kim 现在先查全局和项目 provider，把 worker task 限定为单次工作单，并在安装或更新后刷新本地能力库存。

### 变更

- **专业 Provider 优先路由** - 治理路线现在必须先查已有的全局/项目专业 provider，再考虑创建或升级 execution agent；覆盖 agents、skills、commands、MCP providers/tools、runtime tools、hooks、plugins、memory/graph providers 和 dependency providers。
- **WorkerTask 身份边界** - 明确并验证 `workerTaskPacket` 只是绑定到已选 owner/loadout 的单次运行工作单，不是临时小 agent、subagent definition 或长期 provider 身份。
- **全局能力库存自动刷新** - 安装/更新和全局依赖安装/更新流程会在 runtime home 变化后自动刷新本地 global capability inventory，同时仍然不把机器私有库存提交到 GitHub 源码。
- **能力缺口证据** - 新增 `fetch.global_professional_providers_checked` 证据和回归覆盖，要求 `create_agent` 决策先证明已有专业 provider 已经查过且不足。
- **Setup 回归覆盖** - 新增自动刷新全局库存的发布测试，并修正 project deploy 保护式 JSON merge 测试，使其匹配当前“先规划、再写入”的实现结构。

### 验证

- `npm run meta:release:smoke`
- `npm run meta:test:setup`
- `npm run meta:validate`
- `npm run discover:global`
- `npm run meta:gap:real-input-replay`
- `npm run meta:prd:smooth-capability:validate`
- `npm run meta:runtime:validate`
- `npm run meta:graphify:rebuild`
- `git diff --check`

## [2.8.35] - 2026-06-16

### 解决的问题

本次解决的是 deep research 只收集来源、没有真正改善决策的问题。Fetch 现在会锁定关键信息、迭代查询和阅读、记录停止条件，并阻止弱证据或未验证声明进入 Thinking。

### 变更

- **决策级 Deep Research** - 将 Fetch 证据从“收集来源”升级为“锁定关键信息目标、记录多轮 query/read/update、声明停止条件、写入决策更新规则”，再进入 Thinking。
- **Claim Evidence Cards** - 新增 `claimEvidenceCards` 和更严格的 run artifact 校验；会改变路线的 claim 必须绑定可解析 evidence refs、反证记录、置信度、falsification 状态和决策影响。
- **研究执行证据** - 扩展 live research execution packet，记录 query 迭代次数、证据 gap 是否关闭、confidence 前后变化和反证尝试，避免 blocked evidence 被带入 Thinking。
- **Canonical 治理对齐** - 更新 Scout、Conductor、Prism 和 meta-theory dispatcher，让 deep research 质量由角色责任、生成 packet、validator、fixtures 和回归测试共同约束，而不是只靠提示词描述。

### 验证

- `node scripts/run-node-tests.mjs "tests/meta-theory/02-clarity-gate.test.mjs" "tests/meta-theory/37-research-preparation-layer.test.mjs" "tests/meta-theory/44-research-execution-and-innovation.test.mjs" "tests/meta-theory/09-run-artifact-validator.test.mjs"`
- `npm run meta:check`
- `npm run meta:release:smoke`
- `node scripts/run-node-tests.mjs "tests/meta-theory/09-run-artifact-validator.test.mjs"`
- `git diff --check`

## [2.8.34] - 2026-06-16

### 解决的问题

本次解决的是安装/更新时混淆全局通用能力、项目投影和开源包内容的问题。默认目标、平台分层和包边界现在会明确说明什么被安装、什么只是本地生成、什么只是兼容候选 probe。

### 变更

- **安装范围边界** - 恢复并明确默认安装/更新模型：全局通用能力 + 当前项目投影，并修正为按目标平台选择落地；默认回车只投影 Claude Code + Codex，Cursor / OpenClaw 只有作为“正式投影兼容目标”被显式选择时才生成项目文件。
- **开源 runtime 投影边界** - 新增发布验证器，确保 `.codex/`、`.agents/`、`.claude/`、`.cursor/`、`openclaw/` 等生成的 runtime projection 不进入 GitHub source 或 package files，并明确 Codex adapter / business-role TOML 只是本地宿主投影，不是治理 agent 源码。
- **平台兼容分层** - 安装契约和验证输出现在会区分正式投影、依赖项目目标和候选 probe；公开文档不再重复上游依赖项目的安装矩阵，也不把它写成 Meta_Kim 支持承诺。
- **公开平台口径** - 更新 README 徽章、平台支持表和跨平台映射说明，让默认正式投影、显式正式兼容投影、候选兼容 probe 分开可见；同步刷新 Qoder 官方文档链接，并把 Cline 官方 Skills primitive 纳入 catalog。
- **项目治理体验** - 更新 PRD、setup 与 README 文案：全局 skill 只是可复用的发现入口，其他目录必须先 dry-run 项目 bootstrap 并确认后才允许写入项目文件；`AGENTS.md` 只按平台特性作为上下文资产描述，不再被写成 Codex/Cursor/OpenClaw 的统一入口。
- **安装范围验证** - 新增 `npm run meta:install-scope:verify`，用临时全局 home 和临时项目 bootstrap 实测各平台项目投影边界，并输出全局层 / 项目层分类结果。

## [2.8.33] - 2026-06-15

### 解决的问题

本次解决的是用户需要手动维护全局 Meta_Kim 和每个项目运行时投影的问题。项目 bootstrap 现在先 dry-run、展示来源链、保留用户文件，并且只在确认后写入项目。

### 新增

- **全局优先项目懒初始化** - 新增 `meta-kim project bootstrap` 和 `npm run meta:project:bootstrap`，让全局安装的 Meta_Kim 可以先 dry-run 再 apply 项目级 Claude Code / Codex 投影，用户不需要手动维护全局和项目两套状态。
- **首次触发 Bootstrap 探针** - 扩展 meta-theory activation hook：首次触发 meta-theory 时会运行项目 bootstrap dry-run probe，并保存 source-chain 证据，但不会静默写入项目文件。
- **懒初始化验收测试** - 新增空项目、已有用户配置、旧 manifest、只读失败、managed block 替换、保护式 JSON merge、备份 manifest、`.codex/config.toml` 永不触碰等场景覆盖。

### 变更

- **项目级来源链证据** - 项目 bootstrap plan 现在会在任何写入前暴露 installed package root、canonical roots、`config/sync.json`、生成的 runtime mirrors、目标项目、文件动作、merge policy 和 skipped files。
- **运行时原生选择面** - 更新 Claude Code 和 Codex 的 choice-surface 合同，保留结构化决策面板语义，并使用当前 host schema 的最大有意义选项数，不再使用 Meta_Kim 自己的硬编码上限。
- **能力路由** - 能力发现改为 canonical/index-first 路由，并防止 Codex 和 Claude Code 把对方 runtime 的 project agent adapter 误当作可调用执行 owner。

### 验证

- `npm run meta:check`
- `npm run meta:test:setup`
- `npm run meta:test:governance`
- `npm run meta:runtime:safety:validate`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.32] - 2026-06-15

### 解决的问题

本次解决的是 Codex 治理工作静默退回主线程单干的问题。复杂工作在安全时会进入 fan-out；宿主派发不可用、provider 被选中但没调用，都会作为 partial 证据展示。

### 变更

- **Codex Meta-Theory 并行编排** - 显式 `/meta-theory` 和复杂治理任务在存在多条安全 worker lane 时，会进入 fan-out eligible 路线，避免 Codex 静默退回主线程单干。
- **运行时容量分 wave** - 移除旧的固定 5 个 agent 上限，改为读取 Codex 配置和官方默认容量，同时在 fan-out 前证明 DAG 依赖、冲突边界、workspace 隔离和 external-write 安全。
- **能力调用真实性证据** - 收紧运行证据：只有存在 host spawn 证据时才把 live subagent 标为 `invoked`；host 不可用标为 `unavailable`，单 lane 标为 `not_required`，不能再把 provider 选中冒充为真实执行。

### 验证

- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.31] - 2026-06-14

### 解决的问题

本次解决的是动态工作流规划和真实并行执行之间缺少桥的问题。Meta_Kim 只在存在多条安全可执行 lane 时选择 agent-teams playbook，并区分 provider 选择、subagent 调用、MCP、skill、command、hook 和本地 worker。

### 新增

- **Agent Teams Playbook 门禁** - 新增 P-110 支撑门和 `agentTeamsPlaybookPacket`，让默认治理路线在出现两条及以上独立可执行 worker lane 时选中 `agent-teams-playbook`，先证明 DAG/冲突/workspace/external-write 安全，再按 runtime agent capacity 分 wave；单 lane 任务记录为 `not_required`。
- **能力调用真实性层** - 新增 `agent_teams_playbook` 调用状态，避免把 selected provider、live subagent 调用、MCP、skill、command、hook 或本地 worker 互相冒充。
- **产品体验 Validator** - 新增 PRD/product validator，覆盖三大核心目标和支撑门，包括 LangGraph-style run packet、Dynamic Workflow 覆盖、用户可见运行面、能力调用真实性和 agent-teams 适配。

### 变更

- **Codex Meta-Theory Runtime** - 收紧 Codex `/meta-theory` 适配器和 meta-conductor prompt：`agent-teams-playbook` 只在真实并行 worker lane 中选中，不会套到所有非平凡任务上。
- **依赖登记** - 将 `agent-teams-playbook` 从 external reference 提升为 installed skill candidate，并加入兼容验证与不得越级宣称 live 调用的边界。
- **发布 Smoke 覆盖** - `meta:release:smoke` 现在包含 `agent-teams-playbook` 集成测试。

### 验证

- `npm run meta:deps:compat`
- `npm run meta:prd:product-experience:validate`
- `npm run meta:prd:default-execution:validate`
- `npm run meta:prompt:validate`
- `npm run meta:graphify:check`
- `npm run meta:release:smoke`
- Codex live probe 从线程 `019ec26d-8837-77b2-95c8-1361bcb91128` 创建 reviewer 子智能体 `019ec274-15a4-7603-9986-335dad22c699`；`wait_agent` 回流被中断，因此完整 Review 回流闭环仍只算 partial 证据。

## [2.8.30] - 2026-06-13

### 解决的问题

本次解决的是运行时支持口径过宽、研究结论太容易被接受的问题。发布说明把主安装默认项与兼容 probe 分开，并把 deep research 变成带来源质量和综合规则的 Fetch 合同。

### 变更

- **主链安装默认项** - 将安装/更新时直接回车的默认目标改为 Claude Code + Codex，同时保留 OpenClaw、Cursor 的显式 all-runtime 或 `--targets` 选择路径。
- **Fetch 研究质量门** - 将 ECC 式 deep research 抽象内化为 Meta_Kim 原生 Fetch 合同，加入来源质量阶梯、关键来源深读、声明归因、交叉验证和原创综合边界。
- **兼容候选框架** - 基于官方资料新增 Qoder CLI、Trae、Kiro、Windsurf / Devin Desktop Cascade、Cline、Roo Code、Continue 的原始能力表面框架，同时保持 candidate probe，不升级为正式工具端投影。
- **兼容证据边界** - 将 GitHub 主完成判断与全工具端兼容证据拆开，Cursor 在 local-private PRD 与生成报告中保留为兼容后续项，并与主发布判断分离。

### 验证

- `npm run meta:sync`
- `npm run meta:release:smoke`
- `git diff --check`
- `node setup.mjs --update --lang zh --targets claude,codex --project-dir <dir>...`

## [2.8.29] - 2026-06-13

### 解决的问题

本次解决的是关键分支决策被聊天文字或 artifact fallback 冒充完成的问题。Codex 和 Claude Code 的必需决策必须走原生选择面，同时治理运行能展示用户可读进度。

### 新增

- **原生选择面守卫** - 新增回归测试，防止 Codex 和 Claude Code 的关键分支决策被聊天卡片或纯 artifact fallback 冒充完成。
- **运行状态面** - 新增本地化 run-status envelope 和命令，让治理运行能展示用户可读进度，同时不泄漏内部 packet 名称。

### 变更

- **Codex 与 Claude Code 不降级规则** - Codex 必须用 `request_user_input`，Claude Code 必须用 `AskUserQuestion` 或 deferred `AskUserQuestion` 完成必需执行决策；原生交互面不可用或返回空时，会在 Execution 前阻断，而不是静默降级。
- **Runtime 镜像映射** - 已把 canonical meta-theory skill、meta agents、runtime references 和项目内 runtime mirrors 同步到 Claude Code、Codex、Cursor、OpenClaw。

### 验证

- `npm run meta:sync`
- `npm run meta:governance:validate`
- `npm run meta:prompt:validate`
- `npm run meta:check:runtimes`
- `npm run meta:test:meta-theory`
- `git diff --check`

## [2.8.28] - 2026-06-13

### 解决的问题

本次解决的是默认治理执行看似完成、但证据层级混在一起的问题。产品 validator 现在检查核心目标、默认执行证据、research-to-native 采纳、运行时优先级和能力发现，同时避免把结构证据说成 live proof。

### 新增

- **默认治理执行证据** - 新增 validators 和 run artifact packets，证明默认 Meta-Theory 路径会产出治理 agent result、Conductor consumption evidence、worker result 和 worker execution evidence，同时不会把结构化 board 冒充成 live runtime 证据。
- **Research-to-native 产品化** - 新增来源化产品合同，覆盖研究采纳矩阵、MCP/provider 成熟度、trace/eval 控制、AG-UI 风格阶段事件、performance/cost budget 和 context engineering。
- **顺滑能力发现守卫** - 新增 PRD validator，把 agent、skill、script、MCP、tools、hook、runtime、memory、graph、external provider 都保留为一等发现类别，同时允许安全的 `no_expansion_needed`。
- **Runtime 优先级合同** - 新增机器可读合同和 validator，固定 Claude Code 与 Codex 为 prompt-first 主链路，OpenClaw 与 Cursor 只作为兼容目标保留。

### 变更

- **框架型 Prompt 架构** - Prompt 资产现在按 system/project/agent/skill/contract/runtime-adapter/eval 分层验收，并加入 review dimensions、regression fixtures 和 context-sprawl budget 规则。
- **治理验证链路** - `meta:verify:governance` 现在纳入 default execution、asset sedimentation、research-native、framework prompt architecture、smooth capability discovery 和 runtime priority validators。
- **唯一 PRD 源** - local-private PRD 现在把 P-067、P-068 到 P-084、P-085、P-092 标为本地已测通，同时把 Cursor native live 证据保留在兼容后续项中。

### 验证

- `npm run meta:prd:smooth-capability:validate`
- `npm run meta:prd:runtime-priority:validate`
- `node scripts/run-node-tests.mjs "tests/meta-theory/29-capability-gap-complete-product-prd.test.mjs"`
- `npm run meta:verify:governance`
- `npm run meta:release:smoke`
- `git diff --check`
- `npm run meta:github:gap`

## [2.8.27] - 2026-06-13

### 解决的问题

本次解决的是规划能列很多 lane，却证明不了 owner、依赖和验证是否就绪的问题。编排合同现在要求可用看板、明确依赖策略和可审查交接，之后才能执行。

### 新增

- **Prompt-first 实机验收** - 新增和 PRD 绑定的 live acceptance contract 与 runner，要求同一套框架型 prompt 在 Claude Code 和 Codex 上都跑通，才能声明 prompt-first 全流程完成。
- **PRD 来源化门禁** - 新增 PRD source-map 与分类 dossier validators，覆盖产品发现、prompt/runtime、MCP/tools/providers、安全、评测/可观测性、架构/发布等大类。

### 变更

- **抽象 Prompt 能力验收** - `meta:prompt:validate` 和治理验证现在会覆盖能力发现、prompt intake 优化、planning 连续性、runtime 原生能力、MCP/provider、memory/graph、安全 hook、发布证据和 i18n 等抽象能力族。
- **Prompt-first 发布证据收口** - 治理验证现在纳入 prompt-first stage contract、live acceptance fixture、source-map 校验、PRD 分类 dossier，以及 public docs 图片资产边界。
- **Codex 实机 runner 稳定性** - Codex live acceptance runner 现在通过 `codex exec -` 从 stdin 传入 prompt，避免 Windows `.cmd` 多行 prompt 卡住，同时保留真实 Codex 执行证据。

### 验证

- `npm run meta:prd:prompt-first-live:run`
- `npm run meta:prd:prompt-first-live:validate`
- `npm run meta:verify:governance`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.26] - 2026-06-12

### 解决的问题

本次解决的是 local/private PRD 状态、公开文档和实现证据漂移的问题。剩余产品工作现在用更清晰的 dossier、validator 和公开安全的状态语言跟踪。

### 修复

- **Meta-Theory 深度 Fetch 入口** - 项目/仓库/代码库理解、商业化发展和策略类问题现在会进入治理化 Fetch 路径，不再落到浅层 fast path 回答。
- **跨运行时入口对齐** - 新增 Claude Code `/meta-theory` command 投影支持、Cursor 原生 always-on dispatch rule、OpenClaw HEARTBEAT/SOUL 项目理解契约，让 Claude、Codex、Cursor、OpenClaw 都走同一条治理入口约束。
- **Run artifact 证据补齐** - `meta:theory:run` 现在会为项目理解类运行记录项目概览、维护契约、命令库存、Graphify、MCP、能力索引、机器契约和外部检索能力等 Fetch source class。

### 验证

- `node --test tests/meta-theory/47-meta-theory-entry-classifier.test.mjs`
- `node --test tests/setup/sync-runtimes-manifest.test.mjs`
- `node --test tests/governance/core-loop-contract.test.mjs`
- `npm run meta:sync`
- `npm run meta:check`
- `git diff --check`

## [2.8.25] - 2026-06-12

### 解决的问题

本次解决的是产品目标到底完成、部分完成还是阻塞反复混淆的问题。产品体验清单现在把完成声明绑定到具体证据，而不是宽泛状态词。

### 修复

- **Claude Code 全局 Hook 清理** - 全局 Meta_Kim 同步现在会校验 Claude Code `settings.json` 里的 hook 命令，不再只检查 `~/.claude/hooks/meta-kim/` 包目录。这样可以抓到指向已删除脚本的旧全局 Meta_Kim hook 注册，避免 Claude Code 在 Stop 阶段反复报 `MODULE_NOT_FOUND`。
- **已安装用户恢复路径** - 正常 setup/update 路径现在会清理旧的全局 Meta_Kim hook 条目，只保留当前被管理的全局 hook 命令；已有安装不需要手工改 Claude settings 也能恢复。

### 验证

- `npm run meta:check:global:release`
- `npm run meta:test:setup`
- `npm run meta:verify:governance`
- `npm run meta:check`
- `git diff --check`

## [2.8.24] - 2026-06-12

### 解决的问题

本次解决的是 host config、hook 协议、删除残留和证据表达经常在发布前漏检的问题。Checklist 和 PR 模板现在要求写清 source of truth、host-state 影响、清扫范围和证据预算。

### 变更

- **Runtime Safety 治理契约** - 新增发布级治理契约，把近期 5 条修复线收进同一个 validator：宿主配置安全合并、跨 runtime HookPrompt 协议建模、删除/重构残留清扫、runtime evidence 模板、安装/更新状态语义。
- **安装状态语义固定** - 安装和更新文案现在有机器可读状态类：`success`、`skipped`、`manual`、`failed`，并绑定用户下一步动作，避免把预期跳过、手工步骤和真实失败混在一起。
- **HookPrompt 坏输入回归** - 新增 markdown fence、delegated prompt、internal-goal filter 三类回归样本，并验证 Codex / Cursor adapter 会把优化内容放进模型可见字段，不把 UI 提示误当成策略决策。

### 验证

- 新增 `npm run meta:runtime:safety:validate`，并接入 `meta:verify:governance`。
- `npm run meta:verify:governance`
- `npm run meta:test:setup`
- `npm run meta:sync`
- `npm run discover:global`
- `npm run meta:check`
- `npm run meta:validate`
- `npm run meta:release:smoke`
- `npm run meta:setup:check`
- `npm run meta:validate:run -- tests/fixtures/run-artifacts/valid-core-loop-release-run.json`
- `npm run meta:graphify:rebuild`
- `npm run meta:verify:all`
- `git diff --check`

## [2.8.23] - 2026-06-12

### 解决的问题

本次解决的是发布前容易沿用过期图谱或包边界假设的问题。发布路径现在把 Graphify 和开源包边界作为显式检查项。

### 变更

- **Run-scoped Worker 实机执行** - `meta:theory:run` 现在会通过本地 run-scoped worker executor 执行 bounded worker task packets，不再停在结构化调度就绪。主线程仍然只负责 scope、dispatch、review 和 synthesize；不会额外派外部 Agent。

### 验证

- 增加 governance 覆盖，要求 worker execution evidence，同时继续保留 public-ready 发布门禁。

## [2.8.22] - 2026-06-12

### 解决的问题

本次解决的是生成的 runtime projection 可能偏离 canonical Meta_Kim 行为的问题。同步覆盖和 runtime 检查现在能在发布前更容易抓到投影差距。

### 变更

- **核心治理线路发布证据收口** - 补齐 PDR 发布清单和最终发布证据，让最终 tag 内包含 commit、tag、push 和 GitHub Release 证明。

### 验证

- 复用 `2.8.21` 的核心治理线路实现证据，并为最终 `2.8.22` patch 发布重新运行本地发布检查。

## [2.8.21] - 2026-06-12

### 解决的问题

本次解决的是能力缺口判断从“需要能力”直接跳到“创建 Agent”的问题。现在 capability gap 会先比较 skill、script、MCP provider、runtime tool 和已有 Agent，再允许持久创建。

### 变更

- **核心治理线路修复** - Meta_Kim 现在有了默认 8 阶段治理路径的机器契约，覆盖 Critical、Fetch、Thinking、Execution、Review、Meta-Review、Verification、Evolution 的输入输出、跳过条件、门禁、阻断、警告、public-ready 和写回策略。
- **默认运行产物闭合** - `meta:theory:run` 现在会为普通自然语言 durable task 输出顶层 request、intent、fetch、能力库存、gap/ready、thinking、dispatch、worker task、execution、review、meta-review、verification、evolution、dynamic workflow 和 public-ready 包。
- **能力发现总线接入默认入口** - 默认 run 不再只带 skill 或粗粒度摘要，而是接入统一 capability inventory bus。能力记录覆盖 agent、skill、script/tool、MCP、hook、runtime、OS、memory、graph 和外部依赖候选，并使用统一 provider 字段。
- **发布治理门禁补齐** - 完整发布验证现在会包含 governance validators 和 governance tests，覆盖 strict workflow fixture、PDR 证据映射，以及脚本 registry 的 cleanup candidate 保护。

### 验证

- `npm run meta:sync`
- `npm run discover:global`
- `npm run meta:check`
- `npm run meta:validate`
- `npm run meta:release:smoke`
- `npm run meta:verify:governance`
- `npm run meta:graphify:rebuild`
- `npm run meta:check:global:release`
- `npm run meta:verify:all`
- `npm run meta:validate:run -- tests/fixtures/run-artifacts/valid-core-loop-release-run.json`
- `git diff --check`

## [2.8.20] - 2026-06-11

### 解决的问题

本次解决的是 Meta_Kim 可以报告治理进度，却证明不了用户可见交付链闭合的问题。Run report 和 product bundle 现在带更清楚的完成、警告和剩余动作证据。

### 变更

- **项目 Hook 归属合理化** - 项目级运行时导出现在只保留和 Meta_Kim 项目行为强相关的 hook，例如图谱上下文、能力优先调度和 meta-theory 激活。提示词优化、记忆生命周期、planning 辅助、通用危险命令拦截这类个人通用 hook，统一留在全局运行时目录，不再重复投影到每个项目。
- **全局 Hook 同步覆盖补齐** - 全局同步和发布检查现在会明确比对被管理的全局 hook 文件；项目同步会清理 Codex / Cursor 项目目录里残留的全局专属 hook adapter。这样依赖项目自己的 hook 可以继续从源项目更新，也避免同一份提示词或上下文被重复注入。
- **Codex MCP 配置合并规范化** - Codex MCP 配置合并逻辑进一步收紧，ECC 管理的 server 会按统一命名和结构归一化，同时继续保留用户自己的配置。

### 验证

- `npm run meta:release:smoke`
- `npm run meta:check`
- `npm run meta:check:global:release`
- `npm run meta:test:setup`
- `node scripts/validate-provider-capabilities.mjs`
- `node scripts/validate-foundational-capabilities.mjs`
- `node scripts/validate-hook-progression.mjs`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.19] - 2026-06-11

### 解决的问题

本次解决的是 GitHub 完成、运行时兼容和本地验证被混成一个 done 结论的问题。完成证据和兼容证据现在分开，每个 blocker 都有 owner 和下一步。

### 变更

- **Apache-2.0 + NOTICE 署名声明** - Meta_Kim 主项目许可证从 MIT 调整为 Apache License 2.0，并新增根目录 `NOTICE` 文件承载推荐署名。商业使用仍然允许；分发 Meta_Kim 或其实质性部分时，需要保留 Apache 许可证文本和 NOTICE 署名声明。此前已经发布的版本仍按各自发布时附带的许可证适用。
- **多项目运行时自动更新** - `setup.mjs` 现在可以一次刷新多个显式传入或已保存项目目录里的项目级运行时文件，支持用 `--project-dir` 传入脚本化目标、用 `--save-project-dirs` 保存脚本传入列表，也支持用 `--all-projects` 复用本机保存的目标列表。
- **已保存项目目录管理器** - 更新向导现在支持管理已保存项目目录列表，可在一行里用分号或逗号输入多个目录，从菜单里更新全部已保存项目，也可用 `--all-projects` 复用。
- **批量更新时保护项目配置** - 多项目运行时导出会保留并合并已有本地 `settings`、MCP 和 hook 配置，不再直接替换；`.claude/settings.local.json`、Codex 项目配置、OpenClaw workspace 状态等本地状态不会被导出。

### 验证

- `node --check setup.mjs`
- `node --test tests/setup/project-deploy-protection.test.mjs tests/setup/setup-update-default-flow.test.mjs tests/setup/i18n.test.mjs`
- `npm run meta:test:setup`
- `npm run meta:sync`
- `npm run meta:check`
- `npm run meta:verify:all`
- `npm --registry=https://registry.npmjs.org audit --audit-level=high`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.18] - 2026-06-11

### 解决的问题

本次解决的是 live/runtime evidence 中 timeout、skipped、partial 结果容易被误当 release-grade 成功的问题。Runtime probe 现在更严格分类证据，并保留恢复路径。

### 修复

- **Codex Planning Stop Hook 改为提示模式** - Codex 的 planning-with-files Stop hook 不再把普通进度提醒转成强制继续执行。这样回答已经完成时，不会因为结尾触发旧计划提醒，就把关键答案折叠进 Codex App 的“已处理”区域。
- **零 Phase 计划不再误判未完成** - Codex planning hook adapter 遇到 `0/0` phase 计数时会安静跳过，不再当成未完成任务；混合 `**Status:**` 与 inline `[status]` 的计划格式，也会与 shell / PowerShell hook 一样稳定计数。

### 变更

- **变更准备合同** - 运行时、hook、setup、sync、provider、删除和发布类 PR 现在有可复用检查清单，覆盖宿主状态影响矩阵、hook/prompt 协议流、删除残留清扫和证据预算。
- **执行模式分类** - `executionMode` 现在会明确映射到 `real_execution`、`read_only_sidecar`、`approval_gate` 三类。验证器和 Review 可以按语义类别判断执行是否真实发生，而不是只看任务节点数量。

### 验证

- `node --check scripts/install-global-skills-all-runtimes.mjs`
- `node --check scripts/validate-project.mjs`
- `node --check scripts/validate-run-artifact.mjs`
- `node --test tests/setup/release-docs-semantics.test.mjs tests/setup/install-cross-platform.test.mjs`
- `node --test tests/meta-theory/09-run-artifact-validator.test.mjs tests/meta-theory/31-capability-gap-orchestration.test.mjs tests/meta-theory/33-capability-gap-orchestration-quality.test.mjs`
- `node scripts/validate-provider-capabilities.mjs --strict-global-hooks --json`
- `npm --registry=https://registry.npmjs.org audit --audit-level=high`
- `npm run meta:verify:all`
- 本机 Windows Codex planning Stop hook smoke：`0/0` phase 计划不再 block；普通未完成计划只返回 `systemMessage`，不返回 `decision:block`。
- 已安装用户路径 hook 合并 smoke：重新安装 `planning-with-files` 后，Codex 同时保留 `user_prompt_submit.py` 和 `hookprompt-adapter.mjs`；Cursor 的 `beforeSubmitPrompt` 仍保留 `hookprompt-adapter.mjs`。

## [2.8.17] - 2026-06-11

### 解决的问题

本次解决的是生成报告和产品表面太散，导致治理运行难以检查的问题。报告现在围绕决策、审查和后续行动需要的证据收束。

### 修复

- **编排任务有真实执行模式** - `workerTaskPacket` 现在会声明 `executionMode`，Meta_Kim 可以区分真正执行 worker、审批门禁，以及只读 Fetch/Review sidecar。只包含 sidecar 或审批步骤的并行组，不能再通过质量门。
- **Capability Gap 编排验证更严格** - Capability-gap 报告现在会把 execution mode 贯穿到 worker packet、任务板、Review 检查、验证摘要和 run artifact validator。这样“看起来并行、实际没执行”的假并行会被直接暴露并拦下。
- **ECC 插件更新路径修正** - Claude plugin update 模式在发现已有 ECC 插件记录时，会调用 `claude plugin update ecc@ecc`；更新成功后重新读取插件管理器记录，避免沿用旧路径或旧 SHA。
- **Graphify Python 发现更稳** - Graphify setup 和 runtime 检查会在普通 `python3` / `python` 之后继续尝试 Homebrew 和 Linuxbrew Python 路径。macOS / Linux 用户即使 Python 没放进 PATH，也更容易完成 Graphify 初始化。

### 验证

- `node --test tests/meta-theory/09-run-artifact-validator.test.mjs`
- `node --test tests/meta-theory/31-capability-gap-orchestration.test.mjs tests/meta-theory/33-capability-gap-orchestration-quality.test.mjs`
- `node --test tests/setup/graphify-runtime.test.mjs tests/setup/graphify-wiring-contract.test.mjs tests/setup/install-cross-platform.test.mjs tests/setup/install-plugin-bundles.test.mjs`
- `node --test tests/integration/agent-teams-playbook-integration.test.mjs tests/meta-theory/39-orchestration-dag-report.test.mjs tests/meta-theory/40-orchestration-scheduler-report.test.mjs`
- `npm run meta:gap:validate-board`
- `npm run meta:gap:complex-inputs`
- `npm run meta:gap:codex-real-test`
- `npm run meta:test:setup`
- `npm run meta:test:meta-theory`
- `npm run meta:check`
- `npm run meta:graphify:rebuild`
- `npm run meta:graphify:check`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.16] - 2026-06-10

### 解决的问题

本次解决的是复制出来的项目文件存在，但目标项目并没有真正初始化的问题。Post-copy 流程现在在最终项目根目录初始化 Graphify，并避免把临时导出目录当成真实项目。

### 修复

- **复制后自动初始化 Graphify** - 复制到任意项目根目录的 Meta_Kim 项目级文件夹，不再要求用户记住并手动运行 `node meta-kim-post-copy.mjs`。首次触发 `meta-theory` 时，Meta_Kim 会从最终项目根目录自动启动 post-copy bootstrap。
- **首次触发不阻塞** - 生成的 `meta-kim-post-copy.mjs` 现在支持 `--auto` 和 `--auto-worker`。hook 只启动一个分离的后台 worker，把一次性状态写入 `.meta-kim/state/default/post-copy-init.json`；即使 Graphify 依赖安装或建图耗时较长，也不会卡住 meta-theory 启动路径。
- **运行时 hook 覆盖补齐** - Claude Code 和 Codex 的 Skill 激活会调用同一个 shared spine hook；Cursor 的 prompt hook 也能在显式 `meta-theory` 输入时走同一路径自动 bootstrap。需要显式关闭时，可以设置 `META_KIM_POST_COPY_AUTO=off`。
- **回归测试覆盖** - setup 测试现在锁定自动 bootstrap 契约、Cursor prompt hook 顺序，以及复制后 Graphify 初始化行为。

### 验证

- `npm run meta:test:setup`
- `npm run meta:graphify:rebuild`
- `npm run meta:release:smoke`
- `npm run meta:graphify:check`
- `git diff --check`
- `node --check setup.mjs`
- `node --check canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs`
- `node --check scripts/runtime-hook-mapping.mjs`
- `node --check scripts/sync-runtimes.mjs`

## [2.8.15] - 2026-06-10

### 解决的问题

本次解决的是用户把生成文件移动到真实项目后，copy-ready 设置失效的问题。Bootstrap 脚本现在从复制后的目标目录运行，并把 Graphify 设置绑定到最终项目目录。

### 修复

- **可复制目录的 Graphify 初始化** - quick setup 或 install/update 导出的项目级文件夹现在会包含 `meta-kim-post-copy.mjs`。当你先把生成目录放在桌面等临时位置，再把其中全部内容复制到任意项目根目录后，在最终项目里运行 `node meta-kim-post-copy.mjs` 即可为该项目初始化 Graphify。
- **临时目录边界更清楚** - Meta_Kim 不再把桌面这类生成/暂存目录误当成最终 Graphify root。这样不会为错误目录生成或复制过期的 `graphify-out/`，Graphify 仍然按最终项目逐个初始化。
- **复制后契约测试覆盖** - setup 测试现在会锁定 copy-ready 契约：运行时文件复制完成后才写入 bootstrap；bootstrap 用自身所在目录作为项目根；install/update 导出不会悄悄在暂存目录里构建 Graphify。

### 验证

- `node --check setup.mjs`
- `node --test tests/setup/graphify-wiring-contract.test.mjs`
- `node --test tests/setup/install-cross-platform.test.mjs tests/setup/setup-update-default-flow.test.mjs tests/setup/i18n.test.mjs`
- `npm run meta:test:setup`
- `npm run meta:graphify:rebuild`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.14] - 2026-06-10

### 解决的问题

本次解决的是安装/更新输出像失败或英文内部日志，而不是可执行用户状态的问题。提示现在本地化，预期的宿主插件手动步骤会诚实标记，HookPrompt 输出也不会破坏 Markdown 渲染。

### 修复

- **安装和更新提示本地化** - ECC、Graphify、Codex 配置保护、原生插件交接、插件市场检查和回环代理处理等安装/更新输出，现在统一走 Meta_Kim shared i18n，不再散落硬编码英文。中文、日文、韩文用户会看到本地化的跳过状态和手动宿主插件步骤。
- **ECC 上游版本跟随** - ECC 原生安装现在使用 `ecc-universal@latest`，不再使用旧的 `2.0.0-rc.1` release candidate；运行时清单、文档、兼容性证据和 setup 测试都已同步。
- **插件交接提示不再误导** - 宿主限制导致的预期手动步骤现在显示为跳过/手动处理，不再像失败警告。Codex 和 Cursor 原生插件提示会说明应走宿主插件入口，而不是暗示技能目录回退失败。
- **Graphify 跳过状态一致** - 已经存在 Graphify 指南章节时，Graphify install 会输出本地化跳过提示；旧的 `[SKIP] graphify ...` 也统一成 Meta_Kim 的跳过状态输出。
- **HookPrompt Markdown 安全输出** - 上游 HookPrompt 依赖现在会把用户原始输入和优化后的完整提示词都放进 fenced code block；因此 `# Files mentioned by the user:` 这类附件标题不再会在 Codex 中间输出里被渲染成超大 Markdown 标题。

### 验证

- `node --check .claude/hooks/user-prompt-submit.js; node --check .codex/hooks/user-prompt-submit.js; node --check test-hook.js`（在 `<project-root>/HookPrompt`）
- `node test-hook.js`（在 `<project-root>/HookPrompt`）
- `node scripts/install-global-skills-all-runtimes.mjs --dry-run --update --skills ecc,superpowers --targets claude,codex,cursor --lang zh-CN`
- `node --test tests/setup/install-plugin-bundles.test.mjs tests/setup/graphify-wiring-contract.test.mjs tests/setup/install-cross-platform.test.mjs`
- `npm run meta:test:setup`
- `npm run meta:capabilities:smoke`
- `npm run meta:check`
- `npm run meta:release:smoke`
- `npm run meta:verify:all`
- `npm run meta:graphify:rebuild`
- `npm run meta:graphify:check`
- `git diff --check`

## [2.8.13] - 2026-06-10

### 解决的问题

本次解决的是 ECC 安装覆盖 Codex App 用户配置、导致原生控制能力断开的风险。Meta_Kim 现在以用户配置为基底，只 add-only 合入 ECC，并恢复 Browser、Chrome、Computer Use 插件设置。

### 修复

- **Codex App 原生控制保护** - Meta_Kim 现在会在运行 ECC Codex home installer 前保护用户已有的 `~/.codex/config.toml`。这次问题是因为发现 ECC 的 Codex 安装路径会把它自己的 reference `config.toml` 覆盖到用户的 Codex App 配置上，进而导致 Codex 的 Computer Use 和 Chrome 插件连接失效。
- **ECC 配置合并安全性** - ECC upstream installer 运行后，Meta_Kim 会用用户原始 Codex 配置作为最终基底，只把 ECC 新增项 add-only 合进去，再恢复 Codex App 的 Browser、Chrome 和 Computer Use 原生插件配置。这样不会丢用户已有的 MCP servers、hooks、agents、projects、profiles 和其它全局 Codex 设置。
- **Windows Codex App 恢复** - Windows 安装路径现在会修复 Codex App 原生控制面：保持 `windows.sandbox = "unelevated"`，启用 `features.js_repl`，移除失效的 `.codex/.tmp/bundled-marketplaces/openai-bundled` marketplace source，并在存在时保留 Computer Use notification helper。

### 验证

- `node --test tests/setup/codex-config-merge.test.mjs`
- `node --test tests/setup/install-plugin-bundles.test.mjs`
- `npm run meta:release:smoke`
- `npm run meta:verify:all`
- `npm run meta:graphify:rebuild`
- `git diff --check`

## [2.8.12] - 2026-06-10

### 解决的问题

本次解决的是 HookPrompt 在 Codex 看起来运行了，但优化提示词没有稳定进入模型上下文的问题。Codex 现在使用模型可见的 `additionalContext` 包，UI 提示继续独立。

### 修复

- **Codex HookPrompt 模型上下文** - Codex 的 HookPrompt adapter 现在输出 `hookSpecificOutput.additionalContext`，不再把优化结果包成 `systemMessage`。这修复了“hook 确实执行了、界面或日志能看到，但模型没有稳定吃到优化提示词”的问题。
- **Codex 记忆上下文** - Meta_Kim shared memory hook 在 Codex 里也改用和 Claude Code 一样的模型可见上下文包；Cursor 继续使用自己的 `prompt` 包，UI 提示仍保持独立。

### 变更

- **HookPrompt 依赖路径** - Meta_Kim 会优先查找 HookPrompt 源项目提供的 Codex adapter，再回退到 Claude hook 实现，和依赖项目的新结构对齐。

### 验证

- `node test-hook.js`（在 `<project-root>/HookPrompt`）
- `node --test tests/setup/sync-runtimes-manifest.test.mjs tests/setup/mcp-memory-hooks.test.mjs`
- `node scripts/install-global-skills-all-runtimes.mjs --update --skills hookprompt --targets codex`
- `codex exec --dangerously-bypass-hook-trust --skip-git-repo-check --sandbox read-only --cd <project-root>/course-materials "帮我做个小红书营销自动发布器，先别改文件，先说你理解到什么"`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.11] - 2026-06-09

### 解决的问题

本次解决的是全局 hook 过重或过度绑定特定 runtime 的问题。Meta_Kim 现在区分安全的全局可复用 hook 和更强的项目级治理 hook，并按 runtime 验证 HookPrompt provider 映射。

### 变更

- **全局和项目级 Hook 策略** - Meta_Kim 现在明确区分项目级治理 hook 和全局可复用 hook。派工强校验、Graphify 上下文、meta-theory spine 这类强治理能力默认留在项目级；全局安装只放记忆保存、HookPrompt、OpenClaw memory bridge 这类安全可复用入口。

### 修复

- **Cursor 全局 HookPrompt** - Cursor 全局 `beforeSubmitPrompt` 现在会注册 HookPrompt adapter，和 Codex 全局 `UserPromptSubmit` 的策略对齐；严格 provider 验证也会同时检查 Codex 和 Cursor。
- **Hook 能力清单** - provider registry 现在把 Codex 和 Cursor 的 HookPrompt adapter 分开建模，项目投影和全局安装会按各自 runtime 与 hook 事件验证。

### 验证

- `node scripts/install-global-skills-all-runtimes.mjs --skills hookprompt --targets cursor`
- `node scripts/validate-provider-capabilities.mjs --strict-global-hooks --json`
- `node --test tests/setup/install-cross-platform.test.mjs`
- `node --test tests/governance/provider-capabilities.test.mjs`

## [2.8.10] - 2026-06-09

### 解决的问题

本次解决的是自然语言持久任务被迫套固定清单，或要求用户懂协议词的问题。Meta_Kim 现在按任务生成必要 lane，检查本地基线证据，并显示人能看懂的进度。

### 新增

- **Dynamic Workflow** - 自然语言产品需求现在会展开成当前任务真正需要的执行通道，而不是套固定清单。比如“小红书营销自动发布器”会选择产品、研究、内容、UX、前端、后端、数据、集成、安全、测试、运维；“本地待办看板”只选择更小的必要集合。
- **Project Agent Profiles** - 动态通道会先合成本次运行固定的项目 agent profile，再进入执行。profile 记录项目范围、角色族、能力装载、记忆策略、证据规则和晋升策略；一次性 worker 不再被误认为持久项目 agent。
- **Evidence Policy** - 研究、集成、安全、运维通道会明确声明是否必须查询当前外部证据。平台规则、API、供应商能力、合规、安全、发布路径、第三方可行性等判断，必须有来源支撑后才能锁定路线。
- **Local Baseline Comparison** - 每个被选中的通道都要先和本地真实情况对比：canonical agents / skills、contracts、capability indexes、runtime mirrors、package scripts、MCP 配置、OS/runtime 矩阵和项目记忆。
- **Graphify Agent Equipment** - 项目 agent profile 现在把 Graphify 当成导航和子图切片能力，而不是整图上下文注入。运行时优先复用已有图谱产物，只给 worker 注入相关切片，关键判断仍回到源文件验证，修改后再重建图谱。
- **Conversation Notice** - 普通自然语言请求进入治理流程时，会输出本地化的人话状态提示，让用户知道现在发生了什么、下一步做什么，而不需要懂 packet 名或命令语法。

### 修复

- **自然语言入口** - 持久性人类请求不再要求用户说出 `meta-theory`、`Critical` 或 `Fetch` 这类协议词。产品构建类请求会自动进入治理路线，纯只读问题仍走轻量路径。
- **OpenClaw 和 Cursor 贡献证据门** - OpenClaw 或 Cursor 相关改造必须先在对应工具端完成严格自测并提供证据，审查通过后才能合并。
- **编排输出可读性** - 编排摘要现在能看见 project agent id、固定的 capability profile、是否需要外部证据、是否需要本地基线对比。

### 验证

- `node --test tests/meta-theory/31-capability-gap-orchestration.test.mjs`
- `node --test tests/meta-theory/34-run-deliverables.test.mjs`
- `npm run meta:sync`
- `npm run meta:release:smoke`
- `npm run meta:graphify:rebuild`
- `git diff --check`

## [2.8.8] - 2026-06-09

### 解决的问题

本次解决的是报告和平台声明技术上没错、但用户难以理解的问题。工具支持等级、持久 Agent 边界和 runtime 目标来源现在用更朴素的方式表达。

### 变更

- **工具端报告文案** - 公开报告保留协议标签，但配上人能看懂的说明。
- **工具端支持口径** - Claude Code 和 Codex 说明为完整支持；OpenClaw 和 Cursor 说明为正式兼容投影，并要求更严格的贡献证据。
- **持久 agent 边界** - 临时 subagent 是 factory 或 review worker，不等于被创建出来的项目 agent。
- **工具端来源** - 报告里的工具端目标来自 runtime compatibility 数据，不再写死名称。

### 验证

- `npm run meta:sync`
- `npm run meta:check`
- `npm run meta:providers:validate`
- `npm run meta:hook:validate`
- `npm run meta:route:validate`
- `npm run meta:runtime:validate`
- `npm run meta:release:smoke`
- `git diff --check`

## [2.8.7] - 2026-06-09

### 解决的问题

本次解决的是能力发现太窄、太依赖工具名的问题。Fetch 现在会在 Thinking 选择 owner/loadout 前记录各支持投影的项目和全局库存。

### 变更

- **跨工具端 Fetch 发现** - Claude Code、Codex、Cursor、OpenClaw 在 Thinking 前都要记录项目和全局能力库存证据。
- **Provider 扫描对齐** - 全局发现覆盖 settings、hooks、skills、prompts、rules、MCP config、package scripts 和 workspace agents。
- **运行时 skill 投影稳定性** - runtime sync 保留跨工具端 Fetch checklist，不再把路径错误改写成其它工具端的投影路径。

### 验证

- `npm run meta:sync`
- `npm run meta:route:validate`
- `npm run meta:capabilities:smoke`
- `npm run meta:check:runtimes`
- `npm run meta:test:meta-theory`
- `git diff --check`

## [2.8.6] - 2026-06-05

### 解决的问题

本次解决的是 capability gap 只像松散脚本任务，而不像完整产品流程的问题。缺口现在有决策合同、回放证据、用户可见交付物、runtime 证据加固和报告卫生。

### 新增

- **Capability Gap 产品化** - Capability Gap 不再只是脚本能力，而是带决策合约、输出合约、真实输入回放、编排板校验和验收门的产品流程。
- **Run 交付物** - 治理运行增加用户可见交付物、趋势面板、审批面板、GitHub 差距报告、验证包、研究报告、能力浏览器、DAG/调度报告、worker 输出报告和产品交付 bundle。
- **Runtime 证据加固** - 增加 live shard matrix、Cursor live boundary contract、OpenClaw batch stability evidence、Codex timeout recovery evidence 和复杂回放场景。
- **项目文件盘点技能** - 增加项目内可复用的同组文件盘点 skill。

### 修复

- **Hook 同步可移植** - 项目 Claude hook 命令保持 repo 相对路径，全局 hook 继续使用 slash-normalized absolute commands。
- **生成报告卫生** - 生成报告移出 tracked docs 路径，并移除风险较高的跨项目批量更新器。
- **PRD 闭环对齐** - complete-product guard 跟随当前完成状态，不再盯着过期的 unfinished markers。

### 验证

- `npm run meta:sync`
- `npm run discover:global`
- `npm run meta:check:global`
- `npm run meta:check`
- `npm run meta:graphify:rebuild`
- `npm run meta:release:smoke`
- `npm run meta:verify:all`
- `git diff --check`

## [2.8.5] - 2026-06-03

### 解决的问题

本次解决的是小文案改动发布检查太重、runtime/security 工作检查又太弱的问题。发布模式现在区分快速常规检查和更严格的 release-grade evidence。

### 新增

- **发布模式** - 低风险 prompt、文档、治理文案改动走快速发布路径；安装、runtime、hook、provider、dependency、package、安全和 live evidence 相关工作仍走更严格的 release-grade 路径。
- **执行需求证明** - release-grade 工作必须在修改或发布前证明 Fetch -> Thinking 路线已经选择 owner、agent provider、skill provider、MCP provider、command/runtime tool 和 verification path。
- **Live 证据分类** - structural smoke、warning、skipped/needs-auth 和真实 runtime live pass 被明确区分。

## [2.8.4] - 2026-06-02

### 解决的问题

本次解决的是执行路线可能在没有证明 owner、provider、tool、verification 就绪前就推进的问题。Capability smoke 和 OpenClaw live 分片让真实路线就绪变得可测试。

### 新增

- **能力发现 smoke** - 增加 smoke 命令，用来证明真实执行需求可以自然选择 owner、provider、tool 和 verification path。
- **OpenClaw live 分片** - Claude/OpenClaw 长时间 live 检查可以按 agent 分片，便于恢复和定位问题。

### 修复

- **执行路由** - 工程执行进入 Execution 前必须先绑定真实 owner / provider / verification 证据。
- **OpenClaw live evaluation** - OpenClaw 检查继承配置好的 provider/model 表面，并能更稳地恢复嵌套 JSON 和 session 输出。
- **OpenClaw auth hydration** - 本地 OpenClaw auth 可以复用已有可用的 meta-agent auth 来源，同时不覆盖已经能用的文件。

## [2.8.3] - 2026-06-02

### 解决的问题

本次解决的是 provider discovery 散落在 tools、hooks、skills、plugins、MCP、memory、graph 表面的问题。Provider registry 给这些表面统一生命周期和验证模型。

### 新增

- **Capability Provider Contract** - 增加 provider registry 和生命周期模型，用于管理 runtime-native tools、skills、agents、hooks、commands、rules、plugins、MCP servers、dependency projects、memory 和 graph providers。
- **Provider validator** - 增加 provider/runtime/OS/install-layer 缺口校验，并支持严格检查全局 Codex hook。

### 修复

- **Codex HookPrompt 链路** - 全局 Codex prompt hook 保留原有 planning hooks，同时确保 HookPrompt 输出进入模型上下文。
- **Plugin 可见性** - plugin 和 plugin-bundle provider 进入 capability index 与 provider registry。

## [2.8.2] - 2026-06-02

### 解决的问题

本次解决的是 runtime 支持声明难比较、也容易夸大的问题。兼容性数据现在把 sync 行为、原生表面声明、package targets 和候选 probe 分开记录。

### 变更

- **Runtime compatibility catalog** - runtime 支持数据归一到兼容性目录，覆盖 sync 行为、原生能力声明和 package targets。
- **候选工具端处理** - opencode、Qwen、Zed、Gemini、CodeBuddy、Antigravity、JoyCode、Qoder 等被诚实记录为安装目标或候选 probe，不再夸大成完整投影。

## [2.8.1] - 2026-06-02

### 解决的问题

本次解决的是公开文档没有清楚区分 supported、compatible、candidate runtime 状态的问题。README 和 runtime 文档现在更容易解释和验证这些状态。

### 变更

- **公开支持口径** - README 和 runtime-facing docs 对齐 supported、compatible、candidate 状态。
- **投影同步说明** - 项目本地和全局 sync 行为更容易解释和验证。

## [2.8.0] - 2026-06-01

### 解决的问题

本次解决的是按工具名路由会忽略 provider 就绪、runtime 支持、OS 支持、依赖和验证 owner 的问题。Meta_Kim 转向 provider-first governance，并把发布证据纳入常规流程。

### 新增

- **Provider-first governance** - Meta_Kim 从工具名路由转向 provider 和 capability 路由。
- **Runtime 和 OS 证据门** - 执行路线在行动前检查 runtime 支持、OS 支持、依赖状态、owner、weapon 和 verification path。
- **安装与发布证据** - setup、sync、runtime、provider 和 release 检查进入常规发布叙事。

## [2.7.0] - 2026-06-01

### 解决的问题

本次解决的是治理工作从 Agent 名字开始，而不是从能力需求开始的问题。Capability-first routing、owner/loadout evidence 和 runtime alignment 成为默认执行形态。

### 新增

- **能力路由治理** - 引入 capability-first execution routing、owner/loadout evidence 和 provider discovery，作为治理工作的默认形态。
- **工具端对齐** - Claude Code、Codex、OpenClaw、Cursor 围绕 canonical source 对齐，同时保留真实 runtime 限制。

## [2.6.x] - 2026-05-29 至 2026-05-30

### 解决的问题

这一组版本解决的是治理运行结束后难以审计的问题。报告、status envelope、研究准备、能力库存和全局发现变得更可见、更有来源。

### 新增

- **治理执行报告** - 增加更完整的 run report、status envelope 和公开证据表面。
- **研究和能力准备** - 增加 source-backed research preparation、retrieval capability discovery 和 multi-type capability inventory。
- **全局能力发现** - 扩大扫描 installed agents、skills、hooks、commands、MCP config、plugins 和 runtime mirrors。

## [2.5.x] - 2026-05-28

### 解决的问题

这一组版本解决的是决策缺少 runtime、OS、dependency、weapon、trigger、intent 和 choice-surface 共同门禁的问题。决策引擎和架构文档把这些检查显式化。

### 新增

- **治理决策引擎** - 增加 runtime capability、OS compatibility、dependency capability、weapon routing、trigger-action policy、intent amplification、choice surfaces、dynamic lens selection 和 decision-pattern contracts。
- **面向用户的架构文档** - 扩展 runtime capability、dependency discovery、owner/weapon routing 和 choice surfaces 说明。

## [2.4.x] - 2026-05-27 至 2026-05-28

### 解决的问题

这一组版本解决的是研究和接口集成工作在缺少检索或合同证据时就影响路线设计的问题。新增研究能力证据、集成 packet、未知字段处理和运行状态输出。

### 新增

- **研究路线加固** - 研究工作必须先证明 retrieval capability，才能影响 route design。
- **接口集成合约** - 第三方和内部 API 集成获得明确 contract packets、未知字段处理、evidence refs 和 review gates。
- **运行状态表面** - 增加本地化 run-status 输出。

## [2.3.x] - 2026-05-26

### 解决的问题

这一组版本解决的是 worker 声称测试、命令成功或静默成功时缺少结构化证明的问题。执行证据和验证 schema 结构被收紧。

### 新增

- **证据完整性合约** - worker 关于测试和命令成功的声明必须有结构化 execution evidence。
- **静默成功处理** - 无输出但成功的命令用 exit-code evidence 表达，不再制造占位文本。
- **Validation contract 结构** - validation rules 迁移为更可复用的 schema 和 runner。

## [2.2.x] - 2026-05-25

### 解决的问题

这一组版本解决的是治理词汇和 Agent 创建规则太松，难以支撑持久执行的问题。Workflow packets、命名策略、dispatch evidence、agent factory 规则和 sub-agent 边界被显式化。

### 新增

- **Workflow contract 扩展** - 增加 packet 词汇、命名策略、维度定义、dispatch evidence 和 business-flow tests。
- **Agent factory 治理** - 项目本地 execution agent 创建必须有 capability gap evidence、治理参与和 review，才能写持久文件。
- **Sub-agent 边界规则** - Meta agents 负责治理、审查和路由，不再扮演通用实现 worker。

### 修复

- **Worker 写入完成诚实性** - 有文件范围承诺的 worker 必须逐文件报告 completed、skipped 或 failed。
- **历史更新说明准确性** - 早期低层级 release-note 错误已修正，并折叠进当前可读格式。

## [2.1.x] - 2026-05-23 至 2026-05-24

### 解决的问题

这一组版本解决的是模糊任务在用户选择和 public-ready 边界未清楚前就进入编排的问题。Critical、Fetch、Verification、summary closure 和 deliverable-chain gate 变得更明确。

### 新增

- **选择和确认流程** - Critical 和 Fetch 对模糊需求、候选路径、用户确认有了更清晰的准入门。
- **Public-ready gates** - 声称完成前，必须满足 verification、summary closure 和 deliverable-chain closure。

## [2.0.x] - 2026-04-11 至 2026-05-23

### 解决的问题

这一组版本解决的是需要一套可复用跨工具端治理架构，而不是散落 prompt 和一次性 runtime 文件的问题。Meta_Kim 2.x 建立了核心 spine、投影、记忆、Graphify、setup/update、打包和治理 Agent 基础。

### 新增

- **Meta_Kim 2.x 架构** - 建立 8-stage spine、11-phase business workflow、hidden governance packets、runtime projections、memory layers、Graphify support、setup/update flow 和 capability boundaries。
- **跨工具端投影系统** - canonical sources 可以投影到 Claude Code、Codex、Cursor 和 OpenClaw 文件。
- **安装与打包基础** - 增加 setup、sync、status、package whitelist、runtime asset projection、local overrides、project/global install modes。
- **Meta agent 团队** - 引入 Warden、Conductor、Genesis、Artisan、Sentinel、Librarian、Prism、Scout、Chrysalis 等治理 agent。

### 修复

- **README 和架构表达** - 文档反复收紧，解释 8-stage execution spine、business workflow、contracts、gates 和 runtime projections 的关系。
- **Runtime mirror drift** - sync checks 和 validation 降低 canonical sources 与 runtime projections 的漂移。

## [1.x] - 2026-03-22 至 2026-04-11

### 新增

- **早期治理模型** - 建立早期 meta-agent architecture、workflow vocabulary 和 reusable governance concepts，后来演进为 Meta_Kim 2.x。
- **早期文档和示例** - 增加第一批公开 README、图示和更新说明。

## [0.x] - 2026-03-17 至 2026-03-21

### 新增

- **项目种子** - 创建仓库和第一批实验性 Meta_Kim workflow assets。
