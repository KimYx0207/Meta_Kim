import { createHash } from "node:crypto";
import { taskOutcomeDigest, buildTaskGoalContract } from "../../src/domain/governance/task-outcome.mjs";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
  return value;
}

function refs(value) {
  return Array.isArray(value) && value.length > 0 &&
    value.every((ref) => typeof ref === "string" && ref.trim());
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

/** Attach Thinking's allocation to existing goal and task identities only.
 * This input cannot create a task, change a requirement or grant permission.
 */
export function normalizeTaskCriterionAssignments({ dialogue, input = null }) {
  if (input == null) return null;
  if (dialogue?.status !== "host_provided_understanding" || input.taskHash !== dialogue.taskHash || input.intentDigest !== dialogue.intentDigest) {
    throw new TypeError("Task criterion assignments must bind the existing confirmed goal and intent digest");
  }
  if (!Array.isArray(input.assignments)) throw new TypeError("Task criterion assignments must be an array");
  const criteria = new Set(dialogue.acceptanceCriteria.map((criterion) => criterion.id));
  const identities = new Set();
  const assignments = [];
  for (const assignment of input.assignments) {
    if (!assignment || Boolean(assignment.taskPacketId) === Boolean(assignment.roleInstanceId)) throw new TypeError("Each criterion assignment requires exactly one selected task identity");
    const key = assignment.taskPacketId ? "taskPacketId" : "roleInstanceId";
    if (typeof assignment[key] !== "string" || !assignment[key].trim() || identities.has(`${key}:${assignment[key]}`)) throw new TypeError("Unknown, ambiguous or duplicate task criterion assignment");
    identities.add(`${key}:${assignment[key]}`);
    if (!Array.isArray(assignment.criterionIds) || assignment.criterionIds.some((id) => !criteria.has(id)) || new Set(assignment.criterionIds).size !== assignment.criterionIds.length) {
      throw new TypeError("Task criterion assignment references unknown or duplicate goal criterion IDs");
    }
    assignments.push({ [key]: assignment[key], criterionIds: [...assignment.criterionIds].sort() });
  }
  assignments.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { taskHash: input.taskHash, intentDigest: input.intentDigest, assignments };
}

export function applyTaskCriterionAssignments({ workerTaskPackets, dialogue, input = null }) {
  const normalized = normalizeTaskCriterionAssignments({ dialogue, input });
  if (normalized == null) return workerTaskPackets;
  const assigned = new Map();
  for (const assignment of normalized.assignments) {
    const matches = workerTaskPackets.filter((packet) => assignment.taskPacketId ? packet.taskPacketId === assignment.taskPacketId : packet.roleInstanceId === assignment.roleInstanceId);
    if (matches.length !== 1 || assigned.has(matches[0].taskPacketId)) throw new TypeError("Unknown, ambiguous or duplicate task criterion assignment");
    assigned.set(matches[0].taskPacketId, assignment.criterionIds);
  }
  return workerTaskPackets.map((packet) => ({ ...packet, acceptanceCriterionIds: assigned.get(packet.taskPacketId) ?? [] }));
}

/** Derived coverage of the existing goal IDs, never a second requirements ledger. */
export function buildIntentCriterionCoverage({ workerTaskPackets, dialogue }) {
  const criteria = dialogue?.acceptanceCriteria ?? [];
  const rows = criteria.map((criterion) => {
    const assigned = workerTaskPackets.filter((packet) => packet.acceptanceCriterionIds?.includes(criterion.id));
    const producers = assigned.filter((packet) => ["primary_execution", "local_tool_execution", "factory_then_dispatch", "verification_execution"].includes(packet.executionMode));
    return { criterionId: criterion.id, required: criterion.required !== false,
      producerTaskIds: producers.map((packet) => packet.taskPacketId),
      verificationOwners: [...new Set(producers.map((packet) => packet.handoffTarget).filter(Boolean))],
      status: producers.length && producers.every((packet) => packet.handoffTarget) ? "assigned_not_verified" : "unassigned" };
  });
  const unknownAssignments = workerTaskPackets.flatMap((packet) => strings(packet.acceptanceCriterionIds)
    .filter((id) => !criteria.some((criterion) => criterion.id === id))
    .map((criterionId) => ({ taskPacketId: packet.taskPacketId, criterionId })));
  return { source: "intentBinding.acceptanceCriteria", status: unknownAssignments.length || rows.some((row) => row.required && row.status === "unassigned") ? "incomplete" : criteria.length ? "assigned_not_verified" : "not_supplied", rows, unknownAssignments,
    claimBoundary: "Ownership projection only; no deliverable evidence or semantic compliance has been established." };
}

export function intentDialogueDigest(intent) {
  return createHash("sha256").update(JSON.stringify(canonical({
    taskHash: intent.taskHash,
    outcome: intent.outcome.trim(),
    constraints: intent.constraints ?? {},
    acceptanceCriteria: intent.acceptanceCriteria?.length
      ? buildTaskGoalContract({ task: intent.outcome, acceptanceCriteria: intent.acceptanceCriteria }).acceptanceCriteria : [],
    settledDecisions: intent.settledDecisions ?? [],
    evidenceRefs: intent.evidenceRefs ?? [],
  }))).digest("hex");
}

/** Consume the current host's Thinking work orders, not a second task planner.
 * The host performs semantic judgment. These bindings grant no tool permission.
 */
export function normalizeHostThinking({ input = null, task, dialogue, requirementsDiscovery = null }) {
  if (input == null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input) || input.taskHash !== taskOutcomeDigest(task) ||
      (input.intentDigest ?? null) !== (dialogue.intentDigest ?? null) ||
      (input.requirementsDigest ?? null) !== (requirementsDiscovery?.discoveryDigest ?? null)) {
    throw new TypeError("Thinking must bind the current original task, intent and requirements materials");
  }
  if (!refs(input.evidenceRefs) || !input.intentPacket || input.intentPacket.realIntent !== dialogue.outcome ||
      !Array.isArray(input.intentPacket.blockingUnknowns) || !Array.isArray(input.intentPacket.nonGoals) ||
      !Array.isArray(input.intentPacket.successCriteria) || !input.intentPacket.successCriteria.length ||
      !refs(input.intentPacket.evidenceRefs)) {
    throw new TypeError("The current host must supply Critical understanding, evidence and its unresolved questions");
  }
  const thinking = input.thinkingPacket;
  if (!thinking || typeof thinking.designFrame !== "string" || !thinking.designFrame.trim() ||
      !Array.isArray(thinking.consideredLanes) || !thinking.consideredLanes.length ||
      !Array.isArray(thinking.omittedLanesWithReason) || !Array.isArray(thinking.workerTaskPackets) ||
      !thinking.workerTaskPackets.length || !/^[a-f0-9]{64}$/u.test(input.fetchPacket?.capabilityDiscovery?.inventoryDigest ?? "")) {
    throw new TypeError("Thinking needs the actual Fetch inventory, considered routes and existing worker task fields");
  }
  const ids = new Set();
  for (const packet of thinking.workerTaskPackets) {
    if (!packet || typeof packet !== "object" || Array.isArray(packet) ||
        typeof packet.roleInstanceId !== "string" || !packet.roleInstanceId.trim() || ids.has(packet.roleInstanceId) ||
        typeof packet.todayTask !== "string" || !packet.todayTask.trim() ||
        typeof packet.output !== "string" || !packet.output.trim() ||
        !refs(packet.capabilityNeed) || !refs(packet.evidenceRefs) ||
        !Array.isArray(packet.scopeFiles) || packet.scopeFiles.some((file) => typeof file !== "string" || !file.trim()) ||
        !refs(packet.shardScope) ||
        !Array.isArray(packet.nonGoals) || !Array.isArray(packet.toolRequirements) ||
        !Array.isArray(packet.dependsOn) || !Array.isArray(packet.acceptanceCriterionIds) ||
        !Array.isArray(packet.verifySteps) || !packet.verifySteps.length ||
        typeof packet.selectionReason !== "string" || !packet.selectionReason.trim() ||
        typeof packet.roleDisplayName !== "string" || !packet.roleDisplayName.trim() ||
        typeof packet.handoffTarget !== "string" || !packet.handoffTarget.trim() || packet.qualityBar == null ||
        typeof packet.referenceDirection !== "string" || !packet.referenceDirection.trim() ||
        !packet.selectedCapabilityProviders?.agent ||
        !["read_only_worker", "read_only_support", "local_write", "external_write"].includes(packet.effectClass)) {
      throw new TypeError("Each Thinking work order needs its current operation, scope, needs, selected inventory objects and verification");
    }
    if (packet.verifySteps.some((step) => !step || !["id", "step", "verify"].every((key) => typeof step[key] === "string" && step[key].trim()))) {
      throw new TypeError("Thinking verification must retain the existing verifySteps contract");
    }
    if (packet.handoffContract?.handoffTo && packet.handoffContract.handoffTo !== packet.handoffTarget) throw new TypeError("Thinking handoff target conflict");
    for (const key of ["trusted", "permissions", "authorization", "executionAllowed", "nativeInvocationVerified", "workOrderReadiness", "safetyEvidence", "ownerSource", "ownerContract", "ownerBindingMode", "nativeAgentType", "codexSpawnBinding", "agentCapabilityProfile"]) {
      if (Object.hasOwn(packet, key)) throw new TypeError("A Thinking work order cannot assert " + key);
    }
    ids.add(packet.roleInstanceId);
  }
  const criteria = new Set(dialogue.acceptanceCriteria.map((criterion) => criterion.id));
  const pending = new Map(thinking.workerTaskPackets.map((packet) => {
    if (packet.acceptanceCriterionIds.some((id) => !criteria.has(id)) ||
        packet.dependsOn.some((id) => !ids.has(id) || id === packet.roleInstanceId)) {
      throw new TypeError("Thinking must preserve the existing goal criterion and task dependency identities");
    }
    return [packet.roleInstanceId, new Set(packet.dependsOn)];
  }));
  while (pending.size) {
    const ready = [...pending].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id);
    if (!ready.length) throw new TypeError("Thinking task dependency cycle");
    for (const id of ready) pending.delete(id);
    for (const dependencies of pending.values()) for (const id of ready) dependencies.delete(id);
  }
  return { taskHash: input.taskHash, intentDigest: input.intentDigest ?? null,
    requirementsDigest: input.requirementsDigest ?? null, evidenceRefs: [...input.evidenceRefs],
    intentPacket: structuredClone(input.intentPacket), fetchPacket: structuredClone(input.fetchPacket),
    thinkingPacket: structuredClone(thinking), nativeInvocationVerified: false, executionAllowed: false };
}

