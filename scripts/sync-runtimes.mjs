import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import {
  buildMetaKimHooksTemplate,
  mergeGlobalMetaKimHooksIntoSettings,
  mergeRepoClaudeSettings,
  stripRepoMetaKimHooksFromSettings,
} from "./claude-settings-merge.mjs";
import {
  buildCodexHooksJson,
  buildCursorHooksJson,
  buildHookPromptAdapterSource,
  hookCommand,
  nodeHookCommand,
  runtimeHookSourceOwner,
  SHARED_RUNTIME_HOOK_FILES,
} from "./runtime-hook-mapping.mjs";
import { ensureCodexAppNativeControls } from "./codex-config-merge.mjs";
import { OPENCLAW_WORKSPACE_FILE_NAMES } from "./openclaw-workspace-projection.mjs";
import {
  canonicalAgentsDir,
  canonicalCapabilityIndexDir,
  canonicalRuntimeAssetsDir,
  canonicalSkillsDir,
  canonicalSkillPath,
  canonicalSkillReferencesDir,
  GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
  globalAgentProjectionFileName,
  globalProjectionIsOwnedBy,
  repoRoot,
  resolveTargetContext,
  parseScopeArg,
  assertHomeBound,
  resolveRuntimeProjection,
  resolveRuntimeAllowedRoots,
  resolveRuntimeHomeDir,
} from "./meta-kim-sync-config.mjs";
import { t } from "./meta-kim-i18n.mjs";
import {
  CATEGORIES,
  manifestFileEntryMatches,
  manifestPathFor,
  openRecorder,
  readManifest,
} from "./install-manifest.mjs";
import { validateSkillFrontmatter } from "./install-skill-sanitizer.mjs";
import {
  collectProtectedProjectCapabilityPaths,
  loadProjectCapabilityOwnershipPolicy,
  loadProtectedProjectCapabilityPaths,
} from "./project-capability-ownership.mjs";
import { inspectTrustedPath } from "./safe-managed-file-operations.mjs";

const cliArgs = process.argv.slice(2);
const checkOnly = process.argv.includes("--check");
const jsonMode = process.argv.includes("--json");
const reverseMode = process.argv.includes("--reverse");
const dryRun = process.argv.includes("--dry-run");
const forceWrite = process.argv.includes("--force");
const applyReverseWriteback = process.argv.includes("--apply");
const reverseApprovalArgIndex = cliArgs.indexOf("--approval");
const reverseApprovalPath = reverseApprovalArgIndex >= 0
  ? cliArgs[reverseApprovalArgIndex + 1]
  : null;
const reverseCandidateOutputArgIndex = cliArgs.indexOf("--candidate-output");
const reverseCandidateOutputPath = reverseCandidateOutputArgIndex >= 0
  ? cliArgs[reverseCandidateOutputArgIndex + 1]
  : null;
const PROJECT_RUNTIME_SKILL_IDS = new Set(["meta-theory"]);

function sha256Binding(value) {
  return `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
}

function canonicalTargetRef(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/gu, "/");
}

export function buildReverseSyncMutationCandidate(signal) {
  const targetRef = canonicalTargetRef(signal.canonicalPath);
  const operation = signal.type === "new" ? "create" : "replace";
  const expectedSourceDigest = sha256Binding(
    signal.canonicalContent ?? "__META_KIM_MISSING_CANONICAL_SOURCE__",
  );
  const candidateDigest = sha256Binding(signal.runtimeContent);
  const rollbackPlanDigest = sha256Binding(JSON.stringify({
    operation: "restore_exact_prior_bytes",
    targetRef,
    expectedSourceDigest,
  }));
  const transitionId = sha256Binding(JSON.stringify({
    targetRef,
    operation,
    candidateDigest,
    expectedSourceDigest,
  }));
  return {
    targetRef,
    operation,
    transitionId,
    candidateDigest,
    expectedSourceDigest,
    rollbackPlanDigest,
  };
}

export function buildReverseSyncCandidateArtifact(mutationCandidates) {
  return {
    schemaVersion: "reverse-sync-candidate-v1",
    scope: "canonical_reverse_sync",
    mutationCandidates: mutationCandidates.map((candidate) => ({ ...candidate })),
    approvalPacketTemplate: {
      schemaVersion: "warden-approval-v0.2",
      approvalId: "replace-with-review-id",
      approver: "meta-warden",
      approvedAt: "replace-with-canonical-ISO-timestamp",
      scope: "canonical_reverse_sync",
      mutationBindings: mutationCandidates.map((candidate) => ({ ...candidate })),
      diffSummary: "replace-with-reviewed-diff-summary",
      rollbackPlan: { strategy: "restore_exact_prior_bytes" },
      riskReview: { status: "replace-with-review-result", owner: "meta-sentinel" },
    },
  };
}

async function readReverseSyncCanonicalContent(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "__META_KIM_MISSING_CANONICAL_SOURCE__";
    throw error;
  }
}

async function writeReverseSyncBytesAtomically(filePath, content) {
  const tempPath = `${filePath}.meta-kim-restore-${process.pid}-${Date.now()}.tmp`;
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function rollbackReverseSyncPriorStates(priorStates, { faultInjector = null } = {}) {
  const rollbackErrors = [];
  for (const prior of [...priorStates].reverse()) {
    try {
      await faultInjector?.(prior);
      if (prior.priorContent === null) {
        await fs.rm(prior.path, { force: true });
      } else {
        await writeReverseSyncBytesAtomically(prior.path, prior.priorContent);
      }
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0) {
    throw new AggregateError(rollbackErrors, "Reverse sync rollback could not restore every prior state");
  }
}

export async function assertReverseSyncSourcePrestate(signal, candidate) {
  const content = await readReverseSyncCanonicalContent(signal.canonicalPath);
  if (sha256Binding(content) !== candidate.expectedSourceDigest) {
    throw new Error(`Canonical source changed after approval candidate creation: ${candidate.targetRef}`);
  }
  return content === "__META_KIM_MISSING_CANONICAL_SOURCE__" ? null : content;
}

export function parseGlobalAssetTypesArg(
  argv,
  profiles,
  targetIds = Object.keys(profiles ?? {}),
) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--global-assets") {
      if (!argv[index + 1]) {
        throw new Error("--global-assets requires a comma-separated value");
      }
      values.push(argv[index + 1]);
      index += 1;
    } else if (current.startsWith("--global-assets=")) {
      values.push(current.slice("--global-assets=".length));
    }
  }
  if (values.length === 0) return null;
  const known = new Set(
    targetIds.flatMap((targetId) => profiles[targetId]?.projection?.assetTypes ?? []),
  );
  const requested = [
    ...new Set(
      values
        .join(",")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (requested.length === 0) {
    throw new Error("--global-assets must select at least one asset type");
  }
  for (const assetType of requested) {
    if (!known.has(assetType)) {
      throw new Error(
        `Unknown global asset type ${assetType}; expected one of ${[...known].sort().join(", ")}`,
      );
    }
  }
  return new Set(requested);
}

// Captures "will be written" entries whenever writeGeneratedFile runs under
// --check. Populated even when not in --json mode so callers get deterministic
// planning data; consumers just ignore it when they do not need it.
const staleFiles = [];
let canonicalAgentsForGlobalOnly = [];

function assertSafeRepoProjectionPath(filePath, { allowMissing = true } = {}) {
  if (!isRepoLocalPath(filePath)) return;
  const relPath = path.relative(repoRoot, filePath).replace(/\\/gu, "/");
  if (!inspectTrustedPath(repoRoot, relPath, { allowMissing })) {
    throw new Error(`Refusing to follow a project symlink or Junction: ${relPath}`);
  }
}

const SOURCE_REPO_PROJECT_PROJECTION_MARKERS = [
  ".claude/agents",
  ".claude/capability-index",
  ".claude/commands",
  ".claude/hooks",
  ".claude/settings.json",
  ".claude/skills",
  ".mcp.json",
  ".agents/skills",
  ".codex/agents",
  ".codex/capability-index",
  ".codex/commands",
  ".codex/config.toml",
  ".codex/hooks",
  ".codex/hooks.json",
  ".codex/skills",
  ".cursor/agents",
  ".cursor/capability-index",
  ".cursor/hooks",
  ".cursor/hooks.json",
  ".cursor/mcp.json",
  ".cursor/rules",
  ".cursor/skills",
  "codex/config.toml.example",
  "openclaw/capability-index",
  "openclaw/hooks",
  "openclaw/openclaw.template.json",
  "openclaw/skills",
  "openclaw/workspaces",
];

function normalizeRepoRelativePath(filePath) {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(repoRoot, filePath);
  const rel = path.relative(repoRoot, absolutePath).replace(/\\/g, "/");
  if (rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) {
    return null;
  }
  return rel;
}

function isSourceRepoProjectProjectionPath(filePath) {
  const rel = normalizeRepoRelativePath(filePath);
  if (!rel) return false;
  return SOURCE_REPO_PROJECT_PROJECTION_MARKERS.some(
    (marker) => rel === marker || rel.startsWith(`${marker}/`),
  );
}

async function existsAtRepoPath(relativePath) {
  try {
    await fs.access(path.join(repoRoot, relativePath));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function hasMaterialFileUnder(dirPath) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }

  for (const entry of entries) {
    const childPath = path.join(dirPath, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && (await hasMaterialFileUnder(childPath))) {
      return true;
    }
  }
  return false;
}

async function hasMaterialProjectionAtRepoPath(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (stat.isFile()) return true;
  if (stat.isDirectory()) return hasMaterialFileUnder(absolutePath);
  return false;
}

async function isMetaKimSourceRepo() {
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
    );
    return (
      pkg.name === "meta-kim" &&
      (await existsAtRepoPath("canonical")) &&
      (await existsAtRepoPath("config/sync.json"))
    );
  } catch {
    return false;
  }
}

async function hasMaterialProjectProjection() {
  for (const marker of SOURCE_REPO_PROJECT_PROJECTION_MARKERS) {
    if (await hasMaterialProjectionAtRepoPath(marker)) {
      return true;
    }
  }
  return false;
}

async function expectedSourceRepoProjectProjectionAbsence(scope, staleRecords) {
  if (scope !== "project" || staleRecords.length === 0) return false;
  if (!(await isMetaKimSourceRepo())) return false;
  if (await hasMaterialProjectProjection()) return false;
  return staleRecords.every(
    (record) =>
      record.action === "create" &&
      isSourceRepoProjectProjectionPath(record.path),
  );
}

// Recorder is lazily opened in main() when scope includes "project" so every
// write point (writeGeneratedFile / writeGeneratedJson) can record through
// this shared holder without plumbing a recorder arg through every build fn.
// Recorder failures are surfaced by flush() so sync cannot claim success with
// incomplete ownership metadata.
let manifestRecorder = null;
let projectManifestAtStart = null;
let runtimeSedimentedProjectPaths = new Set();
let manifestScope = null;
let syncScopeForWritePlan = null;
let globalProjectionRecordDescriptors = [];
let runtimeProfilesForSync = {};
let requestedGlobalAssetTypes = null;
function recordSafe(fn) {
  if (!manifestRecorder) return;
  fn(manifestRecorder);
}

function protectedProjectPathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function collectRuntimeSedimentedProjectPaths(
  manifest,
  rootDir = repoRoot,
  configRoot = repoRoot,
) {
  const policy = loadProjectCapabilityOwnershipPolicy(configRoot);
  const protectedPaths = collectProtectedProjectCapabilityPaths(manifest, rootDir, policy);
  // Preserve the historical Set API while carrying Skill-directory roots for
  // descendant write/delete protection.
  protectedPaths.absolutePaths.absoluteRoots = protectedPaths.absoluteRoots;
  return protectedPaths.absolutePaths;
}

async function loadRuntimeSedimentedProjectPaths(rootDir = repoRoot) {
  try {
    const protectedPaths = loadProtectedProjectCapabilityPaths(rootDir, repoRoot);
    protectedPaths.absolutePaths.absoluteRoots = protectedPaths.absoluteRoots;
    return protectedPaths.absolutePaths;
  } catch (error) {
    throw new Error(`Cannot safely read project capability ownership: ${error.message}`);
  }
}

export function isRuntimeSedimentedProjectPath(
  filePath,
  protectedPaths = runtimeSedimentedProjectPaths,
) {
  const key = protectedProjectPathKey(filePath);
  if (protectedPaths.has(key)) return true;
  for (const root of protectedPaths.absoluteRoots ?? []) {
    const rel = path.relative(root, path.resolve(filePath));
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
  }
  return false;
}

function forgetRecordedPath(filePath) {
  if (!manifestRecorder) return;
  manifestRecorder.forget(filePath);
}

function exactSyncOwnershipEntry(filePath, installManifest = projectManifestAtStart) {
  const normalized = protectedProjectPathKey(filePath);
  return (installManifest?.entries ?? []).find(
    (entry) =>
      entry.source === "sync-runtimes" &&
      entry.kind === "file" &&
      protectedProjectPathKey(entry.path) === normalized,
  ) ?? null;
}

export function inspectProjectProjectionOwnership(
  filePath,
  installManifest = projectManifestAtStart,
  protectedPaths = runtimeSedimentedProjectPaths,
) {
  if (isRuntimeSedimentedProjectPath(filePath, protectedPaths)) {
    return { preserve: true, reason: "runtime_sedimented_project_copy", entry: null };
  }
  const entry = exactSyncOwnershipEntry(filePath, installManifest);
  return entry
    ? { preserve: false, reason: "install_projection", entry }
    : { preserve: true, reason: "not_manifest_owned", entry: null };
}

/**
 * Map a sync write target to a project manifest category (D..H / G).
 * Returns null when the path is outside the repo or not one of the known
 * projection roots — those writes stay unrecorded rather than polluting
 * the manifest with ambiguous entries.
 *
 * Category semantics (see install-manifest.mjs CATEGORY_LABELS):
 *   D = Project runtime skills   (.claude/skills, .agents/skills, ...)
 *   E = Project runtime hooks    (.claude/hooks, .codex/hooks, .cursor/hooks, openclaw/hooks)
 *   F = Project runtime agents   (.claude/agents, .codex/agents, .cursor/agents)
 *   G = Project settings + MCP   (.claude/settings.json, .claude/commands, .mcp.json, .codex/*.toml)
 */
export function inferProjectCategory(filePath, rootDir = repoRoot) {
  if (typeof filePath !== "string" || !filePath) return null;
  const rel = path.relative(rootDir, filePath).replace(/\\/g, "/");
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  if (rel === ".claude/settings.json" || rel === ".mcp.json") {
    return CATEGORIES.G;
  }
  if (
    rel.startsWith(".claude/capability-index/") ||
    rel.startsWith(".codex/capability-index/") ||
    rel.startsWith(".cursor/capability-index/") ||
    rel.startsWith("openclaw/capability-index/")
  ) {
    return CATEGORIES.G;
  }
  if (
    rel.startsWith(".claude/hooks/") ||
    rel.startsWith(".codex/hooks/") ||
    rel.startsWith(".cursor/hooks/") ||
    rel.startsWith("openclaw/hooks/")
  ) {
    return CATEGORIES.E;
  }
  if (
    rel.startsWith(".claude/agents/") ||
    rel.startsWith(".codex/agents/") ||
    rel.startsWith(".cursor/agents/")
  ) {
    return CATEGORIES.F;
  }
  if (
    rel.startsWith(".claude/skills/") ||
    rel.startsWith(".agents/skills/") ||
    rel.startsWith(".cursor/skills/") ||
    rel.startsWith("openclaw/skills/") ||
    rel.startsWith("openclaw/workspaces/")
  ) {
    return CATEGORIES.D;
  }
  if (
    rel.startsWith(".claude/commands/") ||
    rel.startsWith(".codex/commands/") ||
    rel === ".codex/hooks.json" ||
    rel === ".cursor/hooks.json" ||
    rel.startsWith(".cursor/rules/")
  ) {
    return CATEGORIES.G;
  }
  if (
    rel === "openclaw/openclaw.template.json" ||
    (rel.startsWith(".codex/") && !rel.startsWith(".codex/skills/"))
  ) {
    return CATEGORIES.G;
  }
  return null;
}

export function inferProjectPurpose(category) {
  switch (category) {
    case CATEGORIES.D:
      return "project-skill";
    case CATEGORIES.E:
      return "project-hook";
    case CATEGORIES.F:
      return "project-agent";
    case CATEGORIES.G:
      return "project-settings";
    default:
      return null;
  }
}

export function inferProjectRuntimeTarget(filePath, rootDir = repoRoot) {
  if (typeof filePath !== "string" || !filePath) return null;
  const rel = path.relative(rootDir, filePath).replace(/\\/g, "/");
  if (rel.startsWith(".claude/") || rel === ".mcp.json") return "claude";
  if (rel.startsWith(".codex/") || rel.startsWith(".agents/") || rel.startsWith("codex/")) return "codex";
  if (rel.startsWith(".cursor/")) return "cursor";
  if (rel.startsWith("openclaw/")) return "openclaw";
  return null;
}

function isPathAtOrWithin(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function globalProjectionAssetType(assetKey) {
  const normalized = assetKey.toLowerCase();
  if (normalized.includes("capabilityindex")) return "capabilityIndex";
  if (normalized.includes("workspace")) return "workspaces";
  if (normalized.includes("agent")) return "agents";
  if (normalized.includes("skill")) return "skills";
  if (normalized.includes("hook")) return "hooks";
  if (normalized.includes("command")) return "commands";
  if (normalized.includes("rule")) return "rules";
  if (normalized.includes("mcp")) return "mcp";
  if (
    normalized.includes("config") ||
    normalized.includes("settings") ||
    normalized.includes("template")
  ) {
    return "config";
  }
  return null;
}

function globalProjectionCategory(assetType) {
  if (assetType === "hooks") return CATEGORIES.B;
  if (["config", "mcp"].includes(assetType)) {
    return CATEGORIES.C;
  }
  return CATEGORIES.A;
}

function buildGlobalProjectionRecordDescriptors(targetIds) {
  const descriptors = [];
  for (const targetId of targetIds) {
    const profile = runtimeProfilesForSync[targetId];
    if (!profile) {
      throw new Error(`Missing runtime profile for global write plan: ${targetId}`);
    }
    const projection = resolveRuntimeProjection(targetId, "global");
    for (const [assetKey, assetPath] of Object.entries(projection)) {
      if (
        ["runtimeId", "scope", "baseDir", "display"].includes(assetKey) ||
        typeof assetPath !== "string"
      ) {
        continue;
      }
      const assetType = globalProjectionAssetType(assetKey);
      if (!assetType || !profile.projection.assetTypes.includes(assetType)) {
        continue;
      }
      descriptors.push({
        targetId,
        assetKey,
        assetType,
        rootPath: assetPath,
        category: globalProjectionCategory(assetType),
        owner: profile.projection.globalAssetOwners[assetType],
      });
    }
  }
  return descriptors.sort((left, right) =>
    right.rootPath.length - left.rootPath.length
  );
}

function inferGlobalProjectionRecord(filePath) {
  const descriptor = globalProjectionRecordDescriptors.find(({ rootPath }) =>
    isPathAtOrWithin(rootPath, filePath)
  );
  if (!descriptor) return null;
  return {
    category: descriptor.category,
    purpose: `${descriptor.targetId}-global-${descriptor.assetKey}`,
    runtimeTarget: descriptor.targetId,
    assetType: descriptor.assetType,
    owner: descriptor.owner,
  };
}

function runtimeHasSyncOwnedGlobalAssets(targetId, ignoredAssetTypes = []) {
  const profile = runtimeProfilesForSync[targetId];
  if (!profile) return false;
  const ignored = new Set(ignoredAssetTypes);
  return profile.projection.assetTypes.some(
    (assetType) =>
      !ignored.has(assetType) &&
      (
        requestedGlobalAssetTypes === null ||
        requestedGlobalAssetTypes.has(assetType)
      ) &&
      globalProjectionIsOwnedBy(
        profile,
        assetType,
        GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
      ),
  );
}

function shouldSyncRuntimeAsset(targetId, assetType, scope) {
  if (scope !== "global") return true;
  const profile = runtimeProfilesForSync[targetId];
  return Boolean(
    profile &&
    profile.projection.assetTypes.includes(assetType) &&
    (
      requestedGlobalAssetTypes === null ||
      requestedGlobalAssetTypes.has(assetType)
    ) &&
    globalProjectionIsOwnedBy(
      profile,
      assetType,
      GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
    )
  );
}

function shouldRunRuntimeProjectionBranch(targetId, scope) {
  return (
    scope !== "global" ||
    runtimeHasSyncOwnedGlobalAssets(targetId, ["capabilityIndex"])
  );
}

/**
 * Safely read a canonical source file. Returns null if the file is missing
 * (e.g. when running via npx with a stale or incomplete cached package).
 */
async function tryReadCanonical(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    console.warn(t.canonicalMissingWarn(filePath));
    return null;
  }
}

async function canonicalGlobalHookSource(fileName, runtimeId) {
  const sharedHooksDir = path.join(canonicalRuntimeAssetsDir, "shared", "hooks");
  const claudeHooksDir = path.join(canonicalRuntimeAssetsDir, "claude", "hooks");
  const owner = runtimeHookSourceOwner(runtimeId, fileName);
  if (!owner) return null;
  const sourcePath = path.join(
    owner === "shared" ? sharedHooksDir : claudeHooksDir,
    fileName,
  );
  try {
    await fs.access(sourcePath);
    return sourcePath;
  } catch {
    return null;
  }
}

async function syncGlobalHookPackage(targetDir, displayDir, changedFiles, runtimeId) {
  for (const fileName of GLOBAL_META_KIM_HOOK_PACKAGE_FILES) {
    const sourcePath = await canonicalGlobalHookSource(fileName, runtimeId);
    if (!sourcePath) {
      throw new Error(
        `Missing canonical Hook source for ${runtimeId}:${fileName}`,
      );
    }
    const content = await fs.readFile(sourcePath, "utf8");
    if (
      (
        await writeGeneratedFile(
          path.join(targetDir, fileName),
          content,
        )
      ).changed
    ) {
      changedFiles.push(`${displayDir}/${fileName}`);
    }
  }
}

// ── Scope-aware projection directories ───────────────────────────────

/**
 * Resolve projection base dir for a runtime.
 * project → repoRoot, global → runtime home dir
 */
function getProjectionBase(scope, runtimeId) {
  return resolveRuntimeProjection(runtimeId, scope).baseDir;
}

// ── Reverse sync: Runtime -> Canonical signal collection ────────────────

/**
 * Compare two file contents and return diff information.
 */
function compareFileContents(canonicalContent, runtimeContent) {
  if (canonicalContent === runtimeContent) {
    return { hasChanges: false };
  }
  const canonicalLines = canonicalContent.split("\n");
  const runtimeLines = runtimeContent.split("\n");
  return {
    hasChanges: true,
    canonicalLines: canonicalLines.length,
    runtimeLines: runtimeLines.length,
  };
}

/**
 * Detect local modifications in runtime agent files.
 * Returns evolution signals: changes that should propagate to canonical.
 */
async function detectRuntimeAgentChanges(runtimeAgentsDir, displayPath) {
  const signals = [];
  try {
    const files = await fs.readdir(runtimeAgentsDir);
    const agentFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".toml"));

    for (const file of agentFiles) {
      const runtimePath = path.join(runtimeAgentsDir, file);
      const runtimeContent = await fs.readFile(runtimePath, "utf8");

      // Map runtime file back to canonical source
      const canonicalPath = mapRuntimeToCanonicalAgent(runtimePath, file);
      if (!canonicalPath) continue;

      let canonicalContent = null;
      try {
        canonicalContent = await fs.readFile(canonicalPath, "utf8");
      } catch {
        // Canonical file missing - this is a new candidate
        signals.push({
          type: "new",
          runtimePath,
          canonicalPath,
          displayPath: `${displayPath}/${file}`,
          runtimeContent,
        });
        continue;
      }

      const diff = compareFileContents(canonicalContent, runtimeContent);
      if (diff.hasChanges) {
        signals.push({
          type: "modified",
          runtimePath,
          canonicalPath,
          displayPath: `${displayPath}/${file}`,
          canonicalContent,
          runtimeContent,
          diff,
        });
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Warning: Could not read ${runtimeAgentsDir}: ${error.message}`);
    }
  }
  return signals;
}

