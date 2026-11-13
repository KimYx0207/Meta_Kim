# Host installation and upgrade observations — 2026-11-14

This report separates shipped-package installation, native host loading, and model-driven execution. The run took place on Linux with Node v24.22.1 (UTC timestamp falls on 2026-11-13; user date is 2026-11-14). No model was called. No existing user HOME/configuration, project trust setting, global Hook opt-in, credential, or account/provider state was changed. All installation roots below were disposable test roots.

## Exact distributed inputs

Downloaded directly from the existing GitHub release assets; no released tag or asset was rebuilt or replaced.

| Asset | SHA-256 |
| --- | --- |
| Meta_Kim v3.12.0 `meta-kim-3.12.0.tgz` | `fcdfed573aeab9edd641d1917221aaf5ee2560fa57eea2a09d680bf06daf8e20` |
| Meta_Kim v3.11.0 `meta-kim-3.11.0.tgz` | `93025f3c742d8393e02bbb6b96f29d7feb81377100d0f263429c57042e6b5d65` |
| Kim_Service V1.15 `Kim_Service-V1.15.zip` | `346c9a147cced86a2221817118e5a54ef7a4c742f526a544161072d60a9abaae` |
| Kim_Service V1.15 `Kim_Service-DSH-V1.15.zip` | `abec2b2ca5288f61fa438f3b768df9dce9c9d079f9d17a5bcb1f0ef39e2981ca` |
| Kim_Service V1.15 `Kim-ZCode-V1.15.zip` | `d63f44042eb8bf725413b71750f0ac5ec25d0cb9d916b626935ad1eeb0cc4542` |

The ZCode manifest identifies `kim-local-reviewed`, Meta 3.12.0, Service 1.15.0, 58 professional roles and 30 Skills. The DSH manifest identifies 89 Service Skills (88 components plus catalog), official DSH 0.2.2-rc.1 and Node >=24.9.0. Reading these manifests is package inspection, not native host acceptance.

## Reproduced defect and narrowly scoped repair

`npm install --prefix <isolated-prefix> --ignore-scripts --no-audit --no-fund <official-tgz>` succeeded. npm correctly hoisted dependencies into `<prefix>/node_modules`. The setup installer checked only `<package>/node_modules/@modelcontextprotocol`, incorrectly concluded dependencies were missing, and started another `npm install` inside the already installed package. Update also unconditionally repeated that command. In a credential-free, network-isolated test environment it entered repeated `EAI_AGAIN` fetches; this attempt was interrupted. This failure was not relabeled successful installation.

The repair recognizes a package actually located at its named `node_modules` location and checks that all declared direct dependency manifests are available along Node's resolution paths. Only that npm-owned installed package skips redundant dependency installation. Source checkout updates keep their existing dependency refresh behavior. Missing/misnamed dependency manifests still fail the shortcut. The helper is included explicitly in `package.json.files`.

Changed implementation: `setup.mjs`, `src/infrastructure/installer/npm-installed-dependencies.mjs`; regression coverage: `tests/setup/npm-installed-dependencies.test.mjs`.

An isolated copy of the distributed v3.12.0 package received this installation-only delta; its own source pins were refreshed, then it was npm-packed and installed into a second prefix. This **unpublished test candidate** retained 3.12.0 only as a local fixture and has SHA-256 `c0c081192213ef8731129acd099921fa7f81086f8c1f836bdb188e2ebd5ee544`. It is not the released v3.12.0 asset and not proof for a later release's full contents. Its npm file table includes the new helper. No release command was run.

## Observed installation and upgrade results

- Candidate **installed public CLI**: `install`, `update`, `check`, with `--silent --scope project --targets codex --project-dir <test-project>` all exited 0, with offline npm enabled. This exercised the npm-packed candidate, not repository setup directly.
- Official v3.11.0 package: project installation exited 0. The candidate then updated the same project and checked it, both exit 0. The old package's own dependencies were provisioned with `npm ci --ignore-scripts` before installation.
- User fixtures survived: unknown `.codex/user-owned.txt`, `.claude/settings.json` and `.zcode/config.json` stayed byte-identical. `.meta-kim/local.overrides.json` retained `userSentinel` and the explicit `dependencyRoots.kim-service` pointing to the extracted official V1.15 root; the installer added its `projectProjectionMode` through merge.
- The interrupted dependency-provisioning attempt was followed by successful candidate installation/update in the same isolated project/home. This proves installer retry on that failure condition; it does not prove resumed model conversations or professional workflow continuity.
- Selecting all six targets in this environment correctly failed readiness when Claude's executable binding was absent. Generated Agent/Skill files alone did not turn that into host acceptance.
- Focused tests: 7 passed across `npm-installed-dependencies`, `installer-runtime-boundary`, and `install-status-semantics`; no full historical release suite was rerun.

