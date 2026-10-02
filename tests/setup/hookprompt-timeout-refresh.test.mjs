import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HOOK_PROMPT_TIMEOUT_SECONDS,
  hookCommandNode,
  mergeGlobalMetaKimHooksIntoSettings,
} from "../../scripts/claude-settings-merge.mjs";
import { mergeHookSettings } from "../../scripts/install-global-skills-all-runtimes.mjs";
import { buildGlobalClaudeSettingsHooksTemplate } from "../../scripts/sync-runtimes.mjs";

const REPO_ROOT = new URL("../../", import.meta.url);
const STALE_TIMEOUT = 10000;

function makeClaudeHome({ withNativeHookPrompt }) {
  const home = mkdtempSync(path.join(os.tmpdir(), "meta-kim-hookprompt-"));
  mkdirSync(path.join(home, "hooks"), { recursive: true });
  const script = path.join(home, "hooks", "user-prompt-submit.js");
  if (withNativeHookPrompt) {
    writeFileSync(script, "// native HookPrompt stub\n");
  }
  return { home, script };
}

function promptEntries(settings) {
  return (settings.hooks?.UserPromptSubmit ?? []).flatMap((block) => block.hooks ?? []);
}

function hookPromptEntries(settings) {
  return promptEntries(settings).filter((hook) =>
    /user-prompt-submit\.js/u.test(String(hook.command ?? "")),
  );
}

