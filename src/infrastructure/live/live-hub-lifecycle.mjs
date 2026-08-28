import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { promises as fs } from "node:fs";
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
export const LIVE_HUB_RUNTIME_IDENTITY_PATHS = Object.freeze([
  "scripts/meta-kim-live.mjs",
  "scripts/project-registry.mjs",
  "scripts/release-state-hardening.mjs",
  "src/domain/live/live-continuation-command.mjs",
  "src/domain/live/live-share-artifact.mjs",
  "src/application/live/build-live-share-artifact.mjs",
  "src/application/live/live-control-room-service.mjs",
  "src/application/live/plan-live-continuation.mjs",
  "src/infrastructure/live/live-continuation-command-store.mjs",
  "src/infrastructure/live/live-control-room-server.mjs",
  "src/infrastructure/live/live-hub-lifecycle.mjs",
  "src/infrastructure/live/live-hub-project-catalog.mjs",
  "src/infrastructure/live/live-read-repository.mjs",
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
    startLockPath: path.join(root, "start.lock"),
    startLockOwnerPath: path.join(root, "start.lock", "owner.json"),
  };
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

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporaryPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
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
} = {}) {
  const { statePath } = getLiveHubPaths({ homeDir });
  const state = validState(await readJson(statePath));
  if (!state || !isProcessAlive(state.pid)) return { status: "absent", state: null };
  const observedIdentity = readProcessStartIdentity(state.pid);
  if (!observedIdentity) return { status: "identity_unavailable", state };
  if (observedIdentity !== state.processStartIdentity) return { status: "absent", state: null };
  return (await healthProbe(state))
    ? { status: "reusable", state }
    : { status: "health_unavailable", state };
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
  const paths = getLiveHubPaths({ homeDir });
  await fs.mkdir(paths.root, { recursive: true });
  const token = randomUUID();
  const claim = async () => {
    await fs.mkdir(paths.startLockPath);
    await atomicWriteJson(paths.startLockOwnerPath, {
      token,
      pid: process.pid,
      processStartIdentity: readProcessStartIdentity(process.pid),
      acquiredAt: new Date(now()).toISOString(),
    });
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
    await fs.rename(paths.startLockPath, stalePath);
    const lock = await claim();
    await fs.rm(stalePath, { recursive: true, force: true });
    return lock;
  } catch {
    await fs.rm(stalePath, { recursive: true, force: true }).catch(() => {});
    return { acquired: false, reason: "lock_contended", ...paths };
  }
}

