import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  captureReleaseSourceSnapshot,
  compareReleaseSourceSnapshotSequence,
  compareReleaseSourceSnapshots,
  buildVerificationStages,
  computeLiveCertified,
  computeReleaseGrade,
  computeVerificationClaims,
  LIVE_CERTIFIED_STAGE,
  packedProductProofComplete,
  RELEASE_RUNTIME_TARGETS,
  resolveReleaseOperationTimeout,
  runAllRuntimeGlobalInstallUpdateProbe,
  runReleasePreflight,
  STAGES,
} from "../../scripts/run-verify-all.mjs";
import { PROJECTION_PACKAGE_PURPOSE } from "../../scripts/global-projection-package-store.mjs";

const CORE_LOOP_CONTRACT = JSON.parse(readFileSync("config/contracts/core-loop-contract.json", "utf8"));
const runFixtureRaw = readFileSync("tests/fixtures/run-artifacts/valid-core-loop-release-run.json", "utf8");
const RUN_FIXTURE = JSON.parse(runFixtureRaw);
const changelog = readFileSync("CHANGELOG.md", "utf8");
const changelogZh = readFileSync("CHANGELOG.zh-CN.md", "utf8");
const gitignore = readFileSync(".gitignore", "utf8");
const scriptsReadme = readFileSync("scripts/README.md", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const verifyRunnerSource = readFileSync("scripts/run-verify-all.mjs", "utf8");
const evalMetaAgentsSource = readFileSync("scripts/eval-meta-agents.mjs", "utf8");

function completePackedProductProof() {
  return {
    status: "passed",
    releaseGradeEligible: true,
    sourcePolicy: "npm_pack_installed_public_cli",
    currentVersionTagAbsent: true,
    currentPackage: {
      status: "passed",
      installedCliEntrypoints: true,
      packageSha256: "b".repeat(64),
      targets: [...RELEASE_RUNTIME_TARGETS],
      modes: [
        { mode: "install", status: "passed" },
        { mode: "update", status: "passed" },
        { mode: "update", status: "passed" },
      ],
      automaticOrphanBootRepair: {
        status: "passed",
        evidenceTier: "packed_isolated_installed_public_cli",
        fixture: "exact_startup_vbs_with_missing_command_target",
        removedBeforeDependencyWork: true,
      },
      packedUninstall: {
        status: "passed",
        platform: "win32",
        evidenceTier: "packed_isolated_installed_public_cli",
        packageSha256: "b".repeat(64),
        isolatedHomeAndPrefix: true,
        normalManifestUninstall: {
          status: "passed",
          evidenceScope: "synthetic_manifest_fixture_consumed_by_packed_public_cli",
          descriptorIds: [
            "windows-powershell",
            "windows-command",
            "windows-startup",
          ],
          syntheticFixtureExactOwnershipAndIntegrityRecorded: true,
          allChainFilesRemoved: true,
        },
        privateManifestBypass: {
          status: "passed",
          option: "--no-manifest",
          exitCode: 2,
          rejectedByPublicCli: true,
        },
        publicCliAfterFailedUninstall: {
          status: "passed",
          commandSource: "isolated_installed_public_cli",
          withinIsolatedPrefix: true,
          entrypoint: "--help",
          exitCode: 0,
        },
        windowsRecovery: {
          status: "passed",
          fixture: "shared_renderer_exact_orphan_startup_vbs",
          missingCommandTarget: true,
          dryRunPreserved: true,
          unprovenBoundaryReported: true,
          liveRunRemoved: true,
        },
      },
      projectPackage: {
        status: "passed",
        targets: [...RELEASE_RUNTIME_TARGETS],
        modes: [
          { mode: "install", status: "passed" },
          { mode: "update", status: "passed" },
        ],
      },
      runtimeSedimentation: { status: "passed" },
      transientPackageRoot: {
        status: "passed",
        publicCliApplied: true,
        originDeletedBeforeCheck: true,
        stablePublicCliCheck: true,
        claudeCodexReadback: true,
        forbiddenRootReferenceCount: 0,
        authorityReused: true,
        referencedPathCount: 8,
        authorityPurpose: PROJECTION_PACKAGE_PURPOSE.bundle,
        stableAuthorityDigest: "a".repeat(64),
        stableAuthorityPath: "/isolated/.meta-kim/runtime/projection-packages/meta-kim/4.2.0/" + "a".repeat(64),
        stablePackageRoot: "/isolated/.meta-kim/runtime/projection-packages/meta-kim/4.2.0/" + "a".repeat(64) + "/bundle/node_modules/meta-kim",
        stableAuthorityReferenceCount: 8,
        declaredPackageRootCount: 4,
        allPersistentPackageReferencesBound: true,
        allReferencedPathsExist: true,
        manifestAuthorityBound: true,
        disposableOriginCount: 7,
        remainingDisposableOriginCount: 0,
      },
      portableRuntime: {
        status: "passed",
        agentProjection: { status: "passed" },
        ownershipManifest: {
          status: "passed",
          overlappingWriterPathCount: 0,
        },
        hookProjection: { status: "passed" },
        mcpRegistration: { status: "passed" },
        populatedMcpTransport: {
          status: "passed",
          evidenceTier: "packed_isolated_transport",
          liveHostInvocation: false,
          semanticMatrixMatched: true,
          staticEvidenceMatched: true,
          projectOverlayObserved: true,
          observationCount: 10,
          missingCount: 0,
          executionAuthority: false,
          observedInCurrentRun: false,
          currentHostAdapter: "unavailable_over_mcp_resource_read",
          externalOverlayStayedNonExecutable: true,
          platformCount: RELEASE_RUNTIME_TARGETS.length,
          stubFree: true,
        },
        emptyMcpTransport: {
          status: "passed",
          evidenceTier: "packed_isolated_transport",
          liveHostInvocation: false,
          semanticMatrixMatched: true,
          staticEvidenceMatched: true,
          projectOverlayObserved: false,
          observationCount: 0,
          missingCount: 10,
          executionAuthority: false,
          observedInCurrentRun: false,
          currentHostAdapter: "unavailable_over_mcp_resource_read",
          externalOverlayStayedNonExecutable: true,
          platformCount: RELEASE_RUNTIME_TARGETS.length,
          stubFree: true,
        },
        advisorySnapshot: {
          evidenceClass: "read_only_advisory_snapshot",
          observedInCurrentRun: false,
          executionAuthority: false,
          count: 10,
          bindings: Array.from({ length: 10 }, (_, index) => ({ index })),
        },
        portability: {
          status: "passed",
          packExtractionDeletedBeforeTransport: true,
          tarballDeletedBeforeInstalledChecks: true,
          candidateExtractionUnavailable: true,
          candidateTarballUnavailable: true,
          repoIndependentCwd: true,
          repoIndependentEnvironment: true,
          installedPackageChecksAfterCandidateRemoval: true,
        },
      },
    },
    historicalUpdate: {
      status: "passed",
      targets: [...RELEASE_RUNTIME_TARGETS],
      completed: true,
      historicalRef: "v4.1.9",
      resolution: {
        ref: "v4.1.9",
        source: "highest_prior_stable_semver_tag",
      },
      beforeVersion: "4.1.9",
      afterVersion: "4.2.0",
      seedMethod: "historical_tarball_installed_cli",
      updateMethod: "current_tarball_installed_cli",
      checkMethod: "current_update_internal_global_check_plus_exact_artifact_manifest_validation",
    },
  };
}

function initializeUntaggedReleaseRepo(root, version = "7.8.9") {
  const git = (...args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(git("init", "--quiet").status, 0);
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "release-preflight-fixture", version })}\n`,
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
}

test("verify checks discovery read-only before the sole runtime mirror writer", () => {
  const discoveryIndex = STAGES.findIndex((stage) => stage.name === "discover:global");
  const catalogIndex = STAGES.findIndex(
    (stage) => stage.name === "meta:agents:migration-catalog:check",
  );
  const syncIndex = STAGES.findIndex((stage) => stage.name === "meta:sync");
  const checkIndex = STAGES.findIndex((stage) => stage.name === "meta:check");

  assert.ok(discoveryIndex >= 0);
  assert.match(STAGES[discoveryIndex].cmd, /discover:global -- --check/u);
  assert.ok(catalogIndex > discoveryIndex, "release verification must check the migration catalog");
  assert.ok(catalogIndex < syncIndex, "the catalog check must remain a read-only source gate");
  assert.ok(syncIndex > discoveryIndex, "runtime projection sync must follow discovery");
  assert.equal(
    STAGES[syncIndex].cmd,
    `npm run meta:sync -- --targets ${RELEASE_RUNTIME_TARGETS.join(",")}`,
    "full release verification must not collapse the project projection back to machine-local default runtimes",
  );
  assert.match(
    STAGES[checkIndex].cmd,
    new RegExp(
      `meta:check:runtimes -- --targets ${RELEASE_RUNTIME_TARGETS.join(",")}`,
      "u",
    ),
    "the release readback must check the same explicit target set that the release sync generated",
  );
  assert.ok(checkIndex > syncIndex, "runtime check must follow the sole mirror writer");
});

test("standard and smoke release gates reject a stale global Agent migration catalog", () => {
  assert.equal(
    packageJson.scripts?.["meta:agents:migration-catalog:check"],
    "node scripts/generate-global-agent-migration-catalog.mjs --check",
  );
  assert.match(
    packageJson.scripts?.["meta:release:smoke"] ?? "",
    /npm run meta:agents:migration-catalog:check/u,
  );
  assert.match(verifyRunnerSource, /meta:agents:migration-catalog:check/u);
});

test("core-loop release public evidence maps the default governed path", () => {
  assert.deepEqual(CORE_LOOP_CONTRACT.defaultEntry.spine, [
    "Critical",
    "Fetch",
    "Thinking",
    "Execution",
    "Review",
    "Meta-Review",
    "Verification",
    "Evolution",
  ]);
  assert.equal(CORE_LOOP_CONTRACT.defaultEntry.packageScript, "meta:theory:run");
  assert.equal(CORE_LOOP_CONTRACT.defaultEntry.contractIsDefaultPath, true);

  assert.equal(RUN_FIXTURE.runHeader.primaryDeliverable, "core-loop-governed-execution-repair");
  assert.match(RUN_FIXTURE.intentPacket.realIntent, /governed eight-stage core loop/);
  assert.ok(Array.isArray(RUN_FIXTURE.workerTaskPackets));
  assert.ok(RUN_FIXTURE.workerTaskPackets.length > 0);
  assert.equal(RUN_FIXTURE.verificationPacket.verified, true);
  assert.equal(RUN_FIXTURE.summaryPacket.publicReady, true);

  assert.ok(changelog.includes(`## [${packageJson.version}]`), "English changelog missing current version");
  assert.ok(changelogZh.includes(`## [${packageJson.version}]`), "Chinese changelog missing current version");
  assert.match(changelog, /Run-Scoped Worker Execution/);
  assert.match(changelogZh, /Run-scoped Worker 实机执行/);
});

