import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { evaluateTaskOutcome } from "../../src/domain/governance/task-outcome.mjs";

const text = (value) => typeof value === "string" && value.trim().length > 0;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const list = (value) => Array.isArray(value) && value.every(text);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const productDesignDigest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function requireThat(condition, message) { if (!condition) throw new TypeError(message); }
function uniqueRows(rows, field, label) {
  requireThat(Array.isArray(rows), `${label} must be an array`);
  const ids = new Set();
  for (const row of rows) {
    requireThat(object(row) && text(row[field]) && !ids.has(row[field]), `${label} requires unique ${field}`);
    ids.add(row[field]);
  }
  return ids;
}
function bind(input, dialogue, goal, label) {
  requireThat(object(input) && input.schemaVersion === 1, `${label} requires schemaVersion 1`);
  requireThat(input.taskHash === dialogue.taskHash, `${label} task binding mismatch`);
  requireThat((input.intentDigest ?? null) === (dialogue.intentDigest ?? null), `${label} intent binding mismatch`);
  if (goal) requireThat(input.acceptanceDigest === goal.acceptanceDigest, `${label} acceptance binding mismatch`);
  for (const key of ["trusted", "executionAllowed", "nativeInvocationVerified", "publicReady", "permissions", "authorization"]) {
    requireThat(!Object.hasOwn(input, key), `${label} cannot assert ${key}`);
  }
}
function checkDag(rows, idKey, dependencies = "dependsOn") {
  const ids = uniqueRows(rows, idKey, "dependency rows");
  const remaining = new Map(rows.map((row) => {
    requireThat(list(row[dependencies] ?? []), "Dependencies must be string IDs");
    const deps = row[dependencies] ?? [];
    requireThat(new Set(deps).size === deps.length && deps.every((id) => ids.has(id) && id !== row[idKey]), "Unknown, duplicate or self dependency");
    return [row[idKey], new Set(deps)];
  }));
  while (remaining.size) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    requireThat(ready.length > 0, "Dependency cycle in product design");
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
  }
}

/** Requirements exploration exists before a complete design. These are proposed
 * questions and recommendations, never user answers or execution permission. */
export function normalizeRequirementsDiscovery({ input = null, dialogue }) {
  if (input == null) return null;
  bind(input, dialogue, null, "Requirements discovery");
  requireThat(list(input.evidenceRefs) && input.evidenceRefs.length > 0, "Requirements discovery needs source evidence");
  const items = input.decisionItems ?? [];
  checkDag(items, "questionId");
  const decisionItems = items.map((item) => {
    requireThat(text(item.question) && text(item.decisionImpact) && list(item.evidenceRefs) && item.evidenceRefs.length > 0, "Decision requires a concrete question, impact and evidence");
    requireThat(["discoverable_fact", "routine_design_decision", "material_user_decision"].includes(item.resolutionClass), "Unknown decision resolution class");
    requireThat(text(item.recommendationRationale), "Decision requires a recommendation rationale");
    requireThat(Array.isArray(item.options ?? []) && (item.options ?? []).every((option) => object(option) && text(option.label) && text(option.tradeoff)), "Decision options require explicit tradeoffs");
    for (const key of ["trusted", "status", "userAnswer", "answerEvidenceRefs", "executionAllowed", "nativeInvocationVerified"]) requireThat(!Object.hasOwn(item, key), `Decision content cannot assert ${key}`);
    return { questionId: item.questionId, question: item.question, questionTarget: item.questionTarget ?? "wrong_goal_risk",
      decisionImpact: item.decisionImpact, impactPriority: Number.isFinite(item.impactPriority) ? item.impactPriority : 50,
      dependsOn: [...(item.dependsOn ?? [])], evidenceRefs: [...item.evidenceRefs], resolutionClass: item.resolutionClass,
      recommendationState: text(item.recommendedAnswer) ? "recommended" : "insufficient_evidence",
      recommendedAnswer: item.recommendedAnswer ?? null, recommendationRationale: item.recommendationRationale,
      options: structuredClone(item.options ?? []), affects: structuredClone(item.affects ?? {}) };
  });
  const normalized = { schemaVersion: 1, taskHash: input.taskHash, intentDigest: input.intentDigest ?? null,
    evidenceRefs: [...input.evidenceRefs], findings: structuredClone(input.findings ?? []), resolvedFacts: structuredClone(input.resolvedFacts ?? []), decisionItems };
  requireThat(Array.isArray(normalized.resolvedFacts) && normalized.resolvedFacts.every((fact) => decisionItems.some((item) => item.questionId === fact.questionId && item.resolutionClass === "discoverable_fact") && text(fact.value) && list(fact.evidenceRefs) && fact.evidenceRefs.length > 0), "Resolved facts require a fact question and source evidence");
  return { ...normalized, discoveryDigest: productDesignDigest(normalized),
    claimBoundary: "Proposed requirements exploration. Answers, authorization and native invocation come from the current host, not this content." };
}

