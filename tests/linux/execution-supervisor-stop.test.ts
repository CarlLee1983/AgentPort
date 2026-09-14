import { describe, expect, it } from "vitest";

import { isVerifiedLinuxStopEvidence } from "../../src/supervisor/linux/execution-supervisor.js";
import {
  LINUX_G1_ENABLED,
  linuxReference,
  linuxSupervisor,
} from "../fixtures/linux-supervisor.js";

describe.skipIf(!LINUX_G1_ENABLED)("Linux Execution Supervisor stop", () => {
  it("permanently seals a generation canceled before start", async () => {
    const supervisor = linuxSupervisor();
    const reference = await linuxReference("g1-idle");
    const first = await supervisor.revokeAndStop(reference);
    const repeated = await supervisor.revokeAndStop(reference);

    expect(first.kind).toBe("stopped");
    expect(repeated.kind).toBe("stopped");
    if (first.kind !== "stopped" || repeated.kind !== "stopped") {
      throw new Error("Expected repeatable Stop Evidence");
    }
    expect(repeated.evidence.generationSealedAt).toBe(
      first.evidence.generationSealedAt,
    );
    await expect(supervisor.start(reference)).resolves.toEqual({
      kind: "pending",
    });
  }, 20_000);

  it("seals before a delayed start reaches its release point", async () => {
    const supervisor = linuxSupervisor();
    const reference = await linuxReference("g1-delayed");
    const starting = supervisor.start(reference);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const stopped = await supervisor.revokeAndStop(reference);

    expect(stopped.kind).toBe("stopped");
    if (stopped.kind !== "stopped") throw new Error("Expected stop evidence");
    expect(isVerifiedLinuxStopEvidence(stopped.evidence)).toBe(true);
    await expect(starting).resolves.toEqual({ kind: "pending" });
    await expect(supervisor.start(reference)).resolves.toEqual({
      kind: "pending",
    });
  }, 20_000);

  it.each(["g1-idle", "g1-blocked", "g1-descendants"])(
    "empties the %s cgroup before returning evidence",
    async (profile) => {
      const supervisor = linuxSupervisor();
      const reference = await linuxReference(profile);
      const started = await supervisor.start(reference);
      expect(started.kind).toBe("started");
      const stopped = await supervisor.revokeAndStop(reference);
      expect(stopped.kind).toBe("stopped");
      if (stopped.kind !== "stopped") throw new Error("Expected stop evidence");
      expect(isVerifiedLinuxStopEvidence(stopped.evidence)).toBe(true);
      expect(
        Date.parse(stopped.evidence.unitEmptyObservedAt),
      ).toBeGreaterThanOrEqual(Date.parse(stopped.evidence.generationSealedAt));
      await expect(supervisor.start(reference)).resolves.toEqual({
        kind: "pending",
      });
    },
    20_000,
  );
});
