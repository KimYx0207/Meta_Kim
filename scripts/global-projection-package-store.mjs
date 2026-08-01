import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import {
  CATEGORIES,
  directoryClosureSync,
  fileIntegritySync,
} from "./install-manifest.mjs";
import { resolveCliInvocation } from "./runtime-cli-invocation.mjs";

export const PROJECTION_PACKAGE_RECEIPT_SCHEMA =
  "meta-kim-global-projection-package-v1";
export const PROJECTION_PACKAGE_MANIFEST_SOURCE = "sync-global-meta-theory";
export const PROJECTION_PACKAGE_PURPOSE = Object.freeze({
  bundle: "primary-runtime-global-projection-package-runtime-bundle",
  receipt: "primary-runtime-global-projection-package-runtime-bundle:receipt",
  packageManifest:
    "primary-runtime-global-projection-package-runtime-bundle:package-manifest",
  cli: "primary-runtime-global-projection-package-runtime-bundle:cli",
  syncScript:
    "primary-runtime-global-projection-package-runtime-bundle:sync-script",
});

const RECEIPT_FILE = "receipt.json";
const BUNDLE_DIR = "bundle";
const SYNC_SCRIPT_RELATIVE = "scripts/sync-global-meta-theory.mjs";
const SHA256_RE = /^[a-f0-9]{64}$/u;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]*$/u;
const PACKAGE_SEGMENT_RE = /^@?[a-z0-9][a-z0-9._-]*$/u;

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathAtOrWithin(root, candidate) {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function lstatIfExists(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

const STRIPPED_ENV_KEYS = new Set([
  "node_options",
  "node_path",
  "npm_execpath",
  "npm_node_execpath",
  "init_cwd",
  "meta_kim_repo_root",
  "meta_kim_package_root",
  "meta_kim_stable_project_deployments_json",
]);

// This is a lifecycle-isolation boundary for transient origins and accidental
// drift. It is not a same-user concurrency or npm supply-chain trust claim.

function pathLooksLikeNpxCache(value) {
  const segments = path.resolve(value).split(/[\\/]+/u).map((segment) =>
    segment.toLowerCase()
  );
  const index = segments.indexOf("_npx");
  return index >= 0 && Boolean(segments[index + 1]);
}

function pathLooksLikeNodeModulesBin(value) {
  const segments = path.resolve(value).split(/[\\/]+/u).map((segment) =>
    segment.toLowerCase()
  );
  return segments.some((segment, index) =>
    segment === "node_modules" && segments[index + 1] === ".bin"
  );
}

export function sanitizeProjectionPackageEnvironment(
  env,
  {
    sourceRoot = null,
    storeRoot = null,
    additionalBlockedRoots = [],
  } = {},
) {
  const sanitized = {};
  const pathValues = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "path") {
      pathValues.push(String(value ?? ""));
      continue;
    }
    if (
      STRIPPED_ENV_KEYS.has(normalizedKey) ||
      normalizedKey.startsWith("npm_package_") ||
      normalizedKey.startsWith("npm_config_")
    ) continue;
    sanitized[key] = value;
  }
  const blockedRoots = [sourceRoot, storeRoot, ...additionalBlockedRoots]
    .filter(Boolean)
    .map((value) => path.resolve(value));
  const safePathEntries = pathValues.join(path.delimiter)
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"|"$/gu, "").trim())
    .filter(Boolean)
    .filter((entry) => path.isAbsolute(entry))
    .filter((entry) =>
      !pathLooksLikeNodeModulesBin(entry) &&
      !pathLooksLikeNpxCache(entry) &&
      !blockedRoots.some((root) => pathAtOrWithin(root, entry))
    );
  sanitized.PATH = safePathEntries.join(path.delimiter);
  return sanitized;
}

async function resolvePathExecutable(command, env) {
  if (path.isAbsolute(command) || /[\\/]/u.test(command)) {
    return path.resolve(command);
  }
  for (const directory of String(env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next sanitized PATH entry.
    }
  }
  throw new Error("A trusted npm executable could not be resolved");
}

async function createTrustedNpmRunner({ sourceRoot, homeRoot, env }) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const storeRoot = path.join(
    path.resolve(homeRoot),
    ".meta-kim",
    "runtime",
    "projection-packages",
  );
  const cleanEnv = sanitizeProjectionPackageEnvironment(env, {
    sourceRoot: resolvedSourceRoot,
    storeRoot,
  });
  const invocation = resolveCliInvocation("npm", [], { env: cleanEnv });
  const executableCandidates = new Set([
    invocation.command,
    invocation.launchDescriptor?.discoveredEntry,
    invocation.launchDescriptor?.shim,
    invocation.launchDescriptor?.jsEntry,
  ].filter(Boolean));
  if (executableCandidates.size === 0) {
    throw new Error("A trusted npm invocation could not be resolved");
  }
  for (const candidate of executableCandidates) {
    const resolvedCandidate = await resolvePathExecutable(candidate, cleanEnv);
    const realCandidate = await fs.realpath(resolvedCandidate).catch(() => null);
    if (
      !realCandidate ||
      pathAtOrWithin(resolvedSourceRoot, realCandidate) ||
      pathAtOrWithin(storeRoot, realCandidate) ||
      pathLooksLikeNpxCache(realCandidate)
    ) {
      throw new Error("The resolved npm invocation is not independent of transient package roots");
    }
  }
  const run = (args, cwd, commandEnv = cleanEnv) => {
    try {
      return execFileSync(invocation.command, [
        ...invocation.args,
        ...args,
      ], {
        cwd,
        env: commandEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(
        `Trusted npm command failed: ${error?.code ?? error?.status ?? "unknown"}`,
      );
    }
  };
  return Object.freeze({ run, env: cleanEnv, storeRoot });
}

export async function runWithCleanup(operation, cleanup) {
  let operationResult;
  let operationError;
  let operationFailed = false;
  try {
    operationResult = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await cleanup();
  } catch (cleanupError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Operation and cleanup both failed",
      );
    }
    throw cleanupError;
  }
  if (operationFailed) throw operationError;
  return operationResult;
}