This is a bounded consumer upgrade test for the installation delta. It does not set the global `consumerUpdateVerified` flag for all hosts, all versions, the new release, or Service helper execution.

## Native host observation

| Host | Observed evidence | Remaining boundary |
| --- | --- | --- |
| Codex 0.167.0-alpha.4 | Real `app-server` `initialize` and `skills/list` returned `meta-theory`, `scope: repo`, `enabled: true`, `errors: []`, from the installed project `.agents/skills/meta-theory/SKILL.md` | No model, Agent dispatch, artifact execution or conversation-resume verification |
| Claude Code | Executable absent from initial PATH; setup explicitly reported binding unavailable | No native installed/load/invocation claim |
| ZCode | Official release marketplace/versions inspected | No native plugin list/load/invocation claim; executable absent |
| Cursor, Gemini CLI, OpenClaw | Installer projection formats inspected; executables absent | No native load or execution claim; OpenClaw still requires the documented template merge |
| DSH | Official pinned runtime loaded 99 global and 99 project Skills; actual config, read/pruner and local MCP calls passed | No model or native custom-Agent preset claim |

Codex also emitted a material native warning: the isolated project was not trusted, so project-local config, Hooks and exec policies were disabled, while Skills still loaded. The probe did not silently mark the project trusted. An operator must review that trust boundary in their actual client before claiming Agent/config/Hook loading.

## Official DSH probe completed successfully

The probe ran against the **unchanged official v3.12.0 tarball authority** and the official V1.15 DSH zip, using isolated official `@deepseek-ai/dsh@0.2.2-rc.1` modules. Exit status was 0. The immutable package digest matched the downloaded published tarball, not the local installer candidate. Real native config dumping, Skill registry selection, read-tool/pruner behavior and local MCP tool/resource calls were exercised. Global and project install/update/check/uninstall/reinstall lifecycle checks passed; project removal preserved the global installation. A nested mismatched Git root was rejected before writing.

The native provider discovered all 99 Skills in each scope. It read 2,598 resources / 4,830 bounded parts without pruning; the original oversized JSON and source-code controls were pruned as expected. Actual MCP calls listed governance agents and read `meta://skill/meta-theory`. These are real no-model host/tool invocations, **not native model execution, delegation, business quality acceptance or Hook enforcement**. Complete local evidence was saved as `/tmp/kim-host-acceptance-20261114/dsh-native-report.json`; the portable observation excerpt is retained here:

