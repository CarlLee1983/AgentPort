import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../config/helpers.js";
import { createTestApp } from "../helpers/app.js";
import { scriptedDriver } from "../helpers/fake-driver.js";

afterEach(cleanupTempDirs);

describe("get_task long-poll", () => {
  it("wait_seconds: 0 對 running task 立即回 running", async () => {
    const driver = scriptedDriver({
      events: [{ type: "started", runtime_session_id: "sess-1" }],
      delayMs: 500,
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "long running" },
      });
      const { task_id } = submit.structuredContent as { task_id: string };

      // 等 driver 送出 started（進 running）再打 wait_seconds: 0。
      await new Promise((resolve) => setTimeout(resolve, 50));

      const response = await app.client.callTool({
        name: "get_task",
        arguments: { task_id, wait_seconds: 0 },
      });
      expect((response.structuredContent as { state: string }).state).toBe(
        "running",
      );
    } finally {
      await app.close();
    }
  });

  it("wait_seconds: 5 對 200ms 後完成的 task，回 completed 且耗時 < 1s", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "done", usage: null },
      ],
      delayMs: 100,
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "quick" },
      });
      const { task_id } = submit.structuredContent as { task_id: string };

      const start = Date.now();
      const response = await app.client.callTool({
        name: "get_task",
        arguments: { task_id, wait_seconds: 5 },
      });
      const elapsed = Date.now() - start;

      expect((response.structuredContent as { state: string }).state).toBe(
        "completed",
      );
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await app.close();
    }
  });

  it("long_poll_max_seconds 夾住等待時間：3s 才完成的 task 在 ~1s 回 running", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "done", usage: null },
      ],
      delayMs: 3000,
    });
    const app = await createTestApp(
      { claude: driver, codex: driver },
      { extraToml: "\n[server]\nlong_poll_max_seconds = 1\n" },
    );
    try {
      const submit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "slow" },
      });
      const { task_id } = submit.structuredContent as { task_id: string };

      const start = Date.now();
      const response = await app.client.callTool({
        name: "get_task",
        arguments: { task_id, wait_seconds: 30 },
      });
      const elapsed = Date.now() - start;

      expect((response.structuredContent as { state: string }).state).toBe(
        "running",
      );
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(2500);
    } finally {
      await app.close();
    }
  });

  it("終態 task 帶 wait_seconds 立即回", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "already done", usage: null },
      ],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submit = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "fast" },
      });
      const { task_id } = submit.structuredContent as { task_id: string };

      // 讓它先跑到終態。
      let state = "queued";
      const deadline = Date.now() + 2000;
      while (state !== "completed" && Date.now() < deadline) {
        const poll = await app.client.callTool({
          name: "get_task",
          arguments: { task_id },
        });
        state = (poll.structuredContent as { state: string }).state;
        if (state !== "completed") {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(state).toBe("completed");

      const start = Date.now();
      const response = await app.client.callTool({
        name: "get_task",
        arguments: { task_id, wait_seconds: 30 },
      });
      const elapsed = Date.now() - start;

      expect((response.structuredContent as { state: string }).state).toBe(
        "completed",
      );
      expect(elapsed).toBeLessThan(500);
    } finally {
      await app.close();
    }
  });
});
