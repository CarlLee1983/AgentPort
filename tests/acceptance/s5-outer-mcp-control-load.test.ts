import type { Client } from "@modelcontextprotocol/client";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MCP_PROTOCOL_VERSION } from "../../src/mcp/protocol.js";
import { RuntimeWorkerIngress } from "../../src/runtime/worker/ingress.js";
import { RuntimeWorkerIngressClient } from "../../src/runtime/worker/ingress-client.js";
import { encodeWorkerObservation } from "../../src/runtime/worker/protocol.js";
import {
  createDurableAdmissionFixture,
  INVALID_TOKEN,
  SCOPE_A_TOKEN,
  SCOPE_B_TOKEN,
} from "../fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
  expectStructuredTextAgreement,
  startDurableAdmissionMcpEndpoint,
} from "../fixtures/durable-admission-mcp.js";

const PRIVATE_ANSWER = "AP015-PRIVATE-ANSWER-MARKER";
const PRIVATE_INSTRUCTION = "AP015-PRIVATE-INSTRUCTION-MARKER";
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
type Samples = Record<"reply" | "cancel" | "acknowledgement", number[]>;

function structured(result: ToolResult): Record<string, unknown> {
  expectStructuredTextAgreement(result);
  expect(result.structuredContent).toBeTypeOf("object");
  return result.structuredContent as Record<string, unknown>;
}

function accepted(result: ToolResult): Record<string, unknown> {
  const payload = structured(result);
  expect(result.isError).not.toBe(true);
  expect(payload.ok).toBe(true);
  return payload;
}

function rejected(
  result: ToolResult,
  code: string,
  secrets: readonly string[],
) {
  expect(result.isError).toBe(true);
  expect(structured(result)).toMatchObject({ ok: false, error: { code } });
  for (const secret of secrets)
    expect(JSON.stringify(result)).not.toContain(secret);
}

async function timed(
  samples: Samples,
  name: keyof Samples,
  call: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const started = performance.now();
  const result = await call();
  samples[name].push(performance.now() - started);
  return result;
}

function assertTimings(
  samples: Samples,
  controls: readonly (keyof Samples)[],
): void {
  for (const name of controls) {
    const values = samples[name];
    const ordered = [...values].sort((left, right) => left - right);
    const percentile = (percent: number) =>
      ordered[
        Math.min(ordered.length - 1, Math.ceil(ordered.length * percent) - 1)
      ];
    const max = ordered.at(-1) ?? 0;
    const p50 = percentile(0.5) ?? 0;
    const p95 = percentile(0.95) ?? 0;
    expect(ordered.length, `${name} sample count`).toBeGreaterThan(0);
    expect(max, `${name} maximum full Client response`).toBeLessThanOrEqual(
      2_000,
    );
    expect(p50, `${name} p50 full Client response`).toBeLessThanOrEqual(2_000);
    expect(p95, `${name} p95 full Client response`).toBeLessThanOrEqual(2_000);
    process.stdout.write(
      `${JSON.stringify({
        fixture: "ap015-synthetic-control-outcome",
        control: name,
        sampleCount: ordered.length,
        maximumMs: max,
        p50Ms: p50,
        p95Ms: p95,
      })}\n`,
    );
  }
}

