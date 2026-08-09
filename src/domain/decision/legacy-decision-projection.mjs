/** Read-only compatibility projections for the non-authorizing Decision v1. */

import { assertValidDecision, claimEvidenceTier, decisionExecutionGate } from "./decision.mjs";

function copy(value) { return JSON.parse(JSON.stringify(value)); }

function opaqueReference(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`Decision projection: ${label} must be a bounded lowercase opaque reference.`);
  }
  const normalized = value.normalize("NFKC").trim();
  const payload = normalized.includes(":") ? normalized.slice(normalized.indexOf(":") + 1) : "";
  const secretish = /(?:^|[._/-])(?:secret|token|password|credential|bearer|key|api[._-]?key|access[._-]?key|private[._-]?key|client[._-]?secret|auth(?:orization)?)(?:$|[._/-])|(?:^|[._/-])(?:sk|rk|pk|ghp|gho|ghu|ghs|github_pat|xox[abopr]|akia|aiza|eyj)(?:[._/-]|$)|(?:^|[._/-])(?:sk|rk|pk)-[a-z0-9_-]{8,}(?:$|[._/-])|(?:^|[._/-])(?:ghp|gho|ghu|ghs)_[a-z0-9]{12,}(?:$|[._/-])|(?:^|[._/-])github_pat_[a-z0-9_]{12,}(?:$|[._/-])|(?:^|[._/-])xox[abopr]-[a-z0-9-]{12,}(?:$|[._/-])|(?:^|[._/-])akia[0-9a-z]{16}(?:$|[._/-])|(?:^|[._/-])aiza[a-z0-9_-]{20,}(?:$|[._/-])|(?:^|[._/-])eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}(?:$|[._/-])/u;
  if (value !== normalized || normalized.length > 128 || !/^(?:[a-z][a-z0-9_-]{1,31}):[a-z0-9][a-z0-9._/-]{0,95}$/u.test(normalized) ||
      (!/^sha256:[a-f0-9]{64}$/u.test(normalized) && secretish.test(payload))) {
    throw new TypeError(`Decision projection: ${label} must be a bounded lowercase opaque reference.`);
  }
  return normalized;
}

function projectionInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).some((key) => key !== "reviewOwnerRef" || Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true)) {
    throw new TypeError("Decision projection: input must contain only reviewOwnerRef.");
  }
  return { reviewOwnerRef: opaqueReference(value.reviewOwnerRef ?? "policy:review-owner-required", "reviewOwnerRef") };
}

function choiceState(decision) {
  if (decision.status === "host_answer_claimed") return "host_answer_claimed_not_verified";
  if (decision.status === "skipped") return "no_branching_choice";
  return "pending_user_choice";
}

function questionTarget(decision) {
  if (decision.routeChangingDimensions.includes("permission")) return "permission_or_authorization_risk";
  if (decision.routeChangingDimensions.includes("owner")) return "wrong_owner_or_handoff_risk";
  if (decision.routeChangingDimensions.includes("runtime_or_os")) return "runtime_or_compatibility_risk";
  if (decision.routeChangingDimensions.includes("dependency")) return "dependency_or_compatibility_risk";
  if (decision.routeChangingDimensions.includes("risk_or_cost")) return "risk_or_cost_risk";
  if (decision.routeChangingDimensions.includes("acceptance")) return "acceptance_boundary_risk";
  return "wrong_deliverable_or_scope_risk";
}

function boundary(decision) {
  return {
    decisionId: decision.decisionId,
    decisionStatus: decision.status,
    claimEvidenceTier: claimEvidenceTier(decision),
    projectionOnly: true,
    cannotAnswerDecision: true,
    cannotAuthorizeExecution: true,
    rule: "v1 projections and host answer claims are display-only; M3-P2 verification is required before authorization.",
  };
}

function optionProjection(option) {
  return {
    optionId: option.optionId,
    displayRef: option.displayRef,
    tradeoffRefs: copy(option.tradeoffRefs),
    evidenceRefs: copy(option.evidenceRefs),
    decisionImpact: "route-changing decision option",
    candidateOwners: ["policy:selected-by-authority-layer"],
    candidateTaskShape: "decision:option-projection",
  };
}