async function acquireProjectionDigestLock(layout, homeRoot) {
  const lockKey = layout.packageTarballSha256.slice(0, 24);
  const lockDir = path.join(
    layout.versionRoot,
    `.projection-package-lock-${lockKey}`,
  );
  const ownerPath = path.join(lockDir, "owner.json");
  const token = randomUUID();
  const candidateDir = path.join(
    layout.versionRoot,
    `.projection-package-lock-candidate-${lockKey}-${token}`,
  );
  const candidateOwnerPath = path.join(candidateDir, "owner.json");
  await Promise.all([
    assertHomeBound(lockDir, homeRoot),
    assertHomeBound(candidateDir, homeRoot),
  ]);
  const processIsAlive = (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  };
  const renameWithWindowsRetry = async (source, target) => {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await fs.rename(source, target);
        return;
      } catch (error) {
        lastError = error;
        if (
          !["EACCES", "EBUSY", "EPERM"].includes(error?.code) ||
          attempt === 3
        ) throw error;
        await delay(25 * (attempt + 1));
      }
    }
    throw lastError;
  };
  const removeOwnedLockPath = async (ownedPath, expectedToken, label) => {
    const ownedOwnerPath = path.join(ownedPath, "owner.json");
    const [entries, owner] = await Promise.all([
      fs.readdir(ownedPath),
      readJson(ownedOwnerPath, label),
    ]);
    if (
      entries.length !== 1 ||
      entries[0] !== "owner.json" ||
      owner.token !== expectedToken
    ) {
      throw new Error("Projection package digest lock changed before cleanup");
    }
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await fs.rm(ownedPath, { recursive: true, force: false });
        return;
      } catch (error) {
        lastError = error;
        if (
          !["EACCES", "EBUSY", "EPERM"].includes(error?.code) ||
          attempt === 3
        ) throw error;
        await delay(25 * (attempt + 1));
      }
    }
    throw lastError;
  };
  await fs.mkdir(candidateDir);
  try {
    await fs.writeFile(
      candidateOwnerPath,
      `${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    const entries = await fs.readdir(candidateDir).catch(() => []);
    if (entries.length === 0) await fs.rmdir(candidateDir);
    throw error;
  }

  let published = false;
  try {
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      try {
        await fs.rename(candidateDir, lockDir);
        published = true;
        return async () => {
          const releasePath = path.join(
            layout.versionRoot,
            `.projection-package-lock-release-${lockKey}-${token}`,
          );
          await assertHomeBound(releasePath, homeRoot);
          await renameWithWindowsRetry(lockDir, releasePath);
          await removeOwnedLockPath(
            releasePath,
            token,
            "projection package lock release owner",
          );
        };
      } catch (error) {
        const stat = await lstatIfExists(lockDir);
        if (!stat) {
          if (
            !["EACCES", "EBUSY", "EPERM"].includes(error?.code) ||
            attempt === 1_199
          ) throw error;
          await delay(50);
          continue;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error("Projection package digest lock is not a plain directory");
        }
        let owner = null;
        try {
          owner = await readJson(ownerPath, "projection package lock owner");
        } catch {
          // Legacy or interrupted locks without an owner remain protected until stale.
        }
        if (
          Date.now() - stat.mtimeMs > 30_000 &&
          !processIsAlive(owner?.pid)
        ) {
          const staleLockPath = path.join(
            layout.versionRoot,
            `.projection-package-lock-quarantine-${lockKey}-${process.pid}-${randomUUID()}`,
          );
          try {
            await renameWithWindowsRetry(lockDir, staleLockPath);
            continue;
          } catch (renameError) {
            if (!["EEXIST", "ENOENT"].includes(renameError?.code)) {
              throw renameError;
            }
          }
        }
        await delay(50);
      }
    }
    throw new Error(
      `Projection package digest lock remained busy: ${lockDir}`,
    );
  } finally {
    if (!published && await lstatIfExists(candidateDir)) {
      await removeOwnedLockPath(
        candidateDir,
        token,
        "projection package lock candidate owner",
      );
    }
  }
}

async function createPrivateNpmRuntime({ npmRunner, sourceRoot, storeRoot }) {
  let runtimeRoot = null;
  try {
    runtimeRoot = await fs.mkdtemp(path.join(
      os.tmpdir(),
      "meta-kim-npm-runtime-",
    ));
    const runtimeStat = await fs.lstat(runtimeRoot);
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) {
      throw new Error("Private npm runtime root must be a plain directory");
    }
    const [realRuntimeRoot, realSourceRoot, projectedStoreRoot] =
      await Promise.all([
        fs.realpath(runtimeRoot),
        fs.realpath(path.resolve(sourceRoot)),
        projectedRealPath(path.resolve(storeRoot)),
      ]);
    if (
      pathAtOrWithin(realSourceRoot, realRuntimeRoot) ||
      pathAtOrWithin(projectedStoreRoot, realRuntimeRoot)
    ) {
      throw new Error("Private npm runtime root overlaps package source or store");
    }
    const cacheRoot = path.join(runtimeRoot, "cache");
    const tempRoot = path.join(runtimeRoot, "temp");
    await fs.mkdir(cacheRoot, { recursive: false });
    await fs.mkdir(tempRoot, { recursive: false });
    for (const childRoot of [cacheRoot, tempRoot]) {
      const childStat = await fs.lstat(childRoot);
      const realChildRoot = await fs.realpath(childRoot);
      if (
        childStat.isSymbolicLink() ||
        !childStat.isDirectory() ||
        !pathAtOrWithin(realRuntimeRoot, realChildRoot)
      ) {
        throw new Error("Private npm runtime child escaped its plain root");
      }
    }
    const runtimeEnv = {};
    for (const [key, value] of Object.entries(npmRunner.env)) {
      if (!["tmp", "temp", "tmpdir"].includes(key.toLowerCase())) {
        runtimeEnv[key] = value;
      }
    }
    runtimeEnv.TMP = tempRoot;
    runtimeEnv.TEMP = tempRoot;
    runtimeEnv.TMPDIR = tempRoot;
    return Object.freeze({
      root: runtimeRoot,
      run(args, cwd) {
        return npmRunner.run([
          ...args,
          "--cache",
          cacheRoot,
        ], cwd, runtimeEnv);
      },
      async cleanup() {
        await fs.rm(runtimeRoot, { recursive: true, force: true });
      },
    });
  } catch (error) {
    if (runtimeRoot) {
      try {
        await fs.rm(runtimeRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Private npm runtime setup and cleanup both failed",
        );
      }
    }
    throw error;
  }
}

function safeFirstPartyRelativePath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("npm pack reported an unsafe first-party path");
  }
  return normalized;
}

function comparePortablePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function closureForEntries(entries) {
  return Object.freeze({
    entryCount: entries.length,
    sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  });
}

async function hashFirstPartyFiles(packageRoot, filePaths, { requireExactSet }) {
  const root = path.resolve(packageRoot);
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Projection package root must be a plain directory");
  }
  const normalizedPaths = [...new Set(filePaths.map(safeFirstPartyRelativePath))]
    .sort(comparePortablePaths);
  if (normalizedPaths.length !== filePaths.length || normalizedPaths.length === 0) {
    throw new Error("Projection package first-party file list is empty or ambiguous");
  }
  if (requireExactSet) {
    const actualPaths = [];
    const walk = async (currentPath, relativeParent = "") => {
      for (const entry of await fs.readdir(currentPath, { withFileTypes: true })) {
        const absolutePath = path.join(currentPath, entry.name);
        const relativePath = `${relativeParent}/${entry.name}`.replace(/^\//u, "");
        const stat = await fs.lstat(absolutePath);
        if (stat.isSymbolicLink()) {
          throw new Error("Installed first-party package contains a link");
        }
        if (stat.isDirectory()) await walk(absolutePath, relativePath);
        else if (stat.isFile()) actualPaths.push(relativePath.replaceAll("\\", "/"));
        else throw new Error("Installed first-party package contains an unsupported entry");
      }
    };
    await walk(root);
    actualPaths.sort(comparePortablePaths);
    if (JSON.stringify(actualPaths) !== JSON.stringify(normalizedPaths)) {
      throw new Error("Installed first-party package file set differs from npm pack truth");
    }
  }
  const entries = [];
  for (const relativePath of normalizedPaths) {
    const absolutePath = path.resolve(root, relativePath);
    if (!pathAtOrWithin(root, absolutePath)) {
      throw new Error("First-party package file escapes its package root");
    }
    const segments = relativePath.split("/");
    let cursor = root;
    for (const [index, segment] of segments.entries()) {
      cursor = path.join(cursor, segment);
      const stat = await fs.lstat(cursor);
      const isLast = index === segments.length - 1;
      if (
        stat.isSymbolicLink() ||
        (isLast ? !stat.isFile() : !stat.isDirectory())
      ) {
        throw new Error("First-party package path is not a plain file chain");
      }
    }
    const bytes = await fs.readFile(absolutePath);
    entries.push({
      path: relativePath,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return Object.freeze({
    filePaths: Object.freeze(normalizedPaths),
    closure: closureForEntries(entries),
  });
}

function parseNpmPackResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout).trim());
  } catch {
    throw new Error("npm pack did not return valid JSON metadata");
  }
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!result || !Array.isArray(result.files) || result.files.length === 0) {
    throw new Error("npm pack did not report a first-party file list");
  }
  return result;
}

function parseNpmPackFilePaths(stdout) {
  return parseNpmPackResult(stdout).files.map((entry) =>
    safeFirstPartyRelativePath(entry?.path)
  );
}

async function snapshotNpmPackSource(packageRoot, npmRuntime) {
  const stdout = npmRuntime.run([
    "pack",
    packageRoot,
    "--json",
    "--dry-run",
    "--ignore-scripts",
  ], packageRoot);
  return await hashFirstPartyFiles(
    packageRoot,
    parseNpmPackFilePaths(stdout),
    { requireExactSet: false },
  );
}

export async function packageContentClosure(
  packageRoot,
  { env = process.env, homeRoot = os.homedir() } = {},
) {
  const npmRunner = await createTrustedNpmRunner({
    sourceRoot: packageRoot,
    homeRoot,
    env,
  });
  const npmRuntime = await createPrivateNpmRuntime({
    npmRunner,
    sourceRoot: packageRoot,
    storeRoot: npmRunner.storeRoot,
  });
  return await runWithCleanup(async () => {
    npmRuntime.run(["--version"], path.resolve(packageRoot));
    return (await snapshotNpmPackSource(
      path.resolve(packageRoot),
      npmRuntime,
    )).closure;
  }, () => npmRuntime.cleanup());
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

export async function projectionPackageWriteBoundaryFindings(
  verifiedPackage,
  targetPaths,
) {
  if (!verifiedPackage) return [];
  const protectedRoots = [
    ["package_root", verifiedPackage.packageRoot],
    ["projection_store", verifiedPackage.storeRoot],
  ].filter(([, root]) => typeof root === "string" && root.length > 0);
  const realProtectedRoots = await Promise.all(
    protectedRoots.map(async ([kind, root]) => [kind, await projectedRealPath(root)]),
  );
  const findings = [];
  for (const targetPath of targetPaths ?? []) {
    if (typeof targetPath !== "string" || targetPath.length === 0) continue;
    const realTarget = await projectedRealPath(targetPath);
    for (const [kind, realRoot] of realProtectedRoots) {
      if (pathAtOrWithin(realRoot, realTarget)) {
        findings.push(Object.freeze({
          kind,
          targetPath: path.resolve(targetPath),
          realTarget,
          protectedRoot: realRoot,
        }));
      }
    }
  }
  return findings;
}

export async function assertProjectionPackageWriteBoundary(
  verifiedPackage,
  targetPaths,
  { operation = "write" } = {},
) {
  const findings = await projectionPackageWriteBoundaryFindings(
    verifiedPackage,
    targetPaths,
  );
  if (findings.length === 0) return true;
  const finding = findings[0];
  throw new Error(
    `Stable projection package ${operation} target overlaps ${finding.kind}: ${finding.targetPath}`,
  );
}

async function assertHomeBound(targetPath, homeRoot) {
  const resolvedHome = path.resolve(homeRoot);
  const resolvedTarget = path.resolve(targetPath);
  if (!pathAtOrWithin(resolvedHome, resolvedTarget)) {
    throw new Error("Global projection package path escapes the user home");
  }
  const [realHome, realTarget] = await Promise.all([
    projectedRealPath(resolvedHome),
    projectedRealPath(resolvedTarget),
  ]);
  if (!pathAtOrWithin(realHome, realTarget)) {
    throw new Error("Global projection package path follows a link outside the user home");
  }
}

async function assertPlainDirectoryChain(homeRoot, targetPath, { allowMissing = false } = {}) {
  const home = path.resolve(homeRoot);
  const target = path.resolve(targetPath);
  await assertHomeBound(target, home);
  const homeStat = await fs.lstat(home).catch((error) => {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  });
  if (!homeStat) return;
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new Error(
      "Global projection package store ancestors must be plain directories",
    );
  }
  const relative = path.relative(pathKey(home), pathKey(target));
  const segments = relative ? relative.split(path.sep) : [];
  let cursor = home;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor).catch((error) => {
      if (allowMissing && error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        "Global projection package store ancestors must be plain directories",
      );
    }
  }
}

function packageNameSegments(packageName) {
  const segments = String(packageName ?? "").split("/");
  if (
    segments.length < 1 ||
    segments.length > 2 ||
    segments.some((segment) => !PACKAGE_SEGMENT_RE.test(segment)) ||
    (segments.length === 2 && !segments[0].startsWith("@")) ||
    (segments.length === 1 && segments[0].startsWith("@"))
  ) {
    throw new Error(`Unsafe projection package name: ${packageName}`);
  }
  return segments;
}

function assertVersion(packageVersion) {
  if (!VERSION_RE.test(String(packageVersion ?? ""))) {
    throw new Error(`Unsafe projection package version: ${packageVersion}`);
  }
  return String(packageVersion);
}

function assertDigest(packageTarballSha256) {
  const digest = String(packageTarballSha256 ?? "").toLowerCase();
  if (!SHA256_RE.test(digest)) {
    throw new Error("Projection package digest must be a lowercase SHA-256 value");
  }
  return digest;
}

function portableRelative(from, target) {
  return path.relative(from, target).replaceAll("\\", "/");
}

function resolveCli(packageManifest) {
  const bins = packageManifest?.bin;
  if (!bins || typeof bins !== "object" || Array.isArray(bins)) {
    throw new Error("Projection package must declare a public CLI");
  }
  const preferredName = packageManifest.name?.split("/").at(-1);
  const entry = bins[preferredName] ?? bins["meta-kim"] ?? Object.values(bins)[0];
  if (
    typeof entry !== "string" ||
    !entry ||
    path.isAbsolute(entry) ||
    entry.replaceAll("\\", "/").split("/").some((segment) => segment === "..")
  ) {
    throw new Error("Projection package public CLI must be a safe relative path");
  }
  return entry;
}

export function resolveGlobalProjectionPackageLayout({
  homeRoot = os.homedir(),
  packageName,
  packageVersion,
  packageTarballSha256,
} = {}) {
  const nameSegments = packageNameSegments(packageName);
  const version = assertVersion(packageVersion);
  const digest = assertDigest(packageTarballSha256);
  const storeRoot = path.join(
    path.resolve(homeRoot),
    ".meta-kim",
    "runtime",
    "projection-packages",
  );
  const versionRoot = path.join(storeRoot, ...nameSegments, version);
  const digestDir = path.join(versionRoot, digest);
  const bundleDir = path.join(digestDir, BUNDLE_DIR);
  const packageRoot = path.join(bundleDir, "node_modules", ...nameSegments);
  return Object.freeze({
    homeRoot: path.resolve(homeRoot),
    storeRoot,
    versionRoot,
    digestDir,
    bundleDir,
    receiptPath: path.join(digestDir, RECEIPT_FILE),
    packageRoot,
    packageManifestPath: path.join(packageRoot, "package.json"),
    syncScriptPath: path.join(packageRoot, SYNC_SCRIPT_RELATIVE),
    packageName,
    packageVersion: version,
    packageTarballSha256: digest,
  });
}

async function readJson(filePath, label) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} is unavailable: ${error.code ?? "read_failed"}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function exactRegularFile(filePath, label) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be an exact regular file`);
  }
  const integrity = fileIntegritySync(filePath);
  if (!integrity) throw new Error(`${label} integrity is unavailable`);
  return integrity;
}

