import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, "..");
export const canonicalRoot = path.join(repoRoot, "canonical");
export const canonicalAgentsDir = path.join(canonicalRoot, "agents");
export const canonicalSkillRoot = path.join(
  canonicalRoot,
  "skills",
  "meta-theory",
);
export const canonicalSkillPath = path.join(canonicalSkillRoot, "SKILL.md");
export const canonicalSkillReferencesDir = path.join(
  canonicalSkillRoot,
  "references",
);
export const canonicalRuntimeAssetsDir = path.join(
  canonicalRoot,
  "runtime-assets",
);
export const canonicalCapabilityIndexDir = path.join(
  repoRoot,
  "config",
  "capability-index",
);
export const syncManifestPath = path.join(repoRoot, "config", "sync.json");
export const localOverridesPath = path.join(
  repoRoot,
  ".meta-kim",
  "local.overrides.json",
);
export const supportedTargetIds = ["claude", "codex", "openclaw", "cursor"];

const runtimeProfileCatalog = {
  claude: {
    schemaVersion: 1,
    id: "claude",
    label: "Claude Code",
    projection: {
      supportsRepoProjection: true,
      supportsLocalActivation: true,
      assetTypes: [
        "agents",
        "skills",
        "hooks",
        "config",
        "mcp",
        "capabilityIndex",
      ],
      outputPaths: {
        agentsDir: ".claude/agents",
        skillRoot: ".claude/skills/meta-theory",
        hooksDir: ".claude/hooks",
        settingsFile: ".claude/settings.json",
        mcpFile: ".mcp.json",
        capabilityIndexDir: ".claude/capability-index",
      },
    },
    activation: {
      supportsGlobalSkillSync: true,
      supportsGlobalDependencyInstall: true,
      supportsGlobalHooks: true,
      envKeys: ["META_KIM_CLAUDE_HOME", "CLAUDE_HOME"],
      defaultHomeDir: ".claude",
    },
  },
  codex: {
    schemaVersion: 1,
    id: "codex",
    label: "Codex",
    projection: {
      supportsRepoProjection: true,
      supportsLocalActivation: true,
      assetTypes: ["agents", "skills", "hooks", "commands", "config", "mcp"],
      outputPaths: {
        agentsDir: ".codex/agents",
        skillRoot: ".codex/skills/meta-theory",
        commandsDir: ".codex/commands",
        configExampleFile: "codex/config.toml.example",
      },
    },
    activation: {
      supportsGlobalSkillSync: true,
      supportsGlobalDependencyInstall: true,
      supportsGlobalHooks: true,
      envKeys: ["META_KIM_CODEX_HOME", "CODEX_HOME"],
      defaultHomeDir: ".codex",
    },
  },
  openclaw: {
    schemaVersion: 1,
    id: "openclaw",
    label: "OpenClaw",
    projection: {
      supportsRepoProjection: true,
      supportsLocalActivation: true,
      assetTypes: ["workspaces", "skills", "hooks", "config", "mcp"],
      outputPaths: {
        workspacesDir: "openclaw/workspaces",
        skillRoot: "openclaw/skills/meta-theory",
        templateConfigFile: "openclaw/openclaw.template.json",
      },
    },
    activation: {
      supportsGlobalSkillSync: true,
      supportsGlobalDependencyInstall: true,
      supportsGlobalHooks: true,
      envKeys: ["META_KIM_OPENCLAW_HOME", "OPENCLAW_HOME"],
      defaultHomeDir: ".openclaw",
    },
  },
  cursor: {
    schemaVersion: 1,
    id: "cursor",
    label: "Cursor",
    projection: {
      supportsRepoProjection: true,
      supportsLocalActivation: true,
      assetTypes: ["agents", "skills", "hooks", "mcp"],
      outputPaths: {
        agentsDir: ".cursor/agents",
        skillRoot: ".cursor/skills/meta-theory",
        mcpFile: ".cursor/mcp.json",
      },
    },
    activation: {
      supportsGlobalSkillSync: true,
      supportsGlobalDependencyInstall: true,
      supportsGlobalHooks: true,
      envKeys: ["META_KIM_CURSOR_HOME", "CURSOR_HOME"],
      defaultHomeDir: ".cursor",
    },
  },
};