export function normalizeProductDesign({ input = null, dialogue, goalContract }) {
  if (input == null) return null;
  bind(input, dialogue, goalContract, "Product design");
  requireThat(text(input.designId) && Number.isInteger(input.revision) && input.revision > 0, "Design needs identity and positive revision");
  requireThat(["exploration", "delivery"].includes(input.mode), "Design mode must be exploration or delivery");
  requireThat(list(input.sourceRefs) && input.sourceRefs.length > 0, "Design needs current source references");
  requireThat(!(input.decisionItems?.length), "Discover requirements before design; pass decisionItems through requirementsDiscoveryInput");
  const settled = new Set((dialogue.settledDecisionRefs ?? []).map((decision) => decision.decisionId));
  requireThat(list(input.settledDecisionRefs ?? []) && (input.settledDecisionRefs ?? []).every((id) => settled.has(id)), "Design references an unsettled decision");
  const journeys = structuredClone(input.userJourneys ?? []);
  const journeyIds = uniqueRows(journeys, "id", "User journeys");
  const criteria = new Set(goalContract.acceptanceCriteria.map((criterion) => criterion.id));
  for (const journey of journeys) {
    requireThat(text(journey.audience) && text(journey.motivation), "Journey requires audience and motivation");
    requireThat(Array.isArray(journey.steps) && journey.steps.length > 0 && journey.steps.every((step) => text(step.action) && text(step.feedback) && text(step.result)), "Journey needs concrete action, feedback and result");
    for (const key of ["rules", "failureRecovery", "resourceRefs", "criterionIds"]) requireThat(list(journey[key] ?? []), `Journey ${key} must be a string list`);
    requireThat((journey.criterionIds ?? []).every((id) => criteria.has(id)), "Journey references unknown goal criterion");
  }
  const slices = structuredClone(input.taskSlices ?? []);
  checkDag(slices, "id");
  for (const slice of slices) {
    slice.scopeFiles ??= [];
    slice.inputRefs ??= [];
    requireThat(text(slice.outcome) && list(slice.capabilityNeed) && slice.capabilityNeed.length > 0, "Task slice needs outcome and capability demand");
    requireThat(text(slice.completionDemo), "Task slice requires an observable completion demonstration");
    for (const key of ["scopeFiles", "inputRefs", "criterionIds", "journeyRefs", "decisionRefs", "artifactFlowRefs"]) requireThat(list(slice[key] ?? []), `Task slice ${key} must be a string list`);
    requireThat(slice.criterionIds.length > 0 && slice.criterionIds.every((id) => criteria.has(id)), "Task slice requires existing goal criteria");
    requireThat((slice.journeyRefs ?? []).every((id) => journeyIds.has(id)), "Task slice references unknown journey");
    requireThat((slice.decisionRefs ?? []).every((id) => settled.has(id)), "Task slice references unsettled decision");
    requireThat(Array.isArray(slice.deliverables) && slice.deliverables.length > 0 && slice.deliverables.every((item) => text(item.id) && text(item.description) && text(item.consumer)), "Task slice needs deliverable and actual consumer");
    requireThat(Array.isArray(slice.verification) && slice.verification.length > 0 && slice.verification.every((check) => slice.criterionIds.includes(check.criterionId) && text(check.procedure) && text(check.expectedEvidence)), "Task slice requires concrete verification");
    requireThat(["vertical_slice", "migration_batch", "support"].includes(slice.workKind ?? "vertical_slice"), "Unknown task slice kind");
    if (slice.workKind === "migration_batch") requireThat(object(slice.migration) && text(slice.migration.compatibilityBridge) && text(slice.migration.removalCondition), "Migration batches require compatibility and removal conditions");
    requireThat(slice.methodInputs == null || object(slice.methodInputs), "methodInputs must be explicit input data");
    for (const key of ["ownerAgent", "nativeAgentType", "permissions", "authorization", "trusted", "executionAllowed", "safetyEvidence", "mutationPolicy"]) requireThat(!Object.hasOwn(slice, key), `Design slice cannot assert ${key}`);
    if ((slice.dependsOn ?? []).length) requireThat(Array.isArray(slice.dependencyReasons) && slice.dependsOn.every((id) => slice.dependencyReasons.some((reason) => reason.taskId === id && text(reason.reason))), "Each task dependency needs its actual blocking reason");
  }
  const taskIds = new Set(slices.map((slice) => slice.id));
  const slicesById = new Map(slices.map((slice) => [slice.id, slice]));
  const dependencyClosure = (taskId, seen = new Set()) => {
    for (const dependencyId of slicesById.get(taskId).dependsOn ?? []) {
      if (seen.has(dependencyId)) continue;
      seen.add(dependencyId);
      dependencyClosure(dependencyId, seen);
    }
    return seen;
  };
  const flows = structuredClone(input.artifactFlow ?? []);
  const flowIds = uniqueRows(flows, "id", "Artifact flow");
  for (const flow of flows) {
    requireThat(taskIds.has(flow.producerTaskId) && list(flow.consumerTaskIds) && flow.consumerTaskIds.length > 0 && flow.consumerTaskIds.every((id) => taskIds.has(id)), "Artifact flow references unknown producer or consumer");
    requireThat(flow.consumerTaskIds.every((id) => dependencyClosure(id).has(flow.producerTaskId)), "Artifact flow consumer must depend on its producer directly or transitively");
    requireThat(text(flow.terminalArtifactRef) && list(flow.sourceArtifactRefs) && list(flow.scopeEvidenceRefs) && flow.scopeEvidenceRefs.length > 0, "Artifact flow needs final deliverable and scope evidence");
    requireThat(list(flow.criterionIds) && flow.criterionIds.every((id) => criteria.has(id)), "Artifact flow references unknown criterion");
  }
  for (const slice of slices) requireThat((slice.artifactFlowRefs ?? []).every((id) => flowIds.has(id)), "Task slice references unknown artifact flow");
  const uncoveredCriteria = goalContract.acceptanceCriteria.filter((criterion) => criterion.required && !slices.some((slice) => slice.criterionIds.includes(criterion.id))).map((criterion) => criterion.id);
  const normalized = { schemaVersion: 1, taskHash: input.taskHash, intentDigest: input.intentDigest ?? null, acceptanceDigest: input.acceptanceDigest,
    designId: input.designId, revision: input.revision, mode: input.mode, sourceRefs: [...input.sourceRefs], settledDecisionRefs: [...(input.settledDecisionRefs ?? [])],
    domainTerms: structuredClone(input.domainTerms ?? []), userJourneys: journeys, taskSlices: slices, artifactFlow: flows,
    revisionContext: structuredClone(input.revisionContext ?? null) };
  const revisionImpact = deriveDesignRevisionImpact(normalized);
  return { ...normalized, designDigest: productDesignDigest(normalized), uncoveredCriteria, revisionImpact,
    readiness: input.mode === "delivery" && slices.length > 0 && uncoveredCriteria.length === 0 ? "structure_ready_not_reviewed" : "design_incomplete",
    invocationStatus: "content_supplied_not_authenticated", nativeInvocationVerified: false };
}

