import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildMetaKimHooksTemplate,
  hookCommandNode,
  mergeGlobalMetaKimHooksIntoSettings,
  mergeRepoClaudeSettings,
} from "../../scripts/claude-settings-merge.mjs";

const REPO_ROOT = new URL("../../", import.meta.url);

function matcherTools(matcher) {
  return new Set(String(matcher ?? "").split("|").filter(Boolean));
}

function findEnforcementBlock(settings) {
  return settings.hooks.PreToolUse.find((block) =>
    (block.hooks ?? []).some((hook) =>
      String(hook.command ?? "").includes("enforce-agent-dispatch.mjs"),
    ),
  );
}

describe("Claude settings hook command rendering", () => {
  test("normalizes Windows paths to slash form before writing shell commands", () => {
    const command = hookCommandNode(
      "C:\\Users\\Example\\.claude\\hooks\\meta-kim\\stop-compaction.mjs",
    );

    assert.equal(command, 'node "C:/Users/Example/.claude/hooks/meta-kim/stop-compaction.mjs"');
    assert.doesNotMatch(command, /\\/);
  });

  test("global hook template emits slash-normalized absolute paths", () => {
    const template = buildMetaKimHooksTemplate("C:\\Users\\Example\\.claude\\hooks\\meta-kim");
    const command = template.PreToolUse[0].hooks[0].command;

    assert.equal(command, 'node "C:/Users/Example/.claude/hooks/meta-kim/block-dangerous-bash.mjs"');
    assert.equal(
      template.PreToolUse[1].matcher,
      "Write|Edit|Bash|Agent|Task|TaskCreate|TaskUpdate|TodoWrite|TaskStop|EnterPlanMode|ExitPlanMode|MultiEdit|NotebookEdit",
    );
    assert.equal(
      template.PreToolUse[1].hooks[0].command,
      'node "C:/Users/Example/.claude/hooks/meta-kim/enforce-agent-dispatch.mjs" "--runtime" "claude"',
    );
    const commands = Object.values(template)
      .flatMap((blocks) => blocks.flatMap((block) => block.hooks ?? []))
      .map((hook) => hook.command);
    assert.equal(
      commands.some((entry) => entry.includes("pre-git-push-confirm.mjs")),
      false,
    );
    assert.equal(
      commands.some((entry) => entry.includes("stop-save-progress.mjs")),
      true,
    );
    assert.equal(
      commands.some((entry) => entry.includes("stop-memory-save.mjs")),
      true,
    );
    assert.equal(
      commands.some((entry) => entry.includes("stop-compaction.mjs")),
      true,
    );
  });

  test("Claude enforcement matchers cover the queryBypass control-plane deny contract", () => {
    const template = buildMetaKimHooksTemplate(
      "C:\\Users\\Example\\.claude\\hooks\\meta-kim",
    );
    const canonicalSettings = JSON.parse(
      readFileSync(
        new URL("canonical/runtime-assets/claude/settings.json", REPO_ROOT),
        "utf8",
      ),
    );
    const runtimeControlContract = JSON.parse(
      readFileSync(
        new URL("config/contracts/stage-runtime-control-contract.json", REPO_ROOT),
        "utf8",
      ),
    );

    const templateBlock = findEnforcementBlock({ hooks: template });
    const canonicalBlock = findEnforcementBlock(canonicalSettings);
    assert.ok(templateBlock, "global merge template must register the enforcement hook");
    assert.ok(canonicalBlock, "canonical Claude settings must register the enforcement hook");
    assert.equal(
      canonicalBlock.matcher,
      templateBlock.matcher,
      "project and global Claude projections must expose the same enforcement surface",
    );

    const registeredTools = matcherTools(templateBlock.matcher);
    const denyTools =
      runtimeControlContract.fetchPolicy.queryBypassControlPlanePolicy.denyTools;
    assert.deepEqual(denyTools, [
      "TaskCreate",
      "TaskUpdate",
      "TodoWrite",
      "TaskStop",
      "EnterPlanMode",
      "ExitPlanMode",
    ]);
    assert.deepEqual(
      denyTools.filter((tool) => !registeredTools.has(tool)),
      [],
      "every machine-contract deny tool must be reachable through the Claude matcher",
    );
  });

  test("global update adds the missing enforcement hook and stays idempotent", () => {
    const template = buildMetaKimHooksTemplate(
      "C:\\Users\\Example\\.claude\\hooks\\meta-kim",
    );
    const historical = {
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{
            type: "command",
            command: 'node "C:/Users/Example/.claude/hooks/meta-kim/block-dangerous-bash.mjs"',
          }],
        }],
      },
    };

    const upgraded = mergeGlobalMetaKimHooksIntoSettings(historical, template);
    const repeated = mergeGlobalMetaKimHooksIntoSettings(upgraded, template);
    const serialized = JSON.stringify(upgraded);
    assert.match(serialized, /enforce-agent-dispatch\.mjs/u);
    assert.equal(serialized.match(/enforce-agent-dispatch\.mjs/gu)?.length, 1);
    assert.deepEqual(repeated, upgraded);
  });

  test("Claude global hook template keeps native HookPrompt before Meta_Kim spine", () => {
    const template = buildMetaKimHooksTemplate(
      "C:\\Users\\Example\\.claude\\hooks\\meta-kim",
      "D:\\KimProject\\Meta_Kim",
      {
        hookPromptCommand:
          'node "C:/Users/Example/.claude/hooks/user-prompt-submit.js"',
      },
    );
    const promptHooks = template.UserPromptSubmit[0].hooks;

    assert.match(promptHooks[0].command, /user-prompt-submit\.js/);
    assert.match(promptHooks[1].command, /activate-meta-theory-spine\.mjs/);
    assert.doesNotMatch(
      JSON.stringify(promptHooks),
      /hookprompt-adapter\.mjs/,
    );
  });

  test("global settings merge keeps native HookPrompt block before existing prompt hooks", () => {
    const base = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: ".*",
            hooks: [
              {
                type: "command",
                command: 'node "C:/Users/Example/.claude/hooks/optional.js"',
              },
            ],
          },
        ],
      },
    };
    const template = buildMetaKimHooksTemplate(
      "C:\\Users\\Example\\.claude\\hooks\\meta-kim",
      "D:\\KimProject\\Meta_Kim",
      {
        hookPromptCommand:
          'node "C:/Users/Example/.claude/hooks/user-prompt-submit.js"',
      },
    );

    const merged = mergeGlobalMetaKimHooksIntoSettings(base, template);
    const promptHooks = merged.hooks.UserPromptSubmit.flatMap(
      (block) => block.hooks ?? [],
    );

    assert.match(promptHooks[0].command, /user-prompt-submit\.js/);
    assert.match(promptHooks[1].command, /activate-meta-theory-spine\.mjs/);
    assert.match(promptHooks[2].command, /optional\.js/);
  });

  test("global settings merge preserves unproven same-name retired hooks", () => {
    const base = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command:
                  'node "C:/Users/Example/.claude/hooks/pre-git-push-confirm.mjs"',
              },
              {
                type: "command",
                command: 'node "C:/Users/Example/.claude/hooks/custom.mjs"',
              },
            ],
          },
        ],
      },
    };
    const template = buildMetaKimHooksTemplate(
      "C:\\Users\\Example\\.claude\\hooks\\meta-kim",
    );

    const merged = mergeGlobalMetaKimHooksIntoSettings(base, template);
    const commands = Object.values(merged.hooks)
      .flatMap((blocks) => blocks.flatMap((block) => block.hooks ?? []))
      .map((hook) => hook.command);

    assert.equal(
      commands.some((entry) => entry.includes("pre-git-push-confirm.mjs")),
      true,
    );
    assert.ok(commands.includes('node "C:/Users/Example/.claude/hooks/custom.mjs"'));
  });

  test("global settings merge strips retired hooks only with ownership proof", () => {
    const retired =
      'node "C:/Users/Example/.claude/hooks/pre-git-push-confirm.mjs"';
    const merged = mergeGlobalMetaKimHooksIntoSettings(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: retired }],
            },
          ],
        },
      },
      buildMetaKimHooksTemplate(
        "C:\\Users\\Example\\.claude\\hooks\\meta-kim",
      ),
      { isManagedHookCommand: (command) => command === retired },
    );
    assert.doesNotMatch(JSON.stringify(merged), /pre-git-push-confirm\.mjs/u);
  });

  test("global settings merge removes old managed events no longer in the template", () => {
    const template = buildMetaKimHooksTemplate(
      "C:\\Users\\Example\\.claude\\hooks\\meta-kim",
    );
    const merged = mergeGlobalMetaKimHooksIntoSettings(
      {
        hooks: {
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    'node "C:/Users/Example/.claude/hooks/meta-kim/post-format.mjs"',
                },
              ],
            },
          ],
        },
      },
      template,
    );

    assert.equal(merged.hooks.PostToolUse, undefined);
    assert.match(
      JSON.stringify(merged.hooks),
      /block-dangerous-bash\.mjs/,
    );
  });

  test("global settings merge replaces ownership-proven legacy root Meta_Kim hook commands", () => {
    const base = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command:
                  'node ".claude/hooks/activate-meta-theory-spine.mjs"',
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command:
                  'node "C:/Users/Example/.claude/hooks/block-dangerous-bash.mjs"',
              },
            ],
          },
        ],
      },
    };
    const template = buildMetaKimHooksTemplate(
      "C:\\Users\\Example\\.claude\\hooks\\meta-kim",
    );

    const merged = mergeGlobalMetaKimHooksIntoSettings(base, template, {
      isManagedHookCommand: (command) =>
        command.includes(".claude/hooks/activate-meta-theory-spine.mjs") ||
        command.includes(".claude/hooks/block-dangerous-bash.mjs") ||
        command.includes("/hooks/meta-kim/"),
    });
    const commands = Object.values(merged.hooks)
      .flatMap((blocks) => blocks.flatMap((block) => block.hooks ?? []))
      .map((hook) => hook.command);

    assert.equal(
      commands.some((entry) => entry.includes(".claude/hooks/activate-meta-theory-spine.mjs")),
      false,
    );
    assert.equal(
      commands.some((entry) => entry.includes(".claude/hooks/block-dangerous-bash.mjs")),
      false,
    );
    assert.ok(
      commands.includes(
        'node "C:/Users/Example/.claude/hooks/meta-kim/activate-meta-theory-spine.mjs"',
      ),
    );
    assert.ok(
      commands.includes(
        'node "C:/Users/Example/.claude/hooks/meta-kim/block-dangerous-bash.mjs"',
      ),
    );
  });

  test("repo settings merge adds canonical project hook commands", () => {
    const canonical = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "node .claude/hooks/graphify-context.mjs",
              },
            ],
          },
        ],
      },
    };

    const merged = mergeRepoClaudeSettings({}, canonical, "/Users/delphi/work/Finance");

    assert.deepEqual(merged.hooks, canonical.hooks);
  });

  test("repo settings merge replaces legacy Meta_Kim hook entries with canonical project hooks", () => {
    const base = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "node .claude/hooks/enforce-agent-dispatch.mjs",
              },
            ],
          },
        ],
        Stop: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command:
                  'node "D:/Old/Meta_Kim/.claude/hooks/stop-spine-cleanup.mjs"',
              },
            ],
          },
        ],
      },
    };
    const canonical = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "node .claude/hooks/enforce-agent-dispatch.mjs",
              },
            ],
          },
        ],
        Stop: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: "node .claude/hooks/stop-spine-cleanup.mjs",
              },
            ],
          },
        ],
      },
    };

    const merged = mergeRepoClaudeSettings(base, canonical, "/Users/delphi/work/Finance");
    const commands = Object.values(merged.hooks)
      .flatMap((blocks) => blocks.flatMap((block) => block.hooks ?? []))
      .map((hook) => hook.command);

    assert.deepEqual(commands, [
      "node .claude/hooks/enforce-agent-dispatch.mjs",
      "node .claude/hooks/stop-spine-cleanup.mjs",
    ]);
    assert.equal(
      commands.some((command) => command.includes("D:/Old/Meta_Kim")),
      false,
    );
  });

  test("repo settings merge keeps user hooks while refreshing managed project hooks", () => {
    const merged = mergeRepoClaudeSettings(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume",
              hooks: [
                {
                  type: "command",
                  command: "node .claude/hooks/meta-kim-memory-save.mjs --event session-start",
                },
                {
                  type: "command",
                  command: "node .claude/hooks/user-session-start.mjs",
                },
              ],
            },
          ],
        },
      },
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "node .claude/hooks/graphify-context.mjs",
                },
              ],
            },
          ],
        },
      },
      "/Users/delphi/work/Finance",
    );

    assert.match(JSON.stringify(merged.hooks), /user-session-start\.mjs/);
    assert.doesNotMatch(JSON.stringify(merged.hooks), /meta-kim-memory-save\.mjs/);
    assert.match(JSON.stringify(merged.hooks), /graphify-context\.mjs/);
  });

});
