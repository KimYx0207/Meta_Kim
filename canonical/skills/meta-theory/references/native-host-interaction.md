# Native host interaction

## Use when

Use this reference when an active host must continue a Live request, delegate work, collect a child result or resume an existing worker. Runtime documentation checked on 2026-11-15 describes possible interfaces; only the current callable schema, permissions and returned evidence establish availability.

## Required inputs

Use the exact installed `hostEntry`, project, profile, run and verified conversation from the current handoff.

Discover the actual dispatch tool, permitted target/owner binding, current nesting and concurrency limits, return mechanism and resume support.

In reported mode the adapter receives the complete prepared method prompt, `stageBinding`, `methodSourceBinding`, current scope/upstream results and one `machineResultArtifact` target.

## Do

`scripts/live-workspace-host.mjs --next-work` reads the existing workspace; it does not claim a request, start a model or create a second queue. A stored `nextAction` is a snapshot, so read fresh before choosing work and after reporting a result.

Continue only when the fresh result has `status=ready` and `continuation.mayContinue=true`, its identity still matches and the action is covered by current authorization. Pass `claimArguments` as an argv array to that entry; do not evaluate command text. Claim with the returned revision, perform the bounded work, collect the actual result, verify the artifact references and report through the existing completion port.

An active parent waits for its authorized native children and reviews their returns before finalizing.

The default `observed_runtime` mode retains the existing same-process result observer for supported Claude/Codex CLI adapters. Other hosts can select `stageRunner.stageResultMode = "host_reported_files"` with their actual current-host adapter. This is a supported reported-evidence route; native certification is not an additional acceptance gate. Explicit native `stageExecutors` remain available where the host already provides them.

### Runtime differences

| Current host | Dispatch, return and recovery boundary |
| --- | --- |
| Claude Code | Use the actual `Agent` schema. Current releases support nested subagents when their tools and configured depth allow it. Current `SendMessage` can continue a completed resumable agent using its returned identity; built-in Explore/Plan are one-shot and return no resumable ID. Older releases may expose a different recovery schema. |
| Codex / ChatGPT Codex host | Use exposed `spawn_agent`, `followup_task`, `send_input`, `resume_agent` or namespaced equivalents according to that surface's schema. A message-only operation may not start an idle worker. V1/V2 configuration and tool semantics differ; do not impose a copied depth or capacity value. Use native parent returns. |
| Cursor | Use its actual `Task` surface and returned agent ID for a supported resume. IDE and SDK nesting behavior differ. A configured `stop`/`subagentStop` follow-up is subject to native loop limits and completed status; abort/error is not permission to continue. Meta_Kim's handoff does not install an automatic follow-up loop. |
| Gemini CLI | The discovered custom agent name is its callable tool. Local subagents cannot call other subagents, even with `tools: ["*"]`; return additional work to the main agent. Do not invent a resume tool or grant tools through a prompt. |
| ZCode | Use `Agent` and its native foreground/background result delivery. Children cannot spawn other children. Their MCP inventory is the parent's session-start inventory; missing or newly connected tools require the host's supported session handling, not a fabricated child invocation. |
| DeepSeek Harness (DSH) | Inspect the actual `subagent` instance/provider and preset. Start returns an asynchronous activation acknowledgement. Local Spawn/Fork children support native messaging and restoration; external Codex/Claude/ACP/DSH SDK backends do not accept follow-up messages. Respect provider capabilities and the host's current depth limit; a governance Skill is not an `agentPreset`. |
| OpenClaw | Use actual `sessions_spawn` and the native lifecycle/announce result. Nesting, child admission, tool policy and target allowlists govern delegation. Only use recovery/session controls exposed by the running Gateway; do not infer that a stopped Gateway can deliver a wakeup. |

## Do not

`waiting_human`, `waiting_host`, `in_doubt` and `idle` do not schedule retry loops.

A role name, installed definition or model's general ability is not a callable surface.

MCP connectivity, hook text and an ended assistant turn cannot wake a stopped client. Do not start another provider, app-server, background model, Goal or heartbeat to manufacture that ability.

Native children return through their host's native collaboration or final return to their native ancestors. Cross-chat notification is a separate external action: only the already-supported path in `SKILL.md` and `scripts/live-host-continuation.mjs prepare/commit`, with its independent trusted human authorization and original bound receipts, can use it. A parent request to reply does not grant that authorization. Do not use cross-chat messaging as a replacement for a native ancestor return, proxy a refused send or claim a native message starts a new parent turn.

