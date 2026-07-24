#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");
const META_KIM_BINDING_FIELDS = Object.freeze([
  "runId",
  "family",
  "providerId",
  "bindingRef",
  "taskPacketId",
  "roleInstanceId",
  "occurredAt",
  "evidenceKind",
]);
const META_KIM_BINDING_FAMILIES = new Set([
  "agent_subagent",
  "skill",
  "mcp",
  "command_script",
  "runtime_tool",
  "hook",
  "agent_teams_playbook",
]);
const META_KIM_BINDING_EVIDENCE_KINDS = new Set([
  "spawn_agent_result",
  "agent_task_result",
  "agent_team_result",
  "skill_application",
  "mcp_tool_result",
  "command_output",
  "runtime_tool_call",
  "hook_trigger_event",
]);
const META_KIM_BINDING_KIND_BY_FAMILY = Object.freeze({
  agent_subagent: new Set(["spawn_agent_result", "agent_task_result", "agent_team_result"]),
  skill: new Set(["skill_application"]),
  mcp: new Set(["mcp_tool_result"]),
  command_script: new Set(["command_output"]),
  runtime_tool: new Set(["runtime_tool_call"]),
  hook: new Set(["hook_trigger_event"]),
  agent_teams_playbook: new Set(["agent_team_result"]),
});
const MAX_META_KIM_BINDING_JSON = 2048;
const RUN_SCOPED_BINDING_FAMILIES = new Set(["agent_teams_playbook"]);

export function parseJsonl(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return { line: index + 1, value: JSON.parse(line) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function payloadOf(record) {
  return record?.payload ?? record;
}

function validateMetaKimBinding(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const keys = Object.keys(candidate).sort();
  if (keys.join("|") !== [...META_KIM_BINDING_FIELDS].sort().join("|")) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(candidate.runId)) return null;
  if (!META_KIM_BINDING_FAMILIES.has(candidate.family)) return null;
  if (!META_KIM_BINDING_EVIDENCE_KINDS.has(candidate.evidenceKind)) return null;
  if (!META_KIM_BINDING_KIND_BY_FAMILY[candidate.family]?.has(candidate.evidenceKind)) return null;
  for (const field of ["providerId", "bindingRef"]) {
    if (
      typeof candidate[field] !== "string" ||
      candidate[field].length < 1 ||
      candidate[field].length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(candidate[field])
    ) return null;
  }
  const taskRolePair = [candidate.taskPacketId, candidate.roleInstanceId];
  const nullTaskRolePair = taskRolePair.every((value) => value === null);
  const stringTaskRolePair = taskRolePair.every(
    (value) =>
      typeof value === "string" &&
      value.length >= 1 &&
      value.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(value),
  );
  if (
    (!nullTaskRolePair && !stringTaskRolePair) ||
    (nullTaskRolePair && !RUN_SCOPED_BINDING_FAMILIES.has(candidate.family))
  ) return null;
  if (
    typeof candidate.occurredAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(candidate.occurredAt) ||
    !Number.isFinite(Date.parse(candidate.occurredAt))
  ) return null;
  const serialized = JSON.stringify(candidate);
  if (serialized.length > MAX_META_KIM_BINDING_JSON) return null;
  return Object.fromEntries(META_KIM_BINDING_FIELDS.map((field) => [field, candidate[field]]));
}

function markerFromText(value) {
  if (typeof value !== "string" || value.length > 100_000) return null;
  const open = "<metaKimBinding>";
  const close = "</metaKimBinding>";
  const start = value.indexOf(open);
  if (start < 0 || value.indexOf(open, start + open.length) >= 0) return null;
  const end = value.indexOf(close, start + open.length);
  if (end < 0 || value.indexOf(close, end + close.length) >= 0) return null;
  const raw = value.slice(start + open.length, end);
  if (!raw || raw.length > MAX_META_KIM_BINDING_JSON) return null;
  try {
    return validateMetaKimBinding(JSON.parse(raw));
  } catch {
    return null;
  }
}

function bindingFromJsonEnvelope(value) {
  if (typeof value !== "string" || value.length > 100_000) return null;
  try {
    const envelope = JSON.parse(value);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
    return validateMetaKimBinding(envelope.metaKimBinding);
  } catch {
    return null;
  }
}

const CODEX_OWNER_BINDING_MODES = new Set([
  "native_custom_agent",
  "run_scoped_owner_contract",
]);

function boundedJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || value.length > 100_000) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function boundedCodexIdentity(value) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value.trim()
    : null;
}

function codexWorkerEnvelope(input) {
  const parsedInput = boundedJsonObject(input);
  return boundedJsonObject(parsedInput?.message);
}

function codexOwnerBindingClaim(envelope) {
  const modeCandidates = [envelope?.ownerBindingMode].filter((value) => value != null);
  const nativeAgentTypeCandidates = [envelope?.nativeAgentType].filter((value) => value != null);
  const modes = [...new Set(modeCandidates.map((value) => String(value).trim()))];
  const nativeAgentTypes = [
    ...new Set(nativeAgentTypeCandidates.map((value) => boundedCodexIdentity(value))),
  ];
  if (
    modes.length !== 1 ||
    modes.length > 1 ||
    modes.some((mode) => !CODEX_OWNER_BINDING_MODES.has(mode)) ||
    nativeAgentTypes.includes(null) ||
    nativeAgentTypes.length > 1
  ) {
    return { valid: false, mode: null, nativeAgentType: null };
  }
  return {
    valid: true,
    mode: modes[0] ?? null,
    nativeAgentType: nativeAgentTypes[0] ?? null,
  };
}

