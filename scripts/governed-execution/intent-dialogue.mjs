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
  return workerTaskPackets.map((packet) => {
    const implementation = packet.executionMode === "primary_execution" &&
      ["backend", "frontend", "worker"].includes(packet.roleDisplayName);
    const addDesign = dialogue.deliveryStrategy === "long_term_extensible" && direction?.applies !== false && implementation;
    const selected = addDesign && architecture ? [architecture] : [];
    const skills = [...(packet.skillLoadout ?? [])];
    for (const provider of selected) if (!skills.some((item) => item.id === provider.id)) skills.push(provider);
    const binding = {
      taskHash: dialogue.taskHash, confirmedOutcome: dialogue.outcome,
      intentDigest: dialogue.intentDigest ?? null, constraints: dialogue.constraints,
      settledDecisionRefs: dialogue.settledDecisionRefs,
      invocationState: "selected_not_invoked",
    };
    return {
      ...packet, intentBinding: binding,
      coreProblem: dialogue.outcome,
      todayTask: implementation ? `${dialogue.outcome}\n${packet.todayTask ?? ""}`.trim() : packet.todayTask,
      acceptanceCriteria: [...(packet.acceptanceCriteria ?? []),
        ...dialogue.acceptanceCriteria.map((criterion) => criterion.description)],
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
