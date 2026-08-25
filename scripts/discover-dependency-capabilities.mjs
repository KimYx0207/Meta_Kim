#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { OS_TARGETS, RUNTIMES, exists, listFiles, readJson, repoPath, stateDir, toPosix, writeJson } from "./governance-lib.mjs";
import { CATEGORIES, directoryClosureSync, manifestPathFor, readManifest } from "./install-manifest.mjs";
import {
  buildOwnershipReceipt,
  classifyDependencyLifecycle,
  lifecycleRouteEligibility,
} from "./dependency-lifecycle.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const checkMode = args.includes("--check");
const projectArgIndex = args.indexOf("--project");
const projectFilter = projectArgIndex >= 0 ? args[projectArgIndex + 1] : null;
const outputPath = path.join(stateDir, "dependency-capability-index.json");

function supportMap(defaultRuntime = "partial", defaultOs = "partial") {
  return {
    runtimeSupport: Object.fromEntries(RUNTIMES.map((runtime) => [runtime, defaultRuntime])),
    osSupport: Object.fromEntries(OS_TARGETS.map((target) => [target, defaultOs])),
  };
}

function routeEligibilityFromScore(score, invokeAs) {
  if (invokeAs === "reference" || invokeAs === "notInvokable") return "reference_only";
  if (score >= 85) return "callable";
  if (score >= 70) return "confirm_or_fetch_more";
  if (score >= 50) return "needs_upgrade_or_probe";
  return "blocked_for_execution";
}

async function readIfExists(file) {
  return (await exists(repoPath(file))) ? fs.readFile(repoPath(file), "utf8") : "";
}

async function discoverSkillDirs() {
  const roots = [
    "canonical/skills",
    ".claude/skills",
    ".agents/skills",
    ".cursor/skills",
    "openclaw/skills",
  ];
  const globalRoots = [
    { runtime: "claude", root: path.join(os.homedir(), ".claude", "skills"), publicRoot: "~/.claude/skills" },
    { runtime: "codex", root: path.join(os.homedir(), ".codex", "skills"), publicRoot: "~/.codex/skills" },
    { runtime: "codex", root: path.join(os.homedir(), ".agents", "skills"), publicRoot: "~/.agents/skills" },
    { runtime: "cursor", root: path.join(os.homedir(), ".cursor", "skills"), publicRoot: "~/.cursor/skills" },
    { runtime: "openclaw", root: path.join(os.homedir(), ".openclaw", "skills"), publicRoot: "~/.openclaw/skills" },
  ];
  const records = [];
  for (const root of roots) {
    for (const file of await listFiles(repoPath(root), (candidate) => path.basename(candidate) === "SKILL.md")) {
      records.push({
        id: path.basename(path.dirname(file)),
        source: root,
        path: toPosix(path.relative(repoPath("."), file)),
        absolutePath: file,
        skillRoot: path.dirname(file),
        runtime: null,
        scope: "project",
      });
    }
  }
  for (const { root, runtime, publicRoot } of globalRoots) {
    if (!(await exists(root))) continue;
    for (const file of await listFiles(root, (candidate) => path.basename(candidate) === "SKILL.md")) {
      records.push({
        id: path.basename(path.dirname(file)),
        source: publicRoot,
        path: `${publicRoot}/${toPosix(path.relative(root, file))}`,
        absolutePath: file,
        skillRoot: path.dirname(file),
        runtime,
        scope: "global",
      });
    }
  }
  return records;
}