```json
{
  "observedAt": "2026-11-13T16:18:51.118Z",
  "evidenceKind": "native-host-loading-and-mcp",
  "upstream": {
    "repository": "https://github.com/deepseek-ai/deepseek-harness",
    "revision": "fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159",
    "version": "0.2.2-rc.1"
  },
  "nodeVersion": "v24.22.1",
  "modelCalls": 0,
  "nativeModelExecutionVerified": false,
  "nativeDelegationVerified": false,
  "nativeHookEnforcement": false,
  "nativeStageRunner": false,
  "businessQualityAccepted": false,
  "immutablePackageTarballSha256": "fcdfed573aeab9edd641d1917221aaf5ee2560fa57eea2a09d680bf06daf8e20",
  "implementationSha256": {
    "scripts/dsh-profile-package.mjs": "5357feaf1ce8ea2bf72ded1f8432cc0bfd2f525cd1ddb209e74370675c26243e",
    "bin/meta-kim.mjs": "e7c725aa33907408965ffdb8f65209d306183d06974bbaf4164aff7fb3468816",
    "canonical/runtime-assets/dsh/host-contract.json": "5188384c59457e83c875955725d43ce81bf77bc5c5c51684a9554d628fa99393"
  },
  "servicePackageManifestSha256": "c9cd7cd190dcba3ff710367f8438702adce702a985ebe32730205482814e7515",
  "serviceComponents": 88,
  "packedCliLifecycle": {
    "install": "committed",
    "update": "noop",
    "check": "verified_files",
    "uninstall": "committed",
    "reinstalled": true
  },
  "packedProjectCliLifecycle": {
    "install": "committed",
    "update": "noop",
    "check": "verified_files",
    "uninstall": "committed",
    "globalPreservedAfterProjectRemoval": true,
    "nestedGitRootMismatchRejectedBeforeWrite": true
  },
  "nativeReadAndPruning": {
    "ok": true,
    "resourceCount": 2598,
    "partCount": 4830,
    "jsonResourceCount": 842,
    "codeResourceCount": 412,
    "maxRenderedCharacters": 6726,
    "prunedBoundedResults": 0,
    "originalLargeJsonControlWasPruned": true,
    "originalLargeCodeControlWasPruned": true
  },
  "nativeMcpPlugin": {
    "ok": true,
    "toolNames": [
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
      "mcp__meta-kim-runtime__calculate_materials",
      "mcp__meta-kim-runtime__list_meta_agents",
      "mcp__meta-kim-runtime__get_meta_agent",
      "mcp__meta-kim-runtime__get_meta_runtime_capabilities",
      "mcp__meta-kim-runtime__get_meta_runtime_evidence",
      "mcp__meta-kim-runtime__get_meta_effective_runtime_capabilities",
      "mcp__meta-kim-runtime__dispatch_meta_agent"
    ],
    "resourceUris": [
      "meta://theory",
      "meta://runtime-matrix",
      "meta://skill/meta-theory",
      "meta://runtime-evidence",
      "meta://runtime-effective"
    ],
    "canonicalSkillBytes": 117282
  },
  "nativeSkillProvider": {
    "ok": true,
    "count": 99,
    "primaryMethodPartsRead": 181,
    "maxLoaderCharacters": 3342,
    "source": "user-dsh",
    "registrySelectionVerified": true
  },
  "projectNativeSkills": {
    "ok": true,
    "count": 99,
    "primaryMethodPartsRead": 181,
    "maxLoaderCharacters": 3345,
    "source": "project-dsh",
    "registrySelectionVerified": true,
    "nestedWorkingDirectoryRootSelectionVerified": true
  }
}
```

## Full local release gate remains incomplete

The initial source-preparation attempt of `node scripts/run-verify-all.mjs --json` exited 1 in the declared external dependency install preflight: its then-local Service commit was not yet available from the declared GitHub origin. The log also warned about stripped inherited loopback proxy settings; that warning alone does not establish the failure's cause.

After binding the remotely available Service commit `6012c769047ac61c556587c56594fbe660be0214`, a standalone `node scripts/run-verify-all.mjs --probe-all-runtime-global-targets` passed both real external dependency installation and update. The documented `META_KIM_GIT_PROXY` setting carried the managed session proxy explicitly. All four targets declared by that dependency (`claude`, `codex`, `openclaw`, `cursor`) produced identical `findskill/SKILL.md` bytes: 11,572 bytes, SHA-256 `d122dfcf20eabbe24d1d608b79c9bb89f44a1e5b5e7f51d644f21200faccb9c4`. The probe used `external_declared_dependency_no_local_fallback`; it did not substitute a sibling checkout. Gemini and ZCode are outside this dependency's declared install targets. This isolated subcheck does not prove the complete six-host packed-package gate or native execution.

An independent read-only `node scripts/run-runtime-capability-producers.mjs --status --require-fresh` also exited 1: both `claude_code` and `codex` lacked all five required controlled producer observations (`agent`, `subagent`, `shell`, `filesystem`, `apply_patch / edit`) for the current project/profile. Native Skill discovery and the DSH no-model probe above do not supply those observations. The full local gate therefore remains incomplete even if repository CI passes. Exact-commit GitHub workflow results describe their own executed checks; they do not establish native model execution or a `published_bound` full-gate audit.

To close this boundary, use the real authenticated host to generate its supported producer observations, then rerun the complete standard gate in an environment with the declared dependencies and Graphify available. Retain the resulting report and exact package bytes. Do not copy fixtures or translate a successful installer exit into controlled execution evidence.

## Reproduce on the user's machine

Use a fresh test project and an explicit isolated npm prefix first. Do not point a test HOME at a real account or replace an existing configuration file. The commands below are POSIX shell; replace only the three absolute paths. Use the new release asset when available to exercise the repaired installer; the existing v3.12.0 asset retains the defect above.

