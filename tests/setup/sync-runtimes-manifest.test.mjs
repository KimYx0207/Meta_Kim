import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile as readFsFile } from "node:fs/promises";

import {
  CODEX_BUSINESS_ROLE_AGENTS,
  CODEX_RUNTIME_ADAPTER_AGENTS,
  applyRuntimePaths,
  buildCodexAgent,
  buildCodexProjectConfig,
  buildCodexSkillContent,
  buildCursorAgent,
  buildCursorProjectHooksJson,
  buildCodexGraphifyContextHook,
  buildCodexProjectHooksJson,
  GLOBAL_ONLY_DURABLE_PROJECTION_ROOTS,
  GLOBAL_ONLY_WHOLE_FILE_PROJECTIONS,
  collectRuntimeSedimentedProjectPaths,
  inferProjectCategory,
  inferProjectPurpose,
  inferProjectRuntimeTarget,
  inspectProjectProjectionOwnership,
  isRuntimeSedimentedProjectPath,
} from "../../scripts/sync-runtimes.mjs";
import { mergeRepoClaudeSettings } from "../../scripts/claude-settings-merge.mjs";
import { CATEGORIES } from "../../scripts/install-manifest.mjs";
import {
  buildCodexHooksJson,
  buildHookPromptAdapterSource,
} from "../../scripts/runtime-hook-mapping.mjs";

const REPO = path.resolve("/fake/repo");

function p(...bits) {
  return path.join(REPO, ...bits);
}

describe("sync-runtimes / target selection", () => {
  test("uses activeTargets instead of all supportedTargets by default", async () => {
    const source = await readFsFile("scripts/sync-runtimes.mjs", "utf8");

    assert.match(
      source,
      /const targetContext = await resolveTargetContext\(cliArgs\);/,
    );
    assert.match(
      source,
      /targetContext\.localOverrides\.projectProjectionMode === "global_only"/,
    );
    assert.match(
      source,
      /const selectedTargets = globalOnlyProjectSync \? \[\] : targetContext\.activeTargets;/,
    );
    assert.doesNotMatch(
      source,
      /const selectedTargets = cliTargets\.length > 0 \? cliTargets : supportedTargets;/,
    );
  });

  test("global_only keeps only the project Hook dependency closure as install projection", async () => {
    const source = await readFsFile("scripts/sync-runtimes.mjs", "utf8");
    assert.deepEqual(
      GLOBAL_ONLY_WHOLE_FILE_PROJECTIONS,
      [".codex/hooks.json", ".cursor/hooks.json"],
    );
    for (const forbiddenRoot of [
      ".claude/agents",
      ".claude/skills",
      ".codex/agents",
      ".agents/skills",
      ".cursor/agents",
      "codex",
      "openclaw",
    ]) {
      assert.ok(GLOBAL_ONLY_DURABLE_PROJECTION_ROOTS.includes(forbiddenRoot));
    }
    assert.equal(GLOBAL_ONLY_DURABLE_PROJECTION_ROOTS.includes(".claude/hooks"), false);
    assert.equal(GLOBAL_ONLY_DURABLE_PROJECTION_ROOTS.includes(".codex/hooks"), false);
    assert.equal(GLOBAL_ONLY_DURABLE_PROJECTION_ROOTS.includes(".cursor/hooks"), false);
    assert.match(source, /manifestFileEntryMatches\(entry, filePath\)/);
    assert.match(source, /entry\.source === "sync-runtimes"/);
    assert.match(source, /await enforceGlobalOnlyProjectShape\(changedFiles\)/);
    assert.match(source, /mcp_servers\.meta-kim-runtime/);
    assert.match(source, /mcp_servers\.meta_kim_runtime/);
    assert.doesNotMatch(source, /replaceSources:\s*\["sync-runtimes"\]/);
  });

  test("runtime-sedimented project copy wins over matching install-manifest ownership", () => {
    const relPath = ".agents/skills/custom-project-skill/SKILL.md";
    const absolutePath = p(...relPath.split("/"));
    const protectedPaths = collectRuntimeSedimentedProjectPaths(
      {
        schemaVersion: "meta-kim-project-capabilities-v0.1",
        capabilities: [
          {
            type: "skill",
            ownershipClass: "runtime_sedimented_project_copy",
            policy: "copy_to_project_for_modification",
            detachedFromDependencyUpdates: true,
            dependencyUpdatePolicy: "preserve_project_copy",
            files: [{ relPath }],
          },
        ],
      },
      REPO,
      process.cwd(),
    );
    assert.equal(
      isRuntimeSedimentedProjectPath(absolutePath, protectedPaths),
      true,
    );
    const descendantPath = p(".agents", "skills", "custom-project-skill", "references", "user-note.md");
    assert.equal(
      isRuntimeSedimentedProjectPath(descendantPath, protectedPaths),
      true,
      "sync writes must preserve every descendant of a runtime-sedimented Skill root",
    );
    const ownership = inspectProjectProjectionOwnership(
      absolutePath,
      {
        entries: [
          {
            path: absolutePath,
            source: "sync-runtimes",
            kind: "file",
            sha256: "still-equal-to-old-install-hash",
            size: 42,
          },
        ],
      },
      protectedPaths,
    );
    assert.deepEqual(ownership, {
      preserve: true,
      reason: "runtime_sedimented_project_copy",
      entry: null,
    });
    assert.deepEqual(
      inspectProjectProjectionOwnership(
        descendantPath,
        { entries: [{ path: descendantPath, source: "sync-runtimes", kind: "file", sha256: "old" }] },
        protectedPaths,
      ),
      { preserve: true, reason: "runtime_sedimented_project_copy", entry: null },
      "global_only deletion must preserve Skill descendant files even with old install ownership",
    );
  });

  test("direct global reuse never creates a protected project path", () => {
    const protectedPaths = collectRuntimeSedimentedProjectPaths(
      {
        schemaVersion: "meta-kim-project-capabilities-v0.1",
        capabilities: [
          {
            type: "skill",
            ownershipClass: "global_reuse_reference",
            policy: "use_global_directly",
            files: [{ relPath: ".agents/skills/global-only/SKILL.md" }],
          },
        ],
      },
      REPO,
      process.cwd(),
    );
    assert.equal(protectedPaths.size, 0);
  });
});

