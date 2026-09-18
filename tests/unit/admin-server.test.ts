import { createConnection } from "node:net";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { startAdminReadinessServer } from "../../src/daemon/admin-server.js";

const readiness = () => ({
  level: "service-ready" as const,
  reason: "caller-provisioning-absent" as const,
  observedAt: "2026-09-18T12:34:56.789Z",
  capabilities: {
    service: "available" as const,
    agents: "configured" as const,
    launcher: "ready" as const,
    runtime: "verified" as const,
    callerProvisioning: "absent" as const,
    protectedTopology: "valid" as const,
  },
});

async function request(path: string, frame: string): Promise<string> {
  const socket = createConnection(path);
  let output = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => (output += chunk));
  await once(socket, "connect");
  socket.end(frame);
  await once(socket, "close");
  return output;
}

describe("administrator readiness socket", () => {
  it("serves exactly the versioned read-only readiness request with protected mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentport-admin-"));
    const socketPath = join(directory, "admin.sock");
    const server = await startAdminReadinessServer({
      socketPath,
      groupId: process.getgid?.() ?? 0,
      readiness,
    });
    try {
      expect(
        JSON.parse(
          await request(socketPath, '{"version":1,"method":"get_readiness"}\n'),
        ),
      ).toEqual({
        version: 1,
        ok: true,
        readiness: readiness(),
      });
      expect((await stat(socketPath)).mode & 0o777).toBe(0o660);
      expect(
        await request(socketPath, '{"version":1,"method":"mutate"}\n'),
      ).toEqual('{"version":1,"ok":false,"code":"admin_request_invalid"}\n');
      expect(
        await request(
          socketPath,
          '{"version":1,"method":"get_readiness"}\n{"version":1,"method":"get_readiness"}\n',
        ),
      ).toEqual('{"version":1,"ok":false,"code":"admin_request_invalid"}\n');
    } finally {
      await server.close();
    }
  });
});
