import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
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
    // 換掉 HOME 後 pnpm 會改用空的 store 重新下載全部依賴，也會改用空的 cache，
    // 失去 lockfile 已通過 supply-chain 檢查的紀錄而逐一向 registry 重新驗證；
    // 沿用原本的 store 與 cache 才不會逾時。
    const { stdout: storePath } = await execFileAsync(
      "pnpm",
      ["store", "path"],
      {
        cwd: PROJECT_ROOT,
      },
    );
    const { stdout: cachePath } = await execFileAsync(
      "pnpm",
      ["cache", "path"],
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
          pnpm_config_cache_dir: cachePath.trim(),
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
      process.execPath,
      ["scripts/deploy-package.mjs", packageDirectory],
      { cwd: PROJECT_ROOT },
    );

    await expect(access(`${packageDirectory}/src`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    // 部署不能動到這個 checkout：若它被記成 production-only 安裝，下一次 pnpm
    // 執行前的依賴檢查會移除 devDependencies。這裡直接讀記錄，因為在 pnpm 腳本
    // 內層執行的 pnpm 會略過該檢查，看不出 devDependencies 被移除。
    const workspaceState = JSON.parse(
      await readFile(
        `${PROJECT_ROOT}/node_modules/.pnpm-workspace-state-v1.json`,
        "utf8",
      ),
    ) as { settings: { dev: boolean } };
    expect(workspaceState.settings.dev).toBe(true);

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
