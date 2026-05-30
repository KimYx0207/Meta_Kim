---
name: meta-theory
version: 4.0.0
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

Run Meta_Kim as an executable governance system, not a theory essay. The main thread locks intent, gathers evidence, chooses route, delegates bounded work, reviews, verifies, and synthesizes. It must not become a generic implementation worker for non-trivial work.

## Trigger

Activate when the user calls `/meta-theory`, names meta-theory, asks for governance, multi-file execution, agent design, capability discovery, runtime/platform compatibility, public-ready validation, complex debugging, or durable evolution writeback.

## Path classification

- `fast_path`: read-only query, no mutation, no durable artifact. Output may be direct, but evidence claims still need source.
- `standard_path`: ordinary executable work. Use the 8-stage spine and capability-first route.
- `regulated_path`: governance, security, runtime, dependency, release, public-ready, or cross-platform work. Require full spine, Review, Meta-Review, Verification, and Evolution.

## Canonical spine

Critical -> Fetch -> Thinking -> Execution -> Review -> Meta-Review -> Verification -> Evolution.

## Stage packet table

| Stage | Required packet | Pass condition |
|---|---|---|
| Critical | `intentPacket`, `taskClassification` | outcome, success criteria, non-goals, permissions, blocking unknowns recorded |
| Fetch | `fetchPacket`, `foundationalCapabilityPreservationPacket`, `dependencyCapabilityAuditPacket` | evidence changes route/risk/owner/verification or records no-impact |
| Thinking | `dispatchBoard`, `workerTaskPackets`, `routeScoreBreakdown` | selected route has owner + weapon + dependency policy + runtime + OS + verification owner |
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

## Native ability preservation

Governance may add trigger, evidence, trust review, approval, sandbox, fallback, verification, and risk boundaries. It must not delete, downgrade, or replace runtime-native abilities for Claude Code, Codex, Cursor, or OpenClaw. Unknown or partial native abilities stay `unknown` or `partial` until verified; they are not removed.

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

Execution may start only when all are true:

- `realIntent`, success criteria, non-goals, and blocking unknowns are recorded.
- Fetch evidence and capability discovery are complete enough for the chosen path.
- Route score is `>=85`, or a branch-changing user choice accepts a `70-84` route.
- Owner is not `general-purpose`, not a runtime alias, and not a governance agent acting as implementation worker.
- Weapon is callable and compatible with target runtime and OS.
- Dependency is not `reference_only`, not `external_reference`, not missing invocation path, and not missing verification method when used for execution.
- Verification owner, verification method, rollback/risk boundary, and expected evidence are known.

## Dynamic Workflow routing

Two engines with different objective functions — orthogonal, not interchangeable.

- **Dynamic Workflow** = breadth engine. Parallel fan-out for coverage + adversarial convergence. Optimizes speed and breadth. Up to 16 concurrent agents, built-in adversarial verification.
- **8-stage spine** = depth engine. Governance-first with independent review. Optimizes judgment depth and fault tolerance.

A workflow is a parallel-execution capability chosen *after* Fetch/Thinking, not a substitute for the spine's owner/weapon/verification routing or the independent-review mandate. It plugs into the spine's Execution stage as a parallel-execution weapon — it is not a new process running parallel to the spine.

**One-line decision rule**: when breadth/coverage matters more than per-task judgment density AND each unit is independent → workflow; high judgment density OR dependency chain OR governance mutation → serial + independent review.

> The subsections below apply only after the decision rule above selects a workflow. If serial + independent review wins, skip this entire block.

**Use Dynamic Workflow when** all three hold: (1) homogeneous batch × N independent objects, (2) each unit is read-only or writes to its own isolated path, (3) breadth of coverage matters more than per-unit judgment depth. Examples: bulk audit (N docs through auditor), bulk scan (N files for same issue class), read-only fan-out to assess current state, batch tagging or summarization.

**Do not use Dynamic Workflow — fall back to serial + independent review — when** any of these hold: (1) modifying governance canonical (each merge requires judgment: upstream upgrade vs. local customization), (2) strong dependency chain (Wave 1→2→3 ordering), (3) high-judgment-density writes where concurrent execution dilutes audit coverage, (4) fault tolerance is low and errors are hard to detect across 16 parallel streams.

**Per-run operational constraints** (re-verify against current hooks before each large write-class run):
- Read-only fan-out: hooks do not block read-only execution subagents.
- Write-class fan-out: each worker must write to an isolated path (never concurrent writes to shared canonical). Workers writing in parallel must declare `parallelGroup`, `mergeOwner`, and `collisionPolicy` (enum: `no_overlap` / `merge_by_owner` / `lock_required` / `sequentialize`) per the workerTaskPacket schema. Parallel instances of the same owner additionally require `shardKey` / `shardScope`, `workspaceIsolation`, `artifactNamespace`, and one unified `mergeOwner`; repeated owner entries lacking these are pseudo-parallelism, not safe parallel writes. These are existing schema fields, not new concepts.
- A meta-* caller writing directly to a shared file is blocked by `enforce-agent-dispatch`.
- Concurrent writes to the same file: race condition risk — write to separate paths only.
- Workflow output still requires independent review via the 8-stage spine. Built-in adversarial verification replaces manual fan-out review; it does not replace the independent review mandate.

## Review gate

Review must check upstream chain before output polish:

- Critical locked the right user outcome and success criteria.
- Fetch evidence changed or justified the route.
- Thinking selected owner + weapon + dependency + runtime + OS + verification.
- Execution evidence is reproducible.
- No foundational capability or runtime-native ability was deleted or downgraded.
- No reference-only dependency entered execution.

## Verification gate

Do not claim verified unless a command, log, artifact, or human acceptance record supports the claim. Command pass is not `userGoalDone`. Template validation is not strict run validation.

## Evolution gate

Every run ends with `writebackDecision = writeback` or `none-with-reason`. Durable failures require a scar with `failurePattern`, `preventionRule`, `test`, and `nextRunReuseKey`. Evolution writeback needs Warden approval; Chrysalis coordinates; target owners update their own sources.

## Reference loading

Load only references needed for the run:

- `path-selection.md`: route scoring and path bands.
- `owner-resolution.md`: owner + weapon + dependency route.
- `runtime-codex.md`: Codex-specific sandbox, approval, subagent, hook, and choice behavior.
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

Use the user's language. For Chinese input, output Chinese stage summaries. Each visible stage summary should be at most three bullets unless final reporting requires more.

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
