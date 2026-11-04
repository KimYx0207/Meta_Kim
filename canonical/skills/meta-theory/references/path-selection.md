# Path Selection

Choose the smallest path that can honestly satisfy the real product problem.

## Paths

- `fast_path`: pure read-only query, local evidence enough, no write, no durable artifact, no handoff. It may set `queryBypass: true`, but only for read-only tools. This does not skip a user choice that changes the delivered outcome, scope, maintenance responsibility, resource commitment, authorization or acceptance standard.
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
- Bind alternatives to the current user's outcome and constraints. "Best" means the strongest evidenced feasible route among the considered candidates; record missing evidence and avoid claims of global optimality.
- Product mechanisms and execution-provider routes are separate choices. Internal model/tool/agent substitutions do not establish different user experiences. Keep permissions independent of both, and never use a route-fit score as design-quality evidence or as a substitute for uncertainty, coupling, operational-risk and verification facts.
- For decisions, research, operations, learning and other non-coding goals, discover the required capabilities without forcing an engineering or industry template. Compare expected outcome, cost, risk, reversibility and the smallest discriminating verification before choosing.
- Keep task-outcome verification separate from framework acceptance. Use `outcome-evaluation.md`; a valid plan or successful schema check cannot close the user's goal.

## Use when

Use when choosing fast, standard, or regulated path, or when comparing minimal fix, shortest correct path, and ten-x path shift.

## Required inputs

- `intentPacket`
- `fetchPacket`
- runtime and OS target
- dependency candidates
- current capability support, evidence and task-bound depth facts
- choice-surface policy

## Do

- Compare actual capability fit, supported runtime/OS, required inputs, verification, risk and reversibility. Existing provider-fit rankings are diagnostic, not calibrated design quality or permission.
- Choose internal owners/tools autonomously when the user-visible outcome and authorized boundaries are unchanged; a score band alone cannot create a user question.
- Ask only for a material change to outcome, scope, maintenance responsibility, resource commitment, authorization or acceptance. Investigate missing facts before asking.

## Do not

- Do not ask filler questions.
- Do not treat workflow completion as user goal completion.
- Do not execute unsupported runtime/OS/dependency routes.

## Required packet

Use the existing `pathSelectionPacket`: candidates, selected path, evidence-based rationale, rejected routes, actual user-choice need and any material decision card. A retained `routeScoreBreakdown` is a provider-fit diagnostic, never a replacement for task facts or product acceptance.

## Pass

- selected path has current evidence and a concrete rationale.
- rejected routes name the constraint or evidence that makes them unsuitable.
- public-ready path has verification evidence and intent acceptance requirements.

## Fail

- a numerical rank substitutes for missing capability evidence or user-goal acceptance.
- internal provider substitutions are offered as different product mechanisms.
- missing capabilities lack a concrete gap and next action.

## Block

Block routes with unsupported runtime/OS, fake owner, reference-only execution dependency, unresolved high/critical findings, missing required evidence or missing authorization. A fixed public-ready score cannot prove outcome quality or override these conditions.

## Return to stage

Return to Critical for missing intent. Return to Fetch for missing evidence. Return to Thinking for route gaps.

## Verification

Run `npm run meta:capabilities:route -- --task "fuzzy product monetization task" --runtime codex --os windows --json`.

## Writeback

Write recurring evidence/selection failures to the existing decision-pattern catalog or regression tests; do not add a new scoring authority.

## Preserve

Preserve all foundational and native capabilities; path selection may exclude unsupported capabilities from route, not delete them.
