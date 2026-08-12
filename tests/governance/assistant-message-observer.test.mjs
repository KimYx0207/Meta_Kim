import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCodexSessionEvidence } from "../../scripts/live-acceptance/read-codex-session-evidence.mjs";
import {
  extractMetaKimBinding,
  observeClaudeAssistantMessages,
  observeClaudeJsonl,
  observeCodexAssistantMessages,
  observeCodexJsonl,
} from "../../scripts/live-acceptance/observe-host-events.mjs";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const jsonl = (records) => records.map(JSON.stringify).join("\n");
const binding = Object.freeze({
  runId: "run-2026-07-12",
  family: "agent_subagent",
  providerId: "global:code-architect",
  bindingRef: "task-runtime:agent_subagent:global:code-architect",
  taskPacketId: "task-runtime",
  roleInstanceId: "assistant-relay",
  occurredAt: "2026-07-12T06:00:00.000Z",
  evidenceKind: "spawn_agent_result",
});
const marker = `<metaKimBinding>${JSON.stringify(binding)}</metaKimBinding>`;

function codexSessionRecords({
  parentId = "11111111-1111-4111-8111-111111111111",
  childId = "22222222-2222-4222-8222-222222222222",
  childParentId = parentId,
  finalText = "private child result must remain hashed",
} = {}) {
  const parent = [
    {
      timestamp: "2026-07-24T09:00:00.000Z",
      type: "session_meta",
      payload: {
        id: parentId,
        source: "exec",
        originator: "codex_exec",
        cli_version: "0.111.0",
      },
    },
    {
      timestamp: "2026-07-24T09:00:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        call_id: "host-spawn",
        arguments: JSON.stringify({ task_name: "test", message: "bounded work" }),
      },
    },
    {
      timestamp: "2026-07-24T09:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "host-spawn",
        output: "accepted",
      },
    },
    {
      timestamp: "2026-07-24T09:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        event_id: "host-spawn",
        kind: "started",
        agent_thread_id: childId,
        agent_path: "/root/test",
      },
    },
    {
      timestamp: "2026-07-24T09:00:04.000Z",
      type: "response_item",
      payload: {
        type: "agent_message",
        author: "/root/test",
        recipient: "/root",
        content: [{ type: "input_text", text: finalText }],
      },
    },
  ];
  const child = [
    {
      timestamp: "2026-07-24T09:00:03.000Z",
      type: "session_meta",
      payload: {
        id: childId,
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: childParentId },
          },
        },
        originator: "codex_exec",
        cli_version: "0.111.0",
      },
    },
  ];
  return { parent, child, finalText };
}

function writeCodexSessionPair(codexHome, records, suffix = "") {
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "24");
  mkdirSync(sessionDir, { recursive: true });
  const parentId = records.parent[0].payload.id;
  const childId = records.child[0].payload.id;
  const parentPath = path.join(sessionDir, `rollout-parent${suffix}-${parentId}.jsonl`);
  const childPath = path.join(sessionDir, `rollout-child${suffix}-${childId}.jsonl`);
  writeFileSync(parentPath, `${jsonl(records.parent)}\n`, "utf8");
  writeFileSync(childPath, `${jsonl(records.child)}\n`, "utf8");
  return { parentPath, childPath, sessionDir };
}

function codexRunScopedEnvelope(metaKimBinding, ownerAgent) {
  return {
    schemaVersion: "codex-native-worker-invocation-v0.2",
    taskPacketId: metaKimBinding.taskPacketId,
    roleDisplayName: "test",
    roleInstanceId: metaKimBinding.roleInstanceId,
    ownerAgent,
    ownerSource: `~/.codex/agents/${ownerAgent}.toml`,
    ownerBindingMode: "run_scoped_owner_contract",
    nativeAgentType: null,
    capabilityLoadout: { skill: "meta-theory", runtimeTool: "node:test" },
    metaKimBinding,
  };
}

function codexNativeEnvelope(metaKimBinding, ownerAgent) {
  return {
    ...codexRunScopedEnvelope(metaKimBinding, ownerAgent),
    ownerBindingMode: "native_custom_agent",
    nativeAgentType: ownerAgent,
    ownerDefinition: {
      format: "codex_custom_agent_toml",
      sourceRef: `~/.codex/agents/${ownerAgent}.toml`,
      nativeAgentName: ownerAgent,
      nativeCustomAgentEligible: true,
    },
  };
}

test("Codex CLI main-thread completed agent_message exposes exact session, message, and text hash fields", () => {
  const text = "Route selected before execution.";
  const raw = jsonl([
    { type: "thread.started", thread_id: "thread-1" },
    {
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", status: "completed", text },
    },
  ]);
  const [observation] = observeCodexAssistantMessages(raw, {
    sessionId: "thread-1",
    messageId: "message-1",
    textSha256: sha256(text),
  });
  assert.equal(observation.observationKind, "assistant_message");
  assert.equal(observation.mainThreadChat, true);
  assert.equal(observation.text, text);
  assert.equal(observation.textSha256, sha256(text));
  assert.deepEqual(
    observeCodexAssistantMessages(raw, { textSha256: sha256("different") }),
    [],
  );
});

test("Codex stderr, system records, and incomplete agent messages never count", () => {
  const raw = jsonl([
    { type: "thread.started", thread_id: "thread-2" },
    { type: "stderr", text: "pretend assistant text" },
    { type: "system", message: "pretend assistant text" },
    { type: "item.started", item: { id: "message-started", type: "agent_message", text: "partial" } },
    { type: "item.completed", item: { id: "message-failed", type: "agent_message", status: "failed", text: "failed", error: "boom" } },
  ]);
  assert.deepEqual(observeCodexAssistantMessages(raw), []);
});

test("Codex Desktop committed main-thread event_msg commentary is session-bound assistant chat evidence", () => {
  const text = "Fetch completed; the route changed.";
  const raw = jsonl([
    { type: "session_meta", payload: { id: "desktop-session-1" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: text } },
    {
      type: "response_item",
      payload: {
        type: "agent_message",
        author: "/root/child",
        recipient: "/root",
        content: [{ type: "input_text", text: "child result is not user chat" }],
      },
    },
  ]);
  const observations = observeCodexAssistantMessages(raw);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].sessionId, "desktop-session-1");
  assert.equal(observations[0].phase, "commentary");
  assert.equal(observations[0].mainThreadChat, true);
  assert.equal(observations[0].textSha256, sha256(text));
});

test("Claude main-thread completed assistant text exposes exact session, message, and text hash fields", () => {
  const text = "已选择路线。";
  const raw = jsonl([
    {
      type: "assistant",
      session_id: "claude-session-1",
      message: {
        id: "claude-message-1",
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
      },
    },
  ]);
  const [observation] = observeClaudeAssistantMessages(raw, {
    sessionId: "claude-session-1",
    messageId: "claude-message-1",
    textSha256: sha256(text),
  });
  assert.equal(observation.stopReason, "end_turn");
  assert.equal(observation.mainThreadChat, true);
  assert.equal(observation.textSha256, sha256(text));
});