```sh
KIM_PACKAGE='/absolute/path/to/downloaded-meta-kim.tgz'
KIM_PREFIX='/absolute/path/to/new-test-prefix'
KIM_PROJECT='/absolute/path/to/new-test-project'
mkdir -p "$KIM_PROJECT"
git -C "$KIM_PROJECT" init
npm install --prefix "$KIM_PREFIX" --ignore-scripts --no-audit --no-fund "$KIM_PACKAGE"
node "$KIM_PREFIX/node_modules/meta-kim/bin/meta-kim.mjs" --version
node "$KIM_PREFIX/node_modules/meta-kim/bin/meta-kim.mjs" install --silent --scope project --targets codex --project-dir "$KIM_PROJECT"
node "$KIM_PREFIX/node_modules/meta-kim/bin/meta-kim.mjs" check --scope project --targets codex --project-dir "$KIM_PROJECT"
```

For Claude, Cursor, Gemini or ZCode replace `codex` with `claude`, `cursor`, `gemini` or `zcode`, only after that client's real executable is installed. Reopen the client in `KIM_PROJECT`, review trust in its native UI, inspect its Skill and Agent listing, and retain the actual listing or error. Do not infer native loading from `check` alone. Install does not opt in to global Hooks.

Merge the downloaded Service source root into the existing project's `.meta-kim/local.overrides.json` under `dependencyRoots.kim-service`; preserve other keys. Confirm capability discovery resolves that exact version/source before running a task. A sibling directory alone is not a binding.

For native DSH loading without a model, the repository provides this reproducible probe. Use a checkout corresponding to the package being tested, and the official released Service DSH zip extracted to the directory containing `dsh-package.json`:

```sh
npm install --ignore-scripts --no-audit --no-fund --prefix /absolute/path/to/new-dsh-host @deepseek-ai/dsh@0.2.2-rc.1
node tests/setup/dsh-native-host-probe.mjs --dsh-root /absolute/path/to/new-dsh-host --service-package /absolute/path/to/extracted-service-dsh --report /absolute/path/to/new-dsh-report.json --keep-artifacts
```

For ZCode, extract the official marketplace zip to a persistent directory containing `marketplace.json`, then use its native operations:

```sh
zcode plugins validate /absolute/path/to/kim-zcode
zcode plugins marketplace add /absolute/path/to/kim-zcode --scope user
zcode plugins install kim-service-local@kim-local-reviewed -s user
zcode plugins install meta-kim-local@kim-local-reviewed -s user
zcode plugins list --json
```

The ZCode commands intentionally change the selected user's plugin installation; run them only for the account being accepted. Preserve personal changes before replacing a marketplace directory during upgrade. Verify both native version and selected Agent/Skill after refreshing the marketplace.

For real task execution, use only an explicitly configured Astra-capable host under the user's model restriction. If the host cannot bind Astra, record that blocker; do not silently substitute another model. Ask the host to identify the installed `meta-theory` and Service method paths, execute one supplied example into a new output directory, retain the actual artifact and terminal receipt, then run its malformed-input example and retain the nonzero/error result. Interrupt a task with a written checkpoint, reopen the same project/session, and confirm only unfinished work resumes without overwriting the completed artifact. These last steps remain **unverified here**; package inspection and the no-model probes cannot supply their evidence.

For upgrade, keep sentinel custom configuration and one user-owned Skill, install the previous official package first, replace the CLI using `npm install --prefix "$KIM_PREFIX" ... <new-package>`, then run `update` with the same scope/targets/project and re-open the host. Compare the sentinels byte-for-byte or verify preserved keys for a shared merged JSON file. Retain both old and new versions, exact asset hashes and native discovery output with the result.

## Windows 11：完整 PowerShell 安装、更新和配置保留检查

下面这段在 **v3.12.1 和 V1.16 正式发布且附件齐全之后**使用。若下载返回 404 或校验失败，立即停止，不改成旧版本继续。需要先安装 Node.js 24 和 Codex CLI；只运行无模型安装/检查，不登录、不改真实用户的全局配置或项目信任。无需填写路径，全部放进自动创建的独立临时目录。关闭 PowerShell 后目录仍保留，便于查看日志和产物。

这段使用正式下载包，核对各自 Release 附带的 `SHA256SUMS.txt`，再安装、登记 Service 来源、更新，并确认自定义文件和共享配置字段仍在。发布者提供的 checksum 用于校核下载一致性，不代替签名认证。此命令段经过流程和语法检查，**未在本次 Linux 环境冒充 Windows 实测**。

