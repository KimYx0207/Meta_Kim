import { createHash } from "node:crypto";
import {
  hasPrivateLocalPath,
  sanitizeKnownMetaKimHomeAliases,
} from "./graphify-private-path.mjs";
import { normalizeGraphifyNodeId } from "./graphify-unicode-normalize.mjs";

export const GRAPHIFY_OUTPUT_SANITIZE_SCHEMA =
  "meta-kim-graphify-output-sanitize-v2";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableNodeKey(node) {
  return JSON.stringify([
    String(node?.id ?? ""),
    String(node?.source_file ?? ""),
    String(node?.label ?? ""),
    String(node?.type ?? ""),
    String(node?.file_type ?? ""),
  ]);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalRepositoryFile(value) {
  return typeof value === "string" &&
    Boolean(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.startsWith("./") &&
    !value.endsWith("/") &&
    value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function isPrivateNodeSourceUrl(value) {
  return typeof value === "string" &&
    !/^https?:\/\//iu.test(value) &&
    hasPrivateLocalPath(value);
}

function classifyNonRepositorySource(node, repositoryFiles) {
  const source = String(node.source_file ?? "");
  if (
    source.endsWith("/") &&
    !source.includes("\\") &&
    !source.includes("\0") &&
    !source.includes("..") &&
    repositoryFiles.some((file) => file.startsWith(source))
  ) {
    node.source_directory = source.replace(/\/+$/u, "");
    return "repository_directory";
  }
  if (/^\.(?:claude|codex|cursor|agents)\//u.test(source)) {
    node.runtime_source_ref = source;
    return "runtime_projection";
  }
  if (/^~\/\.(?:claude|codex|cursor|agents)\//u.test(source)) {
    node.runtime_source_ref = source.replace(/^~\/\./u, "runtime-home/");
    return "runtime_home";
  }
  node.external_source_ref = "redacted_unverified";
  return "redacted_external";
}

function hyperedgeSurfaces(graph) {
  return [
    Array.isArray(graph?.hyperedges) ? graph.hyperedges : null,
    Array.isArray(graph?.graph?.hyperedges)
      ? graph.graph.hyperedges
      : null,
  ].filter(Boolean);
}

function unwrapSerializedHyperedge(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.$text !== "string"
  ) {
    return value;
  }
  let parsed;
  try {
    parsed = JSON.parse(value.$text);
  } catch {
    throw new Error("Graphify output contains an invalid serialized hyperedge");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Graphify output contains an invalid serialized hyperedge");
  }
  return parsed;
}

function unwrapSerializedHyperedgeNodes(value) {
  if (Array.isArray(value)) return value;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.item)
  ) {
    return value;
  }
  return value.item;
}

function canonicalizeAlternateHyperedge(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (value.id !== undefined || value.relation !== undefined || value.nodes !== undefined) {
    return value;
  }
  const allowed = new Set([
    "name",
    "kind",
    "paths",
    "confidence",
    "weight",
    "source_file",
    "label",
  ]);
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.has(key)) ||
    typeof value.name !== "string" ||
    !value.name ||
    typeof value.kind !== "string" ||
    !value.kind ||
    !Array.isArray(value.paths) ||
    value.paths.some((nodeId) => typeof nodeId !== "string")
  ) {
    return value;
  }
  const {
    name: id,
    kind: relation,
    paths: nodes,
    weight,
    ...rest
  } = value;
  return {
    ...rest,
    id,
    relation,
    nodes,
    ...(weight === undefined ? {} : { confidence_score: weight }),
  };
}

function normalizeConfidenceScore(record) {
  const value = record?.confidence_score;
  if (value === undefined || value === null) return false;
  if (typeof value === "number") {
    if (Number.isFinite(value) && value >= 0 && value <= 1) return false;
    throw new Error("Graphify output contains an invalid confidence score");
  }
  if (
    typeof value !== "string" ||
    !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(value)
  ) {
    throw new Error("Graphify output contains an invalid confidence score");
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new Error("Graphify output contains an invalid confidence score");
  }
  record.confidence_score = normalized;
  return true;
}

export function graphifyOutputNormalizationValues(graph) {
  const values = new Set();
  const add = (value) => {
    if (typeof value === "string") values.add(value);
  };
  for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) add(node?.id);
  for (const link of Array.isArray(graph?.links) ? graph.links : []) {
    add(link?.source);
    add(link?.target);
  }
  for (const surface of hyperedgeSurfaces(graph)) {
    for (const serialized of surface) {
      const hyperedge = canonicalizeAlternateHyperedge(
        unwrapSerializedHyperedge(serialized),
      );
      add(hyperedge?.id);
      const nodes = unwrapSerializedHyperedgeNodes(hyperedge?.nodes);
      for (const nodeId of Array.isArray(nodes) ? nodes : []) add(nodeId);
    }
  }
  return [...values];
}

