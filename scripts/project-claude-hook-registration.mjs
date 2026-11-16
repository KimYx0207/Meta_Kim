import { readFileSync } from "node:fs";
import { join } from "node:path";

// The canonical Claude settings file owns hook registration. Keep its command
// parser in one place so bootstrap and its tests cannot drift independently.
const HOOK_SCRIPT_PATTERN = /\.claude[\\/]+hooks[\\/]+([\w.-]+\.(?:mjs|cjs|js|py|sh|ps1))/g;
const HOOK_DIRECTORY_PATTERN = /\.claude[\\/]+hooks[\\/]+/;

export function analyzeRegisteredClaudeProjectHooks(settings) {
  const files = new Set();
  const unparsedCommands = [];
  for (const groups of Object.values(settings?.hooks ?? {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        const command = typeof hook?.command === "string" ? hook.command : "";
        const matches = [...command.matchAll(HOOK_SCRIPT_PATTERN)];
        if (HOOK_DIRECTORY_PATTERN.test(command) && matches.length === 0) {
          unparsedCommands.push(command);
        }
        for (const match of matches) files.add(match[1]);
      }
    }
  }
  return {
    files: Object.freeze([...files].sort()),
    unparsedCommands: Object.freeze(unparsedCommands),
  };
}

export function resolveProjectClaudeHookFiles({ projectRoot, existingHookFiles }) {
  const settingsPath = join(
    projectRoot, "canonical", "runtime-assets", "claude", "settings.json",
  );
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Meta_Kim cannot read the canonical Claude hook registration at ${settingsPath}: ${error.message}`,
      { cause: error },
    );
  }
  const { files, unparsedCommands } = analyzeRegisteredClaudeProjectHooks(settings);
  if (unparsedCommands.length > 0) {
    throw new Error(
      `Meta_Kim cannot resolve ${unparsedCommands.length} registered Claude hook command(s) at ${settingsPath}`,
    );
  }
  return Object.freeze([...new Set([...existingHookFiles, ...files])]);
}
