import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { OS_TARGETS, RUNTIMES, toPosix } from "./governance-lib.mjs";
import { matchDependencyAgentContracts } from "./dependency-agent-matching.mjs";

export { matchDependencyAgentContracts };

const INDEX_FORMAT = "component-capabilities-v1";
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const READ_ONLY_PERMISSIONS = new Set([
  "filesystem:read-user-materials", "network:read-web-search", "network:read-web-fetch",
]);
const TOOL_PERMISSIONS = {
  Read: "filesystem:read-user-materials",
  WebSearch: "network:read-web-search",
  WebFetch: "network:read-web-fetch",
};
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Kim Service's v1 index hashes sorted JSON plus a final LF, and sorted
// component-relative file names separated from their raw bytes with NULs.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort(compare).map((key) => [key, stable(value[key])]),
  );
  return value;
}
const stableJson = (value) => JSON.stringify(stable(value), null, 2) + "\n";

function relativeSegments(value) {
  assert.equal(typeof value, "string", "component path must be a relative string");
  assert(!/[\\:\0]/u.test(value), "component path must use portable relative segments");
  const segments = value.split("/");
  assert(segments.every((part) => part && part !== "." && part !== ".."), "component path cannot escape its root");
  return segments;
}

async function checkedPath(root, relative, directory = false) {
  let current = root;
  const segments = relativeSegments(relative);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    assert(!stat.isSymbolicLink(), "component path cannot traverse a symlink or junction");
    assert(index < segments.length - 1 || directory ? stat.isDirectory() : stat.isFile(), "component path has an unexpected file type");
  }
  return current;
}

async function componentHash(root) {
  const files = [];
  async function visit(directory, prefix = "") {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      relativeSegments(name);
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file);
      assert(!stat.isSymbolicLink(), "component tree cannot contain a symlink or junction");
      if (stat.isDirectory()) await visit(file, name);
      else {
        assert(stat.isFile(), "component tree must contain only regular files");
        files.push(name);
      }
    }
  }
  await visit(root);
  const hash = createHash("sha256");
  for (const name of files.sort(compare)) {
    hash.update(name).update("\0").update(await fs.readFile(path.join(root, name))).update("\0");
  }
  return hash.digest("hex");
}

function uniqueIds(records, label) {
  assert(Array.isArray(records), `${label} must be an array`);
  const ids = records.map((entry) => entry?.id);
  assert(ids.every((id) => typeof id === "string" && ID.test(id)), `${label} contains an invalid id`);
  assert.equal(new Set(ids).size, ids.length, `${label} contains duplicate ids`);
}

function stringArray(value, label, required = false) {
  assert(Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim()), `${label} must be a string array`);
  assert(!required || value.length > 0, `${label} must not be empty`);
}

function validateCapability(capability) {
  assert(typeof capability.summary === "string" && capability.summary.trim(), "agent summary is required");
  for (const field of ["useWhen", "doNotUseWhen", "validation"]) stringArray(capability[field], field, true);
  for (const field of ["input", "output"]) {
    assert.equal(capability[field]?.type, "object", `agent ${field} must be an object contract`);
    stringArray(capability[field].required, `${field}.required`);
  }
  stringArray(capability.permissions, "permissions");
  assert(capability.permissions.every((permission) => READ_ONLY_PERMISSIONS.has(permission)), "agent contract requires unsupported execution permissions");
  assert.deepEqual(capability.sideEffects, [], "agent contract must not authorize external side effects");
  assert.equal(typeof capability.humanGate?.required, "boolean", "agent humanGate is required");
  stringArray(capability.humanGate.when, "humanGate.when", capability.humanGate.required);
}

function declaredRoot(project, localOverrides, environment) {
  const envName = project.interface.capabilityIndex.rootEnv;
  if (envName && Object.hasOwn(environment, envName)) return { value: environment[envName], source: `environment:${envName}` };
  if (Object.hasOwn(localOverrides.dependencyRoots ?? {}, project.id)) return {
    value: localOverrides.dependencyRoots[project.id], source: `.meta-kim/local.overrides.json#dependencyRoots.${project.id}`,
  };
  return { value: project.source?.localPath, source: `dependency-project-registry.json#${project.id}.source.localPath` };
}

