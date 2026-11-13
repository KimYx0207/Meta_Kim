# 在豆包工作中使用 Meta_Kim 与 Kim_Service

本入口生成可导入的 **Skill ZIP**，保留选中方法的原始正文、专业合同、配套资料、许可证和文件哈希。Meta 与 Service 共用一个导出器，Service 会检查所选 Meta 版本是否与其发布声明一致。

当前适配级别为 `beta_compatibility`：已实现导出与本地完整性检查，豆包客户端的安装、实际调用、重启恢复和升级仍需真实客户端回执。`installed`、`nativeInvocationVerified`、`nativeExecutionVerified` 保持 `false`。Agent 作为专业方法随 Skill 载入；这不代表已经创建豆包的“工作伙伴”。

## 三种入口要分清

| 入口 | 本次支持情况 | 使用条件 |
| --- | --- | --- |
| 豆包工作的本地技能导入 | 本次导出格式及完整资料入口 | 在当前客户端选择本地技能导入；界面名称以实际版本为准 |
| 豆包开放平台的公开技能上架 | 可参考包内容准备，尚未提交审核 | 平台要求企业认证、评测报告和审核；不以本地导出成功代表上架成功 |
| 豆包应用插件 `apps-plugin` | 本次未接入 | 另有远程 MCP、Manifest、Widget 和单文件 Skill 等要求，不能把本包直接视为此类插件 |

