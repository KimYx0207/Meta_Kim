import { createHash } from "node:crypto";
import path from "node:path";
import {
  GRAPHIFY_NODE_ID_NORMALIZATION,
  normalizeGraphifyNodeId,
} from "./graphify-unicode-normalize.mjs";

export const GRAPH_NODE_IDENTITY_SCHEMA = "meta-kim-graph-node-identity-v2";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "en");
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function repositoryFilesFrom(options = {}) {
  return options.repositoryFiles ?? options.trackedFiles ?? [];
}

function isCanonicalRepositoryFile(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    return false;
  }
  if (
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.startsWith("//") ||
    value.startsWith("./") ||
    value.endsWith("/")
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.every((segment) => segment && segment !== "." && segment !== "..") &&
    path.posix.normalize(value) === value
  );
}

function hasPrivateLocalPath(value) {
  return typeof value === "string" &&
    /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|(?:^|[^A-Za-z0-9_])~[\\/]|\/(?:Users|home|root)\/)/u.test(
      value,
    );
}

function isSafeRuntimeSourceRef(value) {
  return typeof value === "string" &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").includes("..") &&
    (/^\.(?:claude|codex|cursor|agents)\//u.test(value) ||
      /^runtime-home\/(?:claude|codex|cursor|agents)\//u.test(value));
}

function graphProofSurface(graph) {
  const {
    meta_kim_enrichment: rawEnrichment,
    ...graphWithoutEnrichment
  } = graph ?? {};
  const enrichment =
    rawEnrichment &&
    typeof rawEnrichment === "object" &&
    !Array.isArray(rawEnrichment)
      ? { ...rawEnrichment }
      : null;
  if (enrichment) delete enrichment.nodeIdentity;
  return {
    ...graphWithoutEnrichment,
    ...(enrichment && Object.keys(enrichment).length > 0
      ? { meta_kim_enrichment: enrichment }
      : {}),
  };
}

function privatePathIssues(value, pointer = "$", issues = []) {
  if (typeof value === "string") {
    if (hasPrivateLocalPath(value)) issues.push(pointer);
    return issues;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => privatePathIssues(item, `${pointer}[]`, issues));
    return issues;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (hasPrivateLocalPath(key)) issues.push(`${pointer}.[key]`);
      privatePathIssues(item, `${pointer}.[value]`, issues);
    }
  }
  return issues;
}

function repositoryInventory(options = {}) {
  const raw = repositoryFilesFrom(options);
  const invalidIndexes = [];
  const files = [];
  if (!Array.isArray(raw)) return { files, invalidIndexes: [0] };
  for (let index = 0; index < raw.length; index += 1) {
    if (!isCanonicalRepositoryFile(raw[index])) {
      invalidIndexes.push(index);
      continue;
    }
    files.push(raw[index]);
  }
  return { files: sortedUnique(files), invalidIndexes };
}

function sameNameGroups(repositoryFiles) {
  const byBasename = new Map();
  for (const file of repositoryFiles) {
    const basename = path.posix.basename(file).toLocaleLowerCase("en");
    const group = byBasename.get(basename) ?? [];
    group.push(file);
    byBasename.set(basename, group);
  }
  return [...byBasename.entries()]
    .map(([basename, files]) => ({ basename, files: sortedUnique(files) }))
    .filter((group) => group.files.length > 1)
    .sort((left, right) => compareText(left.basename, right.basename));
}

function shortestUniqueLabels(files) {
  const segments = new Map(files.map((file) => [file, file.split("/")]));
  const result = new Map();
  for (const file of files) {
    const parts = segments.get(file);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const suffix = parts.slice(-depth).join("/");
      const suffixKey = suffix.toLocaleLowerCase("en");
      const unique = files.every((other) => {
        if (other === file) return true;
        const otherParts = segments.get(other);
        return otherParts.slice(-depth).join("/").toLocaleLowerCase("en") !== suffixKey;
      });
      if (unique) {
        result.set(file, suffix);
        break;
      }
    }
    if (!result.has(file) && parts.length === 1) {
      result.set(file, `./${file}`);
    }
  }
  return result;
}

function normalizedLabel(value) {
  return String(value ?? "").replaceAll("\\", "/").trim();
}

