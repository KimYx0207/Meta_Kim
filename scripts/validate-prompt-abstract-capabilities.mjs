#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { assert, exists, listFiles, readJson, repoPath, toPosix } from "./governance-lib.mjs";
import { getProfilePaths } from "./meta-kim-local-state.mjs";

const activeProfileDir = getProfilePaths({ repoPath: repoPath(".") }).profileDir;
const activeProfileRef = toPosix(path.relative(repoPath("."), activeProfileDir));
const resolveProfileSource = (source) => String(source)
  .replaceAll("{profile}", getProfilePaths().profile)
  .replace(/^\.meta-kim\/state\/default(?=\/|$)/u, activeProfileRef);

const contract = await readJson("config/contracts/prompt-abstract-capability-contract.json");
const skills = await readJson("config/skills.json");
const providerRegistry = await readJson("config/capability-index/provider-registry.json");
const capabilityIndex = await readJson("config/capability-index/meta-kim-capabilities.json");
const runtimeMatrix = await readJson("config/runtime-capability-matrix.json");
const dependencyRegistry = await readJson("config/capability-index/dependency-project-registry.json");
const weapons = await readJson("config/capability-index/weapon-registry.json");
const pkg = await readJson("package.json");

const REQUIRED_FAMILIES = [
  "governance-orchestration",
  "capability-discovery-and-retrieval",
  "prompt-intake-optimization",
  "planning-continuity",
  "skill-agent-tool-creation",
  "runtime-native-surfaces",
  "execution-tools-and-commands",
  "mcp-external-provider-and-plugin",
  "memory-graph-and-observability",
  "safety-hooks-and-permissions",
  "verification-eval-and-release",
  "user-interaction-and-i18n",
];

const REQUIRED_SKILL_IDS = [
  "agent-teams-playbook",
  "findskill",
  "hookprompt",
  "superpowers",
  "ecc",
  "cli-anything",
  "gstack",
  "meta-skill-creator",
];

const REQUIRED_RUNTIME_CAPABILITIES = [
  "agent",
  "subagent",
  "skill",
  "command",
  "hook",
  "MCP",
  "browser / web",
  "shell",
  "filesystem",
  "apply_patch / edit",
  "sandbox",
  "approval",
  "memory",
  "graph",
  "dependency discovery",
  "skill discovery",
  "hook discovery",
  "human confirmation trigger",
];

const REQUIRED_PROVIDER_TYPES = [
  "runtime_native",
  "canonical_agent",
  "canonical_skill",
  "external_skill",
  "plugin_marketplace",
  "plugin_bundle",
  "mcp_server",
  "hook_script",
  "command",
  "rule_file",
  "dependency_project",
  "memory_provider",
  "graph_provider",
];

const OPTIONAL_PROJECT_INVENTORY_SOURCES = new Set([
  ".mcp.json",
  ".meta-kim/state/default/capability-index/global-capabilities.json",
]);

