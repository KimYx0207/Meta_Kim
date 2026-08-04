#!/usr/bin/env node
/**
 * Meta_Kim uninstaller — reverses what sync-runtimes / sync-global-meta-theory
 * / setup.mjs have written. Dry-run by default; `--yes` actually deletes.
 *
 * Categories handled (A..I from footprint.mjs):
 *   A. Global runtime skills         → remove directory
 *   B. Global hooks                  → remove directory
 *   C. Global settings.json merges   → back up + strip managed hook entries
 *   D. Project runtime skills        → remove directory
 *   E. Project runtime hooks         → remove file
 *   F. Project runtime agents        → (kept by default — owned by the repo
 *                                       itself; pass --purge-project-agents)
 *   G. Project settings / MCP        → back up + strip managed hooks
 *   H. Project local state           → remove directory (.meta-kim/)
 *   I. Shared deps (pip, git hooks)  → only when --deep is passed
 *
 * Usage:
 *   node scripts/uninstall.mjs                       # dry-run
 *   node scripts/uninstall.mjs --yes                 # actually delete
 *   node scripts/uninstall.mjs --scope=global --yes  # global-only cleanup
 *   node scripts/uninstall.mjs --recover             # exact-signature legacy recovery dry-run
 *   node scripts/uninstall.mjs --deep --yes          # also pip + git hooks
 *   node scripts/uninstall.mjs --lang zh             # en/zh/ja/ko
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { collectFindings } from "./footprint.mjs";
import {
  CATEGORIES,
  directoryClosureSync,
  manifestPathFor,
  readManifest,
} from "./install-manifest.mjs";
import {
  removeExactManagedMcpFragment,
  resolveDurableMetaKimRuntimeLayout,
  resolvePortableMetaKimPackageIdentity,
} from "./global-runtime-mcp.mjs";
import {
  globalAgentProjectionFileName,
  resolveRuntimeProfilesFromManifest,
  resolveRuntimeProjection,
  syncManifestPath,
} from "./meta-kim-sync-config.mjs";
import { resolveOpenClawWorkspaceOwnedFiles } from "./openclaw-workspace-projection.mjs";
import {
  invertCodexConfigMutations,
  normalizeCodexConfigMutations,
} from "./codex-config-merge.mjs";
import {
  classifyMcpMemoryBootRecoveryFile,
  collectMcpMemoryBootRecoveryFindings,
  isExactMcpMemoryBootManifestIdentity,
  snapshotMcpMemoryBootArtifactFile,
} from "./mcp-memory-boot-artifacts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const GLOBAL_OWNERSHIP_POLICY_PATH = path.join(
  REPO_ROOT,
  "config",
  "contracts",
  "global-install-ownership-policy.json",
);
const RUNTIME_BUNDLE_PURPOSE_SUFFIX = "-runtime-bundle";
const DURABLE_MCP_BUNDLE_PURPOSE = "claude-global-mcp-runtime-bundle";
const PRIMARY_PROJECTION_BUNDLE_PURPOSE =
  "primary-runtime-global-projection-package-runtime-bundle";
const PROJECTION_PACKAGE_RECEIPT_SCHEMA =
  "meta-kim-global-projection-package-v1";
const REQUIRED_BUNDLE_PROOF_ROLES_BY_PURPOSE = new Map([
  [
    DURABLE_MCP_BUNDLE_PURPOSE,
    new Set(["package-manifest", "cli", "server"]),
  ],
  [
    PRIMARY_PROJECTION_BUNDLE_PURPOSE,
    new Set(["receipt", "package-manifest", "cli", "sync-script"]),
  ],
]);
const BUNDLE_SOURCE_BY_PURPOSE = new Map([
  [DURABLE_MCP_BUNDLE_PURPOSE, "sync-global-meta-theory"],
  [PRIMARY_PROJECTION_BUNDLE_PURPOSE, "sync-global-meta-theory"],
]);
const PACKAGE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathAtOrWithin(rootPath, candidatePath) {
  const root = pathKey(rootPath);
  const candidate = pathKey(candidatePath);
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function projectionAssetType(assetKey) {
  const normalized = String(assetKey).toLowerCase();
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
  ) return "config";
  return null;
}

function projectionCategory(assetType) {
  if (assetType === "hooks") return CATEGORIES.B;
  if (["config", "mcp"].includes(assetType)) return CATEGORIES.C;
  return CATEGORIES.A;
}

function directCanonicalFileNames(directoryPath) {
  try {
    return new Set(
      readdirSync(directoryPath, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name),
    );
  } catch {
    return new Set();
  }
}

const CANONICAL_AGENT_IDS = new Set(
  [...directCanonicalFileNames(path.join(REPO_ROOT, "canonical", "agents"))]
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3)),
);
const CANONICAL_GLOBAL_HOOK_FILES = new Set([
  ...directCanonicalFileNames(path.join(
    REPO_ROOT,
    "canonical",
    "runtime-assets",
    "claude",
    "hooks",
  )),
  ...directCanonicalFileNames(path.join(
    REPO_ROOT,
    "canonical",
    "runtime-assets",
    "shared",
    "hooks",
  )),
]);

function descriptorOwnershipIdentities(
  descriptor,
  profile,
  projection,
) {
  const { runtimeId, assetKey, rootPath, sourceOwner } = descriptor;
  if (sourceOwner === "sync-runtimes") {
    if (assetKey === "workspacesRoot") {
      return resolveOpenClawWorkspaceOwnedFiles(projection, CANONICAL_AGENT_IDS)
        .map((filePath) => ({
          kinds: new Set(["file"]),
          purpose: `${runtimeId}-global-${assetKey}`,
          matchesPath: (candidatePath) =>
            pathKey(candidatePath) === pathKey(filePath),
        }));
    }
    return [{
      kinds: new Set(["file"]),
      purpose: `${runtimeId}-global-${assetKey}`,
      matchesPath: (candidatePath) => assetKey.endsWith("File")
        ? pathKey(candidatePath) === pathKey(rootPath)
        : pathAtOrWithin(rootPath, candidatePath),
    }];
  }
  if (sourceOwner !== "sync-global-meta-theory") return [];

  if (assetKey === "agentsDir") {
    const projection = profile.projection.globalAgentProjection;
    if (!projection?.supported) return [];
    return [...CANONICAL_AGENT_IDS].map((agentId) => ({
      kinds: new Set(["file"]),
      purpose: `${runtimeId}-global-agent:${agentId}`,
      matchesPath: (candidatePath) => pathKey(candidatePath) === pathKey(
        path.join(rootPath, globalAgentProjectionFileName(projection, agentId)),
      ),
    }));
  }

  if (assetKey === "skillRoot") {
    return [{
      kinds: new Set(["dir"]),
      purpose: `${runtimeId}-global-skill`,
      matchesPath: (candidatePath) => pathKey(candidatePath) === pathKey(rootPath),
    }];
  }

  if (assetKey === "commandsDir") {
    const commands = directCanonicalFileNames(path.join(
      REPO_ROOT,
      "canonical",
      "runtime-assets",
      runtimeId,
      "commands",
    ));
    return [...commands].map((fileName) => ({
      kinds: new Set(["file"]),
      purpose: `${runtimeId}-global-command`,
      matchesPath: (candidatePath) => pathKey(candidatePath) === pathKey(
        path.join(rootPath, fileName),
      ),
    }));
  }

  if (assetKey === "hooksDir") {
    return [
      {
        kinds: new Set(["dir"]),
        purpose: `${runtimeId}-global-hooks-dir`,
        matchesPath: (candidatePath) => pathKey(candidatePath) === pathKey(rootPath),
      },
      ...[...CANONICAL_GLOBAL_HOOK_FILES].map((fileName) => ({
        kinds: new Set(["file"]),
        purpose: `${runtimeId}-global-hook`,
        matchesPath: (candidatePath) => pathKey(candidatePath) === pathKey(
          path.join(rootPath, fileName),
        ),
      })),
    ];
  }

  const exactSettingsPurpose = assetKey === "settingsFile"
    ? `${runtimeId}-global-settings-merge`
    : assetKey === "hooksFile"
      ? `${runtimeId}-global-hooks-json-merge`
      : assetKey === "configFile"
        ? `${runtimeId}-global-config-choice-surface-and-app-native-controls`
        : null;
  if (exactSettingsPurpose) {
    return [{
      kinds: new Set(["settings-merge", "toml-fragment-merge"]),
      purpose: exactSettingsPurpose,
      matchesPath: (candidatePath) => pathKey(candidatePath) === pathKey(rootPath),
    }];
  }
  return [];
}

function readGlobalOwnershipPolicy() {
  const policy = JSON.parse(readFileSync(GLOBAL_OWNERSHIP_POLICY_PATH, "utf8"));
  if (
    policy?.schemaVersion !== "meta-kim-global-install-ownership-policy-v1" ||
    !Array.isArray(policy.externalEntries) ||
    !policy.durableRuntimeBundle ||
    typeof policy.durableRuntimeBundle !== "object" ||
    !policy.projectionPackageStore ||
    typeof policy.projectionPackageStore !== "object"
  ) {
    throw new Error(`Invalid global install ownership policy: ${GLOBAL_OWNERSHIP_POLICY_PATH}`);
  }
  return policy;
}

function buildGlobalRemovalPolicy() {
  const syncManifest = JSON.parse(readFileSync(syncManifestPath, "utf8"));
  const profiles = resolveRuntimeProfilesFromManifest(syncManifest);
  const packageManifest = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  const distribution = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "config", "distribution.json"), "utf8"),
  );
  const packageIdentity = resolvePortableMetaKimPackageIdentity(
    packageManifest,
    distribution,
  );
  const ownershipPolicy = readGlobalOwnershipPolicy();
  const descriptors = [];
  for (const [runtimeId, profile] of Object.entries(profiles)) {
    const projection = resolveRuntimeProjection(runtimeId, "global");
    for (const [assetKey, rootPath] of Object.entries(projection)) {
      if (
        ["runtimeId", "scope", "baseDir", "display"].includes(assetKey) ||
        typeof rootPath !== "string"
      ) continue;
      const assetType = projectionAssetType(assetKey);
      if (!assetType || !profile.projection.assetTypes.includes(assetType)) continue;
      descriptors.push({
        runtimeId,
        assetKey,
        assetType,
        rootPath,
        // Runtime hook/config/MCP projection files are merged configuration
        // (category C), while their sibling directories retain the category
        // derived from the capability type. This stays schema-driven for any
        // future *File projection key rather than naming a runtime path here.
        category: assetKey.endsWith("File")
          ? CATEGORIES.C
          : projectionCategory(assetType),
        sourceOwner: profile.projection.globalAssetOwners[assetType],
        ownershipIdentities: null,
      });
    }
  }
  descriptors.sort((left, right) => right.rootPath.length - left.rootPath.length);
  for (const descriptor of descriptors) {
    descriptor.ownershipIdentities = descriptorOwnershipIdentities(
      descriptor,
      profiles[descriptor.runtimeId],
      resolveRuntimeProjection(descriptor.runtimeId, "global"),
    );
  }

  const externalEntries = ownershipPolicy.externalEntries.map((rule, index) => {
    const profile = profiles[rule.runtime];
    const relPath = String(rule.path ?? "").replace(/\\/gu, "/");
    const safeRelPath = relPath && !path.isAbsolute(relPath) &&
      !relPath.split("/").some((segment) => !segment || segment === "." || segment === "..");
    const supportedBase = rule.base === "home" ||
      rule.base === "runtimeHomeParent";
    if (
      !profile ||
      !profile.projection.assetTypes.includes(rule.assetType) ||
      profile.projection.globalAssetOwners[rule.assetType] !== rule.sourceOwner ||
      projectionCategory(rule.assetType) !== rule.category ||
      !Array.isArray(rule.kinds) ||
      rule.kinds.length === 0 ||
      !["exact", "within"].includes(rule.match) ||
      !supportedBase ||
      !safeRelPath ||
      (typeof rule.purpose !== "string" && typeof rule.purposePrefix !== "string")
    ) {
      throw new Error(`Invalid global ownership externalEntries[${index}]`);
    }
    const runtimeBaseDir = path.dirname(
      resolveRuntimeProjection(rule.runtime, "global").baseDir,
    );
    const rootPath = rule.base === "home"
      ? path.resolve(homedir(), relPath)
      : path.resolve(runtimeBaseDir, relPath);
    return { ...rule, rootPath };
  });
  const durableRule = ownershipPolicy.durableRuntimeBundle;
  const durableProfile = profiles[durableRule.runtime];
  if (
    !durableProfile ||
    !durableProfile.projection.assetTypes.includes(durableRule.assetType) ||
    durableProfile.projection.globalAssetOwners[durableRule.assetType] !==
      durableRule.sourceOwner ||
    projectionCategory(durableRule.assetType) !== durableRule.category ||
    typeof durableRule.purpose !== "string" ||
    !durableRule.purpose
  ) {
    throw new Error("Invalid global ownership durableRuntimeBundle");
  }
  const durableRuntimeBaseDir = path.dirname(
    resolveRuntimeProjection(durableRule.runtime, "global").baseDir,
  );
  const durableCurrentLayout = resolveDurableMetaKimRuntimeLayout(
    durableRuntimeBaseDir,
    packageIdentity,
    packageManifest,
  );
  const projectionRule = ownershipPolicy.projectionPackageStore;
  const projectionRelPath = String(projectionRule.path ?? "").replace(/\\/gu, "/");
  const projectionProofRoles = new Set(
    Array.isArray(projectionRule.proofRoles) ? projectionRule.proofRoles : [],
  );
  const requiredProjectionProofRoles =
    REQUIRED_BUNDLE_PROOF_ROLES_BY_PURPOSE.get(PRIMARY_PROJECTION_BUNDLE_PURPOSE);
  const safeProjectionRelPath = projectionRelPath &&
    !path.isAbsolute(projectionRelPath) &&
    !projectionRelPath.split("/").some((segment) =>
      !segment || segment === "." || segment === ".."
    );
  if (
    projectionRule.scope !== "claude_codex" ||
    projectionRule.category !== CATEGORIES.C ||
    projectionRule.sourceOwner !== "sync-global-meta-theory" ||
    projectionRule.bundlePurpose !== PRIMARY_PROJECTION_BUNDLE_PURPOSE ||
    projectionRule.base !== "home" ||
    projectionRelPath !== ".meta-kim/runtime/projection-packages" ||
    projectionRule.layout !==
      "<package-name>/<version>/<tgz-sha256>/bundle/node_modules/<package-name>" ||
    !safeProjectionRelPath ||
    projectionProofRoles.size !== projectionRule.proofRoles?.length ||
    projectionProofRoles.size !== requiredProjectionProofRoles.size ||
    [...requiredProjectionProofRoles].some((role) =>
      !projectionProofRoles.has(role)
    )
  ) {
    throw new Error("Invalid global ownership projectionPackageStore");
  }
  return {
    profiles,
    descriptors,
    externalEntries,
    durableRuntimeBundle: {
      ...durableRule,
      runtimeBaseDir: durableRuntimeBaseDir,
      bundleParent: path.dirname(durableCurrentLayout.bundleDir),
      packageName: packageIdentity.packageName,
      distribution,
    },
    projectionPackageStore: {
      ...projectionRule,
      rootPath: path.resolve(homedir(), projectionRelPath),
      packageName: packageIdentity.packageName,
    },
  };
}

const GLOBAL_REMOVAL_POLICY = buildGlobalRemovalPolicy();

function trustedDurableRuntimeBundleEntry(entry) {
  const rule = GLOBAL_REMOVAL_POLICY.durableRuntimeBundle;
  if (
    entry.category !== rule.category ||
    entry.source !== rule.sourceOwner ||
    (entry.runtimeTarget != null && entry.runtimeTarget !== rule.runtime) ||
    (entry.ownershipClass != null && entry.ownershipClass !== "install_projection") ||
    typeof entry.path !== "string" ||
    !path.isAbsolute(entry.path)
  ) return false;

  const relative = path.relative(rule.bundleParent, entry.path);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) return false;
  const [version] = relative.split(path.sep);
  if (!version || !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/u.test(version)) return false;

  const bundleDir = path.join(rule.bundleParent, version);
  const packageManifestPath = path.join(
    bundleDir,
    "node_modules",
    ...rule.packageName.split("/"),
    "package.json",
  );
  let historicalPackageManifest;
  try {
    const stats = lstatSync(packageManifestPath);
    if (stats.isSymbolicLink() || !stats.isFile()) return false;
    historicalPackageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  } catch {
    return false;
  }

  let historicalIdentity;
  let layout;
  try {
    historicalIdentity = resolvePortableMetaKimPackageIdentity(
      historicalPackageManifest,
      rule.distribution,
    );
    if (
      historicalIdentity.packageName !== rule.packageName ||
      historicalIdentity.packageVersion !== version
    ) return false;
    layout = resolveDurableMetaKimRuntimeLayout(
      rule.runtimeBaseDir,
      historicalIdentity,
      historicalPackageManifest,
    );
  } catch {
    return false;
  }

  const exactIdentities = new Map([
    [rule.purpose, { kind: "dir", path: layout.bundleDir }],
    [`${rule.purpose}:package-manifest`, {
      kind: "file",
      path: layout.packageManifestPath,
    }],
    [`${rule.purpose}:cli`, { kind: "file", path: layout.cliPath }],
    [`${rule.purpose}:server`, { kind: "file", path: layout.serverPath }],
  ]);
  const identity = exactIdentities.get(entry.purpose);
  return Boolean(
    identity &&
    entry.kind === identity.kind &&
    pathKey(entry.path) === pathKey(identity.path)
  );
}

function resolveProjectionPackageCli(packageManifest) {
  const bins = packageManifest?.bin;
  if (!bins || typeof bins !== "object" || Array.isArray(bins)) return null;
  const preferredName = packageManifest.name?.split("/").at(-1);
  const relativePath = bins[preferredName] ?? bins["meta-kim"] ??
    Object.values(bins)[0];
  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.replaceAll("\\", "/").split("/").some((segment) =>
      !segment || segment === "." || segment === ".."
    )
  ) return null;
  return relativePath;
}

function trustedProjectionPackageRuntimeBundleEntry(entry) {
  const rule = GLOBAL_REMOVAL_POLICY.projectionPackageStore;
  if (
    entry.category !== rule.category ||
    entry.source !== rule.sourceOwner ||
    entry.runtimeTarget != null ||
    (entry.ownershipClass != null && entry.ownershipClass !== "install_projection") ||
    typeof entry.path !== "string" ||
    !path.isAbsolute(entry.path) ||
    !pathAtOrWithin(rule.rootPath, entry.path)
  ) return false;

  const packageBase = path.join(rule.rootPath, ...rule.packageName.split("/"));
  const relative = path.relative(pathKey(packageBase), pathKey(entry.path));
  const segments = relative.split(path.sep);
  const [version, digest] = segments;
  if (
    !version ||
    !PACKAGE_VERSION_RE.test(version) ||
    !SHA256_RE.test(digest ?? "")
  ) return false;

  const digestDir = path.join(packageBase, version, digest);
  const packageRoot = path.join(
    digestDir,
    "bundle",
    "node_modules",
    ...rule.packageName.split("/"),
  );
  const packageManifestPath = path.join(packageRoot, "package.json");
  let historicalPackageManifest;
  try {
    const stats = lstatSync(packageManifestPath);
    if (stats.isSymbolicLink() || !stats.isFile()) return false;
    historicalPackageManifest = JSON.parse(
      readFileSync(packageManifestPath, "utf8"),
    );
  } catch {
    return false;
  }
  const cliRelative = resolveProjectionPackageCli(historicalPackageManifest);
  if (
    historicalPackageManifest.name !== rule.packageName ||
    historicalPackageManifest.version !== version ||
    !cliRelative
  ) return false;

  const exactIdentities = new Map([
    [rule.bundlePurpose, { kind: "dir", path: digestDir }],
    [`${rule.bundlePurpose}:receipt`, {
      kind: "file",
      path: path.join(digestDir, "receipt.json"),
    }],
    [`${rule.bundlePurpose}:package-manifest`, {
      kind: "file",
      path: packageManifestPath,
    }],
    [`${rule.bundlePurpose}:cli`, {
      kind: "file",
      path: path.resolve(packageRoot, cliRelative),
    }],
    [`${rule.bundlePurpose}:sync-script`, {
      kind: "file",
      path: path.join(packageRoot, "scripts", "sync-global-meta-theory.mjs"),
    }],
  ]);
  const identity = exactIdentities.get(entry.purpose);
  return Boolean(
    identity &&
    entry.kind === identity.kind &&
    pathKey(entry.path) === pathKey(identity.path)
  );
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeManagedHookFragment(fragment) {
  if (
    !fragment ||
    typeof fragment !== "object" ||
    Array.isArray(fragment) ||
    typeof fragment.event !== "string" ||
    !fragment.event ||
    (fragment.matcher !== null && fragment.matcher !== undefined &&
      typeof fragment.matcher !== "string") ||
    !fragment.hook ||
    typeof fragment.hook !== "object" ||
    Array.isArray(fragment.hook) ||
    fragment.hook.type !== "command" ||
    typeof fragment.hook.command !== "string" ||
    !fragment.hook.command
  ) return null;
  return {
    event: fragment.event,
    matcher: fragment.matcher ?? null,
    hook: structuredClone(fragment.hook),
  };
}

/**
 * Convert an install-manifest entry into the same shape as a scan finding so
 * planActions() can consume either source uniformly. Returns null for entries
 * the current uninstall pipeline cannot act on (pip-package and git-hook).
 */
