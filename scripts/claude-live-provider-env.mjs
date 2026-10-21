import { promises as fs, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PRIVATE_PROVIDER_MAX_BYTES = 16_384;
const PRIVATE_PROVIDER_FIELDS = new Set(["schemaVersion", "providerId", "endpoint", "authType", "credential"]);
const privateProviderError = () => new Error("Invalid private Claude provider handoff");

/** Validates an explicit, run-scoped private handoff. Never formats its values. */
export function validatePrivateClaudeProviderHandoff(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw privateProviderError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== PRIVATE_PROVIDER_FIELDS.size ||
      Reflect.ownKeys(descriptors).some(key => !PRIVATE_PROVIDER_FIELDS.has(key) || !Object.hasOwn(descriptors[key], "value") || typeof descriptors[key].value !== "string")) throw privateProviderError();
  if (value.schemaVersion !== "meta-kim-private-claude-provider-v1" || value.providerId !== "minimax" ||
      value.endpoint !== "https://api.minimaxi.com/anthropic" || !["auth_token", "api_key"].includes(value.authType) ||
      value.credential.length < 1 || value.credential.length > 4096 || !/^[\x21-\x7e]+$/u.test(value.credential)) throw privateProviderError();
  return Object.freeze({ schemaVersion: value.schemaVersion, providerId: value.providerId, endpoint: value.endpoint, authType: value.authType, credential: value.credential });
}

/** Parses only a flat string-valued JSON object, rejecting even escaped duplicate keys. */
export function parsePrivateClaudeProviderHandoff(input) {
  try {
    if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > PRIVATE_PROVIDER_MAX_BYTES) throw privateProviderError();
    const token = /"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/y;
    let offset = 0;
    const whitespace = () => { while (/[\x20\t\r\n]/u.test(input[offset] ?? "")) offset++; };
    const string = () => { token.lastIndex = offset; const match = token.exec(input); if (!match) throw privateProviderError(); offset = token.lastIndex; return JSON.parse(match[0]); };
    const parsed = {};
    whitespace();
    if (input[offset++] !== "{") throw privateProviderError();
    whitespace();
    while (input[offset] !== "}") {
      const key = string();
      if (!PRIVATE_PROVIDER_FIELDS.has(key) || Object.hasOwn(parsed, key)) throw privateProviderError();
      whitespace();
      if (input[offset++] !== ":") throw privateProviderError();
      whitespace();
      parsed[key] = string();
      whitespace();
      if (input[offset] !== ",") break;
      offset++;
      whitespace();
      if (input[offset] === "}") throw privateProviderError();
    }
    if (input[offset++] !== "}") throw privateProviderError();
    whitespace();
    if (offset !== input.length) throw privateProviderError();
    return validatePrivateClaudeProviderHandoff(parsed);
  } catch { throw privateProviderError(); }
}

/** Consumes a bounded private pipe; no private value is logged or written to disk. */
export async function readPrivateClaudeProviderHandoff(input) {
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => input.destroy(privateProviderError()), 10_000);
  timer.unref?.();
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > PRIVATE_PROVIDER_MAX_BYTES) throw privateProviderError();
      chunks.push(buffer);
    }
    return parsePrivateClaudeProviderHandoff(Buffer.concat(chunks).toString("utf8"));
  } catch { throw privateProviderError(); }
  finally { clearTimeout(timer); for (const chunk of chunks) chunk.fill(0); }
}

/** Public identity is safe for request binding; it deliberately excludes credential hashes. */
export function privateClaudeProviderIdentity(handoff) {
  const provider = validatePrivateClaudeProviderHandoff(handoff);
  return { providerId: provider.providerId, endpointHost: "api.minimaxi.com", endpointPath: "/anthropic", authType: provider.authType, selectionSource: "explicit_private_stdin" };
}

export const CLAUDE_LIVE_PROVIDER_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_EFFORT_LEVEL",
]);

const CLAUDE_CONTROLLED_AMBIENT_ENV_KEYS = new Set([
  "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "USER", "USERNAME", "LOGNAME", "SHELL", "TERM",
  "LANG", "LC_ALL", "LC_CTYPE", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
]);

const CLAUDE_PROVIDER_OR_CLOUD_ENV_PREFIXES = Object.freeze([
  "ANTHROPIC_", "CLAUDE_CODE_", "AWS_", "GOOGLE_", "VERTEX_", "CLOUD_ML_",
]);

function normalizeEnvKey(key) {
  return String(key).toUpperCase();
}

