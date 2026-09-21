import { Client } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/load.js";
import { unavailableDrivers } from "../helpers/unavailable-driver.js";
import {
  agentToml,
  baseEnv,
  cleanupTempDirs,
  makeFakeExecutable,
  makeTempDir,
  makeWorkspace,
  writeConfigFile,
} from "../config/helpers.js";
import { waitForTaskFinal } from "../helpers/app.js";

afterEach(cleanupTempDirs);

async function connectClient(app: {
  serverFactory: () => McpServer;
}): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = app.serverFactory();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("重啟後的持久化", () => {
  it("關掉 app 再用同一個 db 路徑開新 app，透過 MCP get_task 仍拿到同一筆 Task", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const dbPath = `${dir}/agentport.sqlite`;
    const logDir = `${dir}/logs`;
    const configPath = await writeConfigFile(
      dir,
      `${agentToml()}\n[storage]\ndb_path = "${dbPath}"\nlog_dir = "${logDir}"\n`,
    );
    const env = baseEnv({ HOME: dir, PATH: dir });
    const loadResult = loadConfig(configPath, env);
    if (!loadResult.ok) {
      throw new Error("測試設定檔載入失敗");
    }

    const firstApp = createApp({
      config: loadResult.config,
      drivers: unavailableDrivers,
      caller: "local",
    });
    const firstClient = await connectClient(firstApp);
    const submitResponse = await firstClient.callTool({
      name: "submit_task",
      arguments: { agent: "stationhub", prompt: "persisted prompt" },
    });
    const { task_id: taskId } = submitResponse.structuredContent as {
      task_id: string;
    };

    // 假 Driver 立即回 failed，等它跑完再關 app，避免關 db 連線時 scheduler 還在寫入。
    await waitForTaskFinal(firstClient, taskId);

    await firstClient.close();
    firstApp.close();

    const secondApp = createApp({
      config: loadResult.config,
      drivers: unavailableDrivers,
      caller: "local",
    });
    const secondClient = await connectClient(secondApp);
    try {
      const getResponse = await secondClient.callTool({
        name: "get_task",
        arguments: { task_id: taskId },
      });
      const task = getResponse.structuredContent as {
        prompt: string;
        task_id: string;
      };
      expect(task.task_id).toBe(taskId);
      expect(task.prompt).toBe("persisted prompt");
    } finally {
      await secondClient.close();
      secondApp.close();
    }
  });
});