export function manifestEntryToFinding(entry) {
  if (!entry?.path || !entry?.category) return null;
  if (
    entry.kind === "pip-package" ||
    entry.kind === "git-hook"
  ) {
    return null;
  }
  const base = {
    path: entry.path,
    category: entry.category,
    source: entry.source || "manifest",
    purpose: entry.purpose || null,
    manifestManaged: true,
    ownershipClass: entry.ownershipClass ?? null,
    runtimeTarget: entry.runtimeTarget ?? null,
    mcpMemoryBootArtifact: isExactMcpMemoryBootManifestIdentity(entry, {
      homeRoot: homedir(),
      platformName: process.platform,
    }),
  };
  if (
    entry.kind === "settings-merge" &&
    path.extname(entry.path).toLowerCase() === ".toml"
  ) {
    return {
      ...base,
      kind: "toml-fragment-merge",
      tomlMutationJournal: null,
      legacyUnstructuredTomlOwnership: true,
    };
  }
  if (entry.kind === "settings-merge") {
    const commands = entry.mergedHookCommands || [];
    const rawFragments = entry.mergedHookFragments;
    const normalizedFragments = Array.isArray(rawFragments)
      ? rawFragments.map(normalizeManagedHookFragment)
      : null;
    const managedHookFragments = normalizedFragments &&
        normalizedFragments.every(Boolean)
      ? normalizedFragments
      : null;
    return {
      ...base,
      kind: "settings-merge",
      managedHookCount: managedHookFragments?.length ?? commands.length,
      managedHooks: commands.map((command) => ({
        event: null,
        matcher: null,
        command,
      })),
      managedHookFragments,
    };
  }
  if (entry.kind === "toml-fragment-merge") {
    let tomlMutationJournal = null;
    try {
      if (Array.isArray(entry.tomlMutationJournal)) {
        tomlMutationJournal = normalizeCodexConfigMutations(
          entry.tomlMutationJournal,
        );
      }
    } catch {
      tomlMutationJournal = null;
    }
    return {
      ...base,
      kind: "toml-fragment-merge",
      tomlMutationJournal,
    };
  }
  if (entry.kind === "mcp-server") {
    return {
      ...base,
      kind: "mcp-server",
      mcpServerName: entry.mcpServerName,
      mcpServerFingerprint: entry.mcpServerFingerprint,
    };
  }
  return {
    ...base,
    kind: entry.kind === "dir" ? "dir" : "file",
    size: entry.size ?? null,
    sha256: entry.sha256 ?? null,
    directoryClosureSha256: entry.directoryClosureSha256 ?? null,
    directoryClosureEntryCount: Number.isFinite(entry.directoryClosureEntryCount)
      ? entry.directoryClosureEntryCount
      : null,
    mtime: null,
  };
}

