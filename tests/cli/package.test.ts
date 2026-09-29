import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter } from "node:path";
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
import { expectHostServiceDryRun } from "./service-dry-run.js";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

afterEach(cleanupTempDirs);

describe("production package", () => {
  it("service:install 將 service install 的參數交給打包出的 CLI", async () => {
    const home = await makeTempDir();
    await makeWorkspace(home, "workspace");
    await makeFakeExecutable(home, "claude");
    const configPath = await writeConfigFile(home, agentToml());
    // 換掉 HOME 後 pnpm 會改用空的 store 重新下載全部依賴；沿用原本的 store 才不會逾時。
    const { stdout: storePath } = await execFileAsync(
      "pnpm",
      ["store", "path"],
      {
        cwd: PROJECT_ROOT,
      },
    );

    const { stdout } = await execFileAsync(
      "pnpm",
      ["service:install", "--", "--dry-run", "--config", configPath],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${home}${delimiter}${process.env.PATH ?? ""}`,
          pnpm_config_store_dir: storePath.trim(),
        },
      },
    );

    expectHostServiceDryRun(stdout);
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
