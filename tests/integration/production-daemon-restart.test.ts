import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createDurableAdmission } from "../../src/bootstrap/create-durable-admission.js";
import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { CursorCodec } from "../../src/core/codec.js";
import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import { validateDaemonCredentials } from "../../src/daemon/credentials.js";
import { sessionReferenceFor } from "../../src/runtime/claude/session-reference.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

describe("production daemon restart", () => {
  it("reuses stable credentials for cursor decoding and the same durable store", async () => {
    const cursorSecret = randomBytes(32).toString("base64url");
    const continuationEncryptionKey = randomBytes(32).toString("base64url");
    const firstCredentials = validateDaemonCredentials(
      cursorSecret,
      continuationEncryptionKey,
    );
    const secondCredentials = validateDaemonCredentials(
      cursorSecret,
      continuationEncryptionKey,
    );
    const cursor = new CursorCodec(firstCredentials.cursorSecret).encode({
      version: 1,
      kind: "restart-sentinel",
    });
    expect(
      new CursorCodec(secondCredentials.cursorSecret).decode(cursor),
    ).toEqual({ version: 1, kind: "restart-sentinel" });

    const fixture = await createDurableAdmissionFixture({
      continuationEncryptionKey: firstCredentials.continuationEncryptionKey,
    });
    let restarted:
      Awaited<ReturnType<typeof createDurableAdmission>> | undefined;
    try {
      await fixture.service.submitTask(actor, {
        operationId: "stable-secret-restart",
        agentId: "agent-a",
        instruction: "preserve this durable record",
      });
      await fixture.store.close();
      restarted = await createDurableAdmission({
        registry: fixture.registryConfiguration,
        cursorSecret: secondCredentials.cursorSecret,
        storage: {
          databasePath: fixture.databasePath,
          continuationEncryptionKey:
            secondCredentials.continuationEncryptionKey,
        },
      });
      await expect(
        restarted.service.listTasks(actor, {}),
      ).resolves.toMatchObject({ tasks: [{ state: "paused" }] });
      await restarted.close();
      restarted = undefined;
      const database = await readFile(fixture.databasePath);
      expect(database.includes(Buffer.from(cursorSecret))).toBe(false);
      expect(database.includes(Buffer.from(continuationEncryptionKey))).toBe(
        false,
      );
    } finally {
      await restarted?.close();
      await fixture.close();
    }
  });

  it("rejects a duplicate database owner without pausing the active daemon queue", async () => {
    const fixture = await createDurableAdmissionFixture({ busyTimeoutMs: 100 });
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "duplicate-daemon-lock",
        agentId: "agent-a",
        instruction: "the second daemon must not reconcile me",
      });
      await expect(
        SqliteDurableAdmissionStore.open({
          databasePath: fixture.databasePath,
          busyTimeoutMs: 100,
        }),
      ).rejects.toThrow();
      await expect(
        fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({ state: "queued", reason: null });
    } finally {
      await fixture.close();
    }
  });

  it("decrypts an existing protected continuation after restart with the same key", async () => {
    const continuationEncryptionKey = randomBytes(32).toString("base64url");
    const fixture = await createDurableAdmissionFixture({
      continuationEncryptionKey,
    });
    let reopenedStore: SqliteDurableAdmissionStore | undefined;
    try {
      const first = await fixture.service.submitTask(actor, {
        operationId: "daemon-restart-continuation-first",
        agentId: "agent-a",
        instruction: "establish protected native continuity",
      });
      const second = await fixture.service.submitTask(actor, {
        operationId: "daemon-restart-continuation-second",
        agentId: "agent-a",
        contextId: first.task.contextId,
        instruction: "fail without replacing native continuity",
      });
      const successor = await fixture.service.submitTask(actor, {
        operationId: "daemon-restart-continuation-successor",
        agentId: "agent-a",
        contextId: first.task.contextId,
        instruction: "resume only after the daemon restart",
      });

      const { reference: firstReference } =
        await fixture.service.prepareForDispatch(
          first.task.taskId,
          "daemon-restart-first-epoch",
        );
      const protectedSessionToken = "claude-session-01J8D7K2WQ6YB8P4M3N5R7T9VX";
      const sessionReference = sessionReferenceFor(
        firstReference,
        protectedSessionToken,
      );
      await fixture.service.markExecutionRunning(firstReference);
      await fixture.recordObservation(actor, {
        taskId: first.task.taskId,
        observation: {
          kind: "candidate",
          reference: firstReference,
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "completed", summary: "continuity established" },
          sessionReference,
          protectedSessionToken,
        },
      });
      await fixture.store.commitTerminal({
        evidence: {
          platform: "linux-cgroup-v2",
          reference: firstReference,
          executionUnitId: "daemon-restart-first-unit",
          generationSealedAt: "2026-09-18T00:00:00.000Z",
          unitEmptyObservedAt: "2026-09-18T00:00:01.000Z",
        },
      });

      const { reference: secondReference } =
        await fixture.service.prepareForDispatch(
          second.task.taskId,
          "daemon-restart-second-epoch",
        );
      await fixture.service.markExecutionRunning(secondReference);
      await fixture.recordObservation(actor, {
        taskId: second.task.taskId,
        observation: {
          kind: "candidate",
          reference: secondReference,
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "failed", summary: "preserve prior continuity" },
          sessionReference: null,
        },
      });
      await fixture.store.commitTerminal({
        evidence: {
          platform: "linux-cgroup-v2",
          reference: secondReference,
          executionUnitId: "daemon-restart-second-unit",
          generationSealedAt: "2026-09-18T00:00:02.000Z",
          unitEmptyObservedAt: "2026-09-18T00:00:03.000Z",
        },
      });

      await fixture.store.close();
      reopenedStore = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
        continuationEncryptionKey,
      });
      const restarted = new DurableAgentExecutionService(
        await AgentRegistry.create(
          fixture.registryConfiguration,
          reopenedStore,
        ),
        reopenedStore,
        { cursorSecret: "daemon-restart-cursor-secret" },
      );
      await restarted.initializeAfterRestart();
      const blocked = await restarted.getTask(actor, {
        taskId: successor.task.taskId,
      });
      await restarted.resumeContext(actor, {
        operationId: "daemon-restart-continuation-resume",
        contextId: first.task.contextId,
        expectedRevision: blocked.contextRevision,
        continuationMode: "preserve",
      });
      await expect(
        restarted.prepareForDispatch(
          successor.task.taskId,
          "daemon-restart-epoch",
        ),
      ).resolves.toMatchObject({
        continuation: {
          kind: "resume",
          sourceReference: firstReference,
          sessionReference,
          protectedSessionToken,
        },
      });
    } finally {
      await reopenedStore?.close();
      await fixture.close();
    }
  });
});