function commandTypeMarker(node) {
  return [node?.type, node?.file_type, node?.kind, node?.node_type, node?._origin]
    .filter((value) => typeof value === "string")
    .map((value) => value.toLocaleLowerCase("en"));
}

function isCommandAstFalsePositive(node) {
  if (node?.command !== undefined) return true;
  if (commandTypeMarker(node).some((value) => value === "command" || value === "command_ast")) {
    return true;
  }
  return String(node?.id ?? "").startsWith("mcp_command_");
}

function isFileNodeCandidate(node, source) {
  if (!node || typeof node !== "object" || node.identityOnly === true) return false;
  if (node.source_location !== "L1" || isCommandAstFalsePositive(node)) return false;
  const basename = path.posix.basename(source);
  const label = normalizedLabel(node.label);
  return label === basename || label.endsWith(`/${basename}`);
}

function sourceWithoutExtension(source) {
  const extension = path.posix.extname(source);
  return extension ? source.slice(0, -extension.length) : source;
}

function nodeIdForm(id, source, normalizeNodeId) {
  const withoutExtension = normalizeNodeId(sourceWithoutExtension(source));
  const withExtension = normalizeNodeId(source);
  const forms = [
    ["full_source_without_extension", withoutExtension],
    ["full_source_with_extension", withExtension],
  ].filter(([, prefix], index, all) => prefix && all.findIndex((entry) => entry[1] === prefix) === index);
  for (const [name, prefix] of forms) {
    if (id === prefix) return name;
    if (id.startsWith(`${prefix}_`) && id.length > prefix.length + 1) return `${name}_suffix`;
  }
  return null;
}

function typeMarker(node) {
  return {
    origin: String(node?._origin ?? ""),
    fileType: String(node?.file_type ?? ""),
    type: String(node?.type ?? ""),
    sourceLocation: String(node?.source_location ?? ""),
  };
}

function safeNodeKey(node, index) {
  const id = String(node?.id ?? "");
  return id || `node-index-${index}`;
}

