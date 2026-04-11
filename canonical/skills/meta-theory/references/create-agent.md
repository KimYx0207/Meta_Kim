# Creation pipeline — full reference

## Pipeline overview

```
┌─ Phase 1: Discovery & split (Mode A only) ─────────────┐
│ Step 0: Data collection ← git history + file distribution │
│ Step 1: Capability dimensions ← domain boundaries from data │
│ Step 2: Coupling groups ← merge high-coupling, split low │
│ Step 2.5: User confirmation ← present plan, get judgment   │
├─ Phase 2: Design on demand ────────────────────────────┤
│ Step 3: Genesis soul   ← required (every agent)         │
│ Step 4: Artisan skills ← required (every agent)         │
│ Step 5: Sentinel safety← on demand (API/DB/Auth)        │
│ Step 6: Librarian memory← on demand (cross-session)     │
│ Step 7: Conductor orchestration← on demand (multi-agent)  │
├─ Phase 3: Review & revision ───────────────────────────┤
│ Step 8: Critical review ← self-critique + rating + slop   │
│ Step 9: Revision       ← fix until pass, max 2 rounds    │
├─ Phase 4: Integrate & verify ──────────────────────────┤
│ Step 10: Integrate & write ← .md files + CLAUDE.md      │
│ Step 11: Final verify  ← five criteria + death patterns │
│ Step 12: User sign-off ← show output; write only after OK│
└────────────────────────────────────────────────────────┘
```

## Two entry modes

### Mode A: Discovery (unclear what agents to build)

- User says “help me design agents” with no explicit list
- Run full Phase 1 data analysis + split

### Mode B: Direct (agents and roles already known)

- User already has a clear agent list and responsibilities
- Skip Phase 1; enter Phase 2 design
- Still run five-criteria and death-pattern checks in Phase 4

---

## Two Entry Modes (dispatch contract)

Use the same **Mode A: Discovery** vs **Mode B: Direct** split as above; this heading exists so dispatchers can grep one block.

## Formal five-phase contract

### Phase 1 — Discovery and Splitting

- **Step 0: Data Collection** — git history + file distribution (commands below).
- **Capability Dimension Enumeration** — name the capability dimensions implied by the repo.
- **Coupling Grouping** — merge high-coupling areas; split low-coupling domains.

### Phase 2 — Pre-Design Decision (Global vs Project-Specific)

Decide **Global vs Project-Specific** need using **3 Hard Criteria**: **Domain Gap**, **Project Uniqueness**, **Frequency**. If a global agent already covers the capability, intercept here.

### Phase 3 — Design On Demand

**Genesis** is **Mandatory**. **Artisan** is **Mandatory**.

**Scout**, **Sentinel**, and **Librarian** are **On Demand** factory stations.
**Conductor** is **orchestration-only** — it may open the task board before the factory starts or consume the resulting card after approval, but it is **not part of the capability-building factory**.

On-demand trigger questions (answer honestly before skipping):

- Is local capability or dependency coverage missing, requiring an external search?
- Will it modify files, call external APIs, or operate databases?
- Must it need to remember what it did last time across sessions?
- Must it hand off results to other Agents or coordinate execution order across agents?

## Execution-Agent Factory Lane

When Type B is triggered by a **capability gap in actual business execution**, use the stricter **execution-agent factory lane** instead of an ad-hoc prompt-writing loop.

Professional role split:

- **Warden** is the **public front door** and approval owner.
- **Conductor** owns orchestration only: it converts the gap into a task board and later dispatches the result.
- **Base-meta factory** owns capability building only: **Genesis + Artisan + Scout + Sentinel + Librarian**.
- **Execution agents are the actual workers**. The factory never performs business execution directly.

Factory lane:

1. **Warden** confirms that an existing owner is insufficient.
2. **Conductor** emits the capability-gap decision and task board.
3. **Genesis** defines the execution-agent identity.
4. **Artisan** defines skill / tool / dependency loadout.
5. **Scout** backfills external capability only when local coverage is missing.
6. **Sentinel** validates safety boundaries.
7. **Librarian** provisions memory / reuse strategy.
8. **Prism** runs the quality gate.
9. **Warden** approves admission into the callable execution roster.

