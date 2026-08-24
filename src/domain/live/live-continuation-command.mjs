import { canonicalDigest, canonicalize } from "../shared/canonical-digest.mjs";

/**
 * The command is the small, immutable contract shared by the live planner,
 * command log, and runtime adapter.  It is intentionally not a scheduler or
 * a run projection: the durable run repository remains the only execution
 * authority.
 */
export const LIVE_CONTINUATION_COMMAND_SCHEMA_VERSION =
  "meta-kim-live-continuation-command-v1";
export const LIVE_CONTINUATION_COMMAND_KIND = "live_continuation_command";
export const LIVE_CONTINUATION_ACTIONS = Object.freeze([
  "pause",
  "resume",
  "reassign",
  "handoff",
]);
export const LIVE_CONTINUATION_EFFECT_STATES = Object.freeze([
  "none",
  "reconciled",
  "reconciled_absent",
  "reconciled_completed",
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,255}$/u;
const RUNTIME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const MAX_PAYLOAD_BYTES = 16 * 1024;

const INPUT_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "commandId",
  "action",
  "runId",
  "nodeId",
  "expectedRevision",
  "checkpointId",
  "effectState",
  "claim",
  "lease",
  "attemptId",
  "ownerId",
  "leaseOwner",
  "leaseExpiresAtMs",
  "leaseExpiresAt",
  "fenceToken",
  "actor",
  "actorId",
  "runtimeAdapter",
  "runtimeAdapterId",
  "runtime",
  "nonce",
  "issuedAtMs",
  "issuedAt",
  "expiresAtMs",
  "expiresAt",
  "payload",
  "commandDigest",
]);

function fail(message, code = "LIVE_CONTINUATION_INVALID_COMMAND") {
  const error = new TypeError(`Live continuation command: ${message}`);
  error.code = code;
  throw error;
}