function collectFacts(graph, options = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph?.links) ? graph.links : [];
  const hyperedgeSurfaces = [
    Array.isArray(graph?.hyperedges)
      ? { name: "hyperedges", values: graph.hyperedges }
      : null,
    Array.isArray(graph?.graph?.hyperedges)
      ? { name: "graph.hyperedges", values: graph.graph.hyperedges }
      : null,
  ].filter(Boolean);
  const normalizeNodeId = options.normalizeNodeId ?? normalizeGraphifyNodeId;
  const inventory = repositoryInventory(options);
  const repositorySet = new Set(inventory.files);
  const invalidSourceNodeIndexes = [];
  const unknownSourceNodeIndexes = [];
  const invalidProvenanceNodeIndexes = [];
  const missingIdNodeIndexes = [];
  const invalidNodeIdIndexes = [];
  const invalidFileNodeLabelIndexes = [];
  const indexesByCanonicalId = new Map();
  const rawNodeIds = new Set();
  const fileNodesBySource = new Map();
  const bindings = [];

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node || typeof node !== "object") {
      missingIdNodeIndexes.push(index);
      continue;
    }
    const id = String(node.id ?? "");
    if (!id) {
      missingIdNodeIndexes.push(index);
    } else {
      const canonicalId = normalizeNodeId(id);
      if (
        typeof node.id !== "string" ||
        id !== id.trim() ||
        id.includes("\0") ||
        !canonicalId ||
        id !== canonicalId
      ) {
        invalidNodeIdIndexes.push(index);
      }
      const indexes = indexesByCanonicalId.get(canonicalId) ?? [];
      indexes.push(index);
      indexesByCanonicalId.set(canonicalId, indexes);
      rawNodeIds.add(id);
    }

    const provenanceFields = [
      node.source_file ? "source_file" : null,
      node.source_directory ? "source_directory" : null,
      node.runtime_source_ref ? "runtime_source_ref" : null,
      node.external_source_ref ? "external_source_ref" : null,
    ].filter(Boolean);
    const sourceDirectoryValid =
      node.source_directory === undefined ||
      (typeof node.source_directory === "string" &&
        isCanonicalRepositoryFile(`${node.source_directory}/placeholder`) &&
        inventory.files.some((file) => file.startsWith(`${node.source_directory}/`)));
    const runtimeRefValid =
      node.runtime_source_ref === undefined ||
      isSafeRuntimeSourceRef(node.runtime_source_ref);
    const externalRefValid =
      node.external_source_ref === undefined ||
      node.external_source_ref === "redacted_unverified";
    if (
      provenanceFields.length > 1 ||
      !sourceDirectoryValid ||
      !runtimeRefValid ||
      !externalRefValid
    ) {
      invalidProvenanceNodeIndexes.push(index);
    }

    if (node.source_file === undefined || node.source_file === null || node.source_file === "") {
      continue;
    }
    if (!isCanonicalRepositoryFile(node.source_file)) {
      invalidSourceNodeIndexes.push(index);
      continue;
    }
    const source = node.source_file;
    if (!repositorySet.has(source)) {
      unknownSourceNodeIndexes.push(index);
      continue;
    }
    if (!isFileNodeCandidate(node, source)) continue;
    const rawLabel = String(node.label ?? "");
    if (
      typeof node.label !== "string" ||
      !rawLabel ||
      rawLabel !== normalizedLabel(rawLabel) ||
      rawLabel.includes("\0")
    ) {
      invalidFileNodeLabelIndexes.push(index);
    }
    const fileNodes = fileNodesBySource.get(source) ?? [];
    const binding = {
      source,
      id,
      label: normalizedLabel(node.label),
      idForm: nodeIdForm(id, source, normalizeNodeId),
      typeMarker: typeMarker(node),
      nodeKey: safeNodeKey(node, index),
    };
    fileNodes.push(binding);
    fileNodesBySource.set(source, fileNodes);
    bindings.push(binding);
  }

  const duplicateNodeIds = [...indexesByCanonicalId.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([id, indexes]) => ({ id, count: indexes.length, nodeIndexes: indexes }))
    .sort((left, right) => compareText(left.id, right.id));
  const danglingLinkIndexes = [];
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    if (
      !link ||
      typeof link !== "object" ||
      typeof link.source !== "string" ||
      typeof link.target !== "string" ||
      link.source !== normalizeNodeId(link.source) ||
      link.target !== normalizeNodeId(link.target) ||
      !rawNodeIds.has(link.source) ||
      !rawNodeIds.has(link.target)
    ) {
      danglingLinkIndexes.push(index);
    }
  }
  const hyperedgeReferenceIssues = [];
  const hyperedgeIdIssues = [];
  const hyperedgeIdsBySurface = [];
  for (let surfaceIndex = 0; surfaceIndex < hyperedgeSurfaces.length; surfaceIndex += 1) {
    const surface = hyperedgeSurfaces[surfaceIndex];
    const seenHyperedgeIds = new Set();
    const ids = [];
    for (let index = 0; index < surface.values.length; index += 1) {
      const hyperedge = surface.values[index];
      const id = typeof hyperedge?.id === "string" ? hyperedge.id : "";
      if (
        !id ||
        id !== normalizeNodeId(id) ||
        seenHyperedgeIds.has(id)
      ) {
        hyperedgeIdIssues.push({ surface: surface.name, index });
      }
      seenHyperedgeIds.add(id);
      ids.push(id);
      if (!Array.isArray(hyperedge?.nodes)) {
        hyperedgeReferenceIssues.push({ surface: surface.name, index });
        continue;
      }
      if (
        hyperedge.nodes.some(
          (nodeId) =>
            typeof nodeId !== "string" ||
            nodeId !== normalizeNodeId(nodeId) ||
            !rawNodeIds.has(nodeId),
        )
      ) {
        hyperedgeReferenceIssues.push({ surface: surface.name, index });
      }
    }
    hyperedgeIdsBySurface.push({ surface: surface.name, ids });
  }
  const hyperedgeSurfaceMismatch =
    hyperedgeSurfaces.length === 2 &&
    canonicalJson(hyperedgeSurfaces[0].values) !==
      canonicalJson(hyperedgeSurfaces[1].values);
  const analysisSidecar = options.analysisSidecar;
  const analysisSidecarIsObject =
    Boolean(analysisSidecar) &&
    typeof analysisSidecar === "object" &&
    !Array.isArray(analysisSidecar);
  const analysisSidecarMissing =
    options.requireAnalysisSidecar === true && !analysisSidecarIsObject;
  const analysisSidecarShapeIssues = [];
  const analysisNodeReferenceIssues = [];
  const analysisSourceFileIssues = [];
  const analysisPrivatePathIssues = [];
  const analysisCommunityCoverageIssues = {
    duplicateNodeReferenceCount: 0,
    missingGraphNodeCount: 0,
  };
  const graphPrivatePathIssues = privatePathIssues(graphProofSurface(graph));
  if (analysisSidecarIsObject) {
    const requiredObjects = ["communities", "cohesion"];
    const requiredArrays = ["gods", "surprises", "questions"];
    for (const field of requiredObjects) {
      if (
        !analysisSidecar[field] ||
        typeof analysisSidecar[field] !== "object" ||
        Array.isArray(analysisSidecar[field])
      ) {
        analysisSidecarShapeIssues.push({ field, reason: "missing_or_malformed" });
      }
    }
    for (const field of requiredArrays) {
      if (!Array.isArray(analysisSidecar[field])) {
        analysisSidecarShapeIssues.push({ field, reason: "missing_or_malformed" });
      }
    }
    const communities =
      analysisSidecar.communities &&
      typeof analysisSidecar.communities === "object" &&
      !Array.isArray(analysisSidecar.communities)
        ? analysisSidecar.communities
        : null;
    const cohesion =
      analysisSidecar.cohesion &&
      typeof analysisSidecar.cohesion === "object" &&
      !Array.isArray(analysisSidecar.cohesion)
        ? analysisSidecar.cohesion
        : null;
    if (communities) {
      const communityIds = Object.keys(communities).sort(compareText);
      const communityNodeReferences = [];
      if (nodes.length > 0 && communityIds.length === 0) {
        analysisSidecarShapeIssues.push({
          field: "communities",
          reason: "empty_for_non_empty_graph",
        });
      }
      if (cohesion) {
        const cohesionIds = Object.keys(cohesion).sort(compareText);
        if (
          communityIds.length !== cohesionIds.length ||
          communityIds.some(
            (communityId, index) => communityId !== cohesionIds[index],
          )
        ) {
          analysisSidecarShapeIssues.push({
            field: "cohesion",
            reason: "community_keys_disagree",
          });
        }
        if (
          Object.values(cohesion).some(
            (value) => typeof value !== "number" || !Number.isFinite(value),
          )
        ) {
          analysisSidecarShapeIssues.push({
            field: "cohesion",
            reason: "invalid_value",
          });
        }
      }
      let communityIndex = 0;
      for (const nodeIds of Object.values(communities)) {
        if (
          !Array.isArray(nodeIds) ||
          nodeIds.length === 0 ||
          nodeIds.some(
            (nodeId) =>
              typeof nodeId !== "string" ||
              nodeId !== normalizeNodeId(nodeId) ||
              !rawNodeIds.has(nodeId),
          )
        ) {
          analysisNodeReferenceIssues.push({
            surface: "communities",
            index: communityIndex,
          });
        }
        if (Array.isArray(nodeIds)) {
          communityNodeReferences.push(
            ...nodeIds.filter((nodeId) => typeof nodeId === "string"),
          );
        }
        communityIndex += 1;
      }
      const uniqueCommunityNodeReferences = new Set(communityNodeReferences);
      analysisCommunityCoverageIssues.duplicateNodeReferenceCount =
        communityNodeReferences.length - uniqueCommunityNodeReferences.size;
      analysisCommunityCoverageIssues.missingGraphNodeCount = [...rawNodeIds]
        .filter((nodeId) => !uniqueCommunityNodeReferences.has(nodeId))
        .length;
    }
    if (Array.isArray(analysisSidecar.gods)) {
      for (let index = 0; index < analysisSidecar.gods.length; index += 1) {
        const nodeId = analysisSidecar.gods[index]?.id;
        if (
          typeof nodeId !== "string" ||
          nodeId !== normalizeNodeId(nodeId) ||
          !rawNodeIds.has(nodeId)
        ) {
          analysisNodeReferenceIssues.push({ surface: "gods", index });
        }
      }
    }
    if (Array.isArray(analysisSidecar.surprises)) {
      for (
        let surpriseIndex = 0;
        surpriseIndex < analysisSidecar.surprises.length;
        surpriseIndex += 1
      ) {
        const sourceFiles = analysisSidecar.surprises[surpriseIndex]?.source_files;
        if (
          sourceFiles !== undefined &&
          (!Array.isArray(sourceFiles) ||
            sourceFiles.some(
              (source) =>
                !isCanonicalRepositoryFile(source) ||
                !repositorySet.has(source),
            ))
        ) {
          analysisSourceFileIssues.push(surpriseIndex);
        }
      }
    }
    const visitAnalysisStrings = (value, pointer = "$") => {
      if (typeof value === "string") {
        if (hasPrivateLocalPath(value)) analysisPrivatePathIssues.push(pointer);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) =>
          visitAnalysisStrings(item, `${pointer}[${index}]`),
        );
        return;
      }
      if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
          if (hasPrivateLocalPath(key)) {
            analysisPrivatePathIssues.push(`${pointer}.[key]`);
          }
          visitAnalysisStrings(item, `${pointer}.[value]`);
        }
      }
    };
    visitAnalysisStrings(analysisSidecar);
  }
  bindings.sort((left, right) =>
    compareText(left.source, right.source) ||
    compareText(left.id, right.id) ||
    compareText(left.label, right.label) ||
    compareText(canonicalJson(left.typeMarker), canonicalJson(right.typeMarker))
  );

  return {
    ...inventory,
    nodes,
    links,
    hyperedgeSurfaces,
    hyperedgeIdsBySurface,
    hyperedgeIdIssues,
    hyperedgeReferenceIssues,
    hyperedgeSurfaceMismatch,
    analysisSidecar,
    analysisSidecarMissing,
    analysisSidecarShapeIssues,
    analysisNodeReferenceIssues,
    analysisSourceFileIssues,
    analysisPrivatePathIssues,
    analysisCommunityCoverageIssues,
    graphPrivatePathIssues,
    invalidSourceNodeIndexes,
    unknownSourceNodeIndexes,
    invalidProvenanceNodeIndexes,
    missingIdNodeIndexes,
    invalidNodeIdIndexes,
    invalidFileNodeLabelIndexes,
    duplicateNodeIds,
    danglingLinkIndexes,
    fileNodesBySource,
    bindings,
  };
}

