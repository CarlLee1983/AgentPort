import { afterEach, describe, expect, it } from "vitest";

import type {
  ExecutionSupervisor,
  SupervisorStartResult,
} from "../../src/core/execution-supervisor.js";
import { StorageIncidentCoordinator } from "../../src/bootstrap/storage-incident-coordinator.js";
import {
  createDurableAdmissionFixture,
  SCOPE_A_TOKEN,
} from "../fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
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

class NoopSupervisor implements ExecutionSupervisor {
  start(): Promise<SupervisorStartResult> {
    return Promise.resolve({ kind: "pending" });
  }

  revokeAndStop() {
    return Promise.resolve({ kind: "pending" } as const);
  }

  reconcile() {
    return Promise.resolve({ kind: "indeterminate" } as const);
  }
}

describe("S5 storage-failure MCP projection", () => {
  it("returns only an authorized committed stale snapshot and redacts internal failure details", async () => {
    const incidents = new StorageIncidentCoordinator(new NoopSupervisor(), 4);
    const fixture = track(
      await createDurableAdmissionFixture(
        {},
        { storageIncidentSafety: incidents },
        incidents,
      ),
    );
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );

    const ownSubmit = structured(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "storage-projection-own-submit",
          agentId: "agent-a",
          instruction: "retain an authorized committed snapshot",
        },
      }),
    );
    const ownTask = ownSubmit.task as Record<string, unknown>;
    const foreign = await fixture.service.submitTask(
      { principalId: "principal-b" },
      {
        operationId: "storage-projection-foreign-submit",
        agentId: "agent-b",
        instruction: "foreign-private-storage-sentinel",
      },
    );

    await expect(fixture.store.probe("exitClean")).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    expect(incidents.isLatched()).toBe(true);

    const stale = structured(
      await client.callTool({
        name: "agentport_get_task",
        arguments: { taskId: ownTask.taskId },
      }),
    );
    expect(stale).toMatchObject({
      ok: true,
      task: {
        taskId: ownTask.taskId,
        observationStatus: "stale",
      },
    });

    const foreignRead = structured(
      await client.callTool({
        name: "agentport_get_task",
        arguments: { taskId: foreign.task.taskId },
      }),
    );
    expect(foreignRead).toMatchObject({
      ok: false,
      error: { code: "observation_unavailable" },
    });

    const unavailableMutation = structured(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "storage-projection-late-submit",
          agentId: "agent-a",
          instruction: "must remain closed",
        },
      }),
    );
    expect(unavailableMutation).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });

    const projection = JSON.stringify({ foreignRead, unavailableMutation });
    expect(projection).not.toContain("foreign-private-storage-sentinel");
    expect(projection).not.toContain(fixture.databasePath);
    expect(projection).not.toContain("storage worker exited");
    expect(projection).not.toContain("executionId");
  });
});
