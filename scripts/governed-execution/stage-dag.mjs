import { createHash } from "node:crypto";

const DEFAULT_STAGE_ORDER = Object.freeze([
  "Critical",
  "Fetch",
  "Thinking",
  "Execution",
  "Review",
  "Meta-Review",
  "Verification",
  "Evolution",
]);

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter(
    (item) => typeof item === "string" && item.trim(),
  ))];
}

function slug(value) {
  return String(value ?? "stage")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "stage";
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function canonicalStringSet(value) {
  return uniqueStrings(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function canonicalGraphPayload(stageDagPacket) {
  return {
    schemaVersion: stageDagPacket?.schemaVersion ?? null,
    authority: stageDagPacket?.authority ?? null,
    stageOrder: Array.isArray(stageDagPacket?.stageOrder)
      ? [...stageDagPacket.stageOrder]
      : [],
    nodes: (Array.isArray(stageDagPacket?.nodes) ? stageDagPacket.nodes : []).map((node) => ({
      nodeId: node?.nodeId ?? null,
      stage: node?.stage ?? null,
      laneKind: node?.laneKind ?? null,
      ownerBindingRef: node?.ownerBindingRef ?? null,
      capabilityBindingRef: node?.capabilityBindingRef ?? null,
      description: node?.description ?? null,
      dependsOn: canonicalStringSet(node?.dependsOn),
      effectClass: node?.effectClass ?? null,
      resourceScopes: canonicalStringSet(node?.resourceScopes),
      isolation: node?.isolation ?? null,
      mergeNodeId: node?.mergeNodeId ?? null,
    })),
  };
}

export function stageDagGraphDigest(stageDagPacket) {
  return createHash("sha256")
    .update(canonicalJson(canonicalGraphPayload(stageDagPacket)), "utf8")
    .digest("hex");
}

function assertNoStageSlugCollisions(stageOrder) {
  const stagesBySlug = new Map();
  for (const stage of stageOrder) {
    const normalizedSlug = slug(stage);
    const stages = stagesBySlug.get(normalizedSlug) ?? [];
    stages.push(stage);
    stagesBySlug.set(normalizedSlug, stages);
  }
  const collisions = [...stagesBySlug.entries()].filter(([, stages]) => stages.length > 1);
  if (collisions.length > 0) {
    throw new TypeError(
      `stage slug collision: ${collisions
        .map(([normalizedSlug, stages]) => `${normalizedSlug} <= ${stages.join(", ")}`)
        .join("; ")}`,
    );
  }
}

export function validateStageDagPacket(stageDagPacket, { requireDigest = false } = {}) {
  if (!stageDagPacket || typeof stageDagPacket !== "object" || Array.isArray(stageDagPacket)) {
    throw new TypeError("stage DAG packet must be an object");
  }
  if (!Array.isArray(stageDagPacket.stageOrder) || stageDagPacket.stageOrder.length === 0) {
    throw new TypeError("stage DAG stageOrder must contain at least one stage");
  }
  if (stageDagPacket.stageOrder.some((stage) => typeof stage !== "string" || !stage.trim())) {
    throw new TypeError("stage DAG stageOrder must contain non-empty strings");
  }
  assertNoStageSlugCollisions(stageDagPacket.stageOrder);
  if (!Array.isArray(stageDagPacket.nodes) || stageDagPacket.nodes.length === 0) {
    throw new TypeError("stage DAG nodes must contain at least one node");
  }

  const stageNames = new Set(stageDagPacket.stageOrder);
  const nodeIdCounts = new Map();
  for (const node of stageDagPacket.nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new TypeError("stage DAG nodes must be objects");
    }
    if (typeof node.nodeId !== "string" || !node.nodeId.trim()) {
      throw new TypeError("stage DAG nodeId must be a non-empty string");
    }
    if (!stageNames.has(node.stage)) {
      throw new TypeError(`stage DAG node ${node.nodeId} has unknown stage: ${node.stage}`);
    }
    if (!Array.isArray(node.dependsOn) || node.dependsOn.some(
      (dependencyId) => typeof dependencyId !== "string" || !dependencyId.trim()
    )) {
      throw new TypeError(`stage DAG node ${node.nodeId} dependsOn must contain strings`);
    }
    if (!Array.isArray(node.resourceScopes)) {
      throw new TypeError(`stage DAG node ${node.nodeId} resourceScopes must be an array`);
    }
    nodeIdCounts.set(node.nodeId, (nodeIdCounts.get(node.nodeId) ?? 0) + 1);
  }

  const duplicateNodeIds = [...nodeIdCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([nodeId]) => nodeId);
  if (duplicateNodeIds.length > 0) {
    throw new TypeError(`duplicate stage DAG node ids: ${duplicateNodeIds.join(", ")}`);
  }

  const nodeIds = new Set(nodeIdCounts.keys());
  const selfDependencies = stageDagPacket.nodes
    .filter((node) => node.dependsOn.includes(node.nodeId))
    .map((node) => node.nodeId);
  if (selfDependencies.length > 0) {
    throw new TypeError(`stage DAG contains self dependency: ${selfDependencies.join(", ")}`);
  }
  const missingDependencies = stageDagPacket.nodes.flatMap((node) =>
    node.dependsOn
      .filter((dependencyId) => !nodeIds.has(dependencyId))
      .map((dependencyId) => ({ nodeId: node.nodeId, dependencyId }))
  );
  if (missingDependencies.length > 0) {
    throw new TypeError(
      `stage DAG contains missing dependencies: ${missingDependencies
        .map((item) => `${item.nodeId}->${item.dependencyId}`)
        .join(", ")}`,
    );
  }

  const remainingDependencyCounts = new Map(
    stageDagPacket.nodes.map((node) => [node.nodeId, new Set(node.dependsOn).size]),
  );
  const dependentsByNodeId = new Map(stageDagPacket.nodes.map((node) => [node.nodeId, []]));
  for (const node of stageDagPacket.nodes) {
    for (const dependencyId of new Set(node.dependsOn)) {
      dependentsByNodeId.get(dependencyId).push(node.nodeId);
    }
  }
  const ready = stageDagPacket.nodes
    .filter((node) => remainingDependencyCounts.get(node.nodeId) === 0)
    .map((node) => node.nodeId);
  let visitedCount = 0;
  while (ready.length > 0) {
    const nodeId = ready.shift();
    visitedCount += 1;
    for (const dependentId of dependentsByNodeId.get(nodeId)) {
      const remaining = remainingDependencyCounts.get(dependentId) - 1;
      remainingDependencyCounts.set(dependentId, remaining);
      if (remaining === 0) ready.push(dependentId);
    }
  }
  if (visitedCount !== stageDagPacket.nodes.length) {
    const cycleNodeIds = stageDagPacket.nodes
      .map((node) => node.nodeId)
      .filter((nodeId) => remainingDependencyCounts.get(nodeId) > 0);
    throw new TypeError(`stage DAG contains a cycle involving: ${cycleNodeIds.join(", ")}`);
  }

  const computedDigest = stageDagGraphDigest(stageDagPacket);
  if (requireDigest && typeof stageDagPacket.graphDigest !== "string") {
    throw new TypeError("stage DAG graphDigest is required");
  }
  if (
    typeof stageDagPacket.graphDigest === "string" &&
    stageDagPacket.graphDigest !== computedDigest
  ) {
    throw new TypeError(
      `stage DAG graph digest mismatch: expected ${stageDagPacket.graphDigest}, computed ${computedDigest}`,
    );
  }
  return stageDagPacket;
}

function isReadOnlyEffect(effectClass) {
  const normalized = String(effectClass ?? "").toLowerCase();
  return normalized.startsWith("read_only") ||
    normalized === "merge_only" ||
    normalized === "stage_control";
}

export function stageLaneNodeId(stage, laneId) {
  return `stage:${slug(stage)}:lane:${slug(laneId)}`;
}

export function stageMergeNodeId(stage) {
  return `stage:${slug(stage)}:merge`;
}

function normalizeLane(stage, lane, index, previousMergeNodeId, mergeNodeId) {
  const laneIdentity = lane?.nodeId ?? lane?.laneId ?? `${slug(stage)}-${index + 1}`;
  const nodeId = lane?.nodeId ?? stageLaneNodeId(stage, laneIdentity);
  return {
    nodeId,
    stage,
    laneKind: lane?.laneKind ?? "stage_support",
    ownerBindingRef: lane?.ownerBindingRef ?? `stage-owner:${slug(stage)}`,
    capabilityBindingRef: lane?.capabilityBindingRef ?? `stage-contract:${slug(stage)}`,
    description: lane?.description ?? null,
    dependsOn: uniqueStrings([
      ...(lane?.dependsOn ?? []),
      ...(previousMergeNodeId ? [previousMergeNodeId] : []),
    ]),
    effectClass: lane?.effectClass ?? "read_only_support",
    resourceScopes: uniqueStrings(lane?.resourceScopes),
    isolation: lane?.isolation ?? "shared_read_only",
    mergeNodeId,
    status: lane?.status ?? "planned_not_invoked",
  };
}

export function buildStageDagPacket({
  stageOrder = DEFAULT_STAGE_ORDER,
  stageLanes = {},
  stageAuthorities = {},
  runtimeCapacity = null,
} = {}) {
  const requestedStages = (Array.isArray(stageOrder) ? stageOrder : []).filter(
    (stage) => typeof stage === "string" && stage.trim(),
  );
  assertNoStageSlugCollisions(requestedStages);
  const orderedStages = uniqueStrings(requestedStages);
  if (orderedStages.length === 0) {
    throw new TypeError("stageOrder must contain at least one stage");
  }

  const nodes = [];
  const stageSummaries = [];
  let previousMergeNodeId = null;

  for (const stage of orderedStages) {
    const mergeNodeId = stageMergeNodeId(stage);
    const configuredLanes = Array.isArray(stageLanes?.[stage]) ? stageLanes[stage] : [];
    const sourceLanes = configuredLanes.length > 0
      ? configuredLanes
      : [{
          laneId: "control",
          laneKind: "stage_control",
          effectClass: "stage_control",
          resourceScopes: [],
          isolation: "shared_read_only",
        }];
    const laneNodes = sourceLanes.map((lane, index) =>
      normalizeLane(stage, lane, index, previousMergeNodeId, mergeNodeId)
    );
    nodes.push(...laneNodes);
    nodes.push({
      nodeId: mergeNodeId,
      stage,
      laneKind: "stage_merge",
      ownerBindingRef: stageAuthorities?.[stage] ?? `stage-owner:${slug(stage)}`,
      capabilityBindingRef: "config/contracts/core-loop-contract.json",
      dependsOn: laneNodes.map((node) => node.nodeId),
      effectClass: "merge_only",
      resourceScopes: [],
      isolation: "single_merge_authority",
      mergeNodeId,
      status: "pending_merge",
    });
    stageSummaries.push({
      stage,
      laneNodeIds: laneNodes.map((node) => node.nodeId),
      mergeNodeId,
      previousStageMergeNodeId: previousMergeNodeId,
      mergeAuthority: stageAuthorities?.[stage] ?? `stage-owner:${slug(stage)}`,
    });
    previousMergeNodeId = mergeNodeId;
  }

  const packet = {
    schemaVersion: "stage-dag-v0.1",
    authority: "config/contracts/core-loop-contract.json",
    status: "planned_not_invoked",
    stageOrder: orderedStages,
    runtimeCapacity,
    nodes,
    stageSummaries,
    schedulerPolicy: {
      mode: "ordered_stage_barriers_with_maximal_safe_internal_parallelism",
      unknownMutationScope: "exclusive_single_lane",
      resourceConflict: "serialize_unless_isolated",
      capacity: "active_host_capacity",
    },
    compatibilityViews: [
      "thinkingPacket.workerTaskPackets",
      "agentTeamsPlaybookPacket.waves",
      "langGraphRunPacket",
      "dispatchBoard",
      "stageOperationPlan",
    ],
    invocationTruth: {
      plannedIsInvoked: false,
      requiredEvidence: "exact runId + nodeId + native tool call + successful terminal result",
    },
  };
  validateStageDagPacket(packet);
  packet.graphDigest = stageDagGraphDigest(packet);
  return packet;
}

function nodeHasUnknownMutationScope(node) {
  return !isReadOnlyEffect(node.effectClass) && node.resourceScopes.length === 0;
}

function normalizeFilesystemScope(scope) {
  const match = String(scope ?? "").trim().match(/^(?:file|path):(.*)$/iu);
  if (!match) return null;
  let normalized = match[1]
    .trim()
    .replace(/\\/gu, "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/^\.\//u, "")
    .toLowerCase();
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/u, "");
  return normalized;
}

function scopesConflict(leftScope, rightScope) {
  const leftFilesystemScope = normalizeFilesystemScope(leftScope);
  const rightFilesystemScope = normalizeFilesystemScope(rightScope);
  if (leftFilesystemScope !== null && rightFilesystemScope !== null) {
    return leftFilesystemScope === rightFilesystemScope ||
      leftFilesystemScope.startsWith(`${rightFilesystemScope}/`) ||
      rightFilesystemScope.startsWith(`${leftFilesystemScope}/`);
  }
  return String(leftScope).trim() === String(rightScope).trim();
}

function nodesConflict(left, right) {
  const leftMutation = !isReadOnlyEffect(left.effectClass);
  const rightMutation = !isReadOnlyEffect(right.effectClass);
  if (!leftMutation && !rightMutation) return false;
  if (
    (leftMutation && left.resourceScopes.length === 0) ||
    (rightMutation && right.resourceScopes.length === 0)
  ) return true;
  return left.resourceScopes.some((leftScope) =>
    right.resourceScopes.some((rightScope) => scopesConflict(leftScope, rightScope))
  );
}

function lexicographicallyEarlier(left, right) {
  if (!right) return true;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return left.length < right.length;
}

function selectMaximumCompatibleCandidateIndexes(candidates, limit) {
  const MAX_EXACT_CANDIDATES = 24;
  if (candidates.length > MAX_EXACT_CANDIDATES) {
    const indexesByLowestConflictDegree = candidates
      .map((_, index) => ({
        index,
        conflictDegree: candidates.reduce(
          (count, candidate, otherIndex) =>
            count + Number(index !== otherIndex && nodesConflict(candidates[index], candidate)),
          0,
        ),
      }))
      .sort((left, right) =>
        left.conflictDegree - right.conflictDegree || left.index - right.index
      );
    return indexesByLowestConflictDegree
      .reduce((selectedIndexes, { index }) => {
        if (selectedIndexes.length >= limit) return selectedIndexes;
        if (selectedIndexes.every((selectedIndex) =>
          !nodesConflict(candidates[selectedIndex], candidates[index])
        )) {
          selectedIndexes.push(index);
        }
        return selectedIndexes;
      }, [])
      .sort((left, right) => left - right);
  }

  let best = [];
  const selected = [];

  function search(candidateIndex) {
    if (selected.length > best.length || (
      selected.length === best.length && lexicographicallyEarlier(selected, best)
    )) {
      best = [...selected];
    }
    if (best.length === limit || candidateIndex >= candidates.length) return;
    if (selected.length + (candidates.length - candidateIndex) < best.length) return;

    const candidate = candidates[candidateIndex];
    if (selected.every((index) => !nodesConflict(candidates[index], candidate))) {
      selected.push(candidateIndex);
      search(candidateIndex + 1);
      selected.pop();
    }
    search(candidateIndex + 1);
  }

  search(0);
  return best;
}

export function selectMaximalSafeReadySet(
  stageDagPacket,
  { completedNodeIds = [], capacity = null, stage = null } = {},
) {
  validateStageDagPacket(stageDagPacket);
  const completed = new Set(uniqueStrings(completedNodeIds));
  const limit = Math.max(
    1,
    Number.parseInt(String(capacity ?? stageDagPacket?.runtimeCapacity ?? 1), 10) || 1,
  );
  const candidates = (stageDagPacket?.nodes ?? [])
    .filter((node) => !completed.has(node.nodeId))
    .filter((node) => !stage || node.stage === stage)
    .filter((node) => node.dependsOn.every((dependencyId) => completed.has(dependencyId)))
    .sort((left, right) =>
      Number(nodeHasUnknownMutationScope(left)) - Number(nodeHasUnknownMutationScope(right))
    );

  const selectedIndexes = selectMaximumCompatibleCandidateIndexes(candidates, limit);
  const selected = selectedIndexes.map((index) => candidates[index]);

  return {
    schemaVersion: "stage-dag-ready-set-v0.1",
    stage: stage ?? selected[0]?.stage ?? null,
    capacity: limit,
    candidateNodeIds: candidates.map((node) => node.nodeId),
    readyNodeIds: selected.map((node) => node.nodeId),
    readyNodes: selected,
    deferredNodeIds: candidates
      .filter((node) => !selected.some((selectedNode) => selectedNode.nodeId === node.nodeId))
      .map((node) => node.nodeId),
  };
}

export { DEFAULT_STAGE_ORDER };
