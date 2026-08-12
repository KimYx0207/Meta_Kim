import { createHash } from "node:crypto";
import {
  assertValidContinuationPolicyShadowResult,
  evaluateContinuationPolicyShadow,
} from "../../src/domain/continuation/continuation-policy-shadow.mjs";
import {
  assertValidEvidenceTransitionShadowResult,
  EVIDENCE_TRANSITION_SHADOW_SCHEMA_VERSION,
} from "../../src/domain/evidence/evidence-transition.mjs";

export const CONTINUATION_POLICY_SHADOW_ADAPTER_SCHEMA_VERSION =
  "continuation-policy-shadow-adapter-v1";

const SHADOW_AUTHORITY = Object.freeze({
  gatesExecution: false,
  writesKernel: false,
  writesEvents: false,
  completesNode: false,
  advancesCursor: false,
  changesCheckpoint: false,
  changesLease: false,
  changesFence: false,
  dispatchesScheduler: false,
  terminatesRun: false,
  projectionOnly: true,
});

const INPUT_FIELDS = Object.freeze([
  "policyDigest",
  "evaluationRevision",
  "goalAssessment",
  "workAssessment",
  "evidenceAssessment",
  "blockerAssessment",
  "humanDecisionAssessment",
  "scopeAssessment",
  "repeatAssessment",
  "controlAssessment",
]);
const ASSESSMENT_FIELDS = Object.freeze([
  "state",
  "evidenceRefs",
  "assessmentDigest",
]);
const CONTROL_ASSESSMENT_FIELDS = Object.freeze([
  "state",
  "controlRef",
  "evidenceRefs",
  "assessmentDigest",
]);
const AUTHORITY_SNAPSHOT_FIELDS = Object.freeze([
  "source",
  "projectionSchemaVersion",
  "runStatus",
  "runId",
  "taskFingerprint",
  "graphDigest",
  "cursor",
  "headEventHash",
  "headCheckpointId",
  "projectionDigest",
  "eventChainState",
  "blockingEffectRefs",
  "activeClaimRefs",
  "bridgeSettlementState",
  "currentness",
]);
const EVIDENCE_PROJECTION_FIELDS = Object.freeze([
  "schemaVersion",
  "mode",
  "evaluationStatus",
  "verdict",
  "result",
  "authority",
]);
const EVIDENCE_AUTHORITY_FIELDS = Object.freeze([
  "gatesExecution",
  "writesKernel",
  "writesEvents",
  "completesNode",
  "advancesCursor",
  "projectionOnly",
]);

function assertExactOwnDataFields(value, fields) {
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("shadow input is not an exact plain record");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new TypeError("shadow input contains unknown or missing fields");
  }
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError("shadow input must contain enumerable own data fields only");
    }
  }
}

function ownDataField(value, field) {
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digest(value) {
  const serialized = JSON.stringify(canonical(value));
  return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

function copyExactRecord(value, fields) {
  assertExactOwnDataFields(value, fields);
  return Object.fromEntries(fields.map((field) => [field, ownDataField(value, field)]));
}

function copyDenseStringArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("shadow references are not a plain array");
  }
  const length = ownDataField(value, "length");
  if (!Number.isSafeInteger(length) || length < 0 || length > 256) {
    throw new TypeError("shadow references have an invalid length");
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
      Number(key) >= length
    ) {
      throw new TypeError("shadow references contain unsupported fields");
    }
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError("shadow references must be dense own data");
    }
    return descriptor.value;
  });
}

function copiedAssessment(value, fields = ASSESSMENT_FIELDS) {
  const copied = copyExactRecord(value, fields);
  copied.evidenceRefs = copyDenseStringArray(copied.evidenceRefs);
  return copied;
}

function copiedAuthoritySnapshot(value) {
  const copied = copyExactRecord(value, AUTHORITY_SNAPSHOT_FIELDS);
  copied.blockingEffectRefs = copyDenseStringArray(copied.blockingEffectRefs);
  copied.activeClaimRefs = copyDenseStringArray(copied.activeClaimRefs);
  return copied;
}

