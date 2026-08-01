import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  sanitizeStateProfile,
  validateCanonicalStateProfile,
} from "../canonical/runtime-assets/shared/hooks/spine-state.mjs";
import { detectProjectRegistryEntry } from "./project-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, "..");
export const localStateRoot = path.join(repoRoot, ".meta-kim", "state");
export const SHARED_RUNTIME_FAMILY = "shared";

function repoPathHash(repoPath = repoRoot) {
  return crypto
    .createHash("sha256")
    .update(path.resolve(repoPath).toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

export function resolveProfileName(input = process.env.META_KIM_PROFILE) {
  return sanitizeStateProfile(input);
}

export function resolveRuntimeFamily(
  input,
  {
    environment = process.env,
    argv = process.argv,
    entrypoint = argv[1],
  } = {},
) {
  const explicit = input === undefined
    ? environment.META_KIM_RUNTIME_FAMILY
    : input;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  const entrypointSegments = String(entrypoint ?? "")
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const entrypointMatches = (runtimeId) =>
    entrypointSegments.includes(runtimeId) ||
    entrypointSegments.includes(`.${runtimeId}`);
  if (
    environment.OPENCLAW_HOME ||
    entrypointMatches("openclaw")
  ) {
    return "openclaw";
  }
  if (
    environment.CODEX_HOME ||
    environment.CODEX_SANDBOX ||
    entrypointMatches("codex")
  ) {
    return "codex";
  }
  if (
    environment.CLAUDE_PROJECT_DIR ||
    environment.CLAUDE_SESSION_ID ||
    entrypointMatches("claude")
  ) {
    return "claude";
  }
  return SHARED_RUNTIME_FAMILY;
}

export function buildProfileKey({
  repoPath = repoRoot,
  runtimeFamily = resolveRuntimeFamily(),
} = {}) {
  return `${runtimeFamily}-${repoPathHash(repoPath)}`;
}

export function getProfilePaths({
  profile,
  canonicalProfile,
  runtimeFamily = resolveRuntimeFamily(),
  repoPath = repoRoot,
  stateRoot = localStateRoot,
} = {}) {
  if (profile !== undefined && canonicalProfile !== undefined) {
    throw new TypeError("Pass either raw profile or canonicalProfile, not both.");
  }
  // `profile` is always raw external input and is normalized exactly once.
  // Internal code that already owns a canonical result must opt into the
  // separate canonicalProfile field so the reserved derived-* namespace is
  // validated rather than mistaken for a new raw user name and re-hashed.
  const safeProfile = canonicalProfile === undefined
    ? resolveProfileName(profile)
    : validateCanonicalStateProfile(canonicalProfile);
  const resolvedRepoPath = path.resolve(repoPath);
  const profileDir = path.join(path.resolve(stateRoot), safeProfile);
  return {
    profile: safeProfile,
    runtimeFamily,
    repoPath: resolvedRepoPath,
    profileKey: buildProfileKey({ repoPath: resolvedRepoPath, runtimeFamily }),
    profileDir,
    profileFile: path.join(profileDir, "profile.json"),
    runIndexPath: path.join(profileDir, "run-index.sqlite"),
    compactionDir: path.join(profileDir, "compaction"),
    doctorCacheDir: path.join(profileDir, "doctor-cache"),
    migrationsDir: path.join(profileDir, "migrations"),
  };
}

export function toRepoRelative(targetPath) {
  return path.relative(repoRoot, targetPath).replace(/\\/g, "/");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readProfileMetadata(options = {}) {
  const paths = getProfilePaths(options);
  if (!(await pathExists(paths.profileFile))) {
    return null;
  }
  const raw = await fs.readFile(paths.profileFile, "utf8");
  return JSON.parse(raw);
}

export async function ensureProfileState(options = {}) {
  const paths = getProfilePaths(options);
  const existing = await readProfileMetadata(options);
  if (
    existing &&
    (existing.profileKey !== paths.profileKey || existing.runtimeFamily !== paths.runtimeFamily)
  ) {
    throw new Error(
      `profile collision detected for ${paths.profile}: expected ${paths.profileKey}/${paths.runtimeFamily}, ` +
        `found ${existing.profileKey ?? "unknown"}/${existing.runtimeFamily ?? "unknown"}. ` +
        `Set META_KIM_PROFILE to a distinct name for each concurrently used runtime (for example codex or claude).`,
    );
  }
  await fs.mkdir(paths.profileDir, { recursive: true });
  await fs.mkdir(paths.compactionDir, { recursive: true });
  await fs.mkdir(paths.doctorCacheDir, { recursive: true });
  await fs.mkdir(paths.migrationsDir, { recursive: true });

  const now = new Date().toISOString();
  const metadata = {
    profile: paths.profile,
    profileKey: paths.profileKey,
    repoRoot: paths.repoPath,
    repoPathHash: repoPathHash(paths.repoPath),
    runtimeFamily: paths.runtimeFamily,
    host: os.hostname(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const projectRegistry = await detectProjectRegistryEntry({
    repoPath: paths.repoPath,
    runtimeFamily: paths.runtimeFamily,
  });
  metadata.projectRef = projectRegistry.projectRef;
  metadata.registryStatus = projectRegistry.registryStatus;

  await fs.writeFile(
    paths.profileFile,
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  return { ...paths, metadata, projectRegistry };
}

export async function detectProfileCollision(options = {}) {
  const paths = getProfilePaths(options);
  const existing = await readProfileMetadata(options);
  if (!existing) {
    return {
      exists: false,
      collision: false,
      expectedProfileKey: paths.profileKey,
      expectedRuntimeFamily: paths.runtimeFamily,
    };
  }

  const mismatches = [];
  if (existing.profileKey !== paths.profileKey) {
    mismatches.push("profileKey");
  }
  if (existing.runtimeFamily !== paths.runtimeFamily) {
    mismatches.push("runtimeFamily");
  }
  if (existing.repoRoot !== repoRoot) {
    mismatches.push("repoRoot");
  }

  return {
    exists: true,
    collision: mismatches.length > 0,
    mismatches,
    expectedProfileKey: paths.profileKey,
    expectedRuntimeFamily: paths.runtimeFamily,
    existing,
  };
}