export async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function parseTargetsArg(argv = process.argv.slice(2)) {
  const joinedValues = [];
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--targets" && argv[index + 1]) {
      joinedValues.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (current.startsWith("--targets=")) {
      joinedValues.push(current.slice("--targets=".length));
    }
  }

  if (joinedValues.length === 0) {
    return [];
  }

  return normalizeTargets(joinedValues.join(",").split(","));
}

/**
 * Parse `--skills=id1,id2` / `--skills id1,id2` / `META_KIM_SKILL_IDS`.
 * Returns null if unset (caller should treat as “all manifest skills”),
 * or a list (possibly empty) when explicitly constrained.
 */
export function parseSkillsArg(argv = process.argv.slice(2)) {
  const env = process.env.META_KIM_SKILL_IDS;
  if (typeof env === "string" && env.trim()) {
    return env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const joined = [];
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--skills" && argv[index + 1] !== undefined) {
      joined.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (current.startsWith("--skills=")) {
      joined.push(current.slice("--skills=".length));
    }
  }

  const result = joined
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (result.length === 0) {
    return null;
  }

  return result;
}

export function normalizeTargets(rawTargets) {
  const seen = new Set();
  const normalized = [];

  for (const rawTarget of rawTargets || []) {
    const target = String(rawTarget || "")
      .trim()
      .toLowerCase();
    if (!target) {
      continue;
    }
    if (!supportedTargetIds.includes(target)) {
      throw new Error(
        `Unknown runtime target: ${target}. Expected one of ${supportedTargetIds.join(", ")}`,
      );
    }
    if (seen.has(target)) {
      continue;
    }
    seen.add(target);
    normalized.push(target);
  }

  return normalized;
}

function cloneRuntimeProfile(profile) {
  return JSON.parse(JSON.stringify(profile));
}

export async function loadRuntimeProfiles(manifest = null) {
  const resolvedManifest = manifest ?? (await loadSyncManifest());
  const declaredTargets =
    resolvedManifest.supportedTargets?.length > 0
      ? normalizeTargets(resolvedManifest.supportedTargets)
      : [...supportedTargetIds];
  const profiles = {};

  for (const targetId of declaredTargets) {
    const profile = runtimeProfileCatalog[targetId];
    if (!profile) {
      throw new Error(`Missing runtime catalog entry: ${targetId}`);
    }
    const clonedProfile = cloneRuntimeProfile(profile);
    validateRuntimeProfile(clonedProfile, targetId);
    profiles[targetId] = clonedProfile;
  }

  return profiles;
}

export async function loadSyncManifest() {
  const manifest = JSON.parse(await fs.readFile(syncManifestPath, "utf8"));
  validateSyncManifest(manifest);
  return manifest;
}

export async function loadLocalOverrides() {
  const overrides = await readJsonIfExists(localOverridesPath);
  if (!overrides) {
    return {};
  }

  if (overrides.activeTargets != null) {
    overrides.activeTargets = normalizeTargets(overrides.activeTargets);
  }

  return overrides;
}

export async function ensureLocalOverridesDir() {
  await fs.mkdir(path.dirname(localOverridesPath), { recursive: true });
}

