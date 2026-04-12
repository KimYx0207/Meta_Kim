# Code Review Capability Gap Analysis

**Date**: 2026-04-12
**Analyst**: meta-artisan
**Status**: Pre-Design Decision

---

## 1. What Meta_Kim Already Has

### 1.1 Meta-Level Review (meta-prism)

| Capability | Description | Gap Coverage |
|------------|-------------|--------------|
| **meta-prism** | Quality forensics for Meta_Kim outputs | Meta governance, AI-slop detection, quality drift |
| **NOT a general code reviewer** | Reviews agent outputs, not project code | N/A |

**Assessment**: meta-prism is **NOT** a general-purpose code reviewer. It reviews Meta_Kim governance artifacts (SOUL.md, agent definitions, workflow outputs). It does NOT review production code files.

### 1.2 Installed Skills (from config/skills.json)

| Skill | Code Review Coverage | Notes |
|-------|---------------------|-------|
| **superpowers:requesting-code-review** | Process trigger | "Use when completing tasks, before merging" |
| **superpowers:receiving-code-review** | Process trigger | "Use when receiving feedback, before implementing" |
| **everything-claude-code:python-review** | Python-specific | Full PEP 8, type hints, security review |
| **everything-claude-code:go-review** | Go-specific | Idiomatic patterns, concurrency, error handling |
| **everything-claude-code:security-review** | Security focus | Auth, secrets, payment features |
| **gstack** | Via /review command | Structured code review (not pre-installed in Meta_Kim) |

### 1.3 Claude Code Global Agents

| Agent | Description | Availability |
|-------|-------------|--------------|
| **code-reviewer** | "Elite code review expert... security vulnerabilities, performance optimization" | `~/.claude/agents/code-reviewer.md` |

---

## 2. External Candidates (Scout's List)

| Candidate | Installs | Language | Focus | ROI Estimate |
|-----------|----------|----------|-------|--------------|
| `google-gemini/gemini-cli@code-reviewer` | 4.3K | Any | General | 4-star |
| `coderabbitai/skills@code-review` | 1.5K | Any | PR-focused | 4-star |
| `anthropics/knowledge-work-plugins@code-review` | 1.3K | Any | General | 3-star |
| `vladm3105/aidoc-flow-framework@code-review` | 58 | Any | Documentation | 2-star |
| `samhvw8/dot-claude@code-review` | 31 | Any | General | 2-star |
| `thebushidocollective/han@code-review` | 22 | Any | General | 2-star |

---

## 3. Gap Analysis

### 3.1 IS Covered

| Use Case | Coverage | Provider |
|----------|----------|----------|
| Meta-level quality review (Meta_Kim artifacts) | **Full** | meta-prism |
| Python code review | **Full** | everything-claude-code:python-review |
| Go code review | **Full** | everything-claude-code:go-review |
| Security code review | **Full** | everything-claude-code:security-review |
| TypeScript/JavaScript review | **Partial** | Claude Code code-reviewer agent |
| Process trigger (request/receive review) | **Full** | superpowers |

### 3.2 NOT Covered (The Gap)

| Use Case | Gap Severity | Notes |
|----------|--------------|-------|
| **General-purpose code review (any language)** | **CRITICAL** | Meta_Kim SOUL.md requires agent to review code in ANY language |
| **Multi-language codebase review** | **HIGH** | No skill covers Python + Go + TypeScript + Rust + etc. |
| **Language-agnostic review checklist** | **HIGH** | What does "review code" mean without language-specific rules? |
| **Framework-specific review (React, Django, Spring)** | **MEDIUM** | No universal framework review pattern |

### 3.3 The Core Gap

Meta_Kim's execution agents (e.g., Type C pipeline execution agents) need to:
1. Review code in **any language** (Python, Go, TypeScript, Rust, etc.)
2. Apply **universal quality patterns** (DRY, SOLID, security, performance)
3. Use **language-specific best practices** when available

Currently, Meta_Kim has:
- Language-specific skills (python-review, go-review) — **fragmented**
- No unified general-purpose code review skill — **gap**
- Claude Code's global `code-reviewer` agent — **available but not Meta_Kim-native**

