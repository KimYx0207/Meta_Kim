import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import process from "node:process";
import { connect as tlsConnect } from "node:tls";
import { resolveTrustedWindowsSystemTool } from "./mcp-memory-process-control.mjs";

export const DEFAULT_RELEASE_METADATA_TIMEOUT_MS = 30_000;
export const DEFAULT_RELEASE_ASSET_TIMEOUT_MS = 120_000;
export const DEFAULT_GLOBAL_CHECK_TIMEOUT_MS = 300_000;
export const DEFAULT_RELEASE_PROXY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const WININET_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function resolveTimeoutMs(value, fallback, label) {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw codedError("release_timeout_invalid", `${label} must be a positive integer`);
  }
  return resolved;
}

function credentialFreeCommandEnvironment(environment) {
  const clean = {};
  for (const key of ["SystemRoot", "WINDIR", "Path", "PATH", "PATHEXT", "ComSpec"]) {
    if (typeof environment?.[key] === "string" && environment[key]) clean[key] = environment[key];
  }
  return clean;
}

function proxyInvalid() {
  return codedError(
    "release_proxy_invalid",
    "Windows proxy must be a credential-free http or https host and port",
  );
}

function parseProxyEndpoint(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw || /[\s\r\n]/u.test(raw) || raw.includes("@")) throw proxyInvalid();
  const candidate = raw.includes("://") ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw proxyInvalid();
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  ) {
    throw proxyInvalid();
  }
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw proxyInvalid();
  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port,
  };
}

function commandText(output) {
  if (Buffer.isBuffer(output)) {
    if (output.includes(0)) return output.toString("utf16le");
    return output.toString("utf8");
  }
  return String(output ?? "");
}

function parseRegValueOutput(output, valueName) {
  const escapedName = String(valueName).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = commandText(output).match(
    new RegExp(`^[\\t ]*${escapedName}[\\t ]+REG_[^\\s]+[\\t ]+([^\\r\\n]*?)[\\t ]*$`, "imu"),
  );
  return match?.[1]?.trim() ?? null;
}

function parseRegDword(output, valueName) {
  const value = parseRegValueOutput(output, valueName);
  if (value == null) return null;
  if (/^(?:0x0+|0+)$/iu.test(value)) return false;
  if (/^(?:0x1|1)$/iu.test(value)) return true;
  return null;
}

function normalizeBypassPatterns(value) {
  return String(value ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !/^(?:\(none\)|none)$/iu.test(entry))
    .slice(0, 128);
}

export function parseWindowsInternetSettingsOutput(output) {
  const enabled = parseRegDword(output, "ProxyEnable");
  if (enabled !== true) return null;
  const rawProxy = parseRegValueOutput(output, "ProxyServer");
  if (!rawProxy) throw proxyInvalid();
  return {
    proxy: parseProxyValue(rawProxy),
    bypass: normalizeBypassPatterns(parseRegValueOutput(output, "ProxyOverride")),
  };
}

function parseProxyValue(value) {
  const entries = String(value ?? "").split(";").map((entry) => entry.trim()).filter(Boolean);
  const mapped = new Map();
  const unqualified = [];
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator > 0) {
      mapped.set(entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim());
    } else {
      unqualified.push(entry);
    }
  }
  const selected = mapped.get("https") || mapped.get("http") || unqualified[0];
  if (!selected) throw proxyInvalid();
  return parseProxyEndpoint(selected);
}

export function parseWindowsSystemProxyOutput(output) {
  const text = commandText(output);
  const line = text
    .split(/\r?\n/u)
    .find((candidate) => /^\s*Proxy Server(?:\(s\))?\s*:/iu.test(candidate));
  if (!line) return null;
  const value = line.replace(/^\s*Proxy Server(?:\(s\))?\s*:\s*/iu, "").trim();
  if (!value || /^(?:direct access|none)\b/iu.test(value)) return null;

  return parseProxyValue(value);
}

function parseWindowsBypassList(output) {
  const line = commandText(output)
    .split(/\r?\n/u)
    .find((candidate) => /^\s*Bypass List\s*:/iu.test(candidate));
  return normalizeBypassPatterns(line?.replace(/^\s*Bypass List\s*:\s*/iu, ""));
}