export function observeCodexOwnerBinding(input) {
  const parsedInput = boundedJsonObject(input);
  const envelope = codexWorkerEnvelope(parsedInput);
  const hasAgentType = Object.prototype.hasOwnProperty.call(parsedInput ?? {}, "agent_type");
  const nativeAgentType = hasAgentType ? boundedCodexIdentity(parsedInput.agent_type) : null;
  const ownerBindingMode = nativeAgentType
    ? "native_custom_agent"
    : "run_scoped_owner_contract";
  const claim = codexOwnerBindingClaim(envelope);
  let mismatchReason = null;
  if (hasAgentType && !nativeAgentType) {
    mismatchReason = "invalid_host_agent_type";
  } else if (!claim.valid) {
    mismatchReason = "invalid_owner_binding_mode_claim";
  } else if (claim.mode && claim.mode !== ownerBindingMode) {
    mismatchReason = "claimed_owner_binding_mode_mismatch";
  } else if (claim.nativeAgentType && claim.nativeAgentType !== nativeAgentType) {
    mismatchReason = "claimed_native_agent_type_mismatch";
  } else if (claim.nativeAgentType && ownerBindingMode !== "native_custom_agent") {
    mismatchReason = "native_agent_type_claim_without_host_agent_type";
  } else if (
    ownerBindingMode === "native_custom_agent" &&
    envelope?.ownerAgent !== nativeAgentType
  ) {
    mismatchReason = "native_agent_type_owner_mismatch";
  } else if (
    ownerBindingMode === "native_custom_agent" &&
    (
      envelope?.ownerDefinition?.format !== "codex_custom_agent_toml" ||
      envelope?.ownerDefinition?.nativeCustomAgentEligible !== true ||
      envelope?.ownerDefinition?.nativeAgentName !== nativeAgentType ||
      !/\.toml$/iu.test(String(envelope?.ownerSource ?? envelope?.ownerDefinition?.sourceRef ?? ""))
    )
  ) {
    mismatchReason = "native_custom_agent_owner_definition_not_validated_toml";
  }
  return {
    ownerBindingMode,
    nativeAgentType,
    claimedOwnerBindingMode: claim.mode,
    ownerBindingModeEvidence: nativeAgentType
      ? "tool_input.agent_type"
      : "tool_input.agent_type_absent",
    ownerBindingModeValidation: mismatchReason ? "mismatch" : "matched_or_host_derived",
    ownerBindingMismatchReason: mismatchReason,
  };
}

