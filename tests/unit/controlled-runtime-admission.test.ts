import { describe, expect, it } from "vitest";

import { createControlledRuntimeAdmission } from "../../src/bootstrap/create-controlled-runtime-admission.js";

describe("controlled Runtime composition", () => {
  it("fails before Runtime admission when the continuation key is absent", async () => {
    await expect(
      createControlledRuntimeAdmission({
        registry: { credentials: {}, principals: [], agents: [] },
        cursorSecret: "test-cursor-secret",
        storage: { databasePath: "/unreached/agentport.sqlite" },
        launcher: {
          socketPath: "/unreached/launcher.sock",
          workerIngressDirectory: "/unreached/ingress",
          runtimeGroupId: 1,
        },
      }),
    ).rejects.toThrow(
      "Controlled Runtime composition requires continuationEncryptionKey",
    );
  });
});
