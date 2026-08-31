#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createLiveControlRoomServer,
  createLiveServer,
  LOOPBACK_HOST,
  startLiveControlRoom,
} from "../src/infrastructure/live/live-control-room-server.mjs";
import {
  buildLiveSnapshot,
  createLiveControlRoomService,
} from "../src/application/live/live-control-room-service.mjs";
import { loadLiveHubLifecycleBudget } from "../src/application/live/live-hub-lifecycle-budget.mjs";
import {
  createLiveReadRepository,
  LIVE_PROFILE_PATTERN,
  resolveLiveProjectRoot,
} from "../src/infrastructure/live/live-read-repository.mjs";
import {
  ensureLiveHub,
  removeOwnedLiveHubState,
  stopLiveHub,
  writeLiveHubState,
} from "../src/infrastructure/live/live-hub-lifecycle.mjs";
import {
  ensureGovernedLiveProjectRegistration,
} from "./project-registry.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class LiveCliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "LiveCliUsageError";
    this.code = "usage_error";
    this.exitCode = 2;
  }
}

function nextValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new LiveCliUsageError(`${flag} requires a value.`);
  return value;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-root" || arg === "--root") {
      options.projectRoot = nextValue(argv, index, arg);
      index += 1;
      if (!path.isAbsolute(options.projectRoot)) throw new LiveCliUsageError("--project-root must be absolute.");
    } else if (arg === "--port") {
      const rawPort = nextValue(argv, index, arg);
      index += 1;
      if (!/^\d{1,5}$/u.test(rawPort)) throw new LiveCliUsageError("--port must be an integer from 0 to 65535.");
      options.port = Number(rawPort);
      if (options.port > 65_535) throw new LiveCliUsageError("--port must be an integer from 0 to 65535.");
    } else if (arg === "--profile") {
      options.profile = nextValue(argv, index, arg);
      index += 1;
      if (!LIVE_PROFILE_PATTERN.test(options.profile)) {
        throw new LiveCliUsageError("--profile must contain only letters, numbers, dot, underscore, or hyphen.");
      }
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--enable-control") {
      options.enableControl = true;
    } else if (arg === "--ensure") {
      options.ensure = true;
    } else if (arg === "--restart") {
      options.restart = true;
    } else if (arg === "--daemon-child") {
      options.daemonChild = true;
    } else if (arg === "--project-ref") {
      options.projectRef = nextValue(argv, index, arg);
      index += 1;
    } else if (arg === "--run-id") {
      options.runId = nextValue(argv, index, arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new LiveCliUsageError(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    "Meta_Kim Live Hub (global singleton, read-only by default, loopback only)",
    "Usage: meta-kim live [--project-root DIR] [--profile NAME] [--port PORT] [--restart] [--no-open] [--json] [--enable-control]",
    "Default mode starts or reuses one user-level Hub on 127.0.0.1, listing only registered projects and governed sessions; it exposes no mutation endpoint.",
    "--enable-control records an explicit control request, but the singleton CLI stays read-only unless a complete authority loadout is injected through the programmatic server API; otherwise it is fail-closed.",
  ].join("\n");
}

function openBrowser(url) {
  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

/**
 * Start the local sidecar from JavaScript callers. This is the public launch
 * surface used by the CLI and by lifecycle tests.
 */
export {
  buildLiveSnapshot,
  createLiveControlRoomServer,
  createLiveControlRoomService,
  createLiveReadRepository,
  createLiveServer,
  LOOPBACK_HOST,
  resolveLiveProjectRoot,
  startLiveControlRoom,
};

export function liveSelectionForRegistration(registration, runId = null) {
  const projectRef = registration?.registryStatus === "joined"
    ? registration.projectRef
    : null;
  return {
    projectRef,
    runId: projectRef ? runId : null,
  };
}

export { parseArgs };

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  if (!options.daemonChild) {
    const projectRoot = await resolveLiveProjectRoot(options);
    const registration = await ensureGovernedLiveProjectRegistration({
      homeDir: process.env.META_KIM_LIVE_HOME,
      repoPath: projectRoot,
      preferredProjectRef: options.projectRef,
      runtimeFamily: "shared",
      sourceRef: "meta-kim-live",
    });
    const { projectRef, runId } = liveSelectionForRegistration(registration, options.runId);
    const profile = options.profile || process.env.META_KIM_PROFILE || "default";
    const budget = loadLiveHubLifecycleBudget();
    if (options.restart === true) {
      const stopped = await stopLiveHub({
        homeDir: process.env.META_KIM_LIVE_HOME,
        timeoutMs: budget.stopBudgetMs,
      });
      if (["signal_failed", "stop_timeout"].includes(stopped.status)) {
        const error = new Error(stopped.status);
        error.code = stopped.status;
        throw error;
      }
    }
    const result = await ensureLiveHub({
      packageRoot: PACKAGE_ROOT,
      homeDir: process.env.META_KIM_LIVE_HOME,
      projectRef,
      runId,
      port: options.port,
      profile,
      timeoutMs: budget.startupBudgetMs,
    });
    if (result.status === "unavailable") {
      const error = new Error(result.reason || "startup_unavailable");
      error.code = result.reason || "startup_unavailable";
      throw error;
    }
    const publicResult = {
      status: result.status,
      started: result.started,
      host: result.host,
      port: result.port,
      url: result.url,
      deepLink: result.deepLink,
      readOnly: true,
      controlEnabled: false,
      controlRequested: options.enableControl === true,
      controlRisk: options.enableControl === true
        ? "control_requested_but_unavailable; fail_closed"
        : "read_only_default",
      singleton: true,
      profile,
      projectRegistered: projectRef !== null,
    };
    process.stdout.write(options.json
      ? `${JSON.stringify(publicResult)}\n`
      : `Meta_Kim Live Hub ${result.started ? "started" : "reused"} (${options.enableControl ? "control requested; fail-closed read-only" : "read-only"}): ${result.deepLink}\n`);
    if (options.open !== false) openBrowser(result.deepLink);
    return null;
  }

  if (!/^[a-f0-9-]{16,64}$/u.test(process.env.META_KIM_LIVE_INSTANCE_ID || "")) {
    const error = new Error("daemon child requires a lifecycle-owned instance id");
    error.code = "daemon_authority_required";
    throw error;
  }

  const controller = createLiveControlRoomServer({
    ...options,
    globalHub: options.daemonChild === true,
    homeDir: process.env.META_KIM_LIVE_HOME,
    instanceId: process.env.META_KIM_LIVE_INSTANCE_ID || null,
    packageIdentity: process.env.META_KIM_LIVE_PACKAGE_IDENTITY || null,
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await controller.close();
    } finally {
      await removeOwnedLiveHubState().catch(() => {});
      // A daemon owns no foreground work after its server is closed. Exit
      // explicitly so inherited runtime handles cannot leave an unreachable
      // listener process behind on Windows.
      process.exit(0);
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let address;
  try {
    address = await controller.start();
    await writeLiveHubState({
      address,
      profile: options.profile || process.env.META_KIM_PROFILE || "default",
    });
  } catch (error) {
    await controller.close().catch(() => {});
    await removeOwnedLiveHubState().catch(() => {});
    throw error;
  }
  process.stdout.write(options.json
    ? `${JSON.stringify({ ...address, readOnly: address.readOnly, controlEnabled: address.controlEnabled, controlHeader: address.controlHeader, controlCapabilities: address.controlCapabilities, controlRisk: address.controlRisk })}\n`
    : `Meta_Kim Live (${address.controlEnabled ? "control opt-in; guarded and fail-closed" : options.enableControl === true ? "control requested; fail-closed plan-only" : "read-only"}) listening on ${address.url}\n`);
  if (options.open !== false) openBrowser(address.url);
  return controller;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  main().catch((error) => {
    // Keep CLI errors bounded and path-free; callers still receive a non-zero
    // exit status without exposing filesystem details.
    const usageError = error instanceof LiveCliUsageError;
    process.stderr.write(`meta-kim-live failed: ${usageError ? error.message : error?.code || "startup_error"}\n`);
    // A daemon child has no terminal. Its stderr is the user-owned hub log, and
    // the launcher can only report `daemon_exited_before_ready`, so a bare code
    // here leaves the singleton's failure with no discoverable cause.
    if (process.argv.includes("--daemon-child") && !usageError) {
      process.stderr.write(`${error?.stack || `${error?.name || "Error"}: ${error?.message || "unknown"}`}\n`);
    }
    process.exitCode = usageError ? 2 : 1;
  });
}