test("docs PDR stays local-private and public fixtures avoid private paths", () => {
  assert.match(gitignore, /^docs\/\*\*/m);
  assert.doesNotMatch(gitignore, /^!docs\/pdr\//m);
  assert.doesNotMatch(gitignore, /^!docs\/pdr\/\*\.md/m);
  assert.doesNotMatch(runFixtureRaw, /docs\/pdr|current-core-loop-release/);
});

test("release verification path includes governance tests", () => {
  assert.match(packageJson.scripts["meta:verify:all"], /node scripts\/run-verify-all\.mjs/);
  assert.match(verifyRunnerSource, /npm run meta:verify:governance:core/);
  assert.match(packageJson.scripts["meta:verify:governance:core"], /npm run meta:test:governance/);
  assert.match(packageJson.scripts["meta:verify:governance"], /meta:open-source-boundary:validate/);
  assert.match(packageJson.scripts["meta:verify:governance"], /meta:test:integration/);
  assert.doesNotMatch(packageJson.scripts["meta:verify:governance:core"], /meta:open-source-boundary:validate/);
  assert.doesNotMatch(packageJson.scripts["meta:verify:governance:core"], /meta:test:integration/);
  assert.match(verifyRunnerSource, /npm run meta:graphify:check/);
  assert.match(verifyRunnerSource, /node scripts\/eval-meta-agents\.mjs --primary-release-fuse/);
  assert.match(verifyRunnerSource, /npm run meta:acceptance:clean-room:require/);
  assert.doesNotMatch(
    packageJson.scripts["meta:verify:all:chain"],
    /npm run meta:acceptance:clean-room:require/,
    "standard release-grade chain must not require optional external live certification",
  );
  assert.match(packageJson.scripts["meta:verify:live-certified"], /--live-certified/);
  assert.match(
    packageJson.scripts["meta:verify:live-certified:chain"],
    /meta:verify:live-certified/,
  );
  assert.equal(
    packageJson.scripts["meta:verify:all:live"],
    "node scripts/eval-meta-agents.mjs --require-all-runtimes --live",
    "existing live runtime evaluation command must remain compatible",
  );
  for (const requiredStage of [
    "meta:verify:governance:core",
    "meta:test:inventory",
    "meta:test:unit",
    "meta:test:process-guard",
    "meta:test:setup",
    "meta:test:meta-theory",
    "meta:test:integration",
  ]) {
    assert.equal(STAGES.some((stage) => stage.name === requiredStage), true, requiredStage);
  }
  assert.equal(STAGES.some((stage) => stage.name === LIVE_CERTIFIED_STAGE.name), false);
  const runtimeFuseStages = STAGES.filter((stage) =>
    stage.cmd.includes("scripts/eval-meta-agents.mjs"),
  );
  assert.deepEqual(
    runtimeFuseStages.map(({ name, cmd }) => ({ name, cmd })),
    [{
      name: "eval-meta-agents",
      cmd: "node scripts/eval-meta-agents.mjs --primary-release-fuse",
    }],
    "standard verification must own one fixed Claude+Codex native release fuse",
  );
  assert.equal(
    STAGES.some((stage) => /--runtime=|--agent=|FIXTURE/u.test(stage.cmd)),
    false,
    "standard release stages must not narrow or fixture the primary runtime fuse",
  );
  assert.match(verifyRunnerSource, /releaseGrade/);
  assert.match(verifyRunnerSource, /续跑诊断通过/);
  assert.match(verifyRunnerSource, /--live-certified.*--from/);
  assert.match(
    packageJson.scripts["meta:acceptance:clean-room:require"],
    /require-clean-room-live-evidence\.mjs/,
  );
});

test("release stages derive runtime targets and timeout budgets from canonical policy", () => {
  const syncManifest = JSON.parse(readFileSync("config/sync.json", "utf8"));
  assert.deepEqual(RELEASE_RUNTIME_TARGETS, syncManifest.supportedTargets);
  const setupStage = STAGES.find((stage) => stage.name === "meta:test:setup");
  assert.equal(setupStage?.cmd, "npm run meta:test:setup");
  assert.ok(setupStage.timeoutMs > 0);
  const processGuardStage = STAGES.find(
    (stage) => stage.name === "meta:test:process-guard",
  );
  assert.equal(processGuardStage?.cmd, "npm run meta:test:process-guard");
  assert.ok(processGuardStage.timeoutMs > 0);
  const metaTheoryStage = STAGES.find(
    (stage) => stage.name === "meta:test:meta-theory",
  );
  assert.equal(metaTheoryStage?.cmd, "npm run meta:test:meta-theory");
  assert.ok(
    metaTheoryStage.timeoutMs >= 300_000,
    "the full meta-theory suite must retain release-sequence load headroom",
  );
  const primaryRuntimeFuseStage = STAGES.find(
    (stage) => stage.name === "eval-meta-agents",
  );
  assert.ok(primaryRuntimeFuseStage);
  assert.ok(
    primaryRuntimeFuseStage.timeoutMs >= 900_000,
    "outer release timeout must cover the dual-primary live probe worst-case budget",
  );
  assert.match(evalMetaAgentsSource, /attempt <= 2/u);
  assert.match(evalMetaAgentsSource, /timeout:\s*150_000/u);
  assert.match(
    evalMetaAgentsSource,
    /const CODEX_LIVE_TIMEOUT_MS\s*=\s*180_000/u,
  );
  const claudeWorstCaseMs = 2 * 150_000;
  const codexWorstCaseMs = 2 * 240_000;
  const processAndDiscoveryAllowanceMs = 60_000;
  assert.ok(
    claudeWorstCaseMs + codexWorstCaseMs + processAndDiscoveryAllowanceMs <
      primaryRuntimeFuseStage.timeoutMs,
    "the 900s outer stage must leave positive headroom after both primary live probes",
  );
  assert.equal(
    STAGES.some((stage) => stage.name === "meta:test:setup:packed"),
    false,
    "the standard gate must not repeat the packed CLI acceptance preflight",
  );
  const overridden = buildVerificationStages({
    META_KIM_VERIFY_TIMEOUT_META_TEST_SETUP_MS: "12345",
  }).find((stage) => stage.name === "meta:test:setup");
  assert.equal(overridden.timeoutMs, 12345);
  const processGuardOverride = buildVerificationStages({
    META_KIM_VERIFY_TIMEOUT_META_TEST_PROCESS_GUARD_MS: "23456",
  }).find((stage) => stage.name === "meta:test:process-guard");
  assert.equal(processGuardOverride.timeoutMs, 23456);
  assert.throws(
    () => buildVerificationStages({
      META_KIM_VERIFY_TIMEOUT_META_TEST_SETUP_MS: "0",
    }),
    /must be a positive integer/u,
  );
  assert.equal(
    resolveReleaseOperationTimeout(
      "all-runtime-global-install-update-probe-mode",
      {},
    ),
    180000,
  );
  assert.equal(
    resolveReleaseOperationTimeout(
      "all-runtime-global-install-update-probe-mode",
      {
        META_KIM_VERIFY_TIMEOUT_ALL_RUNTIME_GLOBAL_INSTALL_UPDATE_PROBE_MODE_MS:
          "24680",
      },
    ),
    24680,
  );
  assert.throws(
    () => resolveReleaseOperationTimeout(
      "all-runtime-global-install-update-probe-mode",
      {
        META_KIM_VERIFY_TIMEOUT_ALL_RUNTIME_GLOBAL_INSTALL_UPDATE_PROBE_MODE_MS:
          "invalid",
      },
    ),
    /must be a positive integer/u,
  );
  assert.doesNotMatch(
    verifyRunnerSource,
    /RELEASE_PROBE_MODE_TIMEOUT_MS\s*=\s*[0-9_]+/u,
  );
});

test("verify-all owns one stage manifest and expands deterministic checks once", () => {
  assert.equal(packageJson.scripts["meta:verify:all:chain"], "npm run meta:verify:all");
  const expandCommand = (command, ancestry = []) =>
    command.split(/\s*&&\s*/u).flatMap((part) => {
      const trimmed = part.trim();
      const npmRun = trimmed.match(/^npm run ([^\s]+)(?:\s+--(?:\s+.*)?)?$/u);
      if (!npmRun) return [trimmed];
      const scriptId = npmRun[1];
      assert.equal(ancestry.includes(scriptId), false, `script cycle: ${[...ancestry, scriptId].join(" -> ")}`);
      assert.equal(typeof packageJson.scripts[scriptId], "string", `missing script: ${scriptId}`);
      return expandCommand(packageJson.scripts[scriptId], [...ancestry, scriptId]);
    });
  const expandedIds = STAGES.flatMap((stage) => expandCommand(stage.cmd));
  assert.notDeepEqual(
    expandCommand("npm run meta:check -- --json"),
    ["npm run meta:check -- --json"],
    "npm argument forwarding must still expand the referenced script",
  );
  assert.equal(new Set(expandedIds).size, expandedIds.length, expandedIds.join("\n"));
  assert.equal(
    expandedIds.filter((id) => id.includes("validate-open-source-boundary.mjs")).length,
    1,
  );
  assert.equal(
    expandedIds.filter((id) => id.includes('tests/integration/*.test.mjs')).length,
    1,
  );
});

test("standard release-grade and optional live certification remain separate", () => {
  const standardResults = STAGES.map((stage) => ({ name: stage.name, status: "passed" }));
  const standardClaims = computeVerificationClaims({
    requested: false,
    results: standardResults,
    startIndex: 0,
    packedUserProof: completePackedProductProof(),
  });
  assert.deepEqual(standardClaims, {
    releaseGrade: true,
    liveCertified: false,
    liveCertificationStatus: "not_requested",
  });
  const releaseGrade = computeReleaseGrade({
    results: standardResults,
    startIndex: 0,
    packedUserProof: completePackedProductProof(),
  });
  assert.equal(releaseGrade, true);
  assert.equal(
    computeLiveCertified({
      requested: false,
      releaseGrade,
      results: standardResults,
      startIndex: 0,
    }),
    false,
  );

  const liveResults = [
    ...standardResults,
    { name: LIVE_CERTIFIED_STAGE.name, status: "passed" },
  ];
  assert.equal(
    computeLiveCertified({
      requested: true,
      releaseGrade,
      results: liveResults,
      startIndex: 0,
    }),
    true,
  );

  const cleanRoomOnly = [
    {
      name: "meta:acceptance:clean-room:require",
      status: "passed",
    },
  ];
  assert.equal(
    computeReleaseGrade({ results: cleanRoomOnly, startIndex: STAGES.length }),
    false,
  );
  assert.equal(
    computeLiveCertified({
      requested: true,
      releaseGrade: false,
      results: STAGES.map((stage) => ({ name: stage.name, status: "passed" })),
      startIndex: STAGES.length,
    }),
    false,
  );
});

test("release-grade requires a stable captured source snapshot and all-runtime install/update proof", () => {
  const standardResults = STAGES.map((stage) => ({ name: stage.name, status: "passed" }));
  assert.equal(
    computeReleaseGrade({
      results: standardResults,
      startIndex: 0,
      sourceIntegrity: { releaseEligible: false },
      globalTargetProof: { status: "passed" },
      packedUserProof: completePackedProductProof(),
    }),
    false,
  );
  assert.equal(
    computeReleaseGrade({
      results: standardResults,
      startIndex: 0,
      sourceIntegrity: { releaseEligible: true },
      globalTargetProof: { status: "failed" },
      packedUserProof: completePackedProductProof(),
    }),
    false,
  );
  assert.equal(
    computeReleaseGrade({
      results: standardResults,
      startIndex: 0,
      sourceIntegrity: { releaseEligible: true },
      globalTargetProof: { status: "passed" },
      packedUserProof: { status: "failed" },
    }),
    false,
  );
  assert.equal(
    compareReleaseSourceSnapshots(
      {
        captureOk: true,
        head: "a",
        tree: "tree-a",
        dirty: false,
        diffHash: "diff-a",
        packageManifestHash: "pkg-a",
      },
      {
        captureOk: true,
        head: "b",
        tree: "tree-b",
        dirty: false,
        diffHash: "diff-b",
        packageManifestHash: "pkg-b",
      },
    ).releaseEligible,
    false,
  );
});

test("packed product proof requires every portable runtime subproof", () => {
  const complete = completePackedProductProof();
  assert.equal(packedProductProofComplete(complete), true);
  assert.equal(packedProductProofComplete({ status: "passed" }), false);

  const missingCurrentVersionTagFact = structuredClone(complete);
  delete missingCurrentVersionTagFact.currentVersionTagAbsent;
  assert.equal(packedProductProofComplete(missingCurrentVersionTagFact), false);
  const collidedCurrentVersionTag = structuredClone(complete);
  collidedCurrentVersionTag.currentVersionTagAbsent = false;
  assert.equal(packedProductProofComplete(collidedCurrentVersionTag), false);

  const legacyWithoutPackedUninstall = structuredClone(complete);
  delete legacyWithoutPackedUninstall.currentPackage.packedUninstall;
  assert.equal(
    packedProductProofComplete(legacyWithoutPackedUninstall),
    false,
    "cached proof without packed uninstall acceptance must be rejected",
  );
  const incompletePackedUninstall = structuredClone(complete);
  incompletePackedUninstall.currentPackage.packedUninstall
    .normalManifestUninstall.descriptorIds.pop();
  assert.equal(
    packedProductProofComplete(incompletePackedUninstall),
    false,
    "packed uninstall proof must cover the complete platform descriptor chain",
  );
  for (const [label, mutateRecoveryProof] of [
    ["missing proof", (proof) => {
      delete proof.currentPackage.packedUninstall.publicCliAfterFailedUninstall;
    }],
    ["failed status", (proof) => {
      proof.currentPackage.packedUninstall.publicCliAfterFailedUninstall.status = "failed";
    }],
    ["wrong command source", (proof) => {
      proof.currentPackage.packedUninstall.publicCliAfterFailedUninstall.commandSource = "repo_source_cli";
    }],
    ["outside isolated prefix", (proof) => {
      proof.currentPackage.packedUninstall.publicCliAfterFailedUninstall.withinIsolatedPrefix = false;
    }],
    ["wrong entrypoint", (proof) => {
      proof.currentPackage.packedUninstall.publicCliAfterFailedUninstall.entrypoint = "help";
    }],
    ["nonzero exit", (proof) => {
      proof.currentPackage.packedUninstall.publicCliAfterFailedUninstall.exitCode = 1;
    }],
    ["raw command path", (proof) => {
      proof.currentPackage.packedUninstall.publicCliAfterFailedUninstall.command =
        "C:\\Users\\fixture\\AppData\\Roaming\\npm\\meta-kim.cmd";
    }],
  ]) {
    const malformedRecovery = structuredClone(complete);
    mutateRecoveryProof(malformedRecovery);
    assert.equal(
      packedProductProofComplete(malformedRecovery),
      false,
      `packed uninstall CLI recovery must reject ${label}`,
    );
  }
  const serializedCliRecovery = JSON.stringify(
    complete.currentPackage.packedUninstall.publicCliAfterFailedUninstall,
  );
  assert.doesNotMatch(
    serializedCliRecovery,
    /(?:[A-Z]:\\|\/(?:home|tmp)\/|AppData)/iu,
    "packed uninstall CLI recovery proof must not serialize home or temporary paths",
  );
  const linuxPackedUninstall = structuredClone(complete);
  linuxPackedUninstall.currentPackage.automaticOrphanBootRepair = {
    status: "not_applicable",
    reason: "windows_startup_vbs_only",
  };
  linuxPackedUninstall.currentPackage.packedUninstall.platform = "linux";
  linuxPackedUninstall.currentPackage.packedUninstall
    .normalManifestUninstall.descriptorIds = [
      "linux-command",
      "linux-autostart",
    ];
  linuxPackedUninstall.currentPackage.packedUninstall.windowsRecovery = {
    status: "not_applicable",
    reason: "windows_exact_signature_recovery_only",
  };
  assert.equal(
    packedProductProofComplete(linuxPackedUninstall),
    true,
    "non-Windows proof keeps full manifest/private checks while recovery is not applicable",
  );
  const missingAutomaticRepair = structuredClone(complete);
  delete missingAutomaticRepair.currentPackage.automaticOrphanBootRepair;
  assert.equal(
    packedProductProofComplete(missingAutomaticRepair),
    false,
    "packed proof must include the installed CLI automatic orphan-repair lane",
  );

  for (const key of [
    "status",
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
    const incomplete = structuredClone(complete);
    delete incomplete.currentPackage.transientPackageRoot[key];
    assert.equal(
      packedProductProofComplete(incomplete),
      false,
      `transientPackageRoot.${key} must be required for packed product proof`,
    );
  }
  const leakedTransientRoot = structuredClone(complete);
  leakedTransientRoot.currentPackage.transientPackageRoot.forbiddenRootReferenceCount = 1;
  assert.equal(
    packedProductProofComplete(leakedTransientRoot),
    false,
    "transient package-root readback must reject every forbidden root reference",
  );
  const legacyAuthorityPurpose = structuredClone(complete);
  legacyAuthorityPurpose.currentPackage.transientPackageRoot.authorityPurpose =
    "cross-runtime-global-projection-package-bundle";
  assert.equal(
    packedProductProofComplete(legacyAuthorityPurpose),
    false,
    "retired projection package purposes must not satisfy packed proof",
  );
  const residualOrigin = structuredClone(complete);
  residualOrigin.currentPackage.transientPackageRoot.remainingDisposableOriginCount = 1;
  assert.equal(
    packedProductProofComplete(residualOrigin),
    false,
    "packed proof must reject a surviving disposable origin",
  );

  for (const key of [
    "agentProjection",
    "ownershipManifest",
    "hookProjection",
    "mcpRegistration",
    "populatedMcpTransport",
    "emptyMcpTransport",
    "advisorySnapshot",
    "portability",
  ]) {
    const incomplete = structuredClone(complete);
    delete incomplete.currentPackage.portableRuntime[key];
    assert.equal(
      packedProductProofComplete(incomplete),
      false,
      `${key} must be required for packed product proof`,
    );
  }

  const falselyLive = structuredClone(complete);
  falselyLive.currentPackage.portableRuntime.populatedMcpTransport.liveHostInvocation = true;
  assert.equal(packedProductProofComplete(falselyLive), false);

  for (const targetOwner of ["currentPackage", "projectPackage", "historicalUpdate"]) {
    const missingTargets = structuredClone(complete);
    const owner = targetOwner === "projectPackage"
      ? missingTargets.currentPackage.projectPackage
      : missingTargets[targetOwner];
    delete owner.targets;
    assert.equal(
      packedProductProofComplete(missingTargets),
      false,
      `${targetOwner}.targets must be required`,
    );

    const oneTarget = structuredClone(complete);
    const oneTargetOwner = targetOwner === "projectPackage"
      ? oneTarget.currentPackage.projectPackage
      : oneTarget[targetOwner];
    oneTargetOwner.targets = [RELEASE_RUNTIME_TARGETS[0]];
    assert.equal(
      packedProductProofComplete(oneTarget),
      false,
      `${targetOwner}.targets must match every canonical packed target`,
    );
  }

  for (const transportKey of ["populatedMcpTransport", "emptyMcpTransport"]) {
    const onePlatform = structuredClone(complete);
    onePlatform.currentPackage.portableRuntime[transportKey].platformCount = 1;
    assert.equal(
      packedProductProofComplete(onePlatform),
      false,
      `${transportKey}.platformCount must match the canonical supported platform count`,
    );
  }

  const legacyCountOnly = structuredClone(complete);
  for (const transport of [
    legacyCountOnly.currentPackage.portableRuntime.populatedMcpTransport,
    legacyCountOnly.currentPackage.portableRuntime.emptyMcpTransport,
  ]) {
    delete transport.missingCount;
    delete transport.executionAuthority;
    delete transport.observedInCurrentRun;
    delete transport.currentHostAdapter;
  }
  assert.equal(
    packedProductProofComplete(legacyCountOnly),
    false,
    "observation counts alone must not substitute for exact partition and advisory facts",
  );

  for (const [transportKey, expectedObservationCount, expectedMissingCount] of [
    ["populatedMcpTransport", 10, 0],
    ["emptyMcpTransport", 0, 10],
  ]) {
    for (const key of [
      "missingCount",
      "executionAuthority",
      "observedInCurrentRun",
      "currentHostAdapter",
    ]) {
      const missingExactFact = structuredClone(complete);
      delete missingExactFact.currentPackage.portableRuntime[transportKey][key];
      assert.equal(
        packedProductProofComplete(missingExactFact),
        false,
        `${transportKey}.${key} must be required`,
      );
    }
    const wrongPartition = structuredClone(complete);
    wrongPartition.currentPackage.portableRuntime[transportKey].observationCount =
      expectedObservationCount + 1;
    wrongPartition.currentPackage.portableRuntime[transportKey].missingCount =
      expectedMissingCount - 1;
    assert.equal(packedProductProofComplete(wrongPartition), false);
  }

  const legacySourceDeletionOnly = structuredClone(complete);
  const legacyPortability = legacySourceDeletionOnly.currentPackage.portableRuntime.portability;
  for (const key of [
    "candidateExtractionUnavailable",
    "candidateTarballUnavailable",
    "repoIndependentCwd",
    "repoIndependentEnvironment",
    "installedPackageChecksAfterCandidateRemoval",
  ]) {
    delete legacyPortability[key];
  }
  legacyPortability.installedPackageChecksAfterSourceDeletion = true;
  assert.equal(
    packedProductProofComplete(legacySourceDeletionOnly),
    false,
    "the retired source-deletion field must not substitute for candidate-removal proof",
  );

  for (const key of [
    "candidateExtractionUnavailable",
    "candidateTarballUnavailable",
    "repoIndependentCwd",
    "repoIndependentEnvironment",
    "installedPackageChecksAfterCandidateRemoval",
  ]) {
    const missingCandidateRemovalProof = structuredClone(complete);
    delete missingCandidateRemovalProof.currentPackage.portableRuntime.portability[key];
    assert.equal(
      packedProductProofComplete(missingCandidateRemovalProof),
      false,
      `${key} must be required for packed candidate-removal proof`,
    );
  }

  for (const key of ["seedMethod", "updateMethod", "checkMethod"]) {
    const missingHistoryProof = structuredClone(complete);
    delete missingHistoryProof.historicalUpdate[key];
    assert.equal(packedProductProofComplete(missingHistoryProof), false);
  }
  const diagnostic = structuredClone(complete);
  diagnostic.status = "diagnostic_passed";
  diagnostic.releaseGradeEligible = false;
  diagnostic.historicalUpdate.status = "not_available";
  assert.equal(packedProductProofComplete(diagnostic), false);
});

test("dirty but stable source content remains release-grade while commit eligibility stays false", () => {
  const dirtySnapshot = {
    captureOk: true,
    head: "head-a",
    tree: "tree-a",
    dirty: true,
    diffHash: "diff-a",
    packageManifestHash: "pkg-a",
  };
  const sourceIntegrity = compareReleaseSourceSnapshots(
    dirtySnapshot,
    { ...dirtySnapshot },
  );
  assert.equal(sourceIntegrity.stable, true);
  assert.equal(sourceIntegrity.releaseEligible, true);
  assert.equal(sourceIntegrity.cleanCommitEligible, false);
  assert.ok(sourceIntegrity.mismatchReasons.includes("source_dirty_at_start"));
  const sequenceIntegrity = compareReleaseSourceSnapshotSequence([
    { label: "invocation", snapshot: dirtySnapshot },
    { label: "post_probe", snapshot: { ...dirtySnapshot } },
    { label: "final", snapshot: { ...dirtySnapshot } },
  ]);
  assert.equal(sequenceIntegrity.stable, true);
  assert.equal(sequenceIntegrity.releaseEligible, true);
  assert.equal(sequenceIntegrity.cleanCommitEligible, false);
  assert.equal(
    computeReleaseGrade({
      results: STAGES.map((stage) => ({ name: stage.name, status: "passed" })),
      startIndex: 0,
      sourceIntegrity,
      globalTargetProof: { status: "passed" },
      packedUserProof: completePackedProductProof(),
    }),
    true,
  );
});

test("release preflight stops before expensive probes when the current version tag exists", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-tag-preflight-"));
  initializeUntaggedReleaseRepo(tempRoot);
  const git = (...args) =>
    spawnSync("git", args, { cwd: tempRoot, encoding: "utf8", windowsHide: true });
  const stableSnapshot = {
    captureOk: true,
    head: "head-a",
    tree: "tree-a",
    dirty: false,
    diffHash: "diff-a",
    packageManifestHash: "pkg-a",
  };
  try {
    let probeCount = 0;
    const allowed = runReleasePreflight({
      repoRoot: tempRoot,
      captureSnapshot: () => ({ ...stableSnapshot }),
      runProbe: () => {
        probeCount += 1;
        return { status: "passed" };
      },
      runPackedProbe: () => {
        probeCount += 1;
        return completePackedProductProof();
      },
    });
    assert.equal(probeCount, 2, "an absent current-version tag must continue");
    assert.equal(allowed.packedUserProof.currentVersionTagAbsent, true);

    assert.equal(git("tag", "v7.8.9").status, 0);
    probeCount = 0;
    const blocked = runReleasePreflight({
      repoRoot: tempRoot,
      captureSnapshot: () => ({ ...stableSnapshot }),
      runProbe: () => {
        probeCount += 1;
        return { status: "passed" };
      },
      runPackedProbe: () => {
        probeCount += 1;
        return completePackedProductProof();
      },
    });
    assert.equal(probeCount, 0, "a current-version tag must block every expensive probe");
    assert.equal(
      blocked.globalTargetProof.status,
      "not_run_after_current_version_tag_collision",
    );
    assert.equal(blocked.packedUserProof.currentVersionTagAbsent, false);
    assert.match(blocked.packedUserProof.error, /v7\.8\.9/u);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("release preflight rejects a source mutation inside the probe window", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-preflight-"));
  initializeUntaggedReleaseRepo(tempRoot);
  try {
    const invocation = {
      captureOk: true,
      head: "head-a",
      tree: "tree-a",
      dirty: false,
      diffHash: "diff-a",
      packageManifestHash: "pkg-a",
    };
    let current = invocation;
    const preflight = runReleasePreflight({
      repoRoot: tempRoot,
      captureSnapshot: () => ({ ...current }),
      runProbe: () => {
        current = {
          ...current,
          dirty: true,
          diffHash: "diff-mutated-during-probe",
        };
        return { status: "passed" };
      },
      runPackedProbe: () => completePackedProductProof(),
    });

    assert.equal(preflight.globalTargetProof.status, "passed");
    assert.equal(preflight.sourceIntegrity.stable, false);
    assert.equal(preflight.sourceIntegrity.releaseEligible, false);
    assert.ok(
      preflight.sourceIntegrity.mismatchReasons.includes("diffHash_changed_during_verification"),
    );
    assert.deepEqual(
      preflight.sourceIntegrity.windows.map(({ from, to }) => ({ from, to })),
      [{ from: "invocation", to: "post_probe" }],
    );

    const completeIntegrity = compareReleaseSourceSnapshotSequence([
      { label: "invocation", snapshot: preflight.sourceSnapshot.invocation },
      { label: "post_probe", snapshot: preflight.sourceSnapshot.postProbe },
      { label: "final", snapshot: { ...preflight.sourceSnapshot.postProbe } },
    ]);
    assert.equal(completeIntegrity.releaseEligible, false);
    assert.equal(
      computeReleaseGrade({
        results: STAGES.map((stage) => ({ name: stage.name, status: "passed" })),
        startIndex: 0,
        sourceIntegrity: completeIntegrity,
        globalTargetProof: preflight.globalTargetProof,
        packedUserProof: completePackedProductProof(),
      }),
      false,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("source snapshot binds HEAD tree diff state and package manifest and rejects mid-run mutation", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-snapshot-"));
  const runGit = (...args) =>
    spawnSync("git", args, { cwd: tempRoot, encoding: "utf8", windowsHide: true });
  try {
    assert.equal(runGit("init", "--quiet").status, 0);
    writeFileSync(path.join(tempRoot, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    writeFileSync(path.join(tempRoot, "tracked.txt"), "initial\n");
    assert.equal(runGit("add", ".").status, 0);
    assert.equal(
      runGit(
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

    const clean = captureReleaseSourceSnapshot(tempRoot);
    assert.equal(clean.captureOk, true);
    assert.equal(clean.dirty, false);
    assert.match(clean.head, /^[a-f0-9]{40}$/u);
    assert.match(clean.tree, /^[a-f0-9]{40}$/u);
    assert.match(clean.diffHash, /^[a-f0-9]{64}$/u);
    assert.match(clean.packageManifestHash, /^[a-f0-9]{64}$/u);

    writeFileSync(path.join(tempRoot, "tracked.txt"), "changed\n");
    const dirty = captureReleaseSourceSnapshot(tempRoot);
    const comparison = compareReleaseSourceSnapshots(clean, dirty);
    assert.equal(dirty.dirty, true);
    assert.equal(comparison.stable, false);
    assert.equal(comparison.releaseEligible, false);
    assert.ok(comparison.mismatchReasons.includes("diffHash_changed_during_verification"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("all-runtime release preflight performs real isolated install and update artifacts", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-probe-test-"));
  const installerScript = path.join(tempRoot, "fake-installer.mjs");
  try {
    initializeUntaggedReleaseRepo(tempRoot);
    writeFileSync(
      installerScript,
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        `const runtimes = ${JSON.stringify(RELEASE_RUNTIME_TARGETS)};`,
        'for (const runtime of runtimes) {',
        '  const home = process.env[`META_KIM_${runtime.toUpperCase()}_HOME`];',
        '  const target = path.join(home, "skills", "planning-with-files");',
        '  mkdirSync(target, { recursive: true });',
        '  writeFileSync(path.join(target, "SKILL.md"), "# planning-with-files\\n");',
        '}',
        'process.stdout.write(process.argv.includes("--update") ? "updated\\n" : "installed\\n");',
      ].join("\n"),
    );
    const progress = [];
    const stableSnapshot = {
      captureOk: true,
      head: "head-a",
      tree: "tree-a",
      dirty: false,
      diffHash: "diff-a",
      packageManifestHash: "package-a",
    };
    const preflight = runReleasePreflight({
      repoRoot: tempRoot,
      captureSnapshot: () => ({ ...stableSnapshot }),
      onProgress: (event) => progress.push(event),
      runProbe: ({ onProgress }) => runAllRuntimeGlobalInstallUpdateProbe({
        cwd: tempRoot,
        installerScript,
        environment: process.env,
        onProgress,
      }),
      runPackedProbe: () => ({
        ...completePackedProductProof(),
        sourcePolicy: "npm_pack_installed_public_cli",
      }),
    });
    const proof = preflight.globalTargetProof;
    assert.equal(proof.status, "passed", proof.error);
    assert.deepEqual(proof.targets, RELEASE_RUNTIME_TARGETS);
    assert.deepEqual(proof.modes.map((mode) => mode.mode), ["install", "update"]);
    assert.equal(proof.modes.every((mode) => mode.status === "passed"), true);
    assert.equal(
      proof.modes.every(
        (mode) => mode.artifactProof.length === RELEASE_RUNTIME_TARGETS.length,
      ),
      true,
    );
    assert.equal(proof.artifactProof.length, RELEASE_RUNTIME_TARGETS.length);
    assert.equal(proof.identicalArtifactHash, true);
    assert.equal(proof.sourcePolicy, "external_declared_dependency_no_local_fallback");
    assert.equal(preflight.packedUserProof.status, "passed");
    assert.equal(
      preflight.packedUserProof.sourcePolicy,
      "npm_pack_installed_public_cli",
    );
    assert.equal(progress[0].event, "release_preflight_start");
    assert.ok(progress[0].expectedDurationMs >= 360_000);
    assert.deepEqual(
      progress
        .filter((event) => event.event === "runtime_probe_mode_start" || event.event === "runtime_probe_mode_complete")
        .map((event) => [event.event, event.mode, event.status ?? null]),
      [
        ["runtime_probe_mode_start", "install", null],
        ["runtime_probe_mode_complete", "install", "passed"],
        ["runtime_probe_mode_start", "update", null],
        ["runtime_probe_mode_complete", "update", "passed"],
      ],
    );
    assert.equal(progress.at(-1).event, "release_preflight_complete");
    assert.equal(progress.at(-1).status, "passed");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("script registry classifies scripts and protects cleanup candidates", () => {
  for (const bucket of [
    "Core engines",
    "Product/report generators",
    "Runtime evidence",
    "Sync/install/release",
    "Validators",
    "Doctor/status utilities",
    "Shared helpers",
  ]) {
    assert.ok(scriptsReadme.includes(bucket), `scripts README missing bucket ${bucket}`);
  }

  assert.match(scriptsReadme, /Do not prune scripts by filename count alone/);
  assert.match(scriptsReadme, /Before removing any script, check changelog history, release notes/);
});
