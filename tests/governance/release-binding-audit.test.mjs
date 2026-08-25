import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalJson,
  collectGitReleaseFacts,
  defaultReleaseAuditOutputDir,
  evaluateReleaseBinding,
  fetchGitHubReleaseFacts,
  readPackageManifestFromTgz,
  readVerificationEvidence,
  requireContainedOutput,
  runReleaseBindingAudit,
  sha256,
  summarizeReleaseBindingAttempts,
  writeReleaseBindingAttempt,
} from "../../scripts/audit-release-binding.mjs";
import {
  getProcessStartIdentity,
  RELEASE_STATE_DURABILITY,
  sanitizeUserVisibleText,
} from "../../scripts/release-state-hardening.mjs";
import { writeVerificationReportAttempt } from "../../scripts/verification-report-history.mjs";
import { PROJECTION_PACKAGE_PURPOSE } from "../../scripts/global-projection-package-store.mjs";

const DIR_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
const CANONICAL_PACKED_TARGETS = JSON.parse(
  readFileSync("config/sync.json", "utf8"),
).supportedTargets;
const PORTABLE_RUNTIME_GLOBAL_UPDATE_TIMEOUT_MS = JSON.parse(
  readFileSync("config/contracts/release-verification-policy.json", "utf8"),
).packedUserAcceptance.portableRuntimeGlobalUpdateTimeoutMs;

test("release audit promotion hashing does not create a CLI module cycle", () => {
  const acceptanceSource = readFileSync("scripts/runtime-capability-acceptance.mjs", "utf8");
  assert.match(acceptanceSource, /from "\.\/release-binding-canonical\.mjs"/u);
  assert.doesNotMatch(acceptanceSource, /from "\.\/audit-release-binding\.mjs"/u);
  assert.equal(
    canonicalJson({ z: 1, nested: { b: 2, a: 1 } }),
    '{"nested":{"a":1,"b":2},"z":1}',
  );
});

