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
  registerLiveNativeCodexBinding,
  registerLiveNativeZcodeBinding,
} from "./project-registry.mjs";
import { createCodexNativeSessionReader } from "../src/infrastructure/live/codex-native-session-reader.mjs";
import { createZcodeNativeSessionReader, nativeZcodeRunId } from "../src/infrastructure/live/zcode-native-session-reader.mjs";

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
    } else if (arg === "--observe-codex-thread" || arg === "--observe-codex-turn") {
      const value = nextValue(argv, index, arg);
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value)) throw new LiveCliUsageError(`${arg} requires a UUID.`);
      options[arg === "--observe-codex-thread" ? "nativeCodexThreadId" : "nativeCodexTurnId"] = value.toLowerCase();
      index += 1;
    } else if (arg === "--observe-zcode-session" || arg === "--observe-zcode-turn") {
      const value = nextValue(argv, index, arg);
      const pattern = arg === "--observe-zcode-session" ? /^sess_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu : /^turn_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
      if (!pattern.test(value)) throw new LiveCliUsageError(`${arg} requires an exact native identifier.`);
      options[arg === "--observe-zcode-session" ? "nativeZcodeSessionId" : "nativeZcodeTurnId"] = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new LiveCliUsageError(`Unknown option: ${arg}`);
    }
  }
  if (Boolean(options.nativeZcodeSessionId) !== Boolean(options.nativeZcodeTurnId)) {
    throw new LiveCliUsageError("--observe-zcode-session and --observe-zcode-turn must be supplied together.");
  }
  if (options.nativeZcodeSessionId && (options.nativeCodexThreadId || options.nativeCodexTurnId)) {
    throw new LiveCliUsageError("Choose one native runtime for this launch.");
  }
  if (options.nativeZcodeSessionId && options.runId && options.runId !== `native-zcode-${options.nativeZcodeSessionId}-${options.nativeZcodeTurnId}`) {
    throw new LiveCliUsageError("ZCode observation requires its deterministic native --run-id; governed run links require automatic task identity verification.");
  }
  return options;
}

