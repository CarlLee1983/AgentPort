import { describe, expect, it } from "vitest";

import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

describe("S3-A observation transactions", () => {
  it("persists one contiguous sequence and idempotently replays identical observations", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "s3a-observation-sequence",
        agentId: "agent-a",
        instruction: "retain bounded progress and candidate evidence",
      });
      await fixture.prepareExecution(actor, {
        taskId: submitted.task.taskId,
      });
      const reference = await fixture.executionReference(actor, {
        taskId: submitted.task.taskId,
      });
      const progress = {
        reference,
        kind: "progress" as const,
        ordinal: 1,
        summary: "validated the first durable step",
      };

      const first = await fixture.recordObservation(actor, {
        taskId: submitted.task.taskId,
        observation: progress,
      });
      const duplicate = await fixture.recordObservation(actor, {
        taskId: submitted.task.taskId,
        observation: progress,
      });

      expect(first).toMatchObject({
        replayed: false,
        execution: {
          state: "prepared",
          lastObservationOrdinal: 1,
          progress: {
            ordinal: 1,
            summary: "validated the first durable step",
          },
          candidateAvailable: false,
          stopReason: null,
        },
      });
      expect(duplicate).toMatchObject({
        replayed: true,
        execution: { lastObservationOrdinal: 1 },
      });

      const candidate = {
        reference,
        kind: "candidate" as const,
        ordinal: 2,
        finalOrdinal: 2,
        outcome: {
          kind: "completed" as const,
          summary: "bounded candidate result",
        },
      };
      const committedCandidate = await fixture.recordObservation(actor, {
        taskId: submitted.task.taskId,
        observation: candidate,
      });
      const duplicateCandidate = await fixture.recordObservation(actor, {
        taskId: submitted.task.taskId,
        observation: {
          ...candidate,
          outcome: {
            summary: candidate.outcome.summary,
            kind: candidate.outcome.kind,
          },
        },
      });

      expect(committedCandidate).toMatchObject({
        replayed: false,
        execution: {
          state: "stopping",
          lastObservationOrdinal: 2,
          candidateAvailable: true,
          finalOrdinal: 2,
          stopReason: "completion",
          quarantined: false,
        },
      });
      expect(duplicateCandidate).toMatchObject({
        replayed: true,
        execution: {
          lastObservationOrdinal: 2,
          candidateAvailable: true,
          stopReason: "completion",
        },
      });
    } finally {
      await fixture.close();
    }
  });
});
