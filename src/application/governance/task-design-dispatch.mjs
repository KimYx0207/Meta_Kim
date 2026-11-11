import { validateGovernanceTaskFacts } from "../../domain/governance/governance-requirements.mjs";
import { taskOutcomeDigest } from "../../domain/governance/task-outcome.mjs";

export const TASK_DESIGN_POLICY = "task-design-dispatch-v1";

/** A later turn may reuse facts only while the decision and evidence basis matches. */
export function inheritTaskDesignFacts(predecessor, { intentDigest, requirementsDigest }) {
  if (!predecessor || (predecessor.goalContractPacket?.intentBinding?.intentDigest ?? null) !== (intentDigest ?? null) ||
      (predecessor.requirementsDiscoveryPacket?.discoveryDigest ?? null) !== (requirementsDigest ?? null)) return null;
  return predecessor.governanceTaskFacts ?? null;
}

/** Only an explicitly task-bound host assessment may replace inferred facts. */
export function readCurrentTaskFacts(input, task) {
  if (input == null) return null;
  const version = Object.getOwnPropertyDescriptor(input, "schemaVersion");
  if (version && !("value" in version)) throw new TypeError("Governance facts must expose data properties");
  if (version?.value !== "governance-task-facts-v2") return null;
  const facts = validateGovernanceTaskFacts(input);
  if (facts.taskHash !== taskOutcomeDigest(task)) throw new TypeError("Governance facts belong to another task");
  return facts;
}

/** Four independent dimensions select the work, never its worker/file count. */
export function selectTaskDesignRoute(facts) {
  const design = facts?.design;
  if (!design) return { policy: TASK_DESIGN_POLICY, route: "assess_unknowns", researchRequired: false, designRequired: false,
    humanDecisionRequired: false, assessmentRequired: true, unknownDimensions: [] };
  const unknownDimensions = Object.entries(design).filter(([, value]) => value === "unknown").map(([dimension]) => dimension);
  const integrated = design.uncertainty === "undecided" || ["shared_state", "shared_contract"].includes(design.coupling);
  const probe = design.uncertainty === "focused_unknown" || design.verification === "needs_probe" ||
    facts.evidence.currentExternalFactsRequired || !facts.evidence.localEvidenceSufficient;
  return { policy: TASK_DESIGN_POLICY, route: probe ? "focused_probe" : integrated ? "integrated_design" :
    unknownDimensions.length > 0 ? "assess_unknowns" : "targeted_change",
  assessmentRequired: unknownDimensions.length > 0, unknownDimensions,
  researchRequired: probe, designRequired: integrated,
  humanDecisionRequired: facts.decision.reasonableOptionCount >= 2 && facts.decision.materialDimensions.length > 0 && !facts.decision.internalImplementationOnly };
}

/** Keep permission-sensitive observations independent of design simplification. */
export function mergeTaskSafetyFacts(current, inferred, { requestedSideEffectActions = [], workerTaskPackets = [] } = {}) {
  if (!current) return inferred;
  const observedSideEffect = requestedSideEffectActions.length > 0 || workerTaskPackets.some(packet => packet.externalWriteBoundary === true || packet.executionMode === "approval_gate");
  return validateGovernanceTaskFacts({ ...current,
    change: { ...current.change, externalSideEffect: current.change.externalSideEffect || observedSideEffect },
    security: { ...current.security, permission: observedSideEffect ? true : current.security.permission } });
}

/** Consume the assessment on this existing work order before its invocation. */
export function verifyTaskDesignReadiness(packet) {
  if (!packet.taskFacts) return { ready: false, route: "assess_unknowns", gaps: ["current_subtask_facts_required"], specialistReviewRequired: false };
  if (packet.taskFactsSubject !== packet.todayTask) throw new TypeError("Subtask facts must describe this work order's actual task");
  const facts = readCurrentTaskFacts(packet.taskFacts, packet.todayTask);
  if (!facts) throw new TypeError("Subtask dispatch requires task-bound v2 facts");
  const route = selectTaskDesignRoute(facts);
  const gaps = [];
  // Research/design select useful work; neither settles a different unknown dimension.
  // A bounded diagnostic uses its own assessed work order, not the unknown facts
  // of the implementation it investigates. Independent ready work stays eligible.
  if (route.assessmentRequired) gaps.push("current_subtask_facts_required");
  if (route.designRequired && !packet.designBinding) gaps.push("current_subtask_integrated_design_required");
  if (route.researchRequired && !packet.researchEvidence?.length) gaps.push("current_subtask_decision_evidence_required");
  const specialistReviewRequired = facts.design.operationalRisk === "sensitive";
  if (specialistReviewRequired && (!packet.handoffTarget || !packet.verifySteps?.length)) gaps.push("current_subtask_sensitive_verification_required");
  return { ready: gaps.length === 0, route: route.route, gaps, specialistReviewRequired,
    unknownDimensions: route.unknownDimensions };
}

/** A committed legacy execution remains historical; it must not dispatch again. */
export function requireCurrentDispatchPolicy(artifact) {
  if (artifact?.taskDesignRoutePacket?.policy !== TASK_DESIGN_POLICY) {
    throw new TypeError("Legacy execution needs a one-way successor with current task-bound design facts before further dispatch; preserve completed results and permissions");
  }
}
