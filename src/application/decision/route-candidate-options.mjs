/** Select material alternatives; choosing a worker is an internal operation. */
import policy from "../../../config/governance/material-decision-policy.json" with { type: "json" };
const materialDimensions = new Set(policy.materialDimensions);
const refs = value => Array.isArray(value) && value.length > 0 && value.every(ref => typeof ref === "string" && ref.trim());

export function routeCandidateOptions(routeResult) {
  const card = routeResult?.decisionCard;
  const options = (card?.options ?? []).filter(option =>
    option.source?.startsWith("recommendedRoute.subjectiveUiCapabilityAmplification.decisionCheckpoints.") ||
    (Array.isArray(option.materialDimensions) && option.materialDimensions.some(dimension =>
      materialDimensions.has(dimension)) &&
      refs(option.evidenceRefs) && typeof option.expectedResult === "string" && option.expectedResult.trim()));
  if (options.length < 2) return [];
  return options.map((option) => ({
    optionId: option.id, whatChanges: option.bestFor ?? option.weapon ?? option.id,
    problemSolved: option.benefit ?? "Uses capabilities discovered for the current task.",
    expectedResult: option.expectedResult ?? "Deliver the user outcome through this bounded route.",
    advantages: [option.benefit ?? option.verificationMethod ?? "Evidence-backed capability fit"],
    disadvantages: [option.cost ?? "Cost and duration require task-specific evidence."],
    evidenceRefs: refs(option.evidenceRefs) ? [...option.evidenceRefs] : ["selectedExecutionRoute.rankedRoutes", "selectedExecutionRoute.ownerDiscoveryPacket"],
    decisionImpact: option.risk ?? "Changes the evidenced outcome or its constraints.",
    candidateOwners: [option.owner ?? routeResult?.recommendedRoute?.owner].filter(Boolean),
    candidateTaskShape: "task_bound_route",
  }));
}
