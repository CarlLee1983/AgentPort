import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startAdminReadinessServer } from "../../src/daemon/admin-server.js";

const secret = "credential-marker-/protected/launcher.sock";

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

describe("deployment readiness administrator boundary", () => {
  it("rejects malformed and oversized administrator bytes without disclosure", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agentport-admin-boundary-"),
    );
    const path = join(directory, "admin.sock");
    const server = await startAdminReadinessServer({
      socketPath: path,
      groupId: process.getgid?.() ?? 0,
      readiness: () => {
        throw new Error(secret);
      },
    });
    try {
      for (const frame of [
        "not-json\n",
        `${"x".repeat(4_097)}\n`,
        '{"version":1,"method":"get_readiness"}\nextra',
        '{"version":1,"method":"get_readiness"}\n',
      ]) {
        const output = await request(path, frame);
        expect(output).not.toContain(secret);
        expect(JSON.parse(output)).toMatchObject({ version: 1, ok: false });
      }
    } finally {
      await server.close();
    }
  });
});
