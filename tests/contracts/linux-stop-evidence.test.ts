import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { VerifiedStopEvidence } from "../../src/core/execution-supervisor.js";
import type { ExecutionReference } from "../../src/core/types.js";
import {
  isVerifiedLinuxStopEvidence,
  LinuxExecutionSupervisor,
} from "../../src/supervisor/linux/execution-supervisor.js";
import { LinuxLauncherClient } from "../../src/supervisor/linux/launcher-client.js";
import {
  encodeLauncherFrame,
  executionUnitNames,
  parseLauncherRequest,
} from "../../src/supervisor/linux/launcher-protocol.js";
import { sessionReferenceFor } from "../../src/runtime/claude/session-reference.js";

const reference: ExecutionReference = {
  executionId: "execution-evidence-1",
  generation: "generation-1",
  daemonEpoch: "epoch-1",
  launchProfileId: "profile-1",
  workspaceIdentity: "workspace-1",
};
const PROTECTED_SOCKET_TEST =
  process.platform === "linux" && process.getuid?.() === 0;

describe("Linux Stop Evidence authority", () => {
  it("accepts a Reference-bound protected continuation only on start", () => {
    const protectedSessionToken = "claude-session-01J8D7K2WQ6YB8P4M3N5R7T9VX";
    const sourceReference = {
      ...reference,
      executionId: "execution-prior-session",
      generation: "generation-prior-session",
    };
    const continuation = {
      kind: "resume" as const,
      sourceReference,
      protectedSessionToken,
      sessionReference: sessionReferenceFor(
        sourceReference,
        protectedSessionToken,
      ),
    };
    expect(
      parseLauncherRequest(
        JSON.stringify({
          requestId: "protected-continuation-1",
          action: "start",
          reference,
          continuation,
        }),
      ),
    ).toMatchObject({ action: "start", reference, continuation });
    expect(
      parseLauncherRequest(
        JSON.stringify({
          requestId: "protected-continuation-2",
          action: "reconcile",
          reference,
          continuation,
        }),
      ),
    ).toBeUndefined();
    expect(
      parseLauncherRequest(
        JSON.stringify({
          requestId: "protected-continuation-3",
          action: "start",
          reference,
          continuation: {
            ...continuation,
            sessionReference: "g1s-invalid",
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("fails closed when no protected launcher socket exists", async () => {
    const supervisor = new LinuxExecutionSupervisor(
      new LinuxLauncherClient({
        socketPath: join(tmpdir(), `missing-launcher-${randomUUID()}.sock`),
      }),
    );
    await expect(supervisor.revokeAndStop(reference)).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it.skipIf(!PROTECTED_SOCKET_TEST)(
    "authenticates evidence received through the protected launcher channel",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "agentport-evidence-"));
      const socketPath = join(directory, "launcher.sock");
      const server = createServer((socket) => {
        socket.setEncoding("utf8");
        socket.once("data", (encoded: string) => {
          const request = parseLauncherRequest(encoded.trimEnd());
          if (request === undefined) return socket.destroy();
          socket.end(
            encodeLauncherFrame({
              requestId: request.requestId,
              result: {
                kind: "stopped",
                evidence: {
                  platform: "linux-cgroup-v2",
                  reference,
                  executionUnitId: executionUnitNames(reference.executionId)
                    .executionUnitId,
                  generationSealedAt: "2026-09-13T00:00:00.000Z",
                  unitEmptyObservedAt: "2026-09-13T00:00:01.000Z",
                },
              },
            }),
          );
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o660);
      try {
        const supervisor = new LinuxExecutionSupervisor(
          new LinuxLauncherClient({ socketPath }),
        );
        const result = await supervisor.revokeAndStop(reference);
        expect(result.kind).toBe("stopped");
        if (result.kind !== "stopped") throw new Error("Expected stopped");
        expect(isVerifiedLinuxStopEvidence(result.evidence)).toBe(true);
        expect(result.evidence).toMatchObject({
          reference,
          executionUnitId: executionUnitNames(reference.executionId)
            .executionUnitId,
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!PROTECTED_SOCKET_TEST).each([
    {
      name: "another generation",
      evidenceReference: { ...reference, generation: "generation-other" },
      executionUnitId: executionUnitNames(reference.executionId)
        .executionUnitId,
      generationSealedAt: "2026-09-13T00:00:00.000Z",
      unitEmptyObservedAt: "2026-09-13T00:00:01.000Z",
    },
    {
      name: "another execution unit",
      evidenceReference: reference,
      executionUnitId: "agentport-execution-wrong.slice",
      generationSealedAt: "2026-09-13T00:00:00.000Z",
      unitEmptyObservedAt: "2026-09-13T00:00:01.000Z",
    },
    {
      name: "empty observation before generation seal",
      evidenceReference: reference,
      executionUnitId: executionUnitNames(reference.executionId)
        .executionUnitId,
      generationSealedAt: "2026-09-13T00:00:02.000Z",
      unitEmptyObservedAt: "2026-09-13T00:00:01.000Z",
    },
  ])("rejects stopped evidence bound to $name", async (fixture) => {
    const directory = await mkdtemp(join(tmpdir(), "agentport-evidence-"));
    const socketPath = join(directory, "launcher.sock");
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (encoded: string) => {
        const request = parseLauncherRequest(encoded.trimEnd());
        if (request === undefined) return socket.destroy();
        socket.end(
          encodeLauncherFrame({
            requestId: request.requestId,
            result: {
              kind: "stopped",
              evidence: {
                platform: "linux-cgroup-v2",
                reference: fixture.evidenceReference,
                executionUnitId: fixture.executionUnitId,
                generationSealedAt: fixture.generationSealedAt,
                unitEmptyObservedAt: fixture.unitEmptyObservedAt,
              },
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o660);
    try {
      const supervisor = new LinuxExecutionSupervisor(
        new LinuxLauncherClient({ socketPath }),
      );
      await expect(supervisor.revokeAndStop(reference)).resolves.toEqual({
        kind: "indeterminate",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects PID, process-group, scripted and structural counterexamples", () => {
    const forgeries: VerifiedStopEvidence[] = [
      {
        kind: "verified",
        platform: "linux-cgroup-v2",
        reference,
        executionUnitId: String(process.pid),
        generationSealedAt: new Date().toISOString(),
        unitEmptyObservedAt: new Date().toISOString(),
      },
      {
        kind: "verified",
        platform: "linux-cgroup-v2",
        reference,
        executionUnitId: `process-group-${randomUUID()}`,
        generationSealedAt: new Date().toISOString(),
        unitEmptyObservedAt: new Date().toISOString(),
      },
    ];
    for (const forgery of forgeries) {
      expect(isVerifiedLinuxStopEvidence(forgery)).toBe(false);
    }
  });
});
