import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { request as httpRequest } from "node:http";
import { promises as fs } from "node:fs";
import { connect as connectSocket } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  getProcessStartIdentity,
  processIsAlive,
} from "../../../scripts/release-state-hardening.mjs";
import { LIVE_PROFILE_PATTERN } from "./live-read-repository.mjs";

export const LIVE_HUB_STATE_SCHEMA_VERSION = "meta-kim-live-hub-state-v1";
export const LIVE_HUB_HEALTH_SCHEMA_VERSION = "meta-kim-live-hub-health-v1";
export const LIVE_HUB_LOOPBACK_HOST = "127.0.0.1";

const PROJECT_REF_PATTERN = /^project-[a-f0-9]{12}$/u;
const RUN_ID_PATTERN = /^meta-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const INSTANCE_ID_PATTERN = /^[a-f0-9-]{16,64}$/u;
/**
 * Files whose contents identify the package a running hub was started from.
 *
 * A hub is reused only when its recorded hash still matches the current
 * package, so an update replaces a stale hub instead of talking to it. Three
 * rules follow from that purpose. The set must cover the whole import closure of
 * `scripts/meta-kim-live.mjs`, because that is what the detached daemon actually
 * executes — an omitted module can be edited without changing the hash, and the
 * fast-reuse path then accepts a hub running stale bytes. Membership is therefore
 * decided by that closure, not by directory name, which is why data-layer and
 * shared-domain modules belong here alongside the Live ones. Conversely a file
 * belongs here only if shipped code loads it: hashing a module nothing imports
 * forces hub replacements that cannot change any behaviour. And every entry must
 * be covered by the `files` whitelist in package.json, because a path the tarball
 * omits makes the hash unobtainable and the packed hub then refuses to start with
 * `package_identity_unavailable`. All three rules are asserted by
 * tests/live/live-package-closure.test.mjs.
 */
export const LIVE_HUB_RUNTIME_IDENTITY_PATHS = Object.freeze([
  "scripts/meta-kim-live.mjs",
  "scripts/project-registry.mjs",
  "scripts/release-state-hardening.mjs",
  "src/domain/live/live-continuation-command.mjs",
  "src/domain/live/live-share-artifact.mjs",
  "src/domain/shared/canonical-digest.mjs",
  "src/application/live/build-live-share-artifact.mjs",
  "src/application/live/live-acceptance-fixture-loader.mjs",
  "src/application/live/live-catalog-scan-policy.mjs",
  "src/application/live/live-control-room-service.mjs",
  "src/application/live/live-conversation-link-vocabulary.mjs",
  "src/application/live/live-default-selection.mjs",
  "src/application/live/live-display-format.mjs",
  "src/application/live/live-graph-camera.mjs",
  "src/application/live/live-hub-lifecycle-budget.mjs",
  "src/application/live/live-record-origin.mjs",
  "src/application/live/live-replay-visibility.mjs",
  "src/application/live/live-run-retention.mjs",
  "src/application/live/live-run-substance.mjs",
  "src/application/live/live-run-visibility.mjs",
  "src/application/live/live-scheduling-projection.mjs",
  "src/application/live/live-spacing-scale.mjs",
  "src/application/live/live-status-vocabulary.mjs",
  "src/application/live/live-stream-policy.mjs",
  "src/application/live/live-typography-scale.mjs",
  "src/application/live/live-viewport-budget.mjs",
  "src/application/live/plan-live-continuation.mjs",
  "src/data/sqlite/runtime.mjs",
  "src/data/sqlite/transaction.mjs",
  "src/infrastructure/live/live-continuation-command-store.mjs",
  "src/infrastructure/live/live-control-room-server.mjs",
  "src/infrastructure/live/live-hub-lifecycle.mjs",
  "src/infrastructure/live/live-hub-project-catalog.mjs",
  "src/infrastructure/live/live-read-repository.mjs",
  "src/infrastructure/live/live-run-retention-store.mjs",
  "src/infrastructure/live/live-runtime-adapter-registry.mjs",
  "src/presentation/live/live-control-room-page.mjs",
  "src/presentation/live/render-live-share-card.mjs",
  "src/sdk/live/common.mjs",
  "src/sdk/live/evidence-card.mjs",
  "src/sdk/live/index.mjs",
  "src/sdk/live/replay-theme.mjs",
  "src/sdk/live/runtime-adapter.mjs",
]);

