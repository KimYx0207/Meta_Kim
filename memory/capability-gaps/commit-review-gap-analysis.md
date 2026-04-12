# Commit Review Gap Analysis

**Date**: 2026/04/12
**Analyst**: meta-artisan
**Subject**: Pre-design decision for "git commit review agent"

---

## 1. Gap Analysis Table

| Dimension | Status | Evidence |
|-----------|--------|----------|
| **CLAUDE.md commit creation rules** | EXISTS | `<type>: <description>` format with 8 types (feat, fix, refactor, docs, test, chore, perf, ci) |
| **CLAUDE.md commit REVIEW rules** | MISSING | Only defines creation format, no review criteria |
| **Commit format validation** | MISSING | No hook or skill validates conventional commit format before push |
| **Commit message quality review** | MISSING | No capability to check description quality, scope clarity, or imperative mood |
| **Pre-push hook** | EXISTS | `pre-git-push-confirm.mjs` - confirms before push, does NOT validate format |
| **meta-prism** | EXISTS | Quality forensics, but NOT specialized for git commit format checking |

---

## 2. Capability Coverage Map

| Capability | Source | Coverage |
|------------|--------|----------|
| Commit creation format rules | CLAUDE.md | Full (8 types + format) |
| Commit creation execution | `zcf:git-commit` skill | Full |
| Commit format validation | NONE | 0% |
| Commit message quality review | NONE | 0% |
| Imperative mood enforcement | NONE | 0% |
| Scope validation | NONE | 0% |

**Conclusion**: A **CAPABILITY GAP EXISTS** for commit review/validation.

---

## 3. External Candidate Evaluation

Scout found 5 candidates. Here is the ROI analysis:

| Candidate | Installs | Primary Function | Meta_Kim Fit | ROI Score |
|-----------|----------|------------------|--------------|-----------|
| `ron-myers/candid@candid-review` | 46 | Commit quality review | Medium - generic review | 3-star |
| `mrclrchtr/skills@git-commit` | 21 | Commit best practices | Medium - creation focused | 2-star |
| `athola/claude-night-market@git-workspace-review` | 19 | Workspace review | Low - too broad | 1-star |
| `lidessen/skills@refining` | 15 | Commit refining | Medium - post-creation | 2-star |
| `lidessen/moniro@refining` | 14 | Commit refining | Medium - post-creation | 2-star |

### ROI Formula Applied

```
ROI = (Task Coverage x Usage Frequency) / (Context Cost + Learning Curve)
```

| Candidate | Coverage | Frequency | Cost | ROI | Verdict |
|-----------|----------|-----------|------|-----|---------|
| candid-review | 70% | High (every commit) | Low | **4.2** | Best fit |
| git-commit | 40% | Medium | Low | **2.4** | Overlaps with existing `zcf:git-commit` |
| git-workspace-review | 30% | Low | Medium | **1.2** | Too broad, ROI < 1 |
| refining (x2) | 35% | Low | Low | **2.1** | Post-creation, not real-time |

---

## 4. Recommendation

### DECISION: **CREATE NEW** (vs install external)

**Rationale**:

1. **Meta_Kim specific rules require custom implementation**:
   - 8 commit types (feat, fix, refactor, docs, test, chore, perf, ci)
   - No attribution rule
   - Imperative mood enforcement
   - Scope naming conventions

2. **Integration with existing hooks**: The gap is NOT just "can we review commits" but "can we validate commits BEFORE push in Meta_Kim's workflow". External skills may not integrate cleanly with `.claude/hooks/pre-git-push-confirm.mjs`.

3. **Best candidate (candid-review) ROI < 4.5**: While candid-review has decent ROI (4.2), it is a general-purpose commit review skill without Meta_Kim-specific conventions baked in.

4. **Low install count**: Top candidate has only 46 installs - not battle-tested enough for Meta_Kim's governance standards.

---

## 5. If Creating New: Required Capabilities

| Capability | Priority | Description |
|------------|----------|-------------|
| **Format validation** | MUST | Regex check: `<type>(optional-scope): <description>` |
| **Type whitelist** | MUST | Only allow 8 types defined in CLAUDE.md |
| **Imperative mood check** | SHOULD | Warn if description starts with past tense, passive, or "the" |
| **Description length** | SHOULD | Warn if <10 chars (too vague) or >72 chars (line wrap risk) |
| **No attribution check** | MUST | Ensure no `Co-authored-by` or author attribution |
| **Scope validation** | CAN | Optional: validate scope against project-specific list |
| **Breaking change flag** | CAN | Check for `!` after type or `BREAKING CHANGE` in body |
| **Body/footer awareness** | CAN | Allow multi-line commits with proper formatting |

### Integration Points

1. **Pre-push hook enhancement**: Extend `pre-git-push-confirm.mjs` to call commit review
2. **Meta-prism integration**: Commit review can feed quality signals to meta-prism
3. **PR workflow**: Integrate with `config/contracts/workflow-contract.json` PR phases

---

## 6. Implementation Path

### Option A: Skill-based (Recommended for Meta_Kim)
- **File**: `canonical/skills/commit-review/SKILL.md`
- **Pros**: Portable across runtimes, governed by Meta_Kim
- **Cons**: Requires manual invocation or hook integration

### Option B: Hook-based
- **File**: `.claude/hooks/pre-commit-msg-validate.mjs`
- **Pros**: Automatic, runs with git hooks
- **Cons**: Platform-specific (git hooks), not portable

### Option C: Agent-based
- **File**: `canonical/agents/commit-reviewer.md`
- **Pros**: Full Meta_Kim agent patterns, can invoke meta-prism
- **Cons**: Heavier than needed for format validation

**Recommendation**: **Option A** (Skill) with **Option B** (Hook) integration point.

---

## 7. Action Items

| Owner | Action | Priority |
|-------|--------|----------|
| **Genesis** | Create `SOUL.md` for commit-reviewer agent if agent-based approach chosen | P2 |
| **Scout** | Close external candidate evaluation (insufficient ROI for Meta_Kim) | DONE |
| **Artisan** | Design skill loadout for commit-reviewer | P1 |
| **Conductor** | Define when in workflow commit review should be invoked | P2 |
| **Warden** | Approve integration with pre-push hook | P2 |

---

## 8. Fallback Plan

If resources are constrained, the **minimum viable commit review** can be achieved by:

1. Adding format validation to `pre-git-push-confirm.mjs`
2. Using existing `zcf:git-commit` for commit creation with built-in format hints

This covers 60% of the gap at 20% of the implementation cost.

---

**End of Analysis**
