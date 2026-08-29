# Meta_Kim for Claude Code

Claude Code is one runtime projection of Meta_Kim. It is important, but it is not the canonical source layer by itself.

## Fast Read

If you only keep six rules in mind:

- `meta-warden` is the public front door; the other meta agents are backstage specialists.
- `canonical/agents/`, `canonical/skills/meta-theory/`, `canonical/runtime-assets/`, `config/contracts/`, and `config/capability-index/` are the durable sources of truth.
- `.claude/` is a runtime projection generated from canonical assets. It is gitignored — run `npm run meta:sync` after clone to generate hooks/agents/skills locally. Sync it instead of hand-forking it.
- When `meta-theory` is active, the main Claude thread dispatches; it does not execute complex work directly.
- Critical, Fetch, Thinking, and Review must make the run executable before mutation; hooks are final safeguards, not the primary design path.
- Capability-first dispatch is **mechanically enforced** in Claude Code via the `enforce-agent-dispatch.mjs` PreToolUse hook (deny payload). Codex and Cursor v1.7+ use the same projected hook; OpenClaw remains declarative. The current matrix lives in `AGENTS.md` under Mechanical Enforcement.
- User-visible run-scoped worker labels may be coarse English role-family names such as `frontend`, `backend`, or `test`, but Meta_Kim does not project those execution labels as durable agents. Durable governance files stay with the nine `meta-*` owners.

## What This Repository Is

Meta_Kim is not Claude-only logic.

It is:

**a cross-runtime intent-amplification system projected into Claude Code, Codex, OpenClaw, and Cursor, with `canonical/` as the neutral source layer.**

In Meta_Kim, `meta` means the smallest governable unit that supports intent amplification. A valid meta unit:

- owns one responsibility class
- defines its refusal boundary
- can be reviewed independently
- can be replaced or rolled back
- does not silently absorb unrelated work

## Claude Code's Role

Claude Code is the most hook-rich runtime projection. It contributes:

- project entry rules through `CLAUDE.md`
- custom-agent mirrors under `.claude/agents/`
- the portable `meta-theory` skill under `.claude/skills/meta-theory/`
- hook enforcement under `.claude/hooks/`
- MCP wiring through `.mcp.json`
- capability-index mirrors under `.claude/capability-index/`

Claude-specific details matter, but they should still be derived from the shared architecture whenever possible.

## Canonical Vs Runtime Files

Edit these for long-term behavior:

- `canonical/agents/*.md`
- `canonical/skills/meta-theory/SKILL.md`
- `canonical/skills/meta-theory/references/*.md`
- `canonical/runtime-assets/claude/*`
- `canonical/runtime-assets/shared/*`
- `config/contracts/`
- `config/capability-index/`

Treat these as generated or runtime-local unless the task explicitly targets Claude wiring:

- `.claude/agents/*.md`
- `.claude/skills/meta-theory/`
- `.claude/hooks/*.mjs`
- `.claude/settings.json`
- `.mcp.json`
- `.claude/capability-index/`

Other runtime mirrors are also projections of the same canonical layer:

- `.codex/`
- `.cursor/`
- `openclaw/`

When trees disagree, update the canonical source and run sync. Do not maintain parallel prompt forks.

## Install Scope And Runtime Sedimentation

Install scope and governed runtime sedimentation are separate contracts:

- `setup.mjs` install/update offers an interactive `global` or `project` choice and accepts `--scope global|project` for non-interactive use. In `global_only`, install sync keeps only the dependency-closed Claude/Codex/Cursor project Hook entry package and does not materialize durable project agents, skills, commands, capability indexes, MCP entries, Codex config examples, or OpenClaw project projections.
- Distribution scope does not erase existing project topology. A normal `global` install/update automatically refreshes only current, explicit, or saved directories with a valid project-bootstrap manifest, using the configured project merge/delta strategy. No valid project state means no project copy and no extra confirmation. Cleanup is a separate explicit operation and never runs as a normal global install/update side effect.
- Under `project_bootstrap_merge_delta`, bootstrap-manifest-owned generated projections are backed up inside the transaction and replaced with the current package version; shared JSON and managed text blocks merge instead. Unknown user files and `runtime_sedimented_project_copy` capabilities are outside that replacement boundary and remain preserved.
- If a governed run proves a current-project Agent, Skill, or Command must be created or iterated, write or copy it into the runtime-native project directory. Record that asset as `runtime_sedimented_project_copy`; later global dependency or install projection updates must preserve it.
- A global search hit that already fits and needs no iteration stays global: use `use_global_directly` and do not copy it into the project. Only project-specific iteration uses `copy_to_project_for_modification`; a real project gap uses `create_project_local_capability`.