function runWindowsCommand(runCommand, command, args, environment, timeoutMs) {
  try {
    return runCommand(command, args, {
      encoding: "utf8",
      env: credentialFreeCommandEnvironment(environment),
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

function commandSucceeded(result) {
  return result && result.status === 0 && !result.error;
}

function readWindowsInternetProxy({ runCommand, resolveSystemTool, environment, timeoutMs }) {
  const executable = resolveSystemTool(["reg.exe"]);
  if (!executable) return { state: "unavailable" };
  const query = (valueName) => runWindowsCommand(
    runCommand,
    executable,
    ["query", WININET_KEY, "/v", valueName],
    environment,
    timeoutMs,
  );
  const enableResult = query("ProxyEnable");
  if (!commandSucceeded(enableResult)) return { state: "unavailable" };
  const enabled = parseRegDword(enableResult.stdout, "ProxyEnable");
  if (enabled === false) return { state: "disabled" };
  if (enabled !== true) return { state: "unavailable" };

  const proxyResult = query("ProxyServer");
  if (!commandSucceeded(proxyResult)) return { state: "unavailable" };
  let proxy;
  try {
    const rawProxy = parseRegValueOutput(proxyResult.stdout, "ProxyServer");
    if (!rawProxy) return { state: "unavailable" };
    proxy = parseProxyValue(rawProxy);
  } catch {
    return { state: "unavailable" };
  }

  const overrideResult = query("ProxyOverride");
  const bypass = commandSucceeded(overrideResult)
    ? normalizeBypassPatterns(parseRegValueOutput(overrideResult.stdout, "ProxyOverride"))
    : [];
  return { state: "configured", proxy, bypass };
}

function readWindowsWinHttpProxy({ runCommand, resolveSystemTool, environment, timeoutMs }) {
  const executable = resolveSystemTool(["netsh.exe"]);
  if (!executable) return null;
  const result = runWindowsCommand(
    runCommand,
    executable,
    ["winhttp", "show", "proxy"],
    environment,
    timeoutMs,
  );
  if (!commandSucceeded(result)) return null;
  try {
    const proxy = parseWindowsSystemProxyOutput(result.stdout);
    return proxy ? { proxy, bypass: parseWindowsBypassList(result.stdout) } : null;
  } catch {
    return null;
  }
}

function attachProxyMetadata(proxy, source, bypass) {
  const result = { ...proxy };
  Object.defineProperties(result, {
    bypass: { value: Object.freeze([...bypass]), enumerable: false },
    source: { value: source, enumerable: false },
  });
  return Object.freeze(result);
}

export function readWindowsSystemProxy({
  platform = process.platform,
  environment = process.env,
  runCommand = spawnSync,
  resolveSystemTool = resolveTrustedWindowsSystemTool,
  proxyTimeoutMs = DEFAULT_RELEASE_PROXY_TIMEOUT_MS,
} = {}) {
  if (platform !== "win32") return null;
  let timeoutMs;
  try {
    timeoutMs = resolveTimeoutMs(proxyTimeoutMs, DEFAULT_RELEASE_PROXY_TIMEOUT_MS, "Windows proxy timeout");
  } catch {
    return null;
  }

  if (typeof resolveSystemTool !== "function") return null;
  let winInet;
  try {
    winInet = readWindowsInternetProxy({ runCommand, resolveSystemTool, environment, timeoutMs });
  } catch {
    return null;
  }
  if (winInet.state === "disabled") return null;
  if (winInet.state === "configured") {
    return attachProxyMetadata(winInet.proxy, "windows_wininet", winInet.bypass);
  }

  let winHttp;
  try {
    winHttp = readWindowsWinHttpProxy({ runCommand, resolveSystemTool, environment, timeoutMs });
  } catch {
    return null;
  }
  return winHttp
    ? attachProxyMetadata(winHttp.proxy, "windows_winhttp", winHttp.bypass)
    : null;
}

function createTimeoutController(timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutError = codedError("release_network_timeout", "release network request timed out");
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  let timeoutPromiseSettled = false;
  const rejectTimeoutOnce = (error) => {
    if (timeoutPromiseSettled) return;
    timeoutPromiseSettled = true;
    rejectTimeout(error);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
    rejectTimeoutOnce(timeoutError);
  }, timeoutMs);
  const abort = () => {
    const reason = parentSignal?.reason;
    const abortError = reason?.code
      ? reason
      : codedError("release_network_aborted", "release network request was aborted");
    controller.abort(reason);
    rejectTimeoutOnce(abortError);
  };
  if (parentSignal) {
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    timeoutPromise,
    didTimeout: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    },
  };
}

function responseFromNode(statusCode, headers, body) {
  const normalizedHeaders = new Map(
    Object.entries(headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(", ") : String(value ?? ""),
    ]),
  );
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) ?? null;
      },
    },
    async json() {
      return JSON.parse(body.toString("utf8"));
    },
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
  };
}