export function disambiguateGraphFileNodeLabels(graph, options = {}) {
  if (!Array.isArray(graph?.nodes)) return { changed: false, updated: [], removed: 0 };
  const isLegacyMetaKimPlaceholder = (node) =>
    node?.identityOnly === true &&
    node?.metaKimGenerated === true &&
    node?._origin === "meta_kim_enrichment";
  const placeholderIds = new Set(
    graph.nodes
      .filter(isLegacyMetaKimPlaceholder)
      .map((node) => String(node?.id ?? ""))
      .filter(Boolean),
  );
  const beforeCount = graph.nodes.length;
  graph.nodes = graph.nodes.filter((node) => !isLegacyMetaKimPlaceholder(node));
  if (Array.isArray(graph.links) && placeholderIds.size > 0) {
    graph.links = graph.links.filter(
      (link) => !placeholderIds.has(String(link?.source ?? "")) && !placeholderIds.has(String(link?.target ?? "")),
    );
  }

  const { files } = repositoryInventory(options);
  const updated = [];
  for (const group of sameNameGroups(files)) {
    const labels = shortestUniqueLabels(group.files);
    for (let index = 0; index < graph.nodes.length; index += 1) {
      const node = graph.nodes[index];
      const source = node?.source_file;
      if (!labels.has(source) || !isFileNodeCandidate(node, source)) continue;
      const nextLabel = labels.get(source);
      if (node.label === nextLabel) continue;
      node.label = nextLabel;
      updated.push({ source, id: String(node.id ?? ""), label: nextLabel });
    }
  }
  updated.sort((left, right) => compareText(left.source, right.source) || compareText(left.id, right.id));
  const removed = beforeCount - graph.nodes.length;
  return { changed: removed > 0 || updated.length > 0, updated, removed };
}