/** The native host supplies Critical reasoning; absence is not clarity. */
export function normalizeHostCritical({ input = null, task, dialogue }) {
  if (input == null) return null;
  if (!input || input.taskHash !== taskOutcomeDigest(task) || (input.intentDigest ?? null) !== (dialogue.intentDigest ?? null) ||
      input.realIntent !== dialogue.outcome || !refs(input.evidenceRefs) ||
      !Array.isArray(input.blockingUnknowns) || input.blockingUnknowns.some((id) => typeof id !== "string" || !id.trim()) ||
      !Array.isArray(input.nonGoals) || !Array.isArray(input.successCriteria) || !input.successCriteria.length) {
    throw new TypeError("Critical requires the current task/intent, evidence, success criteria, non-goals and unresolved decision IDs");
  }
  const structured = typeof input.successCriteria[0] !== "string";
  if (input.nonGoals.some((value) => typeof value !== "string" || !value.trim()) || input.successCriteria.some((criterion) =>
    structured
      ? !criterion || typeof criterion !== "object" || Array.isArray(criterion) ||
        ["id", "condition", "evidenceRequired"].some((key) => typeof criterion[key] !== "string" || !criterion[key].trim())
      : typeof criterion !== "string" || !criterion.trim())) {
    throw new TypeError("Critical needs text success criteria or structured id/condition/evidenceRequired definitions, and text non-goals");
  }
  if (structured && new Set(input.successCriteria.map((criterion) => criterion.id)).size !== input.successCriteria.length) {
    throw new TypeError("Structured Critical criterion identities must be unique");
  }
  return structuredClone(input);
}

