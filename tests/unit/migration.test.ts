import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executionControlMigration,
  executionControlRollbackMigration,
  initialMigration,
} from "../../src/storage/migration.js";

function normalizeSql(sql: string): string {
  return sql
    .replaceAll(/--[^\n]*/g, "")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\s*([(),;=])\s*/g, "$1")
    .trim()
    .toLowerCase();
}

describe("durable admission migration", () => {
  it("keeps the inspectable SQL artifact identical to the worker migration", async () => {
    const artifact = await readFile(
      resolve(
        import.meta.dirname,
        "../../migrations/001_durable_admission.sql",
      ),
      "utf8",
    );
    expect(normalizeSql(initialMigration)).toBe(normalizeSql(artifact));
  });

  it("keeps the execution-control upgrade artifact identical to the worker migration", async () => {
    const artifact = await readFile(
      resolve(
        import.meta.dirname,
        "../../migrations/002_execution_control.sql",
      ),
      "utf8",
    );
    expect(normalizeSql(executionControlMigration)).toBe(
      normalizeSql(artifact),
    );
  });

  it("keeps the rollback artifact non-destructive and identical to its migration contract", async () => {
    const artifact = await readFile(
      resolve(
        import.meta.dirname,
        "../../migrations/002_execution_control_rollback.sql",
      ),
      "utf8",
    );
    expect(normalizeSql(executionControlRollbackMigration)).toBe(
      normalizeSql(artifact),
    );
    expect(normalizeSql(artifact)).not.toContain("drop table");
    expect(normalizeSql(artifact)).toContain(
      "delete from schema_migrations where version=2",
    );
    expect(normalizeSql(artifact)).not.toContain("create trigger");
    expect(normalizeSql(artifact)).not.toContain("raise(rollback");
  });
});
