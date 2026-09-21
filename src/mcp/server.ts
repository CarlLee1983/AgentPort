import { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config/schema.js";
import type { Scheduler } from "../scheduler.js";
import type { TaskStore } from "../store/sqlite.js";
import { registerGetTask } from "./tools/get-task.js";
import { registerListAgents } from "./tools/list-agents.js";
import { registerSubmitTask } from "./tools/submit-task.js";

export interface ServerFactoryDeps {
  config: Config;
  store: TaskStore;
  scheduler: Scheduler;
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
    registerSubmitTask(server, { ...deps, caller: caller ?? deps.caller });
    registerGetTask(server, { store: deps.store });
    return server;
  };
}
