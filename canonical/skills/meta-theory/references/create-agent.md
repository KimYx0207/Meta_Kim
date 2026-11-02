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

## Governance Owner Factory Lane

When Type B is triggered by a **capability gap in the Meta_Kim repository itself**, use the stricter **governance owner factory lane** instead of an ad-hoc prompt-writing loop. Public Meta_Kim does not persist non-governance execution agents; implementation capability is recorded as run-scoped skill/tool evidence.

When Type B is triggered while Meta_Kim is used inside a **user project**, search global agents first. If a global agent already fits, use it directly and do not copy it into the project. Project facts and stable default skill/tool preferences belong in the independently approved capability profile. Copy a global agent only when its stable responsibility, refusal, input/output contract or explicitly required independent project identity must change; record that copy as project-local upgrade work, not ordinary reuse.

When the user's intent explicitly says the agent should be created, iterated, upgraded, or kept in the project, the route must not collapse into `worker_task_only`. The factory may still reject bad agent design, but it must return a durable project-agent candidate or a blocked `capabilityGapPacket` explaining which evidence is missing. Temporary runtime subagents are allowed only as factory workers or reviewers; they are not the created agent.

Professional role split:

- **Warden** is the **public front door** and approval owner.
- **Conductor** owns orchestration only: it converts the gap into a task board and later dispatches the result.
- **Base-meta factory** owns governance capability building only: **Genesis + Artisan + Scout + Sentinel + Librarian**.
- **Run-scoped `matchedCapabilities` plus `capabilityBindings` are the implementation capability evidence**. Legacy `matchedSkills` may appear only as compatibility evidence. The factory never performs business execution directly.

Factory lane:

1. **Warden** confirms that an existing owner is insufficient.
2. **Conductor** emits the capability-gap decision and task board.
3. **Genesis** defines or refines governance owner identity and boundary.
4. **Artisan** defines abstract capability slots, provider compatibility, and Fetch-time skill / tool selection rules.
5. **Scout** backfills external capability only when local coverage is missing.
6. **Sentinel** validates safety boundaries.
7. **Librarian** provisions memory / reuse strategy.
8. **Prism** runs the quality gate.
9. **Warden** approves the governance owner decision and run-scoped capability match.

Rule: Conductor may participate before or after the factory, but **Conductor does not build capability**.

### Station Deliverable Contract (Mandatory)

Required Genesis deliverables: SOUL / identity / responsibility boundary.
Required Artisan deliverables: capability slots, provider compatibility, loadout rules.
Required Conductor deliverables: orchestration board, dependencies, merge path.

| Station | Deliverable |
|---|---|
| Warden | approval gate, public boundary, final owner decision |
| Genesis | SOUL / identity / responsibility boundary |
| Artisan | capability slots, provider compatibility, loadout rules |
| Sentinel | safety, permissions, rollback, external side-effect review |
| Librarian | memory, continuity, handoff and reuse policy |
| Conductor | orchestration board, dependencies, merge path |
| Prism | quality review, anti-slop check, evidence closure |
| Scout | external capability discovery and gap evidence |

## Reviewed creator artifact handoff

The factory produces professional content before the materializer runs. For a new Skill, apply the discovered `meta-skill-creator` core contract: minimum domain research, package plan, trigger positives/negatives, two real inputs and a boundary task. Do not substitute official `skill-creator`, `create-agent`, or generic Goal/Responsibility/Refusal text. Agent identity remains Type B with its existing Genesis/Artisan/Review/Warden artifacts; Hook/MCP creation is outside this agent/skill/command materializer.

The existing JS API accepts `projectCapabilityCreationArtifacts`; no CLI flag or new authority is implied. Each record binds `requestedCapability`, `capabilityType`, `runtime` and the actual target `projectRoot`, separately from the framework package root. The remaining `creationArtifact` fields are `sourceRef`, `creatorProviderId`, `creatorMethodRef`, `evidenceRefs`, `contentDigest` and `review: {status, approvalRef, contentDigest}`. The prepared source must exist; method/evidence refs must be readable nonempty local sources. Skill provenance resolves to the selected `meta-skill-creator` method. The approval ref contains the same scope, creator/method, evidence refs, approved status and digest; a boolean without a checkable approval source is insufficient.