/**
 * Detect local modifications in runtime skill files.
 */
async function detectRuntimeSkillChanges(runtimeSkillRoot, displayPath) {
  const signals = [];
  try {
    const skillPath = path.join(runtimeSkillRoot, "SKILL.md");
    const canonicalSkill = canonicalSkillPath;

    let runtimeContent = null;
    try {
      runtimeContent = await fs.readFile(skillPath, "utf8");
    } catch {
      return signals;
    }

    let canonicalContent = null;
    try {
      canonicalContent = await fs.readFile(canonicalSkill, "utf8");
    } catch {
      signals.push({
        type: "new",
        runtimePath: skillPath,
        canonicalPath: canonicalSkill,
        displayPath: `${displayPath}/SKILL.md`,
        runtimeContent,
      });
      return signals;
    }

    const diff = compareFileContents(canonicalContent, runtimeContent);
    if (diff.hasChanges) {
      signals.push({
        type: "modified",
        runtimePath: skillPath,
        canonicalPath: canonicalSkill,
        displayPath: `${displayPath}/SKILL.md`,
        canonicalContent,
        runtimeContent,
        diff,
      });
    }

    // Check references
    const refsPath = path.join(runtimeSkillRoot, "references");
    try {
      const refFiles = await fs.readdir(refsPath);
      for (const refFile of refFiles) {
        const runtimeRefPath = path.join(refsPath, refFile);
        const canonicalRefPath = path.join(canonicalSkillReferencesDir, refFile);

        const runtimeRefContent = await fs.readFile(runtimeRefPath, "utf8");
        let canonicalRefContent = null;
        try {
          canonicalRefContent = await fs.readFile(canonicalRefPath, "utf8");
        } catch {
          signals.push({
            type: "new",
            runtimePath: runtimeRefPath,
            canonicalPath: canonicalRefPath,
            displayPath: `${displayPath}/references/${refFile}`,
            runtimeContent: runtimeRefContent,
          });
          continue;
        }

        const refDiff = compareFileContents(canonicalRefContent, runtimeRefContent);
        if (refDiff.hasChanges) {
          signals.push({
            type: "modified",
            runtimePath: runtimeRefPath,
            canonicalPath: canonicalRefPath,
            displayPath: `${displayPath}/references/${refFile}`,
            canonicalContent: canonicalRefContent,
            runtimeContent: runtimeRefContent,
            diff: refDiff,
          });
        }
      }
    } catch {
      // References directory might not exist
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Warning: Could not read ${runtimeSkillRoot}: ${error.message}`);
    }
  }
  return signals;
}

/**
 * Map runtime agent file path to canonical source path.
 */
function mapRuntimeToCanonicalAgent(runtimePath, fileName) {
  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext);

  // Claude Code: .claude/agents/{id}.md -> canonical/agents/{id}.md
  if (runtimePath.includes(".claude/agents/") || runtimePath.includes("\\.claude\\agents\\")) {
    return path.join(canonicalAgentsDir, `${baseName}.md`);
  }
  // Codex: .codex/agents/{id}.toml -> canonical/agents/{id}.md
  if (runtimePath.includes(".codex/agents/") || runtimePath.includes("\\.codex\\agents\\")) {
    return path.join(canonicalAgentsDir, `${baseName}.md`);
  }
  // Cursor: .cursor/agents/{id}.md -> canonical/agents/{id}.md
  if (runtimePath.includes(".cursor/agents/") || runtimePath.includes("\\.cursor\\agents\\")) {
    return path.join(canonicalAgentsDir, `${baseName}.md`);
  }
  // OpenClaw: openclaw/workspaces/{id}/SOUL.md -> canonical/agents/{id}.md
  if (runtimePath.includes("workspaces") && (runtimePath.endsWith("SOUL.md") || runtimePath.endsWith("BOOTSTRAP.md"))) {
    const workspaceMatch = runtimePath.match(/workspaces[\/\\]([^\/\\]+)/);
    if (workspaceMatch) {
      return path.join(canonicalAgentsDir, `${workspaceMatch[1]}.md`);
    }
  }

  return null;
}

/**
 * Validate that proposed canonical changes comply with Five Criteria.
 * Basic validation: frontmatter, structure, essential fields.
 */
function validateProposedChange(content, filePath) {
  const errors = [];

  if (filePath.endsWith(".md")) {
    // Check for YAML frontmatter (skip if already has skill frontmatter with different format)
    if (!content.startsWith("---")) {
      errors.push("Missing YAML frontmatter");
    }

    // Check for essential frontmatter fields
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      if (!frontmatter.includes("name:") && !frontmatter.includes("title:") && !frontmatter.includes("description:")) {
        errors.push("Missing name, title, or description in frontmatter");
      }
    }

    // Check agent files have required sections (only for actual agent files)
    const lowerContent = content.toLowerCase();
    const lowerPath = filePath.toLowerCase();

    // Only check agent files (in canonical/agents/ or with agents in path)
    const isAgentFile = lowerPath.includes("canonical/agents") ||
                        lowerPath.includes(".claude/agents") ||
                        lowerPath.includes(".codex/agents") ||
                        lowerPath.includes(".cursor/agents") ||
                        lowerPath.includes("/agents/");

    if (isAgentFile) {
      if (!lowerContent.includes("## boundary") &&
          !lowerContent.includes("## responsibilities") &&
          !lowerContent.includes("## role") &&
          !lowerContent.includes("## ownership")) {
        errors.push("Missing boundary, responsibilities, role, or ownership section");
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Check for conflicts between canonical and runtime versions.
 * Returns true if there's a conflict that requires user attention.
 */
function detectConflict(signal) {
  if (signal.type === "new") {
    return false;
  }

  // Heuristic: if canonical has significantly more content, it may have
  // received updates not yet synced to this runtime
  const { canonicalLines, runtimeLines } = signal.diff;
  const lineDiff = Math.abs(canonicalLines - runtimeLines);
  const threshold = Math.max(20, Math.floor(canonicalLines * 0.1));

  // If canonical is 10% or 20+ lines different, flag as potential conflict
  return lineDiff > threshold && canonicalLines > runtimeLines;
}

/**
 * Execute reverse sync: collect evolution signals and write back to canonical.
 */
async function executeReverseSync(dirs, selectedTargets) {
  console.log("");
  console.log("── meta:sync (reverse mode: runtime -> canonical) ──");
  console.log(t.reverseModeIntro);
  console.log("");

  const allSignals = [];

  // Collect signals from each runtime
  for (const runtimeId of selectedTargets) {
    const projection = resolveRuntimeProjection(runtimeId, "project");

    // Check agents
    if (projection.agentsDir) {
      const agentSignals = await detectRuntimeAgentChanges(
        projection.agentsDir,
        projection.display.agentsDir || `${runtimeId}/agents`,
      );
      allSignals.push(...agentSignals.map((s) => ({ ...s, runtimeId })));
    }

    // Check skills
    if (projection.skillRoot) {
      const skillSignals = await detectRuntimeSkillChanges(
        projection.skillRoot,
        projection.display.skillRoot || `${runtimeId}/skills`,
      );
      allSignals.push(...skillSignals.map((s) => ({ ...s, runtimeId })));
    }
  }

  if (allSignals.length === 0) {
    console.log(t.reverseModeNoSignals);
    return { signals: [], applied: false, canonicalWrites: 0 };
  }

  console.log(t.reverseModeSignalsFound(allSignals.length));
  console.log("");

  // Categorize signals
  const conflicts = [];
  const safeWrites = [];

  for (const signal of allSignals) {
    const validation = validateProposedChange(signal.runtimeContent, signal.canonicalPath);

    if (!validation.valid) {
      console.warn(t.reverseModeValidationFailed(signal.displayPath));
      for (const error of validation.errors) {
        console.warn(`  - ${error}`);
      }
      continue;
    }

    if (detectConflict(signal)) {
      conflicts.push(signal);
    } else {
      safeWrites.push(signal);
    }
  }

  // Handle conflicts
  if (conflicts.length > 0) {
    console.warn("");
    console.warn(t.reverseModeConflictsDetected(conflicts.length));
    for (const conflict of conflicts) {
      console.warn(`  - ${conflict.displayPath}`);
      console.warn(`    ${t.reverseModeConflictHint}`);
    }

    if (!forceWrite && !dryRun) {
      console.warn("");
      console.warn(t.reverseModeConflictPrompt);
      // In non-interactive context, abort on conflict
      console.error(t.reverseModeAborted);
      process.exitCode = 1;
      return { signals: allSignals, applied: false, canonicalWrites: 0 };
    }

    if (forceWrite) {
      console.warn("");
      console.warn(t.reverseModeForceProceed);
    }
  }

  // Show summary of safe writes
  if (safeWrites.length > 0) {
    console.log("");
    console.log(t.reverseModeSafeWrites(safeWrites.length));
    for (const signal of safeWrites) {
      const icon = signal.type === "new" ? "+" : "~";
      console.log(`  ${icon} ${signal.displayPath}`);
    }
  }

  // `--force` controls only already-approved conflict handling. It never
  // creates, widens, or substitutes for Warden approval.
  const toWrite = forceWrite ? [...safeWrites, ...conflicts] : safeWrites;
  const mutationCandidates = toWrite.map(buildReverseSyncMutationCandidate);
  const candidateArtifact = buildReverseSyncCandidateArtifact(mutationCandidates);
  if (reverseCandidateOutputPath) {
    const outputPath = path.resolve(reverseCandidateOutputPath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(candidateArtifact, null, 2)}\n`, "utf8");
    console.log(`[ReverseSyncCandidate] ${outputPath}`);
  }
  if (jsonMode) {
    console.log(`[ReverseSyncCandidateJSON] ${JSON.stringify(candidateArtifact)}`);
  }
  const approvalPacket = reverseApprovalPath
    ? JSON.parse(await fs.readFile(path.resolve(reverseApprovalPath), "utf8"))
    : null;

  const { processEvolutionPacket } = await import("./evolution-writeback-gate.mjs");
  const evolutionPacket = {
    writebackDecision: "writeback",
    decisionReason: "Runtime projection changes are lifecycle candidates until Warden approval is exact-bound",
    writebacks: toWrite.map((signal) => signal.canonicalPath),
    mutationCandidates,
    retain: [],
    upgrade: [],
    retire: [],
    scarIds: [],
    syncRequired: true,
    signalSummary: {
      totalSignals: toWrite.length,
      byType: toWrite.reduce((acc, signal) => {
        acc[signal.type] = (acc[signal.type] || 0) + 1;
        return acc;
      }, {}),
      bySeverity: toWrite.reduce((acc, signal) => {
        acc[signal.severity] = (acc[signal.severity] || 0) + 1;
        return acc;
      }, {}),
    },
  };

  console.log("[Gate] Passing exact-bound candidates through Evolution Writeback Gate...");
  const gateResult = await processEvolutionPacket(evolutionPacket, {
    force: forceWrite,
    dryRun,
    apply: applyReverseWriteback,
    approvalPacket,
    mutationCandidates,
    requiredApprovalScope: "canonical_reverse_sync",
  });
  console.log(`[Gate] Decision: ${gateResult.decision}`);
  console.log(`[Gate] Risk Level: ${gateResult.riskLevel}`);
  console.log(`[Gate] Reason: ${gateResult.reason}`);

  if (gateResult.decision === "reject") {
    throw new Error(`Evolution writeback rejected: ${gateResult.reason}`);
  }
  if (gateResult.decision === "defer" || gateResult.decision === "escalate") {
    throw new Error(`Evolution writeback ${gateResult.decision}: ${gateResult.reason}`);
  }
  if (dryRun || gateResult.decision !== "approve" || !applyReverseWriteback) {
    console.log("");
    console.log(
      dryRun
        ? t.reverseModeDryRun
        : "Candidate collection complete: canonicalWrites=0. Supply --approval <file> --apply after Warden review.",
    );
    return {
      signals: allSignals,
      mutationCandidates,
      candidateArtifact,
      applied: false,
      canonicalWrites: 0,
    };
  }

  // Re-read every canonical source before the first write. Approval binds the
  // exact pre-state, so a concurrent/user edit invalidates the whole batch.
  for (let index = 0; index < toWrite.length; index += 1) {
    const signal = toWrite[index];
    await assertReverseSyncSourcePrestate(signal, mutationCandidates[index]);
  }

  const writtenFiles = [];
  const priorStates = [];

  try {
    for (let index = 0; index < toWrite.length; index += 1) {
      const signal = toWrite[index];
      const priorContent = await assertReverseSyncSourcePrestate(signal, mutationCandidates[index]);
      priorStates.push({ path: signal.canonicalPath, priorContent });
      await ensureDir(path.dirname(signal.canonicalPath));
      const tempPath = `${signal.canonicalPath}.meta-kim-writeback-${process.pid}.tmp`;
      try {
        await fs.writeFile(tempPath, signal.runtimeContent, "utf8");
        // The approval pre-state is rechecked immediately before each atomic
        // rename, after the replacement bytes are fully materialized.
        await assertReverseSyncSourcePrestate(signal, mutationCandidates[index]);
        await fs.rename(tempPath, signal.canonicalPath);
      } finally {
        await fs.rm(tempPath, { force: true });
      }
      console.log(`  [writeback] ${signal.displayPath} -> canonical/${path.relative(repoRoot, signal.canonicalPath)}`);
      writtenFiles.push(signal.canonicalPath);
    }
  } catch (error) {
    try {
      await rollbackReverseSyncPriorStates(priorStates);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, ...rollbackError.errors],
        "Reverse sync batch failed and rollback could not restore every prior state",
      );
    }
    throw new Error(`Reverse sync batch rolled back: ${error.message}`);
  }

  if (writtenFiles.length > 0) {
    console.log("");
    console.log(t.reverseModeComplete(writtenFiles.length));
  }

  return {
    signals: allSignals,
    mutationCandidates,
    candidateArtifact,
    applied: writtenFiles.length > 0,
    canonicalWrites: writtenFiles.length,
  };
}

