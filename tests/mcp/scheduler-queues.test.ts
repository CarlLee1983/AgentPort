import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load.js";
import {
  agentToml,
  baseEnv,
  cleanupTempDirs,
  makeFakeExecutable,
  makeTempDir,
  makeWorkspace,
  writeConfigFile,
} from "../config/helpers.js";
import {
  createMultiAgentTestApp,
  createTestAppFromConfig,
  waitForTaskFinal,
} from "../helpers/app.js";
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

      // 用 `pulled(1)` 等到第一個 Task 的 `started` 事件確定送達，不用猜時間：
      // 這個時間點第一個 Task 一定還沒送出 `completed`（`delayMs` 讓每個事件
      // 都要等一段時間），同 agent FIFO 保證第二、三個 Task 這時一定還在
      // queued，不會偶爾因為機器忙、排程延遲而誤判成「已經跑完」。
      await driver.pulled(1);
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

  it("兩個 agent 各派一個 task：兩條 chain 各自獨立，不會被同一條 FIFO 序列化擋住", async () => {
    // 兩個 agent 用不同 runtime（claude / codex），各自配一個獨立的假
    // driver 實例：`holdAfter` 讓 Turn 送出 `started` 後卡住，`pulled(1)`
    // 是每個 driver 自己的計數器，兩邊都等到才能確定「兩個 Turn 真的同時在
    // 跑」。如果 scheduler 不小心把兩個 agent 排進同一條 FIFO chain，其中一個
    // 永遠排不到、`pulled(1)` 永遠不 resolve，這裡會逾時失敗，而不是像原本
    // 用 `started_at` 差值那樣偶爾因為機器忙就跨過 100ms 門檻、悄悄變成假
    // 陽性或假陰性。
    const driverA = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-a" },
        { type: "completed", final_text: "done a", usage: null },
      ],
      holdAfter: 1,
    });
    const driverB = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-b" },
        { type: "completed", final_text: "done b", usage: null },
      ],
      holdAfter: 1,
    });

    const dir = await makeTempDir();
    const stationhubWorkspace = await makeWorkspace(dir, "stationhub");
    await makeWorkspace(dir, "forgepilot");
    await makeFakeExecutable(dir, "claude");
    await makeFakeExecutable(dir, "codex");
    const dbPath = `${dir}/agentport.sqlite`;
    const logDir = `${dir}/logs`;
    const toml =
      agentToml({
        name: "stationhub",
        workspace: "stationhub",
        runtime: "claude",
      }) +
      agentToml({
        name: "forgepilot",
        workspace: "forgepilot",
        runtime: "codex",
      }) +
      `\n[storage]\ndb_path = "${dbPath}"\nlog_dir = "${logDir}"\n`;
    const configPath = await writeConfigFile(dir, toml);
    const loadResult = loadConfig(
      configPath,
      baseEnv({ HOME: dir, PATH: dir }),
    );
    if (!loadResult.ok) {
      throw new Error(
        `測試設定檔載入失敗：${loadResult.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
      );
    }

    const app = await createTestAppFromConfig(
      loadResult.config,
      { claude: driverA, codex: driverB },
      { dir, dbPath, logDir, workspace: stationhubWorkspace },
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

      await Promise.all([driverA.pulled(1), driverB.pulled(1)]);

      // 兩邊都證實同時在跑之後，靠 `cancel_task` 讓卡住的 Turn 結束
      // （`holdAfter` 的假 driver 只有 `kill()` 能讓它繼續走完迭代）。
      await app.client.callTool({
        name: "cancel_task",
        arguments: { task_id: idA },
      });
      await app.client.callTool({
        name: "cancel_task",
        arguments: { task_id: idB },
      });

      const taskA = await waitForTaskFinal(app.client, idA);
      const taskB = await waitForTaskFinal(app.client, idB);

      expect(taskA.state).toBe("cancelled");
      expect(taskB.state).toBe("cancelled");
    } finally {
      await app.close();
    }
  });
});
