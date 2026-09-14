import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { ExecutionReference } from "../../src/core/types.js";
import {
  RuntimeWorkerObservationSequence,
  type RuntimeWorkerObservation,
} from "../../src/runtime/worker/protocol.js";
import { executionUnitNames } from "../../src/supervisor/linux/launcher-protocol.js";
import {
  descendantPids,
  executionCgroupPath,
  linuxReference,
  linuxSupervisor,
  requiredEnvironment,
} from "../fixtures/linux-supervisor.js";

const executeFile = promisify(execFile);
const CLAUDE_G1_ENABLED =
  process.platform === "linux" &&
  process.env["AGENTPORT_G1_LINUX"] === "1" &&
  process.env["AGENTPORT_G1_CLAUDE"] === "1";

async function journalFrames(reference: ExecutionReference): Promise<string[]> {
  const serviceUnit = executionUnitNames(reference.executionId).serviceUnit;
  const result = await executeFile(
    "journalctl",
    ["--unit", serviceUnit, "--output=cat", "--no-pager", "--quiet"],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024 },
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"kind"'));
}

async function waitForCandidate(
  reference: ExecutionReference,
): Promise<RuntimeWorkerObservation[]> {
  const deadline = Date.now() + 120_000;
  while (Date.now() <= deadline) {
    const sequence = new RuntimeWorkerObservationSequence();
    const observations: RuntimeWorkerObservation[] = [];
    for (const frame of await journalFrames(reference)) {
      const observation = sequence.accept(reference, frame);
      if (observation === undefined) {
        throw new Error(
          "Runtime worker emitted an invalid observation sequence",
        );
      }
      observations.push(observation);
    }
    if (observations.some((value) => value.kind === "candidate")) {
      return observations;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the Runtime candidate");
}

async function expectRuntimeAccount(executionUnitId: string): Promise<void> {
  const expectedUid = requiredEnvironment("AGENTPORT_G1_RUNTIME_UID");
  const expectedGid = requiredEnvironment("AGENTPORT_G1_RUNTIME_GID");
  const cgroupPath = await executionCgroupPath(executionUnitId);
  const pids = await descendantPids(cgroupPath);
  expect(pids.length).toBeGreaterThan(0);
  for (const pid of pids) {
    const status = await readFile(`/proc/${String(pid)}/status`, "utf8");
    const environment = await readFile(`/proc/${String(pid)}/environ`, "utf8");
    expect(status).toMatch(
      new RegExp(`^Uid:\\s+${expectedUid}\\s+${expectedUid}\\s+`, "mu"),
    );
    expect(status).toMatch(
      new RegExp(`^Gid:\\s+${expectedGid}\\s+${expectedGid}\\s+`, "mu"),
    );
    expect(environment).not.toMatch(
      /(?:^|\0)(?:ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|NODE_OPTIONS|AGENTPORT_CORE_TOKEN)=/u,
    );
  }
}

async function runCapability(profile: string): Promise<{
  reference: ExecutionReference;
  observations: RuntimeWorkerObservation[];
}> {
  const reference = await linuxReference(profile);
  const supervisor = linuxSupervisor();
  const started = await supervisor.start(reference);
  expect(started.kind).toBe("started");
  if (started.kind !== "started")
    throw new Error("Claude worker did not start");
  try {
    const observations = await waitForCandidate(reference);
    await expectRuntimeAccount(started.executionUnitId);
    return { reference, observations };
  } finally {
    await expect(supervisor.revokeAndStop(reference)).resolves.toMatchObject({
      kind: "stopped",
    });
  }
}

describe.skipIf(!CLAUDE_G1_ENABLED)(
  "real Claude Runtime capabilities through the Linux Supervisor",
  () => {
    it("returns a bounded Reference-bound structured result inside its Execution Unit", async () => {
      const { reference, observations } = await runCapability(
        "g1-claude-structured",
      );
      expect(observations).toHaveLength(2);
      expect(observations[0]).toMatchObject({
        kind: "progress",
        reference,
        ordinal: 1,
      });
      expect(observations[1]).toMatchObject({
        kind: "candidate",
        reference,
        ordinal: 2,
        finalOrdinal: 2,
        outcome: "succeeded",
        summary: "AGENTPORT_G1_OK",
      });
      const candidate = observations[1];
      if (candidate?.kind !== "candidate") throw new Error("Missing candidate");
      if (candidate.sessionReference === null) {
        throw new Error("Missing Claude Session reference");
      }
      expect(candidate.sessionReference).toMatch(
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
      );
      expect(
        Buffer.byteLength(candidate.sessionReference, "utf8"),
      ).toBeLessThanOrEqual(512);
    }, 150_000);

    it("binds one native multi-question collection and its answer before continuing", async () => {
      const { reference, observations } =
        await runCapability("g1-claude-question");
      expect(observations).toHaveLength(3);
      expect(observations[1]).toMatchObject({
        kind: "question",
        reference,
        ordinal: 2,
      });
      expect(observations[2]).toMatchObject({
        kind: "candidate",
        reference,
        ordinal: 3,
        finalOrdinal: 3,
        outcome: "succeeded",
        summary: "AGENTPORT_G1_QUESTION_OK",
      });
      const question = observations[1];
      if (question?.kind !== "question") throw new Error("Missing question");
      expect(question.questionId.length).toBeGreaterThan(0);
      expect(question.toolUseId.length).toBeGreaterThan(0);
      expect(question.requestId.length).toBeGreaterThan(0);
      expect(question.questions).toHaveLength(2);
      for (const item of question.questions) {
        expect(item.header.length).toBeGreaterThan(0);
        expect(typeof item.multiSelect).toBe("boolean");
        expect(item.options.length).toBeGreaterThanOrEqual(2);
        for (const option of item.options) {
          expect(option.label.length).toBeGreaterThan(0);
          expect(option.description.length).toBeGreaterThan(0);
        }
      }
    }, 150_000);
  },
);
