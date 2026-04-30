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
