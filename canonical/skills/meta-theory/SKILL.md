---
name: meta-theory
version: 3.0.0
author: KimYx0207
user-invocable: true
trigger: "元理论|执行元理论|跑元理论|meta theory|run meta theory|execute meta theory|meta-theory|agent governance|intent amplification|governance|治理|重构|多文件|跨模块|debug|fix|验证|verification"
tools:
  - shell
  - filesystem
  - browser
  - memory
description: |
  Meta_Kim executable governance dispatcher. It classifies the run, loads only needed references, preserves foundational capabilities and runtime-native abilities, routes owner + weapon + dependency + runtime + OS + verification, and closes only with evidence, intent acceptance, and writeback decision.
---
# Meta-Theory Dispatcher
## Purpose
Run Meta_Kim as an executable governance system, not a theory essay. The main thread locks intent, gathers evidence, chooses route, delegates bounded work, reviews, verifies, and synthesizes. It must not become a generic implementation worker for non-trivial work. Machine contract: `config/contracts/core-loop-contract.json` is the compact default-path contract for this skill. It binds ordinary durable work and explicit meta-theory shortcuts to `npm run meta:theory:run`, requires the eight-stage spine, and defines which gates block, warn, or stay progressive.
The default governed runner remains planned-only. When the maintainer explicitly supplies `--execute-stage-dag`, the P-117 bridge executes the existing `coreLoop.stageDagPacket` in read-only shadow mode through either `--stage-runner-runtime codex` or `--stage-runner-runtime claude`, with the P-118 kernel retaining durable node commits; `--resume-stage-dag` continues only the exact bound unfinished run. The ready-set executor defaults to native concurrency. `--stage-runner-orchestrator langgraph` may dynamically load an explicitly installed, currently tested `@langchain/langgraph@1.4.8` and use only its Functional API `entrypoint` plus `task`; it consumes the scheduler-selected ready set and may not define topology or persistence. Both runtimes keep the same graph, checkpoint, and local merge authority. A native terminal result proves invocation, while Review still owns semantic acceptance. Do not claim write execution, external effects, a runtime-specific graph, LangGraph checkpoint authority, or live OpenAI/Claude SDK adapters without credential-backed evidence. The process timeout is a safety fuse, never a task/token/cost budget.

## Global-First Owner Discovery

Discovery is **global-first, capability-first**: not project-local, not agent-name-first. The run searches the relevant sources — local canonical assets, capability indexes, global runtime homes, package scripts, MCP / runtime configs, and external discovery (`findskill` / `meta-scout`) — using the cached-inventory, project-light, stop-on-match policy in `config/contracts/core-loop-contract.json`. A reusable global owner that already matches the boundary wins over creating a project-local copy. Full source-by-source guidance lives in `references/global-owner-discovery.md`; it must not override the machine contract's stage order, full-scan triggers, or stage-internal parallel policy.

The dispatcher (main thread or `meta-conductor`) is the **single merge owner** of `dispatchEnvelopePacket.capabilityInventory`. Fetch may discover independent sources concurrently after Critical has closed its intent merge, but the inventory is merged once before Thinking closes the route. This is a main-flow step, not a hook. The inventory records which relevant sources were actually scanned, which owners were considered, why one was selected, and why any route-relevant source was skipped. Discovery without a recorded inventory is fake discovery and is rejected by Review on the same chain, not by a separate gate.

## Trigger
Activate from ordinary natural-language durable work, not only from command words. If the user asks to plan and start work, organize priorities, produce repair suggestions, build a verification checklist, fix a non-trivial issue, handle multi-file execution, run review/verification, or resolve subjective/taste-dependent quality, classify the entry and choose the governed route automatically. Explicit `/meta-theory`, `meta-theory`, or `元理论` mentions are maintainer shortcuts, not required human behavior.

At run start, show a concise human-readable reason for the route. If the 8-stage spine triggers, say briefly why governance is needed before execution. If the 11-phase business workflow triggers, say briefly why closure, feedback, evolution, or mirror tracking is needed. Keep this to short user-facing lines; do not dump packet names or internal reasoning.

## Path classification
- `fast_path`: read-only query, no mutation, no durable artifact. Output may be direct, but evidence claims still need source.
- `standard_path`: ordinary executable work. Preserve the 8-stage order and capability-first truth boundary, but use fitness-informed depth: concise inline Critical / Fetch / Thinking for clear low-risk work, conditional Review, required fresh Verification, and no dedicated Evolution dispatch without a durable trigger.
- `regulated_path`: governance, security, runtime, dependency, release, public-ready, or cross-platform work. Require full spine, Review, Meta-Review, Verification, and Evolution.

## Canonical spine
Critical -> Fetch -> Thinking -> Execution -> Review -> Meta-Review -> Verification -> Evolution.

You are the DISPATCHER, not the executor. Use Agent tool / `Agent(...)` dispatch only after Fetch evidence and Thinking owner resolution prove the route.

Fetch-first capability matching principle: Fetch gathers evidence, then Thinking performs capability match, never hardcoded agent-name matching. Gate 1: Clarity Check blocks unclear intent before Fetch. Gate 2: Dispatch-Not-Execute blocks self-execution and requires a named owner, weapon, and verification owner.

Decision information is responsibility-scoped. Fetch is not the only stage that creates user choice material. Critical decides which intent dimensions matter, Fetch decides which evidence changes routes, Thinking decides owner / weapon / dependency / runtime / lane options, Execution records route-changing discoveries, Review decides quality and revision trade-offs, Meta-Review decides claim standard, Verification decides truth state, and Evolution decides writeback or none-with-reason. The 11-phase business workflow, meta workflow phases, business lanes, capability route, owner/weapon/dependency choice, runtime/OS support, tool/provider selection, verification path, evolution writeback, and user interaction surface are also decision boundaries. Each boundary must collect information that matches its responsibility and explain how that information changes the user's choices; do not collapse all decision evidence into Fetch or Thinking.

## Architecture Type Pre-judgment

Important: Architecture Type Distinction. Meta Architecture means agent governance, collaboration relationships, and responsibility boundaries. Project Technical Architecture means code organization, tech stack, and design patterns; redirect that lane to an architect or backend-architect capability when the needed owner is technical implementation rather than Meta_Kim governance.

## Type-First Route Invariant

Before adding another checklist, hook rule, or validator gate, classify the route-critical type. The minimum axes are object type, evidence type, and ownership type. Unknown object type returns `null`, `capabilityGapPacket`, or `reference_only`; unknown evidence type must not be promoted from structural/validator pass into runtime truth; unknown ownership preserves or blocks instead of overwriting user-owned local state. This is a route-selection invariant for Fetch and Thinking, not a new stage or acceptance matrix.

## Dynamic Flow Selection

- Type A: prompt/reference/contract hardening.
- Type B: agent/skill/owner creation or upgrade.
- Type C: external capability, tool, MCP, dependency, or web evidence discovery.
- Type D: review, verification, rollback, public-ready, or warning closure.
- Type E: orchestration, planning files, business-flow, and cross-runtime release.

## Complexity Fan-out Trigger

Do not wait for the user to spell out agent names before recognizing complexity. Treat the run as fan-out eligible when any of these signals appear:

- explicit `/meta-theory`, `meta-theory`, `元理论`, natural-language governed work, `critical and fetch thinking and review`, `Critical Thinking -> Fetch -> Deep Thinking -> Review`, "并行", "多个 agent", "review + fix + verify", or equivalent wording
- 2+ independent files, runtimes, platforms, capability families, PR/issue lanes, research angles, product lanes, or verification lanes
- cross-runtime behavior, release/update/sync, hook/security/sandbox, PRD/contract/validator, or repeated same-type failure work
- user feedback that the current Meta_Kim route is slow, serial, missing agents, missing dynamic workflow, or repeatedly corrected

Fan-out eligibility is only an entry hint; `coreLoop.stageDagPacket` is the runtime authority for whether lanes are dependency-ready, resource-safe, permission-safe, and worth dispatching concurrently. Live host-agent dispatch also requires runtime authorization and a callable host surface. In every active stage, dispatch the maximal safe ready set up to active host capacity using that runtime adapter's native concurrency primitive. Do not silently serialize ready independent lanes, but do not require one universal batching shape across hosts: concurrency must be proved by the host's batched-call evidence or overlapping invocation intervals. For Codex, entering meta-theory / governed Meta_Kim execution is itself fan-out authorization when the stage DAG proves separable safe lanes; direct subagent/delegation/parallel-agent wording and structured governance-chain requests such as `Critical Thinking -> Fetch -> Deep Thinking -> Review` are examples of that authorization, not exclusive gates. Native choice is required for branch-changing route, scope, risk, or acceptance decisions, not as the mechanism that first permits safe parallelism. Direct user corrections such as "我要的是派发 / 并行 / 多 agent" are governed execution entries and direct fan-out authorization. If the host tool is unavailable, rejected, or unauthorized, record `subagentCapabilityStatus`, `degradationReason`, and `hostInvocationRequestPacket`; do not claim live fan-out, completion, or public-ready.
Visible owner binding rule: before any live host worker/subagent call, each lane must bind `ownerAgent`, `ownerSource`, `ownerBindingMode`, capability/loadout, `roleDisplayName`, `roleInstanceId`, `parallelGroup`, `mergeOwner`, and the runtime-specific invocation plan. Codex uses `ownerBindingMode=native_custom_agent` only when the active top-level `spawn_agent` schema exposes `agent_type` and the selected owner is a validated Codex TOML custom-agent definition; that request carries `nativeAgentType`, and only its successful result may be presented as invoked/completed. Otherwise Codex uses `ownerBindingMode=run_scoped_owner_contract`, keeps `nativeAgentType` null/absent, and carries the professional owner in the bounded message. A Markdown owner is never promoted to a Codex native custom agent merely because its name matches. Claude Code keeps its own native Agent/Task binding. The user-visible dispatch notice must show the professional owner separately from any `runtimeInstanceAlias`, and the same compact ledger must retain Agent, Skill, Command, MCP, runtime-tool, and Hook selected-versus-actual state plus next action. It must not say only "created N agents", "派 agent", or equivalent wording with no owner/capability binding. If no reusable owner or capability binding can be found, block or return to Thinking with `capabilityGapPacket` instead of spawning unnamed side agents.
## Stage map

