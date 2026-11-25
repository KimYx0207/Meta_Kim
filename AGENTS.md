# Meta_Kim for Codex

This file is the Codex entrypoint for maintaining Meta_Kim. Read it as the resident operating guide for this repository, not as a marketing overview.

## Fast Read

Keep these rules in mind:

- Meta_Kim is one cross-runtime governance system. Claude Code, Codex, OpenClaw, Cursor, Gemini CLI, and ZCode are projections of the same canonical layer. Gemini CLI and ZCode are optional native projections; installation and structural checks do not establish live host acceptance.
- Its core is general agent governance: understand the current user goal, compare evidenced feasible routes, discover capabilities, orchestrate execution and verify outcomes across domains. Industry packages are optional capability sources; framework acceptance must never replace the user's outcome.
- DeepSeek Harness has a separate opt-in `meta-kim dsh` profile/Skill/MCP lifecycle. The canonical nine roles remain Skills there, not registered custom-agent presets. Official no-model config/Skill/MCP observations do not authorize the stage runner, prove hard Hook enforcement or certify professional results. See `canonical/skills/meta-theory/references/runtime-dsh.md`.
- `meta-warden` is the normal public front door. Other meta agents are backstage specialists.
- Dispatch is capability-first: describe the capability, search agents / skills / tools / capability indexes, then choose the best owner.
- Long-term behavior lives in `canonical/`, `config/contracts/`, and `config/capability-index/`. Runtime trees (`.claude/`, `.codex/`, `.agents/`, `.cursor/`, `.gemini/`, `.zcode/`, `openclaw/`) are gitignored projections — run `npm run meta:sync` after clone to generate the selected targets locally.
- User-visible run-scoped worker labels may be coarse English role-family names such as `frontend`, `backend`, or `test`, but Meta_Kim does not project those execution labels as durable agents. Durable governance files stay with the nine `meta-*` owners.

## Codex Output Rules

- This repository uses `main` as its only branch. Commit and push on `main`; create another branch only when the user explicitly requests one. Preserve uncommitted work and linked worktree contents when cleaning up merged branches.
- On Windows, do not output raw Windows paths in normal Markdown text. Wrap paths in backticks and prefer forward slashes, for example `D:/path/to/project`.
- Do not paste full diffs or patches into chat after GitHub submit.
- After GitHub submit, report only the branch name, commit hash, PR URL when present, and a short summary.

## What This Repository Is

Do not read Meta_Kim as a folder full of unrelated prompt files.

Read it as:

**a cross-runtime architecture pack for intent amplification, governed through small replaceable meta units and projected into multiple AI runtimes.**

In this repo, `meta` means the smallest governable unit that supports intent amplification. A valid meta unit:

- owns one clear responsibility class
- states what it refuses, not only what it does
- can be reviewed on its own
- can be replaced or rolled back
- does not silently absorb unrelated responsibilities

## Source Of Truth

Edit these for durable behavior:

- `canonical/agents/*.md`
- `canonical/skills/meta-theory/SKILL.md`
- `canonical/skills/meta-theory/references/*.md`
- `canonical/runtime-assets/*`
- `config/contracts/`
- `config/capability-index/`

Treat these as generated mirrors or runtime adapters unless the task explicitly targets runtime wiring:

- `.claude/agents/*.md`
- `.claude/skills/meta-theory/`
- `.claude/hooks/`
- `.claude/settings.json`
- `.mcp.json`
- `.claude/capability-index/`
- `.codex/agents/*.toml`
- `.agents/skills/`
- `.codex/skills/` legacy compatibility mirrors, when present for cleanup
- `.codex/capability-index/`
- `.cursor/agents/*.md`
- `.cursor/skills/meta-theory/`
- `.cursor/mcp.json`
- `.cursor/capability-index/`
- `.gemini/agents/*.md`
- `.gemini/hooks/meta-kim/`
- `.gemini/settings.json` managed fragments; project skills share `.agents/skills/` with Codex
- `.gemini/capability-index/`
- `.zcode/agents/*.md`
- `.zcode/skills/meta-theory/`
- `.zcode/config.json` managed MCP fragments; current ZCode ignores project hooks
- `.zcode/capability-index/`
- `openclaw/skills/`
- `openclaw/workspaces/*`
- `openclaw/capability-index/`
- `openclaw/openclaw.template.json`

