#!/usr/bin/env node
/**
 * Global sync: canonical meta-theory skill + Meta_Kim Claude runtime hook assets into runtime homes.
 * Flags: --check, --print-targets, --with-global-hooks (opt into global hook copy + settings merge where supported), --skip-durable-mcp.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildMetaKimHooksTemplate,
  hookCommandNode,
  isGlobalMetaKimManagedHookCommand,
  mergeHookMatcherBlocks,
  mergeGlobalMetaKimHooksIntoSettings,
} from "./claude-settings-merge.mjs";
import {
  canonicalAgentsDir,
  canonicalRuntimeAssetsDir,
  canonicalSkillRoot,
  globalAgentProjectionFileName,
  resolveGlobalAgentProjectionTargets,
  resolveTargetContext,
  resolveRuntimeHomeInfo,
} from "./meta-kim-sync-config.mjs";
import {
  CODEX_REQUEST_USER_INPUT_FEATURE,
  assertCodexConfigTomlMergeable,
  hasCodexRequestUserInputFeature,
  planCodexAppNativeControls,
} from "./codex-config-merge.mjs";
import {
  CATEGORIES,
  directoryClosureSync,
  manifestPathFor,
  openRecorder,
  readManifest,
} from "./install-manifest.mjs";
import { validateSkillFrontmatter } from "./install-skill-sanitizer.mjs";
import {
  applyRuntimePaths,
  buildCodexSkillContent,
  loadCanonicalAgents,
  parseCanonicalAgent,
  renderGlobalAgentProjection,
} from "./sync-runtimes.mjs";
import {
  mcpDefinitionFingerprint,
  mergeClaudeUserMcpConfig,
  resolveDurableMetaKimRuntimeLayout,
  resolvePortableMetaKimPackageIdentity,
} from "./global-runtime-mcp.mjs";
import {
  buildCodexHooksJson,
  buildHookPromptAdapterSource,
  runtimeHookSourceOwner,
} from "./runtime-hook-mapping.mjs";

// Recorder is lazily opened in runSync(); helpers record through this holder
// so we do not have to thread recorder arg through every sync function.
let manifestRecorder = null;
let globalManifestSnapshot = null;
const manifestRecordFailures = [];
function recordSafe(fn) {
  if (!manifestRecorder) return;
  try {
    fn(manifestRecorder);
  } catch (error) {
    manifestRecordFailures.push(error?.message ?? String(error));
  }
}

// ANSI colors matching setup.mjs
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  amber: "\x1b[38;2;160;120;60m",
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceDir = canonicalSkillRoot;
const sourceSkillFile = path.join(sourceDir, "SKILL.md");

const cliArgs = process.argv.slice(2);

function printHelp() {
  console.log(`Usage: node scripts/sync-global-meta-theory.mjs [options]

Options:
  --check                 Check selected global projections without writing
  --print-targets         Print resolved runtime homes and selected targets
  --targets <ids>         Comma-separated runtime ids
  --with-global-hooks     Include global Hook files and runtime registration
  --skip-global-hooks     Explicitly skip global Hook synchronization
  --skip-durable-mcp      Explicitly skip Claude durable MCP runtime and MCP config
  --help, -h              Show this help without resolving homes or writing`);
}

function parseCliArgs(args) {
  const flags = new Set([
    "--check",
    "--print-targets",
    "--with-global-hooks",
    "--skip-global-hooks",
    "--skip-durable-mcp",
    "--help",
    "-h",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (flags.has(arg)) continue;
    if (arg === "--targets") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--targets requires a comma-separated value");
      }
      index += 1;
      continue;
    }
    if (arg.startsWith("--targets=")) {
      if (!arg.slice("--targets=".length).trim()) {
        throw new Error("--targets requires a comma-separated value");
      }
      continue;
    }
    throw new Error(`Unknown option: ${arg}. Run with --help for usage.`);
  }

  const help = args.includes("--help") || args.includes("-h");
  const skipGlobalHooks = args.includes("--skip-global-hooks");
  return {
    help,
    checkOnly: args.includes("--check"),
    printTargetsOnly: args.includes("--print-targets"),
    skipGlobalHooks,
    withGlobalHooks: args.includes("--with-global-hooks") && !skipGlobalHooks,
    skipDurableMcp: args.includes("--skip-durable-mcp"),
  };
}

let cliOptions;
try {
  cliOptions = parseCliArgs(cliArgs);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

const checkOnly = cliOptions?.checkOnly ?? false;
const printTargetsOnly = cliOptions?.printTargetsOnly ?? false;
const withGlobalHooks = cliOptions?.withGlobalHooks ?? false;
const skipDurableMcp = cliOptions?.skipDurableMcp ?? false;

const repoHooksDir = path.join(canonicalRuntimeAssetsDir, "claude", "hooks");
const sharedHooksDir = path.join(canonicalRuntimeAssetsDir, "shared", "hooks");
// Files shipped into ~/.claude/hooks/meta-kim/ during global sync.
// Sources: canonical/runtime-assets/claude/hooks/*.mjs + shared/hooks/*.mjs.
// This whitelist is the single source of truth for "what belongs to Meta_Kim
// in the global hooks dir" — used by sync, cleanup, and migration flows.
const CANONICAL_CLAUDE_HOOKS_DIR = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "hooks",
);
const CANONICAL_SHARED_HOOKS_DIR = path.join(
  canonicalRuntimeAssetsDir,
  "shared",
  "hooks",
);
const GLOBAL_HOOK_PACKAGE_FILES = new Set([
  // ── canonical/runtime-assets/claude/hooks/ ──
  "bash-readonly-whitelist.mjs",
  "block-dangerous-bash.mjs",
  "ecc-permission-cache-wrapper.mjs",
  "enforce-agent-dispatch.mjs",
  "graphify-context.mjs",
  "post-console-log-warn.mjs",
  "post-format.mjs",
  "post-typecheck.mjs",
  "stop-compaction.mjs",
  "stop-completion-guard.mjs",
  "stop-console-log-audit.mjs",
  "stop-memory-save.mjs",
  "stop-save-progress.mjs",
  "stop-spine-cleanup.mjs",
  "subagent-context.mjs",
  // ── runtime-owned source selected per target ──
  "meta-kim-memory-save.mjs",
  // ── canonical/runtime-assets/shared/hooks/ ──
  "activate-meta-theory-spine.mjs",
  "project-root.mjs",
  "skip-reminder.mjs",
  "spine-state.mjs",
  "spine-state-utils.mjs",
  "utils.mjs",
]);
const GLOBAL_HOOK_PACKAGE_FILES_LEGACY = new Set([
  // Files that were shipped historically but are no longer in canonical.
  // Listed here so migration logic can clean them up instead of leaving ghosts.
]);
const RETIRED_HOOK_FILES = ["pre-git-push-confirm.mjs"];
const legacyHookBackupStamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-");
const codexCommandsSourceDir = path.join(
  canonicalRuntimeAssetsDir,
  "codex",
  "commands",
);
const claudeCommandsSourceDir = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "commands",
);
const canonicalClaudeMcpPath = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "mcp.json",
);
const distributionPath = path.join(repoRoot, "config", "distribution.json");
const historicalAgentMigrationCatalogPath = path.join(
  repoRoot,
  "config",
  "migrations",
  "global-agent-projection-fingerprints.json",
);
const STALE_META_KIM_SKILL_ALIAS_SPECS = [
  {
    name: "meta_kim",
    label: "legacy Meta Arsenal skill package",
    required: [/Meta Arsenal/i, /Smallest Governable Unit/i],
  },
  {
    name: "meta-theory-agent-calling-gap",
    label: "fixed Meta Theory agent-calling gap skill",
    required: [/Meta-Theory Agent Calling Gap/i, /Status:\s*.*FIXED/i],
  },
  {
    name: "source-command-meta-theory-report",
    label: "legacy Meta Theory report source-command skill",
    required: [/source-command-meta-theory-report/i, /run-meta-theory-governed-execution\.mjs/i],
  },
  {
    name: "source-command-meta-theory-verify",
    label: "legacy Meta Theory verify source-command skill",
    required: [/source-command-meta-theory-verify/i, /meta:(release:smoke|verify:all|check:global:release)/i],
  },
  {
    name: "critical-fetch-thinking-review",
    label: "legacy Critical/Fetch/Thinking/Review Meta_Kim alias",
    required: [/Meta[_ -]?Kim|Meta Theory/i, /Critical[\s\S]*Fetch[\s\S]*Thinking[\s\S]*Review/i],
  },
  {
    name: "critical-fetch-thinking-and-review",
    label: "legacy Critical/Fetch/Thinking/Review Meta_Kim alias",
    required: [/Meta[_ -]?Kim|Meta Theory/i, /Critical[\s\S]*Fetch[\s\S]*Thinking[\s\S]*Review/i],
  },
  {
    name: "critical-and-fetch-thinking-review",
    label: "legacy Critical/Fetch/Thinking/Review Meta_Kim alias",
    required: [/Meta[_ -]?Kim|Meta Theory/i, /Critical[\s\S]*Fetch[\s\S]*Thinking[\s\S]*Review/i],
  },
  {
    name: "critical-and-fetch-thinking-and-review",
    label: "legacy Critical/Fetch/Thinking/Review Meta_Kim alias",
    required: [/Meta[_ -]?Kim|Meta Theory/i, /Critical[\s\S]*Fetch[\s\S]*Thinking[\s\S]*Review/i],
  },
];
const CODEX_LEGACY_SHARED_SKILL_ROOT = path.join(
  os.homedir(),
  ".agents",
  "skills",
);

let runtimeHomes = {};
let allowedRoots = [];
let allowedRealRoots = [];
let allowedExactFiles = [];
let allowedExactRealFiles = [];
let activeTargets = [];
let cleanupTargets = [];
let staleSkillCleanupTargets = [];
let selectedTargetIds = [];
let runtimeProfiles = {};
let globalAgentTargets = [];
let globalAgentMigrationTargets = [];
const removedOwnedLegacyHookPaths = new Set();

function stagedSiblingForExactFile(resolved, exactFile) {
  if (path.dirname(resolved) !== path.dirname(exactFile)) return false;
  const prefix = `.meta-kim-staged-${path.basename(exactFile).replace(/^\.+/u, "")}-`;
  return path.basename(resolved).startsWith(prefix);
}

function exactFileAllowanceIndex(resolved) {
  return allowedExactFiles.findIndex(
    (exactFile) => resolved === exactFile || stagedSiblingForExactFile(resolved, exactFile),
  );
}

function assertHomeBound(targetPath) {
  const resolved = path.resolve(targetPath);
  const isAllowed = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  ) || exactFileAllowanceIndex(resolved) !== -1;
  if (!isAllowed) {
    throw new Error(
      `Refusing to write outside the configured runtime homes: ${resolved}`,
    );
  }
}

async function projectedRealPath(targetPath) {
  let cursor = path.resolve(targetPath);
  const missing = [];
  while (true) {
    try {
      const real = await fs.realpath(cursor);
      return path.join(real, ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function pathIsWithin(root, target) {
  const relativePath = path.relative(root, target);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function assertRealHomeBound(targetPath) {
  assertHomeBound(targetPath);
  const resolved = path.resolve(targetPath);
  const realTarget = await projectedRealPath(resolved);
  const matched = allowedRoots
    .map((root, index) => ({ root, realRoot: allowedRealRoots[index] }))
    .filter(({ root }) => pathIsWithin(root, resolved));
  const exactIndex = exactFileAllowanceIndex(resolved);
  const exactAllowed = exactIndex !== -1 && (
    resolved === allowedExactFiles[exactIndex]
      ? realTarget === allowedExactRealFiles[exactIndex]
      : path.dirname(realTarget) === path.dirname(allowedExactRealFiles[exactIndex]) &&
        stagedSiblingForExactFile(resolved, allowedExactFiles[exactIndex])
  );
  if (!matched.some(({ realRoot }) => pathIsWithin(realRoot, realTarget)) && !exactAllowed) {
    throw new Error(
      `Refusing to follow a symlink or junction outside configured runtime homes: ${resolved} -> ${realTarget}`,
    );
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeUtf8FileIfChanged(targetPath, content) {
  let current = null;
  try {
    current = await fs.readFile(targetPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (current === content) {
    return false;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");
  return true;
}

async function renameDirectoryWithRetry(sourcePath, targetPath) {
  const retryable = new Set(["EACCES", "EBUSY", "EPERM"]);
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      if (!retryable.has(error?.code) || attempt === 7) throw error;
      await delay(50 * (attempt + 1));
    }
  }
  throw lastError;
}

function sha256Text(content) {
  return createHash("sha256").update(content).digest("hex");
}

function manifestOwnsExactAgent(targetPath, content, targetId, agentId) {
  const purpose = `${targetId}-global-agent:${agentId}`;
  const size = Buffer.byteLength(content);
  const sha256 = sha256Text(content);
  return Boolean(globalManifestSnapshot?.entries?.some((entry) =>
    entry.kind === "file" &&
    entry.source === "sync-global-meta-theory" &&
    entry.purpose === purpose &&
    path.resolve(entry.path) === path.resolve(targetPath) &&
    entry.size === size &&
    entry.sha256 === sha256,
  ));
}

const historicalAgentProjectionCache = new Map();
let historicalAgentMigrationCatalog = null;

async function loadHistoricalAgentMigrationCatalog() {
  if (historicalAgentMigrationCatalog) return historicalAgentMigrationCatalog;
  const parsed = JSON.parse(await fs.readFile(historicalAgentMigrationCatalogPath, "utf8"));
  if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.projections)) {
    throw new Error(`Invalid global Agent migration catalog: ${historicalAgentMigrationCatalogPath}`);
  }
  const index = new Map();
  const migrationTargetIds = new Set(
    globalAgentMigrationTargets.map((target) => target.targetId),
  );
  for (const projection of parsed.projections) {
    if (
      typeof projection?.agentId !== "string" ||
      !migrationTargetIds.has(projection?.targetId) ||
      !Array.isArray(projection?.fingerprints) ||
      !projection.fingerprints.every((value) => /^[a-f0-9]{64}$/u.test(value))
    ) {
      throw new Error(`Invalid projection entry in global Agent migration catalog: ${historicalAgentMigrationCatalogPath}`);
    }
    index.set(
      `${projection.targetId}:${projection.agentId}`,
      new Set(projection.fingerprints),
    );
  }
  historicalAgentMigrationCatalog = index;
  return index;
}

async function catalogOwnsHistoricalAgentProjection(agentId, targetId, content) {
  const catalog = await loadHistoricalAgentMigrationCatalog();
  return catalog.get(`${targetId}:${agentId}`)?.has(sha256Text(content)) === true;
}

function historicalAgentProjections(agentId, targetId) {
  const cacheKey = `${targetId}:${agentId}`;
  if (historicalAgentProjectionCache.has(cacheKey)) {
    return historicalAgentProjectionCache.get(cacheKey);
  }
  const target = globalAgentMigrationTargets.find(
    (candidate) => candidate.targetId === targetId,
  );
  if (!target) {
    const empty = new Set();
    historicalAgentProjectionCache.set(cacheKey, empty);
    return empty;
  }
  const sourceFile = path
    .relative(repoRoot, path.join(canonicalAgentsDir, `${agentId}.md`))
    .replace(/\\/g, "/");
  const projections = new Set();
  try {
    const revisions = execFileSync(
      "git",
      ["log", "--format=%H", "--", sourceFile],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim().split(/\r?\n/u).filter(Boolean);
    for (const revision of revisions) {
      const raw = execFileSync(
        "git",
        ["show", `${revision}:${sourceFile}`],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const historical = parseCanonicalAgent(raw, sourceFile);
      if (historical.id === agentId) {
        projections.add(renderGlobalAgentProjection(historical, target));
      }
    }
  } catch {
    // Packaged installs do not necessarily include git history. In that case,
    // only exact manifest ownership can authorize replacing a stale file.
  }
  historicalAgentProjectionCache.set(cacheKey, projections);
  return projections;
}

function globalAgentPath(target, agentId) {
  return path.join(
    runtimeHomes[target.targetId].dir,
    target.agentsDir,
    globalAgentProjectionFileName(target, agentId),
  );
}

async function buildGlobalAgentPlan() {
  const agents = await loadCanonicalAgents();
  const entries = [];
  const collisions = [];
  for (const target of globalAgentTargets) {
    const { targetId } = target;
    for (const agent of agents) {
      const targetPath = globalAgentPath(target, agent.id);
      const expected = renderGlobalAgentProjection(agent, target);
      const current = (await pathExists(targetPath)) ? await fs.readFile(targetPath, "utf8") : null;
      const migration = current !== null && current !== expected;
      const owned = migration && (
        manifestOwnsExactAgent(targetPath, current, targetId, agent.id) ||
        await catalogOwnsHistoricalAgentProjection(agent.id, targetId, current) ||
        historicalAgentProjections(agent.id, targetId).has(current)
      );
      if (migration && !owned) {
        collisions.push({ targetId, agentId: agent.id, targetPath });
      }
      entries.push({ targetId, agentId: agent.id, targetPath, expected });
    }
  }
  return { entries, collisions };
}

async function syncGlobalAgents(plan) {
  for (const entry of plan.entries) {
    assertHomeBound(entry.targetPath);
    await assertRealHomeBound(entry.targetPath);
    const current = (await pathExists(entry.targetPath))
      ? await fs.readFile(entry.targetPath, "utf8")
      : null;
    if (current === entry.expected) {
      recordSafe((rec) => rec.recordFile(entry.targetPath, {
        source: "sync-global-meta-theory",
        purpose: `${entry.targetId}-global-agent:${entry.agentId}`,
        category: CATEGORIES.A,
        runtimeTarget: entry.targetId,
      }));
      continue;
    }
    if (current !== null) {
      const owned = manifestOwnsExactAgent(
        entry.targetPath,
        current,
        entry.targetId,
        entry.agentId,
      ) || await catalogOwnsHistoricalAgentProjection(
        entry.agentId,
        entry.targetId,
        current,
      ) || historicalAgentProjections(entry.agentId, entry.targetId).has(current);
      if (!owned) {
        throw new Error(`Refusing to overwrite concurrently changed or unowned global agent: ${entry.targetPath}`);
      }
      await backupExistingPath(entry.targetPath, {
        family: "agent",
        label: `${entry.targetId} global agent ${entry.agentId}`,
        backupRoot: path.join(runtimeHomes[entry.targetId].dir, ".meta-kim", "backups"),
      });
    }
    await writeUtf8FileAtomic(entry.targetPath, entry.expected, `${entry.targetId}-global-agent`);
    recordSafe((rec) => rec.recordFile(entry.targetPath, {
      source: "sync-global-meta-theory",
      purpose: `${entry.targetId}-global-agent:${entry.agentId}`,
      category: CATEGORIES.A,
      runtimeTarget: entry.targetId,
    }));
  }
}

async function checkGlobalAgents(plan) {
  let inSync = true;
  for (const { targetId } of globalAgentTargets) {
    const targetEntries = plan.entries.filter((entry) => entry.targetId === targetId);
    let current = 0;
    for (const entry of targetEntries) {
      if ((await fs.readFile(entry.targetPath, "utf8").catch(() => null)) === entry.expected) current += 1;
    }
    console.log(`${current === targetEntries.length ? `${C.green}✓${C.reset}` : `${C.yellow}⊘${C.reset}`} ${C.dim}${targetId} global agents: ${current}/${targetEntries.length}${C.reset}`);
    if (current !== targetEntries.length) inSync = false;
  }
  return inSync;
}

async function canonicalClaudeMcpIdentity() {
  const parsed = JSON.parse(await fs.readFile(canonicalClaudeMcpPath, "utf8"));
  const entries = Object.entries(parsed.mcpServers ?? {});
  if (entries.length !== 1) throw new Error(`${canonicalClaudeMcpPath} must declare exactly one canonical server.`);
  const packageManifest = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
  const distribution = JSON.parse(await fs.readFile(distributionPath, "utf8"));
  const identity = resolvePortableMetaKimPackageIdentity(packageManifest, distribution);
  const runtimeBaseDir = path.dirname(runtimeHomes.claude.dir);
  const layout = resolveDurableMetaKimRuntimeLayout(
    runtimeBaseDir,
    identity,
    packageManifest,
  );
  const legacyScriptArg = (entries[0][1].args ?? []).find((value) =>
    typeof value === "string" && value.includes("__REPO_ROOT__"),
  );
  if (!legacyScriptArg) throw new Error(`${canonicalClaudeMcpPath} must declare a portable legacy script marker.`);
  return {
    name: entries[0][0],
    identity,
    packageManifest,
    layout,
    legacyScriptSuffix: legacyScriptArg.replace(/^__REPO_ROOT__[\\/]/u, ""),
    definition: layout.definition,
  };
}

function bundleTrackedFiles(layout) {
  return [
    [layout.packageManifestPath, "package-manifest"],
    [layout.cliPath, "cli"],
    [layout.serverPath, "server"],
  ];
}

async function manifestOwnsExactBundle(layout) {
  const directoryEntry = globalManifestSnapshot?.entries?.find((candidate) =>
    candidate.kind === "dir" &&
    candidate.source === "sync-global-meta-theory" &&
    candidate.purpose === "claude-global-mcp-runtime-bundle" &&
    path.resolve(candidate.path) === path.resolve(layout.bundleDir),
  );
  if (!directoryEntry) return false;
  if (
    typeof directoryEntry.directoryClosureSha256 === "string" ||
    Number.isFinite(directoryEntry.directoryClosureEntryCount)
  ) {
    const closure = directoryClosureSync(layout.bundleDir);
    return Boolean(
      closure &&
      closure.sha256 === directoryEntry.directoryClosureSha256 &&
      closure.entryCount === directoryEntry.directoryClosureEntryCount,
    );
  }

  // Manifests written before directory-closure ownership existed may be
  // migrated only when every historically tracked identity file is exact.
  for (const [filePath, label] of bundleTrackedFiles(layout)) {
    const content = await fs.readFile(filePath).catch(() => null);
    if (!content) return false;
    const entry = globalManifestSnapshot?.entries?.find((candidate) =>
      candidate.kind === "file" &&
      candidate.source === "sync-global-meta-theory" &&
      candidate.purpose === `claude-global-mcp-runtime-bundle:${label}` &&
      path.resolve(candidate.path) === path.resolve(filePath),
    );
    if (!entry || entry.size !== content.byteLength || entry.sha256 !== createHash("sha256").update(content).digest("hex")) {
      return false;
    }
  }
  return true;
}

function candidateLockContent(identity, sourcePackageSha256) {
  return `${JSON.stringify({
    schemaVersion: 1,
    packageName: identity.packageName,
    packageVersion: identity.packageVersion,
    sourcePackageSha256,
  }, null, 2)}\n`;
}

async function liveBundleMatchesCandidate(layout, identity, sourcePackageSha256) {
  const lockPath = path.join(layout.bundleDir, ".meta-kim-candidate.json");
  const current = await fs.readFile(lockPath, "utf8").catch(() => null);
  return current === candidateLockContent(identity, sourcePackageSha256);
}

function recordDurableMcpBundle(layout) {
  recordSafe((rec) => rec.recordDir(layout.bundleDir, {
    source: "sync-global-meta-theory",
    purpose: "claude-global-mcp-runtime-bundle",
    category: CATEGORIES.C,
  }));
  for (const [filePath, label] of bundleTrackedFiles(layout)) {
    recordSafe((rec) => rec.recordFile(filePath, {
      source: "sync-global-meta-theory",
      purpose: `claude-global-mcp-runtime-bundle:${label}`,
      category: CATEGORIES.C,
      runtimeTarget: "claude",
    }));
  }
}

async function resolveNpmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && await pathExists(candidate)) return candidate;
  }
  throw new Error("Unable to resolve npm-cli.js from the active Node installation.");
}

function runDurableMcpSelfTest(cliPath, cwd) {
  return execFileSync(
    process.execPath,
    [cliPath, "mcp", "self-test"],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function verifyDurableMcpLayout(layout, identity) {
  const installedManifest = JSON.parse(await fs.readFile(layout.packageManifestPath, "utf8"));
  if (installedManifest.name !== identity.packageName || installedManifest.version !== identity.packageVersion) {
    throw new Error("Durable MCP runtime package identity does not match the executing candidate.");
  }
  await fs.access(layout.cliPath);
  await fs.access(layout.serverPath);
  const output = runDurableMcpSelfTest(layout.cliPath, layout.packageRoot);
  if (!/"ok"\s*:\s*true/u.test(output)) {
    throw new Error("Durable MCP runtime self-test did not return ok=true.");
  }
}

function stagedLayoutFor(layout, stageDir) {
  const relativePackageRoot = path.relative(layout.bundleDir, layout.packageRoot);
  const packageRoot = path.join(stageDir, relativePackageRoot);
  return {
    ...layout,
    bundleDir: stageDir,
    packageRoot,
    packageManifestPath: path.join(packageRoot, "package.json"),
    cliPath: path.join(stageDir, path.relative(layout.bundleDir, layout.cliPath)),
    serverPath: path.join(stageDir, path.relative(layout.bundleDir, layout.serverPath)),
  };
}

async function materializeDurableMcpRuntime(plan) {
  const { layout, identity } = plan;
  const stageDir = path.join(
    path.dirname(layout.bundleDir),
    `.meta-kim-runtime-staged-${process.pid}-${randomUUID()}`,
  );
  assertHomeBound(stageDir);
  await assertRealHomeBound(stageDir);
  await fs.mkdir(stageDir, { recursive: true });
  let displacedPath = null;
  let promoted = false;
  let promotedClosure = null;
  try {
    const npmCliPath = await resolveNpmCliPath();
    if (process.env.META_KIM_TEST_FAIL_DURABLE_MCP_AT === "pack") {
      throw new Error("Injected durable MCP pack failure.");
    }
    execFileSync(
      process.execPath,
      [npmCliPath, "pack", repoRoot, "--pack-destination", stageDir],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const archives = (await fs.readdir(stageDir)).filter((name) => name.endsWith(".tgz"));
    if (archives.length !== 1) throw new Error(`Expected one packed candidate, found ${archives.length}.`);
    const archivePath = path.join(stageDir, archives[0]);
    const sourcePackageSha256 = createHash("sha256")
      .update(await fs.readFile(archivePath))
      .digest("hex");
    if (await pathExists(layout.bundleDir)) {
      if (!(await manifestOwnsExactBundle(layout))) {
        throw new Error(`Refusing to replace an unowned durable MCP runtime: ${layout.bundleDir}`);
      }
      if (await liveBundleMatchesCandidate(layout, identity, sourcePackageSha256)) {
        await fs.rm(stageDir, { recursive: true, force: true });
        recordDurableMcpBundle(layout);
        return { displacedPath: null, installed: false };
      }
    }
    if (process.env.META_KIM_TEST_FAIL_DURABLE_MCP_AT === "install") {
      throw new Error("Injected durable MCP install failure.");
    }
    execFileSync(
      process.execPath,
      [npmCliPath, "install", "--prefix", stageDir, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", archivePath],
      { cwd: stageDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    await fs.rm(archivePath, { force: true });
    await fs.writeFile(
      path.join(stageDir, ".meta-kim-candidate.json"),
      candidateLockContent(identity, sourcePackageSha256),
      "utf8",
    );
    const stagedLayout = stagedLayoutFor(layout, stageDir);
    await verifyDurableMcpLayout(stagedLayout, identity);
    promotedClosure = directoryClosureSync(stageDir);
    if (!promotedClosure) {
      throw new Error("Unable to capture the staged durable MCP bundle closure.");
    }

    await fs.mkdir(path.dirname(layout.bundleDir), { recursive: true });
    if (await pathExists(layout.bundleDir)) {
      displacedPath = path.join(
        path.dirname(layout.runtimeRoot),
        "backups",
        "mcp-runtime",
        legacyHookBackupStamp,
        `${path.basename(layout.bundleDir)}-${randomUUID()}`,
      );
      assertHomeBound(displacedPath);
      await assertRealHomeBound(displacedPath);
      await fs.mkdir(path.dirname(displacedPath), { recursive: true });
      await renameDirectoryWithRetry(layout.bundleDir, displacedPath);
    }
    if (process.env.META_KIM_TEST_FAIL_DURABLE_MCP_AT === "rename") {
      throw new Error("Injected durable MCP rename failure.");
    }
    await renameDirectoryWithRetry(stageDir, layout.bundleDir);
    promoted = true;
    if (process.env.META_KIM_TEST_CONCURRENT_DURABLE_MCP_EDIT === "post_rename_bundle") {
      await fs.writeFile(
        path.join(layout.bundleDir, "user-concurrent-runtime-file.txt"),
        "preserve concurrent bundle edit\n",
        "utf8",
      );
    }
    if (process.env.META_KIM_TEST_FAIL_DURABLE_MCP_AT === "post_rename_verify") {
      throw new Error("Injected durable MCP post_rename_verify failure.");
    }
    await verifyDurableMcpLayout(layout, identity);
  } catch (error) {
    const rollbackErrors = [];
    if (promoted && await pathExists(layout.bundleDir)) {
      const currentClosure = directoryClosureSync(layout.bundleDir);
      if (
        !currentClosure ||
        !promotedClosure ||
        currentClosure.sha256 !== promotedClosure.sha256 ||
        currentClosure.entryCount !== promotedClosure.entryCount
      ) {
        rollbackErrors.push("rollback_incomplete: promoted bundle changed concurrently");
      } else {
        try {
          await fs.rm(layout.bundleDir, { recursive: true, force: true });
        } catch (rollbackError) {
          rollbackErrors.push(`remove promoted bundle: ${rollbackError?.message ?? rollbackError}`);
        }
      }
    }
    if (
      rollbackErrors.length === 0 &&
      displacedPath &&
      !(await pathExists(layout.bundleDir)) &&
      await pathExists(displacedPath)
    ) {
      try {
        await renameDirectoryWithRetry(displacedPath, layout.bundleDir);
      } catch (rollbackError) {
        rollbackErrors.push(`restore displaced bundle: ${rollbackError?.message ?? rollbackError}`);
      }
    }
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    if (rollbackErrors.length > 0) {
      throw new Error(`${error?.message ?? error}; durable MCP rollback incomplete: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  }

  recordDurableMcpBundle(layout);
  return { displacedPath, installed: true, promotedClosure };
}

function claudeUserConfigPath() {
  return process.env.META_KIM_CLAUDE_USER_CONFIG ||
    path.join(path.dirname(runtimeHomes.claude.dir), ".claude.json");
}

async function buildClaudeUserMcpPlan() {
  if (!selectedTargetIds.includes("claude")) return null;
  const configPath = claudeUserConfigPath();
  assertHomeBound(configPath);
  await assertRealHomeBound(configPath);
  const base = (await pathExists(configPath))
    ? JSON.parse(await fs.readFile(configPath, "utf8"))
    : {};
  const canonical = await canonicalClaudeMcpIdentity();
  const managedFingerprints = new Set(
    (globalManifestSnapshot?.entries ?? [])
      .filter((entry) =>
        entry.kind === "mcp-server" &&
        path.resolve(entry.path) === path.resolve(configPath) &&
        entry.mcpServerName === canonical.name &&
        typeof entry.mcpServerFingerprint === "string",
      )
      .map((entry) => entry.mcpServerFingerprint),
  );
  const merged = mergeClaudeUserMcpConfig(
    base,
    { ...canonical, canonicalName: canonical.name, portableDefinition: canonical.definition, managedFingerprints },
  );
  return { configPath, base, managedFingerprints, ...canonical, ...merged };
}

async function syncClaudeUserMcp(plan) {
  if (!plan) return;
  const configExisted = await pathExists(plan.configPath);
  const originalRaw = configExisted ? await fs.readFile(plan.configPath, "utf8") : null;
  const base = configExisted ? JSON.parse(originalRaw) : {};
  const merged = mergeClaudeUserMcpConfig(base, {
    canonicalName: plan.name,
    portableDefinition: plan.definition,
    identity: plan.identity,
    legacyScriptSuffix: plan.legacyScriptSuffix,
    managedFingerprints: plan.managedFingerprints,
  });
  if (merged.collisions.length > 0) {
    throw new Error(`Refusing to overwrite concurrently changed or unowned Claude MCP entries: ${merged.collisions.join(", ")}`);
  }
  if (!isDeepStrictEqual(base, merged.config)) {
    const promotedRaw = `${JSON.stringify(merged.config, null, 2)}\n`;
    plan.configTransaction = {
      existed: configExisted,
      raw: originalRaw,
      promotedRaw,
      changed: true,
    };
    if (await pathExists(plan.configPath)) {
      await backupExistingPath(plan.configPath, {
        family: "mcp",
        label: "Claude user MCP config",
        backupRoot: path.join(runtimeHomes.claude.dir, ".meta-kim", "backups"),
      });
    }
    await writeUtf8FileAtomic(plan.configPath, promotedRaw, "claude-user-mcp");
  }
  const registeredDefinition = merged.config.mcpServers?.[plan.name];
  recordSafe((rec) => rec.recordMcpServer(plan.configPath, plan.name, {
    source: "sync-global-meta-theory",
    purpose: "claude-global-mcp",
    category: CATEGORIES.C,
    fingerprint: mcpDefinitionFingerprint(registeredDefinition),
  }));
}

async function fsyncDirectoryBestEffort(directoryPath) {
  let handle = null;
  try {
    handle = await fs.open(directoryPath, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some Windows/filesystem combinations.
    // The staged file itself is still fsynced before the atomic rename.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function fileStatIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function fileStatIdentityHash(stat) {
  return sha256Text(JSON.stringify(fileStatIdentity(stat)));
}

async function captureExactFileSnapshot(targetPath) {
  let before;
  try {
    before = await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, bytes: null, size: 0, sha256: null };
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Unsafe config file type: ${targetPath}`);
  }
  const bytes = await fs.readFile(targetPath);
  const after = await fs.lstat(targetPath);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    fileStatIdentityHash(before) !== fileStatIdentityHash(after) ||
    bytes.length !== after.size
  ) {
    throw new Error(`Concurrent config change while taking snapshot: ${targetPath}`);
  }
  return {
    exists: true,
    bytes,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    stat: fileStatIdentity(after),
    identitySha256: fileStatIdentityHash(after),
  };
}

function exactFileSnapshotMatches(actual, expected, { requireIdentity = true } = {}) {
  if (actual?.exists !== expected?.exists) return false;
  if (!expected?.exists) return true;
  return Boolean(
    actual.size === expected.size &&
    actual.sha256 === expected.sha256 &&
    (!requireIdentity || actual.identitySha256 === expected.identitySha256),
  );
}

async function injectConcurrentCodexConfigEdit(targetPath, phase) {
  if (process.env.META_KIM_TEST_CONCURRENT_CODEX_CONFIG_EDIT !== phase) return;
  const current = await fs.readFile(targetPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const separator = current && !/(?:\r\n|\n|\r)$/u.test(current) ? "\n" : "";
  await fs.writeFile(
    targetPath,
    `${current}${separator}# concurrent user edit during ${phase}\n`,
    "utf8",
  );
}

async function promoteExactFileFromSnapshot(
  targetPath,
  originalSnapshot,
  replacementBytes,
  {
    failureId = null,
    beforeCommit = null,
    replacementMode = originalSnapshot?.stat?.mode ?? 0o600,
  } = {},
) {
  assertHomeBound(targetPath);
  await assertRealHomeBound(targetPath);
  const bytes = Buffer.isBuffer(replacementBytes)
    ? replacementBytes
    : Buffer.from(replacementBytes);
  const parentDir = path.dirname(targetPath);
  await fs.mkdir(parentDir, { recursive: true });
  const stagePath = path.join(
    parentDir,
    `.meta-kim-staged-${path.basename(targetPath).replace(/^\.+/u, "")}-${process.pid}-${randomUUID()}`,
  );
  assertHomeBound(stagePath);
  await assertRealHomeBound(stagePath);

  let handle = null;
  let renamed = false;
  try {
    handle = await fs.open(stagePath, "wx", replacementMode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.chmod(stagePath, replacementMode);

    if (
      failureId &&
      process.env.META_KIM_TEST_FAIL_ATOMIC_SETTINGS_WRITE === failureId
    ) {
      throw new Error(`Injected atomic settings write failure: ${failureId}`);
    }
    await beforeCommit?.();
    const current = await captureExactFileSnapshot(targetPath);
    if (!exactFileSnapshotMatches(current, originalSnapshot)) {
      throw new Error(`concurrent_change:${targetPath}`);
    }

    await fs.rename(stagePath, targetPath);
    renamed = true;
    await fsyncDirectoryBestEffort(parentDir);
    const promoted = await captureExactFileSnapshot(targetPath);
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    if (
      !promoted.exists ||
      promoted.size !== bytes.length ||
      promoted.sha256 !== expectedHash
    ) {
      throw new Error(
        `rollback_incomplete: promoted config changed before verification: ${targetPath}`,
      );
    }
    return {
      changed: true,
      targetPath,
      original: originalSnapshot,
      promoted,
    };
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await fs.rm(stagePath, { force: true }).catch(() => {});
  }
}

async function writeUtf8FileAtomic(targetPath, content, failureId) {
  assertHomeBound(targetPath);
  await assertRealHomeBound(targetPath);

  const parentDir = path.dirname(targetPath);
  await fs.mkdir(parentDir, { recursive: true });
  const existingStat = await fs.stat(targetPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const stagePath = path.join(
    parentDir,
    `.meta-kim-staged-${path.basename(targetPath).replace(/^\.+/u, "")}-${process.pid}-${randomUUID()}`,
  );
  assertHomeBound(stagePath);
  await assertRealHomeBound(stagePath);

  let handle = null;
  let renamed = false;
  try {
    handle = await fs.open(stagePath, "wx", existingStat?.mode ?? 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;

    if (existingStat) {
      await fs.chmod(stagePath, existingStat.mode);
    }
    if (process.env.META_KIM_TEST_FAIL_ATOMIC_SETTINGS_WRITE === failureId) {
      throw new Error(`Injected atomic settings write failure: ${failureId}`);
    }

    await fs.rename(stagePath, targetPath);
    renamed = true;
    await fsyncDirectoryBestEffort(parentDir);
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) {
      await fs.rm(stagePath, { force: true }).catch(() => {});
    }
  }
}

async function backupExistingPath(targetPath, { family, label, backupRoot = null }) {
  assertHomeBound(targetPath);
  await assertRealHomeBound(targetPath);
  if (!(await pathExists(targetPath))) return null;

  const backupDir = backupRoot
    ? path.join(backupRoot, family, legacyHookBackupStamp)
    : path.join(
      path.dirname(targetPath),
      `.meta-kim-${family}-backup`,
      legacyHookBackupStamp,
    );
  assertHomeBound(backupDir);
  await assertRealHomeBound(backupDir);
  await fs.mkdir(backupDir, { recursive: true });

  const backupPath = path.join(backupDir, path.basename(targetPath));
  assertHomeBound(backupPath);
  await assertRealHomeBound(backupPath);
  await fs.cp(targetPath, backupPath, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
  console.log(`Backed up previous ${label} to ${backupPath}`);
  return backupPath;
}

async function resolveTargets() {
  const targetContext = await resolveTargetContext(cliArgs);
  runtimeProfiles = targetContext.profiles;
  runtimeHomes = Object.fromEntries(
    Object.keys(runtimeProfiles).map((targetId) => [
      targetId,
      resolveRuntimeHomeInfo(targetId),
    ]),
  );

  selectedTargetIds = [...targetContext.activeTargets];
  globalAgentTargets = resolveGlobalAgentProjectionTargets(
    runtimeProfiles,
    selectedTargetIds,
  );
  globalAgentMigrationTargets = resolveGlobalAgentProjectionTargets(
    runtimeProfiles,
    Object.keys(runtimeProfiles),
    { requireMigrationSupport: true },
  );

  allowedRoots = Object.values(runtimeHomes).map(({ dir }) =>
    path.resolve(dir),
  );
  if (selectedTargetIds.includes("codex")) {
    allowedRoots.push(path.resolve(path.dirname(CODEX_LEGACY_SHARED_SKILL_ROOT)));
  }
  if (selectedTargetIds.includes("claude")) {
    const runtimeBaseDir = path.dirname(runtimeHomes.claude.dir);
    allowedRoots.push(path.resolve(runtimeBaseDir, ".meta-kim", "runtime"));
    allowedRoots.push(path.resolve(runtimeBaseDir, ".meta-kim", "backups"));
  }
  allowedExactFiles = selectedTargetIds.includes("claude")
    ? [path.resolve(claudeUserConfigPath())]
    : [];
  allowedRealRoots = await Promise.all(
    allowedRoots.map((root) => projectedRealPath(root)),
  );
  allowedExactRealFiles = await Promise.all(allowedExactFiles.map(async (filePath) => {
    const realParent = await projectedRealPath(path.dirname(filePath));
    return path.join(realParent, path.basename(filePath));
  }));
  globalManifestSnapshot = readManifest(manifestPathFor("global"));

  activeTargets = selectedTargetIds.map((targetId) => ({
    targetId,
    label: `${targetContext.profiles[targetId]?.label ?? targetId} global skill`,
    dir: path.join(runtimeHomes[targetId].dir, "skills", "meta-theory"),
  }));

  const legacyFlatSkillLabels = {
    claude: "legacy Claude Code flat skill",
    codex: "legacy Codex flat skill",
    openclaw: "legacy OpenClaw flat skill",
    cursor: "legacy Cursor flat skill",
  };
  cleanupTargets = selectedTargetIds.map((targetId) => ({
    label:
      legacyFlatSkillLabels[targetId] ??
      `legacy ${targetContext.profiles[targetId]?.label ?? targetId} flat skill`,
    dir: path.join(runtimeHomes[targetId].dir, "skills", "meta-theory.md"),
  }));

  staleSkillCleanupTargets = [];
  for (const targetId of selectedTargetIds) {
    const roots = [path.join(runtimeHomes[targetId].dir, "skills")];
    if (targetId === "codex") {
      roots.push(CODEX_LEGACY_SHARED_SKILL_ROOT);
    }
    for (const skillsRoot of roots) {
      for (const aliasSpec of STALE_META_KIM_SKILL_ALIAS_SPECS) {
        staleSkillCleanupTargets.push({
          ...aliasSpec,
          runtimeId: targetId,
          dir: path.join(skillsRoot, aliasSpec.name),
        });
      }
    }
  }
  if (selectedTargetIds.includes("codex")) {
    staleSkillCleanupTargets.push({
      name: "meta-theory",
      label: "legacy shared Codex global meta-theory duplicate",
      runtimeId: "codex",
      dir: path.join(CODEX_LEGACY_SHARED_SKILL_ROOT, "meta-theory"),
      required: [/name:\s*meta-theory/i, /Meta_Kim executable governance dispatcher/i],
      removeOnlyWhenPathExists: path.join(
        runtimeHomes.codex.dir,
        "skills",
        "meta-theory",
      ),
    });
  }
}

async function* walkFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
      continue;
    }
    if (entry.isFile()) {
      yield fullPath;
    }
  }
}

async function fingerprintDir(rootDir) {
  if (!(await pathExists(rootDir))) {
    return null;
  }

  const filePaths = [];
  for await (const filePath of walkFiles(rootDir)) {
    filePaths.push(filePath);
  }
  filePaths.sort((left, right) => left.localeCompare(right));

  const hash = createHash("sha256");
  for (const filePath of filePaths) {
    const relativePath = path.relative(rootDir, filePath).replace(/\\/g, "/");
    hash.update(relativePath);
    hash.update("\n");
    hash.update(await fs.readFile(filePath));
    hash.update("\n");
  }

  return {
    fileCount: filePaths.length,
    hash: hash.digest("hex"),
  };
}

function renderGlobalSkillContent(content, targetId, relativePath) {
  if (targetId !== "codex") {
    return content;
  }
  const projected = applyRuntimePaths(content, "codex");
  return relativePath === "SKILL.md"
    ? buildCodexSkillContent(projected)
    : projected;
}

async function fingerprintSourceForTarget(targetId) {
  if (!(await pathExists(sourceDir))) {
    return null;
  }

  const filePaths = [];
  for await (const filePath of walkFiles(sourceDir)) {
    filePaths.push(filePath);
  }
  filePaths.sort((left, right) => left.localeCompare(right));

  const hash = createHash("sha256");
  for (const filePath of filePaths) {
    const relativePath = path.relative(sourceDir, filePath).replace(/\\/g, "/");
    const content = await fs.readFile(filePath, "utf8");
    hash.update(relativePath);
    hash.update("\n");
    hash.update(renderGlobalSkillContent(content, targetId, relativePath));
    hash.update("\n");
  }

  return {
    fileCount: filePaths.length,
    hash: hash.digest("hex"),
  };
}

async function fingerprintSelectedFiles(rootDir, allowedNames) {
  if (!(await pathExists(rootDir))) {
    return null;
  }

  const filePaths = [];
  for (const fileName of [...allowedNames].sort((left, right) => left.localeCompare(right))) {
    const filePath = path.join(rootDir, fileName);
    if (await pathExists(filePath)) {
      filePaths.push(filePath);
    }
  }

  const hash = createHash("sha256");
  for (const filePath of filePaths) {
    const relativePath = path.relative(rootDir, filePath).replace(/\\/g, "/");
    hash.update(relativePath);
    hash.update("\n");
    hash.update(await fs.readFile(filePath));
    hash.update("\n");
  }

  return {
    fileCount: filePaths.length,
    hash: hash.digest("hex"),
  };
}

async function canonicalHookSourcePath(fileName, runtimeId) {
  const owner = runtimeHookSourceOwner(runtimeId, fileName);
  if (!owner) return null;
  if (owner === "shared") {
    const shared = path.join(sharedHooksDir, fileName);
    return (await pathExists(shared)) ? shared : null;
  }
  const claudeSpecific = path.join(repoHooksDir, fileName);
  if (await pathExists(claudeSpecific)) {
    return claudeSpecific;
  }
  return null;
}

async function fingerprintGlobalHookSources(runtimeId) {
  const hash = createHash("sha256");
  let fileCount = 0;
  for (const fileName of [...GLOBAL_HOOK_PACKAGE_FILES].sort((left, right) => left.localeCompare(right))) {
    const filePath = await canonicalHookSourcePath(fileName, runtimeId);
    if (!filePath) {
      throw new Error(`Missing canonical Hook source for ${runtimeId}:${fileName}`);
    }
    hash.update(fileName);
    hash.update("\n");
    hash.update(await fs.readFile(filePath));
    hash.update("\n");
    fileCount += 1;
  }
  return {
    fileCount,
    hash: hash.digest("hex"),
  };
}

async function fingerprintInstalledGlobalHooks(rootDir) {
  if (!(await pathExists(rootDir))) {
    return null;
  }
  const hash = createHash("sha256");
  let fileCount = 0;
  for (const fileName of [...GLOBAL_HOOK_PACKAGE_FILES].sort((left, right) => left.localeCompare(right))) {
    const filePath = path.join(rootDir, fileName);
    if (!(await pathExists(filePath))) continue;
    hash.update(fileName);
    hash.update("\n");
    hash.update(await fs.readFile(filePath));
    hash.update("\n");
    fileCount += 1;
  }
  return {
    fileCount,
    hash: hash.digest("hex"),
  };
}

async function copyCanonicalSkill(targetDir, targetId) {
  assertHomeBound(targetDir);
  await assertRealHomeBound(targetDir);
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });

  const expectedFiles = new Set();
  for await (const sourcePath of walkFiles(sourceDir)) {
    const relativePath = path.relative(sourceDir, sourcePath).replace(/\\/g, "/");
    expectedFiles.add(relativePath);
    const targetPath = path.join(targetDir, ...relativePath.split("/"));
    assertHomeBound(targetPath);
    await assertRealHomeBound(targetPath);
    const content = await fs.readFile(sourcePath, "utf8");
    await writeUtf8FileIfChanged(
      targetPath,
      renderGlobalSkillContent(content, targetId, relativePath),
    );
  }

  // The skill directory is fully Meta_Kim-owned. Retire files removed from the
  // canonical source without recreating unchanged files and churning mtimes.
  for await (const targetPath of walkFiles(targetDir)) {
    const relativePath = path.relative(targetDir, targetPath).replace(/\\/g, "/");
    if (expectedFiles.has(relativePath)) continue;
    assertHomeBound(targetPath);
    await assertRealHomeBound(targetPath);
    await fs.rm(targetPath, { force: true });
  }

  recordSafe((rec) =>
    rec.recordDir(targetDir, {
      source: "sync-global-meta-theory",
      purpose: `${targetId ?? "runtime"}-global-skill`,
      category: CATEGORIES.A,
    }),
  );
}

async function assertCanonicalSkillFrontmatter() {
  const raw = await fs.readFile(sourceSkillFile, "utf8");
  const validation = validateSkillFrontmatter(raw);
  if (!validation.ok) {
    throw new Error(
      `Invalid canonical skill frontmatter in ${sourceSkillFile}: ${validation.message}`,
    );
  }
}

function renderGlobalCommandContent(raw) {
  return raw.replaceAll("__META_KIM_PACKAGE_ROOT__", repoRoot.replace(/\\/g, "/"));
}

async function collectCanonicalCommands(sourceDir) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".md") ||
      entry.name.includes(".tmp.") ||
      entry.name.endsWith(".tmp")
    ) {
      continue;
    }
    files.push({
      name: entry.name,
      content: renderGlobalCommandContent(
        await fs.readFile(path.join(sourceDir, entry.name), "utf8"),
      ),
    });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

async function copyRuntimeCommands(targetId, sourceDir) {
  const commandsDir = path.join(runtimeHomes[targetId].dir, "commands");
  assertHomeBound(commandsDir);
  await assertRealHomeBound(commandsDir);
  const commands = await collectCanonicalCommands(sourceDir);
  await fs.mkdir(commandsDir, { recursive: true });

  const targetPaths = [];
  for (const command of commands) {
    const targetPath = path.join(commandsDir, command.name);
    assertHomeBound(targetPath);
    await assertRealHomeBound(targetPath);
    await writeUtf8FileIfChanged(targetPath, command.content);
    targetPaths.push(targetPath);
    recordSafe((rec) =>
      rec.recordFile(targetPath, {
        source: "sync-global-meta-theory",
        purpose: `${targetId}-global-command`,
        category: CATEGORIES.A,
      }),
    );
  }
  return targetPaths;
}

async function checkRuntimeCommands(targetId, sourceDir) {
  const commandsDir = path.join(runtimeHomes[targetId].dir, "commands");
  assertHomeBound(commandsDir);
  const commands = await collectCanonicalCommands(sourceDir);
  const outOfSync = [];

  for (const command of commands) {
    const targetPath = path.join(commandsDir, command.name);
    assertHomeBound(targetPath);
    const targetRaw = (await pathExists(targetPath))
      ? await fs.readFile(targetPath, "utf8")
      : null;
    if (targetRaw !== command.content) {
      outOfSync.push(command.name);
    }
  }

  const inSync = outOfSync.length === 0;
  const label = targetId === "claude" ? "Claude Code" : "Codex";
  console.log(
    `${inSync ? `${C.green}✓${C.reset}` : `${C.yellow}⊘${C.reset}`} ${C.dim}${label} commands: ${commandsDir} (${commands.length} files)${C.reset}`,
  );
  if (!inSync) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}Out-of-sync ${label} commands: ${outOfSync.join(", ")}${C.reset}`,
    );
  }
  return { inSync, outOfSync, commands };
}

async function ensureCodexGlobalConfigChoiceSurface() {
  const configPath = path.join(runtimeHomes.codex.dir, "config.toml");
  const manifestPurpose =
    "codex-global-config-choice-surface-and-app-native-controls";
  assertHomeBound(configPath);
  await assertRealHomeBound(configPath);
  await fs.mkdir(path.dirname(configPath), { recursive: true });

  const originalSnapshot = await captureExactFileSnapshot(configPath);
  const prev = originalSnapshot.exists
    ? originalSnapshot.bytes.toString("utf8")
    : "";
  if (
    originalSnapshot.exists &&
    !Buffer.from(prev, "utf8").equals(originalSnapshot.bytes)
  ) {
    throw new Error(`Codex config is not valid UTF-8: ${configPath}`);
  }
  const planned = planCodexAppNativeControls(prev, {
    codexHome: runtimeHomes.codex.dir,
  });
  const next = planned.text;

  if (prev === next) {
    const previousEntry = (globalManifestSnapshot?.entries ?? []).find((entry) =>
      path.resolve(entry.path) === path.resolve(configPath) &&
      entry.purpose === manifestPurpose
    );
    if (previousEntry?.kind === "settings-merge") {
      recordSafe((rec) => rec.forget(configPath, manifestPurpose));
    }
    console.log(
      `${C.green}✓${C.reset} ${C.dim}Codex choice surface and App native controls already enabled: ${configPath}${C.reset}`,
    );
    return { configPath, transaction: null };
  }
  if (planned.mutations.length === 0) {
    throw new Error(
      `Codex config planner changed bytes without a mutation journal: ${configPath}`,
    );
  }

  if (originalSnapshot.exists) {
    await backupExistingPath(configPath, {
      family: "settings",
      label: "Codex config",
    });
  }

  const transaction = await promoteExactFileFromSnapshot(
    configPath,
    originalSnapshot,
    Buffer.from(next, "utf8"),
    {
      failureId: "codex-global-config",
      beforeCommit: () => injectConcurrentCodexConfigEdit(
        configPath,
        "precommit",
      ),
    },
  );
  recordSafe((rec) =>
    rec.recordTomlFragmentMerge(
      configPath,
      planned.mutations,
      {
        source: "sync-global-meta-theory",
        purpose: manifestPurpose,
        category: CATEGORIES.C,
      },
    ),
  );
  console.log(
    `${C.green}✓${C.reset} ${C.dim}Enabled Codex choice surface and App native controls: ${configPath}${C.reset}`,
  );
  return { configPath, transaction };
}

async function removeIfExists(targetPath) {
  assertHomeBound(targetPath);
  await assertRealHomeBound(targetPath);
  if (!(await pathExists(targetPath))) {
    return false;
  }
  await fs.rm(targetPath, { recursive: true, force: true });
  return true;
}

async function readSkillSignatureText(targetPath) {
  if (!(await pathExists(targetPath))) {
    return "";
  }
  const stat = await fs.lstat(targetPath);
  if (stat.isFile()) {
    return fs.readFile(targetPath, "utf8");
  }
  if (!stat.isDirectory()) {
    return "";
  }

  const chunks = [];
  for await (const filePath of walkFiles(targetPath)) {
    if (path.basename(filePath) !== "SKILL.md") continue;
    chunks.push(await fs.readFile(filePath, "utf8"));
    if (chunks.length >= 8) break;
  }
  return chunks.join("\n\n");
}

async function isStaleMetaKimSkillAlias(target) {
  if (!(await pathExists(target.dir))) {
    return false;
  }
  if (
    target.removeOnlyWhenPathExists &&
    !(await pathExists(target.removeOnlyWhenPathExists))
  ) {
    return false;
  }
  const signatureText = await readSkillSignatureText(target.dir);
  if (!signatureText) {
    return false;
  }
  return target.required.every((pattern) => pattern.test(signatureText));
}

async function backupAndRemoveStaleSkillAlias(target) {
  assertHomeBound(target.dir);
  await assertRealHomeBound(target.dir);
  if (!(await isStaleMetaKimSkillAlias(target))) {
    return false;
  }

  const backupRoot = path.join(
    runtimeHomes[target.runtimeId].dir,
    ".meta-kim",
    "backups",
    "stale-skill-aliases",
    legacyHookBackupStamp,
  );
  assertHomeBound(backupRoot);
  await assertRealHomeBound(backupRoot);
  await fs.mkdir(backupRoot, { recursive: true });
  const backupPath = path.join(
    backupRoot,
    `${path.basename(target.dir)}-${path
      .resolve(target.dir)
      .replace(/^[A-Za-z]:/, "")
      .replace(/[^A-Za-z0-9_.-]+/g, "_")}`,
  );
  assertHomeBound(backupPath);
  await assertRealHomeBound(backupPath);
  await fs.cp(target.dir, backupPath, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
  await fs.rm(target.dir, { recursive: true, force: true });
  console.log(
    `${C.green}✓${C.reset} ${C.dim}Removed ${target.label}: ${target.dir}${C.reset}`,
  );
  console.log(
    `${C.dim}  backup: ${backupPath}${C.reset}`,
  );
  return true;
}

async function sameFileContent(leftPath, rightPath) {
  try {
    const [left, right] = await Promise.all([
      fs.readFile(leftPath),
      fs.readFile(rightPath),
    ]);
    return left.equals(right);
  } catch {
    return false;
  }
}

async function backupAndRemoveLegacyRootHook(
  topHooksDir,
  fileName,
  { canonicalSourcePath = null, retired = false } = {},
) {
  const legacyTopPath = path.join(topHooksDir, fileName);
  assertHomeBound(legacyTopPath);
  await assertRealHomeBound(legacyTopPath);
  if (!(await pathExists(legacyTopPath))) {
    return false;
  }
  const owned = retired
    ? await isOwnedRetiredMetaKimHook(legacyTopPath, fileName)
    : canonicalSourcePath &&
      (await sameFileContent(legacyTopPath, canonicalSourcePath));
  if (!owned) return false;
  const backupDir = path.join(
    topHooksDir,
    ".meta-kim-legacy-backup",
    legacyHookBackupStamp,
  );
  assertHomeBound(backupDir);
  await assertRealHomeBound(backupDir);
  await fs.mkdir(backupDir, { recursive: true });
  await fs.copyFile(legacyTopPath, path.join(backupDir, fileName));
  await fs.rm(legacyTopPath, { force: true });
  removedOwnedLegacyHookPaths.add(
    path.resolve(legacyTopPath).replace(/\\/g, "/"),
  );
  return true;
}

async function isOwnedRetiredMetaKimHook(filePath, fileName) {
  if (fileName !== "pre-git-push-confirm.mjs" || !(await pathExists(filePath))) {
    return false;
  }
  let source;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch {
    return false;
  }
  return [
    "PreToolUse hook: remind before git push",
    "readJsonFromStdin",
    "About to git push",
    "permissionDecision: \"allow\"",
  ].every((marker) => source.includes(marker));
}

function globalMetaKimHooksDir() {
  return path.join(runtimeHomes.claude.dir, "hooks", "meta-kim");
}

function codexGlobalMetaKimHooksDir() {
  return path.join(runtimeHomes.codex.dir, "hooks", "meta-kim");
}

async function copyCanonicalHooksToGlobal() {
  const dest = globalMetaKimHooksDir();
  assertHomeBound(dest);
  await assertRealHomeBound(dest);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await backupExistingPath(dest, {
    family: "hook-package",
    label: "Claude Code global hook package",
  });
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  for (const fileName of GLOBAL_HOOK_PACKAGE_FILES) {
    const sourcePath = await canonicalHookSourcePath(fileName, "claude");
    if (!sourcePath) {
      throw new Error(`Missing canonical Hook source for claude:${fileName}`);
    }
    const destPath = path.join(dest, fileName);
    await assertRealHomeBound(destPath);
    await fs.copyFile(sourcePath, destPath);
    const removed = await backupAndRemoveLegacyRootHook(
      path.dirname(dest),
      fileName,
      { canonicalSourcePath: sourcePath },
    );
    const legacyPath = path.join(path.dirname(dest), fileName);
    if (!removed && (await pathExists(legacyPath))) {
      console.warn(`Preserved unowned same-name Hook: ${legacyPath}`);
    }
  }

  // Cleanup hooks removed from canonical but still present in older installs.
  for (const retired of RETIRED_HOOK_FILES) {
    const retiredPath = path.join(dest, retired);
    assertHomeBound(retiredPath);
    if (await pathExists(retiredPath)) {
      await fs.rm(retiredPath, { force: true });
    }
  }
  // Also cleanup top-level global hooks dir (pre-meta-kim-subdir layout)
  const topHooksDir = path.dirname(dest);
  for (const retired of RETIRED_HOOK_FILES) {
    const topPath = path.join(topHooksDir, retired);
    assertHomeBound(topPath);
    await assertRealHomeBound(topPath);
    if (await isOwnedRetiredMetaKimHook(topPath, retired)) {
      await backupAndRemoveLegacyRootHook(topHooksDir, retired, {
        retired: true,
      });
    } else if (await pathExists(topPath)) {
      console.warn(
        `Preserved unowned same-name Hook during retired cleanup: ${topPath}`,
      );
    }
  }

  recordSafe((rec) =>
    rec.recordDir(dest, {
      source: "sync-global-meta-theory",
      purpose: "claude-global-hooks-dir",
      category: CATEGORIES.B,
    }),
  );
  try {
    const entries = await fs.readdir(dest, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      recordSafe((rec) =>
        rec.recordFile(path.join(dest, entry.name), {
          source: "sync-global-meta-theory",
          purpose: "claude-global-hook",
          category: CATEGORIES.B,
        }),
      );
    }
  } catch {
    /* directory iteration best-effort */
  }
}