export function buildCardPlanPacketDecisionProjection(decision) {
  assertValidDecision(decision);
  return {
    schemaVersion: "legacy-card-plan-decision-projection-v1",
    ...boundary(decision),
    cardType: "options",
    choiceSurface: decision.nativeSurface?.surface ?? null,
    choiceSurfaceDelivery: "policy:adapter-required-not-triggered-by-artifact",
    choiceSurfaceTriggerProof: "policy:projection-is-not-host-invocation",
    recommendedOptionId: decision.recommendation?.optionId ?? null,
    optionIds: decision.options.map((option) => option.optionId),
    hostAnswerClaimRef: decision.hostAnswerClaim?.claimRef ?? null,
  };
}

export function buildPreDecisionOptionFrameProjection(decision, input = {}) {
  assertValidDecision(decision);
  const { reviewOwnerRef } = projectionInput(input);
  const gate = decisionExecutionGate(decision);
  return {
    decisionTrigger: { required: decision.requirement.required, reasonRef: decision.requirement.reasonRef, routeChangingDimensions: copy(decision.routeChangingDimensions) },
    contentEvidence: copy(decision.evidence),
    optionFrame: { decisionId: decision.decisionId, optionIds: decision.options.map((option) => option.optionId), recommendedOptionId: decision.recommendation?.optionId ?? null },
    presentedBeforeDecision: true,
    userChoiceState: choiceState(decision),
    builtFromContentEvidence: true,
    contentEvidenceRefs: decision.evidence.map((item) => item.evidenceRef),
    unresolvedQuestions: [{
      questionId: decision.decisionId,
      questionRef: decision.requirement.reasonRef,
      questionTarget: questionTarget(decision),
      decisionImpact: decision.routeChangingDimensions.join(","),
      impactPriority: decision.requirement.required ? "high" : "normal",
      dependsOn: [],
      evidenceRefs: copy(decision.requirement.evidenceRefs),
      recommendationState: decision.recommendation ? "recommended" : "insufficient_evidence",
      recommendedAnswerRef: decision.recommendation?.optionId ?? null,
      recommendationRationaleRef: decision.recommendation?.rationaleRef ?? null,
      userAnswer: null,
      answerEvidenceRefs: [],
      hostAnswerClaimRef: decision.hostAnswerClaim?.claimRef ?? null,
      hostAnswerClaimState: decision.hostAnswerClaim ? "host_answer_claimed_not_verified" : "none",
      invalidatedByRef: decision.invalidation?.reasonRef ?? null,
      status: decision.status === "invalidated" ? "invalidated" : "open",
    }],
    candidateOptions: decision.options.map(optionProjection),
    recommendedDefault: decision.recommendation ? { optionId: decision.recommendation.optionId, rationaleRef: decision.recommendation.rationaleRef, evidenceRefs: copy(decision.recommendation.evidenceRefs) } : null,
    requiresUserChoice: decision.requirement.required,
    nativeChoiceSurface: decision.nativeSurface ? copy(decision.nativeSurface) : null,
    choiceGateSkip: decision.status === "skipped",
    skipSource: decision.status === "skipped" ? "decision:v1" : null,
    skipSafetyRationaleRef: decision.status === "skipped" ? decision.requirement.reasonRef : null,
    solutionChoiceState: choiceState(decision),
    reviewOwnerRef,
    executionAllowed: false,
    blockedReason: gate.blockedReason,
    decisionDomain: boundary(decision),
  };
}

export function buildRouteGateDecisionProjection(decision) {
  assertValidDecision(decision);
  const gate = decisionExecutionGate(decision);
  return {
    schemaVersion: "legacy-route-gate-decision-projection-v1",
    ...boundary(decision),
    required: gate.required,
    executionAllowed: false,
    blockedReason: gate.blockedReason,
    hostAnswerClaimRef: decision.hostAnswerClaim?.claimRef ?? null,
    nativeSurface: decision.nativeSurface ? copy(decision.nativeSurface) : null,
  };
}

export const buildLegacyCardPlanPacketProjection = buildCardPlanPacketDecisionProjection;
export const buildLegacyPreDecisionOptionFrameProjection = buildPreDecisionOptionFrameProjection;
export const buildLegacyRouteGateProjection = buildRouteGateDecisionProjection;
