import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { selectMaximalSafeReadySet, stageLaneNodeId, isModuleScopedDag, validateStageDagPacket } from "./stage-dag.mjs";
import { resolveModuleStageExecutor, invokeModuleStageExecutor, moduleStageAncestorResults, moduleStageSatisfied,
  projectModuleStages, moduleNodeInRequestedScope, assertStoredModuleStageRecord, moduleDownstreamNodeIds,
  validateCurrentModuleFacts } from "./module-stage-execution.mjs";
import { createHostModuleStageExecutors, readHostReportedMethodResult, prepareHostReportedMethodRequest } from "./module-stage-host-bindings.mjs";
import { createModuleStageFactExecutors } from "./module-stage-fact-bindings.mjs";
import { revalidateModuleTaskArtifact } from "./module-artifact-reuse.mjs";
import { buildReadOnlyWorkerPrompt, readObservedMachineResult } from "./stage-runner-bridge.mjs";
import { loadDependencyAgentMethod } from "../dependency-agent-discovery.mjs";
import { additionalMethodKnowledgeEvidence } from "../../src/infrastructure/capabilities/dependency-method-knowledge.mjs";
import { evaluateTaskOutcome } from "../../src/domain/governance/task-outcome.mjs";
import { inspectTrustedPath, executeSafeManagedFileTransaction, normalizeManagedRelPath } from "../safe-managed-file-operations.mjs";
import { restoreHumanMilestoneDeclarations, resolveHumanMilestoneReviews, hasNativeHumanMilestoneTransport } from "./plan-challenge-host-continuation.mjs";
import { readEvaluatedOutcomeReview } from "./product-design.mjs";
import { projectHumanGateProgress } from "../../src/domain/scheduling/human-gate-progress.mjs";
import { normalizeConfiguredModel, modelSelectionRecord } from "../runtime-tool-profiles.mjs";
import { TASK_PROGRESS_POLICY, taskProgressGoal, checkedTaskProgress, recordTaskProgress, projectTaskProgress }
  from "../../canonical/runtime-assets/shared/hooks/task-progress.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => sha(JSON.stringify(value));
const beforeImplementationMilestones = new Set(JSON.parse(readFileSync(new URL("../../config/contracts/workflow-contract.json", import.meta.url), "utf8"))
  .protocols.preDecisionOptionFrame.humanMilestonePolicy.milestones.filter((rule) => rule.beforeImplementation).map((rule) => rule.id));

/** Current host authorization can narrow a declared write scope, never expand
 * it. The host remains responsible for enforcing these paths in its tools. */
export function authorizedLocalWritePaths({ packet, node, admission, projectRoot }) {
  if (node.effectClass !== "local_write") return [];
  if (packet.mutationPolicy !== "scoped_local_writes_only" || packet.externalWriteBoundary || packet.hostOperation || packet.executionMode === "approval_gate" ||
      admission.status !== "ready" || admission.effectClass !== "local_write" || !Array.isArray(admission.allowedLocalWritePaths)) {
    throw new Error("current_host_explicit_local_write_scope_required");
  }
  const normalize = (ref) => {
    if (typeof ref !== "string" || /[*?\[\]{}]/u.test(ref)) throw new Error("local_write_scope_requires_exact_project_files");
    const relative = path.relative(projectRoot, path.resolve(projectRoot, ref)).split(path.sep).join("/");
    const safe = normalizeManagedRelPath(relative);
    if (!safe || !inspectTrustedPath(projectRoot, safe, { allowMissing: true })) throw new Error("local_write_scope_outside_project_or_redirected");
    return safe;
  };
  const declared = [...new Set((packet.scopeFiles ?? []).map(normalize))];
  const allowed = new Set(admission.allowedLocalWritePaths.map(normalize));
  const graphPaths = new Set(node.resourceScopes.filter((scope) => scope.startsWith("file:")).map((scope) => normalize(scope.slice(5))));
  if (!declared.length || declared.some((ref) => !allowed.has(ref) || !graphPaths.has(ref))) throw new Error("local_write_scope_not_explicitly_authorized");
  return declared;
}