function octalField(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

function tarFile(relativePath, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const header = Buffer.alloc(512);
  header.write(`package/${relativePath}`, 0, 100, "utf8");
  header.write(octalField(0o644, 8), 100, 8, "ascii");
  header.write(octalField(0, 8), 108, 8, "ascii");
  header.write(octalField(0, 8), 116, 8, "ascii");
  header.write(octalField(bytes.length, 12), 124, 12, "ascii");
  header.write(octalField(0, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc(Math.ceil(bytes.length / 512) * 512 - bytes.length);
  return Buffer.concat([header, bytes, padding]);
}

function minimalTgz(manifest, extraFiles = []) {
  const packageJson = `${JSON.stringify(manifest, null, 2)}\n`;
  return gzipSync(Buffer.concat([
    tarFile("package.json", packageJson),
    ...extraFiles.map(({ path: relativePath, body }) => tarFile(relativePath, body)),
    Buffer.alloc(1024),
  ]));
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createReleaseRepo(version = "9.9.9") {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-audit-"));
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "meta-kim", version }, null, 2)}\n`,
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Meta Kim Test");
  git(root, "config", "user.email", "meta-kim@example.invalid");
  git(root, "remote", "add", "origin", "https://github.com/example/meta-kim.git");
  git(root, "add", "package.json");
  git(root, "commit", "--quiet", "-m", "release fixture");
  git(root, "tag", "-a", `v${version}`, "-m", `v${version}`);
  const head = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", head);
  return root;
}

function completePackedUserProof(packageSha256) {
  const transport = ({ observationCount, missingCount, populated }) => ({
    status: "passed",
    evidenceTier: "packed_isolated_transport",
    liveHostInvocation: false,
    semanticMatrixMatched: true,
    staticEvidenceMatched: true,
    projectOverlayObserved: populated,
    observationCount,
    missingCount,
    executionAuthority: false,
    observedInCurrentRun: false,
    currentHostAdapter: "unavailable_over_mcp_resource_read",
    externalOverlayStayedNonExecutable: true,
    platformCount: CANONICAL_PACKED_TARGETS.length,
    stubFree: true,
  });
  return {
    status: "passed",
    releaseGradeEligible: true,
    sourcePolicy: "npm_pack_installed_public_cli",
    currentVersionTagAbsent: true,
    currentPackage: {
      status: "passed",
      installedCliEntrypoints: true,
      packageSha256,
      targets: [...CANONICAL_PACKED_TARGETS],
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
        packageSha256,
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
        targets: [...CANONICAL_PACKED_TARGETS],
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
        stableAuthorityPath:
          `/isolated/.meta-kim/runtime/projection-packages/meta-kim/9.9.9/${"a".repeat(64)}`,
        stablePackageRoot:
          `/isolated/.meta-kim/runtime/projection-packages/meta-kim/9.9.9/${"a".repeat(64)}/bundle/node_modules/meta-kim`,
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
        globalUpdate: {
          status: "passed",
          diagnostics: {
            operation: "packed-portable-runtime-global-update",
            timeoutMs: PORTABLE_RUNTIME_GLOBAL_UPDATE_TIMEOUT_MS,
            elapsedMs: 125,
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
        },
        agentProjection: { status: "passed" },
        ownershipManifest: { status: "passed", overlappingWriterPathCount: 0 },
        hookProjection: { status: "passed" },
        mcpRegistration: { status: "passed" },
        populatedMcpTransport: transport({
          observationCount: 10,
          missingCount: 0,
          populated: true,
        }),
        emptyMcpTransport: transport({
          observationCount: 0,
          missingCount: 10,
          populated: false,
        }),
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
      targets: [...CANONICAL_PACKED_TARGETS],
      completed: true,
      historicalRef: "v9.9.8",
      resolution: { ref: "v9.9.8", source: "highest_prior_stable_semver_tag" },
      beforeVersion: "9.9.8",
      afterVersion: "9.9.9",
      seedMethod: "historical_tarball_installed_cli",
      updateMethod: "current_tarball_installed_cli",
      checkMethod:
        "current_update_internal_global_check_plus_exact_artifact_manifest_validation",
    },
  };
}

function exactReport(gitFacts, {
  dirty = false,
  packageSha256 = "a".repeat(64),
  reportedPackedProductProofComplete = true,
} = {}) {
  const snapshot = {
    captureOk: true,
    head: gitFacts.peeledCommitSha,
    tree: gitFacts.peeledTreeSha,
    dirty,
    diffHash: "d".repeat(64),
    packageManifestHash: gitFacts.tagPackageJsonSha256,
  };
  return Buffer.from(JSON.stringify({
    ok: true,
    releaseGrade: true,
    packedProductProofComplete: reportedPackedProductProofComplete,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    releasePreflight: {
      packedUserProof: completePackedUserProof(packageSha256),
      sourceSnapshot: {
        invocation: snapshot,
        postProbe: snapshot,
        end: snapshot,
        stable: true,
        cleanCommitEligible: !dirty,
        releaseEligible: true,
        mismatchReasons: [],
        windows: [
          {
            from: "invocation",
            to: "post_probe",
            stable: true,
            releaseEligible: true,
            cleanCommitEligible: !dirty,
            mismatchReasons: [],
          },
          {
            from: "post_probe",
            to: "final",
            stable: true,
            releaseEligible: true,
            cleanCommitEligible: !dirty,
            mismatchReasons: [],
          },
        ],
      },
    },
  }));
}

function githubPayload(gitFacts, assetSha, assetSize) {
  return {
    tag_name: gitFacts.tagName,
    html_url: `https://github.com/example/meta-kim/releases/tag/${gitFacts.tagName}`,
    target_commitish: "main",
    published_at: "2026-01-01T01:00:00.000Z",
    draft: false,
    prerelease: false,
    assets: [{
      name: `${gitFacts.packageName}-${gitFacts.packageVersion}.tgz`,
      size: assetSize,
      digest: `sha256:${assetSha}`,
      browser_download_url: "https://github.com/example/meta-kim/releases/download/package.tgz",
    }],
  };
}

