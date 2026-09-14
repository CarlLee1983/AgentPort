import { describe, expect, it } from "vitest";

import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";
import { openStore, submit } from "../fixtures/durable-store.js";

const actor = { principalId: "principal-a" };

function editRequest(
  taskId: string,
  expectedRevision: number,
  operationId: string,
  instruction: string,
) {
  return {
    accessScopeId: "scope-a",
    operationId,
    fingerprint: `${operationId}-fingerprint`,
    principalId: "principal-a",
    expectedRegistryRevision: 0,
    allowedAgentIds: ["agent-a"],
    taskId,
    expectedRevision,
    instruction,
    now: "2026-09-14T00:00:00.000Z",
  };
}

describe("S4 durable Task edit transactions", () => {
  it("edits never-started queued and paused Tasks through their authorized durable projection", async () => {
    const fixture = await openStore();
    try {
      const accepted = await fixture.store.submit(submit());
      if (accepted.replayed)
        throw new Error("fixture submit unexpectedly replayed");
      const queuedEdit = await fixture.store.edit(
        editRequest(
          accepted.task.taskId,
          accepted.task.revision,
          "edit-queued",
          "queued instruction",
        ),
      );
      if (queuedEdit.replayed)
        throw new Error("fixture queued edit unexpectedly replayed");
      await fixture.store.transitionTasks({
        fromState: "queued",
        toState: "paused",
        reason: "daemon_restart",
        eventType: "daemon_restart_paused",
      });
      const pausedEdit = await fixture.store.edit(
        editRequest(
          accepted.task.taskId,
          queuedEdit.task.revision + 1,
          "edit-paused",
          "paused instruction",
        ),
      );
      if (pausedEdit.replayed)
        throw new Error("fixture paused edit unexpectedly replayed");

      await expect(
        fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: accepted.task.taskId,
        }),
      ).resolves.toMatchObject({
        taskId: accepted.task.taskId,
        state: "paused",
        instruction: "paused instruction",
        revision: pausedEdit.task.revision,
      });
      await expect(
        fixture.store.getEvents({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: accepted.task.taskId,
          limit: 10,
        }),
      ).resolves.toMatchObject({
        events: [
          { type: "accepted" },
          { type: "edited" },
          { type: "daemon_restart_paused" },
          { type: "edited" },
        ],
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("linearizes concurrent expected-revision edits with one committed instruction and event", async () => {
    const fixture = await openStore();
    try {
      const accepted = await fixture.store.submit(submit());
      if (accepted.replayed)
        throw new Error("fixture submit unexpectedly replayed");
      await fixture.store.probe("armCommitBarrier");
      const first = fixture.store.edit(
        editRequest(
          accepted.task.taskId,
          accepted.task.revision,
          "edit-race-first",
          "first committed instruction",
        ),
      );
      await fixture.store.probe("waitForCommitBarrier");
      const second = fixture.store.edit(
        editRequest(
          accepted.task.taskId,
          accepted.task.revision,
          "edit-race-second",
          "stale concurrent instruction",
        ),
      );
      await fixture.store.probe("releaseCommitBarrier");

      const attempts = await Promise.allSettled([first, second]);
      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        attempts.find((attempt) => attempt.status === "rejected"),
      ).toMatchObject({
        reason: { code: "operation_conflict" },
      });
      await expect(
        fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: accepted.task.taskId,
        }),
      ).resolves.toMatchObject({
        instruction: "first committed instruction",
        revision: accepted.task.revision + 1,
      });
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
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await fixture.dispose();
    }
  });

  it("keeps the dispatch winner and its stable authorized projection when a queued edit loses", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "edit-dispatch-submit",
        agentId: "agent-a",
        instruction: "instruction must not change after dispatch commits",
      });
      await fixture.store.probe("armCommitBarrier");
      const dispatch = fixture.prepareExecution(actor, {
        taskId: submitted.task.taskId,
      });
      await fixture.store.probe("waitForCommitBarrier");
      const edit = fixture.service.editTask(actor, {
        operationId: "edit-loses-to-dispatch",
        taskId: submitted.task.taskId,
        expectedRevision: submitted.task.revision,
        instruction: "late edit must not become a second projection",
      });
      await fixture.store.probe("releaseCommitBarrier");

      await expect(dispatch).resolves.toMatchObject({ state: "prepared" });
      await expect(edit).rejects.toMatchObject({ code: "invalid_state" });
      await expect(
        fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
      ).resolves.toMatchObject({
        taskId: submitted.task.taskId,
        instruction: "instruction must not change after dispatch commits",
        revision: submitted.task.revision + 1,
        execution: { state: "prepared" },
      });
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await fixture.close();
    }
  });
});
