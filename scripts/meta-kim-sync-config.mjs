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
export const runtimesDir = path.join(repoRoot, "runtimes");
export const syncManifestPath = path.join(repoRoot, "config", "sync.json");
export const localOverridesPath = path.join(
  repoRoot,
  ".meta-kim",
  "local.overrides.json",
);
export const supportedTargetIds = ["claude", "codex", "openclaw", "cursor"];

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

export async function loadRuntimeProfiles() {
  const entries = await fs.readdir(runtimesDir, { withFileTypes: true });
  const profiles = {};

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".profile.json")) {
      continue;
    }

    const profile = JSON.parse(
      await fs.readFile(path.join(runtimesDir, entry.name), "utf8"),
    );
    validateRuntimeProfile(profile, entry.name);
    profiles[profile.id] = profile;
  }

  for (const targetId of supportedTargetIds) {
    if (!profiles[targetId]) {
      throw new Error(`Missing runtime profile: ${targetId}`);
    }
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
  const [profiles, manifest, localOverrides] = await Promise.all([
    loadRuntimeProfiles(),
    loadSyncManifest(),
    loadLocalOverrides(),
  ]);

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

/** Home directory resolver for each runtime. Priority: env var > ~/.runtime */
export function resolveRuntimeHomeDir(runtimeId) {
  const specs = {
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

  const spec = specs[runtimeId];
  if (!spec) {
    throw new Error(`Unknown runtime: ${runtimeId}`);
  }

  for (const key of spec.envKeys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return path.resolve(value.trim());
    }
  }
  return path.join(os.homedir(), spec.defaultDir);
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

// ── Manifest & profile validation ─────────────────────────────────

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
  for (const key of ["agents", "skills", "runtimeAssets", "contracts"]) {
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
