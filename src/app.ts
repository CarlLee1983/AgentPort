import type { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "./config/schema.js";
import type { DriverRegistry } from "./driver/types.js";
import { createCapacityPolicy, type CapacityPolicy } from "./mcp/capacity.js";
import { createServerFactory } from "./mcp/server.js";
import { createScheduler } from "./scheduler.js";
import { openTaskStore, type TaskStore } from "./store/sqlite.js";
import { createTaskNotifier } from "./task/notifier.js";

export interface CreateAppOptions {
  config: Config;
  drivers: DriverRegistry;
  caller: string;
  /** 僅供測試：覆寫 ADR-0005 容量政策的上限，不必真的塞出 8 MiB payload。 */
  capacity?: CapacityPolicy;
  /** 僅供測試：覆寫 `config.server.turn_timeout_seconds` 換算出的毫秒數。 */
  turnTimeoutMs?: number;
}

export interface App {
  serverFactory: (caller?: string) => McpServer;
  store: TaskStore;
  close(): void;
}

/** 組裝 Task Store、Scheduler 與 server factory；是 `agentport stdio` 與測試共用的入口。 */
export function createApp(options: CreateAppOptions): App {
  const store = openTaskStore(options.config.storage.db_path);
  const notifier = createTaskNotifier();
  const capacity = options.capacity ?? createCapacityPolicy();
  const scheduler = createScheduler({
    store,
    drivers: options.drivers,
    config: options.config,
    notifier,
    ...(options.turnTimeoutMs !== undefined
      ? { turnTimeoutMs: options.turnTimeoutMs }
      : {}),
  });
  const serverFactory = createServerFactory({
    config: options.config,
    store,
    scheduler,
    notifier,
    capacity,
    caller: options.caller,
  });

  return {
    serverFactory,
    store,
    close() {
      // 先把還在跑的 Turn 都 kill 掉，避免留下孤兒子程序，再關 DB 連線。
      scheduler.shutdown();
      store.close();
    },
  };
}
