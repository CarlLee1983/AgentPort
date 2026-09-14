import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  executionControlMigration,
  initialMigration,
  s3aPredispatchMigration,
  s3bDispatchMigration,
  s3bTerminalMigration,
  s4ContextQueueMigration,
  s4ContextResumeMigration,
  s4QuestionsMigration,
  s4QuestionAccountingMigration,
  s4QuestionNativeRelationMigration,
  s4ProtectedSessionTokensMigration,
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

  it("keeps the additive S3-A artifact identical to the worker migration", async () => {
    const artifact = await readFile(
      resolve(import.meta.dirname, "../../migrations/003_s3a_predispatch.sql"),
      "utf8",
    );
    expect(normalizeSql(s3aPredispatchMigration)).toBe(normalizeSql(artifact));
    expect(normalizeSql(artifact)).not.toContain("drop table");
    expect(normalizeSql(artifact)).not.toContain("delete from");
    expect(normalizeSql(artifact)).not.toContain("create trigger");
    expect(normalizeSql(artifact)).not.toContain("raise(rollback");
  });

  it("keeps the additive S3-B artifact identical to the worker migration", async () => {
    const artifact = await readFile(
      resolve(import.meta.dirname, "../../migrations/004_s3b_dispatch.sql"),
      "utf8",
    );
    expect(normalizeSql(s3bDispatchMigration)).toBe(normalizeSql(artifact));
    expect(normalizeSql(artifact)).not.toContain("drop table");
    expect(normalizeSql(artifact)).not.toContain("delete from");
    expect(normalizeSql(artifact)).not.toContain("create trigger");
    expect(normalizeSql(artifact)).not.toContain("raise(rollback");
  });

  it("keeps the additive S3-B terminal artifact identical to the worker migration", async () => {
    const artifact = await readFile(
      resolve(import.meta.dirname, "../../migrations/005_s3b_terminal.sql"),
      "utf8",
    );
    expect(normalizeSql(s3bTerminalMigration)).toBe(normalizeSql(artifact));
    expect(normalizeSql(artifact)).not.toContain("drop table");
    expect(normalizeSql(artifact)).not.toContain("delete from");
    expect(normalizeSql(artifact)).not.toContain("create trigger");
    expect(normalizeSql(artifact)).not.toContain("raise(rollback");
  });

  it("keeps the additive S4 Context queue artifact identical to the worker migration", async () => {
    const artifact = await readFile(
      resolve(import.meta.dirname, "../../migrations/006_s4_context_queue.sql"),
      "utf8",
    );
    expect(normalizeSql(s4ContextQueueMigration)).toBe(normalizeSql(artifact));
    expect(normalizeSql(artifact)).not.toContain("drop table");
    expect(normalizeSql(artifact)).not.toContain("delete from");
    expect(normalizeSql(artifact)).not.toContain("create trigger");
    expect(normalizeSql(artifact)).not.toContain("raise(rollback");
  });

  it("keeps the additive S4 Questions artifact identical to the worker migration", async () => {
    const artifact = await readFile(
      resolve(import.meta.dirname, "../../migrations/007_s4_questions.sql"),
      "utf8",
    );
    expect(normalizeSql(s4QuestionsMigration)).toBe(normalizeSql(artifact));
    expect(normalizeSql(artifact)).not.toContain("drop table");
    expect(normalizeSql(artifact)).not.toContain("delete from");
    expect(normalizeSql(artifact)).not.toContain("create trigger");
    expect(normalizeSql(artifact)).not.toContain("raise(rollback");
  });

  it("keeps the protected S4 Session-token artifact identical to the worker migration", async () => {
    const artifact = await readFile(
      resolve(
        import.meta.dirname,
        "../../migrations/008_s4_protected_session_tokens.sql",
      ),
      "utf8",
    );
    expect(normalizeSql(s4ProtectedSessionTokensMigration)).toBe(
      normalizeSql(artifact),
    );
    expect(normalizeSql(artifact)).not.toContain("drop table");
    expect(normalizeSql(artifact)).not.toContain("delete from");
  });

  it("keeps the additive S4 native Question relation artifact identical to the worker migration", async () => {
    const artifact = await readFile(
      resolve(
        import.meta.dirname,
        "../../migrations/009_s4_question_native_relation.sql",
      ),
      "utf8",
    );
    expect(normalizeSql(s4QuestionNativeRelationMigration)).toBe(
      normalizeSql(artifact),
    );
    expect(normalizeSql(artifact)).not.toContain("drop table");
    expect(normalizeSql(artifact)).not.toContain("delete from");
  });

  it("keeps the additive S4 Context resume artifact identical to the worker migration", async () => {
    const artifact = await readFile(
      resolve(
        import.meta.dirname,
        "../../migrations/010_s4_context_resume.sql",
      ),
      "utf8",
    );
    expect(normalizeSql(s4ContextResumeMigration)).toBe(normalizeSql(artifact));
    expect(normalizeSql(artifact)).not.toContain("drop table");
    expect(normalizeSql(artifact)).not.toContain("delete from");
  });

  it("keeps the additive S4 Question accounting artifact identical to the worker migration", async () => {
    const artifact = await readFile(
      resolve(
        import.meta.dirname,
        "../../migrations/011_s4_question_accounting.sql",
      ),
      "utf8",
    );
    expect(normalizeSql(s4QuestionAccountingMigration)).toBe(
      normalizeSql(artifact),
    );
    expect(normalizeSql(artifact)).not.toContain("drop table");
    expect(normalizeSql(artifact)).not.toContain("delete from");
  });
});
