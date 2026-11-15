import { createHash } from "node:crypto";
import { createDecision, presentDecision, assertValidDecision } from "../decision/decision.mjs";

export const LIVE_WORKSPACE_SCHEMA = "meta-kim-live-workspace-v1";
export const LIVE_WORKSPACE_STATE_SCHEMA = "meta-kim-live-workspace-state-v1";
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const workspaceDigest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const workspaceBytesDigest = value => createHash("sha256").update(value).digest("hex");
export function workspaceFailure(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
export function workspaceRequire(condition, code, status = 400) {
  if (!condition) throw workspaceFailure(code, status);
}
export const workspaceText = (value, limit = 240) => typeof value === "string" ? value.slice(0, limit) : "";
export const workspaceVersion = sha256 => `sha256:${sha256}`;

export function createWorkspaceReview({ runId, targetId, moduleId = null, material, basisDigest, generation, at, policy }) {
  const evidenceRef = `material:${material.sha256}`;
  const decision = presentDecision(createDecision({
    identity: { runId: `run:${workspaceDigest(runId)}`, scopeRef: `scope:${workspaceDigest(targetId)}`,
      decisionKey: `review:${workspaceDigest([material.sha256, basisDigest, generation])}` },
    decisionType: "decision:live-design-review", routeChangingDimensions: ["acceptance"],
    options: policy.choices.map(choice => ({ optionId: `option:${choice.id}`, displayRef: `display:${choice.id}`,
      tradeoffRefs: [`tradeoff:${choice.id}`], evidenceRefs: [evidenceRef] })),
    evidence: [{ evidenceRef, digest: workspaceVersion(material.sha256) },
      { evidenceRef: "context:design-boundary", digest: workspaceVersion(basisDigest) }],
    requirement: { required: true, reasonRef: "reason:human-design-review", evidenceRefs: [evidenceRef] },
    nativeSurface: null, createdAt: at,
  }), { at });
  return { decisionId: decision.decisionId, decision, kind: moduleId === null ? "outline" : "module", moduleId,
    artifactId: material.artifactId, version: workspaceVersion(material.sha256), sha256: material.sha256,
    materialFormat: material.format,
    basisDigest, issuedAt: at, expiresAt: new Date(Date.parse(at) + policy.reviewValidityMs).toISOString() };
}

export function workspaceReviewState(review, now = Date.now()) {
  if (!review) return "not_reviewed";
  assertValidDecision(review.decision);
  if (review.decision.status === "invalidated") return "invalidated";
  const claim = review.decision.hostAnswerClaim;
  if (claim) {
    workspaceRequire(claim.source === "live_local_review" && claim.runtime === "meta_kim_live" &&
      claim.surface === "local_project_review" && review.decision.nativeSurface === null,
    "workspace_review_source_invalid", 409);
    return { "option:accept": "accepted", "option:revise": "revision_required", "option:return": "returned" }[claim.selectedOptionId] || "invalidated";
  }
  return now >= Date.parse(review.expiresAt) ? "expired" : "awaiting_human";
}

/** A shared task has one execution identity. Every module whose contract owns
 * that task must be current before it can be handed to an execution worker. */
export function workspaceModuleRequirements(workspace, moduleIds) {
  workspaceRequire(Array.isArray(moduleIds) && moduleIds.length > 0 && new Set(moduleIds).size === moduleIds.length,
    "workspace_module_scope_invalid", 409);
  const byId = new Map(workspace.modules.map(module => [module.id, module]));
  workspaceRequire(moduleIds.every(id => byId.has(id)), "workspace_module_scope_invalid", 409);
  const taskIds = [...new Set(moduleIds.flatMap(id => byId.get(id).taskIds || []))].sort();
  const required = new Set(moduleIds);
  // A co-owner contributes its current review to these tasks. Its other,
  // unrelated tasks do not expand this execution's shared ownership graph.
  for (const other of workspace.modules) if ((other.taskIds || []).some(id => taskIds.includes(id))) required.add(other.id);
  for (const id of required) {
    const module = byId.get(id);
    for (const dependency of module.dependsOn || []) {
      workspaceRequire(byId.has(dependency), "workspace_module_dependency_invalid", 409);
      required.add(dependency);
    }
  }
  return { moduleIds: [...required].sort(), taskIds };
}

/** Cursor and module state are derived from the current design version and its
 * exact Decision records; this module creates no independent execution queue. */
export function deriveWorkspaceProgress(workspace, now = Date.now()) {
  const reviews = new Map(workspace.reviews.map(review => [review.decisionId, review]));
  const outline = workspaceReviewState(reviews.get(workspace.architecture.decisionId), now);
  const modules = workspace.modules.map(module => ({ ...module, status: module.detailed
    ? workspaceReviewState(reviews.get(module.decisionId), now) : "needs_detail" }));
  let nextAction;
  const readyActions = [], blockedActions = [];
  if (outline !== "accepted") {
    nextAction = { kind: outline === "expired" ? "refresh_design_review"
      : ["revision_required", "returned", "invalidated"].includes(outline) ? "revise_outline" : "awaiting_review",
      stage: "thinking", moduleId: null, summary: outline === "expired" ? "审阅已过期；请当前宿主重新登记原材料后再审阅"
        : outline === "awaiting_human" ? "请审阅当前系统模块大纲" : "系统模块大纲需要重新核对或修订" };
    (nextAction.kind === "revise_outline" ? readyActions : blockedActions).push(nextAction);
  } else {
    const statuses = new Map(modules.map(module => [module.id, module.status]));
    for (const module of modules) {
      if (module.status === "accepted") continue;
      const dependencies = module.dependsOn.filter(id => statuses.get(id) !== "accepted");
      const action = { kind: dependencies.length ? "awaiting_dependency" : module.status === "needs_detail" ? "design_module"
        : ["revision_required", "returned", "invalidated", "expired", "not_reviewed"].includes(module.status) ? "revise_module" : "awaiting_review",
      stage: "thinking", moduleId: module.id, ...(dependencies.length ? { dependsOn: dependencies } : {}),
      summary: dependencies.length ? `模块等待相关设计采纳：${module.title}` : module.status === "needs_detail" ? `继续详细设计：${module.title}`
        : module.status === "awaiting_human" ? `请审阅模块：${module.title}` : `修订或重新核对模块：${module.title}` };
      (["design_module", "revise_module"].includes(action.kind) ? readyActions : blockedActions).push(action);
    }
    const allAccepted = modules.every(module => module.status === "accepted");
    if (!allAccepted) for (const module of modules.filter(item => item.status === "accepted" && item.taskIds?.length)) {
      const scope = workspaceModuleRequirements(workspace, [module.id]);
      const waiting = scope.moduleIds.filter(id => statuses.get(id) !== "accepted");
      if (!waiting.length) readyActions.push({ kind: "continue_module", stage: "thinking", moduleId: module.id,
        scope: { kind: "module", moduleIds: [module.id], requiredModuleIds: scope.moduleIds, taskIds: scope.taskIds },
        summary: `模块设计已采纳，可继续执行与核验：${module.title}` });
      else blockedActions.push({ kind: "awaiting_dependency", stage: "thinking", moduleId: module.id,
        dependsOn: waiting, summary: `共享任务等待相关模块设计采纳：${module.title}` });
    }
    if (allAccepted) readyActions.push({ kind: "continue_governed_run", stage: "thinking", moduleId: null,
      summary: "设计已逐项采纳；由当前宿主完成 Thinking 关口并继续原工作流" });
    nextAction = readyActions[0] || blockedActions[0];
  }
  return { outlineStatus: outline, modules, nextAction, readyActions, blockedActions,
    designStatus: outline === "accepted" && modules.every(module => module.status === "accepted") ? "accepted" : "in_progress" };
}

export function boundedWorkspaceRequest(request) {
  return { commandId: request.commandId, nonce: request.nonce, kind: request.kind, status: request.status,
    targetId: request.targetId, createdAt: request.createdAt, updatedAt: request.updatedAt,
    summary: workspaceText(request.summary), completionVerified: false,
    ...(request.outcome ? { outcome: request.outcome } : {}),
    ...(request.receiptMaterial && request.receipt ? { receipt: {
      ref: request.receiptMaterial.ref, sha256: request.receiptMaterial.sha256,
      evidenceLevel: request.receipt.evidenceLevel, evidenceCount: request.receipt.evidenceCount,
      // The full immutable receipt stays on disk. One actual file reference
      // keeps overview/history pages bounded even for 32-file reports.
      evidenceRefs: (request.receipt.evidenceRefs || []).slice(0, 1),
      evidenceOmitted: Math.max(0, request.receipt.evidenceCount - (request.receipt.evidenceRefs || []).slice(0, 1).length),
      completionVerified: false, nativeInvocationVerified: false,
    } } : {}) };
}
