import { createHash } from "node:crypto";
import { promises as fs, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { evaluateTaskOutcome } from "../../src/domain/governance/task-outcome.mjs";
import { stageLaneNodeId } from "./stage-dag.mjs";
import { normalizeResearchEvidence, researchForTask } from "./research-records.mjs";
import { inspectTrustedPath } from "../safe-managed-file-operations.mjs";
import { readCurrentTaskFacts } from "./task-design-dispatch.mjs";
import { normalizeSoftwareDesign, softwareDesignForTask, softwareAffectedTasks } from "../../src/domain/design/software-design.mjs";

const text = (value) => typeof value === "string" && value.trim().length > 0;
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const list = (value) => Array.isArray(value) && value.every(text);
const milestonePolicy = JSON.parse(readFileSync(new URL("../../config/contracts/workflow-contract.json", import.meta.url), "utf8"))
  .protocols.preDecisionOptionFrame.humanMilestonePolicy;
const evaluatedOutcomeReviews = new WeakMap();
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
    for (const key of ["artifactFlowRefs", "sideEffectActions"]) if (item.affects?.[key] !== undefined) {
      requireThat(list(item.affects[key]), `Decision affects.${key} must contain concrete references`);
    }
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
  const research = normalizeResearchEvidence({ input: input.research, taskHash: dialogue.taskHash, intentDigest: dialogue.intentDigest ?? null });
  if (research) normalized.research = research;
  requireThat(Array.isArray(normalized.resolvedFacts) && normalized.resolvedFacts.every((fact) => decisionItems.some((item) => item.questionId === fact.questionId && item.resolutionClass === "discoverable_fact") && text(fact.value) && list(fact.evidenceRefs) && fact.evidenceRefs.length > 0), "Resolved facts require a fact question and source evidence");
  return { ...normalized, discoveryDigest: productDesignDigest(normalized),
    claimBoundary: "Proposed requirements exploration. Answers, authorization and native invocation come from the current host, not this content." };
}