function sameIntegrity(left, right) {
  return Boolean(
    left &&
    right &&
    left.sha256 === right.sha256 &&
    left.size === right.size,
  );
}

async function buildReceipt(layout, sourcePackageSnapshot) {
  const packageManifest = await readJson(
    layout.packageManifestPath,
    "projection package manifest",
  );
  if (
    packageManifest.name !== layout.packageName ||
    packageManifest.version !== layout.packageVersion
  ) {
    throw new Error("Installed projection package identity differs from the packed source");
  }
  const cliPath = path.resolve(layout.packageRoot, resolveCli(packageManifest));
  if (!pathAtOrWithin(layout.packageRoot, cliPath)) {
    throw new Error("Projection package CLI escapes the package root");
  }
  const keyPaths = {
    packageManifest: layout.packageManifestPath,
    publicCli: cliPath,
    globalSyncScript: layout.syncScriptPath,
  };
  const keyFiles = {};
  for (const [key, filePath] of Object.entries(keyPaths)) {
    keyFiles[key] = {
      relativePath: portableRelative(layout.digestDir, filePath),
      ...await exactRegularFile(filePath, `projection package ${key}`),
    };
  }
  const installedFirstParty = await hashFirstPartyFiles(
    layout.packageRoot,
    sourcePackageSnapshot.filePaths,
    { requireExactSet: true },
  );
  if (
    installedFirstParty.closure.sha256 !== sourcePackageSnapshot.closure.sha256 ||
    installedFirstParty.closure.entryCount !== sourcePackageSnapshot.closure.entryCount
  ) {
    throw new Error(
      "Installed first-party package content differs from npm pack truth",
    );
  }
  const bundleClosure = directoryClosureSync(layout.bundleDir);
  if (!bundleClosure) {
    throw new Error("Projection package bundle closure is unavailable");
  }
  return {
    schemaVersion: PROJECTION_PACKAGE_RECEIPT_SCHEMA,
    packageName: layout.packageName,
    packageVersion: layout.packageVersion,
    packageTarballSha256: layout.packageTarballSha256,
    firstPartyFiles: installedFirstParty.filePaths,
    firstPartyClosure: installedFirstParty.closure,
    bundleRelativePath: BUNDLE_DIR,
    packageRootRelative: portableRelative(layout.digestDir, layout.packageRoot),
    bundleClosure,
    keyFiles,
  };
}

