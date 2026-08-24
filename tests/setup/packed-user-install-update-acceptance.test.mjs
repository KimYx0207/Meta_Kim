import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PACKED_GLOBAL_AGENT_TARGETS,
  PACKED_GLOBAL_USER_UPDATE_TIMEOUT_MS,
  PACKED_HISTORICAL_USER_UPDATE_TIMEOUT_MS,
  PACKED_TRANSIENT_PACKAGE_INSTALL_TIMEOUT_MS,
  PACKED_PORTABLE_RUNTIME_GLOBAL_UPDATE_TIMEOUT_MS,
  PACKED_PROJECT_AWARE_GLOBAL_UPDATE_TIMEOUT_MS,
  PACKED_USER_TARGETS,
  assertCurrentVersionTagAbsent,
  assertPackedAdvisoryEffectiveMatrix,
  buildPackedCommandDiagnostics,
  collectNonPortablePackedReferences,
  durableMcpDefinitionMatches,
  referencedPersistentRuntimePaths,
  requirePackedCommandSuccess,
  runInstalledPublicCli,
  selectHistoricalUpdateRef,
} from "../../scripts/verify-packed-user-install-update.mjs";
import {
  buildDurableMetaKimMcpServer,
} from "../../scripts/global-runtime-mcp.mjs";
import {
  resolveGlobalAgentProjectionTargets,
  resolveRuntimeProfilesFromManifest,
} from "../../scripts/meta-kim-sync-config.mjs";

const acceptanceSource = readFileSync(
  "scripts/verify-packed-user-install-update.mjs",
  "utf8",
);
const releaseVerificationPolicy = JSON.parse(
  readFileSync("config/contracts/release-verification-policy.json", "utf8"),
);
const verifyAllSource = readFileSync("scripts/run-verify-all.mjs", "utf8");
const packedProofSource = readFileSync("scripts/packed-product-proof.mjs", "utf8");
const auditReleaseSource = readFileSync("scripts/audit-release-binding.mjs", "utf8");
const runtimeAcceptanceSource = readFileSync(
  "scripts/runtime-capability-acceptance.mjs",
  "utf8",
);
const coreLoopReleaseEvidenceSource = readFileSync(
  "tests/governance/core-loop-release-evidence.test.mjs",
  "utf8",
);
const setupSource = readFileSync("setup.mjs", "utf8");
const canonicalSpineHookSource = readFileSync(
  "canonical/runtime-assets/shared/hooks/activate-meta-theory-spine.mjs",
  "utf8",
);

test("canonical spine Hook does not contain a token that packed readback treats as unresolved", () => {
  assert.deepEqual(
    collectNonPortablePackedReferences(canonicalSpineHookSource),
    [],
  );
});

test("packed readback distinguishes persistent bindings from guarded executable candidates", () => {
  const stableHook = "C:\\Users\\Runtime\\.meta-kim\\stable\\activate.mjs";
  const guardedCandidate = "C:\\ProgramData\\anaconda3\\python.exe";
  const transientRoot = "C:\\Users\\Runtime\\npm-cache\\_npx\\disposable";
  assert.deepEqual(
    referencedPersistentRuntimePaths({
      "C:/Users/Runtime/.codex/hooks/meta-kim/codex_hook_runner.mjs":
        `const candidate = '${guardedCandidate}'; if (existsSync(candidate)) use(candidate);`,
      "C:/Users/Runtime/.codex/hooks.json": JSON.stringify({
        command: `node \"${stableHook}\"`,
      }),
    }),
    [stableHook],
  );
  assert.deepEqual(
    collectNonPortablePackedReferences(
      `const leaked = '${transientRoot}\\node_modules\\meta-kim\\setup.mjs';`,
      { forbiddenRoots: [transientRoot] },
    ).map((finding) => finding.reason),
    ["forbidden_machine_root"],
    "executable source skips optional-candidate existence checks but still fails portability scanning",
  );
});

test("packed advisory MCP compares the effective overlay without weakening canonical baseline truth", () => {
  const baselineMatrix = JSON.parse(
    readFileSync("config/runtime-capability-matrix.json", "utf8"),
  );
  const effectiveMatrix = structuredClone(baselineMatrix);
  effectiveMatrix.platforms[0].capabilities[0].claimsByMode.interactive_host.acceptanceState =
    "observed_advisory";
  const state = { baselineMatrix, effectiveMatrix };

  assert.equal(
    assertPackedAdvisoryEffectiveMatrix(
      effectiveMatrix,
      baselineMatrix,
      state,
    ),
    effectiveMatrix,
  );
  assert.throws(
    () =>
      assertPackedAdvisoryEffectiveMatrix(
        baselineMatrix,
        baselineMatrix,
        state,
      ),
    /packed MCP advisory effective matrix does not exactly match/u,
  );

  const driftedBaseline = structuredClone(baselineMatrix);
  driftedBaseline.version = `${baselineMatrix.version}-drift`;
  assert.throws(
    () =>
      assertPackedAdvisoryEffectiveMatrix(
        effectiveMatrix,
        driftedBaseline,
        state,
      ),
    /packed MCP advisory baseline matrix does not exactly match/u,
  );
});
const syncManifest = JSON.parse(readFileSync("config/sync.json", "utf8"));
const runtimeProfiles = resolveRuntimeProfilesFromManifest(syncManifest);