| # | Stage | Action | Interaction |
|---|---|---|---|
| 1 | Critical | clarify intent first, lock user pain, value, success criteria, non-goals, permissions, and Architecture Type; for wishful or ambiguous input, enter Critical-Fetch intent loop: translate intent -> read context -> enrich intent -> present IntentCard for user confirmation (up to `criticalFetchLoopMax` rounds) | If a required intent dimension is missing and the answer changes route, scope, risk, or non-goal, set `choiceSurfaceState = critical_clarification_allowed` and ask before proceeding. Do not present execution options during Critical. Present an IntentCard after context-enriched intent translation; Codex and Claude Code must confirm through their native interactive choice surface, while compatibility runtimes may use a clearly labeled chat decision card fallback. |
| 2 | Fetch | gather online/web and local evidence, confirm the problem, list candidate solutions with sources, extract material claims, run targeted read-only baseline verification when it changes the route, discover retrieval capabilities, complete a multi-type capability inventory before Thinking, read every target file that may be changed, and build a change fact card before any file mutation | If evidence suggests multiple valid paths with different trade-offs, surface the options in the user's language before Thinking. If current external facts or third-party capability claims matter, `meta-scout` or an equivalent evidence owner must finish source-backed research before Thinking. |
| 3 | Thinking | determine needed execution capabilities across governance agents, execution agents, skills, scripts, commands, MCP capabilities/providers/tools, runtime tools, plugins/connectors, retrieval capabilities, dependency/external packages, and run-scoped workerTasks; match existing capabilities; create or upgrade only for gaps; bind the file delivery contract; plan DAG/parallel/serial lanes with `mergeOwner` | Present at least 2 candidate paths with a recommended default. Ask the user to confirm the chosen path before Execution. |
| 4 | Execution | run multi-agent work using the agents, skills, scripts, commands, MCP capabilities, runtime tools, plugins/connectors, retrieval capabilities, dependencies, and tools selected by Thinking artifacts | No interaction unless route-changing discovery occurs mid-execution — then pause and inform. |
| 5 | Review | meta-prism checks upstream Critical, Fetch, Thinking, and result quality | If review finds issues that require user preference (quality vs speed trade-off), ask before proceeding. |
| 6 | Meta-Review | meta-warden verifies Review standard and public-ready gate | No interaction. Internal governance check. |
| 7 | Verification | run real tests with fresh evidence and `verificationPacket.fixEvidence` | No interaction. Run checks and record evidence. |
| 8 | Evolution | after Warden approval, directly edit the target agent definition or SOUL.md for meta-agent lessons; execution-agent gaps use `capabilityGapPacket` + Type B pipeline | No interaction. Record writeback decision. |

Autonomous discovery rule: for natural-language durable work, Fetch starts capability discovery from the entry classification itself. The user must not need to say "Critical", "Fetch", "Thinking", "Review", agent, skill, MCP, command, or tool for Meta_Kim to search local/global agents, skills, commands, MCP providers, runtime tools, plugins, hooks, and verification owners. Native choice gates may pause branch-changing execution, but they must not be the mechanism that first reveals missing discovery.

### Parallelism Boundaries

The 8-stage spine is the canonical order and every transition is a merge barrier: no next-stage lane starts before the active stage's merge node closes. Inside each stage, independent support, execution, review, verification, or candidate-analysis lanes use maximal safe parallelism under DAG dependencies, resource locks, permissions, isolation, useful-work, and host-capacity limits. Critical keeps one intent authority; Thinking keeps one route/DAG authority; Execution keeps one merge owner; Review keeps one findings verdict; Meta-Review keeps one Warden verdict; Verification keeps one evidence/claim authority; Evolution keeps one candidate merge and one approved durable writer. The machine authority is `config/contracts/core-loop-contract.json`; `references/dev-governance.md` explains it without introducing Stage 0, fixed waves, or competing strict-serial stage rules.

## User Interaction

**MANDATORY**: Use the current runtime adapter's verified native choice surface at key decision points. Keep the canonical card contract platform-neutral; renderer-specific schemas and tool names belong in runtime references such as `runtime-claude.md` or `runtime-codex.md`, not in the generic contract. For Codex and Claude Code, required branch-changing decisions must use `request_user_input` or `AskUserQuestion`; if that native interactive surface is unavailable, empty, rejected, stripped, or not deferred to host UI, block before Execution and return to Critical/Thinking. Only compatibility runtimes may fall back to a localized chat decision card, and that fallback must not be reported as a Codex or Claude Code popup.

False native choice claim guard: do not write that a popup, panel, or native surface was shown, used, returned empty, timed out, failed, or selected an option unless the current runtime adapter has returned matching evidence. In Codex, that means a `request_user_input` answer or `nativeChoiceSurfaceBlocked`; in Claude Code, that means an `AskUserQuestion` answer, deferred `AskUserQuestion` evidence, or `nativeChoiceSurfaceBlocked`. Cursor, OpenClaw, and other compatibility runtimes may report a fallback only as fallback. If the tool is unavailable, say blocked or pending, not "the choice panel did not return". Use the risk-adaptive plan-challenge overlay for explicit `反证` / `帮我挑刺` / `压力测试` intent or evidence-backed actionable irreversible, high-cost, permission-sensitive, or materially contradictory work. It stays inside Critical -> Fetch -> Thinking -> Review: Fetch facts, ask one highest-impact user decision at a time, remain pending without trusted user evidence, continue from a validator-passing same-task prior run instead of restarting the questions, support continue/recommend/skip/summary/stop, keep understanding separate from the single scoped `executionAllowed` side-effect gate, suppress ritual questions, and close in chat. Full interaction, state, trust, locale, and rhythm contracts live in `references/dev-governance.md`, `references/spine-state.md`, and `references/rhythm-orchestration.md`.

### Choice Dialog Style

Every decision-impacting point inside the governed route MUST be confirmed with the user through an AskUserQuestion / request_user_input dialog. Plain-text questions are not a substitute.

Typical decision-impacting scenarios:

- Multi-path selection (candidate approaches, artifacts to persist, Owner / Weapon / Dependency combinations)
- Persistence layer and write-back target
- Change scope, rollback, and continue vs. stop

Dialog layout — three blocks:

- Left option list with `❯` selection cursor, index, recommended label, and short description
- Right unicode preview using `┌ ┐ └ ┘ │ ─ ┃ ━` borders to draw routing / evidence / comparison schematics
- Bottom Notes line: `Notes: press n to add notes`

The top of the dialog is free — no required step indicator.

Trigger stages: Critical / Fetch / Thinking / Review.

**When NOT to pop** — symmetric guardrail to keep the dialog from becoming UI decoration:

- Pure informational confirmation where any short reply (y/n, ok, continue) is equivalent
- Single-word answers already implied by the prior context
- Low-risk follow-ups chained inside the same decision (e.g., "which file?" right after "which path?")
- User has already expressed a clear, unambiguous direction in the same turn

If in doubt, prefer one consolidated dialog over a chain of small ones. Do not ritual-question every micro-step.

Preview example:

```text
┌─[Critical] Decision Point ──┐
│ ❯ 1. All three (Recommended)│
│   2. Canonical only         │
│   3. Capability only        │
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │ canonical/agents        │ │
│ │ config/capability       │ │
│ │ package.json scripts    │ │
│ │   ↓                     │ │
│ │ Three-layer evidence    │ │
│ └─────────────────────────┘ │
└─────────────────────────────┘
Notes: press n to add notes
```

## Global-First Project Bootstrap

Reusable capability assets are global by default. Agents, Commands, MCP providers/config, hooks, skills, prompts/rules, and reusable runtime tools must be discovered from the global runtime homes first and reused directly when their contract fits. A project directory is not a second copy of the universal Meta_Kim runtime; it is a place for project context, merged local config, cache/state, evidence, and project-specific capability overrides.

Project-local capability files are allowed only when Fetch and Thinking prove a project-specific customization, iteration innovation, or dedicated override that cannot be represented by global reuse plus project state. The proof must be recorded before writing any project-local agent, Command, MCP, hook, skill, prompt/rule, or runtime adapter file.