export async function writeLocalOverrides(nextOverrides) {
  await ensureLocalOverridesDir();
  const payload = { ...nextOverrides };
  if (payload.activeTargets != null) {
    payload.activeTargets = normalizeTargets(payload.activeTargets);
  }
  await fs.writeFile(
    localOverridesPath,
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

export async function resolveTargetContext(argv = process.argv.slice(2)) {
  const cliTargets = parseTargetsArg(argv);
  const [manifest, localOverrides] = await Promise.all([
    loadSyncManifest(),
    loadLocalOverrides(),
  ]);
  const profiles = await loadRuntimeProfiles(manifest);

  const availableTargets =
    manifest.availableTargets?.length > 0
      ? normalizeTargets(manifest.availableTargets)
      : Object.keys(profiles).sort();
  const supportedTargets =
    manifest.supportedTargets?.length > 0
      ? normalizeTargets(manifest.supportedTargets)
      : availableTargets;
  const defaultTargets =
    manifest.defaultTargets?.length > 0
      ? normalizeTargets(manifest.defaultTargets)
      : supportedTargets;
  const activeTargets =
    cliTargets.length > 0
      ? cliTargets
      : localOverrides.activeTargets?.length > 0
        ? normalizeTargets(localOverrides.activeTargets)
        : defaultTargets;

  return {
    profiles,
    manifest,
    localOverrides,
    availableTargets,
    supportedTargets,
    defaultTargets,
    activeTargets,
    cliTargets,
  };
}

// ── Path resolution ─────────────────────────────────────────

const runtimeHomeSpecs = {
  claude: {
    envKeys: ["META_KIM_CLAUDE_HOME", "CLAUDE_HOME"],
    defaultDir: ".claude",
  },
  codex: {
    envKeys: ["META_KIM_CODEX_HOME", "CODEX_HOME"],
    defaultDir: ".codex",
  },
  openclaw: {
    envKeys: ["META_KIM_OPENCLAW_HOME", "OPENCLAW_HOME"],
    defaultDir: ".openclaw",
  },
  cursor: {
    envKeys: ["META_KIM_CURSOR_HOME", "CURSOR_HOME"],
    defaultDir: ".cursor",
  },
};

const runtimeProjectionLayouts = {
  claude: {
    project: {
      agentsDir: [".claude", "agents"],
      skillRoot: [".claude", "skills", "meta-theory"],
      hooksDir: [".claude", "hooks"],
      settingsFile: [".claude", "settings.json"],
      mcpFile: [".mcp.json"],
    },
    global: {
      agentsDir: ["agents"],
      skillRoot: ["skills", "meta-theory"],
      hooksDir: ["hooks", "meta-kim"],
      settingsFile: ["settings.json"],
      mcpFile: null,
    },
  },
  codex: {
    project: {
      agentsDir: [".codex", "agents"],
      skillRoot: [".codex", "skills", "meta-theory"],
      legacySkillFile: [".codex", "skills", "meta-theory.md"],
      legacySkillReferencesDir: [".codex", "skills", "references"],
      hooksDir: [".codex", "hooks"],
      hooksFile: [".codex", "hooks.json"],
      commandsDir: [".codex", "commands"],
      configExampleFile: ["codex", "config.toml.example"],
    },
    global: {
      agentsDir: ["agents"],
      skillRoot: ["skills", "meta-theory"],
      hooksDir: ["hooks"],
      hooksFile: ["hooks.json"],
      commandsDir: ["commands"],
      configExampleFile: ["config.toml.example"],
    },
  },
  openclaw: {
    project: {
      workspacesRoot: ["openclaw", "workspaces"],
      skillRoot: ["openclaw", "skills", "meta-theory"],
      legacySkillFile: ["openclaw", "skills", "meta-theory.md"],
      legacySkillReferencesDir: ["openclaw", "skills", "references"],
      hooksDir: ["openclaw", "hooks"],
      templateConfigFile: ["openclaw", "openclaw.template.json"],
    },
    global: {
      workspacesRoot: [],
      skillRoot: ["skills", "meta-theory"],
      hooksDir: ["hooks"],
      templateConfigFile: ["openclaw.template.json"],
    },
  },
  cursor: {
    project: {
      agentsDir: [".cursor", "agents"],
      skillRoot: [".cursor", "skills", "meta-theory"],
      hooksDir: [".cursor", "hooks"],
      hooksFile: [".cursor", "hooks.json"],
      mcpFile: [".cursor", "mcp.json"],
    },
    global: {
      agentsDir: ["agents"],
      skillRoot: ["skills", "meta-theory"],
      hooksDir: ["hooks"],
      hooksFile: ["hooks.json"],
      mcpFile: ["mcp.json"],
    },
  },
};

function normalizeProjectionScope(scope) {
  return scope === "global" ? "global" : "project";
}

function joinProjectionPath(baseDir, segments) {
  if (!Array.isArray(segments)) {
    return null;
  }
  if (segments.length === 0) {
    return baseDir;
  }
  return path.join(baseDir, ...segments);
}

function relativeProjectionLabel(segments) {
  if (!Array.isArray(segments)) {
    return null;
  }
  if (segments.length === 0) {
    return ".";
  }
  return segments.join("/").replace(/\\/g, "/");
}

export function resolveRuntimeHomeInfo(runtimeId) {
  const spec = runtimeHomeSpecs[runtimeId];
  if (!spec) {
    throw new Error(`Unknown runtime: ${runtimeId}`);
  }

  for (const key of spec.envKeys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return {
        dir: path.resolve(value.trim()),
        source: `env:${key}`,
      };
    }
  }

  return {
    dir: path.join(os.homedir(), spec.defaultDir),
    source: "default",
  };
}

/** Home directory resolver for each runtime. Priority: env var > ~/.runtime */
export function resolveRuntimeHomeDir(runtimeId) {
  return resolveRuntimeHomeInfo(runtimeId).dir;
}

export function resolveRuntimeProjection(
  runtimeId,
  scope = "project",
  options = {},
) {
  const normalizedScope = normalizeProjectionScope(scope);
  const layout = runtimeProjectionLayouts[runtimeId]?.[normalizedScope];
  if (!layout) {
    throw new Error(
      `Missing projection layout for runtime ${runtimeId} (${normalizedScope})`,
    );
  }

  const projectRoot = options.projectRoot ?? repoRoot;
  const baseDir =
    normalizedScope === "global"
      ? resolveRuntimeHomeDir(runtimeId)
      : projectRoot;

  const resolved = {
    runtimeId,
    scope: normalizedScope,
    baseDir,
    display: {},
  };

  for (const [key, segments] of Object.entries(layout)) {
    resolved[key] = joinProjectionPath(baseDir, segments);
    resolved.display[key] =
      normalizedScope === "global"
        ? resolved[key]
        : relativeProjectionLabel(segments);
  }

  if (runtimeId === "openclaw") {
    resolved.workspaceDir = (agentId) =>
      normalizedScope === "global"
        ? path.join(baseDir, `workspace-${agentId}`)
        : path.join(baseDir, "openclaw", "workspaces", agentId);
    resolved.displayWorkspaceDir = (agentId) =>
      normalizedScope === "global"
        ? path.join(baseDir, `workspace-${agentId}`)
        : `openclaw/workspaces/${agentId}`;
  }

  return resolved;
}

export function resolveRuntimeProjectionRoots(scope = "project", options = {}) {
  const normalizedScope = normalizeProjectionScope(scope);
  return supportedTargetIds.reduce((accumulator, runtimeId) => {
    accumulator[runtimeId] = resolveRuntimeProjection(
      runtimeId,
      normalizedScope,
      options,
    );
    return accumulator;
  }, {});
}

export function resolveRuntimeAllowedRoots(scope = "project", options = {}) {
  const normalizedScope = normalizeProjectionScope(scope);
  if (normalizedScope === "global") {
    return supportedTargetIds.map((runtimeId) =>
      resolveRuntimeHomeDir(runtimeId),
    );
  }
  return [options.projectRoot ?? repoRoot];
}

/**
 * Parse --scope CLI argument.
 * @returns "project" | "global" | "both"
 */
export function parseScopeArg(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--scope" && argv[i + 1]) {
      const scope = argv[i + 1];
      if (!["project", "global", "both"].includes(scope)) {
        throw new Error(
          `Invalid --scope value: ${scope}. Expected: project|global|both`,
        );
      }
      return scope;
    }
    if (argv[i].startsWith("--scope=")) {
      const scope = argv[i].slice("--scope=".length);
      if (!["project", "global", "both"].includes(scope)) {
        throw new Error(
          `Invalid --scope value: ${scope}. Expected: project|global|both`,
        );
      }
      return scope;
    }
  }
  return "project"; // Default: write to repo-local
}

