import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { checkedPath, sha256 } from "./source-integrity.mjs";

// These limits bound prompt material, not professional quality. Large references
// should remain on-demand resources instead of silently truncated instructions.
export const METHOD_KNOWLEDGE_LIMITS = Object.freeze({ assets: 16, perAssetBytes: 32 * 1024, totalBytes: 128 * 1024 });

export async function loadMethodKnowledgeAssets({ componentRoot, method, capabilityId, packet = {} }) {
  const declarations = method?.knowledgeAssets ?? [];
  assert(Array.isArray(declarations) && declarations.length <= METHOD_KNOWLEDGE_LIMITS.assets, "method knowledge asset declaration exceeds the bounded limit");
  const ids = new Set();
  const selected = [];
  const selectors = new Set(["always", capabilityId, packet.stage, packet.workKind].filter(Boolean));
  let totalBytes = 0;
  for (const asset of declarations) {
    assert(asset && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(asset.id ?? "") && !ids.has(asset.id), "method knowledge assets require unique stable IDs");
    ids.add(asset.id);
    assert(Array.isArray(asset.appliesTo) && asset.appliesTo.length && asset.appliesTo.every(value => typeof value === "string" && value.trim()), "method knowledge asset requires explicit applicability");
    assert(Array.isArray(asset.sourceRefs) && asset.sourceRefs.length && asset.sourceRefs.every(value => typeof value === "string" && value.trim()), "method knowledge asset requires source references");
    // Validate every declared path, including an unselected resource. A source
    // contract must not hide an escaping path behind a selector.
    const file = await checkedPath(componentRoot, asset.path);
    if (!asset.appliesTo.some(selector => selectors.has(selector))) continue;
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
