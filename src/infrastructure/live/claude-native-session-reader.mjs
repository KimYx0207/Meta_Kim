import { lstat, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createHash } from "node:crypto";
import { createProjectTaskIdentity } from "../../../canonical/runtime-assets/shared/hooks/spine-state.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const META_RUN = /^meta-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 4096;
const caches = new Map();
const normalized = (value) => {
  const resolved = path.resolve(value).replace(/\\/gu, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const samePath = (left, right) => typeof left === "string" && path.isAbsolute(left) && normalized(left) === normalized(right);
const safeLabel = (value) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 120) : "";
const safeTool = (value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u.test(value);
const at = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

async function plainDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || normalized(await realpath(directory)) !== normalized(directory)) throw new Error("claude_directory_unavailable");
  return path.resolve(directory);
}

async function sourceDirectory({ projectRoot, claudeHome }) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) throw new Error("claude_project_unavailable");
  const root = await plainDirectory(projectRoot);
  const home = await plainDirectory(claudeHome || path.join(os.homedir(), ".claude"));
  const projects = await plainDirectory(path.join(home, "projects"));
  const directory = await plainDirectory(path.join(projects, root.replace(/[^A-Za-z0-9]/gu, "-")));
  return { root, home, directory };
}

function realUser(row) {
  const content = row.message?.content;
  return row.type === "user" && row.isSidechain !== true && row.message?.role === "user"
    && (row.origin?.kind === "human" || row.promptSource === "sdk")
    && !(Array.isArray(content) && content.some((block) => block?.type === "tool_result"));
}

async function compactRow(row, { root, sessionId, profile, agentId }) {
  if (!UUID.test(row.uuid || "") || (agentId ? row.isSidechain !== true || row.agentId !== agentId : row.isSidechain === true) || (row.sessionId && row.sessionId !== sessionId)
    || (row.cwd && !samePath(row.cwd, root))) return null;
  const semantic = ["user", "assistant"].includes(row.type);
  if (semantic && (row.sessionId !== sessionId || !samePath(row.cwd, root))) return null;
  const sourceDigest = createHash("sha256").update(JSON.stringify([row.uuid, row.parentUuid, row.type, sessionId, agentId || null,
    row.timestamp, row.message?.stop_reason || null, row.isApiErrorMessage === true])).digest("hex");
  if (agentId) return { id: row.uuid, parentId: row.parentUuid, type: row.type, at: at(row.timestamp), sourceDigest,
    terminal: row.type === "assistant" && ["end_turn", "stop_sequence"].includes(row.message?.stop_reason),
    working: row.type === "assistant" && row.message?.stop_reason === "tool_use", error: row.type === "assistant" && row.isApiErrorMessage === true };
  const record = { id: row.uuid, parentId: row.parentUuid, type: row.type, at: at(row.timestamp), sourceDigest, user: realUser(row), tools: [], results: [],
    terminal: row.type === "assistant" && ["end_turn", "stop_sequence"].includes(row.message?.stop_reason), error: row.type === "assistant" && row.isApiErrorMessage === true };
  const content = row.message?.content;
  if (record.user) {
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n") : "";
    if (text && Buffer.byteLength(text) <= 65536) {
      const identity = await createProjectTaskIdentity(root, text, { profile, requireExisting: true });
      record.fingerprint = identity.ready ? identity.taskFingerprint : null;
      record.identityPending = identity.ready !== true;
    }
  }
  for (const block of Array.isArray(content) ? content : []) {
    if (row.type === "assistant" && block?.type === "tool_use" && typeof block.id === "string" && safeTool(block.name)) {
      const agent = ["Agent", "Task"].includes(block.name);
      record.tools.push({ id: block.id.slice(0, 180), name: block.name,
        ...(agent ? { owner: safeLabel(block.input?.subagent_type) || null, taskName: safeLabel(block.input?.description) || "子任务" } : {}) });
    }
    if (row.type === "user" && block?.type === "tool_result" && typeof block.tool_use_id === "string") {
      record.results.push({ id: block.tool_use_id.slice(0, 180), error: block.is_error === true,
        background: row.toolUseResult?.status === "async_launched" || row.toolUseResult?.isAsync === true,
        agentId: /^[A-Za-z0-9_-]{1,80}$/u.test(row.toolUseResult?.agentId || "") ? row.toolUseResult.agentId : null });
    }
  }
  return record;
}

