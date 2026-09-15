import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeWorkerIngress } from "../../src/runtime/worker/ingress.js";
import { RuntimeWorkerIngressClient } from "../../src/runtime/worker/ingress-client.js";
import { encodeWorkerObservation } from "../../src/runtime/worker/protocol.js";
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

const PRIVATE_INSTRUCTION = "AP014-PRIVATE-INSTRUCTION-MARKER";
const PRIVATE_DIAGNOSTIC = "AP014-PRIVATE-DIAGNOSTIC-MARKER";
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

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function structured(result: ToolResult): Record<string, unknown> {
  expectStructuredTextAgreement(result);
  expect(result.structuredContent).toBeTypeOf("object");
  return result.structuredContent as Record<string, unknown>;
}

function error(result: ToolResult, code: string): void {
  expect(result.isError).toBe(true);
  expect(structured(result)).toMatchObject({
    ok: false,
    error: { code },
  });
  expect(JSON.stringify(result)).not.toContain(PRIVATE_INSTRUCTION);
  expect(JSON.stringify(result)).not.toContain(PRIVATE_DIAGNOSTIC);
}

describe("AP-014 outer MCP observation under synthetic load", () => {
  it("reads bounded current projections while scripted ingress is held and Clients poll event pages", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const poller = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const foreign = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );
    const submitted = structured(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap014-loaded-submit",
          agentId: "agent-a",
          instruction: PRIVATE_INSTRUCTION,
        },
      }),
    );
    const taskId = String((submitted.task as Record<string, unknown>).taskId);
    const { reference } = await fixture.service.prepareForDispatch(
      taskId,
      "ap014-scripted-reference",
    );
    await fixture.service.markExecutionRunning(reference);
    for (let index = 0; index < 50; index++) {
      await fixture.service.submitTask(
        { principalId: "principal-a" },
        {
          operationId: `ap014-page-${String(index)}`,
          agentId: index % 2 === 0 ? "agent-a" : "agent-revokable",
          instruction: PRIVATE_INSTRUCTION,
        },
      );
    }

    let releaseIngress: (() => void) | undefined;
    const ingressGate = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    let markEntered: (() => void) | undefined;
    const ingressEntered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const ingress = track(
      await RuntimeWorkerIngress.open({
        endpoint: `${fixture.directory}/ap014-ingress.sock`,
        reference,
        lifecycle: {
          persistQuestion: () => Promise.resolve(),
          waitForAcceptedAnswer: () => Promise.resolve({}),
          acknowledgeQuestionDelivery: () => Promise.resolve(),
          markQuestionDeliveryUnknown: () => Promise.resolve(),
          async recordObservation(observation) {
            markEntered?.();
            await ingressGate;
            await fixture.recordObservation(
              { principalId: "principal-a" },
              { taskId, observation },
            );
          },
          stopAfterCandidate: () => Promise.resolve(),
          quarantine: () => Promise.resolve(),
        },
      }),
    );
    const worker = await RuntimeWorkerIngressClient.connect(ingress.session);
    resources.push(() => {
      worker.close();
      return Promise.resolve();
    });
    let ingressAccepted = false;
    const pendingIngress = worker
      .emit(
        encodeWorkerObservation({
          kind: "progress",
          reference,
          ordinal: 1,
          summary: "scripted progress remains bounded",
        }),
        1,
        "progress",
      )
      .then(() => {
        ingressAccepted = true;
      });
    void pendingIngress.catch(() => undefined);
    await ingressEntered;
    const delayedRead = fixture.store.probe("block", 150);
    try {
      const calls = await Promise.all([
        client.callTool({ name: "agentport_get_task", arguments: { taskId } }),
        poller.callTool({
          name: "agentport_list_tasks",
          arguments: { agentId: "agent-a", limit: 1 },
        }),
        client.callTool({
          name: "agentport_get_events",
          arguments: { limit: 50 },
        }),
        poller.callTool({
          name: "agentport_get_events",
          arguments: { taskId, limit: 50 },
        }),
      ]);
      await delayedRead;
      expect(ingressAccepted).toBe(false);
      const task = structured(calls[0]);
      expect(task).toMatchObject({
        ok: true,
        task: { taskId, observationStatus: "current", state: "running" },
      });
      const listed = structured(calls[1]);
      expect(listed).toMatchObject({
        ok: true,
        tasks: [{ taskId, agentId: "agent-a" }],
      });
      expect((listed.tasks as unknown[]).length).toBeLessThanOrEqual(1);
      const events = structured(calls[2]);
      expect(events).toMatchObject({ ok: true });
      expect((events.events as unknown[]).length).toBeLessThanOrEqual(50);
      expect((events.events as unknown[]).length).toBe(50);
      expect(events.nextCursor).toBeTypeOf("string");
      expect((structured(calls[3]).events as unknown[]).length).toBeGreaterThan(
        0,
      );
      for (const result of calls.slice(1))
        expect(JSON.stringify(result)).not.toContain(PRIVATE_INSTRUCTION);
      error(
        await foreign.callTool({
          name: "agentport_get_task",
          arguments: { taskId },
        }),
        "not_found",
      );
      error(
        await client.callTool({
          name: "agentport_list_tasks",
          arguments: { agentId: "agent-b" },
        }),
        "not_found",
      );
      for (let index = 0; index < 2; index++) {
        await foreign.callTool({
          name: "agentport_submit_task",
          arguments: {
            operationId: `ap014-foreign-page-${String(index)}`,
            agentId: "agent-b",
            instruction: PRIVATE_DIAGNOSTIC,
          },
        });
      }
      const foreignCursor = structured(
        await foreign.callTool({
          name: "agentport_get_events",
          arguments: { limit: 1 },
        }),
      ).nextCursor;
      expect(foreignCursor).toBeTypeOf("string");
      error(
        await client.callTool({
          name: "agentport_get_events",
          arguments: { afterCursor: foreignCursor },
        }),
        "not_found",
      );
    } finally {
      releaseIngress?.();
    }
    await pendingIngress;
    expect(ingressAccepted).toBe(true);
  });

  it("bounds reads behind a held SQLite write and reauthorizes fresh reads after a warmed-cache revocation", async () => {
    const fixture = track(
      await createDurableAdmissionFixture({ requestTimeoutMs: 300 }),
    );
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const submitted = structured(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap014-revokable-submit",
          agentId: "agent-revokable",
          instruction: PRIVATE_INSTRUCTION,
        },
      }),
    );
    const taskId = String((submitted.task as Record<string, unknown>).taskId);
    const warm = structured(
      await client.callTool({
        name: "agentport_get_task",
        arguments: { taskId },
      }),
    );
    expect(warm).toMatchObject({
      ok: true,
      task: { taskId, observationStatus: "current", state: "queued" },
    });
    const { reference } = await fixture.service.prepareForDispatch(
      taskId,
      "ap014-held-write-reference",
    );
    await fixture.service.markExecutionRunning(reference);
    await fixture.store.probe("armCommitBarrier");
    try {
      const pendingWrite = fixture.recordObservation(
        { principalId: "principal-a" },
        {
          taskId,
          observation: {
            reference,
            kind: "progress",
            ordinal: 1,
            summary: "new progress remains behind a held SQLite commit",
          },
        },
      );
      void pendingWrite.catch(() => undefined);
      await fixture.store.probe("waitForCommitBarrier");
      const started = performance.now();
      const [stale, unavailableList, unavailableEvents] = await Promise.all([
        client.callTool({ name: "agentport_get_task", arguments: { taskId } }),
        client.callTool({
          name: "agentport_list_tasks",
          arguments: { agentId: "agent-revokable" },
        }),
        client.callTool({
          name: "agentport_get_events",
          arguments: { taskId },
        }),
      ]);
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(structured(stale)).toMatchObject({
        ok: true,
        task: { taskId, observationStatus: "stale" },
      });
      expect(structured(stale).task).not.toMatchObject({
        progress: {
          summary: "new progress remains behind a held SQLite commit",
        },
      });
      error(unavailableList, "observation_unavailable");
      error(unavailableEvents, "observation_unavailable");
      await fixture.store.probe("releaseCommitBarrier");
      await pendingWrite.catch(() => undefined);
    } finally {
      await fixture.store.probe("releaseCommitBarrier");
    }

    await fixture.store.probe("failNextReadDiagnostic");
    error(
      await client.callTool({
        name: "agentport_list_tasks",
        arguments: { agentId: "agent-revokable" },
      }),
      "storage_unavailable",
    );

    await fixture.registry.replace({
      ...fixture.registryConfiguration,
      principals: fixture.registryConfiguration.principals.map((principal) =>
        principal.principalId === "principal-a"
          ? { ...principal, active: false }
          : principal,
      ),
    });
    const afterRevocation = await Promise.all([
      client.callTool({ name: "agentport_get_task", arguments: { taskId } }),
      client.callTool({
        name: "agentport_list_tasks",
        arguments: { agentId: "agent-revokable" },
      }),
      client.callTool({
        name: "agentport_get_events",
        arguments: { taskId },
      }),
    ]);
    for (const result of afterRevocation) error(result, "access_denied");
    await endpoint.flushAudit();
    const audit = await fixture.store.probe("inspectProductAudit");
    for (const marker of [
      PRIVATE_INSTRUCTION,
      PRIVATE_DIAGNOSTIC,
      fixture.directory,
      SCOPE_A_TOKEN,
    ])
      expect(JSON.stringify(audit)).not.toContain(marker);
  });
});