export async function verifyGlobalProjectionPackage(
  digestDir,
  {
    homeRoot = os.homedir(),
    expectedPackageName = null,
    expectedPackageVersion = null,
    expectedPackageTarballSha256 = null,
    expectedFirstPartyClosure = null,
    expectedSourcePackageContentClosure = null,
  } = {},
) {
  const expectedClosure = expectedFirstPartyClosure ??
    expectedSourcePackageContentClosure;
  const candidateDir = path.resolve(digestDir);
  await assertHomeBound(candidateDir, homeRoot);
  const receiptPath = path.join(candidateDir, RECEIPT_FILE);
  const receipt = await readJson(receiptPath, "global projection package receipt");
  if (receipt?.schemaVersion !== PROJECTION_PACKAGE_RECEIPT_SCHEMA) {
    throw new Error("Unsupported global projection package receipt schema");
  }
  const layout = resolveGlobalProjectionPackageLayout({
    homeRoot,
    packageName: receipt.packageName,
    packageVersion: receipt.packageVersion,
    packageTarballSha256: receipt.packageTarballSha256,
  });
  if (pathKey(candidateDir) !== pathKey(layout.digestDir)) {
    throw new Error("Global projection package is outside its fixed digest layout");
  }
  await assertPlainDirectoryChain(homeRoot, layout.packageRoot);
  if (
    (expectedPackageName && receipt.packageName !== expectedPackageName) ||
    (expectedPackageVersion && receipt.packageVersion !== expectedPackageVersion) ||
    (expectedPackageTarballSha256 &&
      receipt.packageTarballSha256 !== expectedPackageTarballSha256)
  ) {
    throw new Error("Global projection package receipt does not match the expected identity");
  }
  if (
    receipt.bundleRelativePath !== BUNDLE_DIR ||
    receipt.packageRootRelative !== portableRelative(layout.digestDir, layout.packageRoot)
  ) {
    throw new Error("Global projection package receipt contains a non-canonical layout");
  }
  const digestStat = await fs.lstat(layout.digestDir).catch(() => null);
  const bundleStat = await fs.lstat(layout.bundleDir).catch(() => null);
  const packageStat = await fs.lstat(layout.packageRoot).catch(() => null);
  if (
    !digestStat?.isDirectory() || digestStat.isSymbolicLink() ||
    !bundleStat?.isDirectory() || bundleStat.isSymbolicLink() ||
    !packageStat?.isDirectory() || packageStat.isSymbolicLink()
  ) {
    throw new Error("Global projection package layout must contain exact directories");
  }
  await assertHomeBound(layout.packageRoot, homeRoot);

  const packageManifest = await readJson(
    layout.packageManifestPath,
    "global projection package manifest",
  );
  if (
    packageManifest.name !== receipt.packageName ||
    packageManifest.version !== receipt.packageVersion
  ) {
    throw new Error("Global projection package manifest identity is inconsistent");
  }
  if (!Array.isArray(receipt.firstPartyFiles)) {
    throw new Error("Global projection package receipt lacks first-party file truth");
  }
  const installedFirstParty = await hashFirstPartyFiles(
    layout.packageRoot,
    receipt.firstPartyFiles,
    { requireExactSet: true },
  );
  if (
    !SHA256_RE.test(receipt.firstPartyClosure?.sha256 ?? "") ||
    !Number.isInteger(receipt.firstPartyClosure?.entryCount) ||
    receipt.firstPartyClosure.entryCount < 1 ||
    installedFirstParty.closure.sha256 !== receipt.firstPartyClosure.sha256 ||
    installedFirstParty.closure.entryCount !== receipt.firstPartyClosure.entryCount ||
    (expectedClosure &&
      (installedFirstParty.closure.sha256 !==
        expectedClosure.sha256 ||
        installedFirstParty.closure.entryCount !==
        expectedClosure.entryCount))
  ) {
    throw new Error(
      "Global projection package first-party closure does not match authority",
    );
  }
  const cliPath = path.resolve(layout.packageRoot, resolveCli(packageManifest));
  const expectedKeyPaths = {
    packageManifest: layout.packageManifestPath,
    publicCli: cliPath,
    globalSyncScript: layout.syncScriptPath,
  };
  for (const [key, filePath] of Object.entries(expectedKeyPaths)) {
    const recorded = receipt.keyFiles?.[key];
    if (
      !recorded ||
      recorded.relativePath !== portableRelative(layout.digestDir, filePath) ||
      !sameIntegrity(
        recorded,
        await exactRegularFile(filePath, `global projection package ${key}`),
      )
    ) {
      throw new Error(`Global projection package ${key} does not match its receipt`);
    }
  }
  const bundleClosure = directoryClosureSync(layout.bundleDir);
  if (
    !bundleClosure ||
    bundleClosure.sha256 !== receipt.bundleClosure?.sha256 ||
    bundleClosure.entryCount !== receipt.bundleClosure?.entryCount
  ) {
    throw new Error("Global projection package bundle closure does not match its receipt");
  }
  return Object.freeze({
    ...layout,
    receipt,
    firstPartyClosure: installedFirstParty.closure,
    cliPath,
    keyPaths: Object.freeze(expectedKeyPaths),
  });
}

