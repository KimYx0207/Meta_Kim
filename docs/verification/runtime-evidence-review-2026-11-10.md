# Runtime evidence review — 2026-11-10 UTC

## Purpose and result

The runtime review monitor correctly returned `due_soon`, `issueCount: 0`, and `daysRemaining: 6` in [PR #134's review job](https://github.com/KimYx0207/Meta_Kim/actions/runs/42917534220/job/130183708981). Its clock was 2026-11-10 UTC. The 120 Claude Code, Codex, OpenClaw and Cursor capability rows and their four conservative-review observations were last reviewed on 2026-10-17, the same dates as main. The existing 30-day review window and seven-day warning caused the failure; it was not a new source-digest or acceptance-validation failure. That job's separate evidence regression step reported 49 passed, one skipped and zero failed.

This review reopened the 38 existing official documentation URLs for those four hosts, checked the relevant capability and limitation sections, and inspected the corresponding canonical projections and host-specific denial output. It also recomputed all 23 existing repository-source hash bindings across the six matrix hosts: none differed. Before renewal, the capability validator returned no issues.

The result supports renewing the four **conservative documentation/source reviews** to 2026-11-10 UTC. It does not establish a new live host session, native model execution, successful delegation, user acceptance or professional output quality. Historical `official_docs` and `repo_projection` observation dates, source hashes, host-support levels, integration levels, acceptance states and execution eligibility are preserved. The recent Gemini/ZCode records and separate DSH probe records are unchanged.

## Capability review

The following groups account for each older host's 30 capability rows. Each group was checked against its existing evidence references and the boundaries below; no group was promoted.

| Capability group | Review decision |
| --- | --- |
| Agent, subagent, custom agent | Retain documented host capabilities and current projection claims. File discovery, declared roles and parallelism settings do not certify a successful Meta_Kim task. |
| Skill, command, slash command, skill discovery | Retain the documented formats and scope. Current-machine, project, cloud and remote discovery are distinct; an installed method does not grant tools or permissions. |
| Hook, hook discovery, automation trigger | Retain event-specific protocol and enforcement limitations. No universal interception or new OpenClaw typed-plugin adapter is claimed. |
| MCP | Retain documented transports and configuration. Configuration presence does not prove connectivity, authorization or successful tool execution. |
| Browser/web, shell, filesystem, apply_patch/edit | Retain current tool and mode limits. The active host inventory and authorized workspace still determine execution. |
| Sandbox, approval, permission mode | Retain OS, process and mode boundaries. Permissions, isolated execution and model instructions are separate controls. |
| Native choice, chat decision-card fallback, popup/approval UI, human confirmation trigger | Retain native behavioral evidence requirements. A question, text fallback or permission dialog does not prove the other surfaces; no unanswered choice becomes acceptance. |
| Background task | Retain mode-dependent support. Child start, termination, result delivery and actual acceptance remain distinct events. |
| Memory, graph, project/global rule file | Retain the existing context and partial/unknown boundaries. Persistent instructions do not establish authorization enforcement or an installed graph capability. |
| Project/global install, dependency discovery | Retain repository-level implementation claims after source hash checks; host execution remains subject to its existing acceptance gate. |

### Claude Code

Read on 2026-11-10 UTC:

- [Subagents](https://code.claude.com/docs/en/sub-agents): separate contexts, custom definitions, tool/permission restrictions and completion behavior remain documented.
- [Tools](https://code.claude.com/docs/en/tools-reference): file, shell, web and background surfaces remain documented. The ordinary question timeout does not auto-resolve permission or plan approvals.
- [Hooks](https://code.claude.com/docs/en/hooks): PreToolUse denial uses the event-specific `hookSpecificOutput.permissionDecision` contract. Other events have their own output semantics.
- [Sandbox](https://code.claude.com/docs/en/sandboxing): the Bash sandbox supports macOS, Linux and WSL2. Native Windows commands remain unsandboxed; file tools, MCP servers and hooks are outside this Bash sandbox.
- [Permission modes](https://code.claude.com/docs/en/permission-modes): approval behavior depends on the chosen mode and administrative policy; it is not a universal automatic permission grant.
- [Skills and legacy commands](https://code.claude.com/docs/en/slash-commands): local/project Skill directories and legacy commands remain documented; local personal Skills do not automatically exist in every cloud session.
- [MCP](https://code.claude.com/docs/en/mcp): stdio and remote servers have distinct connection and approval scopes.
- [Memory](https://code.claude.com/docs/en/memory): CLAUDE.md and rules supply context; the documentation explicitly distinguishes them from enforced client settings.

Repository check: `canonical/runtime-assets/claude`, `scripts/runtime-hook-mapping.mjs`, `setup.mjs`, and the shared choice/core-loop contracts. The current denial payload matches the documented PreToolUse shape. No new native Claude session was run for this review. Windows sandbox, background/choice and other partial boundaries remain unchanged.

### Codex

Read on 2026-11-10 UTC:

- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): TOML definitions under `.codex/agents/` remain documented. `agents.max_threads` remains a legacy alias for the newer concurrency key; explicit host configuration still governs available capacity.
- [Skills](https://learn.chatgpt.com/docs/build-skills): name/description discovery precedes full SKILL.md loading; supporting scripts, references and assets are separate resources.
- [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli): local command/args and remote connection fields remain documented; configured availability is not successful invocation.
- [Hooks](https://learn.chatgpt.com/docs/hooks): supported local tool paths can be denied, but hosted tools and some specialized paths are outside that coverage. Unsupported PreToolUse output fields can make a hook fail while the tool continues, so Claude-shaped output cannot be assumed universally valid.
- [Configuration](https://learn.chatgpt.com/docs/config-file/config-reference): sandbox/approval keys and mode-specific restrictions remain explicit.
- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md): global/project precedence and overrides remain documented; instructions are not a substitute for actual permission policy.
- [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli): built-in command, permission and sandbox controls remain host-owned.

Repository check: `canonical/runtime-assets/codex`, the shared enforcement implementation, `scripts/runtime-hook-mapping.mjs`, `setup.mjs`, `AGENTS.md`, and choice/core-loop contracts. The denial path emits the supported event-specific fields; the concurrency example retains a documented alias. No CLI version check or this maintenance conversation is converted into capability-specific native acceptance. Current choice requirements, hook coverage and all `not_run` states remain unchanged.

### OpenClaw

Read on 2026-11-10 UTC:

- [Ask user](https://docs.openclaw.ai/tools/ask-user): availability depends on the session and channel. Plain-text fallback and question answers do not grant additional permission.
- [Exec approvals](https://docs.openclaw.ai/tools/exec-approvals): caller/target policy, allowlists and approval fallback remain separate from isolation. Legacy and current policy forms must not be combined arbitrarily.
- [Plugin permission requests](https://docs.openclaw.ai/plugins/plugin-permission-requests): typed `before_tool_call` plugin hooks can request approval; this does not replace host exec or native Codex approval.
- [Subagents](https://docs.openclaw.ai/tools/subagents): separate sessions, completion delivery and tool restrictions remain documented. The page now links to focused references for detailed parameters and recovery; a successful start is not a completed result.
- [MCP](https://docs.openclaw.ai/cli/mcp): OpenClaw-as-server and its saved client registry remain distinct. Detailed transport pages are linked from the current index.
- [Permission modes](https://docs.openclaw.ai/tools/permission-modes): exec mode, Codex mapping and non-interactive ACPX permissions have distinct limits.
- [Hooks](https://docs.openclaw.ai/automation/hooks): internal event handlers and typed plugin hooks are separate systems. A listed/enabled hook does not itself prove that its handler ran.
- [Memory](https://docs.openclaw.ai/concepts/memory): workspace files and provenance rules govern persistent context.
- [Skills](https://docs.openclaw.ai/tools/skills): workspace/shared/managed source precedence and execution-workspace materialization remain explicit.
- [Slash commands](https://docs.openclaw.ai/tools/slash-commands): Gateway commands and harness-bound conversation text are distinct; command authorization still applies.
- [Tools](https://docs.openclaw.ai/tools): tool exposure depends on profile, policy, provider, sandbox, channel and plugin availability.
- [apply_patch](https://docs.openclaw.ai/tools/apply-patch): workspace, session and required-root restrictions remain relevant; the existence of the tool does not prove Meta_Kim has invoked it.

Repository check: `canonical/runtime-assets/openclaw`, `scripts/sync-runtimes.mjs`, `setup.mjs`, and choice/core-loop contracts. Meta_Kim still has the declared workspace/template integration and lifecycle bridge, not a newly installed typed-plugin enforcement adapter. Current OpenClaw docs contain evolving configuration names and split topic pages; this review does not certify the template against a live installed OpenClaw version. Existing partial/unknown and unprobed choice/apply-patch conclusions remain unchanged.

### Cursor

Read on 2026-11-10 UTC:

- [Subagents](https://cursor.com/docs/subagents) and [2.4 changelog](https://cursor.com/changelog/2-4): project/user custom agents and parallel work remain documented; the changelog also documents clarification questions outside Plan/Debug mode.
- [Skills](https://cursor.com/docs/skills): native/compatible directories, nested discovery and explicit invocation remain documented. Local Skills do not automatically propagate to cloud, SSH or self-hosted workers.
- [Hooks](https://cursor.com/docs/hooks): `preToolUse`, permission responses, exit-code denial and `failClosed` remain documented. Crash/timeout defaults and invalid-response handling must not be conflated.
- [CLI](https://cursor.com/docs/cli/using): Plan/Ask modes, command approval, resume and non-interactive write access remain distinct.
- [Cloud Agents](https://cursor.com/docs/cloud-agent) and [2.5 changelog](https://cursor.com/changelog/2-5): isolated remote environments and asynchronous subagents remain documented; cloud execution is not implied by local setup.
- [Rules](https://cursor.com/docs/rules): project `.mdc`, user/team rules and AGENTS.md provide persistent prompt context. This does not establish automatic conversation memory.
- [Sandbox implementation](https://cursor.com/blog/agent-sandboxing): platform-specific implementations and access controls support a documented host boundary, not a newly observed local enforcement result.
- [Agent tools](https://cursor.com/docs/agent/overview) and [MCP](https://cursor.com/docs/mcp): file/search/shell/web interfaces and local/remote MCP remain documented.

Repository check: `canonical/runtime-assets/cursor`, `scripts/runtime-hook-mapping.mjs`, `setup.mjs`, and choice/core-loop contracts. The current gate uses `preToolUse` with `failClosed: true` and the Cursor-specific denial shape. Cursor's product/live acceptance remains unaccepted in the matrix; memory remains partial. No native Cursor session was run.

## Renewal and validation

The existing `rollReviewFreshness` function behind the explicit `meta:runtime:evidence:roll-review` command was called with the actual UTC date and this review's rationale. It changed the 120 older row dates and four conservative-review dates; the recent Gemini/ZCode dates already matched and therefore did not change. Each row's existing rationale was retained. The four review summaries point to this record, while their existing repository source references remain unchanged.

The before/after structures were compared with only the authorized review metadata removed: all 180 capability rows retain their support, confidence, mode-specific acceptance and execution-eligibility fields. All 40 historical official-documentation observations, all six repository-projection observations and both recent Gemini/ZCode conservative observations remain unchanged. The capability validator returned zero issues before writing.

After renewal:

- `node scripts/check-runtime-evidence-review.mjs` returned `current`, `issueCount: 0`, `daysRemaining: 30`, exit 0.
- The six test files used by the Runtime evidence review workflow reported **50 tests: 49 passed, one Windows junction reproduction skipped on Linux, zero failed** (2.42 seconds). These cover review age, conservative evidence, source hashes, future dates, tampering, native-choice refusal, Cursor non-promotion, renewal and MCP resource boundaries.
- `git diff --check` passed. The JSON delta contains 120 review-date replacements and eight ledger-line replacements (four dates and four summaries); no production script, policy, freshness threshold or source pin changed.

The 30-day lifetime, seven-day reminder, stale/future-date refusal and requirement for substantive review are unchanged. A later review must check then-current evidence again; this document is not automatic renewal authority.