function usage() {
  return [
    "Meta_Kim Live Hub (global singleton, read-only by default, loopback only)",
    "Usage: meta-kim live [--project-root DIR] [--profile NAME] [--port PORT] [--restart] [--no-open] [--json] [--enable-control]",
    "Default mode starts or reuses one user-level Hub on 127.0.0.1, listing only registered projects and governed sessions; it exposes no mutation endpoint.",
    "--enable-control records an explicit control request, but the singleton CLI stays read-only unless a complete authority loadout is injected through the programmatic server API; otherwise it is fail-closed.",
    "The Hub can observe the exact Codex thread from CODEX_THREAD_ID (or --observe-codex-thread UUID). A current-task link requires --run-id or --observe-codex-turn UUID; a thread alone cannot identify the current turn. A reused Hub adds this trusted local binding without replacing other viewers. This only reads native events and never calls a model.",
    "ZCode read-only observation is opt-in: --observe-zcode-session sess_ID --observe-zcode-turn turn_ID. Both native identifiers and the project's directory are verified against the local session database. Manual observation uses its deterministic native run link; existing governed links require an automatic exact task-identity match. No model is called and no ZCode data is written.",
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

/** A later registry detection calls an enrolled project known, not newly joined. */
export function liveSelectionForRegistration(registration, runId = null) {
  const enrolled = registration?.registryStatus === "joined"
    || (registration?.registryStatus === "known" && registration.known === true);
  const projectRef = enrolled
    ? registration.projectRef
    : null;
  return {
    projectRef,
    runId: projectRef ? runId : null,
  };
}

export { parseArgs };

export function liveCurrentRunPresentation({ runId = null, nativeBinding = null, deepLink = null } = {}) {
  const currentRunState = runId ? "selected" : nativeBinding ? "awaiting_native_turn" : "not_requested";
  return { currentRunState, currentTaskLink: runId ? deepLink : null,
    autoOpenAllowed: currentRunState !== "awaiting_native_turn",
    ...(currentRunState === "awaiting_native_turn" ? { notice: "当前任务链接暂不可用（尚未确定本轮原生记录）；下方仅为项目入口。可用 --run-id 或 --observe-codex-turn 指定本轮。" } : {}) };
}

/** A thread's latest observed turn may be yesterday's work, not this launch. */
export async function resolveNativeCodexCurrentRun(nativeBinding) {
  if (!nativeBinding?.turnId) return null;
  const observed = await createCodexNativeSessionReader(nativeBinding).read().catch(() => null);
  return observed?.state === "observed" && observed.threadId === nativeBinding.threadId.toLowerCase()
    && observed.turnId === nativeBinding.turnId.toLowerCase()
    ? `native-codex-${observed.threadId}-${observed.turnId}` : null;
}

/** Existing host metadata can bind a new daemon; no arbitrary HTTP binding exists. */
export function nativeCodexStartupBinding(options, projectRoot, environment = process.env) {
  const threadId = options.nativeCodexThreadId || environment.CODEX_THREAD_ID;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(String(threadId || ""))) return null;
  if (!path.isAbsolute(projectRoot || "")) return null;
  return { projectRoot, threadId: threadId.toLowerCase(), ...(options.nativeCodexTurnId ? { turnId: options.nativeCodexTurnId } : {}), ...(environment.CODEX_HOME ? { codexHome: environment.CODEX_HOME } : {}) };
}

/** Explicit local session selection is distinct from runtime installation/support. */
export function nativeZcodeStartupBinding(options, projectRoot, environment = process.env) {
  if (!options.nativeZcodeSessionId || !options.nativeZcodeTurnId || !path.isAbsolute(projectRoot || "")) return null;
  return { projectRoot, sessionId: options.nativeZcodeSessionId, turnId: options.nativeZcodeTurnId,
    ...(environment.ZCODE_HOME ? { zcodeHome: environment.ZCODE_HOME } : {}) };
}

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
    const { projectRef } = liveSelectionForRegistration(registration, options.runId);
    let { runId } = liveSelectionForRegistration(registration, options.runId);
    const profile = options.profile || process.env.META_KIM_PROFILE || "default";
    const budget = loadLiveHubLifecycleBudget();
    if (options.restart === true) {
      const stopped = await stopLiveHub({
        homeDir: process.env.META_KIM_LIVE_HOME,
        // A person typing --restart is asking for whichever singleton is
        // recorded to be replaced, and no instance id is knowable at the command
        // line. Every other caller must name the Hub it intends to stop.
        allowAnyInstance: true,
        timeoutMs: budget.stopBudgetMs,
      });
      if (["signal_failed", "stop_timeout"].includes(stopped.status)) {
        const error = new Error(stopped.status);
        error.code = stopped.status;
        throw error;
      }
    }
    const zcodeBinding = projectRef ? nativeZcodeStartupBinding(options, projectRoot) : null;
    if (zcodeBinding) {
      const observed = await createZcodeNativeSessionReader(zcodeBinding).read();
      if (observed?.state !== "observed") {
        const error = new Error("zcode_turn_not_available");
        error.code = "zcode_turn_not_available";
        throw error;
      }
      const registered = await registerLiveNativeZcodeBinding({ homeDir: process.env.META_KIM_LIVE_HOME, repoPath: projectRoot, profile, ...zcodeBinding });
      if (!registered) {
        const error = new Error("zcode_binding_not_registered");
        error.code = "zcode_binding_not_registered";
        throw error;
      }
      runId ||= nativeZcodeRunId(zcodeBinding);
    }
    const nativeBinding = projectRef && !zcodeBinding ? nativeCodexStartupBinding(options, projectRoot) : null;
    if (nativeBinding) {
      await registerLiveNativeCodexBinding({ homeDir: process.env.META_KIM_LIVE_HOME, repoPath: projectRoot, profile, ...nativeBinding });
      if (!runId) {
        runId = await resolveNativeCodexCurrentRun(nativeBinding);
      }
    }
    const previousBinding = process.env.META_KIM_LIVE_NATIVE_CODEX_BINDING;
    if (nativeBinding) process.env.META_KIM_LIVE_NATIVE_CODEX_BINDING = JSON.stringify(nativeBinding);
    else delete process.env.META_KIM_LIVE_NATIVE_CODEX_BINDING;
    let result;
    try {
      result = await ensureLiveHub({
      packageRoot: PACKAGE_ROOT,
      homeDir: process.env.META_KIM_LIVE_HOME,
      projectRef,
      runId,
      port: options.port,
      profile,
      // Naming the profile on the command line is a person asking for that
      // scope. An inherited META_KIM_PROFILE is not: that is how a governed run
      // silently replaced the Hub someone was watching.
      allowProfileTakeover: typeof options.profile === "string",
      // A person running this command is the one asking for their own build to
      // serve the port. An autostart cannot make that claim: it is pinned to
      // whichever package root installed the hook.
      allowBuildTakeover: true,
      timeoutMs: budget.startupBudgetMs,
      });
    } finally {
      if (previousBinding === undefined) delete process.env.META_KIM_LIVE_NATIVE_CODEX_BINDING;
      else process.env.META_KIM_LIVE_NATIVE_CODEX_BINDING = previousBinding;
    }
    if (result.status === "unavailable") {
      if (result.reason === "profile_in_use") {
        process.stderr.write(
          `Live Hub is serving profile "${result.profile}". Run with --profile ${result.profile} to watch it, or --restart to replace it.\n`,
        );
      }
      const error = new Error(result.reason || "startup_unavailable");
      error.code = result.reason || "startup_unavailable";
      throw error;
    }
    const currentRun = liveCurrentRunPresentation({ runId, nativeBinding: nativeBinding || zcodeBinding, deepLink: result.deepLink });
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
      ...currentRun,
    };
    process.stdout.write(options.json
      ? `${JSON.stringify(publicResult)}\n`
      : `${currentRun.notice ? currentRun.notice + "\n" : ""}Meta_Kim Live Hub ${result.started ? "started" : "reused"} (${options.enableControl ? "control requested; fail-closed read-only" : "read-only"}): ${result.deepLink}\n`);
    if (options.open !== false && currentRun.autoOpenAllowed) openBrowser(result.deepLink);
    return null;
  }

  if (!/^[a-f0-9-]{16,64}$/u.test(process.env.META_KIM_LIVE_INSTANCE_ID || "")) {
    const error = new Error("daemon child requires a lifecycle-owned instance id");
    error.code = "daemon_authority_required";
    throw error;
  }

  let nativeCodex = null;
  try {
    const raw = process.env.META_KIM_LIVE_NATIVE_CODEX_BINDING || "";
    if (Buffer.byteLength(raw) <= 4_096) {
      const supplied = JSON.parse(raw);
      nativeCodex = nativeCodexStartupBinding({ nativeCodexThreadId: supplied.threadId, nativeCodexTurnId: supplied.turnId }, supplied.projectRoot, { CODEX_HOME: supplied.codexHome });
    }
  } catch { /* An absent or invalid binding leaves ordinary project reads unchanged. */ }
  const controller = createLiveControlRoomServer({
    ...options,
    globalHub: options.daemonChild === true,
    homeDir: process.env.META_KIM_LIVE_HOME,
    instanceId: process.env.META_KIM_LIVE_INSTANCE_ID || null,
    packageIdentity: process.env.META_KIM_LIVE_PACKAGE_IDENTITY || null,
    // The lifecycle hands the child both halves of its build authority. Passing
    // only the digest is what left /api/health unable to name the build it serves.
    packageVersion: process.env.META_KIM_LIVE_PACKAGE_VERSION || null,
    nativeCodex,
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
