import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type ProductAuditSnapshot,
  SqliteDurableAdmissionStore,
} from "../../src/storage/sqlite-durable-admission-store.js";
import { openStore } from "../fixtures/durable-store.js";

function audit(resultCode: string) {
  return {
    principalId: "principal-a",
    method: "tools/call",
    toolName: "agentport_list_agents",
    protocolVersion: "2026-07-28",
    clientName: "audit-client",
    clientVersion: "1.0.0",
    clientCapabilitiesJson: "{}",
    resultCode,
    createdAt: "2026-09-12T08:00:00.000Z",
  };
}

describe("product audit retention", () => {
  it("persists a bounded ring and overwrite counter across restart", async () => {
    const fixture = await openStore({ auditCapacity: 2 });
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      await fixture.store.recordAudit(audit("first"));
      await fixture.store.recordAudit(audit("second"));
      await fixture.store.recordAudit(audit("third"));

      expect(
        (await fixture.store.probe(
          "inspectProductAudit",
        )) as ProductAuditSnapshot,
      ).toMatchObject({
        records: [{ resultCode: "second" }, { resultCode: "third" }],
        overwrittenCount: 1,
      });

      await fixture.store.close();
      reopened = await SqliteDurableAdmissionStore.open({
        databasePath: join(fixture.directory, "store.sqlite"),
        auditCapacity: 2,
      });
      await reopened.recordAudit(audit("fourth"));
      expect(
        (await reopened.probe("inspectProductAudit")) as ProductAuditSnapshot,
      ).toMatchObject({
        records: [{ resultCode: "third" }, { resultCode: "fourth" }],
        overwrittenCount: 2,
      });
    } finally {
      await reopened?.close();
      await fixture.dispose();
    }
  });

  it("atomically applies a smaller retention capacity on restart", async () => {
    const fixture = await openStore({ auditCapacity: 3 });
    let reopened: SqliteDurableAdmissionStore | undefined;
    try {
      await fixture.store.recordAudit(audit("first"));
      await fixture.store.recordAudit(audit("second"));
      await fixture.store.recordAudit(audit("third"));
      await fixture.store.close();

      reopened = await SqliteDurableAdmissionStore.open({
        databasePath: join(fixture.directory, "store.sqlite"),
        auditCapacity: 1,
      });
      await expect(
        reopened.probe("inspectProductAudit"),
      ).resolves.toMatchObject({
        records: [{ resultCode: "third" }],
        overwrittenCount: 2,
      });
    } finally {
      await reopened?.close();
      await fixture.dispose();
    }
  });
});
