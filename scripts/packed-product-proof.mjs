// Pure release-proof predicate shared by verification and post-release audit.
// It intentionally performs no I/O and trusts no precomputed report boolean.
import { PACKED_USER_TARGETS } from "./packed-user-targets.mjs";
import { PROJECTION_PACKAGE_PURPOSE } from "./global-projection-package-store.mjs";

function hasExactPackedTargets(targets) {
  return Array.isArray(targets) &&
    targets.length === PACKED_USER_TARGETS.length &&
    targets.every((target, index) => target === PACKED_USER_TARGETS[index]);
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
    hasExactPackedTargets(currentPackage?.targets) &&
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
