import { validateArtifactFile } from "../validate-run-artifact.mjs";
import { readFileSync, createReadStream, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createDecision, presentDecision, invalidateDecision } from "../../src/domain/decision/decision.mjs";
import { createCodexAppServerDecisionHostAdapter } from "../../src/adapters/codex/app-server-decision-host-adapter.mjs";
import { assertValidNativeHostAnswerSubstrate, consumeNativeHostReturnObservedClaim } from "../../src/domain/decision/native-host-answer-authority.mjs";
import { assertValidNativeDecisionChallenge } from "../../src/domain/decision/native-decision-authority.mjs";
import { inspectTrustedPath, normalizeManagedRelPath } from "../safe-managed-file-operations.mjs";
import { isCodexDesktopDecisionHostAdapter } from "../../src/adapters/codex/desktop-decision-host-adapter.mjs";
import { dependentNodeClosure } from "../../src/domain/scheduling/human-gate-progress.mjs";

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const reviewReceipts = new WeakMap();
const nativeConsumers = new WeakSet();
const desktopConsumers = new WeakSet();
const labels = Object.freeze({ "option:accept": "确认本版", "option:revise": "提出修改", "option:return": "退回方案" });
const policy = JSON.parse(readFileSync(new URL("../../config/contracts/workflow-contract.json", import.meta.url), "utf8"))
  .protocols.preDecisionOptionFrame.humanMilestonePolicy;

/** Bind current-question evidence, its actual prerequisites and common context.
 * Opaque/external references are not silently reinterpreted as local files.
 */
