# Development governance flow — full specification (Type C)

> Detailed operating spec for Type C (Development Governance Flow).
> The Type C section in `SKILL.md` is the entry summary; this file contains the full procedure.
> For extended long-form narrative (including historical Chinese material), see `docs/meta.md`.
> Read this file when executing Type C — Development Governance Flow.

## 1. AGENT INVOCATION PRINCIPLE (Non-Negotiable)

**Skill is the orchestration layer — never hardcode specific agent names.** At every stage where an agent is needed, follow the Fetch-first pattern:

```
Need an agent for X → Search who declares "Own X" → Call the best match
```

**Invocation decision pattern** (applies to every agent call, every stage):

| Step | Action |
|------|--------|
| 1. Search | `Glob: .claude/agents/*.md` + read global-capabilities.json |
| 2. Match | Score each agent's "Own" boundary against needed capability (3=perfect / 1-2=partial / 0=none) |
| 3. Invoke | 3 → invoke directly / 1-2 → invoke + note gaps / 0 → capability gap detected |

**⚠️ Iron Rule**: Do NOT write `call code-reviewer` or `call meta-prism` as hardcoded steps. Describe the **capability needed**; let the executor discover **who provides it** at runtime via the Search-Match-Invoke pattern.

### Agent Ownership Rule

Every **executable** task must have an explicit **agent owner**.

Only a **pure Q / Query** may bypass agent ownership and be answered directly. A task is **not** a pure query if it does any of the following:
- modifies files / code / configuration
- triggers commands, network calls, or other external side effects
- produces a durable artifact for later handoff, review, or verification
- is expected to feed Evolution writeback into agent / skill / contract assets

Rule of thumb:

```
Pure question → may answer directly
Anything executable / handoff-able → must have an agent owner
```

### Capability Gap Resolution Ladder

When Fetch does not find a clean owner, resolve the gap in this order:

1. **Existing owner found** → dispatch to that owner
2. **Durable / recurring / project-specific gap** → trigger Type B, create or compose the owner first, then dispatch
3. **Emergency or one-off gap** → use a temporary `generalPurpose` owner with explicit justification, then review it again in Evolution

**No-owner execution is illegal.** Even a temporary fallback must be named and tracked as an owner, not treated as anonymous direct execution.

### Protocol-First Rule

Before Stage 4 starts, Thinking must produce explicit protocol artifacts for the run:
- `runHeader`
- `taskClassification`
- `cardPlanPacket`
- `dispatchBoard`
- `workerTaskPackets`
- `resultMergePlan`
- `reviewPacketPlan`
- `verificationPacketPlan`
- `summaryPacketPlan`
- `evolutionWritebackPlan`

If these protocol artifacts do not exist, the run is not ready for Execution.

For `governanceFlow` in `complex_dev` or `meta_analysis`, the machine-validated JSON artifact must also include **`intentPacket`** (`trueUserIntent`, `successCriteria`, `nonGoals`, `intentPacketVersion: v1`) and **`intentGatePacket`** (`ambiguitiesResolved`, `requiresUserChoice`, `defaultAssumptions`, `intentGatePacketVersion: v1`; if `requiresUserChoice` is true, include non-empty `pendingUserChoices[]`) before Execution — see `contracts/workflow-contract.json` (`protocols.intentPacket`, `protocols.intentGatePacket`, `runDiscipline.protocolFirst.intentPacketRequiredWhenGovernanceFlows` / `intentGatePacketRequiredWhenGovernanceFlows`).

---

## 1B. Multi-iteration closure (until gates pass)

When work is not done after one pass (open review findings, `verificationPacket.verified !== true`, or `npm run validate:run` fails), treat the run like a **Ralph-style loop** without inventing new stage names:

1. **Execution / Revision** — address the highest-severity open findings; update code or docs as needed.
2. **Review** — refresh `reviewPacket` and finding `closeState` transitions (`open` → `fixed_pending_verify` as appropriate).
3. **Verification** — refresh `revisionResponses`, `verificationResults`, and `closeFindings` until every finding is `verified_closed` or `accepted_risk`.
4. **Summary** — align `summaryPacket` with `contracts/workflow-contract.json` `runDiscipline.publicDisplayRequires` before setting `publicReady=true`.
5. **Validate** — run `npm run validate:run -- <artifact.json>`; if it fails, run `npm run prompt:next-iteration -- <artifact.json>` and feed the printed checklist back into the orchestrator.

Stop when `validate:run` passes **or** the user explicitly accepts risk with documented `accepted_risk` and honest `publicReady=false`.

**Session recovery (API / compact / tool failure):** The governed artifact is the source of truth. After an interrupted session, reload at minimum: `runHeader`, `taskClassification`, `intentPacket`, `intentGatePacket` (when required), `cardPlanPacket`, `dispatchBoard`, `workerTaskPackets` / `workerResultPackets`, `reviewPacket`, `verificationPacket`, `summaryPacket`, `evolutionWritebackPacket`. Re-run `npm run validate:run -- <artifact.json>` before claiming closure. The same packet list is printed by `npm run prompt:next-iteration -- <artifact.json>` under **Minimal context reload**.

Optional **soft todo gate** (off by default): set `META_KIM_SOFT_PUBLIC_READY_GATES=1` when running `validate:run`. If `summaryPacket.publicReady` is true, no `workerTaskPacket` may have `taskTodoState: "open"`. Omit `taskTodoState` if not tracking todos. See `contracts/workflow-contract.json` → `runDiscipline.runArtifactValidation.softPublicReadyTodoGate`.

Optional **soft comment-review gate**: set `META_KIM_SOFT_COMMENT_REVIEW=1` when running `validate:run`. If `summaryPacket.publicReady` is true, `summaryPacket.commentReviewAcknowledged` must be `true`. See `runDiscipline.runArtifactValidation.softCommentReviewGate`.

Optional Claude **Stop hook** (project default off): `META_KIM_STOP_COMPLETION_GUARD=hint` logs a stderr reminder when the last assistant message claims completion without governance cues; `=block` returns `{"decision":"block",...}` so the model continues. See `.claude/hooks/stop-completion-guard.mjs`.