`contentDigest` is `sha256:` plus the SHA-256 of JSON for the existing copy preview's sorted whole-package `{relPath, baselineHash}` file table. Skill references/assets/scripts are included. The materializer checks a private stable snapshot, then uses the existing copy/transaction/ownership path; it never invents domain content or calls a model. Missing output or approval remains partial with a factory next step and blocks public-ready. Candidate-only text and unfulfilled conditions such as “unless Warden approval is supplied” grant no file-write authority.

These checks prove artifact consistency, not creator invocation, native host loading or quality improvement. Attach actual method application and host records separately. Direct global reuse writes nothing. Copying for iteration is only preparation; the project owner then performs the reviewed adaptation and verifies it on the task. Preserve unknown user files, project-owned copies, CAS and exact approval boundaries.

## Fixed Artifacts (Governance Owner Factory Mode)

The public governance owner factory lane must produce these explicit artifacts:

1. **Capability Gap Sheet** (`capabilityGapPacket`) — what is missing, which owners were checked, and what decision was made.
2. **Owner Decision** (`agentBlueprintPacket.roles[]` + `matchedCapabilities` / `capabilityBindings`) — the governance owner contract and run-scoped capability evidence for Meta_Kim itself, or the direct global-reuse / project-local-copy decision for user projects. `agentCopyPolicy = copy_to_project_for_modification` is valid only with project-local upgrade intent; `agentCopyPolicy = create_project_local_agent` is valid only with approved project-local creation. `executionAgentCard` is used only when an execution agent must be created or upgraded, not when a usable global agent is reused directly.
3. **Orchestration Task Board** (`orchestrationTaskBoardPacket`) — ordered execution tasks plus synthesis owner.
4. **Evolution Record** (`evolutionWritebackPacket`) — retain / upgrade / retire outcomes after the run.

## External Execution Agent Role Card Compatibility

External/private and user-project execution-agent registries may still require `executionAgentCard` for creation or upgrade. Public Meta_Kim must not use that packet as durable public owner state; public creation or upgrade is represented by governance owner fields plus `matchedCapabilities` / `capabilityBindings`. Directly reused global agents do not require a copied project-local card.

Required fields:

- **Purpose** — what it is for
- **Capabilities** — what it can do
- **Non-Capabilities / Boundaries** — what it cannot do
- **Dependencies** — abstract capability slots, meta-skill package providers, tools, MCPs, external packages, or other capability sources. Do not bind concrete sub-skills, commands, or plugin sub-capabilities into durable identity.
- **Inputs** — what it accepts
- **Outputs** — what it must deliver

This card is the build contract for an execution-agent factory when an agent must be created or upgraded. It is not used just because a global agent exists; direct global reuse remains a reference, not a local copy. A copied global agent must be modified or upgraded after copy; otherwise it should stay global.

### Durable Project Agent Deliverable

For user-project `create_agent` or `upgrade_existing_owner` routes, the accepted deliverable is a project-retained abstract agent definition, plus projection metadata for required runtimes. It must be suitable for version control and future reuse, not just for the current run.

Required durable deliverables:

- `GeneratedAgentSpec` as the reviewed source of identity truth.
- Project target policy: `project_local_agent`.
- Runtime projections: every formal tool target from `config/sync.json` with an agent path in `config/runtime-compatibility-catalog.json`, marked with its catalog status and evidence.
- Candidate writeback or planned file target showing where the agent will be retained after Warden/user approval.

The durable definition must contain abstract rules: role-family name, trigger conditions, responsibilities, non-capabilities, loadout slots, inputs, outputs, handoff, memory policy, gap policy, and verification policy. It must not contain the current task, current files, ticket names, runtime nickname, or one-run verification steps.

If the run only needs a temporary execution worker, use `workerTaskPacket` and do not create an agent. If the user asks for a persistent project agent, `workerTaskPacket` can describe the factory work, but it cannot be the final deliverable.

### Sub-agent Identity Carry-over

