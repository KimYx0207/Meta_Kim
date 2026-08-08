// Pure release-proof predicate shared by verification and post-release audit.
// It intentionally performs no I/O and trusts no precomputed report boolean.
import { PACKED_USER_TARGETS } from "./packed-user-targets.mjs";
import { PROJECTION_PACKAGE_PURPOSE } from "./global-projection-package-store.mjs";

function hasExactPackedTargets(targets) {
  return Array.isArray(targets) &&
    targets.length === PACKED_USER_TARGETS.length &&
    targets.every((target, index) => target === PACKED_USER_TARGETS[index]);
}

const PACKED_UNINSTALL_DESCRIPTOR_IDS = Object.freeze({
  win32: Object.freeze([
    "windows-powershell",
    "windows-command",
    "windows-startup",
  ]),
  darwin: Object.freeze(["macos-command", "macos-launch-agent"]),
  linux: Object.freeze(["linux-command", "linux-autostart"]),
});
const PACKED_UNINSTALL_PUBLIC_CLI_RECOVERY_KEYS = Object.freeze([
  "commandSource",
  "entrypoint",
  "exitCode",
  "status",
  "withinIsolatedPrefix",
]);

function hasExactOrderedValues(values, expected) {
  return Array.isArray(values) &&
    values.length === expected.length &&
    values.every((value, index) => value === expected[index]);
}

function packedUninstallProofComplete(currentPackage) {
  const packedUninstall = currentPackage?.packedUninstall;
  const expectedDescriptorIds =
    PACKED_UNINSTALL_DESCRIPTOR_IDS[packedUninstall?.platform];
  if (!expectedDescriptorIds) return false;

  const normalManifestUninstall = packedUninstall.normalManifestUninstall;
  const privateManifestBypass = packedUninstall.privateManifestBypass;
  const publicCliAfterFailedUninstall =
    packedUninstall.publicCliAfterFailedUninstall;
  const windowsRecovery = packedUninstall.windowsRecovery;
  const platformRecoveryComplete = packedUninstall.platform === "win32"
    ? windowsRecovery?.status === "passed" &&
      windowsRecovery?.fixture === "shared_renderer_exact_orphan_startup_vbs" &&
      windowsRecovery?.missingCommandTarget === true &&
      windowsRecovery?.dryRunPreserved === true &&
      windowsRecovery?.unprovenBoundaryReported === true &&
      windowsRecovery?.liveRunRemoved === true
    : windowsRecovery?.status === "not_applicable" &&
      windowsRecovery?.reason === "windows_exact_signature_recovery_only";

  return (
    packedUninstall.status === "passed" &&
    packedUninstall.evidenceTier === "packed_isolated_installed_public_cli" &&
    typeof packedUninstall.packageSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(packedUninstall.packageSha256) &&
    packedUninstall.packageSha256 === currentPackage?.packageSha256 &&
    packedUninstall.isolatedHomeAndPrefix === true &&
    normalManifestUninstall?.status === "passed" &&
    normalManifestUninstall?.evidenceScope ===
      "synthetic_manifest_fixture_consumed_by_packed_public_cli" &&
    hasExactOrderedValues(
      normalManifestUninstall?.descriptorIds,
      expectedDescriptorIds,
    ) &&
    normalManifestUninstall?.syntheticFixtureExactOwnershipAndIntegrityRecorded === true &&
    normalManifestUninstall?.allChainFilesRemoved === true &&
    privateManifestBypass?.status === "passed" &&
    privateManifestBypass?.option === "--no-manifest" &&
    privateManifestBypass?.exitCode === 2 &&
    privateManifestBypass?.rejectedByPublicCli === true &&
    hasExactOrderedValues(
      Object.keys(publicCliAfterFailedUninstall ?? {}).sort(),
      PACKED_UNINSTALL_PUBLIC_CLI_RECOVERY_KEYS,
    ) &&
    publicCliAfterFailedUninstall?.status === "passed" &&
    publicCliAfterFailedUninstall?.commandSource ===
      "isolated_installed_public_cli" &&
    publicCliAfterFailedUninstall?.withinIsolatedPrefix === true &&
    publicCliAfterFailedUninstall?.entrypoint === "--help" &&
    publicCliAfterFailedUninstall?.exitCode === 0 &&
    platformRecoveryComplete
  );
}

