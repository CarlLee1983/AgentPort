import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { TaskStore } from "../../store/sqlite.js";
import { TaskStateSchema, TaskSummarySchema } from "../../task/schema.js";
import type { TaskSummary } from "../../task/schema.js";
import { fitsCapacity } from "../capacity.js";
import { result } from "../result.js";

const InputSchema = z.object({
  agent: z.string().optional(),
  context_id: z.string().optional(),
  state: TaskStateSchema.optional(),
  limit: z.number().int().positive().optional(),
  cursor: z.string().optional(),
});

const OutputSchema = z.object({
  tasks: z.array(TaskSummarySchema),
  next_cursor: z.string().nullable(),
});

export interface ListTasksDeps {
  store: TaskStore;
}

/**
 * `list_tasks({ agent?, context_id?, state?, limit?, cursor? })` → 摘要頁
 * （不含 `final_text`）與 `next_cursor`。Store 已依 `limit`（上限 100、預設 50）
 * 給出下一頁 cursor；這裡再依 ADR-0005 逐筆檢查整個回應體是否還在 8 MiB 容量內，
 * 容量不夠時提前縮頁，把 `next_cursor` 改指向最後一筆真的回傳的 task，
 * 不截斷單筆摘要。至少回傳一筆，確保 cursor 一定往前走。
 */
export function registerListTasks(
  server: McpServer,
  deps: ListTasksDeps,
): void {
  server.registerTool(
    "list_tasks",
    {
      description: "列出歷史 Task 摘要並分頁",
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
    },
    ({ agent, context_id, state, limit, cursor }) => {
      const page = deps.store.listTasks({
        agent,
        context_id,
        state,
        limit,
        cursor,
      });

      const tasks: TaskSummary[] = [];
      let next_cursor: string | null = null;
      for (const task of page.tasks) {
        const candidate = [...tasks, task];
        const lastIncluded: TaskSummary | undefined = tasks[tasks.length - 1];
        if (
          lastIncluded &&
          !fitsCapacity({ tasks: candidate, next_cursor: null })
        ) {
          next_cursor = lastIncluded.task_id;
          break;
        }
        tasks.push(task);
      }
      if (next_cursor === null && tasks.length === page.tasks.length) {
        next_cursor = page.next_cursor;
      }

      return result({ tasks, next_cursor });
    },
  );
}
