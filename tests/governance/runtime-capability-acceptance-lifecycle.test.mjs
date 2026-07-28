import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeCapabilityAcceptanceAttempts, prepareRuntimeCapabilityAcceptanceStore, writeRuntimeCapabilityAcceptanceAttempt } from "../../scripts/runtime-capability-acceptance.mjs";
import { loadEffectiveRuntimeCapabilityClaims } from "../../scripts/effective-runtime-capability-claims.mjs";
import { evaluateRouteExecutionGate } from "../../scripts/runtime-execution-gate.mjs";
import { canonicalJson } from "../../scripts/audit-release-binding.mjs";
import { PACKED_USER_TARGETS } from "../../scripts/packed-user-targets.mjs";

const packageRoot = path.resolve(import.meta.dirname, "../..");

function projectFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-p130-"));
  const reports = path.join(root, ".meta-kim", "state", "default", "reports");
  mkdirSync(reports, { recursive: true });
  return { root, reports };
}

function writeLiveFuseReport(reports, runtime, observedAt = new Date().toISOString()) {
  const runtimeKey = runtime === "claude_code" ? "claude" : runtime;
  const file = path.join(reports, `${runtimeKey}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({
    timestamp: observedAt,
    mode: "live",
    primaryReleaseFuse: true,
    [runtimeKey]: {
      status: "passed",
      releaseFuseInvocationObserved: true,
      runtimeVersion: `${runtimeKey}-test-1.0.0`,
    },
    runtimeEvidencePacket: {
      schemaVersion: "runtime-evidence-v0.1",
      records: [{ runtime: runtimeKey, strictReleasePass: true, evidenceKind: "live" }],
    },
  }), "utf8");
  return file;
}

function attest(project, runtime, capability, reportPath, suffix) {
  return writeRuntimeCapabilityAcceptanceAttempt({
    projectRoot: project.root,
    profile: "default",
    reportPath,
    sourceKind: "runtime_live_fuse",
    runtime,
    capability,
    mode: "interactive_host",
    attemptId: `${runtime}-${capability.replaceAll(" ", "-")}-${suffix}`,
    correlationId: `${runtime}-${capability.replaceAll(" ", "-")}-correlation-${suffix}`,
  });
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
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
    platformCount: PACKED_USER_TARGETS.length,
    stubFree: true,
  });
  return {
    status: "passed",
    releaseGradeEligible: true,
    sourcePolicy: "npm_pack_installed_public_cli",
    currentPackage: {
      status: "passed",
      installedCliEntrypoints: true,
      packageSha256,
      targets: [...PACKED_USER_TARGETS],
      modes: [
        { mode: "install", status: "passed" },
        { mode: "update", status: "passed" },
        { mode: "update", status: "passed" },
      ],
      projectPackage: {
        status: "passed",
        targets: [...PACKED_USER_TARGETS],
        modes: [
          { mode: "install", status: "passed" },
          { mode: "update", status: "passed" },
        ],
      },
      runtimeSedimentation: { status: "passed" },
      portableRuntime: {
        status: "passed",
        agentProjection: { status: "passed" },
        ownershipManifest: { status: "passed", overlappingWriterPathCount: 0 },
        hookProjection: { status: "passed" },
        mcpRegistration: { status: "passed" },
        populatedMcpTransport: transport({ observationCount: 10, missingCount: 0, populated: true }),
        emptyMcpTransport: transport({ observationCount: 0, missingCount: 10, populated: false }),
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
      targets: [...PACKED_USER_TARGETS],
      completed: true,
      historicalRef: "v1.0.0",
      resolution: { ref: "v1.0.0", source: "highest_prior_stable_semver_tag" },
      beforeVersion: "1.0.0",
      afterVersion: "1.0.1",
      seedMethod: "historical_tarball_installed_cli",
      updateMethod: "current_tarball_installed_cli",
      checkMethod:
        "current_update_internal_global_check_plus_exact_artifact_manifest_validation",
    },
  };
}

function writePackedObservationReport(project, {
  reportedPackedProductProofComplete = true,
  mutateProof = () => {},
  suffix = "packed-observation",
} = {}) {
  const proof = completePackedUserProof("b".repeat(64));
  mutateProof(proof);
  const withoutHash = {
    schemaVersion: "meta-kim-verification-report-v2",
    attemptId: suffix,
    ok: true,
    releaseGrade: true,
    packedProductProofComplete: reportedPackedProductProofComplete,
    completedAt: "2026-07-28T12:00:00.000Z",
    runtimeVersions: { codex: "codex-test-1.0.0" },
    releasePreflight: {
      packedUserProof: proof,
      globalTargetProof: { status: "passed", targets: [...PACKED_USER_TARGETS] },
    },
  };
  const report = { ...withoutHash, attemptRecordHash: sha(JSON.stringify(withoutHash)) };
  const reportPath = path.join(project.reports, `${suffix}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  return reportPath;
}

function writeReleaseEvidence(project, { wrongAuditPackage = false } = {}) {
  const commit = "a".repeat(40);
  const packageDigest = "b".repeat(64);
  const verificationWithoutHash = {
    schemaVersion: "meta-kim-verification-report-v2",
    attemptId: "verification-attempt-1",
    ok: true,
    releaseGrade: true,
    packedProductProofComplete: true,
    releasePreflight: {
      sourceSnapshot: { end: { head: commit } },
      packedUserProof: completePackedUserProof(packageDigest),
      globalTargetProof: { status: "passed", targets: [...PACKED_USER_TARGETS] },
    },
  };
  const verification = { ...verificationWithoutHash, attemptRecordHash: sha(JSON.stringify(verificationWithoutHash)) };
  const verificationPath = path.join(project.reports, "verification.json");
  const verificationBytes = JSON.stringify(verification, null, 2);
  writeFileSync(verificationPath, verificationBytes, "utf8");
  const auditWithoutHash = {
    schemaVersion: "meta-kim-release-binding-audit-v1",
    attemptId: "release-audit-attempt-1",
    status: "published_bound",
    promotionEligible: true,
    evidence: {
      git: { peeledCommitSha: commit },
      packageAsset: { sha256: wrongAuditPackage ? "c".repeat(64) : packageDigest },
      verification: { sha256: sha(verificationBytes), exact: true },
    },
  };
  const audit = { ...auditWithoutHash, recordHash: sha(canonicalJson(auditWithoutHash)) };
  const auditPath = path.join(project.reports, "audit.json");
  writeFileSync(auditPath, JSON.stringify(audit, null, 2), "utf8");
  return { verificationPath, auditPath };
}

test("external packed observation reader recomputes complete target truth without granting authority", () => {
  const acceptedProject = projectFixture();
  const accepted = writeRuntimeCapabilityAcceptanceAttempt({
    projectRoot: acceptedProject.root,
    reportPath: writePackedObservationReport(acceptedProject, {
      reportedPackedProductProofComplete: false,
      suffix: "false-summary-complete-proof",
    }),
    sourceKind: "packed_update_global_readback",
    runtime: "codex",
    capability: "global install",
    mode: "global_install",
    attemptId: "external-packed-complete",
    correlationId: "external-packed-complete-correlation",
  });
  assert.equal(accepted.record.attestationAuthority, "external_reference");
  assert.equal(accepted.record.releaseGrade, false);

  for (const [label, mutateProof] of [
    ["missing-targets", (proof) => { delete proof.currentPackage.targets; }],
    ["one-target", (proof) => { proof.currentPackage.targets = [PACKED_USER_TARGETS[0]]; }],
  ]) {
    const rejectedProject = projectFixture();
    assert.throws(() => writeRuntimeCapabilityAcceptanceAttempt({
      projectRoot: rejectedProject.root,
      reportPath: writePackedObservationReport(rejectedProject, {
        mutateProof,
        suffix: label,
      }),
      sourceKind: "packed_update_global_readback",
      runtime: "codex",
      capability: "global install",
      mode: "global_install",
      attemptId: `external-packed-${label}`,
      correlationId: `external-packed-${label}-correlation`,
    }), /not release-grade and runtime-complete/u);
  }
});

test("no profile acceptance remains advisory while compatible product routes hand off to the host", () => {
  for (const runtime of ["claude_code", "codex"]) {
    const project = projectFixture();
    const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot: project.root });
    const gate = evaluateRouteExecutionGate({ runtime, taskShape: "product_build", effectiveMatrix: state.effectiveMatrix });
    assert.equal(gate.allowed, false, gate.blockers.join("\n"));
    assert.equal(gate.routeCompatible, true);
    assert.equal(gate.handoffStatus, "ready_for_host_handoff");
    assert.equal(gate.hostAction, "host_action_required");
    assert.equal(gate.executionAuthorized, false);
    assert.equal(gate.persistentAcceptanceAuthorizesExecution, false);
    assert.deepEqual(gate.requirements.map((entry) => entry.capability), ["agent", "subagent"]);
  }
});