Default source chain:

```text
installed Meta_Kim package root
-> canonical/ and config/sync.json
-> global runtime homes and capability inventories
-> project .meta-kim/state/cache/overrides evidence
-> project-local capability files only after projectCustomizationPacket approval
```

Required behavior:

- Before creating project-local capability files, run capability discovery across global runtime homes, project inventories, package scripts, MCP/tool catalogs, and existing local config. Reusable global assets win over copying files into the project.
- Project bootstrap may write project context/config/state: managed `AGENTS.md` / `CLAUDE.md` blocks, additive MCP/settings merges, `graphify-out/`, and `.meta-kim/state|cache|backups|local.overrides.json`. These are not evidence that reusable capability assets should be copied into the project.
- A project-local capability write requires `projectCustomizationPacket` with `capabilityType`, `globalCandidateChecked`, `projectNeed`, `customizationReason`, `targetPath`, `mergePolicy`, `owner`, `verification`, and `rollback`. If any field is missing, return to Fetch or Thinking.
- Project-local capability files must use one of these policies: `copy_to_project_for_modification`, `create_project_local_capability`, or `already_project_local`. Directly reused global capabilities use `use_global_directly` and must not be copied.
- 项目内迭代或创新需要专用能力时，必须创建在对应 runtime 的原生项目目录，不要再包一层 `.meta_kim` 或 `.meta-kim` capability 目录：Claude Code 用 `.claude/agents/`、`.claude/skills/<skill>/`、`.claude/commands/`、`.claude/hooks/`；Codex 用 `.codex/agents/`、`.agents/skills/<skill>/`、`.codex/commands/`、`.codex/hooks.json` + `.codex/hooks/`；Cursor 用 `.cursor/agents/`、`.cursor/skills/<skill>/`、`.cursor/rules/`、`.cursor/hooks.json` + `.cursor/hooks/`；OpenClaw 用 `openclaw/workspaces/<agent>/`、`openclaw/skills/<skill>/`、`openclaw/openclaw.template.json`。
- MCP、settings、hooks JSON、OpenClaw template, and other runtime config files are always merge targets. Add missing project-specific entries, preserve user entries and credentials, and never overwrite the whole file to "make it clean".
- Project-local capability assets created by Meta_Kim must leave ownership evidence: either a manifest entry in `.meta-kim/state/default/project-bootstrap.json`, a managed block, or a small `PROJECT_CUSTOMIZATION.md` next to the asset that names the `projectCustomizationPacket`, owner, verification command, and rollback path.
- Install scope and run-time sedimentation are independent. `setup.mjs` lets the user choose global or project installation; later governed execution must still copy every newly created or project-iterated Agent, Skill, or Command into the current project's native runtime directory. Use `meta-kim project capability copy ... --mode create|iterate --apply` before modifying a global provider or accepting a staged new provider. Its independent `.meta-kim/state/default/project-capabilities.json` ownership record protects that project copy from later dependency/global updates. Direct global reuse with no iteration remains read-only and is not copied.
- A normal global install/update must also merge-refresh current, explicit, or saved projects that already have a valid Meta_Kim project-bootstrap manifest. This does not materialize a fresh project projection, change update topology, add another confirmation, or authorize cleanup. Cleanup stays explicit. Packed CLI project discovery uses the trusted caller cwd rather than the package-cache root.
- Before any project bootstrap plan, write, stale cleanup, or explicit redundancy cleanup, read `.meta-kim/state/default/project-capabilities.json`. Agent, Skill, and Command paths marked `runtime_sedimented_project_copy` or `preserve_project_copy` outrank bootstrap/install ownership and must remain byte-for-byte untouched.
- During update/bootstrap cleanup, remove stale project-local capability assets only when previous Meta_Kim manifest evidence proves ownership and the current plan no longer manages that path. Unknown project files, user-created files, credentials, and merge config files are preserved; empty runtime capability folders may be pruned after their last Meta_Kim-managed file is removed.
- Hooks are last-resort fuses, not the normal design path. If a spine gate, ECC/fact gate, or runtime hook blocks repeatedly, return to Thinking and select the required abstract check/output contract before execution; do not rely on hook denial loops as the way to discover the right output.
- If the target needs initialization, update, or a project-specific override, ask the user through Claude Code `AskUserQuestion` or Codex `request_user_input` before writing. Compatibility runtimes may show a localized decision card, but that is not Claude/Codex native proof.
- Apply only after confirmation or an explicit trusted-auto policy. The apply path must create a backup under `.meta-kim/backups/project-bootstrap/<timestamp>` before overwriting or merging existing files and must write `.meta-kim/state/default/project-bootstrap.json`.
- Preserve user-owned content: JSON configs use additive preserve-user-state merge; existing `AGENTS.md` and `CLAUDE.md` keep user text and receive or update only a Meta_Kim managed block; credentials, project trust state, local runtime state, and workspace state are never copied as project bootstrap files.
- Stale, readonly, permission-denied, or conflicting managed-block cases are not success. Record the blocker, show the next safe action, and do not claim project bootstrap pass until a fresh probe or apply result proves it.

**When to ask:**

| Stage | When to Ask | Example |
|---|---|---|
| Critical | Intent dimension missing, answer changes route/scope/risk/non-goal | "This could be a quick fix or a full rewrite. Which direction?" |
| Fetch | Evidence shows multiple paths with different trade-offs | "I found approach A (faster) and B (more thorough). Which?" |
| Thinking | Choosing between solution paths with different scope/cost | "Minimal fix: 2 hours. Ten-x shift: 2 days. Your call?" |
| Review | Issues found that need user preference to resolve | "Quality concern: rebuild or patch?" |

**Question format:**
- Use the active runtime-native maximum meaningful option count; Meta_Kim must not add a lower option cap of its own
- One recommended default labeled clearly
- User's language, not internal packet field names
- For Codex, inspect the active `request_user_input` schema and use its maximum accepted meaningful option count. If the active host exposes 2-3 options per question, use up to 3; if a future or different host exposes more, use that larger maximum. If semantic options exceed the active host maximum, show the strongest host-maximum set and record omitted alternatives instead of retrying an oversized payload unchanged.
- The native payload is a structured decision panel: preserve AI understanding, AI additions, Capability route, Candidate paths, expected result, advantages, disadvantages/risk, and verification impact when those fields affect the decision.
- Stop and wait — do not proceed until the user answers

**Do not ask:**
- Ritual questions or stage-by-stage confirmation spam
- Just because the work is read-only; ask only when read-only analysis still exposes route-changing choices
- Questions during Meta-Review, Verification, or Evolution (these are mechanical checks)

## Type A: Prompt / Reference / Contract Hardening

Dispatch to `meta-prism` for prompt executability review and `meta-warden` for final gate. The main thread is not the executor. Use Agent tool dispatch when the task has more than a direct query or >3 sentences of change. Output: reviewed contract diff, `workerResultPackets[].fileCompletionList`, workerExecutionEvidence, and verification evidence.

## Type B: Agent / Skill / Owner Creation Or Upgrade

Dispatch to `meta-genesis` for identity/prompt architecture, `meta-artisan` for capability loadout, then `meta-prism` and `meta-warden` for review. Optional: `meta-sentinel`, `meta-librarian`, `meta-conductor`. Existing owner wins; owner upgrade or project-local creation is allowed only when Fetch proves a gap. Execution-agent evolution uses this Type B pipeline, not direct edit.

## Type C: External Capability / Tool / Dependency Discovery

Fetch scans local capability index, runtime mirrors, local runtime inventory, MCP, package scripts, installed skills, global capabilities, `findskill`, external capability discovery, specialist ecosystem search such as everything-claude-code, and `meta-scout` external evidence. Optional owners: `meta-prism`, `meta-sentinel`, `meta-scout`. Use Agent tool dispatch only after Thinking binds an owner; the DISPATCHER does not execute discovery side effects. If no callable owner exists, return to Thinking with `capabilityGapPacket`; do not use temporary fallback.

## Type D: Review / Verification / Rollback / Public-Ready

Dispatch to `meta-prism` and `meta-warden`; optional `meta-scout`, `meta-sentinel`, `meta-chrysalis`. Stage 4 owner prohibition: never dispatch Type: general-purpose, runtime alias, or governance agent as implementation worker. Public-ready requires verification evidence, userGoalDone, warning classification, and Warden gate.

## Type E: Orchestration / Business Flow / Release

Dispatch to `meta-conductor` for dynamic business-flow blueprint and stage-DAG orchestration, then `meta-warden` for synthesis. Conductor must classify the user's natural-language intent, choose lanes by evidence and dependency signals, record omitted lanes with reasons, and derive stage-ready sets only after dependency, resource, permission, isolation, and merge boundaries are known. Native Claude Code Agent/Task or Codex `spawn_agent` is sufficient when the stage DAG and owner bindings are valid; `agent-teams-playbook` may be selected as an optional orchestration aid but is never a prerequisite for safe native fan-out. Size concurrent ready sets from the runtime's current capacity and the task DAG rather than an arbitrary Meta_Kim hard cap; schedule the maximal safe subset instead of disabling all fan-out because one lane conflicts, and avoid role inflation. Use stop-on-match capability resolution: bind a qualified local/global Agent, Skill, Tool, Command, or MCP provider immediately, run external discovery only for a proven gap, and never relabel planned or selected capability as invoked without exact host evidence. Degraded mode requires a real host-surface, permission, isolation, resource, or owner gap.

