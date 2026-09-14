import { mkdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import { openStore, submit } from "../fixtures/durable-store.js";

describe("storage reserves", () => {
  it("rejects new admission yet preserves existing task cancellation", async () => {
    const fixture = await openStore({ receiptCapacity: 1 });
    try {
      await fixture.store.submit(submit());
      await expect(
        fixture.store.submit(
          submit({
            operationId: "submit-2",
            taskId: "task-2",
            contextId: "context-2",
            binding: { ...submit().binding, bindingSnapshotId: "binding-2" },
          }),
        ),
      ).rejects.toMatchObject({ code: "tombstone_capacity" });
      await expect(fixture.store.submit(submit())).resolves.toMatchObject({
        replayed: true,
        task: { taskId: "task-1" },
      });
      await expect(
        fixture.store.getEvents({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          limit: 10,
        }),
      ).resolves.toMatchObject({
        events: [{ taskId: "task-1", type: "accepted" }],
      });
      await expect(
        fixture.store.cancel({
          accessScopeId: "scope-a",
          principalId: "principal-a",
          operationId: "cancel-1",
          fingerprint: "cancel-fingerprint",
          taskId: "task-1",
          expectedStates: ["queued", "paused"],
          nextState: "canceled",
          eventType: "canceled",
        }),
      ).resolves.toMatchObject({ task: { state: "canceled" } });
    } finally {
      await fixture.dispose();
    }
  });

  it("counts queue capacity by immutable Workspace binding, not Agent ID", async () => {
    const fixture = await openStore({ queueGlobal: 10, queuePerWorkspace: 1 });
    try {
      await fixture.store.submit(submit());
      await expect(
        fixture.store.submit(
          submit({
            operationId: "same-workspace-new-agent",
            taskId: "task-2",
            contextId: "context-2",
            agentId: "agent-renamed",
            binding: {
              ...submit().binding,
              bindingSnapshotId: "binding-2",
              workspaceIdentity: {
                canonicalPath: "/fixture/workspace-a-renamed-agent",
                filesystemIdentity: "workspace-a",
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "queue_capacity" });
    } finally {
      await fixture.dispose();
    }
  });

  it("charges admission bytes using UTF-8 bytes rather than characters", async () => {
    const fixture = await openStore({ admissionBytes: 5 });
    try {
      await expect(
        fixture.store.submit(submit({ instruction: "ééé" })),
      ).rejects.toMatchObject({ code: "storage_capacity" });
      await expect(
        fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: "task-1",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it("does not charge reserved cancellation receipts to general admission", async () => {
    const fixture = await openStore({ receiptCapacity: 2 });
    try {
      await fixture.store.submit(submit());
      await fixture.store.cancel({
        accessScopeId: "scope-a",
        principalId: "principal-a",
        operationId: "cancel-1",
        fingerprint: "cancel-fingerprint",
        taskId: "task-1",
        expectedStates: ["queued", "paused"],
        nextState: "canceled",
        eventType: "canceled",
      });
      await expect(
        fixture.store.submit(
          submit({
            operationId: "submit-2",
            taskId: "task-2",
            contextId: "context-2",
            binding: { ...submit().binding, bindingSnapshotId: "binding-2" },
          }),
        ),
      ).resolves.toMatchObject({ task: { taskId: "task-2" } });
      await expect(
        fixture.store.submit(
          submit({
            operationId: "submit-3",
            taskId: "task-3",
            contextId: "context-3",
            binding: { ...submit().binding, bindingSnapshotId: "binding-3" },
          }),
        ),
      ).rejects.toMatchObject({ code: "tombstone_capacity" });
    } finally {
      await fixture.dispose();
    }
  });

  it("accounts for physical DB/WAL bytes while preserving accepted Task control headroom", async () => {
    const fixture = await openStore();
    const databasePath = join(fixture.directory, "store.sqlite");
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      await fixture.store.close();
      const baselineBytes = (await stat(databasePath)).size;
      reopened = await SqliteDurableAdmissionStore.open({
        databasePath,
        queueGlobal: 4,
        physicalAdmissionBytes: baselineBytes + 128 * 1024,
        physicalControlReserveBytes: 512 * 1024,
        taskControlReserveBytes: 128 * 1024,
      });
      const accepted: string[] = [];
      let observedWalBytes = 0;
      let rejected: unknown;
      for (let index = 1; index <= 4; index += 1) {
        const taskId = `physical-task-${String(index)}`;
        try {
          await reopened.submit(
            submit({
              operationId: `physical-submit-${String(index)}`,
              taskId,
              contextId: `physical-context-${String(index)}`,
              instruction: "x".repeat(32 * 1024),
              binding: {
                ...submit().binding,
                bindingSnapshotId: `physical-binding-${String(index)}`,
              },
            }),
          );
          accepted.push(taskId);
          const physical = (await reopened.probe(
            "inspectPhysicalCapacity",
          )) as { walBytes: number };
          observedWalBytes = Math.max(observedWalBytes, physical.walBytes);
        } catch (error) {
          rejected = error;
          break;
        }
      }
      expect(accepted.length).toBeGreaterThan(0);
      expect(rejected).toMatchObject({ code: "storage_capacity" });
      const beforeCancel = (await reopened.probe(
        "inspectPhysicalCapacity",
      )) as {
        databaseBytes: number;
        walBytes: number;
        totalBytes: number;
        allocatedDatabaseBytes: number;
        allocatedWalBytes: number;
        controlReserveBytes: number;
        allocatedControlReserveBytes: number;
        physicalTotalBytes: number;
        physicalAdmissionBytes: number;
        physicalControlReserveBytes: number;
        reservedControlBytes: number;
      };
      expect(beforeCancel.totalBytes).toBe(
        beforeCancel.databaseBytes + beforeCancel.walBytes,
      );
      expect(observedWalBytes).toBeGreaterThan(0);
      expect(beforeCancel.totalBytes).toBeLessThanOrEqual(
        beforeCancel.physicalAdmissionBytes,
      );
      expect(beforeCancel.reservedControlBytes).toBe(
        accepted.length * 128 * 1024,
      );
      expect(beforeCancel.controlReserveBytes).toBe(
        beforeCancel.reservedControlBytes,
      );
      expect(beforeCancel.allocatedControlReserveBytes).toBeGreaterThanOrEqual(
        beforeCancel.controlReserveBytes,
      );
      expect(beforeCancel.physicalTotalBytes).toBe(
        Math.max(
          beforeCancel.totalBytes,
          beforeCancel.allocatedDatabaseBytes + beforeCancel.allocatedWalBytes,
        ) + beforeCancel.allocatedControlReserveBytes,
      );

      await reopened.cancel({
        accessScopeId: "scope-a",
        principalId: "principal-a",
        operationId: "physical-cancel",
        fingerprint: "physical-cancel-fingerprint",
        taskId: accepted[0] ?? "missing",
        expectedStates: ["queued", "paused"],
        nextState: "canceled",
        eventType: "canceled",
      });
      const afterCancel = (await reopened.probe("inspectPhysicalCapacity")) as {
        totalBytes: number;
        controlReserveBytes: number;
        allocatedControlReserveBytes: number;
        physicalTotalBytes: number;
        physicalAdmissionBytes: number;
        physicalControlReserveBytes: number;
        reservedControlBytes: number;
      };
      expect(afterCancel.totalBytes).toBeLessThanOrEqual(
        afterCancel.physicalAdmissionBytes +
          afterCancel.physicalControlReserveBytes,
      );
      expect(afterCancel.reservedControlBytes).toBe(
        (accepted.length - 1) * 128 * 1024,
      );
      expect(afterCancel.controlReserveBytes).toBe(
        afterCancel.reservedControlBytes,
      );
      expect(afterCancel.allocatedControlReserveBytes).toBeGreaterThanOrEqual(
        afterCancel.controlReserveBytes,
      );
    } finally {
      await reopened?.close();
      await fixture.dispose();
    }
  });

  it("reconciles the same-filesystem physical reserve from durable metadata on restart", async () => {
    const fixture = await openStore({
      queueGlobal: 2,
      physicalControlReserveBytes: 256 * 1024,
      taskControlReserveBytes: 128 * 1024,
    });
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      await fixture.store.submit(submit());
      const before = (await fixture.store.probe("inspectPhysicalCapacity")) as {
        controlReserveBytes: number;
        allocatedControlReserveBytes: number;
      };
      expect(before.controlReserveBytes).toBe(128 * 1024);
      expect(before.allocatedControlReserveBytes).toBeGreaterThanOrEqual(
        128 * 1024,
      );

      await fixture.store.probe("truncatePhysicalControlReserve");
      await fixture.store.close();
      reopened = await SqliteDurableAdmissionStore.open({
        databasePath: join(fixture.directory, "store.sqlite"),
        queueGlobal: 2,
        physicalControlReserveBytes: 256 * 1024,
        taskControlReserveBytes: 128 * 1024,
      });
      const reconciled = (await reopened.probe("inspectPhysicalCapacity")) as {
        controlReserveBytes: number;
        allocatedControlReserveBytes: number;
        reservedControlBytes: number;
      };
      expect(reconciled).toMatchObject({
        controlReserveBytes: 128 * 1024,
        reservedControlBytes: 128 * 1024,
      });
      expect(reconciled.allocatedControlReserveBytes).toBeGreaterThanOrEqual(
        128 * 1024,
      );
    } finally {
      await reopened?.close();
      await fixture.dispose();
    }
  });

  it("rebuilds cached control capacity from the Task reservation ledger", async () => {
    const fixture = await openStore({
      queueGlobal: 2,
      physicalControlReserveBytes: 256 * 1024,
      taskControlReserveBytes: 128 * 1024,
    });
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      await fixture.store.submit(submit());
      await fixture.store.probe("corruptReservedControlSummary");
      await fixture.store.close();

      reopened = await SqliteDurableAdmissionStore.open({
        databasePath: join(fixture.directory, "store.sqlite"),
        queueGlobal: 2,
        physicalControlReserveBytes: 256 * 1024,
        taskControlReserveBytes: 128 * 1024,
      });
      await expect(
        reopened.probe("inspectPhysicalCapacity"),
      ).resolves.toMatchObject({
        controlReserveBytes: 128 * 1024,
        reservedControlBytes: 128 * 1024,
      });
      await expect(
        reopened.cancel({
          accessScopeId: "scope-a",
          principalId: "principal-a",
          operationId: "cancel-after-summary-rebuild",
          fingerprint: "cancel-after-summary-rebuild-fingerprint",
          taskId: "task-1",
          expectedStates: ["queued", "paused"],
          nextState: "canceled",
          eventType: "canceled",
        }),
      ).resolves.toMatchObject({ task: { state: "canceled" } });
    } finally {
      await reopened?.close();
      await fixture.dispose();
    }
  });

  it("fails closed when an active Task loses its durable control reservation", async () => {
    const fixture = await openStore();
    try {
      await fixture.store.submit(submit());
      await fixture.store.probe("zeroTaskReservationLedger");
      await fixture.store.close();
      await expect(
        SqliteDurableAdmissionStore.open({
          databasePath: join(fixture.directory, "store.sqlite"),
        }),
      ).rejects.toThrow(
        "active Task control reservation ledger is inconsistent",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("fails closed when a queued Task has only its cancellation event left", async () => {
    const fixture = await openStore();
    try {
      await fixture.store.submit(submit());
      await fixture.store.probe("underfundTaskEventLedger");
      await fixture.store.close();

      await expect(
        SqliteDurableAdmissionStore.open({
          databasePath: join(fixture.directory, "store.sqlite"),
        }),
      ).rejects.toThrow(
        "active Task control reservation ledger is inconsistent",
      );
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    ["event", "exhaustRestartEventReserve"],
    ["byte", "underfundTaskReservationLedger"],
  ] as const)(
    "fails closed when a paused Task loses its cancellation %s reserve",
    async (_kind, probe) => {
      const fixture = await openStore();
      try {
        await fixture.store.submit(submit());
        await fixture.store.transitionTasks({
          fromState: "queued",
          toState: "paused",
          reason: "daemon_restart",
          eventType: "daemon_restart_paused",
        });
        await fixture.store.probe(probe);
        await fixture.store.close();

        await expect(
          SqliteDurableAdmissionStore.open({
            databasePath: join(fixture.directory, "store.sqlite"),
          }),
        ).rejects.toThrow(
          "active Task control reservation ledger is inconsistent",
        );
      } finally {
        await fixture.dispose();
      }
    },
  );

  it("canonicalizes a symlinked database directory before creating its reserve", async () => {
    const fixture = await openStore();
    let canonicalStore: SqliteDurableAdmissionStore | undefined;
    try {
      const actualDirectory = join(fixture.directory, "actual");
      const aliasDirectory = join(fixture.directory, "alias");
      await mkdir(actualDirectory);
      await symlink(actualDirectory, aliasDirectory, "dir");
      canonicalStore = await SqliteDurableAdmissionStore.open({
        databasePath: join(aliasDirectory, "canonical.sqlite"),
      });
      await canonicalStore.submit(submit());

      expect(
        (await stat(join(actualDirectory, "canonical.sqlite"))).size,
      ).toBeGreaterThan(0);
      await expect(
        stat(join(actualDirectory, "canonical.sqlite.control-reserve")),
      ).resolves.toMatchObject({ size: 128 * 1024 });
    } finally {
      await canonicalStore?.close();
      await fixture.dispose();
    }
  });

  it.each([":memory:", "relative.sqlite", "file:/tmp/agentport.sqlite"])(
    "rejects non-durable database path %s",
    (databasePath) => {
      expect(() => new SqliteDurableAdmissionStore({ databasePath })).toThrow(
        "databasePath must be an absolute durable filesystem path",
      );
    },
  );

  it("releases only the restart slice and keeps physical bytes for later cancellation", async () => {
    const fixture = await openStore({
      queueGlobal: 1,
      physicalControlReserveBytes: 128 * 1024,
      taskControlReserveBytes: 128 * 1024,
    });
    try {
      await fixture.store.submit(submit());
      await fixture.store.transitionTasks({
        fromState: "queued",
        toState: "paused",
        reason: "daemon_restart",
        eventType: "daemon_restart_paused",
      });
      expect(
        await fixture.store.probe("inspectPhysicalCapacity"),
      ).toMatchObject({
        controlReserveBytes: 64 * 1024,
        reservedControlBytes: 64 * 1024,
      });

      await fixture.store.cancel({
        accessScopeId: "scope-a",
        principalId: "principal-a",
        operationId: "cancel-after-physical-restart",
        fingerprint: "cancel-after-physical-restart-fingerprint",
        taskId: "task-1",
        expectedStates: ["queued", "paused"],
        nextState: "canceled",
        eventType: "canceled",
      });
      expect(
        await fixture.store.probe("inspectPhysicalCapacity"),
      ).toMatchObject({
        controlReserveBytes: 0,
        reservedControlBytes: 0,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    "activeExecutionCapacity",
    "queuePerWorkspace",
    "auditCapacity",
    "queueGlobal",
    "receiptCapacity",
    "admissionBytes",
    "physicalAdmissionBytes",
    "physicalControlReserveBytes",
    "taskControlReserveBytes",
    "controlReceiptReserve",
    "controlEventReserve",
    "terminalRetentionDays",
    "retentionSweepIntervalMs",
    "busyTimeoutMs",
    "requestTimeoutMs",
  ] as const)("rejects an invalid %s before starting storage", (option) => {
    expect(
      () =>
        new SqliteDurableAdmissionStore({
          databasePath: "/does/not/matter.sqlite",
          [option]: 0,
        }),
    ).toThrow(`${option} must be a positive safe integer`);
  });

  it("reserves separate reply and terminal control receipts", () => {
    expect(
      () =>
        new SqliteDurableAdmissionStore({
          databasePath: "/does/not/matter.sqlite",
          controlReceiptReserve: 1,
        }),
    ).toThrow(
      "controlReceiptReserve must reserve reply and terminal control receipts",
    );
  });

  it("requires event reserve for both restart and cancellation", () => {
    expect(
      () =>
        new SqliteDurableAdmissionStore({
          databasePath: "/does/not/matter.sqlite",
          controlEventReserve: 1,
        }),
    ).toThrow("must reserve restart and cancellation events");
  });

  it("requires physical control headroom for every admitted queue slot", () => {
    expect(
      () =>
        new SqliteDurableAdmissionStore({
          databasePath: "/does/not/matter.sqlite",
          queueGlobal: 2,
          physicalControlReserveBytes: 128 * 1024,
          taskControlReserveBytes: 128 * 1024,
        }),
    ).toThrow("must cover every queued Task reserve");
  });

  it("reserves enough per-Task control bytes for the reply write tranche", () => {
    expect(
      () =>
        new SqliteDurableAdmissionStore({
          databasePath: "/does/not/matter.sqlite",
          physicalControlReserveBytes: 256 * 1024 * 1024,
          taskControlReserveBytes: 64 * 1024,
        }),
    ).toThrow("must reserve at least 128 KiB for reply control writes");
  });

  it.each([
    [
      "global queue",
      { queueGlobal: 1 },
      {
        agentId: "agent-b",
        binding: {
          ...submit().binding,
          workspaceIdentity: {
            canonicalPath: "/fixture/workspace-b",
            filesystemIdentity: "workspace-b",
          },
        },
      },
      "queue_capacity",
    ],
    [
      "per-Workspace queue",
      { queueGlobal: 10, queuePerWorkspace: 1 },
      {},
      "queue_capacity",
    ],
    [
      "logical admission bytes",
      { admissionBytes: 12 },
      { instruction: "another durable task" },
      "storage_capacity",
    ],
  ] as const)(
    "rejects %s exhaustion without evicting an accepted Task",
    async (_label, options, secondOverrides, expectedCode) => {
      const fixture = await openStore(options);
      try {
        await fixture.store.submit(submit({ instruction: "first" }));
        await expect(
          fixture.store.submit(
            submit({
              operationId: "submit-2",
              taskId: "task-2",
              contextId: "context-2",
              binding: { ...submit().binding, bindingSnapshotId: "binding-2" },
              ...secondOverrides,
            }),
          ),
        ).rejects.toMatchObject({ code: expectedCode });
        await expect(
          fixture.store.getTask({
            accessScopeId: "scope-a",
            allowedAgentIds: ["agent-a", "agent-b"],
            taskId: "task-1",
          }),
        ).resolves.toMatchObject({ taskId: "task-1" });
      } finally {
        await fixture.dispose();
      }
    },
  );
});
