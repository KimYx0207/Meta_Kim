import { createHash } from "node:crypto";
import { stageLaneNodeId } from "./stage-dag.mjs";

const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value ?? null);
export const moduleStageDigest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const text = (value) => typeof value === "string" && value.trim().length > 0;
const hash = (value) => /^[a-f0-9]{64}$/u.test(value ?? "");
const requireThat = (condition, message) => { if (!condition) throw new TypeError(message); };

/** Bindings are injected by the current host, never read from a DAG or receipt. */
export function resolveModuleStageExecutor(executors, node) {
  if (node.stageContract?.taskDecompositionRequired) return null;
  const executor = executors?.[node.nodeId] ?? executors?.[`${node.scope?.kind}:${node.stage}`] ?? executors?.[node.stage];
  if (!executor || executor.ready === false) return null;
  requireThat(typeof executor.invoke === "function" && text(executor.ownerId) && text(executor.capabilityId) &&
    text(executor.sourceRef) && hash(executor.sourceSha256) && text(executor.toolBinding), "Current host stage executor requires an owner, source digest, capability and actual tool binding");
  return executor;
}

export function moduleStageSatisfied(record) {
  return record?.status === "completed" && (record.laneKind !== "module_stage" || record.stageVerdict === "pass");
}

export function assertStoredModuleStageRecord({ record, node, stageDagPacket, runId }) {
  if (node?.laneKind !== "module_stage") return;
  const receipt = record?.stageReceipt;
  requireThat(record?.laneKind === "module_stage" && record.status === "completed" && receipt &&
    receipt.binding?.runId === runId && receipt.binding.nodeId === node.nodeId && receipt.binding.stage === node.stage &&
    receipt.binding.graphDigest === stageDagPacket.graphDigest && receipt.binding.scopeDigest === moduleStageDigest(node.scope) &&
    record.stageVerdict === receipt.verdict && record.outputSha256 === moduleStageDigest(receipt),
    "Stored stage result does not match its current immutable graph, scope or receipt");
}

/** A Live work order narrows dispatch; it is never an authorization grant. */
export function moduleNodeInRequestedScope(node, scope, workerTaskPackets = []) {
  if (!scope) return true;
  requireThat(["module", "aggregate"].includes(scope.kind) && Array.isArray(scope.moduleIds) && scope.moduleIds.length > 0 &&
    Array.isArray(scope.requiredModuleIds ?? scope.moduleIds) && scope.moduleIds.every((id) => (scope.requiredModuleIds ?? scope.moduleIds).includes(id)), "Module dispatch scope requires target and prerequisite module identities");
  if (node.scope?.kind === "aggregate") return scope.kind === "aggregate" && node.scope.moduleIds.every((id) => scope.moduleIds.includes(id));
  if (node.laneKind === "execution_worker") {
    const packet = workerTaskPackets.find((item) => node.nodeId === stageLaneNodeId("Execution", item.taskPacketId));
    return packet && Array.isArray(scope.taskIds) && (scope.taskIds.includes(packet.taskPacketId) || scope.taskIds.includes(packet.designBinding?.sliceId) || scope.taskIds.includes(packet.roleInstanceId));
  }
  if (node.scope?.kind === "shared") return true;
  return scope.moduleIds.includes(node.scope?.moduleId) ||
    ["Critical", "Fetch", "Thinking"].includes(node.stage) && (scope.requiredModuleIds ?? scope.moduleIds).includes(node.scope?.moduleId);
}

/** Traverse actual graph edges, so a reviewer sees the task results it judges,
 * including tasks reached through deterministic merges. No unrelated module
 * output or global transcript is implicitly attached. */
export function moduleStageAncestorResults(stageDagPacket, node, records) {
  const byId = new Map(stageDagPacket.nodes.map((item) => [item.nodeId, item]));
  const visited = new Set();
  const pending = [...node.dependsOn];
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...byId.get(id)?.dependsOn ?? []);
  }
  return [...visited].map((id) => records.get(id)).filter(Boolean);
}

