/**
 * Explicit runtime adapter registry for live continuation.
 *
 * Registry entries are dependency-injected. This module never discovers a
 * host CLI, allocates model quota, or performs an implicit runtime call.
 */
export const LIVE_RUNTIME_ADAPTER_REGISTRY_SCHEMA_VERSION =
  "meta-kim-live-runtime-adapter-registry-v1";
export const LIVE_CONTINUATION_RUNTIME_ACTIONS = Object.freeze([
  "pause",
  "resume",
  "reassign",
  "handoff",
]);
export const SUPPORTED_LIVE_RUNTIME_IDS = Object.freeze([
  "claude",
  "codex",
  "cursor",
  "openclaw",
  "fake",
  "fixture",
  "mock",
  "test",
]);

const ADAPTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+\-]{0,127}$/u;
const RUNTIME_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

function fail(message, code = "LIVE_RUNTIME_ADAPTER_INVALID") {
  const error = new TypeError(`Live runtime adapter: ${message}`);
  error.code = code;
  throw error;
}

function plainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain record`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(`${label} has an unsupported key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${label} must contain own data properties only`);
  }
  return value;
}

function identifier(value, label, pattern = ADAPTER_ID_PATTERN) {
  if (typeof value !== "string" || !pattern.test(value) || /(?:https?|ftp|file):|[\\/]/iu.test(value)) {
    fail(`${label} must be a safe bounded identifier`);
  }
  return value;
}

function normalizeCapabilities(value) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value).filter(([, enabled]) => enabled).map(([name]) => name)
      : [];
  if (entries.length === 0) fail("capabilities must explicitly declare at least one action", "LIVE_RUNTIME_ADAPTER_CAPABILITY_REQUIRED");
  const normalized = [];
  for (const raw of entries) {
    if (typeof raw !== "string") fail("capability must be a string");
    const name = raw.replace(/^live\.continuation\./u, "").replace(/^continuation\./u, "");
    if (!LIVE_CONTINUATION_RUNTIME_ACTIONS.includes(name)) {
      fail(`unsupported capability ${raw}`, "LIVE_RUNTIME_ADAPTER_CAPABILITY_UNSUPPORTED");
    }
    if (!normalized.includes(name)) normalized.push(name);
  }
  return Object.freeze(normalized.sort());
}

function normalizeAdapter(input, { requireExecutor = true } = {}) {
  plainRecord(input, "adapter");
  const adapterId = identifier(input.adapterId ?? input.id, "adapter.adapterId");
  const runtime = identifier(input.runtime, "adapter.runtime", RUNTIME_PATTERN);
  if (!SUPPORTED_LIVE_RUNTIME_IDS.includes(runtime)) {
    fail(`unsupported runtime ${runtime}`, "LIVE_RUNTIME_ADAPTER_RUNTIME_UNSUPPORTED");
  }
  const capabilities = normalizeCapabilities(input.capabilities);
  const execute = input.execute ?? input.invoke ?? input.apply;
  if (requireExecutor && typeof execute !== "function") {
    fail("adapter must expose an injected execute function", "LIVE_RUNTIME_ADAPTER_EXECUTOR_REQUIRED");
  }
  if (execute !== undefined && typeof execute !== "function") fail("adapter execute must be a function");
  const sideEffectMode = input.sideEffectMode ?? "injected";
  if (sideEffectMode !== "injected") fail("adapter sideEffectMode must be injected");
  return {
    schemaVersion: LIVE_RUNTIME_ADAPTER_REGISTRY_SCHEMA_VERSION,
    adapterId,
    runtime,
    capabilities,
    sideEffectMode,
    execute,
    metadata: input.metadata === undefined ? null : input.metadata,
  };
}

function freezeAdapter(adapter) {
  Object.freeze(adapter);
  return adapter;
}

/** Build a test-only injected adapter; no host or model calls are performed. */
export function createFakeLiveRuntimeAdapter({
  adapterId = "fake-live-runtime",
  runtime = "fake",
  capabilities = LIVE_CONTINUATION_RUNTIME_ACTIONS,
  execute = async ({ action }) => ({ accepted: true, action, fake: true }),
  metadata = null,
} = {}) {
  return freezeAdapter(normalizeAdapter({
    adapterId,
    runtime,
    capabilities,
    execute,
    metadata,
    sideEffectMode: "injected",
  }));
}

export function createLiveRuntimeAdapterRegistry({ adapters = [] } = {}) {
  if (!Array.isArray(adapters)) fail("adapters must be a list");
  const entries = new Map();

  const register = (input) => {
    const adapter = freezeAdapter(normalizeAdapter(input));
    if (entries.has(adapter.adapterId)) {
      fail(`adapter ${adapter.adapterId} is already registered`, "LIVE_RUNTIME_ADAPTER_DUPLICATE");
    }
    entries.set(adapter.adapterId, adapter);
    return adapter;
  };

  for (const input of adapters) register(input);

  const resolve = (adapterRef, { runtime = null, action = null } = {}) => {
    const adapterId = typeof adapterRef === "string"
      ? adapterRef
      : adapterRef?.adapterId ?? adapterRef?.id;
    if (typeof adapterId !== "string") fail("runtime adapter binding is required", "LIVE_RUNTIME_ADAPTER_REQUIRED");
    const adapter = entries.get(adapterId);
    if (!adapter) fail(`unknown runtime adapter ${adapterId}`, "LIVE_RUNTIME_ADAPTER_UNKNOWN");
    if (runtime !== null && adapter.runtime !== runtime) {
      fail("runtime adapter binding does not match command runtime", "LIVE_RUNTIME_ADAPTER_RUNTIME_MISMATCH");
    }
    if (action !== null && !adapter.capabilities.includes(action)) {
      fail(`adapter ${adapter.adapterId} does not declare ${action}`, "LIVE_RUNTIME_ADAPTER_CAPABILITY_MISSING");
    }
    return adapter;
  };

  const has = (adapterRef, options = {}) => {
    try {
      resolve(adapterRef, options);
      return true;
    } catch {
      return false;
    }
  };

  const invoke = async (adapterRef, request = {}) => {
    const action = request.action;
    if (!LIVE_CONTINUATION_RUNTIME_ACTIONS.includes(action)) {
      fail("runtime invocation action is unsupported", "LIVE_RUNTIME_ADAPTER_ACTION_UNSUPPORTED");
    }
    const adapter = resolve(adapterRef, { runtime: request.runtime ?? null, action });
    if (typeof adapter.execute !== "function") {
      fail("resolved adapter has no injected executor", "LIVE_RUNTIME_ADAPTER_EXECUTOR_REQUIRED");
    }
    const result = await adapter.execute(Object.freeze({
      ...request,
      adapterId: adapter.adapterId,
      runtime: adapter.runtime,
      capabilities: adapter.capabilities,
    }));
    return { adapterId: adapter.adapterId, runtime: adapter.runtime, action, result };
  };

  return Object.freeze({
    schemaVersion: LIVE_RUNTIME_ADAPTER_REGISTRY_SCHEMA_VERSION,
    register,
    resolve,
    has,
    invoke,
    get(adapterRef, options = {}) { return resolve(adapterRef, options); },
    list() { return Object.freeze([...entries.values()]); },
  });
}

export const createRuntimeAdapterRegistry = createLiveRuntimeAdapterRegistry;
export const createLiveRuntimeAdapters = createLiveRuntimeAdapterRegistry;
export const createLiveRuntimeAdapterRegistryForTests = createLiveRuntimeAdapterRegistry;
