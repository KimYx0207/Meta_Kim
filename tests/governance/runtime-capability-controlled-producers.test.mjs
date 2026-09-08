import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { codexLiveInvocationArgs, runCodexCompositeEngineeringProducer, runCodexDesktopEngineeringSessionProducer, runCodexDesktopSessionCapabilityProducer, runControlledRuntimeCapabilityProducer } from "../../scripts/runtime-capability-producers.mjs";
import { readCodexDesktopEngineeringEvidence, readCodexDesktopSessionEvidence } from "../../scripts/live-acceptance/read-codex-session-evidence.mjs";
import { loadEffectiveRuntimeCapabilityClaims } from "../../scripts/effective-runtime-capability-claims.mjs";
import { evaluateRouteExecutionGate } from "../../scripts/runtime-execution-gate.mjs";
import { controlledProducerStageFromVerification, selectVerificationBoundControlledAttempts, validateRuntimeCapabilityAcceptanceAttemptEvidence, writeRuntimeCapabilityAcceptanceAttempt } from "../../scripts/runtime-capability-acceptance.mjs";
import { parseRuntimeAcceptanceCliArgs } from "../../scripts/attest-runtime-capability-acceptance.mjs";
import { loadSetupBoundRuntimeExecutable, recordSetupRuntimeExecutableBindings } from "../../scripts/runtime-executable-binding.mjs";
import { observeClaudeJsonl } from "../../scripts/live-acceptance/observe-host-events.mjs";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function fixtureProject() {
  const root = mkdtempSync(path.join(tmpdir(), "meta-kim-controlled-producer-"));
  temporaryRoots.add(root);
  mkdirSync(path.join(root, ".meta-kim", "state", "default", "imports"), { recursive: true });
  return root;
}

const skillVisibilityProbeScript = `
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  let cursor = process.cwd();
  let ancestorSkill = false;
  while (true) {
    if (fs.existsSync(path.join(cursor, ".agents", "skills", "project-ancestor", "SKILL.md"))) {
      ancestorSkill = true;
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const homeSkill = fs.existsSync(path.join(os.homedir(), ".agents", "skills", "ambient-user", "SKILL.md"));
  const tempExists = fs.existsSync(process.env.TEMP || process.env.TMP || "");
  process.stdout.write(JSON.stringify({ home: os.homedir(), homeSkill, ancestorSkill, tempExists }));
`;

function runSkillVisibilityProbe(cwd, env) {
  const result = spawnSync(process.execPath, ["-e", skillVisibilityProbeScript], { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertHostHandoffOnly(gate, handoffStatus = "ready_for_host_handoff") {
  assert.equal(gate.handoffStatus, handoffStatus, gate.blockers.join("\n"));
  assert.equal(gate.executionAuthorized, false);
  assert.equal(gate.persistentAcceptanceAuthorizesExecution, false);
}

function jsonl(records) {
  return records.map((entry) => JSON.stringify(entry)).join("\n");
}

function codexDesktopFixture() {
  const codexHome = mkdtempSync(path.join(tmpdir(), "meta-kim-codex-desktop-"));
  temporaryRoots.add(codexHome);
  const sessions = path.join(codexHome, "sessions", "2026", "07", "28");
  mkdirSync(sessions, { recursive: true });
  const threadId = "11111111-1111-4111-8111-111111111111";
  const childSessionId = "22222222-2222-4222-8222-222222222222";
  const nonce = "33333333-3333-4333-8333-333333333333";
  const marker = `META_KIM_CAPABILITY_SUBAGENT_${nonce}`;
  const callId = "call_desktop_fixture";
  const now = new Date().toISOString();
  const parent = [
    { timestamp: now, type: "session_meta", payload: { id: threadId, originator: "Codex Desktop", source: "vscode", cli_version: "codex-desktop-test" } },
    { timestamp: now, type: "event_msg", payload: { type: "fixture_padding", value: "x".repeat(4 * 1024 * 1024) } },
    { timestamp: now, type: "response_item", payload: { type: "function_call", name: "spawn_agent", namespace: "collaboration", arguments: "{}", call_id: callId } },
    { timestamp: now, type: "event_msg", payload: { type: "sub_agent_activity", event_id: callId, agent_thread_id: childSessionId, agent_path: "/root/fixture_child", kind: "started" } },
    { timestamp: now, type: "response_item", payload: { type: "function_call_output", call_id: callId, output: JSON.stringify({ task_name: "/root/fixture_child" }) } },
    { timestamp: now, type: "response_item", payload: { type: "agent_message", id: "fixture-final", author: "/root/fixture_child", recipient: "/root", content: [{ type: "input_text", text: `Message Type: FINAL_ANSWER\nPayload:\n${marker}` }] } },
  ];
  const child = [
    { timestamp: now, type: "session_meta", payload: { id: childSessionId, originator: "Codex Desktop", source: { subagent: { thread_spawn: { parent_thread_id: threadId } } }, cli_version: "codex-desktop-test" } },
    { timestamp: now, type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: marker } },
    { timestamp: now, type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: marker }] } },
    { timestamp: now, type: "event_msg", payload: { type: "task_complete", last_agent_message: marker } },
  ];
  writeFileSync(path.join(sessions, `rollout-parent-${threadId}.jsonl`), `${jsonl(parent)}\n`, "utf8");
  writeFileSync(path.join(sessions, `rollout-child-${childSessionId}.jsonl`), `${jsonl(child)}\n`, "utf8");
  return { codexHome, threadId, childSessionId, marker, sinceMs: Date.now() - 5_000 };
}

function codexDesktopEngineeringFixture(projectRoot) {
  const codexHome = mkdtempSync(path.join(tmpdir(), "meta-kim-codex-desktop-engineering-"));
  temporaryRoots.add(codexHome);
  const sessions = path.join(codexHome, "sessions", "2026", "07", "28");
  mkdirSync(sessions, { recursive: true });
  const threadId = "66666666-6666-4666-8666-666666666666";
  const nonce = "77777777-7777-4777-8777-777777777777";
  const marker = `META_KIM_CAPABILITY_ENGINEERING_${nonce}`;
  const workspacePath = path.join(projectRoot, ".meta-kim", "state", "default", "runtime-capability-producers", "workspaces", `desktop-engineering-${nonce}`);
  const file = path.join(workspacePath, "meta-kim-probe.txt");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(file, `after-${marker}\n`, "utf8");
  const now = new Date().toISOString();
  const slashFile = file.replaceAll("\\", "/");
  const call = (id, input) => ({ timestamp: now, type: "response_item", payload: { type: "custom_tool_call", name: "exec", status: "completed", call_id: id, input } });
  const output = (id, text = "{}") => ({ timestamp: now, type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text }] } });
  const patchEnd = (type, change) => ({ timestamp: now, type: "event_msg", payload: { type: "patch_apply_end", success: true, status: "completed", stdout: `Success ${slashFile}`, changes: { [file]: { type, ...change } } } });
  const records = [
    { timestamp: now, type: "session_meta", payload: { id: threadId, originator: "Codex Desktop", source: "vscode", cli_version: "codex-desktop-engineering-test" } },
    call("desktop-shell", `const r=await tools.shell_command({command:"New-Item -ItemType Directory -Path '${workspacePath}'"});`),
    output("desktop-shell", `Exit code: 0\n${workspacePath}`),
    call("desktop-add", `const patch="*** Begin Patch\\n*** Add File: ${slashFile}\\n+before-${marker}\\n*** End Patch"; text(await tools.apply_patch(patch));`),
    patchEnd("add", { content: `before-${marker}\n` }),
    output("desktop-add"),
    call("desktop-read-before", `const r=await tools.shell_command({command:"Get-Content -LiteralPath '${file}'"});`),
    output("desktop-read-before", `Exit code: 0\nbefore-${marker}`),
    call("desktop-update", `const patch="*** Begin Patch\\n*** Update File: ${slashFile}\\n@@\\n-before-${marker}\\n+after-${marker}\\n*** End Patch"; text(await tools.apply_patch(patch));`),
    patchEnd("update", { unified_diff: `@@ -1 +1 @@\n-before-${marker}\n+after-${marker}\n` }),
    output("desktop-update"),
    call("desktop-read-after", `const r=await tools.shell_command({command:"Get-Content -LiteralPath '${file}'"});`),
    output("desktop-read-after", `Exit code: 0\nafter-${marker}`),
  ];
  writeFileSync(path.join(sessions, `rollout-desktop-${threadId}.jsonl`), `${jsonl(records)}\n`, "utf8");
  return { codexHome, threadId, marker, workspacePath, sinceMs: Date.now() - 5_000 };
}