When the orchestrator dispatches a meta-* agent as a sub-agent (e.g., `Agent(subagent_type: "meta-prism", ...)`):
- The sub-agent's runtime identity remains "meta-*"
- All meta-* tool restrictions and behavioral rules continue to apply
- The sub-agent must use Read-only + Agent tools for its own work
- If the sub-agent's task requires execution (code edits, builds, installs), it must transitively dispatch to a non-governance executor
- This carry-over rule is enforced by both: (a) prompt-layer self-check in SKILL.md, and (b) hook-layer caller identity check in `enforce-agent-dispatch.mjs`

### Skill Binding Rules For Created Or Iterated Agents

Created or upgraded agents inherit durable capability shape, not a frozen tactic list.

- Long-term identity may include abstract capability slots, such as `test generation`, `browser QA`, `security review`, or `planning discipline`.
- Long-term identity may include meta-skill package providers, such as `superpowers` or `ecc`, as compatible capability providers.
- Long-term identity must not include the concrete sub-skill, shell command, plugin sub-capability, or prompt tactic that happened to win one Fetch.
- `findskill` is only a runtime-local capability search entrypoint. Its search result can justify a current-run `selectedSkill`, not a permanent agent binding.
Actual choices belong in run artifacts: `capabilitySearchResult`, `matchedCapabilities`, `capabilityBindings`, `orchestrationTaskBoardPacket`, and `workerTaskPacket`. An independent reviewed versioned default capability profile may name stable providers; this does not turn a current-run search winner into identity or prove execution. `executionAgentCard` remains only for project-local/external identity creation or upgrade.

Genesis owns the durable boundary. Artisan owns provider compatibility and selection rules. Fetch owns the current-run concrete selection.

### Project fit and independent default configuration

Trigger this path when a project needs a retained owner/default method or current project facts may change fit. First read the actual project rules/dependencies, selected owner source/version/digest and relevant method/feedback sources. Host Thinking supplies a source-bound professional fit assessment; Node checks current bindings, not professional truth from keywords, complete fields or an approved boolean.

Use `workflow-contract.json` → `agentBlueprintPacket.projectCapabilityProfilePolicy`. The optional runner `agentCapabilityProfileContext` carries only relevant `profileSelections`, `fitAssessments` and actual approval/evidence refs to the same selector entry. The private project-owned `.meta-kim/state/default/agent-capability-profiles.json` is configuration, not a run cache or copy-ownership manifest. Preview then explicitly apply with exact content-bound approval, prior hash and the existing project transaction; ordinary runs, sync and install never write it. Same version cannot silently change; transaction backups support explicit reviewed adoption of old compatible content as a new version. An ordinary clone without this ignored file is unconfigured.

Input → action → output: actual source-A defaults and project-B evidence → read and verify each in its declared root, resolve relevant slots in base/project/run order → freeze one source-bound profile/loadout per actual lane owner and deliver its constraints and exact necessary materials in that worker's existing message. Missing roots, stale hashes, unsafe links, bad versions or required providers return a concrete gap; never guess a sidecar or fall back across roots. Required/default/optional differ. Project stack overrides a framework preference, not an identity refusal, required MetaSC, permission or unsupported runtime. An unneeded optional provider does not authorize networking or hot-loading its catalog.

For a generic frontend identity that really supports Vue, a Vue project can override a React default and retain the global identity. A React-only identity explicitly refusing Vue cannot gain that responsibility by adding a Skill. Stable responsibility/refusal/input/output changes need reviewed Type B adaptation; a missing qualified long-term specialist may justify Type B creation on the first Fetch, without waiting for repeated failure. When fit requires identity derivation, this profile-only first slice returns the Type B work order/gap and does not claim that identity derivation has been performed. Existing project identities are iterated in place after approval rather than cloned for every ticket.

Verification must distinguish saved configuration, source reads, worker delivery, actual source use, native invocation and task effect. Test fitting reuse and required role change, plus no-profile compatibility and hard-conflict cases. Preserve actual materials/read receipts and independently review their effect; configuration existence or a successful copy never proves improvement. Codex `agent_type` alone cannot bind an exact same-name source/digest or enforce a tool allowlist. Project business Hooks are managed once by the project owner, infrastructure Hooks globally; Agents do not install private Hooks or expand authority.