function automaticOrphanBootRepairProofComplete(currentPackage) {
  const proof = currentPackage?.automaticOrphanBootRepair;
  const platformName = currentPackage?.packedUninstall?.platform;
  if (platformName === "win32") {
    return proof?.status === "passed" &&
      proof?.evidenceTier === "packed_isolated_installed_public_cli" &&
      proof?.fixture === "exact_startup_vbs_with_missing_command_target" &&
      proof?.removedBeforeDependencyWork === true;
  }
  return proof?.status === "not_applicable" &&
    proof?.reason === "windows_startup_vbs_only";
}

export function packedProductProofComplete(packedUserProof) {
  const currentPackage = packedUserProof?.currentPackage;
  const portableRuntime = currentPackage?.portableRuntime;
  const transientPackageRoot = currentPackage?.transientPackageRoot;
  const historicalUpdate = packedUserProof?.historicalUpdate;
  const currentModes = currentPackage?.modes ?? [];
  const projectModes = currentPackage?.projectPackage?.modes ?? [];
  return (
    packedUserProof?.status === "passed" &&
    packedUserProof?.releaseGradeEligible === true &&
    packedUserProof?.sourcePolicy === "npm_pack_installed_public_cli" &&
    packedUserProof?.currentVersionTagAbsent === true &&
    currentPackage?.status === "passed" &&
    currentPackage?.installedCliEntrypoints === true &&
    automaticOrphanBootRepairProofComplete(currentPackage) &&
    hasExactPackedTargets(currentPackage?.targets) &&
    packedUninstallProofComplete(currentPackage) &&
    JSON.stringify(currentModes.map(({ mode, status }) => ({ mode, status }))) ===
      JSON.stringify([
        { mode: "install", status: "passed" },
        { mode: "update", status: "passed" },
        { mode: "update", status: "passed" },
      ]) &&
    currentPackage?.projectPackage?.status === "passed" &&
    hasExactPackedTargets(currentPackage?.projectPackage?.targets) &&
    JSON.stringify(projectModes.map(({ mode, status }) => ({ mode, status }))) ===
      JSON.stringify([
        { mode: "install", status: "passed" },
        { mode: "update", status: "passed" },
      ]) &&
    currentPackage?.runtimeSedimentation?.status === "passed" &&
    transientPackageRoot?.status === "passed" &&
    transientPackageRoot?.publicCliApplied === true &&
    transientPackageRoot?.originDeletedBeforeCheck === true &&
    transientPackageRoot?.stablePublicCliCheck === true &&
    transientPackageRoot?.claudeCodexReadback === true &&
    transientPackageRoot?.forbiddenRootReferenceCount === 0 &&
    transientPackageRoot?.authorityReused === true &&
    transientPackageRoot?.authorityPurpose === PROJECTION_PACKAGE_PURPOSE.bundle &&
    typeof transientPackageRoot?.stableAuthorityDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(transientPackageRoot.stableAuthorityDigest) &&
    typeof transientPackageRoot?.stableAuthorityPath === "string" &&
    transientPackageRoot.stableAuthorityPath.length > 0 &&
    typeof transientPackageRoot?.stablePackageRoot === "string" &&
    transientPackageRoot.stablePackageRoot.length > 0 &&
    Number.isSafeInteger(transientPackageRoot?.referencedPathCount) &&
    transientPackageRoot.referencedPathCount > 0 &&
    Number.isSafeInteger(transientPackageRoot?.stableAuthorityReferenceCount) &&
    transientPackageRoot.stableAuthorityReferenceCount > 0 &&
    Number.isSafeInteger(transientPackageRoot?.declaredPackageRootCount) &&
    transientPackageRoot.declaredPackageRootCount > 0 &&
    transientPackageRoot?.allPersistentPackageReferencesBound === true &&
    transientPackageRoot?.allReferencedPathsExist === true &&
    transientPackageRoot?.manifestAuthorityBound === true &&
    Number.isSafeInteger(transientPackageRoot?.disposableOriginCount) &&
    transientPackageRoot.disposableOriginCount > 0 &&
    transientPackageRoot?.remainingDisposableOriginCount === 0 &&
    historicalUpdate?.status === "passed" &&
    hasExactPackedTargets(historicalUpdate?.targets) &&
    historicalUpdate?.completed === true &&
    historicalUpdate?.resolution?.ref === historicalUpdate?.historicalRef &&
    ["highest_prior_stable_semver_tag", "validated_env_override"].includes(
      historicalUpdate?.resolution?.source,
    ) &&
    typeof historicalUpdate?.beforeVersion === "string" &&
    typeof historicalUpdate?.afterVersion === "string" &&
    historicalUpdate.beforeVersion !== historicalUpdate.afterVersion &&
    historicalUpdate?.seedMethod === "historical_tarball_installed_cli" &&
    historicalUpdate?.updateMethod === "current_tarball_installed_cli" &&
    historicalUpdate?.checkMethod ===
      "current_update_internal_global_check_plus_exact_artifact_manifest_validation" &&
    portableRuntime?.status === "passed" &&
    portableRuntime.agentProjection?.status === "passed" &&
    portableRuntime.ownershipManifest?.status === "passed" &&
    portableRuntime.ownershipManifest?.overlappingWriterPathCount === 0 &&
    portableRuntime.hookProjection?.status === "passed" &&
    portableRuntime.mcpRegistration?.status === "passed" &&
    portableRuntime.populatedMcpTransport?.status === "passed" &&
    portableRuntime.populatedMcpTransport?.evidenceTier ===
      "packed_isolated_transport" &&
    portableRuntime.populatedMcpTransport?.liveHostInvocation === false &&
    portableRuntime.populatedMcpTransport?.semanticMatrixMatched === true &&
    portableRuntime.populatedMcpTransport?.staticEvidenceMatched === true &&
    portableRuntime.populatedMcpTransport?.projectOverlayObserved === true &&
    portableRuntime.populatedMcpTransport?.observationCount === 10 &&
    portableRuntime.populatedMcpTransport?.missingCount === 0 &&
    portableRuntime.populatedMcpTransport?.executionAuthority === false &&
    portableRuntime.populatedMcpTransport?.observedInCurrentRun === false &&
    portableRuntime.populatedMcpTransport?.currentHostAdapter ===
      "unavailable_over_mcp_resource_read" &&
    portableRuntime.populatedMcpTransport
      ?.externalOverlayStayedNonExecutable === true &&
    Number.isSafeInteger(portableRuntime.populatedMcpTransport?.platformCount) &&
    portableRuntime.populatedMcpTransport.platformCount ===
      PACKED_USER_TARGETS.length &&
    portableRuntime.populatedMcpTransport?.stubFree === true &&
    portableRuntime.emptyMcpTransport?.status === "passed" &&
    portableRuntime.emptyMcpTransport?.evidenceTier === "packed_isolated_transport" &&
    portableRuntime.emptyMcpTransport?.liveHostInvocation === false &&
    portableRuntime.emptyMcpTransport?.semanticMatrixMatched === true &&
    portableRuntime.emptyMcpTransport?.staticEvidenceMatched === true &&
    portableRuntime.emptyMcpTransport?.projectOverlayObserved === false &&
    portableRuntime.emptyMcpTransport?.observationCount === 0 &&
    portableRuntime.emptyMcpTransport?.missingCount === 10 &&
    portableRuntime.emptyMcpTransport?.executionAuthority === false &&
    portableRuntime.emptyMcpTransport?.observedInCurrentRun === false &&
    portableRuntime.emptyMcpTransport?.currentHostAdapter ===
      "unavailable_over_mcp_resource_read" &&
    portableRuntime.emptyMcpTransport?.externalOverlayStayedNonExecutable === true &&
    Number.isSafeInteger(portableRuntime.emptyMcpTransport?.platformCount) &&
    portableRuntime.emptyMcpTransport.platformCount ===
      PACKED_USER_TARGETS.length &&
    portableRuntime.emptyMcpTransport.platformCount ===
      portableRuntime.populatedMcpTransport.platformCount &&
    portableRuntime.emptyMcpTransport?.stubFree === true &&
    portableRuntime.advisorySnapshot?.evidenceClass ===
      "read_only_advisory_snapshot" &&
    portableRuntime.advisorySnapshot?.observedInCurrentRun === false &&
    portableRuntime.advisorySnapshot?.executionAuthority === false &&
    portableRuntime.advisorySnapshot?.count === 10 &&
    Array.isArray(portableRuntime.advisorySnapshot?.bindings) &&
    portableRuntime.advisorySnapshot.bindings.length === 10 &&
    portableRuntime.portability?.status === "passed" &&
    portableRuntime.portability?.packExtractionDeletedBeforeTransport === true &&
    portableRuntime.portability?.tarballDeletedBeforeInstalledChecks === true &&
    portableRuntime.portability?.candidateExtractionUnavailable === true &&
    portableRuntime.portability?.candidateTarballUnavailable === true &&
    portableRuntime.portability?.repoIndependentCwd === true &&
    portableRuntime.portability?.repoIndependentEnvironment === true &&
    portableRuntime.portability?.installedPackageChecksAfterCandidateRemoval === true
  );
}
