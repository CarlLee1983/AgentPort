import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { unavailableDrivers } from "../../src/driver/unavailable.js";
import { cleanupTempDirs } from "../config/helpers.js";
import { scriptedDriver } from "../helpers/fake-driver.js";
import { initGitWorkspace } from "../helpers/git.js";
import { createTestApp, waitForTaskFinal } from "../helpers/app.js";

afterEach(cleanupTempDirs);

describe("submit_task", () => {
  it("回傳 task_id / context_id 與 queued 狀態", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const response = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "hello" },
      });

      expect(response.isError).toBeFalsy();
      const payload = response.structuredContent as {
        task_id: string;
        context_id: string;
        state: string;
      };
      expect(payload.state).toBe("queued");
      expect(payload.task_id).toMatch(/^[0-9A-Z]{26}$/);
      expect(payload.context_id).toMatch(/^[0-9A-Z]{26}$/);
      expect(
        JSON.parse((response.content[0] as { text: string }).text),
      ).toEqual(response.structuredContent);
    } finally {
      await app.close();
    }
  });

  it("未知 agent 回 unknown_agent 錯誤", async () => {
    const app = await createTestApp(unavailableDrivers);
    try {
      const response = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "no-such-agent", prompt: "hello" },
      });

      expect(response.isError).toBe(true);
      expect(response.structuredContent).toEqual({
        error: {
          code: "unknown_agent",
          message: expect.any(String) as unknown,
        },
      });
    } finally {
      await app.close();
    }
  });

  it("假 Driver 完成後 get_task 為 completed，final_text/usage 正確、prompt 原文可讀回", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "message", text: "thinking..." },
        {
          type: "completed",
          final_text: "done!",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submitResponse = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "do the thing" },
      });
      const { task_id: taskId, context_id: contextId } =
        submitResponse.structuredContent as {
          task_id: string;
          context_id: string;
        };

      const task = await waitForTaskFinal(app.client, taskId);
      expect(task.state).toBe("completed");
      expect(task.final_text).toBe("done!");
      expect(task.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
      expect(task.prompt).toBe("do the thing");

      const context = app.store.getContext(contextId);
      expect(context?.runtime_session_id).toBe("sess-1");

      expect(typeof task.raw_log_path).toBe("string");
      const lines = readFileSync(task.raw_log_path as string, "utf8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0] as string)).toEqual({
        type: "started",
        runtime_session_id: "sess-1",
      });
    } finally {
      await app.close();
    }
  });

  it("Driver failed 事件 → get_task 為 failed 且 error.code = runtime_failed", async () => {
    const driver = scriptedDriver({
      events: [{ type: "failed", error: "boom" }],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submitResponse = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "do the thing" },
      });
      const { task_id: taskId } = submitResponse.structuredContent as {
        task_id: string;
      };

      const task = await waitForTaskFinal(app.client, taskId);
      expect(task.state).toBe("failed");
      expect(task.error).toEqual({ code: "runtime_failed", message: "boom" });
    } finally {
      await app.close();
    }
  });

  it("Driver 迭代丟例外 → get_task 為 failed 且 error.code = runtime_failed", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        { type: "completed", final_text: "unreachable", usage: null },
      ],
      throwAfter: 1,
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      const submitResponse = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "do the thing" },
      });
      const { task_id: taskId } = submitResponse.structuredContent as {
        task_id: string;
      };

      const task = await waitForTaskFinal(app.client, taskId);
      expect(task.state).toBe("failed");
      expect((task.error as { code: string }).code).toBe("runtime_failed");
    } finally {
      await app.close();
    }
  });

  it("permission_denied 事件原樣進 hints.permission_denied[]", async () => {
    const driver = scriptedDriver({
      events: [
        { type: "started", runtime_session_id: "sess-1" },
        {
          type: "permission_denied",
          tool: "Bash",
          input: { command: "rm -rf /" },
        },
        { type: "completed", final_text: "done", usage: null },
      ],
    });
    const app = await createTestApp({ claude: driver, codex: driver });
    try {
      // workspace 需為 git repo，否則 completed 後的 git 摘要會失敗並多出
      // hints.git，干擾這裡只想驗證 permission_denied 的斷言。
      await initGitWorkspace(app.paths.workspace);

      const submitResponse = await app.client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "do the thing" },
      });
      const { task_id: taskId } = submitResponse.structuredContent as {
        task_id: string;
      };

      const task = await waitForTaskFinal(app.client, taskId);
      expect(task.hints).toEqual({
        permission_denied: [{ tool: "Bash", input: { command: "rm -rf /" } }],
      });
    } finally {
      await app.close();
    }
  });
});