export function collectPlanChallengeMaterials({ artifact, questionId = null, projectRoot }) {
  const questions = new Map((artifact.preDecisionOptionFrame?.unresolvedQuestions ?? []).map((question) => [question.questionId, question]));
  for (const question of artifact.requirementsDiscoveryPacket?.decisionItems ?? []) questions.set(question.questionId, question);
  const closure = new Set();
  const gaps = [];
  const visit = (id) => {
    if (closure.has(id)) return;
    const question = questions.get(id);
    if (!question) { gaps.push({ questionId: id, reason: "question_dependency_material_missing" }); return; }
    closure.add(id);
    for (const dependency of question.dependsOn ?? []) visit(dependency);
  };
  if (questionId) visit(questionId);
  const scopedRefs = new Set([...questions.values()].flatMap((question) => question.evidenceRefs ?? []));
  const references = new Set(artifact.intentPacket?.evidenceRefs ?? []);
  for (const ref of artifact.requirementsDiscoveryPacket?.evidenceRefs ?? []) {
    if (!scopedRefs.has(ref)) references.add(ref);
  }
  for (const id of closure) for (const ref of questions.get(id).evidenceRefs ?? []) references.add(ref);
  const bindings = [];
  const packetRoots = { requirementsDiscoveryPacket: artifact.requirementsDiscoveryPacket, intentPacket: artifact.intentPacket };
  for (const sourceRef of [...references].sort()) {
    const version = sourceRef.match(/(?:^|[#?&])sha256[:=]([a-f0-9]{64})$/iu)?.[1];
    if (version) { bindings.push({ kind: "content_addressed_reference", sourceRef, sha256: version.toLowerCase() }); continue; }
    if (/^(?:requirementsDiscoveryPacket|intentPacket)(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/u.test(sourceRef)) {
      const keys = sourceRef.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/gu);
      let value = packetRoots[keys.shift()];
      for (const key of keys) value = value != null && Object.hasOwn(value, key) ? value[key] : undefined;
      if (value !== undefined) { bindings.push({ kind: "packet_reference", sourceRef, sha256: digest(value) }); continue; }
      gaps.push({ sourceRef, kind: "packet_reference", reason: "current_packet_reference_missing" });
      continue;
    }
    const external = !path.isAbsolute(sourceRef) && /^[a-z][a-z0-9+.-]*:/iu.test(sourceRef);
    const fileRef = sourceRef.split("#", 1)[0];
    const fileLike = path.isAbsolute(fileRef) || /[\\/]|\.[A-Za-z0-9]+$/u.test(fileRef);
    if (external || !fileLike) {
      gaps.push({ sourceRef, kind: external ? "external_reference" : "non_file_reference", reason: "bound_snapshot_or_content_version_required" });
      continue;
    }
    const relative = path.relative(projectRoot, path.resolve(projectRoot, fileRef));
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
      gaps.push({ sourceRef, kind: "external_file_reference", reason: "bound_project_snapshot_or_content_version_required" });
      continue;
    }
    try {
      const target = inspectTrustedPath(projectRoot, relative, { allowMissing: false }).target;
      if (!statSync(target).isFile()) throw new Error("Material is not a file");
      bindings.push({ kind: "local_file", sourceRef, fileRef: relative,
        sha256: createHash("sha256").update(readFileSync(target)).digest("hex") });
    } catch (error) {
      gaps.push({ sourceRef, kind: "local_file", reason: "current_local_material_unavailable", code: error.code ?? "invalid_material_path" });
    }
  }
  return { questionIds: [...closure].sort(), bindings, gaps };
}

/** Prepare a current pre-execution question without inventing a producer node. */
export function createPlanChallengeQuestion({ artifact, questionId, projectRoot, at = new Date().toISOString() }) {
  if (artifact.preparation?.status !== "needs_input" || artifact.workerTaskPackets?.length || artifact.coreLoop?.stageDagPacket) {
    throw new Error("Plan-challenge preparation requires a pending pre-execution artifact, not an execution run");
  }
  const question = artifact.preDecisionOptionFrame.unresolvedQuestions.find((item) => item.questionId === questionId);
  if (!question || question.status !== "open" || question.resolutionClass !== "material_user_decision" ||
      !Array.isArray(question.options) || question.options.length < 2 ||
      !artifact.preDecisionOptionFrame.readyDecisionFrontier.some((item) => item.questionId === questionId)) {
    throw new Error("Only the current dependency-ready material question can be presented");
  }
  const options = question.options.map((option, index) => ({ optionId: "option:q" + index,
    label: option.label, description: option.tradeoff, value: option.value ?? option.label }));
  if (options.some((option) => typeof option.label !== "string" || typeof option.description !== "string" || typeof option.value !== "string") ||
      new Set(options.map((option) => option.label)).size !== options.length) throw new TypeError("Question options require unique labels and exact values");
  const materials = collectPlanChallengeMaterials({ artifact, questionId, projectRoot });
  if (materials.gaps.length) return { status: "needs_material_evidence", questionId, materialGaps: materials.gaps,
    returnToStage: "Fetch", executionAllowed: false };
  const binding = { runId: artifact.runId, taskHash: artifact.goalContractPacket.taskHash,
    intentDigest: artifact.intentPacket.intentBinding?.intentDigest ?? null,
    taskFingerprint: artifact.taskFingerprint, projectRoot: path.resolve(projectRoot), runtime: "codex",
    preparationDigest: artifact.preparation.bindingDigest, questionId,
    questionDigest: digest({ question: question.question, options, evidenceRefs: question.evidenceRefs }), options,
    materialBindings: materials.bindings, materialQuestionIds: materials.questionIds };
  binding.bindingDigest = digest(binding);
  const evidence = [{ evidenceRef: "evidence:preparation", digest: "sha256:" + binding.preparationDigest },
    { evidenceRef: "evidence:question", digest: "sha256:" + binding.questionDigest },
    { evidenceRef: "evidence:materials", digest: "sha256:" + digest(binding.materialBindings) }];
  const evidenceRefs = evidence.map((item) => item.evidenceRef);
  const decision = presentDecision(createDecision({ identity: { runId: "run:" + digest(binding.runId),
    taskFingerprint: "sha256:" + digest(binding.taskFingerprint), decisionKey: "decision:" + digest(questionId),
    scopeRef: "sha256:" + binding.bindingDigest }, decisionType: "decision:plan-challenge",
    routeChangingDimensions: ["scope"], evidence,
    options: options.map((option) => ({ optionId: option.optionId, displayRef: "display:" + option.optionId.slice(7),
      tradeoffRefs: ["tradeoff:" + option.optionId.slice(7)], evidenceRefs })),
    requirement: { required: true, reasonRef: "reason:material-choice", evidenceRefs },
    nativeSurface: { runtime: "codex", surface: "request_user_input", primary: true }, createdAt: at }), { at });
  return { binding, decision, presentation: { questions: [{ header: "当前选择", question: question.question,
    options: options.map(({ optionId, label, description }) => ({ optionId, label, description })) }] } };
}

/** Map the observed chosen value, never a recommendation or milestone accept. */
export function consumePlanChallengeChoice({ question, result }) {
  if (result.state !== "consumed" || !result.answerEvidenceRef) return { status: "pending", executionAllowed: false };
  const selected = question.binding.options.find((option) => option.optionId === result.selectedOptionId);
  if (!selected) throw new Error("Consumed plan-challenge choice is not in this question version");
  return { status: "consumed", executionAllowed: false, originAuthenticatedByLibrary: false,
    binding: question.binding, selectedOptionId: selected.optionId,
    settledDecision: { decisionId: question.binding.questionId, value: selected.value, evidenceRefs: [result.answerEvidenceRef] },
    response: { questionId: question.binding.questionId, userAnswer: selected.value, status: "answered",
      binding: "plan-challenge-response:" + question.binding.questionId,
      selectionBinding: "plan-challenge-selection:" + question.binding.questionId,
      evidenceRefs: [result.answerEvidenceRef] },
    questionTurnRef: result.questionTurnRef, replyTurnRef: result.replyTurnRef, substrateRef: result.substrateRef,
    observedClaimDigest: result.observedClaimDigest };
}

/** Bind only the evidence relevant to a declared milestone, never unrelated logs. */
export function bindHumanMilestones(requests = [], context) {
  if (!Array.isArray(requests)) throw new TypeError("humanMilestones must be an array");
  const seen = new Set();
  return requests.map((request) => {
    const rule = policy.milestones.find((item) => item.id === request.milestoneId);
    if (!rule || !rule.triggers.includes(request.trigger) || typeof request.nodeId !== "string" || !request.nodeId ||
        !Array.isArray(request.evidence) || !request.evidence.length || request.evidence.some((item) =>
          typeof item.evidenceRef !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(item.digest))) {
      throw new TypeError("A milestone requires a policy trigger, node and current artifact digests");
    }
    const key = `${request.nodeId}:${request.milestoneId}`;
    if (seen.has(key)) throw new TypeError("Duplicate human milestone for one node");
    seen.add(key);
    const artifactRef = request.artifactRef === undefined ? undefined : normalizeManagedRelPath(request.artifactRef);
    if (request.artifactRef !== undefined && !artifactRef) throw new TypeError("Milestone artifact must be a current project file reference");
    if (request.flowId !== undefined && (typeof request.flowId !== "string" || !request.flowId)) throw new TypeError("Milestone flow reference is missing");
    const binding = { runId: context.runId, taskFingerprint: context.taskFingerprint, graphDigest: context.graphDigest,
      projectRoot: path.resolve(context.projectRoot), runtime: context.runtime, nodeId: request.nodeId, milestoneId: request.milestoneId,
      ...(artifactRef ? { artifactRef } : {}),
      ...(request.flowId ? { flowId: request.flowId } : {}),
      evidence: structuredClone(request.evidence).sort((a, b) => a.evidenceRef < b.evidenceRef ? -1 : a.evidenceRef > b.evidenceRef ? 1 : 0) };
    return { ...binding, bindingDigest: digest(binding) };
  });
}

/** Omission is not revocation: restore the run's latest declarations and r1 waits. */
export function restoreHumanMilestoneDeclarations(requests, context, kernel) {
  const bindings = bindHumanMilestones(requests, context);
  const events = kernel.getEvents(context.runId);
  const declared = new Map();
  const legacy = new Map();
  const scope = { runId: context.runId, taskFingerprint: context.taskFingerprint, graphDigest: context.graphDigest,
    projectRoot: path.resolve(context.projectRoot), runtime: context.runtime };
  const keyOf = (item) => `${item.nodeId}:${item.milestoneId}`;
  for (const event of events) {
    if (!["HumanMilestoneDeclared", "HumanMilestoneRequested"].includes(event.eventType)) continue;
    const binding = event.payload.binding;
    if (Object.entries(scope).some(([key, value]) => binding[key] !== value)) {
      throw new Error("Stored human milestone belongs to a different run, task, graph, project or runtime");
    }
    if (event.eventType === "HumanMilestoneDeclared") declared.set(keyOf(binding), event);
    else legacy.set(keyOf(binding), event);
  }
  for (const [index, source] of requests.entries()) {
    const binding = bindings[index];
    const key = keyOf(binding);
    const previous = declared.get(key) ?? legacy.get(key);
    if (declared.get(key)?.payload.binding.bindingDigest === binding.bindingDigest && declared.get(key).payload.request.trigger === source.trigger) continue;
    const request = { nodeId: source.nodeId, milestoneId: source.milestoneId, trigger: source.trigger,
      evidence: structuredClone(source.evidence), ...(binding.artifactRef ? { artifactRef: binding.artifactRef } : {}),
      ...(binding.flowId ? { flowId: binding.flowId } : {}), ...(source.artifactVersion !== undefined ? { artifactVersion: source.artifactVersion } : {}) };
    const event = kernel.appendEvent({ runId: context.runId,
      eventId: `human-milestone-declared:${digest([previous?.eventId ?? null, binding.bindingDigest, request.trigger])}`,
      eventType: "HumanMilestoneDeclared", nodeId: binding.nodeId, payload: { binding, request } });
    declared.set(key, event);
  }
  const restored = [...declared.values()].map((event) => ({ request: event.payload.request }));
  // r1 did not persist a trigger. Preserve its exact issued binding rather than inventing one.
  for (const [key, event] of legacy) if (!declared.has(key)) restored.push({
    request: { nodeId: event.nodeId, milestoneId: event.payload.binding.milestoneId }, persistedBinding: event.payload.binding,
  });
  return restored;
}

async function currentArtifactDigest(projectRoot, artifactRef) {
  const { target } = inspectTrustedPath(projectRoot, artifactRef, { allowMissing: false });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

/** Existing Decision objects describe a human judgement; they do not grant permission. */
export function createHumanMilestoneDecision(binding, at = new Date().toISOString()) {
  const evidenceRefs = binding.evidence.map((item) => item.evidenceRef);
  return presentDecision(createDecision({ identity: { runId: `run:${digest(binding.runId)}`,
    taskFingerprint: `sha256:${digest(binding.taskFingerprint)}`, decisionKey: `decision:${binding.milestoneId}`,
    scopeRef: `sha256:${binding.bindingDigest}` }, decisionType: "decision:human-milestone",
    routeChangingDimensions: ["acceptance"], evidence: binding.evidence,
    options: Object.keys(labels).map((optionId) => ({ optionId, displayRef: `display:${optionId.slice(7)}`,
      tradeoffRefs: [`tradeoff:${optionId.slice(7)}`], evidenceRefs })),
    requirement: { required: true, reasonRef: "reason:human-milestone", evidenceRefs },
    nativeSurface: binding.runtime === "codex" ? { runtime: "codex", surface: "request_user_input", primary: true }
      : binding.runtime === "claude" ? { runtime: "claude", surface: "AskUserQuestion", primary: true } : null, createdAt: at }), { at });
}

/** Compose the existing native observer and CAS repository behind trusted host ports. */
export function createNativeHumanMilestoneConsumer({ hostConnection, repository, prepareDecision, now = () => new Date().toISOString() }) {
  if (typeof prepareDecision !== "function" || typeof repository?.consume !== "function") {
    throw new TypeError("Native milestone consumer requires host preparation and repository consume ports");
  }
  let response;
  const adapter = createCodexAppServerDecisionHostAdapter({ hostConnection: {
    hostConnectionRef: hostConnection.hostConnectionRef,
    takeRequestUserInput: () => hostConnection.takeRequestUserInput(),
    takeResponse: async (input) => { const event = await hostConnection.takeResponse(input); response = structuredClone(event.response); return event; },
    ackResponse: (input) => hostConnection.ackResponse(input),
  }, repository: { issue: (record) => repository.issue(record), observe: (input) => repository.observe(input), read: (input) => repository.read(input) } });
  const consumer = Object.freeze({
    async resolve({ binding, decision, prior }) {
      let record;
      let answer;
      if (prior) {
        record = assertValidNativeHostAnswerSubstrate(await repository.read({ substrateRef: prior.substrateRef }));
        answer = prior.answer;
      } else {
        const preparation = await prepareDecision({ binding, decision });
        const observed = await adapter.observeRequiredDecision({ ...preparation, decision });
        const consumed = consumeNativeHostReturnObservedClaim(observed.substrate, { at: now(),
          timeSourceClaimRef: "time-source:human-milestone-consumer", consumerRef: `consumer:${binding.bindingDigest}` });
        record = assertValidNativeHostAnswerSubstrate(await repository.consume({ record: consumed,
          expectedRevision: observed.substrate.revision, expectedSubstrateDigest: observed.substrate.substrateDigest,
          expectedState: "host_return_observed" }));
        answer = { response, challenge: observed.challenge };
      }
      const challenge = assertValidNativeDecisionChallenge(answer.challenge, decision);
      const selection = Object.values(answer.response.result.answers).flatMap((item) => item.answers);
      const mismatch = Object.entries({ state: record.state === "consumed", consumer: record.consumerRef === `consumer:${binding.bindingDigest}`,
        decision: record.decisionId === decision.decisionId, revision: record.presentedRevision === decision.revision,
        // The substrate binds these through challengeDigest; it has no duplicate option/evidence fields.
        challenge: record.challengeDigest === challenge.challengeDigest && record.challengeRef === challenge.challengeRef,
        response: record.hostReturnObservedClaimDigest === `sha256:${digest(answer.response)}`,
        selection: challenge.state === "host_answer_claimed" && selection.length === 1 && selection[0] === labels[challenge.selectedOptionId] }).filter(([, valid]) => !valid).map(([key]) => key);
      if (mismatch.length) {
        throw new Error(`Consumed human reply binding mismatch: ${mismatch.join(", ")}`);
      }
      const receipt = Object.freeze({ substrateRef: record.substrateRef, answer, state: "consumed", executionAllowed: false });
      reviewReceipts.set(receipt, { bindingDigest: binding.bindingDigest, selection: challenge.selectedOptionId });
      return receipt;
    },
  });
  nativeConsumers.add(consumer);
  return consumer;
}

/** Desktop async replies use durable observations, never native callback receipts. */
export function createDesktopHumanMilestoneConsumer({ adapter }) {
  if (!isCodexDesktopDecisionHostAdapter(adapter)) throw new TypeError("A current Desktop host adapter is required");
  const consumer = Object.freeze({ resolve: ({ binding, decision }) => adapter.consume({ binding, decision }) });
  desktopConsumers.add(consumer);
  return consumer;
}

/** Only a consumer built around the current native transport may start a
 * blocking host exchange. A plain callback or a claimed flag is insufficient. */
export function hasNativeHumanMilestoneTransport(consumer) {
  return nativeConsumers.has(consumer);
}

/** Consume one declared node's current human decision without changing its completed output. */
export async function resolveHumanMilestoneReviews({ declarations, records, consumer, kernel, context, allowHostInvocation = false }) {
  const reviews = [];
  let requestedHuman = false;
  for (const { request, persistedBinding } of declarations) {
    const output = records.get(request.nodeId);
    if (!output) continue;
    let artifactSha256;
    if (request.artifactRef) {
      try { artifactSha256 = await currentArtifactDigest(context.projectRoot, request.artifactRef); }
      catch (error) {
        reviews.push({ nodeId: request.nodeId, milestoneId: request.milestoneId, accepted: false,
          reason: "human_milestone_actual_artifact_required", evidence: request.evidence, artifactRef: request.artifactRef,
          nextAction: { stage: "Fetch", action: "obtain_current_reviewable_artifact", artifactRef: request.artifactRef } });
        continue;
      }
    }
    const binding = persistedBinding ?? bindHumanMilestones([{ ...request, trigger: request.trigger,
      evidence: [...request.evidence, ...(artifactSha256 ? [{ evidenceRef: `artifact-file:${digest(request.artifactRef)}`, digest: `sha256:${artifactSha256}` }] : []),
        { evidenceRef: `artifact:${digest(request.nodeId)}`, digest: `sha256:${output.outputSha256}` }] }], context)[0];
    if (persistedBinding && !binding.evidence.some((item) => item.evidenceRef === `artifact:${digest(request.nodeId)}` &&
        item.digest === `sha256:${output.outputSha256}`)) {
      reviews.push({ nodeId: request.nodeId, milestoneId: request.milestoneId, accepted: false,
        reason: "legacy_human_milestone_current_evidence_required", bindingDigest: binding.bindingDigest,
        evidence: binding.evidence, decisionState: "invalidated" });
      continue;
    }
    const events = kernel.getEvents(context.runId);
    const requested = events.find((event) => event.eventType === "HumanMilestoneRequested" && event.payload.binding.bindingDigest === binding.bindingDigest);
    const decision = requested?.payload.decision ?? createHumanMilestoneDecision(binding);
    const invalidated = events.find((event) => event.eventType === "HumanMilestoneInvalidated" &&
      event.payload.decision.decisionId === decision.decisionId);
    const older = events.filter((event) => event.eventType === "HumanMilestoneRequested" &&
      event.payload.binding.nodeId === binding.nodeId && event.payload.binding.milestoneId === binding.milestoneId &&
      event.payload.binding.bindingDigest !== binding.bindingDigest);
    for (const event of older) {
      const invalidationId = `human-milestone:${event.payload.binding.bindingDigest}:invalidated:${binding.bindingDigest}`;
      if (!events.some((item) => item.eventId === invalidationId)) kernel.appendEvent({ runId: context.runId,
        eventId: invalidationId, eventType: "HumanMilestoneInvalidated", nodeId: binding.nodeId,
        payload: { decision: invalidateDecision(event.payload.decision, { at: new Date().toISOString(),
          reasonRef: "reason:related-evidence-changed", evidence: decision.evidence,
          options: decision.options }), supersededBy: binding.bindingDigest } });
    }
    if (!requested) kernel.appendEvent({ runId: context.runId, eventId: `human-milestone:${binding.bindingDigest}:requested`,
      eventType: "HumanMilestoneRequested", nodeId: binding.nodeId, payload: { binding, decision } });
    const consumed = events.find((event) => event.eventType === "HumanMilestoneConsumed" && event.payload.bindingDigest === binding.bindingDigest);
    const started = events.some((event) => event.eventType === "HumanMilestoneHostStarted" && event.payload.bindingDigest === binding.bindingDigest);
    const descendants = dependentNodeClosure(context.stageDagPacket.nodes, binding.nodeId);
    const staleCompletedDependency = older.length > 0 && descendants.some(id => records.has(id));
    const inheritanceMissing = request.trigger === "within_accepted_scope" && !consumed;
    let result = { accepted: false, reason: invalidated ? "human_milestone_decision_invalidated"
      : staleCompletedDependency ? "human_milestone_changed_evidence_requires_revision"
      : inheritanceMissing ? "human_milestone_accepted_scope_evidence_required"
      : started && !consumed ? "human_milestone_host_result_unknown" : "host_native_decision_required" };
    if (inheritanceMissing) result.nextAction = { stage: "Thinking", action: "verify_prior_acceptance_or_classify_current_revision", nodeId: binding.nodeId };
    if (invalidated) Object.assign(result, { decisionState: "invalidated", revision: invalidated.payload.decision.revision,
      invalidatedBy: invalidated.payload.decision.invalidation.reasonRef });
    const desktop = desktopConsumers.has(consumer);
    if (!invalidated && !staleCompletedDependency && !inheritanceMissing && context.runtime === "codex" && (desktop || nativeConsumers.has(consumer)) &&
        (desktop || consumed || allowHostInvocation && !requestedHuman && !started)) {
      if (!consumed && !desktop) requestedHuman = true;
      if (!consumed && !desktop) kernel.appendEvent({ runId: context.runId, eventId: `human-milestone:${binding.bindingDigest}:host-started`,
        eventType: "HumanMilestoneHostStarted", nodeId: binding.nodeId, payload: { bindingDigest: binding.bindingDigest } });
      try {
        const receipt = await consumer.resolve({ binding, decision, prior: consumed?.payload.receipt });
        result = desktop ? receipt.state === "consumed" ? {
          accepted: receipt.selectedOptionId === "option:accept", reason: receipt.selectedOptionId === "option:accept" ? "current_human_milestone_accepted"
            : receipt.selectedOptionId === "option:revise" ? "human_milestone_revision_required" : "human_milestone_returned",
          handoffStatus: receipt.selectedOptionId === "option:accept" ? "ready" : "awaiting_revision", executionAllowed: false,
          decisionState: "consumed", selectedOptionId: receipt.selectedOptionId, answerEvidenceRef: receipt.substrateRef,
          originAuthenticatedByLibrary: false,
        } : { accepted: false, reason: receipt.reason, decisionState: "pending", executionAllowed: false }
          : bindVerifiedHostPlanChallengeDecision({ verifiedDecision: receipt, preview: binding });
        if (artifactSha256 && artifactSha256 !== await currentArtifactDigest(context.projectRoot, request.artifactRef)) {
          result = { accepted: false, reason: "human_milestone_artifact_changed_during_review" };
        }
        if (!consumed && receipt.state === "consumed") kernel.appendEvent({ runId: context.runId, eventId: `human-milestone:${binding.bindingDigest}:consumed`,
          eventType: "HumanMilestoneConsumed", nodeId: binding.nodeId, payload: { bindingDigest: binding.bindingDigest, receipt } });
      } catch (error) { result = { accepted: false, reason: "human_milestone_host_return_unresolved", failureReason: error.message }; }
    }
    if (["human_milestone_revision_required", "human_milestone_returned", "human_milestone_changed_evidence_requires_revision"].includes(result.reason)) {
      result.nextAction = { stage: "Thinking", action: result.reason === "human_milestone_returned" ? "reconsider_human_reviewed_scope" : "revise_human_reviewed_scope",
        nodeId: binding.nodeId, affectedNodeIds: [binding.nodeId, ...descendants],
        bindingDigest: binding.bindingDigest, executionAllowed: false };
    }
    reviews.push({ nodeId: binding.nodeId, milestoneId: binding.milestoneId, label: policy.milestones.find((rule) => rule.id === binding.milestoneId).label,
      flowId: binding.flowId, artifactRef: request.artifactRef, artifactVersion: request.artifactVersion,
      artifactSha256, bindingDigest: binding.bindingDigest,
      decisionId: decision.decisionId, revision: decision.revision, evidence: binding.evidence, ...result });
  }
  return reviews;
}

const CONTINUABLE_PHASES = new Set([
  "awaiting_fact_discovery",
  "awaiting_user_answer",
  "awaiting_understanding_confirmation",
  "awaiting_execution_authorization",
]);

export async function loadPlanChallengeContinuationCandidate({
  artifactPath,
  previousRunId,
  taskFingerprint,
  unallocatedPreparationFingerprint = null,
  taskHash,
  intentDigest,
}) {
  const raw = await validateArtifactFile(artifactPath);
  if (raw.preparation) {
    const markdownPath = path.join(path.dirname(artifactPath), raw.runId + "." + raw.resolvedOutputLanguage + ".md");
    // Only an empty, paired preparation can introduce a criterion allocation.
    // Existing assigned preparations and all materialized executions still bind
    // their exact fingerprint. The caller derives this alternative from the
    // same current task/calculation/design inputs without the new allocation.
    const fingerprintMatches = raw.taskFingerprint === taskFingerprint ||
      (unallocatedPreparationFingerprint != null && raw.taskFingerprint === unallocatedPreparationFingerprint);
    if (raw.runId !== previousRunId || !fingerprintMatches || raw.goalContractPacket?.taskHash !== taskHash ||
        (raw.intentPacket.intentBinding?.intentDigest ?? null) !== (intentDigest ?? null) ||
        raw.workerTaskPackets.length || raw.coreLoop?.stageDagPacket ||
        createHash("sha256").update(readFileSync(markdownPath)).digest("hex") !== raw.preparation.markdownSha256) {
      throw new Error("Pending preparation identity or paired material mismatch");
    }
    return { previousRunId, taskHash, intentDigest, planChallengeState: raw.preDecisionOptionFrame.planChallengeState,
      unresolvedQuestions: raw.preDecisionOptionFrame.unresolvedQuestions, preparationArtifact: raw };
  }
  const artifact = raw;
  if (artifact.runId !== previousRunId) {
    throw new Error("Plan challenge continuation run id does not match the prior artifact.");
  }
  if (artifact.taskFingerprint !== taskFingerprint) {
    throw new Error("Plan challenge continuation belongs to a different task.");
  }
  const priorTaskHash = artifact.goalContractPacket?.taskHash;
  const priorIntentDigest = artifact.goalContractPacket?.intentBinding?.intentDigest ?? null;
  if (taskHash !== undefined && priorTaskHash !== taskHash) {
    throw new Error("Plan challenge continuation task binding mismatch.");
  }
  if (intentDigest !== undefined && priorIntentDigest !== intentDigest) {
    throw new Error("Plan challenge continuation intent binding mismatch.");
  }
  const planChallengeState = artifact.preDecisionOptionFrame?.planChallengeState;
  const unresolvedQuestions = artifact.preDecisionOptionFrame?.unresolvedQuestions;
  if (!planChallengeState || !Array.isArray(unresolvedQuestions)) {
    throw new Error("Prior artifact does not contain a valid plan challenge state.");
  }
  if (!CONTINUABLE_PHASES.has(planChallengeState.phase)) {
    throw new Error(`Plan challenge continuation cannot resume terminal phase: ${planChallengeState.phase}.`);
  }
  return {
    previousRunId,
    taskHash: priorTaskHash,
    intentDigest: priorIntentDigest,
    planChallengeState,
    unresolvedQuestions,
  };
}

export function bindVerifiedHostPlanChallengeDecision({
  verifiedDecision,
  preview,
  continuationCandidate: _continuationCandidate = null,
}) {
  const proof = reviewReceipts.get(verifiedDecision);
  if (proof && proof.bindingDigest === preview?.bindingDigest) return {
    accepted: proof.selection === "option:accept", reason: proof.selection === "option:accept" ? "current_human_milestone_accepted"
      : proof.selection === "option:revise" ? "human_milestone_revision_required" : "human_milestone_returned",
    handoffStatus: proof.selection === "option:accept" ? "ready" : "awaiting_revision", executionAllowed: false,
    decisionState: "consumed", selectedOptionId: proof.selection, answerEvidenceRef: verifiedDecision.substrateRef,
  };
  return {
    accepted: false,
    reason: "host_native_decision_required",
    handoffStatus: "awaiting_native_choice",
    hostAction: "host_action_required",
  };
}