### Execution Agent Abstraction Boundary

An execution agent is reusable only when its identity names a capability class, not a one-run address or task. `executionAgentCard` may contain purpose, capabilities, non-capabilities, abstract dependencies, inputs, and outputs. It must not contain concrete repo paths, files, tickets, one-run commands, `todayTask`, `scopeFiles`, `deliverableLink`, `verifySteps`, or worker completion checklists.

Concrete work belongs in `workerTaskPacket`: file lists, shard scope, current task text, acceptance criteria, verification steps, deliverable links, and merge rules. If the only way to describe the agent is "the agent that edits this file / fixes this page / handles this ticket," the factory must stop and return to Thinking. The correct route is usually direct reuse of an existing owner plus a concrete worker task packet, not durable agent creation.

Before creating or upgrading an execution agent, Fetch must produce checked-owner evidence from repo canonical capability index, runtime mirrors, project runtime agents, local global inventory, skills, commands, hooks, rules/prompts, tools, plugins, and MCP capabilities. The factory may proceed only when `capabilityGapPacket.currentAgentsChecked` and `currentProvidersChecked` list those candidates and explain why reuse is insufficient.

A reusable capability surface can be represented as provider records with host-specific projection metadata, not as many durable execution-agent identities. Interface metadata is a discovery card, not a worker identity. Meta_Kim should therefore prefer provider reuse or provider projection before creating a new execution agent; create the agent only when the missing thing is a recurring owner boundary that cannot be represented by an existing agent, skill, command, MCP tool, runtime tool, or plugin.

### Generated Agent Spec Quality Contract

When `GapDecision.decision = create_agent`, the factory must produce a `GeneratedAgentSpec` review artifact before any local or project agent file is written. This artifact proves that the proposed agent is abstract enough to be reusable, professional enough to be useful, and bounded enough to avoid becoming a one-run worker.

`GeneratedAgentSpec` is a review artifact, not a fourth core data model for the Capability Gap MVP. It is required only for create-agent decisions.

Required fields:

- `name`: short, stable, English role-family name; no runtime nickname and no task title.
- `description`: one high-signal trigger sentence that names the professional capability and the route conditions.
- `flowPosition`: where the agent belongs in a product flow such as `Think`, `Plan`, `Build`, `Review`, `Test`, `Ship`, or `Reflect`.
- `purpose`: what durable problem class the agent owns.
- `capabilities`: 4-8 reusable capability classes with domain-specific nouns.
- `nonCapabilities`: explicit refusals, including external writes, one-run implementation work, and work better handled by skill/script/provider.
- `loadoutSlots`: abstract skill, command, MCP, runtime tool, or normal tool slots; stable provider preferences may be held in the separate approved default profile, while actual `capabilityBindings` stay run-scoped.
- `inputs`: stable input contract.
- `outputs`: stable output contract.
- `handoff`: upstream evidence needed and downstream consumer expectations.
- `memoryPolicy`: whether memory is `none`, `run_scoped`, `project_scoped`, or `cross_project_readonly`, plus access boundaries.
- `gapPolicy`: what the agent must report as a capability gap instead of pretending to know.
- `verificationPolicy`: fixtures, scorecard dimensions, and verification owner.
- `installProjection`: whether this can be projected to Claude, Codex, Cursor, OpenClaw, or remains reference-only.
- `projectRetention`: how the agent will be kept in the project, including formal tool projection targets and writeback approval boundary.
- `identityCleanliness`: explicit proof that no repo path, file list, ticket, today task, deliverable link, or verify step is in durable identity.

Quality bar:

| Dimension | Pass condition |
|---|---|
| `identity_clarity` | A maintainer can tell when to call the agent from the name and description alone. |
| `domain_specificity` | Replacing the agent name with `generic-agent` breaks the core logic. |
| `flow_fit` | The agent has a clear upstream and downstream position inside Meta_Kim's product flow. |
| `tool_least_privilege` | Loadout slots are the minimum needed for the capability class. |
| `memory_fit` | Memory policy uses scoped access and does not leak user/project history into identity. |
| `gap_honesty` | The agent names what it cannot know or do and routes gaps to `GapDecision`. |
| `handoff_readiness` | Outputs can be consumed by another owner without oral explanation. |
| `verification_readiness` | At least one fixture or replay check can fail the agent design. |
| `install_projection_readiness` | Runtime projection status is explicit: eligible, needs_probe, or reference_only. |
| `identity_cleanliness` | No one-run work-order fields appear in durable identity. |