test("fresh external reports remain advisory while compatible routes still hand off to the host", () => {
  const canonicalBefore = readFileSync(path.join(packageRoot, "config", "runtime-capability-matrix.json"));
  for (const runtime of ["claude_code", "codex"]) {
    const project = projectFixture();
    const report = writeLiveFuseReport(project.reports, runtime);
    attest(project, runtime, "agent", report, "agent");
    attest(project, runtime, "subagent", report, "subagent");
    const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot: project.root });
    const gate = evaluateRouteExecutionGate({ runtime, taskShape: "product_build", effectiveMatrix: state.effectiveMatrix });
    assert.equal(gate.allowed, false, gate.blockers.join("\n"));
    assert.equal(gate.routeCompatible, true);
    assert.equal(gate.handoffStatus, "ready_for_host_handoff");
    assert.equal(gate.hostAction, "host_action_required");
    assert.equal(gate.executionAuthorized, false);
    assert.equal(gate.persistentAcceptanceAuthorizesExecution, false);
    assert.equal(state.overlayStatus.applied.length, 0);
    assert.match(state.issues.join("\n"), /reference-only/u);
  }
  assert.deepEqual(readFileSync(path.join(packageRoot, "config", "runtime-capability-matrix.json")), canonicalBefore);
});

test("stale or tampered source evidence is rejected at effective-load time", () => {
  const project = projectFixture();
  const staleReport = writeLiveFuseReport(project.reports, "codex", "2020-01-01T00:00:00.000Z");
  attest(project, "codex", "agent", staleReport, "stale");
  let state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot: project.root });
  assert.equal(state.overlayStatus.applied.length, 0);
  assert.match(state.issues.join("\n"), /stale/u);

  const freshReport = writeLiveFuseReport(project.reports, "codex");
  attest(project, "codex", "subagent", freshReport, "tampered");
  writeFileSync(freshReport, "{}", "utf8");
  state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot: project.root });
  assert.match(state.issues.join("\n"), /SHA-256 mismatch/u);
});