export function getLiveHubPaths({ homeDir = os.homedir() } = {}) {
  const root = path.join(homeDir, ".meta-kim", "live");
  return {
    root,
    statePath: path.join(root, "hub.json"),
    stdoutLogPath: path.join(root, "hub.stdout.log"),
    stderrLogPath: path.join(root, "hub.stderr.log"),
    startLockPath: path.join(root, "start.lock"),
    startLockOwnerPath: path.join(root, "start.lock", "owner.json"),
  };
}

function samePhysicalPath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function requirePlainPhysicalDirectory(directoryPath, label) {
  const stat = await fs.lstat(directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a plain directory`);
  }
  const real = await fs.realpath(directoryPath);
  if (!samePhysicalPath(real, directoryPath)) {
    throw new Error(`${label} must not resolve through a symlink or junction`);
  }
  return real;
}

async function prepareLiveHubPaths({ homeDir = os.homedir(), createRoot = false } = {}) {
  const paths = getLiveHubPaths({ homeDir: path.resolve(homeDir) });
  await requirePlainPhysicalDirectory(path.resolve(homeDir), "Live Hub home");
  let current = path.resolve(homeDir);
  for (const segment of [".meta-kim", "live"]) {
    current = path.join(current, segment);
    try {
      await requirePlainPhysicalDirectory(current, `Live Hub ${segment} directory`);
    } catch (error) {
      if (error?.code !== "ENOENT" || !createRoot) throw error;
      try {
        await fs.mkdir(current);
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      }
      await requirePlainPhysicalDirectory(current, `Live Hub ${segment} directory`);
    }
  }
  if (!samePhysicalPath(current, paths.root)) throw new Error("Live Hub root escaped its home directory");
  return paths;
}

async function requireManagedLeaf(filePath, root, { allowMissing = true, directory = false } = {}) {
  const parent = path.dirname(filePath);
  if (!samePhysicalPath(parent, root) && !samePhysicalPath(parent, path.join(root, "start.lock"))) {
    throw new Error("Live Hub managed path escaped its root");
  }
  await requirePlainPhysicalDirectory(parent, "Live Hub managed parent");
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error("Live Hub managed leaf has an unsafe type");
    }
  } catch (error) {
    if (error?.code !== "ENOENT" || !allowMissing) throw error;
  }
}

function defaultPortOccupied(port, { timeoutMs = 250 } = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const socket = connectSocket({ host: LIVE_HUB_LOOPBACK_HOST, port });
    const finish = (occupied) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function openDaemonLogs(homeDir) {
  const paths = await prepareLiveHubPaths({ homeDir, createRoot: true });
  await requireManagedLeaf(paths.stdoutLogPath, paths.root);
  await requireManagedLeaf(paths.stderrLogPath, paths.root);
  const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;
  const stdout = await fs.open(paths.stdoutLogPath, flags, 0o600);
  try {
    const stderr = await fs.open(paths.stderrLogPath, flags, 0o600);
    return { stdout, stderr, paths };
  } catch (error) {
    await stdout.close();
    throw error;
  }
}

function validState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const port = Number(value.port);
  if (
    value.schemaVersion !== LIVE_HUB_STATE_SCHEMA_VERSION ||
    value.host !== LIVE_HUB_LOOPBACK_HOST ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.processStartIdentity !== "string" ||
    !value.processStartIdentity ||
    typeof value.instanceId !== "string" ||
    !INSTANCE_ID_PATTERN.test(value.instanceId) ||
    typeof value.packageVersion !== "string" ||
    value.packageVersion.length < 1 ||
    value.packageVersion.length > 64 ||
    typeof value.packageIdentity !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.packageIdentity) ||
    typeof value.profile !== "string" ||
    !LIVE_PROFILE_PATTERN.test(value.profile) ||
    value.url !== `http://${LIVE_HUB_LOOPBACK_HOST}:${port}`
  ) return null;
  return { ...value, port };
}

