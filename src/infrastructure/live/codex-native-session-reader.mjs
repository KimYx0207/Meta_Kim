import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locateCodexNativeChildren, locateCodexNativeTurn } from "./codex-native-turn-locator.mjs";

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

function commandProjectMatches(cwd, projectRoot) {
  try {
    let localPath = cwd;
    if (typeof cwd !== "string") return false;
    if (/^file:/iu.test(cwd)) {
      const url = new URL(cwd);
      if (url.hostname && url.hostname !== "localhost" || url.search || url.hash) return false;
      localPath = fileURLToPath(url);
    }
    return path.isAbsolute(localPath) && normalize(localPath) === normalize(projectRoot);
  } catch { return false; }
}

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

const MAX_HEADER_BYTES = 128 * 1024;
const MAX_METADATA_READ_BYTES = 512 * 1024;
const MAX_ANCHOR_READ_BYTES = 16 * 1024;
const ANCHOR_BYTES = 256;
const MAX_CACHED_SEGMENTS = 16;
const MAX_CACHED_ENTRIES = 4096;

async function boundedRead(handle, offset, length, budget, kind) {
  const remaining = budget[kind + "Remaining"];
  if (length > remaining) return null;
  const buffer = Buffer.alloc(length);
  let count = 0;
  while (count < length) {
    const part = await handle.read(buffer, count, length - count, offset + count);
    if (!part.bytesRead) break;
    count += part.bytesRead;
  }
  budget[kind + "Remaining"] -= count;
  budget[kind + "ReadBytes"] += count;
  return buffer.subarray(0, count);
}

