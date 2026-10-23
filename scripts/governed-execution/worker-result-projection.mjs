import { methodDeliveryMatches } from "./method-delivery.mjs";
import { stageLaneNodeId } from "./stage-dag.mjs";

/** Read-only task-board notification from an existing committed kernel event.
 * The caller must obtain events from the current kernel, not an input receipt.
 * This maps identities/labels only; it grants no invocation or acceptance. */
export function projectWorkerProgressEvent({ runId, stageDagPacket, workerTaskPackets = [], event, events = [], evidenceKind }) {
  if (event?.runId !== runId || !Number.isInteger(event.eventSeq) || event.eventSeq < 1 ||
      typeof event.eventId !== "string" || !["NodeAttemptClaimed", "NodeAttemptCompleted", "NodeAttemptFailed", "NodeAttemptInDoubt"].includes(event.eventType)) return null;
  const nodes = Array.isArray(stageDagPacket?.nodes) ? stageDagPacket.nodes : [];
  const node = nodes.find((item) => item.nodeId === event.nodeId && item.stage === "Execution" && item.laneKind === "execution_worker");
  const packet = node && (Array.isArray(workerTaskPackets) ? workerTaskPackets : []).find((item) => node.nodeId === stageLaneNodeId("Execution", item.taskPacketId));
  if (!packet) return null;
  const label = String(packet.todayTask || packet.purpose || packet.task || packet.description || packet.roleDisplayName || packet.taskPacketId)
    .replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").slice(0, 140);
  const states = new Map();
  for (const prior of [...(Array.isArray(events) ? events : []), event]) {
    if (prior.runId === runId && Number.isInteger(prior.eventSeq) && prior.eventSeq <= event.eventSeq &&
        prior.eventSeq > (states.get(prior.nodeId)?.eventSeq ?? 0) &&
        ["NodeAttemptClaimed", "NodeAttemptCompleted", "NodeAttemptFailed", "NodeAttemptInDoubt"].includes(prior.eventType)) {
      states.set(prior.nodeId, prior);
    }
  }
  const workers = nodes.filter((item) => item.stage === "Execution" && item.laneKind === "execution_worker");
  return {
    eventKind: "durable_task_event", eventId: event.eventId, eventSeq: event.eventSeq,
    runId, graphDigest: stageDagPacket.graphDigest, eventType: event.eventType,
    nodeId: node.nodeId, taskPacketId: packet.taskPacketId, taskLabel: label,
    roleDisplayName: packet.roleDisplayName || null, owner: packet.ownerAgent || packet.owner || null,
    occurredAt: event.createdAt, evidenceKind, source: "durable_run_kernel",
    activeTaskCount: workers.filter((item) => states.get(item.nodeId)?.eventType === "NodeAttemptClaimed").length,
    waitingTaskCount: workers.filter((item) => !states.has(item.nodeId) && (item.dependsOn ?? []).some((dependency) =>
      nodes.some((candidate) => candidate.nodeId === dependency && candidate.stage === "Execution") &&
      states.get(dependency)?.eventType !== "NodeAttemptCompleted")).length,
  };
}

/**
 * Keep the planner's public task board and the observed execution result on the
 * same identity. A result from another run, task, or owner cannot replace a plan.
 * This copies execution evidence; it never turns an executed turn into acceptance.
 */
export function projectWorkflowWorkerResults({ runId, workerTaskPackets, plannedResults, executionResults }) {
  const packets = new Map(workerTaskPackets.map((packet) => [packet.taskPacketId, packet]));
  const results = new Map((executionResults ?? []).flatMap((result) => {
    const packet = packets.get(result?.taskPacketId);
    if (!packet || result.runId !== runId ||
      (result.ownerAgent ?? result.owner) !== (packet.ownerAgent ?? packet.owner) ||
      !["native_read_only_worker_result", "actual_local_tool_worker_result"].includes(result.resultKind)) return [];
    if (result.output?.deliveryEnvelope && !methodDeliveryMatches({ envelope: result.output.deliveryEnvelope,
      runId, packet, outputText: result.output.text })) return [];
    return [[result.taskPacketId, result]];
  }));
  return plannedResults.map((planned) => {
    const observed = results.get(planned.taskPacketId);
    return observed ? { ...planned, ...observed } : planned;
  });
}
