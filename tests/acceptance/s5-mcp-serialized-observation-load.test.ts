import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { arch, platform, release } from "node:os";
import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeWorkerIngress } from "../../src/runtime/worker/ingress.js";
import { RuntimeWorkerIngressClient } from "../../src/runtime/worker/ingress-client.js";
import { encodeWorkerObservation } from "../../src/runtime/worker/protocol.js";
import { MCP_PROTOCOL_VERSION } from "../../src/mcp/protocol.js";
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

const PRIVATE_INSTRUCTION = "AP016-PRIVATE-INSTRUCTION-MARKER";
const PRIVATE_DIAGNOSTIC = "AP014-PRIVATE-DIAGNOSTIC-MARKER";
const RESULT_DIRECTORY = "node_modules/.cache/agentport-ap016";
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

function rejected(result: ToolResult, code: string): void {
  expect(result.isError).toBe(true);
  expect(structured(result)).toMatchObject({ ok: false, error: { code } });
  expect(JSON.stringify(result)).not.toContain(PRIVATE_INSTRUCTION);
  expect(JSON.stringify(result)).not.toContain(PRIVATE_DIAGNOSTIC);
}

function rawCall(name: string, args: Record<string, unknown>): object {
  return {
    jsonrpc: "2.0",
    id: `ap016-raw-${name}`,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": {
          name: "ap016-test-reader",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

function rawHeaders(name: string): Record<string, string> {
  return {
    authorization: `Bearer ${SCOPE_A_TOKEN}`,
    "content-type": "application/json",
    "mcp-method": "tools/call",
    "mcp-name": name,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
}

async function rawResponseBytes(
  url: URL,
  name: string,
  args: Record<string, unknown>,
): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: rawHeaders(name),
    body: JSON.stringify(rawCall(name, args)),
  });
  expect(response.status).toBe(200);
  const body = await response.text();
  const envelope = JSON.parse(body) as {
    jsonrpc?: string;
    error?: unknown;
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content: Array<{ type: string; text?: string }>;
    };
  };
  expect(envelope.jsonrpc).toBe("2.0");
  expect(envelope.error).toBeUndefined();
  const result = envelope.result;
  if (result === undefined) throw new Error("Expected successful MCP result");
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ ok: true });
  expectStructuredTextAgreement(result);
  return Buffer.byteLength(body, "utf8");
}

function pausedReader(
  url: URL,
  taskId: string,
): {
  firstChunk: Promise<number>;
  finished: Promise<{ status: number; bytes: number }>;
  resume(): void;
  disconnect(): void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstResolve!: (bytes: number) => void;
  let firstReject!: (error: Error) => void;
  const firstChunk = new Promise<number>((resolve, reject) => {
    firstResolve = resolve;
    firstReject = reject;
  });
  let doneResolve!: (result: { status: number; bytes: number }) => void;
  let doneReject!: (error: Error) => void;
  const finished = new Promise<{ status: number; bytes: number }>(
    (resolve, reject) => {
      doneResolve = resolve;
      doneReject = reject;
    },
  );
  const request = httpRequest(
    url,
    { method: "POST", headers: rawHeaders("agentport_get_task") },
    (response) => {
      const chunks: Buffer[] = [];
      let ended = false;
      const firstRead = (): void => {
        const chunk = response.read(1024) as Buffer | null;
        if (chunk === null) {
          response.once("readable", firstRead);
          return;
        }
        chunks.push(chunk);
        firstResolve(chunk.byteLength);
        void gate.then(() => {
          response.on("data", (next: Buffer) => chunks.push(next));
          response.once("end", () => {
            ended = true;
            doneResolve({
              status: response.statusCode ?? 0,
              bytes: chunks.reduce((total, next) => total + next.byteLength, 0),
            });
          });
          response.resume();
        });
      };
      response.once("readable", firstRead);
      response.once("error", (error: Error) => {
        firstReject(error);
        doneReject(error);
      });
      response.once("close", () => {
        if (ended) return;
        const error = new Error("test reader response closed early");
        firstReject(error);
        doneReject(error);
      });
    },
  );
  request.once("error", (error: Error) => {
    firstReject(error);
    doneReject(error);
  });
  request.setTimeout(10_000, () =>
    request.destroy(new Error("test reader timed out")),
  );
  request.end(JSON.stringify(rawCall("agentport_get_task", { taskId })));
  return {
    firstChunk,
    finished,
    resume: release,
    disconnect: () => request.destroy(new Error("test reader disconnected")),
  };
}