---

## 4. Decision: What Should Meta_Kim Do?

### 4.1 Options

| Option | Pros | Cons |
|--------|------|------|
| **A: Use Claude Code code-reviewer agent** | Already installed, full-featured | Not Meta_Kim-native, not in skill ecosystem |
| **B: Install external code-review skill** | Unified, maintained | 58-4.3K installs (quality variance), adds dependency |
| **C: Create Meta_Kim native skill** | Full control, tailored to Meta_Kim | Design cost, maintenance burden |
| **D: Composite (existing + agent dispatch)** | Lowest cost, leverages existing | No unified trigger, ad-hoc |

### 4.2 Recommendation: **Option A + D Hybrid**

**Decision**: Meta_Kim should **NOT create a new code review skill** because:

1. **Claude Code code-reviewer agent already exists**: `~/.claude/agents/code-reviewer.md` with "Elite code review expert specializing in modern AI-powered code analysis, security vulnerabilities, performance optimization"

2. **Everything-claude-code has language-specific reviews**: python-review, go-review are already installed for deep dives

3. **ROI Analysis**:
   | Factor | Value |
   |--------|-------|
   | Task Coverage | 85% (general code) + 95% (Python/Go) |
   | Usage Frequency | Medium (per PR/feature) |
   | Context Cost | Zero (already installed) |
   | Learning Curve | Low (just invoke agent) |
   | **ROI** | **5-star** |

4. **No external skill needed**: The external candidates (4.3K down to 22 installs) offer no advantage over:
   - Claude Code's built-in `code-reviewer` agent
   - everything-claude-code's language-specific skills

### 4.3 The Execution Pattern

Meta_Kim should dispatch the `code-reviewer` agent for general code review:

```
Execution Agent needs code review
  |
  |-> Dispatch: `claudeCode:code-reviewer` subagent
  |   OR
  |-> Use: everything-claude-code:python-review (for Python)
  |-> Use: everything-claude-code:go-review (for Go)
```

---

## 5. Gap Closure Status

| Gap | Status | Action |
|-----|--------|--------|
| General-purpose code review | **CLOSED** | Use `code-reviewer` Claude Code agent |
| Python review | **CLOSED** | everything-claude-code:python-review |
| Go review | **CLOSED** | everything-claude-code:go-review |
| Security review | **CLOSED** | everything-claude-code:security-review |

**No new capability needed.**

---

## 6. For Genesis (If Future Decision Changes)

If a Meta_Kim-native code review skill is ever needed, Genesis should design:

### 6.1 Trigger Conditions
- "Review the code in src/utils/" (any file, any language)
- "Check if this PR follows our coding standards"
- "Audit this function for security issues"

### 6.2 Skill Structure
```
meta-code-review/
  SKILL.md          # Universal review checklist + language dispatch
  languages/
    python.md       # Python-specific patterns
    typescript.md   # TS-specific patterns
    golang.md       # Go-specific patterns
  security.md       # Security audit checklist
  performance.md    # Performance review checklist
```

### 6.3 Decision for Genesis
- **CREATE NEW**: Only if Meta_Kim needs Meta_Kim-specific review patterns (e.g., Meta_Kim constitutional principles compliance)
- **USE EXISTING**: For general code review, the `code-reviewer` agent + everything-claude-code skills are sufficient

---

## 7. Conclusion

| Question | Answer |
|----------|--------|
| Does meta-prism cover code review? | **NO** — meta-prism reviews Meta_Kim artifacts, not code |
| Is there a gap for general code review? | **YES** — but covered by Claude Code's code-reviewer agent |
| Should we install external code-review skill? | **NO** — existing capabilities are sufficient |
| Should we create a new code review agent/skill? | **NO** — ROI < 1 (existing solutions already exist) |

**Verdict**: No action required. Code review capability is covered by existing Claude Code infrastructure.

---

## 8. Action Items

| Owner | Action | Priority |
|-------|--------|----------|
| Artisan | Document `code-reviewer` agent availability in Meta_Kim capability index | Low |
| Scout | Close external code-review candidates as "not needed" | Medium |
| Genesis | No new design required | N/A |

---

**EOF**