export function deriveDesignRevisionImpact(design) {
  const revision = design.revisionContext;
  if (!revision) return null;
  requireThat(text(revision.previousRunId) && text(revision.previousDesignDigest) && list(revision.changeEvidenceRefs) && revision.changeEvidenceRefs.length > 0, "Design revision needs prior identity and change evidence");
  requireThat(list(revision.directlyAffectedTaskIds), "Revision requires explicit affected task IDs");
  const ids = new Set(design.taskSlices.map((slice) => slice.id));
  requireThat(revision.directlyAffectedTaskIds.every((id) => ids.has(id)), "Revision references unknown affected task");
  const affected = new Set(revision.directlyAffectedTaskIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const slice of design.taskSlices) if (!affected.has(slice.id) && (slice.dependsOn ?? []).some((id) => affected.has(id))) { affected.add(slice.id); changed = true; }
  }
  const candidates = revision.reuseCandidates ?? [];
  requireThat(Array.isArray(candidates), "Reuse candidates must be an array");
  for (const item of candidates) requireThat(ids.has(item.taskId ?? item.previousTaskId) && !affected.has(item.taskId ?? item.previousTaskId) && text(item.artifactRef) && /^[a-f0-9]{64}$/u.test(item.sha256 ?? "") && text(item.reason), "Invalid or affected reuse candidate");
  return { previousRunId: revision.previousRunId, directlyAffectedTaskIds: [...revision.directlyAffectedTaskIds], affectedTaskIds: [...affected].sort(),
    reuseCandidates: candidates.map((item) => ({ ...item, status: "requires_current_binding_and_review" })),
    status: "new_run_required", claimBoundary: "Explicit semantic impact plus dependency closure; old completion and review evidence are never copied." };
}

