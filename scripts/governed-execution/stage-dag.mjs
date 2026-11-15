import { createHash } from "node:crypto";
import { scopeComparisonKey, scopeKeysAreProvablyDisjoint } from "../task-scope-comparison.mjs";

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
    ...(stageDagPacket?.moduleScopePlan ? { moduleScopePlan: stageDagPacket.moduleScopePlan,
      completionNodeId: stageDagPacket.completionNodeId ?? null } : {}),
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
      ...(node?.scope ? { scope: node.scope } : {}),
      ...(node?.stageContract ? { stageContract: node.stageContract } : {}),
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
  if (stageDagPacket.moduleScopePlan) {
    requireScope(isModuleScopedDag(stageDagPacket), "scoped graphs require schema version 0.2");
    const normalized = normalizeModuleScopePlan(stageDagPacket.moduleScopePlan,
      stageDagPacket.nodes.filter((node) => node.stage === "Execution" && node.laneKind !== "stage_merge"));
    requireScope(canonicalJson(normalized) === canonicalJson(stageDagPacket.moduleScopePlan), "scope plan must retain its canonical identity");
    requireScope(stageDagPacket.nodes.some((node) => node.nodeId === stageDagPacket.completionNodeId && node.scope?.kind === "aggregate" &&
      node.laneKind === "stage_merge"), "aggregate completion node is required");
  }
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
    if (stageDagPacket.moduleScopePlan) {
      const plan = stageDagPacket.moduleScopePlan;
      requireScope(["shared", "module", "aggregate"].includes(node.scope?.kind), `node ${node.nodeId} requires an explicit scope`);
      if (node.scope.kind === "module") {
        const module = plan.modules.find((item) => item.id === node.scope.moduleId);
        requireScope(module && module.revision === node.scope.revision && module.basisDigest === node.scope.basisDigest &&
          node.scope.architectureBasisDigest === plan.architecture.basisDigest, `node ${node.nodeId} has a stale module basis`);
      } else requireScope(node.scope.basisDigest === plan.architecture.basisDigest && node.scope.revision === plan.architecture.revision,
        `node ${node.nodeId} has a stale architecture basis`);
      if (node.laneKind === "module_stage") requireScope(node.stageContract?.receiptVersion === 1,
        `node ${node.nodeId} requires a stage receipt contract`);
    }
    if (!Array.isArray(node.dependsOn) || node.dependsOn.some(
      (dependencyId) => typeof dependencyId !== "string" || !dependencyId.trim()
    )) {
      throw new TypeError(`stage DAG node ${node.nodeId} dependsOn must contain strings`);
    }
    if (!Array.isArray(node.resourceScopes) || node.resourceScopes.some(
      (scope) => typeof scope !== "string" || !scope.trim()
    )) {
      throw new TypeError(`stage DAG node ${node.nodeId} resourceScopes must be an array of non-empty strings`);
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

export function moduleStageNodeId(moduleId, stage, kind = "gate") {
  // The digest prevents two distinct module IDs with the same display slug
  // from sharing execution identity.
  const identity = `${slug(moduleId)}-${createHash("sha256").update(moduleId).digest("hex").slice(0, 16)}`;
  return `module:${identity}:stage:${slug(stage)}:${kind}`;
}

export function isModuleScopedDag(packet) {
  return packet?.schemaVersion === "stage-dag-v0.2" && packet?.moduleScopePlan?.schemaVersion === 1;
}

function requireScope(condition, message) {
  if (!condition) throw new TypeError(`module scoped DAG: ${message}`);
}

function normalizeModuleScopePlan(input, executionLanes) {
  const plan = structuredClone(input);
  requireScope(plan?.schemaVersion === 1, "schemaVersion 1 is required");
  const identity = (value) => value && typeof value.id === "string" && value.id.trim() &&
    Number.isSafeInteger(value.revision) && value.revision > 0 && /^[a-f0-9]{64}$/u.test(value.basisDigest ?? "");
  requireScope(identity(plan.architecture), "architecture identity, revision and SHA-256 basis are required");
  requireScope(Array.isArray(plan.modules) && plan.modules.length > 0, "modules are required");
  requireScope(plan.modules.every(identity), "every module needs identity, revision and SHA-256 basis");
  const ids = new Set(plan.modules.map((item) => item.id));
  requireScope(ids.size === plan.modules.length, "module IDs must be unique");
  const laneIds = new Set(executionLanes.map((lane) => lane.nodeId));
  for (const module of plan.modules) {
    requireScope(Array.isArray(module.taskIds) &&
      canonicalStringSet(module.taskIds).length === module.taskIds.length &&
      module.taskIds.every((id) => laneIds.has(stageLaneNodeId("Execution", id))), `module ${module.id} tasks must reference current execution lanes`);
    module.taskIds = canonicalStringSet(module.taskIds);
    if (module.taskBindings != null) requireScope(Array.isArray(module.taskBindings) && module.taskBindings.length === module.taskIds.length &&
      module.taskBindings.every((binding) => typeof binding.designTaskId === "string" && binding.designTaskId.trim() && module.taskIds.includes(binding.taskPacketId)) &&
      new Set(module.taskBindings.map((binding) => binding.taskPacketId)).size === module.taskIds.length,
      `module ${module.id} has ambiguous design-to-packet bindings`);
    requireScope(Array.isArray(module.dependsOn ?? []) && (module.dependsOn ?? []).every((id) => ids.has(id) && id !== module.id) &&
      canonicalStringSet(module.dependsOn).length === (module.dependsOn ?? []).length, `module ${module.id} has invalid dependencies`);
    module.dependsOn = canonicalStringSet(module.dependsOn);
  }
  return { schemaVersion: 1, architecture: { id: plan.architecture.id, revision: plan.architecture.revision,
    basisDigest: plan.architecture.basisDigest }, modules: plan.modules.map((module) => ({ id: module.id,
    revision: module.revision, basisDigest: module.basisDigest, taskIds: module.taskIds, dependsOn: module.dependsOn,
    ...(module.taskBindings ? { taskBindings: module.taskBindings } : {}) })) };
}

function buildModuleScopedStageDag({ orderedStages, stageLanes, stageAuthorities, runtimeCapacity, moduleScopePlan }) {
  requireScope(DEFAULT_STAGE_ORDER.every((stage) => orderedStages.includes(stage)) && orderedStages.length === DEFAULT_STAGE_ORDER.length &&
    orderedStages.every((stage, index) => stage === DEFAULT_STAGE_ORDER[index]), "module lifecycle retains the eight canonical stages");
  const executionLanes = (stageLanes.Execution ?? []).map((lane, index) => ({ ...lane,
    nodeId: lane.nodeId ?? stageLaneNodeId("Execution", lane.laneId ?? `execution-${index + 1}`) }));
  const plan = normalizeModuleScopePlan(moduleScopePlan, executionLanes);
  const architectureScope = { kind: "shared", architectureId: plan.architecture.id,
    revision: plan.architecture.revision, basisDigest: plan.architecture.basisDigest };
  const nodes = [];
  const stageSummaries = [];
  const architectureNodeId = "scope:shared:architecture:gate";
  const gate = (nodeId, stage, scope, dependsOn, mergeNodeId, purpose = "module_stage") => ({
    nodeId, stage, laneKind: "module_stage", scope,
    stageContract: { purpose, receiptVersion: 1, independentReview: ["Review", "Meta-Review", "Verification"].includes(stage) },
    ownerBindingRef: stageAuthorities[stage] ?? `stage-owner:${slug(stage)}`,
    capabilityBindingRef: `config/contracts/core-loop-contract.json#${stage}`,
    dependsOn: uniqueStrings(dependsOn), effectClass: "read_only_stage_review", resourceScopes: [],
    isolation: "current_host_stage_binding_required", mergeNodeId, status: "planned_not_invoked",
  });
  const merge = (nodeId, stage, scope, dependsOn) => ({ nodeId, stage, scope, laneKind: "stage_merge",
    ownerBindingRef: stageAuthorities[stage] ?? `stage-owner:${slug(stage)}`,
    capabilityBindingRef: "config/contracts/core-loop-contract.json", dependsOn: uniqueStrings(dependsOn),
    effectClass: "merge_only", resourceScopes: [], isolation: "single_merge_authority", mergeNodeId: nodeId, status: "pending_merge" });
  nodes.push(gate(architectureNodeId, "Thinking", architectureScope, [], null, "shared_architecture"));
  for (const module of plan.modules) {
    const scope = { kind: "module", moduleId: module.id, revision: module.revision, basisDigest: module.basisDigest,
      architectureBasisDigest: plan.architecture.basisDigest };
    let previous = architectureNodeId;
    for (const stage of orderedStages) {
      const mergeId = moduleStageNodeId(module.id, stage, "merge");
      let laneNodeIds;
      if (stage === "Execution") {
        laneNodeIds = module.taskIds.map((id) => stageLaneNodeId(stage, id));
      } else {
        const gateId = moduleStageNodeId(module.id, stage);
        const dependencies = [previous];
        // A declared design dependency waits for its current design decision,
        // not for every downstream stage of the other module.
        if (stage === "Thinking") dependencies.push(...module.dependsOn.map((id) => moduleStageNodeId(id, "Thinking", "merge")));
        nodes.push(gate(gateId, stage, scope, dependencies, mergeId));
        nodes.at(-1).resourceScopes = uniqueStrings(executionLanes.filter((lane) => module.taskIds.some((id) => stageLaneNodeId("Execution", id) === lane.nodeId))
          .flatMap((lane) => lane.resourceScopes ?? []));
        if (stage === "Thinking" && module.taskIds.length === 0) nodes.at(-1).stageContract.taskDecompositionRequired = true;
        laneNodeIds = [gateId];
      }
      nodes.push(merge(mergeId, stage, scope, [...laneNodeIds, previous]));
      stageSummaries.push({ stage, scope, laneNodeIds, mergeNodeId: mergeId, previousStageMergeNodeId: previous,
        mergeAuthority: stageAuthorities[stage] ?? `stage-owner:${slug(stage)}` });
      previous = mergeId;
    }
  }
  // A shared task retains one canonical execution identity. Every consumer's
  // current Thinking gate is required before this one invocation can run.
  for (const [index, lane] of executionLanes.entries()) {
    const members = plan.modules.filter((module) => module.taskIds.some((id) => stageLaneNodeId("Execution", id) === lane.nodeId));
    const scope = members.length === 1
      ? { kind: "module", moduleId: members[0].id, revision: members[0].revision, basisDigest: members[0].basisDigest,
          architectureBasisDigest: plan.architecture.basisDigest }
      : { ...architectureScope, moduleIds: members.map((module) => module.id),
          moduleBases: members.map((module) => ({ id: module.id, revision: module.revision, basisDigest: module.basisDigest })) };
    const node = normalizeLane("Execution", lane, index, null, null);
    node.scope = scope;
    node.dependsOn = uniqueStrings([...node.dependsOn, architectureNodeId,
      ...members.map((module) => moduleStageNodeId(module.id, "Thinking", "merge"))]);
    nodes.push(node);
  }
  const aggregateScope = { ...architectureScope, kind: "aggregate", moduleIds: plan.modules.map((module) => module.id) };
  const integrationNodeId = "scope:aggregate:integration:gate";
  const finalNodeId = "scope:aggregate:completion:merge";
  nodes.push(gate(integrationNodeId, "Verification", aggregateScope,
    [...plan.modules.map((module) => moduleStageNodeId(module.id, "Evolution", "merge")), ...executionLanes.map((lane) => lane.nodeId)],
    finalNodeId, "integration_verification"));
  nodes.at(-1).resourceScopes = uniqueStrings(executionLanes.flatMap((lane) => lane.resourceScopes ?? []));
  nodes.push(merge(finalNodeId, "Evolution", aggregateScope, [integrationNodeId]));
  const packet = { schemaVersion: "stage-dag-v0.2", authority: "config/contracts/core-loop-contract.json",
    status: "planned_not_invoked", stageOrder: orderedStages, runtimeCapacity, moduleScopePlan: plan, nodes, stageSummaries,
    completionNodeId: finalNodeId, schedulerPolicy: { mode: "module_scoped_stage_dependencies",
      unknownMutationScope: "exclusive_single_lane", resourceConflict: "serialize_unless_isolated", capacity: "active_host_capacity" },
    compatibilityViews: ["thinkingPacket.workerTaskPackets", "dispatchBoard", "stageOperationPlan"],
    invocationTruth: { plannedIsInvoked: false, requiredEvidence: "current scope and basis + durable attempt/fence + observed stage receipt; aggregate integration remains required" } };
  validateStageDagPacket(packet);
  packet.graphDigest = stageDagGraphDigest(packet);
  return packet;
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
  moduleScopePlan = null,
} = {}) {
  const requestedStages = (Array.isArray(stageOrder) ? stageOrder : []).filter(
    (stage) => typeof stage === "string" && stage.trim(),
  );
  assertNoStageSlugCollisions(requestedStages);
  const orderedStages = uniqueStrings(requestedStages);
  if (orderedStages.length === 0) {
    throw new TypeError("stageOrder must contain at least one stage");
  }
  if (moduleScopePlan != null) return buildModuleScopedStageDag({ orderedStages, stageLanes, stageAuthorities, runtimeCapacity, moduleScopePlan });

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
  return match ? { key: scopeComparisonKey(match[1].trim()) } : null;
}