/** Map validated Critical content only at the existing Goal text boundary. */
export function hostCriticalGoalCriteria({ task, critical }) {
  if (typeof critical.successCriteria[0] === "string") return buildTaskGoalContract({ task }).acceptanceCriteria.map((criterion) => ({
    ...criterion, description: critical.successCriteria.join("\n"),
  }));
  return critical.successCriteria.map((criterion) => ({
    id: criterion.id, description: `${criterion.condition}\nevidenceRequired: ${criterion.evidenceRequired}`,
    kind: "semantic", required: true,
  }));
}

/** Compare validated current conditions, not object order or source refs. */
export function sameHostCriticalMeaning(left, right) {
  const meaning = (packet) => [
    packet.successCriteria.map((criterion) => JSON.stringify(canonical(typeof criterion === "string" ? criterion.trim() : {
      id: criterion.id, condition: criterion.condition.trim(), evidenceRequired: criterion.evidenceRequired.trim(),
    }))),
    packet.nonGoals.map((value) => value.trim()), packet.blockingUnknowns,
  ].map((values) => [...new Set(values)].sort());
  return JSON.stringify(meaning(left)) === JSON.stringify(meaning(right));
}

/** Consume the existing host-provided understanding boundary, never grant authority.
 * The caller must source that boundary from parsed conversation input. A CLI
 * object, native challenge claim or host-answer substrate is not confirmation.
 * This function neither authenticates native evidence nor grants Permission.
 */