function copiedEvidenceTransition(projection, snapshot, policyDigest) {
  assertExactOwnDataFields(projection, EVIDENCE_PROJECTION_FIELDS);
  if (
    ownDataField(projection, "schemaVersion") !== "evidence-transition-shadow-adapter-v1" ||
    ownDataField(projection, "mode") !== "shadow_only"
  ) {
    throw new TypeError("evidence transition envelope identity is invalid");
  }
  const authority = copyExactRecord(
    ownDataField(projection, "authority"),
    EVIDENCE_AUTHORITY_FIELDS,
  );
  if (
    authority.gatesExecution !== false ||
    authority.writesKernel !== false ||
    authority.writesEvents !== false ||
    authority.completesNode !== false ||
    authority.advancesCursor !== false ||
    authority.projectionOnly !== true
  ) {
    throw new TypeError("evidence transition envelope authority is invalid");
  }
  const result = ownDataField(projection, "result");
  const reportedEvaluationStatus = ownDataField(projection, "evaluationStatus");
  const reportedVerdict = ownDataField(projection, "verdict");
  if (result !== null) {
    assertValidEvidenceTransitionShadowResult(result);
    if (
      result.binding.runId !== snapshot.runId ||
      result.binding.taskFingerprint !== snapshot.taskFingerprint ||
      result.binding.graphDigest !== snapshot.graphDigest ||
      result.binding.policyDigest !== policyDigest
    ) {
      throw new TypeError("evidence transition binding does not match bridge authority");
    }
    if (
      reportedEvaluationStatus !== "evaluated" ||
      reportedVerdict !== result.verdict.status
    ) {
      throw new TypeError("evidence transition envelope conflicts with its canonical result");
    }
    return {
      schemaVersion: result.schemaVersion,
      result,
      evaluationStatus: "evaluated",
      verdict: result.verdict.status,
    };
  }
  if (
    ![
      "not_evaluated_missing_normalized_input",
      "not_evaluated_invalid_normalized_input",
    ].includes(reportedEvaluationStatus) ||
    reportedVerdict !== "in_doubt"
  ) {
    throw new TypeError("evidence transition empty envelope is invalid");
  }
  return {
    schemaVersion: EVIDENCE_TRANSITION_SHADOW_SCHEMA_VERSION,
    result: null,
    evaluationStatus: reportedEvaluationStatus,
    verdict: "in_doubt",
  };
}

function normalizedCommand(input, authoritativeSnapshot, evidenceProjection) {
  assertExactOwnDataFields(input, INPUT_FIELDS);
  const snapshot = copiedAuthoritySnapshot(authoritativeSnapshot);
  const evidence = copiedEvidenceTransition(
    evidenceProjection,
    snapshot,
    ownDataField(input, "policyDigest"),
  );
  const evidenceResult = evidence.result;
  return {
    binding: {
      runId: snapshot.runId,
      taskFingerprint: snapshot.taskFingerprint,
      graphDigest: snapshot.graphDigest,
      projectionDigest: snapshot.projectionDigest,
      durableCursor: snapshot.cursor,
      headEventHash: snapshot.headEventHash,
      headCheckpointId: snapshot.headCheckpointId,
      policyDigest: ownDataField(input, "policyDigest"),
      evaluationRevision: ownDataField(input, "evaluationRevision"),
    },
    authoritySnapshot: snapshot,
    goalAssessment: copiedAssessment(ownDataField(input, "goalAssessment")),
    workAssessment: copiedAssessment(ownDataField(input, "workAssessment")),
    evidenceAssessment: copiedAssessment(ownDataField(input, "evidenceAssessment")),
    blockerAssessment: copiedAssessment(ownDataField(input, "blockerAssessment")),
    humanDecisionAssessment: copiedAssessment(ownDataField(input, "humanDecisionAssessment")),
    scopeAssessment: copiedAssessment(ownDataField(input, "scopeAssessment")),
    repeatAssessment: copiedAssessment(ownDataField(input, "repeatAssessment")),
    controlAssessment: copiedAssessment(
      ownDataField(input, "controlAssessment"),
      CONTROL_ASSESSMENT_FIELDS,
    ),
    evidenceTransition: {
      schemaVersion: evidence.schemaVersion,
      resultDigest: digest(evidenceResult ?? {
        schemaVersion: evidence.schemaVersion,
        evaluationStatus: evidence.evaluationStatus,
        verdict: evidence.verdict,
      }),
      bindingDigest: evidenceResult?.bindingDigest ?? digest({
        binding: null,
        evaluationStatus: evidence.evaluationStatus,
      }),
      evaluationStatus: evidence.evaluationStatus,
      verdict: evidence.verdict,
    },
  };
}

function shadowEnvelope({ evaluationStatus, disposition = "escalate", result = null }) {
  return Object.freeze({
    schemaVersion: CONTINUATION_POLICY_SHADOW_ADAPTER_SCHEMA_VERSION,
    mode: "shadow_only",
    evaluationStatus,
    disposition,
    result,
    authority: SHADOW_AUTHORITY,
  });
}

/**
 * Combines caller-supplied assessments with bridge-derived authority facts.
 * Rejected input collapses to a bounded non-authorizing envelope without
 * retaining caller values or exception details.
 */
export function buildContinuationPolicyShadowProjection(
  normalizedInput = null,
  {
    authoritativeSnapshot = null,
    evidenceTransitionShadowProjection = null,
  } = {},
) {
  if (normalizedInput == null) {
    return shadowEnvelope({
      evaluationStatus: "not_evaluated_missing_normalized_input",
    });
  }
  try {
    const result = evaluateContinuationPolicyShadow(
      normalizedCommand(
        normalizedInput,
        authoritativeSnapshot,
        evidenceTransitionShadowProjection,
      ),
    );
    assertValidContinuationPolicyShadowResult(result);
    return shadowEnvelope({
      evaluationStatus: "evaluated",
      disposition: result.disposition.action,
      result,
    });
  } catch {
    return shadowEnvelope({
      evaluationStatus: "not_evaluated_invalid_normalized_input",
    });
  }
}
