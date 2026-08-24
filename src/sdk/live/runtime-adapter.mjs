import {
  ADAPTER_CAPABILITIES,
  LIVE_SDK_VERSION,
  SDK_AUTHORITY,
  assertAuthority,
  boundedText,
  capabilityList,
  deepFreeze,
  enumValue,
  fail,
  record,
  runWithBoundary,
  safeArray,
  safeIdentifier,
  safeReference,
  semver,
  snapshotData,
  timestamp,
} from "./common.mjs";

export const RUNTIME_ADAPTER_SCHEMA_VERSION = "meta-kim-live-runtime-adapter-v1";

const ADAPTER_FIELDS = ["id", "version", "label", "capabilities", "normalize"];
const ADAPTER_MANIFEST_FIELDS = ["id", "version", "label"];
const RESULT_FIELDS = ["schemaVersion", "adapter", "capabilityDeclaration", "observation", "authority"];
const OBSERVATION_FIELDS = ["status", "stage", "observedAt", "summary"];
const EVENT_FIELDS = ["at", "kind", "status", "label"];
const RUNTIME_STATUSES = Object.freeze([
  "idle",
  "pending",
  "running",
  "completed",
  "failed",
  "blocked",
  "in_doubt",
  "unknown",
]);
const EVENT_KINDS = Object.freeze(["stage", "status", "message", "checkpoint", "error", "unknown"]);

function normalizeStatus(value, label) {
  const aliases = new Map([
    ["active", "running"],
    ["in_progress", "running"],
    ["pass", "completed"],
    ["passed", "completed"],
    ["error", "failed"],
  ]);
  const normalized = typeof value === "string" ? aliases.get(value) || value : value;
  return enumValue(normalized, RUNTIME_STATUSES, label);
}

function normalizeEvent(value, label) {
  const current = record(value, EVENT_FIELDS, label);
  return {
    at: timestamp(current.at, `${label}.at`),
    kind: enumValue(current.kind, EVENT_KINDS, `${label}.kind`),
    status: normalizeStatus(current.status, `${label}.status`),
    label: boundedText(current.label, `${label}.label`, 256),
  };
}

/**
 * Normalize a contributor-produced runtime observation. The input is a
 * deliberately small public shape; authority fields are not accepted here.
 *
 * @param {object} value
 * @returns {Readonly<object>}
 */
export function normalizeRuntimeObservation(value) {
  const current = record(value, OBSERVATION_FIELDS, "observation", ["events"]);
  const events = Object.hasOwn(current, "events")
    ? safeArray(current.events, "observation.events", 128).map((event, index) => normalizeEvent(event, `observation.events[${index}]`))
    : [];
  return deepFreeze({
    status: normalizeStatus(current.status, "observation.status"),
    stage: current.stage === null ? null : safeIdentifier(current.stage, "observation.stage"),
    observedAt: timestamp(current.observedAt, "observation.observedAt"),
    summary: boundedText(current.summary, "observation.summary", 512, { allowEmpty: true }),
    events,
  });
}

function normalizeCapabilityDeclaration(capabilities) {
  return deepFreeze({
    schemaVersion: RUNTIME_ADAPTER_SCHEMA_VERSION,
    sdkVersion: LIVE_SDK_VERSION,
    capabilities: capabilityList(capabilities, "adapter.capabilities", ADAPTER_CAPABILITIES),
    authority: "self_declared_projection",
  });
}

function normalizeManifest(value) {
  const current = record(value, ADAPTER_MANIFEST_FIELDS, "result.adapter", ["schemaVersion", "sdkVersion", "capabilityDeclaration", "normalize"]);
  return {
    id: safeIdentifier(current.id, "result.adapter.id"),
    version: semver(current.version, "result.adapter.version"),
    label: boundedText(current.label, "result.adapter.label", 128),
  };
}

function normalizeAdapterDefinition(value) {
  const current = record(value, ADAPTER_FIELDS, "adapter");
  if (typeof current.normalize !== "function") fail("adapter.normalize must be a function");
  const id = safeIdentifier(current.id, "adapter.id");
  const version = semver(current.version, "adapter.version");
  const label = boundedText(current.label, "adapter.label", 128);
  const capabilities = capabilityList(current.capabilities, "adapter.capabilities", ADAPTER_CAPABILITIES);
  return { id, version, label, capabilities, normalize: current.normalize };
}

function buildResult(adapter, observation) {
  return deepFreeze({
    schemaVersion: RUNTIME_ADAPTER_SCHEMA_VERSION,
    adapter: Object.freeze({ id: adapter.id, version: adapter.version, label: adapter.label }),
    capabilityDeclaration: adapter.capabilityDeclaration,
    observation,
    authority: SDK_AUTHORITY,
  });
}

