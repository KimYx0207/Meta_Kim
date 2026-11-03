import { createHash } from "node:crypto";

export const TASK_PROGRESS_POLICY = Object.freeze({
  id: "task-progress-v1",
  sourcePolicyRef: "config/contracts/core-loop-contract.json#/productExperienceCoreGoals/supportGateRequirements/P-107",
  sameBasisIneffectiveThreshold: 2,
  units: "terminal_execution_attempt_per_logical_task",
  ignoredClassifications: ["waiting", "question", "running", "paused"],
  nonCountingTerminalClassifications: ["unresolved"],
  mutationAuthority: "none",
});

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value) => typeof value === "string" && value.trim().length > 0;
const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const terminal = (classification) => ["progress", "ineffective"].includes(classification);
const lifecycleFinished = (classification) => terminal(classification) || TASK_PROGRESS_POLICY.nonCountingTerminalClassifications.includes(classification);
const requireValue = (condition, reason) => { if (!condition) throw new Error(reason); };
const logicalId = (packet) => packet.logicalTaskPacketId || packet.taskPacketId;

/** Stable criterion identities come from the current goal, never observation labels. */
export function taskProgressGoal(critical) {
  const criteria = critical.successCriteria.map((criterion) => {
    const description = typeof criterion === "string" ? criterion : criterion.description || criterion.condition || JSON.stringify(criterion);
    return { criterionId: typeof criterion === "object" && text(criterion.id) ? criterion.id : `criterion:${hash(description)}`, description };
  });
  requireValue(new Set(criteria.map((criterion) => criterion.criterionId)).size === criteria.length
    && new Set(criteria.map((criterion) => criterion.description.trim())).size === criteria.length, "task_progress_duplicate_goal_criterion");
  return { goalDigest: hash([critical.realIntent, criteria]), criteria };
}

/** Human descriptions and task nicknames are deliberately absent from route identity. */
export function taskProgressRoute(packet) {
  return hash({ capabilityId: packet.capabilityId, strategyId: packet.strategyRef?.id,
    strategyContent: packet.strategyRef?.sha256, method: packet.methodCapabilityId ?? null });
}

export function taskProgressEvidenceBasis(evidence) {
  return hash([...new Set(evidence.map((item) => item.sha256))].sort());
}

