import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";

import {
  createLiveControlRoomService,
  LIVE_REPLAY_SCHEMA_VERSION,
} from "../../application/live/live-control-room-service.mjs";
import {
  loadLiveDefaultSelectionPolicy,
  pickDefaultRow,
  projectSelectionRow,
  sessionSelectionRow,
  sortProjectsForDefault,
} from "../../application/live/live-default-selection.mjs";
import { loadLiveCatalogScanPolicy } from "../../application/live/live-catalog-scan-policy.mjs";
import { liveRecordOrigin } from "../../application/live/live-record-origin.mjs";
import { isLiveRunId } from "./live-read-repository.mjs";
import { LIVE_HUB_HEALTH_SCHEMA_VERSION } from "./live-hub-lifecycle.mjs";
import {
  createLiveHubProjectCatalog,
  LIVE_HUB_MAX_EVENT_COUNT,
  LIVE_HUB_MAX_NODE_COUNT,
} from "./live-hub-project-catalog.mjs";
import { renderLiveControlRoomPage } from "../../presentation/live/live-control-room-page.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const CONTROL_HEADER = "x-meta-kim-control-token";
const DEFAULT_MAX_JSON_BYTES = 256 * 1024;
const CONTROL_ACTIONS = Object.freeze(["pause", "resume", "reassign", "handoff"]);
const BRAND_MARK_PNG = readFileSync(new URL("../../presentation/live/assets/meta-kim-k-mark.png", import.meta.url));
const DEFAULT_SELECTION = loadLiveDefaultSelectionPolicy();

function boundedPublicCount(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function publicSubstanceClass(value) {
  return value === "substantive" || value === "activation_only" ? value : "unknown";
}

/**
 * The public shape re-derives count availability from the counts that survived
 * bounding, so a count dropped for being out of range is reported as unavailable
 * rather than silently reappearing as an absent key the reader would read as zero.
 *
 * Each count is weighed on its own. A record can measure its worker roster and
 * still declare no replay collection — every schema-version-1 artifact does —
 * and folding those together would republish a measured count as no report.
 */
function publicCountsAvailability(declared, counts) {
  const state = declared && typeof declared === "object" && !Array.isArray(declared)
    ? declared.state
    : null;
  const reason = declared && typeof declared === "object" && !Array.isArray(declared)
    ? declared.reason
    : null;
  const measured = counts.filter((count) => count !== null).length;
  if (measured === 0) {
    return { state: "unavailable", reason: reason || "no_measured_counts_available" };
  }
  if (measured < counts.length) {
    return { state: "partial", reason: reason || "some_counts_outside_public_bounds" };
  }
  return {
    state: state === "measured" ? "measured" : "partial",
    reason: reason || "governed_artifact_collections",
  };
}

function capabilityAvailable(value) {
  if (value === true) return true;
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value.available === true || value.enabled === true));
}

function normalizeControlCapabilities(options = {}) {
  const builder = options.controlCommandBuilder;
  const configured = options.controlCapabilities
    ?? options.commandCapabilities
    ?? options.capabilities
    ?? (builder && typeof builder === "object" ? builder.capabilities : null);
  const capabilities = configured && typeof configured === "object" && !Array.isArray(configured)
    ? (configured.capabilities && typeof configured.capabilities === "object" && !Array.isArray(configured.capabilities)
      ? configured.capabilities
      : configured)
    : null;
  if (!capabilities || !CONTROL_ACTIONS.every((action) => capabilityAvailable(capabilities[action]))) return null;
  return Object.freeze(Object.fromEntries(CONTROL_ACTIONS.map((action) => [action, { available: true }])));
}

function resolveControlCommandBuilder(options = {}) {
  if (typeof options.controlCommandBuilder === "function") return options.controlCommandBuilder;
  if (options.controlCommandBuilder && typeof options.controlCommandBuilder.build === "function") {
    return (context) => options.controlCommandBuilder.build(context);
  }
  return null;
}

function hasDurableContinuationRepository(options = {}) {
  const repository = options.durableRepository;
  return Boolean(repository && typeof repository.resumeRun === "function" && typeof repository.verifyEventChain === "function" &&
    typeof repository.prepareEffect === "function" &&
    typeof repository.markEffectDispatchStarted === "function" &&
    typeof repository.markUnresolvedEffectsInDoubt === "function");
}

function hasRuntimeAdapterRegistry(options = {}) {
  const registry = options.adapterRegistry || options.runtimeAdapterRegistry;
  return Boolean(registry && typeof registry.resolve === "function" && typeof registry.invoke === "function");
}