/**
 * Whether the PID in a recorded state still looks like the process that wrote it.
 *
 * `validState` already requires a non-empty recorded identity, so the only
 * ambiguity left is an observed identity the OS refused to produce. That reads as
 * unknown, not as a different process — the same asymmetry `lockOwnerAppearsLive`
 * and `readReusableLiveHub`'s `identity_unavailable` status use.
 */
function incumbentIdentityStillHolds(incumbent, readProcessStartIdentity) {
  const observed = readProcessStartIdentity(incumbent.pid);
  return observed == null || observed === incumbent.processStartIdentity;
}

async function readJson(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function atomicWriteJson(filePath, value, { containmentRoot = path.dirname(filePath) } = {}) {
  await requireManagedLeaf(filePath, containmentRoot);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await requireManagedLeaf(temporaryPath, containmentRoot);
  const handle = await fs.open(temporaryPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await requireManagedLeaf(filePath, containmentRoot);
  await requireManagedLeaf(temporaryPath, containmentRoot, { allowMissing: false });
  await fs.rename(temporaryPath, filePath);
}

function defaultHealthProbe(state, { timeoutMs = 750 } = {}) {
  return new Promise((resolve) => {
    const request = httpRequest({
      host: LIVE_HUB_LOOPBACK_HOST,
      port: state.port,
      path: "/api/health",
      method: "GET",
      headers: { accept: "application/json" },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 64 * 1024) chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(response.statusCode === 200 &&
            payload?.schemaVersion === LIVE_HUB_HEALTH_SCHEMA_VERSION &&
            payload?.instanceId === state.instanceId &&
            payload?.packageIdentity === state.packageIdentity &&
            payload?.profile === state.profile);
        } catch {
          resolve(false);
        }
      });
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
    request.end();
  });
}

async function inspectLiveHub({
  homeDir = os.homedir(),
  healthProbe = defaultHealthProbe,
  isProcessAlive = processIsAlive,
  readProcessStartIdentity = getProcessStartIdentity,
  // Only callers that act on the recorded PID itself need creation-time proof.
  // Reuse callers reach the hub over loopback and never touch the PID.
  requireProcessIdentity = false,
} = {}) {
  let statePath;
  try {
    ({ statePath } = await prepareLiveHubPaths({ homeDir, createRoot: false }));
  } catch {
    return { status: "absent", state: null };
  }
  const state = validState(await readJson(statePath));
  if (!state || !isProcessAlive(state.pid)) return { status: "absent", state: null };
  const healthy = await healthProbe(state);
  // For reuse the health probe is both cheaper and stronger than a creation-time
  // match: it round-trips the loopback endpoint and compares the lifecycle-owned
  // instanceId, package identity and profile. Creation time is what keeps a
  // recycled PID from being signalled, so it is probed when the caller will act
  // on the PID or needs to tell a wedged hub from a dead one. Probing it on
  // every reuse check cost 1867-5020ms on Windows and reported a healthy hub as
  // unusable whenever the OS query timed out.
  if (healthy && !requireProcessIdentity) return { status: "reusable", state };
  const observedIdentity = readProcessStartIdentity(state.pid);
  if (!observedIdentity) return { status: "identity_unavailable", state };
  if (observedIdentity !== state.processStartIdentity) return { status: "absent", state: null };
  return healthy ? { status: "reusable", state } : { status: "health_unavailable", state };
}

export async function readReusableLiveHub(options = {}) {
  const inspection = await inspectLiveHub(options);
  return inspection.status === "reusable" ? inspection.state : null;
}