```powershell
& {
$ErrorActionPreference = 'Stop'
Get-Command node, npm.cmd, codex -ErrorAction Stop | Out-Null
$KimTestRoot = Join-Path ([IO.Path]::GetTempPath()) ('Kim-Acceptance-' + [guid]::NewGuid().ToString('N'))
$KimDownloads = Join-Path $KimTestRoot 'downloads'
$KimPrefix = Join-Path $KimTestRoot 'npm-prefix'
$KimProject = Join-Path $KimTestRoot 'project'
$KimIsolatedHome = Join-Path $KimTestRoot 'isolated-home'
New-Item -ItemType Directory -Force -Path $KimDownloads,$KimPrefix,$KimProject,$KimIsolatedHome | Out-Null

$KimAssets = @(
    @{ Name='meta-kim-3.12.1.tgz'; Base='https://github.com/KimYx0207/Meta_Kim/releases/download/v3.12.1'; Sums='meta-SHA256SUMS.txt' },
    @{ Name='Kim_Service-V1.16.zip'; Base='https://github.com/KimYx0207/Kim_Service/releases/download/V1.16'; Sums='service-SHA256SUMS.txt' }
)
foreach ($KimItem in $KimAssets) {
    $KimFile = Join-Path $KimDownloads $KimItem.Name
    $KimSumsFile = Join-Path $KimDownloads $KimItem.Sums
    Invoke-WebRequest -UseBasicParsing -Uri ($KimItem.Base + '/' + $KimItem.Name) -OutFile $KimFile
    Invoke-WebRequest -UseBasicParsing -Uri ($KimItem.Base + '/SHA256SUMS.txt') -OutFile $KimSumsFile
    $KimPattern = '^[A-Fa-f0-9]{64}\s+\*?' + [regex]::Escape($KimItem.Name) + '$'
    $KimMatching = @(Get-Content -LiteralPath $KimSumsFile | Where-Object { $_ -match $KimPattern })
    if ($KimMatching.Count -ne 1) { throw ('找不到唯一校验记录：' + $KimItem.Name) }
    $KimExpected = ($KimMatching[0] -split '\s+')[0]
    $KimActual = (Get-FileHash -LiteralPath $KimFile -Algorithm SHA256).Hash
    if ($KimActual -ine $KimExpected) { throw ('下载校验失败：' + $KimItem.Name) }
    Write-Host ('SHA256 通过：' + $KimItem.Name)
}
Expand-Archive -LiteralPath (Join-Path $KimDownloads 'Kim_Service-V1.16.zip') -DestinationPath (Join-Path $KimTestRoot 'service')
$KimServiceRoot = Join-Path $KimTestRoot 'service/Kim_Service-V1.16'
if (-not (Test-Path -LiteralPath (Join-Path $KimServiceRoot 'VERSION'))) { throw 'Service 解压目录不完整' }
if ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $KimServiceRoot 'VERSION')).Trim() -ne 'V1.16') { throw 'Service 版本不是 V1.16' }

# 只改变当前进程传给子进程的环境；finally 原样恢复，不修改 Windows 永久环境。
$KimEnvNames = @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','GEMINI_CLI_HOME','DSH_HOME','npm_config_cache','npm_config_userconfig','META_KIM_WITH_GLOBAL_HOOKS','META_KIM_SKIP_OPTIONAL_TOOLS','META_KIM_DISABLE_SIBLING_DEP_PROBE')
$KimSavedEnv = @{}
foreach ($KimName in $KimEnvNames) { $KimSavedEnv[$KimName] = [Environment]::GetEnvironmentVariable($KimName, 'Process') }
$KimOriginalLocation = Get-Location
try {
    foreach ($KimName in @('HOME','USERPROFILE')) { [Environment]::SetEnvironmentVariable($KimName, $KimIsolatedHome, 'Process') }
    foreach ($KimName in @('APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME')) {
        $KimDir = Join-Path $KimIsolatedHome $KimName
        New-Item -ItemType Directory -Force -Path $KimDir | Out-Null
        [Environment]::SetEnvironmentVariable($KimName, $KimDir, 'Process')
    }
    foreach ($KimName in @('CODEX_HOME','CLAUDE_CONFIG_DIR','GEMINI_CLI_HOME','DSH_HOME')) { [Environment]::SetEnvironmentVariable($KimName, $null, 'Process') }
    [Environment]::SetEnvironmentVariable('npm_config_cache', (Join-Path $KimTestRoot 'npm-cache'), 'Process')
    $KimNpmConfig = Join-Path $KimIsolatedHome 'empty.npmrc'
    [IO.File]::WriteAllText($KimNpmConfig, '')
    [Environment]::SetEnvironmentVariable('npm_config_userconfig', $KimNpmConfig, 'Process')
    [Environment]::SetEnvironmentVariable('META_KIM_WITH_GLOBAL_HOOKS', '0', 'Process')
    [Environment]::SetEnvironmentVariable('META_KIM_SKIP_OPTIONAL_TOOLS', '1', 'Process')
    [Environment]::SetEnvironmentVariable('META_KIM_DISABLE_SIBLING_DEP_PROBE', '1', 'Process')
    Set-Location -LiteralPath $KimProject
    & npm.cmd install --global=false --prefix $KimPrefix --ignore-scripts --no-audit --no-fund (Join-Path $KimDownloads 'meta-kim-3.12.1.tgz')
    if ($LASTEXITCODE -ne 0) { throw 'npm 安装失败' }
    $KimCli = Join-Path $KimPrefix 'node_modules/meta-kim/bin/meta-kim.mjs'
    $KimCliVersion = & node $KimCli --version
    if ($LASTEXITCODE -ne 0) { throw 'CLI 版本检查失败' }
    if (($KimCliVersion -join "`n").Trim() -notmatch '^3\.12\.1$') { throw ('CLI 版本不符：' + $KimCliVersion) }
    Write-Host ('Meta_Kim 版本：' + $KimCliVersion)
    New-Item -ItemType Directory -Force -Path (Join-Path $KimProject '.meta-kim'),(Join-Path $KimProject '.codex') | Out-Null
    $KimUtf8 = New-Object System.Text.UTF8Encoding($false)
    $KimOverrides = Join-Path $KimProject '.meta-kim/local.overrides.json'
    $KimSettings = @{ userSentinel='keep-me'; dependencyRoots=@{ 'kim-service'=$KimServiceRoot.Replace('\','/') } }
    [IO.File]::WriteAllText($KimOverrides, ($KimSettings | ConvertTo-Json -Depth 5), $KimUtf8)
    $KimSentinel = Join-Path $KimProject '.codex/user-owned.txt'
    [IO.File]::WriteAllText($KimSentinel, 'keep this user-owned file', $KimUtf8)
    $KimSentinelHash = (Get-FileHash -LiteralPath $KimSentinel -Algorithm SHA256).Hash
    foreach ($KimMode in @('install','check','update','check')) {
        & node $KimCli $KimMode --silent --scope project --targets codex --project-dir $KimProject
        if ($LASTEXITCODE -ne 0) { throw ('未通过：' + $KimMode + '；保留当前目录用于排查，不继续声称成功') }
    }
    if ((Get-FileHash -LiteralPath $KimSentinel -Algorithm SHA256).Hash -ne $KimSentinelHash) { throw '用户文件被改变' }
    $KimAfter = Get-Content -Raw -Encoding UTF8 -LiteralPath $KimOverrides | ConvertFrom-Json
    if ($KimAfter.userSentinel -ne 'keep-me') { throw '用户配置字段丢失' }
    if ($KimAfter.dependencyRoots.'kim-service' -ne $KimServiceRoot.Replace('\','/')) { throw 'Service 来源绑定丢失' }
    Write-Host '安装、同版本更新、check 与用户配置保留检查全部通过。'
    Write-Host ('独立测试项目：' + $KimProject)
    Write-Host ('独立宿主 HOME：' + $KimIsolatedHome)
    Write-Host '这还不是模型执行验收；未启用全局 Hook，也未自动信任项目。'
}
finally {
    foreach ($KimName in $KimEnvNames) { [Environment]::SetEnvironmentVariable($KimName, $KimSavedEnv[$KimName], 'Process') }
    Set-Location -LiteralPath $KimOriginalLocation.Path
}
}
```

这个脚本验证新正式包的安装与**同版本重入更新**；本报告前面的 v3.11.0 → 安装修复候选才是旧版升级观察，两者不能互换。脚本结束后环境已恢复。需要真实客户端验收时，在 Codex 中手动打开打印出的独立测试项目；自行审核是否信任、确认当前账户与 Astra 模型，再查看 Skill/Agent 发现、运行示例、核对产物/错误和中断恢复。不要因为 `check` 为绿色就把这些步骤写成已完成；不要将隔离目录里的空凭证配置覆盖到真实用户目录。