test("Claude system/config records and incomplete assistant messages never count", () => {
  const raw = jsonl([
    { type: "system", session_id: "s1", message: { id: "sys", content: [{ type: "text", text: "system" }] } },
    { type: "assistant", session_id: "s1", message: { id: "partial", stop_reason: null, content: [{ type: "text", text: "partial" }] } },
    { type: "assistant", session_id: "s1", message: { id: "tools-only", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Bash" }] } },
  ]);
  assert.deepEqual(observeClaudeAssistantMessages(raw), []);
});

test("Claude streamed text with null stop_reason counts only when an exact later success result closes it", () => {
  const text = "P117_CLAUDE_RAW_CAPTURE";
  const raw = jsonl([
    {
      type: "assistant",
      session_id: "claude-stream-session",
      message: {
        id: "claude-stream-message",
        stop_reason: null,
        content: [{ type: "text", text }],
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude-stream-session",
      result: text,
    },
  ]);
  const [observation] = observeClaudeAssistantMessages(raw);
  assert.equal(observation.messageId, "claude-stream-message");
  assert.equal(observation.stopReason, "result_success");
  assert.equal(observation.completionBoundary, "result:success");
  assert.deepEqual(observation.sourceLines, [1, 2]);

  assert.deepEqual(observeClaudeAssistantMessages(jsonl([
    JSON.parse(raw.split("\n")[0]),
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude-stream-session",
      result: "different text",
    },
  ])), []);
});

test("Claude Task result without a real child id cannot become successful agent evidence", () => {
  const raw = jsonl([
    {
      type: "assistant",
      session_id: "claude-parent",
      message: {
        id: "batch-no-child",
        content: [{ type: "tool_use", id: "task-no-child", name: "Task", input: { prompt: "review" } }],
      },
    },
    {
      type: "user",
      session_id: "claude-parent",
      message: {
        content: [{ type: "tool_result", tool_use_id: "task-no-child", content: "looks successful" }],
      },
      tool_use_result: {},
    },
  ]);
  assert.deepEqual(observeClaudeJsonl(raw), []);
});

function claudeAsyncAgentRecords({
  agentId = "claude-async-child",
  launchAgentId = agentId,
  childText = "META_KIM_CAPABILITY_AGENT_async-marker",
  includeTaskUpdated = true,
  includeTaskNotification = true,
} = {}) {
  const callId = "claude-async-call";
  const sessionId = "claude-async-parent";
  const records = [
    {
      timestamp: "2026-07-30T20:07:05.000Z",
      type: "assistant",
      session_id: sessionId,
      message: {
        id: "claude-async-batch",
        content: [{ type: "tool_use", id: callId, name: "Agent", input: { prompt: childText } }],
      },
    },
    {
      timestamp: "2026-07-30T20:07:06.000Z",
      type: "system",
      subtype: "task_started",
      task_id: agentId,
      tool_use_id: callId,
      session_id: sessionId,
    },
    {
      timestamp: "2026-07-30T20:07:06.100Z",
      type: "user",
      session_id: sessionId,
      tool_use_result: { isAsync: true, status: "async_launched", agentId: launchAgentId },
      message: {
        content: [{ type: "tool_result", tool_use_id: callId, content: "Async agent launched successfully." }],
      },
    },
    {
      timestamp: "2026-07-30T20:07:07.000Z",
      type: "assistant",
      parent_tool_use_id: callId,
      session_id: sessionId,
      message: {
        id: "claude-async-child-result",
        stop_reason: null,
        content: [{ type: "text", text: childText }],
      },
    },
  ];
  if (includeTaskUpdated) {
    records.push({
      timestamp: "2026-07-30T20:07:08.000Z",
      type: "system",
      subtype: "task_updated",
      task_id: agentId,
      patch: { status: "completed" },
      session_id: sessionId,
    });
  }
  if (includeTaskNotification) {
    records.push({
      timestamp: "2026-07-30T20:07:08.100Z",
      type: "system",
      subtype: "task_notification",
      task_id: agentId,
      tool_use_id: callId,
      status: "completed",
      summary: childText,
      session_id: sessionId,
    });
  }
  return records;
}

test("Claude async Agent requires the exact closed task lifecycle and child return", () => {
  const childText = "META_KIM_CAPABILITY_AGENT_11111111-1111-4111-8111-111111111111";
  const [event] = observeClaudeJsonl(jsonl(claudeAsyncAgentRecords({ childText })));
  assert.equal(event.family, "agent_subagent");
  assert.equal(event.childSessionId, "claude-async-child");
  assert.equal(event.resultStatus, "completed");
  assert.equal(event.lifecycleEvidence, "claude_async_agent_task_lifecycle");
  assert.equal(event.completionBoundary, "task_notification_completed");
  assert.equal(event.resultTextSha256, sha256(childText));
  assert.deepEqual(event.resultSourceLines, [4]);
  assert.deepEqual(event.sourceLines, [1, 2, 3, 4, 5, 6]);
});

test("Claude legacy synchronous Agent remains valid only for an ordered same-session exact child result", () => {
  const childText = "META_KIM_CAPABILITY_AGENT_22222222-2222-4222-8222-222222222222";
  const raw = jsonl([
    { type: "assistant", session_id: "legacy-sync-session", message: { id: "legacy-sync-message", content: [{ type: "tool_use", id: "legacy-sync-call", name: "Agent", input: { prompt: childText } }] } },
    { type: "user", session_id: "legacy-sync-session", tool_use_result: { agentId: "legacy-sync-child" }, message: { content: [{ type: "tool_result", tool_use_id: "legacy-sync-call", content: childText }] } },
  ]);
  const [event] = observeClaudeJsonl(raw);
  assert.equal(event.childSessionId, "legacy-sync-child");
  assert.equal(event.resultTextSha256, sha256(childText));
  assert.equal(event.lifecycleEvidence, "claude_synchronous_agent_tool_result");
  assert.equal(event.completionBoundary, "synchronous_child_tool_result");
  assert.equal(event.activityCompletionObserved, true);
});

test("Claude synchronous Agent rejects every explicit failed tool-result status", () => {
  for (const status of ["failed", "error", "cancelled", "canceled", "declined"]) {
    const raw = jsonl([
      { type: "assistant", session_id: `sync-${status}`, message: { id: `sync-${status}-message`, content: [{ type: "tool_use", id: `sync-${status}-call`, name: "Agent", input: { prompt: "EXACT_MARKER" } }] } },
      { type: "user", session_id: `sync-${status}`, tool_use_result: { agentId: `sync-${status}-child`, status }, message: { content: [{ type: "tool_result", tool_use_id: `sync-${status}-call`, content: "EXACT_MARKER" }] } },
    ]);
    assert.deepEqual(observeClaudeJsonl(raw), [], status);
  }
});

test("Claude synchronous Agent rejects nested tool-result failure flags without a status", () => {
  const failures = [
    { label: "is_error true", value: { is_error: true } },
    { label: "success false", value: { success: false } },
    { label: "error present", value: { error: "explicit launch failure" } },
  ];
  for (const { label, value } of failures) {
    const raw = jsonl([
      { type: "assistant", session_id: `sync-${label}`, message: { id: `sync-${label}-message`, content: [{ type: "tool_use", id: `sync-${label}-call`, name: "Agent", input: { prompt: "EXACT_MARKER" } }] } },
      { type: "user", session_id: `sync-${label}`, tool_use_result: { agentId: `sync-${label}-child`, ...value }, message: { content: [{ type: "tool_result", tool_use_id: `sync-${label}-call`, content: "EXACT_MARKER" }] } },
    ]);
    assert.deepEqual(observeClaudeJsonl(raw), [], label);
  }
});

test("Claude async Agent launch cannot pass without task completion or with a mismatched agent id", () => {
  const launchOnly = claudeAsyncAgentRecords().slice(0, 3);
  assert.deepEqual(observeClaudeJsonl(jsonl(launchOnly)), []);
  assert.deepEqual(observeClaudeJsonl(jsonl(claudeAsyncAgentRecords({ includeTaskUpdated: false }))), []);
  assert.deepEqual(observeClaudeJsonl(jsonl(claudeAsyncAgentRecords({ includeTaskNotification: false }))), []);
  assert.deepEqual(observeClaudeJsonl(jsonl(claudeAsyncAgentRecords({ launchAgentId: "different-child" }))), []);
});

test("Claude tool results bind to an ordered session and tool-use pair", () => {
  const crossSession = claudeAsyncAgentRecords();
  crossSession[2].session_id = "different-session";
  assert.deepEqual(observeClaudeJsonl(jsonl(crossSession)), []);

  const ordered = claudeAsyncAgentRecords();
  const resultBeforeCall = [ordered[2], ordered[0], ordered[1], ...ordered.slice(3)];
  assert.deepEqual(observeClaudeJsonl(jsonl(resultBeforeCall)), []);

  const synchronousCrossSession = [
    { type: "assistant", session_id: "call-session", message: { id: "same-id-call", content: [{ type: "tool_use", id: "same-tool-id", name: "Agent", input: { prompt: "marker" } }] } },
    { type: "user", session_id: "result-session", tool_use_result: { agentId: "child" }, message: { content: [{ type: "tool_result", tool_use_id: "same-tool-id", content: "marker" }] } },
  ];
  assert.deepEqual(observeClaudeJsonl(jsonl(synchronousCrossSession)), []);
});

test("Claude async child text cannot join across sessions and the latest child output wins", () => {
  const markerText = "META_KIM_CAPABILITY_AGENT_33333333-3333-4333-8333-333333333333";
  const splitAt = Math.floor(markerText.length / 2);
  const splitRecords = claudeAsyncAgentRecords({ childText: markerText.slice(0, splitAt) });
  splitRecords[0].message.content[0].input.prompt = markerText;
  splitRecords.at(-1).summary = markerText;
  splitRecords.splice(4, 0, {
    type: "assistant",
    parent_tool_use_id: "claude-async-call",
    session_id: "different-session",
    message: {
      id: "claude-async-child-result",
      stop_reason: null,
      content: [{ type: "text", text: markerText.slice(splitAt) }],
    },
  });
  const [splitEvent] = observeClaudeJsonl(jsonl(splitRecords));
  assert.equal(splitEvent.resultTextSha256, sha256(markerText.slice(0, splitAt)));
  assert.notEqual(splitEvent.resultTextSha256, sha256(markerText));

  const laterWrong = claudeAsyncAgentRecords({ childText: markerText });
  laterWrong.splice(4, 0, {
    type: "assistant",
    parent_tool_use_id: "claude-async-call",
    session_id: "claude-async-parent",
    message: {
      id: "claude-async-later-result",
      stop_reason: null,
      content: [{ type: "text", text: "WRONG_LATER_RESULT" }],
    },
  });
  const [latestEvent] = observeClaudeJsonl(jsonl(laterWrong));
  assert.equal(latestEvent.resultTextSha256, sha256("WRONG_LATER_RESULT"));
  assert.deepEqual(latestEvent.resultSourceLines, [5]);
});

test("Claude async Agent failure terminals cannot be washed by later completion", () => {
  const failedUpdate = claudeAsyncAgentRecords();
  failedUpdate.splice(4, 0, {
    type: "system",
    subtype: "task_updated",
    task_id: "claude-async-child",
    patch: { status: "failed" },
    session_id: "claude-async-parent",
  });
  assert.deepEqual(observeClaudeJsonl(jsonl(failedUpdate)), []);

  const failedNotification = claudeAsyncAgentRecords();
  failedNotification.splice(5, 0, {
    type: "system",
    subtype: "task_notification",
    task_id: "claude-async-child",
    tool_use_id: "claude-async-call",
    status: "failed",
    session_id: "claude-async-parent",
  });
  assert.deepEqual(observeClaudeJsonl(jsonl(failedNotification)), []);
});

test("Claude duplicate call or result correlation keys are ambiguous and produce no event", () => {
  const duplicateCall = claudeAsyncAgentRecords();
  duplicateCall.splice(1, 0, structuredClone(duplicateCall[0]));
  assert.deepEqual(observeClaudeJsonl(jsonl(duplicateCall)), []);

  const duplicateResult = claudeAsyncAgentRecords();
  duplicateResult.splice(3, 0, structuredClone(duplicateResult[2]));
  assert.deepEqual(observeClaudeJsonl(jsonl(duplicateResult)), []);
});

test("Codex CLI collab_tool_call with receiver child and exact agent_type is native spawn evidence", () => {
  const raw = jsonl([
    { type: "thread.started", thread_id: "codex-cli-parent" },
    {
      type: "item.started",
      item: {
        id: "collab-spawn",
        type: "collab_tool_call",
        tool: "spawn_agent",
        agent_type: "meta-prism",
        receiver: { thread_id: "codex-cli-child" },
      },
    },
    {
      type: "item.completed",
      item: {
        id: "collab-spawn",
        type: "collab_tool_call",
        tool: "spawn_agent",
        status: "completed",
        agent_type: "meta-prism",
        receiver: { thread_id: "codex-cli-child" },
        result: "child completed",
      },
    },
  ]);
  const [event] = observeCodexJsonl(raw);
  assert.equal(event.family, "agent_subagent");
  assert.equal(event.hostSurface, "codex_cli.spawn_agent");
  assert.equal(event.childSessionId, "codex-cli-child");
  assert.equal(event.nativeAgentType, "meta-prism");
  assert.equal(event.resultStatus, "completed");
});

test("Codex CLI spawn without agent_type is runtime invocation evidence but never custom-owner proof", () => {
  const raw = jsonl([
    { type: "thread.started", thread_id: "run-scoped-parent" },
    {
      type: "item.started",
      item: {
        id: "run-scoped-spawn",
        type: "collab_tool_call",
        tool: "spawn_agent",
        task_name: "meta-prism",
        receiver_thread_id: "run-scoped-child",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "run-scoped-spawn",
        type: "collab_tool_call",
        tool: "spawn_agent",
        task_name: "meta-prism",
        status: "completed",
        receiver_thread_id: "run-scoped-child",
        result: "completed",
      },
    },
  ]);
  const [event] = observeCodexJsonl(raw);
  assert.equal(event.hostSurface, "codex_cli.spawn_agent");
  assert.equal(event.childSessionId, "run-scoped-child");
  assert.equal(event.ownerBindingMode, "run_scoped_owner_contract");
  assert.equal(event.nativeAgentType, null);
  assert.notEqual(event.providerId, "meta-prism");
  assert.equal(event.activityCompletionObserved, true);
});

test("run-scoped Codex spawn returned by child final is complete fuse evidence without activity completion", () => {
  const finalText = "run-scoped child final";
  const records = [
    { type: "session_meta", payload: { id: "returned-parent" } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        call_id: "returned-spawn",
        arguments: JSON.stringify({
          task_name: "meta-prism",
          message: "review without a host agent_type field",
        }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "returned-spawn",
        output: "accepted",
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        event_id: "returned-spawn",
        kind: "started",
        agent_thread_id: "returned-child",
        agent_path: "/root/returned-child",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "agent_message",
        author: "/root/returned-child",
        recipient: "/root",
        content: [{ type: "input_text", text: finalText }],
      },
    },
  ];
  const [event] = observeCodexJsonl(jsonl(records));
  assert.equal(event.hostSurface, "collaboration.spawn_agent");
  assert.equal(event.ownerBindingMode, "run_scoped_owner_contract");
  assert.equal(event.nativeAgentType, null);
  assert.equal(event.childSessionId, "returned-child");
  assert.equal(event.completionBoundary, "returned_child_final");
  assert.equal(event.activityCompletionObserved, false);
  assert.match(event.resultMessageId, /^message-[a-f0-9]{24}$/u);
  assert.equal(event.resultTextSha256, sha256(finalText));

  for (const omittedIndex of [1, 2, 3]) {
    const incomplete = records.filter((_, index) => index !== omittedIndex);
    assert.deepEqual(
      observeCodexJsonl(jsonl(incomplete)),
      [],
      `accepted output, child start, and returned final are each mandatory (omitted ${omittedIndex})`,
    );
  }
});

test("Codex timeout stdout can contain a valid final JSON and one exact completed native spawn chain", () => {
  const finalPayload = {
    runtime: "codex",
    governed_entry: "meta-theory",
    warden_entry_gate: true,
    conductor_orchestration: true,
    orchestrationTaskBoardPacket: {
      synthesisOwner: "meta-conductor",
      route: "Warden -> Conductor -> board -> workerTaskPackets",
    },
    workerTaskPackets: [{
      owner: "meta-prism",
      deliverable: "review",
      verificationOwner: "meta-warden",
    }],
  };
  const raw = jsonl([
    { type: "thread.started", thread_id: "timed-out-wrapper-thread" },
    {
      type: "item.started",
      item: {
        id: "timeout-exact-spawn",
        type: "collab_tool_call",
        tool: "spawn_agent",
        agent_type: "meta-prism",
        receiver_thread_id: "timeout-exact-child",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "timeout-exact-spawn",
        type: "collab_tool_call",
        tool: "spawn_agent",
        status: "completed",
        agent_type: "meta-prism",
        receiver_thread_id: "timeout-exact-child",
        result: "child completed before wrapper timeout",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "timeout-final-json",
        type: "agent_message",
        status: "completed",
        text: JSON.stringify(finalPayload),
      },
    },
  ]);
  const nativeEvents = observeCodexJsonl(raw).filter(
    (event) =>
      event.hostSurface === "codex_cli.spawn_agent" &&
      event.nativeAgentType === "meta-prism" &&
      event.childSessionId === "timeout-exact-child" &&
      event.resultStatus === "completed",
  );
  assert.equal(nativeEvents.length, 1);
  const encodedFinal = JSON.parse(raw.split("\n").at(-1)).item.text;
  assert.equal(JSON.parse(encodedFinal).runtime, "codex");
});

test("valid final JSON cannot repair missing or wrong native Codex spawn evidence", () => {
  const finalRecord = {
    type: "item.completed",
    item: {
      id: "valid-final",
      type: "agent_message",
      status: "completed",
      text: JSON.stringify({
        runtime: "codex",
        governed_entry: "meta-theory",
        warden_entry_gate: true,
        conductor_orchestration: true,
        orchestrationTaskBoardPacket: { synthesisOwner: "meta-conductor" },
        workerTaskPackets: [{ owner: "meta-prism" }],
      }),
    },
  };
  assert.deepEqual(
    observeCodexJsonl(jsonl([
      { type: "thread.started", thread_id: "missing-spawn" },
      finalRecord,
    ])),
    [],
  );

  const [wrongOwner] = observeCodexJsonl(jsonl([
    { type: "thread.started", thread_id: "wrong-owner-parent" },
    {
      type: "item.started",
      item: {
        id: "wrong-owner-spawn",
        type: "collab_tool_call",
        tool: "spawn_agent",
        agent_type: "meta-scout",
        child_thread_id: "wrong-owner-child",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "wrong-owner-spawn",
        type: "collab_tool_call",
        tool: "spawn_agent",
        status: "completed",
        agent_type: "meta-scout",
        child_thread_id: "wrong-owner-child",
      },
    },
    finalRecord,
  ]));
  assert.equal(wrongOwner.nativeAgentType, "meta-scout");
  assert.notEqual(wrongOwner.nativeAgentType, "meta-prism");
});

test("Codex observer cannot join the same call id across parent sessions", () => {
  const raw = jsonl([
    { type: "thread.started", thread_id: "parent-a" },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        call_id: "reused-call",
        arguments: JSON.stringify({ agent_type: "meta-prism", message: "review" }),
      },
    },
    { type: "thread.started", thread_id: "parent-b" },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "reused-call", output: "accepted" },
    },
    {
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        event_id: "reused-call",
        kind: "completed",
        status: "success",
        agent_thread_id: "wrong-session-child",
      },
    },
  ]);
  assert.deepEqual(observeCodexJsonl(raw), []);
});

