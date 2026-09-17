import { rename } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const ACTOR_A = { principalId: "principal-a" };
const ACTOR_B = { principalId: "principal-b" };

describe("DurableAgentExecutionService", () => {
  it("owns admission, projections, pagination, and cancellation", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(ACTOR_A, {
        operationId: "submit-a",
        agentId: "agent-a",
        instruction: "Keep this instruction out of list summaries",
      });
      expect(submitted).toMatchObject({
        replayed: false,
        task: { state: "queued", revision: 1 },
      });

      const replayed = await fixture.service.submitTask(ACTOR_A, {
        operationId: "submit-a",
        agentId: "agent-a",
        instruction: "Keep this instruction out of list summaries",
      });
      expect(replayed).toMatchObject({
        replayed: true,
        task: { taskId: submitted.task.taskId },
      });
      await expect(
        fixture.service.submitTask(ACTOR_A, {
          operationId: "submit-a",
          agentId: "agent-a",
          instruction: "different initial fingerprint",
        }),
      ).rejects.toMatchObject({
        code: "operation_conflict",
        task: {
          taskId: submitted.task.taskId,
          state: "queued",
          observationStatus: "current",
        },
      });

      const listed = await fixture.service.listTasks(ACTOR_A, { limit: 1 });
      expect(listed.tasks).toHaveLength(1);
      expect(listed.tasks[0]).not.toHaveProperty("instruction");
      expect(
        await fixture.service.getTask(ACTOR_A, submitted.task),
      ).toMatchObject({
        taskId: submitted.task.taskId,
        observationStatus: "current",
      });
      expect(
        (
          await fixture.service.getEvents(ACTOR_A, {
            taskId: submitted.task.taskId,
          })
        ).events,
      ).toMatchObject([{ type: "accepted", taskId: submitted.task.taskId }]);

      const canceled = await fixture.service.cancelTask(ACTOR_A, {
        operationId: "cancel-a",
        taskId: submitted.task.taskId,
      });
      expect(canceled.task).toMatchObject({ state: "canceled", revision: 2 });
    } finally {
      await fixture.close();
    }
  });

  it("reauthorizes every operation and never reveals cross-scope targets", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const taskA = await fixture.service.submitTask(ACTOR_A, {
        operationId: "submit-a",
        agentId: "agent-revokable",
        instruction: "scope a",
      });
      const taskB = await fixture.service.submitTask(ACTOR_B, {
        operationId: "submit-b",
        agentId: "agent-b",
        instruction: "scope b",
      });

      await expect(
        fixture.service.getTask(ACTOR_A, { taskId: taskB.task.taskId }),
      ).rejects.toMatchObject({ code: "not_found" });

      const principalA = fixture.registryConfiguration.principals.find(
        ({ principalId }) => principalId === "principal-a",
      );
      if (principalA === undefined)
        throw new Error("Missing fixture Principal");
      await fixture.registry.replace({
        ...fixture.registryConfiguration,
        principals: [
          { ...principalA, allowedAgentIds: ["agent-a"] },
          ...fixture.registryConfiguration.principals.filter(
            ({ principalId }) => principalId !== "principal-a",
          ),
        ],
      });

      expect(
        (await fixture.service.listAgents(ACTOR_A, {})).agents,
      ).toHaveLength(1);
      expect(await fixture.service.listTasks(ACTOR_A, {})).toMatchObject({
        tasks: [],
      });
      await expect(
        fixture.service.getTask(ACTOR_A, { taskId: taskA.task.taskId }),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await fixture.close();
    }
  });

  it("uses one deterministic Agent ID order across pages", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      await fixture.registry.replace({
        ...fixture.registryConfiguration,
        agents: fixture.registryConfiguration.agents.map((agent) =>
          agent.agentId === "agent-a"
            ? { ...agent, agentId: "a" }
            : agent.agentId === "agent-revokable"
              ? { ...agent, agentId: "B" }
              : agent,
        ),
        principals: fixture.registryConfiguration.principals.map((principal) =>
          principal.principalId === "principal-a"
            ? { ...principal, allowedAgentIds: ["a", "B"] }
            : principal,
        ),
      });
      const first = await fixture.service.listAgents(ACTOR_A, { limit: 1 });
      expect(first).toMatchObject({ agents: [{ agentId: "B" }] });
      expect(first.nextCursor).toBeTypeOf("string");
      if (first.nextCursor === null) throw new Error("Expected next cursor");
      const second = await fixture.service.listAgents(ACTOR_A, {
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(second).toMatchObject({
        agents: [{ agentId: "a" }],
        nextCursor: null,
      });
    } finally {
      await fixture.close();
    }
  });

  it("selects a capacity-safe Task prefix only after validating its cursor and filters", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      await fixture.service.submitTask(ACTOR_A, {
        operationId: "submit-capacity-one",
        agentId: "agent-a",
        instruction: "first",
      });
      await fixture.service.submitTask(ACTOR_A, {
        operationId: "submit-capacity-two",
        agentId: "agent-a",
        instruction: "second",
      });
      const candidates: Array<{
        taskCount: number;
        nextCursor: string | null;
      }> = [];
      const first = await fixture.service.listTasks(
        ACTOR_A,
        { agentId: "agent-a", limit: 2 },
        {
          fits(page) {
            candidates.push({
              taskCount: page.tasks.length,
              nextCursor: page.nextCursor,
            });
            return page.tasks.length === 1;
          },
        },
      );

      expect(
        candidates.map(({ taskCount, nextCursor }) => ({
          taskCount,
          hasCursor: nextCursor !== null,
        })),
      ).toEqual([
        { taskCount: 2, hasCursor: false },
        { taskCount: 1, hasCursor: true },
      ]);
      expect(first.tasks).toHaveLength(1);
      expect(typeof first.tasks[0]?.taskId).toBe("string");
      if (first.nextCursor === null) throw new Error("Expected a cursor");

      let selectorRan = false;
      const selector = {
        fits() {
          selectorRan = true;
          return true;
        },
      };
      await expect(
        fixture.service.listTasks(
          ACTOR_A,
          { agentId: "agent-revokable", cursor: first.nextCursor },
          selector,
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        fixture.service.listTasks(ACTOR_A, { cursor: "malformed" }, selector),
      ).rejects.toMatchObject({ code: "not_found" });
      expect(selectorRan).toBe(false);

      const second = await fixture.service.listTasks(
        ACTOR_A,
        { agentId: "agent-a", cursor: first.nextCursor },
        selector,
      );
      expect(selectorRan).toBe(true);
      expect(second.tasks).toHaveLength(1);
      expect(typeof second.tasks[0]?.taskId).toBe("string");
      expect(second.nextCursor).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("keeps Workspace capacity bound to filesystem identity after a directory rename", async () => {
    const fixture = await createDurableAdmissionFixture({
      queueGlobal: 10,
      queuePerWorkspace: 1,
    });
    try {
      await fixture.service.submitTask(ACTOR_A, {
        operationId: "submit-before-workspace-rename",
        agentId: "agent-a",
        instruction: "first",
      });
      const renamedWorkspace = join(fixture.directory, "workspace-a-renamed");
      await rename(join(fixture.directory, "workspace-a"), renamedWorkspace);
      await fixture.registry.replace({
        ...fixture.registryConfiguration,
        agents: fixture.registryConfiguration.agents.map((agent) =>
          agent.agentId === "agent-a"
            ? { ...agent, workspacePath: renamedWorkspace }
            : agent,
        ),
      });

      await expect(
        fixture.service.submitTask(ACTOR_A, {
          operationId: "submit-after-workspace-rename",
          agentId: "agent-a",
          instruction: "second",
        }),
      ).rejects.toMatchObject({ code: "queue_capacity" });
    } finally {
      await fixture.close();
    }
  });

  it("distinguishes authenticated identity from revoked membership internally", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      await fixture.registry.replace({
        ...fixture.registryConfiguration,
        principals: fixture.registryConfiguration.principals.map((principal) =>
          principal.principalId === "principal-a"
            ? { ...principal, active: false }
            : principal,
        ),
      });
      expect(fixture.registry.authenticate("ap002-scope-a-token")).toBe(
        "principal-a",
      );

      const operations = [
        fixture.service.listAgents(ACTOR_A, {}),
        fixture.service.submitTask(ACTOR_A, {
          operationId: "submit-revoked",
          agentId: "agent-a",
          instruction: "not admitted",
        }),
        fixture.service.getTask(ACTOR_A, { taskId: "unknown" }),
        fixture.service.listTasks(ACTOR_A, {}),
        fixture.service.getEvents(ACTOR_A, {}),
        fixture.service.cancelTask(ACTOR_A, {
          operationId: "cancel-revoked",
          taskId: "unknown",
        }),
      ];
      for (const operation of operations) {
        await expect(operation).rejects.toEqual(
          expect.objectContaining({
            code: "membership_revoked",
          }),
        );
      }
    } finally {
      await fixture.close();
    }
  });
});
