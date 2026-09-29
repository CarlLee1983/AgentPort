import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs, makeTempDir } from "../config/helpers.js";

const CLI_PATH = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const COMMANDS_PATH = fileURLToPath(
  new URL("../../dist/commands.js", import.meta.url),
);
const RECORD_MODULES = fileURLToPath(
  new URL("../fixtures/record-modules.mjs", import.meta.url),
);

afterEach(cleanupTempDirs);

function runCli(args: string[]) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });
}

/** 未知子命令路徑不得載入的模組，分三類，讓對照組能逐類確認 hook 看得到。 */
const FORBIDDEN: Record<string, (url: string) => boolean> = {
  "better-sqlite3": (url) => url.includes("/better-sqlite3/"),
  "@modelcontextprotocol/server": (url) =>
    url.includes("/@modelcontextprotocol/server/"),
  driver: (url) =>
    url.includes("/dist/driver/") || url.includes("/src/driver/"),
};

function isForbidden(url: string): boolean {
  return Object.values(FORBIDDEN).some((matches) => matches(url));
}

/** 以 `node --import record-modules.mjs` 執行，回傳結束碼與所有解析到的模組 URL。 */
async function recordModules(
  nodeArgs: string[],
): Promise<{ status: number | null; modules: string[] }> {
  const logPath = join(await makeTempDir(), "modules.log");
  const result = spawnSync(
    process.execPath,
    ["--import", RECORD_MODULES, ...nodeArgs],
    {
      encoding: "utf8",
      env: { ...process.env, AGENTPORT_MODULE_LOG: logPath },
    },
  );
  const modules = (await readFile(logPath, "utf8")).split("\n");
  return { status: result.status, modules };
}

function expectSubcommandList(stderr: string): void {
  for (const subcommand of ["check-config", "stdio", "serve", "service"]) {
    expect(stderr).toMatch(
      new RegExp(`^\\s*(usage: )?agentport ${subcommand}\\b`, "m"),
    );
  }
}

describe("agentport 未知或缺少的子命令", () => {
  it("未知子命令以 exit code 2 結束，stderr 指出輸入並列出所有子命令", () => {
    const result = runCli(["bogus"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.split("\n")[0]).toBe("agentport：未知的指令 'bogus'");
    expectSubcommandList(result.stderr);
    expect(result.stderr).not.toMatch(/^ {4}at /m);
  });

  it("沒有子命令時以 exit code 2 結束，stderr 列出同一份子命令清單", () => {
    const unknown = runCli(["bogus"]);
    const result = runCli([]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    const [firstLine, ...list] = result.stderr.split("\n");
    expect(firstLine).toBe("agentport：缺少指令");
    expect(list).toEqual(unknown.stderr.split("\n").slice(1));
    expectSubcommandList(result.stderr);
  });

  it("未知子命令不載入 SQLite、MCP server 或 driver 模組", async () => {
    const { status, modules } = await recordModules([CLI_PATH, "bogus"]);

    expect(status).toBe(2);
    expect(modules).toContain(pathToFileURL(CLI_PATH).href);
    expect(modules.filter(isForbidden)).toEqual([]);
  });

  it("對照組：直接載入 dist/commands.js 時，hook 確實記錄到三類禁止模組", async () => {
    const { status, modules } = await recordModules([
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(COMMANDS_PATH).href)});`,
    ]);

    expect(status).toBe(0);
    for (const [category, matches] of Object.entries(FORBIDDEN)) {
      expect(modules.some(matches), category).toBe(true);
    }
  });
});