function publicSkillDirRecord(record) {
  const { absolutePath, skillRoot, ...publicRecord } = record;
  return publicRecord;
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => {
    const resolved = path.resolve(value).replaceAll("\\", "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const a = normalize(left);
  const b = normalize(right);
  return a === b;
}

function manifestOwnershipForSkill(record, manifest) {
  if (record.scope !== "global" || !manifest) return null;
  const entry = (manifest.entries ?? []).find((candidate) => {
    if (candidate.category !== CATEGORIES.A || candidate.kind !== "dir") return false;
    if (!samePath(candidate.path, record.skillRoot)) return false;
    if (![
      `${record.id}-global-skill`,
      `${record.runtime}-global-skill`,
    ].includes(candidate.purpose)) return false;
    const closure = directoryClosureSync(record.skillRoot);
    return Boolean(
      closure &&
      closure.sha256 === candidate.directoryClosureSha256 &&
      closure.entryCount === candidate.directoryClosureEntryCount,
    );
  });
  if (!entry) return null;
  return buildOwnershipReceipt({
    manifest,
    entry,
    runtime: record.runtime,
    path: record.skillRoot,
    userHome: os.homedir(),
    repoRoot: repoPath("."),
  });
}

function lifecycleForProject(project, skillDirs, globalManifest) {
  const available = skillDirs.filter((record) => record.id === project.id);
  const managed = available
    .map((record) => manifestOwnershipForSkill(record, globalManifest))
    .find(Boolean) ?? null;
  const declaredReference =
    project.invokeAs === "reference" ||
    project.invokeAs === "notInvokable" ||
    project.routeEligibility === "reference_only";
  const lifecycleState = classifyDependencyLifecycle({
    providerId: project.id,
    isReference: declaredReference,
    isAvailable: available.length > 0,
    managedReceipt: managed,
  });
  return {
    ...project,
    lifecycleState,
    installedStatus: lifecycleState,
    lifecycleEvidence: {
      available: available.length > 0,
      managedOwnership: Boolean(managed),
      activeForRun: false,
    },
    ...(managed ? { ownershipReceipt: managed } : {}),
    routeEligibility: lifecycleRouteEligibility({
      lifecycleState,
      declaredRouteEligibility: project.routeEligibility,
    }),
  };
}

async function discoverGithubUrls() {
  const files = ["README.md", "README.zh-CN.md", "AGENTS.md", "CLAUDE.md", "setup.mjs"];
  const docs = await listFiles(repoPath("docs/research"), (file) => file.endsWith(".md"));
  const allFiles = [...files.map(repoPath), ...docs];
  const urls = new Set();
  for (const file of allFiles) {
    if (!(await exists(file))) continue;
    const text = await fs.readFile(file, "utf8");
    for (const match of text.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g)) urls.add(match[0]);
  }
  return [...urls].map((uri) => ({ uri, source: "docs_or_readme" }));
}

async function discoverMcpServers() {
  const files = [".mcp.json", ".cursor/mcp.json", ".codex/config.toml"];
  const records = [];
  for (const file of files) {
    const text = await readIfExists(file);
    if (!text) continue;
    const jsonServers = [...text.matchAll(/"([^"]+)":\s*\{/g)].map((match) => match[1]);
    const tomlServers = [...text.matchAll(/\[mcp_servers\.([^\]]+)\]/g)].map((match) => match[1]);
    for (const id of [...jsonServers, ...tomlServers]) records.push({ id, source: file });
  }
  return records;
}