function injectedExecutor(request) {
  if (request.runtime === "claude_code") {
    const settingSourcesIndex = request.args.indexOf("--setting-sources");
    assert.equal(request.args[settingSourcesIndex + 1], "");
    assert.ok(request.args.includes("--strict-mcp-config"));
    const mcpConfigIndex = request.args.indexOf("--mcp-config");
    const mcpConfigPath = request.args[mcpConfigIndex + 1];
    assert.equal(path.dirname(mcpConfigPath), request.workspace);
    assert.deepEqual(JSON.parse(readFileSync(mcpConfigPath, "utf8")), { mcpServers: {} });
    const expectedTool = request.capability === "shell"
      ? "Bash,PowerShell"
      : request.capability === "filesystem"
        ? "Read"
        : request.capability === "apply_patch / edit"
          ? "Read,Edit"
          : "Agent,Task";
    // Claude Code 2.1.236 resolves `--tools <name>` to an EMPTY tool set
    // (verified live: init event tools:[] with the flag, full tool list
    // without it), which made every probe model report "no shell tool
    // available". The probe must therefore rely on `--allowedTools` for the
    // permission grant and never pass `--tools`.
    assert.equal(request.args.includes("--tools"), false);
    const allowedToolsIndex = request.args.indexOf("--allowedTools");
    assert.equal(request.args[allowedToolsIndex + 1], expectedTool);
    if (request.capability === "apply_patch / edit") {
      assert.equal(request.args[allowedToolsIndex + 1], "Read,Edit");
      assert.doesNotMatch(request.args[allowedToolsIndex + 1], /Write/u);
      assert.match(request.prompt, /First call the native Read tool/u);
      assert.match(request.prompt, /Then call the native Edit tool exactly once/u);
      assert.match(request.prompt, /old_string exactly before-META_KIM_CAPABILITY_APPLY_PATCH_EDIT_/u);
      assert.match(request.prompt, /new_string exactly after-META_KIM_CAPABILITY_APPLY_PATCH_EDIT_/u);
      assert.match(request.prompt, /Do not call Write or any other write tool\./u);
      assert.match(request.prompt, /must contain exactly one line, after-META_KIM_CAPABILITY_APPLY_PATCH_EDIT_/u);
      assert.match(request.prompt, /Do not keep the before marker and do not add any other text\./u);
    }
  }
  if (request.runtime === "codex" && request.capability === "apply_patch / edit") {
    assert.match(request.prompt, /native edit\/apply-patch capability/u);
    assert.doesNotMatch(request.prompt, /native Edit tool exactly once/u);
    assert.doesNotMatch(request.prompt, /old_string|new_string/u);
    assert.doesNotMatch(request.prompt, /Do not call Write/u);
  }
  if (request.runtime === "codex" && ["agent", "subagent"].includes(request.capability)) {
    const normalizedPrompt = request.prompt.toLowerCase();
    const spawnInstruction = request.prompt.split(/[.!?]/u).find((sentence) =>
      sentence.includes("spawn_agent") && /exactly once/iu.test(sentence)
    );
    const spawnIndex = normalizedPrompt.indexOf("spawn_agent");
    const returnedChildMatch = /spawn_agent\s+(?:returns?|returned)\s+(?:a\s+)?child/iu.exec(request.prompt.slice(spawnIndex + 1));
    const returnedChildIndex = returnedChildMatch ? spawnIndex + 1 + returnedChildMatch.index : -1;
    const waitIndex = normalizedPrompt.indexOf("wait", returnedChildIndex + 1);
    const completedIndex = normalizedPrompt.indexOf("completed", waitIndex + 1);
    assert.ok(spawnInstruction, `${request.capability} must call native spawn_agent exactly once`);
    assert.ok(returnedChildIndex > spawnIndex, `${request.capability} must bind the child returned by spawn_agent`);
    assert.ok(waitIndex > returnedChildIndex, `${request.capability} must wait only after receiving the child`);
    assert.ok(completedIndex > waitIndex, `${request.capability} must wait until the child is completed`);
    const prohibitions = request.prompt.split(/[.!?]/u).map((sentence) => sentence.toLowerCase());
    assert.ok(
      prohibitions.some((sentence) => /never|do not/u.test(sentence) && sentence.includes("wait") && sentence.includes("before") && sentence.includes("spawn_agent")),
      `${request.capability} must forbid wait-before-spawn`,
    );
    assert.ok(
      prohibitions.some((sentence) => sentence.includes("do not") && sentence.includes("text") && /pretend|simulate|imitate|substitute|replace|claim/u.test(sentence)),
      `${request.capability} must forbid textual imitation of the native tool lifecycle`,
    );
  }
  if (request.runtime === "claude_code" && request.capability === "agent") {
    assert.match(request.prompt, /Use the runtime's native agent\/subagent tool exactly once and wait for its successful completion\./u);
    assert.match(request.prompt, /Require the child to return exactly the complete capability marker .* as its entire final response; the nonce alone is not sufficient\./u);
    assert.doesNotMatch(request.prompt, /spawn_agent|wait-before-spawn|returned child/u);
  }
  if (request.runtime === "claude_code" && request.capability === "subagent") {
    assert.match(request.prompt, /Spawn exactly one native child subagent and wait for its successful completion\./u);
    assert.match(request.prompt, /Require the child to return exactly the complete capability marker .* as its entire final response; the nonce alone is not sufficient\./u);
    assert.doesNotMatch(request.prompt, /spawn_agent|wait-before-spawn|returned child/u);
  }
  const nonce = request.prompt.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu)?.[0];
  const marker = request.prompt.match(/META_KIM_CAPABILITY_[A-Z0-9_]+_[0-9a-f-]{36}/u)?.[0];
  if (request.capability === "shell") writeFileSync(path.join(request.workspace, "meta-kim-probe.txt"), `shell-${marker}\n`, "utf8");
  if (request.capability === "apply_patch / edit") writeFileSync(path.join(request.workspace, "meta-kim-probe.txt"), `after-${marker}\n`, "utf8");
  let stdout;
  if (request.runtime === "codex") {
    const item = request.capability === "agent" || request.capability === "subagent"
      ? { id: `agent-${nonce}`, type: "collab_tool_call", tool: "spawn_agent", message: marker, receiver_thread_id: `child-${nonce}` }
      : request.capability === "apply_patch / edit"
        ? { id: `edit-${nonce}`, type: "file_change" }
        : { id: `tool-${nonce}`, type: "command_execution", command: request.capability === "filesystem" ? `Get-Content meta-kim-probe.txt # ${marker}` : `bounded-probe ${marker}` };
    stdout = jsonl([
      { type: "thread.started", thread_id: `thread-${nonce}` },
      { type: "item.started", item: { ...item, status: "in_progress" } },
      { type: "item.completed", item: { ...item, status: "completed", ...(item.type === "command_execution" ? { exit_code: 0, aggregated_output: marker } : { result: marker }) } },
    ]);
  } else {
    const name = request.capability === "agent" || request.capability === "subagent"
      ? "Agent"
      : request.capability === "shell"
        ? "Bash"
        : request.capability === "filesystem"
          ? "Read"
          : "Edit";
    const id = `${name}-${nonce}`;
    stdout = jsonl([
      { type: "assistant", session_id: `session-${nonce}`, message: { id: `message-${nonce}`, content: [{ type: "tool_use", id, name, input: { path: "meta-kim-probe.txt", marker } }] } },
      { type: "user", session_id: `session-${nonce}`, tool_use_result: name === "Agent" ? { agentId: `child-${nonce}` } : {}, message: { content: [{ type: "tool_result", tool_use_id: id, content: marker }] } },
    ]);
  }
  return { status: 0, signal: null, stdout, stderr: "", runtimeVersion: `${request.runtime}-test-1.0.0` };
}

function injectedClaudeAsyncAgentExecutor({
  launchOnly = false,
  includeTaskUpdated = true,
  includeTaskNotification = true,
  mismatchedAgentId = false,
  mismatchedMarker = false,
  laterMismatchedMarker = false,
  failedUpdateBeforeCompleted = false,
  failedNotificationBeforeCompleted = false,
  duplicateCall = false,
  duplicateResult = false,
} = {}) {
  return (request) => {
    assert.equal(request.runtime, "claude_code");
    assert.ok(["agent", "subagent"].includes(request.capability));
    const nonce = request.prompt.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu)?.[0];
    const marker = request.prompt.match(/META_KIM_CAPABILITY_[A-Z0-9_]+_[0-9a-f-]{36}/u)?.[0];
    assert.match(request.prompt, /entire final response; the nonce alone is not sufficient/u);
    const callId = `async-call-${nonce}`;
    const agentId = `async-agent-${nonce}`;
    const sessionId = `async-session-${nonce}`;
    const records = [
      { type: "assistant", session_id: sessionId, message: { id: `async-message-${nonce}`, content: [{ type: "tool_use", id: callId, name: "Agent", input: { prompt: marker } }] } },
      { type: "system", subtype: "task_started", task_id: agentId, tool_use_id: callId, session_id: sessionId },
      { type: "user", session_id: sessionId, tool_use_result: { isAsync: true, status: "async_launched", agentId: mismatchedAgentId ? `wrong-${agentId}` : agentId }, message: { content: [{ type: "tool_result", tool_use_id: callId, content: "Async agent launched successfully." }] } },
    ];
    if (duplicateCall) records.splice(1, 0, structuredClone(records[0]));
    if (duplicateResult) records.push(structuredClone(records.at(-1)));
    if (!launchOnly) {
      records.push({ type: "assistant", parent_tool_use_id: callId, session_id: sessionId, message: { id: `async-result-${nonce}`, stop_reason: null, content: [{ type: "text", text: mismatchedMarker ? `WRONG_${nonce}` : marker }] } });
      if (laterMismatchedMarker) {
        records.push({ type: "assistant", parent_tool_use_id: callId, session_id: sessionId, message: { id: `async-later-result-${nonce}`, stop_reason: null, content: [{ type: "text", text: `WRONG_LATER_${nonce}` }] } });
      }
      if (failedUpdateBeforeCompleted) {
        records.push({ type: "system", subtype: "task_updated", task_id: agentId, patch: { status: "failed" }, session_id: sessionId });
      }
      if (includeTaskUpdated) {
        records.push({ type: "system", subtype: "task_updated", task_id: agentId, patch: { status: "completed" }, session_id: sessionId });
      }
      if (failedNotificationBeforeCompleted) {
        records.push({ type: "system", subtype: "task_notification", task_id: agentId, tool_use_id: callId, status: "failed", session_id: sessionId });
      }
      if (includeTaskNotification) {
        records.push({ type: "system", subtype: "task_notification", task_id: agentId, tool_use_id: callId, status: "completed", summary: marker, session_id: sessionId });
      }
    }
    return { status: 0, signal: null, stdout: jsonl(records), stderr: "", runtimeVersion: "claude-code-2.1.202" };
  };
}

function injectedClaudeCompletedEnvelopeExecutor({ nestedWrong = false, failedLifecycle = false } = {}) {
  return (request) => {
    assert.equal(request.runtime, "claude_code");
    assert.ok(["agent", "subagent"].includes(request.capability));
    const nonce = request.prompt.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu)?.[0];
    const marker = request.prompt.match(/META_KIM_CAPABILITY_[A-Z0-9_]+_[0-9a-f-]{36}/u)?.[0];
    const callId = `completed-call-${nonce}`;
    const agentId = `completed-agent-${nonce}`;
    const sessionId = `completed-session-${nonce}`;
    const records = [
      { type: "assistant", session_id: sessionId, message: { id: `completed-message-${nonce}`, content: [{ type: "tool_use", id: callId, name: "Agent", input: { prompt: marker, run_in_background: false } }] } },
      { type: "system", subtype: "task_started", task_id: agentId, tool_use_id: callId, session_id: sessionId },
    ];
    if (failedLifecycle) {
      records.push({ type: "system", subtype: "task_updated", task_id: agentId, patch: { status: "failed" }, session_id: sessionId });
    }
    records.push(
      { type: "system", subtype: "task_updated", task_id: agentId, patch: { status: "completed" }, session_id: sessionId },
      { type: "system", subtype: "task_notification", task_id: agentId, tool_use_id: callId, status: "completed", session_id: sessionId },
      {
        type: "user",
        session_id: sessionId,
        tool_use_result: {
          status: "completed",
          agentId,
          content: [{ type: "text", text: nestedWrong ? `WRONG_${nonce}` : marker }],
        },
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: callId,
            content: [
              { type: "text", text: marker },
              { type: "text", text: `agentId: ${agentId}\n<usage>subagent_tokens: 123</usage>` },
            ],
          }],
        },
      },
    );
    return { status: 0, signal: null, stdout: jsonl(records), stderr: "", runtimeVersion: "claude-code-2.1.202" };
  };
}

function injectedCodexEngineeringExecutor(request) {
  assert.equal(request.runtime, "codex");
  assert.equal(request.capability, "engineering_composite");
  const marker = request.prompt.match(/META_KIM_CAPABILITY_ENGINEERING_[0-9a-f-]{36}/u)?.[0];
  writeFileSync(path.join(request.workspace, "meta-kim-engineering-probe.txt"), `after-${marker}\n`, "utf8");
  const records = [{ type: "thread.started", thread_id: "engineering-thread" }];
  const addCommand = (id, command, output) => {
    records.push({ type: "item.started", item: { id, type: "command_execution", command, status: "in_progress" } });
    records.push({ type: "item.completed", item: { id, type: "command_execution", command, status: "completed", exit_code: 0, aggregated_output: output } });
  };
  addCommand("engineering-write", `Set-Content -LiteralPath meta-kim-engineering-probe.txt -Value 'before-${marker}' -NoNewline`, `wrote before-${marker}`);
  addCommand("engineering-read-before", "Get-Content -LiteralPath meta-kim-engineering-probe.txt", `before-${marker}\r\n`);
  const engineeringFile = path.join(request.workspace, "meta-kim-engineering-probe.txt");
  records.push({ type: "item.started", item: { id: "engineering-edit", type: "file_change", status: "in_progress", changes: [{ path: engineeringFile, kind: "update" }] } });
  records.push({ type: "item.completed", item: { id: "engineering-edit", type: "file_change", status: "completed", changes: [{ path: engineeringFile, kind: "update" }] } });
  addCommand("engineering-read-after", "Get-Content -LiteralPath meta-kim-engineering-probe.txt", `after-${marker}\n\r\n`);
  return { status: 0, signal: null, stdout: `${jsonl(records)}\n`, stderr: "", runtimeVersion: "codex-engineering-test" };
}