/** A trusted header plus a bounded complete-line tail; subsequent reads consume only appends. */
async function snapshot(file, maximum, acceptMeta, onOmitted, segmentCache, budget, turnHint = null) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) fail("native_session_file_rejected");
  if (normalize(await realpath(file)) !== normalize(file)) fail("native_session_file_rejected");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1 || opened.ino !== before.ino || opened.dev !== before.dev) fail("native_session_file_changed");
    let cached = segmentCache.get(file);
    if (cached && (cached.ino !== opened.ino || cached.dev !== opened.dev || cached.birthtimeMs !== opened.birthtimeMs
      || opened.size < cached.size || (opened.size === cached.size && opened.mtimeMs !== cached.mtimeMs))) cached = null;
    // Metadata is revalidated even on an unchanged segment. A cached pathname or
    // thread id never substitutes for the native session header's authority.
    const headerParts = [];
    let headerLength = 0;
    const headerLimit = Math.min(opened.size, cached?.headerEnd || MAX_HEADER_BYTES);
    while (headerLength < headerLimit) {
      const part = await boundedRead(handle, headerLength, Math.min(cached?.headerEnd || 4096, headerLimit - headerLength), budget, "metadata");
      if (!part) { onOmitted("metadata_read_budget_exhausted"); return null; }
      headerParts.push(part);
      headerLength += part.length;
      if (part.includes(10) || !part.length) break;
    }
    const prefix = Buffer.concat(headerParts);
    const headerEnd = prefix.indexOf(10) + 1;
    let meta;
    try { if (!headerEnd) throw new Error(); meta = JSON.parse(prefix.subarray(0, headerEnd).toString("utf8")); }
    catch { segmentCache.delete(file); onOmitted("segment_metadata_unavailable"); return null; }
    if (meta.type !== "session_meta" || !acceptMeta(meta)) { segmentCache.delete(file); return null; }
    const headerSha = digest(prefix.subarray(0, headerEnd));
    if (cached?.headerSha !== headerSha) cached = null;
    if (cached) {
      const anchor = await boundedRead(handle, cached.anchorStart, cached.cursor - cached.anchorStart, budget, "anchor");
      if (!anchor) { onOmitted("anchor_read_budget_exhausted"); return null; }
      if (digest(anchor) !== cached.anchorSha) cached = null;
    }
    if (cached?.startAnchor) {
      const source = await boundedRead(handle, cached.startAnchor.offset, cached.startAnchor.length, budget, "anchor");
      if (!source) { onOmitted("anchor_read_budget_exhausted"); return null; }
      if (digest(source) !== cached.startAnchor.sha256) cached = null;
    }
    let start = cached?.cursor ?? headerEnd;
    let entries = cached ? [...cached.entries] : [];
    const reasons = new Set(cached?.reasons || []);
    let startAnchor = cached?.startAnchor || null;
    let validatedHint = null;
    // An indexed location is untrusted until the exact source record binds it.
    if (!cached && Number.isSafeInteger(turnHint?.offset) && turnHint.offset >= headerEnd && turnHint.offset < opened.size) {
      const probe = await boundedRead(handle, turnHint.offset, Math.min(4096, Math.floor(maximum / 4), opened.size - turnHint.offset, budget.bodyRemaining), budget, "body");
      const end = probe?.indexOf(10) ?? -1;
      if (end >= 0) {
        try {
          const source = JSON.parse(probe.subarray(0, end).toString("utf8"));
          const p = source.payload || {};
          if (source.type === "event_msg" && p.type === "task_started" && p.turn_id === turnHint.turnId
            && (!p.thread_id || p.thread_id === turnHint.threadId)) validatedHint = turnHint;
        } catch { /* The ordinary bounded tail remains available. */ }
      }
    }
    const windows = [];
    const allowance = Math.min(maximum, budget.bodyRemaining);
    if (validatedHint && opened.size - validatedHint.offset > allowance && allowance >= 1024) {
      const firstLength = Math.floor(allowance / 2);
      const lastLength = allowance - firstLength;
      windows.push({ start: validatedHint.offset, length: firstLength, aligned: true, gap: true, pinned: true });
      windows.push({ start: opened.size - lastLength, length: lastLength, aligned: false, gap: true });
      reasons.add("segment_prefix_omitted");
      reasons.add("segment_middle_omitted");
    } else if (validatedHint) {
      start = validatedHint.offset;
      windows.push({ start, length: Math.min(opened.size - start, allowance), aligned: true, gap: start > headerEnd, pinned: true });
      if (start > headerEnd) reasons.add("pre_turn_history_omitted");
    } else if (opened.size - start > allowance) {
      if (!budget.bodyRemaining) { onOmitted("segment_read_budget_exhausted"); return null; }
      start = Math.max(headerEnd, opened.size - allowance);
      entries = entries.filter((entry) => entry.pinnedStart === true);
      windows.push({ start, length: opened.size - start, aligned: false, gap: true });
      if (start > headerEnd) reasons.add("segment_prefix_omitted");
    } else if (opened.size > start) {
      windows.push({ start, length: opened.size - start, aligned: true, gap: false });
    }
    // A tail entirely inside an unfinished large line has no new safe cursor.
    let cursor = cached?.cursor ?? headerEnd;
    for (const window of windows) {
      const buffer = await boundedRead(handle, window.start, window.length, budget, "body");
      if (!buffer) { onOmitted("segment_read_budget_exhausted"); return null; }
      // Start/end may cut UTF-8 or JSON. Only LF-delimited complete bytes are decoded.
      let lineStart = window.aligned ? 0 : buffer.indexOf(10) + 1;
      if (!window.aligned && !lineStart) {
        reasons.add("partial_final_line");
        continue;
      }
      cursor = Math.max(cursor, window.start + lineStart);
      let gap = window.gap;
      let firstNewEntry = true;
      for (let newline = buffer.indexOf(10, lineStart); newline >= 0; newline = buffer.indexOf(10, lineStart)) {
        const lineEnd = buffer[newline - 1] === 13 ? newline - 1 : newline;
        const line = buffer.subarray(lineStart, lineEnd);
        try {
          if (line.length) {
            const record = JSON.parse(line.toString("utf8"));
            const projected = structuralEntries([{ record, sha256: digest(line) }]);
            for (const entry of projected) {
              entries.push({ ...entry, startOffset: window.start + lineStart, latestWindow: !window.pinned,
                ...(window.pinned ? { pinnedStart: true } : {}), ...(gap && firstNewEntry ? { gapBefore: true } : {}) });
              firstNewEntry = false;
            }
          }
        } catch { reasons.add("invalid_event_line"); gap = true; firstNewEntry = true; }
        lineStart = newline + 1;
        cursor = Math.max(cursor, window.start + lineStart);
      }
      if (window.pinned && buffer.length) {
        const length = Math.min(ANCHOR_BYTES, buffer.length);
        startAnchor = { offset: window.start, length, sha256: digest(buffer.subarray(0, length)) };
      }
    }
    if (!windows.length) budget.cachedSegments += 1;
    // Bound retained memory by the same byte window and by structural event count.
    // Dropping an unread/evicted prefix resets turn attribution at the retained edge.
    const pinned = entries.filter((entry) => entry.pinnedStart === true).slice(0, MAX_CACHED_ENTRIES / 2);
    const recent = entries.filter((entry) => !entry.pinnedStart && entry.startOffset >= opened.size - maximum).slice(-(MAX_CACHED_ENTRIES - pinned.length));
    const retained = [...pinned, ...recent];
    if (retained.length !== entries.length) {
      reasons.add("segment_structure_window_omitted");
      if (retained.length) retained[0] = { ...retained[0], gapBefore: true };
    }
    const anchorStart = Math.max(headerEnd, cursor - ANCHOR_BYTES);
    const anchor = await boundedRead(handle, anchorStart, Math.max(0, cursor - anchorStart), budget, "anchor");
    if (!anchor) { onOmitted("anchor_read_budget_exhausted"); return null; }
    const after = await lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink > 1 || after.ino !== opened.ino || after.dev !== opened.dev || after.size < opened.size) fail("native_session_file_changed");
    segmentCache.delete(file);
    segmentCache.set(file, { ino: opened.ino, dev: opened.dev, birthtimeMs: opened.birthtimeMs, size: opened.size, mtimeMs: opened.mtimeMs,
      headerEnd, headerSha, cursor, anchorStart, anchorSha: digest(anchor), startAnchor, entries: retained, reasons: [...reasons] });
    if (segmentCache.size > MAX_CACHED_SEGMENTS) segmentCache.delete(segmentCache.keys().next().value);
    for (const reason of reasons) onOmitted(reason);
    if (cursor < opened.size) onOmitted("partial_final_line");
    return retained;
  } finally { await handle.close(); }
}

