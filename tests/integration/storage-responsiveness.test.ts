import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { DurableAgentExecutionService } from "../../src/core/agent-execution-service.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";
import { openStore, submit } from "../fixtures/durable-store.js";

describe("storage responsiveness", () => {
  it("lets reserved cancellation overtake a saturated audit queue", async () => {
    const fixture = await openStore({
      auditCapacity: 1,
      requestTimeoutMs: 100,
    });
    try {
      await fixture.store.submit(submit());
      const audits = Array.from({ length: 2_000 }, (_, index) =>
        fixture.store
          .recordAudit({
            principalId: "principal-a",
            method: "tools/list",
            toolName: null,
            protocolVersion: "2026-07-28",
            clientName: null,
            clientVersion: null,
            clientCapabilitiesJson: null,
            resultCode: `audit-${String(index)}`,
            createdAt: "2026-09-12T08:00:00.000Z",
          })
          .then(
            () => "fulfilled" as const,
            () => "rejected" as const,
          ),
      );

      await expect(
        fixture.store.cancel({
          accessScopeId: "scope-a",
          principalId: "principal-a",
          operationId: "cancel-through-audit-backlog",
          fingerprint: "cancel-through-audit-backlog-fingerprint",
          taskId: "task-1",
          expectedStates: ["queued", "paused"],
          nextState: "canceled",
          eventType: "canceled",
        }),
      ).resolves.toMatchObject({ task: { state: "canceled" } });
      const auditResults = await Promise.all(audits);
      expect(
        auditResults.filter((status) => status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        auditResults.filter((status) => status === "rejected"),
      ).toHaveLength(1_999);
      await fixture.store.flushAudit();
      await expect(
        fixture.store.probe("inspectProductAudit"),
      ).resolves.toMatchObject({
        records: [{ resultCode: "audit-1999" }],
        overwrittenCount: 1_999,
      });
    } finally {
      await fixture.dispose();
    }
  }, 30_000);

  it("restores and retries a coalesced gap after its first write fails", async () => {
    const fixture = await openStore({ auditCapacity: 1 });
    try {
      await fixture.store.probe("failNextAuditGap");
      const audits = ["first", "second", "latest"].map((resultCode) =>
        fixture.store
          .recordAudit({
            principalId: "principal-a",
            method: "tools/list",
            toolName: null,
            protocolVersion: "2026-07-28",
            clientName: null,
            clientVersion: null,
            clientCapabilitiesJson: null,
            resultCode,
            createdAt: "2026-09-12T08:00:00.000Z",
          })
          .then(
            () => "fulfilled" as const,
            () => "rejected" as const,
          ),
      );

      const results = await Promise.all(audits);
      expect(results.filter((status) => status === "fulfilled")).toHaveLength(
        1,
      );
      expect(results.filter((status) => status === "rejected")).toHaveLength(2);
      await fixture.store.flushAudit();
      await expect(
        fixture.store.probe("inspectProductAudit"),
      ).resolves.toMatchObject({
        records: [{ resultCode: "latest" }],
        overwrittenCount: 2,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("does not double-count a gap when the original write commits after timeout", async () => {
    const fixture = await openStore({
      auditCapacity: 1,
      requestTimeoutMs: 100,
    });
    try {
      void fixture.store.probe("block", 500).catch(() => undefined);
      const audits = ["first", "second", "latest"].map((resultCode) =>
        fixture.store
          .recordAudit({
            principalId: "principal-a",
            method: "tools/list",
            toolName: null,
            protocolVersion: "2026-07-28",
            clientName: null,
            clientVersion: null,
            clientCapabilitiesJson: null,
            resultCode,
            createdAt: "2026-09-12T08:00:00.000Z",
          })
          .then(
            () => "fulfilled" as const,
            () => "rejected" as const,
          ),
      );

      const results = await Promise.all(audits);
      expect(results.filter((status) => status === "fulfilled")).toHaveLength(
        1,
      );
      expect(results.filter((status) => status === "rejected")).toHaveLength(2);
      await fixture.store.flushAudit();
      await expect(
        fixture.store.probe("inspectProductAudit"),
      ).resolves.toMatchObject({
        records: [{ resultCode: "latest" }],
        overwrittenCount: 2,
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("fails audit drain without blocking Task control after repeated gap failures", async () => {
    const fixture = await openStore({ auditCapacity: 1 });
    try {
      await fixture.store.submit(submit());
      await fixture.store.probe("failAuditGapPermanently");
      const audits = ["first", "second", "latest"].map((resultCode) =>
        fixture.store
          .recordAudit({
            principalId: "principal-a",
            method: "tools/list",
            toolName: null,
            protocolVersion: "2026-07-28",
            clientName: null,
            clientVersion: null,
            clientCapabilitiesJson: null,
            resultCode,
            createdAt: "2026-09-12T08:00:00.000Z",
          })
          .then(
            () => "fulfilled" as const,
            () => "rejected" as const,
          ),
      );

      await expect(fixture.store.flushAudit()).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await expect(Promise.all(audits)).resolves.toEqual([
        "rejected",
        "rejected",
        "rejected",
      ]);
      await expect(
        fixture.store.cancel({
          accessScopeId: "scope-a",
          principalId: "principal-a",
          operationId: "cancel-after-audit-failure",
          fingerprint: "cancel-after-audit-failure-fingerprint",
          taskId: "task-1",
          expectedStates: ["queued", "paused"],
          nextState: "canceled",
          eventType: "canceled",
        }),
      ).resolves.toMatchObject({ task: { state: "canceled" } });
    } finally {
      await fixture.dispose();
    }
  });

  it("does not block the main event loop and bounds timed-out reads", async () => {
    const fixture = await openStore({ requestTimeoutMs: 500 });
    try {
      let advanced = false;
      setImmediate(() => {
        advanced = true;
      });
      await expect(fixture.store.probe("block", 1_500)).rejects.toMatchObject({
        code: "observation_unavailable",
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(advanced).toBe(true);
      await expect(
        fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: "missing",
        }),
      ).rejects.toMatchObject({ code: "observation_unavailable" });
    } finally {
      await fixture.dispose();
    }
  });

  it("bounds a large worker result without blocking the main event loop", async () => {
    const fixture = await openStore({ requestTimeoutMs: 1_000 });
    try {
      let advanced = false;
      setImmediate(() => {
        advanced = true;
      });
      const result = await fixture.store.probe("largeRead", 2 * 1024 * 1024);
      await new Promise((resolve) => setImmediate(resolve));
      expect(advanced).toBe(true);
      expect(result).toBeTypeOf("string");
      expect((result as string).length).toBe(1024 * 1024);
    } finally {
      await fixture.dispose();
    }
  });

  it("returns an authorized stale snapshot and otherwise reports unavailable", async () => {
    const fixture = await createDurableAdmissionFixture({
      requestTimeoutMs: 500,
    });
    try {
      const actor = { principalId: "principal-a" };
      const submitted = await fixture.service.submitTask(actor, {
        operationId: "stale-snapshot",
        agentId: "agent-a",
        instruction: "cache this committed snapshot",
      });
      const serviceWithoutSnapshot = new DurableAgentExecutionService(
        fixture.registry,
        fixture.store,
        { cursorSecret: "fresh-service-cursor-secret" },
      );
      const blocking = fixture.store
        .probe("block", 1_500)
        .catch(() => undefined);
      const [stale, unavailable] = await Promise.allSettled([
        fixture.service.getTask(actor, { taskId: submitted.task.taskId }),
        serviceWithoutSnapshot.getTask(actor, {
          taskId: submitted.task.taskId,
        }),
      ]);
      expect(stale).toMatchObject({
        status: "fulfilled",
        value: {
          taskId: submitted.task.taskId,
          observationStatus: "stale",
        },
      });
      expect(unavailable).toMatchObject({
        status: "rejected",
        reason: { code: "observation_unavailable" },
      });
      await blocking;
    } finally {
      await fixture.close();
    }
  });

  it("bounds retained stale snapshots and reports unavailable after eviction", async () => {
    const fixture = await createDurableAdmissionFixture(
      { requestTimeoutMs: 500 },
      { snapshotCacheEntries: 1 },
    );
    try {
      const actor = { principalId: "principal-a" };
      const first = await fixture.service.submitTask(actor, {
        operationId: "cache-first",
        agentId: "agent-a",
        instruction: "evicted snapshot",
      });
      const second = await fixture.service.submitTask(actor, {
        operationId: "cache-second",
        agentId: "agent-a",
        instruction: "retained snapshot",
      });
      const blocking = fixture.store
        .probe("block", 1_500)
        .catch(() => undefined);
      const [evicted, retained] = await Promise.allSettled([
        fixture.service.getTask(actor, { taskId: first.task.taskId }),
        fixture.service.getTask(actor, { taskId: second.task.taskId }),
      ]);
      expect(evicted).toMatchObject({
        status: "rejected",
        reason: { code: "observation_unavailable" },
      });
      expect(retained).toMatchObject({
        status: "fulfilled",
        value: { observationStatus: "stale" },
      });
      await blocking;
    } finally {
      await fixture.close();
    }
  });

  it("fails current and future requests immediately after a clean unexpected worker exit", async () => {
    const fixture = await openStore({ requestTimeoutMs: 2_000 });
    try {
      await expect(fixture.store.probe("exitClean")).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      await expect(
        fixture.store.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: "missing",
        }),
      ).rejects.toMatchObject({ code: "storage_unavailable" });
    } finally {
      await fixture.dispose();
    }
  });

  it("drains a timed-out mutation before closing the database worker", async () => {
    const fixture = await openStore({ requestTimeoutMs: 100 });
    try {
      void fixture.store.probe("block", 300).catch(() => undefined);
      await expect(
        fixture.store.submit({
          accessScopeId: "scope-a",
          operationId: "drain-submit",
          fingerprint: "drain-fingerprint",
          principalId: "principal-a",
          taskId: "drain-task",
          contextId: "drain-context",
          agentId: "agent-a",
          instruction: "commit before close completes",
          binding: {
            bindingSnapshotId: "drain-binding",
            configurationRevision: "config-1",
            workspaceIdentity: {
              canonicalPath: "/fixture/workspace-a",
              filesystemIdentity: "workspace-a",
            },
            runtimeDriver: "none",
            runtimeVersion: "none",
            launchProfileId: "fixture-profile",
            policy: {
              maximumExecutionLimitSeconds: 3_600,
              maximumInputWaitSeconds: 86_400,
            },
          },
        }),
      ).rejects.toMatchObject({ code: "observation_unavailable" });
      await fixture.store.close();
      const reopened = await SqliteDurableAdmissionStore.open({
        databasePath: join(fixture.directory, "store.sqlite"),
      });
      await expect(
        reopened.getTask({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: "drain-task",
        }),
      ).resolves.toMatchObject({ taskId: "drain-task", state: "queued" });
      await reopened.close();
    } finally {
      await fixture.dispose();
    }
  });
});
