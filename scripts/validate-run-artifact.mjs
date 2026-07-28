#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { planChallengeAuthorizationBinding } from "./governed-execution/plan-challenge-policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const contractPath = path.join(
  repoRoot,
  "config",
  "contracts",
  "workflow-contract.json",
);
const artifactArg = process.argv[2];

export const PACKET_LOCATIONS = {
  runHeader: "runHeader",
  taskClassification: "taskClassification",
  fetchPacket: "fetchPacket",
  intentPacket: "intentPacket",
  intentGatePacket: "intentGatePacket",
  cardPlanPacket: "cardPlanPacket",
  dispatchEnvelopePacket: "dispatchEnvelopePacket",
  orchestrationTaskBoardPacket: "orchestrationTaskBoardPacket",
  businessFlowBlueprintPacket: "businessFlowBlueprintPacket",
  productCompletenessPacket: "productCompletenessPacket",
  experienceQualityPacket: "experienceQualityPacket",
  testStrategyPacket: "testStrategyPacket",
  structureHygienePacket: "structureHygienePacket",
  permissionMatrixPacket: "permissionMatrixPacket",
  sideEffectLedgerPacket: "sideEffectLedgerPacket",
  rollbackPlanPacket: "rollbackPlanPacket",
  interfaceIntegrationContractPacket: "interfaceIntegrationContractPacket",
  agentBlueprintPacket: "agentBlueprintPacket",
  capabilityGapPacket: "capabilityGapPacket",
  executionAgentCard: "executionAgentCard",
  dispatchBoard: "dispatchBoard",
  workerTaskPacket: "workerTaskPackets",
  workerResultPacket: "workerResultPackets",
  reviewPacket: "reviewPacket",
  verificationPacket: "verificationPacket",
  summaryPacket: "summaryPacket",
  compactionPacket: "compactionPacket",
  evolutionWritebackPacket: "evolutionWritebackPacket",
};

function fail(message) {
  throw new Error(message);
}

function ensure(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function ensureFields(target, fields, context) {
  ensure(target && typeof target === "object", `${context} must be an object.`);
  for (const field of fields) {
    ensure(field in target, `${context} is missing required field "${field}".`);
  }
}

function ensureArray(value, context) {
  ensure(Array.isArray(value), `${context} must be an array.`);
}

function ensureEnum(value, allowed, context) {
  ensure(
    allowed.includes(value),
    `${context} must be one of [${allowed.join(", ")}], got: ${value}`,
  );
}

function normalizePathRef(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeTargetPath(value) {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
}

function containsPathTraversal(target) {
  return normalizeTargetPath(target).split("/").includes("..");
}

function isForbiddenEvolutionWritebackTarget(target) {
  const normalized = normalizeTargetPath(target).toLowerCase();
  return (
    normalized === "memory" ||
    normalized.startsWith("memory/") ||
    normalized.startsWith(".meta-kim/state/") ||
    normalized.includes("/compaction/") ||
    normalized === "compaction" ||
    normalized.startsWith("compaction/") ||
    normalized === "run-index" ||
    normalized.startsWith("run-index/") ||
    normalized.includes("run-index.sqlite")
  );
}

function matchesEvolutionWritebackTarget(target, allowedTarget) {
  const normalizedTarget = normalizeTargetPath(target);
  const normalizedAllowed = normalizeTargetPath(allowedTarget);

  if (!normalizedAllowed) return false;
  if (normalizedAllowed.endsWith("/")) {
    return normalizedTarget.startsWith(normalizedAllowed);
  }

  const escaped = normalizedAllowed
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\{[^/]+\\\}/g, "[^/]+");
  return new RegExp(`^${escaped}$`).test(normalizedTarget);
}

function validateEvolutionWritebackTargets(contract, writebacks) {
  const allowedTargets = contract.runDiscipline.evolutionWritebackTargets ?? [];
  ensureArray(
    allowedTargets,
    "runDiscipline.evolutionWritebackTargets",
  );

  for (const [index, writeback] of writebacks.entries()) {
    const target = writeback.target;
    ensure(
      !containsPathTraversal(target),
      `evolutionWritebackPacket.writebacks[${index}].target must not contain path traversal: ${target}`,
    );
    ensure(
      !isForbiddenEvolutionWritebackTarget(target),
      `evolutionWritebackPacket.writebacks[${index}].target must not use memory, compaction, or run-index storage for Evolution writeback: ${target}`,
    );
    ensure(
      allowedTargets.some((allowedTarget) =>
        matchesEvolutionWritebackTarget(target, allowedTarget),
      ),
      `evolutionWritebackPacket.writebacks[${index}].target must match one of runDiscipline.evolutionWritebackTargets: ${target}`,
    );
  }
}

async function readJson(targetPath) {
  const raw = await fs.readFile(targetPath, "utf8");
  return JSON.parse(raw);
}

function getPacket(artifact, packetName) {
  return artifact[PACKET_LOCATIONS[packetName] ?? packetName];
}

function ensureString(value, context) {
  ensure(
    typeof value === "string" && value.trim().length >= 1,
    `${context} must be a non-empty string.`,
  );
}

function ensureStringArray(value, context) {
  ensureArray(value, context);
  for (const [index, item] of value.entries()) {
    ensureString(item, `${context}[${index}]`);
  }
}

const DEFAULT_PRODUCT_GATE_PACKET_NAMES = [
  "productCompletenessPacket",
  "experienceQualityPacket",
  "testStrategyPacket",
  "structureHygienePacket",
  "permissionMatrixPacket",
  "sideEffectLedgerPacket",
  "rollbackPlanPacket",
];

function productGatePacketNames(contract) {
  const policy = contract.runDiscipline?.productDeliverableGatePolicy ?? {};
  const names = [
    ...(policy.requiredPackets ?? []),
    ...(policy.requiredSideEffectPackets ?? []),
  ];
  return names.length > 0 ? [...new Set(names)] : DEFAULT_PRODUCT_GATE_PACKET_NAMES;
}

function getPathValue(root, ref) {
  const normalized = String(ref ?? "")
    .trim()
    .replace(/\[(\d+)\]/g, ".$1");
  if (!normalized) return undefined;
  let cursor = root;
  for (const part of normalized.split(".")) {
    if (!part) continue;
    if (cursor === undefined || cursor === null) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function evidenceRefResolves(artifact, ref) {
  const value = getPathValue(artifact, ref);
  return value !== undefined;
}

function validateEvidenceRefArray(artifact, refs, context) {
  ensureStringArray(refs, context);
  ensure(refs.length >= 1, `${context} must include at least one evidence reference.`);
  for (const [index, ref] of refs.entries()) {
    ensure(
      evidenceRefResolves(artifact, ref),
      `${context}[${index}] must resolve to an artifact evidence path, got: ${ref}`,
    );
  }
}

function ensureNoUnexpectedFields(value, allowedFields, context) {
  ensureObject(value, context);
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(value)) {
    ensure(
      allowed.has(field),
      `${context}.${field} is not allowed; unsupported fields can hide stale fallback behavior.`,
    );
  }
}

function ensureObjectArray(value, context) {
  ensureArray(value, context);
  for (const [index, item] of value.entries()) {
    ensureObject(item, `${context}[${index}]`);
  }
}

function ensureObject(value, context) {
  ensure(value && typeof value === "object" && !Array.isArray(value), `${context} must be an object.`);
}

function ensureForbiddenSecretValueKeysAbsent(value, context) {
  const forbiddenKeys = new Set([
    "secretValue",
    "tokenValue",
    "apiKeyValue",
    "passwordValue",
  ]);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      ensureForbiddenSecretValueKeysAbsent(item, `${context}[${index}]`);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    ensure(
      !forbiddenKeys.has(key),
      `${context}.${key} must not store secret values; use a secretRef or authPolicyRef instead.`,
    );
    ensureForbiddenSecretValueKeysAbsent(item, `${context}.${key}`);
  }
}

function ensureNonEmptyValue(value, context) {
  if (Array.isArray(value)) {
    ensure(value.length >= 1, `${context} must not be empty.`);
    for (const [index, item] of value.entries()) {
      ensureString(item, `${context}[${index}]`);
    }
    return;
  }
  ensureString(value, context);
}

function governanceStagePolicy(contract) {
  return contract.protocols?.agentBlueprintPacket?.governanceStageCoveragePolicy ?? {};
}

function allowedGovernanceAgents(contract) {
  const configured = governanceStagePolicy(contract).allowedOwnerAgents ?? [];
  return new Set(
    configured.length > 0
      ? configured
      : [
          "meta-warden",
          "meta-conductor",
          "meta-genesis",
          "meta-artisan",
          "meta-sentinel",
          "meta-librarian",
          "meta-prism",
          "meta-scout",
          "meta-chrysalis",
        ],
  );
}

function ensureGovernanceOwner(contract, ownerAgent, context) {
  const allowed = allowedGovernanceAgents(contract);
  ensureString(ownerAgent, context);
  ensure(
    allowed.has(ownerAgent),
    `${context} must be one of the open-source governance meta agents, got: ${ownerAgent}`,
  );
}

function ensureDurableOwner(contract, artifact, ownerAgent, context) {
  ensureString(ownerAgent, context);
}

function validateRoleOwnerPolicy(contract, role, context) {
  const policy = contract.protocols.agentBlueprintPacket;
  ensureEnum(role.ownerSource, policy.ownerSourceEnum, `${context}.ownerSource`);
  ensureEnum(
    role.agentCopyPolicy,
    policy.agentCopyPolicyEnum,
    `${context}.agentCopyPolicy`,
  );

  if (role.ownerSource === "meta_kim_canonical") {
    ensureGovernanceOwner(contract, role.ownerAgent, `${context}.ownerAgent`);
    ensure(
      role.agentCopyPolicy === "meta_kim_governance_only",
      `${context}.agentCopyPolicy must be meta_kim_governance_only for Meta_Kim canonical owners.`,
    );
  }

  if (role.ownerSource === "global_reuse") {
    ensure(
      role.agentCopyPolicy === "use_global_directly",
      `${context}.agentCopyPolicy must be use_global_directly for directly reused global agents; do not copy usable global agents into the project.`,
    );
    ensure(
      role.ownerResolution === "reuse_existing_owner",
      `${context}.ownerResolution must be reuse_existing_owner when a global agent is used directly.`,
    );
  }

  if (role.ownerSource === "project_local") {
    ensure(
      [
        "copy_to_project_for_modification",
        "create_project_local_agent",
        "already_project_local",
      ].includes(role.agentCopyPolicy),
      `${context}.agentCopyPolicy must be copy_to_project_for_modification, create_project_local_agent, or already_project_local for project-local agents.`,
    );
  }

  if (role.agentCopyPolicy === "copy_to_project_for_modification") {
    ensure(
      role.ownerSource === "project_local" &&
        role.ownerResolution === "upgrade_existing_owner",
      `${context}.agentCopyPolicy=copy_to_project_for_modification requires ownerSource=project_local and ownerResolution=upgrade_existing_owner; only agents that need modification are copied into the project.`,
    );
  }

  if (role.agentCopyPolicy === "create_project_local_agent") {
    ensure(
      role.ownerSource === "project_local" &&
        role.ownerResolution === "create_owner_first",
      `${context}.agentCopyPolicy=create_project_local_agent requires ownerSource=project_local and ownerResolution=create_owner_first.`,
    );
  }

  if (
    role.ownerSource === "project_local" &&
    role.ownerResolution === "reuse_existing_owner"
  ) {
    ensure(
      role.agentCopyPolicy === "already_project_local",
      `${context}.agentCopyPolicy must be already_project_local when reusing an existing project-local agent without modification.`,
    );
  }

  if (role.ownerResolution === "create_owner_first") {
    ensure(
      role.ownerSource === "project_local" &&
        role.agentCopyPolicy === "create_project_local_agent",
      `${context}.ownerResolution=create_owner_first requires a project-local execution agent creation policy.`,
    );
  }

  if (
    ["upgrade_existing_owner", "create_owner_first"].includes(
      role.ownerResolution,
    ) &&
    role.ownerSource === "global_reuse"
  ) {
    fail(
      `${context} cannot modify a global_reuse agent directly; copy it to the project first and mark ownerSource=project_local.`,
    );
  }
}

function validateMatchedSkills(policy, skills, context) {
  ensureObjectArray(skills, context);
  ensure(skills.length >= 1, `${context} must contain at least one run-scoped skill match.`);
  const allowedProviders = new Set(
    policy.longTermCapabilityPolicy?.allowedMetaSkillProviders ?? [],
  );
  for (const [index, skill] of skills.entries()) {
    ensureFields(skill, policy.matchedSkillRequiredFields, `${context}[${index}]`);
    ensureString(skill.matchId, `${context}[${index}].matchId`);
    ensureString(skill.capabilitySlot, `${context}[${index}].capabilitySlot`);
    ensureString(skill.providerId, `${context}[${index}].providerId`);
    ensure(
      allowedProviders.has(skill.providerId),
      `${context}[${index}].providerId must be an allowed meta skill provider.`,
    );
    ensureString(skill.skillId, `${context}[${index}].skillId`);
    ensureString(skill.source, `${context}[${index}].source`);
    ensure(
      Number.isFinite(skill.roiScore),
      `${context}[${index}].roiScore must be a number.`,
    );
    ensureString(skill.selectionReason, `${context}[${index}].selectionReason`);
    ensureEnum(
      skill.selectionScope,
      policy.skillSelectionScopeEnum,
      `${context}[${index}].selectionScope`,
    );
    ensure(
      skill.persistencePolicy === "do_not_persist_to_agent_identity",
      `${context}[${index}].persistencePolicy must be do_not_persist_to_agent_identity.`,
    );
    ensureString(skill.fallback, `${context}[${index}].fallback`);
    ensure(
      !/temporary|generic|general[- ]purpose|use_fallback/i.test(skill.fallback),
      `${context}[${index}].fallback must block or record a capability gap, not assign a temporary or generic fallback owner.`,
    );
  }
}

function validateMatchedCapabilities(policy, capabilities, context) {
  ensureObjectArray(capabilities, context);
  ensure(
    capabilities.length >= 1,
    `${context} must contain at least one run-scoped capability match.`,
  );
  const allowedTypes = policy.capabilityBindingTypeEnum ?? [];
  const allowedScopes =
    policy.capabilitySelectionScopeEnum ?? policy.skillSelectionScopeEnum;
  for (const [index, capability] of capabilities.entries()) {
    ensureFields(
      capability,
      policy.matchedCapabilityRequiredFields,
      `${context}[${index}]`,
    );
    ensureString(capability.matchId, `${context}[${index}].matchId`);
    ensureString(
      capability.capabilitySlot,
      `${context}[${index}].capabilitySlot`,
    );
    ensureEnum(
      capability.bindingType,
      allowedTypes,
      `${context}[${index}].bindingType`,
    );
    ensureString(
      capability.bindingRef,
      `${context}[${index}].bindingRef`,
    );
    ensureString(capability.source, `${context}[${index}].source`);
    ensure(
      Number.isFinite(capability.confidenceScore),
      `${context}[${index}].confidenceScore must be a number.`,
    );
    ensureString(
      capability.selectionReason,
      `${context}[${index}].selectionReason`,
    );
    ensureEnum(
      capability.selectionScope,
      allowedScopes,
      `${context}[${index}].selectionScope`,
    );
    ensure(
      capability.persistencePolicy === "do_not_persist_to_agent_identity",
      `${context}[${index}].persistencePolicy must be do_not_persist_to_agent_identity.`,
    );
    ensureString(capability.fallback, `${context}[${index}].fallback`);
    ensure(
      !/temporary|generic|general[- ]purpose|use_fallback/i.test(capability.fallback),
      `${context}[${index}].fallback must block or record a capability gap, not assign a temporary or generic fallback owner.`,
    );
  }
}

function validateCapabilityBindings(policy, bindings, context) {
  ensureObjectArray(bindings, context);
  ensure(
    bindings.length >= 1,
    `${context} must contain at least one concrete capability binding.`,
  );
  const allowedTypes = policy.capabilityBindingTypeEnum ?? [];
  for (const [index, binding] of bindings.entries()) {
    ensureFields(
      binding,
      policy.capabilityBindingRequiredFields,
      `${context}[${index}]`,
    );
    ensureString(binding.bindingId, `${context}[${index}].bindingId`);
    ensureString(
      binding.capabilitySlot,
      `${context}[${index}].capabilitySlot`,
    );
    ensureEnum(
      binding.bindingType,
      allowedTypes,
      `${context}[${index}].bindingType`,
    );
    ensureString(binding.bindingRef, `${context}[${index}].bindingRef`);
    ensureString(binding.source, `${context}[${index}].source`);
    ensureString(binding.evidenceRef, `${context}[${index}].evidenceRef`);
  }
}

function validateRoleCapabilityMatches(policy, role, context) {
  const hasMatchedCapabilities = role.matchedCapabilities !== undefined;
  const hasMatchedSkills = role.matchedSkills !== undefined;
  ensure(
    hasMatchedCapabilities || hasMatchedSkills,
    `${context} must include matchedCapabilities or legacy matchedSkills capability evidence.`,
  );

  if (hasMatchedCapabilities) {
    validateMatchedCapabilities(
      policy,
      role.matchedCapabilities,
      `${context}.matchedCapabilities`,
    );
    ensure(
      role.capabilityBindings !== undefined,
      `${context}.capabilityBindings is required when matchedCapabilities are present.`,
    );
  }
  if (role.capabilityBindings !== undefined) {
    validateCapabilityBindings(
      policy,
      role.capabilityBindings,
      `${context}.capabilityBindings`,
    );
  }
  if (hasMatchedCapabilities) {
    const bindings = role.capabilityBindings ?? [];
    for (const [index, capability] of role.matchedCapabilities.entries()) {
      const hasBinding = bindings.some(
        (binding) =>
          binding.capabilitySlot === capability.capabilitySlot &&
          binding.bindingType === capability.bindingType &&
          binding.bindingRef === capability.bindingRef,
      );
      ensure(
        hasBinding,
        `${context}.matchedCapabilities[${index}] must have a matching capabilityBindings entry with the same capabilitySlot, bindingType, and bindingRef.`,
      );
    }
  }
  if (hasMatchedSkills) {
    validateMatchedSkills(policy, role.matchedSkills, `${context}.matchedSkills`);
  }
}

function validateGovernanceStageNodes(policy, nodes, context) {
  ensureObjectArray(nodes, context);
  ensure(nodes.length >= 1, `${context} must contain at least one governance stage node.`);
  const stagesSeen = new Set();
  for (const [index, node] of nodes.entries()) {
    ensureFields(node, policy.governanceStageNodeRequiredFields, `${context}[${index}]`);
    ensureString(node.stage, `${context}[${index}].stage`);
    ensure(
      policy.governanceStageCoveragePolicy.requiredStages.includes(node.stage),
      `${context}[${index}].stage must be one of the required governance stages.`,
    );
    stagesSeen.add(node.stage);
    ensureGovernanceOwner(contractFromPolicy(policy), node.ownerAgent, `${context}[${index}].ownerAgent`);
    const stageAllowed = new Set(
      policy.governanceStageCoveragePolicy.stageAllowedAgents?.[node.stage] ?? [],
    );
    ensure(
      stageAllowed.has(node.ownerAgent),
      `${context}[${index}].ownerAgent is not allowed for stage ${node.stage}.`,
    );
    ensureString(node.responsibility, `${context}[${index}].responsibility`);
  }
  for (const stage of policy.governanceStageCoveragePolicy.requiredStages) {
    ensure(
      stagesSeen.has(stage),
      `${context} must include a governance node for ${stage}.`,
    );
  }
}

function contractFromPolicy(policy) {
  return {
    protocols: {
      agentBlueprintPacket: {
        governanceStageCoveragePolicy: policy.governanceStageCoveragePolicy,
      },
    },
  };
}

function shouldRequireProductGatePackets(contract, artifact) {
  const policy = contract.runDiscipline?.productDeliverableGatePolicy ?? {};
  if (policy.enabled !== true) return false;

  const flow = artifact.taskClassification?.governanceFlow;
  if (policy.requiredForNonQuery === true && flow && flow !== "query") {
    return true;
  }

  const deliverableType = artifact.businessFlowBlueprintPacket?.deliverableType;
  return (policy.requiredWhenDeliverableTypes ?? []).includes(deliverableType);
}

function productGatePolicy(contract) {
  return contract.runDiscipline?.productDeliverableGatePolicy ?? {};
}

function dimensionCoverageFieldForPacket(contract, packetName) {
  return productGatePolicy(contract).dimensionCoverageFieldByPacket?.[packetName];
}

function dimensionCatalogForPacket(contract, packetName, deliverableType) {
  const catalog = productGatePolicy(contract).designDimensionCatalog ?? [];
  return catalog.filter((dimension) => {
    if (dimension?.packet !== packetName) return false;
    const applicable = dimension.applicableDeliverableTypes ?? [];
    return applicable.includes("all") || applicable.includes(deliverableType);
  });
}

function validateDimensionCoverage(
  contract,
  packetName,
  packet,
  artifact,
) {
  const fieldName = dimensionCoverageFieldForPacket(contract, packetName);
  if (!fieldName) return;

  const policy = productGatePolicy(contract);
  const deliverableType = artifact.businessFlowBlueprintPacket?.deliverableType;
  const requiredDimensions = dimensionCatalogForPacket(
    contract,
    packetName,
    deliverableType,
  );
  const requiredDimensionIds = new Set(
    requiredDimensions.map((dimension) => dimension.dimensionId),
  );
  const knownDimensionIds = new Set(
    (policy.designDimensionCatalog ?? []).map((dimension) => dimension.dimensionId),
  );
  const allowedStatuses = policy.dimensionCoverageStatusEnum ?? [
    "covered",
    "omitted_with_reason",
    "blocked",
  ];
  const publicReadyAllowed = policy.dimensionPublicReadyAllowedStatuses ?? [
    "covered",
    "omitted_with_reason",
  ];

  ensureObjectArray(packet[fieldName], `${packetName}.${fieldName}`);

  const coveredIds = new Set();
  for (const [index, dimension] of packet[fieldName].entries()) {
    const context = `${packetName}.${fieldName}[${index}]`;
    ensureFields(
      dimension,
      policy.dimensionCoverageRequiredFields ?? ["dimensionId", "status"],
      context,
    );
    ensureString(dimension.dimensionId, `${context}.dimensionId`);
    ensure(
      knownDimensionIds.has(dimension.dimensionId),
      `${context}.dimensionId must be defined in productDeliverableGatePolicy.designDimensionCatalog: ${dimension.dimensionId}`,
    );
    ensureEnum(dimension.status, allowedStatuses, `${context}.status`);

    if (dimension.status === "covered") {
      ensureString(dimension.evidenceRef, `${context}.evidenceRef`);
      ensure(
        evidenceRefResolves(artifact, dimension.evidenceRef),
        `${context}.evidenceRef must resolve to an artifact evidence path, got: ${dimension.evidenceRef}`,
      );
    } else if (dimension.status === "omitted_with_reason") {
      ensureString(dimension.omissionReason, `${context}.omissionReason`);
    } else if (dimension.status === "blocked") {
      ensureString(dimension.blockingReason, `${context}.blockingReason`);
    }

    if (artifact.summaryPacket?.publicReady === true) {
      ensure(
        publicReadyAllowed.includes(dimension.status),
        `summaryPacket.publicReady=true requires ${context}.status to be one of [${publicReadyAllowed.join(", ")}], got: ${dimension.status}`,
      );
    }

    coveredIds.add(dimension.dimensionId);
  }

  for (const dimensionId of requiredDimensionIds) {
    ensure(
      coveredIds.has(dimensionId),
      `${packetName}.${fieldName} must include design-time dimension ${dimensionId} for deliverableType=${deliverableType}.`,
    );
  }
}

function ensureAcyclicDependencyGraph(dependenciesById, context) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      const cyclePath = [...stack.slice(cycleStart), id].join(" -> ");
      fail(`${context} contains a dependency cycle: ${cyclePath}`);
    }

    visiting.add(id);
    stack.push(id);
    for (const dep of dependenciesById.get(id) ?? []) {
      visit(dep);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of dependenciesById.keys()) {
    visit(id);
  }
}

