# Intent amplification — full reference

> Distilled into the canonical meta-theory reference set; aligns with the Meta_Kim methodology.

## Core proposition

**High-level intent, structurally expanded.** Not one actor doing everything — intent amplified layer by layer through the organization into system-level output.

> **One intent should not have only one expression. Mature systems swap shells, not cores, by touchpoint, role, and context.**

---

## Intent core + delivery shell

### Intent core (stable)

The underlying goal / information / decision. Does not change with packaging.

Examples:

- “The auth system needs a token refresh mechanism” — intent core
- “Progress is ~20% behind plan” — intent core
- “Genesis SOUL.md is missing Decision Rules” — intent core

### Delivery shell (contextual)

How the core is wrapped for a given audience. Same core, different shell.

Example — core: “Token refresh must be implemented”:

| Audience | Shell |
|----------|-------|
| Exec | “Auth module lacks one security-critical item; ~2 extra days.” |
| Developer | “Implement `refreshToken()`, trigger JWT refresh 5 minutes before expiry; see API design doc.” |
| End user | “You stay signed in without re-entering credentials.” |

---

## Four dimensions of shell choice

### Matrix

| Dimension | Options | Effect |
|-----------|---------|--------|
| **Audience** | Exec / developer / user / auditor | Abstraction and depth |
| **Touchpoint** | Doc / chat / notification / report | Format and length |
| **Context density** | First view / revisit / emergency | How much background |
| **Attention budget** | High / medium / low | Information density |

### Decision sketch

```
selectDeliveryShell(card, audience, context):

  IF audience = exec:
    → high abstraction, conclusions first, recommended actions
    → format: summary + key numbers + next steps

  IF audience = developer:
    → low abstraction, implementation detail, code refs
    → format: technical note + paths + snippets

  IF audience = auditor:
    → medium abstraction, evidence chain, verifiable claims
    → format: assertion + evidence + verdict

  THEN adjust for context density:
    IF first view → add background
    IF revisit → deltas only
    IF emergency → conclusions + actions only

  THEN adjust for attention budget:
    IF high → full detail
    IF medium → core + expandable links
    IF low → one-line summary
```

---

## Card cost vs shell

Shell choice directly affects attention cost:

| Shell type | Attention cost | When |
|------------|----------------|------|
| One-liner | low | Low budget, confirmation |
| Structured report | mid | Medium budget, overview |
| Full technical doc | high | First deep dive |
| Delta-only | low | Revisit, changes only |
| Decision memo | mid | Exec, needs actions |

**Ties to rhythm**: on each card, Conductor picks shell for audience + context to control cost.

---

## Five evolution amplification actions

Evolution scans are not the end state — they must become structural upgrades.

### 1. Pattern reuse → extract

| Finding | Action | Owner |
|---------|--------|-------|
| Reusable code pattern | Skill → Artisan pool | Artisan |
| Reusable workflow | Orchestration template → Conductor library | Conductor |
| Reusable review pattern | Assertion template → Prism library | Prism |

### 2. Agent boundaries → restructure

| Finding | Action | Owner |
|---------|--------|-------|
| Role creep (>2 domains) | Split → Type B pipeline | Warden |
| Over-fragmentation | Merge / regroup | Warden |
| Five criteria still pass | Snapshot verification | Prism |

### 3. Guidance UX → interaction

| Finding | Action | Owner |
|---------|--------|-------|
| >2 clarification rounds | Tune guide cards / intent presets | Conductor |
| User must supply too much context | Stronger memory / history fill | Librarian |
| Misunderstanding rate > 0 | Tighten Decision Rules / disambiguation | Genesis |

### 4. Process bottleneck → throughput

| Finding | Action | Owner |
|---------|--------|-------|
| Slowest step | Root cause → parallelize or precompute | Conductor |
| Highest failure rate | Pre-checks or simpler fallback | Sentinel |
| Serial waste | Mark parallelizable steps, update deck deps | Conductor |

### 5. Capability coverage → scale

| Finding | Action | Owner |
|---------|--------|-------|
| New capability gap | New meta/skill or Scout | Scout / Genesis |
| Missing tool/skill | Scout scan → ROI → adopt? | Scout |
| Knowledge gap | Memory / references + Librarian index | Librarian |

---

## Warden: intent amplification review

During synthesis, check delivery quality:

### Exec shell checklist

| Check | Method | If fail |
|-------|--------|---------|
| Right abstraction level? | Exec memo should not embed raw code paths | Rewrite higher |
| Conclusion first? | First paragraph states the core verdict | Restructure |
| Actionable recommendation? | Not information-only | Add “recommended actions” |
| Density matches budget? | Exec usually “medium” budget | Trim detail |

### Cross-audience consistency

Same core across audiences:

