import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import process from "node:process";

export const DEFAULT_RELEASE_METADATA_TIMEOUT_MS = 30_000;
export const DEFAULT_RELEASE_ASSET_TIMEOUT_MS = 120_000;
export const DEFAULT_GLOBAL_CHECK_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;

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
    "Windows WinHTTP proxy must be a credential-free host and port",
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

export function parseWindowsSystemProxyOutput(output) {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : String(output ?? "");
  const line = text
    .split(/\r?\n/u)
    .find((candidate) => /^\s*Proxy Server(?:\(s\))?\s*:/iu.test(candidate));
  if (!line) return null;
  const value = line.replace(/^\s*Proxy Server(?:\(s\))?\s*:\s*/iu, "").trim();
  if (!value || /^(?:direct access|none)\b/iu.test(value)) return null;

  const entries = value.split(";").map((entry) => entry.trim()).filter(Boolean);
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
  return selected ? parseProxyEndpoint(selected) : null;
}

export function readWindowsSystemProxy({
  platform = process.platform,
  environment = process.env,
  runCommand = spawnSync,
} = {}) {
  if (platform !== "win32") return null;
  const systemRoot = environment?.SystemRoot || environment?.WINDIR || "C:\\Windows";
  const netsh = path.join(systemRoot, "System32", "netsh.exe");
  const result = runCommand(netsh, ["winhttp", "show", "proxy"], {
    encoding: "utf8",
    windowsHide: true,
    env: credentialFreeCommandEnvironment(environment),
  });
  if (result?.status !== 0) {
    throw codedError("release_proxy_unavailable", "Windows WinHTTP proxy settings could not be read");
  }
  return parseWindowsSystemProxyOutput(result.stdout);
}

function createTimeoutController(timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutError = codedError("release_network_timeout", "release network request timed out");
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
    rejectTimeout(timeoutError);
  }, timeoutMs);
  const abort = () => controller.abort(parentSignal?.reason);
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

function requestThroughProxy(target, proxy, headers, onResponse, onError) {
  const proxyRequest = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({
    protocol: proxy.protocol,
    hostname: proxy.hostname,
    port: proxy.port,
    method: "CONNECT",
    path: `${target.hostname}:${target.port || 443}`,
    headers: { Host: `${target.hostname}:${target.port || 443}` },
  });
  proxyRequest.once("connect", (connectResponse, socket) => {
    if (connectResponse.statusCode !== 200) {
      connectResponse.resume();
      onError(codedError("release_proxy_failed", "Windows WinHTTP proxy rejected the release connection"));
      socket.destroy();
      return;
    }
    const targetRequest = httpsRequest({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: { ...headers, Host: target.host },
      createConnection: () => socket,
      agent: false,
      servername: target.hostname,
    }, onResponse);
    targetRequest.once("error", onError);
    targetRequest.end();
  });
  proxyRequest.once("error", onError);
  proxyRequest.end();
  return proxyRequest;
}

async function fetchThroughNode(url, {
  headers = {},
  signal,
  proxy,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  redirectCount = 0,
} = {}) {
  const target = new URL(url);
  if (target.protocol !== "https:") {
    throw codedError("release_url_invalid", "release network URLs must use HTTPS");
  }
  if (redirectCount > MAX_REDIRECTS) {
    throw codedError("release_redirects_exceeded", "release network redirect limit exceeded");
  }
  return new Promise((resolve, reject) => {
    let activeRequest;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      activeRequest?.destroy();
      reject(error);
    };
    const abort = () => fail(codedError("release_network_aborted", "release network request was aborted"));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const onResponse = (response) => {
      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && location) {
        response.resume();
        const redirectedUrl = new URL(location, target);
        fetchThroughNode(redirectedUrl, {
          headers: redirectedHeaders(headers, target, redirectedUrl),
          signal,
          proxy,
          maxResponseBytes,
          redirectCount: redirectCount + 1,
        }).then(finish, fail);
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
      response.on("end", () => finish(responseFromNode(
        response.statusCode ?? 0,
        response.headers,
        Buffer.concat(chunks),
      )));
    };
    try {
      activeRequest = proxy
        ? requestThroughProxy(target, proxy, headers, onResponse, fail)
        : httpsRequest({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: "GET",
          headers,
          servername: target.hostname,
        }, onResponse);
      activeRequest.once("error", fail);
      if (!proxy) activeRequest.end?.();
    } catch (error) {
      fail(error);
    }
  });
}

export function createReleaseNetworkClient({
  fetchImpl = null,
  environment = process.env,
  platform = process.platform,
  systemProxyReader = readWindowsSystemProxy,
} = {}) {
  const proxy = typeof fetchImpl === "function"
    ? null
    : platform === "win32"
      ? systemProxyReader({ platform, environment })
      : null;
  const request = async (url, {
    headers = {},
    timeoutMs,
    signal: parentSignal,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  } = {}) => {
    const timeout = resolveTimeoutMs(timeoutMs, DEFAULT_RELEASE_METADATA_TIMEOUT_MS, "release network timeout");
    const timeoutController = createTimeoutController(timeout, parentSignal);
    try {
      const operation = typeof fetchImpl === "function"
        ? fetchImpl(url, { headers, signal: timeoutController.signal })
        : proxy
          ? fetchThroughNode(url, {
            headers,
            signal: timeoutController.signal,
            proxy,
            maxResponseBytes,
          })
          : globalThis.fetch(url, {
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
    proxyMode: proxy ? "windows_winhttp" : "direct",
  });
}
