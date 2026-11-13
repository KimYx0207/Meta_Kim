import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

/** Verify the registered design at the existing Thinking completion boundary.
 * Reads only hash-bound material; it never starts a worker or accepts a vote. */
export async function inspectLiveWorkspaceGate(state, projectRoot) {
  const workspace = state?.liveWorkspace;
  if (!workspace) return { ready: true, reason: "no_registered_design_workspace" };
  if (workspace.schemaVersion !== "meta-kim-live-workspace-state-v1" || workspace.runId !== state.runId ||
      workspace.designStatus !== "accepted") return { ready: false, reason: "live_design_review_pending", nextAction: workspace.nextAction || null };
  const targets = [workspace.architecture, ...(workspace.modules || [])];
  const currentReviews = targets.length > 1 && targets.every(target => {
    const review = (workspace.reviews || []).find(item => item.decisionId === target?.decisionId);
    const material = workspace.materials?.[target?.artifactId];
    const claim = review?.decision?.hostAnswerClaim;
    return material && review?.artifactId === target.artifactId && review.sha256 === material.sha256 &&
      review.decision.status === "host_answer_claimed" && review.decision.nativeSurface === null &&
      claim?.source === "live_local_review" && claim.selectedOptionId === "option:accept" &&
      review.localReview?.source === "same_origin_live_ui" && typeof review.localReview.consumedAt === "string";
  });
  if (!currentReviews || workspace.modules.some(module => module.detailed !== true)) {
    return { ready: false, reason: "live_design_current_review_binding_missing" };
  }
  const root = path.resolve(projectRoot);
  async function verify(ref, digest, bytes) {
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
      const hash = createHash("sha256"), buffer = Buffer.alloc(65536);
      let offset = 0;
      while (offset < bytes) {
        const result = await handle.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset);
        if (!result.bytesRead) throw new Error("short material");
        hash.update(buffer.subarray(0, result.bytesRead)); offset += result.bytesRead;
      }
      const after = await handle.stat();
      if (hash.digest("hex") !== digest || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("changed material");
    } finally { await handle.close(); }
  }
  try {
    for (const material of Object.values(workspace.materials || {})) {
      await verify(material.ref, material.sha256, material.bytes);
      if (material.sourceRef) await verify(material.sourceRef, material.sourceSha256, material.bytes);
    }
  } catch { return { ready: false, reason: "live_design_material_changed", nextAction: { kind: "refresh_design_material", stage: "thinking" } }; }
  return { ready: true, reason: "current_local_design_reviews_consumed", nativeInvocationVerified: false };
}
