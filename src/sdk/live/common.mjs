/**
 * Shared, dependency-free primitives for the Meta_Kim Live ecosystem SDKs.
 *
 * This module is intentionally not part of the public contributor surface.
 * Third-party code should import from ./index.mjs only so the projection
 * contract can remain versioned independently from implementation details.
 */

export const LIVE_SDK_VERSION = "1.0.0";

export const SDK_AUTHORITY = Object.freeze({
  projectionOnly: true,
  authoritative: false,
  executionAllowed: false,
  mutationAllowed: false,
  liveCertified: false,
});

export const SDK_CAPABILITIES = Object.freeze(["normalize", "project"]);
export const ADAPTER_CAPABILITIES = Object.freeze(["normalize", "project"]);
export const EVIDENCE_CAPABILITIES = Object.freeze(["project"]);
export const THEME_CAPABILITIES = Object.freeze(["render"]);

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const SECRET_KEY = /(?:secret|password|passwd|credential|token|api[_-]?key|private[_-]?key|bearer|raw[_-]?(?:prompt|output|model)|stdout|stderr|authorization)/iu;
const URL_OR_PATH = /(?:[A-Za-z]:[\\/]|^~[\\/]|^(?:\\\\|\/)|(?:^|[\s])(?:\.\.?[\\/])+|(?:https?|ftp|file):\/\/|www\.)/iu;
const HIGH_ENTROPY = /^[A-Za-z0-9_+./=-]{24,}$/u;
const IDENTIFIER = /^[a-z][a-z0-9._:@+~-]{0,127}$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@+~#\[\]()/ -]{0,255}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

/**
 * Error base for failures crossing the public SDK boundary.
 */
export class LiveSdkError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code = "LIVE_SDK_ERROR") {
    super(message);
    this.name = "LiveSdkError";
    this.code = code;
  }
}

/** @param {string} message */
export class LiveSdkTimeoutError extends LiveSdkError {
  constructor(message = "Live SDK operation timed out") {
    super(message, "LIVE_SDK_TIMEOUT");
    this.name = "LiveSdkTimeoutError";
  }
}

/** @param {string} message */
export class LiveSdkAbortError extends LiveSdkError {
  constructor(message = "Live SDK operation was cancelled") {
    super(message, "LIVE_SDK_ABORTED");
    this.name = "LiveSdkAbortError";
  }
}

/** @param {string} message */
export function fail(message) {
  throw new TypeError(`Meta_Kim Live SDK: ${message}`);
}

/**
 * Return true only for ordinary data records. Proxies, class instances and
 * host objects are rejected because reading them can execute user code.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

/**
 * Read enumerable own data properties once. Accessors and symbol keys are
 * deliberately outside the SDK data contract.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {Array<[string, unknown]>}
 */
export function ownDataEntries(value, label) {
  if (!isPlainRecord(value)) fail(`${label} must be a plain record`);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(`${label} must be inspectable`);
  }
  return keys.map((key) => {
    if (typeof key !== "string") fail(`${label} cannot contain symbol keys`);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(`${label}.${key} must be inspectable`);
    }
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      fail(`${label}.${key} must be an enumerable data property`);
    }
    return [key, descriptor.value];
  });
}

/**
 * Validate a record with required and optional fields. Unknown fields are
 * rejected, which prevents contributors from smuggling authority claims into
 * a projection envelope.
 */
export function record(value, requiredFields, label, optionalFields = []) {
  const entries = ownDataEntries(value, label);
  const allowed = new Set([...requiredFields, ...optionalFields]);
  for (const [key] of entries) {
    if (!allowed.has(key)) fail(`${label}.${key} is unsupported`);
  }
  const map = new Map(entries);
  for (const field of requiredFields) {
    if (!map.has(field)) fail(`${label}.${field} is required`);
  }
  return Object.fromEntries([...requiredFields, ...optionalFields].filter((field) => map.has(field)).map((field) => [field, map.get(field)]));
}

/** @param {unknown} value @param {string} label @param {number} [max] */
export function boundedText(value, label, max = 512, { allowEmpty = false } = {}) {
  if (typeof value !== "string") fail(`${label} must be text`);
  const normalized = value.normalize("NFKC").trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > max || CONTROL_CHARACTER.test(normalized)) {
    fail(`${label} must be bounded text`);
  }
  if (SECRET_KEY.test(label) || looksSensitive(normalized)) fail(`${label} contains sensitive or local-only material`);
  return normalized;
}

/** @param {unknown} value @param {string} label */
export function safeIdentifier(value, label) {
  const normalized = boundedText(value, label, 128);
  if (!IDENTIFIER.test(normalized) || looksSensitive(normalized)) fail(`${label} must be a safe identifier`);
  return normalized;
}

/** @param {unknown} value @param {string} label */
export function safeReference(value, label) {
  const normalized = boundedText(value, label, 256);
  if (!REFERENCE.test(normalized) || URL_OR_PATH.test(normalized) || looksSensitive(normalized)) {
    fail(`${label} must be a safe reference`);
  }
  return normalized;
}