**Governance doctor:** `npm run doctor:governance` checks contract readability, Claude hook command set, `npm run check:runtimes`, and `validate:run` on the sample fixture — use before release or when mirrors drift.

---

## 2. CORE 8-STAGE EXECUTION SPINE (Detailed)

| Stage | Name | Key Question |
|-------|------|-------------|
| 1 | **Critical** | What is the task? Is it clear? |
| 2 | **Fetch** | Who can do this? |
| 3 | **Thinking** | How should we approach it? |
| 4 | **Execution** | Delegate to agents |
| 5 | **Review** | Is the result correct? |
| 6 | **Meta-Review** | Are the review standards themselves sound? |
| 7 | **Verification** | Did the fixes actually solve the issues? |
| 8 | **Evolution** | What structural learning should carry forward? |

### Hidden Skeleton State Model

The 8-stage spine is the **human-readable orchestration surface**. Underneath it, Meta_Kim may maintain a **hidden state skeleton** so the run stays governable without turning the system into a visible bureaucracy:

| State Layer | Example Values | Primary Owner | Why it exists |
|-------------|----------------|---------------|---------------|
| `stageState` | `Critical -> Fetch -> Thinking -> Execution -> Review -> Meta-Review -> Verification -> Evolution` | Conductor | Canonical stage progression |
| `controlState` | `normal / skip / interrupt / intentional-silence / iteration` | Conductor | Modify stage dealing without inventing new pseudo-stages |
| `gateState` | `planning-open / planning-passed / review-open / verification-open / verification-closed / synthesis-ready` | Warden + Prism | Separate stage completion from gate clearance |
| `surfaceState` | `debug-surface / internal-ready / public-ready` | Warden | Prevent dirty runs from being presented as completed/public |
| `capabilityState` | `covered / partial / gap / escalated` | Scout + Artisan | Keep Fetch results explicit instead of hand-wavy |
| `agentInvocationState` | `idle / discovered / matched / dispatched / returned / escalated` | meta-theory skill | Track whether the skill delegates to agents or attempts work directly — enforce the dispatcher role |

**Rule**: this is an **invisible skeleton only**. The user-facing workflow still speaks in stage language and concrete deliverables. State labels exist to support gates, skips, interrupts, and evolution logging — not to become a second product interface.

### Card Governance Model

Meta_Kim no longer treats **dealing cards** as just a metaphor. In engineering terms:

- **dealer primary owner**: `meta-conductor`
- **dealer escalation owner**: `meta-warden`
- **interrupt signal sources**: `meta-sentinel`, `meta-prism`, `user`, `system`

This is intentionally **not** a new agent. It is a protocol role layered on top of Conductor/Warden so the system gains one explicit decision chain:

1. **Whether to deal**: `cardDecision`
2. **Deal to whom**: `cardAudience`
3. **When to deal**: `cardTiming`
4. **Which delivery shell**: `deliveryShell`

### Card Decision Objects

Every real run may emit card decisions through a `cardPlanPacket`. Each card records:

- `cardId`
- `cardType`
- `cardIntent`
- `cardDecision`
- `cardAudience`
- `cardTiming`
- `cardShell`
- `cardPriority`
- `cardReason`
- `cardSource`
- `cardSuppressed`
- `suppressionReason`
- `deliveryShellId`

Card families:

| Card family | Meaning |
|------------|---------|
| `info` | information / clarification / status |
| `action` | route to execution, review, repair, rollback |
| `risk` | governance or safety intervention |
| `silence` | intentional no-card / defer / quiet-hold |
| `default` | preferred next move or default path |
| `upgrade` | escalation, handoff, or governance raise |

### Silence / No-Card Rule

Silence is a first-class decision, not a missing action.

Default principle:

```text
If there is no clear evidence that interruption is better,
prefer no-card / defer / intentional silence.
```

Run artifacts must therefore model:
- `noInterventionPreferred`
- `silenceDecision`
- `interruptionJustified`
- `deferUntil`
- `reasonForSilence`

### Skip / Interrupt / Override Rule

Meta_Kim distinguishes:

- **skip**: current step is intentionally not dealt because it is already known / already in context / not applicable
- **interrupt**: a risk or urgent governance signal temporarily inserts a card ahead of the default queue
- **override**: governance rules change the default path (for example, public display blocked until verification closes)
- **escalation_insert**: Warden / Sentinel / Prism inserts a governance owner into the chain

Every such move must emit a `controlDecision` with:
- `decisionType`
- `skipReason`
- `interruptReason`
- `overrideReason`
- `insertedGovernanceOwner`
- `emergencyGovernanceTriggered`
- `returnsToStage`
- `rejoinCondition`

---

## STAGE 1: Critical Analysis (Detailed)

### Task Classification Routing

Meta_Kim now uses a **two-layer classifier** so trigger decisions are reviewable instead of intuitive:

| Layer | Field | Allowed values | Purpose |
|-------|-------|----------------|---------|
| Intent layer | `taskClass` | `Q / A / P / S` | Preserve the canonical query / action / planning / strategic split |
| Runtime layer | `requestClass` | `query / execute / plan / strategy` | Explain what kind of ask the runtime saw |
| Governance layer | `governanceFlow` | `query / simple_exec / complex_dev / meta_analysis / proposal_review / rhythm` | Decide which execution path and gate set must run |

**Classification output fields**:
- `taskClass`
- `requestClass`
- `governanceFlow`
- `triggerReasons[]`
- `upgradeReasons[]`
- `bypassReasons[]`
- `ownerRequired`
- `decisionSource`
- `classifierVersion`

### Canonical Mapping

| `taskClass` | `requestClass` | Default `governanceFlow` | Default handling |
|-------------|----------------|--------------------------|------------------|
| `Q` | `query` | `query` | Direct answer only when pure-query conditions all hold |
| `A` | `execute` | `simple_exec` or `complex_dev` | Requires explicit owner; classify complexity before execution |
| `P` | `plan` | `complex_dev` or `proposal_review` | Plan first, then produce owner-routable packets |
| `S` | `strategy` | `meta_analysis` or `rhythm` | Warden / Conductor-led governance path |