test("one returned child result cannot satisfy two Codex collaboration calls", () => {
  const taskPath = "/root/shared-child";
  const records = [{ type: "session_meta", payload: { id: "single-parent" } }];
  for (const callId of ["call-one", "call-two"]) {
    records.push(
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          namespace: "collaboration",
          call_id: callId,
          arguments: JSON.stringify({ message: "review" }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: callId, output: "accepted" },
      },
      {
        type: "event_msg",
        payload: {
          type: "sub_agent_activity",
          event_id: callId,
          kind: "started",
          agent_thread_id: "same-child",
          agent_path: taskPath,
        },
      },
    );
  }
  records.push({
    type: "response_item",
    payload: {
      type: "agent_message",
      author: taskPath,
      recipient: "/root",
      content: [{ type: "input_text", text: "only one final" }],
    },
  });
  const events = observeCodexJsonl(jsonl(records));
  assert.equal(events.length, 1);
  assert.equal(events[0].resultTextSha256, sha256("only one final"));
});

for (const requestName of ["spawn_agent", "followup_task"]) {
  test(`Codex Desktop ${requestName} requires accepted request output, child activity, and returned child final`, () => {
    const childId = `child-${requestName}`;
    const taskPath = `/root/${requestName}`;
    const callId = `call-${requestName}`;
    const finalText = `${requestName} final result`;
    const records = [
      { type: "thread.started", thread_id: "desktop-parent-thread" },
      { type: "response_item", payload: { type: "function_call", name: requestName, namespace: "collaboration", call_id: callId, arguments: "{}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: callId, output: "request accepted" } },
      { type: "event_msg", payload: { type: "sub_agent_activity", event_id: callId, kind: requestName === "followup_task" ? "interacted" : "started", agent_thread_id: childId, task_path: taskPath } },
      { type: "event_msg", payload: { type: "sub_agent_activity", event_id: callId, kind: "completed", status: "success", agent_thread_id: childId, task_path: taskPath } },
      { type: "item.completed", item: { id: `message-${requestName}`, type: "agent_message", status: "completed", agent_thread_id: childId, task_path: taskPath, text: finalText } },
    ];
    assert.deepEqual(observeCodexJsonl(jsonl(records.slice(0, -1))), []);
    const [event] = observeCodexJsonl(jsonl(records));
    assert.equal(event.family, "agent_subagent");
    assert.equal(event.childSessionId, childId);
    assert.equal(event.taskPath, taskPath);
    assert.equal(event.outputDigest, sha256(finalText));
    assert.equal(event.resultMessageId, `message-${requestName}`);
    assert.equal(event.resultTextSha256, sha256(finalText));
    assert.equal(event.lifecycleEvidence, "desktop_collaboration_returned_agent_message");
    assert.equal(event.sessionId, "desktop-parent-thread");
  });
}

test("Codex Desktop collaboration rejects a returned message from the wrong child", () => {
  const raw = jsonl([
    { type: "thread.started", thread_id: "parent" },
    { type: "response_item", payload: { type: "function_call", name: "followup_task", namespace: "collaboration", call_id: "call-1", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "accepted" } },
    { type: "event_msg", payload: { type: "sub_agent_activity", event_id: "call-1", kind: "started", agent_thread_id: "child-1", task_path: "/root/task-1" } },
    { type: "event_msg", payload: { type: "sub_agent_activity", event_id: "call-1", kind: "completed", status: "success", agent_thread_id: "child-1", task_path: "/root/task-1" } },
    { type: "item.completed", item: { id: "wrong-message", type: "agent_message", status: "completed", agent_thread_id: "child-2", task_path: "/root/task-2", text: "wrong child" } },
  ]);
  assert.deepEqual(observeCodexJsonl(raw), []);
});

test("sanitized real Codex Desktop followup shape correlates interacted handoff to later child-authored input_text", () => {
  const resultText = "Child final review result.";
  const raw = jsonl([
    { timestamp: "2026-07-12T06:00:01.000Z", type: "session_meta", payload: { id: "desktop-real-session" } },
    {
      timestamp: "2026-07-12T06:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        id: "fc-1",
        name: "followup_task",
        namespace: "collaboration",
        arguments: JSON.stringify({
          target: "/root/review",
          message: JSON.stringify(codexRunScopedEnvelope(binding, "code-architect")),
        }),
        call_id: "call-real-1",
      },
    },
    {
      timestamp: "2026-07-12T06:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        kind: "interacted",
        event_id: "call-real-1",
        agent_thread_id: "child-real-1",
        agent_path: "/root/review",
      },
    },
    {
      timestamp: "2026-07-12T06:00:04.000Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-real-1", output: "delivered" },
    },
    {
      type: "event_msg",
      payload: { type: "agent_message", phase: "commentary", message: "Main-thread progress." },
    },
    {
      timestamp: "2026-07-12T06:00:05.1234567Z",
      type: "response_item",
      payload: {
        type: "agent_message",
        author: "/root/review",
        recipient: "/root",
        content: [{ type: "input_text", text: resultText }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-child-1" },
      },
    },
  ]);
  const [event] = observeCodexJsonl(raw);
  assert.equal(event.family, "agent_subagent");
  assert.equal(event.sessionId, "desktop-real-session");
  assert.equal(event.childSessionId, "child-real-1");
  assert.equal(event.taskPath, "/root/review");
  assert.equal(event.resultTextSha256, sha256(resultText));
  assert.deepEqual(event.metaKimBinding, binding);
  assert.equal(event.bindingRef, binding.bindingRef);
  assert.equal(event.providerId, binding.providerId);
  assert.equal(event.hostSurface, "collaboration.followup_task");
  assert.equal(event.occurredAt, "2026-07-12T06:00:05.1234567Z");
  assert.equal(event.markerOccurredAt, binding.occurredAt);
  assert.equal(event.resultStatus, "returned");
  assert.equal(event.completionBoundary, "returned_child_final");
  assert.equal(event.activityCompletionObserved, false);
  assert.equal(event.parentAgentPath, "/root");
  assert.match(event.resultMessageId, /^message-[a-f0-9]{24}$/u);
  assert.equal(event.sourceLines.length, 4);
});

