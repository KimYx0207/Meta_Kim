# Planning Files (Dual-Workflow Support)

When file-based planning is enabled and the task is not a pure query, planning files track workflow progress:

- `task_plan.md`: goal, phases, dependencies, status checkpoints
- `findings.md`: evidence, decisions, contradictions, open issues
- `progress.md`: stage-by-stage progress, completed checks, current state

## Two Workflow Modes

Meta_Kim supports two workflow models:

1. **8-Stage Spine** (canonical meta-theory spine)
2. **11-Phase Business Workflow** (department workflow, legacy alias: ten-step-governance)

The planning files adapt to whichever mode is active.

---

## 8-Stage Spine Coverage

| Stage | Updates | Content |
|-------|---------|---------|
| Critical | `task_plan.md` | Initialize: goal, context, phases, dependencies |
| Fetch | `findings.md` | Evidence collected, decision impact map, contradictions |
| Thinking | `task_plan.md`, `findings.md` | Solution paths, chosen rationale, capability gaps |
| Execution | `progress.md` | Worker progress, file completion list, execution evidence |
| Review | `findings.md`, `progress.md` | Quality findings, boundary checks, review decisions |
| Meta-Review | `findings.md` | Review standard evaluation, review quality assessment |
| Verification | `progress.md` | Verification results, evidence binding, closure status |
| Evolution | `task_plan.md`, `progress.md` | Final status, writeback decision, lessons learned |

---

## 11-Phase Business Workflow Coverage

| Phase | Updates | Content |
|-------|---------|---------|
| Direction (1) | `task_plan.md` | Initialize: intent core, complexity class |
| Planning (2) | `task_plan.md`, `findings.md` | Task decomposition, meta assignments, dependencies |
| Execute (3) | `progress.md` | Execution progress, artifacts created |
| Review (4) | `findings.md`, `progress.md` | Prism report findings, grade, assertions |
| Meta-review (5) | `findings.md` | Standard evaluation, drift detection |
| Revision (6) | `progress.md` | Revision rounds, fixes applied |
| Verify (7) | `progress.md` | Re-verification results, fresh evidence |
| Summary (8) | `task_plan.md`, `progress.md` | Exec memo, learning log |
| Feedback (9) | `task_plan.md` | User acceptance, change requests |
| Evolve (10) | `task_plan.md`, `findings.md` | Five-dimension scan, amplification actions |
| Mirror (11) | `progress.md` | Runtime sync status, projection evidence |

---

## Workflow Mapping

8-stage spine and 11-phase business workflow map as follows:

| 8-Stage Spine | 11-Phase Business Workflow | Planning Files |
|---------------|---------------------------|----------------|
| Critical | Direction | task_plan.md |
| Fetch + Thinking | Planning | task_plan.md + findings.md |
| Execution | Execute | progress.md |
| Review | Review | findings.md + progress.md |
| Meta-Review | Meta-review | findings.md |
| Verification | Verify | progress.md |
| Evolution | Summary + Feedback + Evolve + Mirror | task_plan.md + progress.md |

These files are supplemental. Packets in `config/contracts/workflow-contract.json` remain canonical.

Only the conductor/main coordinator writes these planning files unless the run explicitly delegates ownership.

## Release Closure Projection

Planning files and a local-private PRD stay outside Git and must not be copied into a public backlog. Public release continuity already belongs to the tracked changelog, annotated tag, GitHub Release, exact package asset, and immutable release-binding audit.

After those public facts and the final Claude Code/Codex global update are complete, the maintainer runs:

```text
meta-kim release close --issue <P-NNN> --prd <repo-relative-private-prd>
```

The command verifies the PRD and planning files are ignored, the PRD owns the one matching `ACTIVE` row, and the tracked tree is clean. It then replays the exact proof against the live GitHub annotated tag, Release, downloaded tgz, matching clean verification report, current remote main, and latest chained `published_bound` audit; checks the real default Claude Code/Codex global projections; and rechecks local release facts immediately before writing. Only then does it append one marked block to each planning file that already exists. It never creates missing planning files, publishes the PRD, or turns a planning block into queue authority. A retry after interruption keeps an existing correct block and adds only missing projections; a partial or conflicting marker fails closed.


## Use when

Use when task_plan.md, findings.md, and progress.md planning state affects route, owner, risk, acceptance, verification, public-ready, or evolution writeback.

## Required inputs

- Latest user request and `intentPacket`
- `fetchPacket` evidence that changes decision
- runtime and OS targets when tools or dependencies are involved
- relevant config, registry, script, or artifact path

## Do

- Assign an owner for each action.
- Produce a checkable packet or artifact.
- Bind pass/fail to evidence, threshold, or command output.
- Treat planning files as update-only continuity state. Append, refine, or mark superseded items; preserve the existing phases, evidence, and user decisions while a run is active.
- Preserve existing foundational and native runtime capabilities.
- During Critical and early Fetch, prefer a short visible chat status plus batched read/search evidence. Do not create or update host task/todo boards before useful Fetch evidence exists.

## Do not

- Do not delete skills, dependencies, web/browser/research, shell, filesystem, apply_patch, MCP, memory, graph, hooks, scripts, runtime tools, or native platform abilities.
- Do not use vague advice without trigger, output, evidence, and writeback.
- Do not route reference-only or unknown dependencies into execution.
- Do not overwrite `task_plan.md`, `findings.md`, or `progress.md` with a fresh plan while they contain active continuity state.
- Do not reset prior completed, blocked, superseded, or user-accepted planning entries; update their status and add a new entry instead.
- Do not treat host task/todo control-plane bookkeeping as Fetch progress, evidence, or a required first step.

## Required packet

`referenceContractPacket`: `referenceId`, `trigger`, `requiredInputs`, `actions`, `outputs`, `passCriteria`, `failCriteria`, `blockConditions`, `returnStage`, `verification`, `writebackTarget`.

## Pass

- At least one action has owner, input, output, and verification.
- Pass criteria include numeric threshold, required field list, command, artifact, or human acceptance record.
- Existing `task_plan.md`, `findings.md`, and `progress.md` content is preserved or explicitly superseded with reason.
- Unsupported, unknown, or partial capability is marked rather than removed.

## Fail

- Instruction is only theory or roleplay.
- No block condition exists for missing evidence, unsupported runtime/OS, fake owner, or missing verification.
- Public-ready can be claimed without userGoalDone and evidence.

## Block

Block Execution when owner, weapon, dependency eligibility, runtime support, OS support, verification owner, or rollback boundary is missing. Block public-ready when verification evidence, intent acceptance, writebackDecision, or high/critical closure is missing.

## Return to stage

Return to Critical for intent gaps, Fetch for evidence/support gaps, Thinking for route gaps, Execution for missing artifact, Review for open findings, Verification for missing proof, and Evolution for missing writeback.

## Verification

Run the most specific validator for this reference plus `npm run meta:prompt:validate`. Use command/log/artifact/human acceptance evidence, not a narrative claim.

## Writeback

Write durable improvements to canonical references, governance configs, capability indexes, validators, tests, or scars. If no durable change exists, record `none-with-reason`.

## Preserve

Preserve Skills, WebSearch/browser/research, filesystem, shell, apply_patch, MCP, memory, Graphify, graph, hooks, commands, rules, agents, subagents, approval, sandbox, runtime tools, package scripts, setup, sync, install, uninstall, status, doctor, validators, and runtime projections.