export function normalizeProductDesign({ input = null, dialogue, goalContract, research = null, requireResearch = false }) {
  if (input == null) return null;
  bind(input, dialogue, goalContract, "Product design");
  requireThat(text(input.designId) && Number.isInteger(input.revision) && input.revision > 0, "Design needs identity and positive revision");
  requireThat(["exploration", "delivery"].includes(input.mode), "Design mode must be exploration or delivery");
  if (input.lifecycle !== undefined) requireThat(milestonePolicy.lifecycleValues.includes(input.lifecycle), "Unknown design lifecycle");
  requireThat(list(input.sourceRefs) && input.sourceRefs.length > 0, "Design needs current source references");
  requireThat(!(input.decisionItems?.length), "Discover requirements before design; pass decisionItems through requirementsDiscoveryInput");
  const settled = new Set((dialogue.settledDecisionRefs ?? []).map((decision) => decision.decisionId));
  requireThat(list(input.settledDecisionRefs ?? []) && (input.settledDecisionRefs ?? []).every((id) => settled.has(id)), "Design references an unsettled decision");
  const journeys = structuredClone(input.userJourneys ?? []);
  const journeyIds = uniqueRows(journeys, "id", "User journeys");
  const criteria = new Set(goalContract.acceptanceCriteria.map((criterion) => criterion.id));
  const solutionOptions = structuredClone(input.solutionOptions ?? []);
  const optionIds = uniqueRows(solutionOptions, "id", "Product solution options");
  const experiences = new Set();
  for (const option of solutionOptions) {
    requireThat(text(option.mechanism) && text(option.scenario) && list(option.userFlow) && option.userFlow.length > 0,
      "Product options need a user scenario, solution mechanism and actual user flow");
    for (const key of ["benefits", "costs", "failureConditions", "unknowns", "evidenceRefs"]) requireThat(list(option[key] ?? []), `Product option ${key} must be a list`);
    const experience = productDesignDigest([option.scenario, option.userFlow, option.benefits ?? [], option.costs ?? [], option.failureConditions ?? []]);
    requireThat(!experiences.has(experience), "Execution tool substitutions with the same user flow and tradeoffs are not distinct product options");
    experiences.add(experience);
  }
  if (input.mode === "delivery" && solutionOptions.length > 0) requireThat(optionIds.has(input.selectedOptionId) && text(input.selectionRationale), "Delivery requires a selected product option and rationale");
  if (input.selectedOptionId !== undefined) requireThat(optionIds.has(input.selectedOptionId) && text(input.selectionRationale), "Selected product option needs an existing identity and rationale");
  for (const journey of journeys) {
    requireThat(text(journey.audience) && text(journey.motivation), "Journey requires audience and motivation");
    requireThat(Array.isArray(journey.steps) && journey.steps.length > 0 && journey.steps.every((step) => text(step.action) && text(step.feedback) && text(step.result)), "Journey needs concrete action, feedback and result");
    for (const key of ["rules", "failureRecovery", "resourceRefs", "criterionIds"]) requireThat(list(journey[key] ?? []), `Journey ${key} must be a string list`);
    requireThat((journey.criterionIds ?? []).every((id) => criteria.has(id)), "Journey references unknown goal criterion");
  }
  const slices = structuredClone(input.taskSlices ?? []);
  const researchRequired = requireResearch || research?.required === true;
  const knownResearch = new Set(research?.sources.map(source => source.id) ?? []);
  const researchRefs = input.researchRefs ?? [];
  requireThat(list(researchRefs) && researchRefs.every(id => knownResearch.has(id)), "Design references unknown research evidence");
  const researchGaps = researchRequired ? [...research?.gaps ?? ["required_research_missing"]] : [];
  checkDag(slices, "id");
  for (const slice of slices) {
    slice.scopeFiles ??= [];
    slice.inputRefs ??= [];
    if (research || researchRequired || slice.researchRefs !== undefined) {
      slice.researchRefs ??= [];
      requireThat(list(slice.researchRefs) && slice.researchRefs.every(id => knownResearch.has(id)), "Task slice references unknown research evidence");
    }
    if (researchRequired && !slice.researchRefs?.length && !text(slice.researchNotApplicableReason)) researchGaps.push(`task_research_binding_missing:${slice.id}`);
    requireThat(text(slice.outcome) && list(slice.capabilityNeed) && slice.capabilityNeed.length > 0, "Task slice needs outcome and capability demand");
    if (slice.taskFacts != null) {
      const taskFacts = readCurrentTaskFacts(slice.taskFacts, slice.outcome);
      requireThat(taskFacts, "Task slice requires current task-bound v2 design facts");
      slice.taskFacts = structuredClone(taskFacts);
    }
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
  const sharedState = structuredClone(input.sharedState ?? []);
  const interfaces = structuredClone(input.interfaces ?? []);
  const stateIds = uniqueRows(sharedState, "id", "Shared state");
  const interfaceIds = uniqueRows(interfaces, "id", "Shared interfaces");
  for (const state of sharedState) requireThat(text(state.description) && taskIds.has(state.ownerTaskId) && list(state.consumerTaskIds ?? []) &&
    (state.consumerTaskIds ?? []).every(id => taskIds.has(id)), "Shared state needs its actual owner, consumers and responsibility");
  for (const contract of interfaces) requireThat(taskIds.has(contract.producerTaskId) && list(contract.consumerTaskIds) && contract.consumerTaskIds.every(id => taskIds.has(id)) &&
    (text(contract.contract) || object(contract.contract)), "Interface needs producer, consumers and a concrete contract");
  for (const slice of slices) {
    for (const [key, known] of [["stateRefs", stateIds], ["interfaceRefs", interfaceIds]]) {
      requireThat(slice[key] === undefined || list(slice[key]) && slice[key].every(id => known.has(id)), `Task references unknown ${key}`);
    }
    requireThat(slice.domainTermRefs === undefined || list(slice.domainTermRefs) && slice.domainTermRefs.every(term => (input.domainTerms ?? []).some(item => (item.id ?? item.term) === term)), "Task references unknown domain terms");
  }
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
    if (flow.artifactKind !== undefined) requireThat(flow.artifactKind === "other" || milestonePolicy.milestones.some((rule) => rule.artifactKind === flow.artifactKind), "Unknown artifact kind");
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
    revisionContext: structuredClone(input.revisionContext ?? null), ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
    ...(input.solutionOptions !== undefined ? { solutionOptions } : {}),
    ...(input.selectedOptionId !== undefined ? { selectedOptionId: input.selectedOptionId, selectionRationale: input.selectionRationale } : {}),
    ...(input.sharedState !== undefined ? { sharedState } : {}), ...(input.interfaces !== undefined ? { interfaces } : {}),
    ...(slices.some(slice => slice.decisionRefs?.length) ? { decisions: structuredClone((dialogue.settledDecisionRefs ?? []).filter(decision => slices.some(slice => slice.decisionRefs?.includes(decision.decisionId)))) } : {}),
    ...(research || researchRequired ? { researchBinding: { required: researchRequired, digest: research?.digest ?? null,
      sourceIds: [...new Set([...researchRefs, ...slices.flatMap(slice => slice.researchRefs ?? [])])], gaps: researchGaps } } : {}) };
  const softwareDesign = normalizeSoftwareDesign({ input: input.softwareDesign, design: normalized, settledDecisionIds: settled, criterionIds: criteria });
  if (softwareDesign) {
    normalized.softwareDesign = softwareDesign;
    const softwareDecisions = new Set([...softwareDesign.architecture.decisionRefs,
      ...softwareDesign.modules.flatMap(module => module.decisionRefs), ...slices.flatMap(slice => slice.decisionRefs ?? [])]);
    normalized.decisions = structuredClone((dialogue.settledDecisionRefs ?? []).filter(decision => softwareDecisions.has(decision.decisionId)));
  }
  const revisionImpact = deriveDesignRevisionImpact(normalized);
  return { ...normalized, designDigest: productDesignDigest(normalized), uncoveredCriteria, revisionImpact,
    readiness: researchGaps.length ? "research_incomplete" : input.mode === "delivery" && slices.length > 0 && uncoveredCriteria.length === 0 ? "structure_ready_not_reviewed" : "design_incomplete",
    invocationStatus: "content_supplied_not_authenticated", nativeInvocationVerified: false };
}

