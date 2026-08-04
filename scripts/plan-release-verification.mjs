#!/usr/bin/env node

/**
 * Build a release-verification plan from changed-file impact evidence.
 *
 * This module is intentionally a planner, not a runner. It never invokes a
 * verification command and never writes runtime or .meta-kim state. The full
 * release claim remains owned by scripts/run-verify-all.mjs.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "release-verification-tier-contract.json",
);

export const RELEASE_VERIFICATION_TIER_CONTRACT = Object.freeze(
  JSON.parse(readFileSync(CONTRACT_PATH, "utf8")),
);

const BASE_NARROW_CHECK_IDS = Object.freeze([
  ...RELEASE_VERIFICATION_TIER_CONTRACT.tiers.narrow.requiredCheckIds,
]);
const TIER_NAMES = Object.freeze(["smoke", "narrow", "full"]);

function unique(values) {
  return [...new Set(values)];
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function validateReleaseVerificationTierContract(contract = RELEASE_VERIFICATION_TIER_CONTRACT) {
  assertString(contract.schemaVersion, "schemaVersion");
  if (contract.contractId !== "meta-kim-release-verification-tier-contract") {
    throw new Error("release verification tier contract id mismatch");
  }
  for (const tierName of TIER_NAMES) {
    if (!contract.tiers?.[tierName]) throw new Error(`missing release verification tier ${tierName}`);
    if (!contract.claimBoundary?.[tierName]) throw new Error(`missing claim boundary for ${tierName}`);
  }
  const requiredNarrow = contract.tiers.narrow.requiredCheckIds;
  if (!Array.isArray(requiredNarrow) || requiredNarrow.join("|") !== BASE_NARROW_CHECK_IDS.join("|")) {
    throw new Error("narrow tier must retain version, sync, packaging, and focused_regression checks");
  }
  for (const checkId of unique([
    ...requiredNarrow,
    ...contract.tiers.smoke.requiredCheckIds,
    ...contract.tiers.full.requiredCheckIds,
  ])) {
    if (!contract.checkDefinitions?.[checkId]) throw new Error(`missing check definition ${checkId}`);
  }
  const fullStageNames = contract.tiers.full.requiredStageNames;
  if (!Array.isArray(fullStageNames) || fullStageNames.length === 0 || new Set(fullStageNames).size !== fullStageNames.length) {
    throw new Error("full tier must define unique standard stage names");
  }
  if (contract.claimBoundary.smoke.releaseGradeClaimable !== false || contract.claimBoundary.narrow.releaseGradeClaimable !== false) {
    throw new Error("smoke and narrow tiers must not be release-grade claimable");
  }
  if (!Array.isArray(contract.impactRules) || contract.impactRules.length === 0) {
    throw new Error("release verification tier contract must define impact rules");
  }
  for (const rule of contract.impactRules) {
    assertString(rule.id, "impact rule id");
    if (!Array.isArray(rule.patterns) || rule.patterns.length === 0) {
      throw new Error(`impact rule ${rule.id} must define patterns`);
    }
    if (!Array.isArray(rule.impacts)) throw new Error(`impact rule ${rule.id} must define impacts`);
  }
  assertString(contract.fallback?.ruleId, "fallback rule id");
  if (contract.fallback.requiresFull !== true) throw new Error("unknown-file fallback must require full verification");
  return true;
}

validateReleaseVerificationTierContract();

export function normalizeChangedFile(file) {
  if (typeof file !== "string") return null;
  let value = file.trim().replaceAll("\\", "/");
  if (!value) return null;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    value = path.relative(REPO_ROOT, path.resolve(value)).replaceAll("\\", "/");
  }
  value = value.replace(/^\.\//u, "");
  value = path.posix.normalize(value);
  if (value === "." || value === "") return null;
  return value;
}

export function normalizeChangedFiles(files = []) {
  if (!Array.isArray(files)) throw new Error("changed files must be an array");
  return unique(files.map(normalizeChangedFile).filter(Boolean)).sort();
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

function globToRegExp(pattern) {
  const normalized = String(pattern).replaceAll("\\", "/");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character);
    }
  }
  return new RegExp(`${source}$`, "iu");
}

function globMatches(file, pattern) {
  return globToRegExp(pattern).test(file);
}

function ruleMatches(file, rule) {
  return rule.patterns.some((pattern) => globMatches(file, pattern));
}

export function buildChangedFileImpactMap(
  changedFiles = [],
  contract = RELEASE_VERIFICATION_TIER_CONTRACT,
) {
  validateReleaseVerificationTierContract(contract);
  const normalizedFiles = normalizeChangedFiles(changedFiles);
  return normalizedFiles.map((file) => {
    const matchedRules = contract.impactRules.filter((rule) => ruleMatches(file, rule));
    if (matchedRules.length === 0) {
      return {
        file,
        ruleIds: [contract.fallback.ruleId],
        impacts: [...contract.fallback.impacts],
        ignored: false,
        requiresFull: true,
        escalationReasons: ["unknown_file"],
        reasons: [contract.fallback.reason],
        testSelectors: [],
      };
    }
    const activeRules = matchedRules.filter((rule) => rule.ignored !== true);
    const ignored = activeRules.length === 0;
    const impacts = unique(activeRules.flatMap((rule) => rule.impacts ?? []));
    const requiresFull = activeRules.some((rule) => rule.requiresFull === true);
    return {
      file,
      ruleIds: matchedRules.map((rule) => rule.id),
      impacts,
      ignored,
      requiresFull,
      escalationReasons: requiresFull ? ["full_only_impact"] : [],
      reasons: matchedRules.map((rule) => rule.reason).filter(Boolean),
      testSelectors: unique(activeRules.flatMap((rule) => rule.testSelectors ?? [])),
    };
  });
}

export const mapChangedFilesToImpacts = buildChangedFileImpactMap;

export function buildChangedFileImpactGraph(impactMap = []) {
  const nodes = [];
  const edges = [];
  const seenNodes = new Set();
  const seenEdges = new Set();
  const addNode = (node) => {
    if (seenNodes.has(node.id)) return;
    seenNodes.add(node.id);
    nodes.push(node);
  };
  for (const entry of impactMap) {
    const fileNodeId = `file:${entry.file}`;
    addNode({ id: fileNodeId, kind: "changed_file", label: entry.file });
    for (const impact of entry.impacts) {
      const impactNodeId = `impact:${impact}`;
      addNode({ id: impactNodeId, kind: "impact", label: impact });
      const edgeKey = `${fileNodeId}\u0000${impactNodeId}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({ from: fileNodeId, to: impactNodeId, relation: "matches" });
      }
    }
  }
  return { nodes, edges };
}

export const buildImpactGraph = buildChangedFileImpactGraph;
export const buildImpactMap = buildChangedFileImpactMap;

export function buildFocusedRegressionSelectors(
  changedFiles = [],
  impactMap = buildChangedFileImpactMap(changedFiles),
  contract = RELEASE_VERIFICATION_TIER_CONTRACT,
) {
  const selectors = [];
  for (const entry of impactMap) {
    if (/^tests\/.*\.test\.mjs$/iu.test(entry.file)) selectors.push(entry.file);
    selectors.push(...entry.testSelectors);
  }
  if (selectors.length === 0) {
    selectors.push(...(contract.checkDefinitions.focused_regression.defaultSelectors ?? []));
  }
  return unique(selectors).sort();
}

function claimBoundary(contract, tier) {
  return structuredClone(contract.claimBoundary[tier]);
}

function buildCheckPlan(checkId, { selectors = [], contract = RELEASE_VERIFICATION_TIER_CONTRACT } = {}) {
  const definition = contract.checkDefinitions[checkId];
  if (!definition) throw new Error(`unknown release verification check ${checkId}`);
  return {
    id: checkId,
    category: definition.category,
    required: true,
    description: definition.description,
    commands: [...(definition.commands ?? [])],
    ...(definition.commandTemplate ? { commandTemplate: definition.commandTemplate } : {}),
    ...(checkId === "focused_regression" ? { selectors: [...selectors] } : {}),
    sourceRefs: [...(definition.sourceRefs ?? [])],
    evidenceBoundary: definition.evidenceBoundary,
  };
}

function buildBasePlan({ requestedTier, selectedTier, changedFiles, impactMap, contract }) {
  const impactGraph = buildChangedFileImpactGraph(impactMap);
  return {
    schemaVersion: contract.schemaVersion,
    contractId: contract.contractId,
    planner: contract.authority.planner,
    requestedTier,
    tier: selectedTier,
    changedFiles: [...changedFiles],
    impactMap,
    impactGraph,
    claimBoundary: claimBoundary(contract, selectedTier),
    releaseGradeClaimable: false,
  };
}

function buildSmokePlan({ requestedTier, changedFiles, impactMap, contract }) {
  const plan = buildBasePlan({
    requestedTier,
    selectedTier: "smoke",
    changedFiles,
    impactMap,
    contract,
  });
  return {
    ...plan,
    recommendedTier: "smoke",
    requiresFull: false,
    escalationReasons: [],
    requiredCheckIds: ["smoke"],
    checks: [buildCheckPlan("smoke", { contract })],
    command: contract.checkDefinitions.smoke.commands[0],
  };
}

function buildFullPlan({ requestedTier, changedFiles, impactMap, contract }) {
  const plan = buildBasePlan({
    requestedTier,
    selectedTier: "full",
    changedFiles,
    impactMap,
    contract,
  });
  return {
    ...plan,
    recommendedTier: "full",
    requiresFull: true,
    escalationReasons: [],
    requiredCheckIds: ["full_release_runner"],
    checks: [buildCheckPlan("full_release_runner", { contract })],
    command: contract.tiers.full.entrypoint,
    standardStageNames: [...contract.tiers.full.requiredStageNames],
  };
}

function buildNarrowPlan({ requestedTier, changedFiles, impactMap, contract }) {
  const escalationReasons = [];
  if (changedFiles.length === 0) escalationReasons.push("empty_changed_file_set");
  for (const entry of impactMap) escalationReasons.push(...entry.escalationReasons);
  const uniqueEscalationReasons = unique(escalationReasons);
  const focusedSelectors = buildFocusedRegressionSelectors(changedFiles, impactMap, contract);
  const checkIds = [...BASE_NARROW_CHECK_IDS];
  const additionalImpacts = unique(impactMap.flatMap((entry) => entry.impacts));
  for (const impact of additionalImpacts) {
    if (contract.checkDefinitions[impact] && !checkIds.includes(impact)) checkIds.push(impact);
  }
  const plan = buildBasePlan({
    requestedTier,
    selectedTier: "narrow",
    changedFiles,
    impactMap,
    contract,
  });
  return {
    ...plan,
    recommendedTier: uniqueEscalationReasons.length > 0 ? "full" : "narrow",
    requiresFull: uniqueEscalationReasons.length > 0,
    escalationReasons: uniqueEscalationReasons,
    requiredCheckIds: checkIds,
    checks: checkIds.map((checkId) =>
      buildCheckPlan(checkId, { selectors: focusedSelectors, contract }),
    ),
    focusedRegressionSelectors: focusedSelectors,
    command: null,
    fullEscalationCommand: contract.tiers.full.entrypoint,
  };
}

export function buildReleaseVerificationPlan(changedFiles = [], options = {}) {
  const contract = options.contract ?? RELEASE_VERIFICATION_TIER_CONTRACT;
  validateReleaseVerificationTierContract(contract);
  const requestedTier = options.tier ?? options.requestedTier ?? "narrow";
  if (!TIER_NAMES.includes(requestedTier)) {
    throw new Error(`unknown release verification tier ${requestedTier}`);
  }
  const normalizedFiles = normalizeChangedFiles(changedFiles);
  const impactMap = buildChangedFileImpactMap(normalizedFiles, contract);
  if (requestedTier === "smoke") {
    return buildSmokePlan({ requestedTier, changedFiles: normalizedFiles, impactMap, contract });
  }
  if (requestedTier === "full") {
    return buildFullPlan({ requestedTier, changedFiles: normalizedFiles, impactMap, contract });
  }
  return buildNarrowPlan({ requestedTier, changedFiles: normalizedFiles, impactMap, contract });
}

export const planReleaseVerification = buildReleaseVerificationPlan;

function parseCliArgs(argv) {
  const changedFiles = [];
  let tier = "narrow";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tier") {
      tier = argv[++index];
      continue;
    }
    if (arg === "--files" || arg === "--file") {
      const value = argv[++index];
      if (value == null) throw new Error(`${arg} requires a value`);
      changedFiles.push(...value.split(","));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true, tier, changedFiles };
    }
    if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    changedFiles.push(arg);
  }
  return { help: false, tier, changedFiles };
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node scripts/plan-release-verification.mjs [--tier smoke|narrow|full] [--files file1,file2]",
      "The command only prints a plan; it does not run verification or write state.",
    ].join("\n") + "\n",
  );
}

async function main() {
  try {
    const parsed = parseCliArgs(process.argv.slice(2));
    if (parsed.help) {
      printHelp();
      return;
    }
    const plan = buildReleaseVerificationPlan(parsed.changedFiles, { tier: parsed.tier });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`[release-verification-plan] ${error.message}\n`);
    process.exitCode = 2;
  }
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
