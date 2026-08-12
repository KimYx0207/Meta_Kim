import {
  assertValidEvidenceTransitionShadowResult,
  evaluateEvidenceTransitionShadow,
} from "../../src/domain/evidence/evidence-transition.mjs";

export const EVIDENCE_TRANSITION_SHADOW_ADAPTER_SCHEMA_VERSION =
  "evidence-transition-shadow-adapter-v1";

const SHADOW_AUTHORITY = Object.freeze({
  gatesExecution: false,
  writesKernel: false,
  writesEvents: false,
  completesNode: false,
  advancesCursor: false,
  projectionOnly: true,
});

const BINDING_FIELDS = Object.freeze([
  "runId",
  "taskFingerprint",
  "graphDigest",
  "nodeId",
  "attemptId",
  "fenceToken",
  "revision",
  "policyDigest",
]);
const CLAIM_FIELDS = Object.freeze([
  "claimId",
  "producerRef",
  "evidenceType",
  "subjectRef",
  "payloadDigest",
]);
const ASSESSMENT_FIELDS = Object.freeze([
  "claimId",
  "validatorRef",
  "assessment",
  "assessmentDigest",
  "reasonCode",
]);
const DECISION_DEPENDENCY_FIELDS = Object.freeze([
  "decisionId",
  "revision",
  "required",
  "authorityState",
  "executionAllowed",
  "evidenceDigest",
]);
const TRANSITION_REQUEST_FIELDS = Object.freeze([
  "proposalId",
  "fromStage",
  "toStage",
  "requiredClaimIds",
]);

const COMMAND_FIELDS = Object.freeze([
  "binding",
  "evidenceClaims",
  "validatorAssessments",
  "decisionDependencies",
  "transitionRequest",
]);
const BRIDGE_INPUT_FIELDS = Object.freeze([
  "policyDigest",
  "evidenceClaims",
  "validatorAssessments",
  "decisionDependencies",
  "transitionRequest",
]);
const AUTHORITATIVE_BINDING_FIELDS = Object.freeze([
  "runId",
  "taskFingerprint",
  "graphDigest",
  "nodeId",
  "attemptId",
  "fenceToken",
  "revision",
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

function assertDenseRecordArray(value, fields) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("shadow input list is not a plain array");
  }
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError("shadow input list length is invalid");
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
      throw new TypeError("shadow input list contains unsupported fields");
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError("shadow input list must be dense own data");
    }
    assertExactOwnDataFields(descriptor.value, fields);
  }
}

function ownDataField(value, field) {
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}

function explicitFields(value, fields) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(value, field))
      .map((field) => [field, ownDataField(value, field)]),
  );
}

function explicitArray(value, fields) {
  if (!Array.isArray(value)) return value;
  const length = ownDataField(value, "length");
  return Array.from({ length }, (_, index) =>
    explicitFields(ownDataField(value, String(index)), fields)
  );
}

function normalizedCommand(input, authoritativeBinding = undefined) {
  if (authoritativeBinding === undefined) {
    assertExactOwnDataFields(input, COMMAND_FIELDS);
    assertExactOwnDataFields(ownDataField(input, "binding"), BINDING_FIELDS);
  } else {
    assertExactOwnDataFields(input, BRIDGE_INPUT_FIELDS);
    assertExactOwnDataFields(authoritativeBinding, AUTHORITATIVE_BINDING_FIELDS);
  }
  const evidenceClaims = ownDataField(input, "evidenceClaims");
  const validatorAssessments = ownDataField(input, "validatorAssessments");
  const decisionDependencies = ownDataField(input, "decisionDependencies");
  const transitionRequest = ownDataField(input, "transitionRequest");
  assertDenseRecordArray(evidenceClaims, CLAIM_FIELDS);
  assertDenseRecordArray(validatorAssessments, ASSESSMENT_FIELDS);
  assertDenseRecordArray(decisionDependencies, DECISION_DEPENDENCY_FIELDS);
  assertExactOwnDataFields(transitionRequest, TRANSITION_REQUEST_FIELDS);
  return {
    binding: authoritativeBinding === undefined
      ? explicitFields(ownDataField(input, "binding"), BINDING_FIELDS)
      : {
          ...explicitFields(authoritativeBinding, AUTHORITATIVE_BINDING_FIELDS),
          policyDigest: ownDataField(input, "policyDigest"),
        },
    evidenceClaims: explicitArray(evidenceClaims, CLAIM_FIELDS),
    validatorAssessments: explicitArray(validatorAssessments, ASSESSMENT_FIELDS),
    decisionDependencies: explicitArray(
      decisionDependencies,
      DECISION_DEPENDENCY_FIELDS,
    ),
    transitionRequest: explicitFields(transitionRequest, TRANSITION_REQUEST_FIELDS),
  };
}

function shadowEnvelope({ evaluationStatus, verdict = "in_doubt", result = null }) {
  return Object.freeze({
    schemaVersion: EVIDENCE_TRANSITION_SHADOW_ADAPTER_SCHEMA_VERSION,
    mode: "shadow_only",
    evaluationStatus,
    verdict,
    result,
    authority: SHADOW_AUTHORITY,
  });
}

/**
 * Maps only an already-normalized evidence-transition command into the pure
 * domain evaluator. The bridge overload supplies a kernel-derived binding and
 * accepts only policy/evidence/decision/transition inputs from its caller.
 * Runtime status, stdout, Markdown, tool calls, and host answer claims are
 * deliberately not accepted as evidence sources here.
 * Rejected input and evaluator errors collapse to a bounded in_doubt envelope
 * without retaining caller values or error details.
 */
export function buildEvidenceTransitionShadowProjection(
  input = null,
  { authoritativeBinding = undefined } = {},
) {
  if (input == null) {
    return shadowEnvelope({
      evaluationStatus: "not_evaluated_missing_normalized_input",
    });
  }

  try {
    if (authoritativeBinding === null) {
      throw new TypeError("authoritative bridge binding is unavailable");
    }
    const result = evaluateEvidenceTransitionShadow(
      normalizedCommand(input, authoritativeBinding),
    );
    assertValidEvidenceTransitionShadowResult(result);
    return shadowEnvelope({
      evaluationStatus: "evaluated",
      verdict: result.verdict.status,
      result,
    });
  } catch {
    return shadowEnvelope({
      evaluationStatus: "not_evaluated_invalid_normalized_input",
    });
  }
}