function redirectedHeaders(headers, from, to) {
  if (from.origin === to.origin) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) =>
      !["authorization", "cookie", "proxy-authorization"].includes(key.toLowerCase())),
  );
}

function destroyResource(resource, destroyed) {
  if (!resource || destroyed.has(resource)) return;
  destroyed.add(resource);
  try {
    resource.destroy?.();
  } catch {
    // A best-effort destroy must not hide the original network failure.
  }
}

function armTimer(timeoutMs, onTimeout) {
  const timer = setTimeout(onTimeout, timeoutMs);
  return () => clearTimeout(timer);
}

function requestThroughProxy(target, proxy, headers, {
  onResponse,
  onError,
  timeoutMs,
  httpRequestImpl,
  httpsRequestImpl,
  tlsConnectImpl,
}) {
  const proxyRequestImpl = proxy.protocol === "https:" ? httpsRequestImpl : httpRequestImpl;
  let proxyRequest;
  let targetRequest;
  let connectResponse;
  let tunnelSocket;
  let secureSocket;
  let phaseCleanup;
  let disposed = false;
  const destroyed = new Set();
  const clearPhase = () => {
    phaseCleanup?.();
    phaseCleanup = null;
  };
  const armPhase = (label) => {
    clearPhase();
    phaseCleanup = armTimer(timeoutMs, () => onError(
      codedError("release_network_timeout", `release ${label} phase timed out`),
    ));
  };
  const handleResponse = (response) => {
    clearPhase();
    onResponse(response);
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearPhase();
    destroyResource(targetRequest, destroyed);
    destroyResource(secureSocket, destroyed);
    destroyResource(tunnelSocket, destroyed);
    destroyResource(proxyRequest, destroyed);
    if (connectResponse && typeof connectResponse.resume === "function") {
      try {
        connectResponse.resume();
      } catch {
        // The socket destroy below is the authoritative cleanup path.
      }
    }
  };

  try {
    proxyRequest = proxyRequestImpl({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: proxy.port,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: { Host: `${target.hostname}:${target.port || 443}` },
      ...(proxy.protocol === "https:" ? { servername: proxy.hostname } : {}),
    });
    proxyRequest.once("error", onError);
    proxyRequest.once("connect", (response, socket, head) => {
      connectResponse = response;
      tunnelSocket = socket;
      if (head?.length && typeof socket?.unshift === "function") socket.unshift(head);
      if (response?.statusCode !== 200) {
        response?.resume?.();
        destroyResource(socket, destroyed);
        onError(codedError("release_proxy_failed", "Windows proxy rejected the release connection"));
        return;
      }
      clearPhase();
      try {
        secureSocket = tlsConnectImpl({
          socket,
          servername: target.hostname,
        });
        if (!secureSocket) throw codedError("release_tls_failed", "TLS connection could not be created");
        secureSocket.once("error", onError);
        secureSocket.once("secureConnect", () => {
          clearPhase();
          try {
            targetRequest = httpsRequestImpl({
              protocol: "https:",
              hostname: target.hostname,
              port: target.port || 443,
              path: `${target.pathname}${target.search}`,
              method: "GET",
              headers: { ...headers, Host: target.host },
              createConnection: () => secureSocket,
              agent: false,
              servername: target.hostname,
            }, handleResponse);
            targetRequest.once("error", onError);
            armPhase("response");
            targetRequest.end();
          } catch (error) {
            onError(error);
          }
        });
        armPhase("TLS");
      } catch (error) {
        onError(error);
      }
    });
    armPhase("CONNECT");
    proxyRequest.end();
  } catch (error) {
    cleanup();
    onError(error);
  }

  return { request: proxyRequest, cleanup };
}

async function fetchThroughFetch(url, {
  fetchImpl,
  headers = {},
  signal,
  redirectCount = 0,
} = {}) {
  const target = new URL(url);
  if (target.protocol !== "https:") {
    throw codedError("release_url_invalid", "release network URLs must use HTTPS");
  }
  if (redirectCount > MAX_REDIRECTS) {
    throw codedError("release_redirects_exceeded", "release network redirect limit exceeded");
  }
  const response = await fetchImpl(url, {
    headers,
    redirect: "manual",
    signal,
  });
  const location = response?.headers?.get?.("location");
  if (response?.status >= 300 && response?.status < 400 && location) {
    try {
      await response.body?.cancel?.();
    } catch {
      // The next request remains bounded by the same signal.
    }
    const redirectedUrl = new URL(location, target);
    return fetchThroughFetch(redirectedUrl, {
      fetchImpl,
      headers: redirectedHeaders(headers, target, redirectedUrl),
      signal,
      redirectCount: redirectCount + 1,
    });
  }
  return response;
}

