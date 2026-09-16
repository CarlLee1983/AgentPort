import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join } from "node:path";

import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import type {
  ExecutionSupervisor,
  VerifiedStopEvidence,
} from "../../src/core/execution-supervisor.js";
import type { ExecutionReference } from "../../src/core/types.js";
import { ControlledRuntimeDispatcher } from "../../src/dispatcher/controlled-runtime-dispatcher.js";
import { MCP_PROTOCOL_VERSION } from "../../src/mcp/protocol.js";
import { listTasksSuccessSchema } from "../../src/mcp/schemas.js";
import { RuntimeWorkerIngress } from "../../src/runtime/worker/ingress.js";
import { RuntimeWorkerIngressClient } from "../../src/runtime/worker/ingress-client.js";
import {
  encodeWorkerObservation,
  RuntimeWorkerObservationSequence,
} from "../../src/runtime/worker/protocol.js";
import {
  createDurableAdmissionFixture,
  INVALID_TOKEN,
  SCOPE_A_TOKEN,
  SCOPE_B_TOKEN,
  type DurableAdmissionFixture,
} from "../fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
  expectStructuredTextAgreement,
  startDurableAdmissionMcpEndpoint,
} from "../fixtures/durable-admission-mcp.js";

const PRIVATE_INSTRUCTION = "AP017-PRIVATE-INSTRUCTION-MARKER";
const PRIVATE_RESULT = "AP017-PRIVATE-RESULT-MARKER";
const SYNTHETIC_REFERENCE = "ap017-synthetic-terminal-reference";
const RESULT_DIRECTORY = "node_modules/.cache/agentport-ap017";
const TARGET_BYTES = 8 * 1024 * 1024;
const TASK_COUNT = 100;

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

interface PageObservation {
  taskIds: string[];
  nextCursor: string | null;
}

interface RawPageObservation extends PageObservation {
  layerBytes: {
    structuredResult: number;
    jsonText: number;
    serializedTextContent: number;
    jsonRpcResponseBody: number;
  };
}

interface BoundaryObservation {
  summary: string;
  repeatCount: number;
  logicalSummaryBytes: number;
  acceptedWorkerFrameBytes: number;
  rejectedWorkerFrameBytes: number;
  rejectionOwner:
    "encodeWorkerObservation" | "RuntimeWorkerObservationSequence";
}

interface CompletedTask {
  taskId: string;
  workerFrameBytes: number;
}

interface SanitizedFixtureRecord {
  fixture: {
    label: string;
    repeatedCodePoint: string;
    privateMarkerBytes: number;
    taskCount: number;
  };
  derivation: {
    acceptedRepeatCount: number;
    rejectedRepeatCount: number;
    perItemLogicalSummaryBytes: number;
    acceptedWorkerFrameBytes: number;
    rejectedWorkerFrameBytes: number;
    rejectionOwner: BoundaryObservation["rejectionOwner"];
  };
  expected: {
    defaultFirst: { itemCount: 50; nextCursor: "non-null" };
    defaultContinuation: { itemCount: 50; nextCursor: "null" };
    maximum: { itemCount: 100; nextCursor: "null" };
  };
  actual: {
    officialClient: Record<string, { itemCount: number; nextCursor: string }>;
    rawLoopback: Record<
      string,
      {
        itemCount: number;
        nextCursor: string;
        layers: Record<
          string,
          {
            observedBytes: number;
            targetBytes: number;
            differenceBytes: number;
          }
        >;
      }
    >;
    privacy: {
      foreignFreshPageItemCount: number;
      foreignCursorResult: "not_found";
      revokedFreshReadResult: "access_denied";
      invalidBearerHttpStatus: 401;
      invalidBearerAuditResult: "unauthorized";
      revokedAuditResult: "access_denied";
      eventCount: number;
      auditRecordCount: number;
    };
  };
}

function candidate(reference: ExecutionReference, summary: string) {
  return {
    kind: "candidate" as const,
    reference,
    ordinal: 1,
    finalOrdinal: 1,
    outcome: "succeeded" as const,
    summary,
    sessionReference: null,
  };
}