export function prepareIntentDialogue({ task, confirmedIntent = null, sharedUnderstandingConfirmed = null } = {}) {
  const taskHash = taskOutcomeDigest(task);
  const empty = {
    taskHash, status: "not_supplied", outcome: task.trim(), constraints: {},
    acceptanceCriteria: [], settledDecisionRefs: [], evidenceRefs: [],
    routeTask: task.trim(), deliveryStrategy: null, executionAllowed: false,
    nativeInvocationVerified: false,
  };
  if (confirmedIntent == null) return empty;
  if (confirmedIntent.taskHash !== taskHash) throw new TypeError("Confirmed intent must bind the original user task");
  if (typeof confirmedIntent.outcome !== "string" || !confirmedIntent.outcome.trim() || !refs(confirmedIntent.evidenceRefs)) {
    throw new TypeError("Intent requires an outcome and source evidence references");
  }
  const constraints = confirmedIntent.constraints ?? {};
  if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) throw new TypeError("Intent constraints must be a record");
  const strategy = constraints.deliveryStrategy ?? null;
  if (strategy != null && !["fast_usable", "long_term_extensible"].includes(strategy)) throw new TypeError("Unknown delivery strategy");
  const decisions = confirmedIntent.settledDecisions ?? [];
  if (!Array.isArray(decisions) || decisions.some((decision) =>
    typeof decision?.decisionId !== "string" || !decision.decisionId.trim() ||
    typeof decision.value !== "string" || !decision.value.trim() || !refs(decision.evidenceRefs))) {
    throw new TypeError("Settled decisions require identity, value and source references");
  }
  if (new Set(decisions.map((decision) => decision.decisionId)).size !== decisions.length) {
    throw new TypeError("Settled decision identities must be unique");
  }
  if (!Array.isArray(confirmedIntent.acceptanceCriteria ?? [])) throw new TypeError("Acceptance criteria must be a list");
  const digest = intentDialogueDigest(confirmedIntent);
  const understanding = sharedUnderstandingConfirmed;
  const bound = understanding?.trusted === true &&
    understanding.binding === "plan-challenge-understanding-confirmation" &&
    understanding.taskHash === taskHash && understanding.intentDigest === digest &&
    refs(understanding.evidenceRefs) &&
    confirmedIntent.evidenceRefs.every((ref) => understanding.evidenceRefs.includes(ref));
  if (!bound) return {
    ...empty, status: "advisory_not_confirmed", suppliedIntentDigest: digest,
    claimBoundary: "Caller-supplied input is not a confirmed choice or permission.",
  };
  const outcome = confirmedIntent.outcome.trim();
  const direction = strategy === "long_term_extensible"
    ? "Architecture, extension boundaries and maintainability are required for the confirmed outcome."
    : strategy === "fast_usable"
      ? "Use the smallest reversible implementation that delivers the confirmed outcome promptly."
      : "";
  return {
    ...empty, status: "host_provided_understanding", outcome, constraints,
    acceptanceCriteria: confirmedIntent.acceptanceCriteria?.length
      ? buildTaskGoalContract({ task, acceptanceCriteria: confirmedIntent.acceptanceCriteria }).acceptanceCriteria : [],
    intentDigest: digest, deliveryStrategy: strategy,
    settledDecisionRefs: decisions.map((decision) => ({ ...decision })),
    evidenceRefs: [...confirmedIntent.evidenceRefs],
    understandingEvidenceRefs: [...understanding.evidenceRefs],
    // Do not leak packet field labels (e.g. "decision" or "deliveryStrategy")
    // into the lexical task classifier as invented business-domain signals.
    routeTask: [task.trim(), outcome, direction,
      ...Object.entries(constraints).filter(([key]) => key !== "deliveryStrategy")
        .map(([, value]) => typeof value === "string" ? value : JSON.stringify(value)),
      ...decisions.map((decision) => decision.value)].filter(Boolean).join("\n"),
    claimBoundary: "Consumes the existing host-provided understanding boundary; not native answer authentication, execution authority or Permission.",
  };
}

