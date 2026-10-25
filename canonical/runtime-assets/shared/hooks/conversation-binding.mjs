import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

/**
 * Filesystem-confirmed conversation binding for governed runs.
 *
 * A raw hook payload is caller-controlled, so a bare `session_id` string is not
 * proof that a conversation exists. What the payload also carries is
 * `transcript_path`. Claude-style transcripts use `<conversation id>.<ext>`;
 * Codex rollout filenames include a timestamp and may retain ancestor ids after
 * a fork. Confirm the regular, non-empty file and either its exact session name
 * or the identity in a Codex rollout's first `session_meta` record. Never infer a
 * binding from an id merely appearing somewhere in the filename or transcript.
 *
 * When any check fails the resolver refuses and names the failed check, so a run
 * stays honestly unlinked instead of carrying a guessed reference.
 */

export const CONVERSATION_BINDING_RUNTIMES = Object.freeze(["claude", "codex", "cursor", "openclaw"]);
export const CONVERSATION_BINDING_MATCH_BASIS = "transcript_file_verified";
export const CONVERSATION_BINDING_REFUSAL_REASONS = Object.freeze([
  "runtime_not_identified",
  "conversation_id_not_identified",
  "transcript_path_absent",
  "transcript_path_not_absolute",
  "transcript_identity_mismatch",
  "transcript_file_absent",
  "transcript_file_empty",
]);

const CONVERSATION_ID_PATTERN = /^[a-z0-9][a-z0-9:._-]{3,159}$/iu;
const TRANSCRIPT_EXTENSIONS = Object.freeze([".jsonl", ".ndjson", ".json"]);
const CODEX_SESSION_META_MAX_BYTES = 256 * 1024;
const UUID_PATTERN = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const CODEX_ROLLOUT_STEM_PATTERN = new RegExp(
  `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${UUID_PATTERN}(?:_${UUID_PATTERN})*$`,
  "iu",
);
const CONVERSATION_ID_KEYS = Object.freeze([
  "conversation_id",
  "conversationId",
  "thread_id",
  "threadId",
  "session_id",
  "sessionId",
  "composer_id",
  "composerId",
  "session_key",
  "sessionKey",
]);
const TRANSCRIPT_PATH_KEYS = Object.freeze([
  "transcript_path",
  "transcriptPath",
  "conversation_path",
  "conversationPath",
  "thread_path",
  "threadPath",
]);
const CONVERSATION_TITLE_KEYS = Object.freeze([
  "conversation_title",
  "conversationTitle",
  "thread_title",
  "threadTitle",
  "session_title",
  "sessionTitle",
]);

export function normalizeBindingRuntime(value) {
  const candidate = String(value ?? "").trim().toLowerCase();
  const runtime = candidate === "claude-code" ? "claude" : candidate;
  return CONVERSATION_BINDING_RUNTIMES.includes(runtime) ? runtime : null;
}

function firstMatching(payload, keys, accept) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "string" && accept(value.trim())) return value.trim();
  }
  return null;
}

function conversationIdFromPayload(payload) {
  return firstMatching(payload, CONVERSATION_ID_KEYS, (value) => CONVERSATION_ID_PATTERN.test(value));
}

function transcriptPathFromPayload(payload) {
  return firstMatching(payload, TRANSCRIPT_PATH_KEYS, (value) => value.length > 0);
}

function conversationTitleFromPayload(payload) {
  return firstMatching(
    payload,
    CONVERSATION_TITLE_KEYS,
    (value) => value.length > 0 && value.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(value),
  );
}

function transcriptStem(transcriptPath) {
  const name = basename(String(transcriptPath).replaceAll("\\", "/").replace(/\/+$/u, ""));
  const lowered = name.toLowerCase();
  for (const extension of TRANSCRIPT_EXTENSIONS) {
    if (lowered.endsWith(extension)) return name.slice(0, -extension.length);
  }
  return name;
}

