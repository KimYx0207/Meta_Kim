import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGlobalMetaTheorySyncArgs } from "../../scripts/node-spawn-config.mjs";
import {
  GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
  globalProjectionIsOwnedBy,
  resolveRuntimeProfilesFromManifest,
} from "../../scripts/meta-kim-sync-config.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const syncManifest = JSON.parse(
  readFileSync(path.join(repoRoot, "config", "sync.json"), "utf8"),
);
const runtimeProfiles = resolveRuntimeProfilesFromManifest(syncManifest);
const packageJson = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const distribution = JSON.parse(
  readFileSync(path.join(repoRoot, "config", "distribution.json"), "utf8"),
);
const readmeEn = readFileSync(path.join(repoRoot, "README.md"), "utf8");
const readmeZh = readFileSync(path.join(repoRoot, "README.zh-CN.md"), "utf8");

describe("setup update default flow", () => {
  test("default meta:test:setup includes the core Graphify runtime unit tests", () => {
    const runtimeTest = readFileSync(
      path.join(repoRoot, "tests", "setup", "graphify-runtime.test.mjs"),
      "utf8",
    );
    assert.match(packageJson.scripts["meta:test:setup"], /tests\/setup\/\*\.test\.mjs/);
    assert.match(packageJson.scripts["meta:test:setup"], /--exclude-import "node:child_process"/);
    assert.doesNotMatch(runtimeTest, /["']node:child_process["']/);
    assert.match(runtimeTest, /does not fall back to a stale PATH Graphify/);
  });

  test("update does not add a redundant final confirmation or map cancellation to complete", () => {
    assert.doesNotMatch(source, /updateConfirmCopy/);
    assert.doesNotMatch(source, /return summarizeInstallStatus\(\[\]\)/);
  });
  const source = readFileSync(path.join(repoRoot, "setup.mjs"), "utf8");
  const i18nStrings = readFileSync(path.join(repoRoot, "config", "i18n", "setup-strings.mjs"), "utf8");
  const projectFileSafetySource = readFileSync(
    path.join(repoRoot, "scripts", "project-bootstrap-file-safety.mjs"),
    "utf8",
  );
  const syncConfigSource = readFileSync(
    path.join(repoRoot, "scripts", "meta-kim-sync-config.mjs"),
    "utf8",
  );

  test("--update takes precedence over non-TTY silent install mode", () => {
    const mainSource = source.slice(source.indexOf("async function main()"));
    const updateBranch = mainSource.indexOf("if (updateMode)");
    const silentBranch = mainSource.indexOf("if (silentMode)");

    assert.ok(updateBranch >= 0, "main() must branch on updateMode");
    assert.ok(silentBranch >= 0, "main() must branch on silentMode");
    assert.ok(
      updateBranch < silentBranch,
      "--update must run runUpdate() before silentMode can fall back to runInstall()",
    );
  });

  test("silent mode list prompts choose defaults without waiting for stdin", () => {
    assert.match(
      source,
      /async function keyboardSelect[\s\S]*?if \(silentMode\) return 0;/,
      "single-select prompts must choose the first/default option in silent mode",
    );
    assert.match(
      source,
      /async function keyboardMultiSelect[\s\S]*?if \(silentMode\) return defaultIds;/,
      "multi-select prompts must choose default ids in silent mode",
    );
  });

  test("interactive prompts fall back before npm dependencies are installed", () => {
    assert.match(source, /function isMissingInquirerPromptsError/);
    assert.match(source, /async function importInquirerPrompt/);
    assert.match(source, /numberedSelectFallback\(question, options\)/);
    assert.match(
      source,
      /numberedMultiSelectFallback\(question, choices, defaultIds, hintText\)/,
    );
  });

  test("install/update direct-enter defaults stay on Claude Code and Codex", () => {
    assert.deepEqual(syncManifest.defaultTargets, ["claude", "codex"]);
    assert.match(
      packageJson.scripts["meta:deps:install"],
      /--targets claude,codex$/,
    );
    assert.match(
      packageJson.scripts["meta:deps:update"],
      /--update --targets claude,codex$/,
    );
    assert.match(
      packageJson.scripts["meta:deps:install:all-runtimes"],
      /--targets claude,codex,openclaw,cursor$/,
    );
    assert.match(
      packageJson.scripts["meta:deps:update:all-runtimes"],
      /--update --targets claude,codex,openclaw,cursor$/,
    );
    assert.match(
      source,
      /askMultiSelectTargets\(\s*t\.selectRuntimeTargets,\s*RUNTIME_CHOICES,\s*defaultTargets,\s*\)/,
    );
    assert.match(
      source,
      /const reselectTargets = await askYesNo\(t\.askReselectRuntimes, true\)/,
    );
  });

  test("install scope direct-enter default is global reusable capabilities", () => {
    const askScopeStart = source.indexOf("async function askInstallScope()");
    const askScopeEnd = source.indexOf("// ── Directory structure explanation", askScopeStart);
    const askScopeSource = source.slice(askScopeStart, askScopeEnd);

    assert.match(
      askScopeSource,
      /const explicitScope = scopeArgIndex >= 0 \? args\[scopeArgIndex \+ 1\] : null;/,
      "explicit --scope must take precedence in both interactive and silent setup",
    );
    assert.equal(distribution.installDefaults.silentScope, "global");
    assert.equal(distribution.installDefaults.interactiveScope, "global");
    assert.match(
      askScopeSource,
      /const configuredDefault = silentMode[\s\S]*?DISTRIBUTION\.installDefaults\.silentScope[\s\S]*?DISTRIBUTION\.installDefaults\.interactiveScope/,
      "interactive and silent defaults must come from the distribution config",
    );
    assert.doesNotMatch(
      askScopeSource,
      /promptInstallScope/,
      "interactive install/update must always show the global vs project choice",
    );
    assert.ok(
      askScopeSource.indexOf('id: "global"') < askScopeSource.indexOf('id: "project"'),
      "interactive direct-Enter must choose global scope before project-only",
    );
    assert.doesNotMatch(
      askScopeSource,
      /id: "both"|installScopeBoth/,
      "install scope must be a two-way choice: global or project directories",
    );
    assert.doesNotMatch(
      source,
      /cleanupLegacySkills\("both"\)/,
      "legacy two-scope install mode must not survive in project deploy helpers",
    );
  });

  test("distribution scope and existing project projection state stay separate", () => {
    assert.match(
      source,
      /function rememberProjectProjectionMode\(targetDirs\)/,
      "setup must update project state only for concrete project targets",
    );
    assert.match(
      source,
      /projectProjectionMode: "project"/,
      "a successfully refreshed managed project remains a project projection",
    );
    assert.doesNotMatch(
      source,
      /rememberProjectProjectionMode\(needGlobal \? "global_only" : "project"\)|projectProjectionMode: mode/,
      "choosing global must not eagerly rewrite existing project state to global_only",
    );
    assert.match(
      source,
      /if \([\s\S]*?needProject &&[\s\S]*?summarizeInstallStatus\(stepResults\)\.status === "complete"[\s\S]*?rememberProjectProjectionMode/,
      "an explicit project refresh must commit project mode only after the full required install path succeeds",
    );
    const updateSource = source.slice(
      source.indexOf("async function runUpdate()"),
      source.indexOf("async function runCheck()"),
    );
    assert.match(
      updateSource,
      /if \(needProject[\s\S]*?rememberProjectProjectionMode/,
      "explicit project update success must persist project topology",
    );
  });

  test("repo-local setup checks validate the global-only hook dependency pairs and active targets", () => {
    assert.match(
      source,
      /function checkProjectRuntimeSync\(runtimes, targetContext\) \{[\s\S]*?executingStableProjectionPackage[\s\S]*?\? CALLER_CWD[\s\S]*?: PROJECT_DIR[\s\S]*?projectProjectionMode === "global_only"[\s\S]*?return checkGlobalOnlyProjectHookPairs\(projectRoot\);[\s\S]*?return checkSync\(runtimes, targetContext\.activeTargets, projectRoot\);/,
      "global_only must validate its project hook dependency set instead of returning true unconditionally",
    );
    assert.match(
      source,
      /function checkGlobalOnlyProjectHookPairs\(projectRoot = PROJECT_DIR\)/,
    );
    assert.match(source, /\.claude\/hooks[\s\S]*?\.codex\/hooks[\s\S]*?\.cursor\/hooks/);
    assert.match(source, /activate-meta-theory-spine\.mjs/);
    assert.match(source, /project-root\.mjs/);
    const pairCheckStart = source.indexOf("function checkGlobalOnlyProjectHookPairs");
    const pairCheckEnd = source.indexOf("function checkProjectRuntimeSync", pairCheckStart);
    const pairCheckSource = source.slice(pairCheckStart, pairCheckEnd);
    assert.match(pairCheckSource, /readFileSync\(activator, "utf8"\)/);
    assert.match(pairCheckSource, /activatorExists && resolverExists && importsResolver/);
    assert.doesNotMatch(
      source.slice(
        source.indexOf("function checkProjectRuntimeSync"),
        source.indexOf("function reportProjectRuntimeSyncResult"),
      ),
      /return true;/,
      "global_only sync checks must not keep the old unconditional success path",
    );

    const checkOnlyStart = source.indexOf("if (checkOnly) {");
    const checkOnlyEnd = source.indexOf("if (updateMode)", checkOnlyStart);
    const checkOnlySource = source.slice(checkOnlyStart, checkOnlyEnd);
    assert.match(
      checkOnlySource,
      /const checkOk = await runCheck\(\)/,
      "--check must route through the single scope-aware check implementation",
    );
    assert.match(checkOnlySource, /process\.exit\(checkOk \? 0 : 1\)/);
    assert.doesNotMatch(
      checkOnlySource,
      /checkSync\(detectedRuntimes, targetContext\.supportedTargets\)/,
      "--check must not require every supported runtime projection",
    );

    const updateCheckStart = source.indexOf("// ── 6. Validate installed artifacts");
    const updateCheckEnd = source.indexOf("console.log(`\\n${C.bold}${C.green}✓ ${t.updateComplete}", updateCheckStart);
    const updateCheckSource = source.slice(updateCheckStart, updateCheckEnd);
    assert.match(
      updateCheckSource,
      /if \(needProject\) \{[\s\S]*?checkSync\(runtimes, activeTargets\);[\s\S]*?\}/,
      "project-scope update validation must check only selected active targets",
    );
    assert.doesNotMatch(
      updateCheckSource,
      /supportedTargets/,
      "project-scope update validation must not expand to all supported runtimes",
    );

    const runCheckStart = source.indexOf("async function runCheck()");
    const runCheckEnd = source.indexOf("main().catch", runCheckStart);
    const runCheckSource = source.slice(runCheckStart, runCheckEnd);
    assert.match(
      runCheckSource,
      /const checkScope = scopeArgIndex >= 0 \? args\[scopeArgIndex \+ 1\] : "project"/,
      "runCheck() must preserve project as the default scope",
    );
    assert.match(
      runCheckSource,
      /checkScope === "global"[\s\S]*?checkGlobalRuntimeSync\(targetContext\.activeTargets\)[\s\S]*?: checkProjectRuntimeSync\(runtimes, targetContext\)/,
      "explicit global check must verify the manifest-bound stable authority while project/default keeps project checks",
    );
    assert.match(runCheckSource, /reportProjectRuntimeSyncResult\(syncOk\)/);
    assert.match(
      runCheckSource,
      /const stateRepoPath = checkScope === "global"[\s\S]*?homedir\(\)[\s\S]*?executingStableProjectionPackage \? CALLER_CWD : PROJECT_DIR[\s\S]*?stateRoot: join\(stateRepoPath, "\.meta-kim", "state"\)[\s\S]*?getProfilePaths\(stateOptions\)[\s\S]*?readProfileMetadata\(stateOptions\)/,
      "check output must describe the same global or caller-project state it actually checked",
    );
    assert.match(runCheckSource, /return syncOk;/);
    assert.doesNotMatch(
      runCheckSource,
      /checkSync\(runtimes, targetContext\.supportedTargets\)/,
      "runCheck() must not require every supported runtime projection",
    );
  });

  test("global install and update hand off to the immutable package before persistent writes", () => {
    assert.match(source, /async function handOffGlobalSetupIfNeeded\(/);
    assert.match(source, /verifyExecutingGlobalProjectionPackage\(/);
    assert.match(source, /materializeGlobalProjectionPackage\(/);
    assert.match(source, /sanitizeProjectionPackageEnvironment\(/);
    assert.match(source, /join\(stablePackage\.packageRoot, "setup\.mjs"\)/);
    assert.match(source, /childEnv\.META_KIM_CALLER_CWD = CALLER_CWD/);
    assert.match(
      source,
      /childEnv\[STABLE_PROJECT_DEPLOYMENTS_ENV\] = JSON\.stringify\([\s\S]*?targetDir:[\s\S]*?activeTargets:/,
      "stable handoff must preserve each managed project's path and runtime targets as structured data",
    );
    assert.doesNotMatch(
      source,
      /deployDirs\.flatMap\(\(targetDir\) => \["--project-dir", targetDir\]\)/,
      "managed project objects must never be coerced into [object Object] CLI paths",
    );
    assert.match(
      source,
      /function stableProjectDeploymentHandoff\(\)[\s\S]*?JSON\.parse\(raw\)[\s\S]*?resolveExistingManagedProjectCandidates\([\s\S]*?Stable project deployment targets changed before execution/,
      "stable child must revalidate the handed-off project manifest and its saved runtime targets",
    );
    assert.match(
      source,
      /async function detectExecutingStableProjectionPackage\(\)[\s\S]*?verifyExecutingGlobalProjectionPackage\([\s\S]*?projectionPackageWriteBoundaryFindings\([\s\S]*?PROJECT_DIR[\s\S]*?unverified package inside the projection store cannot execute setup/,
      "an invalid package already inside the immutable store must fail closed",
    );
    assert.match(
      syncConfigSource,
      /export const localStateRoot = process\.env\.META_KIM_CALLER_CWD[\s\S]*?: path\.resolve\(process\.cwd\(\)\);[\s\S]*?export const localOverridesPath = path\.join\(\s*localStateRoot/,
      "stable package preferences must be written to the caller project, not the immutable package",
    );
    assert.match(
      source,
      /async function writeLocalOverrides\(nextOverrides\)[\s\S]*?projectionPackageWriteBoundaryFindings\([\s\S]*?localOverridesPath[\s\S]*?if \(findings\.length > 0\) return false;[\s\S]*?persistLocalOverrides\(nextOverrides\)/,
      "direct stable setup execution must not persist state into its package or projection store",
    );

    const mainSource = source.slice(source.indexOf("async function main()"));
    assert.ok(
      mainSource.indexOf("executingStableProjectionPackage =") <
        mainSource.indexOf("if (projectBootstrapMode)"),
      "stable package execution must be identified before every project mutation shortcut",
    );
    assert.match(
      source,
      /async function runProjectBootstrapCli\(\)[\s\S]*?if \(applyMode\) \{[\s\S]*?assertProjectPersistentWriteBoundary\(targetDirs, "project bootstrap"\)/,
    );
    assert.match(
      source,
      /async function runProjectCleanupCli\(\)[\s\S]*?assertProjectPersistentWriteBoundary\(targetDirs, "project cleanup"\)/,
    );

    const installSource = source.slice(
      source.indexOf("async function runInstall()"),
      source.indexOf("async function runUpdate()"),
    );
    const installHandoff = installSource.indexOf("handOffGlobalSetupIfNeeded");
    assert.ok(installHandoff > installSource.indexOf("const confirm = await askYesNo"));
    assert.ok(installHandoff < installSource.indexOf("// 步骤计数"));
    assert.match(
      installSource,
      /mode: "install"[\s\S]*?skillIds: selectedSkillIds[\s\S]*?deployDirs/,
    );
    assert.match(installSource, /assertProjectPersistentWriteBoundary\(deployDirs, "install project target"\)/);

    const updateSource = source.slice(
      source.indexOf("async function runUpdate()"),
      source.indexOf("async function runCheck()"),
    );
    const updateHandoff = updateSource.indexOf("handOffGlobalSetupIfNeeded");
    assert.ok(updateHandoff > updateSource.indexOf("const updateSkillIds"));
    assert.ok(updateHandoff < updateSource.indexOf("// ── 1. npm install"));
    assert.match(
      updateSource,
      /if \(executingStableProjectionPackage\)[\s\S]*?INSTALL_STEP_OUTCOME\.SKIPPED[\s\S]*?else \{[\s\S]*?spawnCliSync\("npm", \["install"\]/,
      "a verified immutable package must not mutate its own closure with npm install in any scope",
    );
    assert.match(updateSource, /assertProjectPersistentWriteBoundary\(deployDirs, "update project target"\)/);
    assert.match(
      updateSource,
      /if \(needProject\) \{\s*if \(executingStableProjectionPackage\)[\s\S]*?INSTALL_STEP_OUTCOME\.SKIPPED[\s\S]*?SETUP_NODE_CHILD\.RUNTIME_SYNC/,
      "project update from the stable public CLI must project directly to targets instead of syncing into the package root",
    );
    assert.match(source, /async function stableProjectionPackageIntegrityOk\(\)/);
    assert.match(source, /mergeDelegatedGlobalSetupResult\([\s\S]*?explicit_project_dirs/);
    assert.match(
      source,
      /async function installPythonTools\([\s\S]*?Graphify project integration[\s\S]*?join\(homedir\(\), "\.claude", "settings\.json"\)[\s\S]*?Graphify user Hook reconciliation/,
      "Graphify must protect both project and user-level Hook destinations from store junctions",
    );
    assert.match(
      source,
      /async function refreshRuntimeExecutableBindings\([\s\S]*?host-executable-bindings\.json[\s\S]*?runtime executable inventory/,
      "runtime inventory must validate its exact descendant write target",
    );
  });

  test("global cleanup preserves local override state", () => {
    const localStateStart = source.indexOf("const PROJECT_META_KIM_LOCAL_STATE_RELS");
    const localStateEnd = source.indexOf("const PROJECT_HOOK_REL_DIRS_BY_PLATFORM", localStateStart);
    const localStateSource = source.slice(localStateStart, localStateEnd);
    assert.doesNotMatch(
      localStateSource,
      /"\.meta-kim",/,
      "global cleanup must not remove .meta-kim/local.overrides.json",
    );
    assert.match(
      localStateSource,
      /"\.meta-kim\/state\/default\/project-bootstrap\.json"/,
      "cleanup can remove the old bootstrap manifest without deleting the whole local state root",
    );
  });

  test("cleanup exposes retryable failure states and keeps the manifest until retry closes", () => {
    assert.match(projectFileSafetySource, /const PROJECT_CLEANUP_RETRYABLE_REASONS = new Map/);
    assert.match(projectFileSafetySource, /\["backup_failed_preserved", "partial"\]/);
    assert.match(projectFileSafetySource, /\["manifest_hash_mismatch_preserved", "partial"\]/);
    assert.match(projectFileSafetySource, /\["legacy_manifest_missing_hash_preserved", "partial"\]/);
    assert.match(projectFileSafetySource, /\["unsafe_realpath_or_link_preserved", "blocked"\]/);
    assert.match(
      source,
      /preserveManifest: retryableBeforeLocalState\.length > 0/,
    );
    assert.match(
      source,
      /ok: results\.every\(\(result\) => result\.status === "ok"\)/,
    );
    assert.doesNotMatch(source, /metaKimProjectionSignature/);
    assert.match(
      source,
      /rel === "\.claude\/project-task-state\.json"[\s\S]*?!projectRemovalProof\(targetDir, rel\)/,
    );
  });

  test("install copy keeps reusable capabilities global by default", () => {
    assert.doesNotMatch(
      source,
      /Existing projects can use Meta_Kim without setup|现有项目无需安装即可使用|既存プロジェクトもセットアップ不要|기존 프로젝트도 설치 없이/,
      "setup copy must not claim global install automatically governs every existing project",
    );
    assert.match(
      i18nStrings,
      /Global capabilities \(recommended\)/,
      "English setup copy must name global capabilities as the recommended default",
    );
    assert.match(
      i18nStrings,
      /全局通用能力（推荐）/,
      "Chinese setup copy must name global capabilities as the recommended default",
    );
    assert.match(
      readmeEn,
      /default Enter path is \*\*global reusable capabilities\*\*/,
      "README must describe the default install as global capabilities",
    );
    assert.match(
      readmeZh,
      /默认直接回车的路径是：\*\*全局通用能力\*\*/,
      "Chinese README must describe the default install as global capabilities",
    );
    assert.deepEqual(syncManifest.projectMaterializationPolicy.globalByDefault, [
      "agents",
      "commands",
      "mcp",
      "skills",
    ]);
    assert.equal(
      syncManifest.projectMaterializationPolicy.projectRuntimeAssetCopyPolicy,
      "copy_to_project_when_explicit_project_update_or_project_dedicated_extension",
    );
    assert.doesNotMatch(
      `${readmeEn}\n${readmeZh}`,
      /global installation .* work in any project|全局安装后在任何项目中都能工作/s,
      "README must not collapse global capability into automatic project governance",
    );
  });

  test("silent project scope targets cwd unless CLI/saved targets are requested", () => {
    const deployFunctionStart = source.indexOf(
      "async function askDeployDirectory()",
    );
    const deployFunctionEnd = source.indexOf(
      "function printProjectDeploySummary",
      deployFunctionStart,
    );
    const deploySource = source.slice(deployFunctionStart, deployFunctionEnd);
    const silentBranch = deploySource.indexOf("if (silentMode)");
    const cwdReturn = deploySource.indexOf("return uniqueProjectDeployDirs([CALLER_CWD]);", silentBranch);
    const selectPrompt = deploySource.indexOf("askSelect(");

    assert.ok(
      deployFunctionStart >= 0,
      "askDeployDirectory() must exist in setup.mjs",
    );
    assert.ok(
      silentBranch >= 0,
      "askDeployDirectory() must special-case silent/default flow",
    );
    assert.ok(
      deploySource.indexOf("cliProjectDeployDirs.length > 0") >= 0,
      "askDeployDirectory() must honor explicit CLI project targets before silent fallback",
    );
    assert.ok(
      deploySource.indexOf("useSavedProjectDirsMode") >= 0,
      "askDeployDirectory() must honor saved project targets before silent fallback",
    );
    assert.ok(
      cwdReturn > silentBranch,
      "silent project scope must project into the caller cwd instead of the packed source root",
    );
    assert.ok(
      selectPrompt >= 0,
      "askDeployDirectory() must keep the interactive project deploy choice",
    );
    assert.ok(
      cwdReturn < selectPrompt,
      "askDeployDirectory() must resolve the silent cwd before interactive prompting",
    );
  });

  test("global install/update refreshes only existing managed projects and keeps cleanup explicit", () => {
    assert.match(
      source,
      /const handedOffProjectResolution = stableProjectDeploymentHandoff\(\);[\s\S]*?const managedProjectResolution = needProject\s*\? \{ deployments: await askDeployDirectory\(\), rejected: \[\] \}\s*:\s*\(handedOffProjectResolution \?\? await existingManagedProjectDeployments\(\)\);[\s\S]*?const deployDirs = managedProjectResolution\.deployments;/,
      "global install/update must reuse either the verified stable handoff or existing managed projects without a new prompt",
    );
    const installSource = source.slice(
      source.indexOf("async function runInstall()"),
      source.indexOf("async function runUpdate()"),
    );
    const updateSource = source.slice(
      source.indexOf("async function runUpdate()"),
      source.indexOf("async function runCheck()"),
    );
    assert.doesNotMatch(installSource, /askProjectCleanupDirectory|cleanupProjectRedundancyDirs/);
    assert.doesNotMatch(updateSource, /askProjectCleanupDirectory|cleanupProjectRedundancyDirs/);
    assert.match(source, /projectCleanupMode/);
    assert.match(source, /runProjectCleanupCli/);
    assert.match(source, /--cleanup-projects/);
    assert.equal(
      syncManifest.projectMaterializationPolicy.existingProjectProjectionUpdate.cleanupMode,
      "explicit_only",
    );
    assert.equal(
      syncManifest.projectMaterializationPolicy.existingProjectProjectionUpdate.noManagedProjectAction,
      "do_not_materialize_project_projection",
    );
    const existingProjectResolver = source.slice(
      source.indexOf("async function existingManagedProjectDeployDirs()"),
      source.indexOf("function projectDeployConfigDisplayPath", source.indexOf("async function existingManagedProjectDeployDirs()")),
    );
    assert.match(existingProjectResolver, /current_working_directory: \[\{ targetDir: CALLER_CWD, source: "current_working_directory" \}\]/);
    assert.match(existingProjectResolver, /resolveExistingManagedProjectCandidates\(candidates/);
    assert.doesNotMatch(existingProjectResolver, /mkdirSync|applyProjectBootstrapToDir/);
    assert.doesNotMatch(source, /includeSelfCleanup/);
    assert.match(
      source,
      /let deployResults = \[\];\s*if \(deployDirs\.length > 0\) \{\s*deployResults = await copyToDeployDirs\(activeTargets, deployDirs\);[\s\S]*?deployResults\.length === deployDirs\.length &&[\s\S]*?item\.status === "ok" && item\.stateStatus === "ready"/,
    );
    assert.match(source, /copyToDeployDirs\(activeTargets, targetDirs\)/);
    assert.match(source, /projectDeployProtectionNote/);
    assert.match(source, /reportRejectedManagedProjectTargets\(managedProjectResolution\.rejected\)/);
    assert.match(source, /item\.source === "explicit_project_dirs"[\s\S]*?installStep\(t\.managedProjectRejectedStep, false\)/);
    assert.match(source, /rejectedManagedProjects: managedProjectResolution\.rejected/);
    assert.match(source, /projectCleanupProtectionNote/);
    assert.match(
      i18nStrings,
      /askProjectRedundantCleanup:\s*"[^"]*\\n[^"]*\\n[^"]*"/,
      "project cleanup prompt must be line-broken instead of one long terminal line",
    );
    const cleanupFunctionStart = source.indexOf(
      "async function askProjectCleanupDirectory()",
    );
    const cleanupFunctionEnd = source.indexOf(
      "function printProjectDeploySummary",
      cleanupFunctionStart,
    );
    const cleanupFunctionSource = source.slice(
      cleanupFunctionStart,
      cleanupFunctionEnd,
    );
    assert.ok(
      cleanupFunctionSource.indexOf("printProjectDeployDirList(") <
        cleanupFunctionSource.indexOf("askYesNo(t.askProjectRedundantCleanup"),
      "global cleanup must show saved project directories before asking y/N",
    );
    assert.match(
      source,
      /const wantCleanup = await askYesNo\(t\.askProjectRedundantCleanup, true\);[\s\S]*?if \(savedDirs\.length === 0\) \{[\s\S]*?const dirs = await collectProjectDeployDirs\(false\);/,
      "answering yes to global cleanup must force directory entry when no saved directories exist",
    );
    assert.match(
      cleanupFunctionSource,
      /projectCleanupUseSaved\(savedDirs\.length\)/,
      "cleanup mode must label saved project selection as cleanup, not update",
    );
    assert.match(
      cleanupFunctionSource,
      /projectCleanupSelectAndRemember/,
      "cleanup mode must label saved-directory edits as cleanup",
    );
    assert.match(
      cleanupFunctionSource,
      /projectCleanupSelectOnce/,
      "cleanup mode must label one-time directory selection as cleanup",
    );
    assert.doesNotMatch(
      cleanupFunctionSource,
      /projectDeployUseSaved\(savedDirs\.length\)|projectDeploySelectAndRemember|projectDeploySelectOnce/,
      "cleanup mode must not reuse project update menu labels",
    );
  });

  test("external project deploy reuses protected project bootstrap apply", () => {
    assert.match(source, /async function applyProjectBootstrapToDir\(activeTargets, targetDir\)/);
    assert.match(
      source,
      /const bootstrapResult = await applyProjectBootstrapToDir\(activeTargets, targetDir\);/,
    );
    assert.match(source, /const transactionPlan = projectBootstrapTransactionalPlan\(plan, targetDir, backup\)/);
    assert.match(source, /transactionLabel: "project-bootstrap-apply"/);
    assert.match(source, /phase: "manifest"/);
    assert.doesNotMatch(source, /createProjectBootstrapBackup\(/);
    assert.match(
      source,
      /const PROJECT_MUTATION_SESSION_LOCK_KEY = "project-mutation-session"/,
    );
    assert.equal(
      (source.match(/lockKey: PROJECT_MUTATION_SESSION_LOCK_KEY/g) ?? []).length,
      2,
      "bootstrap and cleanup must share the same outer project mutation lock",
    );
    assert.doesNotMatch(source, /project-(?:bootstrap|cleanup)-session/);
  });

  test("project install restores hooks while global cleanup removes project hook residue", () => {
    const applyStart = source.indexOf("async function applyProjectBootstrapToDir");
    const applyEnd = source.indexOf("function classifyProjectBootstrapError", applyStart);
    const applySource = source.slice(applyStart, applyEnd);
    assert.doesNotMatch(
      applySource,
      /migrateProjectMetaKimHooksForBootstrap/,
      "project install/apply must not run project hook cleanup first",
    );

    const deployStart = source.indexOf("function deployPlatformFiles");
    const deployEnd = source.indexOf("function buildPostCopyBootstrapScript", deployStart);
    const deploySource = source.slice(deployStart, deployEnd);
    assert.match(
      deploySource,
      /writeProjectGeneratedHooks\(platformId, targetDir, protectedPaths\)/,
    );

    const planStart = source.indexOf("function collectProjectDeployPlan");
    const planEnd = source.indexOf("function readPackageVersion", planStart);
    const planSource = source.slice(planStart, planEnd);
    assert.match(
      planSource,
      /projectHookGeneratedPlans\(platformId, targetDir, protectedPaths\)/,
    );

    const protectedJsonStart = source.indexOf("function plannedProtectedProjectDeployJson");
    const protectedJsonEnd = source.indexOf("function plannedProtectedProjectDeployText", protectedJsonStart);
    const protectedJsonSource = source.slice(protectedJsonStart, protectedJsonEnd);
    assert.doesNotMatch(
      protectedJsonSource,
      /stripProjectMetaKimHooksFromHookConfig/,
      "project install must merge hook config instead of stripping Meta_Kim hooks",
    );

    const cleanupStart = source.indexOf("async function cleanupProjectRedundancyDirs");
    const cleanupEnd = source.indexOf("async function copyToDeployDirs", cleanupStart);
    const cleanupSource = source.slice(cleanupStart, cleanupEnd);
    assert.match(
      cleanupSource,
      /migrateProjectMetaKimHooksForBootstrap\(\s*activeTargets,\s*targetDir,?\s*\)/,
    );
    assert.match(cleanupSource, /cleanupProjectHookConfigs\(activeTargets, targetDir\)/);

    const cleanupConfigStart = source.indexOf("function cleanupProjectHookConfigs");
    const cleanupConfigEnd = source.indexOf("async function cleanupProjectRedundancyDirs", cleanupConfigStart);
    const cleanupConfigSource = source.slice(cleanupConfigStart, cleanupConfigEnd);
    assert.match(cleanupConfigSource, /stripProjectMetaKimHooksFromHookConfig\(current\)/);

    const bootstrapApplyStart = source.indexOf("async function applyProjectBootstrapToDir");
    const bootstrapApplyEnd = source.indexOf("function classifyProjectBootstrapError", bootstrapApplyStart);
    const bootstrapApplySource = source.slice(bootstrapApplyStart, bootstrapApplyEnd);
    assert.match(
      bootstrapApplySource,
      /reportProjectAssetCleanup\(transactionPlan\.cleanup, \{ reason: "project_retarget" \}\)/,
      "project install retarget cleanup must use project-specific wording",
    );
    assert.match(
      cleanupSource,
      /reportProjectAssetCleanup\(cleanup, \{ reason: "global_redundancy" \}\)/,
      "global cleanup must keep global redundancy wording",
    );
    assert.doesNotMatch(
      cleanupSource,
      /resolve\(targetDir\) !== resolve\(PROJECT_DIR\)/,
      "global cleanup must not skip the Meta_Kim source workspace by default",
    );
  });

  test("install and update keep global hooks opt-in without a second Claude-only question", () => {
    assert.match(
      source,
      /const setupWithGlobalHooks =[\s\S]*?args\.includes\("--with-global-hooks"\)[\s\S]*?META_KIM_WITH_GLOBAL_HOOKS/,
      "setup must expose an explicit global hook opt-in",
    );
    assert.doesNotMatch(
      source.slice(source.indexOf("const setupWithGlobalHooks"), source.indexOf("function writeUtf8BomFileSync")),
      /!updateMode|!args\.includes\("--without-global-hooks"\)/,
      "fresh installs must not silently enable global hooks",
    );
    assert.match(source, /function metaTheoryGlobalSyncArgs\(targets, withGlobalHooks = false\)/);
    assert.deepEqual(
      buildGlobalMetaTheorySyncArgs({
        targets: ["claude", "cursor"],
        withGlobalHooks: true,
      }),
      ["--targets", "claude,cursor", "--with-global-hooks"],
      "sync-global-meta-theory must receive --with-global-hooks only after setup opt-in",
    );
    assert.deepEqual(
      buildGlobalMetaTheorySyncArgs({
        targets: ["cursor", "openclaw"],
        withGlobalHooks: true,
      }),
      ["--targets", "cursor,openclaw"],
    );
    assert.match(
      source,
      /function syncOwnedGlobalRuntimeAssets\([\s\S]*?assetType === "hooks" && !withGlobalHooks[\s\S]*?globalProjectionIsOwnedBy/,
      "global runtime assets must be selected from profile ownership while hooks remain opt-in",
    );
    assert.doesNotMatch(source, /askAdvancedGlobalControls\(activeTargets\)/);
    assert.doesNotMatch(source, /askYesNo\(t\.askAdvancedGlobalControls/);
    assert.doesNotMatch(source, /announceGlobalRuntimeHooksPlan\(activeTargets\)/);
    assert.doesNotMatch(
      source,
      /下面只确认 Claude Code|是否在 Claude Code 启用同一套 Meta_Kim 全局治理规则/,
      "global sync must not show a redundant Claude Code-only confirmation",
    );
    assert.match(
      i18nStrings,
      /把 Meta_Kim 全局治理层同步到已选平台，供各项目复用？包含 agents、skills、MCP、Commands；全局 hooks 需要 --with-global-hooks。实际支持项会自动检查后同步。（推荐）/,
      "global sync prompt must name hooks as explicit opt-in",
    );
    assert.doesNotMatch(
      source,
      /包含 agents、skills、MCP、Commands、hooks 等/,
      "setup copy must not present hooks as part of the default global capability sync",
    );
    assert.match(source, /metaTheoryGlobalSyncArgs\(activeTargets, setupWithGlobalHooks\)/);
    assert.match(
      source,
      /syncOwnedGlobalRuntimeAssets\(\s*activeTargets,\s*runtimeProfiles,\s*setupWithGlobalHooks,\s*\)/,
    );
    assert.match(source, /globalHooksOptInNotice/);
    assert.doesNotMatch(
      source,
      /\["cursor", "openclaw"\]\.includes\(target\)/,
      "setup must not hardcode which runtimes are owned by sync-runtimes",
    );
    assert.equal(
      globalProjectionIsOwnedBy(
        runtimeProfiles.claude,
        "capabilityIndex",
        GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
      ),
      true,
    );
    assert.equal(
      globalProjectionIsOwnedBy(
        runtimeProfiles.codex,
        "capabilityIndex",
        GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
      ),
      true,
    );
    assert.match(source, /"--global-assets"/);
  });

  test("global update runs global skill and governance updates without extra yes/no prompts", () => {
    assert.doesNotMatch(source, /wantGlobalSkills/);
    assert.doesNotMatch(source, /wantMetaTheory/);
    assert.doesNotMatch(source, /askYesNo\(t\.askGlobalSkillsUpdate/);
    assert.doesNotMatch(source, /askYesNo\(t\.askMetaTheoryUpdate/);
    assert.match(
      source,
      /const updateSkillIds = needGlobal\s*\?\s*await resolveSelectedSkillDependencyIds\(\)\s*:\s*\[\];/,
    );
    assert.match(source, /if \(needGlobal\) \{\s*const updateSyncResult = runNodeScript/);
    assert.doesNotMatch(source, /updateSyncProjectSkipped/);
  });

  test("global-only install/update reconciles existing Graphify hooks before skipping project wiring", () => {
    assert.match(
      source,
      /function projectDeploymentTargetDir\(deployment, fallback = CALLER_CWD\)[\s\S]*?deployment\?\.targetDir[\s\S]*?\?\? fallback;/,
      "stable handoff deployment records must be reduced to their targetDir before path APIs",
    );
    assert.match(
      source,
      /installPythonTools\(\s*activeTargets,\s*false,[\s\S]*?projectDeploymentTargetDir\(deployDirs\[0\], CALLER_CWD\)[\s\S]*?: PROJECT_DIR,\s*\{\s*projectWiring: needProject,\s*\}/,
    );
    assert.match(
      source,
      /installPythonTools\(\s*activeTargets,\s*true,[\s\S]*?projectDeploymentTargetDir\(deployDirs\[0\], CALLER_CWD\)[\s\S]*?: PROJECT_DIR,\s*\{ projectWiring: needProject \},/,
    );
    assert.match(
      source,
      /const projectWiring = options\.projectWiring !== false;/,
    );
    const start = source.indexOf("async function installPythonTools(");
    const end = source.indexOf("// ── Step 4.6:", start);
    const body = source.slice(start, end);
    assert.ok(body.indexOf("resolveGraphifyExecutable(python") < body.indexOf("if (!projectWiring)"));
    assert.match(body, /join\(homedir\(\), "\.claude", "settings\.json"\)/);
    assert.match(body, /reconcileExistingGraphifyWindowsHooks\(/);
    assert.match(
      source,
      /if \(!projectWiring\) \{\s*skip\(t\.graphifyProjectWiringSkipped\);\s*return true;\s*\}/,
    );
  });

  test("META_KIM_SKIP_OPTIONAL_TOOLS skips Graphify and MCP Memory in install and update", () => {
    assert.match(source, /const skipOptionalTools = process\.env\.META_KIM_SKIP_OPTIONAL_TOOLS === "1";/);
    const installStart = source.indexOf("async function runInstall()");
    const updateStart = source.indexOf("async function runUpdate()");
    const installSource = source.slice(installStart, updateStart);
    const updateSource = source.slice(updateStart, source.indexOf("async function runCheck()"));
    for (const flowSource of [installSource, updateSource]) {
      assert.match(flowSource, /skipOptionalTools[\s\S]*?INSTALL_STEP_OUTCOME\.SKIPPED/);
      assert.match(flowSource, /skipOptionalTools[\s\S]*?t\.mcpMemorySkipped/);
      assert.match(
        flowSource,
        /const mcpMemoryOk = executingStableProjectionPackage[\s\S]*?t\.mcpMemorySkipped[\s\S]*?INSTALL_STEP_OUTCOME\.SKIPPED/,
        "the immutable package lifecycle must not absorb live MCP replacement",
      );
    }
  });

  test("MCP memory consent is scoped to the selected Claude child installer", () => {
    const installerStart = source.indexOf("async function runMcpMemoryHookInstaller");
    const installerEnd = source.indexOf("function checkMcpMemoryService", installerStart);
    const installerSource = source.slice(installerStart, installerEnd);
    assert.match(
      installerSource,
      /\{ allowClaudeGlobalSettings = false \} = \{\}/,
      "the child installer must receive an explicit scoped consent parameter",
    );
    assert.match(
      installerSource,
      /allowClaudeGlobalSettings && activeTargets\.includes\("claude"\)[\s\S]*?META_KIM_CONFIRM_GLOBAL: "1"/,
      "Claude consent must be injected only when Claude is selected",
    );
    assert.match(
      installerSource,
      /\.\.\.\(childEnv \? \{ env: childEnv \} : \{\}\)/,
      "non-Claude child runs must not receive a setup-injected consent env",
    );
    assert.doesNotMatch(installerSource, /process\.env\.META_KIM_CONFIRM_GLOBAL\s*=/);
    assert.doesNotMatch(installerSource, /--force/);
    assert.match(
      installerSource,
      /const stdoutText = \(result\.stdout \|\| ""\)\.trim\(\);[\s\S]*?const stderrText = \(result\.stderr \|\| ""\)\.trim\(\);[\s\S]*?if \(stdoutText\)[\s\S]*?if \(stderrText\)/,
      "failed child hook installs must surface both stdout and stderr evidence",
    );

    const memoryStepStart = source.indexOf("async function installMcpMemoryServiceStep");
    const memoryStepEnd = source.indexOf("function ensureNetworkxCompatibility", memoryStepStart);
    const memoryStepSource = source.slice(memoryStepStart, memoryStepEnd);
    assert.match(
      memoryStepSource,
      /const want = await askYesNo\(t\.askMcpMemoryInstall, true\);[\s\S]*?allowClaudeGlobalSettings: want && activeTargets\.includes\("claude"\)/,
      "the setup prompt answer must be the only source of the scoped Claude consent",
    );
  });

  test("global hook sync precedes memory and inventory refresh is last in install and update", () => {
    const installStart = source.indexOf("async function runInstall()");
    const updateStart = source.indexOf("async function runUpdate()");
    const installSource = source.slice(installStart, updateStart);
    const updateSource = source.slice(updateStart, source.indexOf("async function runCheck()"));

    for (const [flowName, flowSource, memoryCall] of [
      ["install", installSource, "installMcpMemoryServiceStep(false, activeTargets)"],
      ["update", updateSource, "installMcpMemoryServiceStep(true, activeTargets)"],
    ]) {
      const globalSync = flowSource.indexOf("SETUP_NODE_CHILD.GLOBAL_META_THEORY_SYNC");
      const memoryInstall = flowSource.indexOf(memoryCall);
      const inventoryRefresh = flowSource.indexOf(
        "refreshGlobalCapabilityInventory(activeTargets)",
        memoryInstall,
      );
      const validation = flowSource.indexOf(
        flowName === "install"
          ? "validateInstalledArtifacts("
          : "// ── 6. Validate installed artifacts",
      );

      assert.ok(globalSync >= 0, `${flowName}: global sync must be present`);
      assert.ok(memoryInstall > globalSync, `${flowName}: memory must run after global sync`);
      assert.ok(
        inventoryRefresh > memoryInstall,
        `${flowName}: inventory must refresh after memory-owned runtime writes`,
      );
      assert.ok(
        validation > inventoryRefresh,
        `${flowName}: inventory must refresh before final validation`,
      );
      assert.match(
        flowSource,
        /resolveMcpMemorySetupPolicy\(\{\s*needGlobal,\s*withGlobalHooks: setupWithGlobalHooks,\s*skipOptionalTools,\s*\}\)/,
        `${flowName}: memory must use the shared global-hook prerequisite policy`,
      );
    }
    assert.match(i18nStrings, /mcpMemoryRequiresGlobalHooks/);
  });

  test("packed installs validate installed artifacts instead of maintainer repository files", () => {
    const validationStart = source.indexOf("async function validateInstalledArtifacts");
    const validationEnd = source.indexOf("function printInstallResult", validationStart);
    const validationSource = source.slice(validationStart, validationEnd);
    assert.match(validationSource, /checkGlobalRuntimeSync\(globalValidationTargets\)/);
    const globalCheckStart = source.indexOf("function checkGlobalRuntimeSync");
    const globalCheckEnd = source.indexOf("function formatRuntimeTargetLabels", globalCheckStart);
    assert.match(
      source.slice(globalCheckStart, globalCheckEnd),
      /SETUP_NODE_CHILD\.GLOBAL_META_THEORY_SYNC[\s\S]*?"--check"/,
    );
    assert.match(validationSource, /projectDeployResults/);
    assert.match(validationSource, /isSourceCheckout\(\)/);
    assert.doesNotMatch(validationSource, /PROJECT_VALIDATION|validate-project|\.gitignore/);
    assert.doesNotMatch(source, /await validate\(\)/);
  });
});
