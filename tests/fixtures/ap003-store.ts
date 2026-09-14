import Database from "better-sqlite3";

/** Replays the accepted AP-003 binary's schema-version startup boundary. */
export function reopenWithAp003Store(databasePath: string): void {
  const database = new Database(databasePath, { fileMustExist: true });
  try {
    const versions = (
      database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as { version: number }[]
    ).map(({ version }) => version);
    if (versions.length !== 2 || versions[0] !== 1 || versions[1] !== 2) {
      throw new Error("unsupported AP-003 durable admission schema version");
    }
  } finally {
    database.close();
  }
}
