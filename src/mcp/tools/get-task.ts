import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../../config/schema.js";
import type { TaskStore } from "../../store/sqlite.js";
import type { TaskNotifier } from "../../task/notifier.js";
import { TaskRecordSchema } from "../../task/schema.js";
import { result, toolError } from "../result.js";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

const InputSchema = z.object({
  task_id: z.string(),
  wait_seconds: z.number().min(0).optional(),
});

const OutputSchema = TaskRecordSchema;

export interface GetTaskDeps {
  store: TaskStore;
  notifier: TaskNotifier;
  config: Config;
}

/**
 * `get_task({ task_id, wait_seconds? })` → Task 完整記錄；不存在 → `not_found`。
 * `wait_seconds` 為 0（或省略）或 Task 已在終態時立即回；否則等到狀態改變或
 * `min(wait_seconds, long_poll_max_seconds)` 逾時，逾時回目前狀態（不是錯誤）。
 */
export function registerGetTask(server: McpServer, deps: GetTaskDeps): void {
  server.registerTool(
    "get_task",
    {
      description:
        "查詢一個 Task 的目前狀態與結果，可用 wait_seconds 等待狀態改變",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
    },
    async ({ task_id, wait_seconds }) => {
      const task = deps.store.getTask(task_id);
      if (!task) {
        return toolError("not_found", `找不到 Task：${task_id}`);
      }

      if (!wait_seconds || TERMINAL_STATES.has(task.state)) {
        return result(task);
      }

      const timeoutMs =
        Math.min(wait_seconds, deps.config.server.long_poll_max_seconds) * 1000;
      await deps.notifier.waitForChange(task_id, timeoutMs);

      const latest = deps.store.getTask(task_id);
      if (!latest) {
        return toolError("not_found", `找不到 Task：${task_id}`);
      }
      return result(latest);
    },
  );
}
