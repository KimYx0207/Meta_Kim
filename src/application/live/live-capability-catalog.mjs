import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Read-only, repository-declared capability directory for the Live sidebar.
 *
 * These records are registration evidence, never proof that a host installed,
 * loaded or invoked a capability. Actual worker / tool / skill use must come
 * from the run-scoped Live projection and its native observation evidence.
 */
export const LIVE_CAPABILITY_CATALOG_SCHEMA_VERSION = 1;
export const LIVE_CAPABILITY_CATALOG_INDEX = "config/capability-index/meta-kim-capabilities.json";
export const LIVE_CAPABILITY_CATALOG_AGENT_POLICY = "config/capability-index/agent-eligibility.json";

const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_REGISTRY_BYTES = 512 * 1024;
const MAX_ITEMS_PER_KIND = 128;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:@+/-]{0,119}$/u;
const SECRET_IDENTIFIER_PATTERN = /^(?:gh[pousr]_|github_pat_|sk-|AKIA|ASIA)[a-zA-Z0-9_-]{8,}$/u;
const GROUPS = Object.freeze([
  ["agents", "agents"],
  ["skills", "skills"],
  ["hooks", "hooks"],
  ["mcpServers", "mcpServers"],
  ["mcpTools", "mcpTools"],
  ["plugins", "plugins"],
  ["commands", "commands"],
]);

function safeIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !IDENTIFIER_PATTERN.test(normalized) ||
    normalized.includes("..") ||
    normalized.includes("//") ||
    normalized.includes("\\") ||
    normalized.includes("/") ||
    SECRET_IDENTIFIER_PATTERN.test(normalized) ||
    normalized.toLowerCase().includes("token") ||
    normalized.toLowerCase().includes("secret") ||
    normalized.toLowerCase().includes("password")
  ) return null;
  return normalized;
}

function safeIdList(values, limit = 10) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(safeIdentifier).filter(Boolean))].slice(0, limit);
}

function canonicalAgentPolicy(policy) {
  const result = new Map();
  for (const tier of ["eligible", "conditional", "hard_reject"]) {
    const records = policy?.tiers?.[tier]?.agents;
    if (!Array.isArray(records)) continue;
    for (const candidate of records.slice(0, MAX_ITEMS_PER_KIND)) {
      const id = safeIdentifier(candidate?.id);
      if (!id || result.has(id)) continue;
      result.set(id, {
        eligibilityTier: tier,
        role: safeIdentifier(candidate?.role),
        owns: safeIdList(candidate?.owns),
      });
    }
  }
  return result;
}

function safeGeneratedAt(value) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/** Pure projection; can be unit-tested without filesystem or run-state access. */
export function projectLiveCapabilityCatalog(index, agentPolicy) {
  const agentsById = canonicalAgentPolicy(agentPolicy);
  const projection = {
    schemaVersion: LIVE_CAPABILITY_CATALOG_SCHEMA_VERSION,
    source: "repository_registry",
    evidenceLevel: "registered_only",
    observedRuntime: false,
    generatedAt: safeGeneratedAt(index?.generatedAt),
    agents: [],
    skills: [],
    hooks: [],
    mcpServers: [],
    mcpTools: [],
    plugins: [],
    commands: [],
    counts: {},
    provenance: {
      index: LIVE_CAPABILITY_CATALOG_INDEX,
      agentPolicy: LIVE_CAPABILITY_CATALOG_AGENT_POLICY,
    },
  };

  for (const [sourceKind, outputKind] of GROUPS) {
    const rawEntries = index?.byCapabilityType?.[sourceKind];
    const seen = new Set();
    const candidates = rawEntries && typeof rawEntries === "object" && !Array.isArray(rawEntries)
      ? Object.entries(rawEntries).slice(0, MAX_ITEMS_PER_KIND)
      : [];

    const rows = [];
    for (const [, candidate] of candidates) {
      const id = safeIdentifier(candidate?.id);
      const namespace = safeIdentifier(candidate?.namespace);
      if (!id || !namespace || seen.has(`${namespace}:${id}`)) continue;
      seen.add(`${namespace}:${id}`);

      const row = {
        key: `${sourceKind}:${namespace}:${id}`,
        id,
        label: id,
        namespace,
        registrationState: "registered",
        invocationState: "not_observed",
      };

      if (sourceKind === "agents") {
        const registration = agentsById.get(id);
        if (!registration || candidate?.layer !== "meta") continue;
        row.role = registration.role;
        row.owns = registration.owns;
        row.eligibilityTier = registration.eligibilityTier;
        row.agentKind = "canonical_meta_agent";
      } else if (sourceKind === "skills") {
        // Many indexed "skills" are supporting references, not callable SKILL.md entries.
        row.referenceOnly = namespace === "canonical-reference";
        row.capabilityKind = row.referenceOnly ? "skill_reference" : "skill_package";
      } else if (sourceKind === "plugins") {
        row.runtimeTargets = safeIdList(candidate?.runtimeTargets, 20);
        row.routeEligibility = safeIdentifier(candidate?.routeEligibility);
      } else if (sourceKind === "mcpTools") {
        const colon = id.indexOf(":");
        row.serverId = colon > 0 ? safeIdentifier(id.slice(0, colon)) : null;
      }

      // Registry keys, on-disk paths, activation config and provider arguments
      // are deliberately not copied into this HTTP-facing public projection.
      rows.push(row);
    }
    rows.sort((left, right) => left.id.localeCompare(right.id) || left.namespace.localeCompare(right.namespace));
    projection[outputKind] = rows;
    projection.counts[outputKind] = rows.length;
  }

  projection.counts.callableSkillPackages = projection.skills.filter((skill) => !skill.referenceOnly).length;
  projection.counts.skillReferences = projection.skills.filter((skill) => skill.referenceOnly).length;
  // A Subagent is a live runtime child, not a separate persistent Meta identity.
  // Populate it solely from actual run worker nodes in /api/snapshot.
  projection.subagents = [];
  projection.counts.subagents = null;
  projection.subagentSource = "run_observation_only";
  return projection;
}

async function readBoundedJson(projectRoot, relativePath) {
  const file = path.join(projectRoot, relativePath);
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_REGISTRY_BYTES) {
    throw new Error(`Capability catalog source is missing or oversized: ${relativePath}`);
  }
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * @param {{projectRoot?: string}} [options]
 * @returns {Promise<ReturnType<typeof projectLiveCapabilityCatalog>>}
 */
export async function loadLiveCapabilityCatalog({ projectRoot = DEFAULT_PROJECT_ROOT } = {}) {
  const [index, agentPolicy] = await Promise.all([
    readBoundedJson(projectRoot, LIVE_CAPABILITY_CATALOG_INDEX),
    readBoundedJson(projectRoot, LIVE_CAPABILITY_CATALOG_AGENT_POLICY),
  ]);
  return projectLiveCapabilityCatalog(index, agentPolicy);
}
