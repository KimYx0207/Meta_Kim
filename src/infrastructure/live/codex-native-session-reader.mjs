import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 512;
const normalize = (value) => {
  const absolute = path.resolve(value).replace(/\\/gu, "/");
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const within = (root, value) => !path.relative(root, value).startsWith("..") && !path.isAbsolute(path.relative(root, value));
const safeId = (value) => typeof value === "string" && /^[A-Za-z0-9_:/.-]{1,180}$/u.test(value) ? value : null;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

async function plainDirectory(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("native_session_directory_rejected");
  const resolved = await realpath(directory);
  if (normalize(resolved) !== normalize(directory)) fail("native_session_directory_rejected");
  return resolved;
}

/** Read one append-safe bounded snapshot; source files are never changed. */
async function snapshot(file, maximum, acceptMeta, onOmitted = () => {}) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) fail("native_session_file_rejected");
  if (before.size > maximum) { onOmitted("segment_size_limit"); return null; }
  if (normalize(await realpath(file)) !== normalize(file)) fail("native_session_file_rejected");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size > maximum) fail("native_session_file_changed");
    const prefix = Buffer.alloc(Math.min(opened.size, 128 * 1024));
    const headerRead = await handle.read(prefix, 0, prefix.length, 0);
    const header = prefix.subarray(0, headerRead.bytesRead).toString("utf8").split("\n")[0];
    let meta;
    try { meta = JSON.parse(header); } catch { onOmitted("segment_metadata_unavailable"); return null; }
    if (meta.type !== "session_meta" || !acceptMeta(meta)) return null;
    const buffer = Buffer.alloc(opened.size);
    let count = 0;
    while (count < buffer.length) {
      const part = await handle.read(buffer, count, buffer.length - count, count);
      if (!part.bytesRead) break;
      count += part.bytesRead;
    }
    const after = await lstat(file);
    if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev) fail("native_session_file_changed");
    const text = buffer.subarray(0, count).toString("utf8");
    // A concurrently appended final line is not a complete event yet.
    if (!text.endsWith("\n")) onOmitted("partial_final_line");
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    return complete.split(/\r?\n/u).filter(Boolean).map((line) => {
      try { return { record: JSON.parse(line), sha256: digest(line) }; } catch { onOmitted("invalid_event_line"); return null; }
    }).filter(Boolean);
  } finally {
    await handle.close();
  }
}

/** Keep only parser inputs while joining bounded resume segments in memory. */
function structuralEntries(entries) {
  return entries.flatMap(({ record, sha256 }) => {
    const p = record.payload || {};
    let payload;
    if (record.type === "turn_context") payload = { turn_id: p.turn_id, cwd: p.cwd };
    else if (record.type === "response_item" && p.type === "function_call") payload = { type: p.type, call_id: p.call_id, namespace: p.namespace, name: p.name, arguments: typeof p.arguments === "string" && Buffer.byteLength(p.arguments) <= 32_768 ? p.arguments : null };
    else if (record.type === "response_item" && p.type === "function_call_output") payload = { type: p.type, call_id: p.call_id };
    else if (record.type === "event_msg" && ["task_started", "task_complete", "turn_complete", "item_completed"].includes(p.type)) {
      payload = { type: p.type, thread_id: p.thread_id, turn_id: p.turn_id, started_at: p.started_at, completed_at_ms: p.completed_at_ms, root_turn_id: p.root_turn_id, turn_attribution: { parent_turn_id: p.turn_attribution?.parent_turn_id } };
      if (p.item?.type === "CommandExecution") payload.item = { type: p.item.type, id: p.item.id, cwd: p.item.cwd, status: p.item.status, exit_code: p.item.exit_code, duration: p.item.duration };
      else if (p.item?.type === "SubAgentActivity") payload.item = { type: p.item.type, id: p.item.id, agent_thread_id: p.item.agent_thread_id, agent_path: p.item.agent_path, kind: p.item.kind };
    }
    return payload ? [{ record: { type: record.type, timestamp: record.timestamp, payload }, sha256 }] : [];
  });
}