function scopesConflict(leftScope, rightScope) {
  const leftFilesystemScope = normalizeFilesystemScope(leftScope);
  const rightFilesystemScope = normalizeFilesystemScope(rightScope);
  if (leftFilesystemScope?.key === null || rightFilesystemScope?.key === null) return true;
  if (leftFilesystemScope !== null && rightFilesystemScope !== null) {
    // Use the same conservative lexical identity as fanout-policy. Unknown
    // roots and aliases cannot prove independent writes; no physical sandbox
    // or symlink isolation is implied by this scheduler comparison.
    return !scopeKeysAreProvablyDisjoint(leftFilesystemScope.key, rightFilesystemScope.key);
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

function validateEligibleNodeIds(eligibleNodeIds, knownNodeIds) {
  if (eligibleNodeIds === null) return null;
  if (!Array.isArray(eligibleNodeIds) || eligibleNodeIds.length === 0) {
    throw new TypeError("eligibleNodeIds must be a non-empty array");
  }

  for (let index = 0; index < eligibleNodeIds.length; index += 1) {
    if (!Object.hasOwn(eligibleNodeIds, index)) {
      throw new TypeError("eligibleNodeIds must be dense");
    }
    const nodeId = eligibleNodeIds[index];
    if (typeof nodeId !== "string" || !nodeId.trim()) {
      throw new TypeError("eligibleNodeIds must contain non-empty strings");
    }
  }

  const eligible = new Set(eligibleNodeIds);
  if (eligible.size !== eligibleNodeIds.length) {
    throw new TypeError("eligibleNodeIds must contain unique node ids");
  }
  for (const nodeId of eligible) {
    if (!knownNodeIds.has(nodeId)) {
      throw new TypeError(`eligibleNodeIds contains unknown node id: ${nodeId}`);
    }
  }
  return eligible;
}

export function selectMaximalSafeReadySet(
  stageDagPacket,
  { completedNodeIds = [], capacity = null, stage = null, eligibleNodeIds = null, runningNodeIds = [] } = {},
) {
  validateStageDagPacket(stageDagPacket);
  const completed = new Set(uniqueStrings(completedNodeIds));
  const eligible = validateEligibleNodeIds(
    eligibleNodeIds,
    new Set(stageDagPacket.nodes.map((node) => node.nodeId)),
  );
  const limit = Math.max(
    1,
    Number.parseInt(String(capacity ?? stageDagPacket?.runtimeCapacity ?? 1), 10) || 1,
  );
  const runningIds = Array.isArray(runningNodeIds) && runningNodeIds.length === 0 ? new Set()
    : validateEligibleNodeIds(runningNodeIds, new Set(stageDagPacket.nodes.map((node) => node.nodeId)));
  const running = stageDagPacket.nodes.filter((node) => runningIds.has(node.nodeId));
  const candidates = (stageDagPacket?.nodes ?? [])
    .filter((node) => !completed.has(node.nodeId))
    .filter((node) => !runningIds.has(node.nodeId) && !running.some((active) => nodesConflict(active, node)))
    .filter((node) => eligible === null || eligible.has(node.nodeId))
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
