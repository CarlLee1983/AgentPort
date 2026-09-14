import { describe, expect, it } from "vitest";

import type { ExecutionReference } from "../../src/core/types.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

const actor = { principalId: "principal-a" };

async function preparedFixture() {
  const fixture = await createDurableAdmissionFixture();
  const submitted = await fixture.service.submitTask(actor, {
    operationId: "s3a-invalid-observation",
    agentId: "agent-a",
    instruction: "quarantine invalid worker evidence",
  });
  await fixture.prepareExecution(actor, { taskId: submitted.task.taskId });
  const reference = await fixture.executionReference(actor, {
    taskId: submitted.task.taskId,
  });
  return { fixture, taskId: submitted.task.taskId, reference };
}

async function expectQuarantined(
  observation: (reference: ExecutionReference) => unknown,
  expected: { lastObservationOrdinal?: number; summary?: string } = {},
): Promise<void> {
  const { fixture, taskId, reference } = await preparedFixture();
  const rawSecret = "credential-path-and-cross-scope-id";
  try {
    let failure: unknown;
    try {
      await fixture.recordObservation(actor, {
        taskId,
        observation: observation(reference),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "operation_conflict" });
    expect(JSON.stringify(failure)).not.toContain(rawSecret);

    const execution = await fixture.store.getExecution({
      accessScopeId: "scope-a",
      allowedAgentIds: ["agent-a"],
      taskId,
    });
    expect(execution).toMatchObject({
      workspaceClaim: "quarantined",
      lastObservationOrdinal: expected.lastObservationOrdinal ?? 0,
      candidateAvailable: false,
    });
    if (expected.summary !== undefined) {
      expect(execution?.progress).toMatchObject({ summary: expected.summary });
    }
    expect(execution).not.toHaveProperty("result");
  } finally {
    await fixture.close();
  }
}

describe("S3-A observation failures", () => {
  it("rejects stale and cross-execution References without disclosing them", async () => {
    await expectQuarantined((reference) => ({
      reference: {
        ...reference,
        generation: "credential-path-and-cross-scope-id",
      },
      kind: "progress",
      ordinal: 1,
      summary: "must not persist",
    }));
    await expectQuarantined((reference) => ({
      reference: {
        ...reference,
        executionId: "credential-path-and-cross-scope-id",
      },
      kind: "progress",
      ordinal: 1,
      summary: "must not persist",
    }));
  });

  it("rejects ordinal gaps and oversized payloads", async () => {
    await expectQuarantined((reference) => ({
      reference,
      kind: "progress",
      ordinal: 2,
      summary: "ordinal one is missing",
    }));
    await expectQuarantined((reference) => ({
      reference,
      kind: "progress",
      ordinal: 1,
      summary: "x".repeat(1025),
    }));
    await expectQuarantined((reference) => ({
      reference,
      kind: "progress",
      ordinal: "1",
      summary: "coercive ordinals are not accepted",
    }));
  });

  it("rejects conflicting duplicates and preserves the original observation", async () => {
    const { fixture, taskId, reference } = await preparedFixture();
    try {
      await fixture.recordObservation(actor, {
        taskId,
        observation: {
          reference,
          kind: "progress",
          ordinal: 1,
          summary: "original bounded progress",
        },
      });
      await expect(
        fixture.recordObservation(actor, {
          taskId,
          observation: {
            reference,
            kind: "progress",
            ordinal: 1,
            summary: "conflicting progress",
          },
        }),
      ).rejects.toMatchObject({ code: "operation_conflict" });

      const execution = await fixture.store.getExecution({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        taskId,
      });
      expect(execution).toMatchObject({
        workspaceClaim: "quarantined",
        lastObservationOrdinal: 1,
        progress: { summary: "original bounded progress" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("rejects candidate mismatches and spoofed terminal fields", async () => {
    await expectQuarantined((reference) => ({
      reference,
      kind: "candidate",
      ordinal: 1,
      finalOrdinal: 2,
      outcome: { kind: "completed", summary: "mismatched final ordinal" },
    }));
    for (const spoofed of [
      { stopEvidence: "credential-path-and-cross-scope-id" },
      { terminalResult: "credential-path-and-cross-scope-id" },
      { workspaceIdentity: "/credential-path-and-cross-scope-id" },
    ]) {
      await expectQuarantined((reference) => ({
        reference,
        kind: "candidate",
        ordinal: 1,
        finalOrdinal: 1,
        outcome: { kind: "completed", summary: "must remain nonterminal" },
        ...spoofed,
      }));
    }
  });

  it("rolls observation writes back when the Registry revision changes before commit", async () => {
    const { fixture, taskId, reference } = await preparedFixture();
    try {
      await fixture.store.probe("armCommitBarrier");
      const pending = fixture.recordObservation(actor, {
        taskId,
        observation: {
          reference,
          kind: "progress",
          ordinal: 1,
          summary: "must roll back with the stale authorization revision",
        },
      });
      await fixture.store.probe("waitForCommitBarrier");
      const replacement = fixture.registry.replace({
        ...fixture.registryConfiguration,
        principals: fixture.registryConfiguration.principals.map((principal) =>
          principal.principalId === actor.principalId
            ? { ...principal, allowedAgentIds: ["agent-revokable"] }
            : principal,
        ),
      });
      await fixture.store.probe("waitForRegistryRevision", 2);
      await fixture.store.probe("releaseCommitBarrier");

      await expect(pending).rejects.toMatchObject({
        code: "operation_conflict",
        retryable: false,
      });
      await replacement;
      await expect(
        fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId,
        }),
      ).resolves.toMatchObject({
        lastObservationOrdinal: 0,
        workspaceClaim: "held",
      });
    } finally {
      await fixture.store.probe("releaseCommitBarrier").catch(() => undefined);
      await fixture.close();
    }
  });
});