function workerAccepts(
  reference: ExecutionReference,
  summary: string,
): boolean {
  let encoded: string;
  try {
    encoded = encodeWorkerObservation(candidate(reference, summary));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Worker observation exceeds the protocol bound"
    ) {
      return false;
    }
    throw error;
  }
  return (
    new RuntimeWorkerObservationSequence().accept(reference, encoded) !==
    undefined
  );
}

function deriveBoundary(
  reference: ExecutionReference,
  repeated: "漢" | '"',
): BoundaryObservation {
  const summaryFor = (repeatCount: number): string =>
    `${PRIVATE_RESULT}${repeated.repeat(repeatCount)}`;
  let accepted = 0;
  let rejected = 1;
  while (workerAccepts(reference, summaryFor(rejected))) {
    accepted = rejected;
    rejected *= 2;
    if (rejected > 1024 * 1024) {
      throw new Error("Worker candidate boundary was not bounded");
    }
  }
  while (rejected - accepted > 1) {
    const middle = Math.floor((accepted + rejected) / 2);
    if (workerAccepts(reference, summaryFor(middle))) accepted = middle;
    else rejected = middle;
  }

  const summary = summaryFor(accepted);
  const rejectedSummary = summaryFor(rejected);
  const acceptedFrame = encodeWorkerObservation(candidate(reference, summary));
  let rejectionOwner: BoundaryObservation["rejectionOwner"];
  try {
    const rejectedFrame = encodeWorkerObservation(
      candidate(reference, rejectedSummary),
    );
    if (
      new RuntimeWorkerObservationSequence().accept(
        reference,
        rejectedFrame,
      ) !== undefined
    ) {
      throw new Error("The first rejected repeat unexpectedly passed ingress");
    }
    rejectionOwner = "RuntimeWorkerObservationSequence";
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Worker observation exceeds the protocol bound"
    ) {
      rejectionOwner = "encodeWorkerObservation";
    } else {
      throw error;
    }
  }
  if (
    !workerAccepts(reference, summary) ||
    workerAccepts(reference, rejectedSummary)
  ) {
    throw new Error("Binary-searched worker boundary was not adjacent");
  }
  return {
    summary,
    repeatCount: accepted,
    logicalSummaryBytes: Buffer.byteLength(summary, "utf8"),
    acceptedWorkerFrameBytes: Buffer.byteLength(acceptedFrame, "utf8"),
    rejectedWorkerFrameBytes: Buffer.byteLength(
      JSON.stringify(candidate(reference, rejectedSummary)),
      "utf8",
    ),
    rejectionOwner,
  };
}

function createVerifiedStopHarness(): {
  supervisor: ExecutionSupervisor;
  verifier: {
    verify(value: unknown): Omit<VerifiedStopEvidence, "kind"> | undefined;
  };
} {
  const authentic = new WeakSet<object>();
  return {
    verifier: {
      verify(value) {
        if (
          typeof value !== "object" ||
          value === null ||
          !authentic.has(value)
        ) {
          return undefined;
        }
        const evidence = value as VerifiedStopEvidence;
        return {
          platform: evidence.platform,
          reference: { ...evidence.reference },
          executionUnitId: evidence.executionUnitId,
          generationSealedAt: evidence.generationSealedAt,
          unitEmptyObservedAt: evidence.unitEmptyObservedAt,
        };
      },
    },
    supervisor: {
      start(reference) {
        return Promise.resolve({
          kind: "started",
          executionUnitId: `ap017-unit-${reference.executionId}`,
        });
      },
      revokeAndStop(reference) {
        const evidence: VerifiedStopEvidence = {
          kind: "verified",
          platform: "linux-cgroup-v2",
          reference,
          executionUnitId: `ap017-unit-${reference.executionId}`,
          generationSealedAt: "2026-09-16T00:00:01.000Z",
          unitEmptyObservedAt: "2026-09-16T00:00:02.000Z",
        };
        authentic.add(evidence);
        return Promise.resolve({ kind: "stopped", evidence });
      },
      reconcile() {
        return Promise.resolve({ kind: "indeterminate" });
      },
    },
  };
}