### Trigger / Upgrade / Bypass Reasons

Record concrete reasons, not vibes:

- `triggerReasons`: `multi_file`, `cross_module`, `external_side_effect`, `durable_artifact`, `owner_missing`, `cross_runtime_sync`, `security_sensitive`, `verification_required`, `writeback_candidate`, `user_explicit_review`
- `upgradeReasons`: `cross_system_scope`, `review_or_verify_required`, `owner_creation_required`, `parallel_merge_required`, `business_workflow_upgrade`, `security_gate_required`
- `bypassReasons`: `pure_query`, `read_only_explanation`, `existing_verified_artifact_reuse`

### No-Agent Exception (strict)

The only valid no-agent path is:

```text
taskClass = Q
AND requestClass = query
AND governanceFlow = query
AND no file/code/config change
AND no external side effect
AND no durable artifact/handoff packet required
```

If any one of those conditions fails, the task must be treated as `A`, `P`, or `S`, and therefore must have an agent owner.

### Skip-Level Self-Reflection Gate

> Core question: **Should I be doing this, or should I dispatch it?**

Self-check list:
- [ ] Is the current role an "Execution Layer"? (Yes → Skip-Level suspicion, should dispatch to the corresponding execution agent)
- [ ] Does the task involve writing code / modifying files? (Yes → must delegate to Execution Layer; meta-theory does not execute directly)
- [ ] Am I "conveniently" making decisions for the Execution Layer? (Yes → only provide constraints; let the Execution Layer judge implementation details autonomously)
- [ ] Did the previous round also do a similar task? (Yes → check if a Skip-Level pattern is forming, record Scars)

Skip-Level determination:
```
IF self-check has ≥1 hit AND taskClass = A
  → Mark as "should-dispatch task"
  → Assemble task package (context + constraints + deliverables)
  → Hand to Conductor for orchestration → dispatch to Execution Layer
  → Record Scars (if Skip-Level indeed occurred)
```

### Escalation Signals (pre-emptive)

> Unlike Skip-Level detection (which catches violations after the fact), Escalation Signals let the **dispatched agent itself** recognize it cannot handle the task — before wasting effort.

When dispatching to an agent, include this instruction in the task package:

```
If you detect any of these signals, STOP and report back immediately:
- Task exceeds your declared "Own" boundary
- Multiple failed attempts (>2) on the same sub-problem
- Cross-system dependencies you cannot trace from your context
- Security-sensitive changes requiring specialized review
- Irreversible operations (database migrations, production deploys)
```

Agent escalation response format:
```json
{
  "escalation": true,
  "reason": "why this exceeds my capability",
  "suggestedCapability": "what kind of agent/skill is needed instead",
  "workCompletedSoFar": "what I did manage to do before hitting the wall"
}
```

On receiving an escalation signal: re-enter Fetch (Stage 2) to find a more capable agent.

### Clarity Gate

| State | Condition | Action |
|-------|-----------|--------|
| **Confirmed** | User specified file paths OR ≥2 deliverables OR said "just do this" | → Stage 2 |
| **Probed** | Needs scope or priority clarification | → Follow-up Probe (max 2 rounds) |
| **Assumed** | Still vague after 2 rounds | Record assumptions, mark `clarity: "assumed"`, → Stage 2 |

**Follow-up Probe Strategy**:
- Round 1: Ask about **scope** — "Which scenarios need support? Which can be deferred?"
- Round 2: Ask about **priorities** — "If time is tight, which parts can be cut?"
- Early Exit: Round 1 already specifies file paths OR ≥2 deliverables → skip Round 2

### Complexity Routing

| File Changes | Complexity | Executed Path | Upgrade to 10-Step? |
|-------------|-----------|---------------|-------------------|
| 1 file, pure logic/style/comments | Simple | Execution → Review → Verification → Evolution (4 stages, still owner-driven) | No — 8-stage is the minimum; even these 4 stages suffice |
| 2-5 files, 1 module | Medium | Full 8-stage spine | No — 8-stage is the complete executable chain for medium complexity |
| >5 files OR cross-system OR multi-team | Complex | Full 8-stage spine, with escalation gates | **Yes** — upgrade to full 10-step governance when: (a) >5 files, (b) cross-system dependencies detected, (c) multi-team handoff required, (d) security-sensitive changes, or (e) business-workflow revision/summary/feedback phases are needed per the run contract |

**Upgrade Trigger Conditions** (any one is sufficient):
- File scope > 5 files
- Cross-system dependency detected (Stage 3 Thinking identifies shared components across module boundaries)
- Multi-team handoff required (business department + meta department coordination)
- Security-sensitive or permission-critical changes
- Business run contract explicitly requires 10-step phases (direction/planning/execution/review/meta-review/revision/verification/summary/feedback/evolution)

**Note**: The 8-stage spine is the **minimum executable chain** regardless of complexity. The 10-step governance is an **upgrade layer** for complex scenarios — the 8 stages still run, but extended with direction refinement, summary, and feedback phases before Evolution.

### Critical Stage Output

```json
{
  "taskClass": "A",
  "requestClass": "execute",
  "governanceFlow": "complex_dev",
  "triggerReasons": ["multi_file", "durable_artifact"],
  "upgradeReasons": ["review_or_verify_required"],
  "bypassReasons": [],
  "requiresAgentOwner": true,
  "ownerRequired": true,
  "ownerPolicy": "existing-owner | create-owner-first | temporary-fallback-owner",
  "decisionSource": "classifier-v2",
  "classifierVersion": "v2",
  "skipLevel": "should-dispatch",
  "complexity": "medium",
  "clarity": "confirmed",
  "understanding": "one-sentence description of the task as understood",
  "scope": {
    "mustHave": ["item1", "item2"],
    "deferLater": ["item3"]
  }
}
```

---

## STAGE 2: Fetch — Discover Available Agents (Detailed)