/** Bind an already discovered design capability to implementation work only.
 * Runtime tools, required implementation skills and permission gates remain
 * owned by the existing route. A missing match stays an explicit gap.
 */
export function bindIntentToWorkerTasks({ workerTaskPackets, routeResult, dialogue }) {
  const direction = routeResult?.recommendedRoute?.intentDirectionSelection;
  // Selection stays in the existing route selector, including its eligibility
  // and reference-only policy. Never pick from an unfiltered inventory here.
  const selectedArchitecture = routeResult?.recommendedRoute?.selectedCapabilityProviders?.intentArchitecture;
  const architecture = direction?.selectionPolicy === "capability_need_runtime_match" &&
    direction.status === "selected_not_invoked" &&
    direction.selectedProvider?.id === selectedArchitecture?.id &&
    selectedArchitecture?.routeEligible !== false && selectedArchitecture?.executionEligible !== false &&
    selectedArchitecture?.cacheEvidenceOnly !== true
      ? selectedArchitecture : null;
  const primaryWorkers = workerTaskPackets.filter((packet) => ["primary_execution", "local_tool_execution", "factory_then_dispatch"].includes(packet.executionMode));
  const outcomeWorkers = primaryWorkers.length ? primaryWorkers
    : workerTaskPackets.filter((packet) => packet.executionMode === "verification_execution");
  const globalNonGoals = [...strings(dialogue.constraints?.nonGoals), ...strings(dialogue.constraints?.forbidden)];
  return workerTaskPackets.map((packet) => {
    const implementation = packet.executionMode === "primary_execution" &&
      ["backend", "frontend", "worker"].includes(packet.roleDisplayName);
    const addDesign = dialogue.deliveryStrategy === "long_term_extensible" && direction?.applies !== false && implementation;
    const selected = addDesign && architecture ? [architecture] : [];
    const skills = [...(packet.skillLoadout ?? [])];
    for (const provider of selected) if (!skills.some((item) => item.id === provider.id)) skills.push(provider);
    const binding = {
      taskHash: dialogue.taskHash, status: dialogue.status, confirmedOutcome: dialogue.outcome,
      intentDigest: dialogue.intentDigest ?? null, constraints: dialogue.constraints,
      acceptanceCriteria: dialogue.acceptanceCriteria,
      settledDecisionRefs: dialogue.settledDecisionRefs,
      invocationState: "selected_not_invoked",
      acceptanceRole: "global_context_not_per_worker_ownership",
      constraintPrecedence: "User constraints and non-goals take precedence over generic Skill or method recommendations; unresolved conflicts require review evidence, not a success claim.",
    };
    const hasExplicitAssignment = Array.isArray(packet.acceptanceCriterionIds);
    const acceptanceCriterionIds = hasExplicitAssignment ? [...new Set(strings(packet.acceptanceCriterionIds))]
      : outcomeWorkers.length === 1 && outcomeWorkers[0] === packet ? dialogue.acceptanceCriteria.map((criterion) => criterion.id) : [];
    const assignedCriteria = dialogue.acceptanceCriteria.filter((criterion) => acceptanceCriterionIds.includes(criterion.id));
    return {
      ...packet, intentBinding: binding,
      acceptanceCriterionIds,
      criterionAssignmentSource: hasExplicitAssignment ? "explicit_goal_ids" : acceptanceCriterionIds.length ? primaryWorkers.length ? "sole_primary_outcome_owner" : "sole_verification_outcome_owner" : "unassigned",
      nonGoals: [...new Set([...strings(packet.nonGoals), ...globalNonGoals])],
      coreProblem: dialogue.outcome,
      todayTask: implementation ? `${dialogue.outcome}\n${packet.todayTask ?? ""}`.trim() : packet.todayTask,
      acceptanceCriteria: [...(packet.acceptanceCriteria ?? []),
        ...assignedCriteria.map((criterion) => criterion.description)],
      handoffContract: { ...packet.handoffContract,
        requiredConstraintReview: { constraints: dialogue.constraints, nonGoals: globalNonGoals, criterionIds: acceptanceCriterionIds,
          status: "required_not_reviewed", evidenceRequirement: "Review the actual deliverable against user constraints, including conflicts with generic selected methods." } },
      skillLoadout: skills,
      capabilityBindings: { ...packet.capabilityBindings, skills, intentBinding: binding },
      capabilityLoadout: { ...packet.capabilityLoadout,
        repoSkills: skills.map((provider) => provider.id),
        runtimeSkillCandidates: skills.map((provider) => provider.id) },
      intentCapabilitySelection: {
        deliveryStrategy: dialogue.deliveryStrategy,
        capabilityNeed: addDesign ? ["architecture and extension boundaries"] : [],
        selectedProviders: selected,
        status: addDesign && !architecture ? "capability_gap" : "bound",
        whySelected: addDesign
          ? "Confirmed long-term direction requires a discovered architecture capability before implementation."
          : "Retain the existing implementation loadout and the smallest task boundary.",
        invocationState: "selected_not_invoked",
      },
    };
  });
}