describe("AP-015 outer MCP existing-Task control under synthetic load", () => {
  it("commits and replays active cancellation before held synthetic ingress or stop callback release", async () => {
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stopReferences: unknown[] = [];
    let stopCallbackReleased = false;
    const fixture = track(
      await createDurableAdmissionFixture(
        { auditCapacity: 1, receiptCapacity: 5 },
        {
          stopRequester: {
            async requestStop(reference) {
              stopReferences.push(reference);
              await stopGate;
              stopCallbackReleased = true;
            },
          },
        },
      ),
    );
    const primaryAgent = fixture.registryConfiguration.agents.find(
      ({ agentId }) => agentId === "agent-a",
    );
    if (primaryAgent === undefined) throw new Error("primary Agent is missing");
    const extraWorkspaces = await Promise.all(
      ["c", "d"].map(async (suffix) => {
        const workspacePath = join(fixture.directory, `workspace-${suffix}`);
        await mkdir(workspacePath);
        return workspacePath;
      }),
    );
    await fixture.registry.replace({
      ...fixture.registryConfiguration,
      principals: fixture.registryConfiguration.principals.map((principal) =>
        principal.principalId === "principal-a"
          ? {
              ...principal,
              allowedAgentIds: [
                "agent-a",
                "agent-revokable",
                "agent-c",
                "agent-d",
              ],
            }
          : principal,
      ),
      agents: [
        ...fixture.registryConfiguration.agents,
        ...extraWorkspaces.map((workspacePath, index) => ({
          ...primaryAgent,
          agentId: index === 0 ? "agent-c" : "agent-d",
          description: `AP-015 synthetic Workspace ${String(index + 3)}`,
          workspacePath,
        })),
      ],
    });
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
    const samples: Samples = { reply: [], cancel: [], acknowledgement: [] };
    const activeTasks: Record<string, unknown>[] = [];
    for (const [index, agentId] of [
      "agent-a",
      "agent-revokable",
      "agent-c",
      "agent-d",
    ].entries()) {
      activeTasks.push(
        accepted(
          await client.callTool({
            name: "agentport_submit_task",
            arguments: {
              operationId: `ap015-active-submit-${String(index + 1)}`,
              agentId,
              instruction: PRIVATE_INSTRUCTION,
            },
          }),
        ).task as Record<string, unknown>,
      );
    }
    const successor = accepted(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap015-same-workspace-successor",
          agentId: "agent-a",
          instruction: "AP015 queued same-Workspace successor",
        },
      }),
    ).task as Record<string, unknown>;
    const taskId = String(activeTasks[0]?.taskId);
    const held = await Promise.all(
      activeTasks.map(async (task, index) => {
        const preparation = await fixture.service.prepareForDispatch(
          String(task.taskId),
          `ap015-held-synthetic-reference-${String(index + 1)}`,
        );
        await fixture.service.markExecutionRunning(preparation.reference);
        return preparation.reference;
      }),
    );
    const reference = held[0];
    if (reference === undefined) throw new Error("cancel Reference is missing");
    expect(held).toHaveLength(4);
    expect(
      new Set(held.map(({ workspaceIdentity }) => workspaceIdentity)).size,
    ).toBe(4);
    expect(successor).toMatchObject({ agentId: "agent-a", state: "queued" });
    expect(Number(successor.queueOrder)).toBeGreaterThan(
      Number(activeTasks[0]?.queueOrder),
    );

    let releaseIngress: (() => void) | undefined;
    const ingressGate = new Promise<void>((resolve) => {
      releaseIngress = resolve;
    });
    let enteredIngress: (() => void) | undefined;
    const ingressEntered = new Promise<void>((resolve) => {
      enteredIngress = resolve;
    });
    let ingressCommitted = false;
    const ingress = track(
      await RuntimeWorkerIngress.open({
        endpoint: `${fixture.directory}/ap015-held-ingress.sock`,
        reference,
        lifecycle: {
          persistQuestion: () => Promise.resolve(),
          waitForAcceptedAnswer: () => Promise.resolve({}),
          acknowledgeQuestionDelivery: () => Promise.resolve(),
          markQuestionDeliveryUnknown: () => Promise.resolve(),
          async recordObservation(observation) {
            enteredIngress?.();
            await ingressGate;
            await fixture.recordObservation(
              { principalId: "principal-a" },
              { taskId, observation },
            );
            ingressCommitted = true;
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
    const pendingIngress = worker.emit(
      encodeWorkerObservation({
        kind: "progress",
        reference,
        ordinal: 1,
        summary: "AP015 held synthetic ingress",
      }),
      1,
      "progress",
    );
    void pendingIngress.catch(() => undefined);
    await ingressEntered;

    try {
      rejected(
        await client.callTool({
          name: "agentport_submit_task",
          arguments: {
            operationId: "ap015-saturated-new-admission",
            agentId: "agent-a",
            instruction: "new work must remain saturated",
          },
        }),
        "tombstone_capacity",
        [PRIVATE_INSTRUCTION],
      );
      const [cancel, polledTask, eventPage, listedTasks, ...pressurePages] =
        await Promise.all([
          timed(samples, "cancel", () =>
            client.callTool({
              name: "agentport_cancel_task",
              arguments: {
                operationId: "ap015-identical-control-retry",
                taskId,
              },
            }),
          ),
          poller.callTool({
            name: "agentport_get_task",
            arguments: { taskId },
          }),
          poller.callTool({
            name: "agentport_get_events",
            arguments: { taskId, limit: 1 },
          }),
          client.callTool({
            name: "agentport_list_tasks",
            arguments: { agentId: "agent-a", limit: 1 },
          }),
          ...Array.from({ length: 4 }, () =>
            poller.callTool({
              name: "agentport_get_events",
              arguments: { taskId, limit: 1 },
            }),
          ),
        ]);
      expect(accepted(polledTask)).toMatchObject({ task: { taskId } });
      expect(accepted(listedTasks)).toMatchObject({ ok: true });
      for (const page of [eventPage, ...pressurePages]) {
        const projection = accepted(page);
        expect(Array.isArray(projection.events)).toBe(true);
        expect((projection.events as unknown[]).length).toBeLessThanOrEqual(1);
        for (const marker of [
          PRIVATE_INSTRUCTION,
          PRIVATE_ANSWER,
          reference.generation,
          reference.daemonEpoch,
        ]) {
          expect(JSON.stringify(projection)).not.toContain(marker);
        }
      }
      expect(accepted(cancel)).toMatchObject({
        replayed: false,
        task: { taskId, state: "stopping", execution: { state: "stopping" } },
      });
      await expect(
        fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId,
        }),
      ).resolves.toMatchObject({ workspaceClaim: "held" });
      await expect.poll(() => stopReferences).toHaveLength(1);
      expect(ingressCommitted).toBe(false);
      expect(stopCallbackReleased).toBe(false);
      const replay = await timed(samples, "cancel", () =>
        client.callTool({
          name: "agentport_cancel_task",
          arguments: { operationId: "ap015-identical-control-retry", taskId },
        }),
      );
      expect(accepted(replay)).toMatchObject({
        replayed: true,
        task: {
          taskId,
          state: "stopping",
          result: null,
          execution: { state: "stopping" },
        },
      });
      const controlEvents = accepted(
        await client.callTool({
          name: "agentport_get_events",
          arguments: { taskId, limit: 50 },
        }),
      );
      expect(controlEvents.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "cancel_requested" }),
        ]),
      );
      expect(JSON.stringify(controlEvents)).not.toContain(PRIVATE_INSTRUCTION);
      expect(JSON.stringify(controlEvents)).not.toContain(reference.generation);
      expect(JSON.stringify(controlEvents)).not.toContain(
        reference.daemonEpoch,
      );
      expect(JSON.stringify({ cancel, replay, stopReferences })).not.toContain(
        "linux-cgroup-v2",
      );
      await endpoint.flushAudit();
      const pressuredAudit = (await fixture.store.probe(
        "inspectProductAudit",
      )) as { records: unknown[]; overwrittenCount: number };
      expect(pressuredAudit.records.length).toBeLessThanOrEqual(1);
      expect(pressuredAudit.overwrittenCount).toBeGreaterThan(0);
      const invalidBearer = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${INVALID_TOKEN}`,
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "ap015-invalid",
          method: "tools/list",
          params: {},
        }),
      });
      expect(invalidBearer.status).toBe(401);
      expect(await invalidBearer.text()).not.toContain(INVALID_TOKEN);
      await endpoint.flushAudit();
      const rejectedBearerAudit = (await fixture.store.probe(
        "inspectProductAudit",
      )) as {
        records: Array<{
          principalId: string | null;
          method: string;
          resultCode: string;
        }>;
      };
      expect(rejectedBearerAudit.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            principalId: null,
            method: "tools/list",
            resultCode: "unauthorized",
          }),
        ]),
      );
      expect(JSON.stringify(rejectedBearerAudit)).not.toContain(INVALID_TOKEN);
      rejected(
        await foreign.callTool({
          name: "agentport_submit_task",
          arguments: {
            operationId: "ap015-foreign-agent-admission",
            agentId: "agent-a",
            instruction: PRIVATE_INSTRUCTION,
          },
        }),
        "not_found",
        [PRIVATE_INSTRUCTION],
      );
      releaseIngress?.();
      await pendingIngress;
      rejected(
        await foreign.callTool({
          name: "agentport_cancel_task",
          arguments: { operationId: "ap015-foreign-cancel", taskId },
        }),
        "not_found",
        [
          taskId,
          reference.generation,
          reference.daemonEpoch,
          PRIVATE_INSTRUCTION,
        ],
      );
      await fixture.registry.replace({
        ...fixture.registryConfiguration,
        principals: fixture.registryConfiguration.principals.map((principal) =>
          principal.principalId === "principal-a"
            ? { ...principal, active: false }
            : principal,
        ),
      });
      rejected(
        await client.callTool({
          name: "agentport_cancel_task",
          arguments: { operationId: "ap015-revoked-cancel", taskId },
        }),
        "access_denied",
        [taskId, reference.daemonEpoch, PRIVATE_INSTRUCTION],
      );
      await endpoint.flushAudit();
      expect(
        JSON.stringify(await fixture.store.probe("inspectProductAudit")),
      ).not.toContain(PRIVATE_INSTRUCTION);
      expect(
        JSON.stringify(await fixture.store.probe("inspectProductAudit")),
      ).not.toContain(reference.generation);
      expect(
        JSON.stringify(await fixture.store.probe("inspectProductAudit")),
      ).not.toContain(reference.daemonEpoch);
    } finally {
      releaseIngress?.();
      releaseStop?.();
    }
    await pendingIngress;
    assertTimings(samples, ["cancel"]);
  });

  it("keeps one loaded reply pending and concealed across replay, foreign access, and revocation", async () => {
    const fixture = track(
      await createDurableAdmissionFixture({ receiptCapacity: 3 }),
    );
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const foreign = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );
    const samples: Samples = { reply: [], cancel: [], acknowledgement: [] };
    const submitted = accepted(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap015-reply-submit",
          agentId: "agent-a",
          instruction: PRIVATE_INSTRUCTION,
        },
      }),
    ).task as Record<string, unknown>;
    const taskId = String(submitted.taskId);
    const foreignTask = accepted(
      await foreign.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap015-foreign-protected-submit",
          agentId: "agent-b",
          instruction: PRIVATE_INSTRUCTION,
        },
      }),
    ).task as Record<string, unknown>;
    const foreignTaskId = String(foreignTask.taskId);
    accepted(
      await foreign.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap015-foreign-cursor-submit",
          agentId: "agent-b",
          instruction: "AP015 foreign cursor page",
        },
      }),
    );
    const { reference } = await fixture.service.prepareForDispatch(
      taskId,
      "ap015-reply-reference",
    );
    await fixture.service.markExecutionRunning(reference);
    const { reference: foreignReference } =
      await fixture.service.prepareForDispatch(
        foreignTaskId,
        "ap015-foreign-question-reference",
      );
    await fixture.service.markExecutionRunning(foreignReference);
    await fixture.store.persistQuestionObservation({
      reference,
      questionId: "ap015-question",
      toolUseId: "ap015-tool-use",
      requestId: "ap015-request",
      ordinal: 1,
      toolActivity: "none",
      activeElapsedMs: 0,
      schema: [
        {
          question: "Choose",
          header: "Choice",
          options: [
            { label: PRIVATE_ANSWER, description: "Private" },
            { label: "Other", description: "Other choice" },
          ],
          multiSelect: false,
        },
      ],
      expiresAt: "2026-09-15T00:00:00.000Z",
      now: "2026-09-14T00:00:00.000Z",
    });
    await fixture.store.persistQuestionObservation({
      reference: foreignReference,
      questionId: "ap015-foreign-question",
      toolUseId: "ap015-foreign-tool-use",
      requestId: "ap015-foreign-request",
      ordinal: 1,
      toolActivity: "none",
      activeElapsedMs: 0,
      schema: [
        {
          question: "Choose",
          header: "Choice",
          options: [
            { label: PRIVATE_ANSWER, description: "Private" },
            { label: "Other", description: "Other choice" },
          ],
          multiSelect: false,
        },
      ],
      expiresAt: "2026-09-15T00:00:00.000Z",
      now: "2026-09-14T00:00:00.000Z",
    });
    rejected(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap015-reply-saturated-admission",
          agentId: "agent-a",
          instruction: "must reject",
        },
      }),
      "tombstone_capacity",
      [PRIVATE_INSTRUCTION],
    );
    const delivery = vi.spyOn(fixture.store, "getQuestionForDelivery");
    const replyInput = {
      operationId: "ap015-reply-identical-control-retry",
      taskId,
      questionId: "ap015-question",
      answer: { Choose: PRIVATE_ANSWER },
    };
    const [first] = await Promise.all([
      timed(samples, "reply", () =>
        client.callTool({ name: "agentport_reply", arguments: replyInput }),
      ),
      client.callTool({ name: "agentport_get_task", arguments: { taskId } }),
      foreign.callTool({
        name: "agentport_get_events",
        arguments: { limit: 1 },
      }),
    ]);
    expect(accepted(first)).toMatchObject({
      replayed: false,
      task: {
        taskId,
        state: "awaiting_input",
        question: {
          state: "accepted",
          delivery: "pending",
          answer: { Choose: PRIVATE_ANSWER },
        },
      },
    });
    const replyEvents = accepted(
      await client.callTool({
        name: "agentport_get_events",
        arguments: { taskId, limit: 50 },
      }),
    );
    expect(Array.isArray(replyEvents.events)).toBe(true);
    expect((replyEvents.events as unknown[]).length).toBeLessThanOrEqual(50);
    for (const marker of [
      PRIVATE_ANSWER,
      PRIVATE_INSTRUCTION,
      reference.generation,
      reference.daemonEpoch,
    ]) {
      expect(JSON.stringify(replyEvents)).not.toContain(marker);
    }
    const replay = await timed(samples, "reply", () =>
      client.callTool({ name: "agentport_reply", arguments: replyInput }),
    );
    expect(accepted(replay)).toMatchObject({
      replayed: true,
      task: { question: { state: "accepted", delivery: "pending" } },
    });
    expect(delivery).not.toHaveBeenCalled();
    const foreignEventCursor = structured(
      await foreign.callTool({
        name: "agentport_get_events",
        arguments: { limit: 1 },
      }),
    ).nextCursor;
    expect(foreignEventCursor).toBeTypeOf("string");
    rejected(
      await client.callTool({
        name: "agentport_reply",
        arguments: {
          operationId: "ap015-foreign-question-reply",
          taskId: foreignTaskId,
          questionId: "ap015-foreign-question",
          answer: { Choose: PRIVATE_ANSWER },
        },
      }),
      "not_found",
      [
        foreignTaskId,
        "ap015-foreign-question",
        PRIVATE_ANSWER,
        PRIVATE_INSTRUCTION,
      ],
    );
    rejected(
      await client.callTool({
        name: "agentport_get_events",
        arguments: { afterCursor: foreignEventCursor },
      }),
      "not_found",
      [foreignTaskId, PRIVATE_ANSWER, PRIVATE_INSTRUCTION],
    );
    rejected(
      await foreign.callTool({
        name: "agentport_reply",
        arguments: replyInput,
      }),
      "not_found",
      [taskId, "ap015-question", PRIVATE_ANSWER, PRIVATE_INSTRUCTION],
    );
    await fixture.registry.replace({
      ...fixture.registryConfiguration,
      principals: fixture.registryConfiguration.principals.map((principal) =>
        principal.principalId === "principal-a"
          ? { ...principal, active: false }
          : principal,
      ),
    });
    rejected(
      await client.callTool({ name: "agentport_reply", arguments: replyInput }),
      "access_denied",
      [taskId, "ap015-question", PRIVATE_ANSWER, PRIVATE_INSTRUCTION],
    );
    await endpoint.flushAudit();
    const revokedAudit = (await fixture.store.probe("inspectProductAudit")) as {
      records: Array<{ resultCode: string }>;
    };
    expect(revokedAudit.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resultCode: "access_denied" }),
      ]),
    );
    expect(JSON.stringify(revokedAudit)).not.toContain(PRIVATE_ANSWER);
    assertTimings(samples, ["reply"]);
  });

  it("rejects a premature loaded acknowledgement, then replays the scripted same-Reference precondition", async () => {
    const fixture = track(
      await createDurableAdmissionFixture({ receiptCapacity: 1 }),
    );
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const foreign = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );
    const samples: Samples = { reply: [], cancel: [], acknowledgement: [] };
    const submitted = accepted(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap015-ack-submit",
          agentId: "agent-a",
          instruction: PRIVATE_INSTRUCTION,
        },
      }),
    ).task as Record<string, unknown>;
    const taskId = String(submitted.taskId);
    const { reference } = await fixture.service.prepareForDispatch(
      taskId,
      "ap015-ack-reference",
    );
    await fixture.service.markExecutionRunning(reference);
    await fixture.store.recoverExecutions();
    const recovering = await fixture.service.getTask(
      { principalId: "principal-a" },
      { taskId },
    );
    const acknowledgement = {
      operationId: "ap015-ack-identical-control-retry",
      taskId,
      expectedRevision: recovering.revision,
    };
    rejected(
      await timed(samples, "acknowledgement", () =>
        client.callTool({
          name: "agentport_acknowledge_interruption",
          arguments: acknowledgement,
        }),
      ),
      "not_found",
      [PRIVATE_INSTRUCTION],
    );
    rejected(
      await foreign.callTool({
        name: "agentport_acknowledge_interruption",
        arguments: { ...acknowledgement, operationId: "ap015-foreign-ack" },
      }),
      "not_found",
      [taskId, PRIVATE_INSTRUCTION],
    );
    // Test-only synthetic store precondition. The Linux-shaped fields satisfy the
    // existing SQLite schema branch; no actual Runtime, Supervisor, or trusted Stop
    // Evidence is exercised or claimed by this platform-neutral fixture.
    await fixture.store.confirmRecoveryStopped({
      evidence: {
        platform: "linux-cgroup-v2",
        reference,
        executionUnitId: "ap015-scripted-stopped-before-ack",
        generationSealedAt: "2026-09-14T00:00:01.000Z",
        unitEmptyObservedAt: "2026-09-14T00:00:02.000Z",
      },
      now: "2026-09-14T00:00:03.000Z",
    });
    rejected(
      await client.callTool({
        name: "agentport_acknowledge_interruption",
        arguments: {
          ...acknowledgement,
          operationId: "ap015-stale-ack-revision",
          expectedRevision: recovering.revision + 1,
        },
      }),
      "operation_conflict",
      [],
    );
    const [committed] = await Promise.all([
      timed(samples, "acknowledgement", () =>
        client.callTool({
          name: "agentport_acknowledge_interruption",
          arguments: acknowledgement,
        }),
      ),
      client.callTool({ name: "agentport_get_task", arguments: { taskId } }),
      client.callTool({
        name: "agentport_get_events",
        arguments: { taskId, limit: 1 },
      }),
    ]);
    expect(accepted(committed)).toMatchObject({
      replayed: false,
      task: {
        taskId,
        state: "interrupted",
        reason: "outcome_unknown",
        execution: { state: "interrupted", quarantined: false },
      },
    });
    const replay = await timed(samples, "acknowledgement", () =>
      client.callTool({
        name: "agentport_acknowledge_interruption",
        arguments: acknowledgement,
      }),
    );
    expect(accepted(replay)).toMatchObject({
      replayed: true,
      task: { taskId, state: "interrupted" },
    });
    expect(JSON.stringify({ committed, replay })).not.toContain(
      "linux-cgroup-v2",
    );
    await fixture.registry.replace({
      ...fixture.registryConfiguration,
      principals: fixture.registryConfiguration.principals.map((principal) =>
        principal.principalId === "principal-a"
          ? { ...principal, active: false }
          : principal,
      ),
    });
    rejected(
      await client.callTool({
        name: "agentport_acknowledge_interruption",
        arguments: { ...acknowledgement, operationId: "ap015-revoked-ack" },
      }),
      "access_denied",
      [taskId, PRIVATE_INSTRUCTION],
    );
    await endpoint.flushAudit();
    expect(
      JSON.stringify(await fixture.store.probe("inspectProductAudit")),
    ).not.toContain(PRIVATE_INSTRUCTION);
    assertTimings(samples, ["acknowledgement"]);
  });
});