/** Consume a discovered route template; the design cannot supply an owner or
 * grant a tool. Per-slice templates were selected using its capability demand. */
export function projectDesignWorkerTasks({ design, runId, templates }) {
  if (!design) return templates;
  requireThat(design.revisionContext?.previousRunId !== runId, "Changed design requires a new run, not resume or overwrite");
  return design.taskSlices.map((slice, index) => {
    const packet = templates[index];
    requireThat(packet, "Design task has no discovered capability route");
    const scopeFiles = [...slice.scopeFiles];
    const taskPacketId = `${runId}-design-${slice.id}`;
    const ready = design.readiness === "structure_ready_not_reviewed" && scopeFiles.length > 0 && packet.workOrderReadiness === "ready";
    return { ...packet, taskPacketId, roleInstanceId: slice.id, businessFlowLaneId: slice.id,
      coreProblem: slice.outcome, todayTask: slice.outcome, description: slice.outcome,
      output: slice.deliverables.map((item) => item.description).join("; "), deliverableLink: `design://${design.designId}/${slice.id}`,
      scopeFiles, shardScope: scopeFiles, dependsOn: (slice.dependsOn ?? []).map((id) => `${runId}-design-${id}`),
      dependencyEvidence: "explicit_design_dependencies", capabilityNeed: [...slice.capabilityNeed], capabilityRequirements: [...slice.capabilityNeed],
      acceptanceCriterionIds: [...slice.criterionIds], verifySteps: slice.verification.map((check, i) => ({ id: `${taskPacketId}-check-${i + 1}`, step: check.procedure, verify: check.expectedEvidence })),
      designBinding: { designId: design.designId, revision: design.revision, designDigest: design.designDigest, sliceId: slice.id },
      methodInputs: structuredClone(slice.methodInputs ?? null), ...(slice.methodCapabilityId ? { methodCapabilityId: slice.methodCapabilityId } : {}),
      designTask: { completionDemo: slice.completionDemo, inputRefs: slice.inputRefs, deliverables: slice.deliverables, journeyRefs: slice.journeyRefs ?? [], decisionRefs: slice.decisionRefs ?? [], dependencyReasons: slice.dependencyReasons ?? [] },
      artifactFlowRefs: [...(slice.artifactFlowRefs ?? [])], artifactFlow: design.artifactFlow.filter((flow) => flow.producerTaskId === slice.id || flow.consumerTaskIds.includes(slice.id)),
      workOrderReadiness: ready ? "ready" : "incomplete", finalizationGate: ready ? packet.finalizationGate : "blocked_before_host_handoff" };
  });
}

/** Review input is an assessment. This validates current artifact bytes and
 * bindings, never authenticates native tools or turns assessment into permission. */
