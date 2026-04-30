# Ten-step governance — full reference

> Distilled into the canonical meta-theory reference set; aligns with the Meta_Kim methodology.
> **Steps 1–3 = “it moves.” Steps 4–10 = “it matures.”**

## Core proposition

Governance means: **the system not only does work — it judges, corrects, verifies, and evolves.**

A first output only proves motion. Motion ≠ reliability ≠ reusability ≠ evolvability.

> **AI maturity is not “how good the first draft is” but whether a self-correction loop exists.**

---

## Ten-step map

```
Direction(1) → Plan(2) → Execute(3) → Review(4) → Meta-review(5) → Revise(6) → Verify(7) → Summary(8) → Feedback(9) → Evolve(10)
├────── moves ──────┤├──────────────────── matures ─────────────────────────────────────────┤
```

---

## Step by step

### Step 1: Direction

| Attribute | Content |
|-----------|---------|
| **Owners** | Warden + user |
| **Input** | User need (possibly fuzzy) |
| **Core work** | Clarity check → intent core → complexity class |
| **Output** | Clear intent core + complexity (simple / medium / complex) |
| **Gate** | Core must be testable: one sentence for “done looks like”? If not → clarify |

**Clarification rules**:

- At most 2 rounds (guide cards)
- Still fuzzy after 2 → conservative assumptions, mark assumptions
- Do not guess intent forever

### Step 2: Planning

| Attribute | Content |
|-----------|---------|
| **Owner** | Conductor |
| **Input** | Intent core + complexity |
| **Core work** | Decompose → assign metas → dependencies → deck |
| **Output** | Task plan + deck config + parallel/serial flags |
| **Gate** | Every subtask maps to a concrete meta; if not → creation pipeline |

**Complexity routing here**:

- Simple (<2 files) → skip heavy planning, execute
- Medium (2–5) → light plan
- Complex (>5) → full plan + dependency picture

### Step 3: Execute

| Attribute | Content |
|-----------|---------|
| **Owners** | Execution metas (per assignment) |
| **Input** | Plan + concrete subtasks |
| **Core work** | Search assets → match capability → execute → artifacts |
| **Output** | Code / docs / config / design |
| **Gate** | Single writer per file at a time |

**Execution rules**:

- No overlapping files → safe parallel
- Overlap → serial; second waits
- No owning meta → Type B creation pipeline

### Step 4: Review

| Attribute | Content |
|-----------|---------|
| **Owner** | Prism |
| **Input** | Step 3 artifacts |
| **Core work** | Slop scan → assertion review → declared checks → depth → grade |
| **Output** | Prism report: assertions PASS/FAIL + grade S/A/B/C/D |
| **Gate** | A/S pass; B revise; C/D redo |

**Review is not a score** — it is forensic:

- Every claim needs evidence (path, line, data)
- Hidden assumptions must be surfaced and tested
- No evidence → FAIL

### Step 5: Meta-review

> **Who reviews the reviewer?**

| Attribute | Content |
|-----------|---------|
| **Owner** | Warden (reviews Prism’s *bar*, not re-judging the artifact) |
| **Input** | Prism report + review standard |
| **Core work** | Assertion coverage → assertion strength → standard consistency |
| **Output** | Pass / need more / drift warning |
| **Gate** | See meta-review protocol below |

#### Meta-review protocol

Warden examines Prism’s standard, not the artifact again:

| Dimension | Method | If fail |
|-----------|--------|---------|
| **Coverage** | Do assertions cover all critical dimensions? | Add missing dimensions |
| **Strength** | Weak assertions faking confidence? | Tighten (e.g. “has Core Truths” → “≥3 and replaceability-tested”) |
| **Consistency** | Same bar as last similar review? | Log delta: evolution vs drift |

**Triggers**:

```
IF Prism pass_rate > 0.9 AND output clearly bad
  THEN force meta-review (bar too loose)

IF Prism pass_rate < 0.3 AND output looks reasonable
  THEN force meta-review (bar too tight)

IF standard differs >30% from last similar review
  THEN drift warning → Warden decides.
```

> **Weak PASS is worse than FAIL — it breeds false confidence.**

### Step 6: Revision

| Attribute | Content |
|-----------|---------|
| **Owner** | Original execution meta |
| **Input** | Prism report + Warden meta-review notes |
| **Core work** | Fix per feedback → resubmit |
| **Output** | Revised artifacts |
| **Gate** | Max 3 AutoFix rounds; still B after 3 → Warden. AutoFix = automatic fix loop without user until cap. |

