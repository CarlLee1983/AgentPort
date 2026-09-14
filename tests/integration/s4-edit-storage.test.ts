import { describe, expect, it } from "vitest";

import { openStore, submit } from "../fixtures/durable-store.js";

describe("S4 durable queued Task edit", () => {
  it("commits one expected-revision edit with a durable receipt and event", async () => {
    const fixture = await openStore();
    try {
      const accepted = await fixture.store.submit(submit());
      if (accepted.replayed)
        throw new Error("fixture submit unexpectedly replayed");

      const request = {
        accessScopeId: "scope-a",
        operationId: "s4-edit-1",
        fingerprint: "s4-edit-1-fingerprint",
        principalId: "principal-a",
        expectedRegistryRevision: 0,
        allowedAgentIds: ["agent-a"],
        taskId: accepted.task.taskId,
        expectedRevision: accepted.task.revision,
        instruction: "edited durable task",
        now: "2026-09-14T00:00:00.000Z",
      };
      await expect(fixture.store.edit(request)).resolves.toMatchObject({
        replayed: false,
        task: {
          taskId: accepted.task.taskId,
          instruction: "edited durable task",
          revision: accepted.task.revision + 1,
        },
      });
      await expect(fixture.store.edit(request)).resolves.toEqual({
        replayed: true,
        task: { taskId: accepted.task.taskId },
      });
      await expect(
        fixture.store.edit({
          ...request,
          operationId: "s4-edit-stale",
          fingerprint: "s4-edit-stale-fingerprint",
          expectedRevision: accepted.task.revision,
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      await expect(
        fixture.store.getEvents({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: accepted.task.taskId,
          limit: 10,
        }),
      ).resolves.toMatchObject({
        events: [{ type: "accepted" }, { type: "edited" }],
      });
    } finally {
      await fixture.dispose();
    }
  });
});
