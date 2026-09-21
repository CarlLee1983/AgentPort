import { afterEach, describe, expect, it } from "vitest";

import { unavailableDrivers } from "../helpers/unavailable-driver.js";
import { cleanupTempDirs } from "../config/helpers.js";
import { createTestApp } from "../helpers/app.js";
import {
  resetCapacityLimitsForTesting,
  setCapacityLimitsForTesting,
} from "../../src/mcp/capacity.js";

afterEach(() => {
  resetCapacityLimitsForTesting();
  return cleanupTempDirs();
});

interface ListTasksPayload {
  tasks: { task_id: string }[];
  next_cursor: string | null;
}

interface GetTaskPayload {
  final_text: string | null;
  hints: { truncated?: boolean } | null;
}

describe("capacity (ADR-0005)", () => {
  it("list_tasks 在回應體逼近上限時提前縮頁，依 cursor 續走可不漏不重複拿到每一筆", async () => {
    // 測試用的上限縮小到 64 KiB，不必真的塞出 8 MiB payload 就能逼出縮頁。
    setCapacityLimitsForTesting({ responseBodyLimitBytes: 64 * 1024 });
    const app = await createTestApp(unavailableDrivers);
    try {
      const context = app.store.createContext("stationhub");
      // final_text 不進摘要，改用 error.message 撐大單筆摘要的序列化大小。
      const bigMessage = "x".repeat(20 * 1024);
      const taskIds: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const task = app.store.createTask({
          context_id: context.context_id,
          agent: "stationhub",
          caller: "local",
          prompt: "p",
        });
        app.store.markFailed(task.task_id, {
          code: "runtime_failed",
          message: bigMessage,
        });
        taskIds.push(task.task_id);
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const response = await app.client.callTool({
          name: "list_tasks",
          arguments: cursor ? { limit: 50, cursor } : { limit: 50 },
        });
        const payload = response.structuredContent as ListTasksPayload;
        expect(payload.tasks.length).toBeGreaterThan(0);
        for (const task of payload.tasks) {
          seen.push(task.task_id);
        }
        if (payload.next_cursor === null) {
          break;
        }
        cursor = payload.next_cursor;
      }

      // `ulid()` 在同一毫秒內不保證單調遞增，只驗證每一筆恰好出現一次、不漏不重。
      expect(seen.slice().sort()).toEqual(taskIds.slice().sort());
    } finally {
      await app.close();
    }
  });

  it("get_task 的 final_text 超過上限時截尾並附 hints.truncated，store 內原文不變", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const context = app.store.createContext("stationhub");
      const task = app.store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "hello",
      });
      const longText = "y".repeat(5 * 1024 * 1024); // 5 MiB，超過預設上限（~3.94 MiB）
      app.store.markCompleted(task.task_id, {
        final_text: longText,
        usage: null,
      });

      const response = await app.client.callTool({
        name: "get_task",
        arguments: { task_id: task.task_id },
      });
      const payload = response.structuredContent as GetTaskPayload;

      const finalText = payload.final_text;
      if (finalText === null) {
        throw new Error("final_text 不應為 null");
      }
      expect(finalText.length).toBeLessThan(longText.length);
      expect(payload.hints?.truncated).toBe(true);

      const stored = app.store.getTask(task.task_id);
      expect(stored?.final_text).toBe(longText);
    } finally {
      await app.close();
    }
  });
});
