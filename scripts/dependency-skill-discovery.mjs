import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dependencyRootBinding } from "./managed-dependency-source.mjs";
import { inspectPlainAbsolutePath } from "./safe-managed-file-operations.mjs";
import {
  checkedPath, componentHash, stableJson, uniqueIds, stringArray, sha256,
  matchDependencyAgentContracts, readDependencyProjectOverrides,
} from "./dependency-agent-discovery.mjs";
import { repoRoot } from "./governance-lib.mjs";
import { loadMethodKnowledgeAssets } from "../src/infrastructure/capabilities/dependency-method-knowledge.mjs";

const INDEX_FIELDS = [
  "id", "summary", "useWhen", "doNotUseWhen", "input", "output",
  "permissions", "sideEffects", "humanGate", "validation",
  "componentId", "componentType", "componentVersion", "componentPath",
  "entrypoint", "componentContentSha256", "contractSha256",
];
const excluded = (project) => project.interface.invokeAs === "reference"
  || ["reference_only", "external_reference", "blocked", "blocked_for_execution"]
    .includes(project.capabilityCard?.routeEligibility);

function rootBinding(project, localOverrides, environment) {
  return dependencyRootBinding(project, localOverrides, environment);
}

function validateSkillCapability(capability) {
  assert(typeof capability.summary === "string" && capability.summary.trim(), "skill summary is required");
  for (const field of ["useWhen", "doNotUseWhen", "validation"]) stringArray(capability[field], field, true);
  for (const field of ["input", "output"]) {
    assert.equal(capability[field]?.type, "object", `skill ${field} must be an object contract`);
    stringArray(capability[field].required, `${field}.required`);
  }
  stringArray(capability.permissions, "permissions");
  stringArray(capability.sideEffects, "sideEffects");
  assert.equal(typeof capability.humanGate?.required, "boolean", "skill humanGate is required");
  stringArray(capability.humanGate.when, "humanGate.when", capability.humanGate.required);
}

async function readIndex(project, binding, projectRoot) {
  assert.equal(project.interface.capabilityIndex.format, "component-capabilities-v1", "unsupported dependency capability index format");
  assert(typeof binding.value === "string" && binding.value.trim(), "dependency root binding must be a non-empty path");
  const root = path.resolve(projectRoot, binding.value);
  assert(inspectPlainAbsolutePath(root, { kind: "directory" }), "dependency root must be a plain directory without a symlink or junction");
  const file = await checkedPath(root, project.interface.capabilityIndex.path);
  const indexBytes = await fs.readFile(file);
  const index = JSON.parse(indexBytes.toString("utf8"));
  assert.equal(index.schemaVersion, 1, "unsupported dependency capability index schema");
  uniqueIds(index.components, "index components");
  uniqueIds(index.capabilities, "index capabilities");
  assert.equal(index.componentCount, index.components.length, "index component count mismatch");
  assert.equal(index.capabilityCount, index.capabilities.length, "index capability count mismatch");
  for (const entry of index.capabilities) {
    assert(typeof entry.summary === "string" && entry.summary.trim(), "index capability summary is required");
    stringArray(entry.useWhen, "index capability useWhen", true);
    assert(typeof entry.componentId === "string" && entry.componentId.trim(), "index capability componentId is required");
    assert(typeof entry.componentType === "string" && entry.componentType.trim(), "index capability componentType is required");
  }
  return { project, root, index, indexPath: file, indexSha256: sha256(indexBytes) };
}

