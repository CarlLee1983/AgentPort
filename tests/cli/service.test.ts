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

describe("agentport service 子命令", () => {
  it("建置產物的 install --dry-run 路由到 service 並印出 LaunchAgent label", async () => {
    const home = await makeTempDir();
    await makeWorkspace(home, "workspace");
    await makeFakeExecutable(home, "claude");
    const configPath = await writeConfigFile(home, agentToml());

    const { stdout } = await execFileAsync(
      process.execPath,
      [CLI_PATH, "service", "install", "--dry-run", "--config", configPath],
      { env: baseEnv({ HOME: home, PATH: home }) },
    );

    expect(stdout).toContain("com.agentport.serve");
  });

  it("未知 service 子命令印用法到 stderr 並以 exit code 2 結束", async () => {
    await expect(
      execFileAsync(process.execPath, [CLI_PATH, "service", "unknown"], {
        env: baseEnv(),
      }),
    ).rejects.toMatchObject({
      code: 2,
      stdout: "",
      stderr: expect.stringContaining(
        "usage: agentport service install [--dry-run] [--config <path>]",
      ) as unknown,
    });
  });
});
