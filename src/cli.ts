#!/usr/bin/env node
import {
  CHECK_CONFIG_USAGE,
  isSubcommand,
  SERVE_USAGE,
  SERVICE_USAGE,
  STDIO_USAGE,
} from "./usage.js";

const SUBCOMMAND_LIST = [
  CHECK_CONFIG_USAGE,
  STDIO_USAGE,
  SERVE_USAGE,
  SERVICE_USAGE,
].join("\n");

/**
 * 子命令的實作（設定、SQLite、driver、MCP server）只在命中已知子命令時才
 * 動態載入；缺少或未知子命令直接印錯誤與子命令清單，不付任何載入成本。
 */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || !isSubcommand(command)) {
    const problem =
      command === undefined ? "缺少指令" : `未知的指令 '${command}'`;
    console.error(`agentport：${problem}\n${SUBCOMMAND_LIST}`);
    return 2;
  }

  const { runCommand } = await import("./commands.js");
  return await runCommand(command, rest);
}

void main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
