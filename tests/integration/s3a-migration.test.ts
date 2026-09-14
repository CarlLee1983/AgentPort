import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  executionControlMigration,
  initialMigration,
} from "../../src/storage/migration.js";
import { SqliteDurableAdmissionStore } from "../../src/storage/sqlite-durable-admission-store.js";
import { reopenWithAp002Store } from "../fixtures/ap002-store.js";
import { reopenWithAp003Store } from "../fixtures/ap003-store.js";
import { createDurableAdmissionFixture } from "../fixtures/durable-admission.js";

async function createSchemaV2Database(): Promise<{
  directory: string;
  databasePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "agentport-s3a-v2-"));
  const databasePath = join(directory, "agentport.sqlite");
  const database = new Database(databasePath);
  const stamp = "2026-09-13T00:00:00.000Z";
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.exec(initialMigration);
    database
      .prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)")
      .run(stamp);
    database.exec(executionControlMigration);
    database
      .prepare("INSERT INTO schema_migrations(version,applied_at) VALUES(2,?)")
      .run(stamp);

    for (const [suffix, state, claim] of [
      ["prepared", "prepared", "held"],
      ["recovering", "recovering", "quarantined"],
    ] as const) {
      const bindingId = `binding-${suffix}`;
      const contextId = `context-${suffix}`;
      const taskId = `task-${suffix}`;
      const executionId = `execution-${suffix}`;
      const workspaceId = `workspace-${suffix}`;
      database
        .prepare(
          "INSERT INTO binding_snapshots(binding_snapshot_id,scope,agent_id,workspace_id,payload_json,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(bindingId, "scope-a", "agent-a", workspaceId, "{}", stamp);
      database
        .prepare(
          "INSERT INTO contexts(context_id,scope,agent_id,binding_snapshot_id,revision,created_at) VALUES(?,?,?,?,1,?)",
        )
        .run(contextId, "scope-a", "agent-a", bindingId, stamp);
      database
        .prepare(
          "INSERT INTO tasks(task_id,context_id,scope,agent_id,created_by,state,revision,queue_order,instruction,created_at,updated_at) VALUES(?,?,?,?,?,'paused',1,?,?,?,?)",
        )
        .run(
          taskId,
          contextId,
          "scope-a",
          "agent-a",
          "principal-a",
          suffix === "prepared" ? 1 : 2,
          `retain ${suffix}`,
          stamp,
          stamp,
        );
      database
        .prepare(
          "INSERT INTO task_reservations(task_id,control_receipts,control_events,control_bytes) VALUES(?,1,1,65536)",
        )
        .run(taskId);
      database
        .prepare(
          "INSERT INTO executions(execution_id,task_id,binding_snapshot_id,generation,daemon_epoch,launch_profile_id,workspace_id,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)",
        )
        .run(
          executionId,
          taskId,
          bindingId,
          `generation-${suffix}`,
          "epoch-v2",
          "driver@v2",
          workspaceId,
          state,
          stamp,
          stamp,
        );
      database
        .prepare(
          "INSERT INTO workspace_claims(workspace_id,execution_id,status,created_at,updated_at) VALUES(?,?,?,?,?)",
        )
        .run(workspaceId, executionId, claim, stamp, stamp);
    }
    database
      .prepare(
        "INSERT INTO product_audit_records(principal_id,method,result_code,created_at) VALUES(?,?,?,?)",
      )
      .run("principal-a", "fixture.evidence", "retained", stamp);
  } finally {
    database.close();
  }
  return { directory, databasePath };
}

describe("durable schema migration", () => {
  it("opens the durable store at additive schema version 11", async () => {
    const fixture = await createDurableAdmissionFixture();
    try {
      await expect(
        fixture.store.probe("inspectSchemaVersions"),
      ).resolves.toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    } finally {
      await fixture.close();
    }
  });

  it("preserves v2 executions, claims, and evidence while legacy binaries reject v3", async () => {
    const seeded = await createSchemaV2Database();
    let store: SqliteDurableAdmissionStore | undefined;
    try {
      store = await SqliteDurableAdmissionStore.open({
        databasePath: seeded.databasePath,
      });
      await expect(store.probe("inspectSchemaVersions")).resolves.toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      await expect(
        store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: "task-prepared",
        }),
      ).resolves.toMatchObject({
        executionId: "execution-prepared",
        state: "prepared",
        workspaceClaim: "held",
      });
      await expect(
        store.getExecution({
          accessScopeId: "scope-a",
          allowedAgentIds: ["agent-a"],
          taskId: "task-recovering",
        }),
      ).resolves.toMatchObject({
        executionId: "execution-recovering",
        state: "recovering",
        workspaceClaim: "quarantined",
      });
      await store.close();
      store = undefined;

      expect(() => {
        reopenWithAp002Store({
          databasePath: seeded.databasePath,
          taskId: "task-prepared",
        });
      }).toThrow("unsupported AP-002 durable admission schema version");
      expect(() => {
        reopenWithAp003Store(seeded.databasePath);
      }).toThrow("unsupported AP-003 durable admission schema version");

      const inspected = new Database(seeded.databasePath, {
        fileMustExist: true,
      });
      try {
        const executionColumns = new Set(
          (
            inspected.pragma("table_info(executions)") as { name: string }[]
          ).map(({ name }) => name),
        );
        expect([...executionColumns]).toEqual(
          expect.arrayContaining([
            "candidate_ordinal",
            "last_observation_ordinal",
            "observation_bytes",
            "recovery_reason",
            "recovery_started_at",
            "stop_reason",
            "stop_reason_committed_at",
          ]),
        );
        const observationColumns = new Set(
          (
            inspected.pragma("table_info(execution_observations)") as {
              name: string;
            }[]
          ).map(({ name }) => name),
        );
        expect(observationColumns.has("payload_bytes")).toBe(true);
        expect(
          inspected
            .prepare("SELECT COUNT(*) AS count FROM product_audit_records")
            .get(),
        ).toEqual({ count: 1 });
        expect(
          inspected
            .prepare("SELECT COUNT(*) AS count FROM execution_observations")
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        inspected.close();
      }
    } finally {
      await store?.close();
      await rm(seeded.directory, { force: true, recursive: true });
    }
  });
});
