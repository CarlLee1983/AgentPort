import { McpServer } from "@modelcontextprotocol/server";

import type { Config } from "../config/schema.js";
import type { Scheduler } from "../scheduler.js";
import type { TaskStore } from "../store/sqlite.js";
import type { TaskNotifier } from "../task/notifier.js";
import { registerFollowUp } from "./tools/follow-up.js";
import { registerGetTask } from "./tools/get-task.js";
import { registerListAgents } from "./tools/list-agents.js";
import { registerSubmitTask } from "./tools/submit-task.js";

export interface ServerFactoryDeps {
  config: Config;
  store: TaskStore;
  scheduler: Scheduler;
  notifier: TaskNotifier;
  caller: string;
}

/** 一份 server factory 同時餵 `serveStdio` 與（後續票的）`createMcpHandler`。 */
export function createServerFactory(deps: ServerFactoryDeps): () => McpServer {
  return () => {
    const server = new McpServer(
      { name: "agentport", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerListAgents(server, { config: deps.config });
    registerSubmitTask(server, deps);
    registerFollowUp(server, deps);
    registerGetTask(server, {
      store: deps.store,
      notifier: deps.notifier,
      config: deps.config,
    });
    return server;
  };
}