export function deriveDesignRevisionImpact(design) {
  const revision = design.revisionContext;
  if (!revision) return null;
  requireThat(text(revision.previousRunId) && text(revision.previousDesignDigest) && list(revision.changeEvidenceRefs) && revision.changeEvidenceRefs.length > 0, "Design revision needs prior identity and change evidence");
  const declaredTasks = revision.directlyAffectedTaskIds ?? [];
  requireThat(list(declaredTasks), "Revision requires explicit affected task IDs");
  const ids = new Set(design.taskSlices.map((slice) => slice.id));
  requireThat(declaredTasks.every((id) => ids.has(id)), "Revision references unknown affected task");
  const directlyAffectedTaskIds = [...new Set([...declaredTasks, ...softwareAffectedTasks(design.softwareDesign, revision, design.taskSlices)])];
  requireThat(directlyAffectedTaskIds.length > 0, "Revision requires a concrete affected task, module, architecture or decision");
  const affected = new Set(directlyAffectedTaskIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const slice of design.taskSlices) if (!affected.has(slice.id) && (slice.dependsOn ?? []).some((id) => affected.has(id))) { affected.add(slice.id); changed = true; }
  }
  const candidates = revision.reuseCandidates ?? [];
  requireThat(Array.isArray(candidates), "Reuse candidates must be an array");
  for (const item of candidates) requireThat(ids.has(item.taskId ?? item.previousTaskId) && !affected.has(item.taskId ?? item.previousTaskId) && text(item.artifactRef) && /^[a-f0-9]{64}$/u.test(item.sha256 ?? "") && text(item.reason), "Invalid or affected reuse candidate");
  return { previousRunId: revision.previousRunId, directlyAffectedTaskIds, affectedTaskIds: [...affected].sort(),
    reuseCandidates: candidates.map((item) => ({ ...item, status: "requires_current_binding_and_review" })),
    status: "new_run_required", claimBoundary: "Explicit semantic impact plus dependency closure; old completion and review evidence are never copied." };
}

