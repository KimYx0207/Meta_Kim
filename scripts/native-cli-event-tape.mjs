import { createHash } from "node:crypto";
import path from "node:path";

// This module is a bounded parser, not an authority to execute a CLI or import
// evidence. Its caller must bind stdout to its own fixed, successful CLI child.
// In particular, a replayable tape alone never proves production provenance.
// Observer digests describe this projection; rawStdoutSha256 separately binds
// original stdout, including omitted display-only prose and private metadata.
const SCHEMA = "meta-kim-native-cli-event-tape-v1";
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 128 * 1024;
const MAX_RECORDS = 4096;
const MAX_TEXT = 64 * 1024;
const CAPABILITIES = new Set(["agent", "subagent", "shell", "filesystem", "apply_patch / edit", "engineering_composite"]);
const FAILED = /^(?:error|failed|failure|declined|denied|cancelled|canceled|aborted|interrupted|timed_out|timeout|errored|rejected|incomplete)$/iu;
const PROBE_FILE = /^meta-kim-(?:engineering-)?probe\.txt$/u;
const SHA = /^[a-f0-9]{64}$/u;
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const fail = (message) => { throw new Error(`native CLI event tape: ${message}`); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

function identity(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(value)) fail("invalid event identity");
  return value;
}

function optionsFor(options, requireWorkspace) {
  if (!object(options) || !["codex", "claude", "claude_code"].includes(options.runtime)) fail("unsupported runtime");
  if (!CAPABILITIES.has(options.capability)) fail("unsupported capability");
  if (typeof options.marker !== "string" || !/^META_KIM_CAPABILITY_[A-Z0-9_]+_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(options.marker)) fail("invalid capability marker");
  const workspace = options.workspace;
  if ((requireWorkspace || workspace != null) && (typeof workspace !== "string" || !(path.posix.isAbsolute(workspace) || path.win32.isAbsolute(workspace)) || /[\u0000-\u001f]/u.test(workspace))) fail("absolute synthetic workspace required");
  return options;
}

// JSON.parse accepts duplicate keys. Reject them before a later value can hide
// a failure or replace a call identity. Parsing is already syntax checked here.
function assertUniqueJsonKeys(text) {
  let cursor = 0;
  const whitespace = () => { while (/\s/u.test(text[cursor] ?? "") && cursor < text.length) cursor += 1; };
  const string = () => {
    const start = cursor++;
    while (cursor < text.length) {
      if (text[cursor] === "\\") { cursor += 2; continue; }
      if (text[cursor++] === '"') break;
    }
    return JSON.parse(text.slice(start, cursor));
  };
  const value = (depth) => {
    if (depth > 32) fail("JSON nesting limit exceeded");
    whitespace();
    if (text[cursor] === '"') { string(); return; }
    const open = text[cursor];
    if (open === "{" || open === "[") {
      cursor += 1;
      whitespace();
      const close = open === "{" ? "}" : "]";
      const keys = new Set();
      while (text[cursor] !== close) {
        if (open === "{") {
          const key = string();
          if (keys.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) fail("duplicate or unsafe JSON key");
          keys.add(key);
          whitespace();
          cursor += 1; // colon, already checked by JSON.parse
        }
        value(depth + 1);
        whitespace();
        if (text[cursor] !== ",") break;
        cursor += 1;
        whitespace();
      }
      cursor += 1;
      return;
    }
    while (cursor < text.length && !/[\s,}\]]/u.test(text[cursor])) cursor += 1;
  };
  value(0);
}

function inspectFailures(value, depth = 0) {
  if (depth > 32) fail("JSON nesting limit exceeded");
  if (Array.isArray(value)) { for (const item of value) inspectFailures(item, depth + 1); return; }
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (["error", "errors", "permission_denials"].includes(key) && item != null && item !== false && !(Array.isArray(item) && item.length === 0)) fail("error or permission denial in stream");
    if (["is_error", "isError", "interrupted", "timed_out", "cancelled", "canceled"].includes(key) && item !== false && item != null) fail("failed or interrupted stream");
    if (key === "success" && item === false) fail("unsuccessful stream event");
    if (["exit_code", "exitCode", "exit_status", "exitStatus"].includes(key) && item != null && (!Number.isInteger(item) || item !== 0)) fail("nonzero or invalid exit code");
    if (["status", "result_status", "outcome", "stop_reason"].includes(key) && typeof item === "string" && (FAILED.test(item) || ["max_tokens", "max_turns", "max_budget_usd"].includes(item))) fail("failed or truncated lifecycle");
    if (["type", "subtype"].includes(key) && typeof item === "string" && (FAILED.test(item) || /(?:^|[._])(?:error|failed|failure|cancelled|canceled|declined|denied)(?:$|[._])/iu.test(item))) fail("failure event in stream");
    if (["text", "message", "content", "output", "aggregated_output", "result", "stdout", "stderr"].includes(key) && typeof item === "string" && /(?:^|\n)\s*(?:(?:error|failed|failure)\s*:|(?:exit code|exit_code)\s*[:=]\s*-?[1-9]\d*\b)|\bpermission denied\b/iu.test(item)) fail("failure text in stream");
    inspectFailures(item, depth + 1);
  }
}