function readCaseInsensitiveEnvironmentValue(ambientEnv, expectedKey) {
  const matches = Object.entries(ambientEnv ?? {})
    .filter(([key]) => normalizeEnvKey(key) === expectedKey)
    .map(([, value]) => value);
  if (matches.length === 0) return undefined;
  if (matches.some((value) => typeof value !== "string" || value.trim().length === 0) || new Set(matches).size !== 1) {
    throw new Error("Claude configuration directory is invalid");
  }
  return matches[0];
}

function resolveTrustedClaudeConfigDir({ homeDir, ambientEnv }) {
  const configuredDir = readCaseInsensitiveEnvironmentValue(ambientEnv, "CLAUDE_CONFIG_DIR");
  const candidate = configuredDir ?? path.join(homeDir, ".claude");
  if (typeof candidate !== "string" || candidate.trim() !== candidate || !path.isAbsolute(candidate)) {
    throw new Error("Claude configuration directory is invalid");
  }
  const resolved = realpathSync(candidate);
  if (!statSync(resolved).isDirectory()) throw new Error("Claude configuration directory is invalid");
  return resolved;
}

function hasValidClaudeLiveProvider(configured) {
  const endpoint = configured.ANTHROPIC_BASE_URL;
  const credential = configured.ANTHROPIC_API_KEY ?? configured.ANTHROPIC_AUTH_TOKEN;
  return typeof endpoint === "string" && endpoint.trim().length > 0 &&
    typeof credential === "string" && credential.trim().length > 0;
}

export function selectClaudeLiveProviderEnv(settings) {
  const source =
    settings?.env && typeof settings.env === "object" && !Array.isArray(settings.env)
      ? settings.env
      : {};
  const selected = {};
  for (const key of CLAUDE_LIVE_PROVIDER_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      selected[key] = value;
    }
  }
  return selected;
}

export function sanitizeClaudeLiveProviderAmbientEnv(ambientEnv = process.env) {
  const sanitized = {};
  for (const [key, value] of Object.entries(ambientEnv ?? {})) {
    const normalizedKey = normalizeEnvKey(key);
    if (normalizedKey === "NODE_OPTIONS" || normalizedKey === "CLAUDE_CONFIG_DIR" ||
      CLAUDE_PROVIDER_OR_CLOUD_ENV_PREFIXES.some((prefix) => normalizedKey.startsWith(prefix))) {
      continue;
    }
    if (CLAUDE_CONTROLLED_AMBIENT_ENV_KEYS.has(normalizedKey) && typeof value === "string") {
      sanitized[normalizedKey] = value;
    }
  }
  return sanitized;
}

function readClaudeLiveProviderSettingsSync(configDir) {
  const settingsPath = path.join(configDir, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const configured = selectClaudeLiveProviderEnv(settings);
  if (!hasValidClaudeLiveProvider(configured)) {
    throw new Error("Claude global settings contain no allowed live-provider configuration");
  }
  return configured;
}

/**
 * Resolves the strict provider environment used by controlled Claude probes.
 * The caller's provider values are deliberately discarded so an empty
 * --setting-sources invocation cannot inherit a different ambient provider.
 */
export function resolveClaudeLiveProviderEnvironmentSync({
  homeDir = os.homedir(),
  ambientEnv = process.env,
  privateProviderHandoff,
  model,
  effort,
} = {}) {
  if (privateProviderHandoff !== undefined) {
    const provider = validatePrivateClaudeProviderHandoff(privateProviderHandoff);
    if (model !== "MiniMax-M3.1-Flash" || effort !== "low") throw privateProviderError();
    return {
      ...sanitizeClaudeLiveProviderAmbientEnv(ambientEnv),
      ANTHROPIC_BASE_URL: provider.endpoint,
      [provider.authType === "api_key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"]: provider.credential,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      CLAUDE_CODE_EFFORT_LEVEL: effort,
      NO_COLOR: "1",
    };
  }
  let configDir;
  let configured;
  try {
    configDir = resolveTrustedClaudeConfigDir({ homeDir, ambientEnv });
    configured = readClaudeLiveProviderSettingsSync(configDir);
  } catch {
    throw new Error("Claude global live-provider settings are missing or malformed");
  }
  return {
    ...sanitizeClaudeLiveProviderAmbientEnv(ambientEnv),
    CLAUDE_CONFIG_DIR: configDir,
    ...configured,
    NO_COLOR: "1",
  };
}

export async function resolveClaudeLiveProviderEnvironment({
  homeDir = os.homedir(),
  ambientEnv = process.env,
} = {}) {
  let configured = {};
  try {
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    configured = selectClaudeLiveProviderEnv(settings);
  } catch {
    // A missing or malformed settings file keeps the previous ambient behavior.
  }
  return {
    ...ambientEnv,
    ...configured,
    NO_COLOR: "1",
  };
}
