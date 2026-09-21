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

/** Turn 期間新增的一個 commit：git 摘要模組（`src/git/summary.ts`）輸出的形狀。 */
export const GitCommitSchema = z.object({
  sha: z.string(),
  subject: z.string(),
});

/**
 * `hints` 非權威附註：`permission_denied` 原樣轉交，`git` 記 git 摘要失敗原因，
 * `truncated` 記 `final_text` 是否因超過容量上限被截尾（ADR-0005）。
 */
export const HintsSchema = z.object({
  permission_denied: z.array(z.unknown()).optional(),
  git: z.string().optional(),
  truncated: z.boolean().optional(),
});

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
  commits: z.array(GitCommitSchema).nullable(),
  usage: z.record(z.string(), z.number()).nullable(),
  hints: HintsSchema.nullable(),
  error: z
    .object({ code: TaskErrorCodeSchema, message: z.string() })
    .nullable(),
  raw_log_path: z.string().nullable(),
});

/**
 * `list_tasks` 的摘要形狀：`TaskRecordSchema` 去掉 `prompt`、`final_text`、
 * `diff_stat`、`commits`、`usage`，避免單筆摘要就把回應體撐大（ADR-0005）。
 */
export const TaskSummarySchema = TaskRecordSchema.omit({
  prompt: true,
  final_text: true,
  diff_stat: true,
  commits: true,
  usage: true,
});

export type TaskState = z.infer<typeof TaskStateSchema>;
export type TaskErrorCode = z.infer<typeof TaskErrorCodeSchema>;
export type GitCommit = z.infer<typeof GitCommitSchema>;
export type Hints = z.infer<typeof HintsSchema>;
export type TaskRecord = z.infer<typeof TaskRecordSchema>;
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * `completed` / `failed` / `cancelled` 是終態，`queued` / `running` 不是。
 * `get_task` 的長輪詢、`cancel_task` 的終態判斷、scheduler 的 `cancel()` 都
 * 共用這個判斷，避免各處各自維護一份 state 集合。
 */
export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state);
}