/**
 * Define a dependency-free runtime adapter. The callback receives only a
 * frozen data snapshot and may return a Promise. It cannot provide authority
 * fields or mutate the caller's object.
 *
 * @param {object} definition
 * @returns {Readonly<object>}
 */
export function defineRuntimeAdapter(definition) {
  const normalized = normalizeAdapterDefinition(definition);
  const capabilityDeclaration = normalizeCapabilityDeclaration(normalized.capabilities);
  const adapter = {
    schemaVersion: RUNTIME_ADAPTER_SCHEMA_VERSION,
    sdkVersion: LIVE_SDK_VERSION,
    id: normalized.id,
    version: normalized.version,
    label: normalized.label,
    capabilityDeclaration,
    /**
     * Normalize one explicit runtime record under the shared boundary.
     * @param {object} input
     * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
     * @returns {Promise<Readonly<object>>}
     */
    async normalize(input, options = {}) {
      const safeInput = snapshotData(input, "adapter.input");
      const context = Object.freeze({
        schemaVersion: RUNTIME_ADAPTER_SCHEMA_VERSION,
        sdkVersion: LIVE_SDK_VERSION,
        adapterId: normalized.id,
        capabilityDeclaration,
        signal: options?.signal,
      });
      const raw = await runWithBoundary(() => normalized.normalize(safeInput, context), options || {});
      return normalizeRuntimeObservation(raw);
    },
  };
  return Object.freeze(adapter);
}

/**
 * Invoke a defined adapter and return the versioned projection envelope.
 *
 * @param {object} adapter
 * @param {object} input
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<Readonly<object>>}
 */
export async function runRuntimeAdapter(adapter, input, options = {}) {
  if (!adapter || typeof adapter !== "object" || typeof adapter.normalize !== "function") fail("adapter must be defined by defineRuntimeAdapter");
  if (adapter.schemaVersion !== RUNTIME_ADAPTER_SCHEMA_VERSION || adapter.sdkVersion !== LIVE_SDK_VERSION) fail("adapter schemaVersion or sdkVersion is unsupported");
  const manifest = normalizeManifest(adapter);
  const capabilities = capabilityList(adapter.capabilityDeclaration?.capabilities, "adapter.capabilityDeclaration.capabilities", ADAPTER_CAPABILITIES);
  const declaration = record(adapter.capabilityDeclaration, ["schemaVersion", "sdkVersion", "capabilities", "authority"], "adapter.capabilityDeclaration");
  if (declaration.schemaVersion !== RUNTIME_ADAPTER_SCHEMA_VERSION || declaration.sdkVersion !== LIVE_SDK_VERSION || declaration.authority !== "self_declared_projection") {
    fail("adapter capability declaration is not a current self-declared projection");
  }
  if (JSON.stringify(capabilities) !== JSON.stringify(declaration.capabilities)) fail("adapter capability declaration is not canonical");
  const observation = await adapter.normalize(input, options);
  return buildResult({ ...manifest, capabilityDeclaration: deepFreeze({ ...declaration, capabilities }) }, observation);
}

/**
 * Validate a runtime adapter result received from a contributor or persisted
 * fixture. Validation does not repair or promote it.
 *
 * @param {object} value
 * @returns {Readonly<object>}
 */
export function assertValidRuntimeAdapterResult(value) {
  const result = record(value, RESULT_FIELDS, "runtime adapter result");
  if (result.schemaVersion !== RUNTIME_ADAPTER_SCHEMA_VERSION) fail("runtime adapter result schemaVersion is unsupported");
  normalizeManifest(record(result.adapter, ADAPTER_MANIFEST_FIELDS, "runtime adapter result.adapter"));
  const declaration = record(result.capabilityDeclaration, ["schemaVersion", "sdkVersion", "capabilities", "authority"], "runtime adapter result.capabilityDeclaration");
  if (declaration.schemaVersion !== RUNTIME_ADAPTER_SCHEMA_VERSION || declaration.sdkVersion !== LIVE_SDK_VERSION || declaration.authority !== "self_declared_projection") fail("runtime adapter capability declaration is invalid");
  capabilityList(declaration.capabilities, "runtime adapter result.capabilityDeclaration.capabilities", ADAPTER_CAPABILITIES);
  normalizeRuntimeObservation(result.observation);
  assertAuthority(result.authority, "runtime adapter result.authority");
  return result;
}

export {
  RUNTIME_STATUSES as RUNTIME_STATUS_VALUES,
  ADAPTER_CAPABILITIES as RUNTIME_ADAPTER_CAPABILITIES,
};