The install manifest records install-generated files as `install_projection`, retains records for runtimes not selected during the current update, and stores exact hash plus size. The separate `.meta-kim/state/default/project-capabilities.json` manifest owns `runtime_sedimented_project_copy` / `preserve_project_copy` Agent, Skill, and Command paths. Project bootstrap plan, write, stale cleanup, and explicit cleanup all read that ownership before mutation. Unknown and runtime-sedimented files are preserved; drift in bootstrap-manifest-owned generated projections follows the configured merge/delta replacement-and-backup policy. Manifest recording or flush failure cannot be presented as successful install/update.

Treat canonical source, install projection, runtime-sedimented project copies, and local/user configuration as different ownership classes. For merged configuration, remove only Meta_Kim-owned fragments; never infer whole-file ownership from its location.

Install/update release claims require real packed-product evidence: pack the npm artifact, install that artifact into an isolated location, then run the packed CLI install and update paths. Repository-source execution alone is not packed CLI truth.

Do not use arbitrary line counts as architecture gates. Verify CLI entrypoint responsibility, dependency direction, module boundaries, and behavior. `setup.mjs` remains a façade; new domain behavior belongs in focused modules with focused tests.

## Meta-Theory Dispatch Is Mandatory

When `meta-theory` is activated by `/meta-theory`, skill auto-detection, or an equivalent trigger, the 8-stage spine is mandatory.

The main Claude thread is the dispatcher:

- it scopes the request
- it performs capability discovery
- it maps lanes, owners, dependencies, and merge strategy
- it dispatches execution with the `Agent` tool
- it reviews, verifies, and synthesizes

The main thread is not the all-in-one executor for complex work.

Hard rules:

1. Analysis, code changes, design work, review, and verification should be owned by dispatched agents when the task is non-trivial.
2. Critical locks the actual user outcome, value, success criteria, scope, permissions, and non-goals before the route expands.
3. Fetch gathers evidence and capability facts that change route, risk, owner, scope, acceptance, or verification.
4. Thinking chooses owners, lanes, dependencies, work orders, review owner, verification owner, and rollback path before mutation.
5. Review checks Critical, Fetch, and Thinking readiness before output polish; it is not a late rescue stage for missing design.
6. The PreToolUse hook `enforce-agent-dispatch.mjs` can block execution tools when spine state is active and no agent has been dispatched.
7. If a hook blocks you, follow the dispatch protocol and return to the responsible stage. Do not work around it.
8. A "simple task" is not an excuse to bypass governance when the task touches multiple files, multiple capabilities, or cross-runtime behavior.

## Dispatch Flow

For governed work, Claude Code should follow:

```text
Critical -> Fetch -> Thinking -> Execution -> Review -> Meta-Review -> Verification -> Evolution
```

Practical meaning:

1. `Critical`: clarify the actual request and blockers.
2. `Fetch`: discover existing agents, skills, MCP tools, commands, memory, and graph context.
3. `Thinking`: map business lanes, owners, dependencies, parallel groups, merge owner, review owner, and verification owner.
4. `Execution`: dispatch bounded work through `Agent`.
5. `Review`: inspect outputs against quality and boundary rules.
6. `Meta-Review`: check whether the review standard itself was adequate when risk is high.
7. `Verification`: run fresh checks against the final state.
8. `Evolution`: write back reusable patterns through Warden-gated evolution, or explicitly choose no writeback.

## Capability-First Rule