官方产品说明确认本地导入、自定义执行指令及脚本、参考资料、模板能力，见 [飞书官方说明](https://www.feishu.cn/content/article/7677519271848610746)。公开技能提交的 ZIP 限额见 [豆包技能接入指南](https://open.doubao.com/document/doubao-developer-guide/skill-integration-guide)；导出器保守采用 ZIP / 解压总量各 16 MB（16000000 字节）、1024 个条目、单文件 2 MB（2000000 字节）的限制。该限额来自开发者提审规范，并非本轮实测的个人客户端限制。[应用插件开发规范](https://open.doubao.com/apps-plugin/docs/skill-development/overview) 属于独立集成路线。

## Windows：从正式分发包生成两个技能

要求 Node.js 22.13.0 或更高版本、PowerShell，以及可以使用技能导入的豆包工作客户端。下面只下载正式源码、核对 SHA-256 并生成导入包；不会改客户端配置、安装 Hook、登录账号或调用模型。

完整复制到 PowerShell 执行。版本配对为 Meta `v3.13.0` 与 Service `V1.16`。若发布页尚无该版本，应等待对应正式发布，不要自行替换为来源不明的同名包。

```powershell
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw '请先安装 Node.js 22.13.0 或更高版本，再运行本段。'
}
node -e "const [a,b,c]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&(b<13||(b===13&&c<0))))process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 版本低于 22.13.0。' }

$kimDesktopRoot = Join-Path $env:USERPROFILE ('Kim-Desktop-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $kimDesktopRoot | Out-Null

function Get-KimReleaseSource {
    param([string]$Repository, [string]$Tag, [string]$Archive, [string]$Folder)
    New-Item -ItemType Directory -Path $Folder | Out-Null
    $base = "https://github.com/KimYx0207/$Repository/releases/download/$Tag"
    Invoke-WebRequest "$base/SHA256SUMS.txt" -OutFile (Join-Path $Folder 'SHA256SUMS.txt')
    foreach ($name in @($Archive, 'SOURCE-REVISION.txt')) {
        $file = Join-Path $Folder $name
        Invoke-WebRequest "$base/$name" -OutFile $file
        $pattern = '^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($name) + '$'
        $records = @(Get-Content (Join-Path $Folder 'SHA256SUMS.txt') | Where-Object { $_ -match $pattern })
        if ($records.Count -ne 1) { throw "校验清单未唯一列出 $name" }
        $expected = ($records[0] -split '\s+')[0]
        if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $expected) {
            throw "SHA-256 不一致：$name"
        }
    }
    Expand-Archive (Join-Path $Folder $Archive) -DestinationPath $Folder
}

$metaDownload = Join-Path $kimDesktopRoot 'meta'
$serviceDownload = Join-Path $kimDesktopRoot 'service'
Get-KimReleaseSource 'Meta_Kim' 'v3.13.0' 'Meta_Kim-3.13.0-source.zip' $metaDownload
Get-KimReleaseSource 'Kim_Service' 'V1.16' 'Kim_Service-V1.16.zip' $serviceDownload
$metaRoot = Join-Path $metaDownload 'Meta_Kim-3.13.0'
$serviceRoot = Join-Path $serviceDownload 'Kim_Service-V1.16'
$metaRecord = Join-Path $metaDownload 'SOURCE-REVISION.txt'
$serviceRecord = Join-Path $serviceDownload 'SOURCE-REVISION.txt'
$metaOutput = Join-Path $kimDesktopRoot 'doubao-meta'
$serviceOutput = Join-Path $kimDesktopRoot 'doubao-reliability'

node (Join-Path $metaRoot 'scripts/build-desktop-skill-package.mjs') --host doubao --component meta-theory --source-record $metaRecord --output $metaOutput
if ($LASTEXITCODE -ne 0) { throw 'Meta 技能导出失败，请保留完整错误信息。' }
node (Join-Path $serviceRoot 'scripts/build-desktop-skill-package.mjs') --meta-root $metaRoot --host doubao --component reliability-engineer --source-record $serviceRecord --output $serviceOutput
if ($LASTEXITCODE -ne 0) { throw 'Service 技能导出失败，请保留完整错误信息。' }

node (Join-Path $metaRoot 'scripts/build-desktop-skill-package.mjs') --host doubao --component meta-theory --source-record $metaRecord --output $metaOutput --check
if ($LASTEXITCODE -ne 0) { throw 'Meta 导出包读回校验失败。' }
node (Join-Path $serviceRoot 'scripts/build-desktop-skill-package.mjs') --meta-root $metaRoot --host doubao --component reliability-engineer --source-record $serviceRecord --output $serviceOutput --check
if ($LASTEXITCODE -ne 0) { throw 'Service 导出包读回校验失败。' }

Write-Host "导出完成：$kimDesktopRoot"
Get-ChildItem $metaOutput, $serviceOutput -Filter '*.zip' | Select-Object FullName
```

在豆包工作进入“技能·连接器·伙伴”或当前版本对应的技能管理区，选择导入本地技能文件，分别导入上述两个 ZIP。若界面要求文件夹，选择对应解压目录，完整保留其中的 `source/`、`package-provenance.json` 和 `SKILL.md`。不要只复制入口文本。

需要其他岗位时，先在 [Service 能力目录](https://kimyx0207.github.io/Kim_Service/) 按行业和岗位找到稳定组件 ID，再把 `reliability-engineer` 替换为该 ID，并使用新的输出目录。Tool 与 Hook 不通过此入口假装成已安装 Skill。

## 本机验收：先发现，再执行，再续做

导入后在豆包工作发送：

```text
请检查刚导入的 meta-theory 与 reliability-engineer 技能。
先完整读取所选方法的原始入口、capability.json、method.json 和相关参考资料，
报告技能名、组件版本、来源记录、实际读取的资源路径，以及当前可用的文件、脚本和工具权限。
这里只检查发现与资源读取，不调用外部服务，不改我已有的账号、模型、权限或 Hook 配置。
如果缺少资源、执行工具或 Meta CLI，请明确列出缺口，不把导入成功写成执行成功。
```

再提供一份你允许处理的真实故障记录、日志和对应版本，发送：

```text
用已导入的 reliability-engineer 方法处理我提供的故障材料。
区分已知事实、推断和缺少的数据；给出可核对的时间线、证据、影响范围、
根因候选、修复计划、回滚条件、复核方式和遗留风险，并生成实际文件。
不能确认的影响指标保留未知，不编造 MTTR、业务损失或采用结果。
完成一个可核查的阶段后，保存本任务检查点、输入版本、产物路径和下一步，等待我继续。
```

核查文件确实存在、内容引用确实能回到原材料。关闭并重启客户端后，用同一任务继续；它应保留已完成阶段和输入版本，只继续尚未完成的工作。若材料已改动，应识别受影响的结论并复核。

这个便携包提供治理与专业方法。Meta 的实际 Live 服务、宿主领取/回传 CLI 和阶段执行器仍来自单独安装的 Meta runtime。没有真实 CLI、相应权限和执行回执，不能声明整条 Meta 原生主控已运行。

## 更新及配置保留

更新时从同一版本配对的正式源码重新导出到**新目录**。先保留当前技能配置、伙伴挂载关系和一份任务检查点，再用客户端实际提供的更新/替换入口更新同名技能。检查技能名称、版本、完整资源和旧任务是否仍可读取；模型选择、权限和用户材料应保持原状态。

导出器拒绝覆盖既有目录，`--check` 只读回校验。客户端如何处理同名技能、是否重复创建、是否保留伙伴挂载关系，需要在本机实际观察；尚未观察时 `consumerUpdateVerified` 不应变为 `true`。若客户端没有可确认的更新入口，保留旧技能和任务，先在独立测试任务导入新版并比较，勿删除旧任务。

请记录：客户端版本和入口、源包校验值、技能发现结果、实际资源读取、首次执行产物与错误、重启续做、升级前后用户设置差异。脱敏后保存这些回执，才能补齐本机验收证据。