- Facts must agree (cannot tell exec “on track” and dev “late”)
- Only the shell differs, not contradictory substance
- If contradiction → reconcile the core, then re-shell

---

## Relationship to other threads

```
Meta (split)
  ↓ yields independently deliverable units
Organizational mirror (compose)
  ↓ yields layered audiences (exec / middle / execution)
Rhythm orchestration (deal)
  ↓ yields timing and attention budget
Intent amplification (deliver) ← this layer
  ↓ yields structured delivery by audience, touchpoint, context
```

Intent amplification is the **terminal layer** — upstream work becomes effective system output here.

---

## Scenario: security fix shipped

**Intent core**: XSS fixed on three pages; verification needed.

| Audience | Shell |
|----------|-------|
| Exec | “Security-critical fix shipped; three user-facing pages hardened. Suggested next step: schedule a security review.” |
| Developer | “XSS fixed at `pages/profile.tsx:42`, `pages/settings.tsx:88`, `pages/dashboard.tsx:156`. DOMPurify on user input. Needs code review + regression.” |
| Auditor | “Claim: all user-input paths sanitized. Evidence: three `innerHTML` sites → `DOMPurify.sanitize()`. Test: inject `<script>alert(1)</script>`.” |


## Use when

Use when real intent, path choice, first action, pass/kill, and userGoalDone affects route, owner, risk, acceptance, verification, public-ready, or evolution writeback.

## Required inputs

- Latest user request and `intentPacket`
- `fetchPacket` evidence that changes decision
- runtime and OS targets when tools or dependencies are involved
- relevant config, registry, script, or artifact path

## Do

- Assign an owner for each action.
- Produce a checkable packet or artifact.
- Bind pass/fail to evidence, threshold, or command output.
- Preserve existing foundational and native runtime capabilities.

## Do not

- Do not delete skills, dependencies, web/browser/research, shell, filesystem, apply_patch, MCP, memory, graph, hooks, scripts, runtime tools, or native platform abilities.
- Do not use vague advice without trigger, output, evidence, and writeback.
- Do not route reference-only or unknown dependencies into execution.

## Required packet

`referenceContractPacket`: `referenceId`, `trigger`, `requiredInputs`, `actions`, `outputs`, `passCriteria`, `failCriteria`, `blockConditions`, `returnStage`, `verification`, `writebackTarget`.

## Pass

- At least one action has owner, input, output, and verification.
- Pass criteria include numeric threshold, required field list, command, artifact, or human acceptance record.
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

## Evidence-Informed Requirements Dialogue

Reuse the seven intent dimensions in `workflow-contract.json` and the question history in `preDecisionOptionFrame.unresolvedQuestions`; they remain the single requirements authority. Fetch reads project facts and existing decisions before asking the user. Replay a concrete scenario, example or counterexample when an adjective or desired outcome could imply different deliverables. Ask the highest-impact unresolved question whose answer changes a goal, audience, scope, cost, deadline, quality, tool, permission or acceptance criterion. There is no fixed number of questions.

Compare multiple directions only when they are genuinely viable and materially different. Describe their outcome, relevant cost/time/quality/extension trade-offs and uncertainty from evidence; do not invent estimates or filler routes. A cheap, bounded sample may distinguish uncertain directions before a larger implementation. A user's settled direction carries its evidence into the goal contract, pre-decision frame, business blueprint, capability bindings and worker packets. Reopen a decision only when new material evidence changes it; ordinary implementation details use the existing authorization.

Professional capabilities receive that settled task and constraints. They may use their own domain methods and existing tools, but must return a material goal/cost/deadline/permission discovery to the Meta_Kim merge owner instead of launching another interview or orchestrator. A reference's planning files or goal draft do not replace the sole PRD, first-party planning-continuity or native decision authority. Understanding/route choice is distinct from action permission; a confirmed goal cannot grant credentials, paid services or external writes.

Method provenance is pinned in `config/governance/decision-pattern-catalog.json`: EveryInc/compound-engineering-plugin `ce-brainstorm` contributes interaction, dialogue, approaches, visual probes and settled-decision techniques; active `open-gsd/gsd-core` contributes outcome-focused question examples; BMAD-METHOD contributes unresolved-question convergence; LoopX contributes a read-only shared-goal draft idea. These are methods, not installed execution dependencies. Preserve GSD migration provenance rather than presenting the retired repository as active. Do not import a second pack resolver, mandatory visual offer, chat fallback, global workflow, fixed questionnaire or competing goal authority.

## Preserve

Preserve Skills, WebSearch/browser/research, filesystem, shell, apply_patch, MCP, memory, Graphify, graph, hooks, commands, rules, agents, subagents, approval, sandbox, runtime tools, package scripts, setup, sync, install, uninstall, status, doctor, validators, and runtime projections.
