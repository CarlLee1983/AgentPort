#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createApp, type App } from "./app.js";
import { loadConfig } from "./config/load.js";
import { resolveConfigPath } from "./config/paths.js";
import type { Config } from "./config/schema.js";
import type { DriverRegistry } from "./driver/types.js";
import { createDrivers } from "./driver/registry.js";
import { createBearerAuth, resolveBearerCallers } from "./http/auth.js";
import { startHttpServer } from "./http/server.js";

const USAGE = "usage: agentport check-config [--config <path>]";
const STDIO_USAGE = "usage: agentport stdio [--config <path>]";
const SERVE_USAGE = "usage: agentport serve [--config <path>]";

type ParsedArgs = { ok: true; configPath: string | undefined } | { ok: false };

/** 只接受 `--config <path>`；缺值或任何未知旗標都視為用法錯誤。 */
function parseConfigArgs(args: string[]): ParsedArgs {
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg !== "--config") {
      return { ok: false };
    }
    const value = args[i + 1];
    if (value === undefined) {
      return { ok: false };
    }
    configPath = value;
    i += 1;
  }
  return { ok: true, configPath };
}

type LoadConfigOutcome =
  { ok: true; config: Config } | { ok: false; exitCode: number };

/**
 * 三個子命令共用的設定檔載入流程：解析 `--config`、找路徑、`loadConfig`，
 * 錯誤（用法錯誤 exit 2、設定檔驗證錯誤 exit 1）已經印到 stderr，呼叫端只要
 * 看 `ok` 決定要不要繼續、`ok: false` 時直接把 `exitCode` 回傳出去。
 */
function loadConfigOrReport(args: string[], usage: string): LoadConfigOutcome {
  const parsedArgs = parseConfigArgs(args);
  if (!parsedArgs.ok) {
    console.error(usage);
    return { ok: false, exitCode: 2 };
  }
  const configPath = resolveConfigPath(parsedArgs.configPath, process.env);
  const result = loadConfig(configPath, process.env);

  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`${error.path}: ${error.message}`);
    }
    return { ok: false, exitCode: 1 };
  }

  return { ok: true, config: result.config };
}

type CreateAppOutcome =
  { ok: true; app: App } | { ok: false; exitCode: number };

/**
 * `runStdio` / `runServe` 共用：只包 `createApp` 這一步（`createDrivers` 的
 * 錯誤維持原本行為，不在這裡接住）。失敗多半是 single-instance 鎖搶輸了
 * （另一個 agentport 程序正用同一個 db_path）：印出清楚的錯誤訊息，不要讓
 * 未接住的例外印出一大串 stack trace；`cause`（原始 SQLite 錯誤）另外印一行，
 * 方便診斷但不混進第一行訊息。
 */
function createAppOrReport(
  config: Config,
  drivers: DriverRegistry,
): CreateAppOutcome {
  try {
    const app = createApp({ config, drivers, caller: "local" });
    return { ok: true, app };
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      if (error.cause instanceof Error) {
        console.error(error.cause.message);
      }
    } else {
      console.error(String(error));
    }
    return { ok: false, exitCode: 1 };
  }
}

function runCheckConfig(args: string[]): number {
  const outcome = loadConfigOrReport(args, USAGE);
  if (!outcome.ok) {
    return outcome.exitCode;
  }

  const { agents, callers } = outcome.config;
  console.log("name\truntime\tpolicy\tworkspace");
  for (const agent of agents) {
    console.log(
      `${agent.name}\t${agent.runtime}\t${agent.policy}\t${agent.workspace}`,
    );
  }
  console.log(`callers: ${String(callers.length)}`);
  return 0;
}

function runStdio(args: string[]): number {
  const outcome = loadConfigOrReport(args, STDIO_USAGE);
  if (!outcome.ok) {
    return outcome.exitCode;
  }

  const drivers = createDrivers(outcome.config, process.env);
  const appOutcome = createAppOrReport(outcome.config, drivers);
  if (!appOutcome.ok) {
    return appOutcome.exitCode;
  }
  const app = appOutcome.app;

  try {
    // serveStdio() 本身是同步 API（回傳 StdioServerHandle，不是 Promise）；
    // runStdio 維持 async 是為了讓 SIGINT/SIGTERM 的關閉流程可以照順序 await。
    const handle = serveStdio(() => app.serverFactory());

    const shutdown = (): void => {
      handle
        .close()
        .catch(() => {
          // close() 失敗也要繼續關 store、結束程序，不讓訊號處理卡住。
        })
        .finally(() => {
          app.close();
          process.exit(0);
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    return 0;
  } catch (error) {
    app.close();
    throw error;
  }
}

function runServe(args: string[]): number {
  const outcome = loadConfigOrReport(args, SERVE_USAGE);
  if (!outcome.ok) {
    return outcome.exitCode;
  }
  const config = outcome.config;

  if (config.callers.length === 0) {
    console.error(
      "callers[] 不可為空：agentport serve 需要至少一個 caller 才能啟動",
    );
    return 1;
  }

  const resolvedCallers = resolveBearerCallers(config.callers, process.env);
  if (!resolvedCallers.ok) {
    for (const tokenEnv of resolvedCallers.missing) {
      console.error(
        `callers[].token_env 指到的環境變數未設定或為空：${tokenEnv}`,
      );
    }
    return 1;
  }

  const drivers = createDrivers(config, process.env);
  const appOutcome = createAppOrReport(config, drivers);
  if (!appOutcome.ok) {
    return appOutcome.exitCode;
  }
  const app = appOutcome.app;

  const auth = createBearerAuth(resolvedCallers.callers);

  startHttpServer({
    listen: config.server.listen,
    serverFactory: app.serverFactory,
    auth,
    allowedHosts: config.server.allowed_hosts,
  })
    .then((handle) => {
      console.log(`listening on ${handle.url}`);

      const shutdown = (): void => {
        handle
          .close()
          .catch(() => {
            // close() 失敗也要繼續關 store、結束程序，不讓訊號處理卡住。
          })
          .finally(() => {
            app.close();
            process.exit(0);
          });
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error: unknown) => {
      app.close();
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });

  return 0;
}

export function main(argv: string[]): number {
  const [command, ...rest] = argv;

  if (command === "check-config") {
    return runCheckConfig(rest);
  }

  if (command === "stdio") {
    return runStdio(rest);
  }

  if (command === "serve") {
    return runServe(rest);
  }

  console.error(USAGE);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
