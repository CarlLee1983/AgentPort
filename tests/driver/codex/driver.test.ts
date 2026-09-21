import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createCodexDriver } from "../../../src/driver/codex/driver.js";
import type { DriverEvent } from "../../../src/driver/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/codex",
);
const replayScript = path.join(fixturesDir, "replay.mjs");

async function collect(
  events: AsyncIterable<DriverEvent>,
): Promise<DriverEvent[]> {
  const seen: DriverEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

/**
 * fixture 回放不能走 `createCodexDriver` 真正的 `buildCodexArgs`：那組引數第一個是
 * `exec`，若把 replay.mjs 的路徑當 command 交給 `node` 執行，node 會把 `exec` 當成
 * 要載入的腳本檔名。所以改用環境變數告訴 replay.mjs 要印哪份 fixture、用什麼退出碼、
 * 附加什麼 stderr，`command` 指到 replay.mjs 本身（node shebang），與
 * tests/fixtures/claude/replay.mjs 同款式。
 */
function driverForFixture(
  fixtureName: string,
  options: { exitCode?: number; stderr?: string } = {},
) {
  return createCodexDriver({
    command: replayScript,
    env: {
      ...process.env,
      AGENTPORT_TEST_FIXTURE: path.join(fixturesDir, fixtureName),
      ...(options.exitCode !== undefined
        ? { AGENTPORT_TEST_EXIT_CODE: String(options.exitCode) }
        : {}),
      ...(options.stderr !== undefined
        ? { AGENTPORT_TEST_STDERR: options.stderr }
        : {}),
    },
  });
}

const turnInput = {
  workspace: process.cwd(),
  prompt: "hi",
  policy: "workspace-write" as const,
  extra_args: [],
};

describe("createCodexDriver", () => {
  it("成功一輪含 file_change：started 帶 thread id、activity{file_change}、completed", async () => {
    const driver = driverForFixture("success.jsonl");
    const events = await collect(driver.start(turnInput).events);

    expect(events[0]).toEqual({
      type: "started",
      runtime_session_id: "01a0c201-7cd4-7890-ad53-b6a102ed4ca7",
    });
    expect(events).toContainEqual({
      type: "activity",
      kind: "file_change",
      summary: "/workspace/fixture/note.txt",
    });
    const last = events.at(-1);
    expect(last?.type).toBe("completed");
    expect(last?.type === "completed" ? last.final_text : "").toContain(
      "note.txt",
    );
  });

  it("含 command_execution 的一輪：activity{kind: command}", async () => {
    const driver = driverForFixture("command-execution.jsonl");
    const events = await collect(driver.start(turnInput).events);

    expect(events).toContainEqual({
      type: "activity",
      kind: "command",
      summary: "/bin/zsh -lc ls",
    });
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });

  it("turn.failed：對映 failed，取原始 API 錯誤文字", async () => {
    const driver = driverForFixture("turn-failed.jsonl", { exitCode: 1 });
    const events = await collect(
      driver.resume({
        ...turnInput,
        runtime_session_id: "01a0c202-28d5-7791-bcd8-a87ecfec6aa9",
      }).events,
    );

    expect(events.at(-1)).toMatchObject({ type: "failed" });
    expect((events.at(-1) as { error: string }).error).toContain(
      "no-such-model-xyz",
    );
  });

  it("resume 不存在的 thread id：exit 1 且無任何 JSONL 時，stderr 含 'no rollout found for thread id' 對映 session_unresumable", async () => {
    const stderr =
      "Error: thread/resume: thread/resume failed: no rollout found for thread id 00000000-0000-0000-0000-000000000000 (code -32600)";
    const driver = driverForFixture("resume-not-found.jsonl", {
      exitCode: 1,
      stderr,
    });
    const rawLines: string[] = [];
    const events = await collect(
      driver.resume(
        {
          ...turnInput,
          runtime_session_id: "00000000-0000-0000-0000-000000000000",
        },
        { onRawLine: (line) => rawLines.push(line) },
      ).events,
    );

    expect(events).toEqual([
      {
        type: "failed",
        error: "session not found",
        code: "session_unresumable",
      },
    ]);
    // stderr 尾端不進 caller 看到的 error，改由 onRawLine 寫進原始 log。
    expect(rawLines).toEqual([
      JSON.stringify({ type: "stderr", text: stderr }),
    ]);
  });

  it("子程序結束但沒有任何終態事件時，回報定型的 failed 訊息", async () => {
    // 不設 AGENTPORT_TEST_FIXTURE：replay.mjs 什麼都不印，正常結束（exit 0）。
    const driver = createCodexDriver({
      command: replayScript,
      env: { ...process.env, AGENTPORT_TEST_FIXTURE: "" },
    });
    const events = await collect(driver.start(turnInput).events);

    expect(events).toEqual([
      { type: "failed", error: "codex exited with code 0" },
    ]);
  });

  it("spawn 失敗（ENOENT）時回報 failed", async () => {
    const driver = createCodexDriver({
      command: "/nonexistent/codex-binary",
      env: process.env,
    });
    const events = await collect(driver.start(turnInput).events);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "failed" });
    expect((events[0] as { error: string }).error).toContain("ENOENT");
  });
});
