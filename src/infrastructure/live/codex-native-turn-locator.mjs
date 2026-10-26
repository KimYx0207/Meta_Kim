import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

/** The host's existing index supplies an offset hint, never execution evidence. */
async function queryNativeIndex({ codexHome, threadId, turnId = null }, query) {
  if (typeof codexHome !== "string" || codexHome.length > 4096 || !path.isAbsolute(codexHome)
    || !UUID.test(String(threadId)) || (turnId && !UUID.test(String(turnId)))) return null;
  const file = path.join(codexHome, "thread_history_1.sqlite");
  let database;
  try {
    const directory = await lstat(codexHome);
    if (!directory.isDirectory() || directory.isSymbolicLink() || normalize(await realpath(codexHome)) !== normalize(codexHome)) return null;
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || normalize(await realpath(file)) !== normalize(file)) return null;
    for (const suffix of ["-wal", "-shm"]) {
      try {
        const sidecar = await lstat(file + suffix);
        if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink > 1 || normalize(await realpath(file + suffix)) !== normalize(file + suffix)) return null;
      } catch (error) { if (error.code !== "ENOENT") return null; }
    }
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(file, { readOnly: true });
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 25;");
    const result = query(database);
    const after = await lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink > 1 || after.ino !== before.ino || after.dev !== before.dev) return null;
    return result;
  } catch { return null; }
  finally { try { database?.close(); } catch { /* An optional hint cannot block source observation. */ } }
}

function indexedStatement(database, table, sql, args) {
  // Schema drift must not turn a locator into a scan of all native history.
  const plan = database.prepare("EXPLAIN QUERY PLAN " + sql).all(...args);
  if (!plan.length || plan.some((entry) => !new RegExp(`SEARCH ${table} USING (?:COVERING )?INDEX`, "iu").test(entry.detail))) return null;
  return database.prepare(sql);
}

export async function locateCodexNativeTurn({ codexHome, threadId, turnId = null, rootTurnId = null } = {}) {
  if (rootTurnId && !UUID.test(String(rootTurnId))) return null;
  return queryNativeIndex({ codexHome, threadId, turnId }, (database) => {
    // Older host indexes do not have an end locator. Keep their start lookup
    // working; neither column is a statement about execution or completion.
    const hasEndOffset = database.prepare("PRAGMA table_info(thread_turns)").all().some((column) => column.name === "rollout_end_byte_offset");
    const endColumn = hasEndOffset ? "rollout_end_byte_offset" : "NULL AS rollout_end_byte_offset";
    const hint = (row) => {
      if (!UUID.test(String(row?.turn_id)) || !Number.isSafeInteger(row.rollout_byte_offset) || row.rollout_byte_offset < 0) return null;
      return { threadId, turnId: row.turn_id, offset: row.rollout_byte_offset,
        ...(Number.isSafeInteger(row.rollout_end_byte_offset) && row.rollout_end_byte_offset > row.rollout_byte_offset
          ? { endOffset: row.rollout_end_byte_offset } : {}) };
    };
    if (!turnId && rootTurnId) {
      const sql = `SELECT turn_id, rollout_byte_offset, root_turn_id, ${endColumn} FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 64`;
      const row = indexedStatement(database, "thread_turns", sql, [threadId])?.all(threadId)
        .find((item) => item.root_turn_id === rootTurnId);
      return hint(row);
    }
    const sql = turnId
      ? `SELECT turn_id, rollout_byte_offset, ${endColumn} FROM thread_turns WHERE thread_id = ? AND turn_id = ? LIMIT 1`
      : `SELECT turn_id, rollout_byte_offset, ${endColumn} FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1`;
    const args = turnId ? [threadId, turnId] : [threadId];
    const row = indexedStatement(database, "thread_turns", sql, args)?.get(...args);
    return hint(row);
  });
}

/** Child ids are search hints only; names, calls and results need native source proof. */
export async function locateCodexNativeChildren({ codexHome, threadId, turnId, maxBytes = 256 * 1024 } = {}) {
  if (!turnId || !Number.isSafeInteger(maxBytes) || maxBytes < 4096) return null;
  return queryNativeIndex({ codexHome, threadId, turnId }, (database) => {
    const sql = "SELECT substr(CAST(item_json AS BLOB), 1, 4096) AS hint FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_type = 'subAgentActivity' ORDER BY rollout_ordinal LIMIT ?";
    const args = [threadId, turnId, Math.min(64, Math.floor(maxBytes / 4096))];
    const statement = indexedStatement(database, "thread_items", sql, args);
    if (!statement) return null;
    const candidates = new Set();
    let bytesRead = 0;
    const rows = statement.all(...args);
    for (const row of rows) {
      bytesRead += row.hint.byteLength;
      try {
        const item = JSON.parse(Buffer.from(row.hint).toString("utf8"));
        if (item.type === "subAgentActivity" && item.kind === "started" && UUID.test(String(item.agentThreadId))) candidates.add(item.agentThreadId.toLowerCase());
      } catch { /* Truncated or malformed rows confer no source identity. */ }
    }
    return { candidates: [...candidates], bytesRead, truncated: rows.length === args[2] };
  });
}
