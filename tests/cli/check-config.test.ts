import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

describe("agentport check-config 子命令", () => {
  it("設定有效時印出 agent 表並以 exit code 0 結束", async () => {
    const dir = await makeTempDir();
    await makeWorkspace(dir, "workspace");
    await makeFakeExecutable(dir, "claude");
    const configPath = await writeConfigFile(dir, agentToml());

    const { stdout } = await execFileAsync(
      process.execPath,
      [CLI_PATH, "check-config", "--config", configPath],
      { env: baseEnv({ HOME: dir, PATH: dir }) },
    );

    expect(stdout).toContain("stationhub");
    expect(stdout).toContain("claude");
    expect(stdout).toContain("workspace-write");
  });

  it("設定有錯誤時每行輸出一個 path: message 到 stderr 並以 exit code 1 結束", async () => {
    const dir = await makeTempDir();
    const configPath = await writeConfigFile(dir, "agents = []\n");

    await expect(
      execFileAsync(
        process.execPath,
        [CLI_PATH, "check-config", "--config", configPath],
        { env: baseEnv({ HOME: dir }) },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("agents: agents[] 不可為空\n") as unknown,
    });
  });

  it("--config 缺值時印用法到 stderr 並以 exit code 2 結束", async () => {
    await expect(
      execFileAsync(process.execPath, [CLI_PATH, "check-config", "--config"], {
        env: baseEnv(),
      }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        "usage: agentport check-config [--config <path>]",
      ) as unknown,
    });
  });

  it("未知旗標時印用法到 stderr 並以 exit code 2 結束", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        [CLI_PATH, "check-config", "--unknown-flag"],
        { env: baseEnv() },
      ),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        "usage: agentport check-config [--config <path>]",
      ) as unknown,
    });
  });

  it("未知子命令時印用法到 stderr 並以 exit code 2 結束", async () => {
    await expect(
      execFileAsync(process.execPath, [CLI_PATH, "no-such-command"], {
        env: baseEnv(),
      }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        "usage: agentport check-config [--config <path>]",
      ) as unknown,
    });
  });
});