The 11-phase business workflow must prove phase decisions, not only list phase names. `businessPhasePlanPacket` requires a trigger standard: every phase records whether it triggered, skipped, blocked, or waits; the phase decision must score at least 80 with quantitative signals, evidence references, and falsification checks. Accurate skips such as `revision` after a clean Review and waits such as `feedback` before user acceptance are valid only when the evidence explains them.

Card dealing must prove card decisions, not only list the deck. `cardPlanPacket` requires a deal accuracy standard: every card records whether it was dealt, suppressed, deferred, skipped, interrupted, or escalated; the decision must score at least 80 with quantitative signals, evidence references, and falsification checks. At run start and in the readable report, show a short card summary so the user sees why cards triggered without reading raw packets.

Routine Type E release work defaults to lightweight smoke when the change is low-risk prompt/docs/governance wording, changelog, or version metadata. Use `meta:release:smoke` plus `git diff --check`, then commit/tag/publish without upgrading unless risk or the user asks. Standard full-release Type E uses `meta:verify:all` for install/update, global sync, hooks, runtime matrix, provider registry, dependency compatibility, probes, package contents, security-sensitive behavior, or explicit full verification requests; a complete passing run permits an ordinary release. After a standard full release is published with its exact npm tgz asset, run `meta-kim release audit --tag <tag> --verification-report <report> --package-file <tgz> --require-exact`; keep every immutable attempt and attach the successful audit record to the Release. Exact promotion requires the uploaded tgz digest to match the byte-exact npm candidate installed and tested by that clean full gate; package name, version, or `package.json` alone are insufficient. A dirty or unavailable historical report may be indexed only as `published_artifacts_bound_verification_unbound` and must never be promoted. `meta:verify:live-certified` is a separate optional highest-assurance mode that appends private-attested external-observer exact-binding clean-room verification. Missing that attestation forbids only the `live-certified` claim and does not block a separately passing standard release. Detailed evidence chains live in `dev-governance.md`, `owner-resolution.md`, and `verification-evidence.md`. Validators, gates, and hooks are protection, not the engine; if they patch missing route evidence after the fact, return to Thinking before public-ready or release.

## Dispatch Self-Check
Before Execution, record the minimum Protocol-first Dispatch evidence: intent, Fetch evidence, a Thinking route, selected owner, owner loadout, memory strategy, Review standard, and the current `stageDagPacket`. Preferred compatibility views include `runHeader`, `dispatchBoard`, `businessFlowBlueprintPacket`, `agentBlueprintPacket`, `ownerDiscoveryPacket`, and Execution-stage `workerTaskPackets`, but hooks must not require every optional field before useful work can continue. `agentInvocationState`: `idle -> discovered -> matched -> requested -> dispatched -> returned/escalated`. `workerTaskPackets`, `parallelGroup`, and scheduler waves are derived Execution views of authoritative stage-DAG nodes; they must not become a second dependency or collision source. `ownerDiscoveryPacket` should list the relevant repo canonical owners, runtime mirror owners, project runtime agents, local global agents, and reusable skill/command/hook/rule/prompt/MCP/plugin/tool providers checked before a create or upgrade decision. Option Exploration is MANDATORY when materially different paths exist: compare ≥2 solution paths with Pros / Cons or Decision Record, or record `no_branching_choice` with evidence. Apply Skip-Level Self-Reflection Gate and Escalation Signals before dispatch.

## Fetch Evidence Inventory

Research -> Inventory -> Thinking Handoff. Fetch first records the question, source requirements, retrieval capability readiness, and multi-type capability inventory. Thinking determines needed execution capabilities after Fetch, matches existing capabilities, and creates or upgrades only for gaps. Fetch material claims include version, price, third-party, platform, current web state, dependency, provider, and tool assertions. If current facts matter, set `contentEvidencePacket.researchRequired = true`, run `researchCapabilityDiscovery`, and prefer `web_search`, `url_fetch`, `docs_lookup`, `browser_open`, `mcp_search`, or `plugin_search` before route design. Deep research must identify key information targets, run iterative query / read / update loops, record stop conditions, update `decisionImpactMap` when evidence changes owner/route/scope/risk/verification, and convert route-changing claims into `claimEvidenceCards` with source refs, counterevidence, confidence, and falsification status. If research is blocked, return `blocked` with `user_fallback` rather than guessing. Run command/script discovery by package.json script scan and npm run inventory. Apply DRY conflict detection: overlap detect, duplicate reject, and keep one owner per capability. Capability selection ROI = (Task Coverage x Usage Frequency) / (Context Cost + Learning Curve).

Global professional provider first: a governed route must prefer already-discovered professional capability providers over inventing temporary small agents. Global execution agents, skills, MCP providers/tools, commands, runtime tools, hooks, plugins, memory/graph providers, and dependency providers are candidate professional owners or weapons when their contracts fit the task. `workerTaskPacket` is only a run-scoped work order for a selected professional owner/loadout; it is not an agent, not a subagent identity, and not a durable provider. For explicit agent fan-out, each executable lane must bind a reusable execution-agent owner first; selected skills, commands, MCP tools, and runtime tools are loadout/dependency bindings and must not replace the lane's agent owner. A runtime worker instance is allowed only after this owner binding exists, and the visible dispatch surface must name the reused owner/capability before or alongside any host-created worker badge. Create or upgrade an execution agent only after Fetch proves no existing global or project provider can own the recurring responsibility class, and only through `GapDecision = create_agent` plus the Type B review path.

Fetch discovery minimum checklist: before Thinking, search at least these locations (even if results are empty):
- canonical sources and capability indexes: `canonical/agents/`, `canonical/skills/`, `canonical/runtime-assets/`, `config/capability-index/*.json`, and runtime capability-index mirrors
- Claude Code project and global inventories: `.claude/agents/`, `.claude/skills/`, `.claude/commands/`, `.claude/hooks/`, `.claude/settings.json`, `~/.claude/agents/`, `~/.claude/skills/`, `~/.claude/commands/`, `~/.claude/hooks/`, and `~/.claude/settings.json`
- Codex project and global inventories: `.codex/agents/`, `.agents/skills/`, `.codex/commands/`, `.codex/hooks/`, `.codex/hooks.json`, `.codex/config.toml`, `~/.codex/agents/`, `~/.codex/skills/`, `~/.codex/commands/`, `~/.codex/hooks/meta-kim/`, `~/.codex/hooks.json`, `~/.codex/config.toml`, and `~/.agents/skills/`
- Cursor project and global inventories: `.cursor/agents/`, `.cursor/skills/`, `.cursor/rules/`, `.cursor/prompts/`, `.cursor/hooks/`, `.cursor/hooks.json`, `.cursor/mcp.json`, `~/.cursor/agents/`, `~/.cursor/skills/`, `~/.cursor/rules/`, `~/.cursor/prompts/`, `~/.cursor/hooks/meta-kim/`, and `~/.cursor/hooks.json`
- OpenClaw project and global inventories: `openclaw/workspaces/`, `openclaw/skills/`, `openclaw/hooks/`, `openclaw/openclaw.template.json`, `~/.openclaw/openclaw.json`, `~/.openclaw/workspace-*`, `~/.openclaw/skills/`, `~/.openclaw/hooks/`, and `~/.agents/skills/`
- runtime package and command providers: `package.json` scripts, local scripts, runtime commands, hooks, validators, prompts/rules, setup/status/doctor/sync/install routes
- `.mcp.json`, runtime MCP config such as `.codex/config.toml` and `.cursor/mcp.json`, MCP server/tool inventory, and connector/plugin inventories
- `config/runtime-capability-matrix.json`, `config/os-compatibility-matrix.json`, `config/capability-index/dependency-project-registry.json`, and dependency/external package registries
- retrieval capability inventory: `web_search`, `url_fetch`, `docs_lookup`, `browser_open`, `mcp_search`, `plugin_search`, `local_only`, and user-supplied source paths

Pass condition: `fetchPacket.capabilityDiscovery.searchLog` exists with checked sources and results, including empty or unavailable source entries; `fetchPacket.capabilityDiscovery.capabilityInventory` covers all capability types and all runtime-specific paths that affect the route; and planned file mutation records `fileChangeFactCard`; detailed schema lives in `dev-governance.md`.

Fetch angle decomposition: for research or analysis tasks (when `contentEvidencePacket.researchRequired = true`), decompose the core question into N semantically distinct search angles before searching. Each angle must target a different aspect; rephrasing the same angle is forbidden. Output: `contentEvidencePacket.searchAngles = [{angle, keywords, expectedCoverage}]`. Default N=3; increase for complex multi-domain questions.