async function completeTaskThroughWorker(
  fixture: DurableAdmissionFixture,
  supervisor: ExecutionSupervisor,
  index: number,
  summaryForReference: (reference: ExecutionReference) => string,
): Promise<CompletedTask & { reference: ExecutionReference; summary: string }> {
  const submitted = await fixture.service.submitTask(
    { principalId: "principal-a" },
    {
      operationId: `ap017-submit-${index.toString().padStart(3, "0")}`,
      agentId: "agent-a",
      instruction: `${PRIVATE_INSTRUCTION}-${index.toString().padStart(3, "0")}`,
    },
  );
  let opened: RuntimeWorkerIngress | undefined;
  let openedReference: ExecutionReference | undefined;
  const dispatcher = new ControlledRuntimeDispatcher(
    fixture.service,
    { dispatchAuthority: () => Promise.resolve(SYNTHETIC_REFERENCE) },
    supervisor,
    {
      async open({ reference, lifecycle }) {
        openedReference = reference;
        opened = await RuntimeWorkerIngress.open({
          endpoint: join(
            fixture.directory,
            `ap017-${index.toString().padStart(3, "0")}.sock`,
          ),
          reference,
          lifecycle,
        });
        return {
          session: opened.session,
          close: () => opened?.close() ?? Promise.resolve(),
        };
      },
    },
  );
  const dispatch = await dispatcher.dispatch(submitted.task.taskId);
  if (
    dispatch.kind !== "started" ||
    opened === undefined ||
    openedReference === undefined
  ) {
    await opened?.close();
    throw new Error("Synthetic worker dispatch did not start");
  }

  const reference = openedReference;
  const summary = summaryForReference(reference);
  const encoded = encodeWorkerObservation(candidate(reference, summary));
  const worker = await RuntimeWorkerIngressClient.connect(opened.session);
  try {
    await worker.emit(encoded, 1, "candidate");
    await expect
      .poll(async () => {
        const execution = await fixture.store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: submitted.task.taskId,
        });
        return {
          workspaceClaim: execution?.workspaceClaim,
        };
      })
      .toEqual({ workspaceClaim: "released" });
    const terminal = await fixture.service.getTask(
      { principalId: "principal-a" },
      { taskId: submitted.task.taskId },
    );
    if (
      terminal.state !== "completed" ||
      terminal.result?.kind !== "completed" ||
      terminal.result.summary !== summary
    ) {
      throw new Error("Verified stop did not durably terminalize the Task");
    }
  } finally {
    worker.close();
    await opened.close();
  }
  return {
    taskId: submitted.task.taskId,
    reference,
    summary,
    workerFrameBytes: Buffer.byteLength(encoded, "utf8"),
  };
}

function structured(result: ToolResult): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expectStructuredTextAgreement(result);
  expect(result.structuredContent).toBeTypeOf("object");
  return result.structuredContent as Record<string, unknown>;
}

function assertPage(
  payload: Record<string, unknown>,
  summary: string,
  expectedCount: number,
  cursor: "null" | "non-null",
): PageObservation {
  const parsed = listTasksSuccessSchema.safeParse(payload);
  if (!parsed.success)
    throw new Error("Task page failed its public output schema");
  if (parsed.data.tasks.length !== expectedCount) {
    throw new Error("Task page returned an incomplete item count");
  }
  if (
    (cursor === "null" && parsed.data.nextCursor !== null) ||
    (cursor === "non-null" && parsed.data.nextCursor === null)
  ) {
    throw new Error("Task page returned the wrong cursor outcome");
  }
  for (const task of parsed.data.tasks) {
    if (Object.prototype.hasOwnProperty.call(task, "instruction")) {
      throw new Error("Task summary exposed instruction");
    }
    if (
      task.state !== "completed" ||
      task.result?.kind !== "completed" ||
      task.result.summary !== summary
    ) {
      throw new Error("Task page returned an incomplete terminal summary");
    }
  }
  return {
    taskIds: parsed.data.tasks.map((task) => task.taskId),
    nextCursor: parsed.data.nextCursor,
  };
}

