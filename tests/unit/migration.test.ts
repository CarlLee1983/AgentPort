import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { initialMigration } from "../../src/storage/migration.js";

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
});