Pass threshold: all ten dimensions must pass for direct creation. One soft miss returns to Genesis or Artisan for revision. Any miss in `identity_cleanliness`, `gap_honesty`, `tool_least_privilege`, or `memory_fit` blocks creation and returns to Thinking.

Reference translation:

- Professional role standard: use a domain role, concise trigger, tool awareness, examples, and cross-runtime packaging discipline.
- Flow standard: place the agent inside a real product flow and make upstream/downstream handoff explicit.
- Memory standard: give the agent scoped memory, gap analysis, schema/eval thinking, and access boundaries.

Do not copy:

- Do not copy one repository's commands, install scripts, or host-specific preambles into durable identity.
- Do not create a graph database or full CapabilityGraph before the create-agent fixture proves value.
- Do not let every agent carry long-term memory; memory is a provider policy, not a personality trait.

Minimal create-agent fixture:

```json
{
  "fixtureId": "generated-agent-test-coverage-specialist",
  "input": "The project repeatedly lacks a stable owner for test coverage strategy, gap diagnosis, and verification planning.",
  "expectedDecision": "create_agent",
  "generatedAgentSpec": {
    "name": "test-coverage-specialist",
    "flowPosition": "Test",
    "purpose": "Own reusable test coverage strategy and coverage gap diagnosis across runs.",
    "nonCapabilities": [
      "does not become the implementation worker for every failing test",
      "does not publish coverage reports externally without approval",
      "does not replace existing test, QA, or release owners when they already fit"
    ],
    "loadoutSlots": [
      "test framework discovery",
      "coverage report parsing",
      "risk-based test planning",
      "regression fixture design"
    ],
    "memoryPolicy": "project_scoped repeat patterns and user corrections only",
    "gapPolicy": "emit GapDecision when the project lacks a test runner, coverage command, fixture harness, or permission to execute tests",
    "verificationPolicy": "fixture must prove no one-run path or verifySteps appear in durable identity"
  }
}
```

### LangGraph Projection Boundary

When the Capability Gap MVP is projected into a LangGraph-style runtime, keep identity, task, and route state separate:

- `GeneratedAgentSpec` maps to a reusable worker node contract.
- `workerTaskPacket` maps to the run-scoped task state passed into that node.
- `GapDecision` maps to conditional edge routing.
- `CandidateWriteback` maps to the post-run evolution state, not to automatic file writes.
- Governance agents map to decision, review, and gate nodes; they do not become business execution worker nodes.
- Skills, scripts, commands, MCP providers, runtime tools, and plugins map to capability/tool nodes or loadout slots.

The first LangGraph target is a control graph, not a knowledge graph:

```text
critical_intent
-> fetch_capabilities
-> detect_gap
-> decide_gap_route
-> one of: design_skill_candidate | design_agent_spec | design_script_candidate | design_mcp_provider_candidate | make_worker_task | ask_approval_or_block
-> review_quality
-> warden_gate
-> verify_fixture
-> evolve_or_none
```

Do not create `CapabilityGraph`, graph database storage, or edge-builder logic until the `GapDecision` and `GeneratedAgentSpec` fixtures prove value.

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

Windows PowerShell equivalents:

