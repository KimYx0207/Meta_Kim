# Gemini CLI runtime binding

## Use when

Use this reference only when the active host is Google's Gemini CLI. Installation is a projection of canonical Meta_Kim responsibility and workflow sources; it does not establish model quality or live acceptance.

## Required inputs

Read the current host inventory, trusted project root, selected install scope, existing user configuration and install manifest. For governed work, load the pending artifact and its task, intent and revision bindings; inspect the active tool schema before constructing any call.

## Native surfaces

- Project agents: `.gemini/agents/*.md`; user agents: `~/.gemini/agents/*.md`. Generated governance agents use `model: inherit`, `kind: local` and the canonical responsibility body. Omitted tools inherit the active host's tools and permissions. A child cannot call another subagent; return a bounded work order to its parent.
- Project skills: `.agents/skills/meta-theory/`, shared with Codex. Gemini gives `.agents/skills` precedence over `.gemini/skills` at the same scope. Do not install a second same-named divergent bundle. User skills use `~/.gemini/skills/`; an independently managed `~/.agents/skills/meta-theory` may shadow them and must be inspected, never deleted merely because it shares a name.
- Project rules: the native `context.fileName` setting includes `AGENTS.md` while preserving the user's existing context filenames. Existing rules remain the authority.
- Settings: `.gemini/settings.json` or `~/.gemini/settings.json`. MCP servers live in `mcpServers`. Native hooks are `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent` and `SessionStart`; hook denial is a top-level `decision: "deny"`, not a Claude permission payload.
- `GEMINI_CLI_HOME` changes the user-home parent: the native config directory is `$GEMINI_CLI_HOME/.gemini`. `META_KIM_GEMINI_HOME` explicitly selects the config directory for projection. The older `GEMINI_HOME` alias remains only as a compatibility override; it is not the official native variable.

## Do

Load the pending artifact from the existing Meta_Kim entry. This host produces actual Critical, Fetch and Thinking material, including source references and settled decisions. Reuse `references/runtime-codex.md` only for the generic data contract and staged CLI exchange; its Codex tool names and choice UI are not Gemini tools. For the same run, retain question identifiers, revision bindings, work orders and acceptance criteria. Never manufacture answers, worker completion, transcript identity or source freshness.

Resolve actual tools from the host inventory. Common Gemini tools are `read_file`, `grep_search`, `glob`, `run_shell_command`, `write_file`, `replace`, `activate_skill`; discovered custom agents are tools named after the agent. Do not blindly copy `Agent(...)`, Claude tool allowlists or Codex collaboration calls. If a material choice needs a native question surface, use it only when actually exposed; otherwise record the supported conversation fallback and leave any native-only acceptance requirement unfulfilled.

The native hook adapter translates events into the existing governance core. Hooks cannot prove durable worker lifecycle completion. Stage-runner SDK/CLI execution remains limited to its existing separately validated runtimes; installing Gemini does not silently expand that authority.

## Do not

Do not equate projected agents, loaded rules, adapter subprocess tests or a successful settings merge with native invocation. Do not grant a child recursive orchestration, delete a shadowing user skill, copy another host's hook response schema, or install model/account configuration.

## Required packet

Reuse the existing Critical/Fetch/Thinking inputs, worker work orders and `hostInvocationRequestPacket`; retain their current task/intent/revision/inventory bindings. Installation uses the existing ownership manifest and its exact JSON-fragment journal. Neither record is a second execution authority.

## Pass

Projection passes only when the selected target's install/update/check verifies its dependency closure, native configuration shape and preserved user settings. Live verification additionally needs actual host discovery, invocation, result and fresh outcome verification for the current task.

## Fail

Fail a projection with a broken dependency closure, divergent shared skill, malformed native payload or unintended user-setting change. Fail an outcome claim without the task's acceptance evidence; report the failed boundary rather than promoting a structural pass.

## Block

Block writes when manifest ownership or the current managed-fragment value conflicts. Block a native-only task when its tool, permission or supported executor is unavailable, while retaining the pending artifact and precise missing capability.

## Return to stage

Return to Fetch for missing host inventory or contradictory native documentation; to Thinking for a changed owner, route or tool boundary; and to Critical for a changed user goal or acceptance criterion. Preserve settled answers unless the changed evidence invalidates them.

## Verification

Use the existing `meta:sync` / `meta:sync:global` target `gemini`, with `--with-global-hooks` for global hook installation. Update through the same entry and run its `--check` mode. Configuration writes preserve unrelated settings and record exact JSON fragments in the existing install manifest. Uninstall refuses to revert a managed fragment changed by the user. The uninstall CLI is not a per-runtime selector.

Start a new trusted Gemini workspace/session, inspect `/skills list`, confirm the nine governance agents and submit a small ordinary task. Record native discovery, hook execution, user decision, work result and fresh verification separately. A fixture test or generated settings file is not live verification.

## Writeback

Write installation ownership through the existing manifest, and actual work results through the bound run/checkpoint. Record `projection_implemented` and `live_verified` separately in runtime evidence; absent live observation remains unverified. Route reusable changes through the existing Evolution review.

## Preserve

Preserve the canonical responsibility/workflow source, unrelated user settings, independently edited shared skills, runtime-sedimented project capabilities and existing task identity. The shared Codex/Gemini skill and immutable execution package remain installed while another owned consumer still references them.

## Primary documentation

- https://geminicli.com/docs/cli/skills/
- https://geminicli.com/docs/core/subagents/
- https://geminicli.com/docs/cli/gemini-md/
- https://geminicli.com/docs/hooks/reference/
- https://geminicli.com/docs/tools/mcp-server/
- https://geminicli.com/docs/cli/enterprise/

Reviewed 2026-11-10; no paid host invocation was performed for this projection.
