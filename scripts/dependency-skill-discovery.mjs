import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  checkedPath, componentHash, stableJson, uniqueIds, stringArray, sha256,
  matchDependencyAgentContracts,
} from "./dependency-agent-discovery.mjs";

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
  const envName = project.interface.capabilityIndex.rootEnv;
  if (envName && Object.hasOwn(environment, envName)) return { value: environment[envName], source: `environment:${envName}` };
  if (Object.hasOwn(localOverrides.dependencyRoots ?? {}, project.id)) return {
    value: localOverrides.dependencyRoots[project.id], source: `.meta-kim/local.overrides.json#dependencyRoots.${project.id}`,
  };
  return { value: project.source?.localPath, source: `dependency-project-registry.json#${project.id}.source.localPath` };
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
  const stat = await fs.lstat(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), "dependency root must be a directory, not a symlink or junction");
  const real = await fs.realpath(root);
  assert.equal(process.platform === "win32" ? real.toLowerCase() : real,
    process.platform === "win32" ? root.toLowerCase() : root, "dependency root cannot traverse a symlink or junction");
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
} = {}) {
  assert.equal(typeof request, "string", "request must be a string");
  stringArray(capabilityNeedIds, "capabilityNeedIds");
  const result = { skills: [], capabilities: [], sources: [], matches: [], canExecute: false, invocationStatus: "not_invoked" };
  if (!capabilityNeedIds.length && !request.trim()) return result;
  const contexts = [];
  for (const project of projects.filter((entry) => entry.interface?.capabilityIndex)) {
    const binding = rootBinding(project, localOverrides, environment);
    const source = { dependencyId: project.id, sourceRef: `dependency:${project.id}/${project.interface.capabilityIndex.path}`, rootBinding: binding.source, componentReadIds: [] };
    result.sources.push(source);
    if (excluded(project)) { Object.assign(source, { status: "reference_only", reason: "Dependency is not authorized for execution contract discovery." }); continue; }
    if (binding.value === undefined || binding.value === null) { Object.assign(source, { status: "not_configured", reason: "No explicit local root; no sibling or home scan attempted." }); continue; }
    try {
      contexts.push({ ...await readIndex(project, binding, projectRoot), source });
      source.status = "index_read";
    } catch (error) { Object.assign(source, { status: error.code === "ENOENT" ? "missing" : "invalid", reason: error.message }); }
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
    const match = matchDependencyAgentContracts(request, candidates);
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
