import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

export interface SqliteCompatibilityResult {
  bindingVersion: string;
  sqliteVersion: string;
  journalMode: string;
}

const WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const Database = require("better-sqlite3");
  const metadata = require("better-sqlite3/package.json");
  const database = new Database(workerData.databasePath);
  const journalMode = database.pragma("journal_mode = WAL", { simple: true });
  const { version: sqliteVersion } = database.prepare("select sqlite_version() as version").get();
  database.close();
  parentPort.postMessage({ bindingVersion: metadata.version, sqliteVersion, journalMode });
`;

export async function probeSqliteCompatibility(): Promise<SqliteCompatibilityResult> {
  const directory = await mkdtemp(join(tmpdir(), "agentport-ap001-sqlite-"));
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { databasePath: join(directory, "compatibility.sqlite") },
  });

  try {
    return await new Promise<SqliteCompatibilityResult>((resolve, reject) => {
      worker.once("message", (message: SqliteCompatibilityResult) => {
        resolve(message);
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0)
          reject(
            new Error(
              `SQLite compatibility worker exited with code ${String(code)}`,
            ),
          );
      });
    });
  } finally {
    await worker.terminate();
    await rm(directory, { force: true, recursive: true });
  }
}