async function fetchThroughNode(url, {
  headers = {},
  signal,
  proxy,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  redirectCount = 0,
  proxyConfiguration = null,
  httpRequestImpl = httpRequest,
  httpsRequestImpl = httpsRequest,
  tlsConnectImpl = tlsConnect,
  timeoutMs,
} = {}) {
  const target = new URL(url);
  if (target.protocol !== "https:") {
    throw codedError("release_url_invalid", "release network URLs must use HTTPS");
  }
  if (redirectCount > MAX_REDIRECTS) {
    throw codedError("release_redirects_exceeded", "release network redirect limit exceeded");
  }
  const effectiveProxy = proxyConfiguration ? proxyForUrl(url, proxyConfiguration) : proxy;
  return new Promise((resolve, reject) => {
    let activeRequest;
    let activeResponse;
    let transport;
    let phaseCleanup;
    let responseCleanup;
    let settled = false;
    const destroyed = new Set();
    const clearPhase = () => {
      phaseCleanup?.();
      phaseCleanup = null;
    };
    const clearResponse = () => {
      responseCleanup?.();
      responseCleanup = null;
    };
    const cleanup = ({ destroyResponse = false } = {}) => {
      clearPhase();
      clearResponse();
      signal?.removeEventListener("abort", abort);
      transport?.cleanup();
      destroyResource(activeRequest, destroyed);
      if (destroyResponse) destroyResource(activeResponse, destroyed);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup({ destroyResponse: true });
      reject(error);
    };
    const abort = () => {
      const reason = signal?.reason;
      fail(reason?.code === "release_network_timeout"
        ? reason
        : codedError("release_network_aborted", "release network request was aborted"));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      cleanup();
      resolve(value);
    };
    const armResponseTimeout = (response) => {
      clearResponse();
      let timer;
      let closed = false;
      const reset = () => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(
          codedError("release_network_timeout", "release response phase timed out"),
        ), timeoutMs);
      };
      const done = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        response.removeListener?.("data", reset);
        response.removeListener?.("end", done);
        response.removeListener?.("close", done);
        responseCleanup = null;
      };
      responseCleanup = done;
      response.on?.("data", reset);
      response.once?.("end", done);
      response.once?.("close", done);
      reset();
    };
    const onResponse = (response) => {
      clearPhase();
      activeResponse = response;
      armResponseTimeout(response);
      const location = response.headers?.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume?.();
        response.once("end", () => {
          clearResponse();
          cleanup();
          try {
            const redirectedUrl = new URL(location, target);
            fetchThroughNode(redirectedUrl, {
              headers: redirectedHeaders(headers, target, redirectedUrl),
              signal,
              proxy: proxyConfiguration ? proxyForUrl(redirectedUrl, proxyConfiguration) : proxy,
              proxyConfiguration,
              maxResponseBytes,
              redirectCount: redirectCount + 1,
              httpRequestImpl,
              httpsRequestImpl,
              tlsConnectImpl,
              timeoutMs,
            }).then(finish, fail);
          } catch (error) {
            fail(error);
          }
        });
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          fail(codedError("release_response_too_large", "release network response exceeds the allowed size"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", fail);
      response.on("aborted", () => fail(
        codedError("release_response_aborted", "release network response was aborted"),
      ));
      response.on("end", () => finish(responseFromNode(
        response.statusCode ?? 0,
        response.headers,
        Buffer.concat(chunks),
      )));
    };
    const armDirectPhase = () => {
      clearPhase();
      phaseCleanup = armTimer(timeoutMs, () => fail(
        codedError("release_network_timeout", "release TLS or response phase timed out"),
      ));
    };
    try {
      if (effectiveProxy) {
        transport = requestThroughProxy(target, effectiveProxy, headers, {
          onResponse,
          onError: fail,
          timeoutMs,
          httpRequestImpl,
          httpsRequestImpl,
          tlsConnectImpl,
        });
        activeRequest = transport.request;
      } else {
        activeRequest = httpsRequestImpl({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: "GET",
          headers,
          servername: target.hostname,
        }, onResponse);
        activeRequest.once("error", fail);
        armDirectPhase();
        activeRequest.end?.();
      }
    } catch (error) {
      fail(error);
    }
  });
}

