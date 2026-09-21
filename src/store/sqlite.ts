import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";
import { monotonicFactory } from "ulid";

import type {
  GitCommit,
  TaskErrorCode,
  TaskRecord,
  TaskState,
  TaskSummary,
} from "../task/schema.js";

export type { TaskRecord, TaskState } from "../task/schema.js";

export interface ContextRecord {
  context_id: string;
  agent: string;
  runtime_session_id: string | null;
  created_at: string;
}

export interface CreateTaskInput {
  context_id: string;
  agent: string;
  caller: string;
  prompt: string;
}

export interface MarkCompletedInput {
  final_text: string;
  usage: Record<string, number> | null;
  diff_stat?: string | null | undefined;
  commits?: GitCommit[] | null | undefined;
  hints?: Record<string, unknown> | undefined;
}

export interface MarkFailedInput {
  code: TaskErrorCode;
  message: string;
  hints?: Record<string, unknown> | undefined;
}

export interface ListTasksInput {
  agent?: string | undefined;
  context_id?: string | undefined;
  state?: TaskState | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface ListTasksResult {
  tasks: TaskSummary[];
  next_cursor: string | null;
}

const LIST_TASKS_DEFAULT_LIMIT = 50;
const LIST_TASKS_MAX_LIMIT = 100;

export interface TaskStore {
  createContext(agent: string): ContextRecord;
  createTask(input: CreateTaskInput): TaskRecord;
  getTask(taskId: string): TaskRecord | undefined;
  getContext(contextId: string): ContextRecord | undefined;
  listTasks(input: ListTasksInput): ListTasksResult;
  markRunning(taskId: string, rawLogPath: string): void;
  setRuntimeSession(contextId: string, runtimeSessionId: string): void;
  markCompleted(taskId: string, input: MarkCompletedInput): void;
  markFailed(taskId: string, input: MarkFailedInput): void;
  close(): void;
}

interface TaskRow {
  task_id: string;
  context_id: string;
  agent: string;
  caller: string;
  prompt: string;
  state: TaskState;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  final_text: string | null;
  diff_stat: string | null;
  commits: string | null;
  usage: string | null;
  hints: string | null;
  error_code: string | null;
  error_message: string | null;
  raw_log_path: string | null;
}

interface ContextRow {
  context_id: string;
  agent: string;
  runtime_session_id: string | null;
  created_at: string;
}

/**
 * 打開（並在需要時建立）SQLite Task Store；WAL 模式，schema 用 `CREATE TABLE IF NOT EXISTS`。
 * `dbPath` 所在的目錄不存在時先建立（設定檔預設路徑指向尚未存在的巢狀目錄）。
 */
export function openTaskStore(dbPath: string): TaskStore {
  // 用 monotonicFactory 而不是裸 `ulid()`：同一毫秒內連續呼叫時，一般 ulid 只保證
  // 時間戳部分遞增、隨機尾碼不保證順序；monotonic 版在同一毫秒內把尾碼加一，讓
  // `task_id` / `context_id` 全域嚴格遞增，`listTasks` 才能拿它當可靠的分頁 cursor
  // 與時間排序鍵（見下方 `ORDER BY task_id DESC`）。
  const ulid = monotonicFactory();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS contexts (
      context_id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      runtime_session_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      caller TEXT NOT NULL,
      prompt TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      final_text TEXT,
      diff_stat TEXT,
      commits TEXT,
      usage TEXT,
      hints TEXT,
      error_code TEXT,
      error_message TEXT,
      raw_log_path TEXT
    );
  `);

  const insertContext = db.prepare(
    `INSERT INTO contexts (context_id, agent, runtime_session_id, created_at)
     VALUES (@context_id, @agent, NULL, @created_at)`,
  );
  const insertTask = db.prepare(
    `INSERT INTO tasks (
       task_id, context_id, agent, caller, prompt, state, created_at
     ) VALUES (@task_id, @context_id, @agent, @caller, @prompt, 'queued', @created_at)`,
  );
  const selectTask = db.prepare(`SELECT * FROM tasks WHERE task_id = ?`);
  const selectContext = db.prepare(
    `SELECT * FROM contexts WHERE context_id = ?`,
  );
  const updateMarkRunning = db.prepare(
    `UPDATE tasks SET state = 'running', started_at = @started_at, raw_log_path = @raw_log_path WHERE task_id = @task_id`,
  );
  const updateRuntimeSession = db.prepare(
    `UPDATE contexts SET runtime_session_id = @runtime_session_id WHERE context_id = @context_id`,
  );
  const updateMarkCompleted = db.prepare(
    `UPDATE tasks SET state = 'completed', finished_at = @finished_at, final_text = @final_text, diff_stat = @diff_stat, commits = @commits, usage = @usage, hints = @hints WHERE task_id = @task_id`,
  );
  const updateMarkFailed = db.prepare(
    `UPDATE tasks SET state = 'failed', finished_at = @finished_at, error_code = @error_code, error_message = @error_message, hints = @hints WHERE task_id = @task_id`,
  );

  function rowToTask(row: TaskRow): TaskRecord {
    return {
      task_id: row.task_id,
      context_id: row.context_id,
      agent: row.agent,
      caller: row.caller,
      prompt: row.prompt,
      state: row.state,
      created_at: row.created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      final_text: row.final_text,
      diff_stat: row.diff_stat,
      commits: row.commits ? (JSON.parse(row.commits) as GitCommit[]) : null,
      usage: row.usage
        ? (JSON.parse(row.usage) as Record<string, number>)
        : null,
      hints: row.hints
        ? (JSON.parse(row.hints) as Record<string, unknown>)
        : null,
      error:
        row.error_code !== null
          ? {
              code: row.error_code as TaskErrorCode,
              message: row.error_message ?? "",
            }
          : null,
      raw_log_path: row.raw_log_path,
    };
  }

  /** `list_tasks` 摘要：不含 `prompt`、`final_text`、`diff_stat`、`commits`、`usage`。 */
  function rowToSummary(row: TaskRow): TaskSummary {
    return {
      task_id: row.task_id,
      context_id: row.context_id,
      agent: row.agent,
      caller: row.caller,
      state: row.state,
      created_at: row.created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      hints: row.hints
        ? (JSON.parse(row.hints) as Record<string, unknown>)
        : null,
      error:
        row.error_code !== null
          ? {
              code: row.error_code as TaskErrorCode,
              message: row.error_message ?? "",
            }
          : null,
      raw_log_path: row.raw_log_path,
    };
  }

  function rowToContext(row: ContextRow): ContextRecord {
    return {
      context_id: row.context_id,
      agent: row.agent,
      runtime_session_id: row.runtime_session_id,
      created_at: row.created_at,
    };
  }

  return {
    createContext(agent) {
      const context_id = ulid();
      const created_at = new Date().toISOString();
      insertContext.run({ context_id, agent, created_at });
      return { context_id, agent, runtime_session_id: null, created_at };
    },

    createTask(input) {
      const task_id = ulid();
      const created_at = new Date().toISOString();
      insertTask.run({ task_id, created_at, ...input });
      return {
        task_id,
        context_id: input.context_id,
        agent: input.agent,
        caller: input.caller,
        prompt: input.prompt,
        state: "queued",
        created_at,
        started_at: null,
        finished_at: null,
        final_text: null,
        diff_stat: null,
        commits: null,
        usage: null,
        hints: null,
        error: null,
        raw_log_path: null,
      };
    },

    getTask(taskId) {
      const row = selectTask.get(taskId) as TaskRow | undefined;
      return row ? rowToTask(row) : undefined;
    },

    getContext(contextId) {
      const row = selectContext.get(contextId) as ContextRow | undefined;
      return row ? rowToContext(row) : undefined;
    },

    listTasks(input) {
      const limit = Math.min(
        input.limit ?? LIST_TASKS_DEFAULT_LIMIT,
        LIST_TASKS_MAX_LIMIT,
      );
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (input.agent !== undefined) {
        clauses.push("agent = @agent");
        params.agent = input.agent;
      }
      if (input.context_id !== undefined) {
        clauses.push("context_id = @context_id");
        params.context_id = input.context_id;
      }
      if (input.state !== undefined) {
        clauses.push("state = @state");
        params.state = input.state;
      }
      if (input.cursor !== undefined) {
        clauses.push("task_id < @cursor");
        params.cursor = input.cursor;
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      // `task_id` 是 monotonic ulid，字典序即建立順序，`ORDER BY task_id DESC`
      // 等同「最新建立的排最前面」；`cursor` 用 `task_id < @cursor` 取下一頁，
      // 靠的正是這個嚴格遞增保證（同一毫秒建立的兩筆也不會有 cursor 卡住或跳過的問題）。
      // 多拿一筆判斷是否還有下一頁，取回後丟掉。
      const rows = db
        .prepare(
          `SELECT * FROM tasks ${where} ORDER BY task_id DESC LIMIT @limit`,
        )
        .all({ ...params, limit: limit + 1 }) as TaskRow[];
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const lastRow: TaskRow | undefined = page[page.length - 1];
      return {
        tasks: page.map(rowToSummary),
        next_cursor: hasMore && lastRow ? lastRow.task_id : null,
      };
    },

    markRunning(taskId, rawLogPath) {
      updateMarkRunning.run({
        task_id: taskId,
        started_at: new Date().toISOString(),
        raw_log_path: rawLogPath,
      });
    },

    setRuntimeSession(contextId, runtimeSessionId) {
      updateRuntimeSession.run({
        context_id: contextId,
        runtime_session_id: runtimeSessionId,
      });
    },

    markCompleted(taskId, input) {
      updateMarkCompleted.run({
        task_id: taskId,
        finished_at: new Date().toISOString(),
        final_text: input.final_text,
        diff_stat: input.diff_stat ?? null,
        commits: input.commits ? JSON.stringify(input.commits) : null,
        usage: input.usage ? JSON.stringify(input.usage) : null,
        hints: input.hints ? JSON.stringify(input.hints) : null,
      });
    },

    markFailed(taskId, input) {
      updateMarkFailed.run({
        task_id: taskId,
        finished_at: new Date().toISOString(),
        error_code: input.code,
        error_message: input.message,
        hints: input.hints ? JSON.stringify(input.hints) : null,
      });
    },

    close() {
      db.close();
    },
  };
}