/** Consume an existing governed DAG. Host functions, never plan fields, admit calls. */
export async function advanceGovernedGoal({
  runId, goalContract, stageDagPacket, workerTaskPackets, projectRoot, artifactRoot,
  runtime, host, kernel, taskFingerprint, observations = [], env = process.env, humanMilestones = [], thinkingGaps = [], design = null, outcomeReview = null,
}) {
  const calls = [];
  host = { ...host, maxResultBytes: host?.maxResultBytes ?? 2 * 1024 * 1024 };
  const reportedMethodResults = host?.methodResultMode === "host_reported_files";
  if (host?.methodResultMode != null && !["observed_runtime", "host_reported_files"].includes(host.methodResultMode)) throw new TypeError("Unsupported current-host method result mode");
  const configuredModel = normalizeConfiguredModel(host?.model);
  let modelSelection = modelSelectionRecord(configuredModel);
  let humanMilestoneReviews = [];
  let humanGateProgress = null;
  let refreshHumanGateProgress = () => {};
  let activeThinkingGaps = [];
  let revisionNextAction = null;
  let taskProgress = { policyId: TASK_PROGRESS_POLICY.id, coverage: "not_observed", tasks: [], evidenceLevel: "owner_reported", nativeInvocationVerified: false };
  const moduleScoped = isModuleScopedDag(stageDagPacket);
  if (moduleScoped) validateStageDagPacket(stageDagPacket, { requireDigest: true });
  const moduleDispatchScope = host?.workOrder?.scope ?? host?.moduleScope ?? null;
  let moduleProgress = null;
  let moduleStageGaps = [];
  let moduleInvalidNodeIds = [];
  const finish = (status, reason, outcome = null) => ({ runId, status, reason, runtime, modelSelection, calls,
    outcome, humanMilestoneReviews, humanGateProgress, taskProgress, thinkingGaps: activeThinkingGaps,
    ...(revisionNextAction ? { nextAction: revisionNextAction } : {}), ...(moduleProgress ? { moduleProgress } : {}), publicReady: false, userOutcomeAccepted: false });
  if (typeof host?.authorize !== "function" || typeof host?.adapterRegistry?.invoke !== "function") {
    return finish("blocked", "current_host_execution_adapter_required");
  }
  let admission = await host.authorize({ runId, taskPacket: null, calls: [] });
  if (admission.status !== "ready") return finish(admission.status, admission.reason);
  // Capacity is an injected host capability, not a field supplied by a task or
  // method. A plan can lower this limit but cannot grant additional workers.
  const hostCapacity = host.capacity === undefined ? 1 : host.capacity;
  if (!Number.isSafeInteger(hostCapacity) || hostCapacity <= 0) return finish("blocked", "host_capacity_must_be_a_positive_integer");
  const planCapacity = stageDagPacket?.runtimeCapacity;
  const capacity = Number.isSafeInteger(planCapacity) && planCapacity > 0 ? Math.min(hostCapacity, planCapacity) : hostCapacity;
  const leaseMs = host.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) return finish("blocked", "host_lease_must_be_a_positive_integer");
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
  const hasRequiredExecution = stageDagPacket?.nodes?.some(node => node.stage === "Execution") === true;
  if (!kernel) return outcome.status === "pass" && !hasRequiredExecution && !humanMilestones.length && !thinkingGaps.length && !revisions.length
    ? finish("completed", "parent_criteria_reported_passed", outcome) : finish("blocked", "existing_durable_kernel_required", outcome);
  const receiver = await import("./method-delivery.mjs");
  if (typeof receiver.decodeMachineMethodResult !== "function") return finish("blocked", "machine_result_receiver_required", outcome);
  const root = path.resolve(projectRoot);
  const ownedRoot = path.resolve(artifactRoot);
  await fs.mkdir(ownedRoot, { recursive: true });
  if (moduleScoped) {
    host = { ...host, moduleRunContext: { runId, workspaceRunId: host.workOrder?.runId ?? null,
      designDigest: design?.designDigest ?? null, previousRunId: design?.revisionContext?.previousRunId ?? null } };
    const discovered = await createHostModuleStageExecutors({ host, runtime, projectRoot: root, artifactRoot: ownedRoot, env });
    const facts = await createModuleStageFactExecutors({ host, runtime, projectRoot: root, artifactRoot: ownedRoot });
    host = { ...host, stageExecutors: { ...discovered, ...host.stageExecutors, ...facts },
      stageBindingDiagnostics: [...discovered.diagnostics, ...facts.diagnostics] };
  }
  let resume;
  try { resume = kernel.resumeRun({ runId, graphDigest: stageDagPacket.graphDigest, taskFingerprint }); }
  catch (error) {
    if (!/Unknown governed run/u.test(error.message)) throw error;
    if (outcome.status === "pass" && !hasRequiredExecution && !humanMilestones.length && !thinkingGaps.length && !revisions.length) return finish("completed", "parent_criteria_reported_passed", outcome);
    kernel.createRun({ runId, graphDigest: stageDagPacket.graphDigest, taskFingerprint });
    resume = kernel.resumeRun({ runId, graphDigest: stageDagPacket.graphDigest, taskFingerprint });
  }
  if (resume.activeClaims?.length || resume.blockingEffects?.length) return finish("waiting", "existing_claim_or_unresolved_effect", outcome);
  // One consumer owns scheduling and review projection for a run. Per-node
  // leases below independently fence output commits, including after restart.
  let coordinator;
  try { coordinator = kernel.claimRunCoordinator({ runId, ownerId: host.ownerId, leaseMs }); }
  catch (error) {
    if (/Run coordinator lease is already claimed/u.test(error.message)) return finish("waiting", "existing_run_coordinator", outcome);
    throw error;
  }
  const coordinatorBinding = { runId, ownerId: host.ownerId, fenceToken: coordinator.fenceToken };
  let coordinatorError = null;
  const assertCoordinator = () => {
    if (coordinatorError) throw coordinatorError;
    try { kernel.heartbeatRunCoordinator({ ...coordinatorBinding, leaseMs }); }
    catch (error) { coordinatorError = error; throw error; }
  };
  const coordinatorHeartbeat = setInterval(() => { try { assertCoordinator(); } catch {} }, Math.max(1, Math.floor(leaseMs / 3)));
  coordinatorHeartbeat.unref?.();
  const inFlight = new Map();
  let humanReviewTask = null;
  let humanReviewRevision = 0;
  // A pending promise is only an active transport call. Durable recovery still
  // reads the existing milestone events and native-answer CAS repository.
  const activeCalls = () => [...inFlight.values(), ...(humanReviewTask ? [humanReviewTask] : [])];
  const drain = () => Promise.allSettled(activeCalls());
  const finishAfterDrain = async (status, reason) => {
    await drain();
    refreshHumanGateProgress();
    return finish(coordinatorError ? "blocked" : status, coordinatorError ? "run_coordinator_lease_lost" : reason, outcome);
  };
  const consumeRun = async () => {
    // Refresh under ownership: a previous coordinator may have settled output
    // between our first read and the lease acquisition in another process.
    resume = kernel.resumeRun({ runId, graphDigest: stageDagPacket.graphDigest, taskFingerprint });
    if (resume.activeClaims?.length || resume.blockingEffects?.length) return finish("waiting", "existing_claim_or_unresolved_effect", outcome);
    const records = new Map(resume.completedNodes.map((entry) => [entry.nodeId, entry.output]));
    if (moduleScoped) for (const [nodeId, record] of records) assertStoredModuleStageRecord({ record,
      node: stageDagPacket.nodes.find((node) => node.nodeId === nodeId), stageDagPacket, runId });
    // Durable results describe this run, not only calls made during this resume.
    const recordedModel = [...records.values()].find(record => record.modelSelection?.requested === configuredModel &&
      record.modelSelection?.applied != null)?.modelSelection;
    modelSelection = recordedModel ? { ...recordedModel, scope: "run" }
      : modelSelectionRecord(configuredModel, { scope: "run", application: records.size ? "not_observed" : "not_invoked" });
    const requiresProfessionalInput = (entry) => entry.domainOutput?.handoff.requiresDecision || ["needs_input", "blocked"].includes(entry.domainOutput?.status);
    const priorStages = new Set(stageDagPacket.stageOrder.slice(0, stageDagPacket.stageOrder.indexOf("Execution")));
    const prefix = moduleScoped ? [] : stageDagPacket.nodes.filter((node) => priorStages.has(node.stage)).map((node) => node.nodeId);
    const packets = new Map(workerTaskPackets.map((packet) => [stageLaneNodeId("Execution", packet.taskPacketId), packet]));
    const reviewBinding = { taskFingerprint, graphDigest: stageDagPacket.graphDigest, projectRoot: root, runtime };
    const progressGoal = taskProgressGoal({ realIntent: goalContract.contractFields.outcome, successCriteria: goalContract.acceptanceCriteria });
    let progressLedger;
    const progressPackets = new Map();
    const progressBindingMatches = (binding) => binding && Object.entries(reviewBinding).every(([key, value]) => binding[key] === value);
    for (const event of kernel.getEvents(runId).filter((entry) => entry.eventType === "TaskProgressObserved")) {
      if (!progressBindingMatches(event.payload.binding)) throw new Error("Stored task progress belongs to a different run context");
      const { observation, packet } = event.payload;
      const checked = checkedTaskProgress(observation, packet, progressGoal);
      if (checked.goalDigest !== observation.goalDigest || checked.routeDigest !== observation.routeDigest ||
          checked.evidenceBasisDigest !== observation.evidenceBasisDigest) throw new Error("Stored task progress binding mismatch");
      progressLedger = recordTaskProgress(progressLedger, checked).ledger;
      progressPackets.set(`${observation.taskPacketId}:${observation.attemptId}`, packet);
    }
    const updateTaskProgress = () => {
      const logicalTasks = new Set(workerTaskPackets.map((packet) => packet.logicalTaskPacketId || packet.taskPacketId));
      const tasks = [...logicalTasks].map((logicalTaskId) => {
        const projection = projectTaskProgress(progressLedger, progressGoal.goalDigest, logicalTaskId);
        const rows = (progressLedger?.observations || []).filter((entry) => entry.goalDigest === progressGoal.goalDigest && entry.logicalTaskPacketId === logicalTaskId);
        const criterionAssigned = workerTaskPackets.some((packet) => (packet.logicalTaskPacketId || packet.taskPacketId) === logicalTaskId && packet.acceptanceCriterionIds?.length > 0);
        return { ...projection, criterionAssignment: criterionAssigned ? "assigned" : "unassigned_not_supervised",
          coverage: rows.length ? projection.terminalAttempts ? "reviewed_attempts_recorded"
            : rows.some((entry) => entry.classification === "unresolved") ? "unresolved_attempts_recorded" : "awaiting_criterion_review" : "not_observed" };
      });
      taskProgress = { policyId: TASK_PROGRESS_POLICY.id, coverage: tasks.some((task) => task.coverage !== "not_observed") ? "observed_tasks_only" : "not_observed",
        tasks, evidenceLevel: "owner_reported", nativeInvocationVerified: false };
      return tasks.filter((task) => task.pendingCorrections.length > 0);
    };
    const appendTaskProgress = (raw, packet) => {
      const observation = checkedTaskProgress(raw, packet, progressGoal);
      const reduced = recordTaskProgress(progressLedger, observation);
      if (reduced.changed) kernel.appendEvent({ runId,
        eventId: `task-progress:${digest({ eventId: reduced.eventId, classification: observation.classification, resultDigest: observation.resultDigest, waitReason: observation.waitReason })}`,
        eventType: "TaskProgressObserved", payload: { binding: reviewBinding, packet, observation } });
      progressLedger = reduced.ledger;
      progressPackets.set(`${observation.taskPacketId}:${observation.attemptId}`, packet);
      updateTaskProgress();
    };
    const reconcileEndedProgressAttempts = () => {
      const ended = kernel.getEvents(runId).filter((event) => ["NodeAttemptFailed", "NodeAttemptInDoubt", "NodeAttemptAbandoned"].includes(event.eventType));
      for (const event of ended) {
        const unfinished = (progressLedger?.observations || []).filter((entry) => entry.attemptId === event.attemptId && entry.started
          && !["progress", "ineffective", "unresolved"].includes(entry.classification));
        for (const entry of unfinished) {
          const packet = progressPackets.get(`${entry.taskPacketId}:${entry.attemptId}`);
          const resultRef = `kernel:${runId}:${event.eventId}`;
          appendTaskProgress({ ...entry, classification: "unresolved", resultRef, resultDigest: event.eventHash,
            criterionEvidence: [], failureClass: null, waitReason: event.eventType, evidenceRefs: [resultRef] }, packet);
        }
      }
    };
    // Only an evaluated criterion review of this committed attempt's exact output
    // can settle progress. Worker completion and another read are not progress.
    const observeReviewedProgress = (current, { preview = false } = {}) => {
      let candidateLedger = progressLedger;
      for (const item of current.coveredTaskCriteria) {
        if (!["pass", "fail"].includes(item.verdict)) continue;
        const completed = records.get(stageLaneNodeId("Execution", item.taskId));
        if (!completed?.attemptId || completed.outputSha256 !== item.sha256) continue;
        const packet = progressPackets.get(`${item.taskId}:${completed.attemptId}`);
        const started = candidateLedger?.observations.find((entry) => entry.taskPacketId === item.taskId && entry.attemptId === completed.attemptId && entry.criterionId === item.criterionId && entry.started);
        if (!packet || !started) continue;
        const snapshot = current.artifactSnapshots.find((entry) => entry.ref === item.artifactRef && entry.producerTaskId === item.taskId && entry.verifiedSha256 === completed.outputSha256);
        if (!snapshot) continue;
        const raw = { ...started, classification: item.verdict === "pass" ? "progress" : "ineffective",
          resultDigest: completed.outputSha256, resultRef: snapshot.ref,
          failureClass: item.verdict === "fail" ? "criterion_not_met" : null,
          criterionEvidence: item.verdict === "pass" ? [{ ref: snapshot.ref, sha256: snapshot.verifiedSha256 }] : [],
          evidenceRefs: [current.reviewRef, snapshot.ref], waitReason: null };
        if (preview) candidateLedger = recordTaskProgress(candidateLedger, checkedTaskProgress(raw, packet, progressGoal)).ledger;
        else { appendTaskProgress(raw, packet); candidateLedger = progressLedger; }
      }
    };
    reconcileEndedProgressAttempts();
    updateTaskProgress();
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
      observeReviewedProgress(current);
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
        observeReviewedProgress(review, { preview: true });
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
    const eligible = stageDagPacket.nodes.filter((node) => moduleScoped || node.stage === "Execution");
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
    const executionLanes = eligible.filter((node) => node.stage === "Execution" && node.laneKind !== "stage_merge");
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
    let otherWaitingNodeIds = new Set();
    refreshHumanGateProgress = () => {
      moduleProgress = projectModuleStages(stageDagPacket, records, { invalidNodeIds: moduleInvalidNodeIds });
      if (moduleProgress) Object.assign(moduleProgress, { bindingDiagnostics: host.stageBindingDiagnostics ?? [], gaps: moduleStageGaps,
        requestedModuleIds: moduleDispatchScope?.moduleIds ?? [], requestedScopeComplete: moduleDispatchScope?.moduleIds?.length > 0
          ? moduleDispatchScope.moduleIds.every((id) => moduleProgress.modules.some((module) => module.moduleId === id && module.completed))
          : moduleProgress.aggregateCompleted });
      humanGateProgress = projectHumanGateProgress({ nodes: stageDagPacket.nodes,
        requiredNodeIds: eligible.map(node => node.nodeId), completedNodeIds: [...prefix, ...records.keys()].filter(id => !moduleInvalidNodeIds.includes(id)),
        runningNodeIds: [...inFlight.keys()], waitingNodeIds: [...otherWaitingNodeIds],
        declarations: milestoneDeclarations, reviews: humanMilestoneReviews,
        taskNodeBindings: [...packets].map(([nodeId, packet]) => ({ nodeId, taskPacketId: packet.taskPacketId })) });
    };
    const failureReasons = new Map();
    const admissionGaps = new Map();
    let stopped = null;
    const startHumanReview = () => {
      if (humanReviewTask || runtime !== "codex" || !hasNativeHumanMilestoneTransport(host.humanDecisionConsumer) ||
          !humanMilestoneReviews.some(review => review.reason === "host_native_decision_required")) return;
      const pending = (async () => {
        const authorization = await host.authorize({ runId, taskPacket: null, calls: [...calls] });
        if (authorization.status !== "ready") { stopped = authorization; return; }
        assertCoordinator();
        humanMilestoneReviews = await resolveHumanMilestoneReviews({ declarations: milestoneDeclarations, records,
          consumer: host.humanDecisionConsumer, kernel, context: milestoneContext, allowHostInvocation: true });
        humanReviewRevision += 1;
      })().catch(error => { stopped = { status: "blocked", reason: error.message }; })
        .finally(() => { if (humanReviewTask === pending) humanReviewTask = null; });
      humanReviewTask = pending;
    };
    while (true) {
      if (stopped) return finishAfterDrain(stopped.status, stopped.reason);
      try { assertCoordinator(); } catch { return finishAfterDrain("blocked", "run_coordinator_lease_lost"); }
      const projection = kernel.projectRun(runId);
      const failedNodeIds = new Set(projection.events.filter((event) => ["NodeAttemptFailed", "NodeAttemptInDoubt"].includes(event.eventType) &&
        event.payload?.failure?.failureClass !== "module_stage_wait" && !records.has(event.nodeId)).map((event) => event.nodeId));
      const reviewRevision = humanReviewRevision;
      const currentReviews = await resolveHumanMilestoneReviews({ declarations: milestoneDeclarations, records,
        consumer: host.humanDecisionConsumer, kernel, context: milestoneContext, allowHostInvocation: false });
      // An awaited transport may settle while the read-only projection is being
      // refreshed. Do not overwrite its newer receipt with an older pending view.
      if (reviewRevision !== humanReviewRevision) continue;
      humanMilestoneReviews = currentReviews;
      const acceptedNodeIds = new Set(humanMilestoneReviews.filter((review) => review.accepted &&
        humanMilestoneReviews.every((other) => other.nodeId !== review.nodeId || other.accepted)).map((review) => review.nodeId));
      activeThinkingGaps = [...storedThinkingGaps.values()].filter((gap) => !notApplicableGapIds.has(gap.id) && (incomingGapIds.has(gap.id) ||
        !humanMilestoneReviews.some((review) => review.accepted && (review.flowId === gap.id || review.milestoneId === gap.id))));
      const waitingNodeIds = new Set([...records].filter(([id, entry]) => ["needs_input", "blocked"].includes(entry.domainOutput?.status) ||
        requiresProfessionalInput(entry) && !acceptedNodeIds.has(id)).map(([id]) => id));
      const stageGaps = [...admissionGaps.values()];
      for (const id of admissionGaps.keys()) waitingNodeIds.add(id);
      if (moduleScoped) for (const node of eligible) {
        if (node.laneKind !== "module_stage") continue;
        const record = records.get(node.nodeId);
        const fact = host.stageExecutors?.[node.nodeId];
        let currentFactFailure = fact?.ready === false ? fact.reason ?? "current_module_fact_required" : null;
        if (!currentFactFailure && record && typeof fact?.validateCurrent === "function") {
          try { const current = await fact.validateCurrent({ node, runId }); if (current?.ready !== true) currentFactFailure = current?.reason ?? "current_module_fact_required"; }
          catch (error) { currentFactFailure = error.message; }
        }
        if (currentFactFailure || record && !moduleStageSatisfied(record) || !record && !resolveModuleStageExecutor(host.stageExecutors, node)) {
          waitingNodeIds.add(node.nodeId);
          stageGaps.push({ nodeId: node.nodeId, stage: node.stage, scope: node.scope,
            reason: currentFactFailure ?? (record ? `stage_${record.stageVerdict}_requires_current_revision`
              : node.stageContract?.taskDecompositionRequired ? "module_task_decomposition_required"
              : host.stageExecutors?.[node.nodeId]?.reason ?? "current_host_stage_executor_required") });
        }
      }
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
      const progressCorrections = updateTaskProgress();
      const correctionTaskIds = workerTaskPackets.filter((packet) => progressCorrections.some((task) =>
        task.logicalTaskPacketId === (packet.logicalTaskPacketId || packet.taskPacketId))).map((packet) => packet.taskPacketId);
      for (const taskId of correctionTaskIds) waitingNodeIds.add(stageLaneNodeId("Execution", taskId));
      if (progressCorrections.length) revisionNextAction = { action: "revise", stage: "Thinking",
        reason: "same_basis_ineffective_attempts_require_task_correction", taskIds: correctionTaskIds,
        pendingCorrections: progressCorrections.flatMap((task) => task.pendingCorrections),
        correctionBoundary: "Prepare an evidenced task replacement under the existing goal and graph authority; this consumer does not rewrite the graph or rerun completed nodes" };
      const humanRevision = humanMilestoneReviews.find(review => !review.accepted && review.nextAction);
      if (!revisionNextAction && humanRevision) revisionNextAction = { ...humanRevision.nextAction, reason: humanRevision.reason };
      for (const gap of activeThinkingGaps) for (const id of gap.taskPacketIds) waitingNodeIds.add(stageLaneNodeId("Execution", id));
      otherWaitingNodeIds = new Set(waitingNodeIds);
      for (const review of humanMilestoneReviews) if (!review.accepted) waitingNodeIds.add(review.nodeId);
      if (moduleScoped) {
        for (const id of moduleDownstreamNodeIds(stageDagPacket, waitingNodeIds)) waitingNodeIds.add(id);
        moduleInvalidNodeIds = [...waitingNodeIds];
        otherWaitingNodeIds = new Set(waitingNodeIds);
      }
      refreshHumanGateProgress();
      // A completed delivery need not satisfy downstream dependencies. Keep
      // its kernel record, but neither rerun it nor release its downstream work.
      const completedNodeIds = [...prefix, ...records.keys()].filter((id) => !waitingNodeIds.has(id));
      const eligibleNodeIds = eligible.filter((node) => !waitingNodeIds.has(node.nodeId) &&
        !failedNodeIds.has(node.nodeId) && !inFlight.has(node.nodeId) &&
        (!moduleScoped || moduleNodeInRequestedScope(node, moduleDispatchScope, workerTaskPackets))).map((node) => node.nodeId);
      const waitingReason = stageGaps.length ? "module_stage_binding_or_revision_required" : progressCorrections.length ? "task_progress_correction_required"
        : activeThinkingGaps.length ? "human_milestone_thinking_required"
        : humanMilestoneReviews.some((review) => !review.accepted) ? "human_milestone_review_required"
        : stageRevisions.length ? "verified_outcome_revision_requires_stage_handoff"
        : waitingNodeIds.size ? "professional_result_requires_input_or_decision"
        : revisions.length ? "revised_result_requires_current_review" : "parent_goal_outcome_evidence_or_authorized_plan_required";
      if (outcome.status === "pass") {
        const pendingDecision = milestoneDeclarations.some(({ request }) => !humanMilestoneReviews.some((review) =>
          review.nodeId === request.nodeId && review.milestoneId === request.milestoneId && review.accepted));
        if (humanGateProgress.canFinalizeExecution && !pendingDecision && !activeThinkingGaps.length && !pendingRevisions.length && !progressCorrections.length && !failedNodeIds.size) {
          return finishAfterDrain("completed", "parent_criteria_reported_passed");
        }
      }
      const available = capacity - inFlight.size;
      moduleStageGaps = stageGaps;
      if (moduleProgress) moduleProgress.gaps = stageGaps;
      const ready = available > 0 && eligibleNodeIds.length ? selectMaximalSafeReadySet(stageDagPacket,
        { completedNodeIds, capacity: available, stage: moduleScoped ? null : "Execution", eligibleNodeIds,
          runningNodeIds: [...inFlight.keys()] }) : { readyNodes: [] };
      if (!ready.readyNodes.length) {
        startHumanReview();
        // Re-evaluate dependencies as soon as one attempt settles. A fast A can
        // await a human while B and B's own dependents keep progressing.
        if (activeCalls().length) { await Promise.race(activeCalls()); continue; }
        if (failedNodeIds.size) return finishAfterDrain("blocked", failureReasons.values().next().value ?? "prior_attempt_requires_explicit_recovery");
        if (moduleDispatchScope?.kind === "module" && moduleProgress?.requestedScopeComplete) {
          return finishAfterDrain("partial", "requested_modules_completed_pending_aggregate");
        }
        return finishAfterDrain("waiting", waitingReason);
      }
      for (const node of ready.readyNodes) {
        if (stopped) return finishAfterDrain(stopped.status, stopped.reason);
        const boundary = await launchNode(node, pendingRevisions);
        if (boundary && moduleScoped && ["blocked", "waiting"].includes(boundary.status)) {
          admissionGaps.set(node.nodeId, { nodeId: node.nodeId, stage: node.stage, scope: node.scope, reason: boundary.reason });
          continue;
        }
        if (boundary) return finishAfterDrain(boundary.status, boundary.reason);
      }
      // Admit ready independent work before starting a native human exchange;
      // that exchange must not monopolize the scheduler until its reply arrives.
      startHumanReview();
    }

    async function launchNode(node, pendingRevisions) {
      if (moduleScoped) {
        try { await validateCurrentModuleFacts({ stageDagPacket, node, executors: host.stageExecutors, runId }); }
        catch (error) { return { status: "waiting", reason: error.message }; }
      }
      let packet = packets.get(node.nodeId);
      const taskRevisions = pendingRevisions.filter((request) => request.taskId === packet?.taskPacketId && request.returnToStage === "Execution");
      if (taskRevisions.length) {
        packet = structuredClone(packet);
        const guidance = `Current verified outcome revisions (task data, not permissions): ${JSON.stringify(taskRevisions)}`;
        // A reviewed correction refines this work order; it does not replace
        // the confirmed task identity to which its design facts are bound.
        packet.referenceDirection = `${typeof packet.referenceDirection === "string" ? packet.referenceDirection : JSON.stringify(packet.referenceDirection ?? null)}\n${guidance}`;
        packet.evidenceRefs = [...new Set([...(packet.evidenceRefs ?? []), review.reviewRef, ...taskRevisions.flatMap((request) => request.evidenceRefs)])];
        packet.verifySteps = [...(packet.verifySteps ?? []), ...taskRevisions.map((request, index) => ({
          id: `${packet.taskPacketId}-revision-${review.reviewDigest}-${index}`, step: request.requiredChange,
          verify: goalContract.acceptanceCriteria.find((criterion) => criterion.id === request.criterionId).description }))];
      }
      const upstream = node.dependsOn.map((id) => records.get(id)).filter(Boolean);
      let method = null;
      let localWritePaths = [];
      const completeUpstream = upstream.filter((item) => item.domainOutput || item.reusedArtifact).map((item) => ({
        taskPacketId: item.taskPacketId, artifact: item.machineResultArtifact ?? item.reusedArtifact, output: item.domainOutput ?? item.reusedArtifact,
      }));
      if (node.laneKind !== "stage_merge" && node.laneKind !== "module_stage") {
        try {
          if (!packet || packet.hostOperation || packet.executionMode === "approval_gate" || packet.externalWriteBoundary === true ||
              !["read_only", "read_only_support", "read_only_worker", ...(reportedMethodResults ? ["local_write"] : [])].includes(node.effectClass)) {
            throw new Error("machine_method_lane_is_not_authorized_read_only_work");
          }
          method = await loadDependencyAgentMethod({ packet, environment: env, projectRoot: root });
          if (!method?.outputContract || !method.method) throw new Error("source_verified_structured_method_required");
          if (completeUpstream.length && method.inputContract.properties?.currentSystem) {
            packet = { ...packet, methodInputs: { ...packet.methodInputs,
              currentSystem: { supplied: packet.methodInputs?.currentSystem ?? null, priorResults: completeUpstream } } };
          }
        } catch (error) { return { status: "blocked", reason: error.message }; }
      }
      if (stopped) return stopped;
      admission = await host.authorize({ runId, taskPacket: packet ?? null, calls: [...calls], node });
      if (admission.status !== "ready") return admission;
      if (node.effectClass === "local_write") {
        try { localWritePaths = authorizedLocalWritePaths({ packet, node, admission, projectRoot: root }); }
        catch (error) { return { status: "blocked", reason: error.message }; }
      }
      if (stopped) return stopped;
      if (moduleScoped) {
        try { await validateCurrentModuleFacts({ stageDagPacket, node, executors: host.stageExecutors, runId }); }
        catch (error) { return { status: "waiting", reason: error.message }; }
      }
      assertCoordinator();
      const claim = kernel.claimNode({ runId, nodeId: node.nodeId, ownerId: host.ownerId,
        nodeDefinitionHash: sha(`${stageDagPacket.graphDigest}:${node.nodeId}`),
        inputHash: digest({ taskFingerprint, packet, upstream: upstream.map((item) => item.outputSha256), ...(localWritePaths.length ? { localWritePaths } : {}) }),
        dependencyOutputHash: digest(upstream.map((item) => item.outputSha256)), leaseMs });
      reconcileEndedProgressAttempts();
      const binding = { runId, nodeId: node.nodeId, attemptId: claim.attemptId, fenceToken: claim.fenceToken, ownerId: host.ownerId };
      if (node.laneKind === "stage_merge") {
        const result = { nodeId: node.nodeId, stage: node.stage, laneKind: node.laneKind, ...(node.scope ? { scope: node.scope } : {}),
          status: "completed", outputSha256: digest(upstream), evidenceKind: "local_dag_merge" };
        kernel.completeNode({ ...binding, output: result }); records.set(node.nodeId, result); return null;
      }
      let heartbeatError = null;
      const heartbeat = setInterval(() => {
        if (heartbeatError) return;
        try { kernel.heartbeatNode({ ...binding, leaseMs }); }
        catch (error) { heartbeatError = error; stopped = { status: "blocked", reason: "node_attempt_resolution_requires_explicit_recovery" }; }
      }, Math.max(1, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();
      let callIndex = null;
      let localWriteEffect = null;
      let rollbackEvidence = [];
      const execute = async () => {
        try {
          if (node.laneKind === "module_stage") {
            const executor = resolveModuleStageExecutor(host.stageExecutors, node);
            callIndex = calls.length;
            calls.push({ nodeId: node.nodeId, attemptId: claim.attemptId, stage: node.stage, scope: node.scope,
              ownerAgent: executor.ownerId, status: "invocation_started", nativeInvocationVerified: false });
            const result = await invokeModuleStageExecutor({ executor, runId, stageDagPacket, node, claim, upstreamResults: upstream,
              relatedResults: moduleStageAncestorResults(stageDagPacket, node, records), projectRoot: root, runtime, workerTaskPackets });
            if (heartbeatError) throw heartbeatError;
            await validateCurrentModuleFacts({ stageDagPacket, node, executors: host.stageExecutors, runId });
            assertCoordinator();
            if (result.stageVerdict === "blocked") {
              kernel.appendEvent({ runId, eventId: `${claim.attemptId}:stage-wait`, eventType: "ModuleStageWaitObserved",
                nodeId: node.nodeId, attemptId: claim.attemptId, payload: { receipt: result.stageReceipt } });
              kernel.failNode({ ...binding, failure: { failureClass: "module_stage_wait", failureMessage: result.stageReceipt.summary } });
            } else kernel.completeNode({ ...binding, output: result });
            records.set(node.nodeId, result); calls[callIndex] = result;
            return;
          }
          if (moduleScoped) {
            const reuse = await revalidateModuleTaskArtifact({ design, packet, node, stageDagPacket, runId, kernel, claim,
              stageExecutors: host.stageExecutors, projectRoot: root, runtime, upstreamResults: upstream });
            if (reuse.status === "reused") {
              if (heartbeatError) throw heartbeatError;
              await validateCurrentModuleFacts({ stageDagPacket, node, executors: host.stageExecutors, runId });
              assertCoordinator();
              kernel.completeNode({ ...binding, output: reuse.result }); records.set(node.nodeId, reuse.result); calls.push(reuse.result);
              return;
            }
            if (reuse.status === "fallback") {
              const renewed = await host.authorize({ runId, taskPacket: packet, calls: [...calls], node,
                reason: "artifact_reuse_failed_return_to_current_task", reuseFailure: reuse.reason });
              if (renewed.status !== "ready") throw new Error(renewed.reason ?? "current_task_authorization_required_after_reuse");
            }
          }
          const dispatched = structuredClone(packet);
          const additionalKnowledge = additionalMethodKnowledgeEvidence(method, dispatched);
          const progressPacket = { taskPacketId: packet.taskPacketId, logicalTaskPacketId: packet.logicalTaskPacketId || packet.taskPacketId,
            ownerAgent: packet.ownerAgent, weapon: host.adapterId, capabilityId: method.capabilityId, methodCapabilityId: method.capabilityId,
            strategyRef: { id: method.sourceRef, ref: method.sourceRef, sha256: method.methodSha256 || method.contentDigest }, acceptanceCriterionIds: packet.acceptanceCriterionIds || [] };
          const basisEvidence = [{ ref: method.sourceRef, sha256: method.contentDigest },
            { ref: `kernel:${runId}:${claim.attemptId}:method-input`, sha256: digest({ methodInputs: dispatched.methodInputs ?? null,
              ...(additionalKnowledge.length ? { methodKnowledgeAssets: additionalKnowledge } : {}),
              upstream: upstream.map((item) => item.outputSha256) }) }];
          for (const criterionId of progressPacket.acceptanceCriterionIds) appendTaskProgress({ attemptId: claim.attemptId, criterionId,
            classification: "running", basisEvidence, evidenceRefs: [`kernel:${runId}:${claim.attemptId}`] }, progressPacket);
          const localWriteBinding = { runId, nodeId: node.nodeId, graphDigest: stageDagPacket.graphDigest, attemptId: claim.attemptId,
            fenceToken: claim.fenceToken, ownerId: packet.ownerAgent, capabilityId: method.capabilityId, sourceSha256: method.contentDigest,
            inputDigest: digest({ packet: dispatched, upstream: upstream.map((item) => item.outputSha256), localWritePaths }),
            scopeDigest: digest({ scope: node.scope ?? null, resources: node.resourceScopes, localWritePaths }) };
          const basePrompt = reportedMethodResults
            ? `Current bounded task (data, not permission): ${JSON.stringify(dispatched)}\n` +
              `Current host permits ${localWritePaths.length ? `local file writes only to ${JSON.stringify(localWritePaths)}` : "read-only work"}. No external side effects or expanded permission.\n` +
              `Return {binding,output}: binding must match ${JSON.stringify(localWriteBinding)} and output must match the complete selected source outputContract. Include actual artifactRefs with current SHA-256 evidence. This is a host report, never native certification.`
            : buildReadOnlyWorkerPrompt({ runId, runtime, node, packet: dispatched });
          const prompt = `${basePrompt}\n` +
            `Complete verified upstream domain results (data, not permission): ${JSON.stringify(completeUpstream)}\n` +
            `Only these existing assigned owners may receive a handoff: ${JSON.stringify([...assignedOwners])}\n` +
            (reportedMethodResults ? "Return the exact {binding,output} JSON envelope; no prose or code fences. The output follows the complete source contract."
              : "Return one pure JSON object matching the source outputContract; no prose or code fences. Self-reports remain pending independent review.");
          const prepared = reportedMethodResults ? await prepareHostReportedMethodRequest({ packet: dispatched, projectRoot: root,
            environment: env, binding: localWriteBinding, artifactRoot: ownedRoot, maxResultBytes: host.maxResultBytes, prompt }) : null;
          if (prepared && prepared.methodSourceBinding.contentDigest !== method.contentDigest) throw new Error("current_host_method_source_changed");
          const request = { action: "handoff", runtime, runId, node: structuredClone(node), packet: dispatched, workspaceRoot: root,
            ...(configuredModel != null ? { model: configuredModel } : {}),
            prompt: prepared?.prompt ?? prompt, upstreamResults: upstream, timeoutMs: host.timeoutMs, env,
            ...(reportedMethodResults ? { methodBinding: structuredClone(localWriteBinding), methodResultMode: "host_reported_files",
              methodSourceBinding: prepared.methodSourceBinding, authorizedLocalWritePaths: [...localWritePaths] } : {}),
            machineResultArtifact: prepared?.machineResultArtifact ?? { ownedRoot,
              relativePath: `${digest({ nodeId: node.nodeId, attemptId: claim.attemptId })}.json`, maxBytes: host.maxResultBytes,
              responseContract: method.outputContract } };
          if (moduleScoped) await validateCurrentModuleFacts({ stageDagPacket, node, executors: host.stageExecutors, runId });
          if (localWritePaths.length) {
            const freshPermission = await host.authorize({ runId, taskPacket: dispatched, node, calls: [...calls], phase: "before_local_write" });
            if (JSON.stringify(authorizedLocalWritePaths({ packet: dispatched, node, admission: freshPermission, projectRoot: root })) !== JSON.stringify(localWritePaths)) {
              throw new Error("local_write_authorization_changed_before_invocation");
            }
            for (const ref of localWritePaths) {
              const checked = inspectTrustedPath(root, ref, { allowMissing: true });
              if (!checked) throw new Error("local_write_target_changed_before_invocation");
              if (checked.missingAt) { rollbackEvidence.push({ ref, existed: false }); continue; }
              const stat = await fs.stat(checked.target);
              if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("local_write_backup_requires_bounded_file");
              const before = await fs.readFile(checked.target);
              const backup = `rollback-${digest({ attemptId: claim.attemptId, ref })}.bin`;
              const backupTarget = inspectTrustedPath(ownedRoot, backup, { allowMissing: true });
              if (!backupTarget || backupTarget.missingAt !== backupTarget.target) throw new Error("local_write_backup_target_not_unique");
              await fs.writeFile(backupTarget.target, before, { flag: "wx", mode: 0o600 });
              rollbackEvidence.push({ ref, existed: true, beforeSha256: sha(before), backupRef: backupTarget.target });
            }
            if (moduleScoped) await validateCurrentModuleFacts({ stageDagPacket, node, executors: host.stageExecutors, runId });
            localWriteEffect = kernel.prepareEffect({ ...binding, effectId: `local-write:${claim.attemptId}`,
              logicalEffectKey: `local-write:${node.nodeId}`, fingerprint: digest({ localWriteBinding, rollbackEvidence }),
              idempotencyKey: digest({ runId, nodeId: node.nodeId, localWriteBinding }),
              providerBinding: { adapterId: host.adapterId, scope: node.scope ?? null, localWritePaths, rollbackEvidence } });
            kernel.markEffectDispatchStarted({ effectId: localWriteEffect.effectId, attemptId: claim.attemptId,
              fenceToken: claim.fenceToken, ownerId: host.ownerId });
          }
          callIndex = calls.length;
          calls.push({ nodeId: node.nodeId, attemptId: claim.attemptId, taskPacketId: packet.taskPacketId, ownerAgent: packet.ownerAgent, runtime, status: "invocation_started" });
          const invoked = await host.adapterRegistry.invoke(host.adapterId, request);
          const callModelSelection = modelSelectionRecord(configuredModel, { application: "injected_adapter_request", applied: configuredModel != null });
          modelSelection = { ...callModelSelection, scope: "run" };
          const actual = invoked.result;
          calls[callIndex] = { ...calls[callIndex], status: actual.status, invocationStatus: actual.status, invocationReason: actual.reason,
            modelSelection: callModelSelection,
            invocationFailureMessage: actual.failureMessage,
            sessionId: actual.sessionId, messageId: actual.messageId,
            inputDigest: actual.inputSha256, rawOutputSha256: actual.rawOutputSha256, machineResultArtifact: actual.machineResultArtifact,
            sourceBinding: actual.ownerMethodBinding, failureClass: actual.failureClass };
          const text = reportedMethodResults ? null : await readObservedMachineResult(actual);
          if (actual.status !== "pass" || actual.runtime !== runtime || actual.ownerMethodBinding?.contentDigest !== method.contentDigest || heartbeatError) {
            throw new Error(heartbeatError?.message ?? "machine_runtime_or_method_binding_mismatch");
          }
          const body = reportedMethodResults
            ? await readHostReportedMethodResult({ result: actual, target: prepared.resultTarget,
                binding: localWriteBinding, maxBytes: host.maxResultBytes, outputContract: method.outputContract })
            : receiver.decodeMachineMethodResult({ text, outputContract: method.outputContract, maxBytes: host.maxResultBytes });
          if (localWritePaths.length) {
            if (!Array.isArray(body.artifactRefs) || !body.artifactRefs.length) throw new Error("local_write_result_requires_current_artifacts");
            for (const artifact of body.artifactRefs) {
              const relative = path.relative(root, path.resolve(root, artifact.ref ?? "")).split(path.sep).join("/");
              if (!localWritePaths.includes(relative) || !/^[a-f0-9]{64}$/u.test(artifact.sha256 ?? "")) throw new Error("local_write_receipt_outside_authorized_scope");
              const checked = inspectTrustedPath(root, relative);
              if (!checked || sha(await fs.readFile(checked.target)) !== artifact.sha256) throw new Error("local_write_artifact_changed_or_missing");
            }
            const commitPermission = await host.authorize({ runId, taskPacket: dispatched, node, calls: [...calls], phase: "verify_local_write_result" });
            if (JSON.stringify(authorizedLocalWritePaths({ packet: dispatched, node, admission: commitPermission, projectRoot: root })) !== JSON.stringify(localWritePaths)) {
              throw new Error("local_write_authorization_revoked_before_acceptance");
            }
            const freshMethod = await loadDependencyAgentMethod({ packet: dispatched, environment: env, projectRoot: root });
            if (freshMethod?.contentDigest !== method.contentDigest || freshMethod.componentContentSha256 !== method.componentContentSha256) {
              throw new Error("local_write_method_source_changed_before_acceptance");
            }
            kernel.markUnresolvedEffectsInDoubt({ runId, attemptId: claim.attemptId });
            kernel.reconcileEffect({ effectId: localWriteEffect.effectId, outcome: "completed", reconcilerIdentity: `${host.ownerId}:current-artifact-observer`,
              evidence: { methodBinding: localWriteBinding, artifactRefs: body.artifactRefs, rollbackEvidence,
                evidenceKind: "current_project_file_hashes", nativeInvocationVerified: false } });
          }
          assertCoordinator();
          if (moduleScoped) await validateCurrentModuleFacts({ stageDagPacket, node, executors: host.stageExecutors, runId });
          const result = { nodeId: node.nodeId, attemptId: claim.attemptId, taskPacketId: packet.taskPacketId, ownerAgent: packet.ownerAgent,
            laneKind: "execution_worker", ...(node.scope ? { scope: node.scope } : {}),
            ...(packet.designBinding ? { designBinding: packet.designBinding } : {}),
            modelSelection: callModelSelection,
            ...(packet.workBinding ? { workBinding: structuredClone(packet.workBinding) } : {}),
            status: "completed", runtime, sessionId: actual.sessionId, messageId: actual.messageId,
            sourceBinding: actual.ownerMethodBinding, inputDigest: actual.inputSha256, domainInputDigest: digest({ packet: dispatched, completeUpstream }),
            machineResultArtifact: actual.machineResultArtifact, outputSha256: actual.machineResultArtifact.sha256,
            ...(taskRevisions.length ? { revisionReviewDigest: review.reviewDigest } : {}),
            domainOutput: body, evidenceKind: reportedMethodResults ? "current_host_reported_files_verified" : "observed_native_read_only_machine_result",
            ...(reportedMethodResults ? { nativeInvocationVerified: false, methodBinding: localWriteBinding,
              authorizedLocalWritePaths: localWritePaths, writeScopeEnforcement: "current_host_tools", artifactRefs: body.artifactRefs ?? [] } : {}),
            ...(localWriteEffect ? { localWriteEffectId: localWriteEffect.effectId, rollbackEvidence } : {}),
            acceptanceStatus: "pending_independent_review" };
          if (requiresProfessionalInput(result)) {
            for (const criterionId of progressPacket.acceptanceCriterionIds) appendTaskProgress({ attemptId: claim.attemptId, criterionId,
              classification: "waiting", basisEvidence, evidenceRefs: [actual.machineResultArtifact.path || `kernel:${runId}:${claim.attemptId}`],
              waitReason: "professional_result_requires_input_or_decision" }, progressPacket);
          }
          kernel.completeNode({ ...binding, output: result }); records.set(node.nodeId, result); calls[callIndex] = result;
          if (requiresProfessionalInput(result)) return;
          if (!assignedOwners.has(body.handoff.nextOwner)) {
            stopped = { status: "blocked", reason: "handoff_owner_not_assigned_in_current_plan" }; return;
          }
          outcome = latestReview?.outcomeEvaluation ?? evaluateTaskOutcome(goalContract, observations);
        } catch (error) {
          if (localWriteEffect) {
            try { kernel.markUnresolvedEffectsInDoubt({ runId, attemptId: claim.attemptId }); } catch {}
          }
          failureReasons.set(node.nodeId, error.message);
          if (callIndex !== null) calls[callIndex] = { ...calls[callIndex], status: "unresolved",
            failureClass: calls[callIndex].failureClass ?? "machine_result_or_invocation_unresolved", failureMessage: error.message };
          try {
            kernel.failNode({ ...binding, failure: { failureClass: "machine_result_or_invocation_unresolved", failureMessage: error.message } });
            reconcileEndedProgressAttempts();
          } catch (resolutionError) {
            // A lost node fence cannot be repaired by this consumer. Keep the
            // persisted claim for explicit recovery and drain all admitted peers.
            stopped = { status: "blocked", reason: "node_attempt_resolution_requires_explicit_recovery" };
            if (callIndex !== null) calls[callIndex].resolutionError = resolutionError.message;
          }
        } finally { clearInterval(heartbeat); }
      };
      const running = execute().catch((error) => {
        stopped = { status: "blocked", reason: error.message };
      }).finally(() => inFlight.delete(node.nodeId));
      inFlight.set(node.nodeId, running);
      return null;
    }
  };
  let result;
  try { result = await consumeRun(); }
  catch (error) {
    if (!coordinatorError) throw error;
    result = finish("blocked", "run_coordinator_lease_lost", outcome);
  }
  finally {
    // Never release ownership, or let the caller close its repository, while
    // an already admitted invocation can still produce a terminal result.
    await drain();
    clearInterval(coordinatorHeartbeat);
    try { kernel.releaseRunCoordinator(coordinatorBinding); }
    catch (error) { coordinatorError ??= error; }
  }
  return coordinatorError ? finish("blocked", "run_coordinator_lease_lost", outcome) : result;
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