**Purpose**: Search for agents / skills whose "Own" boundary matches the capability needed.

**⚠️ Execute all 5 steps in order — no skipping.**

**Step 1 — Local agent scan**:
```
Glob: .claude/agents/*.md
Read each file, verify it has `name:` YAML frontmatter (valid = registered agent)
Extract each agent's "Own / Do Not Touch" boundaries
Score match: does "Own" cover the needed capability?
```

**Step 0.5 — Project Graph Context** (auto-detection, runs before Step 1):
```
CHECK: Does graphify-out/graph.json exist in the target project root?
  IF YES →
    - Verify freshness: compare graph.json mtime against git log last commit
    - If stale → run `graphify --update` (incremental, SHA256 cache)
    - Load graph metadata: node count, edge count, confidence distribution
    - Quality gate: if AMBIGUOUS nodes > 30% OR total nodes < 10 → mark as low-quality, agents use direct Read as primary
    - Record graphContext in Fetch output for downstream stages
  IF NO →
    - Check auto-generation conditions (all must be true):
        a) Source files > 20 (excluding node_modules/ .git/ dist/)
        b) Python 3.10+ available (python --version)
        c) graphify installed (graphify --version)
        d) Current project is NOT Meta_Kim itself
    - If all conditions met → run `graphify` and wait for completion
    - If conditions not met → proceed without graph, no error
```

**Step 2 — Capability index search** (if no perfect local match):
```
IF .claude/capability-index/global-capabilities.json is missing OR stale for the current machine
  → run npm run discover:global first

IF discover:global lists few skills/agents but the task needs Meta_Kim third-party skills (install-deps list)
  AND ~/.codex/skills or ~/.openclaw/skills are empty on this machine
  → operator should run npm run deps:install:all-runtimes (or npm run deps:install for Claude-only), then npm run discover:global again

Read .claude/capability-index/global-capabilities.json
Search for agents declaring the needed capability
Score match
```

**Step 3 — External skill discovery** (if the local + indexed baseline still has no perfect match):
```
Invoke the **findskill** skill
Search the Skills.sh ecosystem for the missing capability
Record what was searched and what was found
```

**Step 4 — Specialist ecosystem fallback** (if the external search still finds no clean winner):
```
Search known specialist ecosystems already integrated by Meta_Kim:
- everything-claude-code agents
- gstack specialist skills
- other globally installed runtime-native agents / skills from the capability index
```

**Step 5 — Owner resolution branch** (if no match found):
```
Mark capabilityGap: "no agent declares Own [capability]"
IF gap is durable / recurring / project-specific
  → trigger Type B creation pipeline before execution
ELSE
  → invoke Agent(subagent_type="generalPurpose") as a TEMPORARY owner
  → record justification + require Evolution follow-up
```

### Match Scoring

| Score | Meaning | Action |
|-------|---------|--------|
| 3 | Perfect match — "Own" covers exactly what is needed | Invoke directly |
| 2 | Partial match — covers most, some gaps | Invoke + note gaps |
| 1 | Weak match — tangentially related | Invoke + note significant gaps |
| 0 | No match | Capability gap detected → Step 5 owner-resolution branch |

### Owner Resolution Rules

| Situation | Resolution |
|----------|------------|
| Existing owner covers the work | Dispatch to that owner |
| No owner, but gap is recurring / strategic / project-specific | Create or compose the owner first (Type B) |
| No owner, gap is one-off and low-risk | Use a temporary `generalPurpose` owner and mark it for Evolution review |

Temporary fallback is a **transition state**, not a mature architecture state.

### Tier-Aware Routing

> Not all tasks need Opus-level agents. Match task complexity to agent weight to optimize context consumption and speed.

After scoring candidates, apply tier preference:

| Task Complexity | Preferred Tier | Rationale |
|----------------|---------------|-----------|
| Simple (1 file, pure logic) | Lightweight agent (e.g., `model: "haiku"`) | Fast, cheap, sufficient |
| Medium (2-5 files) | Standard agent (default model) | Balanced |
| Complex (>5 files, cross-layer) | Full-weight agent (e.g., `model: "opus"`) | Deep reasoning needed |

Tier selection rule:
```
IF complexity = "simple" AND candidate has lightweight variant
  → Prefer the lightweight variant (saves context, faster)
ELSE
  → Use the default agent as matched
```

This is a **preference**, not a hard rule — if the lightweight agent escalates (see Escalation Signals), re-dispatch to the full-weight version.

### Fetch Stage Output

```json
{
  "capabilityNeeded": "code quality review",
  "graphContext": {
    "available": false,
    "suggestedForProjectsWithMoreThan": 20,
    "path": null,
    "nodeCount": null,
    "edgeCount": null,
    "confidenceDistribution": null,
    "quality": null
  },
  "searchTrail": [
    "local-agents",
    "global-capability-index",
    "findskill",
    "specialist-ecosystem"
  ],
  "candidates": [
    { "name": "code-reviewer", "source": "global", "score": 3, "matchReason": "Own covers code quality review" }
  ],
  "selected": { "name": "code-reviewer", "score": 3 },
  "capabilityGap": null,
  "ownerMode": "existing-owner",
  "createOwnerRecommended": false,
  "temporaryOwnerJustification": null,
  "fallbackUsed": false
}
```

---

## STAGE 3: Thinking — Plan the Approach (Detailed)

**Purpose**: Explore solution paths, identify risks, decompose into sub-tasks. This stage bridges Fetch and Execution.

### Step 1: Option Exploration
Analyze at least 2 possible solution paths:

| Path | Approach | Pros | Cons |
|------|----------|------|------|
| A | [approach description] | [reasons] | [reasons] |
| B | [alternative approach] | [reasons] | [reasons] |

### Step 2: Risk Identification

| Signal | Type | Mitigation |
|--------|------|------------|
| Shared component modification | Risk Card | Notify user before proceeding |
| Auth/permission logic involved | Risk Card | Surface immediately |
| >3 files affected | Cross-contamination risk | Mark for Review |
| No matching agent found | Capability gap | Record + suggest Type B |

