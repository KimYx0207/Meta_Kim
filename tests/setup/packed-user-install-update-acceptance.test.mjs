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
  PACKED_USER_TARGETS,
  assertPackedAdvisoryEffectiveMatrix,
  durableMcpDefinitionMatches,
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
      tags: ["v4.1.9", "v4.2.0"],
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
    /runInstalledPublicCli\(currentDescriptor, roots, env, "update", timeoutMs\)/u,
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