export function routeCandidateOptions(routeResult) {
  const card = routeResult?.decisionCard;
  const routes = routeResult?.rankedRoutes ?? [];
  const feasible = routes.filter((route) =>
    route.score >= 70 && !(route.blockedReasons?.length)).slice(0, 3);
  const options = card?.options?.length ? card.options : feasible.length ? feasible :
    routeResult?.recommendedRoute ? [routeResult.recommendedRoute] : [];
  return options.map((option) => ({
    optionId: option.id, whatChanges: option.bestFor ?? option.weapon ?? option.id,
    problemSolved: option.benefit ?? "Uses capabilities discovered for the current task.",
    expectedResult: option.expectedResult ?? "Deliver the user outcome through this bounded route.",
    advantages: [option.benefit ?? option.verificationMethod ?? "Evidence-backed capability fit"],
    disadvantages: [option.cost ?? "Cost and duration require task-specific evidence."],
    evidenceRefs: ["selectedExecutionRoute.rankedRoutes", "selectedExecutionRoute.ownerDiscoveryPacket"],
    decisionImpact: option.risk ?? "Changes the selected owner, provider loadout and verification path.",
    candidateOwners: [option.owner ?? routeResult?.recommendedRoute?.owner].filter(Boolean),
    candidateTaskShape: "task_bound_route",
  }));
}