Rule: Conductor may participate before or after the factory, but **Conductor does not build capability**.

## Fixed Artifacts (Execution-Agent Factory Mode)

The execution-agent factory lane must produce these explicit artifacts:

1. **Capability Gap Sheet** (`capabilityGapPacket`) — what is missing, which owners were checked, and what decision was made.
2. **Execution Agent Role Card** (`executionAgentCard`) — the execution agent's contract.
3. **Orchestration Task Board** (`orchestrationTaskBoardPacket`) — ordered execution tasks plus synthesis owner.
4. **Evolution Record** (`evolutionWritebackPacket`) — retain / upgrade / retire outcomes after the run.

## Execution Agent Role Card

Every created or upgraded execution agent must ship with one explicit role card. No free-form shortcut.

Required fields:

- **Purpose** — what it is for
- **Capabilities** — what it can do
- **Non-Capabilities / Boundaries** — what it cannot do
- **Dependencies** — skills, tools, MCPs, external packages, or other capability sources
- **Inputs** — what it accepts
- **Outputs** — what it must deliver

This card is the build contract for the factory and the dispatch contract for Conductor.

### Phase 4 — Review and Revision

Run **meta-prism** review. Map **S/A Pass** (grades S or A count as Pass), treat **B** and **C** as Revise, and use **D redo** when the design is shallow or template-only.

### Phase 5 — Integration and Verification

Integrate files, verify five criteria / death patterns, obtain user sign-off.

---

## Phase 1: Data collection & split

### Step 0: Data collection commands

```bash
# Commit count (project scale)
git log --since="6 months ago" --oneline | wc -l

# Commit type distribution (feat/fix/refactor share)
git log --since="6 months ago" --oneline | awk '{print $2}' | sed 's/:.*//' | sort | uniq -c | sort -rn

# Directory change heatmap (most active areas)
git log --since="6 months ago" --name-only --pretty=format:"" | sed '/^$/d' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -20

# Co-change analysis (dirs that often change together = high coupling)
git log --since="6 months ago" --name-only --pretty=format:"---" | awk 'BEGIN{RS="---"} NF>1 {for(i=1;i<=NF;i++) for(j=i+1;j<=NF;j++) print $i, $j}' | sed 's|/[^/]*$||g' | sort | uniq -c | sort -rn | head -15

# File category counts
echo "=== Components ===" && find src/visual/components -name "*.tsx" 2>/dev/null | wc -l
echo "=== API routes ===" && find app/api -name "route.ts" 2>/dev/null | wc -l
echo "=== Scripts ===" && find scripts -name "*.mjs" 2>/dev/null | wc -l
echo "=== Tests ===" && find tests -name "*.test.*" 2>/dev/null | wc -l
```

### Steps 1–2: Analysis & grouping

From data, infer natural domain boundaries:

- Directories with >5% change share → candidate independent domains
- Frequently co-changing directories → same agent
- Rarely co-changing directories → may split

**Coupling rule**: If A often changes, does B usually change too? Yes → same agent. No → may split.

### Step 2.5: User confirmation

Use whatever prompt/confirm mechanism the runtime supports:

- List each candidate agent: name, responsibility domain, evidence
- Ask whether the grouping matches the user’s mental model
- **Iron rule**: If the user says “these two capability types differ,” split them even if data shows coupling

---

## Phase 2: Design on demand

### Station selection

**Genesis (soul) and Artisan (skills) run for every agent.** **Scout**, **Sentinel**, and **Librarian** are conditional factory stations. **Conductor** remains outside the factory and only owns orchestration.

After Step 3 (Genesis), for each agent answer:

| Question | Yes → station | Rationale |
|----------|---------------|-----------|
| Is local capability coverage missing? | Scout | Search external skills / tools only after baseline proves the gap is real |
| Will it modify files, call external APIs, or touch databases? | Sentinel | Writes = risk surface |
| Must it remember prior work or accumulate learning? | Librarian | Cross-session consistency |
| Must it hand off to other agents or coordinate order? | Conductor | Multi-agent collaboration |

All factory questions No → only Genesis + Artisan. If the Conductor question is Yes, open orchestration design **after** the factory card is complete.

