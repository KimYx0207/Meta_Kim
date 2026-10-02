#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CI_LANES, SMOKE_STAGES, SMOKE_PREPARATION_STAGES } from "./verification-stage-manifest.mjs";

export function buildIsolatedTestEnvironment(home, source = process.env) {
  // Allow-list OS process plumbing only. In particular no API tokens, runtime
  // config locations, npm/Git credentials, NODE_OPTIONS, or provider overrides.
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "LANG", "LC_ALL", "TERM"]);
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toUpperCase())));
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "appdata"),
    LOCALAPPDATA: path.join(home, "localappdata"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    TMPDIR: path.join(home, "tmp"),
    TMP: path.join(home, "tmp"),
    TEMP: path.join(home, "tmp"),
    npm_config_cache: path.join(home, "npm-cache"),
    npm_config_userconfig: path.join(home, ".npmrc"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    CI: "true",
    META_KIM_DISABLE_SIBLING_DEP_PROBE: "1",
  });
  return env;
}

export function localVerificationStages(suite = "smoke") {
  if (suite === "smoke") return SMOKE_STAGES;
  if (!Object.hasOwn(CI_LANES, suite)) throw new Error(`Unknown verification suite: ${suite}`);
  const { supportedTargets } = JSON.parse(readFileSync(new URL("../config/sync.json", import.meta.url), "utf8"));
  return [
    ...SMOKE_PREPARATION_STAGES.map((stage) => stage.name === "meta:sync"
      ? { ...stage, cmd: `${stage.cmd} -- --targets ${supportedTargets.join(",")}` }
      : stage),
    ...CI_LANES[suite],
  ];
}

export function runLocalVerification({ suite = "smoke", isolated = false, cwd = process.cwd() } = {}) {
  const stages = localVerificationStages(suite);
  const home = isolated ? mkdtempSync(path.join(os.tmpdir(), "meta-kim-ci-home-")) : null;
  try {
    const env = home ? buildIsolatedTestEnvironment(home) : {
      ...process.env,
      META_KIM_DISABLE_SIBLING_DEP_PROBE: process.env.META_KIM_DISABLE_SIBLING_DEP_PROBE ?? "1",
    };
    if (home) {
      for (const name of ["tmp", "appdata", "localappdata", "config", "cache", "data", "state", "npm-cache"]) {
        mkdirSync(path.join(home, name), { recursive: true });
      }
    }
    for (const stage of stages) {
      console.log(`\n=== ${suite}: ${stage.name} ===`);
      // Commands come only from the shared manifest, never user input.
      const command = process.platform === "win32" ? (env.ComSpec || env.COMSPEC || "cmd.exe") : "npm";
      const args = process.platform === "win32"
        ? ["/d", "/s", "/c", stage.cmd]
        : stage.cmd.split(/\s+/u).slice(1);
      const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell: false });
      if (result.error || result.signal || result.status !== 0) {
        console.error(`Verification failed at ${stage.name}: ${result.error?.message || result.signal || `exit ${result.status}`}`);
        return result.status || 1;
      }
    }
    return 0;
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let suite = "smoke";
  let isolated = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--suite" && args[i + 1]) suite = args[++i];
    else if (args[i] === "--isolated") isolated = true;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  process.exitCode = runLocalVerification({ suite, isolated });
}