test("Codex followup_task keeps the reused task label separate from the bound professional owner", () => {
  const reusedTaskPath = "/root/status_validator_consumer";
  const professionalBinding = {
    ...binding,
    providerId: "global:test-automator",
    bindingRef: "task-runtime:agent_subagent:global:test-automator",
    roleInstanceId: "dispatch-regression",
  };
  const raw = jsonl([
    { type: "session_meta", payload: { id: "desktop-followup-owner-session" } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "followup_task",
        namespace: "collaboration",
        call_id: "call-followup-owner",
        arguments: JSON.stringify({
          target: reusedTaskPath,
          message: JSON.stringify(
            codexRunScopedEnvelope(professionalBinding, "test-automator"),
          ),
        }),
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        kind: "interacted",
        event_id: "call-followup-owner",
        agent_thread_id: "child-followup-owner",
        agent_path: reusedTaskPath,
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-followup-owner", output: "delivered" },
    },
    {
      type: "response_item",
      payload: {
        type: "agent_message",
        author: reusedTaskPath,
        recipient: "/root",
        content: [{ type: "input_text", text: "Regression result." }],
      },
    },
  ]);

  const [event] = observeCodexJsonl(raw);
  assert.equal(event.hostSurface, "collaboration.followup_task");
  assert.equal(event.taskPath, reusedTaskPath);
  assert.equal(event.providerId, "global:test-automator");
  assert.equal(event.metaKimBinding.providerId, "global:test-automator");
  assert.notEqual(event.taskPath, event.providerId);
  assert.equal(event.roleInstanceId, "dispatch-regression");
});

test("Codex followup_task without a binding is host activity, not proof of a professional owner", () => {
  const reusedTaskPath = "/root/status_panel_rework";
  const raw = jsonl([
    { type: "session_meta", payload: { id: "desktop-followup-unbound-session" } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "followup_task",
        namespace: "collaboration",
        call_id: "call-followup-unbound",
        arguments: JSON.stringify({ target: reusedTaskPath, message: "Continue the old task." }),
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        kind: "interacted",
        event_id: "call-followup-unbound",
        agent_thread_id: "child-followup-unbound",
        agent_path: reusedTaskPath,
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-followup-unbound", output: "delivered" },
    },
    {
      type: "response_item",
      payload: {
        type: "agent_message",
        author: reusedTaskPath,
        recipient: "/root",
        content: [{ type: "input_text", text: "Unbound result." }],
      },
    },
  ]);

  const [event] = observeCodexJsonl(raw);
  assert.equal(event.hostSurface, "collaboration.followup_task");
  assert.equal(event.providerId, "collaboration.followup_task");
  assert.equal(event.taskPath, reusedTaskPath);
  assert.equal(event.metaKimBinding ?? null, null);
  assert.equal(event.nativeAgentType ?? null, null);
  assert.notEqual(event.hostSurface, "collaboration.spawn_agent");
  assert.notEqual(event.providerId, "global:test-automator");
});

