#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createReportContext } from "./report-context.mjs";
import {
  runtimeCapabilityNameForTool,
  runtimeRouteEligibility,
  runtimeSupportForCapability,
} from "./runtime-capability-claims.mjs";

const reportContext = createReportContext();
const REPO_ROOT = reportContext.repoRoot;
const OUTPUT_DIR = reportContext.resolveStatePath("multi-type-capability-browser");

const REQUIRED_TYPES = [
  "agent",
  "skill",
  "script",
  "command",
  "mcp_provider_tool",
  "runtime_tool",
  "plugin_connector",
  "retrieval_capability",
  "dependency_external_package",
  "worker_task_only",
];

const RUNTIME_TOOLS = [
  "shell",
  "filesystem",
  "apply_patch",
  "browser",
  "web_search",
  "url_fetch",
  "MCP",
  "memory",
  "graphify",
  "subagent",
  "approval",
  "sandbox",
];

const RETRIEVAL_CAPABILITIES = [
  "web_search",
  "url_fetch",
  "docs_lookup",
  "browser_open",
  "mcp_search",
  "plugin_search",
  "local_only",
  "user_supplied_sources",
];

const relativeToRepo = reportContext.relativeToRepo;

async function readJson(repoRelativePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(REPO_ROOT, repoRelativePath), "utf8"));
  } catch {
    return fallback;
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(repoRelativeDir, predicate = () => true) {
  const root = path.join(REPO_ROOT, repoRelativeDir);
  if (!(await pathExists(root))) return [];
  const out = [];
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (predicate(full)) {
        out.push(full);
      }
    }
  }
  await visit(root);
  return out;
}

function sanitizeSourceRef(value) {
  if (!value) return null;
  const text = String(value).replaceAll("\\", "/");
  const repo = REPO_ROOT.replaceAll("\\", "/");
  return text.startsWith(repo) ? text.replace(repo, ".") : text;
}

function candidate(id, sourceRef, extra = {}) {
  return {
    id,
    sourceRef: sanitizeSourceRef(sourceRef),
    routeEligibility: extra.routeEligibility ?? "reference",
    status: extra.status ?? "available",
    owner: extra.owner ?? null,
    invocationPath: extra.invocationPath ?? null,
    risk: extra.risk ?? [],
    runtimeSupport: extra.runtimeSupport ?? null,
    executionEligible: extra.executionEligible ?? null,
  };
}

function topCandidates(candidates, limit = 6) {
  return candidates
    .filter((item) => item.id)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit);
}

function unavailableReasons(type, candidates) {
  const reasons = [];
  if (candidates.length === 0) {
    reasons.push("no_candidate_found");
  }
  if (type === "mcp_provider_tool") {
    reasons.push("external_provider_invocation_requires_runtime_inventory_and_permission_review");
  }
  if (type === "plugin_connector") {
    reasons.push("third_party_plugins_require_trust_review_before_execution");
  }
  if (type === "retrieval_capability") {
    reasons.push("current_fact_claims_require_source_backed_fetch_before_thinking");
  }
  if (type === "dependency_external_package") {
    reasons.push("dependency_projects_are_reference_or_probe_candidates_until_contract_and_score_allow_execution");
  }
  if (type === "worker_task_only") {
    reasons.push("worker_task_only_is_run_scoped_and_must_not_be_written_to_long_term_identity");
  }
  if (type === "runtime_tool") {
    reasons.push("runtime_tool_support_is_host_and_version_dependent");
  }
  return reasons;
}

function category(type, label, candidates, notes = []) {
  const reasons = unavailableReasons(type, candidates);
  return {
    capabilityType: type,
    label,
    count: candidates.length,
    topCandidates: topCandidates(candidates),
    unavailableReasons: reasons,
    innovationNeeded: candidates.length === 0,
    innovationPolicy:
      candidates.length === 0
        ? "return CapabilityGap and create or upgrade only after Fetch evidence"
        : "reuse or bind candidate before creating a new durable capability",
    notes,
  };
}

async function agentCandidates() {
  const files = await listFiles("canonical/agents", (file) => file.endsWith(".md"));
  return files.map((file) =>
    candidate(path.basename(file, ".md"), relativeToRepo(file), {
      routeEligibility: "governance_owner",
      owner: "meta-warden",
    }),
  );
}

async function skillCandidates(skillsManifest) {
  const canonical = await listFiles("canonical/skills", (file) => path.basename(file) === "SKILL.md");
  const local = canonical.map((file) =>
    candidate(path.basename(path.dirname(file)), relativeToRepo(file), {
      routeEligibility: "callable",
      owner: "meta-artisan",
      invocationPath: "skill trigger",
    }),
  );
  const manifest = (skillsManifest.skills ?? []).map((skill) =>
    candidate(skill.id, "config/skills.json", {
      routeEligibility: "install_or_provider_validation_required",
      owner: "meta-artisan",
      risk: ["external_skill_or_plugin_review"],
    }),
  );
  return [...local, ...manifest];
}

