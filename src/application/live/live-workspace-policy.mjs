import workspacePolicy from "../../../config/live/workspace.json" with { type: "json" };

/** One package policy for both host ingestion and private HTTP projection. */
export function loadLiveWorkspacePolicy() {
  return normalizeLiveWorkspacePolicy(workspacePolicy);
}

export function normalizeLiveWorkspacePolicy(policy) {
  if (policy.schemaVersion !== "meta-kim-live-workspace-policy-v1") throw new TypeError("Invalid Live workspace policy");
  for (const key of ["modulePageSize", "requestPageSize", "stageEvidenceLimit", "maxEvidenceRefChars", "stageSummaryChars", "maxArchiveBytes", "maxModules", "materialPageBytes", "maxMaterialBytes", "maxDesignBytes", "maxFeedbackBytes", "maxRequests", "maxReviews", "maxWorkspaceStateBytes", "maxOverviewBytes", "reviewValidityMs", "hostLeaseMs"]) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) throw new TypeError(`Invalid workspace policy ${key}`);
  }
  if (policy.modulePageSize > policy.maxModules || policy.requestPageSize > policy.maxRequests || policy.materialPageBytes < 4 ||
      policy.materialPageBytes > policy.maxMaterialBytes || policy.maxRequests < 2 * policy.maxModules + 2 ||
      policy.maxReviews < policy.maxModules + 1 || policy.maxArchiveBytes < policy.maxWorkspaceStateBytes ||
      !Array.isArray(policy.choices) || policy.choices.map(choice => choice.id).join(",") !== "accept,revise,return") {
    throw new TypeError("Inconsistent Live workspace policy");
  }
  return Object.freeze({ ...policy, choices: Object.freeze(policy.choices.map(choice => Object.freeze({ ...choice }))) });
}
