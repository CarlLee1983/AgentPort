import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../../config/schema.js";
import type { Scheduler } from "../../scheduler.js";
import type { TaskStore } from "../../store/sqlite.js";
import { createAndEnqueue } from "./enqueue.js";
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
  config: Config;
  store: TaskStore;
  scheduler: Scheduler;
  caller: string;
}

/**
 * `follow_up({ context_id, prompt })` → 沿用既有 Context 建立新 Task 並排進佇列；
 * agent 取自 Context（caller 不可指定、不可換）。Context 不存在 → `not_found`；
 * Context 綁的 agent 已經不在目前設定檔內 → `unknown_agent`（沒有熱重載，但
 * 設定檔重啟後可能移除了某個 agent，殘留 Context 的 follow-up 要能明確拒絕）。
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

      const agentConfig = deps.config.agents.find(
        (candidate) => candidate.name === context.agent,
      );
      if (!agentConfig) {
        return toolError("unknown_agent", `未知 agent：${context.agent}`);
      }

      return result(
        createAndEnqueue(deps, {
          context_id: context.context_id,
          agent: context.agent,
          prompt,
        }),
      );
    },
  );
}
