import path from "node:path";
import process from "node:process";

const RUNTIMES = new Set(["codex", "claude_code"]);
const SAFE_ENV_KEYS = new Set([
  "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA",
  "USER", "USERNAME", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "CODEX_HOME", "CLAUDE_CONFIG_DIR",
]);
const ABSOLUTE_PATH_ENV_KEYS = new Set([
  "HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
]);
const CLAUDE_IDENTITY_KEYS = new Set([
  "email", "orgId", "orgName", "userId", "accountId", "accountUuid", "organizationId", "organizationName",
]);
const CLAUDE_STATUS_KEYS = new Set([
  "loggedIn", "authMethod", "apiProvider", "subscriptionType", ...CLAUDE_IDENTITY_KEYS,
]);
const MAX_STATUS_BYTES = 16 * 1024;

function fail(code, message) {
  const error = new TypeError(`Native CLI auth: ${message}`);
  error.code = code;
  throw error;
}

function requireRuntime(runtime) {
  if (!RUNTIMES.has(runtime)) {
    fail("NATIVE_CLI_AUTH_RUNTIME_INVALID", "runtime must be codex or claude_code");
  }
}

function absolutePath(value) {
  return path.posix.isAbsolute(value) || /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u.test(value);
}

function safeEnvironmentValue(value, key) {
  if (typeof value !== "string" || value.length > 32_768 || /[\0\r\n]/u.test(value)) {
    fail("NATIVE_CLI_AUTH_ENV_INVALID", `${key} has an invalid environment value`);
  }
  if (ABSOLUTE_PATH_ENV_KEYS.has(key) && (!absolutePath(value) || value !== value.trim())) {
    fail("NATIVE_CLI_AUTH_ENV_INVALID", `${key} must be an unambiguous absolute path`);
  }
  return value;
}

/**
 * Reconstruct the child environment from a closed OS/network allowlist. The
 * official CLI alone owns existing-login discovery and refresh: this module
 * never opens credential files, settings, sessions, tokens, or the keychain.
 * Current official home overrides are inherited, never synthesized or read.
 * Provider/API/token overrides and loader injections cannot cross this boundary,
 * including mixed-case or future provider keys that a denylist would miss.
 * The returned environment is private subprocess input, not evidence to log.
 */
export function buildNativeCliEnvironment(runtime, ambientEnv = process.env) {
  requireRuntime(runtime);
  if (!ambientEnv || typeof ambientEnv !== "object" || Array.isArray(ambientEnv)) {
    fail("NATIVE_CLI_AUTH_ENV_INVALID", "ambient environment must be a record");
  }
  const values = new Map();
  for (const [rawKey, rawValue] of Object.entries(ambientEnv)) {
    const key = rawKey.toUpperCase();
    if (!SAFE_ENV_KEYS.has(key) || rawValue === undefined) continue;
    const value = safeEnvironmentValue(rawValue, key);
    if (values.has(key) && values.get(key) !== value) {
      fail("NATIVE_CLI_AUTH_ENV_INVALID", `${key} has conflicting case variants`);
    }
    values.set(key, value);
  }
  return Object.freeze({ ...Object.fromEntries(values), NO_COLOR: "1" });
}

/** Build status-only argv for a native executable or an already resolved Node shim. */
export function buildNativeCliAuthStatusArgs(runtime, argsPrefix = []) {
  requireRuntime(runtime);
  if (!Array.isArray(argsPrefix) || argsPrefix.length > 1 || argsPrefix.some((value) =>
    typeof value !== "string" || value.length > 32_768 || /[\0\r\n]/u.test(value) ||
    !absolutePath(value) || !/\.(?:cjs|mjs|js)$/iu.test(value))) {
    fail("NATIVE_CLI_AUTH_ARGS_INVALID", "prefix must be empty or one absolute Node shim path");
  }
  return [
    ...argsPrefix,
    ...(runtime === "codex" ? ["login", "status"] : ["auth", "status", "--json"]),
  ];
}