Decision-grade research synthesis: Fetch must turn external research practice into Meta_Kim-native evidence, not copy another project's prompt text, template, command examples, or visible structure into canonical governance. For research-required runs, record `contentEvidencePacket.deepResearchPlan` with the user's decision use, 3+ distinct sub-questions, planned source classes, key-source deep-read targets, source-quality ladder, claim attribution rules, cross-check strategy, original-synthesis rules, and decision-impact criteria. Search volume is not evidence; at least one material claim must map to owner, route, scope, risk, acceptance, blocker, or rejected path before Thinking can use it. Search snippets alone are insufficient for route-changing claims; Fetch must deep-read the strongest available primary or official sources and flag single-source claims as unverified. External methods may be cited in private research notes, but durable Meta_Kim prompts keep only abstract invariants: question decomposition, source breadth, key-source reading, citation discipline, contradiction handling, assumption ledger, and Thinking handoff.

Graphify knowledge policy: Graphify is an agent capability, not a context dump. At run start, check only whether `graphify-out/graph.json`, `graphify-out/GRAPH_REPORT.md`, or wiki indexes exist; do not run a global freshness check or rebuild just because a graph exists. For focused questions, prefer `graphify query "<question>"` with a small budget, `graphify path "<A>" "<B>"` for relationships, or `graphify explain "<concept>"` for concepts; use `GRAPH_REPORT.md` only for broad architecture orientation or when query/path/explain do not surface enough context. Treat Graphify output as candidate navigation, not truth: if results are generic, stale, polluted by generated/local state, or route-changing, fall back to targeted repository search and read the target source files before deciding. Inject only worker-relevant graph slices, short hints, and file anchors; never inject the full `graph.json`, full `GRAPH_REPORT.md`, or broad graph dumps into every worker. After code, canonical, contract, or runtime-facing doc mutation, rebuild Graphify in Verification/Evolution; reserve `meta:graphify:check` for verification, release, public-ready, or explicit graph validation.

Execution-agent identity must stay abstract and provider-first. Durable `executionAgentCard` content may describe a reusable capability class, boundaries, abstract dependencies, inputs, and outputs; it must not contain repo paths, file lists, tickets, one-run work instructions, `todayTask`, `scopeFiles`, `deliverableLink`, or `verifySteps`. Match existing agents, skills, commands, hooks, rules/prompts, MCP tools, runtime tools, and plugins before creating or upgrading an execution agent. Put concrete work in `workerTaskPackets`, `capabilityBindings`, and `orchestrationTaskBoardPacket` only. If a card cannot be written without concrete task binding, return to Thinking and reuse an existing owner/provider or emit `capabilityGapPacket`. When `GapDecision = create_agent`, require a `GeneratedAgentSpec` review artifact with flow position, handoff, loadout slots, scoped memory, gap policy, verification policy, install projection, and identity-cleanliness proof before any agent file is written.

Temporary small-agent prohibition: do not create a new agent merely to execute this run's task, shard, file set, or role instance. If the work is one-run, keep it in `workerTaskPackets` and bind it to an existing professional provider. If the work is recurring but the best global provider is partial, prefer `upgrade_existing_owner` or a project-local professional profile over a throwaway runtime agent. A runtime adapter may expose a coarse role name for host routing, but it must not become the professional owner unless it has its own reviewed capability contract.

Capability scan UX: full global scans happen on install, update, explicit refresh, missing cache, cache older than 14 days, missing required provider, or high-risk provider routes. Normal execution reads cached global inventory, performs a lightweight project scan, shows only counts/top candidates/source refs, and avoids dumping full provider definitions into chat. If the last full scan is older than 2 weeks, tell the user this run will update first to match newly added content and reach the best capability route, then refresh before execution.

## Warden Entry Gate

Governed meta-theory entry enters through `meta-warden` entry gate, whether it was triggered by ordinary natural language or by an explicit maintainer shortcut. Then `meta-conductor` owns the evidence lane and sequencing, `meta-scout` owns external evidence, and `meta-prism` audits Critical, Fetch, and Thinking quality before output polish. All meta agents are dispatch targets: `meta-warden`, `meta-conductor`, `meta-scout`, `meta-artisan`, `meta-genesis`, `meta-sentinel`, `meta-librarian`, `meta-prism`, `meta-chrysalis`.

## Product Reasoning Contract

Translate the surface request into the real product problem. Compare minimal fix against ten-x path challenge and path shift. Final user-facing closure states the root goal, what this run did, whether it still fits the root direction, whether delivery is complete or partial, chosen rationale, why changed / why change, what changed, where changed, user impact, verification, complexity added or avoided, remaining limits, deferred work, and next action.

Product-route or strategy-unclear requests must not automatically expand into a full product build. When the user's real question is "which route should I take?", first design a decision protocol and minimum evidence bench: candidate routes, required evidence, first experiment, pass/kill signals, time box, and review checks. A UI, backend, database, automation, or full app lane starts only when the user asks to build, evidence proves the route, or Thinking records why implementation is now the smallest useful test.

Repository or product-doc cleanup requests must first separate change pressure from durable architecture. Before suggesting directory moves, classify the current work into change trains and source layers: source layer, projection layer, evidence layer, and reader layer. Record whether scripts or commands are read-only, generate state, sync runtime projections, install/update dependencies, or run live/slow checks. Do not treat "many files visible" as proof that directories should be moved; first decide which layer the confusion belongs to.

## Decision Cross-Validation Gate

For PR, issue, release, compatibility, public-ready, or skill-prioritization decisions, the answer must survive adversarial cross-validation before it is treated as done. Record the evidence snapshot time, source state matrix, confidence labels, counterevidence, contradiction log, falsification checks, and replay commands. Re-check current external state when it can change, such as open PRs, open issues, comments, labels, review state, release status, package versions, or platform support.

Decision recommendations must bind one primary risk lane and at most one secondary lane to the next executable gate. For example, runtime/setup/install/sync changes bind to cross-runtime contract design; localized routing or choice-surface changes bind to multilingual QA; review finding or release-closure work binds to review closure discipline; hook/dispatch/state/validator changes bind to state-machine failure modeling. When two lanes compete, choose by failure cost: user install/runtime breakage, wrong execution or repeated hook blocks, incomplete public closure, then localized user route failure.

Fail the gate if the decision relies on stale PR/issue state, a single source with no countercheck, unlabeled inference, unverifiable "verified" claims, command-pass equals user-goal-done, or four equal priorities with no next action. A cross-validatable decision must let an independent reviewer replay the evidence and either reach the same conclusion or see exactly which contradiction changed the route.

## Human-Readable Stage Feedback

Stage updates must be compact, human, and in the resolved user language. Record internally with packet field name / internal keys and debug traces, but show human label and human-readable label in user-facing output. Mention Critical, Fetch, Thinking, Review only when the stage status matters. Keep token use low and avoid dumping raw packet fields unless the user asks for debug.

Public status surface uses `runStatusEnvelope`, `publicLabels`, `.meta-kim/state/{profile}/active-run.json`, and `.meta-kim/state/{profile}/runs/{runId}/status.json`. Apply runtime/tool selected output language first, then latest input language. Do not hardcode labels. The public notice must not expose internal protocol fields such as `Preflight` or `conversation_fallback` unless debug is requested.

Host-visible notice rule: in Codex App and Claude Code, a governed run must say the important progress information in normal assistant chat, in the resolved user language. HookPrompt / `additionalContext`, `systemMessage` warnings, CLI artifacts, JSON packets, and markdown reports may help the model or maintainer, but they do not count as user-visible progress unless the assistant also renders the notice in the conversation. HookPrompt is prompt-intake context only: it must not be treated as active-run authority, Fetch evidence, Thinking evidence, workerTaskPacket evidence, execution evidence, verification evidence, or public-ready proof. Required visible moments are run start, route selected before Execution, blocker/degraded state when present, and closure. Keep each notice to at most three information blocks; nested human-readable details inside those blocks must preserve stage/current work, owner/capability, result, risk or blocker, verification, and next action. Do not reduce chat guidance merely to shorten the notice; move only raw packet keys and duplicate telemetry to report/debug. Use native choice surfaces only for branch-changing decisions, not for routine status.
The governed runner must emit ordered conversation progress snapshots at run start, Fetch completion, Thinking route lock before Execution, Execution planning, Review snapshot, and closure. Do not call a snapshot a completed eight-stage runtime boundary unless host evidence proves that boundary. Host adapters consume progress through the API callback or stderr progress channel and relay it into normal assistant chat; stdout remains a single machine-readable final JSON summary. A final three-block aggregate remains available for user summary and audit. The blocks must show final artifact status and readable partial reasons, actual orchestration owner, selected provider bindings with invocation state, planned/structural versus host-observed mesh truth, and control graph nodes/edges/state/checkpoints. A sentence claiming that these are visible is not evidence by itself.
Governed run identity is a filesystem boundary. Validate every requested or latest-file `runId` with a strict filename-safe allowlist and a resolve-within-output-root check. A caller-provided ID that already exists must fail by default; overwrite requires an explicit API/CLI authorization and must be recorded in the artifact. Update `latest.json` through same-directory temporary write plus atomic rename so readers never observe a partial pointer.
Fetch anti-churn rule: do not start Critical or Fetch by creating, updating, or narrating a host task/todo board. In Claude Code, `TaskCreate`, `TaskUpdate`, and `TodoWrite` are continuity aids after useful evidence exists, not the first Fetch action and not user-visible progress. If the run needs continuity, say a short localized status in chat, then batch read/search the next evidence files. Planning files and spine-state writes are allowed only when they preserve route-changing continuity; they do not replace visible progress or Fetch evidence.
User experience truth boundary: users should not need to run `npm` scripts, inspect JSON, or know packet names to understand a governed run. Internal artifacts such as `ownerDiscoveryPacket`, `orchestrationTaskBoardPacket`, `workerTaskPackets`, and command output are evidence, not the user experience itself. When reporting orchestration, show compact localized notices for progress, route, owner handoff, blockers, and verification, and explicitly avoid claiming that users can experience a feature when it only exists as an internal artifact or maintainer-only command.

