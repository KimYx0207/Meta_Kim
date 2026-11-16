# Cross-Agent thinking patterns — optional method loadout

## Responsibility and authority

This is a reusable method *selection guide*, not an education-only Agent, a new stage, a new orchestration system, or an approval mechanism. **任何专业 Agent / any professional Agent** may use the relevant pattern when its task benefits; production, research, marketing, engineering/编码, customer service and 教学/education all qualify. A subject-matter Agent retains its own industry knowledge, current project rules, tools, and artifact acceptance conditions.

1. In **Critical**, name the user outcome and the specific uncertainty, missing evidence, decision fork, or need for feedback. A plain execution request does not automatically need a thinking exercise.
2. In **Fetch**, perform capability-first discovery. First look for a suitable currently available provider; Kim_Service's `agent-thinking-patterns` is a shared candidate, not a mandatory installed dependency. Match scope and current host availability before stating it was loaded. The professional Agent remains the owner; the chosen method is its optional Skill/loadout.
3. In **Thinking**, select the smallest set of patterns that changes the route or improves the actual result. Bind relevant task inputs, sources and output checks through the existing `capabilityBindings`, `workerTaskPackets` and research/decision references; **不强制** all ten or any fixed count. Do not create a second PRD, task board, permission ledger, or acceptance state.
4. In **Review / Verification**, evaluate the professional artifact with its original criteria. An authored method contract or catalog match is not evidence of host invocation, an accepted business decision, user progress, or task completion. Keep missing actual evidence `not_evaluated` or `not_run`.

## Shared methods; choose by the actual obstacle

| Pattern ID | Use for any Agent when... | Distinguishing action |
| --- | --- | --- |
| `clarify-real-problem` | The symptom may differ from the user's real goal | State the job to be done and ask only a route-changing question. |
| `adversarial-review` | An assumption or solution may hide serious failure | Find counterevidence, break points and a concrete falsification test. |
| `backcast-goal` | The outcome is clear but the path is not | Work backward into dependencies, capacities, milestones and pass checks. |
| `expert-comparison` | Domain technique matters and novice errors recur | Compare evidence-backed professional practice and common errors without impersonation. |
| `decision-tradeoffs` | Several viable choices have different long-term cost or risk | Compare feasible options, opportunity cost, reversibility and conditions that change the choice. |
| `opportunity-scan` | Potential user value or business upside needs evidence | Test actual beneficiary, demand, payment or time-savings and false-positive routes. |
| `practice-feedback` | The user asks to learn, rehearse, demonstrate or self-test competence | First provide a bounded exercise; only after their submission give targeted assessment and transfer exercise. |
| `repeatable-system` | Work recurs and can improve with feedback | Propose triggers, actions, checkpoints and stops under the host's automation authority. |
| `knowledge-extraction` | Raw sources or results need reusable insight | Preserve claim, context, supporting facts, contradictory interpretation and transfer boundary. |
| `strategic-focus` | Many possible actions compete for finite resources | Identify leverage, what to stop, concrete next action and its evidence of effect. |

### Examples that preserve professional ownership

- **代码/engineering Agent:** use `adversarial-review` to challenge failure assumptions and `practice-feedback` only if the user wants to implement a fix themselves for review; for an authorized bug fix, deliver the code without imposing homework.
- **营销/marketing Agent:** use `opportunity-scan` and `decision-tradeoffs` for audience/channel strategy; use `practice-feedback` only if the user explicitly asks to practice writing a campaign and receive critique.
- **教学/education Agent:** may use `practice-feedback`, plus its own learner assessment, grading rubric and answer isolation rules. This pattern is not owned exclusively by education.

**Exercise boundary:** In `practice-feedback`, do not expose the answer key in advance when self-testing is intended. If the user has not submitted actual work, return `awaiting_submission` and the evaluation result `not_run`; do not fabricate mistakes or mastery. When the user actually submits work, assess against observable criteria and distinguish feedback from a verified improvement. Never use this pattern to delay a normal product deliverable the user asked the Agent to produce.

### Integration boundary

- **单一事实和状态源:** Meta_Kim retains the single source of truth for goal, evidence, choices, two-level PRD, stage DAG, approval/权限, run status and final verification. The shared thinking method is an optional reference/procedure, not an added control plane.
- Kim_Service owns versioned general methods, while current project Agents own professional execution. If a specialized Agent already covers the method, reuse it rather than add a duplicate call or force a cross-repo dependency.
- A method choice is not an execution authorization. User-selected substantive decisions and explicit external-write approval remain binding; `agent-thinking-patterns` never overrides them.

## Use when

A professional Agent has an evidenced uncertainty, decision, or feedback need that a transferable method can resolve. A straightforward authorized delivery does not require an extra exercise.

## Required inputs

The user's outcome, applicable project and specialist contracts, available capability evidence, current decisions, and the expected deliverable with acceptance criteria.

## Do

Choose the smallest useful pattern during Thinking, after Fetch identifies a suitable real provider. Keep the specialist Agent as owner and its original output contract as the deliverable.

## Do not

Do not impose all ten patterns, invent a second workflow, substitute a teaching Agent for a delivery worker, or claim a method was invoked without host evidence.

## Required packet

Use existing `capabilityBindings`, `workerTaskPackets`, research sources, and decision references. Record the chosen method ID, provider and reason inside those established packets; introduce no parallel control state.

## Pass

The selected professional output meets its own observable criteria, with traceable evidence of whichever pattern materially improved the route or result.

## Fail

The output fails a required criterion, relies on a false assumption, or cannot show that the claimed pattern was actually available and used.

## Block

Block only the affected action if prerequisite evidence, specialist authority, or explicit permission is absent. Leave independent authorized work runnable.

## Return to stage

Return a missing-source or provider problem to Fetch, an open route choice to Thinking, and a product defect to the affected execution task or Review.

## Verification

The verification owner checks the actual professional artifact and its criteria, separates method selection from host execution, and marks unobserved outcomes `not_evaluated` or `not_run`.

## Writeback

Write a bounded method choice and its observed value to the existing task records; propose reusable changes only through the ordinary reviewed knowledge lifecycle.

## Preserve

Preserve the user's decisions, specialist ownership, current project rules, original acceptance tests, and all unrelated valid task state.
