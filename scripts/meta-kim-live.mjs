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
import {
  createLiveReadRepository,
  LIVE_PROFILE_PATTERN,
  resolveLiveProjectRoot,
} from "../src/infrastructure/live/live-read-repository.mjs";

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
    "Meta_Kim Live (read-only by default, loopback only)",
    "Usage: meta-kim live [--project-root DIR] [--profile NAME] [--port PORT] [--no-open] [--json] [--enable-control]",
    "Default mode serves a read-only local control room on 127.0.0.1 and exposes no mutation endpoint.",
    "--enable-control opts into a guarded command endpoint; it requires same-origin, a server control token, durable authority, CAS/lease/fence/effect checks, and an injected capable adapter. Without those it remains plan-only and fail-closed.",
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

export { parseArgs };

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }
  const controller = createLiveControlRoomServer(options);
  const address = await controller.start();
  process.stdout.write(options.json
    ? `${JSON.stringify({ ...address, readOnly: address.readOnly, controlEnabled: address.controlEnabled, controlHeader: address.controlHeader, controlCapabilities: address.controlCapabilities, controlRisk: address.controlRisk })}\n`
    : `Meta_Kim Live (${address.controlEnabled ? "control opt-in; guarded and fail-closed" : options.enableControl === true ? "control requested; fail-closed plan-only" : "read-only"}) listening on ${address.url}\n`);
  if (options.open !== false) openBrowser(address.url);
  const stop = async () => {
    await controller.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return controller;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  main().catch((error) => {
    // Keep CLI errors bounded and path-free; callers still receive a non-zero
    // exit status without exposing filesystem details.
    const usageError = error instanceof LiveCliUsageError;
    process.stderr.write(`meta-kim-live failed: ${usageError ? error.message : error?.code || "startup_error"}\n`);
    process.exitCode = usageError ? 2 : 1;
  });
}