async function scriptCandidates() {
  const files = await listFiles("scripts", (file) => file.endsWith(".mjs"));
  return files.map((file) =>
    candidate(path.basename(file, ".mjs"), relativeToRepo(file), {
      routeEligibility: "callable",
      owner: "meta-artisan",
      invocationPath: `node ${relativeToRepo(file)}`,
    }),
  );
}

function commandCandidates(packageJson) {
  return Object.keys(packageJson.scripts ?? {}).map((id) =>
    candidate(id, "package.json", {
      routeEligibility: "callable",
      owner: id.includes("test") || id.includes("check") ? "verify" : "meta-artisan",
      invocationPath: `npm run ${id}`,
      risk: id.includes("install") || id.includes("uninstall") ? ["external_or_destructive_boundary"] : [],
    }),
  );
}

function mcpCandidates(mcpJson, providerRegistry, dependencyRegistry) {
  const servers = Object.keys(mcpJson.mcpServers ?? {}).map((id) =>
    candidate(id, ".mcp.json", {
      routeEligibility: "mcp_configured",
      owner: "meta-artisan",
      invocationPath: "MCP server",
    }),
  );
  const providers = (providerRegistry.providers ?? [])
    .filter((provider) => provider.providerType === "mcp_server")
    .map((provider) =>
      candidate(provider.id, "config/capability-index/provider-registry.json", {
        routeEligibility: provider.support?.default?.state ?? "declared",
        owner: "meta-artisan",
      }),
    );
  const dependencies = (dependencyRegistry.projects ?? [])
    .filter((project) => project.source?.type === "mcp" || /mcp/i.test(project.name ?? project.id))
    .map((project) =>
      candidate(project.id, "config/capability-index/dependency-project-registry.json", {
        routeEligibility: project.capabilityCard?.routeEligibility ?? "reference",
        owner: "meta-artisan",
      }),
    );
  return [...servers, ...providers, ...dependencies];
}

export function runtimeToolCandidates(runtimeMatrix) {
  return RUNTIME_TOOLS.map((id) => {
    const matrixCapability = runtimeCapabilityNameForTool(id);
    const runtimeSupport = runtimeSupportForCapability(runtimeMatrix, matrixCapability);
    const executionEligible = Object.keys(runtimeSupport).some((runtime) =>
      runtimeRouteEligibility(runtimeMatrix, matrixCapability, runtime) === "callable");
    return candidate(id, "config/runtime-capability-matrix.json", {
      routeEligibility: executionEligible ? "callable" : "reference",
      owner: "meta-artisan",
      invocationPath: id,
      runtimeSupport,
      executionEligible,
    });
  });
}

function pluginCandidates(skillsManifest) {
  return (skillsManifest.skills ?? [])
    .filter(
      (skill) =>
        skill.installMethod === "pluginMarketplace" ||
        skill.pluginHookCompat ||
        skill.claudePlugin ||
        skill.codexPlugin ||
        skill.cursorPlugin,
    )
    .map((skill) =>
      candidate(skill.id, "config/skills.json", {
        routeEligibility: "trust_review_required",
        owner: "meta-sentinel",
        invocationPath: skill.claudePlugin ?? skill.codexPlugin ?? skill.cursorPlugin ?? null,
        risk: ["third_party_trust_review"],
      }),
    );
}

function retrievalCandidates() {
  return RETRIEVAL_CAPABILITIES.map((id) =>
    candidate(id, "canonical/skills/meta-theory/SKILL.md", {
      routeEligibility: id === "local_only" || id === "user_supplied_sources" ? "available" : "runtime_proof_required",
      owner: id === "local_only" ? "meta-librarian" : "meta-scout",
      invocationPath: id,
    }),
  );
}

function dependencyCandidates(dependencyRegistry) {
  return (dependencyRegistry.projects ?? []).map((project) =>
    candidate(project.id, "config/capability-index/dependency-project-registry.json", {
      routeEligibility: project.capabilityCard?.routeEligibility ?? project.source?.inspectionStatus ?? "reference",
      owner: "meta-artisan",
      risk: project.capabilityCard?.knownRisks ?? project.capabilityCard?.risk ?? [],
    }),
  );
}

function workerTaskOnlyCandidates(outputContract, graphContract) {
  const candidates = [];
  if (outputContract.branches?.worker_task_only || outputContract.worker_task_only) {
    candidates.push(
      candidate("worker_task_only_output_contract", "config/contracts/capability-gap-output-contract.json", {
        routeEligibility: "run_scoped",
        owner: "existing_execution_owner",
      }),
    );
  }
  if ((graphContract.nodes ?? []).some((node) => node.id === "make_worker_task")) {
    candidates.push(
      candidate("make_worker_task_graph_node", "config/contracts/capability-gap-executable-graph-contract.json", {
        routeEligibility: "run_scoped",
        owner: "meta-conductor",
      }),
    );
  }
  candidates.push(
    candidate("workerTaskPackets", "scripts/run-capability-gap-orchestration.mjs", {
      routeEligibility: "run_scoped",
      owner: "meta-conductor",
    }),
  );
  return candidates;
}

