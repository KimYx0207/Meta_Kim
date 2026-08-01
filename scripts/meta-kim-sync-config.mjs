import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = process.env.META_KIM_REPO_ROOT
  ? path.resolve(process.env.META_KIM_REPO_ROOT)
  : path.resolve(__dirname, "..");
export const canonicalRoot = path.join(repoRoot, "canonical");
export const canonicalAgentsDir = path.join(canonicalRoot, "agents");
export const canonicalSkillsDir = path.join(canonicalRoot, "skills");
export const canonicalSkillRoot = path.join(
  canonicalSkillsDir,
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
export const localStateRoot = process.env.META_KIM_CALLER_CWD
  ? path.resolve(process.env.META_KIM_CALLER_CWD)
  : path.resolve(process.cwd());
export const localOverridesPath = path.join(
  localStateRoot,
  ".meta-kim",
  "local.overrides.json",
);
export const supportedTargetIds = [
  "claude",
  "codex",
  "openclaw",
  "cursor",
  "opencode",
  "qwen",
  "zed",
  "gemini",
  "codebuddy",
  "antigravity",
  "joycode",
  "qoder",
];

export const GLOBAL_AGENT_MIGRATION_NONE = "none";
export const GLOBAL_AGENT_MIGRATION_HISTORICAL_CATALOG =
  "historical_fingerprint_catalog";
export const GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL = "sync-global-meta-theory";
export const GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES = "sync-runtimes";
export const GLOBAL_PROJECTION_OWNERS = Object.freeze([
  GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
  GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
]);

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
        "commands",
        "config",
        "mcp",
        "capabilityIndex",
      ],
      outputPaths: {
        agentsDir: ".claude/agents",
        skillsDir: ".claude/skills",
        skillRoot: ".claude/skills/meta-theory",
        hooksDir: ".claude/hooks",
        commandsDir: ".claude/commands",
        settingsFile: ".claude/settings.json",
        mcpFile: ".mcp.json",
        capabilityIndexDir: ".claude/capability-index",
      },
      globalAgentProjection: {
        supported: true,
        format: "markdown_frontmatter",
        renderer: "canonical_markdown",
        agentsDir: "agents",
        fileExtension: ".md",
        migrationSupport: GLOBAL_AGENT_MIGRATION_HISTORICAL_CATALOG,
      },
      globalAssetOwners: {
        agents: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        skills: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        hooks: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        commands: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        config: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        mcp: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        capabilityIndex: GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
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
      assetTypes: [
        "agents",
        "skills",
        "hooks",
        "commands",
        "config",
        "mcp",
        "capabilityIndex",
      ],
      outputPaths: {
        agentsDir: ".codex/agents",
        skillsDir: ".agents/skills",
        skillRoot: ".agents/skills/meta-theory",
        hooksDir: ".codex/hooks",
        hooksFile: ".codex/hooks.json",
        commandsDir: ".codex/commands",
        configFile: ".codex/config.toml",
        configExampleFile: "codex/config.toml.example",
        capabilityIndexDir: ".codex/capability-index",
      },
      globalAgentProjection: {
        supported: true,
        format: "codex_toml",
        renderer: "codex_toml",
        agentsDir: "agents",
        fileExtension: ".toml",
        migrationSupport: GLOBAL_AGENT_MIGRATION_HISTORICAL_CATALOG,
      },
      globalAssetOwners: {
        agents: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        skills: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        hooks: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        commands: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        config: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        mcp: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        capabilityIndex: GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
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
      assetTypes: [
        "workspaces",
        "skills",
        "hooks",
        "config",
        "mcp",
        "capabilityIndex",
      ],
      outputPaths: {
        workspacesDir: "openclaw/workspaces",
        skillsDir: "openclaw/skills",
        skillRoot: "openclaw/skills/meta-theory",
        templateConfigFile: "openclaw/openclaw.template.json",
        capabilityIndexDir: "openclaw/capability-index",
      },
      globalAgentProjection: {
        supported: false,
        format: "openclaw_workspace_bundle",
        renderer: "openclaw_workspace_bundle",
        agentsDir: null,
        fileExtension: null,
        migrationSupport: GLOBAL_AGENT_MIGRATION_NONE,
      },
      globalAssetOwners: {
        workspaces: GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
        skills: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        hooks: GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
        config: GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
        mcp: GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
        capabilityIndex: GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
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
      assetTypes: ["agents", "skills", "hooks", "mcp", "capabilityIndex", "rules"],
      outputPaths: {
        agentsDir: ".cursor/agents",
        skillsDir: ".cursor/skills",
        skillRoot: ".cursor/skills/meta-theory",
        hooksDir: ".cursor/hooks",
        hooksFile: ".cursor/hooks.json",
        mcpFile: ".cursor/mcp.json",
        capabilityIndexDir: ".cursor/capability-index",
        rulesDir: ".cursor/rules",
      },
      globalAgentProjection: {
        supported: true,
        format: "cursor_markdown",
        renderer: "cursor_markdown",
        agentsDir: "agents",
        fileExtension: ".md",
        migrationSupport: GLOBAL_AGENT_MIGRATION_HISTORICAL_CATALOG,
      },
      globalAssetOwners: {
        agents: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        skills: GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL,
        hooks: GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
        mcp: GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
        capabilityIndex: GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
        rules: GLOBAL_PROJECTION_OWNER_SYNC_RUNTIMES,
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
 * Returns null if unset (caller should treat as "all manifest skills"),
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
  let explicitCliFilter = false;
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--skills") {
      explicitCliFilter = true;
      if (argv[index + 1] !== undefined) {
        joined.push(argv[index + 1]);
        index += 1;
      }
      continue;
    }
    if (current.startsWith("--skills=")) {
      explicitCliFilter = true;
      joined.push(current.slice("--skills=".length));
    }
  }

  if (!explicitCliFilter) {
    return null;
  }

  return joined
    .join(",")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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

export function resolveRuntimeProfilesFromManifest(resolvedManifest) {
  validateSyncManifest(resolvedManifest);
  const declaredTargets =
    resolvedManifest.supportedTargets?.length > 0
      ? normalizeTargets(resolvedManifest.supportedTargets)
      : Object.keys(runtimeProfileCatalog);
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

export async function loadRuntimeProfiles(manifest = null) {
  const resolvedManifest = manifest ?? (await loadSyncManifest());
  return resolveRuntimeProfilesFromManifest(resolvedManifest);
}

export function resolveGlobalAgentProjectionTargets(
  profiles,
  targetIds = Object.keys(profiles ?? {}),
  { requireMigrationSupport = false } = {},
) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new Error("runtime profiles are required for global Agent projection discovery");
  }
  const targets = [];
  for (const targetId of [...new Set(targetIds)]) {
    const profile = profiles[targetId];
    if (!profile) {
      throw new Error(`Missing runtime profile for global Agent target: ${targetId}`);
    }
    const projection = profile.projection.globalAgentProjection;
    if (!projection.supported) continue;
    if (
      requireMigrationSupport &&
      projection.migrationSupport === GLOBAL_AGENT_MIGRATION_NONE
    ) {
      continue;
    }
    targets.push({
      targetId,
      label: profile.label,
      ...projection,
    });
  }
  return targets;
}

export function globalProjectionOwner(profile, assetType) {
  if (!profile || typeof profile !== "object") {
    throw new Error("A runtime profile is required for global projection ownership");
  }
  if (typeof assetType !== "string" || !assetType.trim()) {
    throw new Error("A global projection asset type is required");
  }
  const owner = profile.projection?.globalAssetOwners?.[assetType];
  if (!GLOBAL_PROJECTION_OWNERS.includes(owner)) {
    throw new Error(
      `Runtime profile ${profile.id ?? "unknown"} has no valid global owner for ${assetType}`,
    );
  }
  return owner;
}

export function globalProjectionIsOwnedBy(profile, assetType, owner) {
  if (!GLOBAL_PROJECTION_OWNERS.includes(owner)) {
    throw new Error(`Unknown global projection owner: ${owner}`);
  }
  return globalProjectionOwner(profile, assetType) === owner;
}

export function globalAgentProjectionFileName(projection, agentId) {
  if (!projection?.supported || typeof projection.fileExtension !== "string") {
    throw new Error("A supported global Agent projection is required");
  }
  if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(agentId)) {
    throw new Error(`Invalid global Agent id: ${agentId}`);
  }
  return `${agentId}${projection.fileExtension}`;
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
  opencode: {
    envKeys: ["META_KIM_OPENCODE_HOME", "OPENCODE_HOME"],
    defaultDir: ".opencode",
  },
  qwen: {
    envKeys: ["META_KIM_QWEN_HOME", "QWEN_HOME"],
    defaultDir: ".qwen",
  },
  zed: {
    envKeys: ["META_KIM_ZED_HOME", "ZED_HOME"],
    defaultDir: ".zed",
  },
  gemini: {
    envKeys: ["META_KIM_GEMINI_HOME", "GEMINI_HOME"],
    defaultDir: ".gemini",
  },
  codebuddy: {
    envKeys: ["META_KIM_CODEBUDDY_HOME", "CODEBUDDY_HOME"],
    defaultDir: ".codebuddy",
  },
  antigravity: {
    envKeys: ["META_KIM_ANTIGRAVITY_HOME", "ANTIGRAVITY_HOME"],
    defaultDir: ".agent",
  },
  joycode: {
    envKeys: ["META_KIM_JOYCODE_HOME", "JOYCODE_HOME"],
    defaultDir: ".joycode",
  },
  qoder: {
    envKeys: ["META_KIM_QODER_HOME", "QODER_HOME"],
    defaultDir: ".qoder",
  },
};

