import { canonicalDigest } from "../shared/canonical-digest.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0 && value.length <= 500 && !/[\x00-\x1f\x7f]/u.test(value);
const fail = message => { throw new TypeError(`Work context: ${message}`); };
const ref = (value, name) => text(value) ? value : fail(`${name} must be a non-empty string`);
const refs = (value, name) => {
  if (!Array.isArray(value) || value.length > 64 || !value.every(text) || new Set(value).size !== value.length) fail(`${name} must contain at most 64 unique reference strings (500 characters each, no control characters)`);
  return [...value];
};
const reason = value => {
  if (value == null || typeof value === "string" && !value.trim()) return "unknown";
  if (typeof value !== "string" || value.length > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) fail("reason/summary must be text up to 8000 characters");
  return value;
};
const fields = (value, allowed, name) => {
  if (!object(value)) fail(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name}.${key} is not part of this contract`);
};

/** Host-owned business references. This contract neither resolves the refs nor
 * grants access, authenticates a human decision or creates a Work database. */
export function normalizeWorkContext(input) {
  if (input == null) return null;
  fields(input, ["schemaVersion", "organizationRef", "workRef", "contextRevision", "scopeRef", "sourceRefs", "acceptedArtifactRefs", "decisionRefs"], "workContext");
  if (input.schemaVersion !== "kim-work-context-v1") fail("unsupported workContext schemaVersion");
  return {
    schemaVersion: "kim-work-context-v1",
    organizationRef: ref(input.organizationRef, "organizationRef"),
    workRef: ref(input.workRef, "workRef"),
    contextRevision: ref(input.contextRevision, "contextRevision"),
    scopeRef: ref(input.scopeRef, "scopeRef"),
    sourceRefs: refs(input.sourceRefs ?? [], "sourceRefs"),
    acceptedArtifactRefs: refs(input.acceptedArtifactRefs ?? [], "acceptedArtifactRefs"),
    decisionRefs: refs(input.decisionRefs ?? [], "decisionRefs"),
  };
}

export function workBindingFor(input) {
  const context = normalizeWorkContext(input);
  return context && {
    organizationRef: context.organizationRef, workRef: context.workRef,
    contextRevision: context.contextRevision, contextDigest: canonicalDigest(context),
  };
}

export function workBindingsMatch(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return ["organizationRef", "workRef", "contextRevision", "contextDigest"].every(key => text(left[key]) && left[key] === right[key]);
}

export function assertWorkContextMatches(expected, actual) {
  if (!workBindingsMatch(workBindingFor(expected), workBindingFor(actual))) fail("organization, Work or context revision/content differs; use a new run with the current context");
}

/** The run's immutable digest is also carried by each existing worker packet. */
export function bindWorkerWorkContext(packets, workContext) {
  const context = normalizeWorkContext(workContext);
  const workBinding = workBindingFor(context);
  if (!workBinding) return packets;
  return packets.map(packet => ({ ...packet, workBinding: { ...workBinding },
    workContext: structuredClone(context), workContextRef: "workContext", workScopeRef: context.scopeRef }));
}

/** A business observation is appended to an existing run, never inferred from
 * its technical verdict. An older version may be adopted while this run
 * produced a newer one. This observation belongs to the current run; its
 * decisionRef may retain an earlier decision without another human approval. */
export function normalizeWorkOutcome(input, { runId, workContext }) {
  if (input == null) return null;
  fields(input, ["schemaVersion", "runId", "workBinding", "adopted", "effect", "knowledgeReuse"], "workOutcome");
  const workBinding = workBindingFor(workContext);
  if (!workBinding) fail("workOutcome requires workContext");
  if (input.schemaVersion !== "kim-work-outcome-v1" || !text(runId) || input.runId !== runId) fail("workOutcome must name the current explicit runId and schemaVersion");
  fields(input.workBinding, ["organizationRef", "workRef", "contextRevision", "contextDigest"], "workOutcome.workBinding");
  if (!workBindingsMatch(workBinding, input.workBinding)) fail("workOutcome belongs to another organization, Work or context revision/content");
  const adopted = input.adopted ?? { status: "unknown" };
  fields(adopted, ["status", "artifactRefs", "decisionRef", "reason"], "adopted");
  if (!["unknown", "pending", "accepted", "rejected"].includes(adopted.status)) fail("invalid adopted status");
  const artifactRefs = refs(adopted.artifactRefs ?? [], "adopted.artifactRefs");
  const decisionRef = adopted.decisionRef == null ? null : ref(adopted.decisionRef, "adopted.decisionRef");
  if (["accepted", "rejected"].includes(adopted.status) && !decisionRef) fail("accepted/rejected adoption requires the host decision reference");
  if (adopted.status === "accepted" && !artifactRefs.length) fail("accepted adoption requires exact artifact/version references");
  const effect = input.effect ?? { status: "unknown" };
  fields(effect, ["status", "evidenceRefs", "summary"], "effect");
  if (!["unknown", "observed"].includes(effect.status)) fail("invalid effect status");
  const evidenceRefs = refs(effect.evidenceRefs ?? [], "effect.evidenceRefs");
  if (effect.status === "observed" && !evidenceRefs.length) fail("observed effect requires evidence references");
  if (!Array.isArray(input.knowledgeReuse ?? []) || input.knowledgeReuse?.length > 64) fail("knowledgeReuse must be an array of at most 64 entries");
  const knowledgeReuse = (input.knowledgeReuse ?? []).map(item => {
    fields(item, ["sourceRef", "disposition", "reason"], "knowledgeReuse entry");
    if (!["direct", "adapted", "not_applicable"].includes(item.disposition)) fail("invalid knowledgeReuse disposition");
    return { sourceRef: ref(item.sourceRef, "knowledgeReuse.sourceRef"), disposition: item.disposition, reason: reason(item.reason) };
  });
  return { schemaVersion: "kim-work-outcome-v1", runId, workBinding,
    adopted: { status: adopted.status, artifactRefs, decisionRef, reason: reason(adopted.reason) },
    effect: { status: effect.status, evidenceRefs, summary: reason(effect.summary) }, knowledgeReuse };
}

export function projectWorkReceipt(artifact, workOutcome = artifact.workOutcomePacket ?? null) {
  if (!artifact.workContext) return artifact;
  const workContext = normalizeWorkContext(artifact.workContext);
  const workBinding = workBindingFor(workContext);
  const outcome = normalizeWorkOutcome(workOutcome, { runId: artifact.runId, workContext });
  const packets = artifact.coreLoop?.thinkingPacket?.workerTaskPackets ?? artifact.workerTaskPackets ?? [];
  const outputs = (artifact.coreLoop?.executionResult?.workerResultPackets ?? artifact.executionResult?.workerResultPackets ?? []).flatMap(result => {
    const packet = packets.find(item => item.taskPacketId === result.taskPacketId);
    return result.runId === artifact.runId && packet && (result.ownerAgent ?? result.owner) === (packet.ownerAgent ?? packet.owner) &&
      workBindingsMatch(result.workBinding, workBinding) && workBindingsMatch(packet.workBinding, workBinding) &&
      result.status === "executed" && ["native_read_only_worker_result", "actual_local_tool_worker_result"].includes(result.resultKind) &&
      typeof result.output?.text === "string"
      ? [`run:${artifact.runId}:task:${result.taskPacketId}:output`] : [];
  });
  for (const call of artifact.machineExecution?.calls ?? []) {
    if (call.status === "completed" && call.evidenceKind === "observed_native_read_only_machine_result" &&
        workBindingsMatch(call.workBinding, workBinding) && text(call.machineResultArtifact?.path)) outputs.push(call.machineResultArtifact.path);
  }
  const review = artifact.outcomeReviewPacket ?? artifact.coreLoop?.outcomeReviewPacket;
  const evaluation = review?.outcomeEvaluation;
  const verifiedStatus = !text(review?.reviewRef) ? "unknown" : evaluation?.status === "pass" ? "passed" : evaluation?.status === "fail" ? "failed" : "unknown";
  const receipt = {
    schemaVersion: "kim-work-receipt-v1", runId: artifact.runId, workBinding,
    produced: { status: outputs.length ? "produced" : "not_produced", artifactRefs: [...new Set(outputs)], source: "bound_execution_results" },
    verified: { status: verifiedStatus, evidenceRefs: review?.reviewRef ? [review.reviewRef] : [], source: "existing_independent_outcome_review" },
    adopted: { ...(outcome?.adopted ?? { status: "unknown", artifactRefs: [], decisionRef: null, reason: "unknown" }), source: outcome ? "host_provided_not_independently_verified" : "not_observed" },
    effect: { ...(outcome?.effect ?? { status: "unknown", evidenceRefs: [], summary: "unknown" }), source: outcome ? "host_provided_not_independently_verified" : "not_observed" },
    knowledgeReuse: outcome?.knowledgeReuse ?? [],
    authority: "References do not grant access, authenticate adoption/effect, or authorize knowledge publication.",
  };
  const candidates = [];
  if (receipt.verified.status === "failed") candidates.push({ kind: "technical_verification", status: "failed",
    sourceRefs: receipt.verified.evidenceRefs, reason: "existing_task_review_failed; business_effect_unknown" });
  if (receipt.adopted.status !== "unknown") candidates.push({ kind: "business_adoption", status: receipt.adopted.status,
    artifactRefs: receipt.adopted.artifactRefs, sourceRefs: receipt.adopted.decisionRef ? [receipt.adopted.decisionRef] : [], reason: receipt.adopted.reason });
  if (receipt.effect.status === "observed") candidates.push({ kind: "business_effect", sourceRefs: receipt.effect.evidenceRefs, reason: receipt.effect.summary });
  for (const reuse of receipt.knowledgeReuse) candidates.push({ kind: "knowledge_reuse", disposition: reuse.disposition, sourceRefs: [reuse.sourceRef], reason: reuse.reason });
  const workFeedback = { status: candidates.length ? "candidate_only" : "no_observation", workBinding, candidates,
    visibility: "originating_organization_scope", authority: "Use the existing reviewed knowledge lifecycle; no automatic canonical/public writeback." };
  const attachEvolution = packet => ({ ...packet, workFeedback });
  return { ...artifact, workContext, workBinding, ...(outcome ? { workOutcomePacket: outcome } : {}), workReceipt: receipt,
    ...(artifact.evolutionWritebackPacket ? { evolutionWritebackPacket: attachEvolution(artifact.evolutionWritebackPacket) } : {}),
    ...(artifact.coreLoop ? { coreLoop: { ...artifact.coreLoop, workContext, workBinding, workReceipt: receipt,
      ...(outcome ? { workOutcomePacket: outcome } : {}),
      ...(artifact.coreLoop.evolutionWritebackPacket ? { evolutionWritebackPacket: attachEvolution(artifact.coreLoop.evolutionWritebackPacket) } : {}) } } : {}) };
}
