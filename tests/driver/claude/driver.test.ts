import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createClaudeDriver } from "../../../src/driver/claude/driver.js";
import type { DriverEvent, TurnHooks } from "../../../src/driver/types.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/claude",
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
 * fixture 回放不能走 `createClaudeDriver` 真正的 buildClaudeArgs：那組引數第一個是
 * `-p`，若把 replay.mjs 的路徑當 command 交給 node 執行，argv 會被 node 自己的
 * `-p`/`--print` 搶走語意。所以改用環境變數告訴 replay.mjs 要印哪份 fixture、
 * 用什麼退出碼、附加什麼 stderr，`command` 指到 replay.mjs 本身（node shebang）。
 */
function driverForFixture(
  fixtureName: string,
  options: { exitCode?: number; stderr?: string } = {},
) {
  return createClaudeDriver({
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

describe("createClaudeDriver", () => {
  it("成功一輪：started 帶 session id、completed 帶 final_text 與 usage；原始行透過 hooks.onRawLine 送出", async () => {
    const driver = driverForFixture("success.jsonl");
    const rawLines: string[] = [];
    const hooks: TurnHooks = { onRawLine: (line) => rawLines.push(line) };
    const events = await collect(driver.start(turnInput, hooks).events);

    expect(rawLines.length).toBeGreaterThan(0);
    expect(JSON.parse(rawLines[0] as string)).toMatchObject({
      type: "system",
      subtype: "hook_started",
    });

    expect(events[0]).toEqual({
      type: "started",
      runtime_session_id: "4c76d20c-9da3-4c9f-bdb9-85b4b2ccf6fa",
    });
    const completed = events.find((event) => event.type === "completed");
    expect(completed).toMatchObject({
      type: "completed",
      final_text: expect.stringContaining("hello.txt") as unknown,
    });
    // Write 被 hook 擋下，只在 result.permission_denials[] 出現，沒有獨立事件。
    const denied = events.find((event) => event.type === "permission_denied");
    expect(denied).toEqual({
      type: "permission_denied",
      tool: "Write",
      input: expect.objectContaining({
        file_path: expect.stringContaining("hello.txt") as unknown,
      }) as unknown,
    });
  });

  it("permission_denied：真正的 system/permission_denied 加上 result.permission_denials[]", async () => {
    const driver = driverForFixture("permission-denied.jsonl");
    const events = await collect(driver.start(turnInput).events);

    expect(events[0]).toEqual({
      type: "started",
      runtime_session_id: "379c1be8-0570-4a29-b01b-68034b1464bc",
    });
    const denials = events.filter(
      (event) => event.type === "permission_denied",
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]).toEqual({
      type: "permission_denied",
      tool: "Bash",
      input: expect.objectContaining({
        command: "touch denied.txt",
      }) as unknown,
    });
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });

  it("failed：result.is_error 且 errors[] 含 'No conversation found with session ID' 時 code 為 session_unresumable", async () => {
    const driver = driverForFixture("resume-not-found.jsonl");
    const events = await collect(
      driver.resume({
        ...turnInput,
        runtime_session_id: "00000000-0000-0000-0000-000000000000",
      }).events,
    );

    expect(events).toEqual([
      {
        type: "failed",
        error: "session not found",
        code: "session_unresumable",
      },
    ]);
  });

  it("子程序結束但沒有任何終態事件時，回報 failed", async () => {
    // 不設 AGENTPORT_TEST_FIXTURE：replay.mjs 什麼都不印，正常結束（exit 0）。
    const driver = createClaudeDriver({
      command: replayScript,
      env: { ...process.env, AGENTPORT_TEST_FIXTURE: "" },
    });
    const events = await collect(driver.start(turnInput).events);

    expect(events).toEqual([
      { type: "failed", error: "claude exited with code 0" },
    ]);
  });

  it("子程序非 0 結束時，failed 訊息是定型句，stderr 尾端改由 onRawLine 寫進原始 log", async () => {
    const driver = createClaudeDriver({
      command: replayScript,
      env: {
        ...process.env,
        AGENTPORT_TEST_FIXTURE: "",
        AGENTPORT_TEST_EXIT_CODE: "1",
        AGENTPORT_TEST_STDERR: "boom: something went wrong",
      },
    });
    const rawLines: string[] = [];
    const events = await collect(
      driver.start(turnInput, { onRawLine: (line) => rawLines.push(line) })
        .events,
    );

    expect(events).toEqual([
      { type: "failed", error: "claude exited with code 1" },
    ]);
    expect(rawLines).toEqual([
      JSON.stringify({ type: "stderr", text: "boom: something went wrong" }),
    ]);
  });

  it("spawn 失敗（指令不存在）時回報 failed", async () => {
    const driver = createClaudeDriver({
      command: "/nonexistent/claude-binary",
      env: process.env,
    });
    const events = await collect(driver.start(turnInput).events);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "failed" });
    expect((events[0] as { error: string }).error).toContain("ENOENT");
  });
});