/** Validate once at the checkpoint/observed-result boundary. No counter is caller writable. */
export function checkedTaskProgress(raw, packet, goal) {
  requireValue(raw && typeof raw === "object" && !Array.isArray(raw), "task_progress_observation_missing");
  requireValue(text(packet.capabilityId) && text(packet.strategyRef?.id) && sha(packet.strategyRef?.sha256), "task_progress_stable_route_required");
  requireValue(text(raw.attemptId) && raw.attemptId.length <= 160 && !/[\u0000-\u001f]/u.test(raw.attemptId), "task_progress_attempt_invalid");
  requireValue(goal.criteria.some((criterion) => criterion.criterionId === raw.criterionId)
    && packet.acceptanceCriterionIds?.includes(raw.criterionId), "task_progress_criterion_mismatch");
  requireValue(["progress", "ineffective", ...TASK_PROGRESS_POLICY.ignoredClassifications, ...TASK_PROGRESS_POLICY.nonCountingTerminalClassifications].includes(raw.classification), "task_progress_classification_invalid");
  requireValue(Array.isArray(raw.basisEvidence) && raw.basisEvidence.length > 0 && raw.basisEvidence.length <= 64
    && raw.basisEvidence.every((item) => item && text(item.ref) && sha(item.sha256)), "task_progress_basis_missing");
  requireValue(Array.isArray(raw.evidenceRefs) && raw.evidenceRefs.length > 0 && raw.evidenceRefs.length <= 64
    && raw.evidenceRefs.every(text), "task_progress_evidence_missing");
  requireValue(!lifecycleFinished(raw.classification) || sha(raw.resultDigest), "task_progress_result_digest_invalid");
  requireValue(!lifecycleFinished(raw.classification) || text(raw.resultRef) && raw.evidenceRefs.includes(raw.resultRef), "task_progress_result_reference_missing");
  requireValue(raw.classification !== "ineffective" || ["execution_failed", "criterion_not_met"].includes(raw.failureClass), "task_progress_failure_class_invalid");
  requireValue(raw.classification !== "progress" || Array.isArray(raw.criterionEvidence) && raw.criterionEvidence.length > 0 && raw.criterionEvidence.length <= 64
    && raw.criterionEvidence.every((item) => item && text(item.ref) && sha(item.sha256)), "task_progress_criterion_evidence_missing");
  requireValue(!["waiting", "paused", "question", "unresolved"].includes(raw.classification) || text(raw.waitReason), "task_progress_wait_reason_missing");
  return { attemptId: raw.attemptId, criterionId: raw.criterionId, classification: raw.classification,
    failureClass: raw.classification === "ineffective" ? raw.failureClass : null,
    basisEvidence: raw.basisEvidence.map(({ ref, sha256 }) => ({ ref, sha256 })),
    resultDigest: lifecycleFinished(raw.classification) ? raw.resultDigest : null, resultRef: lifecycleFinished(raw.classification) ? raw.resultRef : null,
    evidenceRefs: [...raw.evidenceRefs],
    criterionEvidence: (raw.criterionEvidence || []).map(({ ref, sha256 }) => ({ ref, sha256 })),
    waitReason: raw.waitReason || null, policyId: TASK_PROGRESS_POLICY.id,
    goalDigest: goal.goalDigest, logicalTaskPacketId: logicalId(packet), taskPacketId: packet.taskPacketId,
    contextId: packet.progressContextId || "initial",
    ownerAgent: packet.ownerAgent, routeDigest: taskProgressRoute(packet),
    evidenceBasisDigest: taskProgressEvidenceBasis(raw.basisEvidence), evidenceLevel: "owner_reported", nativeInvocationVerified: false };
}

function observationIdentity(observation) {
  return hash([observation.goalDigest, observation.logicalTaskPacketId, observation.criterionId, observation.attemptId]);
}

function observationMeaning(observation) {
  return hash([observation.taskPacketId, observation.ownerAgent, observation.routeDigest, observation.evidenceBasisDigest,
    observation.resultDigest, observation.classification, observation.failureClass,
    observation.criterionEvidence.map((item) => item.sha256).sort(), observation.waitReason, observation.contextId || "initial"]);
}

/** Replay-safe reduction. Capacity refusal preserves old identities rather than forgetting them. */
export function recordTaskProgress(ledger, observation) {
  const next = structuredClone(ledger || { schemaVersion: 1, observations: [], corrections: [] });
  requireValue(next.schemaVersion === 1 && Array.isArray(next.observations) && Array.isArray(next.corrections), "task_progress_ledger_invalid");
  requireValue(observation.policyId === TASK_PROGRESS_POLICY.id
    && next.observations.every((entry) => entry.policyId === TASK_PROGRESS_POLICY.id), "task_progress_policy_mismatch");
  const eventId = observationIdentity(observation);
  const index = next.observations.findIndex((entry) => entry.eventId === eventId);
  if (index >= 0) {
    const previous = next.observations[index];
    if (observationMeaning(previous) === observationMeaning(observation)) return { ledger: next, changed: false, eventId };
    requireValue(!lifecycleFinished(previous.classification) && previous.taskPacketId === observation.taskPacketId
      && previous.routeDigest === observation.routeDigest && previous.evidenceBasisDigest === observation.evidenceBasisDigest
      && (previous.contextId || "initial") === (observation.contextId || "initial"),
    "task_progress_attempt_conflict");
    if (observation.classification === "running" && !previous.started) {
      requireValue(projectTaskProgress(next, observation.goalDigest, observation.logicalTaskPacketId, observation.contextId).pendingCorrections.length === 0,
        "task_progress_correction_required_before_attempt");
      requireValue(!next.observations.some((entry) => entry.eventId !== eventId && entry.goalDigest === observation.goalDigest
        && entry.logicalTaskPacketId === observation.logicalTaskPacketId && entry.attemptId !== observation.attemptId
        && entry.started && !lifecycleFinished(entry.classification)), "task_progress_active_attempt_exists");
    }
    requireValue(!lifecycleFinished(observation.classification) || previous.started === true, "task_progress_started_attempt_required");
    if (observation.classification === "progress") {
      const oldEvidence = new Set([...previous.basisEvidence, ...previous.criterionEvidence].map((item) => item.sha256));
      requireValue(observation.criterionEvidence.some((item) => !oldEvidence.has(item.sha256)), "task_progress_new_criterion_evidence_required");
    }
    next.observations[index] = { ...observation, eventId, started: previous.started || observation.classification === "running" };
  } else {
    requireValue(next.observations.length < 4096, "task_progress_capacity_requires_explicit_archive");
    const pending = projectTaskProgress(next, observation.goalDigest, observation.logicalTaskPacketId, observation.contextId).pendingCorrections;
    requireValue(!lifecycleFinished(observation.classification), "task_progress_started_attempt_required");
    requireValue(observation.classification !== "running" || pending.length === 0, "task_progress_correction_required_before_attempt");
    requireValue(observation.classification !== "running" || !next.observations.some((entry) => entry.goalDigest === observation.goalDigest
      && entry.logicalTaskPacketId === observation.logicalTaskPacketId && entry.attemptId !== observation.attemptId
      && entry.started && !lifecycleFinished(entry.classification)), "task_progress_active_attempt_exists");
    next.observations.push({ ...observation, eventId, started: observation.classification === "running" });
  }
  return { ledger: next, changed: true, eventId };
}

