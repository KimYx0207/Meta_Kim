/** Human-authored, reviewable design contracts for B2. No native execution. */
import { createHash } from "node:crypto";

import { AGENT_WORKFLOW_KEY_PATTERN, agentWorkflowConflict } from "./agent-workflow-decision.mjs";

export const AGENT_DESIGN_SCHEMA = "meta-kim-agent-design-v1";
export const AGENT_DESIGN_RECORD_SCHEMA = "meta-kim-agent-design-record-v1";
export const AGENT_DESIGN_MAX_VERSIONS = 256;
export const AGENT_DESIGN_MAX_PENDING_REVIEW_NOTES = 64;
const NODE_ID = /^[a-z][a-z0-9_-]{1,31}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

function stringField(value, maximum) {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result && result.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)
    ? result : null;
}

function textArray(value, minimum = 1, maximum = 24) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return null;
  const list = value.map((entry) => stringField(entry, 600));
  return list.some((entry) => entry == null) ? null : list;
}

function normalizeSystem(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const title = stringField(input.title, 160);
  const goal = stringField(input.goal, 4_000);
  const architecture = stringField(input.architecture, 8_000);
  const techStack = stringField(input.techStack, 4_000);
  const acceptance = textArray(input.acceptance);
  return title && goal && architecture && techStack && acceptance
    ? { title, goal, architecture, techStack, acceptance } : null;
}

function normalizeModule(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || typeof input.id !== "string" || !NODE_ID.test(input.id)) return null;
  const title = stringField(input.title, 160);
  const objective = stringField(input.objective, 4_000);
  const inputContract = textArray(input.inputContract);
  const outputContract = textArray(input.outputContract);
  const boundaries = textArray(input.boundaries, 0);
  const acceptance = textArray(input.acceptance);
  const deps = input.dependencies;
  if (!title || !objective || !inputContract || !outputContract || !boundaries || !acceptance
    || !Array.isArray(deps) || deps.length > 31
    || !deps.every((id) => typeof id === "string" && NODE_ID.test(id))
    || new Set(deps).size !== deps.length) return null;
  return { id: input.id, title, objective, inputContract, outputContract,
    boundaries, acceptance, dependencies: [...deps] };
}

export function validateDesignDag(modules) {
  if (!Array.isArray(modules) || modules.length < 1 || modules.length > 32) return false;
  const byId = new Map(modules.map((module) => [module.id, module]));
  if (byId.size !== modules.length) return false;
  const state = new Map();
  function visit(id) {
    if (state.get(id) === "done") return true;
    if (state.get(id) === "visiting") return false;
    const module = byId.get(id);
    if (!module) return false;
    state.set(id, "visiting");
    for (const dependency of module.dependencies) {
      if (!byId.has(dependency) || dependency === id || !visit(dependency)) return false;
    }
    state.set(id, "done");
    return true;
  }
  return [...byId.keys()].every(visit);
}

export function normalizeDesign(input) {
  const system = normalizeSystem(input?.system);
  if (!system || !Array.isArray(input.modules)
    || input.modules.length < 1 || input.modules.length > 32) return null;
  const modules = input.modules.map(normalizeModule);
  if (modules.some((entry) => !entry) || !validateDesignDag(modules)) return null;
  return { system, modules };
}

