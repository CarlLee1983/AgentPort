import { describe, expect, it } from "vitest";
import { openStore, submit } from "../fixtures/durable-store.js";

describe("admission failures", () => {
  it("rolls back injected commit failure without a partial task", async () => {
    const fixture = await openStore();
    try {
      await fixture.store.probe("failNextCommit");
      await expect(fixture.store.submit(submit())).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await expect(
        fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: "task-1",
        }),
      ).resolves.toBeUndefined();
      await expect(
        fixture.store.probe("inspectPhysicalCapacity"),
      ).resolves.toMatchObject({
        controlReserveBytes: 0,
        reservedControlBytes: 0,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("restores physical control bytes when cancellation rolls back", async () => {
    const fixture = await openStore();
    try {
      await fixture.store.submit(submit());
      await fixture.store.probe("failNextCommit");
      await expect(
        fixture.store.cancel({
          accessScopeId: "scope-a",
          principalId: "principal-a",
          operationId: "cancel-rollback",
          fingerprint: "cancel-rollback-fingerprint",
          taskId: "task-1",
          expectedStates: ["queued", "paused"],
          nextState: "canceled",
          eventType: "canceled",
        }),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(
        fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: "task-1",
        }),
      ).resolves.toMatchObject({ state: "queued", revision: 1 });
      await expect(
        fixture.store.probe("inspectPhysicalCapacity"),
      ).resolves.toMatchObject({
        controlReserveBytes: 128 * 1024,
        reservedControlBytes: 128 * 1024,
      });
    } finally {
      await fixture.dispose();
    }
  });
});
