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

/**
 * The variables Claude Code actually exports to a child process.
 *
 * The previous single check read `CLAUDE_SESSION_ID`, a name no supported host
 * sets, so it never once fired while both real markers were ignored — a wrong
 * name and an absent variable are the same shape at the read site. Codex was
 * detected from its own real markers on the branch above, so a governed run
 * started by an npm script inside a Claude Code session fell through to the
 * shared family and wrote its state under a different profile key than the
 * hooks of the very same session.
 *
 * `scripts/governed-execution/host-runtime-provenance.mjs` keeps the
 * provenance-facing copy of these names. That module reaches the spine reader,
 * which this low-level path resolver must not depend on, so the lists are
 * deliberately separate — consolidating them is tracked as follow-up rather
 * than done by importing upward.
 */
const CLAUDE_HOST_ENV_MARKERS = Object.freeze([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
]);

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
    CLAUDE_HOST_ENV_MARKERS.some((name) => environment[name]) ||
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

export function getGlobalProfilePaths({ profile, canonicalProfile } = {}) {
  const home = os.homedir();
  return getProfilePaths({
    profile,
    canonicalProfile,
    runtimeFamily: SHARED_RUNTIME_FAMILY,
    repoPath: home,
    stateRoot: path.join(home, ".meta-kim", "state"),
  });
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

/**
 * `shared` is what the resolver returns when it could not identify a runtime, so
 * it never conflicts with an identified family — the stronger evidence wins in
 * both directions. Two *identified* families in one profile is the real
 * collision, and that is what `classifyProfileIdentity` still refuses.
 *
 * `getGlobalProfilePaths` also passes `shared` deliberately for runtime-neutral
 * global state, and that case is unaffected: it supplies `shared` on both sides,
 * so reconciliation returns `shared` and the global profile is never relabelled
 * by whichever runtime happens to touch it.
 */
function reconcileRuntimeFamily(recordedFamily, requestedFamily) {
  return requestedFamily === SHARED_RUNTIME_FAMILY ? recordedFamily : requestedFamily;
}

/**
 * The one decision about whether a recorded profile and the current run may share
 * a state directory. `ensureProfileState` acts on it and `detectProfileCollision`
 * reports it, so the governance doctor — which gates on the report and asks
 * before the write happens — cannot call a difference fatal that the writer would
 * have reconciled without complaint.
 */
function classifyProfileIdentity(existing, requestedPaths) {
  const requestedFamily = requestedPaths.runtimeFamily;
  if (!existing) {
    return { exists: false, collision: false, mismatches: [], runtimeFamily: requestedFamily };
  }
  // Absent metadata predates the family field, which makes it a record that could
  // not name its runtime rather than one claiming a different runtime.
  const recordedFamily = existing.runtimeFamily ?? SHARED_RUNTIME_FAMILY;
  const mismatches = [];
  // Rebuilding the key from the family already on disk isolates the repo-path
  // half, so a reconcilable family cannot read as a path collision.
  if (
    existing.profileKey !==
    buildProfileKey({ repoPath: requestedPaths.repoPath, runtimeFamily: recordedFamily })
  ) {
    mismatches.push("profileKey");
  }
  if (
    recordedFamily !== SHARED_RUNTIME_FAMILY &&
    requestedFamily !== SHARED_RUNTIME_FAMILY &&
    recordedFamily !== requestedFamily
  ) {
    mismatches.push("runtimeFamily");
  }
  // Compared against the root the caller asked about, not this module's own:
  // a profile living outside the repo is not evidence of a mixed-up profile.
  if (existing.repoRoot !== requestedPaths.repoPath) {
    mismatches.push("repoRoot");
  }
  return {
    exists: true,
    collision: mismatches.length > 0,
    mismatches,
    runtimeFamily: reconcileRuntimeFamily(recordedFamily, requestedFamily),
  };
}

export async function ensureProfileState(options = {}) {
  const requestedPaths = getProfilePaths(options);
  const existing = await readProfileMetadata(options);
  const identity = classifyProfileIdentity(existing, requestedPaths);
  if (identity.collision) {
    throw new Error(
      `profile collision detected for ${requestedPaths.profile}: expected ${requestedPaths.profileKey}/${requestedPaths.runtimeFamily}, ` +
        `found ${existing.profileKey ?? "unknown"}/${existing.runtimeFamily ?? "unknown"}. ` +
        `Set META_KIM_PROFILE to a distinct name for each concurrently used runtime (for example codex or claude).`,
    );
  }
  const paths = identity.runtimeFamily === requestedPaths.runtimeFamily
    ? requestedPaths
    : {
        ...requestedPaths,
        runtimeFamily: identity.runtimeFamily,
        profileKey: buildProfileKey({
          repoPath: requestedPaths.repoPath,
          runtimeFamily: identity.runtimeFamily,
        }),
      };
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

export async function ensureGlobalProfileState({ profile, canonicalProfile } = {}) {
  const paths = getGlobalProfilePaths({ profile, canonicalProfile });
  return ensureProfileState({
    canonicalProfile: paths.profile,
    runtimeFamily: SHARED_RUNTIME_FAMILY,
    repoPath: paths.repoPath,
    stateRoot: path.dirname(paths.profileDir),
  });
}

export async function detectProfileCollision(options = {}) {
  const paths = getProfilePaths(options);
  const existing = await readProfileMetadata(options);
  const identity = classifyProfileIdentity(existing, paths);
  return {
    exists: identity.exists,
    collision: identity.collision,
    mismatches: identity.mismatches,
    expectedProfileKey: paths.profileKey,
    expectedRuntimeFamily: paths.runtimeFamily,
    existing: existing ?? null,
  };
}