export async function verifyExecutingGlobalProjectionPackage({
  packageRoot,
  homeRoot = os.homedir(),
} = {}) {
  let packageManifest;
  try {
    packageManifest = await readJson(
      path.join(packageRoot, "package.json"),
      "executing package manifest",
    );
    const nameSegments = packageNameSegments(packageManifest.name);
    const digestDir = path.resolve(
      packageRoot,
      ...Array(nameSegments.length + 2).fill(".."),
    );
    const verified = await verifyGlobalProjectionPackage(digestDir, {
      homeRoot,
      expectedPackageName: packageManifest.name,
      expectedPackageVersion: packageManifest.version,
    });
    return pathKey(verified.packageRoot) === pathKey(packageRoot) ? verified : null;
  } catch {
    return null;
  }
}

export async function materializeGlobalProjectionPackage({
  sourceRoot,
  homeRoot = os.homedir(),
  env = process.env,
} = {}) {
  const sourcePackageRoot = path.resolve(sourceRoot);
  const fixedStoreRoot = path.join(
    path.resolve(homeRoot),
    ".meta-kim",
    "runtime",
    "projection-packages",
  );
  if (pathAtOrWithin(fixedStoreRoot, sourcePackageRoot)) {
    throw new Error(
      "An unverified package inside the projection store cannot rematerialize itself",
    );
  }
  const sourceManifest = await readJson(
    path.join(sourcePackageRoot, "package.json"),
    "source package manifest",
  );
  packageNameSegments(sourceManifest.name);
  assertVersion(sourceManifest.version);
  const npmRunner = await createTrustedNpmRunner({
    sourceRoot: sourcePackageRoot,
    homeRoot,
    env,
  });
  const npmRuntime = await createPrivateNpmRuntime({
    npmRunner,
    sourceRoot: sourcePackageRoot,
    storeRoot: fixedStoreRoot,
  });
  return await runWithCleanup(async () => {
    npmRuntime.run(["--version"], sourcePackageRoot);
    const sourceSnapshotBeforePack = await snapshotNpmPackSource(
      sourcePackageRoot,
      npmRuntime,
    );

    const provisionalRoot = path.join(
      path.resolve(homeRoot),
      ".meta-kim",
      "runtime",
      "projection-packages",
      ...packageNameSegments(sourceManifest.name),
      sourceManifest.version,
    );
    await assertPlainDirectoryChain(homeRoot, provisionalRoot, { allowMissing: true });
    await fs.mkdir(provisionalRoot, { recursive: true });
    await assertPlainDirectoryChain(homeRoot, provisionalRoot);
    const stageDir = path.join(
      provisionalRoot,
      `.projection-package-staged-${process.pid}-${randomUUID()}`,
    );
    await fs.mkdir(stageDir, { recursive: false });
    let promoted = false;
    return await runWithCleanup(async () => {
      await assertPlainDirectoryChain(homeRoot, stageDir);
      const packedResult = parseNpmPackResult(npmRuntime.run(
      [
        "pack",
        sourcePackageRoot,
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        stageDir,
      ],
      sourcePackageRoot,
    ));
    await assertPlainDirectoryChain(homeRoot, stageDir);
    const archives = (await fs.readdir(stageDir)).filter((name) =>
      name.endsWith(".tgz")
    );
    if (archives.length !== 1) {
      throw new Error(`Expected one packed projection candidate, found ${archives.length}`);
    }
    if (
      typeof packedResult.filename !== "string" ||
      path.basename(packedResult.filename) !== packedResult.filename ||
      packedResult.filename !== archives[0]
    ) {
      throw new Error("npm pack archive metadata does not match the staged artifact");
    }
    const actualPackPaths = packedResult.files.map((entry) =>
      safeFirstPartyRelativePath(entry?.path)
    ).sort(comparePortablePaths);
    if (
      JSON.stringify(actualPackPaths) !==
        JSON.stringify(sourceSnapshotBeforePack.filePaths)
    ) {
      throw new Error("npm pack artifact file list differs from its dry-run snapshot");
    }
    const archivePath = path.join(stageDir, packedResult.filename);
    const packageTarballSha256 = createHash("sha256")
      .update(await fs.readFile(archivePath))
      .digest("hex");
    const finalLayout = resolveGlobalProjectionPackageLayout({
      homeRoot,
      packageName: sourceManifest.name,
      packageVersion: sourceManifest.version,
      packageTarballSha256,
    });
      const sourceSnapshotAfterPack = await snapshotNpmPackSource(
        sourcePackageRoot,
        npmRuntime,
      );
    if (
      sourceSnapshotAfterPack.closure.sha256 !==
        sourceSnapshotBeforePack.closure.sha256 ||
      sourceSnapshotAfterPack.closure.entryCount !==
        sourceSnapshotBeforePack.closure.entryCount
    ) {
      throw new Error("Source package content changed while the stable package was packed");
    }

    const stageBundleDir = path.join(stageDir, BUNDLE_DIR);
    await fs.mkdir(stageBundleDir, { recursive: true });
    await assertPlainDirectoryChain(homeRoot, stageBundleDir);
      npmRuntime.run(
      [
        "install",
        "--prefix",
        stageBundleDir,
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        archivePath,
      ],
      stageDir,
    );
    await assertPlainDirectoryChain(homeRoot, stageBundleDir);
    await fs.rm(archivePath, { force: true });

    const stageLayout = {
      ...finalLayout,
      digestDir: stageDir,
      bundleDir: stageBundleDir,
      receiptPath: path.join(stageDir, RECEIPT_FILE),
      packageRoot: path.join(
        stageBundleDir,
        "node_modules",
        ...packageNameSegments(sourceManifest.name),
      ),
    };
    stageLayout.packageManifestPath = path.join(stageLayout.packageRoot, "package.json");
    stageLayout.syncScriptPath = path.join(stageLayout.packageRoot, SYNC_SCRIPT_RELATIVE);
    await assertPlainDirectoryChain(homeRoot, stageLayout.packageRoot);
    const receipt = await buildReceipt(stageLayout, sourceSnapshotBeforePack);
    await fs.writeFile(
      stageLayout.receiptPath,
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );

    const stageClosure = directoryClosureSync(stageDir);
    if (!stageClosure) {
      throw new Error("Staged projection package closure is unavailable");
    }
    await assertPlainDirectoryChain(homeRoot, stageLayout.packageRoot);

    const verifyExactWinner = async () => {
      const winner = await verifyGlobalProjectionPackage(finalLayout.digestDir, {
        homeRoot,
        expectedPackageName: sourceManifest.name,
        expectedPackageVersion: sourceManifest.version,
        expectedPackageTarballSha256: packageTarballSha256,
        expectedFirstPartyClosure: sourceSnapshotBeforePack.closure,
      });
      const winnerClosure = directoryClosureSync(winner.digestDir);
      const [stageReceiptRaw, winnerReceiptRaw] = await Promise.all([
        fs.readFile(stageLayout.receiptPath, "utf8"),
        fs.readFile(winner.receiptPath, "utf8"),
      ]);
      if (
        !winnerClosure ||
        winnerClosure.sha256 !== stageClosure.sha256 ||
        winnerClosure.entryCount !== stageClosure.entryCount ||
        winnerReceiptRaw !== stageReceiptRaw
      ) {
        throw new Error(
          "Existing projection package digest directory differs from this staged candidate",
        );
      }
      return winner;
    };

    const retryableIncompleteWinner = (error) =>
      /global projection package receipt is unavailable: ENOENT/u
        .test(error?.message ?? "");
    const verifyExactWinnerWithRetry = async () => {
      let lastError;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          return await verifyExactWinner();
        } catch (error) {
          lastError = error;
          if (!retryableIncompleteWinner(error) || attempt === 3) throw error;
          await delay(25 * (attempt + 1));
        }
      }
      throw lastError;
    };
    const existingWinnerHasMissingReceipt = async () => {
      const digestStat = await lstatIfExists(finalLayout.digestDir);
      if (!digestStat) return false;
      if (digestStat.isSymbolicLink() || !digestStat.isDirectory()) {
        throw new Error("Existing projection package digest is not a plain directory");
      }
      const receiptStat = await lstatIfExists(finalLayout.receiptPath);
      if (!receiptStat) return true;
      if (receiptStat.isSymbolicLink() || !receiptStat.isFile()) {
        throw new Error("Existing projection package receipt is not a regular file");
      }
      return false;
    };
    const promoteStagedCandidate = async () => {
      let lastError;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await assertPlainDirectoryChain(homeRoot, finalLayout.versionRoot);
          await fs.rename(stageDir, finalLayout.digestDir);
          promoted = true;
          return null;
        } catch (error) {
          lastError = error;
          if (await lstatIfExists(finalLayout.digestDir)) {
            return await verifyExactWinnerWithRetry();
          }
          if (
            !["EACCES", "EBUSY", "EPERM"].includes(error?.code) ||
            attempt === 3
          ) throw error;
          await delay(25 * (attempt + 1));
        }
      }
      throw lastError;
    };

    const quarantineIncompleteWinner = async (quarantinePath) => {
      let lastError;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await fs.rename(finalLayout.digestDir, quarantinePath);
          return;
        } catch (error) {
          lastError = error;
          if (
            !["EACCES", "EBUSY", "EPERM"].includes(error?.code) ||
            attempt === 3
          ) throw error;
          await delay(25 * (attempt + 1));
        }
      }
      throw lastError;
    };

    const releaseDigestLock = await acquireProjectionDigestLock(finalLayout, homeRoot);
    return await runWithCleanup(async () => {
      const existing = await lstatIfExists(finalLayout.digestDir);
      if (existing) {
        try {
          return await verifyExactWinnerWithRetry();
        } catch (error) {
          if (
            !retryableIncompleteWinner(error) ||
            !(await existingWinnerHasMissingReceipt())
          ) throw error;
          const quarantinePath = path.join(
            finalLayout.versionRoot,
            `.projection-package-quarantine-${finalLayout.packageTarballSha256.slice(0, 12)}-${process.pid}-${randomUUID()}`,
          );
          await assertHomeBound(quarantinePath, homeRoot);
          await quarantineIncompleteWinner(quarantinePath);
          const winner = await promoteStagedCandidate();
          if (winner) return winner;
        }
      } else {
        const winner = await promoteStagedCandidate();
        if (winner) return winner;
      }
      return await verifyGlobalProjectionPackage(finalLayout.digestDir, {
        homeRoot,
        expectedPackageName: sourceManifest.name,
        expectedPackageVersion: sourceManifest.version,
        expectedPackageTarballSha256: packageTarballSha256,
        expectedFirstPartyClosure: sourceSnapshotBeforePack.closure,
      });
    }, releaseDigestLock);
    }, async () => {
      if (!promoted) {
        await fs.rm(stageDir, { recursive: true, force: true });
      }
    });
  }, () => npmRuntime.cleanup());
}

