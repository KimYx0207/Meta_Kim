import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { detectProjectRegistryEntry } from "./project-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, "..");
export const localStateRoot = path.join(repoRoot, ".meta-kim", "state");

function repoPathHash(repoPath = repoRoot) {
  return crypto
    .createHash("sha256")
    .update(path.resolve(repoPath).toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

export function resolveProfileName(input = process.env.META_KIM_PROFILE) {
  return typeof input === "string" && input.trim() ? input.trim() : "default";
}

export function resolveRuntimeFamily(input = process.env.META_KIM_RUNTIME_FAMILY) {
  if (typeof input === "string" && input.trim()) {
    return input.trim();
  }
  if (process.env.OPENCLAW_HOME || process.argv.some((arg) => arg.includes("openclaw"))) {
    return "openclaw";
  }
  if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX || process.argv.some((arg) => arg.includes("codex"))) {
    return "codex";
  }
  if (
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.CLAUDE_SESSION_ID ||
    process.argv.some((arg) => arg.includes("claude"))
  ) {
    return "claude";
  }
  return "shared";
}

export function buildProfileKey({ repoPath = repoRoot, runtimeFamily = resolveRuntimeFamily() } = {}) {
  return `${runtimeFamily}-${repoPathHash(repoPath)}`;
}

export function getProfilePaths({
  profile = resolveProfileName(),
  runtimeFamily = resolveRuntimeFamily(),
  repoPath = repoRoot,
} = {}) {
  const profileDir = path.join(localStateRoot, profile);
  return {
    profile,
    runtimeFamily,
    profileKey: buildProfileKey({ repoPath, runtimeFamily }),
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
  await fs.mkdir(paths.profileDir, { recursive: true });
  await fs.mkdir(paths.compactionDir, { recursive: true });
  await fs.mkdir(paths.doctorCacheDir, { recursive: true });
  await fs.mkdir(paths.migrationsDir, { recursive: true });

  const now = new Date().toISOString();
  const existing = await readProfileMetadata(options);
  const metadata = {
    profile: paths.profile,
    profileKey: paths.profileKey,
    repoRoot,
    repoPathHash: repoPathHash(repoPath),
    runtimeFamily: paths.runtimeFamily,
    host: os.hostname(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const projectRegistry = await detectProjectRegistryEntry({
    repoPath,
    runtimeFamily: paths.runtimeFamily,
  });
  metadata.projectRef = projectRegistry.projectRef;
  metadata.registryStatus = projectRegistry.registryStatus;

  await fs.writeFile(paths.profileFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
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
