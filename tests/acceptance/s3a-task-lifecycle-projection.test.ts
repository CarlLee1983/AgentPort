import { afterEach, describe, expect, it } from "vitest";

import {
  createDurableAdmissionFixture,
  SCOPE_A_TOKEN,
  SCOPE_B_TOKEN,
} from "../fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
  expectStructuredTextAgreement,
  startDurableAdmissionMcpEndpoint,
} from "../fixtures/durable-admission-mcp.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(
    resources
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
});

function track<T extends { close(): Promise<void> }>(resource: T): T {
  resources.push(() => resource.close());
  return resource;
}

function structured(result: {
  structuredContent?: unknown;
}): Record<string, unknown> {
  expect(result.structuredContent).toBeTypeOf("object");
  return result.structuredContent as Record<string, unknown>;
}

describe("S3-A Task lifecycle projection", () => {
  it("uses get_task as the only authorized bounded lifecycle projection", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const preparedTask = await fixture.service.submitTask(
      { principalId: "principal-a" },
      {
        operationId: "s3a-project-prepared",
        agentId: "agent-a",
        instruction: "project prepared execution",
      },
    );
    const stoppingTask = await fixture.service.submitTask(
      { principalId: "principal-a" },
      {
        operationId: "s3a-project-stopping",
        agentId: "agent-revokable",
        instruction: "project stopping execution",
      },
    );
    await fixture.prepareExecution(
      { principalId: "principal-a" },
      { taskId: preparedTask.task.taskId },
    );
    await fixture.prepareExecution(
      { principalId: "principal-a" },
      { taskId: stoppingTask.task.taskId },
    );
    const stoppingReference = await fixture.executionReference(
      { principalId: "principal-a" },
      { taskId: stoppingTask.task.taskId },
    );
    await fixture.recordObservation(
      { principalId: "principal-a" },
      {
        taskId: stoppingTask.task.taskId,
        observation: {
          reference: stoppingReference,
          kind: "progress",
          ordinal: 1,
          summary: "bounded external progress",
        },
      },
    );
    await fixture.recordObservation(
      { principalId: "principal-a" },
      {
        taskId: stoppingTask.task.taskId,
        observation: {
          reference: stoppingReference,
          kind: "candidate",
          ordinal: 2,
          finalOrdinal: 2,
          outcome: {
            kind: "completed",
            summary: "private candidate content",
          },
        },
      },
    );

    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const clientA = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const clientB = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );

    const tools = await clientA.listTools();
    expect(tools.tools.map(({ name }) => name)).not.toContain(
      "agentport_get_execution_lifecycle",
    );

    const prepared = await clientA.callTool({
      name: "agentport_get_task",
      arguments: { taskId: preparedTask.task.taskId },
    });
    expectStructuredTextAgreement(prepared);
    expect(structured(prepared)).toMatchObject({
      ok: true,
      task: {
        taskId: preparedTask.task.taskId,
        execution: {
          state: "prepared",
          progress: null,
          candidateAvailable: false,
          stopReason: null,
          quarantined: false,
        },
        readiness: { status: "blocked", reason: "g1_unproven" },
      },
    });

    const stopping = await clientA.callTool({
      name: "agentport_get_task",
      arguments: { taskId: stoppingTask.task.taskId },
    });
    expectStructuredTextAgreement(stopping);
    expect(structured(stopping)).toMatchObject({
      ok: true,
      task: {
        execution: {
          state: "stopping",
          progress: { ordinal: 1, summary: "bounded external progress" },
          candidateAvailable: true,
          finalOrdinal: 2,
          stopReason: "completion",
          quarantined: false,
        },
        readiness: { status: "blocked", reason: "g1_unproven" },
      },
    });
    expect(JSON.stringify(stopping)).not.toMatch(
      /generation|daemonEpoch|launchProfile|workspaceIdentity|private candidate content/i,
    );

    const crossScope = await clientB.callTool({
      name: "agentport_get_task",
      arguments: { taskId: preparedTask.task.taskId },
    });
    expect(crossScope.isError).toBe(true);
    expect(structured(crossScope)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });

    await fixture.service.initializeAfterRestart();
    const recovering = await clientA.callTool({
      name: "agentport_get_task",
      arguments: { taskId: stoppingTask.task.taskId },
    });
    expect(structured(recovering)).toMatchObject({
      ok: true,
      task: {
        execution: {
          state: "recovering",
          candidateAvailable: true,
          recoveryReason: "daemon_restart",
          quarantined: true,
        },
        readiness: { status: "blocked", reason: "g1_unproven" },
      },
    });
  });
});