function normalizeProxyConfiguration(value) {
  if (!value) return null;
  const proxy = value.proxy && typeof value.proxy === "object" ? value.proxy : value;
  if (!proxy || !["http:", "https:"].includes(proxy.protocol) || !proxy.hostname) return null;
  const port = Number(proxy.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) return null;
  return {
    proxy: { protocol: proxy.protocol, hostname: proxy.hostname, port },
    bypass: Array.isArray(value.bypass)
      ? value.bypass
      : Array.isArray(value.proxyOverride)
        ? value.proxyOverride
        : [],
    source: value.source || "windows_winhttp",
  };
}

function isLocalHost(hostname) {
  const host = String(hostname ?? "").replace(/^\[|\]$/gu, "").toLowerCase();
  return host === "localhost" ||
    host === "localhost.localdomain" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(host);
}

function splitBypassPattern(pattern) {
  const raw = String(pattern ?? "").trim();
  if (!raw || raw.includes("@") || /[\s\r\n]/u.test(raw)) return null;
  if (/^https?:\/\//iu.test(raw)) {
    try {
      const parsed = new URL(raw);
      return { host: parsed.hostname, port: parsed.port ? Number(parsed.port) : null };
    } catch {
      return null;
    }
  }
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0) return null;
    const port = raw.slice(end + 1).match(/^:(\d+)$/u)?.[1] ?? null;
    return { host: raw.slice(1, end), port: port == null ? null : Number(port) };
  }
  const portMatch = raw.match(/^(.*):(\d+)$/u);
  return portMatch
    ? { host: portMatch[1], port: Number(portMatch[2]) }
    : { host: raw, port: null };
}

function wildcardMatch(value, pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  const expression = `^${escaped.replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`;
  return new RegExp(expression, "iu").test(value);
}

function bypassesProxy(target, patterns) {
  const targetHost = target.hostname.replace(/^\[|\]$/gu, "");
  const targetPort = Number(target.port || 443);
  return patterns.some((pattern) => {
    if (String(pattern).trim().toLowerCase() === "<local>") return isLocalHost(targetHost) || !targetHost.includes(".");
    const parsed = splitBypassPattern(pattern);
    if (!parsed || (parsed.port != null && parsed.port !== targetPort)) return false;
    return wildcardMatch(targetHost, parsed.host);
  });
}

function proxyForUrl(url, proxyConfiguration) {
  if (!proxyConfiguration) return null;
  const target = new URL(url);
  return bypassesProxy(target, proxyConfiguration.bypass) ? null : proxyConfiguration.proxy;
}

export function createReleaseNetworkClient({
  fetchImpl = null,
  environment = process.env,
  platform = process.platform,
  systemProxyReader = readWindowsSystemProxy,
  resolveSystemTool = resolveTrustedWindowsSystemTool,
  httpRequestImpl = httpRequest,
  httpsRequestImpl = httpsRequest,
  tlsConnectImpl = tlsConnect,
} = {}) {
  let proxyConfiguration = null;
  if (typeof fetchImpl !== "function" && platform === "win32") {
    try {
      proxyConfiguration = normalizeProxyConfiguration(systemProxyReader({
        platform,
        environment,
        resolveSystemTool,
      }));
    } catch {
      proxyConfiguration = null;
    }
  }
  const request = async (url, {
    headers = {},
    timeoutMs,
    signal: parentSignal,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = {}) => {
    const timeout = resolveTimeoutMs(timeoutMs, DEFAULT_RELEASE_METADATA_TIMEOUT_MS, "release network timeout");
    const timeoutController = createTimeoutController(timeout, parentSignal);
    try {
      const proxy = typeof fetchImpl === "function" ? null : proxyForUrl(url, proxyConfiguration);
      const operation = typeof fetchImpl === "function"
        ? fetchThroughFetch(url, {
          fetchImpl,
          headers,
          signal: timeoutController.signal,
        })
        : proxyConfiguration
          ? fetchThroughNode(url, {
            headers,
            signal: timeoutController.signal,
            proxy,
            proxyConfiguration,
            maxResponseBytes,
            httpRequestImpl,
            httpsRequestImpl,
            tlsConnectImpl,
            timeoutMs: timeout,
          })
          : fetchThroughFetch(url, {
            fetchImpl: globalThis.fetch,
            headers,
            signal: timeoutController.signal,
          });
      return await Promise.race([operation, timeoutController.timeoutPromise]);
    } catch (error) {
      if (timeoutController.didTimeout()) {
        throw codedError("release_network_timeout", "release network request timed out");
      }
      throw error;
    } finally {
      timeoutController.cleanup();
    }
  };
  return Object.freeze({
    request,
    proxyMode: proxyConfiguration?.source || "direct",
  });
}