### Step 3: Task Decomposition

Break Stage 1's task into independent sub-tasks:

```json
{
  "subTasks": [
    {
      "id": 1,
      "description": "what specifically to do",
      "owner": "agent name from Stage 2",
      "ownerMode": "existing-owner | create-owner-first | temporary-fallback-owner",
      "parallel": true,
      "parallelGroup": "group-a",
      "dependsOn": [],
      "mergeOwner": "agent responsible for consolidation",
      "taskPacketId": "task-001",
      "fileScope": ["file-or-module-a", "file-or-module-b"],
      "constraints": ["boundary1", "dependency1"]
    }
  ]
}
```

### Step 3.5: Protocol-First Dispatch Artifacts

Thinking must lock down the execution protocol before any `Agent` tool invocation begins:

```json
{
  "taskClassification": {
    "taskClass": "A",
    "requestClass": "execute",
    "governanceFlow": "complex_dev",
    "triggerReasons": ["multi_file", "durable_artifact"],
    "upgradeReasons": ["review_or_verify_required"],
    "bypassReasons": [],
    "ownerRequired": true,
    "decisionSource": "classifier-v2",
    "classifierVersion": "v2"
  },
  "runHeader": {
    "department": "team or department",
    "primaryDeliverable": "single deliverable name",
    "audience": "who the result is for",
    "freshnessRequirement": "freshness rule",
    "visualPolicy": "visual strategy",
    "handoffPlan": "how the chain closes"
  },
  "cardPlanPacket": {
    "dealerOwner": "meta-conductor",
    "dealerMode": "conductor-primary-warden-escalation",
    "cards": [
      {
        "cardId": "card-001",
        "cardType": "action",
        "cardIntent": "execute",
        "cardDecision": "deal",
        "cardAudience": "owner",
        "cardTiming": "next_stage",
        "cardShell": "agent_dispatch",
        "cardPriority": 8,
        "cardReason": "work is ready for owner execution",
        "cardSource": "meta-conductor",
        "cardSuppressed": false,
        "suppressionReason": "",
        "deliveryShellId": "shell-tech-detail"
      }
    ],
    "deliveryShells": [
      {
        "deliveryShellId": "shell-tech-detail",
        "shellType": "technical_detail",
        "presentationMode": "direct",
        "exposureLevel": "internal",
        "interventionForm": "agent_dispatch",
        "audience": "developer-owner",
        "contentBoundary": "implementation packet only"
      }
    ],
    "silenceDecision": {
      "silenceDecision": "defer",
      "noInterventionPreferred": true,
      "interruptionJustified": false,
      "deferUntil": "verification-complete",
      "reasonForSilence": "no additional push is better while verification is pending"
    },
    "controlDecisions": [
      {
        "decisionId": "ctl-001",
        "decisionType": "interrupt",
        "skipReason": "",
        "interruptReason": "security_risk",
        "overrideReason": "",
        "insertedGovernanceOwner": "meta-sentinel",
        "emergencyGovernanceTriggered": true,
        "returnsToStage": "verification",
        "rejoinCondition": "critical risk reviewed"
      }
    ],
    "defaultShellId": "shell-tech-detail"
  },
  "dispatchBoard": {
    "boardId": "dispatch-001",
    "goal": "one sentence goal",
    "ownerResolution": "existing-owner | create-owner-first | temporary-fallback-owner"
  },
  "workerTaskPackets": [
    {
      "packetId": "task-001",
      "owner": "agent name",
      "ownerMode": "existing-owner",
      "dependsOn": [],
      "parallelGroup": "group-a",
      "mergeOwner": "agent name",
      "deliverableLink": "how this packet connects back to the primary deliverable"
    }
  ],
  "resultMergePlan": {
    "mergeOwner": "agent responsible for consolidation",
    "consolidationArtifact": "single deliverable artifact"
  }
}
```

Independent work that can be parallelized must be marked with the same `parallelGroup`. Any task that has no declared `owner`, `dependsOn`, and `mergeOwner` is not ready for Execution.

### Step 4: `cardDeck` (stage-card rhythm) + delivery plan

Thinking must translate the plan into a **`cardDeck`** — the canonical Stage 3 artifact for stage-card rhythm (sequencing / lanes — not legacy “Planning / Guidance / Direction” card names). Each entry is one **stage-card intent** (priority, lane, skip/interrupt hooks). Conductor owns concrete dealing on the dispatch board; Thinking outputs `cardDeck` constraints and decomposition only.

```json
{
  "cardDeck": [
    {
      "stage": "Thinking",
      "priority": 8,
      "laneIntent": "decompose-and-surface-risks",
      "skipCondition": "task is simple and already decomposed",
      "interruptTrigger": "security-risk or scope-drift"
    }
  ],
  "deliveryShellPlan": [
    {
      "audience": "user",
      "channel": "conversation",
      "shell": "structured-status"
    }
  ],
  "interruptChannels": [
    { "source": "sentinel", "severity": "critical", "action": "pause and front-load interrupt" },
    { "source": "prism", "severity": "high", "action": "insert before next execution stage" }
  ]
}
```

### Step 5: Decision Record

```json
{
  "selected": "A",
  "reason": "why this path was chosen over alternatives",
  "rejectedOptions": [{ "path": "B", "reason": "why not chosen" }],
  "risks": [{ "type": "shared-component", "mitigation": "notify user" }]
}
```

### Thinking Stage Output Contract

```json
{
  "subTasks": [],
  "taskClassification": {},
  "runHeader": {},
  "cardPlanPacket": {},
  "dispatchBoard": {},
  "workerTaskPackets": [],
  "resultMergePlan": {},
  "cardDeck": [],
  "deliveryShellPlan": [],
  "interruptChannels": [],
  "reviewPlan": ["code-quality", "security"],
  "reviewPacketPlan": ["owner-coverage", "protocol-compliance", "quality-findings", "finding-closure-model"],
  "metaReviewGate": "complexity=complex OR abnormal review confidence",
  "verificationGate": "all failed assertions must be re-run with fresh evidence",
  "verificationPacketPlan": ["fixEvidence", "revisionResponses", "verificationResults", "closeFindings", "regressionGuard"],
  "summaryPacketPlan": ["verifyPassed", "summaryClosed", "deliverableChainClosed", "publicReady"],
  "evolutionWritebackPlan": ["writebackDecision", "agent-boundary", "skill", "contract", "scar"],
  "evolutionFocus": ["pattern reuse", "boundary drift", "process bottlenecks"]
}
```