async function copyCanonicalHooksToCodexGlobal() {
  const dest = codexGlobalMetaKimHooksDir();
  assertHomeBound(dest);
  await assertRealHomeBound(dest);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await backupExistingPath(dest, {
    family: "hook-package",
    label: "Codex global hook package",
  });
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  for (const fileName of GLOBAL_HOOK_PACKAGE_FILES) {
    const sourcePath = await canonicalHookSourcePath(fileName, "codex");
    if (!sourcePath) {
      throw new Error(`Missing canonical Hook source for codex:${fileName}`);
    }
    const destPath = path.join(dest, fileName);
    await assertRealHomeBound(destPath);
    await fs.copyFile(sourcePath, destPath);
  }

  for (const retired of RETIRED_HOOK_FILES) {
    const retiredPath = path.join(dest, retired);
    assertHomeBound(retiredPath);
    if (await pathExists(retiredPath)) {
      await fs.rm(retiredPath, { force: true });
    }
  }

  recordSafe((rec) =>
    rec.recordDir(dest, {
      source: "sync-global-meta-theory",
      purpose: "codex-global-hooks-dir",
      category: CATEGORIES.B,
    }),
  );
  try {
    const entries = await fs.readdir(dest, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      recordSafe((rec) =>
        rec.recordFile(path.join(dest, entry.name), {
          source: "sync-global-meta-theory",
          purpose: "codex-global-hook",
          category: CATEGORIES.B,
        }),
      );
    }
  } catch {
    /* directory iteration best-effort */
  }
}