/**
 * Safety check: assert path is within allowed home directories.
 * Throws if targetPath escapes allowedRoots.
 */
export function assertHomeBound(targetPath, allowedRoots) {
  const resolved = path.resolve(targetPath);
  const isAllowed = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );
  if (!isAllowed) {
    throw new Error(
      `Refusing to write outside configured runtime homes: ${resolved}`,
    );
  }
}

// ── Manifest & runtime target validation ──────────────────────────

export function validateSyncManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("sync manifest must be an object");
  }
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    throw new Error("sync manifest schemaVersion must be an integer >= 1");
  }
  if (manifest.supportedTargets != null) {
    normalizeTargets(manifest.supportedTargets);
  }
  if (manifest.defaultTargets != null) {
    normalizeTargets(manifest.defaultTargets);
  }
  if (manifest.availableTargets != null) {
    normalizeTargets(manifest.availableTargets);
  }
  if (!manifest.canonicalRoots || typeof manifest.canonicalRoots !== "object") {
    throw new Error("sync manifest canonicalRoots must exist");
  }
  for (const key of [
    "agents",
    "skills",
    "runtimeAssets",
    "contracts",
    "capabilityIndex",
  ]) {
    if (
      typeof manifest.canonicalRoots[key] !== "string" ||
      !manifest.canonicalRoots[key].trim()
    ) {
      throw new Error(
        `sync manifest canonicalRoots.${key} must be a non-empty string`,
      );
    }
  }
}