async function officialPage(
  client: Client,
  args: Record<string, unknown>,
  summary: string,
  expectedCount: number,
  cursor: "null" | "non-null",
): Promise<PageObservation> {
  return assertPage(
    structured(
      await client.callTool({
        name: "agentport_list_tasks",
        arguments: args,
      }),
    ),
    summary,
    expectedCount,
    cursor,
  );
}

let rawRequestSequence = 0;

function rawCall(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  rawRequestSequence += 1;
  return {
    jsonrpc: "2.0",
    id: `ap017-raw-${rawRequestSequence.toString()}`,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": {
          name: "ap017-capacity-reader",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

function rawHeaders(
  name: string,
  token = SCOPE_A_TOKEN,
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "mcp-method": "tools/call",
    "mcp-name": name,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
  };
}

async function rawPage(
  url: URL,
  args: Record<string, unknown>,
  summary: string,
  expectedCount: number,
  cursor: "null" | "non-null",
): Promise<RawPageObservation> {
  const call = rawCall("agentport_list_tasks", args);
  const response = await fetch(url, {
    method: "POST",
    headers: rawHeaders("agentport_list_tasks"),
    body: JSON.stringify(call),
  });
  if (response.status !== 200)
    throw new Error("Raw Task page HTTP request failed");
  const body = await response.text();
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new Error("Raw Task page was not valid JSON");
  }
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope)
  ) {
    throw new Error("Raw Task page JSON-RPC envelope was invalid");
  }
  const record = envelope as Record<string, unknown>;
  if (
    record.jsonrpc !== "2.0" ||
    record.id !== call.id ||
    record.error !== undefined
  ) {
    throw new Error("Raw Task page returned a JSON-RPC error");
  }
  if (typeof record.result !== "object" || record.result === null) {
    throw new Error("Raw Task page omitted its MCP result");
  }
  const result = record.result as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
  };
  if (result.isError === true)
    throw new Error("Raw Task page returned an MCP error");
  expectStructuredTextAgreement(result);
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null ||
    Array.isArray(result.structuredContent)
  ) {
    throw new Error("Raw Task page omitted structured content");
  }
  const first = result.content[0];
  if (first?.type !== "text" || first.text === undefined) {
    throw new Error("Raw Task page omitted JSON TextContent");
  }
  return {
    ...assertPage(
      result.structuredContent as Record<string, unknown>,
      summary,
      expectedCount,
      cursor,
    ),
    layerBytes: {
      structuredResult: Buffer.byteLength(
        JSON.stringify(result.structuredContent),
        "utf8",
      ),
      jsonText: Buffer.byteLength(first.text, "utf8"),
      serializedTextContent: Buffer.byteLength(
        JSON.stringify(result.content),
        "utf8",
      ),
      jsonRpcResponseBody: Buffer.byteLength(body, "utf8"),
    },
  };
}

function rejected(result: ToolResult, code: string): void {
  assertSanitized(JSON.stringify(result), "application error");
  expect(result.isError).toBe(true);
  expectStructuredTextAgreement(result);
  expect(result.structuredContent).toMatchObject({
    ok: false,
    error: { code },
  });
}

function assertSanitized(value: string, sink: string): void {
  if (
    [PRIVATE_INSTRUCTION, PRIVATE_RESULT, SYNTHETIC_REFERENCE].some((secret) =>
      value.includes(secret),
    )
  ) {
    throw new Error(`Private marker entered ${sink}`);
  }
}

function assertSameTasks(
  left: readonly string[],
  right: readonly string[],
): void {
  if (
    left.length !== right.length ||
    left.some((id, index) => id !== right[index])
  ) {
    throw new Error("Task pages did not describe the same complete snapshot");
  }
}

function comparison(observedBytes: number) {
  return {
    observedBytes,
    targetBytes: TARGET_BYTES,
    differenceBytes: observedBytes - TARGET_BYTES,
  };
}

function cursorOutcome(cursor: string | null): string {
  return cursor === null ? "null" : "non-null";
}

