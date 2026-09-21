import type { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/load.js";
import { openTaskStore } from "../../src/store/sqlite.js";
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
  createTestAppFromConfig,
  prepareTestAppConfig,
  waitForTaskFinal,
} from "../helpers/app.js";
import { sequencedDriver } from "../helpers/fake-driver.js";

afterEach(cleanupTempDirs);

interface TaskPayload {
  task_id: string;
  state: string;
  final_text: string | null;
  raw_log_path: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: { code: string; message: string } | null;
}

async function getTask(client: Client, taskId: string): Promise<TaskPayload> {
  const response = await client.callTool({
    name: "get_task",
    arguments: { task_id: taskId },
  });
  return response.structuredContent as TaskPayload;
}

describe("重啟語意（票 11）", () => {
  it("重啟前留在 running 的 Task 變成 failed{interrupted}，final_text 是 null、raw_log_path 保留，driver 從沒收到它", async () => {
    const { config, paths } = await prepareTestAppConfig();
    const store = openTaskStore(paths.dbPath);
    const context = store.createContext("stationhub");
    const orphan = store.createTask({
      context_id: context.context_id,
      agent: "stationhub",
      caller: "local",
      prompt: "left running",
    });
    store.markRunning(orphan.task_id, "/tmp/agentport-orphan.jsonl");
    store.close();

    const driver = sequencedDriver([{ events: [] }]);
    const app = await createTestAppFromConfig(
      config,
      { claude: driver, codex: driver },
      paths,
    );
    try {
      const task = await getTask(app.client, orphan.task_id);
      expect(task.state).toBe("failed");
      expect(task.error).toEqual({
        code: "interrupted",
        message: "service restarted while task was running",
      });
      expect(task.final_text).toBeNull();
      expect(task.raw_log_path).toBe("/tmp/agentport-orphan.jsonl");
      expect(driver.received).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("重啟前留在 queued 的 Task 依原順序自動繼續跑到 completed", async () => {
    const { config, paths } = await prepareTestAppConfig();
    const store = openTaskStore(paths.dbPath);
    const context = store.createContext("stationhub");
    const first = store.createTask({
      context_id: context.context_id,
      agent: "stationhub",
      caller: "local",
      prompt: "first queued",
    });
    const second = store.createTask({
      context_id: context.context_id,
      agent: "stationhub",
      caller: "local",
      prompt: "second queued",
    });
    store.close();

    const driver = sequencedDriver([
      {
        events: [
          { type: "started", runtime_session_id: "sess-1" },
          { type: "completed", final_text: "first done", usage: null },
        ],
      },
      {
        events: [{ type: "completed", final_text: "second done", usage: null }],
      },
    ]);
    const app = await createTestAppFromConfig(
      config,
      { claude: driver, codex: driver },
      paths,
    );
    try {
      const firstTask = await waitForTaskFinal(app.client, first.task_id);
      const secondTask = await waitForTaskFinal(app.client, second.task_id);
      expect(firstTask.state).toBe("completed");
      expect(secondTask.state).toBe("completed");
      expect(driver.received.map((input) => input.prompt)).toEqual([
        "first queued",
        "second queued",
      ]);
      expect(
        (secondTask.started_at as string) >= (firstTask.finished_at as string),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("重啟前留在 queued 的 follow-up（Context 已有 runtime_session_id）重啟後用 resume 續跑", async () => {
    const { config, paths } = await prepareTestAppConfig();
    const store = openTaskStore(paths.dbPath);
    const context = store.createContext("stationhub");
    store.setRuntimeSession(context.context_id, "existing-session");
    const followUp = store.createTask({
      context_id: context.context_id,
      agent: "stationhub",
      caller: "local",
      prompt: "resume me",
    });
    store.close();

    const driver = sequencedDriver([
      { events: [{ type: "completed", final_text: "resumed", usage: null }] },
    ]);
    const app = await createTestAppFromConfig(
      config,
      { claude: driver, codex: driver },
      paths,
    );
    try {
      const task = await waitForTaskFinal(app.client, followUp.task_id);
      expect(task.state).toBe("completed");
      expect(driver.received).toEqual([
        expect.objectContaining({ runtime_session_id: "existing-session" }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("同一個 agent／context 混合 running + queued：running 變 interrupted，queued 照樣續跑並 resume", async () => {
    const { config, paths } = await prepareTestAppConfig();
    const store = openTaskStore(paths.dbPath);
    const context = store.createContext("stationhub");
    store.setRuntimeSession(context.context_id, "existing-session");
    const running = store.createTask({
      context_id: context.context_id,
      agent: "stationhub",
      caller: "local",
      prompt: "was running",
    });
    store.markRunning(running.task_id, "/tmp/agentport-mixed.jsonl");
    const queued = store.createTask({
      context_id: context.context_id,
      agent: "stationhub",
      caller: "local",
      prompt: "queued follow-up",
    });
    store.close();

    const driver = sequencedDriver([
      { events: [{ type: "completed", final_text: "done", usage: null }] },
    ]);
    const app = await createTestAppFromConfig(
      config,
      { claude: driver, codex: driver },
      paths,
    );
    try {
      const runningTask = await getTask(app.client, running.task_id);
      expect(runningTask.state).toBe("failed");
      expect(runningTask.error?.code).toBe("interrupted");

      const queuedTask = await waitForTaskFinal(app.client, queued.task_id);
      expect(queuedTask.state).toBe("completed");
      expect(driver.received).toEqual([
        expect.objectContaining({ runtime_session_id: "existing-session" }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("已是終態的 Task（completed / failed / cancelled）重啟後原樣不動", async () => {
    const { config, paths } = await prepareTestAppConfig();
    const store = openTaskStore(paths.dbPath);
    const context = store.createContext("stationhub");
    const completed = store.createTask({
      context_id: context.context_id,
      agent: "stationhub",
      caller: "local",
      prompt: "completed",
    });
    store.markCompleted(completed.task_id, {
      final_text: "already done",
      usage: null,
    });
    const failed = store.createTask({
      context_id: context.context_id,
      agent: "stationhub",
      caller: "local",
      prompt: "failed",
    });
    store.markFailed(failed.task_id, {
      code: "runtime_failed",
      message: "boom",
    });
    const cancelled = store.createTask({
      context_id: context.context_id,
      agent: "stationhub",
      caller: "local",
      prompt: "cancelled",
    });
    store.cancelQueued(cancelled.task_id, {
      code: "cancelled",
      message: "cancelled by caller",
    });
    store.close();

    const driver = sequencedDriver([{ events: [] }]);
    const app = await createTestAppFromConfig(
      config,
      { claude: driver, codex: driver },
      paths,
    );
    try {
      expect((await getTask(app.client, completed.task_id)).state).toBe(
        "completed",
      );
      expect((await getTask(app.client, failed.task_id)).state).toBe("failed");
      expect((await getTask(app.client, cancelled.task_id)).state).toBe(
        "cancelled",
      );
      expect(driver.received).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("重啟前設定檔已移除某 agent、DB 仍有它的 queued Task → 重建後收斂為 failed{runtime_failed}", async () => {
    const dir = await makeTempDir();
    const workspace = await makeWorkspace(dir, "workspace");
    await makeWorkspace(dir, "forgepilot");
    await makeFakeExecutable(dir, "claude");
    const dbPath = `${dir}/agentport.sqlite`;
    const logDir = `${dir}/logs`;
    const paths = { dir, dbPath, logDir, workspace };

    // 重啟前的設定檔有 stationhub 跟 forgepilot 兩個 agent。
    const initialTomlPath = await writeConfigFile(
      dir,
      `${agentToml()}${agentToml({ name: "forgepilot", workspace: "forgepilot" })}\n[storage]\ndb_path = "${dbPath}"\nlog_dir = "${logDir}"\n`,
    );
    const initialLoadResult = loadConfig(
      initialTomlPath,
      baseEnv({ HOME: dir, PATH: dir }),
    );
    if (!initialLoadResult.ok) {
      throw new Error("測試設定檔載入失敗");
    }

    const store = openTaskStore(paths.dbPath);
    const context = store.createContext("forgepilot");
    const orphanAgentTask = store.createTask({
      context_id: context.context_id,
      agent: "forgepilot",
      caller: "local",
      prompt: "agent removed before restart",
    });
    store.close();

    // 重啟後的設定檔拿掉了 forgepilot，只剩 stationhub；同一個 db_path / log_dir。
    const reducedTomlPath = await writeConfigFile(
      paths.dir,
      `${agentToml()}\n[storage]\ndb_path = "${paths.dbPath}"\nlog_dir = "${paths.logDir}"\n`,
    );
    const reducedLoadResult = loadConfig(
      reducedTomlPath,
      baseEnv({ HOME: paths.dir, PATH: paths.dir }),
    );
    if (!reducedLoadResult.ok) {
      throw new Error("測試設定檔載入失敗");
    }

    const driver = sequencedDriver([{ events: [] }]);
    const app = await createTestAppFromConfig(
      reducedLoadResult.config,
      { claude: driver, codex: driver },
      paths,
    );
    try {
      const task = await waitForTaskFinal(app.client, orphanAgentTask.task_id);
      expect(task.state).toBe("failed");
      expect(task.error).toEqual({
        code: "runtime_failed",
        message: "未知 agent：forgepilot",
      });
      expect(driver.received).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