function statusOutput(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.getPrototypeOf(result) !== Object.prototype) {
    fail("NATIVE_CLI_AUTH_STATUS_INVALID", "status result must be a plain record");
  }
  if (result.status !== 0 || (result.error !== undefined && result.error !== null) ||
      (result.signal !== undefined && result.signal !== null) ||
      (result.timedOut !== undefined && result.timedOut !== false) ||
      (result.outputLimitExceeded !== undefined && result.outputLimitExceeded !== false)) {
    fail("NATIVE_CLI_AUTH_COMMAND_FAILED", "official status command did not complete successfully");
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (typeof stdout !== "string" || typeof stderr !== "string" ||
      Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > MAX_STATUS_BYTES ||
      /\0/u.test(stdout) || /\0/u.test(stderr)) {
    fail("NATIVE_CLI_AUTH_STATUS_INVALID", "status output must be bounded text");
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

function parseClaudeStatus(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail("NATIVE_CLI_AUTH_STATUS_INVALID", "Claude status is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype) {
    fail("NATIVE_CLI_AUTH_STATUS_INVALID", "Claude status must be a JSON object");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!CLAUDE_STATUS_KEYS.has(key) || (value !== null && typeof value === "object") ||
        ((CLAUDE_IDENTITY_KEYS.has(key) || key === "subscriptionType") && value !== null && typeof value !== "string")) {
      fail("NATIVE_CLI_AUTH_STATUS_INVALID", "Claude status has an unsupported schema");
    }
  }
  // JSON.parse silently accepts repeated keys. The supported schema is shallow,
  // so each JSON string followed by ':' is a top-level property. Decode escapes
  // before comparison to also reject e.g. loggedIn plus logged\u0049n.
  const keys = new Set();
  for (const match of stdout.matchAll(/"(?:\\.|[^"\\])*"/gu)) {
    if (stdout.slice(match.index + match[0].length).trimStart()[0] !== ":") continue;
    const key = JSON.parse(match[0]);
    if (keys.has(key)) {
      fail("NATIVE_CLI_AUTH_STATUS_INVALID", "Claude status has duplicate fields");
    }
    keys.add(key);
  }
  if (typeof parsed.loggedIn !== "boolean" || typeof parsed.authMethod !== "string" ||
      typeof parsed.apiProvider !== "string") {
    fail("NATIVE_CLI_AUTH_STATUS_INVALID", "Claude status is missing required authentication fields");
  }
  if (parsed.loggedIn !== true || parsed.authMethod !== "oauth_token" || parsed.apiProvider !== "firstParty") {
    fail("NATIVE_CLI_AUTH_NOT_OFFICIAL", "Claude must use an existing first-party OAuth login");
  }
}

/**
 * Consume a spawnCli-compatible status result, without retaining its raw output.
 * This proves only the reported login mode, never subscription, billing mode,
 * model access, or live success. Optional subscription/identity data is discarded.
 * Unknown, ambiguous, API-key, and alternative-provider modes fail closed.
 */
export function parseNativeCliAuthStatus(runtime, result) {
  requireRuntime(runtime);
  const { stdout, stderr } = statusOutput(result);
  if (runtime === "codex") {
    if (Boolean(stdout) === Boolean(stderr) ||
        (stdout || stderr) !== "Logged in using ChatGPT") {
      fail("NATIVE_CLI_AUTH_NOT_OFFICIAL", "Codex must report only an existing ChatGPT login");
    }
  } else {
    if (stderr) {
      fail("NATIVE_CLI_AUTH_STATUS_INVALID", "Claude status has unexpected diagnostic output");
    }
    parseClaudeStatus(stdout);
  }
  return Object.freeze({
    kind: "official_existing_login",
    runtime,
    provider: runtime === "codex" ? "chatgpt" : "firstParty",
  });
}
