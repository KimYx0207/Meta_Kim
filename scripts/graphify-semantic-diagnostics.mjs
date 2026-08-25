import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { normalizeGraphifyNodeId } from "./graphify-unicode-normalize.mjs";

export const GRAPHIFY_SEMANTIC_DIAGNOSTICS_SCHEMA =
  "meta-kim-graphify-semantic-diagnostics-v2";
export const GRAPHIFY_SEMANTIC_SOURCE_EXTENSIONS = Object.freeze([
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".sh",
  ".ts",
]);
export const GRAPHIFY_SEMANTIC_DIAGNOSTICS_FILE =
  "semantic-coverage-diagnostics.json";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function manifestSourcesFrom(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.sources)) return value.sources;
  if (Array.isArray(value.files)) return value.files;
  return Object.keys(value);
}

function canonicalSources(value) {
  return sortedUnique(
    manifestSourcesFrom(value)
      .filter((source) => typeof source === "string" && source.length > 0)
      .map((source) => source.replaceAll("\\", "/")),
  );
}

function sourceExtension(source) {
  return path.posix.extname(source).toLowerCase() || "[none]";
}

function isExpectedSemanticSource(source) {
  return GRAPHIFY_SEMANTIC_SOURCE_EXTENSIONS.includes(sourceExtension(source));
}

function graphSourceEntries(graph) {
  const entries = [];
  for (let nodeIndex = 0; nodeIndex < (Array.isArray(graph?.nodes) ? graph.nodes.length : 0); nodeIndex += 1) {
    const node = graph.nodes[nodeIndex];
    if (!node || typeof node !== "object" || node.identityOnly === true) continue;
    if (typeof node.source_file !== "string" || node.source_file.length === 0) continue;
    entries.push({
      source: node.source_file.replaceAll("\\", "/"),
      nodeIndex,
      id: typeof node.id === "string" ? node.id : "",
    });
  }
  return entries;
}

function rawIdCollisionEvidence(graph, normalizeNodeId) {
  const byCanonicalId = new Map();
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const normalizationErrorNodeIndexes = [];
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex];
    if (!node || typeof node !== "object" || node.identityOnly === true) continue;
    if (typeof node.id !== "string" || node.id.length === 0) continue;
    let canonicalId;
    try {
      canonicalId = String(normalizeNodeId(node.id) ?? "");
    } catch {
      normalizationErrorNodeIndexes.push(nodeIndex);
      continue;
    }
    if (!canonicalId) continue;
    const entries = byCanonicalId.get(canonicalId) ?? [];
    entries.push({
      nodeIndex,
      rawId: node.id,
      sourceFile:
        typeof node.source_file === "string" && node.source_file.length > 0
          ? node.source_file.replaceAll("\\", "/")
          : null,
    });
    byCanonicalId.set(canonicalId, entries);
  }

  const duplicateRawIds = [];
  const semanticCollisions = [];
  for (const [canonicalId, entries] of byCanonicalId) {
    const rawIds = sortedUnique(entries.map((entry) => entry.rawId));
    if (entries.length < 2) continue;
    const sourceFiles = sortedUnique(
      entries
        .map((entry) => entry.sourceFile)
        .filter((source) => typeof source === "string"),
    );
    const evidence = {
      canonicalId,
      rawIds,
      nodeIndexes: entries.map((entry) => entry.nodeIndex).sort((left, right) => left - right),
      sourceFiles,
      evidence: "raw_id_and_normalizer",
      noOwnerInference: true,
    };
    if (rawIds.length === 1) {
      duplicateRawIds.push({ ...evidence, kind: "duplicate_raw_id" });
    }
    if (rawIds.length > 1 && sourceFiles.length > 1) {
      semanticCollisions.push({ ...evidence, kind: "sanitizer_collision" });
    }
  }
  const sortEvidence = (left, right) => compareText(left.canonicalId, right.canonicalId);
  duplicateRawIds.sort(sortEvidence);
  semanticCollisions.sort(sortEvidence);
  return {
    duplicateRawIds,
    semanticCollisions,
    normalizationErrorNodeIndexes,
  };
}

/**
 * Compare the Graphify manifest source inventory with semantic graph source
 * anchors. This is deliberately read-only and never creates or mutates graph
 * nodes. Labels are not consulted, so the report cannot infer an owner.
 */
