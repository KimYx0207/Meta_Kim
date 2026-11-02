# Evolution Writeback

Evolution is for durable governance learning, not for routine status.

Write back only when the run changes long-term behavior, agent responsibility, install/release rules, capability indexes, hook contracts, or verification requirements.

Authority:

- Warden approves.
- Chrysalis coordinates.
- Target specialist performs writeback.

If there is no durable lesson, record `writebackDecision: none` with rationale.

## Use when

Use at run end, after verification failure, after repeated failure pattern, after dependency compatibility improves, or after prompt/governance boundary repair.

## Project fit before the next task

The host's Thinking consumes the target project's verified constraints, actual same-project independent review/failure evidence and current method source/version before selecting reuse, adaptation or creation. It records the fit judgment and, when needed, a bounded project candidate and creator work order. Use the existing project PRD, source and result records; do not infer a project root from task prose or inject the whole history. This is host evidence consumption, not a new Node history-learning service or feedback API. A task-only/default-global lifecycle decision does not prove project fit; absent fit or performance evidence stays unknown.

Keep these triggers distinct: the second same-type failure returns to Critical/Fetch/Thinking to change the design or evidence path; three uses of the same structure across different tasks justify evaluating Skill extraction; an explicit request for persistent learning or project adaptation triggers that evaluation immediately. None forces a new Agent/Skill. Choose a project method/reference update when responsibility already fits; new identity remains Type B, and Skill authoring applies `meta-skill-creator`.

Conductor places relevant sources in existing worker `evidenceRefs`, explains their direction in `referenceDirection`, and states the expected decision/check in `handoffContract`. The receiving owner reports the sources and versions actually read, the action taken or reason not applicable, and observed task/review outcomes. Quality, rework, waiting and elapsed time come from real task receipts; file counts, saved notes, fixture pass and copied packages do not prove better quality or speed. No new performance database or parallel queue is required.

## Required inputs

- `verificationResult`
- `reviewPacket.findings`
- writeback proposal
- scar candidate
- Warden approval or rejection
- target registry or file path

## Do

- `meta-chrysalis` prepares `evolutionWritebackPacket` and `scarPacket`.
- `meta-warden` approves or rejects writeback.
- Target owner writes only its owned source.
- Generate `none-with-reason` when no durable learning exists.

## Do not

- Do not write "next time remember" without artifact.
- Do not self-approve Chrysalis writeback.
- Do not write to memory/graph/run-index as the only durable governance writeback.

## Required packet

`evolutionWritebackPacket`: `writebackDecision`, `decisionReason`, `writebacks`, `scarIds`, `nextRunReuseKey`, `wardenApproval`.

## Pass

- decision is `writeback` or `none-with-reason`.
- every scar has `failurePattern`, `preventionRule`, `test`, and `nextRunReuseKey`.
- every writeback has target and owner.

## Fail

- missing writebackDecision.
- scar lacks regression test.
- writeback target missing or self-approved.

## Block

Block public-ready if writebackDecision is missing. Block writeback if Warden approval is absent.

## Return to stage

Return to Review when failure evidence is unclear. Return to Verification when fix evidence is missing. Return to Thinking when target owner is unclear.

## Verification

Run `npm run meta:prompt:validate`, `npm run meta:foundational:validate`, and relevant governance tests.

## Writeback

Allowed targets include canonical agent prompts, canonical skill references, governance configs, capability indexes, validators, tests, and scar protocol records.

## Preserve

Preserve memory, graph, MCP, hooks, run-index, Graphify, and all foundational capabilities; writeback strengthens them instead of replacing them.

## Durable invariants

Run-scoped scar logs belong in `.meta-kim/state/default/runs/<runId>/`, not in this reference file. This file keeps only cross-run invariants; each invariant must map to an enforcement artifact (regression test, validator, hook, or companion reference).

- **Backup failure must surface.** A backup helper that swallows its own failure and lets the primary write continue silently is a reversibility bug. Enforced by `tests/meta-theory/56-backup-failure-must-surface.test.mjs`.
- **Every stage maximizes safe internal parallelism behind an ordered merge barrier.** `config/contracts/core-loop-contract.json#parallelExecutionPolicy` and each stage's `parallelPolicy` are authoritative. Independent support lanes may run concurrently in Critical, Fetch, Thinking, Execution, Review, Meta-Review, Verification, and Evolution, but only the stage's named merge authority may commit the intent, evidence, route, execution merge, review/meta-review verdict, verification claim, or writeback decision. Cross-stage overlap, conflicting writes, missing approval, and unverified host invocation remain forbidden.
- **Write-class task completion requires a Read-confirmed artifact.** A `completed` transition on a write-class task is not durable evidence unless the produced file path is attached and confirmed to exist with the expected shape. Bare task-board state is a verification gap, not a writeback.
- **Runtime local-override markers must be symmetric.** If one runtime carries a `meta-kim: local-override` marker (or equivalent) so sync skips it, every other runtime with a writable projection config must carry the same marker or be declared asymmetric in `scripts/sync-coverage-check.mjs`.
