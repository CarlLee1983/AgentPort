import { describe, expect, it } from "vitest";

import { createCodexParser } from "../../../src/driver/codex/events.js";

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("createCodexParser", () => {
  it("忽略空行與非 JSON 行", () => {
    const parser = createCodexParser();
    expect(parser.feed("")).toEqual([]);
    expect(parser.feed("   ")).toEqual([]);
    expect(parser.feed("not json")).toEqual([]);
  });

  it("thread.started 對映 started", () => {
    const parser = createCodexParser();
    expect(
      parser.feed(json({ type: "thread.started", thread_id: "t1" })),
    ).toEqual([{ type: "started", runtime_session_id: "t1" }]);
  });

  it("item.completed/agent_message 對映 message", () => {
    const parser = createCodexParser();
    const events = parser.feed(
      json({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "hi there" },
      }),
    );
    expect(events).toEqual([{ type: "message", text: "hi there" }]);
  });

  it("item.completed/command_execution 對映 activity{kind: command}", () => {
    const parser = createCodexParser();
    const events = parser.feed(
      json({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "a.txt\n",
          exit_code: 0,
          status: "completed",
        },
      }),
    );
    expect(events).toEqual([
      { type: "activity", kind: "command", summary: "ls" },
    ]);
  });

  it("item.completed/file_change 對映 activity{kind: file_change}，摘要為路徑列表", () => {
    const parser = createCodexParser();
    const events = parser.feed(
      json({
        type: "item.completed",
        item: {
          id: "item_2",
          type: "file_change",
          changes: [
            { path: "/workspace/fixture/a.txt", kind: "add" },
            { path: "/workspace/fixture/b.txt", kind: "update" },
          ],
          status: "completed",
        },
      }),
    );
    expect(events).toEqual([
      {
        type: "activity",
        kind: "file_change",
        summary: "/workspace/fixture/a.txt, /workspace/fixture/b.txt",
      },
    ]);
  });

  it("其他 tool 類 item 對映 activity{kind: tool}", () => {
    const parser = createCodexParser();
    const events = parser.feed(
      json({
        type: "item.completed",
        item: {
          id: "item_3",
          type: "web_search",
          query: "agentport",
          status: "completed",
        },
      }),
    );
    expect(events).toEqual([
      {
        type: "activity",
        kind: "tool",
        summary: 'web_search: {"query":"agentport","status":"completed"}',
      },
    ]);
  });

  it("reasoning item 忽略", () => {
    const parser = createCodexParser();
    expect(
      parser.feed(
        json({
          type: "item.completed",
          item: { id: "item_4", type: "reasoning", text: "thinking..." },
        }),
      ),
    ).toEqual([]);
  });

  it("turn.completed 帶最後一則 agent_message 文字與 usage 數值欄位", () => {
    const parser = createCodexParser();
    parser.feed(
      json({
        type: "item.completed",
        item: { type: "agent_message", text: "first" },
      }),
    );
    parser.feed(
      json({
        type: "item.completed",
        item: { type: "agent_message", text: "second" },
      }),
    );
    const events = parser.feed(
      json({
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      }),
    );
    expect(events).toEqual([
      {
        type: "completed",
        final_text: "second",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      },
    ]);
  });

  it("turn.completed 前沒有任何 agent_message 時 final_text 為空字串", () => {
    const parser = createCodexParser();
    const events = parser.feed(json({ type: "turn.completed", usage: {} }));
    expect(events).toEqual([{ type: "completed", final_text: "", usage: {} }]);
  });

  it("turn.failed 對映 failed，取 error.message", () => {
    const parser = createCodexParser();
    const events = parser.feed(
      json({ type: "turn.failed", error: { message: "boom" } }),
    );
    expect(events).toEqual([{ type: "failed", error: "boom" }]);
  });

  it("未知 type 忽略（例如 turn.started、error）", () => {
    const parser = createCodexParser();
    expect(parser.feed(json({ type: "turn.started" }))).toEqual([]);
    expect(parser.feed(json({ type: "error", message: "noise" }))).toEqual([]);
  });
});
