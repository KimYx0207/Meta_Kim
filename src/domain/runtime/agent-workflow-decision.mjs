/**
 * Decisions about a native CLI's read-only plan are review artifacts, not
 * execution authority. A future governed run must have its own explicit,
 * separately verified authorization and runtime evidence.
 */
import { createHash } from "node:crypto";

export const AGENT_DECISION_SCHEMA = "meta-kim-agent-decision-v1";
export const AGENT_REQUEST_SCHEMA = "meta-kim-agent-request-v1";
export const AGENT_WORKFLOW_SCHEMA = "meta-kim-agent-workflow-record-v1";

export const AGENT_WORKFLOW_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const DECISION_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const PLAN_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const ACTIONS = Object.freeze({
  adopt: "adopted_for_design",
  revise: "revision_requested",
  reject: "rejected",
});

export function agentWorkflowConflict(reason) {
  const error = new Error(reason);
  error.code = "AGENT_REQUEST_CONFLICT";
  error.reason = reason;
  return error;
}

export function agentWorkflowFingerprint(goal, hostId) {
  return createHash("sha256").update(hostId).update("\u0000").update(goal).digest("hex");
}

export function agentWorkflowProjectFingerprint(realRoot, profile) {
  return createHash("sha256").update("meta-kim-project-v1\u0000")
    .update(realRoot).update("\u0000").update(profile).digest("hex");
}

export function agentWorkflowPlanDigest({ projectFingerprint, requestId, resultPreview }) {
  if (!PLAN_DIGEST_PATTERN.test(projectFingerprint)
    || typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)
    || typeof resultPreview !== "string" || !resultPreview.trim()) return null;
  return createHash("sha256").update("meta-kim-read-only-plan-v1\u0000")
    .update(projectFingerprint).update("\u0000").update(requestId)
    .update("\u0000").update(resultPreview).digest("hex");
}

export function validateAgentWorkflowIntake(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.hasOwn(input, "projectId") || Object.hasOwn(input, "projectRoot")) return null;
  const { goal, hostId, idempotencyKey } = input;
  if (typeof goal !== "string" || typeof hostId !== "string"
    || !/^[a-z][a-z0-9_-]{1,31}$/u.test(hostId)
    || typeof idempotencyKey !== "string" || !AGENT_WORKFLOW_KEY_PATTERN.test(idempotencyKey)) return null;
  const normalizedGoal = goal.trim();
  if (!normalizedGoal || normalizedGoal.length > 6_000
    || Buffer.byteLength(normalizedGoal, "utf8") > 24 * 1024
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalizedGoal)) return null;
  return { goal: normalizedGoal, hostId, idempotencyKey };
}

export function validateAgentWorkflowDecision(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { idempotencyKey, requestId, planDigest, action, decisionKey } = input;
  if (!AGENT_WORKFLOW_KEY_PATTERN.test(idempotencyKey ?? "")
    || !REQUEST_ID_PATTERN.test(requestId ?? "")
    || !PLAN_DIGEST_PATTERN.test(planDigest ?? "")
    || !Object.hasOwn(ACTIONS, action)
    || !DECISION_KEY_PATTERN.test(decisionKey ?? "")) return null;
  const feedback = input.feedback == null ? "" : input.feedback;
  if (typeof feedback !== "string" || feedback.length > 2_000
    || Buffer.byteLength(feedback, "utf8") > 8_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(feedback)
    || (action === "revise" && !feedback.trim())) return null;
  // The native CLI currently returns an unstructured text plan. Require a
  // human to name the adopted strategy and explain their decision; no parser
  // may imply that two or three machine-verifiable options were discovered.
  let selectedStrategy = null;
  let selectionReason = null;
  if (action === "adopt") {
    if (typeof input.selectedStrategy !== "string" || typeof input.selectionReason !== "string") return null;
    selectedStrategy = input.selectedStrategy.trim();
    selectionReason = input.selectionReason.trim();
    if (!selectedStrategy || selectedStrategy.length > 180
      || Buffer.byteLength(selectedStrategy, "utf8") > 720
      || !selectionReason || selectionReason.length > 1_200
      || Buffer.byteLength(selectionReason, "utf8") > 4_800
      || /[\u0000-\u001f\u007f]/u.test(selectedStrategy)
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(selectionReason)) return null;
  }
  return {
    idempotencyKey, requestId, planDigest, action, feedback: feedback.trim(), decisionKey,
    state: ACTIONS[action], selectedStrategy, selectionReason,
  };
}
