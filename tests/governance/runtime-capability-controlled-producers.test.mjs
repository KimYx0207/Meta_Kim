import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { runCodexCompositeEngineeringProducer, runCodexDesktopEngineeringSessionProducer, runCodexDesktopSessionCapabilityProducer, runControlledRuntimeCapabilityProducer } from "../../scripts/runtime-capability-producers.mjs";
import { readCodexDesktopEngineeringEvidence, readCodexDesktopSessionEvidence } from "../../scripts/live-acceptance/read-codex-session-evidence.mjs";
import { loadEffectiveRuntimeCapabilityClaims } from "../../scripts/effective-runtime-capability-claims.mjs";
import { evaluateRouteExecutionGate } from "../../scripts/runtime-execution-gate.mjs";
import { controlledProducerStageFromVerification, selectVerificationBoundControlledAttempts, writeRuntimeCapabilityAcceptanceAttempt } from "../../scripts/runtime-capability-acceptance.mjs";
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
      ? "Bash"
      : request.capability === "filesystem"
        ? "Read"
        : request.capability === "apply_patch / edit"
          ? "Read,Edit"
          : "Agent";
    const toolsIndex = request.args.indexOf("--tools");
    assert.equal(request.args[toolsIndex + 1], expectedTool);
    const allowedToolsIndex = request.args.indexOf("--allowedTools");
    assert.equal(request.args[allowedToolsIndex + 1], expectedTool);
    if (request.capability === "apply_patch / edit") {
      assert.equal(request.args[toolsIndex + 1], "Read,Edit");
      assert.equal(request.args[allowedToolsIndex + 1], "Read,Edit");
      assert.doesNotMatch(request.args[toolsIndex + 1], /Write/u);
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
  writeFileSync(path.join(request.workspace, "meta-kim-engineering-probe.txt"), `after-${marker}`, "utf8");
  const records = [{ type: "thread.started", thread_id: "engineering-thread" }];
  const addCommand = (id, command, output) => {
    records.push({ type: "item.started", item: { id, type: "command_execution", command, status: "in_progress" } });
    records.push({ type: "item.completed", item: { id, type: "command_execution", command, status: "completed", exit_code: 0, aggregated_output: output } });
  };
  addCommand("engineering-write", `Set-Content -LiteralPath meta-kim-engineering-probe.txt -Value 'before-${marker}' -NoNewline`, `wrote before-${marker}`);
  addCommand("engineering-read-before", "Get-Content -LiteralPath meta-kim-engineering-probe.txt", `before-${marker}`);
  records.push({ type: "item.started", item: { id: "engineering-edit", type: "file_change", status: "in_progress", changes: [{ path: "meta-kim-engineering-probe.txt", before: `before-${marker}`, after: `after-${marker}` }] } });
  records.push({ type: "item.completed", item: { id: "engineering-edit", type: "file_change", status: "completed", result: { path: "meta-kim-engineering-probe.txt", before: `before-${marker}`, after: `after-${marker}` } } });
  addCommand("engineering-read-after", "Get-Content -LiteralPath meta-kim-engineering-probe.txt", `after-${marker}`);
  return { status: 0, signal: null, stdout: `${jsonl(records)}\n`, stderr: "", runtimeVersion: "codex-engineering-test" };
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

  assert.match(source, /import \{ resolveClaudeLiveProviderEnvironmentSync \} from "\.\/claude-live-provider-env\.mjs";/u);
  assert.match(promptBuilder, /if \(runtime === "claude_code"\)/u);
  assert.match(promptBuilder, /native Edit tool exactly once/u);
  assert.match(promptBuilder, /Do not call Write or any other write tool/u);
  assert.match(promptBuilder, /native edit\/apply-patch capability/u);
  assert.match(producerExecutor, /if \(request\.runtime === "claude_code"\) \{\s*env = resolveClaudeLiveProviderEnvironmentSync\(\);/u);
  assert.match(producerExecutor, /runCli\(request\.command, request\.args, \{\s*cwd: request\.workspace,\s*env,/u);
  assert.match(producerExecutor, /runtimeIsolation: request\.runtime === "codex" \? "ephemeral_auth_only" : "empty_setting_sources_strict_mcp_current_auth"/u);
  assert.match(commandBuilder, /"--setting-sources",\s*"",/u);
  assert.match(commandBuilder, /"--strict-mcp-config",/u);
  assert.match(commandBuilder, /"--mcp-config", path\.join\(workspace, "meta-kim-empty-mcp\.json"\),/u);

  assert.match(producerExecutor, /isolatedRuntimeHome = mkdtempSync\(path\.join\(os\.tmpdir\(\), "meta-kim-codex-probe-"\)\)/u);
  assert.match(producerExecutor, /const authSource = path\.join\(sourceRuntimeHome, "auth\.json"\);/u);
  assert.match(producerExecutor, /copyFileSync\(authSource, path\.join\(isolatedRuntimeHome, "auth\.json"\)\);/u);
  assert.match(producerExecutor, /CODEX_HOME: isolatedRuntimeHome,/u);
  assert.match(producerExecutor, /CODEX_SKILLS_DIR: path\.join\(isolatedRuntimeHome, "skills"\),/u);
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