function normalizeProject(project, extra = {}) {
  const score = project.scoring?.overall ?? extra.reuseScore ?? 50;
  const invokeAs = project.interface?.invokeAs ?? extra.invokeAs ?? "reference";
  const compatibility = supportMap("partial", "partial");
  const runtimeSupport = project.runtimeSupport ?? Object.fromEntries(RUNTIMES.map((runtime) => [
    runtime,
    project.interface?.requiredRuntime?.includes(runtime) ? "partial" : "unknown",
  ]));
  const osSupport = project.osSupport ?? compatibility.osSupport;
  const routeEligibility = project.capabilityCard?.routeEligibility ?? routeEligibilityFromScore(score, invokeAs);
  return {
    id: project.id,
    name: project.name ?? project.id,
    source: project.source ?? extra.source ?? { type: "unknown", uri: null, localPath: null, inspectionStatus: "unknown" },
    sourceType: project.source?.type ?? extra.sourceType ?? "unknown",
    inspectionStatus: project.source?.inspectionStatus ?? extra.inspectionStatus ?? "unknown",
    canDo: project.capabilityCard?.canDo ?? project.capabilityCard?.taskShapes ?? extra.canDo ?? [],
    canNotDo: project.capabilityCard?.canNotDo ?? project.capabilityCard?.notFor ?? extra.canNotDo ?? [],
    inputContract: project.capabilityCard?.inputContract ?? extra.inputContract ?? {},
    outputContract: project.capabilityCard?.outputContract ?? extra.outputContract ?? {},
    invokeAs,
    runtimeSupport,
    osSupport,
    verificationMethod: project.capabilityCard?.verificationMethod ?? project.capabilityCard?.verificationMethods?.[0] ?? extra.verificationMethod ?? null,
    risk: project.capabilityCard?.risk ?? project.capabilityCard?.knownRisks ?? extra.risk ?? [],
    reuseScore: score,
    routeEligibility,
    invocationPath: project.interface?.invocationPath ?? project.interface?.preferredWeaponId ?? extra.invocationPath ?? null,
    writebackKey: project.capabilityCard?.writebackKey ?? `dependency:${project.id}`,
    taskShapes: project.capabilityCard?.taskShapes ?? extra.taskShapes ?? [],
    triggerConditions: project.capabilityCard?.triggerConditions ?? extra.triggerConditions ?? [],
    notFor: project.capabilityCard?.notFor ?? project.capabilityCard?.canNotDo ?? extra.notFor ?? [],
    lastInspectedAt: project.source?.lastInspectedAt ?? null,
    evidenceConfidence: project.supportEvidence?.confidence ?? (project.source?.inspectionStatus === "inspected" ? "verified_local" : "repo_claim"),
    supportEvidence: project.supportEvidence ?? { source: project.source?.type === "github" ? "external_reference" : "local_file", confidence: project.source?.inspectionStatus === "inspected" ? "verified_local" : "repo_claim", verificationCommand: null, lastVerifiedAt: project.source?.lastInspectedAt ?? null },
    installedStatus: extra.installedStatus ?? "unknown",
    missingFields: [],
    recommendedUpgrade: [],
  };
}

function annotateMissing(project) {
  const required = ["canDo", "canNotDo", "inputContract", "outputContract", "triggerConditions", "verificationMethod", "risk", "routeEligibility", "notFor", "writebackKey"];
  for (const field of required) {
    if (project[field] === null || project[field] === undefined || (Array.isArray(project[field]) && project[field].length === 0) || (typeof project[field] === "object" && !Array.isArray(project[field]) && Object.keys(project[field]).length === 0)) {
      project.missingFields.push(field);
    }
  }
  if (["callable", "eligible_for_route", "installed_skill_candidate", "local_inspected_protocol"].includes(project.routeEligibility)) {
    if (!project.invocationPath) project.missingFields.push("invocationPath");
    if (!project.verificationMethod) project.missingFields.push("verificationMethod");
  }
  if (project.reuseScore < 50) project.recommendedUpgrade.push("blocked_for_execution: keep as evidence/reference and add contract before routing");
  else if (project.reuseScore < 70) project.recommendedUpgrade.push("needs_upgrade_or_probe: add invocationPath or verificationMethod");
  else if (project.reuseScore < 85) project.recommendedUpgrade.push("confirm_or_fetch_more: require decision card or more evidence");
  return project;
}

