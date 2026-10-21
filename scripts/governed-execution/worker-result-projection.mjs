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
    return [[result.taskPacketId, result]];
  }));
  return plannedResults.map((planned) => {
    const observed = results.get(planned.taskPacketId);
    return observed ? { ...planned, ...observed } : planned;
  });
}
