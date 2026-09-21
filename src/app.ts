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
  try {
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

    // 重啟語意（票 11）：這個 process 沒有任何殘留 Task 對應的 Turn，DB 裡留著
    // 的 running 一定是上次程序中止時卡住的，先收斂成 failed{interrupted}；
    // queued 依 task_id（建立順序）重新 enqueue，讓 per-agent FIFO 與 Context
    // 線性照舊成立。single-instance 鎖（`openTaskStore`）保證同一個 db_path
    // 不會有第二個 process 在旁邊，所以這裡看到的 running 絕不是「其實還在跑」
    // 的假警報。
    const interrupted = store.interruptRunning();
    if (interrupted > 0) {
      console.error(`重啟時中斷 ${String(interrupted)} 個 running Task`);
    }
    for (const taskId of store.listQueuedTaskIds()) {
      scheduler.enqueue(taskId);
    }

    return {
      serverFactory,
      store,
      close() {
        // 先把還在跑的 Turn 都 kill 掉，避免留下孤兒子程序，再關 DB 連線。
        scheduler.shutdown();
        store.close();
      },
    };
  } catch (error) {
    // openTaskStore 成功之後任何一步出錯都要先關掉 store，不然 single-instance
    // 鎖會一直被這個失敗的呼叫占著，呼叫端就算收到例外也重新開不了。
    store.close();
    throw error;
  }
}
