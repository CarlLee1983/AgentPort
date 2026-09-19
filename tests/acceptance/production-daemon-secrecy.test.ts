import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { validateDaemonCredentials } from "../../src/daemon/credentials.js";
import { daemonMain } from "../../src/daemon/main.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";
import { startDurableAdmissionMcpEndpoint } from "../fixtures/durable-admission-mcp.js";

describe("production daemon secret sinks", () => {
  it("projects credential/startup failures without the raw sentinel", async () => {
    const cursorSecret = "ap022-cursor-secret-sentinel";
    const continuationEncryptionKey = randomBytes(32).toString("base64url");
    expect(
      validateDaemonCredentials(cursorSecret, continuationEncryptionKey),
    ).toEqual({ cursorSecret, continuationEncryptionKey });

    const output: string[] = [];
    const exitCode = await daemonMain(
      ["--config", "/etc/agentport/agentport.json"],
      {
        getUid: () => 995,
        readConfiguration: () =>
          Promise.reject(
            new Error(
              `${cursorSecret}:${continuationEncryptionKey}:/protected/path`,
            ),
          ),
        readCredentials: () =>
          Promise.resolve({ cursorSecret, continuationEncryptionKey }),
        createLifecycle: () => {
          throw new Error("unreachable lifecycle");
        },
        onSignal: () => undefined,
        offSignal: () => undefined,
        writeError: (line) => output.push(line),
      },
    );
    expect(exitCode).toBe(1);
    expect(output).toEqual([JSON.stringify({ code: "daemon_startup_failed" })]);
    expect(output.join()).not.toContain(cursorSecret);
    expect(output.join()).not.toContain(continuationEncryptionKey);
    expect(output.join()).not.toContain("/protected/path");
  });

  it("keeps an invalid bearer sentinel out of response, audit and SQLite", async () => {
    const bearerSentinel = "ap022-invalid-bearer-sentinel";
    const fixture = await createDurableAdmissionFixture();
    const endpoint = await startDurableAdmissionMcpEndpoint(fixture);
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearerSentinel}`,
          "content-type": "application/json",
          "mcp-method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "secret-sentinel",
          method: "tools/list",
          params: {},
        }),
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(bearerSentinel);
      await endpoint.flushAudit();
      expect(
        JSON.stringify(await fixture.store.probe("inspectProductAudit")),
      ).not.toContain(bearerSentinel);
      await fixture.store.close();
      const database = await readFile(fixture.databasePath);
      expect(database.includes(Buffer.from(bearerSentinel))).toBe(false);
    } finally {
      await endpoint.close().catch(() => undefined);
      await fixture.close();
    }
  });
});
