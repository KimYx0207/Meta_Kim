# Meta_Kim for Codex

This file explains how to read and maintain this repository inside Codex.

## Human Summary

If you only remember four things:

- Meta_Kim is one cross-runtime governance system, not a pile of unrelated prompt folders (Claude Code, Codex, OpenClaw, and Cursor are projections of the same layer).
- `meta-warden` is the default public front door.
- `meta-conductor` orchestrates rhythm; the execution stack is grounded in `meta-genesis`, `meta-artisan`, `meta-scout`, `meta-sentinel`, and `meta-librarian` (capability-first dispatch still beats hardcoded names).
- Long-term edits belong in `canonical/` and `config/contracts/workflow-contract.json`; runtime-facing trees under `.codex/`, `.agents/`, `.claude/`, `openclaw/`, and `.cursor/` are generated or mirrored — sync instead of hand-forking.

## Read This Repository Correctly

Do not interpret this repository as “a folder full of unrelated agent prompts”.

Interpret it as:

**one intent-amplification architecture, governed through meta units, projected into Claude Code, Codex, OpenClaw, and Cursor.**

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
- `.agents/skills/meta-theory/` is the project skill mirror (directory layout); `.codex/skills/` may hold the portable skill surface depending on sync scope
- `codex/config.toml.example` is generated from `canonical/runtime-assets/codex/config.toml.example` and shows how user-global Codex can wire MCP and skills

**Cursor parity (same repo, fourth runtime):** `.cursor/agents/*.md`, `.cursor/skills/meta-theory/`, `.cursor/mcp.json` — all refreshed by `npm run sync:runtimes` per `config/sync.json`.

Important maintenance rule:

- `canonical/agents/*.md` and `canonical/skills/meta-theory/SKILL.md` are the canonical sources
- `config/contracts/workflow-contract.json` is the canonical run-discipline and gate contract (not overwritten by agent/skill sync)
- `.codex/agents/*`, `.codex/skills/*`, `.agents/skills/*`, and Cursor/OpenClaw projection trees are derived runtime assets unless explicitly stated otherwise

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

The department-run contract is defined separately in `config/contracts/workflow-contract.json`:

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

The current hardening layer now expects:

- `taskClassification` before execution (`taskClass + requestClass + governanceFlow + trigger/upgrade/bypass reasons`)
- `cardPlanPacket` before execution (`dealerOwner + cards + silenceDecision + controlDecisions + deliveryShells`)
- `dispatchEnvelopePacket` before every non-query execution (`ownerAgent + taskRef + allowed/blocked capabilities + memoryMode + reviewOwner + verificationOwner`)
- finding-level closure (`reviewPacket.findings -> revisionResponses -> verificationResults -> closeFindings`)
- explicit `summaryPacket` before any public-ready claim
- explicit evolution decision (`writebackDecision = writeback | none`)
- local-only `compactionPacket` handoff state under `.meta-kim/state/{profile}/compaction/` when continuity is needed between sessions
- no final public-ready claim before the public-display gate passes

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

- `canonical/agents/*.md`
- `canonical/skills/meta-theory/SKILL.md`
- `canonical/skills/meta-theory/references/*.md`
- `canonical/runtime-assets/*`
- `config/contracts/workflow-contract.json`

Files that should usually be treated as mirrors or adapters:

- `.claude/agents/*.md`
- `.claude/skills/meta-theory/`
- `.claude/hooks/`
- `.claude/settings.json`
- `.mcp.json`
- `.claude/capability-index/` (including `meta-kim-capabilities.json` and `global-capabilities.json` from `discover:global`)
- `.codex/agents/*.toml`
- `.codex/skills/` (e.g. `meta-theory.md` and `references/` when present)
- `.agents/skills/meta-theory/`
- `.cursor/agents/*.md`
- `.cursor/skills/meta-theory/`
- `.cursor/mcp.json`
- `openclaw/skills/` and `openclaw/workspaces/*`
- `openclaw/openclaw.template.json` (from `canonical/runtime-assets/openclaw/`)

## Code graph (`graphify-out/`) — Platform Automation

Cross-runtime parity for **how to use** a graph is the synced **meta-theory** reference `canonical/skills/meta-theory/references/dev-governance.md` (Fetch **Step 0.5**). There is **no** `SubagentStart` hook in the Codex / OpenClaw / Cursor projections (only `.claude/hooks/` carries `subagent-context.mjs`).

### Platform Automation Comparison

| Capability | Claude Code | Codex | OpenClaw | Cursor |
|-----------|------------|-------|----------|--------|
| PreToolUse hook (auto-prompt before Glob/Grep) | ✅ settings.json | ❌ | ❌ | ❌ |
| Slash command `/graphify` | ✅ | ✅ | ✅ | ✅ |
| git hook auto-rebuild (post-commit/checkout) | ✅ | ✅ | ✅ | ✅ |
| AGENTS.md resident rules | N/A | ✅ | ✅ | ✅ |
| Multi-platform install via setup.mjs | ✅ claude | ✅ codex | ✅ claw | ✅ cursor |

