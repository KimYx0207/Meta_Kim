/** Read model only. Private kernel/task/artifact identities stay behind the
 * existing public-node resolver; this projection never authorizes a reply. */
const SCHEMA = "meta-kim-live-human-gates-v1";
const STATES = new Set(["accepted", "awaiting_producer", "awaiting_human", "invalidated", "revision_required", "returned"]);
const ids = value => Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0)
  ? [...new Set(value)] : null;
const count = (value, ceiling) => Number.isSafeInteger(value) && value >= 0 && value <= ceiling ? value : null;

export function buildLiveHumanGateProjection({ progress, runId, stageNodes, resolveNodeId, limit }) {
  if (!progress || progress.schemaVersion !== "human-gate-progress-v1" || !Array.isArray(progress.gates)
    || !Array.isArray(stageNodes) || !Number.isSafeInteger(limit) || limit < 1
    || progress.gates.length > limit || typeof resolveNodeId !== "function") return null;
  const known = new Set(stageNodes.map(node => node?.nodeId).filter(Boolean));
  const bindings = new Map((Array.isArray(progress.taskNodeBindings) ? progress.taskNodeBindings : []).slice(0, limit).filter(binding => known.has(binding?.nodeId)
    && typeof binding.taskPacketId === "string").map(binding => [binding.nodeId, resolveNodeId(binding.taskPacketId)]));
  const mapNode = id => bindings.get(id) || null;
  const fields = ["requiredNodeIds", "completedRequiredNodeIds", "blockedNodeIds", "independentRunningNodeIds", "independentReadyNodeIds"];
  const sets = {};
  for (const field of fields) {
    const value = ids(progress[field]);
    if (!value || value.length > limit || value.some(id => !known.has(id))) return null;
    sets[field] = value;
  }
  const required = new Set(sets.requiredNodeIds);
  if (fields.slice(1).some(field => sets[field].some(id => !required.has(id)))) return null;
  const gates = [];
  for (const gate of progress.gates) {
    if (!known.has(gate?.nodeId) || !STATES.has(gate.state)) return null;
    const accepted = gate.state === "accepted" && gate.accepted === true;
    gates.push({ nodeId: mapNode(gate.nodeId), state: accepted ? "accepted"
      : gate.state === "accepted" ? "awaiting_human" : gate.state });
  }
  return {
    schemaVersion: SCHEMA, runId, provenance: "recorded", gates,
    pendingGateCount: gates.filter(gate => gate.state !== "accepted").length,
    requiredTaskCount: required.size, completedTaskCount: sets.completedRequiredNodeIds.length,
    blockedTaskCount: sets.blockedNodeIds.length,
    independentRunningCount: sets.independentRunningNodeIds.length,
    independentReadyCount: sets.independentReadyNodeIds.length,
    blockedNodeIds: sets.blockedNodeIds.map(mapNode).filter(Boolean),
    unmappedGateCount: gates.filter(gate => !gate.nodeId).length,
    executionAllowed: false, publicReady: false,
  };
}

export function sanitizeLiveHumanGateProjection(value, { runId, knownNodeIds, limit }) {
  if (!value || value.schemaVersion !== SCHEMA || value.runId !== runId || value.provenance !== "recorded"
    || !Number.isSafeInteger(limit) || limit < 1 || !Array.isArray(value.gates) || value.gates.length > limit) return null;
  const gates = [];
  for (const gate of value.gates) {
    if (!STATES.has(gate?.state)) return null;
    gates.push({ nodeId: knownNodeIds.has(gate.nodeId) ? gate.nodeId : null, state: gate.state });
  }
  const counts = {};
  for (const field of ["requiredTaskCount", "completedTaskCount", "blockedTaskCount", "independentRunningCount", "independentReadyCount"]) {
    counts[field] = count(value[field], limit);
    if (counts[field] === null) return null;
  }
  if (Object.values(counts).some(value => value > counts.requiredTaskCount)) return null;
  return { schemaVersion: SCHEMA, runId, provenance: "recorded", gates, ...counts,
    pendingGateCount: gates.filter(gate => gate.state !== "accepted").length,
    blockedNodeIds: (ids(value.blockedNodeIds) ?? []).filter(id => knownNodeIds.has(id)).slice(0, limit),
    unmappedGateCount: gates.filter(gate => !gate.nodeId).length,
    executionAllowed: false, publicReady: false };
}