async function syncClaudeGlobalSettingsHooks() {
  const absHooks = globalMetaKimHooksDir();
  const settingsPath = path.join(runtimeHomes.claude.dir, "settings.json");
  assertHomeBound(settingsPath);
  await assertRealHomeBound(settingsPath);

  const template = buildMetaKimHooksTemplate(absHooks, repoRoot, {
    hookPromptCommand: await claudeGlobalHookPromptCommand(),
  });
  const recordSettingsMerge = () => {
    recordSafe((rec) => {
      const managedCommands = [];
      for (const blocks of Object.values(template)) {
        for (const block of blocks ?? []) {
          for (const h of block.hooks ?? []) {
            if (h?.command) managedCommands.push(h.command);
          }
        }
      }
      rec.recordSettingsMerge(settingsPath, managedCommands, {
        source: "sync-global-meta-theory",
        purpose: "claude-global-settings-merge",
        category: CATEGORIES.C,
        managedHookFragments: flattenHookFragments(template),
      });
    });
  };

  let base = {};
  if (await pathExists(settingsPath)) {
    const raw = await fs.readFile(settingsPath, "utf8");
    try {
      base = JSON.parse(raw);
    } catch {
      throw new Error(
        `Invalid JSON in ${settingsPath}; fix or move aside before sync.`,
      );
    }
  }

  if (base.disableAllHooks === true) {
    console.warn(
      "Warning: ~/.claude/settings.json has disableAllHooks=true — Meta_Kim hook entries were merged but will not run until disabled.",
    );
  }

  const merged = mergeGlobalMetaKimHooksIntoSettings(base, template, {
    isManagedHookCommand: isOwnedGlobalMetaKimHookCommand,
  });
  const out = `${JSON.stringify(merged, null, 2)}\n`;
  const prev = (await pathExists(settingsPath))
    ? await fs.readFile(settingsPath, "utf8")
    : null;

  if (prev === out) {
    console.log(
      `Claude Code settings hooks already up to date: ${settingsPath}`,
    );
    recordSettingsMerge();
    return;
  }

  if (prev !== null) {
    await backupExistingPath(settingsPath, {
      family: "settings",
      label: "Claude Code settings",
    });
  }

  await writeUtf8FileAtomic(settingsPath, out, "claude-settings");
  console.log(`Merged Meta_Kim hooks into ${settingsPath}`);
  recordSettingsMerge();
}