const runtimeProjectionLayouts = {
  claude: {
    project: {
      agentsDir: [".claude", "agents"],
      skillsDir: [".claude", "skills"],
      skillRoot: [".claude", "skills", "meta-theory"],
      hooksDir: [".claude", "hooks"],
      commandsDir: [".claude", "commands"],
      settingsFile: [".claude", "settings.json"],
      mcpFile: [".mcp.json"],
      capabilityIndexDir: [".claude", "capability-index"],
    },
    global: {
      agentsDir: ["agents"],
      skillsDir: ["skills"],
      skillRoot: ["skills", "meta-theory"],
      hooksRoot: ["hooks"],
      hooksDir: ["hooks", "meta-kim"],
      commandsDir: ["commands"],
      settingsFile: ["settings.json"],
      mcpFile: null,
      capabilityIndexDir: ["capability-index"],
    },
  },
  codex: {
    project: {
      agentsDir: [".codex", "agents"],
      skillsDir: [".agents", "skills"],
      skillRoot: [".agents", "skills", "meta-theory"],
      legacySkillRoot: [".codex", "skills", "meta-theory"],
      legacySkillFile: [".codex", "skills", "meta-theory.md"],
      legacySkillReferencesDir: [".codex", "skills", "references"],
      hooksDir: [".codex", "hooks"],
      hooksFile: [".codex", "hooks.json"],
      commandsDir: [".codex", "commands"],
      configFile: [".codex", "config.toml"],
      configExampleFile: ["codex", "config.toml.example"],
      capabilityIndexDir: [".codex", "capability-index"],
    },
    global: {
      agentsDir: ["agents"],
      skillsDir: ["skills"],
      skillRoot: ["skills", "meta-theory"],
      hooksRoot: ["hooks"],
      hooksDir: ["hooks", "meta-kim"],
      hooksFile: ["hooks.json"],
      commandsDir: ["commands"],
      configFile: ["config.toml"],
      configExampleFile: ["config.toml.example"],
      capabilityIndexDir: ["capability-index"],
    },
  },
  openclaw: {
    project: {
      workspacesRoot: ["openclaw", "workspaces"],
      skillsDir: ["openclaw", "skills"],
      skillRoot: ["openclaw", "skills", "meta-theory"],
      legacySkillFile: ["openclaw", "skills", "meta-theory.md"],
      legacySkillReferencesDir: ["openclaw", "skills", "references"],
      hooksDir: ["openclaw", "hooks"],
      templateConfigFile: ["openclaw", "openclaw.template.json"],
      capabilityIndexDir: ["openclaw", "capability-index"],
    },
    global: {
      workspacesRoot: [],
      skillsDir: ["skills"],
      skillRoot: ["skills", "meta-theory"],
      hooksDir: ["hooks"],
      templateConfigFile: ["openclaw.template.json"],
      capabilityIndexDir: ["capability-index"],
    },
  },
  cursor: {
    project: {
      agentsDir: [".cursor", "agents"],
      skillsDir: [".cursor", "skills"],
      skillRoot: [".cursor", "skills", "meta-theory"],
      hooksDir: [".cursor", "hooks"],
      hooksFile: [".cursor", "hooks.json"],
      mcpFile: [".cursor", "mcp.json"],
      capabilityIndexDir: [".cursor", "capability-index"],
      rulesDir: [".cursor", "rules"],
    },
    global: {
      agentsDir: ["agents"],
      skillsDir: ["skills"],
      skillRoot: ["skills", "meta-theory"],
      hooksRoot: ["hooks"],
      hooksDir: ["hooks", "meta-kim"],
      hooksFile: ["hooks.json"],
      mcpFile: ["mcp.json"],
      capabilityIndexDir: ["capability-index"],
      rulesDir: ["rules"],
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
  const projectedRealPath = (candidate) => {
    let cursor = path.resolve(candidate);
    const missing = [];
    while (true) {
      try {
        return path.join(realpathSync.native(cursor), ...missing.reverse());
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        missing.push(path.basename(cursor));
        cursor = parent;
      }
    }
  };
  const pathAtOrWithin = (root, candidate) => {
    const rel = path.relative(root, candidate);
    return rel === "" || (
      rel !== ".." &&
      !rel.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(rel)
    );
  };
  const realTarget = projectedRealPath(resolved);
  const realAllowed = allowedRoots.some((root) =>
    pathAtOrWithin(projectedRealPath(root), realTarget)
  );
  if (!realAllowed) {
    throw new Error(
      `Refusing to follow a symlink or junction outside configured runtime homes: ${resolved}`,
    );
  }
  const projectionStoreRoot = projectedRealPath(path.join(
    os.homedir(),
    ".meta-kim",
    "runtime",
    "projection-packages",
  ));
  if (pathAtOrWithin(projectionStoreRoot, realTarget)) {
    throw new Error(
      `Refusing to write a runtime projection into the immutable package store: ${resolved}`,
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
  if (manifest.canonicalRoots.skills !== "canonical/skills") {
    throw new Error("sync manifest canonicalRoots.skills must be canonical/skills");
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
  const globalAgentProjection = profile.projection.globalAgentProjection;
  if (!globalAgentProjection || typeof globalAgentProjection !== "object") {
    throw new Error(
      `runtime profile ${sourceName} must declare projection.globalAgentProjection`,
    );
  }
  for (const field of ["format", "renderer", "migrationSupport"]) {
    if (
      typeof globalAgentProjection[field] !== "string" ||
      !globalAgentProjection[field].trim()
    ) {
      throw new Error(
        `runtime profile ${sourceName} global Agent projection must declare ${field}`,
      );
    }
  }
  if (typeof globalAgentProjection.supported !== "boolean") {
    throw new Error(
      `runtime profile ${sourceName} global Agent projection must declare supported`,
    );
  }
  if (globalAgentProjection.supported) {
    if (!profile.projection.assetTypes.includes("agents")) {
      throw new Error(
        `runtime profile ${sourceName} supports global Agents but does not declare the agents asset type`,
      );
    }
    if (
      typeof globalAgentProjection.agentsDir !== "string" ||
      !globalAgentProjection.agentsDir.trim() ||
      path.isAbsolute(globalAgentProjection.agentsDir) ||
      globalAgentProjection.agentsDir.split(/[\\/]/u).includes("..")
    ) {
      throw new Error(
        `runtime profile ${sourceName} global Agent agentsDir must be a safe relative directory`,
      );
    }
    if (
      typeof globalAgentProjection.fileExtension !== "string" ||
      !/^\.[a-z0-9]+$/u.test(globalAgentProjection.fileExtension)
    ) {
      throw new Error(
        `runtime profile ${sourceName} global Agent fileExtension must be a simple extension`,
      );
    }
  } else if (
    globalAgentProjection.agentsDir !== null ||
    globalAgentProjection.fileExtension !== null ||
    globalAgentProjection.migrationSupport !== GLOBAL_AGENT_MIGRATION_NONE
  ) {
    throw new Error(
      `runtime profile ${sourceName} unsupported global Agent projection must use null paths and migrationSupport=none`,
    );
  }
  const globalAssetOwners = profile.projection.globalAssetOwners;
  if (
    !globalAssetOwners ||
    typeof globalAssetOwners !== "object" ||
    Array.isArray(globalAssetOwners)
  ) {
    throw new Error(
      `runtime profile ${sourceName} must declare projection.globalAssetOwners`,
    );
  }
  const declaredAssetTypes = new Set(profile.projection.assetTypes);
  const ownerAssetTypes = Object.keys(globalAssetOwners);
  for (const assetType of declaredAssetTypes) {
    if (!ownerAssetTypes.includes(assetType)) {
      throw new Error(
        `runtime profile ${sourceName} must declare a global owner for ${assetType}`,
      );
    }
  }
  for (const [assetType, owner] of Object.entries(globalAssetOwners)) {
    if (!declaredAssetTypes.has(assetType)) {
      throw new Error(
        `runtime profile ${sourceName} declares global owner for unknown asset ${assetType}`,
      );
    }
    if (!GLOBAL_PROJECTION_OWNERS.includes(owner)) {
      throw new Error(
        `runtime profile ${sourceName} declares unsupported global owner ${owner} for ${assetType}`,
      );
    }
  }
  if (
    globalAgentProjection.supported &&
    globalAssetOwners.agents !== GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL
  ) {
    throw new Error(
      `runtime profile ${sourceName} must assign supported global Agent projections to ${GLOBAL_PROJECTION_OWNER_SYNC_GLOBAL}`,
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
