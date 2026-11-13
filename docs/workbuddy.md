# WorkBuddy：导入治理方法与专业方法

本接入使用 WorkBuddy 官方的本地 Skill 上传入口。它生成可查看的单个 Skill ZIP，保留原方法和资源、来源版本与文件 SHA-256。生成成功表示导入包已就绪，不表示 WorkBuddy 已安装、已发现、已执行模型任务，或已经注册原生 Agent、MCP、Hook。不会写入用户宿主目录、配置、登录信息或权限。

## 已核对的官方边界

核对日期：2026-11-13 UTC（北京时间 2026-11-14）。

- [官方技能使用说明](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)提供「专家·技能·连接器 → 技能 → 添加技能 → 上传技能」入口。启用状态由用户配置管理；关闭后的当前会话可能仍保留已加载内容，应开新任务核对。
- [官方 Skill 结构](https://open.workbuddy.cn/docs/skill)规定 `SKILL.md` 和可附带的参考、脚本、模板，并给出市场展示元数据。导出器生成这些元数据，将未经改写的原方法放在 `source/`，wrapper 指向完整入口。
- [专家](https://open.workbuddy.cn/docs/expert)、[专家团](https://open.workbuddy.cn/docs/expert-team)是另一个插件/平台规范，包含 `.codebuddy-plugin/plugin.json`、Agent 文件及展示材料。本包没有冒用这条专家注册路径；Service 的 Agent 作为 Skill 中的完整专业方法供读取。
- [连接器](https://open.workbuddy.cn/docs/connector)公开了 MCP/CLI 集成；[插件说明](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Plug-In)列出 Agent、MCP、Hook 等组成。本次只实现 Skill 文件导入，不自动接入这些执行能力。
- 这些 WorkBuddy 桌面文档没有明确稳定的用户/项目 Skill 自动扫描路径。本次不猜 `~/.workbuddy/skills`，也不把同域 `docs/cli` 下 **CodeBuddy Code** 的 `.codebuddy` 用户/项目路径当成 WorkBuddy 契约。

[Windows 官方安装要求](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Win-Guide)为 Windows 10+、x64；ARM64 支持以具体版本说明为准。[Mac 官方要求](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Mac-Guide)为 macOS 12+，分别提供 ARM64/X64，须从 Applications 启动而不是只读 DMG。方法中脚本的 Node/Python 等依赖仍需在实际宿主按需确认；包生成器只需要 Node，不需要系统 zip/Python。

## 导出 Meta_Kim

在 Meta_Kim 正式源码解压目录（或已安装 npm 包根目录）打开 PowerShell：

```powershell
$KimExport = Join-Path ([IO.Path]::GetTempPath()) ('meta-workbuddy-' + [guid]::NewGuid().ToString('N'))
node scripts/build-desktop-skill-package.mjs --host workbuddy --component meta-theory --output $KimExport
if ($LASTEXITCODE -ne 0) { throw '导出失败，请按错误修复，不要导入不完整包' }
node scripts/build-desktop-skill-package.mjs --host workbuddy --component meta-theory --output $KimExport --check
if ($LASTEXITCODE -ne 0) { throw '文件核验失败' }
Write-Host (Join-Path $KimExport 'meta-theory.zip')
```

macOS 使用相同 Node CLI，`--output` 指向新的绝对目录。已有输出不会被覆盖；`--check` 比较 ZIP、解压树、全部哈希和来源，不写文件。重新导出升级包时使用另一个新目录。

包内保留 `meta-theory` 完整原文、九个治理角色和公开 config 契约。**它是治理方法包，不含 Meta_Kim 可执行运行时。** 原文所需命令、Live、MCP 或 Hook 必须由另行安装且核实的运行时提供，缺少时明确报告，不凭一份 ZIP 宣称运行时已接入。原生工具名称须映射到当前宿主实际能力；不修改原方法来伪造能力。

## 选择一个 Service 方法

进入 Kim_Service 正式源码根目录，运行其薄入口；`--meta-root` 必须指向同一版本要求的 Meta_Kim 源码/npm 包根目录：

```sh
node scripts/build-desktop-skill-package.mjs --meta-root /absolute/Meta_Kim --host workbuddy --component financial-modeler --output /absolute/new-financial-method
node scripts/build-desktop-skill-package.mjs --meta-root /absolute/Meta_Kim --host workbuddy --component inventory-replenishment --output /absolute/new-inventory-method
```

每次只选一个 Agent 或 Skill，避免把全部组件挤入一个巨大包。原组件全部资源、可执行脚本、声明的公共图片和 LICENSE/NOTICE 被保留；执行脚本使用原始文件，不执行生成的 loader。实际产物需由当前宿主核验。

两仓共享同一个导出器。Service 检查要求的 Meta 版本；能取得源 Git HEAD 或显式来源记录时还会比对 Meta 的 Service commit pin。`desktop-package.json` 记录 exporter 版本/实现哈希、源版本、组件 revision、实际文件哈希、是否干净工作树，以及 pin 的验证层级。源码 ZIP 没有 Git 元数据时，不从版本号猜 commit。

若已按正式 Release 的 SHA256SUMS 校验独立附件 `SOURCE-REVISION.txt`，可追加 `--source-record /absolute/SOURCE-REVISION.txt`。记录的 commit 会核对仓库、tag、已知 Git HEAD 与依赖 pin；但仅提供文本记录不能证明解压文件就是那个 Git tree，因此 manifest 仍区分声明来源和实际内容哈希。

## 在 WorkBuddy 导入与升级

1. 打开官方「上传技能」入口，选刚生成的一个 ZIP；在已安装列表确认名称、版本与启用状态。没有客户端实际回执时，本仓不将 `installed` 改成 true。
2. 新开一个任务，要求宿主先读取包内 `package-provenance.json` 和原方法入口，确认完整资源可读。按当前宿主模型执行，并遵守用户另行指定的模型限制；模型不可用就报告缺口。
3. 用包内一个样例运行实际脚本，保存产物和错误输出；再用缺项输入验证错误不是假成功。这仍不自动等于行业业务效果认证。
4. 升级前导出或另存本人修改的 Skill/配置。将新版包输出到全新目录、核验后，通过宿主界面更新/重新导入并复核版本。宿主对同名导入的具体处理需实机观察，本脚本不会替用户覆盖旧包。
5. 中断后只继续已记录的未完成任务，核对相同项目、输入版本、已完成产物及下一步。没有真实会话恢复证据时，保留未验证状态。

WorkBuddy 的导出器限额（32 MiB、4096 文件、单文件 8 MiB）是本工具的本地保护界限，**不是已证实的 WorkBuddy 上传上限**。超过上限会停止，不截断方法、丢弃资源或偷偷拆成不完整包。原生导入、模型调用、Hook 执法和专业结果仍须在实际客户端验证。
