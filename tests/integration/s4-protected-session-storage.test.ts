import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sessionReferenceFor } from "../../src/runtime/claude/session-reference.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

describe("S4 protected Claude Session storage", () => {
  it("encrypts a Reference-bound worker token without exposing it in observations", async () => {
    const rawToken = "claude-session-01J8D7K2WQ6YB8P4M3N5R7T9VX";
    const fixture = await createDurableAdmissionFixture({
      continuationEncryptionKey: randomBytes(32).toString("base64url"),
    });
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "s4-protected-session-submit",
        agentId: "agent-a",
        instruction: "persist only an encrypted continuation token",
      });
      await fixture.prepareExecution(actor, { taskId: submitted.task.taskId });
      const reference = await fixture.executionReference(actor, {
        taskId: submitted.task.taskId,
      });
      const sessionReference = sessionReferenceFor(reference, rawToken);

      await fixture.recordObservation(actor, {
        taskId: submitted.task.taskId,
        observation: {
          kind: "candidate",
          reference,
          ordinal: 1,
          finalOrdinal: 1,
          outcome: { kind: "completed", summary: "finished safely" },
          sessionReference,
          protectedSessionToken: rawToken,
        },
      });

      await expect(
        fixture.store.probe("inspectProtectedSessionTokens"),
      ).resolves.toEqual([
        expect.objectContaining({
          sessionReference,
          sourceExecutionId: reference.executionId,
          contextId: submitted.task.contextId,
          state: "candidate",
          nonceBytes: 12,
          authTagBytes: 16,
        }),
      ]);
      const execution = await fixture.store.getExecution({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        taskId: submitted.task.taskId,
      });
      expect(JSON.stringify(execution)).not.toContain(rawToken);
      const events = await fixture.store.getEvents({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        taskId: submitted.task.taskId,
        limit: 10,
      });
      expect(JSON.stringify(events)).not.toContain(rawToken);
    } finally {
      await fixture.close();
    }
  });
});
