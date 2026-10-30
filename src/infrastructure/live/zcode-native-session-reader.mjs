import os from "node:os";
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { importDatabaseSync } from "../../data/sqlite/runtime.mjs";
import { createProjectTaskIdentity } from "../../../canonical/runtime-assets/shared/hooks/spine-state.mjs";

const SESSION_ID = /^sess_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const TURN_ID = /^turn_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const LEGACY_RUN_ID = /^meta-\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-\d{3}z-[a-f0-9]{16}$/iu;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const MAX_MESSAGES = 512;
const MAX_PARTS = 2048;
const MAX_DISCOVERY_USERS_PER_SESSION = 128;
const MAX_DISCOVERY_INPUT_BYTES = 1024 * 1024;
const MAX_TEXT = 120;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u;

const normalizePath = (value) => {
  const resolved = path.resolve(value).replace(/\\/gu, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const cleanLabel = (value) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_TEXT)
  : "";
const isoTime = (value) => {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
    return Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null;
  }
  return null;
};
const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

async function requirePlainDirectory(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("zcode_directory_rejected");
  const resolved = await realpath(directory);
  if (normalizePath(resolved) !== normalizePath(directory)) fail("zcode_directory_rejected");
  return resolved;
}

async function resolveDatabase({ projectRoot, zcodeHome }) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) fail("zcode_project_root_invalid");
  const requestedProjectRoot = path.resolve(projectRoot);
  const canonicalProjectRoot = await requirePlainDirectory(requestedProjectRoot);
  const cliRoot = path.resolve(zcodeHome || path.join(os.homedir(), ".zcode", "cli"));
  const canonicalCliRoot = await requirePlainDirectory(cliRoot);
  const dbPath = path.join(canonicalCliRoot, "db", "db.sqlite");
  const dbDir = await requirePlainDirectory(path.dirname(dbPath));
  if (!inside(canonicalCliRoot, dbDir)) fail("zcode_database_path_rejected");
  const stat = await lstat(dbPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) fail("zcode_database_file_rejected");
  const canonicalDb = await realpath(dbPath);
  if (!inside(canonicalCliRoot, canonicalDb) || normalizePath(canonicalDb) !== normalizePath(dbPath)) fail("zcode_database_path_rejected");
  return { projectRoot: canonicalProjectRoot, cliRoot: canonicalCliRoot, dbPath: canonicalDb };
}

function requiredColumns(db, table, required) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  if (!required.every((column) => columns.has(column))) fail("zcode_schema_unavailable");
}

function validBinding(binding) {
  return binding && SESSION_ID.test(binding.sessionId || "") && TURN_ID.test(binding.turnId || "")
    && (!binding.runId || LEGACY_RUN_ID.test(binding.runId));
}

function unavailable(binding, code) {
  return { state: "unavailable", refusal: code, binding: { projectRootMatched: false },
    sessionId: binding?.sessionId || null, turnId: binding?.turnId || null };
}

