import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** Verify the registered design at the existing Thinking completion boundary.
 * Reads only hash-bound material; it never starts a worker or accepts a vote. */
export async function inspectLiveWorkspaceGate(state, projectRoot, { workerTaskPackets, moduleIds, architectureOnly = false } = {}) {
  const workspace = state?.liveWorkspace;
  if (typeof architectureOnly !== "boolean" || architectureOnly && (moduleIds !== undefined || workerTaskPackets !== undefined)) {
    return { ready: false, reason: "live_design_module_scope_invalid" };
  }
  if (!workspace) return { ready: moduleIds === undefined && !architectureOnly, reason: "no_registered_design_workspace" };
  if (workspace.schemaVersion !== "meta-kim-live-workspace-state-v1" || workspace.runId !== state.runId ||
      !Array.isArray(workspace.modules) || (moduleIds === undefined && !architectureOnly && workspace.designStatus !== "accepted")) {
    return { ready: false, reason: "live_design_review_pending", nextAction: workspace.nextAction || null };
  }
  let selectedModules = architectureOnly ? [] : workspace.modules;
  if (moduleIds !== undefined) {
    if (!Array.isArray(moduleIds) || moduleIds.length === 0 || new Set(moduleIds).size !== moduleIds.length ||
        !moduleIds.every(id => workspace.modules.some(module => module.id === id))) return { ready: false, reason: "live_design_module_scope_invalid" };
    const taskIds = new Set(workspace.modules.filter(module => moduleIds.includes(module.id)).flatMap(module => module.taskIds || []));
    const required = new Set(moduleIds);
    for (const module of workspace.modules) if ((module.taskIds || []).some(id => taskIds.has(id))) required.add(module.id);
    for (const id of required) {
      const module = workspace.modules.find(item => item.id === id);
      if (!module) return { ready: false, reason: "live_design_module_scope_invalid" };
      for (const dependency of module.dependsOn || []) required.add(dependency);
    }
    selectedModules = workspace.modules.filter(module => required.has(module.id));
  }
  if (workspace.taskContractVersion !== 1 && selectedModules.some(module => module.taskIds?.length)) {
    return { ready: false, reason: "live_design_task_review_required", nextAction: { kind: "refresh_design_material", stage: "thinking" } };
  }
  const targets = [workspace.architecture, ...selectedModules];
  const currentReviews = (architectureOnly || targets.length > 1) && targets.every(target => {
    const review = (workspace.reviews || []).find(item => item.decisionId === target?.decisionId);
    const material = workspace.materials?.[target?.artifactId];
    const claim = review?.decision?.hostAnswerClaim;
    return material && review?.artifactId === target.artifactId && review.sha256 === material.sha256 &&
      review.decision.status === "host_answer_claimed" && review.decision.nativeSurface === null &&
      claim?.source === "live_local_review" && claim.selectedOptionId === "option:accept" &&
      review.localReview?.source === "same_origin_live_ui" && typeof review.localReview.consumedAt === "string";
  });
  if (!currentReviews || selectedModules.some(module => module.detailed !== true)) {
    return { ready: false, reason: "live_design_current_review_binding_missing" };
  }
  const root = path.resolve(projectRoot);
  async function verify(ref, digest, bytes, capture = false) {
    if (typeof ref !== "string" || path.isAbsolute(ref) || ref.includes("\\") ||
      ref.split("/").some(part => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/u.test(digest || "")) throw new Error("invalid material");
    let target = root;
    for (const part of ref.split("/")) {
      target = path.join(target, part);
      if ((await lstat(target)).isSymbolicLink()) throw new Error("redirected material");
    }
    if (await realpath(target) !== target) throw new Error("redirected material");
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== bytes) throw new Error("changed material");
      const hash = createHash("sha256"), buffer = Buffer.alloc(65536), chunks = [];
      let offset = 0;
      while (offset < bytes) {
        const result = await handle.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset);
        if (!result.bytesRead) throw new Error("short material");
        hash.update(buffer.subarray(0, result.bytesRead));
        if (capture) chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      if (hash.digest("hex") !== digest || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("changed material");
      if (capture) return Buffer.concat(chunks);
    } finally { await handle.close(); }
  }
  try {
    const materials = moduleIds === undefined && !architectureOnly ? Object.values(workspace.materials || {}) : targets.map(target => workspace.materials[target.artifactId]);
    for (const material of materials) {
      await verify(material.ref, material.sha256, material.bytes);
      if (material.sourceRef) await verify(material.sourceRef, material.sourceSha256, material.sourceBytes ?? material.bytes);
    }
  } catch { return { ready: false, reason: "live_design_material_changed", nextAction: { kind: "refresh_design_material", stage: "thinking" } }; }
  if (workerTaskPackets !== undefined) {
    try {
      const ref = workspace.designRef;
      if (!ref || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > 8 * 1024 * 1024) throw new Error("design reference missing");
      const design = JSON.parse((await verify(ref.ref, ref.sha256, ref.bytes, true)).toString("utf8"));
      // Required module reviews and executable tasks have different scopes:
      // co-owners may own unrelated tasks which this request must not execute.
      const scopeTasks = moduleIds === undefined ? null : new Set(workspace.modules.filter(module => moduleIds.includes(module.id)).flatMap(module => module.taskIds || []));
      if (scopeTasks) for (const id of scopeTasks) {
        const task = (design.taskSlices || []).find(item => item.id === id);
        if (!task) throw new Error("task scope");
        for (const dependency of task.dependsOn || []) scopeTasks.add(dependency);
      }
      const tasks = (design.taskSlices || []).filter(task => scopeTasks === null || scopeTasks.has(task.id));
      if (tasks.length) {
        if (!tasks.every(task => design.softwareDesign?.modules?.some(module => module.taskIds?.includes(task.id) &&
          module.taskContracts?.some(contract => JSON.stringify(contract) === JSON.stringify(task))))) {
          return { ready: false, reason: "live_design_task_review_required", nextAction: { kind: "refresh_design_material", stage: "thinking" } };
        }
        const packets = new Map(workerTaskPackets.map(packet => [packet.roleInstanceId, packet]));
        if (packets.size !== tasks.length || workerTaskPackets.length !== tasks.length) throw new Error("task coverage");
        for (const task of tasks) {
          const packet = packets.get(task.id);
          const expected = (task.dependsOn || []).map(id => packets.get(id)?.taskPacketId);
          const same = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && b.every(id => a.includes(id));
          if (!packet || !packet.progressBasisEvidence?.some(item => item.ref === ref.ref && item.sha256 === ref.sha256) || !same(packet.dependsOn, expected) || !same(packet.acceptanceCriterionIds, task.criterionIds)) throw new Error("task binding");
        }
      }
    } catch { return { ready: false, reason: "live_design_worker_task_binding_missing", nextAction: { kind: "bind_reviewed_design_tasks", stage: "thinking" } }; }
  }
  return { ready: true, reason: "current_local_design_reviews_consumed", nativeInvocationVerified: false,
    ...(architectureOnly ? { architectureOnly: true, reviewedModuleIds: [], aggregateDesignAccepted: workspace.designStatus === "accepted" } : {}),
    ...(moduleIds === undefined ? {} : { moduleIds: [...moduleIds], reviewedModuleIds: selectedModules.map(module => module.id),
      aggregateDesignAccepted: workspace.designStatus === "accepted" }) };
}