async function sourceDigest(): Promise<string> {
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const digest = createHash("sha256");
  for (const path of paths) {
    digest.update(path);
    digest.update("\0");
    try {
      digest.update(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      digest.update("<deleted>");
    }
    digest.update("\0");
  }
  return digest.digest("hex");
}

async function record(
  scenario: string,
  values: Record<string, unknown>,
  sourceSha256Before: string,
): Promise<void> {
  await mkdir(RESULT_DIRECTORY, { recursive: true });
  const path = join(
    RESULT_DIRECTORY,
    `${scenario}-${Date.now().toString()}.json`,
  );
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    packageManager: string;
    dependencies: Record<string, string>;
  };
  const sourceSha256After = await sourceDigest();
  expect(sourceSha256After).toBe(sourceSha256Before);
  const content = {
    scenario,
    candidate: {
      baseRevision: execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      sourceSha256Before,
      sourceSha256After,
    },
    platform: { os: platform(), release: release(), arch: arch() },
    versions: {
      node: process.version,
      pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
      mcpProtocol: MCP_PROTOCOL_VERSION,
      mcpClient: manifest.dependencies["@modelcontextprotocol/client"],
      mcpServer: manifest.dependencies["@modelcontextprotocol/server"],
      sqlite: manifest.dependencies["better-sqlite3"],
    },
    ...values,
    resultLocation: path,
  };
  await writeFile(path, `${JSON.stringify(content, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ scenario, resultLocation: path })}\n`,
  );
}