async function kimDecisionRecord() {
  const roots = [
    ...(process.env.META_KIM_DEP_ROOTS ? process.env.META_KIM_DEP_ROOTS.split(path.delimiter) : []),
    path.resolve(repoPath(".."), "Kim_Decision"),
  ];
  let foundPath = null;
  for (const root of roots) {
    if (root && (await exists(root))) {
      foundPath = root;
      break;
    }
  }
  const skillPath = foundPath ? path.join(foundPath, ".agents", "skills", "Kim", "SKILL.md") : null;
  const hasSkill = skillPath ? await exists(skillPath) : false;
  return annotateMissing({
    id: "kim-decision",
    name: "Kim_Decision",
    source: { type: foundPath ? "local" : "github_or_unknown", uri: "https://github.com/KimYx0207/Kim_Decision", localPath: foundPath ? toPosix(path.relative(repoPath("."), foundPath)) : null, inspectionStatus: foundPath ? "local_inspected_protocol" : "needs_probe" },
    sourceType: foundPath ? "local" : "github",
    inspectionStatus: foundPath ? "local_inspected_protocol" : "needs_probe",
    canDo: ["realIntent judgment", "subject path mapping", "evidence labeling", "minimum test", "pass/kill condition", "public-ready intent acceptance review"],
    canNotDo: ["direct code implementation", "code executor", "security approval", "runtime hook install", "MCP server startup", "universal owner"],
    inputContract: { requires: ["decision question", "evidence labels", "constraints"] },
    outputContract: { produces: ["decision rationale", "minimum test", "passSignal", "killSignal"] },
    invokeAs: hasSkill ? "skill" : "reference",
    runtimeSupport: Object.fromEntries(RUNTIMES.map((runtime) => [runtime, hasSkill ? "partial" : "unknown"])),
    osSupport: Object.fromEntries(OS_TARGETS.map((target) => [target, foundPath ? "partial" : "unknown"])),
    verificationMethod: hasSkill ? "read installed skill and run dependency compatibility validator" : "probe META_KIM_DEP_ROOTS or installed skill paths",
    risk: ["not_for_code_execution", "requires_owner_weapon_verification_route"],
    reuseScore: hasSkill || foundPath ? 82 : 55,
    routeEligibility: hasSkill ? "installed_skill_candidate" : foundPath ? "local_inspected_protocol" : "needs_probe",
    invocationPath: hasSkill ? toPosix(path.relative(repoPath("."), skillPath)) : null,
    writebackKey: "dependency:kim-decision-state-machine",
    taskShapes: ["strategy_product_decision", "intent_acceptance", "path_selection"],
    triggerConditions: ["realIntent unclear", "minimum test needed", "pass/kill condition needed"],
    notFor: ["code execution", "implementation owner", "security approval", "runtime install"],
    lastInspectedAt: foundPath ? new Date().toISOString() : null,
    evidenceConfidence: foundPath ? "verified_local" : "unverified",
    supportEvidence: { source: foundPath ? "local_file" : "external_reference", confidence: foundPath ? "verified_local" : "unverified", verificationCommand: null, lastVerifiedAt: foundPath ? new Date().toISOString() : null },
    installedStatus: hasSkill ? "installed_skill_candidate" : foundPath ? "local_inspected_protocol" : "needs_probe",
    missingFields: [],
    recommendedUpgrade: [],
  });
}