/** Keep compact source facts in memory; neither transcripts nor prompts are rewritten. */
async function readSource(binding) {
  const source = await sourceDirectory(binding);
  if (!UUID.test(binding.sessionId || "")) throw new Error("claude_session_unavailable");
  let filename = path.join(source.directory, `${binding.sessionId}.jsonl`);
  if (binding.agentId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/u.test(binding.agentId)) throw new Error("claude_agent_unavailable");
    const sessionDirectory = await plainDirectory(path.join(source.directory, binding.sessionId));
    const subagents = await plainDirectory(path.join(sessionDirectory, "subagents"));
    filename = path.join(subagents, `agent-${binding.agentId}.jsonl`);
  }
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || normalized(await realpath(filename)) !== normalized(filename)) throw new Error("claude_transcript_unavailable");
  const key = JSON.stringify([filename, source.root, binding.profile || "default"]);
  let cache = caches.get(key);
  if (cache?.pending) return cache.pending;
  if (cache?.size === info.size && cache?.modified === info.mtimeMs && cache?.inode === info.ino && !cache.identityPending) return cache;
  const initial = !cache || cache.identityPending || cache.inode !== info.ino || info.size < cache.size || (info.size === cache.size && info.mtimeMs !== cache.modified);
  if (initial) cache = { rows: [], remainder: "", decoder: new StringDecoder("utf8"), size: 0, inode: info.ino, partial: false, bytesRead: 0 };
  caches.set(key, cache);
  if (caches.size > 16) caches.delete(caches.keys().next().value);
  const pending = (async () => {
    let start = cache.size;
    let tailRead = false;
    if (info.size - start > MAX_BYTES) {
      start = info.size - MAX_BYTES;
      cache.rows = [];
      cache.remainder = "";
      cache.decoder = new StringDecoder("utf8");
      cache.partial = true;
      tailRead = true;
    }
    const handle = await open(filename, "r");
    let buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== info.ino) throw new Error("claude_transcript_changed");
      buffer = Buffer.alloc(info.size - start);
      const read = await handle.read(buffer, 0, buffer.length, start);
      buffer = buffer.subarray(0, read.bytesRead);
      cache.size = start + read.bytesRead;
      cache.bytesRead += read.bytesRead;
    } finally { await handle.close(); }
    let raw = cache.remainder + cache.decoder.write(buffer);
    if (tailRead) raw = raw.slice(raw.indexOf("\n") + 1);
    const lines = raw.split("\n");
    cache.remainder = lines.pop() || "";
    if (cache.remainder.length > 1024 * 1024) { cache.remainder = ""; cache.partial = true; }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = await compactRow(JSON.parse(line), { ...source, sessionId: binding.sessionId, profile: binding.profile || "default", agentId: binding.agentId });
        if (row) {
          const existing = cache.rows.findIndex((candidate) => candidate.id === row.id);
          if (existing >= 0) cache.rows[existing] = row;
          else cache.rows.push(row);
        }
      } catch { cache.partial = true; }
    }
    if (cache.rows.length > MAX_ROWS) { cache.rows = cache.rows.slice(-MAX_ROWS); cache.partial = true; }
    cache.identityPending = cache.rows.some((row) => row.identityPending);
    cache.modified = info.mtimeMs;
    return cache;
  })();
  cache.pending = pending;
  try { return await pending; } finally { delete cache.pending; }
}

