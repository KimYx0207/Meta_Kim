import { LIVE_WORKSPACE_MESSAGES } from "./live-workspace-copy.mjs";
export { LIVE_WORKSPACE_MESSAGES };


export function workspaceStatusKey(status) {
  const value = String(status || "unknown").toLowerCase();
  const aliases = { active: "running", current: "running", in_progress: "running", "in-progress": "running", live: "running", queued: "planned", upcoming: "planned", not_started: "planned", pending: "waiting", waiting_for_human: "waiting_human", awaiting_human: "waiting_human", paused: "waiting", succeeded: "completed", verified: "completed", unreported: "unknown", not_recorded: "unknown", not_observed: "unknown", in_doubt: "unproven", adopted: "accepted", revise: "revised", revision_required: "revised", return: "returned" };
  return aliases[value] || value;
}

export function workspaceArtifactItems(workspace) {
  const design = workspace?.design || {};
  const items = [];
  if (design.architecture?.artifactId) items.push({ ...design.architecture, kind: "outline", moduleId: null });
  for (const module of Array.isArray(design.modules) ? design.modules : []) {
    if (module?.id) items.push({ ...module, kind: "module", moduleId: module.id });
  }
  return items;
}

export function workspaceMaterialIdentity(item) {
  return item?.artifactId ? [String(item.artifactId), String(item.version ?? ""), String(item.sha256 ?? "")].join("\u001f") : "";
}

export function workspaceMaterialMatches(item, page) {
  return Boolean(item?.artifactId && page && page.artifactId === item.artifactId && String(page.version) === String(item.version)
    && typeof page.sha256 === "string" && (!item.sha256 || page.sha256 === item.sha256) && typeof page.text === "string");
}

export function workspaceMaterialReady(item, material) {
  return Boolean(item?.artifactId && material?.verified === true && material.identity === workspaceMaterialIdentity(item)
    && typeof material.sha256 === "string" && (!item.sha256 || material.sha256 === item.sha256)
    && material.conflict !== true && material.sourceState !== "changed");
}

export function workspaceReviewForArtifact(workspace, item) {
  if (!item?.artifactId) return null;
  return (workspace?.reviews || []).find((review) => review.artifactId === item.artifactId
    && String(review.version) === String(item.version) && (!item.sha256 || !review.sha256 || review.sha256 === item.sha256)
    && review.state === "awaiting_human") || null;
}

export function workspaceCommandMessage(status, kind) {
  if (["recorded", "waiting_host"].includes(status)) return kind === "feedback" ? "feedbackRecorded" : "receiptRecorded";
  if (status === "host_claimed") return "hostClaimed";
  if (status === "host_reported") return "hostReported";
  if (status === "superseded") return "supersededMessage";
  return "uncertain";
}

export function serializeLiveWorkspaceModel() {
  return `const LIVE_WORKSPACE_MESSAGES = ${JSON.stringify(LIVE_WORKSPACE_MESSAGES)};\n${[
    workspaceStatusKey, workspaceArtifactItems, workspaceMaterialIdentity, workspaceMaterialMatches, workspaceMaterialReady,
    workspaceReviewForArtifact, workspaceCommandMessage,
  ].map((fn) => fn.toString()).join("\n")}`;
}