Natural-language trigger rule: the user does not need to ask for stages, agents, skills, MCPs, commands, packets, or reports. If a normal human task triggers meta-theory, the dispatcher must automatically translate the internal route into a plain-language stage plan: what this stage does, what capability/loadout will be used, what result the user will see, and what starts next. Technical names may appear only as a compact backing loadout for traceability; the primary explanation must read like an operation handoff, not a protocol dump.
Interactive execution communication: during multi-stage work, the dispatcher must report progress to the user at natural transition points — not only at the pre-decision gate. Report triggers: (1) Fetch complete — brief evidence summary and route impact, (2) Thinking complete — chosen path and trade-offs, (3) each Execution phase complete — what was done and what remains, (4) Review findings that change scope — surface them immediately, (5) route-changing discovery mid-execution — pause and inform. Each report is a compact notice with at most three information blocks, with nested details allowed when needed to keep the user informed; it is not a full packet dump. If the discovery changes scope, owner, or risk, upgrade the notice to a Decision card requiring user input. This "communicate while working" pattern keeps the user informed and in control without requiring them to ask for status.
Meta-theory visible surface: when the user explicitly triggers meta-theory or the task enters governed execution, the user-facing output must expose a compact orchestration surface before or alongside execution. It must name the orchestration owner/board, Dynamic Workflow lane choice, capability discovery beyond Skill, peer agent mesh / handoff shape, and LangGraph-style node-edge-state-checkpoint shape. Do not hide these behind `coreLoop`, JSON, packet names, or generated reports only. If a runtime cannot show this surface directly, state the blocked/degraded surface and provide the readable report artifact; do not claim P-104 user perception pass from hidden artifacts alone.
Capability invocation truth: every governed run that names agents/subagents, app-visible host UI subagents, skills, MCP, hooks, prompts/rules, commands/scripts, runtime tools, memory, graph, `agent-teams-playbook`, or worker tasks must classify each capability family as `invoked`, `applied`, `host_visible_observed`, `selected_not_invoked`, `discovered_not_selected`, `unavailable`, `not_authorized`, `blocked`, or `not_required`. `invoked` requires fresh externally observed invocation evidence joined to every exact selected `family + provider + task/lane` binding. A selected skill, selected `agent-teams-playbook` provider, configured MCP server, matched hook, command candidate, runtime tool candidate, readiness probe, or runner-generated worker plan is not invoked. Prompt/rule behavior is `applied`, not an external tool call. Host UI subagent badges are `host_visible_observed`, not Meta_Kim runner `spawn_agent` / `Agent` invocation. `capabilityInvocationProbePacket` reports readiness only and never satisfies `realInvocationCoverage`. Product-experience pass requires `realInvocationCoverage.status=pass`, a `live_host_observed` evidence tier, and zero missing bindings; `selected_not_invoked` is never execution pass. Live evidence must come from a hash-verified external host observation artifact with matching run/session/event/provider/binding/timestamp/result fields. Fixtures, self-tests, public CLI trust flags, synthesized worker results, and generic caller-authored JSON are forbidden substitutes. `hostInvocationRequestPacket` is a handoff, not proof. If no real runtime Agent/subagent tool call is available or attached, record whether the host tool is unavailable, blocked by authorization, not required, or merely selected_not_invoked; keep peer workers as structural plans and do not call them live subagents or peer-to-peer runtime agents. If `agent-teams-playbook` is selected, record it separately as `agent_teams_playbook=selected_not_invoked` unless a live Skill/Agent Team/spawn_agent call is externally observed.
User execution presentation is separate from exact-binding and live-certification audit. In normal Codex App or Claude Code chat, the active host renders the actual current-turn native tool results directly: all returned subagent calls mean called/completed; at least one returned call plus at least one failed, missing, or blocked call means called with partial failures; and a zero-success native result says failed, denied, or blocked according to that result. `unavailable` is reserved for a genuine zero-call capability boundary such as an unsupported surface or missing provider, with zero successful bindings and zero strict failed bindings. A missing audit association never erases a successful current-turn call. The Node runner does not accept a lifecycle-evidence/trust bridge for presentation and does not claim automatic host-failure ingestion: its artifact projection uses only the existing strict truth packet. Without private verified failure evidence, denied/blocked/failed offline input stays pending. CLI flags, environment variables, caller-supplied subagent names, UI badges, and generic JSON remain unverified hints and cannot produce called/completed or a verified failure. Users never provide evidence flags, session ids, or event ids. Normal chat, Markdown, and panel text must keep the useful guidance but speak at task level: state the call result, whether the run record is linked, and that an optional additional independent review does not alter the calls already made. Do not expose exact-binding/live-certification wording, provider ids, or lane terms there; raw rows, state counts, binding coverage, and exact evidence stay in the strict audit packet/debug surface.

Assistant-message visibility is also not caller-promotable runner state. Runner-side assistant-message records may diagnose expected hashes, but they always remain `host_observation_required`; arbitrary JSON or an API trust boolean cannot mark the conversation visible. Normal Codex/Claude chat visibility comes from the active host conversation itself. The governed runner exposes no caller trust input for invocation evidence. Without the separate private observer/verifier, its strict audit result stays pending; the fail-closed validator helper may be exercised by focused tests but cannot directly mint user-facing called/completed or live-certified labels. The runner does not claim a production path from caller failure JSON to verified failure. Presentation may use failed/denied/blocked only when the strict truth packet already contains verified `failedBindings`; those bindings affect failure presentation only and never satisfy invoked success, coverage pass, completed, or called. Current native chat instead reports the actual tool result directly, while offline artifacts without external verification remain pending.

## Dynamic business-flow capability matrix

Fetch expands executable deliverables into a Business-flow capability matrix by intent signals, not by a fixed template. The candidate lane universe may include product, research, content, UX, UI, frontend, backend, database, integration, security, motion, accessibility, browser QA, performance, release, feedback, and evolution. Thinking selects only the lanes justified by the current task, records omitted lanes with reasons, binds dependencies and merge owner per selected lane, and uses fan-out / synthesize / adversarial verification when the task has independent work streams.

For strategy, product-route, prioritization, roadmap, or "I do not know what to build first" asks, the default selected lane is a decision-protocol lane, not implementation. Its output is a route judgment card: user/value frame, 2-3 candidate routes, evidence needed for each route, first experiment, pass/kill signal, and next review gate. Mark UI/frontend/backend/database/integration lanes as omitted unless they are the smallest experiment or explicitly requested.

Selected dynamic lanes must synthesize project-scoped agent profiles from the current project profile and capability requirements. Thinking records them in `projectAgentBlueprintPacket` with `ownerMode = project-agent-profile`, a pinned `capabilityProfileId`, `capabilityLoadout`, `roleSoulPolicy`, project memory strategy, `externalEvidencePolicy`, `localBaselineComparison`, and `knowledgeGraphPolicy`. Current external claims such as platform rules, provider/API capability, dependency versions, pricing, compliance, security, release, or third-party workflow feasibility require source-backed Fetch evidence through `web_search`, `url_fetch`, `docs_lookup`, `browser_open`, `mcp_search`, or equivalent runtime retrieval before route lock; if that evidence is unavailable, block or return to Fetch instead of guessing. Every selected lane must also compare against local reality before dispatch: canonical agents/skills/contracts, capability indexes, runtime mirrors, package scripts, MCP configs, OS/runtime matrices, project memory, and graph navigation slices when available. Execution then calls the selected real provider surfaces when the host exposes them: agents/subagents, skills, MCP tools, commands/scripts, runtime tools, prompts/rules, or bounded run-scoped workers. A degraded structural runner may create only run-scoped worker instances and must mark uncalled selected providers as partial rather than pass, plus emit `hostInvocationRequestPacket` so the host adapter knows the exact calls still required. Capability updates change the capability profile for future runs; in-flight workers keep the pinned profile. A synthesized profile becomes a durable high-quality project agent file only through `GapDecision = create_agent` plus the Type B `GeneratedAgentSpec` review path. Durable-agent completion needs the `durableAgentLifecyclePacket` chain: definition candidate, Warden approval/writeback, host reload/discovery, and live invocation proof.

## Evolution target map