### Step 3: Genesis — soul design (required)

**Read** `.claude/agents/meta-genesis.md` and design SOUL.md per that method.

See references/meta-theory.md, module 8.

### Step 4: Artisan — skill matching (required)

**Read** `.claude/agents/meta-artisan.md`

1. **Scan skills**: `ls .claude/skills/*/SKILL.md` + built-in skills
2. **ROI score**: `ROI = (task coverage × frequency) / (context cost + learning curve)`
3. **Output**: per-agent skill shortlist (top 5–8) with ROI and rationale

### Step 5: Sentinel — safety design (on demand)

**Read** `.claude/agents/meta-sentinel.md`

- **Threat model**: top 5 threats in this agent’s domain
- **Permissions**: three levels (CAN / CANNOT / NEVER)
- **Hooks**: PreToolUse / PostToolUse / Stop
- **Output**: safety rules + hook config + permission boundaries

### Step 6: Librarian — memory design (on demand)

**Read** `.claude/agents/meta-librarian.md`

- **Memory architecture**: three layers (index / topic / archive)
- **Expiry**: per-type retention rules
- **Output**: MEMORY.md template + persistence strategy

### Step 7: Conductor — orchestration design (on demand)

**Read** `.claude/agents/meta-conductor.md`

- **Collaboration flow**: call order among agents, parallel vs serial
- **Triggers**: when to spawn this agent
- **Output**: workflow config + trigger rules

---

## Phase 3: Review & revision

See references/meta-theory.md sections 4–5 (quality rating + AI-slop detection).

### Step 8: Critical review

#### 8a. Self-critique

For each agent’s full design, answer:

1. **What did I assume? Is there evidence?**
2. **If I rename the agent, does the design still hold?**
3. **Any “convenience” shortcuts?**
4. **What was actually thought through vs templated?**

### Step 9: Revision

- **B**: add concrete cases, data citations, file paths
- **C**: rewrite generic paragraphs with project-specific data
- **D**: re-run the relevant station from scratch

Re-enter Step 8 until **A or better**. **Max 2 rounds**

---

## Phase 4: Integrate & verify

### Step 10: Integrate & write

Generate `.claude/agents/{name}.md` with this shape:

```markdown
# {Name}: {Display name} {emoji}

> {One-line role}

## Identity
- **Tier**: execution meta
- **Role**: {role}

## Responsibility boundary
**Owns**: {concrete list}
**Does not touch**: {explicit exclusions, point to owning agent}

## Core Truths
{≥3 core beliefs}

## Decision Rules
{≥3 if/then rules}

## Thinking Framework
{Domain-specific thinking steps}

## Anti-AI-Slop
{Slop signals for this domain}

## Output Quality
{Verifiable quality bar}

## Deliverable Flow
{input → process → output}

## Meta-Skills
{≥2 self-improvement directions}

## Skill loadout
| Skill | ROI | Use |
|-------|-----|-----|
{table}

## Safety rules (if any)
{Permissions + hooks}

## Memory strategy (if any)
{MEMORY.md template}

## Workflow (if any)
{Triggers + collaboration}

## Skipped stations
{List skipped stations + reason}

## Five-criteria verification
| Criterion | Evidence | Pass? |
|-----------|----------|-------|
| Independent | {evidence} | ✅ |
| Small enough | {evidence} | ✅ |
| Clear boundary | {evidence} | ✅ |
| Replaceable | {evidence} | ✅ |
| Reusable | {evidence} | ✅ |
```

Also update `CLAUDE.md` “Claude Code Subagents” section.

### Step 11: Final verification

| Check | Method | If fail |
|-------|--------|---------|
| Five criteria | Table per agent, 5/5 PASS | Back to Step 9 |
| Death patterns | No “everything pot,” no “shattered bits” | Back to Step 2 regroup |
| Eight SOUL modules | All eight present | Back to Step 3 |
| Skip rationale | Every skip explained | If none → run that station |

### Step 12: User sign-off

Present a full summary:

- Each agent’s role + quality grade (S/A/B)
- Skipped stations and why
- Five-criteria tables

**Write files only after explicit user confirmation.**
