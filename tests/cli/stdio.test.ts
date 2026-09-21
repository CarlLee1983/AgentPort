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
    await makeFakeExecutable(dir, "claude");
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

      let task: { state: string; error?: { code: string } } = {
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

      // 真 Driver 還沒做（票 04/05），這張票的假 Driver 立即回 failed。
      expect(task.state).toBe("failed");
      expect(task.error?.code).toBe("runtime_failed");
    } finally {
      await client.close();
    }
  }, 10000);
});