/** Counters are rebuilt from immutable attempt results, so restarts do not add observations. */
export function projectTaskProgress(ledger, goalDigest, logicalTaskPacketId, contextId = "initial") {
  const observations = (ledger?.observations || []).filter((entry) => entry.goalDigest === goalDigest && entry.logicalTaskPacketId === logicalTaskPacketId
    && (entry.contextId || "initial") === contextId);
  const corrections = (ledger?.corrections || []).filter((entry) => entry.goalDigest === goalDigest && entry.logicalTaskPacketId === logicalTaskPacketId
    && (entry.contextId || "initial") === contextId);
  const byCriterion = new Map();
  const triggers = new Map();
  for (const observation of observations) {
    if (!terminal(observation.classification)) continue;
    const key = hash([observation.routeDigest, observation.evidenceBasisDigest]);
    const previous = byCriterion.get(observation.criterionId);
    const ineffectiveCount = observation.classification === "ineffective" ? previous?.key === key ? previous.ineffectiveCount + 1 : 1 : 0;
    const item = { key, ineffectiveCount, observation };
    byCriterion.set(observation.criterionId, item);
    if (ineffectiveCount === TASK_PROGRESS_POLICY.sameBasisIneffectiveThreshold) triggers.set(observation.eventId, {
      triggerEventId: observation.eventId, criterionId: observation.criterionId, taskPacketId: observation.taskPacketId,
      routeDigest: observation.routeDigest, evidenceBasisDigest: observation.evidenceBasisDigest,
      failureClass: observation.failureClass, sameBasisIneffectiveCount: ineffectiveCount,
      nextRequiredAction: "return_to_thinking_for_this_task", evidenceRefs: observation.evidenceRefs,
    });
  }
  const pendingCorrections = [...triggers.values()].filter((trigger) => !corrections.some((correction) => correction.triggerEventIds.includes(trigger.triggerEventId)));
  const attempts = observations.filter((entry) => terminal(entry.classification));
  return { policyId: TASK_PROGRESS_POLICY.id, units: TASK_PROGRESS_POLICY.units, logicalTaskPacketId, goalDigest,
    contextId, counterScope: "current_dependency_context", historyPreserved: true,
    terminalAttempts: new Set(attempts.map((entry) => entry.attemptId)).size,
    ineffectiveAttempts: new Set(attempts.filter((entry) => entry.classification === "ineffective").map((entry) => entry.attemptId)).size,
    progressAttempts: new Set(attempts.filter((entry) => entry.classification === "progress").map((entry) => entry.attemptId)).size,
    unresolvedAttempts: new Set(observations.filter((entry) => entry.classification === "unresolved").map((entry) => entry.attemptId)).size,
    ignoredObservations: observations.filter((entry) => TASK_PROGRESS_POLICY.ignoredClassifications.includes(entry.classification)).length,
    sameBasisIneffectiveCount: Math.max(0, ...[...byCriterion.values()].map((entry) => entry.ineffectiveCount)),
    correctionsTriggered: triggers.size, correctionsResolved: corrections.length,
    pendingCorrections, nextRequiredAction: pendingCorrections.length ? "return_to_thinking_for_this_task" : "continue_current_authorized_work",
    evidenceLevel: "owner_reported", nativeInvocationVerified: false };
}

