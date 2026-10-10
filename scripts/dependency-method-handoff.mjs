import { createHash } from "node:crypto";
/** Advisory bridge only. Read-only professional methods may guide an existing
 * authorized host worker without becoming an execution owner or permission.
 * Binding and invocation remain the current host's responsibility. */
export function buildDependencyMethodHandoff({ task = "", match, scopeExclusion = null } = {}) {
  const owner = match?.selected;
  const verified = owner?.source === "dependency_agent_contract"
    && owner.ownerBindingMode === "run_scoped_owner_contract"
    && !owner.nativeAgentType
    && owner.ownerContract?.contentDigest === owner.contentDigest
    && /^[a-f0-9]{64}$/u.test(owner.contentDigest ?? "")
    && /^[a-f0-9]{64}$/u.test(owner.ownerContract?.componentContentSha256 ?? "")
    && owner.ownerContract?.sourceRef === owner.sourceRef;
  const recommendation = verified ? {
    ownerAgent: owner.id,
    ownerSource: owner.source,
    ownerBindingMode: "run_scoped_owner_contract",
    ownerSourceRef: owner.sourceRef,
    contentDigest: owner.contentDigest,
    ownerContract: owner.ownerContract,
  } : null;
  return {
    schemaVersion: "dependency-method-handoff-v1",
    taskHash: createHash("sha256").update(task).digest("hex"),
    status: recommendation ? "method_recommended_host_binding_required" : "no_verified_method_match",
    evidenceClass: "advisory_source_bound_method_recommendation",
    recommendation,
    matchReason: match?.reason ?? "not_checked",
    scopeExclusion,
    executionAllowed: false,
    automaticInvocation: false,
    grantsPermission: false,
    nativeAgentInvoked: false,
    missingCapabilities: recommendation ? [
      "current_task_host_authorization",
      "existing_worker_task_and_source_binding",
      "current_host_tool_bindings_and_resource_availability",
      "observed_host_invocation_and_result_receipts",
      "independent_task_outcome_verification",
    ] : ["verified_professional_method_match"],
    handoffSteps: recommendation ? [
      "Revalidate and load the recommended source through loadDependencyAgentMethod; recommendation is not invocation.",
      "Give the method and task criteria to the existing authorized worker; do not create or impersonate a native custom agent.",
      "The current host binds only permitted tools and queues exclusive resources; method JSON and prompt claims cannot authorize them.",
      "Bind actual output artifacts and observed receipts to the task and source hashes; missing or denied tools remain blocked.",
      "An independent verifier checks the task outcome; deterministic integrity checks do not establish semantic or live-runtime success.",
    ] : [],
  };
}