Do not start by hardcoding an agent name. Start by defining the needed capability.

Use this search order:

```text
Need capability
-> Search config/capability-index/
-> Search runtime capability-index mirrors
-> Search local runtime inventory
-> Search available skills, MCP tools, commands, and graph context
-> Choose best owner by boundary fit
-> Dispatch with explicit scope and verification evidence
```

Named dispatch without a discovery step is a design shortcut, not the canonical method.

### Mechanical Enforcement

Capability-first is no longer only a prompt-level discipline. In Claude Code it is enforced by the PreToolUse hook `enforce-agent-dispatch.mjs` (canonical source: `canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs`).

Behavior:

- **Active stages**: `execution`, `review`, `meta_review`, `verification`, `evolution`. The hook denies any `Agent` dispatch in these stages unless `fetchRecord.capabilitySearchPerformed === true` is present in spine state.
- **Exempt stages**: `critical`, `fetch`, `thinking`. Discovery happens here, so the gate does not fire.
- **Override env var**: `META_KIM_CAPABILITY_GATE`. Values: `progressive`, `block`, `warn` (stderr warning only), `off` (gate disabled). Default: `progressive` (warn for the grace window, then block); `block` restores immediate deny. Use `warn` or `off` only for debugging — production runs should keep `progressive` (or `block` for strict environments).
- **Other env vars**: `META_KIM_HOOK_RUNTIME` (one of `claude` / `codex` / `cursor`) selects the deny payload schema when the same hook is projected to a different runtime.

The same hook script is now projected to Codex (`.codex/hooks/`) and Cursor v1.7+ (`.cursor/hooks/`) via `sync-runtimes.mjs`. `AGENTS.md` is the current source for the four-runtime mechanical-deny matrix and OpenClaw's declarative-only gap.

Hook enforcement is a final safety boundary after Critical, Fetch, Thinking, and Review have done their work. Repeated hook blocks mean the upstream design or packet state is incomplete; return to the earliest broken stage instead of retrying the same action.

## Business Flow Before Execution

Before execution, create a business-flow blueprint for executable work. For a web product, for example, the blueprint may include:

- product direction
- UX flow
- UI system
- frontend
- backend
- database
- auth / security
- motion / interaction polish
- tests / QA
- release / install path
- feedback and evolution

The blueprint does not need every lane for every task, but omissions should be deliberate. It should state:

- what capability is required
- which existing agent / skill / tool was found
- whether the owner is reused, upgraded, or newly created
- what can run in parallel
- who owns merge and conflict resolution
- what evidence will prove the result is done

## Agent Display Names

Keep three names separate:

- `ownerAgent`: real governance or execution owner, for example `meta-conductor` or `frontend-developer`
- `roleDisplayName`: short user-visible English business role family, for example `frontend`, `backend`, or `test`
- `runtimeInstanceAlias`: incidental runtime nickname, if Claude or another host assigns one

Rules:

- `roleDisplayName` is a run-scoped task-packet label, not a durable agent identity and not a projection file.
- Cross-runtime handoffs use one `ownerBindingMode`: Codex may use `native_custom_agent` only for a validated Codex TOML owner selected through a schema-confirmed `agent_type`; otherwise it uses `run_scoped_owner_contract`. A runtime alias or task label never substitutes for `ownerAgent`.
- User-visible status keeps Agent, Skill, Command, MCP, runtime-tool, and Hook provider/source, selected state, actual state, and next action; it does not reduce the handoff to an Agent-only sentence.
- Do not expose random personal nicknames as the primary agent name.
- Prefer short role names over long task sentences.
- Do not put concrete work items into `roleDisplayName`; when the same role has parallel shards, keep the same coarse role name and put shard scope in `roleInstanceId` / `shardScope`.
- If one owner runs multiple parallel instances, record shard boundaries, dependencies, `parallelGroup`, `mergeOwner`, and collision rules.

## The Business Workflow Contract

The 8-stage spine is not the same thing as the department workflow contract.

The department workflow is:

```text
direction -> planning -> execution -> review -> meta_review -> revision -> verify -> summary -> feedback -> evolve -> mirror
```