function codexGlobalHooksJsonPath() {
  return path.join(runtimeHomes.codex.dir, "hooks.json");
}

function codexGlobalHookPromptAdapterPath() {
  return path.join(runtimeHomes.codex.dir, "hooks", "hookprompt-adapter.mjs");
}

async function claudeGlobalHookPromptCommand() {
  const scriptPath = path.join(
    runtimeHomes.claude.dir,
    "hooks",
    "user-prompt-submit.js",
  );
  return (await pathExists(scriptPath)) ? hookCommandNode(scriptPath) : null;
}

async function ensureCodexGlobalHookPromptAdapter() {
  const adapterPath = codexGlobalHookPromptAdapterPath();
  assertHomeBound(adapterPath);
  await assertRealHomeBound(adapterPath);
  await fs.mkdir(path.dirname(adapterPath), { recursive: true });
  await fs.writeFile(adapterPath, buildHookPromptAdapterSource("codex"), "utf8");
  recordSafe((rec) =>
    rec.recordFile(adapterPath, {
      source: "sync-global-meta-theory",
      purpose: "codex-global-hookprompt-adapter",
      category: CATEGORIES.B,
    }),
  );
  return adapterPath;
}

function buildCodexGlobalHooksTemplate() {
  const absHooks = codexGlobalMetaKimHooksDir();
  return buildCodexHooksJson({
    graphifyHookPath: path.join(absHooks, "graphify-context.mjs"),
    memoryHookPath: path.join(absHooks, "meta-kim-memory-save.mjs"),
    spineHookPath: path.join(absHooks, "activate-meta-theory-spine.mjs"),
    packageRoot: repoRoot,
    enforceAgentDispatchHookPath: path.join(
      absHooks,
      "enforce-agent-dispatch.mjs",
    ),
    hookPromptAdapterPath: codexGlobalHookPromptAdapterPath(),
    stopSpineCleanupHookPath: path.join(absHooks, "stop-spine-cleanup.mjs"),
  });
}

