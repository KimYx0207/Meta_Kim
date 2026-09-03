import {
  readFile,
  mkdir,
  readdir,
  unlink,
  lstat,
  realpath,
} from "node:fs/promises";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { atomicWriteJson, withFileLock } from "./spine-state-utils.mjs";
import {
  CONVERSATION_BINDING_MATCH_BASIS,
  CONVERSATION_BINDING_REFUSAL_REASONS,
} from "./conversation-binding.mjs";
import {
  CHOICE_SURFACE_STATES,
  checkCapabilityNodeBindings,
  checkChoiceSurfaceGate,
  checkPreExecutionReadiness,
  checkStageRequirements,
  evaluateFanoutGate,
  extractMetaAgentName,
  getGovernanceFlow,
  isExecutionTool,
  isMetaAgentName,
  isReadOnlyTool,
  normalizeStage,
  STAGE_META_AGENT_MAP,
  STAGE_ORDER,
  STAGE_PUBLIC_LABELS,
  validateDegradedDeclaration,
} from "./spine-state-gates.mjs";

export {
  CHOICE_SURFACE_STATES,
  checkCapabilityNodeBindings,
  checkChoiceSurfaceGate,
  checkPreExecutionReadiness,
  checkStageRequirements,
  evaluateFanoutGate,
  extractMetaAgentName,
  getGovernanceFlow,
  isExecutionTool,
  isReadOnlyTool,
  STAGE_META_AGENT_MAP,
  STAGE_ORDER,
  STAGE_PUBLIC_LABELS,
  validateDegradedDeclaration,
};

const META_KIM_STATE_ROOT = ".meta-kim/state";
const DEFAULT_SPINE_STATE_DIR = ".meta-kim/state/default/spine";
const SPINE_STATE_FILE = "spine-state.json";
const ACTIVE_RUN_STATUS_FILE = "active-run.json";
const RUN_STATUS_FILE = "status.json";
const RUN_STATUS_LIFECYCLE_MIGRATION = "run-status-lifecycle-v1";
const RUN_STATUS_LIFECYCLE_COMPLETION_SIDECAR =
  `${RUN_STATUS_LIFECYCLE_MIGRATION}.managed-completion.json`;
const RUN_STATUS_SCHEMA_VERSION = 2;
const MIGRATION_MARKER_SCHEMA = "run-status-lifecycle-marker-v1";
const HISTORICAL_RUN_ID_RE = /^meta-[A-Za-z0-9](?:[A-Za-z0-9._-]{0,115})$/u;
const CANONICAL_RUN_ID_RE = /^meta-[a-z0-9](?:[a-z0-9._-]{0,115})$/u;
const DIRECT_PROFILE_RE = /^[a-z0-9._-]+$/u;
const DERIVED_PROFILE_PREFIX = "derived-";
const TASK_FINGERPRINT_RE = /^hmac-sha256:[a-f0-9]{64}$/u;
const TASK_IDENTITY_KEY_SCHEMA = "task-identity-key-v1";
const HISTORICAL_MIGRATION_ENVELOPE = Symbol("historical-migration-envelope");
const taskIdentityKeyInflight = new Map();
const SOURCE_RUNTIMES = new Set(["claude", "codex", "cursor", "openclaw"]);
// How a run learned its conversation. Whitelisted so a caller cannot write free
// text into a field that later reads as evidence of verification: the consumer in
// `scripts/governed-execution/host-runtime-provenance.mjs` refuses a run whose
// basis is absent, so membership here is an admission decision and not a label.
//
// Derived from the verifier's own constant rather than restated, because a member
// with no producer is pre-opened permission — nothing can earn it, and the one
// consumer that reads this field would still accept it from any caller that wrote
// it by hand. `host_reported_binding` sat here exactly that way: zero producers,
// zero consumers, and eight filesystem checks standing behind the only value next
// to it. Deriving also makes the opposite drift unrepresentable — a verifier
// cannot earn a basis this gate then silently strips at the normalizer below,
// which would read downstream as a run that failed to verify.
export const SOURCE_CONVERSATION_MATCH_BASIS = Object.freeze([CONVERSATION_BINDING_MATCH_BASIS]);

const ADMISSIBLE_MATCH_BASIS = new Set(SOURCE_CONVERSATION_MATCH_BASIS);
const WORKER_LIFECYCLE_STATUSES = new Set(["queued", "active", "completed", "failed", "cancelled"]);

export const RUN_LIFECYCLE_STATUSES = [
  "active",
  "inactive",
  "session_stopped",
  "evolution_completed",
  "superseded",
  "archived_legacy",
];

export const TASK_IDENTITY_SOURCES = [
  "project_profile_hmac_sha256",
  "not_available",
  "unrecoverable_legacy",
];

export const RUN_SUBSTANCE_CLASSES = ["activation_only", "substantive"];

export const RUN_DIRECTORY_MINTING_MODES = ["substantive", "always"];

/**
 * Substance is an axis orthogonal to lifecycleStatus. lifecycleStatus answers
 * "is this run still running", substanceClass answers "did this run ever do
 * anything". A measured scan of one long-lived project found 994 of 1004
 * persisted run directories sitting at Critical with zero completed stages,
 * zero worker records and zero replay events: activation receipts, not runs.
 * Collapsing both questions into lifecycleStatus would force a reader to guess,
 * so the two stay separate and the reader is told which one it is looking at.
 *
 * Evidence-bearing signals only. Absence of a signal is never upgraded into a
 * positive claim, and a value that cannot be read is treated as absent.
 */
export function classifyRunSubstance(record) {
  const completedStages = Array.isArray(record?.completed) ? record.completed.length : 0;
  const workerRecords = Array.isArray(record?.workerLifecycle)
    ? record.workerLifecycle.length
    : 0;
  const declaredWorkerPackets = Array.isArray(record?.workerTaskPackets)
    ? record.workerTaskPackets.length
    : 0;
  const stageIndex = Number.isInteger(record?.stageIndex)
    ? record.stageIndex
    : STAGE_ORDER.indexOf(normalizeStage(record?.currentStageKey || record?.currentStage)) + 1;
  const advancedBeyondEntryStage = stageIndex > 1;
  const recordedBlocker = typeof record?.blockedOn === "string" && record.blockedOn.trim() !== "";
  const substantive =
    completedStages > 0 ||
    workerRecords > 0 ||
    declaredWorkerPackets > 0 ||
    advancedBeyondEntryStage ||
    recordedBlocker;
  return {
    substanceClass: substantive ? "substantive" : "activation_only",
    substanceSignals: {
      completedStages,
      workerRecords,
      declaredWorkerPackets,
      stageIndex: stageIndex > 0 ? stageIndex : null,
      advancedBeyondEntryStage,
      recordedBlocker,
    },
  };
}

/**
 * `substantive` (default) keeps bare activations out of the run directory so the
 * directory stays a list of runs that did something. `always` restores the older
 * write-every-activation behavior for debugging a specific machine.
 */
export function runDirectoryMintingMode(env = process.env) {
  const raw = typeof env?.META_KIM_RUN_DIRECTORY_MINTING === "string"
    ? env.META_KIM_RUN_DIRECTORY_MINTING.trim().toLowerCase()
    : "";
  return RUN_DIRECTORY_MINTING_MODES.includes(raw) ? raw : "substantive";
}

const STAGE_PROGRESS_PERCENT = {
  critical: 12,
  fetch: 25,
  thinking: 38,
  execution: 50,
  review: 63,
  "meta-review": 75,
  verification: 88,
  evolution: 100,
};

function createRunId(timestamp = new Date().toISOString()) {
  return `meta-${timestamp.replace(/[:.]/g, "-").toLowerCase()}-${randomBytes(8).toString("hex")}`;
}

