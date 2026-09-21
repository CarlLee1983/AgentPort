import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { TaskStore } from "../../store/sqlite.js";
import { TaskRecordSchema } from "../../task/schema.js";
import { truncateFinalText } from "../capacity.js";
import { result, toolError } from "../result.js";

const InputSchema = z.object({
  task_id: z.string(),
});

const OutputSchema = TaskRecordSchema;

export interface GetTaskDeps {
  store: TaskStore;
}

/** `get_task({ task_id })` → Task 完整記錄（不等待）；不存在 → `not_found`。 */
export function registerGetTask(server: McpServer, deps: GetTaskDeps): void {
  server.registerTool(
    "get_task",
    {
      description: "查詢一個 Task 的目前狀態與結果",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
    },
    ({ task_id }) => {
      const task = deps.store.getTask(task_id);
      if (!task) {
        return toolError("not_found", `找不到 Task：${task_id}`);
      }
      return result(truncateFinalText(task));
    },
  );
}