export function validateDesignMutation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.hasOwn(input, "projectId") || Object.hasOwn(input, "projectRoot")
    || !AGENT_WORKFLOW_KEY_PATTERN.test(input.idempotencyKey ?? "")
    || typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(input.requestId)
    || typeof input.planDigest !== "string" || !DIGEST.test(input.planDigest)
    || !AGENT_WORKFLOW_KEY_PATTERN.test(input.decisionKey ?? "")
    || !AGENT_WORKFLOW_KEY_PATTERN.test(input.mutationKey ?? "")
    || !Number.isSafeInteger(input.expectedVersion)
    || input.expectedVersion < 0 || input.expectedVersion > AGENT_DESIGN_MAX_VERSIONS) return null;
  const action = input.action;
  if (!["submit", "revise_module", "revise_system", "approve", "revoke", "request_revision"].includes(action)) return null;
  const base = {
    action, idempotencyKey: input.idempotencyKey, requestId: input.requestId,
    planDigest: input.planDigest, decisionKey: input.decisionKey,
    mutationKey: input.mutationKey, expectedVersion: input.expectedVersion,
  };
  if (action === "submit") {
    const design = normalizeDesign(input.design);
    if (input.sourceDraftDigest != null
      && (typeof input.sourceDraftDigest !== "string" || !DIGEST.test(input.sourceDraftDigest))) return null;
    return design && input.expectedVersion === 0 ? {
      ...base, design,
      ...(input.sourceDraftDigest && { sourceDraftDigest: input.sourceDraftDigest }),
    } : null;
  }
  if (action === "revise_module") {
    const module = normalizeModule(input.module);
    return module && input.expectedVersion > 0 ? { ...base, module } : null;
  }
  if (action === "revise_system") {
    const system = normalizeSystem(input.system);
    return system && input.expectedVersion > 0 ? { ...base, system } : null;
  }
  const kind = input.target?.kind;
  if (!input.target || typeof input.target !== "object" || Array.isArray(input.target)
    || !["system", "module"].includes(kind) || input.expectedVersion < 1
    || (kind === "module" && (typeof input.target.moduleId !== "string"
      || !NODE_ID.test(input.target.moduleId)))
    || (kind === "system" && input.target.moduleId != null)) return null;
  const target = { kind, ...(kind === "module" && { moduleId: input.target.moduleId }) };
  if (action === "request_revision") {
    const feedback = stringField(input.feedback, 2_000);
    if (!feedback || Buffer.byteLength(feedback, "utf8") > 8_000) return null;
    return { ...base, target, feedback };
  }
  return { ...base, target };
}

function initialApproval() {
  return { state: "pending", version: null, at: null, reason: null };
}

function invalidate(approval, reason) {
  return approval.state === "approved" || approval.state === "invalidated"
    ? { state: "invalidated", version: null, at: null, reason } : approval;
}

function changed(approval, reason) {
  return { state: approval.state === "approved" || approval.state === "invalidated"
    ? "invalidated" : "pending", version: null, at: null,
  reason: approval.state === "approved" || approval.state === "invalidated" ? reason : null };
}

function downstream(moduleId, modules) {
  const selected = new Set([moduleId]);
  let previous = 0;
  while (previous !== selected.size) {
    previous = selected.size;
    for (const module of modules) {
      if (module.dependencies.some((dependency) => selected.has(dependency))) selected.add(module.id);
    }
  }
  selected.delete(moduleId);
  return selected;
}

function statusOf(content) {
  if (content.pendingReviewNotes?.length) return "reviewing";
  const approvals = [content.system.approval, ...content.modules.map((module) => module.approval)];
  if (approvals.every((approval) => approval.state === "approved")) return "approved";
  if (approvals.some((approval) => approval.state !== "pending")) return "reviewing";
  return "draft";
}

