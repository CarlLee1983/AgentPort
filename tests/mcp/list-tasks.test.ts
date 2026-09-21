import { afterEach, describe, expect, it } from "vitest";

import { unavailableDrivers } from "../helpers/unavailable-driver.js";
import { cleanupTempDirs } from "../config/helpers.js";
import { createTestApp } from "../helpers/app.js";

afterEach(cleanupTempDirs);

interface TaskSummaryPayload {
  task_id: string;
  agent: string;
  context_id: string;
  state: string;
  final_text?: unknown;
}

interface ListTasksPayload {
  tasks: TaskSummaryPayload[];
  next_cursor: string | null;
}

describe("list_tasks", () => {
  it("依 cursor 分頁走完，每筆恰好出現一次，最後 next_cursor 為 null", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const context = app.store.createContext("stationhub");
      const taskIds: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const task = app.store.createTask({
          context_id: context.context_id,
          agent: "stationhub",
          caller: "local",
          prompt: `prompt-${String(i)}`,
        });
        taskIds.push(task.task_id);
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const response = await app.client.callTool({
          name: "list_tasks",
          arguments: cursor ? { limit: 3, cursor } : { limit: 3 },
        });
        const payload = response.structuredContent as ListTasksPayload;
        for (const task of payload.tasks) {
          seen.push(task.task_id);
        }
        if (payload.next_cursor === null) {
          break;
        }
        cursor = payload.next_cursor;
      }

      // `ulid()` 在同一毫秒內不保證單調遞增，故不假設 task_id 字典序等於建立
      // 順序；只驗證依 cursor 走完後每一筆恰好出現一次、不漏不重。
      expect(seen.slice().sort()).toEqual(taskIds.slice().sort());
    } finally {
      await app.close();
    }
  });

  it("依 agent 篩選", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const context = app.store.createContext("stationhub");
      const matching = app.store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "keep",
      });
      app.store.createTask({
        context_id: context.context_id,
        agent: "other-agent",
        caller: "local",
        prompt: "drop",
      });

      const response = await app.client.callTool({
        name: "list_tasks",
        arguments: { agent: "stationhub" },
      });
      const payload = response.structuredContent as ListTasksPayload;

      expect(payload.tasks.map((t) => t.task_id)).toEqual([matching.task_id]);
    } finally {
      await app.close();
    }
  });

  it("依 context_id 篩選", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const contextA = app.store.createContext("stationhub");
      const contextB = app.store.createContext("stationhub");
      const matching = app.store.createTask({
        context_id: contextA.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "keep",
      });
      app.store.createTask({
        context_id: contextB.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "drop",
      });

      const response = await app.client.callTool({
        name: "list_tasks",
        arguments: { context_id: contextA.context_id },
      });
      const payload = response.structuredContent as ListTasksPayload;

      expect(payload.tasks.map((t) => t.task_id)).toEqual([matching.task_id]);
    } finally {
      await app.close();
    }
  });

  it("依 state 篩選", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const context = app.store.createContext("stationhub");
      const queuedTask = app.store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "queued",
      });
      const failedTask = app.store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "failed",
      });
      app.store.markFailed(failedTask.task_id, {
        code: "runtime_failed",
        message: "boom",
      });

      const response = await app.client.callTool({
        name: "list_tasks",
        arguments: { state: "queued" },
      });
      const payload = response.structuredContent as ListTasksPayload;

      expect(payload.tasks.map((t) => t.task_id)).toEqual([queuedTask.task_id]);
    } finally {
      await app.close();
    }
  });

  it("摘要不含 final_text", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const context = app.store.createContext("stationhub");
      const task = app.store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "hello",
      });
      app.store.markCompleted(task.task_id, {
        final_text: "the final answer",
        usage: { input_tokens: 1, output_tokens: 1 },
      });

      const response = await app.client.callTool({
        name: "list_tasks",
        arguments: {},
      });
      const payload = response.structuredContent as ListTasksPayload;

      expect(payload.tasks).toHaveLength(1);
      expect(payload.tasks[0]).not.toHaveProperty("final_text");
      expect(payload.tasks[0]).not.toHaveProperty("prompt");
    } finally {
      await app.close();
    }
  });

  it("limit 超過 100 會被夾到 100", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const context = app.store.createContext("stationhub");
      for (let i = 0; i < 110; i += 1) {
        app.store.createTask({
          context_id: context.context_id,
          agent: "stationhub",
          caller: "local",
          prompt: `prompt-${String(i)}`,
        });
      }

      const response = await app.client.callTool({
        name: "list_tasks",
        arguments: { limit: 500 },
      });
      const payload = response.structuredContent as ListTasksPayload;

      expect(payload.tasks).toHaveLength(100);
      expect(payload.next_cursor).not.toBeNull();
    } finally {
      await app.close();
    }
  });

  it("未知格式的 cursor（排在所有真實 task_id 之前）回空頁", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const context = app.store.createContext("stationhub");
      app.store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "hello",
      });

      const response = await app.client.callTool({
        name: "list_tasks",
        arguments: { cursor: "0" },
      });
      const payload = response.structuredContent as ListTasksPayload;

      expect(payload.tasks).toEqual([]);
      expect(payload.next_cursor).toBeNull();
    } finally {
      await app.close();
    }
  });
});
