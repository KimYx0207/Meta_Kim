import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { inspectTrustedPath } from "../safe-managed-file-operations.mjs";
import { verifyTaskDesignContext } from "./product-design.mjs";
import { buildMethodDeliveryEnvelope } from "./method-delivery.mjs";
import { invokeModuleStageExecutor, resolveModuleStageExecutor, moduleStageDigest } from "./module-stage-execution.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

/** Reuse is a fresh, fenced review of current bytes. Historical completion is
 * provenance only and can never be copied into the new run. A rejected reuse
 * returns to the task's ordinary, independently authorized execution path. */
export async function revalidateModuleTaskArtifact({ design, packet, node, stageDagPacket, runId, kernel, claim,
  stageExecutors, projectRoot, runtime, upstreamResults = [], signal = null }) {
  const taskId = packet?.designBinding?.sliceId ?? packet?.taskPacketId;
  const candidate = design?.revisionImpact?.reuseCandidates?.find((item) => (item.taskId ?? item.previousTaskId) === taskId);
  if (!candidate) return { status: "not_requested" };
  const impact = design.revisionImpact;
  const eventBinding = { runId, nodeId: node.nodeId, attemptId: claim.attemptId, fenceToken: claim.fenceToken,
    graphDigest: stageDagPacket.graphDigest, candidateDigest: moduleStageDigest(candidate) };
  const recordAssessment = (status, reason, receipt = null) => kernel.appendEvent({ runId,
    eventId: `artifact-reuse:${moduleStageDigest({ ...eventBinding, status })}`, eventType: "ArtifactReuseAssessed",
    payload: { ...eventBinding, status, reason, ...(receipt ? { receipt } : {}) } });
  try {
    requireThat(!packet.hostOperation && packet.externalWriteBoundary !== true && packet.executionMode !== "approval_gate",
      "reuse_cannot_replace_host_operations_or_external_side_effects");
    requireThat(impact.status === "new_run_required" && candidate.status === "requires_current_binding_and_review" &&
      impact.previousRunId && impact.previousRunId !== runId &&
      !impact.affectedTaskIds?.includes(taskId), "reuse_candidate_is_not_current_unaffected_work");
    requireThat(packet.designBinding?.designDigest === design.designDigest && packet.designBinding?.revision === design.revision,
      "reuse_requires_current_task_design_binding");
    const oldRun = kernel.projectRun(impact.previousRunId);
    const oldTaskId = candidate.previousTaskPacketId ?? `${impact.previousRunId}-design-${taskId}`;
    const prior = oldRun.completedNodes.map((entry) => entry.output).find((output) => output?.taskPacketId === oldTaskId);
    requireThat(prior?.status === "completed" && (prior.designBinding?.designDigest ?? prior.deliveryEnvelope?.designDigest) === design.revisionContext?.previousDesignDigest,
      "reuse_original_task_and_design_are_not_observed");
    const priorArtifact = prior.deliveryEnvelope?.reportedArtifactRefs?.find((item) => item.ref === candidate.artifactRef && item.sha256 === candidate.sha256) ??
      prior.artifactRefs?.find((item) => item.ref === candidate.artifactRef && item.sha256 === candidate.sha256);
    requireThat(priorArtifact, "reuse_artifact_is_not_bound_to_the_original_task");
    const checked = inspectTrustedPath(projectRoot, candidate.artifactRef);
    requireThat(checked, "reuse_artifact_outside_current_project_or_missing");
    const stat = await fs.stat(checked.target);
    requireThat(stat.isFile() && stat.size <= 8 * 1024 * 1024, "reuse_artifact_not_a_bounded_regular_file");
    const bytes = await fs.readFile(checked.target);
    requireThat(sha(bytes) === candidate.sha256, "reuse_artifact_bytes_changed");
    await verifyTaskDesignContext({ packet, projectRoot, upstreamResults });
    const reviewNode = { ...node, stage: "Verification", laneKind: "module_stage",
      stageContract: { purpose: "artifact_reuse_verification", receiptVersion: 1, independentReview: true } };
    const executor = resolveModuleStageExecutor(stageExecutors, reviewNode);
    requireThat(executor, "reuse_requires_current_independent_verification_executor");
    const artifact = { ref: candidate.artifactRef, sha256: candidate.sha256, bytes: bytes.length };
    const observed = { nodeId: node.nodeId, taskPacketId: packet.taskPacketId, ownerAgent: packet.ownerAgent ?? packet.owner,
      laneKind: "execution_worker", status: "completed", outputSha256: artifact.sha256, outputText: bytes.toString("utf8"),
      artifactRefs: [artifact], evidenceKind: "observed_current_candidate_bytes", previousRunId: impact.previousRunId,
      previousTaskPacketId: oldTaskId, previousAttemptId: prior.attemptId ?? prior.stageReceipt?.binding.attemptId ?? null };
    const reviewed = await invokeModuleStageExecutor({ executor, runId, stageDagPacket, node: reviewNode, claim,
      upstreamResults, relatedResults: [observed], projectRoot, runtime, signal, workerTaskPackets: [packet] });
    requireThat(reviewed.stageVerdict === "pass", `reuse_review_${reviewed.stageVerdict}`);
    requireThat(sha(await fs.readFile(checked.target)) === candidate.sha256, "reuse_artifact_changed_during_review");
    await verifyTaskDesignContext({ packet, projectRoot, upstreamResults });
    recordAssessment("revalidated", null, reviewed.stageReceipt);
    const outputText = JSON.stringify({ status: "revalidated_artifact", artifactRefs: [artifact],
      criterionResults: reviewed.stageReceipt.criterionResults.map((item) => ({ ...item, scope: "current task artifact reuse" })) });
    return { status: "reused", result: { nodeId: node.nodeId, stage: node.stage, laneKind: "execution_worker", scope: node.scope,
      taskPacketId: packet.taskPacketId, ownerAgent: packet.ownerAgent ?? packet.owner, designBinding: packet.designBinding,
      attemptId: claim.attemptId, status: "completed", evidenceKind: "current_revalidated_artifact_reuse",
      reusedArtifact: { ...artifact, content: bytes.toString("utf8"), previousRunId: impact.previousRunId, previousTaskPacketId: oldTaskId },
      reuseReview: reviewed.stageReceipt, outputText, outputTextComplete: true, outputSha256: sha(outputText),
      deliveryEnvelope: buildMethodDeliveryEnvelope({ runId, packet, outputText, evidenceKind: "current_revalidated_artifact_reuse" }),
      nativeInvocationVerified: false, userOutcomeAccepted: false } };
  } catch (error) {
    recordAssessment("fallback_to_current_task", error.message);
    return { status: "fallback", reason: error.message };
  }
}