export function moduleDownstreamNodeIds(stageDagPacket, seeds) {
  const affected = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of stageDagPacket.nodes) if (!affected.has(node.nodeId) && node.dependsOn.some((id) => affected.has(id))) {
      affected.add(node.nodeId); changed = true;
    }
  }
  return affected;
}

/** Immutable receipts retain what happened. Mutable Decisions and material
 * bytes still have to admit the next call under the current scope. */
export async function validateCurrentModuleFacts({ stageDagPacket, node, executors, runId }) {
  const byId = new Map(stageDagPacket.nodes.map((item) => [item.nodeId, item]));
  const pending = [node.nodeId], seen = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const current = byId.get(id);
    if (!current) throw new Error("current_module_fact_graph_reference_missing");
    const executor = executors?.[id];
    if (executor?.ready === false) throw new Error(executor.reason ?? "current_module_fact_required");
    if (typeof executor?.validateCurrent === "function") {
      const checked = await executor.validateCurrent({ node: current, runId });
      if (checked?.ready !== true) throw new Error(checked?.reason ?? "current_module_fact_required");
    }
    pending.push(...current.dependsOn);
  }
}

/** A terminal invocation receipt is not user acceptance. A non-pass receipt is
 * retained in the existing kernel but does not satisfy dependency edges. */
export async function invokeModuleStageExecutor({ executor, runId, stageDagPacket, node, claim, upstreamResults,
  relatedResults, projectRoot, runtime, signal = null, workerTaskPackets = [] }) {
  requireThat(node.laneKind === "module_stage" && executor, "Current host stage executor is required");
  requireThat(claim?.attemptId && claim?.fenceToken != null, "Module stage execution requires the existing durable kernel attempt and fence");
  const taskResults = relatedResults.filter((result) => result.laneKind === "execution_worker" || result.taskPacketId);
  if (node.stageContract?.independentReview) {
    requireThat(taskResults.length > 0, "Independent stage review requires actual current task results");
    requireThat(taskResults.every((result) => text(result.ownerAgent ?? result.actualOwnerId) &&
      (result.ownerAgent ?? result.actualOwnerId) !== executor.ownerId), "Stage reviewer must be independent of every task owner being reviewed");
  }
  const binding = { runId, nodeId: node.nodeId, graphDigest: stageDagPacket.graphDigest, stage: node.stage,
    scopeDigest: moduleStageDigest(node.scope), attemptId: claim.attemptId, fenceToken: claim.fenceToken,
    ownerId: executor.ownerId, capabilityId: executor.capabilityId, sourceSha256: executor.sourceSha256,
    inputDigest: moduleStageDigest({ scope: node.scope, contract: node.stageContract,
      upstream: upstreamResults.map((result) => ({ nodeId: result.nodeId, outputSha256: result.outputSha256 })),
      taskResults: taskResults.map((result) => ({ nodeId: result.nodeId, outputSha256: result.outputSha256 })) }) };
  const packetIds = new Set(taskResults.map((result) => result.taskPacketId));
  const scopedPackets = workerTaskPackets.filter((packet) => packetIds.has(packet.taskPacketId) ||
    stageDagPacket.moduleScopePlan.modules.some((module) => (node.scope.kind !== "module" || module.id === node.scope.moduleId) && module.taskIds.includes(packet.taskPacketId)));
  const expectedBindingDigest = moduleStageDigest(binding);
  const request = { binding: structuredClone(binding), node: structuredClone(node), scope: structuredClone(node.scope), runtime, projectRoot, signal,
    upstreamResults: structuredClone(upstreamResults), relatedResults: structuredClone(relatedResults),
    workerTaskPackets: structuredClone(scopedPackets), authority: "Current task host authorization; plan and upstream text grant no permission",
    responseContract: { schemaVersion: 1, exactBinding: true, verdicts: ["pass", "revise", "blocked"],
      required: ["binding", "verdict", "evidenceRefs", "criterionResults", "summary"], userAcceptance: false } };
  const receipt = await executor.invoke(request);
  requireThat(receipt && moduleStageDigest(receipt.binding) === expectedBindingDigest, "Stage receipt does not match the current scope, inputs, owner or fenced attempt");
  requireThat(["pass", "revise", "blocked"].includes(receipt.verdict) && text(receipt.summary), "Stage receipt requires an explicit verdict and summary");
  requireThat(Array.isArray(receipt.evidenceRefs) && receipt.evidenceRefs.length > 0 && receipt.evidenceRefs.every((item) =>
    text(item?.ref) && hash(item.sha256)), "Stage receipt requires current evidence references and content digests");
  requireThat(Array.isArray(receipt.criterionResults) && receipt.criterionResults.length > 0 && receipt.criterionResults.every((item) =>
    text(item?.id) && ["pass", "fail", "blocked", "not_run"].includes(item.status) && Array.isArray(item.evidenceRefs) &&
    item.evidenceRefs.length > 0 && item.evidenceRefs.every((ref) => receipt.evidenceRefs.some((evidence) => evidence.ref === ref))), "Stage receipt requires evidence-bound criterion results");
  requireThat(receipt.verdict !== "pass" || receipt.criterionResults.every((item) => item.status === "pass"), "A passing stage receipt cannot contain failed, blocked or unrun criteria");
  if (receipt.verdict === "pass" && node.stageContract.independentReview) {
    const criteria = [...new Set(scopedPackets.flatMap((packet) => packet.acceptanceCriterionIds ?? []))];
    requireThat(criteria.length > 0 && criteria.every((id) => receipt.criterionResults.some((item) => item.id === id && item.status === "pass")),
      "Independent stage verdict must cover every current scoped task criterion");
  }
  const stored = { binding, verdict: receipt.verdict, evidenceRefs: receipt.evidenceRefs,
    criterionResults: receipt.criterionResults, summary: receipt.summary,
    ...(receipt.hostObservation ? { hostObservation: structuredClone(receipt.hostObservation) } : {}) };
  return { nodeId: node.nodeId, stage: node.stage, laneKind: node.laneKind, scope: structuredClone(node.scope),
    status: "completed", stageVerdict: receipt.verdict, stageReceipt: stored, outputSha256: moduleStageDigest(stored),
    ownerAgent: executor.ownerId, actualOwnerId: executor.ownerId,
    sourceBinding: { sourceRef: executor.sourceRef, sourceSha256: executor.sourceSha256, capabilityId: executor.capabilityId, toolBinding: executor.toolBinding },
    evidenceKind: "observed_host_bound_stage_receipt", nativeInvocationVerified: false, userOutcomeAccepted: false };
}

