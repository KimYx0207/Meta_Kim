/** Read-only projection of the existing graph, committed outputs and reviewed
 * human milestones. This is neither a queue nor an answer/permission authority. */
export function dependentNodeClosure(nodes, rootNodeId) {
  const children = new Map(nodes.map(node => [node.nodeId, []]));
  for (const node of nodes) for (const dependency of node.dependsOn) children.get(dependency)?.push(node.nodeId);
  const ids = new Set([rootNodeId]);
  const queue = [rootNodeId];
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]) ?? []) if (!ids.has(child)) {
      ids.add(child); queue.push(child);
    }
  }
  return nodes.filter(node => node.nodeId !== rootNodeId && ids.has(node.nodeId)).map(node => node.nodeId);
}

export function projectHumanGateProgress({ nodes, requiredNodeIds, completedNodeIds = [], runningNodeIds = [],
  waitingNodeIds = [], declarations = [], reviews = [], taskNodeBindings = [] }) {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const required = new Set(requiredNodeIds);
  const completed = new Set(completedNodeIds);
  const running = new Set(runningNodeIds);
  const waiting = new Set(waitingNodeIds);
  const descendants = id => dependentNodeClosure(nodes, id);
  for (const nodeId of [...required, ...completed, ...running, ...waiting]) {
    if (!byId.has(nodeId)) throw new TypeError(`Human gate projection references an unknown node: ${nodeId}`);
  }
  const gates = declarations.map(({ request }) => {
    if (!byId.has(request.nodeId)) throw new TypeError("Human gate must bind the current graph");
    const review = reviews.find(item => item.nodeId === request.nodeId && item.milestoneId === request.milestoneId);
    const accepted = completed.has(request.nodeId) && review?.accepted === true;
    const state = accepted ? "accepted" : !completed.has(request.nodeId) ? "awaiting_producer"
      : review?.decisionState === "invalidated" ? "invalidated"
      : ["human_milestone_revision_required", "human_milestone_changed_evidence_requires_revision"].includes(review?.reason) ? "revision_required"
      : review?.reason === "human_milestone_returned" ? "returned" : "awaiting_human";
    return { nodeId: request.nodeId, milestoneId: request.milestoneId, flowId: request.flowId ?? null,
      artifactRef: request.artifactRef ?? null, artifactVersion: request.artifactVersion ?? null,
      state, accepted, reason: review?.reason ?? "reviewable_producer_required",
      bindingDigest: review?.bindingDigest ?? null, decisionId: review?.decisionId ?? null,
      decisionRevision: review?.revision ?? null,
      blockedNodeIds: accepted ? [] : descendants(request.nodeId).filter(id => required.has(id)),
      executionAllowed: false };
  });
  const blocked = new Set(gates.filter(gate => !gate.accepted).flatMap(gate => gate.blockedNodeIds));
  for (const id of waiting) { blocked.add(id); for (const child of descendants(id)) blocked.add(child); }
  const uncompletedRequiredNodeIds = [...required].filter(id => !completed.has(id));
  const pendingGates = gates.filter(gate => !gate.accepted);
  for (const binding of taskNodeBindings) if (!required.has(binding.nodeId) || typeof binding.taskPacketId !== "string" || !binding.taskPacketId) {
    throw new TypeError("Human gate task binding must name a current required node and task");
  }
  return {
    schemaVersion: "human-gate-progress-v1", evidenceKind: "current_graph_and_committed_run_projection",
    gates, taskNodeBindings: taskNodeBindings.map(({ nodeId, taskPacketId }) => ({ nodeId, taskPacketId })),
    requiredNodeIds: [...required], completedRequiredNodeIds: [...required].filter(id => completed.has(id)),
    uncompletedRequiredNodeIds, blockedNodeIds: [...blocked].filter(id => required.has(id)),
    independentRunningNodeIds: [...running].filter(id => required.has(id) && !blocked.has(id)),
    independentReadyNodeIds: [...required].filter(id => !completed.has(id) && !running.has(id) && !blocked.has(id) &&
      byId.get(id).dependsOn.every(dependency => completed.has(dependency) && !waiting.has(dependency))),
    pendingGateCount: pendingGates.length,
    canFinalizeExecution: uncompletedRequiredNodeIds.length === 0 && pendingGates.length === 0 && waiting.size === 0,
    executionAllowed: false, publicReady: false,
  };
}
