import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDurableAdmission } from "../../src/bootstrap/create-durable-admission.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";
import { openStore, submit } from "../fixtures/durable-store.js";

describe("storage restart", () => {
  it("pauses committed queued work and retains receipts/events", async () => {
    const fixture = await openStore();
    try {
      await fixture.store.submit(submit({ now: "2026-01-01T00:00:00.000Z" }));
      await fixture.store.close();
      const store = await SqliteDurableAdmissionStore.open({
        databasePath: join(fixture.directory, "store.sqlite"),
      });
      await store.transitionTasks({
        fromState: "queued",
        toState: "paused",
        reason: "daemon_restart",
        eventType: "daemon_restart_paused",
      });
      const found = await store.getTask({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        taskId: "task-1",
      });
      expect(found).toMatchObject({
        state: "paused",
        reason: "daemon_restart",
        revision: 2,
      });
      expect(
        (
          await store.getEvents({
            accessScopeId: "scope-a",
            allowedAgentIds: ["agent-a"],
            limit: 10,
          })
        ).events.map((e) => e.type),
      ).toEqual(["accepted", "daemon_restart_paused"]);
      const replay = await store.submit(submit());
      expect(replay).toMatchObject({
        replayed: true,
        task: { taskId: "task-1" },
      });
      expect(await store.probe("inspectDurability")).toEqual({
        bindingSnapshots: 1,
        bindingPayloads: [
          {
            bindingSnapshotId: "binding-1",
            configurationRevision: "opaque-revision",
            policy: {
              maximumExecutionLimitSeconds: 3_600,
              maximumInputWaitSeconds: 86_400,
            },
            runtimeDriver: "none",
            runtimeVersion: "none",
            launchProfileId: "fixture-profile",
            workspaceIdentity: {
              canonicalPath: "/fixture/workspace-a",
              filesystemIdentity: "workspace-a",
            },
          },
        ],
        contexts: 1,
        receipts: 1,
        actors: ["principal-a"],
        reservations: 1,
        reservationState: [
          { controlReceipts: 1, controlEvents: 1, controlBytes: 65_536 },
        ],
        capacity: [
          { key: "active_global", value: 1 },
          { key: "active_workspace:workspace-a", value: 1 },
          { key: "admission_bytes", value: 12 },
          { key: "general_receipts", value: 1 },
          { key: "reserved_control_bytes", value: 65_536 },
        ],
      });
      await store.close();
    } finally {
      await fixture.dispose();
    }
  });

  it("allocates event cursors independently inside each Access Scope", async () => {
    const fixture = await openStore();
    try {
      await fixture.store.submit(submit());
      await fixture.store.submit(
        submit({
          accessScopeId: "scope-b",
          operationId: "scope-b-submit",
          taskId: "scope-b-task",
          contextId: "scope-b-context",
          binding: {
            ...submit().binding,
            bindingSnapshotId: "scope-b-binding",
          },
        }),
      );
      await fixture.store.cancel({
        accessScopeId: "scope-a",
        principalId: "principal-a",
        operationId: "scope-a-cancel",
        fingerprint: "scope-a-cancel-fingerprint",
        taskId: "task-1",
        expectedStates: ["queued", "paused"],
        nextState: "canceled",
        eventType: "canceled",
      });
      await expect(
        fixture.store.getEvents({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toMatchObject({ events: [{ cursor: 1 }, { cursor: 2 }] });
      await expect(
        fixture.store.getEvents({
          accessScopeId: "scope-b",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toMatchObject({ events: [{ cursor: 1 }] });
    } finally {
      await fixture.dispose();
    }
  });

  it("holds one crash-safe SQLite daemon lock until close", async () => {
    const fixture = await openStore({ busyTimeoutMs: 100 });
    try {
      await expect(
        SqliteDurableAdmissionStore.open({
          databasePath: join(fixture.directory, "store.sqlite"),
          busyTimeoutMs: 100,
        }),
      ).rejects.toThrow();
      await fixture.store.close();
      const reopened = await SqliteDurableAdmissionStore.open({
        databasePath: join(fixture.directory, "store.sqlite"),
      });
      await reopened.close();
    } finally {
      await fixture.dispose();
    }
  });

  it("releases the daemon lock when restart initialization fails", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: "submit-before-failed-restart",
          agentId: "agent-a",
          instruction: "queued before restart",
        },
      );
      await fixture.store.probe("exhaustRestartEventReserve");
      await fixture.store.close();

      await expect(
        createDurableAdmission({
          registry: fixture.registryConfiguration,
          cursorSecret: "failed-restart-cursor-secret",
          storage: { databasePath: fixture.databasePath },
        }),
      ).rejects.toThrow(
        "active Task control reservation ledger is inconsistent",
      );

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

  it("releases the daemon lock when the MCP handler fails to close", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      await fixture.store.close();
      const composition = await createDurableAdmission({
        registry: fixture.registryConfiguration,
        cursorSecret: "failed-handler-close-cursor-secret",
        storage: { databasePath: fixture.databasePath },
      });
      vi.spyOn(composition.mcpHandler, "close").mockRejectedValueOnce(
        new Error("injected MCP handler close failure"),
      );

      await expect(composition.close()).rejects.toThrow(
        "injected MCP handler close failure",
      );
      const reopened = await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      });
      await reopened.close();
    } finally {
      await fixture.close();
    }
  });

  it.each(["setFutureSchemaVersion", "makeSchemaIncomplete"] as const)(
    "fails closed when %s corrupts the recorded schema contract",
    async (probe) => {
      const fixture = await openStore();
      try {
        await fixture.store.probe(probe);
        await fixture.store.close();
        await expect(
          SqliteDurableAdmissionStore.open({
            databasePath: join(fixture.directory, "store.sqlite"),
          }),
        ).rejects.toThrow();
      } finally {
        await fixture.dispose();
      }
    },
  );
});