export async function evaluateProductOutcomeReview({ input, artifact, projectRoot }) {
  const goal = artifact.goalContractPacket ?? artifact.coreLoop?.goalContractPacket;
  const design = artifact.productDesignPacket ?? artifact.coreLoop?.productDesignPacket ?? null;
  const dialogue = goal.intentBinding ?? { taskHash: goal.taskHash, intentDigest: null };
  bind(input, { ...dialogue, taskHash: goal.taskHash }, goal, "Outcome review");
  requireThat(input.runId === artifact.runId && (input.designDigest ?? null) === (design?.designDigest ?? null), "Outcome review run or design binding mismatch");
  requireThat(text(input.reviewRef) && Array.isArray(input.observations) && input.observations.length > 0, "Outcome review requires original assessment and observations");
  requireThat(Array.isArray(input.artifactSnapshots) && input.artifactSnapshots.length > 0, "Outcome review needs actual artifact snapshots");
  const packets = artifact.workerTaskPackets ?? artifact.coreLoop?.thinkingPacket?.workerTaskPackets ?? [];
  const tasks = new Set(packets.map((packet) => packet.taskPacketId));
  const root = await fs.realpath(projectRoot);
  const snapshots = [];
  for (const snapshot of input.artifactSnapshots) {
    requireThat(text(snapshot.ref) && /^[a-f0-9]{64}$/u.test(snapshot.sha256 ?? "") && tasks.has(snapshot.producerTaskId), "Invalid outcome artifact snapshot or producer task");
    const target = await fs.realpath(path.resolve(root, snapshot.ref));
    const relative = path.relative(root, target);
    requireThat(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), "Review artifact escapes the current project");
    const hash = createHash("sha256").update(await fs.readFile(target)).digest("hex");
    requireThat(hash === snapshot.sha256, "Outcome artifact changed since review");
    snapshots.push({ ...snapshot, verifiedSha256: hash });
  }
  const outcome = evaluateTaskOutcome(goal, input.observations);
  for (const observation of input.observations) {
    requireThat(list(observation.artifactRefs) && observation.artifactRefs.length > 0, "Each outcome observation must identify its reviewed artifacts");
    for (const ref of observation.artifactRefs) {
      const snapshot = snapshots.find((item) => item.ref === ref);
      const producer = snapshot && packets.find((packet) => packet.taskPacketId === snapshot.producerTaskId);
      requireThat(snapshot && producer?.acceptanceCriterionIds?.includes(observation.criterionId), "Observation artifact must belong to the task assigned this criterion");
    }
  }
  const revisionRequests = structuredClone(input.revisionRequests ?? []);
  requireThat(Array.isArray(revisionRequests), "Revision requests must be an array");
  for (const request of revisionRequests) requireThat(tasks.has(request.taskId) && goal.acceptanceCriteria.some((criterion) => criterion.id === request.criterionId) && ["Critical", "Fetch", "Thinking", "Execution"].includes(request.returnToStage) && text(request.finding) && text(request.requiredChange) && list(request.evidenceRefs) && request.evidenceRefs.length > 0, "Revision needs selected task, criterion, evidence and concrete change");
  return { schemaVersion: 1, runId: artifact.runId, reviewDigest: productDesignDigest(input), reviewRef: input.reviewRef,
    designDigest: design?.designDigest ?? null, artifactSnapshots: snapshots, outcomeEvaluation: outcome, revisionRequests,
    nextAction: revisionRequests.length ? { action: "revise", stage: revisionRequests[0].returnToStage, taskIds: [...new Set(revisionRequests.map((request) => request.taskId))] }
      : { action: outcome.status === "pass" ? "continue_verification" : "obtain_missing_outcome_evidence", stage: "Review", taskIds: [] },
    status: outcome.status, evidenceKind: "supplied_assessment_with_current_artifact_binding", nativeInvocationVerified: false,
    claimBoundary: "Current artifact bytes and supplied independent assessments were checked; host invocation and user acceptance are not authenticated here." };
}

export function projectProductReview(artifact, review) {
  const core = artifact.coreLoop;
  const prior = artifact.reviewPacket ?? core?.reviewPacket ?? {};
  const findings = review.revisionRequests.map((request) => ({ findingId: `outcome-${productDesignDigest([review.reviewDigest, request.taskId, request.criterionId]).slice(0, 16)}`,
    taskPacketId: request.taskId, criterionId: request.criterionId, severity: "high", finding: request.finding, summary: request.finding,
    requiredChange: request.requiredChange, returnToStage: request.returnToStage, evidenceRefs: request.evidenceRefs, status: "open" }));
  const reviewPacket = { ...prior, ...(review.status === "pass" ? {} : { status: "partial" }), qualityGate: review.status === "pass" ? prior.qualityGate ?? "partial" : "partial",
    revisionNeeded: findings.length > 0, findings: [...(prior.findings ?? []).filter((finding) => !String(finding.findingId ?? "").startsWith("outcome-")), ...findings],
    outcomeReviewRef: review.reviewRef, revisionRequests: review.revisionRequests, nextAction: review.nextAction };
  const traceEvalControlPlane = { ...(artifact.traceEvalControlPlane ?? core?.traceEvalControlPlane), outcomeEvaluation: review.outcomeEvaluation };
  return { ...artifact, ...(review.status === "pass" ? {} : { status: "partial" }), outcomeReviewPacket: review, reviewPacket, traceEvalControlPlane,
    ...(artifact.defaultRuntimePath ? { defaultRuntimePath: { ...artifact.defaultRuntimePath, traceEvalControlPlane } } : {}),
    ...(core ? { coreLoop: { ...core, outcomeReviewPacket: review, reviewPacket, traceEvalControlPlane } } : {}),
    ...(artifact.summaryPacket ? { summaryPacket: { ...artifact.summaryPacket, nextAction: JSON.stringify(review.nextAction), publicReady: false } } : {}) };
}
