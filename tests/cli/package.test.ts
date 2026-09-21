import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
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
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

afterEach(cleanupTempDirs);

describe("production package", () => {
  it("service:install 將 service install 的參數交給打包出的 CLI", async () => {
    const home = await makeTempDir();
    await makeWorkspace(home, "workspace");
    await makeFakeExecutable(home, "claude");
    const configPath = await writeConfigFile(home, agentToml());

    const { stdout } = await execFileAsync(
      "pnpm",
      ["service:install", "--", "--dry-run", "--config", configPath],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, HOME: home },
      },
    );

    expect(stdout).toContain("com.agentport.serve");
  }, 20_000);

  it("只打包建置產物，且獨立執行 check-config 成功", async () => {
    const packageDirectory = await makeTempDir();
    const configDirectory = await makeTempDir();
    await makeWorkspace(configDirectory, "workspace");
    await makeFakeExecutable(configDirectory, "claude");
    const configPath = await writeConfigFile(configDirectory, agentToml());

    await execFileAsync(
      "pnpm",
      ["deploy", "--legacy", "--prod", packageDirectory],
      { cwd: PROJECT_ROOT },
    );

    await expect(access(`${packageDirectory}/src`)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        `${packageDirectory}/dist/cli.js`,
        "check-config",
        "--config",
        configPath,
      ],
      { env: baseEnv({ HOME: configDirectory, PATH: configDirectory }) },
    );

    expect(stdout).toContain("stationhub");
  });
});
