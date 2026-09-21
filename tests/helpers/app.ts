import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config/schema.js";
import type { DriverRegistry } from "../../src/driver/types.js";
import type { CapacityPolicy } from "../../src/mcp/capacity.js";
import type { TaskStore } from "../../src/store/sqlite.js";
import {
  agentToml,
  baseEnv,
  makeFakeExecutable,
  makeTempDir,
  makeWorkspace,
  writeConfigFile,
} from "../config/helpers.js";
import { loadConfig } from "../../src/config/load.js";

export interface TestAppPaths {
  dir: string;
  dbPath: string;
  logDir: string;
  workspace: string;
}

export interface TestApp {
  client: Client;
  store: TaskStore;
  paths: TestAppPaths;
  close(): Promise<void>;
}

/**
 * 建一個暫存目錄（config TOML + workspace + db + logs）並載入設定檔，但不
 * 開 store、不建 app：給需要在建 app 之前先用 `openTaskStore` 直接寫入「殘留」
 * 狀態的測試（例如票 11 重啟語意）使用，之後再用 `createTestAppFromConfig`
 * 建 app 觀察後續行為。
 */
export async function prepareTestAppConfig(
  options: { extraToml?: string } = {},
): Promise<{ config: Config; paths: TestAppPaths }> {
  const dir = await makeTempDir();
  const workspace = await makeWorkspace(dir, "workspace");
  await makeFakeExecutable(dir, "claude");
  const dbPath = `${dir}/agentport.sqlite`;
  const logDir = `${dir}/logs`;

  const toml = `${agentToml()}${options.extraToml ?? ""}\n[storage]\ndb_path = "${dbPath}"\nlog_dir = "${logDir}"\n`;
  const configPath = await writeConfigFile(dir, toml);

  const loadResult = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));
  if (!loadResult.ok) {
    throw new Error(
      `測試設定檔載入失敗：${loadResult.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    );
  }

  return {
    config: loadResult.config,
    paths: { dir, dbPath, logDir, workspace },
  };
}

/**
 * 建一個暫存目錄（config TOML + workspace + db + logs），用 `createApp` 組裝
 * server factory，並透過 `InMemoryTransport` 連上一個真的 MCP `Client`。
 */
export async function createTestApp(
  drivers: DriverRegistry,
  options: {
    extraToml?: string;
    capacity?: CapacityPolicy;
    turnTimeoutMs?: number;
  } = {},
): Promise<TestApp> {
  const { config, paths } = await prepareTestAppConfig(options);
  return createTestAppFromConfig(
    config,
    drivers,
    paths,
    options.capacity,
    options.turnTimeoutMs,
  );
}

/**
 * 建多個 agent 的測試 app（每個 agent 一個獨立 workspace 子目錄，名稱同 agent
 * name），供驗證「每 agent 一條 FIFO、跨 agent 並行」的測試使用。
 */
export async function createMultiAgentTestApp(
  drivers: DriverRegistry,
  agentNames: string[],
): Promise<TestApp> {
  const [firstAgentName] = agentNames;
  if (!firstAgentName) {
    throw new Error("createMultiAgentTestApp 需要至少一個 agent name");
  }

  const dir = await makeTempDir();
  await makeFakeExecutable(dir, "claude");
  const dbPath = `${dir}/agentport.sqlite`;
  const logDir = `${dir}/logs`;

  let toml = "";
  for (const name of agentNames) {
    await makeWorkspace(dir, name);
    toml += agentToml({ name, workspace: name });
  }
  toml += `\n[storage]\ndb_path = "${dbPath}"\nlog_dir = "${logDir}"\n`;
  const configPath = await writeConfigFile(dir, toml);

  const loadResult = loadConfig(configPath, baseEnv({ HOME: dir, PATH: dir }));
  if (!loadResult.ok) {
    throw new Error(
      `測試設定檔載入失敗：${loadResult.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    );
  }

  return createTestAppFromConfig(loadResult.config, drivers, {
    dir,
    dbPath,
    logDir,
    workspace: `${dir}/${firstAgentName}`,
  });
}

/**
 * 已有 `config`（例如 `prepareTestAppConfig` 產出、或重啟測試沿用前一個
 * app 的 `config`）時，直接建 app 並連上 client；`createTestApp` 內部也是
 * 靠這個函式組裝。
 */
export async function createTestAppFromConfig(
  config: Config,
  drivers: DriverRegistry,
  paths: TestAppPaths,
  capacity?: CapacityPolicy,
  turnTimeoutMs?: number,
): Promise<TestApp> {
  const app = createApp({
    config,
    drivers,
    caller: "local",
    ...(capacity ? { capacity } : {}),
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = app.serverFactory();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    store: app.store,
    paths,
    async close() {
      await client.close();
      app.close();
    },
  };
}

/** 小 polling helper：反覆呼叫 `get_task` 直到 state 不再是 queued/running 或逾時。 */
export async function waitForTaskFinal(
  client: Client,
  taskId: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await client.callTool({
      name: "get_task",
      arguments: { task_id: taskId },
    });
    const task = response.structuredContent as Record<string, unknown>;
    if (task.state !== "queued" && task.state !== "running") {
      return task;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `get_task(${taskId}) 逾時仍未到終態：${JSON.stringify(task)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
