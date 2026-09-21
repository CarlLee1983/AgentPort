import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
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

/** 從 `serve` 子命令的 stdout 找出 `listening on <url>` 印出的 URL。 */
function waitForListeningUrl(
  stream: NodeJS.ReadableStream,
  timeoutMs = 5000,
): Promise<URL> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`逾時仍未看到 listening 訊息，stdout：${buffer}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const match = /listening on (\S+)/.exec(buffer);
      const url = match?.[1];
      if (url !== undefined) {
        clearTimeout(timer);
        stream.off("data", onData);
        resolve(new URL(url));
      }
    };
    stream.on("data", onData);
  });
}

describe("agentport serve 子命令", () => {
  it("callers[] 為空時以 exit code 1 結束，不啟動 HTTP 服務", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(dir, agentToml());

    await expect(
      execFileAsync(
        process.execPath,
        [CLI_PATH, "serve", "--config", configPath],
        { env: baseEnv({ HOME: dir, PATH: dir }) },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("callers[] 不可為空") as unknown,
    });
  });

  it("正常設定時啟動 HTTP 服務，可打 list_agents，SIGTERM 後正常結束", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const dbPath = `${dir}/agentport.sqlite`;
    const logDir = `${dir}/logs`;
    const configPath = await writeConfigFile(
      dir,
      `${agentToml()}\n[[callers]]\nname = "grok"\ntoken_env = "AGENTPORT_TOKEN_GROK"\n\n[server]\nlisten = "127.0.0.1:0"\n\n[storage]\ndb_path = "${dbPath}"\nlog_dir = "${logDir}"\n`,
    );

    const child = spawn(
      process.execPath,
      [CLI_PATH, "serve", "--config", configPath],
      {
        env: baseEnv({
          HOME: dir,
          PATH: dir,
          AGENTPORT_TOKEN_GROK: "secret-1",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      const url = await waitForListeningUrl(child.stdout);

      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: "Bearer secret-1" } },
      });
      const client = new Client({ name: "test-client", version: "0.0.0" });
      await client.connect(transport);
      try {
        const response = await client.callTool({
          name: "list_agents",
          arguments: {},
        });
        expect(response.isError).toBeFalsy();
      } finally {
        await client.close();
      }

      const exitPromise = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => {
          resolve(code);
        });
      });
      child.kill("SIGTERM");
      const exitCode = await exitPromise;
      expect(exitCode).toBe(0);
    } catch (error) {
      child.kill("SIGKILL");
      throw new Error(`stderr: ${stderr}`, { cause: error });
    }
  }, 10000);
});