test("Codex native owner evidence rejects a marker bound to a different Agent", () => {
  const ownerAgent = "meta-prism";
  const forgedBinding = {
    ...binding,
    providerId: "global:test-automator",
    bindingRef: "task-runtime:agent_subagent:global:test-automator",
  };
  const raw = jsonl([
    { type: "session_meta", payload: { id: "desktop-native-owner-mismatch" } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        call_id: "call-native-owner-mismatch",
        arguments: JSON.stringify({
          task_name: "review_lane",
          agent_type: ownerAgent,
          message: JSON.stringify(codexNativeEnvelope(forgedBinding, ownerAgent)),
        }),
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        kind: "started",
        event_id: "call-native-owner-mismatch",
        agent_thread_id: "child-native-owner-mismatch",
        agent_path: "/root/review_lane",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-native-owner-mismatch",
        output: "accepted",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "agent_message",
        author: "/root/review_lane",
        recipient: "/root",
        content: [{ type: "input_text", text: "Review result." }],
      },
    },
  ]);

  const [event] = observeCodexJsonl(raw);
  assert.equal(event.ownerBindingMode, "native_custom_agent");
  assert.equal(event.nativeAgentType, ownerAgent);
  assert.equal(event.bindingUnavailableReason, "agent_binding_does_not_match_owner_envelope");
  assert.equal(event.bindingRef, undefined);
  assert.equal(event.metaKimBinding, undefined);
  assert.notEqual(event.providerId, forgedBinding.providerId);
});

test("strict metaKimBinding rejects partial, extra, malformed, and CLI-flag-like markers", () => {
  assert.deepEqual(extractMetaKimBinding({ metaKimBinding: binding }), binding);
  assert.equal(extractMetaKimBinding({ metaKimBinding: { ...binding, bindingRef: undefined } }), null);
  assert.equal(extractMetaKimBinding({ metaKimBinding: { ...binding, extra: "no" } }), null);
  assert.equal(
    extractMetaKimBinding({ metaKimBinding: { ...binding, family: "mcp" } }),
    null,
  );
  assert.equal(extractMetaKimBinding(`<metaKimBinding>{bad}</metaKimBinding>`), null);
  assert.equal(extractMetaKimBinding(`--meta-kim-binding '${JSON.stringify(binding)}'`), null);
  assert.equal(
    extractMetaKimBinding({ metaKimBinding: { ...binding, occurredAt: "2026-07-12T08:47:28.9231567Z" } })?.occurredAt,
    "2026-07-12T08:47:28.9231567Z",
  );
  const runScopedTeamBinding = {
    ...binding,
    family: "agent_teams_playbook",
    evidenceKind: "agent_team_result",
    taskPacketId: null,
    roleInstanceId: null,
  };
  assert.deepEqual(extractMetaKimBinding({ metaKimBinding: runScopedTeamBinding }), runScopedTeamBinding);
  assert.equal(
    extractMetaKimBinding({ metaKimBinding: { ...binding, taskPacketId: null, roleInstanceId: null } }),
    null,
  );
  assert.equal(
    extractMetaKimBinding({ metaKimBinding: { ...runScopedTeamBinding, roleInstanceId: "mixed" } }),
    null,
  );
});

test("assistant-message observers exclude child-thread messages from the main chat surface", () => {
  const codexRaw = jsonl([
    { type: "session_meta", payload: { id: "root-session" } },
    { type: "event_msg", payload: { type: "agent_message", phase: "commentary", agent_thread_id: "child-session", message: "child commentary" } },
    { type: "item.completed", item: { id: "child-final", type: "agent_message", status: "completed", agent_thread_id: "child-session", text: "child final" } },
  ]);
  assert.deepEqual(observeCodexAssistantMessages(codexRaw), []);

  const claudeRaw = jsonl([
    { type: "assistant", session_id: "root-session", message: { id: "root-message", stop_reason: "end_turn", content: [{ type: "text", text: "root" }] } },
    { type: "assistant", session_id: "root-session", agent_id: "child-agent", message: { id: "child-message", stop_reason: "end_turn", content: [{ type: "text", text: "child" }] } },
  ]);
  const observations = observeClaudeAssistantMessages(claudeRaw);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].messageId, "root-message");
  assert.equal(observations[0].mainThreadChat, true);
});

test("command_script binding requires a simple direct provider invocation", () => {
  const commandBinding = {
    ...binding,
    family: "command_script",
    providerId: "scripts/provider.mjs",
    bindingRef: "task-runtime:command_script:scripts/provider.mjs",
    evidenceKind: "command_output",
  };
  const observe = (command) => observeCodexJsonl(jsonl([
    { timestamp: "2026-07-12T07:10:00.000Z", type: "thread.started", thread_id: "command-session" },
    { timestamp: "2026-07-12T07:10:01.000Z", type: "response_item", payload: { type: "function_call", name: "shell_command", namespace: "functions", call_id: "command-call", arguments: JSON.stringify({ command, prompt: marker.replace(JSON.stringify(binding), JSON.stringify(commandBinding)) }) } },
    { timestamp: "2026-07-12T07:10:02.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "command-call", output: "ok", exit_code: 0 } },
  ]))[0];
  for (const command of [
    "node scripts/provider.mjs --verify",
    "node.exe .\\scripts\\provider.mjs --verify",
    "/usr/bin/node ./scripts/provider.mjs --verify",
    '"scripts/provider.mjs" --verify',
    ["node.exe", ".\\scripts\\provider.mjs", "--verify"],
    ["/usr/bin/node", "./scripts/provider.mjs", "--verify"],
  ]) {
    const matched = observe(command);
    assert.equal(matched.family, "command_script", command);
    assert.equal(matched.hostObservedFamily, "runtime_tool", command);
    assert.equal(matched.bindingRef, commandBinding.bindingRef, command);
  }

  for (const command of [
    "node scripts/provider.mjs.evil --verify",
    "if ($false) { node scripts/provider.mjs }; pwd",
    'Write-Output "scripts/provider.mjs"',
    "node other.mjs # scripts/provider.mjs",
    "node scripts/provider.mjs | Out-String",
    "node scripts/provider.mjs; pwd",
    "node scripts/provider.mjs > result.txt",
    "$(node scripts/provider.mjs)",
    ["sh", "-c", "node scripts/provider.mjs"],
  ]) {
    const rejected = observe(command);
    assert.equal(rejected.family, "runtime_tool", command);
    assert.equal(rejected.hostObservedFamily, "runtime_tool", command);
    assert.equal(rejected.bindingRef, undefined, command);
    assert.equal(
      rejected.bindingUnavailableReason,
      "command_script_provider_not_in_executed_argv",
      command,
    );
  }
});

test("task_name, nickname, and task path never prove a professional owner identity", () => {
  const ownerLikeLabel = "test-automator";
  const taskPath = `/root/${ownerLikeLabel}`;
  const raw = jsonl([
    { type: "session_meta", payload: { id: "owner-like-label-session" } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        call_id: "owner-like-label-call",
        arguments: JSON.stringify({
          task_name: ownerLikeLabel,
          nickname: ownerLikeLabel,
          message: "Run the bounded test shard without a professional owner binding.",
        }),
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        kind: "started",
        event_id: "owner-like-label-call",
        agent_thread_id: "owner-like-label-child",
        agent_path: taskPath,
        nickname: ownerLikeLabel,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "owner-like-label-call",
        output: JSON.stringify({ nickname: ownerLikeLabel, status: "started" }),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "agent_message",
        author: taskPath,
        recipient: "/root",
        content: [{ type: "input_text", text: "Unbound result." }],
      },
    },
  ]);

  const [event] = observeCodexJsonl(raw);
  assert.equal(event.taskPath, taskPath);
  assert.equal(event.providerId, "collaboration.spawn_agent");
  assert.notEqual(event.providerId, `global:${ownerLikeLabel}`);
  assert.notEqual(event.ownerAgent, ownerLikeLabel);
  assert.equal(event.metaKimBinding ?? null, null);
});