export function analyzeGraphSemanticCoverage(
  graph,
  {
    manifest = null,
    manifestSources = null,
    normalizeNodeId = normalizeGraphifyNodeId,
    releaseSafeIdentity = false,
    freshnessVerified = false,
  } = {},
) {
  const manifestAvailable = manifest !== null || manifestSources !== null;
  const identityReleaseSafe = releaseSafeIdentity === true;
  const freshness = freshnessVerified === true;
  if (!manifestAvailable) {
    return {
      schemaVersion: GRAPHIFY_SEMANTIC_DIAGNOSTICS_SCHEMA,
      status: "diagnostic_unavailable",
      diagnosticAvailable: false,
      diagnosticReason: "manifest_missing",
      releaseSafeIdentity: identityReleaseSafe,
      freshnessVerified: freshness,
      semanticCompleteness: "unknown",
      semanticCompletenessDegraded: false,
      noOwnerInference: true,
      sourceAnchorFallback: [],
      expectedNonGraphSourceAnchorFallback: [],
      evidence: null,
      evidenceSha256: null,
    };
  }
  const sources = canonicalSources(manifestSources ?? manifest);
  const entries = graphSourceEntries(graph);
  const sourceToNodeIndexes = new Map();
  for (const entry of entries) {
    const indexes = sourceToNodeIndexes.get(entry.source) ?? [];
    indexes.push(entry.nodeIndex);
    sourceToNodeIndexes.set(entry.source, indexes);
  }
  const graphSources = sortedUnique(entries.map((entry) => entry.source));
  const zeroNodeSources = sources.filter((source) => !sourceToNodeIndexes.has(source));
  const expectedNonGraphSources = zeroNodeSources.filter(
    (source) => !isExpectedSemanticSource(source),
  );
  const unexpectedZeroNodeSources = zeroNodeSources.filter(
    (source) => isExpectedSemanticSource(source),
  );
  const graphOnlySources = graphSources.filter((source) => !sources.includes(source));
  const collisionEvidence = rawIdCollisionEvidence(graph, normalizeNodeId);
  const semanticGap =
    unexpectedZeroNodeSources.length > 0 ||
    collisionEvidence.semanticCollisions.length > 0;
  const status = semanticGap
    ? identityReleaseSafe && freshness
      ? "degraded_navigation"
      : "semantic_completeness_degraded"
    : identityReleaseSafe && freshness
      ? "verified_navigation"
      : "identity_unverified";
  const sourceAnchorFallback = unexpectedZeroNodeSources.map((source) => ({
    source_file: source,
    source_location: null,
    anchorType: "manifest_source",
    noOwnerInference: true,
  }));
  const expectedNonGraphSourceAnchorFallback = expectedNonGraphSources.map((source) => ({
    source_file: source,
    source_location: null,
    anchorType: "expected_non_graph_source",
    noOwnerInference: true,
  }));
  const evidence = {
    manifestAvailable: true,
    manifestSourceCount: sources.length,
    manifestSources: sources,
    manifestSourceDigest: sha256(canonicalJson(sources)),
    graphSourceCount: graphSources.length,
    graphSourcesDigest: sha256(canonicalJson(graphSources)),
    coveredSourceCount: sources.length - zeroNodeSources.length,
    zeroNodeSourceCount: zeroNodeSources.length,
    zeroNodeSources,
    zeroNodeSourceDigest: sha256(canonicalJson(zeroNodeSources)),
    expectedNonGraphSourceCount: expectedNonGraphSources.length,
    expectedNonGraphSources,
    expectedNonGraphSourceDigest: sha256(canonicalJson(expectedNonGraphSources)),
    unexpectedZeroNodeSourceCount: unexpectedZeroNodeSources.length,
    unexpectedZeroNodeSources,
    unexpectedZeroNodeSourceDigest: sha256(canonicalJson(unexpectedZeroNodeSources)),
    graphOnlySourceCount: graphOnlySources.length,
    graphOnlySources,
    duplicateRawIds: collisionEvidence.duplicateRawIds,
    duplicateRawIdCount: collisionEvidence.duplicateRawIds.length,
    semanticIdCollisions: collisionEvidence.semanticCollisions,
    semanticIdCollisionCount: collisionEvidence.semanticCollisions.length,
    normalizationErrorNodeIndexes: collisionEvidence.normalizationErrorNodeIndexes,
  };
  return {
    schemaVersion: GRAPHIFY_SEMANTIC_DIAGNOSTICS_SCHEMA,
    diagnosticAvailable: true,
    status,
    releaseSafeIdentity: identityReleaseSafe,
    freshnessVerified: freshness,
    semanticCompleteness: semanticGap ? "degraded" : "complete",
    semanticCompletenessDegraded: semanticGap,
    noOwnerInference: true,
    sourceAnchorFallback,
    expectedNonGraphSourceAnchorFallback,
    evidence,
    evidenceSha256: sha256(canonicalJson(evidence)),
  };
}

function assertPlainOutputDirectory(outputDir) {
  const resolved = path.resolve(outputDir);
  const stats = lstatSync(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Graphify diagnostics output must be a plain directory");
  }
  if (pathIdentity(realpathSync.native(resolved)) !== pathIdentity(resolved)) {
    throw new Error("Graphify diagnostics output resolves through a link");
  }
  return resolved;
}

function pathIdentity(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function writeGraphSemanticCoverageArtifact({
  outputDir,
  diagnostics,
  binding = {},
}) {
  const resolvedOutputDir = assertPlainOutputDirectory(outputDir);
  const artifactPath = path.join(resolvedOutputDir, GRAPHIFY_SEMANTIC_DIAGNOSTICS_FILE);
  if (existsSync(artifactPath)) {
    const stats = lstatSync(artifactPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Graphify diagnostics artifact must be a plain file");
    }
    if (pathIdentity(realpathSync.native(artifactPath)) !== pathIdentity(artifactPath)) {
      throw new Error("Graphify diagnostics artifact resolves through a link");
    }
  }
  const artifact = {
    schemaVersion: "meta-kim-graphify-semantic-diagnostics-artifact-v1",
    binding: {
      builtAtCommit: binding.builtAtCommit ?? null,
      graphIdentityProofDigest: binding.graphIdentityProofDigest ?? null,
      graphContentSha256: binding.graphContentSha256 ?? null,
      graphReportSha256: binding.graphReportSha256 ?? null,
    },
    diagnostics,
  };
  const contents = `${JSON.stringify(artifact, null, 2)}\n`;
  if (existsSync(artifactPath) && readFileText(artifactPath) === contents) {
    return { changed: false, artifactPath, binding: artifact.binding };
  }
  const temporary = `${artifactPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = openSync(temporary, "wx", 0o600);
    writeFileSync(handle, contents, "utf8");
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    assertPlainOutputDirectory(resolvedOutputDir);
    renameSync(temporary, artifactPath);
    return { changed: true, artifactPath, binding: artifact.binding };
  } finally {
    if (handle !== undefined) closeSync(handle);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readFileText(filePath) {
  return readFileSync(filePath, "utf8");
}
