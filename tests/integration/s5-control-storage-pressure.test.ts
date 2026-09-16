import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { StorageIncidentCoordinator } from "../../src/bootstrap/storage-incident-coordinator.js";
import type {
  ExecutionSupervisor,
  SupervisorStartResult,
} from "../../src/core/execution-supervisor.js";
import type { ExecutionReference } from "../../src/core/types.js";
import { ControlledRuntimeDispatcher } from "../../src/dispatcher/controlled-runtime-dispatcher.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import {
  createDurableAdmissionFixture,
  SCOPE_A_TOKEN,
} from "../fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
  startDurableAdmissionMcpEndpoint,
} from "../fixtures/durable-admission-mcp.js";
import { openStore, submit } from "../fixtures/durable-store.js";

const QUESTION_SCHEMA = [
  {
    question: "Continue?",
    header: "Continue",
    options: [
      { label: "Yes", description: "Continue execution" },
      { label: "No", description: "Keep waiting" },
    ],
    multiSelect: false,
  },
] as const;
const PRIVATE_DIAGNOSTIC = "AP015-PRIVATE-DIAGNOSTIC-MARKER";

function dispatchRequest(taskId: string, suffix: string) {
  return {
    accessScopeId: "scope-a",
    allowedAgentIds: ["agent-a"],
    expectedRegistryRevision: 0,
    executionId: `ap015-synthetic-execution-${suffix}`,
    taskId,
    generation: `ap015-synthetic-generation-${suffix}`,
    daemonEpoch: "ap015-synthetic-epoch",
    dispatchIntent: true,
    binding: {
      ...submit().binding,
      bindingSnapshotId: `ap015-synthetic-binding-${suffix}`,
      accessScopeId: "scope-a",
      agentId: "agent-a",
      createdAt: "2026-09-15T00:00:00.000Z",
    },
  };
}

async function prepareRunning(
  store: SqliteDurableAdmissionStore,
  taskId: string,
  suffix: string,
) {
  const execution = await store.claimAndPrepare(
    dispatchRequest(taskId, suffix),
  );
  const reference = {
    executionId: execution.executionId,
    generation: execution.generation,
    daemonEpoch: execution.daemonEpoch,
    launchProfileId: execution.launchProfileId,
    workspaceIdentity: execution.workspaceId,
  };
  await store.markExecutionRunning({ reference });
  return reference;
}

function receiptCount(databasePath: string, operationId: string): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database
      .prepare(
        "SELECT count(*) AS count FROM operation_receipts WHERE scope='scope-a' AND operation_id=?",
      )
      .get(operationId) as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

class PendingSupervisor implements ExecutionSupervisor {
  readonly starts: ExecutionReference[] = [];
  readonly stops: ExecutionReference[] = [];

  start(reference: ExecutionReference): Promise<SupervisorStartResult> {
    this.starts.push(reference);
    return Promise.resolve({ kind: "pending" });
  }

  revokeAndStop(reference: ExecutionReference) {
    this.stops.push(reference);
    return Promise.resolve({ kind: "pending" } as const);
  }

  reconcile() {
    return Promise.resolve({ kind: "indeterminate" } as const);
  }
}

