import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { checkedPath, sha256 } from "./source-integrity.mjs";

// These limits bound prompt material, not professional quality. Large references
// should remain on-demand resources instead of silently truncated instructions.
export const METHOD_KNOWLEDGE_LIMITS = Object.freeze({ assets: 16, perAssetBytes: 32 * 1024, totalBytes: 128 * 1024 });

/** Compare selections as sets without hiding invalid types or duplicate IDs. */
export function canonicalMethodKnowledgeSelection(ids) {
  if (ids === undefined) return [];
  return Array.isArray(ids) && ids.every(id => typeof id === "string") ? ids.toSorted() : ids;
}

function appliesToTask(asset, capabilityId, packet) {
  const selectors = new Set(["always", capabilityId, packet.stage, packet.workKind].filter(Boolean));
  return asset.appliesTo.some(selector => selectors.has(selector));
}

/** Evidence for extra resources from an already source-verified method load. */
export function additionalMethodKnowledgeEvidence(method, packet = {}) {
  const capabilityId = method.capabilityId.slice(method.capabilityId.indexOf(":") + 1);
  const declarations = new Map((method.method?.knowledgeAssets ?? []).map(asset => [asset.id, asset]));
  return (method.knowledgeAssets ?? [])
    .filter(asset => !appliesToTask(declarations.get(asset.id), capabilityId, packet))
    .map(({ id, sha256 }) => ({ id, sha256 }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export async function loadMethodKnowledgeAssets({ componentRoot, method, capabilityId, packet = {} }) {
  const declarations = method?.knowledgeAssets ?? [];
  assert(Array.isArray(declarations) && declarations.length <= METHOD_KNOWLEDGE_LIMITS.assets, "method knowledge asset declaration exceeds the bounded limit");
  // The host may select an on-demand resource by its declared ID after reading
  // its applicability guidance; prose conditions are not task-kind selectors.
  const requestedIds = canonicalMethodKnowledgeSelection(packet.methodKnowledgeAssetIds);
  assert(Array.isArray(requestedIds) && requestedIds.length <= METHOD_KNOWLEDGE_LIMITS.assets &&
    requestedIds.every(id => typeof id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) &&
    new Set(requestedIds).size === requestedIds.length, "method knowledge selection requires a bounded array of unique asset IDs");
  assert(requestedIds.every(id => declarations.some(asset => asset?.id === id)), "selected method knowledge asset is not declared by this component");
  const requested = new Set(requestedIds);
  const ids = new Set();
  const selected = [];
  let totalBytes = 0;
  for (const asset of declarations) {
    assert(asset && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(asset.id ?? "") && !ids.has(asset.id), "method knowledge assets require unique stable IDs");
    ids.add(asset.id);
    assert(Array.isArray(asset.appliesTo) && asset.appliesTo.length && asset.appliesTo.every(value => typeof value === "string" && value.trim()), "method knowledge asset requires explicit applicability");
    assert(Array.isArray(asset.sourceRefs) && asset.sourceRefs.length && asset.sourceRefs.every(value => typeof value === "string" && value.trim()), "method knowledge asset requires source references");
    // Validate every declared path, including an unselected resource. A source
    // contract must not hide an escaping path behind a selector.
    const file = await checkedPath(componentRoot, asset.path);
    if (!requested.has(asset.id) && !appliesToTask(asset, capabilityId, packet)) continue;
    const stat = await fs.stat(file);
    assert(stat.size <= METHOD_KNOWLEDGE_LIMITS.perAssetBytes, "method knowledge asset is too large; split it into task-selected resources");
    const bytes = await fs.readFile(file);
    assert(bytes.length <= METHOD_KNOWLEDGE_LIMITS.perAssetBytes, "method knowledge asset grew while loading");
    totalBytes += bytes.length;
    assert(totalBytes <= METHOD_KNOWLEDGE_LIMITS.totalBytes, "selected method knowledge exceeds the context budget");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert(content.trim().length && !content.includes("\0"), "method knowledge must be nonempty UTF-8 text");
    selected.push({ id: asset.id, path: asset.path, sha256: sha256(bytes), bytes: bytes.length, content,
      sourceRefs: [...asset.sourceRefs], evidenceClass: "loaded_component_resource",
      boundary: "Bundled method knowledge; sourceRefs do not prove external sources were fetched for this task" });
  }
  return selected;
}
