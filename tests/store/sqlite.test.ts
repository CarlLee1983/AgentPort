import { existsSync, writeFileSync } from "node:fs";
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

  it("同一個 db_path 不能被兩個 store 同時開啟（single-instance 鎖），關掉第一個後可以再開", async () => {
    const dir = await makeTempDir();
    const dbPath = join(dir, "agentport.sqlite");
    const first = openTaskStore(dbPath);
    try {
      expect(() => openTaskStore(dbPath)).toThrow(
        `另一個 agentport 程序正在使用 ${dbPath}`,
      );
    } finally {
      first.close();
    }

    const second = openTaskStore(dbPath);
    second.close();
  });

  it("損毀的檔案（非 SQLite 內容）開啟失敗時，錯誤不是「另一個程序在用」那句鎖訊息", async () => {
    const dir = await makeTempDir();
    const dbPath = join(dir, "corrupt.sqlite");
    writeFileSync(dbPath, "not a sqlite file, just garbage bytes");

    expect(() => openTaskStore(dbPath)).not.toThrow(
      `另一個 agentport 程序正在使用 ${dbPath}`,
    );
    expect(() => openTaskStore(dbPath)).toThrow(/database/i);
  });

  it("interruptRunning 把所有 running Task 收斂成 failed{interrupted}，不動 final_text / raw_log_path，也不動其他狀態", async () => {
    const dir = await makeTempDir();
    const store = openTaskStore(join(dir, "agentport.sqlite"));
    try {
      const context = store.createContext("stationhub");
      const running = store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "running",
      });
      store.markRunning(running.task_id, "/tmp/running.jsonl");
      const queued = store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "queued",
      });
      const completed = store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "completed",
      });
      store.markCompleted(completed.task_id, {
        final_text: "done",
        usage: null,
      });

      const count = store.interruptRunning();
      expect(count).toBe(1);

      const runningNow = store.getTask(running.task_id);
      expect(runningNow?.state).toBe("failed");
      expect(runningNow?.finished_at).not.toBeNull();
      expect(runningNow?.error).toEqual({
        code: "interrupted",
        message: "service restarted while task was running",
      });
      expect(runningNow?.final_text).toBeNull();
      expect(runningNow?.raw_log_path).toBe("/tmp/running.jsonl");

      expect(store.getTask(queued.task_id)?.state).toBe("queued");
      expect(store.getTask(completed.task_id)?.state).toBe("completed");
    } finally {
      store.close();
    }
  });

  it("listQueuedTaskIds 依建立順序回傳所有 queued task_id，其餘狀態不含在內", async () => {
    const dir = await makeTempDir();
    const store = openTaskStore(join(dir, "agentport.sqlite"));
    try {
      const context = store.createContext("stationhub");
      const first = store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "first",
      });
      const running = store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "running",
      });
      store.markRunning(running.task_id, "/tmp/running.jsonl");
      const second = store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "second",
      });

      expect(store.listQueuedTaskIds()).toEqual([
        first.task_id,
        second.task_id,
      ]);
    } finally {
      store.close();
    }
  });
});