function pageRecord(
  page: RawPageObservation,
  logicalSummaryBytes: number,
  frameBytesByTaskId: ReadonlyMap<string, number>,
) {
  const workerFrameBytes = page.taskIds.reduce((total, taskId) => {
    const bytes = frameBytesByTaskId.get(taskId);
    if (bytes === undefined)
      throw new Error("Task page had no worker-frame evidence");
    return total + bytes;
  }, 0);
  return {
    itemCount: page.taskIds.length,
    nextCursor: cursorOutcome(page.nextCursor),
    layers: {
      logicalSummary: comparison(logicalSummaryBytes * page.taskIds.length),
      workerFrame: comparison(workerFrameBytes),
      structuredResult: comparison(page.layerBytes.structuredResult),
      jsonText: comparison(page.layerBytes.jsonText),
      serializedTextContent: comparison(page.layerBytes.serializedTextContent),
      jsonRpcResponseBody: comparison(page.layerBytes.jsonRpcResponseBody),
    },
  };
}

async function allEvents(
  client: Client,
): Promise<{ count: number; serialized: string }> {
  let afterCursor: string | undefined;
  let count = 0;
  const serializedPages: string[] = [];
  for (;;) {
    const payload = structured(
      await client.callTool({
        name: "agentport_get_events",
        arguments: {
          limit: 100,
          ...(afterCursor === undefined ? {} : { afterCursor }),
        },
      }),
    );
    const events = payload.events;
    if (!Array.isArray(events)) throw new Error("Event page omitted events");
    count += events.length;
    serializedPages.push(JSON.stringify(payload));
    if (payload.nextCursor === null) break;
    if (typeof payload.nextCursor !== "string") {
      throw new Error("Event page returned an invalid cursor");
    }
    afterCursor = payload.nextCursor;
  }
  return { count, serialized: serializedPages.join("") };
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

async function writeRecord(
  fixtures: readonly SanitizedFixtureRecord[],
  sourceSha256Before: string,
): Promise<string> {
  await mkdir(RESULT_DIRECTORY, { recursive: true });
  const path = join(
    RESULT_DIRECTORY,
    `terminal-summary-capacity-${Date.now().toString()}.json`,
  );
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    packageManager: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const sourceSha256After = await sourceDigest();
  expect(sourceSha256After).toBe(sourceSha256Before);
  const content = {
    scenario: "ap017-terminal-summary-capacity-characterization",
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
      packageManager: manifest.packageManager,
      mcpProtocol: MCP_PROTOCOL_VERSION,
      mcpClient: manifest.dependencies["@modelcontextprotocol/client"],
      mcpServer: manifest.dependencies["@modelcontextprotocol/server"],
      sqlite: manifest.dependencies["better-sqlite3"],
      vitest: manifest.devDependencies.vitest,
    },
    target: {
      documentedBytes: TARGET_BYTES,
      authoritativeLayer: "unresolved",
      capacityVerdict: "not-selected-by-ap017",
    },
    fixtures,
    residualDecisions: [
      "authoritative response layer remains unresolved",
      "pagination and output_limit behavior remain unresolved",
      "five-second Client outage and production backpressure remain unproven",
      "Linux Stop Evidence, complete G5, S6, and release acceptance remain unproven",
    ],
    resultLocation: path,
  };
  const serialized = `${JSON.stringify(content, null, 2)}\n`;
  assertSanitized(serialized, "sanitized candidate record");
  await writeFile(path, serialized);
  const written = await readFile(path, "utf8");
  if (written !== serialized) {
    throw new Error("Sanitized candidate record was not written exactly");
  }
  process.stdout.write(
    `${JSON.stringify({ scenario: content.scenario, resultLocation: path })}\n`,
  );
  return path;
}

