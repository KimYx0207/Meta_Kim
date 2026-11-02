import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { selectMaximalSafeReadySet, stageLaneNodeId } from "./stage-dag.mjs";
import { buildReadOnlyWorkerPrompt, readObservedMachineResult } from "./stage-runner-bridge.mjs";
import { loadDependencyAgentMethod } from "../dependency-agent-discovery.mjs";
import { evaluateTaskOutcome } from "../../src/domain/governance/task-outcome.mjs";
import { inspectTrustedPath, executeSafeManagedFileTransaction, normalizeManagedRelPath } from "../safe-managed-file-operations.mjs";
import { restoreHumanMilestoneDeclarations, resolveHumanMilestoneReviews } from "./plan-challenge-host-continuation.mjs";
import { readEvaluatedOutcomeReview } from "./product-design.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => sha(JSON.stringify(value));
const beforeImplementationMilestones = new Set(JSON.parse(readFileSync(new URL("../../config/contracts/workflow-contract.json", import.meta.url), "utf8"))
  .protocols.preDecisionOptionFrame.humanMilestonePolicy.milestones.filter((rule) => rule.beforeImplementation).map((rule) => rule.id));

/** Consume an existing governed DAG. Host functions, never plan fields, admit calls. */
export async function advanceGovernedGoal({
  runId, goalContract, stageDagPacket, workerTaskPackets, projectRoot, artifactRoot,
  runtime, host, kernel, taskFingerprint, observations = [], env = process.env, humanMilestones = [], thinkingGaps = [], design = null, outcomeReview = null,
}) {
  const calls = [];
  let humanMilestoneReviews = [];
  let activeThinkingGaps = [];
  let revisionNextAction = null;
  const finish = (status, reason, outcome = null) => ({ runId, status, reason, runtime, calls,
    outcome, humanMilestoneReviews, thinkingGaps: activeThinkingGaps, ...(revisionNextAction ? { nextAction: revisionNextAction } : {}), publicReady: false, userOutcomeAccepted: false });
  if (typeof host?.authorize !== "function" || typeof host?.adapterRegistry?.invoke !== "function") {
    return finish("blocked", "current_host_execution_adapter_required");
  }
  let admission = await host.authorize({ runId, taskPacket: null, calls: [] });
  if (admission.status !== "ready") return finish(admission.status, admission.reason);
  const review = readEvaluatedOutcomeReview(outcomeReview);
  if (review && (review.runId !== runId || review.outcomeEvaluation.taskHash !== goalContract.taskHash ||
      review.outcomeEvaluation.acceptanceDigest !== goalContract.acceptanceDigest ||
      (review.outcomeEvaluation.intentDigest ?? null) !== (goalContract.intentBinding?.status === "host_provided_understanding" ? goalContract.intentBinding.intentDigest : null) ||
      review.designDigest !== (design?.designDigest ?? null))) {
    throw new TypeError("Outcome revision must match the current run, goal, criteria and design");
  }
  let revisions = (review?.revisionRequests ?? []).map((request) => ({ ...request, reviewDigest: review.reviewDigest, reviewRef: review.reviewRef,
    artifacts: review.artifactSnapshots.filter((snapshot) => request.artifactRefs.includes(snapshot.ref)) }));
  let outcome = review?.outcomeEvaluation ?? evaluateTaskOutcome(goalContract, observations);
  if (!kernel) return outcome.status === "pass" && !humanMilestones.length && !thinkingGaps.length && !revisions.length
    ? finish("completed", "parent_criteria_reported_passed", outcome) : finish("blocked", "existing_durable_kernel_required", outcome);
  const receiver = await import("./method-delivery.mjs");
  if (typeof receiver.decodeMachineMethodResult !== "function") return finish("blocked", "machine_result_receiver_required", outcome);
  const root = path.resolve(projectRoot);
  const ownedRoot = path.resolve(artifactRoot);
  await fs.mkdir(ownedRoot, { recursive: true });
  let resume;
  try { resume = kernel.resumeRun({ runId, graphDigest: stageDagPacket.graphDigest, taskFingerprint }); }
  catch (error) {
    if (!/Unknown governed run/u.test(error.message)) throw error;
    if (outcome.status === "pass" && !humanMilestones.length && !thinkingGaps.length && !revisions.length) return finish("completed", "parent_criteria_reported_passed", outcome);
    kernel.createRun({ runId, graphDigest: stageDagPacket.graphDigest, taskFingerprint });
    resume = kernel.resumeRun({ runId, graphDigest: stageDagPacket.graphDigest, taskFingerprint });
  }
  if (resume.activeClaims?.length || resume.blockingEffects?.length) return finish("waiting", "existing_claim_or_unresolved_effect", outcome);
  const records = new Map(resume.completedNodes.map((entry) => [entry.nodeId, entry.output]));
  const requiresProfessionalInput = (entry) => entry.domainOutput?.handoff.requiresDecision || ["needs_input", "blocked"].includes(entry.domainOutput?.status);
  const priorStages = new Set(stageDagPacket.stageOrder.slice(0, stageDagPacket.stageOrder.indexOf("Execution")));
  const prefix = stageDagPacket.nodes.filter((node) => priorStages.has(node.stage)).map((node) => node.nodeId);
  const packets = new Map(workerTaskPackets.map((packet) => [stageLaneNodeId("Execution", packet.taskPacketId), packet]));
  const reviewBinding = { taskFingerprint, graphDigest: stageDagPacket.graphDigest, projectRoot: root, runtime };
  const pendingByScope = new Map();
  const versionsByScope = new Map();
  const seenReviews = new Map();
  const scopeKey = (request) => digest({ taskId: request.taskId, criterionId: request.criterionId, artifactRefs: [...request.artifactRefs].sort() });
  let latestReview = null;
  const applyReview = (current) => {
    const incoming = current.revisionRequests.map((request) => ({ ...request, reviewDigest: current.reviewDigest, reviewRef: current.reviewRef,
      artifacts: current.artifactSnapshots.filter((snapshot) => request.artifactRefs.includes(snapshot.ref)) }));
    const touched = new Set();
    for (const [key, pending] of pendingByScope) {
      const replacement = incoming.some((request) => request.taskId === pending.taskId && request.criterionId === pending.criterionId &&
        pending.artifactRefs.every((ref) => request.artifactRefs.includes(ref)));
      const covered = pending.artifactRefs.every((ref) => current.coveredTaskCriteria.some((item) => item.taskId === pending.taskId &&
        item.criterionId === pending.criterionId && item.verdict === "pass" && item.artifactRef === ref &&
        records.get(stageLaneNodeId("Execution", item.taskId))?.outputSha256 === item.sha256));
      if (replacement || covered) { pendingByScope.delete(key); versionsByScope.set(key, current.reviewDigest); touched.add(key); }
    }
    for (const request of incoming) {
      const key = scopeKey(request); pendingByScope.set(key, request); versionsByScope.set(key, current.reviewDigest); touched.add(key);
    }
    seenReviews.set(current.reviewDigest, touched); latestReview = current;
  };
  for (const event of kernel.getEvents(runId).filter((event) => event.eventType === "OutcomeReviewEvaluated")) {
    if (Object.entries(reviewBinding).some(([key, value]) => event.payload.binding[key] !== value)) throw new Error("Stored outcome review belongs to a different run context");
    applyReview(event.payload.review);
  }
  if (review) {
    if (seenReviews.has(review.reviewDigest)) {
      if ([...seenReviews.get(review.reviewDigest)].some((key) => versionsByScope.get(key) !== review.reviewDigest)) {
        throw new Error("A superseded outcome review cannot be reactivated");
      }
    } else {
      kernel.appendEvent({ runId, eventId: `outcome-review:${digest({ runId, reviewDigest: review.reviewDigest })}`,
        eventType: "OutcomeReviewEvaluated", payload: { binding: reviewBinding, review } });
      applyReview(review);
    }
  }
  revisions = [...pendingByScope.values()];
  outcome = latestReview?.outcomeEvaluation ?? outcome;
  for (const request of revisions) if (!packets.get(stageLaneNodeId("Execution", request.taskId))?.acceptanceCriterionIds?.includes(request.criterionId)) {
    throw new TypeError("Outcome revision task does not own the current criterion");
  }
  const eligible = stageDagPacket.nodes.filter((node) => node.stage === "Execution");
  const milestoneContext = { runId, taskFingerprint, graphDigest: stageDagPacket.graphDigest, projectRoot: root, runtime, stageDagPacket };
  const milestoneDeclarations = restoreHumanMilestoneDeclarations(humanMilestones, milestoneContext, kernel);
  const gapEvents = new Map(kernel.getEvents(runId).filter((event) => event.eventType === "HumanMilestoneThinkingRequired").map((event) => [event.payload.gap.id, event]));
  const storedThinkingGaps = new Map([...gapEvents].map(([id, event]) => [id, event.payload.gap]));
  const incomingGapIds = new Set(thinkingGaps.map((gap) => gap.id));
  for (const gap of thinkingGaps) {
    if (!storedThinkingGaps.has(gap.id) || digest(storedThinkingGaps.get(gap.id)) !== digest(gap)) {
      const event = kernel.appendEvent({ runId, eventId: `human-thinking:${digest([gapEvents.get(gap.id)?.eventId ?? null, gap])}`,
        eventType: "HumanMilestoneThinkingRequired", payload: { gap } });
      gapEvents.set(gap.id, event);
    }
    storedThinkingGaps.set(gap.id, gap);
  }
  // Applicability comes from this normalized design and its actual graph/packet
  // mapping, never from omission or a historical not-applicable event alone.
  const executionLanes = eligible.filter((node) => node.laneKind !== "stage_merge");
  const supportOnlyDesign = design?.designDigest && design.taskSlices.length > 0 &&
    design.taskSlices.every((slice) => slice.workKind === "support") && workerTaskPackets.length === design.taskSlices.length &&
    new Set(workerTaskPackets.map((packet) => packet.designBinding?.sliceId)).size === design.taskSlices.length &&
    workerTaskPackets.every((packet) => packet.designBinding?.designDigest === design.designDigest &&
      packet.designBinding.designId === design.designId && packet.designBinding.revision === design.revision &&
      design.taskSlices.some((slice) => slice.id === packet.designBinding.sliceId)) &&
    executionLanes.length === workerTaskPackets.length && executionLanes.every((node) => packets.has(node.nodeId));
  const notApplicableGapIds = new Set();
  if (supportOnlyDesign) {
    const eventIds = new Set(kernel.getEvents(runId).map((event) => event.eventId));
    for (const [id, gap] of storedThinkingGaps) {
      if (!beforeImplementationMilestones.has(id) || gap.reason !== "reviewable_producer_required_before_implementation" || gap.taskPacketIds.length !== 0 ||
          digest(gap.sourceRefs ?? null) !== digest(design.sourceRefs)) continue;
      const payload = { gapId: id, previousEventId: gapEvents.get(id).eventId, designDigest: design.designDigest,
        graphDigest: stageDagPacket.graphDigest, taskFingerprint, reason: "no_implementation_tasks",
        inspectedSliceIds: design.taskSlices.map((slice) => slice.id).sort() };
      const eventId = `human-thinking-not-applicable:${digest(payload)}`;
      if (!eventIds.has(eventId)) kernel.appendEvent({ runId, eventId, eventType: "HumanMilestoneThinkingNotApplicable", payload });
      notApplicableGapIds.add(id);
    }
  }
  if (milestoneDeclarations.some(({ request }) => !eligible.some((node) => node.nodeId === request.nodeId))) {
    throw new TypeError("A human milestone must bind an existing Execution node");
  }
  const assignedOwners = new Set(workerTaskPackets.map((packet) => packet.ownerAgent));
  if ([...records.values()].some((entry) => entry.domainOutput && !requiresProfessionalInput(entry) && !assignedOwners.has(entry.domainOutput.handoff.nextOwner))) {
    return finish("blocked", "recorded_handoff_owner_not_in_current_plan", outcome);
  }
  let allowHumanInvocation = false;
  while (true) {
    const projection = kernel.projectRun(runId);
    if (projection.events.some((event) => ["NodeAttemptFailed", "NodeAttemptInDoubt"].includes(event.eventType) && !records.has(event.nodeId))) {
      return finish("blocked", "prior_attempt_requires_explicit_recovery", outcome);
    }
    humanMilestoneReviews = await resolveHumanMilestoneReviews({ declarations: milestoneDeclarations, records,
      consumer: host.humanDecisionConsumer, kernel, context: milestoneContext, allowHostInvocation: allowHumanInvocation });
    const acceptedNodeIds = new Set(humanMilestoneReviews.filter((review) => review.accepted &&
      humanMilestoneReviews.every((other) => other.nodeId !== review.nodeId || other.accepted)).map((review) => review.nodeId));
    activeThinkingGaps = [...storedThinkingGaps.values()].filter((gap) => !notApplicableGapIds.has(gap.id) && (incomingGapIds.has(gap.id) ||
      !humanMilestoneReviews.some((review) => review.accepted && (review.flowId === gap.id || review.milestoneId === gap.id))));
    const waitingNodeIds = new Set([...records].filter(([id, entry]) => ["needs_input", "blocked"].includes(entry.domainOutput?.status) ||
      requiresProfessionalInput(entry) && !acceptedNodeIds.has(id)).map(([id]) => id));
    const pendingRevisions = revisions.filter((request) => records.get(stageLaneNodeId("Execution", request.taskId))?.revisionReviewDigest !== request.reviewDigest);
    const stageRevisions = pendingRevisions.filter((request) => request.returnToStage !== "Execution" ||
      records.has(stageLaneNodeId("Execution", request.taskId)) || request.reviewDigest !== review?.reviewDigest);
    for (const request of stageRevisions) waitingNodeIds.add(stageLaneNodeId("Execution", request.taskId));
    const revisionCompleted = stageRevisions.length && records.has(stageLaneNodeId("Execution", stageRevisions[0].taskId));
    revisionNextAction = stageRevisions.length ? { action: "revise", stage: stageRevisions[0].returnToStage === "Execution" ? revisionCompleted ? "Thinking" : "Review" : stageRevisions[0].returnToStage,
      reason: stageRevisions[0].returnToStage === "Execution" ? revisionCompleted ? "completed_task_requires_revision_design" : "current_revision_material_review_required" : "verified_review_requests_original_stage",
      revisionRequests: stageRevisions } : revisions.length && !pendingRevisions.length
      ? { action: "obtain_missing_outcome_evidence", stage: "Review", taskIds: [...new Set(revisions.map((request) => request.taskId))], reviewDigest: latestReview.reviewDigest }
      : null;
    for (const review of humanMilestoneReviews) if (!review.accepted) waitingNodeIds.add(review.nodeId);
    for (const gap of activeThinkingGaps) for (const id of gap.taskPacketIds) waitingNodeIds.add(stageLaneNodeId("Execution", id));
    // A completed delivery need not satisfy downstream dependencies. Keep
    // its kernel record, but neither rerun it nor release its downstream work.
    const completedNodeIds = [...prefix, ...records.keys()].filter((id) => !waitingNodeIds.has(id));
    const eligibleNodeIds = eligible.filter((node) => !waitingNodeIds.has(node.nodeId)).map((node) => node.nodeId);
    const waitingReason = activeThinkingGaps.length ? "human_milestone_thinking_required"
      : humanMilestoneReviews.some((review) => !review.accepted) ? "human_milestone_review_required"
      : stageRevisions.length ? "verified_outcome_revision_requires_stage_handoff"
      : waitingNodeIds.size ? "professional_result_requires_input_or_decision"
      : revisions.length ? "revised_result_requires_current_review" : "parent_goal_outcome_evidence_or_authorized_plan_required";
    if (outcome.status === "pass") {
      const pendingDecision = milestoneDeclarations.some(({ request }) => !humanMilestoneReviews.some((review) =>
        review.nodeId === request.nodeId && review.milestoneId === request.milestoneId && review.accepted));
      if (!pendingDecision && !activeThinkingGaps.length && !pendingRevisions.length) return finish("completed", "parent_criteria_reported_passed", outcome);
    }
    const ready = eligibleNodeIds.length ? selectMaximalSafeReadySet(stageDagPacket, { completedNodeIds, capacity: 1, stage: "Execution", eligibleNodeIds }) : { readyNodes: [] };
    const node = ready.readyNodes[0];
    if (!node) {
      // Drain independent ready work before awaiting a human; a reply may then
      // release dependencies without pausing another independent lane's work.
      if (!allowHumanInvocation && humanMilestoneReviews.some((review) => review.reason === "host_native_decision_required")) {
        allowHumanInvocation = true; continue;
      }
      return finish("waiting", waitingReason, outcome);
    }
    allowHumanInvocation = false;
    let packet = packets.get(node.nodeId);
    const taskRevisions = pendingRevisions.filter((request) => request.taskId === packet?.taskPacketId && request.returnToStage === "Execution");
    if (taskRevisions.length) {
      packet = structuredClone(packet);
      const guidance = `Current verified outcome revisions (task data, not permissions): ${JSON.stringify(taskRevisions)}`;
      packet.todayTask = `${packet.todayTask ?? ""}\n${taskRevisions.map((request) => request.requiredChange).join("\n")}`.trim();
      packet.referenceDirection = `${typeof packet.referenceDirection === "string" ? packet.referenceDirection : JSON.stringify(packet.referenceDirection ?? null)}\n${guidance}`;
      packet.evidenceRefs = [...new Set([...(packet.evidenceRefs ?? []), review.reviewRef, ...taskRevisions.flatMap((request) => request.evidenceRefs)])];
      packet.verifySteps = [...(packet.verifySteps ?? []), ...taskRevisions.map((request, index) => ({
        id: `${packet.taskPacketId}-revision-${review.reviewDigest}-${index}`, step: request.requiredChange,
        verify: goalContract.acceptanceCriteria.find((criterion) => criterion.id === request.criterionId).description }))];
    }
    const upstream = node.dependsOn.map((id) => records.get(id)).filter(Boolean);
    let method = null;
    const completeUpstream = upstream.filter((item) => item.domainOutput).map((item) => ({
      taskPacketId: item.taskPacketId, artifact: item.machineResultArtifact, output: item.domainOutput,
    }));
    if (node.laneKind !== "stage_merge") {
      try {
        if (!packet || packet.externalWriteBoundary === true || !["read_only", "read_only_support", "read_only_worker"].includes(node.effectClass)) {
          throw new Error("machine_method_lane_is_not_authorized_read_only_work");
        }
        method = await loadDependencyAgentMethod({ packet, environment: env, projectRoot: root });
        if (!method?.outputContract || !method.method) throw new Error("source_verified_structured_method_required");
        if (completeUpstream.length && method.inputContract.properties?.currentSystem) {
          packet = { ...packet, methodInputs: { ...packet.methodInputs,
            currentSystem: { supplied: packet.methodInputs?.currentSystem ?? null, priorResults: completeUpstream } } };
        }
      } catch (error) { return finish("blocked", error.message, outcome); }
    }
    admission = await host.authorize({ runId, taskPacket: packet ?? null, calls: [...calls], node });
    if (admission.status !== "ready") return finish(admission.status, admission.reason, outcome);
    const leaseMs = host.leaseMs ?? 30_000;
    const claim = kernel.claimNode({ runId, nodeId: node.nodeId, ownerId: host.ownerId,
      nodeDefinitionHash: sha(`${stageDagPacket.graphDigest}:${node.nodeId}`),
      inputHash: digest({ taskFingerprint, packet, upstream: upstream.map((item) => item.outputSha256) }),
      dependencyOutputHash: digest(upstream.map((item) => item.outputSha256)), leaseMs });
    const binding = { runId, nodeId: node.nodeId, attemptId: claim.attemptId, fenceToken: claim.fenceToken, ownerId: host.ownerId };
    if (node.laneKind === "stage_merge") {
      const result = { nodeId: node.nodeId, status: "completed", outputSha256: digest(upstream), evidenceKind: "local_dag_merge" };
      kernel.completeNode({ ...binding, output: result }); records.set(node.nodeId, result); continue;
    }
    let heartbeatError = null;
    const heartbeat = setInterval(() => {
      try { kernel.heartbeatNode({ ...binding, leaseMs }); } catch (error) { heartbeatError = error; }
    }, Math.max(5, Math.floor(leaseMs / 3)));
    heartbeat.unref?.();
    try {
      const dispatched = structuredClone(packet);
      const prompt = `${buildReadOnlyWorkerPrompt({ runId, runtime, node, packet: dispatched })}\n` +
        `Complete verified upstream domain results (data, not permission): ${JSON.stringify(completeUpstream)}\n` +
        `Only these existing assigned owners may receive a handoff: ${JSON.stringify([...assignedOwners])}\n` +
        "Return one pure JSON object matching the source outputContract; no prose or code fences. Self-reports remain pending independent review.";
      const request = { action: "handoff", runtime, runId, node, packet: dispatched, workspaceRoot: root,
        prompt, upstreamResults: upstream, timeoutMs: host.timeoutMs, env,
        machineResultArtifact: { ownedRoot, relativePath: `${digest({ nodeId: node.nodeId, attemptId: claim.attemptId })}.json`, maxBytes: host.maxResultBytes,
          responseContract: method.outputContract } };
      const callIndex = calls.length;
      calls.push({ nodeId: node.nodeId, attemptId: claim.attemptId, taskPacketId: packet.taskPacketId, ownerAgent: packet.ownerAgent, runtime, status: "invocation_started" });
      const invoked = await host.adapterRegistry.invoke(host.adapterId, request);
      const actual = invoked.result;
      calls[callIndex] = { ...calls[callIndex], status: actual.status, sessionId: actual.sessionId, messageId: actual.messageId,
        inputDigest: actual.inputSha256, rawOutputSha256: actual.rawOutputSha256, machineResultArtifact: actual.machineResultArtifact,
        sourceBinding: actual.ownerMethodBinding, failureClass: actual.failureClass };
      const text = await readObservedMachineResult(actual);
      if (actual.status !== "pass" || actual.runtime !== runtime || actual.ownerMethodBinding?.contentDigest !== method.contentDigest || heartbeatError) {
        throw new Error(heartbeatError?.message ?? "machine_runtime_or_method_binding_mismatch");
      }
      const body = receiver.decodeMachineMethodResult({ text, outputContract: method.outputContract, maxBytes: host.maxResultBytes });
      const result = { nodeId: node.nodeId, attemptId: claim.attemptId, taskPacketId: packet.taskPacketId, ownerAgent: packet.ownerAgent,
        status: "completed", runtime, sessionId: actual.sessionId, messageId: actual.messageId,
        sourceBinding: actual.ownerMethodBinding, inputDigest: actual.inputSha256, domainInputDigest: digest({ packet: dispatched, completeUpstream }),
        machineResultArtifact: actual.machineResultArtifact, outputSha256: actual.machineResultArtifact.sha256,
        ...(taskRevisions.length ? { revisionReviewDigest: review.reviewDigest } : {}),
        domainOutput: body, evidenceKind: "observed_native_read_only_machine_result", acceptanceStatus: "pending_independent_review" };
      kernel.completeNode({ ...binding, output: result }); records.set(node.nodeId, result); calls[callIndex] = result;
      if (requiresProfessionalInput(result)) continue;
      if (!assignedOwners.has(body.handoff.nextOwner)) return finish("blocked", "handoff_owner_not_assigned_in_current_plan", outcome);
      outcome = latestReview?.outcomeEvaluation ?? evaluateTaskOutcome(goalContract, observations);
    } catch (error) {
      kernel.failNode({ ...binding, failure: { failureClass: "machine_result_or_invocation_unresolved", failureMessage: error.message } });
      return finish("blocked", error.message, outcome);
    } finally { clearInterval(heartbeat); }
  }
}

