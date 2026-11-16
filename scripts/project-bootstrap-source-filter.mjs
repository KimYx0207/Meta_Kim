// Project projections contain capabilities, never transient build/runtime state.
// This explicit set leaves legitimate dot directories (e.g. .claude-plugin) alone.
export const IGNORED_DEPLOY_CACHE_DIRS = Object.freeze([
  ".ruff_cache",
  ".meta-kim",
  ".git",
  ".pytest_cache",
  ".mypy_cache",
  "__pycache__",
  "node_modules",
]);

const ignored = new Set(IGNORED_DEPLOY_CACHE_DIRS);

export function isIgnoredDeploySourceDir(entry) {
  return entry.isDirectory() && ignored.has(entry.name);
}
