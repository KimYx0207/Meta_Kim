import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { observeCodexJsonl } from "./observe-host-events.mjs";

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const SESSION_META_READ_LIMIT_BYTES = 1024 * 1024;
const MTIME_TOLERANCE_MS = 5_000;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CODE_MODE_SPAWN_PATTERN = /\btools\.multi_agent_v1__spawn_agent\s*\(/gu;

class CodexSessionEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "CodexSessionEvidenceError";
    this.code = code;
  }
}

function fail(code) {
  throw new CodexSessionEvidenceError(code);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function parseJsonlRecords(text) {
  return String(text)
    .split(/\r?\n/u)
    .map((line, index) => {
      if (!line.trim()) return null;
      try {
        return { line: index + 1, raw: line, value: JSON.parse(line) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function codeModeOutputText(payload) {
  if (typeof payload?.output === "string") return payload.output;
  if (!Array.isArray(payload?.output)) return "";
  return payload.output
    .filter((entry) =>
      entry &&
      typeof entry === "object" &&
      ["input_text", "output_text", "text"].includes(entry.type) &&
      typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

function codeModeStringField(input, field) {
  const match = new RegExp(
    `\\b${field}\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`,
    "u",
  ).exec(input);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" && value.length > 0 && value.length <= 100_000
      ? value
      : null;
  } catch {
    return null;
  }
}

function codeModeSpawnRequest(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > 100_000) {
    return null;
  }
  const matches = [...input.matchAll(CODE_MODE_SPAWN_PATTERN)];
  const executedCall = /^\s*(?:\/\/\s*@exec:[^\r\n]*(?:\r?\n))?\s*const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*await\s+tools\.multi_agent_v1__spawn_agent\s*\(\s*(\{[\s\S]*?\})\s*\)\s*;\s*text\s*\(\s*JSON\.stringify\s*\(\s*(?:\1|\{\s*\1\s*\})\s*\)\s*\)\s*;\s*(?:const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*await\s+tools\.multi_agent_v1__wait_agent\s*\(\s*\{\s*targets\s*:\s*\[\s*\1\.agent_id\s*\]\s*,\s*timeout_ms\s*:\s*[1-9][0-9]*\s*\}\s*\)\s*;\s*text\s*\(\s*JSON\.stringify\s*\(\s*(?:\3|\{\s*\3\s*\})\s*\)\s*\)\s*;\s*)?$/u.exec(input);
  if (
    matches.length !== 1 ||
    !executedCall ||
    /\btools\.(?:multi_agent_v1__)?(?:followup_task|send_message|interrupt_agent)\s*\(/u.test(input)
  ) {
    return null;
  }
  const invocationObject = executedCall[2];
  const message = codeModeStringField(invocationObject, "message");
  if (!message) return null;
  return {
    agentType: codeModeStringField(invocationObject, "agent_type"),
    message,
    input,
  };
}

function codeModeSpawnChildId(payload) {
  const candidates = codeModeOutputText(payload)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .map((line) => {
      try {
        const value = JSON.parse(line);
        if (THREAD_ID_PATTERN.test(String(value?.agent_id ?? ""))) {
          return value.agent_id;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return null;
        }
        const nested = Object.values(value).filter(
          (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
        );
        return nested.length === 1 ? nested[0].agent_id ?? null : null;
      } catch {
        return null;
      }
    })
    .filter((value) => THREAD_ID_PATTERN.test(String(value ?? "")));
  return [...new Set(candidates)].length === 1 ? candidates[0] : null;
}

function readCodeModeSpawnLifecycle(parentSessionText, threadId) {
  const records = parseJsonlRecords(parentSessionText);
  const calls = records
    .filter(({ value }) =>
      value?.type === "response_item" &&
      value?.payload?.type === "custom_tool_call" &&
      value?.payload?.name === "exec" &&
      typeof value?.payload?.call_id === "string")
    .map((entry) => ({
      ...entry,
      request: codeModeSpawnRequest(entry.value.payload.input),
    }))
    .filter((entry) => entry.request);
  if (calls.length === 0) return null;
  if (calls.length !== 1) fail("codex_parent_spawn_event_not_unique");
  const [call] = calls;
  const outputs = records.filter(({ value }) =>
    value?.type === "response_item" &&
    value?.payload?.type === "custom_tool_call_output" &&
    value?.payload?.call_id === call.value.payload.call_id);
  if (outputs.length !== 1) fail("codex_parent_spawn_output_not_unique");
  const childSessionId = codeModeSpawnChildId(outputs[0].value.payload);
  if (!childSessionId) fail("codex_parent_spawn_output_invalid");
  return {
    call,
    output: outputs[0],
    childSessionId,
    threadId,
  };
}

function readCodeModeChildFinal(childSessionText, childSessionId, sinceMs) {
  const records = parseJsonlRecords(childSessionText);
  const finals = records.filter(({ value }) =>
    value?.type === "event_msg" &&
    value?.payload?.type === "agent_message" &&
    value?.payload?.phase === "final_answer" &&
    typeof value?.payload?.message === "string" &&
    value.payload.message.length > 0);
  const completions = records.filter(({ value }) =>
    value?.type === "event_msg" &&
    value?.payload?.type === "task_complete" &&
    typeof value?.payload?.last_agent_message === "string");
  const messages = records.filter(({ value }) =>
    value?.type === "response_item" &&
    value?.payload?.type === "message" &&
    value?.payload?.role === "assistant" &&
    typeof value?.payload?.id === "string");
  if (finals.length !== 1 || completions.length !== 1 || messages.length !== 1) {
    fail("codex_child_final_invalid");
  }
  const finalText = finals[0].value.payload.message;
  if (completions[0].value.payload.last_agent_message !== finalText) {
    fail("codex_child_final_invalid");
  }
  const messageText = (messages[0].value.payload.content ?? [])
    .filter((entry) => entry?.type === "output_text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("");
  if (messageText !== finalText) fail("codex_child_final_invalid");
  const finalAtMs = Date.parse(finals[0].value.timestamp ?? "");
  const completedAtMs = Date.parse(completions[0].value.timestamp ?? "");
  if (
    !Number.isFinite(finalAtMs) ||
    !Number.isFinite(completedAtMs) ||
    finalAtMs < sinceMs ||
    completedAtMs < finalAtMs
  ) {
    fail("codex_child_timestamp_invalid");
  }
  return {
    childSessionId,
    finalText,
    resultMessageId: messages[0].value.payload.id,
    finalLine: finals[0].line,
    completionLine: completions[0].line,
    observedAt: new Date(completedAtMs).toISOString(),
  };
}

function isInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function assertPlainDirectory(directoryPath, invalidCode, symlinkCode) {
  const stats = await fs.lstat(directoryPath).catch(() => null);
  if (stats?.isSymbolicLink()) fail(symlinkCode);
  if (!stats?.isDirectory()) fail(invalidCode);
  const realPath = await fs.realpath(directoryPath).catch(() => null);
  if (!realPath) fail(invalidCode);
  return realPath;
}

async function listSessionFiles(sessionsRoot) {
  const files = [];
  const pending = [sessionsRoot];
  while (pending.length > 0) {
    const directoryPath = pending.pop();
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.resolve(directoryPath, entry.name);
      if (!isInside(sessionsRoot, entryPath)) fail("codex_session_path_escape");
      const stats = await fs.lstat(entryPath);
      if (stats.isSymbolicLink()) fail("codex_session_symlink_rejected");
      if (stats.isDirectory()) {
        pending.push(entryPath);
      } else if (stats.isFile() && entry.name.endsWith(".jsonl")) {
        files.push({ filePath: entryPath, stats });
      }
    }
  }
  return files;
}

async function readSessionMeta(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(SESSION_META_READ_LIMIT_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = prefix.indexOf("\n");
    if (newlineIndex < 0 && bytesRead === buffer.length) {
      return null;
    }
    const firstLine = (newlineIndex >= 0 ? prefix.slice(0, newlineIndex) : prefix).trim();
    if (!firstLine) return null;
    const record = JSON.parse(firstLine);
    return record?.type === "session_meta" ? record.payload ?? null : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

function isFresh(stats, sinceMs) {
  return stats.mtimeMs + MTIME_TOLERANCE_MS >= sinceMs;
}

async function readBoundedFile(file, maxBytes, sizeCode) {
  if (file.stats.size > maxBytes) fail(sizeCode);
  const realPath = await fs.realpath(file.filePath).catch(() => null);
  if (!realPath || realPath !== file.filePath) fail("codex_session_symlink_rejected");
  const handle = await fs.open(file.filePath, "r");
  try {
    const currentStats = await handle.stat();
    if (!currentStats.isFile() || currentStats.size > maxBytes) fail(sizeCode);
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text, "utf8") > maxBytes) fail(sizeCode);
    return text;
  } finally {
    await handle.close();
  }
}

/**
 * Recovers host events from the exact Codex exec session named by a
 * `thread.started` event. The returned session text is internal-only input for
 * the existing host observer; callers must expose only the digest/category/ids.
 *
 * @param {{
 *   codexHome?: string,
 *   threadId: string,
 *   sinceMs: number,
 *   maxBytes?: number,
 * }} options
 */
export async function readCodexSessionEvidence({
  codexHome,
  threadId,
  sinceMs,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  if (!THREAD_ID_PATTERN.test(String(threadId ?? ""))) {
    fail("codex_session_thread_id_invalid");
  }
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) {
    fail("codex_session_since_invalid");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    fail("codex_session_max_bytes_invalid");
  }

  const configuredHome = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  if (!path.isAbsolute(configuredHome)) fail("codex_home_must_be_absolute");
  const absoluteHome = path.resolve(configuredHome);
  const realHome = await assertPlainDirectory(
    absoluteHome,
    "codex_home_invalid",
    "codex_home_symlink_rejected",
  );
  if (realHome !== absoluteHome) fail("codex_home_symlink_rejected");

  const sessionsPath = path.resolve(absoluteHome, "sessions");
  if (!isInside(absoluteHome, sessionsPath)) fail("codex_session_path_escape");
  const sessionsRoot = await assertPlainDirectory(
    sessionsPath,
    "codex_sessions_invalid",
    "codex_sessions_symlink_rejected",
  );
  if (!isInside(realHome, sessionsRoot) || sessionsRoot !== sessionsPath) {
    fail("codex_sessions_symlink_rejected");
  }

  const files = await listSessionFiles(sessionsRoot);
  const parentSuffix = `-${threadId}.jsonl`;
  const parentCandidates = [];
  for (const file of files) {
    if (!path.basename(file.filePath).endsWith(parentSuffix)) continue;
    const meta = await readSessionMeta(file.filePath);
    if (
      meta?.id === threadId &&
      meta?.source === "exec" &&
      meta?.originator === "codex_exec"
    ) {
      parentCandidates.push({ ...file, meta });
    }
  }
  if (parentCandidates.length !== 1) fail("codex_parent_session_not_unique");
  const parent = parentCandidates[0];
  if (!isFresh(parent.stats, sinceMs)) fail("codex_parent_session_stale");
  const parentSessionText = await readBoundedFile(
    parent,
    maxBytes,
    "codex_parent_session_too_large",
  );

  const spawnEvents = observeCodexJsonl(parentSessionText).filter(
    (event) =>
      event.family === "agent_subagent" &&
      /(?:^|\.)spawn_agent$/u.test(String(event.hostSurface ?? "")) &&
      event.sessionId === threadId &&
      typeof event.childSessionId === "string" &&
      event.childSessionId.length > 0,
  );
  const codeModeLifecycle = spawnEvents.length === 0
    ? readCodeModeSpawnLifecycle(parentSessionText, threadId)
    : null;
  const spawnChildSessionIds = [
    ...new Set([
      ...spawnEvents.map((event) => event.childSessionId),
      codeModeLifecycle?.childSessionId,
    ].filter(Boolean)),
  ];
  if (spawnChildSessionIds.length === 0) fail("codex_parent_spawn_event_missing");
  if (spawnChildSessionIds.length !== 1) fail("codex_parent_spawn_event_not_unique");
  const [childSessionId] = spawnChildSessionIds;

  const childCandidates = [];
  const expectedChildCandidates = [];
  for (const file of files) {
    if (file.filePath === parent.filePath || !isFresh(file.stats, sinceMs)) continue;
    const meta = await readSessionMeta(file.filePath);
    if (path.basename(file.filePath).endsWith(`-${childSessionId}.jsonl`)) {
      expectedChildCandidates.push({ ...file, meta });
    }
    if (meta?.source?.subagent?.thread_spawn?.parent_thread_id === threadId) {
      childCandidates.push({ ...file, meta });
    }
  }
  if (childCandidates.length === 0 && expectedChildCandidates.length === 1) {
    fail("codex_child_session_mismatch");
  }
  if (childCandidates.length !== 1) fail("codex_child_session_not_unique");
  const child = childCandidates[0];
  if (
    child.meta?.id !== childSessionId ||
    child.meta?.originator !== "codex_exec" ||
    !path.basename(child.filePath).endsWith(`-${childSessionId}.jsonl`)
  ) {
    fail("codex_child_session_mismatch");
  }
  const childSessionText = await readBoundedFile(
    child,
    maxBytes,
    "codex_child_session_too_large",
  );

  let nativeInvocation = null;
  if (codeModeLifecycle) {
    const childFinal = readCodeModeChildFinal(
      childSessionText,
      childSessionId,
      sinceMs,
    );
    const nativeAgentType = codeModeLifecycle.call.request.agentType;
    if (
      nativeAgentType != null &&
      child.meta?.source?.subagent?.thread_spawn?.agent_role !== nativeAgentType
    ) {
      fail("codex_child_agent_type_mismatch");
    }
    nativeInvocation = {
      observerFormat: "codex_exec_code_mode_v1",
      family: "agent_subagent",
      eventId: codeModeLifecycle.call.value.payload.call_id,
      parentEventId: null,
      hostSurface: "codex_cli.spawn_agent",
      providerId: "codex_cli.spawn_agent",
      resultStatus: "returned",
      inputDigest: sha256(codeModeLifecycle.call.request.input),
      outputDigest: sha256(childFinal.finalText),
      childSessionId,
      taskPath: null,
      parentAgentPath: null,
      sessionId: threadId,
      resultMessageId: childFinal.resultMessageId,
      resultTextSha256: sha256(childFinal.finalText),
      resultSourceLines: [childFinal.finalLine, childFinal.completionLine],
      sourceLines: [
        codeModeLifecycle.call.line,
        codeModeLifecycle.output.line,
      ],
      lifecycleEvidence: "code_mode_spawn_output_and_child_session_final",
      completionBoundary: "returned_child_final",
      activityCompletionObserved: true,
      ownerBindingMode: nativeAgentType
        ? "native_custom_agent"
        : "run_scoped_owner_contract",
      nativeAgentType,
      claimedOwnerBindingMode: null,
      ownerBindingModeEvidence: nativeAgentType
        ? "code_mode_tool_input.agent_type"
        : "code_mode_tool_input.agent_type_absent",
      ownerBindingModeValidation: "matched_or_host_derived",
      ownerBindingMismatchReason: null,
      occurredAt: childFinal.observedAt,
      bindingUnavailableReason: "meta_kim_binding_not_present",
    };
  }

  return {
    parentSessionText,
    threadId,
    childSessionId,
    sessionDigest: sha256(parentSessionText),
    childSessionDigest: sha256(childSessionText),
    sourceCategory: "codex_home_sessions",
    cliVersion: parent.meta.cli_version ?? null,
    nativeInvocation,
  };
}

async function readDesktopParentEventSlice({ parent, threadId, childSessionId, marker, sinceMs }) {
  const snapshotSize = parent.stats.size;
  const stream = createReadStream(parent.filePath, {
    encoding: "utf8",
    start: 0,
    end: Math.max(0, snapshotSize - 1),
  });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const spawnCalls = new Map();
  const callOutputs = new Map();
  const activities = [];
  const finalMessages = [];
  let sessionMeta = null;
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === "session_meta" && record?.payload?.id === threadId) {
      sessionMeta = { line, lineNumber, record };
      continue;
    }
    const timestampMs = Date.parse(record?.timestamp ?? "");
    if (!Number.isFinite(timestampMs) || timestampMs < sinceMs) continue;
    const payload = record?.payload ?? {};
    if (record?.type === "response_item" && payload?.type === "function_call" && payload?.name === "spawn_agent" && payload?.namespace === "collaboration" && payload?.call_id) {
      spawnCalls.set(payload.call_id, { line, lineNumber, record });
    }
    if (record?.type === "response_item" && payload?.type === "function_call_output" && payload?.call_id) {
      callOutputs.set(payload.call_id, { line, lineNumber, record });
    }
    if (record?.type === "event_msg" && payload?.type === "sub_agent_activity" && payload?.agent_thread_id === childSessionId && payload?.event_id) {
      activities.push({ line, lineNumber, record });
    }
    if (record?.type === "response_item" && payload?.type === "agent_message") {
      const texts = (payload.content ?? []).map((entry) => entry?.text ?? "").filter(Boolean);
      if (texts.some((text) => text.includes(marker))) finalMessages.push({ line, lineNumber, record });
    }
  }
  if (!sessionMeta) fail("codex_desktop_parent_meta_missing");
  const eventIds = [...new Set(activities.map((entry) => entry.record.payload.event_id))];
  if (eventIds.length !== 1) fail("codex_desktop_spawn_lifecycle_not_unique");
  const [eventId] = eventIds;
  const spawn = spawnCalls.get(eventId);
  const output = callOutputs.get(eventId);
  if (!spawn || !output) fail("codex_desktop_spawn_call_binding_missing");
  const childAgentPaths = [...new Set(
    activities.map((entry) => entry.record.payload.agent_path).filter(Boolean),
  )];
  if (childAgentPaths.length !== 1) fail("codex_desktop_child_agent_path_invalid");
  const [childAgentPath] = childAgentPaths;
  const lastSeparator = childAgentPath.lastIndexOf("/");
  const parentAgentPath = lastSeparator > 0 ? childAgentPath.slice(0, lastSeparator) : null;
  const exactFinals = finalMessages.filter((entry) => {
    const payload = entry.record.payload;
    return payload?.author === childAgentPath && payload?.recipient === parentAgentPath &&
      (payload.content ?? []).some((item) => item?.type === "input_text" && String(item.text).endsWith(marker));
  });
  if (exactFinals.length !== 1) fail("codex_desktop_parent_child_final_not_unique");
  const selected = [sessionMeta, spawn, ...activities, output, exactFinals[0]]
    .sort((left, right) => left.lineNumber - right.lineNumber);
  const parentSessionText = `${selected.map((entry) => entry.line).join("\n")}\n`;
  return {
    parentSessionText,
    parentSnapshotSize: snapshotSize,
    parentFragmentDigest: sha256(parentSessionText),
    parentSourceLines: selected.map((entry) => ({
      lineNumber: entry.lineNumber,
      sha256: sha256(`${entry.line}\n`),
    })),
    eventId,
    childAgentPath,
    parentAgentPath,
  };
}

/**
 * Reads one explicitly selected Codex Desktop parent/child lifecycle without
 * loading a long-lived parent rollout into memory. Only the exact spawn chain
 * and child-final lines are retained as the evidence slice.
 */
export async function readCodexDesktopSessionEvidence({
  codexHome,
  threadId,
  childSessionId,
  marker,
  sinceMs,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  if (!THREAD_ID_PATTERN.test(String(threadId ?? "")) || !THREAD_ID_PATTERN.test(String(childSessionId ?? ""))) fail("codex_desktop_session_id_invalid");
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) fail("codex_session_since_invalid");
  if (!/^META_KIM_CAPABILITY_SUBAGENT_[0-9a-f-]{36}$/u.test(String(marker ?? ""))) fail("codex_desktop_marker_invalid");
  const configuredHome = codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  if (!path.isAbsolute(configuredHome)) fail("codex_home_must_be_absolute");
  const absoluteHome = path.resolve(configuredHome);
  const realHome = await assertPlainDirectory(absoluteHome, "codex_home_invalid", "codex_home_symlink_rejected");
  if (realHome !== absoluteHome) fail("codex_home_symlink_rejected");
  const sessionsPath = path.resolve(realHome, "sessions");
  const sessionsRoot = await assertPlainDirectory(sessionsPath, "codex_sessions_invalid", "codex_sessions_symlink_rejected");
  if (!isInside(realHome, sessionsRoot) || sessionsRoot !== sessionsPath) fail("codex_sessions_symlink_rejected");
  const files = await listSessionFiles(sessionsRoot);
  const parentMatches = files.filter((file) => path.basename(file.filePath).endsWith(`-${threadId}.jsonl`));
  const childMatches = files.filter((file) => path.basename(file.filePath).endsWith(`-${childSessionId}.jsonl`));
  if (parentMatches.length !== 1) fail("codex_parent_session_not_unique");
  if (childMatches.length !== 1) fail("codex_child_session_not_unique");
  const parent = parentMatches[0];
  const child = childMatches[0];
  const parentMeta = await readSessionMeta(parent.filePath);
  const childMeta = await readSessionMeta(child.filePath);
  if (parentMeta?.id !== threadId || parentMeta?.originator !== "Codex Desktop" || parentMeta?.source !== "vscode") fail("codex_desktop_parent_source_invalid");
  if (childMeta?.id !== childSessionId || childMeta?.originator !== "Codex Desktop" || childMeta?.source?.subagent?.thread_spawn?.parent_thread_id !== threadId) fail("codex_child_session_mismatch");
  if (!isFresh(parent.stats, sinceMs) || !isFresh(child.stats, sinceMs)) fail("codex_desktop_session_stale");
  const parentSlice = await readDesktopParentEventSlice({ parent, threadId, childSessionId, marker, sinceMs });
  const childSessionText = await readBoundedFile(child, maxBytes, "codex_child_session_too_large");
  const childRecords = childSessionText.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return { value: JSON.parse(line), line: index + 1, raw: line }; } catch { return null; }
  }).filter(Boolean);
  const childMetas = childRecords.filter(({ value }) =>
    value?.type === "session_meta" && value?.payload?.id === childSessionId);
  const childFinals = childRecords.filter(({ value }) =>
    value?.type === "event_msg" && value?.payload?.type === "agent_message" && value?.payload?.phase === "final_answer" && value?.payload?.message === marker);
  const taskCompletions = childRecords.filter(({ value }) =>
    value?.type === "event_msg" && value?.payload?.type === "task_complete" && value?.payload?.last_agent_message === marker);
  if (childMetas.length !== 1 || childFinals.length !== 1 || taskCompletions.length !== 1) fail("codex_desktop_child_final_invalid");
  const completedAtMs = Date.parse(taskCompletions[0].value?.timestamp ?? "");
  const finalAtMs = Date.parse(childFinals[0].value?.timestamp ?? "");
  if (!Number.isFinite(completedAtMs) || !Number.isFinite(finalAtMs) || completedAtMs < sinceMs || finalAtMs < sinceMs || completedAtMs < finalAtMs) {
    fail("codex_desktop_child_timestamp_invalid");
  }
  const childFragmentEntries = [childMetas[0], childFinals[0], taskCompletions[0]];
  const childFragmentText = `${childFragmentEntries.map((entry) => entry.raw).join("\n")}\n`;
  const observed = observeCodexJsonl(parentSlice.parentSessionText).filter((event) =>
    event.family === "agent_subagent" && /(?:^|\.)spawn_agent$/u.test(String(event.hostSurface ?? "")) && event.sessionId === threadId && event.childSessionId === childSessionId && event.completionBoundary === "returned_child_final" && ["completed", "returned"].includes(event.resultStatus));
  if (observed.length !== 1) fail("codex_desktop_observed_spawn_invalid");
  return {
    ...parentSlice,
    childSessionText,
    childFragmentText,
    childFragmentDigest: sha256(childFragmentText),
    childSnapshotSize: child.stats.size,
    childSourceLines: childFragmentEntries.map((entry) => ({ lineNumber: entry.line, sha256: sha256(`${entry.raw}\n`) })),
    threadId,
    childSessionId,
    lifecycleId: `${threadId}:${childSessionId}:${parentSlice.eventId}`,
    marker,
    markerDigest: sha256(marker),
    observedAt: new Date(completedAtMs).toISOString(),
    sourceCategory: "codex_home_sessions",
    cliVersion: parentMeta.cli_version ?? childMeta.cli_version ?? null,
    parentSessionRef: path.relative(sessionsRoot, parent.filePath).replaceAll("\\", "/"),
    childSessionRef: path.relative(sessionsRoot, child.filePath).replaceAll("\\", "/"),
    nativeInvocation: observed[0],
  };
}

function outputText(payload) {
  const output = payload?.output;
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output
    .filter((entry) =>
      entry &&
      typeof entry === "object" &&
      ["input_text", "output_text", "text"].includes(entry.type) &&
      typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

function completedShellOutput(payload) {
  if (!Array.isArray(payload?.output)) return false;
  const text = outputText(payload);
  const failed =
    /\bScript running with cell ID\b/iu.test(text) ||
    /^Script failed(?:\r?\n|$)/u.test(text) ||
    /(?:^|\r?\n)[A-Za-z][A-Za-z0-9-]*:\s*\r?\nLine \|/u.test(text) ||
    /\b(?:rejected|blocked by policy)\b/iu.test(text);
  return !failed &&
    (/(?:^|\r?\n)Exit code:\s*0(?:\r?\n|$)/iu.test(text) ||
      /^Script completed(?:\r?\n|$)/u.test(text));
}

/** Parses the bounded Desktop engineering fragment, never a whole rollout. */
export function observeCodexDesktopEngineeringSlice(text, { marker, workspacePath }) {
  const normalizePathText = (value) => String(value).replaceAll("\\", "/").replace(/\/{2,}/gu, "/").toLowerCase();
  const normalizedWorkspace = normalizePathText(workspacePath);
  const filePath = `${normalizedWorkspace}/meta-kim-probe.txt`;
  const records = String(text).split(/\r?\n/u).map((line, index) => {
    try { return { line: index + 1, value: JSON.parse(line), raw: line }; } catch { return null; }
  }).filter(Boolean);
  const calls = records.filter(({ value }) => value?.type === "response_item" && value?.payload?.type === "custom_tool_call" && value?.payload?.name === "exec" && value?.payload?.call_id);
  const outputs = new Map(records.filter(({ value }) => value?.type === "response_item" && value?.payload?.type === "custom_tool_call_output" && value?.payload?.call_id).map((entry) => [entry.value.payload.call_id, entry]));
  const patchEnds = records.filter(({ value }) => value?.type === "event_msg" && value?.payload?.type === "patch_apply_end" && value?.payload?.success === true && value?.payload?.status === "completed");
  const normalizedInput = (entry) => normalizePathText(entry.value.payload.input ?? "");
  const isShellProvider = (input) => /tools\.(?:shell_command|exec_command)/u.test(input);
  const successfulShell = calls.map((call) => ({ call, output: outputs.get(call.value.payload.call_id), input: normalizedInput(call) })).filter(({ output }) => output && completedShellOutput(output.value.payload));
  const directory = successfulShell.filter(({ input }) => isShellProvider(input) && input.includes("new-item") && input.includes(normalizedWorkspace) && !input.includes("get-content"));
  const reads = successfulShell.filter(({ input }) => isShellProvider(input) && input.includes("get-content") && input.includes(filePath));
  const beforeReads = reads.filter(({ output }) => outputText(output.value.payload).includes(`before-${marker}`) && !outputText(output.value.payload).includes(`after-${marker}`));
  const afterReads = reads.filter(({ output }) => outputText(output.value.payload).includes(`after-${marker}`));
  const patches = calls.map((call) => ({ call, output: outputs.get(call.value.payload.call_id), input: normalizedInput(call) })).filter(({ input, output }) => input.includes("tools.apply_patch") && input.includes(filePath) && output);
  const bindPatchEnd = ({ call, output, input }, kind) => {
    const matches = patchEnds.filter((entry) => entry.line > call.line && entry.line < output.line && normalizePathText(entry.value.payload.stdout ?? "").includes(filePath));
    if (matches.length !== 1) return null;
    const change = Object.values(matches[0].value.payload.changes ?? {})[0];
    if (kind === "add" && (change?.type !== "add" || change?.content !== `before-${marker}\n` || !input.includes("*** add file:"))) return null;
    if (kind === "update" && (change?.type !== "update" || !String(change?.unified_diff ?? "").includes(`-before-${marker}`) || !String(change?.unified_diff ?? "").includes(`+after-${marker}`) || !input.includes("*** update file:"))) return null;
    return { call, output, patchEnd: matches[0] };
  };
  const adds = patches.map((entry) => bindPatchEnd(entry, "add")).filter(Boolean);
  const updates = patches.map((entry) => bindPatchEnd(entry, "update")).filter(Boolean);
  if (directory.length !== 1 || adds.length !== 1 || beforeReads.length !== 1 || updates.length !== 1 || afterReads.length !== 1) {
    fail(`codex_desktop_engineering_chain_invalid:directory_${directory.length}:add_${adds.length}:before_${beforeReads.length}:update_${updates.length}:after_${afterReads.length}`);
  }
  const chain = [directory[0], adds[0], beforeReads[0], updates[0], afterReads[0]];
  const starts = chain.map((entry) => entry.call.line);
  if (starts.some((line, index) => index > 0 && line <= starts[index - 1])) fail("codex_desktop_engineering_order_invalid");
  const makeEvent = (entry, hostSurface, facet) => {
    const selected = [entry.call, entry.patchEnd, entry.output].filter(Boolean);
    return {
      eventId: entry.call.value.payload.call_id,
      family: "runtime_tool",
      hostSurface,
      providerId: hostSurface,
      resultStatus: "completed",
      inputDigest: sha256(entry.call.value.payload.input ?? ""),
      outputDigest: sha256(entry.patchEnd ? JSON.stringify(entry.patchEnd.value.payload.changes) : outputText(entry.output.value.payload)),
      sourceLines: selected.map((item) => item.line),
      facet,
      observedAt: entry.output.value.timestamp ?? entry.patchEnd?.value?.timestamp ?? entry.call.value.timestamp,
    };
  };
  const shellSurface = ({ input }) => input.includes("tools.exec_command")
    ? "functions.exec.exec_command"
    : "functions.exec.shell_command";
  return {
    shell: makeEvent(directory[0], shellSurface(directory[0]), "shell"),
    patchAdd: makeEvent(adds[0], "functions.exec.apply_patch", "apply_patch / edit"),
    filesystemBefore: makeEvent(beforeReads[0], shellSurface(beforeReads[0]), "filesystem"),
    patchUpdate: makeEvent(updates[0], "functions.exec.apply_patch", "apply_patch / edit"),
    filesystemAfter: makeEvent(afterReads[0], shellSurface(afterReads[0]), "filesystem"),
  };
}

/** Streams one explicit Codex Desktop engineering chain from the configured session. */
export async function readCodexDesktopEngineeringEvidence({ codexHome, threadId, marker, workspacePath, sinceMs }) {
  if (!THREAD_ID_PATTERN.test(String(threadId ?? ""))) fail("codex_desktop_engineering_thread_invalid");
  if (!/^META_KIM_CAPABILITY_ENGINEERING_[0-9a-f-]{36}$/u.test(String(marker ?? ""))) fail("codex_desktop_engineering_marker_invalid");
  if (!path.isAbsolute(String(workspacePath ?? "")) || !Number.isFinite(sinceMs)) fail("codex_desktop_engineering_input_invalid");
  const absoluteHome = path.resolve(codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
  const realHome = await assertPlainDirectory(absoluteHome, "codex_home_invalid", "codex_home_symlink_rejected");
  if (realHome !== absoluteHome) fail("codex_home_symlink_rejected");
  const sessionsPath = path.resolve(realHome, "sessions");
  const sessionsRoot = await assertPlainDirectory(sessionsPath, "codex_sessions_invalid", "codex_sessions_symlink_rejected");
  const files = await listSessionFiles(sessionsRoot);
  const matches = files.filter((file) => path.basename(file.filePath).endsWith(`-${threadId}.jsonl`));
  if (matches.length !== 1) fail("codex_parent_session_not_unique");
  const parent = matches[0];
  const meta = await readSessionMeta(parent.filePath);
  if (meta?.id !== threadId || meta?.originator !== "Codex Desktop" || meta?.source !== "vscode" || !isFresh(parent.stats, sinceMs)) fail("codex_desktop_engineering_parent_invalid");
  const snapshotSize = parent.stats.size;
  const stream = createReadStream(parent.filePath, { encoding: "utf8", start: 0, end: Math.max(0, snapshotSize - 1) });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const selected = [];
  let sessionMeta = null;
  let lineNumber = 0;
  const normalizedWorkspace = path.resolve(workspacePath).replaceAll("\\", "/").replace(/\/{2,}/gu, "/").toLowerCase();
  const selectedCallIds = new Set();
  for await (const line of lines) {
    lineNumber += 1;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type === "session_meta" && record?.payload?.id === threadId) sessionMeta = { line, lineNumber };
    const timestampMs = Date.parse(record?.timestamp ?? "");
    if (!Number.isFinite(timestampMs) || timestampMs < sinceMs) continue;
    const payload = record?.payload ?? {};
    const serialized = line.replaceAll("\\", "/").replace(/\/{2,}/gu, "/").toLowerCase();
    if (
      record?.type === "response_item" &&
      payload?.type === "custom_tool_call" &&
      payload?.name === "exec" &&
      serialized.includes(normalizedWorkspace) &&
      (serialized.includes("tools.shell_command") || serialized.includes("tools.exec_command") || serialized.includes("tools.apply_patch"))
    ) {
      selectedCallIds.add(payload.call_id);
      selected.push({ line, lineNumber });
    } else if (record?.type === "response_item" && payload?.type === "custom_tool_call_output" && selectedCallIds.has(payload.call_id)) {
      selected.push({ line, lineNumber });
    } else if (record?.type === "event_msg" && payload?.type === "patch_apply_end" && serialized.includes(normalizedWorkspace)) {
      selected.push({ line, lineNumber });
    }
  }
  if (!sessionMeta) fail("codex_desktop_parent_meta_missing");
  const fragmentEntries = [sessionMeta, ...selected].sort((left, right) => left.lineNumber - right.lineNumber);
  const parentSessionText = `${fragmentEntries.map((entry) => entry.line).join("\n")}\n`;
  const events = observeCodexDesktopEngineeringSlice(parentSessionText, { marker, workspacePath });
  const observedAt = events.filesystemAfter.observedAt;
  if (!Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) < sinceMs) fail("codex_desktop_engineering_timestamp_invalid");
  return {
    parentSessionText,
    parentFragmentDigest: sha256(parentSessionText),
    parentSourceLines: fragmentEntries.map((entry) => ({ lineNumber: entry.lineNumber, sha256: sha256(`${entry.line}\n`) })),
    parentSnapshotSize: snapshotSize,
    parentSessionRef: path.relative(sessionsRoot, parent.filePath).replaceAll("\\", "/"),
    sourceCategory: "codex_desktop_sessions",
    threadId,
    marker,
    markerDigest: sha256(marker),
    workspacePath: path.resolve(workspacePath),
    workspaceDigest: sha256(path.resolve(workspacePath).replaceAll("\\", "/").toLowerCase()),
    lifecycleId: `${threadId}:${marker.slice(-36)}`,
    cliVersion: meta.cli_version ?? null,
    observedAt,
    events,
  };
}
