import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateLegacyCapabilitySummary,
  getRuntimeCapabilityRecord,
  resolveRuntimeCapabilityClaim,
} from "./runtime-capability-claims.mjs";
import { assertRuntimeCapabilityClaims } from "./runtime-capability-evidence.mjs";
import {
  loadRuntimeCapabilityAcceptanceAttempts,
  validateRuntimeCapabilityAcceptanceAttemptEvidence,
} from "./runtime-capability-acceptance.mjs";
import { resolveProjectRoot } from "../canonical/runtime-assets/shared/hooks/project-root.mjs";

const defaultPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OVERLAYABLE_INTEGRATION = new Set(["projected", "projected_unaccepted", "host_only"]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

export function loadEffectiveRuntimeCapabilityClaims({
  packageRoot = defaultPackageRoot,
  projectRoot,
  profile = process.env.META_KIM_PROFILE,
  now = new Date().toISOString(),
  releaseResolution = false,
  allowTestReceipts = false,
} = {}) {
  const matrix = readJson(path.join(packageRoot, "config", "runtime-capability-matrix.json"));
  const ledger = readJson(path.join(packageRoot, "config", "runtime-capability-evidence.json"));
  assertRuntimeCapabilityClaims(matrix, ledger, { now });
  const effectiveMatrix = clone(matrix);
  const issues = [];
  const explicitRoot = projectRoot ?? process.env.META_KIM_CALLER_CWD ?? null;
  const resolvedProjectRoot = resolveProjectRoot({ cwd: process.cwd(), explicitDeclarations: explicitRoot ? [explicitRoot] : [] });
  if (!resolvedProjectRoot) {
    return {
      baselineMatrix: matrix,
      staticLedger: ledger,
      effectiveMatrix,
      overlayStatus: { profile: profile ?? "default", applied: [], rejected: [], state: "unbound" },
      issues: ["No trusted explicit or marker-backed project root; profile overlay was not loaded."],
    };
  }
  let store;
  try {
    store = loadRuntimeCapabilityAcceptanceAttempts({ projectRoot: resolvedProjectRoot, profile });
  } catch (error) {
    return {
      baselineMatrix: matrix,
      staticLedger: ledger,
      effectiveMatrix,
      overlayStatus: { profile: profile ?? "default", applied: [], rejected: [], state: "invalid" },
      issues: [error.message],
    };
  }
  issues.push(...(store.indexIssues ?? []).map((issue) => `recoverable acceptance index cache: ${issue}`));
  const snapshotPath = path.join(store.paths.root, "advisory-snapshot.json");
  const snapshot = existsSync(snapshotPath) ? readJson(snapshotPath) : null;
  const portableSnapshotAttempts = new Set(snapshot?.schemaVersion === "meta-kim-runtime-advisory-snapshot-v1" ? (snapshot.bindings ?? []).map((entry) => entry.attemptId) : []);
  const candidates = new Map();
  for (const attempt of store.attempts) {
    const key = `${attempt.runtime}:${attempt.capability}:${attempt.mode}`;
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(attempt);
  }
  const applied = [];
  const rejected = [];
  const selected = [];
  for (const entries of candidates.values()) {
    const ordered = [...entries].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)) || right.attemptId.localeCompare(left.attemptId));
    let chosen = null;
    for (const attempt of ordered) {
      const evidence = validateRuntimeCapabilityAcceptanceAttemptEvidence(attempt, { profileRoot: store.paths.profileRoot, now, releaseResolution, portableAdvisorySnapshot: portableSnapshotAttempts.has(attempt.attemptId) });
      const reasons = [...evidence.issues];
      if (attempt.attestationAuthority !== "controlled_producer") reasons.push("external/imported reports are reference-only");
      if (attempt.testOnly === true && !allowTestReceipts) reasons.push("test-only producer receipt cannot authorize production execution");
      if (!releaseResolution && attempt.releaseGrade === true) reasons.push("release-grade clone is historical release evidence, not a current host observation");
      if (releaseResolution && attempt.releaseGrade !== true) reasons.push("release resolution requires a release-grade receipt");
      if (reasons.length === 0) { chosen = attempt; break; }
      rejected.push({ attemptId: attempt.attemptId, runtime: attempt.runtime, capability: attempt.capability, mode: attempt.mode, reasons });
      issues.push(...reasons.map((reason) => `${attempt.attemptId}: ${reason}`));
    }
    if (chosen) selected.push(chosen);
  }
  for (const attempt of selected) {
    const evidence = { issues: [] };
    const row = getRuntimeCapabilityRecord(effectiveMatrix, attempt.runtime, attempt.capability);
    const claim = row?.claimsByMode?.[attempt.mode];
    const rejectionReasons = [...evidence.issues];
    if (!row || !claim) rejectionReasons.push("acceptance target is absent from the canonical matrix");
    if (attempt.runtime === "cursor") rejectionReasons.push("Cursor product execution is blocked for P-130");
    if (claim && !["native", "partial"].includes(claim.hostSupport)) rejectionReasons.push("canonical host support is not overlayable");
    if (claim && !OVERLAYABLE_INTEGRATION.has(claim.metaKimIntegration)) rejectionReasons.push("canonical integration state is not overlayable");
    if (rejectionReasons.length > 0) {
      rejected.push({ attemptId: attempt.attemptId, runtime: attempt.runtime, capability: attempt.capability, mode: attempt.mode, reasons: rejectionReasons });
      issues.push(...rejectionReasons.map((reason) => `${attempt.attemptId}: ${reason}`));
      continue;
    }
    claim.hostConfidence = "observed_local";
    if (claim.metaKimIntegration === "projected_unaccepted") claim.metaKimIntegration = "projected";
    claim.acceptanceRequirement = "required";
    claim.acceptanceState = "observed_advisory";
    // Persisted acceptance remains advisory and must not mint execution authority,
    // but it also must not downgrade canonical host-handoff eligibility.
    claim.evidenceRefs = [...new Set([...(claim.evidenceRefs ?? []), `profile-attempt:${attempt.attemptId}`])];
    const aggregate = aggregateLegacyCapabilitySummary(row);
    row.support = aggregate.support;
    row.confidence = aggregate.confidence;
    row.hostConfidence = "observed_local";
    applied.push({
      attemptId: attempt.attemptId,
      runtime: attempt.runtime,
      capability: attempt.capability,
      mode: attempt.mode,
      observedAt: attempt.observedAt,
      releaseGrade: attempt.releaseGrade,
      evidenceClass: "advisory_persisted_observation",
      observedInCurrentRun: false,
      executionAuthority: false,
      evidenceRef: `profile-attempt:${attempt.attemptId}`,
    });
  }
  return {
    baselineMatrix: matrix,
    staticLedger: ledger,
    effectiveMatrix,
    overlayStatus: {
      profile: store.paths.profile,
      state: rejected.length > 0 ? (applied.length > 0 ? "partial" : "rejected") : (applied.length > 0 ? "applied" : "empty"),
      applied,
      rejected,
    },
    issues,
  };
}

export function resolveEffectiveRuntimeCapabilityClaim(options) {
  const state = loadEffectiveRuntimeCapabilityClaims(options);
  return {
    ...resolveRuntimeCapabilityClaim(state.effectiveMatrix, options),
    overlayStatus: state.overlayStatus,
    overlayIssues: state.issues,
  };
}