/** Record a scoped Thinking decision; it never grants execution or changes the goal. */
export function recordTaskProgressCorrection(ledger, { goalDigest, oldPacket, replacement, rationale, evidenceRefs, basisEvidence }) {
  const pending = projectTaskProgress(ledger, goalDigest, logicalId(oldPacket), oldPacket.progressContextId).pendingCorrections;
  requireValue(pending.length > 0, "task_progress_no_pending_correction");
  requireValue(text(rationale) && Array.isArray(evidenceRefs) && evidenceRefs.length > 0 && evidenceRefs.every(text), "task_progress_correction_evidence_missing");
  requireValue(Array.isArray(basisEvidence) && basisEvidence.length > 0
    && basisEvidence.every((item) => item && text(item.ref) && sha(item.sha256)), "task_progress_basis_missing");
  const routeDigest = taskProgressRoute(replacement);
  const evidenceBasisDigest = taskProgressEvidenceBasis(basisEvidence);
  requireValue(pending.every((entry) => routeDigest !== entry.routeDigest || evidenceBasisDigest !== entry.evidenceBasisDigest), "task_progress_unchanged_basis");
  const next = structuredClone(ledger);
  next.corrections.push({ goalDigest, logicalTaskPacketId: logicalId(oldPacket), oldTaskPacketId: oldPacket.taskPacketId,
    contextId: oldPacket.progressContextId || "initial",
    taskPacketId: replacement.taskPacketId, triggerEventIds: pending.map((entry) => entry.triggerEventId),
    routeDigest, evidenceBasisDigest, rationale, evidenceRefs: [...evidenceRefs],
    policyId: TASK_PROGRESS_POLICY.id, evidenceLevel: "owner_reported", nativeInvocationVerified: false });
  return next;
}

/** A dependency correction cannot erase an unfinished invocation in any historical context. */
export function taskProgressHasActiveAttempt(ledger, goalDigest, logicalTaskPacketId) {
  return (ledger?.observations || []).some((entry) => entry.goalDigest === goalDigest && entry.logicalTaskPacketId === logicalTaskPacketId
    && entry.started && !lifecycleFinished(entry.classification));
}

/** Generated barriers are released only by current protected prerequisite criterion results. */
export function taskProgressDependencyReadiness(packet, packets, results) {
  if (!packet.progressDependencyBarrier) return { ready: true, blockedTaskIds: [], reason: null };
  const blockedTaskIds = packet.dependsOn.filter((taskPacketId) => {
    const prerequisite = packets.find((item) => item.taskPacketId === taskPacketId);
    const result = results.find((item) => item.taskPacketId === taskPacketId && item.ownerAgent === prerequisite?.ownerAgent);
    if (prerequisite?.progressPolicyId !== TASK_PROGRESS_POLICY.id || !prerequisite.acceptanceCriterionIds?.length
      || result?.resultStatus !== "reported_complete") return true;
    return !prerequisite.acceptanceCriterionIds.every((criterionId) => result.progressObservations?.some((observation) =>
      observation.criterionId === criterionId && observation.classification === "progress"
      && (observation.contextId || "initial") === (prerequisite.progressContextId || "initial")));
  });
  return { ready: blockedTaskIds.length === 0, blockedTaskIds,
    reason: blockedTaskIds.length ? "corrected_prerequisite_requires_current_criterion_results" : null };
}
