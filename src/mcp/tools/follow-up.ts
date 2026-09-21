import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Scheduler } from "../../scheduler.js";
import type { TaskStore } from "../../store/sqlite.js";
import { result, toolError } from "../result.js";

const InputSchema = z.object({
  context_id: z.string(),
  prompt: z.string(),
});

const OutputSchema = z.object({
  task_id: z.string(),
  context_id: z.string(),
  state: z.literal("queued"),
});

export interface FollowUpDeps {
  store: TaskStore;
  scheduler: Scheduler;
  caller: string;
}

/**
 * `follow_up({ context_id, prompt })` → 沿用既有 Context 建立新 Task 並排進佇列；
 * agent 取自 Context（caller 不可指定、不可換）。Context 不存在 → `not_found`。
 * 前一個 Task 是否 resume 既有 session 由 scheduler 依 Context 的
 * `runtime_session_id` 決定，這裡只負責建 Task 與排隊，與 `submit_task` 相同。
 */
export function registerFollowUp(server: McpServer, deps: FollowUpDeps): void {
  server.registerTool(
    "follow_up",
    {
      description: "沿用既有 Context 追加一項工作",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
    },
    ({ context_id, prompt }) => {
      const context = deps.store.getContext(context_id);
      if (!context) {
        return toolError("not_found", `找不到 Context：${context_id}`);
      }

      const task = deps.store.createTask({
        context_id: context.context_id,
        agent: context.agent,
        caller: deps.caller,
        prompt,
      });
      deps.scheduler.enqueue(task.task_id);

      return result({
        task_id: task.task_id,
        context_id: context.context_id,
        state: "queued" as const,
      });
    },
  );
}
