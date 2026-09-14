import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

describe("S3-A restart recovery", () => {
  it("moves prepared and candidate-stopping executions to recovering without replay or release", async () => {
    const fixture = await createDurableAdmissionFixture();
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "s3a-recover-candidate",
        agentId: "agent-a",
        instruction: "preserve candidate while recovery remains fail closed",
      });
      await fixture.prepareExecution(actor, { taskId: submitted.task.taskId });
      const reference = await fixture.executionReference(actor, {
        taskId: submitted.task.taskId,
      });
      await fixture.recordObservation(actor, {
        taskId: submitted.task.taskId,
        observation: {
          reference,
          kind: "progress",
          ordinal: 1,
          summary: "durable progress before restart",
        },
      });
      await fixture.recordObservation(actor, {
        taskId: submitted.task.taskId,
        observation: {
          reference,
          kind: "candidate",
          ordinal: 2,
          finalOrdinal: 2,
          outcome: { kind: "completed", summary: "untrusted candidate" },
        },
      });
      const preparedOnly = await fixture.service.submitTask(actor, {
        operationId: "s3a-recover-prepared",
        agentId: "agent-revokable",
        instruction: "do not accept observations after recovery begins",
      });
      await fixture.prepareExecution(actor, {
        taskId: preparedOnly.task.taskId,
      });
      const preparedReference = await fixture.executionReference(actor, {
        taskId: preparedOnly.task.taskId,
      });

      await fixture.store.close();
      reopened = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const registry = await AgentRegistry.create(
        fixture.registryConfiguration,
        reopened,
      );
      const recovery =
        DurableAgentExecutionService.createPlatformNeutralPreparationFixture(
          registry,
          reopened,
          {
            cursorSecret: "s3a-recovery-cursor-secret",
            now: () => new Date("2026-09-13T01:00:00.000Z"),
          },
        );
      const { service } = recovery;

      await service.initializeAfterRestart();
      await expect(
        service.getTask(actor, {
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        execution: {
          state: "recovering",
          progress: {
            ordinal: 1,
            summary: "durable progress before restart",
          },
          lastObservationOrdinal: 2,
          candidateAvailable: true,
          finalOrdinal: 2,
          stopReason: "completion",
          recoveryReason: "daemon_restart",
          quarantined: true,
        },
      });
      const execution = await reopened.getExecution({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        taskId: submitted.task.taskId,
      });
      expect(execution).not.toHaveProperty("result");
      expect(execution).not.toHaveProperty("terminalState");
      await expect(
        recovery.recordObservation(actor, {
          taskId: submitted.task.taskId,
          observation: {
            reference,
            kind: "candidate",
            ordinal: 2,
            finalOrdinal: 2,
            outcome: { kind: "completed", summary: "untrusted candidate" },
          },
        }),
      ).resolves.toMatchObject({
        replayed: true,
        execution: {
          state: "recovering",
          stopReason: "completion",
          quarantined: true,
        },
      });

      await expect(
        recovery.recordObservation(actor, {
          taskId: preparedOnly.task.taskId,
          observation: {
            reference: preparedReference,
            kind: "progress",
            ordinal: 1,
            summary: "must not resume a recovering execution",
          },
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        reopened.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-revokable"],
          taskId: preparedOnly.task.taskId,
        }),
      ).resolves.toMatchObject({
        state: "recovering",
        lastObservationOrdinal: 0,
        workspaceClaim: "quarantined",
      });

      const revision = execution?.revision;
      await service.initializeAfterRestart();
      await expect(
        reopened.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({ revision });
    } finally {
      await reopened?.close();
      await fixture.close();
    }
  });

  it("reopens after a prepared execution records a cancellation intent", async () => {
    const fixture = await createDurableAdmissionFixture();
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "s3a-recover-cancellation-intent",
        agentId: "agent-a",
        instruction: "retain cancellation ordering across restart",
      });
      await fixture.prepareExecution(actor, { taskId: submitted.task.taskId });
      await fixture.service.cancelTask(actor, {
        operationId: "s3a-cancel-before-restart",
        taskId: submitted.task.taskId,
      });
      await fixture.store.close();

      reopened = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      const registry = await AgentRegistry.create(
        fixture.registryConfiguration,
        reopened,
      );
      const service = new DurableAgentExecutionService(registry, reopened, {
        cursorSecret: "s3a-cancel-recovery-secret",
      });
      await service.initializeAfterRestart();

      await expect(
        service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        state: "paused",
        reason: "execution_stopping",
        execution: {
          state: "recovering",
          stopReason: "cancellation",
          candidateAvailable: false,
          quarantined: true,
        },
      });
    } finally {
      await reopened?.close();
      await fixture.close();
    }
  });

  it("fails closed when an unrelated cancel receipt masks an underfunded Task ledger", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "s3a-corrupt-receipt-mask",
        agentId: "agent-a",
        instruction: "do not trust a receipt without matching execution state",
      });
      await fixture.store.close();

      const database = new Database(fixture.databasePath, {
        fileMustExist: true,
      });
      try {
        database
          .prepare(
            "UPDATE task_reservations SET control_receipts=0 WHERE task_id=?",
          )
          .run(submitted.task.taskId);
        database
          .prepare(
            "INSERT INTO operation_receipts(scope,operation_id,operation_type,target_id,fingerprint,actor_principal_id,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            "scope-a",
            "unrelated-cancel-receipt",
            "cancel",
            submitted.task.taskId,
            "unrelated",
            actor.principalId,
            JSON.stringify({ taskId: submitted.task.taskId }),
            "2026-09-13T02:00:00.000Z",
          );
      } finally {
        database.close();
      }

      await expect(
        SqliteDurableAdmissionStore.open({
          databasePath: fixture.databasePath,
        }),
      ).rejects.toThrow(
        "active Task control reservation ledger is inconsistent",
      );
    } finally {
      await fixture.close();
    }
  });
});
