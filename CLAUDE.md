# Meta_Kim for Claude Code

Claude Code is the canonical editing runtime for Meta_Kim.

## Human Summary

If you only remember three things:

- `meta-warden` is the default public front door.
- `.claude/agents/*.md`, `.claude/skills/meta-theory/SKILL.md`, and `contracts/workflow-contract.json` are the long-term source of truth.
- After editing canonical files, resync and validate before trusting the result.

## Read This Repository Correctly

Meta_Kim is not Claude-only logic.

It is:

**one intent-amplification system projected into Claude Code, Codex, and OpenClaw, with Claude Code as the canonical editing home.**

## What “Meta” Means

In Meta_Kim:

**meta = the smallest governable unit that exists to support intent amplification**

A valid meta unit must:

- own one clear responsibility class
- define its refusal boundary
- be independently reviewable
- be replaceable
- be safe to roll back

## Claude Code’s Role In The Project

Claude Code is where the main editable sources live:

- `.claude/agents/*.md`
- `.claude/skills/meta-theory/SKILL.md`
- `contracts/workflow-contract.json`
- `.claude/settings.json`
- `.mcp.json`

Those files define the canonical agent prompts, skill behavior, project hooks, permissions, and MCP entry. Other runtime assets are derived from them.

## Capability-First Rule

Meta_Kim’s canonical orchestration method is capability-first, not name-first.

That means:

- do not begin from a hardcoded agent name
- define the capability needed first
- search local agents, mirrored capabilities, and indexed/global capabilities
- dispatch the best ownership match

The intended pattern is:

```text
Need capability X
-> Search who declares ownership of X
-> Match the best fit
-> Dispatch
```

Hardcoded named dispatch without a search step is not the canonical design.

## Critical Rule: Dispatch Before You Execute

For complex development work, Claude Code should behave as the dispatcher first, not the all-in-one executor.

This applies to **all meta-theory Type flows**, not just development tasks:

- **Type A (Analysis)**: meta-theory gathers information (Steps 1-2), then dispatches `meta-prism` for quality audit and `meta-warden` for synthesis
- **Type B (Agent Creation)**: meta-theory plans (Phases 1-2), then dispatches station agents (`meta-genesis`, `meta-artisan`, etc.) via the `Agent` tool for design work
- **Type C (Development)**: meta-theory handles Stages 1-3 (Critical/Fetch/Thinking), then dispatches specialists via the `Agent` tool for Stages 4-8
- **Type D (Review)**: meta-theory reads the proposal, then dispatches `meta-prism` + `meta-scout` + `meta-warden` for review execution
- **Type E (Rhythm)**: meta-theory diagnoses issues (Steps 1-3), then dispatches `meta-conductor` for Card Deck design and `meta-warden` for synthesis

The core principle is: **meta-theory thinks, agents do.**

Treat these as complex tasks:

- multi-file work
- cross-module changes
- tasks that need multiple capabilities or ownership domains

For those tasks:

1. use the `meta-theory` skill
2. follow the 8-stage spine
3. in `Execution`, spawn sub-agents via the `Agent` tool
4. keep the main thread focused on scope, delegation, review, and synthesis

The 8-stage spine is:

1. `Critical`
2. `Fetch`
3. `Thinking`
4. `Execution`
5. `Review`
6. `Meta-Review`
7. `Verification`
8. `Evolution`

## The 8-Stage Spine vs. The Business Workflow Contract

Meta_Kim uses two workflow layers that should not be collapsed into one.

The execution backbone is the 8-stage spine:

```text
Critical -> Fetch -> Thinking -> Execution -> Review -> Meta-Review -> Verification -> Evolution
```

The department-run contract is defined separately in `contracts/workflow-contract.json`:

```text
direction -> planning -> execution -> review -> meta_review -> revision -> verify -> summary -> feedback -> evolve
```

The relationship is:

- the 8-stage spine governs execution logic
- the business workflow governs run contract, deliverable closure, and display discipline
- business phases do not rename or replace the underlying execution stages

