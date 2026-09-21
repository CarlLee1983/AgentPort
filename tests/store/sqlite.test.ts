import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openTaskStore } from "../../src/store/sqlite.js";
import { cleanupTempDirs, makeTempDir } from "../config/helpers.js";

afterEach(cleanupTempDirs);

describe("openTaskStore", () => {
  it("同一毫秒內連續建立的 task_id / context_id 仍保持嚴格遞增（monotonic ulid）", async () => {
    const dir = await makeTempDir();
    const store = openTaskStore(join(dir, "agentport.sqlite"));
    try {
      const context = store.createContext("stationhub");
      const taskIds: string[] = [];
      for (let i = 0; i < 50; i += 1) {
        const task = store.createTask({
          context_id: context.context_id,
          agent: "stationhub",
          caller: "local",
          prompt: "p",
        });
        taskIds.push(task.task_id);
      }

      expect(taskIds).toEqual([...taskIds].sort());
      expect(new Set(taskIds).size).toBe(taskIds.length);
    } finally {
      store.close();
    }
  });

  it("db_path 所在的巢狀目錄不存在時會自動建立", async () => {
    const dir = await makeTempDir();
    const dbPath = join(
      dir,
      "nested",
      "does",
      "not",
      "exist",
      "agentport.sqlite",
    );

    const store = openTaskStore(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
      const context = store.createContext("stationhub");
      expect(store.getContext(context.context_id)).toEqual(context);
    } finally {
      store.close();
    }
  });
});