function codexRolloutIdentityMatches(transcriptPath, conversationId) {
  // Only the native JSONL rollout family gets this alternative proof. Other
  // runtime filenames keep their exact-name contract.
  if (!String(transcriptPath).toLowerCase().endsWith(".jsonl")
    || !CODEX_ROLLOUT_STEM_PATTERN.test(transcriptStem(transcriptPath))) return false;

  let descriptor;
  try {
    descriptor = openSync(transcriptPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(descriptor).isFile()) return false;
    const buffer = Buffer.alloc(CODEX_SESSION_META_MAX_BYTES + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const lineEnd = buffer.subarray(0, bytesRead).indexOf(0x0a);
    const recordBytes = lineEnd >= 0 ? lineEnd : bytesRead;
    if (recordBytes > CODEX_SESSION_META_MAX_BYTES) return false;
    const record = JSON.parse(buffer.subarray(0, recordBytes).toString("utf8"));
    if (record?.type !== "session_meta" || !record.payload || Array.isArray(record.payload)) return false;
    const metadataId = record.payload.id;
    if (typeof metadataId !== "string" || metadataId.toLowerCase() !== conversationId.toLowerCase()) return false;
    // Desktop can include both keys. A conflicting or malformed alias is not
    // independent evidence of the claimed conversation.
    const sessionId = record.payload.session_id;
    return sessionId === undefined
      || (typeof sessionId === "string" && sessionId.toLowerCase() === conversationId.toLowerCase());
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function realFileFacts(transcriptPath) {
  const stats = statSync(transcriptPath);
  return { exists: true, isFile: stats.isFile(), size: stats.size };
}

function refuse(reason, runtime = null) {
  return { conversation: null, binding: { state: "unlinked", runtime, reason } };
}

export function resolveVerifiedSourceConversation(payload, { runtime, fileFacts = realFileFacts } = {}) {
  const boundRuntime = normalizeBindingRuntime(runtime ?? payload?.runtime);
  if (!boundRuntime) return refuse("runtime_not_identified");

  const conversationId = conversationIdFromPayload(payload);
  if (!conversationId) return refuse("conversation_id_not_identified", boundRuntime);

  const transcriptPath = transcriptPathFromPayload(payload);
  if (!transcriptPath) return refuse("transcript_path_absent", boundRuntime);
  // A relative path would only be resolvable through the hook process cwd, which
  // is itself caller-controlled, so it cannot carry the proof.
  if (!isAbsolute(transcriptPath) && !/^[a-z]:[\\/]/iu.test(transcriptPath)) {
    return refuse("transcript_path_not_absolute", boundRuntime);
  }
  const exactNameMatches = transcriptStem(transcriptPath).toLowerCase() === conversationId.toLowerCase();
  const codexRollout = boundRuntime === "codex"
    && CODEX_ROLLOUT_STEM_PATTERN.test(transcriptStem(transcriptPath));
  if (!exactNameMatches && !codexRollout) {
    return refuse("transcript_identity_mismatch", boundRuntime);
  }

  let facts;
  try {
    facts = fileFacts(transcriptPath);
  } catch {
    return refuse("transcript_file_absent", boundRuntime);
  }
  if (!facts?.exists || facts.isFile !== true) return refuse("transcript_file_absent", boundRuntime);
  if (!(Number(facts.size) > 0)) return refuse("transcript_file_empty", boundRuntime);
  if (!exactNameMatches && !codexRolloutIdentityMatches(transcriptPath, conversationId)) {
    return refuse("transcript_identity_mismatch", boundRuntime);
  }

  const title = conversationTitleFromPayload(payload);
  return {
    conversation: {
      runtime: boundRuntime,
      conversationId,
      matchBasis: CONVERSATION_BINDING_MATCH_BASIS,
      ...(title ? { title } : {}),
    },
    binding: {
      state: "verified",
      runtime: boundRuntime,
      basis: CONVERSATION_BINDING_MATCH_BASIS,
    },
  };
}
