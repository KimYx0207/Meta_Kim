/** Durable, fail-closed receipts for native read-only B2 design drafts. */
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";

import { AGENT_WORKFLOW_KEY_PATTERN, agentWorkflowConflict } from "../../domain/runtime/agent-workflow-decision.mjs";

export const AGENT_DRAFT_RECORD_SCHEMA = "meta-kim-native-design-draft-record-v1";
const MAX_RECORD = 256 * 1024;
const MAX_ATTEMPTS = 24;
const FILE = /^d-([A-Za-z0-9_-]{16,128})\.json$/u;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function folder(stateRoot, key) {
  if (!AGENT_WORKFLOW_KEY_PATTERN.test(key ?? "")) throw new TypeError("Invalid draft owner key");
  return path.join(stateRoot, `${key}.drafts`);
}

function ensureFolder(target, create = false) {
  if (create && !existsSync(target)) {
    try { mkdirSync(target, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (!existsSync(target)) return false;
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw agentWorkflowConflict("agent_draft_state_path_invalid");
  return true;
}

function recordFile(target, draftKey) {
  if (!AGENT_WORKFLOW_KEY_PATTERN.test(draftKey ?? "")) throw new TypeError("Invalid native draft key");
  return path.join(target, `d-${draftKey}.json`);
}

function readOne(filename, owner, fingerprint) {
  let fd;
  try {
    if (lstatSync(filename).isSymbolicLink()) throw new Error("symlink");
    fd = openSync(filename, constants.O_RDONLY | O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_RECORD) throw new Error("size");
    const row = JSON.parse(readFileSync(fd, "utf8"));
    if (!row || row.schemaVersion !== AGENT_DRAFT_RECORD_SCHEMA
      || row.idempotencyKey !== owner || row.projectFingerprint !== fingerprint
      || row.draftKey !== FILE.exec(path.basename(filename))[1]) throw new Error("identity");
    return row;
  } catch {
    throw agentWorkflowConflict("agent_draft_receipt_corrupt");
  } finally { if (fd != null) closeSync(fd); }
}

function serialize(record) {
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json, "utf8") > MAX_RECORD) throw new TypeError("Native design draft record too large");
  return json;
}

export function createAgentDesignDraftStore({ stateRoot, projectFingerprint } = {}) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)
    || !statSync(stateRoot).isDirectory() || lstatSync(stateRoot).isSymbolicLink()
    || typeof projectFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(projectFingerprint)) {
    throw new TypeError("Invalid native draft state scope");
  }

  function all(key) {
    const target = folder(stateRoot, key);
    if (!ensureFolder(target)) return [];
    const names = readdirSync(target).filter((name) => FILE.test(name));
    if (names.length > MAX_ATTEMPTS) throw agentWorkflowConflict("agent_draft_capacity_reached");
    return names.map((name) => readOne(path.join(target, name), key, projectFingerprint))
      .sort((a, b) => Number.isInteger(a.attemptIndex) && Number.isInteger(b.attemptIndex)
        ? a.attemptIndex - b.attemptIndex
        : a.createdAt.localeCompare(b.createdAt) || a.draftKey.localeCompare(b.draftKey));
  }

  function reserve({ idempotencyKey, draftKey, record }) {
    const target = folder(stateRoot, idempotencyKey);
    ensureFolder(target, true);
    const lock = path.join(stateRoot, `${idempotencyKey}.draft-lock`);
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code === "EEXIST") throw agentWorkflowConflict("agent_draft_reservation_busy_or_in_doubt");
      throw error;
    }
    try {
      const previous = all(idempotencyKey);
      const existing = previous.find((item) => item.draftKey === draftKey);
      if (existing) {
        if (existing.bindingDigest !== record.bindingDigest) throw agentWorkflowConflict("agent_draft_key_conflict");
        return { record: existing, newRecord: false };
      }
      if (previous.some((item) => ["reserved", "accepted", "running"].includes(item.status))) {
        throw agentWorkflowConflict("agent_draft_prior_outcome_in_doubt");
      }
      if (previous.length >= MAX_ATTEMPTS) throw agentWorkflowConflict("agent_draft_capacity_reached");
      // Monotonic under the exclusive reservation lock, including when two
      // retries land in the same millisecond (filesystem sort order differs).
      record.attemptIndex = previous.length + 1;
      const file = recordFile(target, draftKey);
      let fd;
      try {
        fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
        writeFileSync(fd, serialize(record), "utf8");
        fsyncSync(fd);
      } catch (error) {
        if (error.code === "EEXIST") throw agentWorkflowConflict("agent_draft_key_conflict");
        throw error;
      } finally { if (fd != null) closeSync(fd); }
      return { record, newRecord: true };
    } finally { rmdirSync(lock); }
  }

  function replace(record) {
    const target = folder(stateRoot, record.idempotencyKey);
    ensureFolder(target);
    const destination = recordFile(target, record.draftKey);
    const temporary = path.join(target, `d-${record.draftKey}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
      writeFileSync(fd, serialize(record), "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temporary, destination);
    } finally {
      if (fd != null) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  return Object.freeze({ all, reserve, replace });
}