function injectedCodexEngineeringRuntimeShapeExecutor(request, changePaths = [path.join(request.workspace, "meta-kim-engineering-probe.txt")], { finalTrailingNewline = true, nonRawReadOutput = false } = {}) {
  assert.equal(request.runtime, "codex");
  assert.equal(request.capability, "engineering_composite");
  const marker = request.prompt.match(/META_KIM_CAPABILITY_ENGINEERING_[0-9a-f-]{36}/u)?.[0];
  const file = path.join(request.workspace, "meta-kim-engineering-probe.txt");
  writeFileSync(file, `after-${marker}${finalTrailingNewline ? "\n" : ""}`, "utf8");
  const records = [{ type: "thread.started", thread_id: "engineering-runtime-shape-thread" }];
  const addCommand = (id, command, output) => {
    records.push({ type: "item.started", item: { id, type: "command_execution", command, status: "in_progress" } });
    records.push({ type: "item.completed", item: { id, type: "command_execution", command, status: "completed", exit_code: 0, aggregated_output: output } });
  };
  addCommand("runtime-shape-write", `[System.IO.File]::WriteAllText('meta-kim-engineering-probe.txt', 'before-${marker}')`, "");
  addCommand("runtime-shape-read-before", nonRawReadOutput ? "Get-Content -LiteralPath '.\\meta-kim-engineering-probe.txt'" : "Get-Content -Raw -LiteralPath '.\\meta-kim-engineering-probe.txt'", `before-${marker}\r\n`);
  records.push(
    { type: "item.started", item: { id: "runtime-shape-edit", type: "file_change", changes: changePaths.map((changePath) => ({ path: changePath, kind: "update" })), status: "in_progress" } },
    { type: "item.completed", item: { id: "runtime-shape-edit", type: "file_change", changes: changePaths.map((changePath) => ({ path: changePath, kind: "update" })), status: "completed" } },
  );
  addCommand("runtime-shape-read-after", nonRawReadOutput ? "Get-Content -LiteralPath '.\\meta-kim-engineering-probe.txt'" : "Get-Content -Raw -LiteralPath '.\\meta-kim-engineering-probe.txt'", nonRawReadOutput ? `after-${marker}\r\n` : `after-${marker}\n\r\n`);
  return { status: 0, signal: null, stdout: `${jsonl(records)}\n`, stderr: "", runtimeVersion: "codex-engineering-runtime-shape-test" };
}

test("controlled receipts stay advisory while compatible routes hand off to the current host", () => {
  for (const runtime of ["claude_code", "codex"]) {
    const projectRoot = fixtureProject();
    for (const capability of ["agent", "subagent", "shell", "filesystem", "apply_patch / edit"]) {
      runControlledRuntimeCapabilityProducer({ projectRoot, runtime, capability, executor: injectedExecutor });
    }
    const production = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot });
    assert.equal(production.overlayStatus.applied.length, 0);
    assert.match(production.issues.join("\n"), /test-only producer receipt/u);
    const testAware = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot, allowTestReceipts: true });
    assert.ok(testAware.overlayStatus.applied.every((entry) => entry.evidenceClass === "advisory_persisted_observation" && entry.executionAuthority === false));
    assertHostHandoffOnly(evaluateRouteExecutionGate({ runtime, taskShape: "product_build", effectiveMatrix: testAware.effectiveMatrix }));
    assertHostHandoffOnly(evaluateRouteExecutionGate({ runtime, taskShape: "engineering_execution", effectiveMatrix: testAware.effectiveMatrix }));
  }
});

