import { createServer } from "node:http";
import { URL } from "node:url";
import { randomBytes } from "node:crypto";

import { createLiveControlRoomService } from "../../application/live/live-control-room-service.mjs";
import { isLiveRunId } from "./live-read-repository.mjs";
import { renderLiveControlRoomPage } from "../../presentation/live/live-control-room-page.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 0;
const CONTROL_HEADER = "x-meta-kim-control-token";
const DEFAULT_MAX_JSON_BYTES = 256 * 1024;
const CONTROL_ACTIONS = Object.freeze(["pause", "resume", "reassign", "handoff"]);

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
  const service = options.service || createLiveControlRoomService(options);
  const requestedPort = Number.isInteger(options.port) && options.port >= 0 ? options.port : DEFAULT_PORT;
  const requestedHost = options.host;
  if (!loopbackOnly(requestedHost)) {
    throw new TypeError("Live sidecar accepts loopback host only.");
  }
  const enableControl = options.enableControl === true;
  const exposure = controlExposure(options, enableControl);
  const controlToken = enableControl
    ? (typeof options.controlToken === "string" && options.controlToken.length >= 16
      ? options.controlToken
      : randomBytes(32).toString("base64url"))
    : null;
  const maxJsonBytes = Number.isSafeInteger(options.maxJsonBytes) && options.maxJsonBytes >= 1 && options.maxJsonBytes <= 1_048_576
    ? options.maxJsonBytes
    : DEFAULT_MAX_JSON_BYTES;

  const clients = new Set();
  let listening = null;
  let closePromise = null;
  let closed = false;
  let heartbeat = null;
  let observer = null;
  let observerBusy = false;
  let lastSnapshotKey = null;
  const pollIntervalMs = Number.isInteger(options.pollIntervalMs) && options.pollIntervalMs >= 10
    ? options.pollIntervalMs
    : 1_000;

  const stopObserverWhenIdle = () => {
    if (clients.size > 0 || !observer) return;
    clearInterval(observer);
    observer = null;
    lastSnapshotKey = null;
  };

  const publishSnapshotChange = async () => {
    if (observerBusy || clients.size === 0) return;
    observerBusy = true;
    try {
      const snapshot = withoutControlProjection(await service.getSnapshot().catch(() => null));
      if (!snapshot) return;
      const key = semanticSnapshotKey(snapshot);
      if (lastSnapshotKey !== null && key !== lastSnapshotKey) {
        const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
        for (const client of clients) {
          if (!client.writableEnded) client.write(payload);
        }
      }
      lastSnapshotKey = key;
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

    if (parsed.pathname === "/api/share") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        jsonResponse(response, 405, safeError("method_not_allowed"));
        return;
      }
      try {
        const format = parsed.searchParams.get("format") || "json";
        const runId = parsed.searchParams.get("runId");
        const result = await service.getShare({ format, runId: runId || null });
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
        jsonResponse(response, 200, withoutControlProjection(await service.getSnapshot()));
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
        jsonResponse(response, 200, await service.getReplay(rawRunId));
      } catch {
        jsonResponse(response, 200, {
          schemaVersion: "meta-kim-live-replay-v1",
          runId: rawRunId,
          replay: [],
          source: { kind: "empty", observedAt: new Date().toISOString(), stale: true },
          permissions: { projectionOnly: true, executionAllowed: false, mutationAllowed: false },
        });
      }
      return;
    }

    if (parsed.pathname === "/api/events") {
      securityHeaders(response);
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("cache-control", "no-cache, no-store");
      response.setHeader("connection", "keep-alive");
      response.setHeader("x-content-type-options", "nosniff");
      response.flushHeaders?.();
      clients.add(response);
      request.once("close", () => {
        clients.delete(response);
        stopObserverWhenIdle();
      });
      const snapshot = withoutControlProjection(await service.getSnapshot().catch(() => null));
      if (!response.writableEnded && snapshot) {
        if (lastSnapshotKey === null) lastSnapshotKey = semanticSnapshotKey(snapshot);
        response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      }
      ensureObserver();
      return;
    }

    if (parsed.pathname === "/" || parsed.pathname === "/index.html") {
      const snapshot = withoutControlProjection(await service.getSnapshot().catch(() => null));
      const body = renderLiveControlRoomPage({
        snapshot: withoutControlProjection(snapshot),
        controlEnabled: exposure.enabled,
        commandCapabilities: exposure.capabilities,
        controlHeader: exposure.enabled ? CONTROL_HEADER : null,
        controlToken: exposure.enabled ? controlToken : null,
      });
      textResponse(response, 200, body, "text/html; charset=utf-8");
      return;
    }

    // Only the root frontend asset is public. This keeps arbitrary project
    // files and path traversal out of the sidecar's response surface.
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
      for (const client of clients) {
        if (!client.writableEnded) client.write(": keep-alive\n\n");
      }
    }, 25_000);
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
    for (const client of clients) {
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