function stripGlobalMetaKimHooksFromCodexConfig(config = {}) {
  const next = structuredClone(config && typeof config === "object" ? config : {});
  const hooks = {};
  for (const [event, blocks] of Object.entries(next.hooks ?? {})) {
    if (!Array.isArray(blocks)) {
      hooks[event] = blocks;
      continue;
    }
    const keptBlocks = [];
    for (const block of blocks) {
      const blockHooks = Array.isArray(block?.hooks)
        ? block.hooks.filter(
            (hook) =>
              !isOwnedGlobalMetaKimHookCommand(hook?.command ?? ""),
          )
        : [];
      if (Array.isArray(block?.hooks)) {
        if (blockHooks.length > 0) {
          keptBlocks.push({ ...block, hooks: blockHooks });
        }
        continue;
      }
      if (
        !isOwnedGlobalMetaKimHookCommand(block?.command ?? "")
      ) {
        keptBlocks.push(block);
      }
    }
    if (keptBlocks.length > 0) {
      hooks[event] = keptBlocks;
    }
  }
  next.hooks = hooks;
  return next;
}

function mergeCodexGlobalHooksIntoConfig(config, template) {
  const next = stripGlobalMetaKimHooksFromCodexConfig(config);
  next.hooks ??= {};
  for (const [event, additionBlocks] of Object.entries(template.hooks ?? {})) {
    next.hooks[event] = mergeHookMatcherBlocks(
      Array.isArray(next.hooks[event]) ? next.hooks[event] : [],
      Array.isArray(additionBlocks) ? additionBlocks : [additionBlocks],
    );
  }
  return next;
}

