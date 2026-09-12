import { afterEach, describe, expect, it } from "vitest";

import {
  SCOPE_A_TOKEN,
  createDurableAdmissionFixture,
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

describe("execution lifecycle authorization", () => {
  it("rejects every caller-supplied Execution Reference field", async () => {
    const fixture = track(await createDurableAdmissionFixture());
    const endpoint = track(await startDurableAdmissionMcpEndpoint(fixture));
    const client = track(
      await connectDurableAdmissionClient(endpoint.url, SCOPE_A_TOKEN),
    );
    await client.listTools();
    const overrides: Array<Record<string, unknown>> = [
      { executionId: "caller-selected-execution" },
      { generation: "caller-selected-generation" },
      { launchProfile: "caller-selected-profile" },
      { workspaceIdentity: "caller-selected-workspace" },
      { stopEvidence: "synthetic-stop-evidence" },
    ];

    for (const override of overrides) {
      const result = await client.callTool({
        name: "agentport_get_execution_lifecycle",
        arguments: { taskId: "unknown-task", ...override },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "validation_error" },
      });
      expect(JSON.stringify(result)).not.toContain(
        String(Object.values(override)[0]),
      );
    }
  });
});