function parseRecords(text) {
  if (typeof text !== "string" || !text || Buffer.byteLength(text, "utf8") > MAX_BYTES) fail("stdout byte limit or empty stdout");
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > MAX_RECORDS) fail("record limit exceeded");
  return lines.map((line) => {
    if (!line.trim() || Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) fail("empty or oversized JSONL record");
    let record;
    try { record = JSON.parse(line); } catch { fail("malformed JSONL record"); }
    if (!object(record)) fail("JSONL record must be an object");
    assertUniqueJsonKeys(line);
    inspectFailures(record);
    return record;
  });
}

function portablePath(value) { return value.replaceAll("\\", "/").replace(/\/{2,}/gu, "/"); }

function checkPath(value, options, { executable = false } = {}) {
  const normalized = portablePath(value);
  if (executable && new Set(["/bin/sh", "/bin/bash", "/usr/bin/bash", "/usr/bin/env", "/usr/bin/pwsh", "/dev/null"]).has(normalized)) return;
  if (normalized.split("/").includes("..")) fail("path traversal in retained evidence");
  const absolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
  if (options.workspace && absolute) {
    const root = portablePath(options.workspace).replace(/\/$/u, "");
    const windows = /^[A-Za-z]:\//u.test(root);
    const candidate = windows ? normalized.toLowerCase() : normalized;
    const base = windows ? root.toLowerCase() : root;
    if (candidate !== base && !candidate.startsWith(`${base}/`)) fail("outside-workspace path in retained evidence");
  } else if (absolute && !PROBE_FILE.test(normalized.split("/").at(-1))) {
    fail("unbound absolute path in retained evidence");
  }
}