```powershell
# Commit count (project scale)
(git log --since="6 months ago" --oneline | Measure-Object -Line).Lines

# Commit type distribution (feat/fix/refactor share)
git log --since="6 months ago" --oneline |
  ForEach-Object { ($_ -split '\s+', 3)[1] } |
  ForEach-Object { ($_ -split ':', 2)[0] } |
  Group-Object |
  Sort-Object Count -Descending |
  Select-Object Count, Name

# Directory change heatmap (most active areas)
git log --since="6 months ago" --name-only --pretty=format:"" |
  Where-Object { $_ } |
  ForEach-Object { Split-Path $_ -Parent } |
  Where-Object { $_ } |
  Group-Object |
  Sort-Object Count -Descending |
  Select-Object -First 20 Count, Name

# Co-change analysis (dirs that often change together = high coupling)
$commits = git log --since="6 months ago" --format="%H"
$pairs = foreach ($commit in $commits) {
  $dirs = git show --name-only --pretty=format:"" $commit |
    Where-Object { $_ } |
    ForEach-Object { Split-Path $_ -Parent } |
    Where-Object { $_ } |
    Sort-Object -Unique
  for ($i = 0; $i -lt $dirs.Count; $i++) {
    for ($j = $i + 1; $j -lt $dirs.Count; $j++) {
      "$($dirs[$i]) $($dirs[$j])"
    }
  }
}
$pairs | Group-Object | Sort-Object Count -Descending | Select-Object -First 15 Count, Name

# File category counts
"=== Components ==="; (Get-ChildItem -LiteralPath "src/visual/components" -Filter "*.tsx" -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
"=== API routes ==="; (Get-ChildItem -LiteralPath "app/api" -Filter "route.ts" -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
"=== Scripts ==="; (Get-ChildItem -LiteralPath "scripts" -Filter "*.mjs" -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
"=== Tests ==="; (Get-ChildItem -LiteralPath "tests" -Filter "*.test.*" -Recurse -ErrorAction SilentlyContinue | Measure-Object).Count
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

Read the canonical `meta-genesis` agent definition first, then use the current runtime mirror only as an adapter. Design SOUL.md per that method.

See references/meta-theory.md, module 8.

### Step 4: Artisan — capability provider matching (required)

Read the canonical `meta-artisan` agent definition first, then use the current runtime mirror only as an adapter.

1. **Scan capability providers and skills**: canonical capability index, runtime mirrors, local runtime inventory, built-in skills, then external discovery when allowed
2. **ROI score**: `ROI = (task coverage × frequency) / (context cost + learning curve)`
3. **Output**: per-agent abstract capability slots, compatible provider packages (`superpowers`, `ecc`, etc.), selection rules, and example run-scoped candidates with ROI and rationale

Do not promote example candidates automatically. Persistent adoption needs source-bound fit, review and approval of the separate default profile; current availability, permission and actual selection are still checked per run.

### Step 5: Sentinel — safety design (on demand)

Read the canonical `meta-sentinel` agent definition first, then use the current runtime mirror only as an adapter.

- **Threat model**: top 5 threats in this agent’s domain
- **Permissions**: three levels (CAN / CANNOT / NEVER)
- **Hooks**: PreToolUse / PostToolUse / Stop
- **Output**: safety rules + hook config + permission boundaries

### Step 6: Librarian — memory design (on demand)

Read the canonical `meta-librarian` agent definition first, then use the current runtime mirror only as an adapter.

- **Memory architecture**: three layers (index / topic / archive)
- **Expiry**: per-type retention rules
- **Output**: MEMORY.md template + persistence strategy

### Step 7: Conductor — orchestration design (on demand)

Read the canonical `meta-conductor` agent definition first, then use the current runtime mirror only as an adapter.

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

Generate the canonical agent source with this shape, then sync runtime mirrors:

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

## Skill loadout / capability provider loadout
| Capability slot | Provider | ROI | Selection rule |
|-----------------|----------|-----|----------------|
{table}

## Run-scoped skill selection policy
Concrete skills, commands, and plugin sub-capabilities are selected after Fetch and recorded in `capabilitySearchResult` / `selectedSkill` / `workerTaskPacket`, not in this agent's long-term identity.

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


## Use when

Use when new owner or agent boundary creation affects route, owner, risk, acceptance, verification, public-ready, or evolution writeback.

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

## Preserve

Preserve Skills, WebSearch/browser/research, filesystem, shell, apply_patch, MCP, memory, Graphify, graph, hooks, commands, rules, agents, subagents, approval, sandbox, runtime tools, package scripts, setup, sync, install, uninstall, status, doctor, validators, and runtime projections.
