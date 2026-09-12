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

describe("execution lifecycle projections", () => {
  it("returns only an authorized bounded lifecycle snapshot", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const task = await fixture.service.submitTask(
      { principalId: "principal-a" },
      {
        operationId: "project-prepared-execution",
        agentId: "agent-a",
        instruction: "prepare only; do not dispatch",
      },
    );
    await fixture.prepareExecution(
      { principalId: "principal-a" },
      { taskId: task.task.taskId },
    );
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const clientA = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const clientB = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );
    await clientA.listTools();
    await clientB.listTools();

    const permitted = await clientA.callTool({
      name: "agentport_get_execution_lifecycle",
      arguments: { taskId: task.task.taskId },
    });
    expectStructuredTextAgreement(permitted);
    expect(structured(permitted)).toMatchObject({
      ok: true,
      lifecycle: {
        taskId: task.task.taskId,
        state: "prepared",
        candidateOutcome: null,
        quarantined: false,
      },
    });
    expect(JSON.stringify(permitted)).not.toMatch(
      /generation|daemonEpoch|launchProfile|workspaceIdentity/i,
    );

    const crossScope = await clientB.callTool({
      name: "agentport_get_execution_lifecycle",
      arguments: { taskId: task.task.taskId },
    });
    expect(crossScope.isError).toBe(true);
    expect(structured(crossScope)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});
