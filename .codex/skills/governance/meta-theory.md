# Meta-theory methodology — full reference

## Four threads (core frame)

The end-to-end meta methodology:

```
Meta (split) → Organizational mirror (compose) → Rhythm orchestration (deal) → Intent amplification (deliver)
```

| Layer | What it solves | Core question |
|-------|----------------|---------------|
| **Meta** | How to split | To what grain should the system be decomposed so it both works and stays governable? |
| **Organizational mirror** | How to compose | How do metas form a structured organization? |
| **Rhythm orchestration** | How to deal | How does the org play cards gracefully instead of dumping everything at once? |
| **Intent amplification** | How to deliver | How is high-level intent structurally expanded into system-level outcomes? |

> The first two layers answer “how the system stands up.” The last two answer “how it runs gracefully.”

### Dependency among the four threads

```
Meta (split)      ← Base: without metas, the rest is hollow
  ↓
Organizational mirror (compose) ← Structure: metas must be organized to collaborate
  ↓
Rhythm orchestration (deal) ← Runtime: the org needs rhythm to avoid overload
  ↓
Intent amplification (deliver) ← Output: structured outcomes under rhythm control
```

**Deeper reading**:

- Rhythm → `references/rhythm-orchestration.md`
- Intent amplification → `references/intent-amplification.md`
- Ten-step governance → `references/ten-step-governance.md`

---

## Meta = smallest governable unit

### Five criteria

**Meta = smallest governable unit** must satisfy:

1. **Independent** — understandable, invokable, and productive on its own
2. **Small Enough** — further split is pointless or costs more than it saves
3. **Clear Boundaries** — explicit “owns” vs “does not touch”
4. **Replaceable** — swap without collapse; can upgrade or reorganize
5. **Reusable** — useful across scenarios, not one-off

Five Criteria evidence table (use when auditing):

| Criterion | Evidence | Pass |
|-----------|----------|------|
| Independent | Observable invocations + outputs | Yes / No |
| Small Enough | Split cost vs benefit | Yes / No |
| Clear Boundaries | Written owns / does-not-touch | Yes / No |
| Replaceable | Swap experiment notes | Yes / No |
| Reusable | Cross-scenario reuse proof | Yes / No |

### Four death patterns

| Death Pattern | Symptoms | Diagnostic Questions |
|---------------|----------|----------------------|
| **Stew-All** | One agent does everything | >2 unrelated domains? SOUL.md >300 lines? |
| **Shattered** | Too many tiny agents | Needs other agents’ output to produce anything? |
| **Governance-Free Execution** | Only direction → plan → execute; no review → verify → evolve | Who reviews? Who reviews the reviewer? Who verifies fixes? How is learning captured? |
| **Result-Chasing Without Structure** | “It ran once” treated as gospel | Will it run tomorrow? Can a handoff work? Can another model adapt? |

> Death patterns 1–2 are split extremes; 3–4 are governance gaps.
> The first pair makes the system unstable; the second pair keeps it from maturing.

### Omnipotent Executor Meta Anti-Pattern

**Omnipotent Executor Meta Anti-Pattern** — one meta absorbs execution, review, and synthesis until the system shows **compression disease** (everything collapses into one overloaded role). Remediation: **trigger Type B splitting** so Genesis/Artisan stations rebuild boundaries.

Symptoms to flag:

- **execution before thorough understanding**
- **decisions before complete information gathering**
- **modifying shared logic before exposing risks**

**Stew-All** diagnostics (aligned with the table above): watch for **>2 unrelated domains** in one SOUL and **>300 lines** in SOUL.md without a split plan.

**Iron Rule** (splitting): If **the user says** “**these two** concerns are **different**; **split them apart**,” treat that as a forced split even when git data shows high coupling — **user override** on coupling decisions is final.

**Coupling probe** (data + judgment): **if A changes, does B frequently need to change?** High **co-change frequency** → candidates **merge**; low **co-change frequency** → domains may stay **separate**.

Plain-language merge rule (for search/regex checks): high co-change frequency should be merged; low co-change frequency can be separated.

**Meta-verification four questions** (after a split proposal):

1. **Does it have clear boundaries** between owns / does-not-touch?
2. **Can it be replaced without collapsing** neighboring metas?
3. Where could **Cross-contamination** still leak?
4. **Can this meta combine with other metas** without role collapse?

### Golden band for splitting

**Small enough yet whole enough; standalone yet collaborable; responsible without dragging the whole system down.**

Heuristics:

- Split further → governance cost dominates → lower bound
- Merge up → responsibilities blur → upper bound
- The band in between is the golden interval

### Three tiers

| Tier | Role | Examples |
|------|------|----------|
| Execution meta | Does the work; keep scope pure | Frontend, Backend, Quality |
| Orchestration meta | Schedules work, ordering | Commander, meta-conductor |
| Infrastructure meta | Builds capability, not tasks | Memory / skills / tools / rules / permissions / security |

> **Some metas do not “do tasks”; they build capability.**

Execution metas fight on the front line. Orchestration metas run the battle map. Infrastructure metas build airfields, roads, ammo, and rules.

