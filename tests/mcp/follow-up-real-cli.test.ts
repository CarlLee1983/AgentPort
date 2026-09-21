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
 * 對真的 `claude` / `codex` CLI 跑 submit_task → follow_up 的完整 MCP 流程，驗證
 * follow-up 真的沿用同一個 Runtime Session（第二輪記得第一輪寫了什麼檔案）。只在
 * 本機已登入兩個 CLI 時才跑：`AGENTPORT_REAL_CLI=1 pnpm vitest run
 * tests/mcp/follow-up-real-cli.test.ts`。CI 與一般 `pnpm check` 一律 skip。
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

async function waitForFinal(
  client: Client,
  taskId: string,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await client.callTool({
      name: "get_task",
      arguments: { task_id: taskId },
    });
    const task = response.structuredContent as Record<string, unknown>;
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

async function runFollowUpFlow(
  runtime: "claude" | "codex",
  workspace: string,
): Promise<void> {
  const rootDir = await makeDir(`agentport-followup-${runtime}-`);
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
policy = "workspace-write"
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
        prompt: "在 docs/hello.txt 寫入 hi 並回覆 done",
      },
    });
    expect(submitResponse.isError).toBeFalsy();
    const { task_id: firstTaskId, context_id: contextId } =
      submitResponse.structuredContent as SubmitPayload;

    const firstTask = await waitForFinal(client, firstTaskId);
    expect(firstTask.state).toBe("completed");

    const followResponse = await client.callTool({
      name: "follow_up",
      arguments: {
        context_id: contextId,
        prompt: "剛才寫了什麼檔案？只回檔名",
      },
    });
    expect(followResponse.isError).toBeFalsy();
    const { task_id: secondTaskId } =
      followResponse.structuredContent as SubmitPayload;

    const secondTask = await waitForFinal(client, secondTaskId);
    expect(secondTask.state).toBe("completed");
    expect(secondTask.final_text as string).toContain("hello");
  } finally {
    await client.close();
    app.close();
  }
}

describe.skipIf(process.env.AGENTPORT_REAL_CLI !== "1")(
  "follow_up 真 CLI (set AGENTPORT_REAL_CLI=1 to run)",
  () => {
    it("claude：submit_task 寫檔完成後 follow_up 記得剛才寫的檔案", async () => {
      const workspace = await makeDir("agentport-followup-claude-ws-");
      await initGitWorkspace(workspace);
      await runFollowUpFlow("claude", workspace);
    }, 180_000);

    it("codex：submit_task 寫檔完成後 follow_up 記得剛才寫的檔案", async () => {
      // codex 不需要 git init：`--skip-git-repo-check` 已涵蓋非 git 目錄。
      const workspace = await makeDir("agentport-followup-codex-ws-");
      await runFollowUpFlow("codex", workspace);
    }, 180_000);
  },
);