/** Read a single explicitly bound ZCode session turn without opening any write path. */
export function createZcodeNativeSessionReader(binding = {}) {
  const readTurn = async (requestedTurnId = binding.turnId) => {
    if (!validBinding({ ...binding, turnId: requestedTurnId })) return unavailable(binding, "zcode_binding_invalid");
    let resolved;
    let db;
    try {
      resolved = await resolveDatabase(binding);
      const DatabaseSync = await importDatabaseSync();
      db = new DatabaseSync(resolved.dbPath, { readOnly: true });
      db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
      requiredColumns(db, "session", ["id", "directory"]);
      requiredColumns(db, "message", ["id", "session_id", "data", "sequence", "time_created"]);
      requiredColumns(db, "part", ["id", "message_id", "session_id", "data", "sequence"]);

      const session = db.prepare("SELECT id, directory FROM session WHERE id = ? LIMIT 1")
        .get(binding.sessionId);
      const projectMatched = Boolean(session && typeof session.directory === "string"
        && path.isAbsolute(session.directory)
        && normalizePath(path.resolve(session.directory)) === normalizePath(resolved.projectRoot));
      if (!projectMatched) return unavailable(binding, session ? "zcode_project_mismatch" : "zcode_session_not_found");

      const users = db.prepare(`
        SELECT id, sequence, json_extract(data, '$.role') AS role,
          json_extract(data, '$.anchor.turnId') AS turnId,
          json_extract(data, '$.anchor.origin') AS origin,
          json_extract(data, '$.time') AS at
        FROM message
        WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
          AND json_extract(data, '$.anchor.turnId') = ?
          AND json_extract(data, '$.anchor.origin') = 'realUser'
        ORDER BY sequence ASC LIMIT 2
      `).all(binding.sessionId, requestedTurnId);
      if (users.length !== 1) return unavailable(binding, users.length ? "zcode_turn_anchor_ambiguous" : "zcode_turn_anchor_not_found");
      const user = users[0];
      // Read only assistant descendants of the exact real-user anchor. The body,
      // prompt, metadata and raw JSON are never selected from SQLite.
      const messages = db.prepare(`
        WITH RECURSIVE turn_messages(id, sequence, createdAt, role, parentId, turnId, agent, at, finish) AS (
          SELECT id, sequence, time_created, json_extract(data, '$.role'), json_extract(data, '$.parentID'),
            json_extract(data, '$.anchor.turnId'), json_extract(data, '$.agent'),
            json_extract(data, '$.time'), json_extract(data, '$.finish')
          FROM message WHERE session_id = ? AND id = ?
          UNION ALL
          SELECT child.id, child.sequence, child.time_created, json_extract(child.data, '$.role'), json_extract(child.data, '$.parentID'),
            json_extract(child.data, '$.anchor.turnId'), json_extract(child.data, '$.agent'),
            json_extract(child.data, '$.time'), json_extract(child.data, '$.finish')
          FROM message AS child JOIN turn_messages AS parent ON json_extract(child.data, '$.parentID') = parent.id
          WHERE child.session_id = ? AND json_extract(child.data, '$.role') = 'assistant'
            AND (json_extract(child.data, '$.anchor.turnId') IS NULL OR json_extract(child.data, '$.anchor.turnId') = ?)
          LIMIT ?
        )
        SELECT id, sequence, createdAt, role, parentId, turnId, agent, at, finish FROM turn_messages ORDER BY sequence ASC
      `).all(binding.sessionId, user.id, binding.sessionId, requestedTurnId, MAX_MESSAGES + 1);
      const truncatedMessages = messages.length > MAX_MESSAGES;
      const boundedMessages = messages.slice(0, MAX_MESSAGES);
      const assistantMessages = boundedMessages.filter((row) => row.role === "assistant");
      if (!assistantMessages.length) return unavailable(binding, "zcode_turn_execution_not_observed");
      const messageIds = assistantMessages.map((row) => row.id);
      const parts = messageIds.length ? db.prepare(`
        SELECT id, message_id AS messageId, sequence,
          json_extract(data, '$.type') AS type,
          json_extract(data, '$.tool') AS tool,
          json_extract(data, '$.callID') AS callId,
          json_extract(data, '$.state.status') AS status,
          json_extract(data, '$.state.input.description') AS description,
          json_extract(data, '$.state.input.subagent_type') AS subagentType,
          json_extract(data, '$.state.time.start') AS startedAt,
          json_extract(data, '$.state.time.end') AS endedAt,
          json_extract(data, '$.state.title') AS title
        FROM part
        WHERE session_id = ? AND message_id IN (${messageIds.map(() => "?").join(",")})
          AND json_extract(data, '$.type') = 'tool'
        ORDER BY sequence ASC LIMIT ?
      `).all(binding.sessionId, ...messageIds, MAX_PARTS + 1) : [];
      const truncatedParts = parts.length > MAX_PARTS;
      const safeParts = parts.slice(0, MAX_PARTS).filter((part) => SAFE_NAME.test(part.tool || ""));
      const agents = [];
      const toolCalls = [];
      for (const part of safeParts) {
        const status = ["running", "completed", "error"].includes(part.status) ? part.status : "unknown";
        const partMessage = assistantMessages.find((message) => message.id === part.messageId);
        const at = isoTime(part.startedAt) || isoTime(partMessage?.at) || isoTime(partMessage?.createdAt) || isoTime(user.at) || isoTime(user.createdAt);
        const endedAt = isoTime(part.endedAt);
        const id = String(part.callId || part.id).slice(0, 180);
        if (part.tool === "Agent") {
          agents.push({ id, owner: cleanLabel(part.subagentType) || null, taskName: cleanLabel(part.description) || cleanLabel(part.title) || "子任务", at,
            status, completed: status === "completed" || status === "error", completedAt: endedAt });
        }
        toolCalls.push({ id, name: part.tool, status, at, endedAt });
      }
      const orderedTimes = [isoTime(user.at) || isoTime(user.createdAt), ...assistantMessages.map((row) => isoTime(row.at) || isoTime(row.createdAt)), ...safeParts.map((part) => isoTime(part.endedAt))].filter(Boolean).sort();
      const coverageReasons = [];
      if (truncatedMessages) coverageReasons.push("message_limit_reached");
      if (truncatedParts) coverageReasons.push("tool_part_limit_reached");
      if (agents.length) coverageReasons.push("child_tool_history_not_observed");
      const droppedToolPartCount = parts.slice(0, MAX_PARTS).length - safeParts.length;
      if (droppedToolPartCount) coverageReasons.push("unsupported_tool_record");
      const observation = {
        state: "observed",
        binding: { projectRootMatched: true, sessionMetadataVerified: true, userTurnAnchorVerified: true },
        sessionId: binding.sessionId,
        turnId: requestedTurnId,
        runId: binding.runId || null,
        title: "ZCode native session",
        observedAt: new Date().toISOString(),
        startedAt: orderedTimes[0] || null,
        updatedAt: orderedTimes.at(-1) || null,
        turnComplete: ["stop", "end_turn"].includes(assistantMessages.at(-1)?.finish)
          && !agents.some((agent) => agent.status === "running") && !toolCalls.some((call) => call.status === "running"),
        agents,
        toolCalls,
        coverage: { scope: "parent_turn", state: coverageReasons.length ? "partial" : "complete", reasons: coverageReasons,
          messageCount: assistantMessages.length, toolPartCount: safeParts.length, droppedToolPartCount, limits: { messages: MAX_MESSAGES, toolParts: MAX_PARTS } },
      };
      return observation;
    } catch (error) {
      return unavailable(binding, error?.code || "zcode_native_read_failed");
    } finally {
      try { db?.close(); } catch { /* preserve the read result */ }
    }
  };
  return {
    projectRoot: typeof binding.projectRoot === "string" ? path.resolve(binding.projectRoot) : null,
    read: () => readTurn(binding.turnId),
    readTurn,
  };
}

