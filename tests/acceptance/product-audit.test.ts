import { describe, expect, it } from "vitest";

import { createDurableAdmissionMcpHandler } from "../../src/mcp/adapter.js";
import { startLoopbackDurableAdmissionServer } from "../../src/mcp/loopback-server.js";
import type { ProductAuditSnapshot } from "../../src/storage/sqlite-durable-admission-store.js";
import {
  INVALID_TOKEN,
  SCOPE_A_TOKEN,
  createDurableAdmissionFixture,
} from "../fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
  startDurableAdmissionMcpEndpoint,
} from "../fixtures/durable-admission-mcp.js";

describe("product audit", () => {
  it("records bounded protocol metadata and outcomes without request arguments", async () => {
    const fixture = await createDurableAdmissionFixture();
    const endpoint = await startDurableAdmissionMcpEndpoint(fixture);
    const client = await connectDurableAdmissionClient(
      endpoint.url,
      SCOPE_A_TOKEN,
    );
    try {
      await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "audit-submit",
          agentId: "agent-a",
          instruction: "AP002-AUDIT-INSTRUCTION-SENTINEL",
        },
      });
      await client.callTool({
        name: "agentport_get_task",
        arguments: { taskId: "audit-cross-scope-identity" },
      });
      await fetch(endpoint.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SCOPE_A_TOKEN}`,
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "AUDIT-METADATA-INSTRUCTION-SECRET",
                version: "AUDIT-METADATA-PRIVATE-PATH-SECRET",
              },
              "io.modelcontextprotocol/clientCapabilities": {
                "AUDIT-METADATA-BEARER-SECRET": true,
              },
            },
          },
        }),
      });
      await fetch(endpoint.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SCOPE_A_TOKEN}`,
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "AUDIT-PROTOCOL-PRIVATE-PATH-SECRET",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
          params: {},
        }),
      });
      await fetch(endpoint.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${INVALID_TOKEN}`,
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      await endpoint.flushAudit();

      const snapshot = (await fixture.store.probe(
        "inspectProductAudit",
      )) as ProductAuditSnapshot;
      expect(snapshot.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            principalId: "principal-a",
            method: "tools/call",
            toolName: "agentport_submit_task",
            protocolVersion: "2026-07-28",
            resultCode: "ok",
          }),
          expect.objectContaining({
            principalId: "principal-a",
            toolName: "agentport_get_task",
            resultCode: "not_found",
          }),
          expect.objectContaining({
            principalId: null,
            method: "tools/list",
            resultCode: "unauthorized",
          }),
          expect.objectContaining({
            principalId: "principal-a",
            method: "tools/list",
            protocolVersion: "unsupported",
            resultCode: "unsupported_protocol",
          }),
        ]),
      );
      const metadataAudit = snapshot.records.find(
        ({ method, clientName, clientVersion }) =>
          method === "tools/list" &&
          clientName !== null &&
          clientVersion !== null,
      );
      expect(metadataAudit?.clientName).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(metadataAudit?.clientVersion).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(metadataAudit?.clientCapabilitiesJson).toMatch(
        /^\{"sha256":"[a-f0-9]{64}"\}$/u,
      );
      const persisted = JSON.stringify(snapshot);
      expect(persisted).not.toContain(SCOPE_A_TOKEN);
      expect(persisted).not.toContain(INVALID_TOKEN);
      expect(persisted).not.toContain("AP002-AUDIT-INSTRUCTION-SENTINEL");
      expect(persisted).not.toContain("audit-cross-scope-identity");
      expect(persisted).not.toContain(fixture.directory);
      expect(persisted).not.toContain("AUDIT-METADATA");
      expect(persisted).not.toContain("AUDIT-PROTOCOL");
    } finally {
      await client.close();
      await endpoint.close();
      await fixture.close();
    }
  });

  it("does not let audit ring overflow block reserved cancellation", async () => {
    const fixture = await createDurableAdmissionFixture({ auditCapacity: 1 });
    const endpoint = await startDurableAdmissionMcpEndpoint(fixture);
    const client = await connectDurableAdmissionClient(
      endpoint.url,
      SCOPE_A_TOKEN,
    );
    try {
      const submitted = await client.callTool({
        name: "agentport_submit_task",
        arguments: {
          operationId: "audit-overflow-submit",
          agentId: "agent-a",
          instruction: "cancel remains reserved",
        },
      });
      const task = submitted.structuredContent as {
        task: { taskId: string };
      };
      await expect(
        client.callTool({
          name: "agentport_cancel_task",
          arguments: {
            operationId: "audit-overflow-cancel",
            taskId: task.task.taskId,
          },
        }),
      ).resolves.toMatchObject({
        structuredContent: { ok: true, task: { state: "canceled" } },
      });
      await endpoint.flushAudit();
      expect(
        (await fixture.store.probe(
          "inspectProductAudit",
        )) as ProductAuditSnapshot,
      ).toMatchObject({
        records: [{ resultCode: "ok" }],
      });
      const snapshot = (await fixture.store.probe(
        "inspectProductAudit",
      )) as ProductAuditSnapshot;
      expect(snapshot.overwrittenCount).toBeGreaterThan(0);
    } finally {
      await client.close();
      await endpoint.close();
      await fixture.close();
    }
  });

  it("records a sanitized outcome when the MCP handler rejects", async () => {
    const fixture = await createDurableAdmissionFixture();
    const handler = createDurableAdmissionMcpHandler(fixture.service);
    const endpoint = await startLoopbackDurableAdmissionServer({
      registry: fixture.registry,
      auditRecorder: fixture.store,
      handler: {
        ...handler,
        fetch: () =>
          Promise.reject(new Error("AUDIT-HANDLER-PRIVATE-ERROR-SENTINEL")),
      },
    });
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SCOPE_A_TOKEN}`,
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
          },
        }),
      });
      expect(response.status).toBe(500);
      await endpoint.flushAudit();
      const snapshot = (await fixture.store.probe(
        "inspectProductAudit",
      )) as ProductAuditSnapshot;
      expect(snapshot.records).toEqual([
        expect.objectContaining({
          principalId: "principal-a",
          method: "tools/list",
          resultCode: "internal_error",
        }),
      ]);
      expect(JSON.stringify(snapshot)).not.toContain("AUDIT-HANDLER");
    } finally {
      await endpoint.close();
      await handler.close();
      await fixture.close();
    }
  });
});
