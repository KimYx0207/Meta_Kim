import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import {
  parseGraphifyHookCommand,
  rewriteHookToDirectSpawn,
} from "./doctor-hooks.mjs";
import { renameWithTransientRetry } from "./transient-rename.mjs";

function isoStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Repair graphify hook commands that graphify's upstream installer wrote as
 * Windows shell-form (`C:\\...\\graphify.EXE hook-guard read`). Claude Code
 * runs shell-form hooks through Git Bash, which consumes those backslashes as
 * escapes and collapses the path to something like `C:UsersKim...`. Rewriting
 * each match into the direct-spawn `command` + `args` form lets Claude Code
 * spawn the executable without a shell boundary, so the path is preserved.
 *
 * No-op outside win32. Backs up the original file before any write. Idempotent.
 *
 * @param {string} settingsPath Absolute path to a settings.json file.
 * @param {{
 *   platform?: string,
 *   exists?: typeof existsSync,
 *   readFile?: typeof readFileSync,
 *   writeFile?: typeof writeFileSync,
 *   renameFile?: typeof renameSync,
 *   removeFile?: typeof unlinkSync,
 *   now?: Date,
 *   graphifyExecutable?: string | null,
 * }} [options]
 * @returns {{ changed: boolean, count: number, path: string | null, backup?: string }}
 */
export function sanitizeGraphifyWindowsHooks(settingsPath, options = {}) {
  const runtimePlatform = options.platform ?? process.platform;
  const fileExists = options.exists ?? existsSync;
  const readFile = options.readFile ?? readFileSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const renameFile = options.renameFile ?? renameSync;
  const removeFile = options.removeFile ?? unlinkSync;
  const base = { changed: false, count: 0, path: settingsPath ?? null };
  if (runtimePlatform !== "win32") return base;
  if (!settingsPath || !fileExists(settingsPath)) return base;

  let raw;
  try {
    raw = readFile(settingsPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read Graphify hook settings at ${settingsPath}: ${error.message}`, {
      cause: error,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Unable to parse Graphify hook settings at ${settingsPath}: ${error.message}`, {
      cause: error,
    });
  }

  let count = 0;
  const nextHooks = {};
  for (const [event, blocks] of Object.entries(parsed.hooks || {})) {
    nextHooks[event] = (blocks || []).map((block) => ({
      ...block,
      hooks: (block.hooks || []).map((hook) => {
        const parsed = parseGraphifyHookCommand(hook);
        if (
          !options.graphifyExecutable &&
          parsed?.form === "shell" &&
          !fileExists(parsed.executable)
        ) {
          return hook;
        }
        const rewritten = rewriteHookToDirectSpawn(
          hook,
          runtimePlatform,
          options.graphifyExecutable ?? null,
        );
        if (rewritten) {
          count += 1;
          return rewritten;
        }
        return hook;
      }),
    }));
  }

  if (count === 0) return base;

  const stamp = isoStamp(options.now);
  const backup = `${settingsPath}.backup-${stamp}-graphify`;
  const temporary = `${settingsPath}.tmp-${stamp}-${process.pid}`;
  try {
    writeFile(backup, raw, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    throw new Error(`Graphify hook repair stopped because backup creation failed at ${backup}: ${error.message}`, {
      cause: error,
    });
  }
  const next = { ...parsed, hooks: nextHooks };
  try {
    writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameWithTransientRetry(temporary, settingsPath, {
      rename: renameFile,
      platform: runtimePlatform,
    });
  } catch (error) {
    try {
      if (fileExists(temporary)) removeFile(temporary);
    } catch {
      // Preserve the original failure; the exact backup remains available.
    }
    throw new Error(`Graphify hook repair failed for ${settingsPath}; the original backup is ${backup}: ${error.message}`, {
      cause: error,
    });
  }
  return { changed: true, count, path: settingsPath, backup };
}

/** Reconcile only settings files that already contain recognized Graphify hooks. */
export function reconcileExistingGraphifyWindowsHooks(
  settingsPaths,
  graphifyExecutable,
  options = {},
) {
  return [...new Set(settingsPaths || [])].map((settingsPath) =>
    sanitizeGraphifyWindowsHooks(settingsPath, {
      ...options,
      graphifyExecutable,
    })
  );
}
