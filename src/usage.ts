/**
 * 子命令清單與各自的用法字串。這個模組不得 import 任何東西：未知子命令的路徑
 * 只載入它和 `cli.ts`，不碰設定、SQLite、driver 或 MCP server。
 */
export const SUBCOMMANDS = [
  "check-config",
  "stdio",
  "serve",
  "service",
] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number];

export const CHECK_CONFIG_USAGE =
  "usage: agentport check-config [--config <path>]";
export const STDIO_USAGE = "usage: agentport stdio [--config <path>]";
export const SERVE_USAGE = "usage: agentport serve [--config <path>]";
export const SERVICE_USAGE =
  "usage: agentport service install [--dry-run] [--config <path>]\n" +
  "       agentport service status|restart|uninstall [--config <path>]";

export function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}