describe("sync-runtimes / inferProjectCategory", () => {
  test("maps .claude/settings.json to category G", () => {
    assert.equal(
      inferProjectCategory(p(".claude/settings.json"), REPO),
      CATEGORIES.G,
    );
  });

  test("maps .mcp.json to category G", () => {
    assert.equal(inferProjectCategory(p(".mcp.json"), REPO), CATEGORIES.G);
  });

  test("maps openclaw template json to category G", () => {
    assert.equal(
      inferProjectCategory(p("openclaw/openclaw.template.json"), REPO),
      CATEGORIES.G,
    );
  });

  test("maps any .codex/ config file to category G", () => {
    assert.equal(
      inferProjectCategory(p(".codex/config.toml"), REPO),
      CATEGORIES.G,
    );
  });

  test("maps runtime slash commands to project settings category", () => {
    assert.equal(
      inferProjectCategory(p(".claude/commands/meta-theory.md"), REPO),
      CATEGORIES.G,
    );
    assert.equal(
      inferProjectCategory(p(".codex/commands/meta-theory.md"), REPO),
      CATEGORIES.G,
    );
  });

  test("maps .claude/hooks/*.mjs to category E", () => {
    assert.equal(
      inferProjectCategory(p(".claude/hooks/stop-compaction.mjs"), REPO),
      CATEGORIES.E,
    );
    assert.equal(
      inferProjectCategory(p(".codex/hooks/meta-kim-memory-save.mjs"), REPO),
      CATEGORIES.E,
    );
    assert.equal(
      inferProjectCategory(p(".cursor/hooks/meta-kim-memory-save.mjs"), REPO),
      CATEGORIES.E,
    );
    assert.equal(
      inferProjectCategory(p("openclaw/hooks/mcp-memory-service/HOOK.md"), REPO),
      CATEGORIES.E,
    );
  });

  test("maps runtime agents to category F across runtimes", () => {
    assert.equal(
      inferProjectCategory(p(".claude/agents/meta-warden.md"), REPO),
      CATEGORIES.F,
    );
    assert.equal(
      inferProjectCategory(p(".codex/agents/meta-warden.toml"), REPO),
      CATEGORIES.F,
    );
    assert.equal(
      inferProjectCategory(p(".cursor/agents/meta-warden.md"), REPO),
      CATEGORIES.F,
    );
  });

  test("maps runtime skills to category D across runtimes", () => {
    assert.equal(
      inferProjectCategory(p(".claude/skills/meta-theory/SKILL.md"), REPO),
      CATEGORIES.D,
    );
    assert.equal(
      inferProjectCategory(p(".cursor/skills/meta-theory/SKILL.md"), REPO),
      CATEGORIES.D,
    );
    assert.equal(
      inferProjectCategory(p("openclaw/skills/meta-theory/SKILL.md"), REPO),
      CATEGORIES.D,
    );
    assert.equal(
      inferProjectCategory(p(".agents/skills/meta-theory/SKILL.md"), REPO),
      CATEGORIES.D,
    );
    assert.equal(
      inferProjectCategory(p(".codex/skills/meta-theory/SKILL.md"), REPO),
      null,
    );
  });

  test("maps capability index mirrors to project settings category", () => {
    assert.equal(
      inferProjectCategory(
        p(".claude/capability-index/meta-kim-capabilities.json"),
        REPO,
      ),
      CATEGORIES.G,
    );
    assert.equal(
      inferProjectCategory(
        p(".codex/capability-index/meta-kim-capabilities.json"),
        REPO,
      ),
      CATEGORIES.G,
    );
    assert.equal(
      inferProjectCategory(
        p("openclaw/capability-index/meta-kim-capabilities.json"),
        REPO,
      ),
      CATEGORIES.G,
    );
    assert.equal(
      inferProjectCategory(
        p(".cursor/capability-index/meta-kim-capabilities.json"),
        REPO,
      ),
      CATEGORIES.G,
    );
  });

  test("maps openclaw workspaces to category D", () => {
    assert.equal(
      inferProjectCategory(p("openclaw/workspaces/meta-warden/SOUL.md"), REPO),
      CATEGORIES.D,
    );
  });

  test("returns null for paths outside the repo", () => {
    const outside = path.resolve("/tmp/not-in-repo/.claude/settings.json");
    assert.equal(inferProjectCategory(outside, REPO), null);
  });

  test("returns null for repo-local paths that are not projection targets", () => {
    assert.equal(inferProjectCategory(p("README.md"), REPO), null);
    assert.equal(
      inferProjectCategory(p("scripts/sync-runtimes.mjs"), REPO),
      null,
    );
    assert.equal(inferProjectCategory(p("docs/guide.md"), REPO), null);
  });

  test("returns null for empty / invalid input", () => {
    assert.equal(inferProjectCategory("", REPO), null);
    assert.equal(inferProjectCategory(null, REPO), null);
    assert.equal(inferProjectCategory(undefined, REPO), null);
    assert.equal(inferProjectCategory(123, REPO), null);
  });

  test("distinguishes .claude/settings.json (G) from .claude/hooks/ (E)", () => {
    const settings = inferProjectCategory(p(".claude/settings.json"), REPO);
    const hook = inferProjectCategory(p(".claude/hooks/anything.mjs"), REPO);
    assert.notEqual(settings, hook);
    assert.equal(settings, CATEGORIES.G);
    assert.equal(hook, CATEGORIES.E);
  });
});

