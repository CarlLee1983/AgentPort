import { isRecord, numericUsage, truncate } from "../json.js";
import type { DriverEvent } from "../types.js";

interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

interface TextBlock {
  type: "text";
  text: string;
}

type ContentBlock = ToolUseBlock | TextBlock | { type: string };

/** tool_use 的 kind：Bash 算指令，Edit/Write/MultiEdit 算檔案變更，其餘算泛用工具。 */
function activityKind(toolName: string): "command" | "file_change" | "tool" {
  if (toolName === "Bash") {
    return "command";
  }
  if (toolName === "Edit" || toolName === "Write" || toolName === "MultiEdit") {
    return "file_change";
  }
  return "tool";
}

/** 工具名 + 簡短輸入，作為 activity 的人讀摘要。 */
function summarizeToolUse(toolName: string, input: unknown): string {
  if (isRecord(input)) {
    if (typeof input.command === "string") {
      return truncate(`${toolName}: ${input.command}`);
    }
    if (typeof input.file_path === "string") {
      return truncate(`${toolName}: ${input.file_path}`);
    }
  }
  return truncate(`${toolName}: ${JSON.stringify(input)}`);
}

function parseAssistantLine(message: unknown): DriverEvent[] {
  if (!isRecord(message)) {
    return [];
  }
  const content = message.content;
  if (!Array.isArray(content)) {
    return [];
  }
  const events: DriverEvent[] = [];
  for (const block of content as ContentBlock[]) {
    if (
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      events.push({ type: "message", text: block.text });
    } else if (
      block.type === "tool_use" &&
      "name" in block &&
      typeof block.name === "string"
    ) {
      events.push({
        type: "activity",
        kind: activityKind(block.name),
        summary: summarizeToolUse(block.name, block.input),
      });
    }
  }
  return events;
}

function resultErrorMessage(result: Record<string, unknown>): string {
  if (typeof result.result === "string" && result.result.length > 0) {
    return result.result;
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    return result.errors.map((error) => String(error)).join("; ");
  }
  return `claude result subtype ${String(result.subtype)}`;
}

/** `--resume` 一個不存在的 session id 時，`result.errors[]` 帶這句原始 API 錯誤文字。 */
function isSessionUnresumable(result: Record<string, unknown>): boolean {
  return (
    Array.isArray(result.errors) &&
    result.errors.some(
      (error) =>
        typeof error === "string" &&
        error.includes("No conversation found with session ID"),
    )
  );
}

function parseResultLine(result: Record<string, unknown>): DriverEvent[] {
  const events: DriverEvent[] = [];
  const denials = Array.isArray(result.permission_denials)
    ? result.permission_denials
    : [];
  for (const denial of denials) {
    if (!isRecord(denial) || typeof denial.tool_name !== "string") {
      continue;
    }
    events.push({
      type: "permission_denied",
      tool: denial.tool_name,
      input: denial.tool_input ?? null,
    });
  }
  if (result.is_error === true || result.subtype !== "success") {
    events.push(
      isSessionUnresumable(result)
        ? {
            type: "failed",
            error: "session not found",
            code: "session_unresumable",
          }
        : { type: "failed", error: resultErrorMessage(result) },
    );
  } else {
    events.push({
      type: "completed",
      final_text: typeof result.result === "string" ? result.result : "",
      usage: numericUsage(result.usage),
    });
  }
  return events;
}

export interface ClaudeParser {
  /** 餵一行 stdout；回傳這一行對映出的事件（可能為空）。 */
  feed(line: string): DriverEvent[];
}

/**
 * `claude -p --output-format stream-json` 一行一個事件；對映到 AgentPort 的六種
 * `DriverEvent`。非 JSON 行（不應出現，保險起見）忽略。
 *
 * `system/permission_denied` 本身不帶 tool_input（見
 * research/claude-headless.md §1.3），且 hook 攔截的拒絕根本不會出現這個事件；
 * `result.permission_denials[]` 才是每次都帶完整 `tool_input` 的來源，
 * 所以 permission_denied 只從 `result` 產生，避免同一次拒絕重複發兩個事件。
 *
 * 不需要跨行狀態，`createClaudeParser()` 只是為了跟 Codex 的 parser 同形
 * （`{ feed(line) }`），方便 `runTurn` 兩邊共用同一個介面。
 */
export function createClaudeParser(): ClaudeParser {
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

    if (parsed.type === "system" && parsed.subtype === "init") {
      return typeof parsed.session_id === "string"
        ? [{ type: "started", runtime_session_id: parsed.session_id }]
        : [];
    }
    if (parsed.type === "assistant") {
      return parseAssistantLine(parsed.message);
    }
    if (parsed.type === "result") {
      return parseResultLine(parsed);
    }
    return [];
  }

  return { feed };
}