export function applyDesignMutation(prior, mutation, nextVersion, now) {
  if (!Number.isInteger(nextVersion) || nextVersion < 1) throw new TypeError("Invalid design version");
  if (mutation.action === "submit") {
    if (prior) throw agentWorkflowConflict("agent_design_already_exists");
    return { content: {
      system: { ...mutation.design.system, approval: initialApproval() },
      modules: mutation.design.modules.map((module) => ({ ...module, approval: initialApproval() })),
      pendingReviewNotes: [],
    }, changedNodeIds: ["system", ...mutation.design.modules.map((module) => module.id)],
    invalidatedModuleIds: [], status: "draft" };
  }
  if (!prior) throw agentWorkflowConflict("agent_design_not_found");
  const content = structuredClone(prior);
  const byId = new Map(content.modules.map((module) => [module.id, module]));
  const changedNodeIds = [];
  const invalidatedModuleIds = [];
  const resolvedReviewNoteIds = [];
  let reviewNote = null;
  const clearNodeNotes = (kind, id = null) => {
    const remaining = [];
    for (const note of content.pendingReviewNotes || []) {
      if (note.target.kind === kind && (kind === "system" || note.target.moduleId === id)) {
        resolvedReviewNoteIds.push(note.noteId);
      } else remaining.push(note);
    }
    content.pendingReviewNotes = remaining;
  };
  if (mutation.action === "revise_module") {
    const old = byId.get(mutation.module.id);
    if (!old) throw agentWorkflowConflict("agent_design_module_not_found");
    const { approval: ignored, ...before } = old;
    if (JSON.stringify(before) === JSON.stringify(mutation.module)) throw agentWorkflowConflict("agent_design_no_changes");
    const replacement = { ...mutation.module, approval: changed(old.approval, "module_changed") };
    const index = content.modules.findIndex((module) => module.id === mutation.module.id);
    content.modules[index] = replacement;
    if (!validateDesignDag(content.modules)) throw agentWorkflowConflict("agent_design_dependency_cycle_or_missing");
    clearNodeNotes("module", mutation.module.id);
    changedNodeIds.push(mutation.module.id);
    for (const id of downstream(mutation.module.id, content.modules)) {
      const dependent = content.modules.find((module) => module.id === id);
      dependent.approval = invalidate(dependent.approval, "upstream_changed");
      invalidatedModuleIds.push(id);
    }
  } else if (mutation.action === "revise_system") {
    const { approval: ignored, ...before } = content.system;
    if (JSON.stringify(before) === JSON.stringify(mutation.system)) throw agentWorkflowConflict("agent_design_no_changes");
    content.system = { ...mutation.system, approval: changed(content.system.approval, "system_changed") };
    clearNodeNotes("system");
    changedNodeIds.push("system");
    for (const module of content.modules) {
      module.approval = invalidate(module.approval, "system_changed");
      invalidatedModuleIds.push(module.id);
    }
  } else if (mutation.action === "request_revision") {
    const { kind, moduleId } = mutation.target;
    const node = kind === "system" ? content.system : byId.get(moduleId);
    if (!node) throw agentWorkflowConflict("agent_design_module_not_found");
    if ((content.pendingReviewNotes?.length || 0) >= AGENT_DESIGN_MAX_PENDING_REVIEW_NOTES) {
      throw agentWorkflowConflict("agent_design_feedback_limit");
    }
    reviewNote = { noteId: mutation.mutationKey, target: mutation.target,
      sourceVersion: mutation.expectedVersion, feedback: mutation.feedback, at: now };
    content.pendingReviewNotes = [...content.pendingReviewNotes || [], reviewNote];
    node.approval = changed(node.approval, "revision_requested");
    changedNodeIds.push(kind === "system" ? "system" : moduleId);
    const affected = kind === "system" ? new Set(content.modules.map((module) => module.id))
      : downstream(moduleId, content.modules);
    for (const id of affected) {
      const dependent = content.modules.find((module) => module.id === id);
      dependent.approval = invalidate(dependent.approval, "upstream_revision_requested");
      invalidatedModuleIds.push(id);
    }
  } else if (mutation.action === "approve" || mutation.action === "revoke") {
    const { kind, moduleId } = mutation.target;
    const node = kind === "system" ? content.system : byId.get(moduleId);
    if (!node) throw agentWorkflowConflict("agent_design_module_not_found");
    if (mutation.action === "approve") {
      if (node.approval.state === "approved") throw agentWorkflowConflict("agent_design_already_approved");
      if (content.pendingReviewNotes?.some((note) => note.target.kind === kind
        && (kind === "system" || note.target.moduleId === moduleId))) {
        throw agentWorkflowConflict("agent_design_unresolved_feedback");
      }
      if (kind === "module") {
        if (content.system.approval.state !== "approved"
          || node.dependencies.some((id) => byId.get(id)?.approval.state !== "approved")) {
          throw agentWorkflowConflict("agent_design_dependencies_not_approved");
        }
      }
      node.approval = { state: "approved", version: nextVersion, at: now, reason: null };
    } else {
      if (node.approval.state !== "approved") throw agentWorkflowConflict("agent_design_not_approved");
      node.approval = { state: "revoked", version: null, at: now, reason: "user_revoked" };
      const affected = kind === "system" ? new Set(content.modules.map((module) => module.id))
        : downstream(moduleId, content.modules);
      for (const id of affected) {
        const dependent = content.modules.find((module) => module.id === id);
        dependent.approval = invalidate(dependent.approval, "upstream_revoked");
        invalidatedModuleIds.push(id);
      }
    }
    changedNodeIds.push(kind === "system" ? "system" : moduleId);
  }
  return { content, changedNodeIds, invalidatedModuleIds,
    ...(reviewNote && { reviewNote }), resolvedReviewNoteIds, status: statusOf(content) };
}

function withoutApproval(content) {
  const { approval: systemApproval, ...system } = content.system;
  return { system, modules: content.modules.map(({ approval, ...module }) => module) };
}

export function designArtifactDigest(basis, content) {
  return createHash("sha256").update("meta-kim-human-design-artifact-v1\u0000")
    .update(JSON.stringify({ basis, design: withoutApproval(content) })).digest("hex");
}

export function designVersionDigest(record) {
  const { recordDigest: ignored, ...fields } = record;
  return createHash("sha256").update("meta-kim-human-design-version-v1\u0000")
    .update(JSON.stringify(fields)).digest("hex");
}