describe("sync-runtimes / inferProjectPurpose", () => {
  test("maps each category to its purpose tag", () => {
    assert.equal(inferProjectPurpose(CATEGORIES.D), "project-skill");
    assert.equal(inferProjectPurpose(CATEGORIES.E), "project-hook");
    assert.equal(inferProjectPurpose(CATEGORIES.F), "project-agent");
    assert.equal(inferProjectPurpose(CATEGORIES.G), "project-settings");
  });

  test("returns null for non-project categories", () => {
    assert.equal(inferProjectPurpose(CATEGORIES.A), null);
    assert.equal(inferProjectPurpose(CATEGORIES.B), null);
    assert.equal(inferProjectPurpose(CATEGORIES.C), null);
    assert.equal(inferProjectPurpose(CATEGORIES.H), null);
    assert.equal(inferProjectPurpose(CATEGORIES.I), null);
  });

  test("returns null for unknown / missing input", () => {
    assert.equal(inferProjectPurpose(null), null);
    assert.equal(inferProjectPurpose(undefined), null);
    assert.equal(inferProjectPurpose("Z"), null);
  });
});

describe("sync-runtimes / install projection ownership", () => {
  test("classifies runtime target independently from ownership class", () => {
    assert.equal(inferProjectRuntimeTarget(p(".claude/agents/meta-warden.md"), REPO), "claude");
    assert.equal(inferProjectRuntimeTarget(p(".agents/skills/meta-theory/SKILL.md"), REPO), "codex");
    assert.equal(inferProjectRuntimeTarget(p(".cursor/rules/meta.mdc"), REPO), "cursor");
    assert.equal(inferProjectRuntimeTarget(p("openclaw/workspaces/meta-warden/SOUL.md"), REPO), "openclaw");
  });
});

