import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reconcileExistingGraphifyWindowsHooks,
  sanitizeGraphifyWindowsHooks,
} from "../../scripts/graphify-hook-sanitize.mjs";

const GRAPHIFY_EXE = String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE`;
const BACKSLASH_HOOK = {
  type: "command",
  command: `${GRAPHIFY_EXE} hook-guard read`,
};

function writeHookSettings(dir, settings) {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const settingsPath = join(dir, ".claude", "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  return settingsPath;
}

describe("sanitizeGraphifyWindowsHooks()", () => {
  test("global-only reconciliation relocates an existing user hook without creating missing settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-global-reconcile-"));
    const missingProjectSettings = join(dir, "project", ".claude", "settings.json");
    const noHookSettings = writeHookSettings(join(dir, "no-hook"), {
      permissions: { allow: ["Read"] },
    });
    const userSettings = writeHookSettings(join(dir, "user"), {
      hooks: { PreToolUse: [{ matcher: "Read", hooks: [BACKSLASH_HOOK] }] },
    });
    const current = String.raw`C:\Python313\Scripts\graphify.EXE`;

    const results = reconcileExistingGraphifyWindowsHooks(
      [missingProjectSettings, noHookSettings, userSettings],
      current,
      { platform: "win32" },
    );

    assert.equal(results.length, 3);
    assert.equal(results[0].changed, false);
    assert.equal(results[1].changed, false);
    assert.equal(results[2].changed, true);
    assert.equal(existsSync(missingProjectSettings), false);
    assert.equal(
      Object.hasOwn(JSON.parse(readFileSync(noHookSettings, "utf8")), "hooks"),
      false,
    );
    const userHook = JSON.parse(readFileSync(userSettings, "utf8"))
      .hooks.PreToolUse[0].hooks[0];
    assert.equal(userHook.command, current);
    assert.deepEqual(userHook.args, ["hook-guard", "read"]);
  });

  test("rewrites graphify Windows shell-form hook to direct-spawn command + args", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const settingsPath = writeHookSettings(dir, {
      hooks: { PreToolUse: [{ matcher: "Read|Glob", hooks: [BACKSLASH_HOOK] }] },
    });

    const result = sanitizeGraphifyWindowsHooks(settingsPath, {
      platform: "win32",
      graphifyExecutable: GRAPHIFY_EXE,
    });
    assert.equal(result.changed, true);
    assert.equal(result.count, 1);

    const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    const hook = saved.hooks.PreToolUse[0].hooks[0];
    assert.equal(hook.command, String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE`);
    assert.deepEqual(hook.args, ["hook-guard", "read"]);
  });

  test("recognizes forward-slash, quoted, strict-read, and already-exec forms and relocates them", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const current = String.raw`C:\Users\Kim\AppData\Local\Programs\Python\Python313\Scripts\graphify.EXE`;
    const settingsPath = writeHookSettings(dir, {
      hooks: { PreToolUse: [{ matcher: "Read|Glob", hooks: [
        { type: "command", command: "C:/Users/Kim/AppData/Local/Programs/Python/Python311/Scripts/graphify.EXE hook-guard search" },
        { type: "command", command: String.raw`"C:\Program Files\Python311\Scripts\graphify.EXE" hook-guard read --strict`, timeout: 25 },
        { type: "command", command: String.raw`C:\Old\Scripts\graphify.EXE`, args: ["hook-guard", "read"] },
      ] }] },
    });

    const result = sanitizeGraphifyWindowsHooks(settingsPath, {
      platform: "win32",
      graphifyExecutable: current,
    });
    assert.equal(result.count, 3);
    const hooks = JSON.parse(readFileSync(settingsPath, "utf8")).hooks.PreToolUse[0].hooks;
    assert.deepEqual(hooks.map(({ command, args }) => ({ command, args })), [
      { command: current, args: ["hook-guard", "search"] },
      { command: current, args: ["hook-guard", "read", "--strict"] },
      { command: current, args: ["hook-guard", "read"] },
    ]);
    assert.equal(hooks[1].timeout, 25);
    const second = sanitizeGraphifyWindowsHooks(settingsPath, {
      platform: "win32",
      graphifyExecutable: current,
    });
    assert.equal(second.changed, false);
    assert.equal(second.count, 0);
  });

  test("preserves unknown and bare Graphify commands during relocation", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const hooks = [
      { type: "command", command: "graphify hook-guard read" },
      { type: "command", command: String.raw`C:\Old\Scripts\graphify.EXE update .` },
      { type: "command", command: String.raw`C:\Old\Scripts\other.EXE hook-guard read` },
    ];
    const settingsPath = writeHookSettings(dir, {
      hooks: { PreToolUse: [{ matcher: "Read", hooks }] },
    });
    const result = sanitizeGraphifyWindowsHooks(settingsPath, {
      platform: "win32",
      graphifyExecutable: String.raw`C:\Current\Scripts\graphify.EXE`,
    });
    assert.equal(result.changed, false);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).hooks.PreToolUse[0].hooks, hooks);
  });

  test("is a no-op on non-win32 platforms", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const settingsPath = writeHookSettings(dir, {
      hooks: { PreToolUse: [{ matcher: "Read|Glob", hooks: [BACKSLASH_HOOK] }] },
    });

    const result = sanitizeGraphifyWindowsHooks(settingsPath, { platform: "linux" });
    assert.equal(result.changed, false);
    assert.equal(result.count, 0);
  });

  test("is idempotent (second run is a no-op)", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const settingsPath = writeHookSettings(dir, {
      hooks: { PreToolUse: [{ matcher: "Read|Glob", hooks: [BACKSLASH_HOOK] }] },
    });

    sanitizeGraphifyWindowsHooks(settingsPath, {
      platform: "win32",
      graphifyExecutable: GRAPHIFY_EXE,
    });
    const second = sanitizeGraphifyWindowsHooks(settingsPath, {
      platform: "win32",
      graphifyExecutable: GRAPHIFY_EXE,
    });
    assert.equal(second.changed, false);
    assert.equal(second.count, 0);
  });

  test("writes a backup file alongside the repaired settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const settingsPath = writeHookSettings(dir, {
      hooks: { PreToolUse: [{ matcher: "Read|Glob", hooks: [BACKSLASH_HOOK] }] },
    });

    const original = readFileSync(settingsPath, "utf8");
    const result = sanitizeGraphifyWindowsHooks(settingsPath, {
      platform: "win32",
      graphifyExecutable: GRAPHIFY_EXE,
      now: new Date("2026-07-21T00:00:00.123Z"),
    });
    assert.equal(typeof result.backup, "string");
    assert.ok(result.backup.includes(".backup-"));

    const backups = readdirSync(join(dir, ".claude")).filter((name) =>
      name.startsWith("settings.json.backup-"),
    );
    assert.deepEqual(backups, ["settings.json.backup-2026-07-21T00-00-00-123Z-graphify"]);
    assert.equal(readFileSync(result.backup, "utf8"), original);
  });

  test("fails closed when the required backup cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const settingsPath = writeHookSettings(dir, {
      hooks: { PreToolUse: [{ matcher: "Read|Glob", hooks: [BACKSLASH_HOOK] }] },
    });
    const original = readFileSync(settingsPath, "utf8");

    assert.throws(
      () => sanitizeGraphifyWindowsHooks(settingsPath, {
        platform: "win32",
        graphifyExecutable: GRAPHIFY_EXE,
        writeFile(filePath, ...args) {
          if (String(filePath).includes(".backup-")) {
            throw new Error("simulated backup failure");
          }
          return writeFileSync(filePath, ...args);
        },
      }),
      /backup creation failed/,
    );
    assert.equal(readFileSync(settingsPath, "utf8"), original);
  });

  test("keeps the original settings when the atomic replacement fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const settingsPath = writeHookSettings(dir, {
      hooks: { PreToolUse: [{ matcher: "Read|Glob", hooks: [BACKSLASH_HOOK] }] },
    });
    const original = readFileSync(settingsPath, "utf8");

    assert.throws(
      () => sanitizeGraphifyWindowsHooks(settingsPath, {
        platform: "win32",
        graphifyExecutable: GRAPHIFY_EXE,
        renameFile() {
          throw new Error("simulated replace failure");
        },
      }),
      /original backup is/,
    );
    assert.equal(readFileSync(settingsPath, "utf8"), original);
  });

  test("retries the atomic replacement through a transient Windows lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const settingsPath = writeHookSettings(dir, {
      hooks: { PreToolUse: [{ matcher: "Read|Glob", hooks: [BACKSLASH_HOOK] }] },
    });

    let attempts = 0;
    const result = sanitizeGraphifyWindowsHooks(settingsPath, {
      platform: "win32",
      graphifyExecutable: GRAPHIFY_EXE,
      renameFile(source, target) {
        attempts += 1;
        if (attempts === 1) {
          const locked = new Error("simulated Defender lock");
          locked.code = "EPERM";
          throw locked;
        }
        return renameSync(source, target);
      },
    });

    assert.equal(attempts, 2, "a transient lock must be retried, not surfaced");
    assert.equal(result.changed, true);
    assert.equal(result.count, 1);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    const hook = written.hooks.PreToolUse[0].hooks[0];
    assert.equal(hook.command, GRAPHIFY_EXE);
    assert.deepEqual(hook.args, ["hook-guard", "read"]);
    assert.equal(existsSync(result.backup), true);
  });

  test("still fails closed when the Windows lock never clears", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const settingsPath = writeHookSettings(dir, {
      hooks: { PreToolUse: [{ matcher: "Read|Glob", hooks: [BACKSLASH_HOOK] }] },
    });
    const original = readFileSync(settingsPath, "utf8");

    let attempts = 0;
    assert.throws(
      () => sanitizeGraphifyWindowsHooks(settingsPath, {
        platform: "win32",
        graphifyExecutable: GRAPHIFY_EXE,
        renameFile() {
          attempts += 1;
          const locked = new Error("simulated permanent lock");
          locked.code = "EBUSY";
          throw locked;
        },
      }),
      /original backup is/,
    );
    assert.ok(attempts > 1, "a lock code must be retried at least once");
    assert.ok(attempts <= 8, "the retry must stay bounded, not spin");
    assert.equal(readFileSync(settingsPath, "utf8"), original);
  });

  test("leaves non-graphify shell-form hooks untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const settingsPath = writeHookSettings(dir, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Read|Glob",
            hooks: [
              { type: "command", command: String.raw`C:\Users\Kim\bin\other-tool.EXE run` },
            ],
          },
        ],
      },
    });

    const result = sanitizeGraphifyWindowsHooks(settingsPath, {
      platform: "win32",
      graphifyExecutable: GRAPHIFY_EXE,
    });
    assert.equal(result.changed, false);
    assert.equal(result.count, 0);
  });

  test("returns unchanged when settings file is missing", () => {
    const result = sanitizeGraphifyWindowsHooks(
      join(tmpdir(), "missing-graphify-dir", ".claude", "settings.json"),
      { platform: "win32" },
    );
    assert.equal(result.changed, false);
    assert.equal(result.count, 0);
  });

  test("preserves permissions and sibling hooks while rewriting", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const settingsPath = writeHookSettings(dir, {
      permissions: { deny: ["Read(./.env)"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Read|Glob",
            hooks: [
              BACKSLASH_HOOK,
              { type: "command", command: "node .claude/hooks/graphify-context.mjs" },
            ],
          },
        ],
      },
    });

    const result = sanitizeGraphifyWindowsHooks(settingsPath, {
      platform: "win32",
      graphifyExecutable: GRAPHIFY_EXE,
    });
    assert.equal(result.count, 1);

    const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(saved.permissions.deny, ["Read(./.env)"]);
    const hooks = saved.hooks.PreToolUse[0].hooks;
    assert.equal(hooks[0].command, String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE`);
    assert.deepEqual(hooks[0].args, ["hook-guard", "read"]);
    assert.equal(hooks[1].command, "node .claude/hooks/graphify-context.mjs");
    assert.equal(Object.hasOwn(hooks[1], "args"), false);
  });

  test("preserves command metadata on the rewritten Graphify hook", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphify-sanitize-"));
    const settingsPath = writeHookSettings(dir, {
      hooks: {
        PreToolUse: [{
          matcher: "Read",
          hooks: [{ ...BACKSLASH_HOOK, timeout: 25, statusMessage: "Graph lookup" }],
        }],
      },
    });

    sanitizeGraphifyWindowsHooks(settingsPath, {
      platform: "win32",
      graphifyExecutable: GRAPHIFY_EXE,
    });
    const hook = JSON.parse(readFileSync(settingsPath, "utf8"))
      .hooks.PreToolUse[0].hooks[0];
    assert.equal(hook.timeout, 25);
    assert.equal(hook.statusMessage, "Graph lookup");
  });
});