function manifestFileMatches(entry, filePath) {
  if (
    entry?.kind !== "file" ||
    entry.ownershipClass !== "install_projection" ||
    entry.runtimeTarget != null ||
    pathKey(entry.path) !== pathKey(filePath) ||
    !Number.isFinite(entry.size) ||
    !entry.sha256
  ) return false;
  return sameIntegrity(entry, fileIntegritySync(filePath));
}

export async function findAuthoritativeGlobalProjectionPackage(
  manifest,
  {
    homeRoot = os.homedir(),
    expectedPackageName = "meta-kim",
    expectedPackageVersion,
    expectedFirstPartyClosure = null,
    expectedSourcePackageContentClosure = null,
  } = {},
) {
  const expectedClosure = expectedFirstPartyClosure ??
    expectedSourcePackageContentClosure;
  if (
    manifest?.scope !== "global" ||
    typeof expectedPackageVersion !== "string" ||
    manifest.metaKimVersion !== expectedPackageVersion ||
    !SHA256_RE.test(expectedClosure?.sha256 ?? "") ||
    !Number.isInteger(expectedClosure?.entryCount) ||
    expectedClosure.entryCount < 1
  ) return null;
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const versionRoot = path.join(
    path.resolve(homeRoot),
    ".meta-kim",
    "runtime",
    "projection-packages",
    ...packageNameSegments(expectedPackageName),
    assertVersion(expectedPackageVersion),
  );
  const candidates = entries
    .filter((entry) =>
      entry.source === PROJECTION_PACKAGE_MANIFEST_SOURCE &&
      entry.purpose === PROJECTION_PACKAGE_PURPOSE.bundle &&
      entry.category === CATEGORIES.C &&
      entry.kind === "dir" &&
      entry.ownershipClass === "install_projection" &&
      entry.runtimeTarget == null &&
      pathKey(path.dirname(entry.path)) === pathKey(versionRoot) &&
      SHA256_RE.test(path.basename(entry.path))
    )
    .sort((left, right) =>
      String(right.installedAt ?? "").localeCompare(String(left.installedAt ?? ""))
    );
  const candidate = candidates[0];
  if (!candidate) return null;
  try {
    const verified = await verifyGlobalProjectionPackage(candidate.path, {
      homeRoot,
      expectedPackageName,
      expectedPackageVersion,
      expectedFirstPartyClosure: expectedClosure,
    });
    const closure = directoryClosureSync(verified.digestDir);
    if (
      !closure ||
      closure.sha256 !== candidate.directoryClosureSha256 ||
      closure.entryCount !== candidate.directoryClosureEntryCount
    ) return null;
    const required = [
      [PROJECTION_PACKAGE_PURPOSE.receipt, verified.receiptPath],
      [PROJECTION_PACKAGE_PURPOSE.packageManifest, verified.packageManifestPath],
      [PROJECTION_PACKAGE_PURPOSE.cli, verified.cliPath],
      [PROJECTION_PACKAGE_PURPOSE.syncScript, verified.syncScriptPath],
    ];
    if (required.every(([purpose, filePath]) =>
        entries.some((entry) =>
          entry.source === PROJECTION_PACKAGE_MANIFEST_SOURCE &&
          entry.purpose === purpose &&
          entry.category === CATEGORIES.C &&
          manifestFileMatches(entry, filePath)
        )
      )) return verified;
  } catch {
    // The newest authority for this exact version is invalid. Fail closed;
    // never fall back to an older digest or version.
  }
  return null;
}

