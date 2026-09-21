import { isRecord, numericUsage, truncate } from "../json.js";
import type { DriverEvent } from "../types.js";

/** `file_change.changes[]` 的路徑列表，逗號分隔，作為 activity 的人讀摘要。 */
function summarizeFileChange(changes: unknown): string {
  if (!Array.isArray(changes)) {
    return "";
  }
  return changes
    .map((change) =>
      isRecord(change) && typeof change.path === "string"
        ? change.path
        : String(change),
    )
    .join(", ");
}

/** 泛用 tool 類 item（`mcp_tool_call`、`collab_tool_call`、`web_search`、`todo_list`…）的摘要。 */
function summarizeTool(item: Record<string, unknown>): string {
  const rest = Object.fromEntries(
    Object.entries(item).filter(([key]) => key !== "type" && key !== "id"),
  );
  return truncate(`${String(item.type)}: ${JSON.stringify(rest)}`);
}

/** `item.completed` 依 item type 對映 activity；`agent_message` 另外處理，回傳 null 表示忽略。 */
function activityFromItem(item: Record<string, unknown>): DriverEvent | null {
  switch (item.type) {
    case "command_execution":
      return {
        type: "activity",
        kind: "command",
        summary: typeof item.command === "string" ? item.command : "",
      };
    case "file_change":
      return {
        type: "activity",
        kind: "file_change",
        summary: summarizeFileChange(item.changes),
      };
    case "agent_message":
    case "reasoning":
    case "error":
      return null;
    default:
      return {
        type: "activity",
        kind: "tool",
        summary: summarizeTool(item),
      };
  }
}

/** `turn.failed.error` 是 `{message}`；退回整個值的字串形式以防形狀不同。 */
function turnFailedMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

export interface CodexParser {
  /** 餵一行 stdout；回傳這一行對映出的事件（可能為空）。 */
  feed(line: string): DriverEvent[];
}

/**
 * `codex exec --json` 一行一個事件；對映到 AgentPort 的六種 `DriverEvent`。
 *
 * `turn.completed` 只帶 `usage`，`final_text` 要用本輪最後一則 `agent_message` 的文字
 * （research/codex-exec.md §1：「最後文字回覆」= 最後一個 agent_message item），因此需要
 * 跨行狀態，一次 Turn 用一個 `createCodexParser()` 實例。非 JSON 行忽略。
 */
export function createCodexParser(): CodexParser {
  let lastAgentMessage = "";

  function feed(line: string): DriverEvent[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isRecord(parsed)) {
      return [];
    }

    switch (parsed.type) {
      case "thread.started":
        return typeof parsed.thread_id === "string"
          ? [{ type: "started", runtime_session_id: parsed.thread_id }]
          : [];
      case "item.completed": {
        const item = parsed.item;
        if (!isRecord(item)) {
          return [];
        }
        if (item.type === "agent_message" && typeof item.text === "string") {
          lastAgentMessage = item.text;
          return [{ type: "message", text: item.text }];
        }
        const activity = activityFromItem(item);
        return activity ? [activity] : [];
      }
      case "turn.completed":
        return [
          {
            type: "completed",
            final_text: lastAgentMessage,
            usage: numericUsage(parsed.usage),
          },
        ];
      case "turn.failed":
        return [{ type: "failed", error: turnFailedMessage(parsed.error) }];
      default:
        return [];
    }
  }

  return { feed };
}