test("deleting matrix requiredModes cannot bypass compatibility or host-handoff boundaries", () => {
  const project = projectFixture();
  const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot: project.root });
  for (const capability of state.effectiveMatrix.platforms.find((entry) => entry.platform === "codex").capabilities) {
    capability.requiredModes = [];
    for (const claim of Object.values(capability.claimsByMode)) claim.acceptanceRequirement = "not_required";
  }
  const compatible = evaluateRouteExecutionGate({ runtime: "codex", taskShape: "engineering_execution", effectiveMatrix: state.effectiveMatrix });
  assert.equal(compatible.allowed, false, compatible.blockers.join("\n"));
  assert.equal(compatible.handoffStatus, "ready_for_host_handoff");
  assert.equal(compatible.hostAction, "host_action_required");
  assert.equal(compatible.executionAuthorized, false);
  assert.equal(compatible.persistentAcceptanceAuthorizesExecution, false);
  assert.deepEqual(compatible.requirements.map((entry) => entry.capability), ["shell", "filesystem", "apply_patch / edit"]);

  state.effectiveMatrix.platforms
    .find((entry) => entry.platform === "codex")
    .capabilities.find((entry) => entry.capability === "shell")
    .claimsByMode.interactive_host.hostSupport = "unsupported";
  const unsupported = evaluateRouteExecutionGate({ runtime: "codex", taskShape: "engineering_execution", effectiveMatrix: state.effectiveMatrix });
  assert.equal(unsupported.allowed, false);
  assert.equal(unsupported.routeCompatible, false);
  assert.equal(unsupported.handoffStatus, "blocked");
  assert.equal(unsupported.hostAction, "none");
  assert.match(unsupported.blockers.join("\n"), /unsupported/u);
});

test("Cursor product execution remains blocked even if an effective matrix is forged", () => {
  const project = projectFixture();
  const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot: project.root });
  for (const capability of ["agent", "subagent"]) {
    const claim = state.effectiveMatrix.platforms.find((entry) => entry.platform === "cursor").capabilities.find((entry) => entry.capability === capability).claimsByMode.interactive_host;
    Object.assign(claim, { hostSupport: "native", metaKimIntegration: "projected", acceptanceRequirement: "required", acceptanceState: "accepted", routeEligibility: "executable" });
  }
  const gate = evaluateRouteExecutionGate({ runtime: "cursor", taskShape: "product_build", effectiveMatrix: state.effectiveMatrix });
  assert.equal(gate.allowed, false);
  assert.match(gate.blockers.join("\n"), /Cursor/u);
});

