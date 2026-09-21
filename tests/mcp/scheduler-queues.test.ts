import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../config/helpers.js";
import { createMultiAgentTestApp, waitForTaskFinal } from "../helpers/app.js";
import { scriptedDriver } from "../helpers/fake-driver.js";

afterEach(cleanupTempDirs);

describe("scheduler 佇列：同 agent 序列、跨 agent 並行", () => {
  it("同 agent 連派三個 100ms task：第二個在第一個 completed 前保持 queued，started_at 嚴格遞增不重疊", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess" },
        { type: "completed", final_text: "done", usage: null },
      ],
      delayMs: 100,
    });
    const app = await createMultiAgentTestApp(
      { claude: driver, codex: driver },
      ["stationhub"],
    );
    try {
      const submit1 = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "one" },
      });
      const { task_id: id1 } = submit1.structuredContent as {
        task_id: string;
      };

      const submit2 = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "two" },
      });
      const { task_id: id2 } = submit2.structuredContent as {
        task_id: string;
      };

      const submit3 = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "three" },
      });
      const { task_id: id3 } = submit3.structuredContent as {
        task_id: string;
      };

      // 送出後立刻檢查：第一個已進 running，其餘還在 queued（第一個要跑 100ms）。
      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = await app.client.callTool({
        name: "get_task",
        arguments: { task_id: id2 },
      });
      expect((second.structuredContent as { state: string }).state).toBe(
        "queued",
      );
      const third = await app.client.callTool({
        name: "get_task",
        arguments: { task_id: id3 },
      });
      expect((third.structuredContent as { state: string }).state).toBe(
        "queued",
      );

      const task1 = await waitForTaskFinal(app.client, id1);
      const task2 = await waitForTaskFinal(app.client, id2);
      const task3 = await waitForTaskFinal(app.client, id3);

      expect(task1.state).toBe("completed");
      expect(task2.state).toBe("completed");
      expect(task3.state).toBe("completed");

      const started1 = Date.parse(task1.started_at as string);
      const finished1 = Date.parse(task1.finished_at as string);
      const started2 = Date.parse(task2.started_at as string);
      const finished2 = Date.parse(task2.finished_at as string);
      const started3 = Date.parse(task3.started_at as string);

      expect(started1).toBeLessThan(started2);
      expect(started2).toBeLessThan(started3);
      expect(started2).toBeGreaterThanOrEqual(finished1);
      expect(started3).toBeGreaterThanOrEqual(finished2);
    } finally {
      await app.close();
    }
  });

  it("兩個 agent 各派一個 300ms task：started_at 差 < 100ms（重疊執行）", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess" },
        { type: "completed", final_text: "done", usage: null },
      ],
      delayMs: 300,
    });
    const app = await createMultiAgentTestApp(
      { claude: driver, codex: driver },
      ["stationhub", "forgepilot"],
    );
    try {
      const submitA = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "a" },
      });
      const { task_id: idA } = submitA.structuredContent as {
        task_id: string;
      };

      const submitB = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "forgepilot", prompt: "b" },
      });
      const { task_id: idB } = submitB.structuredContent as {
        task_id: string;
      };

      const taskA = await waitForTaskFinal(app.client, idA);
      const taskB = await waitForTaskFinal(app.client, idB);

      expect(taskA.state).toBe("completed");
      expect(taskB.state).toBe("completed");

      const startedA = Date.parse(taskA.started_at as string);
      const startedB = Date.parse(taskB.started_at as string);

      expect(Math.abs(startedA - startedB)).toBeLessThan(100);
    } finally {
      await app.close();
    }
  });
});