Use the spine to govern execution. Use the department workflow to package the run, close deliverables, and decide whether a result is display-ready.

Do not claim public-ready status until all of these are true:

- verification passed
- summary is closed
- a single primary deliverable was maintained
- the deliverable chain is closed
- consolidated deliverable evidence exists

## Hidden Governance Packets

A governed run should leave audit-ready structure. Important packets include:

- `taskClassification`
- `cardPlanPacket`
- `businessFlowBlueprintPacket`
- `agentBlueprintPacket`
- `dispatchEnvelopePacket`
- `workerTaskPacket`
- `reviewPacket`
- `revisionResponses`
- `verificationResults`
- `summaryPacket`
- `evolutionWritebackPacket`

These packets are not UI decoration. They are how the system avoids pretending unfinished work is complete.

## Planning Files

When the task is not a pure query, use Meta_Kim's first-party `planning-continuity` runtime to create or resume persistent planning state during Thinking:

- `task_plan.md`
- `findings.md`
- `progress.md`

These files supplement protocol packets. They do not replace dispatch envelopes, review findings, or verification evidence.

## The Nine Meta Agents

- `meta-warden`: coordination, arbitration, final synthesis, Warden gate
- `meta-conductor`: workflow, stage sequencing, business-flow blueprint, rhythm control
- `meta-genesis`: `SOUL.md`, identity, persona, prompt architecture
- `meta-artisan`: skill / MCP / tool fit, capability loadout
- `meta-sentinel`: safety boundaries, permissions, hooks, rollback
- `meta-librarian`: memory, continuity, context policy
- `meta-prism`: quality review, drift detection, anti-slop review
- `meta-scout`: external capability discovery and evaluation
- `meta-chrysalis`: evolution signal aggregation and writeback coordination through Warden's gate

Meta agents govern. They do not become generic implementation workers when a better execution specialist exists.

## Claude Code Hooks

Claude Code has project hooks generated from canonical runtime assets. The expected hook commands are:

- `node .claude/hooks/graphify-context.mjs`
- `node .claude/hooks/enforce-agent-dispatch.mjs`
- `node .claude/hooks/activate-meta-theory-spine.mjs`
- `node .claude/hooks/post-format.mjs`
- `node .claude/hooks/post-typecheck.mjs`
- `node .claude/hooks/post-console-log-warn.mjs`
- `node .claude/hooks/subagent-context.mjs`
- `node .claude/hooks/stop-compaction.mjs`
- `node .claude/hooks/stop-console-log-audit.mjs`
- `node .claude/hooks/stop-completion-guard.mjs`
- `node .claude/hooks/stop-spine-cleanup.mjs`

They cover:

- meta-theory spine activation
- graph/context preload
- capability-first dispatch enforcement and dangerous command blocking
- formatting and typecheck follow-ups
- console logging warnings
- subagent graph/context hints
- session-end compaction
- session-end console audit
- optional premature-completion guard
- spine-state cleanup

Shared hook dependencies such as `project-root.mjs`, `bash-readonly-whitelist.mjs`, `spine-state.mjs`, `hook-i18n.mjs`, `skip-reminder.mjs`, and `utils.mjs` are copied as support files. They are not direct `.claude/settings.json` hook commands. `activate-meta-theory-spine.mjs` and `project-root.mjs` are one runtime dependency set and must always be projected together.

The activation hook never treats a bare cwd as a project. It prefers a valid `CLAUDE_PROJECT_DIR`, then walks up from cwd for `.git` or `.meta-kim/state/default/project-bootstrap.json`, and only uses an absolute marker-backed runtime payload root when cwd is not already a recognized project. The resolved root is passed explicitly to post-copy; if no legitimate root exists, both spine-state and post-copy projection skip without writing.

Hook behavior differs across runtimes. Do not assume Claude's `SubagentStart`-style behavior exists in Codex, OpenClaw, or Cursor unless the runtime adapter explicitly verifies it.

## Third-Party Meta Skills

