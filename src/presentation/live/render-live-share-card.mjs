import { assertValidLiveShareArtifact } from "../../domain/live/live-share-artifact.mjs";

function markdownText(value, fallback = "unknown") {
  const text = typeof value === "string" && value.length > 0 ? value : fallback;
  if (text.length > 2000 || /[\u0000-\u001f\u007f]/u.test(text)) return markdownText(fallback, "unknown");
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replace(/[\\`*_[\]{}()#+!|~]/gu, "\\$&")
    .replace(/[\r\n]/gu, " ");
}

function safeRelativePath(value) {
  if (typeof value !== "string") return "./.meta-kim/live/share-artifact.json";
  const path = value.trim();
  if (
    !path ||
    path.length > 240 ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.startsWith("//") ||
    path.split(/[\\/]/u).includes("..") ||
    /^[A-Za-z][A-Za-z+.-]*:/u.test(path) ||
    !/^[A-Za-z0-9._/-]+$/u.test(path) ||
    /[()<>\u0026`*_[\]{}#!|~]/u.test(path)
  ) return "./.meta-kim/live/share-artifact.json";
  return path.replaceAll("\\", "/");
}

function formatTimestamp(value) {
  return value || "not recorded";
}

function statusLabel(value) {
  return value.replaceAll("_", " ");
}

function digestLine(artifact) {
  return `Content digest: \`${markdownText(artifact.contentDigest)}\``;
}

function nodeRows(artifact) {
  if (!artifact.nodes.length) return "| — | — | — | — | — |\n| --- | --- | --- | --- | --- |";
  return artifact.nodes.map((node) => [
    markdownText(node.label),
    markdownText(node.stage),
    markdownText(statusLabel(node.status)),
    markdownText(node.ownerAgent),
    String(node.evidenceCount),
  ].join(" | ")).join("\n");
}

function evidenceRows(artifact) {
  if (!artifact.evidence.length) return "| — | — | — |\n| --- | --- | --- |";
  return artifact.evidence.map((item) => [
    markdownText(item.type),
    markdownText(item.label),
    markdownText(statusLabel(item.status)),
  ].join(" | ")).join("\n");
}

function replayRows(artifact) {
  if (!artifact.replay.events.length) return "| — | — | — | — |\n| --- | --- | --- | --- |";
  return artifact.replay.events.map((event) => [
    String(event.sequence),
    markdownText(event.at),
    markdownText(event.label),
    markdownText(statusLabel(event.status)),
  ].join(" | ")).join("\n");
}

/**
 * Render a review-friendly, text-only PR card. The renderer validates the
 * content binding before interpolation and never emits HTML or executable
 * markup.
 */
export function renderLiveShareCard(artifact, options = {}) {
  assertValidLiveShareArtifact(artifact);
  const title = markdownText(options.title, "Meta_Kim Live proof");
  const sourceLabel = markdownText(artifact.source.kind);
  const state = artifact.source.stale ? "stale / in doubt" : statusLabel(artifact.run.status);
  const replayCount = artifact.replay.events.length;
  return [
    `## ${title}`,
    "",
    "> Read-only, content-bound replay projection. It does not authorize execution or mutation.",
    "",
    "| Run | Status | Current stage | Source | Replay events |",
    "| --- | --- | --- | --- | --- |",
    `| ${markdownText(artifact.run.runId)} | ${markdownText(state)} | ${markdownText(artifact.run.currentStage)} | ${sourceLabel} | ${replayCount} |`,
    "",
    digestLine(artifact),
    "",
    `Observed: ${markdownText(formatTimestamp(artifact.source.observedAt))}  `,
    `Updated: ${markdownText(formatTimestamp(artifact.run.updatedAt))}`,
    "",
    "### Nodes",
    "",
    "| Node | Stage | Status | Owner | Evidence |",
    "| --- | --- | --- | --- | --- |",
    nodeRows(artifact),
    "",
    "### Evidence",
    "",
    "| Type | Label | Status |",
    "| --- | --- | --- |",
    evidenceRows(artifact),
    "",
    "### Public replay",
    "",
    "| # | At | Event | Status |",
    "| --- | --- | --- | --- |",
    replayRows(artifact),
    "",
    "Permissions: read-only; execution allowed: false; mutation allowed: false.",
  ].join("\n");
}

/** Render a compact README section that links to a caller-supplied relative artifact path. */
export function renderLiveReadmeEmbed(artifact, options = {}) {
  assertValidLiveShareArtifact(artifact);
  const artifactPath = safeRelativePath(options.artifactPath);
  const title = markdownText(options.title, "Meta_Kim Live replay");
  const state = artifact.source.stale ? "stale / in doubt" : statusLabel(artifact.run.status);
  return [
    `## ${title}`,
    "",
    `Meta_Kim Live observed run \`${markdownText(artifact.run.runId)}\` in **${markdownText(state)}** at stage **${markdownText(artifact.run.currentStage)}**.`,
    "",
    `- Replay events: **${artifact.replay.events.length}**`,
    `- Content digest: \`${markdownText(artifact.contentDigest)}\``,
    "- Surface: read-only; no execution or mutation authority",
    `- [Open the verified replay artifact](./${safeRelativePath(artifactPath).replace(/^\.\//u, "")})`,
  ].join("\n");
}

export const renderLivePrCard = renderLiveShareCard;
export const renderPrCard = renderLiveShareCard;
export const renderReadmeEmbed = renderLiveReadmeEmbed;
export const renderLiveReadmeSection = renderLiveReadmeEmbed;