## Hidden Skeleton And Public-Display Discipline

Under the readable stage flow, Meta_Kim also depends on a hidden governance skeleton.

Typical state layers include:

- `stageState`
- `controlState`
- `gateState`
- `surfaceState`
- `capabilityState`
- `agentInvocationState`

This skeleton is not a second front-end. It exists so the system can manage skips, interrupts, gates, verification closure, and evolution logging without inventing ad hoc rules each run.

Claude-side synthesis should also respect public-display discipline. A run is not truly display-ready just because it has content. The workflow contract expects verification closure, summary closure, single-deliverable discipline, and deliverable-chain closure before public-ready claims are valid.

### Anti-Pattern

```text
User: build a notification system
You: start editing many files directly without delegation
```

### Correct Pattern

```text
User: build a notification system
You:
- Critical: clarify scope
- Fetch: search existing capabilities
- Thinking: define ownership and deliverables
- Execution: use the `Agent` tool to dispatch the right specialists
- Review: inspect outputs
- Verification: confirm the applied state
- Evolution: capture the reusable pattern
```

## The Eight Meta Agents

- `meta-warden`: coordination, arbitration, final synthesis
- `meta-conductor`: workflow, sequencing, rhythm control
- `meta-genesis`: `SOUL.md`, persona, prompt architecture
- `meta-artisan`: skills, MCP, tool fit, capability loadout
- `meta-sentinel`: safety, permissions, hooks, rollback
- `meta-librarian`: memory, continuity, context policy
- `meta-prism`: quality review, drift detection, anti-slop review
- `meta-scout`: external capability discovery and evaluation

## Project Hooks In Claude Code

Claude Code has 7 project-level hooks configured in `.claude/settings.json`:

- `block-dangerous-bash.mjs`
- `pre-git-push-confirm.mjs`
- `post-format.mjs`
- `post-typecheck.mjs`
- `post-console-log-warn.mjs`
- `subagent-context.mjs`
- `stop-console-log-audit.mjs`

These cover:

- dangerous command blocking
- git-push reminder
- formatting
- type checking
- console logging warnings
- subagent context injection
- session-end console audit

## Canonical vs Derived Assets

Preferred long-term edit targets:

- `.claude/agents/*.md`
- `.claude/skills/meta-theory/SKILL.md`
- `contracts/workflow-contract.json`
- `docs/meta.md`

Files that should usually remain derived or runtime-specific:

- `.codex/agents/*.toml`
- `.agents/skills/meta-theory/`
- `.codex/skills/meta-theory.md`
- `shared-skills/meta-theory.md`
- `openclaw/workspaces/*`

## Required Maintenance Loop

After changing canonical prompts, skills, hooks, or runtime-facing contracts:

1. run `npm run sync:runtimes`
2. run `npm run discover:global`
3. run `npm run validate`
4. run `npm run eval:agents` when smoke-level runtime acceptance matters
5. run `npm run eval:agents:live` only when you explicitly need slower prompt-backed runtime acceptance
6. run `npm run verify:all` before release or after larger changes
7. run `npm run verify:all:live` only before runtime-sensitive releases that need the live acceptance layer

Useful supporting commands:

- `npm run check:runtimes`
- `npm run probe:clis`
- `npm run test:mcp`
- `node scripts/agent-health-report.mjs`

`eval:agents` is now the lightweight runtime smoke layer: it checks CLI availability, runtime wiring, hooks, and registry/config scaffolding without opening live prompt sessions. Use the `:live` variants only when you actually need real Claude / Codex / OpenClaw prompt-backed acceptance.

## Reading Notes

For human readers:

- start with `README.md` or `README.zh-CN.md`
- read this file to understand Claude Code’s role
- read `AGENTS.md` if you also care about Codex
- read `docs/repo-map.md` for the directory map
- read `docs/meta.md` only when you want the long-form theory

## One-Line Summary

Claude Code is not a separate product logic here. It is the canonical authoring runtime for the Meta_Kim governance system.