export function nativeZcodeRunId(binding = {}) {
  if (!validBinding(binding)) return null;
  return binding.runId || `native-zcode-${binding.sessionId}-${binding.turnId}`;
}

/** Find a unique native user-turn match from the existing project HMAC identity. */
export async function discoverZcodeNativeBinding({
  projectRoot,
  runId,
  profile = "default",
  zcodeHome,
  taskFingerprint = null,
  durableStatus = null,
} = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot) || !LEGACY_RUN_ID.test(runId || "")
    || !PROFILE_ID.test(profile || "")) return null;
  if (durableStatus !== null && (durableStatus?.runId !== runId || typeof durableStatus?.taskFingerprint !== "string")) return null;
  const expected = taskFingerprint || durableStatus?.taskFingerprint;
  if (typeof expected !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/iu.test(expected)) return null;
  let db;
  try {
    const resolved = await resolveDatabase({ projectRoot, zcodeHome });
    const DatabaseSync = await importDatabaseSync();
    db = new DatabaseSync(resolved.dbPath, { readOnly: true });
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    requiredColumns(db, "session", ["id", "directory", "parent_id", "time_deleted", "time_updated"]);
    requiredColumns(db, "message", ["id", "session_id", "data", "sequence", "time_created"]);
    const sessions = db.prepare(`
      SELECT id, directory FROM session
      WHERE directory = ? AND time_deleted IS NULL AND parent_id IS NULL
      ORDER BY time_updated DESC LIMIT 9
    `).all(resolved.projectRoot);
    if (sessions.length > 8) return null;
    const candidates = [];
    let inputBytesRemaining = MAX_DISCOVERY_INPUT_BYTES;
    for (const session of sessions) {
      if (!SESSION_ID.test(session.id || "") || normalizePath(path.resolve(session.directory || "")) !== normalizePath(resolved.projectRoot)) continue;
      const messageAnchors = db.prepare(`
        SELECT id, sequence, json_extract(data, '$.anchor.turnId') AS turnId,
          length(CAST(json_extract(data, '$.metadata.inputIntent.text') AS BLOB)) AS inputBytes
        FROM message
        WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
          AND json_type(data, '$.metadata.inputIntent.text') = 'text'
          AND length(CAST(json_extract(data, '$.metadata.inputIntent.text') AS BLOB)) BETWEEN 1 AND 65536
        ORDER BY sequence DESC LIMIT ${MAX_DISCOVERY_USERS_PER_SESSION + 1}
      `).all(session.id);
      if (messageAnchors.length > MAX_DISCOVERY_USERS_PER_SESSION) return null;
      const candidateBytes = messageAnchors.reduce((sum, message) => sum + Number(message.inputBytes || 0), 0);
      if (candidateBytes > inputBytesRemaining) return null;
      inputBytesRemaining -= candidateBytes;
      const messages = messageAnchors.length ? db.prepare(`
        SELECT id, json_extract(data, '$.anchor.turnId') AS turnId,
          json_extract(data, '$.metadata.inputIntent.text') AS inputIntent
        FROM message WHERE session_id = ? AND id IN (${messageAnchors.map(() => "?").join(",")})
      `).all(session.id, ...messageAnchors.map((message) => message.id)) : [];
      for (const message of messages) {
        if (!TURN_ID.test(message.turnId || "")) continue;
        const identity = await createProjectTaskIdentity(resolved.projectRoot, message.inputIntent, { profile, requireExisting: true });
        if (identity.ready === true && identity.taskFingerprint === expected) candidates.push({ sessionId: session.id, turnId: message.turnId });
        if (candidates.length > 1) return null;
      }
    }
    if (candidates.length !== 1) return null;
    return { projectRoot: resolved.projectRoot, zcodeHome: resolved.cliRoot, sessionId: candidates[0].sessionId, turnId: candidates[0].turnId, runId };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* discovery remains read only */ }
  }
}