After changing canonical sources, sync projections instead of hand-forking runtime copies.

Open-source boundary: runtime projection directories are generated local outputs, not GitHub source. `.claude/`, `.codex/`, `.agents/`, `.cursor/`, `.gemini/`, `.zcode/`, `.dsh/`, `openclaw/`, `.mcp.json`, and `codex/` must stay gitignored and excluded from package files. The nine governance agents are sourced from `canonical/agents/`. Codex `.toml` projection is limited to those governance mirrors; execution-layer labels such as `worker`, `explorer`, `frontend`, `backend`, `test`, `review`, `analysis`, `verify`, or `docs` are not Meta_Kim projection targets.

## Install Scope And Runtime Sedimentation

Install scope, project ownership, and the immutable execution store have independent lifecycles. Preserve user state and project-owned capabilities. Use the packed CLI for install and update verification. [Install and ownership rules](MAINTAINER.md#install-scope-and-runtime-sedimentation)

## Codex Runtime Map

Codex projects use the canonical governance agents, project skills, and Hook projection. Keep shared dependencies together and resolve the project root before any write. [Runtime formats and paths](MAINTAINER.md#codex-runtime-map)

## Capability-First Dispatch

Meta_Kim does not start with "call agent X". It starts with "what capability is needed?"

For every non-query governed task, run capability search before execution. If the task touches runtime behavior, inspect `config/runtime-capability-matrix.json`. If it touches macOS, Windows, or WSL2, inspect `config/os-compatibility-matrix.json`. If it touches external reusable capability, inspect `config/capability-index/dependency-project-registry.json`. Reference-only projects are not dependencies; distill useful ideas into Meta_Kim stage data such as `config/governance/decision-pattern-catalog.json`.

Use this order:

```text
Need capability
-> Search repo canonical capability index
-> Search runtime mirror indexes
-> Search local runtime inventory
-> Search available skills and tools
-> Choose the best owner by boundary fit
-> Dispatch with explicit scope, deliverable, review owner, and verification owner
```

Capability-index fetch order:

```text
config/capability-index/
-> .claude/.codex/.cursor/.gemini/.zcode/openclaw capability-index mirrors
-> .meta-kim/state/{profile}/capability-index/
-> explicit compatibility degradation or capabilityGapPacket
```

Hardcoding a specific agent name before discovery is a shortcut, not the canonical method.

Provider claim truth is also capability-first. In `config/capability-index/provider-registry.json`, `providers[*].support` is the single durable authority and `runtimeAdapters` is only its validated projection. Keep selection run-scoped, distinguish availability from native support, and require fresh verification evidence for live claims. A runtime-specific provider must remain blocked and have no activation event outside its declared target runtime; a generated projection never makes a Claude provider native to Codex, Cursor, or OpenClaw, or vice versa.

For a real execution demand, the default path must prove the whole provider chain before mutation: capability discovery, execution-agent search and selection, execution-agent creation capability search, skill search and selection, skill creation capability search, MCP provider search, command/runtime tool selection, and verification owner/path selection. This must happen as the natural Fetch -> Thinking route, not as a validator or hook rescue after the route is already weak.

### Mechanical Enforcement (Cross-Runtime)

Capability-first has a mechanical hook path on Claude Code, Codex, and Cursor. Default `progressive` keeps role-allocation notices advisory; elapsed days never escalate them into a deny. Use the recorded task-progress fuse for outcomes: one in-flight attempt per task, two ineffective terminal attempts on the same basis open only that task’s circuit, and an evidenced scoped correction starts a recovery trial. Independent tasks and read-only diagnosis continue. Mandatory intent, capability, owner/loadout, authorization and dependency checks remain at their relevant boundary; optional packet completeness belongs to Review and release validation.

- **Claude Code**: enforced via the PreToolUse hook `enforce-agent-dispatch.mjs` (deny payload `{hookSpecificOutput.permissionDecision: "deny"}` when the effective mode is `block`). The gate covers `Agent` dispatches in stages `execution`, `review`, `meta_review`, `verification`, `evolution` unless `fetchRecord.capabilitySearchPerformed === true`. Discovery stages `critical`, `fetch`, `thinking` are exempt except for execution-intent dispatch before design-time readiness.
- **Codex CLI**: enforced via PreToolUse hook (same `enforce-agent-dispatch.mjs` script projected to `.codex/hooks/`). Matcher includes `"Bash|apply_patch|Edit|Write|MultiEdit|NotebookEdit|Agent|spawn_agent|followup_task|collaboration\\.spawn_agent|collaboration\\.followup_task"`, but Codex hook coverage is runtime-version dependent; do not treat it as an all-tool policy engine. It is generated by `buildCodexHooksJson` in `scripts/runtime-hook-mapping.mjs`; do not document a line-number contract.
- **Cursor**: mechanically enforced via the official `preToolUse` hook surface with `failClosed: true` (crash defaults to deny). Uses exit code 2 + stderr deny reason or stdout JSON `{"permission":"deny",...}`. Registered at `scripts/runtime-hook-mapping.mjs:269-280`.
- **OpenClaw**: current Meta_Kim tool-blocking enforcement is declarative-only — hard refusal prose in workspace `HEARTBEAT.md` and `SOUL.md` (`executionBlock=true`). OpenClaw internal hooks cover command/lifecycle automation, and typed plugin hooks are the official blocking/canceling policy surface, but Meta_Kim has not installed a typed plugin enforcement adapter yet. See `canonical/runtime-assets/openclaw/DECLARED_GAP.md` for the full boundary declaration.
- **Gemini CLI**: the native adapter maps `BeforeTool` into the shared governance core and maps denial back to Gemini's top-level `decision: "deny"`. Local subprocess tests establish the adapter's dependency closure and translation; real host identity, activation and tool coverage remain unverified.
- **ZCode**: the native adapter uses documented user-level `PreToolUse` / `Stop` events and ZCode output shapes. Current official documentation ignores project hooks. Global hook installation is opt-in; structural tests do not establish real host execution or session proof.

Override knob (all hook-equipped runtimes): `META_KIM_CAPABILITY_GATE=progressive|block|warn|off` (default `progressive`; `block` explicitly enforces the advisory gate). `warn` keeps that notice advisory and `off` disables the capability gate. These modes do not create host permissions. Legacy `*_GRACE_DAYS` variables are no longer used. The existing task ledger supplies the scoped fuse; `canary`, `open`, `recovery_trial` and `observed_progress` in checkpoint inspection describe recorded results, not automatic deployment rollback or independent quality certification. Runtime-payload schema selector: `META_KIM_HOOK_RUNTIME=claude|codex|cursor`.

Canonical hook source: `canonical/runtime-assets/claude/hooks/enforce-agent-dispatch.mjs`. The current runtime matrix and limits are documented in this Mechanical Enforcement section; do not add a separate source-of-truth document for the same rule.

## Meta-Theory Activation

Do not require humans to know or type command words. Treat ordinary natural-language executable requests as the primary entry path when they imply durable planning, execution, review, verification, prioritization, repair suggestions, or a validation checklist. Examples include "帮我整理成优先级、修复建议和验证清单", "这个页面不好看，帮我弄高级一点", "帮我规划并开始处理", or "review this and fix what matters".

Explicit triggers such as `/meta-theory`, `meta-theory`, `meta theory`, `run meta theory`, `execute meta theory`, `元理论`, or a `meta-theory` skill mention are maintainer shortcuts, not required user behavior.

Use the entry classifier behavior as the user-facing rule:

- plain durable work in natural language enters governed `standard_path`
- subjective or taste-dependent work enters Critical clarification before Fetch
- pure read-only questions stay on `fast_path`
- explicit meta-theory requests enter `regulated_path`

Codex must first run:

```text
Critical -> Fetch -> Thinking
```

That means:

- Critical locks the real outcome, pain/value, audience, success standard, non-goals, and only asks questions that change execution
- Fetch gathers evidence and capability facts that change the route, risk, owner, scope, or acceptance criteria
- Thinking selects expert lenses, compares viable paths, rejects weak paths, resolves owners/capabilities, and writes worker work orders before Execution
- Review checks whether Critical, Fetch, and Thinking were good enough before judging final output polish
- Execution work is dispatched to agents, skills, commands, MCP capabilities, runtime tools, or workers selected by Thinking instead of collapsing into the main thread

For Codex, meta-theory / governed Meta_Kim activation is user-visible authorization for safe native fan-out when Thinking proves multiple independent worker lanes and DAG/collision/workspace/external-write safety. Direct subagent/delegation/parallel-agent wording and structured governance-chain requests such as `Critical Thinking -> Fetch -> Deep Thinking -> Review` are strong activation examples, not exclusive gates. The main thread scopes, delegates, reviews, and synthesizes; it does not become the all-purpose executor for complex work. Native choice remains required only when route, scope, risk, or acceptance materially branches. Live delegation requires a native `spawn_agent` surface exposed by the current Codex host, whether top-level or under its declared namespace (for example, `collaboration.spawn_agent`). Inspect that callable tool's actual schema; if no native surface is exposed, block or declare degraded mode instead of inventing an API or silently serializing.

Codex owner binding is schema-adaptive and truth-preserving. Use the single field `ownerBindingMode`: `native_custom_agent` is allowed only when the active `spawn_agent` schema exposes `agent_type` and the selected owner is a validated Codex TOML custom-agent definition; pass its declared name as `nativeAgentType`/`agent_type`, and wait for a successful host result before calling it invoked or completed. Otherwise use `run_scoped_owner_contract` with no `nativeAgentType`. Markdown owners, `task_name`, nicknames, badges, and `runtimeInstanceAlias` never prove native owner loading.

### Production Correctness Before Execution

Meta-theory work must be correct before production starts, not rescued by Review or Verification after the fact.

Before editing files, inspect the current worktree and source files that will be changed: `git status --short`, `git diff --stat`, targeted diffs, targeted source reads, and repo-scoped search. This read-before-edit step belongs to Critical/Fetch. A hook that blocks read-only inspection is a governance defect to route to Sentinel/Conductor, not a reason to work blind.

For actual task supervision, consume `config/contracts/core-loop-contract.json`'s `taskProgressPolicy` through the existing host checkpoint or durable execution path. A new protected host work order binds current criterion IDs, stable capability/method identity and immutable input/strategy snapshots. Register its running attempt before dispatch, then submit the same attempt's criterion results through the returned checkpoint template. Use the existing task-level observation/correction operations for a repeated ineffective route; do not clear all stages or invalidate unrelated work. Inspect exposes coverage, counters and the exact next required action. Legacy or unbound host work remains explicitly unobserved; installing files or adding a reminder does not prove supervision is active. Correcting a task requires the current goal/trigger-bound reviewed decision and a changed evidenced basis, without relaxing scope, criteria or permissions.

Required internal stage records:

- Critical: `realIntent`, `successCriteria`, `nonGoals`, `blockingUnknowns`, `noQuotaClarification`
- Fetch: `evidence`, `decisionImpactMap`, `capabilityDiscovery`, `capabilityGap`, `contradictionLog`
- Thinking: `designFrame`, `workType`, `expertLens`, `consideredLanes`, `omittedLanesWithReason`, `workerTaskPackets`, `dependencyPolicy`
- Review: checks upstream Critical/Fetch/Thinking quality before result polish

Normal chat output for these stages must be localized, compact, and human-readable. Packet field names such as `realIntent`, `decisionImpactMap`, or `workerTaskPackets` may appear when useful, but they must be paired with human labels instead of being dumped as unexplained English keys.

Governance-quality fallback is forbidden. Missing intent, evidence, design, owner, capability, dependency readiness, or worker work order means `block`, `return_to_stage`, or `capabilityGapPacket`. Runtime compatibility fallback may remain for host limitations such as a chat card instead of a popup, but it does not count as governance readiness.

## Business Flow Before Execution

For executable work, plan the business flow before writing code or changing files. This is a dynamic workflow step, not a fixed checklist: classify the user's natural-language intent, choose lanes from evidence and dependency signals, and record omitted lanes with reasons. A web app, for example, may need separate lanes for:

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

Hard rules before Execution:

- Fuzzy goals require intent amplification and an acceptance record.
- Multi-path work requires best-path selection.
- Multi-lens judgment uses dynamic lens discovery; user-mentioned books, people, or theories are seeds/fallbacks, not a fixed list.
- Execution requires owner + weapon + verification owner.
- Dependency projects require input/output contracts before use.
- Codex native subagents require governed Meta_Kim activation or another user-visible authorization source, separable safe lanes proven by Thinking, and the current host's exposed native `spawn_agent` surface and schema. A `meta-theory` trigger or structured governance-chain request may authorize safe fan-out; native choice is reserved for branch-changing decisions. Use a namespaced surface only when the current host actually exposes it; do not guess legacy aliases. Hooks require trust review.
- OpenClaw skills require third-party risk and sandbox review.
- Cursor capabilities remain unknown/partial until verified; do not mark them native from projection files alone.
- Public-ready requires verification plus intent acceptance; workflow completion alone is not user-goal completion.
- Evolution must write back or record none-with-reason.

Not every task needs every lane. Do not force every wish-style request through the same lane set; omitted lanes should be intentional. The business-flow blueprint should explain:

- what user pain/value and success standard the run serves
- what capability is needed
- which existing agent / skill / tool was found
- whether an owner is reused, upgraded, or newly created
- which expert lenses are relevant and which are explicitly not applicable
- which lanes can run in parallel
- who merges the outputs
- how the result will be reviewed and verified

## Agent Display Names

Separate these three names:

- `ownerAgent`: the real governance or execution owner, for example `meta-conductor` or `frontend-developer`
- `roleDisplayName`: the short user-visible English business role family, for example `frontend`, `backend`, or `test`
- `runtimeInstanceAlias`: the host runtime's incidental nickname, if any

Rules:

- `roleDisplayName` is a run-scoped label inside task packets, not a durable agent identity and not a projection file.
- Do not show host-generated personal names as the primary agent name.
- Prefer short role names over long task descriptions.
- Do not put concrete work items into `roleDisplayName`; put shard or task scope in `roleInstanceId`, `shardScope`, `parallelGroup`, `dependsOn`, `mergeOwner`, and collision boundaries.
- If the same owner runs multiple parallel instances, keep the same coarse `roleDisplayName` and separate instances with `roleInstanceId`.
- Normal chat and run panels must show `ownerAgent` separately from `runtimeInstanceAlias` and retain the Agent, Skill, Command, MCP, runtime-tool, and Hook selected-versus-actual ledger with each next action.

## Eight-Stage Spine

Meta_Kim's execution backbone is:

```text
Critical -> Fetch -> Thinking -> Execution -> Review -> Meta-Review -> Verification -> Evolution
```

The 11-phase business workflow is separate:

```text
direction -> planning -> execution -> review -> meta_review -> revision -> verify -> summary -> feedback -> evolve -> mirror
```

The relationship is simple:

- the 8-stage spine governs execution logic
- the business workflow governs run packaging and deliverable closure
- business phases do not rename or replace the spine

Machine-readable source: `config/contracts/core-loop-contract.json` defines each stage's required input/output, skip condition, gate condition, blocking vs progressive behavior, Verification fuse policy, Evolution writeback policy, and public-ready claim rule. The default runnable entry is `npm run meta:theory:run`, which emits a `coreLoop` summary in the governed execution artifact.

## Hidden Governance Packets

A governed run should leave enough structure to audit what happened. Important packets include:

- `coreLoop`
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

Do not claim a run is public-ready unless verification passed, summary closure exists, a single primary deliverable was maintained, and the deliverable chain is closed.

## Planning Files

When the task is not a pure query, use Meta_Kim's first-party `planning-continuity` runtime at Stage 3 to create or resume persistent planning state:

- `task_plan.md`
- `findings.md`
- `progress.md`

The external `OthmanAdi/planning-with-files` dependency has been absorbed and retired. It remains only as historical provenance in the dependency registry; it must not appear in `config/skills.json`, install routes, runtime homes, Hook registrations, or execution selection. Meta_Kim's first-party `planning-continuity` runtime is the sole planning authority.

The first-party runtime binds planning state to a trusted project root, runtime, and run digest; preserves existing files; requires explicit owner review before attesting pre-existing content; refuses automatic recovery on hash drift or unsafe control-instruction patterns; never auto-injects `findings.md`; and bounds completion blocking to two attempts before allowing an incomplete stop without a completion claim. Use `npm run meta:planning:validate` for its local contract and absence acceptance.

These files supplement protocol packets. They do not replace `businessFlowBlueprintPacket`, `dispatchEnvelopePacket`, or verification evidence. The Conductor or the main thread acting as Conductor is the sole writer.

For a release-backed local work queue, do not publish these files or the private PRD and do not invent a public backlog mirror. After the exact Release audit and the final Claude Code/Codex global check have passed, run `meta-kim release close --issue <P-NNN> --prd <repo-relative-private-prd>`. The command verifies the current tag/audit/global state, then appends one idempotent release-fact block to each existing planning file. The PRD remains the only queue authority; planning blocks are recoverable local projections only.

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

## Correct Execution Shape

Anti-pattern:

```text
User: build a notification system
Assistant: immediately edits ten files as one undifferentiated worker
```

Correct pattern:

```text
User: build a notification system
Assistant:
1. Critical: clarify material ambiguity
2. Fetch: discover existing capabilities
3. Thinking: map lanes, owners, dependencies, and merge plan
4. Execution: dispatch bounded work to the right agents / skills
5. Review: inspect outputs against quality and boundaries
6. Meta-Review: verify the review standard when risk is high
7. Verification: run fresh checks
8. Evolution: record reusable patterns or decide no writeback
```

## Graphify

This repository has a knowledge graph under `graphify-out/`.

Rules:

- For broad architecture or codebase questions, use existing `graphify-out/GRAPH_REPORT.md` and `graphify-out/graph.json` as navigation indexes when present.
- Do not run a startup freshness gate merely because a graph exists. At the start of a run, check only whether graph artifacts are present and useful enough for navigation.
- Treat Graphify as a project map, not the final source of truth. Use graph queries or subgraph extraction to find relevant modules, concepts, and file anchors, then verify route-changing claims against the target source files.
- Agent and worker context should receive only graph slices, short hints, and file anchors relevant to that worker. Do not inject the full `graph.json`, full `GRAPH_REPORT.md`, or broad graph dumps into every worker.
- If `graphify-out/wiki/index.md` exists, use it for broad navigation instead of raw source browsing.
- Dirty `graphify-out/` files can be expected after hooks or incremental updates; dirty graph files are not a reason to skip graph context.
- `npm run meta:graphify:check` and `npm run meta:validate` compare the graph's built commit with current `git rev-parse HEAD` and fail when `GRAPH_REPORT.md` is stale. Use this as a verification/release/public-ready gate, not as a routine run-start cost.
- After modifying code files, run `npm run meta:graphify:rebuild` to keep the graph current across Windows, macOS, and Linux.

## Maintenance Loop

After changing canonical behavior, contracts, hooks, or runtime-facing docs:

1. `npm run discover:global`
2. `npm run meta:sync`
3. `npm run meta:check`
4. `npm run meta:check:global`
5. `npm run meta:release:smoke` before routine low-risk patch/minor releases; use `npm run meta:verify:all` for the standard full release gate on larger, risky, runtime, install, hook, dependency, package, or security changes; add `npm run meta:verify:live-certified` only when the optional highest-assurance external live certification is requested

Use these supporting commands as needed:

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
- `npm run meta:graphify:check`
- `npm run meta:graphify:rebuild`
- `npm run meta:deps:install`
- `npm run meta:deps:install:all-runtimes`
- `npm run meta:deps:update`
- `npm run meta:deps:update:all-runtimes`
- `npm run meta:sync:global`
- `npm run prompt:next-iteration`

`npm run meta:release:smoke` is the default maintainer release check for low-risk prompt/doc/governance iterations. It runs projection sync, default capability-discovery smoke, and meta-theory tests. `npm run meta:verify:all` is the standard full release suite: runtime sync checks, project validation, graphify health, global sync checks, smoke-level runtime acceptance, setup tests, and meta-theory tests. A complete passing run may be used to commit, tag, push, publish, and describe the release as standard release-verified. The standard suite validates packed installation and runtime structure without requiring Claude Code and Codex native model-task completion. Version-only CLI fixtures remain structural evidence and never native execution proof. `npm run meta:verify:live-certified` explicitly adds the strict native observation prerequisites and separate external-signature exact-binding clean-room gate.

## Release Modes

Use the project release entry points and evidence requirements before making release claims. [Release modes and packaging](MAINTAINER.md#release-modes)

## Reading Order

For maintainers:

1. `README.md` or `README.zh-CN.md`
2. `AGENTS.md`
3. `CLAUDE.md` when touching Claude Code behavior
4. This `AGENTS.md` Mechanical Enforcement section when changing cross-runtime trigger, hook, review, verification, stop, or writeback behavior
5. `canonical/skills/meta-theory/references/dev-governance.md` for the long-form governed execution contract
