---
description: Run the Meta_Kim meta-theory governance dispatcher
argument-hint: <request>
---

Use the machine-governed Meta_Kim entry for this request:

$ARGUMENTS

Default product runtime path:

When this command is installed globally, run the installed Meta_Kim package root directly:

```bash
node "__META_KIM_PACKAGE_ROOT__/scripts/run-meta-theory-governed-execution.mjs" --runtime claude_code --emit-conversation-notice "$ARGUMENTS"
```

If this command file has not been rendered by global sync and the placeholder is still present, fall back only when the current project is the Meta_Kim source checkout or provides the package script:

```bash
npm run meta:theory:run:notice -- --runtime claude_code "$ARGUMENTS"
```

Then reopen the report with:

```bash
node "__META_KIM_PACKAGE_ROOT__/scripts/run-meta-theory-governed-execution.mjs" --read latest
```

This command is not a prose-only reminder. For explicit `/meta-theory` requests,
project/repo understanding, architecture analysis, commercialization strategy,
market or competitor reasoning, governance review, release work, runtime work,
or any non-trivial durable task, run the machine entry above or state the exact
blocking reason.

Minimum route:

1. Classify the request with the Meta_Kim entry rules.
2. Run Fetch before Thinking. Project understanding must inspect local project
   evidence such as README, AGENTS, package scripts, canonical/config contracts,
   capability index, MCP/runtime configs, and Graphify navigation when present.
3. If the answer depends on current market, competitor, platform, provider,
   pricing, dependency, version, or official documentation facts, prove an
   available retrieval path or return blocked to Fetch.
4. Use the run artifact and report as the evidence surface. Do not replace the
   machine route with a short manual summary.

Two host-native phases are mandatory:

- **Phase 1 — route and handoff:** run the governed Node command only to
  produce route compatibility and a handoff state. `ready_for_host_handoff`
  means Claude Code must perform the next native action;
  `awaiting_native_choice` means it must call `AskUserQuestion`; `blocked`
  means it must stop. The runner never authorizes task execution.
- **Phase 2 — current-host action:** after any required `AskUserQuestion`
  answer, use the active Claude Code host's real `Agent` / Task, tools, and
  permission surface. Persistent acceptance records are advisory compatibility
  evidence only. No callback, environment value, or JSON can complete the
  native choice or authorize this task.

Claude Code execution rule:

**HOST-NATIVE FAN-OUT PREFERRED.** The main thread is the dispatcher, never
the execution worker. The governed runner produces route evidence,
`workerTaskPackets`, and `hostInvocationRequestPacket`; it does not by itself
prove live Claude Code `Agent` / Task execution. Use Claude Code's native
Agent/Task tool directly to fan out independent worker lanes — the runner
only records evidence, discovers capabilities, and suggests lanes; it does
not enforce dispatch.

- This `/meta-theory` invocation is explicit user authorization to use Claude
  Code Agent/Task delegation and parallel worker lanes when Thinking proves
  the lanes are independent and safe.
- Use the authoritative stage DAG plus native Agent/Task as the sufficient
  fan-out route. `agent-teams-playbook` is optional: select it only when it
  improves orchestration, record `not_required` for fewer than two ready lanes,
  and record `optional_adapter_not_selected` when native fan-out is sufficient.
  Resolve it from the first available skill root (`~/.claude/skills/agent-teams-playbook/SKILL.md`,
  `.claude/skills/agent-teams-playbook/SKILL.md`, `.agents/skills/agent-teams-playbook/SKILL.md`,
  or a configured dependency root). Treat it as a selected fan-out adapter
  unless a live Skill/Agent Team/Task call is attached.
- Then call the active Claude Code host's real `Agent` / Task surface for each
  selected execution worker lane. Every Agent/Task prompt must cite the
  corresponding `workerTaskPackets[].taskPacketId`, selected owner/role,
  output schema, write scope, collision boundary, verification owner, and
  expected evidence shape.
- Record the returned Agent/Task tool-call id, completion status, and
  worker-task-to-agent mapping as trusted host invocation evidence. If no
  callable Agent/Task surface is available, record the checked tool/capability
  names and blocked reason; do not silently continue as main-thread execution.

If the rendered package-root runner is unavailable and the current directory
does not provide the fallback package script, say that the machine entry is
unavailable and list the checked paths. Do not continue as if governed Fetch
happened.

## Prompt Acceptance

This command adapter binds `governance-orchestration`, `capability-discovery-and-retrieval`, `runtime-native-surfaces`, `execution-tools-and-commands`, and `verification-eval-and-release`. It is a runtime entry surface for the shared Meta_Kim dispatcher, not a second governance source.

## Required inputs

- User request from `$ARGUMENTS`.
- Rendered installed Meta_Kim package root, or a source-checkout current project directory with `package.json`.
- Available Claude Code command and shell capability.

## Pass

- The request is routed through the rendered package-root runner or the `meta:theory:run:notice` source-checkout fallback, or a precise blocked reason is returned.
- Fetch evidence is produced by the machine artifact before route claims.
- The report is reopened with `npm run meta:theory:report -- latest` or the returned runId when user-readable closure is needed.

## Fail

- The command gives a prose-only answer for non-trivial durable work.
- It claims governed Fetch happened without a run artifact or checked blocked path.
- It treats this runtime command file as the canonical source instead of the shared skill and contract.

## Block

Block when the rendered package-root runner and fallback package script are unavailable, shell execution is unavailable, or the request requires current external evidence but no retrieval path exists.

## Return to stage

Return to Fetch when local project evidence, Graphify, provider state, or current external facts are missing. Return to Thinking when capability discovery exists but no owner/loadout route is selected.

## Verification

Run `npm run meta:prompt:validate` after editing this command adapter. For live command behavior, verify the produced run artifact and report rather than this prompt text alone.

## Preserve

Preserve Claude Code native slash-command behavior, shell/tool permissions, MCP, hooks, skills, agents, memory, graph, and project rule files. This adapter may add governance routing but must not replace native runtime ability.
