import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../../config/schema.js";
import type { Scheduler } from "../../scheduler.js";
import type { TaskStore } from "../../store/sqlite.js";
import { createAndEnqueue } from "./enqueue.js";
import { result, toolError } from "../result.js";

const InputSchema = z.object({
  agent: z.string(),
  prompt: z.string(),
});

const OutputSchema = z.object({
  task_id: z.string(),
  context_id: z.string(),
  state: z.literal("queued"),
});

export interface SubmitTaskDeps {
  config: Config;
  store: TaskStore;
  scheduler: Scheduler;
  caller: string;
}

/** `submit_task({ agent, prompt })` → 建立 Context 與 Task 並排進佇列；未知 agent → `unknown_agent`。 */
export function registerSubmitTask(
  server: McpServer,
  deps: SubmitTaskDeps,
): void {
  server.registerTool(
    "submit_task",
    {
      description: "對指定 Agent 提交一項新工作",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
    },
    ({ agent, prompt }) => {
      const agentConfig = deps.config.agents.find(
        (candidate) => candidate.name === agent,
      );
      if (!agentConfig) {
        return toolError("unknown_agent", `未知 agent：${agent}`);
      }

      const context = deps.store.createContext(agent);
      return result(
        createAndEnqueue(deps, {
          context_id: context.context_id,
          agent,
          prompt,
        }),
      );
    },
  );
}
