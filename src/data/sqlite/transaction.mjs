export function withSqliteTransaction(db, work, { mode = "IMMEDIATE" } = {}) {
  if (!db || typeof db.exec !== "function") {
    throw new TypeError("withSqliteTransaction requires a synchronous sqlite database");
  }
  if (typeof work !== "function") {
    throw new TypeError("withSqliteTransaction requires a work function");
  }

  db.exec(`BEGIN ${mode}`);
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
}