**Key insight**: Claude Code is the only platform with a **PreToolUse hook** that auto-prompts before searches. Other platforms (Codex, OpenClaw, Cursor) use **AGENTS.md** rules injected at startup — graph awareness is still present but triggers at session start rather than per-search. Both mechanisms are automatic once installed.

For multi-platform setups, run `node setup.mjs` — it loops through all selected platforms and runs `graphify <platform> install` for each one idempotently.

**When `graphify-out/graph.json` exists in the repo root** (this repo or a target project): for complex or multi-file work, follow Fetch Step 0.5 and **prefer reading `graphify-out/GRAPH_REPORT.md` first** when present, then `graph.json` or subgraph queries as needed.

**Refreshing the graph**: per-repo git hooks from `python -m graphify hook install` (also run from `node setup.mjs` optional Python step and `npm run graphify:install`). Optional: in a **non–Meta_Kim target repo**, `python -m graphify codex install` or `python -m graphify claw install` can add graphify sections per upstream graphify CLI — do not run those blindly on Meta_Kim’s canonical `AGENTS.md` without reviewing merge impact.

## Recommended Maintenance Loop

After changing canonical files:

1. run `npm run sync:runtimes`
2. run `npm run discover:global`
3. run `npm run validate` (or `npm run check` = `check:runtimes` + `validate`)
4. run `npm run validate:run -- <artifact.json>` when you want to verify a recorded governed run
5. run `npm run index:runs -- <artifact-dir-or-file>` when you want validated governed runs queryable from the local run index
6. use `npm run query:runs -- --owner <agent>` when continuity or retrieval should consult the local run index first
7. run `npm run doctor:governance` when mirrors, hooks, local profiles, or run-index health might have drifted
8. run `npm run migrate:meta-kim -- <source-dir> --apply` when importing an older prompt pack or single-agent repo into local migration state
9. run `npm run eval:agents` when smoke-level runtime acceptance matters
10. run `npm run eval:agents:live` only when you explicitly need slower prompt-backed runtime acceptance
11. run `npm run verify:all` before release or after larger changes
12. run `npm run verify:all:live` only before runtime-sensitive releases that need the live acceptance layer
13. read `docs/runtime-capability-matrix.md` whenever you touch trigger, card, silence, shell, review, verification, stop, or writeback behavior across runtimes

`npm run verify:all` runs `check`, `check:global:meta-theory`, `eval:agents --require-all-runtimes`, `test:setup`, and `test:meta-theory`.

Runtime target selection has two layers:

- `config/sync.json` declares repo-level `supportedTargets` and `defaultTargets`
- `.meta-kim/local.overrides.json` stores machine-level `activeTargets`
- `setup.mjs`, `sync:global:meta-theory`, and `deps:install:all-runtimes` act on `activeTargets`
- `sync:runtimes` acts on repo `supportedTargets` unless `--targets` overrides it

Useful supporting commands:

- `npm run check`
- `npm run check:runtimes`
- `npm run check:global:meta-theory`
- `npm run show:global:meta-theory-targets`
- `npm run doctor:governance`
- `npm run index:runs -- <artifact-dir-or-file>`
- `npm run query:runs -- --owner <agent>`
- `npm run rebuild:run-index -- <artifact-dir-or-file>`
- `npm run migrate:meta-kim -- <source-dir> --apply`
- `npm run probe:clis`
- `npm run test:mcp`
- `npm run graphify:check` (optional; target projects and this repo’s `graphify-out/` workflow)
- `node scripts/agent-health-report.mjs`
- `npm run deps:install` / `npm run deps:install:all-runtimes` and `npm run deps:update` / `npm run deps:update:all-runtimes`
- `npm run deps:install:claude-plugins`
- `npm run sync:global:meta-theory`
- `npm run prompt:next-iteration`

`eval:agents` is the lightweight runtime smoke layer: it checks CLI availability, runtime wiring, hooks, and registry/config scaffolding without opening live prompt sessions. Use the `:live` variants only when you actually need real Claude / Codex / OpenClaw prompt-backed acceptance.

**Tooling:** Node `>=22.13.0` (see `package.json` `engines`).

## Reading Notes

- Start with `README.md` / `README.zh-CN.md`, then this file; use `CLAUDE.md` for Claude-specific hooks and projection detail.
- For cross-runtime behavior parity, keep `docs/runtime-capability-matrix.md` open when changing gates, cards, or writeback.

## One-Line Interpretation

Do not read Meta_Kim as “many agents”.

Read it as:

**a cross-runtime architecture pack for intent amplification, with Codex (and the other runtimes) acting as projections of the same governance system.**

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"` to keep the graph current
