import { describe, expect, it } from "vitest";

import type { ExecutionReference } from "../../src/core/types.js";
import { parseLinuxLedgerRecord } from "../../src/supervisor/linux/launcher-server.js";
import {
  executionUnitNames,
  parseLauncherRequest,
  parseLauncherResponse,
} from "../../src/supervisor/linux/launcher-protocol.js";

const reference: ExecutionReference = {
  executionId: "execution-ledger-validation",
  generation: "generation-1",
  daemonEpoch: "epoch-1",
  launchProfileId: "g1-idle",
  workspaceIdentity: "g1-workspace",
};
const units = executionUnitNames(reference.executionId);
const authorized = {
  version: 1,
  reference,
  ...units,
  state: "authorized",
  releasedAt: null,
  generationSealedAt: null,
  unitEmptyObservedAt: null,
};

describe("Linux Supervisor ledger validation", () => {
  it("accepts only the exact supported record schema and derived unit names", () => {
    expect(parseLinuxLedgerRecord(authorized, reference.executionId)).toEqual(
      authorized,
    );
    expect(
      parseLinuxLedgerRecord(
        {
          ...authorized,
          state: "sealed",
          generationSealedAt: "2026-09-13T00:00:00.000Z",
          unitEmptyObservedAt: "2026-09-13T00:00:01.000Z",
        },
        reference.executionId,
      ),
    ).toMatchObject({ state: "sealed" });
  });

  it.each([
    ["unknown schema version", { ...authorized, version: 2 }],
    ["foreign Execution ID", authorized, "execution-other"],
    ["caller-selected slice", { ...authorized, executionUnitId: "x.slice" }],
    ["caller-selected service", { ...authorized, serviceUnit: "x.service" }],
    ["unknown state", { ...authorized, state: "running" }],
    [
      "authorized record with a seal timestamp",
      {
        ...authorized,
        generationSealedAt: "2026-09-13T00:00:00.000Z",
      },
    ],
    [
      "sealed record without a seal timestamp",
      { ...authorized, state: "sealed" },
    ],
    [
      "empty observation before generation seal",
      {
        ...authorized,
        state: "sealed",
        generationSealedAt: "2026-09-13T00:00:02.000Z",
        unitEmptyObservedAt: "2026-09-13T00:00:01.000Z",
      },
    ],
  ])("rejects %s", (_name, value, executionId = reference.executionId) => {
    expect(parseLinuxLedgerRecord(value, executionId)).toBeUndefined();
  });
});

describe("launcher-private dispatch authority protocol", () => {
  it("accepts a Reference-free authority request and a bounded epoch response", () => {
    expect(
      parseLauncherRequest(
        JSON.stringify({
          requestId: "request-1",
          action: "dispatch_authority",
        }),
      ),
    ).toEqual({ requestId: "request-1", action: "dispatch_authority" });
    expect(
      parseLauncherResponse(
        JSON.stringify({
          requestId: "request-1",
          result: {
            kind: "dispatch_authority",
            daemonEpoch: "epoch-launcher-tenure-1",
          },
        }),
        "request-1",
      ),
    ).toEqual({
      requestId: "request-1",
      result: {
        kind: "dispatch_authority",
        daemonEpoch: "epoch-launcher-tenure-1",
      },
    });
  });

  it("rejects a caller-supplied Reference on the authority handshake", () => {
    expect(
      parseLauncherRequest(
        JSON.stringify({
          requestId: "request-1",
          action: "dispatch_authority",
          reference,
        }),
      ),
    ).toBeUndefined();
  });
});
