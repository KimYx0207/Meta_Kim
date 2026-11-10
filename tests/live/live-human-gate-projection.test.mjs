import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveCompactProjection, buildLiveSnapshot } from "../../src/application/live/live-control-room-service.mjs";
import { buildLiveHumanGateProjection, sanitizeLiveHumanGateProjection } from "../../src/application/live/live-human-gate-projection.mjs";
import { resolveLiveRunTaskLifecycle, resolveLiveNodeTaskLifecycle, liveTaskLifecycleCopy, serializeLiveRunOverviewResolvers } from "../../src/presentation/live/live-run-overview.mjs";

const runId = "human-gate-view-run";
const nodes = ["a", "b", "c"].map(id => ({ nodeId: `kernel-${id}`, dependsOn: id === "c" ? ["kernel-a"] : [] }));
function progress() {
  return { schemaVersion: "human-gate-progress-v1", requiredNodeIds: nodes.map(node => node.nodeId),
    completedRequiredNodeIds: ["kernel-a"], blockedNodeIds: ["kernel-c"], independentRunningNodeIds: ["kernel-b"], independentReadyNodeIds: [],
    taskNodeBindings: nodes.map((node, i) => ({ nodeId: node.nodeId, taskPacketId: `task-${i}` })),
    gates: [{ nodeId: "kernel-a", state: "awaiting_human", accepted: false,
      artifactRef: "C:/Users/private-client/pricing.pdf", milestoneId: "private financial decision", decisionId: "private-decision" }],
    publicReady: true, executionAllowed: true, pendingGateCount: 0 };
}
function publicProgress() {
  return buildLiveHumanGateProjection({ progress: progress(), runId, stageNodes: nodes, limit: 128, resolveNodeId: id => `public-${id}` });
}

test("current human gates survive actual compact projection and readback without private identities or authority", () => {
  const artifact = { schemaVersion: "governed-execution-v1", runId, status: "in_progress", updatedAt: "2026-11-10T10:00:00Z",
    workerTaskPackets: nodes.map((_, i) => ({ taskPacketId: `task-${i}`, ownerAgent: "frontend-developer", roleDisplayName: "frontend",
      roleInstanceId: `worker-${i}`, stage: "execution", task: `Module ${i}`, dependsOn: [], capabilityBindings: {} })),
    coreLoop: { stageDagPacket: { nodes } }, machineExecution: { humanGateProgress: progress() } };
  const compact = buildLiveCompactProjection(artifact);
  assert.equal(compact.humanGates.pendingGateCount, 1);
  assert.equal(compact.humanGates.independentRunningCount, 1);
  assert.ok(compact.nodes.some(node => node.id === compact.humanGates.gates[0].nodeId));
  for (const source of [artifact, JSON.parse(JSON.stringify(compact))]) {
    const snapshot = buildLiveSnapshot({ governedArtifact: source, observedAt: "2026-11-10T10:00:01Z" });
    assert.equal(snapshot.humanGates.pendingGateCount, 1);
    assert.equal(snapshot.humanGates.executionAllowed, false);
    assert.equal(snapshot.humanGates.publicReady, false);
    assert.doesNotMatch(JSON.stringify(snapshot.humanGates), /private|kernel-|artifactRef|milestoneId|decisionId/);
  }
});

test("waiting A stays unfinished while B retains its completed result in both server and shipped browser selectors", () => {
  const snapshot = { run: { id: runId, status: "completed", executionEvidenceState: "recorded" }, humanGates: publicProgress(),
    nodes: [0, 1].map(i => ({ id: `public-task-${i}`, runId, kind: "worker", status: "completed", displayState: "completed" })) };
  for (const select of [resolveLiveRunTaskLifecycle, new Function(serializeLiveRunOverviewResolvers() + "; return resolveLiveRunTaskLifecycle;")()]) {
    const lifecycle = select(snapshot);
    assert.equal(lifecycle.state, "in_progress");
    assert.equal(lifecycle.detail, "human_acceptance_pending");
    assert.match(liveTaskLifecycleCopy(lifecycle).detail, /记录时 1 项独立工作执行中/);
    assert.equal(select({ ...snapshot, humanGates: { ...snapshot.humanGates, runId: "old-run" } }).state, "completed");
  }
  assert.equal(resolveLiveNodeTaskLifecycle(snapshot.nodes[0], snapshot).detail, "human_acceptance_pending");
  assert.equal(resolveLiveNodeTaskLifecycle(snapshot.nodes[1], snapshot).state, "completed");
});

test("malformed or unrelated gate summaries cannot hide required acceptance or expose foreign node IDs", () => {
  const input = progress();
  const build = value => buildLiveHumanGateProjection({ progress: value, runId, stageNodes: nodes, limit: 128, resolveNodeId: id => `public-${id}` });
  assert.equal(build({ ...input, requiredNodeIds: ["unknown"] }), null);
  assert.equal(build({ ...input, gates: [{ ...input.gates[0], state: "complete-and-authorized" }] }), null);
  assert.equal(build({ ...input, gates: [{ ...input.gates[0], state: "accepted", accepted: false }] }).pendingGateCount, 1);
  const safe = sanitizeLiveHumanGateProjection({ ...publicProgress(), executionAllowed: true, publicReady: true },
    { runId, knownNodeIds: new Set(), limit: 128 });
  assert.equal(safe.pendingGateCount, 1);
  assert.equal(safe.gates[0].nodeId, null);
  assert.equal(safe.unmappedGateCount, 1);
  assert.equal(safe.executionAllowed, false);
  assert.equal(sanitizeLiveHumanGateProjection({ ...safe, completedTaskCount: 900 }, { runId, knownNodeIds: new Set(), limit: 128 }), null);
});