async function characterizeFixture(
  label: string,
  repeated: "漢" | '"',
  repeatedCodePoint: "U+6F22" | "U+0022",
): Promise<SanitizedFixtureRecord> {
  const stopHarness = createVerifiedStopHarness();
  let idSequence = 0;
  const fixture = await createDurableAdmissionFixture(
    {},
    {
      newId: () => `ap017-id-${(++idSequence).toString().padStart(6, "0")}`,
      stopEvidenceVerifier: stopHarness.verifier,
    },
  );
  let endpoint:
    Awaited<ReturnType<typeof startDurableAdmissionMcpEndpoint>> | undefined;
  let client: Client | undefined;
  let foreign: Client | undefined;
  try {
    let boundary: BoundaryObservation | undefined;
    const completed: CompletedTask[] = [];
    for (let index = 0; index < TASK_COUNT; index++) {
      const task = await completeTaskThroughWorker(
        fixture,
        stopHarness.supervisor,
        index,
        (reference) => {
          boundary ??= deriveBoundary(reference, repeated);
          return boundary.summary;
        },
      );
      completed.push(task);
      const currentBoundary = boundary;
      if (currentBoundary === undefined) {
        throw new Error("Terminal Task boundary was not derived");
      }
      if (task.summary !== currentBoundary.summary) {
        throw new Error("Terminal Task did not preserve the derived fixture");
      }
      if (task.workerFrameBytes !== currentBoundary.acceptedWorkerFrameBytes) {
        throw new Error("Deterministic worker References changed frame size");
      }
    }
    if (boundary === undefined || completed.length !== TASK_COUNT) {
      throw new Error("Terminal Task fixture was incomplete");
    }
    const frameBytesByTaskId = new Map(
      completed.map((task) => [task.taskId, task.workerFrameBytes]),
    );

    endpoint = await startDurableAdmissionMcpEndpoint(fixture);
    client = await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN);
    foreign = await connectDurableAdmissionClient(endpoint.url, SCOPE_B_TOKEN);

    const officialFirst = await officialPage(
      client,
      {},
      boundary.summary,
      50,
      "non-null",
    );
    if (officialFirst.nextCursor === null)
      throw new Error("Missing official cursor");
    const officialSecond = await officialPage(
      client,
      { cursor: officialFirst.nextCursor },
      boundary.summary,
      50,
      "null",
    );
    const officialMaximum = await officialPage(
      client,
      { limit: 100 },
      boundary.summary,
      100,
      "null",
    );
    assertSameTasks(
      [...officialFirst.taskIds, ...officialSecond.taskIds],
      officialMaximum.taskIds,
    );

    const rawFirst = await rawPage(
      endpoint.url,
      {},
      boundary.summary,
      50,
      "non-null",
    );
    if (rawFirst.nextCursor === null) throw new Error("Missing raw cursor");
    const rawSecond = await rawPage(
      endpoint.url,
      { cursor: rawFirst.nextCursor },
      boundary.summary,
      50,
      "null",
    );
    const rawMaximum = await rawPage(
      endpoint.url,
      { limit: 100 },
      boundary.summary,
      100,
      "null",
    );
    assertSameTasks(
      [...rawFirst.taskIds, ...rawSecond.taskIds],
      rawMaximum.taskIds,
    );
    assertSameTasks(officialFirst.taskIds, rawFirst.taskIds);
    assertSameTasks(officialSecond.taskIds, rawSecond.taskIds);
    assertSameTasks(officialMaximum.taskIds, rawMaximum.taskIds);

    const foreignFresh = structured(
      await foreign.callTool({
        name: "agentport_list_tasks",
        arguments: { limit: 100 },
      }),
    );
    assertSanitized(JSON.stringify(foreignFresh), "foreign fresh page");
    const foreignFreshTasks = foreignFresh.tasks;
    if (!Array.isArray(foreignFreshTasks) || foreignFreshTasks.length !== 0) {
      throw new Error("Foreign Principal observed terminal Tasks");
    }
    rejected(
      await foreign.callTool({
        name: "agentport_list_tasks",
        arguments: { cursor: officialFirst.nextCursor },
      }),
      "not_found",
    );

    const events = await allEvents(client);
    assertSanitized(events.serialized, "event projection");

    const invalidBearer = await fetch(endpoint.url, {
      method: "POST",
      headers: rawHeaders("agentport_list_tasks", INVALID_TOKEN),
      body: JSON.stringify(rawCall("agentport_list_tasks", { limit: 100 })),
    });
    expect(invalidBearer.status).toBe(401);
    const invalidBearerBody = await invalidBearer.text();
    assertSanitized(invalidBearerBody, "authentication error");

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
        name: "agentport_list_tasks",
        arguments: { limit: 100 },
      }),
      "access_denied",
    );

    await endpoint.flushAudit();
    const audit = (await fixture.store.probe("inspectProductAudit")) as {
      records: Array<Record<string, unknown>>;
    };
    const serializedAudit = JSON.stringify(audit);
    assertSanitized(serializedAudit, "product audit");
    const invalidBearerAudited = audit.records.some(
      (record) =>
        record.principalId === null &&
        record.method === "tools/call" &&
        record.resultCode === "unauthorized",
    );
    const revokedReadAudited = audit.records.some(
      (record) =>
        record.principalId === "principal-a" &&
        record.method === "tools/call" &&
        record.toolName === "agentport_list_tasks" &&
        record.resultCode === "access_denied",
    );
    if (!invalidBearerAudited || !revokedReadAudited) {
      throw new Error("Required sanitized denial audit outcomes were absent");
    }

    return {
      fixture: {
        label,
        repeatedCodePoint,
        privateMarkerBytes: Buffer.byteLength(PRIVATE_RESULT, "utf8"),
        taskCount: completed.length,
      },
      derivation: {
        acceptedRepeatCount: boundary.repeatCount,
        rejectedRepeatCount: boundary.repeatCount + 1,
        perItemLogicalSummaryBytes: boundary.logicalSummaryBytes,
        acceptedWorkerFrameBytes: boundary.acceptedWorkerFrameBytes,
        rejectedWorkerFrameBytes: boundary.rejectedWorkerFrameBytes,
        rejectionOwner: boundary.rejectionOwner,
      },
      expected: {
        defaultFirst: { itemCount: 50, nextCursor: "non-null" },
        defaultContinuation: { itemCount: 50, nextCursor: "null" },
        maximum: { itemCount: 100, nextCursor: "null" },
      },
      actual: {
        officialClient: {
          defaultFirst: {
            itemCount: officialFirst.taskIds.length,
            nextCursor: cursorOutcome(officialFirst.nextCursor),
          },
          defaultContinuation: {
            itemCount: officialSecond.taskIds.length,
            nextCursor: cursorOutcome(officialSecond.nextCursor),
          },
          maximum: {
            itemCount: officialMaximum.taskIds.length,
            nextCursor: cursorOutcome(officialMaximum.nextCursor),
          },
        },
        rawLoopback: {
          defaultFirst: pageRecord(
            rawFirst,
            boundary.logicalSummaryBytes,
            frameBytesByTaskId,
          ),
          defaultContinuation: pageRecord(
            rawSecond,
            boundary.logicalSummaryBytes,
            frameBytesByTaskId,
          ),
          maximum: pageRecord(
            rawMaximum,
            boundary.logicalSummaryBytes,
            frameBytesByTaskId,
          ),
        },
        privacy: {
          foreignFreshPageItemCount: foreignFreshTasks.length,
          foreignCursorResult: "not_found",
          revokedFreshReadResult: "access_denied",
          invalidBearerHttpStatus: 401,
          invalidBearerAuditResult: "unauthorized",
          revokedAuditResult: "access_denied",
          eventCount: events.count,
          auditRecordCount: audit.records.length,
        },
      },
    };
  } finally {
    await client?.close().catch(() => undefined);
    await foreign?.close().catch(() => undefined);
    await endpoint?.close().catch(() => undefined);
    await fixture.close();
  }
}

describe("AP-017 terminal Task-summary wire capacity", () => {
  it("characterizes complete 100-item UTF-8 and JSON-escape terminal pages without selecting response behavior", async () => {
    const sourceSha256Before = await sourceDigest();
    const fixtures = [
      await characterizeFixture("utf8-multibyte", "漢", "U+6F22"),
      await characterizeFixture("json-escape", '"', "U+0022"),
    ];
    const resultLocation = await writeRecord(fixtures, sourceSha256Before);
    expect(resultLocation.startsWith(`${RESULT_DIRECTORY}/`)).toBe(true);
  }, 120_000);
});