function normalizeControlAdapterBindings(options = {}) {
  const builder = options.controlCommandBuilder;
  const configured = options.controlAdapterBindings
    ?? options.adapterBindings
    ?? (builder && typeof builder === "object" ? builder.adapterBindings : null)
    ?? (typeof builder === "function" ? builder.adapterBindings : null);
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) return null;
  const registry = options.adapterRegistry || options.runtimeAdapterRegistry;
  if (!registry || typeof registry.resolve !== "function") return null;
  const normalized = {};
  for (const action of CONTROL_ACTIONS) {
    const binding = configured[action];
    if (!binding || typeof binding !== "object" || Array.isArray(binding) || typeof binding.adapterId !== "string" || typeof binding.runtime !== "string") return null;
    try {
      const valid = typeof registry.has === "function"
        ? registry.has(binding.adapterId, { runtime: binding.runtime, action })
        : Boolean(registry.resolve(binding.adapterId, { runtime: binding.runtime, action }));
      if (!valid) return null;
    } catch {
      return null;
    }
    normalized[action] = { adapterId: binding.adapterId, runtime: binding.runtime };
  }
  return Object.freeze(normalized);
}

function hasCommandStore(options = {}) {
  const store = options.commandStore || options.continuationCommandStore;
  return Boolean(store && typeof store.append === "function");
}

function controlExposure(options = {}, enableControl = false) {
  const capabilities = normalizeControlCapabilities(options);
  const builder = resolveControlCommandBuilder(options);
  const durableRepository = hasDurableContinuationRepository(options);
  const adapterRegistry = hasRuntimeAdapterRegistry(options);
  const commandStore = hasCommandStore(options);
  const adapterBindings = normalizeControlAdapterBindings(options);
  const enabled = enableControl && durableRepository && adapterRegistry && commandStore && Boolean(builder) && Boolean(capabilities) && Boolean(adapterBindings);
  return {
    enabled,
    builder,
    capabilities: enabled ? capabilities : null,
    durableRepository,
    adapterRegistry,
    commandStore,
    adapterBindings: enabled ? adapterBindings : null,
  };
}

function withoutControlProjection(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const { control: _control, controls: _controls, ...safeSnapshot } = snapshot;
  return safeSnapshot;
}

function securityHeaders(response) {
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function jsonResponse(response, statusCode, value) {
  const body = JSON.stringify(value);
  securityHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function textResponse(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  securityHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function binaryResponse(response, statusCode, body, contentType) {
  securityHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", "public, max-age=3600");
  response.setHeader("content-length", body.byteLength);
  response.end(body);
}

function safeError(code) {
  return { error: code };
}

function semanticSnapshotKey(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return "null";
  return JSON.stringify({
    ...snapshot,
    source: snapshot.source && typeof snapshot.source === "object"
      ? { ...snapshot.source, observedAt: undefined }
      : snapshot.source,
  });
}

function loopbackOnly(host) {
  return host === undefined || host === null || host === "" || host === LOOPBACK_HOST || host === "localhost";
}

function requestUrl(request) {
  try {
    return new URL(request.url || "/", "http://127.0.0.1");
  } catch {
    return null;
  }
}

function requestHasLocalAuthority(request, server) {
  const address = server.address();
  if (!address || typeof address !== "object") return false;
  const expectedAuthority = `${LOOPBACK_HOST}:${address.port}`;
  if (request.headers.host !== expectedAuthority) return false;
  const origin = request.headers.origin;
  return typeof origin !== "string" || origin === `http://${expectedAuthority}`;
}

function requestHasSameOrigin(request, server) {
  if (!requestHasLocalAuthority(request, server)) return false;
  const address = server.address();
  if (!address || typeof address !== "object") return false;
  return request.headers.origin === `http://${LOOPBACK_HOST}:${address.port}`;
}

function readJsonBody(request, maxBytes = DEFAULT_MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const contentLength = request.headers["content-length"];
    if (contentLength !== undefined && (!/^\d+$/u.test(String(contentLength)) || Number(contentLength) > maxBytes)) {
      request.resume();
      const error = new Error("request body exceeds the bounded JSON size");
      error.code = "LIVE_REQUEST_BODY_TOO_LARGE";
      reject(error);
      return;
    }
    let size = 0;
    const chunks = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      request.resume();
      reject(error);
    };
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("request body exceeds the bounded JSON size");
        error.code = "LIVE_REQUEST_BODY_TOO_LARGE";
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", fail);
    request.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        const error = new Error("request JSON body is required");
        error.code = "LIVE_REQUEST_BODY_INVALID";
        reject(error);
        return;
      }
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body must be an object");
        resolve(value);
      } catch {
        const error = new Error("request JSON body is invalid");
        error.code = "LIVE_REQUEST_BODY_INVALID";
        reject(error);
      }
    });
  });
}

function commandFromEnvelope(body) {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "command" || !body.command || typeof body.command !== "object" || Array.isArray(body.command)) {
    const error = new Error("command envelope contains unsupported fields");
    error.code = "LIVE_REQUEST_BODY_INVALID";
    throw error;
  }
  return body.command;
}

function isSimpleControlIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === "action" && keys[1] === "runId" &&
    typeof value.action === "string" && typeof value.runId === "string";
}

function controlError(message, code) {
  const error = new Error(`Live control: ${message}`);
  error.code = code;
  return error;
}

