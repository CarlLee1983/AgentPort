import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { AgentRegistry } from "../../src/bootstrap/registry.js";
import { StorageIncidentCoordinator } from "../../src/bootstrap/storage-incident-coordinator.js";
import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import type {
  ExecutionSupervisor,
  SupervisorStartResult,
} from "../../src/core/execution-supervisor.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
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
  const cleanupErrors: Error[] = [];
  for (const close of resources.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error : new Error("G5 fixture cleanup failed"),
      );
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "G5 fixture cleanup failed");
  }
});

function isStorageUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "storage_unavailable"
  );
}

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

class IndeterminateSupervisor implements ExecutionSupervisor {
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

describe("G5 crash-window projection through the official MCP Client", () => {
  it("projects a stop-unknown recovery only to its Access Scope without inventing success", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const clientA = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const clientB = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );
    const own = structured(
      await clientA.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "g5-stop-unknown-own-submit",
          agentId: "agent-a",
          instruction: "keep the authorized recovery projection bounded",
        },
      }),
    );
    const ownTask = own.task as Record<string, unknown>;
    const foreignInstruction = "G5-FOREIGN-RECOVERY-PRIVATE";
    const foreign = structured(
      await clientB.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "g5-stop-unknown-foreign-submit",
          agentId: "agent-b",
          instruction: foreignInstruction,
        },
      }),
    );
    const foreignTask = foreign.task as Record<string, unknown>;

    await fixture.prepareExecution(
      { principalId: "principal-a" },
      { taskId: String(ownTask.taskId) },
    );
    const reference = await fixture.executionReference(
      { principalId: "principal-a" },
      { taskId: String(ownTask.taskId) },
    );
    await fixture.recordIndeterminateSupervisorResult(
      { principalId: "principal-a" },
      { taskId: String(ownTask.taskId), reference },
    );

    const recovered = await clientA.callTool({
      name: "agentport_get_task",
      arguments: { taskId: ownTask.taskId },
    });
    expectStructuredTextAgreement(recovered);
    expect(structured(recovered)).toMatchObject({
      ok: true,
      task: {
        taskId: ownTask.taskId,
        state: "paused",
        result: null,
        execution: {
          state: "recovering",
          candidateAvailable: false,
          quarantined: true,
        },
      },
    });

    const foreignRead = await clientA.callTool({
      name: "agentport_get_task",
      arguments: { taskId: foreignTask.taskId },
    });
    expectStructuredTextAgreement(foreignRead);
    expect(structured(foreignRead)).toMatchObject({
      ok: false,
      error: { code: "not_found", retryable: false, safeRetry: "none" },
    });
    const projection = JSON.stringify({ recovered, foreignRead });
    expect(projection).not.toContain(foreignInstruction);
    expect(projection).not.toContain(String(foreignTask.taskId));
    expect(projection).not.toContain("completed");
  });

  it("does not let Context resume clear a recovery blocker after restart", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const predecessor = await fixture.service.submitTask(
      { principalId: "principal-a" },
      {
        operationId: "g5-recovery-blocker-predecessor",
        agentId: "agent-a",
        instruction: "leave the predecessor awaiting exact reconciliation",
      },
    );
    const successor = await fixture.service.submitTask(
      { principalId: "principal-a" },
      {
        operationId: "g5-recovery-blocker-successor",
        agentId: "agent-a",
        contextId: predecessor.task.contextId,
        instruction: "remain blocked while recovery is unknown",
      },
    );
    const preparation = await fixture.service.prepareForDispatch(
      predecessor.task.taskId,
      "g5-recovery-blocker-daemon-epoch",
    );
    await fixture.service.markExecutionRunning(preparation.reference);
    await fixture.store.close();

    const store = track(
      await SqliteDurableAdmissionStore.open({
        databasePath: fixture.databasePath,
      }),
    );
    const registry = await AgentRegistry.create(
      fixture.registryConfiguration,
      store,
    );
    const service = new DurableAgentExecutionService(registry, store, {
      cursorSecret: "g5-recovery-blocker-secret",
    });
    await service.initializeAfterRestart();

    const endpoint = track(
      await startDurableAdmissionMcpEndpoint({
        ...fixture,
        registry,
        service,
        store,
      }),
    );
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const blocked = structured(
      await client.callTool({
        name: "agentport_get_task",
        arguments: { taskId: successor.task.taskId },
      }),
    );
    const blockedTask = blocked.task as Record<string, unknown>;
    expect(blockedTask).toMatchObject({
      state: "paused",
      blocker: {
        predecessorTaskId: predecessor.task.taskId,
        state: "recovering",
      },
    });

    const resume = await client.callTool({
      name: "agentport_resume_context",
      arguments: {
        operationId: "g5-recovery-blocker-resume",
        contextId: predecessor.task.contextId,
        expectedRevision: blockedTask.contextRevision,
        continuationMode: "fresh_session",
        contextSummary: "do not override unknown stop state",
      },
    });
    expectStructuredTextAgreement(resume);
    expect(structured(resume)).toMatchObject({
      ok: false,
      error: { code: "invalid_state", retryable: false, safeRetry: "none" },
    });
  });

  it("keeps an ordinal-gap quarantine through two restarts without projecting a result", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const submitted = await fixture.service.submitTask(
      { principalId: "principal-a" },
      {
        operationId: "g5-ordinal-gap-submit",
        agentId: "agent-a",
        instruction: "quarantine a missing first worker observation",
      },
    );
    await fixture.prepareExecution(
      { principalId: "principal-a" },
      { taskId: submitted.task.taskId },
    );
    const reference = await fixture.executionReference(
      { principalId: "principal-a" },
      { taskId: submitted.task.taskId },
    );
    await expect(
      fixture.recordObservation(
        { principalId: "principal-a" },
        {
          taskId: submitted.task.taskId,
          observation: {
            reference,
            kind: "candidate",
            ordinal: 2,
            finalOrdinal: 2,
            outcome: { kind: "completed", summary: "untrusted success" },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "operation_conflict" });
    await fixture.store.close();

    let lastRegistry: AgentRegistry | undefined;
    let lastService: DurableAgentExecutionService | undefined;
    let lastStore: SqliteDurableAdmissionStore | undefined;
    for (let restart = 0; restart < 2; restart += 1) {
      const store = track(
        await SqliteDurableAdmissionStore.open({
          databasePath: fixture.databasePath,
        }),
      );
      const registry = await AgentRegistry.create(
        fixture.registryConfiguration,
        store,
      );
      const service = new DurableAgentExecutionService(registry, store, {
        cursorSecret: `g5-ordinal-gap-restart-${String(restart)}`,
      });
      await service.initializeAfterRestart();
      await expect(
        store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        workspaceClaim: "quarantined",
        lastObservationOrdinal: 0,
        candidateAvailable: false,
      });
      if (restart === 0) {
        await store.close();
      } else {
        lastRegistry = registry;
        lastService = service;
        lastStore = store;
      }
    }
    if (
      lastRegistry === undefined ||
      lastService === undefined ||
      lastStore === undefined
    ) {
      throw new Error("Missing second recovery fixture");
    }

    const endpoint = track(
      await startDurableAdmissionMcpEndpoint({
        ...fixture,
        registry: lastRegistry,
        service: lastService,
        store: lastStore,
      }),
    );
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const observed = await client.callTool({
      name: "agentport_get_task",
      arguments: { taskId: submitted.task.taskId },
    });
    expectStructuredTextAgreement(observed);
    expect(structured(observed)).toMatchObject({
      ok: true,
      task: {
        taskId: submitted.task.taskId,
        result: null,
        execution: {
          candidateAvailable: false,
          quarantined: true,
        },
      },
    });
    expect(JSON.stringify(observed)).not.toContain("untrusted success");
  });

  it("does not turn a recovery into success during a storage-worker outage", async () => {
    const incidents = new StorageIncidentCoordinator(
      new IndeterminateSupervisor(),
      4,
    );
    const fixture = await createDurableAdmissionFixture(
      {},
      { storageIncidentSafety: incidents },
      incidents,
    );
    resources.push(async () => {
      try {
        await fixture.close();
      } catch (error) {
        if (!isStorageUnavailable(error)) throw error;
        await rm(fixture.directory, { force: true, recursive: true });
      }
    });
    const endpoint = await startDurableAdmissionMcpEndpoint(fixture);
    resources.push(async () => {
      try {
        await endpoint.close();
      } catch (error) {
        if (!isStorageUnavailable(error)) throw error;
      }
    });
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const submitted = await fixture.service.submitTask(
      { principalId: "principal-a" },
      {
        operationId: "g5-storage-unknown-own-submit",
        agentId: "agent-a",
        instruction: "keep this result unknown across a storage outage",
      },
    );
    const foreignInstruction = "G5-FOREIGN-STORAGE-PRIVATE";
    const foreign = await fixture.service.submitTask(
      { principalId: "principal-b" },
      {
        operationId: "g5-storage-unknown-foreign-submit",
        agentId: "agent-b",
        instruction: foreignInstruction,
      },
    );
    await fixture.prepareExecution(
      { principalId: "principal-a" },
      { taskId: submitted.task.taskId },
    );
    const reference = await fixture.executionReference(
      { principalId: "principal-a" },
      { taskId: submitted.task.taskId },
    );
    await fixture.recordIndeterminateSupervisorResult(
      { principalId: "principal-a" },
      { taskId: submitted.task.taskId, reference },
    );
    const beforeOutage = await client.callTool({
      name: "agentport_get_task",
      arguments: { taskId: submitted.task.taskId },
    });
    expectStructuredTextAgreement(beforeOutage);
    expect(structured(beforeOutage)).toMatchObject({
      ok: true,
      task: {
        result: null,
        execution: { state: "recovering", quarantined: true },
      },
    });

    await expect(fixture.store.probe("exitClean")).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    expect(incidents.isLatched()).toBe(true);
    const stale = await client.callTool({
      name: "agentport_get_task",
      arguments: { taskId: submitted.task.taskId },
    });
    expectStructuredTextAgreement(stale);
    expect(structured(stale)).toMatchObject({
      ok: true,
      task: {
        result: null,
        observationStatus: "stale",
        execution: { state: "recovering", quarantined: true },
      },
    });
    const foreignRead = await client.callTool({
      name: "agentport_get_task",
      arguments: { taskId: foreign.task.taskId },
    });
    expectStructuredTextAgreement(foreignRead);
    expect(structured(foreignRead)).toMatchObject({
      ok: false,
      error: { code: "observation_unavailable" },
    });
    const lateMutation = await client.callTool({
      name: "agentport_submit_task",
      arguments: {
        operationId: "g5-storage-unknown-late-submit",
        agentId: "agent-a",
        instruction: "must not enter after storage loss",
      },
    });
    expectStructuredTextAgreement(lateMutation);
    expect(structured(lateMutation)).toMatchObject({
      ok: false,
      error: { code: "storage_unavailable" },
    });
    const projection = JSON.stringify({ stale, foreignRead, lateMutation });
    expect(projection).not.toContain(foreignInstruction);
    expect(projection).not.toContain(fixture.databasePath);
    expect(projection).not.toContain("completed");
  });
});