test("release audit accepts an exact immutable v2 verification attempt", () => {
  const root = createReleaseRepo();
  const outputRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-v2-verification-audit-"));
  try {
    const gitFacts = collectGitReleaseFacts(root, "v9.9.9");
    const report = JSON.parse(exactReport(gitFacts).toString("utf8"));
    const written = writeVerificationReportAttempt({
      reportPath: path.join(outputRoot, "verification-report.json"),
      attemptId: "exact-v2-attempt",
      report,
    });
    const verification = readVerificationEvidence(
      readFileSync(written.recordPath),
      gitFacts,
    );
    assert.equal(verification.exact, true);
    assert.equal(verification.bindingStatus, "exact_commit_tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("release Git facts ignore inherited GIT_DIR and GIT_WORK_TREE redirection", () => {
  const root = createReleaseRepo();
  try {
    const gitFacts = collectGitReleaseFacts(root, "v9.9.9", {
      environment: {
        ...process.env,
        git_dir: path.join(root, "missing-attacker.git"),
        git_work_tree: path.join(root, "attacker-worktree"),
        git_config_count: "1",
      },
    });
    assert.equal(gitFacts.packageVersion, "9.9.9");
    assert.equal(gitFacts.peeledCommitSha, git(root, "rev-parse", "HEAD"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function linkDirectoryOrSkip(t, target, linkPath) {
  try {
    symlinkSync(target, linkPath, DIR_LINK_TYPE);
  } catch (error) {
    t.skip(`directory links unavailable: ${error.code ?? error.message}`);
    return false;
  }
  return true;
}

function assertNoAuditBytesChangedOutside(outsidePath, sentinelName = "sentinel.txt") {
  assert.equal(readFileSync(path.join(outsidePath, sentinelName), "utf8"), "outside bytes\n");
  assert.deepEqual(readdirSync(outsidePath).sort(), [sentinelName]);
  assert.equal(existsSync(path.join(outsidePath, "audit.lock")), false);
  assert.equal(existsSync(path.join(outsidePath, "latest-attempt.json")), false);
  assert.equal(existsSync(path.join(outsidePath, "latest-published-bound.json")), false);
  assert.equal(existsSync(path.join(outsidePath, "attempts")), false);
  assert.equal(existsSync(path.join(outsidePath, "stale-locks")), false);
}

function attemptedRecordInput(attemptId) {
  return {
    schemaVersion: "meta-kim-release-binding-audit-v1",
    attemptId,
    status: "failed",
    promotionEligible: false,
  };
}

test("release package manifest is read in-memory from a bounded npm-style tgz", () => {
  const tgz = minimalTgz({ name: "meta-kim", version: "9.9.9" });
  const parsed = readPackageManifestFromTgz(tgz);
  assert.equal(parsed.manifest.name, "meta-kim");
  assert.equal(parsed.manifest.version, "9.9.9");
  assert.equal(parsed.sha256, sha256(parsed.bytes));
  assert.throws(
    () => readPackageManifestFromTgz(Buffer.from("not gzip")),
    (error) => error.code === "package_tgz_invalid",
  );
});

test("dirty historical verification remains explicitly unbound", () => {
  const gitFacts = {
    peeledCommitSha: "a".repeat(40),
    peeledTreeSha: "b".repeat(40),
  };
  const dirty = readVerificationEvidence(exactReport({
    ...gitFacts,
    tagPackageJsonSha256: "c".repeat(64),
  }, { dirty: true }), gitFacts);
  assert.equal(dirty.bindingStatus, "verification_dirty_candidate");
  assert.equal(dirty.exact, false);
  const unavailable = readVerificationEvidence(null, gitFacts);
  assert.equal(unavailable.bindingStatus, "historical_report_unavailable");
  assert.equal(unavailable.exact, false);
  const wrongManifestReport = JSON.parse(exactReport({
    ...gitFacts,
    tagPackageJsonSha256: "c".repeat(64),
  }).toString("utf8"));
  for (const key of ["invocation", "postProbe", "end"]) {
    wrongManifestReport.releasePreflight.sourceSnapshot[key].packageManifestHash = "e".repeat(64);
  }
  const wrongManifest = readVerificationEvidence(
    Buffer.from(JSON.stringify(wrongManifestReport)),
    { ...gitFacts, tagPackageJsonSha256: "c".repeat(64) },
  );
  assert.equal(wrongManifest.bindingStatus, "verification_package_manifest_mismatch");
  assert.equal(wrongManifest.exact, false);

  const weakPackedProofReport = JSON.parse(exactReport({
    ...gitFacts,
    tagPackageJsonSha256: "c".repeat(64),
  }).toString("utf8"));
  delete weakPackedProofReport.releasePreflight.packedUserProof.currentPackage.modes;
  const weakPackedProof = readVerificationEvidence(
    Buffer.from(JSON.stringify(weakPackedProofReport)),
    { ...gitFacts, tagPackageJsonSha256: "c".repeat(64) },
  );
  assert.equal(weakPackedProof.bindingStatus, "verification_package_candidate_unproven");
  assert.equal(weakPackedProof.exact, false);
});

test("release audit recomputes packed completeness and rejects legacy or partial proof shapes", () => {
  const gitFacts = {
    peeledCommitSha: "a".repeat(40),
    peeledTreeSha: "b".repeat(40),
    tagPackageJsonSha256: "c".repeat(64),
  };
  const reportWithFalseSummary = exactReport(gitFacts, {
    reportedPackedProductProofComplete: false,
  });
  assert.equal(readVerificationEvidence(reportWithFalseSummary, gitFacts).exact, true);

  const reject = (mutate, label) => {
    const report = JSON.parse(exactReport(gitFacts).toString("utf8"));
    mutate(report.releasePreflight.packedUserProof);
    report.packedProductProofComplete = true;
    const verification = readVerificationEvidence(
      Buffer.from(JSON.stringify(report)),
      gitFacts,
    );
    assert.equal(verification.packedCandidateProofComplete, false, label);
    assert.equal(verification.bindingStatus, "verification_package_candidate_unproven", label);
    assert.equal(verification.exact, false, label);
  };

  reject((proof) => {
    proof.currentPackage = {
      status: "passed",
      installedCliEntrypoints: true,
      packageSha256: "a".repeat(64),
      modes: [
        { mode: "install", status: "passed" },
        { mode: "update", status: "passed" },
        { mode: "update", status: "passed" },
      ],
    };
  }, "minimal legacy proof");
  reject((proof) => {
    const portable = proof.currentPackage.portableRuntime;
    portable.mcpTransport = portable.populatedMcpTransport;
    delete portable.populatedMcpTransport;
  }, "legacy mcpTransport name");
  reject((proof) => {
    for (const transport of [
      proof.currentPackage.portableRuntime.populatedMcpTransport,
      proof.currentPackage.portableRuntime.emptyMcpTransport,
    ]) {
      delete transport.missingCount;
      delete transport.executionAuthority;
      delete transport.observedInCurrentRun;
      delete transport.currentHostAdapter;
    }
  }, "count-only proof");
  reject((proof) => {
    delete proof.currentPackage.portableRuntime.globalUpdate;
  }, "cached report missing portable runtime global update proof");
  reject((proof) => {
    proof.currentPackage.portableRuntime.globalUpdate.diagnostics.stdout =
      "raw packed command output";
  }, "cached report retaining raw portable runtime update output");
  reject((proof) => {
    delete proof.currentPackage.portableRuntime.emptyMcpTransport.missingCount;
  }, "missing exact partition fact");
  reject((proof) => {
    delete proof.currentPackage.targets;
  }, "missing current package targets");
  reject((proof) => {
    delete proof.currentPackage.packedUninstall;
  }, "cached report missing packed uninstall proof");
  reject((proof) => {
    delete proof.currentPackage.packedUninstall.publicCliAfterFailedUninstall;
  }, "cached report missing installed CLI recovery proof");
  reject((proof) => {
    proof.currentPackage.packedUninstall.publicCliAfterFailedUninstall.entrypoint = "help";
  }, "cached report malformed installed CLI recovery proof");
  reject((proof) => {
    proof.currentPackage.projectPackage.targets = [CANONICAL_PACKED_TARGETS[0]];
  }, "one-target project proof");
  reject((proof) => {
    proof.currentPackage.portableRuntime.populatedMcpTransport.platformCount = 1;
    proof.currentPackage.portableRuntime.emptyMcpTransport.platformCount = 1;
  }, "one-platform MCP proof");
});

test("published-bound requires exact clean verification and the uploaded local package", () => {
  const gitFacts = {
    remoteMainRelation: "exact",
    packageName: "meta-kim",
    packageVersion: "9.9.9",
  };
  const githubFacts = {
    draft: false,
    prerelease: false,
    publishedAt: "2026-01-01T00:00:00.000Z",
    asset: { sha256: "a".repeat(64) },
  };
  const verification = { exact: true, verifiedPackageSha256: "a".repeat(64) };
  const localPackage = {
    sha256: "a".repeat(64),
    packageName: "meta-kim",
    packageVersion: "9.9.9",
    packageJsonSha256: "b".repeat(64),
  };
  gitFacts.tagPackageJsonSha256 = "b".repeat(64);
  assert.deepEqual(
    evaluateReleaseBinding({ gitFacts, githubFacts, verification, localPackage }).status,
    "published_bound",
  );
  const missingPackage = evaluateReleaseBinding({
    gitFacts,
    githubFacts,
    verification,
  });
  assert.equal(missingPackage.status, "failed");
  assert.ok(
    missingPackage.failureReasons.includes("local_package_evidence_missing_for_exact_binding"),
  );
  const historical = evaluateReleaseBinding({
    gitFacts,
    githubFacts,
    verification: { exact: false },
  });
  assert.equal(historical.status, "published_artifacts_bound_verification_unbound");
  assert.equal(historical.promotionEligible, false);
  const alteredManifest = evaluateReleaseBinding({
    gitFacts,
    githubFacts,
    verification,
    localPackage: { ...localPackage, packageJsonSha256: "c".repeat(64) },
  });
  assert.equal(alteredManifest.status, "failed");
  assert.ok(alteredManifest.failureReasons.includes("local_package_manifest_mismatch"));
  const alteredPackageBytes = evaluateReleaseBinding({
    gitFacts,
    githubFacts: { ...githubFacts, asset: { sha256: "c".repeat(64) } },
    verification,
    localPackage: { ...localPackage, sha256: "c".repeat(64) },
  });
  assert.equal(alteredPackageBytes.status, "failed");
  assert.ok(
    alteredPackageBytes.failureReasons.includes("verified_package_candidate_mismatch"),
  );
});

test("changed non-manifest package bytes cannot replace the clean verified candidate", () => {
  const manifest = { name: "meta-kim", version: "9.9.9" };
  const verifiedTgz = minimalTgz(manifest, [{ path: "bin/meta-kim.mjs", body: "verified\n" }]);
  const replacedTgz = minimalTgz(manifest, [{ path: "bin/meta-kim.mjs", body: "tampered\n" }]);
  const replacedSha = sha256(replacedTgz);
  const packageJsonSha = readPackageManifestFromTgz(replacedTgz).sha256;
  const result = evaluateReleaseBinding({
    gitFacts: {
      remoteMainRelation: "exact",
      packageName: "meta-kim",
      packageVersion: "9.9.9",
      tagPackageJsonSha256: packageJsonSha,
    },
    githubFacts: {
      draft: false,
      prerelease: false,
      publishedAt: "2026-01-01T00:00:00.000Z",
      asset: { sha256: replacedSha },
    },
    verification: { exact: true, verifiedPackageSha256: sha256(verifiedTgz) },
    localPackage: {
      sha256: replacedSha,
      packageName: "meta-kim",
      packageVersion: "9.9.9",
      packageJsonSha256: packageJsonSha,
    },
  });
  assert.equal(result.status, "failed");
  assert.ok(result.failureReasons.includes("verified_package_candidate_mismatch"));
});

test("attempt journal is immutable, chained, and failure preserves latest published-bound", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-journal-"));
  try {
    const first = writeReleaseBindingAttempt(root, {
      schemaVersion: "meta-kim-release-binding-audit-v1",
      attemptId: "attempt-one",
      status: "published_bound",
      promotionEligible: true,
    });
    const second = writeReleaseBindingAttempt(root, {
      schemaVersion: "meta-kim-release-binding-audit-v1",
      attemptId: "attempt-two",
      status: "failed",
      promotionEligible: false,
    });
    assert.equal(second.record.previousRecordHash, first.record.recordHash);
    assert.equal(
      first.record.recordHash,
      sha256(canonicalJson(Object.fromEntries(
        Object.entries(first.record).filter(([key]) => key !== "recordHash"),
      ))),
    );
    assert.ok(readFileSync(first.recordPath, "utf8").includes("attempt-one"));
    assert.ok(readFileSync(second.recordPath, "utf8").includes("attempt-two"));
    const publishedPointer = JSON.parse(
      readFileSync(path.join(root, "latest-published-bound.json"), "utf8"),
    );
    assert.equal(publishedPointer.attemptId, "attempt-one");
    const latestAttempt = JSON.parse(readFileSync(path.join(root, "latest-attempt.json"), "utf8"));
    assert.equal(latestAttempt.attemptId, "attempt-two");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attempt journal reports valid orphan attempts without deleting immutable evidence", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-orphans-"));
  try {
    const first = writeReleaseBindingAttempt(root, attemptedRecordInput("reachable"));
    const orphanWithoutHash = {
      ...attemptedRecordInput("orphaned"),
      previousRecordHash: null,
    };
    const orphan = {
      ...orphanWithoutHash,
      recordHash: sha256(canonicalJson(orphanWithoutHash)),
    };
    writeFileSync(
      path.join(root, "attempts", "orphaned.json"),
      `${JSON.stringify(orphan, null, 2)}\n`,
    );

    const summary = summarizeReleaseBindingAttempts(root);
    assert.equal(summary.totalValidAttempts, 2);
    assert.deepEqual(summary.reachableAttemptIds, [first.record.attemptId]);
    assert.deepEqual(summary.orphanedAttemptIds, ["orphaned"]);
    assert.equal(existsSync(path.join(root, "attempts", "orphaned.json")), true);

    writeReleaseBindingAttempt(root, attemptedRecordInput("next"));
    const persisted = JSON.parse(readFileSync(path.join(root, "attempt-summary.json"), "utf8"));
    assert.deepEqual(persisted.orphanedAttemptIds, ["orphaned"]);
    assert.equal(persisted.advisoryOnly, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release state declares crash recovery separately from power-loss durability", () => {
  assert.equal(RELEASE_STATE_DURABILITY.crashRecovery, "hash_bound_atomic_replace");
  assert.equal(RELEASE_STATE_DURABILITY.fileDataFlush, "fsync_before_publish");
  assert.equal(
    RELEASE_STATE_DURABILITY.parentDirectoryFlush,
    process.platform === "win32"
      ? "unsupported_by_node_on_windows"
      : "best_effort_fsync_when_filesystem_supports_directory_handles",
  );
  assert.equal(RELEASE_STATE_DURABILITY.universalPowerLossDurability, false);
});

test("user-visible release errors redact unrelated absolute paths", () => {
  const windows = sanitizeUserVisibleText("failed at Z:\\private\\release\\token.txt");
  const posix = sanitizeUserVisibleText("failed at /srv/private/release/token.txt");
  assert.doesNotMatch(windows, /Z:\\private/u);
  assert.doesNotMatch(posix, /\/srv\/private/u);
  assert.match(windows, /<path>/u);
  assert.match(posix, /<path>/u);
});

test("journal recovers a dead-owner lock but rejects a live owner and tampered chain head", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-lock-"));
  try {
    writeFileSync(
      path.join(root, "audit.lock"),
      JSON.stringify({ pid: 2_147_483_647, token: "dead", createdAt: "2020-01-01T00:00:00Z" }),
    );
    const recovered = writeReleaseBindingAttempt(root, {
      schemaVersion: "meta-kim-release-binding-audit-v1",
      attemptId: "recovered",
      status: "failed",
      promotionEligible: false,
    });
    assert.equal(recovered.record.attemptId, "recovered");
    assert.equal(readdirSync(path.join(root, "stale-locks")).length, 1);

    writeFileSync(
      path.join(root, "audit.lock"),
      JSON.stringify({ pid: process.pid, token: "live", createdAt: new Date().toISOString() }),
    );
    assert.throws(
      () => writeReleaseBindingAttempt(root, {
        schemaVersion: "meta-kim-release-binding-audit-v1",
        attemptId: "must-not-write",
        status: "failed",
        promotionEligible: false,
      }),
      (error) => error.code === "audit_busy",
    );
    rmSync(path.join(root, "audit.lock"), { force: true });

    const record = JSON.parse(readFileSync(recovered.recordPath, "utf8"));
    record.status = "published_bound";
    writeFileSync(recovered.recordPath, `${JSON.stringify(record, null, 2)}\n`);
    assert.throws(
      () => writeReleaseBindingAttempt(root, {
        schemaVersion: "meta-kim-release-binding-audit-v1",
        attemptId: "after-tamper",
        status: "failed",
        promotionEligible: false,
      }),
      (error) => error.code === "audit_chain_head_invalid",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal recovers a reused PID when the recorded process-start identity differs", (t) => {
  const currentIdentity = getProcessStartIdentity(process.pid);
  if (!currentIdentity) {
    t.skip("host cannot reliably expose process start identity");
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-pid-reuse-"));
  try {
    writeFileSync(
      path.join(root, "audit.lock"),
      JSON.stringify({
        pid: process.pid,
        processStartIdentity: `${currentIdentity}-reused`,
        token: "reused",
        createdAt: "2020-01-01T00:00:00Z",
      }),
    );
    const recovered = writeReleaseBindingAttempt(root, attemptedRecordInput("after-pid-reuse"));
    assert.equal(recovered.record.attemptId, "after-pid-reuse");
    assert.equal(readdirSync(path.join(root, "stale-locks")).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remote annotated-tag identity must match the local tag object and peeled commit", async () => {
  const root = createReleaseRepo();
  try {
    const gitFacts = collectGitReleaseFacts(root, "v9.9.9");
    const tgz = minimalTgz({ name: "meta-kim", version: "9.9.9" });
    const payload = githubPayload(gitFacts, sha256(tgz), tgz.length);
    const fetchImpl = async (url) => {
      let responsePayload = payload;
      if (String(url).includes("/git/ref/tags/")) {
        responsePayload = { object: { type: "tag", sha: "f".repeat(40) } };
      }
      return new Response(JSON.stringify(responsePayload), { status: 200 });
    };
    await assert.rejects(
      () => fetchGitHubReleaseFacts(gitFacts, { fetchImpl }),
      (error) => error.code === "remote_tag_object_mismatch",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release audit defaults state to the caller repository and keeps timeout budgets distinct", async () => {
  const root = createReleaseRepo();
  try {
    const gitFacts = collectGitReleaseFacts(root, "v9.9.9");
    assert.equal(
      defaultReleaseAuditOutputDir(root),
      path.join(root, ".meta-kim", "state", "default", "release-binding-audit"),
    );
    const tgz = minimalTgz({ name: "meta-kim", version: "9.9.9" });
    const requests = [];
    const payload = githubPayload(gitFacts, sha256(tgz), tgz.length);
    const networkClient = {
      request: async (url, options) => {
        requests.push({ url: String(url), timeoutMs: options.timeoutMs });
        if (String(url).includes("/git/ref/tags/")) {
          return new Response(JSON.stringify({ object: { type: "tag", sha: gitFacts.tagObjectSha } }), { status: 200 });
        }
        if (String(url).includes("/git/tags/")) {
          return new Response(JSON.stringify({ object: { type: "commit", sha: gitFacts.peeledCommitSha } }), { status: 200 });
        }
        if (String(url) === "https://github.com/example/meta-kim/releases/download/package.tgz") {
          return new Response(tgz, {
            status: 200,
            headers: { "content-length": String(tgz.length) },
          });
        }
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    };
    const facts = await fetchGitHubReleaseFacts(gitFacts, {
      networkClient,
      metadataTimeoutMs: 111,
      assetTimeoutMs: 222,
      downloadAsset: true,
    });
    assert.equal(facts.asset.sha256, sha256(tgz));
    assert.deepEqual(requests.map(({ timeoutMs }) => timeoutMs), [111, 111, 111, 222]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release audit downloads and verifies the GitHub asset only with explicit opt-in", async () => {
  const root = createReleaseRepo();
  try {
    const gitFacts = collectGitReleaseFacts(root, "v9.9.9");
    const tgz = minimalTgz({ name: "meta-kim", version: "9.9.9" });
    const payload = githubPayload(gitFacts, sha256(tgz), tgz.length);
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(String(url));
      if (String(url).includes("/git/ref/tags/")) {
        return new Response(JSON.stringify({ object: { type: "tag", sha: gitFacts.tagObjectSha } }));
      }
      if (String(url).includes("/git/tags/")) {
        return new Response(JSON.stringify({ object: { type: "commit", sha: gitFacts.peeledCommitSha } }));
      }
      if (String(url).includes("/download/")) {
        return new Response(tgz, { headers: { "content-length": String(tgz.length) } });
      }
      return new Response(JSON.stringify(payload));
    };

    const metadataOnly = await runReleaseBindingAudit({
      repoRoot: root,
      tagName: "v9.9.9",
      historicalReportUnavailable: true,
      fetchImpl,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(requests.some((url) => url.includes("/download/")), false);
    assert.equal(
      metadataOnly.record.evidence.packageAsset.assetDownloadVerification.status,
      "not_requested",
    );

    requests.length = 0;
    const downloaded = await runReleaseBindingAudit({
      repoRoot: root,
      tagName: "v9.9.9",
      historicalReportUnavailable: true,
      fetchImpl,
      verifyAssetDownload: true,
      now: new Date("2026-01-01T00:01:00.000Z"),
    });
    assert.equal(requests.filter((url) => url.includes("/download/")).length, 1);
    assert.deepEqual(downloaded.record.evidence.packageAsset.assetDownloadVerification, {
      status: "passed",
      size: tgz.length,
      sha256: sha256(tgz),
    });
    assert.equal(downloaded.record.status, metadataOnly.record.status);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release audit keeps a failed immutable attempt in the caller repository state", async () => {
  const root = createReleaseRepo();
  try {
    const written = await runReleaseBindingAudit({
      repoRoot: root,
      tagName: "v9.9.8",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert.equal(written.record.status, "failed");
    assert.equal(
      written.recordPath.startsWith(defaultReleaseAuditOutputDir(root)),
      true,
    );
    assert.equal(existsSync(path.join(defaultReleaseAuditOutputDir(root), "latest-attempt.json")), true);
    assert.equal(existsSync(path.join(defaultReleaseAuditOutputDir(root), "attempts", `${written.record.attemptId}.json`)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release asset digest binding rejects a precise remote size mismatch", async () => {
  const root = createReleaseRepo();
  try {
    const gitFacts = collectGitReleaseFacts(root, "v9.9.9");
    const tgz = minimalTgz({ name: "meta-kim", version: "9.9.9" });
    const payload = githubPayload(gitFacts, sha256(tgz), tgz.length + 1);
    const networkClient = {
      request: async (url) => {
        if (String(url).includes("/git/ref/tags/")) {
          return new Response(JSON.stringify({ object: { type: "tag", sha: gitFacts.tagObjectSha } }), { status: 200 });
        }
        if (String(url).includes("/git/tags/")) {
          return new Response(JSON.stringify({ object: { type: "commit", sha: gitFacts.peeledCommitSha } }), { status: 200 });
        }
        if (String(url).includes("/download/")) return new Response(tgz, { status: 200 });
        return new Response(JSON.stringify(payload), { status: 200 });
      },
    };
    await assert.rejects(
      () => fetchGitHubReleaseFacts(gitFacts, { networkClient, downloadAsset: true }),
      (error) => error.code === "release_package_size_mismatch",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("output containment rejects a repository link that resolves outside before writing", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-output-root-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-output-outside-"));
  const link = path.join(root, "linked-output");
  try {
    if (!linkDirectoryOrSkip(t, outside, link)) return;
    const escaped = path.join(link, "audit");
    assert.throws(
      () => requireContainedOutput(root, escaped),
      (error) => error.code === "output_outside_repo",
    );
    assert.equal(
      (() => {
        try {
          readFileSync(path.join(outside, "audit", "latest-attempt.json"));
          return true;
        } catch {
          return false;
        }
      })(),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("release audit CLI rejects output-dir state redirection before any audit write", () => {
  const root = createReleaseRepo();
  try {
    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/audit-release-binding.mjs"), "--tag", "v9.9.9", "--output-dir", ".alternate-audit"],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, META_KIM_CALLER_CWD: root },
      },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--output-dir is not supported/u);
    assert.equal(existsSync(path.join(root, ".alternate-audit")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release audit API rejects output-dir state redirection before recording an attempt", async () => {
  const root = createReleaseRepo();
  const alternate = path.join(root, ".alternate-audit");
  try {
    await assert.rejects(
      () => runReleaseBindingAudit({
        repoRoot: root,
        tagName: "v9.9.9",
        outputDir: alternate,
      }),
      (error) => error.code === "output_dir_forbidden",
    );
    assert.equal(existsSync(alternate), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release attempt rejects an output directory link before external bytes change", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-output-link-root-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-output-link-outside-"));
  const outputLink = path.join(root, "audit-output");
  try {
    writeFileSync(path.join(outside, "sentinel.txt"), "outside bytes\n");
    if (!linkDirectoryOrSkip(t, outside, outputLink)) return;
    assert.throws(
      () => writeReleaseBindingAttempt(outputLink, attemptedRecordInput("must-not-write-output")),
      (error) => error.code === "output_outside_repo",
    );
    assertNoAuditBytesChangedOutside(outside);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("release attempt rejects a linked attempts directory before lock or record writes", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-attempts-root-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-attempts-outside-"));
  try {
    writeFileSync(path.join(outside, "sentinel.txt"), "outside bytes\n");
    if (!linkDirectoryOrSkip(t, outside, path.join(root, "attempts"))) return;
    assert.throws(
      () => writeReleaseBindingAttempt(root, attemptedRecordInput("must-not-write-attempts")),
      (error) => error.code === "output_outside_repo",
    );
    assertNoAuditBytesChangedOutside(outside);
    assert.equal(existsSync(path.join(root, "audit.lock")), false);
    assert.equal(existsSync(path.join(root, "latest-attempt.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("release attempt rejects a linked stale-locks directory before stale lock recovery writes outside", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-stale-root-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "meta-kim-release-stale-outside-"));
  try {
    writeFileSync(path.join(outside, "sentinel.txt"), "outside bytes\n");
    mkdirSync(path.join(root, "attempts"));
    if (!linkDirectoryOrSkip(t, outside, path.join(root, "stale-locks"))) return;
    writeFileSync(
      path.join(root, "audit.lock"),
      JSON.stringify({ pid: 2_147_483_647, token: "dead", createdAt: "2020-01-01T00:00:00Z" }),
    );
    assert.throws(
      () => writeReleaseBindingAttempt(root, attemptedRecordInput("must-not-write-stale-lock")),
      (error) => error.code === "output_outside_repo",
    );
    assertNoAuditBytesChangedOutside(outside);
    assert.equal(existsSync(path.join(root, "audit.lock")), true);
    assert.equal(existsSync(path.join(root, "latest-attempt.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("end-to-end audit binds annotated tag, clean report, GitHub asset digest, and local tgz", async () => {
  const root = createReleaseRepo();
  const outputDir = defaultReleaseAuditOutputDir(root);
  try {
    const gitFacts = collectGitReleaseFacts(root, "v9.9.9");
    assert.match(gitFacts.tagObjectSha, /^[a-f0-9]{40}$/u);
    assert.equal(gitFacts.remoteMainRelation, "exact");
    assert.equal(gitFacts.remoteMainEvidenceSource, "local_tracking_ref");
    const tgz = minimalTgz({ name: "meta-kim", version: "9.9.9" });
    const tgzPath = path.join(root, "meta-kim-9.9.9.tgz");
    const reportPath = path.join(root, "verification-report.json");
    writeFileSync(tgzPath, tgz);
    writeFileSync(reportPath, exactReport(gitFacts, { packageSha256: sha256(tgz) }));
    const payload = githubPayload(gitFacts, sha256(tgz), tgz.length);
    const fetchImpl = async (url) => {
      let responsePayload = payload;
      if (String(url).includes("/git/ref/tags/")) {
        responsePayload = { object: { type: "tag", sha: gitFacts.tagObjectSha } };
      } else if (String(url).includes("/git/tags/")) {
        responsePayload = { object: { type: "commit", sha: gitFacts.peeledCommitSha } };
      }
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const first = await runReleaseBindingAudit({
      repoRoot: root,
      tagName: "v9.9.9",
      verificationReportPath: reportPath,
      localPackagePath: tgzPath,
      outputDir,
      fetchImpl,
      now: new Date("2026-01-01T02:00:00.000Z"),
    });
    assert.equal(first.record.status, "published_bound");
    assert.equal(first.record.promotionEligible, true);
    assert.equal(first.record.evidence.verification.bindingStatus, "exact_commit_tree");

    const second = await runReleaseBindingAudit({
      repoRoot: root,
      tagName: "v9.9.9",
      verificationReportPath: reportPath,
      localPackagePath: tgzPath,
      outputDir,
      fetchImpl,
      now: new Date("2026-01-01T02:01:00.000Z"),
    });
    assert.equal(second.record.status, "published_bound");
    assert.equal(second.record.evidenceFingerprint, first.record.evidenceFingerprint);
    assert.equal(second.record.previousRecordHash, first.record.recordHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