---

## STAGE 4: Execution — Delegate to Agents (Detailed)

**⚠️ Core Rule: meta-theory does NOT write code directly.**

### Step 1: Invoke selected agents from Stage 2

For each sub-task from Stage 3, invoke the matched agent:
```
Agent(
  subagent_type="<selected agent from Stage 2>",
  prompt="""
  Packet: [workerTaskPacket JSON]
  Task: [sub-task description]
  Constraints: [boundaries from Stage 3]
  Deliverable: [expected output format]
  Graph context: [IF graphContext.available, include compressed subgraph relevant to this task's fileScope — node topology, dependency edges, confidence notes for AMBIGUOUS nodes. Graph context tells WHERE things are; for HOW they work, always Read the actual source files.]
  """
)
```

### Step 2: Parallel/Sequential Decision
- No dependency edges + non-overlapping file scopes → **must run in parallel**
- Shared files, explicit dependency edges, or shared consolidation step → **sequential**
- Every parallel lane must declare a `parallelGroup`
- Every parallel group must declare one `mergeOwner`

### Step 2.5: Execute in stage order

Execution must respect the Stage 3 **`cardDeck`** (stage-card sequence / control interrupts — delegated to Conductor for actual dealing):
- Run stages in agreed order unless a control interrupt (silence / skip / risk) is active
- Insert intentional silence when the overload rule is hit
- Use the selected Delivery Shell when reporting progress or handing off results

### Step 3: Result Aggregation
- Which files were modified
- Any conflicts to resolve
- Any sub-task failures → handle via fault protocol
- Every result returns through a `WorkerResultPacket`, not free-form orphan output

---

## STAGE 5: Review — Validate the Result (Detailed)

**Trigger**: Stage 4 produced code changes or any durable execution artifact. If Stage 4 produced neither, skip to Stage 6.

**⚠️ The executor does not self-review. Follow the Agent Invocation Principle.**

### Step 1: Skip-Level Retrospective

Check: Did anyone (including myself) do work that should have been dispatched?
- [ ] Who wrote this round's code? (If meta-theory used Edit/Write directly → Skip-Level)
- [ ] Were required agents skipped?
- [ ] Was Stage 1's skip-level result respected?

Skip-Level handling:
```
IF Skip-Level detected → Record Scar → Assess impact → IF impact occurred → re-verify with agent
```

### Step 1.5: Owner Coverage + Protocol Compliance Review

Before content quality review begins, check the execution contract itself:
- [ ] Did every executable sub-task have an explicit owner?
- [ ] If temporary fallback owner was used, is the justification explicit?
- [ ] Do all `WorkerResultPackets` map back to the `dispatchBoard` and primary deliverable?
- [ ] Is there a declared `mergeOwner` for every parallel group?
- [ ] Did the run maintain one consolidated deliverable rather than drifting into detached outputs?

If any answer is no, the Review packet must record **protocol non-compliance** even if the implementation quality looks good.

### Step 2: Quality Review (dynamic, Fetch-first)

Following the **Agent Invocation Principle** (Search → Match → Invoke):
```
→ Search: who declares "Own: code quality review"?
→ Match: score candidates
→ Invoke: selected agent
```

When invoking a code quality agent, specify these check dimensions:
- **Type safety**: any / implicit any / type assertions
- **Error handling**: try/catch coverage and fallback strategy
- **Permission boundaries**: which external APIs / file systems / network requests were called
- **Code reuse**: duplicate logic, DRY detection

### Step 3: Security Scan (dynamic, Fetch-first)

```
→ Search: who declares "Own: security analysis"?
→ Match: score candidates
→ Invoke: selected agent
```

When invoking a security agent, specify these check dimensions:
- **Hardcoded secrets**: API key / token / password
- **Unvalidated input**: parameter validation
- **Injection risks**: SQL injection / XSS

### Step 4: UX Review (for UI-related changes)

If files involve UI/components:
- Accessibility (keyboard navigation focus-visible, aria-label, aria-live)
- Loading states (skeleton screens vs pure spinners)
- Responsiveness (mobile breakpoints)

### Step 5: AI-Slop Detection (optional — for agent/system definitions)

```
→ Search: who declares "Own: quality forensics, AI-Slop detection"?
→ Invoke if found
```

### Review Stage Output

```json
{
  "skipLevelDetected": false,
  "skipLevelScar": null,
  "ownerCoverage": "PASS",
  "protocolCompliance": "PASS",
  "temporaryOwnerFollowUp": [],
  "reviews": [
    { "type": "code-quality", "agent": "code-reviewer", "result": "PASS", "issues": [] },
    { "type": "security", "agent": "security-reviewer", "result": "FAIL", "issues": ["hardcoded API key in config.ts"] }
  ],
  "findings": [
    {
      "findingId": "rev-001",
      "severity": "high",
      "owner": "security-reviewer",
      "summary": "hardcoded API key in config.ts",
      "requiredAction": "remove secret and load from secure runtime config",
      "fixArtifact": "src/config.ts",
      "verifiedBy": "meta-prism",
      "closeState": "open"
    }
  ],
  "qualityGate": "FAIL",
  "revisionNeeded": true,
  "revisionRound": 1
}
```

Every non-pass issue must become a **review finding object**. Free-form issue lists are insufficient once revision and verification start.

**Quality Gate rules — Auto-Fix Loop**:

