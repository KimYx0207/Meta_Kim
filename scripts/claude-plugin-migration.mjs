/**
 * Claude Code itself owns plugin inventory, enable state and cache paths.
 * Never synthesize or rewrite plugins/installed_plugins.json from an installer.
 */
export function parseClaudePluginInventory(stdout) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch {
    throw new Error("Claude plugin list --json returned invalid JSON");
  }
  if (!Array.isArray(rows) || rows.some((row) =>
    !row || typeof row !== "object" ||
    typeof row.id !== "string" ||
    typeof row.enabled !== "boolean" ||
    typeof row.scope !== "string" ||
    typeof row.version !== "string"
  )) {
    throw new Error("Claude plugin list --json returned an unsupported inventory schema");
  }
  return rows;
}

export function legacyUserPluginsForMigration(rows, spec, legacyNames = []) {
  const names = new Set(legacyNames);
  return rows.filter((row) => {
    if (row.scope !== "user" || row.id === spec) return false;
    const at = row.id.lastIndexOf("@");
    return at > 0 && names.has(row.id.slice(0, at)) &&
      !["inline", "skills-dir", "synced", "builtin"].includes(row.id.slice(at + 1));
  });
}

export function requireInstalledClaudePlugin(rows, spec) {
  const matched = rows.filter((row) => row.id === spec &&
    ["user", "project", "local", "managed"].includes(row.scope));
  if (!matched.length) throw new Error(`Claude did not register the installed plugin ${spec}`);
  if (matched.some((row) => Array.isArray(row.errors) && row.errors.length > 0)) {
    throw new Error(`Claude reports load errors for plugin ${spec}`);
  }
  return matched.find((row) => row.scope === "user") ?? matched[0];
}