/** Consume a discovered route template; the design cannot supply an owner or
 * grant a tool. Per-slice templates were selected using its capability demand. */
export function projectDesignWorkerTasks({ design, runId, templates, research = null, projectContext = null, projectRoot = null }) {
  if (!design) return templates;
  requireThat(!design.researchBinding?.digest || design.researchBinding.digest === research?.digest, "Design research changed before task handoff");
  requireThat(design.revisionContext?.previousRunId !== runId, "Changed design requires a new run, not resume or overwrite");
  return design.taskSlices.map((slice, index) => {
    const packet = templates[index];
    requireThat(packet, "Design task has no discovered capability route");
    const scopeFiles = [...slice.scopeFiles];
    const taskPacketId = `${runId}-design-${slice.id}`;
    const sourceBindings = [...new Set(slice.inputRefs.length ? slice.inputRefs : design.sourceRefs)].map(ref => {
      const flow = design.artifactFlow.find(flow => flow.terminalArtifactRef === ref && flow.consumerTaskIds.includes(slice.id));
      if (flow) return { ref, status: "pending_upstream", producerTaskId: `${runId}-design-${flow.producerTaskId}` };
      if (/^[a-z][a-z0-9+.-]*:/iu.test(ref) && !path.isAbsolute(ref)) return { ref, status: "reference_only", limitation: "Reference is not an observed project file" };
      if (!projectRoot) return { ref, status: "unbound", limitation: "Current project root required before dispatch" };
      const checked = inspectTrustedPath(projectRoot, ref);
      if (!checked || !statSync(checked.target).isFile()) return { ref, status: "unavailable", limitation: "Source missing, outside the project or unsafe" };
      const bytes = readFileSync(checked.target);
      return { ref, status: "bound", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    });
    const softwareContext = softwareDesignForTask(design.softwareDesign, slice.id);
    const decisionIds = new Set([...(slice.decisionRefs ?? []), ...(softwareContext?.architecture.decisionRefs ?? []),
      ...(softwareContext?.modules.flatMap(module => module.decisionRefs) ?? [])]);
    const context = { schemaVersion: 1, taskPacketId, taskHash: design.taskHash, intentDigest: design.intentDigest, designDigest: design.designDigest,
      designId: design.designId, revision: design.revision, sliceId: slice.id,
      ...(design.selectedOptionId ? { selectedOption: design.solutionOptions.find(option => option.id === design.selectedOptionId), selectionRationale: design.selectionRationale } : {}),
      journeys: design.userJourneys.filter(journey => slice.journeyRefs?.includes(journey.id) || softwareContext?.modules.some(module => module.journeyRefs.includes(journey.id))),
      decisions: (design.decisions ?? []).filter(decision => decisionIds.has(decision.decisionId)),
      domainTerms: design.domainTerms.filter(term => !slice.domainTermRefs || slice.domainTermRefs.includes(term.id ?? term.term)),
      sharedState: (design.sharedState ?? []).filter(state => softwareContext?.modules.some(module => module.stateRefs.includes(state.id)) ||
        (slice.stateRefs ? slice.stateRefs.includes(state.id) : state.ownerTaskId === slice.id || state.consumerTaskIds?.includes(slice.id))),
      interfaces: (design.interfaces ?? []).filter(contract => softwareContext?.modules.some(module => module.interfaceRefs.includes(contract.id)) ||
        (slice.interfaceRefs ? slice.interfaceRefs.includes(contract.id) : contract.producerTaskId === slice.id || contract.consumerTaskIds.includes(slice.id))),
      ...(design.softwareDesign ? { softwareDesign: softwareContext } : {}),
      artifactFlow: design.artifactFlow.filter(flow => flow.producerTaskId === slice.id || flow.consumerTaskIds.includes(slice.id)), sourceBindings };
    const designContext = { ...context, digest: productDesignDigest(context), authority: "Task-scoped projection of the single PRD; no user approval or tool permission" };
    const ready = design.readiness === "structure_ready_not_reviewed" && scopeFiles.length > 0 && packet.workOrderReadiness === "ready" && !sourceBindings.some(source => source.status === "unavailable");
    return { ...packet, taskPacketId, roleInstanceId: slice.id, businessFlowLaneId: slice.id,
      coreProblem: slice.outcome, todayTask: slice.outcome, description: slice.outcome,
      output: slice.deliverables.map((item) => item.description).join("; "), deliverableLink: `design://${design.designId}/${slice.id}`,
      scopeFiles, shardScope: scopeFiles, dependsOn: (slice.dependsOn ?? []).map((id) => `${runId}-design-${id}`),
      dependencyEvidence: "explicit_design_dependencies", capabilityNeed: [...slice.capabilityNeed], capabilityRequirements: [...slice.capabilityNeed],
      acceptanceCriterionIds: [...slice.criterionIds], verifySteps: slice.verification.map((check, i) => ({ id: `${taskPacketId}-check-${i + 1}`, step: check.procedure, verify: check.expectedEvidence })),
      designBinding: { designId: design.designId, revision: design.revision, designDigest: design.designDigest, sliceId: slice.id, contextDigest: designContext.digest },
      designContext,
      ...(slice.taskFacts ? { taskFacts: structuredClone(slice.taskFacts), taskFactsSubject: slice.outcome } : {}),
      ...(slice.researchRefs?.length ? { researchContextBinding: { taskHash: design.taskHash, intentDigest: design.intentDigest } } : {}),
      ...(slice.researchRefs?.length ? { researchEvidence: researchForTask({ research, sourceIds: slice.researchRefs }) } : {}),
      ...(projectContext ? { projectContextBinding: { digest: projectContext.digest, lifecycle: projectContext.lifecycle,
        modules: projectContext.modules.filter(module => !scopeFiles.length || scopeFiles.some(file => module.directory === "." || file.startsWith(module.directory + "/"))),
        ...(projectContext.relatedCode ? { relatedCode: { ...projectContext.relatedCode,
          relations: projectContext.relatedCode.relations.filter(edge => scopeFiles.some(file =>
            file === edge.from || file === edge.to || edge.from.startsWith(file + "/") || edge.to.startsWith(file + "/"))) } } : {}),
        limitations: projectContext.limitations } } : {}),
      methodInputs: structuredClone(slice.methodInputs ?? null), ...(slice.methodCapabilityId ? { methodCapabilityId: slice.methodCapabilityId } : {}),
      ...(slice.methodKnowledgeAssetIds !== undefined ? { methodKnowledgeAssetIds: structuredClone(slice.methodKnowledgeAssetIds) } : {}),
      designTask: { completionDemo: slice.completionDemo, inputRefs: slice.inputRefs, deliverables: slice.deliverables, journeyRefs: slice.journeyRefs ?? [], decisionRefs: slice.decisionRefs ?? [], dependencyReasons: slice.dependencyReasons ?? [] },
      artifactFlowRefs: [...(slice.artifactFlowRefs ?? [])], artifactFlow: design.artifactFlow.filter((flow) => flow.producerTaskId === slice.id || flow.consumerTaskIds.includes(slice.id)),
      workOrderReadiness: ready ? "ready" : "incomplete", finalizationGate: ready ? packet.finalizationGate : "blocked_before_host_handoff" };
  });
}

/** Recheck the same task/PRD/source binding for native and injected dispatches. */
export async function verifyTaskDesignContext({ packet, projectRoot, upstreamResults = [] }) {
  if (!packet?.designBinding) return;
  const context = packet.designContext;
  requireThat(context, "Legacy design task needs current PRD context migration before dispatch");
  const { digest, authority, ...content } = context;
  requireThat(productDesignDigest(content) === digest && digest === packet.designBinding.contextDigest && context.designDigest === packet.designBinding.designDigest &&
    context.designId === packet.designBinding.designId && context.revision === packet.designBinding.revision && context.sliceId === packet.designBinding.sliceId &&
    context.taskPacketId === packet.taskPacketId, "Design context digest or current task binding changed");
  if (packet.intentBinding) requireThat(context.taskHash === packet.intentBinding.taskHash && (context.intentDigest ?? null) === (packet.intentBinding.intentDigest ?? null), "Design context must preserve current intent");
  for (const source of context.sourceBindings) {
    if (source.status === "reference_only") continue;
    let expected = source.sha256;
    if (source.status === "pending_upstream") {
      const producer = upstreamResults.find(result => result.taskPacketId === source.producerTaskId);
      const output = producer?.deliveryEnvelope?.reportedArtifactRefs?.find(artifact => artifact.ref === source.ref);
      requireThat(["completed", "pass"].includes(producer?.status) && /^[a-f0-9]{64}$/u.test(output?.sha256 ?? ""), `Upstream artifact ${source.ref} has no current producer evidence`);
      expected = output.sha256;
    } else requireThat(source.status === "bound", `Design input ${source.ref} is ${source.status}; return to Thinking for current source binding`);
    const checked = inspectTrustedPath(projectRoot, source.ref);
    requireThat(checked, `Design input ${source.ref} is missing or outside the trusted project`);
    const current = createHash("sha256").update(await fs.readFile(checked.target)).digest("hex");
    requireThat(current === expected, `Design input ${source.ref} changed; review the affected design before dispatch`);
  }
}

/** Project observed design-stage facts into existing node decisions, never selected owners or permissions. */
export function projectDesignHumanMilestones({ design, requirementsDiscovery, sideEffectActions = [], workerTaskPackets }) {
  const requests = [];
  const gaps = [];
  if (!design) return { requests, gaps };
  const packets = new Map(workerTaskPackets.filter((packet) => packet.designBinding).map((packet) => [packet.designBinding.sliceId, packet]));
  const taskIds = (ids) => ids.map((id) => packets.get(id)?.taskPacketId).filter(Boolean);
  const implementationIds = design.taskSlices.filter((slice) => slice.workKind !== "support").map((slice) => slice.id);
  const lifecycle = design.lifecycle ?? "unknown";
  const addGap = (id, reason, ids, sourceRefs) => gaps.push({ id, reason, taskPacketIds: taskIds(ids), sourceRefs,
    nextAction: { stage: "Thinking", action: "prepare_discovered_read_only_review_slice",
      slice: { id: `review-${id}`, workKind: "support", outcome: "Read the actual supplied plan and produce a reviewable artifact before implementation consumes it",
        capabilityNeed: ["read-only product or system design review"], inputRefs: sourceRefs,
        completionDemo: "Current artifact and source evidence ready for one human judgement" } } });
  for (const rule of milestonePolicy.milestones.filter((item) => item.beforeImplementation)) {
    if (implementationIds.length && !design.artifactFlow.some((flow) => flow.artifactKind === rule.artifactKind)) {
      addGap(rule.id, "reviewable_producer_required_before_implementation", implementationIds, design.sourceRefs);
    }
  }
  for (const flow of design.artifactFlow) {
    if (flow.artifactKind === "other") continue;
    const rule = milestonePolicy.milestones.find((item) => item.artifactKind === flow.artifactKind);
    if (!rule) { addGap(flow.id, "artifact_stage_facts_required", flow.consumerTaskIds, flow.sourceArtifactRefs); continue; }
    const producer = design.taskSlices.find((slice) => slice.id === flow.producerTaskId);
    if (rule.beforeImplementation && producer.workKind !== "support") {
      addGap(flow.id, "read_only_review_producer_required", [flow.producerTaskId, ...flow.consumerTaskIds], flow.sourceArtifactRefs); continue;
    }
    let trigger;
    const decisions = (requirementsDiscovery?.decisionItems ?? []).filter((item) => item.resolutionClass === "material_user_decision" &&
      item.affects.artifactFlowRefs?.includes(flow.id));
    if (rule.activation === "first_or_material") {
      if (lifecycle === "first_delivery") trigger = "first";
      else if (lifecycle === "material_revision" && design.revisionContext) trigger = "material_change";
      else if (lifecycle === "within_accepted_scope") trigger = "within_accepted_scope";
      else { addGap(flow.id, "lifecycle_source_evidence_required", flow.consumerTaskIds, design.sourceRefs); continue; }
    } else if (decisions.length) {
      if (rule.activation === "side_effect_decision" && !decisions.some((item) =>
        item.affects.sideEffectActions?.some((action) => sideEffectActions.includes(action)))) {
        addGap(flow.id, "current_flow_side_effect_evidence_required", flow.consumerTaskIds, flow.scopeEvidenceRefs); continue;
      }
      trigger = rule.triggers[0];
    } else { addGap(flow.id, "material_tradeoff_evidence_required", flow.consumerTaskIds, flow.scopeEvidenceRefs); continue; }
    const packet = packets.get(flow.producerTaskId);
    if (!packet) { addGap(flow.id, "discovered_producer_required", flow.consumerTaskIds, flow.sourceArtifactRefs); continue; }
    requests.push({ nodeId: stageLaneNodeId("Execution", packet.taskPacketId), milestoneId: rule.id, trigger,
      artifactRef: flow.terminalArtifactRef, artifactVersion: design.revision, flowId: flow.id, evidence: [
        { evidenceRef: `flow:${productDesignDigest(flow.id)}`, digest: `sha256:${productDesignDigest({ designId: design.designId, revision: design.revision, flow, producer: producer.deliverables })}` },
        ...decisions.map((decision) => ({ evidenceRef: `decision:${productDesignDigest(decision.questionId)}`, digest: `sha256:${productDesignDigest(decision)}` })),
      ] });
  }
  return { requests, gaps };
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
  requireThat(outcome.errors.length === 0 && !outcome.results.some((result) => result.status === "invalid"), "Outcome review contains an invalid observation binding or assessment");
  for (const observation of input.observations) {
    requireThat(list(observation.artifactRefs) && observation.artifactRefs.length > 0, "Each outcome observation must identify its reviewed artifacts");
    if (goal.acceptanceCriteria.find(criterion => criterion.id === observation.criterionId)?.measurement) {
      for (const sample of observation.measurement?.samples ?? []) {
        requireThat(observation.artifactRefs.includes(sample.evidenceRef) && snapshots.some(snapshot =>
          snapshot.ref === sample.evidenceRef && snapshot.verifiedSha256 === sample.evidenceDigest),
        "Numeric sample evidence must bind a current reviewed artifact snapshot");
      }
    }
    for (const ref of observation.artifactRefs) {
      const snapshot = snapshots.find((item) => item.ref === ref);
      const producer = snapshot && packets.find((packet) => packet.taskPacketId === snapshot.producerTaskId);
      requireThat(snapshot && producer?.acceptanceCriterionIds?.includes(observation.criterionId), "Observation artifact must belong to the task assigned this criterion");
    }
  }
  const revisionRequests = structuredClone(input.revisionRequests ?? []);
  requireThat(Array.isArray(revisionRequests), "Revision requests must be an array");
  for (const request of revisionRequests) {
    const target = packets.find((packet) => packet.taskPacketId === request.taskId);
    requireThat(target?.acceptanceCriterionIds?.includes(request.criterionId) &&
      ["Critical", "Fetch", "Thinking", "Execution"].includes(request.returnToStage) && text(request.finding) && text(request.requiredChange) &&
      list(request.evidenceRefs) && request.evidenceRefs.length > 0, "Revision needs the task's assigned criterion, evidence and concrete change");
    const related = input.observations.filter((observation) => observation.criterionId === request.criterionId &&
      request.evidenceRefs.some((ref) => ref === observation.evidenceRef || observation.artifactRefs.includes(ref)));
    requireThat(related.length > 0, "Revision must refer to this criterion's current observation and artifact");
    const result = outcome.results.find(result => result.criterionId === request.criterionId);
    const measuredFailure = result?.status === "fail" &&
      (result.reason === "numeric_target_not_met" && result.measurement?.status === "fail" ||
        result.reason === "measured_target_and_reported_assessment" && result.measurement?.status === "pass");
    requireThat(result?.reason === "reported_task_bound_assessment" || measuredFailure,
      "Revision requires a valid current criterion observation");
    request.artifactRefs = [...new Set(related.flatMap((observation) => observation.artifactRefs))];
  }
  const coveredTaskCriteria = input.observations.flatMap((observation) => snapshots.filter((snapshot) => observation.artifactRefs.includes(snapshot.ref)).map((snapshot) => ({
    taskId: snapshot.producerTaskId, criterionId: observation.criterionId, artifactRef: snapshot.ref, sha256: snapshot.verifiedSha256,
    verdict: outcome.results.find((result) => result.criterionId === observation.criterionId).status,
  })));
  const review = { schemaVersion: 1, runId: artifact.runId, reviewDigest: productDesignDigest(input), reviewRef: input.reviewRef,
    designDigest: design?.designDigest ?? null, artifactSnapshots: snapshots, outcomeEvaluation: outcome, revisionRequests, coveredTaskCriteria,
    nextAction: revisionRequests.length ? { action: "revise", stage: revisionRequests[0].returnToStage, taskIds: [...new Set(revisionRequests.map((request) => request.taskId))] }
      : { action: outcome.status === "pass" ? "continue_verification" : "obtain_missing_outcome_evidence", stage: "Review", taskIds: [] },
    status: outcome.status, evidenceKind: "supplied_assessment_with_current_artifact_binding", nativeInvocationVerified: false,
    claimBoundary: "Current artifact bytes and supplied independent assessments were checked; host invocation and user acceptance are not authenticated here." };
  evaluatedOutcomeReviews.set(review, structuredClone(review));
  return review;
}

/** Same-process validated content, not native human acceptance or execution permission. */
export function readEvaluatedOutcomeReview(review) {
  if (review == null) return null;
  const snapshot = evaluatedOutcomeReviews.get(review);
  requireThat(snapshot, "Current evaluated outcome review required");
  return structuredClone(snapshot);
}

export function projectProductReview(artifact, review) {
  const core = artifact.coreLoop;
  const prior = artifact.reviewPacket ?? core?.reviewPacket ?? {};
  const nextAction = artifact.machineExecution?.nextAction ?? review.nextAction;
  const findings = review.revisionRequests.map((request) => ({ findingId: `outcome-${productDesignDigest([review.reviewDigest, request.taskId, request.criterionId]).slice(0, 16)}`,
    taskPacketId: request.taskId, criterionId: request.criterionId, severity: "high", finding: request.finding, summary: request.finding,
    requiredChange: request.requiredChange, returnToStage: request.returnToStage, evidenceRefs: request.evidenceRefs, status: "open" }));
  const reviewPacket = { ...prior, ...(review.status === "pass" ? {} : { status: "partial" }), qualityGate: review.status === "pass" ? prior.qualityGate ?? "partial" : "partial",
    revisionNeeded: findings.length > 0, findings: [...(prior.findings ?? []).filter((finding) => !String(finding.findingId ?? "").startsWith("outcome-")), ...findings],
    outcomeReviewRef: review.reviewRef, revisionRequests: review.revisionRequests, nextAction };
  const traceEvalControlPlane = { ...(artifact.traceEvalControlPlane ?? core?.traceEvalControlPlane), outcomeEvaluation: review.outcomeEvaluation };
  return { ...artifact, ...(review.status === "pass" ? {} : { status: "partial" }), outcomeReviewPacket: review, reviewPacket, traceEvalControlPlane,
    ...(artifact.defaultRuntimePath ? { defaultRuntimePath: { ...artifact.defaultRuntimePath, traceEvalControlPlane } } : {}),
    ...(core ? { coreLoop: { ...core, outcomeReviewPacket: review, reviewPacket, traceEvalControlPlane } } : {}),
    ...(artifact.summaryPacket ? { summaryPacket: { ...artifact.summaryPacket, nextAction: JSON.stringify(nextAction), publicReady: false } } : {}) };
}
