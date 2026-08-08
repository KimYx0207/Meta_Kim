import { promises as fs, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
} = {}) {
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