function validateRoleDisplayName(name, context) {
  const trimmed = String(name ?? "").trim();
  ensure(
    !/^agent-[0-9a-f-]+$/i.test(trimmed),
    `${context} must be a role-family name; runtime alias ids such as agent-019e56a9 belong in runtimeInstanceAlias only.`,
  );
  ensure(
    !/^[A-Z][a-z]+$/.test(trimmed),
    `${context} must be business-readable, not a runtime nickname.`,
  );
  ensure(
    !/[-_/\\:]/.test(trimmed),
    `${context} must stay at role-family level; put work-item scope in roleInstanceId, shardScope, assignedResponsibilitySlice, or task text.`,
  );
}

function flattenStringValues(value, context = "value", results = []) {
  if (typeof value === "string") {
    results.push({ context, value });
    return results;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      flattenStringValues(item, `${context}[${index}]`, results);
    }
    return results;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      flattenStringValues(item, `${context}.${key}`, results);
    }
  }
  return results;
}

function looksLikePathBinding(text) {
  return /(?:[A-Za-z]:[\\/]|\\\\[^\s]+|(?:^|[\s"'`])(?:~|\.{1,2})[\\/]|(?:^|[\s"'`])\/(?:Users|home|mnt|var|tmp|etc)\b|(?:^|[\s"'`])(?:src|app|pages|components|canonical|config|scripts|tests|docs)[\\/]|[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|md|json|toml|ya?ml|css|html|sql|sh|ps1)\b)/i.test(
    text,
  );
}

function looksLikeSingleRunTaskBinding(text) {
  const hasTaskVerb =
    /\b(fix|patch|update|modify|rewrite|edit|delete|remove|add|change|migrate|implement)\b/i.test(
      text,
    );
  const hasConcreteObject =
    /\b(ticket|issue|bug|pr|page|screen|endpoint|route|file|component|button|modal|checkout|login|signup|auth|settings)\b/i.test(
      text,
    );
  const hasRunMarker =
    /\b(today|this run|this task|one-off|single-run|current request)\b/i.test(
      text,
    );
  return hasTaskVerb && (hasConcreteObject || hasRunMarker);
}

function validateExecutionAgentCardAbstraction(contract, packet, context) {
  const policy = contract.protocols?.executionAgentCard?.abstractionPolicy ?? {};
  const forbiddenFields = new Set(policy.forbiddenDurableFields ?? []);

  for (const key of Object.keys(packet ?? {})) {
    ensure(
      !forbiddenFields.has(key),
      `${context}.${key} is a worker-task field and must not be persisted in executionAgentCard durable identity.`,
    );
  }

  validateRoleDisplayName(packet.roleDisplayName, `${context}.roleDisplayName`);

  for (const item of flattenStringValues(packet, context)) {
    ensure(
      !looksLikePathBinding(item.value),
      `${item.context} must not bind execution-agent identity to a concrete file path or address; put concrete scope in workerTaskPackets.scopeFiles or capabilityBindings.`,
    );
    ensure(
      !looksLikeSingleRunTaskBinding(item.value),
      `${item.context} must describe a reusable capability class, not a single-run task; put concrete work in workerTaskPackets.todayTask.`,
    );
  }
}

function valuesAsStrings(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [String(value)];
}

function ensureDecisionItems(value, context) {
  ensureArray(value, context);
  for (const [index, item] of value.entries()) {
    ensure(
      item && typeof item === "object",
      `${context}[${index}] must be an object.`,
    );
    ensureString(item.target, `${context}[${index}].target`);
    ensureString(item.reason, `${context}[${index}].reason`);
  }
}

function computePendingFindingIds(artifact) {
  const reviewFindings = artifact.reviewPacket?.findings ?? [];
  const closedIds = new Set(artifact.verificationPacket?.closeFindings ?? []);
  return reviewFindings
    .filter((finding) => !closedIds.has(finding.findingId))
    .map((finding) => finding.findingId);
}

function deriveVerifyGateState(artifact) {
  if (artifact.verificationPacket?.verified !== true) {
    return "pending_verify";
  }
  const hasAcceptedRisk = (
    artifact.verificationPacket?.verificationResults ?? []
  ).some((result) => result.closeState === "accepted_risk");
  return hasAcceptedRisk ? "accepted_risk" : "verified";
}

function validateTaskClassification(contract, taskClassification) {
  ensureFields(
    taskClassification,
    contract.protocols.taskClassification.requiredFields,
    "taskClassification",
  );

  const classificationPolicy = contract.runDiscipline.taskClassification;
  ensureEnum(
    taskClassification.taskClass,
    classificationPolicy.taskClassEnum,
    "taskClassification.taskClass",
  );
  ensureEnum(
    taskClassification.requestClass,
    classificationPolicy.requestClassEnum,
    "taskClassification.requestClass",
  );
  ensureEnum(
    taskClassification.queryScope,
    classificationPolicy.queryScopeEnum,
    "taskClassification.queryScope",
  );
  ensureString(taskClassification.projectRef, "taskClassification.projectRef");
  ensureEnum(
    taskClassification.registryStatus,
    classificationPolicy.registryStatusEnum,
    "taskClassification.registryStatus",
  );
  ensureString(
    taskClassification.crossProjectReason,
    "taskClassification.crossProjectReason",
  );
  ensureEnum(
    taskClassification.governanceFlow,
    classificationPolicy.governanceFlowEnum,
    "taskClassification.governanceFlow",
  );
  ensureArray(
    taskClassification.triggerReasons,
    "taskClassification.triggerReasons",
  );
  ensureArray(
    taskClassification.upgradeReasons,
    "taskClassification.upgradeReasons",
  );
  ensureArray(
    taskClassification.bypassReasons,
    "taskClassification.bypassReasons",
  );

  for (const item of taskClassification.triggerReasons) {
    ensureEnum(
      item,
      classificationPolicy.triggerReasonEnum,
      "taskClassification.triggerReasons[]",
    );
  }
  for (const item of taskClassification.upgradeReasons) {
    ensureEnum(
      item,
      classificationPolicy.upgradeReasonEnum,
      "taskClassification.upgradeReasons[]",
    );
  }
  for (const item of taskClassification.bypassReasons) {
    ensureEnum(
      item,
      classificationPolicy.bypassReasonEnum,
      "taskClassification.bypassReasons[]",
    );
  }

  if (taskClassification.ownerRequired === false) {
    ensure(
      taskClassification.taskClass === "Q" &&
        taskClassification.requestClass === "query" &&
        taskClassification.governanceFlow === "query" &&
        taskClassification.bypassReasons.includes("pure_query"),
      "ownerRequired=false is only legal for pure-query runs.",
    );
  }
  if (taskClassification.governanceFlow === "query") {
    ensure(
      taskClassification.taskClass === "Q" &&
        taskClassification.requestClass === "query" &&
        taskClassification.ownerRequired === false &&
        taskClassification.bypassReasons.includes("pure_query"),
      "governanceFlow=query is only legal for true pure-query runs; executable work is misclassified.",
    );
  }
}

function validateFetchPacket(contract, artifact) {
  const packet = artifact.fetchPacket;
  ensureFields(packet, contract.protocols.fetchPacket.requiredFields, "fetchPacket");

  for (const field of [
    "projectsChecked",
    "projectLocalSources",
    "globalRegistryHits",
    "capabilityMatches",
    "capabilityGaps",
    "graphSources",
    "knowledgeSources",
  ]) {
    ensureArray(packet[field], `fetchPacket.${field}`);
  }

  for (const [index, item] of packet.projectsChecked.entries()) {
    ensure(item && typeof item === "object", `fetchPacket.projectsChecked[${index}] must be an object.`);
    ensureString(item.projectRef, `fetchPacket.projectsChecked[${index}].projectRef`);
    ensureString(item.checkMode, `fetchPacket.projectsChecked[${index}].checkMode`);
    ensureString(item.reason, `fetchPacket.projectsChecked[${index}].reason`);
  }

  for (const field of ["projectLocalSources", "globalRegistryHits", "graphSources", "knowledgeSources"]) {
    for (const [index, item] of packet[field].entries()) {
      ensure(item && typeof item === "object", `fetchPacket.${field}[${index}] must be an object.`);
      ensureString(item.projectRef, `fetchPacket.${field}[${index}].projectRef`);
      ensureString(item.sourceType, `fetchPacket.${field}[${index}].sourceType`);
      ensureString(item.sourceRef, `fetchPacket.${field}[${index}].sourceRef`);
    }
  }

  for (const [index, item] of packet.capabilityMatches.entries()) {
    ensure(item && typeof item === "object", `fetchPacket.capabilityMatches[${index}] must be an object.`);
    ensureString(item.capability, `fetchPacket.capabilityMatches[${index}].capability`);
    ensureString(item.owner, `fetchPacket.capabilityMatches[${index}].owner`);
    ensureString(item.sourceProject, `fetchPacket.capabilityMatches[${index}].sourceProject`);
  }

  for (const [index, item] of packet.capabilityGaps.entries()) {
    ensure(item && typeof item === "object", `fetchPacket.capabilityGaps[${index}] must be an object.`);
    ensureString(item.capability, `fetchPacket.capabilityGaps[${index}].capability`);
    ensureString(item.reason, `fetchPacket.capabilityGaps[${index}].reason`);
  }

  const checkedProjects = packet.projectsChecked.map((item) => item.projectRef);
  ensure(
    checkedProjects.includes(artifact.taskClassification.projectRef),
    "fetchPacket.projectsChecked must include taskClassification.projectRef.",
  );

  if (artifact.taskClassification.queryScope === "current_project") {
    ensure(
      packet.projectsChecked.length === 1 &&
        checkedProjects[0] === artifact.taskClassification.projectRef,
      "current_project runs may only check the current project in fetchPacket.projectsChecked.",
    );
    ensure(
      packet.globalRegistryHits.length === 0,
      "current_project runs must not record global registry hits.",
    );
  }
}

function validateContentEvidencePacket(contract, artifact) {
  const packet = artifact.contentEvidencePacket;
  const policy = contract.protocols.contentEvidencePacket;
  ensureFields(packet, policy.requiredFields, "contentEvidencePacket");
  ensureEnum(
    packet.evidenceScope,
    policy.evidenceScopeEnum,
    "contentEvidencePacket.evidenceScope",
  );
  ensureEnum(
    packet.researchSkipReason,
    policy.researchSkipReasonEnum,
    "contentEvidencePacket.researchSkipReason",
  );
  ensureString(
    packet.evidenceLaneValidatedBy,
    "contentEvidencePacket.evidenceLaneValidatedBy",
  );
  ensureStringArray(packet.evidence, "contentEvidencePacket.evidence");
  ensure(
    packet.evidence.length >= 1,
    "contentEvidencePacket.evidence must contain decision-grade evidence.",
  );
  ensureStringArray(
    packet.capabilityDiscovery,
    "contentEvidencePacket.capabilityDiscovery",
  );
  ensure(
    packet.capabilityDiscovery.length >= 1,
    "contentEvidencePacket.capabilityDiscovery must list capability, tool, or owner candidates checked.",
  );
  ensure(
    typeof packet.capabilityGap === "string" ||
      (packet.capabilityGap && typeof packet.capabilityGap === "object"),
    "contentEvidencePacket.capabilityGap must be a string or object.",
  );
  ensureObject(packet.deepResearchPlan, "contentEvidencePacket.deepResearchPlan");
  const researchGate = policy.deepResearchPlanQualityGate ?? {};
  const stringArrayPlanFields = [
    "decisionUse",
    "questions",
    "sourceCategoriesPlanned",
    "deepReadTargets",
    "sourceQualityLadder",
    "claimAttributionRules",
    "crossCheckStrategy",
    "originalSynthesisRules",
    "decisionImpactCriteria",
    "keyInformationTargets",
    "iterationPlan",
    "stopCondition",
    "decisionUpdateRule",
  ];
  for (const field of researchGate.requiredPlanFields ?? stringArrayPlanFields) {
    const context = `contentEvidencePacket.deepResearchPlan.${field}`;
    if (stringArrayPlanFields.includes(field)) {
      ensureStringArray(packet.deepResearchPlan[field], context);
      ensure(
        packet.deepResearchPlan[field].length >= 1,
        `${context} must explain what evidence would change the decision.`,
      );
    } else {
      ensure(
        packet.deepResearchPlan[field] && typeof packet.deepResearchPlan[field] === "object",
        `${context} must be present for decision-grade research.`,
      );
    }
  }
  const decisionFrame = packet.deepResearchPlan.decisionQualityFrame;
  ensureObject(decisionFrame, "contentEvidencePacket.deepResearchPlan.decisionQualityFrame");
  for (const field of researchGate.decisionQualityFrameRequiredFields ?? []) {
    ensure(
      typeof decisionFrame[field] === "string" ||
        (Array.isArray(decisionFrame[field]) && decisionFrame[field].length >= 1),
      `contentEvidencePacket.deepResearchPlan.decisionQualityFrame.${field} must be non-empty.`,
    );
  }
  const minimumTest = packet.deepResearchPlan.minimumDecisionTest;
  ensureObject(minimumTest, "contentEvidencePacket.deepResearchPlan.minimumDecisionTest");
  for (const field of researchGate.minimumDecisionTestRequiredFields ?? []) {
    ensureString(
      minimumTest[field],
      `contentEvidencePacket.deepResearchPlan.minimumDecisionTest.${field}`,
    );
  }
  const hypothesisPolicy = researchGate.competingHypothesesPolicy ?? {};
  ensureArray(
    packet.deepResearchPlan.competingHypotheses,
    "contentEvidencePacket.deepResearchPlan.competingHypotheses",
  );
  ensure(
    packet.deepResearchPlan.competingHypotheses.length >=
      (hypothesisPolicy.minimumHypotheses ?? 2),
    "contentEvidencePacket.deepResearchPlan.competingHypotheses must compare at least two plausible routes or explanations.",
  );
  for (const [index, hypothesis] of packet.deepResearchPlan.competingHypotheses.entries()) {
    const context = `contentEvidencePacket.deepResearchPlan.competingHypotheses[${index}]`;
    ensureObject(hypothesis, context);
    ensureFields(
      hypothesis,
      hypothesisPolicy.requiredFields ?? [
        "hypothesis",
        "wouldExpect",
        "disconfirmingEvidence",
        "currentStatus",
        "decisionImpact",
      ],
      context,
    );
    for (const field of ["hypothesis", "wouldExpect", "disconfirmingEvidence", "currentStatus", "decisionImpact"]) {
      ensureString(hypothesis[field], `${context}.${field}`);
    }
  }
  const confidencePolicy = packet.deepResearchPlan.evidenceConfidencePolicy;
  ensureObject(confidencePolicy, "contentEvidencePacket.deepResearchPlan.evidenceConfidencePolicy");
  ensureStringArray(
    confidencePolicy.sourceStates,
    "contentEvidencePacket.deepResearchPlan.evidenceConfidencePolicy.sourceStates",
  );
  ensureStringArray(
    confidencePolicy.downgradeReasons,
    "contentEvidencePacket.deepResearchPlan.evidenceConfidencePolicy.downgradeReasons",
  );
  ensureObject(packet.deepResearchPlan.decisionReadinessGate, "contentEvidencePacket.deepResearchPlan.decisionReadinessGate");
  ensureStringArray(
    packet.deepResearchPlan.decisionReadinessGate.requiredSignals,
    "contentEvidencePacket.deepResearchPlan.decisionReadinessGate.requiredSignals",
  );
  for (const field of [
    "localSourcesRead",
    "contentFindings",
    "capabilityEvidence",
    "sourceCategoryCoverage",
    "crossReferenceMatrix",
    "assumptionLedger",
    "decisionImpactMap",
    "iterationLog",
    "claimEvidenceCards",
  ]) {
    ensureArray(packet[field], `contentEvidencePacket.${field}`);
    ensure(
      packet[field].length >= 1,
      `contentEvidencePacket.${field} must contain decision-grade evidence before Thinking.`,
    );
  }
  const impactFields = policy.decisionImpactMapRequiredFields ?? [
    "finding",
    "impacts",
    "decisionChanged",
    "stageAffected",
  ];
  const allowedImpactStages = policy.decisionImpactStageEnum ?? [
    "Critical",
    "Fetch",
    "Thinking",
    "Execution",
    "Review",
  ];
  for (const [index, item] of packet.decisionImpactMap.entries()) {
    ensureObject(item, `contentEvidencePacket.decisionImpactMap[${index}]`);
    ensureFields(
      item,
      impactFields,
      `contentEvidencePacket.decisionImpactMap[${index}]`,
    );
    ensureString(
      item.finding,
      `contentEvidencePacket.decisionImpactMap[${index}].finding`,
    );
    ensure(
      evidenceRefResolves(artifact, item.finding),
      `contentEvidencePacket.decisionImpactMap[${index}].finding must resolve to an artifact evidence path, got: ${item.finding}`,
    );
    validateEvidenceRefArray(
      artifact,
      item.impacts,
      `contentEvidencePacket.decisionImpactMap[${index}].impacts`,
    );
    ensureString(
      item.decisionChanged,
      `contentEvidencePacket.decisionImpactMap[${index}].decisionChanged`,
    );
    ensure(
      !/none|n\/a|no impact|unchanged/i.test(item.decisionChanged),
      `contentEvidencePacket.decisionImpactMap[${index}].decisionChanged must explain how evidence changes routing, option, scope, owner, or review.`,
    );
    ensureEnum(
      item.stageAffected,
      allowedImpactStages,
      `contentEvidencePacket.decisionImpactMap[${index}].stageAffected`,
    );
  }
  const iterationPolicy = policy.iterationLogQualityGate ?? {};
  ensure(
    packet.iterationLog.length >= (iterationPolicy.minimumIterationLogEntries ?? 1),
    "contentEvidencePacket.iterationLog must record at least one retrieval or reasoning iteration.",
  );
  for (const [index, item] of packet.iterationLog.entries()) {
    const context = `contentEvidencePacket.iterationLog[${index}]`;
    ensureObject(item, context);
    ensureFields(
      item,
      iterationPolicy.requiredFields ?? [
        "iteration",
        "trigger",
        "queryOrAction",
        "observation",
        "gapClosed",
        "nextStepDecision",
        "stopCheck",
      ],
      context,
    );
    ensure(
      Number.isInteger(item.iteration) && item.iteration >= 1,
      `${context}.iteration must be a positive integer.`,
    );
    for (const field of ["trigger", "queryOrAction", "observation", "nextStepDecision", "stopCheck"]) {
      ensureString(item[field], `${context}.${field}`);
    }
    ensure(
      typeof item.gapClosed === "boolean" || typeof item.gapClosed === "string",
      `${context}.gapClosed must state whether the information gap was closed.`,
    );
    ensure(
      !/none|n\/a|no impact|unchanged/i.test(item.nextStepDecision),
      `${context}.nextStepDecision must explain whether to continue, stop, or update the route.`,
    );
  }
  const claimCardPolicy = policy.claimEvidenceCardQualityGate ?? {};
  ensure(
    packet.claimEvidenceCards.length >= (claimCardPolicy.minimumClaimEvidenceCards ?? 1),
    "contentEvidencePacket.claimEvidenceCards must include at least one claim evidence card.",
  );
  for (const [index, item] of packet.claimEvidenceCards.entries()) {
    const context = `contentEvidencePacket.claimEvidenceCards[${index}]`;
    ensureObject(item, context);
    ensureFields(
      item,
      claimCardPolicy.requiredFields ?? [
        "claim",
        "sourceRefs",
        "evidenceAnchor",
        "confidence",
        "counterevidence",
        "decisionImpact",
        "falsificationStatus",
      ],
      context,
    );
    for (const field of ["claim", "evidenceAnchor", "decisionImpact"]) {
      ensureString(item[field], `${context}.${field}`);
    }
    validateEvidenceRefArray(artifact, item.sourceRefs, `${context}.sourceRefs`);
    if (Array.isArray(item.counterevidence)) {
      ensure(
        item.counterevidence.length >= 1,
        `${context}.counterevidence must record what was checked or why none was found.`,
      );
      for (const [counterIndex, counter] of item.counterevidence.entries()) {
        ensureString(counter, `${context}.counterevidence[${counterIndex}]`);
      }
    } else {
      ensureString(item.counterevidence, `${context}.counterevidence`);
    }
    ensureEnum(
      item.confidence,
      claimCardPolicy.confidenceEnum ?? ["low", "moderate", "high"],
      `${context}.confidence`,
    );
    ensureEnum(
      item.falsificationStatus,
      claimCardPolicy.falsificationStatusEnum ?? [
        "tested_survived",
        "tested_refuted",
        "unverified",
        "blocked",
      ],
      `${context}.falsificationStatus`,
    );
    ensure(
      !/none|n\/a|no impact|unchanged/i.test(item.decisionImpact),
      `${context}.decisionImpact must state what the card changes for the decision.`,
    );
  }
  ensureArray(packet.contradictionLog, "contentEvidencePacket.contradictionLog");

  const discovery = packet.researchCapabilityDiscovery;
  const discoveryPolicy = policy.researchCapabilityDiscovery;
  ensureFields(
    discovery,
    discoveryPolicy.requiredFields,
    "contentEvidencePacket.researchCapabilityDiscovery",
  );

  for (const field of discoveryPolicy.forbiddenFields ?? []) {
    ensure(
      !(field in discovery),
      `contentEvidencePacket.researchCapabilityDiscovery must not include forbidden field "${field}".`,
    );
  }

  ensureStringArray(
    discovery.requiredCapabilities,
    "contentEvidencePacket.researchCapabilityDiscovery.requiredCapabilities",
  );
  ensure(
    discovery.requiredCapabilities.length >= 1,
    "contentEvidencePacket.researchCapabilityDiscovery.requiredCapabilities must name the information capability needed.",
  );
  ensureFields(
    discovery.runtimeContext,
    discoveryPolicy.runtimeContextRequiredFields,
    "contentEvidencePacket.researchCapabilityDiscovery.runtimeContext",
  );
  ensureString(
    discovery.runtimeContext.os,
    "contentEvidencePacket.researchCapabilityDiscovery.runtimeContext.os",
  );
  ensureString(
    discovery.runtimeContext.runtimeFamily,
    "contentEvidencePacket.researchCapabilityDiscovery.runtimeContext.runtimeFamily",
  );

  ensureArray(
    discovery.toolInventorySources,
    "contentEvidencePacket.researchCapabilityDiscovery.toolInventorySources",
  );
  for (const [index, source] of discovery.toolInventorySources.entries()) {
    ensureEnum(
      source,
      discoveryPolicy.toolInventorySourceEnum,
      `contentEvidencePacket.researchCapabilityDiscovery.toolInventorySources[${index}]`,
    );
  }
  ensure(
    discovery.toolInventorySources.length >= 1,
    "contentEvidencePacket.researchCapabilityDiscovery.toolInventorySources must prove where capability inventory was checked.",
  );

  ensureArray(
    discovery.availableRetrievalCapabilities,
    "contentEvidencePacket.researchCapabilityDiscovery.availableRetrievalCapabilities",
  );
  for (const [index, capability] of discovery.availableRetrievalCapabilities.entries()) {
    ensureObject(
      capability,
      `contentEvidencePacket.researchCapabilityDiscovery.availableRetrievalCapabilities[${index}]`,
    );
    ensureEnum(
      capability.capability,
      discoveryPolicy.retrievalCapabilityEnum,
      `contentEvidencePacket.researchCapabilityDiscovery.availableRetrievalCapabilities[${index}].capability`,
    );
    ensureEnum(
      capability.providerKind,
      discoveryPolicy.providerKindEnum,
      `contentEvidencePacket.researchCapabilityDiscovery.availableRetrievalCapabilities[${index}].providerKind`,
    );
    ensureEnum(
      capability.status,
      discoveryPolicy.statusEnum,
      `contentEvidencePacket.researchCapabilityDiscovery.availableRetrievalCapabilities[${index}].status`,
    );
    ensureString(
      capability.proof,
      `contentEvidencePacket.researchCapabilityDiscovery.availableRetrievalCapabilities[${index}].proof`,
    );
    ensureStringArray(
      capability.limitations,
      `contentEvidencePacket.researchCapabilityDiscovery.availableRetrievalCapabilities[${index}].limitations`,
    );
  }
  ensure(
    discovery.availableRetrievalCapabilities.length >= 1,
    "contentEvidencePacket.researchCapabilityDiscovery.availableRetrievalCapabilities must prove at least one retrieval path or blocker.",
  );

  ensureFields(
    discovery.selectedResearchPath,
    ["mode", "reason"],
    "contentEvidencePacket.researchCapabilityDiscovery.selectedResearchPath",
  );
  ensureEnum(
    discovery.selectedResearchPath.mode,
    discoveryPolicy.selectedResearchPathModeEnum,
    "contentEvidencePacket.researchCapabilityDiscovery.selectedResearchPath.mode",
  );
  ensureString(
    discovery.selectedResearchPath.reason,
    "contentEvidencePacket.researchCapabilityDiscovery.selectedResearchPath.reason",
  );
  const selectedMode = discovery.selectedResearchPath.mode;
  const availableCapabilities = discovery.availableRetrievalCapabilities.filter(
    (capability) => ["available", "partial"].includes(capability.status),
  );
  if (selectedMode === "local_only") {
    ensure(
      availableCapabilities.some((capability) => capability.capability === "local_only"),
      "contentEvidencePacket selectedResearchPath=local_only requires an available local_only capability proof.",
    );
  }
  if (["external_web", "mixed"].includes(selectedMode)) {
    ensure(
      availableCapabilities.some((capability) =>
        ["web_search", "url_fetch", "browser_open", "docs_lookup", "mcp_search", "plugin_search"].includes(
          capability.capability,
        ),
      ),
      `contentEvidencePacket selectedResearchPath=${selectedMode} requires available external retrieval capability proof.`,
    );
  }
  if (packet.researchRequired === true) {
    ensure(
      packet.researchSkipReason === "none",
      "contentEvidencePacket.researchRequired=true requires researchSkipReason=none.",
    );
    ensure(
      packet.sourceCategoryCoverage.length >= 5,
      "contentEvidencePacket researchRequired=true requires at least five source categories.",
    );
  } else {
    ensure(
      packet.researchSkipReason !== "none",
      "contentEvidencePacket researchRequired=false requires a concrete researchSkipReason.",
    );
  }

  ensureArray(
    discovery.capabilityGaps,
    "contentEvidencePacket.researchCapabilityDiscovery.capabilityGaps",
  );
  for (const [index, gap] of discovery.capabilityGaps.entries()) {
    ensureObject(gap, `contentEvidencePacket.researchCapabilityDiscovery.capabilityGaps[${index}]`);
    ensureString(gap.gap, `contentEvidencePacket.researchCapabilityDiscovery.capabilityGaps[${index}].gap`);
    ensureString(gap.impact, `contentEvidencePacket.researchCapabilityDiscovery.capabilityGaps[${index}].impact`);
    ensureString(gap.handoff, `contentEvidencePacket.researchCapabilityDiscovery.capabilityGaps[${index}].handoff`);
  }
  ensureString(
    discovery.validatedBy,
    "contentEvidencePacket.researchCapabilityDiscovery.validatedBy",
  );
}

function validateIntentPacketWhenRequired(contract, artifact) {
  const when =
    contract.runDiscipline.protocolFirst
      .intentPacketRequiredWhenGovernanceFlows;
  if (!Array.isArray(when) || when.length === 0) {
    return;
  }
  const flow = artifact.taskClassification?.governanceFlow;
  if (!when.includes(flow)) {
    return;
  }
  const intent = artifact.intentPacket;
  ensure(
    intent && typeof intent === "object",
    `intentPacket is required when governanceFlow is ${flow}.`,
  );
  ensureFields(
    intent,
    contract.protocols.intentPacket.requiredFields,
    "intentPacket",
  );
  for (const field of [
    "realIntent",
    "trueUserIntent",
    "successCriteria",
    "nonGoals",
    "noQuotaClarification",
  ]) {
    ensure(
      typeof intent[field] === "string" && intent[field].trim().length >= 1,
      `intentPacket.${field} must be a non-empty string.`,
    );
  }
  ensureStringArray(intent.blockingUnknowns, "intentPacket.blockingUnknowns");
  ensure(
    intent.intentPacketVersion === "v1",
    'intentPacket.intentPacketVersion must be "v1" for this contract revision.',
  );
}

function validateIntentGatePacketWhenRequired(contract, artifact) {
  const when =
    contract.runDiscipline.protocolFirst
      .intentGatePacketRequiredWhenGovernanceFlows;
  if (!Array.isArray(when) || when.length === 0) {
    return;
  }
  const flow = artifact.taskClassification?.governanceFlow;
  if (!when.includes(flow)) {
    return;
  }
  const gate = artifact.intentGatePacket;
  ensure(
    gate && typeof gate === "object",
    `intentGatePacket is required when governanceFlow is ${flow}.`,
  );
  ensureFields(
    gate,
    contract.protocols.intentGatePacket.requiredFields,
    "intentGatePacket",
  );
  ensure(
    typeof gate.ambiguitiesResolved === "boolean",
    "intentGatePacket.ambiguitiesResolved must be a boolean.",
  );
  ensure(
    typeof gate.requiresUserChoice === "boolean",
    "intentGatePacket.requiresUserChoice must be a boolean.",
  );
  ensure(
    Array.isArray(gate.defaultAssumptions),
    "intentGatePacket.defaultAssumptions must be an array.",
  );
  for (const [i, item] of gate.defaultAssumptions.entries()) {
    ensure(
      typeof item === "string" && item.trim().length >= 1,
      `intentGatePacket.defaultAssumptions[${i}] must be a non-empty string.`,
    );
  }
  ensure(
    gate.intentGatePacketVersion === "v1",
    'intentGatePacket.intentGatePacketVersion must be "v1" for this contract revision.',
  );
  if (gate.requiresUserChoice === true) {
    ensure(
      Array.isArray(gate.pendingUserChoices) &&
        gate.pendingUserChoices.length >= 1,
      "intentGatePacket.requiresUserChoice=true requires non-empty pendingUserChoices array.",
    );
    for (const [i, c] of gate.pendingUserChoices.entries()) {
      ensure(
        typeof c === "string" && c.trim().length >= 1,
        `intentGatePacket.pendingUserChoices[${i}] must be a non-empty string.`,
      );
    }
  }
}

function validatePreDecisionOptionFrame(contract, artifact) {
  const when =
    contract.runDiscipline.protocolFirst
      .preDecisionOptionFrameRequiredBeforeUserChoiceWhenGovernanceFlows ?? [];
  const flow = artifact.taskClassification?.governanceFlow;
  if (!when.includes(flow)) {
    return;
  }

  const packet = artifact.preDecisionOptionFrame;
  ensure(
    packet && typeof packet === "object",
    `preDecisionOptionFrame is required when governanceFlow is ${flow}.`,
  );
  const policy = contract.protocols.preDecisionOptionFrame;
  ensureFields(packet, policy.requiredFields, "preDecisionOptionFrame");
  ensure(
    packet.presentedBeforeDecision === true,
    "preDecisionOptionFrame.presentedBeforeDecision must be true.",
  );
  ensure(
    packet.builtFromContentEvidence === true,
    "preDecisionOptionFrame.builtFromContentEvidence must be true.",
  );
  ensureArray(
    packet.contentEvidenceRefs,
    "preDecisionOptionFrame.contentEvidenceRefs",
  );
  ensure(
    packet.contentEvidenceRefs.length >= 1,
    "preDecisionOptionFrame.contentEvidenceRefs must include at least one evidence reference.",
  );
  ensureArray(
    packet.unresolvedQuestions,
    "preDecisionOptionFrame.unresolvedQuestions",
  );
  const questionFields = policy.unresolvedQuestionRequiredFields ?? [
    "question",
    "questionTarget",
    "decisionImpact",
    "status",
  ];
  const questionTargets = policy.questionTargetEnum ?? [];
  const questionStatuses = policy.unresolvedQuestionStatusEnum ?? [
    "open",
    "answered",
    "skipped",
    "invalidated",
  ];
  const recommendationStates = policy.recommendationStateEnum ?? [
    "recommended",
    "preference_only",
    "insufficient_evidence",
  ];
  const questionIds = new Set();
  for (const [index, question] of packet.unresolvedQuestions.entries()) {
    ensureObject(
      question,
      `preDecisionOptionFrame.unresolvedQuestions[${index}]`,
    );
    ensureFields(
      question,
      questionFields,
      `preDecisionOptionFrame.unresolvedQuestions[${index}]`,
    );
    ensureString(
      question.questionId,
      `preDecisionOptionFrame.unresolvedQuestions[${index}].questionId`,
    );
    ensure(
      !questionIds.has(question.questionId),
      `preDecisionOptionFrame.unresolvedQuestions contains duplicate questionId ${question.questionId}.`,
    );
    questionIds.add(question.questionId);
    ensureString(
      question.question,
      `preDecisionOptionFrame.unresolvedQuestions[${index}].question`,
    );
    ensureEnum(
      question.questionTarget,
      questionTargets,
      `preDecisionOptionFrame.unresolvedQuestions[${index}].questionTarget`,
    );
    ensureString(
      question.decisionImpact,
      `preDecisionOptionFrame.unresolvedQuestions[${index}].decisionImpact`,
    );
    ensure(
      !/just curious|nice to know|quota|generic/i.test(question.decisionImpact),
      `preDecisionOptionFrame.unresolvedQuestions[${index}].decisionImpact must explain what execution, scope, risk, owner, or acceptance branch the answer changes.`,
    );
    ensure(
      questionStatuses.includes(question.status),
      `preDecisionOptionFrame.unresolvedQuestions[${index}].status must be ${questionStatuses.join(", ")}.`,
    );
    ensure(
      Number.isInteger(question.impactPriority) && question.impactPriority >= 1,
      `preDecisionOptionFrame.unresolvedQuestions[${index}].impactPriority must be a positive integer.`,
    );
    ensureStringArray(
      question.dependsOn,
      `preDecisionOptionFrame.unresolvedQuestions[${index}].dependsOn`,
    );
    ensureArray(
      question.evidenceRefs,
      `preDecisionOptionFrame.unresolvedQuestions[${index}].evidenceRefs`,
    );
    validateEvidenceRefArray(
      artifact,
      question.evidenceRefs,
      `preDecisionOptionFrame.unresolvedQuestions[${index}].evidenceRefs`,
    );
    ensureEnum(
      question.recommendationState,
      recommendationStates,
      `preDecisionOptionFrame.unresolvedQuestions[${index}].recommendationState`,
    );
    ensureString(
      question.recommendationRationale,
      `preDecisionOptionFrame.unresolvedQuestions[${index}].recommendationRationale`,
    );
    if (question.recommendationState === "recommended") {
      ensureString(
        question.recommendedAnswer,
        `preDecisionOptionFrame.unresolvedQuestions[${index}].recommendedAnswer`,
      );
    } else {
      ensure(
        question.recommendedAnswer === null || question.recommendedAnswer === "",
        `preDecisionOptionFrame.unresolvedQuestions[${index}].recommendedAnswer must be empty when recommendationState is not recommended.`,
      );
    }
    if (question.status === "answered") {
      ensureString(
        question.userAnswer,
        `preDecisionOptionFrame.unresolvedQuestions[${index}].userAnswer`,
      );
      validateEvidenceRefArray(
        artifact,
        question.answerEvidenceRefs,
        `preDecisionOptionFrame.unresolvedQuestions[${index}].answerEvidenceRefs`,
      );
    }
    if (question.status === "invalidated") {
      ensureString(
        question.invalidatedBy,
        `preDecisionOptionFrame.unresolvedQuestions[${index}].invalidatedBy`,
      );
      ensure(
        question.invalidatedBy === "user_requested_summary_stop" ||
          question.invalidatedBy.startsWith("answer:") ||
          packet.unresolvedQuestions.some(
            (candidate) => candidate.questionId === question.invalidatedBy,
          ),
        `preDecisionOptionFrame.unresolvedQuestions[${index}].invalidatedBy must be a producer-derived answer, stop control, or dependency reference.`,
      );
    }
  }
  for (const [index, question] of packet.unresolvedQuestions.entries()) {
    for (const dependencyId of question.dependsOn) {
      ensure(
        dependencyId !== question.questionId && questionIds.has(dependencyId),
        `preDecisionOptionFrame.unresolvedQuestions[${index}].dependsOn references an unknown or self dependency ${dependencyId}.`,
      );
    }
  }
  if (packet.planChallengeState != null) {
    const challenge = packet.planChallengeState;
    const challengePolicy = policy.planChallengeState ?? {};
    ensureObject(challenge, "preDecisionOptionFrame.planChallengeState");
    ensureFields(
      challenge,
      challengePolicy.requiredFields ?? [],
      "preDecisionOptionFrame.planChallengeState",
    );
    ensure(
      typeof challenge.active === "boolean",
      "preDecisionOptionFrame.planChallengeState.active must be a boolean.",
    );
    ensure(
      typeof challenge.planChallengeSatisfied === "boolean",
      "preDecisionOptionFrame.planChallengeState.planChallengeSatisfied must be a boolean.",
    );
    ensure(
      typeof challenge.authorizationRequired === "boolean",
      "preDecisionOptionFrame.planChallengeState.authorizationRequired must be a boolean.",
    );
    ensureStringArray(
      challenge.sideEffectActions,
      "preDecisionOptionFrame.planChallengeState.sideEffectActions",
    );
    ensure(
      new Set(challenge.sideEffectActions).size === challenge.sideEffectActions.length,
      "preDecisionOptionFrame.planChallengeState.sideEffectActions must not contain duplicates.",
    );
    ensure(
      typeof challenge.executionAllowed === "boolean",
      "preDecisionOptionFrame.planChallengeState.executionAllowed must be a boolean.",
    );
    ensureEnum(
      challenge.phase,
      challengePolicy.phaseEnum ?? [],
      "preDecisionOptionFrame.planChallengeState.phase",
    );
    ensureStringArray(
      challenge.triggerReasons,
      "preDecisionOptionFrame.planChallengeState.triggerReasons",
    );
    for (const reason of challenge.triggerReasons) {
      ensureEnum(
        reason,
        challengePolicy.triggerReasonEnum ?? [],
        "preDecisionOptionFrame.planChallengeState.triggerReasons[]",
      );
    }
    ensureObjectArray(
      challenge.triggerEvidence,
      "preDecisionOptionFrame.planChallengeState.triggerEvidence",
    );
    for (const [index, evidence] of challenge.triggerEvidence.entries()) {
      ensureFields(
        evidence,
        ["evidenceId", "kind", "source", "excerpt", "trusted", "binding"],
        `preDecisionOptionFrame.planChallengeState.triggerEvidence[${index}]`,
      );
      ensure(
        evidence.trusted === true,
        `preDecisionOptionFrame.planChallengeState.triggerEvidence[${index}] must be trusted producer evidence.`,
      );
    }
    ensureArray(
      challenge.triggerEvidenceRefs,
      "preDecisionOptionFrame.planChallengeState.triggerEvidenceRefs",
    );
    if (challenge.active) {
      validateEvidenceRefArray(
        artifact,
        challenge.triggerEvidenceRefs,
        "preDecisionOptionFrame.planChallengeState.triggerEvidenceRefs",
      );
    } else {
      ensure(
        challenge.triggerEvidenceRefs.length === 0 && challenge.triggerEvidence.length === 0,
        "inactive plan challenge must not claim trigger evidence.",
      );
    }
    ensureObjectArray(
      challenge.decisionEvidence,
      "preDecisionOptionFrame.planChallengeState.decisionEvidence",
    );
    for (const [index, evidence] of challenge.decisionEvidence.entries()) {
      ensureFields(
        evidence,
        ["evidenceId", "kind", "binding", "sourceRefs", "sequence", "historical", "trusted"],
        `preDecisionOptionFrame.planChallengeState.decisionEvidence[${index}]`,
      );
      ensure(
        evidence.trusted === false,
        `preDecisionOptionFrame.planChallengeState.decisionEvidence[${index}] is planning evidence and must remain non-authorizing.`,
      );
      ensureString(
        evidence.binding,
        `preDecisionOptionFrame.planChallengeState.decisionEvidence[${index}].binding`,
      );
      ensureStringArray(
        evidence.sourceRefs,
        `preDecisionOptionFrame.planChallengeState.decisionEvidence[${index}].sourceRefs`,
      );
      ensure(
        evidence.sourceRefs.length >= 1,
        `preDecisionOptionFrame.planChallengeState.decisionEvidence[${index}].sourceRefs must not be empty.`,
      );
      if (evidence.kind === "question_response") {
        ensure(
          Number.isInteger(evidence.sequence) && evidence.sequence >= 1,
          `preDecisionOptionFrame.planChallengeState.decisionEvidence[${index}].sequence must record selected-question order.`,
        );
        ensure(
          typeof evidence.historical === "boolean",
          `preDecisionOptionFrame.planChallengeState.decisionEvidence[${index}].historical must identify replayed history versus the current answer.`,
        );
      }
    }
    const decisionEvidenceIds = challenge.decisionEvidence.map((item) => item.evidenceId);
    const questionResponseEvidence = challenge.decisionEvidence.filter(
      (item) => item.kind === "question_response",
    );
    const questionResponseSequences = questionResponseEvidence.map((item) => item.sequence);
    ensure(
      new Set(decisionEvidenceIds).size === decisionEvidenceIds.length,
      "plan challenge decision evidence ids must be unique.",
    );
    ensure(
      new Set(questionResponseSequences).size === questionResponseSequences.length,
      "plan challenge question response sequences must be unique.",
    );
    ensure(
      questionResponseEvidence.filter((item) => item.historical === false).length <= 1,
      "plan challenge may record at most one current-run question response.",
    );
    for (const [index, question] of packet.unresolvedQuestions.entries()) {
      if (!["answered", "skipped"].includes(question.status)) continue;
      ensureArray(
        question.answerEvidenceRefs,
        `preDecisionOptionFrame.unresolvedQuestions[${index}].answerEvidenceRefs`,
      );
      ensure(
        question.answerEvidenceRefs.length > 0,
        `preDecisionOptionFrame.unresolvedQuestions[${index}] closed by user decision must retain evidence.`,
      );
      validateEvidenceRefArray(
        artifact,
        question.answerEvidenceRefs,
        `preDecisionOptionFrame.unresolvedQuestions[${index}].answerEvidenceRefs`,
      );
      const expectedResponseBinding = `plan-challenge-response:${question.questionId}`;
      ensure(
        question.answerEvidenceRefs.some((ref) => {
          const evidence = getPathValue(artifact, ref);
          return (
            (evidence?.kind === "question_response" &&
              evidence.binding === expectedResponseBinding) ||
            (ref === "preDecisionOptionFrame.planChallengeState.controlEvidence" &&
              evidence?.trusted === true &&
              ["accept_recommendation", "skip"].includes(evidence.action))
          );
        }),
        `preDecisionOptionFrame.unresolvedQuestions[${index}] answer evidence must bind to its question or trusted question control.`,
      );
    }
    ensure(
      typeof challenge.sharedUnderstandingConfirmed === "boolean",
      "preDecisionOptionFrame.planChallengeState.sharedUnderstandingConfirmed must be a boolean.",
    );
    ensureStringArray(
      challenge.sharedUnderstandingEvidenceRefs,
      "preDecisionOptionFrame.planChallengeState.sharedUnderstandingEvidenceRefs",
    );
    if (challenge.sharedUnderstandingConfirmed) {
      validateEvidenceRefArray(
        artifact,
        challenge.sharedUnderstandingEvidenceRefs,
        "preDecisionOptionFrame.planChallengeState.sharedUnderstandingEvidenceRefs",
      );
      ensure(
        challenge.sharedUnderstandingEvidenceRefs.every(
          (ref) =>
            getPathValue(artifact, ref)?.kind === "shared_understanding_confirmation" &&
            getPathValue(artifact, ref)?.binding === "plan-challenge-understanding-confirmation",
        ),
        "shared understanding evidence must be trusted and bound to plan-challenge-understanding-confirmation.",
      );
    } else {
      ensure(
        challenge.sharedUnderstandingEvidenceRefs.length === 0,
        "unconfirmed shared understanding must not claim evidence refs.",
      );
    }
    ensureObject(
      challenge.executionAuthorization,
      "preDecisionOptionFrame.planChallengeState.executionAuthorization",
    );
    ensureFields(
      challenge.executionAuthorization,
      challengePolicy.executionAuthorizationRequiredFields ?? [],
      "preDecisionOptionFrame.planChallengeState.executionAuthorization",
    );
    ensureEnum(
      challenge.executionAuthorization.state,
      challengePolicy.executionAuthorizationStateEnum ?? [],
      "preDecisionOptionFrame.planChallengeState.executionAuthorization.state",
    );
    ensureString(
      challenge.executionAuthorization.source,
      "preDecisionOptionFrame.planChallengeState.executionAuthorization.source",
    );
    ensureString(
      challenge.executionAuthorization.scope,
      "preDecisionOptionFrame.planChallengeState.executionAuthorization.scope",
    );
    ensureStringArray(
      challenge.executionAuthorization.scopeActions,
      "preDecisionOptionFrame.planChallengeState.executionAuthorization.scopeActions",
    );
    ensure(
      typeof challenge.executionAuthorization.trusted === "boolean",
      "preDecisionOptionFrame.planChallengeState.executionAuthorization.trusted must be a boolean.",
    );
    ensureString(
      challenge.executionAuthorization.binding,
      "preDecisionOptionFrame.planChallengeState.executionAuthorization.binding",
    );
    ensureStringArray(
      challenge.executionAuthorization.evidenceRefs,
      "preDecisionOptionFrame.planChallengeState.executionAuthorization.evidenceRefs",
    );
    ensure(
      typeof challenge.executionAuthorization.scopeCoversActions === "boolean",
      "preDecisionOptionFrame.planChallengeState.executionAuthorization.scopeCoversActions must be a boolean.",
    );
    const expectedAuthorizationBinding = planChallengeAuthorizationBinding(
      challenge.sideEffectActions,
    );
    ensure(
      challenge.executionAuthorization.binding === expectedAuthorizationBinding,
      "preDecisionOptionFrame.planChallengeState.executionAuthorization.binding must match the current side-effect action set.",
    );
    const scopeCoversActions = challenge.sideEffectActions.every((action) =>
      challenge.executionAuthorization.scopeActions.includes(action),
    );
    ensure(
      challenge.executionAuthorization.scopeCoversActions === scopeCoversActions,
      "preDecisionOptionFrame.planChallengeState.executionAuthorization.scopeCoversActions must match concrete action coverage.",
    );
    if (["authorized", "denied"].includes(challenge.executionAuthorization.state)) {
      ensure(
        challenge.executionAuthorization.trusted === true,
        "authorized or denied executionAuthorization must be trusted.",
      );
      validateEvidenceRefArray(
        artifact,
        challenge.executionAuthorization.evidenceRefs,
        "preDecisionOptionFrame.planChallengeState.executionAuthorization.evidenceRefs",
      );
      ensure(
        challenge.executionAuthorization.evidenceRefs.every(
          (ref) =>
            getPathValue(artifact, ref)?.kind === "execution_authorization" &&
            getPathValue(artifact, ref)?.binding === expectedAuthorizationBinding,
        ),
        "execution authorization evidence must be bound to the current side-effect action set.",
      );
    }
    ensure(
      challenge.executionAuthorization.state !== "authorized",
      "pre-host artifacts cannot claim authorized executionAuthorization.",
    );
    ensureObject(
      challenge.pendingUserChoice,
      "preDecisionOptionFrame.planChallengeState.pendingUserChoice",
    );
    ensureEnum(
      challenge.pendingUserChoice.status,
      ["required_not_invoked", "not_required"],
      "preDecisionOptionFrame.planChallengeState.pendingUserChoice.status",
    );
    ensureArray(
      challenge.pendingUserChoice.controls,
      "preDecisionOptionFrame.planChallengeState.pendingUserChoice.controls",
    );
    ensureString(challenge.chatSummaryRef, "preDecisionOptionFrame.planChallengeState.chatSummaryRef");
    ensure(
      challenge.chatSummaryRef === "summaryPacket",
      "preDecisionOptionFrame.planChallengeState.chatSummaryRef must reference summaryPacket.",
    );
    ensure(
      challenge.active === (challenge.triggerReasons.length > 0),
      "preDecisionOptionFrame.planChallengeState.active must match whether a trigger reason exists.",
    );
    ensure(
      challenge.authorizationRequired ===
        (challenge.active && challenge.sideEffectActions.length > 0),
      "preDecisionOptionFrame.planChallengeState.authorizationRequired must match active concrete side effects.",
    );
    const eligibleOpen = packet.unresolvedQuestions
      .filter(
        (question) =>
          question.status === "open" &&
          question.dependsOn.every(
            (dependencyId) =>
              packet.unresolvedQuestions.find((candidate) => candidate.questionId === dependencyId)?.status === "answered",
          ),
      )
      .sort(
        (left, right) =>
          right.impactPriority - left.impactPriority ||
          left.questionId.localeCompare(right.questionId),
      );
    ensure(
      challenge.selectedQuestionId === (eligibleOpen[0]?.questionId ?? null),
      "preDecisionOptionFrame.planChallengeState.selectedQuestionId must be the single highest-impact eligible open question.",
    );
    const awaitingUserInput = [
      "awaiting_user_answer",
      "awaiting_understanding_confirmation",
      "awaiting_execution_authorization",
    ].includes(challenge.phase);
    ensure(
      challenge.pendingUserChoice.status ===
        (awaitingUserInput ? "required_not_invoked" : "not_required"),
      "preDecisionOptionFrame.planChallengeState.pendingUserChoice.status must match the current phase.",
    );
    if (awaitingUserInput) {
      ensureObject(
        challenge.pendingUserChoice.question,
        "preDecisionOptionFrame.planChallengeState.pendingUserChoice.question",
      );
      ensureString(
        challenge.pendingUserChoice.question.binding,
        "preDecisionOptionFrame.planChallengeState.pendingUserChoice.question.binding",
      );
      ensureString(
        challenge.pendingUserChoice.question.displayText,
        "preDecisionOptionFrame.planChallengeState.pendingUserChoice.question.displayText",
      );
      ensure(
        challenge.pendingUserChoice.controls.length >= 1,
        "preDecisionOptionFrame.planChallengeState.pendingUserChoice.controls must expose user actions while input is pending.",
      );
    } else {
      ensure(
        challenge.pendingUserChoice.question === null,
        "preDecisionOptionFrame.planChallengeState.pendingUserChoice.question must be null when no user choice is pending.",
      );
      ensure(
        challenge.pendingUserChoice.controls.length === 0,
        "preDecisionOptionFrame.planChallengeState.pendingUserChoice.controls must be empty when no choice is pending.",
      );
    }
    ensure(
      challenge.executionAllowed === false,
      "preDecisionOptionFrame.planChallengeState.executionAllowed must remain false before host-native execution occurs.",
    );
    ensure(
      challenge.phase !== "ready_for_execution",
      "pre-host artifacts cannot claim ready_for_execution; use planChallengeSatisfied for non-authorizing plan closure.",
    );
    if (!challenge.active) {
      ensure(
        challenge.phase === "inactive" &&
          challenge.authorizationRequired === false &&
          challenge.executionAuthorization.state === "not_required",
        "inactive plan challenge must preserve the low-risk path without an authorization gate.",
      );
    }
    if (challenge.phase === "plan_challenge_satisfied") {
      ensure(
        challenge.selectedQuestionId === null &&
          packet.unresolvedQuestions.every((question) => question.status !== "open"),
        "plan_challenge_satisfied requires every challenge question to be closed and no selected question.",
      );
      ensure(
        challenge.sharedUnderstandingConfirmed === true,
        "plan_challenge_satisfied requires shared understanding confirmation.",
      );
      ensure(
        challenge.planChallengeSatisfied === true,
        "plan_challenge_satisfied phase requires planChallengeSatisfied=true.",
      );
    }
    ensure(
      challenge.planChallengeSatisfied === (challenge.phase === "plan_challenge_satisfied"),
      "planChallengeSatisfied must match the non-authorizing plan_challenge_satisfied phase.",
    );
    if (challenge.executionAuthorization.state === "denied") {
      ensure(
        challenge.phase === "execution_denied" &&
          challenge.executionAllowed === false &&
          challenge.pendingUserChoice.status === "not_required",
        "denied execution authorization must be terminal and must not ask again.",
      );
    }
    if (challenge.active) {
      ensure(
        challenge.executionAllowed === false && artifact.status !== "pass",
        "active non-ready plan challenge must block execution and prevent a pass artifact.",
      );
      ensure(
        artifact.wardenWritebackFlow?.status !== "approved-for-writeback",
        "active non-ready plan challenge must block canonical writeback.",
      );
      ensure(
        Number(artifact.projectCustomizationPacket?.execution?.appliedCount ?? 0) === 0,
        "active non-ready plan challenge must block project capability writes.",
      );
      ensure(
        artifact.coreLoop?.executionResult?.executionAllowed === false &&
          artifact.coreLoop?.executionResult?.executionGate === "blocked_by_plan_challenge",
        "active non-ready plan challenge must be represented as blocked in the core Execution result.",
      );
    }
    if (
      challenge.sharedUnderstandingConfirmed === true &&
      challenge.authorizationRequired === true &&
      !["authorized", "denied"].includes(challenge.executionAuthorization.state)
    ) {
      ensure(
        challenge.phase === "plan_challenge_satisfied",
        "shared understanding may satisfy the plan challenge but must not authorize host execution.",
      );
    }
    const summaryFields = challengePolicy.summaryRequiredFields ?? [];
    ensureFields(artifact.summaryPacket, summaryFields, "summaryPacket");
    ensureArray(artifact.summaryPacket.confirmedDecisions, "summaryPacket.confirmedDecisions");
    ensureArray(artifact.summaryPacket.openRisks, "summaryPacket.openRisks");
    ensureString(artifact.summaryPacket.nextStep, "summaryPacket.nextStep");
  }
  ensureArray(packet.candidateOptions, "preDecisionOptionFrame.candidateOptions");
  ensure(
    packet.candidateOptions.length >= 2,
    "preDecisionOptionFrame.candidateOptions must include at least two candidate solution paths.",
  );
  for (const [index, option] of packet.candidateOptions.entries()) {
    ensureObject(option, `preDecisionOptionFrame.candidateOptions[${index}]`);
    ensureFields(
      option,
      policy.candidateOptionRequiredFields,
      `preDecisionOptionFrame.candidateOptions[${index}]`,
    );
    ensureArray(
      option.candidateOwners,
      `preDecisionOptionFrame.candidateOptions[${index}].candidateOwners`,
    );
    ensure(
      option.candidateOwners.length >= 1,
      `preDecisionOptionFrame.candidateOptions[${index}].candidateOwners must not be empty.`,
    );
    ensureString(
      option.candidateTaskShape,
      `preDecisionOptionFrame.candidateOptions[${index}].candidateTaskShape`,
    );
    validateEvidenceRefArray(
      artifact,
      option.evidenceRefs,
      `preDecisionOptionFrame.candidateOptions[${index}].evidenceRefs`,
    );
    ensureString(
      option.decisionImpact,
      `preDecisionOptionFrame.candidateOptions[${index}].decisionImpact`,
    );
  }
  ensure(
    typeof packet.requiresUserChoice === "boolean",
    "preDecisionOptionFrame.requiresUserChoice must be a boolean.",
  );
  const allowedSkips = policy.choiceGateSkipAllowedWhen ?? [];
  if (packet.choiceGateSkip !== null && packet.choiceGateSkip !== undefined) {
    ensureEnum(
      packet.choiceGateSkip,
      allowedSkips,
      "preDecisionOptionFrame.choiceGateSkip",
    );
    ensureString(packet.skipSource, "preDecisionOptionFrame.skipSource");
    ensureString(
      packet.skipSafetyRationale,
      "preDecisionOptionFrame.skipSafetyRationale",
    );
    ensure(
      !/fallback/i.test(packet.skipSafetyRationale),
      "preDecisionOptionFrame.skipSafetyRationale must justify why the choice is safe, not cite fallback as the reason.",
    );
  }
  ensureString(
    packet.solutionChoiceState,
    "preDecisionOptionFrame.solutionChoiceState",
  );
  ensureEnum(
    packet.solutionChoiceState,
    policy.solutionChoiceStateEnum ?? ["confirmed", ...allowedSkips],
    "preDecisionOptionFrame.solutionChoiceState",
  );
  if (allowedSkips.includes(packet.solutionChoiceState)) {
    ensure(
      packet.choiceGateSkip === packet.solutionChoiceState,
      "preDecisionOptionFrame.solutionChoiceState must match choiceGateSkip when confirmation is skipped.",
    );
  }
  if (packet.requiresUserChoice === true) {
    ensure(
      packet.solutionChoiceState === "pending_user_choice",
      "preDecisionOptionFrame.solutionChoiceState must remain pending_user_choice while a host choice is required.",
    );
    ensure(
      packet.choiceGateSkip === null || packet.choiceGateSkip === undefined,
      "preDecisionOptionFrame.choiceGateSkip must be empty when user choice is required.",
    );
    ensure(
      packet.skipSource === "pending_host_adapter",
      "preDecisionOptionFrame.skipSource must record pending_host_adapter while the choice has not been invoked.",
    );
  }
  if (packet.solutionChoiceState === "confirmed") {
    ensure(
      packet.userChoiceState === "confirmed",
      "preDecisionOptionFrame.userChoiceState must be confirmed when solutionChoiceState is confirmed.",
    );
  } else {
    ensure(
      packet.userChoiceState === packet.solutionChoiceState,
      "preDecisionOptionFrame.userChoiceState must match solutionChoiceState for skip-based confirmation.",
    );
  }
}

function validateFinalizedChoiceState(artifact, packet, context) {
  const frame = artifact.preDecisionOptionFrame;
  if (!frame) return;
  ensureString(packet.preDecisionOptionFrameRef, `${context}.preDecisionOptionFrameRef`);
  ensure(
    packet.preDecisionOptionFrameRef === "preDecisionOptionFrame",
    `${context}.preDecisionOptionFrameRef must point to preDecisionOptionFrame.`,
  );
  ensureString(packet.userChoiceState, `${context}.userChoiceState`);
  ensure(
    packet.userChoiceState === frame.solutionChoiceState,
    `${context}.userChoiceState must match preDecisionOptionFrame.solutionChoiceState.`,
  );
  ensureString(packet.finalizationGate, `${context}.finalizationGate`);
  ensure(
    !/pending|before/i.test(packet.finalizationGate),
    `${context}.finalizationGate must show dispatch was finalized after user choice or an allowed skip.`,
  );
}

function validateDispatchEnvelope(contract, artifact) {
  const when =
    contract.runDiscipline.protocolFirst
      .dispatchEnvelopePacketRequiredWhenGovernanceFlows ?? [];
  const flow = artifact.taskClassification?.governanceFlow;
  if (!when.includes(flow)) {
    return;
  }

  const packet = artifact.dispatchEnvelopePacket;
  ensure(
    packet && typeof packet === "object",
    `dispatchEnvelopePacket is required when governanceFlow is ${flow}.`,
  );
  ensureFields(
    packet,
    contract.protocols.dispatchEnvelopePacket.requiredFields,
    "dispatchEnvelopePacket",
  );
  ensureString(packet.ownerAgent, "dispatchEnvelopePacket.ownerAgent");
  ensureDurableOwner(contract, artifact, packet.ownerAgent, "dispatchEnvelopePacket.ownerAgent");
  ensureString(packet.businessRoleId, "dispatchEnvelopePacket.businessRoleId");
  ensureString(packet.roleDisplayName, "dispatchEnvelopePacket.roleDisplayName");
  validateRoleDisplayName(
    packet.roleDisplayName,
    "dispatchEnvelopePacket.roleDisplayName",
  );
  ensureString(packet.roleInstanceId, "dispatchEnvelopePacket.roleInstanceId");
  validateFinalizedChoiceState(artifact, packet, "dispatchEnvelopePacket");
  ensureString(packet.taskRef, "dispatchEnvelopePacket.taskRef");
  ensureStringArray(
    packet.allowedCapabilities,
    "dispatchEnvelopePacket.allowedCapabilities",
  );
  ensureStringArray(
    packet.blockedCapabilities,
    "dispatchEnvelopePacket.blockedCapabilities",
  );
  ensureEnum(
    packet.route,
    contract.protocols.dispatchEnvelopePacket.routeEnum,
    "dispatchEnvelopePacket.route",
  );
  ensureEnum(
    packet.ownerSelection,
    contract.protocols.dispatchEnvelopePacket.ownerSelectionEnum,
    "dispatchEnvelopePacket.ownerSelection",
  );
  ensure(
    packet.allowedCapabilities.length >= 1,
    "dispatchEnvelopePacket.allowedCapabilities must contain at least one capability.",
  );
  ensureEnum(
    packet.memoryMode,
    contract.protocols.dispatchEnvelopePacket.memoryModeEnum,
    "dispatchEnvelopePacket.memoryMode",
  );
  ensureString(packet.workspaceHint, "dispatchEnvelopePacket.workspaceHint");
  ensureString(
    packet.resultSchemaRef,
    "dispatchEnvelopePacket.resultSchemaRef",
  );
  ensureString(packet.reviewOwner, "dispatchEnvelopePacket.reviewOwner");
  ensureGovernanceOwner(contract, packet.reviewOwner, "dispatchEnvelopePacket.reviewOwner");
  ensureString(
    packet.verificationOwner,
    "dispatchEnvelopePacket.verificationOwner",
  );
  ensureGovernanceOwner(contract, packet.verificationOwner, "dispatchEnvelopePacket.verificationOwner");

  const overlaps = packet.allowedCapabilities.filter((capability) =>
    packet.blockedCapabilities.includes(capability),
  );
  ensure(
    overlaps.length === 0,
    `dispatchEnvelopePacket capability boundary overlaps are forbidden: ${overlaps.join(", ")}`,
  );

  if (artifact.taskClassification?.queryScope === "current_project") {
    ensure(
      packet.route === "project_only",
      "current_project runs must use dispatchEnvelopePacket.route=project_only.",
    );
    ensure(
      packet.memoryMode === "project_only",
      "current_project runs must use dispatchEnvelopePacket.memoryMode=project_only.",
    );
  }

  if (artifact.taskClassification?.queryScope === "all_projects") {
    ensure(
      packet.route === "cross_project",
      "all_projects runs must use dispatchEnvelopePacket.route=cross_project.",
    );
    ensure(
      packet.memoryMode === "cross_project_readonly",
      "all_projects runs must use dispatchEnvelopePacket.memoryMode=cross_project_readonly.",
    );
  }
}

function validateDispatchBoard(contract, artifact) {
  const packet = artifact.dispatchBoard;
  ensureFields(
    packet,
    contract.protocols.dispatchBoard.requiredFields,
    "dispatchBoard",
  );
  for (const field of contract.protocols.dispatchBoard.requiredFields) {
    ensureString(packet[field], `dispatchBoard.${field}`);
  }
  ensure(
    packet.primaryDeliverable === artifact.runHeader.primaryDeliverable,
    "dispatchBoard.primaryDeliverable must match runHeader.primaryDeliverable.",
  );
  if (artifact.orchestrationTaskBoardPacket) {
    ensure(
      packet.boardId === artifact.orchestrationTaskBoardPacket.dispatchBoardId,
      "dispatchBoard.boardId must match orchestrationTaskBoardPacket.dispatchBoardId.",
    );
  }
}

function validateOrchestrationTaskBoard(contract, artifact) {
  const when =
    contract.runDiscipline.protocolFirst
      .orchestrationTaskBoardPacketRequiredWhenGovernanceFlows ?? [];
  const flow = artifact.taskClassification?.governanceFlow;
  if (!when.includes(flow)) {
    return;
  }

  const packet = artifact.orchestrationTaskBoardPacket;
  ensure(
    packet && typeof packet === "object",
    `orchestrationTaskBoardPacket is required when governanceFlow is ${flow}.`,
  );
  ensureFields(
    packet,
    contract.protocols.orchestrationTaskBoardPacket.requiredFields,
    "orchestrationTaskBoardPacket",
  );
  ensure(
    packet.dispatchBoardId === artifact.dispatchBoard?.boardId,
    "orchestrationTaskBoardPacket.dispatchBoardId must match dispatchBoard.boardId.",
  );
  ensureEnum(
    packet.boardMode,
    contract.protocols.orchestrationTaskBoardPacket.boardModeEnum,
    "orchestrationTaskBoardPacket.boardMode",
  );
  ensureArray(packet.tasks, "orchestrationTaskBoardPacket.tasks");
  ensure(
    packet.tasks.length >= 1,
    "orchestrationTaskBoardPacket.tasks must contain at least one task.",
  );
  ensureString(
    packet.synthesisOwner,
    "orchestrationTaskBoardPacket.synthesisOwner",
  );
  ensureGovernanceOwner(contract, packet.synthesisOwner, "orchestrationTaskBoardPacket.synthesisOwner");

  const taskIds = new Set();
  const sequences = new Set();
  let hasFactoryTask = false;
  for (const [index, task] of packet.tasks.entries()) {
    ensureFields(
      task,
      contract.protocols.orchestrationTask.requiredFields,
      `orchestrationTaskBoardPacket.tasks[${index}]`,
    );
    ensure(!taskIds.has(task.taskId), `Duplicate orchestration taskId: ${task.taskId}`);
    taskIds.add(task.taskId);
    ensureEnum(
      task.taskKind,
      contract.protocols.orchestrationTask.taskKindEnum,
      `orchestrationTaskBoardPacket.tasks[${index}].taskKind`,
    );
    ensureString(
      task.owner,
      `orchestrationTaskBoardPacket.tasks[${index}].owner`,
    );
    ensureDurableOwner(
      contract,
      artifact,
      task.owner,
      `orchestrationTaskBoardPacket.tasks[${index}].owner`,
    );
    ensureString(
      task.businessRoleId,
      `orchestrationTaskBoardPacket.tasks[${index}].businessRoleId`,
    );
    ensureString(
      task.roleDisplayName,
      `orchestrationTaskBoardPacket.tasks[${index}].roleDisplayName`,
    );
    validateRoleDisplayName(
      task.roleDisplayName,
      `orchestrationTaskBoardPacket.tasks[${index}].roleDisplayName`,
    );
    ensure(
      Number.isInteger(task.sequence) && task.sequence >= 1,
      `orchestrationTaskBoardPacket.tasks[${index}].sequence must be a positive integer.`,
    );
    ensure(
      !sequences.has(task.sequence),
      `Duplicate orchestration sequence: ${task.sequence}`,
    );
    sequences.add(task.sequence);
    ensureArray(
      task.dependsOn,
      `orchestrationTaskBoardPacket.tasks[${index}].dependsOn`,
    );
    ensureString(
      task.deliverable,
      `orchestrationTaskBoardPacket.tasks[${index}].deliverable`,
    );
    if (task.taskKind !== "execution") {
      hasFactoryTask = true;
    }
  }

  const dependenciesByTaskId = new Map();
  for (const [index, task] of packet.tasks.entries()) {
    dependenciesByTaskId.set(task.taskId, []);
    for (const [depIndex, dep] of task.dependsOn.entries()) {
      ensureString(
        dep,
        `orchestrationTaskBoardPacket.tasks[${index}].dependsOn[${depIndex}]`,
      );
      ensure(
        taskIds.has(dep),
        `orchestrationTaskBoardPacket task ${task.taskId} depends on unknown taskId ${dep}.`,
      );
      dependenciesByTaskId.get(task.taskId).push(dep);
    }
  }
  ensureAcyclicDependencyGraph(
    dependenciesByTaskId,
    "orchestrationTaskBoardPacket.tasks",
  );

  if (packet.boardMode === "factory_then_dispatch") {
    ensure(
      hasFactoryTask,
      "orchestrationTaskBoardPacket.boardMode=factory_then_dispatch requires at least one factory task.",
    );
  }
  if (packet.boardMode === "direct_dispatch") {
    ensure(
      hasFactoryTask === false,
      "orchestrationTaskBoardPacket.boardMode=direct_dispatch may not include factory tasks.",
    );
  }
}

function validateBusinessFlowBlueprint(contract, artifact) {
  const flow = artifact.businessFlowBlueprintPacket;
  const policy = contract.protocols.businessFlowBlueprintPacket;
  const capabilityPolicy = contract.protocols.agentBlueprintPacket;
  ensureFields(
    flow,
    policy.requiredFields,
    "businessFlowBlueprintPacket",
  );
  ensureEnum(
    flow.deliverableType,
    policy.deliverableTypeEnum,
    "businessFlowBlueprintPacket.deliverableType",
  );
  ensureArray(flow.requiredLanes, "businessFlowBlueprintPacket.requiredLanes");
  ensureArray(flow.optionalLanes, "businessFlowBlueprintPacket.optionalLanes");
  ensureArray(flow.omittedLanes, "businessFlowBlueprintPacket.omittedLanes");

  const requiredLaneIds = new Set();
  const optionalLaneIds = new Set();
  const omittedLaneIds = new Set();

  const validateLane = (lane, context, bucket) => {
    ensureObject(lane, context);
    ensureFields(lane, policy.laneRequiredFields, context);
    for (const field of policy.laneRequiredFields) {
      if (field === "candidateOwners") {
        ensureStringArray(lane[field], `${context}.${field}`);
        ensure(
          lane[field].length >= 1,
          `${context}.${field} must include at least one global capability scan candidate.`,
        );
        for (const [ownerIndex, owner] of lane[field].entries()) {
          ensureDurableOwner(
            contract,
            artifact,
            owner,
            `${context}.candidateOwners[${ownerIndex}]`,
          );
        }
      } else if (field === "matchedCapabilities") {
        validateMatchedCapabilities(
          capabilityPolicy,
          lane[field],
          `${context}.${field}`,
        );
      } else if (field === "capabilityBindings") {
        validateCapabilityBindings(
          capabilityPolicy,
          lane[field],
          `${context}.${field}`,
        );
      } else {
        ensureString(lane[field], `${context}.${field}`);
      }
    }
    for (const [capabilityIndex, capability] of lane.matchedCapabilities.entries()) {
      const hasBinding = lane.capabilityBindings.some(
        (binding) =>
          binding.capabilitySlot === capability.capabilitySlot &&
          binding.bindingType === capability.bindingType &&
          binding.bindingRef === capability.bindingRef,
      );
      ensure(
        hasBinding,
        `${context}.matchedCapabilities[${capabilityIndex}] must have a matching capabilityBindings entry with the same capabilitySlot, bindingType, and bindingRef.`,
      );
    }
    ensureDurableOwner(contract, artifact, lane.selectedOwner, `${context}.selectedOwner`);
    ensureEnum(
      lane.coverageStatus,
      policy.laneCoverageStatusEnum,
      `${context}.coverageStatus`,
    );
    ensure(
      lane.coverageStatus !== "omitted_with_reason",
      `${context}.coverageStatus must not be omitted_with_reason; use omittedLanes for omitted lanes.`,
    );
    bucket.add(lane.laneId);
  };

  for (const [index, lane] of flow.requiredLanes.entries()) {
    validateLane(
      lane,
      `businessFlowBlueprintPacket.requiredLanes[${index}]`,
      requiredLaneIds,
    );
  }
  for (const [index, lane] of flow.optionalLanes.entries()) {
    validateLane(
      lane,
      `businessFlowBlueprintPacket.optionalLanes[${index}]`,
      optionalLaneIds,
    );
  }

  for (const [index, lane] of flow.omittedLanes.entries()) {
    ensureObject(lane, `businessFlowBlueprintPacket.omittedLanes[${index}]`);
    const laneId = lane.laneId ?? lane.lane;
    ensureString(laneId, `businessFlowBlueprintPacket.omittedLanes[${index}].lane`);
    ensureString(
      lane.reason,
      `businessFlowBlueprintPacket.omittedLanes[${index}].reason`,
    );
    ensure(
      lane.coverageStatus === "omitted_with_reason",
      `businessFlowBlueprintPacket.omittedLanes[${index}].coverageStatus must be omitted_with_reason.`,
    );
    omittedLaneIds.add(laneId);
  }
  ensureArray(flow.laneDependencies, "businessFlowBlueprintPacket.laneDependencies");
  ensureEnum(
    flow.coverageJudgment,
    policy.coverageJudgmentEnum,
    "businessFlowBlueprintPacket.coverageJudgment",
  );

  if (flow.coverageJudgment === "complete") {
    for (const [index, lane] of flow.requiredLanes.entries()) {
      ensure(
        lane.coverageStatus === "covered",
        `businessFlowBlueprintPacket.requiredLanes[${index}].coverageStatus must be covered when coverageJudgment=complete.`,
      );
    }
    for (const [index, lane] of flow.optionalLanes.entries()) {
      ensure(
        lane.coverageStatus === "covered",
        `businessFlowBlueprintPacket.optionalLanes[${index}].coverageStatus must be covered when coverageJudgment=complete; use omittedLanes with a reason or mark coverageJudgment incomplete.`,
      );
    }
  }

  return { requiredLaneIds, optionalLaneIds, omittedLaneIds };
}

function validateEvidenceBackedGatePacket(
  contract,
  packetName,
  statusField,
  artifact,
  options = {},
) {
  const packet = artifact[packetName];
  const protocol = contract.protocols[packetName];
  ensureFields(packet, protocol.requiredFields, packetName);
  ensureForbiddenSecretValueKeysAbsent(packet, packetName);

  for (const field of protocol.requiredFields) {
    if (field === "owner") {
      ensureDurableOwner(contract, artifact, packet[field], `${packetName}.${field}`);
      continue;
    }
    if (field === "evidenceRefs") {
      ensureStringArray(packet[field], `${packetName}.${field}`);
      ensure(
        packet[field].length >= 1,
        `${packetName}.${field} must include at least one evidence reference.`,
      );
      for (const [index, ref] of packet[field].entries()) {
        ensure(
          evidenceRefResolves(artifact, ref),
          `${packetName}.evidenceRefs[${index}] must resolve to an artifact evidence path, got: ${ref}`,
        );
      }
      continue;
    }
    if (Array.isArray(packet[field])) {
      if (
        options.allowEmptyArrays?.includes(field) &&
        packet[field].length === 0
      ) {
        continue;
      }
      ensure(
        packet[field].length >= 1,
        `${packetName}.${field} must not be empty.`,
      );
      for (const [index, item] of packet[field].entries()) {
        ensure(
          (typeof item === "string" && item.trim().length >= 1) ||
            (item && typeof item === "object"),
          `${packetName}.${field}[${index}] must be a non-empty string or object.`,
        );
      }
      continue;
    }
    ensureNonEmptyValue(packet[field], `${packetName}.${field}`);
  }

  ensureEnum(packet[statusField], protocol.statusEnum, `${packetName}.${statusField}`);
  validateDimensionCoverage(contract, packetName, packet, artifact);
}

function validateProductGatePackets(contract, artifact) {
  if (!shouldRequireProductGatePackets(contract, artifact)) {
    return;
  }

  for (const packetName of productGatePacketNames(contract)) {
    ensure(
      artifact[packetName] !== undefined,
      `${packetName} is required for non-query or product deliverable run artifacts.`,
    );
  }

  validateEvidenceBackedGatePacket(
    contract,
    "productCompletenessPacket",
    "completenessStatus",
    artifact,
  );
  validateEvidenceBackedGatePacket(
    contract,
    "experienceQualityPacket",
    "experienceStatus",
    artifact,
  );
  validateEvidenceBackedGatePacket(
    contract,
    "testStrategyPacket",
    "testStatus",
    artifact,
    { allowEmptyArrays: ["deferredTests"] },
  );
  validateEvidenceBackedGatePacket(
    contract,
    "structureHygienePacket",
    "hygieneStatus",
    artifact,
  );
  validateEvidenceBackedGatePacket(
    contract,
    "permissionMatrixPacket",
    "permissionStatus",
    artifact,
  );
  validateEvidenceBackedGatePacket(
    contract,
    "sideEffectLedgerPacket",
    "sideEffectStatus",
    artifact,
    {
      allowEmptyArrays: [
        "sideEffects",
        "externalSystemsTouched",
        "stateChanges",
      ],
    },
  );
  if (artifact.sideEffectLedgerPacket.sideEffectStatus !== "none") {
    ensure(
      artifact.sideEffectLedgerPacket.sideEffects.length >= 1 ||
        artifact.sideEffectLedgerPacket.stateChanges.length >= 1,
      "sideEffectLedgerPacket must record sideEffects or stateChanges unless sideEffectStatus=none.",
    );
  }
  validateEvidenceBackedGatePacket(
    contract,
    "rollbackPlanPacket",
    "rollbackStatus",
    artifact,
  );
}

function validateProductGatePublicReadyStatus(contract, artifact) {
  if (
    artifact.summaryPacket?.publicReady !== true ||
    !shouldRequireProductGatePackets(contract, artifact)
  ) {
    return;
  }

  const policy =
    contract.runDiscipline?.runArtifactValidation
      ?.productGatePublicReadyStatusPolicy ?? {};
  if (policy.enabled !== true) return;

  for (const entry of policy.packetStatusFields ?? []) {
    const packet = artifact[entry.packet];
    const value = packet?.[entry.statusField];
    const allowed = entry.publicReadyAllowed ?? [];
    ensure(
      allowed.includes(value),
      `summaryPacket.publicReady=true requires ${entry.packet}.${entry.statusField} to be one of [${allowed.join(", ")}], got: ${value}`,
    );
  }
}

function validateInterfaceIntegrationContractWhenRequired(contract, artifact) {
  const policy = contract.runDiscipline?.integrationContractPolicy ?? {};
  const deliverableType = artifact.businessFlowBlueprintPacket?.deliverableType;
  const requiredDeliverableTypes = policy.requiredWhenDeliverableTypes ?? [];
  const triggerReasons = artifact.taskClassification?.triggerReasons ?? [];
  const requiredTriggerReasons =
    contract.runDiscipline?.protocolFirst
      ?.interfaceIntegrationContractPacketRequiredWhenTriggerReasons ?? [];
  const shouldRequire =
    requiredDeliverableTypes.includes(deliverableType) ||
    triggerReasons.some((reason) => requiredTriggerReasons.includes(reason));

  if (!shouldRequire) return;

  const packet = artifact.interfaceIntegrationContractPacket;
  ensure(
    packet !== undefined,
    "interfaceIntegrationContractPacket is required when taskClassification.triggerReasons or businessFlowBlueprintPacket.deliverableType indicate internal or third-party interface integration.",
  );

  const protocol = contract.protocols.interfaceIntegrationContractPacket;
  ensureForbiddenSecretValueKeysAbsent(
    packet,
    "interfaceIntegrationContractPacket",
  );
  ensureFields(
    packet,
    protocol.requiredFields,
    "interfaceIntegrationContractPacket",
  );
  ensureEnum(
    packet.integrationKind,
    protocol.integrationKindEnum,
    "interfaceIntegrationContractPacket.integrationKind",
  );

  ensureObjectArray(
    packet.interfaceInventory,
    "interfaceIntegrationContractPacket.interfaceInventory",
  );
  ensureObjectArray(
    packet.fieldLedger,
    "interfaceIntegrationContractPacket.fieldLedger",
  );
  ensureObjectArray(packet.unknowns, "interfaceIntegrationContractPacket.unknowns");
  ensureObjectArray(packet.evidence, "interfaceIntegrationContractPacket.evidence");
  ensureArray(packet.reviewGates, "interfaceIntegrationContractPacket.reviewGates");
  ensureObjectArray(
    packet.testMatrix,
    "interfaceIntegrationContractPacket.testMatrix",
  );
  ensureObjectArray(
    packet.ownerApprovals,
    "interfaceIntegrationContractPacket.ownerApprovals",
  );

  const evidenceIds = new Set();
  for (const [index, evidence] of packet.evidence.entries()) {
    ensureFields(
      evidence,
      protocol.evidenceRequiredFields,
      `interfaceIntegrationContractPacket.evidence[${index}]`,
    );
    ensureString(
      evidence.evidenceId,
      `interfaceIntegrationContractPacket.evidence[${index}].evidenceId`,
    );
    ensureEnum(
      evidence.sourceType,
      policy.evidenceSourceEnum,
      `interfaceIntegrationContractPacket.evidence[${index}].sourceType`,
    );
    ensureString(
      evidence.sourceRef,
      `interfaceIntegrationContractPacket.evidence[${index}].sourceRef`,
    );
    ensureString(
      evidence.summary,
      `interfaceIntegrationContractPacket.evidence[${index}].summary`,
    );
    evidenceIds.add(evidence.evidenceId);
  }

  const blockingStatuses = new Set(policy.blockingUnknownStatuses ?? []);
  const isPublicReady = artifact.summaryPacket?.publicReady === true;

  for (const [index, field] of packet.fieldLedger.entries()) {
    ensureFields(
      field,
      protocol.fieldLedgerRequiredFields,
      `interfaceIntegrationContractPacket.fieldLedger[${index}]`,
    );
    ensureString(
      field.fieldName,
      `interfaceIntegrationContractPacket.fieldLedger[${index}].fieldName`,
    );
    ensureEnum(
      field.fieldClass,
      policy.fieldClassEnum,
      `interfaceIntegrationContractPacket.fieldLedger[${index}].fieldClass`,
    );
    ensureString(
      field.sourceOfTruth,
      `interfaceIntegrationContractPacket.fieldLedger[${index}].sourceOfTruth`,
    );
    ensure(
      evidenceIds.has(field.evidenceRef),
      `interfaceIntegrationContractPacket.fieldLedger[${index}].evidenceRef must reference interfaceIntegrationContractPacket.evidence[].evidenceId.`,
    );
    ensureString(
      field.owner,
      `interfaceIntegrationContractPacket.fieldLedger[${index}].owner`,
    );
    ensureString(
      field.transformationRule,
      `interfaceIntegrationContractPacket.fieldLedger[${index}].transformationRule`,
    );
    ensureEnum(
      field.unknownStatus,
      policy.unknownStatusEnum,
      `interfaceIntegrationContractPacket.fieldLedger[${index}].unknownStatus`,
    );
    ensure(
      !(isPublicReady && blockingStatuses.has(field.unknownStatus)),
      `interfaceIntegrationContractPacket.fieldLedger[${index}] cannot remain ${field.unknownStatus} when summaryPacket.publicReady=true.`,
    );
  }

  for (const [index, unknown] of packet.unknowns.entries()) {
    ensureFields(
      unknown,
      protocol.unknownRequiredFields,
      `interfaceIntegrationContractPacket.unknowns[${index}]`,
    );
    ensureEnum(
      unknown.status,
      policy.unknownStatusEnum,
      `interfaceIntegrationContractPacket.unknowns[${index}].status`,
    );
    ensure(
      !(isPublicReady && blockingStatuses.has(unknown.status)),
      `interfaceIntegrationContractPacket.unknowns[${index}] cannot remain ${unknown.status} when summaryPacket.publicReady=true.`,
    );
  }

  const reviewGates = new Set(packet.reviewGates);
  for (const [index, gate] of packet.reviewGates.entries()) {
    ensureEnum(
      gate,
      protocol.reviewGateEnum,
      `interfaceIntegrationContractPacket.reviewGates[${index}]`,
    );
  }

  const requiredGates =
    policy.requiredReviewGatesByIntegrationKind?.[packet.integrationKind] ?? [];
  for (const gate of requiredGates) {
    ensure(
      reviewGates.has(gate),
      `interfaceIntegrationContractPacket.reviewGates must include ${gate} for integrationKind=${packet.integrationKind}.`,
    );
  }

  const testScenarios = new Set(packet.testMatrix.map((item) => item.scenario));
  for (const scenario of protocol.testMatrixRequiredScenarios) {
    ensure(
      testScenarios.has(scenario),
      `interfaceIntegrationContractPacket.testMatrix must include scenario ${scenario}.`,
    );
  }
}

function validateAgentBlueprint(contract, artifact) {
  const packet = artifact.agentBlueprintPacket;
  const policy = contract.protocols.agentBlueprintPacket;
  ensureFields(
    packet,
    policy.requiredFields,
    "agentBlueprintPacket",
  );
  ensureArray(packet.roles, "agentBlueprintPacket.roles");
  ensure(packet.roles.length >= 1, "agentBlueprintPacket.roles must not be empty.");
  const coveredLaneIds = new Set();
  for (const [index, role] of packet.roles.entries()) {
    ensureObject(role, `agentBlueprintPacket.roles[${index}]`);
    ensureFields(
      role,
      policy.roleRequiredFields,
      `agentBlueprintPacket.roles[${index}]`,
    );
    for (const field of policy.roleRequiredFields) {
      if (["governanceStageNodes"].includes(field)) {
        continue;
      }
      ensureNonEmptyValue(role[field], `agentBlueprintPacket.roles[${index}].${field}`);
    }
    ensureString(role.businessRoleId, `agentBlueprintPacket.roles[${index}].businessRoleId`);
    ensureString(role.roleDisplayName, `agentBlueprintPacket.roles[${index}].roleDisplayName`);
    ensureString(role.ownerAgent, `agentBlueprintPacket.roles[${index}].ownerAgent`);
    validateRoleOwnerPolicy(contract, role, `agentBlueprintPacket.roles[${index}]`);
    ensureEnum(
      role.ownerResolution,
      policy.ownerResolutionEnum,
      `agentBlueprintPacket.roles[${index}].ownerResolution`,
    );
    validateRoleCapabilityMatches(
      policy,
      role,
      `agentBlueprintPacket.roles[${index}]`,
    );
    if (role.providerCompatibility !== undefined) {
      ensureStringArray(
        role.providerCompatibility,
        `agentBlueprintPacket.roles[${index}].providerCompatibility`,
      );
      for (const [skillIndex, skill] of (role.matchedSkills ?? []).entries()) {
        ensure(
          role.providerCompatibility.includes(skill.providerId),
          `agentBlueprintPacket.roles[${index}].matchedSkills[${skillIndex}].providerId must appear in role providerCompatibility.`,
        );
      }
      for (const [capabilityIndex, capability] of (
        role.matchedCapabilities ?? []
      ).entries()) {
        if (capability.providerId === undefined) continue;
        ensure(
          role.providerCompatibility.includes(capability.providerId),
          `agentBlueprintPacket.roles[${index}].matchedCapabilities[${capabilityIndex}].providerId must appear in role providerCompatibility.`,
        );
      }
    }
    ensure(
      role.skillSelectionScope === policy.governanceStageCoveragePolicy.skillSelectionScope &&
        policy.skillSelectionScopeEnum.includes(role.skillSelectionScope),
      `agentBlueprintPacket.roles[${index}].skillSelectionScope must be ${policy.governanceStageCoveragePolicy.skillSelectionScope}.`,
    );
    validateGovernanceStageNodes(policy, role.governanceStageNodes, `agentBlueprintPacket.roles[${index}].governanceStageNodes`);
    validateRoleDisplayName(
      role.roleDisplayName,
      `agentBlueprintPacket.roles[${index}].roleDisplayName`,
    );
    for (const laneId of valuesAsStrings(role.assignedResponsibilitySlice)) {
      coveredLaneIds.add(laneId);
    }
  }
  ensureEnum(
    packet.roleCoverageGate,
    policy.roleCoverageGateEnum,
    "agentBlueprintPacket.roleCoverageGate",
  );
  ensureArray(packet.missingRoles, "agentBlueprintPacket.missingRoles");
  if (packet.roleCoverageGate === "pass") {
    ensure(
      packet.missingRoles.length === 0,
      "agentBlueprintPacket.missingRoles must be empty when roleCoverageGate=pass.",
    );
  }
  ensureEnum(
    packet.duplicateRolePolicy,
    policy.duplicateRolePolicyEnum,
    "agentBlueprintPacket.duplicateRolePolicy",
  );
  ensureObject(packet.namingPolicy, "agentBlueprintPacket.namingPolicy");
  for (const [field, expected] of Object.entries(policy.namingPolicy)) {
    if (field === "description") continue;
    ensure(
      packet.namingPolicy[field] === expected,
      `agentBlueprintPacket.namingPolicy.${field} must match workflow contract.`,
    );
  }

  ensureObject(packet.governanceStageCoverage, "agentBlueprintPacket.governanceStageCoverage");
  const factoryResolutionPolicy =
    policy.governanceStageCoveragePolicy
      .factoryResolutionAdditionalRequiredAgents ?? {};
  const factoryResolutionApplies =
    factoryResolutionPolicy.appliesWhenResolutionActionAnyOf?.includes(
      artifact.capabilityGapPacket?.resolutionAction,
    ) ?? false;
  for (const stage of policy.governanceStageCoveragePolicy.requiredStages) {
    const participants = packet.governanceStageCoverage[stage];
    ensureStringArray(participants, `agentBlueprintPacket.governanceStageCoverage.${stage}`);
    const stageAllowed = new Set(policy.governanceStageCoveragePolicy.stageAllowedAgents?.[stage] ?? []);
    for (const participant of participants) {
      ensure(
        stageAllowed.has(participant),
        `agentBlueprintPacket.governanceStageCoverage.${stage} contains agent outside the allowed stage set: ${participant}`,
      );
    }
    const requiredAgents = new Set(
      policy.governanceStageCoveragePolicy.stageRequiredAgents?.[stage] ?? [],
    );
    if (factoryResolutionApplies) {
      for (const participant of factoryResolutionPolicy[stage] ?? []) {
        requiredAgents.add(participant);
      }
    }
    for (const requiredAgent of requiredAgents) {
      ensure(
        participants.includes(requiredAgent),
        `agentBlueprintPacket.governanceStageCoverage.${stage} must include required governance agent ${requiredAgent}.`,
      );
    }
  }

  for (const lane of artifact.businessFlowBlueprintPacket.requiredLanes) {
    ensure(
      coveredLaneIds.has(lane.laneId),
      `agentBlueprintPacket.roles must cover required businessFlowBlueprintPacket lane "${lane.laneId}".`,
    );
  }
}

function isCapabilityGapRequired(contract, artifact) {
  const when =
    contract.runDiscipline.protocolFirst
      .capabilityGapPacketRequiredWhenUpgradeReasons ?? [];
  const upgradeReasons = artifact.taskClassification?.upgradeReasons ?? [];
  const roleCoveragePolicy =
    contract.runDiscipline.protocolFirst
      .capabilityGapPacketRequiredWhenRoleCoverage ?? {};
  const missingRoles = artifact.agentBlueprintPacket?.missingRoles ?? [];
  const roleCoverageRequiresGap =
    artifact.agentBlueprintPacket?.roleCoverageGate ===
      roleCoveragePolicy.roleCoverageGate ||
    (roleCoveragePolicy.missingRolesNonEmpty === true &&
      missingRoles.length > 0) ||
    (artifact.agentBlueprintPacket?.roles ?? []).some((role) =>
      (roleCoveragePolicy.ownerResolutionAnyOf ?? []).includes(
        role.ownerResolution,
      ),
    );
  return (
    upgradeReasons.some((reason) => when.includes(reason)) ||
    roleCoverageRequiresGap
  );
}

function validateCapabilityGapPacketWhenRequired(contract, artifact) {
  const shouldRequire = isCapabilityGapRequired(contract, artifact);
  if (!shouldRequire) {
    return;
  }

  const packet = artifact.capabilityGapPacket;
  ensure(
    packet && typeof packet === "object",
    "capabilityGapPacket is required when upgradeReasons, missingRoles, roleCoverageGate, or ownerResolution require owner creation or upgrade.",
  );
  ensureFields(
    packet,
    contract.protocols.capabilityGapPacket.requiredFields,
    "capabilityGapPacket",
  );
  ensureString(packet.gapId, "capabilityGapPacket.gapId");
  ensureString(
    packet.requestedCapability,
    "capabilityGapPacket.requestedCapability",
  );
  ensureStringArray(
    packet.currentAgentsChecked,
    "capabilityGapPacket.currentAgentsChecked",
  );
  ensure(
    packet.currentAgentsChecked.length >= 1,
    "capabilityGapPacket.currentAgentsChecked must contain at least one checked owner.",
  );
  ensureString(
    packet.insufficiencyReason,
    "capabilityGapPacket.insufficiencyReason",
  );
  ensureEnum(
    packet.resolutionAction,
    contract.protocols.capabilityGapPacket.resolutionActionEnum,
    "capabilityGapPacket.resolutionAction",
  );
  ensureString(packet.requestedBy, "capabilityGapPacket.requestedBy");
  ensureString(packet.approvedBy, "capabilityGapPacket.approvedBy");
}

function validateExecutionAgentCardWhenRequired(contract, artifact) {
  const when =
    contract.runDiscipline.protocolFirst
      .executionAgentCardRequiredWhenResolutionActions ?? [];
  const resolutionAction = artifact.capabilityGapPacket?.resolutionAction;
  if (!when.includes(resolutionAction)) {
    ensure(
      artifact.executionAgentCard === undefined,
      "executionAgentCard is only for execution-agent creation or upgrade, not direct global reuse or public Meta_Kim durable ownership.",
    );
    return;
  }

  const registryScope =
    artifact.capabilityGapPacket?.executionAgentRegistryScope ??
    artifact.executionAgentCard?.registryScope;
  const allowedRegistryScopes = new Set(
    contract.protocols.executionAgentCard.registryScopeEnum ?? [
      "external_private",
    ],
  );
  ensure(
    allowedRegistryScopes.has(registryScope),
    `executionAgentCard registry scope must be one of [${[...allowedRegistryScopes].join(", ")}].`,
  );

  const packet = artifact.executionAgentCard;
  ensure(
    packet && typeof packet === "object",
    `executionAgentCard is required when capabilityGapPacket.resolutionAction is ${resolutionAction}.`,
  );
  ensureFields(
    packet,
    contract.protocols.executionAgentCard.requiredFields,
    "executionAgentCard",
  );
  ensureString(packet.agentId, "executionAgentCard.agentId");
  ensureString(packet.purpose, "executionAgentCard.purpose");
  ensureStringArray(
    packet.capabilities,
    "executionAgentCard.capabilities",
  );
  ensure(
    packet.capabilities.length >= 1,
    "executionAgentCard.capabilities must contain at least one capability.",
  );
  ensureStringArray(
    packet.nonCapabilities,
    "executionAgentCard.nonCapabilities",
  );
  ensure(
    packet.nonCapabilities.length >= 1,
    "executionAgentCard.nonCapabilities must contain at least one explicit boundary.",
  );
  ensureArray(packet.dependencies, "executionAgentCard.dependencies");
  for (const [index, dep] of packet.dependencies.entries()) {
    ensureString(dep, `executionAgentCard.dependencies[${index}]`);
  }
  ensureStringArray(packet.inputs, "executionAgentCard.inputs");
  ensure(
    packet.inputs.length >= 1,
    "executionAgentCard.inputs must contain at least one input.",
  );
  ensureStringArray(packet.outputs, "executionAgentCard.outputs");
  ensure(
    packet.outputs.length >= 1,
    "executionAgentCard.outputs must contain at least one output.",
  );
  validateExecutionAgentCardAbstraction(contract, packet, "executionAgentCard");
}

function validateHardPublicReadyTodoGate(contract, artifact) {
  const sp = artifact.summaryPacket;
  if (!sp || sp.publicReady !== true) {
    return;
  }
  const packets = artifact.workerTaskPackets;
  ensureArray(packets, "workerTaskPackets");
  for (const [index, packet] of packets.entries()) {
    if (packet?.taskTodoState === "open") {
      fail(
        `Hard public-ready todo gate: workerTaskPackets[${index}] has taskTodoState=open while summaryPacket.publicReady=true.`,
      );
    }
  }
}

function validateHardCommentReviewGate(contract, artifact) {
  const gate =
    contract.runDiscipline?.runArtifactValidation?.commentReviewGate ?? {};
  const sp = artifact.summaryPacket;
  if (!sp || sp.publicReady !== true) {
    return;
  }
  const field = gate?.summaryBooleanField ?? "commentReviewAcknowledged";
  if (sp[field] !== true) {
    fail(
      `Hard public-ready comment review gate: summaryPacket.publicReady=true requires summaryPacket.${field}=true.`,
    );
  }
}

function validateCardPlan(contract, artifact) {
  const cardPlan = artifact.cardPlanPacket;
  ensureFields(
    cardPlan,
    contract.protocols.cardPlanPacket.requiredFields,
    "cardPlanPacket",
  );
  ensureArray(cardPlan.cardEvents, "cardPlanPacket.cardEvents");
  ensureArray(cardPlan.cardTypeCatalog, "cardPlanPacket.cardTypeCatalog");
  ensureArray(cardPlan.cardTypeDecisions, "cardPlanPacket.cardTypeDecisions");
  ensureArray(cardPlan.deliveryShells, "cardPlanPacket.deliveryShells");
  ensureArray(cardPlan.controlDecisions, "cardPlanPacket.controlDecisions");

  const dealerGate = contract.gates.dealer;
  ensure(
    [dealerGate.primaryOwner, dealerGate.escalationOwner].includes(
      cardPlan.dealerOwner,
    ),
    `cardPlanPacket.dealerOwner must be ${dealerGate.primaryOwner} or ${dealerGate.escalationOwner}.`,
  );

  const cardPolicy = contract.runDiscipline.cardGovernance;
  const shellPolicy = contract.runDiscipline.deliveryShell;
  const silencePolicy = contract.runDiscipline.silencePolicy;
  const controlPolicy = contract.runDiscipline.controlIntervention;

  const cardEventIds = new Set();
  for (const [index, event] of cardPlan.cardEvents.entries()) {
    ensureFields(
      event,
      [
        "eventId",
        "eventIndex",
        "cardKey",
        "cardType",
        "cardIntent",
        "cardDecision",
        "cardAudience",
        "cardTiming",
        "deliveryShellId",
        "eventReason",
        "repeatOrdinal",
      ],
      `cardPlanPacket.cardEvents[${index}]`,
    );
    ensure(!cardEventIds.has(event.eventId), `Duplicate card eventId: ${event.eventId}`);
    cardEventIds.add(event.eventId);
    ensure(
      Number.isInteger(event.eventIndex) && event.eventIndex >= 1,
      `card event ${event.eventId} eventIndex must be a positive integer.`,
    );
    ensure(
      Number.isInteger(event.repeatOrdinal) && event.repeatOrdinal >= 1,
      `card event ${event.eventId} repeatOrdinal must be a positive integer.`,
    );
    ensureEnum(event.cardType, cardPolicy.cardTypeEnum, `card event ${event.eventId} cardType`);
    ensureEnum(
      event.cardIntent,
      cardPolicy.cardIntentEnum,
      `card event ${event.eventId} cardIntent`,
    );
    ensureEnum(
      event.cardDecision,
      cardPolicy.cardDecisionEnum,
      `card event ${event.eventId} cardDecision`,
    );
    ensureEnum(
      event.cardAudience,
      cardPolicy.cardAudienceEnum,
      `card event ${event.eventId} cardAudience`,
    );
    ensureEnum(
      event.cardTiming,
      cardPolicy.cardTimingEnum,
      `card event ${event.eventId} cardTiming`,
    );
  }

  const cardIds = new Set();
  for (const [index, card] of cardPlan.cardTypeDecisions.entries()) {
    ensureFields(
      card,
      contract.protocols.cardDecision.requiredFields,
      `cardPlanPacket.cardTypeDecisions[${index}]`,
    );
    ensure(!cardIds.has(card.cardId), `Duplicate cardId: ${card.cardId}`);
    cardIds.add(card.cardId);
    ensureEnum(
      card.cardType,
      cardPolicy.cardTypeEnum,
      `card ${card.cardId} cardType`,
    );
    ensureEnum(
      card.cardIntent,
      cardPolicy.cardIntentEnum,
      `card ${card.cardId} cardIntent`,
    );
    ensureEnum(
      card.cardDecision,
      cardPolicy.cardDecisionEnum,
      `card ${card.cardId} cardDecision`,
    );
    ensureEnum(
      card.cardAudience,
      cardPolicy.cardAudienceEnum,
      `card ${card.cardId} cardAudience`,
    );
    ensureEnum(
      card.cardTiming,
      cardPolicy.cardTimingEnum,
      `card ${card.cardId} cardTiming`,
    );
    ensureEnum(
      card.cardShell,
      cardPolicy.cardShellEnum,
      `card ${card.cardId} cardShell`,
    );
    ensureEnum(
      card.cardSource,
      cardPolicy.cardSourceEnum,
      `card ${card.cardId} cardSource`,
    );
    ensure(
      Number.isInteger(card.cardPriority) && card.cardPriority >= 1,
      `card ${card.cardId} cardPriority must be a positive integer.`,
    );
    if (card.cardSuppressed === true) {
      ensure(
        typeof card.suppressionReason === "string" &&
          card.suppressionReason.trim().length >= 1,
        `suppressed card ${card.cardId} must record suppressionReason.`,
      );
    }
    if (card.suppressionReason) {
      ensure(
        cardPolicy.suppressionReasonEnum.includes(card.suppressionReason) ||
          String(card.suppressionReason).trim().length >= 1,
        `card ${card.cardId} suppressionReason must be documented.`,
      );
    }
  }

  const shellIds = new Set();
  for (const [index, shell] of cardPlan.deliveryShells.entries()) {
    ensureFields(
      shell,
      contract.protocols.deliveryShell.requiredFields,
      `cardPlanPacket.deliveryShells[${index}]`,
    );
    ensure(
      !shellIds.has(shell.deliveryShellId),
      `Duplicate deliveryShellId: ${shell.deliveryShellId}`,
    );
    shellIds.add(shell.deliveryShellId);
    ensureEnum(
      shell.shellType,
      shellPolicy.shellTypeEnum,
      `deliveryShell ${shell.deliveryShellId} shellType`,
    );
    ensureEnum(
      shell.presentationMode,
      shellPolicy.presentationModeEnum,
      `deliveryShell ${shell.deliveryShellId} presentationMode`,
    );
    ensureEnum(
      shell.exposureLevel,
      shellPolicy.exposureLevelEnum,
      `deliveryShell ${shell.deliveryShellId} exposureLevel`,
    );
    ensureEnum(
      shell.interventionForm,
      shellPolicy.interventionFormEnum,
      `deliveryShell ${shell.deliveryShellId} interventionForm`,
    );
  }

  ensure(
    shellIds.has(cardPlan.defaultShellId),
    `cardPlanPacket.defaultShellId ${cardPlan.defaultShellId} must reference an existing delivery shell.`,
  );
  for (const card of cardPlan.cardTypeDecisions) {
    ensure(
      shellIds.has(card.deliveryShellId),
      `card ${card.cardId} references missing deliveryShellId ${card.deliveryShellId}.`,
    );
  }
  for (const event of cardPlan.cardEvents) {
    ensure(
      shellIds.has(event.deliveryShellId),
      `card event ${event.eventId} references missing deliveryShellId ${event.deliveryShellId}.`,
    );
  }

  ensureFields(
    cardPlan.silenceDecision,
    contract.protocols.silenceDecision.requiredFields,
    "cardPlanPacket.silenceDecision",
  );
  ensureEnum(
    cardPlan.silenceDecision.silenceDecision,
    silencePolicy.silenceDecisionEnum,
    "cardPlanPacket.silenceDecision.silenceDecision",
  );
  if (cardPlan.silenceDecision.silenceDecision === "defer") {
    ensure(
      typeof cardPlan.silenceDecision.deferUntil === "string" &&
        cardPlan.silenceDecision.deferUntil.trim().length >= 1,
      "defer silenceDecision must include deferUntil.",
    );
  }
  if (cardPlan.silenceDecision.silenceDecision !== "none") {
    ensure(
      typeof cardPlan.silenceDecision.reasonForSilence === "string" &&
        cardPlan.silenceDecision.reasonForSilence.trim().length >= 1,
      "non-none silenceDecision must include reasonForSilence.",
    );
  }

  const controlIds = new Set();
  for (const [index, decision] of cardPlan.controlDecisions.entries()) {
    ensureFields(
      decision,
      contract.protocols.controlDecision.requiredFields,
      `cardPlanPacket.controlDecisions[${index}]`,
    );
    ensure(
      !controlIds.has(decision.decisionId),
      `Duplicate control decision id: ${decision.decisionId}`,
    );
    controlIds.add(decision.decisionId);
    ensureEnum(
      decision.decisionType,
      controlPolicy.decisionTypeEnum,
      `controlDecision ${decision.decisionId} decisionType`,
    );

    if (decision.decisionType === "skip") {
      ensureEnum(
        decision.skipReason,
        controlPolicy.skipReasonEnum,
        `controlDecision ${decision.decisionId} skipReason`,
      );
    }
    if (decision.decisionType === "interrupt") {
      ensureEnum(
        decision.interruptReason,
        controlPolicy.interruptReasonEnum,
        `controlDecision ${decision.decisionId} interruptReason`,
      );
      ensure(
        controlPolicy.insertedGovernanceOwners.includes(
          decision.insertedGovernanceOwner,
        ),
        `interrupt decision ${decision.decisionId} must declare an insertedGovernanceOwner.`,
      );
    }
    if (
      decision.decisionType === "override" ||
      decision.decisionType === "escalation_insert"
    ) {
      ensureEnum(
        decision.overrideReason,
        controlPolicy.overrideReasonEnum,
        `controlDecision ${decision.decisionId} overrideReason`,
      );
      ensure(
        controlPolicy.insertedGovernanceOwners.includes(
          decision.insertedGovernanceOwner,
        ),
        `${decision.decisionType} decision ${decision.decisionId} must declare an insertedGovernanceOwner.`,
      );
    }
    if (controlPolicy.requiresReturnToMainChain === true) {
      ensure(
        typeof decision.returnsToStage === "string" &&
          decision.returnsToStage.trim().length >= 1,
        `controlDecision ${decision.decisionId} must declare returnsToStage.`,
      );
      ensure(
        typeof decision.rejoinCondition === "string" &&
          decision.rejoinCondition.trim().length >= 1,
        `controlDecision ${decision.decisionId} must declare rejoinCondition.`,
      );
    }
  }
}

function normalizeWorkerDependency(contract, dep, context) {
  if (typeof dep === "string") {
    ensureString(dep, context);
    return dep;
  }

  ensureObject(dep, context);
  ensureNoUnexpectedFields(
    dep,
    ["taskRef", "type", "timeout_ms", "retry", "onTimeout"],
    context,
  );
  ensureFields(dep, ["taskRef"], context);
  ensureString(dep.taskRef, `${context}.taskRef`);

  if (dep.type !== undefined) {
    ensureEnum(
      dep.type,
      Object.keys(contract.protocols.dependencyContract?.threeModes ?? {}),
      `${context}.type`,
    );
  }
  if (dep.timeout_ms !== undefined) {
    ensure(
      Number.isInteger(dep.timeout_ms) && dep.timeout_ms > 0,
      `${context}.timeout_ms must be a positive integer.`,
    );
  }
  if (dep.retry !== undefined) {
    ensureObject(dep.retry, `${context}.retry`);
    if (dep.retry.max !== undefined) {
      ensure(
        Number.isInteger(dep.retry.max) && dep.retry.max >= 0,
        `${context}.retry.max must be a non-negative integer.`,
      );
    }
    if (dep.retry.backoff_ms !== undefined) {
      ensure(
        Number.isInteger(dep.retry.backoff_ms) && dep.retry.backoff_ms >= 0,
        `${context}.retry.backoff_ms must be a non-negative integer.`,
      );
    }
  }
  if (dep.onTimeout !== undefined) {
    ensureEnum(
      dep.onTimeout,
      ["block", "wait", "return_to_stage"],
      `${context}.onTimeout`,
    );
    ensure(
      dep.onTimeout !== "use_fallback",
      `${context}.onTimeout must not use fallback artifacts; return to Thinking or abort instead.`,
    );
  }

  return dep.taskRef;
}

function validateWorkerWorkOrder(contract, artifact, packet, context) {
  for (const field of [
    "coreProblem",
    "todayTask",
    "output",
    "deliverableLink",
    "workType",
    "qualityBar",
    "referenceDirection",
    "lengthExpectation",
    "visualOrAssetPlan",
    "preDecisionOptionFrameRef",
    "finalizationGate",
  ]) {
    ensureString(packet[field], `${context}.${field}`);
  }
  const allowedWorkTypes = new Set(
    (contract.runDiscipline?.qualityFirstPolicy?.expertLensCatalog ?? []).map(
      (entry) => entry.workType,
    ),
  );
  ensure(
    allowedWorkTypes.has(packet.workType),
    `${context}.workType must reference a configured expert lens workType, got: ${packet.workType}`,
  );

  for (const field of [
    "scopeFiles",
    "nonGoals",
    "acceptanceCriteria",
    "expertLensRefs",
    "evidenceRefs",
    "capabilityRequirements",
    "toolRequirements",
  ]) {
    ensureStringArray(packet[field], `${context}.${field}`);
    ensure(
      packet[field].length >= 1,
      `${context}.${field} must contain at least one item before the worker starts.`,
    );
  }

  const allowedLensRefs = new Set(
    (contract.runDiscipline?.qualityFirstPolicy?.expertLensCatalog ?? []).map(
      (entry) => entry.workType,
    ),
  );
  for (const [index, lensRef] of packet.expertLensRefs.entries()) {
    ensure(
      allowedLensRefs.has(lensRef),
      `${context}.expertLensRefs[${index}] must reference a configured expert lens workType, got: ${lensRef}`,
    );
  }

  validateEvidenceRefArray(artifact, packet.evidenceRefs, `${context}.evidenceRefs`);

  ensureObject(packet.handoffContract, `${context}.handoffContract`);
  const handoffFields =
    contract.protocols.workerTaskPacket.handoffContractRequiredFields ?? [];
  ensureFields(packet.handoffContract, handoffFields, `${context}.handoffContract`);
  for (const field of handoffFields) {
    ensureString(
      packet.handoffContract[field],
      `${context}.handoffContract.${field}`,
    );
  }
}

function validateFileCompletionList(resultPacket, taskPacket, context) {
  ensureArray(resultPacket.producedArtifacts, `${context}.producedArtifacts`);
  ensureArray(resultPacket.fileCompletionList, `${context}.fileCompletionList`);
  const completedPaths = new Map();
  for (const [index, item] of resultPacket.fileCompletionList.entries()) {
    ensureObject(item, `${context}.fileCompletionList[${index}]`);
    ensureString(item.path, `${context}.fileCompletionList[${index}].path`);
    ensureEnum(
      item.action,
      ["edit", "create", "delete", "rename"],
      `${context}.fileCompletionList[${index}].action`,
    );
    ensureEnum(
      item.status,
      ["completed", "skipped", "failed"],
      `${context}.fileCompletionList[${index}].status`,
    );
    if (item.status !== "completed") {
      ensureString(
        item.skipReason,
        `${context}.fileCompletionList[${index}].skipReason`,
      );
    }
    completedPaths.set(normalizePathRef(item.path), item);
  }

  const promisedPaths = [
    ...resultPacket.producedArtifacts,
    ...(Array.isArray(taskPacket.scopeFiles) ? taskPacket.scopeFiles : []),
  ].map((item) => normalizePathRef(String(item)));
  for (const promisedPath of new Set(promisedPaths)) {
    ensure(
      completedPaths.has(promisedPath),
      `${context}.fileCompletionList must account for promised artifact ${promisedPath}.`,
    );
  }
}

function validateWorkerExecutionEvidence(resultPacket, taskPacket, context, artifact) {
  ensureArray(taskPacket.verifySteps, `${context}.matchedWorkerTask.verifySteps`);
  ensureArray(
    resultPacket.workerExecutionEvidence,
    `${context}.workerExecutionEvidence`,
  );
  ensure(
    resultPacket.workerExecutionEvidence.length === taskPacket.verifySteps.length,
    `${context}.workerExecutionEvidence must cover every worker verifySteps entry exactly once.`,
  );
  const verifyStepIds = new Set();
  for (const [index, step] of taskPacket.verifySteps.entries()) {
    ensureObject(step, `${context}.matchedWorkerTask.verifySteps[${index}]`);
    ensureString(step.id, `${context}.matchedWorkerTask.verifySteps[${index}].id`);
    ensure(
      !verifyStepIds.has(step.id),
      `${context}.matchedWorkerTask.verifySteps[${index}].id must be unique.`,
    );
    verifyStepIds.add(step.id);
  }
  const coveredStepIds = new Set();
  for (const [index, item] of resultPacket.workerExecutionEvidence.entries()) {
    ensureObject(item, `${context}.workerExecutionEvidence[${index}]`);
    for (const field of [
      "verifyStepRef",
      "command",
      "passClaim",
      "status",
      "runBy",
      "runAt",
      "expectedResult",
      "observedResult",
      "workingDirectory",
    ]) {
      ensureString(item[field], `${context}.workerExecutionEvidence[${index}].${field}`);
    }
    ensure(
      typeof item.stderrTail === "string",
      `${context}.workerExecutionEvidence[${index}].stderrTail must be a string.`,
    );
    ensure(
      verifyStepIds.has(item.verifyStepRef),
      `${context}.workerExecutionEvidence[${index}].verifyStepRef must match a worker verifySteps id.`,
    );
    ensure(
      !coveredStepIds.has(item.verifyStepRef),
      `${context}.workerExecutionEvidence[${index}].verifyStepRef duplicates ${item.verifyStepRef}.`,
    );
    coveredStepIds.add(item.verifyStepRef);
    ensureEnum(
      item.status,
      ["verified", "fabricated", "skipped"],
      `${context}.workerExecutionEvidence[${index}].status`,
    );
    ensure(
      item.status !== "fabricated",
      `${context}.workerExecutionEvidence[${index}] must not fabricate verification.`,
    );
    ensureString(
      item.successMarkerFormat,
      `${context}.workerExecutionEvidence[${index}].successMarkerFormat`,
    );
    ensureEnum(
      item.successMarkerFormat,
      ["stdout-text", "exit-code-only", "json-output"],
      `${context}.workerExecutionEvidence[${index}].successMarkerFormat`,
    );
    if (item.status === "verified") {
      if (item.successMarkerFormat === "exit-code-only") {
        ensure(
          item.exitCode === 0,
          `${context}.workerExecutionEvidence[${index}].exitCode must be 0 for exit-code-only verified evidence.`,
        );
        ensureString(
          item.commandRanAt,
          `${context}.workerExecutionEvidence[${index}].commandRanAt`,
        );
      } else {
        ensureString(
          item.actualOutput,
          `${context}.workerExecutionEvidence[${index}].actualOutput`,
        );
        if (item.successMarkerFormat === "json-output") {
          try {
            JSON.parse(item.actualOutput);
          } catch {
            ensure(
              false,
              `${context}.workerExecutionEvidence[${index}].actualOutput must contain parseable JSON for json-output.`,
            );
          }
        }
      }
    }
    if (item.status === "skipped") {
      const claimsVerified =
        artifact.verificationPacket?.verified === true ||
        artifact.summaryPacket?.publicReady === true;
      ensure(
        !claimsVerified,
        `${context}.workerExecutionEvidence[${index}] has skipped worker verification evidence but verificationPacket.verified or summaryPacket.publicReady claims a verified run.`,
      );
      ensureString(
        item.skipReason,
        `${context}.workerExecutionEvidence[${index}].skipReason`,
      );
    }
  }
  for (const stepId of verifyStepIds) {
    ensure(
      coveredStepIds.has(stepId),
      `${context}.workerExecutionEvidence must include verifyStepRef ${stepId}.`,
    );
  }
}

function validateWorkerPackets(contract, artifact) {
  const primaryDeliverable = artifact.runHeader.primaryDeliverable;
  ensure(
    artifact.dispatchBoard.primaryDeliverable === primaryDeliverable,
    "dispatchBoard.primaryDeliverable must match runHeader.primaryDeliverable.",
  );

  const taskPackets = artifact.workerTaskPackets;
  const resultPackets = artifact.workerResultPackets;
  ensureArray(taskPackets, "workerTaskPackets");
  ensureArray(resultPackets, "workerResultPackets");

  const taskById = new Map();
  const dependenciesByTaskId = new Map();
  const packetsByOwnerAgent = new Map();
  const packetsByParallelGroup = new Map();
  const workerPolicy = contract.protocols.workerTaskPacket.sameOwnerMultiInstancePolicy;
  const validCollisionPolicies = workerPolicy.collisionPolicyEnum ?? [];
  const executionModePolicy =
    contract.protocols.workerTaskPacket.executionModePolicy ?? {};
  const executionWorkerModes = new Set(
    executionModePolicy.executionWorkerModes ?? [],
  );
  const approvalGateModes = new Set(executionModePolicy.approvalGateModes ?? []);
  const executionModeClasses = new Set(executionModePolicy.executionModeClasses ?? []);
  const executionModeClassMap = executionModePolicy.executionModeClassMap ?? {};
  const validWorkspaceIsolation = new Set([
    "same_workspace_readonly_overlap",
    "isolated_worktree",
    "file_lock_required",
  ]);
  for (const [index, packet] of taskPackets.entries()) {
    ensureFields(
      packet,
      contract.protocols.workerTaskPacket.requiredFields,
      `workerTaskPackets[${index}]`,
    );
    validateWorkerWorkOrder(
      contract,
      artifact,
      packet,
      `workerTaskPackets[${index}]`,
    );
    ensureString(packet.taskPacketId, `workerTaskPackets[${index}].taskPacketId`);
    ensure(
      !taskById.has(packet.taskPacketId),
      `Duplicate workerTaskPacket taskPacketId: ${packet.taskPacketId}`,
    );
    ensureEnum(
      packet.ownerMode,
      contract.protocols.workerTaskPacket.ownerModeEnum ?? [],
      `workerTaskPackets[${index}].ownerMode`,
    );
    ensureEnum(
      packet.executionMode,
      executionModePolicy.executionModeEnum ?? [],
      `workerTaskPackets[${index}].executionMode`,
    );
    ensure(
      executionModeClasses.has(executionModeClassMap[packet.executionMode]),
      `workerTaskPackets[${index}].executionMode ${packet.executionMode} must map to an execution mode class.`,
    );
    ensureString(packet.roleDisplayName, `workerTaskPackets[${index}].roleDisplayName`);
    ensureString(packet.ownerAgent, `workerTaskPackets[${index}].ownerAgent`);
    ensureDurableOwner(contract, artifact, packet.ownerAgent, `workerTaskPackets[${index}].ownerAgent`);
    ensureDurableOwner(contract, artifact, packet.owner, `workerTaskPackets[${index}].owner`);
    ensureString(packet.roleInstanceId, `workerTaskPackets[${index}].roleInstanceId`);
    ensureString(packet.shardKey, `workerTaskPackets[${index}].shardKey`);
    ensureArray(packet.shardScope, `workerTaskPackets[${index}].shardScope`);
    ensure(
      packet.shardScope.length >= 1,
      `workerTaskPackets[${index}].shardScope must contain at least one shard.`,
    );
    ensureString(
      packet.artifactNamespace,
      `workerTaskPackets[${index}].artifactNamespace`,
    );
    ensureString(
      packet.collisionPolicy,
      `workerTaskPackets[${index}].collisionPolicy`,
    );
    ensureDurableOwner(contract, artifact, packet.mergeOwner, `workerTaskPackets[${index}].mergeOwner`);
    ensureDurableOwner(contract, artifact, packet.handoffTarget, `workerTaskPackets[${index}].handoffTarget`);
    ensureEnum(
      packet.collisionPolicy,
      validCollisionPolicies,
      `workerTaskPackets[${index}].collisionPolicy`,
    );
    ensure(
      validWorkspaceIsolation.has(packet.workspaceIsolation),
      `workerTaskPackets[${index}].workspaceIsolation must be one of [${[...validWorkspaceIsolation].join(", ")}].`,
    );
    ensureArray(packet.dependsOn, `workerTaskPackets[${index}].dependsOn`);
    dependenciesByTaskId.set(packet.taskPacketId, []);
    validateRoleDisplayName(
      packet.roleDisplayName,
      `workerTaskPacket ${packet.taskPacketId} roleDisplayName`,
    );
    validateFinalizedChoiceState(
      artifact,
      packet,
      `workerTaskPackets[${index}]`,
    );
    const ownerPackets = packetsByOwnerAgent.get(packet.ownerAgent) ?? [];
    ownerPackets.push({ ...packet, index });
    packetsByOwnerAgent.set(packet.ownerAgent, ownerPackets);
    const parallelPackets = packetsByParallelGroup.get(packet.parallelGroup) ?? [];
    parallelPackets.push({ ...packet, index });
    packetsByParallelGroup.set(packet.parallelGroup, parallelPackets);
    taskById.set(packet.taskPacketId, packet);
    if (
      contract.runDiscipline.runArtifactValidation
        .deliverableLinkMustReferencePrimaryDeliverable
    ) {
      ensure(
        normalizePathRef(packet.deliverableLink).includes(
          normalizePathRef(primaryDeliverable),
        ),
        `workerTaskPacket ${packet.taskPacketId} deliverableLink must reference primaryDeliverable ${primaryDeliverable}.`,
      );
    }
  }

  const executableRun =
    artifact.taskClassification?.requestClass === "execute" &&
    artifact.taskClassification?.governanceFlow !== "query";
  const executionWorkerCount = taskPackets.filter((packet) =>
    executionWorkerModes.has(packet.executionMode)
  ).length;
  const allApprovalGates =
    taskPackets.length > 0 &&
    taskPackets.every((packet) => approvalGateModes.has(packet.executionMode));
  ensure(
    !executableRun ||
      taskPackets.length === 0 ||
      executionWorkerCount > 0 ||
      allApprovalGates,
    "workerTaskPackets for executable runs must include at least one execution worker; read-only sidecars do not satisfy Stage 4 Execution.",
  );

  for (const [parallelGroup, groupPackets] of packetsByParallelGroup.entries()) {
    if (groupPackets.length <= 1) continue;
    const groupExecutionWorkerCount = groupPackets.filter((packet) =>
      executionWorkerModes.has(packet.executionMode)
    ).length;
    ensure(
      groupExecutionWorkerCount > 0,
      `parallelGroup ${parallelGroup} contains only read-only sidecar or approval-gate workerTaskPackets; it has no execution worker to run in parallel.`,
    );
  }

  for (const [index, packet] of taskPackets.entries()) {
    for (const [depIndex, dep] of packet.dependsOn.entries()) {
      const depRef = normalizeWorkerDependency(
        contract,
        dep,
        `workerTaskPackets[${index}].dependsOn[${depIndex}]`,
      );
      ensure(
        taskById.has(depRef),
        `workerTaskPacket ${packet.taskPacketId} depends on unknown taskPacketId ${depRef}.`,
      );
      dependenciesByTaskId.get(packet.taskPacketId).push(depRef);
    }
  }
  ensureAcyclicDependencyGraph(dependenciesByTaskId, "workerTaskPackets");

  for (const [ownerAgent, ownerPackets] of packetsByOwnerAgent.entries()) {
    const roleInstanceIds = new Set();
    const artifactNamespaces = new Set();
    const scopes = new Map();
    const mergeOwnerByParallelGroup = new Map();
    for (const packet of ownerPackets) {
      ensure(
        !roleInstanceIds.has(packet.roleInstanceId),
        `Duplicate roleInstanceId ${packet.roleInstanceId} for ownerAgent ${ownerAgent}.`,
      );
      roleInstanceIds.add(packet.roleInstanceId);
      ensure(
        !artifactNamespaces.has(packet.artifactNamespace),
        `Duplicate artifactNamespace ${packet.artifactNamespace} for ownerAgent ${ownerAgent}.`,
      );
      artifactNamespaces.add(packet.artifactNamespace);
      if (ownerPackets.length > 1) {
        const group = packet.parallelGroup;
        const groupMergeOwner = mergeOwnerByParallelGroup.get(group);
        if (groupMergeOwner) {
          ensure(
            groupMergeOwner === packet.mergeOwner,
            `same ownerAgent ${ownerAgent} in parallelGroup ${group} must use one mergeOwner.`,
          );
        } else {
          mergeOwnerByParallelGroup.set(group, packet.mergeOwner);
        }
        for (const scope of packet.shardScope.map((item) => normalizePathRef(item))) {
          const previous = scopes.get(scope);
          ensure(
            !previous,
            `same ownerAgent ${ownerAgent} must not use overlapping shardScope "${scope}" across ${previous} and ${packet.taskPacketId}.`,
          );
          scopes.set(scope, packet.taskPacketId);
        }
      }
    }
  }

  const resultById = new Map();
  for (const [index, packet] of resultPackets.entries()) {
    ensureFields(
      packet,
      contract.protocols.workerResultPacket.requiredFields,
      `workerResultPackets[${index}]`,
    );
    ensure(
      taskById.has(packet.taskPacketId),
      `workerResultPacket ${packet.taskPacketId} has no matching workerTaskPacket.`,
    );
    const taskPacket = taskById.get(packet.taskPacketId);
    ensureDurableOwner(contract, artifact, packet.owner, `workerResultPackets[${index}].owner`);
    ensure(
      packet.owner === taskPacket.owner,
      `workerResultPacket ${packet.taskPacketId} owner must match workerTaskPacket owner.`,
    );
    validateFileCompletionList(packet, taskPacket, `workerResultPackets[${index}]`);
    validateWorkerExecutionEvidence(
      packet,
      taskPacket,
      `workerResultPackets[${index}]`,
      artifact,
    );
    resultById.set(packet.taskPacketId, packet);
  }

  for (const taskId of taskById.keys()) {
    ensure(
      resultById.has(taskId),
      `workerTaskPacket ${taskId} has no matching workerResultPacket.`,
    );
  }
}

function normalizeReasonValue(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    return String(value.reason ?? value.value ?? value.status ?? "").trim();
  }
  return "";
}

function collectRecordedChoiceOrSkipReasons(artifact) {
  const reasons = new Set();
  for (const value of [
    artifact.intentGatePacket?.choiceGateSkip,
    artifact.preDecisionOptionFrame?.choiceGateSkip,
    artifact.preDecisionOptionFrame?.solutionChoiceState,
    artifact.preDecisionOptionFrame?.userChoiceState,
    artifact.dispatchEnvelopePacket?.userChoiceState,
    ...(artifact.workerTaskPackets ?? []).map((packet) => packet.userChoiceState),
  ]) {
    const reason = normalizeReasonValue(value);
    if (reason) reasons.add(reason);
  }
  return reasons;
}

function validateReviewProcessChecks(artifact) {
  const check = artifact.reviewPacket.triggerVsSkipReasonCheck;
  ensureObject(check, "reviewPacket.triggerVsSkipReasonCheck");
  ensureFields(
    check,
    ["status", "triggerReasons", "skipReason", "evidence"],
    "reviewPacket.triggerVsSkipReasonCheck",
  );
  ensureEnum(
    check.status,
    ["pass", "fail"],
    "reviewPacket.triggerVsSkipReasonCheck.status",
  );
  ensureStringArray(
    check.triggerReasons,
    "reviewPacket.triggerVsSkipReasonCheck.triggerReasons",
  );
  ensureString(check.skipReason, "reviewPacket.triggerVsSkipReasonCheck.skipReason");
  ensureString(check.evidence, "reviewPacket.triggerVsSkipReasonCheck.evidence");

  for (const triggerReason of artifact.taskClassification.triggerReasons ?? []) {
    ensure(
      check.triggerReasons.includes(triggerReason),
      `reviewPacket.triggerVsSkipReasonCheck.triggerReasons must include taskClassification trigger reason ${triggerReason}.`,
    );
  }

  const recordedReasons = collectRecordedChoiceOrSkipReasons(artifact);
  if (check.skipReason && check.skipReason !== "none") {
    ensure(
      recordedReasons.has(check.skipReason),
      `reviewPacket.triggerVsSkipReasonCheck.skipReason must match a recorded choiceGateSkip or userChoiceState, got: ${check.skipReason}`,
    );
  }

  if (check.status === "fail") {
    ensure(
      artifact.reviewPacket.revisionNeeded === true,
      "reviewPacket.triggerVsSkipReasonCheck.status=fail requires reviewPacket.revisionNeeded=true.",
    );
  }
}

function validateFindingChain(contract, artifact) {
  const reviewPacket = artifact.reviewPacket;
  const verificationPacket = artifact.verificationPacket;
  ensureFields(
    reviewPacket,
    contract.protocols.reviewPacket.requiredFields,
    "reviewPacket",
  );
  ensureFields(
    verificationPacket,
    contract.protocols.verificationPacket.requiredFields,
    "verificationPacket",
  );

  ensureArray(reviewPacket.sourceProjects, "reviewPacket.sourceProjects");
  ensureEnum(
    reviewPacket.crossProjectContaminationCheck,
    contract.protocols.reviewPacket.crossProjectContaminationCheckEnum,
    "reviewPacket.crossProjectContaminationCheck",
  );
  ensureArray(reviewPacket.findings, "reviewPacket.findings");
  ensureArray(
    verificationPacket.revisionResponses,
    "verificationPacket.revisionResponses",
  );
  ensureArray(
    verificationPacket.verificationResults,
    "verificationPacket.verificationResults",
  );
  ensureArray(
    verificationPacket.closeFindings,
    "verificationPacket.closeFindings",
  );
  ensureArray(
    verificationPacket.fixEvidence,
    "verificationPacket.fixEvidence",
  );

  validateReviewProcessChecks(artifact);

  const findingClosure = contract.runDiscipline.findingClosure;
  const findings = new Map();
  for (const [index, finding] of reviewPacket.findings.entries()) {
    ensureFields(
      finding,
      contract.protocols.reviewFinding.requiredFields,
      `reviewPacket.findings[${index}]`,
    );
    ensure(
      !findings.has(finding.findingId),
      `Duplicate review findingId: ${finding.findingId}`,
    );
    ensureString(
      finding.sourceProject,
      `review finding ${finding.findingId} sourceProject`,
    );
    ensure(
      reviewPacket.sourceProjects.includes(finding.sourceProject),
      `review finding ${finding.findingId} sourceProject must appear in reviewPacket.sourceProjects.`,
    );
    ensureDurableOwner(
      contract,
      artifact,
      finding.owner,
      `reviewPacket.findings[${index}].owner`,
    );
    ensureGovernanceOwner(
      contract,
      finding.verifiedBy,
      `reviewPacket.findings[${index}].verifiedBy`,
    );
    ensureEnum(
      finding.closeState,
      findingClosure.closeStateEnum,
      `review finding ${finding.findingId} closeState`,
    );
    ensure(
      ["open", "fixed_pending_verify"].includes(finding.closeState),
      `review finding ${finding.findingId} cannot start in a terminal closeState.`,
    );
    findings.set(finding.findingId, finding);
  }

  if (reviewPacket.crossProjectContaminationCheck === "fail") {
    ensure(
      reviewPacket.revisionNeeded === true,
      "cross-project contamination failures must require revision.",
    );
  }

  const revisionsByFinding = new Map();
  for (const [
    index,
    response,
  ] of verificationPacket.revisionResponses.entries()) {
    ensureFields(
      response,
      contract.protocols.revisionResponse.requiredFields,
      `verificationPacket.revisionResponses[${index}]`,
    );
    ensure(
      findings.has(response.findingId),
      `revisionResponse ${response.actionId} references unknown findingId ${response.findingId}.`,
    );
    ensureDurableOwner(
      contract,
      artifact,
      response.owner,
      `verificationPacket.revisionResponses[${index}].owner`,
    );
    revisionsByFinding.set(response.findingId, response);
  }

  const verificationByFinding = new Map();
  for (const [
    index,
    result,
  ] of verificationPacket.verificationResults.entries()) {
    ensureFields(
      result,
      contract.protocols.verificationResult.requiredFields,
      `verificationPacket.verificationResults[${index}]`,
    );
    ensure(
      findings.has(result.findingId),
      `verificationResult references unknown findingId ${result.findingId}.`,
    );
    ensureEnum(
      result.closeState,
      findingClosure.closeStateEnum,
      `verificationResult ${result.findingId} closeState`,
    );
    ensureGovernanceOwner(
      contract,
      result.verifiedBy,
      `verificationPacket.verificationResults[${index}].verifiedBy`,
    );
    ensure(
      ["verified_closed", "accepted_risk"].includes(result.closeState),
      `verificationResult ${result.findingId} must finish in a terminal closeState.`,
    );
    verificationByFinding.set(result.findingId, result);
  }

  const fixEvidenceByFinding = new Map();
  for (const [index, item] of verificationPacket.fixEvidence.entries()) {
    ensureObject(item, `verificationPacket.fixEvidence[${index}]`);
    for (const field of [
      "findingId",
      "actionId",
      "verifiedBy",
      "verificationMethod",
      "resultArtifactRef",
      "result",
      "failureDisposition",
    ]) {
      ensureString(item[field], `verificationPacket.fixEvidence[${index}].${field}`);
    }
    ensureArray(item.evidenceRefs, `verificationPacket.fixEvidence[${index}].evidenceRefs`);
    ensure(
      item.evidenceRefs.length >= 1,
      `verificationPacket.fixEvidence[${index}].evidenceRefs must not be empty.`,
    );
    ensure(
      findings.has(item.findingId),
      `verificationPacket.fixEvidence[${index}] references unknown findingId ${item.findingId}.`,
    );
    ensure(
      revisionsByFinding.get(item.findingId)?.actionId === item.actionId,
      `verificationPacket.fixEvidence[${index}].actionId must match the revisionResponse actionId for ${item.findingId}.`,
    );
    ensureGovernanceOwner(
      contract,
      item.verifiedBy,
      `verificationPacket.fixEvidence[${index}].verifiedBy`,
    );
    if (item.result === "accepted_risk") {
      for (const field of [
        "riskOwner",
        "riskReason",
        "expiryOrRevisitTrigger",
      ]) {
        ensureString(
          item[field],
          `verificationPacket.fixEvidence[${index}].${field} for accepted_risk`,
        );
      }
    }
    fixEvidenceByFinding.set(item.findingId, item);
  }

  for (const findingId of findings.keys()) {
    ensure(
      revisionsByFinding.has(findingId),
      `Finding ${findingId} is missing a revisionResponse.`,
    );
    ensure(
      verificationByFinding.has(findingId),
      `Finding ${findingId} is missing a verificationResult.`,
    );
    ensure(
      fixEvidenceByFinding.has(findingId),
      `Finding ${findingId} is missing structured fixEvidence.`,
    );
  }

  const closedIds = new Set(verificationPacket.closeFindings);
  for (const closedId of closedIds) {
    ensure(
      findings.has(closedId),
      `closeFindings contains unknown findingId ${closedId}.`,
    );
    const verificationResult = verificationByFinding.get(closedId);
    ensure(
      verificationResult &&
        ["verified_closed", "accepted_risk"].includes(
          verificationResult.closeState,
        ),
      `closeFindings may only contain findings with a terminal verification closeState (${closedId}).`,
    );
    const fixEvidence = fixEvidenceByFinding.get(closedId);
    ensure(
      fixEvidence,
      `closeFindings requires structured fixEvidence for ${closedId}.`,
    );
    if (verificationResult.closeState === "accepted_risk") {
      ensure(
        fixEvidence.result === "accepted_risk",
        `accepted_risk closeState requires matching fixEvidence result for ${closedId}.`,
      );
      for (const field of [
        "riskOwner",
        "riskReason",
        "expiryOrRevisitTrigger",
      ]) {
        ensureString(
          fixEvidence[field],
          `verificationPacket.fixEvidence for accepted_risk ${closedId}.${field}`,
        );
      }
    }
  }

  if (verificationPacket.verified === true) {
    ensure(
      verificationPacket.remainingIssues.length === 0,
      "verificationPacket.verified=true requires remainingIssues to be empty.",
    );
    ensure(
      closedIds.size === findings.size,
      "verificationPacket.verified=true requires every review finding to be closed.",
    );
  }
}

function validateSummaryAndEvolution(contract, artifact) {
  const summaryPacket = artifact.summaryPacket;
  const verificationPacket = artifact.verificationPacket;
  const evolutionPacket = artifact.evolutionWritebackPacket;
  ensureFields(
    summaryPacket,
    contract.protocols.summaryPacket.requiredFields,
    "summaryPacket",
  );
  ensureArray(
    summaryPacket.deliveryShellsUsed,
    "summaryPacket.deliveryShellsUsed",
  );
  ensureArray(summaryPacket.sourceProjects, "summaryPacket.sourceProjects");
  ensureArray(summaryPacket.blockedBy, "summaryPacket.blockedBy");

  for (const [index, projectRef] of summaryPacket.sourceProjects.entries()) {
    ensureString(projectRef, `summaryPacket.sourceProjects[${index}]`);
  }
  for (const projectRef of artifact.reviewPacket.sourceProjects) {
    ensure(
      summaryPacket.sourceProjects.includes(projectRef),
      `summaryPacket.sourceProjects must include reviewPacket source project ${projectRef}.`,
    );
  }
  const checkedProjects = new Set(
    artifact.fetchPacket.projectsChecked.map((item) => item.projectRef),
  );
  for (const projectRef of summaryPacket.sourceProjects) {
    ensure(
      checkedProjects.has(projectRef),
      `summaryPacket.sourceProjects may only reference projects checked during Fetch (${projectRef}).`,
    );
  }
  if (artifact.taskClassification.queryScope === "current_project") {
    ensure(
      summaryPacket.sourceProjects.length === 1 &&
        summaryPacket.sourceProjects[0] === artifact.taskClassification.projectRef,
      "current_project runs must summarize exactly one source project.",
    );
  }

  const shellIds = new Set(
    artifact.cardPlanPacket.deliveryShells.map(
      (shell) => shell.deliveryShellId,
    ),
  );
  for (const shellId of summaryPacket.deliveryShellsUsed) {
    ensure(
      shellIds.has(shellId),
      `summaryPacket references unknown delivery shell ${shellId}.`,
    );
  }

  ensure(
    summaryPacket.verifyPassed === verificationPacket.verified,
    "summaryPacket.verifyPassed must match verificationPacket.verified.",
  );

  const publicConditions = contract.runDiscipline.publicDisplayRequires;
  const missingConditions = publicConditions.filter(
    (field) => summaryPacket[field] !== true,
  );
  if (summaryPacket.publicReady === true) {
    ensure(
      missingConditions.length === 0,
      `summaryPacket.publicReady=true but these public-display conditions are false: ${missingConditions.join(", ")}`,
    );
    validateProductGatePublicReadyStatus(contract, artifact);
    ensure(
      summaryPacket.blockedBy.length === 0,
      "summaryPacket.publicReady=true requires blockedBy to be empty.",
    );
  } else if (missingConditions.length > 0) {
    ensure(
      summaryPacket.blockedBy.length >= 1,
      "summaryPacket must record blockedBy reasons when publicReady=false due to gate failure.",
    );
  }

  ensureFields(
    evolutionPacket,
    contract.protocols.evolutionWritebackPacket.requiredFields,
    "evolutionWritebackPacket",
  );
  ensureArray(
    evolutionPacket.writebacks,
    "evolutionWritebackPacket.writebacks",
  );
  ensureDecisionItems(
    evolutionPacket.retain,
    "evolutionWritebackPacket.retain",
  );
  ensureDecisionItems(
    evolutionPacket.upgrade,
    "evolutionWritebackPacket.upgrade",
  );
  ensureDecisionItems(
    evolutionPacket.retire,
    "evolutionWritebackPacket.retire",
  );
  ensureArray(evolutionPacket.scarIds, "evolutionWritebackPacket.scarIds");
  ensureEnum(
    evolutionPacket.writebackDecision,
    contract.runDiscipline.evolutionDecision.allowedDecisions,
    "evolutionWritebackPacket.writebackDecision",
  );
  ensure(
    typeof evolutionPacket.decisionReason === "string" &&
      evolutionPacket.decisionReason.trim().length >= 1,
    "evolutionWritebackPacket.decisionReason must be non-empty.",
  );
  if (evolutionPacket.writebackDecision === "writeback") {
    ensure(
      evolutionPacket.writebacks.length >= 1,
      "writebackDecision=writeback requires at least one writeback target.",
    );
  }
  if (evolutionPacket.writebacks.length > 0) {
    validateEvolutionWritebackTargets(contract, evolutionPacket.writebacks);
  }
  ensure(
    evolutionPacket.retain.length +
      evolutionPacket.upgrade.length +
      evolutionPacket.retire.length >=
      1,
    "evolutionWritebackPacket must record at least one retain/upgrade/retire decision.",
  );
}

function nestedPacket(artifact, packetName) {
  return artifact.coreLoop?.[packetName] ?? artifact[packetName] ?? null;
}

function publicReadySignals(artifact) {
  return [
    ["runHeader.publicReady", artifact.runHeader?.publicReady],
    ["summaryPacket.publicReady", artifact.summaryPacket?.publicReady],
    ["publicReadyDecision.publicReady", artifact.publicReadyDecision?.publicReady],
    [
      "coreLoop.publicReadyDecision.publicReady",
      artifact.coreLoop?.publicReadyDecision?.publicReady,
    ],
  ].filter(([, value]) => typeof value === "boolean");
}

function publicReadyClaims(artifact) {
  return publicReadySignals(artifact).filter(([, value]) => value === true);
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function validateNestedPacketConsistency(artifact, packetName) {
  const topLevel = artifact[packetName];
  const coreLoop = artifact.coreLoop?.[packetName];
  if (topLevel === undefined || coreLoop === undefined) return;
  ensure(
    canonicalJson(topLevel) === canonicalJson(coreLoop),
    `${packetName} must match coreLoop.${packetName}; top-level packets cannot mask stale or failing coreLoop truth.`,
  );
}

function validateCoreLoopPublicReadyConsistency(artifact) {
  for (const packetName of [
    "runtimeInvocationPlanPacket",
    "hostInvocationRequestPacket",
    "capabilityInvocationTruthPacket",
    "productExperiencePacket",
    "publicReadyDecision",
  ]) {
    validateNestedPacketConsistency(artifact, packetName);
  }

  const claims = publicReadyClaims(artifact);
  if (claims.length === 0) return;

  const readinessSignals = publicReadySignals(artifact);
  const falseSignals = readinessSignals.filter(([, value]) => value === false);
  ensure(
    falseSignals.length === 0,
    `${claims.map(([name]) => name).join(", ")} cannot coexist with false public-ready signals: ${falseSignals
      .map(([name]) => name)
      .join(", ")}.`,
  );

  const runtimeInvocationPlanPacket = nestedPacket(
    artifact,
    "runtimeInvocationPlanPacket",
  );
  const hostInvocationRequestPacket = nestedPacket(
    artifact,
    "hostInvocationRequestPacket",
  );
  const capabilityInvocationTruthPacket = nestedPacket(
    artifact,
    "capabilityInvocationTruthPacket",
  );
  const productExperiencePacket = nestedPacket(
    artifact,
    "productExperiencePacket",
  );
  const claimNames = claims.map(([name]) => name).join(", ");

  ensure(
    runtimeInvocationPlanPacket?.status === "pass",
    `${claimNames} requires runtimeInvocationPlanPacket.status=pass.`,
  );
  ensure(
    hostInvocationRequestPacket?.status === "pass",
    `${claimNames} requires hostInvocationRequestPacket.status=pass.`,
  );
  ensure(
    capabilityInvocationTruthPacket?.realInvocationCoverage?.status === "pass",
    `${claimNames} requires capabilityInvocationTruthPacket.realInvocationCoverage.status=pass.`,
  );
  ensure(
    productExperiencePacket?.status === "product_experience_pass",
    `${claimNames} requires productExperiencePacket.status=product_experience_pass.`,
  );

  const realCoverage = capabilityInvocationTruthPacket.realInvocationCoverage;
  const requiredFamilies = Array.isArray(realCoverage.requiredFamilies)
    ? realCoverage.requiredFamilies
    : [];
  const hostEvidenceCount = Number(realCoverage.hostEvidenceCount ?? 0);
  ensure(
    requiredFamilies.length === 0 || hostEvidenceCount > 0,
    `${claimNames} requires capabilityInvocationTruthPacket.realInvocationCoverage.hostEvidenceCount > 0 for selected executable families.`,
  );

  const invocationEvidence = Array.isArray(runtimeInvocationPlanPacket.evidence)
    ? runtimeInvocationPlanPacket.evidence
    : [];
  ensure(
    requiredFamilies.length === 0 || invocationEvidence.length > 0,
    `${claimNames} requires runtimeInvocationPlanPacket.evidence for selected executable families.`,
  );
  for (const family of requiredFamilies) {
    ensure(
      invocationEvidence.some(
        (item) =>
          item?.family === family &&
          item.passEligible === true &&
          (typeof item.evidenceRef === "string"
            ? item.evidenceRef.trim().length > 0
            : Boolean(item.evidenceRef)),
      ),
      `${claimNames} requires trusted invocation evidence for selected executable family ${family}.`,
    );
  }

  const blockingRows = (capabilityInvocationTruthPacket.rows ?? []).filter(
    (row) =>
      row?.selectedCount > 0 &&
      ["selected_not_invoked", "unavailable", "blocked"].includes(row.state),
  );
  ensure(
    blockingRows.length === 0,
    `${claimNames} cannot coexist with selected executable capability states: ${blockingRows
      .map((row) => `${row.family}:${row.state}`)
      .join(", ")}.`,
  );

  for (const row of capabilityInvocationTruthPacket.rows ?? []) {
    if (
      row?.selectedCount > 0 &&
      ["invoked", "applied"].includes(row.state)
    ) {
      ensure(
        Array.isArray(row.invocationEvidenceRefs) &&
          row.invocationEvidenceRefs.length > 0,
        `${claimNames} requires invocationEvidenceRefs for selected executable capability ${row.family}.`,
      );
    }
  }

  ensure(
    (hostInvocationRequestPacket.pendingFamilies ?? []).length === 0,
    `${claimNames} requires hostInvocationRequestPacket.pendingFamilies to be empty.`,
  );
  ensure(
    (hostInvocationRequestPacket.requests ?? []).every(
      (request) => request.status === "satisfied" && request.passEligible === true,
    ),
    `${claimNames} requires every hostInvocationRequestPacket request to be satisfied and passEligible.`,
  );

  if (artifact.publicReadyDecision && artifact.coreLoop?.publicReadyDecision) {
    ensure(
      artifact.publicReadyDecision.publicReady ===
        artifact.coreLoop.publicReadyDecision.publicReady,
      "publicReadyDecision.publicReady must match coreLoop.publicReadyDecision.publicReady.",
    );
  }
}

function validateCompactionPacket(contract, artifact) {
  const packet = artifact.compactionPacket;
  if (!packet) {
    return;
  }

  ensureFields(
    packet,
    contract.protocols.compactionPacket.requiredFields,
    "compactionPacket",
  );
  ensureString(packet.packetVersion, "compactionPacket.packetVersion");
  ensureString(packet.runRef, "compactionPacket.runRef");
  ensureString(packet.profile, "compactionPacket.profile");
  ensureString(packet.profileKey, "compactionPacket.profileKey");
  ensure(
    packet.authority === contract.protocols.compactionPacket.authorityPolicy.defaultAuthority,
    "compactionPacket.authority must be local_continuity_only.",
  );
  ensureEnum(
    packet.sourceAuthority,
    contract.protocols.compactionPacket.authorityPolicy.allowedSourceAuthority,
    "compactionPacket.sourceAuthority",
  );
  ensure(
    packet.sourceAuthorityDetail &&
      typeof packet.sourceAuthorityDetail === "object" &&
      packet.sourceAuthorityDetail.publicReadyClaimAllowed ===
        contract.protocols.compactionPacket.authorityPolicy.publicReadyClaimAllowed,
    "compactionPacket.sourceAuthorityDetail must record publicReadyClaimAllowed=false.",
  );
  ensureStringArray(packet.openFindings, "compactionPacket.openFindings");
  ensureStringArray(
    packet.pendingRevisions,
    "compactionPacket.pendingRevisions",
  );
  ensureEnum(
    packet.verifyGateState,
    contract.protocols.compactionPacket.verifyGateStateEnum,
    "compactionPacket.verifyGateState",
  );
  ensure(
    packet.singleDeliverableState &&
      typeof packet.singleDeliverableState === "object",
    "compactionPacket.singleDeliverableState must be an object.",
  );
  ensure(
    packet.summaryDelta && typeof packet.summaryDelta === "object",
    "compactionPacket.summaryDelta must be an object.",
  );
  ensure(
    packet.writebackDecision ===
      artifact.evolutionWritebackPacket.writebackDecision,
    "compactionPacket.writebackDecision must match evolutionWritebackPacket.writebackDecision.",
  );

  const pendingFindingIds = computePendingFindingIds(artifact).sort();
  const packetOpenFindings = [...packet.openFindings].sort();
  ensure(
    JSON.stringify(packetOpenFindings) === JSON.stringify(pendingFindingIds),
    `compactionPacket.openFindings must exactly match unresolved review findings (${pendingFindingIds.join(", ")}).`,
  );

  if (pendingFindingIds.length > 0) {
    ensure(
      packet.pendingRevisions.length >= 1,
      "compactionPacket.pendingRevisions must retain at least one pending revision while findings remain open.",
    );
  }

  ensure(
    packet.verifyGateState === deriveVerifyGateState(artifact),
    "compactionPacket.verifyGateState must match verificationPacket closure state.",
  );
  ensure(
    packet.singleDeliverableState.singleDeliverableMaintained ===
      artifact.summaryPacket.singleDeliverableMaintained,
    "compactionPacket.singleDeliverableState.singleDeliverableMaintained must match summaryPacket.",
  );
  ensure(
    packet.singleDeliverableState.deliverableChainClosed ===
      artifact.summaryPacket.deliverableChainClosed,
    "compactionPacket.singleDeliverableState.deliverableChainClosed must match summaryPacket.",
  );
  ensure(
    packet.summaryDelta.publicReady === artifact.summaryPacket.publicReady,
    "compactionPacket.summaryDelta.publicReady must match summaryPacket.publicReady.",
  );
  ensure(
    packet.summaryDelta.verifyPassed === artifact.summaryPacket.verifyPassed,
    "compactionPacket.summaryDelta.verifyPassed must match summaryPacket.verifyPassed.",
  );
  ensure(
    packet.summaryDelta.summaryClosed === artifact.summaryPacket.summaryClosed,
    "compactionPacket.summaryDelta.summaryClosed must match summaryPacket.summaryClosed.",
  );

  if (packet.summaryDelta.publicReady === true) {
    ensure(
      artifact.verificationPacket.verified === true &&
        pendingFindingIds.length === 0,
      "compactionPacket must not claim publicReady while verification or finding closure remains open.",
    );
  }
}

function validateRequiredPackets(contract, artifact) {
  for (const packetName of contract.runDiscipline.protocolFirst
    .requiredPackets) {
    if (
      packetName === "dispatchEnvelopePacket" &&
      !(
        contract.runDiscipline.protocolFirst
          .dispatchEnvelopePacketRequiredWhenGovernanceFlows ?? []
      ).includes(artifact.taskClassification?.governanceFlow)
    ) {
      continue;
    }
    if (
      packetName === "orchestrationTaskBoardPacket" &&
      !(
        contract.runDiscipline.protocolFirst
          .orchestrationTaskBoardPacketRequiredWhenGovernanceFlows ?? []
      ).includes(artifact.taskClassification?.governanceFlow)
    ) {
      continue;
    }
    if (
      productGatePacketNames(contract).includes(packetName) &&
      !shouldRequireProductGatePackets(contract, artifact)
    ) {
      continue;
    }
    const packet = getPacket(artifact, packetName);
    ensure(
      packet !== undefined,
      `run artifact is missing required packet ${packetName}.`,
    );
  }
}

export function validateArtifact(contract, artifact) {
  validateRequiredPackets(contract, artifact);
  ensureFields(
    artifact.runHeader,
    contract.protocols.runHeader.requiredFields,
    "runHeader",
  );
  validateTaskClassification(contract, artifact.taskClassification);
  validateFetchPacket(contract, artifact);
  validateContentEvidencePacket(contract, artifact);
  validateIntentPacketWhenRequired(contract, artifact);
  validateIntentGatePacketWhenRequired(contract, artifact);
  validatePreDecisionOptionFrame(contract, artifact);
  validateCardPlan(contract, artifact);
  validateDispatchEnvelope(contract, artifact);
  validateDispatchBoard(contract, artifact);
  validateOrchestrationTaskBoard(contract, artifact);
  validateBusinessFlowBlueprint(contract, artifact);
  validateInterfaceIntegrationContractWhenRequired(contract, artifact);
  validateProductGatePackets(contract, artifact);
  validateAgentBlueprint(contract, artifact);
  validateCapabilityGapPacketWhenRequired(contract, artifact);
  validateExecutionAgentCardWhenRequired(contract, artifact);
  validateWorkerPackets(contract, artifact);
  validateFindingChain(contract, artifact);
  validateSummaryAndEvolution(contract, artifact);
  validateCoreLoopPublicReadyConsistency(artifact);
  validateCompactionPacket(contract, artifact);
  validateHardPublicReadyTodoGate(contract, artifact);
  validateHardCommentReviewGate(contract, artifact);
}

export async function validateArtifactFile(artifactFilePath) {
  const artifactPath = path.resolve(process.cwd(), artifactFilePath);
  const artifact = await readJson(artifactPath);
  const contract = await readJson(contractPath);
  validateArtifact(contract, artifact);
  return artifact;
}

async function main() {
  if (!artifactArg) {
    fail("Usage: node scripts/validate-run-artifact.mjs <artifact.json>");
  }

  const artifactPath = path.resolve(process.cwd(), artifactArg);
  const artifact = await validateArtifactFile(artifactPath);
  const contract = await readJson(contractPath);

  console.log(
    JSON.stringify(
      {
        ok: true,
        artifact: path.relative(repoRoot, artifactPath).replace(/\\/g, "/"),
        validatedPackets: contract.runDiscipline.protocolFirst.requiredPackets,
      },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