function isWithin(parent, target) {
  const rel = relative(parent, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function sanitizeStateProfile(input) {
  if (typeof input !== "string" || !input.trim()) return "default";
  const raw = input.trim();
  if (
    raw !== "." &&
    raw !== ".." &&
    raw.length <= 80 &&
    DIRECT_PROFILE_RE.test(raw) &&
    !raw.startsWith(DERIVED_PROFILE_PREFIX)
  ) {
    return raw;
  }

  const normalized = raw
    .toLowerCase()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  const suffix = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
  const maxBaseLength = 80 - DERIVED_PROFILE_PREFIX.length - suffix.length - 1;
  const readableBase = (normalized || "profile")
    .slice(0, maxBaseLength)
    .replace(/[._-]+$/gu, "") || "profile";
  return `${DERIVED_PROFILE_PREFIX}${readableBase}-${suffix}`;
}

function isCanonicalStateProfile(value) {
  if (typeof value !== "string" || value.length > 80) return false;
  if (
    DIRECT_PROFILE_RE.test(value) &&
    !value.startsWith(DERIVED_PROFILE_PREFIX)
  ) {
    return value !== "." && value !== "..";
  }
  return /^derived-[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?-[a-f0-9]{12}$/u.test(value);
}

export function validateCanonicalStateProfile(value) {
  if (!isCanonicalStateProfile(value)) {
    throw new TypeError("Invalid canonical Meta_Kim state profile.");
  }
  return value;
}

function resolveCanonicalProfileStateDir(cwd, canonicalProfile, ...segments) {
  validateCanonicalStateProfile(canonicalProfile);
  const stateRoot = resolveMetaKimStateRoot(cwd);
  const candidate = resolve(stateRoot, canonicalProfile, ...segments);
  if (!isWithin(stateRoot, candidate)) {
    return resolve(stateRoot, "default", ...segments);
  }
  return candidate;
}

export function resolveMetaKimStateRoot(cwd) {
  return resolve(cwd || process.cwd(), META_KIM_STATE_ROOT);
}

export function resolveRepoLocalStateDir(cwd, requestedPath, fallbackPath) {
  const repoRoot = resolve(cwd || process.cwd());
  const stateRoot = resolveMetaKimStateRoot(repoRoot);
  const fallback = resolve(repoRoot, fallbackPath || DEFAULT_SPINE_STATE_DIR);
  const raw =
    typeof requestedPath === "string" && requestedPath.trim()
      ? requestedPath.trim()
      : "";

  const candidate = raw
    ? resolve(isAbsolute(raw) ? raw : join(repoRoot, raw))
    : fallback;

  if (isWithin(stateRoot, candidate)) return candidate;
  return fallback;
}

export function resolveProfileStateDir(cwd, profile, ...segments) {
  const safeProfile = sanitizeStateProfile(profile);
  return resolveCanonicalProfileStateDir(cwd, safeProfile, ...segments);
}

function ownEnumerableDataField(value, key) {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw jsonBoundaryTypeError(`routing field ${key} must be an own enumerable data property`);
  }
  return descriptor.value;
}

function resolveSpineStateRoute(cwd, state = null) {
  const stateProfile =
    ownEnumerableDataField(state, "profile") ||
    ownEnumerableDataField(state, "stateProfile");
  const fallbackProfile = sanitizeStateProfile(
    process.env.META_KIM_PROFILE ||
      process.env.META_KIM_STATE_PROFILE ||
      stateProfile,
  );
  const requestedStateDir = process.env.META_KIM_SPINE_STATE_DIR;
  let stateDir = resolveRepoLocalStateDir(
    cwd,
    requestedStateDir,
    join(".meta-kim", "state", fallbackProfile, "spine"),
  );
  if (typeof requestedStateDir !== "string" || !requestedStateDir.trim()) {
    return { filePath: join(stateDir, SPINE_STATE_FILE), profile: fallbackProfile };
  }
  const stateRoot = resolveMetaKimStateRoot(cwd);
  const routeSegments = relative(stateRoot, stateDir).split(/[\\/]+/u).filter(Boolean);
  const firstSegment = routeSegments[0];
  const profile = firstSegment
    ? sanitizeStateProfile(firstSegment)
    : fallbackProfile;
  if (firstSegment && profile !== firstSegment) {
    stateDir = resolve(stateRoot, profile, ...routeSegments.slice(1));
  }
  return { filePath: join(stateDir, SPINE_STATE_FILE), profile };
}

function spineStatePath(cwd) {
  return resolveSpineStateRoute(cwd).filePath;
}

function ensureDir(filePath) {
  return mkdir(dirname(filePath), { recursive: true });
}

function profileFromState(state) {
  return (
    ownEnumerableDataField(state, "profile") ||
      ownEnumerableDataField(state, "stateProfile") ||
      process.env.META_KIM_PROFILE ||
      process.env.META_KIM_STATE_PROFILE ||
      "default"
  );
}

function cleanLanguageTag(input) {
  return typeof input === "string" && input.trim() ? input.trim() : null;
}

function resolveOutputLanguage(state, options = {}) {
  const candidates = [
    ["tool_selected", options.toolSelectedLanguage || state?.toolSelectedLanguage],
    ["explicit_output_choice", options.outputLanguage || state?.outputLanguage],
    ["intent_gate", state?.intentGatePacket?.userLanguage],
    ["card_decision", state?.cardDecision?.userLanguage],
    ["delivery_shell", state?.deliveryShell?.userLanguage],
    ["latest_user_input", state?.latestUserInputLanguage],
    ["environment", process.env.META_KIM_OUTPUT_LANGUAGE || process.env.LANG],
  ];

  for (const [source, value] of candidates) {
    const language = cleanLanguageTag(value);
    if (language) return { language, source };
  }

  return { language: "undetermined", source: "not_resolved" };
}

export function validateRunId(runId) {
  if (typeof runId !== "string" || !CANONICAL_RUN_ID_RE.test(runId)) {
    throw new TypeError(
      "Invalid Meta_Kim runId: new writes require lowercase meta- plus 1-116 safe ASCII characters (maximum 120 total).",
    );
  }
  return runId;
}

function validateHistoricalRunId(runId) {
  if (typeof runId !== "string" || !HISTORICAL_RUN_ID_RE.test(runId)) {
    throw new TypeError("Invalid historical Meta_Kim runId.");
  }
  return runId;
}

function normalizeTaskFingerprint(value) {
  return typeof value === "string" && TASK_FINGERPRINT_RE.test(value)
    ? value
    : null;
}

function runStatusPaths(cwd, profile, runId) {
  const safeRunId = validateRunId(runId);
  const profileDir = resolveCanonicalProfileStateDir(cwd, profile);
  return {
    activeRun: join(profileDir, ACTIVE_RUN_STATUS_FILE),
    runStatus: join(profileDir, "runs", safeRunId, RUN_STATUS_FILE),
  };
}

const FORBIDDEN_RAW_PROMPT_FIELD_NAMES = new Set([
  "task",
  "tasktext",
  "rawprompttext",
  "rawprompt",
  "userprompt",
  "prompttext",
  "taskidentitystatus",
  "tasktruncation",
]);
const FORBIDDEN_STRUCTURAL_FIELD_NAMES = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function normalizedBoundaryFieldName(key) {
  return String(key).toLowerCase().replace(/[_-]/gu, "");
}

function jsonBoundaryTypeError(reason) {
  return new TypeError(`Unsafe Meta_Kim JSON boundary value: ${reason}.`);
}

function sanitizeJsonBoundary(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw jsonBoundaryTypeError("non-finite number");
    return value;
  }
  if (["undefined", "function", "symbol", "bigint"].includes(typeof value)) {
    throw jsonBoundaryTypeError(typeof value);
  }
  if (ancestors.has(value)) {
    throw new TypeError("Cyclic Meta_Kim state is not serializable at the JSON boundary.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0) {
        throw jsonBoundaryTypeError("invalid array length");
      }
      const sanitizedArray = new Array(length);
      for (let index = 0; index < length; index += 1) {
        if (!Object.hasOwn(descriptors, String(index))) {
          throw jsonBoundaryTypeError(`sparse array index ${index}`);
        }
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === "symbol") throw jsonBoundaryTypeError("symbol array key");
        if (key === "length") continue;
        if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
          throw jsonBoundaryTypeError(`non-index array property ${key}`);
        }
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, "value")) {
          throw jsonBoundaryTypeError(`array accessor ${key}`);
        }
        if (!descriptor.enumerable) {
          throw jsonBoundaryTypeError(`non-enumerable array index ${key}`);
        }
        sanitizedArray[Number(key)] = sanitizeJsonBoundary(descriptor.value, ancestors);
      }
      return sanitizedArray;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw jsonBoundaryTypeError("custom object prototype");
    }
    const sanitized = Object.create(null);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === "symbol") throw jsonBoundaryTypeError("symbol object key");
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, "value")) {
        throw jsonBoundaryTypeError(`accessor property ${key}`);
      }
      if (!descriptor.enumerable) {
        throw jsonBoundaryTypeError(`non-enumerable property ${key}`);
      }
      if (FORBIDDEN_STRUCTURAL_FIELD_NAMES.has(key)) {
        throw jsonBoundaryTypeError(`reserved structural property ${key}`);
      }
      if (FORBIDDEN_RAW_PROMPT_FIELD_NAMES.has(normalizedBoundaryFieldName(key))) {
        continue;
      }
      const sanitizedValue = sanitizeJsonBoundary(descriptor.value, ancestors);
      Object.defineProperty(sanitized, key, {
        value: sanitizedValue,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return sanitized;
  } finally {
    ancestors.delete(value);
  }
}

function stripRawPromptFields(value) {
  const sanitized = sanitizeJsonBoundary(value);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return sanitized;
  }
  if (
    sanitized.stageRuntimeControl &&
    typeof sanitized.stageRuntimeControl === "object" &&
    !Array.isArray(sanitized.stageRuntimeControl)
  ) {
    sanitized.stageRuntimeControl.promptFingerprint = normalizeTaskFingerprint(
      sanitized.stageRuntimeControl.promptFingerprint,
    );
  }
  sanitized.taskFingerprint = normalizeTaskFingerprint(sanitized.taskFingerprint);
  sanitized.taskIdentitySource = TASK_IDENTITY_SOURCES.includes(
    sanitized.taskIdentitySource,
  )
    ? sanitized.taskIdentitySource
    : sanitized.taskFingerprint
      ? "project_profile_hmac_sha256"
      : "not_available";
  return sanitized;
}