async function observe(cache, binding) {
  const user = cache.rows.find((row) => row.user && row.id === binding.turnId && (!binding.taskFingerprint || row.fingerprint === binding.taskFingerprint));
  if (!user) return { state: "unavailable", refusal: "claude_turn_not_observed" };
  const rowsById = new Map(cache.rows.map((row) => [row.id, row]));
  const belongs = (row) => {
    const seen = new Set();
    let current = row;
    while (current && !seen.has(current.id)) {
      if (current.id === user.id) return true;
      if (current.user) return false;
      seen.add(current.id);
      current = rowsById.get(current.parentId);
    }
    return false;
  };
  const rows = cache.rows.filter(belongs);
  const results = new Map(rows.flatMap((row) => row.results.map((result) => [result.id, { ...result, at: row.at, sourceEventId: row.id, sourceDigest: row.sourceDigest }])));
  const agents = [];
  const toolCalls = [];
  for (const row of rows) for (const tool of row.tools) {
    const result = results.get(tool.id);
    let status = !result || result.background ? "running" : result.error ? "error" : "completed";
    let endedAt = result && !result.background ? result.at : null;
    let returnEvidence = result && !result.background && !result.error
      ? { sourceEventId: result.sourceEventId, sourceDigest: result.sourceDigest, observedAt: result.at } : null;
    let statusReason = null;
    if (["Agent", "Task"].includes(tool.name) && result?.background) {
      status = "unknown";
      statusReason = result.agentId ? "尚未读到可确认执行状态的子会话记录。" : "后台调用未记录子会话标识，执行状态尚未确认。";
      let child = null;
      if (result.agentId) {
        try { child = await readSource({ ...binding, agentId: result.agentId }); }
        catch { statusReason = "当前无法读取已关联子会话，执行状态尚未确认。"; }
      }
      const terminal = child?.rows.filter((record) => record.type === "assistant").at(-1);
      if (terminal?.terminal || terminal?.error) {
        status = terminal.error ? "error" : "completed";
        endedAt = terminal.at;
        returnEvidence = terminal.error ? null : { sourceEventId: terminal.id, sourceDigest: terminal.sourceDigest, observedAt: terminal.at };
        statusReason = null;
      } else if (terminal?.working && !child.rows.slice(child.rows.indexOf(terminal) + 1).some((record) => record.type === "user")) {
        status = "running";
        statusReason = "已观察到该子会话进入原生工具执行阶段。";
      }
    }
    const call = { id: tool.id, name: tool.name, status, at: row.at, endedAt, ...(returnEvidence ? { returnEvidence } : {}), ...(statusReason ? { statusReason } : {}) };
    toolCalls.push(call);
    if (["Agent", "Task"].includes(tool.name)) agents.push({ ...call, owner: tool.owner, taskName: tool.taskName, completed: status === "completed" || status === "error", completedAt: endedAt });
  }
  const reasons = cache.partial ? ["earlier_history_not_observed"] : [];
  if (agents.length) reasons.push("child_tool_history_not_observed");
  const latestAssistant = rows.filter((row) => row.type === "assistant").at(-1);
  const turnError = latestAssistant?.error === true;
  const turnComplete = turnError || latestAssistant?.terminal === true && !toolCalls.some((call) => call.status === "running");
  return { state: "observed", runtime: "claude", binding: { projectRootMatched: true, sessionMetadataVerified: true, userTurnAnchorVerified: true },
    sessionId: binding.sessionId, turnId: user.id, runId: binding.runId || null, title: "当前 Claude Code 执行记录", startedAt: user.at,
    updatedAt: rows.map((row) => row.at).filter(Boolean).sort().at(-1) || user.at, observedAt: new Date().toISOString(), turnComplete, turnError,
    turnReturnEvidence: turnComplete && !turnError ? { sourceEventId: latestAssistant.id, sourceDigest: latestAssistant.sourceDigest, observedAt: latestAssistant.at } : null,
    agents, toolCalls,
    coverage: { scope: "parent_turn", state: reasons.length ? "partial" : "complete", reasons, sourceBytesRead: cache.bytesRead, retainedRecordCount: cache.rows.length } };
}

export function createClaudeNativeSessionReader(binding = {}) {
  return { projectRoot: binding.projectRoot,
    async read() { try { return observe(await readSource(binding), binding); } catch { return { state: "unavailable", refusal: "claude_transcript_not_observed" }; } },
  };
}

/** Resolve an existing governed run to one exact native input, without another index. */
export async function discoverClaudeNativeBinding({ projectRoot, runId, profile = "default", durableStatus, claudeHome } = {}) {
  if (!META_RUN.test(runId || "") || durableStatus?.runId !== runId || !/^hmac-sha256:[a-f0-9]{64}$/u.test(durableStatus?.taskFingerprint || "")) return null;
  const conversation = durableStatus.sourceConversation;
  if (conversation?.runtime && conversation.runtime !== "claude") return null;
  const hint = durableStatus.stageRuntimeControl?.nativeSessionHint;
  const sessionId = conversation?.conversationId || (hint?.runtime === "claude" ? hint.sessionId : null);
  if (!UUID.test(sessionId || "")) return null;
  try {
    const source = await sourceDirectory({ projectRoot, claudeHome });
    const matches = [];
    for (const candidateSessionId of [sessionId]) {
      const binding = { runtime: "claude", projectRoot: source.root, claudeHome: source.home, sessionId: candidateSessionId, runId, profile, taskFingerprint: durableStatus.taskFingerprint };
      const cache = await readSource(binding).catch(() => null);
      for (const row of cache?.rows || []) if (row.user && row.fingerprint === durableStatus.taskFingerprint) matches.push({ ...binding, turnId: row.id });
      if (matches.length > 1) return null;
    }
    return matches.length === 1 ? matches[0] : null;
  } catch { return null; }
}
