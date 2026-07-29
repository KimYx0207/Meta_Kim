import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectHookCommandIncompatibility,
  detectHookRuntimeIncompatibility,
  extractCommandPath,
  extractHookTargetPath,
  findProjectSettings,
  projectRootFromArgs,
  parseGraphifyHookCommand,
  removeZombies,
  rewriteHookToDirectSpawn,
  resolveHookTargetPath,
  scanSettingsFile,
} from "../../scripts/doctor-hooks.mjs";

describe("rewriteHookToDirectSpawn()", () => {
  test("precisely parses supported Graphify hook-guard forms", () => {
    const exact = "C:/Users/Kim/AppData/Local/Programs/Python/Python311/Scripts/graphify.EXE";
    assert.deepEqual(parseGraphifyHookCommand({ command: `${exact} hook-guard search` }), {
      executable: exact, action: "search", strict: false, form: "shell",
    });
    assert.deepEqual(parseGraphifyHookCommand({
      command: String.raw`C:\Program Files\Python311\Scripts\graphify.EXE`,
      args: ["hook-guard", "read", "--strict"],
    }), {
      executable: String.raw`C:\Program Files\Python311\Scripts\graphify.EXE`,
      action: "read", strict: true, form: "exec",
    });
    for (const hook of [
      { command: "graphify hook-guard read" },
      { command: `${exact} hook-guard search --strict` },
      { command: `${exact} update .` },
      { command: `${exact}`, args: ["hook-guard", "payload"] },
    ]) assert.equal(parseGraphifyHookCommand(hook), null);
  });
  test("rewrites a graphify Windows shell-form hook into command + args", () => {
    const hook = {
      type: "command",
      timeout: 17,
      statusMessage: "Indexing context",
      command: String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE hook-guard read`,
    };
    const next = rewriteHookToDirectSpawn(hook, "win32");
    assert.deepEqual(next, {
      type: "command",
      timeout: 17,
      statusMessage: "Indexing context",
      command: String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE`,
      args: ["hook-guard", "read"],
    });
  });

  test("keeps a Graphify executable path containing spaces intact", () => {
    const hook = {
      type: "command",
      command: String.raw`C:\Users\Kim Name\Python\Scripts\graphify.EXE hook-guard read`,
    };
    const next = rewriteHookToDirectSpawn(hook, "win32");
    assert.equal(
      next.command,
      String.raw`C:\Users\Kim Name\Python\Scripts\graphify.EXE`,
    );
    assert.deepEqual(next.args, ["hook-guard", "read"]);
  });

  test("rewrites a UNC graphify path into command + args", () => {
    const hook = {
      type: "command",
      command: String.raw`\\server\share\graphify.EXE hook-guard search`,
    };
    const next = rewriteHookToDirectSpawn(hook, "win32");
    assert.equal(next.command, String.raw`\\server\share\graphify.EXE`);
    assert.deepEqual(next.args, ["hook-guard", "search"]);
  });

  test("normalizes recognized shell forms and leaves bare/exec forms untouched", () => {
    const shellForms = [
      "C:/Users/Kim/Python/Scripts/graphify.EXE hook-guard read",
      String.raw`"C:\Users\Kim\Python\Scripts\graphify.EXE" hook-guard read`,
    ];
    for (const command of shellForms) {
      assert.deepEqual(
        rewriteHookToDirectSpawn({ type: "command", command }, "win32")?.args,
        ["hook-guard", "read"],
      );
    }
    assert.equal(rewriteHookToDirectSpawn({ type: "command", command: "graphify hook-guard read" }, "win32"), null);
    assert.equal(
      rewriteHookToDirectSpawn(
        {
          type: "command",
          command: String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE`,
          args: ["hook-guard", "read"],
        },
        "win32",
      ),
      null,
    );
  });

  test("leaves non-graphify shell-form hooks untouched", () => {
    const hook = {
      type: "command",
      command: String.raw`C:\Users\Kim\bin\other-tool.EXE run`,
    };
    assert.equal(rewriteHookToDirectSpawn(hook, "win32"), null);
  });

  test("leaves Graphify commands outside the known hook-guard contract untouched", () => {
    const hook = {
      type: "command",
      command: String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE update .`,
    };
    assert.equal(rewriteHookToDirectSpawn(hook, "win32"), null);
  });

  test("is a no-op outside win32", () => {
    const hook = {
      type: "command",
      command: String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE hook-guard read`,
    };
    assert.equal(rewriteHookToDirectSpawn(hook, "linux"), null);
    assert.equal(rewriteHookToDirectSpawn(hook, "darwin"), null);
  });
});

function withTempProject(run) {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-hook-doctor-"));
  try {
    mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeSettings(root, command) {
  const settingsPath = path.join(root, ".claude", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      PostToolUse: [{
        matcher: "Write|Edit",
        hooks: [{ type: "command", command }],
      }],
    },
  }, null, 2));
  return settingsPath;
}

function writeHookSettings(root, hooks) {
  const settingsPath = path.join(root, ".claude", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      PostToolUse: [{
        matcher: "Write|Edit",
        hooks,
      }],
    },
  }, null, 2));
  return settingsPath;
}

describe("doctor-hooks extractCommandPath", () => {
  test("should detect direct script command correctly", () => {
    assert.strictEqual(
      extractCommandPath("./hook.sh"),
      "./hook.sh"
    );
    assert.strictEqual(
      extractCommandPath(".claude/hooks/foo.mjs"),
      ".claude/hooks/foo.mjs"
    );
    assert.strictEqual(
      extractCommandPath(".claude/hooks/foo.js"),
      ".claude/hooks/foo.js"
    );
  });

  test("should skip known runner and return correct script target", () => {
    assert.strictEqual(
      extractCommandPath("node .claude/hooks/foo.mjs"),
      ".claude/hooks/foo.mjs"
    );
    assert.strictEqual(
      extractCommandPath("python3 C:/repo/hooks/memory.py"),
      "C:/repo/hooks/memory.py"
    );
    assert.strictEqual(
      extractCommandPath("python C:/repo/hooks/memory.py"),
      "C:/repo/hooks/memory.py"
    );
    assert.strictEqual(
      extractCommandPath("bash ./hook.sh"),
      "./hook.sh"
    );
  });

  test("should skip runner with absolute or windows executable paths", () => {
    assert.strictEqual(
      extractCommandPath("C:/node/node.exe C:/repo/.claude/hooks/x.mjs"),
      "C:/repo/.claude/hooks/x.mjs"
    );
    assert.strictEqual(
      extractCommandPath("C:\\Python312\\python.exe C:\\repo\\.claude\\hooks\\memory.py"),
      "C:\\repo\\.claude\\hooks\\memory.py"
    );
    assert.strictEqual(
      extractCommandPath("/usr/bin/python3 /usr/local/bin/hook.py"),
      "/usr/local/bin/hook.py"
    );
  });

  test("should handle quoted paths and spaces correctly", () => {
    assert.strictEqual(
      extractCommandPath('"C:\\Program Files\\nodejs\\node.exe" .claude/hooks/foo.mjs'),
      ".claude/hooks/foo.mjs"
    );
    assert.strictEqual(
      extractCommandPath('node "C:/My Folder/hooks/foo.js"'),
      "C:/My Folder/hooks/foo.js"
    );
  });

  test("should handle recursive shell command payloads", () => {
    assert.strictEqual(
      extractCommandPath('sh -c "node .claude/hooks/foo.mjs"'),
      ".claude/hooks/foo.mjs"
    );
    assert.strictEqual(
      extractCommandPath('bash -c "./hook.sh"'),
      "./hook.sh"
    );
    assert.strictEqual(
      extractCommandPath('pwsh -Command .claude/hooks/foo.ps1'),
      ".claude/hooks/foo.ps1"
    );
    assert.strictEqual(
      extractCommandPath('bash -lc "node .claude/hooks/foo.mjs"'),
      ".claude/hooks/foo.mjs"
    );
    assert.strictEqual(
      extractCommandPath('bash -lc "cd C:/repo && node .claude/hooks/foo.mjs"'),
      ".claude/hooks/foo.mjs"
    );
    assert.strictEqual(
      extractCommandPath('sh -c "cd C:/repo && node .claude/hooks/foo.mjs"'),
      ".claude/hooks/foo.mjs"
    );
    assert.strictEqual(
      extractCommandPath('sh -c "cd C:/repo; node .claude/hooks/foo.mjs"'),
      ".claude/hooks/foo.mjs"
    );
    assert.strictEqual(
      extractCommandPath("C:/repo"),
      null
    );
  });

  test("should handle node loader, import and experimental options", () => {
    assert.strictEqual(
      extractCommandPath('node --experimental-loader ts-node/esm .claude/hooks/foo.ts'),
      ".claude/hooks/foo.ts"
    );
    assert.strictEqual(
      extractCommandPath('node --import ./.claude/hooks/setup.mjs .claude/hooks/foo.mjs'),
      ".claude/hooks/foo.mjs"
    );
  });

  test("should return null for unrecognized/non-script commands (regression/false-positives check)", () => {
    assert.strictEqual(
      extractCommandPath("echo hello"),
      null
    );
    assert.strictEqual(
      extractCommandPath("cmd /c .claude/hooks/foo.mjs"),
      ".claude/hooks/foo.mjs"
    );
    assert.strictEqual(
      extractCommandPath("cmd.exe /c C:/repo/.claude/hooks/foo.mjs"),
      "C:/repo/.claude/hooks/foo.mjs"
    );
    assert.strictEqual(
      extractCommandPath("npx tsx .claude/hooks/foo.ts"),
      ".claude/hooks/foo.ts"
    );
    assert.strictEqual(
      extractCommandPath("node -r ts-node/register .claude/hooks/foo.ts"),
      ".claude/hooks/foo.ts"
    );
    assert.strictEqual(
      extractCommandPath("python -m pip install"),
      null
    );
    assert.strictEqual(
      extractCommandPath("python -m my_module.hook"),
      null
    );
  });

  test("should fallback to null appropriately", () => {
    assert.strictEqual(
      extractCommandPath(""),
      null
    );
    assert.strictEqual(
      extractCommandPath("node"),
      null
    );
  });
});

describe("doctor-hooks project-aware runtime diagnostics", () => {
  test("detects only unquoted Windows backslash paths in shell-form hooks", () => {
    const broken = {
      type: "command",
      command: String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE hook-guard read`,
    };
    const issue = detectHookCommandIncompatibility(broken, "win32");
    assert.equal(issue?.code, "windows_shell_backslash_path");
    assert.equal(issue?.path, String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE`);

    const uncIssue = detectHookCommandIncompatibility({
      type: "command",
      command: String.raw`\\server\share\graphify.EXE hook-guard read`,
    }, "win32");
    assert.equal(uncIssue?.code, "windows_shell_backslash_path");
    assert.equal(uncIssue?.path, String.raw`\\server\share\graphify.EXE`);

    for (const safe of [
      {
        type: "command",
        command: "C:/Users/Kim/Python/Scripts/graphify.EXE hook-guard read",
      },
      {
        type: "command",
        command: String.raw`"C:\Users\Kim\Python\Scripts\graphify.EXE" hook-guard read`,
      },
      {
        type: "command",
        command: String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE`,
        args: ["hook-guard", "read"],
      },
      {
        type: "command",
        command: String.raw`echo C:\Users\Kim\payload.txt`,
      },
    ]) {
      assert.equal(detectHookCommandIncompatibility(safe, "win32"), null);
    }
    assert.equal(detectHookCommandIncompatibility(broken, "linux"), null);
  });

  test("diagnoses a stale Graphify executable without making it auto-deletable", {
    skip: process.platform !== "win32",
  }, () => {
    withTempProject((root) => {
      const hook = {
        type: "command",
        command: String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE hook-guard read`,
      };
      const settingsPath = writeHookSettings(root, [hook]);
      const result = scanSettingsFile(settingsPath);

      assert.equal(result.zombies.length, 0);
      assert.equal(result.live.length, 0);
      assert.equal(result.unverified.length, 0);
      assert.equal(result.incompatible.length, 1);
      assert.equal(
        result.incompatible[0].path,
        String.raw`C:\Users\Kim\Python\Scripts\graphify.EXE`,
      );
      assert.equal(result.incompatible[0].code, "missing_graphify_executable");

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const cleaned = removeZombies(settings, settingsPath);
      assert.equal(cleaned.removed, 0);
      assert.deepEqual(cleaned.settings, settings);
    });
  });

  test("doctor --fix preserves a stale recognized Graphify exec hook", {
    skip: process.platform !== "win32",
  }, () => {
    withTempProject((root) => {
      const hook = {
        type: "command",
        command: String.raw`C:\Missing\Python311\Scripts\graphify.EXE`,
        args: ["hook-guard", "search"],
      };
      const settingsPath = writeHookSettings(root, [hook]);
      const before = JSON.parse(readFileSync(settingsPath, "utf8"));
      const result = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "..", "..", "scripts", "doctor-hooks.mjs"),
          "--project",
          "--project-root",
          root,
          "--fix",
          "--silent",
        ],
        { encoding: "utf8" },
      );

      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), before);
    });
  });

  test("doctor --fix leaves the stale forward-slash Graphify shell command byte-identical", {
    skip: process.platform !== "win32",
  }, () => {
    withTempProject((root) => {
      const settingsPath = writeHookSettings(root, [{
        type: "command",
        command: "C:/Users/Kim/AppData/Local/Programs/Python/Python311/Scripts/graphify.EXE hook-guard search",
      }]);
      const before = readFileSync(settingsPath);
      const result = spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "..", "..", "scripts", "doctor-hooks.mjs"),
          "--project",
          "--project-root",
          root,
          "--fix",
          "--silent",
        ],
        { encoding: "utf8" },
      );

      assert.equal(result.status, 1);
      assert.deepEqual(readFileSync(settingsPath), before);
    });
  });

  test("classifies an existing current Graphify exec hook as healthy", {
    skip: process.platform !== "win32",
  }, () => {
    withTempProject((root) => {
      const executable = path.join(root, "graphify.EXE");
      writeFileSync(executable, "");
      const settingsPath = writeHookSettings(root, [{
        type: "command",
        command: executable,
        args: ["hook-guard", "read", "--strict"],
      }]);
      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 0);
      assert.equal(result.unverified.length, 0);
      assert.equal(result.incompatible.length, 0);
      assert.equal(result.live.length, 1);
      assert.equal(result.live[0].path, executable);
    });
  });

  test("recognizes an existing direct-spawn node target from args", () => {
    withTempProject((root) => {
      const hookPath = path.join(root, ".claude", "hooks", "hook with spaces.mjs");
      writeFileSync(hookPath, "export {};\n");
      const hook = { type: "command", command: "node", args: [hookPath] };
      const settingsPath = writeHookSettings(root, [hook]);

      assert.equal(extractHookTargetPath(hook), hookPath);
      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 0);
      assert.equal(result.unverified.length, 0);
      assert.equal(result.live.length, 1);
      assert.equal(result.live[0].path, hookPath);
    });
  });

  test("treats a direct-spawn script command with spaces as one literal path", () => {
    withTempProject((root) => {
      const hookPath = path.join(root, ".claude", "hooks", "valid hook.cmd");
      writeFileSync(hookPath, "@echo off\r\n");
      const hook = { type: "command", command: hookPath, args: [] };
      const settingsPath = writeHookSettings(root, [hook]);

      assert.equal(extractHookTargetPath(hook), hookPath);
      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 0);
      assert.equal(result.unverified.length, 0);
      assert.equal(result.live.length, 1);

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.deepEqual(removeZombies(settings, settingsPath), {
        settings,
        removed: 0,
      });
    });
  });

  test("recognizes an absolute runner path with spaces in direct-spawn form", () => {
    withTempProject((root) => {
      const hookPath = path.join(root, ".claude", "hooks", "hook.mjs");
      writeFileSync(hookPath, "export {};\n");
      const runner = process.platform === "win32"
        ? "C:/Program Files/nodejs/node.exe"
        : "/opt/Node Runtime/bin/node";
      const hook = { type: "command", command: runner, args: [hookPath] };
      const settingsPath = writeHookSettings(root, [hook]);

      assert.equal(extractHookTargetPath(hook), hookPath);
      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 0);
      assert.equal(result.unverified.length, 0);
      assert.equal(result.live.length, 1);
    });
  });

  test("recognizes only explicit PowerShell file mode in direct-spawn form", () => {
    withTempProject((root) => {
      const hookPath = path.join(root, ".claude", "hooks", "hook.ps1");
      writeFileSync(hookPath, "exit 0\n");
      const hook = { type: "command", command: "pwsh", args: ["-File", hookPath] };
      const settingsPath = writeHookSettings(root, [hook]);

      assert.equal(extractHookTargetPath(hook), hookPath);
      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 0);
      assert.equal(result.unverified.length, 0);
      assert.equal(result.live.length, 1);
    });
  });

  test("preserves malformed direct-spawn args as unverified", () => {
    withTempProject((root) => {
      const malformedHooks = [
        { type: "command", command: "node", args: ".claude/hooks/missing.mjs" },
        { type: "command", command: "node", args: [42, ".claude/hooks/missing.mjs"] },
      ];
      const settingsPath = writeHookSettings(root, malformedHooks);
      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 0);
      assert.equal(result.live.length, 0);
      assert.equal(result.unverified.length, 2);

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const cleaned = removeZombies(settings, settingsPath);
      assert.equal(cleaned.removed, 0);
      assert.deepEqual(cleaned.settings, settings);
    });
  });

  test("preserves direct-spawn non-file and ambiguous runner args as unverified", () => {
    withTempProject((root) => {
      const inlineHooks = [
        {
          type: "command",
          command: "node",
          args: ["-e", "console.log(process.argv[1])", "missing-data.js"],
        },
        {
          type: "command",
          command: "node",
          args: ["-econsole.log(process.argv[1])", "missing-data.js"],
        },
        { type: "command", command: "node", args: ["-efoo.js"] },
        { type: "command", command: "node", args: ["--eval=foo.js"] },
        { type: "command", command: "node", args: ["--print=foo.js"] },
        {
          type: "command",
          command: "python",
          args: ["-c", "print('safe')", "missing-data.py"],
        },
        { type: "command", command: "python", args: ["-cfoo.py"] },
        {
          type: "command",
          command: "python3",
          args: ["-m", "package.tool", "missing-data.py"],
        },
        {
          type: "command",
          command: "bash",
          args: ["-c", "echo missing-data.sh"],
        },
        { type: "command", command: "bash", args: ["-cfoo.sh"] },
        {
          type: "command",
          command: "pwsh",
          args: ["-Command", "Write-Output missing-data.ps1"],
        },
        {
          type: "command",
          command: "bun",
          args: ["-e", "missing-data.ts"],
        },
        {
          type: "command",
          command: "deno",
          args: ["eval", "missing-data.ts"],
        },
        {
          type: "command",
          command: "npx",
          args: ["package", "--output", "missing-data.js"],
        },
        {
          type: "command",
          command: "cmd",
          args: ["/c", "echo missing-data.cmd"],
        },
      ];
      const settingsPath = writeHookSettings(root, inlineHooks);

      for (const hook of inlineHooks) {
        assert.equal(extractHookTargetPath(hook), null);
      }
      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 0);
      assert.equal(result.live.length, 0);
      assert.equal(result.unverified.length, inlineHooks.length);

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const cleaned = removeZombies(settings, settingsPath);
      assert.equal(cleaned.removed, 0);
      assert.deepEqual(cleaned.settings, settings);
    });
  });

  test("removes only a missing direct-spawn target and preserves unrelated args", () => {
    withTempProject((root) => {
      const livePath = path.join(root, ".claude", "hooks", "live.mjs");
      const missingPath = path.join(root, ".claude", "hooks", "missing.mjs");
      writeFileSync(livePath, "export {};\n");
      const liveHook = { type: "command", command: "node", args: [livePath, "--mode", "safe"] };
      const missingHook = { type: "command", command: "node", args: [missingPath] };
      const unrelatedHook = {
        type: "command",
        command: "graphify",
        args: ["hook-guard", "payload.js"],
      };
      const settingsPath = writeHookSettings(root, [liveHook, missingHook, unrelatedHook]);

      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 1);
      assert.equal(result.zombies[0].rawPath, missingPath);
      assert.equal(result.live.length, 1);
      assert.equal(result.unverified.length, 1);

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const cleaned = removeZombies(settings, settingsPath);
      assert.equal(cleaned.removed, 1);
      assert.deepEqual(
        cleaned.settings.hooks.PostToolUse[0].hooks,
        [liveHook, unrelatedHook],
      );
    });
  });

  test("recognizes and removes a missing WSL shell-form path on Windows", {
    skip: process.platform !== "win32",
  }, () => {
    withTempProject((root) => {
      const command = 'node "/mnt/c/Users/MetaKimMissing/.claude/hooks/hook.mjs"';
      const settingsPath = writeSettings(root, command);
      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 1);
      assert.equal(result.zombies[0].rawPath, "/mnt/c/Users/MetaKimMissing/.claude/hooks/hook.mjs");

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const cleaned = removeZombies(settings, settingsPath);
      assert.equal(cleaned.removed, 1);
      assert.deepEqual(cleaned.settings.hooks, {});
    });
  });

  test("preserves MSYS drive paths as unverified on Windows", {
    skip: process.platform !== "win32",
  }, () => {
    withTempProject((root) => {
      const msysPath = "/c/Users/Kim/.claude/hooks/meta-kim/hook.mjs";
      const hooks = [
        { type: "command", command: `node "${msysPath}"` },
        { type: "command", command: "node", args: [msysPath] },
      ];
      const settingsPath = writeHookSettings(root, hooks);
      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 0);
      assert.equal(result.live.length, 0);
      assert.equal(result.unverified.length, hooks.length);
      assert.equal(result.unverified[0].rawPath, msysPath);
      assert.equal(result.unverified[1].rawPath, msysPath);

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const cleaned = removeZombies(settings, settingsPath);
      assert.equal(cleaned.removed, 0);
      assert.deepEqual(cleaned.settings, settings);
    });
  });

  test("preserves ambiguous POSIX absolute roots as unverified on Windows", {
    skip: process.platform !== "win32",
  }, () => {
    withTempProject((root) => {
      const settingsPath = writeSettings(root, 'node "/usr/local/hooks/hook.mjs"');
      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 0);
      assert.equal(result.live.length, 0);
      assert.equal(result.unverified.length, 1);

      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const cleaned = removeZombies(settings, settingsPath);
      assert.equal(cleaned.removed, 0);
      assert.deepEqual(cleaned.settings, settings);
    });
  });

  test("resolves an explicit project root before the caller cwd", () => {
    withTempProject((root) => {
      const settingsPath = writeSettings(root, "node .claude/hooks/hook.mjs");
      assert.strictEqual(projectRootFromArgs(["--project-root", root], "C:/ignored"), root);
      assert.strictEqual(findProjectSettings(root), settingsPath);
      assert.strictEqual(projectRootFromArgs([], root), root);
    });
  });

  test("rejects a missing --project-root value", () => {
    assert.throws(
      () => projectRootFromArgs(["--project-root", "--project"], process.cwd()),
      /requires a path/u,
    );
  });

  test("resolves relative hook commands from the project containing settings.json", () => {
    withTempProject((root) => {
      const hookPath = path.join(root, ".claude", "hooks", "hook.mjs");
      writeFileSync(hookPath, "export {};\n");
      const settingsPath = writeSettings(root, "node .claude/hooks/hook.mjs");
      assert.strictEqual(
        resolveHookTargetPath(".claude/hooks/hook.mjs", settingsPath),
        hookPath,
      );
      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 0);
      assert.equal(result.incompatible.length, 0);
      assert.equal(result.live.length, 1);
    });
  });

  test("classifies CommonJS syntax in a type=module .js hook as incompatible", () => {
    withTempProject((root) => {
      writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
      const hookPath = path.join(root, ".claude", "hooks", "legacy.js");
      writeFileSync(hookPath, "const fs = require('node:fs');\n");
      const settingsPath = writeSettings(root, "node .claude/hooks/legacy.js");

      const issue = detectHookRuntimeIncompatibility(hookPath);
      assert.equal(issue?.code, "esm_commonjs_mismatch");

      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 0);
      assert.equal(result.live.length, 0);
      assert.equal(result.incompatible.length, 1);
      assert.equal(result.incompatible[0].path, hookPath);
    });
  });

  test("does not flag ESM .js or CommonJS .cjs hooks", () => {
    withTempProject((root) => {
      writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
      const esmPath = path.join(root, ".claude", "hooks", "esm.js");
      const cjsPath = path.join(root, ".claude", "hooks", "legacy.cjs");
      writeFileSync(esmPath, "import fs from 'node:fs';\nvoid fs;\n");
      writeFileSync(cjsPath, "module.exports = {};\n");
      assert.equal(detectHookRuntimeIncompatibility(esmPath), null);
      assert.equal(detectHookRuntimeIncompatibility(cjsPath), null);
    });
  });

  test("classifies commands with no parseable target as unverified, not healthy or broken", () => {
    withTempProject((root) => {
      const settingsPath = writeSettings(root, "graphify hook-guard search");
      const result = scanSettingsFile(settingsPath);
      assert.equal(result.zombies.length, 0);
      assert.equal(result.incompatible.length, 0);
      assert.equal(result.live.length, 0);
      assert.equal(result.unverified.length, 1);
      assert.equal(result.unverified[0].command, "graphify hook-guard search");
    });
  });

  test("fix cleanup preserves commands with no parseable target", () => {
    withTempProject((root) => {
      const settingsPath = writeSettings(root, "graphify hook-guard search");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const cleaned = removeZombies(settings, settingsPath);
      assert.equal(cleaned.removed, 0);
      assert.deepEqual(
        cleaned.settings.hooks.PostToolUse[0].hooks.map((hook) => hook.command),
        ["graphify hook-guard search"],
      );
    });
  });

  test("fix cleanup removes only missing hooks and preserves incompatible unknown hooks", () => {
    withTempProject((root) => {
      writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
      const hookPath = path.join(root, ".claude", "hooks", "legacy.js");
      writeFileSync(hookPath, "module.exports = {};\n");
      const settingsPath = writeSettings(root, "node .claude/hooks/legacy.js");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      settings.hooks.PostToolUse[0].hooks.push({
        type: "command",
        command: "node .claude/hooks/missing.mjs",
      });

      const cleaned = removeZombies(settings, settingsPath);
      assert.equal(cleaned.removed, 1);
      assert.deepEqual(
        cleaned.settings.hooks.PostToolUse[0].hooks.map((hook) => hook.command),
        ["node .claude/hooks/legacy.js"],
      );
    });
  });
});