describe("sync-runtimes / Codex project hooks", () => {
  test("fresh Codex project config does not auto-register a per-session stdio MCP", () => {
    const configExample = [
      'approval_policy = "on-request"',
      "[features]",
      "default_mode_request_user_input = true",
      "[agents]",
      "max_threads = 2",
      "max_depth = 1",
      "",
    ].join("\n");
    const out = buildCodexProjectConfig("", configExample, {
      platformName: "linux",
      codexHome: "/tmp/codex-home",
    });
    assert.doesNotMatch(out, /\[mcp_servers\./);
    assert.match(out, /max_threads = 2/);
  });

  test("project Codex config preserves local MCP while enabling native choice surface", () => {
    const existingProjectConfig = [
      "[mcp_servers.meta-kim-runtime]",
      'args = ["scripts/mcp/meta-runtime-server.mjs"]',
      'command = "node"',
      "",
    ].join("\n");
    const configExample = [
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      "",
      "[features]",
      "default_mode_request_user_input = true",
      "",
      "[agents]",
      "max_threads = 2",
      "max_depth = 1",
      "",
    ].join("\n");

    const out = buildCodexProjectConfig(existingProjectConfig, configExample, {
      platformName: "linux",
      codexHome: "/tmp/codex-home",
    });

    assert.match(out, /\[mcp_servers\.meta-kim-runtime\]/);
    assert.match(out, /scripts\/mcp\/meta-runtime-server\.mjs/);
    assert.match(out, /\[features\][\s\S]*default_mode_request_user_input = true/);
    assert.match(out, /\[features\][\s\S]*js_repl = true/);
  });

  test("registers the enforce-agent-dispatch deny gate before context hooks", () => {
    const config = buildCodexProjectHooksJson();
    const preToolUse = config.hooks.PreToolUse;

    const enforceEntry = preToolUse.find((entry) =>
      entry.hooks?.some((cmd) =>
        cmd.command?.includes("enforce-agent-dispatch.mjs"),
      ),
    );
    assert(enforceEntry, "enforce-agent-dispatch should be registered");
    assert.match(
      JSON.stringify(enforceEntry.hooks),
      /--runtime codex/,
      "Codex hook command must pass explicit runtime instead of relying on path sniffing",
    );
    assert.equal(
      preToolUse[0],
      enforceEntry,
      "enforce-agent-dispatch must run before any other PreToolUse hook",
    );
    assert.match(
      enforceEntry.matcher,
      /Bash\|apply_patch\|Edit\|Write\|MultiEdit\|NotebookEdit\|Agent/,
    );
    assert.match(enforceEntry.matcher, /spawn_agent/);

    const graphifyEntry = preToolUse.find((entry) =>
      entry.hooks?.some((cmd) =>
        cmd.command?.includes("graphify-context.mjs"),
      ),
    );
    assert(graphifyEntry, "graphify-context should still be registered");
  });

  test("uses a cross-platform Node command instead of Unix shell syntax", () => {
    const config = buildCodexProjectHooksJson();
    const graphifyEntry = config.hooks.PreToolUse.find((entry) =>
      entry.hooks?.some((cmd) =>
        cmd.command?.includes("graphify-context.mjs"),
      ),
    );
    assert(graphifyEntry, "graphify-context entry should be present");
    const command = graphifyEntry.hooks[0].command;

    assert.match(command, /node(\.exe)?/);
    assert.match(command, /\.codex\/hooks\/graphify-context\.mjs/);
    assert.doesNotMatch(command, /\[ -f|\|\| true|2>\/dev\/null/);
  });

  test("repo Claude settings remove retired inline hooks and refresh managed project hooks", () => {
    const retiredInlineHook =
      'CMD=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get(\'tool_input\',d).get(\'command\',\'\'))" 2>/dev/null || true); case "$CMD" in *rg\\ *) [ -f graphify-out/graph.json ] && echo "{}" || true ;; esac';
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
              {
                type: "command",
                command: "node .claude/hooks/enforce-agent-dispatch.mjs",
              },
            ],
          },
        ],
      },
    };
    const merged = mergeRepoClaudeSettings(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: retiredInlineHook,
                },
              ],
            },
          ],
        },
      },
      canonical,
      REPO
    );
    const commands = Object.values(merged.hooks ?? {})
      .flatMap((blocks) => blocks.flatMap((block) => block.hooks ?? []))
      .map((hook) => hook.command);

    assert.equal(commands.some((command) => command.includes("graphify-context.mjs")), true);
    assert.equal(commands.some((command) => command.includes("enforce-agent-dispatch.mjs")), true);
    assert.equal(commands.some((command) => command.includes("CMD=$(python3")), false);
  });

  test("Claude sync branches on requested scope instead of repository identity", async () => {
    const source = await readFsFile("scripts/sync-runtimes.mjs", "utf8");

    assert.doesNotMatch(source, /includeProjectHooks/);
    assert.match(source, /const globalScope = dirs\.scope === "global"/);
    assert.match(source, /if \(!globalScope\) \{[\s\S]*mergeRepoClaudeSettings/);
    assert.match(source, /else \{[\s\S]*mergeGlobalMetaKimHooksIntoSettings/);
  });

  test("project Codex hooks wire memory before lifecycle cleanup without global-only adapters", () => {
    const config = buildCodexProjectHooksJson({ packageRoot: "D:/Meta_Kim" });

    assert.ok(Array.isArray(config.hooks.SessionStart));
    assert.ok(
      config.hooks.UserPromptSubmit[0].hooks.some((hook) =>
        hook.command.includes("activate-meta-theory-spine.mjs"),
      ),
      "Codex project prompt entry must run the meta-theory spine hook",
    );
    assert.ok(Array.isArray(config.hooks.Stop));
    assert.match(JSON.stringify(config.hooks.Stop), /stop-compaction\.mjs/);
    assert.ok(
      config.hooks.PostToolUse.some((entry) =>
        entry.hooks?.some((hook) => hook.command.includes("activate-meta-theory-spine.mjs")),
      ),
      "Codex project PostToolUse must preserve worker lifecycle writeback",
    );
    assert.ok(
      config.hooks.PostToolUse.some((entry) =>
        entry.hooks?.some((hook) => hook.command.includes("post-format.mjs")),
      ),
      "Codex project PostToolUse must still append formatting hooks",
    );
    assert.ok(
      config.hooks.SubagentStart.some((entry) =>
        entry.hooks?.some((hook) => hook.command.includes("activate-meta-theory-spine.mjs")),
      ),
      "Codex project SubagentStart must preserve worker lifecycle binding",
    );
    assert.ok(
      config.hooks.SubagentStart.some((entry) =>
        entry.hooks?.some((hook) => hook.command.includes("subagent-context.mjs")),
      ),
      "Codex project SubagentStart must still append context injection",
    );
    const stopCommands = config.hooks.Stop.flatMap((entry) => entry.hooks ?? [])
      .map((hook) => hook.command);
    assert.equal(stopCommands.filter((command) => command.includes("meta-kim-memory-save.mjs")).length, 1);
    assert.equal(stopCommands.filter((command) => command.includes("stop-spine-cleanup.mjs")).length, 1);
    assert.ok(
      stopCommands.findIndex((command) => command.includes("meta-kim-memory-save.mjs")) <
      stopCommands.findIndex((command) => command.includes("stop-spine-cleanup.mjs")),
    );
    const allCommands = JSON.stringify(config);
    assert.match(allCommands, /--package-root/);
    assert.match(allCommands, /D:\/Meta_Kim/);
    assert.match(allCommands, /meta-kim-memory-save\.mjs/);
    assert.doesNotMatch(allCommands, /stop-save-progress\.mjs/);
    assert.doesNotMatch(allCommands, /hookprompt-adapter\.mjs/);
    assert.doesNotMatch(allCommands, /planning-with-files-adapter\.mjs/);
  });

  test("project sync keeps Codex and Cursor hook mirrors active in repo-local projections", async () => {
    const source = await readFsFile("scripts/sync-runtimes.mjs", "utf8");

    assert.doesNotMatch(source, /codexHooksInRepoRoot/);
    assert.doesNotMatch(source, /cursorHooksInRepoRoot/);
    assert.match(source, /CODEX_ACTIVE_PROJECT_HOOK_FILES/);
    assert.match(source, /CURSOR_ACTIVE_PROJECT_HOOK_FILES/);
    assert.match(source, /scope === "global"[\s\S]*GLOBAL_META_KIM_HOOK_PACKAGE_FILES[\s\S]*CODEX_ACTIVE_PROJECT_HOOK_FILES/);
    assert.match(source, /scope === "global"[\s\S]*GLOBAL_META_KIM_HOOK_PACKAGE_FILES[\s\S]*CURSOR_ACTIVE_PROJECT_HOOK_FILES/);
    assert.match(source, /buildCodexProjectHooksJson\(\{[\s\S]*packageRoot: repoRoot/);
    assert.match(source, /buildCursorProjectHooksJson\(\{[\s\S]*packageRoot: repoRoot/);

    const codexProjectConfig = buildCodexProjectHooksJson({ packageRoot: "D:/Meta_Kim" });
    assert.doesNotMatch(JSON.stringify(codexProjectConfig), /hookprompt-adapter\.mjs/);
    assert.match(JSON.stringify(codexProjectConfig), /meta-kim-memory-save\.mjs/);

    const codexGlobalConfig = buildCodexProjectHooksJson({
      hookPromptAdapterPath: "~/.codex/hooks/hookprompt-adapter.mjs",
      memoryHookPath: "~/.codex/hooks/meta-kim/meta-kim-memory-save.mjs",
      packageRoot: "D:/Meta_Kim",
    });
    assert.match(JSON.stringify(codexGlobalConfig), /hookprompt-adapter\.mjs/);
    assert.match(JSON.stringify(codexGlobalConfig), /meta-kim-memory-save\.mjs/);
  });

  test("wires meta-theory Skill activation to the spine hook", () => {
    const config = buildCodexProjectHooksJson();
    const promptEntry = config.hooks.UserPromptSubmit[0].hooks.find((hook) =>
      hook.command.includes("activate-meta-theory-spine.mjs"),
    );
    const skillEntry = config.hooks.Skill.find((entry) =>
      entry.hooks?.some((hook) =>
        hook.command?.includes("activate-meta-theory-spine.mjs"),
      ),
    );

    assert(promptEntry, "prompt-entry spine hook should be registered");
    assert.equal(promptEntry.timeout, 5);
    assert(skillEntry, "meta-theory spine hook should be registered");
    assert.equal(skillEntry.matcher, "meta-theory");
    assert.equal(skillEntry.hooks[0].timeout, 5);
  });

  test("Cursor prompt hooks can bootstrap explicit meta-theory prompts", () => {
    const config = buildCursorProjectHooksJson({ packageRoot: "D:/Meta_Kim" });
    const beforeSubmit = config.hooks.beforeSubmitPrompt;

    assert.match(beforeSubmit[0].command, /activate-meta-theory-spine\.mjs/);
    assert.match(beforeSubmit[0].command, /--package-root/);
    assert.equal(beforeSubmit[0].timeout, 5);
    assert.doesNotMatch(JSON.stringify(config), /meta-kim-memory-save\.mjs/);
    assert.doesNotMatch(JSON.stringify(config), /hookprompt-adapter\.mjs/);
    assert.doesNotMatch(JSON.stringify(config), /planning-with-files-adapter\.mjs/);
  });

  test("can wire HookPrompt through a global Codex adapter", () => {
    const config = buildCodexHooksJson({
      hookPromptAdapterPath: ".codex/hooks/hookprompt-adapter.mjs",
    });

    assert.ok(
      config.hooks.UserPromptSubmit[0].hooks.some((hook) =>
        /hookprompt-adapter\.mjs/.test(hook.command),
      ),
      "Codex UserPromptSubmit should include HookPrompt adapter when configured",
    );
  });

  test("Codex HookPrompt adapter injects model-visible additionalContext", () => {
    const codexSource = buildHookPromptAdapterSource("codex");
    const cursorSource = buildHookPromptAdapterSource("cursor");

    assert.match(codexSource, /hookSpecificOutput/);
    assert.match(codexSource, /hookEventName:\s*"UserPromptSubmit"/);
    assert.match(codexSource, /additionalContext/);
    assert.doesNotMatch(codexSource, /systemMessage:\s*additionalContext/);
    assert.match(cursorSource, /prompt:\s*additionalContext/);
  });

  test("does not emit quoted absolute Node paths that fail in PowerShell", () => {
    const hookPath = "C:\\Users\\Example\\Path With Spaces\\meta-kim-memory-save.mjs";
    const config = buildCodexProjectHooksJson({
      memoryHookPath: hookPath,
    });
    const command = config.hooks.SessionStart[0].hooks[0].command;

    assert.equal(command, `node ${JSON.stringify(hookPath)} --event session-start`);
    assert.doesNotMatch(command, /Program Files/);
    assert.doesNotMatch(command, /^"/);
  });

  test("graphify hook script exits cleanly when no graph exists", () => {
    const source = buildCodexGraphifyContextHook();

    assert.match(source, /existsSync\(graphPath\)/);
    assert.match(source, /systemMessage/);
    assert.match(source, /graphify query/);
    assert.match(source, /graphify path/);
    assert.match(source, /graphify explain/);
    assert.match(source, /source files/);
    assert.match(source, /targeted `rg`/);
    assert.match(source, /never inject full graph\.json or full GRAPH_REPORT\.md/);
    assert.doesNotMatch(source, /Read graphify-out\/GRAPH_REPORT\.md/);
    assert.doesNotMatch(source, /\[ -f|\|\| true|2>\/dev\/null/);
  });
});

describe("sync-runtimes / OpenClaw template portability", () => {
  test("canonical OpenClaw template uses forward-slash placeholders", async () => {
    const templateRaw = await readFsFile(
      "canonical/runtime-assets/openclaw/openclaw.template.json",
      "utf8",
    );

    assert.doesNotMatch(templateRaw, /__REPO_ROOT__\\/);
    assert.match(templateRaw, /__REPO_ROOT__\/openclaw\/workspaces/);
    assert.match(templateRaw, /__REPO_ROOT__\/openclaw\/skills/);
    assert.doesNotMatch(templateRaw, /before_tool_call/);
  });

  test("Cursor and OpenClaw expose project-understanding deep Fetch entry contracts", async () => {
    const cursorRule = await readFsFile(
      "canonical/runtime-assets/cursor/rules/meta-theory-dispatch.mdc",
      "utf8",
    );
    const openclawHeartbeat = await readFsFile(
      "canonical/runtime-assets/openclaw/HEARTBEAT.template.md",
      "utf8",
    );
    const syncRuntime = await readFsFile("scripts/sync-runtimes.mjs", "utf8");

    for (const source of [cursorRule, openclawHeartbeat, syncRuntime]) {
      assert.match(source, /npm run meta:theory:run/);
      assert.match(source, /project understanding|project-understanding/i);
      assert.match(source, /Graphify/);
      assert.match(source, /blocked_to_fetch/);
      assert.match(source, /MCP/);
    }
  });
});

describe("sync-runtimes / Codex skills", () => {
  test("emits Codex-compatible skill frontmatter with only name and description", () => {
    const rendered = buildCodexSkillContent(`---
name: meta-theory
version: 3.0.0
author: KimYx0207
user-invocable: true
trigger: "meta theory"
tools:
  - shell
description: Meta Arsenal dispatcher
---

# Meta Arsenal

Body content.
`);

    const frontmatter = rendered.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    assert.match(frontmatter, /^name: meta-theory$/m);
    assert.match(frontmatter, /^description: Meta Arsenal dispatcher$/m);
    assert.doesNotMatch(frontmatter, /^version:/m);
    assert.doesNotMatch(frontmatter, /^author:/m);
    assert.doesNotMatch(frontmatter, /^user-invocable:/m);
    assert.doesNotMatch(frontmatter, /^trigger:/m);
    assert.doesNotMatch(frontmatter, /^tools:/m);
  });

  test("rewrites canonical agent references with runtime-native extensions", () => {
    const source =
      "Agent source: canonical/agents/meta-warden.md, canonical/agents/*.md, and canonical/agents/{name}.md";

    assert.equal(
      applyRuntimePaths(source, "claude"),
      "Agent source: .claude/agents/meta-warden.md, .claude/agents/*.md, and .claude/agents/{name}.md",
    );
    assert.equal(
      applyRuntimePaths(source, "codex"),
      "Agent source: .codex/agents/meta-warden.toml, .codex/agents/*.toml, and .codex/agents/{name}.toml",
    );
    assert.equal(
      applyRuntimePaths(source, "cursor"),
      "Agent source: .cursor/agents/meta-warden.md, .cursor/agents/*.md, and .cursor/agents/{name}.md",
    );
    assert.equal(
      applyRuntimePaths(source, "openclaw"),
      "Agent source: openclaw/workspaces/meta-warden/SOUL.md, openclaw/workspaces/*/SOUL.md, and openclaw/workspaces/{name}/SOUL.md",
    );
  });

  test("keeps cross-runtime Fetch checklist paths literal in runtime skill mirrors", () => {
    const source = `Fetch discovery minimum checklist: before Thinking, search at least these locations (even if results are empty):
- canonical sources and capability indexes: \`canonical/agents/\`, \`canonical/skills/\`, \`canonical/runtime-assets/\`, \`config/capability-index/*.json\`, and runtime capability-index mirrors
- Claude Code project and global inventories: \`.claude/agents/\`, \`.claude/skills/\`, \`.claude/commands/\`, \`.claude/hooks/\`, \`.claude/settings.json\`, \`~/.claude/agents/\`, \`~/.claude/skills/\`, \`~/.claude/commands/\`, \`~/.claude/hooks/\`, and \`~/.claude/settings.json\`
- Cursor project and global inventories: \`.cursor/agents/\`, \`.cursor/skills/\`, \`.cursor/rules/\`, \`.cursor/prompts/\`, \`.cursor/hooks/\`, \`.cursor/hooks.json\`, \`.cursor/mcp.json\`, \`~/.cursor/agents/\`, \`~/.cursor/skills/\`, \`~/.cursor/rules/\`, \`~/.cursor/prompts/\`, \`~/.cursor/hooks/\`, and \`~/.cursor/hooks.json\`
- OpenClaw project and global inventories: \`openclaw/workspaces/\`, \`openclaw/skills/\`, \`openclaw/hooks/\`, \`openclaw/openclaw.template.json\`, \`~/.openclaw/openclaw.json\`, \`~/.openclaw/workspace-*\`, \`~/.openclaw/skills/\`, \`~/.openclaw/hooks/\`, and \`~/.agents/skills/\`

Pass condition: searchLog exists.
`;

    for (const target of ["claude", "codex", "cursor", "openclaw"]) {
      assert.equal(applyRuntimePaths(source, target), source);
    }
  });

  test("keeps cross-runtime native path matrix literal in runtime skill mirrors", () => {
    const source =
      "- 项目内迭代或创新需要专用能力时，必须创建在对应 runtime 的原生项目目录，不要再包一层 `.meta_kim` 或 `.meta-kim` capability 目录：Claude Code 用 `.claude/agents/`、`.claude/skills/<skill>/`、`.claude/commands/`、`.claude/hooks/`；Codex 用 `.codex/agents/`、`.agents/skills/<skill>/`、`.codex/commands/`、`.codex/hooks.json` + `.codex/hooks/`；Cursor 用 `.cursor/agents/`、`.cursor/skills/<skill>/`、`.cursor/rules/`、`.cursor/hooks.json` + `.cursor/hooks/`；OpenClaw 用 `openclaw/workspaces/<agent>/`、`openclaw/skills/<skill>/`、`openclaw/openclaw.template.json`。\n";

    for (const target of ["claude", "codex", "cursor", "openclaw"]) {
      assert.equal(applyRuntimePaths(source, target), source);
    }
  });
});

describe("sync-runtimes / Codex agents", () => {
  test("emits Codex TOML nickname candidates for canonical meta agents", () => {
    const rendered = buildCodexAgent({
      id: "meta-warden",
      description: "Coordinates dispatch and final synthesis",
      body: "Body instructions",
    });

    assert.match(rendered, /^name = "meta-warden"$/m);
    assert.match(
      rendered,
      /^nickname_candidates = \["Meta Warden", "Warden", "meta-warden"\]$/m,
    );
    assert.match(rendered, /^developer_instructions = """$/m);
    assert.doesNotMatch(rendered, /代码库分析|执行|审查|验证/);
  });

  test("does not project Codex execution-layer adapter agents", () => {
    assert.deepEqual(CODEX_RUNTIME_ADAPTER_AGENTS, []);
    assert.deepEqual(CODEX_BUSINESS_ROLE_AGENTS, []);
  });

  test("classifies stale Codex adapter files as runtime-local projections only", () => {
    assert.equal(
      inferProjectCategory(p(".codex", "agents", "worker.toml"), REPO),
      CATEGORIES.F,
    );
    assert.equal(
      inferProjectCategory(p(".codex", "agents", "explorer.toml"), REPO),
      CATEGORIES.F,
    );
    assert.equal(
      inferProjectCategory(p(".codex", "agents", "frontend.toml"), REPO),
      CATEGORIES.F,
    );
  });
});

describe("sync-runtimes / Cursor agents", () => {
  test("emits Cursor-required YAML frontmatter", () => {
    const rendered = buildCursorAgent({
      id: "meta-warden",
      title: "Meta-Warden",
      summary: "Coordinates the team",
      sourceFile: "canonical/agents/meta-warden.md",
      description: "Coordinates dispatch and final synthesis",
      body: "Body instructions",
    });

    assert.match(rendered, /^---\nname: meta-warden\n/);
    assert.match(
      rendered,
      /description: "Coordinates dispatch and final synthesis"\n---\n\n# Meta-Warden/,
    );
    assert.doesNotMatch(rendered, /nickname_candidates/);
    assert.doesNotMatch(rendered, /^name = /m);
  });

  test("does not duplicate Cursor mirror preamble when canonical body already carries it", () => {
    const body = `# Meta-Warden

> ⚠️ **GOVERNANCE LAYER AGENT — NOT FOR DIRECT EXECUTION**

Body instructions`;
    const rendered = buildCursorAgent({
      id: "meta-warden",
      title: "Meta-Warden",
      summary: "Coordinates the team",
      sourceFile: "canonical/agents/meta-warden.md",
      description: "Coordinates dispatch and final synthesis",
      body,
    });

    assert.equal((rendered.match(/^# Meta-Warden$/gm) ?? []).length, 1);
    assert.equal(
      (rendered.match(/GOVERNANCE LAYER AGENT — NOT FOR DIRECT EXECUTION/g) ?? []).length,
      1,
    );
  });
});

describe("sync-runtimes / Cursor project hooks", () => {
  test("uses Cursor native lowerCamel lifecycle hooks", () => {
    const config = buildCursorProjectHooksJson();

    assert.equal(config.hooks.sessionStart, undefined);
    assert.match(
      config.hooks.beforeSubmitPrompt[0].command,
      /activate-meta-theory-spine\.mjs/,
    );
    assert.equal(config.hooks.beforeSubmitPrompt.length, 1);

    const preToolUse = config.hooks.preToolUse;

    const enforceEntry = preToolUse.find((entry) =>
      entry.command?.includes("enforce-agent-dispatch.mjs"),
    );
    assert(enforceEntry, "enforce-agent-dispatch should be registered");
    assert.match(
      enforceEntry.command,
      /--runtime cursor/,
      "Cursor hook command must pass explicit runtime instead of relying on path sniffing",
    );
    assert.equal(
      preToolUse[0],
      enforceEntry,
      "enforce-agent-dispatch must run before any other preToolUse hook",
    );
    assert.equal(
      enforceEntry.failClosed,
      true,
      "enforce-agent-dispatch must be failClosed so the deny payload is honored",
    );

    const graphifyEntry = preToolUse.find((entry) =>
      entry.command?.includes("graphify-context.mjs"),
    );
    assert(graphifyEntry, "graphify-context should still be registered");

    assert.ok(
      config.hooks.postToolUse.some((entry) =>
        entry.hooks?.some((hook) => hook.command?.includes("activate-meta-theory-spine.mjs")),
      ),
      "Cursor project postToolUse must preserve exact lifecycle observation",
    );
    assert.ok(
      config.hooks.postToolUse.some((entry) =>
        entry.hooks?.some((hook) => hook.command?.includes("post-format.mjs")),
      ),
      "Cursor project postToolUse must still append formatting hooks",
    );
    assert.ok(
      config.hooks.subagentStart.some((entry) =>
        entry.command?.includes("activate-meta-theory-spine.mjs"),
      ),
      "Cursor project subagentStart must preserve exact lifecycle observation",
    );
    assert.ok(
      config.hooks.subagentStart.some((entry) =>
        entry.command?.includes("subagent-context.mjs"),
      ),
      "Cursor project subagentStart must still append context injection",
    );
    assert.equal(
      config.hooks.subagentStop,
      undefined,
      "Cursor must not claim a SubagentStop surface that Meta_Kim has not verified",
    );

    assert.ok(Array.isArray(config.hooks.stop));
    assert.match(JSON.stringify(config.hooks.stop), /stop-compaction\.mjs/);
    assert.doesNotMatch(JSON.stringify(config), /meta-kim-memory-save\.mjs/);
    assert.doesNotMatch(JSON.stringify(config), /stop-save-progress\.mjs/);
    assert.doesNotMatch(JSON.stringify(config), /hookprompt-adapter\.mjs/);
    assert.doesNotMatch(JSON.stringify(config), /planning-with-files-adapter\.mjs/);
  });
});
