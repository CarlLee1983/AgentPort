import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../config/helpers.js";
import { createTestApp, waitForTaskFinal } from "../helpers/app.js";
import { scriptedDriver, sequencedDriver } from "../helpers/fake-driver.js";
import { initGitWorkspace } from "../helpers/git.js";
import { unavailableDrivers } from "../helpers/unavailable-driver.js";

afterEach(cleanupTempDirs);

interface SubmitPayload {
  task_id: string;
  context_id: string;
  state: string;
}

interface CancelPayload {
  task_id: string;
  state: string;
}

describe("cancel_task", () => {
  it("queued task 立刻取消，不進 worker，同 agent 後面沒有 task 卡住", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess" },
        { type: "completed", final_text: "first done", usage: null },
      ],
      delayMs: 100,
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const firstSubmit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "first" },
      });
      const { task_id: firstTaskId } =
        firstSubmit.structuredContent as SubmitPayload;

      const secondSubmit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "second" },
      });
      const { task_id: secondTaskId } =
        secondSubmit.structuredContent as SubmitPayload;

      const cancelResponse = await app.client.callTool({
        name: "cancel_task",
        arguments: { task_id: secondTaskId },
      });
      expect(cancelResponse.isError).toBeFalsy();
      const cancelPayload = cancelResponse.structuredContent as CancelPayload;
      expect(cancelPayload.state).toBe("cancelled");

      const secondTask = await app.client.callTool({
        name: "get_task",
        arguments: { task_id: secondTaskId },
      });
      const secondTaskRecord = secondTask.structuredContent as {
        state: string;
        error: { code: string } | null;
      };
      expect(secondTaskRecord.state).toBe("cancelled");
      expect(secondTaskRecord.error?.code).toBe("cancelled");

      const firstTask = await waitForTaskFinal(app.client, firstTaskId);
      expect(firstTask.state).toBe("completed");

      // driver 只收到第一個 task 的 prompt：第二個從沒被 worker 取出過。
      expect(driver.received).toHaveLength(1);
      expect(driver.received[0]).toMatchObject({ prompt: "first" });
    } finally {
      await app.close();
    }
  });

  it("running task 取消：保留已收到的 message 文字，跑 git 摘要，error.code = cancelled", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess" },
        { type: "message", text: "partial output" },
        { type: "completed", final_text: "should not appear", usage: null },
      ],
      // 送完前兩個事件（started + message）後卡住，等 kill() 才繼續；不用猜
      // 時間點，`pulled(2)` 確定兩個事件都已送達再取消。
      holdAfter: 2,
      onStart: async (input) => {
        await writeFile(join(input.workspace, "written.txt"), "x", "utf8");
      },
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      await initGitWorkspace(app.paths.workspace);

      const submit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "go" },
      });
      const { task_id: taskId } = submit.structuredContent as SubmitPayload;

      await driver.pulled(2);

      const cancelResponse = await app.client.callTool({
        name: "cancel_task",
        arguments: { task_id: taskId },
      });
      expect(cancelResponse.isError).toBeFalsy();
      expect((cancelResponse.structuredContent as CancelPayload).state).toBe(
        "cancelled",
      );

      const task = await waitForTaskFinal(app.client, taskId);
      expect(task.state).toBe("cancelled");
      expect(task.final_text).toBe("partial output");
      expect(task.diff_stat).toContain("written.txt");
      expect(task.commits).toEqual([]);
      expect((task.error as { code: string }).code).toBe("cancelled");
    } finally {
      await app.close();
    }
  });

  it("收到 completed 事件但迴圈還沒結束時取消：仍收斂成 cancelled，final_text/usage 用 completed 的資料", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "message", text: "partial" },
        { type: "completed", final_text: "full answer", usage: { tokens: 42 } },
      ],
      // 送完 completed 後卡住：scheduler 的 for-await 迴圈這時已經拿到
      // completed 事件、記下 terminal/completed，但迴圈本身還在等下一次
      // next()（也就是還沒真正跑出迴圈）。在這個當下取消，驗證「取消贏過
      // 已經收到的 completed」不只在迴圈結束後的分支成立，迴圈還卡著時一樣。
      holdAfter: 2,
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "go" },
      });
      const { task_id: taskId } = submit.structuredContent as SubmitPayload;

      await driver.pulled(2);

      const cancelResponse = await app.client.callTool({
        name: "cancel_task",
        arguments: { task_id: taskId },
      });
      expect((cancelResponse.structuredContent as CancelPayload).state).toBe(
        "cancelled",
      );

      const task = await waitForTaskFinal(app.client, taskId);
      expect(task.state).toBe("cancelled");
      expect((task.error as { code: string }).code).toBe("cancelled");
      expect(task.final_text).toBe("full answer");
      expect(task.usage).toEqual({ tokens: 42 });
    } finally {
      await app.close();
    }
  });

  it("被 kill 後 driver 又送 failed：取消結果仍是 cancelled，不會被蓋回 failed", async () => {
    const driver = scriptedDriver({
      events: [{ type: "started", runtime_session_id: "sess" }],
      // 送完 started 後卡住，等 kill() 才繼續（此時因為 killed 為 true，
      // 迴圈會中止並依 failAfterKill 補送一個 failed）。
      holdAfter: 1,
      failAfterKill: true,
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "go" },
      });
      const { task_id: taskId } = submit.structuredContent as SubmitPayload;

      await driver.pulled(1);

      const cancelResponse = await app.client.callTool({
        name: "cancel_task",
        arguments: { task_id: taskId },
      });
      expect((cancelResponse.structuredContent as CancelPayload).state).toBe(
        "cancelled",
      );

      const task = await waitForTaskFinal(app.client, taskId);
      expect(task.state).toBe("cancelled");
      expect((task.error as { code: string }).code).toBe("cancelled");
    } finally {
      await app.close();
    }
  });

  it("對終態 task 取消回 invalid_state", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess" },
        { type: "completed", final_text: "done", usage: null },
      ],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "go" },
      });
      const { task_id: taskId } = submit.structuredContent as SubmitPayload;
      await waitForTaskFinal(app.client, taskId);

      const cancelResponse = await app.client.callTool({
        name: "cancel_task",
        arguments: { task_id: taskId },
      });
      expect(cancelResponse.isError).toBe(true);
      expect(cancelResponse.structuredContent).toEqual({
        error: {
          code: "invalid_state",
          message: expect.any(String) as unknown,
        },
      });
    } finally {
      await app.close();
    }
  });

  it("不存在的 task_id 回 not_found", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const response = await app.client.callTool({
        name: "cancel_task",
        arguments: { task_id: "no-such-task" },
      });
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toEqual({
        error: { code: "not_found", message: expect.any(String) as unknown },
      });
    } finally {
      await app.close();
    }
  });

  it("running 但不在 active 的 task（模擬服務重啟殘留）直接收斂成 cancelled，不用等", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      // 直接在 store 造一筆 running Task，繞過 scheduler：模擬前次服務程序
      // 意外中止、這個 process 從沒把它排進 `active` 過的殘留狀態。
      const context = app.store.createContext("stationhub");
      const orphan = app.store.createTask({
        context_id: context.context_id,
        agent: "stationhub",
        caller: "local",
        prompt: "orphaned",
      });
      app.store.markRunning(orphan.task_id, "/tmp/agentport-orphan.jsonl");

      const cancelResponse = await app.client.callTool({
        name: "cancel_task",
        arguments: { task_id: orphan.task_id },
      });
      expect(cancelResponse.isError).toBeFalsy();
      expect((cancelResponse.structuredContent as CancelPayload).state).toBe(
        "cancelled",
      );

      const task = await app.client.callTool({
        name: "get_task",
        arguments: { task_id: orphan.task_id },
      });
      const record = task.structuredContent as {
        state: string;
        final_text: string | null;
        error: { code: string } | null;
      };
      expect(record.state).toBe("cancelled");
      expect(record.final_text).toBe("");
      expect(record.error?.code).toBe("cancelled");
    } finally {
      await app.close();
    }
  });

  it("turn_timeout 逾時：cancelled、error.code = timeout，訊息帶實際生效的毫秒數", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess" },
        { type: "message", text: "partial" },
        { type: "completed", final_text: "should not appear", usage: null },
      ],
      // 送完 started + message 後卡住，之後只靠逾時計時器的 kill() 讓它繼續。
      holdAfter: 2,
    });
    const app = await createTestApp(
      { claude: driver, codex: driver },
      { turnTimeoutMs: 50 },
    );
    try {
      const submit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "go" },
      });
      const { task_id: taskId } = submit.structuredContent as SubmitPayload;

      const task = await waitForTaskFinal(app.client, taskId);
      expect(task.state).toBe("cancelled");
      // 逾時計時從 markRunning 起算（涵蓋 captureHead 的 git spawn），小
      // turnTimeoutMs 下逾時有可能在 message 事件送達前就先觸發（captureHead
      // 本身耗時不定）。final_text 是「逾時前收到的文字」，這裡不斷言其值：
      // 那段語意（final_text 取自已收到的 message）已經由「running task 取消」
      // 與「收到 completed 事件但迴圈還沒結束時取消」兩個測試覆蓋（同一套
      // `finishCancelled` 邏輯，只是觸發來源是 cancel_task 而不是逾時計時器）。
      // 這裡只斷言逾時路徑本身確定成立的部分：終態、錯誤碼、訊息帶的是實際
      // 生效的毫秒數。
      expect((task.error as { code: string; message: string }).code).toBe(
        "timeout",
      );
      expect((task.error as { code: string; message: string }).message).toBe(
        "turn exceeded 50ms",
      );
    } finally {
      await app.close();
    }
  });

  it("取消後 follow_up：曾送過 started 的 context 走 resume 沿用同一個 session id", async () => {
    const driver = sequencedDriver([
      {
        events: [{ type: "started", runtime_session_id: "sess-cancelled" }],
        holdAfter: 1,
      },
      {
        events: [{ type: "completed", final_text: "follow done", usage: null }],
      },
    ]);
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "first" },
      });
      const { task_id: firstTaskId, context_id: contextId } =
        submit.structuredContent as SubmitPayload;

      await driver.pulled(1);

      const cancelResponse = await app.client.callTool({
        name: "cancel_task",
        arguments: { task_id: firstTaskId },
      });
      expect((cancelResponse.structuredContent as CancelPayload).state).toBe(
        "cancelled",
      );

      const followResponse = await app.client.callTool({
        name: "follow_up",
        arguments: { context_id: contextId, prompt: "second" },
      });
      const { task_id: secondTaskId } =
        followResponse.structuredContent as SubmitPayload;
      const secondTask = await waitForTaskFinal(app.client, secondTaskId);

      expect(secondTask.state).toBe("completed");
      expect(driver.received).toHaveLength(2);
      // 這裡順帶覆蓋了「cancel 後的 context 確實記得 started 事件回填的
      // session id」——follow_up 走 resume 帶對 session id 才會通過。
      expect(driver.received[1]).toMatchObject({
        runtime_session_id: "sess-cancelled",
        prompt: "second",
      });
    } finally {
      await app.close();
    }
  });

  it("get_task 的 long-poll 在等待中的 running task 被取消時醒過來", async () => {
    const driver = scriptedDriver({
      events: [{ type: "started", runtime_session_id: "sess" }],
      holdAfter: 1,
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "go" },
      });
      const { task_id: taskId } = submit.structuredContent as SubmitPayload;

      // 等 started 事件送達，確保進了 running 再開始 long-poll。
      await driver.pulled(1);

      const longPollPromise = app.client.callTool({
        name: "get_task",
        arguments: { task_id: taskId, wait_seconds: 10 },
      });

      // get_task 在等 wait_seconds 前會先拿一次 revision 快照，跟 notify
      // 誰先誰後都不影響正確性（見 notifier.ts 的說明），不需要在這裡插入
      // 額外等待去猜「long-poll 是不是已經開始等」。
      const cancelResponse = await app.client.callTool({
        name: "cancel_task",
        arguments: { task_id: taskId },
      });
      expect((cancelResponse.structuredContent as CancelPayload).state).toBe(
        "cancelled",
      );

      const longPollResult = await longPollPromise;
      expect(
        (longPollResult.structuredContent as { state: string }).state,
      ).toBe("cancelled");
    } finally {
      await app.close();
    }
  });

  it("app.close() 會 kill 掉還在跑的 turn，避免留下孤兒子程序", async () => {
    const driver = scriptedDriver({
      events: [{ type: "started", runtime_session_id: "sess" }],
      holdAfter: 1,
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    const submit = await app.client.callTool({
      name: "submit_task",
      arguments: { agent: "stationhub", prompt: "go" },
    });
    const { task_id: taskId } = submit.structuredContent as SubmitPayload;

    await driver.pulled(1);
    const running = await app.client.callTool({
      name: "get_task",
      arguments: { task_id: taskId },
    });
    expect((running.structuredContent as { state: string }).state).toBe(
      "running",
    );

    await app.close();

    expect(driver.killCount).toBeGreaterThanOrEqual(1);
  });
});
