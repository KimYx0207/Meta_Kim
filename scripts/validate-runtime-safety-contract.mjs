#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  CODEX_APP_NATIVE_PLUGIN_IDS,
  CODEX_JS_REPL_FEATURE,
  CODEX_REQUEST_USER_INPUT_FEATURE,
  ensureCodexAppNativeControls,
  mergeCodexConfigAddOnly,
} from "./codex-config-merge.mjs";
import {
  INSTALL_STATUS_CLASSES,
  INSTALL_STATUS_MESSAGE_CLASSES,
  installStatusNextAction,
} from "./meta-kim-i18n.mjs";
import {
  buildCodexHooksJson,
  buildHookPromptAdapterSource,
} from "./runtime-hook-mapping.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function repoPath(relativePath) {
  return path.join(repoRoot, relativePath);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readText(relativePath) {
  return fs.readFile(repoPath(relativePath), "utf8");
}

async function readOptionalText(relativePath) {
  try {
    return await readText(relativePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function exists(relativePath) {
  try {
    await fs.access(repoPath(relativePath));
    return true;
  } catch {
    return false;
  }
}

async function walk(relativeRoot, bucket = []) {
  const absoluteRoot = repoPath(relativeRoot);
  let entries = [];
  try {
    entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  } catch {
    return bucket;
  }

  for (const entry of entries) {
    const absolutePath = path.join(absoluteRoot, entry.name);
    const relativePath = path.relative(repoRoot, absolutePath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      await walk(relativePath, bucket);
    } else if (entry.isFile()) {
      bucket.push(relativePath);
    }
  }
  return bucket;
}

function hasAll(haystack, needles, label) {
  for (const needle of needles) {
    assert(haystack.includes(needle), `${label} missing ${needle}`);
  }
}

function sameMembers(left, right) {
  return (
    JSON.stringify([...(left ?? [])].sort()) ===
    JSON.stringify([...(right ?? [])].sort())
  );
}

function productIdsByTier(catalog, tier) {
  return (catalog.products ?? [])
    .filter((product) => product.tier === tier)
    .map((product) => product.id);
}

const contract = await readJson("config/governance/runtime-safety-hardening-contract.json");
const pkg = await readJson("package.json");
const catalog = await readJson("config/runtime-compatibility-catalog.json");
const checklist = await readText("config/contracts/change-readiness-checklist.md");
const pullRequestTemplate = await readOptionalText(".github/pull_request_template.md");
const verificationEvidence = await readText("canonical/skills/meta-theory/references/verification-evidence.md");
const evalMetaAgents = await readText("scripts/eval-meta-agents.mjs");

assert(
  contract.contractId === "meta-kim-runtime-safety-hardening-contract",
  "runtime safety contract id mismatch",
);
assert(
  await exists(contract.releaseGate?.validatorScript),
  "runtime safety validator script is missing",
);
assert(
  pkg.scripts?.[contract.releaseGate?.packageScript] ===
    `node ${contract.releaseGate.validatorScript}`,
  "package script must point to the runtime safety validator",
);
assert(
  `${pkg.scripts?.["meta:verify:governance"] ?? ""} ${pkg.scripts?.["meta:verify:governance:core"] ?? ""}`.includes(
    `npm run ${contract.releaseGate.packageScript}`,
  ),
  "meta:verify:governance must run runtime safety validation",
);

hasAll(
  contract.hostConfigMerge?.requiredMatrixColumns ?? [],
  ["existingHostState", "stateAddedByChange", "stateMustPreserve", "rollbackPath"],
  "host config merge matrix",
);
hasAll(
  contract.hostConfigMerge?.protectedState ?? [],
  [
    "userOwnedConfig",
    "userOwnedGlobalInstructionFiles",
    "credentials",
    "customMcpServers",
    "nativeHostControls",
    "marketplaceSources",
  ],
  "host config protected state",
);
hasAll(
  contract.hostConfigMerge?.codexGlobalInstructionFiles?.protectedFiles ?? [],
  ["~/.codex/AGENTS.md"],
  "Codex global instruction protected files",
);
hasAll(
  contract.hostConfigMerge?.codexGlobalInstructionFiles?.policy ?? [],
  [
    "snapshot before ECC upstream installer",
    "restore user-authored global AGENTS.md after upstream installer",
    "quarantine exact ECC baseline if it appears in global AGENTS.md",
    "never copy project AGENTS.md into Codex global home",
  ],
  "Codex global instruction file policy",
);
assert(
  contract.hostConfigMerge?.mergeMode === "additive_preserve_user_state",
  "host config merge mode must preserve user state",
);

assert(
  contract.installExperienceModel?.goal ===
    "clear_global_or_project_install_paths_with_optional_manifest_proven_project_cleanup",
  "install experience goal must bind clear global/project install paths and optional manifest-proven cleanup",
);
hasAll(
  contract.installExperienceModel?.principles ?? [],
  [
    "global common capabilities are reusable across projects and are the default install/update path",
    "project-level complete projections are preserved when the user explicitly selects project directory updates",
    "global cleanup is a separate optional step and must not run during project install/update",
    "governance applies only to explicitly enabled directories",
    "existing user configuration always wins over generated defaults",
  ],
  "install experience principles",
);
const projectProjectionLayer =
  contract.installExperienceModel?.layers?.projectCompleteProjectionLayer ?? {};
assert(
  JSON.stringify(projectProjectionLayer.defaultActiveTargets) ===
    JSON.stringify(["claude", "codex"]),
  "project projection default active targets must be Claude Code + Codex",
);
hasAll(
  projectProjectionLayer.defaultProjectionSet ?? [],
  [
    "CLAUDE.md",
    "AGENTS.md",
    ".claude/",
    ".codex/",
    ".mcp.json",
    ".meta-kim/state",
    ".meta-kim/backups",
  ],
  "project default projection layer",
);
const conditionalProjectionSets =
  projectProjectionLayer.targetConditionalProjectionSets ?? {};
hasAll(
  conditionalProjectionSets.claude ?? [],
  ["CLAUDE.md", ".claude/", ".mcp.json", ".meta-kim/state", ".meta-kim/backups"],
  "Claude Code target projection layer",
);
hasAll(
  conditionalProjectionSets.codex ?? [],
  ["AGENTS.md", ".codex/", ".meta-kim/state", ".meta-kim/backups"],
  "Codex target projection layer",
);
hasAll(
  conditionalProjectionSets.cursor ?? [],
  ["AGENTS.md", ".cursor/", ".meta-kim/state", ".meta-kim/backups"],
  "Cursor target projection layer",
);
hasAll(
  conditionalProjectionSets.openclaw ?? [],
  ["AGENTS.md", "openclaw/", ".meta-kim/state", ".meta-kim/backups"],
  "OpenClaw target projection layer",
);
hasAll(
  projectProjectionLayer.selectionInvariant ?? "",
  ["activeTargets", "claude,codex", "--targets", ".meta-kim/local.overrides.json", "all four supported targets are formal"],
  "project projection selection invariant",
);
const platformSupportTiers = contract.installExperienceModel?.platformSupportTiers ?? {};
assert(
  platformSupportTiers.sourceOfTruth === "config/runtime-compatibility-catalog.json",
  "platform support tiers must reference the runtime compatibility catalog",
);
assert(
  sameMembers(
    platformSupportTiers.formalProjectionTargets,
    productIdsByTier(catalog, "runtime_projection"),
  ),
  "formal projection targets must match runtime_projection catalog products",
);
assert(
  sameMembers(platformSupportTiers.defaultSelectedTargets, ["claude", "codex"]),
  "default selected targets must be Claude Code + Codex",
);
assert(
  sameMembers(platformSupportTiers.nonDefaultFormalProjectionTargets, [
    "openclaw",
    "cursor",
  ]),
  "non-default formal projection targets must be OpenClaw + Cursor",
);
assert(
  sameMembers(
    platformSupportTiers.dependencyInstallTargets,
    productIdsByTier(catalog, "dependency_install_target"),
  ),
  "dependency install targets must match dependency_install_target catalog products",
);
assert(
  sameMembers(
    platformSupportTiers.candidateProbeTargets,
    productIdsByTier(catalog, "candidate_probe"),
  ),
  "candidate probe targets must match candidate_probe catalog products",
);
hasAll(
  platformSupportTiers.boundary ?? "",
  ["OpenClaw", "Cursor", "formal Meta_Kim projection targets"],
  "platform support tier boundary",
);
hasAll(
  platformSupportTiers.promotionInvariant ?? "",
  ["runtime profile", "projection layout", "generated target paths", "sync tests", "install policy"],
  "platform promotion invariant",
);
const installOptions = contract.installExperienceModel?.installOptions ?? [];
assert(
  installOptions.find((option) => option.id === "global")?.defaultOnEnter === true,
  "global reusable capabilities must be the Enter default",
);
assert(
  installOptions.find((option) => option.id === "project")?.defaultOnEnter === false,
  "project directory updates must default off",
);
assert(
  installOptions.find((option) => option.id === "project_cleanup_after_global")
    ?.requiresInstallOption === "global",
  "project cleanup must require global install/update first",
);
assert(
  !installOptions.some((option) => option.id === "both"),
  "install options must not include a combined both mode",
);
assert(
  !installOptions.some((option) => option.id === "advanced_global_controls"),
  "install options must not expose advanced global controls as a separate path",
);
hasAll(
  contract.installExperienceModel?.noSkillSemantics?.mustNotSkip ?? [],
  [
    "project projection when project scope is selected",
    "global meta-theory core sync when global scope is selected",
  ],
  "no-skill semantics",
);
hasAll(
  contract.installExperienceModel?.dryRunDisclosure?.mustShow ?? [],
  ["globalWrites", "projectWrites", "mergePolicy", "backupBeforeApply", "rollbackPlan"],
  "dry-run disclosure",
);
hasAll(
  contract.hostConfigMerge?.codexNativeControls?.requiredFeatures ?? [],
  [CODEX_REQUEST_USER_INPUT_FEATURE, CODEX_JS_REPL_FEATURE],
  "Codex native feature contract",
);
assert(
  JSON.stringify(contract.hostConfigMerge?.codexNativeControls?.requiredPluginIds) ===
    JSON.stringify(CODEX_APP_NATIVE_PLUGIN_IDS),
  "Codex native plugin ids must match codex-config-merge implementation",
);
const additiveMergeOut = mergeCodexConfigAddOnly(
  [
    'model = "gpt-5.5"',
    "",
    "[mcp_servers.github]",
    'command = "npx"',
    "",
    "[hooks]",
    'stop = "scripts/stop.mjs"',
    "",
  ].join("\n"),
  [
    'model = "gpt-5.4"',
    "",
    "[mcp_servers.github]",
    'command = "uvx"',
    'args = ["github-mcp"]',
    "",
    "[mcp_servers.context7]",
    'command = "npx"',
    "",
  ].join("\n"),
);
hasAll(
  additiveMergeOut,
  [
    'model = "gpt-5.5"',
    "[mcp_servers.github]",
    'command = "npx"',
    'args = ["github-mcp"]',
    "[mcp_servers.context7]",
    "[hooks]",
    'stop = "scripts/stop.mjs"',
  ],
  "Codex additive merge fixture",
);
assert(
  !additiveMergeOut.includes('model = "gpt-5.4"'),
  "Codex additive merge must not overwrite existing root settings",
);
const nativeControlsOut = ensureCodexAppNativeControls(
  [
    'model = "gpt-5.5"',
    'notify = ["terminal-notifier", "-message", "Task completed!"]',
    "",
    "[features]",
    "default_mode_request_user_input = false",
    "",
    '[plugins."browser@openai-bundled"]',
    "enabled = false",
    "",
    "[marketplaces.openai-bundled]",
    'source = "\\\\?\\C:\\Users\\Kim\\.codex\\.tmp\\bundled-marketplaces\\openai-bundled"',
    "",
    "[mcp_servers.github]",
    'command = "npx"',
    "",
    "[hooks]",
    'stop = "scripts/stop.mjs"',
    "",
    '[projects."D:/workspace/Meta_Kim"]',
    'trust_level = "trusted"',
    "",
  ].join("\n"),
  {
    platformName: "win32",
    bundledMarketplaceSource: "C:\\CodexApp\\app\\resources\\plugins\\openai-bundled",
    pathExists: () => true,
  },
);
hasAll(
  nativeControlsOut,
  [
    "default_mode_request_user_input = true",
    "js_repl = true",
    '[plugins."browser@openai-bundled"]',
    '[plugins."chrome@openai-bundled"]',
    '[plugins."computer-use@openai-bundled"]',
    "[mcp_servers.github]",
    "[hooks]",
    '[projects."D:/workspace/Meta_Kim"]',
  ],
  "Codex native controls fixture",
);
assert(!/terminal-notifier/.test(nativeControlsOut), "Windows Codex notify must not keep terminal-notifier");
assert(
  !/\.codex\\\.tmp\\bundled-marketplaces\\openai-bundled/i.test(nativeControlsOut),
  "Codex native controls must not keep stale bundled marketplace source",
);

const hookLayers = (contract.hookPromptProtocol?.requiredLayers ?? []).map(
  (layer) => layer.id,
);
assert(
  hookLayers.join("|") ===
    "sourcePayload|adapterTransform|hostRegistration|modelVisibleResult",
  "HookPrompt protocol must model the four hop chain",
);
const codexAdapter = buildHookPromptAdapterSource("codex");
const cursorAdapter = buildHookPromptAdapterSource("cursor");
hasAll(codexAdapter, ["hookSpecificOutput", "hookEventName", "UserPromptSubmit", "additionalContext"], "Codex HookPrompt adapter");
assert(
  !/systemMessage:\s*additionalContext/.test(codexAdapter),
  "Codex HookPrompt adapter must not use systemMessage for model context",
);
hasAll(cursorAdapter, ["prompt: additionalContext"], "Cursor HookPrompt adapter");
const codexHooks = buildCodexHooksJson({
  hookPromptAdapterPath: ".codex/hooks/hookprompt-adapter.mjs",
});
assert(
  JSON.stringify(codexHooks).includes("hookprompt-adapter.mjs"),
  "Codex HookPrompt host registration is missing",
);
hasAll(
  contract.hookPromptProtocol?.badInputRegressionFixtures ?? [],
  ["markdownFence", "delegatedPrompt", "internalGoalFilter"],
  "HookPrompt bad input regression fixtures",
);

hasAll(
  contract.residueSweep?.requiredBuckets ?? [],
  ["runtimeState", "i18n", "docs", "fixtures", "validators", "runtimeMirrors"],
  "residue sweep buckets",
);
const productionScanFiles = [
  ...(await walk("canonical")),
  ...(await walk("scripts")),
  "README.md",
  "README.zh-CN.md",
  "README.ja-JP.md",
  "README.ko-KR.md",
  "AGENTS.md",
  "CLAUDE.md",
].filter((file) => !file.endsWith(".png") && !file.endsWith(".sqlite"));
for (const marker of contract.residueSweep?.deprecatedMarkers ?? []) {
  const offenders = [];
  for (const file of productionScanFiles) {
    const raw = await readText(file);
    if (raw.includes(marker.marker)) {
      offenders.push(file);
    }
  }
  assert(
    offenders.length === 0,
    `deprecated marker ${marker.marker} remains in production files: ${offenders.join(", ")}`,
  );
}

hasAll(
  contract.runtimeEvidence?.requiredTemplateFields ?? [],
  ["operationSteps", "toolSideOutput", "hostVisibleResult", "failureBoundary", "reviewStatus"],
  "runtime evidence template",
);
hasAll(
  verificationEvidence,
  contract.runtimeEvidence?.allowedEvidenceKinds ?? [],
  "verification evidence reference",
);
hasAll(
  evalMetaAgents,
  ["runtimeEvidencePacket", "strictReleasePass", "blockedFromRelease", "evidenceKind", "failureClass"],
  "runtime evaluator evidence packet",
);
for (const evidenceKind of Object.keys(contract.runtimeEvidence?.evalEvidenceKindMap ?? {})) {
  assert(
    evalMetaAgents.includes(`"${evidenceKind}"`),
    `runtime evaluator missing evidence kind ${evidenceKind}`,
  );
}
hasAll(
  contract.runtimeEvidence?.requiredRecordFields ?? [],
  ["runtime", "mode", "status", "evidenceKind", "failureClass", "command", "artifact", "remainingAction", "strictReleasePass", "blockedFromRelease"],
  "runtime evidence record fields",
);
const catalogById = new Map((catalog.products ?? []).map((runtime) => [runtime.id, runtime]));
for (const runtimeId of ["cursor", "openclaw"]) {
  const runtime = catalogById.get(runtimeId);
  assert(runtime, `runtime compatibility catalog missing ${runtimeId}`);
  assert(
    /strict .*self-test evidence/i.test(runtime.nextAction ?? "") &&
      /passes review/i.test(runtime.nextAction ?? ""),
    `${runtimeId} nextAction must require strict self-test evidence and review`,
  );
}

assert(
  JSON.stringify(contract.installStatusSemantics?.allowedClasses) ===
    JSON.stringify(["success", "skipped", "manual", "failed"]),
  "install status classes must be success/skipped/manual/failed",
);
assert(
  JSON.stringify(INSTALL_STATUS_CLASSES) ===
    JSON.stringify(contract.installStatusSemantics?.allowedClasses),
  "install status helper classes must match runtime safety contract",
);
for (const statusClass of ["success", "skipped", "manual", "failed"]) {
  const record = contract.installStatusSemantics?.classes?.[statusClass];
  assert(record?.meaning, `install status ${statusClass} missing meaning`);
  assert(record?.userNextAction, `install status ${statusClass} missing userNextAction`);
  assert(installStatusNextAction(statusClass), `install status ${statusClass} missing helper next action`);
}
for (const [messageKey, statusClass] of Object.entries(INSTALL_STATUS_MESSAGE_CLASSES)) {
  assert(
    INSTALL_STATUS_CLASSES.includes(statusClass),
    `install message ${messageKey} maps to unknown status class ${statusClass}`,
  );
}

hasAll(
  contract.lazyProjectBootstrap?.entrypoints ?? [],
  [
    "meta-kim project bootstrap --dry-run --project-dir <dir>",
    "meta-kim project bootstrap --apply --project-dir <dir>",
  ],
  "lazy project bootstrap entrypoints",
);
hasAll(
  Object.keys(contract.lazyProjectBootstrap?.sourceChain ?? {}),
  [
    "globalEntrypoint",
    "packageRoot",
    "canonicalRoots",
    "syncManifest",
    "runtimeMirrorSource",
    "projectTarget",
  ],
  "lazy project bootstrap source chain",
);
assert(
  contract.lazyProjectBootstrap?.postCopyInitializerPolicy?.executorLocation ===
    "installed package root scripts/project-post-copy-init.mjs",
  "post-copy initializer must be a global package-root executor",
);
hasAll(
  contract.lazyProjectBootstrap?.postCopyInitializerPolicy?.projectOutputs ?? [],
  [
    ".meta-kim/state/default/post-copy-init.json",
    "graphify-out/graph.json",
    "graphify-out/GRAPH_REPORT.md",
  ],
  "post-copy initializer project outputs",
);
hasAll(
  contract.lazyProjectBootstrap?.postCopyInitializerPolicy
    ?.forbiddenProjectExecutables ?? [],
  [".meta-kim/meta-kim-post-copy.mjs", "meta-kim-post-copy.mjs"],
  "post-copy project executable ban",
);
hasAll(
  contract.lazyProjectBootstrap?.projectFilePolicies?.merge ?? [],
  [".claude/settings.json", ".codex/hooks.json", ".cursor/hooks.json", ".mcp.json"],
  "lazy project bootstrap protected merge files",
);
hasAll(
  contract.lazyProjectBootstrap?.projectFilePolicies?.managedTextBlock ?? [],
  ["AGENTS.md", "CLAUDE.md"],
  "lazy project bootstrap managed text block files",
);
hasAll(
  contract.lazyProjectBootstrap?.projectFilePolicies?.neverTouch ?? [],
  [".codex/config.toml", "credentials", "project trust state"],
  "lazy project bootstrap never-touch files",
);
assert(
  contract.lazyProjectBootstrap?.rollback?.requiredBeforeApply === true,
  "lazy project bootstrap must require backup before apply",
);
hasAll(
  contract.lazyProjectBootstrap?.scenarioAcceptance ?? [],
  [
    "empty project dry-run exposes sourceChain and writes nothing",
    "current project dry-run after apply reports ready, requires no confirmation, and lists no project writes",
    "existing user AGENTS.md or CLAUDE.md keeps user text and adds a managed block",
    ".codex/config.toml remains global-owned and is never copied into project bootstrap",
    "stale project manifest reports stale before update",
  ],
  "lazy project bootstrap scenario acceptance",
);
hasAll(
  contract.lazyProjectBootstrap?.forbiddenOutcomes ?? [],
  [
    "silent project writes before dry-run and user confirmation",
    "project-level source described without packageRoot/canonical/syncManifest/runtimeMirror chain",
    "AGENTS.md or CLAUDE.md blind overwrite when the target already has user content",
    "copying .codex/config.toml as project bootstrap source",
  ],
  "lazy project bootstrap forbidden outcomes",
);

for (const doc of [checklist, pullRequestTemplate].filter(Boolean)) {
  hasAll(
    doc,
    [
      "Host State Impact Matrix",
      "Hook / Prompt Protocol Flow",
      "Deletion / Refactor Residue Sweep",
      "Evidence Budget",
      "Install / Update Status Semantics",
    ],
    "change readiness documentation",
  );
}

hasAll(
  checklist,
  [
    "Installed-User Compatibility Gate",
    "Historical-version update",
    "Partial or failed prior install",
    "fresh install is not enough",
  ],
  "installed-user compatibility contract",
);

if (!pullRequestTemplate) {
  console.warn(
    "[Meta_Kim] Optional GitHub pull request template is not present; " +
      "runtime safety readiness is validated from config/contracts/change-readiness-checklist.md.",
  );
}

console.log("runtime safety hardening contract valid");