async function readDependency(project, root, projectRoot) {
  const rootStat = await fs.lstat(root);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "dependency root must be a directory, not a symlink or junction");
  const indexFile = await checkedPath(root, project.interface.capabilityIndex.path);
  const index = JSON.parse(await fs.readFile(indexFile, "utf8"));
  assert.equal(index.schemaVersion, 1, "unsupported dependency capability index schema");
  uniqueIds(index.components, "index components");
  uniqueIds(index.capabilities, "index capabilities");
  assert.equal(index.componentCount, index.components.length, "index component count mismatch");
  assert.equal(index.capabilityCount, index.capabilities.length, "index capability count mismatch");
  const agents = [];
  const capabilities = [];
  for (const component of index.components.filter((entry) => entry.componentType === "agent")) {
    assert.equal(component.path, `agents/${component.id}`, "agent component path must match its id");
    const componentRoot = await checkedPath(root, component.path, true);
    const contractFile = await checkedPath(componentRoot, "capability.json");
    const contract = JSON.parse(await fs.readFile(contractFile, "utf8"));
    assert.equal(contract.schemaVersion, 1, "unsupported agent contract schema");
    assert.equal(contract.id, component.id, "agent contract id mismatch");
    assert.equal(contract.componentType, "agent", "agent contract type mismatch");
    assert.equal(contract.componentVersion, component.componentVersion, "agent contract version mismatch");
    assert.equal(contract.entrypoint, "AGENT.md", "agent entrypoint must be AGENT.md");
    assert.equal(component.entrypoint, contract.entrypoint, "index entrypoint differs from contract");
    assert.equal(sha256(stableJson(contract)), component.contractSha256, "agent contract hash mismatch");
    assert.equal(await componentHash(componentRoot), component.contentSha256, "agent content hash mismatch; rebuild the package index after review");
    uniqueIds(contract.capabilities, "agent capabilities");
    assert(contract.capabilities.length > 0, "agent has no capabilities");
    assert.deepEqual([...component.capabilityIds].sort(compare), contract.capabilities.map((entry) => entry.id).sort(compare), "index capability ids differ from contract");
    const indexedCapabilities = index.capabilities.filter((entry) => entry.componentId === component.id);
    assert.equal(indexedCapabilities.length, contract.capabilities.length, "index capability count differs from contract");
    const expectedValidation = [...new Set(contract.capabilities.flatMap((entry) => entry.validation))].sort(compare);
    assert.deepEqual(component.validation, expectedValidation, "index validation differs from contract");
    const entrypointPath = await checkedPath(componentRoot, contract.entrypoint);
    const prompt = await fs.readFile(entrypointPath, "utf8");
    const frontmatter = prompt.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
    assert(frontmatter, "agent prompt must have frontmatter");
    assert.equal(frontmatter.match(/^name:\s*(.+)$/mu)?.[1]?.trim(), contract.id, "agent prompt name differs from contract");
    const tools = (frontmatter.match(/^tools:\s*(.+)$/mu)?.[1] ?? "").replace(/[\[\]"']/gu, "").split(",").map((tool) => tool.trim());
    assert(tools.length > 0 && tools.every((tool) => Object.hasOwn(TOOL_PERMISSIONS, tool)), "agent tools must stay within the read-only permission contract");
    assert.deepEqual([...new Set(tools.map((tool) => TOOL_PERMISSIONS[tool]))].sort(),
      [...new Set(contract.capabilities.flatMap((capability) => capability.permissions))].sort(), "agent tools and contract permissions differ");
    const sourceRef = toPosix(path.relative(projectRoot, entrypointPath));
    const contentDigest = sha256(prompt);
    const ownerId = `${project.id}:${component.id}`;
    for (const capability of contract.capabilities) {
      validateCapability(capability);
      for (const validation of capability.validation) await checkedPath(componentRoot, validation);
      const expected = {
        ...capability, componentId: component.id, componentType: "agent", componentVersion: contract.componentVersion,
        componentPath: component.path, entrypoint: contract.entrypoint,
        componentContentSha256: component.contentSha256, contractSha256: component.contractSha256,
      };
      assert.equal(stableJson(indexedCapabilities.find((entry) => entry.id === capability.id)), stableJson(expected), "generated index differs from source contract");
      capabilities.push({
        id: `${project.id}:${capability.id}`, capabilityId: `${project.id}:${capability.id}`, type: "agent", providerType: "agent",
        sourcePath: sourceRef, sourceRef, triggerWords: [component.id, capability.summary, ...capability.useWhen],
        ownerCandidates: [ownerId], ownerBoundary: "professional_execution_contract",
        weaponCandidates: [], dependencyCandidates: [project.id],
        runtimeSupport: Object.fromEntries(RUNTIMES.map((runtime) => [runtime, "unknown"])),
        osSupport: Object.fromEntries(OS_TARGETS.map((os) => [os, "unknown"])),
        routeEligibility: "owner_contract_candidate", canExecute: false, canReview: false, canVerify: false, canCreateOrUpgrade: false,
        missingDependencies: [], missingFields: [], mustPreserve: true,
        risk: { requiresTrustReview: true, canMutateFiles: false, sideEffects: [] },
        confidence: "verified_local", invocationPath: sourceRef,
        verificationMethod: "Read the contract and run its declared checks in an isolated package copy after trust review.",
        evidence: { source: "local_dependency_contract", sourceRef, confidence: "verified_local", contentDigest, contractSha256: component.contractSha256, componentContentSha256: component.contentSha256, liveVerification: false },
        writebackKey: `dependency-agent:${project.id}:${component.id}`,
        reason: "Source contract and component bytes match the index; selection remains run-scoped and does not prove native loading or invocation.",
      });
    }
    agents.push({
      id: ownerId, componentId: component.id, dependencyId: project.id, layer: "execution",
      displayName: prompt.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? contract.capabilities[0].summary.split(/[：:]/u)[0],
      source: "dependency_agent_contract", sourceClass: "external_dependency", sourceRef,
      sourceRoot: toPosix(path.relative(projectRoot, root)), sourceKey: `${project.id}:agent:${component.id}:${contentDigest}`,
      contentDigest, description: contract.capabilities.map((entry) => entry.summary).join("; "),
      trigger: contract.capabilities.flatMap((entry) => entry.useWhen),
      boundary: contract.capabilities.flatMap((entry) => entry.doNotUseWhen),
      executionBlock: false, routeEligible: true,
      ownerBindingMode: "run_scoped_owner_contract", nativeAgentType: null, validCustomAgentDefinition: false,
      ownerContract: {
        dependencyId: project.id, sourceRef, contentDigest, componentContentSha256: component.contentSha256,
        ...(contract.capabilities.length === 1 ? contract.capabilities[0] : {}), capabilities: contract.capabilities,
        reviewOwner: "meta-prism", verificationOwner: "meta-prism",
        runtimeStatus: "needs_probe", invocationStatus: "not_invoked",
      },
    });
  }
  return { agents, capabilities };
}

export async function discoverDependencyAgentContracts({ projects = [], projectRoot = process.cwd(), localOverrides = {}, environment = process.env } = {}) {
  const result = { agents: [], capabilities: [], sources: [] };
  for (const project of projects.filter((entry) => entry.interface?.capabilityIndex)) {
    const binding = declaredRoot(project, localOverrides, environment);
    const source = { dependencyId: project.id, sourceRef: `dependency:${project.id}/${project.interface.capabilityIndex.path}`, rootBinding: binding.source };
    if (project.interface.invokeAs === "reference"
      || ["reference_only", "external_reference", "blocked", "blocked_for_execution"].includes(project.capabilityCard?.routeEligibility)) {
      result.sources.push({ ...source, status: "reference_only", reason: "The dependency registry does not authorize owner-contract selection from this project." });
      continue;
    }
    if (binding.value === null || binding.value === undefined) {
      result.sources.push({ ...source, status: "not_configured", reason: "No explicit local dependency root; no sibling or home scan was attempted." });
      continue;
    }
    try {
      assert.equal(project.interface.capabilityIndex.format, INDEX_FORMAT, "unsupported dependency capability index format");
      assert(typeof binding.value === "string" && binding.value.trim(), "dependency root binding must be a non-empty path");
      const discovered = await readDependency(project, path.resolve(projectRoot, binding.value), projectRoot);
      result.agents.push(...discovered.agents);
      result.capabilities.push(...discovered.capabilities);
      result.sources.push({ ...source, status: "verified_local", agentCount: discovered.agents.length, reason: "Index, contracts and component hashes agree; no dependency code was executed." });
    } catch (error) {
      result.sources.push({ ...source, status: error.code === "ENOENT" ? "missing" : "invalid", reason: error.message });
    }
  }
  return result;
}
