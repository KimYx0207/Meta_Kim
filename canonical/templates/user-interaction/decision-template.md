# Decision Template (Outcome-Branching Options)

Use this template when multiple viable solutions exist with distinct trade-offs. Ask only questions whose answer changes the user-visible result, scope, risk, cost, permission, or acceptance. Apply `config/governance/material-decision-policy.json`; owner/model/provider/loadout differences alone remain internal. Each visible question must have at least two materially different options, and each option must be understandable to non-technical users.

## Format

| Dimension | Description | Required |
|-----------|-------------|----------|
| **What changes** | Specific scope of modification | ✅ |
| **What problem it solves** | Corresponding requirement or pain point | ✅ |
| **Expected result** | What the user will get after choosing this option | ✅ |
| **Advantages** | Why choose this approach | ✅ |
| **Disadvantages** | Costs or risks | ✅ |

## Runtime Adapter Payload

The canonical template defines the semantic card only. Runtime adapters may compact or reshape it for a native choice surface, but they must preserve the decision purpose, route-changing dimension, recommended default, runtime-native maximum option policy, option trade-offs, selection result, fallback reason, and writeback target.

For primary native runtimes, the adapter must keep the interaction feeling like a structured decision panel rather than a plain prompt. Preserve these semantic sections when they affect the decision: AI understanding, AI additions, Capability route, Candidate paths, expected result, advantages, disadvantages or risk, and verification impact. Runtime-specific payload limits and current host maximums belong in the matching runtime reference, not in this generic template.

Renderer-specific payload schemas belong in runtime references, not in this generic template.

## Example

| Option | What Changes | Problem Solved | Expected Result | Advantages | Disadvantages |
|--------|--------------|----------------|-----------------|------------|---------------|
| Recommended | The assistant gathers facts first, then asks one clear decision before changing anything. | Avoids repeated interruptions. | The user sees the plan, choices, likely outcome, benefits, and trade-offs in one place. | Clear and efficient. | Some early assumptions may need correction. |
| Early clarification | The assistant asks immediately only when it cannot understand the goal or risk. | Prevents work from starting on a wrong target. | Unclear requests are clarified before planning. | Safer for ambiguous work. | Can interrupt more often. |
| Milestone control | The assistant pauses at major checkpoints for user choice. | Gives more control during risky work. | The user can redirect before each large step. | Strong oversight. | Slower completion. |

## When to Use

- 2+ viable solutions exist with clear trade-offs
- Product/Business direction must be clarified
- Security or rollback risk requires explicit acknowledgment

## When Not to Use

- The answer would not change the deliverable, scope, risk, cost, permission, or acceptance
- The assistant can proceed with an explicit assumption and document it
- The question exists only to satisfy a question count

## Prompt Acceptance

This template binds `user-interaction-and-i18n`, `governance-orchestration`, `runtime-native-surfaces`, and `verification-eval-and-release`. It captures the semantic decision card and leaves renderer-specific payloads to runtime adapters.

## Pass

- The question changes the user-visible result, scope, risk, cost, permission, or acceptance.
- Options are materially different, understandable to a non-technical user, and include trade-offs.
- A recommended default is marked when Critical, Fetch, and Thinking evidence supports one.
- Runtime fallback preserves decision purpose, route-changing dimension, runtime-native maximum option policy, trade-offs, selection result, fallback reason, writeback target, and locale.

## Fail

- The template is used for a ritual question that does not change the route.
- It exposes internal packet jargon as the primary user-facing choice.
- It embeds Codex, Claude Code, Cursor, or OpenClaw renderer schemas into the generic template.

## Block

Block the decision card when fewer than two viable options exist, evidence is too weak to state trade-offs, the user already gave a binding instruction, or the question only satisfies a process quota.

## Return to stage

Return to Critical for unclear user outcome. Return to Fetch for missing evidence. Return to Thinking for incomplete branch comparison, owner selection, or acceptance impact.

## Verification

Check runtime-native maximum option policy, route-changing dimension, recommended default, trade-off completeness, fallback reason, selected locale, and writeback target. Run `npm run meta:prompt:validate` after editing this template.

## Preserve

Preserve user control, native choice surfaces, chat fallback, localization, and the distinction between semantic decision contracts and runtime-specific rendering schemas.
