import { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config/schema.js";
import type { Scheduler } from "../scheduler.js";
import type { TaskStore } from "../store/sqlite.js";
import type { TaskNotifier } from "../task/notifier.js";
import type { CapacityPolicy } from "./capacity.js";
import { registerCancelTask } from "./tools/cancel-task.js";
import { registerFollowUp } from "./tools/follow-up.js";
import { registerGetTask } from "./tools/get-task.js";
import { registerListAgents } from "./tools/list-agents.js";
import { registerListTasks } from "./tools/list-tasks.js";
import { registerSubmitTask } from "./tools/submit-task.js";

export interface ServerFactoryDeps {
  config: Config;
  store: TaskStore;
  scheduler: Scheduler;
  notifier: TaskNotifier;
  capacity: CapacityPolicy;
  caller: string;
}

/**
 * 一份 server factory 同時餵 `serveStdio` 與 `createMcpHandler`。
 * 每次呼叫可傳入本次連線 / 請求的 caller（HTTP 依 bearer 對應的 caller 名稱）；
 * 省略時用 `deps.caller`（stdio 固定為 `"local"`）。
 */
export function createServerFactory(
  deps: ServerFactoryDeps,
): (caller?: string) => McpServer {
  return (caller) => {
    const server = new McpServer(
      { name: "agentport", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerListAgents(server, { config: deps.config });
    const callerDeps = { ...deps, caller: caller ?? deps.caller };
    registerSubmitTask(server, callerDeps);
    registerFollowUp(server, callerDeps);
    registerGetTask(server, {
      store: deps.store,
      notifier: deps.notifier,
      config: deps.config,
      capacity: deps.capacity,
    });
    registerListTasks(server, { store: deps.store, capacity: deps.capacity });
    registerCancelTask(server, {
      store: deps.store,
      scheduler: deps.scheduler,
      notifier: deps.notifier,
      config: deps.config,
    });
    return server;
  };
}
