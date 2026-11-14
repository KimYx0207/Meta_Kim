import { createHash } from "node:crypto";
import path from "node:path";
import { stableJson } from "../dependency-agent-discovery.mjs";
import { scopeComparisonKey } from "../task-scope-comparison.mjs";
import { taskOutcomeDigest } from "../../src/domain/governance/task-outcome.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim();
const keysOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

/** A request for the current host, never an execution adapter or authority.
 * Caller-supplied availability/authorization/denial overrides are rejected. */
export function prepareCurrentHostOperation({ task, workOrder, owner, projectRoot }) {
  if (workOrder.hostOperation == null) return { operation: null, blockers: [] };
  const request = workOrder.hostOperation;
  const blockers = [];
  const invalid = reason => blockers.push(`current_host_operation_${reason}`);
  if (!keysOnly(request, ["schemaVersion", "executionOwner", "operation", "taskHash", "roleInstanceId", "scopeFiles", "methodSource", "requestedTools"]) ||
      request.schemaVersion !== "current-host-operation-request-v1" || request.executionOwner !== "current_host" ||
      request.operation !== "create_or_update" || workOrder.effectClass !== "local_write") invalid("request_invalid");
  if (request.taskHash !== taskOutcomeDigest(task) || request.roleInstanceId !== workOrder.roleInstanceId) invalid("task_binding_mismatch");
  const scopes = values => Array.isArray(values) && values.length && values.every(value => text(value) && !value.split(/[\\/]/u).some(part => part === "." || part === ".."))
    ? values.map(value => scopeComparisonKey(path.resolve(projectRoot, value))).sort() : null;
  const requestScopes = scopes(request.scopeFiles), actualScopes = scopes(workOrder.scopeFiles);
  if (!requestScopes || !actualScopes || requestScopes.includes(null) || stableJson(requestScopes) !== stableJson(actualScopes)) invalid("scope_binding_mismatch");
  const method = request.methodSource;
  const dependencyId = owner?.dependencyId ?? owner?.ownerContract?.dependencyId;
  const capabilities = (owner?.ownerContract?.capabilities ?? []).filter(capability => workOrder.methodCapabilityId === capability.id || workOrder.methodCapabilityId === `${dependencyId}:${capability.id}`);
  const capability = capabilities.length === 1 ? capabilities[0] : null;
  if (!keysOnly(method, ["ownerAgent", "sourceRef", "contentDigest", "componentContentSha256", "capabilityId"]) ||
      owner?.source !== "dependency_agent_contract" || !capability || capability.sideEffects?.length !== 0 ||
      method.ownerAgent !== owner.id || method.sourceRef !== owner.sourceRef || method.contentDigest !== owner.contentDigest ||
      method.componentContentSha256 !== owner.ownerContract.componentContentSha256 ||
      ![capability.id, `${dependencyId}:${capability.id}`].includes(method.capabilityId)) invalid("method_binding_mismatch");
  if (!Array.isArray(request.requestedTools) || !request.requestedTools.length || request.requestedTools.length > 32 ||
      request.requestedTools.some(tool => !keysOnly(tool, ["slot", "tool"]) || !/^[a-zA-Z0-9_.:-]+$/u.test(tool.slot ?? "") || !/^[a-zA-Z0-9_.:-]+$/u.test(tool.tool ?? "")) ||
      new Set(request.requestedTools?.map(tool => tool?.slot)).size !== request.requestedTools?.length) invalid("tool_request_invalid");
  if (blockers.length) return { operation: null, blockers };
  const methodSource = { ...method, capabilityId: `${dependencyId}:${capability.id}` };
  return { blockers, operation: {
    schemaVersion: "current-host-operation-preparation-v1", requestDigest: createHash("sha256").update(stableJson(request)).digest("hex"),
    taskHash: request.taskHash, roleInstanceId: request.roleInstanceId, executionOwner: "current_host", operation: request.operation, methodSource,
    scopeFiles: [...request.scopeFiles], requestedTools: request.requestedTools.map(tool => ({ ...tool, availability: "not_observed", authorization: "not_observed" })),
    status: "prepared_not_bound", toolBindingStatus: "not_observed", authorizationStatus: "not_observed", executionAuthorized: false, canEnterExecution: false,
    nativeInvocationVerified: false, actualExecution: false,
    rejectionPolicy: "An unavailable or denied current-host tool remains unavailable or denied; this request cannot override it or retry that action through another surface.",
    claimBoundary: "Professional guidance and a requested local operation only. Actual tool availability, task permission and results remain with the current host."
  } };
}
