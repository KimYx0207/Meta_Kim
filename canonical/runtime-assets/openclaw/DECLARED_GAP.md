# OpenClaw Declared Gap

## Purpose

This document is the canonical declaration of what Meta_Kim does **not** project into OpenClaw, and why. OpenClaw is a **declarative-only** runtime: Meta_Kim ships identity/workspace files, a template config, the `meta-kim-runtime` MCP, and one lifecycle bridge hook (`mcp-memory-service`). It does not ship the Claude/Codex/Cursor-shaped agents directory, the deny-payload PreToolUse hook surface, or the per-runtime command layer.

This gap is intentional. Treating it as a missing feature — or trying to "fix" it by copying codex/claude projections — would produce runtime shapes OpenClaw does not support and would silently degrade governance. Read this file before opening a work order that touches `openclaw/`.

## Why openclaw has no agents/ projection

OpenClaw's own model is **workspace-and-template**, not **agent-files**: each role lives in `openclaw/workspaces/<id>/` with `HEARTBEAT.md`, `SOUL.md`, and a manifest. Meta_Kim already projects that surface via `canonical/runtime-assets/openclaw/HEARTBEAT.template.md` and `canonical/runtime-assets/openclaw/openclaw.template.json` (rendered to `openclaw/openclaw.json` by `npm run meta:sync`). The agent list is the `agents.list` array inside that template.

Three reasons Meta_Kim does not project a Claude-shaped `openclaw/agents/*.md` tree:

1. **Governance shape mismatch.** Meta_Kim's `meta-*` owners are nine durable governance files in `canonical/agents/`. OpenClaw does not consume Markdown-with-YAML agents; it consumes a JSON `agents.list` plus per-workspace `SOUL.md` / `HEARTBEAT.md`. Forcing a `.md` mirror would require either a translation layer or duplicate governance that can drift.
2. **Bootstrap order.** OpenClaw loads `openclaw/openclaw.json` first and resolves workspaces from there. A parallel `openclaw/agents/` tree would either be ignored (false completeness) or shadow the JSON source (two truths). Sync projects choose JSON as the single source.
3. **OpenClaw's declarative-only model.** Hard refusal and execution gating in OpenClaw live in workspace `HEARTBEAT.md` and `SOUL.md` (`executionBlock=true`) and in typed plugin hooks. There is no PreToolUse deny payload surface. A "mirror the Claude hook tree here" change would not deny anything — it would just create inert files.

## Why openclaw has no hooks/ projection (except mcp-memory-service)

The only Meta_Kim hook shipped into OpenClaw is `canonical/runtime-assets/openclaw/hooks/mcp-memory-service/` — a lifecycle bridge that records `command:new`, `command:reset`, `command:stop`, `session:compact:after` to the MCP Memory Service HTTP API. It complements, and never replaces, OpenClaw's internal `session-memory` store.

Meta_Kim does **not** ship `enforce-agent-dispatch.mjs` to OpenClaw for four reasons:

1. **No tool-deny payload surface in OpenClaw's current plugin model.** A PreToolUse hook that returns `permissionDecision: "deny"` is a Claude/Codex/Cursor concept. OpenClaw's typed plugin hooks block by raising or by short-circuiting the policy graph, not by emitting the harness-specific deny payload.
2. **Capability-gate policy is declarative in OpenClaw.** `executionBlock=true` plus refusal prose is policy and refusal guidance, not a mechanical tool-call security boundary. Adding a script that calls `process.exit(2)` on every `Agent` dispatch would not create a valid typed-plugin adapter and could fight OpenClaw's own policy graph.
3. **No Bash/Edit matcher registry.** Claude's `enforce-agent-dispatch.mjs` keys off `Bash|apply_patch|Edit|Write|MultiEdit|...`. OpenClaw's typed plugin hooks fire on `command:*` / `session:*` / `tool:*` events with different semantics; copying the matcher would create false negatives.
4. **Trust review cost.** `AGENTS.md` flags OpenClaw skills/hooks as needing third-party risk and sandbox review. Projecting our Claude hook tree without that review would skip a declared gate.

If a future typed plugin enforcement adapter is built, this section is where the design contract lives; do not silently re-enable by deleting this paragraph.

## Capability Boundary Table

| Surface | Claude Code | Codex | OpenClaw | Cursor |
|---|---|---|---|---|
| `agents/` projection | `.claude/agents/*.md` | `.codex/agents/*.toml` | declared-only (workspaces + JSON `agents.list`) | `.cursor/agents/*.md` |
| `hooks/` projection (gate) | `enforce-agent-dispatch.mjs` deny payload | same script projected | **none** (declarative `executionBlock`) | typed hook surface (`failClosed: true`) |
| `hooks/` projection (bridge) | stop / post-format / etc. | mirrors of selected hooks | `mcp-memory-service` only | mirrors of selected hooks |
| `commands/` projection | `.claude/commands/*.md` | Codex native commands | **none** (typed plugin commands only) | Cursor commands + rules |
| `skills/` projection | `.claude/skills/meta-theory/` | `.codex/skills/` | `openclaw/skills/` (extraDirs) | `.cursor/skills/meta-theory/` |
| Capability gate | `META_KIM_CAPABILITY_GATE` PreToolUse | same script, runtime-version dependent | declarative prose + `executionBlock` | `preToolUse` with `failClosed: true` |
| Per-tool deny schema | `{hookSpecificOutput.permissionDecision}` | stdout JSON | typed-plugin raise / abort | exit 2 + JSON `{permission:"deny"}` |

`declared-only` means Meta_Kim ships the template that drives OpenClaw but does not ship per-agent mirror files. `none` means no Meta_Kim hook is installed and enforcement is left to OpenClaw's own mechanism (declarative or native).

## User expectations

A user should expect OpenClaw to provide:

- the nine `meta-*` governance workspaces, hydrated from `canonical/runtime-agents/openclaw/HEARTBEAT.template.md` and `openclaw.template.json`
- the `meta-kim-runtime` MCP server and its `dispatch_meta_agent` / `list_meta_agents` tools
- the `mcp-memory-service` lifecycle bridge so MCP Memory Service sees OpenClaw checkpoints
- declarative capability-gate enforcement via workspace `HEARTBEAT.md` / `SOUL.md`

A user should **not** expect OpenClaw to provide:

- a `openclaw/agents/*.md` directory mirrored from `canonical/agents/`
- a Claude-shaped `enforce-agent-dispatch.mjs` running on every `Agent` call
- a Bash/Edit `matcher` registry that blocks Edit/Write before they happen
- the same deny-payload schema Claude Code uses
- project-level commands at `openclaw/commands/*.md`

If you find yourself opening an issue that says "OpenClaw is missing X" and X is on the second list, the gap is by design — fix the expectation, not the runtime.

## See also

- `AGENTS.md` § Mechanical Enforcement → `OpenClaw` bullet (the line this document cross-references from)
- `AGENTS.md` § Runtime Tree Map for the four-runtime projection layout
- `canonical/skills/meta-theory/references/global-owner-discovery.md` for the global-first discovery contract that all four runtimes share
- `canonical/runtime-assets/openclaw/HEARTBEAT.template.md` and `openclaw.template.json` for the surfaces that *are* projected
- `canonical/runtime-assets/openclaw/hooks/mcp-memory-service/HOOK.md` for the one bridge hook and its lifecycle contract