async function acquireStartLock({
  homeDir,
  now = Date.now,
  isProcessAlive = processIsAlive,
  readProcessStartIdentity = getProcessStartIdentity,
  staleAfterMs = 30_000,
} = {}) {
  const paths = await prepareLiveHubPaths({ homeDir, createRoot: true });
  const token = randomUUID();
  const claim = async () => {
    await requirePlainPhysicalDirectory(paths.root, "Live Hub root");
    await fs.mkdir(paths.startLockPath);
    await requireManagedLeaf(paths.startLockPath, paths.root, { allowMissing: false, directory: true });
    await atomicWriteJson(paths.startLockOwnerPath, {
      token,
      pid: process.pid,
      processStartIdentity: readProcessStartIdentity(process.pid),
      acquiredAt: new Date(now()).toISOString(),
    }, { containmentRoot: paths.startLockPath });
    return { acquired: true, token, ...paths };
  };
  try {
    return await claim();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const owner = await readJson(paths.startLockOwnerPath);
  const ownerAlive = Number.isSafeInteger(owner?.pid) && isProcessAlive(owner.pid);
  const observedIdentity = ownerAlive ? readProcessStartIdentity(owner.pid) : null;
  if (ownerAlive && (!owner?.processStartIdentity || observedIdentity === owner.processStartIdentity)) {
    return { acquired: false, reason: "start_in_progress", ...paths };
  }
  let ageMs = 0;
  try {
    ageMs = Math.max(0, now() - (await fs.stat(paths.startLockPath)).mtimeMs);
  } catch {
    return { acquired: false, reason: "lock_unreadable", ...paths };
  }
  if (ageMs < staleAfterMs) return { acquired: false, reason: "lock_initializing", ...paths };

  const stalePath = `${paths.startLockPath}.stale.${token}`;
  try {
    await requirePlainPhysicalDirectory(paths.root, "Live Hub root");
    await requireManagedLeaf(paths.startLockPath, paths.root, { allowMissing: false, directory: true });
    await fs.rename(paths.startLockPath, stalePath);
    await requireManagedLeaf(stalePath, paths.root, { allowMissing: false, directory: true });
    const lock = await claim();
    await requireManagedLeaf(stalePath, paths.root, { allowMissing: false, directory: true });
    await fs.rm(stalePath, { recursive: true, force: true });
    return lock;
  } catch {
    await requireManagedLeaf(stalePath, paths.root, { allowMissing: true, directory: true })
      .then(() => fs.rm(stalePath, { recursive: true, force: true }))
      .catch(() => {});
    return { acquired: false, reason: "lock_contended", ...paths };
  }
}

async function releaseStartLock(lock) {
  if (!lock?.acquired) return;
  const owner = await readJson(lock.startLockOwnerPath);
  if (owner?.token === lock.token) {
    await requirePlainPhysicalDirectory(lock.root, "Live Hub root");
    await requireManagedLeaf(lock.startLockPath, lock.root, { allowMissing: false, directory: true });
    await fs.rm(lock.startLockPath, { recursive: true, force: true });
  }
}

function deepLinkFor(state, { projectRef = null, runId = null } = {}) {
  const url = new URL(state.url);
  if (PROJECT_REF_PATTERN.test(projectRef || "")) url.searchParams.set("projectId", projectRef);
  if (RUN_ID_PATTERN.test(runId || "")) url.searchParams.set("runId", runId);
  return url.href;
}

async function waitForReusableHub(options, timeoutMs, expectedAuthority = null) {
  const deadline = Date.now() + timeoutMs;
  do {
    const state = await readReusableLiveHub(options);
    if (state && (!expectedAuthority || (
      state.packageVersion === expectedAuthority.packageVersion &&
      state.packageIdentity === expectedAuthority.packageIdentity &&
      state.profile === expectedAuthority.profile
    ))) return state;
    await new Promise((resolve) => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  return null;
}

async function waitForSpawnedHub(options, timeoutMs, expectedAuthority, child) {
  let childFailure = null;
  const onError = () => { childFailure = "spawn_error"; };
  const onExit = () => { childFailure = "child_exit"; };
  child.once?.("error", onError);
  child.once?.("exit", onExit);
  const deadline = Date.now() + timeoutMs;
  try {
    do {
      if (childFailure || (child.exitCode !== null && child.exitCode !== undefined)) {
        return { state: null, childFailure: childFailure || "child_exit" };
      }
      const state = await readReusableLiveHub(options);
      if (state && (
        state.packageVersion === expectedAuthority.packageVersion &&
        state.packageIdentity === expectedAuthority.packageIdentity &&
        state.profile === expectedAuthority.profile
      )) return { state, childFailure: null };
      await new Promise((resolve) => setTimeout(resolve, 75));
    } while (Date.now() < deadline);
    return { state: null, childFailure: null };
  } finally {
    child.off?.("error", onError);
    child.off?.("exit", onExit);
  }
}

async function packageVersionAt(packageRoot) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    return typeof value?.version === "string" && value.version.length <= 64 ? value.version : "unknown";
  } catch {
    return "unknown";
  }
}

// The reader above falls back to "unknown", and a state file records whatever the
// Hub that wrote it declared, so an unorderable pair answers "not older" rather
// than guessing a direction.
function declaredVersionIsOlder(candidate, reference) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(String(value ?? "").trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
  };
  const left = parse(candidate);
  const right = parse(reference);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

async function packageIdentityAt(packageRoot) {
  try {
    const canonicalRoot = await fs.realpath(packageRoot);
    const digest = createHash("sha256");
    digest.update(process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot);
    for (const relativePath of ["package.json", ...LIVE_HUB_RUNTIME_IDENTITY_PATHS]) {
      digest.update(relativePath);
      digest.update(await fs.readFile(path.join(canonicalRoot, relativePath)));
    }
    return digest.digest("hex");
  } catch {
    return null;
  }
}

async function removeStateForInstance(homeDir, instanceId) {
  let paths;
  try {
    paths = await prepareLiveHubPaths({ homeDir, createRoot: false });
  } catch {
    return false;
  }
  const { statePath } = paths;
  const state = validState(await readJson(statePath));
  if (state?.instanceId !== instanceId) return false;
  await requireManagedLeaf(statePath, paths.root, { allowMissing: false });
  await fs.rm(statePath, { force: true });
  return true;
}

async function terminateSpawnedChild(child, timeoutMs = 1_500) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0 || child.exitCode !== null) return false;
  const exited = new Promise((resolve) => child.once?.("exit", () => resolve(true)));
  try {
    child.kill?.("SIGTERM");
  } catch {
    return false;
  }
  const stopped = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!stopped && child.exitCode === null) {
    try {
      child.kill?.("SIGKILL");
    } catch {
      return false;
    }
  }
  return true;
}

