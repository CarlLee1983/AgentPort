import { describe, expect, it } from "vitest";

import { probeRuntimeAccessAsUser } from "../../src/operations/linux-preflight.js";
import { LINUX_G1_ENABLED } from "../fixtures/linux-supervisor.js";

describe.skipIf(!LINUX_G1_ENABLED)(
  "Linux operations effective-access probe",
  () => {
    it("distinguishes denied access from a runuser launch failure", async () => {
      expect(
        await probeRuntimeAccessAsUser("/", "agentport-runtime", "traverse"),
      ).toBe(true);
      expect(
        await probeRuntimeAccessAsUser("/", "agentport-runtime", "write"),
      ).toBe(false);
      await expect(
        probeRuntimeAccessAsUser(
          "/",
          "agentport-nonexistent-probe-user",
          "write",
        ),
      ).rejects.toThrow();
    });
  },
);