async function discover() {
  const registry = await readJson("config/capability-index/dependency-project-registry.json");
  const skills = await readJson("config/skills.json");
  const pkg = await readJson("package.json");
  const setupText = await readIfExists("setup.mjs");
  const skillDirs = await discoverSkillDirs();
  const githubUrls = await discoverGithubUrls();
  const mcpServers = await discoverMcpServers();
  const globalManifest = readManifest(manifestPathFor("global"));
  const registryProjects = (registry.projects ?? []).map((project) => annotateMissing(normalizeProject(project)));
  const manifestProjects = (skills.skills ?? []).map((skill) => {
    const existing = registryProjects.find((project) => project.id === skill.id);
    if (existing) return null;
    const installed = skillDirs.find((entry) => entry.id === skill.id);
    return annotateMissing(normalizeProject({
      id: skill.id,
      name: skill.id,
      source: { type: "installed_skill", uri: skill.repo ?? skill.upstreamPackage ?? skill.claudePlugin ?? null, localPath: installed?.path ?? null, inspectionStatus: installed ? "installed_skill_candidate" : "external_reference" },
      capabilityCard: {
        canDo: skill.capabilities ?? ["skill capability from config/skills.json"],
        canNotDo: ["unverified direct execution without invocation and verification"],
        inputContract: { requires: ["task matching skill capability"] },
        outputContract: { produces: ["skill-specific artifact"] },
        triggerConditions: [skill.id],
        verificationMethod: "npm run meta:deps:compat",
        risk: ["third_party_skill_requires_trust_review"],
        routeEligibility: installed ? "installed_skill_candidate" : "external_reference",
        notFor: ["automatic execution without trust review"],
        taskShapes: ["external_capability"],
        writebackKey: `dependency:${skill.id}`,
      },
      interface: { invokeAs: installed ? "skill" : "reference", invocationPath: installed?.path ?? null },
      scoring: { overall: installed ? 78 : 62 },
      runtimeSupport: Object.fromEntries(RUNTIMES.map((runtime) => [runtime, (skill.targets ?? []).includes(runtime.replace("_code", "")) || (skill.targets ?? []).includes(runtime) ? "partial" : "unknown"])),
      osSupport: Object.fromEntries(OS_TARGETS.map((target) => [target, "partial"])),
    }, { installedStatus: installed?.installedStatus ?? "external_reference" }));
  }).filter(Boolean);
  const dynamicProjects = [];
  if (!registryProjects.some((project) => project.id === "kim-decision")) {
    dynamicProjects.push(await kimDecisionRecord());
  }
  const discoveredDependencyProjects = [...registryProjects, ...manifestProjects, ...dynamicProjects]
    .map((project) => lifecycleForProject(project, skillDirs, globalManifest))
    .filter((project) => !projectFilter || project.id === projectFilter || project.name.toLowerCase().includes(projectFilter.toLowerCase()));
  return {
    generatedAt: new Date().toISOString(),
    scannedSources: {
      registry: "config/capability-index/dependency-project-registry.json",
      skillsManifestCount: skills.skills?.length ?? 0,
      packageScripts: Object.keys(pkg.scripts ?? {}),
      setupExternalMentions: [...setupText.matchAll(/github|pip|npm|mcp|graphify|memory/gi)].length,
      skillDirs: skillDirs.map(publicSkillDirRecord),
      githubUrls,
      mcpServers,
      docsResearchDependencies: (await listFiles(repoPath("docs/research/dependencies"), (file) => file.endsWith(".md"))).map((file) => toPosix(path.relative(repoPath("."), file))),
      docsResearchPlatforms: (await listFiles(repoPath("docs/research/platforms"), (file) => file.endsWith(".md"))).map((file) => toPosix(path.relative(repoPath("."), file))),
    },
    manifestDependencies: skills.skills ?? [],
    discoveredDependencyProjects,
    localDependencyProjects: discoveredDependencyProjects.filter((project) => ["local", "mcp", "script"].includes(project.sourceType)),
    externalDependencyProjects: discoveredDependencyProjects.filter((project) => !["local", "mcp", "script"].includes(project.sourceType)),
    rankedRoutes: discoveredDependencyProjects.filter((project) =>
      ["installed_provider", "active_for_run"].includes(project.lifecycleState) &&
      !["reference_only", "external_reference", "blocked_for_execution", "needs_probe", "available_not_installed"].includes(project.routeEligibility),
    ),
  };
}

function validateIndex(index) {
  for (const project of index.discoveredDependencyProjects ?? []) {
    if (![
      "reference_only",
      "available_not_installed",
      "installed_provider",
      "active_for_run",
    ].includes(project.lifecycleState)) {
      throw new Error(`${project.id} has invalid dependency lifecycle state`);
    }
    if (project.routeEligibility === "callable") {
      if (!project.invocationPath) throw new Error(`${project.id} callable dependency missing invocationPath`);
      if (!project.verificationMethod) throw new Error(`${project.id} callable dependency missing verificationMethod`);
    }
    if (["reference_only", "available_not_installed"].includes(project.lifecycleState) && (index.rankedRoutes ?? []).some((route) => route.id === project.id)) {
      throw new Error(`${project.id} ${project.lifecycleState} dependency entered execution route`);
    }
  }
  const kim = index.discoveredDependencyProjects.find((project) => project.id === "kim-decision");
  if (!kim) throw new Error("Kim_Decision state-machine record missing");
  if (kim.canNotDo.some((item) => /code executor/i.test(item)) !== true) throw new Error("Kim_Decision must record not_for_code_execution");
}

const index = await discover();
await writeJson(outputPath, index);
if (checkMode) validateIndex(index);
if (json) console.log(JSON.stringify(index, null, 2));
else console.log(`Dependency capability index written to ${outputPath}`);