/** Exact source-line duplicates do not replay terminals or double-count work. */
function mergeSegmentEntries(segments) {
  const unique = new Map();
  for (const entries of segments) for (const entry of entries) if (!unique.has(entry.sha256)) unique.set(entry.sha256, entry);
  return [...unique.values()].sort((a, b) => (Date.parse(a.record.timestamp) || 0) - (Date.parse(b.record.timestamp) || 0));
}

function dayDirectories(sinceMs, nowMs) {
  const start = Math.max(sinceMs - 86_400_000, nowMs - 2 * 86_400_000);
  const result = new Set();
  for (let time = start; time <= nowMs + 86_400_000; time += 86_400_000) {
    const date = new Date(time);
    result.add([String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("/"));
  }
  return [...result];
}

async function locateSegments(root, threadId, sinceMs, nowMs) {
  const files = [];
  for (const day of dayDirectories(sinceMs, nowMs)) {
    let cursor = root;
    try {
      for (const part of day.split("/")) {
        cursor = path.join(cursor, part);
        await plainDirectory(cursor);
      }
      const names = await readdir(cursor);
      for (const name of names) {
        if (name.startsWith("rollout-") && name.endsWith(".jsonl") && name.includes(threadId) && !name.includes(path.sep)) {
          files.push(path.join(cursor, name));
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (files.length > 16) fail("native_session_segment_limit");
  return files.sort().reverse();
}

function validMeta(records, threadId, projectRoot, parentThreadId = null) {
  const meta = records.find(({ record }) => record.type === "session_meta")?.record.payload;
  if (!meta || meta.id !== threadId || meta.originator !== "Codex Desktop" || typeof meta.cwd !== "string") return false;
  if (normalize(meta.cwd) !== normalize(projectRoot)) return false;
  if (parentThreadId && meta.source?.subagent?.thread_spawn?.parent_thread_id !== parentThreadId) return false;
  return !parentThreadId || meta.source?.subagent?.thread_spawn?.parent_thread_id === parentThreadId;
}

function boundedArguments(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 32_768) return {};
  try {
    const args = JSON.parse(raw);
    const role = /roleDisplayName\s*[=:]\s*([a-z]{2,20})/u.exec(String(args.message || ""))?.[1];
    const label = (value) => typeof value === "string" && /^[a-z0-9_-]{1,64}$/iu.test(value) ? value : null;
    return { taskName: label(args.task_name), owner: label(args.agent_type), role: role || null };
  } catch { return {}; }
}

function eventTime(record, payload) {
  const at = Number.isFinite(payload.completed_at_ms) ? payload.completed_at_ms : Date.parse(record.timestamp);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function taskStartedMs(record) {
  const supplied = record.payload?.started_at;
  const time = typeof supplied === "number" ? supplied * (supplied < 1e12 ? 1000 : 1) : Date.parse(record.timestamp);
  return Number.isFinite(new Date(time).valueOf()) ? time : Date.parse(record.timestamp);
}

function rememberTurnStart(starts, record, threadId) {
  const p = record.payload || {};
  if (!UUID.test(String(p.turn_id || "")) || (p.thread_id && p.thread_id !== threadId)) return;
  const field = record.type === "turn_context" ? "context" : record.type === "event_msg" && p.type === "task_started" ? "task" : null;
  if (!field) return;
  const time = field === "task" ? taskStartedMs(record) : Date.parse(record.timestamp);
  if (!Number.isFinite(time)) return;
  const previous = starts.get(p.turn_id) || {};
  previous[field] = Math.min(previous[field] ?? Infinity, time);
  starts.set(p.turn_id, previous);
}

function nativeExecutionActivity(record, threadId, turnId) {
  const p = record.payload || {};
  if (record.type === "response_item") return ["function_call", "function_call_output"].includes(p.type) && Boolean(safeId(p.call_id));
  return record.type === "event_msg" && p.type === "item_completed" && p.thread_id === threadId && p.turn_id === turnId &&
    Boolean(safeId(p.item?.id)) && ["CommandExecution", "SubAgentActivity"].includes(p.item?.type);
}

/** Parse only whitelisted structural native fields; raw prompts/output never leave this module. */
export function parseCodexNativeTurn(records, { threadId, turnId, sinceMs = 0 } = {}) {
  let activeTurn = null;
  const turnStarts = new Map();
  const calls = new Map();
  const outputs = new Map();
  const activities = new Map();
  const commands = new Map();
  let turnComplete = false;
  let turnCompletedAt = null;
  const unique = new Map();
  for (const { record, sha256 } of records) {
    const p = record.payload || {};
    const timestamp = Date.parse(record.timestamp);
    rememberTurnStart(turnStarts, record, threadId);
    if (record.type === "turn_context") {
      activeTurn = p.turn_id;
    }
    if (!Number.isFinite(timestamp) || timestamp < sinceMs) continue;
    const matches = p.turn_id ? p.turn_id === turnId && (!p.thread_id || p.thread_id === threadId) : activeTurn === turnId;
    if (!matches) continue;
    const at = eventTime(record, p);
    // A terminal describes the state at that journal position. A resumed tool
    // call/result in the same exact turn invalidates it until another terminal.
    if (turnComplete && nativeExecutionActivity(record, threadId, turnId)) {
      turnComplete = false;
      turnCompletedAt = null;
    }
    if (record.type === "response_item" && p.type === "function_call" && safeId(p.call_id)) {
      calls.set(p.call_id, { id: p.call_id, name: safeId(p.name), namespace: safeId(p.namespace), ...boundedArguments(p.arguments), at, sha256 });
    }
    if (record.type === "response_item" && p.type === "function_call_output" && safeId(p.call_id)) outputs.set(p.call_id, at);
    if (record.type !== "event_msg") continue;
    if (["task_complete", "turn_complete"].includes(p.type)) { turnComplete = true; turnCompletedAt = at; }
    if (p.type !== "item_completed" || p.thread_id !== threadId || p.turn_id !== turnId) continue;
    const item = p.item || {};
    if (!safeId(item.id)) continue;
    if (item.type === "SubAgentActivity" && UUID.test(String(item.agent_thread_id || ""))) {
      const previous = activities.get(item.id);
      activities.set(item.id, { id: item.id, childThreadId: item.agent_thread_id, childPath: safeId(item.agent_path), kind: safeId(item.kind), at, sha256, ...previous });
      unique.set(`agent:${item.id}`, sha256);
    }
    if (item.type === "CommandExecution" && typeof item.cwd === "string") {
      commands.set(item.id, { id: item.id, cwd: item.cwd, status: safeId(item.status), exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null, durationMs: Number.isFinite(item.duration) ? item.duration : null, at, sha256 });
      unique.set(`command:${item.id}`, sha256);
    }
  }
  const agents = [...activities.values()].filter((item) => {
    const call = calls.get(item.id);
    return call?.namespace === "collaboration" && call.name === "spawn_agent" && outputs.has(item.id);
  }).map((item) => ({ ...item, ...calls.get(item.id), spawnReturned: true }));
  const startedMs = turnStarts.get(turnId)?.task ?? turnStarts.get(turnId)?.context;
  return { threadId, turnId, startedAt: Number.isFinite(startedMs) ? new Date(startedMs).toISOString() : null, turnComplete, turnCompletedAt, agents: agents.slice(-64), commands: [...commands.values()].slice(-MAX_EVENTS), pairedToolCalls: [...calls.values()].filter((item) => outputs.has(item.id)).map((item) => ({ ...item, endedAt: outputs.get(item.id) })).slice(-MAX_EVENTS), sourceEventCount: unique.size };
}

/**
 * Create an explicitly bound, read-only Desktop observer. It never discovers a
 * different conversation by title/mtime and never writes native or project state.
 */
export function createCodexNativeSessionReader(options = {}) {
  const threadId = String(options.threadId || "").toLowerCase();
  const explicitTurnId = options.turnId ? String(options.turnId).toLowerCase() : null;
  if (!UUID.test(threadId) || (explicitTurnId && !UUID.test(explicitTurnId))) fail("native_session_binding_invalid");
  if (!path.isAbsolute(options.projectRoot || "")) fail("native_session_project_invalid");
  const codexHome = path.resolve(options.codexHome || path.join(os.homedir(), ".codex"));
  const projectRoot = path.resolve(options.projectRoot);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sinceMs = options.sinceMs === undefined ? now() - 86_400_000 : Number(options.sinceMs);
  if (!Number.isFinite(sinceMs) || sinceMs < 0 || sinceMs > now()) fail("native_session_since_invalid");
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 1024 && options.maxBytes <= DEFAULT_MAX_BYTES ? options.maxBytes : DEFAULT_MAX_BYTES;
  const cache = new Map();
  const readCurrent = async (requestedTurnId = null) => {
    const root = await plainDirectory(codexHome);
    const sessions = await plainDirectory(path.join(root, "sessions"));
    if (!within(root, sessions)) fail("native_session_path_escape");
    const realProject = await realpath(projectRoot);
    if (normalize(realProject) !== normalize(projectRoot)) fail("native_session_project_rejected");
    const candidates = await locateSegments(sessions, threadId, sinceMs, now());
    let selected = null;
    const parentSegments = [];
    const omittedReasons = new Set();
    const coverage = { state: "bounded", parentSegmentCount: candidates.length, parentReadCount: 0, childSegmentCount: 0, childReadCount: 0, reasons: [] };
    const noteOmitted = (reason) => { coverage.state = "partial"; omittedReasons.add(reason); };
    const turnStarts = new Map();
    const targetTurnId = requestedTurnId || explicitTurnId;
    let selectedTurn = targetTurnId;
    for (const file of candidates) {
      const rawRecords = await snapshot(file, maxBytes, (meta) => validMeta([{ record: meta }], threadId, realProject), noteOmitted);
      const records = rawRecords && structuralEntries(rawRecords);
      if (!records) continue;
      coverage.parentReadCount += 1;
      parentSegments.push(records);
      for (const { record } of records) rememberTurnStart(turnStarts, record, threadId);
      const turns = records.filter(({ record }) => record.type === "turn_context" && UUID.test(String(record.payload?.turn_id || "")) && Date.parse(record.timestamp) >= sinceMs);
      const match = targetTurnId ? turns.find(({ record }) => record.payload.turn_id === targetTurnId) : turns.at(-1);
      if (!match) continue;
      if (!selected || Date.parse(match.record.timestamp) > Date.parse(selected.timestamp)) {
        selected = { timestamp: match.record.timestamp };
        selectedTurn = match.record.payload.turn_id;
      }
    }
    if (!selected) return { state: "unavailable", reason: "exact_native_turn_not_observed", threadId, turnId: targetTurnId, coverage: { ...coverage, reasons: [...omittedReasons] } };
    const observation = parseCodexNativeTurn(mergeSegmentEntries(parentSegments), { threadId, turnId: selectedTurn, sinceMs });
    const startedMs = turnStarts.get(selectedTurn)?.task ?? turnStarts.get(selectedTurn)?.context;
    if (Number.isFinite(startedMs)) observation.startedAt = new Date(startedMs).toISOString();
    observation.commands = observation.commands.filter((command) => normalize(command.cwd) === normalize(realProject));
    for (const agent of observation.agents) {
      agent.completed = false;
      const spawnMs = Date.parse(agent.at);
      const endMs = observation.turnCompletedAt ? Date.parse(observation.turnCompletedAt) : Infinity;
      const childFiles = await locateSegments(sessions, agent.childThreadId, sinceMs, now());
      coverage.childSegmentCount += childFiles.length;
      const childSegments = [];
      let childIncomplete = false;
      for (const file of childFiles) {
        const records = await snapshot(file, maxBytes, (meta) => validMeta([{ record: meta }], agent.childThreadId, realProject, threadId) && Date.parse(meta.timestamp) >= spawnMs - 5_000 && Date.parse(meta.timestamp) <= endMs, (reason) => { childIncomplete = true; noteOmitted(reason); });
        if (records) { coverage.childReadCount += 1; childSegments.push(structuralEntries(records)); }
      }
      const records = mergeSegmentEntries(childSegments);
      const starts = records.filter(({ record }) => {
        const p = record.payload;
        const time = taskStartedMs(record);
        return record.type === "event_msg" && p?.type === "task_started" && p.turn_attribution?.parent_turn_id === selectedTurn && p.root_turn_id === selectedTurn && UUID.test(String(p.turn_id || "")) && time >= spawnMs - 5_000 && time <= endMs;
      });
      const childStart = starts.reduce((latest, entry) => !latest || taskStartedMs(entry.record) >= taskStartedMs(latest.record) ? entry : latest, null)?.record;
      if (!childStart) continue;
      const firstContextIndex = records.findIndex(({ record }) => record.type === "turn_context" && record.payload?.turn_id === childStart.payload.turn_id);
      if (firstContextIndex < 0) continue;
      const childContext = records[firstContextIndex].record;
      if (typeof childContext.payload?.cwd === "string" && normalize(childContext.payload.cwd) !== normalize(realProject)) continue;
      // Copied parent history cannot select a child turn. Join only the latest
      // child start attributed to this exact parent turn, then replay its bounded
      // segments chronologically so resumed activity invalidates an old terminal.
      let completion = null;
      const startedAtMs = taskStartedMs(childStart);
      for (const entry of records.slice(firstContextIndex + 1)) {
        if (entry.record.type === "turn_context" && entry.record.payload?.turn_id !== childContext.payload?.turn_id) break;
        const time = Date.parse(entry.record.timestamp);
        const p = entry.record.payload || {};
        if (!Number.isFinite(time) || time < startedAtMs || time > endMs || (p.turn_id && p.turn_id !== childStart.payload.turn_id) || (p.thread_id && p.thread_id !== agent.childThreadId)) continue;
        if (nativeExecutionActivity(entry.record, agent.childThreadId, childStart.payload.turn_id)) completion = null;
        if (entry.record.type === "event_msg" && ["task_complete", "turn_complete"].includes(p.type) && p.turn_id === childStart.payload.turn_id) completion = entry;
      }
      agent.childMetadataVerified = true;
      agent.childTurnId = childStart.payload.turn_id;
      if (completion && !childIncomplete) {
        agent.completed = true;
        agent.completedAt = completion.record.timestamp;
        agent.completionSha256 = completion.sha256;
      }
    }
    // Remove the raw cwd as soon as its exact match has been checked.
    observation.commands = observation.commands.map(({ cwd: _cwd, ...item }) => item);
    coverage.reasons = [...omittedReasons];
    return { state: "observed", sourceKind: "codex_desktop_native_session", readOnly: true, ...observation, coverage, observedAt: new Date(now()).toISOString(), binding: { threadId, turnId: selectedTurn, projectRootMatched: true }, limitations: ["Native execution observation is not semantic task acceptance.", "Only the bound current turn and verified child metadata are inspected.", ...(coverage.state === "partial" ? ["Some bounded native source segments or events were omitted; counts are partial observations."] : [])] };
  };
  const read = async (requestedTurnId = null) => {
    if (requestedTurnId && (!UUID.test(requestedTurnId) || (explicitTurnId && requestedTurnId !== explicitTurnId))) fail("native_session_turn_not_bound");
    const key = requestedTurnId || explicitTurnId || "latest";
    const current = cache.get(key);
    if (current?.value && now() < current.expires) return current.value;
    if (current?.promise) return current.promise;
    const entry = {};
    entry.promise = readCurrent(requestedTurnId).then((value) => { entry.value = value; entry.expires = now() + 750; return value; }).finally(() => { entry.promise = null; });
    cache.set(key, entry);
    if (cache.size > 16) cache.delete(cache.keys().next().value);
    return entry.promise;
  };
  return {
    threadId,
    projectRoot,
    read,
    readTurn: (turnId) => read(String(turnId).toLowerCase()),
  };
}
