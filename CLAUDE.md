# Meta_Kim for Claude Code

Claude Code is one runtime projection of Meta_Kim, not the canonical source layer.

## Human Summary

If you only remember three things:

- `meta-warden` is the default public front door.
- `canonical/agents/`, `canonical/skills/meta-theory/`, `config/contracts/`, and `config/capability-index/` are the long-term source of truth.
- After editing canonical files, resync and validate before trusting the result.

## Third-party meta-skills (canonical install)

Packs such as **findskill** are installed by **`node setup.mjs`** from **`KimYx0207/*`** repos declared in `setup.mjs`. These are **maintained and optimized for Meta_Kim** on top of public-ecosystem baselines.

**Install path:** install and document through **this repository** — do not parallel-install duplicate marketplace copies under different folder names unless you explicitly need both. **In this repo, call it `findskill` everywhere** (agents, skills, mirrors) so it matches `~/.claude/skills/findskill/` and `setup.mjs`.

## Read This Repository Correctly

Meta_Kim is not Claude-only logic.

It is:

**one intent-amplification system projected into Claude Code, Codex, OpenClaw, and Cursor, with `canonical/` as the neutral source layer.**

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

Claude Code is a first-class projection. Separate **what sync generates** from **what you edit long-term**:

**Generated / runtime wiring (from `canonical/` + `canonical/runtime-assets/claude/` via `npm run meta:sync`):**

- `.claude/agents/*.md`
- `.claude/skills/meta-theory/` (portable `meta-theory` + `references/`)
- `.claude/hooks/*.mjs`
- `.claude/settings.json`
- `.mcp.json`
- `.claude/capability-index/` (runtime mirror for `meta-kim-capabilities.json`; local global inventory is stored under `.meta-kim/state/{profile}/capability-index/`)

**Canonical sources you edit for behavior and contracts:**

- `canonical/agents/*.md`
- `canonical/skills/meta-theory/SKILL.md` and `canonical/skills/meta-theory/references/*.md`
- `canonical/runtime-assets/claude/*`
- `config/contracts/` (run discipline and gates; not overwritten by agent/skill sync)
- `config/capability-index/` (canonical repository capability-index source; runtime indexes mirror it)

Cursor, Codex, and OpenClaw get their own projections from the same neutral layer; see `config/sync.json` → `generatedTargets`.

## Capability-First Rule

Meta_Kim’s canonical orchestration method is capability-first, not name-first.

That means:

- do not begin from a hardcoded agent name
- define the capability needed first
- search in order: repo canonical `config/capability-index/`, runtime capability-index mirrors, local runtime inventory, then explicit fallback
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

- **Type A (Analysis)**: meta-theory gathers information (Steps 1-2), then dispatches via Fetch-first capability matching (quality audit → capability="code quality review" / synthesis → capability="coordination and synthesis")
- **Type B (Agent Creation)**: meta-theory plans (Phases 1-2), then dispatches station agents via capability matching (identity → capability="agent SOUL design" / loadout → capability="skill/tool matching") via the `Agent` tool for design work
- **Type C (Development)**: meta-theory handles Stages 1-3 (Critical/Fetch/Thinking with mandatory 3-STEP capability discovery), then dispatches specialists via capability-matched `Agent` tool for Stages 4-8
- **Type D (Review)**: meta-theory reads the proposal, then dispatches via Fetch-first capability matching (quality audit → capability="code quality review" / external claims → capability="external capability discovery" / synthesis → capability="coordination and synthesis")
- **Type E (Rhythm)**: meta-theory diagnoses issues (Steps 1-3), then dispatches via capability matching (card deck → capability="workflow sequencing and rhythm control" / synthesis → capability="coordination and synthesis")

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

## The 8-Stage Spine vs. The 11-Phase Business Workflow Contract

Meta_Kim uses two workflow layers that should not be collapsed into one.

The execution backbone is the 8-stage spine:

```text
Critical -> Fetch -> Thinking -> Execution -> Review -> Meta-Review -> Verification -> Evolution
```

The department-run contract is defined separately in `config/contracts/workflow-contract.json`:

```text
direction -> planning -> execution -> review -> meta_review -> revision -> verify -> summary -> feedback -> evolve -> mirror
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

Claude-side synthesis should also respect public-display discipline. A run is not truly display-ready just because it has content. The workflow contract now hardens this with:

- explicit `taskClassification` before execution
- explicit `cardPlanPacket` so dealing / silence / skip / interrupt decisions are auditable
- explicit `dispatchEnvelopePacket` before every non-query execution so owner, capability boundary, memory mode, and review / verification owners are fixed before work starts
- finding-level closure across `reviewPacket -> revisionResponses -> verificationResults -> closeFindings`
- explicit `summaryPacket` before any public-ready claim
- explicit `writebackDecision = writeback | none`
- local-only `compactionPacket` handoff state under `.meta-kim/state/{profile}/compaction/` when continuity has to survive a session break
- hard public-display blocking until verification, summary, and deliverable closure all pass

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

Claude Code has 10 hook scripts wired from `.claude/settings.json` (the `Stop` event runs four commands in order):

- `block-dangerous-bash.mjs`
- `pre-git-push-confirm.mjs`
- `post-format.mjs`
- `post-typecheck.mjs`
- `post-console-log-warn.mjs`
- `subagent-context.mjs`
- `stop-memory-save.mjs`
- `stop-compaction.mjs`
- `stop-console-log-audit.mjs`
- `stop-completion-guard.mjs` (optional premature-completion guard; off unless `META_KIM_STOP_COMPLETION_GUARD` is set)

These cover:

- dangerous command blocking
- git-push reminder
- formatting
- type checking
- console logging warnings
- subagent context injection
- session-end MCP Memory save
- session-end compaction packet
- session-end console audit
- optional session-end completion heuristic (`hint` or `block`)

## Canonical vs Derived Assets

Preferred long-term edit targets:

- `canonical/agents/*.md`
- `canonical/skills/meta-theory/SKILL.md`
- `canonical/skills/meta-theory/references/*.md`
- `canonical/runtime-assets/*`
- `config/contracts/`
- `config/capability-index/`

Files that should usually remain derived or runtime-specific:

- `.claude/agents/*.md`
- `.claude/skills/meta-theory/`
- `.claude/hooks/`
- `.claude/settings.json`
- `.mcp.json`
- `.claude/capability-index/`
- `.codex/agents/*.toml`
- `.agents/skills/meta-theory/`
- `.codex/skills/meta-theory/SKILL.md` and `.codex/skills/meta-theory/references/*`
- `.codex/capability-index/`
- `openclaw/skills/meta-theory/SKILL.md` and `openclaw/skills/meta-theory/references/*`
- `openclaw/workspaces/*`
- `openclaw/capability-index/`
- `.cursor/agents/*.md`
- `.cursor/skills/meta-theory/`
- `.cursor/mcp.json`
- `.cursor/capability-index/`

`npm run meta:sync` writes the **same** portable `meta-theory` skill (main file + `references/`) into `.claude/skills/meta-theory/`, `openclaw/skills/meta-theory/`, `.codex/skills/meta-theory/`, `.agents/skills/meta-theory/`, and **`.cursor/skills/meta-theory/`**. It also refreshes agents, hooks, settings, MCP templates, and the Codex `/meta-theory` command per target (including **`.cursor/agents/`** and **`.cursor/mcp.json`**). Default targets are `config/sync.json` → `supportedTargets`; machine overrides live in `.meta-kim/local.overrides.json` → `activeTargets`. If trees disagree, re-run sync from the source tree — do not hand-edit projections as independent truth.

### meta-theory reference language

- **`canonical/skills/meta-theory/SKILL.md` and `canonical/skills/meta-theory/references/*.md`**: canonical, model-facing theory and operating references.
- Runtime copies under `.claude/`, `.codex/`, `.cursor/`, and `openclaw/` are mirrors/projections; do not treat docs narrative files as theory sources.
- **Evolution writeback:** when persistence is configured, gaps and patterns may be recorded under `memory/` per canonical `meta-theory` `SKILL.md`.

## Code Knowledge Graph Support (graphify)

Meta_Kim can leverage [graphify](https://github.com/safishamsi/graphify) (`pip install graphifyy`) to generate compressed code knowledge graphs for **target projects** (not Meta_Kim itself). This provides up to 71x token compression via subgraph extraction instead of raw file reading.

### Three different things (do not confuse them)

1. **Refreshing `graphify-out/` (data)** — `python -m graphify hook install` registers **per-repo** git hooks (post-commit / post-checkout) so the graph rebuilds when you commit or checkout. `npm run meta:graphify:install` / `node setup.mjs` runs pip install + `hook install` + `graphify <platform> install` **idempotently** for all selected platforms — pip success no longer skips skill registration.
2. **Using the graph in governance (behavior)** — `canonical/skills/meta-theory/references/dev-governance.md` Fetch **Step 0.5** tells the model to check `graphify-out/graph.json` and quality gates; this is **not** a background daemon — the skill must be followed.
3. **Claude Code subagents (hint only)** — `subagent-context.mjs` injects a short rule to prefer `GRAPH_REPORT.md` then `graph.json`; it does **not** embed those files into context automatically.

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

### How It Works

1. **graphify** generates `graphify-out/graph.json` in the target project root (NetworkX node-link JSON with nodes, edges, and confidence scores)
2. Meta_Kim’s Fetch stage (Step 0.5 in `dev-governance.md`) describes auto-detection and refresh rules for the model — not an IDE-managed pipeline
3. **Claude Code** dispatched subagents get the graph **hint** via `subagent-context.mjs` (see above)
4. For complex projects (>50 graph nodes), a **project-level conductor** can be auto-created via Type B pipeline

### Auto-Trigger Conditions

Graph context is used automatically when ALL conditions are met:
- Source files > 20 (excluding node_modules/, .git/, dist/)
- Python 3.10+ installed
- graphify installed (`pip install graphifyy`)

### Installation

```bash
# Via setup.mjs (interactive — installs pip package + hook + all selected platforms' graphify skill)
node setup.mjs

# Via install-deps.sh
bash install-deps.sh

# Repo helper (pip install graphifyy + claude install + hook install for cwd)
npm run meta:graphify:install

# Manual
pip install graphifyy && python -m graphify claude install && python -m graphify hook install

# Check status
npm run meta:graphify:check
```

### Quality Gate

- AMBIGUOUS nodes > 30% → graph marked low-quality, agents use direct Read as primary
- Total nodes < 10 → graph too sparse, fall back to Glob/Grep
- God nodes (high in-degree) → flagged as serial bottlenecks for Conductor

### Working inside this repository (graphify)

This repo keeps a graph under `graphify-out/`. Before deep architecture questions, read `graphify-out/GRAPH_REPORT.md` (and prefer `graphify-out/wiki/index.md` when present). After you change code here, refresh the graph with:

```bash
python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"
```

## Required Maintenance Loop

After changing canonical prompts, skills, hooks, or runtime-facing contracts:

1. run `npm run meta:sync`
2. run `npm run discover:global`
3. run `npm run meta:validate` (or `npm run meta:check`, which runs `meta:check:runtimes` then `meta:validate`)
4. run `npm run meta:validate:run -- <artifact.json>` when you want to verify a recorded governed run
5. run `npm run meta:index:runs -- <artifact-dir-or-file>` when validated governed runs should become queryable from the local run index
6. use `npm run meta:query:runs -- --owner <agent>` when continuity should consult the local run index before memory/files
7. run `npm run meta:doctor:governance` when mirrors, hooks, local profiles, or run-index health may have drifted
8. run `npm run migrate:meta-kim -- <source-dir> --apply` when importing an older prompt pack or single-agent repo into local migration state
9. run `npm run meta:eval:agents` when smoke-level runtime acceptance matters
10. run `npm run meta:eval:agents:live` only when you explicitly need slower prompt-backed runtime acceptance
11. run `npm run meta:verify:all` before release or after larger changes
12. run `npm run meta:verify:all:live` only before runtime-sensitive releases that need the live acceptance layer
13. check `docs/runtime-capability-matrix.md` when changing behavior that must stay parity-aligned across Claude / Codex / OpenClaw / Cursor

`npm run meta:verify:all` runs, in order: `meta:check` (runtime mirror + project validate), `meta:check:global`, `eval-meta-agents --require-all-runtimes`, `meta:test:setup`, and `meta:test:meta-theory`.

Useful supporting commands:

- `npm run meta:check` — `meta:check:runtimes` + `meta:validate`
- `npm run meta:check:runtimes`
- `npm run meta:check:global` — verify user-level runtime merge targets for `meta:sync:global`
- `npm run meta:show:global:targets` — print where global sync will write
- `npm run meta:doctor:governance`
- `npm run meta:index:runs -- <artifact-dir-or-file>`
- `npm run meta:query:runs -- --owner <agent>`
- `npm run meta:rebuild:run-index -- <artifact-dir-or-file>`
- `npm run migrate:meta-kim -- <source-dir> --apply`
- `npm run meta:probe:clis`
- `npm run meta:test:mcp`
- `npm run meta:graphify:install` / `npm run meta:graphify:update` — helper wrappers around graphify setup
- `node scripts/agent-health-report.mjs`
- `npm run meta:deps:install` or `npm run meta:deps:install:all-runtimes` — install third-party skill repos into global runtime skill dirs (`all-runtimes` includes Codex/OpenClaw/Cursor where applicable; see README)
- `npm run meta:deps:update` / `npm run meta:deps:update:all-runtimes` — same with `--update`
- `npm run meta:deps:install:claude-plugins` — optional Claude Code marketplace plugins (e.g. full Superpowers bundle)
- `npm run meta:sync:global` — sync portable `meta-theory` + merge Meta_Kim hooks into user-level Claude settings
- `npm run prompt:next-iteration` — maintainer helper for structured next-step prompts after a governed run

`meta:eval:agents` is the lightweight runtime smoke layer: it checks CLI availability, runtime wiring, hooks, and registry/config scaffolding without opening live prompt sessions. Use the `:live` variants only when you actually need real Claude / Codex / OpenClaw prompt-backed acceptance.

**Tooling:** Node `>=22.13.0` (see `package.json` `engines`). CLI entry: `npx --yes github:KimYx0207/Meta_Kim meta-kim` / `bin/meta-kim.mjs`.

**Packaging & runtime notes (post-2.0.12 Unreleased):**

- `package.json` now has an explicit `files` whitelist so every `npx` tarball contains the full `canonical/` tree (older publications relied on default npm ignore rules and occasionally dropped `canonical/runtime-assets/openclaw/openclaw.template.json` / `canonical/runtime-assets/codex/config.toml.example`). If `npx` reports `[sync-runtimes] Skipping missing canonical file: …`, clear the local npx cache (`npm cache clean --force`) and re-run — the current tarball ships everything.
- All installer user-facing strings are localized through `scripts/meta-kim-i18n.mjs` (en / zh-CN / ja-JP / ko-KR). `sync-runtimes.mjs` `tryReadCanonical` warnings and `setup.mjs` `runMcpMemoryHookInstaller` progress / success / warning messages now respect `META_KIM_LANG` / `--lang`.
- `runMcpMemoryHookInstaller` uses `withProgress` + `stdio: pipe` so child-process output is captured silently and only surfaces (as dimmed `stderr`) on non-zero exit, restoring the consistent step-label UX on slow hook installs.
- MCP Memory Service default port is **8000** (upstream `MCP_HTTP_PORT=8000`). Override via `MCP_MEMORY_URL` env var or by editing `~/.claude/hooks/config.json`. Legacy installs that wrote `:8888` into `~/.claude/hooks/config.json` need a one-line edit — see `CHANGELOG.md` `Migration Notes`.
- `stop-memory-save.mjs` (Stop hook) writes session summaries to MCP Memory Service on session end, enabling cross-session continuity without manual intervention.

## Reading Notes

For human readers:

- start with `README.md` or `README.zh-CN.md`
- read this file to understand Claude Code’s role
- read `AGENTS.md` if you also care about Codex (and Cursor-oriented mirrors)
- use the repository tree section in `README.md` for the directory map
- read `.claude/skills/meta-theory/references/` only when you want the long-form theory

## One-Line Summary

Claude Code is not a separate product logic here. It is one runtime projection of the Meta_Kim governance system.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"` to keep the graph current
