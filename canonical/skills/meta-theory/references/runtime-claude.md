# Claude Code Runtime Adapter

Use this reference when Meta_Kim runs inside Claude Code and the route depends on native questions, subagents, skills, slash commands, prompts, hooks, or MCP tools.

Project-retained Claude Code agents live in `.claude/agents/<agent>.md`. When the user asks to create, iterate, upgrade, or keep an agent in the project, Claude Code must treat that file-level agent definition or a Warden-approved candidate writeback as the deliverable. A Claude subagent invocation may help design or review the agent, but it is not itself the durable project agent.

## Native Question Surface

Claude Code exposes the native `AskUserQuestion` tool for branch-changing user decisions. Current Claude Code hooks documentation also describes `AskUserQuestion` as the typical deferred tool-use case for non-interactive `claude -p` integrations, where the calling process surfaces the question and resumes the session with the answer. Reference: https://code.claude.com/docs/en/hooks

Known limitation: PreToolUse hooks strip `AskUserQuestion` return data (GitHub issue #12031). Meta_Kim hooks whitelist `AskUserQuestion` to bypass this by not intercepting it. Claude Code is a primary Meta_Kim runtime, so if the native tool is unavailable, returns empty, or is stripped by hooks, record `nativeChoiceSurfaceBlocked` and stop before Execution instead of accepting a localized chat decision card.

Trigger proof rule: when `AskUserQuestion` is available and `choiceSurfaceState` is `critical_clarification_allowed` or `execution_confirmation_allowed`, Claude Code must call `AskUserQuestion` or produce a deferred `AskUserQuestion` tool call for the host UI before Execution. A `cardPlanPacket`, CLI report, hook notification, or markdown decision card is not proof that the native question surface appeared. In non-interactive `claude -p` flows, acceptable proof is a deferred `AskUserQuestion` tool call handled by the caller or a non-empty resumed answer. Missing native proof blocks the run.

False native choice claim guard: do not announce "I used AskUserQuestion", "the native question did not return", "the popup failed", or equivalent localized wording unless an `AskUserQuestion` answer, deferred `AskUserQuestion` tool call, or `nativeChoiceSurfaceBlocked` record exists. If the tool is unavailable, say the native question is blocked or pending; do not narrate an empty return that the runtime did not provide.

## Visible Status Boundary

Claude Code `UserPromptSubmit` / HookPrompt context can help Claude decide what to do, but it is not the same thing as telling the user what is happening. `MessageDisplay` can transform assistant text while it streams, but it is display-only: it cannot create a missing stage notice, cannot change what Claude sees, and cannot replace the conversation transcript. For Claude Code, the reliable user-visible status surface is the assistant message itself.

Therefore every governed Claude Code run must render localized assistant-message notices for run start, route selected before Execution, blocker/degraded state when present, and closure. Use `AskUserQuestion` only for branch-changing decisions; do not use it for routine progress.

Claude Code task/todo bookkeeping is not a progress surface. During Critical and pre-evidence Fetch, do not open with `TaskCreate`, `TaskUpdate`, or `TodoWrite`, and do not announce "I will create a task list, then continue Fetch." Continue with a compact assistant-message status plus batch read/search evidence first. Task/todo bookkeeping may be used after Fetch evidence exists when it preserves continuity, but it is not required for governance readiness.

Use `AskUserQuestion` in exactly these cases:

- Critical clarification: only when the missing answer changes deliverable, scope, permission, safety, owner, capability, acceptance, or non-goal, and Fetch cannot safely proceed.
- Execution confirmation: only after Fetch evidence and Thinking option framing are complete, when the selected route branches by scope, owner, capability, risk, verification depth, or public-ready acceptance.

Every `AskUserQuestion` payload must use the active Claude Code native question schema and show the maximum meaningful option count that schema accepts. Current known Claude Code payloads commonly support two to four meaningful options; treat that as observed host capacity, not a Meta_Kim product cap. Each option states what changes, what problem it solves, expected result, advantage, disadvantage or risk, and verification impact. No filler questions and no question quota.

Native structured panel content: the `AskUserQuestion` payload should render as a host-native interactive panel, not as an unstructured yes/no interruption. The question prompt must preserve the semantic panel sections "AI understanding", "AI additions", "Capability route", and "Candidate paths" when those sections affect the decision. Options must keep the recommended default visible and preserve expected result, advantage, disadvantage/risk, and verification impact. If the Claude host changes the visual renderer, Meta_Kim still owns this payload structure; the host owns the skin.

Subjective quality or non-measurable adjective requests such as "good", "bad", "beautiful", "ugly", "doesn't look good", "smooth", "not smooth", "professional", "premium", "advanced", "clean", "simple", "fast", "slow", "hard to use", "feels off", or localized equivalents are blocking Critical clarification when the target, quality dimension, acceptance standard, or allowed scope is unclear. Ask through `AskUserQuestion` before Fetch or Execution rather than guessing an aesthetic, UX, quality, or trade-off direction.

## Dispatch-Not-Execute In Claude Code

In Claude Code, governed Execution is real only when the main thread invokes actual providers selected during Thinking. The main thread scopes, dispatches, reviews, and synthesizes; it must not directly edit, write, or run implementation commands as the worker for non-trivial executable work.

Claude Code fan-out uses Claude Code's native dispatch capacity, the task DAG, collision boundaries, workspace isolation, permission model, and context budget. Meta_Kim must not impose a fixed maximum number of Claude Code subagents. If the host can safely run more independent Task/Agent lanes, use that host capacity; if the host or task cannot, record the concrete capacity or safety reason.

An ordinary natural-language request for a persistent artifact with multiple independent work scopes is fan-out eligible even when the user never says Agent or parallel. After a bounded initial Fetch (at most 8 targeted source reads), Thinking must bind workers and invoke the native `Agent` surface before `TaskCreate`, `TaskUpdate`, or `TodoWrite`. Those task-list tools are bookkeeping only; they never count as worker dispatch and must not become a substitute for Agent execution.

`agent-teams-playbook` uses stop-on-match capability resolution in Claude Code. Once a qualified Agent, Skill, Tool, Command, or MCP provider is found, bind it and stop searching. `find-skills` is only for a proven capability gap. A successful native Agent/Task dispatch after an optional Skill search found no install is still the normal route, not fallback or degraded execution. Do not apply Codex `task_name`, `message`, or `fork_turns` parameters to Claude Code.

Before the first mutation, Thinking must produce a dispatch plan that binds each execution lane to:

- `ownerAgent`: the selected agent or provider owner
- `weapon`: the concrete tool surface, such as `Agent`, `Skill`, slash `Command`, prompt/rule provider, MCP tool, shell script, or runtime tool
- `capabilityBindings`: the specific agent, skill, command, prompt, MCP tool, or script found during Fetch
- `verificationOwner`: the role that will verify the result

Execution must then call the selected provider surface:

- Use `Agent` / Task tool for implementation lanes that have a matching Claude subagent.
- Use `Skill` when a Claude skill is the chosen capability provider.
- Use slash `Command` or project script only when command discovery selected that command as the weapon.
- Use prompt/rule providers only when Fetch found them and Thinking bound them to the lane.
- Use MCP tools only when the MCP inventory proves the tool is available and safe for the lane.

Record selected executable bindings in `runtimeInvocationPlanPacket`. `hostInvocationRequestPacket` is the Claude Code adapter handoff: for each missing binding it states the Agent/Task, Skill, slash command, MCP, hook, or runtime-tool action the host must perform. The Node runner must not treat the request, a fixture, or a caller-supplied trust flag as proof. Highest-assurance `live-certified` evidence comes from an external observer parsing Claude stream JSON, tool-use/tool-result pairs, and correlated hook events; it must match the run, session, event, provider, task binding, timestamp, and successful result in a hash-verified observation artifact. `capabilityInvocationTruthPacket.realInvocationCoverage.status` is `pass` only when every selected binding is covered. Readiness probes and MCP `--self-test` output remain callable/catalog evidence only. `selected_not_invoked` is honest evidence but never a product-experience pass. This external attestation boundary governs the optional `live-certified` label; it is not a prerequisite for a standard release whose `meta:verify:all` run passed.

For create-agent or iterate-agent routes, execution must separate two artifacts:

- durable project agent: `.claude/agents/<agent>.md` plus matching formal tool projection metadata from `config/sync.json` and `config/runtime-compatibility-catalog.json`
- temporary worker dispatch: `Agent` prompts tied to `workerTaskPackets`

Do not accept a temporary Agent prompt, runtime thread name, or current work order as the agent definition. Durable agent identity must stay abstract: reusable responsibility class, non-capabilities, abstract loadout slots, inputs, outputs, handoff, memory policy, gap policy, and verification policy.

Durable Claude Code agent completion is a four-step lifecycle, not a file write:

1. Generate a reviewed project-agent definition candidate.
2. Apply Warden-approved writeback to `.claude/agents/<agent>.md` or the configured projection target.
3. Reload or restart Claude Code so it discovers the agent definition, then attach `durable_agent` evidence with `evidenceKind=host_discovery_reload`.
4. Invoke that durable agent through Claude Code Agent/Task and attach `durable_agent` evidence with `evidenceKind=durable_agent_live_invocation`.

Until steps 3 and 4 are attached, `durableAgentLifecyclePacket.status` remains partial even if the file exists.

If no real provider is callable, do not self-execute to "keep moving". Return to Thinking with `capabilityGapPacket`, or enter degraded mode with explicit `degradationReason`, `humanAcceptanceRequired`, `publicReadinessState=internal-ready`, and runtime `surfaceState=notice` or `silent`.

## Write-Time Fact Gates

Claude Code may run project or plugin PreToolUse hooks that deny the first `Write`, `Edit`, or file-producing command until the assistant states file facts. Treat that denial as a Fetch/Thinking repair signal, not as a permission problem to bypass.

When a write-time fact gate appears, produce the Meta_Kim `fileChangeFactCard` in the user's language and retry the same file operation only after the card is complete. The card must name target files, explain their consumer/caller/distribution path, show same-purpose file search results and reuse decision, describe data fields/structure/date formats with redacted or synthetic examples when data files are involved, and quote the current user instruction verbatim. For content projects, "consumer" may mean the lesson, README, task card, index page, or human workflow that will distribute or ask the user to open the file.

Do not copy the external hook's wording into durable Meta_Kim instructions. Keep the durable concept as "change facts before mutation": target, consumer, overlap, data shape, and user instruction.

## Use when

- The user expects a Claude Code popup or native decision surface.
- A governed task would otherwise be implemented by the main thread.
- The route depends on Claude Code subagents, skills, commands, prompts, hooks, or MCP tools.

## Required inputs

- `intentPacket.realIntent` locked in Critical stage.
- `fetchPacket.capabilityMatches` with at least one scored candidate.
- `dispatchEnvelopePacket.ownerAgent` resolved during Thinking.
- `workerTaskPackets[].taskPacketId` and `roleInstanceId` for each execution lane.
- `capabilityBindings` mapping each lane to a callable Claude Code provider (Agent, Skill, Command, prompt, MCP).

## Do

- Use `AskUserQuestion` for required branch-changing choices when available.
- Prefer real Agent / Skill / Command / prompt / MCP dispatch over main-thread execution.
- For agent creation/iteration, produce a durable project-agent candidate with formal tool projection targets from the sync manifest and compatibility catalog; use subagents only as factory or review workers.
- Record unavailable providers as evidence, not as permission to fake delegation.
- Cite `workerTaskPackets[].taskPacketId` in every Agent dispatch prompt.
- Read the current content of every target file in the same execution turn before using Edit, MultiEdit, Write, or any command that rewrites it.
- Build `fileChangeFactCard` before file mutation, and use it to answer write-time fact gates before retrying the same operation.
- For an unresolved required choice, block with `nativeChoiceSurfaceBlocked` when `AskUserQuestion` is unavailable, returns empty, or cannot be deferred to the host UI. Preserve an already settled direction and existing action authorization separately.

## Do not

- Do not call a chat decision card a popup.
- Do not ask during Critical, Fetch, Thinking, or Review just to satisfy a ritual.
- Do not let the main thread become the implementation worker for non-trivial governed execution.
- Do not self-execute when Thinking assigned a different owner without recording `degradationReason`.
- Do not disable, route around, or repeatedly hammer a write-time fact gate; return to Fetch/Thinking, state the facts once, then retry.

## Required packet

- `dispatchEnvelopePacket` with `ownerAgent`, `weapon`, `capabilityBindings`, and `verificationOwner`.
- `fileChangeFactCard` when the lane will mutate files.
- `workerResultPackets[].workerExecutionEvidence` from each dispatched provider.
- For a required branch-changing `AskUserQuestion`: `choiceSurfaceState` must be `completed` before the dependent Execution; `preDecisionOptionFrame.candidateOptions` must list at least two viable options. A settled single route uses the existing recorded skip policy and does not need a filler option or another interview.

## Pass criteria

- Every dispatched provider returned a result matching its declared output schema.
- Every mutated file was read before rewrite and has a recorded target, consumer, overlap decision, and data-shape note where applicable.
- A required `AskUserQuestion` returned a non-empty answer, or non-interactive mode produced a deferred `AskUserQuestion` tool call that the host UI handles before resume; otherwise an allowed choice skip records its rationale.
- `workerResultPackets[].schemaValidationAttempts[].passed === true` for each lane.
- The main thread did not directly edit, write, or run implementation commands.

## Fail criteria

- Main thread directly executed implementation work without dispatching a provider.
- File mutation attempted through Edit, MultiEdit, Write, or rewrite commands before reading the target file in the same execution turn.
- File mutation started without `fileChangeFactCard` when the change was non-trivial, new-file, data-file, runtime-facing, or hook-gated.
- `AskUserQuestion` returned empty and the run did not block with `nativeChoiceSurfaceBlocked`.
- `workerTaskPackets` missing `taskPacketId` or `roleInstanceId`.
- `capabilityBindings` missing or referencing a provider not found during Fetch.

## Block conditions

- `AskUserQuestion` called outside blocking Critical clarification or post-Thinking execution confirmation.
- Critical clarification needed for a subjective quality complaint, but mutation or execution starts without `choiceSurfaceState=critical_clarification_allowed` followed by a completed native answer or deferred native answer.
- Agent dispatch in execution stage without `capabilitySearchPerformed === true` in spine state.
- An unresolved required choice has `choiceSurfaceState` not `completed` when its dependent Execution attempts mutation tools; allowed skips remain governed by their recorded rationale and independent permissions.
- Same write-time fact gate blocks the same action twice after `fileChangeFactCard` was presented; record `hookFailurePacket` and return to Thinking.
- PreToolUse hook strips `AskUserQuestion` return data (workaround: hook bypasses `AskUserQuestion` at line ~900 of `enforce-agent-dispatch.mjs`).

## Return to stage

- Missing `fetchPacket.capabilityMatches` → return to Fetch.
- Missing `dispatchEnvelopePacket` or `capabilityBindings` → return to Thinking.
- Missing or incomplete `fileChangeFactCard` for a write-time fact gate → return to Fetch, complete the card, then retry the same operation.
- Empty `AskUserQuestion` response → record `nativeChoiceSurfaceBlocked=hook_strip`, return to Thinking, and do not execute.
- Provider dispatch fails → return to Thinking with `capabilityGapPacket`.

## Verification

- Confirm each Agent dispatch prompt cites a `workerTaskPackets[].taskPacketId`.
- Confirm `AskUserQuestion` popup appeared by checking the returned answer is non-empty, or confirm non-interactive deferred native UI by checking `deferred_tool_use.name === "AskUserQuestion"` and the resumed answer is present.
- Correlate real `hook_started` and successful `hook_response` records by `hook_id`. If no tool-use id is present, record only session-level hook observation; do not claim an exact route binding.
- Treat generic `Bash` use as runtime-tool evidence. Promote it to selected Command evidence only after exact argv/provider/binding reconciliation outside the model process.
- Run `npm run meta:test:meta-theory` to verify all 8-stage spine tests pass with the Claude Code adapter loaded.
- Check `enforce-agent-dispatch.mjs` whitelists `AskUserQuestion` to avoid issue #12031.

## Writeback

- If `AskUserQuestion` behavior changes in a Claude Code update, update this reference and the hook whitelist.
- If a new provider surface is added to Claude Code (e.g., a native multi-select), add it to `capabilityBindings` options and update `runtimeNativeChoiceSurfaces.claude` in `workflow-contract.json`.
- Hook compatibility scars go to `canonical/runtime-assets/claude/hooks/` with regression test.

## Preserve

- Claude Code's native `AskUserQuestion` tool must not be replaced with a Meta_Kim equivalent.
- Claude Code's permission system (allow/deny) must not be bypassed by governance.
- Claude Code's built-in Skills, WebSearch, browser, filesystem, shell, MCP, and memory tools must remain callable; governance may add boundaries but must not remove them.
- The `enforce-agent-dispatch.mjs` whitelist for `AskUserQuestion` must not be removed without confirming issue #12031 is resolved upstream.
