import { promises as fs } from "node:fs";
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