const TARGETED_PROMPT_ASSETS = [
  "canonical/skills/same-set-reusable-flow-for-project-file-inventor/SKILL.md",
  "canonical/runtime-assets/claude/commands/meta-theory.md",
  "canonical/runtime-assets/codex/commands/meta-theory.md",
  "canonical/runtime-assets/claude/commands/save-progress/SKILL.md",
  "canonical/runtime-assets/openclaw/HEARTBEAT.template.md",
  "canonical/runtime-assets/openclaw/hooks/mcp-memory-service/HOOK.md",
  "canonical/templates/user-interaction/batch-decision-template.md",
  "canonical/templates/user-interaction/decision-template.md",
  "canonical/templates/user-interaction/notice-template.md",
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasHeading(text, heading) {
  return new RegExp(`^#{1,4}\\s+${escapeRegExp(heading)}\\b`, "im").test(text);
}

function includesAny(text, terms) {
  return terms.some((term) => new RegExp(escapeRegExp(term), "i").test(text));
}

async function readText(relativePath) {
  return fs.readFile(repoPath(relativePath), "utf8");
}

assert(contract.contractId === "prompt-abstract-capability-contract", "wrong contract id");
assert((contract.capabilityFamilies ?? []).length >= REQUIRED_FAMILIES.length, "contract has too few capability families");

const familyIds = new Set((contract.capabilityFamilies ?? []).map((family) => family.id));
for (const id of REQUIRED_FAMILIES) {
  assert(familyIds.has(id), `contract missing capability family ${id}`);
}

for (const family of contract.capabilityFamilies ?? []) {
  for (const field of ["id", "kind", "sourceRefs", "examples", "promptHardcodePolicy", "trigger", "conflictPolicy"]) {
    assert(family[field], `${family.id ?? "unknown family"} missing ${field}`);
  }
  assert(Array.isArray(family.sourceRefs) && family.sourceRefs.length > 0, `${family.id} missing sourceRefs`);
  assert(Array.isArray(family.examples) && family.examples.length > 0, `${family.id} missing examples`);
}

const conflictIds = new Set();
for (const rule of contract.hardConflictRules ?? []) {
  assert(rule.id && rule.capabilityFamily && rule.rule, "hardConflictRule missing id/family/rule");
  assert(!conflictIds.has(rule.id), `duplicate hard conflict rule ${rule.id}`);
  conflictIds.add(rule.id);
  assert(familyIds.has(rule.capabilityFamily), `${rule.id} references unknown family ${rule.capabilityFamily}`);
}
for (const id of [
  "planning-files-update-only",
  "hookprompt-no-route-override",
  "findskill-run-scoped",
  "creation-after-gap-proof",
  "native-ability-preservation",
  "provider-config-not-live-proof",
]) {
  assert(conflictIds.has(id), `contract missing hard conflict rule ${id}`);
}

for (const source of contract.inventorySources ?? []) {
  if (source.startsWith("graphify-out")) continue;
  const resolvedSource = resolveProfileSource(source);
  const sourceExists = await exists(repoPath(resolvedSource));
  if (!sourceExists && OPTIONAL_PROJECT_INVENTORY_SOURCES.has(source)) {
    continue;
  }
  assert(sourceExists, `inventory source missing ${resolvedSource}`);
}

const skillIds = new Set((skills.skills ?? []).map((skill) => skill.id));
for (const id of REQUIRED_SKILL_IDS) {
  assert(skillIds.has(id), `skills manifest missing abstract provider ${id}`);
}

const providerTypes = new Set(providerRegistry.providerTypes ?? []);
for (const type of REQUIRED_PROVIDER_TYPES) {
  assert(providerTypes.has(type), `provider registry missing provider type ${type}`);
  if (type !== "plugin_bundle") {
    assert(
      (providerRegistry.providers ?? []).some((provider) => provider.providerType === type),
      `provider registry missing provider instance for type ${type}`,
    );
  }
}

assert((providerRegistry.providers ?? []).length >= 25, "provider registry must cover at least current 25 modeled providers");
assert((capabilityIndex.summary?.totalAgents ?? 0) >= 9, "capability index must expose canonical agents");
assert((capabilityIndex.summary?.totalSkills ?? 0) >= 16, "capability index must expose skills");
assert((capabilityIndex.summary?.totalHooks ?? 0) >= 20, "capability index must expose hooks");
assert((capabilityIndex.summary?.totalMcpServers ?? 0) >= 1, "capability index must expose MCP servers");
assert((capabilityIndex.summary?.totalPlugins ?? 0) >= 3, "capability index must expose current plugin providers");
assert((capabilityIndex.summary?.totalCommands ?? 0) >= 3, "capability index must expose commands");

const runtimeCapabilityNames = new Set(runtimeMatrix.capabilityNames ?? []);
for (const capability of REQUIRED_RUNTIME_CAPABILITIES) {
  assert(runtimeCapabilityNames.has(capability), `runtime matrix missing abstract capability ${capability}`);
}

for (const runtime of runtimeMatrix.platforms ?? []) {
  const capabilities = new Map((runtime.capabilities ?? []).map((cap) => [cap.capability, cap]));
  for (const capability of REQUIRED_RUNTIME_CAPABILITIES) {
    const record = capabilities.get(capability);
    assert(record, `${runtime.platform} missing runtime capability ${capability}`);
    assert(record.support !== "unsupported", `${runtime.platform}.${capability} must be preserved, unknown, partial, or native`);
  }
}

assert((dependencyRegistry.projects ?? []).length >= REQUIRED_SKILL_IDS.length, "dependency registry lost dependency entries");
assert((weapons.weapons ?? []).length >= 6, "weapon registry lost core weapons");
assert(Object.keys(pkg.scripts ?? {}).length >= 100, "package scripts inventory unexpectedly narrow");
assert(pkg.scripts?.["meta:prompt:validate"]?.includes("validate-prompt-abstract-capabilities.mjs"), "meta:prompt:validate must include abstract capability validator");

const metaSkill = await readText("canonical/skills/meta-theory/SKILL.md");
for (const marker of [
  "Abstract foundational capability triggers",
  "capability-discovery-and-retrieval",
  "prompt-intake-optimization",
  "planning-continuity",
  "skill-agent-tool-creation",
  "runtime-native-surfaces",
  "mcp-external-provider-and-plugin",
  "verification-eval-and-release",
]) {
  assert(metaSkill.includes(marker), `meta-theory skill missing abstract capability marker ${marker}`);
}

const planningRef = await readText("canonical/skills/meta-theory/references/planning-files.md");
for (const marker of [
  "update-only continuity state",
  "Do not overwrite",
  "Do not reset",
  "task_plan.md",
  "findings.md",
  "progress.md",
]) {
  assert(new RegExp(escapeRegExp(marker), "i").test(planningRef), `planning-files reference missing ${marker}`);
}

for (const relativePath of TARGETED_PROMPT_ASSETS) {
  const text = await readText(relativePath);
  for (const heading of ["Prompt Acceptance", "Pass", "Fail", "Block", "Return to stage", "Verification", "Preserve"]) {
    assert(hasHeading(text, heading), `${relativePath} missing ${heading}`);
  }
  assert(
    includesAny(text, REQUIRED_FAMILIES),
    `${relativePath} does not bind any abstract capability family`,
  );
}

const promptAssetFiles = [
  "AGENTS.md",
  "CLAUDE.md",
  ...(await listFiles(repoPath("canonical/agents"), (file) => file.endsWith(".md"))),
  ...(await listFiles(repoPath("canonical/skills"), (file) => file.endsWith(".md"))),
  ...(await listFiles(repoPath("canonical/runtime-assets"), (file) => file.endsWith(".md"))),
  ...(await listFiles(repoPath("canonical/templates"), (file) => file.endsWith(".md"))),
].map((file) => (path.isAbsolute(file) ? toPosix(path.relative(repoPath("."), file)) : file));

const uniquePromptAssets = [...new Set(promptAssetFiles)].sort();
assert(uniquePromptAssets.length >= 36, `expected at least 36 prompt-like assets, found ${uniquePromptAssets.length}`);

const privateEvidence = [];
for (const privateDoc of [
  {
    path: "docs/prompt-acceptance-deep-research.zh-CN.md",
    markers: [
      "Abstract Capability Framework Acceptance",
      "full project capability surface",
      "36 pass, 0 partial, 0 research_required",
      "prompt-abstract-capability-contract",
    ],
  },
  {
    path: "docs/ai-native-capability-gap-mvp-prd.zh-CN.md",
    markers: [
      "版本：v0.42",
      "abstractCapabilityFrameworkPacket",
      "prompt-abstract-capability-contract",
      "36 pass、0 partial、0 research_required",
    ],
  },
]) {
  const absPath = repoPath(privateDoc.path);
  if (!(await exists(absPath))) {
    privateEvidence.push({
      path: privateDoc.path,
      status: "private_evidence_not_attached",
      requiredForPublicValidation: false,
    });
    continue;
  }
  const text = await fs.readFile(absPath, "utf8");
  for (const marker of privateDoc.markers) {
    assert(text.includes(marker), `${privateDoc.path} private evidence missing ${marker}`);
  }
  privateEvidence.push({
    path: privateDoc.path,
    status: "private_evidence_validated",
    requiredForPublicValidation: false,
  });
}

const globalInventoryPath = path.join(activeProfileDir, "capability-index", "global-capabilities.json");
if (await exists(globalInventoryPath)) {
  const globalInventory = JSON.parse(await fs.readFile(globalInventoryPath, "utf8"));
  assert((globalInventory.summary?.totalSkills ?? 0) >= 1, "global inventory exists but has no skills");
}

console.log(
  JSON.stringify(
    {
      status: "pass",
      promptLikeAssetsChecked: uniquePromptAssets.length,
      privateEvidence,
    },
    null,
    2,
  ),
);