function assertControlAdapterBinding(command, exposure) {
  if (!exposure?.adapterBindings || typeof exposure.adapterBindings !== "object") {
    throw controlError("control adapter bindings are unavailable", "LIVE_CONTROL_ADAPTER_BINDING_UNAVAILABLE");
  }
  if (!command || typeof command !== "object" || Array.isArray(command) || !CONTROL_ACTIONS.includes(command.action)) {
    throw controlError("command action is not an exposed control action", "LIVE_CONTROL_ADAPTER_BINDING_MISMATCH");
  }
  const binding = exposure.adapterBindings[command.action];
  if (
    !binding ||
    typeof command.runtimeAdapter !== "string" ||
    typeof command.runtime !== "string" ||
    command.runtimeAdapter !== binding.adapterId ||
    command.runtime !== binding.runtime
  ) {
    throw controlError("command runtime adapter does not match the exposed action binding", "LIVE_CONTROL_ADAPTER_BINDING_MISMATCH");
  }
  return command;
}

async function resolveCommandBody(body, { service, exposure, nowMs }) {
  const command = body.command && typeof body.command === "object" && !Array.isArray(body.command)
    ? commandFromEnvelope(body)
    : body;
  if (!isSimpleControlIntent(command)) return assertControlAdapterBinding(command, exposure);
  if (!exposure.enabled || !exposure.builder) {
    throw controlError("simplified browser intent requires a complete control capability loadout", "LIVE_CONTROL_COMMAND_BUILDER_UNAVAILABLE");
  }
  if (!service || typeof service.getSnapshot !== "function") {
    throw controlError("fresh snapshot authority is unavailable", "LIVE_CONTROL_CAPABILITY_UNAVAILABLE");
  }
  const snapshot = await service.getSnapshot();
  const snapshotRunId = snapshot?.run?.runId || snapshot?.run?.id;
  if (snapshotRunId !== command.runId) {
    throw controlError("simplified intent does not match the fresh trusted run", "LIVE_CONTROL_RUN_MISMATCH");
  }
  const built = await exposure.builder({
    action: command.action,
    runId: command.runId,
    snapshot,
    nowMs,
  });
  const candidate = built && typeof built === "object" && !Array.isArray(built) && built.command && typeof built.command === "object" && !Array.isArray(built.command)
    ? built.command
    : built;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw controlError("control command builder did not return a complete command", "LIVE_CONTROL_COMMAND_BUILDER_INVALID");
  }
  return assertControlAdapterBinding(candidate, exposure);
}

function boundedError(error, fallback = "control_unavailable") {
  if (error?.code === "LIVE_REQUEST_BODY_TOO_LARGE") return { status: 413, body: safeError("request_too_large") };
  if (error?.code === "LIVE_REQUEST_BODY_INVALID") return { status: 400, body: safeError("invalid_json") };
  if (error?.code === "LIVE_SHARE_FORMAT_UNSUPPORTED") return { status: 400, body: safeError("unsupported_share_format") };
  if (error?.code === "LIVE_SHARE_RUN_ID_INVALID") return { status: 400, body: safeError("invalid_run_id") };
  if (error?.code === "LIVE_SHARE_UNAVAILABLE") return { status: 404, body: safeError("share_unavailable") };
  if (
    error?.code === "LIVE_CONTINUATION_PLANNER_UNAVAILABLE" ||
    error?.code === "LIVE_CONTINUATION_ADAPTER_UNAVAILABLE" ||
    error?.code === "LIVE_CONTINUATION_AUTHORITY_REQUIRED" ||
    error?.code === "LIVE_CONTINUATION_STORE_REQUIRED" ||
    error?.code === "LIVE_CONTINUATION_EFFECT_PROTOCOL_REQUIRED"
  ) {
    return { status: 503, body: { status: "plan_only", executionAllowed: false, mutationAllowed: false, error: "control_capability_unavailable" } };
  }
  if (error?.code === "LIVE_CONTROL_CAPABILITY_UNAVAILABLE" || error?.code === "LIVE_CONTROL_COMMAND_BUILDER_UNAVAILABLE") {
    return { status: 503, body: { status: "plan_only", executionAllowed: false, mutationAllowed: false, error: "control_capability_unavailable" } };
  }
  if (error?.code === "LIVE_CONTROL_COMMAND_BUILDER_INVALID" || error?.code === "LIVE_CONTROL_RUN_MISMATCH" || error?.code === "LIVE_CONTROL_ADAPTER_BINDING_MISMATCH") {
    return { status: 400, body: { status: "blocked", executionAllowed: false, mutationAllowed: false, error: "continuation_blocked" } };
  }
  if (error?.code === "LIVE_CONTROL_ADAPTER_BINDING_UNAVAILABLE") {
    return { status: 503, body: { status: "plan_only", executionAllowed: false, mutationAllowed: false, error: "control_capability_unavailable" } };
  }
  if (error?.code === "LIVE_CONTINUATION_ADAPTER_INVOCATION_FAILED") {
    return {
      status: 503,
      body: {
        ...(error.executionResult || {}),
        status: "adapter_failed",
        adapterInvocationObserved: false,
        effectState: "in_doubt",
        completionVerified: false,
        error: "adapter_invocation_failed",
      },
    };
  }
  if (error?.code?.startsWith("LIVE_RUNTIME_ADAPTER_")) {
    return { status: 503, body: { status: "plan_only", executionAllowed: false, mutationAllowed: false, error: "control_capability_unavailable" } };
  }
  if (error?.code === "LIVE_CONTINUATION_STORE_NONCE_REPLAY" || error?.code === "LIVE_CONTINUATION_STORE_CAS_MISMATCH" || error?.code === "LIVE_CONTINUATION_STORE_COMMAND_REPLAY") {
    return { status: 409, body: { status: "blocked", executionAllowed: false, mutationAllowed: false, error: "command_replay_or_cas_conflict" } };
  }
  if (error?.code?.startsWith("LIVE_CONTINUATION_")) return { status: 400, body: { status: "blocked", executionAllowed: false, mutationAllowed: false, error: "continuation_blocked" } };
  return { status: 500, body: safeError(fallback) };
}

