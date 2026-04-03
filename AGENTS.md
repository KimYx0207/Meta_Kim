# Meta_Kim for Codex

This file explains how to read and maintain this repository inside Codex.

## Human Summary

If you only remember three things:

- Meta_Kim is one cross-runtime governance system, not three separate projects.
- `meta-warden` is the default public front door.
- Long-term edits belong in `.claude/` and `contracts/workflow-contract.json`; Codex-facing files are mostly mirrors or runtime adapters.

## Read This Repository Correctly

Do not interpret this repository as “a folder full of unrelated agent prompts”.

Interpret it as:

**one intent-amplification architecture, governed through meta units, projected into Claude Code, Codex, and OpenClaw.**

## What “Meta” Means

In Meta_Kim:

**meta = the smallest governable unit that exists to support intent amplification**

A valid meta unit should:

- own one clear class of responsibility
- define what it refuses, not only what it does
- be reviewable on its own
- be replaceable
- be safe to roll back

## What Codex Is Looking At

When this repository is opened in Codex:

- `AGENTS.md` is the project guide you are reading now
- `.codex/agents/*.toml` contains the 8 Codex custom-agent mirrors
- `.agents/skills/meta-theory/` contains the project skill mirror for Codex
- `codex/config.toml.example` shows how a user-global Codex config can wire in MCP and skills

Important maintenance rule:

- `.claude/agents/*.md` and `.claude/skills/meta-theory/SKILL.md` are the canonical sources
- `contracts/workflow-contract.json` is the canonical run-discipline and gate contract
- `.codex/agents/*` and `.agents/skills/*` are derived runtime assets unless explicitly stated otherwise

## Capability-First Rule

Meta_Kim’s orchestration model is capability-first, not name-first.

That means:

- do not hardcode “call agent X” as the primary design rule
- first describe the capability needed
- then search for who declares ownership of that capability
- then dispatch the best match

The intended pattern is:

```text
Need capability X
-> Search agents / skills / capability index
-> Match by ownership boundary
-> Dispatch the best fit
```

Hardcoding a specific agent name without a search step is a design shortcut, not the canonical method.

## Default Behavior In Codex

The intended default behavior is:

1. the user gives raw intent
2. the system clarifies the intent first
3. the system searches for existing capabilities
4. the system decides whether specialist meta agents are needed
5. the system returns one coherent result

That is why the normal public front door should be:

- `meta-warden`

The other seven meta agents are backstage specialists, not the public menu.

## Critical Rule: Orchestrate Before You Execute

For complex development work, Codex should behave as an orchestrator first.

This applies to **all meta-theory Type flows**, not just development tasks:

- **Type A (Analysis)**: meta-theory gathers information, then dispatches `meta-prism` for quality audit and `meta-warden` for synthesis
- **Type B (Agent Creation)**: meta-theory plans, then dispatches station agents (`meta-genesis`, `meta-artisan`, etc.) for design work
- **Type C (Development)**: meta-theory handles Stages 1-3, then dispatches specialists for Stages 4-8
- **Type D (Review)**: meta-theory reads the proposal, then dispatches `meta-prism` + `meta-scout` + `meta-warden` for review execution
- **Type E (Rhythm)**: meta-theory diagnoses issues, then dispatches `meta-conductor` for Card Deck design and `meta-warden` for synthesis

The core principle is: **meta-theory thinks, agents do.**

Treat these as complex tasks:

- multi-file work
- cross-module changes
- tasks requiring multiple capabilities or roles

For those tasks:

1. `Critical`: clarify the real request
2. `Fetch`: search for existing agents, skills, and tools
3. `Thinking`: define ownership, deliverables, sequencing, and boundaries
4. `Execution`: delegate using Codex-native custom agents or subagents
5. `Review`: inspect outputs against quality and boundary rules
6. `Meta-Review`: review the review standard itself if needed
7. `Verification`: confirm the change actually landed
8. `Evolution`: capture patterns and failure lessons

## The 8-Stage Spine vs. The Business Workflow Contract

Meta_Kim uses two workflow layers that should not be merged mentally.

The execution backbone is the 8-stage spine:

```text
Critical -> Fetch -> Thinking -> Execution -> Review -> Meta-Review -> Verification -> Evolution
```

The department-run contract is defined separately in `contracts/workflow-contract.json`:

```text
direction -> planning -> execution -> review -> meta_review -> revision -> verify -> summary -> feedback -> evolve
```

The relationship is:

- the 8-stage spine governs execution
- the business workflow governs run packaging, run discipline, and deliverable closure
- business phases do not replace the execution spine

## Hidden Skeleton And Gate Discipline

Under the readable workflow, Meta_Kim also relies on a hidden governance skeleton.

Typical state layers include:

- `stageState`
- `controlState`
- `gateState`
- `surfaceState`
- `capabilityState`
- `agentInvocationState`

This skeleton is not a second user interface. It exists so runs can be governed without pretending unfinished work is complete.

In particular, Codex-side summaries should respect the project’s public-display discipline. A run should not be treated as display-ready unless verification, summary closure, single-deliverable discipline, and deliverable-chain closure all hold under the workflow contract.

Main-thread responsibility in Codex:

- scope clarification
- routing and delegation
- quality gates
- final synthesis

What the main thread should not do for complex work:

- immediately start editing across many files
- collapse all roles into one undifferentiated response
- bypass delegation when the task clearly spans multiple ownership areas

### Anti-Pattern

```text
User: build a notification system
You: immediately start editing 10 files yourself
```

### Correct Pattern

```text
User: build a notification system
You:
- Critical: clarify scope
- Fetch: look for existing agents and skills
- Thinking: split ownership and define deliverables
- Execution: delegate to the right Codex-native agents/subagents
- Review: inspect outputs
- Verification: confirm the real state
- Evolution: keep the reusable pattern
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

## Canonical vs Derived Files

Preferred long-term edit targets:

- `.claude/agents/*.md`
- `.claude/skills/meta-theory/SKILL.md`
- `contracts/workflow-contract.json`
- `docs/meta.md`

Files that should usually be treated as mirrors or adapters:

- `.codex/agents/*.toml`
- `.agents/skills/meta-theory/`
- `.codex/skills/meta-theory.md`
- `shared-skills/meta-theory.md`
- `openclaw/workspaces/*`

## Recommended Maintenance Loop

After changing canonical files:

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

## One-Line Interpretation

Do not read Meta_Kim as “many agents”.

Read it as:

**a cross-runtime architecture pack for intent amplification, with Codex acting as one runtime projection of the same governance system.**