| Gap type | Evolution target |
|---|---|
| prompt gap | canonical skill or reference contract |
| agent boundary gap | target agent definition / SOUL.md |
| capability gap | `capabilityGapPacket` then Type B owner upgrade |
| dependency gap | dependency registry and compatibility validator |
| runtime/OS gap | runtime matrix or OS matrix |
| warning/hook scar | validator, hook policy, regression test |

## Stage packet table

| Stage | Required packet | Pass condition |
|---|---|---|
| Critical | `intentPacket`, `taskClassification` | outcome, success criteria, non-goals, permissions, blocking unknowns recorded |
| Fetch | `fetchPacket`, `foundationalCapabilityPreservationPacket`, `dependencyCapabilityAuditPacket`, `fileChangeFactCard` when mutation is planned | evidence changes route/risk/owner/verification or records no-impact; planned file changes have purpose, consumer, overlap, data-shape, and user-instruction evidence |
| Thinking | `dispatchBoard`, `workerTaskPackets`, `routeScoreBreakdown` | selected route has owner + weapon + dependency policy + runtime + OS + verification owner; worker tasks bind target files to their consumer and delivery contract |
| Execution | `workerResultPackets`, `workerExecutionEvidence` | bounded tasks produce declared artifacts and evidence |
| Review | `reviewPacket.findings` | upstream Critical/Fetch/Thinking and output quality are reproducibly checked |
| Meta-Review | review-standard checks on `reviewPacket` | Review catches native/foundational/dependency/intent/public-ready/evolution risks |
| Verification | `verificationPacket`, `verificationEvidence` | fresh commands/logs/artifacts/human acceptance bind claims |
| Evolution | `evolutionWritebackPacket`, `scarPacket` | writeback or `none-with-reason` with next-run reuse key |

## Required Fetch config

Before Execution, inspect the relevant local source of truth:

- `config/runtime-capability-matrix.json` for Claude Code, Codex, Cursor, OpenClaw support.
- `config/os-compatibility-matrix.json` for macOS, Windows, Linux, WSL2 support.
- `config/capability-index/weapon-registry.json` for weapons.
- `config/capability-index/dependency-project-registry.json` and `.meta-kim/state/default/dependency-capability-index.json` for dependencies.
- `config/skills.json`, runtime projections, MCP configs, hooks, package scripts, Graphify, Memory, and repository search for foundational capabilities.

## Abstract foundational capability triggers

Do not narrow Meta_Kim to a few named skills. Treat named packages such as `findskill`, `hookprompt`, `planning-with-files`, and `skill-creator` as examples inside a wider abstract capability surface described by `config/contracts/prompt-abstract-capability-contract.json`.

Hardcode capability families and conflict rules in prompts; discover concrete providers at run time:

| Capability family | Trigger in the prompt | Conflict boundary |
|---|---|---|
| `governance-orchestration` | Durable planning, governance, review, verification, prioritization, repair, runtime, or release work | Governance agents route and review; they do not become generic implementation workers. |
| `capability-discovery-and-retrieval` | Owner, tool, dependency, current fact, provider, or verification path affects the route | `findskill` and external search are run-scoped Fetch inputs, not permanent agent identity bindings. |
| `prompt-intake-optimization` | User prompt submission or prompt optimization request | `hookprompt` may add prompt context and, when the runtime emits a mandatory foreground prompt-understanding block, that block must be rendered before Meta_Kim route notices or native choice surfaces. It is prompt-intake context only and must not override user intent, PRD decisions, meta-theory route, planning state, later progress notices, active-run state, Fetch records, Thinking packets, workerTaskPackets, execution evidence, verification evidence, or public-ready claims. |
| `planning-continuity` | Non-query durable work needs resume, progress, evidence, route, or acceptance continuity | Planning files are update-only continuity state: append, refine, or mark superseded; do not overwrite or reset `task_plan.md`, `findings.md`, or `progress.md`. Host task/todo boards must not be the first Fetch action; use visible chat status plus evidence reads before task bookkeeping. |
| `skill-agent-tool-creation` | Fetch proves a reusable capability gap after existing providers are checked | `skill-creator`, create-agent, or tool creation starts only after gap proof, review, and Warden-approved durable writeback. |
| `runtime-native-surfaces` | Runtime-facing route, projection, hook, command, skill, agent, MCP, choice, sandbox, or approval behavior | Preserve native, partial, unknown, and blocked states; do not fake or replace runtime-native abilities. |
| `execution-tools-and-commands` | Real execution, file edits, browser/UI proof, command output, or validator/test evidence is needed | Select tools by owner, permission, runtime, OS, and verification; command pass is evidence, not user-goal completion. |
| `mcp-external-provider-and-plugin` | External data, external tool, provider SDK, plugin, connector, dependency, or MCP affects the route | Configured or installed providers are not live proof; external writes, credentials, paid actions, and mutations need approval and verification. |
| `memory-graph-and-observability` | Prior decisions, project map, graph freshness, run state, trace, or evidence continuity affects route or acceptance | Memory and graph guide navigation; verify route-changing claims against source files or fresh artifacts. |
| `safety-hooks-and-permissions` | Unsafe mutation, missing dispatch evidence, hook loop, install/update, sandbox, approval, or credential risk appears | Hooks are last-resort fuses, not planners; repeated blocks return to the responsible stage. |
| `verification-eval-and-release` | A prompt, route, runtime, release, or user goal is claimed complete | Do not relabel smoke, config validation, skipped, needsAuth, or old artifacts as live/release-grade proof. |
| `user-interaction-and-i18n` | Route-changing ambiguity, user choice, progress notice, or output-language handling is visible | Ask only route-changing questions and preserve locale; renderer schemas stay in runtime adapters. |

## Native ability preservation

Governance may add trigger, evidence, trust review, approval, sandbox, fallback, verification, and risk boundaries. It must not delete, downgrade, or replace runtime-native abilities for Claude Code, Codex, Cursor, or OpenClaw. Unknown or partial native abilities stay `unknown` or `partial` until verified; they are not removed.

Provider-registry truth has four separate layers. `providers[*].support` is the only durable runtime-claim authority, while `runtimeAdapters` is a mechanically checked projection of it. Provider selection is run-scoped and must never be persisted as a registry fact. Availability comes only from the target runtime's support state and install-layer evidence; a projection file does not prove availability. Native support belongs only to a provider's declared target runtime, and live execution requires a fresh verification artifact. Runtime-specific providers must be `blocked` with `unsupported` layers and no activation event on every non-target runtime; never copy a Claude, Codex, Cursor, or OpenClaw trigger or `verified` label across runtimes.

## Foundational capability preservation

Do not delete or hide existing Skills, WebSearch, web search, browser, online research, fetch, filesystem, shell, command, apply_patch, edit, MCP, memory, Graphify, graph, hooks, scripts, validators, commands, rules, agents, subagents, approval, sandbox, permission mode, runtime tools, setup, uninstall, status, doctor, sync, install, or verification capability. If a capability is risky or unavailable, mark `needs_probe`, `unknown`, `partial`, `requires_approval`, `requires_trust_review`, `reference_only`, or `not_for_execution_route`.

## Dependency compatibility

Dependencies are retained and routed by state, not deleted by score.

- score `<50`: `blocked_for_execution`, evidence/reference only, generate upgrade/probe suggestion.
- score `50-69`: `needs_upgrade_or_probe`, no automatic execution.
- score `70-84`: `confirm_or_fetch_more`, requires user confirmation or more evidence.
- score `>=85`: eligible only with invocation path, verification method, owner, weapon, runtime support, OS support, and verification owner.

`Kim_Decision` is a decision protocol candidate, not a code executor. Discover it through `META_KIM_DEP_ROOTS`, sibling repo scan, installed skill paths, registry, or external reference. Never hardcode a personal path. Valid states: `local_inspected_protocol`, `installed_skill_candidate`, `external_reference`, `internalized_pattern`, `blocked`, `not_for_code_execution`, `eligible_for_decision_route`, `needs_probe`.

## Execution gate

Execution may start only when the key behavior gate is true (or degraded mode is explicitly active with recorded degradation reason). Hooks enforce this minimum; fuller packet shape is validated by validators and Review:

- `realIntent`, success criteria, non-goals, and blocking unknowns are recorded.
- Fetch evidence and capability discovery are complete enough for the chosen path.
- Existing-owner discovery has checked enough available agents, skills, commands, MCP tools, runtime tools, and prompt/rule providers to justify the selected owner/loadout; skipped sources appear as blockers or no-impact evidence.
- Route score is `>=85`, or a branch-changing user choice accepts a `70-84` route; simple single-path work may record `no_branching_choice`.
- Owner is not `general-purpose`, not a runtime alias, and not a governance agent acting as implementation worker.
- Owner has a usable loadout: skill, command, MCP capability, runtime tool, normal tool, or abstract prompt.
- Runtime/OS support is not known-unsupported; unknown or partial support is recorded with a probe/degraded route.
- Memory strategy exists (`project_only`, `cross_project_readonly`, `none-with-reason`, or equivalent).
- For file mutation, the current content of every target file has been read in the same execution turn before editing, and `fileChangeFactCard` exists with each target file's consumer/distribution path, overlap decision, and data-shape note when applicable.
- Review standard is known. Verification owner, rollback, dependency eligibility, and detailed packet fields are required for public-ready, not as universal hook blockers.