Packs such as `findskill`, `gstack`, `superpowers`, and `cli-anything` remain installable through `node setup.mjs` and supporting dependency commands. The absorbed `planning-with-files` dependency is retired from install and execution routes; normal planning continuity is provided only by Meta_Kim's first-party runtime.

Repository policy:

- document canonical installs through this repo
- avoid duplicate marketplace copies under different names unless explicitly required
- use stable names consistently across agents, skills, mirrors, and setup scripts
- prefer capability discovery over hardcoded skill assumptions

## Graphify

This repo keeps a knowledge graph under `graphify-out/`.

Use it as a query-first navigation index, not as compressed context or an infallible truth source:

- for focused questions, start with `graphify query "<question>" --budget 1000`, `graphify path`, or `graphify explain`
- for broad architecture review, use `graphify-out/GRAPH_REPORT.md` only as orientation
- if `graphify-out/wiki/index.md` exists, use it for broad navigation
- treat graph results as candidate file anchors, then verify route-changing claims against source files
- treat ambiguous graph nodes as uncertain dependencies requiring manual verification, and fall back to targeted repository search when graph results are generic or stale
- `npm run meta:graphify:check` and `npm run meta:validate` compare the graph's built commit with current `git rev-parse HEAD` and fail when `GRAPH_REPORT.md` is stale
- after modifying code files, run `npm run meta:graphify:rebuild`

Graphify installation and runtime wiring are handled by setup and helper scripts:

- `npm run meta:graphify:check`
- `npm run meta:graphify:install`
- `npm run meta:graphify:update`
- `npm run meta:graphify:rebuild`

## Maintenance Loop

After changing canonical prompts, skills, hooks, contracts, or runtime-facing docs:

1. `npm run discover:global`
2. `npm run meta:sync`
3. `npm run meta:check`
4. `npm run meta:check:global`
5. `npm run meta:verify:all` before release or after larger changes

Use supporting commands as needed:

- `npm run meta:validate`
- `npm run meta:check:runtimes`
- `npm run meta:check:sync-coverage`
- `npm run meta:doctor:governance`
- `npm run meta:eval:agents`
- `npm run meta:eval:agents:live`
- `npm run meta:validate:run -- <artifact.json>`
- `npm run meta:index:runs -- <artifact-dir-or-file>`
- `npm run meta:query:runs -- --owner <agent>`
- `npm run migrate:meta-kim -- <source-dir> --apply`
- `npm run meta:deps:install`
- `npm run meta:deps:install:all-runtimes`
- `npm run meta:deps:update`
- `npm run meta:deps:update:all-runtimes`
- `npm run meta:deps:install:claude-plugins`
- `npm run meta:sync:global`
- `npm run prompt:next-iteration`

`npm run meta:verify:all` runs runtime sync checks, project validation, graphify health, global sync checks, smoke-level runtime acceptance, setup tests, and meta-theory tests.

## Install And Packaging Notes

- Node must satisfy the `package.json` engine requirement.
- CLI entry is `npx --yes github:KimYx0207/Meta_Kim meta-kim` or `bin/meta-kim.mjs`.
- `package.json` uses a `files` whitelist so install tarballs contain the full `canonical/` tree.
- `node setup.mjs` installs selected runtime projections and graphify wiring idempotently.
- Runtime target selection has two layers: repo defaults in `config/sync.json`, machine-active targets in `.meta-kim/local.overrides.json`.
- MCP Memory Service uses port `8000`.
- `stop-memory-save.mjs` is a canonical/global MCP memory lifecycle asset installed by `scripts/install-mcp-memory-hooks.mjs`; it is not registered in the project `.claude/settings.json` projection.

## Reading Order

For maintainers:

1. `README.md` or `README.zh-CN.md`
2. `AGENTS.md` for cross-runtime and Codex-facing rules
3. `CLAUDE.md` for Claude Code hook and Agent-tool behavior
4. The Mechanical Enforcement and Maintenance Loop sections in `AGENTS.md` when changing trigger, hook, review, verification, stop, or writeback behavior
5. `canonical/skills/meta-theory/references/dev-governance.md` for the long-form governed execution contract

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
