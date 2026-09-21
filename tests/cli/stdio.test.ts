import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentToml,
  baseEnv,
  cleanupTempDirs,
  makeFakeExecutable,
  makeTempDir,
  makeWorkspace,
  writeConfigFile,
} from "../config/helpers.js";

const execFileAsync = promisify(execFile);

/** 假 `claude`：不看引數，吐最小的 stream-json（init + result）後 exit 0。 */
async function makeFakeClaude(dir: string): Promise<void> {
  const init = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "fake-session",
  });
  const result = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "fake done",
    session_id: "fake-session",
    usage: { input_tokens: 1, output_tokens: 1 },
    permission_denials: [],
  });
  await makeFakeExecutable(
    dir,
    "claude",
    `#!/bin/sh\necho '${init}'\necho '${result}'\nexit 0\n`,
  );
}
const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

afterEach(cleanupTempDirs);

describe("agentport stdio 子命令", () => {
  it("設定檔有錯誤時以 exit code 1 結束，不啟動 stdio 服務", async () => {
    const dir = await makeTempDir();
    const configPath = await writeConfigFile(dir, "agents = []\n");

    await expect(
      execFileAsync(
        process.execPath,
        [CLI_PATH, "stdio", "--config", configPath],
        {
          env: baseEnv({ HOME: dir }),
        },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("agents: agents[] 不可為空\n") as unknown,
    });
  });

  it("真的 spawn 子程序，透過 stdio 連線呼叫 list_agents / submit_task / get_task", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeClaude(dir);
    const dbPath = `${dir}/agentport.sqlite`;
    const logDir = `${dir}/logs`;
    const configPath = await writeConfigFile(
      dir,
      `${agentToml()}\n[storage]\ndb_path = "${dbPath}"\nlog_dir = "${logDir}"\n`,
    );
    const env = baseEnv({ HOME: dir, PATH: dir });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "stdio", "--config", configPath],
      env: env as Record<string, string>,
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);

    try {
      const listResponse = await client.callTool({
        name: "list_agents",
        arguments: {},
      });
      expect(listResponse.structuredContent).toEqual({
        agents: [
          { name: "stationhub", runtime: "claude", policy: "workspace-write" },
        ],
      });

      const submitResponse = await client.callTool({
        name: "submit_task",
        arguments: { agent: "stationhub", prompt: "hello" },
      });
      const { task_id: taskId } = submitResponse.structuredContent as {
        task_id: string;
      };

      let task: { state: string; final_text?: string | null } = {
        state: "queued",
      };
      const deadline = Date.now() + 5000;
      while (task.state === "queued" || task.state === "running") {
        if (Date.now() > deadline) {
          throw new Error(`get_task(${taskId}) 逾時仍未到終態`);
        }
        const getResponse = await client.callTool({
          name: "get_task",
          arguments: { task_id: taskId },
        });
        task = getResponse.structuredContent as typeof task;
        if (task.state === "queued" || task.state === "running") {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      // 假 claude 吐最小 stream-json：init + result，真實 stdio 路徑應走到 completed。
      expect(task.state).toBe("completed");
      expect(task.final_text).toBe("fake done");
    } finally {
      await client.close();
    }
  }, 10000);

  it("同一個 db_path 已被另一個 agentport stdio 程序占用時，第二個以 exit code 1 結束並印出鎖訊息", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeClaude(dir);
    const dbPath = `${dir}/agentport.sqlite`;
    const logDir = `${dir}/logs`;
    const configPath = await writeConfigFile(
      dir,
      `${agentToml()}\n[storage]\ndb_path = "${dbPath}"\nlog_dir = "${logDir}"\n`,
    );
    const env = baseEnv({ HOME: dir, PATH: dir });

    // 第一個程序：透過 stdio client 連上，讓它一直活著（不 close），佔住
    // single-instance 鎖。
    const firstTransport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "stdio", "--config", configPath],
      env: env as Record<string, string>,
    });
    const firstClient = new Client({ name: "test-client-1", version: "0.0.0" });
    await firstClient.connect(firstTransport);

    try {
      // 第二個程序指向同一個 db_path：createApp 裡的 single-instance 鎖應該
      // 讓它啟動失敗，不用等它真的把 stdio 服務起來。
      await expect(
        execFileAsync(
          process.execPath,
          [CLI_PATH, "stdio", "--config", configPath],
          { env },
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining(
          `另一個 agentport 程序正在使用 ${dbPath}`,
        ) as unknown,
      });
    } finally {
      await firstClient.close();
    }
  }, 10000);
});
