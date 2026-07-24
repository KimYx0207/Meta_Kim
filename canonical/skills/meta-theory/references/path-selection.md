# Path Selection

Choose the smallest path that can honestly satisfy the real product problem.

## Paths

- `fast_path`: pure read-only query, local evidence enough, no write, no durable artifact, no handoff. It may set `queryBypass: true`, but only for read-only tools. This does not skip a user choice if the analysis reveals materially different routes, scopes, risks, owners, or acceptance standards.
- `standard_path`: executable work with limited risk. Keep the canonical stage order, but apply fitness-informed depth: Critical / Fetch / Thinking may be concise inline records for a clear local task; Execution and fresh Verification remain required; Review runs only when risk, ambiguity, blast radius, a failed check, or the intended claim justifies it; Evolution is skipped with inline `none-with-reason` unless a durable learning trigger exists.
- `regulated_path`: security, release, install, cross-runtime, public-ready, governance-contract, or high-blast-radius work. Use all gates, explicit evidence, Meta-Review when review quality matters, and fresh verification.

## Rules

- If multiple interpretations change output, ask one blocking clarification.
- If a simpler approach solves the real pain, state it and use it.
- Smallest path is not automatically the minimal fix. If the real pain suggests a route, product, validation, owner, install, or abstraction change, compare the minimal fix against the ten-x path shift before choosing.
- Fuzzy user intent is not a fast path just because the requested artifact is small. If the user has not decided the outcome, audience, success standard, or product direction, keep the work in Critical / Thinking until the route is honest.
- If evidence is missing but cheap to gather, Fetch first.
- Do not dispatch extra governance workers or create planning artifacts merely to make a clear low-risk local task look governed; concise evidence and a verified result are enough.
- Review is conditional for standard-path work, but remains required for regulated triggers, ambiguous acceptance, high-blast-radius mutation, or verification failures.
- Evolution is not part of the default execution scaffold. Dispatch it only for a reusable capability gap, repeated failure scar, durable agent/skill/tool/hook/runtime lesson, governance-contract change, or explicit user request for durable learning.
- If capability is missing, return to Thinking or create `capabilityGapPacket`; do not invent a fallback owner.

## Use when

Use when choosing fast, standard, or regulated path, or when comparing minimal fix, shortest correct path, and ten-x path shift.

## Required inputs

- `intentPacket`
- `fetchPacket`
- runtime and OS target
- dependency candidates
- route score inputs
- choice-surface policy

## Do

- Score route as intentFit 20%, ownerFit 15%, weaponFit 15%, dependencyFit 15%, runtimeSupport 10%, osSupport 10%, verificationStrength 10%, riskRollbackClarity 5%.
- Select `>=85` automatically when no branch-changing choice is needed.
- Ask only when route, risk, scope, owner, runtime, OS, dependency, or acceptance changes.

## Do not

- Do not ask filler questions.
- Do not treat workflow completion as user goal completion.
- Do not execute unsupported runtime/OS/dependency routes.

## Required packet

`pathSelectionPacket`: `pathCandidates`, `selectedPath`, `whyThisPath`, `routeScoreBreakdown`, `rejectedRoutes`, `userChoiceNeeded`, `decisionCard`.

## Pass

- selected path has score band and rationale.
- rejected routes list score and reason.
- public-ready path has verification evidence and intent acceptance requirements.

## Fail

- best path has no score formula.
- `70-84` route proceeds without confirmation or extra evidence.
- `<50` route lacks `capabilityGapPacket`.

## Block

Block routes with unsupported runtime, unsupported OS, fake owner, reference-only execution dependency, unresolved high/critical finding, or publicReadyScore `<90`.

## Return to stage

Return to Critical for missing intent. Return to Fetch for missing evidence. Return to Thinking for route gaps.

## Verification

Run `npm run meta:capabilities:route -- --task "fuzzy product monetization task" --runtime codex --os windows --json`.

## Writeback

Write recurring path scoring failures to `config/governance/decision-pattern-catalog.json` or scar tests.

## Preserve

Preserve all foundational and native capabilities; path selection may exclude unsupported capabilities from route, not delete them.