describe("S5 existing-Task control under SQLite pressure", () => {
  it("commits a delayed reply before reporting success", async () => {
    const fixture = await openStore({ requestTimeoutMs: 1_000 });
    try {
      const accepted = await fixture.store.submit(
        submit({
          operationId: "ap015-delayed-submit",
          fingerprint: "ap015-delayed-submit",
          taskId: "ap015-delayed-task",
          contextId: "ap015-delayed-context",
        }),
      );
      const reference = await prepareRunning(
        fixture.store,
        accepted.task.taskId,
        "delayed",
      );
      await fixture.store.persistQuestionObservation({
        reference,
        questionId: "ap015-delayed-question",
        toolUseId: "ap015-delayed-tool",
        requestId: "ap015-delayed-request",
        ordinal: 1,
        toolActivity: "none",
        activeElapsedMs: 0,
        schema: QUESTION_SCHEMA,
        expiresAt: "2026-09-16T00:00:00.000Z",
        now: "2026-09-15T00:00:00.000Z",
      });
      const delay = fixture.store.probe("block", 250);
      const reply = fixture.store.replyToQuestion({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 0,
        principalId: "principal-a",
        operationId: "ap015-delayed-reply",
        fingerprint: "ap015-delayed-reply",
        taskId: accepted.task.taskId,
        questionId: "ap015-delayed-question",
        answer: { "Continue?": "Yes" },
        now: "2026-09-15T00:00:01.000Z",
      });
      await delay;
      await expect(reply).resolves.toMatchObject({
        replayed: false,
        question: { state: "accepted", delivery: "pending" },
      });
      await fixture.store.close();
      expect(
        receiptCount(
          join(fixture.directory, "store.sqlite"),
          "ap015-delayed-reply",
        ),
      ).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });

  it("discovers a reply's late committed winner after a write timeout and worker replacement", async () => {
    const fixture = await openStore({ requestTimeoutMs: 350 });
    const databasePath = join(fixture.directory, "store.sqlite");
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      const accepted = await fixture.store.submit(
        submit({
          operationId: "ap015-ambiguous-reply-submit",
          fingerprint: "ap015-ambiguous-reply-submit",
          taskId: "ap015-ambiguous-reply-task",
          contextId: "ap015-ambiguous-reply-context",
        }),
      );
      const reference = await prepareRunning(
        fixture.store,
        accepted.task.taskId,
        "ambiguous-reply",
      );
      await fixture.store.persistQuestionObservation({
        reference,
        questionId: "ap015-ambiguous-question",
        toolUseId: "ap015-ambiguous-tool",
        requestId: "ap015-ambiguous-request",
        ordinal: 1,
        toolActivity: "none",
        activeElapsedMs: 0,
        schema: QUESTION_SCHEMA,
        expiresAt: "2026-09-16T00:00:00.000Z",
        now: "2026-09-15T00:00:00.000Z",
      });
      const request = {
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 0,
        principalId: "principal-a",
        operationId: "ap015-ambiguous-reply",
        fingerprint: "ap015-ambiguous-reply",
        taskId: accepted.task.taskId,
        questionId: "ap015-ambiguous-question",
        answer: { "Continue?": "Yes" },
        now: "2026-09-15T00:00:01.000Z",
      };

      await fixture.store.probe("armCommitBarrier");
      const timedOut = fixture.store.replyToQuestion(request);
      void timedOut.catch(() => undefined);
      await fixture.store.probe("waitForCommitBarrier");
      await expect(timedOut).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await fixture.store.probe("releaseCommitBarrier");
      await fixture.store.probe("inspectDurability");
      await fixture.store.close();

      reopened = await SqliteDurableAdmissionStore.open({ databasePath });
      await expect(reopened.replyToQuestion(request)).resolves.toMatchObject({
        replayed: true,
        question: {
          state: "accepted",
          delivery: "pending",
          answer: { "Continue?": "Yes" },
        },
      });
      await expect(
        reopened.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: accepted.task.taskId,
        }),
      ).resolves.toMatchObject({
        state: "running",
        workspaceClaim: "held",
      });
      await reopened.close();
      expect(receiptCount(databasePath, request.operationId)).toBe(1);
    } finally {
      await fixture.store.probe("releaseCommitBarrier");
      await reopened?.close();
      await fixture.dispose();
    }
  });

  it("discovers a late cancel intent without releasing its exact held claim", async () => {
    const fixture = await openStore({ requestTimeoutMs: 350 });
    const databasePath = join(fixture.directory, "store.sqlite");
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      const accepted = await fixture.store.submit(
        submit({
          operationId: "ap015-ambiguous-cancel-submit",
          fingerprint: "ap015-ambiguous-cancel-submit",
          taskId: "ap015-ambiguous-cancel-task",
          contextId: "ap015-ambiguous-cancel-context",
        }),
      );
      const reference = await prepareRunning(
        fixture.store,
        accepted.task.taskId,
        "ambiguous-cancel",
      );
      const request = {
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 0,
        principalId: "principal-a",
        operationId: "ap015-ambiguous-cancel",
        fingerprint: "ap015-ambiguous-cancel",
        taskId: accepted.task.taskId,
        expectedStates: ["queued", "paused"] as const,
        nextState: "canceled" as const,
        eventType: "canceled" as const,
        now: "2026-09-15T00:00:01.000Z",
        activeElapsedMs: 0,
      };

      await fixture.store.probe("armCommitBarrier");
      const timedOut = fixture.store.cancel(request);
      void timedOut.catch(() => undefined);
      await fixture.store.probe("waitForCommitBarrier");
      await expect(timedOut).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await fixture.store.probe("releaseCommitBarrier");
      await fixture.store.probe("inspectDurability");
      await fixture.store.close();

      reopened = await SqliteDurableAdmissionStore.open({ databasePath });
      await expect(reopened.cancel(request)).resolves.toMatchObject({
        replayed: true,
      });
      await expect(
        reopened.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: accepted.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        daemonEpoch: reference.daemonEpoch,
        state: "stopping",
        workspaceClaim: "held",
      });
      await expect(
        reopened.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: accepted.task.taskId,
        }),
      ).resolves.toMatchObject({ state: "stopping" });
      await reopened.close();
      expect(receiptCount(databasePath, request.operationId)).toBe(1);
    } finally {
      await fixture.store.probe("releaseCommitBarrier");
      await reopened?.close();
      await fixture.dispose();
    }
  });

  it("replays one interrupted terminal control after an ambiguous acknowledgement commit", async () => {
    const fixture = await openStore({ requestTimeoutMs: 350 });
    const databasePath = join(fixture.directory, "store.sqlite");
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      const accepted = await fixture.store.submit(
        submit({
          operationId: "ap015-ambiguous-ack-submit",
          fingerprint: "ap015-ambiguous-ack-submit",
          taskId: "ap015-ambiguous-ack-task",
          contextId: "ap015-ambiguous-ack-context",
        }),
      );
      const reference = await prepareRunning(
        fixture.store,
        accepted.task.taskId,
        "ambiguous-ack",
      );
      await fixture.store.recoverExecutions();
      const recovering = await fixture.store.getTask({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        taskId: accepted.task.taskId,
      });
      if (recovering === undefined) throw new Error("recovering Task missing");
      await expect(
        fixture.store.acknowledgeInterruption({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          expectedRegistryRevision: 0,
          principalId: "principal-a",
          operationId: "ap015-ambiguous-ack-premature",
          fingerprint: "ap015-ambiguous-ack-premature",
          taskId: accepted.task.taskId,
          expectedRevision: recovering.revision,
          now: "2026-09-15T00:00:01.000Z",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      // The Linux-shaped fields below are a scripted SQLite precondition in
      // this platform-neutral test, not Supervisor-verified Stop Evidence.
      await fixture.store.confirmRecoveryStopped({
        evidence: {
          platform: "linux-cgroup-v2",
          reference,
          executionUnitId: "ap015-scripted-ack-precondition-unit",
          generationSealedAt: "2026-09-15T00:00:02.000Z",
          unitEmptyObservedAt: "2026-09-15T00:00:03.000Z",
        },
        now: "2026-09-15T00:00:04.000Z",
      });
      const request = {
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        expectedRegistryRevision: 0,
        principalId: "principal-a",
        operationId: "ap015-ambiguous-ack",
        fingerprint: "ap015-ambiguous-ack",
        taskId: accepted.task.taskId,
        expectedRevision: recovering.revision,
        now: "2026-09-15T00:00:05.000Z",
      };

      await fixture.store.probe("armCommitBarrier");
      const timedOut = fixture.store.acknowledgeInterruption(request);
      void timedOut.catch(() => undefined);
      await fixture.store.probe("waitForCommitBarrier");
      await expect(timedOut).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await fixture.store.probe("releaseCommitBarrier");
      await fixture.store.probe("inspectDurability");
      await fixture.store.close();

      reopened = await SqliteDurableAdmissionStore.open({ databasePath });
      await expect(
        reopened.acknowledgeInterruption(request),
      ).resolves.toMatchObject({
        replayed: true,
      });
      await expect(
        reopened.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: accepted.task.taskId,
        }),
      ).resolves.toMatchObject({
        state: "interrupted",
        reason: "outcome_unknown",
      });
      await expect(
        reopened.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: accepted.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        daemonEpoch: reference.daemonEpoch,
        workspaceClaim: "released",
      });
      await reopened.close();
      expect(receiptCount(databasePath, request.operationId)).toBe(1);
    } finally {
      await fixture.store.probe("releaseCommitBarrier");
      await reopened?.close();
      await fixture.dispose();
    }
  });

  it("closes dispatch on a physical control-commit failure without inventing stop or terminal state", async () => {
    const supervisor = new PendingSupervisor();
    const incidents = new StorageIncidentCoordinator(supervisor, 4);
    const fixture = await createDurableAdmissionFixture(
      {},
      { storageIncidentSafety: incidents },
      incidents,
    );
    try {
      const actor = { principalId: "principal-a" };
      const running = await fixture.service.submitTask(actor, {
        operationId: "ap015-physical-running-submit",
        agentId: "agent-a",
        instruction: "keep exact claim when cancellation cannot commit",
      });
      const waiting = await fixture.service.submitTask(actor, {
        operationId: "ap015-physical-waiting-submit",
        agentId: "agent-revokable",
        instruction: "must not dispatch after storage fails",
      });
      const { reference } = await fixture.service.prepareForDispatch(
        running.task.taskId,
        "ap015-physical-synthetic-epoch",
      );
      await fixture.service.markExecutionRunning(reference);
      await fixture.store.probe("failNextStorageFull");
      await expect(
        fixture.service.cancelTask(actor, {
          operationId: "ap015-physical-failed-cancel",
          taskId: running.task.taskId,
        }),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      expect(incidents.isLatched()).toBe(true);
      await expect.poll(() => supervisor.stops).toEqual([reference]);
      await expect(
        new ControlledRuntimeDispatcher(
          fixture.service,
          { dispatchAuthority: () => Promise.resolve("ap015-late-epoch") },
          supervisor,
        ).dispatch(waiting.task.taskId),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
      expect(supervisor.starts).toEqual([]);
      await expect(
        fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: running.task.taskId,
        }),
      ).resolves.toMatchObject({
        executionId: reference.executionId,
        generation: reference.generation,
        daemonEpoch: reference.daemonEpoch,
        state: "running",
        workspaceClaim: "held",
      });
      await expect(
        fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: running.task.taskId,
        }),
      ).resolves.toMatchObject({ state: "running" });
      await fixture.store.close();
      expect(
        receiptCount(fixture.databasePath, "ap015-physical-failed-cancel"),
      ).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("bounds an injected SQLite diagnostic before MCP error and product-audit projection", async () => {
    const fixture = await createDurableAdmissionFixture();
    const endpoint = await startDurableAdmissionMcpEndpoint(fixture);
    const client = await connectDurableAdmissionClient(
      endpoint.url,
      SCOPE_A_TOKEN,
    );
    try {
      await fixture.store.probe("failNextAp015ReadDiagnostic");
      const result = await client.callTool({
        name: "agentport_list_tasks",
        arguments: { agentId: "agent-a", limit: 1 },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "storage_unavailable" },
      });
      for (const marker of [
        PRIVATE_DIAGNOSTIC,
        fixture.databasePath,
        SCOPE_A_TOKEN,
      ]) {
        expect(JSON.stringify(result)).not.toContain(marker);
      }
      await endpoint.flushAudit();
      const audit = (await fixture.store.probe("inspectProductAudit")) as {
        records: Array<{ resultCode: string }>;
      };
      expect(audit.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resultCode: "storage_unavailable" }),
        ]),
      );
      expect(JSON.stringify(audit)).not.toContain(PRIVATE_DIAGNOSTIC);
      expect(JSON.stringify(audit)).not.toContain(fixture.databasePath);
      expect(JSON.stringify(audit)).not.toContain(SCOPE_A_TOKEN);
    } finally {
      await client.close();
      await endpoint.close();
      await fixture.close();
    }
  });
});