---

## Entry meta

### Definition

**Every project has exactly one entry meta.**

Entry meta = the first agent the user talks to = who turns intent into an executable work package.

It is not “creation order”; it is **entry concentration** — one voice to the user, not a rotating cast.

### Entry meta vs other metas

| Dimension | Entry meta | Other metas |
|-----------|------------|-------------|
| **Entry** | User talks directly | Spawned / routed by entry |
| **Role** | Intent translation + routing + rhythm | Execute concrete tasks |
| **Boundary** | “Owns” user-visible layer | “Owns” internal execution |
| **Count** | One per project | N per project |

### Responsibilities (entry meta only)

| Responsibility | Meaning |
|----------------|---------|
| **Intent translation** | Turn fuzzy asks into concrete tasks |
| **Task routing** | Decide which execution meta owns the work |
| **Rhythm control** | When to speak, when to stay quiet |
| **Gatekeeping** | Block out-of-scope changes (e.g. Frontend edits API) |
| **Unified summary** | User-facing synthesis only from entry meta |

### Outputs

What others “hear” as the single voice:

```
[Structured requirements]
  ↓
[Task breakdown + agent routing]
  ↓
[Autonomous execution + automatic review]
  ↓
[Unified change summary]  ← user sees only this layer
```

### Project scale vs entry name

| Scale | Entry name | Tier | Traits |
|-------|------------|------|--------|
| **Single project** | Commander | Project execution | Requirements guide + decomposition + dispatch |
| **Multi-department** | Warden | Meta layer | Coordinate + arbitrate + final synthesis |
| **Generic template** | Manager | Generic entry | Intent → plan → delivery |

### Core principles

1. **One voice to the user** — execution metas do not speak over the entry meta
2. **Entry meta does not write code** — output is plan and schedule, not implementation
3. **Entry meta is goalkeeper** — out-of-scope changes must be blocked
4. **Entry meta sets rhythm** — when to push, pause, or interrupt

> **No entry meta = many agents talking at once = cognitive overload**

### Place in the organizational mirror

Entry meta is the “user interface layer” of the mirror:

```
User ──→ Entry meta ──→ Execution metas ──→ Governance metas ──→ User
            ↑
         Intent translation
         Task routing
         Rhythm control
         Gatekeeping
```

---

## Organizational mirror

### Definition

Not metaphor — an architecture pattern mapping real org mechanisms to multi-agent systems:

| Mechanism | In orgs | In AI systems |
|-----------|---------|---------------|
| Layered delegation | Top → middle → execution | CEO → Warden → execution agents |
| Role split | Job descriptions | SOUL.md + owns / does-not-touch |
| Separate workspaces | Departments | Per-agent context isolation |
| Review feedback | QA + performance | Review + Meta-Review |
| Continuous improvement | Retros + training | Evolution + memory |

### Three classic failures (without the mirror)

| Failure | Symptom | Root cause |
|---------|---------|------------|
| **Cross-contamination** | Domain A leaks into B | Shared context without isolation |
| **Coordination explosion** | Too many roles, tangled links | Flat messaging, no structure |
| **High design cost** | Hand-crafting every interaction | No org-shaped abstraction |

> **Collaboration can be flat; governance cannot be absent. Equal ≠ chaotic.**

---

## Rhythm orchestration (summary)

### Definition

Orchestration is not only sequencing (who goes first). It includes **rhythm**: what to deliver when — and when **not** to.

### Core idea

> **Telling the user something has a cost.**

- Every suggestion competes for attention
- Every todo competes with other todos
- Every extra goal dilutes focus
- Every pushed task adds cognitive load

Attention, bandwidth, and throughput are finite.

> **Mature systems do not say everything they know; they say what matters most *when* it matters most.**

### Event card deck

The deck implements rhythm: surface freedom, ideal order underneath.

| Card | Trigger | Action | Philosophy |
|------|---------|--------|------------|
| **Clarify** | Ambiguous need | ≤2 rounds of questions | Gather before acting |
| **Scope shrink** | Repo too large / too many files / name clashes | Narrow to a workable boundary | High complexity → reckless edits fail |
| **Options** | Clear need, multiple paths | Lay out routes, tradeoffs, recommendation | Big problems need a map before code |
| **Execute** | Plan done, risk acceptable | Assign to metas, touch code | Execute with a plan |
| **Verify** | Execution done | Build / types / deps / requirements | First pass ≠ correct |
| **Fix** | Verification fails | Repair until pass; cap iterations | Don’t fake “done” |
| **Rollback** | Risk or blast radius grows | Return to last stable state | Retreat is maturity |
| **Risk** | Shared components / auth / global logic / multi-party | Surface risk; preempt if needed | Safety / permissions / global impact first |
| **Nudge** | User stuck, light touch OK | Lower-cost next step | Non-urgent but helpful |
| **Pause** | Streak of completions / digest needed / ≥3 high-cost cards | Stop pushing; short status only | Designed silence can be optimal |

### Three internal mechanisms

Internal to Conductor — not standalone metas (they fail the five criteria):