// Kept as a narrow compatibility surface for in-flight Graphify wiring. It no
// longer manufactures identity-only nodes; it only removes legacy placeholders
// and labels real upstream file nodes.
export function ensureSameNameFileIdentityNodes(graph, options = {}) {
  return disambiguateGraphFileNodeLabels(graph, options);
}

export function analyzeGraphNodeIdentity(graph, options = {}) {
  const facts = collectFacts(graph, options);
  const unrepresentedSameNameSources = [];
  const invalidFileNodeIds = facts.bindings
    .filter((binding) => !binding.idForm)
    .map((binding) => ({ source: binding.source, id: binding.id }));
  const invalidSameNameLabels = [];
  const coveredGroups = [];

  for (const group of sameNameGroups(facts.files)) {
    const expectedLabels = shortestUniqueLabels(group.files);
    const representedSources = [];
    for (const source of group.files) {
      const fileNodes = facts.fileNodesBySource.get(source) ?? [];
      if (fileNodes.length === 0) {
        unrepresentedSameNameSources.push({ basename: group.basename, source });
        continue;
      }
      representedSources.push(source);
      for (const binding of fileNodes) {
        if (binding.label !== expectedLabels.get(source)) {
          invalidSameNameLabels.push({ source, id: binding.id, expectedLabel: expectedLabels.get(source) });
        }
      }
    }
    coveredGroups.push({ basename: group.basename, sources: group.files, representedSources });
  }

  const evidence = {
    repositoryFileCount: facts.files.length,
    repositoryFilesSha256: sha256(canonicalJson(facts.files)),
    repositoryStateSha256:
      typeof options.repositoryStateSha256 === "string"
        ? options.repositoryStateSha256
        : null,
    repositoryPathPolicy: "repository-relative-posix-case-exact-v1",
    nodeIdNormalization:
      options.nodeIdNormalization ?? GRAPHIFY_NODE_ID_NORMALIZATION,
    invalidRepositoryFileCount: facts.invalidIndexes.length,
    nodeCount: facts.nodes.length,
    nodeIdsSha256: sha256(canonicalJson(
      facts.nodes
        .map((node) => String(node?.id ?? ""))
        .sort(compareText),
    )),
    nodeProvenanceSha256: sha256(canonicalJson(
      facts.nodes
        .map((node) => ({
          id: String(node?.id ?? ""),
          source_file: node?.source_file ?? null,
          source_directory: node?.source_directory ?? null,
          runtime_source_ref: node?.runtime_source_ref ?? null,
          external_source_ref: node?.external_source_ref ?? null,
        }))
        .sort((left, right) => compareText(left.id, right.id)),
    )),
    graphContentSha256: sha256(canonicalJson(graphProofSurface(graph))),
    outputSanitizationSha256: sha256(canonicalJson(
      graph?.meta_kim_enrichment?.outputSanitization ?? null,
    )),
    linkEndpointsSha256: sha256(canonicalJson(
      facts.links
        .map((link) => [
          String(link?.source ?? ""),
          String(link?.target ?? ""),
        ])
        .sort((left, right) =>
          compareText(left[0], right[0]) || compareText(left[1], right[1])
        ),
    )),
    hyperedgeReferencesSha256: sha256(canonicalJson(
      facts.hyperedgeSurfaces.map((surface) => ({
        surface: surface.name,
        values: surface.values.map((hyperedge) => ({
          id: String(hyperedge?.id ?? ""),
          nodes: Array.isArray(hyperedge?.nodes)
            ? hyperedge.nodes.map((value) => String(value ?? ""))
            : null,
        })),
      })),
    )),
    hyperedgeIdIssues: facts.hyperedgeIdIssues,
    hyperedgeReferenceIssues: facts.hyperedgeReferenceIssues,
    hyperedgeSurfaceMismatch: facts.hyperedgeSurfaceMismatch,
    analysisSidecarSha256:
      facts.analysisSidecar && !facts.analysisSidecarMissing
        ? sha256(canonicalJson(facts.analysisSidecar))
        : null,
    analysisSidecarMissing: facts.analysisSidecarMissing,
    analysisSidecarShapeIssues: facts.analysisSidecarShapeIssues,
    analysisNodeReferenceIssues: facts.analysisNodeReferenceIssues,
    analysisSourceFileIssues: facts.analysisSourceFileIssues,
    analysisPrivatePathIssues: facts.analysisPrivatePathIssues,
    analysisCommunityCoverageIssues: facts.analysisCommunityCoverageIssues,
    graphPrivatePathIssues: facts.graphPrivatePathIssues,
    missingNodeIdIndexes: facts.missingIdNodeIndexes,
    invalidNodeIdIndexes: facts.invalidNodeIdIndexes,
    duplicateNodeIds: facts.duplicateNodeIds,
    danglingLinkIndexes: facts.danglingLinkIndexes,
    invalidSourceNodeIndexes: facts.invalidSourceNodeIndexes,
    unknownSourceNodeIndexes: facts.unknownSourceNodeIndexes,
    invalidProvenanceNodeIndexes: facts.invalidProvenanceNodeIndexes,
    trackedSameNameGroupCount: coveredGroups.length,
    coveredSameNameGroupCount: coveredGroups.filter(
      (group) => group.representedSources.length === group.sources.length,
    ).length,
    coveredSameNameSourceCount: coveredGroups.reduce(
      (total, group) => total + group.representedSources.length,
      0,
    ),
    unrepresentedSameNameSources,
    invalidFileNodeIds,
    invalidSameNameLabels,
    invalidFileNodeLabelIndexes: facts.invalidFileNodeLabelIndexes,
    fileNodeBindings: facts.bindings,
    fileNodeBindingsSha256: sha256(canonicalJson(facts.bindings)),
    missingFileIdentityCoverage:
      facts.files.length > 0 && facts.bindings.length === 0,
  };
  const unsafe =
    evidence.invalidRepositoryFileCount > 0 ||
    evidence.missingNodeIdIndexes.length > 0 ||
    evidence.invalidNodeIdIndexes.length > 0 ||
    evidence.duplicateNodeIds.length > 0 ||
    evidence.danglingLinkIndexes.length > 0 ||
    evidence.hyperedgeIdIssues.length > 0 ||
    evidence.hyperedgeReferenceIssues.length > 0 ||
    evidence.hyperedgeSurfaceMismatch ||
    evidence.analysisSidecarMissing ||
    evidence.analysisSidecarShapeIssues.length > 0 ||
    evidence.analysisNodeReferenceIssues.length > 0 ||
    evidence.analysisSourceFileIssues.length > 0 ||
    evidence.analysisPrivatePathIssues.length > 0 ||
    evidence.analysisCommunityCoverageIssues.duplicateNodeReferenceCount > 0 ||
    evidence.analysisCommunityCoverageIssues.missingGraphNodeCount > 0 ||
    evidence.graphPrivatePathIssues.length > 0 ||
    evidence.invalidSourceNodeIndexes.length > 0 ||
    evidence.unknownSourceNodeIndexes.length > 0 ||
    evidence.invalidProvenanceNodeIndexes.length > 0 ||
    evidence.invalidFileNodeIds.length > 0 ||
    evidence.invalidFileNodeLabelIndexes.length > 0 ||
    evidence.invalidSameNameLabels.length > 0 ||
    evidence.missingFileIdentityCoverage;

  return {
    schemaVersion: GRAPH_NODE_IDENTITY_SCHEMA,
    status: unsafe ? "unsafe_node_identity" : "verified_graph_file_identity",
    fileIdentityCount: facts.bindings.length,
    requiresUpstreamReextract:
      evidence.missingNodeIdIndexes.length > 0 ||
      evidence.invalidNodeIdIndexes.length > 0 ||
      evidence.duplicateNodeIds.length > 0 ||
      evidence.danglingLinkIndexes.length > 0 ||
      evidence.hyperedgeIdIssues.length > 0 ||
      evidence.hyperedgeReferenceIssues.length > 0 ||
      evidence.hyperedgeSurfaceMismatch ||
      evidence.analysisSidecarMissing ||
      evidence.analysisSidecarShapeIssues.length > 0 ||
      evidence.analysisNodeReferenceIssues.length > 0 ||
      evidence.analysisSourceFileIssues.length > 0 ||
      evidence.analysisPrivatePathIssues.length > 0 ||
      evidence.analysisCommunityCoverageIssues.duplicateNodeReferenceCount > 0 ||
      evidence.analysisCommunityCoverageIssues.missingGraphNodeCount > 0 ||
      evidence.graphPrivatePathIssues.length > 0 ||
      evidence.invalidSourceNodeIndexes.length > 0 ||
      evidence.unknownSourceNodeIndexes.length > 0 ||
      evidence.invalidProvenanceNodeIndexes.length > 0 ||
      evidence.invalidFileNodeIds.length > 0 ||
      evidence.invalidFileNodeLabelIndexes.length > 0 ||
      evidence.missingFileIdentityCoverage,
    ...evidence,
    evidenceSha256: sha256(canonicalJson(evidence)),
  };
}