async function readSelectedComponent(context, component, selected, projectRoot) {
  assert.equal(component.componentType, "skill", "unsupported selected component type");
  assert.equal(component.path, `skills/${component.id}`, "skill component path must match its id");
  const root = await checkedPath(context.root, component.path, true);
  const file = await checkedPath(root, "capability.json");
  const contract = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(contract.schemaVersion, 1, "unsupported skill contract schema");
  assert.equal(contract.id, component.id, "skill contract id mismatch");
  assert.equal(contract.componentType, "skill", "skill contract type mismatch");
  assert.equal(contract.componentVersion, component.componentVersion, "skill contract version mismatch");
  assert.equal(contract.entrypoint, "SKILL.md", "skill entrypoint must be SKILL.md");
  assert.equal(component.entrypoint, contract.entrypoint, "index entrypoint differs from contract");
  assert.equal(sha256(stableJson(contract)), component.contractSha256, "skill contract hash mismatch");
  assert.equal(await componentHash(root), component.contentSha256, "skill content hash mismatch; rebuild the package index after review");
  uniqueIds(contract.capabilities, "skill capabilities");
  assert.deepEqual([...component.capabilityIds].sort(), contract.capabilities.map((entry) => entry.id).sort(), "index capability ids differ from contract");
  const indexed = context.index.capabilities.filter((entry) => entry.componentId === component.id);
  assert.equal(indexed.length, contract.capabilities.length, "index capability count differs from contract");
  for (const capability of contract.capabilities) stringArray(capability.validation, "validation", true);
  assert.deepEqual(component.validation, [...new Set(contract.capabilities.flatMap((entry) => entry.validation))].sort(), "index validation differs from contract");
  const entrypointPath = await checkedPath(root, contract.entrypoint);
  const entrypointText = await fs.readFile(entrypointPath, "utf8");
  const frontmatter = entrypointText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
  assert(frontmatter, "skill prompt must have frontmatter");
  assert.equal(frontmatter.match(/^name:\s*(.+)$/mu)?.[1]?.trim(), contract.id, "skill prompt name differs from contract");
  const capabilities = [];
  for (const entry of selected) {
    const capability = contract.capabilities.find((item) => item.id === entry.capability.id);
    assert(capability, "selected capability is absent from full contract");
    validateSkillCapability(capability);
    const expected = {
      ...capability, componentId: component.id, componentType: "skill", componentVersion: contract.componentVersion,
      componentPath: component.path, entrypoint: contract.entrypoint,
      componentContentSha256: component.contentSha256, contractSha256: component.contractSha256,
    };
    // v1 indexes may omit new adapter metadata. Every existing projected field
    // still has to agree; unknown metadata is retained only from the hashed source.
    for (const field of INDEX_FIELDS) assert(Object.hasOwn(entry.capability, field), `index capability missing ${field}`);
    for (const [field, value] of Object.entries(entry.capability)) {
      assert.equal(stableJson(value), stableJson(expected[field]), `generated index differs from source contract: ${field}`);
    }
    for (const validation of capability.validation) await checkedPath(root, validation);
    capabilities.push({
      id: entry.id, capabilityId: entry.id, dependencyId: context.project.id,
      componentId: component.id, type: "skills", providerType: "skill",
      componentVersion: contract.componentVersion, componentPath: component.path, entrypoint: contract.entrypoint,
      sourceRoot: context.root, componentRoot: root, entrypointPath,
      indexPath: context.indexPath, indexSha256: context.indexSha256,
      selectedCapability: capability, sourceRef: entrypointPath, invocationPath: entrypointPath,
      contractSha256: component.contractSha256, componentContentSha256: component.contentSha256,
      permissions: capability.permissions, sideEffects: capability.sideEffects, humanGate: capability.humanGate,
      canExecute: false, invocationStatus: "not_invoked", routeEligibility: "skill_contract_candidate",
      evidence: { source: "local_dependency_skill_contract", liveVerification: false, contentDigest: sha256(entrypointText) },
    });
  }
  return {
    id: `${context.project.id}:${component.id}`, dependencyId: context.project.id,
    componentId: component.id, componentRoot: root, sourceRoot: context.root,
    indexPath: context.indexPath, indexSha256: context.indexSha256, entrypointPath,
    componentVersion: contract.componentVersion, componentPath: component.path,
    sourceRef: path.relative(projectRoot, entrypointPath).replaceAll("\\", "/"),
    fullContract: contract, entrypointText, contractSha256: component.contractSha256,
    componentContentSha256: component.contentSha256, capabilities,
    canExecute: false, invocationStatus: "not_invoked",
  };
}