export async function recordGlobalProjectionPackage(recorder, verifiedPackage) {
  const verified = await verifyGlobalProjectionPackage(verifiedPackage.digestDir, {
    homeRoot: verifiedPackage.homeRoot,
    expectedPackageName: verifiedPackage.packageName,
    expectedPackageVersion: verifiedPackage.packageVersion,
    expectedPackageTarballSha256: verifiedPackage.packageTarballSha256,
  });
  const currentEntries = recorder.snapshot()?.entries ?? [];
  for (const entry of currentEntries) {
    const isProjectionPackageAuthority =
      entry.source === PROJECTION_PACKAGE_MANIFEST_SOURCE &&
      entry.category === CATEGORIES.C &&
      (
        entry.purpose === PROJECTION_PACKAGE_PURPOSE.bundle ||
        entry.purpose?.startsWith(`${PROJECTION_PACKAGE_PURPOSE.bundle}:`)
      );
    if (
      isProjectionPackageAuthority &&
      !pathAtOrWithin(verified.digestDir, entry.path)
    ) {
      recorder.forget(entry.path, entry.purpose);
    }
  }
  recorder.recordDir(verified.digestDir, {
    source: PROJECTION_PACKAGE_MANIFEST_SOURCE,
    purpose: PROJECTION_PACKAGE_PURPOSE.bundle,
    category: CATEGORIES.C,
  });
  // Stamp the closed directory record with the same explicit install
  // ownership identity required from its file proofs. recordFile(kind=dir)
  // merges into the existing record without replacing its closure fields.
  recorder.recordFile(verified.digestDir, {
    source: PROJECTION_PACKAGE_MANIFEST_SOURCE,
    purpose: PROJECTION_PACKAGE_PURPOSE.bundle,
    category: CATEGORIES.C,
    kind: "dir",
    ownershipClass: "install_projection",
  });
  for (const [purpose, filePath] of [
    [PROJECTION_PACKAGE_PURPOSE.receipt, verified.receiptPath],
    [PROJECTION_PACKAGE_PURPOSE.packageManifest, verified.packageManifestPath],
    [PROJECTION_PACKAGE_PURPOSE.cli, verified.cliPath],
    [PROJECTION_PACKAGE_PURPOSE.syncScript, verified.syncScriptPath],
  ]) {
    recorder.recordFile(filePath, {
      source: PROJECTION_PACKAGE_MANIFEST_SOURCE,
      purpose,
      category: CATEGORIES.C,
      ownershipClass: "install_projection",
    });
  }
  return verified;
}

export async function runGlobalProjectionPackageChild(
  verifiedPackage,
  args,
  { env = process.env, sourceRoot = null } = {},
) {
  const fresh = await verifyGlobalProjectionPackage(verifiedPackage.digestDir, {
    homeRoot: verifiedPackage.homeRoot,
    expectedPackageName: verifiedPackage.packageName,
    expectedPackageVersion: verifiedPackage.packageVersion,
    expectedPackageTarballSha256: verifiedPackage.packageTarballSha256,
    expectedFirstPartyClosure: verifiedPackage.firstPartyClosure,
  });
  if (pathKey(fresh.packageRoot) !== pathKey(verifiedPackage.packageRoot)) {
    throw new Error("Projection package changed before stable child launch");
  }
  const childEnv = sanitizeProjectionPackageEnvironment(env, {
    sourceRoot: sourceRoot ?? env.INIT_CWD ?? process.cwd(),
    storeRoot: fresh.storeRoot,
  });
  childEnv.META_KIM_REPO_ROOT = fresh.packageRoot;
  return spawnSync(
    process.execPath,
    [fresh.syncScriptPath, ...args],
    {
      cwd: fresh.packageRoot,
      env: childEnv,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    },
  );
}