async function releaseStartLock(lock) {
  if (!lock?.acquired) return;
  const owner = await readJson(lock.startLockOwnerPath);
  if (owner?.token === lock.token) {
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

async function packageVersionAt(packageRoot) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
    return typeof value?.version === "string" && value.version.length <= 64 ? value.version : "unknown";
  } catch {
    return "unknown";
  }
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
  const { statePath } = getLiveHubPaths({ homeDir });
  const state = validState(await readJson(statePath));
  if (state?.instanceId !== instanceId) return false;
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
  timeoutMs = 3_000,
  healthProbe = defaultHealthProbe,
  isProcessAlive = processIsAlive,
  readProcessStartIdentity = getProcessStartIdentity,
  signalProcess = (pid) => process.kill(pid, "SIGTERM"),
} = {}) {
  const common = { homeDir, healthProbe, isProcessAlive, readProcessStartIdentity };
  const state = await readReusableLiveHub(common);
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
    if (!(await readReusableLiveHub(common))) {
      await removeStateForInstance(homeDir, state.instanceId);
      return { status: "stopped", stopped: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return { status: "stop_timeout", stopped: false };
}

export async function ensureLiveHub({
  packageRoot,
  homeDir = os.homedir(),
  profile = "default",
  projectRef = null,
  runId = null,
  port = 0,
  timeoutMs = 5_000,
  healthProbe = defaultHealthProbe,
  isProcessAlive = processIsAlive,
  readProcessStartIdentity = getProcessStartIdentity,
  spawnProcess = spawn,
  signalProcess = (pid) => process.kill(pid, "SIGTERM"),
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
  const { statePath } = getLiveHubPaths({ homeDir });
  const fastState = validState(await readJson(statePath));
  if (
    fastState?.packageVersion === expectedPackageVersion &&
    fastState?.packageIdentity === expectedPackageIdentity &&
    fastState?.profile === profile &&
    await healthProbe(fastState)
  ) {
    return {
      status: "reused",
      started: false,
      ...fastState,
      deepLink: deepLinkFor(fastState, { projectRef, runId }),
    };
  }
  let inspection = await inspectLiveHub(common);
  if (["identity_unavailable", "health_unavailable"].includes(inspection.status)) {
    return { status: "unavailable", started: false, reason: `live_hub_${inspection.status}` };
  }
  let reusable = inspection.state;
  let lock = null;
  if (reusable && (
      reusable.packageVersion !== expectedPackageVersion ||
      reusable.packageIdentity !== expectedPackageIdentity ||
      reusable.profile !== profile
  )) {
    lock = await acquireStartLock({ homeDir, isProcessAlive, readProcessStartIdentity });
    if (!lock.acquired) {
      const upgraded = await waitForReusableHub(common, timeoutMs, expectedAuthority);
      return upgraded
        ? { status: "reused", started: false, ...upgraded, deepLink: deepLinkFor(upgraded, { projectRef, runId }) }
        : { status: "unavailable", started: false, reason: lock.reason };
    }
    inspection = await inspectLiveHub(common);
    if (["identity_unavailable", "health_unavailable"].includes(inspection.status)) {
      await releaseStartLock(lock);
      return { status: "unavailable", started: false, reason: `live_hub_${inspection.status}` };
    }
    reusable = inspection.state;
    if (
      reusable?.packageVersion === expectedPackageVersion &&
      reusable?.packageIdentity === expectedPackageIdentity &&
      reusable?.profile === profile
    ) {
      await releaseStartLock(lock);
      return { status: "reused", started: false, ...reusable, deepLink: deepLinkFor(reusable, { projectRef, runId }) };
    }
    const stopped = await stopLiveHub({
      ...common,
      instanceId: reusable?.instanceId || null,
      timeoutMs,
      signalProcess,
    });
    if (reusable && !stopped.stopped) {
      await releaseStartLock(lock);
      return { status: "unavailable", started: false, reason: "version_mismatch_restart_failed" };
    }
    reusable = null;
  }
  if (reusable) {
    return { status: "reused", started: false, ...reusable, deepLink: deepLinkFor(reusable, { projectRef, runId }) };
  }
  if (!lock) lock = await acquireStartLock({ homeDir, isProcessAlive, readProcessStartIdentity });
  if (!lock.acquired) {
    const state = await waitForReusableHub(common, timeoutMs, expectedAuthority);
    return state
      ? { status: "reused", started: false, ...state, deepLink: deepLinkFor(state, { projectRef, runId }) }
      : { status: "unavailable", started: false, reason: lock.reason };
  }

  try {
    const instanceId = randomUUID();
    const requestedPort = Number.isSafeInteger(port) && port >= 0 && port <= 65_535 ? port : 0;
    const child = spawnProcess(process.execPath, [
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
      stdio: "ignore",
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
    child.once?.("error", () => {});
    child.unref?.();
    const state = await waitForReusableHub(common, timeoutMs, expectedAuthority);
    if (state) {
      return { status: "started", started: true, ...state, deepLink: deepLinkFor(state, { projectRef, runId }) };
    }
    await terminateSpawnedChild(child, Math.min(timeoutMs, 1_500));
    return { status: "unavailable", started: false, reason: "startup_timeout" };
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
  const { statePath } = getLiveHubPaths({ homeDir });
  await atomicWriteJson(statePath, state);
  return state;
}

export async function removeOwnedLiveHubState({
  homeDir = process.env.META_KIM_LIVE_HOME || os.homedir(),
  instanceId = process.env.META_KIM_LIVE_INSTANCE_ID,
} = {}) {
  const { statePath } = getLiveHubPaths({ homeDir });
  const state = validState(await readJson(statePath));
  if (state?.instanceId === instanceId && state.pid === process.pid) {
    await fs.rm(statePath, { force: true });
    return true;
  }
  return false;
}

export { deepLinkFor, validState as validateLiveHubState };
