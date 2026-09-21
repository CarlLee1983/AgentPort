import type { Policy, RuntimeName } from "../config/schema.js";

/** Driver 對外回報的六種事件；語意見 specs/agentport-v2.md「Runtime Driver」。 */
export type DriverEvent =
  | { type: "started"; runtime_session_id: string }
  | { type: "message"; text: string }
  | {
      type: "activity";
      kind: "command" | "file_change" | "tool";
      summary: string;
    }
  | { type: "permission_denied"; tool: string; input: unknown }
  | {
      type: "completed";
      final_text: string;
      usage: Record<string, number> | null;
    }
  | { type: "failed"; error: string; code?: "session_unresumable" };

export interface TurnInput {
  workspace: string;
  prompt: string;
  policy: Policy;
  extra_args: string[];
}

export interface Turn {
  events: AsyncIterable<DriverEvent>;
  kill(): void;
}

export interface TurnHooks {
  /** 收到一行原始 CLI 輸出（尚未映射成 DriverEvent）時呼叫；供寫進原始 JSONL log。 */
  onRawLine?(line: string): void;
}

export interface RuntimeDriver {
  start(input: TurnInput, hooks?: TurnHooks): Turn;
  resume(
    input: TurnInput & { runtime_session_id: string },
    hooks?: TurnHooks,
  ): Turn;
}

export type DriverRegistry = Record<RuntimeName, RuntimeDriver>;