**Revision tiers**:

- B → add cases, citations
- C → replace generic text with real data
- D → re-execute from scratch

### Step 7: Verify

| Attribute | Content |
|-----------|---------|
| **Owner** | Prism (independent of reviser) |
| **Input** | Revised artifacts |
| **Core work** | Re-run same assertions → confirm fixes landed |
| **Output** | Pass / need more revision |
| **Gate** | Fresh evidence required — not “I think I fixed it” |

> **Verification is not self-congratulation. Changed ≠ fixed. Re-run assertions.**

### Step 8: Summary

| Attribute | Content |
|-----------|---------|
| **Owner** | Warden |
| **Input** | Full run data + final artifacts |
| **Core work** | Integrate reports → extract learning → exec-facing memo |
| **Output** | Exec memo (shell-matched) + learning log |
| **Gate** | Pass intent-amplification checks on the memo |

**Summary ≠ paste** — reconcile conflicts, extract learning for Step 10.

### Step 9: Feedback

| Attribute | Content |
|-----------|---------|
| **Owners** | User / exec |
| **Input** | Summary + artifacts |
| **Core work** | Satisfaction → change requests → acceptance |
| **Output** | Confirmed / changes requested |
| **Gate** | Explicit confirmation; vague (“fine I guess”) → ask what failed |

### Step 10: Evolution

| Attribute | Content |
|-----------|---------|
| **Owners** | Everyone (per-meta) + Conductor coordination |
| **Input** | Full trace + user feedback |
| **Core work** | Five-dimension scan → amplification actions |
| **Output** | Evolution backlog + executed changes |
| **Gate** | At least one dimension with a concrete action (not all “no change”) |

Detail: `references/intent-amplification.md`.

---

## Complexity routing

Not every task runs all eleven steps.

### Simple (<2 files)

```
Direction(1) → Execute(3) → Review(4) → Verify(7) → Feedback(9)
Skip: Plan(2), Meta-review(5), Revise(6), Summary(8), Evolve(10)
```

Small change: review + verify suffice; no meta-review or full evolution.

### Medium (2–5 files)

```
Direction(1) → Plan(2) → Execute(3) → Review(4) → Meta-review(5) → Revise(6) → Verify(7) → Feedback(9)
Skip: Summary(8), Evolve(10)
```

Planning + meta-review matter; evolution optional at this scale.

### Complex (>5 files / multi-module)

```
Full 1–10
```

Large change: meta-review against blind spots, summary, evolution.

### Escalation matrix

| Signal | Escalate |
|--------|----------|
| File count crosses 2 | simple → medium |
| Cross-module deps | medium → complex |
| Sentinel security | any → complex (full path) |
| Prism finds systemic issue | medium → complex |
| User demands full process | any → complex |

---

## Signal flow

```
Direction(1) ──core+complexity──→ Plan(2)
Plan(2) ──deck+assignments──→ Execute(3)
Execute(3) ──artifacts──→ Review(4)
Review(4) ──report──→ Meta-review(5)
         ──feedback──→ Revise(6)
Meta-review(5) ──standard fix──→ Revise(6) if needed
Revise(6) ──revised──→ Verify(7)
Verify(7) ──pass──→ Summary(8)
         ──fail──→ Revise(6) (loop, max 3 AutoFix)
Summary(8) ──exec memo──→ Feedback(9)
Feedback(9) ──confirm──→ Evolve(10)
         ──changes──→ Revise(6)
Evolve(10) ──actions──→ [stronger next run]
```

---

## Meta-review deep dive

Easiest to skip; worst to skip.

### Why it exists

Prism judges output quality. **Who judges Prism’s judgment?**

**Risks**:

- Too loose → bad output passes (false confidence)
- Too tight → good output blocked (waste)
- Drifting standard → same work passes today, fails tomorrow

### What meta-review does **not** do

- Re-review the artifact (Prism’s job)
- Nitpick Prism’s conclusions (unless the standard is wrong)
- Replace Prism

### What it **does**

- Assertion coverage on critical dimensions
- Assertion strength (weak-PASS detection)
- Historical consistency (drift)

### Prism’s obligations under meta-review

- Publish full assertion list and rubric
- Explain each assertion’s design
- Mark deltas vs last similar review
- Accept Warden’s standard adjustments

See `.claude/agents/meta-prism.md` “reviewed-party protocol.”
