import { selectReadyDecisionFrontier } from "./plan-challenge-policy.mjs";

/** Presentation only: neither this projection nor a Pause grants or denies execution. */
export function insertHighCostCardPauses(cardKeys, cardTypeCatalog, waitingCardKey = null) {
  const costs = new Map(cardTypeCatalog.map((card) => [card.id, card.cost]));
  const activeOrder = [];
  const pauseReasons = [];
  let consecutiveHighCost = 0;
  let maximumConsecutiveHighCost = 0;
  for (const cardKey of cardKeys) {
    activeOrder.push(cardKey);
    consecutiveHighCost = costs.get(cardKey) === "high" ? consecutiveHighCost + 1 : 0;
    maximumConsecutiveHighCost = Math.max(maximumConsecutiveHighCost, consecutiveHighCost);
    if (consecutiveHighCost >= 3 || cardKey === waitingCardKey) {
      activeOrder.push("pause");
      pauseReasons.push(cardKey === waitingCardKey ? "user_decision_window" : "high_cost_control_window");
      consecutiveHighCost = 0;
    }
  }
  return { activeOrder, pauseReasons, maximumConsecutiveHighCost };
}

/**
 * Derive cards from the existing question ledger and observed route evidence.
 * The decision frontier owns readiness and settled answers; cards do not keep
 * a second question history, infer user choices from capability counts, or
 * turn a host's next action into another user approval.
 */
export function projectContextualCardPlan({
  orchestrationReport,
  runtimeEvidence,
  preDecisionOptionFrame = null,
  cardTypeCatalog,
}) {
  const questions = preDecisionOptionFrame?.unresolvedQuestions ?? [];
  const challenge = preDecisionOptionFrame?.planChallengeState;
  const stopped = challenge?.stopRequested === true || challenge?.phase === "stopped_by_user";
  const selectedQuestion = stopped ? null : selectReadyDecisionFrontier(questions)
    .find((question) => question.resolutionClass === "material_user_decision") ?? null;
  const optionsNeeded = selectedQuestion != null && (selectedQuestion.options?.length ?? 0) >= 2;
  const clarificationNeeded = selectedQuestion != null && !optionsNeeded;
  const pendingChoice = challenge?.pendingUserChoice;
  // Reuse only an actual outstanding host question. A generic nextAction or
  // an unanswered discoverable fact is work for the host, not for the user.
  const userNextStepNeeded = !stopped && !selectedQuestion &&
    !questions.some((question) => question.status === "open") &&
    challenge?.active === true &&
    ["awaiting_understanding_confirmation", "awaiting_execution_authorization"].includes(challenge.phase) &&
    pendingChoice?.status === "required_not_invoked" &&
    Boolean(pendingChoice.question?.binding && pendingChoice.question?.displayText);
  const workerCount = orchestrationReport.workerTaskPackets?.length ?? 0;
  const runtimeRecordCount = runtimeEvidence.results?.length ?? 0;
  const hasBlockedGap = orchestrationReport.capabilityGaps?.some((gap) => gap.blocked) ?? false;
  // Preserve the existing conservative safety signal; missing release proof
  // must not silently become safe merely because presentation is quieter.
  const runtimeRisk = runtimeEvidence.results?.some((item) => item.strictReleasePass === false) ?? false;
  const reviewStatus = orchestrationReport.reviewResult?.status;
  const needsFix = reviewStatus != null && reviewStatus !== "pass";
  const userDecisionNeeded = selectedQuestion != null || userNextStepNeeded;
  const waitingCardKey = optionsNeeded ? "options" : clarificationNeeded ? "clarify" : userNextStepNeeded ? "nudge" : null;
  const primaryActiveOrder = [
    ...(runtimeRisk ? ["risk"] : []),
    ...(clarificationNeeded ? ["clarify"] : []),
    ...(workerCount > 1 ? ["shrink-scope"] : []),
    ...(optionsNeeded ? ["options"] : []),
    ...(workerCount > 0 ? ["execute"] : []),
    ...(runtimeRecordCount > 0 ? ["verify"] : []),
    ...(hasBlockedGap ? ["rollback"] : []),
    ...(needsFix ? ["fix"] : []),
    ...(userNextStepNeeded ? ["nudge"] : []),
  ];
  const cadence = insertHighCostCardPauses(primaryActiveOrder, cardTypeCatalog, waitingCardKey);
  const pauseNeeded = cadence.pauseReasons.length > 0;
  return {
    ...cadence,
    selectedQuestionId: selectedQuestion?.questionId ?? null,
    questionEvidenceRef: selectedQuestion
      ? `preDecisionOptionFrame.unresolvedQuestions[${questions.indexOf(selectedQuestion)}]` : null,
    choiceSuppressionReason: questions.some((question) => question.status === "open")
      ? "verification_pending" : questions.some((question) => question.status === "answered")
        ? "already_known" : "no_clear_intervention_gain",
    context: {
      workerCount, runtimeRecordCount, hasBlockedGap, runtimeRisk, reviewStatus,
      clarificationNeeded, optionsNeeded, needsFix, userNextStepNeeded, userDecisionNeeded, pauseNeeded,
      highCostActiveBeforePause: cadence.maximumConsecutiveHighCost,
    },
    rejoinCondition: userDecisionNeeded ? "after_current_user_decision"
      : pauseNeeded ? "after_compact_status" : "no_pause_required",
  };
}
