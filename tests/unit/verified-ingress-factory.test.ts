import { describe, expect, it, vi } from "vitest";

import { verifyBeforeEachIngressOpen } from "../../src/bootstrap/verified-ingress-factory.js";
import type { RuntimeIngressFactory } from "../../src/dispatcher/controlled-runtime-dispatcher.js";

const input = {
  taskId: "task-1",
  reference: {
    executionId: "execution-1",
    generation: "generation-1",
    daemonEpoch: "epoch-1",
    launchProfileId: "g1-idle",
    workspaceIdentity: "g1-workspace",
  },
  lifecycle: {} as Parameters<RuntimeIngressFactory["open"]>[0]["lifecycle"],
};

describe("verifyBeforeEachIngressOpen (AP-021 R3)", () => {
  it("verifies the ingress directory before every open", async () => {
    const calls: string[] = [];
    const factory = verifyBeforeEachIngressOpen(
      {
        open: () => {
          calls.push("open");
          return Promise.resolve({
            session: { endpoint: "/run/agentport/ingress/a.sock", token: "t" },
            close: () => Promise.resolve(),
          });
        },
      },
      () => {
        calls.push("verify");
        return Promise.resolve();
      },
    );
    await factory.open(input);
    await factory.open(input);
    expect(calls).toEqual(["verify", "open", "verify", "open"]);
  });

  it("does not open an ingress socket when verification fails", async () => {
    const open = vi.fn();
    const failure = new Error(
      "Worker ingress directory is not protected for the Runtime identity",
    );
    const factory = verifyBeforeEachIngressOpen({ open }, () =>
      Promise.reject(failure),
    );
    await expect(factory.open(input)).rejects.toBe(failure);
    expect(open).not.toHaveBeenCalled();
  });
});
