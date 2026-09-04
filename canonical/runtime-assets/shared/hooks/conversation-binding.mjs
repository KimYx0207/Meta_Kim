import { statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

/**
 * Filesystem-confirmed conversation binding for governed runs.
 *
 * A raw hook payload is caller-controlled, so a bare `session_id` string is not
 * proof that a conversation exists. What the payload also carries is
 * `transcript_path`, and every supported runtime writes that transcript as
 * `<conversation id>.<ext>` on the local disk. Confirming that the named file
 * exists, is a regular file, is non-empty, and is named after the very session
 * the payload claims turns the hint into independent evidence: a caller cannot
 * assert a conversation it has not actually written.
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
  const name = basename(String(transcriptPath).replace(/[\\/]+$/u, ""));
  const lowered = name.toLowerCase();
  for (const extension of TRANSCRIPT_EXTENSIONS) {
    if (lowered.endsWith(extension)) return name.slice(0, -extension.length);
  }
  return name;
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
  if (transcriptStem(transcriptPath).toLowerCase() !== conversationId.toLowerCase()) {
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