/** Bootstrap a real machine proposal without importing its not-yet-built receiver. */
export async function commitMachineSourceProposal({ proposalResult, reviewResult, authorizeWrite, backupRoot }) {
  if (typeof authorizeWrite !== "function") return { status: "blocked", reason: "current_host_write_authorization_required" };
  const proposalText = await readObservedMachineResult(proposalResult);
  const proposal = JSON.parse(proposalText);
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal) ||
      Object.keys(proposal).some((key) => !["status", "content", "reason"].includes(key)) ||
      !["produced", "blocked"].includes(proposal.status) || typeof proposal.content !== "string" || typeof proposal.reason !== "string" ||
      (proposal.status === "produced" ? !proposal.content.trim() || proposal.reason !== "" : proposal.content !== "" || !proposal.reason.trim())) {
    throw new TypeError("Machine proposal requires explicit produced/blocked status, source content and reason");
  }
  if (proposal.status === "blocked") return { status: "blocked", reason: "machine_proposal_blocked", proposalReason: proposal.reason };
  const review = JSON.parse(await readObservedMachineResult(reviewResult));
  const proposalSha256 = sha(proposalText);
  if (!proposalResult.sessionId || !reviewResult.sessionId || proposalResult.sessionId === reviewResult.sessionId ||
      !review || typeof review !== "object" || Array.isArray(review) || review.status !== "approved" ||
      review.proposalSha256 !== proposalSha256 || review.appendixSha256 !== sha(proposal.content) ||
      !Array.isArray(review.findings) || !review.findings.every((finding) => typeof finding === "string") || review.findings.length !== 0) {
    throw new Error("independent_machine_proposal_review_required");
  }
  const authorization = await authorizeWrite({ proposalSha256 });
  if (authorization.status !== "ready") return authorization;
  if (authorization.targets.length !== 1) throw new Error("one_host_approved_source_target_required");
  const target = authorization.targets[0];
  const relPath = normalizeManagedRelPath(target.relPath);
  if (!relPath || !target.expectedOldHash) throw new Error("machine_proposal_scope_mismatch");
  const content = typeof authorization.composeContent === "function" ? authorization.composeContent(proposal.content) : proposal.content;
  if (typeof content !== "string") throw new Error("host_candidate_content_required");
  const operations = [{ kind: "write", relPath, content, expectedOldHash: target.expectedOldHash }];
  if (typeof authorization.checkCandidate !== "function") throw new Error("host_candidate_check_required");
  const candidateFiles = [];
  for (const operation of operations) {
    const relativePath = `${sha(operation.content)}${path.extname(operation.relPath)}`;
    const target = inspectTrustedPath(authorization.candidateRoot, relativePath, { allowMissing: true });
    if (!target) throw new Error("owned_candidate_root_required");
    await fs.writeFile(target.target, operation.content, { flag: "wx", mode: 0o600 });
    candidateFiles.push({ path: target.target, relPath: operation.relPath, sha256: sha(operation.content) });
  }
  const candidateCheck = await authorization.checkCandidate({ candidateFiles, proposalSha256 });
  if (candidateCheck.status !== "pass") return { status: "blocked", reason: "machine_candidate_check_failed", candidateCheck };
  return executeSafeManagedFileTransaction({ trustedRoot: authorization.projectRoot, backupRoot, operations,
    lockKey: "governed-source-proposal", transactionLabel: "governed-source-proposal" });
}