test("duplicate correlation IDs and non-release evidence cannot be promoted", () => {
  const project = projectFixture();
  const report = writeLiveFuseReport(project.reports, "codex");
  const first = attest(project, "codex", "agent", report, "duplicate");
  assert.throws(() => writeRuntimeCapabilityAcceptanceAttempt({
    projectRoot: project.root,
    reportPath: report,
    sourceKind: "runtime_live_fuse",
    runtime: "codex",
    capability: "subagent",
    attemptId: "unique-second-attempt",
    correlationId: first.record.correlationId,
  }), /correlationId already exists/u);
  const releaseState = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot: project.root, releaseResolution: true });
  assert.equal(releaseState.overlayStatus.applied.length, 0);
  assert.match(releaseState.issues.join("\n"), /release-grade acceptance/u);
});

test("acceptance store rejects a junction root", (t) => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "meta-kim-p130-junction-project-"));
  const external = mkdtempSync(path.join(tmpdir(), "meta-kim-p130-junction-target-"));
  const profileRoot = path.join(projectRoot, ".meta-kim", "state", "default");
  mkdirSync(profileRoot, { recursive: true });
  try {
    symlinkSync(external, path.join(profileRoot, "runtime-capability-acceptance"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`junction creation unavailable: ${error.message}`);
    return;
  }
  const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot });
  assert.equal(state.overlayStatus.state, "invalid");
  assert.match(state.issues.join("\n"), /plain directory|symlink|junction|reparse/u);
});

test("release resolution requires an exact audit-to-verification binding", () => {
  const project = projectFixture();
  const liveReport = writeLiveFuseReport(project.reports, "codex");
  const evidence = writeReleaseEvidence(project);
  writeRuntimeCapabilityAcceptanceAttempt({
    projectRoot: project.root,
    reportPath: liveReport,
    sourceKind: "runtime_live_fuse",
    runtime: "codex",
    capability: "agent",
    attemptId: "release-grade-agent",
    correlationId: "release-grade-agent-correlation",
    releaseGrade: true,
    releaseVerificationPath: evidence.verificationPath,
    releaseAuditPath: evidence.auditPath,
  });
  const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot: project.root, releaseResolution: true });
  assert.equal(state.overlayStatus.applied.length, 0);
  assert.match(state.issues.join("\n"), /reference-only/u);

  const invalidProject = projectFixture();
  const invalidLive = writeLiveFuseReport(invalidProject.reports, "codex");
  const invalidEvidence = writeReleaseEvidence(invalidProject, { wrongAuditPackage: true });
  assert.throws(() => writeRuntimeCapabilityAcceptanceAttempt({
    projectRoot: invalidProject.root,
    reportPath: invalidLive,
    sourceKind: "runtime_live_fuse",
    runtime: "codex",
    capability: "agent",
    releaseGrade: true,
    releaseVerificationPath: invalidEvidence.verificationPath,
    releaseAuditPath: invalidEvidence.auditPath,
  }), /does not exactly bind/u);
});

test("stale locks recover safely while live locks remain owned", () => {
  const staleProject = projectFixture();
  const stalePaths = prepareRuntimeCapabilityAcceptanceStore({ projectRoot: staleProject.root });
  writeFileSync(path.join(stalePaths.root, "write.lock"), JSON.stringify({ token: "stale", pid: 99999999, createdAt: "2020-01-01T00:00:00.000Z" }), "utf8");
  const staleReport = writeLiveFuseReport(staleProject.reports, "codex");
  assert.doesNotThrow(() => attest(staleProject, "codex", "agent", staleReport, "stale-lock"));

  const liveProject = projectFixture();
  const livePaths = prepareRuntimeCapabilityAcceptanceStore({ projectRoot: liveProject.root });
  writeFileSync(path.join(livePaths.root, "write.lock"), JSON.stringify({ token: "live", pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
  const liveReport = writeLiveFuseReport(liveProject.reports, "codex");
  assert.throws(() => attest(liveProject, "codex", "agent", liveReport, "live-lock"), /locked by another writer/u);
  assert.equal(JSON.parse(readFileSync(path.join(livePaths.root, "write.lock"), "utf8")).token, "live");
});

test("truncated attempts are quarantined and a broken index remains recoverable", () => {
  const project = projectFixture();
  const paths = prepareRuntimeCapabilityAcceptanceStore({ projectRoot: project.root });
  writeFileSync(path.join(paths.attemptsDir, "truncated.json"), "{\"partial\":", "utf8");
  writeFileSync(paths.indexPath, "{\"broken\":", "utf8");
  const store = loadRuntimeCapabilityAcceptanceAttempts({ projectRoot: project.root });
  assert.equal(store.attempts.length, 0);
  assert.equal(store.index, null);
  assert.ok(store.indexIssues.length > 0);
  const quarantined = readdirSync(path.join(paths.root, "quarantine"));
  assert.ok(quarantined.some((entry) => entry.startsWith("truncated.json")));
  assert.equal(existsSync(path.join(paths.attemptsDir, "truncated.json")), false);
});