```
Round 1: Review agent reports issues
  → Auto-dispatch fix to the original execution agent (with issue list as constraints)
  → Re-run Review on the fixed output
Round 2: If still FAIL → auto-fix again with accumulated context
  → Re-run Review
Round 3: If still FAIL → STOP, notify user for manual decision
  → Include: all 3 rounds of issues, what was tried, what remains unfixed
```

Key difference from simple "max 2 rounds": the fix is **automatic** — the Review agent dispatches the fix back to the execution agent without waiting for user input. Only escalate to user after 3 failed auto-fix attempts.

---

## STAGE 6: Meta-Review — Review the Review Standards (Detailed)

**Trigger**: Complex tasks, abnormal pass rates, or when the user explicitly asks for stricter governance.

Meta-Review does **not** re-review the implementation itself. It reviews whether Stage 5's review criteria were strong enough:

| Check Dimension | Question | Fail Action |
|----------------|----------|-------------|
| Assertion coverage | Did the review cover all critical dimensions? | Add missing assertions and re-run review |
| Assertion strength | Could a clearly wrong result still pass? | Tighten weak assertions and re-run review |
| Criteria consistency | Did standards drift materially from comparable past runs? | Record drift and request Warden arbitration |

**Trigger heuristics**:
- Review pass rate > 0.9 but output still looks suspect
- Review pass rate < 0.3 but output looks materially sound
- Security-sensitive or cross-layer changes

---

## STAGE 7: Verification — Confirm the Fixes (Detailed)

**Trigger**: Stage 5 or Stage 6 produced revision work.

Verification is an independent re-check using fresh evidence, not a trust-based acknowledgment:

| Check | Method |
|------|--------|
| Issue closure | Re-run the assertion that originally failed |
| Regression guard | Confirm the fix did not break an adjacent path |
| Fresh evidence | Cite current files / outputs / logs, not memory of what changed |

**Verification output**:
```json
{
  "verified": true,
  "remainingIssues": [],
  "evidence": ["current file or runtime evidence"],
  "fixEvidence": ["commit diff, file path, or test output showing the fix landed"],
  "revisionResponses": [
    {
      "findingId": "rev-001",
      "actionId": "fix-001",
      "owner": "execution-owner",
      "responseType": "code-change",
      "status": "applied",
      "fixArtifact": "src/config.ts",
      "responseSummary": "removed hardcoded key and switched to env lookup"
    }
  ],
  "verificationResults": [
    {
      "findingId": "rev-001",
      "verifiedBy": "meta-prism",
      "result": "pass",
      "evidence": ["src/config.ts now reads process.env.API_KEY"],
      "closeState": "verified_closed"
    }
  ],
  "closeFindings": ["rev-001"]
}
```

If verification fails, route back to Execution with the accumulated issue list.

**Closure rule**:
- `review finding -> revision response -> verification result -> closeFindings`
- Missing any link means the finding stays open
- `closeFindings` may only contain finding ids that have a matching verification result with fresh evidence

### Rollback Protocol

When verification reveals that fixes caused more damage than they solved, or when risk exceeds the original task scope, invoke the rollback protocol:

| Rollback Level | Trigger | Action |
|---------------|---------|--------|
| **File-level** | Single file regression detected | Restore the specific file from last known good state (`git checkout HEAD~1 -- <file>`) |
| **Sub-task level** | One sub-task's changes broke adjacent paths | Revert only that sub-task's file set; re-run Review on remaining changes |
| **Full rollback** | Cross-contamination across >3 files; original task assumptions invalidated | `git stash` all uncommitted changes; return to Stage 1 Critical with a revised scope |
| **Partial rollback** | Some sub-tasks succeeded, others failed | Keep successful sub-tasks; rollback failed ones; re-enter Stage 3 Thinking to re-decompose the failed portion |

**Rollback Decision Flow**:
```
Verification FAIL
  → Count affected files
  → IF 1 file: File-level rollback → Re-run Stage 4 for that file only
  → IF 2-3 files in same sub-task: Sub-task level rollback
  → IF >3 files OR cross-module: Notify user → Full or Partial rollback (user decides)
```

**Iron Rule**: Rollback is not failure. Rollback is the system demonstrating it knows when to stop making things worse. A system without rollback capability is a system that can only move forward into disaster.

### Summary / Public Display Packet

The 8-stage spine has no separate “summary stage”, but business runs still need a structured closure object before anything becomes display-ready.

```json
{
  "verifyPassed": true,
  "summaryClosed": true,
  "singleDeliverableMaintained": true,
  "deliverableChainClosed": true,
  "consolidatedDeliverablePresent": true,
  "publicReady": true,
  "deliveryShellsUsed": ["shell-tech-detail"],
  "blockedBy": []
}
```

Rules:
- `publicReady = true` only when all public-display conditions are true
- if any gate is false, `blockedBy` must explain why
- summary closure is the public shell of the verified run, not a replacement for verification

---

## STAGE 8: Evolution — Extract Learnings (Detailed)

Use the **5+1 evolution model** after every task: the canonical 5 structural dimensions, plus Scars codification as an always-on overlay.

| Dimension | What to Detect | Amplification Action |
|-----------|---------------|---------------------|
| Pattern reuse | Can this solution become a reusable pattern? | Extract as new skill/agent |
| Agent boundaries | Do boundaries need adjustment? | Trigger split/merge |
| Rhythm optimization | Can interaction path be shorter? | Tighten stage or control-card trigger conditions (Conductor-owned dealing) |
| Process bottlenecks | Which step is slowest/error-prone? | Adjust orchestration |
| Capability coverage | Any new gaps discovered? | Trigger Scout or Type B |
| **Scars codification** | Skip-Level/Boundary Violation/Process Gap? | Record structured Scar → prevention rule |

### Amplification Operations

| Dimension | Detection | Action |
|-----------|-----------|--------|
| Pattern reuse | Reusable pattern found | → Extract as skill/template → register |
| Agent boundaries | Boundaries unreasonable | → Trigger split/merge |
| Rhythm optimization | Interaction path redundant | → Update stage/control triggers (via Conductor) |
| Process bottlenecks | Bottleneck found | → Adjust stage-card priority / sequencing (Conductor) |
| Capability coverage | Gap discovered | → Scout or Type B |
| Scars | Issue detected | → Record Scar → update Critical checklist |

