# Scar Protocol

A **scar** is a permanent record of a failure that reveals a structural weakness in the Meta_Kim system. Unlike temporary session notes, scars persist and feed back into the governance system via `evolution-contract.json` → `scarDetected` target.

## When to Record a Scar

Record a scar when:
- A review gate was passed incorrectly (false positive) — the problem resurfaced later
- An agent boundary was violated — one agent overstepped another's domain
- A governance step was skipped — "we'll skip review this time" caused a regression
- A Fetch assumption was wrong — the agent turned out to not own what we assumed
- A process gap caused damage — the governance system had no hook for this failure type

**Do NOT record as scar**: individual coding bugs, external service failures, user errors. A scar is about **systemic governance failure**, not task-level mistakes.

## Scar Record Schema

```yaml
scar:
  id: "{YYYY-MM}-{type}-{short-desc}"   # e.g., 2026-04-overstep-warden-gate
  type: overstep | boundary-violation | process-gap | false-positive
  date: YYYY-MM-DD
  triggered_by: "{context that exposed the scar}"
  what_happened: "one sentence"
  root_cause: "why this happened at the governance level (not the symptom)"
  impact: none | degraded | recovered | critical
  prevention_rule: "specific rule for next time"
  closed_by: "{agent or person}"
  contract_updated: boolean   # did this trigger evolution-contract.json update?
```

## Scar Lifecycle

1. **Detect**: During Review/Meta-Review/Verification, Prism or Warden identifies a systemic failure
2. **Record**: Write the scar to `memory/scars/{id}.md` following this schema
3. **Classify**: Determine the `type` and `impact`
4. **Trigger**: If `impact: recovered or critical`, update `contracts/scar-protocol.md` and trigger the `scarDetected` loop in `evolution-contract.json`
5. **Audit**: During future Critical stages, scan `memory/scars/` for relevant patterns before proceeding

## Storage

```
memory/
└── scars/
    └── {YYYY-MM}-{type}-{short-desc}.md
```

## Examples

### Example 1: False Positive Review Gate
```yaml
scar:
  id: 2026-04-false-positive-review
  type: false-positive
  date: 2026-04-01
  triggered_by: "User reported the auth bug that 'passed review' last week"
  what_happened: "Review gate passed a PR that introduced auth bypass"
  root_cause: "Review was scoped to code quality only, not security implications"
  impact: recovered
  prevention_rule: "All auth/permission changes must pass security-reviewer before Review gate closes"
  closed_by: meta-prism
  contract_updated: true
```

### Example 2: Agent Boundary Overstep
```yaml
scar:
  id: 2026-04-boundary-overstep-artisan
  type: boundary-violation
  date: 2026-04-01
  triggered_by: "Conductor re-sequenced Artisan's skill loadout without consultation"
  what_happened: "Conductor deleted 3 skills from agent loadout during dispatch sequencing"
  root_cause: "Conductor owned 'when to invoke' but also modified 'what the agent can do'"
  impact: degraded
  prevention_rule: "Conductor may sequence stages but may not modify skill loadout; any loadout change requires Artisan re-approval"
  closed_by: meta-warden
  contract_updated: true
```

### Example 3: Process Gap — No Hook for This Failure
```yaml
scar:
  id: 2026-04-process-gap-missing-evidence
  type: process-gap
  date: 2026-04-01
  triggered_by: "Evolution artifacts persisted only in conversation context and were lost on session end"
  what_happened: "5 hours of pattern extraction work vanished when session was cleared"
  root_cause: "Evolution Stage 8 had no mandatory storage requirement enforcement"
  impact: critical
  prevention_rule: "Evolution artifacts MUST be persisted before Stage 8 closes (enforced by Verification gate)"
  closed_by: meta-conductor
  contract_updated: true
```
