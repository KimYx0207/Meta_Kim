/**
 * A content-addressed proposal for a future governed Meta_Kim run.
 * Its SHA-256 digest is a change detector, never a signature, bearer token,
 * native host authorization, or evidence that a real run was created.
 */
import { createHash } from "node:crypto";

import { AGENT_WORKFLOW_KEY_PATTERN } from "./agent-workflow-decision.mjs";

export const AGENT_HANDOFF_SCHEMA = "meta-kim-agent-handoff-v1";
export const AGENT_HANDOFF_RECORD_SCHEMA = "meta-kim-agent-handoff-record-v1";
const DIGEST = /^[a-f0-9]{64}$/u;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/u;

export function validateAgentHandoffPreparation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.hasOwn(input, "projectRoot") || Object.hasOwn(input, "projectId")
    || !AGENT_WORKFLOW_KEY_PATTERN.test(input.idempotencyKey ?? "")
    || !REQUEST_ID.test(input.requestId ?? "")
    || !DIGEST.test(input.planDigest ?? "")
    || !AGENT_WORKFLOW_KEY_PATTERN.test(input.decisionKey ?? "")
    || !AGENT_WORKFLOW_KEY_PATTERN.test(input.handoffKey ?? "")
    || !Number.isSafeInteger(input.designVersion) || input.designVersion < 1 || input.designVersion > 256
    || !DIGEST.test(input.designDigest ?? "")) return null;
  return {
    idempotencyKey: input.idempotencyKey,
    requestId: input.requestId,
    planDigest: input.planDigest,
    decisionKey: input.decisionKey,
    handoffKey: input.handoffKey,
    designVersion: input.designVersion,
    designDigest: input.designDigest,
  };
}

export function digestAgentHandoffEnvelope(envelope) {
  return createHash("sha256").update("meta-kim-static-handoff-envelope-v1\u0000")
    .update(JSON.stringify(envelope)).digest("hex");
}

export function buildAgentHandoffEnvelope({ scope, plan, basis, design }) {
  if (!scope || scope.kind !== "server_bound" || !DIGEST.test(scope.projectFingerprint ?? "")
    || !plan || plan.status !== "completed" || !plan.planDigest
    || !basis || design?.status !== "approved" || design.reviewComplete !== true
    || !design.system || !Array.isArray(design.modules) || design.modules.length < 1
    || design.system.approval?.state !== "approved"
    || design.modules.some((module) => module.approval?.state !== "approved")) return null;
  const envelope = {
    schemaVersion: "meta-kim-agent-handoff-envelope-v1",
    project: { kind: scope.kind, projectLabel: scope.projectLabel,
      projectFingerprint: scope.projectFingerprint },
    plan: {
      requestId: basis.requestId,
      planDigest: basis.planDigest,
      decisionKey: basis.decisionKey,
      resultPreview: plan.resultPreview,
      selectedStrategy: basis.selectedStrategy,
      selectionReason: basis.selectionReason,
      source: "native_read_only_plan_human_selection",
      researchEvidenceVerified: false,
      sourceCompleteness: "bounded_read_only_preview_only",
    },
    design: {
      version: design.version,
      designDigest: design.designDigest,
      recordDigest: design.recordDigest,
      source: "human_submitted_prd",
      system: design.system,
      modules: design.modules,
    },
    constraints: {
      nativeHostConfirmationRequired: true,
      governedRunCreationRequired: true,
      sideEffectApprovalRequired: true,
      executionAuthorized: false,
    },
  };
  const handoffDigest = digestAgentHandoffEnvelope(envelope);
  return { envelope, handoffDigest };
}