/** Keep only parser inputs while joining bounded resume segments in memory. */
function structuralEntries(entries) {
  return entries.flatMap(({ record, sha256 }) => {
    const p = record.payload || {};
    let payload;
    if (record.type === "turn_context") payload = { turn_id: p.turn_id, thread_id: p.thread_id, cwd: p.cwd };
    else if (record.type === "response_item" && p.type === "function_call") {
      const args = boundedArguments(p.arguments);
      payload = { type: p.type, call_id: p.call_id, namespace: p.namespace, name: p.name,
        arguments: JSON.stringify({ task_name: args.taskName, agent_type: args.owner, message: args.role ? "roleDisplayName=" + args.role : "" }) };
    }
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
  for (const entries of segments) for (const entry of entries) {
    const previous = unique.get(entry.sha256);
    unique.set(entry.sha256, previous?.gapBefore ? { ...entry, gapBefore: true } : entry);
  }
  return [...unique.values()].sort((a, b) => (Date.parse(a.record.timestamp) || 0) - (Date.parse(b.record.timestamp) || 0));
}

function dayDirectories(sinceMs, nowMs, threadId) {
  const start = Math.max(sinceMs - 86_400_000, nowMs - 2 * 86_400_000);
  const result = new Set();
  const addDay = (time) => {
    const date = new Date(time);
    result.add([String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("/"));
  };
  for (let time = start; time <= nowMs + 86_400_000; time += 86_400_000) {
    addDay(time);
  }
  // Desktop appends to the creation-day file when an older chat resumes. The
  // UUIDv7 timestamp is only a bounded filename-search hint: metadata, project,
  // exact turn and event-window checks below still establish source authority.
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(threadId)) {
    const createdMs = Number.parseInt(threadId.replaceAll("-", "").slice(0, 12), 16);
    if (createdMs <= nowMs) {
      // Date directories may use the host timezone rather than UTC.
      for (const offset of [-86_400_000, 0, 86_400_000]) addDay(createdMs + offset);
    }
  }
  return [...result];
}

async function locateSegments(root, threadId, sinceMs, nowMs) {
  const files = [];
  for (const day of dayDirectories(sinceMs, nowMs, threadId)) {
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
  for (const { record, sha256, gapBefore } of records) {
    if (gapBefore) activeTurn = null;
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
  const segmentCache = new Map();
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
    const budget = { bodyRemaining: maxBytes, metadataRemaining: MAX_METADATA_READ_BYTES, anchorRemaining: MAX_ANCHOR_READ_BYTES, bodyReadBytes: 0, metadataReadBytes: 0, anchorReadBytes: 0, cachedSegments: 0 };
    const coverage = { state: "bounded", parentSegmentCount: candidates.length, parentReadCount: 0, childSegmentCount: 0, childReadCount: 0, reasons: [] };
    const finishCoverage = () => ({ ...coverage, reasons: [...omittedReasons], sourceBytesRead: budget.bodyReadBytes + budget.metadataReadBytes + budget.anchorReadBytes, bodyBytesRead: budget.bodyReadBytes, cachedSegmentCount: budget.cachedSegments, readByteLimit: maxBytes + MAX_METADATA_READ_BYTES + MAX_ANCHOR_READ_BYTES });
    const noteOmitted = (reason) => { coverage.state = "partial"; omittedReasons.add(reason); };
    const turnStarts = new Map();
    const targetTurnId = requestedTurnId || explicitTurnId;
    const turnHint = await locateCodexNativeTurn({ codexHome: root, threadId, turnId: targetTurnId });
    let selectedTurn = targetTurnId;
    for (const file of candidates) {
      // Leave half of the unchanged total byte budget for child-source proof.
      const records = await snapshot(file, Math.floor(maxBytes / 2), (meta) => validMeta([{ record: meta }], threadId, realProject), noteOmitted, segmentCache, budget, turnHint);
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
    if (!selected) return { state: "unavailable", reason: "exact_native_turn_not_observed", threadId, turnId: targetTurnId, coverage: finishCoverage() };
    const parentRecords = mergeSegmentEntries(parentSegments);
    const turnContexts = parentRecords.filter(({ record }) => record.type === "turn_context" && record.payload?.turn_id === selectedTurn);
    if (!turnContexts.length || turnContexts.some(({ record }) => {
      const context = record.payload;
      return (context.thread_id && context.thread_id !== threadId) || typeof context.cwd !== "string" || !path.isAbsolute(context.cwd) || normalize(context.cwd) !== normalize(realProject);
    })) return { state: "unavailable", reason: "native_turn_project_binding_unproven", threadId, turnId: selectedTurn, coverage: finishCoverage() };
    const observation = parseCodexNativeTurn(parentRecords, { threadId, turnId: selectedTurn, sinceMs });
    const startedMs = turnStarts.get(selectedTurn)?.task ?? turnStarts.get(selectedTurn)?.context;
    if (Number.isFinite(startedMs)) observation.startedAt = new Date(startedMs).toISOString();
    observation.commands = observation.commands.filter((command) => commandProjectMatches(command.cwd, realProject));
    const agentCandidates = [...observation.agents];
    const nativeChildren = await locateCodexNativeChildren({ codexHome: root, threadId, turnId: selectedTurn,
      maxBytes: Math.min(256 * 1024, budget.metadataRemaining) });
    if (nativeChildren) {
      budget.metadataRemaining -= nativeChildren.bytesRead;
      budget.metadataReadBytes += nativeChildren.bytesRead;
      if (nativeChildren.truncated) noteOmitted("child_candidate_limit");
      const known = new Set(agentCandidates.map((agent) => agent.childThreadId));
      for (const childThreadId of nativeChildren.candidates) {
        if (known.has(childThreadId)) continue;
        if (agentCandidates.length >= 64) { noteOmitted("child_candidate_limit"); break; }
        known.add(childThreadId);
        agentCandidates.push({ id: `child-source-${childThreadId}`, childThreadId, sourceOnlyCandidate: true });
      }
    }
    for (const agent of agentCandidates) {
      agent.completed = false;
      const sourceOnly = agent.sourceOnlyCandidate === true;
      const spawnMs = sourceOnly ? sinceMs : Date.parse(agent.at);
      const endMs = observation.turnCompletedAt ? Date.parse(observation.turnCompletedAt) : Infinity;
      const childFiles = await locateSegments(sessions, agent.childThreadId, sinceMs, now());
      const childHint = await locateCodexNativeTurn({ codexHome: root, threadId: agent.childThreadId, rootTurnId: selectedTurn });
      coverage.childSegmentCount += childFiles.length;
      const childSegments = [];
      let childIncomplete = false;
      let childHasGap = false;
      let childSpawnMetadata = null;
      for (const file of childFiles) {
        const records = await snapshot(file, Math.max(1024, Math.floor(maxBytes / 16)), (meta) => {
          const valid = validMeta([{ record: meta }], agent.childThreadId, realProject, threadId)
            && Number.isFinite(Date.parse(meta.timestamp)) && Date.parse(meta.timestamp) <= endMs
            && (sourceOnly || Date.parse(meta.timestamp) >= spawnMs - 5_000);
          if (valid) childSpawnMetadata = meta.payload.source.subagent.thread_spawn;
          return valid;
        }, (reason) => {
          if (["segment_prefix_omitted", "segment_middle_omitted", "segment_structure_window_omitted"].includes(reason)) childHasGap = true;
          else if (reason !== "pre_turn_history_omitted") childIncomplete = true;
          noteOmitted(reason);
        }, segmentCache, budget, childHint);
        if (records) { coverage.childReadCount += 1; childSegments.push(records); }
      }
      const records = mergeSegmentEntries(childSegments);
      const starts = records.filter(({ record }) => {
        const p = record.payload;
        const time = taskStartedMs(record);
        return record.type === "event_msg" && p?.type === "task_started" && p.turn_attribution?.parent_turn_id === selectedTurn && p.root_turn_id === selectedTurn && UUID.test(String(p.turn_id || "")) && time >= spawnMs - 5_000 && time <= endMs;
      });
      const childStart = starts.reduce((latest, entry) => !latest || taskStartedMs(entry.record) >= taskStartedMs(latest.record) ? entry : latest, null)?.record;
      if (!childStart) continue;
      const childStartIndex = records.findIndex(({ record }) => record === childStart);
      const childContexts = records.filter(({ record }) => record.type === "turn_context" && record.payload?.turn_id === childStart.payload.turn_id);
      if (childContexts.some(({ record }) => typeof record.payload?.cwd === "string" && normalize(record.payload.cwd) !== normalize(realProject))) continue;
      // The source header already binds cwd and parent thread; task_started
      // independently binds this exact parent turn. A huge turn_context line is
      // not required to rediscover the same project association.
      if (!childContexts.length) noteOmitted("child_turn_context_not_covered");
      // Copied parent history cannot select a child turn. Join only the latest
      // child start attributed to this exact parent turn, then replay its bounded
      // segments chronologically so resumed activity invalidates an old terminal.
      let completion = null;
      const startedAtMs = taskStartedMs(childStart);
      for (const entry of records.slice(childStartIndex + 1)) {
        if (entry.gapBefore) completion = null;
        if (entry.record.type === "turn_context" && entry.record.payload?.turn_id !== childStart.payload.turn_id) { completion = null; break; }
        const time = Date.parse(entry.record.timestamp);
        const p = entry.record.payload || {};
        if (entry.record.type === "event_msg" && p.type === "task_started" && p.turn_id !== childStart.payload.turn_id) { completion = null; break; }
        if (!Number.isFinite(time) || time < startedAtMs || time > endMs || (p.turn_id && p.turn_id !== childStart.payload.turn_id) || (p.thread_id && p.thread_id !== agent.childThreadId)) continue;
        if (nativeExecutionActivity(entry.record, agent.childThreadId, childStart.payload.turn_id)) completion = null;
        if (entry.record.type === "event_msg" && ["task_complete", "turn_complete"].includes(p.type) && p.turn_id === childStart.payload.turn_id) completion = entry;
      }
      agent.childMetadataVerified = true;
      agent.childTurnId = childStart.payload.turn_id;
      if (sourceOnly) {
        const sourcePath = safeId(childSpawnMetadata?.agent_path);
        Object.assign(agent, { observationBasis: "verified_child_parent_turn", spawnReturned: false,
          at: new Date(taskStartedMs(childStart)).toISOString(), sha256: childStart.sha256,
          childPath: sourcePath, taskName: sourcePath?.split("/").filter(Boolean).at(-1) || null,
          owner: safeId(childSpawnMetadata?.agent_role), role: "worker" });
        delete agent.sourceOnlyCandidate;
        observation.agents.push(agent);
        noteOmitted("parent_dispatch_record_not_covered");
      }
      if (completion && !childIncomplete && (!childHasGap || completion.latestWindow === true)) {
        agent.completed = true;
        agent.completedAt = completion.record.timestamp;
        agent.completionSha256 = completion.sha256;
      }
    }
    // Remove the raw cwd as soon as its exact match has been checked.
    observation.commands = observation.commands.map(({ cwd: _cwd, ...item }) => item);
    Object.assign(coverage, finishCoverage());
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