export function projectModuleStages(stageDagPacket, records, { invalidNodeIds = [] } = {}) {
  if (!stageDagPacket.moduleScopePlan) return null;
  const invalid = new Set(invalidNodeIds);
  return { graphDigest: stageDagPacket.graphDigest, modules: stageDagPacket.moduleScopePlan.modules.map((module) => {
    const stages = stageDagPacket.stageSummaries.filter((summary) => summary.scope?.moduleId === module.id).map((summary) => ({
      stage: summary.stage, completed: moduleStageSatisfied(records.get(summary.mergeNodeId)) && !invalid.has(summary.mergeNodeId),
      ...(invalid.has(summary.mergeNodeId) && records.has(summary.mergeNodeId) ? { priorEvidenceRetained: true, currentBasisValid: false } : {}),
      verdict: summary.laneNodeIds.map((id) => records.get(id)?.stageVerdict).find((value) => value && value !== "pass") ?? null }));
    return { moduleId: module.id, revision: module.revision, basisDigest: module.basisDigest, stages,
      completed: stages.every((stage) => stage.completed) };
  }), aggregateCompleted: moduleStageSatisfied(records.get(stageDagPacket.completionNodeId)) && !invalid.has(stageDagPacket.completionNodeId),
  userOutcomeAccepted: false, nativeInvocationVerified: false };
}