### Owner Writeback Rule

Every completed run must ask:

1. Did an existing owner prove sufficient?
2. Did a temporary fallback owner reveal a recurring capability gap?
3. Should an agent boundary, SOUL, skill loadout, or workflow contract be updated?

If the run used a temporary owner more than once for the same capability family, Evolution should default to **Type B or owner-boundary adjustment**, not repeated temporary fallback.

### Scars Structured Recording

```yaml
scar:
  id: "{date}-{type}-{short-desc}"
  type: overstep | boundary-violation | process-gap | false-positive
  triggered_by: "{context}"
  what_happened: "one sentence"
  root_cause: "why (not surface reason)"
  impact: none | degraded | recovered | critical
  prevention_rule: "specific rule for next time"
```

### Evolution Writeback Packet

```json
{
  "ownerAssessment": "keep-existing | adjust-boundary | create-owner | retire-temporary-fallback",
  "writebackDecision": "writeback | none",
  "decisionReason": "why a writeback is required, or why none is acceptable for this run",
  "writebacks": [
    { "target": ".claude/agents/<agent>.md", "reason": "boundary drift" },
    { "target": ".claude/skills/<skill>/SKILL.md", "reason": "reusable execution pattern" },
    { "target": "contracts/workflow-contract.json", "reason": "protocol or gate refinement" }
  ],
  "scarIds": ["2026-04-02-overstep-example"],
  "syncRequired": true
}
```

**Rule**: Evolution may not silently disappear. Every run must emit either:
- `writebackDecision = "writeback"` with concrete targets, or
- `writebackDecision = "none"` with a concrete `decisionReason`

### Evolution Artifacts Storage

Evolution outputs must be persisted to specific locations — not left floating in conversation context:

| Artifact Type | Storage Location | Lifecycle |
|--------------|-----------------|-----------|
| **Reusable Patterns** | `memory/patterns/{pattern-name}.md` | Permanent; reviewed quarterly by Librarian |
| **Scars** | `memory/scars/{scar-id}.yaml` | Permanent; prevention rules feed back into Critical stage checklists |
| **New Skills** (extracted) | `.claude/skills/{skill-name}/SKILL.md` | Permanent; created via skill-creator, validated via Type D Review |
| **Agent Boundary Adjustments** | `.claude/agents/{agent}.md` (direct edit) | Immediate; triggers `npm run sync:runtimes` |
| **Rhythm Optimizations** | Recorded in `contracts/workflow-contract.json` or Conductor's card-deck defaults | Immediate; affects next run's dispatch board |
| **Capability Gap Records** | `memory/capability-gaps.md` | Until resolved; Scout monitors and closes when filled |

**Storage Rule**: If an evolution artifact has no defined storage location, it does not count as "captured". The 5+1 model's amplification actions are only complete when the artifact is written to disk and indexed.

### Public Display Discipline

External-ready output is a **gate state**, not a storytelling choice. Before any run is treated as publicly complete, all of these must hold:

- `verifyPassed`
- `summaryClosed`
- `singleDeliverableMaintained`
- `deliverableChainClosed`
- `consolidatedDeliverablePresent`

If any one of these is false, the run may produce internal notes, but it must not be framed as the final public deliverable.

---

## STAGE SPINE VS CONTROL CARDS

**8-stage spine** (always the backbone): Critical → Fetch → Thinking → Execution → Review → Meta-Review → Verification → Evolution. Business workflow **phase names** in `contracts/workflow-contract.json` (e.g. `direction`, `planning`, `execution`) are a separate vocabulary for department runs — do not relabel spine stages as “Guidance / Direction / Planning cards.”

**Control / overlay cards** (rhythm and safety — Conductor deals; not a second spine):

| Card | Trigger Condition | Action |
|------|-------------------|--------|
| Scope Contraction | Repository too large / duplicate filenames / branching history | Ask which target to change, then proceed |
| Risk | Shared components / auth / global interfaces / hot multi-editor areas | Surface; may trigger interrupt path |
| Suggestion | User hesitates; interruption costly | Low-cost forward plan or intentional silence |
| Silence | ≥3 consecutive high-density push rounds | Pause for digestion |
| Skip | Attention cost > benefit | Simplify or defer |
| Interrupt | Emergency or Sentinel-critical | Prioritize and reorder |
| Iteration | Acceptance not closed within agreed rounds | Loop with explicit gate; max 3 iterations, then escalate to Warden |
| **Rollback** | Risk exceeded original scope OR impact scope expanded beyond acceptance | Revert to last stable state; re-enter Stage 3 Thinking to re-decompose |

**Card naming note**: English names are canonical in this repository. `docs/meta.md` uses Chinese labels for the same cards; align wording with your audience and locale.

Spine coverage reference (what each stage is for — not separate “card” names):

| Spine stage | Role |
|-------------|------|
| Critical | Clarity, classification, skip-level checks |
| Fetch | Capability discovery (Search–Match–Invoke) |
| Thinking | Options, risks, decomposition |
| Execution | Delegated work |
| Review | Result validation (Fetch-first reviewers) |
| Meta-Review | Review-of-review when triggered |
| Verification | Fresh-evidence re-check after revisions |
| Evolution | Learnings and scars |

---

## "WHAT IT IS NOT" GUARDRAILS

- Meta ≠ role naming: calling something "frontend agent" doesn't make it a meta; naming without clear boundaries is just packaging
- Meta ≠ Omnipotent Executor Meta: stuffing all responsibilities into one agent isn't strength; clear division of labor is maturity
- Organizational Mirror ≠ metadata/ORM: it's not a technical term — it's an architectural design method for collaboration relationships between metas, responsibility boundaries, and who takes the field first
- Meta ≠ framework complexity: simple scenarios don't need meta decomposition; direct execution is more efficient — meta is a governance tool, not decoration
- Meta ≠ once-and-for-all: meta boundaries need to be adjusted as the system evolves; they aren't defined once and never changed