test("Skill and MCP family matches do not satisfy a different exact provider binding", () => {
  const observations = [
    {
      expectedFamily: "skill",
      binding: {
        ...binding,
        family: "skill",
        providerId: "meta-theory",
        bindingRef: "task-runtime:skill:meta-theory",
        evidenceKind: "skill_application",
      },
      call: {
        name: "Skill",
        namespace: "",
        arguments: { skill: "different-skill" },
      },
    },
    {
      expectedFamily: "mcp",
      binding: {
        ...binding,
        family: "mcp",
        providerId: "mcp__memory.search_memory",
        bindingRef: "task-runtime:mcp:mcp__memory.search_memory",
        evidenceKind: "mcp_tool_result",
      },
      call: {
        name: "save_memory",
        namespace: "mcp__memory",
        arguments: { text: "different exact MCP tool" },
      },
    },
  ];

  for (const fixture of observations) {
    const raw = jsonl([
      { timestamp: "2026-07-14T12:10:00.000Z", type: "thread.started", thread_id: `${fixture.expectedFamily}-mismatch-session` },
      {
        timestamp: "2026-07-14T12:10:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: fixture.call.name,
          namespace: fixture.call.namespace,
          call_id: `${fixture.expectedFamily}-mismatch-call`,
          arguments: JSON.stringify({
            ...fixture.call.arguments,
            metaKimBinding: fixture.binding,
          }),
        },
      },
      {
        timestamp: "2026-07-14T12:10:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: `${fixture.expectedFamily}-mismatch-call`,
          output: "ok",
        },
      },
    ]);
    const [event] = observeCodexJsonl(raw);
    assert.equal(event.family, fixture.expectedFamily);
    assert.equal(event.hostObservedFamily, fixture.expectedFamily);
    assert.equal(event.bindingRef, undefined);
    assert.notEqual(event.providerId, fixture.binding.providerId);
  }
});

test("runtime_tool binding requires the exact host tool name and namespace", () => {
  const runtimeBinding = {
    ...binding,
    family: "runtime_tool",
    providerId: "functions.fake_tool",
    bindingRef: "task-runtime:runtime_tool:functions.fake_tool",
    evidenceKind: "runtime_tool_call",
  };
  const raw = jsonl([
    { timestamp: "2026-07-14T12:20:00.000Z", type: "thread.started", thread_id: "runtime-tool-mismatch" },
    {
      timestamp: "2026-07-14T12:20:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        namespace: "functions",
        call_id: "runtime-tool-mismatch-call",
        arguments: JSON.stringify({ command: "node -v", metaKimBinding: runtimeBinding }),
      },
    },
    {
      timestamp: "2026-07-14T12:20:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "runtime-tool-mismatch-call",
        output: "Exit code: 0\nv24",
        exit_code: 0,
      },
    },
  ]);

  const [event] = observeCodexJsonl(raw);
  assert.equal(event.family, "runtime_tool");
  assert.equal(event.hostSurface, "functions.shell_command");
  assert.equal(event.providerId, "functions.shell_command");
  assert.equal(event.bindingRef, undefined);
  assert.equal(event.metaKimBinding, undefined);
  assert.equal(
    event.bindingUnavailableReason,
    "runtime_tool_binding_does_not_match_host_surface",
  );
});