/**
 * Resolve projection directories based on scope.
 * Returns an object with all paths needed for sync.
 */
function resolveProjectionDirs(scope) {
  const claude = resolveRuntimeProjection("claude", scope);
  const codex = resolveRuntimeProjection("codex", scope);
  const openclaw = resolveRuntimeProjection("openclaw", scope);
  const cursor = resolveRuntimeProjection("cursor", scope);
  const globalScope = scope === "global";

  return {
    scope,
    // Claude Code
    claudeAgentsProjectionDir: claude.agentsDir,
    claudeSkillsProjectionDir: claude.skillsDir,
    claudeSkillProjectionRoot: claude.skillRoot,
    claudeHooksProjectionDir: claude.hooksDir,
    claudeCommandsDir: claude.commandsDir,
    claudeSettingsProjectionPath: claude.settingsFile,
    claudeMcpProjectionPath: claude.mcpFile,
    claudeCapabilityIndexDir: claude.capabilityIndexDir,

    // Codex
    codexSkillsDir: codex.skillsDir,
    codexSkillRoot: codex.skillRoot,
    codexLegacySkillRoot: globalScope ? null : codex.legacySkillRoot,
    codexLegacySkillsDir: globalScope
      ? null
      : path.join(repoRoot, ".codex", "skills"),
    codexLegacySkillFile: globalScope ? null : codex.legacySkillFile,
    codexLegacySkillReferencesDir: globalScope
      ? null
      : codex.legacySkillReferencesDir,
    codexUsesDirectorySkill: true,
    codexAgentsDir: codex.agentsDir,
    codexHooksDir: codex.hooksDir,
    codexHooksFile: codex.hooksFile,
    codexCommandsDir: codex.commandsDir,
    codexConfigPath: globalScope ? null : codex.configFile,
    codexConfigExamplePath: codex.configExampleFile,
    codexCapabilityIndexDir: codex.capabilityIndexDir,

    // OpenClaw
    openclawWorkspaceDir: openclaw.workspaceDir,
    openclawDisplayWorkspaceDir: openclaw.displayWorkspaceDir,
    openclawSkillsDir: openclaw.skillsDir,
    openclawSkillRoot: openclaw.skillRoot,
    openclawLegacySkillFile: globalScope ? null : openclaw.legacySkillFile,
    openclawLegacySkillReferencesDir: globalScope
      ? null
      : openclaw.legacySkillReferencesDir,
    openclawHooksDir: openclaw.hooksDir,
    openclawTemplateConfigPath: openclaw.templateConfigFile,
    openclawCapabilityIndexDir: openclaw.capabilityIndexDir,

    // Cursor
    cursorAgentsDir: cursor.agentsDir,
    cursorSkillsDir: cursor.skillsDir,
    cursorSkillRoot: cursor.skillRoot,
    cursorHooksDir: cursor.hooksDir,
    cursorHooksFile: cursor.hooksFile,
    cursorMcpPath: cursor.mcpFile,
    cursorCapabilityIndexDir: cursor.capabilityIndexDir,
    cursorRulesDir: cursor.rulesDir,

    // Allowed roots for safety assertion
    allowedRoots: resolveRuntimeAllowedRoots(scope),

    displayPaths: {
      claudeAgents: claude.display.agentsDir,
      claudeSkills: claude.display.skillsDir,
      claudeSkill: claude.display.skillRoot,
      claudeHooks: claude.display.hooksDir,
      claudeCommands: claude.display.commandsDir,
      claudeSettings: claude.display.settingsFile,
      claudeMcp: claude.display.mcpFile,
      claudeCapabilityIndex: claude.display.capabilityIndexDir,
      codexAgents: codex.display.agentsDir,
      codexSkillsRoot: codex.display.skillsDir,
      codexSkills: codex.display.skillRoot,
      codexHooks: codex.display.hooksDir,
      codexHooksFile: codex.display.hooksFile,
      codexCommands: codex.display.commandsDir,
      codexConfig: globalScope ? null : codex.display.configFile,
      codexConfigExample: codex.display.configExampleFile,
      codexCapabilityIndex: codex.display.capabilityIndexDir,
      openclawWorkspaces: globalScope
        ? openclaw.baseDir
        : "openclaw/workspaces",
      openclawTemplate: openclaw.display.templateConfigFile,
      openclawCapabilityIndex: openclaw.display.capabilityIndexDir,
      openclawSkillsRoot: openclaw.display.skillsDir,
      openclawSkills: openclaw.display.skillRoot,
      openclawHooks: openclaw.display.hooksDir,
      cursorAgents: cursor.display.agentsDir,
      cursorSkillsRoot: cursor.display.skillsDir,
      cursorSkill: cursor.display.skillRoot,
      cursorHooks: cursor.display.hooksDir,
      cursorHooksFile: cursor.display.hooksFile,
      cursorMcp: cursor.display.mcpFile,
      cursorCapabilityIndex: cursor.display.capabilityIndexDir,
      cursorRules: cursor.display.rulesDir,
    },
  };
}

// ── Canonical source paths (scope-independent) ──────────────────

const canonicalClaudeHooksDir = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "hooks",
);
const canonicalClaudeSettingsPath = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "settings.json",
);
const canonicalClaudeMcpPath = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "mcp.json",
);
const canonicalClaudeCommandsDir = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "commands",
);
const canonicalCodexConfigExamplePath = path.join(
  canonicalRuntimeAssetsDir,
  "codex",
  "config.toml.example",
);
const canonicalCodexCommandsDir = path.join(
  canonicalRuntimeAssetsDir,
  "codex",
  "commands",
);
const canonicalSharedSpineHookPath = path.join(
  canonicalRuntimeAssetsDir,
  "shared",
  "hooks",
  "activate-meta-theory-spine.mjs",
);
const canonicalSharedProjectRootHookPath = path.join(
  canonicalRuntimeAssetsDir,
  "shared",
  "hooks",
  "project-root.mjs",
);
const canonicalClaudeEnforceDispatchHookPath = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "hooks",
  "enforce-agent-dispatch.mjs",
);
const canonicalClaudeBashReadonlyWhitelistPath = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "hooks",
  "bash-readonly-whitelist.mjs",
);
const canonicalCursorRulesDir = path.join(
  canonicalRuntimeAssetsDir,
  "cursor",
  "rules",
);
const canonicalOpenClawTemplatePath = path.join(
  canonicalRuntimeAssetsDir,
  "openclaw",
  "openclaw.template.json",
);
const canonicalOpenClawMemoryHookDir = path.join(
  canonicalRuntimeAssetsDir,
  "openclaw",
  "hooks",
  "mcp-memory-service",
);
const canonicalOpenClawStopSaveProgressHookPath = path.join(
  canonicalRuntimeAssetsDir,
  "claude",
  "hooks",
  "stop-save-progress.mjs",
);
const GLOBAL_META_KIM_HOOK_PACKAGE_FILES = new Set([
  "project-root.mjs",
  "utils.mjs",
  "skip-reminder.mjs",
  "conversation-binding.mjs",
  "spine-state-utils.mjs",
  "spine-state-gates.mjs",
  "spine-state.mjs",
  "activate-meta-theory-spine.mjs",
  "planning-continuity.mjs",
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
  "meta-kim-memory-save.mjs",
]);

const PROJECT_CLAUDE_HOOK_FILES = new Set([
  "utils.mjs",
  "skip-reminder.mjs",
  "spine-state-utils.mjs",
  "spine-state-gates.mjs",
  "spine-state.mjs",
  "planning-continuity.mjs",
  "bash-readonly-whitelist.mjs",
  "enforce-agent-dispatch.mjs",
  "graphify-context.mjs",
  "post-console-log-warn.mjs",
  "post-format.mjs",
  "post-typecheck.mjs",
  "stop-compaction.mjs",
  "stop-completion-guard.mjs",
  "stop-console-log-audit.mjs",
  "stop-spine-cleanup.mjs",
  "subagent-context.mjs",
]);

// These retired basenames may also belong to users. The v1 project install
// manifest has no content hash, so it cannot prove exact ownership for safe
// deletion. Keep them out of the active projection (and avoid missing-source
// warnings) while preserving any existing file until stronger evidence exists.
const PRESERVED_UNOWNED_LEGACY_PROJECT_HOOK_FILES = new Set([
  "hook-i18n.mjs",
]);

const REMOVED_PROJECT_CLAUDE_HOOK_FILES = [
  "block-dangerous-bash.mjs",
  "ecc-permission-cache-wrapper.mjs",
  "meta-kim-memory-save.mjs",
  "stop-memory-save.mjs",
  "stop-save-progress.mjs",
];

const preferredOrder = [
  "meta-warden",
  "meta-genesis",
  "meta-artisan",
  "meta-sentinel",
  "meta-librarian",
  "meta-conductor",
  "meta-prism",
  "meta-scout",
];

function parseFrontmatter(raw, filePath) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`${filePath} is missing YAML frontmatter.`);
  }

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      throw new Error(`${filePath} has an invalid frontmatter line: ${line}`);
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }

  return { data, body: match[2].trimStart() };
}

function extractTitle(body, fallback) {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function extractSummary(body, fallback) {
  const match = body.match(/^>\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function roleFromTitle(title, fallback) {
  const parts = title.split(":");
  return parts.length > 1 ? parts.slice(1).join(":").trim() : fallback;
}

export function parseCanonicalAgent(raw, sourceFile) {
  const { data, body } = parseFrontmatter(raw, sourceFile);
  if (!data.name || !data.description) {
    throw new Error(
      `${sourceFile} must define frontmatter name and description.`,
    );
  }
  const title = extractTitle(body, data.name);
  return {
    id: data.name,
    description: data.description,
    sourceFile,
    title,
    summary: extractSummary(body, data.description),
    role: roleFromTitle(title, data.description),
    raw,
    body: body.trim(),
  };
}

function sortAgents(agents) {
  return [...agents].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left.id);
    const rightIndex = preferredOrder.indexOf(right.id);

    if (leftIndex === -1 && rightIndex === -1) {
      return left.id.localeCompare(right.id);
    }
    if (leftIndex === -1) {
      return 1;
    }
    if (rightIndex === -1) {
      return -1;
    }
    return leftIndex - rightIndex;
  });
}

function parseAgentPresentation(agent) {
  const titleMatch = agent.title.match(
    /^(.*?)(?::\s*(.*?))?(?:\s+([^\s]+))?$/u,
  );
  const displayName = titleMatch?.[1]?.trim() || agent.id;
  const localizedRole = titleMatch?.[2]?.trim() || agent.description;
  const emoji = titleMatch?.[3]?.trim() || "🤖";

  return {
    displayName,
    localizedRole,
    emoji,
  };
}

function buildBootstrap(agent) {
  const { displayName, localizedRole } = parseAgentPresentation(agent);

  return `# BOOTSTRAP.md - ${agent.id}

This workspace already ships Meta_Kim meta-architecture assets; do not invent a persona from scratch.

## Cold-start order

1. Read \`IDENTITY.md\` — confirm you are \`${displayName}\` and your role is ${localizedRole}.
2. Read \`SOUL.md\` — boundaries and quality bar.
3. Read \`TOOLS.md\` and \`AGENTS.md\` — decide what to delegate.
4. Update \`USER.md\` only when the user explicitly asks for long-lived context.

## First reply

- One sentence: what you own (and only that).
- Do not absorb other meta agents' responsibilities.
- Escalate cross-boundary conflicts to \`meta-warden\`.
`;
}

function buildIdentity(agent) {
  const { displayName, localizedRole, emoji } = parseAgentPresentation(agent);

  return `# IDENTITY.md - ${agent.id}

- **Name:** ${displayName}
- **Creature:** Meta_Kim meta agent
- **Vibe:** Focused, minimal, clear boundaries; primary job: ${localizedRole}
- **Emoji:** ${emoji}
- **Avatar:**

## Identity Notes

- Agent ID: \`${agent.id}\`
- Core role: ${agent.description}
- Canonical source: \`${agent.sourceFile}\`
`;
}

function buildUser() {
  return `# USER.md - About Your Human

- **Name:**
- **What to call them:**
- **Pronouns:** _(optional)_
- **Timezone:**
- **Notes:**

## Context

Record this user's long-term preferences for Meta_Kim work; do not store unrelated private data.
`;
}

function buildBoot(agent) {
  const { displayName } = parseAgentPresentation(agent);

  return `# BOOT.md - ${agent.id}

After the OpenClaw gateway starts, run one-time boot checks in this order when needed.

1. Confirm the workspace path and that \`IDENTITY.md\`, \`SOUL.md\`, \`TOOLS.md\`, and \`AGENTS.md\` are readable.
2. Do not message the user proactively; act only when the boot task explicitly requires it.
3. If you see role-boundary conflicts, record them in \`MEMORY.md\` under open questions — do not rewrite persona on your own.
4. If you are \`${displayName}\`, keep boot checks inside your own boundary only.
`;
}

function buildMemory(agent) {
  return `# MEMORY.md - ${agent.id}

Store information that stays true across sessions.

## Do record

- Stable user preferences
- Recurring architecture decisions
- Confirmed boundary interpretations
- Risk constraints that keep applying

## Do not record

- One-off task state
- Ephemeral command output
- Unconfirmed guesses
- Personal data unrelated to Meta_Kim
`;
}

export async function loadCanonicalAgents() {
  const files = (await fs.readdir(canonicalAgentsDir))
    .filter((file) => file.endsWith(".md"))
    .sort();

  const agents = [];
  for (const file of files) {
    const filePath = path.join(canonicalAgentsDir, file);
    const raw = await fs.readFile(filePath, "utf8");
    const sourceFile = path.relative(repoRoot, filePath).replace(/\\/g, "/");
    agents.push(parseCanonicalAgent(raw, sourceFile));
  }

  return sortAgents(agents);
}

function buildWorkspaceDirectory(agents) {
  const rows = agents
    .map(
      (agent) => `| \`${agent.id}\` | ${agent.title} | ${agent.description} |`,
    )
    .join("\n");

  return `# AGENTS.md - Meta_Kim Team Directory

This file is generated from \`canonical/agents/*.md\` by \`npm run sync:runtimes\`.

Use the smallest agent whose boundary matches the task. Escalate to \`meta-warden\` when the task spans multiple agent boundaries.

Important: this file lists only the Meta_Kim team. It is not the full OpenClaw registry. If the user asks how many agents exist, which agents are currently registered, or who can collaborate right now, query the live runtime registry first instead of answering from this file alone.

| Agent ID | Name | Responsibility |
| --- | --- | --- |
${rows}
`;
}

function buildSoul(agent) {
  return `# SOUL.md - ${agent.id}

Generated from \`${agent.sourceFile}\`. Edit the canonical source first, then run \`npm run sync:runtimes\`.

## Runtime Notes

- You are running inside OpenClaw.
- Read the local \`AGENTS.md\` before delegating with \`sessions_send\`.
- \`AGENTS.md\` only lists the Meta_Kim team, not the full OpenClaw registry.
- When the user asks which agents exist, how many agents exist, or who can collaborate right now, query the live runtime registry first through \`agents_list\`. If that tool is unavailable, fall back to an explicit runtime command and state the result source.
- Stay inside your own responsibility boundary unless the user explicitly asks you to coordinate broader work.
- The theory source is \`canonical/skills/meta-theory/references/meta-theory.md\`; public runtime behavior must not depend on local narrative notes.
- For \`meta-theory\`, \`/meta-theory\`, project understanding, architecture, runtime routing, hook/MCP/tool routing, commercialization, market, competitor, pricing, growth, strategy, or roadmap tasks, run or faithfully follow \`npm run meta:theory:run:notice -- "<user request>"\` before Thinking and relay the compact notice/report path. If command execution or retrieval capability is unavailable, return \`blocked_to_fetch\` with the exact missing capability instead of giving a shallow summary.
- Project-understanding Fetch must account for README, AGENTS, package scripts, canonical agents/skills/runtime assets, contracts, capability index, runtime projections, MCP configs, hooks, dependency registry, and Graphify when present.

${agent.body}
`;
}

let heartbeatTemplateCache = null;

async function loadHeartbeatTemplate() {
  if (heartbeatTemplateCache !== null) return heartbeatTemplateCache;
  const templatePath = path.join(
    canonicalRuntimeAssetsDir,
    "openclaw",
    "HEARTBEAT.template.md",
  );
  const raw = await fs.readFile(templatePath, "utf8");
  // Strip leading canonical-only HTML comment line(s). The comment is metadata
  // for editors; it must not appear in the generated workspace file.
  const stripped = raw.replace(/^<!--[\s\S]*?-->\r?\n/, "");
  heartbeatTemplateCache = stripped;
  return stripped;
}

async function buildHeartbeat(agent) {
  const template = await loadHeartbeatTemplate();
  return template.replaceAll("{{AGENT_ID}}", agent.id);
}