// Callers using an isolated worktree must first resolve dependency declarations
// relative to their original declaring project, then pass that explicit root here.
export async function discoverDependencySkillContracts({
  request = "", capabilityNeedIds = [], projects = [], projectRoot = process.cwd(), localOverrides = {}, environment = process.env,
  indexOnly = false,
} = {}) {
  assert.equal(typeof request, "string", "request must be a string");
  stringArray(capabilityNeedIds, "capabilityNeedIds");
  const result = { skills: [], capabilities: [], sources: [], matches: [], canExecute: false, invocationStatus: "not_invoked" };
  if (!indexOnly && !capabilityNeedIds.length && !request.trim()) return result;
  const contexts = [];
  for (const project of projects.filter((entry) => entry.interface?.capabilityIndex)) {
    const binding = rootBinding(project, localOverrides, environment);
    const source = { dependencyId: project.id, sourceRef: `dependency:${project.id}/${project.interface.capabilityIndex.path}`, rootBinding: binding.source, componentReadIds: [] };
    result.sources.push(source);
    if (binding.error) { Object.assign(source, { status: "invalid", reason: binding.error }); continue; }
    if (excluded(project)) { Object.assign(source, { status: "reference_only", reason: "Dependency is not authorized for execution contract discovery." }); continue; }
    if (binding.value === undefined || binding.value === null) { Object.assign(source, { status: "not_configured", reason: "No explicit local root; no sibling or home scan attempted." }); continue; }
    try {
      contexts.push({ ...await readIndex(project, binding, projectRoot), source });
      source.status = "index_read";
    } catch (error) { Object.assign(source, { status: error.code === "ENOENT" ? "missing" : "invalid", reason: error.message }); }
  }
  if (indexOnly) {
    for (const context of contexts) {
      for (const capability of context.index.capabilities.filter(item => item.componentType === "skill")) {
        const component = context.index.components.find(item => item.id === capability.componentId && item.componentType === "skill");
        if (!component || component.path !== `skills/${component.id}` || component.entrypoint !== "SKILL.md" ||
            capability.componentPath !== component.path || capability.componentContentSha256 !== component.contentSha256 ||
            capability.contractSha256 !== component.contractSha256 || !/^[a-f0-9]{64}$/u.test(component.contentSha256 ?? "") ||
            !/^[a-f0-9]{64}$/u.test(component.contractSha256 ?? "")) continue;
        const id = `${context.project.id}:${capability.id}`;
        const sourceRef = path.relative(projectRoot, path.join(context.root, component.path, component.entrypoint)).replaceAll("\\", "/");
        const contentDigest = sha256(stableJson(capability));
        const skillContract = { schemaVersion: 1, dependencyId: context.project.id, componentId: component.id, capabilityId: id,
          componentVersion: component.componentVersion, sourceRef, indexSha256: context.indexSha256, contractSha256: component.contractSha256,
          componentContentSha256: component.contentSha256, contentDigest, contentDigestKind: "indexed_capability", sourceVerification: "index_only",
          permissions: capability.permissions, sideEffects: capability.sideEffects, humanGate: capability.humanGate };
        result.capabilities.push({ id, type: "skills", providerType: "skill", source: "dependency_skill_contract", sourceRef,
          sourceRoot: context.root, sourceKey: `dependency:${id}`, contentDigest, description: capability.summary,
          boundary: "Declared index candidate only; selected source verification and current host authorization remain separate from invocation.",
          routeEligible: true, routeEligibility: "skill_contract_candidate", skillContract, canExecute: false, invocationStatus: "not_invoked" });
      }
    }
    return result;
  }
  const candidates = contexts.flatMap((context) => context.index.capabilities.map((capability) => ({
    id: `${context.project.id}:${capability.id}`, componentId: capability.id,
    displayName: capability.summary, trigger: capability.useWhen ?? [], routeEligible: true,
    capability, context,
  })));
  const selected = new Map();
  if (capabilityNeedIds.length) {
    for (const needId of new Set(capabilityNeedIds)) {
      const matching = candidates.filter((entry) => entry.id === needId || entry.capability.id === needId);
      const entry = matching.length === 1 ? matching[0] : null;
      const status = matching.length > 1 ? "ambiguous" : !entry ? "no_match" : entry.capability.componentType !== "skill" ? "unsupported_type" : "selected";
      result.matches.push({ needId, status, selected: status === "selected" ? entry.id : null, candidates: matching.map((item) => item.id) });
      if (status === "selected") selected.set(entry.id, entry);
    }
  } else {
    // This selects which bounded source package to read, not an execution
    // owner. Current host Thinking still chooses the capability it will use.
    const match = matchDependencyAgentContracts(request, candidates, { discoveryOnly: true });
    const entry = match.selected;
    const status = !entry ? match.reason === "ambiguous_contract_matches" ? "ambiguous" : "no_match" : entry.capability.componentType !== "skill" ? "unsupported_type" : "selected";
    result.matches.push({ request, status, selected: status === "selected" ? entry.id : null, candidates: match.candidates, reason: match.reason });
    if (status === "selected") selected.set(entry.id, entry);
  }
  for (const context of contexts) {
    const entries = [...selected.values()].filter((entry) => entry.context === context);
    for (const componentId of new Set(entries.map((entry) => entry.capability.componentId))) {
      context.source.componentReadIds.push(componentId);
      try {
        const component = context.index.components.find((entry) => entry.id === componentId);
        assert(component, "selected capability component is absent from index");
        const skill = await readSelectedComponent(context, component, entries.filter((entry) => entry.capability.componentId === componentId), projectRoot);
        result.skills.push(skill);
        result.capabilities.push(...skill.capabilities);
      } catch (error) {
        context.source.status = "invalid";
        context.source.reason = error.message;
        for (const match of result.matches.filter((match) => entries.some((entry) => entry.capability.componentId === componentId && entry.id === match.selected))) {
          match.status = "invalid_contract"; match.selected = null; match.reason = error.message;
        }
      }
    }
    if (context.source.status === "index_read") context.source.status = entries.length ? "verified_local" : "no_selected_skill";
  }
  return result;
}

