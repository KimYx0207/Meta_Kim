#!/usr/bin/env node

/**
 * One local application entry for Meta_Kim. The native browser window is a
 * presentation shell around the existing Live workbench; it does not create a
 * second executor, project registry, token store, or product repository.
 */
import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createLiveControlRoomServer } from "../src/infrastructure/live/live-control-room-server.mjs";
import { resolveLiveProjectRoot } from "../src/infrastructure/live/live-read-repository.mjs";
import { createAgentStartService } from "../src/application/agent/agent-start-service.mjs";

export function parseAgentArgs(args) {
  const parsed = { open: true, port: 0, json: false, help: false, projectRoot: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--no-open") parsed.open = false;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--port" || arg === "--project-root") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--port") {
        if (!/^\d{1,5}$/u.test(value) || Number(value) > 65535) throw new Error("--port must be between 0 and 65535");
        parsed.port = Number(value);
      } else {
        if (!path.isAbsolute(value)) throw new Error("--project-root must be an absolute path");
        parsed.projectRoot = value;
      }
    } else throw new Error(`Unknown Agent option: ${arg}`);
  }
  return parsed;
}

function usage() {
  return [
    "Meta_Kim Agent · local workspace",
    "Usage: meta-kim agent [--project-root ABSOLUTE_DIR] [--port 0..65535] [--no-open] [--json]",
    "Open the existing Meta Live workspace in a native browser window, with explicit task submission enabled.",
    "Your project directory needs a .git or .meta-kim marker. Native clients run only when you choose one and submit a task.",
    "The regular 'meta-kim live' command remains read-only. No existing Agent CLI credentials are imported by this launcher.",
  ].join("\n");
}

async function executable(program) {
  try { await access(program, constants.X_OK); return true; } catch { return false; }
}

async function resolveFromPath(name, environment) {
  const extensions = process.platform === "win32" ? [".exe", ".cmd"] : [""];
  for (const directory of String(environment.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      if (await executable(candidate)) return candidate;
    }
  }
  return null;
}

/** Prefer actual app windows when installed; opening a tab is a safe fallback. */
export async function resolveAgentBrowser(environment = process.env) {
  const names = process.platform === "darwin"
    ? ["google-chrome", "chromium", "microsoft-edge"]
    : ["msedge", "chrome", "chromium", "google-chrome", "google-chrome-stable", "microsoft-edge"];
  for (const name of names) {
    const located = await resolveFromPath(name, environment);
    if (located) return { program: located, args: (url) => [`--app=${url}`, "--no-first-run"] };
  }
  if (process.platform === "win32") {
    const bases = [environment["PROGRAMFILES(X86)"], environment.ProgramFiles, environment.LOCALAPPDATA].filter(Boolean);
    for (const base of bases) {
      for (const relative of ["Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe"]) {
        const candidate = path.join(base, relative);
        if (await executable(candidate)) return { program: candidate, args: (url) => [`--app=${url}`, "--no-first-run"] };
      }
    }
  }
  if (process.platform === "darwin" && existsSync("/Applications/Google Chrome.app")) {
    return { program: "/usr/bin/open", args: (url) => ["-a", "Google Chrome", "--args", `--app=${url}`] };
  }
  if (process.platform !== "win32") {
    const fallback = await resolveFromPath(process.platform === "darwin" ? "open" : "xdg-open", environment);
    if (fallback) return { program: fallback, args: (url) => [url] };
  }
  return null;
}

async function openAgentWindow(url) {
  const browser = await resolveAgentBrowser();
  if (!browser) return false;
  return new Promise((resolve) => {
    const child = spawn(browser.program, browser.args(url), { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve(false));
    child.once("spawn", () => { child.unref(); resolve(true); });
  });
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const options = parseAgentArgs(args);
  if (options.help) { process.stdout.write(`${usage()}\n`); return null; }
  const callerCwd = typeof environment.META_KIM_CALLER_CWD === "string" && path.isAbsolute(environment.META_KIM_CALLER_CWD)
    ? environment.META_KIM_CALLER_CWD : process.cwd();
  const projectRoot = await resolveLiveProjectRoot({ cwd: callerCwd, projectRoot: options.projectRoot, env: environment });
  if (!projectRoot) throw new Error("Project folder is not initialized. Open a project containing .git or .meta-kim, or pass --project-root with that folder's absolute path.");

  const agentStartService = createAgentStartService({ projectRoot, enabled: true, environment });
  const controller = createLiveControlRoomServer({
    projectRoot, port: options.port, globalHub: false, workspaceEnabled: true,
    // This opt-in path is separate from the global read-only Live Hub.
    enableControl: false, enableAgentStart: true, agentStartService,
  });
  const address = await controller.start();
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await controller.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stop(); });
  const opened = options.open ? await openAgentWindow(address.url) : false;
  if (options.json) process.stdout.write(`${JSON.stringify({ status: "listening", url: address.url, windowOpened: opened, engine: "meta-kim-live" })}\n`);
  else process.stdout.write(`Meta_Kim Agent is ready at ${address.url}${opened ? " (app window opened)" : ""}\nPress Ctrl+C to stop.\n`);
  return controller;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`meta-kim agent: ${error.message}\n`);
    process.exitCode = 1;
  });
}
