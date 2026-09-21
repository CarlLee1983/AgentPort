#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createApp } from "./app.js";
import { loadConfig } from "./config/load.js";
import { resolveConfigPath } from "./config/paths.js";
import { createDrivers } from "./driver/registry.js";
import { createBearerAuth } from "./http/auth.js";
import { startHttpServer } from "./http/server.js";

const USAGE = "usage: agentport check-config [--config <path>]";
const STDIO_USAGE = "usage: agentport stdio [--config <path>]";
const SERVE_USAGE = "usage: agentport serve [--config <path>]";

type ParsedArgs = { ok: true; configPath: string | undefined } | { ok: false };

/** 只接受 `--config <path>`；缺值或任何未知旗標都視為用法錯誤。 */
function parseCheckConfigArgs(args: string[]): ParsedArgs {
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

function runCheckConfig(args: string[]): number {
  const parsedArgs = parseCheckConfigArgs(args);
  if (!parsedArgs.ok) {
    console.error(USAGE);
    return 2;
  }
  const configPath = resolveConfigPath(parsedArgs.configPath, process.env);
  const result = loadConfig(configPath, process.env);

  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`${error.path}: ${error.message}`);
    }
    return 1;
  }

  const { agents, callers } = result.config;
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
  const parsedArgs = parseCheckConfigArgs(args);
  if (!parsedArgs.ok) {
    console.error(STDIO_USAGE);
    return 2;
  }
  const configPath = resolveConfigPath(parsedArgs.configPath, process.env);
  const result = loadConfig(configPath, process.env);

  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`${error.path}: ${error.message}`);
    }
    return 1;
  }

  const app = createApp({
    config: result.config,
    drivers: createDrivers(result.config, process.env),
    caller: "local",
  });

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
  const parsedArgs = parseCheckConfigArgs(args);
  if (!parsedArgs.ok) {
    console.error(SERVE_USAGE);
    return 2;
  }
  const configPath = resolveConfigPath(parsedArgs.configPath, process.env);
  const result = loadConfig(configPath, process.env);

  if (!result.ok) {
    for (const error of result.errors) {
      console.error(`${error.path}: ${error.message}`);
    }
    return 1;
  }

  if (result.config.callers.length === 0) {
    console.error(
      "callers[] 不可為空：agentport serve 需要至少一個 caller 才能啟動",
    );
    return 1;
  }

  const app = createApp({
    config: result.config,
    drivers: createDrivers(result.config, process.env),
    caller: "local",
  });

  const auth = createBearerAuth(
    result.config.callers.map((caller) => ({
      name: caller.name,
      token: process.env[caller.token_env] ?? "",
    })),
  );

  startHttpServer({
    listen: result.config.server.listen,
    serverFactory: app.serverFactory,
    auth,
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