function buildMarkdown(report) {
  const lines = [
    "# Multi-Type Capability Browser",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- skillOnly: ${report.summary.skillOnly}`,
    `- capabilityTypes: ${report.summary.coveredTypes}/${report.summary.requiredTypes}`,
    "",
    "## Why This Exists",
    "",
    "P-038 makes capability inventory visible as a multi-type function stack. Skill is one capability type, not the whole capability model.",
    "",
    "| Capability Type | Count | Innovation Needed | Top Candidates | Unavailable / Risk Reasons |",
    "|---|---:|---|---|---|",
    ...report.categories.map((item) =>
      [
        item.capabilityType,
        item.count,
        String(item.innovationNeeded),
        item.topCandidates.map((candidateItem) => candidateItem.id).join(", "),
        item.unavailableReasons.join(", "),
      ].join(" | "),
    ).map((row) => `| ${row} |`),
    "",
    "## Notes",
    "",
    "- Thinking must choose from this multi-type inventory before creating or upgrading a durable capability.",
    "- Missing or unavailable candidates become CapabilityGap evidence instead of being hidden behind skill-only routing.",
  ];
  return `${lines.join("\n")}\n`;
}

async function main() {
  const [
    packageJson,
    skillsManifest,
    mcpJson,
    providerRegistry,
    dependencyRegistry,
    outputContract,
    graphContract,
    runtimeMatrix,
  ] = await Promise.all([
    readJson("package.json", { scripts: {} }),
    readJson("config/skills.json", { skills: [] }),
    readJson(".mcp.json", { mcpServers: {} }),
    readJson("config/capability-index/provider-registry.json", { providers: [] }),
    readJson("config/capability-index/dependency-project-registry.json", { projects: [] }),
    readJson("config/contracts/capability-gap-output-contract.json", {}),
    readJson("config/contracts/capability-gap-executable-graph-contract.json", { nodes: [] }),
    readJson("config/runtime-capability-matrix.json", { platforms: [] }),
  ]);

  const categories = [
    category("agent", "Governance and execution owners", await agentCandidates()),
    category("skill", "Reusable workflow and method packages", await skillCandidates(skillsManifest)),
    category("script", "Repeatable local scripts", await scriptCandidates()),
    category("command", "Package commands and local CLIs", commandCandidates(packageJson)),
    category("mcp_provider_tool", "MCP servers and provider tools", mcpCandidates(mcpJson, providerRegistry, dependencyRegistry)),
    category("runtime_tool", "Host runtime tools", runtimeToolCandidates(runtimeMatrix)),
    category("plugin_connector", "Plugins and connectors", pluginCandidates(skillsManifest)),
    category("retrieval_capability", "Research and evidence retrieval", retrievalCandidates()),
    category("dependency_external_package", "Dependency projects and external packages", dependencyCandidates(dependencyRegistry)),
    category("worker_task_only", "Run-scoped one-time worker tasks", workerTaskOnlyCandidates(outputContract, graphContract)),
  ];

  const coveredTypes = categories.filter((item) => item.count > 0).length;
  const missingTypes = categories.filter((item) => item.count === 0).map((item) => item.capabilityType);
  const report = {
    schemaVersion: "multi-type-capability-browser-v0.1",
    generatedAt: new Date().toISOString(),
    status: coveredTypes === REQUIRED_TYPES.length ? "pass" : "fail",
    summary: {
      requiredTypes: REQUIRED_TYPES.length,
      coveredTypes,
      missingTypes,
      totalCandidates: categories.reduce((sum, item) => sum + item.count, 0),
      skillOnly: false,
      skillIsOneTypeOnly: true,
      sourceRefs: [
        "canonical/agents",
        "canonical/skills",
        "scripts",
        "package.json",
        ".mcp.json",
        "config/skills.json",
        "config/capability-index/dependency-project-registry.json",
        "config/capability-index/provider-registry.json",
        "config/contracts/capability-gap-output-contract.json",
      ],
    },
    categories,
  };

  await reportContext.ensureDirectory(OUTPUT_DIR);
  const jsonPath = path.join(OUTPUT_DIR, "latest.json");
  const mdPath = path.join(OUTPUT_DIR, "latest.zh-CN.md");
  await reportContext.writeJson(jsonPath, report);
  await reportContext.writeText(mdPath, buildMarkdown(report));

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: report.status === "pass",
        report: relativeToRepo(jsonPath),
        markdown: relativeToRepo(mdPath),
        requiredTypes: report.summary.requiredTypes,
        coveredTypes: report.summary.coveredTypes,
        totalCandidates: report.summary.totalCandidates,
        skillOnly: report.summary.skillOnly,
      },
      null,
      2,
    )}\n`,
  );
  if (report.status !== "pass") {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
