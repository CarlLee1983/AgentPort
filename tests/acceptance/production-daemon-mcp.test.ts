import { describe, expect, it } from "vitest";

import { MCP_PROTOCOL_VERSION } from "../../src/mcp/protocol.js";
import {
  createDurableAdmissionFixture,
  SCOPE_A_TOKEN,
} from "../fixtures/durable-admission.js";
import {
  connectDurableAdmissionClient,
  startDurableAdmissionMcpEndpoint,
} from "../fixtures/durable-admission-mcp.js";

describe("production daemon service skeleton", () => {
  it("lists zero Agents through test-only authorization and rejects production submission without credentials", async () => {
    const fixture = await createDurableAdmissionFixture();
    const endpoint = await startDurableAdmissionMcpEndpoint(fixture);
    try {
      await fixture.registry.replace({
        credentials: { [SCOPE_A_TOKEN]: "principal-a" },
        principals: [
          {
            principalId: "principal-a",
            accessScopeId: "scope-a",
            active: true,
            allowedAgentIds: [],
          },
        ],
        agents: [],
      });
      const client = await connectDurableAdmissionClient(
        endpoint.url,
        SCOPE_A_TOKEN,
      );
      try {
        const listed = await client.callTool({
          name: "agentport_list_agents",
          arguments: {},
        });
        expect(listed.structuredContent).toMatchObject({
          ok: true,
          agents: [],
        });
      } finally {
        await client.close();
      }

      // This is the production mapping installed by daemon/composition.ts.
      await fixture.registry.replace({
        credentials: {},
        principals: [],
        agents: [],
      });
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${SCOPE_A_TOKEN}`,
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "agentport_submit_task",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "production-submit-blocked",
          method: "tools/call",
          params: {
            name: "agentport_submit_task",
            arguments: {
              operationId: "must-not-persist",
              agentId: "missing",
              instruction: "must not reach service admission",
            },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            },
          },
        }),
      });
      expect(response.status).toBe(401);
      await expect(
        fixture.store.listTasks({
          accessScopeId: "scope-a",
          allowedAgentIds: [],
          limit: 10,
        }),
      ).resolves.toMatchObject({ tasks: [] });
    } finally {
      await endpoint.close();
      await fixture.close();
    }
  });
});
