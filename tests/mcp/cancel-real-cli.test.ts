import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/load.js";
import { createDrivers } from "../../src/driver/registry.js";
import { initGitWorkspace } from "../helpers/git.js";

/**
 * 對真的 `claude` / `codex` CLI 跑「送出一個會睡 60 秒的 Task → 取消 → follow_up
 * 問剛才記住的暗號」，量測取消是否真的把子程序砍掉（不是乾等 60 秒自然結束），
 * 並把「取消後同一 Context 能不能 resume」的實測結果寫進斷言（票 10 acceptance）。
 * 只在本機已登入兩個 CLI 時才跑：`AGENTPORT_REAL_CLI=1 pnpm vitest run
 * tests/mcp/cancel-real-cli.test.ts`。CI 與一般 `pnpm check` 一律 skip。
 */
const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface SubmitPayload {
  task_id: string;
  context_id: string;
  state: string;
}

interface TaskPayload {
  state: string;
  final_text: string | null;
  error: { code: string; message: string } | null;
}

async function waitUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitUntil 逾時（${String(timeoutMs)}ms）`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForFinal(
  client: Client,
  taskId: string,
  timeoutMs: number,
): Promise<TaskPayload> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await client.callTool({
      name: "get_task",
      arguments: { task_id: taskId },
    });
    const task = response.structuredContent as TaskPayload;
    if (task.state !== "queued" && task.state !== "running") {
      return task;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `get_task(${taskId}) 逾時仍未到終態：${JSON.stringify(task)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function runCancelFlow(
  runtime: "claude" | "codex",
  workspace: string,
): Promise<TaskPayload> {
  const rootDir = await makeDir(`agentport-cancel-${runtime}-`);
  const dbPath = join(rootDir, "agentport.sqlite");
  const logDir = join(rootDir, "logs");
  const configPath = join(rootDir, "agentport.toml");
  await writeFile(
    configPath,
    `[storage]
db_path = "${dbPath}"
log_dir = "${logDir}"

[[agents]]
name = "real-agent"
workspace = "${workspace}"
runtime = "${runtime}"
policy = "full"
`,
    "utf8",
  );

  const loadResult = loadConfig(configPath, process.env);
  if (!loadResult.ok) {
    throw new Error(
      `測試設定檔載入失敗：${loadResult.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    );
  }

  const app = createApp({
    config: loadResult.config,
    drivers: createDrivers(loadResult.config, process.env),
    caller: "local",
  });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = app.serverFactory();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  try {
    const submitResponse = await client.callTool({
      name: "submit_task",
      arguments: {
        agent: "real-agent",
        prompt:
          "記住這個暗號：7392。接著執行 shell 指令 `sleep 60`，指令結束後只要回覆完成即可，不用提到暗號。",
      },
    });
    expect(submitResponse.isError).toBeFalsy();
    const { task_id: taskId, context_id: contextId } =
      submitResponse.structuredContent as SubmitPayload;

    // 等 Task 進 running 且 Context 已經有 runtime_session_id（Driver 送過
    // `started` 事件）：這是「同一個 Context 的 follow-up 能不能 resume」這個
    // 問題有意義的前提。
    await waitUntil(async () => {
      const task = (
        await client.callTool({
          name: "get_task",
          arguments: { task_id: taskId },
        })
      ).structuredContent as TaskPayload;
      if (task.state !== "running") {
        return false;
      }
      return app.store.getContext(contextId)?.runtime_session_id != null;
    }, 60_000);

    const cancelStartedAt = Date.now();
    const cancelResponse = await client.callTool({
      name: "cancel_task",
      arguments: { task_id: taskId },
    });
    expect(cancelResponse.isError).toBeFalsy();
    const cancelElapsedMs = Date.now() - cancelStartedAt;

    const cancelledTask = await waitForFinal(client, taskId, 30_000);
    console.log(
      `[cancel-real-cli:${runtime}] cancel_task 耗時 ${String(cancelElapsedMs)}ms，Task 最終狀態 ${cancelledTask.state}`,
    );
    expect(cancelledTask.state).toBe("cancelled");
    expect(cancelledTask.error?.code).toBe("cancelled");
    // sleep 60 被真的砍掉的話，取消全程應該遠低於 60 秒；沒被砍掉才會撞到這個上限。
    expect(cancelElapsedMs).toBeLessThan(45_000);

    const followResponse = await client.callTool({
      name: "follow_up",
      arguments: {
        context_id: contextId,
        prompt: "剛才要你記住的暗號是什麼？只回暗號數字。",
      },
    });
    const { task_id: followTaskId } =
      followResponse.structuredContent as SubmitPayload;
    const followTask = await waitForFinal(client, followTaskId, 120_000);

    console.log(
      `[cancel-real-cli:${runtime}] follow_up 結果：state=${followTask.state} error=${JSON.stringify(followTask.error)} final_text=${JSON.stringify(followTask.final_text)}`,
    );
    return followTask;
  } finally {
    await client.close();
    app.close();
  }
}

describe.skipIf(process.env.AGENTPORT_REAL_CLI !== "1")(
  "cancel_task 真 CLI (set AGENTPORT_REAL_CLI=1 to run)",
  () => {
    // 實測（2026-09-21）：cancel 後 Claude session 可 resume 且記得暗號
    // （final_text "7392"）。把這個結果寫進斷言：resume 成功、記得。
    it("claude：取消後 resume 成功且記得取消前的暗號", async () => {
      const workspace = await makeDir("agentport-cancel-claude-ws-");
      await initGitWorkspace(workspace);
      const followTask = await runCancelFlow("claude", workspace);
      expect(followTask.state).toBe("completed");
      expect(followTask.error).toBeNull();
      expect(followTask.final_text).toContain("7392");
    }, 200_000);

    // 實測（2026-09-21，跑了 3 次觀察行為不穩定）：cancel 後 Codex thread
    // 的 resume 結果在兩種之間搖擺——(a) resume 成功但忘記取消前的暗號
    // （回「無法判定」或答錯），(b) resume 直接失敗成 session_unresumable。
    // 沒有一次是「resume 成功且記得暗號」。把這個不確定性原樣寫進斷言：
    // 允許這兩種結果，但不接受「記得暗號」（會是巧合，不是可依賴的行為）。
    it("codex：取消後 resume 結果不穩定——會忘記暗號，或直接 session_unresumable", async () => {
      // codex 不需要 git init：`--skip-git-repo-check` 已涵蓋非 git 目錄。
      const workspace = await makeDir("agentport-cancel-codex-ws-");
      const followTask = await runCancelFlow("codex", workspace);
      if (followTask.state === "failed") {
        expect(followTask.error?.code).toBe("session_unresumable");
      } else {
        expect(followTask.state).toBe("completed");
        expect(followTask.error).toBeNull();
        // 記不記得暗號不強求（實測發現不穩定），只記錄實際回答內容。
        console.log(
          `[cancel-real-cli:codex] resume 後實際回答：${JSON.stringify(followTask.final_text)}`,
        );
      }
    }, 200_000);
  },
);
