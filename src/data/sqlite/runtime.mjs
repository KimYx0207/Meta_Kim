function isNodeSqliteExperimentalWarning(warning, args) {
  const message =
    typeof warning === "string" ? warning : String(warning?.message ?? "");
  const type =
    typeof args[0] === "string" ? args[0] : String(warning?.name ?? "");
  return type === "ExperimentalWarning" && /SQLite is an experimental feature/i.test(message);
}

export async function importDatabaseSync() {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function emitWarningWithoutNodeSqliteNoise(warning, ...args) {
    if (isNodeSqliteExperimentalWarning(warning, args)) {
      return;
    }
    return originalEmitWarning.call(this, warning, ...args);
  };
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return DatabaseSync;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}