/** Open only an exact host-selected candidate through the existing verifier.
 * Index metadata recalls the source; it never grants tools or proves invocation. */
export async function loadDependencySkillMethod({ provider, packet = {}, projectRoot = process.cwd(), environment = process.env }) {
  assert.equal(provider?.source, "dependency_skill_contract", "Selected Skill requires a dependency source binding");
  const { projects } = JSON.parse(await fs.readFile(path.join(repoRoot, "config/capability-index/dependency-project-registry.json"), "utf8"));
  const localOverrides = await readDependencyProjectOverrides(projectRoot);
  const options = { projects, localOverrides, projectRoot, environment };
  const inventory = await discoverDependencySkillContracts({ ...options, indexOnly: true });
  const current = inventory.capabilities.filter(item => item.id === provider.id);
  assert.equal(current.length, 1, "Selected dependency Skill is unavailable or ambiguous");
  for (const field of ["contentDigest", "sourceRef", "sourceRoot"]) assert.equal(provider[field], current[0][field], `Selected Skill binding changed: ${field}`);
  for (const field of ["dependencyId", "componentId", "capabilityId", "indexSha256", "contractSha256", "componentContentSha256"]) {
    assert.equal(provider.skillContract?.[field], current[0].skillContract[field], `Selected Skill contract changed: ${field}`);
  }
  const discovered = await discoverDependencySkillContracts({ ...options, capabilityNeedIds: [provider.id] });
  const capability = discovered.capabilities.find(item => item.id === provider.id);
  const skill = discovered.skills.find(item => item.componentId === capability?.componentId && item.dependencyId === capability?.dependencyId);
  assert(skill && capability, `Selected dependency Skill source is not verified: ${discovered.sources.find(item => item.dependencyId === provider.skillContract.dependencyId)?.reason ?? "missing"}`);
  let method = null;
  try {
    method = JSON.parse(await fs.readFile(await checkedPath(skill.componentRoot, "method.json"), "utf8"));
    assert.equal(method.schemaVersion, 1, "Unsupported Skill method schema");
    assert.equal(method.roleId, skill.componentId, "Skill method identity differs from selected source");
    assert.equal(method.protocol, "host-bound-task-method-v1", "Unsupported Skill method protocol");
    stringArray(method.steps, "method.steps", true); stringArray(method.acceptance, "method.acceptance", true);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const knowledgeAssets = await loadMethodKnowledgeAssets({ componentRoot: skill.componentRoot, method, capabilityId: capability.selectedCapability.id, packet });
  assert.equal(await componentHash(skill.componentRoot), skill.componentContentSha256, "Skill source changed during handoff");
  return { ownerAgent: provider.id, componentId: skill.componentId, componentVersion: skill.componentVersion, sourceRef: provider.sourceRef, sourceText: skill.entrypointText,
    contentDigest: sha256(skill.entrypointText), componentContentSha256: skill.componentContentSha256, ownerContractSha256: skill.contractSha256,
    capabilityId: provider.id, inputContract: capability.selectedCapability.input, outputContract: capability.selectedCapability.output,
    method, methodSha256: method ? sha256(stableJson(method)) : null, knowledgeAssets,
    methodStatus: method ? "structured_method_loaded" : "legacy_skill_text_only" };
}