function isStrictDescendant(parentPath, candidatePath) {
  const relative = path.relative(pathKey(parentPath), pathKey(candidatePath));
  return Boolean(relative) && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function findingsFromOneManifest(manifest) {
  const findings = [];
  const bundlePurposes = new Set(
    (manifest?.entries ?? [])
      .filter((entry) =>
        entry.kind === "dir" &&
        typeof entry.purpose === "string" &&
        entry.purpose.endsWith(RUNTIME_BUNDLE_PURPOSE_SUFFIX),
      )
      .map((entry) => entry.purpose),
  );
  for (const entry of manifest?.entries ?? []) {
    if (
      entry.kind === "file" &&
      [...bundlePurposes].some((purpose) => entry.purpose?.startsWith(`${purpose}:`))
    ) {
      // Bundle proof files are evidence for the closed-directory action, not
      // independent deletion or settings-merge targets.
      continue;
    }
    const finding = manifestEntryToFinding(entry);
    if (!finding) continue;
    if (
      finding.kind === "dir" &&
      typeof finding.purpose === "string" &&
      finding.purpose.endsWith(RUNTIME_BUNDLE_PURPOSE_SUFFIX)
    ) {
      const proofPrefix = `${finding.purpose}:`;
      finding.bundleProofFiles = manifest.entries
        .filter((candidate) =>
          typeof candidate.purpose === "string" &&
          candidate.purpose.startsWith(proofPrefix),
        )
        .map((candidate) => ({
          path: candidate.path,
          role: candidate.purpose.slice(proofPrefix.length),
          kind: candidate.kind,
          source: candidate.source,
          size: candidate.size ?? null,
          sha256: candidate.sha256 ?? null,
        }));
    }
    findings.push(finding);
  }
  return findings;
}

function manifestEntryIsActionable(entry) {
  return Boolean(manifestEntryToFinding(entry));
}

function matchesExternalGlobalRule(entry, rule) {
  if (
    entry.category !== rule.category ||
    entry.source !== rule.sourceOwner ||
    !rule.kinds.includes(entry.kind) ||
    (entry.runtimeTarget != null && entry.runtimeTarget !== rule.runtime)
  ) return false;
  const purposeMatches = typeof rule.purpose === "string"
    ? entry.purpose === rule.purpose
    : typeof entry.purpose === "string" && entry.purpose.startsWith(rule.purposePrefix);
  if (!purposeMatches || !path.isAbsolute(entry.path)) return false;
  return rule.match === "exact"
    ? pathKey(entry.path) === pathKey(rule.rootPath)
    : pathAtOrWithin(rule.rootPath, entry.path);
}

function validateGlobalManifestEntryForRemoval(entry) {
  if (!manifestEntryIsActionable(entry)) return { ok: true };
  if (
    typeof entry.path !== "string" ||
    !path.isAbsolute(entry.path) ||
    typeof entry.source !== "string" ||
    typeof entry.purpose !== "string" ||
    (entry.ownershipClass != null && entry.ownershipClass !== "install_projection")
  ) return { ok: false, reason: "missing_or_invalid_global_ownership_identity" };

  if (trustedDurableRuntimeBundleEntry(entry)) return { ok: true };
  if (trustedProjectionPackageRuntimeBundleEntry(entry)) return { ok: true };
  if (isExactMcpMemoryBootManifestIdentity(entry, {
    homeRoot: homedir(),
    platformName: process.platform,
  })) return { ok: true };

  if (
    GLOBAL_REMOVAL_POLICY.externalEntries.some((rule) =>
      matchesExternalGlobalRule(entry, rule)
    )
  ) return { ok: true };

  const matchingDescriptors = GLOBAL_REMOVAL_POLICY.descriptors.filter((descriptor) =>
    descriptor.assetKey.endsWith("File")
      ? pathKey(entry.path) === pathKey(descriptor.rootPath)
      : pathAtOrWithin(descriptor.rootPath, entry.path)
  );
  const mostSpecificLength = matchingDescriptors.reduce(
    (length, descriptor) => Math.max(length, pathKey(descriptor.rootPath).length),
    -1,
  );
  for (const descriptor of matchingDescriptors.filter((candidate) =>
    pathKey(candidate.rootPath).length === mostSpecificLength
  )) {
    const pathMatches = descriptor.assetKey.endsWith("File")
      ? pathKey(entry.path) === pathKey(descriptor.rootPath)
      : pathAtOrWithin(descriptor.rootPath, entry.path);
    if (!pathMatches) continue;
    if (
      entry.category !== descriptor.category ||
      entry.source !== descriptor.sourceOwner ||
      (entry.runtimeTarget != null && entry.runtimeTarget !== descriptor.runtimeId)
    ) continue;
    const identityMatches = descriptor.ownershipIdentities.some((identity) =>
      identity.kinds.has(entry.kind) &&
      entry.purpose === identity.purpose &&
      identity.matchesPath(entry.path)
    );
    if (identityMatches) return { ok: true };
  }
  if (matchingDescriptors.length > 0) {
    return { ok: false, reason: "descriptor_identity_mismatch" };
  }
  return { ok: false, reason: "outside_global_ownership_policy" };
}

function validatePhysicalManifestForRemoval(
  manifest,
  { manifestScope, manifestPath, repoRoot },
) {
  if (manifest.scope !== manifestScope) {
    return `${manifestScope}:manifest_scope_mismatch:${manifestPath}`;
  }
  if (manifestScope === "project") {
    if (
      typeof manifest.repoRoot !== "string" ||
      pathKey(manifest.repoRoot) !== pathKey(repoRoot)
    ) return `project:manifest_repo_root_mismatch:${manifestPath}`;
    for (const entry of manifest.entries ?? []) {
      if (!manifestEntryIsActionable(entry)) continue;
      if (!path.isAbsolute(entry.path) || !pathAtOrWithin(repoRoot, entry.path)) {
        return `project:manifest_entry_outside_repo:${entry.path}`;
      }
    }
    return null;
  }
  for (const entry of manifest.entries ?? []) {
    const validated = validateGlobalManifestEntryForRemoval(entry);
    if (!validated.ok) {
      return `global:manifest_entry_untrusted:${validated.reason}:${entry.path}`;
    }
  }
  return null;
}

/**
 * Collect findings from install manifests (global + project) for the given
 * scope. Returns an empty array when no manifest exists or all entries are
 * non-actionable — callers should then fall back to collectFindings().
 */
export function findingsFromManifest({ scope, repoRoot }) {
  return manifestFindingsState({ scope, repoRoot }).findings;
}

export function manifestFindingsState({ scope, repoRoot }) {
  const findings = [];
  const blockedReasons = [];
  const requested = [];
  if (scope === "global" || scope === "both") requested.push(["global", manifestPathFor("global")]);
  if (scope === "project" || scope === "both") requested.push(["project", manifestPathFor("project", repoRoot)]);
  for (const [manifestScope, manifestPath] of requested) {
    if (!existsSync(manifestPath)) {
      blockedReasons.push(`${manifestScope}:manifest_missing:${manifestPath}`);
      continue;
    }
    const manifest = readManifest(manifestPath);
    if (!manifest) {
      blockedReasons.push(`${manifestScope}:manifest_invalid:${manifestPath}`);
      continue;
    }
    const manifestBlock = validatePhysicalManifestForRemoval(manifest, {
      manifestScope,
      manifestPath,
      repoRoot,
    });
    if (manifestBlock) {
      blockedReasons.push(manifestBlock);
      continue;
    }
    const currentFindings = findingsFromOneManifest(manifest);
    if (currentFindings.length === 0) {
      blockedReasons.push(`${manifestScope}:manifest_has_no_actionable_entries:${manifestPath}`);
      continue;
    }
    findings.push(...currentFindings);
  }
  return { findings, blockedReasons };
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

const MSG = {
  en: {
    title: "Meta_Kim uninstall",
    dryNote: "DRY-RUN — nothing will be deleted. Re-run with --yes to apply.",
    liveNote: "LIVE RUN — changes will be applied now.",
    sourceManifest:
      "Source: install-manifest (recorded entries from prior sync runs).",
    sourceScan:
      "Source: filesystem scan (no manifest found, or --no-manifest was passed).",
    sourceRecovery:
      "Source: opt-in exact-signature legacy recovery (not manifest-backed).",
    recoveryBoundary:
      "Recovery handles only recognized Meta_Kim artifacts; without a trusted manifest, complete uninstall cannot be proven.",
    planHeader: "Planned actions:",
    actRemoveDir: (p) => `  − remove directory: ${p}`,
    actRemoveFile: (p) => `  − remove file: ${p}`,
    actStripSettings: (p, n) =>
      `  ~ strip ${n} Meta_Kim hook entr${n === 1 ? "y" : "ies"} from: ${p}`,
    actBackup: (p) => `  ↳ backup → ${p}`,
    actPipUninstall: (pkg) => `  − pip uninstall ${pkg}  (--deep only)`,
    actGitHook: (p) => `  − remove shared git hook: ${p}  (--deep only)`,
    summary: (n) => `${n} action(s) planned.`,
    summaryNone: "Nothing to do — system is clean.",
    recoveryNone:
      "No exact Meta_Kim boot artifacts were found. Nothing changed. Without a trusted manifest, full cleanup is not proven.",
    done: "Done.",
    doneDelta: (del, strip) =>
      `Done: ${del} path(s) removed, ${strip} settings entr${strip === 1 ? "y" : "ies"} stripped.`,
    partialDelta: (del, strip) =>
      `Partial: ${del} path(s) removed, ${strip} settings entries stripped; preserved or failed actions remain.`,
    projectAgentsKept:
      "Project runtime agents (.claude/agents, .codex/agents, .cursor/agents) are kept by default — pass --purge-project-agents to also remove them.",
    deepOff:
      "Shared dependencies (pip packages, .git/hooks) are NOT touched unless --deep is passed.",
    backupDone: (p) => `Backup written: ${p}`,
    settingsParseFailed: (p) => `Cannot parse ${p} — leaving it untouched.`,
    preservedModified: (p) => `Preserved user-modified managed file: ${p}`,
    preservedUnverifiable: (p) => `Preserved managed file without complete integrity metadata: ${p}`,
    preservedConcurrent: (p) => `Preserved concurrently changed configuration: ${p}`,
    writeFailed: (p, reason) => `Atomic update failed for ${p}: ${reason}`,
    manifestBlocked: (reasons) => `Refusing manifest-less cleanup: ${reasons.join("; ")}. Use --recover for conservative exact-signature legacy recovery.`,
    confirmNeeded: "Refusing to delete without --yes. Exiting.",
  },
  "zh-CN": {
    title: "Meta_Kim 卸载",
    dryNote: "DRY-RUN 模式 — 不会真删。加 --yes 后才执行。",
    liveNote: "LIVE 模式 — 现在开始执行实际删除。",
    sourceManifest: "来源：install-manifest（历次 sync 记录的条目）。",
    sourceScan:
      "来源：文件系统扫描（未找到 manifest，或传入了 --no-manifest）。",
    sourceRecovery: "来源：用户明确启用的精确签名旧版恢复（非 manifest 驱动）。",
    recoveryBoundary: "恢复模式只处理能精确识别的 Meta_Kim 产物；没有可信 manifest，无法证明已完整卸载。",
    planHeader: "计划执行的操作：",
    actRemoveDir: (p) => `  − 删除目录：${p}`,
    actRemoveFile: (p) => `  − 删除文件：${p}`,
    actStripSettings: (p, n) => `  ~ 从 ${p} 移除 ${n} 条 Meta_Kim hook 条目`,
    actBackup: (p) => `  ↳ 备份 → ${p}`,
    actPipUninstall: (pkg) => `  − pip 卸载 ${pkg}（仅 --deep 时）`,
    actGitHook: (p) => `  − 删除共享 git hook：${p}（仅 --deep 时）`,
    summary: (n) => `共 ${n} 项待执行操作。`,
    summaryNone: "无事可做，系统已是干净状态。",
    recoveryNone: "未发现可精确识别的 Meta_Kim 启动产物。未做任何更改；没有可信 manifest，无法证明已完成全部清理。",
    done: "完成。",
    doneDelta: (del, strip) =>
      `完成：删除 ${del} 个路径，清理 ${strip} 条 settings 条目。`,
    partialDelta: (del, strip) =>
      `部分完成：删除 ${del} 个路径，清理 ${strip} 条 settings 条目；仍有已保留或失败的操作。`,
    projectAgentsKept:
      "项目级 runtime agents（.claude/agents、.codex/agents、.cursor/agents）默认保留。加 --purge-project-agents 才一起删。",
    deepOff:
      "共享依赖（pip 包、.git/hooks）默认不动。如需一并清理请加 --deep。",
    backupDone: (p) => `已备份：${p}`,
    settingsParseFailed: (p) => `无法解析 ${p}，跳过该文件。`,
    preservedModified: (p) => `已保留用户修改过的受管文件：${p}`,
    preservedUnverifiable: (p) => `缺少完整校验信息，已保留受管文件：${p}`,
    preservedConcurrent: (p) => `检测到并发修改，已保留配置：${p}`,
    writeFailed: (p, reason) => `${p} 原子更新失败：${reason}`,
    manifestBlocked: (reasons) => `缺少可信 manifest，拒绝清理：${reasons.join("；")}。如需保守地恢复旧版残留，请使用 --recover。`,
    confirmNeeded: "未加 --yes，拒绝执行删除。退出。",
  },
  "ja-JP": {
    title: "Meta_Kim アンインストール",
    dryNote: "DRY-RUN — 削除しません。--yes で実行します。",
    liveNote: "LIVE 実行 — 変更を即時適用します。",
    sourceManifest:
      "ソース：install-manifest（過去の sync で記録されたエントリ）。",
    sourceScan:
      "ソース：ファイルシステムスキャン（manifest なし、または --no-manifest 指定）。",
    sourceRecovery: "ソース：明示指定された厳密署名の旧版復旧（manifest ベースではありません）。",
    recoveryBoundary: "復旧は厳密に識別できた Meta_Kim 生成物だけを処理します。信頼できる manifest がないため、完全なアンインストールは証明できません。",
    planHeader: "実行予定の操作：",
    actRemoveDir: (p) => `  − ディレクトリ削除：${p}`,
    actRemoveFile: (p) => `  − ファイル削除：${p}`,
    actStripSettings: (p, n) =>
      `  ~ ${p} から Meta_Kim 管理 hook を ${n} 件削除`,
    actBackup: (p) => `  ↳ バックアップ → ${p}`,
    actPipUninstall: (pkg) => `  − pip uninstall ${pkg}（--deep のみ）`,
    actGitHook: (p) => `  − 共有 git hook 削除：${p}（--deep のみ）`,
    summary: (n) => `計 ${n} 件の操作を予定。`,
    summaryNone: "何もする必要がありません。クリーンな状態です。",
    recoveryNone: "厳密に識別できる Meta_Kim 起動生成物は見つかりませんでした。変更はありません。信頼できる manifest がないため、完全なクリーンアップは証明できません。",
    done: "完了。",
    doneDelta: (del, strip) =>
      `完了：${del} パス削除、${strip} 件の settings エントリ除去。`,
    partialDelta: (del, strip) =>
      `一部完了：${del} パス削除、${strip} 件除去。保持または失敗した操作が残っています。`,
    projectAgentsKept:
      "プロジェクト ランタイム agents はデフォルトで保持。--purge-project-agents で削除可。",
    deepOff: "共有依存（pip パッケージ、.git/hooks）は --deep 時のみ削除。",
    backupDone: (p) => `バックアップ作成：${p}`,
    settingsParseFailed: (p) => `${p} を解析できません、スキップ。`,
    preservedModified: (p) => `ユーザー変更済みの管理ファイルを保持：${p}`,
    preservedUnverifiable: (p) => `完全性情報が不十分な管理ファイルを保持：${p}`,
    preservedConcurrent: (p) => `同時変更された設定を保持：${p}`,
    writeFailed: (p, reason) => `${p} のアトミック更新失敗：${reason}`,
    manifestBlocked: (reasons) => `信頼できる manifest がないため拒否：${reasons.join("; ")}。保守的な厳密署名の旧版復旧には --recover を使用してください。`,
    confirmNeeded: "--yes なし、削除を拒否して終了。",
  },
  "ko-KR": {
    title: "Meta_Kim 제거",
    dryNote: "DRY-RUN — 실제 삭제 안 함. --yes 로 재실행하면 적용.",
    liveNote: "LIVE 모드 — 변경이 즉시 적용됩니다.",
    sourceManifest: "소스: install-manifest (이전 sync에 기록된 항목).",
    sourceScan:
      "소스: 파일시스템 스캔 (manifest 없음 또는 --no-manifest 지정).",
    sourceRecovery: "소스: 사용자가 명시한 엄격한 서명 기반 레거시 복구(manifest 기반 아님).",
    recoveryBoundary: "복구 모드는 정확히 식별된 Meta_Kim 산출물만 처리합니다. 신뢰할 수 있는 manifest가 없으므로 완전한 제거는 증명할 수 없습니다.",
    planHeader: "실행 예정 작업:",
    actRemoveDir: (p) => `  − 디렉터리 삭제: ${p}`,
    actRemoveFile: (p) => `  − 파일 삭제: ${p}`,
    actStripSettings: (p, n) => `  ~ ${p} 에서 Meta_Kim hook 항목 ${n} 건 제거`,
    actBackup: (p) => `  ↳ 백업 → ${p}`,
    actPipUninstall: (pkg) => `  − pip uninstall ${pkg} (--deep 전용)`,
    actGitHook: (p) => `  − 공유 git hook 제거: ${p} (--deep 전용)`,
    summary: (n) => `총 ${n} 건 작업 예정.`,
    summaryNone: "할 일 없음, 이미 깨끗한 상태.",
    recoveryNone: "정확히 식별된 Meta_Kim 시작 산출물을 찾지 못했습니다. 변경 사항은 없습니다. 신뢰할 수 있는 manifest가 없으므로 전체 정리를 증명할 수 없습니다.",
    done: "완료.",
    doneDelta: (del, strip) =>
      `완료: 경로 ${del} 건 제거, settings 항목 ${strip} 건 제거.`,
    partialDelta: (del, strip) =>
      `부분 완료: 경로 ${del} 건 제거, settings 항목 ${strip} 건 제거. 보존되거나 실패한 작업이 남았습니다.`,
    projectAgentsKept:
      "프로젝트 runtime agents 는 기본 보존. --purge-project-agents 로 함께 삭제.",
    deepOff: "공유 의존성(pip 패키지, .git/hooks)은 --deep 시에만 삭제.",
    backupDone: (p) => `백업 완료: ${p}`,
    settingsParseFailed: (p) => `${p} 파싱 실패, 건너뜀.`,
    preservedModified: (p) => `사용자가 수정한 관리 파일 보존: ${p}`,
    preservedUnverifiable: (p) => `무결성 정보가 불완전한 관리 파일 보존: ${p}`,
    preservedConcurrent: (p) => `동시에 변경된 설정 보존: ${p}`,
    writeFailed: (p, reason) => `${p} 원자적 업데이트 실패: ${reason}`,
    manifestBlocked: (reasons) => `신뢰 가능한 manifest가 없어 제거를 거부합니다: ${reasons.join("; ")}. 보수적인 엄격 서명 레거시 복구에는 --recover를 사용하세요.`,
    confirmNeeded: "--yes 없음, 삭제 거부. 종료.",
  },
};

function resolveLang(cliLang) {
  const pick = (value) => {
    if (!value) return null;
    const v = String(value).toLowerCase();
    if (v.startsWith("zh")) return "zh-CN";
    if (v.startsWith("ja")) return "ja-JP";
    if (v.startsWith("ko")) return "ko-KR";
    if (v.startsWith("en")) return "en";
    return null;
  };
  return (
    pick(cliLang) ||
    pick(process.env.METAKIM_LANG) ||
    pick(process.env.LC_ALL) ||
    pick(process.env.LC_MESSAGES) ||
    pick(process.env.LANG) ||
    "en"
  );
}

function iso() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function normalizeHookCommand(command) {
  return String(command ?? "").replace(/\\\\/g, "\\");
}

function isManagedGlobalCommand(command) {
  const n = normalizeHookCommand(command);
  return (
    n.includes("hooks/meta-kim/") ||
    n.includes("hooks\\meta-kim\\") ||
    isRetiredHookCommand(command)
  );
}

const RETIRED_HOOK_FILES = new Set(["pre-git-push-confirm.mjs"]);

function isRetiredHookCommand(command) {
  const n = normalizeHookCommand(command).replace(/\\/g, "/");
  return [...RETIRED_HOOK_FILES].some(
    (f) => n.endsWith(f) || n.includes(`/hooks/${f}`),
  );
}

const REPO_HOOK_FILES = new Set([
  "activate-meta-theory-spine.mjs",
  "bash-readonly-whitelist.mjs",
  "enforce-agent-dispatch.mjs",
  "graphify-context.mjs",
  "hook-i18n.mjs",
  "post-format.mjs",
  "post-typecheck.mjs",
  "post-console-log-warn.mjs",
  "skip-reminder.mjs",
  "subagent-context.mjs",
  "stop-compaction.mjs",
  "stop-console-log-audit.mjs",
  "stop-completion-guard.mjs",
  "stop-spine-cleanup.mjs",
]);

function isManagedRepoCommand(command) {
  const n = normalizeHookCommand(command).replace(/\\/g, "/");
  if (!n.includes("/.claude/hooks/")) return false;
  return [...REPO_HOOK_FILES].some((f) => n.endsWith(f)) || isRetiredHookCommand(command);
}

function stripManagedHookBlocks(hooksSection, predicate) {
  if (!hooksSection || typeof hooksSection !== "object") {
    return { hooks: {}, stripped: 0 };
  }
  let stripped = 0;
  const next = {};
  for (const [event, blocks] of Object.entries(hooksSection)) {
    const kept = [];
    for (const block of blocks ?? []) {
      const filtered = (block.hooks ?? []).filter((h) => {
        const hit = predicate(h.command ?? "", event, block, h);
        if (hit) stripped += 1;
        return !hit;
      });
      if (filtered.length > 0) {
        kept.push({ ...block, hooks: filtered });
      }
    }
    if (kept.length > 0) next[event] = kept;
  }
  return { hooks: next, stripped };
}

function removalIntegrity(finding) {
  return {
    manifestManaged: finding.manifestManaged === true,
    sha256: finding.sha256 ?? null,
    size: Number.isFinite(finding.size) ? finding.size : null,
    closureSha256: finding.directoryClosureSha256 ?? null,
    closureEntryCount: Number.isInteger(finding.directoryClosureEntryCount)
      ? finding.directoryClosureEntryCount
      : null,
    scanDerived: finding.source === "scan",
    scanExact: scanFindingMatchesCanonical(finding),
    recoverySignature: finding.recoverySignature ?? null,
    mcpMemoryBootArtifact: finding.mcpMemoryBootArtifact === true,
    physicalPath: finding.physicalPath ?? null,
  };
}

function isPrimaryProjectionReferenceFinding(finding) {
  if (finding.source !== "sync-global-meta-theory") return false;
  const purpose = String(finding.purpose ?? "");
  return (
    /-global-command$/u.test(purpose) ||
    /-global-hook$/u.test(purpose) ||
    /-global-hooks-dir$/u.test(purpose) ||
    /-global-settings-merge$/u.test(purpose) ||
    /-global-hooks-json-merge$/u.test(purpose) ||
    /-global-config-choice-surface-and-app-native-controls$/u.test(purpose)
  );
}

function scanFindingMatchesCanonical(finding) {
  if (finding.source !== "scan") return true;
  if (finding.kind !== "file") return false;
  if (![CATEGORIES.B, CATEGORIES.E].includes(finding.category)) return false;
  if (typeof finding.recoverySignature === "string") {
    try {
      const bytes = readFileSync(finding.path);
      return classifyMcpMemoryBootRecoveryFile({
        filePath: finding.path,
        bytes,
        homeRoot: homedir(),
        platformName: process.platform,
      }) === finding.recoverySignature;
    } catch {
      return false;
    }
  }
  const fileName = path.basename(finding.path);
  if (!REPO_HOOK_FILES.has(fileName)) return false;
  const canonicalPath = path.join(
    REPO_ROOT,
    "canonical",
    "runtime-assets",
    "claude",
    "hooks",
    fileName,
  );
  try {
    return readFileSync(finding.path).equals(readFileSync(canonicalPath));
  } catch {
    return false;
  }
}

function planActions({
  scope,
  repoRoot,
  deep,
  purgeProjectAgents,
  useManifest = true,
  recover = false,
}) {
  let findings = [];
  let source = "scan";
  if (useManifest) {
    const state = manifestFindingsState({ scope, repoRoot });
    if (state.blockedReasons.length > 0) {
      return { actions: [], source: "manifest", blockedReasons: state.blockedReasons };
    }
    findings = state.findings;
    source = "manifest";
  } else if (recover) {
    findings = scope === "global" || scope === "both"
      ? collectMcpMemoryBootRecoveryFindings({
          homeRoot: homedir(),
          platformName: process.platform,
        })
      : [];
    source = "recovery";
  } else {
    findings = collectFindings({ scope, repoRoot });
  }
  const unsafeTomlOwnership = findings.find((finding) =>
    finding.kind === "toml-fragment-merge" &&
    (!Array.isArray(finding.tomlMutationJournal) ||
      finding.tomlMutationJournal.length === 0)
  );
  if (unsafeTomlOwnership) {
    return {
      actions: [],
      source,
      blockedReasons: [
        `no_exact_managed_fragments_recorded:${unsafeTomlOwnership.path}`,
      ],
    };
  }
  const actions = [];

  for (const f of findings) {
    const primaryProjectionReferenceCleanup =
      isPrimaryProjectionReferenceFinding(f);
    switch (f.category) {
      case CATEGORIES.A: {
        actions.push({
          kind: "remove",
          path: f.path,
          catLabel: "A",
          recursive: f.kind === "dir",
          primaryProjectionReferenceCleanup,
          ...removalIntegrity(f),
        });
        break;
      }
      case CATEGORIES.B: {
        if (f.mcpMemoryBootArtifact === true || typeof f.recoverySignature === "string") {
          actions.push({
            kind: "remove",
            path: f.path,
            catLabel: "B",
            recursive: false,
            primaryProjectionReferenceCleanup,
            ...removalIntegrity(f),
          });
          break;
        }
        if (
          f.path.endsWith(path.sep + "meta-kim") ||
          f.path.endsWith("/meta-kim")
        ) {
          if (scope === "project") {
            break;
          }
          actions.push({
            kind: "remove",
            path: f.path,
            catLabel: "B",
            recursive: true,
            primaryProjectionReferenceCleanup,
            ...removalIntegrity(f),
          });
        }
        break;
      }
      case CATEGORIES.C: {
        if (f.kind === "toml-fragment-merge") {
          actions.push({
            kind: "revert-toml-fragments",
            path: f.path,
            catLabel: "C",
            mutationJournal: f.tomlMutationJournal,
            primaryProjectionReferenceCleanup,
          });
          break;
        }
        if (f.kind === "mcp-server") {
          actions.push({
            kind: "strip-mcp",
            path: f.path,
            catLabel: "C",
            serverName: f.mcpServerName,
            fingerprint: f.mcpServerFingerprint,
            primaryProjectionReferenceCleanup,
          });
          break;
        }
        if (
          f.kind === "dir" &&
          REQUIRED_BUNDLE_PROOF_ROLES_BY_PURPOSE.has(f.purpose)
        ) {
          actions.push({
            kind: "remove-bundle",
            path: f.path,
            catLabel: "C",
            manifestManaged: f.manifestManaged === true,
            source: f.source,
            purpose: f.purpose,
            closureSha256: f.directoryClosureSha256,
            closureEntryCount: f.directoryClosureEntryCount,
            proofFiles: f.bundleProofFiles ?? [],
          });
          break;
        }
        actions.push({
          kind: "strip-settings",
          path: f.path,
          catLabel: "C",
          predicate: isManagedGlobalCommand,
          expectedCount: f.managedHookCount ?? 0,
          exactFragments: f.manifestManaged ? f.managedHookFragments : null,
          requiresExactFragments: f.manifestManaged === true,
          primaryProjectionReferenceCleanup,
        });
        break;
      }
      case CATEGORIES.D: {
        actions.push({
          kind: "remove",
          path: f.path,
          catLabel: "D",
          recursive: f.kind === "dir",
          ...removalIntegrity(f),
        });
        break;
      }
      case CATEGORIES.E: {
        actions.push({
          kind: "remove",
          path: f.path,
          catLabel: "E",
          recursive: f.kind === "dir",
          ...removalIntegrity(f),
        });
        break;
      }
      case CATEGORIES.F: {
        if (purgeProjectAgents) {
          actions.push({
            kind: "remove",
            path: f.path,
            catLabel: "F",
            recursive: f.kind === "dir",
            ...removalIntegrity(f),
          });
        }
        break;
      }
      case CATEGORIES.G: {
        if (f.kind === "toml-fragment-merge") {
          actions.push({
            kind: "revert-toml-fragments",
            path: f.path,
            catLabel: "G",
            mutationJournal: f.tomlMutationJournal,
          });
        } else if (f.kind === "mcp-server") {
          actions.push({
            kind: "strip-mcp",
            path: f.path,
            catLabel: "G",
            serverName: f.mcpServerName,
            fingerprint: f.mcpServerFingerprint,
          });
        } else if (f.kind === "settings-merge") {
          actions.push({
            kind: "strip-settings",
            path: f.path,
            catLabel: "G",
            predicate: isManagedRepoCommand,
            expectedCount: f.managedHookCount ?? 0,
            exactFragments: f.manifestManaged ? f.managedHookFragments : null,
            requiresExactFragments: f.manifestManaged === true,
          });
        } else {
          actions.push({
            kind: "remove",
            path: f.path,
            catLabel: "G",
            recursive: f.kind === "dir",
            ...removalIntegrity(f),
          });
        }
        break;
      }
      case CATEGORIES.H: {
        actions.push({
          kind: "remove",
          path: f.path,
          catLabel: "H",
          recursive: f.kind === "dir",
          ...removalIntegrity(f),
        });
        break;
      }
      case CATEGORIES.I: {
        if (deep) {
          actions.push({
            kind: "remove",
            path: f.path,
            catLabel: "I",
            recursive: f.kind === "dir",
            ...removalIntegrity(f),
          });
        }
        break;
      }
      default:
        break;
    }
  }

  const seen = new Set();
  const deduped = actions.filter((a) => {
    const key = `${a.kind}::${a.path}::${a.serverName ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { actions: orderUninstallActions(deduped), source, blockedReasons: [] };
}

export function orderUninstallActions(actions) {
  const priority = (action) => {
    if (action.primaryProjectionReferenceCleanup === true) return 0;
    if (action.kind === "strip-mcp") return 0;
    if (
      action.kind === "remove-bundle" &&
      action.purpose === PRIMARY_PROJECTION_BUNDLE_PURPOSE
    ) return 100;
    if (action.kind === "remove-bundle") return 1;
    if (action.kind === "remove" && action.scanDerived && action.recursive) return 3;
    return 2;
  };
  return actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) => priority(left.action) - priority(right.action) || left.index - right.index)
    .map(({ action }) => action);
}

function describe(action, t) {
  switch (action.kind) {
    case "remove":
      return action.recursive
        ? t.actRemoveDir(action.path)
        : t.actRemoveFile(action.path);
    case "strip-settings":
      return t.actStripSettings(action.path, action.expectedCount);
    case "revert-toml-fragments":
      return `  ~ revert exact managed TOML fragments in: ${action.path}`;
    case "strip-mcp":
      return `  ~ strip managed MCP ${action.serverName} from: ${action.path}`;
    case "remove-bundle":
      return `  − remove exact managed runtime bundle: ${action.path}`;
    case "pip-uninstall":
      return t.actPipUninstall(action.package);
    default:
      return `  ? ${action.kind} ${action.path ?? ""}`;
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameSnapshot(left, right) {
  return left.length === right.length && sha256Bytes(left) === sha256Bytes(right);
}

function stagedPathFor(targetPath, purpose) {
  return path.join(
    path.dirname(targetPath),
    `.meta-kim-${purpose}-${path.basename(targetPath).replace(/^\.+/u, "")}-${process.pid}-${randomUUID()}.tmp`,
  );
}

function fsyncParentDirectoryBestEffort(filePath) {
  let fd;
  try {
    fd = openSync(path.dirname(filePath), "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is not supported by every Windows/filesystem pairing.
    // Each staged file is still flushed before its atomic rename.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeDurableStagedFile({ stagePath, bytes, mode }) {
  let fd;
  try {
    fd = openSync(stagePath, "wx", mode ?? 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Replace a file only when the bytes observed during planning are still the
 * bytes on disk at commit time. The backup is made from that exact snapshot,
 * and both backup and replacement are staged + fsynced before atomic rename.
 */
export function atomicRewriteFileFromSnapshot(
  targetPath,
  originalBytes,
  nextBytes,
  {
    beforeCommit,
    stageWriter = writeDurableStagedFile,
  } = {},
) {
  const original = Buffer.isBuffer(originalBytes)
    ? originalBytes
    : Buffer.from(originalBytes);
  const replacement = Buffer.isBuffer(nextBytes) ? nextBytes : Buffer.from(nextBytes);
  let initialStat;
  try {
    initialStat = lstatSync(targetPath);
  } catch (error) {
    return { success: false, reason: `snapshot_unavailable:${error?.code ?? "unknown"}` };
  }
  if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
    return { success: false, reason: "unsafe_file_type" };
  }
  const mode = initialStat.mode;

  const uniqueSuffix = randomUUID();
  const backupPath = `${targetPath}.backup-${iso()}-${uniqueSuffix}`;
  const backupStagePath = stagedPathFor(backupPath, "backup");
  const targetStagePath = stagedPathFor(targetPath, "rewrite");
  let backupCommitted = false;
  let targetCommitted = false;

  try {
    let preflight;
    try {
      preflight = readFileSync(targetPath);
    } catch (error) {
      return {
        success: false,
        reason: `concurrent_change:${error?.code ?? "unreadable"}`,
      };
    }
    if (!sameSnapshot(preflight, original)) {
      return { success: false, reason: "concurrent_change" };
    }

    stageWriter({
      stagePath: backupStagePath,
      bytes: original,
      mode,
      purpose: "backup",
    });
    renameSync(backupStagePath, backupPath);
    backupCommitted = true;
    fsyncParentDirectoryBestEffort(backupPath);

    stageWriter({
      stagePath: targetStagePath,
      bytes: replacement,
      mode,
      purpose: "replacement",
    });
    beforeCommit?.();

    let current;
    try {
      current = readFileSync(targetPath);
    } catch (error) {
      return {
        success: false,
        reason: `concurrent_change:${error?.code ?? "unreadable"}`,
        backupPath,
      };
    }
    if (!sameSnapshot(current, original)) {
      return { success: false, reason: "concurrent_change", backupPath };
    }
    let commitStat;
    try {
      commitStat = lstatSync(targetPath);
    } catch (error) {
      return {
        success: false,
        reason: `concurrent_change:${error?.code ?? "unreadable"}`,
        backupPath,
      };
    }
    if (
      commitStat.isSymbolicLink() ||
      !commitStat.isFile() ||
      commitStat.dev !== initialStat.dev ||
      commitStat.ino !== initialStat.ino
    ) {
      return { success: false, reason: "concurrent_change:file_identity", backupPath };
    }

    renameSync(targetStagePath, targetPath);
    targetCommitted = true;
    fsyncParentDirectoryBestEffort(targetPath);
    return { success: true, backupPath };
  } catch (error) {
    return {
      success: false,
      reason: `atomic_write_failed:${error?.message ?? String(error)}`,
      backupPath: backupCommitted ? backupPath : null,
    };
  } finally {
    if (!backupCommitted) rmSync(backupStagePath, { force: true });
    if (!targetCommitted) rmSync(targetStagePath, { force: true });
  }
}

export function stripManagedSettingsFile(
  action,
  { beforeCommit, stageWriter } = {},
) {
  let targetStat;
  try {
    targetStat = lstatSync(action.path);
  } catch (error) {
    return { success: false, stripped: 0, reason: `settings_unavailable:${error?.code ?? "unknown"}` };
  }
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    return { success: false, stripped: 0, reason: "unsafe_settings_file_type" };
  }
  const originalBytes = readFileSync(action.path);
  let parsed;
  try {
    parsed = JSON.parse(originalBytes.toString("utf8"));
  } catch {
    return { success: false, stripped: 0, reason: "invalid_json" };
  }
  let predicate = action.predicate;
  if (
    action.requiresExactFragments === true &&
    (!Array.isArray(action.exactFragments) || action.exactFragments.length === 0)
  ) {
    return {
      success: false,
      stripped: 0,
      reason: "no_exact_managed_fragments_recorded",
    };
  }
  if (Array.isArray(action.exactFragments)) {
    const remaining = action.exactFragments.map((fragment) => ({
      key: stableJson(fragment),
      consumed: false,
    }));
    predicate = (_command, event, block, hook) => {
      const key = stableJson({
        event,
        matcher: block?.matcher ?? null,
        hook,
      });
      const exact = remaining.find(
        (candidate) => !candidate.consumed && candidate.key === key,
      );
      if (!exact) return false;
      exact.consumed = true;
      return true;
    };
  }
  const { hooks, stripped } = stripManagedHookBlocks(parsed.hooks ?? {}, predicate);
  if (!Number.isInteger(action.expectedCount) || action.expectedCount <= 0) {
    return { success: false, stripped: 0, reason: "no_managed_entries_recorded" };
  }
  if (stripped !== action.expectedCount) {
    return {
      success: false,
      stripped: 0,
      reason: `managed_entry_count_mismatch:${stripped}/${action.expectedCount}`,
    };
  }
  parsed.hooks = hooks;
  const nextBytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  const rewrite = atomicRewriteFileFromSnapshot(
    action.path,
    originalBytes,
    nextBytes,
    { beforeCommit, stageWriter },
  );
  return rewrite.success
    ? { success: true, stripped, backupPath: rewrite.backupPath }
    : { ...rewrite, stripped: 0 };
}

export function revertManagedTomlFragments(
  action,
  { beforeCommit, stageWriter } = {},
) {
  let targetStat;
  try {
    targetStat = lstatSync(action.path);
  } catch (error) {
    return {
      success: false,
      stripped: 0,
      reason: `config_unavailable:${error?.code ?? "unknown"}`,
    };
  }
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    return {
      success: false,
      stripped: 0,
      reason: "unsafe_config_file_type",
    };
  }

  const originalBytes = readFileSync(action.path);
  const currentText = originalBytes.toString("utf8");
  if (!Buffer.from(currentText, "utf8").equals(originalBytes)) {
    return { success: false, stripped: 0, reason: "invalid_utf8" };
  }

  let normalizedJournal;
  let restoredText;
  try {
    if (!Array.isArray(action.mutationJournal) || action.mutationJournal.length === 0) {
      throw new Error("no exact TOML mutation journal recorded");
    }
    normalizedJournal = normalizeCodexConfigMutations(action.mutationJournal);
    if (normalizedJournal.length === 0) {
      throw new Error("empty normalized TOML mutation journal");
    }
    restoredText = invertCodexConfigMutations(currentText, normalizedJournal);
    if (restoredText === currentText) {
      throw new Error("TOML mutation journal has no effective delta");
    }
  } catch (error) {
    return {
      success: false,
      stripped: 0,
      reason: `toml_fragment_preflight_failed:${error?.message ?? String(error)}`,
    };
  }

  const rewrite = atomicRewriteFileFromSnapshot(
    action.path,
    originalBytes,
    Buffer.from(restoredText, "utf8"),
    { beforeCommit, stageWriter },
  );
  return rewrite.success
    ? {
        success: true,
        stripped: normalizedJournal.length,
        backupPath: rewrite.backupPath,
      }
    : { ...rewrite, stripped: 0 };
}

export function removeManagedMcpFragmentFromFile(
  action,
  { beforeCommit, stageWriter } = {},
) {
  let targetStat;
  try {
    targetStat = lstatSync(action.path);
  } catch (error) {
    return { success: false, stripped: 0, reason: `config_unavailable:${error?.code ?? "unknown"}` };
  }
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    return { success: false, stripped: 0, reason: "unsafe_config_file_type" };
  }
  const originalBytes = readFileSync(action.path);
  let parsed;
  try {
    parsed = JSON.parse(originalBytes.toString("utf8"));
  } catch {
    return { success: false, stripped: 0, reason: "invalid_json" };
  }
  if (!action.serverName || !action.fingerprint) {
    return { success: false, stripped: 0, reason: "missing_fragment_identity" };
  }
  const result = removeExactManagedMcpFragment(parsed, action.serverName, action.fingerprint);
  if (!result.removed) {
    return { success: false, stripped: 0, reason: "managed_fragment_changed" };
  }
  const nextBytes = Buffer.from(`${JSON.stringify(result.config, null, 2)}\n`, "utf8");
  const rewrite = atomicRewriteFileFromSnapshot(
    action.path,
    originalBytes,
    nextBytes,
    { beforeCommit, stageWriter },
  );
  return rewrite.success
    ? { success: true, stripped: 1, backupPath: rewrite.backupPath }
    : { ...rewrite, stripped: 0 };
}

export function removeManagedFileIfUnchanged(action, options = {}) {
  if (action.scanDerived && action.recursive !== true && action.scanExact !== true) {
    return { success: false, preserved: true, reason: "legacy_file_not_exact" };
  }
  if (action.scanDerived && action.recursive === true) {
    try {
      rmdirSync(action.path);
      return { success: true };
    } catch (error) {
      if (["ENOTEMPTY", "EEXIST", "EPERM"].includes(error?.code)) {
        return { success: false, preserved: true, reason: "legacy_directory_not_empty" };
      }
      if (error?.code === "ENOENT") return { success: true, missing: true };
      return { success: false, preserved: true, reason: `legacy_directory_unremovable:${error?.code ?? "unknown"}` };
    }
  }
  if (action.scanDerived && action.recoverySignature && action.recursive !== true) {
    if (!action.sha256 || !Number.isFinite(action.size)) {
      return { success: false, preserved: true, reason: "missing_integrity" };
    }
    return quarantineAndRemoveExactFile(action, options);
  }
  if (action.manifestManaged && action.recursive === true) {
    return removeExactManagedDirectory(action);
  }
  if (action.manifestManaged && action.recursive !== true) {
    if (!action.sha256 || !Number.isFinite(action.size)) {
      return { success: false, preserved: true, reason: "missing_integrity" };
    }
    return quarantineAndRemoveExactFile(action, options);
  }
  try {
    rmSync(action.path, { recursive: action.recursive === true, force: true });
    return { success: true };
  } catch (error) {
    return { success: false, preserved: false, reason: error?.message ?? String(error) };
  }
}

function physicalPathKey(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function inspectManagedFile(
  action,
  targetPath = action.path,
  { homeRoot = homedir() } = {},
) {
  if (!allDirectoryAncestorsArePlain(path.dirname(targetPath))) {
    return { ok: false, reason: "unsafe_file_ancestor" };
  }
  if (action.mcpMemoryBootArtifact === true || action.recoverySignature) {
    let snapshot;
    try {
      snapshot = snapshotMcpMemoryBootArtifactFile({
        filePath: targetPath,
        homeRoot,
        platformName: process.platform,
      });
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: false, reason: "file_missing" };
      return {
        ok: false,
        reason: `unsafe_mcp_memory_boot_path:${error?.message ?? "inspection_failed"}`,
      };
    }
    const inspectingOriginal = physicalPathKey(targetPath) === physicalPathKey(action.path);
    if (
      inspectingOriginal &&
      action.physicalPath &&
      physicalPathKey(snapshot.physicalPath) !== physicalPathKey(action.physicalPath)
    ) {
      return { ok: false, reason: "mcp_memory_boot_physical_path_changed" };
    }
    if (snapshot.size !== action.size || snapshot.sha256 !== action.sha256) {
      return { ok: false, reason: "integrity_mismatch" };
    }
    return { ok: true, dev: snapshot.dev, ino: snapshot.ino };
  }

  let stats;
  let bytes;
  try {
    stats = lstatSync(targetPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return { ok: false, reason: "unsafe_file_type" };
    }
    bytes = readFileSync(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, reason: "file_missing" };
    return { ok: false, reason: "integrity_unreadable" };
  }
  if (bytes.length !== action.size || sha256Bytes(bytes) !== action.sha256) {
    return { ok: false, reason: "integrity_mismatch" };
  }
  return { ok: true, dev: stats.dev, ino: stats.ino };
}

function quarantineAndRemoveExactFile(
  action,
  {
    beforeMove,
    removeFile = (targetPath) => rmSync(targetPath, { force: true }),
    homeRoot = homedir(),
  } = {},
) {
  if (!existsSync(action.path)) return { success: true, missing: true };
  const before = inspectManagedFile(action, action.path, { homeRoot });
  if (!before.ok) return { success: false, preserved: true, reason: before.reason };
  const quarantinePath = path.join(
    path.dirname(action.path),
    `.meta-kim-uninstall-${path.basename(action.path)}-${process.pid}-${randomUUID()}`,
  );
  let moved = false;
  try {
    beforeMove?.();
    const commitSnapshot = inspectManagedFile(action, action.path, { homeRoot });
    if (
      !commitSnapshot.ok ||
      commitSnapshot.dev !== before.dev ||
      commitSnapshot.ino !== before.ino
    ) {
      return {
        success: false,
        preserved: true,
        reason: `concurrent_change_before_move:${commitSnapshot.reason ?? "file_identity"}`,
        quarantinePath: null,
      };
    }
    renameSync(action.path, quarantinePath);
    moved = true;
    const after = inspectManagedFile(action, quarantinePath, { homeRoot });
    if (!after.ok || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Error(`post_move_integrity:${after.reason ?? "file_identity"}`);
    }
    removeFile(quarantinePath);
    moved = false;
    fsyncParentDirectoryBestEffort(action.path);
    return { success: true };
  } catch (error) {
    let restored = false;
    let rollbackIntegrity = { ok: false, reason: "quarantine_missing" };
    if (moved && existsSync(quarantinePath)) {
      rollbackIntegrity = inspectManagedFile(action, quarantinePath, { homeRoot });
      if (!existsSync(action.path)) {
        try {
          renameSync(quarantinePath, action.path);
          restored = true;
          moved = false;
        } catch {
          // Preserve the quarantine and report its exact path below.
        }
      }
    }
    const rollbackIncomplete = moved || !restored;
    return {
      success: false,
      preserved: restored,
      reason: `${rollbackIncomplete ? "rollback_incomplete" : "file_remove_failed"}:${error?.message ?? String(error)}${rollbackIntegrity.ok ? "" : `:${rollbackIntegrity.reason}`}`,
      quarantinePath: moved ? quarantinePath : null,
    };
  }
}

function inspectManagedDirectoryClosure(action, rootPath = action.path) {
  if (!action.closureSha256 || !Number.isInteger(action.closureEntryCount)) {
    return { ok: false, reason: "missing_directory_closure" };
  }
  const closure = directoryClosureSync(rootPath);
  if (
    !closure ||
    closure.entryCount !== action.closureEntryCount ||
    closure.sha256 !== action.closureSha256
  ) {
    return { ok: false, reason: "directory_closure_drift" };
  }
  return { ok: true };
}

function quarantineAndRemoveExactDirectory(
  action,
  inspector,
  { removeDirectory = (targetPath) => rmSync(targetPath, { recursive: true, force: true }) } = {},
) {
  if (!existsSync(action.path)) return { success: true, missing: true };
  const before = inspector(action);
  if (!before.ok) return { success: false, preserved: true, reason: before.reason };

  const quarantinePath = path.join(
    path.dirname(action.path),
    `.meta-kim-uninstall-${path.basename(action.path)}-${process.pid}-${randomUUID()}`,
  );
  let moved = false;
  try {
    renameSync(action.path, quarantinePath);
    moved = true;
    const after = inspector(action, quarantinePath);
    if (!after.ok) throw new Error(`post_move_integrity:${after.reason}`);
    removeDirectory(quarantinePath);
    moved = false;
    fsyncParentDirectoryBestEffort(action.path);
    return { success: true };
  } catch (error) {
    let restored = false;
    let rollbackIntegrity = { ok: false, reason: "quarantine_missing" };
    if (moved && existsSync(quarantinePath)) {
      rollbackIntegrity = inspector(action, quarantinePath);
      if (rollbackIntegrity.ok && !existsSync(action.path)) {
        try {
          renameSync(quarantinePath, action.path);
          restored = true;
          moved = false;
        } catch {
          // A failed exact rollback is reported with the quarantine location.
        }
      }
    }
    const rollbackIncomplete = moved || !restored;
    return {
      success: false,
      preserved: restored,
      reason: `${rollbackIncomplete ? "rollback_incomplete" : "directory_remove_failed"}:${error?.message ?? String(error)}${rollbackIntegrity.ok ? "" : `:${rollbackIntegrity.reason}`}`,
      quarantinePath: moved ? quarantinePath : null,
    };
  }
}

export function removeExactManagedDirectory(action, options) {
  if (action.manifestManaged !== true) {
    return { success: false, preserved: true, reason: "missing_directory_identity" };
  }
  return quarantineAndRemoveExactDirectory(action, inspectManagedDirectoryClosure, options);
}

function allDirectoryAncestorsArePlain(targetPath) {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  const relative = path.relative(pathKey(root), pathKey(resolved));
  const segments = relative ? relative.split(path.sep) : [];
  let cursor = root;
  for (const segment of [null, ...segments]) {
    if (segment) cursor = path.join(cursor, segment);
    let stats;
    let real;
    try {
      stats = lstatSync(cursor);
      real = realpathSync.native(cursor);
    } catch {
      return false;
    }
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      pathKey(real) !== pathKey(cursor)
    ) return false;
  }
  return true;
}

function portableRelative(fromPath, targetPath) {
  return path.relative(fromPath, targetPath).replaceAll("\\", "/");
}

function safeFirstPartyRelativePath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) return null;
  return normalized;
}

function firstPartyClosureSync(packageRoot, filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return null;
  const normalizedPaths = filePaths.map(safeFirstPartyRelativePath);
  if (normalizedPaths.some((entry) => !entry)) return null;
  const sortedPaths = [...new Set(normalizedPaths)].sort((left, right) =>
    left.localeCompare(right)
  );
  if (
    sortedPaths.length !== normalizedPaths.length ||
    JSON.stringify(sortedPaths) !== JSON.stringify(normalizedPaths)
  ) return null;

  const actualPaths = [];
  const walk = (currentPath, relativeParent = "") => {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = `${relativeParent}/${entry.name}`.replace(/^\//u, "");
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink()) throw new Error("first_party_link");
      if (stats.isDirectory()) walk(absolutePath, relativePath);
      else if (stats.isFile()) actualPaths.push(relativePath.replaceAll("\\", "/"));
      else throw new Error("first_party_unsupported_type");
    }
  };
  try {
    const packageStats = lstatSync(packageRoot);
    if (packageStats.isSymbolicLink() || !packageStats.isDirectory()) return null;
    walk(packageRoot);
  } catch {
    return null;
  }
  actualPaths.sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualPaths) !== JSON.stringify(sortedPaths)) return null;

  const entries = [];
  try {
    for (const relativePath of sortedPaths) {
      const absolutePath = path.resolve(packageRoot, relativePath);
      if (!pathAtOrWithin(packageRoot, absolutePath)) return null;
      let cursor = packageRoot;
      const segments = relativePath.split("/");
      for (const [index, segment] of segments.entries()) {
        cursor = path.join(cursor, segment);
        const stats = lstatSync(cursor);
        const isLast = index === segments.length - 1;
        if (
          stats.isSymbolicLink() ||
          (isLast ? !stats.isFile() : !stats.isDirectory())
        ) return null;
      }
      const bytes = readFileSync(absolutePath);
      entries.push({
        path: relativePath,
        size: bytes.length,
        sha256: sha256Bytes(bytes),
      });
    }
  } catch {
    return null;
  }
  return {
    entryCount: entries.length,
    sha256: sha256Bytes(Buffer.from(JSON.stringify(entries), "utf8")),
  };
}

function proofCurrentPath(action, rootPath, proof) {
  const relativePath = path.relative(action.path, proof.path);
  if (!relativePath || path.isAbsolute(relativePath) || relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)) return null;
  return path.join(rootPath, relativePath);
}

function inspectPrimaryProjectionReceipt(action, rootPath) {
  let topLevel;
  try {
    topLevel = readdirSync(rootPath, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory(), file: entry.isFile() }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return { ok: false, reason: "projection_receipt_unreadable" };
  }
  if (
    topLevel.length !== 2 ||
    topLevel[0]?.name !== "bundle" ||
    topLevel[0]?.dir !== true ||
    topLevel[1]?.name !== "receipt.json" ||
    topLevel[1]?.file !== true
  ) {
    return { ok: false, reason: "projection_receipt_layout_drift" };
  }

  const proofByRole = new Map(action.proofFiles.map((proof) => [proof.role, proof]));
  const receiptProof = proofByRole.get("receipt");
  const receiptPath = receiptProof && proofCurrentPath(action, rootPath, receiptProof);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    return { ok: false, reason: "projection_receipt_invalid_json" };
  }
  if (receipt?.schemaVersion !== PROJECTION_PACKAGE_RECEIPT_SCHEMA) {
    return { ok: false, reason: "projection_receipt_schema_mismatch" };
  }
  const rule = GLOBAL_REMOVAL_POLICY.projectionPackageStore;
  const packageName = rule.packageName;
  const version = path.basename(path.dirname(action.path));
  const digest = path.basename(action.path);
  const packageSegments = packageName.split("/");
  let packageCursor = path.dirname(path.dirname(action.path));
  for (const segment of [...packageSegments].reverse()) {
    if (path.basename(packageCursor) !== segment) {
      return { ok: false, reason: "projection_receipt_layout_mismatch" };
    }
    packageCursor = path.dirname(packageCursor);
  }
  if (
    receipt.packageName !== packageName ||
    receipt.packageVersion !== version ||
    receipt.packageTarballSha256 !== digest ||
    !PACKAGE_VERSION_RE.test(version) ||
    !SHA256_RE.test(digest)
  ) {
    return { ok: false, reason: "projection_receipt_identity_mismatch" };
  }

  const originalBundleDir = path.join(action.path, "bundle");
  const originalPackageRoot = path.join(
    originalBundleDir,
    "node_modules",
    ...packageSegments,
  );
  const currentBundleDir = path.join(rootPath, "bundle");
  const currentPackageRoot = path.join(
    currentBundleDir,
    "node_modules",
    ...packageSegments,
  );
  if (
    receipt.bundleRelativePath !== "bundle" ||
    receipt.packageRootRelative !== portableRelative(action.path, originalPackageRoot)
  ) {
    return { ok: false, reason: "projection_receipt_layout_mismatch" };
  }

  let packageManifest;
  const packageManifestPath = path.join(currentPackageRoot, "package.json");
  try {
    packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  } catch {
    return { ok: false, reason: "projection_package_manifest_invalid" };
  }
  const cliRelative = resolveProjectionPackageCli(packageManifest);
  if (
    packageManifest.name !== packageName ||
    packageManifest.version !== version ||
    !cliRelative
  ) {
    return { ok: false, reason: "projection_package_identity_mismatch" };
  }

  const originalKeyPaths = {
    packageManifest: path.join(originalPackageRoot, "package.json"),
    publicCli: path.resolve(originalPackageRoot, cliRelative),
    globalSyncScript: path.join(
      originalPackageRoot,
      "scripts",
      "sync-global-meta-theory.mjs",
    ),
  };
  const currentKeyPaths = {
    packageManifest: packageManifestPath,
    publicCli: path.resolve(currentPackageRoot, cliRelative),
    globalSyncScript: path.join(
      currentPackageRoot,
      "scripts",
      "sync-global-meta-theory.mjs",
    ),
  };
  const expectedProofPaths = {
    receipt: path.join(action.path, "receipt.json"),
    "package-manifest": originalKeyPaths.packageManifest,
    cli: originalKeyPaths.publicCli,
    "sync-script": originalKeyPaths.globalSyncScript,
  };
  for (const [role, expectedPath] of Object.entries(expectedProofPaths)) {
    if (pathKey(proofByRole.get(role)?.path ?? "") !== pathKey(expectedPath)) {
      return { ok: false, reason: "projection_receipt_proof_path_mismatch" };
    }
  }
  for (const [key, originalPath] of Object.entries(originalKeyPaths)) {
    const recorded = receipt.keyFiles?.[key];
    let bytes;
    try {
      bytes = readFileSync(currentKeyPaths[key]);
    } catch {
      return { ok: false, reason: "projection_receipt_key_file_missing" };
    }
    if (
      recorded?.relativePath !== portableRelative(action.path, originalPath) ||
      recorded.size !== bytes.length ||
      recorded.sha256 !== sha256Bytes(bytes)
    ) {
      return { ok: false, reason: "projection_receipt_key_file_drift" };
    }
  }

  const firstPartyClosure = firstPartyClosureSync(
    currentPackageRoot,
    receipt.firstPartyFiles,
  );
  if (
    !firstPartyClosure ||
    !SHA256_RE.test(receipt.firstPartyClosure?.sha256 ?? "") ||
    !Number.isInteger(receipt.firstPartyClosure?.entryCount) ||
    receipt.firstPartyClosure.entryCount < 1 ||
    receipt.firstPartyClosure.sha256 !== firstPartyClosure.sha256 ||
    receipt.firstPartyClosure.entryCount !== firstPartyClosure.entryCount
  ) {
    return { ok: false, reason: "projection_receipt_first_party_drift" };
  }
  const bundleClosure = directoryClosureSync(currentBundleDir);
  if (
    !bundleClosure ||
    bundleClosure.sha256 !== receipt.bundleClosure?.sha256 ||
    bundleClosure.entryCount !== receipt.bundleClosure?.entryCount
  ) {
    return { ok: false, reason: "projection_receipt_bundle_drift" };
  }
  return { ok: true };
}

function inspectManagedBundle(action, rootPath = action.path) {
  const requiredProofRoles = REQUIRED_BUNDLE_PROOF_ROLES_BY_PURPOSE.get(
    action.purpose,
  );
  const requiredSource = BUNDLE_SOURCE_BY_PURPOSE.get(action.purpose);
  if (
    action.manifestManaged !== true ||
    !requiredProofRoles ||
    action.source !== requiredSource ||
    !action.closureSha256 ||
    !Number.isInteger(action.closureEntryCount)
  ) {
    return { ok: false, reason: "missing_bundle_identity" };
  }
  let rootStats;
  try {
    rootStats = lstatSync(rootPath);
  } catch {
    return { ok: false, reason: "bundle_missing" };
  }
  if (
    rootStats.isSymbolicLink() ||
    !rootStats.isDirectory() ||
    !allDirectoryAncestorsArePlain(rootPath)
  ) {
    return { ok: false, reason: "unsafe_bundle_root_type" };
  }
  if (
    !Array.isArray(action.proofFiles) ||
    action.proofFiles.length < requiredProofRoles.size ||
    (
      action.purpose === PRIMARY_PROJECTION_BUNDLE_PURPOSE &&
      action.proofFiles.length !== requiredProofRoles.size
    )
  ) {
    return { ok: false, reason: "missing_bundle_proof" };
  }
  const roles = new Set(action.proofFiles.map((proof) => proof.role));
  if (
    roles.size !== action.proofFiles.length ||
    [...requiredProofRoles].some((role) => !roles.has(role))
  ) {
    return { ok: false, reason: "invalid_bundle_proof_roles" };
  }
  for (const proof of action.proofFiles) {
    if (
      proof.kind !== "file" ||
      proof.source !== action.source ||
      !proof.sha256 ||
      !Number.isFinite(proof.size) ||
      !isStrictDescendant(action.path, proof.path)
    ) {
      return { ok: false, reason: "invalid_bundle_proof" };
    }
    const relativePath = path.relative(action.path, proof.path);
    const currentPath = path.join(rootPath, relativePath);
    let bytes;
    try {
      const segments = relativePath.split(path.sep);
      let cursor = rootPath;
      for (const [index, segment] of segments.entries()) {
        cursor = path.join(cursor, segment);
        const stats = lstatSync(cursor);
        const isLast = index === segments.length - 1;
        if (
          stats.isSymbolicLink() ||
          (isLast ? !stats.isFile() : !stats.isDirectory())
        ) {
          return { ok: false, reason: "unsafe_bundle_proof_type" };
        }
      }
      bytes = readFileSync(currentPath);
    } catch {
      return { ok: false, reason: "bundle_proof_missing" };
    }
    if (bytes.length !== proof.size || sha256Bytes(bytes) !== proof.sha256) {
      return { ok: false, reason: "bundle_proof_drift" };
    }
  }
  if (action.purpose === PRIMARY_PROJECTION_BUNDLE_PURPOSE) {
    const receipt = inspectPrimaryProjectionReceipt(action, rootPath);
    if (!receipt.ok) return receipt;
  }
  const closure = directoryClosureSync(rootPath);
  if (
    !closure ||
    closure.entryCount !== action.closureEntryCount ||
    closure.sha256 !== action.closureSha256
  ) {
    return { ok: false, reason: "bundle_closure_drift" };
  }
  return { ok: true };
}

export function removeExactManagedRuntimeBundle(action, options) {
  return quarantineAndRemoveExactDirectory(action, inspectManagedBundle, options);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const valueOf = (name) => {
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? (args[idx + 1] ?? null) : null;
  };

  const rawScope = valueOf("scope") || "both";
  if (!["global", "project", "both"].includes(rawScope)) {
    console.error(`meta-kim uninstall: invalid scope '${rawScope}'; expected global, project, or both`);
    process.exitCode = 2;
    return;
  }
  const scope = rawScope;
  const apply = flag("yes");
  const deep = flag("deep");
  const purgeProjectAgents = flag("purge-project-agents");
  const recover = flag("recover");
  const useManifest = !recover && !flag("no-manifest");
  const lang = resolveLang(valueOf("lang"));
  const t = MSG[lang] || MSG.en;

  const repoRoot = REPO_ROOT;

  const { actions, source, blockedReasons } = planActions({
    scope,
    repoRoot,
    deep,
    purgeProjectAgents,
    useManifest,
    recover,
  });

  if (blockedReasons.length > 0) {
    console.error(`${C.red}${t.manifestBlocked(blockedReasons)}${C.reset}`);
    process.exitCode = 1;
    return;
  }

  const lines = [];
  lines.push(`${C.bold}${C.cyan}${t.title}${C.reset}`);
  lines.push(
    apply
      ? `${C.yellow}${t.liveNote}${C.reset}`
      : `${C.dim}${t.dryNote}${C.reset}`,
  );
  lines.push(
    `${C.dim}${source === "manifest" ? t.sourceManifest : source === "recovery" ? t.sourceRecovery : t.sourceScan}${C.reset}`,
  );
  if (source === "recovery") lines.push(`${C.yellow}${t.recoveryBoundary}${C.reset}`);
  if (!purgeProjectAgents)
    lines.push(`${C.dim}${t.projectAgentsKept}${C.reset}`);
  if (!deep) lines.push(`${C.dim}${t.deepOff}${C.reset}`);

  if (actions.length === 0) {
    lines.push(
      `${source === "recovery" ? C.yellow : C.green}${source === "recovery" ? t.recoveryNone : t.summaryNone}${C.reset}`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  lines.push("");
  lines.push(`${C.bold}${t.planHeader}${C.reset}`);
  for (const a of actions) lines.push(describe(a, t));
  lines.push("");
  lines.push(`${C.dim}${t.summary(actions.length)}${C.reset}`);
  process.stdout.write(`${lines.join("\n")}\n`);

  if (!apply) {
    process.stdout.write(`\n${C.yellow}${t.confirmNeeded}${C.reset}\n`);
    return;
  }

  let removedCount = 0;
  let strippedTotal = 0;
  let hadFailure = false;
  let mcpCleanupFailed = false;
  const primaryProjectionReferenceCleanupFailures = [];
  const recordPrimaryReferenceFailure = (action, result) => {
    if (action.primaryProjectionReferenceCleanup !== true || result.success) return;
    primaryProjectionReferenceCleanupFailures.push(
      `${action.kind}:${action.path}:${result.reason ?? "unknown"}`,
    );
  };
  for (const a of actions) {
    if (
      a.kind === "strip-settings" ||
      a.kind === "strip-mcp" ||
      a.kind === "revert-toml-fragments"
    ) {
      if (!existsSync(a.path)) continue;
      const result = a.kind === "strip-mcp"
        ? removeManagedMcpFragmentFromFile(a)
        : a.kind === "revert-toml-fragments"
          ? revertManagedTomlFragments(a)
          : stripManagedSettingsFile(a);
      const { success, stripped, backupPath } = result;
      if (success) {
        strippedTotal += stripped;
        console.log(
          `${C.green}✓ ${t.actStripSettings(a.path, stripped)}${C.reset}`,
        );
        if (backupPath)
          console.log(`${C.dim}${t.backupDone(backupPath)}${C.reset}`);
      } else {
        hadFailure = true;
        recordPrimaryReferenceFailure(a, result);
        if (a.kind === "strip-mcp") mcpCleanupFailed = true;
        if (result.reason === "invalid_json") {
          console.error(`${C.yellow}${t.settingsParseFailed(a.path)}${C.reset}`);
        } else if (a.kind === "strip-mcp" && (
          result.reason === "managed_fragment_changed" ||
          result.reason?.startsWith("concurrent_change")
        )) {
          console.error(`${C.yellow}${t.preservedConcurrent(a.path)}${C.reset}`);
        } else {
          console.error(`${C.yellow}${t.writeFailed(a.path, result.reason)}${C.reset}`);
        }
        if (backupPath) {
          console.error(`${C.dim}${t.backupDone(backupPath)}${C.reset}`);
        }
      }
    } else if (a.kind === "remove-bundle") {
      const result = a.purpose === PRIMARY_PROJECTION_BUNDLE_PURPOSE &&
          primaryProjectionReferenceCleanupFailures.length > 0
        ? {
            success: false,
            preserved: true,
            reason: `projection_reference_cleanup_failed:${primaryProjectionReferenceCleanupFailures.join("|")}`,
          }
        : (
            a.purpose === DURABLE_MCP_BUNDLE_PURPOSE && mcpCleanupFailed
          )
          ? { success: false, preserved: true, reason: "mcp_cleanup_failed" }
          : removeExactManagedRuntimeBundle(a);
      if (result.success) {
        if (!result.missing) removedCount += 1;
      } else {
        hadFailure = true;
        const message = result.reason?.startsWith("projection_reference_cleanup_failed:")
          ? t.writeFailed(a.path, result.reason)
          : result.preserved
          ? t.preservedModified(a.path)
          : t.writeFailed(a.path, result.reason);
        console.error(`${C.yellow}${message}${C.reset}`);
      }
    } else if (a.kind === "remove") {
      const result = removeManagedFileIfUnchanged(a);
      if (result.success) {
        if (!result.missing) removedCount += 1;
      } else if (result.preserved) {
        hadFailure = true;
        recordPrimaryReferenceFailure(a, result);
        const message = result.reason === "missing_integrity"
          ? t.preservedUnverifiable(a.path)
          : t.preservedModified(a.path);
        console.error(`${C.yellow}${message}${C.reset}`);
      } else {
        hadFailure = true;
        recordPrimaryReferenceFailure(a, result);
        console.error(`${C.yellow}${t.writeFailed(a.path, result.reason)}${C.reset}`);
      }
    }
  }
  const finalMessage = hadFailure
    ? `${C.yellow}${t.partialDelta(removedCount, strippedTotal)}${C.reset}`
    : `${C.green}${t.doneDelta(removedCount, strippedTotal)}${C.reset}`;
  process.stdout.write(`\n${finalMessage}\n`);
  if (hadFailure) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("uninstall.mjs")) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}