/** @param {unknown} value @param {string} label */
export function semver(value, label) {
  const normalized = boundedText(value, label, 64);
  if (!VERSION.test(normalized)) fail(`${label} must be a semantic version`);
  return normalized;
}

/** @param {unknown} value @param {string} label @param {{ nullable?: boolean }} [options] */
export function timestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) fail(`${label} must be an ISO timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail(`${label} must be an ISO timestamp`);
  return date.toISOString();
}

/** @param {unknown} value @param {string} label @param {number} [max] */
export function safeArray(value, label, max = 128) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be an array`);
  if (value.length > max) fail(`${label} is too large`);
  const keys = Reflect.ownKeys(value);
  const result = new Array(value.length);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) fail(`${label} must be dense`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) fail(`${label} must contain data values`);
    result[Number(key)] = descriptor.value;
  }
  if (result.some((_, index) => !Object.hasOwn(value, String(index)))) fail(`${label} must be dense`);
  return result;
}

/**
 * Clone bounded JSON-like input and freeze the clone. This is the only value
 * passed to third-party contribution callbacks.
 */
export function snapshotData(value, label = "input", depth = 0) {
  if (depth > 8) fail(`${label} is nested too deeply`);
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) fail(`${label} must contain finite numbers`);
    return value;
  }
  if (typeof value === "string") return boundedText(value, label, 4096, { allowEmpty: true });
  if (Array.isArray(value)) return Object.freeze(safeArray(value, label, 256).map((child, index) => snapshotData(child, `${label}[${index}]`, depth + 1)));
  const entries = ownDataEntries(value, label);
  if (entries.length > 128) fail(`${label} has too many fields`);
  const output = {};
  for (const [key, child] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,95}$/u.test(key) || SECRET_KEY.test(key)) fail(`${label}.${key} is not public data`);
    output[key] = snapshotData(child, `${label}.${key}`, depth + 1);
  }
  return Object.freeze(output);
}

/** @param {unknown} value @returns {boolean} */
export function looksSensitive(value) {
  if (typeof value !== "string") return false;
  const normalized = value.normalize("NFKC");
  if (URL_OR_PATH.test(normalized)) return true;
  if (/(?:secret|password|passwd|credential|private[_-]?key|api[_-]?key|access[_-]?token|bearer|raw[_-]?(?:prompt|output))/iu.test(normalized)) return true;
  if (/^(?:sk|rk|pk|ak|gh[pousr]|github_pat|xox[baprs]|npm)[_-][A-Za-z0-9_-]{8,}$/iu.test(normalized)) return true;
  return HIGH_ENTROPY.test(normalized) && /[A-Z]/u.test(normalized) && /[a-z]/u.test(normalized) && /[0-9]/u.test(normalized);
}

/** @param {unknown} value @param {string} label */
export function booleanValue(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
  return value;
}

/** @param {unknown} value @param {string[]} values @param {string} label */
export function enumValue(value, values, label) {
  if (typeof value !== "string" || !values.includes(value)) fail(`${label} is unsupported`);
  return value;
}

/** @param {unknown} value @param {string} label @param {string[]} allowed */
export function capabilityList(value, label, allowed) {
  const entries = safeArray(value, label, allowed.length);
  if (entries.length < 1) fail(`${label} must declare at least one capability`);
  const normalized = entries.map((item, index) => enumValue(item, allowed, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail(`${label} must not contain duplicates`);
  return Object.freeze([...normalized].sort((left, right) => left.localeCompare(right)));
}

/** @param {unknown} value */
export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/**
 * Execute one contribution callback with a bounded timeout and cancellation.
 * The callback may continue internally after timeout, but its result can
 * never cross the SDK boundary.
 */
export async function runWithBoundary(operation, options = {}) {
  if (typeof operation !== "function") fail("operation must be a function");
  if (!isPlainRecord(options)) fail("options must be a plain record");
  for (const [key] of ownDataEntries(options, "options")) {
    if (key !== "timeoutMs" && key !== "signal") fail(`options.${key} is unsupported`);
  }
  const { timeoutMs = 5000, signal } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) fail("timeoutMs must be between 1 and 120000");
  if (signal !== undefined && (signal === null || typeof signal !== "object" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
    fail("signal must be an AbortSignal-like object");
  }
  if (signal?.aborted) throw new LiveSdkAbortError();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => settle(reject, new LiveSdkAbortError());
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => settle(reject, new LiveSdkTimeoutError()), timeoutMs);
    Promise.resolve()
      .then(() => operation())
      .then((value) => settle(resolve, value), (error) => settle(reject, error));
  });
}

/** @param {unknown} value @param {string} label */
export function assertAuthority(value, label = "authority") {
  const normalized = record(value, Object.keys(SDK_AUTHORITY), label);
  for (const [key, expected] of Object.entries(SDK_AUTHORITY)) {
    if (normalized[key] !== expected) fail(`${label}.${key} must be ${String(expected)}`);
  }
  return normalized;
}

/** @param {string[]} values @returns {readonly string[]} */
export function sortedUnique(values) {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

export { IDENTIFIER, REFERENCE, SHA256 };