async function assertSafeStatePath(cwd, targetPath, options = {}) {
  const repoRoot = resolve(cwd || process.cwd());
  const stateRoot = resolveMetaKimStateRoot(repoRoot);
  const resolvedTarget = resolve(targetPath);
  if (!isWithin(stateRoot, resolvedTarget)) {
    throw new Error("Refusing Meta_Kim state path outside the repository state root.");
  }

  const repoReal = await realpath(repoRoot);
  const parentPath = options.targetIsDirectory
    ? resolvedTarget
    : dirname(resolvedTarget);
  const segments = relative(repoRoot, parentPath).split(/[\\/]+/u).filter(Boolean);
  let current = repoRoot;
  for (const segment of segments) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT" || options.createParents !== true) throw error;
      await mkdir(current).catch((mkdirError) => {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      });
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Unsafe Meta_Kim state path component: ${segment}`);
    }
    const currentReal = await realpath(current);
    if (!isWithin(repoReal, currentReal)) {
      throw new Error("Refusing Meta_Kim state path through a reparse escape.");
    }
  }

  // Lock files are created with exclusive `wx` semantics after this check.
  // Their names can legitimately appear and disappear between concurrent
  // processes, so inspecting that volatile leaf would turn normal lock churn
  // into a false reparse escape. The fully resolved parent chain above remains
  // mandatory; `withFileLock` refuses to follow an existing leaf.
  if (options.exclusiveCreateLeaf === true) return resolvedTarget;

  try {
    const targetInfo = await lstat(resolvedTarget);
    if (targetInfo.isSymbolicLink()) {
      throw new Error("Refusing symlinked Meta_Kim state target.");
    }
    const targetReal = await realpath(resolvedTarget);
    if (!isWithin(repoReal, targetReal)) {
      throw new Error("Refusing Meta_Kim state target outside the repository.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return resolvedTarget;
}

async function safeAtomicWriteJson(cwd, targetPath, payload, options = {}) {
  await assertSafeStatePath(cwd, targetPath, { createParents: true });
  await atomicWriteJson(targetPath, payload, options);
}

async function readJsonObject(cwd, filePath) {
  try {
    await assertSafeStatePath(cwd, filePath);
    const raw = await readFile(filePath, "utf8");
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? { status: "valid", value }
      : { status: "unknown", value };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "missing", value: null };
    if (/Unsafe|Refusing|reparse|symlink/iu.test(error?.message || "")) {
      return { status: "unsafe", value: null };
    }
    return { status: "malformed", value: null };
  }
}

function decodeTaskIdentityKey(record) {
  if (
    record?.schemaVersion !== 1 ||
    record?.keySchema !== TASK_IDENTITY_KEY_SCHEMA ||
    typeof record?.key !== "string"
  ) {
    return null;
  }
  try {
    const key = Buffer.from(record.key, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

async function readTaskIdentityKey(cwd, keyPath) {
  const record = await readJsonObject(cwd, keyPath);
  if (record.status === "missing") return null;
  const decoded = record.status === "valid"
    ? decodeTaskIdentityKey(record.value)
    : null;
  if (decoded) return decoded;
  const error = new Error(
    "Invalid protected Meta_Kim task identity key; refusing replacement.",
  );
  error.code = "META_KIM_TASK_IDENTITY_KEY_INVALID";
  throw error;
}

async function initializeTaskIdentityKey(cwd, keyPath, lockPath) {
  try {
    return await withFileLock(lockPath, async () => {
      const existing = await readTaskIdentityKey(cwd, keyPath);
      if (existing) return existing;
      const generated = randomBytes(32);
      await safeAtomicWriteJson(
        cwd,
        keyPath,
        {
          schemaVersion: 1,
          keySchema: TASK_IDENTITY_KEY_SCHEMA,
          key: generated.toString("base64"),
          createdAt: new Date().toISOString(),
        },
        { mode: 0o600 },
      );
      return generated;
    });
  } catch (error) {
    if (error?.code !== "META_KIM_LOCK_TIMEOUT") throw error;
    // A cross-process creator may have completed immediately before our retry
    // budget expired. Reuse only a fully valid key; a missing or invalid key
    // preserves the lock failure instead of manufacturing unlocked state.
    const completed = await readTaskIdentityKey(cwd, keyPath);
    if (completed) return completed;
    throw error;
  }
}

export async function createProjectTaskIdentity(cwd, promptText, options = {}) {
  if (typeof promptText !== "string" || !promptText) {
    return {
      ready: false,
      status: "not_available",
      taskFingerprint: null,
      taskIdentitySource: "not_available",
    };
  }
  const requestedProfile = ownEnumerableDataField(options, "profile");
  const profile = requestedProfile
    ? sanitizeStateProfile(requestedProfile)
    : resolveSpineStateRoute(cwd).profile;
  const keyPath = join(
    resolveCanonicalProfileStateDir(cwd, profile),
    "private",
    "task-identity-key.json",
  );
  const lockPath = `${keyPath}.lock`;
  let key;
  try {
    key = await readTaskIdentityKey(cwd, keyPath);
  } catch (error) {
    if (
      options.requireExisting === true &&
      error?.code === "META_KIM_TASK_IDENTITY_KEY_INVALID"
    ) {
      return {
        ready: false,
        status: "existing_key_invalid",
        taskFingerprint: null,
        taskIdentitySource: "project_profile_hmac_sha256",
      };
    }
    throw error;
  }
  if (!key && options.requireExisting === true) {
    return {
      ready: false,
      status: "existing_key_missing",
      taskFingerprint: null,
      taskIdentitySource: "project_profile_hmac_sha256",
    };
  }
  if (!key) {
    await assertSafeStatePath(cwd, lockPath, {
      createParents: true,
      exclusiveCreateLeaf: true,
    });
    let pending = taskIdentityKeyInflight.get(keyPath);
    if (!pending) {
      pending = initializeTaskIdentityKey(cwd, keyPath, lockPath);
      taskIdentityKeyInflight.set(keyPath, pending);
    }
    try {
      key = await pending;
    } finally {
      if (taskIdentityKeyInflight.get(keyPath) === pending) {
        taskIdentityKeyInflight.delete(keyPath);
      }
    }
  }
  return {
    ready: true,
    status: "ready",
    taskFingerprint: `hmac-sha256:${createHmac("sha256", key).update(promptText, "utf8").digest("hex")}`,
    taskIdentitySource: "project_profile_hmac_sha256",
  };
}

function recordHasHmacTaskIdentity(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (
        value.taskIdentitySource === "project_profile_hmac_sha256" ||
        normalizeTaskFingerprint(value.taskFingerprint) != null
      ),
  );
}

export async function readExistingTaskIdentityBinding(cwd) {
  const { profile } = resolveSpineStateRoute(cwd);
  const profileDir = resolveCanonicalProfileStateDir(cwd, profile);
  const [spineRecord, statusRecord] = await Promise.all([
    readJsonObject(cwd, join(profileDir, "spine", SPINE_STATE_FILE)),
    readJsonObject(cwd, join(profileDir, ACTIVE_RUN_STATUS_FILE)),
  ]);
  if (spineRecord.status === "valid" && recordHasHmacTaskIdentity(spineRecord.value)) {
    return { hmacBound: true, profile, source: "spine" };
  }
  if (statusRecord.status === "valid" && recordHasHmacTaskIdentity(statusRecord.value)) {
    return { hmacBound: true, profile, source: "active_run_status" };
  }
  return { hmacBound: false, profile, source: null };
}

function lifecycleStatusForReason(active, reason) {
  if (active) return "active";
  if (reason === "session_stop") return "session_stopped";
  if (reason === "evolution_completed") return "evolution_completed";
  if (reason === "superseded_by_new_prompt") return "superseded";
  if (reason === "legacy_reconciled") return "archived_legacy";
  return "inactive";
}

// Which event retired the run, kept separate from why. "session_stop" is written
// by the Stop hook, and Stop fires at every turn boundary rather than when the
// conversation ends, so the reason alone cannot answer "is that chat still open".
// There is deliberately no real-session-end value here: no writer can produce one
// yet, and a declared-but-unreachable value invites readers to trust a branch that
// never runs. Absent means unknown, never assumed.
const DEACTIVATION_TRIGGERS = Object.freeze([
  "stop_hook_turn_boundary",
  "prompt_supersede",
  "state_migration",
]);

function normalizeDeactivationTrigger(value) {
  return DEACTIVATION_TRIGGERS.includes(value) ? value : null;
}

function terminalState(state, reason, trigger, details = {}) {
  return stripRawPromptFields({
    ...state,
    active: false,
    lifecycleStatus: lifecycleStatusForReason(false, reason),
    deactivatedAt: new Date().toISOString(),
    deactivationReason: reason,
    deactivationTrigger: normalizeDeactivationTrigger(trigger),
    ...details,
  });
}

const VALID_STAGE_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "skipped",
  "blocked",
  "failed",
]);

function isValidTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasCompleteStageMap(stages) {
  return Boolean(
    stages &&
      typeof stages === "object" &&
      !Array.isArray(stages) &&
      STAGE_ORDER.every(
        (stage) =>
          Object.hasOwn(stages, stage) &&
          stages[stage] &&
          typeof stages[stage] === "object" &&
          VALID_STAGE_STATUSES.has(stages[stage].status),
      ),
  );
}

function isValidLifecycleCombination(
  value,
  { allowLegacyMissing = false, allowHistoricalRunIds = false } = {},
) {
  const runIdValidator = allowHistoricalRunIds
    ? validateHistoricalRunId
    : validateRunId;
  if (allowLegacyMissing && value?.lifecycleStatus == null) {
    const reason = value?.deactivationReason ?? null;
    const deactivatedAt = value?.deactivatedAt ?? null;
    if (value?.active === true) {
      return reason === null && deactivatedAt === null;
    }
    if (value?.active !== false) return false;
    if (reason === null) {
      return deactivatedAt === null || isValidTimestamp(deactivatedAt);
    }
    if (!isValidTimestamp(deactivatedAt)) return false;
    if (["session_stop", "evolution_completed"].includes(reason)) return true;
    if (reason === "superseded_by_new_prompt") {
      try {
        return runIdValidator(value.supersededByRunId) !== value.runId;
      } catch {
        return false;
      }
    }
    return reason === "legacy_reconciled" && isValidTimestamp(value.archivedAt);
  }
  if (!RUN_LIFECYCLE_STATUSES.includes(value?.lifecycleStatus)) return false;
  const reason = value?.deactivationReason ?? null;
  if (value.active === true) {
    return value.lifecycleStatus === "active" && reason === null;
  }
  if (value.active !== false) return false;
  if (value.lifecycleStatus === "inactive") return reason === null;
  if (value.lifecycleStatus === "session_stopped") return reason === "session_stop";
  if (value.lifecycleStatus === "evolution_completed") {
    return reason === "evolution_completed";
  }
  if (value.lifecycleStatus === "superseded") {
    try {
      return (
        reason === "superseded_by_new_prompt" &&
        runIdValidator(value.supersededByRunId) !== value.runId
      );
    } catch {
      return false;
    }
  }
  return (
    value.lifecycleStatus === "archived_legacy" &&
    reason === "legacy_reconciled" &&
    isValidTimestamp(value.archivedAt)
  );
}

function isValidSpineState(value) {
  try {
    validateRunId(value?.runId);
  } catch {
    return false;
  }
  return Boolean(
    value &&
      typeof value === "object" &&
      value.version === 2 &&
      typeof value.active === "boolean" &&
      STAGE_ORDER.includes(value.currentStage) &&
      hasCompleteStageMap(value.stages) &&
      isValidLifecycleCombination(value),
  );
}

function isSupportedStatusEnvelope(value) {
  const schemaVersion = value?.schemaVersion;
  if (![1, RUN_STATUS_SCHEMA_VERSION].includes(schemaVersion)) return false;
  const historicalRunId = (() => {
    try {
      validateHistoricalRunId(value?.runId);
      return !CANONICAL_RUN_ID_RE.test(value.runId);
    } catch {
      return null;
    }
  })();
  if (historicalRunId === null) return false;
  if (
    typeof value.active !== "boolean" ||
    !STAGE_ORDER.includes(value.currentStageKey) ||
    typeof value.currentStage !== "string" ||
    value.currentStage.length === 0 ||
    value.stageIndex !== STAGE_ORDER.indexOf(value.currentStageKey) + 1 ||
    value.stageTotal !== STAGE_ORDER.length ||
    !Number.isFinite(value.percent) ||
    !Array.isArray(value.completed) ||
    !Object.hasOwn(value, "next") ||
    !Object.hasOwn(value, "blockedOn") ||
    typeof value.triggeredBy !== "string" ||
    value.triggeredBy.length === 0 ||
    !isValidTimestamp(value.startedAt) ||
    !isValidTimestamp(value.updatedAt) ||
    value.surfaceMode !== "public" ||
    !value.publicSurface ||
    typeof value.publicSurface !== "object" ||
    !value.languageResolution ||
    typeof value.languageResolution !== "object" ||
    value.stagePurposeKey !== value.currentStageKey
  ) {
    return false;
  }
  if (
    value.authorityMode != null &&
    !["managed_runtime_spine", "hook_observed_advisory"].includes(value.authorityMode)
  ) {
    return false;
  }
  if (schemaVersion === RUN_STATUS_SCHEMA_VERSION) {
    const historicalArchivedEnvelope = historicalRunId === true &&
      value.active === false &&
      value.lifecycleStatus === "archived_legacy" &&
      value.deactivationReason === "legacy_reconciled" &&
      value.archiveReason === "non_authoritative_historical_active_status";
    if (historicalRunId === true && !historicalArchivedEnvelope) return false;
    return (
      value.authorityMode != null &&
      value.publicReadyAuthority === false &&
      isValidLifecycleCombination(value, {
        allowHistoricalRunIds: historicalArchivedEnvelope,
      }) &&
      TASK_IDENTITY_SOURCES.includes(value.taskIdentitySource) &&
      (value.taskFingerprint == null || normalizeTaskFingerprint(value.taskFingerprint) != null)
    );
  }
  return (
    [undefined, false].includes(value.publicReadyAuthority) &&
    isValidLifecycleCombination(value, {
      allowLegacyMissing: true,
      allowHistoricalRunIds: true,
    })
  );
}

/**
 * A run directory entry is a durable, user-visible claim that a run exists.
 * Bare activations do not earn one, but promotion is monotone: once a run has
 * proven substance and been materialized, every later write keeps updating it,
 * including the terminal write. Otherwise a run that finished its work would
 * lose its own closing record and the directory would show stale progress.
 */
async function shouldMaterializeRunDirectory(runStatusPath, envelope) {
  if (runDirectoryMintingMode() === "always") return true;
  if (envelope.substanceClass === "substantive") return true;
  try {
    await lstat(runStatusPath);
    return true;
  } catch {
    return false;
  }
}

async function writeMetaRunStatusUnlocked(cwd, state, profile, options = {}) {
  const envelope = createMetaRunStatusEnvelope(state, options);
  const paths = runStatusPaths(cwd, profile, envelope.runId);
  if (await shouldMaterializeRunDirectory(paths.runStatus, envelope)) {
    await safeAtomicWriteJson(cwd, paths.runStatus, envelope);
  }
  if (options.skipActivePointer !== true) {
    await safeAtomicWriteJson(cwd, paths.activeRun, envelope);
  }
  return envelope;
}

async function readProfileAuthority(cwd, profile) {
  const profileDir = resolveCanonicalProfileStateDir(cwd, profile);
  const spinePath = join(profileDir, "spine", SPINE_STATE_FILE);
  const activePath = join(profileDir, ACTIVE_RUN_STATUS_FILE);
  const [spineRecord, activeRecord] = await Promise.all([
    readJsonObject(cwd, spinePath),
    readJsonObject(cwd, activePath),
  ]);
  const spine = spineRecord.status === "valid" ? spineRecord.value : null;
  const active = activeRecord.status === "valid" ? activeRecord.value : null;
  if (
    !isValidSpineState(spine) ||
    spine.active !== true ||
    !isSupportedStatusEnvelope(active) ||
    active.active !== true ||
    active.runId !== spine.runId
  ) {
    return { proven: false, spineRecord, activeRecord };
  }
  return { proven: true, runId: spine.runId, spine, active };
}

function archivedLegacyEnvelope(value, archivedAt) {
  const currentStage = normalizeStage(value.currentStageKey || value.currentStage);
  const state = {
    active: false,
    lifecycleStatus: "archived_legacy",
    runId: validateHistoricalRunId(value.runId),
    taskFingerprint: normalizeTaskFingerprint(value.taskFingerprint),
    taskIdentitySource: normalizeTaskFingerprint(value.taskFingerprint)
      ? "project_profile_hmac_sha256"
      : "unrecoverable_legacy",
    taskClassification:
      typeof value.taskClassification === "string"
        ? value.taskClassification
        : "unrecoverable_legacy",
    triggerReason: value.triggeredBy || "legacy_reconciliation",
    currentStage,
    stages: Object.fromEntries(
      STAGE_ORDER.map((stage) => [
        stage,
        {
          status:
            stage === currentStage
              ? "in_progress"
              : "pending",
          completedAt: null,
        },
      ]),
    ),
    triggeredAt: value.startedAt || archivedAt,
    deactivatedAt: archivedAt,
    deactivationReason: "legacy_reconciled",
    deactivationTrigger: "state_migration",
    archivedAt,
    archiveReason: "non_authoritative_historical_active_status",
  };
  return createMetaRunStatusEnvelope(state, {
    historicalMigrationToken: HISTORICAL_MIGRATION_ENVELOPE,
  });
}

const MIGRATION_REPORT_COUNT_FIELDS = [
  "scannedRecords",
  "authoritativeActivePreserved",
  "terminalPreserved",
  "archived",
  "malformedPreserved",
  "unknownPreserved",
  "unsafePreserved",
];

function isValidMigrationMarker(marker, profile) {
  try {
    validateRunId(marker?.authoritativeRunId);
  } catch {
    return false;
  }
  return Boolean(
    marker?.schemaVersion === 1 &&
      marker?.markerSchema === MIGRATION_MARKER_SCHEMA &&
      marker?.migrationId === RUN_STATUS_LIFECYCLE_MIGRATION &&
      marker?.profile === profile &&
      marker?.recordSchemaVersion === RUN_STATUS_SCHEMA_VERSION &&
      marker?.completed === true &&
      isValidTimestamp(marker?.completedAt) &&
      MIGRATION_REPORT_COUNT_FIELDS.every(
        (field) => Number.isInteger(marker?.[field]) && marker[field] >= 0,
      ),
  );
}

async function reconcileLegacyRunStatusesUnlocked(cwd, { profile } = {}) {
  if (!isCanonicalStateProfile(profile)) {
    throw new TypeError("Legacy reconciliation requires a canonical state profile.");
  }
  const safeProfile = profile;
  const authority = await readProfileAuthority(cwd, safeProfile);
  if (!authority.proven) {
    return { completed: false, status: "authority_not_proven", profile: safeProfile };
  }

  const profileDir = resolveCanonicalProfileStateDir(cwd, safeProfile);
  const migrationPath = join(
    profileDir,
    "migrations",
    `${RUN_STATUS_LIFECYCLE_MIGRATION}.json`,
  );
  const completionSidecarPath = join(
    profileDir,
    "migrations",
    RUN_STATUS_LIFECYCLE_COMPLETION_SIDECAR,
  );
  const existingMarker = await readJsonObject(cwd, migrationPath);
  if (
    existingMarker.status === "valid" &&
    isValidMigrationMarker(existingMarker.value, safeProfile)
  ) {
    return { ...existingMarker.value, alreadyCompleted: true };
  }
  const existingCompletionSidecar = await readJsonObject(cwd, completionSidecarPath);
  if (
    existingCompletionSidecar.status === "valid" &&
    isValidMigrationMarker(existingCompletionSidecar.value, safeProfile)
  ) {
    return {
      ...existingCompletionSidecar.value,
      alreadyCompleted: true,
      completionSource: "managed_sidecar",
    };
  }
  if (existingCompletionSidecar.status !== "missing") {
    return {
      completed: false,
      status: "invalid_completion_sidecar",
      profile: safeProfile,
      invalidCompletionSidecarPreserved: true,
    };
  }
  const invalidMarkerPreserved = existingMarker.status !== "missing";

  const report = {
    schemaVersion: 1,
    markerSchema: MIGRATION_MARKER_SCHEMA,
    recordSchemaVersion: RUN_STATUS_SCHEMA_VERSION,
    migrationId: RUN_STATUS_LIFECYCLE_MIGRATION,
    profile: safeProfile,
    completed: true,
    completedAt: new Date().toISOString(),
    authoritativeRunId: authority.runId,
    scannedRecords: 0,
    authoritativeActivePreserved: 0,
    terminalPreserved: 0,
    archived: 0,
    malformedPreserved: 0,
    unknownPreserved: 0,
    unsafePreserved: 0,
    invalidMarkerPreserved,
  };
  const runsDir = join(profileDir, "runs");
  let entries = [];
  try {
    await assertSafeStatePath(cwd, runsDir, { targetIsDirectory: true });
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      report.unsafePreserved += 1;
    }
  }

  const caseFoldCounts = new Map();
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    try {
      const historicalRunId = validateHistoricalRunId(entry.name);
      const folded = historicalRunId.toLowerCase();
      caseFoldCounts.set(folded, (caseFoldCounts.get(folded) || 0) + 1);
    } catch {
      // Count only strongly shaped historical run directory names.
    }
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      report.unsafePreserved += 1;
      continue;
    }
    let runId;
    try {
      runId = validateHistoricalRunId(entry.name);
    } catch {
      report.unknownPreserved += 1;
      continue;
    }
    if (
      caseFoldCounts.get(runId.toLowerCase()) !== 1 ||
      (runId !== authority.runId && runId.toLowerCase() === authority.runId.toLowerCase())
    ) {
      report.unsafePreserved += 1;
      continue;
    }
    const statusPath = join(runsDir, runId, RUN_STATUS_FILE);
    const record = await readJsonObject(cwd, statusPath);
    if (record.status === "missing") continue;
    report.scannedRecords += 1;
    if (record.status === "unsafe") {
      report.unsafePreserved += 1;
      continue;
    }
    if (record.status === "malformed") {
      report.malformedPreserved += 1;
      continue;
    }
    const value = record.value;
    if (
      record.status !== "valid" ||
      value?.runId !== runId ||
      !isSupportedStatusEnvelope(value)
    ) {
      report.unknownPreserved += 1;
      continue;
    }
    if (value.active === false) {
      report.terminalPreserved += 1;
      continue;
    }
    if (runId === authority.runId) {
      report.authoritativeActivePreserved += 1;
      continue;
    }

    const archivedAt = new Date().toISOString();
    await safeAtomicWriteJson(
      cwd,
      statusPath,
      archivedLegacyEnvelope(value, archivedAt),
    );
    report.archived += 1;
  }

  const completionPath = invalidMarkerPreserved
    ? completionSidecarPath
    : migrationPath;
  await safeAtomicWriteJson(cwd, completionPath, report);
  return invalidMarkerPreserved
    ? { ...report, completionSource: "managed_sidecar" }
    : report;
}

export async function readSpineState(cwd) {
  const filePath = spineStatePath(cwd);
  const record = await readJsonObject(cwd, filePath);
  const state = record.status === "valid" ? stripRawPromptFields(record.value) : null;
  return isValidSpineState(state) && state.active !== false ? state : null;
}

export async function readSpineStateIncludingInactive(cwd) {
  const filePath = spineStatePath(cwd);
  const record = await readJsonObject(cwd, filePath);
  const state = record.status === "valid" ? stripRawPromptFields(record.value) : null;
  return isValidSpineState(state) ? state : null;
}

export async function writeSpineState(cwd, state, options = {}) {
  const safeState = stripRawPromptFields(state);
  safeState.workerLifecycle = lifecycleRecords(safeState);
  // Resolve the file and profile together. A legacy custom spine directory is
  // still honored, but its first state-root segment becomes the status profile
  // so spine/status readers cannot be routed to different tenants.
  // Route only from the already validated null-prototype boundary copy. Reading
  // routing fields from the caller object first would execute accessors or
  // inherit Object.prototype pollution before the JSON boundary can reject it.
  const { filePath, profile } = resolveSpineStateRoute(cwd, safeState);
  validateRunId(safeState?.runId);
  if (!isValidSpineState(safeState)) {
    throw new TypeError("Invalid Meta_Kim spine state schema or stage map.");
  }
  await assertSafeStatePath(cwd, filePath, { createParents: true });
  const lockPath = `${filePath}.lock`;
  await assertSafeStatePath(cwd, lockPath, { createParents: true });
  return withFileLock(lockPath, async () => {
    const currentRecord = await readJsonObject(cwd, filePath);
    const current = currentRecord.status === "valid" && isValidSpineState(currentRecord.value)
      ? currentRecord.value
      : null;
    const expectedRunId = options.expectedRunId || safeState.runId;
    validateRunId(expectedRunId);
    if (current && current.runId !== expectedRunId) {
      return { written: false, reason: "expected_run_changed", runId: current.runId };
    }
    await safeAtomicWriteJson(cwd, filePath, safeState);
    if (options.interruptAfter === "spine") {
      throw new Error("Injected interruption after authoritative spine write.");
    }
    await writeMetaRunStatusUnlocked(cwd, safeState, profile);
    return { written: true, runId: safeState.runId };
  });
}

/**
 * Reconcile legacy per-run status records once within one sanitized profile.
 * Unknown or malformed records are reported but never rewritten.
 */
async function reconcileLegacyRunStatusesUnderSpineLock(cwd, profile) {
  const migrationPath = join(
    resolveCanonicalProfileStateDir(cwd, profile),
    "migrations",
    `${RUN_STATUS_LIFECYCLE_MIGRATION}.json`,
  );
  await assertSafeStatePath(cwd, `${migrationPath}.lock`, { createParents: true });
  return withFileLock(`${migrationPath}.lock`, () =>
    reconcileLegacyRunStatusesUnlocked(cwd, { profile }),
  );
}

export async function reconcileLegacyRunStatuses(cwd, options = {}) {
  const profile = sanitizeStateProfile(
    ownEnumerableDataField(options, "profile") ||
      process.env.META_KIM_PROFILE ||
      process.env.META_KIM_STATE_PROFILE,
  );
  const spinePath = join(
    resolveCanonicalProfileStateDir(cwd, profile),
    "spine",
    SPINE_STATE_FILE,
  );
  await assertSafeStatePath(cwd, `${spinePath}.lock`, { createParents: true });
  return withFileLock(`${spinePath}.lock`, () =>
    reconcileLegacyRunStatusesUnderSpineLock(cwd, profile),
  );
}

/**
 * Publish a new authoritative spine state, terminalizing an eligible prior run first.
 */
export async function activateSpineState(cwd, state, options = {}) {
  const safeState = stripRawPromptFields(state);
  safeState.workerLifecycle = lifecycleRecords(safeState);
  const { filePath, profile } = resolveSpineStateRoute(cwd, safeState);
  validateRunId(safeState?.runId);
  if (!isValidSpineState(safeState)) {
    throw new TypeError("Invalid Meta_Kim spine state schema or stage map.");
  }
  await assertSafeStatePath(cwd, filePath, { createParents: true });
  await assertSafeStatePath(cwd, `${filePath}.lock`, { createParents: true });
  return withFileLock(`${filePath}.lock`, async () => {
    const currentRecord = await readJsonObject(cwd, filePath);
    const current = currentRecord.status === "valid" && isValidSpineState(currentRecord.value)
      ? stripRawPromptFields(currentRecord.value)
      : null;
    const expectedRunId = options.expectedRunId || null;
    if (expectedRunId !== null) validateRunId(expectedRunId);
    if (options.refreshExisting === true) {
      if (current?.active === true && current.runId === expectedRunId) {
        await writeMetaRunStatusUnlocked(cwd, current, profile);
        const migration = await reconcileLegacyRunStatusesUnderSpineLock(cwd, profile);
        return {
          activated: false,
          reason: "same_run_refreshed",
          runId: current.runId,
          migration,
        };
      }
      return {
        activated: false,
        reason: !current
          ? "refresh_authority_missing"
          : current.runId !== expectedRunId
            ? "refresh_authority_changed"
            : "refresh_authority_inactive",
        runId: current?.runId || null,
      };
    }
    if (
      current?.active === true &&
      (!options.replaceActive || current.runId !== expectedRunId)
    ) {
      return {
        activated: false,
        reason: current.runId === expectedRunId
          ? "active_replacement_not_authorized"
          : "authoritative_state_changed",
        runId: current.runId || null,
      };
    }

    let supersededRunId = null;
    if (current?.active === true) {
      const superseded = terminalState(current, "superseded_by_new_prompt", "prompt_supersede", {
        supersededByRunId: safeState.runId,
      });
      await safeAtomicWriteJson(cwd, filePath, superseded);
      await writeMetaRunStatusUnlocked(cwd, superseded, profile);
      supersededRunId = current.runId || null;
    } else if (current?.active === false) {
      // Repair the prior terminal projection before publishing a new spine so
      // migration can never mistake interrupted terminal history for legacy active state.
      await writeMetaRunStatusUnlocked(cwd, current, profile);
    }

    const nextState = {
      ...safeState,
      profile,
      lifecycleStatus: "active",
    };
    await safeAtomicWriteJson(cwd, filePath, nextState);
    if (options.interruptAfter === "spine") {
      throw new Error("Injected interruption after authoritative activation write.");
    }
    await writeMetaRunStatusUnlocked(cwd, nextState, profile);
    const migration = await reconcileLegacyRunStatusesUnderSpineLock(cwd, profile);
    return {
      activated: true,
      runId: nextState.runId,
      supersededRunId,
      migration,
    };
  });
}

/**
 * Persist terminal state/status before optionally removing the live spine file.
 */
export async function terminalizeSpineState(cwd, options = {}) {
  const { filePath, profile } = resolveSpineStateRoute(cwd);
  const expectedRunId = options.expectedRunId || null;
  if (!expectedRunId) {
    return { terminalized: false, reason: "expected_run_required" };
  }
  validateRunId(expectedRunId);
  await assertSafeStatePath(cwd, filePath, { createParents: true });
  await assertSafeStatePath(cwd, `${filePath}.lock`, { createParents: true });
  return withFileLock(`${filePath}.lock`, async () => {
    const currentRecord = await readJsonObject(cwd, filePath);
    const current = currentRecord.status === "valid" && isValidSpineState(currentRecord.value)
      ? stripRawPromptFields(currentRecord.value)
      : null;
    if (!current) return { terminalized: false, reason: "no_authoritative_state" };
    if (current.runId !== expectedRunId) {
      return {
        terminalized: false,
        reason: "expected_run_changed",
        runId: current.runId,
      };
    }

    if (current.active === false) {
      await writeMetaRunStatusUnlocked(cwd, current, profile);
      const shouldCompleteEvolutionDeletion =
        options.removeStateFile === true &&
        current.deactivationReason === "evolution_completed";
      if (shouldCompleteEvolutionDeletion) {
        await unlink(filePath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
      return {
        terminalized: true,
        repaired: true,
        removed: shouldCompleteEvolutionDeletion,
        runId: current.runId,
        reason: current.deactivationReason,
      };
    }

    const reason = options.reason === "evolution_completed"
      ? "evolution_completed"
      : "session_stop";
    const terminal = terminalState(current, reason, "stop_hook_turn_boundary");
    await safeAtomicWriteJson(cwd, filePath, terminal);
    if (options.interruptAfter === "spine") {
      throw new Error("Injected interruption after authoritative terminal write.");
    }
    await writeMetaRunStatusUnlocked(cwd, terminal, profile);
    if (options.removeStateFile === true) {
      await unlink(filePath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    return {
      terminalized: true,
      removed: options.removeStateFile === true,
      runId: terminal.runId || null,
      reason,
    };
  });
}

export function createInitialState({
  taskClassification,
  triggerReason,
  activationMode = "managed_stage_runtime",
  driverMode = "managed",
  hookGateMode = "block",
  promptFingerprint = null,
  latestUserInputLanguage = null,
  factGatePolicy = null,
  executionLeasePolicy = null,
  taskFingerprint = null,
  taskIdentitySource = null,
  sourceConversation = null,
  sourceRuntime = null,
  conversationLinkRefusal = null,
} = {}) {
  const triggeredAt = new Date().toISOString();
  const runId = createRunId(triggeredAt);
  const stageRuntimeControl = {
    activationMode,
    driverMode,
    hookGateMode,
    promptFingerprint,
    userLanguage: latestUserInputLanguage,
    factGatePolicy:
      factGatePolicy ||
      (hookGateMode === "advisory"
        ? "managed_gate_required_for_public_ready"
        : "required_before_mutation"),
    executionLeasePolicy:
      executionLeasePolicy ||
      (hookGateMode === "advisory"
        ? "advisory_until_managed_stage_driver"
        : "required_for_business_mutation"),
    createdAt: triggeredAt,
  };
  const normalizedTaskFingerprint = normalizeTaskFingerprint(taskFingerprint);
  const normalizedSourceConversation = normalizeSourceConversation(sourceConversation, runId);
  const normalizedSourceRuntime = normalizeSourceRuntime(
    normalizedSourceConversation?.runtime || sourceRuntime,
  );
  return {
    active: true,
    version: 2,
    runId,
    triggeredAt,
    stageRuntimeControl,
    lifecycleStatus: "active",
    taskFingerprint: normalizedTaskFingerprint,
    taskIdentitySource: TASK_IDENTITY_SOURCES.includes(taskIdentitySource)
      ? taskIdentitySource
      : normalizedTaskFingerprint
        ? "project_profile_hmac_sha256"
        : "not_available",
    currentStage: "critical",
    stages: {
      critical: { status: "in_progress", completedAt: null },
      fetch: { status: "pending", completedAt: null },
      thinking: { status: "pending", completedAt: null },
      execution: { status: "pending", completedAt: null },
      review: { status: "pending", completedAt: null },
      "meta-review": { status: "pending", completedAt: null },
      verification: { status: "pending", completedAt: null },
      evolution: { status: "pending", completedAt: null },
    },
    taskClassification: taskClassification || null,
    triggerReason: triggerReason || "user_invocation",
    dispatchedAgents: [],
    dispatchChain: {},
    controlState: "normal",
    gateState: "pending",
    surfaceState: "silent",
    choiceSurfaceState: "not_allowed",
    queryBypass: false,
    latestUserInputLanguage,
    executionStarted: false,
    criticalFetchLoopCount: 0,
    criticalFetchLoopMax: 3,
    intentCard: null,
    intentConfirmationState: null,
    intentConfirmationTimestamp: null,
    intentCorrectionPayload: null,
    // Audit trail for skipped hooks
    skippedHooks: [],
    sourceRuntime: normalizedSourceRuntime || "unavailable",
    conversationLinkState: normalizedSourceConversation ? "verified" : "unlinked",
    ...(normalizedSourceConversation ? { sourceConversation: normalizedSourceConversation } : {}),
    ...(!normalizedSourceConversation && normalizeConversationLinkRefusal(conversationLinkRefusal)
      ? { conversationLinkRefusal: normalizeConversationLinkRefusal(conversationLinkRefusal) }
      : {}),
  };
}

function normalizeSourceRuntime(value) {
  const runtime = String(value || "").trim().toLowerCase();
  return SOURCE_RUNTIMES.has(runtime) ? runtime : null;
}

function normalizeConversationLinkRefusal(value) {
  return CONVERSATION_BINDING_REFUSAL_REASONS.includes(value) ? value : null;
}

function normalizeSourceConversation(value, expectedRunId = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const runtime = normalizeSourceRuntime(value.runtime);
  if (!runtime) return null;
  const conversationId = String(value.conversationId || value.threadId || value.sessionId || value.composerId || value.sessionKey || "").trim();
  if (!/^[a-z0-9][a-z0-9:._-]{3,159}$/iu.test(conversationId)) return null;
  const explicitRunId = typeof value.runId === "string" ? value.runId : null;
  if (explicitRunId && expectedRunId && explicitRunId !== expectedRunId) return null;
  const rawTitle = typeof value.title === "string" ? value.title.trim() : "";
  const title = rawTitle && rawTitle.length <= 120 && !/[\u0000-\u001f\u007f]/u.test(rawTitle)
    ? rawTitle
    : null;
  return {
    runtime,
    conversationId,
    ...(expectedRunId ? { runId: expectedRunId } : explicitRunId ? { runId: explicitRunId } : {}),
    ...(title ? { title } : {}),
    ...(ADMISSIBLE_MATCH_BASIS.has(value.matchBasis) ? { matchBasis: value.matchBasis } : {}),
  };
}

export function bindSourceConversation(state, sourceConversation, { sourceRuntime = null, refusalReason = null } = {}) {
  if (!state || typeof state !== "object") return state;
  const runtime = normalizeSourceRuntime(sourceConversation?.runtime || sourceRuntime);
  const normalized = normalizeSourceConversation(sourceConversation, state.runId);
  if (!normalized) {
    if (state.sourceConversation) return state;
    const refusal = normalizeConversationLinkRefusal(refusalReason);
    return {
      ...state,
      sourceRuntime: runtime || state.sourceRuntime || "unavailable",
      conversationLinkState: "unlinked",
      ...(refusal ? { conversationLinkRefusal: refusal } : {}),
    };
  }
  const { conversationLinkRefusal: _resolved, ...linked } = state;
  return {
    ...linked,
    sourceRuntime: normalized.runtime,
    conversationLinkState: "verified",
    sourceConversation: normalized,
  };
}

function safeWorkerTaskId(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9][a-z0-9:._-]{2,239}$/iu.test(candidate) ? candidate : null;
}

function safeHostEventId(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9][a-z0-9:._-]{2,159}$/iu.test(candidate) ? candidate : null;
}

function safeHostInvocationIds(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => safeHostEventId(value))
    .filter(Boolean))].slice(-8);
}

function lifecycleRecords(state) {
  const existing = Array.isArray(state?.workerLifecycle) ? state.workerLifecycle : [];
  const byTask = new Map(existing.flatMap((record) => {
    const taskPacketId = safeWorkerTaskId(record?.taskPacketId);
    if (!taskPacketId || record?.runId !== state?.runId || !WORKER_LIFECYCLE_STATUSES.has(record?.status)) return [];
    return [[taskPacketId, record]];
  }));
  for (const packet of Array.isArray(state?.workerTaskPackets) ? state.workerTaskPackets : []) {
    const taskPacketId = safeWorkerTaskId(packet?.taskPacketId);
    if (!taskPacketId || byTask.has(taskPacketId)) continue;
    byTask.set(taskPacketId, {
      runId: state.runId,
      taskPacketId,
      status: "queued",
      updatedAt: state.triggeredAt || new Date().toISOString(),
      terminalEvidence: [],
      ...(typeof packet.roleDisplayName === "string" ? { roleDisplayName: packet.roleDisplayName.slice(0, 80) } : {}),
      ...(typeof packet.roleInstanceId === "string" ? { roleInstanceId: packet.roleInstanceId.slice(0, 120) } : {}),
    });
  }
  return [...byTask.values()];
}

export function projectWorkerLifecycle(state) {
  return lifecycleRecords(state).map((record) => ({ ...record }));
}

export function recordWorkerLifecycleEvent(state, event = {}, options = {}) {
  if (!state || typeof state !== "object" || state.active !== true) return state;
  if (options.trustedHostEvent !== true) return state;
  const runId = typeof event.runId === "string" ? event.runId : state.runId;
  if (runId !== state.runId) return state;
  const taskPacketId = safeWorkerTaskId(event.taskPacketId);
  const packet = (Array.isArray(state.workerTaskPackets) ? state.workerTaskPackets : [])
    .find((candidate) => candidate?.taskPacketId === taskPacketId);
  if (!taskPacketId || !packet) return state;
  const status = String(event.status || "").trim().toLowerCase();
  if (!WORKER_LIFECYCLE_STATUSES.has(status) || status === "queued") return state;
  const runtime = normalizeSourceRuntime(event.runtime);
  if (!runtime) return state;
  const records = lifecycleRecords(state);
  const index = records.findIndex((record) => record.taskPacketId === taskPacketId);
  const current = records[index];
  if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return state;
  const now = isValidTimestamp(event.occurredAt) ? new Date(event.occurredAt).toISOString() : new Date().toISOString();
  const terminal = ["completed", "failed", "cancelled"].includes(status);
  const eventId = safeHostEventId(event.eventId);
  const invocationIds = safeHostInvocationIds([
    ...(Array.isArray(current.invocationIds) ? current.invocationIds : []),
    event.invocationId,
    ...(Array.isArray(event.invocationIds) ? event.invocationIds : []),
  ]);
  const next = {
    ...current,
    runId: state.runId,
    taskPacketId,
    status,
    runtime,
    updatedAt: now,
    ...(current.startedAt ? {} : { startedAt: now }),
    ...(terminal ? { completedAt: now } : {}),
    ...(invocationIds.length > 0 ? { invocationIds } : {}),
    terminalEvidence: terminal
      ? [...(Array.isArray(current.terminalEvidence) ? current.terminalEvidence : []), {
          runId: state.runId,
          taskPacketId,
          status,
          resultStatus: status,
          runtime,
          occurredAt: now,
          proofValid: true,
          synthetic: false,
          evidenceKind: "host_worker_lifecycle",
          ...(eventId ? { eventId } : {}),
        }].slice(-8)
      : Array.isArray(current.terminalEvidence) ? current.terminalEvidence : [],
  };
  records[index] = next;
  return { ...state, workerLifecycle: records };
}

export function isHookObservedState(state) {
  const control = state?.stageRuntimeControl || {};
  return (
    control.activationMode === "hook_observed" ||
    control.driverMode === "hook_observed" ||
    control.hookGateMode === "advisory" ||
    state?.activationMode === "hook_observed" ||
    state?.driverMode === "hook_observed" ||
    state?.hookGateMode === "advisory"
  );
}

export function createMetaRunStatusEnvelope(state, options = {}) {
  const safeState = stripRawPromptFields(state);
  const currentStage = normalizeStage(
    options.currentStage || safeState?.currentStage || "critical",
  );
  const stageIndex = STAGE_ORDER.indexOf(currentStage) + 1;
  const stageTotal = STAGE_ORDER.length;
  const stages = safeState?.stages || {};
  const completed = STAGE_ORDER.filter(
    (stage) => stages?.[stage]?.status === "completed",
  ).map((stage) => STAGE_PUBLIC_LABELS[stage]);
  const nextStage =
    stageIndex < stageTotal ? STAGE_ORDER[stageIndex] : null;
  const startedAt =
    safeState?.triggeredAt || safeState?.startedAt || new Date().toISOString();
  const updatedAt = new Date().toISOString();
  const runId = options.historicalMigrationToken === HISTORICAL_MIGRATION_ENVELOPE
    ? validateHistoricalRunId(safeState?.runId)
    : validateRunId(safeState?.runId || createRunId(startedAt));
  const languageResolution = resolveOutputLanguage(safeState, options);
  const stagePurpose =
    safeState?.stagePurpose ||
    safeState?.stagePurposes?.[languageResolution.language] ||
    null;
  const runtimeControl = safeState?.stageRuntimeControl || {};
  const hookObserved = isHookObservedState(safeState);
  const driverMode =
    runtimeControl.driverMode ||
    safeState?.driverMode ||
    (hookObserved ? "hook_observed" : "managed");
  const hookGateMode =
    runtimeControl.hookGateMode ||
    safeState?.hookGateMode ||
    (hookObserved ? "advisory" : "managed");
  const authorityMode = hookObserved
    ? "hook_observed_advisory"
    : "managed_runtime_spine";
  const active = safeState?.active !== false;
  const deactivatedAt = active ? null : safeState?.deactivatedAt || null;
  const deactivationReason = active ? null : safeState?.deactivationReason || null;
  const deactivationTrigger = active
    ? null
    : normalizeDeactivationTrigger(safeState?.deactivationTrigger);
  const lifecycleStatus = lifecycleStatusForReason(active, deactivationReason);
  const taskFingerprint = normalizeTaskFingerprint(safeState?.taskFingerprint);
  const taskIdentitySource = TASK_IDENTITY_SOURCES.includes(
    safeState?.taskIdentitySource,
  )
    ? safeState.taskIdentitySource
    : taskFingerprint
      ? "project_profile_hmac_sha256"
      : "not_available";
  const continuationBoundary =
    safeState?.continuationBoundary ||
    (active
      ? {
          status: "active_run",
          mode: "not_applicable",
          reason: null,
        }
      : {
          status: "inactive_run",
          mode:
            deactivationReason === "session_stop"
              ? "session_stop_requires_new_run_or_offline_audit"
              : "inactive_run_requires_state_reconciliation",
          reason:
            "Inactive run status is history only. A later prompt may start a new run or offline audit, but it must not claim this run is still active.",
        });
  const sourceConversation = normalizeSourceConversation(safeState?.sourceConversation, runId);
  const sourceRuntime = normalizeSourceRuntime(sourceConversation?.runtime || safeState?.sourceRuntime) || "unavailable";
  const conversationLinkState = sourceConversation ? "verified" : "unlinked";
  const conversationLinkRefusal = sourceConversation
    ? null
    : normalizeConversationLinkRefusal(safeState?.conversationLinkRefusal);
  const workerLifecycle = lifecycleRecords({ ...safeState, runId });
  const substance = classifyRunSubstance({
    completed,
    workerLifecycle,
    stageIndex,
    blockedOn: safeState?.blockedOn || null,
  });

  return {
    schemaVersion: RUN_STATUS_SCHEMA_VERSION,
    active,
    lifecycleStatus,
    runId,
    taskFingerprint,
    taskIdentitySource,
    taskClassification: safeState?.taskClassification || null,
    triggeredBy:
      safeState?.triggerReason || safeState?.triggeredBy || "meta-theory",
    currentStage: STAGE_PUBLIC_LABELS[currentStage],
    currentStageKey: currentStage,
    stageIndex,
    stageTotal,
    percent: STAGE_PROGRESS_PERCENT[currentStage],
    completed,
    next: nextStage ? STAGE_PUBLIC_LABELS[nextStage] : null,
    blockedOn: safeState?.blockedOn || null,
    authorityMode,
    driverMode,
    hookGateMode,
    publicReadyAuthority: false,
    publicReadyBoundary: {
      status: "not_public_ready_authority",
      reason:
        "Run status reports current runtime progress only. Public-ready requires summary, verification, real invocation coverage, and Warden gates.",
    },
    deactivatedAt,
    deactivationReason,
    deactivationTrigger,
    supersededByRunId: safeState?.supersededByRunId || null,
    archivedAt: safeState?.archivedAt || null,
    archiveReason: safeState?.archiveReason || null,
    continuationBoundary,
    startedAt,
    updatedAt,
    lastUserVisibleNotice: safeState?.lastUserVisibleNotice || null,
    surfaceMode: "public",
    resolvedOutputLanguage: languageResolution.language,
    languageResolution,
    publicSurface: {
      primaryDisplay: "conversation_notice",
      nativeEnhancementAllowed: true,
      popupRequired: false,
      hiddenInternalFields: [
        "Preflight",
        "nativeChoiceSurface",
        "conversation_fallback",
        "packet_id",
        "protocol_trace",
      ],
    },
    publicLabels: safeState?.publicLabels || null,
    stagePurpose,
    stagePurposeKey: currentStage,
    sourceRuntime,
    conversationLinkState,
    workerLifecycle,
    substanceClass: substance.substanceClass,
    substanceSignals: substance.substanceSignals,
    ...(sourceConversation ? { sourceConversation } : {}),
    ...(conversationLinkRefusal ? { conversationLinkRefusal } : {}),
  };
}

export async function writeMetaRunStatus(cwd, state, options = {}) {
  if (!state || typeof state !== "object") return null;
  const safeState = stripRawPromptFields(state);
  safeState.workerLifecycle = lifecycleRecords(safeState);
  const profile = sanitizeStateProfile(
    ownEnumerableDataField(options, "profile") || profileFromState(safeState),
  );
  return writeMetaRunStatusUnlocked(cwd, safeState, profile, options);
}

export async function readMetaRunStatus(cwd, profile) {
  const safeProfile = sanitizeStateProfile(profile);
  const profileDir = resolveCanonicalProfileStateDir(cwd, safeProfile);
  const spinePath = join(profileDir, "spine", SPINE_STATE_FILE);
  const spineRecord = await readJsonObject(cwd, spinePath);
  if (spineRecord.status === "valid" && isValidSpineState(spineRecord.value)) {
    return createMetaRunStatusEnvelope(stripRawPromptFields(spineRecord.value));
  }

  const activePath = join(profileDir, ACTIVE_RUN_STATUS_FILE);
  const activeRecord = await readJsonObject(cwd, activePath);
  if (
    activeRecord.status === "valid" &&
    isSupportedStatusEnvelope(activeRecord.value) &&
    activeRecord.value.active === false
  ) {
    return stripRawPromptFields(activeRecord.value);
  }
  // An active projection without a valid live spine has no authority.
  return null;
}

export function advanceStage(state, stageName) {
  const stageOrder = STAGE_ORDER;

  const idx = stageOrder.indexOf(stageName);
  if (idx === -1) return state;

  const newState = { ...state };

  for (let i = 0; i < idx; i++) {
    const prev = stageOrder[i];
    if (newState.stages[prev].status !== "completed") {
      newState.stages[prev] = {
        status: "completed",
        completedAt: new Date().toISOString(),
        autoCompleted: true,
        reason: `Advanced past by stage ${stageName}`,
      };
    }
  }

  newState.stages[stageName] = {
    status: "in_progress",
    completedAt: null,
    startedAt: new Date().toISOString(),
  };
  newState.currentStage = stageName;

  if (stageName === "execution") {
    newState.executionStarted = true;
  }

  return newState;
}

export function completeStage(state, stageName) {
  if (!state.stages[stageName]) return state;
  const newState = { ...state };
  newState.stages[stageName] = {
    status: "completed",
    completedAt: new Date().toISOString(),
  };

  const stageOrder = STAGE_ORDER;
  const idx = stageOrder.indexOf(stageName);
  if (idx < stageOrder.length - 1) {
    const nextStage = stageOrder[idx + 1];
    newState.currentStage = nextStage;
    newState.stages[nextStage] = {
      status: "in_progress",
      startedAt: new Date().toISOString(),
    };
  }

  return newState;
}

export function incrementCriticalFetchLoop(state) {
  const count = (state.criticalFetchLoopCount || 0) + 1;
  const max = state.criticalFetchLoopMax || 3;
  return {
    ...state,
    criticalFetchLoopCount: count,
    criticalFetchLoopBudgetExhausted: count >= max,
  };
}

export function recordIntentConfirmation(state, confirmationState, correctionPayload) {
  return {
    ...state,
    intentConfirmationState: confirmationState,
    intentConfirmationTimestamp: new Date().toISOString(),
    intentCorrectionPayload: correctionPayload || null,
  };
}

/**
 * Record a dispatch into spine state.
 *
 * Behavior matrix (HOOK-INFRA-001, v2.3.1):
 *   - When `metaName` is a known meta-agent name → append to
 *     `dispatchChain[currentStage]` (legacy/existing behavior).
 *   - When `metaName` is null but a runtime dispatch identity such as
 *     `toolInput.subagent_type` or Codex `toolInput.task_name` matches a
 *     `workerTaskPackets[]` entry by `taskPacketId` / `roleInstanceId`:
 *       * If the matched packet's `ownerAgent` is a meta-agent → append to
 *         `dispatchChain[currentStage]`.
 *       * Otherwise → append the worker identifier to
 *         `dispatchChain[currentStage]_supplementary`.
 *   - When no match either way → append the raw dispatch identifier into
 *     `dispatchChain[currentStage]_supplementary` so the chain stays
 *     auditable.
 *
 * Field shape: `dispatchChain` retains its existing
 * `{ stage: string[] }` shape; the supplementary entries use a parallel
 * key `${stage}_supplementary` to avoid mixing meta-owners with worker IDs
 * in the same array. Both fields are append-only and dedup-safe.
 *
 * @param {object} state - Current spine state.
 * @param {string} agentName - Human description / agent identifier.
 * @param {string|null} metaName - Resolved meta-agent name, if any.
 * @param {object} [toolInput] - The raw tool input (Agent dispatch payload).
 * @returns {object} New state with dispatch recorded.
 */
export function recordDispatch(state, agentName, metaName, toolInput) {
  const newState = { ...state };
  if (!newState.dispatchedAgents.includes(agentName)) {
    newState.dispatchedAgents = [...newState.dispatchedAgents, agentName];
  }

  const chain = { ...newState.dispatchChain };
  const stage = newState.currentStage;
  const supplementaryKey = `${stage}_supplementary`;

  const appendToChain = (value) => {
    if (!value) return;
    if (!chain[stage]) chain[stage] = [];
    if (!chain[stage].includes(value)) {
      chain[stage] = [...chain[stage], value];
    }
  };

  const appendToSupplementary = (value) => {
    if (!value) return;
    if (!chain[supplementaryKey]) chain[supplementaryKey] = [];
    if (!chain[supplementaryKey].includes(value)) {
      chain[supplementaryKey] = [...chain[supplementaryKey], value];
    }
  };

  if (metaName && isMetaAgentName(metaName)) {
    appendToChain(metaName);
  } else {
    const dispatchIdentity =
      (toolInput &&
        (toolInput.subagent_type ||
          toolInput.agent_type ||
          toolInput.task_name ||
          toolInput.type)) ||
      null;
    const dispatchText = toolInput
      ? [
          toolInput.description,
          toolInput.prompt,
          toolInput.message,
          toolInput.task_name,
          toolInput.agent_type,
          toolInput.subagent_type,
          toolInput.type,
        ]
          .filter(Boolean)
          .join(" ")
      : "";
    const workerPackets = Array.isArray(newState.workerTaskPackets)
      ? newState.workerTaskPackets
      : [];

    const matchedPacket = workerPackets.find((packet) => {
      if (!packet || typeof packet !== "object") return false;
      if (
        dispatchIdentity &&
        (packet.businessRoleId === dispatchIdentity ||
          packet.roleDisplayName === dispatchIdentity ||
          packet.roleInstanceId === dispatchIdentity ||
          packet.taskPacketId === dispatchIdentity)
      ) {
        return true;
      }
      if (
        dispatchText &&
        ((packet.taskPacketId && dispatchText.includes(packet.taskPacketId)) ||
          (packet.roleInstanceId &&
            dispatchText.includes(packet.roleInstanceId)))
      ) {
        return true;
      }
      return false;
    });

    if (matchedPacket) {
      if (
        matchedPacket.ownerAgent &&
        isMetaAgentName(matchedPacket.ownerAgent)
      ) {
        appendToChain(matchedPacket.ownerAgent);
      } else {
        appendToSupplementary(
          matchedPacket.roleInstanceId ||
            matchedPacket.taskPacketId ||
            matchedPacket.businessRoleId ||
            matchedPacket.roleDisplayName ||
            matchedPacket.ownerAgent ||
            agentName,
        );
      }
    } else {
      appendToSupplementary(dispatchIdentity || agentName);
    }
  }

  newState.dispatchChain = chain;
  return newState;
}

export function setQueryBypass(state, bypass) {
  return { ...state, queryBypass: bypass };
}

export function deactivateState(state) {
  return {
    ...state,
    active: false,
    deactivatedAt: new Date().toISOString(),
  };
}

/**
 * Record a skipped hook to the audit trail
 * @param {object} state - Current spine state
 * @param {string} hookName - Name of the hook being skipped
 * @param {string} reason - Why the hook was skipped
 * @returns {object} - Updated state with skip record added
 */
export function recordSkippedHook(state, hookName, reason) {
  const record = {
    hook: hookName,
    reason,
    timestamp: new Date().toISOString(),
  };

  return {
    ...state,
    skippedHooks: [...(state.skippedHooks || []), record],
  };
}