function buildTools(agent, agents) {
  const teammates = agents
    .filter((item) => item.id !== agent.id)
    .map((item) => `- \`${item.id}\`: ${item.description}`)
    .join("\n");

  return `# TOOLS.md - ${agent.id}

Auto-generated by \`npm run sync:runtimes\`. Edit templates in \`scripts/sync-runtimes.mjs\`, then re-sync.

## OpenClaw runtime conventions

- Read \`SOUL.md\` and \`AGENTS.md\` in this directory first.
- For collaboration, prefer OpenClaw native agent-to-agent routing.
- \`AGENTS.md\` lists the Meta_Kim team only — it is not the full OpenClaw registry.
- When the user asks for agent counts, names, or who can collaborate, call \`agents_list\` first; if unavailable, use an explicit command and state the source.
- Shared skill: \`../../skills/meta-theory/SKILL.md\` (directory under \`openclaw/skills/\`, not duplicated per workspace).
- Do not absorb other agents' duties; delegate or escalate to \`meta-warden\` when out of scope.

## Teammates

${teammates || "- None"}
`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function loadSkillReferences() {
  const entries = await fs.readdir(canonicalSkillReferencesDir, {
    withFileTypes: true,
  });
  const files = entries.filter((entry) => entry.isFile());

  return Promise.all(
    files.map(async (file) => ({
      name: file.name,
      content: await fs.readFile(
        path.join(canonicalSkillReferencesDir, file.name),
        "utf8",
      ),
    })),
  );
}

async function collectSkillFiles(rootDir, currentDir = rootDir, bucket = []) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectSkillFiles(rootDir, entryPath, bucket);
    } else if (entry.isFile()) {
      if (entry.name.includes(".tmp.") || entry.name.endsWith(".tmp")) {
        continue;
      }
      let content;
      try {
        content = await fs.readFile(entryPath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      bucket.push({
        relativePath: path.relative(rootDir, entryPath).replace(/\\/g, "/"),
        content,
      });
    }
  }
  return bucket.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function collectCommandFiles(commandsDir) {
  let entries = [];
  try {
    entries = await fs.readdir(commandsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

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
      content: await fs.readFile(path.join(commandsDir, entry.name), "utf8"),
    });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

async function loadCanonicalSkills() {
  const entries = await fs.readdir(canonicalSkillsDir, { withFileTypes: true });
  const skills = [];

  for (const entry of entries.filter((item) => item.isDirectory())) {
    const skillRoot = path.join(canonicalSkillsDir, entry.name);
    const skillPath = path.join(skillRoot, "SKILL.md");
    let raw = null;
    try {
      raw = await fs.readFile(skillPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    assertPortableSkillFrontmatter(raw, skillPath);
    skills.push({
      id: entry.name,
      root: skillRoot,
      skillPath,
      files: await collectSkillFiles(skillRoot),
    });
  }

  if (skills.length === 0) {
    throw new Error("No canonical skills found under canonical/skills/*/SKILL.md.");
  }

  return skills.sort((left, right) => left.id.localeCompare(right.id));
}

function assertPortableSkillFrontmatter(raw, filePath) {
  const validation = validateSkillFrontmatter(raw);
  if (!validation.ok) {
    throw new Error(
      `Invalid canonical skill frontmatter in ${filePath}: ${validation.message}`,
    );
  }
}

function escapeTomlBasicMultiline(value) {
  return value.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}

function escapeTomlBasicString(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CODEX_NICKNAME_CANDIDATES_BY_AGENT = {
  "meta-warden": ["Meta Warden", "Warden"],
  "meta-genesis": ["Meta Genesis", "Genesis"],
  "meta-artisan": ["Meta Artisan", "Artisan"],
  "meta-sentinel": ["Meta Sentinel", "Sentinel"],
  "meta-librarian": ["Meta Librarian", "Librarian"],
  "meta-conductor": ["Meta Conductor", "Conductor"],
  "meta-prism": ["Meta Prism", "Prism", "Review"],
  "meta-scout": ["Meta Scout", "Scout"],
  "meta-chrysalis": ["Meta Chrysalis", "Chrysalis"],
};

// Meta_Kim projects only governance agents into Codex. Execution-layer labels
// such as frontend/backend/test are run-scoped `roleDisplayName` values in
// packets, not durable project/global `.codex/agents/*.toml` files.
export const CODEX_RUNTIME_ADAPTER_AGENTS = [];

export const CODEX_BUSINESS_ROLE_AGENTS = [];

function normalizeCodexNicknameCandidate(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function assertCodexNicknameCandidate(value, context) {
  if (!/^[A-Za-z0-9 _-]+$/.test(value)) {
    throw new Error(
      `${context} has invalid Codex nickname candidate "${value}". ` +
        "Codex nickname_candidates must stay ASCII alphanumeric with spaces, hyphens, or underscores.",
    );
  }
}

function uniqueNicknameCandidates(candidates, context) {
  const result = [];
  const seen = new Set();
  for (const rawCandidate of candidates) {
    const candidate = normalizeCodexNicknameCandidate(rawCandidate);
    if (!candidate || seen.has(candidate)) continue;
    assertCodexNicknameCandidate(candidate, context);
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

function titleCaseAgentId(agentId) {
  return String(agentId ?? "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function buildCodexNicknameCandidates(agent) {
  const configured = CODEX_NICKNAME_CANDIDATES_BY_AGENT[agent.id] ?? [];
  const fallback = titleCaseAgentId(agent.id);
  return uniqueNicknameCandidates(
    [...configured, fallback, agent.id],
    `Codex agent ${agent.id}`,
  );
}

function formatTomlStringArray(values) {
  return `[${values.map((value) => `"${escapeTomlBasicString(value)}"`).join(", ")}]`;
}

function buildCodexAgentInstructions(agent) {
  return [
    `You are the Codex custom agent mirror of Meta_Kim agent \`${agent.id}\`.`,
    `Primary responsibility: ${agent.description}`,
    "Stay inside your own responsibility boundary.",
    "If the task crosses agent boundaries, hand the decision back to the parent session or recommend the correct sibling meta agent.",
    "Use the portable meta-theory skill when it helps, but do not claim ownership of another agent's deliverable.",
    "",
    agent.body.trim(),
  ].join("\n");
}

export function buildCodexAgent(agent) {
  const instructions = escapeTomlBasicMultiline(
    buildCodexAgentInstructions(agent),
  );
  const nicknameCandidates = buildCodexNicknameCandidates(agent);

  return `name = "${agent.id}"
description = "${escapeTomlBasicString(agent.description)}"
nickname_candidates = ${formatTomlStringArray(nicknameCandidates)}
developer_instructions = """
${instructions}
"""
`;
}

/**
 * Build a Cursor-compatible agent Markdown file.
 * Cursor agents live in .cursor/agents/*.md and require YAML frontmatter.
 */
export function buildCursorAgent(agent) {
  const description = String(agent.description ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n");
  const body = String(agent.body ?? "");
  const bodyHasTitle = new RegExp(`^#\\s+${escapeRegExp(agent.title)}\\s*$`, "m").test(body);
  const bodyHasGovernanceWarning = /GOVERNANCE LAYER AGENT\s+—\s+NOT FOR DIRECT EXECUTION/.test(body);
  const generatedPreamble = [
    bodyHasTitle ? null : `# ${agent.title}`,
    bodyHasGovernanceWarning ? null : `> ${agent.summary}`,
    `<!-- Generated from ${agent.sourceFile} by npm run sync:runtimes. Edit canonical source first. -->`,
    `You are the Cursor agent mirror of Meta_Kim agent \`${agent.id}\`.`,
    `Primary responsibility: ${agent.description}`,
    "Stay inside your own responsibility boundary.",
    "If the task crosses agent boundaries, hand the decision back to the parent session or recommend the correct sibling meta agent.",
    "Use the portable meta-theory skill when it helps, but do not claim ownership of another agent's deliverable.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return `---
name: ${agent.id}
description: "${description}"
---

${generatedPreamble}

---

${body}
`;
}

const GLOBAL_AGENT_RENDERERS = Object.freeze({
  canonical_markdown: (agent) => agent.raw,
  codex_toml: buildCodexAgent,
  cursor_markdown: buildCursorAgent,
});

export function renderGlobalAgentProjection(agent, projection) {
  const renderer = GLOBAL_AGENT_RENDERERS[projection?.renderer];
  if (!renderer) {
    throw new Error(
      `Unsupported global Agent renderer: ${projection?.renderer ?? "<missing>"}`,
    );
  }
  return renderer(agent);
}

async function writeGeneratedFile(filePath, nextContent) {
  assertSafeRepoProjectionPath(filePath);
  if (isRuntimeSedimentedProjectPath(filePath)) {
    return { changed: false, preserved: true, reason: "runtime_sedimented_project_copy" };
  }
  const globalRecord = syncScopeForWritePlan === "global"
    ? inferGlobalProjectionRecord(filePath)
    : null;
  if (syncScopeForWritePlan === "global" && !globalRecord) {
    throw new Error(
      `Global projection path has no runtime-profile ownership mapping: ${filePath}`,
    );
  }
  if (
    globalRecord &&
    (
      globalRecord.owner !== GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES ||
      (
        requestedGlobalAssetTypes !== null &&
        !requestedGlobalAssetTypes.has(globalRecord.assetType)
      )
    )
  ) {
    return {
      changed: false,
      preserved: true,
      reason:
        globalRecord.owner !== GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES
          ? `owned_by:${globalRecord.owner}`
          : `asset_not_selected:${globalRecord.assetType}`,
    };
  }
  const recordGeneratedFile = () => {
    const category = globalRecord?.category ?? inferProjectCategory(filePath);
    if (!category) return;
    recordSafe((rec) =>
      rec.recordFile(filePath, {
        source: "sync-runtimes",
        purpose: globalRecord?.purpose ?? inferProjectPurpose(category),
        category,
        ownershipClass: "install_projection",
        runtimeTarget:
          globalRecord?.runtimeTarget ?? inferProjectRuntimeTarget(filePath),
      }),
    );
  };

  let currentContent = null;
  try {
    currentContent = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (currentContent === nextContent) {
    if (!checkOnly) {
      recordGeneratedFile();
    }
    return { changed: false };
  }

  if (checkOnly) {
    staleFiles.push({
      path: filePath,
      category: globalRecord?.category ?? inferProjectCategory(filePath),
      action: currentContent === null ? "create" : "update",
    });
    return { changed: true };
  }

  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, nextContent, "utf8");
  recordGeneratedFile();
  return { changed: true };
}

async function writeGeneratedJson(filePath, value) {
  const nextContent = `${JSON.stringify(value, null, 2)}\n`;
  return writeGeneratedFile(filePath, nextContent);
}

function renderMetaKimRuntimeMcp(content, rootDir) {
  const normalizedRoot = rootDir.replace(/\\/g, "/");
  return content.replaceAll("__REPO_ROOT__", normalizedRoot);
}

function renderCodexConfigExample(content, rootDir) {
  const normalizedRoot = rootDir.replace(/\\/g, "/");
  return content.replaceAll("REPLACE_WITH_REPO_ROOT", normalizedRoot);
}

/**
 * Additive merge: take a rendered canonical MCP config (already containing
 * the meta_kim-runtime server) and union it with any user-added servers
 * already present at the projection path. User-added servers (anything that
 * is not meta-kim-runtime) are preserved across syncs so the user can keep
 * local helper MCPs (memory, sqlite, etc.) registered without re-adding
 * them after every `npm run meta:sync`.
 *
 * Preserves canonical entries when both sides define the same server name.
 */
function mergeUserMcpServers(canonicalRendered, existingRaw) {
  let parsedCanonical = {};
  let parsedExisting = {};
  try {
    parsedCanonical = JSON.parse(canonicalRendered);
  } catch {
    parsedCanonical = {};
  }
  try {
    parsedExisting = JSON.parse(existingRaw);
  } catch {
    parsedExisting = {};
  }
  const canonicalServers =
    parsedCanonical && typeof parsedCanonical === "object" && parsedCanonical.mcpServers
      ? parsedCanonical.mcpServers
      : {};
  const existingServers =
    parsedExisting && typeof parsedExisting === "object" && parsedExisting.mcpServers
      ? parsedExisting.mcpServers
      : {};
  const merged = {};
  for (const [name, def] of Object.entries(canonicalServers)) {
    merged[name] = def;
  }
  for (const [name, def] of Object.entries(existingServers)) {
    if (Object.prototype.hasOwnProperty.call(merged, name)) continue;
    merged[name] = def;
  }
  return `${JSON.stringify({ mcpServers: merged }, null, 2)}\n`;
}

export function buildCodexProjectConfig(
  currentContent,
  configExampleContent,
  options = {},
) {
  const seed = String(currentContent ?? "").trim()
    ? String(currentContent ?? "")
    : renderCodexConfigExample(configExampleContent, repoRoot);
  return ensureCodexAppNativeControls(seed, {
    codexHome: resolveRuntimeHomeDir("codex"),
    ...options,
  });
}

function emptyMcpConfigContent() {
  return `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
}

async function removeGeneratedPath(filePath) {
  if (!filePath) return { changed: false };
  assertSafeRepoProjectionPath(filePath);

  let exists = false;
  try {
    await fs.access(filePath);
    exists = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  if (!exists) return { changed: false };

  if (checkOnly) {
    staleFiles.push({
      path: filePath,
      category: inferProjectCategory(filePath),
      action: "delete",
    });
    return { changed: true };
  }

  await fs.rm(filePath, { recursive: true, force: true });
  return { changed: true };
}

export const GLOBAL_ONLY_DURABLE_PROJECTION_ROOTS = [
  ".claude/agents",
  ".claude/skills",
  ".claude/commands",
  ".claude/capability-index",
  ".codex/agents",
  ".agents/skills",
  ".codex/commands",
  ".codex/capability-index",
  ".cursor/agents",
  ".cursor/skills",
  ".cursor/rules",
  ".cursor/capability-index",
  "codex",
  "openclaw",
];

export const GLOBAL_ONLY_WHOLE_FILE_PROJECTIONS = [
  ".codex/hooks.json",
  ".cursor/hooks.json",
];

async function walkFiles(rootPath) {
  assertSafeRepoProjectionPath(rootPath);
  let stat;
  try {
    stat = await fs.stat(rootPath);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (stat.isFile()) return [rootPath];
  if (!stat.isDirectory()) return [];
  const out = [];
  for (const entry of await fs.readdir(rootPath, { withFileTypes: true })) {
    const childPath = path.join(rootPath, entry.name);
    assertSafeRepoProjectionPath(childPath);
    if (entry.isFile()) out.push(childPath);
    else if (entry.isDirectory()) out.push(...await walkFiles(childPath));
  }
  return out;
}

async function removeEmptyTree(rootPath) {
  assertSafeRepoProjectionPath(rootPath);
  let entries;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyTree(path.join(rootPath, entry.name));
  }
  const remaining = await fs.readdir(rootPath);
  if (remaining.length === 0 && !checkOnly) await fs.rmdir(rootPath);
}

function projectionRelativeChild(rootPath, candidatePath) {
  if (typeof rootPath !== "string" || !rootPath.trim()) return null;
  const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  const normalizedCandidate = candidatePath.replace(/\\/g, "/").replace(/^\.\//u, "");
  if (!normalizedCandidate.startsWith(`${normalizedRoot}/`)) return null;
  const relativePath = normalizedCandidate.slice(normalizedRoot.length + 1);
  return relativePath || null;
}

export async function canonicalGlobalOnlyProjectionContent(
  filePath,
  agents,
  {
    rootDir = repoRoot,
    profiles = runtimeProfilesForSync,
  } = {},
) {
  const relativePath = path.relative(rootDir, filePath).replace(/\\/g, "/");
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  const candidates = [];
  for (const [targetId, profile] of Object.entries(profiles ?? {})) {
    const outputPaths = profile?.projection?.outputPaths ?? {};
    const capabilityRelative = projectionRelativeChild(
      outputPaths.capabilityIndexDir,
      relativePath,
    );
    if (capabilityRelative) {
      candidates.push({
        targetId,
        kind: "capability-index",
        content: await tryReadCanonical(
          path.join(canonicalCapabilityIndexDir, ...capabilityRelative.split("/")),
        ),
      });
    }

    const projection = profile?.projection?.globalAgentProjection;
    if (!projection?.supported) continue;
    const agentRelative = projectionRelativeChild(outputPaths.agentsDir, relativePath);
    if (!agentRelative || agentRelative.includes("/")) continue;
    const agent = agents.find((item) =>
      globalAgentProjectionFileName(projection, item.id) === agentRelative
    );
    if (!agent) continue;
    candidates.push({
      targetId,
      kind: "agent",
      content: renderGlobalAgentProjection(agent, projection),
    });
  }
  const matches = candidates.filter(({ content }) => content !== null);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous runtime-profile canonical projection mapping for ${relativePath}: ` +
        matches.map(({ targetId, kind }) => `${targetId}:${kind}`).join(", "),
    );
  }
  return matches[0]?.content ?? null;
}

export function canRetireGlobalOnlyProjection({
  manifestMatches,
  actualContent,
  expectedContent,
}) {
  return manifestMatches ||
    (expectedContent !== null && actualContent === expectedContent);
}

async function removeExactlyOwnedProjectionFile(filePath, agents) {
  assertSafeRepoProjectionPath(filePath);
  const ownership = inspectProjectProjectionOwnership(filePath);
  if (ownership.preserve) {
    return { changed: false, preserved: true, reason: ownership.reason };
  }
  const { entry } = ownership;
  const manifestMatches = manifestFileEntryMatches(entry, filePath);
  const expectedContent = await canonicalGlobalOnlyProjectionContent(filePath, agents);
  const actualContent = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!canRetireGlobalOnlyProjection({ manifestMatches, actualContent, expectedContent })) {
    staleFiles.push({
      path: filePath,
      category: inferProjectCategory(filePath),
      action: "preserve",
      reason: entry.sha256 ? "managed_file_changed" : "legacy_manifest_missing_integrity",
    });
    return { changed: false, preserved: true, reason: "canonical_projection_not_exact" };
  }
  if (checkOnly) {
    staleFiles.push({
      path: filePath,
      category: inferProjectCategory(filePath),
      action: "delete",
    });
    return { changed: true };
  }
  await fs.unlink(filePath);
  forgetRecordedPath(filePath);
  return { changed: true };
}

async function removeExactlyOwnedProjectionTree(relativePath, changedFiles, agents) {
  const rootPath = path.join(repoRoot, relativePath);
  const files = await walkFiles(rootPath);
  for (const filePath of files) {
    const result = await removeExactlyOwnedProjectionFile(filePath, agents);
    if (result.changed) changedFiles.push(path.relative(repoRoot, filePath).replace(/\\/g, "/"));
  }
  await removeEmptyTree(rootPath);
}

function stripTomlTable(raw, tableName) {
  const lines = String(raw ?? "").split(/\r?\n/);
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`);
  if (!lines.some((line) => header.test(line))) return String(raw ?? "");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (header.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^\s*\[/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

async function rewriteGlobalOnlyConfig(filePath, transform, changedFiles) {
  assertSafeRepoProjectionPath(filePath);
  if (isRuntimeSedimentedProjectPath(filePath)) return;
  let current;
  try {
    current = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let next;
  try {
    next = transform(current);
  } catch {
    return; // Unknown or malformed user configuration is preserved verbatim.
  }
  if (next === current) return;
  const rel = path.relative(repoRoot, filePath).replace(/\\/g, "/");
  if (checkOnly) {
    staleFiles.push({ path: filePath, category: inferProjectCategory(filePath), action: "update" });
  } else {
    await fs.writeFile(filePath, next, "utf8");
    forgetRecordedPath(filePath);
  }
  changedFiles.push(rel);
}

async function enforceGlobalOnlyProjectShape(changedFiles) {
  for (const relativePath of GLOBAL_ONLY_DURABLE_PROJECTION_ROOTS) {
    await removeExactlyOwnedProjectionTree(relativePath, changedFiles, canonicalAgentsForGlobalOnly);
  }
  for (const relativePath of GLOBAL_ONLY_WHOLE_FILE_PROJECTIONS) {
    const filePath = path.join(repoRoot, relativePath);
    const result = await removeExactlyOwnedProjectionFile(filePath, canonicalAgentsForGlobalOnly);
    if (result.changed) changedFiles.push(relativePath);
  }

  await rewriteGlobalOnlyConfig(
    path.join(repoRoot, ".claude", "settings.json"),
    (raw) => {
      const parsed = JSON.parse(raw);
      const cleaned = stripRepoMetaKimHooksFromSettings(parsed);
      return JSON.stringify(parsed) === JSON.stringify(cleaned)
        ? raw
        : `${JSON.stringify(cleaned, null, 2)}\n`;
    },
    changedFiles,
  );
  await rewriteGlobalOnlyConfig(
    path.join(repoRoot, ".mcp.json"),
    (raw) => {
      const parsed = JSON.parse(raw);
      if (!parsed?.mcpServers || typeof parsed.mcpServers !== "object") return raw;
      if (!Object.prototype.hasOwnProperty.call(parsed.mcpServers, "meta-kim-runtime")) return raw;
      delete parsed.mcpServers["meta-kim-runtime"];
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
    changedFiles,
  );
  await rewriteGlobalOnlyConfig(
    path.join(repoRoot, ".cursor", "mcp.json"),
    (raw) => {
      const parsed = JSON.parse(raw);
      if (!parsed?.mcpServers || typeof parsed.mcpServers !== "object") return raw;
      if (!Object.prototype.hasOwnProperty.call(parsed.mcpServers, "meta-kim-runtime")) return raw;
      delete parsed.mcpServers["meta-kim-runtime"];
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
    changedFiles,
  );
  await rewriteGlobalOnlyConfig(
    path.join(repoRoot, ".codex", "config.toml"),
    (raw) => stripTomlTable(
      stripTomlTable(raw, "mcp_servers.meta-kim-runtime"),
      "mcp_servers.meta_kim_runtime",
    ),
    changedFiles,
  );
}

async function removeDirIfEmpty(dirPath) {
  if (!dirPath) return { changed: false };

  let entries;
  try {
    entries = await fs.readdir(dirPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { changed: false };
    }
    throw error;
  }

  if (entries.length > 0) {
    return { changed: false };
  }

  if (checkOnly) {
    staleFiles.push({
      path: dirPath,
      category: inferProjectCategory(dirPath),
      action: "delete",
    });
    return { changed: true };
  }

  await fs.rmdir(dirPath);
  return { changed: true };
}

async function syncCapabilityIndexMirrors(dirs, selectedTargets, changedFiles) {
  const canonicalContent = await tryReadCanonical(
    path.join(canonicalCapabilityIndexDir, "meta-kim-capabilities.json"),
  );
  if (!canonicalContent) return;

  const targets = {
    claude: {
      dir: dirs.claudeCapabilityIndexDir,
      display: dirs.displayPaths.claudeCapabilityIndex,
    },
    codex: {
      dir: dirs.codexCapabilityIndexDir,
      display: dirs.displayPaths.codexCapabilityIndex,
    },
    openclaw: {
      dir: dirs.openclawCapabilityIndexDir,
      display: dirs.displayPaths.openclawCapabilityIndex,
    },
    cursor: {
      dir: dirs.cursorCapabilityIndexDir,
      display: dirs.displayPaths.cursorCapabilityIndex,
    },
  };

  for (const targetId of selectedTargets) {
    const target = targets[targetId];
    if (!target?.dir) continue;

    const mirrorPath = path.join(target.dir, "meta-kim-capabilities.json");
    if ((await writeGeneratedFile(mirrorPath, canonicalContent)).changed) {
      changedFiles.push(`${target.display}/meta-kim-capabilities.json`);
    }

    const localInventoryPath = path.join(target.dir, "global-capabilities.json");
    if ((await removeGeneratedPath(localInventoryPath)).changed) {
      changedFiles.push(`${target.display}/global-capabilities.json`);
    }
  }
}

// ── Runtime skill path substitution ─────────────────────────────────────
// The canonical SKILL.md and its references use canonical/ paths.
// During sync, these are substituted to runtime-specific paths so that
// the skill works correctly in each runtime projection.
//
// IMPORTANT: These rules must match the actual synced directory structure.
// When the sync config (meta-kim-sync-config.mjs) changes, these rules
// MUST be updated to match.

/**
 * Build a path substitution map for a given runtime target.
 * canonical/ paths are replaced with the runtime's actual projection paths.
 * @param {"claude"|"codex"|"openclaw"|"cursor"} targetId
 * @returns {{pattern:RegExp, replacement:string}[]}
 */
function buildRuntimeSkillMap(targetId) {
  const maps = {
    claude: [
      // Skill references: canonical/ → runtime-specific for Claude
      {
        pattern: /canonical\/skills\/meta-theory\/references\//g,
        replacement: ".claude/skills/meta-theory/references/",
      },
      {
        pattern: /canonical\/agents\/([A-Za-z0-9_*{}<>-]+)\.md/g,
        replacement: ".claude/agents/$1.md",
      },
      // Agent definitions: canonical/ → runtime-specific for Claude
      { pattern: /canonical\/agents\//g, replacement: ".claude/agents/" },
      // Hook files: stay in .claude/hooks/ (no canonical equivalent)
      { pattern: /\.claude\/hooks\//g, replacement: ".claude/hooks/" },
      // Capability index: stays in .claude/capability-index/
      {
        pattern: /\.claude\/capability-index\//g,
        replacement: ".claude/capability-index/",
      },
      // Legacy .claude/skills/ references in canonical source → canonical/skills/ (normalize to canonical/)
      { pattern: /\.claude\/skills\//g, replacement: "canonical/skills/" },
    ],
    codex: [
      // Skill references: canonical/ → .agents/skills/meta-theory/references/
      {
        pattern: /canonical\/skills\/meta-theory\/references\//g,
        replacement: ".agents/skills/meta-theory/references/",
      },
      // Skill root: canonical/skills/ → .agents/skills/
      { pattern: /canonical\/skills\//g, replacement: ".agents/skills/" },
      {
        pattern: /canonical\/agents\/([A-Za-z0-9_*{}<>-]+)\.md/g,
        replacement: ".codex/agents/$1.toml",
      },
      // Agent definitions: canonical/ → .codex/agents/
      { pattern: /canonical\/agents\//g, replacement: ".codex/agents/" },
      // Hooks: Codex uses .codex/hooks/ plus .codex/hooks.json
      { pattern: /\.claude\/hooks\//g, replacement: ".codex/hooks/" },
      // Capability index: preserve subdirectory structure
      {
        pattern: /\.claude\/capability-index\//g,
        replacement: ".codex/capability-index/",
      },
      // Legacy .claude/skills/ references in source → platform-specific path
      { pattern: /\.claude\/skills\//g, replacement: ".agents/skills/" },
    ],
    openclaw: [
      // Skill references: canonical/ → openclaw/skills/meta-theory/references/
      {
        pattern: /canonical\/skills\/meta-theory\/references\//g,
        replacement: "openclaw/skills/meta-theory/references/",
      },
      // Skill root: canonical/skills/ → openclaw/skills/
      { pattern: /canonical\/skills\//g, replacement: "openclaw/skills/" },
      {
        pattern: /canonical\/agents\/([A-Za-z0-9_*{}<>-]+)\.md/g,
        replacement: "openclaw/workspaces/$1/SOUL.md",
      },
      // Agent definitions: OpenClaw uses workspace-per-agent model.
      // Each workspace has AGENTS.md containing all agent definitions.
      {
        pattern: /canonical\/agents\//g,
        replacement: "openclaw/workspaces/{workspace}/AGENTS.md#",
      },
      // Hooks: OpenClaw internal hooks live under openclaw/hooks/.
      // Tool-blocking policy requires a typed plugin hook adapter.
      { pattern: /\.claude\/hooks\//g, replacement: "openclaw/hooks/" },
      // Capability index: preserve subdirectory structure
      {
        pattern: /\.claude\/capability-index\//g,
        replacement: "openclaw/capability-index/",
      },
      // Legacy .claude/skills/ references in source → platform-specific path
      { pattern: /\.claude\/skills\//g, replacement: "openclaw/skills/" },
    ],
    cursor: [
      // Skill references: canonical/ → .cursor/skills/meta-theory/references/
      {
        pattern: /canonical\/skills\/meta-theory\/references\//g,
        replacement: ".cursor/skills/meta-theory/references/",
      },
      // Skill root: canonical/skills/ → .cursor/skills/
      { pattern: /canonical\/skills\//g, replacement: ".cursor/skills/" },
      {
        pattern: /canonical\/agents\/([A-Za-z0-9_*{}<>-]+)\.md/g,
        replacement: ".cursor/agents/$1.md",
      },
      // Agent definitions: canonical/ → .cursor/agents/
      { pattern: /canonical\/agents\//g, replacement: ".cursor/agents/" },
      // Hooks: Cursor uses .cursor/hooks/ plus .cursor/hooks.json
      { pattern: /\.claude\/hooks\//g, replacement: ".cursor/hooks/" },
      // Capability index: preserve subdirectory structure
      {
        pattern: /\.claude\/capability-index\//g,
        replacement: ".cursor/capability-index/",
      },
      // Legacy .claude/skills/ references in source → platform-specific path
      { pattern: /\.claude\/skills\//g, replacement: ".cursor/skills/" },
    ],
  };

  return maps[targetId] || maps.claude;
}

/**
 * Apply runtime-specific path substitutions to skill content.
 * @param {string} content - The skill file content
 * @param {"claude"|"codex"|"openclaw"|"cursor"} targetId
 * @returns {string}
 */
export function applyRuntimePaths(content, targetId) {
  const rules = buildRuntimeSkillMap(targetId);
  const protectedBlocks = [];
  let result = content;
  for (const pattern of [
    /Fetch discovery minimum checklist: before Thinking, search at least these locations \(even if results are empty\):[\s\S]*?\n(?=Pass condition:)/g,
    /^- 项目内迭代或创新需要专用能力时，必须创建在对应 runtime 的原生项目目录[\s\S]*?\n/gm,
  ]) {
    result = result.replace(pattern, (block) => {
      const token = `__META_KIM_RUNTIME_LITERAL_BLOCK_${protectedBlocks.length}__`;
      protectedBlocks.push({ token, block });
      return token;
    });
  }
  for (const { pattern, replacement } of rules) {
    result = result.replace(pattern, replacement);
  }
  for (const { token, block } of protectedBlocks) {
    result = result.replace(token, block);
  }
  return result;
}

function readFrontmatterField(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(new RegExp(`^${key}:\\s*(.*)$`));
    if (!match) continue;
    const rawValue = match[1].trim();
    if (rawValue === "|" || rawValue === ">") {
      const blockLines = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        if (/^[A-Za-z0-9_-]+:\s*/.test(lines[next])) {
          break;
        }
        blockLines.push(lines[next].replace(/^\s{2}/, ""));
      }
      return blockLines.join("\n").trim();
    }
    return rawValue.replace(/^['"]|['"]$/g, "").trim();
  }
  return "";
}

function formatYamlScalar(value) {
  const normalized = String(value ?? "").trim();
  if (normalized.includes("\n")) {
    return `|\n${normalized
      .split(/\r?\n/)
      .map((line) => `  ${line}`)
      .join("\n")}`;
  }
  if (/^[A-Za-z0-9 _.,;()'"—-]+$/.test(normalized)) {
    return normalized;
  }
  return JSON.stringify(normalized);
}

export function buildCodexSkillContent(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return content;
  }
  const frontmatter = match[1];
  const name = readFrontmatterField(frontmatter, "name");
  const description = readFrontmatterField(frontmatter, "description");
  if (!name || !description) {
    return content;
  }
  return `---\nname: ${formatYamlScalar(name)}\ndescription: ${formatYamlScalar(description)}\n---\n\n${content.slice(match[0].length)}`;
}

export function buildCodexGraphifyContextHook() {
  return [
    'import { existsSync, readFileSync } from "node:fs";',
    'import path from "node:path";',
    'import process from "node:process";',
    "",
    "function readPayload() {",
    "  try {",
    '    const raw = readFileSync(0, "utf8");',
    '    return raw.trim() ? JSON.parse(raw) : {};',
    "  } catch {",
    "    return {};",
    "  }",
    "}",
    "",
    "const payload = readPayload();",
    'const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();',
    'const graphPath = path.join(cwd, "graphify-out", "graph.json");',
    "",
    "if (existsSync(graphPath)) {",
    "  console.log(",
    "    JSON.stringify({",
    '      systemMessage: "graphify: Knowledge graph exists. For focused questions, run `graphify query \\"<question>\\" --budget 1000` first; use `graphify path`/`graphify explain` for relationships or concepts. Treat graph results as candidate file anchors and verify route-changing claims against source files; fall back to targeted `rg` when results are generic or stale. Read GRAPH_REPORT.md only for broad architecture context; never inject full graph.json or full GRAPH_REPORT.md.",',
    "    }),",
    "  );",
    "}",
    "",
  ].join("\n");
}

export function buildCodexProjectHooksJson({
  graphifyHookPath = ".codex/hooks/graphify-context.mjs",
  memoryHookPath = ".codex/hooks/meta-kim-memory-save.mjs",
  spineHookPath = ".codex/hooks/activate-meta-theory-spine.mjs",
  enforceAgentDispatchHookPath = ".codex/hooks/enforce-agent-dispatch.mjs",
  hookPromptAdapterPath = null,
  planningContinuityHookPath = ".codex/hooks/planning-continuity.mjs",
  stopSpineCleanupHookPath = ".codex/hooks/stop-spine-cleanup.mjs",
  packageRoot = null,
} = {}) {
  const config = buildCodexHooksJson({
    graphifyHookPath,
    memoryHookPath,
    spineHookPath,
    enforceAgentDispatchHookPath,
    hookPromptAdapterPath,
    planningContinuityHookPath,
    stopSpineCleanupHookPath,
    packageRoot,
  });
  config.hooks.PostToolUse = [
    ...(config.hooks.PostToolUse ?? []),
    {
      matcher: "Edit|Write",
      hooks: [
        hookCommand(nodeHookCommand(planningContinuityHookPath, [
          "--event", "post-tool", "--runtime", "codex",
        ]), 10),
        hookCommand(nodeHookCommand(".codex/hooks/post-format.mjs")),
        hookCommand(nodeHookCommand(".codex/hooks/post-typecheck.mjs")),
        hookCommand(nodeHookCommand(".codex/hooks/post-console-log-warn.mjs")),
      ],
    },
  ];
  config.hooks.SubagentStart = [
    ...(config.hooks.SubagentStart ?? []),
    {
      matcher: "*",
      hooks: [hookCommand(nodeHookCommand(".codex/hooks/subagent-context.mjs"))],
    },
  ];
  const baseStopHooks = (config.hooks.Stop ?? [])
    .flatMap((entry) => entry.hooks ?? []);
  const lifecycleCleanupHooks = baseStopHooks.filter((hook) =>
    hook.command?.includes("stop-spine-cleanup.mjs"),
  );
  const orderedStopHooks = [
    ...baseStopHooks.filter((hook) =>
      !hook.command?.includes("stop-spine-cleanup.mjs"),
    ),
    hookCommand(nodeHookCommand(".codex/hooks/stop-compaction.mjs")),
    hookCommand(nodeHookCommand(".codex/hooks/stop-console-log-audit.mjs")),
    hookCommand(nodeHookCommand(".codex/hooks/stop-completion-guard.mjs")),
    ...lifecycleCleanupHooks,
  ];
  const seenStopCommands = new Set();
  config.hooks.Stop = [{
    matcher: "*",
    hooks: orderedStopHooks.filter((hook) => {
      if (!hook?.command || seenStopCommands.has(hook.command)) return false;
      seenStopCommands.add(hook.command);
      return true;
    }),
  }];
  return config;
}

export function buildCursorProjectHooksJson({
  graphifyHookPath = ".cursor/hooks/graphify-context.mjs",
  memoryHookPath = null,
  spineHookPath = ".cursor/hooks/activate-meta-theory-spine.mjs",
  enforceAgentDispatchHookPath = ".cursor/hooks/enforce-agent-dispatch.mjs",
  hookPromptAdapterPath = null,
  planningContinuityHookPath = null,
  packageRoot = null,
} = {}) {
  const config = buildCursorHooksJson({
    graphifyHookPath,
    memoryHookPath,
    spineHookPath,
    enforceAgentDispatchHookPath,
    hookPromptAdapterPath,
    planningContinuityHookPath,
    packageRoot,
  });
  config.hooks.postToolUse = [
    ...(config.hooks.postToolUse ?? []),
    {
      command: nodeHookCommand(".cursor/hooks/post-format.mjs"),
      matcher: "Edit|Write",
    },
    {
      command: nodeHookCommand(".cursor/hooks/post-typecheck.mjs"),
      matcher: "Edit|Write",
    },
    {
      command: nodeHookCommand(".cursor/hooks/post-console-log-warn.mjs"),
      matcher: "Edit|Write",
    },
  ];
  config.hooks.subagentStart = [
    ...(config.hooks.subagentStart ?? []),
    {
      command: nodeHookCommand(".cursor/hooks/subagent-context.mjs"),
    },
  ];
  config.hooks.stop = [
    ...(config.hooks.stop ?? []),
    { command: nodeHookCommand(".cursor/hooks/stop-compaction.mjs") },
    { command: nodeHookCommand(".cursor/hooks/stop-console-log-audit.mjs") },
    { command: nodeHookCommand(".cursor/hooks/stop-completion-guard.mjs") },
    { command: nodeHookCommand(".cursor/hooks/stop-spine-cleanup.mjs") },
  ];
  return config;
}

async function syncRuntimeSkills(
  runtimeId,
  runtimeSkillsDir,
  displaySkillsDir,
  canonicalSkills,
  changedFiles,
) {
  const runtimeSkills = canonicalSkills.filter((skill) =>
    PROJECT_RUNTIME_SKILL_IDS.has(skill.id),
  );
  await pruneNonProjectedRuntimeSkills(
    runtimeSkillsDir,
    displaySkillsDir,
    canonicalSkills,
    changedFiles,
  );
  for (const skill of runtimeSkills) {
    for (const file of skill.files) {
      const targetPath = path.join(
        runtimeSkillsDir,
        skill.id,
        ...file.relativePath.split("/"),
      );
      const runtimeContent =
        runtimeId === "codex" && file.relativePath === "SKILL.md"
          ? buildCodexSkillContent(applyRuntimePaths(file.content, runtimeId))
          : applyRuntimePaths(file.content, runtimeId);
      if (
        (
          await writeGeneratedFile(
            targetPath,
            runtimeContent,
          )
        ).changed
      ) {
        changedFiles.push(
          `${displaySkillsDir}/${skill.id}/${file.relativePath}`,
        );
      }
    }
  }
}

function isRepoLocalPath(filePath) {
  const rel = path.relative(repoRoot, filePath);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function pruneNonProjectedRuntimeSkills(
  runtimeSkillsDir,
  displaySkillsDir,
  canonicalSkills,
  changedFiles,
) {
  if (!isRepoLocalPath(runtimeSkillsDir)) return;
  for (const skill of canonicalSkills) {
    if (PROJECT_RUNTIME_SKILL_IDS.has(skill.id)) continue;
    const targetPath = path.join(runtimeSkillsDir, skill.id);
    try {
      const stat = await fs.stat(targetPath);
      if (!stat.isDirectory()) continue;
      if (!checkOnly) {
        await fs.rm(targetPath, { recursive: true, force: true });
      }
      changedFiles.push(`${displaySkillsDir}/${skill.id}`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

// Whitelists of Meta_Kim-managed hook files per platform. Used to identify
// and replace or prune generated hook files before rendering the current
// project/global runtime projection. Files NOT on the whitelist
// (i.e. user-authored files) are never touched.
const CLAUDE_PROJECT_HOOK_FILES = new Set([
  "project-root.mjs",
  "utils.mjs",
  "skip-reminder.mjs",
  "conversation-binding.mjs",
  "spine-state-utils.mjs",
  "spine-state-gates.mjs",
  "spine-state.mjs",
  "activate-meta-theory-spine.mjs",
  "planning-continuity.mjs",
  "bash-readonly-whitelist.mjs",
  "block-dangerous-bash.mjs",
  "ecc-permission-cache-wrapper.mjs",
  "enforce-agent-dispatch.mjs",
  "graphify-context.mjs",
  "hook-i18n.mjs",
  "meta-kim-memory-save.mjs",
  "post-format.mjs",
  "post-typecheck.mjs",
  "post-console-log-warn.mjs",
  "subagent-context.mjs",
  "stop-compaction.mjs",
  "stop-memory-save.mjs",
  "stop-console-log-audit.mjs",
  "stop-completion-guard.mjs",
  "stop-save-progress.mjs",
  "stop-spine-cleanup.mjs",
]);

// Codex uses an adapter pattern (.mjs script + .py wrapper). Project-level
// files match the same basename as global hooks dir.
const CODEX_PROJECT_HOOK_FILES = new Set([
  "project-root.mjs",
  "utils.mjs",
  "skip-reminder.mjs",
  "conversation-binding.mjs",
  "spine-state-utils.mjs",
  "spine-state-gates.mjs",
  "spine-state.mjs",
  "activate-meta-theory-spine.mjs",
  "bash-readonly-whitelist.mjs",
  "codex_hook_adapter.py",
  "codex_hook_runner.mjs",
  "enforce-agent-dispatch.mjs",
  "graphify-context.mjs",
  "hook-i18n.mjs",
  "hookprompt-adapter.mjs",
  "meta-kim-memory-save.mjs",
  "planning-with-files-adapter.mjs",
  "post_tool_use.py",
  "post-tool-use.sh",
  "pre_tool_use.py",
  "pre-tool-use.sh",
  "pre-compact.sh",
  "session_start.py",
  "session-start.sh",
  "stop.py",
  "stop.sh",
  "user_prompt_submit.py",
  "user-prompt-submit.sh",
  "permission_request.py",
  "resolve-plan-dir.sh",
]);

const CODEX_ACTIVE_PROJECT_HOOK_FILES = new Set([
  "project-root.mjs",
  "utils.mjs",
  "skip-reminder.mjs",
  "conversation-binding.mjs",
  "spine-state-utils.mjs",
  "spine-state-gates.mjs",
  "spine-state.mjs",
  "activate-meta-theory-spine.mjs",
  "planning-continuity.mjs",
  "bash-readonly-whitelist.mjs",
  "enforce-agent-dispatch.mjs",
  "graphify-context.mjs",
  "meta-kim-memory-save.mjs",
  "post-console-log-warn.mjs",
  "post-format.mjs",
  "post-typecheck.mjs",
  "stop-compaction.mjs",
  "stop-completion-guard.mjs",
  "stop-console-log-audit.mjs",
  "stop-spine-cleanup.mjs",
  "subagent-context.mjs",
]);

// Cursor hook files (.ps1/.sh variants under ~/.cursor/hooks/).
const CURSOR_PROJECT_HOOK_FILES = new Set([
  "project-root.mjs",
  "utils.mjs",
  "skip-reminder.mjs",
  "conversation-binding.mjs",
  "spine-state-utils.mjs",
  "spine-state-gates.mjs",
  "spine-state.mjs",
  "activate-meta-theory-spine.mjs",
  "bash-readonly-whitelist.mjs",
  "enforce-agent-dispatch.mjs",
  "graphify-context.mjs",
  "hook-i18n.mjs",
  "hookprompt-adapter.mjs",
  "meta-kim-memory-save.mjs",
  "planning-with-files-adapter.mjs",
  "post-tool-use.ps1",
  "post-tool-use.sh",
  "pre-tool-use.ps1",
  "pre-tool-use.sh",
  "stop.ps1",
  "stop.sh",
  "user-prompt-submit.ps1",
  "user-prompt-submit.sh",
]);

const CURSOR_ACTIVE_PROJECT_HOOK_FILES = new Set([
  "project-root.mjs",
  "utils.mjs",
  "skip-reminder.mjs",
  "conversation-binding.mjs",
  "spine-state-utils.mjs",
  "spine-state-gates.mjs",
  "spine-state.mjs",
  "activate-meta-theory-spine.mjs",
  "bash-readonly-whitelist.mjs",
  "enforce-agent-dispatch.mjs",
  "graphify-context.mjs",
  "post-console-log-warn.mjs",
  "post-format.mjs",
  "post-typecheck.mjs",
  "stop-compaction.mjs",
  "stop-completion-guard.mjs",
  "stop-console-log-audit.mjs",
  "stop-spine-cleanup.mjs",
  "subagent-context.mjs",
]);

const OPENCLAW_PROJECT_HOOK_FILES = new Set([
  "HOOK.md",
  "handler.ts",
  "stop-save-progress.mjs",
]);

// Map from platform id to whitelist for project-level hook cleanup.
const PROJECT_HOOK_FILES_BY_PLATFORM = {
  claude: CLAUDE_PROJECT_HOOK_FILES,
  codex: CODEX_PROJECT_HOOK_FILES,
  cursor: CURSOR_PROJECT_HOOK_FILES,
  openclaw: OPENCLAW_PROJECT_HOOK_FILES,
};

// Remove retired install-projection hooks only when manifest + current hash
// prove exact ownership. Runtime-sedimented project copies and user files are
// independent project assets and must survive install/global dependency sync.
async function removeProjectMetaKimHooks(hooksDir, platformId, options = {}) {
  const whitelist = PROJECT_HOOK_FILES_BY_PLATFORM[platformId];
  if (!whitelist || !hooksDir) return [];
  const keep = options.keep ?? null;
  let entries;
  try {
    entries = await fs.readdir(hooksDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!whitelist.has(entry.name)) continue;
    if (keep?.has(entry.name)) continue;
    const target = path.join(hooksDir, entry.name);
    try {
      const result = await removeExactlyOwnedProjectionFile(target);
      if (result.changed) removed.push(entry.name);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(
          `[Meta_Kim] Failed to remove ${platformId} hook ${entry.name}: ${error.message}`,
        );
      }
    }
  }
  if (removed.length > 0 && !checkOnly) {
    console.log(
      `[Meta_Kim] Removed ${removed.length} Meta_Kim ${platformId} hook file(s) from ${hooksDir}`,
    );
  }
  return removed;
}

async function syncClaudeProjection(
  dirs,
  agents,
  canonicalSkills,
  changedFiles,
) {
  const {
    claudeAgentsProjectionDir,
    claudeSkillsProjectionDir,
    claudeHooksProjectionDir,
    claudeCommandsDir,
    claudeSettingsProjectionPath,
    claudeMcpProjectionPath,
    displayPaths,
  } = dirs;
  const globalScope = dirs.scope === "global";
  const targetHasMetaRuntimeServer =
    typeof claudeMcpProjectionPath === "string" &&
    claudeMcpProjectionPath.includes(repoRoot);
  if (globalScope) {
    await syncGlobalHookPackage(
      claudeHooksProjectionDir,
      displayPaths.claudeHooks,
      changedFiles,
      "claude",
    );
  }

  for (const agent of agents) {
    if (
      (
        await writeGeneratedFile(
          path.join(claudeAgentsProjectionDir, `${agent.id}.md`),
          agent.raw,
        )
      ).changed
    ) {
      changedFiles.push(`${displayPaths.claudeAgents}/${agent.id}.md`);
    }
  }

  await syncRuntimeSkills(
    "claude",
    claudeSkillsProjectionDir,
    displayPaths.claudeSkills,
    canonicalSkills,
    changedFiles,
  );

  for (const command of await collectCommandFiles(canonicalClaudeCommandsDir)) {
    if (
      (
        await writeGeneratedFile(
          path.join(claudeCommandsDir, command.name),
          command.content,
        )
      ).changed
    ) {
      changedFiles.push(`${displayPaths.claudeCommands}/${command.name}`);
    }
  }

  if (!globalScope) {
    const hookEntries = (
      await fs.readdir(canonicalClaudeHooksDir, { withFileTypes: true })
    )
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".mjs") &&
          PROJECT_CLAUDE_HOOK_FILES.has(entry.name) &&
          !SHARED_RUNTIME_HOOK_FILES.includes(entry.name),
      )
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const hookEntry of hookEntries) {
      const hookContent = await fs.readFile(
        path.join(canonicalClaudeHooksDir, hookEntry.name),
        "utf8",
      );
      if (
        (
          await writeGeneratedFile(
            path.join(claudeHooksProjectionDir, hookEntry.name),
            hookContent,
          )
        ).changed
      ) {
        changedFiles.push(`${displayPaths.claudeHooks}/${hookEntry.name}`);
      }
    }

    const sharedClaudeHookDependencies = SHARED_RUNTIME_HOOK_FILES;
    for (const hookName of sharedClaudeHookDependencies) {
      const hookContent = await tryReadCanonical(
        path.join(canonicalRuntimeAssetsDir, "shared", "hooks", hookName),
      );
      if (
        hookContent &&
        (
          await writeGeneratedFile(
            path.join(claudeHooksProjectionDir, hookName),
            hookContent,
          )
        ).changed
      ) {
        changedFiles.push(`${displayPaths.claudeHooks}/${hookName}`);
      }
    }

    if (!globalScope) {
      for (const hookName of REMOVED_PROJECT_CLAUDE_HOOK_FILES) {
        if (
          (await removeGeneratedPath(path.join(claudeHooksProjectionDir, hookName)))
            .changed
        ) {
          changedFiles.push(`${displayPaths.claudeHooks}/${hookName}`);
        }
      }
    }
  }

  const [settingsContent, mcpContent] = await Promise.all([
    fs.readFile(canonicalClaudeSettingsPath, "utf8"),
    fs.readFile(canonicalClaudeMcpPath, "utf8"),
  ]);

  // Merge into existing settings.json — never blind overwrite (project + global).
  let finalSettingsContent;
  const canonicalParsed = JSON.parse(settingsContent);

  if (!globalScope) {
    let base = {};
    try {
      const prev = await fs.readFile(claudeSettingsProjectionPath, "utf8");
      base = JSON.parse(prev);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const merged = mergeRepoClaudeSettings(base, canonicalParsed, repoRoot);
    finalSettingsContent = `${JSON.stringify(merged, null, 2)}\n`;
  } else {
    let base = {};
    try {
      const prev = await fs.readFile(claudeSettingsProjectionPath, "utf8");
      base = JSON.parse(prev);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const globalClaudeMetaKimHooksDir = path.join(
      resolveRuntimeHomeDir("claude"),
      "hooks",
      "meta-kim",
    );
    const template = buildMetaKimHooksTemplate(globalClaudeMetaKimHooksDir);
    const merged = mergeGlobalMetaKimHooksIntoSettings(base, template);
    finalSettingsContent = `${JSON.stringify(merged, null, 2)}\n`;
  }

  if (
    (
      await writeGeneratedFile(
        claudeSettingsProjectionPath,
        finalSettingsContent,
      )
    ).changed
  ) {
    changedFiles.push(displayPaths.claudeSettings);
  }
  if (claudeMcpProjectionPath) {
    // Only write meta-kim-runtime MCP config when the target contains the
    // server script; writing that command elsewhere breaks MCP startup.
    if (targetHasMetaRuntimeServer) {
      const renderedMcpContent = renderMetaKimRuntimeMcp(mcpContent, repoRoot);
      let existingMcpRaw = null;
      try {
        existingMcpRaw = await fs.readFile(claudeMcpProjectionPath, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      const finalMcpContent = existingMcpRaw
        ? mergeUserMcpServers(renderedMcpContent, existingMcpRaw)
        : renderedMcpContent;
      if (
        (await writeGeneratedFile(claudeMcpProjectionPath, finalMcpContent))
          .changed
      ) {
        changedFiles.push(displayPaths.claudeMcp);
      }
    } else {
      if (
        (
          await writeGeneratedFile(
            claudeMcpProjectionPath,
            emptyMcpConfigContent(),
          )
        ).changed
      ) {
        changedFiles.push(displayPaths.claudeMcp);
      }
    }
  }
}

async function main() {
  // ── Help ────────────────────────────────────────────────────────
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    console.log(`Usage: node sync-runtimes.mjs [options]

Options:
  --scope <project|global|both>  Write projection to repo (default: project)
  --targets <ids>                 Comma-separated runtime IDs (claude,codex,openclaw,cursor)
  --global-assets <types>         Profile-declared asset families to write in global scope
  --lang <code>                   Messages: en | zh-CN | ja-JP | ko-KR (aliases: zh, ja, ko)
  --check                        Show what would be synced without writing
  --reverse                      Reverse sync: runtime -> canonical (collect evolution signals)
  --dry-run                      Preview reverse sync changes without writing
  --approval <file>              Exact Warden approval v0.2 for reverse-sync candidates
  --candidate-output <file>      Write exact reverse-sync candidates plus an approval template
  --apply                        Apply only exact approval-bound reverse-sync candidates
  --force                        Include approved conflicts; never substitutes for approval
  --help, -h                     Show this help

Scopes:
  project  Write to repo-local directories (.claude/, .codex/, openclaw/)
  global  Write directly to runtime home dirs (${resolveRuntimeHomeDir("claude")}, etc.)
  both    Write to both locations

Examples:
  node sync-runtimes.mjs                        # project scope (default)
  node sync-runtimes.mjs --scope global        # write to ~/.claude, ~/.codex, ~/.openclaw
  node sync-runtimes.mjs --scope global --targets claude  # Claude Code only, global
  node sync-runtimes.mjs --check                # preview changes
  node sync-runtimes.mjs --reverse              # collect candidate-only evolution signals
  node sync-runtimes.mjs --reverse --dry-run    # preview reverse sync
  node sync-runtimes.mjs --reverse --force      # still candidate-only without approval
  node sync-runtimes.mjs --reverse --candidate-output reverse-candidates.json
  node sync-runtimes.mjs --reverse --approval approval.json --apply
`);
    return;
  }

  const scope = parseScopeArg(cliArgs);
  const targetContext = await resolveTargetContext(cliArgs);
  runtimeProfilesForSync = targetContext.profiles;
  syncScopeForWritePlan = scope;
  const globalOnlyProjectSync =
    scope === "project" &&
    targetContext.cliTargets.length === 0 &&
    targetContext.localOverrides.projectProjectionMode === "global_only";
  const selectedTargets = globalOnlyProjectSync ? [] : targetContext.activeTargets;
  requestedGlobalAssetTypes = parseGlobalAssetTypesArg(
    cliArgs,
    runtimeProfilesForSync,
    selectedTargets,
  );
  if (requestedGlobalAssetTypes !== null && syncScopeForWritePlan !== "global") {
    throw new Error("--global-assets can only be used with --scope global");
  }
  globalProjectionRecordDescriptors = syncScopeForWritePlan === "global"
    ? buildGlobalProjectionRecordDescriptors(selectedTargets)
    : [];
  const dirs = resolveProjectionDirs(scope);
  const agents = await loadCanonicalAgents();
  canonicalAgentsForGlobalOnly = agents;
  const teamDirectory = buildWorkspaceDirectory(agents);
  const canonicalSkills = await loadCanonicalSkills();
  const changedFiles = [];

  // Safety assertion: all writes must stay within allowedRoots
  if (!checkOnly) {
    assertHomeBound(dirs.claudeAgentsProjectionDir, dirs.allowedRoots);
    assertHomeBound(dirs.claudeCommandsDir, dirs.allowedRoots);
    if (dirs.codexConfigPath) {
      assertHomeBound(dirs.codexConfigPath, dirs.allowedRoots);
    }
    if (dirs.claudeMcpProjectionPath) {
      assertHomeBound(dirs.claudeMcpProjectionPath, dirs.allowedRoots);
    }
  }

  // Every scope records its own actual projection writes into the shared
  // ownership ledger. The recorder performs a lock-backed merge so this
  // global writer preserves records emitted by sync-global-meta-theory.mjs.
  if (!checkOnly && (scope === "project" || scope === "both" || scope === "global")) {
    manifestScope = scope === "global" ? "global" : "project";
    if (manifestScope === "project") {
      projectManifestAtStart = readManifest(manifestPathFor("project", repoRoot));
      runtimeSedimentedProjectPaths = await loadRuntimeSedimentedProjectPaths(repoRoot);
    }
    manifestRecorder = openRecorder({
      scope: manifestScope,
      repoRoot: manifestScope === "project" ? repoRoot : undefined,
      metaKimVersion:
        process.env.META_KIM_VERSION ??
        JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8")).version,
    });
  } else if (scope === "project" || scope === "both") {
    projectManifestAtStart = readManifest(manifestPathFor("project", repoRoot));
    runtimeSedimentedProjectPaths = await loadRuntimeSedimentedProjectPaths(repoRoot);
  }

  // ── Reverse Mode: Runtime -> Canonical signal propagation ─────────────
  if (reverseMode) {
    if (reverseApprovalArgIndex >= 0 && !reverseApprovalPath) {
      throw new Error("--approval requires a packet file");
    }
    if (reverseCandidateOutputArgIndex >= 0 && !reverseCandidateOutputPath) {
      throw new Error("--candidate-output requires a file path");
    }
    const reverseResult = await executeReverseSync(dirs, selectedTargets);

    // After reverse sync, optionally run forward sync to propagate updates
    // only after an exact-bound canonical batch was actually applied.
    if (!dryRun && reverseResult.applied) {
      console.log("");
      console.log(t.reverseModePropagating);
      // Continue to forward sync below
    } else {
      return reverseResult.signals;
    }
  }

  await syncCapabilityIndexMirrors(
    dirs,
    selectedTargets.filter((targetId) =>
      shouldSyncRuntimeAsset(targetId, "capabilityIndex", scope),
    ),
    changedFiles,
  );

  // `global_only` suppresses durable project agents/skills/commands, but the
  // repo-local governance hook package still has to remain internally
  // resolvable. Keep the three hook-capable project mirrors paired with the
  // same shared dependencies (especially activate-meta-theory-spine.mjs +
  // project-root.mjs). This is deliberately narrower than selecting a runtime:
  // it does not materialize agents, skills, commands, rules, or MCP config.
  if (globalOnlyProjectSync) {
    const runtimeHookTargets = [
      {
        runtime: "claude",
        hooksDir: dirs.claudeHooksProjectionDir,
        display: dirs.displayPaths.claudeHooks,
        activeFiles: new Set([
          ...PROJECT_CLAUDE_HOOK_FILES,
          ...SHARED_RUNTIME_HOOK_FILES,
        ]),
      },
      {
        runtime: "codex",
        hooksDir: dirs.codexHooksDir,
        display: dirs.displayPaths.codexHooks,
        activeFiles: CODEX_ACTIVE_PROJECT_HOOK_FILES,
      },
      {
        runtime: "cursor",
        hooksDir: dirs.cursorHooksDir,
        display: dirs.displayPaths.cursorHooks,
        activeFiles: CURSOR_ACTIVE_PROJECT_HOOK_FILES,
      },
    ];

    for (const target of runtimeHookTargets) {
      for (const hookName of target.activeFiles) {
        const hookSource = await canonicalGlobalHookSource(
          hookName,
          target.runtime,
        );
        if (!hookSource) {
          throw new Error(
            `Missing canonical Hook source owner for ${target.runtime}:${hookName}`,
          );
        }
        const hookContent = await tryReadCanonical(hookSource);
        if (
          hookContent &&
          (
            await writeGeneratedFile(
              path.join(target.hooksDir, hookName),
              hookContent,
            )
          ).changed
        ) {
          changedFiles.push(`${target.display}/${hookName}`);
        }
      }

      const preservedFiles = new Set([
        ...target.activeFiles,
        ...PRESERVED_UNOWNED_LEGACY_PROJECT_HOOK_FILES,
      ]);
      const removedHooks = await removeProjectMetaKimHooks(
        target.hooksDir,
        target.runtime,
        { keep: preservedFiles },
      );
      for (const hookName of removedHooks) {
        changedFiles.push(`${target.display}/${hookName}`);
      }
    }

    await enforceGlobalOnlyProjectShape(changedFiles);
  }

  if (
    selectedTargets.includes("claude") &&
    shouldRunRuntimeProjectionBranch("claude", scope)
  ) {
    await syncClaudeProjection(
      dirs,
      agents,
      canonicalSkills,
      changedFiles,
    );
  }

  if (
    selectedTargets.includes("openclaw") &&
    shouldRunRuntimeProjectionBranch("openclaw", scope)
  ) {
    const dp = dirs.displayPaths;

    for (const agent of agents) {
      const workspaceDir = dirs.openclawWorkspaceDir(agent.id);
      const heartbeatContent = await buildHeartbeat(agent);
      const workspaceContent = new Map([
        ["BOOT.md", buildBoot(agent)],
        ["BOOTSTRAP.md", buildBootstrap(agent)],
        ["IDENTITY.md", buildIdentity(agent)],
        ["MEMORY.md", buildMemory(agent)],
        ["USER.md", buildUser()],
        ["SOUL.md", buildSoul(agent)],
        ["AGENTS.md", teamDirectory],
        ["HEARTBEAT.md", heartbeatContent],
        ["TOOLS.md", buildTools(agent, agents)],
      ]);
      const writes = await Promise.all(
        OPENCLAW_WORKSPACE_FILE_NAMES.map((fileName) =>
          writeGeneratedFile(
            path.join(workspaceDir, fileName),
            workspaceContent.get(fileName),
          )
        ),
      );

      if (writes.some((result) => result.changed)) {
        changedFiles.push(dirs.openclawDisplayWorkspaceDir(agent.id));
      }
    }

    // Gracefully handle missing openclaw.template.json (can happen when running
    // via npx with an older cached package version that doesn't include it)
    let templateConfig = null;
    const templateRaw = await tryReadCanonical(canonicalOpenClawTemplatePath);
    if (templateRaw) {
      templateConfig = JSON.parse(templateRaw);
    }

    if (templateConfig !== null) {
      const renderedTemplateRaw = renderMetaKimRuntimeMcp(
        JSON.stringify(templateConfig),
        repoRoot,
      );
      templateConfig = JSON.parse(renderedTemplateRaw);
    }

    if (
      templateConfig !== null &&
      (
        await writeGeneratedJson(
          dirs.openclawTemplateConfigPath,
          templateConfig,
        )
      ).changed
    ) {
      changedFiles.push(dp.openclawTemplate);
    }

    const openclawInRepoRoot =
      dirs.openclawTemplateConfigPath?.includes(repoRoot);
    if (openclawInRepoRoot) {
      const removedOpenclawRootHooks = await removeProjectMetaKimHooks(
        dirs.openclawHooksDir,
        "openclaw",
      );
      for (const hookName of removedOpenclawRootHooks) {
        changedFiles.push(`${dp.openclawHooks}/${hookName}`);
      }
      const removedOpenclawHooks = await removeProjectMetaKimHooks(
        path.join(dirs.openclawHooksDir, "mcp-memory-service"),
        "openclaw",
      );
      for (const hookName of removedOpenclawHooks) {
        changedFiles.push(`${dp.openclawHooks}/mcp-memory-service/${hookName}`);
      }
      if (
        (await removeDirIfEmpty(path.join(dirs.openclawHooksDir, "mcp-memory-service")))
          .changed
      ) {
        changedFiles.push(`${dp.openclawHooks}/mcp-memory-service`);
      }
      if ((await removeDirIfEmpty(dirs.openclawHooksDir)).changed) {
        changedFiles.push(dp.openclawHooks);
      }
    } else {
      let openclawHookEntries = [];
      try {
        openclawHookEntries = await fs.readdir(canonicalOpenClawMemoryHookDir, {
          withFileTypes: true,
        });
      } catch {
        openclawHookEntries = [];
      }
      for (const hookEntry of openclawHookEntries) {
        if (!hookEntry.isFile()) continue;
        const hookContent = await tryReadCanonical(
          path.join(canonicalOpenClawMemoryHookDir, hookEntry.name),
        );
        if (
          hookContent &&
          (
            await writeGeneratedFile(
              path.join(
                dirs.openclawHooksDir,
                "mcp-memory-service",
                hookEntry.name,
              ),
              hookContent,
            )
          ).changed
        ) {
          changedFiles.push(
            `${dp.openclawHooks}/mcp-memory-service/${hookEntry.name}`,
          );
        }
      }
      const stopSaveProgressHook = await tryReadCanonical(
        canonicalOpenClawStopSaveProgressHookPath,
      );
      if (
        stopSaveProgressHook &&
        (
          await writeGeneratedFile(
            path.join(dirs.openclawHooksDir, "stop-save-progress.mjs"),
            stopSaveProgressHook,
          )
        ).changed
      ) {
        changedFiles.push(`${dp.openclawHooks}/stop-save-progress.mjs`);
      }
    }

    if ((await removeGeneratedPath(dirs.openclawLegacySkillFile)).changed) {
      changedFiles.push("openclaw/skills/meta-theory.md");
    }
    if (
      (await removeGeneratedPath(dirs.openclawLegacySkillReferencesDir)).changed
    ) {
      changedFiles.push("openclaw/skills/references");
    }
    await syncRuntimeSkills(
      "openclaw",
      dirs.openclawSkillsDir,
      dp.openclawSkillsRoot,
      canonicalSkills,
      changedFiles,
    );
  }

  if (
    selectedTargets.includes("codex") &&
    shouldRunRuntimeProjectionBranch("codex", scope)
  ) {
    const dp = dirs.displayPaths;

    if ((await removeGeneratedPath(dirs.codexLegacySkillFile)).changed) {
      changedFiles.push(".codex/skills/meta-theory.md");
    }
    if (
      (await removeGeneratedPath(dirs.codexLegacySkillReferencesDir)).changed
    ) {
      changedFiles.push(".codex/skills/references");
    }
    if ((await removeGeneratedPath(dirs.codexLegacySkillRoot)).changed) {
      changedFiles.push(".codex/skills/meta-theory");
    }
    if ((await removeDirIfEmpty(dirs.codexLegacySkillsDir)).changed) {
      changedFiles.push(".codex/skills");
    }

    await syncRuntimeSkills(
      "codex",
      dirs.codexSkillsDir,
      dp.codexSkillsRoot,
      canonicalSkills,
      changedFiles,
    );
    const codexConfigExample = await tryReadCanonical(
      canonicalCodexConfigExamplePath,
    );
    if (
      codexConfigExample &&
      (
        await writeGeneratedFile(
          dirs.codexConfigExamplePath,
          codexConfigExample,
        )
      ).changed
    ) {
      changedFiles.push(dp.codexConfigExample);
    }
    if (dirs.codexConfigPath && codexConfigExample) {
      let currentCodexConfig = null;
      try {
        currentCodexConfig = await fs.readFile(dirs.codexConfigPath, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      // Respect user-local override: if the local .codex/config.toml
      // carries a `# meta-kim: local-override` marker comment, the file
      // is intentionally divergent from the canonical template and
      // sync must not silently rewrite it. To regenerate from canonical,
      // remove the marker line.
      if (
        currentCodexConfig &&
        /meta-kim:\s*local-override/.test(currentCodexConfig)
      ) {
        // skip — file is intentionally divergent
      } else {
        const nextCodexConfig = buildCodexProjectConfig(
          currentCodexConfig,
          codexConfigExample,
        );
        if (
          (await writeGeneratedFile(dirs.codexConfigPath, nextCodexConfig))
            .changed
        ) {
          changedFiles.push(dp.codexConfig);
        }
      }
    }

    for (const command of await collectCommandFiles(canonicalCodexCommandsDir)) {
      if (
        (
          await writeGeneratedFile(
            path.join(dirs.codexCommandsDir, command.name),
            command.content,
          )
        ).changed
      ) {
        changedFiles.push(`${dp.codexCommands}/${command.name}`);
      }
    }

    if (dirs.codexHooksDir && dirs.codexHooksFile) {
      // Global-hooks migration: clear legacy files directly under
      // ~/.codex/hooks/ before writing the namespaced global package.
      if (scope === "global") {
        await removeProjectMetaKimHooks(path.dirname(dirs.codexHooksDir), "codex", {
          keep: new Set(["hookprompt-adapter.mjs"]),
        });
      }
      const removedCodexHooks = await removeProjectMetaKimHooks(
        dirs.codexHooksDir,
        "codex",
        {
          keep:
            scope === "global"
              ? GLOBAL_META_KIM_HOOK_PACKAGE_FILES
              : CODEX_ACTIVE_PROJECT_HOOK_FILES,
        },
      );
      for (const hookName of removedCodexHooks) {
        changedFiles.push(`${dp.codexHooks}/${hookName}`);
      }
      const codexGraphifyHookContent =
        scope === "global"
          ? await tryReadCanonical(
              path.join(canonicalRuntimeAssetsDir, "claude", "hooks", "graphify-context.mjs"),
            )
          : buildCodexGraphifyContextHook();
      if (
        codexGraphifyHookContent &&
        (
          await writeGeneratedFile(
            path.join(dirs.codexHooksDir, "graphify-context.mjs"),
            codexGraphifyHookContent,
          )
        ).changed
      ) {
        changedFiles.push(`${dp.codexHooks}/graphify-context.mjs`);
      }
      for (const hookName of [
        "project-root.mjs",
        "utils.mjs",
        "skip-reminder.mjs",
        "spine-state-utils.mjs",
        "spine-state-gates.mjs",
        "spine-state.mjs",
      ]) {
        const sourcePath = await canonicalGlobalHookSource(hookName, "codex");
        if (!sourcePath) {
          throw new Error(
            `Missing canonical Hook source for codex:${hookName}`,
          );
        }
        const hookContent = await fs.readFile(sourcePath, "utf8");
        if (
          (
            await writeGeneratedFile(
              path.join(dirs.codexHooksDir, hookName),
              hookContent,
            )
          ).changed
        ) {
          changedFiles.push(`${dp.codexHooks}/${hookName}`);
        }
      }
      const spineHookContent = await tryReadCanonical(canonicalSharedSpineHookPath);
      if (
        spineHookContent &&
        (
          await writeGeneratedFile(
            path.join(dirs.codexHooksDir, "activate-meta-theory-spine.mjs"),
            spineHookContent,
          )
        ).changed
      ) {
        changedFiles.push(`${dp.codexHooks}/activate-meta-theory-spine.mjs`);
      }
      // Sync the dispatch-enforcement gate + its bash-readonly classifier from
      // the Claude canonical hooks directory. These two files implement the
      // capability-first gate and meta-readonly contract; they share a deny()
      // shape that detects the host runtime at invocation time.
      const enforceDispatchHookContent = await tryReadCanonical(
        canonicalClaudeEnforceDispatchHookPath,
      );
      if (
        enforceDispatchHookContent &&
        (
          await writeGeneratedFile(
            path.join(dirs.codexHooksDir, "enforce-agent-dispatch.mjs"),
            enforceDispatchHookContent,
          )
        ).changed
      ) {
        changedFiles.push(`${dp.codexHooks}/enforce-agent-dispatch.mjs`);
      }
      const bashReadonlyWhitelistContent = await tryReadCanonical(
        canonicalClaudeBashReadonlyWhitelistPath,
      );
      if (
        bashReadonlyWhitelistContent &&
        (
          await writeGeneratedFile(
            path.join(dirs.codexHooksDir, "bash-readonly-whitelist.mjs"),
            bashReadonlyWhitelistContent,
          )
        ).changed
      ) {
        changedFiles.push(`${dp.codexHooks}/bash-readonly-whitelist.mjs`);
      }
      for (const hookName of [
        "meta-kim-memory-save.mjs",
        "stop-spine-cleanup.mjs",
      ]) {
        const sourcePath = await canonicalGlobalHookSource(hookName, "codex");
        if (!sourcePath) {
          throw new Error(`Missing canonical Hook source for codex:${hookName}`);
        }
        const hookContent = await fs.readFile(sourcePath, "utf8");
        if (
          (
            await writeGeneratedFile(
              path.join(dirs.codexHooksDir, hookName),
              hookContent,
            )
          ).changed
        ) {
          changedFiles.push(`${dp.codexHooks}/${hookName}`);
        }
      }
      if (scope === "global") {
        const codexHookPromptAdapterPath = path.join(
          path.dirname(dirs.codexHooksDir),
          "hookprompt-adapter.mjs",
        );
        if (
          (
            await writeGeneratedFile(
              codexHookPromptAdapterPath,
              buildHookPromptAdapterSource("codex"),
            )
          ).changed
        ) {
          changedFiles.push(`${path.dirname(dp.codexHooks)}/hookprompt-adapter.mjs`);
        }
      }
      const staleCodexHooks = [
        "hookprompt-adapter.mjs",
        "planning-with-files-adapter.mjs",
      ];
      for (const staleHook of staleCodexHooks) {
        if (
          (await removeGeneratedPath(path.join(dirs.codexHooksDir, staleHook)))
            .changed
        ) {
          changedFiles.push(`${dp.codexHooks}/${staleHook}`);
        }
      }
      if (scope === "global") {
        await syncGlobalHookPackage(dirs.codexHooksDir, dp.codexHooks, changedFiles, "codex");
      }
      const graphifyHookPath =
        scope === "global"
          ? path.join(dirs.codexHooksDir, "graphify-context.mjs")
          : ".codex/hooks/graphify-context.mjs";
      const spineHookPath =
        scope === "global"
          ? path.join(dirs.codexHooksDir, "activate-meta-theory-spine.mjs")
          : ".codex/hooks/activate-meta-theory-spine.mjs";
      const enforceAgentDispatchHookPath =
        scope === "global"
          ? path.join(dirs.codexHooksDir, "enforce-agent-dispatch.mjs")
          : ".codex/hooks/enforce-agent-dispatch.mjs";
      const codexMemoryHookPath =
        scope === "global"
          ? path.join(dirs.codexHooksDir, "meta-kim-memory-save.mjs")
          : ".codex/hooks/meta-kim-memory-save.mjs";
      const codexPlanningContinuityHookPath =
        scope === "global"
          ? path.join(dirs.codexHooksDir, "planning-continuity.mjs")
          : ".codex/hooks/planning-continuity.mjs";
      const codexHookPromptAdapterPath =
        scope === "global"
          ? path.join(path.dirname(dirs.codexHooksDir), "hookprompt-adapter.mjs")
          : null;
      const codexStopSpineCleanupHookPath =
        scope === "global"
          ? path.join(dirs.codexHooksDir, "stop-spine-cleanup.mjs")
          : ".codex/hooks/stop-spine-cleanup.mjs";
      if (
        (
          await writeGeneratedJson(
            dirs.codexHooksFile,
            buildCodexProjectHooksJson({
              graphifyHookPath,
              memoryHookPath: codexMemoryHookPath,
              spineHookPath,
              enforceAgentDispatchHookPath,
              hookPromptAdapterPath: codexHookPromptAdapterPath,
              planningContinuityHookPath: codexPlanningContinuityHookPath,
              stopSpineCleanupHookPath: codexStopSpineCleanupHookPath,
              packageRoot: repoRoot,
            }),
          )
        ).changed
      ) {
        changedFiles.push(dp.codexHooksFile);
      }
    }

    for (const agent of agents) {
      if (
        (
          await writeGeneratedFile(
            path.join(dirs.codexAgentsDir, `${agent.id}.toml`),
            buildCodexAgent(agent),
          )
        ).changed
      ) {
        changedFiles.push(`${dp.codexAgents}/${agent.id}.toml`);
      }
    }

  }

  // ── Cursor sync ───────────────────────────────────────────────
  if (
    selectedTargets.includes("cursor") &&
    shouldRunRuntimeProjectionBranch("cursor", scope)
  ) {
    const dp = dirs.displayPaths;

    // Agent projections (.cursor/agents/*.md)
    for (const agent of agents) {
      if (
        (
          await writeGeneratedFile(
            path.join(dirs.cursorAgentsDir, `${agent.id}.md`),
            buildCursorAgent(agent),
          )
        ).changed
      ) {
        changedFiles.push(`${dp.cursorAgents}/${agent.id}.md`);
      }
    }

    // Cursor MDC rules (.cursor/rules/*.mdc) — copied verbatim from
    // canonical/runtime-assets/cursor/rules/. Mirrors the agent-projection
    // pattern: each canonical .mdc file is fully overwritten in the runtime
    // mirror. Files only in the destination are left alone (no prune) —
    // matches buildCursorAgent semantics that only emit canonical-owned IDs.
    if (dirs.cursorRulesDir) {
      let cursorRuleEntries = [];
      try {
        cursorRuleEntries = await fs.readdir(canonicalCursorRulesDir, {
          withFileTypes: true,
        });
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      const sortedRuleEntries = cursorRuleEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".mdc"))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const ruleEntry of sortedRuleEntries) {
        const ruleContent = await tryReadCanonical(
          path.join(canonicalCursorRulesDir, ruleEntry.name),
        );
        if (
          ruleContent &&
          (
            await writeGeneratedFile(
              path.join(dirs.cursorRulesDir, ruleEntry.name),
              ruleContent,
            )
          ).changed
        ) {
          changedFiles.push(`${dp.cursorRules}/${ruleEntry.name}`);
        }
      }
    }

    // Skill projections (.cursor/skills/meta-theory/)
    await syncRuntimeSkills(
      "cursor",
      dirs.cursorSkillsDir,
      dp.cursorSkillsRoot,
      canonicalSkills,
      changedFiles,
    );

    if (
      dirs.cursorHooksDir &&
      dirs.cursorHooksFile &&
      shouldSyncRuntimeAsset("cursor", "hooks", scope)
    ) {
      // Global-hooks migration: clear legacy files directly under
      // ~/.cursor/hooks/ before writing the namespaced global package.
      if (scope === "global") {
        await removeProjectMetaKimHooks(path.dirname(dirs.cursorHooksDir), "cursor", {
          keep: new Set(["hookprompt-adapter.mjs"]),
        });
      }
      const removedCursorHooks = await removeProjectMetaKimHooks(
        dirs.cursorHooksDir,
        "cursor",
        {
          keep:
            scope === "global"
              ? GLOBAL_META_KIM_HOOK_PACKAGE_FILES
              : CURSOR_ACTIVE_PROJECT_HOOK_FILES,
        },
      );
      for (const hookName of removedCursorHooks) {
        changedFiles.push(`${dp.cursorHooks}/${hookName}`);
      }
      const cursorGraphifyHookContent =
        scope === "global"
          ? await tryReadCanonical(
              path.join(canonicalRuntimeAssetsDir, "claude", "hooks", "graphify-context.mjs"),
            )
          : buildCodexGraphifyContextHook();
      if (
        cursorGraphifyHookContent &&
        (
          await writeGeneratedFile(
            path.join(dirs.cursorHooksDir, "graphify-context.mjs"),
            cursorGraphifyHookContent,
          )
        ).changed
      ) {
        changedFiles.push(`${dp.cursorHooks}/graphify-context.mjs`);
      }
      for (const hookName of [
        "project-root.mjs",
        "utils.mjs",
        "skip-reminder.mjs",
        "spine-state-utils.mjs",
        "spine-state-gates.mjs",
        "spine-state.mjs",
      ]) {
        const sourcePath = await canonicalGlobalHookSource(hookName, "cursor");
        if (!sourcePath) {
          throw new Error(
            `Missing canonical Hook source for cursor:${hookName}`,
          );
        }
        const hookContent = await fs.readFile(sourcePath, "utf8");
        if (
          (
            await writeGeneratedFile(
              path.join(dirs.cursorHooksDir, hookName),
              hookContent,
            )
          ).changed
        ) {
          changedFiles.push(`${dp.cursorHooks}/${hookName}`);
        }
      }
      const cursorSpineHookContent = await tryReadCanonical(
        canonicalSharedSpineHookPath,
      );
      if (
        cursorSpineHookContent &&
        (
          await writeGeneratedFile(
            path.join(dirs.cursorHooksDir, "activate-meta-theory-spine.mjs"),
            cursorSpineHookContent,
          )
        ).changed
      ) {
        changedFiles.push(`${dp.cursorHooks}/activate-meta-theory-spine.mjs`);
      }
      // Sync the dispatch-enforcement gate + its bash-readonly classifier from
      // the Claude canonical hooks directory. deny() output adapts to Cursor's
      // official Cursor hook JSON schema at runtime via META_KIM_HOOK_RUNTIME / argv inspection.
      const cursorEnforceDispatchHookContent = await tryReadCanonical(
        canonicalClaudeEnforceDispatchHookPath,
      );
      if (
        cursorEnforceDispatchHookContent &&
        (
          await writeGeneratedFile(
            path.join(dirs.cursorHooksDir, "enforce-agent-dispatch.mjs"),
            cursorEnforceDispatchHookContent,
          )
        ).changed
      ) {
        changedFiles.push(`${dp.cursorHooks}/enforce-agent-dispatch.mjs`);
      }
      const cursorBashReadonlyWhitelistContent = await tryReadCanonical(
        canonicalClaudeBashReadonlyWhitelistPath,
      );
      if (
        cursorBashReadonlyWhitelistContent &&
        (
          await writeGeneratedFile(
            path.join(dirs.cursorHooksDir, "bash-readonly-whitelist.mjs"),
            cursorBashReadonlyWhitelistContent,
          )
        ).changed
      ) {
        changedFiles.push(`${dp.cursorHooks}/bash-readonly-whitelist.mjs`);
      }
      if (scope === "global") {
        const cursorHookPromptAdapterPath = path.join(
          path.dirname(dirs.cursorHooksDir),
          "hookprompt-adapter.mjs",
        );
        if (
          (
            await writeGeneratedFile(
              cursorHookPromptAdapterPath,
              buildHookPromptAdapterSource("cursor"),
            )
          ).changed
        ) {
          changedFiles.push(`${path.dirname(dp.cursorHooks)}/hookprompt-adapter.mjs`);
        }
      }
      const staleCursorHooks = [
        "hookprompt-adapter.mjs",
        "planning-with-files-adapter.mjs",
        ...(scope === "global" ? [] : ["meta-kim-memory-save.mjs"]),
      ];
      for (const staleHook of staleCursorHooks) {
        if (
          (await removeGeneratedPath(path.join(dirs.cursorHooksDir, staleHook)))
            .changed
        ) {
          changedFiles.push(`${dp.cursorHooks}/${staleHook}`);
        }
      }
      if (scope === "global") {
        await syncGlobalHookPackage(dirs.cursorHooksDir, dp.cursorHooks, changedFiles, "cursor");
      }
      const graphifyHookPath =
        scope === "global"
          ? path.join(dirs.cursorHooksDir, "graphify-context.mjs")
          : ".cursor/hooks/graphify-context.mjs";
      const spineHookPath =
        scope === "global"
          ? path.join(dirs.cursorHooksDir, "activate-meta-theory-spine.mjs")
          : ".cursor/hooks/activate-meta-theory-spine.mjs";
      const enforceAgentDispatchHookPath =
        scope === "global"
          ? path.join(dirs.cursorHooksDir, "enforce-agent-dispatch.mjs")
          : ".cursor/hooks/enforce-agent-dispatch.mjs";
      const cursorMemoryHookPath =
        scope === "global"
          ? path.join(dirs.cursorHooksDir, "meta-kim-memory-save.mjs")
          : null;
      const cursorHookPromptAdapterPath =
        scope === "global"
          ? path.join(path.dirname(dirs.cursorHooksDir), "hookprompt-adapter.mjs")
          : null;
      if (
        (
          await writeGeneratedJson(
            dirs.cursorHooksFile,
            buildCursorProjectHooksJson({
              graphifyHookPath,
              memoryHookPath: cursorMemoryHookPath,
              spineHookPath,
              enforceAgentDispatchHookPath,
              hookPromptAdapterPath: cursorHookPromptAdapterPath,
              packageRoot: repoRoot,
            }),
          )
        ).changed
      ) {
        changedFiles.push(dp.cursorHooksFile);
      }
    }

    // MCP config (.cursor/mcp.json) — reuse Claude's MCP template
    if (dirs.cursorMcpPath) {
      const mcpContent = await tryReadCanonical(canonicalClaudeMcpPath);
      const cursorInRepoRoot = dirs.cursorMcpPath.includes(repoRoot);
      const renderedMcpContent = cursorInRepoRoot
        ? renderMetaKimRuntimeMcp(mcpContent, repoRoot)
        : emptyMcpConfigContent();
      if (
        mcpContent &&
        (await writeGeneratedFile(dirs.cursorMcpPath, renderedMcpContent))
          .changed
      ) {
        changedFiles.push(dp.cursorMcp);
      }
    }
  }

  const sourceRepoProjectProjectionAbsent = checkOnly
    ? await expectedSourceRepoProjectProjectionAbsence(scope, staleFiles)
    : false;

  if (checkOnly && jsonMode) {
    const effectiveStaleFiles = sourceRepoProjectProjectionAbsent
      ? []
      : staleFiles;
    const byCategory = staleFiles.reduce((acc, f) => {
      const k = f.category || "unknown";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    const byAction = staleFiles.reduce((acc, f) => {
      acc[f.action] = (acc[f.action] || 0) + 1;
      return acc;
    }, {});
    process.stdout.write(
      `${JSON.stringify(
        {
          scope,
          targets: selectedTargets,
          status: sourceRepoProjectProjectionAbsent
            ? "source_repo_project_projections_absent"
            : staleFiles.length > 0
              ? "stale"
              : "ok",
          total: effectiveStaleFiles.length,
          byCategory: sourceRepoProjectProjectionAbsent ? {} : byCategory,
          byAction: sourceRepoProjectProjectionAbsent ? {} : byAction,
          sourceRepoProjectProjections: sourceRepoProjectProjectionAbsent
            ? {
                expectedAbsent: true,
                skippedStaleFiles: staleFiles.length,
                message: t.syncRuntimesCheckSourceRepoProjectionAbsent(
                  staleFiles.length,
                ),
              }
            : {
                expectedAbsent: false,
                skippedStaleFiles: 0,
              },
          staleFiles: effectiveStaleFiles,
        },
        null,
        2,
      )}\n`,
    );
    if (!sourceRepoProjectProjectionAbsent && staleFiles.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  if (checkOnly && changedFiles.length > 0) {
    if (sourceRepoProjectProjectionAbsent) {
      console.log(
        t.syncRuntimesCheckSourceRepoProjectionAbsent(staleFiles.length),
      );
      return;
    }
    console.error(t.syncRuntimesCheckStale);
    for (const file of changedFiles) {
      console.error(t.syncRuntimesCheckStaleLine(file));
    }
    process.exitCode = 1;
    return;
  }

  if (checkOnly) {
    if (selectedTargets.length === 0 && !globalOnlyProjectSync) {
      console.log(
        t.syncRuntimesCheckNoTargets ||
          "[meta:sync] 未选定 runtime target — projectProjectionMode=global_only 且未传 --targets。\n本次未检查任何镜像，\"已是最新\"结论不成立。\n检查项目投影：npm run meta:check:runtimes -- --scope project --targets claude,codex\n检查全局镜像：npm run meta:check:runtimes -- --scope global",
      );
      return;
    }
    console.log(t.syncRuntimesCheckOk);
    return;
  }

  const normalizeDisplayPath = (value) =>
    String(value ?? "").replace(/\\/g, "/");
  const hasDisplayPrefix = (targetPath, prefix) => {
    if (!prefix) {
      return false;
    }
    const normalizedTarget = normalizeDisplayPath(targetPath);
    const normalizedPrefix = normalizeDisplayPath(prefix);
    return (
      normalizedTarget === normalizedPrefix ||
      normalizedTarget.startsWith(`${normalizedPrefix}/`)
    );
  };

  const openclawWorkspacePrefix =
    scope === "global"
      ? normalizeDisplayPath(dirs.openclawWorkspaceDir(""))
      : normalizeDisplayPath(dirs.displayPaths.openclawWorkspaces);

  const layerCounts = {
    claudeAgents: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.claudeAgents),
    ).length,
    claudeSkill: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.claudeSkills),
    ).length,
    claudeHooks: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.claudeHooks),
    ).length,
    claudeCommands: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.claudeCommands),
    ).length,
    claudeSettings: changedFiles.filter(
      (f) =>
        normalizeDisplayPath(f) ===
        normalizeDisplayPath(dirs.displayPaths.claudeSettings),
    ).length,
    claudeMcp: changedFiles.filter(
      (f) =>
        dirs.displayPaths.claudeMcp &&
        normalizeDisplayPath(f) ===
          normalizeDisplayPath(dirs.displayPaths.claudeMcp),
    ).length,
    codexAgents: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.codexAgents),
    ).length,
    codexSkill: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.codexSkillsRoot),
    ).length,
    codexHooks: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.codexHooks),
    ).length,
    codexConfig: changedFiles.filter(
      (f) => {
        const normalized = normalizeDisplayPath(f);
        return (
          normalized === normalizeDisplayPath(dirs.displayPaths.codexConfig) ||
          normalized ===
            normalizeDisplayPath(dirs.displayPaths.codexConfigExample)
        );
      },
    ).length,
    codexHooksFile: changedFiles.filter(
      (f) =>
        normalizeDisplayPath(f) ===
        normalizeDisplayPath(dirs.displayPaths.codexHooksFile),
    ).length,
    openclawWorkspace: changedFiles.filter((f) =>
      normalizeDisplayPath(f).startsWith(openclawWorkspacePrefix),
    ).length,
    openclawSkill: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.openclawSkillsRoot),
    ).length,
    openclawHooks: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.openclawHooks),
    ).length,
    openclawTemplate: changedFiles.filter(
      (f) =>
        normalizeDisplayPath(f) ===
        normalizeDisplayPath(dirs.displayPaths.openclawTemplate),
    ).length,
    cursorAgents: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.cursorAgents),
    ).length,
    cursorSkill: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.cursorSkillsRoot),
    ).length,
    cursorHooks: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.cursorHooks),
    ).length,
    cursorHooksFile: changedFiles.filter(
      (f) =>
        normalizeDisplayPath(f) ===
        normalizeDisplayPath(dirs.displayPaths.cursorHooksFile),
    ).length,
    cursorMcp: changedFiles.filter(
      (f) =>
        normalizeDisplayPath(f) ===
        normalizeDisplayPath(dirs.displayPaths.cursorMcp),
    ).length,
    cursorRules: changedFiles.filter((f) =>
      hasDisplayPrefix(f, dirs.displayPaths.cursorRules),
    ).length,
  };

  const teamSize = agents.length;
  const groups = [
    {
      name: t.runtimeGroupClaude,
      entries: [
        {
          label: dirs.displayPaths.claudeAgents,
          count: layerCounts.claudeAgents,
          summaryKind: "agents",
        },
        {
          label: dirs.displayPaths.claudeSkills,
          count: layerCounts.claudeSkill,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.claudeHooks,
          count: layerCounts.claudeHooks,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.claudeCommands,
          count: layerCounts.claudeCommands,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.claudeSettings,
          count: layerCounts.claudeSettings,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.claudeMcp,
          count: layerCounts.claudeMcp,
          summaryKind: "files",
        },
      ],
    },
    {
      name: t.runtimeGroupCodex,
      entries: [
        {
          label: dirs.displayPaths.codexAgents,
          count: layerCounts.codexAgents,
          summaryKind: "agents",
          expectedCount: teamSize,
        },
        {
          label: dirs.displayPaths.codexSkillsRoot,
          count: layerCounts.codexSkill,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.codexHooks,
          count: layerCounts.codexHooks,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.codexHooksFile,
          count: layerCounts.codexHooksFile,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.codexConfig,
          count: layerCounts.codexConfig,
          summaryKind: "files",
        },
      ],
    },
    {
      name: t.runtimeGroupOpenclaw,
      entries: [
        {
          label: dirs.displayPaths.openclawWorkspaces,
          count: layerCounts.openclawWorkspace,
          summaryKind: "workspaces",
        },
        {
          label: dirs.displayPaths.openclawSkillsRoot,
          count: layerCounts.openclawSkill,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.openclawHooks,
          count: layerCounts.openclawHooks,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.openclawTemplate,
          count: layerCounts.openclawTemplate,
          summaryKind: "files",
        },
      ],
    },
    {
      name: t.runtimeGroupCursor,
      entries: [
        {
          label: dirs.displayPaths.cursorAgents,
          count: layerCounts.cursorAgents,
          summaryKind: "agents",
        },
        {
          label: dirs.displayPaths.cursorSkillsRoot,
          count: layerCounts.cursorSkill,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.cursorHooks,
          count: layerCounts.cursorHooks,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.cursorHooksFile,
          count: layerCounts.cursorHooksFile,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.cursorMcp,
          count: layerCounts.cursorMcp,
          summaryKind: "files",
        },
        {
          label: dirs.displayPaths.cursorRules,
          count: layerCounts.cursorRules,
          summaryKind: "files",
        },
      ],
    },
  ];

  // Dynamic path column width: base on the longest active label so short
  // entries (e.g. ".mcp.json") do not trail a wall of spaces. Bounded below
  // so single-entry runs still have breathing room, and above so pathological
  // long paths do not push detail off-screen.
  const activeLabels = groups.flatMap((g) =>
    g.entries.filter((e) => e.label && e.count > 0).map((e) => String(e.label)),
  );
  const longestLabel = activeLabels.reduce(
    (max, label) => Math.max(max, label.length),
    0,
  );
  const pathColWidth = Math.max(16, Math.min(longestLabel + 2, 60));
  console.log("");
  console.log(t.syncRuntimesSummaryTitle);
  console.log(t.syncRuntimesSummaryIntro);
  console.log("");

  for (const group of groups) {
    const activeEntries = group.entries.filter(
      (entry) => entry.label && entry.count > 0,
    );
    if (activeEntries.length === 0) {
      continue;
    }
    console.log(`${group.name}`);
    for (const entry of activeEntries) {
      const pathCol = String(entry.label).padEnd(pathColWidth);
      let detail = "";
      if (entry.summaryKind === "agents") {
        detail = t.syncDetailAgents(entry.count, entry.expectedCount ?? teamSize);
      } else if (entry.summaryKind === "workspaces") {
        detail = t.syncDetailWorkspaces(entry.count, teamSize);
      } else {
        detail = t.syncDetailFiles(entry.count);
      }
      console.log(`${pathCol} ${detail}`);
    }
    console.log("");
  }

  console.log(t.syncScopeLine(scope, selectedTargets.join(", ")));

  if (manifestRecorder) {
    if (process.env.META_KIM_TEST_FAIL_SYNC_RUNTIMES_MANIFEST === "1") {
      throw new Error(
        "Global runtime sync is partial because install manifest persistence was intentionally failed",
      );
    }
    const result = await manifestRecorder.flush();
    if (result.ok) {
      console.log(`✓ ${t.syncInstallManifestOk(result.path, result.entries)}`);
    } else {
      throw new Error(`Install manifest update failed: ${result.error ?? "unknown error"}`);
    }
  }
}

if (
  import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("sync-runtimes.mjs")
) {
  await main();
}