describe("issue #81: managed HookPrompt timeout follows the template on every writer", () => {
  test("skills.json carries the same HookPrompt timeout as the settings template constant", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("config/skills.json", REPO_ROOT), "utf8"),
    );
    const hookprompt = manifest.skills.find((skill) => skill.id === "hookprompt");

    assert.ok(hookprompt, "skills.json must still declare the hookprompt dependency");
    assert.equal(
      hookprompt.hookSettingsMerge.claude.timeout,
      HOOK_PROMPT_TIMEOUT_SECONDS,
    );
  });

  test("dependency installer refreshes a stale managed HookPrompt timeout instead of skipping it", async () => {
    const { home, script } = makeClaudeHome({ withNativeHookPrompt: true });
    try {
      const userHook = {
        type: "command",
        command: 'node "/Users/example/.claude/hooks/my-own-prompt-hook.js"',
        timeout: 5,
      };
      writeFileSync(
        path.join(home, "settings.json"),
        JSON.stringify(
          {
            permissions: { allow: ["Bash(ls:*)"] },
            hooks: {
              UserPromptSubmit: [
                {
                  hooks: [
                    { type: "command", command: hookCommandNode(script), timeout: STALE_TIMEOUT },
                  ],
                },
                { hooks: [userHook] },
              ],
            },
          },
          null,
          2,
        ),
      );
      const spec = {
        id: "hookprompt",
        hookSettingsMerge: {
          claude: {
            event: "UserPromptSubmit",
            hookFile: "user-prompt-submit.js",
            timeout: HOOK_PROMPT_TIMEOUT_SECONDS,
          },
        },
      };

      await mergeHookSettings(spec, home, "claude");

      const after = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"));
      const managed = hookPromptEntries(after);
      assert.equal(managed.length, 1, "refresh must not duplicate the managed entry");
      assert.equal(managed[0].timeout, HOOK_PROMPT_TIMEOUT_SECONDS);
      assert.deepEqual(
        promptEntries(after).find((hook) => hook.command.includes("my-own-prompt-hook.js")),
        userHook,
        "a user-authored hook in the same event keeps its own timeout",
      );
      assert.deepEqual(after.permissions, { allow: ["Bash(ls:*)"] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("dependency installer leaves an already-current managed entry byte-for-byte alone", async () => {
    const { home, script } = makeClaudeHome({ withNativeHookPrompt: true });
    try {
      const settingsPath = path.join(home, "settings.json");
      const current = JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  {
                    type: "command",
                    command: hookCommandNode(script),
                    timeout: HOOK_PROMPT_TIMEOUT_SECONDS,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      );
      writeFileSync(settingsPath, current);
      const spec = {
        id: "hookprompt",
        hookSettingsMerge: {
          claude: {
            event: "UserPromptSubmit",
            hookFile: "user-prompt-submit.js",
            timeout: HOOK_PROMPT_TIMEOUT_SECONDS,
          },
        },
      };

      await mergeHookSettings(spec, home, "claude");

      assert.equal(readFileSync(settingsPath, "utf8"), current);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("installer only refreshes the exact managed script and preserves its position and custom fields", async () => {
    const { home, script } = makeClaudeHome({ withNativeHookPrompt: true });
    try {
      const managed = {
        type: "command",
        command: `node "${script.replace(/\\/gu, "\\\\")}"`,
        timeout: STALE_TIMEOUT,
        statusMessage: "Optimizing prompt",
      };
      const userHooks = [
        { type: "command", command: hookCommandNode(path.join(home, "other", "hooks", "user-prompt-submit.js")), timeout: 7 },
        { type: "command", command: hookCommandNode(`${script}.backup.js`), timeout: 8 },
        { type: "command", command: `echo ${hookCommandNode(script)}`, timeout: 9 },
      ];
      const settings = { hooks: { UserPromptSubmit: [{ matcher: "custom", hooks: [...userHooks, managed] }] } };
      const settingsPath = path.join(home, "settings.json");
      writeFileSync(settingsPath, JSON.stringify(settings));
      await mergeHookSettings({ id: "hookprompt", hookSettingsMerge: { claude: {
        event: "UserPromptSubmit", hookFile: "user-prompt-submit.js", timeout: HOOK_PROMPT_TIMEOUT_SECONDS,
      } } }, home, "claude");
      const after = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.deepEqual(after.hooks.UserPromptSubmit, [{ matcher: "custom", hooks: [
        ...userHooks, { ...managed, timeout: HOOK_PROMPT_TIMEOUT_SECONDS },
      ] }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a user's same-name script cannot suppress registration of the managed script", async () => {
    const { home, script } = makeClaudeHome({ withNativeHookPrompt: true });
    try {
      const userHook = { type: "command", command: hookCommandNode(path.join(home, "other", "hooks", "user-prompt-submit.js")), timeout: 5 };
      const settingsPath = path.join(home, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [userHook] }] } }));
      const spec = { id: "hookprompt", hookSettingsMerge: { claude: {
        event: "UserPromptSubmit", hookFile: "user-prompt-submit.js", timeout: HOOK_PROMPT_TIMEOUT_SECONDS,
      } } };
      await mergeHookSettings(spec, home, "claude");
      const first = readFileSync(settingsPath, "utf8");
      assert.deepEqual(promptEntries(JSON.parse(first)), [userHook, {
        type: "command", command: hookCommandNode(script), timeout: HOOK_PROMPT_TIMEOUT_SECONDS,
      }]);
      await mergeHookSettings(spec, home, "claude");
      assert.equal(readFileSync(settingsPath, "utf8"), first);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const withNativeHookPrompt of [true, false]) {
    test(`global sync preserves same-name user hooks with native script ${withNativeHookPrompt ? "present" : "absent"}`, async () => {
      const { home, script } = makeClaudeHome({ withNativeHookPrompt });
      try {
        const userHooks = [
          { type: "command", command: hookCommandNode(path.join(home, "other", "hooks", "user-prompt-submit.js")), timeout: 7 },
          { type: "command", command: hookCommandNode(`${script}.backup.js`), timeout: 8 },
          { type: "command", command: `echo ${hookCommandNode(script)}`, timeout: 9 },
        ];
        const base = { permissions: { allow: ["Read"] }, hooks: { UserPromptSubmit: [
          { hooks: [{ type: "command", command: hookCommandNode(script), timeout: STALE_TIMEOUT }] },
          { matcher: "user-only", hooks: userHooks },
        ] } };
        const template = await buildGlobalClaudeSettingsHooksTemplate(home);
        const merged = mergeGlobalMetaKimHooksIntoSettings(base, template);
        assert.deepEqual(merged.hooks.UserPromptSubmit.find((block) => block.matcher === "user-only"), { matcher: "user-only", hooks: userHooks });
        assert.deepEqual(merged.permissions, base.permissions);
        const managed = promptEntries(merged).filter((hook) => hook.command === hookCommandNode(script));
        assert.equal(managed.length, withNativeHookPrompt ? 1 : 0);
        if (withNativeHookPrompt) assert.equal(managed[0].timeout, HOOK_PROMPT_TIMEOUT_SECONDS);
        assert.deepEqual(mergeGlobalMetaKimHooksIntoSettings(merged, template), merged);
        assert.equal(base.hooks.UserPromptSubmit[0].hooks[0].timeout, STALE_TIMEOUT);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("global-scope runtime sync keeps the native HookPrompt entry and re-dates its timeout", async () => {
    const { home, script } = makeClaudeHome({ withNativeHookPrompt: true });
    try {
      const template = await buildGlobalClaudeSettingsHooksTemplate(home);
      const first = template.UserPromptSubmit[0].hooks[0];
      assert.match(first.command, /user-prompt-submit\.js/u);
      assert.equal(first.timeout, HOOK_PROMPT_TIMEOUT_SECONDS);

      const base = {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                { type: "command", command: hookCommandNode(script), timeout: STALE_TIMEOUT },
              ],
            },
          ],
        },
      };
      const merged = mergeGlobalMetaKimHooksIntoSettings(base, template);
      const managed = hookPromptEntries(merged);
      assert.equal(managed.length, 1);
      assert.equal(managed[0].timeout, HOOK_PROMPT_TIMEOUT_SECONDS);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("global-scope runtime sync template omits HookPrompt when the native script is absent", async () => {
    const { home } = makeClaudeHome({ withNativeHookPrompt: false });
    try {
      const template = await buildGlobalClaudeSettingsHooksTemplate(home);
      const commands = template.UserPromptSubmit[0].hooks.map((hook) => hook.command);
      assert.equal(commands.some((command) => /user-prompt-submit\.js/u.test(command)), false);
      assert.match(commands[0], /activate-meta-theory-spine\.mjs/u);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