export async function stopLiveHub({
  homeDir = os.homedir(),
  instanceId = null,
  allowAnyInstance = false,
  timeoutMs = 3_000,
  healthProbe = defaultHealthProbe,
  isProcessAlive = processIsAlive,
  readProcessStartIdentity = getProcessStartIdentity,
  signalProcess = (pid) => process.kill(pid, "SIGTERM"),
} = {}) {
  // Naming the owner is the safe branch, so it must not be the opt-in one. The
  // ownership check below reads `instanceId &&`, which a null default skips
  // silently, so an importer that simply omitted the argument stopped whichever
  // Hub was recorded. A caller that genuinely means "replace whichever
  // singleton is recorded" — what a person typing --restart is asking for —
  // waives the check by name, and omitting both is refused.
  if (!allowAnyInstance && !INSTANCE_ID_PATTERN.test(instanceId ?? "")) {
    return { status: "instance_authority_required", stopped: false };
  }
  const observed = { homeDir, healthProbe, isProcessAlive, readProcessStartIdentity };
  // Signalling is the one operation that acts on the recorded PID, so the
  // decision to signal demands creation-time proof that the PID is still this
  // hub. The flag is set here rather than by callers so a takeover path cannot
  // forget it. Waiting for the process to disappear only observes, so it uses
  // the cheap inspection; probing per poll would outlast the stop budget.
  const state = await readReusableLiveHub({ ...observed, requireProcessIdentity: true });
  if (!state || (instanceId && state.instanceId !== instanceId)) {
    return { status: "not_running", stopped: false };
  }
  try {
    signalProcess(state.pid);
  } catch {
    return { status: "signal_failed", stopped: false };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await readReusableLiveHub(observed))) {
      await removeStateForInstance(homeDir, state.instanceId);
      return { status: "stopped", stopped: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return { status: "stop_timeout", stopped: false };
}

export const LIVE_HUB_DEFAULT_PORT = 4331;

export async function ensureLiveHub({
  packageRoot,
  homeDir = os.homedir(),
  profile = "default",
  allowProfileTakeover = false,
  allowBuildTakeover = false,
  projectRef = null,
  runId = null,
  port = LIVE_HUB_DEFAULT_PORT,
  timeoutMs = 5_000,
  healthProbe = defaultHealthProbe,
  isProcessAlive = processIsAlive,
  readProcessStartIdentity = getProcessStartIdentity,
  spawnProcess = spawn,
  signalProcess = (pid) => process.kill(pid, "SIGTERM"),
  portOccupiedProbe = defaultPortOccupied,
} = {}) {
  if (typeof packageRoot !== "string" || !path.isAbsolute(packageRoot)) {
    return { status: "unavailable", started: false, reason: "package_root_required" };
  }
  if (typeof profile !== "string" || !LIVE_PROFILE_PATTERN.test(profile)) {
    return { status: "unavailable", started: false, reason: "profile_invalid" };
  }
  const scriptPath = path.join(packageRoot, "scripts", "meta-kim-live.mjs");
  try {
    const stat = await fs.lstat(scriptPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: "unavailable", started: false, reason: "launcher_unavailable" };
    }
  } catch {
    return { status: "unavailable", started: false, reason: "launcher_unavailable" };
  }
  const common = { homeDir, healthProbe, isProcessAlive, readProcessStartIdentity };
  const expectedPackageVersion = await packageVersionAt(packageRoot);
  const expectedPackageIdentity = await packageIdentityAt(packageRoot);
  if (!expectedPackageIdentity) {
    return { status: "unavailable", started: false, reason: "package_identity_unavailable" };
  }
  const expectedAuthority = {
    packageVersion: expectedPackageVersion,
    packageIdentity: expectedPackageIdentity,
    profile,
  };
  // "reused" alone could not say which build answered: keeping a Hub whose build
  // could not be matched and reusing an exact match returned byte-identical
  // envelopes, so no caller could report that the port was serving code it never
  // built. `buildMatch` follows the spread because a state file is written by
  // whichever Hub answered, and that Hub must not get to declare its own match.
  const reusedResult = (state, buildMatch) => ({
    status: "reused",
    started: false,
    ...state,
    buildMatch,
    deepLink: deepLinkFor(state, { projectRef, runId }),
  });
  let fastState = null;
  try {
    const { statePath } = await prepareLiveHubPaths({ homeDir, createRoot: false });
    fastState = validState(await readJson(statePath));
  } catch {
    fastState = null;
  }
  if (
    fastState?.packageVersion === expectedPackageVersion &&
    fastState?.packageIdentity === expectedPackageIdentity &&
    fastState?.profile === profile &&
    await healthProbe(fastState)
  ) {
    return reusedResult(fastState, "expected");
  }
  // Past the fast reuse path above, every remaining outcome either takes over or
  // refuses, so PID proof is required here and costs nothing in the common case.
  const authoritative = { ...common, requireProcessIdentity: true };
  let inspection = await inspectLiveHub(authoritative);
  if (["identity_unavailable", "health_unavailable"].includes(inspection.status)) {
    return { status: "unavailable", started: false, reason: `live_hub_${inspection.status}` };
  }
  let reusable = inspection.state;
  let lock = null;
  // Ordered so that no pair of differences can express two authorities at once.
  // A strictly older declared version is the only provable staleness: the
  // identity digest covers the package root path as well as the file bytes, so
  // a source-tree Hub and an installed-release Hub never match in either
  // direction, and reading that as "old" let the hook — pinned to the installed
  // root by --package-root — terminate the Hub its user was watching. A profile
  // is decided before an unordered build difference because it is a data scope:
  // reusing the wrong scope would answer with the wrong runs.
  const buildDiffers = (state) =>
    state.packageVersion !== expectedPackageVersion || state.packageIdentity !== expectedPackageIdentity;
  const takeoverPlan = (state) => {
    if (declaredVersionIsOlder(state.packageVersion, expectedPackageVersion)) return "replace";
    if (state.profile !== profile) return allowProfileTakeover ? "replace" : "profile_in_use";
    if (buildDiffers(state)) return allowBuildTakeover ? "replace" : "keep";
    return "reuse";
  };
  const plan = reusable ? takeoverPlan(reusable) : null;
  if (plan === "profile_in_use") {
    return { status: "unavailable", started: false, reason: "profile_in_use", profile: reusable.profile };
  }
  if (plan === "replace") {
    lock = await acquireStartLock({ homeDir, isProcessAlive, readProcessStartIdentity });
    if (!lock.acquired) {
      const upgraded = await waitForReusableHub(common, timeoutMs, expectedAuthority);
      return upgraded
        ? reusedResult(upgraded, "expected")
        : { status: "unavailable", started: false, reason: lock.reason };
    }
    inspection = await inspectLiveHub(authoritative);
    if (["identity_unavailable", "health_unavailable"].includes(inspection.status)) {
      await releaseStartLock(lock);
      return { status: "unavailable", started: false, reason: `live_hub_${inspection.status}` };
    }
    reusable = inspection.state;
    const relocked = reusable ? takeoverPlan(reusable) : null;
    if (relocked === "profile_in_use") {
      await releaseStartLock(lock);
      return { status: "unavailable", started: false, reason: "profile_in_use", profile: reusable.profile };
    }
    if (relocked === "keep" || relocked === "reuse") {
      await releaseStartLock(lock);
      return reusedResult(reusable, relocked === "keep" ? "foreign" : "expected");
    }
    // Nothing proven under the lock means nothing to stop. stopLiveHub re-reads
    // the state file, so an unnamed stop here could pick up a Hub that appeared
    // between the two reads and signal that one instead.
    if (reusable) {
      const stopped = await stopLiveHub({
        ...common,
        instanceId: reusable.instanceId,
        timeoutMs,
        signalProcess,
      });
      if (!stopped.stopped) {
        await releaseStartLock(lock);
        return { status: "unavailable", started: false, reason: "version_mismatch_restart_failed" };
      }
    }
    reusable = null;
  }
  if (reusable) {
    return reusedResult(reusable, plan === "keep" ? "foreign" : "expected");
  }
  if (!lock) lock = await acquireStartLock({ homeDir, isProcessAlive, readProcessStartIdentity });
  if (!lock.acquired) {
    const state = await waitForReusableHub(common, timeoutMs, expectedAuthority);
    return state
      ? reusedResult(state, "expected")
      : { status: "unavailable", started: false, reason: lock.reason };
  }

  try {
    const instanceId = randomUUID();
    const requestedPort = Number.isSafeInteger(port) && port >= 0 && port <= 65_535 ? port : 0;
    const daemonLogs = await openDaemonLogs(homeDir);
    let child;
    let spawnFailed = false;
    try {
      child = spawnProcess(process.execPath, [
        scriptPath,
        "--daemon-child",
        "--no-open",
        "--port",
        String(requestedPort),
        "--profile",
        profile,
      ], {
        cwd: packageRoot,
        detached: true,
        stdio: ["ignore", daemonLogs.stdout.fd, daemonLogs.stderr.fd],
        windowsHide: true,
        env: {
          ...process.env,
          META_KIM_LIVE_HOME: homeDir,
          META_KIM_LIVE_INSTANCE_ID: instanceId,
          META_KIM_LIVE_PACKAGE_VERSION: expectedPackageVersion,
          META_KIM_LIVE_PACKAGE_IDENTITY: expectedPackageIdentity,
          META_KIM_PROFILE: profile,
        },
      });
    } catch {
      spawnFailed = true;
    } finally {
      await Promise.allSettled([daemonLogs.stdout.close(), daemonLogs.stderr.close()]);
    }
    if (spawnFailed || !child) {
      return {
        status: "unavailable",
        started: false,
        reason: requestedPort > 0 && await portOccupiedProbe(requestedPort)
          ? "port_in_use"
          : "daemon_spawn_failed",
      };
    }
    child.unref?.();
    const startResult = await waitForSpawnedHub(common, timeoutMs, expectedAuthority, child);
    if (startResult.state) {
      return {
        status: "started",
        started: true,
        ...startResult.state,
        deepLink: deepLinkFor(startResult.state, { projectRef, runId }),
      };
    }
    await terminateSpawnedChild(child, Math.min(timeoutMs, 1_500));
    const portInUse = requestedPort > 0 && await portOccupiedProbe(requestedPort);
    return {
      status: "unavailable",
      started: false,
      reason: portInUse
        ? "port_in_use"
        : startResult.childFailure === "spawn_error"
          ? "daemon_spawn_failed"
          : startResult.childFailure === "child_exit"
            ? "daemon_exited_before_ready"
            : "startup_timeout",
    };
  } finally {
    await releaseStartLock(lock);
  }
}