test("controlled producer binds Claude to the fail-closed provider resolver while retaining runtime isolation", () => {
  const source = readFileSync(path.join(packageRoot, "scripts", "runtime-capability-producers.mjs"), "utf8");
  const promptBuilder = source.slice(
    source.indexOf("function promptFor("),
    source.indexOf("function commandFor("),
  );
  const commandBuilder = source.slice(
    source.indexOf("function commandFor("),
    source.indexOf("function productionExecutor("),
  );
  const producerExecutor = source.slice(
    source.indexOf("function productionExecutor(request)"),
    source.indexOf("function eventMatches("),
  );
  const runtimeIsolationHelper = source.slice(
    source.indexOf("export function withRuntimeIsolation("),
    source.indexOf("function productionExecutor(request)"),
  );

  assert.match(source, /import \{ resolveClaudeLiveProviderEnvironmentSync \} from "\.\/claude-live-provider-env\.mjs";/u);
  assert.match(promptBuilder, /if \(runtime === "claude_code"\)/u);
  assert.match(promptBuilder, /native Edit tool exactly once/u);
  assert.match(promptBuilder, /Do not call Write or any other write tool/u);
  assert.match(promptBuilder, /native edit\/apply-patch capability/u);
  assert.match(producerExecutor, /withRuntimeIsolation\(request, \(\{ env \}\) =>/u);
  assert.match(runtimeIsolationHelper, /if \(request\.runtime === "claude_code"\) \{\s*env = resolveClaudeLiveProviderEnvironmentSync\(\);/u);
  assert.match(producerExecutor, /runCli\(request\.command, request\.args, \{\s*cwd: request\.workspace,\s*env,/u);
  assert.match(producerExecutor, /runtimeIsolation: request\.runtime === "codex" \? "ephemeral_auth_home_and_rules_isolated" : "empty_setting_sources_strict_mcp_current_auth"/u);
  assert.match(commandBuilder, /"--setting-sources",\s*"",/u);
  assert.match(commandBuilder, /"--strict-mcp-config",/u);
  assert.match(commandBuilder, /"--mcp-config", path\.join\(workspace, "meta-kim-empty-mcp\.json"\),/u);

  assert.match(runtimeIsolationHelper, /isolatedRuntimeHome = mkdtemp\(path\.join\(tempRoot, "meta-kim-codex-probe-"\)\)/u);
  assert.match(runtimeIsolationHelper, /const authSource = path\.join\(sourceRuntimeHome, "auth\.json"\);/u);
  assert.match(runtimeIsolationHelper, /copyFile\(authSource, authTarget\);/u);
  assert.match(runtimeIsolationHelper, /env = isolatedCodexChildEnvironment\(inheritedEnv, isolatedRuntimeHome, \{ mkdir \}\);/u);
  assert.match(source, /function isolatedCodexChildEnvironment\(inheritedEnv, isolatedRuntimeHome, \{ mkdir = mkdirSync \} = \{\}\)/u);
  assert.match(runtimeIsolationHelper, /finally \{\s*if \(isolatedRuntimeHome\) cleanupIsolatedCodexRuntimeHome/u);
});

test("controlled native probes do not load unrelated host skills or project instructions", () => {
  const args = codexLiveInvocationArgs({ workspace: '/isolated/probe', platform: 'win32' });
  assert.equal(args[args.indexOf('--enable') + 1], 'skip_host_skill_discovery');
  assert.ok(args.includes('project_doc_max_bytes=0'));
  assert.equal(args[args.indexOf('-s') + 1], 'workspace-write');
  assert.ok(args.includes('--ignore-rules'));
});

test("Codex isolated child replaces inherited user-home discovery roots", async () => {
  const { withRuntimeIsolation } = await import("../../scripts/runtime-capability-producers.mjs");
  const inheritedEnv = {
    ...process.env,
    HOME: "C:/ambient-user",
    Home: "C:/stale-case-variant",
    USERPROFILE: "C:/ambient-user",
    UserProfile: "C:/stale-case-variant",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\Kim",
    APPDATA: "C:/ambient-user/AppData/Roaming",
    AppData: "C:/stale-case-variant/AppData/Roaming",
    LOCALAPPDATA: "C:/ambient-user/AppData/Local",
    LocalAppData: "C:/stale-case-variant/AppData/Local",
    TEMP: "C:/ambient-user/AppData/Local/Temp",
    Temp: "C:/stale-case-variant/Temp",
    TMP: "C:/ambient-user/AppData/Local/Temp",
    Tmp: "C:/stale-case-variant/Temp",
  };
  const isolatedHome = "C:/synthetic/meta-kim-codex-probe-isolated";
  let observed;
  const createdDirectories = [];
  withRuntimeIsolation({ runtime: "codex" }, ({ env, isolatedRuntimeHome }) => {
    observed = { env, isolatedRuntimeHome };
  }, {
    tempRoot: "C:/synthetic",
    sourceRuntimeHome: "C:/synthetic/source-codex",
    inheritedEnv,
    mkdtemp: () => isolatedHome,
    mkdir: (target) => { createdDirectories.push(target); },
    exists: () => true,
    copyFile: () => {},
    remove: () => {},
  });
  assert.equal(observed.env.HOME, isolatedHome);
  assert.equal(observed.env.USERPROFILE, isolatedHome);
  assert.equal(observed.env.APPDATA, path.join(isolatedHome, "AppData", "Roaming"));
  assert.equal(observed.env.LOCALAPPDATA, path.join(isolatedHome, "AppData", "Local"));
  assert.equal(observed.env.CODEX_HOME, isolatedHome);
  assert.equal(observed.env.HOMEDRIVE, "C:");
  assert.equal(observed.env.HOMEPATH, path.win32.normalize(isolatedHome).slice(2));
  assert.deepEqual(createdDirectories, [path.join(isolatedHome, "tmp")]);
  assert.notEqual(observed.env.HOME, inheritedEnv.HOME);
  assert.notEqual(observed.env.USERPROFILE, inheritedEnv.USERPROFILE);
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    assert.deepEqual(Object.keys(observed.env).filter((key) => key.toLowerCase() === name.toLowerCase()), [name], `${name} must have one canonical child key`);
  }
});

test("Codex isolated child cannot discover ambient user skills", async () => {
  const { withRuntimeIsolation } = await import("../../scripts/runtime-capability-producers.mjs");
  const ambientHome = mkdtempSync(path.join(tmpdir(), "meta-kim-ambient-home-"));
  const sourceHome = mkdtempSync(path.join(tmpdir(), "meta-kim-source-home-"));
  const childWorkspace = mkdtempSync(path.join(tmpdir(), "meta-kim-codex-child-workspace-"));
  temporaryRoots.add(ambientHome);
  temporaryRoots.add(sourceHome);
  temporaryRoots.add(childWorkspace);
  mkdirSync(path.join(ambientHome, ".agents", "skills", "ambient-user"), { recursive: true });
  writeFileSync(path.join(ambientHome, ".agents", "skills", "ambient-user", "SKILL.md"), "ambient sentinel\n", "utf8");
  writeFileSync(path.join(sourceHome, "auth.json"), "{}\n", "utf8");
  const inheritedEnv = { ...process.env, HOME: ambientHome, USERPROFILE: ambientHome };
  let observed;
  withRuntimeIsolation({ runtime: "codex" }, ({ env, isolatedRuntimeHome }) => {
    observed = { isolatedRuntimeHome, visibility: runSkillVisibilityProbe(childWorkspace, env) };
  }, { sourceRuntimeHome: sourceHome, inheritedEnv });
  assert.equal(observed.visibility.home, observed.isolatedRuntimeHome);
  assert.equal(observed.visibility.homeSkill, false);
  assert.equal(observed.visibility.ancestorSkill, false);
  assert.equal(observed.visibility.tempExists, true);
});

test("Codex child home variables derive from Windows root or clear stale POSIX values", async () => {
  const { withRuntimeIsolation } = await import("../../scripts/runtime-capability-producers.mjs");
  for (const scenario of [
    { home: "\\\\server\\share\\meta-kim", drive: "\\\\server\\share", homePath: "\\meta-kim" },
    { home: "/tmp/meta-kim-posix", drive: undefined, homePath: undefined },
  ]) {
    let observed;
    withRuntimeIsolation({ runtime: "codex" }, ({ env }) => { observed = env; }, {
      tempRoot: "C:/synthetic",
      sourceRuntimeHome: "C:/synthetic/source-codex",
      inheritedEnv: { ...process.env, HOMEDRIVE: "C:", HOMEPATH: "\\Users\\Kim" },
      mkdtemp: () => scenario.home,
      mkdir: () => {},
      exists: () => true,
      copyFile: () => {},
      remove: () => {},
    });
    assert.equal(observed.HOMEDRIVE, scenario.drive);
    assert.equal(observed.HOMEPATH, scenario.homePath);
  }
});

test("Codex controlled engineering workspace is outside the project ancestor discovery tree", () => {
  const projectRoot = fixtureProject();
  mkdirSync(path.join(projectRoot, ".agents", "skills", "project-ancestor"), { recursive: true });
  writeFileSync(path.join(projectRoot, ".agents", "skills", "project-ancestor", "SKILL.md"), "project sentinel\n", "utf8");
  const emptyHome = mkdtempSync(path.join(tmpdir(), "meta-kim-empty-home-"));
  temporaryRoots.add(emptyHome);
  let visibility;
  let capturedRequest;
  runCodexCompositeEngineeringProducer({
    projectRoot,
    executor: (request) => {
      capturedRequest = request;
      visibility = runSkillVisibilityProbe(request.workspace, { ...process.env, HOME: emptyHome, USERPROFILE: emptyHome });
      return injectedCodexEngineeringExecutor(request);
    },
  });
  const relative = path.relative(projectRoot, capturedRequest.workspace);
  assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`), `workspace remained under project root: ${relative}`);
  assert.equal(visibility.ancestorSkill, false);
});

test("Codex setup failures clean the temporary home without reading real authentication", async () => {
  const { withRuntimeIsolation } = await import("../../scripts/runtime-capability-producers.mjs");
  assert.equal(typeof withRuntimeIsolation, "function");
  for (const scenario of [
    {
      name: "missing auth",
      exists: () => false,
      copyFile: () => { throw new Error("copy must not run when auth is absent"); },
      expected: /auth\.json is required/u,
    },
    {
      name: "auth copy failure",
      exists: () => true,
      copyFile: () => { throw new Error("synthetic auth copy failure"); },
      expected: /synthetic auth copy failure/u,
    },
  ]) {
    const temporaryHome = `C:/synthetic/meta-kim-codex-probe-${scenario.name.replaceAll(" ", "-")}`;
    const removed = [];
    assert.throws(() => withRuntimeIsolation({ runtime: "codex" }, () => {
      throw new Error("callback must not run after auth setup failure");
    }, {
      tempRoot: "C:/synthetic",
      sourceRuntimeHome: "C:/synthetic/source-codex",
      mkdtemp: () => temporaryHome,
      exists: scenario.exists,
      copyFile: scenario.copyFile,
      remove: (target) => { removed.push(target); },
    }), scenario.expected, scenario.name);
    assert.deepEqual(removed, [temporaryHome], scenario.name);
  }
});

test("failed child invocation diagnostics retain safe exit, signal, and error code", async () => {
  const { runtimeHostInvocationError } = await import("../../scripts/runtime-capability-producers.mjs");
  const error = runtimeHostInvocationError("codex", "version probe", {
    status: null,
    signal: "SIGTERM",
    error: { code: "ENOENT", message: "secret environment should not escape" },
  });
  assert.equal(error.exitCode, null);
  assert.equal(error.signal, "SIGTERM");
  assert.equal(error.childErrorCode, "ENOENT");
  assert.equal(error.errorCode, "ENOENT");
  assert.match(error.message, /exit=unknown.*signal=SIGTERM.*errorCode=ENOENT/u);
  assert.doesNotMatch(error.message, /secret environment/u);
});

test("controlled producer preserves child diagnostics when exit is unknown", () => {
  const projectRoot = fixtureProject();
  const attemptId = "unknown-exit-diagnostics";
  assert.throws(() => runControlledRuntimeCapabilityProducer({
    projectRoot,
    runtime: "codex",
    capability: "shell",
    attemptId,
    executor: () => ({
      status: null,
      signal: "SIGTERM",
      error: { code: "ENOENT", message: "secret environment should not escape" },
      stdout: "bounded raw host output\n",
      stderr: "secret stderr should not escape",
    }),
  }), (error) => {
    assert.equal(error.exitCode, null);
    assert.equal(error.signal, "SIGTERM");
    assert.equal(error.childErrorCode, "ENOENT");
    assert.match(error.message, /exit=unknown.*signal=SIGTERM.*errorCode=ENOENT/u);
    assert.doesNotMatch(error.message, /secret/u);
    return true;
  });
  const artifact = path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "runtime-capability-producers",
    "artifacts",
    `${attemptId}.jsonl`,
  );
  assert.equal(readFileSync(artifact, "utf8"), "bounded raw host output\n");
});

test("the codex controlled invocation keeps workspace-write while isolating host rules and selecting a supported sandbox flavor", () => {
  const workspace = path.join(packageRoot, "codex-invocation-probe-workspace");
  const win32Args = codexLiveInvocationArgs({ workspace, platform: "win32" });
  const posixArgs = codexLiveInvocationArgs({ workspace, platform: "linux" });

  for (const args of [win32Args, posixArgs]) {
    assert.equal(args[0], "exec");
    assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
    assert.equal(args[args.indexOf("-C") + 1], workspace);
    assert.equal(args.at(-1), "-");
    assert.ok(args.includes("--ignore-user-config"));
    assert.ok(!args.includes("--ephemeral"), "--ephemeral withholds the collaboration thread spawn_agent needs, so agent and subagent can never complete; isolation comes from the temporary CODEX_HOME instead");
    assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(!args.includes("--dangerously-bypass-hook-trust"));
    assert.ok(args.includes("--ignore-rules"), "the controlled probe must ignore unrelated user/project execpolicy rules");
    assert.ok(!args.some((arg) => String(arg).includes("danger-full-access")));
  }

  const overrideIndex = win32Args.indexOf("windows.sandbox=unelevated");
  assert.ok(overrideIndex > 0, "win32 must pin a host-supported Windows sandbox flavor instead of inheriting the discarded user config");
  assert.equal(win32Args[overrideIndex - 1], "-c");
  assert.ok(!posixArgs.some((arg) => String(arg).includes("windows.sandbox")));
  assert.equal(codexLiveInvocationArgs({ workspace, argsPrefix: ["--prefix-probe"], platform: "win32" })[0], "--prefix-probe");
});

test("the codex invocation can pin an explicit model and reasoning effort without changing defaults", () => {
  const workspace = path.join(packageRoot, "codex-model-invocation-probe-workspace");
  const defaultArgs = codexLiveInvocationArgs({ workspace, platform: "win32" });
  assert.equal(defaultArgs.includes("-m"), false);
  assert.equal(defaultArgs.some((arg) => String(arg).includes("model_reasoning_effort")), false);

  const pinnedArgs = codexLiveInvocationArgs({
    workspace,
    platform: "win32",
    model: "gpt-5.6-luna",
    reasoningEffort: "max",
  });
  assert.equal(pinnedArgs[pinnedArgs.indexOf("-m") + 1], "gpt-5.6-luna");
  assert.equal(pinnedArgs[pinnedArgs.indexOf("-c") + 1], 'model_reasoning_effort="max"');
  assert.equal(pinnedArgs[pinnedArgs.indexOf("-s") + 1], "workspace-write");
});

test("Codex isolates native tool probes with ephemeral sessions while preserving collaboration sessions", () => {
  const projectRoot = fixtureProject();
  const requests = new Map();
  for (const capability of ["shell", "filesystem", "apply_patch / edit", "agent", "subagent"]) {
    runControlledRuntimeCapabilityProducer({
      projectRoot,
      runtime: "codex",
      capability,
      executor: (request) => {
        requests.set(capability, request);
        return injectedExecutor(request);
      },
    });
  }
  for (const capability of ["shell", "filesystem", "apply_patch / edit"]) {
    assert.ok(requests.get(capability).args.includes("--ephemeral"), `${capability} must isolate its native tool session`);
  }
  for (const capability of ["agent", "subagent"]) {
    assert.equal(requests.get(capability).args.includes("--ephemeral"), false, `${capability} must retain collaboration session state`);
  }
});

test("live controlled Codex forwards explicit model and reasoning effort to the host request", () => {
  const projectRoot = fixtureProject();
  let captured = null;
  runControlledRuntimeCapabilityProducer({
    projectRoot,
    runtime: "codex",
    capability: "shell",
    codexModel: "gpt-5.6-luna",
    codexReasoningEffort: "max",
    executor: (request) => {
      captured = request;
      return injectedExecutor(request);
    },
  });
  assert.ok(captured);
  assert.equal(captured.args[captured.args.indexOf("-m") + 1], "gpt-5.6-luna");
  assert.equal(captured.args[captured.args.indexOf("-c") + 1], 'model_reasoning_effort="max"');
});

test("the production codex composite path builds its invocation through the shared codex builder", () => {
  const projectRoot = fixtureProject();
  const captured = [];
  runCodexCompositeEngineeringProducer({
    projectRoot,
    executor: (request) => {
      captured.push(request);
      return injectedCodexEngineeringExecutor(request);
    },
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].executableIdentity?.realpath, "<test-only:codex>");
  const args = captured[0].args;
  assert.deepEqual(args, codexLiveInvocationArgs({ workspace: captured[0].workspace, platform: process.platform, ephemeral: true }));
  assert.equal(args[args.indexOf("-s") + 1], "workspace-write");
  if (process.platform === "win32") assert.ok(args.includes("windows.sandbox=unelevated"));
});

test("the Codex composite producer forwards explicit model and reasoning effort", () => {
  const projectRoot = fixtureProject();
  let captured = null;
  runCodexCompositeEngineeringProducer({
    projectRoot,
    codexModel: "gpt-5.6-luna",
    codexReasoningEffort: "max",
    executor: (request) => {
      captured = request;
      return injectedCodexEngineeringExecutor(request);
    },
  });
  assert.ok(captured);
  assert.equal(captured.args[captured.args.indexOf("-m") + 1], "gpt-5.6-luna");
  assert.equal(captured.args[captured.args.indexOf("-c") + 1], 'model_reasoning_effort="max"');
});

test("runtime producer CLI exposes explicit Codex model and reasoning options", () => {
  const result = spawnSync(process.execPath, ["scripts/run-runtime-capability-producers.mjs", "--help"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--codex-model <MODEL>/u);
  assert.match(result.stdout, /--codex-reasoning-effort <EFFORT>/u);
});

test("explicit Codex model options reject mixed runtimes before any host invocation", () => {
  const result = spawnSync(process.execPath, [
    "scripts/run-runtime-capability-producers.mjs",
    "--source", "live_controlled",
    "--codex-model", "gpt-5.6-luna",
    "--codex-reasoning-effort", "max",
  ], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /require --runtimes codex/u);
});

test("Claude 2.1.202 async Agent and subagent producers accept only marker-bound closed child lifecycles", () => {
  const projectRoot = fixtureProject();
  for (const capability of ["agent", "subagent"]) {
    const produced = runControlledRuntimeCapabilityProducer({
      projectRoot,
      runtime: "claude_code",
      capability,
      executor: injectedClaudeAsyncAgentExecutor(),
    });
    const [event] = produced.receipt.eventEvidence;
    assert.equal(produced.receipt.eventEvidence.length, 1);
    assert.equal(event.resultStatus, "completed");
    assert.equal(event.sourceLines.length, 6);
    assert.equal(event.resultTextSha256, createHash("sha256").update(produced.receipt.capabilityMarker).digest("hex"));
    assert.deepEqual(event.resultSourceLines, [4]);
    assert.equal(event.lifecycleEvidence, "claude_async_agent_task_lifecycle");
    assert.equal(event.completionBoundary, "task_notification_completed");
    assert.equal(event.activityCompletionObserved, true);
  }
});

test("Claude 2.1.202 completed Agent envelope trusts nested child final over decorated outer content", () => {
  const produced = runControlledRuntimeCapabilityProducer({
    projectRoot: fixtureProject(),
    runtime: "claude_code",
    capability: "agent",
    executor: injectedClaudeCompletedEnvelopeExecutor(),
  });
  assert.equal(
    produced.receipt.eventEvidence[0].resultTextSha256,
    createHash("sha256").update(produced.receipt.capabilityMarker).digest("hex"),
  );
  assert.throws(() => runControlledRuntimeCapabilityProducer({
    projectRoot: fixtureProject(),
    runtime: "claude_code",
    capability: "agent",
    executor: injectedClaudeCompletedEnvelopeExecutor({ nestedWrong: true }),
  }), /did not observe a capability-specific completed host event/u);
  assert.throws(() => runControlledRuntimeCapabilityProducer({
    projectRoot: fixtureProject(),
    runtime: "claude_code",
    capability: "agent",
    executor: injectedClaudeCompletedEnvelopeExecutor({ failedLifecycle: true }),
  }), /did not observe a capability-specific completed host event/u);
});

test("Claude 2.1.202 async Agent producer rejects launch-only, incomplete, mismatched-id, and mismatched-marker evidence", () => {
  const cases = [
    injectedClaudeAsyncAgentExecutor({ launchOnly: true }),
    injectedClaudeAsyncAgentExecutor({ includeTaskUpdated: false }),
    injectedClaudeAsyncAgentExecutor({ includeTaskNotification: false }),
    injectedClaudeAsyncAgentExecutor({ mismatchedAgentId: true }),
    injectedClaudeAsyncAgentExecutor({ mismatchedMarker: true }),
    injectedClaudeAsyncAgentExecutor({ laterMismatchedMarker: true }),
    injectedClaudeAsyncAgentExecutor({ failedUpdateBeforeCompleted: true }),
    injectedClaudeAsyncAgentExecutor({ failedNotificationBeforeCompleted: true }),
    injectedClaudeAsyncAgentExecutor({ duplicateCall: true }),
    injectedClaudeAsyncAgentExecutor({ duplicateResult: true }),
  ];
  for (const [index, executor] of cases.entries()) {
    assert.throws(() => runControlledRuntimeCapabilityProducer({
      projectRoot: fixtureProject(),
      runtime: "claude_code",
      capability: "agent",
      attemptId: `claude-async-negative-${index}`,
      executor,
    }), /did not observe a capability-specific completed host event|marker lifecycle .* terminated as declined, failed, cancelled, or nonzero/u);
  }
});

test("rehashed Claude async receipt and raw artifact cannot accept a wrong child marker", () => {
  const projectRoot = fixtureProject();
  const produced = runControlledRuntimeCapabilityProducer({
    projectRoot,
    runtime: "claude_code",
    capability: "agent",
    executor: injectedClaudeAsyncAgentExecutor(),
  });
  const rawRecords = readFileSync(produced.rawPath, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const child = rawRecords.find((record) => record.type === "assistant" && record.parent_tool_use_id);
  child.message.content[0].text = `WRONG_${produced.receipt.capabilityNonce}`;
  const rawText = jsonl(rawRecords);
  writeFileSync(produced.rawPath, rawText, "utf8");
  const rawSha256 = createHash("sha256").update(rawText).digest("hex");
  const [actual] = observeClaudeJsonl(rawText).filter((event) => event.family === "agent_subagent");

  const receipt = JSON.parse(readFileSync(produced.receiptPath, "utf8"));
  receipt.eventEvidence[0].outputDigest = actual.outputDigest;
  receipt.rawArtifact.sha256 = rawSha256;
  receipt.hostInvocation.result.stdoutSha256 = rawSha256;
  receipt.hostInvocation.resultDigest = createHash("sha256").update(JSON.stringify(receipt.hostInvocation.result)).digest("hex");
  const { recordHash: _receiptHash, ...receiptBody } = receipt;
  receipt.recordHash = createHash("sha256").update(JSON.stringify(receiptBody)).digest("hex");
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(produced.receiptPath, receiptBytes, "utf8");

  const attempt = JSON.parse(readFileSync(produced.acceptance.recordPath, "utf8"));
  attempt.sourceReport.sha256 = createHash("sha256").update(receiptBytes).digest("hex");
  attempt.rawArtifactSha256 = rawSha256;
  const { recordHash: _attemptHash, ...attemptBody } = attempt;
  attempt.recordHash = createHash("sha256").update(JSON.stringify(attemptBody)).digest("hex");
  writeFileSync(produced.acceptance.recordPath, `${JSON.stringify(attempt, null, 2)}\n`, "utf8");

  const index = JSON.parse(readFileSync(produced.acceptance.indexPath, "utf8"));
  index.latestByClaim["claude_code:agent:interactive_host"].recordHash = attempt.recordHash;
  writeFileSync(produced.acceptance.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot, allowTestReceipts: true });
  assert.equal(state.overlayStatus.applied.length, 0);
  assert.ok(["invalid", "rejected"].includes(state.overlayStatus.state));
  assert.match(state.issues.join("\n"), /child result is not the exact capability marker|does not match raw host evidence/u);
});

test("rehashed Claude async raw evidence cannot hide a later failed task terminal", () => {
  const projectRoot = fixtureProject();
  const produced = runControlledRuntimeCapabilityProducer({
    projectRoot,
    runtime: "claude_code",
    capability: "agent",
    executor: injectedClaudeAsyncAgentExecutor(),
  });
  const rawRecords = readFileSync(produced.rawPath, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const launch = rawRecords.find((record) => record.tool_use_result?.status === "async_launched");
  const call = rawRecords.find((record) => record.type === "assistant" && record.message?.content?.some((item) => item.type === "tool_use"));
  rawRecords.push({
    type: "system",
    subtype: "task_updated",
    task_id: launch.tool_use_result.agentId,
    patch: { status: "failed" },
    session_id: launch.session_id,
    tool_use_id: call.message.content.find((item) => item.type === "tool_use").id,
  });
  const rawText = jsonl(rawRecords);
  writeFileSync(produced.rawPath, rawText, "utf8");
  const rawSha256 = createHash("sha256").update(rawText).digest("hex");

  const receipt = JSON.parse(readFileSync(produced.receiptPath, "utf8"));
  receipt.rawArtifact.sha256 = rawSha256;
  receipt.hostInvocation.result.stdoutSha256 = rawSha256;
  receipt.hostInvocation.resultDigest = createHash("sha256").update(JSON.stringify(receipt.hostInvocation.result)).digest("hex");
  const { recordHash: _receiptHash, ...receiptBody } = receipt;
  receipt.recordHash = createHash("sha256").update(JSON.stringify(receiptBody)).digest("hex");
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(produced.receiptPath, receiptBytes, "utf8");

  const attempt = JSON.parse(readFileSync(produced.acceptance.recordPath, "utf8"));
  attempt.sourceReport.sha256 = createHash("sha256").update(receiptBytes).digest("hex");
  attempt.rawArtifactSha256 = rawSha256;
  const { recordHash: _attemptHash, ...attemptBody } = attempt;
  attempt.recordHash = createHash("sha256").update(JSON.stringify(attemptBody)).digest("hex");
  writeFileSync(produced.acceptance.recordPath, `${JSON.stringify(attempt, null, 2)}\n`, "utf8");

  const index = JSON.parse(readFileSync(produced.acceptance.indexPath, "utf8"));
  index.latestByClaim["claude_code:agent:interactive_host"].recordHash = attempt.recordHash;
  writeFileSync(produced.acceptance.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot, allowTestReceipts: true });
  assert.equal(state.overlayStatus.applied.length, 0);
  assert.ok(["invalid", "rejected"].includes(state.overlayStatus.state));
  assert.match(state.issues.join("\n"), /does not match raw host evidence|does not prove agent/u);
});

test("one Codex engineering invocation emits three facet-specific advisory receipts", () => {
  const projectRoot = fixtureProject();
  const produced = runCodexCompositeEngineeringProducer({ projectRoot, executor: injectedCodexEngineeringExecutor });
  assert.deepEqual(produced.results.map((entry) => entry.capability), ["shell", "filesystem", "apply_patch / edit"]);
  assert.equal(new Set(produced.results.map((entry) => entry.receipt.rawArtifact.sha256)).size, 1);
  assert.deepEqual(produced.results.map((entry) => entry.receipt.eventEvidence.length), [1, 2, 1]);
  assert.equal(new Set(produced.results.flatMap((entry) => entry.receipt.eventEvidence.map((event) => event.eventId))).size, 4);
  const production = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot });
  assertHostHandoffOnly(evaluateRouteExecutionGate({ runtime: "codex", taskShape: "engineering_execution", effectiveMatrix: production.effectiveMatrix }));
  const testAware = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot, allowTestReceipts: true });
  assertHostHandoffOnly(evaluateRouteExecutionGate({ runtime: "codex", taskShape: "engineering_execution", effectiveMatrix: testAware.effectiveMatrix }));
});

test("Codex engineering accepts the native file_change path shape without requiring synthetic marker payload", () => {
  const projectRoot = fixtureProject();
  const produced = runCodexCompositeEngineeringProducer({ projectRoot, executor: injectedCodexEngineeringRuntimeShapeExecutor });
  assert.deepEqual(produced.results.map((entry) => entry.capability), ["shell", "filesystem", "apply_patch / edit"]);
  assert.equal(produced.results.every((entry) => entry.receipt.eventEvidence.length > 0), true);
  assert.equal(produced.results.find((entry) => entry.capability === "apply_patch / edit").receipt.eventEvidence[0].hostSurface, "codex_cli.file_change");
});

test("acceptance validator accepts the native file_change path shape without synthetic marker payload", () => {
  const projectRoot = fixtureProject();
  const produced = runCodexCompositeEngineeringProducer({ projectRoot, executor: injectedCodexEngineeringRuntimeShapeExecutor });
  const edit = produced.results.find((entry) => entry.capability === "apply_patch / edit");
  const validation = validateRuntimeCapabilityAcceptanceAttemptEvidence(edit.acceptance.record, {
    profileRoot: edit.acceptance.paths.profileRoot,
  });
  assert.equal(validation.valid, true, validation.issues.join("\n"));
});

test("acceptance validator separates non-Raw read output from the final file LF contract", () => {
  const projectRoot = fixtureProject();
  const produced = runCodexCompositeEngineeringProducer({
    projectRoot,
    executor: (request) => injectedCodexEngineeringRuntimeShapeExecutor(request, undefined, { nonRawReadOutput: true }),
  });
  const edit = produced.results.find((entry) => entry.capability === "apply_patch / edit");
  const validation = validateRuntimeCapabilityAcceptanceAttemptEvidence(edit.acceptance.record, {
    profileRoot: edit.acceptance.paths.profileRoot,
  });
  assert.equal(validation.valid, true, validation.issues.join("\n"));
  assert.equal(edit.receipt.workspaceOutcome.contentSha256, createHash("sha256").update(`after-${produced.marker}\n`).digest("hex"));
});

test("acceptance validator rejects a rehashed native file_change for a different path", () => {
  const projectRoot = fixtureProject();
  const produced = runCodexCompositeEngineeringProducer({ projectRoot, executor: injectedCodexEngineeringRuntimeShapeExecutor });
  const target = produced.results.find((entry) => entry.capability === "apply_patch / edit");
  const rawRecords = readFileSync(produced.rawPath, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  for (const record of rawRecords) {
    if (record.type !== "item.started" && record.type !== "item.completed") continue;
    if (record.item?.type !== "file_change") continue;
    record.item.changes = [{ path: path.join(target.receipt.hostInvocation.request.args[target.receipt.hostInvocation.request.args.indexOf("-C") + 1], "other", "meta-kim-engineering-probe.txt"), kind: "update" }];
  }
  const rawText = `${jsonl(rawRecords)}\n`;
  writeFileSync(produced.rawPath, rawText, "utf8");
  const rawSha256 = createHash("sha256").update(rawText).digest("hex");

  const receipt = JSON.parse(readFileSync(target.receiptPath, "utf8"));
  receipt.rawArtifact.sha256 = rawSha256;
  receipt.hostInvocation.result.stdoutSha256 = rawSha256;
  receipt.hostInvocation.resultDigest = createHash("sha256").update(JSON.stringify(receipt.hostInvocation.result)).digest("hex");
  const { recordHash: _receiptHash, ...receiptBody } = receipt;
  receipt.recordHash = createHash("sha256").update(JSON.stringify(receiptBody)).digest("hex");
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(target.receiptPath, receiptBytes, "utf8");

  const attempt = JSON.parse(readFileSync(target.acceptance.recordPath, "utf8"));
  attempt.sourceReport.sha256 = createHash("sha256").update(receiptBytes).digest("hex");
  attempt.rawArtifactSha256 = rawSha256;
  const { recordHash: _attemptHash, ...attemptBody } = attempt;
  attempt.recordHash = createHash("sha256").update(JSON.stringify(attemptBody)).digest("hex");
  const validation = validateRuntimeCapabilityAcceptanceAttemptEvidence(attempt, {
    profileRoot: target.acceptance.paths.profileRoot,
  });
  assert.equal(validation.valid, false);
  assert.match(validation.issues.join("\n"), /not capability-marker-bound|engineering composite raw lifecycle is invalid/u);
});

test("Codex engineering accepts the native file_change final file as one marker line with one LF", () => {
  const projectRoot = fixtureProject();
  const produced = runCodexCompositeEngineeringProducer({
    projectRoot,
    executor: (request) => injectedCodexEngineeringRuntimeShapeExecutor(request, undefined, { finalTrailingNewline: true }),
  });
  const edit = produced.results.find((entry) => entry.capability === "apply_patch / edit");
  assert.equal(
    edit.receipt.compositeLifecycle.finalContentSha256,
    createHash("sha256").update(`after-${produced.marker}\n`).digest("hex"),
  );
});

test("Codex engineering rejects file_change events for another path, a suffix, or multiple files", () => {
  for (const scenario of [
    {
      name: "another directory",
      changePaths: (workspace) => [path.join(workspace, "other", "meta-kim-engineering-probe.txt")],
    },
    {
      name: "backup suffix",
      changePaths: (workspace) => [path.join(workspace, "meta-kim-engineering-probe.txt.bak")],
    },
    {
      name: "multiple files",
      changePaths: (workspace) => [
        path.join(workspace, "meta-kim-engineering-probe.txt"),
        path.join(workspace, "meta-kim-engineering-probe.txt.bak"),
      ],
    },
  ]) {
    const projectRoot = fixtureProject();
    assert.throws(() => runCodexCompositeEngineeringProducer({
      projectRoot,
      executor: (request) => injectedCodexEngineeringRuntimeShapeExecutor(request, scenario.changePaths(request.workspace)),
    }), /one exact write\/read\/edit\/final-read chain/u, scenario.name);
  }
});

test("recomputing receipt, attempt and index hashes can only forge advisory status", () => {
  const projectRoot = fixtureProject();
  const produced = runControlledRuntimeCapabilityProducer({ projectRoot, runtime: "codex", capability: "shell", executor: injectedExecutor });
  const receipt = JSON.parse(readFileSync(produced.receiptPath, "utf8"));
  receipt.testOnly = false;
  const { recordHash: _oldReceiptHash, ...receiptBody } = receipt;
  receipt.recordHash = createHash("sha256").update(JSON.stringify(receiptBody)).digest("hex");
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(produced.receiptPath, receiptBytes, "utf8");

  const attempt = JSON.parse(readFileSync(produced.acceptance.recordPath, "utf8"));
  attempt.testOnly = false;
  attempt.sourceReport.sha256 = createHash("sha256").update(receiptBytes).digest("hex");
  const { recordHash: _oldAttemptHash, ...attemptBody } = attempt;
  attempt.recordHash = createHash("sha256").update(JSON.stringify(attemptBody)).digest("hex");
  writeFileSync(produced.acceptance.recordPath, `${JSON.stringify(attempt, null, 2)}\n`, "utf8");

  const index = JSON.parse(readFileSync(produced.acceptance.indexPath, "utf8"));
  const pointer = index.latestByClaim["codex:shell:interactive_host"];
  pointer.recordHash = attempt.recordHash;
  writeFileSync(produced.acceptance.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot });
  assert.ok(state.overlayStatus.applied.length <= 1);
  if (state.overlayStatus.applied.length === 1) {
    assert.equal(state.overlayStatus.applied[0].evidenceClass, "advisory_persisted_observation");
    assert.equal(state.overlayStatus.applied[0].executionAuthority, false);
  }
  assertHostHandoffOnly(evaluateRouteExecutionGate({ runtime: "codex", taskShape: "default_executable", effectiveMatrix: state.effectiveMatrix }));
});

test("portable advisory snapshots preserve stale observations without weakening normal freshness", () => {
  const projectRoot = fixtureProject();
  const produced = runControlledRuntimeCapabilityProducer({
    projectRoot,
    runtime: "codex",
    capability: "shell",
    executor: injectedExecutor,
  });
  const staleNow = new Date(Date.parse(produced.acceptance.record.observedAt) + (2 * 24 * 60 * 60 * 1000)).toISOString();

  const normal = loadEffectiveRuntimeCapabilityClaims({
    packageRoot,
    projectRoot,
    allowTestReceipts: true,
    now: staleNow,
  });
  assert.equal(normal.overlayStatus.applied.length, 0);
  assert.match(normal.issues.join("\n"), /source observation is stale/u);

  const sourceSnapshot = loadEffectiveRuntimeCapabilityClaims({
    packageRoot,
    projectRoot,
    allowTestReceipts: true,
    now: staleNow,
    portableAdvisorySnapshot: true,
  });
  assert.equal(sourceSnapshot.overlayStatus.applied.length, 1);
  assertHostHandoffOnly(evaluateRouteExecutionGate({
    runtime: "codex",
    taskShape: "default_executable",
    effectiveMatrix: sourceSnapshot.effectiveMatrix,
  }));

  writeFileSync(path.join(
    projectRoot,
    ".meta-kim",
    "state",
    "default",
    "runtime-capability-acceptance",
    "advisory-snapshot.json",
  ), `${JSON.stringify({
    schemaVersion: "meta-kim-runtime-advisory-snapshot-v1",
    evidenceClass: "read_only_advisory_snapshot",
    observedInCurrentRun: false,
    executionAuthority: false,
    bindings: [{ attemptId: produced.acceptance.record.attemptId }],
  }, null, 2)}\n`, "utf8");
  const copiedSnapshot = loadEffectiveRuntimeCapabilityClaims({
    packageRoot,
    projectRoot,
    allowTestReceipts: true,
    now: staleNow,
  });
  assert.equal(copiedSnapshot.overlayStatus.applied.length, 1);
  assert.equal(copiedSnapshot.overlayStatus.applied[0].executionAuthority, false);
});

test("Codex engineering composite rejects an incomplete or reordered facet chain", () => {
  const projectRoot = fixtureProject();
  assert.throws(() => runCodexCompositeEngineeringProducer({
    projectRoot,
    attemptBase: "incomplete-engineering-chain",
    executor: (request) => {
      const result = injectedCodexEngineeringExecutor(request);
      const records = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      result.stdout = `${jsonl(records.filter((entry) => entry?.item?.id !== "engineering-read-after"))}\n`;
      return result;
    },
  }), /one exact write\/read\/edit\/final-read chain/u);
});

test("Codex engineering composite preserves a policy-declined host tool as failure truth", () => {
  const projectRoot = fixtureProject();
  assert.throws(() => runCodexCompositeEngineeringProducer({
    projectRoot,
    attemptBase: "policy-declined-engineering-chain",
    executor: (request) => {
      const marker = request.prompt.match(/META_KIM_CAPABILITY_ENGINEERING_[0-9a-f-]{36}/u)?.[0];
      return {
        status: 0,
        signal: null,
        stderr: "",
        runtimeVersion: "codex-policy-test",
        stdout: `${jsonl([
          { type: "thread.started", thread_id: "policy-thread" },
          { type: "item.started", item: { id: "declined-write", type: "command_execution", status: "in_progress", command: `WriteAllText meta-kim-engineering-probe.txt before-${marker}` } },
          { type: "item.completed", item: { id: "declined-write", type: "command_execution", status: "declined", exit_code: -1, command: `WriteAllText meta-kim-engineering-probe.txt before-${marker}`, aggregated_output: "blocked by policy" } },
        ])}\n`,
      };
    },
  }), /host tool was declined/u);
});

test("marker-started call fails when its unmarked terminal declines and later success cannot overwrite it", () => {
  const projectRoot = fixtureProject();
  assert.throws(() => runControlledRuntimeCapabilityProducer({
    projectRoot,
    runtime: "codex",
    capability: "shell",
    executor: (request) => {
      const marker = request.prompt.match(/META_KIM_CAPABILITY_[A-Z0-9_]+_[0-9a-f-]{36}/u)?.[0];
      writeFileSync(path.join(request.workspace, "meta-kim-probe.txt"), `shell-${marker}\n`, "utf8");
      return {
        status: 0,
        signal: null,
        stderr: "",
        runtimeVersion: "codex-marker-terminal-test",
        stdout: `${jsonl([
          { type: "thread.started", thread_id: "marker-thread" },
          { type: "item.started", item: { id: "same-call", type: "command_execution", status: "in_progress", command: `bounded-probe ${marker}` } },
          { type: "item.completed", item: { id: "same-call", type: "command_execution", status: "declined", exit_code: 7, aggregated_output: "policy denied" } },
          { type: "item.completed", item: { id: "same-call", type: "command_execution", status: "completed", exit_code: 0, aggregated_output: marker } },
        ])}\n`,
      };
    },
  }), /missing or conflicting terminal|terminated as declined/u);
});

test("setup-bound producer rejects a PATH-prepended fake binary before host invocation", () => {
  const projectRoot = fixtureProject();
  const producerRoot = path.join(projectRoot, ".meta-kim", "state", "default", "runtime-capability-producers");
  mkdirSync(producerRoot, { recursive: true });
  const trusted = path.join(projectRoot, "trusted-codex.exe");
  const fake = path.join(projectRoot, "fake-codex.exe");
  writeFileSync(trusted, "trusted executable", "utf8");
  writeFileSync(fake, "fake executable", "utf8");
  const trustedReal = path.resolve(trusted);
  recordSetupRuntimeExecutableBindings({
    roots: [projectRoot],
    targets: ["codex"],
    pathResolver: () => trusted,
    versionRunner: () => ({ status: 0, stdout: "codex fixture 1.0.0", stderr: "" }),
  });
  assert.throws(() => loadSetupBoundRuntimeExecutable({ projectRoot, runtime: "codex", pathResolver: () => fake }), /does not match/u);
  assert.equal(loadSetupBoundRuntimeExecutable({ projectRoot, runtime: "codex", pathResolver: () => trusted }).realpath, trustedReal);
});

test("rewriting self-hashes cannot forge a Codex engineering facet binding", () => {
  const projectRoot = fixtureProject();
  const produced = runCodexCompositeEngineeringProducer({ projectRoot, executor: injectedCodexEngineeringExecutor });
  const target = produced.results.find((entry) => entry.capability === "filesystem");
  const receipt = JSON.parse(readFileSync(target.receiptPath, "utf8"));
  receipt.compositeLifecycle.eventBindings.filesystem.reverse();
  const { recordHash: _receiptHash, ...receiptBody } = receipt;
  receipt.recordHash = createHash("sha256").update(JSON.stringify(receiptBody)).digest("hex");
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(target.receiptPath, receiptBytes, "utf8");
  const attempt = JSON.parse(readFileSync(target.acceptance.recordPath, "utf8"));
  attempt.sourceReport.sha256 = createHash("sha256").update(receiptBytes).digest("hex");
  const { recordHash: _attemptHash, ...attemptBody } = attempt;
  attempt.recordHash = createHash("sha256").update(JSON.stringify(attemptBody)).digest("hex");
  writeFileSync(target.acceptance.recordPath, `${JSON.stringify(attempt, null, 2)}\n`, "utf8");
  const index = JSON.parse(readFileSync(target.acceptance.indexPath, "utf8"));
  index.latestByClaim["codex:filesystem:interactive_host"].recordHash = attempt.recordHash;
  writeFileSync(target.acceptance.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot, allowTestReceipts: true });
  assertHostHandoffOnly(evaluateRouteExecutionGate({ runtime: "codex", taskShape: "engineering_execution", effectiveMatrix: state.effectiveMatrix }));
  assert.match(state.issues.join("\n"), /engineering composite producer lifecycle is invalid|engineering composite raw lifecycle is invalid/u);
});

test("one streamed Codex Desktop spawn lifecycle proves distinct agent and subagent facets", async () => {
  const projectRoot = fixtureProject();
  const fixture = codexDesktopFixture();
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = fixture.codexHome;
  try {
    const produced = await runCodexDesktopSessionCapabilityProducer({
      projectRoot,
      ...fixture,
      reader: (options) => readCodexDesktopSessionEvidence(options),
    });
    assert.equal(produced.results.length, 2);
    assert.equal(produced.results[0].receipt.rawArtifact.sha256, produced.results[1].receipt.rawArtifact.sha256);
    assert.equal(produced.results[0].receipt.compositeLifecycle.lifecycleId, produced.results[1].receipt.compositeLifecycle.lifecycleId);
    assert.deepEqual(produced.results.map((entry) => entry.receipt.compositeLifecycle.facet), ["agent", "subagent"]);
    assert.notEqual(produced.results[0].receipt.eventEvidence[0].eventId, produced.results[1].receipt.eventEvidence[0].eventId);
    assert.equal(produced.results[0].receipt.eventEvidence[0].sourceLines.some((line) => produced.results[1].receipt.eventEvidence[0].sourceLines.includes(line)), false);
    assert.equal(produced.results.every((entry) => entry.receipt.testOnly === true), true);
    const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot, allowTestReceipts: true });
    assert.equal(state.overlayStatus.state, "applied");
    assertHostHandoffOnly(evaluateRouteExecutionGate({ runtime: "codex", taskShape: "product_build", effectiveMatrix: state.effectiveMatrix }));
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    rmSync(fixture.codexHome, { recursive: true, force: true });
  }
});

test("Desktop readers accept a uniquely fresh resumed segment without relaxing identity or ambiguity checks", async (context) => {
  for (const kind of ["agent", "engineering"]) await context.test(kind, async () => {
    const fixture = kind === "agent" ? codexDesktopFixture() : codexDesktopEngineeringFixture(fixtureProject());
    const reader = kind === "agent" ? readCodexDesktopSessionEvidence : readCodexDesktopEngineeringEvidence;
    const dir = path.join(fixture.codexHome, "sessions", "2026", "07", "28");
    const original = path.join(dir, `rollout-${kind === "agent" ? "parent" : "desktop"}-${fixture.threadId}.jsonl`);
    const resumed = path.join(dir, `rollout-resumed-${fixture.threadId}_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl`);
    try {
      const bytes = readFileSync(original);
      writeFileSync(resumed, bytes);
      utimesSync(original, new Date(0), new Date(0));
      const evidence = await reader(fixture);
      assert.ok(evidence.parentSessionRef.includes("_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"));
      const records = bytes.toString().split(/\r?\n/u);
      const meta = JSON.parse(records[0]);
      meta.payload.id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      records[0] = JSON.stringify(meta);
      writeFileSync(resumed, records.join("\n"));
      await assert.rejects(() => reader(fixture), /source_invalid|parent_invalid/u);
      writeFileSync(resumed, bytes);
      writeFileSync(original, bytes);
      await assert.rejects(() => reader(fixture), /codex_parent_session_not_unique/u);
    } finally {
      rmSync(fixture.codexHome, { recursive: true, force: true });
      if (fixture.workspacePath) rmSync(fixture.workspacePath, { recursive: true, force: true });
    }
  });
});

test("one Codex Desktop session chain produces three engineering receipts from five distinct events", async () => {
  const projectRoot = fixtureProject();
  const fixture = codexDesktopEngineeringFixture(projectRoot);
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = fixture.codexHome;
  try {
    const produced = await runCodexDesktopEngineeringSessionProducer({
      projectRoot,
      ...fixture,
      reader: (options) => readCodexDesktopEngineeringEvidence(options),
    });
    assert.deepEqual(produced.results.map((entry) => entry.receipt.eventEvidence.length), [1, 2, 2]);
    assert.equal(new Set(produced.results.map((entry) => entry.receipt.rawArtifact.sha256)).size, 1);
    assert.equal(new Set(produced.results.flatMap((entry) => entry.receipt.eventEvidence.map((event) => event.eventId))).size, 5);
    const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot, allowTestReceipts: true });
    assertHostHandoffOnly(evaluateRouteExecutionGate({ runtime: "codex", taskShape: "engineering_execution", effectiveMatrix: state.effectiveMatrix }));
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    rmSync(fixture.codexHome, { recursive: true, force: true });
    rmSync(fixture.workspacePath, { recursive: true, force: true });
  }
});

test("Codex Desktop engineering reader ignores string-output outer exec calls without hiding the valid array chain", async () => {
  const projectRoot = fixtureProject();
  const fixture = codexDesktopEngineeringFixture(projectRoot);
  const parentPath = path.join(
    fixture.codexHome,
    "sessions",
    "2026",
    "07",
    "28",
    `rollout-desktop-${fixture.threadId}.jsonl`,
  );
  const records = readFileSync(parentPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const validDirectoryCall = records.find((record) => record?.payload?.call_id === "desktop-shell");
  records.splice(1, 0,
    {
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", status: "completed", call_id: "outer-unrelated", input: "const r=await tools.shell_command({command:\"Write-Output unrelated\"});" },
    },
    {
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "outer-unrelated", output: "Script running with cell ID outer-unrelated" },
    },
    {
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", status: "completed", call_id: "outer-matching", input: validDirectoryCall.payload.input },
    },
    {
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "outer-matching", output: `Exit code: 0\n${fixture.workspacePath}` },
    },
    {
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", status: "completed", call_id: "outer-running", input: validDirectoryCall.payload.input },
    },
    {
      timestamp: new Date().toISOString(),
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "outer-running", output: "Script running with cell ID outer-running" },
    },
  );
  writeFileSync(parentPath, `${jsonl(records)}\n`, "utf8");

  const evidence = await readCodexDesktopEngineeringEvidence(fixture);
  assert.equal(evidence.sourceCategory, "codex_desktop_sessions");
  assert.deepEqual(Object.keys(evidence.events).sort(), ["filesystemAfter", "filesystemBefore", "patchAdd", "patchUpdate", "shell"]);

  const stringOnlyFixture = codexDesktopEngineeringFixture(projectRoot);
  const stringOnlyParentPath = path.join(
    stringOnlyFixture.codexHome,
    "sessions",
    "2026",
    "07",
    "28",
    `rollout-desktop-${stringOnlyFixture.threadId}.jsonl`,
  );
  const stringOnlyRecords = readFileSync(stringOnlyParentPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const stringOnlyDirectoryOutput = stringOnlyRecords.find((record) => record?.payload?.call_id === "desktop-shell" && record?.payload?.type === "custom_tool_call_output");
  stringOnlyDirectoryOutput.payload.output = `Exit code: 0\n${stringOnlyFixture.workspacePath}`;
  writeFileSync(stringOnlyParentPath, `${jsonl(stringOnlyRecords)}\n`, "utf8");

  await assert.rejects(
    readCodexDesktopEngineeringEvidence(stringOnlyFixture),
    /codex_desktop_engineering_chain_invalid/u,
  );
});

test("Codex Desktop engineering reader accepts the current exec_command completed wrapper without accepting failures", async () => {
  const projectRoot = fixtureProject();
  const fixture = codexDesktopEngineeringFixture(projectRoot);
  const parentPath = path.join(
    fixture.codexHome,
    "sessions",
    "2026",
    "07",
    "28",
    `rollout-desktop-${fixture.threadId}.jsonl`,
  );
  const records = readFileSync(parentPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const record of records) {
    if (record?.payload?.type === "custom_tool_call" && record.payload.name === "exec") {
      record.payload.input = record.payload.input.replaceAll("tools.shell_command", "tools.exec_command");
    }
    if (
      record?.payload?.type === "custom_tool_call_output" &&
      ["desktop-shell", "desktop-read-before", "desktop-read-after"].includes(record.payload.call_id)
    ) {
      const prior = record.payload.output[0].text.replace(/^Exit code: 0\r?\n/u, "");
      record.payload.output = [
        { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
        { type: "input_text", text: prior },
      ];
    }
  }
  writeFileSync(parentPath, `${jsonl(records)}\n`, "utf8");

  const evidence = await readCodexDesktopEngineeringEvidence(fixture);
  assert.equal(evidence.events.shell.hostSurface, "functions.exec.exec_command");
  assert.equal(evidence.events.filesystemBefore.hostSurface, "functions.exec.exec_command");
  assert.equal(evidence.events.filesystemAfter.hostSurface, "functions.exec.exec_command");

  const failedOutput = records.find((record) => record?.payload?.call_id === "desktop-shell" && record?.payload?.type === "custom_tool_call_output");
  failedOutput.payload.output[0].text = "Script failed\nWall time 0.1 seconds\nOutput:\n";
  writeFileSync(parentPath, `${jsonl(records)}\n`, "utf8");
  await assert.rejects(
    readCodexDesktopEngineeringEvidence(fixture),
    /codex_desktop_engineering_chain_invalid/u,
  );

  failedOutput.payload.output[0].text = "Script completed\nWall time 0.1 seconds\nOutput:\n";
  failedOutput.payload.output[1].text = "New-Item:\nLine |\n  1 | New-Item -BadFlag\n    | A parameter cannot be found";
  writeFileSync(parentPath, `${jsonl(records)}\n`, "utf8");
  await assert.rejects(
    readCodexDesktopEngineeringEvidence(fixture),
    /codex_desktop_engineering_chain_invalid/u,
  );
});

test("Codex Desktop session producer rejects a mismatched child backlink", async () => {
  const fixture = codexDesktopFixture();
  try {
    const childPath = path.join(fixture.codexHome, "sessions", "2026", "07", "28", `rollout-child-${fixture.childSessionId}.jsonl`);
    const text = readFileSync(childPath, "utf8").replace(fixture.threadId, "44444444-4444-4444-8444-444444444444");
    writeFileSync(childPath, text, "utf8");
    await assert.rejects(() => readCodexDesktopSessionEvidence(fixture), /codex_child_session_mismatch/u);
  } finally {
    rmSync(fixture.codexHome, { recursive: true, force: true });
  }
});

test("Codex Desktop session reader rejects wrong marker, stale, and ambiguous parent evidence", async (context) => {
  await context.test("wrong marker", async () => {
    const fixture = codexDesktopFixture();
    try {
      await assert.rejects(() => readCodexDesktopSessionEvidence({
        ...fixture,
        marker: "META_KIM_CAPABILITY_SUBAGENT_55555555-5555-4555-8555-555555555555",
      }), /codex_desktop_parent_child_final_not_unique/u);
    } finally { rmSync(fixture.codexHome, { recursive: true, force: true }); }
  });
  await context.test("stale", async () => {
    const fixture = codexDesktopFixture();
    try {
      await assert.rejects(() => readCodexDesktopSessionEvidence({ ...fixture, sinceMs: Date.now() + 60_000 }), /stale|timestamp/u);
    } finally { rmSync(fixture.codexHome, { recursive: true, force: true }); }
  });
  await context.test("ambiguous parent", async () => {
    const fixture = codexDesktopFixture();
    try {
      const sessions = path.join(fixture.codexHome, "sessions");
      const original = path.join(sessions, "2026", "07", "28", `rollout-parent-${fixture.threadId}.jsonl`);
      const duplicateDir = path.join(sessions, "duplicate");
      mkdirSync(duplicateDir, { recursive: true });
      writeFileSync(path.join(duplicateDir, `duplicate-${fixture.threadId}.jsonl`), readFileSync(original));
      await assert.rejects(() => readCodexDesktopSessionEvidence(fixture), /codex_parent_session_not_unique/u);
    } finally { rmSync(fixture.codexHome, { recursive: true, force: true }); }
  });
});

test("external self-hashed live JSON stays reference-only", () => {
  const projectRoot = fixtureProject();
  const reportPath = path.join(projectRoot, ".meta-kim", "state", "default", "imports", "forged.json");
  const timestamp = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify({
    timestamp,
    mode: "live",
    primaryReleaseFuse: true,
    codex: { status: "passed", releaseFuseInvocationObserved: true, runtimeVersion: "forged" },
    runtimeEvidencePacket: { schemaVersion: "runtime-evidence-v0.1", records: [{ runtime: "codex", strictReleasePass: true, evidenceKind: "live" }] },
  }), "utf8");
  writeRuntimeCapabilityAcceptanceAttempt({ projectRoot, reportPath, sourceKind: "runtime_live_fuse", runtime: "codex", capability: "agent" });
  const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot });
  assert.equal(state.overlayStatus.applied.length, 0);
  assert.match(state.issues.join("\n"), /reference-only/u);
});

test("one producer raw artifact cannot authorize a different capability", async () => {
  const projectRoot = fixtureProject();
  const first = runControlledRuntimeCapabilityProducer({ projectRoot, runtime: "codex", capability: "shell", executor: injectedExecutor });
  const receipt = structuredClone(first.receipt);
  receipt.capability = "filesystem";
  receipt.producer.id = "meta-kim.runtime-native-engineering.filesystem";
  receipt.capabilityMarker = `META_KIM_CAPABILITY_FILESYSTEM_${receipt.capabilityNonce}`;
  receipt.attemptId = "reused-artifact-attempt";
  receipt.correlationId = "reused-artifact-correlation";
  const { recordHash: _ignored, ...withoutHash } = receipt;
  receipt.recordHash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
  const forgedReceiptPath = path.join(projectRoot, ".meta-kim", "state", "default", "runtime-capability-producers", "receipts", "reused-artifact-attempt.json");
  writeFileSync(forgedReceiptPath, JSON.stringify(receipt), "utf8");
  const { writeTestOnlyControlledRuntimeCapabilityAcceptanceAttempt } = await import("../../scripts/runtime-capability-acceptance.mjs");
  writeTestOnlyControlledRuntimeCapabilityAcceptanceAttempt({ projectRoot, receiptPath: forgedReceiptPath, runtime: "codex", capability: "filesystem", attemptId: receipt.attemptId, correlationId: receipt.correlationId });
  const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot, allowTestReceipts: true });
  assert.equal(state.overlayStatus.state, "invalid");
  assert.match(state.issues.join("\n"), /cannot be reused across capability claims/u);
});

test("production controlled acceptance writer is not publicly exported", async () => {
  const module = await import("../../scripts/runtime-capability-acceptance.mjs");
  assert.equal(module.writeControlledRuntimeCapabilityAcceptanceAttempt, undefined);
  await assert.rejects(() => module.produceRuntimeCapabilityAcceptance({ source: "live_controlled", runtime: "codex", capabilities: ["shell"], projectRoot: fixtureProject(), executor: () => ({}) }), /does not accept injected executor/u);
  await assert.rejects(() => module.produceRuntimeCapabilityAcceptance({ source: "codex_desktop_agent_subagent", runtime: "codex", capabilities: ["agent"], projectRoot: fixtureProject(), codexHome: "C:/forged" }), /does not accept injected executor, reader, or codexHome/u);
});

test("live controlled routing selects composite only for the exact Codex engineering facets", async () => {
  const { selectLiveControlledProducerRoute } = await import("../../scripts/runtime-capability-producers.mjs");
  const engineering = ["shell", "filesystem", "apply_patch / edit"];
  assert.equal(selectLiveControlledProducerRoute({ runtime: "codex", capabilities: engineering }), "codex_engineering_composite");
  assert.equal(selectLiveControlledProducerRoute({ runtime: "codex", capabilities: ["filesystem", "shell", "apply_patch / edit"] }), "codex_engineering_composite");
  for (const capabilities of [
    ["shell", "filesystem"],
    ["shell", "filesystem", "apply_patch / edit", "agent"],
    ["shell", "filesystem", "apply_patch / edit", "apply_patch / edit"],
  ]) {
    assert.equal(selectLiveControlledProducerRoute({ runtime: "codex", capabilities }), "capability_specific");
  }
  assert.equal(selectLiveControlledProducerRoute({ runtime: "claude_code", capabilities: engineering }), "capability_specific");
});

test("formal live engineering routing still rejects injected executors", async () => {
  const module = await import("../../scripts/runtime-capability-acceptance.mjs");
  await assert.rejects(() => module.produceRuntimeCapabilityAcceptance({
    source: "live_controlled",
    runtime: "codex",
    capabilities: ["shell", "filesystem", "apply_patch / edit"],
    projectRoot: fixtureProject(),
    executor: () => ({ status: 0 }),
  }), /does not accept injected executor, reader, or codexHome/u);
});

test("rewriting every self-hash cannot forge raw host event evidence", () => {
  const projectRoot = fixtureProject();
  const produced = runControlledRuntimeCapabilityProducer({ projectRoot, runtime: "codex", capability: "shell", executor: injectedExecutor });
  const receipt = JSON.parse(readFileSync(produced.receiptPath, "utf8"));
  receipt.eventEvidence[0].outputDigest = "0".repeat(64);
  const { recordHash: _receiptHash, ...receiptBody } = receipt;
  receipt.recordHash = createHash("sha256").update(JSON.stringify(receiptBody)).digest("hex");
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(produced.receiptPath, receiptBytes, "utf8");

  const attempt = JSON.parse(readFileSync(produced.acceptance.recordPath, "utf8"));
  attempt.sourceReport.sha256 = createHash("sha256").update(receiptBytes).digest("hex");
  const { recordHash: _attemptHash, ...attemptBody } = attempt;
  attempt.recordHash = createHash("sha256").update(JSON.stringify(attemptBody)).digest("hex");
  writeFileSync(produced.acceptance.recordPath, `${JSON.stringify(attempt, null, 2)}\n`, "utf8");
  const index = JSON.parse(readFileSync(produced.acceptance.indexPath, "utf8"));
  index.latestByClaim["codex:shell:interactive_host"].recordHash = attempt.recordHash;
  writeFileSync(produced.acceptance.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

  const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot, allowTestReceipts: true });
  assert.equal(state.overlayStatus.applied.length, 0);
  assert.match(state.issues.join("\n"), /does not match raw host evidence/u);
});

test("a marker-bound declined event cannot be hidden by a later successful event", () => {
  const projectRoot = fixtureProject();
  assert.throws(() => runControlledRuntimeCapabilityProducer({
    projectRoot,
    runtime: "codex",
    capability: "shell",
    executor: (request) => {
      const marker = request.prompt.match(/META_KIM_CAPABILITY_[A-Z0-9_]+_[0-9a-f-]{36}/u)?.[0];
      writeFileSync(path.join(request.workspace, "meta-kim-probe.txt"), `shell-${marker}\n`, "utf8");
      return { status: 0, stderr: "", runtimeVersion: "codex-decline-test", stdout: `${jsonl([
        { type: "thread.started", thread_id: "decline-thread" },
        { type: "item.started", item: { id: "declined", type: "command_execution", command: `blocked ${marker}`, status: "in_progress" } },
        { type: "item.completed", item: { id: "declined", type: "command_execution", command: `blocked ${marker}`, status: "declined", exit_code: -1, aggregated_output: "blocked" } },
        { type: "item.started", item: { id: "success", type: "command_execution", command: `allowed ${marker}`, status: "in_progress" } },
        { type: "item.completed", item: { id: "success", type: "command_execution", command: `allowed ${marker}`, status: "completed", exit_code: 0, aggregated_output: marker } },
      ])}\n` };
    },
  }), /terminated as declined|missing or conflicting terminal/u);
});

test("Codex unknown native choice remains blocked without a current host surface", () => {
  const projectRoot = fixtureProject();
  const state = loadEffectiveRuntimeCapabilityClaims({ packageRoot, projectRoot });
  const gate = evaluateRouteExecutionGate({ runtime: "codex", taskShape: "fast_path", choiceRequired: true, effectiveMatrix: state.effectiveMatrix });
  assert.equal(gate.allowed, false);
  assertHostHandoffOnly(gate, "blocked");
  assert.equal(gate.hostAction, "none");
  assert.match(gate.blockers.join("\n"), /not_executable|unknown/u);
});

test("external import CLI rejects unknown, producer, and release-promotion inputs", () => {
  assert.throws(() => parseRuntimeAcceptanceCliArgs(["--unknown"]), /unknown option/u);
  assert.throws(() => parseRuntimeAcceptanceCliArgs(["--report", "x", "--source-kind", "controlled_producer_receipt", "--runtime", "codex", "--capability", "agent"]), /unsupported external source kind/u);
  assert.throws(() => parseRuntimeAcceptanceCliArgs(["--report", "x", "--source-kind", "runtime_live_fuse", "--runtime", "codex", "--capability", "agent", "--release-grade"]), /cannot create or promote release-grade/u);
});

test("controlled producer CLI help and invalid options never invoke a runtime", () => {
  const script = path.join(packageRoot, "scripts", "run-runtime-capability-producers.mjs");
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /without invoking a runtime/u);
  assert.equal(help.stderr, "");

  const invalid = spawnSync(process.execPath, [script, "--unknown"], { encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unknown option/u);
  assert.doesNotMatch(invalid.stderr, /at file:/u);

  const freshRoot = fixtureProject();
  const status = spawnSync(process.execPath, [script, "--status", "--require-fresh", "--project-root", freshRoot, "--runtimes", "codex", "--capabilities", "agent"], { encoding: "utf8" });
  assert.notEqual(status.status, 0);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.readOnly, true);
  assert.equal(statusPayload.results.length, 0);
  assert.deepEqual(statusPayload.missing, [{ runtime: "codex", capability: "agent", mode: "interactive_host" }]);
  assert.match(statusPayload.remediation, /meta-kim runtime produce --source/u);

  const binHelp = spawnSync(process.execPath, [path.join(packageRoot, "bin", "meta-kim.mjs"), "--help"], { encoding: "utf8" });
  assert.equal(binHelp.status, 0);
  assert.match(binHelp.stdout, /meta-kim runtime produce/u);
  assert.match(binHelp.stdout, /meta-kim runtime status/u);
});

test("standard verification reads fresh controlled evidence instead of invoking producers", async () => {
  const { buildVerificationStages } = await import("../../scripts/run-verify-all.mjs");
  const stage = buildVerificationStages().find((entry) => entry.name === "meta:runtime:produce");
  assert.match(stage.cmd, /--status --require-fresh/u);
  assert.doesNotMatch(stage.cmd, /--source|--codex-engineering-composite/u);
});

test("release promotion reads controlled evidence from current and legacy verification reports", () => {
  const currentStage = { name: "meta:runtime:produce", controlledProducerEvidence: { ok: true } };
  assert.equal(
    controlledProducerStageFromVerification({ stages: [currentStage] }),
    currentStage,
  );
  assert.equal(
    controlledProducerStageFromVerification({ results: [currentStage] }),
    currentStage,
  );
  assert.equal(controlledProducerStageFromVerification({ stages: [] }), null);
});

test("release promotion selects only exact verification-bound controlled attempts", () => {
  const safetySet = JSON.parse(readFileSync(path.join(packageRoot, "config", "contracts", "runtime-execution-safety-contract.json"), "utf8")).standardObservationSet;
  const base = (binding, attemptId, receiptSha256) => ({
    attemptId, ...binding,
    attestationAuthority: "controlled_producer", testOnly: false, releaseGrade: false,
    producer: { id: `producer.${binding.runtime}.${binding.capability}` }, sourceReport: { sha256: receiptSha256, kind: "controlled_producer_receipt" },
  });
  const attempts = safetySet.map((binding, index) => base(binding, `raw-${index}`, String(index).padStart(64, "a").slice(-64)));
  const evidence = { ok: true, readOnly: true, missing: [], results: attempts.map((entry) => ({ runtime: entry.runtime, capability: entry.capability, mode: entry.mode, attemptId: entry.attemptId, receiptSha256: entry.sourceReport.sha256, producer: entry.producer.id, source: entry.sourceReport.kind })) };
  assert.equal(selectVerificationBoundControlledAttempts(attempts, evidence).length, 10);
  assert.throws(() => selectVerificationBoundControlledAttempts(attempts, { ...evidence, results: evidence.results.slice(1) }), /exact 10-item/u);
  assert.throws(() => selectVerificationBoundControlledAttempts(attempts, { ...evidence, results: [...evidence.results, evidence.results[0]] }), /exact 10-item/u);
  assert.throws(() => selectVerificationBoundControlledAttempts(attempts, { ...evidence, results: evidence.results.map((entry, index) => index === 0 ? { ...entry, mode: "headless_live" } : entry) }), /exact 10-item/u);
  assert.throws(() => selectVerificationBoundControlledAttempts(attempts, { ...evidence, results: [{ ...evidence.results[0], receiptSha256: "f".repeat(64) }, ...evidence.results.slice(1)] }), /binding mismatch/u);
});

test("failed controlled probes retain their raw host output for diagnosis", () => {
  const projectRoot = fixtureProject();
  const attemptId = "failed-shell-probe";
  const raw = `${JSON.stringify({ type: "result", result: "wrong surface" })}\n`;
  assert.throws(() => runControlledRuntimeCapabilityProducer({
    projectRoot,
    runtime: "claude_code",
    capability: "shell",
    attemptId,
    executor: () => ({ status: 0, signal: null, stdout: raw, stderr: "", runtimeVersion: "claude-test" }),
  }), /did not observe a capability-specific completed host event/u);
  const artifact = path.join(projectRoot, ".meta-kim", "state", "default", "runtime-capability-producers", "artifacts", `${attemptId}.jsonl`);
  assert.equal(readFileSync(artifact, "utf8"), raw);
});