Worker output schema validation: when `workerTaskPacket.output` defines an expected structure, the dispatcher (or receiving agent) must validate the worker result against that structure before accepting it. On mismatch, the worker retries (up to 2 attempts) before reporting failure. Record `workerResultPacket.schemaValidationAttempts = [{attempt, passed, violationDetail}]`. This prevents format drift between Thinking's output contract and Execution's actual return.

## Review gate

Review must check upstream chain before output polish:

- Critical locked the right user outcome and success criteria.
- Fetch evidence changed or justified the route.
- Thinking selected owner + weapon + dependency + runtime + OS + verification.
- Planned file changes were preceded by reading the target files and justified by `fileChangeFactCard`; no new file exists only because the worker found a convenient place to write.
- Execution evidence is reproducible.
- No foundational capability or runtime-native ability was deleted or downgraded.
- No reference-only dependency entered execution.

Adversarial verify pattern: when Review runs for `regulated_path` or when the user requests cross-check, spawn N independent skeptic reviewers (default N=3). Each skeptic receives a different lens (correctness, security, completeness) and must explicitly try to refute each finding. A finding survives only if a majority (>= ceil(N/2) refutations fail). Record per-finding vote tallies in `reviewPacket.findings[].adversarialVotes = [{lens, verdict, refutationEvidence}]`. In degraded mode, the main thread applies the same checklist with `degradedFlag: true` and records self-assessment as one vote (not a majority).

## Verification gate

Do not claim verified unless a command, log, artifact, or human acceptance record supports the claim. Command pass is not `userGoalDone`. Template validation is not strict run validation.

Runtime-live and `live-certified` evidence are stricter than structural checks; smoke, config validation, UI/systemMessage output, auth-present checks, and skipped/needsAuth states cannot be relabeled as live pass. Routine low-risk releases may ship after the smoke path, and standard releases may ship after a complete passing `meta:verify:all`. Only the optional `live-certified` label waits for the private-attested exact-binding evidence chain in `verification-evidence.md`.

## Evolution gate

Every run still records `writebackDecision = writeback` or `none-with-reason`, but Evolution is removed from the default execution scaffold. When no reusable capability gap, repeated failure scar, agent/skill/tool/MCP/hook/workflow/runtime/OS lesson, governance-contract change, or explicit durable-learning request exists, close inline with `none-with-reason` and do not dispatch Chrysalis or candidate-analysis lanes. Durable failures still require a scar with `failurePattern`, `preventionRule`, `test`, and `nextRunReuseKey`. Triggered Evolution writeback needs Warden approval; Chrysalis coordinates; target owners update their own sources.

## Reference loading

Load only references needed for the run:

- `path-selection.md`: route scoring and path bands.
- `owner-resolution.md`: owner + weapon + dependency route.
- `runtime-codex.md`: Codex-specific sandbox, approval, subagent, hook, and choice behavior.
- `runtime-claude.md`: Claude Code-specific native question surface, Agent / Skill / Command / prompt / MCP dispatch, and no-self-execution behavior.
- `verification-evidence.md`: verified claim and public-ready evidence.
- `intent-amplification.md`: real intent, first action, pass/kill, userGoalDone.
- `evolution-writeback.md`: writeback, scars, reuse keys.
- `rhythm-orchestration.md`: choice/card timing.
- `planning-files.md`: `task_plan.md`, `findings.md`, `progress.md`.
- `create-agent.md`: new/changed owner design.
- `spine-state.md`: stage state and packet transitions.
- `dev-governance.md`: full-flow compact index.
- `ten-step-governance.md`: business workflow compatibility.
- `meta-theory.md`: background only; do not load as execution contract unless theory terms are disputed.

## User-facing compact output rule
Use the user's language. For Chinese input, output Chinese stage summaries. Each visible stage summary should use at most three information blocks unless final reporting requires more. A block may contain nested details so the chat still covers progress, current work, owner/capability, result, risk/blocker, verification, and next action; users are not expected to inspect generated files for essential guidance.

## No fake owner
Reject `general-purpose`, temporary fallback, runtime nickname, missing owner, or governance agent as implementation worker. Return to Thinking with a `capabilityGapPacket`.

## No general-purpose fallback

Compatibility fallback may preserve runtime usability. Governance fallback may not hide missing intent, owner, weapon, dependency, evidence, or verification. Missing governance readiness blocks or returns to the responsible stage.

## No public-ready without userGoalDone

`public-ready` requires `intentAmplificationScore >= 90`, `publicReadyScore >= 90`, `userGoalDone = true`, verification evidence, no unresolved high/critical findings, and writeback decision.

## No deletion of foundational capabilities

Prompt cleanup may delete vague language only. It may not remove Skills, WebSearch, browser, research, filesystem, shell, apply_patch, MCP, memory, graph, Graphify, hooks, scripts, commands, runtime tools, validators, setup, sync, install, uninstall, or projections.

## No removal of runtime native abilities

Meta_Kim adds boundaries around Claude Code, Codex, Cursor, and OpenClaw native abilities. It must not replace native UI, approval, sandbox, hooks, skills, agents, commands, MCP, or rules with fake Meta_Kim equivalents.

## No dependency deletion due to low score

Low-score, unknown, partial, uninstalled, external, high-risk, or reference-only dependencies stay registered. They may be blocked from execution, marked for probe, downgraded to evidence/reference, or assigned upgrade suggestions.

## No Hook loop

Hooks are last-resort fuses, not the main governance engine. Governed Agent dispatch and public-ready claims must pass the key behavior preflight: intent, evidence, capability discovery, runtime/OS not known-unsupported, owner, owner loadout across skill/command/MCP/tool/prompt, memory strategy, and Review standard. Ordinary local edits and commands do not wait for that proof. Detailed dependency eligibility, rollback, verification owner, warning classification, and writeback reservation are validator/public-ready gates unless their absence makes execution unsafe. A Hook block must include `returnToStage`, `repairOwner`, `repairAction`, `allowedNextAction`, and `forbiddenRetry`. The same Hook reason may block once; the second same-reason block enters `hookRepairMode`; a third same-hook block stops Execution and creates `hookFailurePacket`. Never retry the same blocked action unchanged.
Hooks must not duplicate generic keyword safety gates or turn stage progress into a local file/command permission system. User-explicit local execution stays runtime-native in observed and managed modes, including ordinary edits, tests, Git, delete/cleanup, install, publish, GitHub Release, and GitHub API writes. `enforce-agent-dispatch` may block an Agent dispatch when governed owner/capability/choice evidence is missing, a meta-agent attempts direct execution, or an explicit read-only `queryBypass` run attempts mutation; it must not block or warn on ordinary project edits or local commands because Critical, Fetch, Thinking, Review, Verification, or Evolution evidence is incomplete. Review and Verification judge release truth, rollback evidence, policy adherence, and public-ready claims.
## Same-Type Failure Design Gate

This gate applies beyond hooks. If the same failure class appears for the second time in one goal or acceptance run, treat it as `bottom_design_failure`, not as another local patch opportunity. Return to Critical, Fetch, or Thinking and change the underlying goal contract, route design, evidence path, owner/loadout choice, runtime adapter, or verification gate before retrying.

Failure classes include missing native choice surface before Execution, fixture-specific hardcoding, validator rescue after a weak route, verification pass without runtime evidence, repeated hook reason, and repeated user correction about the same target. A fix must change the design or evidence route and add a regression test or scar. Do not rerun the same action, prompt, fixture, or local edit unchanged after the second same-class failure.

## Degraded Mode

When Agent dispatch is unavailable or no matching owner exists after capability discovery, the spine enters degraded mode instead of silently skipping stages.

Required actions:
- Record `capabilityGapPacket` with `currentAgentsChecked` and `currentProvidersChecked`.
- Record `degradationReason`: `tool_limitation`, `no_matching_owner`, or `permission_blocked`.
- Set `publicReadinessState` or the summary/public surface packet state to `internal-ready`; keep runtime `surfaceState` at `notice` or `silent`; never claim `public-ready` in degraded mode.
- Log which spine stages execute in degraded mode vs fully executed.
- Review and Verification stages: read the relevant meta-agent definition for criteria, apply the same checklist, and record `degradedFlag: true` with `reviewerRole: "main-thread-degraded"`.
- Verification: add `humanAcceptanceRequired: true` when no independent verification owner exists.

Forbidden:
- Silently skip any stage.
- Claim `public-ready` while in degraded mode.
- Self-execute when Thinking assigned a different owner (unless degraded mode explicitly overrides and records the override reason).

## Real testing and warning classification

Script validation is necessary but not sufficient. Public-ready requires real route fixtures, strict run artifact validation, dependency discovery output, runtime/OS probe output, and warning review. Warnings must be classified as `BLOCKING_WARNING`, `FIXABLE_WARNING`, `ENVIRONMENT_WARNING`, `EXPECTED_WARNING`, `DEPRECATED_WARNING`, or `NOISE_WARNING`. Unclassified warnings, unresolved Hook blocks, unresolved high/critical findings, missing verification evidence, or missing `userGoalDone` keep `publicReady=false`.