function safeText(value, options, limit = MAX_TEXT) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limit || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail("invalid or oversized retained text");
  if (/(?:^|[\/\\\s'"`])(?:\.ssh|\.aws|\.codex|\.claude|\.config|\.env)(?:[\/\\.\s'"`]|$)|\b(?:auth\.json|credentials?(?:\.json)?|api[_-]?key|access[_-]?token|refresh[_-]?token)\b|(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,})|(?:\$\{?(?:HOME|USERPROFILE)|%USERPROFILE%|\$env:(?:HOME|USERPROFILE)|~[\/\\])/iu.test(value)) fail("credential or home reference in retained evidence");
  if (/(?:^|[\/\\\s'"`])\.\.[\/\\]/u.test(value)) fail("path traversal in retained evidence");
  // Inputs are synthetic probe commands. Retain their actual native spelling,
  // but never store a command/output referring to another absolute location.
  for (const match of value.matchAll(/(?:[A-Za-z]:[\/\\]|(?<![A-Za-z0-9_<])\/)[^\s'"`<>|;,()[\]{}]+/gu)) checkPath(match[0], options, { executable: true });
  return value;
}

function timestamp(record, target) {
  if (record.timestamp != null) {
    if (typeof record.timestamp !== "string" || !/^\d{4}-\d\d-\d\dT/u.test(record.timestamp) || !Number.isFinite(Date.parse(record.timestamp))) fail("invalid event timestamp");
    target.timestamp = record.timestamp;
  }
  return target;
}

function textContent(content, options) {
  if (typeof content === "string") return safeText(content, options);
  if (!Array.isArray(content) || content.length > 128) fail("unsupported tool output content");
  return content.map((entry) => {
    if (!object(entry) || entry.type !== "text") fail("unsupported tool output block");
    return { type: "text", text: safeText(entry.text, options) };
  });
}

const INPUT_KEYS = {
  Agent: ["prompt", "description", "subagent_type", "run_in_background", "name"],
  Task: ["prompt", "description", "subagent_type", "run_in_background", "name"],
  Bash: ["command", "description", "timeout", "run_in_background"],
  PowerShell: ["command", "description", "timeout", "run_in_background"],
  Read: ["file_path", "path", "offset", "limit", "pages"],
  Edit: ["file_path", "path", "old_string", "new_string", "replace_all"],
  Write: ["file_path", "path", "content"],
};

function toolInput(input, name, options) {
  if (!object(input) || !INPUT_KEYS[name]) fail("unsupported native tool input");
  const projected = {};
  for (const [key, value] of Object.entries(input)) {
    if (!INPUT_KEYS[name].includes(key)) fail("unknown native tool input field");
    if (["description", "name", "task_name"].includes(key)) continue; // Display prose is not executed input.
    if (key === "subagent_type" && value !== "general-purpose") fail("custom Agent selection is outside the synthetic probe");
    if (key === "agent_type" && value !== "default") fail("custom agent selection is outside the synthetic probe");
    if (key === "fork_turns" && value !== "none") fail("history forking is outside the synthetic probe");
    if (key === "run_in_background" && typeof value !== "boolean") fail("invalid background control");
    if (typeof value === "string") {
      projected[key] = safeText(value, options, key === "description" ? 1024 : MAX_TEXT);
      if (["path", "file_path"].includes(key)) checkPath(value, options);
    } else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) projected[key] = value;
    else if (key === "ids" && Array.isArray(value) && value.length <= 16) projected[key] = value.map(identity);
    else fail("unsupported native tool input value");
  }
  return projected;
}

function immutableCodexInput(item) {
  const fields = ["type", "command", "tool", "prompt", "message", "agent_type", "task_name", "fork_turns", "arguments", "input", "tool_input"];
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(Object.fromEntries(fields.map((key) => [key, item[key] ?? null]))));
}

function projectCodex(records, options) {
  const retained = [];
  let root = null;
  let phase = "initial";
  const started = new Map();
  const immutableInputs = new Map();
  const completed = new Set();
  const children = new Set();
  const childOwners = new Map();
  const childDone = new Set();
  const requireRoot = (record) => {
    for (const key of ["thread_id", "session_id", "sender_thread_id"]) if (record[key] != null && record[key] !== root) fail("cross-root thread evidence");
  };
  for (const record of records) {
    if (phase === "done") fail("record after final success");
    if (record.type === "thread.started") {
      if (phase !== "initial") fail("duplicate or misplaced root thread");
      root = identity(record.thread_id);
      phase = "thread";
      retained.push(timestamp(record, { type: record.type, thread_id: root }));
      continue;
    }
    if (!root) fail("missing initial root thread");
    requireRoot(record);
    if (record.type === "turn.started") {
      if (phase !== "thread") fail("duplicate or misplaced turn start");
      phase = "turn";
      retained.push(timestamp(record, { type: record.type }));
      continue;
    }
    if (phase !== "turn") fail("item outside active turn");
    if (record.type === "turn.completed") {
      if ([...started.keys()].some((id) => !completed.has(id)) || [...children].some((id) => !childDone.has(id))) fail("unfinished tool or child lifecycle");
      retained.push(timestamp(record, { type: record.type }));
      phase = "done";
      continue;
    }
    if (!["item.started", "item.updated", "item.completed"].includes(record.type) || !object(record.item)) fail("unknown Codex operational event");
    const item = record.item;
    const id = identity(item.id);
    requireRoot(item);
    if (!["reasoning", "agent_message", "command_execution", "file_change", "collab_tool_call"].includes(item.type)) fail("unknown Codex item type");
    if (record.type === "item.started") {
      if (started.has(id) || completed.has(id)) fail("duplicate unique call id");
      started.set(id, item.type);
      immutableInputs.set(id, immutableCodexInput(item));
    } else {
      if (completed.has(id)) fail("duplicate terminal id or update after completion");
      if (started.has(id) && started.get(id) !== item.type) fail("item type changed during lifecycle");
      if (started.has(id) && immutableInputs.get(id) !== immutableCodexInput(item)) fail("native tool input changed during lifecycle");
      if (!started.has(id) && !["reasoning", "agent_message", "file_change"].includes(item.type)) fail("missing native tool start");
      if (record.type === "item.updated" && !started.has(id)) fail("update without start");
      if (record.type === "item.completed") completed.add(id);
    }
    if (item.status != null && !["in_progress", "completed", "success"].includes(item.status)) fail("unsupported Codex item status");
    if (record.type === "item.completed" && item.status != null && !["completed", "success"].includes(item.status)) fail("nonterminal completed item");
    if (item.type === "reasoning") continue;
    const projected = { id, type: item.type };
    if (item.status != null) projected.status = item.status;
    if (item.type === "agent_message") {
      const child = item.child_thread_id ?? item.agent_thread_id;
      if (!child) continue; // Parent narration is not capability evidence.
      if (!children.has(child)) fail("unknown child message");
      if (item.child_thread_id != null) projected.child_thread_id = identity(item.child_thread_id);
      if (item.agent_thread_id != null) projected.agent_thread_id = identity(item.agent_thread_id);
      if (item.text != null) projected.text = safeText(item.text, options);
      else if (Array.isArray(item.content)) projected.content = textContent(item.content, options);
      else fail("missing child message text");
    } else if (item.type === "command_execution") {
      projected.command = safeText(item.command, options);
      if (record.type === "item.completed" && item.exit_code !== 0) fail("missing successful command exit");
      if (item.exit_code != null) projected.exit_code = item.exit_code;
      if (item.aggregated_output != null) projected.aggregated_output = safeText(item.aggregated_output, options);
    } else if (item.type === "file_change") {
      if (!Array.isArray(item.changes) || item.changes.length < 1 || item.changes.length > 16) fail("missing or oversized native file changes");
      projected.changes = item.changes.map((change) => {
        if (!object(change) || !["add", "update", "delete"].includes(change.kind)) fail("invalid native file change");
        checkPath(safeText(change.path, options, 4096), options);
        if (!PROBE_FILE.test(portablePath(change.path).split("/").at(-1))) fail("file change outside synthetic probe");
        const result = { path: change.path, kind: change.kind };
        if (change.diff != null) result.diff = safeText(change.diff, options);
        return result;
      });
    } else {
      if (!["spawn_agent", "wait"].includes(item.tool)) fail("unsupported collaboration operation");
      projected.tool = item.tool;
      if (item.sender_thread_id != null) projected.sender_thread_id = identity(item.sender_thread_id);
      if (!Array.isArray(item.receiver_thread_ids) || item.receiver_thread_ids.length > 16) fail("missing native receiver identities");
      const receivers = item.receiver_thread_ids.map(identity);
      if (new Set(receivers).size !== receivers.length || receivers.includes(root)) fail("invalid child identities");
      if (item.tool === "spawn_agent") {
        if ((record.type === "item.completed" && receivers.length !== 1) || receivers.length > 1) fail("ambiguous spawned child");
        for (const child of receivers) {
          if (childOwners.has(child) && childOwners.get(child) !== id) fail("duplicate spawned child");
          children.add(child);
          childOwners.set(child, id);
        }
      } else if (item.tool === "wait" && receivers.some((child) => !children.has(child))) fail("wait for unknown child");
      projected.receiver_thread_ids = receivers;
      // Only the official exec JSON collaboration shape is eligible here.
      // Legacy rollout aliases remain supported by their existing observer,
      // never by this new CLI-only source.
      for (const key of ["arguments", "input", "tool_input", "message", "agent_type", "task_name", "fork_turns", "model", "mode", "reasoning_effort"]) if (own(item, key)) fail("noncanonical collaboration input outside the synthetic probe");
      if (item.prompt != null) {
        if (item.tool !== "spawn_agent") fail("unexpected wait prompt outside the synthetic probe");
        projected.prompt = safeText(item.prompt, options);
      }
      if (item.agents_states != null) {
        if (!object(item.agents_states)) fail("invalid child states");
        projected.agents_states = {};
        for (const [child, state] of Object.entries(item.agents_states)) {
          if (!receivers.includes(child) || !children.has(child) || !object(state) || !["pending_init", "running", "in_progress", "completed"].includes(state.status)) fail("unbound child state");
          const next = { status: state.status };
          if (state.message != null) next.message = safeText(state.message, options);
          if (state.status === "completed") {
            if (typeof state.message !== "string") fail("missing completed child message");
            childDone.add(child);
          }
          projected.agents_states[child] = next;
        }
      }
    }
    for (const key of ["result", "output"]) if (item[key] != null) projected[key] = textContent(item[key], options);
    retained.push(timestamp(record, { type: record.type, item: projected }));
  }
  if (phase !== "done") fail("missing final Codex turn success");
  return retained;
}

function projectClaude(records, options) {
  const retained = [];
  let root = null;
  let done = false;
  const calls = new Map();
  const results = new Set();
  const taskStarts = new Set();
  const taskTerminals = new Set();
  for (const record of records) {
    if (done) fail("record after final success");
    if (record.type === "system" && record.subtype === "init") {
      if (root) fail("duplicate Claude init");
      root = identity(record.session_id);
      retained.push(timestamp(record, { type: "system", subtype: "init", session_id: root }));
      continue;
    }
    if (!root) fail("missing initial Claude session");
    if (record.session_id !== root || (record.sessionId != null && record.sessionId !== root)) fail("cross-root session evidence");
    const base = { type: record.type, session_id: root };
    if (record.type === "result") {
      if (record.subtype !== "success" || record.is_error !== false) fail("missing final Claude result success");
      if ([...calls.keys()].some((id) => !results.has(id)) || [...taskStarts].some((id) => !taskTerminals.has(`task_notification:${id}`))) fail("unfinished native tool or task lifecycle");
      retained.push(timestamp(record, { type: "result", subtype: "success", is_error: false, session_id: root }));
      done = true;
      continue;
    }
    if (record.type === "system") {
      if (!["task_started", "task_updated", "task_notification", "task_progress"].includes(record.subtype)) fail("unknown Claude system event");
      base.subtype = record.subtype;
      base.task_id = identity(record.task_id);
      if (record.tool_use_id != null) {
        base.tool_use_id = identity(record.tool_use_id);
        if (!["Agent", "Task"].includes(calls.get(base.tool_use_id))) fail("task references unknown Agent call");
      }
      if (record.subtype === "task_started") {
        if (taskStarts.has(base.task_id) || !base.tool_use_id) fail("duplicate or unbound native task start");
        taskStarts.add(base.task_id);
      } else if (!taskStarts.has(base.task_id)) fail("task update without start");
      const status = record.patch?.status ?? record.status;
      if (status != null && !["pending", "running", "in_progress", "completed"].includes(status)) fail("unknown task status");
      if (record.status != null) base.status = record.status;
      if (record.patch != null) {
        if (!object(record.patch) || record.patch.status == null) fail("unknown task patch");
        base.patch = { status: record.patch.status };
      }
      if (status === "completed") {
        const key = `${record.subtype}:${base.task_id}`;
        if (taskTerminals.has(key)) fail("duplicate native task terminal id");
        taskTerminals.add(key);
      }
      retained.push(timestamp(record, base));
      continue;
    }
    if (!["assistant", "user"].includes(record.type) || !object(record.message) || !Array.isArray(record.message.content)) fail("unknown Claude operational event");
    const childCall = record.parent_tool_use_id;
    if (childCall != null) {
      if (!["Agent", "Task"].includes(calls.get(childCall))) fail("child message references unknown Agent call");
      base.parent_tool_use_id = identity(childCall);
    }
    for (const key of ["agent_id", "agentId", "agent_thread_id", "child_thread_id"]) if (record[key] != null) fail("unsupported independent child session");
    const content = [];
    for (const item of record.message.content) {
      if (!object(item)) fail("invalid Claude content block");
      if (["thinking", "redacted_thinking"].includes(item.type)) continue;
      if (item.type === "text") {
        if (childCall != null) content.push({ type: "text", text: safeText(item.text, options) });
        continue;
      }
      if (item.type === "tool_use" && record.type === "assistant") {
        const id = identity(item.id);
        if (calls.has(id) || results.has(id)) fail("duplicate unique call id");
        if (!INPUT_KEYS[item.name] || ["spawn_agent", "wait"].includes(item.name)) fail("unsupported Claude native tool");
        calls.set(id, item.name);
        content.push({ type: "tool_use", id, name: item.name, input: toolInput(item.input, item.name, options) });
      } else if (item.type === "tool_result" && record.type === "user") {
        const id = identity(item.tool_use_id);
        if (!calls.has(id) || results.has(id)) fail("duplicate or unmatched native tool result");
        results.add(id);
        const result = { type: "tool_result", tool_use_id: id, content: textContent(item.content, options) };
        if (item.is_error != null) result.is_error = item.is_error;
        content.push(result);
      } else fail("unknown Claude content operation");
    }
    if (content.length === 0) continue;
    base.message = {};
    if (record.message.id != null) base.message.id = identity(record.message.id);
    if (record.type === "assistant" && !base.message.id) fail("missing assistant message identity");
    if (record.message.stop_reason != null) {
      if (!["end_turn", "tool_use", "stop_sequence"].includes(record.message.stop_reason)) fail("unsupported assistant stop reason");
      base.message.stop_reason = record.message.stop_reason;
    }
    base.message.content = content;
    const agentResult = content.some((item) => item.type === "tool_result" && ["Agent", "Task"].includes(calls.get(item.tool_use_id)));
    if (record.tool_use_result != null && !agentResult) {
      if (!object(record.tool_use_result)) fail("invalid native tool result envelope");
      const envelope = {};
      for (const key of ["content", "stdout", "stderr"]) if (record.tool_use_result[key] != null) envelope[key] = textContent(record.tool_use_result[key], options);
      if (record.tool_use_result.file != null) {
        const file = record.tool_use_result.file;
        if (!object(file) || typeof file.content !== "string" || typeof file.filePath !== "string") fail("unsupported native file output envelope");
        envelope.file = { filePath: safeText(file.filePath, options), content: safeText(file.content, options) };
      }
      if (Object.keys(envelope).length > 0) base.tool_use_result = envelope;
    }
    if (record.tool_use_result != null && agentResult) {
      if (!object(record.tool_use_result)) fail("invalid native tool result envelope");
      const envelope = {};
      for (const key of ["agentId", "agent_id"]) if (record.tool_use_result[key] != null) envelope[key] = identity(record.tool_use_result[key]);
      if (record.tool_use_result.status != null) {
        if (!["completed", "success", "async_launched"].includes(record.tool_use_result.status)) fail("unknown native result status");
        envelope.status = record.tool_use_result.status;
      }
      if (record.tool_use_result.isAsync != null) {
        if (typeof record.tool_use_result.isAsync !== "boolean") fail("invalid async result flag");
        envelope.isAsync = record.tool_use_result.isAsync;
      }
      if (record.tool_use_result.content != null) envelope.content = textContent(record.tool_use_result.content, options);
      if (Object.keys(envelope).length > 0) base.tool_use_result = envelope;
    }
    retained.push(timestamp(record, base));
  }
  if (!done) fail("missing final Claude result success");
  return retained;
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function probeTarget(value, options) {
  if (typeof value !== "string") fail("missing synthetic probe target");
  const unquoted = value.replace(/^(['"])(.*)\1$/u, "$2");
  checkPath(unquoted, options);
  const expected = options.capability === "engineering_composite" ? "meta-kim-engineering-probe.txt" : "meta-kim-probe.txt";
  const normalized = portablePath(unquoted).replace(/^\.\//u, "");
  if (normalized !== expected && (!options.workspace || normalized !== `${portablePath(options.workspace).replace(/\/$/u, "")}/${expected}`)) {
    // A receipt may replay after its temporary workspace has been removed.
    if (options.workspace || !path.posix.isAbsolute(normalized) && !path.win32.isAbsolute(normalized) || normalized.split("/").at(-1) !== expected) fail("action does not target the synthetic probe file");
  }
}

function syntheticCommand(command, operation, content, options) {
  let source = safeText(command, options).trim();
  const shellWrapper = /^(?:\/(?:usr\/)?bin\/(?:ba)?sh)\s+-[lc]+\s+(['"])([\s\S]*)\1$/u.exec(source);
  if (shellWrapper) source = shellWrapper[2].replaceAll("'\\''", "'");
  let match;
  if (operation === "read") {
    match = /^(?:cat(?:\s+--)?|Get-Content(?:\s+-Raw)?(?:\s+-LiteralPath)?|\[System\.IO\.File\]::ReadAllText)\s*(?:\(\s*)?(['"]?[^'"\s;|&<>`]+['"]?)\s*\)?$/iu.exec(source);
    if (!match) fail("unrecognized synthetic read command");
    probeTarget(match[1], options);
    return;
  }
  const data = escapeRegex(content);
  const target = "(['\"]?[^'\"\\s;|&<>`]+['\"]?)";
  const patterns = [
    new RegExp(`^printf\\s+(?:['\"]%s(?:\\\\n)?['\"]\\s+['\"]${data}['\"]|['\"]${data}(?:\\\\n)?['\"])\\s*>\\s*${target}$`, "u"),
    new RegExp(`^echo\\s+['\"]?${data}['\"]?\\s*>\\s*${target}$`, "u"),
    new RegExp(`^Set-Content\\s+(?:-LiteralPath\\s+|-Path\\s+)?${target}\\s+-Value\\s+['\"]${data}['\"](?:\\s+-NoNewline)?(?:\\s+-Encoding\\s+ascii)?$`, "iu"),
    new RegExp(`^\\[System\\.IO\\.File\\]::WriteAllText\\(\\s*${target}\\s*,\\s*['\"]${data}['\"]\\s*\\)$`, "iu"),
  ];
  match = patterns.map((pattern) => pattern.exec(source)).find(Boolean);
  if (!match) fail("unrecognized synthetic write command");
  probeTarget(match[1], options);
}

function syntheticPrompt(value, options) {
  if (typeof value !== "string" || !value.includes(options.marker)) fail("missing exact child marker in prompt");
  const remaining = value.replaceAll(options.marker, " ").toLowerCase();
  const allowed = new Set("return exactly complete capability marker as your entire final response only the following text with no other output or punctuation do not include anything else respond reply and stop please must be a single line nothing more".split(" "));
  if (/[^a-z\s.,;:!'"()-]/u.test(remaining) || remaining.split(/[^a-z]+/u).filter(Boolean).some((word) => !allowed.has(word))) fail("unrecognized synthetic child prompt");
}

function exactOutput(value, expected, options, { numbered = false, empty = false } = {}) {
  if (Array.isArray(value)) {
    if (value.length !== 1 || value[0]?.type !== "text") fail("unrecognized synthetic output blocks");
    exactOutput(value[0].text, expected, options, { numbered, empty });
    return;
  }
  const text = safeText(value, options);
  if (empty && text === "") return;
  if ([expected, `${expected}\n`, `${expected}\r\n`].includes(text)) return;
  if (numbered && new RegExp(`^\\s*1(?:→|\\t|\\|)\\s?${escapeRegex(expected)}(?:\\r?\\n)?$`, "u").test(text)) return;
  fail("unrecognized or private synthetic tool output");
}

function agentOutput(value, options, childId) {
  if (typeof value === "string") {
    if (value !== options.marker) fail("child did not return the exact marker");
    return value;
  }
  if (!Array.isArray(value) || value[0]?.type !== "text" || value[0].text !== options.marker || value.length > 2) fail("child did not return the exact marker");
  if (value.length === 2) {
    const metadata = value[1];
    if (!childId || metadata.type !== "text" || !new RegExp(`^agentId: ${escapeRegex(childId)}(?:\\n<usage>(?:[a-z_]+: \\d+\\s*)+</usage>)?$`, "u").test(metadata.text)) fail("unrecognized native Agent result wrapper");
  }
  // The child id is retained structurally; usage is not capability evidence.
  return [{ type: "text", text: options.marker }];
}

function validateScopedActions(records, options) {
  const agent = ["agent", "subagent"].includes(options.capability);
  if (options.runtime === "codex") {
    const tools = records.filter((record) => record.type === "item.completed" && record.item.type !== "agent_message").map((record) => record.item);
    if (agent) {
      if (tools.length < 2 || tools[0].type !== "collab_tool_call" || tools[0].tool !== "spawn_agent" || tools.slice(1).some((item) => item.type !== "collab_tool_call" || item.tool !== "wait")) fail("agent probe contains unrelated actions");
      for (const record of records.filter((record) => record.item)) {
        const item = record.item;
        if (item.type === "agent_message") {
          if (item.text !== options.marker) fail("child did not return the exact marker");
        } else if (item.tool === "spawn_agent") {
          syntheticPrompt(item.prompt, options);
        }
        for (const key of ["result", "output"]) if (item[key] != null && item[key] !== "" && item[key] !== options.marker) fail("unrecognized native collaboration output");
        for (const state of Object.values(item.agents_states ?? {})) if (state.message != null && state.message !== options.marker) fail("child did not return the exact marker");
      }
      return;
    }
    const expected = options.capability === "engineering_composite"
      ? ["command_execution", "command_execution", "file_change", "command_execution"]
      : options.capability === "apply_patch / edit" ? ["command_execution", "file_change"] : ["command_execution"];
    if (tools.map((item) => item.type).join("|") !== expected.join("|")) fail("probe contains unrelated or missing native actions");
    for (const record of records.filter((record) => record.item)) {
      const item = record.item;
      if (item.type === "agent_message") fail("non-agent probe contains child message");
      const index = tools.findIndex((completed) => completed.id === item.id);
      if (index < 0) fail("unmatched scoped native action");
      if (item.type === "file_change") {
        if (item.changes.length !== 1 || item.changes[0].kind !== "update" || item.changes[0].diff != null) fail("unexpected synthetic file change");
        probeTarget(item.changes[0].path, options);
        for (const key of ["result", "output"]) if (item[key] != null) exactOutput(item[key], `after-${options.marker}`, options, { empty: true });
        continue;
      }
      const write = options.capability === "shell" || options.capability === "engineering_composite" && index === 0;
      const prefix = options.capability === "shell" ? "shell-" : options.capability === "filesystem" ? "" : options.capability === "engineering_composite" && index === 3 ? "after-" : "before-";
      syntheticCommand(item.command, write ? "write" : "read", `${prefix}${options.marker}`, options);
      if (item.aggregated_output != null) exactOutput(item.aggregated_output, `${prefix}${options.marker}`, options, { empty: write || record.type !== "item.completed" });
      for (const key of ["result", "output"]) if (item[key] != null) exactOutput(item[key], `${prefix}${options.marker}`, options, { empty: write });
    }
    return;
  }
  const calls = records.flatMap((record) => (record.message?.content ?? []).filter((item) => item.type === "tool_use"));
  const names = calls.map((item) => item.name);
  if (agent ? names.length !== 1 || !["Agent", "Task"].includes(names[0]) : options.capability === "shell" ? names.length !== 1 || !["Bash", "PowerShell"].includes(names[0]) : options.capability === "filesystem" ? names.join() !== "Read" : names.join() !== "Read,Edit") fail("probe contains unrelated or missing native actions");
  const childTexts = new Map();
  for (const call of calls) {
    if (agent) {
      syntheticPrompt(call.input.prompt, options);
      if (call.input.run_in_background === true) {
        const launch = records.find((record) => record.message?.content?.some((item) => item.type === "tool_result" && item.tool_use_id === call.id));
        if (launch?.tool_use_result?.status !== "async_launched") fail("background Agent lacks native async launch evidence");
      }
    }
    else if (["Bash", "PowerShell"].includes(call.name)) {
      if (call.input.run_in_background === true) fail("background shell is outside the synthetic probe");
      syntheticCommand(call.input.command, "write", `shell-${options.marker}`, options);
    }
    else {
      probeTarget(call.input.file_path ?? call.input.path, options);
      if (call.input.file_path != null && call.input.path != null) probeTarget(call.input.path, options);
      if (call.name === "Edit" && (call.input.old_string !== `before-${options.marker}` || call.input.new_string !== `after-${options.marker}` || call.input.replace_all === true)) fail("unexpected synthetic Edit replacement");
    }
  }
  for (const record of records) {
    if (record.parent_tool_use_id) {
      const key = `${record.parent_tool_use_id}:${record.message.id}`;
      childTexts.set(key, (childTexts.get(key) ?? "") + record.message.content.filter((item) => item.type === "text").map((item) => item.text).join(""));
    }
    for (const item of record.message?.content ?? []) {
      if (item.type !== "tool_result") continue;
      const call = calls.find((entry) => entry.id === item.tool_use_id);
      if (!agent && record.tool_use_result) {
        const envelope = record.tool_use_result;
        const prefix = call.name === "Read" ? options.capability === "filesystem" ? "" : "before-" : call.name === "Edit" ? "after-" : "shell-";
        for (const key of ["content", "stdout"]) if (envelope[key] != null) exactOutput(envelope[key], `${prefix}${options.marker}`, options, { numbered: call.name === "Read", empty: call.name !== "Read" });
        if (envelope.stderr != null && envelope.stderr !== "") fail("unexpected stderr in successful native result");
        if (envelope.file) {
          probeTarget(envelope.file.filePath, options);
          exactOutput(envelope.file.content, `${prefix}${options.marker}`, options);
        }
      }
      if (agent) {
        const envelope = record.tool_use_result;
        if (envelope?.status === "async_launched") {
          if (item.content !== "Async agent launched successfully.") fail("unrecognized async launch output");
        } else {
          item.content = agentOutput(item.content, options, envelope?.agentId ?? envelope?.agent_id);
          if (envelope?.content != null) envelope.content = agentOutput(envelope.content, options, envelope.agentId ?? envelope.agent_id);
        }
      } else if (call.name === "Read") exactOutput(item.content, `${options.capability === "filesystem" ? "" : "before-"}${options.marker}`, options, { numbered: true });
      else if (call.name === "Edit") {
        const content = typeof item.content === "string" ? item.content : item.content.length === 1 ? item.content[0].text : null;
        if (content !== `after-${options.marker}` && content !== "") {
          const match = typeof content === "string" && /^The file (.+) has been updated successfully\.$/u.exec(content);
          if (!match) fail("unrecognized synthetic Edit result");
          probeTarget(match[1], options);
        }
      } else exactOutput(item.content, `shell-${options.marker}`, options, { empty: true });
    }
  }
  for (const text of childTexts.values()) if (text !== options.marker) fail("child did not return the exact marker");
}

function operationalNodes(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + operationalNodes(item), 0);
  if (!object(value)) return 0;
  const operational = typeof value.type === "string" && /tool|call|command_execution|file_change|patch_apply/iu.test(value.type);
  return Number(operational) + Object.values(value).reduce((sum, item) => sum + operationalNodes(item), 0);
}

function project(text, options) {
  const records = parseRecords(text);
  const retained = options.runtime === "codex" ? projectCodex(records, options) : projectClaude(records, options);
  if (operationalNodes(records) !== operationalNodes(retained)) fail("hidden operational evidence would be discarded");
  validateScopedActions(retained, options);
  return { text: `${retained.map((record) => JSON.stringify(record)).join("\n")}\n`, retainedRecords: retained.length, discardedRecords: records.length - retained.length };
}

export function collectNativeCliEventTape(rawText, options) {
  optionsFor(options, true);
  const projected = project(rawText, options);
  return {
    text: projected.text,
    capture: {
      schemaVersion: SCHEMA,
      source: "native_cli_stream",
      runtime: options.runtime,
      rawStdoutSha256: sha256(rawText),
      eventTapeSha256: sha256(projected.text),
      rawByteLength: Buffer.byteLength(rawText, "utf8"),
      retainedRecords: projected.retainedRecords,
      discardedRecords: projected.discardedRecords,
    },
  };
}

export function validateNativeCliEventTape(text, capture, options) {
  optionsFor(options, false);
  const keys = ["schemaVersion", "source", "runtime", "rawStdoutSha256", "eventTapeSha256", "rawByteLength", "retainedRecords", "discardedRecords"];
  if (!object(capture) || Object.keys(capture).sort().join("|") !== keys.sort().join("|") || capture.schemaVersion !== SCHEMA || capture.source !== "native_cli_stream" || capture.runtime !== options.runtime) fail("capture metadata mismatch");
  if (!SHA.test(capture.rawStdoutSha256) || !SHA.test(capture.eventTapeSha256) || typeof text !== "string" || sha256(text) !== capture.eventTapeSha256) fail("event tape hash mismatch");
  if (!Number.isInteger(capture.rawByteLength) || capture.rawByteLength < 1 || capture.rawByteLength > MAX_BYTES || !Number.isInteger(capture.retainedRecords) || capture.retainedRecords < 1 || !Number.isInteger(capture.discardedRecords) || capture.discardedRecords < 0 || capture.retainedRecords + capture.discardedRecords > MAX_RECORDS) fail("invalid capture counts");
  const replay = project(text, options);
  if (replay.text !== text || replay.discardedRecords !== 0 || replay.retainedRecords !== capture.retainedRecords) fail("tape is not canonical replay-complete evidence");
  // rawStdoutSha256 is a commitment to private capture bytes, not a hash of
  // this projection. The producer receipt must bind that commitment separately.
  return { text, capture: { ...capture } };
}