describe("AP-016 serialized outer observation and slow Client", () => {
  it("measures legal escaped Task content and a 100-event page without leaking protected fields", async () => {
    const sourceSha256Before = await sourceDigest();
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const foreign = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN),
    );
    const actor = { principalId: "principal-a" };
    const instruction = `${PRIVATE_INSTRUCTION}漢字${'"'.repeat(60_000)}`;
    const accepted = await fixture.service.submitTask(actor, {
      operationId: "ap016-large-task",
      agentId: "agent-a",
      instruction,
    });
    const taskId = accepted.task.taskId;
    for (let index = 0; index < 50; index++) {
      const task = await fixture.service.submitTask(actor, {
        operationId: `ap016-page-submit-${index.toString()}`,
        agentId: index % 2 === 0 ? "agent-a" : "agent-revokable",
        instruction: "bounded event metadata only",
      });
      await fixture.service.cancelTask(actor, {
        operationId: `ap016-page-cancel-${index.toString()}`,
        taskId: task.task.taskId,
      });
    }
    const task = structured(
      await client.callTool({
        name: "agentport_get_task",
        arguments: { taskId },
      }),
    );
    expect(task).toMatchObject({
      ok: true,
      task: { taskId, instruction, observationStatus: "current" },
    });
    const tasks = structured(
      await client.callTool({
        name: "agentport_list_tasks",
        arguments: { limit: 100 },
      }),
    );
    expect(tasks).toMatchObject({ ok: true });
    expect((tasks.tasks as unknown[]).length).toBeLessThanOrEqual(100);
    for (const summary of tasks.tasks as Record<string, unknown>[])
      expect(summary).not.toHaveProperty("instruction");
    expect(JSON.stringify(tasks)).not.toContain(PRIVATE_INSTRUCTION);
    const events = structured(
      await client.callTool({
        name: "agentport_get_events",
        arguments: { limit: 100 },
      }),
    );
    expect((events.events as unknown[]).length).toBe(100);
    for (const event of events.events as Record<string, unknown>[])
      expect(Object.keys(event).sort()).toEqual(
        [
          "agentId",
          "cursor",
          "occurredAt",
          "taskId",
          "taskRevision",
          "taskSeq",
          "type",
        ].sort(),
      );
    expect(events.nextCursor).toBeTypeOf("string");
    expect(JSON.stringify(events)).not.toContain(PRIVATE_INSTRUCTION);
    rejected(
      await foreign.callTool({
        name: "agentport_get_task",
        arguments: { taskId },
      }),
      "not_found",
    );
    rejected(
      await client.callTool({
        name: "agentport_list_tasks",
        arguments: { agentId: "agent-b" },
      }),
      "not_found",
    );
    rejected(
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap016-foreign-agent-submit",
          agentId: "agent-b",
          instruction: PRIVATE_DIAGNOSTIC,
        },
      }),
      "not_found",
    );
    const foreignTask = structured(
      await foreign.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "ap016-foreign-page-submit",
          agentId: "agent-b",
          instruction: "foreign event",
        },
      }),
    ).task as Record<string, unknown>;
    await foreign.callTool({
      name: "agentport_cancel_task",
      arguments: {
        operationId: "ap016-foreign-page-cancel",
        taskId: foreignTask.taskId,
      },
    });
    const foreignCursor = structured(
      await foreign.callTool({
        name: "agentport_get_events",
        arguments: { limit: 1 },
      }),
    ).nextCursor;
    expect(foreignCursor).toBeTypeOf("string");
    rejected(
      await client.callTool({
        name: "agentport_get_events",
        arguments: { afterCursor: foreignCursor },
      }),
      "not_found",
    );
    const invalid = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        ...rawHeaders("agentport_get_task"),
        authorization: `Bearer ${INVALID_TOKEN}`,
      },
      body: JSON.stringify(rawCall("agentport_get_task", { taskId })),
    });
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).not.toContain(PRIVATE_INSTRUCTION);
    await endpoint.flushAudit();
    const audit = await fixture.store.probe("inspectProductAudit");
    expect(JSON.stringify(audit)).not.toContain(PRIVATE_INSTRUCTION);
    expect(JSON.stringify(audit)).not.toContain(PRIVATE_DIAGNOSTIC);
    const wireBytes = {
      getTask: await rawResponseBytes(endpoint.url, "agentport_get_task", {
        taskId,
      }),
      listTasks: await rawResponseBytes(endpoint.url, "agentport_list_tasks", {
        limit: 100,
      }),
      getEvents: await rawResponseBytes(endpoint.url, "agentport_get_events", {
        limit: 100,
      }),
    };
    for (const bytes of Object.values(wireBytes))
      expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    await record(
      "ap016-serialized-page",
      {
        fixture: {
          legalInstructionBytes: Buffer.byteLength(instruction),
          eventLimit: 100,
        },
        expected: { pageCount: 100, wireTargetBytes: 8 * 1024 * 1024 },
        actual: { eventCount: (events.events as unknown[]).length, wireBytes },
      },
      sourceSha256Before,
    );
  }, 60_000);

  it("keeps observation and cancel durable while a test reader pauses, then survives its disconnect", async () => {
    const sourceSha256Before = await sourceDigest();
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const fixture = track(
      await createDurableAdmissionFixture(
        {},
        {
          stopRequester: { requestStop: async () => stopGate },
        },
      ),
    );
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const poller = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    const actor = { principalId: "principal-a" };
    const instruction = `${PRIVATE_INSTRUCTION}漢字${'"'.repeat(60_000)}`;
    const accepted = await fixture.service.submitTask(actor, {
      operationId: "ap016-held-submit",
      agentId: "agent-a",
      instruction,
    });
    const taskId = accepted.task.taskId;
    const { reference } = await fixture.service.prepareForDispatch(
      taskId,
      "ap016-held-synthetic-reference",
    );
    await fixture.service.markExecutionRunning(reference);
    const ingress = track(
      await RuntimeWorkerIngress.open({
        endpoint: `${fixture.directory}/ap016-ingress.sock`,
        reference,
        lifecycle: {
          persistQuestion: () => Promise.resolve(),
          waitForAcceptedAnswer: () => Promise.resolve({}),
          acknowledgeQuestionDelivery: () => Promise.resolve(),
          markQuestionDeliveryUnknown: () => Promise.resolve(),
          recordObservation: async (observation) => {
            await fixture.recordObservation(actor, { taskId, observation });
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
    const reader = pausedReader(endpoint.url, taskId);
    resources.push(async () => {
      reader.disconnect();
      await reader.finished.catch(() => undefined);
    });
    try {
      const firstBytes = await reader.firstChunk;
      const pausedAt = performance.now();
      expect(firstBytes).toBeLessThanOrEqual(1024);
      await worker.emit(
        encodeWorkerObservation({
          kind: "progress",
          reference,
          ordinal: 1,
          summary: "ap016-durable-progress",
        }),
        1,
        "progress",
      );
      const started = performance.now();
      const [polled, page, cancel] = await Promise.all([
        poller.callTool({ name: "agentport_get_task", arguments: { taskId } }),
        poller.callTool({
          name: "agentport_get_events",
          arguments: { taskId, limit: 50 },
        }),
        client.callTool({
          name: "agentport_cancel_task",
          arguments: { operationId: "ap016-held-cancel", taskId },
        }),
      ]);
      const otherClientMs = performance.now() - started;
      expect(otherClientMs).toBeLessThanOrEqual(2_000);
      expect(structured(polled)).toMatchObject({
        ok: true,
        task: {
          taskId,
          observationStatus: "current",
          execution: { progress: { summary: "ap016-durable-progress" } },
        },
      });
      expect(structured(page)).toMatchObject({ ok: true });
      expect(structured(cancel)).toMatchObject({
        ok: true,
        replayed: false,
        task: { taskId, state: "stopping", result: null },
      });
      const replay = structured(
        await client.callTool({
          name: "agentport_cancel_task",
          arguments: { operationId: "ap016-held-cancel", taskId },
        }),
      );
      expect(replay).toMatchObject({
        ok: true,
        replayed: true,
        task: { taskId, state: "stopping", result: null },
      });
      const execution = await fixture.store.getExecution({
        accessScopeId: "scope-a",
        allowedAgentIds: ["agent-a"],
        taskId,
      });
      expect(execution).toMatchObject({ workspaceClaim: "held" });
      const controlEvents = structured(
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
      const remaining = Math.max(0, 2_520 - (performance.now() - pausedAt));
      if (remaining > 0)
        await new Promise((resolve) => setTimeout(resolve, remaining));
      const pauseMs = performance.now() - pausedAt;
      expect(pauseMs).toBeGreaterThanOrEqual(2_500);
      reader.resume();
      const completed = await reader.finished;
      expect(completed.status).toBe(200);
      expect(completed.bytes).toBeGreaterThanOrEqual(128 * 1024);
      expect(completed.bytes - firstBytes).toBeGreaterThanOrEqual(64 * 1024);
      const disconnected = pausedReader(endpoint.url, taskId);
      resources.push(async () => {
        disconnected.disconnect();
        await disconnected.finished.catch(() => undefined);
      });
      await disconnected.firstChunk;
      disconnected.disconnect();
      await expect(disconnected.finished).rejects.toThrow(
        "test reader disconnected",
      );
      expect(
        structured(
          await poller.callTool({
            name: "agentport_get_task",
            arguments: { taskId },
          }),
        ),
      ).toMatchObject({ task: { taskId, state: "stopping", result: null } });
      await fixture.registry.replace({
        ...fixture.registryConfiguration,
        principals: fixture.registryConfiguration.principals.map((principal) =>
          principal.principalId === "principal-a"
            ? { ...principal, active: false }
            : principal,
        ),
      });
      for (const result of await Promise.all([
        client.callTool({ name: "agentport_get_task", arguments: { taskId } }),
        poller.callTool({ name: "agentport_list_tasks", arguments: {} }),
        poller.callTool({
          name: "agentport_get_events",
          arguments: { taskId },
        }),
      ]))
        rejected(result, "access_denied");
      await endpoint.flushAudit();
      const audit = await fixture.store.probe("inspectProductAudit");
      expect(JSON.stringify(audit)).not.toContain(PRIVATE_INSTRUCTION);
      expect(JSON.stringify(audit)).not.toContain(PRIVATE_DIAGNOSTIC);
      await record(
        "ap016-slow-reader",
        {
          fixture: { readerPauseTargetMs: 2_500, firstReadMaximumBytes: 1024 },
          expected: {
            state: "stopping",
            workspaceClaim: "held",
            progressOrdinal: 1,
          },
          actual: {
            pauseMs,
            responseBytes: completed.bytes,
            withheldBytes: completed.bytes - firstBytes,
            otherClientMs,
            state: "stopping",
            workspaceClaim: execution?.workspaceClaim,
            progressOrdinal: 1,
            cancelReplayed: replay.replayed,
            cancelRequestedEvent: true,
            revokedReadsRejected: true,
            readerDisconnected: true,
          },
        },
        sourceSha256Before,
      );
    } finally {
      reader.resume();
      reader.disconnect();
      releaseStop();
      await reader.finished.catch(() => undefined);
    }
  }, 60_000);
});
