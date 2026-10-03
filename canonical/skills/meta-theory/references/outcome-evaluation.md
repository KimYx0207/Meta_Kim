# Task Outcome Evaluation

Meta_Kim is a general agent governance framework. A request may need a decision, research, a document, software, a business operation, learning support, or capabilities not yet available. Critical binds that request; Thinking chooses an evidenced feasible route; capability discovery and the existing DAG supply execution. An industry pack is one possible source of capabilities.

## Use when

Use when defining a task's acceptance criteria, comparing candidate decisions, reviewing a deliverable or interpreting evaluation evidence across domains.

## Required inputs

The current user request, scope and constraints; a run-scoped goal contract with required acceptance criteria; the deliverable and any criterion observations; and the selected verification owner. Missing observations are allowed for an honest incomplete assessment.

The current request is the goal authority. `goalContractPacket` is run-scoped: `taskHash` binds its `contractFields.outcome`, and `acceptanceDigest` binds the exact `acceptanceCriteria`. Do not replace these with Meta_Kim roadmap IDs or install/test commands. Framework acceptance remains separately recorded. A change to the goal or its criteria invalidates prior criterion observations and requires new review.

The implementation is `src/domain/governance/task-outcome.mjs`. It distinguishes a valid goal definition from a passed outcome. The default runner emits an incomplete outcome assessment when it has no task-specific evidence; this adds evidence reporting, not a new Hook, scheduler or approval authority.

## Do

Conductor binds the user's outcome and criteria before execution. Thinking selects the smallest useful test and a qualified verification owner. That owner assesses the deliverable against the criteria; Prism reviews the evidence and claim boundary.

Use three separate levels:

1. Structure: inputs, schemas and references are valid.
2. Routing and boundaries: natural-language requests select suitable capabilities, negative cases do not trigger unrelated roles, and ownership, permissions and dependencies hold.
3. Task outcome: the real deliverable meets every required criterion. Review open-ended quality and preserve the evidence reference and reviewer.

At Thinking, define the smallest observable check that can distinguish candidate routes. For a decision, this includes constraints, evidence, meaningful alternatives, the recommendation and what would change it. For execution, include the deliverable's actual result. Required failures cannot be hidden by good optional scores. Equivalent correct outcomes may follow different tool sequences; require a specific action only when the task contract justifies it.

## Do not

Do not replace a user's goal with framework maintenance criteria, accept optional scores in place of a required result, treat a tool sequence as the only valid route without a contract reason, or infer live success from fixtures, cached results or model scores.

## Required packet

`goalContractPacket` records the request binding and acceptance definition. `traceEvalControlPlane.outcomeEvaluation` or a standalone evaluation report records each criterion's status, evidence reference and missing or rejected evidence reason, plus the aggregate status and claim boundary.

An observation has `criterionId`, `taskHash`, `acceptanceDigest`, `verdict` (`pass`, `fail`, `inconclusive`), `evidenceKind` and `evidenceRef`. A `human_review` names its `reviewer`; an `independent_review` names distinct `producer` and `reviewer` owners and may come from a qualified review agent. Deterministic checks can support deterministic criteria. Semantic criteria need accountable review, without imposing a new human approval gate on every task. Unreviewed model judgments remain advisory. Unknown criteria, duplicate observations, wrong task bindings and missing evidence do not pass. The evaluator assesses supplied records; it does not authenticate them or grant native-invocation, public-ready or user-acceptance authority.

## Pass

A criterion assessment passes only when every required criterion has an eligible task- and acceptance-bound passing observation, with no invalid observations. This is an assessment of submitted records; authenticated execution and public-ready acceptance remain separate gates.

## Fail

A required failing observation, an unknown or duplicate observation, or a mismatched binding fails the assessment. Malformed goal contracts are rejected. Missing or inconclusive required evidence produces `incomplete`, never a passing outcome.

## Block

Block a task-completion claim while required outcome evidence is missing, inconclusive or failing. Do not block unrelated safe work or create a new approval gate merely because an assessment is incomplete.

## Return to stage

Return to Critical when the goal or criteria change, Fetch when evidence is missing, Thinking when the selected route cannot meet the criteria, and Execution when the deliverable needs correction. Reassess changed criteria with fresh observations.

## Verification

Run the offline functional regression with `npm run meta:eval:governance`. Its synthetic cases cover multiple domains and explicit, implicit, contextual and negative requests. They verify the implementation, not a model-quality improvement. To assess actual observations, run `node scripts/evaluate-governance-outcomes.mjs --artifact <run.json> --observations <observations.json> --json-out <new-report.json>`. Existing output files are preserved. A missing or failed outcome returns a nonzero exit code. Model A/B quality comparisons still require a separately executed, matched evaluation with fresh evidence; preserve existing Fitness Lab results, including negative findings.

## Writeback

Record the actual assessment, unresolved gaps and reusable failure findings in the current planning records. Update the decision-pattern catalog or regression cases only when a recurring failure or reusable lesson warrants it; otherwise record none-with-reason. Preserve separate provenance for each absorbed method.

## Preserve

When documents or tables are needed, discover an existing material-reading capability first. Preserve the original source, extraction method, unsupported content, table units and fidelity limitations. Markdown conversion alone does not verify facts or imply OCR was executed. MarkItDown remains an optional converter candidate until that route is selected and tested.

For requests under resource constraints, reuse the existing scheduler. Concurrency limits simultaneous operations; start-rate limits calls over time. A local limiter can control only the calls routed through it. Respect a user's serial-execution request. Timeout does not prove cancellation, and automatic retry must not duplicate external effects. p-queue remains an optional implementation candidate for a proven controlled-entry gap.

Reference provenance is recorded per project in `config/governance/decision-pattern-catalog.json`: promptfoo (MIT), NVIDIA SkillEvaluator (Apache-2.0), τ-Bench (MIT), MarkItDown (MIT) and p-queue (MIT), inspected on 2026-09-14 at pinned commits. The first three supplied evaluation methods; the last two supplied guidance boundaries. No upstream runtime is installed or made an execution authority by this reference.