export function validateRuntimeProfile(profile, sourceName = "<unknown>") {
  if (!profile || typeof profile !== "object") {
    throw new Error(`runtime profile ${sourceName} must be an object`);
  }
  if (!Number.isInteger(profile.schemaVersion) || profile.schemaVersion < 1) {
    throw new Error(
      `runtime profile ${sourceName} must declare schemaVersion >= 1`,
    );
  }
  if (
    typeof profile.id !== "string" ||
    !supportedTargetIds.includes(profile.id)
  ) {
    throw new Error(`runtime profile ${sourceName} has invalid id`);
  }
  if (!profile.projection || typeof profile.projection !== "object") {
    throw new Error(`runtime profile ${sourceName} is missing projection`);
  }
  if (
    !Array.isArray(profile.projection.assetTypes) ||
    profile.projection.assetTypes.length === 0
  ) {
    throw new Error(
      `runtime profile ${sourceName} must declare projection.assetTypes`,
    );
  }
  if (
    !profile.projection.outputPaths ||
    typeof profile.projection.outputPaths !== "object"
  ) {
    throw new Error(
      `runtime profile ${sourceName} must declare projection.outputPaths`,
    );
  }
  if (!profile.activation || typeof profile.activation !== "object") {
    throw new Error(`runtime profile ${sourceName} is missing activation`);
  }
  if (
    !Array.isArray(profile.activation.envKeys) ||
    profile.activation.envKeys.length === 0
  ) {
    throw new Error(
      `runtime profile ${sourceName} must declare activation.envKeys`,
    );
  }
  if (
    typeof profile.activation.defaultHomeDir !== "string" ||
    !profile.activation.defaultHomeDir.trim()
  ) {
    throw new Error(
      `runtime profile ${sourceName} must declare activation.defaultHomeDir`,
    );
  }
}