async function readJsonConfig(configPath, label) {
  if (!(await pathExists(configPath))) {
    return {};
  }
  const raw = await fs.readFile(configPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${label}; fix or move aside before sync.`);
  }
}

async function syncCodexGlobalHooksJson() {
  const hooksJsonPath = codexGlobalHooksJsonPath();
  assertHomeBound(hooksJsonPath);
  await assertRealHomeBound(hooksJsonPath);
  const template = buildCodexGlobalHooksTemplate();
  const base = await readJsonConfig(hooksJsonPath, hooksJsonPath);
  const merged = mergeCodexGlobalHooksIntoConfig(base, template);
  const out = `${JSON.stringify(merged, null, 2)}\n`;
  const prev = (await pathExists(hooksJsonPath))
    ? await fs.readFile(hooksJsonPath, "utf8")
    : null;

  const managedCommands = flattenHookCommands(template.hooks);
  const recordHooksJsonMerge = () => {
    recordSafe((rec) =>
      rec.recordSettingsMerge(hooksJsonPath, managedCommands, {
        source: "sync-global-meta-theory",
        purpose: "codex-global-hooks-json-merge",
        category: CATEGORIES.C,
        managedHookFragments: flattenHookFragments(template.hooks),
      }),
    );
  };

  if (prev === out) {
    console.log(`Codex hooks.json already up to date: ${hooksJsonPath}`);
    recordHooksJsonMerge();
    return;
  }

  await fs.mkdir(path.dirname(hooksJsonPath), { recursive: true });
  if (prev !== null) {
    await backupExistingPath(hooksJsonPath, {
      family: "settings",
      label: "Codex hooks.json",
    });
  }

  await writeUtf8FileAtomic(hooksJsonPath, out, "codex-hooks");
  console.log(`Merged Meta_Kim hooks into ${hooksJsonPath}`);
  recordHooksJsonMerge();
}

async function readClaudeGlobalSettings(settingsPath) {
  if (!(await pathExists(settingsPath))) {
    return {};
  }
  const raw = await fs.readFile(settingsPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid JSON in ${settingsPath}; fix or move aside before sync.`,
    );
  }
}

function flattenHookCommands(hooks = {}) {
  const commands = [];
  for (const blocks of Object.values(hooks ?? {})) {
    for (const block of blocks ?? []) {
      for (const hook of block?.hooks ?? []) {
        if (hook?.command) {
          commands.push(hook.command);
        }
      }
    }
  }
  return commands;
}

function flattenHookFragments(hooks = {}) {
  const fragments = [];
  for (const [event, blocks] of Object.entries(hooks ?? {})) {
    for (const block of blocks ?? []) {
      for (const hook of block?.hooks ?? []) {
        if (hook && typeof hook === "object" && !Array.isArray(hook)) {
          fragments.push({
            event,
            matcher: block?.matcher ?? null,
            hook: structuredClone(hook),
          });
        }
      }
    }
  }
  return fragments;
}

function hookCommandScriptPath(command) {
  const trimmed = String(command ?? "").trim();
  const quoted = trimmed.match(/^node\s+"([^"]+)"/u);
  if (quoted) {
    return quoted[1];
  }
  const unquoted = trimmed.match(/^node\s+([^\s]+)/u);
  return unquoted?.[1] ?? null;
}

