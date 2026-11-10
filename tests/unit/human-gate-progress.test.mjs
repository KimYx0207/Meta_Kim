import assert from "node:assert/strict";
import test from "node:test";
import { projectHumanGateProgress } from "../../src/domain/scheduling/human-gate-progress.mjs";

const nodes = [
  { nodeId: "a", dependsOn: [] }, { nodeId: "b", dependsOn: [] },
  { nodeId: "c", dependsOn: ["b"] }, { nodeId: "after-a", dependsOn: ["a"] },
  { nodeId: "merge", dependsOn: ["c", "after-a"] },
];
const declarations = [{ request: { nodeId: "a", milestoneId: "scope", artifactVersion: 2 } }];
const project = options => projectHumanGateProgress({ nodes, requiredNodeIds: nodes.map(node => node.nodeId), declarations,
  taskNodeBindings: [{ nodeId: "a", taskPacketId: "module-a" }], ...options });

test("a local human gate leaves an independent chain ready and retains the final join", () => {
  const value = project({ completedNodeIds: ["a", "b"], reviews: [{ nodeId: "a", milestoneId: "scope", accepted: false }] });
  assert.deepEqual(value.independentReadyNodeIds, ["c"]);
  assert.deepEqual(value.blockedNodeIds, ["after-a", "merge"]);
  assert.equal(value.gates[0].state, "awaiting_human");
  assert.equal(value.canFinalizeExecution, false);
  assert.deepEqual(value.taskNodeBindings, [{ nodeId: "a", taskPacketId: "module-a" }]);
  assert.equal(value.executionAllowed, false);
});

test("every required gate and required node must close before execution can finalize", () => {
  const accepted = [{ nodeId: "a", milestoneId: "scope", accepted: true }];
  assert.equal(project({ completedNodeIds: nodes.map(node => node.nodeId), reviews: [] }).canFinalizeExecution, false);
  assert.equal(project({ completedNodeIds: ["a", "b", "c"], reviews: accepted }).canFinalizeExecution, false);
  const complete = project({ completedNodeIds: nodes.map(node => node.nodeId), reviews: accepted });
  assert.equal(complete.canFinalizeExecution, true);
  assert.equal(complete.publicReady, false, "The execution projection does not perform final project verification");
  assert.equal(project({ completedNodeIds: nodes.map(node => node.nodeId), reviews: accepted, waitingNodeIds: ["a"] }).canFinalizeExecution, false);
  assert.equal(project({ completedNodeIds: ["b", "c"], reviews: accepted }).gates[0].state, "awaiting_producer");
});

test("rejection, revision and invalidation identify the same affected branch", () => {
  for (const [reason, decisionState, state] of [
    ["human_milestone_returned", "consumed", "returned"],
    ["human_milestone_revision_required", "consumed", "revision_required"],
    ["human_milestone_changed_evidence_requires_revision", "presented", "revision_required"],
    ["human_milestone_decision_invalidated", "invalidated", "invalidated"],
  ]) {
    const value = project({ completedNodeIds: ["a", "b", "c"], reviews: [{ nodeId: "a", milestoneId: "scope", accepted: false, reason, decisionState }] });
    assert.equal(value.gates[0].state, state);
    assert.deepEqual(value.blockedNodeIds, ["after-a", "merge"]);
    assert.deepEqual(value.completedRequiredNodeIds, ["a", "b", "c"]);
    assert.equal(value.canFinalizeExecution, false);
  }
});

test("the display projection rejects nodes and task bindings outside the current graph", () => {
  assert.throws(() => project({ runningNodeIds: ["outside"] }), /unknown node/);
  assert.throws(() => project({ taskNodeBindings: [{ nodeId: "outside", taskPacketId: "a" }] }), /current required node/);
});
