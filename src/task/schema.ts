import { z } from "zod";

export const TASK_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export const TASK_ERROR_CODES = [
  "runtime_failed",
  "session_unresumable",
  "interrupted",
  "cancelled",
  "timeout",
] as const;

export const TaskStateSchema = z.enum(TASK_STATES);
export const TaskErrorCodeSchema = z.enum(TASK_ERROR_CODES);

/**
 * Task 完整記錄的唯一定義來源：SQLite store 的回傳型別與 `get_task` 的
 * outputSchema 都 import 這裡，欄位只定義一次。
 */
export const TaskRecordSchema = z.object({
  task_id: z.string(),
  context_id: z.string(),
  agent: z.string(),
  caller: z.string(),
  prompt: z.string(),
  state: TaskStateSchema,
  created_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  final_text: z.string().nullable(),
  diff_stat: z.string().nullable(),
  commits: z.array(z.string()).nullable(),
  usage: z.record(z.string(), z.number()).nullable(),
  hints: z.record(z.string(), z.unknown()).nullable(),
  error: z
    .object({ code: TaskErrorCodeSchema, message: z.string() })
    .nullable(),
  raw_log_path: z.string().nullable(),
});

export type TaskState = z.infer<typeof TaskStateSchema>;
export type TaskErrorCode = z.infer<typeof TaskErrorCodeSchema>;
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