export async function writeLiveHubState({
  homeDir = process.env.META_KIM_LIVE_HOME || os.homedir(),
  address,
  instanceId = process.env.META_KIM_LIVE_INSTANCE_ID,
  pid = process.pid,
  processStartIdentity = getProcessStartIdentity(pid),
  packageVersion = process.env.META_KIM_LIVE_PACKAGE_VERSION || "unknown",
  packageIdentity = process.env.META_KIM_LIVE_PACKAGE_IDENTITY || "0".repeat(64),
  profile = process.env.META_KIM_PROFILE || "default",
  isProcessAlive = processIsAlive,
  readProcessStartIdentity = getProcessStartIdentity,
} = {}) {
  if (!address || address.host !== LIVE_HUB_LOOPBACK_HOST || !INSTANCE_ID_PATTERN.test(instanceId || "")) {
    throw new TypeError("Live Hub state requires a loopback address and valid instance id.");
  }
  const state = validState({
    schemaVersion: LIVE_HUB_STATE_SCHEMA_VERSION,
    instanceId,
    pid,
    processStartIdentity,
    packageVersion,
    packageIdentity,
    profile,
    host: address.host,
    port: address.port,
    url: address.url,
    startedAt: new Date().toISOString(),
  });
  if (!state) throw new TypeError("Live Hub state is incomplete.");
  const paths = await prepareLiveHubPaths({ homeDir, createRoot: true });
  // The singleton record is also the only way to find the running Hub, so
  // overwriting it while another process still holds the port makes that process
  // unreachable and unstoppable: every later stop signals the newly recorded PID.
  // A write is refused when the record names some other process that still
  // appears to be that Hub. Whether it appears to be that Hub follows the rule
  // the rest of this module already uses: a dead PID is residue, a PID whose
  // creation identity has provably changed was recycled by something unrelated,
  // and an identity the OS will not tell us is unknown rather than gone. Reading
  // unknown as gone would disable this exactly when the machine is loaded enough
  // for the PowerShell or /proc query to fail.
  const incumbent = validState(await readJson(paths.statePath));
  if (
    incumbent
    && incumbent.pid !== pid
    && isProcessAlive(incumbent.pid)
    && incumbentIdentityStillHolds(incumbent, readProcessStartIdentity)
  ) {
    throw new Error(`Live Hub is already serving on port ${incumbent.port} under another instance.`);
  }
  await atomicWriteJson(paths.statePath, state, { containmentRoot: paths.root });
  return state;
}

export async function removeOwnedLiveHubState({
  homeDir = process.env.META_KIM_LIVE_HOME || os.homedir(),
  instanceId = process.env.META_KIM_LIVE_INSTANCE_ID,
} = {}) {
  let paths;
  try {
    paths = await prepareLiveHubPaths({ homeDir, createRoot: false });
  } catch {
    return false;
  }
  const { statePath } = paths;
  const state = validState(await readJson(statePath));
  if (state?.instanceId === instanceId && state.pid === process.pid) {
    await requireManagedLeaf(statePath, paths.root, { allowMissing: false });
    await fs.rm(statePath, { force: true });
    return true;
  }
  return false;
}

export { deepLinkFor, validState as validateLiveHubState };