test("real-shaped Codex spawn request extracts a bounded envelope without retaining the prompt", () => {
  const raw = jsonl([
    { timestamp: "2026-07-12T06:10:00.000Z", type: "session_meta", payload: { id: "spawn-session" } },
    { timestamp: "2026-07-12T06:10:01.000Z", type: "response_item", payload: { type: "function_call", name: "spawn_agent", namespace: "collaboration", call_id: "spawn-call", arguments: JSON.stringify({ message: JSON.stringify(codexRunScopedEnvelope(binding, "code-architect")) }) } },
    { timestamp: "2026-07-12T06:10:02.000Z", type: "event_msg", payload: { type: "sub_agent_activity", kind: "started", event_id: "spawn-call", agent_thread_id: "spawn-child", agent_path: "/root/spawn-child" } },
    { timestamp: "2026-07-12T06:10:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "spawn-call", output: "started" } },
    { timestamp: "2026-07-12T06:10:04.000Z", type: "response_item", payload: { type: "agent_message", author: "/root/spawn-child", recipient: "/root", content: [{ type: "input_text", text: "done" }] } },
  ]);
  const [event] = observeCodexJsonl(raw);
  assert.deepEqual(event.metaKimBinding, binding);
  assert.equal(event.bindingRef, binding.bindingRef);
  assert.equal(event.occurredAt, "2026-07-12T06:10:04.000Z");
  assert.equal("prompt" in event, false);
  assert.equal("arguments" in event, false);
});

test("real v0.2 Codex worker JSON envelope binds professional owner evidence without an XML marker", () => {
  const workerEnvelope = codexRunScopedEnvelope(binding, "code-architect");
  const raw = jsonl([
    { timestamp: "2026-07-12T06:20:00.000Z", type: "session_meta", payload: { id: "spawn-envelope-session" } },
    {
      timestamp: "2026-07-12T06:20:01.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        call_id: "spawn-envelope-call",
        arguments: JSON.stringify({
          task_name: "dispatch_regression",
          fork_turns: "none",
          message: JSON.stringify(workerEnvelope),
        }),
      },
    },
    { timestamp: "2026-07-12T06:20:02.000Z", type: "event_msg", payload: { type: "sub_agent_activity", kind: "started", event_id: "spawn-envelope-call", agent_thread_id: "spawn-envelope-child", agent_path: "/root/dispatch_regression" } },
    { timestamp: "2026-07-12T06:20:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "spawn-envelope-call", output: "started" } },
    { timestamp: "2026-07-12T06:20:04.000Z", type: "response_item", payload: { type: "agent_message", author: "/root/dispatch_regression", recipient: "/root", content: [{ type: "input_text", text: "done" }] } },
  ]);

  assert.deepEqual(extractMetaKimBinding(JSON.stringify({ message: JSON.stringify(workerEnvelope) })), binding);
  const [event] = observeCodexJsonl(raw);
  assert.deepEqual(event.metaKimBinding, binding);
  assert.equal(event.providerId, binding.providerId);
  assert.equal(event.taskPath, "/root/dispatch_regression");
  assert.notEqual(event.providerId, event.taskPath);
});

test("real-shaped Claude Task extracts metaKimBinding from immutable input prompt", () => {
  const claudeBinding = {
    ...binding,
    providerId: "claude:Task",
    bindingRef: "task-runtime:agent_subagent:claude:Task",
    evidenceKind: "agent_task_result",
  };
  const raw = jsonl([
    { timestamp: "2026-07-12T06:20:01.000Z", type: "assistant", session_id: "claude-binding-session", message: { id: "batch-1", content: [{ type: "tool_use", id: "task-call", name: "Task", input: { prompt: `Audit. <metaKimBinding>${JSON.stringify(claudeBinding)}</metaKimBinding>` } }] } },
    { timestamp: "2026-07-12T06:20:02.000Z", type: "user", session_id: "claude-binding-session", message: { content: [{ type: "tool_result", tool_use_id: "task-call", content: "done" }] }, tool_use_result: { agentId: "claude-child" } },
  ]);
  const [event] = observeClaudeJsonl(raw);
  assert.deepEqual(event.metaKimBinding, claudeBinding);
  assert.equal(event.bindingRef, claudeBinding.bindingRef);
  assert.equal(event.providerId, claudeBinding.providerId);
  assert.equal(event.hostSurface, "Task");
  assert.equal(event.occurredAt, "2026-07-12T06:20:02.000Z");
});

test("Desktop child result must return to the exact derived parent agent path", () => {
  const raw = jsonl([
    { timestamp: "2026-07-12T06:30:00.000Z", type: "session_meta", payload: { id: "sibling-session" } },
    { timestamp: "2026-07-12T06:30:01.000Z", type: "response_item", payload: { type: "function_call", name: "followup_task", namespace: "collaboration", call_id: "sibling-call", arguments: JSON.stringify({ target: "/root/review", message: "continue" }) } },
    { timestamp: "2026-07-12T06:30:02.000Z", type: "event_msg", payload: { type: "sub_agent_activity", kind: "interacted", event_id: "sibling-call", agent_thread_id: "review-child", agent_path: "/root/review" } },
    { timestamp: "2026-07-12T06:30:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "sibling-call", output: "delivered" } },
    { timestamp: "2026-07-12T06:30:04.000Z", type: "response_item", payload: { type: "agent_message", author: "/root/review", recipient: "/root/sibling", content: [{ type: "input_text", text: "wrong recipient" }] } },
  ]);
  assert.deepEqual(observeCodexJsonl(raw), []);
});

test("agent_teams_playbook marker flattens while preserving the real host surface", () => {
  const teamBinding = {
    ...binding,
    family: "agent_teams_playbook",
    providerId: "agent-teams-playbook",
    bindingRef: "task-runtime:agent_teams_playbook:agent-teams-playbook",
    evidenceKind: "agent_team_result",
  };
  const raw = jsonl([
    { timestamp: "2026-07-12T06:40:01.000Z", type: "assistant", session_id: "team-session", message: { id: "team-batch", content: [{ type: "tool_use", id: "team-call", name: "Skill", input: { prompt: `Run team. <metaKimBinding>${JSON.stringify(teamBinding)}</metaKimBinding>` } }] } },
    { timestamp: "2026-07-12T06:40:02.000Z", type: "user", session_id: "team-session", message: { content: [{ type: "tool_result", tool_use_id: "team-call", content: "done" }] } },
  ]);
  const [event] = observeClaudeJsonl(raw);
  assert.equal(event.family, "agent_teams_playbook");
  assert.equal(event.providerId, "agent-teams-playbook");
  assert.equal(event.hostSurface, "Skill");
  assert.equal(event.bindingRef, teamBinding.bindingRef);
});

test("Claude hook inherits a hook marker only from its correlated parent call", () => {
  const hookBinding = {
    ...binding,
    family: "hook",
    providerId: "PreToolUse",
    bindingRef: "task-runtime:hook:PreToolUse",
    evidenceKind: "hook_trigger_event",
  };
  const raw = jsonl([
    { timestamp: "2026-07-12T06:50:01.000Z", type: "assistant", session_id: "hook-session", message: { id: "hook-batch", content: [{ type: "tool_use", id: "parent-tool-call", name: "Bash", input: { prompt: `Run. <metaKimBinding>${JSON.stringify(hookBinding)}</metaKimBinding>` } }] } },
    { timestamp: "2026-07-12T06:50:02.000Z", type: "user", session_id: "hook-session", message: { content: [{ type: "tool_result", tool_use_id: "parent-tool-call", content: "done" }] } },
    { timestamp: "2026-07-12T06:50:03.000Z", type: "system", subtype: "hook_started", hook_id: "hook-1", hook_name: "PreToolUse", tool_use_id: "parent-tool-call", session_id: "hook-session" },
    { timestamp: "2026-07-12T06:50:04.123456Z", type: "system", subtype: "hook_response", hook_id: "hook-1", hook_name: "PreToolUse", tool_use_id: "parent-tool-call", exit_code: 0, outcome: "success", session_id: "hook-session" },
  ]);
  const events = observeClaudeJsonl(raw);
  const bound = events.filter((event) => event.bindingRef === hookBinding.bindingRef);
  assert.equal(bound.length, 1);
  assert.equal(bound[0].family, "hook");
  assert.equal(bound[0].hostSurface, "PreToolUse");
  assert.equal(bound[0].parentEventId, "parent-tool-call");
  assert.equal(bound[0].occurredAt, "2026-07-12T06:50:04.123456Z");
});

test("Claude hook binding cannot substitute another hook phase", () => {
  const preToolUseBinding = {
    ...binding,
    family: "hook",
    providerId: "PreToolUse",
    bindingRef: "task-runtime:hook:PreToolUse",
    evidenceKind: "hook_trigger_event",
  };
  const raw = jsonl([
    {
      timestamp: "2026-07-14T12:30:01.000Z",
      type: "assistant",
      session_id: "hook-phase-mismatch",
      message: {
        id: "hook-phase-parent",
        content: [{
          type: "tool_use",
          id: "hook-phase-tool-call",
          name: "Bash",
          input: {
            prompt: `Run. <metaKimBinding>${JSON.stringify(preToolUseBinding)}</metaKimBinding>`,
          },
        }],
      },
    },
    {
      timestamp: "2026-07-14T12:30:02.000Z",
      type: "user",
      session_id: "hook-phase-mismatch",
      message: {
        content: [{ type: "tool_result", tool_use_id: "hook-phase-tool-call", content: "done" }],
      },
    },
    {
      timestamp: "2026-07-14T12:30:03.000Z",
      type: "system",
      subtype: "hook_started",
      hook_id: "post-hook",
      hook_name: "PostToolUse",
      tool_use_id: "hook-phase-tool-call",
      session_id: "hook-phase-mismatch",
    },
    {
      timestamp: "2026-07-14T12:30:04.000Z",
      type: "system",
      subtype: "hook_response",
      hook_id: "post-hook",
      hook_name: "PostToolUse",
      tool_use_id: "hook-phase-tool-call",
      exit_code: 0,
      outcome: "success",
      session_id: "hook-phase-mismatch",
    },
  ]);

  const event = observeClaudeJsonl(raw).find((candidate) => candidate.family === "hook");
  assert.ok(event);
  assert.equal(event.hostSurface, "PostToolUse");
  assert.equal(event.providerId, "PostToolUse");
  assert.equal(event.bindingRef, undefined);
  assert.equal(event.metaKimBinding, undefined);
  assert.equal(event.bindingUnavailableReason, "hook_binding_does_not_match_host_surface");
});

test("encrypted tool payload is not decrypted and reports why binding is unavailable", () => {
  const raw = jsonl([
    { timestamp: "2026-07-12T07:00:01.000Z", type: "thread.started", thread_id: "encrypted-session" },
    { timestamp: "2026-07-12T07:00:02.000Z", type: "response_item", payload: { type: "function_call", name: "shell_command", namespace: "functions", call_id: "encrypted-call", arguments: JSON.stringify({ encrypted_content: "opaque" }) } },
    { timestamp: "2026-07-12T07:00:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "encrypted-call", output: "success", exit_code: 0 } },
  ]);
  const [event] = observeCodexJsonl(raw);
  assert.equal(event.bindingRef, undefined);
  assert.equal(event.bindingUnavailableReason, "encrypted_payload_without_host_binding_metadata");
  assert.equal("arguments" in event, false);
});

test("Fernet-like encrypted message payload is diagnosed without attempting decryption", () => {
  const raw = jsonl([
    { timestamp: "2026-07-12T07:20:01.000Z", type: "thread.started", thread_id: "fernet-session" },
    { timestamp: "2026-07-12T07:20:02.000Z", type: "response_item", payload: { type: "function_call", name: "shell_command", namespace: "functions", call_id: "fernet-call", arguments: JSON.stringify({ message: "gAAAAABo_0123456789abcdefghijklmnop" }) } },
    { timestamp: "2026-07-12T07:20:03.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "fernet-call", output: "success", exit_code: 0 } },
  ]);
  const [event] = observeCodexJsonl(raw);
  assert.equal(event.bindingUnavailableReason, "encrypted_payload_without_host_binding_metadata");
});

test("Codex session reader binds one fresh exec parent to one exact child backlink", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-codex-session-"));
  try {
    const codexHome = path.join(tempRoot, "codex-home");
    const records = codexSessionRecords();
    writeCodexSessionPair(codexHome, records);

    const evidence = await readCodexSessionEvidence({
      codexHome,
      threadId: records.parent[0].payload.id,
      sinceMs: Date.now() - 60_000,
    });

    assert.ok(evidence);
    assert.equal(evidence.threadId, records.parent[0].payload.id);
    assert.equal(evidence.childSessionId, records.child[0].payload.id);
    assert.equal(evidence.sourceCategory, "codex_home_sessions");
    assert.equal(evidence.cliVersion, "0.111.0");
    assert.match(evidence.sessionDigest, /^[a-f0-9]{64}$/u);
    assert.match(evidence.childSessionDigest, /^[a-f0-9]{64}$/u);
    assert.equal(evidence.parentSessionText, `${jsonl(records.parent)}\n`);
    assert.equal("parentSessionPath" in evidence, false);
    assert.equal("childSessionPath" in evidence, false);

    const publicEvidence = {
      threadId: evidence.threadId,
      childSessionId: evidence.childSessionId,
      sessionDigest: evidence.sessionDigest,
      childSessionDigest: evidence.childSessionDigest,
      sourceCategory: evidence.sourceCategory,
      cliVersion: evidence.cliVersion,
    };
    const serialized = JSON.stringify(publicEvidence);
    assert.doesNotMatch(serialized, new RegExp(tempRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.doesNotMatch(serialized, new RegExp(records.finalText, "u"));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Codex session reader binds code-mode multi_agent spawn to the exact child final", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-codex-code-mode-session-"));
  try {
    const codexHome = path.join(tempRoot, "codex-home");
    const parentId = "44444444-4444-4444-8444-444444444444";
    const childId = "55555555-5555-4555-8555-555555555555";
    const startedAt = Date.now() - 5_000;
    const timestamp = (offset) => new Date(startedAt + offset).toISOString();
    const finalText = "bounded code-mode child review";
    const callId = "code-mode-spawn-call";
    const records = {
      parent: [
        {
          timestamp: timestamp(0),
          type: "session_meta",
          payload: {
            id: parentId,
            source: "exec",
            originator: "codex_exec",
            cli_version: "0.146.0",
          },
        },
        {
          timestamp: timestamp(1_000),
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            status: "completed",
            call_id: callId,
            input: '// @exec: {"yield_time_ms": 120000, "max_output_tokens": 2000}\nconst spawned = await tools.multi_agent_v1__spawn_agent({ agent_type: "meta-prism", fork_context: false, message: "bounded review" });\ntext(JSON.stringify({spawned}));\nconst waited = await tools.multi_agent_v1__wait_agent({ targets: [spawned.agent_id], timeout_ms: 3600000 });\ntext(JSON.stringify({waited}));',
          },
        },
        {
          timestamp: timestamp(1_100),
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: callId,
            output: [
              { type: "input_text", text: "Script completed\nWall time 0.4 seconds\nOutput:\n" },
              { type: "input_text", text: JSON.stringify({ spawned: { agent_id: childId, nickname: "Review" } }) },
              { type: "input_text", text: JSON.stringify({ waited: { status: "completed", agent_id: childId } }) },
            ],
          },
        },
      ],
      child: [
        {
          timestamp: timestamp(1_200),
          type: "session_meta",
          payload: {
            id: childId,
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: parentId,
                  agent_role: "meta-prism",
                },
              },
            },
            originator: "codex_exec",
            cli_version: "0.146.0",
          },
        },
        {
          timestamp: timestamp(2_000),
          type: "event_msg",
          payload: { type: "agent_message", message: finalText, phase: "final_answer" },
        },
        {
          timestamp: timestamp(2_000),
          type: "response_item",
          payload: {
            type: "message",
            id: "msg-code-mode-child-final",
            role: "assistant",
            content: [{ type: "output_text", text: finalText }],
            phase: "final_answer",
          },
        },
        {
          timestamp: timestamp(2_100),
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: finalText },
        },
      ],
    };
    const paths = writeCodexSessionPair(codexHome, records);

    const evidence = await readCodexSessionEvidence({
      codexHome,
      threadId: parentId,
      sinceMs: startedAt - 1_000,
    });

    assert.equal(evidence.childSessionId, childId);
    assert.equal(evidence.nativeInvocation?.observerFormat, "codex_exec_code_mode_v1");
    assert.equal(evidence.nativeInvocation?.hostSurface, "codex_cli.spawn_agent");
    assert.equal(evidence.nativeInvocation?.nativeAgentType, "meta-prism");
    assert.equal(evidence.nativeInvocation?.ownerBindingMode, "native_custom_agent");
    assert.equal(evidence.nativeInvocation?.completionBoundary, "returned_child_final");
    assert.equal(evidence.nativeInvocation?.resultMessageId, "msg-code-mode-child-final");
    assert.equal(evidence.nativeInvocation?.resultTextSha256, sha256(finalText));
    assert.equal(evidence.nativeInvocation?.outputDigest, sha256(finalText));
    assert.doesNotMatch(JSON.stringify(evidence.nativeInvocation), /bounded code-mode child review/u);

    records.parent[1].payload.input = '/* tools.multi_agent_v1__spawn_agent({ agent_type: "meta-prism", message: "spoof" }); */\ntext("not a spawn");';
    writeFileSync(paths.parentPath, `${jsonl(records.parent)}\n`, "utf8");
    await assert.rejects(
      readCodexSessionEvidence({
        codexHome,
        threadId: parentId,
        sinceMs: startedAt - 1_000,
      }),
      (error) => error instanceof Error && error.code === "codex_parent_spawn_event_missing",
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Codex session reader collapses parent event frames only when they bind the same child", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-codex-session-frames-"));
  try {
    const codexHome = path.join(tempRoot, "codex-home");
    const records = codexSessionRecords();
    records.parent.splice(4, 0,
      {
        timestamp: "2026-07-24T09:00:03.100Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          namespace: "collaboration",
          call_id: "host-spawn-frame-two",
          arguments: JSON.stringify({ message: "same logical child frame" }),
        },
      },
      {
        timestamp: "2026-07-24T09:00:03.200Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "host-spawn-frame-two",
          output: "accepted",
        },
      },
      {
        timestamp: "2026-07-24T09:00:03.300Z",
        type: "event_msg",
        payload: {
          type: "sub_agent_activity",
          event_id: "host-spawn-frame-two",
          kind: "started",
          agent_thread_id: records.child[0].payload.id,
          agent_path: "/root/test-frame-two",
        },
      },
      {
        timestamp: "2026-07-24T09:00:03.400Z",
        type: "response_item",
        payload: {
          type: "agent_message",
          author: "/root/test-frame-two",
          recipient: "/root",
          content: [{ type: "input_text", text: "second frame result" }],
        },
      },
    );
    assert.equal(
      observeCodexJsonl(jsonl(records.parent)).filter(
        (event) => event.family === "agent_subagent",
      ).length,
      2,
    );
    const paths = writeCodexSessionPair(codexHome, records);

    const evidence = await readCodexSessionEvidence({
      codexHome,
      threadId: records.parent[0].payload.id,
      sinceMs: Date.now() - 60_000,
    });
    assert.equal(evidence.childSessionId, records.child[0].payload.id);

    const differentChildId = "33333333-3333-4333-8333-333333333333";
    const differentFrame = records.parent.find(
      (record) => record.payload?.event_id === "host-spawn-frame-two",
    );
    differentFrame.payload.agent_thread_id = differentChildId;
    writeFileSync(paths.parentPath, `${jsonl(records.parent)}\n`, "utf8");
    await assert.rejects(
      readCodexSessionEvidence({
        codexHome,
        threadId: records.parent[0].payload.id,
        sinceMs: Date.now() - 60_000,
      }),
      (error) => error instanceof Error &&
        error.code === "codex_parent_spawn_event_not_unique",
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Codex session reader refuses mismatched, stale, ambiguous, linked, and oversized evidence", async (t) => {
  async function expectNoEvidence(options, expectedCode) {
    await assert.rejects(
      readCodexSessionEvidence(options),
      (error) => error instanceof Error && error.code === expectedCode,
    );
  }

  async function withFixture(name, setup, assertion) {
    await t.test(name, async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-codex-negative-"));
      try {
        const codexHome = path.join(tempRoot, "codex-home");
        const records = codexSessionRecords();
        const paths = writeCodexSessionPair(codexHome, records);
        await setup({ tempRoot, codexHome, records, paths });
        await assertion({ tempRoot, codexHome, records, paths });
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    });
  }

  await withFixture("wrong requested thread", async () => {}, async ({ codexHome }) => {
    await expectNoEvidence(
      {
        codexHome,
        threadId: "33333333-3333-4333-8333-333333333333",
        sinceMs: Date.now() - 60_000,
      },
      "codex_parent_session_not_unique",
    );
  });

  await withFixture("stale mtimes", async ({ paths }) => {
    const old = new Date(Date.now() - 120_000);
    utimesSync(paths.parentPath, old, old);
    utimesSync(paths.childPath, old, old);
  }, async ({ codexHome, records }) => {
    await expectNoEvidence(
      { codexHome, threadId: records.parent[0].payload.id, sinceMs: Date.now() - 30_000 },
      "codex_parent_session_stale",
    );
  });

  await withFixture("multiple matching parents", async ({ paths, records }) => {
    const parentId = records.parent[0].payload.id;
    writeFileSync(path.join(paths.sessionDir, `duplicate-${parentId}.jsonl`), `${jsonl(records.parent)}\n`, "utf8");
  }, async ({ codexHome, records }) => {
    await expectNoEvidence(
      { codexHome, threadId: records.parent[0].payload.id, sinceMs: Date.now() - 60_000 },
      "codex_parent_session_not_unique",
    );
  });

  await withFixture("multiple matching children", async ({ paths, records }) => {
    writeFileSync(path.join(paths.sessionDir, "duplicate-child.jsonl"), `${jsonl(records.child)}\n`, "utf8");
  }, async ({ codexHome, records }) => {
    await expectNoEvidence(
      { codexHome, threadId: records.parent[0].payload.id, sinceMs: Date.now() - 60_000 },
      "codex_child_session_not_unique",
    );
  });

  await withFixture("wrong child backlink", async ({ paths, records }) => {
    const wrongChild = codexSessionRecords({
      childParentId: "33333333-3333-4333-8333-333333333333",
    }).child;
    writeFileSync(paths.childPath, `${jsonl(wrongChild)}\n`, "utf8");
    assert.notDeepEqual(wrongChild, records.child);
  }, async ({ codexHome, records }) => {
    await expectNoEvidence(
      { codexHome, threadId: records.parent[0].payload.id, sinceMs: Date.now() - 60_000 },
      "codex_child_session_mismatch",
    );
  });

  await withFixture("oversized session files", async () => {}, async ({ codexHome, records }) => {
    await expectNoEvidence(
      {
        codexHome,
        threadId: records.parent[0].payload.id,
        sinceMs: Date.now() - 60_000,
        maxBytes: 64,
      },
      "codex_parent_session_too_large",
    );
  });

  await t.test("symlinked sessions root", async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "meta-kim-codex-symlink-"));
    try {
      const codexHome = path.join(tempRoot, "codex-home");
      const externalHome = path.join(tempRoot, "external-home");
      const records = codexSessionRecords();
      const { sessionDir } = writeCodexSessionPair(externalHome, records);
      mkdirSync(codexHome, { recursive: true });
      symlinkSync(sessionDir, path.join(codexHome, "sessions"), "junction");
      await expectNoEvidence(
        {
          codexHome,
          threadId: records.parent[0].payload.id,
          sinceMs: Date.now() - 60_000,
        },
        "codex_sessions_symlink_rejected",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