export function extractMetaKimBinding(input) {
  let parsed = input;
  if (typeof input === "string") {
    const textMarker = markerFromText(input);
    if (textMarker) return textMarker;
    if (input.length > MAX_META_KIM_BINDING_JSON) return null;
    try {
      parsed = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const direct = validateMetaKimBinding(parsed.metaKimBinding);
  if (direct) return direct;
  for (const field of ["message", "prompt"]) {
    const nested = markerFromText(parsed[field]) ?? bindingFromJsonEnvelope(parsed[field]);
    if (nested) return nested;
  }
  return null;
}

function rawHostTimestamp(recordValue, payload = null) {
  const candidate =
    recordValue?.timestamp ??
    payload?.timestamp ??
    payload?.occurred_at ??
    payload?.occurredAt ??
    payload?.occurred_at_ms ??
    null;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return new Date(candidate).toISOString();
  }
  if (typeof candidate === "string" && Number.isFinite(Date.parse(candidate))) return candidate;
  return null;
}

function encryptedBindingPayload(input) {
  if (typeof input === "string" && input.length <= 100_000) {
    if (/^gAAAAA[A-Za-z0-9_-]{20,}={0,2}$/u.test(input)) return true;
    try {
      return encryptedBindingPayload(JSON.parse(input));
    } catch {
      return false;
    }
  }
  if (!input || typeof input !== "object") return false;
  return Boolean(
    input.encrypted === true ||
    input.encrypted_content ||
    input.encryptedContent ||
    input.ciphertext ||
    input.cipher_text ||
    encryptedBindingPayload(input.message) ||
    encryptedBindingPayload(input.prompt),
  );
}

function commandScriptProviderMatches(input, providerId) {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch {
      parsed = { command: input };
    }
  }
  const argv = Array.isArray(parsed?.argv)
    ? parsed.argv
    : Array.isArray(parsed?.command)
      ? parsed.command
      : null;
  const command = typeof parsed?.command === "string" ? parsed.command : null;
  const forbiddenShellSyntax = /[\r\n;&|<>`{}()#^]|\$\{|\$\(|@\(/u;
  if (command != null && forbiddenShellSyntax.test(command)) return false;
  if (
    command != null &&
    (((command.match(/"/gu) ?? []).length % 2 !== 0) ||
      ((command.match(/'/gu) ?? []).length % 2 !== 0))
  ) return false;
  if (
    argv != null &&
    (!argv.every((token) => typeof token === "string") ||
      argv.some((token) => forbiddenShellSyntax.test(token)))
  ) return false;
  const tokens = argv ?? command?.match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? [];
  const normalizeToken = (value) =>
    String(value)
      .replace(/^["']|["']$/gu, "")
      .replaceAll("\\", "/")
      .replace(/^\.\//u, "");
  const expected = normalizeToken(providerId);
  const normalized = tokens.map(normalizeToken);
  if (normalized.length === 0 || !expected) return false;
  if (normalized[0] === expected) return true;
  const executable = normalized[0].split("/").at(-1)?.toLowerCase();
  const directInterpreters = new Set([
    "node",
    "node.exe",
    "python",
    "python.exe",
    "python3",
    "python3.exe",
    "deno",
    "deno.exe",
    "bun",
    "bun.exe",
    "ruby",
    "ruby.exe",
    "perl",
    "perl.exe",
  ]);
  return directInterpreters.has(executable) && normalized[1] === expected;
}

function skillProviderMatches(input, providerId) {
  const parsed = boundedJsonObject(input);
  const actualProvider = [
    parsed?.skill,
    parsed?.skillId,
    parsed?.skill_id,
    parsed?.providerId,
  ]
    .map((value) => boundedCodexIdentity(value))
    .find(Boolean);
  return Boolean(actualProvider) && actualProvider === providerId;
}

function mcpProviderMatches(event, providerId) {
  return typeof providerId === "string" &&
    providerId.length > 0 &&
    event?.hostSurface === providerId;
}

function markerBindingRefJoinsProvider(marker) {
  const family = boundedCodexIdentity(marker?.family);
  const providerId = boundedCodexIdentity(marker?.providerId);
  const bindingRef = boundedCodexIdentity(marker?.bindingRef);
  return Boolean(family && providerId && bindingRef) &&
    bindingRef.includes(`:${family}:${providerId}`);
}

function exactHostSurfaceBindingMatches(event, marker) {
  return marker?.providerId === event?.hostSurface &&
    markerBindingRefJoinsProvider(marker);
}

function agentSubagentBindingMatches(input, marker) {
  const parsedInput = boundedJsonObject(input);
  const envelope = codexWorkerEnvelope(parsedInput);
  const ownerAgent = boundedCodexIdentity(envelope?.ownerAgent);
  if (!ownerAgent || marker?.family !== "agent_subagent") return false;
  if (
    boundedCodexIdentity(envelope?.taskPacketId) !== marker.taskPacketId ||
    boundedCodexIdentity(envelope?.roleInstanceId) !== marker.roleInstanceId
  ) return false;

  const providerId = boundedCodexIdentity(marker.providerId);
  const providerMatchesOwner = providerId === ownerAgent ||
    providerId?.endsWith(`:${ownerAgent}`) === true;
  if (!providerMatchesOwner) return false;

  const bindingRef = boundedCodexIdentity(marker.bindingRef);
  const providerJoin = `:agent_subagent:${providerId}`;
  const taskPacketJoin = marker.taskPacketId;
  return Boolean(bindingRef) &&
    bindingRef.includes(providerJoin) &&
    (bindingRef.startsWith(`${taskPacketJoin}:`) || bindingRef.endsWith(`:${taskPacketJoin}`));
}

export function normalizeObservedEventBinding(event, input, hostOccurredAt = null) {
  if (event?.ownerBindingModeValidation === "mismatch") {
    return {
      ...event,
      hostObservedFamily: event.family,
      bindingUnavailableReason:
        event.ownerBindingMismatchReason ?? "owner_binding_mode_mismatch",
    };
  }
  const marker = extractMetaKimBinding(input);
  if (!marker) {
    return {
      ...event,
      bindingUnavailableReason: encryptedBindingPayload(input)
        ? "encrypted_payload_without_host_binding_metadata"
        : "meta_kim_binding_missing_or_invalid",
    };
  }
  if (
    marker.family === "command_script" &&
    !commandScriptProviderMatches(input, marker.providerId)
  ) {
    return {
      ...event,
      hostObservedFamily: event.family,
      markerOccurredAt: marker.occurredAt,
      metaKimBinding: marker,
      bindingUnavailableReason: "command_script_provider_not_in_executed_argv",
    };
  }
  if (marker.family === "skill" && !skillProviderMatches(input, marker.providerId)) {
    return {
      ...event,
      hostObservedFamily: event.family,
      markerOccurredAt: marker.occurredAt,
      bindingUnavailableReason: "skill_provider_not_in_host_input",
    };
  }
  if (marker.family === "mcp" && !mcpProviderMatches(event, marker.providerId)) {
    return {
      ...event,
      hostObservedFamily: event.family,
      markerOccurredAt: marker.occurredAt,
      bindingUnavailableReason: "mcp_provider_does_not_match_host_surface",
    };
  }
  if (marker.family === "hook" && !exactHostSurfaceBindingMatches(event, marker)) {
    return {
      ...event,
      hostObservedFamily: event.family,
      markerOccurredAt: marker.occurredAt,
      bindingUnavailableReason: "hook_binding_does_not_match_host_surface",
    };
  }
  if (
    marker.family === "runtime_tool" &&
    !exactHostSurfaceBindingMatches(event, marker)
  ) {
    return {
      ...event,
      hostObservedFamily: event.family,
      markerOccurredAt: marker.occurredAt,
      bindingUnavailableReason: "runtime_tool_binding_does_not_match_host_surface",
    };
  }
  if (
    marker.family === "agent_subagent" &&
    CODEX_OWNER_BINDING_MODES.has(event?.ownerBindingMode) &&
    !agentSubagentBindingMatches(input, marker)
  ) {
    return {
      ...event,
      hostObservedFamily: event.family,
      markerOccurredAt: marker.occurredAt,
      bindingUnavailableReason: "agent_binding_does_not_match_owner_envelope",
    };
  }
  return {
    ...event,
    hostObservedFamily: event.family,
    ...marker,
    occurredAt: hostOccurredAt,
    markerOccurredAt: marker.occurredAt,
    metaKimBinding: marker,
    bindingUnavailableReason: hostOccurredAt ? null : "raw_host_timestamp_missing",
  };
}

function parentAgentPathFor(taskPath) {
  if (typeof taskPath !== "string" || !taskPath.startsWith("/root/")) return null;
  const parts = taskPath.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `/${parts.slice(0, -1).join("/")}`;
}

function firstBoundedIdentity(...values) {
  for (const value of values.flat(Infinity)) {
    const identity = boundedCodexIdentity(value);
    if (identity) return identity;
  }
  return null;
}

function codexCollaborationChildId(item) {
  return firstBoundedIdentity(
    item?.child_thread_id,
    item?.agent_thread_id,
    item?.new_thread_id,
    item?.receiver_thread_id,
    item?.receiver_thread_ids,
    item?.receiver?.thread_id,
    item?.receivers?.map((receiver) => receiver?.thread_id),
  );
}

function codexCollaborationArguments(item) {
  const raw = item?.arguments ?? item?.input ?? item?.tool_input;
  const parsed = boundedJsonObject(raw);
  const synthesized = parsed ? { ...parsed } : {};
  for (const key of ["agent_type", "task_name", "message", "fork_turns"]) {
    if (synthesized[key] == null && item?.[key] != null) synthesized[key] = item[key];
  }
  return Object.keys(synthesized).length > 0 ? synthesized : raw ?? {};
}

function codexCollaborationName(item) {
  const raw = item?.tool ?? item?.name ?? item?.tool_name ?? item?.action;
  const normalized = String(raw ?? "").replace(/^collaboration[.:]/iu, "");
  return normalized || (item?.type === "collab_tool_call" ? "spawn_agent" : item?.type);
}

function classifyTool(name, namespace = "") {
  const normalized = `${namespace}:${name}`.toLowerCase();
  if (["spawn_agent", "followup_task", "agent", "task"].includes(String(name).toLowerCase())) {
    return "agent_subagent";
  }
  if (String(name).toLowerCase() === "skill") return "skill";
  if (normalized.includes("mcp") || String(namespace).startsWith("mcp__")) return "mcp";
  if (["bash", "shell_command", "exec_command"].includes(String(name).toLowerCase())) {
    // A generic shell call is only a runtime tool observation. It becomes
    // command_script evidence later, after an exact argv/provider/binding join.
    return "runtime_tool";
  }
  return "runtime_tool";
}

function completedStatus(value) {
  return value == null || ["completed", "success", "returned", "verified"].includes(value);
}

function textFromCodexAgentMessage(item) {
  if (typeof item?.text === "string") return item.text;
  const content = item?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((entry) => ["input_text", "output_text", "text"].includes(entry?.type) && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("");
}

function deterministicMessageId({ sessionId, line, text, turnId = null, author = null }) {
  return `message-${sha256(JSON.stringify({ sessionId, line, text, turnId, author })).slice(0, 24)}`;
}

function matchesExpectedObservation(observation, expected = {}) {
  return (
    (!expected.sessionId || observation.sessionId === expected.sessionId) &&
    (!expected.messageId || observation.messageId === expected.messageId) &&
    (!expected.textSha256 || observation.textSha256 === expected.textSha256)
  );
}

export function observeCodexAssistantMessages(text, expected = {}) {
  const records = parseJsonl(text);
  const threadId = records
    .map((record) =>
      record.value?.type === "session_meta"
        ? record.value?.payload?.id ?? record.value?.payload?.session_id ?? null
        : record.value?.type === "thread.started"
          ? record.value.thread_id ?? null
          : null,
    )
    .find(Boolean) ?? null;
  const observations = [];
  for (const record of records) {
    if (["session_meta", "thread.started"].includes(record.value?.type)) continue;
    if (
      record.value?.type === "event_msg" &&
      record.value?.payload?.type === "agent_message"
    ) {
      const payload = record.value.payload;
      const messageText = typeof payload.message === "string" ? payload.message : "";
      const phase = payload.phase;
      if (
        !threadId ||
        !messageText ||
        !["commentary", "final"].includes(phase) ||
        payload.agent_thread_id != null ||
        payload.child_thread_id != null
      ) continue;
      const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id ?? null;
      const messageId = payload.id ?? deterministicMessageId({
        sessionId: threadId,
        line: record.line,
        text: messageText,
        turnId,
      });
      const observation = {
        observerFormat: "codex_desktop_assistant_message_v1",
        observationKind: "assistant_message",
        runtime: "codex",
        eventId: messageId,
        messageId,
        sessionId: threadId,
        text: messageText,
        textSha256: sha256(messageText),
        resultStatus: "completed",
        mainThreadChat: true,
        phase,
        completionBoundary: `event_msg:${phase}`,
        sourceLines: [record.line],
      };
      if (matchesExpectedObservation(observation, expected)) observations.push(observation);
      continue;
    }
    if (record.value?.type !== "item.completed" || record.value?.item?.type !== "agent_message") continue;
    const item = record.value.item;
    const messageText = textFromCodexAgentMessage(item);
    const sessionId = item.thread_id ?? item.session_id ?? threadId;
    const messageId = item.id ?? item.message_id ?? null;
    if (
      !messageText ||
      !sessionId ||
      !messageId ||
      item.agent_thread_id != null ||
      item.child_thread_id != null ||
      sessionId !== threadId ||
      !completedStatus(item.status) ||
      item.error != null ||
      item.is_error === true
    ) continue;
    const observation = {
      observerFormat: "codex_assistant_message_v1",
      observationKind: "assistant_message",
      runtime: "codex",
      eventId: messageId,
      messageId,
      sessionId,
      text: messageText,
      textSha256: sha256(messageText),
      resultStatus: "completed",
      mainThreadChat: true,
      sourceLines: [record.line],
    };
    if (matchesExpectedObservation(observation, expected)) observations.push(observation);
  }
  return observations;
}

export function observeClaudeAssistantMessages(text, expected = {}) {
  const records = parseJsonl(text);
  const rootSessionId = records
    .map((record) => {
      const payload = payloadOf(record.value);
      if (
        record.value?.type !== "assistant" ||
        payload?.agent_id != null ||
        payload?.agentId != null ||
        payload?.agent_thread_id != null ||
        payload?.child_thread_id != null ||
        payload?.parent_tool_use_id != null
      ) return null;
      return payload?.session_id ?? payload?.sessionId ?? null;
    })
    .find(Boolean) ?? null;
  const observations = [];
  for (const record of records) {
    const payload = payloadOf(record.value);
    if (record.value?.type !== "assistant" || !payload?.message) continue;
    const message = payload.message;
    const messageText = Array.isArray(message.content)
      ? message.content
          .filter((item) => item?.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("")
      : "";
    const sessionId = payload.session_id ?? payload.sessionId ?? null;
    const messageId = message.id ?? null;
    const stopReason = message.stop_reason ?? message.stopReason ?? null;
    if (
      !messageText ||
      !sessionId ||
      !rootSessionId ||
      sessionId !== rootSessionId ||
      !messageId ||
      payload.agent_id != null ||
      payload.agentId != null ||
      payload.agent_thread_id != null ||
      payload.child_thread_id != null ||
      payload.parent_tool_use_id != null ||
      !["end_turn", "tool_use", "stop_sequence", "max_tokens"].includes(stopReason) ||
      payload.error != null ||
      payload.is_error === true
    ) continue;
    const observation = {
      observerFormat: "claude_assistant_message_v1",
      observationKind: "assistant_message",
      runtime: "claude",
      eventId: messageId,
      messageId,
      sessionId,
      text: messageText,
      textSha256: sha256(messageText),
      resultStatus: "completed",
      mainThreadChat: true,
      stopReason,
      sourceLines: [record.line],
    };
    if (matchesExpectedObservation(observation, expected)) observations.push(observation);
  }
  return observations;
}

export function observeCodexJsonl(text) {
  const records = parseJsonl(text);
  const calls = new Map();
  const outputs = new Map();
  const agentStarts = new Map();
  const agentCompletions = new Map();
  const agentMessages = new Map();
  const childAuthoredMessages = [];
  let threadId = null;
  let crossSessionCorrelationDetected = false;
  const rootSessionIds = new Set();
  const callSessions = new Map();
  const registerCallSession = (callId, sessionId) => {
    if (!callId || !sessionId) return;
    const prior = callSessions.get(callId);
    if (prior && prior !== sessionId) crossSessionCorrelationDetected = true;
    callSessions.set(callId, sessionId);
  };
  for (const record of records) {
    const payload = payloadOf(record.value);
    if (record.value?.type === "session_meta") {
      threadId = record.value?.payload?.id ?? record.value?.payload?.session_id ?? threadId;
      if (threadId) rootSessionIds.add(threadId);
      continue;
    }
    if (record.value?.type === "thread.started") {
      threadId = record.value.thread_id ?? null;
      if (threadId) rootSessionIds.add(threadId);
    }
    if (
      record.value?.type === "response_item" &&
      payload?.type === "agent_message" &&
      typeof payload.author === "string" &&
      typeof payload.recipient === "string"
    ) {
      const messageText = textFromCodexAgentMessage(payload);
      const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id ?? null;
      if (messageText) {
        childAuthoredMessages.push({
          line: record.line,
          observedAt: rawHostTimestamp(record.value, payload),
          item: payload,
          text: messageText,
          author: payload.author,
          recipient: payload.recipient,
          messageId: payload.id ?? deterministicMessageId({
            sessionId: threadId,
            line: record.line,
            text: messageText,
            turnId,
            author: payload.author,
          }),
        });
      }
    }
    if (record.value?.type === "item.started" && record.value?.item?.id) {
      const item = record.value.item;
      const mappedName = item.type === "command_execution"
        ? "shell_command"
        : item.type === "collab_tool_call"
          ? codexCollaborationName(item)
          : item.name ?? item.tool_name ?? item.type;
      const collabChildId = item.type === "collab_tool_call"
        ? codexCollaborationChildId(item)
        : null;
      registerCallSession(item.id, threadId);
      calls.set(item.id, {
        line: record.line,
        observedAt: rawHostTimestamp(record.value, item),
        payload: {
          type: "function_call",
          call_id: item.id,
          name: mappedName,
          namespace: item.namespace ?? "codex_cli",
          arguments: item.type === "collab_tool_call"
            ? codexCollaborationArguments(item)
            : item.command ?? item.arguments ?? item.input ?? "",
          session_id: threadId,
          itemType: item.type,
        },
      });
      if (collabChildId) {
        const activity = {
          line: record.line,
          observedAt: rawHostTimestamp(record.value, item),
          payload: {
            ...item,
            kind: "started",
            child_thread_id: collabChildId,
          },
        };
        agentStarts.set(item.id, activity);
        agentStarts.set(`child:${collabChildId}`, activity);
      }
    }
    if (record.value?.type === "item.completed" && record.value?.item?.id) {
      const item = record.value.item;
      registerCallSession(item.id, threadId);
      if (item.type === "agent_message") {
        const messageText = textFromCodexAgentMessage(item);
        const childId = item.agent_thread_id ?? item.child_thread_id ?? null;
        const taskPath = item.task_path ?? item.path ?? null;
        if (
          messageText &&
          completedStatus(item.status) &&
          item.error == null &&
          item.is_error !== true
        ) {
          const entry = {
            line: record.line,
            observedAt: rawHostTimestamp(record.value, item),
            item,
            text: messageText,
          };
          if (childId) agentMessages.set(`child:${childId}`, entry);
          if (taskPath) agentMessages.set(`path:${taskPath}`, entry);
          if (item.call_id) agentMessages.set(`call:${item.call_id}`, entry);
        }
      }
      const commandCompletedSuccessfully =
        item.type !== "command_execution" ||
        (Number.isInteger(item.exit_code) && item.exit_code === 0);
      const itemCompletedSuccessfully =
        completedStatus(item.status) &&
        item.error == null &&
        item.is_error !== true &&
        commandCompletedSuccessfully;
      if (itemCompletedSuccessfully) {
        outputs.set(item.id, {
          line: record.line,
          observedAt: rawHostTimestamp(record.value, item),
          payload: {
            type: "function_call_output",
            call_id: item.id,
            output: item.aggregated_output ?? item.result ?? item.output ?? "",
            session_id: threadId,
            exit_code: item.exit_code,
          },
        });
        if (item.type === "collab_tool_call") {
          const childId = codexCollaborationChildId(item);
          if (childId) {
            const started = agentStarts.get(item.id) ?? {
              line: calls.get(item.id)?.line ?? record.line,
              observedAt: calls.get(item.id)?.observedAt ?? rawHostTimestamp(record.value, item),
              payload: {
                kind: "started",
              },
            };
            const startWithChild = {
              ...started,
              payload: {
                ...started.payload,
                child_thread_id: childId,
              },
            };
            agentStarts.set(item.id, startWithChild);
            agentStarts.set(`child:${childId}`, startWithChild);
            const completion = {
              line: record.line,
              observedAt: rawHostTimestamp(record.value, item),
              payload: {
                ...item,
                kind: "completed",
                child_thread_id: childId,
                success: true,
              },
            };
            agentCompletions.set(item.id, completion);
            agentCompletions.set(`child:${childId}`, completion);
          }
        }
      }
    }
    if (payload?.type === "function_call") {
      const callId = payload.call_id ?? payload.callId;
      registerCallSession(callId, payload.session_id ?? payload.sessionId ?? threadId);
      if (callId) {
        calls.set(callId, {
          line: record.line,
          observedAt: rawHostTimestamp(record.value, payload),
          payload: { ...payload, session_id: payload.session_id ?? payload.sessionId ?? threadId },
        });
      }
    }
    if (payload?.type === "function_call_output") {
      const callId = payload.call_id ?? payload.callId;
      registerCallSession(callId, payload.session_id ?? payload.sessionId ?? threadId);
      const outputText = typeof payload.output === "string"
        ? payload.output
        : JSON.stringify(payload.output ?? payload.result ?? "");
      const call = callId ? calls.get(callId) : null;
      const callName = String(call?.payload?.name ?? "").toLowerCase();
      const commandLike =
        call?.payload?.itemType === "command_execution" ||
        ["bash", "shell_command", "exec_command"].includes(callName);
      const explicitExitCode = payload.exit_code ?? payload.exitCode;
      const parsedExitCode = outputText.match(
        /(?:^|\n)\s*(?:exit code|exit_code)\s*[:=]\s*(-?\d+)\b/i,
      );
      const hasSuccessfulCommandExit =
        !commandLike ||
        (explicitExitCode !== undefined && Number(explicitExitCode) === 0) ||
        (parsedExitCode && Number(parsedExitCode[1]) === 0);
      const failed =
        payload.is_error === true ||
        payload.error != null ||
        !hasSuccessfulCommandExit ||
        (explicitExitCode !== undefined && Number(explicitExitCode) !== 0) ||
        /(?:^|\n)\s*(?:exit code|exit_code)\s*[:=]\s*[1-9]\d*\b/i.test(outputText) ||
        /(?:^|\n)\s*(?:error|failed)\s*:/i.test(outputText);
      if (callId && !failed) {
        outputs.set(callId, {
          line: record.line,
          observedAt: rawHostTimestamp(record.value, payload),
          payload,
        });
      }
    }
    if (
      payload?.type === "sub_agent_activity" &&
      ["started", "interacted"].includes(payload?.kind)
    ) {
      const callId = payload.event_id ?? payload.call_id ?? payload.parent_call_id ?? payload.request_id;
      const activity = {
        line: record.line,
        observedAt: rawHostTimestamp(record.value, payload),
        payload,
      };
      if (callId) agentStarts.set(callId, activity);
      const childId = payload.agent_thread_id ?? payload.child_thread_id;
      const taskPath = payload.agent_path ?? payload.task_path ?? payload.path;
      if (childId) agentStarts.set(`child:${childId}`, activity);
      if (taskPath) agentStarts.set(`path:${taskPath}`, activity);
    }
    if (
      payload?.type === "sub_agent_activity" &&
      ["completed", "task_complete", "result", "returned"].includes(payload?.kind)
    ) {
      const callId = payload.event_id ?? payload.call_id ?? payload.parent_call_id ?? payload.request_id;
      const childId = payload.agent_thread_id ?? payload.child_thread_id;
      const taskPath = payload.agent_path ?? payload.task_path ?? payload.path;
      const completionStatus = payload.status ?? payload.result_status ?? payload.outcome;
      const completionSucceeded =
        payload.success === true ||
        ["success", "completed", "returned", "verified"].includes(completionStatus);
      if (!completionSucceeded || payload.error != null || payload.is_error === true) continue;
      const completion = {
        line: record.line,
        observedAt: rawHostTimestamp(record.value, payload),
        payload,
      };
      if (callId) agentCompletions.set(callId, completion);
      if (childId) agentCompletions.set(`child:${childId}`, completion);
      if (taskPath) agentCompletions.set(`path:${taskPath}`, completion);
    }
  }
  if (rootSessionIds.size > 1 || crossSessionCorrelationDetected) return [];
  const events = [];
  const consumedResultKeys = new Set();
  for (const [callId, call] of calls) {
    const output = outputs.get(callId);
    if (!output) continue;
    const name = String(call.payload.name ?? "unknown").toLowerCase();
    const namespace = call.payload.namespace ?? "";
    const family = call.payload.itemType === "mcp_tool_call"
      ? "mcp"
      : classifyTool(name, namespace);
    const agentStart = agentStarts.get(callId);
    const childSessionId = agentStart?.payload?.agent_thread_id ?? agentStart?.payload?.child_thread_id ?? null;
    const taskPath = agentStart?.payload?.agent_path ?? agentStart?.payload?.task_path ?? agentStart?.payload?.path ?? null;
    const agentCompletion = agentCompletions.get(callId) ??
      (childSessionId ? agentCompletions.get(`child:${childSessionId}`) : null) ??
      (taskPath ? agentCompletions.get(`path:${taskPath}`) : null);
    const storedAgentMessage = agentMessages.get(`call:${callId}`) ??
      (childSessionId ? agentMessages.get(`child:${childSessionId}`) : null) ??
      (taskPath ? agentMessages.get(`path:${taskPath}`) : null);
    const desktopCollaborationLifecycle =
      family === "agent_subagent" &&
      ["spawn_agent", "followup_task"].includes(name) &&
      Boolean(taskPath);
    const activityKind = agentStart?.payload?.kind;
    const activityMatchesRequest = name === "followup_task"
      ? activityKind === "interacted"
      : ["started", "interacted"].includes(activityKind);
    const afterLine = Math.max(call.line ?? 0, output.line ?? 0, agentStart?.line ?? 0);
    const parentAgentPath = parentAgentPathFor(taskPath);
    const childAuthoredResult = desktopCollaborationLifecycle
      ? childAuthoredMessages.find(
          (entry) =>
            entry.line > afterLine &&
            entry.author === taskPath &&
            parentAgentPath != null &&
            entry.recipient === parentAgentPath &&
            !consumedResultKeys.has(`message:${entry.messageId}`),
        )
      : null;
    const storedResultMatches =
      storedAgentMessage &&
      storedAgentMessage.line > afterLine &&
      (storedAgentMessage.item?.agent_thread_id ?? storedAgentMessage.item?.child_thread_id) === childSessionId &&
      (storedAgentMessage.item?.agent_path ?? storedAgentMessage.item?.task_path ?? storedAgentMessage.item?.path) === taskPath &&
      !consumedResultKeys.has(`line:${storedAgentMessage.line}`);
    const desktopReturnedMessage = childAuthoredResult ?? (storedResultMatches ? storedAgentMessage : null);
    const returnedAgentMessage = desktopReturnedMessage ?? storedAgentMessage;
    if (family === "agent_subagent" && !childSessionId) continue;
    if (
      family === "agent_subagent" &&
      desktopCollaborationLifecycle &&
      (!activityMatchesRequest || !desktopReturnedMessage)
    ) continue;
    if (
      family === "agent_subagent" &&
      !desktopCollaborationLifecycle &&
      !agentCompletion
    ) continue;
    const callSessionId = call.payload.session_id ?? null;
    const outputSessionId = output.payload.session_id ?? callSessionId;
    if (callSessionId && outputSessionId && callSessionId !== outputSessionId) continue;
    const resultOutput = returnedAgentMessage?.text ?? output.payload.output ?? output.payload.result ?? "";
    const toolInput = call.payload.arguments ?? call.payload.input ?? null;
    const ownerBindingObservation = family === "agent_subagent"
      ? observeCodexOwnerBinding(toolInput)
      : {};
    const baseEvent = {
      observerFormat: "codex_host_jsonl_v1",
      family,
      eventId: callId,
      parentEventId: null,
      hostSurface: namespace ? `${namespace}.${name}` : name,
      providerId: namespace ? `${namespace}.${name}` : name,
      resultStatus: desktopCollaborationLifecycle ? "returned" : "completed",
      inputDigest: sha256(call.payload.arguments ?? call.payload.input ?? ""),
      outputDigest: sha256(resultOutput),
      childSessionId,
      taskPath,
      parentAgentPath,
      sessionId: call.payload.session_id ?? output.payload.session_id ?? null,
      resultMessageId: returnedAgentMessage?.messageId ?? returnedAgentMessage?.item?.id ?? null,
      resultTextSha256: returnedAgentMessage ? sha256(returnedAgentMessage.text) : null,
      sourceLines: [
        call.line,
        output.line,
        agentStart?.line,
        agentCompletion?.line,
        returnedAgentMessage?.line,
      ].filter(Boolean),
      lifecycleEvidence: desktopCollaborationLifecycle
        ? "desktop_collaboration_returned_agent_message"
        : "host_call_and_child_completion",
      completionBoundary: desktopCollaborationLifecycle
        ? "returned_child_final"
        : "completed_activity_observed",
      activityCompletionObserved: Boolean(agentCompletion),
      ...ownerBindingObservation,
    };
    events.push(normalizeObservedEventBinding(
      baseEvent,
      toolInput,
      returnedAgentMessage?.observedAt ?? agentCompletion?.observedAt ?? output.observedAt ?? null,
    ));
    if (returnedAgentMessage?.messageId) {
      consumedResultKeys.add(`message:${returnedAgentMessage.messageId}`);
    }
    if (returnedAgentMessage?.line) {
      consumedResultKeys.add(`line:${returnedAgentMessage.line}`);
    }
  }
  return events;
}

function claudeContentRecords(records) {
  const result = [];
  for (const record of records) {
    const payload = payloadOf(record.value);
    const content = payload?.message?.content ?? payload?.content ?? [];
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      result.push({
        line: record.line,
        observedAt: rawHostTimestamp(record.value, payload),
        item,
        payload,
      });
    }
  }
  return result;
}

export function observeClaudeJsonl(text) {
  const records = parseJsonl(text);
  const content = claudeContentRecords(records);
  const calls = new Map();
  const results = new Map();
  const events = [];
  for (const entry of content) {
    if (entry.item?.type === "tool_use" && entry.item?.id) calls.set(entry.item.id, entry);
    if (entry.item?.type === "tool_result" && entry.item?.tool_use_id) {
      results.set(entry.item.tool_use_id, entry);
    }
  }
  for (const [callId, call] of calls) {
    const output = results.get(callId);
    if (!output || output.item?.is_error === true) continue;
    const name = call.item.name ?? "unknown";
    const baseEvent = {
      observerFormat: "claude_stream_json_v1",
      family: classifyTool(name),
      eventId: callId,
      parentEventId: null,
      hostSurface: name,
      providerId: name,
      resultStatus: "completed",
      inputDigest: sha256(JSON.stringify(call.item.input ?? {})),
      outputDigest: sha256(JSON.stringify(output.item.content ?? output.item)),
      childSessionId:
        output.payload?.tool_use_result?.agentId ??
        output.payload?.tool_use_result?.agent_id ??
        output.item?.agentId ??
        output.item?.agent_id ??
        null,
      batchId: call.payload?.message?.id ?? null,
      sessionId: call.payload?.session_id ?? output.payload?.session_id ?? null,
      sourceLines: [call.line, output.line],
    };
    if (baseEvent.family === "agent_subagent" && !baseEvent.childSessionId) continue;
    const callInput = call.item.input ?? null;
    const callMarker = extractMetaKimBinding(callInput);
    events.push(normalizeObservedEventBinding(
      baseEvent,
      callMarker?.family === "hook" ? null : callInput,
      output.observedAt ?? call.observedAt ?? null,
    ));
  }
  const hookStarts = new Map();
  for (const record of records) {
    const payload = payloadOf(record.value);
    if (record.value?.type === "system" && record.value?.subtype === "hook_started") {
      const hookId = record.value.hook_id ?? payload?.hook_id;
      if (hookId) {
        hookStarts.set(hookId, {
          line: record.line,
          observedAt: rawHostTimestamp(record.value, payload),
          payload: record.value,
        });
      }
      continue;
    }
    if (record.value?.type === "system" && record.value?.subtype === "hook_response") {
      const hookId = record.value.hook_id ?? payload?.hook_id;
      const started = hookStarts.get(hookId);
      const exitCode = Number(record.value.exit_code ?? payload?.exit_code ?? 1);
      const outcome = record.value.outcome ?? payload?.outcome;
      if (!hookId || !started || exitCode !== 0 || outcome !== "success") continue;
      const hookName = record.value.hook_name ?? started.payload?.hook_name ?? "hook";
      const parentEventId =
        record.value.tool_use_id ?? started.payload?.tool_use_id ?? null;
      const baseHookEvent = {
        observerFormat: "claude_hook_event_v1",
        family: "hook",
        eventId: `hook:${hookId}`,
        parentEventId,
        hostSurface: hookName,
        providerId: hookName,
        resultStatus: "completed",
        inputDigest: sha256(JSON.stringify(started.payload ?? {})),
        outputDigest: sha256(JSON.stringify(record.value ?? {})),
        childSessionId: null,
        sessionId: record.value.session_id ?? started.payload?.session_id ?? null,
        sourceLines: [started.line, record.line],
        correlationScope: parentEventId ? "tool_call" : "session",
      };
      const parentCallInput = parentEventId ? calls.get(parentEventId)?.item?.input ?? null : null;
      events.push(normalizeObservedEventBinding(
        baseHookEvent,
        parentCallInput,
        rawHostTimestamp(record.value, payload) ?? started.observedAt ?? null,
      ));
      continue;
    }
    const hook = payload?.hook_event ?? payload?.hookEvent ?? payload;
    if (!["hook_success", "hook_additional_context"].includes(hook?.type)) continue;
    const eventId = hook.tool_use_id ?? hook.toolUseID ?? hook.event_id;
    if (!eventId) continue;
    const baseHookEvent = {
      observerFormat: "claude_hook_event_v1",
      family: "hook",
      eventId: `hook:${eventId}:${hook.hookName ?? hook.hook_name ?? "unknown"}`,
      parentEventId: eventId,
      hostSurface: hook.hookName ?? hook.hook_name ?? "hook",
      providerId: hook.hookName ?? hook.hook_name ?? "hook",
      resultStatus: "completed",
      inputDigest: sha256(JSON.stringify(hook.input ?? {})),
      outputDigest: sha256(JSON.stringify(hook.output ?? {})),
      childSessionId: null,
      sessionId: payload?.session_id ?? null,
      sourceLines: [record.line],
    };
    const parentCallInput = calls.get(eventId)?.item?.input ?? null;
    events.push(normalizeObservedEventBinding(
      baseHookEvent,
      parentCallInput,
      rawHostTimestamp(record.value, payload),
    ));
  }
  return events;
}

export function observeMcpClientJsonl(text) {
  const records = parseJsonl(text).map((entry) => entry.value);
  const initialize = records.find((record) => record.phase === "initialize" && record.status === "success");
  const listed = records.find((record) => record.phase === "tools/list" && record.status === "success");
  const called = records.find((record) => record.phase === "tools/call" && record.status === "success");
  if (!initialize || !listed || !called || !called.callId || !called.toolName) return [];
  return [{
    observerFormat: "mcp_stdio_client_v1",
    family: "mcp",
    eventId: called.callId,
    parentEventId: initialize.sessionId ?? null,
    hostSurface: `mcp.${called.toolName}`,
    providerId: called.providerId ?? called.toolName,
    resultStatus: "completed",
    inputDigest: called.inputDigest ?? sha256(JSON.stringify(called.arguments ?? {})),
    outputDigest: called.outputDigest ?? sha256(JSON.stringify(called.result ?? {})),
    childSessionId: null,
    sourceLines: [],
  }];
}

export function lintBlindPrompt(prompt) {
  const forbidden = [
    /\bagents?\b/i, /subagent/i, /spawn[_ -]?agent/i, /\bskills?\b/i,
    /\bmcp\b/i, /\bhooks?\b/i, /\bcommands?\b/i, /\btools?\b/i, /\bparallel\b/i,
    /智能体|子代理|技能|钩子|命令|工具|并行|同时推进|并发|分头/g,
  ];
  const hits = forbidden.filter((pattern) => pattern.test(prompt)).map((pattern) => pattern.source);
  return { pass: hits.length === 0, hits };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const runtime = value("--runtime");
  const inputPath = value("--input");
  const outputPath = value("--output");
  if (!runtime || !inputPath || !outputPath) {
    throw new Error("Usage: observe-host-events.mjs --runtime codex|claude|mcp --input <raw.jsonl> --output <observed.json>");
  }
  const raw = await fs.readFile(path.resolve(inputPath), "utf8");
  const events = runtime === "codex"
    ? observeCodexJsonl(raw)
    : runtime === "claude"
      ? observeClaudeJsonl(raw)
      : observeMcpClientJsonl(raw);
  const assistantMessages = runtime === "codex"
    ? observeCodexAssistantMessages(raw)
    : runtime === "claude"
      ? observeClaudeAssistantMessages(raw)
      : [];
  const report = {
    schemaVersion: "clean-room-host-observation-v0.1",
    runtime,
    sourceArtifact: path.resolve(inputPath),
    sourceSha256: sha256(raw),
    events,
    assistantMessages,
  };
  await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const observed = events.length > 0 || assistantMessages.length > 0;
  process.stdout.write(`${JSON.stringify({
    status: observed ? "observed" : "no_events",
    eventCount: events.length,
    assistantMessageCount: assistantMessages.length,
  })}\n`);
  if (!observed) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
