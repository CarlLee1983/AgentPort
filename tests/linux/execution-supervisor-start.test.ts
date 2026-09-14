import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  descendantPids,
  executionCgroupPath,
  LINUX_G1_ENABLED,
  linuxReference,
  linuxSupervisor,
  requiredEnvironment,
} from "../fixtures/linux-supervisor.js";

describe.skipIf(!LINUX_G1_ENABLED)("Linux Execution Supervisor start", () => {
  it("persists one generation and idempotently releases one cgroup v2 unit", async () => {
    const supervisor = linuxSupervisor();
    const reference = await linuxReference("g1-idle");
    try {
      const results = await Promise.all([
        supervisor.start(reference),
        supervisor.start(reference),
      ]);
      expect(results[0]).toMatchObject({ kind: "started" });
      expect(results[1]).toEqual(results[0]);
      if (results[0].kind !== "started") throw new Error("Expected start");

      const cgroupPath = await executionCgroupPath(results[0].executionUnitId);
      const pids = await descendantPids(cgroupPath);
      expect(pids.length).toBeGreaterThan(0);
      const expectedUid = requiredEnvironment("AGENTPORT_G1_RUNTIME_UID");
      const expectedGid = requiredEnvironment("AGENTPORT_G1_RUNTIME_GID");
      for (const pid of pids) {
        const status = await readFile(`/proc/${String(pid)}/status`, "utf8");
        expect(status).toMatch(
          new RegExp(`^Uid:\\s+${expectedUid}\\s+${expectedUid}\\s+`, "mu"),
        );
        expect(status).toMatch(
          new RegExp(`^Gid:\\s+${expectedGid}\\s+${expectedGid}\\s+`, "mu"),
        );
        expect(status).toMatch(
          new RegExp(`^Groups:\\s+${expectedGid}\\s*$`, "mu"),
        );
      }
      expect((await readFile(`${cgroupPath}/memory.max`, "utf8")).trim()).toBe(
        "536870912",
      );
      expect((await readFile(`${cgroupPath}/pids.max`, "utf8")).trim()).toBe(
        "64",
      );
    } finally {
      await supervisor.revokeAndStop(reference);
    }
  }, 20_000);
});
