import { access, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import { reopenWithAp003Store } from "../fixtures/ap003-store.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

describe("S3-A rollback recovery", () => {
  it("keeps the live v3 database for recovery-only query and control", async () => {
    const fixture = await createDurableAdmissionFixture();
    let recoveryStore: SqliteDurableAdmissionStore | undefined;
    try {
      const recoveryDirectory = join(fixture.directory, "offline-recovery");
      const recoveryDatabasePath = join(recoveryDirectory, "agentport.sqlite");
      const mainOnlyPath = join(recoveryDirectory, "main-only.sqlite");
      await mkdir(recoveryDirectory);
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "s3a-rollback-candidate",
        agentId: "agent-a",
        instruction: "preserve every v3 fact during rollback",
      });
      await fixture.prepareExecution(actor, { taskId: submitted.task.taskId });
      const reference = await fixture.executionReference(actor, {
        taskId: submitted.task.taskId,
      });
      await fixture.recordObservation(actor, {
        taskId: submitted.task.taskId,
        observation: {
          reference,
          kind: "candidate",
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "completed", summary: "retained candidate" },
        },
      });
      await expect(
        access(`${fixture.databasePath}-wal`),
      ).resolves.toBeUndefined();
      await copyFile(fixture.databasePath, mainOnlyPath);
      const mainOnly = new Database(mainOnlyPath, { fileMustExist: true });
      try {
        expect(
          mainOnly
            .prepare("SELECT COUNT(*) AS count FROM execution_observations")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        mainOnly.close();
      }
      await copyFile(fixture.databasePath, recoveryDatabasePath);
      await copyFile(
        `${fixture.databasePath}-wal`,
        `${recoveryDatabasePath}-wal`,
      );
      await copyFile(
        `${fixture.databasePath}.control-reserve`,
        `${recoveryDatabasePath}.control-reserve`,
      );
      await fixture.store.close();

      await expect(access(recoveryDatabasePath)).resolves.toBeUndefined();
      await expect(
        access(`${recoveryDatabasePath}-wal`),
      ).resolves.toBeUndefined();
      expect(() => {
        reopenWithAp003Store(recoveryDatabasePath);
      }).toThrow("unsupported AP-003 durable admission schema version");

      recoveryStore = await SqliteDurableAdmissionStore.open({
        databasePath: recoveryDatabasePath,
        recoveryOnly: true,
      });
      const registry = await AgentRegistry.create(
        fixture.registryConfiguration,
        recoveryStore,
      );
      const service = new DurableAgentExecutionService(
        registry,
        recoveryStore,
        {
          cursorSecret: "s3a-rollback-recovery-secret",
        },
      );
      await service.initializeAfterRestart();

      await expect(
        service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        execution: {
          state: "recovering",
          candidateAvailable: true,
          finalOrdinal: 1,
          stopReason: "completion",
          quarantined: true,
        },
        readiness: { status: "blocked", reason: "g1_unproven" },
      });
      await expect(
        service.submitTask(actor, {
          operationId: "blocked-during-rollback",
          agentId: "agent-revokable",
          instruction: "recovery mode must not admit new work",
        }),
      ).rejects.toMatchObject({ code: "invalid_state" });
      await expect(
        service.cancelTask(actor, {
          operationId: "control-during-rollback",
          taskId: submitted.task.taskId,
        }),
      ).rejects.toMatchObject({
        code: "operation_conflict",
        task: {
          execution: {
            state: "recovering",
            stopReason: "completion",
            candidateAvailable: true,
          },
        },
      });
      await expect(
        recoveryStore.probe("inspectSchemaVersions"),
      ).resolves.toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      await recoveryStore.close();
      recoveryStore = undefined;

      const inspected = new Database(recoveryDatabasePath, {
        fileMustExist: true,
      });
      try {
        expect(
          inspected
            .prepare("SELECT COUNT(*) AS count FROM execution_observations")
            .get(),
        ).toEqual({ count: 1 });
        expect(
          inspected
            .prepare("SELECT status FROM execution_workspace_claims")
            .get(),
        ).toEqual({ status: "quarantined" });
        expect(
          inspected
            .prepare("SELECT stop_reason AS stopReason FROM executions")
            .get(),
        ).toEqual({ stopReason: "completion" });
      } finally {
        inspected.close();
      }
    } finally {
      await recoveryStore?.close();
      await fixture.close();
    }
  });
});
