import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { ExecutionReference } from "../../src/core/types.js";
import {
  isVerifiedLinuxStopEvidence,
  LinuxExecutionSupervisor,
} from "../../src/supervisor/linux/execution-supervisor.js";
import { LinuxLauncherClient } from "../../src/supervisor/linux/launcher-client.js";
import { executionUnitNames } from "../../src/supervisor/linux/launcher-protocol.js";
import {
  RuntimeWorkerObservationSequence,
  type RuntimeWorkerObservation,
} from "../../src/runtime/worker/protocol.js";
import {
  descendantPids,
  executionCgroupPath,
  linuxReference,
  linuxSupervisor,
} from "../fixtures/linux-supervisor.js";

const executeFile = promisify(execFile);
const CLAUDE_G1_ENABLED =
  process.platform === "linux" &&
  process.env["AGENTPORT_G1_LINUX"] === "1" &&
  process.env["AGENTPORT_G1_CLAUDE"] === "1";

async function observationsFor(
  reference: ExecutionReference,
): Promise<RuntimeWorkerObservation[]> {
  const serviceUnit = executionUnitNames(reference.executionId).serviceUnit;
  const result = await executeFile(
    "journalctl",
    ["--unit", serviceUnit, "--output=cat", "--no-pager", "--quiet"],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 },
  );
  const sequence = new RuntimeWorkerObservationSequence();
  const observations: RuntimeWorkerObservation[] = [];
  for (const frame of result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"kind"'))) {
    const observation = sequence.accept(reference, frame);
    if (observation === undefined) {
      throw new Error("Runtime worker emitted an invalid observation sequence");
    }
    observations.push(observation);
  }
  return observations;
}

async function waitForObservation(
  reference: ExecutionReference,
  predicate: (observation: RuntimeWorkerObservation) => boolean,
): Promise<RuntimeWorkerObservation[]> {
  const deadline = Date.now() + 120_000;
  while (Date.now() <= deadline) {
    const observations = await observationsFor(reference);
    if (observations.some(predicate)) return observations;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the Runtime observation");
}

async function waitForActiveClaudeChild(
  reference: ExecutionReference,
  executionUnitId: string,
): Promise<void> {
  const cgroupPath = await executionCgroupPath(executionUnitId);
  const deadline = Date.now() + 120_000;
  while (Date.now() <= deadline) {
    const [pids, observations] = await Promise.all([
      descendantPids(cgroupPath),
      observationsFor(reference),
    ]);
    if (observations.some((observation) => observation.kind === "candidate")) {
      throw new Error("Claude completed before Supervisor cancellation");
    }
    if (pids.length >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for an active Claude child process");
}

async function revokeAndAssertStop(
  reference: ExecutionReference,
): Promise<void> {
  const stopped = await linuxSupervisor().revokeAndStop(reference);
  expect(stopped.kind).toBe("stopped");
  if (stopped.kind !== "stopped") {
    throw new Error("Supervisor cancellation did not return Stop Evidence");
  }
  expect(isVerifiedLinuxStopEvidence(stopped.evidence)).toBe(true);
  expect(stopped.evidence).toMatchObject({
    reference,
    executionUnitId: executionUnitNames(reference.executionId).executionUnitId,
  });
  expect(
    Date.parse(stopped.evidence.unitEmptyObservedAt),
  ).toBeGreaterThanOrEqual(Date.parse(stopped.evidence.generationSealedAt));
}

describe.skipIf(!CLAUDE_G1_ENABLED)(
  "Claude Runtime cancellation through the Linux Supervisor",
  () => {
    it("cancels an active Claude child only through revoke-and-stop", async () => {
      const reference = await linuxReference("g1-claude-cancel-active");
      const supervisor = linuxSupervisor();
      const started = await supervisor.start(reference);
      expect(started.kind).toBe("started");
      if (started.kind !== "started")
        throw new Error("Claude worker did not start");
      try {
        await waitForObservation(
          reference,
          (observation) =>
            observation.kind === "progress" &&
            observation.summary === "claude-worker-ready",
        );
        await waitForActiveClaudeChild(reference, started.executionUnitId);
        await revokeAndAssertStop(reference);
        expect(await observationsFor(reference)).not.toContainEqual(
          expect.objectContaining({ kind: "candidate" }),
        );
      } finally {
        await supervisor.revokeAndStop(reference);
      }
    }, 150_000);

    it("cancels a verified pure native-question wait only through revoke-and-stop", async () => {
      const reference = await linuxReference("g1-claude-cancel-question");
      const supervisor = linuxSupervisor();
      const started = await supervisor.start(reference);
      expect(started.kind).toBe("started");
      if (started.kind !== "started")
        throw new Error("Claude worker did not start");
      try {
        const observations = await waitForObservation(
          reference,
          (observation) => observation.kind === "question",
        );
        expect(observations.map((observation) => observation.kind)).toEqual([
          "progress",
          "question",
        ]);
        expect(observations[1]).toMatchObject({ toolActivity: "none" });
        await revokeAndAssertStop(reference);
        expect(await observationsFor(reference)).not.toContainEqual(
          expect.objectContaining({ kind: "candidate" }),
        );
      } finally {
        await supervisor.revokeAndStop(reference);
      }
    }, 150_000);

    it("keeps a pure native-question wait nonterminal when Supervisor control is unavailable", async () => {
      const reference = await linuxReference("g1-claude-cancel-question");
      const supervisor = linuxSupervisor();
      const started = await supervisor.start(reference);
      expect(started.kind).toBe("started");
      if (started.kind !== "started")
        throw new Error("Claude worker did not start");
      try {
        await waitForObservation(
          reference,
          (observation) => observation.kind === "question",
        );
        const unavailableSupervisor = new LinuxExecutionSupervisor(
          new LinuxLauncherClient({
            socketPath: "/run/agentport-g1/nonexistent-launcher.sock",
          }),
        );
        await expect(
          unavailableSupervisor.revokeAndStop(reference),
        ).resolves.toEqual({ kind: "unavailable" });
        expect(await observationsFor(reference)).not.toContainEqual(
          expect.objectContaining({ kind: "candidate" }),
        );
      } finally {
        await supervisor.revokeAndStop(reference);
      }
    }, 150_000);
  },
);
