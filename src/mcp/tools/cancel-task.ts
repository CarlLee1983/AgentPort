import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../../config/schema.js";
import type { Scheduler } from "../../scheduler.js";
import type { TaskStore } from "../../store/sqlite.js";
import type { TaskNotifier } from "../../task/notifier.js";
import { isTerminalState, TaskStateSchema } from "../../task/schema.js";
import { result, toolError } from "../result.js";

const InputSchema = z.object({
  task_id: z.string(),
});

const OutputSchema = z.object({
  task_id: z.string(),
  state: TaskStateSchema,
});

export interface CancelTaskDeps {
  store: TaskStore;
  scheduler: Scheduler;
  notifier: TaskNotifier;
  config: Config;
}

/**
 * `cancel_task({ task_id })` → `{ task_id, state }`。queued Task 立刻變
 * `cancelled`；running Task 送出 kill 後等到終態或 `long_poll_max_seconds`
 * 逾時，回目前狀態（逾時仍可能是 `running`，不算錯誤，caller 可再 `get_task`）；
 * 終態 Task → `invalid_state`；不存在 → `not_found`。
 */
export function registerCancelTask(
  server: McpServer,
  deps: CancelTaskDeps,
): void {
  server.registerTool(
    "cancel_task",
    {
      description: "取消一個排隊中或執行中的 Task",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
    },
    async ({ task_id }) => {
      // 先取 revision 再呼叫 scheduler.cancel：running Task 的取消結果（kill
      // 完成、markCancelled）可能在我們讀到 outcome 之後、開始等待之前就已經
      // 發生，先拿 revision 才不會把這個變化吃掉、白等到逾時（見 get_task 的
      // 同一套理由）。
      const sinceRevision = deps.notifier.current(task_id);
      const outcome = deps.scheduler.cancel(task_id);

      if (outcome === "not_found") {
        return toolError("not_found", `找不到 Task：${task_id}`);
      }
      if (outcome === "invalid_state") {
        const task = deps.store.getTask(task_id);
        return toolError(
          "invalid_state",
          `Task 已在終態（${task?.state ?? "unknown"}），無法取消`,
        );
      }
      if (outcome === "cancelled") {
        return result({ task_id, state: "cancelled" as const });
      }

      // "cancelling"：running Task 已經送出 kill，等到它收斂成終態，或
      // long_poll_max_seconds 逾時就回目前狀態（不是錯誤）。
      const deadline =
        Date.now() + deps.config.server.long_poll_max_seconds * 1000;
      let revision = sinceRevision;
      for (;;) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        const changeResult = await deps.notifier.waitForChange(
          task_id,
          revision,
          remainingMs,
        );
        if (changeResult === "timeout") {
          break;
        }
        revision = deps.notifier.current(task_id);
        const task = deps.store.getTask(task_id);
        if (task && isTerminalState(task.state)) {
          break;
        }
      }

      const latest = deps.store.getTask(task_id);
      return result({
        task_id,
        state: latest?.state ?? "running",
      });
    },
  );
}