function functionSource(name, nextName) {
  const start = setupSource.indexOf(`async function ${name}(`);
  const end = setupSource.indexOf(`async function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `unable to isolate ${name}`);
  return setupSource.slice(start, end);
}

function acceptanceFunctionSource(name, nextName) {
  const start = acceptanceSource.indexOf(`function ${name}(`);
  const end = acceptanceSource.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `unable to isolate acceptance ${name}`);
  return acceptanceSource.slice(start, end);
}

test("packed user acceptance runs public install and update from an npm-packed candidate", () => {
  assert.deepEqual(PACKED_USER_TARGETS, syncManifest.supportedTargets);
  assert.match(acceptanceSource, /npm["'], \["pack"/u);
  assert.match(acceptanceSource, /"install",\s*"--global",\s*"--prefix"/u);
  assert.match(acceptanceSource, /resolvePackageCliName\(packageManifest\)/u);
  assert.match(acceptanceSource, /packageManifest\.bin\[cliName\]/u);
  assert.match(acceptanceSource, /path\.win32\.isAbsolute\(cliRelativePath\)/u);
  assert.match(acceptanceSource, /statSync\(cliPath\)\.isFile\(\)/u);
  assert.doesNotMatch(
    acceptanceSource,
    /path\.join\(workspace, "bin", "meta-kim\.mjs"\)|missing bin\/meta-kim\.mjs/u,
  );
  assert.match(acceptanceSource, /\["install", "update", "update"\]/u);
  assert.match(acceptanceSource, /runInstalledPublicCli\(descriptor/u);
  assert.doesNotMatch(
    acceptanceSource,
    /installed packed CLI public check after candidate removal/u,
  );
  assert.match(acceptanceSource, /installedPackageChecksAfterCandidateRemoval: true/u);
  assert.match(acceptanceSource, /global-only CLI polluted ordinary cwd/u);
  assert.match(acceptanceSource, /second packed user update changed managed artifacts/u);
  assert.match(acceptanceSource, /global install manifest is missing required entries/u);
});

test("packed user acceptance help is read-only and does not start install/update lanes", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/verify-packed-user-install-update.mjs", "--help"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node scripts\/verify-packed-user-install-update\.mjs/u);
  assert.match(result.stdout, /--skip-history/u);
  assert.doesNotMatch(result.stdout, /packed_user_acceptance_start/u);
  assert.doesNotMatch(result.stderr ?? "", /packed_user_acceptance_start/u);
  assert.doesNotMatch(result.stderr ?? "", /npm pack/u);
});

test("release entrypoints fail on a broken installed CLI even when extracted source is green", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-installed-cli-fault-"));
  try {
    const ordinaryCwd = path.join(root, "cwd");
    const installedPackageRoot = path.join(root, "installed-package");
    mkdirSync(ordinaryCwd, { recursive: true });
    mkdirSync(installedPackageRoot, { recursive: true });
    const extractedGreen = path.join(root, "extracted-green.mjs");
    writeFileSync(extractedGreen, "process.exit(0);\n", "utf8");
    assert.equal(spawnSync(process.execPath, [extractedGreen]).status, 0);

    const command = process.platform === "win32"
      ? path.join(root, "broken-installed.cmd")
      : path.join(root, "broken-installed");
    if (process.platform === "win32") {
      const badTarget = path.join(root, "broken-installed.mjs");
      writeFileSync(badTarget, "process.exit(23);\n", "utf8");
      writeFileSync(command, '"%~dp0\\broken-installed.mjs" %*\r\n', "utf8");
    } else {
      writeFileSync(command, "#!/bin/sh\nexit 23\n", "utf8");
    }
    if (process.platform !== "win32") chmodSync(command, 0o755);
    const result = runInstalledPublicCli(
      { command, installedPackageRoot },
      { ordinaryCwd },
      process.env,
      "install",
      10_000,
    );
    assert.equal(result.status, 23);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packed uninstall lane reuses its installed public CLI after a failed manifestless uninstall", () => {
  const uninstallLane = acceptanceFunctionSource(
    "runPackedUninstallLane",
    "filesRecursively",
  );
  assert.match(
    uninstallLane,
    /const privateFlag = runCli\([\s\S]*?installed\.command,[\s\S]*?\["uninstall", "--no-manifest", "--scope=global"\]/u,
  );
  assert.match(
    uninstallLane,
    /runCli\(installed\.command, \["--help"\]/u,
  );
  assert.match(
    uninstallLane,
    /packed installed public CLI was unavailable after the failed manifestless uninstall/u,
  );
  assert.match(
    uninstallLane,
    /publicCliAfterFailedUninstall:[\s\S]*?commandSource: "isolated_installed_public_cli"[\s\S]*?withinIsolatedPrefix: installedCommandWithinIsolatedPrefix[\s\S]*?entrypoint: "--help"/u,
  );
  const recoveryProofStart = uninstallLane.indexOf(
    "publicCliAfterFailedUninstall:",
  );
  const recoveryProofEnd = uninstallLane.indexOf(
    "windowsRecovery,",
    recoveryProofStart,
  );
  const serializedRecoveryShape = uninstallLane.slice(
    recoveryProofStart,
    recoveryProofEnd,
  );
  assert.doesNotMatch(serializedRecoveryShape, /command:\s*installed\.command/u);
  assert.match(uninstallLane, /const serializedProof = JSON\.stringify\(proof\)/u);
  assert.match(
    uninstallLane,
    /roots\.laneRoot,[\s\S]*?roots\.userHome,[\s\S]*?roots\.tempDir,[\s\S]*?roots\.cliPrefix/u,
  );
  assert.match(
    uninstallLane,
    /packed uninstall proof serialized an isolated home or temporary path/u,
  );
});

test("historical release baseline is the highest prior semver tag and never a fixed ref", () => {
  assert.equal(
    selectHistoricalUpdateRef({
      currentVersion: "4.2.1",
      tags: ["v4.1.9", "v4.2.0", "v3.9.8", "not-a-release"],
    }).tag,
    "v4.2.0",
  );
  assert.equal(
    selectHistoricalUpdateRef({
      currentVersion: "4.2.1",
      tags: ["v4.1.9", "v4.2.0", "v4.2.1"],
      overrideRef: "v4.1.9",
    }).tag,
    "v4.1.9",
  );
  assert.throws(
    () => selectHistoricalUpdateRef({ currentVersion: "4.2.1", tags: [] }),
    /no prior stable release tag/u,
  );
  assert.match(acceptanceSource, /highest_prior_stable_semver_tag/u);
});

test("current package version exact tag fails closed before packed and release probes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-current-tag-guard-"));
  const git = (...args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  try {
    assert.equal(git("init", "--quiet").status, 0);
    writeFileSync(
      path.join(root, "package.json"),
      '{"name":"tag-guard-fixture","version":"7.8.9"}\n',
      "utf8",
    );
    assert.equal(git("add", "package.json").status, 0);
    assert.equal(
      git(
        "-c",
        "user.name=Meta Kim Test",
        "-c",
        "user.email=meta-kim@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ).status,
      0,
    );

    const absent = assertCurrentVersionTagAbsent({ repoRoot: root });
    assert.equal(absent.currentVersionTagAbsent, true);
    assert.equal(absent.exactRef, "refs/tags/v7.8.9");

    assert.equal(git("tag", "v7.8.9").status, 0);
    assert.throws(
      () => assertCurrentVersionTagAbsent({ repoRoot: root }),
      /current package version tag already exists: v7\.8\.9/u,
    );

    const packedRunner = acceptanceFunctionSource(
      "runPackedUserInstallUpdateAcceptance",
      "main",
    );
    assert.ok(
      packedRunner.indexOf("assertCurrentVersionTagAbsent") <
        packedRunner.indexOf("mkdtempSync"),
      "packed acceptance must reject a current-version tag before allocating or packing",
    );
    const releasePreflightStart = verifyAllSource.indexOf(
      "export function runReleasePreflight(",
    );
    const releasePreflightEnd = verifyAllSource.indexOf(
      "export function computeReleaseGrade(",
      releasePreflightStart,
    );
    const releasePreflightSource = verifyAllSource.slice(
      releasePreflightStart,
      releasePreflightEnd,
    );
    assert.ok(
      releasePreflightSource.indexOf("assertCurrentVersionTagAbsent") <
        releasePreflightSource.indexOf("runProbe({ onProgress })"),
      "release preflight must reject a current-version tag before its first expensive probe",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every packed CLI install and update lane uses every manifest runtime target", () => {
  const globalCliSource = acceptanceFunctionSource(
    "runInstalledPublicCli",
    "runInstalledPublicProjectCli",
  );
  assert.match(
    globalCliSource,
    /"--scope",\s*"global"/u,
    "global packed lanes must declare their distribution scope explicitly",
  );
  for (const [name, nextName] of [
    ["runInstalledPublicCli", "runInstalledPublicProjectCli"],
    ["runInstalledPublicProjectCli", "runInstalledPublicGlobalUpdateFromProject"],
    ["runInstalledPublicGlobalUpdateFromProject", "runProjectCapabilityCopy"],
  ]) {
    assert.match(
      acceptanceFunctionSource(name, nextName),
      /"--targets",[\s\S]*?PACKED_USER_TARGETS\.join\(","\)/u,
      `${name} must pass every manifest target to the real packed CLI`,
    );
  }
  const historicalLane = acceptanceFunctionSource(
    "runHistoricalUpdateLane",
    "runPackedUserInstallUpdateAcceptance",
  );
  assert.match(historicalLane, /installPackedCli\(\s*historicalPackage/u);
  assert.match(
    historicalLane,
    /runInstalledPublicCli\(\s*historicalDescriptor,[\s\S]*?"install"/u,
    "the historical seed must use the prior tarball-installed CLI",
  );
  assert.match(
    historicalLane,
    /runInstalledPublicCli\([\s\S]*?currentDescriptor,[\s\S]*?"update",[\s\S]*?PACKED_HISTORICAL_USER_UPDATE_TIMEOUT_MS/u,
    "the historical upgrade must use the current tarball-installed CLI entry",
  );
  assert.doesNotMatch(
    historicalLane,
    /runInstalledPublicCli\(currentDescriptor, roots, env, "check", timeoutMs\)/u,
    "a global historical lane must not invoke the project-projection check",
  );
  assert.match(
    historicalLane,
    /current_update_internal_global_check_plus_exact_artifact_manifest_validation/u,
  );
  assert.match(acceptanceSource, /targets: \[\.\.\.PACKED_USER_TARGETS\]/u);
  const portablePreparation = acceptanceFunctionSource(
    "runPortableRuntimePreparation",
    "probePackedMcpTransport",
  );
  assert.match(portablePreparation, /const runtimeTargetIds = \[\.\.\.PACKED_USER_TARGETS\]/u);
  assert.match(portablePreparation, /"--targets",\s*runtimeTargetIds\.join\(","\)/u);
});

test("packed global proof validates profile-owned manifest integrity and disjoint writers", () => {
  assert.match(acceptanceSource, /function verifyGlobalProjectionOwnership\(/u);
  assert.match(acceptanceSource, /entry\.source === "sync-global-meta-theory"/u);
  assert.match(acceptanceSource, /entry\.source === "sync-runtimes"/u);
  assert.match(acceptanceSource, /globalProjectionIsOwnedBy/u);
  assert.match(acceptanceSource, /packed global projection has multiple writers/u);
  assert.match(acceptanceSource, /ownershipManifest: ownershipProof/u);
});

test("packed acceptance fingerprints Cursor and OpenClaw global and project artifacts", () => {
  for (const requiredPath of [
    /cursorSkill: path\.join\(roots\.cursorHome, "skills", "meta-theory", "SKILL\.md"\)/u,
    /openclawSkill: path\.join\(roots\.openclawHome, "skills", "meta-theory", "SKILL\.md"\)/u,
    /cursorSkill: path\.join\(projectDir, "\.cursor", "skills", "meta-theory", "SKILL\.md"\)/u,
    /cursorMcp: path\.join\(projectDir, "\.cursor", "mcp\.json"\)/u,
    /openclawSkill: path\.join\(projectDir, "openclaw", "skills", "meta-theory", "SKILL\.md"\)/u,
    /openclawTemplate: path\.join\(projectDir, "openclaw", "openclaw\.template\.json"\)/u,
  ]) {
    assert.match(acceptanceSource, requiredPath);
  }
});

test("packed user acceptance covers project install/update and runtime-sedimented ownership", () => {
  assert.match(acceptanceSource, /"--scope",\s*"project"/u);
  assert.match(acceptanceSource, /runInstalledPublicProjectCli/u);
  assert.match(acceptanceSource, /`packed project \$\{mode\}`/u);
  assert.match(acceptanceSource, /"project",\s*"capability",\s*"copy"/u);
  for (const type of ["agent", "skill", "command"]) {
    assert.match(acceptanceSource, new RegExp(`type: "${type}"`, "u"));
  }
  assert.match(acceptanceSource, /preserved_project_copy/u);
  assert.match(acceptanceSource, /dependencyUpdatePolicy === "preserve_project_copy"/u);
  assert.match(acceptanceSource, /global update overwrote the project-owned/u);
  assert.match(acceptanceSource, /runGlobalReuseNegativeLane/u);
  assert.match(acceptanceSource, /packet\?\.decision !== "use_global_directly"/u);
  assert.match(acceptanceSource, /use_global_directly created project copies/u);
  assert.match(acceptanceSource, /use_global_directly added project capability ownership entries/u);
});

test("packed global update refreshes a bootstrapped project without overwriting user-owned project state", () => {
  assert.match(acceptanceSource, /runInstalledPublicGlobalUpdateFromProject/u);
  assert.match(acceptanceSource, /"update",[\s\S]*?"--scope",[\s\S]*?"global"/u);
  assert.match(acceptanceSource, /cwd: roots\.projectDir/u);
  assert.match(acceptanceSource, /readValidatedProjectBootstrapManifest/u);
  assert.match(acceptanceSource, /meta-kim-project-bootstrap-v0\.1/u);
  assert.match(acceptanceSource, /project-aware global update did not refresh the global Codex skill/u);
  assert.match(acceptanceSource, /manifest_managed_projection_replace/u);
  assert.match(acceptanceSource, /managed_block_preserve_user_text/u);
  assert.match(acceptanceSource, /project-aware global update changed an unknown user project file/u);
  assert.match(acceptanceSource, /project capability manifest was not prepared before the global update/u);
  assert.match(acceptanceSource, /project-aware global update overwrote the runtime-sedimented/u);
  assert.match(acceptanceSource, /runtimeSedimentedCopiesPreserved: true/u);
  assert.match(acceptanceSource, /project-aware global update changed the existing project projection mode/u);
  assert.match(acceptanceSource, /projectProjectionModePreserved: true/u);
  assert.match(acceptanceSource, /freshGlobalUpdateCreatedProjectCopies: false/u);
});

test("project-aware packed global update alone receives the policy-scoped extended timeout", () => {
  assert.equal(
    releaseVerificationPolicy.packedUserAcceptance.commandTimeoutMs,
    300_000,
    "ordinary packed commands retain their existing five-minute timeout",
  );
  assert.equal(
    releaseVerificationPolicy.packedUserAcceptance.projectAwareGlobalUpdateTimeoutMs,
    600_000,
  );
  assert.equal(PACKED_PROJECT_AWARE_GLOBAL_UPDATE_TIMEOUT_MS, 600_000);
  assert.match(
    acceptanceSource,
    /const DEFAULT_TIMEOUT_MS\s*=\s*[\s\S]*?packedUserAcceptance\.commandTimeoutMs/u,
  );
  const acceptanceRunner = acceptanceFunctionSource(
    "runPackedUserInstallUpdateAcceptance",
    "main",
  );
  assert.match(acceptanceRunner, /timeoutMs\s*=\s*DEFAULT_TIMEOUT_MS/u);

  const ordinaryGlobalCli = acceptanceFunctionSource(
    "runInstalledPublicCli",
    "runPackedUninstallLane",
  );
  const projectAwareGlobalUpdate = acceptanceFunctionSource(
    "runInstalledPublicGlobalUpdateFromProject",
    "runProjectCapabilityCopy",
  );
  assert.match(ordinaryGlobalCli, /timeoutMs,/u);
  assert.doesNotMatch(
    ordinaryGlobalCli,
    /PACKED_PROJECT_AWARE_GLOBAL_UPDATE_TIMEOUT_MS/u,
  );
  assert.match(
    projectAwareGlobalUpdate,
    /timeoutMs:\s*PACKED_PROJECT_AWARE_GLOBAL_UPDATE_TIMEOUT_MS/u,
  );
});

test("ordinary packed global updates receive a bounded Windows-safe timeout without widening install", () => {
  assert.equal(
    releaseVerificationPolicy.packedUserAcceptance.globalUserUpdateTimeoutMs,
    600_000,
  );
  assert.equal(PACKED_GLOBAL_USER_UPDATE_TIMEOUT_MS, 600_000);
  const currentLane = acceptanceFunctionSource(
    "runCurrentPackageLane",
    "runHistoricalUpdateLane",
  );
  assert.match(
    currentLane,
    /mode === "update" \? PACKED_GLOBAL_USER_UPDATE_TIMEOUT_MS : timeoutMs/u,
  );
});

test("historical packed upgrade receives its own bounded Windows-safe timeout", () => {
  assert.equal(
    releaseVerificationPolicy.packedUserAcceptance.historicalUserUpdateTimeoutMs,
    600_000,
  );
  assert.equal(PACKED_HISTORICAL_USER_UPDATE_TIMEOUT_MS, 600_000);
  const historicalLane = acceptanceFunctionSource(
    "runHistoricalUpdateLane",
    "runPackedUserInstallUpdateAcceptance",
  );
  assert.match(historicalLane, /PACKED_HISTORICAL_USER_UPDATE_TIMEOUT_MS/u);
});

test("transient npx-shaped package install receives a bounded Windows-safe timeout", () => {
  assert.equal(
    releaseVerificationPolicy.packedUserAcceptance.transientPackageInstallTimeoutMs,
    600_000,
  );
  assert.equal(PACKED_TRANSIENT_PACKAGE_INSTALL_TIMEOUT_MS, 600_000);
  const transientPreparation = acceptanceFunctionSource(
    "prepareTransientPackageRoot",
    "runTransientPackageRootLane",
  );
  assert.match(transientPreparation, /PACKED_TRANSIENT_PACKAGE_INSTALL_TIMEOUT_MS/u);
});

test("portable runtime global update receives its own policy-scoped extended timeout without widening other packed lanes", () => {
  assert.equal(
    releaseVerificationPolicy.packedUserAcceptance.commandTimeoutMs,
    300_000,
    "ordinary packed commands retain their existing five-minute timeout",
  );
  assert.equal(
    releaseVerificationPolicy.packedUserAcceptance.portableRuntimeGlobalUpdateTimeoutMs,
    1_200_000,
  );
  assert.equal(PACKED_PORTABLE_RUNTIME_GLOBAL_UPDATE_TIMEOUT_MS, 1_200_000);

  const portablePreparation = acceptanceFunctionSource(
    "runPortableRuntimePreparation",
    "probePackedMcpTransport",
  );
  assert.ok(
    portablePreparation.includes("requirePackedCommandSuccess("),
    "portable runtime preparation must use the metadata-only packed command gate",
  );
  assert.equal(
    portablePreparation.includes("requireSuccess("),
    false,
    "portable runtime preparation must not expose raw command output through the legacy gate",
  );
  assert.ok(
    portablePreparation.includes(
      "timeoutMs: PACKED_PORTABLE_RUNTIME_GLOBAL_UPDATE_TIMEOUT_MS",
    ),
    "the portable global update must use its dedicated ten-minute timeout",
  );
  assert.ok(
    portablePreparation.includes(
      "operation: PORTABLE_RUNTIME_GLOBAL_UPDATE_OPERATION_ID",
    ),
    "the portable global update must emit its dedicated operation identity",
  );
  assert.ok(
    portablePreparation.includes("diagnostics: globalUpdate.boundedDiagnostics"),
    "a successful portable proof must retain only bounded diagnostics",
  );

  const ordinaryGlobalCli = acceptanceFunctionSource(
    "runInstalledPublicCli",
    "runInstalledPublicProjectCli",
  );
  const projectCli = acceptanceFunctionSource(
    "runInstalledPublicProjectCli",
    "runInstalledPublicGlobalUpdateFromProject",
  );
  const projectAwareGlobalUpdate = acceptanceFunctionSource(
    "runInstalledPublicGlobalUpdateFromProject",
    "runProjectCapabilityCopy",
  );
  const historicalLane = acceptanceFunctionSource(
    "runHistoricalUpdateLane",
    "runPackedUserInstallUpdateAcceptance",
  );
  for (const [lane, source] of [
    ["ordinary global", ordinaryGlobalCli],
    ["project", projectCli],
    ["project-aware global", projectAwareGlobalUpdate],
    ["historical", historicalLane],
  ]) {
    assert.equal(
      source.includes("PACKED_PORTABLE_RUNTIME_GLOBAL_UPDATE_TIMEOUT_MS"),
      false,
      `${lane} lane inherited the portable-only timeout`,
    );
  }
  assert.ok(
    projectAwareGlobalUpdate.includes(
      "PACKED_PROJECT_AWARE_GLOBAL_UPDATE_TIMEOUT_MS",
    ),
    "the project-aware lane must retain its independently named timeout",
  );

  assert.deepEqual(
    [...PACKED_USER_TARGETS].sort(),
    ["claude", "codex", "cursor", "openclaw"].sort(),
  );
  assert.ok(
    portablePreparation.includes("const runtimeTargetIds = [...PACKED_USER_TARGETS]"),
    "portable preparation must continue covering all four declared runtimes",
  );
  assert.ok(portablePreparation.includes('META_KIM_WITH_GLOBAL_HOOKS: "1"'));
  assert.ok(portablePreparation.includes('"--with-global-hooks"'));
  assert.ok(portablePreparation.includes("seeded.userAgents"));
  assert.ok(portablePreparation.includes("seeded.userHookCommand"));
  assert.ok(portablePreparation.includes("requireDurableMcpServer("));
  assert.ok(portablePreparation.includes("unknownAgentsPreserved: true"));
  assert.ok(portablePreparation.includes("unknownHookPreserved: true"));
  assert.ok(
    portablePreparation.includes("unknownServerEnvAndAuthPreserved: true"),
  );

  const acceptanceRunner = acceptanceFunctionSource(
    "runPackedUserInstallUpdateAcceptance",
    "main",
  );
  assert.ok(
    acceptanceRunner.includes(
      "boundedDiagnostics: error.boundedDiagnostics ?? null",
    ),
    "a portable preparation failure must surface metadata-only diagnostics at the top level",
  );
});

const PACKED_DIAGNOSTIC_KEYS = Object.freeze([
  "elapsedMs",
  "errorCode",
  "exitCode",
  "operation",
  "outputRetention",
  "signal",
  "stderrChars",
  "stderrPresent",
  "stdoutChars",
  "stdoutPresent",
  "timedOut",
  "timeoutMs",
]);

function assertMetadataOnlyDiagnostics(diagnostic, expected, sensitiveValues = []) {
  assert.deepEqual(Object.keys(diagnostic).sort(), PACKED_DIAGNOSTIC_KEYS);
  assert.deepEqual(diagnostic, expected);
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /stdoutTail|stderrTail|digest|message|stack/u);
  for (const sensitiveValue of sensitiveValues) {
    assert.equal(
      serialized.includes(sensitiveValue),
      false,
      "diagnostics serialized command-controlled text",
    );
  }
}

function packedDiagnosticsOptions(overrides = {}) {
  return {
    operation: "packed-project-aware-global-update",
    timeoutMs: 600_000,
    elapsedMs: 42,
    ...overrides,
  };
}

function packedCommandResult(overrides = {}) {
  return {
    status: 0,
    error: null,
    signal: null,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

function assertSafePackedError(
  error,
  expectedMessage,
  expectedErrorCode,
  sensitiveValues = [],
) {
  assert.equal(error instanceof Error, true);
  assert.equal(error.message, expectedMessage);
  assert.ok(error.boundedDiagnostics);
  assert.equal(Object.isFrozen(error.boundedDiagnostics), true);
  assert.equal(error.boundedDiagnostics.errorCode, expectedErrorCode);
  assert.equal(error.boundedDiagnostics.outputRetention, "metadata_only");
  const serialized = JSON.stringify({
    message: error.message,
    diagnostics: error.boundedDiagnostics,
    stack: error.stack,
  });
  for (const sensitiveValue of sensitiveValues) {
    assert.equal(
      serialized.includes(sensitiveValue),
      false,
      "safe failure reflected command-controlled or trap-controlled text",
    );
  }
  return true;
}

test("packed diagnostics count decoded characters and never claim original byte length", () => {
  const runtimeText = (...parts) => parts.join("");
  const stdout = runtimeText("完成", "🙂");
  const stderr = "é";
  const diagnostic = buildPackedCommandDiagnostics({
    result: packedCommandResult({ status: 23, signal: "SIGTERM", stdout, stderr }),
    ...packedDiagnosticsOptions(),
  });

  assertMetadataOnlyDiagnostics(
    diagnostic,
    {
      operation: "packed-project-aware-global-update",
      timeoutMs: 600_000,
      elapsedMs: 42,
      timedOut: false,
      exitCode: 23,
      errorCode: null,
      signal: "SIGTERM",
      outputRetention: "metadata_only",
      stdoutPresent: true,
      stderrPresent: true,
      stdoutChars: stdout.length,
      stderrChars: stderr.length,
    },
    [stdout, stderr],
  );
  assert.equal(stdout.length, 4, "astral Unicode uses JavaScript string length");
  assert.notEqual(Buffer.byteLength(stdout), stdout.length);
  assert.notEqual(Buffer.byteLength(stderr), stderr.length);
});

test("packed diagnostics treat Buffer output as unavailable decoded character metadata", () => {
  const rawOutput = Buffer.from("buffer content must not be retained", "utf8");
  const diagnostic = buildPackedCommandDiagnostics({
    result: packedCommandResult({ stdout: rawOutput, stderr: rawOutput }),
    ...packedDiagnosticsOptions(),
  });
  assertMetadataOnlyDiagnostics(
    diagnostic,
    {
      operation: "packed-project-aware-global-update",
      timeoutMs: 600_000,
      elapsedMs: 42,
      timedOut: false,
      exitCode: 0,
      errorCode: null,
      signal: null,
      outputRetention: "metadata_only",
      stdoutPresent: false,
      stderrPresent: false,
      stdoutChars: 0,
      stderrChars: 0,
    },
    [rawOutput.toString("utf8")],
  );
});

test("packed diagnostics classify ETIMEDOUT and ENOBUFS without reading error text", () => {
  let sensitiveGetterReads = 0;
  const privateSentinel = ["private", "error", "text"].join("-");
  const sourceError = Object.assign(new Error(), { code: "ETIMEDOUT" });
  for (const property of ["message", "stack"]) {
    Object.defineProperty(sourceError, property, {
      enumerable: true,
      get() {
        sensitiveGetterReads += 1;
        throw new Error(`${privateSentinel}-${property}`);
      },
    });
  }
  const diagnostic = buildPackedCommandDiagnostics({
    result: packedCommandResult({ status: null, error: sourceError }),
    ...packedDiagnosticsOptions({ elapsedMs: 600_123 }),
  });

  assert.equal(sensitiveGetterReads, 0);
  assertMetadataOnlyDiagnostics(diagnostic, {
    operation: "packed-project-aware-global-update",
    timeoutMs: 600_000,
    elapsedMs: 600_123,
    timedOut: true,
    exitCode: null,
    errorCode: "ETIMEDOUT",
    signal: null,
    outputRetention: "metadata_only",
    stdoutPresent: false,
    stderrPresent: false,
    stdoutChars: 0,
    stderrChars: 0,
  }, [privateSentinel]);

  const capacityDiagnostic = buildPackedCommandDiagnostics({
    result: packedCommandResult({
      status: null,
      error: Object.assign(new Error(), { code: "ENOBUFS" }),
    }),
    ...packedDiagnosticsOptions({ elapsedMs: 17 }),
  });
  assert.equal(capacityDiagnostic.errorCode, "ENOBUFS");
  assert.equal(capacityDiagnostic.timedOut, false);
});

test("packed command helper requires valid metadata-only options and never falls back to raw failure", () => {
  const runtimeText = (...parts) => parts.join("");
  const rawOutput = runtimeText("raw-", "output-private-sentinel");
  const rawError = runtimeText("raw-", "error-private-sentinel");
  const result = packedCommandResult({
    status: 9,
    error: Object.assign(new Error(rawError), { code: "EIO" }),
    stdout: rawOutput,
    stderr: rawOutput,
  });

  const invalidOptions = [
    undefined,
    null,
    {},
    packedDiagnosticsOptions({ operation: "unknown-operation" }),
    packedDiagnosticsOptions({ timeoutMs: -1 }),
    packedDiagnosticsOptions({ elapsedMs: 1.5 }),
  ];
  for (const options of invalidOptions) {
    assert.throws(
      () => requirePackedCommandSuccess(result, options),
      (error) =>
        assertSafePackedError(
          error,
          "packed command diagnostics options are invalid",
          "DIAGNOSTICS_OPTIONS_INVALID",
          [rawOutput, rawError],
        ),
    );
  }

  let optionGetterReads = 0;
  const accessorOptions = packedDiagnosticsOptions();
  Object.defineProperty(accessorOptions, "elapsedMs", {
    enumerable: true,
    get() {
      optionGetterReads += 1;
      throw new Error(rawError);
    },
  });
  assert.throws(
    () => requirePackedCommandSuccess(result, accessorOptions),
    (error) =>
      assertSafePackedError(
        error,
        "packed command diagnostics options are invalid",
        "DIAGNOSTICS_OPTIONS_INVALID",
        [rawOutput, rawError],
      ),
  );
  assert.equal(optionGetterReads, 0);
});

test("packed command result snapshot rejects accessors without executing alternating or throwing getters", () => {
  const privateSentinel = ["getter", "private", "sentinel"].join("-");
  for (const property of ["status", "error"]) {
    let getterReads = 0;
    const result = packedCommandResult();
    Object.defineProperty(result, property, {
      enumerable: true,
      get() {
        getterReads += 1;
        if (getterReads === 1) return property === "status" ? 0 : null;
        throw new Error(privateSentinel);
      },
    });
    assert.throws(
      () => requirePackedCommandSuccess(result, packedDiagnosticsOptions()),
      (error) =>
        assertSafePackedError(
          error,
          "packed command result snapshot is invalid",
          "COMMAND_RESULT_INVALID",
          [privateSentinel],
        ),
    );
    assert.equal(getterReads, 0);
  }
});

test("packed command result snapshot avoids ownKeys and property get traps and is read exactly once", () => {
  const descriptorReads = new Map();
  let ownKeysReads = 0;
  let propertyGetterReads = 0;
  const firstValues = packedCommandResult({ stdout: "完成🙂", stderr: "é" });
  const laterValues = packedCommandResult({
    status: 88,
    error: Object.assign(new Error(), { code: "ETIMEDOUT" }),
    stdout: "later-private-output",
    stderr: "later-private-error",
  });
  const result = new Proxy({}, {
    ownKeys() {
      ownKeysReads += 1;
      throw new Error("own-keys-private-sentinel");
    },
    get(_target, property) {
      propertyGetterReads += 1;
      throw new Error(`property-get-private-sentinel-${String(property)}`);
    },
    getOwnPropertyDescriptor(_target, property) {
      const reads = (descriptorReads.get(property) ?? 0) + 1;
      descriptorReads.set(property, reads);
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: reads === 1 ? firstValues[property] : laterValues[property],
      };
    },
  });

  const success = requirePackedCommandSuccess(result, packedDiagnosticsOptions());
  assert.equal(ownKeysReads, 0);
  assert.equal(propertyGetterReads, 0);
  for (const property of ["status", "error", "signal", "stdout", "stderr"]) {
    assert.equal(descriptorReads.get(property), 1, `${property} was re-read after snapshot`);
  }
  assert.equal(success.status, 0);
  assert.equal(success.boundedDiagnostics.exitCode, 0);
  assert.equal(success.boundedDiagnostics.errorCode, null);
  assert.equal(success.boundedDiagnostics.timedOut, false);
  assert.equal(success.boundedDiagnostics.stdoutChars, firstValues.stdout.length);
  assert.equal(success.boundedDiagnostics.stderrChars, firstValues.stderr.length);
});

test("packed command result snapshot converts throwing Proxy descriptor traps to a fixed safe failure", () => {
  const privateSentinel = ["descriptor", "trap", "private", "sentinel"].join("-");
  const result = new Proxy({}, {
    getOwnPropertyDescriptor(_target, property) {
      if (property === "status") throw new Error(privateSentinel);
      return {
        configurable: true,
        enumerable: true,
        writable: true,
        value: null,
      };
    },
  });
  assert.throws(
    () => requirePackedCommandSuccess(result, packedDiagnosticsOptions()),
    (error) =>
      assertSafePackedError(
        error,
        "packed command result snapshot is invalid",
        "COMMAND_RESULT_INVALID",
        [privateSentinel],
      ),
  );
});

test("packed command helper fails closed on ETIMEDOUT and ENOBUFS for both extended-timeout operations", () => {
  const rawErrorSentinel = ["raw", "error", "private", "sentinel"].join("-");
  const stdoutSentinel = ["stdout", "private", "sentinel"].join("-");
  const stderrSentinel = ["stderr", "private", "sentinel"].join("-");
  for (const operation of [
    "packed-project-aware-global-update",
    "packed-portable-runtime-global-update",
  ]) {
    for (const code of ["ETIMEDOUT", "ENOBUFS"]) {
      const sourceError = Object.assign(new Error(rawErrorSentinel), { code });
      const timeoutResult = packedCommandResult({
        status: null,
        signal: "SIGTERM",
        error: sourceError,
        stdout: stdoutSentinel,
        stderr: stderrSentinel,
      });

      assert.throws(
        () =>
          requirePackedCommandSuccess(
            timeoutResult,
            packedDiagnosticsOptions({ operation, elapsedMs: 600_123 }),
          ),
        (error) => {
          assertSafePackedError(
            error,
            "packed command failed",
            code,
            [rawErrorSentinel, stdoutSentinel, stderrSentinel],
          );
          assert.equal(error.boundedDiagnostics.operation, operation);
          assert.equal(error.boundedDiagnostics.timedOut, code === "ETIMEDOUT");
          assert.equal(error.boundedDiagnostics.stdoutChars, stdoutSentinel.length);
          assert.equal(error.boundedDiagnostics.stderrChars, stderrSentinel.length);
          return true;
        },
      );
    }
  }
});

test("project-aware packed command success rejects zero exit with signal or non-null error state", () => {
  const stdoutSentinel = ["strict", "stdout", "private", "sentinel"].join("-");
  const stderrSentinel = ["strict", "stderr", "private", "sentinel"].join("-");
  const unknownSignal = ["SIG", "PRIVATE", "UNKNOWN"].join("_");
  const cases = [
    {
      name: "allowlisted termination signal",
      overrides: { signal: "SIGTERM" },
      expectedSignal: "SIGTERM",
      sensitiveValues: [stdoutSentinel, stderrSentinel],
    },
    {
      name: "unknown termination signal",
      overrides: { signal: unknownSignal },
      expectedSignal: null,
      sensitiveValues: [stdoutSentinel, stderrSentinel, unknownSignal],
    },
    {
      name: "undefined error state",
      overrides: { error: undefined },
      expectedSignal: null,
      sensitiveValues: [stdoutSentinel, stderrSentinel],
    },
  ];

  for (const scenario of cases) {
    const result = packedCommandResult({
      stdout: stdoutSentinel,
      stderr: stderrSentinel,
      ...scenario.overrides,
    });
    assert.throws(
      () => requirePackedCommandSuccess(result, packedDiagnosticsOptions()),
      (error) => {
        assertSafePackedError(
          error,
          "packed command failed",
          null,
          scenario.sensitiveValues,
        );
        assert.equal(error.boundedDiagnostics.exitCode, 0, scenario.name);
        assert.equal(error.boundedDiagnostics.signal, scenario.expectedSignal, scenario.name);
        assert.equal(error.boundedDiagnostics.timedOut, false, scenario.name);
        assert.equal(
          error.boundedDiagnostics.stdoutChars,
          stdoutSentinel.length,
          scenario.name,
        );
        assert.equal(
          error.boundedDiagnostics.stderrChars,
          stderrSentinel.length,
          scenario.name,
        );
        return true;
      },
      scenario.name,
    );
  }
});

test("project-aware packed command success returns only a frozen safe snapshot", () => {
  const successStdout = "completed\n";
  const sourceError = { private: "must-not-return" };
  const success = requirePackedCommandSuccess(
    packedCommandResult({ stdout: successStdout, stderr: "完成" }),
    packedDiagnosticsOptions({ elapsedMs: 321 }),
  );
  assert.equal(Object.isFrozen(success), true);
  assert.deepEqual(Object.keys(success).sort(), [
    "boundedDiagnostics",
    "signal",
    "status",
  ]);
  assert.equal(success.status, 0);
  assert.equal(success.signal, null);
  assert.equal("stdout" in success, false);
  assert.equal("stderr" in success, false);
  assert.equal("error" in success, false);
  assert.equal(JSON.stringify(success).includes(sourceError.private), false);
  assertMetadataOnlyDiagnostics(success.boundedDiagnostics, {
    operation: "packed-project-aware-global-update",
    timeoutMs: 600_000,
    elapsedMs: 321,
    timedOut: false,
    exitCode: 0,
    errorCode: null,
    signal: null,
    outputRetention: "metadata_only",
    stdoutPresent: true,
    stderrPresent: true,
    stdoutChars: successStdout.length,
    stderrChars: "完成".length,
  });

  const projectAwareGlobalUpdate = acceptanceFunctionSource(
    "runInstalledPublicGlobalUpdateFromProject",
    "runProjectCapabilityCopy",
  );
  assert.match(projectAwareGlobalUpdate, /requirePackedCommandSuccess/u);

  const runtimeSedimentationLane = acceptanceFunctionSource(
    "runRuntimeSedimentationLane",
    "runProjectPackageLane",
  );
  assert.match(
    runtimeSedimentationLane,
    /runInstalledPublicGlobalUpdateFromProject/u,
    "ETIMEDOUT must remain a thrown lane failure instead of diagnostic success",
  );

  const acceptanceRunner = acceptanceFunctionSource(
    "runPackedUserInstallUpdateAcceptance",
    "main",
  );
  assert.match(
    acceptanceRunner,
    /status: "failed",[\s\S]*?boundedDiagnostics: error\.boundedDiagnostics \?\? null/u,
  );
});

test("setup persists project projection mode only after successful project-scope completion", () => {
  const installSource = functionSource("runInstall", "runUpdate");
  const updateSource = functionSource("runUpdate", "runCheck");
  const installSummaryIndex = installSource.indexOf("summarizeInstallStatus(stepResults)");
  const installModeWriteIndexes = [
    ...installSource.matchAll(/rememberProjectProjectionMode/gu),
  ].map((match) => match.index);

  assert.ok(installSummaryIndex >= 0);
  assert.equal(installModeWriteIndexes.length, 1);
  assert.ok(
    installModeWriteIndexes[0] > installSummaryIndex,
    "cancelled or failed install must not persist a projection mode",
  );
  const updateSummaryIndex = updateSource.indexOf("summarizeInstallStatus(stepResults)");
  const updateModeWriteIndexes = [
    ...updateSource.matchAll(/rememberProjectProjectionMode/gu),
  ].map((match) => match.index);
  assert.equal(updateModeWriteIndexes.length, 1);
  assert.ok(
    updateModeWriteIndexes[0] > updateSummaryIndex,
    "failed project update must not persist a projection mode",
  );
  assert.match(updateSource, /needProject\s*&&[\s\S]*rememberProjectProjectionMode/u);
});

test("verify-all blocks release-grade when packed public CLI acceptance fails", () => {
  assert.match(verifyAllSource, /runPackedUserInstallUpdateAcceptance/u);
  assert.match(verifyAllSource, /packedProductProofComplete\(packedUserProof\)/u);
  assert.match(verifyAllSource, /packed-user-install-update-acceptance/u);
  assert.match(verifyAllSource, /npm-packed public CLI/u);
});

test("packed release proof derives canonical Agents and the CLI bin instead of hardcoding them", () => {
  const expectedAgentTargets = resolveGlobalAgentProjectionTargets(
    runtimeProfiles,
    syncManifest.supportedTargets,
  ).map((target) => target.targetId);
  assert.deepEqual(
    PACKED_GLOBAL_AGENT_TARGETS.map((target) => target.targetId),
    expectedAgentTargets,
  );
  assert.ok(expectedAgentTargets.includes("cursor"));
  assert.match(acceptanceSource, /function canonicalAgentIds\(workspace\)/u);
  assert.match(acceptanceSource, /readdirSync\(agentsDir\)/u);
  assert.match(acceptanceSource, /function expectedGlobalAgentArtifacts\(/u);
  assert.match(acceptanceSource, /resolveGlobalAgentProjectionTargets/u);
  assert.match(acceptanceSource, /globalAgentProjectionFileName/u);
  assert.match(acceptanceSource, /resolvePortableMetaKimPackageIdentity/u);
  assert.match(acceptanceSource, /identity\.cliName/u);
  assert.doesNotMatch(
    acceptanceSource.slice(
      acceptanceSource.indexOf("function canonicalAgentIds"),
      acceptanceSource.indexOf("function expectedGlobalAgentArtifacts"),
    ),
    /meta-warden|meta-sentinel|meta-prism/u,
  );
});

test("packed release proof exercises explicitly authorized global Hooks and preserves unknown runtime state", () => {
  assert.match(acceptanceSource, /META_KIM_WITH_GLOBAL_HOOKS: "1"/u);
  assert.match(acceptanceSource, /"--with-global-hooks"/u);
  assert.match(acceptanceSource, /packed global Hook release check/u);
  assert.match(acceptanceSource, /seeded\.userAgents/u);
  assert.match(acceptanceSource, /unknown \$\{userAgent\.targetId\} Agent/u);
  assert.match(acceptanceSource, /unknown user Hook/u);
});

test("packed release proof migrates durable Claude MCP registration and proves transport after pack deletion", () => {
  const portablePreparation = acceptanceFunctionSource(
    "runPortableRuntimePreparation",
    "probePackedMcpTransport",
  );
  assert.match(acceptanceSource, /claudeUserConfigPath = path\.join\(roots\.userHome, "\.claude\.json"\)/u);
  assert.match(acceptanceSource, /meta_kim_runtime/u);
  assert.match(acceptanceSource, /event: "packed_legacy_mcp_migration_complete"/u);
  assert.ok(
    acceptanceSource.indexOf('event: "packed_legacy_mcp_migration_complete"') <
      acceptanceSource.indexOf("prepared.context.advisorySnapshot = copyRuntimeCapabilityObservationSnapshot"),
    "historical-user migration proof must be emitted before unrelated live observation evidence is copied",
  );
  const historicalUpdateCall = acceptanceSource.lastIndexOf("runHistoricalUpdateLane({");
  const advisorySnapshotCapture = acceptanceSource.indexOf(
    "prepared.context.advisorySnapshot = copyRuntimeCapabilityObservationSnapshot",
  );
  const portableReadbackCall = acceptanceSource.lastIndexOf("finalizePortableRuntimeProof(");
  assert.ok(
    historicalUpdateCall < advisorySnapshotCapture &&
      advisorySnapshotCapture < portableReadbackCall,
    "the advisory snapshot must be captured after the slow historical-update lane and immediately before portable readback",
  );
  assert.match(acceptanceSource, /mcpServers\?\.\["meta-kim-runtime"\]/u);
  assert.match(acceptanceSource, /resolveDurableMetaKimRuntimeLayout/u);
  assert.match(acceptanceSource, /packedCliSha256/u);
  assert.match(acceptanceSource, /durableLayout\.serverPath/u);
  assert.match(acceptanceSource, /unknown user MCP server/u);
  assert.match(acceptanceSource, /unknown Claude auth state/u);
  assert.match(acceptanceSource, /rmSync\(packageInfo\.extractDir/u);
  assert.match(acceptanceSource, /packed durable CLI MCP transport/u);
  assert.match(acceptanceSource, /get_meta_runtime_capabilities/u);
  assert.match(acceptanceSource, /runtime-capability-matrix\.json/u);
  assert.match(acceptanceSource, /semanticMatrixMatched: true/u);
  assert.match(acceptanceSource, /stubFree: true/u);
  assert.match(acceptanceSource, /evidenceTier: "packed_isolated_transport"/u);
  assert.match(acceptanceSource, /liveHostInvocation: false/u);
  assert.match(acceptanceSource, /copyRuntimeCapabilityObservationSnapshot/u);
  assert.match(acceptanceSource, /portableAdvisorySnapshot: true/u);
  assert.match(acceptanceSource, /runtime", "status", "--require-fresh"/u);
  assert.match(acceptanceSource, /assertExactStandardRuntimeObservationSet\(populatedPayload\.results\)/u);
  assert.match(acceptanceSource, /assertExactStandardRuntimeObservationSet\(emptyPayload\.missing\)/u);
  assert.match(acceptanceSource, /executionAuthority !== false/u);
  assert.match(acceptanceSource, /expectedObservationCount: 0/u);
  assert.match(acceptanceSource, /candidateExtractionUnavailable: true/u);
  assert.match(acceptanceSource, /candidateTarballUnavailable: true/u);
  assert.match(acceptanceSource, /repoIndependentCwd: true/u);
  assert.match(acceptanceSource, /repoIndependentEnvironment: true/u);
  assert.match(acceptanceSource, /installedPackageChecksAfterCandidateRemoval: true/u);
  assert.match(acceptanceSource, /effectivePayload\.results/u);
  assert.match(acceptanceSource, /effectivePayload\.missing/u);
  assert.doesNotMatch(acceptanceSource, /seedPackedReferenceOnlyOverlay/u);
  assert.doesNotMatch(
    portablePreparation,
    /originalHomes|environment\.HOME|environment\.USERPROFILE/u,
    "an isolated runtime under the host temp directory must not fail merely because the temp path is below the real user home",
  );
  assert.match(
    portablePreparation,
    /const forbiddenRoots = \[\s*packageInfo\.sourceRoot,\s*packageInfo\.workspace,\s*seeded\.legacyPackageRoot,\s*\]/u,
    "portability must still reject source, deleted pack, and retired package roots",
  );
  assert.match(acceptanceSource, /missingCount: effectivePayload\.missing\.length/u);
  assert.match(acceptanceSource, /executionAuthority: effectivePayload\.executionAuthority/u);
  assert.match(acceptanceSource, /observedInCurrentRun: effectivePayload\.observedInCurrentRun/u);
  assert.match(acceptanceSource, /currentHostAdapter: effectivePayload\.currentHostAdapter/u);
  assert.match(verifyAllSource, /from "\.\/packed-product-proof\.mjs"/u);
  assert.match(verifyAllSource, /packedProductProofComplete\(packedUserProof\)/u);
  assert.match(auditReleaseSource, /from "\.\/packed-product-proof\.mjs"/u);
  assert.match(auditReleaseSource, /packedProductProofComplete\(packedUserProof\)/u);
  assert.match(runtimeAcceptanceSource, /from "\.\/packed-product-proof\.mjs"/u);
  assert.match(runtimeAcceptanceSource, /packedProductProofComplete\(proof\)/u);
  assert.match(packedProofSource, /portableRuntime\.populatedMcpTransport/u);
  assert.match(packedProofSource, /portableRuntime\.emptyMcpTransport/u);
  assert.match(packedProofSource, /populatedMcpTransport\?\.missingCount === 0/u);
  assert.match(packedProofSource, /emptyMcpTransport\?\.missingCount === 10/u);
  assert.match(packedProofSource, /currentHostAdapter ===\s*"unavailable_over_mcp_resource_read"/u);
  assert.match(packedProofSource, /portableRuntime\.advisorySnapshot/u);
  assert.match(packedProofSource, /candidateExtractionUnavailable/u);
  assert.match(packedProofSource, /candidateTarballUnavailable/u);
  assert.match(packedProofSource, /repoIndependentCwd/u);
  assert.match(packedProofSource, /repoIndependentEnvironment/u);
  assert.match(packedProofSource, /installedPackageChecksAfterCandidateRemoval/u);
  assert.doesNotMatch(packedProofSource, /installedPackageChecksAfterSourceDeletion/u);
  assert.match(coreLoopReleaseEvidenceSource, /legacyCountOnly/u);
  assert.match(coreLoopReleaseEvidenceSource, /missingExactFact/u);
  assert.match(coreLoopReleaseEvidenceSource, /onePlatform/u);
});

test("packed release proof survives deletion of an npx-shaped current package root", () => {
  assert.match(
    acceptanceSource,
    /import \{[\s\S]*?PROJECTION_PACKAGE_PURPOSE[\s\S]*?\} from "\.\/global-projection-package-store\.mjs"/u,
  );
  assert.doesNotMatch(
    acceptanceSource,
    /cross-runtime-global-projection-package-bundle/u,
  );
  assert.match(acceptanceSource, /function prepareTransientPackageRoot/u);
  assert.match(acceptanceSource, /function runTransientPackageRootLane/u);
  assert.match(
    acceptanceSource,
    /"install",[\s\S]*?"--prefix",[\s\S]*?transientPrefix,[\s\S]*?packageInfo\.tarball/u,
  );
  assert.match(
    acceptanceSource,
    /fresh transient npx-shaped package unexpectedly contains package-local runtime state/u,
  );
  assert.doesNotMatch(
    acceptanceSource,
    /cpSync\(descriptor\.globalNodeModules, transientNodeModules/u,
  );
  assert.match(acceptanceSource, /"_npx"[\s\S]*?"node_modules"/u);
  assert.match(
    acceptanceSource,
    /transientCliPath[\s\S]*?"update"[\s\S]*?TRANSIENT_PACKAGE_TARGETS\.join\(","\)[\s\S]*?"--with-global-hooks"/u,
  );
  assert.match(acceptanceSource, /rmSync\(roots\.npmCache, \{ recursive: true, force: true \}\)/u);
  assert.match(acceptanceSource, /rmSync\(roots\.cliPrefix, \{ recursive: true, force: true \}\)/u);
  assert.match(acceptanceSource, /packageInfo\.sourceRoot/u);
  assert.match(acceptanceSource, /remainingDisposableOrigins\.length > 0/u);
  assert.match(
    acceptanceSource,
    /authorityAfterApply\.publicCliPath[\s\S]*?"check"[\s\S]*?"--scope"[\s\S]*?"global"[\s\S]*?"--with-global-hooks"/u,
  );
  assert.match(
    acceptanceFunctionSource("finalizePortableRuntimeProof", "expectedProjectArtifacts"),
    /currentProjectionPackageAuthority\([\s\S]*?authority\.packageRoot[\s\S]*?sync-runtimes\.mjs[\s\S]*?authority\.packageRoot[\s\S]*?sync-global-meta-theory\.mjs/u,
    "post-deletion exact checks must execute from the immutable authority, not the disposable installed origin",
  );
  assert.match(
    acceptanceSource,
    /path\.join\(roots\.userHome, "\.meta-kim", "install-manifest\.json"\)[\s\S]*?structuredRuntimeReadback\(textByPath\)[\s\S]*?collectNonPortablePackedReferences/u,
  );
  assert.match(
    acceptanceSource,
    /const transientPackage = prepareTransientPackageRoot[\s\S]*?currentPackage\.portableRuntime = finalizePortableRuntimeProof[\s\S]*?currentPackage\.transientPackageRoot = runTransientPackageRootLane/u,
  );
  assert.match(
    verifyAllSource,
    /runPackedUserInstallUpdateAcceptance\(\{[\s\S]*?repoRoot,[\s\S]*?environment,[\s\S]*?onProgress: probeProgress,[\s\S]*?\}\)/u,
  );
  for (const requiredFact of [
    "publicCliApplied",
    "originDeletedBeforeCheck",
    "stablePublicCliCheck",
    "claudeCodexReadback",
    "forbiddenRootReferenceCount",
    "authorityReused",
    "referencedPathCount",
    "authorityPurpose",
    "stableAuthorityDigest",
    "stableAuthorityPath",
    "stablePackageRoot",
    "stableAuthorityReferenceCount",
    "declaredPackageRootCount",
    "allPersistentPackageReferencesBound",
    "allReferencedPathsExist",
    "manifestAuthorityBound",
    "disposableOriginCount",
    "remainingDisposableOriginCount",
  ]) {
    assert.match(acceptanceSource, new RegExp(`${requiredFact}:`, "u"));
    assert.match(packedProofSource, new RegExp(`transientPackageRoot\\?\\.${requiredFact}`, "u"));
    assert.match(coreLoopReleaseEvidenceSource, new RegExp(requiredFact, "u"));
  }
});

test("packed MCP acceptance follows the shared durable strategy across supported path shapes", () => {
  const pathShapes = [
    ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\Runtime\\.meta-kim\\runtime\\meta-kim\\current\\bin\\meta-kim.mjs"],
    ["/usr/bin/node", "/home/runtime/.meta-kim/runtime/meta-kim/current/bin/meta-kim.mjs"],
    ["/opt/homebrew/bin/node", "/Users/runtime/.meta-kim/runtime/meta-kim/current/bin/meta-kim.mjs"],
  ];
  for (const [nodePath, cliPath] of pathShapes) {
    const definition = buildDurableMetaKimMcpServer(nodePath, cliPath);
    assert.equal(
      durableMcpDefinitionMatches(definition, definition),
      true,
      `${nodePath} shared MCP definition must pass packed acceptance`,
    );
    const drifted = structuredClone(definition);
    drifted.args.push("--unexpected");
    assert.equal(
      durableMcpDefinitionMatches(drifted, definition),
      false,
      `${nodePath} drifted MCP definition must fail packed acceptance`,
    );
  }

  const validatorSource = acceptanceFunctionSource(
    "durableMcpDefinitionMatches",
    "isPathWithin",
  );
  assert.match(validatorSource, /mcpDefinitionFingerprint/u);
  assert.doesNotMatch(validatorSource, /slice\(-2\)|\["mcp",\s*"serve"\]/u);
});
