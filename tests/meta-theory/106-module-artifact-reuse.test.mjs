import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildStageDagPacket, stageLaneNodeId } from "../../scripts/governed-execution/stage-dag.mjs";
import { runStageRunnerBridge } from "../../scripts/governed-execution/stage-runner-bridge.mjs";
import { openDurableRunKernel } from "../../scripts/governed-execution/durable-run-kernel.mjs";
import { buildMethodDeliveryEnvelope } from "../../scripts/governed-execution/method-delivery.mjs";
import { productDesignDigest } from "../../scripts/governed-execution/product-design.mjs";
import { readOnlyWorkerPacket } from "../helpers/read-only-worker-packet.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
async function fixture(t, { affected = false, selfReview = false, changeBytes = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "meta-module-reuse-"));
  const kernel = await openDurableRunKernel(path.join(root, "runs.sqlite"));
  t.after(async () => { kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  const previousRunId = "old-modules", runId = "current-modules", previousDigest = sha("old-design"), designDigest = sha("new-design");
  const content = "export const unchanged = 1;\n", artifactRef = "unchanged.mjs";
  await fs.writeFile(path.join(root, artifactRef), changeBytes ? "changed" : content);
  const packets = ["a", "b"].map((id) => {
    const taskPacketId = `${runId}-design-${id}`;
    const context = { taskPacketId, designDigest, designId: "design", revision: 2, sliceId: id, sourceBindings: [] };
    const digest = productDesignDigest(context);
    return readOnlyWorkerPacket({ taskPacketId, ownerAgent: `author:${id}`, description: `Produce ${id}`, dependsOn: [],
      externalWriteBoundary: false, acceptanceCriterionIds: [`criterion:${id}`],
      designBinding: { designId: "design", designDigest, revision: 2, sliceId: id, contextDigest: digest },
      designContext: { ...context, digest, authority: "Fixture single design" } });
  });
  const scopePlan = { schemaVersion: 1, architecture: { id: "arch", revision: 1, basisDigest: sha("arch") },
    modules: ["a", "b"].map((id, i) => ({ id, revision: id === "a" ? 1 : 2, basisDigest: sha(id), taskIds: [packets[i].taskPacketId], dependsOn: [] })) };
  const dag = buildStageDagPacket({ moduleScopePlan: scopePlan, runtimeCapacity: 2, stageLanes: { Execution: packets.map((packet) => ({
    laneId: packet.taskPacketId, laneKind: "execution_worker", ownerBindingRef: packet.ownerAgent, capabilityBindingRef: "fixture:author",
    effectClass: "read_only_worker", resourceScopes: [`file:${artifactRef}`], isolation: "shared_read_only" })) } });
  const oldPacket = { ...packets[0], taskPacketId: `${previousRunId}-design-a`, designBinding: { ...packets[0].designBinding, designDigest: previousDigest, revision: 1 } };
  kernel.createRun({ runId: previousRunId, graphDigest: sha("previous-graph"), taskFingerprint: "previous-task" });
  const oldClaim = kernel.claimNode({ runId: previousRunId, nodeId: stageLaneNodeId("Execution", oldPacket.taskPacketId), ownerId: "old-host",
    nodeDefinitionHash: sha("old-node"), inputHash: sha("old-input"), dependencyOutputHash: sha("old-deps"), leaseMs: 30_000 });
  const oldOutput = JSON.stringify({ artifactRefs: [{ ref: artifactRef, sha256: sha(content) }] });
  kernel.completeNode({ ...oldClaim, runId: previousRunId, nodeId: stageLaneNodeId("Execution", oldPacket.taskPacketId), ownerId: "old-host",
    output: { nodeId: stageLaneNodeId("Execution", oldPacket.taskPacketId), status: "completed", taskPacketId: oldPacket.taskPacketId,
      ownerAgent: oldPacket.ownerAgent, designBinding: oldPacket.designBinding, outputText: oldOutput, outputSha256: sha(oldOutput),
      deliveryEnvelope: buildMethodDeliveryEnvelope({ runId: previousRunId, packet: oldPacket, outputText: oldOutput }) } });
  const design = { designDigest, revision: 2, revisionContext: { previousRunId, previousDesignDigest: previousDigest },
    revisionImpact: { status: "new_run_required", previousRunId, affectedTaskIds: affected ? ["a", "b"] : ["b"],
      reuseCandidates: [{ taskId: "a", artifactRef, sha256: sha(content), reason: "Independent of B", status: "requires_current_binding_and_review" }] } };
  const stageCalls = [], authorCalls = [];
  const stageExecutors = Object.fromEntries(["Critical", "Fetch", "Thinking", "Review", "Meta-Review", "Verification", "Evolution"].map((stage) => [stage, {
    ownerId: selfReview && stage === "Verification" ? "author:a" : `reviewer:${stage}`, capabilityId: `fixture:${stage}`,
    sourceRef: `fixture:method:${stage}`, sourceSha256: sha(stage), toolBinding: "fixture:local-inspection", invoke: async (request) => {
      stageCalls.push({ node: request.node.nodeId, purpose: request.node.stageContract.purpose, binding: request.binding });
      const ref = `fixture:evidence:${request.node.nodeId}`;
      return { binding: request.binding, verdict: "pass", summary: "Current fixture artifact independently inspected",
        evidenceRefs: [{ ref, sha256: sha(ref) }], criterionResults: [...new Set([`stage:${stage}`, ...request.workerTaskPackets.flatMap((packet) => packet.acceptanceCriterionIds)])]
          .map((id) => ({ id, status: "pass", evidenceRefs: [ref] })) };
    },
  }]));
  const result = await runStageRunnerBridge({ runId, runtime: "claude", stageDagPacket: dag, workerTaskPackets: packets,
    workspaceRoot: root, evidenceKind: "synthetic_transport", stageExecutors, design,
    durable: { enabled: true, kernel, mode: "create", taskFingerprint: "current-task" },
    invokeWorker: async ({ packet }) => { authorCalls.push(packet.taskPacketId); const outputText = packet.taskPacketId;
      return { status: "pass", durationMs: 1, outputText, outputSha256: sha(outputText) }; } });
  return { result, kernel, authorCalls, stageCalls, runId, packets, dag, root, content, artifactRef };
}

test("new graph revalidates unaffected A bytes under a fresh attempt while only B invokes its original worker", async (t) => {
  const f = await fixture(t);
  assert.equal(f.result.status, "pass", JSON.stringify(f.result.failure));
  assert.deepEqual(f.authorCalls, [f.packets[1].taskPacketId]);
  const reused = f.result.workerResults.find((result) => result.taskPacketId === f.packets[0].taskPacketId);
  assert.equal(reused.evidenceKind, "current_revalidated_artifact_reuse");
  assert.equal(reused.reuseReview.binding.runId, f.runId);
  assert.equal(reused.reuseReview.binding.graphDigest, f.dag.graphDigest);
  assert.equal(reused.reuseReview.binding.attemptId, reused.attemptId);
  assert.equal(reused.nativeInvocationVerified, false);
  assert.equal(await fs.readFile(path.join(f.root, f.artifactRef), "utf8"), f.content);
  assert.ok(f.kernel.getEvents(f.runId).some((event) => event.eventType === "ArtifactReuseAssessed" && event.payload.status === "revalidated"));
});

for (const [label, option, reason] of [["changed bytes", { changeBytes: true }, "reuse_artifact_bytes_changed"],
  ["affected task", { affected: true }, "reuse_candidate_is_not_current_unaffected_work"],
  ["self review", { selfReview: true }, "Stage reviewer must be independent"]]) {
  test(`rejected reuse (${label}) returns only that task to ordinary current execution`, async (t) => {
    const f = await fixture(t, option);
    assert.deepEqual([...f.authorCalls].sort(), f.packets.map((packet) => packet.taskPacketId).sort());
    const fallback = f.kernel.getEvents(f.runId).find((event) => event.eventType === "ArtifactReuseAssessed");
    assert.equal(fallback.payload.status, "fallback_to_current_task");
    assert.ok(fallback.payload.reason.includes(reason), fallback.payload.reason);
    assert.equal(f.result.workerResults.find((result) => result.taskPacketId === f.packets[0].taskPacketId).evidenceKind, "synthetic_transport");
  });
}