export function sanitizeGraphifyOutput(
  graph,
  {
    repositoryFiles = [],
    normalizeNodeId = normalizeGraphifyNodeId,
  } = {},
) {
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes)) {
    throw new Error("Graphify output must contain a nodes array");
  }
  const repositorySet = new Set(repositoryFiles);
  const rawIdCounts = new Map();
  let recoveredSerializedConfidenceScores = 0;
  for (const node of graph.nodes) {
    if (
      !node ||
      typeof node !== "object" ||
      typeof node.id !== "string" ||
      !node.id ||
      node.id.includes("\0")
    ) {
      throw new Error("Graphify output contains a missing or unsafe raw node ID");
    }
    if (normalizeConfidenceScore(node)) recoveredSerializedConfidenceScores += 1;
    rawIdCounts.set(node.id, (rawIdCounts.get(node.id) ?? 0) + 1);
  }
  if ([...rawIdCounts.values()].some((count) => count > 1)) {
    throw new Error("Graphify output contains duplicate exact raw node IDs");
  }

  const survivors = [];
  const sourceReclassifications = {
    repositoryDirectoryRefs: 0,
    runtimeProjectionRefs: 0,
    runtimeHomeRefs: 0,
    redactedExternalRefs: 0,
  };
  let redactedPrivateSourceUrls = 0;
  let sanitizedKnownHomeAliases = 0;
  for (const node of graph.nodes) {
    for (const field of ["label", "norm_label", "name", "description"]) {
      const current = node[field];
      const sanitized = sanitizeKnownMetaKimHomeAliases(current);
      if (sanitized !== current) {
        node[field] = sanitized;
        sanitizedKnownHomeAliases += 1;
      }
    }
    if (isPrivateNodeSourceUrl(node.source_url)) {
      delete node.source_url;
      redactedPrivateSourceUrls += 1;
    }
    if (
      node.source_file !== undefined &&
      node.source_file !== null &&
      node.source_file !== "" &&
      (typeof node.source_file !== "string" ||
        !repositorySet.has(node.source_file))
    ) {
      const classification = classifyNonRepositorySource(node, repositoryFiles);
      delete node.source_file;
      const field = {
        repository_directory: "repositoryDirectoryRefs",
        runtime_projection: "runtimeProjectionRefs",
        runtime_home: "runtimeHomeRefs",
        redacted_external: "redactedExternalRefs",
      }[classification];
      sourceReclassifications[field] += 1;
    }
    survivors.push(node);
  }

  const byCanonicalId = new Map();
  for (const node of survivors) {
    const canonicalId = normalizeNodeId(node.id);
    if (!canonicalId) {
      throw new Error("Graphify output contains a node ID with no canonical form");
    }
    const group = byCanonicalId.get(canonicalId) ?? [];
    group.push(node);
    byCanonicalId.set(canonicalId, group);
  }

  const assignedByRawId = new Map();
  let canonicalizedNodeIds = 0;
  let resolvedCanonicalCollisions = 0;
  const assignedIds = new Set();
  for (const [canonicalId, group] of [...byCanonicalId.entries()].sort(
    ([left], [right]) => compareText(left, right),
  )) {
    group.sort((left, right) => {
      const leftCanonical = left.id === canonicalId ? 0 : 1;
      const rightCanonical = right.id === canonicalId ? 0 : 1;
      return leftCanonical - rightCanonical ||
        compareText(stableNodeKey(left), stableNodeKey(right));
    });
    for (let index = 0; index < group.length; index += 1) {
      const node = group[index];
      let assignedId = canonicalId;
      if (index > 0 || assignedIds.has(assignedId)) {
        const digest = sha256(stableNodeKey(node)).slice(0, 16);
        assignedId = `${canonicalId}_meta_kim_collision_${digest}`;
        let collisionIndex = 2;
        while (assignedIds.has(assignedId)) {
          assignedId =
            `${canonicalId}_meta_kim_collision_${digest}_${collisionIndex}`;
          collisionIndex += 1;
        }
        resolvedCanonicalCollisions += 1;
      }
      assignedIds.add(assignedId);
      assignedByRawId.set(node.id, assignedId);
      if (node.id !== assignedId) canonicalizedNodeIds += 1;
    }
  }

  for (const node of survivors) {
    node.id = assignedByRawId.get(node.id);
  }
  const nextLinks = [];
  for (const link of Array.isArray(graph.links) ? graph.links : []) {
    if (
      !link ||
      typeof link !== "object" ||
      typeof link.source !== "string" ||
      typeof link.target !== "string"
    ) {
      throw new Error("Graphify output contains a malformed link endpoint");
    }
    if (normalizeConfidenceScore(link)) recoveredSerializedConfidenceScores += 1;
    nextLinks.push({
      ...link,
      source: assignedByRawId.get(link.source) ?? link.source,
      target: assignedByRawId.get(link.target) ?? link.target,
    });
  }

  graph.nodes = survivors;
  graph.links = nextLinks;
  let canonicalizedHyperedgeIds = 0;
  let rewrittenHyperedgeReferences = 0;
  let recoveredSerializedHyperedges = 0;
  let recoveredSerializedHyperedgeNodes = 0;
  let recoveredAlternateHyperedges = 0;
  for (const surface of hyperedgeSurfaces(graph)) {
    const assignedHyperedgeIds = new Set();
    for (let index = 0; index < surface.length; index += 1) {
      const serialized = surface[index];
      const unwrapped = unwrapSerializedHyperedge(serialized);
      const hyperedge = canonicalizeAlternateHyperedge(unwrapped);
      if (hyperedge !== unwrapped) {
        surface[index] = hyperedge;
        recoveredAlternateHyperedges += 1;
      } else if (unwrapped !== serialized) {
        surface[index] = hyperedge;
      }
      if (unwrapped !== serialized) {
        recoveredSerializedHyperedges += 1;
      }
      const serializedNodes = hyperedge?.nodes;
      const nodes = unwrapSerializedHyperedgeNodes(serializedNodes);
      if (nodes !== serializedNodes) {
        hyperedge.nodes = nodes;
        recoveredSerializedHyperedgeNodes += 1;
      }
      if (
        !hyperedge ||
        typeof hyperedge !== "object" ||
        typeof hyperedge.id !== "string" ||
        !hyperedge.id ||
        !Array.isArray(hyperedge.nodes)
      ) {
        throw new Error("Graphify output contains a malformed hyperedge");
      }
      if (normalizeConfidenceScore(hyperedge)) recoveredSerializedConfidenceScores += 1;
      const rawHyperedgeId = hyperedge.id;
      const canonicalHyperedgeId = normalizeNodeId(rawHyperedgeId);
      if (!canonicalHyperedgeId) {
        throw new Error("Graphify output contains a hyperedge ID with no canonical form");
      }
      let assignedHyperedgeId = canonicalHyperedgeId;
      if (assignedHyperedgeIds.has(assignedHyperedgeId)) {
        assignedHyperedgeId =
          `${canonicalHyperedgeId}_meta_kim_collision_${sha256(rawHyperedgeId).slice(0, 16)}`;
      }
      assignedHyperedgeIds.add(assignedHyperedgeId);
      if (hyperedge.id !== assignedHyperedgeId) canonicalizedHyperedgeIds += 1;
      hyperedge.id = assignedHyperedgeId;
      hyperedge.nodes = hyperedge.nodes.map((nodeId) => {
        if (typeof nodeId !== "string") {
          throw new Error("Graphify output contains a malformed hyperedge node reference");
        }
        const assigned = assignedByRawId.get(nodeId) ?? nodeId;
        if (assigned !== nodeId) rewrittenHyperedgeReferences += 1;
        return assigned;
      });
    }
  }
  const result = {
    schemaVersion: GRAPHIFY_OUTPUT_SANITIZE_SCHEMA,
    changed:
      Object.values(sourceReclassifications).some((count) => count > 0) ||
      redactedPrivateSourceUrls > 0 ||
      sanitizedKnownHomeAliases > 0 ||
      canonicalizedNodeIds > 0 ||
      canonicalizedHyperedgeIds > 0 ||
      rewrittenHyperedgeReferences > 0 ||
      recoveredSerializedHyperedges > 0 ||
      recoveredSerializedHyperedgeNodes > 0 ||
      recoveredAlternateHyperedges > 0 ||
      recoveredSerializedConfidenceScores > 0,
    ...sourceReclassifications,
    redactedPrivateSourceUrls,
    sanitizedKnownHomeAliases,
    canonicalizedNodeIds,
    resolvedCanonicalCollisions,
    canonicalizedHyperedgeIds,
    rewrittenHyperedgeReferences,
    recoveredSerializedHyperedges,
    recoveredSerializedHyperedgeNodes,
    recoveredAlternateHyperedges,
    recoveredSerializedConfidenceScores,
  };
  Object.defineProperty(result, "nodeIdMap", {
    value: assignedByRawId,
    enumerable: false,
  });
  return result;
}