async function checkClaudeGlobalSettingsHooks() {
  const settingsPath = path.join(runtimeHomes.claude.dir, "settings.json");
  const absHooks = globalMetaKimHooksDir();
  const template = buildMetaKimHooksTemplate(absHooks, repoRoot, {
    hookPromptCommand: await claudeGlobalHookPromptCommand(),
  });
  const settings = await readClaudeGlobalSettings(settingsPath);
  const expected = mergeGlobalMetaKimHooksIntoSettings(settings, template, {
    isManagedHookCommand: isOwnedGlobalMetaKimHookCommand,
  });

  let inSync = isDeepStrictEqual(settings.hooks ?? {}, expected.hooks ?? {});
  const missingCommands = [];

  for (const command of flattenHookCommands(settings.hooks)) {
    if (!isGlobalMetaKimManagedHookCommand(command)) {
      continue;
    }
    const scriptPath = hookCommandScriptPath(command);
    if (!scriptPath || !(await pathExists(scriptPath))) {
      missingCommands.push(command);
    }
  }

  if (missingCommands.length > 0) {
    inSync = false;
  }

  console.log(
    `${inSync ? `${C.green}✓${C.reset}` : `${C.yellow}⊘${C.reset}`} ${C.dim}Claude Code global settings hooks: ${settingsPath}${C.reset}`,
  );
  if (!inSync && missingCommands.length > 0) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}Missing registered Meta_Kim hook scripts: ${missingCommands.length}${C.reset}`,
    );
  }
  return inSync;
}

async function checkCodexGlobalHooksJson() {
  const hooksJsonPath = codexGlobalHooksJsonPath();
  const template = buildCodexGlobalHooksTemplate();
  const config = await readJsonConfig(hooksJsonPath, hooksJsonPath);
  const expected = mergeCodexGlobalHooksIntoConfig(config, template);

  // Object insertion order is not semantic JSON state; array order is. Node's
  // deep strict comparison preserves that boundary without stringifying keys.
  let inSync = isDeepStrictEqual(config.hooks ?? {}, expected.hooks ?? {});
  const missingCommands = [];

  for (const command of flattenHookCommands(config.hooks)) {
    if (!isGlobalMetaKimManagedHookCommand(command)) {
      continue;
    }
    const scriptPath = hookCommandScriptPath(command);
    if (!scriptPath || !(await pathExists(scriptPath))) {
      missingCommands.push(command);
    }
  }

  if (missingCommands.length > 0) {
    inSync = false;
  }

  console.log(
    `${inSync ? `${C.green}✓${C.reset}` : `${C.yellow}⊘${C.reset}`} ${C.dim}Codex global hooks.json: ${hooksJsonPath}${C.reset}`,
  );
  if (!inSync && missingCommands.length > 0) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}Missing registered Meta_Kim Codex hook scripts: ${missingCommands.length}${C.reset}`,
    );
  }
  return inSync;
}

function isOwnedGlobalMetaKimHookCommand(command) {
  if (isGlobalMetaKimManagedHookCommand(command)) return true;
  const normalized = String(command ?? "").replace(/\\\\/g, "\\").replace(/\\/g, "/");
  return [...removedOwnedLegacyHookPaths].some((ownedPath) =>
    normalized.includes(ownedPath),
  );
}