| Mechanism | Trigger | Behavior |
|-----------|---------|----------|
| **Pause cadence** | ≥3 consecutive high-cost cards | Stop pushing; brief status |
| **Rollback** | Risk or scope exceeds plan | Revert to stable state, reassess |
| **Emergency governance** | Sentinel alert / severe Prism drift | Pause deck; risk card to front |
| **Deal interface** | On each card | Pick channel (reply / file / subagent / wait) |

> Full detail: `references/rhythm-orchestration.md`

---

## Intent amplification (summary)

### Definition

The result of **structurally expanding** high-level intent — not one person doing everything, but intent amplified through org layers into system-level output.

### Intent core + delivery shell

> **One intent should not have only one expression. Mature systems swap shells, not cores, by touchpoint, role, and context.**

- **Intent core** (stable): goal / information / decision
- **Delivery shell** (contextual): packaging for role, channel, UI, format

Four dimensions for shell choice:

1. **Audience** — exec / developer / end user
2. **Touchpoint** — doc / chat / notification
3. **Context density** — first view / revisit / emergency
4. **Attention budget** — high / medium / low

> Detail: `references/intent-amplification.md`

### Five-dimension evolution scan

| Dimension | What to check | Pass bar |
|-----------|---------------|----------|
| **Pattern reuse** | Can this solution become a reusable pattern? | Clear component / template / rule |
| **Agent boundaries** | Still valid? Need split/merge? | Five criteria still pass |
| **Guidance UX** | Can paths be shorter/smoother? | Fewer clarification rounds or simpler inputs |
| **Process bottleneck** | Slowest or error-prone step? | Identified with a fix |
| **Capability coverage** | New gaps? | Logged or triggers creation pipeline |

### Five amplification actions

| Dimension | Finding | Action |
|-----------|---------|--------|
| Pattern reuse | Reusable pattern | Extract skill/template → Artisan pool |
| Agent boundaries | Bad fit | Split/merge → Type B pipeline |
| Guidance UX | Redundant path | Update card triggers / clarification |
| Process bottleneck | Bottleneck | Reprioritize deck; parallelize or skip |
| Capability coverage | Gap | New meta/skill or Scout for tools |

> Detail: `references/intent-amplification.md`

---

## Ten-step governance (summary)

| Step | Meaning | Owner | Key question |
|------|---------|-------|--------------|
| 1. Direction | Requirements | Warden / user | What is the intent? |
| 2. Planning | Decomposition | Conductor | How do metas split? |
| 3. Execution | Search + do | Execution metas | Who does it? |
| 4. Review | Quality | Prism | Is it right? |
| 5. Meta-review | Review the reviewer | Warden on Prism | Is the bar sane? |
| 6. Revision | Fix | Execution metas | How to fix? |
| 7. Verification | Re-check | Prism | Really fixed? Not self-congratulation? |
| 8. Summary | Synthesize | Warden | What did we learn? |
| 9. Feedback | User sign-off | User / exec | Satisfied? |
| 10. Evolution | Five dimensions | Everyone | How to be stronger next time? |

> Steps 1–3 = “it moves.” 4–10 = “it matures.”
> No review → blind rush. No verification → theater. No evolution → repeat mistakes.

### Complexity routing

| Complexity | Rule | Steps |
|------------|------|-------|
| Simple | <2 files | 1→3→4→7→9 (skip meta-review) |
| Medium | 2–5 files | 1→2→3→4→5→6→7→9 |
| Complex | >5 files / multi-module | All 10 |

> Detail: `references/ten-step-governance.md`

---

## Eight-module SOUL design

| # | Module | Role | Quality bar |
|---|--------|------|-------------|
| 1 | Core Truths | Behavioral anchors | ≥3, domain-specific |
| 2 | Role + Core Work | Identity + core duties | Clear owns / does-not-touch |
| 3 | Decision Rules | Choices under uncertainty | ≥3 if/then rules |
| 4 | Thinking Framework | How to think in-domain | Domain-specific steps |
| 5 | Anti-AI-Slop | Anti-template signals | Concrete slop detectors |
| 6 | Output Quality | Verifiable bar | Observable criteria |
| 7 | Deliverable Flow | Handoff path | Clear input→process→output |
| 8 | Meta-Skills | Self-improvement | ≥2 learning directions |

## Quality grades

| Grade | Standard | Action |
|-------|----------|--------|
| **S** | Distinct insight, hard data, executable, hard to replace | Pass |
| **A** | Complete, concrete data, medium depth | Pass |
| **B** | Structurally OK, weak cases/data | Revise |
| **C** | Generic, interchangeable, no real plan | Revise |
| **D** | Template dump, no thinking visible | Redo |

## AI-slop detection

| Signal | How to detect | Verdict |
|--------|---------------|---------|
| Template density | Count “in conclusion / notably / overall” | >0 deducts |
| Missing specificity | No file/function/data citations | Fail |
| Interchangeability | Swap agent name with a competitor; still “works”? | Shallow |
| List stuffing | 5+ bullets each <2 sentences | Superficial |