export function graphNodeIdentityProof(graph, options = {}) {
  return {
    ...analyzeGraphNodeIdentity(graph, options),
    builtCommit: String(options.builtCommit ?? graph?.built_at_commit ?? ""),
  };
}

export function applyGraphNodeIdentityProof(graph, options = {}) {
  const proof = graphNodeIdentityProof(graph, options);
  if (!graph.meta_kim_enrichment || typeof graph.meta_kim_enrichment !== "object") {
    graph.meta_kim_enrichment = {};
  }
  const previous = graph.meta_kim_enrichment.nodeIdentity;
  graph.meta_kim_enrichment.nodeIdentity = proof;
  return { changed: canonicalJson(previous ?? null) !== canonicalJson(proof), proof };
}

function failureReason(expected) {
  const reasons = [];
  if (expected.invalidRepositoryFileCount) reasons.push("repository file inventory is not canonical");
  if (expected.missingNodeIdIndexes.length) reasons.push("graph nodes are missing IDs");
  if (expected.invalidNodeIdIndexes.length) reasons.push("graph node IDs are not canonical strings");
  if (expected.duplicateNodeIds.length) reasons.push("graph node IDs are not globally unique");
  if (expected.danglingLinkIndexes.length) reasons.push("graph links do not bind exact node IDs");
  if (expected.hyperedgeIdIssues.length) reasons.push("graph hyperedge IDs are not canonical and unique");
  if (expected.hyperedgeReferenceIssues.length) {
    reasons.push("graph hyperedges do not bind exact node IDs");
  }
  if (expected.hyperedgeSurfaceMismatch) {
    reasons.push("graph hyperedge truth surfaces disagree");
  }
  if (expected.analysisSidecarMissing) {
    reasons.push("Graphify analysis sidecar is missing");
  }
  if (expected.analysisSidecarShapeIssues.length) {
    reasons.push("Graphify analysis sidecar is incomplete or malformed");
  }
  if (expected.analysisNodeReferenceIssues.length) {
    reasons.push("Graphify analysis sidecar does not bind exact node IDs");
  }
  if (expected.analysisSourceFileIssues.length) {
    reasons.push("Graphify analysis sidecar references files outside the repository inventory");
  }
  if (expected.analysisPrivatePathIssues.length) {
    reasons.push("Graphify analysis sidecar exposes private local paths");
  }
  if (
    expected.analysisCommunityCoverageIssues.duplicateNodeReferenceCount > 0 ||
    expected.analysisCommunityCoverageIssues.missingGraphNodeCount > 0
  ) {
    reasons.push("Graphify analysis communities do not partition every graph node exactly once");
  }
  if (expected.graphPrivatePathIssues.length) {
    reasons.push("Graphify graph exposes local absolute or home-directory paths");
  }
  if (expected.invalidSourceNodeIndexes.length) {
    reasons.push("node source_file values are not canonical repository-relative paths");
  }
  if (expected.unknownSourceNodeIndexes.length) {
    reasons.push("node source_file values are absent from the repository inventory");
  }
  if (expected.invalidProvenanceNodeIndexes.length) {
    reasons.push("node provenance classification is malformed or ambiguous");
  }
  if (expected.invalidFileNodeIds.length) reasons.push("file node IDs are not derived from full source paths");
  if (expected.invalidFileNodeLabelIndexes.length) {
    reasons.push("file node labels are not canonical strings");
  }
  if (expected.invalidSameNameLabels.length) {
    reasons.push("same-name file node labels are not shortest-unique paths");
  }
  if (expected.missingFileIdentityCoverage) {
    reasons.push("non-empty repository has no real upstream file identity nodes");
  }
  return reasons.join("; ") || "unsafe graph node identity";
}

export function validateGraphNodeIdentity(
  graph,
  { requireStored = true, ...options } = {},
) {
  const expected = graphNodeIdentityProof(graph, options);
  const stored = graph?.meta_kim_enrichment?.nodeIdentity;
  if (expected.status !== "verified_graph_file_identity") {
    return { ok: false, reason: failureReason(expected), expected };
  }
  if (requireStored && canonicalJson(stored ?? null) !== canonicalJson(expected)) {
    return {
      ok: false,
      reason: `missing or stale ${GRAPH_NODE_IDENTITY_SCHEMA} proof`,
      expected,
    };
  }
  return { ok: true, reason: null, expected };
}