export function sanitizeGraphifyAnalysisSidecar(
  analysis,
  {
    nodeIdMap,
    graphNodeIds,
    repositoryFiles = [],
    requireComplete = true,
  } = {},
) {
  if (!analysis || typeof analysis !== "object" || Array.isArray(analysis)) {
    throw new Error("Graphify analysis sidecar must be an object");
  }
  if (!(nodeIdMap instanceof Map) || !(graphNodeIds instanceof Set)) {
    throw new Error("Graphify analysis sanitization requires an exact node-ID map");
  }
  const requiredObjects = ["communities", "cohesion"];
  const requiredArrays = requireComplete
    ? ["gods", "surprises", "questions"]
    : ["gods", "surprises"];
  for (const field of requiredObjects) {
    if (
      !analysis[field] ||
      typeof analysis[field] !== "object" ||
      Array.isArray(analysis[field])
    ) {
      throw new Error(`Graphify analysis ${field} surface is missing or malformed`);
    }
  }
  for (const field of requiredArrays) {
    if (!Array.isArray(analysis[field])) {
      throw new Error(`Graphify analysis ${field} surface is missing or malformed`);
    }
  }
  if (
    analysis.questions !== undefined &&
    !Array.isArray(analysis.questions)
  ) {
    throw new Error("Graphify analysis questions surface is malformed");
  }
  const communityIds = Object.keys(analysis.communities).sort(compareText);
  const cohesionIds = Object.keys(analysis.cohesion).sort(compareText);
  if (
    communityIds.length !== cohesionIds.length ||
    communityIds.some((communityId, index) => communityId !== cohesionIds[index])
  ) {
    throw new Error("Graphify analysis community and cohesion surfaces disagree");
  }
  if (graphNodeIds.size > 0 && communityIds.length === 0) {
    throw new Error("Graphify analysis is empty for a non-empty graph");
  }
  if (
    Object.values(analysis.cohesion).some(
      (value) => typeof value !== "number" || !Number.isFinite(value),
    )
  ) {
    throw new Error("Graphify analysis cohesion values are malformed");
  }
  const repositorySet = new Set(repositoryFiles);
  for (const surprise of analysis.surprises) {
    if (!surprise || typeof surprise !== "object" || Array.isArray(surprise)) {
      throw new Error("Graphify analysis surprise entry is malformed");
    }
    if (
      surprise.source_files !== undefined &&
      (!Array.isArray(surprise.source_files) ||
        surprise.source_files.some(
          (source) =>
            !isCanonicalRepositoryFile(source) ||
            !repositorySet.has(source),
        ))
    ) {
      throw new Error("Graphify analysis surprise references an unknown source file");
    }
  }
  const inspectPrivatePaths = (value) => {
    if (typeof value === "string") {
      if (hasPrivateLocalPath(value)) {
        throw new Error("Graphify analysis contains a private local path");
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(inspectPrivatePaths);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        inspectPrivatePaths(key);
        inspectPrivatePaths(item);
      }
    }
  };
  inspectPrivatePaths(analysis);
  let rewrittenNodeReferences = 0;
  const rewrite = (value) => {
    if (typeof value !== "string") {
      throw new Error("Graphify analysis contains a malformed node reference");
    }
    const assigned = nodeIdMap.get(value) ?? value;
    if (!graphNodeIds.has(assigned)) {
      throw new Error("Graphify analysis contains a dangling node reference");
    }
    if (assigned !== value) rewrittenNodeReferences += 1;
    return assigned;
  };

  for (const nodeIds of Object.values(analysis.communities)) {
    if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
      throw new Error("Graphify analysis contains a malformed community member list");
    }
  }
  for (const [communityId, nodeIds] of Object.entries(analysis.communities)) {
    analysis.communities[communityId] = nodeIds.map(rewrite);
  }
  const communityNodeReferences = Object.values(analysis.communities).flat();
  const uniqueCommunityNodeReferences = new Set(communityNodeReferences);
  const communityCoverageComplete =
    communityNodeReferences.length !== uniqueCommunityNodeReferences.size ||
    uniqueCommunityNodeReferences.size !== graphNodeIds.size ||
    [...graphNodeIds].some(
      (nodeId) => !uniqueCommunityNodeReferences.has(nodeId),
    )
      ? false
      : true;
  if (requireComplete && !communityCoverageComplete) {
    throw new Error(
      "Graphify analysis communities must partition every graph node exactly once",
    );
  }
  for (const node of analysis.gods) {
    if (!node || typeof node !== "object" || typeof node.id !== "string") {
      throw new Error("Graphify analysis gods entry is malformed");
    }
    node.id = rewrite(node.id);
  }
  return {
    changed: rewrittenNodeReferences > 0,
    rewrittenNodeReferences,
    communityCoverageComplete,
  };
}
