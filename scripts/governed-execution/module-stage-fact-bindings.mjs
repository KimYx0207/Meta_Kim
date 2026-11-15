import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSpineStateIncludingInactive } from "../../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { inspectLiveWorkspaceGate } from "../../canonical/runtime-assets/shared/hooks/live-workspace-gate.mjs";
import { workspaceDigest } from "../../src/domain/live/live-workspace.mjs";
import { inspectTrustedPath } from "../safe-managed-file-operations.mjs";
import { moduleStageNodeId } from "./stage-dag.mjs";
import { moduleStageDigest } from "./module-stage-execution.mjs";

const sourcePath = fileURLToPath(import.meta.url);
const sha = value => createHash("sha256").update(value).digest("hex");
const sourceSha256 = sha(await fs.readFile(sourcePath));
const text = value => typeof value === "string" && value.trim().length > 0;
const hash = value => /^[a-f0-9]{64}$/u.test(value ?? "");
const requireThat = (value, reason) => { if (!value) throw new Error(reason); };
const canonicalStages = { Critical: "critical", Fetch: "fetch" };

/** Read existing stage facts and Decisions. These are input gates, not new
 * model judgments, independent reviews, user approval or execution authority. */
export async function createModuleStageFactExecutors({ host, projectRoot, artifactRoot, runtime }) {
  const executors = {};
  const diagnostics = [];
  Object.defineProperty(executors, "diagnostics", { value: diagnostics, enumerable: false });
  const order = host?.workOrder;
  if (!order?.moduleScopePlan) return executors;
  const root = await fs.realpath(projectRoot);
  const ownedRoot = path.resolve(artifactRoot || path.join(root, ".meta-kim/work/module-stage-facts"));
  requireThat(order.projectRoot === root && text(order.profile) && text(order.conversationId) && text(order.commandId) && text(order.runId),
    "module_fact_work_order_identity_required");
  const relativeOwnedRoot = path.relative(root, ownedRoot).split(path.sep).join("/");
  requireThat(relativeOwnedRoot && inspectTrustedPath(root, relativeOwnedRoot, { allowMissing: true }), "module_fact_artifact_root_invalid");

  async function currentState() {
    const state = await readSpineStateIncludingInactive(root, { profile: order.profile });
    requireThat(state?.active === true && state.runId === order.runId && state.conversationLinkState === "verified" &&
      state.sourceConversation?.runId === order.runId && state.sourceConversation.conversationId === order.conversationId &&
      state.sourceConversation.matchBasis === "transcript_file_verified", "module_fact_current_workspace_required");
    const workspace = state.liveWorkspace;
    requireThat(workspace?.runId === order.runId && workspace.profile === order.profile &&
      workspace.projectBinding === workspaceDigest([root, order.profile]), "module_fact_workspace_binding_mismatch");
    const claim = workspace.requests.find(request => request.commandId === order.commandId);
    requireThat(claim && ["host_claimed", "in_doubt"].includes(claim.status) &&
      claim.claim?.conversationDigest === workspaceDigest(order.conversationId), "module_fact_current_claim_required");
    requireThat(claim.outlineBasis === workspace.architecture.basisDigest, "module_fact_claim_basis_changed");
    requireThat(order.kind === claim.kind && order.targetId === claim.targetId && order.sourceVersion === claim.version,
      "module_fact_claim_work_order_mismatch");
    const expectedScope = claim.scope || (claim.kind === "continue_governed_run" && workspace.taskContractVersion === 1 ? {
      kind: "aggregate", moduleIds: workspace.modules.map(module => module.id), requiredModuleIds: workspace.modules.map(module => module.id),
      taskIds: [...new Set(workspace.modules.flatMap(module => module.taskIds || []))].sort() } : null);
    requireThat(expectedScope && workspaceDigest(order.scope) === workspaceDigest(expectedScope), "module_fact_claim_scope_mismatch");
    for (const id of expectedScope.requiredModuleIds) {
      const module = workspace.modules.find(item => item.id === id);
      const planned = order.moduleScopePlan.modules.find(item => item.id === id);
      const review = workspace.reviews.find(item => item.decisionId === module?.decisionId);
      requireThat(module && planned && planned.revision === (module.revision || 1) &&
        planned.basisDigest === (review?.basisDigest || module.basisDigest) &&
        workspaceDigest(planned.taskIds) === workspaceDigest(module.taskIds || []) &&
        workspaceDigest(planned.dependsOn) === workspaceDigest(module.dependsOn || []), "module_fact_claim_design_scope_changed");
    }
    return state;
  }

  function assertScope(state, node, binding) {
    const context = host.moduleRunContext;
    if (binding.runId !== order.runId) requireThat(context?.runId === binding.runId && context.workspaceRunId === order.runId &&
      text(context.previousRunId) && hash(context.designDigest), "module_fact_new_run_context_required");
    const workspace = state.liveWorkspace;
    const architectureBasis = workspaceDigest([workspace.architecture.basisDigest,
      workspace.materials[workspace.architecture.artifactId].sha256]);
    requireThat(order.moduleScopePlan.architecture.id === workspace.architecture.id &&
      order.moduleScopePlan.architecture.revision === (workspace.architecture.revision || 1) &&
      order.moduleScopePlan.architecture.basisDigest === architectureBasis &&
      (node.scope.kind === "module" ? node.scope.architectureBasisDigest === architectureBasis : node.scope.basisDigest === architectureBasis),
    "module_fact_architecture_basis_changed");
    if (node.scope.kind === "module") {
      requireThat(order.scope?.requiredModuleIds?.includes(node.scope.moduleId), "module_fact_scope_not_in_work_order");
      const module = workspace.modules.find(item => item.id === node.scope.moduleId);
      const review = workspace.reviews.find(item => item.decisionId === module?.decisionId);
      requireThat(module && (review?.basisDigest || module.basisDigest) === node.scope.basisDigest &&
        (module.revision || 1) === node.scope.revision, "module_fact_module_basis_changed");
    }
  }

  function checkReviewBindings(state, moduleIds) {
    const workspace = state.liveWorkspace;
    for (const target of [workspace.architecture, ...workspace.modules.filter(module => moduleIds.includes(module.id))]) {
      const bound = order.designReviewBindings?.find(item => item.targetId === target.id);
      const review = workspace.reviews.find(item => item.decisionId === target.decisionId);
      requireThat(bound && review && bound.decisionId === target.decisionId && bound.decisionRevision === review.decision.revision &&
        bound.materialSha256 === workspace.materials[target.artifactId].sha256, "module_fact_review_binding_changed");
    }
  }

  async function factsFor(state, node) {
    const stage = node.stage;
    if (stage === "Critical") {
      const record = state.criticalRecord;
      requireThat(state.stages?.critical?.status === "completed" && text(record?.realIntent) && record.successCriteria?.length > 0 &&
        Array.isArray(record.blockingUnknowns) && record.blockingUnknowns.length === 0, "module_fact_critical_not_complete");
      return { kind: "current_completed_stage_record", stage, record, report: state.hostStageReports?.critical || null };
    }
    if (stage === "Fetch") {
      const record = state.fetchRecord;
      requireThat(state.stages?.fetch?.status === "completed" && record?.evidence?.length > 0 &&
        record.decisionImpactMap?.length > 0 && text(record.memoryStrategy) && record.capabilitySearchPerformed === true &&
        record.capabilityDiscovery?.sources?.length > 0 && record.capabilityDiscovery?.matches?.length > 0,
      "module_fact_fetch_not_complete");
      return { kind: "current_completed_stage_record", stage, record, report: state.hostStageReports?.fetch || null };
    }
    if (stage === "Thinking") {
      const shared = node.scope.kind === "shared";
      const gate = await inspectLiveWorkspaceGate(state, root, shared ? { architectureOnly: true } : { moduleIds: [node.scope.moduleId] });
      requireThat(gate.ready, gate.reason);
      const modules = shared ? [] : gate.reviewedModuleIds;
      checkReviewBindings(state, modules);
      return { kind: "current_local_design_review", stage, gate,
        bindings: order.designReviewBindings.filter(item => item.targetId === state.liveWorkspace.architecture.id || modules.includes(item.targetId)) };
    }
    if (stage === "Evolution") {
      const explicit = host.evolutionDecision;
      if (explicit) requireThat(explicit.runId === order.runId || explicit.runId === host.moduleRunContext?.runId,
        "module_fact_evolution_run_binding_required");
      const record = explicit || state.evolutionWritebackPacket;
      requireThat(record?.decision === "none-with-reason" && text(record.reason), "module_fact_evolution_decision_required");
      return { kind: "existing_inline_evolution_decision", stage, record };
    }
    throw new Error("module_fact_stage_requires_professional_review");
  }

  async function evidenceFor(binding, facts) {
    const relative = `${relativeOwnedRoot}/facts/${workspaceDigest(binding)}.json`;
    requireThat(inspectTrustedPath(root, relative, { allowMissing: true }), "module_fact_artifact_path_invalid");
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    requireThat(inspectTrustedPath(root, relative, { allowMissing: true }), "module_fact_artifact_path_invalid");
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, binding, workspaceRunId: order.runId,
      commandId: order.commandId, facts, evidenceKind: "current_state_facts", nativeInvocationVerified: false,
      ...(host.moduleRunContext ? { moduleRunContext: host.moduleRunContext } : {}) }) + "\n");
    requireThat(bytes.length <= 4 * 1024 * 1024, "module_fact_snapshot_too_large");
    try { await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    requireThat(inspectTrustedPath(root, relative, { allowMissing: false }) && sha(await fs.readFile(target)) === sha(bytes),
      "module_fact_snapshot_replay_conflict");
    return { ref: relative, sha256: sha(bytes) };
  }

  const state = await currentState();
  const candidates = [{ nodeId: "scope:shared:architecture:gate", stage: "Thinking", scope: {
    kind: "shared", architectureId: order.moduleScopePlan.architecture.id, revision: order.moduleScopePlan.architecture.revision,
    basisDigest: order.moduleScopePlan.architecture.basisDigest } }];
  for (const module of order.moduleScopePlan.modules) for (const stage of ["Critical", "Fetch", "Thinking", "Evolution"]) {
    if (!order.scope?.requiredModuleIds?.includes(module.id)) continue;
    if (stage === "Evolution" && (host.evolutionDecision || state.evolutionWritebackPacket)?.decision === "writeback") continue;
    candidates.push({ nodeId: moduleStageNodeId(module.id, stage), stage, scope: { kind: "module", moduleId: module.id,
      revision: module.revision, basisDigest: module.basisDigest, architectureBasisDigest: order.moduleScopePlan.architecture.basisDigest } });
  }
  for (const node of candidates) {
    const executor = { ownerId: state.hostStageReports?.[canonicalStages[node.stage]]?.ownerAgent || "meta-conductor",
      capabilityId: "meta-kim-current-stage-facts", sourceRef: sourcePath, sourceSha256,
      toolBinding: "readSpineStateIncludingInactive/inspectLiveWorkspaceGate", ready: true,
      async validateCurrent({ node: currentNode, runId }) {
        requireThat(currentNode?.nodeId === node.nodeId && currentNode.stage === node.stage &&
          workspaceDigest(currentNode.scope) === workspaceDigest(node.scope), "module_fact_invocation_binding_mismatch");
        const current = await currentState();
        assertScope(current, currentNode, { runId });
        await factsFor(current, currentNode);
        return { ready: true, evidenceKind: "current_state_facts" };
      },
      async invoke(request) {
        request.signal?.throwIfAborted();
        requireThat(request.node?.nodeId === node.nodeId && request.node.stage === node.stage &&
          workspaceDigest(request.node.scope) === workspaceDigest(node.scope) && request.runtime === runtime && path.resolve(request.projectRoot) === root &&
          request.binding?.nodeId === node.nodeId && request.binding.stage === node.stage &&
          request.binding.scopeDigest === moduleStageDigest(request.node.scope) && request.binding.ownerId === executor.ownerId &&
          request.binding.capabilityId === executor.capabilityId && request.binding.sourceSha256 === sourceSha256,
        "module_fact_invocation_binding_mismatch");
        requireThat(sha(await fs.readFile(sourcePath)) === sourceSha256, "module_fact_source_changed");
        const current = await currentState();
        assertScope(current, request.node, request.binding);
        const facts = { ...await factsFor(current, request.node), recordOrigin: current.recordOrigin || "not_recorded" };
        const evidence = await evidenceFor(request.binding, facts);
        return { binding: request.binding, verdict: "pass", evidenceRefs: [evidence],
          criterionResults: [{ id: `current-fact:${request.node.stage}`, status: "pass", evidenceRefs: [evidence.ref] }],
          summary: `Consumed current ${request.node.stage} facts without a new model invocation`,
          hostObservation: { evidenceKind: "current_state_facts", nativeInvocationVerified: false, userAcceptance: false } };
      } };
    try { assertScope(state, node, { runId: order.runId }); await factsFor(state, node); }
    catch (error) { executor.ready = false; executor.reason = error.message; diagnostics.push({ nodeId: node.nodeId, reason: error.message }); }
    executors[node.nodeId] = executor;
  }
  return executors;
}