function isPlainRecord(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function assertPlainRecord(value, label) {
  if (!isPlainRecord(value)) fail(`${label} must be a plain record`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(`${label} has an unsupported key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail(`${label} must contain own data properties only`);
    }
  }
  return value;
}

function safeRef(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !ID_PATTERN.test(value) || containsSensitiveMarker(value)) {
    fail(`${label} must be a safe bounded reference`);
  }
  return value;
}

function safeRuntime(value, label) {
  if (typeof value !== "string" || !RUNTIME_PATTERN.test(value) || containsSensitiveMarker(value)) {
    fail(`${label} must be a safe runtime identifier`);
  }
  return value;
}

function containsSensitiveMarker(value) {
  const normalized = value.normalize("NFKC").toLowerCase();
  if (/(?:https?|ftp|file):|www\.|[\\/]/u.test(normalized)) return true;
  if (/(?:secret|password|credential|privatekey|apikey|accesstoken|bearertoken)/u.test(normalized.replace(/[^a-z0-9]/gu, ""))) return true;
  if (/^(?:sk|gh[pousr]|akia|asia)[a-z0-9_-]{12,}$/u.test(normalized.replace(/[^a-z0-9_-]/gu, ""))) return true;
  return false;
}

function safeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    fail(`${label} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return value;
}

function timestampMs(value, label, { defaultValue = null } = {}) {
  if (value === undefined && defaultValue !== null) return defaultValue;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  fail(`${label} must be a non-negative epoch millisecond timestamp`);
}

function cloneSafe(value, label = "payload", depth = 0) {
  if (depth > 8) fail(`${label} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && containsSensitiveMarker(value)) fail(`${label} contains forbidden material`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) fail(`${label} exceeds the bounded list size`);
    return value.map((item, index) => cloneSafe(item, `${label}[${index}]`, depth + 1));
  }
  if (!isPlainRecord(value)) fail(`${label} must contain JSON data only`);
  const result = {};
  const keys = Object.keys(value).sort();
  if (keys.length > 128) fail(`${label} exceeds the bounded field count`);
  for (const key of keys) {
    if (!ID_PATTERN.test(key) || containsSensitiveMarker(key)) fail(`${label} has an unsafe field name`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${label} must contain own data properties only`);
    result[key] = cloneSafe(descriptor.value, `${label}.${key}`, depth + 1);
  }
  return result;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function claimInput(input) {
  const raw = input.claim ?? input.lease;
  if (raw !== undefined) {
    assertPlainRecord(raw, "claim");
    return raw;
  }
  if (
    input.attemptId !== undefined ||
    input.ownerId !== undefined ||
    input.leaseOwner !== undefined ||
    input.leaseExpiresAtMs !== undefined ||
    input.leaseExpiresAt !== undefined ||
    input.fenceToken !== undefined
  ) {
    return {
      attemptId: input.attemptId ?? null,
      ownerId: input.ownerId ?? input.leaseOwner,
      leaseExpiresAtMs: input.leaseExpiresAtMs,
      leaseExpiresAt: input.leaseExpiresAt,
      fenceToken: input.fenceToken,
    };
  }
  fail("claim or lease binding is required", "LIVE_CONTINUATION_CLAIM_REQUIRED");
}

function normalizeClaim(input) {
  const raw = claimInput(input);
  const attemptId = raw.attemptId === undefined ? null : safeRef(raw.attemptId, "claim.attemptId", { nullable: true });
  const ownerId = safeRef(raw.ownerId ?? raw.leaseOwner, "claim.ownerId");
  const leaseExpiresAtMs = timestampMs(raw.leaseExpiresAtMs ?? raw.leaseExpiresAt, "claim.leaseExpiresAtMs");
  const fenceToken = safeInteger(raw.fenceToken, "claim.fenceToken", { positive: true });
  return { attemptId, ownerId, leaseExpiresAtMs, fenceToken };
}

function normalizeActor(input) {
  const actor = input.actor;
  if (isPlainRecord(actor)) return safeRef(actor.actorId ?? actor.id, "actor.actorId");
  return safeRef(input.actorId ?? actor, "actor");
}

function normalizeAdapter(input) {
  const adapter = input.runtimeAdapter;
  if (isPlainRecord(adapter)) {
    return safeRef(adapter.adapterId ?? adapter.id, "runtimeAdapter.adapterId");
  }
  return safeRef(input.runtimeAdapterId ?? adapter, "runtimeAdapter");
}

function normalizeInput(input, { allowMissingDigest = true, nowMs = Date.now() } = {}) {
  assertPlainRecord(input, "command");
  for (const key of Object.keys(input)) {
    if (!INPUT_FIELDS.has(key)) fail(`unsupported command field ${key}`);
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== LIVE_CONTINUATION_COMMAND_SCHEMA_VERSION) {
    fail("schemaVersion is unsupported");
  }
  if (input.kind !== undefined && input.kind !== LIVE_CONTINUATION_COMMAND_KIND) fail("kind is unsupported");
  const action = input.action;
  if (!LIVE_CONTINUATION_ACTIONS.includes(action)) fail("action is unsupported", "LIVE_CONTINUATION_ACTION_UNSUPPORTED");
  const runId = safeRef(input.runId, "runId");
  const nodeId = safeRef(input.nodeId, "nodeId");
  const expectedRevision = safeInteger(input.expectedRevision, "expectedRevision");
  // A freshly claimed durable run may legitimately have no checkpoint yet;
  // explicit null still binds that fact. Omitting the field remains invalid.
  if (!Object.hasOwn(input, "checkpointId")) fail("checkpointId binding is required");
  const checkpointId = safeRef(input.checkpointId, "checkpointId", { nullable: true });
  const effectState = input.effectState;
  if (!LIVE_CONTINUATION_EFFECT_STATES.includes(effectState)) {
    fail("effectState must be reconciled or none", "LIVE_CONTINUATION_EFFECT_UNRECONCILED");
  }
  const claim = normalizeClaim(input);
  const actor = normalizeActor(input);
  const runtimeAdapter = normalizeAdapter(input);
  const runtime = safeRuntime(
    input.runtime ?? (isPlainRecord(input.runtimeAdapter) ? input.runtimeAdapter.runtime : undefined),
    "runtime",
  );
  const nonce = safeRef(input.nonce, "nonce");
  const issuedAtMs = timestampMs(input.issuedAtMs ?? input.issuedAt, "issuedAtMs", { defaultValue: nowMs });
  const expiresAtMs = timestampMs(input.expiresAtMs ?? input.expiresAt, "expiresAtMs");
  const payload = cloneSafe(input.payload ?? {}, "payload");
  const commandId = input.commandId === undefined
    ? `continuation-${canonicalDigest({ runId, nodeId, action, nonce }).slice(7, 39)}`
    : safeRef(input.commandId, "commandId");
  const normalized = {
    schemaVersion: LIVE_CONTINUATION_COMMAND_SCHEMA_VERSION,
    kind: LIVE_CONTINUATION_COMMAND_KIND,
    commandId,
    action,
    runId,
    nodeId,
    expectedRevision,
    checkpointId,
    effectState,
    claim,
    actor,
    runtimeAdapter,
    runtime,
    nonce,
    issuedAtMs,
    expiresAtMs,
    payload,
  };
  const commandDigest = canonicalDigest(normalized);
  if (!allowMissingDigest && input.commandDigest === undefined) fail("commandDigest is required");
  if (input.commandDigest !== undefined) {
    if (typeof input.commandDigest !== "string" || input.commandDigest !== commandDigest) {
      fail("commandDigest does not bind the command", "LIVE_CONTINUATION_DIGEST_MISMATCH");
    }
  }
  return { ...normalized, commandDigest };
}

/** Create and freeze an immutable command. Expiry is checked by the planner. */
export function createLiveContinuationCommand(input = {}, options = {}) {
  return freeze(normalizeInput(input, { ...options, allowMissingDigest: true }));
}

/** Validate a command received from a caller or command log. */
export function validateLiveContinuationCommand(input, options = {}) {
  return freeze(normalizeInput(input, { ...options, allowMissingDigest: false }));
}

export const assertValidLiveContinuationCommand = validateLiveContinuationCommand;
export const assertLiveContinuationCommand = validateLiveContinuationCommand;
export const parseLiveContinuationCommand = validateLiveContinuationCommand;
export const buildLiveContinuationCommand = createLiveContinuationCommand;

export function isLiveContinuationCommand(value) {
  try {
    validateLiveContinuationCommand(value);
    return true;
  } catch {
    return false;
  }
}

export function digestLiveContinuationCommand(command) {
  const normalized = validateLiveContinuationCommand(command);
  return normalized.commandDigest;
}

export function commandCoreForDigest(command) {
  const normalized = validateLiveContinuationCommand(command);
  const { commandDigest: ignored, ...core } = normalized;
  void ignored;
  return canonicalize(core);
}
