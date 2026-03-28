# Meta_Kim Repository Guide

This is not a repository for casually collecting agent prompts.

The goal is to make one meta-based intent-amplification system land consistently across Codex, Claude Code, and OpenClaw.

## Start with “Meta”

In this project:

**meta = the smallest governable unit that exists to support intent amplification**

A valid meta unit should:

- own one clear class of responsibility
- have explicit boundaries against other meta units
- be orchestratable rather than free-floating
- be independently reviewable
- be replaceable or rolled back when it fails

## What This Means for Codex

If you open this repository in Codex, read it as:

- `AGENTS.md` explains what the project is trying to achieve
- `.codex/agents/` maps the eight meta roles into Codex-native custom agents
- `.agents/skills/` provides the project skill mirror

Codex should not just see “many files”.

It should understand:

**this repository is a cross-runtime intent-amplification system.**

## Default Working Model

Users should not need to think in terms of eight specialist agents.

The intended default behavior is:

1. the user gives raw intent
2. the system amplifies the intent first
3. the system decides whether specialist meta agents are needed
4. the system returns a single coherent result

So the external front door should normally be:

- `meta-warden`

The others are backstage specialists, not the public menu.

## The Eight Meta Agents

- `meta-warden`: coordination, arbitration, final synthesis
- `meta-genesis`: prompt identity and `SOUL.md`
- `meta-artisan`: skills, MCP, and tool mapping
- `meta-sentinel`: safety, hooks, permissions, rollback
- `meta-librarian`: memory, knowledge continuity, context policy
- `meta-conductor`: workflow, sequencing, rhythm
- `meta-prism`: quality review and drift detection
- `meta-scout`: external capability discovery and evaluation

## Canonical vs Derived Assets

Preferred edit targets:

- `.claude/agents/*.md`
- `.claude/skills/meta-theory/SKILL.md`

Do not treat these as the long-term maintenance source:

- `.codex/agents`
- `.agents/skills`
- `openclaw/workspaces`

Those are runtime mirrors maintained by sync tooling.

## Working Loop

After changing canonical source files:

1. run `npm run sync:runtimes`
2. run `npm run discover:global` (required on first setup, re-run after installing new global capabilities)
3. run `npm run validate`
4. run `npm run eval:agents` when you need runtime-level acceptance
5. run `npm run verify:all` for full validation + acceptance pass

### Global Capability Discovery

Meta_Kim now supports discovering global capabilities across all three runtimes:

```bash
npm run discover:global
```

This scans:
- `~/.claude/` — agents, skills, hooks, plugins, commands
- `~/.openclaw/` — agents, skills, hooks, commands
- `~/.codex/` — agents, skills, commands

And generates `.claude/capability-index/global-capabilities.json` for use by the meta-theory skill's Fetch phase. This file is gitignored — it contains local absolute paths and is regenerated on each machine.

This allows the meta architecture to see and integrate with your globally-installed capabilities, not just the project's 8 meta agents.

## Most Important Instruction

Do not interpret this repository as a showroom for “many agents”.

Interpret it as:

**an architecture pack centered on intent amplification, governed through meta units, and projected consistently across multiple runtimes.**