## Required packet

Give each worker its existing task packet: goal and acceptance criteria, selected owner/method, complete required method sources, current input/artifact versions, owned resources, dependencies, allowed actions, expected output and acceptance owner.

The ordinary runner accepts existing source-bound work packets in `stageRunner.stageWorkPackets`, keyed by node ID, `module:Review` or stage name. Each packet declares its stage's `acceptanceCriterionIds`; independent Review, Meta-Review and Verification also cover the current scope's worker criteria. `module-stage-host-bindings.mjs` composes these packets with the same `stageRunner.authorize` and `adapterRegistry` used for worker execution. It reads complete method sources and contracts, rather than requiring a new dispatcher or asking the user to manufacture receipts. Missing sources or criteria remain per-binding diagnostics so independent work can proceed.

## Pass

The binding factory records `host_reported_files_verified` with `nativeInvocationVerified: false`; the source owner's report does not certify a model call or user acceptance.

## Fail

Do not convert a start acknowledgement into a terminal result or convert a terminal result into independent acceptance.

A missing child return is not completion.

Wrong or missing evidence cannot advance the stage.

## Block

A user pause, abort, changed goal or revoked permission stops the affected continuation.

A changed source, revoked authorization, uncertain result or unavailable adapter stays unresolved through the existing run, without silently launching another client.

## Return to stage

Then inspect the next work. A CAS conflict requires a fresh read; it does not authorize repeating the previous side effect.

Preserve unresolved claims; reconcile the original worker and return before considering another attempt.

After a genuine wait, resume only through the host's supported lifecycle under the still-current authorization.

If a native child lacks a delegation tool, reaches its depth limit or cannot address the selected owner, return a bounded work order and the concrete missing surface to its native parent. The parent applies the existing owner resolution and dispatches the work within the same host, subject to available capacity and dependencies. Do not require a second client, invent a nested tool call, recursively reinstall an agent or call the entire route degraded merely because one child cannot spawn.

The module fact bridge rechecks the current design and claim identity before starting a stage and on resume. The claim lease indicates reconciliation needs; the current host separately checks authorization before each dispatch. It cannot automatically reclaim uncertain work, and an exact late result can still use the original report command. Historical stage receipts remain evidence, but cannot override a current material change, withdrawn Decision or stopped run.

## Verification

The binding factory rereads the exact file, rejects an existing target before redispatch, checks the complete run/node/scope/attempt/fence/input binding, revalidates the source and artifact hashes, and consumes every required criterion.

Keep the selected owner/source, host tool and arguments, returned worker identity, terminal status, actual artifacts and independent checks attached to the current task. Record failed, denied, unavailable, pending and completed as observed.

Local contract tests certify the handoff protocol, not paid model execution, installed-client operation or user acceptance.

### Official interface references

- Claude Code: [subagents and resume](https://code.claude.com/docs/en/sub-agents).
- Codex: [subagents](https://developers.openai.com/codex/subagents/) and [app-server lifecycle](https://developers.openai.com/codex/app-server/); [V1/V2 configuration definitions](https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs).
- Cursor: [subagents](https://cursor.com/docs/subagents) and [hook follow-ups](https://cursor.com/docs/hooks).
- Gemini CLI: [subagent isolation and recursion](https://geminicli.com/docs/core/subagents/).
- ZCode: [subagents, tools and MCP boundaries](https://zcode.z.ai/en/docs/subagents).
- DSH: [native subagent tool and provider continuation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/tool-subagent/README.md).
- OpenClaw: [subagents](https://docs.openclaw.ai/tools/subagents) and [nesting and authentication](https://docs.openclaw.ai/tools/subagents/nesting).

## Writeback

Invoke the actual host tool under the packet's permissions, then write the complete `{binding, output}` envelope to that exact new target; `output` must follow the source method's output contract. Return `result` with `status: "returned"`, actual `runtime`, `ownerMethodBinding`, and `machineResultArtifact: {path, sha256, bytes}`. Include actual session/message identities when available, never invented ones. `ownerMethodBinding` identifies the selected source; it cannot prove the host loaded it or grant permissions.

Preserve the original native return in the host's existing evidence location.

## Preserve

Preserve the existing run, task packets, claims and acceptance owners.

One installed client can run the complete governance method using its own available workers and tools; installing Codex is not a prerequisite for Claude Code, Gemini, ZCode or the other hosts.

Preserve the same task/attempt identity when using a supported resume.

Shared files do not imply shared model context or inherited human approval.
