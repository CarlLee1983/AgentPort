import type { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "./config/schema.js";
import type { DriverRegistry } from "./driver/types.js";
import { createServerFactory } from "./mcp/server.js";
import { createScheduler } from "./scheduler.js";
import { openTaskStore, type TaskStore } from "./store/sqlite.js";

export interface CreateAppOptions {
  config: Config;
  drivers: DriverRegistry;
  caller: string;
}

export interface App {
  serverFactory: (caller?: string) => McpServer;
  store: TaskStore;
  close(): void;
}

/** 組裝 Task Store、Scheduler 與 server factory；是 `agentport stdio` 與測試共用的入口。 */
export function createApp(options: CreateAppOptions): App {
  const store = openTaskStore(options.config.storage.db_path);
  const scheduler = createScheduler({
    store,
    drivers: options.drivers,
    config: options.config,
  });
  const serverFactory = createServerFactory({
    config: options.config,
    store,
    scheduler,
    caller: options.caller,
  });

  return {
    serverFactory,
    store,
    close() {
      store.close();
    },
  };
}