/**
 * Build a loopback-only HTTP server for the read-only control-room service.
 * The returned controller owns only the server socket; source files are never
 * written by this module.
 *
 * @param {object} [options]
 * @returns {{server: import('node:http').Server, service: object, start: Function, close: Function}}
 */
export function createLiveControlRoomServer(options = {}) {
  const globalHub = options.globalHub === true;
  const service = options.service || createLiveControlRoomService(globalHub
    ? {
        ...options,
        repository: {
          readDurableStatus: async () => null,
          readLatestArtifact: async () => null,
          readArtifact: async () => null,
        },
      }
    : options);
  const requestedPort = Number.isInteger(options.port) && options.port >= 0 ? options.port : DEFAULT_PORT;
  const requestedHost = options.host;
  if (!loopbackOnly(requestedHost)) {
    throw new TypeError("Live sidecar accepts loopback host only.");
  }
  const instanceId = typeof options.instanceId === "string" ? options.instanceId : null;
  const packageIdentity = typeof options.packageIdentity === "string" ? options.packageIdentity : null;
  // The identity digest proves a match but cannot be compared to anything a person
  // knows, so a Hub serving an older install answered /api/health exactly like the
  // working tree and rendered hours-old code with nothing anywhere saying so. The
  // value is whatever the start path was handed: re-reading package.json per
  // request would report the file as it is now rather than the build this Hub was
  // started from, and a default would read as a real version.
  const packageVersion = typeof options.packageVersion === "string" ? options.packageVersion : null;
  const hubCatalog = globalHub
    ? (options.hubCatalog || createLiveHubProjectCatalog(options))
    : null;
  const hubProfile = globalHub && typeof hubCatalog?.profile === "string"
    ? hubCatalog.profile
    : typeof options.profile === "string"
      ? options.profile
      : "default";
  const projectServices = new Map();
  // How long a built project list stays current, how much longer it may still be
  // served while a replacement is built, and how many projects may be walked at
  // once. All three live in config/live/catalog-scan.json: the walk cost is a
  // property of the machine and the registry, not of this file.
  const catalogScanPolicy = options.scanPolicy || loadLiveCatalogScanPolicy();
  const hubCatalogTtlMs = catalogScanPolicy.cacheTtlMs;
  const hubCatalogStaleWindowMs = catalogScanPolicy.staleWhileRevalidateMs;
  const hubCatalogClock = typeof options.hubCatalogClock === "function"
    ? options.hubCatalogClock
    : Date.now;
  let hubCatalogCache = null;
  let hubCatalogCacheExpiresAt = 0;
  let hubCatalogReadPromise = null;
  const createProjectService = typeof options.createProjectService === "function"
    ? options.createProjectService
    : ({ repoRoot }) => createLiveControlRoomService({
        ...options,
        service: undefined,
        repository: undefined,
        projectRoot: repoRoot,
      });
  const enableControl = !globalHub && options.enableControl === true;
  const exposure = controlExposure(options, enableControl);
  const controlToken = enableControl
    ? (typeof options.controlToken === "string" && options.controlToken.length >= 16
      ? options.controlToken
      : randomBytes(32).toString("base64url"))
    : null;
  const maxJsonBytes = Number.isSafeInteger(options.maxJsonBytes) && options.maxJsonBytes >= 1 && options.maxJsonBytes <= 1_048_576
    ? options.maxJsonBytes
    : DEFAULT_MAX_JSON_BYTES;

  const clients = new Map();
  let listening = null;
  let closePromise = null;
  let closed = false;
  let heartbeat = null;
  let observer = null;
  let observerBusy = false;
  const pollIntervalMs = Number.isInteger(options.pollIntervalMs) && options.pollIntervalMs >= 10
    ? options.pollIntervalMs
    : 1_000;
  const heartbeatIntervalMs = Number.isInteger(options.heartbeatIntervalMs) && options.heartbeatIntervalMs >= 10
    ? options.heartbeatIntervalMs
    : 25_000;

  const stopObserverWhenIdle = () => {
    if (clients.size > 0 || !observer) return;
    clearInterval(observer);
    observer = null;
  };

  const rebuildHubProjects = () => {
    if (!hubCatalogReadPromise) {
      hubCatalogReadPromise = Promise.resolve(hubCatalog.listProjects())
        .then((projects) => {
          hubCatalogCache = Array.isArray(projects) ? projects : [];
          hubCatalogCacheExpiresAt = hubCatalogClock() + hubCatalogTtlMs;
          return hubCatalogCache;
        })
        .finally(() => {
          hubCatalogReadPromise = null;
        });
    }
    return hubCatalogReadPromise;
  };

  const readHubProjects = async ({ refresh = false } = {}) => {
    const now = hubCatalogClock();
    if (refresh || !hubCatalogCache) return rebuildHubProjects();
    if (hubCatalogCacheExpiresAt > now) return hubCatalogCache;
    if (hubCatalogCacheExpiresAt + hubCatalogStaleWindowMs > now) {
      // Answer with the list already in hand and build the replacement behind the
      // reader. A rebuild that fails leaves the previous list in place, and the
      // request that finds it past the stale window waits for a real walk, so the
      // failure surfaces there instead of being served forever.
      rebuildHubProjects().catch(() => {});
      return hubCatalogCache;
    }
    return rebuildHubProjects();
  };

  const publicHubCatalog = async ({ requestedProjectId = null, requestedRunId = null, refresh = false } = {}) => {
    const internalProjects = await readHubProjects({ refresh });
    const unorderedProjects = internalProjects.map((project) => ({
      projectId: project.projectRef,
      displayName: project.displayName,
      status: project.status,
      activeSessionId: project.activeSessionId,
      sessionCount: project.sessionCount,
      omittedSessionCount: Number.isFinite(Number(project.omittedSessionCount))
        ? Number(project.omittedSessionCount)
        : 0,
      updatedAt: project.updatedAt,
      sessions: Array.isArray(project.sessions)
        ? project.sessions.map((session) => {
            const workerCount = boundedPublicCount(session.workerCount, LIVE_HUB_MAX_NODE_COUNT);
            const nodeCount = boundedPublicCount(session.nodeCount, LIVE_HUB_MAX_NODE_COUNT);
            const eventCount = boundedPublicCount(session.eventCount, LIVE_HUB_MAX_EVENT_COUNT);
            return {
              sessionId: session.sessionId,
              runId: session.runId,
              title: session.title,
              titleSource: session.titleSource,
              identificationState: session.identificationState,
              recordOrigin: liveRecordOrigin(session),
              sourceRuntime: session.sourceRuntime,
              conversationLinkState: session.conversationLinkState,
              ...(session.conversationLinkRefusal
                ? { conversationLinkRefusal: session.conversationLinkRefusal }
                : {}),
              // The discovery reasons are statements about what was inspected, and
              // this surface inspects nothing — it republishes the catalog. A record
              // that carries no discovery block is published without one so the
              // reader gets the plain sentence instead of a claim nobody made.
              ...(session.conversationDiscovery && typeof session.conversationDiscovery === "object"
                ? {
                    conversationDiscovery: {
                      state: session.conversationDiscovery.state,
                      ...(session.conversationDiscovery.runtime ? { runtime: session.conversationDiscovery.runtime } : {}),
                      ...(session.conversationDiscovery.reason ? { reason: session.conversationDiscovery.reason } : {}),
                    },
                  }
                : {}),
              verifiedLinks: Array.isArray(session.verifiedLinks)
                ? session.verifiedLinks.slice(0, 16).map((link) => ({
                    sourceRuntime: link.sourceRuntime,
                    conversationRef: link.conversationRef,
                    matchBasis: link.matchBasis,
                    ...(link.conversationTitle ? { conversationTitle: link.conversationTitle } : {}),
                    ...(link.updatedAt ? { updatedAt: link.updatedAt } : {}),
                  }))
                : [],
              candidateLinks: Array.isArray(session.candidateLinks)
                ? session.candidateLinks.slice(0, 16).map((link) => ({
                    sourceRuntime: link.sourceRuntime,
                    conversationRef: link.conversationRef,
                    matchBasis: link.matchBasis,
                    ...(link.conversationTitle ? { conversationTitle: link.conversationTitle } : {}),
                    ...(link.updatedAt ? { updatedAt: link.updatedAt } : {}),
                  }))
                : [],
              ...(session.conversationRef ? { conversationRef: session.conversationRef } : {}),
              ...(session.conversationTitle ? { conversationTitle: session.conversationTitle } : {}),
              status: session.status,
              displayState: session.displayState,
              statusReason: session.statusReason,
              currentStage: session.currentStage,
              runtime: session.runtime,
              updatedAt: session.updatedAt,
              // Two very different claims share this one value: a time the run
              // reported, and a time read off the record file because the run
              // reported none. The basis has to travel with it or the browser
              // shows both identically.
              ...(session.updatedAtBasis ? { updatedAtBasis: session.updatedAtBasis } : {}),
              // `updatedAt` folds several distinct instants into one, so it cannot
              // answer "did this run start long ago". The start instant is published
              // only when the record states one.
              ...(session.startedAt ? { startedAt: session.startedAt } : {}),
              substanceClass: publicSubstanceClass(session.substanceClass),
              countsAvailability: publicCountsAvailability(session.countsAvailability, [workerCount, nodeCount, eventCount]),
              ...(workerCount === null ? {} : { workerCount }),
              ...(nodeCount === null ? {} : { nodeCount }),
              ...(eventCount === null ? {} : { eventCount }),
              active: session.active === true,
            };
          })
        : [],
    }));
    // Drawability first, then liveness. Ranking liveness first is what opened
    // the control room on a project whose every run was an activation receipt.
    const projects = sortProjectsForDefault(unorderedProjects, DEFAULT_SELECTION);
    const selectedProject = pickDefaultRow(
      projects.map((project) => projectSelectionRow(project, DEFAULT_SELECTION)),
      DEFAULT_SELECTION,
      requestedProjectId || "",
    )?.project || null;
    const selectedRun = pickDefaultRow(
      (selectedProject?.sessions || []).map((session) => sessionSelectionRow(session)),
      DEFAULT_SELECTION,
      requestedRunId || "",
    )?.session || null;
    return {
      schemaVersion: "meta-kim-live-hub-catalog-v1",
      projects,
      selected: {
        projectId: selectedProject?.projectId || null,
        runId: selectedRun?.runId || null,
      },
    };
  };

  const resolveHubSelection = async (parsed) => {
    if (!globalHub) return { service, projectId: null, runId: parsed.searchParams.get("runId") || null };
    const requestedProjectId = parsed.searchParams.get("projectId");
    const requestedRunId = parsed.searchParams.get("runId");
    const catalog = await publicHubCatalog({ requestedProjectId, requestedRunId });
    if (catalog.projects.length === 0) return { service: null, projectId: null, runId: null, catalog };
    if (requestedProjectId && catalog.selected.projectId !== requestedProjectId) {
      return { service: null, projectId: null, runId: null, catalog, invalidProject: true };
    }
    const projectId = catalog.selected.projectId;
    const runId = requestedRunId || catalog.selected.runId;
    if (requestedRunId && !isLiveRunId(requestedRunId)) {
      return { service: null, projectId, runId: null, catalog, invalidRun: true };
    }
    const selectedProject = catalog.projects.find((project) => project.projectId === projectId);
    if (requestedRunId && !selectedProject?.sessions?.some((session) => session.runId === requestedRunId)) {
      return { service: null, projectId, runId: requestedRunId, catalog, invalidRun: true };
    }
    const internalProject = await hubCatalog.resolveProject(projectId);
    if (!internalProject) return { service: null, projectId, runId, catalog, invalidProject: true };
    const cacheKey = `${projectId}:${internalProject.repoRoot}`;
    let selectedService = projectServices.get(cacheKey);
    if (!selectedService) {
      selectedService = createProjectService(internalProject);
      projectServices.clear();
      projectServices.set(cacheKey, selectedService);
    }
    return { service: selectedService, projectId, runId, catalog };
  };

  const publishSnapshotChange = async () => {
    if (observerBusy || clients.size === 0) return;
    observerBusy = true;
    try {
      for (const [client, selection] of clients) {
        if (client.writableEnded) continue;
        const snapshot = withoutControlProjection(await selection.service
          .getSnapshot(selection.runId)
          .catch(() => null));
        if (!snapshot) continue;
        const key = semanticSnapshotKey(snapshot);
        if (selection.lastSnapshotKey !== null && key !== selection.lastSnapshotKey) {
          client.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
        }
        selection.lastSnapshotKey = key;
      }
    } finally {
      observerBusy = false;
    }
  };

  const ensureObserver = () => {
    if (observer) return;
    observer = setInterval(publishSnapshotChange, pollIntervalMs);
    observer.unref?.();
  };

  const server = createServer(async (request, response) => {
    if (!requestHasLocalAuthority(request, server)) {
      jsonResponse(response, 403, safeError("forbidden_authority"));
      return;
    }
    const parsed = requestUrl(request);
    if (!parsed) {
      jsonResponse(response, 400, safeError("invalid_request"));
      return;
    }

    if (parsed.pathname === "/api/health") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        jsonResponse(response, 405, safeError("method_not_allowed"));
        return;
      }
      jsonResponse(response, 200, {
        schemaVersion: LIVE_HUB_HEALTH_SCHEMA_VERSION,
        status: "ok",
        instanceId,
        packageIdentity,
        packageVersion,
        profile: hubProfile,
        singleton: globalHub,
        readOnly: !exposure.enabled,
      });
      return;
    }

    if (parsed.pathname === "/api/projects") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        jsonResponse(response, 405, safeError("method_not_allowed"));
        return;
      }
      if (!globalHub) {
        jsonResponse(response, 404, safeError("hub_catalog_unavailable"));
        return;
      }
      try {
        // No forced refresh. Building this catalog walks every registered
        // project's run directory, and the page asks for it on first paint and on
        // every project or run switch, so forcing a fresh read put the whole walk
        // in front of each click while the cache above was never read.
        jsonResponse(response, 200, await publicHubCatalog({
          requestedProjectId: parsed.searchParams.get("projectId"),
          requestedRunId: parsed.searchParams.get("runId"),
        }));
      } catch {
        jsonResponse(response, 200, {
          schemaVersion: "meta-kim-live-hub-catalog-v1",
          projects: [],
          selected: { projectId: null, runId: null },
        });
      }
      return;
    }

    if (parsed.pathname === "/api/share") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        jsonResponse(response, 405, safeError("method_not_allowed"));
        return;
      }
      try {
        const format = parsed.searchParams.get("format") || "json";
        const runId = parsed.searchParams.get("runId");
        const selection = await resolveHubSelection(parsed);
        if (!selection.service) {
          jsonResponse(response, selection.invalidProject || selection.invalidRun ? 404 : 200, safeError("share_unavailable"));
          return;
        }
        const result = await selection.service.getShare({ format, runId: runId || null });
        if (format === "markdown" || format === "readme") textResponse(response, 200, result, "text/markdown; charset=utf-8");
        else jsonResponse(response, 200, result);
      } catch (error) {
        const failure = boundedError(error, "share_unavailable");
        jsonResponse(response, failure.status, failure.body);
      }
      return;
    }

    if (parsed.pathname === "/api/continuation/plan") {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        jsonResponse(response, 405, safeError("method_not_allowed"));
        return;
      }
      if (!requestHasSameOrigin(request, server)) {
        jsonResponse(response, 403, safeError("forbidden_authority"));
        return;
      }
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        jsonResponse(response, 415, safeError("json_required"));
        return;
      }
      try {
        const body = await readJsonBody(request, maxJsonBytes);
        const command = body.command && typeof body.command === "object" && !Array.isArray(body.command)
          ? commandFromEnvelope(body)
          : body;
        const plan = await service.planContinuation(command, { nowMs: Date.now() });
        jsonResponse(response, 200, { status: "planned", executionAllowed: false, mutationAllowed: false, plan });
      } catch (error) {
        const failure = boundedError(error, "continuation_plan_unavailable");
        jsonResponse(response, failure.status, failure.body);
      }
      return;
    }

    if (parsed.pathname === "/api/commands") {
      if (!enableControl) {
        jsonResponse(response, 404, safeError("control_disabled"));
        return;
      }
      if (!exposure.enabled) {
        jsonResponse(response, 503, { status: "plan_only", executionAllowed: false, mutationAllowed: false, error: "control_capability_unavailable" });
        return;
      }
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        jsonResponse(response, 405, safeError("method_not_allowed"));
        return;
      }
      if (!requestHasSameOrigin(request, server)) {
        jsonResponse(response, 403, safeError("forbidden_authority"));
        return;
      }
      if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
        jsonResponse(response, 415, safeError("json_required"));
        return;
      }
      if (request.headers[CONTROL_HEADER] !== controlToken) {
        jsonResponse(response, 403, safeError("control_token_required"));
        return;
      }
      try {
        const body = await readJsonBody(request, maxJsonBytes);
        const nowMs = Date.now();
        const command = await resolveCommandBody(body, { service, exposure, nowMs });
        const plan = await service.planContinuation(command, { nowMs });
        const result = await service.executeContinuation(plan, { nowMs });
        if (result?.status !== "adapter_invoked") {
          jsonResponse(response, 503, { ...(result ?? {}), status: result?.status || "adapter_failed", adapterInvocationObserved: result?.adapterInvocationObserved === true, effectState: result?.effectState || "in_doubt", completionVerified: false });
          return;
        }
        jsonResponse(response, 200, { status: "adapter_invoked", adapterInvocationObserved: true, effectState: "in_doubt", completionVerified: false, result });
      } catch (error) {
        const failure = boundedError(error, "control_unavailable");
        jsonResponse(response, failure.status, failure.body);
      }
      return;
    }

    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      jsonResponse(response, 405, safeError("method_not_allowed"));
      return;
    }

    if (parsed.pathname === "/api/snapshot") {
      try {
        const selection = await resolveHubSelection(parsed);
        if (!selection.service) {
          if (selection.invalidProject || selection.invalidRun) {
            jsonResponse(response, 404, safeError("selection_not_found"));
          } else {
            jsonResponse(response, 200, withoutControlProjection(await service.getSnapshot()));
          }
          return;
        }
        jsonResponse(response, 200, withoutControlProjection(await selection.service.getSnapshot(selection.runId)));
      } catch {
        jsonResponse(response, 200, withoutControlProjection(await service.getSnapshot().catch(() => ({ error: "snapshot_unavailable" }))));
      }
      return;
    }

    if (parsed.pathname === "/api/replay") {
      const rawRunId = parsed.searchParams.get("runId");
      if (!rawRunId || !isLiveRunId(rawRunId)) {
        jsonResponse(response, 400, safeError("invalid_run_id"));
        return;
      }
      try {
        const selection = await resolveHubSelection(parsed);
        if (!selection.service) {
          jsonResponse(response, selection.invalidProject || selection.invalidRun ? 404 : 200, {
            schemaVersion: LIVE_REPLAY_SCHEMA_VERSION,
            runId: rawRunId,
            replay: [],
            source: { kind: "empty", observedAt: new Date().toISOString(), stale: true },
            permissions: { projectionOnly: true, executionAllowed: false, mutationAllowed: false },
          });
          return;
        }
        jsonResponse(response, 200, await selection.service.getReplay(rawRunId));
      } catch {
        jsonResponse(response, 200, {
          schemaVersion: LIVE_REPLAY_SCHEMA_VERSION,
          runId: rawRunId,
          replay: [],
          source: { kind: "empty", observedAt: new Date().toISOString(), stale: true },
          permissions: { projectionOnly: true, executionAllowed: false, mutationAllowed: false },
        });
      }
      return;
    }

    if (parsed.pathname === "/api/events") {
      const selection = await resolveHubSelection(parsed);
      if (!selection.service) {
        jsonResponse(response, selection.invalidProject || selection.invalidRun ? 404 : 200, safeError("selection_unavailable"));
        return;
      }
      securityHeaders(response);
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("cache-control", "no-cache, no-store");
      response.setHeader("connection", "keep-alive");
      response.setHeader("x-content-type-options", "nosniff");
      response.flushHeaders?.();
      const clientSelection = {
        service: selection.service,
        runId: selection.runId,
        lastSnapshotKey: null,
      };
      clients.set(response, clientSelection);
      request.once("close", () => {
        clients.delete(response);
        stopObserverWhenIdle();
      });
      const snapshot = withoutControlProjection(await selection.service.getSnapshot(selection.runId).catch(() => null));
      if (!response.writableEnded && snapshot) {
        clientSelection.lastSnapshotKey = semanticSnapshotKey(snapshot);
        response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      }
      ensureObserver();
      return;
    }

    if (parsed.pathname === "/assets/meta-kim-k-mark.png") {
      binaryResponse(response, 200, BRAND_MARK_PNG, "image/png");
      return;
    }
    if (parsed.pathname === "/" || parsed.pathname === "/index.html") {
      if (parsed.searchParams.get("demo") === "states") {
        const body = renderLiveControlRoomPage({
          snapshot: null,
          catalog: null,
          controlEnabled: false,
          commandCapabilities: {},
          controlHeader: null,
          controlToken: null,
        });
        textResponse(response, 200, body, "text/html; charset=utf-8");
        return;
      }
      const selection = await resolveHubSelection(parsed);
      const snapshot = withoutControlProjection(await (selection.service || service)
        .getSnapshot(selection.runId)
        .catch(() => null));
      const body = renderLiveControlRoomPage({
        snapshot: withoutControlProjection(snapshot),
        catalog: selection.catalog || null,
        controlEnabled: exposure.enabled,
        commandCapabilities: exposure.capabilities,
        controlHeader: exposure.enabled ? CONTROL_HEADER : null,
        controlToken: exposure.enabled ? controlToken : null,
      });
      textResponse(response, 200, body, "text/html; charset=utf-8");
      return;
    }

    // Only the root frontend and exact bundled UI assets are public.
    // This keeps arbitrary project files and path traversal out of the
    // sidecar's response surface.
    jsonResponse(response, 404, safeError("not_found"));
  });

  const start = async () => {
    if (closed) throw new Error("Live control-room server is closed.");
    if (listening) return listening;
    listening = await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : requestedPort;
        resolve({
          host: LOOPBACK_HOST,
          port,
          url: `http://${LOOPBACK_HOST}:${port}`,
          readOnly: !exposure.enabled,
          controlEnabled: exposure.enabled,
          controlHeader: exposure.enabled ? CONTROL_HEADER : null,
          controlCapabilities: exposure.capabilities,
          controlRisk: exposure.enabled
            ? "explicit_control_enabled; adapter_and_authority_checks_required"
            : enableControl
              ? "control_requested_but_unavailable; fail_closed"
              : "read_only_default",
        });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(requestedPort, LOOPBACK_HOST);
    });
    heartbeat = setInterval(() => {
      for (const client of clients.keys()) {
        if (client.destroyed || client.writableEnded) continue;
        try {
          client.write(": keep-alive\n\n");
        } catch {
          clients.delete(client);
        }
      }
    }, heartbeatIntervalMs);
    heartbeat.unref?.();
    return listening;
  };

  const close = async () => {
    if (closePromise) return closePromise;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (observer) clearInterval(observer);
    observer = null;
    for (const client of clients.keys()) {
      try {
        client.end();
      } catch {
        // The client may already have disconnected.
      }
    }
    clients.clear();
    closePromise = new Promise((resolve) => {
      if (!server.listening) {
        listening = null;
        resolve();
        return;
      }
      server.close(() => {
        listening = null;
        resolve();
      });
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
    return closePromise;
  };

  return {
    server,
    service,
    start,
    close,
    enableControl,
    controlEnabled: enableControl,
    controlHeader: CONTROL_HEADER,
    get controlToken() {
      return controlToken;
    },
    get address() {
      return listening;
    },
  };
}

export const createLiveServer = createLiveControlRoomServer;
export const startLiveControlRoom = async (options = {}) => {
  const controller = createLiveControlRoomServer(options);
  const address = await controller.start();
  return { ...controller, ...address, controller };
};

export { LOOPBACK_HOST };
export { CONTROL_HEADER };
