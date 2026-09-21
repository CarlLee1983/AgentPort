import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../config/helpers.js";
import { createTestApp, waitForTaskFinal } from "../helpers/app.js";
import { scriptedDriver, sequencedDriver } from "../helpers/fake-driver.js";
import { unavailableDrivers } from "../helpers/unavailable-driver.js";

afterEach(cleanupTempDirs);

interface SubmitPayload {
  task_id: string;
  context_id: string;
  state: string;
}

describe("follow_up", () => {
  it("前一個 task 完成後 follow_up 走 resume，帶入 started 事件的 runtime_session_id；context_id/agent 沿用", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "first done", usage: null },
      ],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submitResponse = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "first" },
      });
      const { task_id: firstTaskId, context_id: contextId } =
        submitResponse.structuredContent as SubmitPayload;
      await waitForTaskFinal(app.client, firstTaskId);

      const followResponse = await app.client.callTool({
        name: "follow_up",
        arguments: { context_id: contextId, prompt: "second" },
      });
      expect(followResponse.isError).toBeFalsy();
      const followPayload = followResponse.structuredContent as SubmitPayload;
      expect(followPayload.state).toBe("queued");
      expect(followPayload.context_id).toBe(contextId);

      const secondTask = await waitForTaskFinal(
        app.client,
        followPayload.task_id,
      );
      expect(secondTask.state).toBe("completed");
      expect(secondTask.agent).toBe("stationhub");

      expect(driver.received).toHaveLength(2);
      expect(driver.received[1]).toMatchObject({
        prompt: "second",
        runtime_session_id: "sess-1",
      });
      // 第一通呼叫（submit_task）沒有 runtime_session_id，是 start 不是 resume。
      expect(driver.received[0]).not.toHaveProperty("runtime_session_id");
    } finally {
      await app.close();
    }
  });

  it("未知 context_id 回 not_found", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const response = await app.client.callTool({
        name: "follow_up",
        arguments: { context_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", prompt: "hi" },
      });
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toEqual({
        error: { code: "not_found", message: expect.any(String) as unknown },
      });
    } finally {
      await app.close();
    }
  });

  it("前一個 task 仍 running 時，follow_up 的新 task 保持 queued 直到前一個 completed", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "first done", usage: null },
      ],
      delayMs: 50,
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submitResponse = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "first" },
      });
      const { task_id: firstTaskId, context_id: contextId } =
        submitResponse.structuredContent as SubmitPayload;

      const followResponse = await app.client.callTool({
        name: "follow_up",
        arguments: { context_id: contextId, prompt: "second" },
      });
      const { task_id: secondTaskId } =
        followResponse.structuredContent as SubmitPayload;

      const midFlightSecond = await app.client.callTool({
        name: "get_task",
        arguments: { task_id: secondTaskId },
      });
      expect(
        (midFlightSecond.structuredContent as { state: string }).state,
      ).toBe("queued");

      const firstTask = await waitForTaskFinal(app.client, firstTaskId);
      expect(firstTask.state).toBe("completed");

      const secondTask = await waitForTaskFinal(app.client, secondTaskId);
      expect(secondTask.state).toBe("completed");
      expect(driver.received).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("前一個 task failed 且未曾送 started（無 session id）→ follow_up 走 start 起新 session", async () => {
    const driver = scriptedDriver({
      events: [{ type: "failed", error: "boom" }],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submitResponse = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "first" },
      });
      const { task_id: firstTaskId, context_id: contextId } =
        submitResponse.structuredContent as SubmitPayload;
      const firstTask = await waitForTaskFinal(app.client, firstTaskId);
      expect(firstTask.state).toBe("failed");
      expect(app.store.getContext(contextId)?.runtime_session_id).toBeNull();

      const followResponse = await app.client.callTool({
        name: "follow_up",
        arguments: { context_id: contextId, prompt: "second" },
      });
      const { task_id: secondTaskId } =
        followResponse.structuredContent as SubmitPayload;
      await waitForTaskFinal(app.client, secondTaskId);

      expect(driver.received).toHaveLength(2);
      expect(driver.received[1]).not.toHaveProperty("runtime_session_id");
    } finally {
      await app.close();
    }
  });

  it("前一個 task failed 但已有 session id → follow_up 走 resume", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-2" },
        { type: "failed", error: "boom after started" },
      ],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submitResponse = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "first" },
      });
      const { task_id: firstTaskId, context_id: contextId } =
        submitResponse.structuredContent as SubmitPayload;
      const firstTask = await waitForTaskFinal(app.client, firstTaskId);
      expect(firstTask.state).toBe("failed");
      expect(app.store.getContext(contextId)?.runtime_session_id).toBe(
        "sess-2",
      );

      const followResponse = await app.client.callTool({
        name: "follow_up",
        arguments: { context_id: contextId, prompt: "second" },
      });
      const { task_id: secondTaskId } =
        followResponse.structuredContent as SubmitPayload;
      await waitForTaskFinal(app.client, secondTaskId);

      expect(driver.received).toHaveLength(2);
      expect(driver.received[1]).toMatchObject({
        runtime_session_id: "sess-2",
        prompt: "second",
      });
    } finally {
      await app.close();
    }
  });

  it("resume 回 failed{session_unresumable} → follow_up 的 task failed 且 error.code = session_unresumable", async () => {
    const driver = sequencedDriver([
      {
        events: [
          { type: "started", runtime_session_id: "sess-3" },
          { type: "completed", final_text: "first done", usage: null },
        ],
      },
      {
        events: [
          {
            type: "failed",
            error: "session not found",
            code: "session_unresumable",
          },
        ],
      },
    ]);
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submitResponse = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "first" },
      });
      const { task_id: firstTaskId, context_id: contextId } =
        submitResponse.structuredContent as SubmitPayload;
      await waitForTaskFinal(app.client, firstTaskId);

      const followResponse = await app.client.callTool({
        name: "follow_up",
        arguments: { context_id: contextId, prompt: "second" },
      });
      const { task_id: secondTaskId } =
        followResponse.structuredContent as SubmitPayload;
      const secondTask = await waitForTaskFinal(app.client, secondTaskId);

      expect(secondTask.state).toBe("failed");
      expect((secondTask.error as { code: string }).code).toBe(
        "session_unresumable",
      );
      expect(driver.received[1]).toHaveProperty("runtime_session_id", "sess-3");
    } finally {
      await app.close();
    }
  });
});
