import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../config/helpers.js";
import { createTestApp, waitForTaskFinal } from "../helpers/app.js";
import { scriptedDriver } from "../helpers/fake-driver.js";

afterEach(cleanupTempDirs);

describe("scheduler 對例外與非終態事件的韌性", () => {
  it("store 方法在某個 Task 執行中途丟例外 → 該 Task failed，下一個 Task 仍正常 completed", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "done", usage: null },
      ],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      let thrown = false;
      const originalSetRuntimeSession = app.store.setRuntimeSession.bind(
        app.store,
      );
      app.store.setRuntimeSession = (
        contextId: string,
        runtimeSessionId: string,
      ) => {
        if (!thrown) {
          thrown = true;
          throw new Error("wrapper: setRuntimeSession 一次性丟例外");
        }
        originalSetRuntimeSession(contextId, runtimeSessionId);
      };

      const firstSubmit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "first" },
      });
      const { task_id: firstTaskId } = firstSubmit.structuredContent as {
        task_id: string;
      };
      const firstTask = await waitForTaskFinal(app.client, firstTaskId);
      expect(firstTask.state).toBe("failed");
      expect((firstTask.error as { code: string }).code).toBe("runtime_failed");

      const secondSubmit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "second" },
      });
      const { task_id: secondTaskId } = secondSubmit.structuredContent as {
        task_id: string;
      };
      const secondTask = await waitForTaskFinal(app.client, secondTaskId);
      expect(secondTask.state).toBe("completed");
      expect(secondTask.final_text).toBe("done");
    } finally {
      await app.close();
    }
  });

  it("Driver 事件流自然結束但沒送終態事件 → failed 且訊息說明沒有終態事件", async () => {
    const driver = scriptedDriver({
      events: [{ type: "started", runtime_session_id: "sess-1" }],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submitResponse = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "no terminal event" },
      });
      const { task_id: taskId } = submitResponse.structuredContent as {
        task_id: string;
      };
      const task = await waitForTaskFinal(app.client, taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toEqual({
        code: "runtime_failed",
        message: "driver ended without terminal event",
      });
    } finally {
      await app.close();
    }
  });

  it("收到終態事件後忽略後續事件：completed 之後的 failed 不覆寫", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "completed", final_text: "already done", usage: null },
        { type: "failed", error: "should be ignored" },
      ],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submitResponse = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "terminal then more" },
      });
      const { task_id: taskId } = submitResponse.structuredContent as {
        task_id: string;
      };
      const task = await waitForTaskFinal(app.client, taskId);
      expect(task.state).toBe("completed");
      expect(task.final_text).toBe("already done");
    } finally {
      await app.close();
    }
  });
});
