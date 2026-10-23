import { validateArtifactFile } from "../validate-run-artifact.mjs";

const CONTINUABLE_PHASES = new Set([
  "awaiting_fact_discovery",
  "awaiting_user_answer",
  "awaiting_understanding_confirmation",
  "awaiting_execution_authorization",
]);

export async function loadPlanChallengeContinuationCandidate({
  artifactPath,
  previousRunId,
  taskFingerprint,
  taskHash,
  intentDigest,
}) {
  const artifact = await validateArtifactFile(artifactPath);
  if (artifact.runId !== previousRunId) {
    throw new Error("Plan challenge continuation run id does not match the prior artifact.");
  }
  if (artifact.taskFingerprint !== taskFingerprint) {
    throw new Error("Plan challenge continuation belongs to a different task.");
  }
  const priorTaskHash = artifact.goalContractPacket?.taskHash;
  const priorIntentDigest = artifact.goalContractPacket?.intentBinding?.intentDigest ?? null;
  if (taskHash !== undefined && priorTaskHash !== taskHash) {
    throw new Error("Plan challenge continuation task binding mismatch.");
  }
  if (intentDigest !== undefined && priorIntentDigest !== intentDigest) {
    throw new Error("Plan challenge continuation intent binding mismatch.");
  }
  const planChallengeState = artifact.preDecisionOptionFrame?.planChallengeState;
  const unresolvedQuestions = artifact.preDecisionOptionFrame?.unresolvedQuestions;
  if (!planChallengeState || !Array.isArray(unresolvedQuestions)) {
    throw new Error("Prior artifact does not contain a valid plan challenge state.");
  }
  if (!CONTINUABLE_PHASES.has(planChallengeState.phase)) {
    throw new Error(`Plan challenge continuation cannot resume terminal phase: ${planChallengeState.phase}.`);
  }
  return {
    previousRunId,
    taskHash: priorTaskHash,
    intentDigest: priorIntentDigest,
    planChallengeState,
    unresolvedQuestions,
  };
}

export function bindVerifiedHostPlanChallengeDecision({
  verifiedDecision: _verifiedDecision,
  preview: _preview,
  continuationCandidate: _continuationCandidate = null,
}) {
  return {
    accepted: false,
    reason: "host_native_decision_required",
    handoffStatus: "awaiting_native_choice",
    hostAction: "host_action_required",
  };
}
