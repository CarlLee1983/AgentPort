import { describe, expect, it } from "vitest";

import { createClaudeParser } from "../../../src/driver/claude/events.js";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function feed(line: string) {
  return createClaudeParser().feed(line);
}

describe("createClaudeParser", () => {
  it("忽略空行", () => {
    expect(feed("")).toEqual([]);
    expect(feed("   ")).toEqual([]);
  });

  it("忽略非 JSON 行", () => {
    expect(feed("not json")).toEqual([]);
  });

  it("忽略 system/init 以外的 system 事件", () => {
    expect(feed(json({ type: "system", subtype: "hook_started" }))).toEqual([]);
    expect(
      feed(
        json({
          type: "system",
          subtype: "permission_denied",
          tool_name: "Bash",
        }),
      ),
    ).toEqual([]);
  });

  it("system/init 對映 started", () => {
    expect(
      feed(json({ type: "system", subtype: "init", session_id: "sid-1" })),
    ).toEqual([{ type: "started", runtime_session_id: "sid-1" }]);
  });

  it("assistant text block 對映 message", () => {
    expect(
      feed(
        json({
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        }),
      ),
    ).toEqual([{ type: "message", text: "done" }]);
  });

  it("assistant Bash tool_use 對映 activity{kind: command}", () => {
    const events = feed(
      json({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "touch a.txt" },
            },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { type: "activity", kind: "command", summary: "Bash: touch a.txt" },
    ]);
  });

  it("assistant Write tool_use 對映 activity{kind: file_change}", () => {
    const events = feed(
      json({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Write",
              input: { file_path: "/tmp/a.txt", content: "hi" },
            },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { type: "activity", kind: "file_change", summary: "Write: /tmp/a.txt" },
    ]);
  });

  it("其他工具對映 activity{kind: tool}", () => {
    const events = feed(
      json({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "WebSearch", input: { query: "x" } },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { type: "activity", kind: "tool", summary: 'WebSearch: {"query":"x"}' },
    ]);
  });

  it("忽略 thinking block", () => {
    expect(
      feed(
        json({
          type: "assistant",
          message: { content: [{ type: "thinking", thinking: "..." }] },
        }),
      ),
    ).toEqual([]);
  });

  it("result 成功對映 completed，usage 只留數值欄位", () => {
    const events = feed(
      json({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        usage: { input_tokens: 3, output_tokens: 5, service_tier: "standard" },
        permission_denials: [],
      }),
    );
    expect(events).toEqual([
      {
        type: "completed",
        final_text: "done",
        usage: { input_tokens: 3, output_tokens: 5 },
      },
    ]);
  });

  it("result is_error 對映 failed（即使 subtype 是 success）", () => {
    const events = feed(
      json({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in · Please run /login",
        permission_denials: [],
      }),
    );
    expect(events).toEqual([
      { type: "failed", error: "Not logged in · Please run /login" },
    ]);
  });

  it("result subtype 非 success 對映 failed，result 為 null 時退回 errors[]（非 session 相關）", () => {
    const events = feed(
      json({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: null,
        errors: ["some other API error"],
        permission_denials: [],
      }),
    );
    expect(events).toEqual([{ type: "failed", error: "some other API error" }]);
  });

  it("errors[] 含 'No conversation found with session ID' 時 code 為 session_unresumable，error 是定型句", () => {
    const events = feed(
      json({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: null,
        errors: [
          "No conversation found with session ID: 00000000-0000-0000-0000-000000000000",
        ],
        permission_denials: [],
      }),
    );
    expect(events).toEqual([
      {
        type: "failed",
        error: "session not found",
        code: "session_unresumable",
      },
    ]);
  });

  it("result.permission_denials[] 對映 permission_denied（帶 tool_input）", () => {
    const events = feed(
      json({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ok",
        usage: {},
        permission_denials: [
          {
            tool_name: "Bash",
            tool_use_id: "t1",
            tool_input: { command: "touch x" },
          },
        ],
      }),
    );
    expect(events).toEqual([
      {
        type: "permission_denied",
        tool: "Bash",
        input: { command: "touch x" },
      },
      { type: "completed", final_text: "ok", usage: {} },
    ]);
  });
});