async function runCheck() {
  await assertCanonicalSkillFrontmatter();
  let failed = false;
  const agentPlan = await buildGlobalAgentPlan();
  const skipClaudeDurableMcp = skipDurableMcp && selectedTargetIds.includes("claude");
  const mcpPlan = skipClaudeDurableMcp ? null : await buildClaudeUserMcpPlan();

  if (agentPlan.collisions.length > 0) failed = true;
  if (!(await checkGlobalAgents(agentPlan))) failed = true;
  if (mcpPlan) {
    let durableReady = false;
    try {
      await verifyDurableMcpLayout(mcpPlan.layout, mcpPlan.identity);
      durableReady = true;
    } catch {
      durableReady = false;
    }
    const mcpInSync = durableReady && mcpPlan.collisions.length === 0 &&
      isDeepStrictEqual(mcpPlan.base, mcpPlan.config);
    console.log(`${mcpInSync ? `${C.green}✓${C.reset}` : `${C.yellow}⊘${C.reset}`} ${C.dim}Claude user MCP: ${mcpPlan.configPath}${C.reset}`);
    if (!mcpInSync) failed = true;
  } else if (skipClaudeDurableMcp) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}Claude durable MCP runtime and user MCP config not checked; skipped because explicitly requested with --skip-durable-mcp.${C.reset}`,
    );
  }

  for (const target of activeTargets) {
    const sourceFingerprint = await fingerprintSourceForTarget(
      target.targetId,
    );
    const targetFingerprint = await fingerprintDir(target.dir);
    const inSync =
      targetFingerprint !== null &&
      sourceFingerprint !== null &&
      targetFingerprint.hash === sourceFingerprint.hash &&
      targetFingerprint.fileCount === sourceFingerprint.fileCount;
    console.log(
      `${inSync ? `${C.green}✓${C.reset}` : `${C.yellow}⊘${C.reset}`} ${C.dim}${target.label}: ${target.dir}${C.reset}`,
    );
    if (!inSync) {
      failed = true;
    }
  }

  for (const target of cleanupTargets) {
    const exists = await pathExists(target.dir);
    console.log(
      `${exists ? `${C.yellow}⊘${C.reset}` : `${C.green}✓${C.reset}`} ${C.dim}${target.label}: ${target.dir}${C.reset}`,
    );
    if (exists) {
      failed = true;
    }
  }

  for (const target of staleSkillCleanupTargets) {
    const exists = await pathExists(target.dir);
    const isStale = exists && (await isStaleMetaKimSkillAlias(target));
    console.log(
      `${isStale ? `${C.yellow}⊘${C.reset}` : `${C.green}✓${C.reset}`} ${C.dim}${target.label}: ${target.dir}${C.reset}`,
    );
    if (isStale) {
      failed = true;
    }
  }

  if (selectedTargetIds.includes("claude") && withGlobalHooks) {
    const repoHooksFp = await fingerprintGlobalHookSources("claude");
    const globalHooksPath = globalMetaKimHooksDir();
    const globalHooksFp = await fingerprintInstalledGlobalHooks(globalHooksPath);
    const hooksInSync =
      repoHooksFp !== null &&
      globalHooksFp !== null &&
      repoHooksFp.hash === globalHooksFp.hash &&
      repoHooksFp.fileCount === globalHooksFp.fileCount;
    console.log(
      `${hooksInSync ? `${C.green}✓${C.reset}` : `${C.yellow}⊘${C.reset}`} ${C.dim}Claude Code global hooks (meta-kim): ${globalHooksPath}${C.reset}`,
    );
    if (!hooksInSync) {
      failed = true;
    }
    const settingsHooksInSync = await checkClaudeGlobalSettingsHooks();
    if (!settingsHooksInSync) {
      failed = true;
    }
  } else if (selectedTargetIds.includes("claude")) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}Claude Code global hooks skipped (use --with-global-hooks to check them): ${globalMetaKimHooksDir()}${C.reset}`,
    );
  }

  if (selectedTargetIds.includes("codex") && withGlobalHooks) {
    const repoHooksFp = await fingerprintGlobalHookSources("codex");
    const codexHooksPath = codexGlobalMetaKimHooksDir();
    const codexHooksFp = await fingerprintInstalledGlobalHooks(codexHooksPath);
    const hooksInSync =
      repoHooksFp !== null &&
      codexHooksFp !== null &&
      repoHooksFp.hash === codexHooksFp.hash &&
      repoHooksFp.fileCount === codexHooksFp.fileCount;
    console.log(
      `${hooksInSync ? `${C.green}✓${C.reset}` : `${C.yellow}⊘${C.reset}`} ${C.dim}Codex global hooks (meta-kim): ${codexHooksPath}${C.reset}`,
    );
    if (!hooksInSync) {
      failed = true;
    }
    const hooksJsonInSync = await checkCodexGlobalHooksJson();
    if (!hooksJsonInSync) {
      failed = true;
    }
  } else if (selectedTargetIds.includes("codex")) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}Codex global hooks skipped (use --with-global-hooks to check them): ${codexGlobalMetaKimHooksDir()}${C.reset}`,
    );
  }

  if (selectedTargetIds.includes("claude")) {
    const commandResults = await checkRuntimeCommands("claude", claudeCommandsSourceDir);
    if (!commandResults.inSync) failed = true;
  }

  if (selectedTargetIds.includes("codex")) {
    const commandResults = await checkRuntimeCommands("codex", codexCommandsSourceDir);
    if (!commandResults.inSync) failed = true;

    const configPath = path.join(runtimeHomes.codex.dir, "config.toml");
    const configRaw = (await pathExists(configPath))
      ? await fs.readFile(configPath, "utf8")
      : "";
    let featureEnabled = false;
    try {
      assertCodexConfigTomlMergeable(configRaw);
      featureEnabled = hasCodexRequestUserInputFeature(configRaw);
    } catch (error) {
      console.log(
        `${C.red}×${C.reset} ${C.dim}Codex config.toml is invalid: ${configPath}${C.reset}`,
      );
      console.error(error.message);
      failed = true;
    }
    console.log(
      `${featureEnabled ? `${C.green}✓${C.reset}` : `${C.yellow}⊘${C.reset}`} ${C.dim}Codex ${CODEX_REQUEST_USER_INPUT_FEATURE}: ${configPath}${C.reset}`,
    );
    if (!featureEnabled) {
      failed = true;
    }
  }

  process.exitCode = failed ? 1 : 0;
}

async function restoreFileSnapshot(filePath, raw) {
  if (raw === null) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, raw, "utf8");
}

async function readFileSnapshot(filePath) {
  return fs.readFile(filePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function restoreCodexConfigTransaction(transaction) {
  if (!transaction?.changed) return;
  const current = await captureExactFileSnapshot(transaction.targetPath);
  if (!exactFileSnapshotMatches(current, transaction.promoted)) {
    throw new Error("rollback_incomplete: Codex config changed concurrently");
  }

  if (transaction.original.exists) {
    await promoteExactFileFromSnapshot(
      transaction.targetPath,
      transaction.promoted,
      transaction.original.bytes,
      { replacementMode: transaction.original.stat.mode },
    );
    return;
  }

  const quarantinePath = path.join(
    path.dirname(transaction.targetPath),
    `.meta-kim-rollback-${path.basename(transaction.targetPath)}-${process.pid}-${randomUUID()}`,
  );
  assertHomeBound(quarantinePath);
  await assertRealHomeBound(quarantinePath);
  await fs.rename(transaction.targetPath, quarantinePath);
  await fsyncDirectoryBestEffort(path.dirname(transaction.targetPath));
  const quarantined = await captureExactFileSnapshot(quarantinePath);
  if (!exactFileSnapshotMatches(quarantined, transaction.promoted, {
    requireIdentity: false,
  })) {
    if (!(await pathExists(transaction.targetPath))) {
      await fs.rename(quarantinePath, transaction.targetPath);
    }
    throw new Error("rollback_incomplete: Codex config changed during removal");
  }
  await fs.rm(quarantinePath, { force: true });
  await fsyncDirectoryBestEffort(path.dirname(transaction.targetPath));
}

function directoryClosureMatches(actual, expected) {
  return Boolean(
    actual &&
    expected &&
    actual.sha256 === expected.sha256 &&
    actual.entryCount === expected.entryCount,
  );
}

async function injectConcurrentDurableMcpEdit(mcpPlan) {
  const mode = process.env.META_KIM_TEST_CONCURRENT_DURABLE_MCP_EDIT;
  if (!mcpPlan || !["config", "bundle", "both"].includes(mode)) return;
  if (["config", "both"].includes(mode) && await pathExists(mcpPlan.configPath)) {
    const current = JSON.parse(await fs.readFile(mcpPlan.configPath, "utf8"));
    current.userConcurrentEdit = { preserve: true };
    await fs.writeFile(mcpPlan.configPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  }
  if (["bundle", "both"].includes(mode) && await pathExists(mcpPlan.layout.bundleDir)) {
    await fs.writeFile(
      path.join(mcpPlan.layout.bundleDir, "user-concurrent-runtime-file.txt"),
      "preserve concurrent bundle edit\n",
      "utf8",
    );
  }
}

async function rollbackGlobalSyncTransaction(
  mcpPlan,
  bundleTransaction,
  codexConfigTransaction,
  recorder = manifestRecorder,
) {
  const rollbackErrors = [];
  if (codexConfigTransaction?.changed) {
    const currentConfig = await captureExactFileSnapshot(
      codexConfigTransaction.targetPath,
    );
    if (!exactFileSnapshotMatches(currentConfig, codexConfigTransaction.promoted)) {
      rollbackErrors.push("rollback_incomplete: Codex config changed concurrently");
    }
  }
  if (mcpPlan?.configTransaction?.changed) {
    const currentConfig = await readFileSnapshot(mcpPlan.configPath);
    if (currentConfig !== mcpPlan.configTransaction.promotedRaw) {
      rollbackErrors.push("rollback_incomplete: Claude MCP config changed concurrently");
    }
  }
  if (bundleTransaction?.installed && mcpPlan?.layout) {
    const currentClosure = directoryClosureSync(mcpPlan.layout.bundleDir);
    if (!directoryClosureMatches(currentClosure, bundleTransaction.promotedClosure)) {
      rollbackErrors.push("rollback_incomplete: durable MCP bundle changed concurrently");
    }
  }
  // Treat bundle, registration, and ledger as one rollback unit. If any CAS
  // precondition fails, preserve every current artifact rather than creating a
  // mixed old/new runtime state or overwriting user edits.
  if (rollbackErrors.length > 0) {
    throw new Error(`Global sync rollback incomplete: ${rollbackErrors.join("; ")}`);
  }

  if (mcpPlan?.configTransaction?.changed) {
    try {
      await restoreFileSnapshot(mcpPlan.configPath, mcpPlan.configTransaction.raw);
    } catch (error) {
      rollbackErrors.push(`Claude MCP config: ${error?.message ?? error}`);
    }
  }
  if (bundleTransaction?.installed && mcpPlan?.layout) {
    try {
      await fs.rm(mcpPlan.layout.bundleDir, { recursive: true, force: true });
      if (bundleTransaction.displacedPath && await pathExists(bundleTransaction.displacedPath)) {
        await fs.mkdir(path.dirname(mcpPlan.layout.bundleDir), { recursive: true });
        await renameDirectoryWithRetry(bundleTransaction.displacedPath, mcpPlan.layout.bundleDir);
      }
    } catch (error) {
      rollbackErrors.push(`durable MCP bundle: ${error?.message ?? error}`);
    }
  }
  if (codexConfigTransaction?.changed) {
    try {
      await restoreCodexConfigTransaction(codexConfigTransaction);
    } catch (error) {
      rollbackErrors.push(`Codex config: ${error?.message ?? error}`);
    }
  }
  if (recorder) {
    const result = await recorder.rollback();
    if (!result.ok) {
      rollbackErrors.push(`install manifest: ${result.error ?? "rollback failed"}`);
    }
  }
  if (rollbackErrors.length > 0) {
    throw new Error(`Global sync rollback incomplete: ${rollbackErrors.join("; ")}`);
  }
}

function globalManifestPartialFailure(reasons) {
  return new Error(
    `Global sync is partial because install manifest persistence failed: ${reasons}. ` +
    "Resolve the manifest write failure, then rerun the same sync command; " +
    "non-MCP projections may already be updated and will be reconciled on rerun.",
  );
}

async function runSync() {
  let mcpPlan = null;
  let bundleTransaction = null;
  let codexConfigTransaction = null;
  try {
  // Leading newline to separate from parent's progress message
  console.log("");
  if (!(await pathExists(sourceSkillFile))) {
    throw new Error(`Missing canonical skill source: ${sourceSkillFile}`);
  }
  await assertCanonicalSkillFrontmatter();
  const agentPlan = await buildGlobalAgentPlan();
  const skipClaudeDurableMcp = skipDurableMcp && selectedTargetIds.includes("claude");
  mcpPlan = skipClaudeDurableMcp ? null : await buildClaudeUserMcpPlan();
  const collisions = [
    ...agentPlan.collisions.map((item) => item.targetPath),
    ...(mcpPlan?.collisions ?? []).map((name) => `${mcpPlan.configPath}#${name}`),
  ];
  if (collisions.length > 0) {
    throw new Error(`Refusing to overwrite unowned global runtime assets:\n${collisions.join("\n")}`);
  }
  const packageVersion = JSON.parse(
    await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
  ).version;
  manifestRecorder = openRecorder({
    scope: "global",
    metaKimVersion: packageVersion,
  });

  if (mcpPlan) {
    bundleTransaction = await materializeDurableMcpRuntime(mcpPlan);
  }

  for (const target of cleanupTargets) {
    const removed = await removeIfExists(target.dir);
    if (removed) {
      console.log(
        `${C.green}✓${C.reset} ${C.dim}Removed ${target.label}: ${target.dir}${C.reset}`,
      );
    }
  }

  for (const target of activeTargets) {
    await copyCanonicalSkill(target.dir, target.targetId);
    console.log(
      `${C.green}✓${C.reset} ${C.dim}Synced ${target.label}: ${target.dir}${C.reset}`,
    );
  }

  await syncGlobalAgents(agentPlan);
  await syncClaudeUserMcp(mcpPlan);
  if (skipClaudeDurableMcp) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}Claude durable MCP runtime and user MCP config skipped because explicitly requested with --skip-durable-mcp.${C.reset}`,
    );
  }

  for (const target of staleSkillCleanupTargets) {
    await backupAndRemoveStaleSkillAlias(target);
  }

  if (selectedTargetIds.includes("claude") && withGlobalHooks) {
    await copyCanonicalHooksToGlobal();
    console.log(
      `${C.green}✓${C.reset} ${C.dim}Synced Claude Code global hooks: ${globalMetaKimHooksDir()}${C.reset}`,
    );
    await syncClaudeGlobalSettingsHooks();
  } else {
    if (selectedTargetIds.includes("claude")) {
      console.log(
        `${C.yellow}⊘${C.reset} ${C.dim}Skipped Claude Code global hooks (opt in with --with-global-hooks).${C.reset}`,
      );
    }
  }

  if (selectedTargetIds.includes("codex") && withGlobalHooks) {
    await copyCanonicalHooksToCodexGlobal();
    await ensureCodexGlobalHookPromptAdapter();
    console.log(
      `${C.green}✓${C.reset} ${C.dim}Synced Codex global hooks: ${codexGlobalMetaKimHooksDir()}${C.reset}`,
    );
    await syncCodexGlobalHooksJson();
  } else if (selectedTargetIds.includes("codex")) {
    console.log(
      `${C.yellow}⊘${C.reset} ${C.dim}Skipped Codex global hooks (opt in with --with-global-hooks).${C.reset}`,
    );
  }

  if (selectedTargetIds.includes("claude")) {
    const commandPaths = await copyRuntimeCommands("claude", claudeCommandsSourceDir);
    console.log(
      `${C.green}✓${C.reset} ${C.dim}Synced Claude Code commands: ${path.join(runtimeHomes.claude.dir, "commands")} (${commandPaths.length} files)${C.reset}`,
    );
  }

  if (selectedTargetIds.includes("codex")) {
    const commandPaths = await copyRuntimeCommands("codex", codexCommandsSourceDir);
    console.log(
      `${C.green}✓${C.reset} ${C.dim}Synced Codex commands: ${path.join(runtimeHomes.codex.dir, "commands")} (${commandPaths.length} files)${C.reset}`,
    );
    const codexConfigResult = await ensureCodexGlobalConfigChoiceSurface();
    codexConfigTransaction = codexConfigResult.transaction;
  }

  if (manifestRecorder) {
    if (["manifest", "rollback"].includes(
      process.env.META_KIM_TEST_FAIL_CODEX_CONFIG_AT,
    )) {
      throw globalManifestPartialFailure("Injected Codex config manifest failure");
    }
    if (process.env.META_KIM_TEST_FAIL_DURABLE_MCP_AT === "manifest") {
      await injectConcurrentDurableMcpEdit(mcpPlan);
      throw globalManifestPartialFailure("Injected durable MCP manifest failure");
    }
    const result = await manifestRecorder.flush();
    if (!result.ok || manifestRecordFailures.length > 0) {
      const reasons = [...manifestRecordFailures, result.error].filter(Boolean).join("; ");
      throw globalManifestPartialFailure(reasons);
    }
    if (process.env.META_KIM_TEST_FAIL_DURABLE_MCP_AT === "late") {
      await injectConcurrentDurableMcpEdit(mcpPlan);
      throw globalManifestPartialFailure("Injected durable MCP late failure");
    }
    if (process.env.META_KIM_TEST_FAIL_CODEX_CONFIG_AT === "late") {
      throw globalManifestPartialFailure("Injected Codex config late failure");
    }
    console.log(
      `${C.green}✓${C.reset} ${C.dim}Install manifest: ${result.path} (${result.entries} entries)${C.reset}`,
    );
  }
  } catch (error) {
    try {
      if (
        codexConfigTransaction?.changed &&
        process.env.META_KIM_TEST_CONCURRENT_CODEX_CONFIG_EDIT === "rollback"
      ) {
        await injectConcurrentCodexConfigEdit(
          codexConfigTransaction.targetPath,
          "rollback",
        );
      }
      await rollbackGlobalSyncTransaction(
        mcpPlan,
        bundleTransaction,
        codexConfigTransaction,
        manifestRecorder,
      );
    } catch (rollbackError) {
      throw new Error(`${error?.message ?? error}; ${rollbackError.message}`);
    }
    throw error;
  }
}

function printTargets() {
  console.log("Resolved runtime homes:");
  console.log(
    `- Claude Code: ${runtimeHomes.claude.dir} (${runtimeHomes.claude.source})`,
  );
  console.log(
    `- OpenClaw: ${runtimeHomes.openclaw.dir} (${runtimeHomes.openclaw.source})`,
  );
  console.log(
    `- Codex: ${runtimeHomes.codex.dir} (${runtimeHomes.codex.source})`,
  );
  console.log(
    `- Cursor: ${runtimeHomes.cursor.dir} (${runtimeHomes.cursor.source})`,
  );
  console.log("");
  console.log("Resolved active targets:");
  for (const target of activeTargets) {
    console.log(`- ${target.label}: ${target.dir}`);
  }
  console.log("");
  console.log("Environment overrides:");
  console.log("- META_KIM_CLAUDE_HOME or CLAUDE_HOME");
  console.log("- META_KIM_OPENCLAW_HOME or OPENCLAW_HOME");
  console.log("- META_KIM_CODEX_HOME or CODEX_HOME");
  console.log("- META_KIM_CURSOR_HOME or CURSOR_HOME");
  console.log("");
  console.log("Runtime slash commands:");
  console.log(
    `- ${path.join(runtimeHomes.claude.dir, "commands")} (Claude Code)`,
  );
  console.log(
    `- ${path.join(runtimeHomes.codex.dir, "commands")} (Codex)`,
  );
  console.log(
    `- ${path.join(runtimeHomes.codex.dir, "config.toml")} ([features].${CODEX_REQUEST_USER_INPUT_FEATURE} = true)`,
  );
  console.log("");
  console.log("Runtime hooks (only with --with-global-hooks):");
  console.log(`- Codex scripts: ${codexGlobalMetaKimHooksDir()}`);
  console.log(`- Codex merged into: ${codexGlobalHooksJsonPath()}`);
  console.log(`- Scripts: ${globalMetaKimHooksDir()}`);
  console.log(
    `- Claude Code merged into: ${path.join(runtimeHomes.claude.dir, "settings.json")}`,
  );
}

async function main() {
  if (!cliOptions) return;
  if (cliOptions.help) {
    printHelp();
    return;
  }
  await resolveTargets();
  if (printTargetsOnly) {
    printTargets();
    return;
  }
  if (checkOnly) {
    await runCheck();
    return;
  }
  await runSync();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
