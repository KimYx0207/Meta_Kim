# Meta_Kim for Claude Code

Meta_Kim is not a Claude-only repository.

Its purpose is to make one meta-based intent-amplification discipline hold across Claude Code, Codex, and OpenClaw, while Claude Code remains the canonical editing runtime.

## What “Meta” Means in This Repo

In Meta_Kim:

**meta = the smallest governable unit that exists to support intent amplification**

The eight meta agents are not here for visual complexity. They exist to:

- break complex work into governable units
- preserve clear boundaries between responsibilities
- keep the whole system aligned with intent amplification rather than shallow task dumping

## Public and Private Layers

The long-form local research manuscript under `docs/` is private research material and is intentionally not part of the public GitHub payload.

Claude Code should align with the project goal, but should not depend on that private manuscript.

## Desired Claude-Side Behavior

The end state in Claude Code should be:

1. the user provides raw intent
2. the system amplifies the intent first
3. specialized meta agents are invoked only when needed
4. the system returns a unified result

So in practice:

- `meta-warden` should be treated as the default front door
- the other meta agents are backstage specialists

## Canonical Claude Sources

- `.claude/agents/*.md`
  canonical definitions for the eight meta agents
- `.claude/skills/meta-theory/SKILL.md`
  canonical skill source
- `.claude/settings.json`
  Claude Code permissions and hooks
- `.mcp.json`
  project-level MCP entry for Claude Code

## The Eight Meta Agents

- `meta-warden`: coordination, arbitration, final synthesis
- `meta-genesis`: prompt identity and `SOUL.md`
- `meta-artisan`: skills, MCP, and tool-fit design
- `meta-sentinel`: safety, hooks, permissions, rollback
- `meta-librarian`: memory, knowledge continuity, context policy
- `meta-conductor`: workflow, sequencing, rhythm
- `meta-prism`: quality review and drift detection
- `meta-scout`: external capability discovery and evaluation

## Hard Rules

- `.claude/agents/*.md` must keep valid YAML frontmatter or Claude Code will not register them as project agents.
- `.claude/agents/*.md` and `.claude/skills/meta-theory/SKILL.md` are the only long-term canonical edit targets.
- `.codex/agents/*`, `.agents/skills/*`, and `openclaw/workspaces/*` are runtime mirrors and should not become the maintenance source.
- After changing prompts, skills, or runtime contracts, run:
  - `npm run sync:runtimes`
  - `npm run validate`
- To integrate your global capabilities (agents, skills, hooks, plugins, commands):
  - `npm run discover:global`
- If you need runtime-level acceptance instead of file-level validation, also run:
  - `npm run eval:agents`
- For full validation + acceptance, run:
  - `npm run verify:all`
- For a quick health check of all 8 meta agents:
  - `node scripts/agent-health-report.mjs`

## Global Capability Discovery

Meta_Kim can now discover and integrate with your globally-installed capabilities across all three runtimes:

```bash
npm run discover:global
```

This generates `.claude/capability-index/global-capabilities.json` which includes:

**Claude Code** (`~/.claude/`):
- Global agents, skills, hooks, plugins, and commands
- Numbers vary by local installation — run `npm run discover:global` to see current counts

**OpenClaw** (`~/.openclaw/`):
- Skills and workspace configurations

**Codex** (`~/.codex/`):
- Skills and custom agents

The meta-theory skill's Fetch phase automatically checks this index, allowing the meta architecture to route requests to your global capabilities when appropriate.

## One-Line Summary

Claude Code is the canonical editing runtime for Meta_Kim, not a separate product logic. Its job is to help this meta-based intent-amplification system land cleanly before the same system is projected into Codex and OpenClaw.
